// v0.6 第 2–4 段断言：DataGrid 0 点 / 空值过滤 / emitTrace / PUT rowsReplace。
// 真起服务只在**副本库**上，绝不写生产 data/reports.json。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
let pass = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }
const { toPoints, fromPoints, filterEmptyValueRows } = await import(path.join(ROOT, 'web/src/pages/intake/points.js'))

// ---------- 第 2 段：points 往返 + 0 点 + inferred ----------
{
  const rows = [{ name: 'WBC', value: '4.66', unit: '10^9/L', refRange: '3.5-9.5', flag: 'high', code: 'WBC' }]
  const back = fromPoints(toPoints(rows))
  assert.equal(back[0].name, 'WBC'); assert.equal(back[0].value, '4.66')
  assert.equal(back[0].refRange, '3.5-9.5'); assert.equal(back[0].code, 'WBC')
  ok('points 往返：name/value/unit/refRange/code/flag→arrow 不丢字段')
}
{
  assert.deepEqual(toPoints([]), [], '0 行 → 0 点（DataGrid 自带空态，不崩）')
  assert.deepEqual(fromPoints([]), [])
  ok('0 点安全：toPoints/fromPoints 空数组不抛错')
}
{
  // r3 B：智能补项补出「有单位/区间但 value 空」的推测行
  const inferred = [{ original_name: '血小板', value: '', unit: '10^9/L', ref_range: '125-350', standard_code: 'PLT', _source: 'inferred' }]
  const rows = fromPoints(inferred)
  assert.equal(rows[0].inferred, true, '_source:inferred 必须保留')
  const { rows: kept, dropped } = filterEmptyValueRows(rows)
  assert.equal(kept.length, 0); assert.equal(dropped, 1)
  ok('智能补项行：保留 inferred 标记 + 空 value 入库前过滤（dropped=1）')
}
{
  const qual = [{ name: '乙肝表面抗原', value: '阴性', unit: '' }, { name: 'MRD', value: '未检出', unit: '' }]
  const { rows: kept, dropped } = filterEmptyValueRows(qual)
  assert.equal(kept.length, 2); assert.equal(dropped, 0)
  ok('定性结果「阴性/未检出」value 非空，不被误删')
}

// ---------- 第 3/4 段：副本库真起服务 ----------
const REAL = path.join(ROOT, 'data', 'reports.json')
const realShaBefore = fs.readFileSync(REAL).toString('utf8')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-v06-'))
const tmpReports = path.join(tmp, 'reports.json')
const store = JSON.parse(realShaBefore)
// 造一条已知报告用于 PUT：带 text + 2 行
const victim = store.reports.find((r) => (r.rows || []).length >= 2) || store.reports[0]
victim.rows = [{ name: 'WBC', value: '4.66', unit: '10^9/L', refRange: '3.5-9.5' }, { name: 'HGB', value: '88', unit: 'g/L', refRange: '130-175' }]
victim.text = '原始全文（旧结论）'
store.reports = store.reports.map((r) => (r.id === victim.id ? victim : r))
fs.writeFileSync(tmpReports, JSON.stringify(store, null, 2), 'utf8')
const PORT = 5198
const BASE = `http://127.0.0.1:${PORT}`
let srv = null
try {
  srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), MEDBRIEF_REPORTS_FILE: tmpReports, MEDBRIEF_DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let up = false
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) { up = true; break } } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  assert.ok(up, '副本服务未起来')

  const put = async (id, payload) => {
    const r = await fetch(`${BASE}/api/intake/reports/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    return r.json()
  }
  // ① 拒绝无 rowsReplace / fromReportId / 空 text
  {
    const a = await put(victim.id, { rows: [], text: 'x' })
    assert.equal(a.ok, false)
    const b = await put(victim.id, { rowsReplace: true, fromReportId: 'wrong', rows: [] })
    assert.equal(b.ok, false)
    const c = await put(victim.id, { rowsReplace: true, fromReportId: victim.id, rows: [], text: '' })
    assert.equal(c.ok, false)
    ok('PUT 三个护栏：缺 rowsReplace / fromReportId 不符 / text 清空 全部拒绝')
  }
  // ② 正常更新：行数变化 + text 更新 + added/removed 快照 + 不新增记录
  {
    const newRows = [
      { name: 'WBC', value: '5.10', unit: '10^9/L', refRange: '3.5-9.5' },
      { name: 'HGB', value: '88', unit: 'g/L', refRange: '130-175' },
      { name: 'PLT', value: '', unit: '10^9/L', refRange: '125-350', inferred: true }, // 空值行
    ]
    const j = await put(victim.id, {
      rowsReplace: true, fromReportId: victim.id, rows: newRows, text: '新识别全文（新结论）',
      meta: { reportDate: victim.reportDate || '', reportType: victim.reportType || '' },
    })
    assert.equal(j.ok, true, JSON.stringify(j))
    assert.equal(j.rows, 2, '空 value 行被过滤')
    assert.equal(j.droppedEmptyValue, 1)
    assert.equal(j.added, 0); assert.equal(j.removed, 0)
    const after = JSON.parse(fs.readFileSync(tmpReports, 'utf8'))
    assert.equal(after.reports.length, store.reports.length, 'reports.length 不变（原地更新，不 push 第二条）')
    const rep = after.reports.find((r) => r.id === victim.id)
    assert.equal(rep.text, '新识别全文（新结论）', 'text 与 rows 一起更新')
    assert.equal(rep.rows[0].value, '5.10')
    assert.ok(Array.isArray(after.trashed) && Array.isArray(after.audit), '原子写保 trashed/audit')
    const lastLog = rep.patchLog[rep.patchLog.length - 1]
    assert.equal(lastLog.field, 'rowsReplace')
    assert.equal(lastLog.text.fromLen, '原始全文（旧结论）'.length)
    assert.equal(lastLog.text.toSha.length, 12)
    assert.ok(!JSON.stringify(lastLog).includes('原始全文'), 'patchLog 不含患者原文')
    assert.ok(!JSON.stringify(lastLog).includes('rawSnippet'), '快照不含 rawSnippet')
    ok('PUT 正常更新：不新增记录 / text+rows 同步 / 空值过滤 / patchLog 只存长度+sha / 无原文无 rawSnippet')
  }
  // ③ 行数变多/变少时 added/removed 分条
  {
    const j = await put(victim.id, { rowsReplace: true, fromReportId: victim.id,
      rows: [{ name: 'WBC', value: '5.10', unit: '10^9/L', refRange: '3.5-9.5' }] })
    assert.equal(j.ok, true)
    assert.equal(j.removed, 1)
    const rep = JSON.parse(fs.readFileSync(tmpReports, 'utf8')).reports.find((r) => r.id === victim.id)
    const lastLog = rep.patchLog[rep.patchLog.length - 1]
    assert.equal(lastLog.rows.removed, 1)
    assert.equal(lastLog.removedSnapshot.length, 1)
    assert.deepEqual(Object.keys(lastLog.removedSnapshot[0]).sort(), ['name', 'unit', 'value'])
    ok('行数变化：removed 分条 + 被删行快照只含 name/value/unit')
  }
  // ④ 真实库全程未动
  assert.equal(fs.readFileSync(REAL, 'utf8'), realShaBefore)
  ok('真实库 sha 前后一致（副本测试绝不写生产）')

  // ---------- 375 ② 校对区 DataGrid 窄屏样式（真浏览器，只读） ----------
  // 用副本服务（仍在跑）上传真 PDF 后量；不做写库，只看布局
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage({ viewport: { width: 375, height: 900 } })
    await p.goto(`${BASE}/?tab=intake`, { waitUntil: 'domcontentloaded' })
    await p.waitForTimeout(1000)
    const pdf = '/Users/scallion/Documents/projects/ds-bot/home/attachments/v1/files/d6/d648e04bfbfec6df7cb977db4599905ff2c540ce624053db3a77e9d2fd6b9b81/V020089_刘梦圆_新疆_新疆军区总医院_血液科_血液_MaYo骨髓染色体核型分_2026072318053636.pdf'
    if (fs.existsSync(pdf)) {
      await p.setInputFiles('input[type=file]', pdf)
      await p.waitForTimeout(600)
      const one = p.getByRole('button', { name: /一键识别全部/ }).first()
      if (await one.count()) await one.click({ timeout: 8000 })
      await p.waitForTimeout(3500)
      const m = await p.evaluate(() => {
        const scope = document.querySelector('.mb-review-grid')
        if (!scope) return null
        const ths = [...scope.querySelectorAll('th')]
        const saveRow = scope.querySelector('.flex.items-center.justify-end.gap-3')
        return {
          de: document.documentElement.scrollWidth,
          // antd/tailwind 表头自带 py-2 内边距，实测单行 38px；竖排单字会 >60px。
          // 阈值 44 区分「正常单行」与「被压成竖排」，别拿裸行高当判据（375 实测踩过）。
          thTall: ths.filter((t) => t.getBoundingClientRect().height > 44).length,
          thNarrow: ths.filter((t) => t.getBoundingClientRect().width < 30).length,
          saveWrapped: saveRow ? saveRow.getBoundingClientRect().height > 52 : false,
          styleIds: [...document.querySelectorAll('head > style[id]')].map((s) => s.id).filter((i) => i.startsWith('mb-')),
          gridSave: [...scope.querySelectorAll('button')].filter((x) => x.getBoundingClientRect().height > 0 && /保存到本地/.test(x.textContent)).length,
          gridReset: [...scope.querySelectorAll('button')].filter((x) => x.getBoundingClientRect().height > 0 && /清空本次/.test(x.textContent)).length,
          gridToolbar: [...scope.querySelectorAll('button')].filter((x) => x.getBoundingClientRect().height > 0 && /智能补项|空白行|一键修正/.test(x.textContent)).length,
          pageHasSave: [...document.querySelectorAll('button')].some((x) => x.getBoundingClientRect().height > 0 && /入库这份报告/.test(x.textContent)),
        }
      })
      if (m) {
        if (m.de === 375) ok('375 ② 校对区无横向溢出（de=375）')
        else throw new Error(`de=${m.de}`)
        if (m.thTall === 0 && m.thNarrow === 0) ok('表头不竖排：无超高/超窄 th')
        else throw new Error(`thTall=${m.thTall} thNarrow=${m.thNarrow}`)
        if (!m.saveWrapped) ok('底部保存区横排不折行')
        else throw new Error('保存区仍被压高')
        if (m.styleIds.includes('mb-review-grid-mobile')) ok('页面级窄屏样式 #mb-review-grid-mobile 已注入')
        else throw new Error(`styles=${m.styleIds.join(',')}`)
        // 冗余保存按钮（2026-11-16 用户指出）：网格内「保存到本地数据库」在本页 onSave 只弹提示 → 隐藏
        if (m.gridSave === 0) ok('校对网格内「保存到本地数据库」已隐藏（写库唯一入口＝页面「入库这份报告」）')
        else throw new Error(`gridSave=${m.gridSave}`)
        if (m.gridReset === 1) ok('网格内「清空本次」保留')
        else throw new Error(`gridReset=${m.gridReset}`)
        if (m.gridToolbar === 3) ok('工具栏 3 个按钮未被误伤')
        else throw new Error(`gridToolbar=${m.gridToolbar}`)
        if (m.pageHasSave) ok('页面级「入库这份报告」仍在（唯一写库入口）')
        else throw new Error('页面级写库按钮缺失')
      } else console.log('SKIP 375 校对区断言：PDF 未就绪或校对区未展开')
    } else console.log('SKIP 375 校对区断言：找不到真 PDF')
  } finally { await browser.close() }
} finally {
  if (srv) srv.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\nv0.6 第 2–4 段：${pass} 通过 / 0 失败`)
