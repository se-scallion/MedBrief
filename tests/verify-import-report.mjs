// 报告导入固定流程 · 门禁（零网络、不写库）
//
// 覆盖三件事：
//   1. 版式适配器在**真实文本**（已脱敏的 line-level 文本层）上认出 6 个比例行、值逐项对得上；
//   2. 红线：流式报告无参考区间 → 不许判高低；原文名不许改写成「原始细胞」；
//   3. dry-run 绝不写库（reports.json 字节数/修改时间不变）；无法识别的版式 → 退出码 3（要人加适配器）。
//
// 跑法：node tests/verify-import-report.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pickAdapter, stripWatermarkTokens, collectSuspects } from '../tools/report-adapters/index.mjs'
import labPanelAdapter from '../tools/report-adapters/lab-panel.mjs'
import { findDuplicate } from '../lib/reportIntake.mjs' // 直接进叶子模块：验证没有循环依赖（曾因 index↔适配器互相 import 报 TDZ）
import { isPlausibleLabRow, buildReportFingerprint, parseLabRowsDetailed } from '../lib/reportIntake.mjs'
import { hospitalCandidates, guessHospital } from '../lib/reportMeta.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FIXTURE = path.join(HERE, 'fixtures', 'flow-immunophenotype-page1.txt')
const FIXTURE_LAB = path.join(HERE, 'fixtures', 'lab-panel-simple.txt')
const FIXTURE_KARYO = path.join(HERE, 'fixtures', 'karyotype-report.txt')
const NODE = process.execPath

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); pass++ } catch (e) { fails.push(name); console.log(`FAIL  ${name}\n      ${e.message}`) }
}

const text = fs.readFileSync(FIXTURE, 'utf8')

// ---------------- 适配器 ----------------
it('适配器：血液肿瘤免疫分型报告单被 flow-immunophenotype 认领（不是兜底）', () => {
  const picked = pickAdapter(text)
  assert.ok(picked, '没有适配器命中')
  assert.equal(picked.adapter.id, 'flow-immunophenotype')
})

it('水印：跨行重复的「姓名首字 / 条码」被剥掉，但 检测条码：… 的值必须保留', () => {
  const lines = stripWatermarkTokens(text.split('\n'))
  const joined = lines.join('\n')
  assert.ok(!/(^|\s)某(\s|$)/.test(joined), '单字水印没剥干净')
  // 独立成词的条码水印应清零，只剩「检测条码(Barcode)：V00000000000」这一处
  const standalone = joined.split('\n').filter((l) => l.trim() === 'V00000000000')
  assert.equal(standalone.length, 0, `仍有独立成词的条码水印 ${standalone.length} 行`)
  assert.ok(/检测条码\(Barcode\)：V00000000000/.test(joined), '标签后的条码值被误删')
})

it('抬头：标签与值在同一行（PDF 文本层按 y 聚类后必须配得上对）', () => {
  const parsed = pickAdapter(text).adapter.parse({ text })
  assert.equal(parsed.meta.patientName, '张某')
  assert.equal(parsed.meta.patientSex, '女')
  assert.equal(parsed.meta.patientAge, '30')
  assert.equal(parsed.meta.specimen, '骨髓')
  assert.equal(parsed.meta.barcode, 'V00000000000')
  assert.equal(parsed.meta.attending, '某医生')
  assert.equal(parsed.meta.clinicalDiagnosis, 'AL?')
  assert.match(parsed.meta.hospital, /某军区总医院/)
  assert.equal(parsed.meta.labName, '某主检实验室')
})

it('报告日期取「报告日期：」那一行，不能被页脚「自报告日期起三天内…」抢走', () => {
  const parsed = pickAdapter(text).adapter.parse({ text })
  assert.equal(parsed.meta.reportDate, '2026-07-17')
  assert.equal(parsed.meta.sampledAt, '2026-07-15 12:51')
  assert.equal(parsed.meta.receivedAt, '2026-07-16 11:19')
  assert.ok(!parsed.warnings.some((w) => /报告日期未读到/.test(w)), '不应触发日期兜底告警')
})

it('指标行：6 个比例行、值逐项对得上原文', () => {
  const { rows } = pickAdapter(text).adapter.parse({ text })
  assert.equal(rows.length, 6)
  const by = Object.fromEntries(rows.map((r) => [r.name, r]))
  assert.equal(by['异常细胞占有核细胞比例'].value, '85.76')
  assert.equal(by['CD34+细胞占有核细胞比例'].value, '84.42')
  assert.equal(by['粒细胞占有核细胞比例'].value, '9.27')
  assert.equal(by['有核红细胞占有核细胞比例'].value, '2.51')
  assert.equal(by['淋巴细胞占有核细胞比例'].value, '2.19')
  assert.equal(by['单核细胞占有核细胞比例'].value, '0.27')
})

it('红线：无参考区间就不判高低（status 全 unknown、refRange 全空）', () => {
  const { rows } = pickAdapter(text).adapter.parse({ text })
  for (const r of rows) {
    assert.equal(r.status, 'unknown', `${r.name} 被判了 ${r.status}`)
    assert.equal(r.refRange, '', `${r.name} 被编了参考区间`)
    assert.equal(r.flag, '')
    assert.equal(r.unit, '%')
    assert.ok(r.rawSnippet && r.rawSnippet.length > 5, `${r.name} 缺原文片段`)
  }
})

it('红线：不许把「异常细胞%」改写成「原始细胞/骨髓原始细胞」', () => {
  const { rows } = pickAdapter(text).adapter.parse({ text })
  const names = rows.map((r) => r.name).join('|')
  assert.ok(!/原始细胞/.test(names), `出现了推断出来的项目名：${names}`)
  assert.ok(names.includes('异常细胞占有核细胞比例'))
})

it('字段：code 对齐 MedData 命名空间（流式走 fcm，字典外项走 custom:）', () => {
  const { rows } = pickAdapter(text).adapter.parse({ text })
  const by = Object.fromEntries(rows.map((r) => [r.name, r]))
  assert.equal(by['异常细胞占有核细胞比例'].code, 'FCM_MRD_PCT')
  assert.equal(by['CD34+细胞占有核细胞比例'].code, 'FCM_CD34_PCT')
  assert.equal(by['粒细胞占有核细胞比例'].code, 'custom:fcm-gran-pct')
  for (const r of rows) {
    assert.equal(r.stream, 'fcm')
    assert.equal(r.qualifier, 'eq')
    assert.equal(r.originalName, r.name)
  }
})

it('兜底：无版式特征的纯文本交给 lab-panel，不会假装成功（出告警）', () => {
  const picked = pickAdapter('白细胞 6.83 3.5-9.5 10^9/L\n血红蛋白 113 130-175 g/L')
  assert.equal(picked.adapter.id, 'lab-panel')
  const parsed = picked.adapter.parse({ text: '白细胞 6.83 3.5-9.5 10^9/L\n血红蛋白 113 130-175 g/L' })
  assert.ok(parsed.rows.length >= 2)
})

// ---------------- 染色体核型报告（全文型，2026-11-12 第二份真实样本） ----------------

const karyoText = fs.readFileSync(FIXTURE_KARYO, 'utf8')

it('适配器：染色体核型报告被 karyotype 认领（不是兜底）', () => {
  const picked = pickAdapter(karyoText)
  assert.ok(picked, '没有适配器命中')
  assert.equal(picked.adapter.id, 'karyotype')
})

it('抬头：双语标签「中文(EN)：值」一行多组，流式与核型共用同一套解析', () => {
  const { meta } = pickAdapter(karyoText).adapter.parse({ text: karyoText })
  assert.equal(meta.patientName, '张某')
  assert.equal(meta.patientSex, '女')
  assert.equal(meta.patientAge, '30')
  assert.equal(meta.hospital, '某军区总医院')
  assert.equal(meta.barcode, 'V00000000000')
  assert.equal(meta.sampledAt, '2026-07-15 12:51')
  assert.equal(meta.receivedAt, '2026-07-17 10:07')
  assert.equal(meta.clinicalDiagnosis, 'AL?')
  assert.equal(meta.specimen, '骨髓')
  assert.equal(meta.department, '血液科')
})

it('日期：没有「报告日期」时用采样时间兜底，并明确留痕来源', () => {
  const parsed = pickAdapter(karyoText).adapter.parse({ text: karyoText })
  assert.equal(parsed.meta.reportDate, '2026-07-15')
  assert.ok(parsed.warnings.some((w) => /报告日期未读到.*采样/.test(w)), '兜底没留痕')
})

it('红线：核型公式 / 结论不拆成指标行，全文型报告 0 行是合法结果', () => {
  const parsed = pickAdapter(karyoText).adapter.parse({ text: karyoText })
  assert.equal(parsed.rows.length, 0)
  assert.equal(parsed.textOnly, true)
  assert.equal(parsed.meta.textOnly, true)
  assert.equal(parsed.meta.reportType, 'KARYOTYPE')
  assert.ok(parsed.warnings.some((w) => /自由文本/.test(w)))
  assert.ok(!parsed.warnings.some((w) => /未解析出指标行/.test(w)), '0 行不该被误报成解析失败')
})

it('闸门：ISCN 版本号不再变成 1 行假指标，带单位的真实行不误杀', () => {
  assert.equal(isPlausibleLabRow({ name: '检测结果(ISCN', value: '2024', unit: '', refRange: '', flag: '' }), false)
  assert.equal(isPlausibleLabRow({ name: '白细胞', value: '6.83', unit: '10^9/L' }), true)
  assert.equal(isPlausibleLabRow({ name: '白细胞（WBC）', value: '6.83', unit: '', refRange: '' }), true)
  const { rows, droppedLines } = parseLabRowsDetailed('检测结果(ISCN 2024) 检测结论')
  assert.equal(rows.length, 0, `仍产出了假行：${JSON.stringify(rows)}`)
  assert.equal(droppedLines.length, 1, '丢掉的行必须留痕')
})

it('指纹：0 行全文型报告按 reportType + 条码区分，同日同院不同报告不互撞', () => {
  const meta = { reportDate: '2026-07-15', hospital: '某院', kind: 'pathology', reportType: 'KARYOTYPE', barcode: 'V1' }
  assert.equal(buildReportFingerprint([], meta), buildReportFingerprint([], { ...meta }))
  assert.notEqual(buildReportFingerprint([], meta), buildReportFingerprint([], { ...meta, reportType: 'OTHER' }))
  assert.notEqual(buildReportFingerprint([], meta), buildReportFingerprint([], { ...meta, barcode: 'V2' }))
})

// ---------------- CLI（dry-run 不许写库） ----------------

const REPORTS = path.join(ROOT, 'data', 'reports.json')
const stamp = () => (fs.existsSync(REPORTS) ? `${fs.statSync(REPORTS).size}:${fs.statSync(REPORTS).mtimeMs}` : 'absent')

it('CLI：dry-run 不改 data/reports.json（字节数与 mtime 不变）', () => {
  const before = stamp()
  const r = spawnSync(NODE, [path.join(ROOT, 'tools', 'import-report.mjs'), FIXTURE], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `退出码 ${r.status}：${r.stderr}`)
  assert.match(r.stdout, /DRY-RUN 不写库/)
  assert.match(r.stdout, /异常细胞占有核细胞比例/)
  assert.equal(stamp(), before, 'dry-run 动了 reports.json')
})

it('CLI：无法识别的版式 → 退出码 3，并提示去加适配器', () => {
  const tmp = path.join(ROOT, 'data', 'tmp', 'verify-import-unknown.txt')
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, '这是一份没有任何版式特征的说明文字。\n', 'utf8')
  const r = spawnSync(NODE, [path.join(ROOT, 'tools', 'import-report.mjs'), tmp], { cwd: ROOT, encoding: 'utf8' })
  // lab-panel 是兜底（match 0.1）→ 会命中但 0 行；判据：**必须**非 0 退出并明说要加适配器，
  // 不许「解析出空表也算导入成功」（那正是「静默丢数据」）
  assert.equal(r.status, 3, `退出码应为 3，实际 ${r.status}：${r.stderr}`)
  assert.match(`${r.stdout}${r.stderr}`, /未解析出任何指标行/)
  fs.unlinkSync(tmp)
})

it('CLI：全文型报告 0 行不算失败，收尾明确说「未写库」', () => {
  const before = stamp()
  const r = spawnSync(NODE, [path.join(ROOT, 'tools', 'import-report.mjs'), FIXTURE_KARYO], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `退出码 ${r.status}：${r.stderr}`)
  assert.match(r.stdout, /karyotype/)
  assert.match(r.stdout, /全文型报告/)
  assert.match(r.stdout, /未写库/)
  assert.equal(stamp(), before, 'dry-run 动了 reports.json')
})

it('CLI：ISCN 表头被当成指标的非化验版式 → 退出码 3，不写库', () => {
  const before = stamp()
  const tmp = path.join(ROOT, 'data', 'tmp', 'verify-import-iscn.txt')
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, '某检验所 报告单\n检测结果(ISCN 2024) 检测结论\n', 'utf8')
  const r = spawnSync(NODE, [path.join(ROOT, 'tools', 'import-report.mjs'), tmp], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 3, `退出码 ${r.status}：${r.stdout}${r.stderr}`)
  assert.match(`${r.stdout}${r.stderr}`, /未解析出任何指标行/)
  assert.equal(stamp(), before, '失败路径动了 reports.json')
  fs.unlinkSync(tmp)
})

it('CLI --json：全文型报告带 textOnly 标记，机器可读结果与核对表一致', () => {
  const r = spawnSync(NODE, [path.join(ROOT, 'tools', 'import-report.mjs'), FIXTURE_KARYO, '--json'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0)
  const j = JSON.parse(r.stdout)
  assert.equal(j.results[0].adapter, 'karyotype')
  assert.equal(j.results[0].textOnly, true)
  assert.equal(j.results[0].rows, 0)
  assert.equal(j.results[0].status, 'parsed')
})


// ---------------- 批量 / 可疑行 ----------------

it('叶子模块可独立 import：适配器不依赖 index（防循环依赖 TDZ 回归）', () => {
  const parsed = labPanelAdapter.parse({ text: fs.readFileSync(FIXTURE_LAB, 'utf8') })
  assert.equal(labPanelAdapter.id, 'lab-panel')
  assert.ok(parsed.rows.length >= 3)
  assert.ok(parsed.rows.every((r) => r.rawSnippet), 'lab-panel 行必须有原文片段')
})

it('可疑行判定：留痕字段才是「要人看」的理由，干净的行不打扰人', () => {
  const clean = collectSuspects({ rows: [{ name: '白细胞', value: '6.83', num: 6.83, rawSnippet: 'x' }], meta: { patientName: '某某', reportDate: '2026-11-01' } })
  assert.deepEqual(clean, [], `干净行被判成可疑：${clean.join('；')}`)
  const dirty = collectSuspects({
    rows: [
      { name: '血小板', value: '10', num: 10, rawSnippet: 'x', valueConflict: true },
      { name: '血红蛋白', value: '<0.01', num: null, rawSnippet: 'x' },
      { name: '红细胞', value: '3.8', num: 3.8 },
    ],
    meta: {},
    warnings: ['报告日期未读到'],
  })
  assert.ok(dirty.some((x) => /切块边界/.test(x)))
  assert.ok(dirty.some((x) => /不是纯数值/.test(x)))
  assert.ok(dirty.some((x) => /缺原文片段/.test(x)))
  assert.ok(dirty.some((x) => /报告日期未读到/.test(x)))
})

it('CLI 批量：两份不同版式一次跑完，各自走对的适配器', () => {
  const r = spawnSync(NODE, [path.join(ROOT, 'tools', 'import-report.mjs'), FIXTURE, FIXTURE_LAB, '--review', 'none'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `退出码 ${r.status}：${r.stderr}`)
  assert.match(r.stdout, /（2 份，并发 4/)
  assert.match(r.stdout, /flow-immunophenotype/)
  assert.match(r.stdout, /lab-panel/)
  assert.match(r.stdout, /parsed 2/)
})

it('CLI 批量：并发参数被夹在 1..8，且并发跑不改变解析结果', () => {
  const run = (c) => spawnSync(NODE, [path.join(ROOT, 'tools', 'import-report.mjs'), FIXTURE, '--concurrency', String(c), '--review', 'none'], { cwd: ROOT, encoding: 'utf8' })
  const ok = run(4)
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /parsed 1/)
  const huge = run(99) // 应被夹到 8，不崩
  assert.equal(huge.status, 0)
  assert.match(huge.stdout, /并发 8/)
})

// 2026-11-15 用户真截图 20260718G0110035（第 2 页）实测：页脚「本结果仅供参考，请以医院纸质报告及
// 医生意见为准。」被抽成院名 `请以医院` —— 一入库就把「请以医院」写进报告抬头，医生看到的是句残句。
// 判据：院名必须以地名/机构名起头；中文虚词起头的（请以/至/到/该/本/此…）一定不是机构名。
it('院名：免责声明里的「请以医院」不得当院名，真院名仍要认出来', () => {
  const disclaimer = '检验免责声明：\n本结果仅供参考，请以医院纸质报告及医生意见为准。\n分享报告'
  assert.deepEqual(hospitalCandidates(disclaimer), [], `免责声明不得产出院名，实际 ${JSON.stringify(hospitalCandidates(disclaimer))}`)
  assert.equal(guessHospital(disclaimer), '')
  assert.deepEqual(hospitalCandidates('陆军军医大学新桥医院血液病医学中心\n治疗后微小残留病检测流式报告'), ['陆军军医大学新桥医院'])
  assert.equal(guessHospital('北京市朝阳区某某医院\n检验科 血常规报告'), '北京市朝阳区某某医院')
})

console.log('\n' + '='.repeat(46))
// 查重护栏（2026-11-15 修）：同一条码会被同一送检批的多份报告共用（真实库 V02008911352 被 6 份共用），
// 旧规则「有条码就只比条码」会把同批的新报告判成重复 —— 现在要求条码/日期/内容指纹都对上才算同一份。
it('查重：同条码同日期但内容指纹不同 → 不是重复；指纹相同 → 才是重复', () => {
  const dhash0 = '0'.repeat(64)
  const existing = [{ id: 'rep_old', sha256: 'sha_old', dhash: dhash0, reportDate: '2026-10-16', barcode: 'V02008911352', fingerprint: 'fp_old' }]
  const same = findDuplicate({ sha256: 'sha_new', dhash: dhash0, reportDate: '2026-10-16', barcode: 'V02008911352', fingerprint: 'fp_old' }, existing)
  assert.equal(same.dup, true, '完全同一份（指纹也相同）必须判重复')
  const diff = findDuplicate({ sha256: 'sha_new2', dhash: dhash0, reportDate: '2026-10-16', barcode: 'V02008911352', fingerprint: 'fp_new' }, existing)
  assert.equal(diff.dup, false, '同条码同日但内容不同的新报告不得判重复')
  const otherDay = findDuplicate({ sha256: 'sha_new3', dhash: dhash0, reportDate: '2026-11-01', barcode: 'V02008911352', fingerprint: 'fp_old' }, existing)
  assert.equal(otherDay.dup, false, '日期不同不得判重复')
  const exact = findDuplicate({ sha256: 'sha_old', dhash: '', reportDate: '', barcode: '' }, existing)
  assert.equal(exact.kind, 'exact', '同一张图（sha256 相同）仍须精确命中')
})

console.log(`报告导入流程：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  console.log('失败项：\n  - ' + fails.join('\n  - '))
  process.exit(1)
}
