// 问诊资料卡回归断言（守「渲染静默丢数据」这一类 bug）
// 背景：2026-11-12 真实事故 —— 卡片按「组」渲染（每组一行、只取 rows[0]），
//   105 行 / 35 项指标在卡上只剩 6 行，HTML 看起来正常、A4 也是 1 页，但 99 项数据被静默丢弃。
//   教训：**压缩展示的渲染必须断言「渲染出来的行 == 数据里的行」**，只断言「不报错」抓不到。
// 三条断言：
//   1. 行数完备性：3 份 × 35 项 = 105 行 → counts.rows=105，且 35 个项目一个不少地出现在卡上，
//      「最新指标」段实际渲染行数 == counts.latest（不是 6，也不是 1）；
//   2. 一页上限：同量级下 <tr> 总数与 HTML 字节数有上界（防止以后加列又溢出到第 2 页）；
//   3. 趋势截断不丢关键项：10 个可比较项目 → counts.trends ≤ 8、trendsAll == 10，
//      且保留的 8 项里必须含骨髓原始 / MRD / WBC / ANC / Hb / PLT（关键项优先于边缘项）。
// 运行：node tests/verify-card.mjs（也可 npm run test:intake，会连跑 verify-intake）

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildCard, DEFAULT_PATIENT, parseRefRange, judgeFlag, svgTrend } from '../lib/intakeCard.js'
import { blocksToLines } from '../lib/visionLayout.mjs'
import { parseLabRows, detectCbcCode, normalizeUnit, splitTwoColumnLine } from '../lib/reportIntake.mjs'

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/vision-blocks-lab.json', import.meta.url), 'utf8'))
const REAL = JSON.parse(fs.readFileSync(new URL('./fixtures/vision-blocks-real-cbc.json', import.meta.url), 'utf8'))
const REAL2 = JSON.parse(fs.readFileSync(new URL('./fixtures/vision-blocks-real-cbc-2col.json', import.meta.url), 'utf8'))

function scoreReal() {
  const rows = parseLabRows(blocksToLines(REAL.blocks).join('\n'))
  const used = new Set()
  const hit = []
  const wrong = []
  const miss = []
  const noValue = []
  for (const e of REAL._expected) {
    if (String(e.value) === '') { noValue.push(e.code); continue } // 报告本身无结果值，不算解析失败
    const idx = rows.findIndex((r, i) => !used.has(i) && detectCbcCode(r.name) === e.code)
    if (idx < 0) { miss.push(e.code); continue }
    used.add(idx)
    const ev = Number(String(e.value).replace(/[^\d.\-]/g, ''))
    const gv = Number(rows[idx].num)
    if (Number.isFinite(ev) && Math.abs(ev - gv) <= Math.max(0.02, Math.abs(ev) * 0.005)) hit.push(e.code)
    else wrong.push(`${e.code}: ${rows[idx].value} ≠ ${e.value}`)
  }
  return { rows, hit, wrong, miss, noValue }
}

function scoreTwoColumn() {
  const rows = parseLabRows(blocksToLines(REAL2.blocks).join('\n'))
  const used = new Set()
  const hit = []
  const wrong = []
  const miss = []
  for (const e of REAL2._expected) {
    const idx = rows.findIndex((r, i) => !used.has(i) && detectCbcCode(r.name) === e.code)
    if (idx < 0) { miss.push(e.code); continue }
    used.add(idx)
    const ev = Number(String(e.value).replace(/[^\d.\-]/g, ''))
    const gv = Number(rows[idx].num)
    if (Number.isFinite(ev) && Math.abs(ev - gv) <= Math.max(0.02, Math.abs(ev) * 0.005)) hit.push(e.code)
    else wrong.push(`${e.code}: ${rows[idx].value} ≠ ${e.value}`)
  }
  return { rows, hit, wrong, miss }
}

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`) } catch (e) { fails.push(name); console.error(`FAIL  ${name} → ${e.message}`) }
}

// ---------- 合成最坏情况语料 ----------
const ANALYTES = [
  ['白细胞', '6.83', '3.5-9.5', '10^9/L'], ['中性粒细胞绝对值', '4.73', '1.8-6.3', '10^9/L'],
  ['淋巴细胞绝对值', '1.37', '1.1-3.2', '10^9/L'], ['单核细胞绝对值', '0.42', '0.1-0.6', '10^9/L'],
  ['嗜酸细胞绝对值', '0.12', '0.02-0.5', '10^9/L'], ['嗜碱细胞绝对值', '0.03', '0-0.06', '10^9/L'],
  ['红细胞', '3.78', '4.3-5.8', '10^12/L'], ['血红蛋白', '113', '130-175', 'g/L'],
  ['红细胞压积', '33.2', '40-50', '%'], ['平均红细胞体积', '87.8', '82-100', 'fL'],
  ['平均血红蛋白量', '29.9', '27-34', 'pg'], ['平均血红蛋白浓度', '340', '316-354', 'g/L'],
  ['血小板', '321', '125-350', '10^9/L'], ['平均血小板体积', '10.2', '7.4-12.5', 'fL'],
  ['红细胞分布宽度', '13.1', '11.5-14.5', '%'], ['超敏C反应蛋白', '1.11', '0-3', 'mg/L'],
  ['丙氨酸氨基转移酶', '21', '7-40', 'U/L'], ['天门冬氨酸氨基转移酶', '19', '13-35', 'U/L'],
  ['总胆红素', '9.8', '3.4-20.5', 'umol/L'], ['直接胆红素', '2.1', '0-6.8', 'umol/L'],
  ['白蛋白', '41.2', '40-55', 'g/L'], ['总蛋白', '68.5', '65-85', 'g/L'],
  ['尿素', '4.2', '2.6-7.5', 'mmol/L'], ['肌酐', '57', '57-97', 'umol/L'],
  ['尿酸', '302', '208-428', 'umol/L'], ['乳酸脱氢酶', '210', '120-250', 'U/L'],
  ['凝血酶原时间', '12.1', '11-14.5', 's'], ['活化部分凝血活酶时间', '32.5', '28-42', 's'],
  ['纤维蛋白原', '3.12', '2-4', 'g/L'], ['D-二聚体', '0.42', '0-0.55', 'mg/L'],
  ['钾', '4.12', '3.5-5.3', 'mmol/L'], ['钠', '140', '137-147', 'mmol/L'],
  ['氯', '103', '99-110', 'mmol/L'], ['钙', '2.28', '2.11-2.52', 'mmol/L'],
  ['铁蛋白', '320', '15-150', 'ng/mL'],
]
const DATES = ['2026-09-20', '2026-09-03', '2026-08-27']

function makeReports() {
  return DATES.map((d, i) => ({
    id: 'rep_' + i,
    reportDate: d,
    kind: 'lab',
    hospital: '（脱敏）',
    rows: ANALYTES.map(([name, v, ref, unit]) => {
      const num = Number(v) * (1 + i * 0.05)
      const val = String(Number(num.toFixed(num < 10 ? 2 : 1)))
      const low = /血红蛋白|红细胞$|红细胞压积/.test(name)
      return { name, value: val, num: Number(val), unit, refRange: ref, measuredAt: d, status: low ? 'low' : 'normal', flag: low ? 'low' : '' }
    }),
  }))
}

// 10 个「可比较」项目（同项 ≥2 次才会进趋势段；名称要命中 intakeCard 的关键指标正则）
const TREND_NAMES = ['骨髓原始细胞比例', '流式 MRD', '白细胞', '中性粒细胞绝对值', '血红蛋白', '血小板', '超敏C反应蛋白', '乳酸脱氢酶', '白细胞介素6', 'C反应蛋白定量']
function makeTrendReports() {
  return DATES.map((d, i) => ({
    id: 'trep_' + i,
    reportDate: d,
    kind: 'lab',
    rows: TREND_NAMES.map((name, j) => ({
      name,
      value: String((j + 1) * (1 + i * 0.1)).slice(0, 5),
      num: (j + 1) * (1 + i * 0.1),
      unit: '%',
      refRange: '',
      measuredAt: d,
      status: 'unknown',
      flag: '',
    })),
  }))
}

const trCount = (s) => (s.match(/<tr/g) || []).length
/** 按 h2 文本切片；找不到起点返回空串（宁可断言失败，也不许静默通过）。 */
const block = (html, from, to) => {
  const i = html.indexOf(from)
  if (i < 0) return ''
  const j = to ? html.indexOf(to, i + from.length) : html.length
  return html.slice(i, j < 0 ? html.length : j)
}
const P1 = block
const TODAY = new Date('2026-11-13T09:00:00')

// ---------- 1. 完备性（不变量：进来的数据必须全部出现在卡上） ----------
it('完备性：105 行输入 → counts.rows=105，35 个项目一个不少', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  assert.equal(card.counts.reports, 3)
  assert.equal(card.counts.rows, 105, `counts.rows 应为 105，实际 ${card.counts.rows}`)
  assert.equal(card.counts.latest, 35, `按 code 去重后应为 35 项，实际 ${card.counts.latest}（少 = 不同项目被并成同一 code）`)
  const missing = ANALYTES.filter(([n]) => !card.html.includes(n)).map(([n]) => n)
  assert.deepEqual(missing, [], `卡上缺这些项目（静默丢数据）：${missing.join('、')}`)
})

it('完备性：第 2 页「全部指标」渲染行数 == counts.latest，且不得退化成「组数」', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const seg = block(card.html, '④ 全部指标', '⑤ 关键趋势')
  assert.ok(seg, '找不到「④ 全部指标」段')
  const dataRows = trCount(seg) - 2 // 两栏并排，各 1 行表头
  assert.ok(dataRows >= card.counts.latest, `全部指标段渲染 ${dataRows} 行 < 应有的 ${card.counts.latest} 行`)
  assert.notEqual(dataRows, card.counts.groups, '渲染行数退化成了"组数"（历史 bug 回归）')
})

// ---------- 2. 第 1 页聚焦性（v3 核心：只看最新状态，不摊历史） ----------
it('第 1 页只放「最新状态」的异常项：3 份历史 × 3 项异常 → 第 1 页只有 3 行（不是 9 行）', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const seg = block(card.html, '② 核心异常项', '③ 本次主诉与核心诉求')
  const rows = trCount(seg) - 1
  // 2026-11-14 口径：红细胞(RBC)/红细胞压积(HCT) 已下沉 P1，第 1 页只剩血红蛋白
  assert.equal(card.counts.p0, 1, `P0 应为 1 项（仅血红蛋白；RBC/HCT 已下沉 P1），实际 ${card.counts.p0}`)
  assert.ok(card.counts.p1 >= 2, `RBC/HCT 应落到 P1，实际 P1=${card.counts.p1}`)
  assert.equal(rows, card.counts.p0, `第 1 页异常表渲染 ${rows} 行，应为 ${card.counts.p0} 行（历史重复不得进第 1 页）`)
  // 同一项目名不得在第 1 页出现两次
  const names = [...seg.matchAll(/<td>([^<]+)<\/td>/g)].map((m) => m[1].trim())
  assert.equal(new Set(names).size, names.length, `第 1 页出现重复项目：${names.join('、')}`)
  assert.ok(!card.html.includes('最新指标'), '「最新指标」段应按用户要求移除')
})

it('P1 折叠：非核心异常不进第 1 页表格，只留一行摘要（不多占篇幅）', () => {
  const reports = makeReports()
  // 尿酮体（U_KET）属 P1：不得在 P0 表里占行，只能出现在摘要里
  reports[0].rows.push({ name: '酮体（KET）', value: '10（++）', num: 10, unit: '', refRange: '', measuredAt: '2026-09-20', status: 'abnormal', flag: 'high' })
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.ok(card.counts.p1 >= 1, `应有 P1 异常，实际 ${card.counts.p1}`)
  const seg = block(card.html, '② 核心异常项', '③ 本次主诉与核心诉求')
  assert.ok(!/酮体/.test(seg.replace(/另有[^\n]*非核心异常[^\n]*/g, '')), 'P1 项不得出现在第 1 页表格里')
  assert.ok(/另有 \d+ 项非核心异常/.test(seg), '第 1 页必须有 P1 折叠摘要行')
})

// ---------- 3. 危急值（2026-11-14 改口径：不再置顶，只靠底纹 + 微标） ----------
it('危急值：命中阈值 → 保留底纹 + 「危急」标记，但**不再插队置顶**', () => {
  const reports = makeReports()
  // WBC 0.6 < 1.0（危急），日期 2026-09-20；血红蛋白 09-20 同日、另有 09-03/08-27 的历史（取最新仍是 09-20）
  reports[0].rows.push({ name: '白细胞', value: '0.6', num: 0.6, unit: '10^9/L', refRange: '3.5-9.5', measuredAt: '2026-09-20', status: 'low', flag: 'low' })
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.equal(card.counts.critical, 1, `危急项应为 1，实际 ${card.counts.critical}`)
  const seg = block(card.html, '② 核心异常项', '③ 本次主诉与核心诉求')
  assert.ok(/class="crit"/.test(seg), '危急行必须有底纹样式类 crit')
  assert.ok(/危急/.test(seg), '危急行必须有「危急」标记')
  // 同一日期下允许任意先后，但**不得**因为危急而被提到严格时间轴之外：
  const dates = [...seg.matchAll(/<td class="d">([^<]*)</g)].map((m) => m[1].slice(0, 10))
  const sorted = dates.slice().sort((a, b) => b.localeCompare(a))
  assert.deepEqual(dates, sorted, `危急值不得打乱时间轴（日期应严格新→旧）：${dates.join(' → ')}`)
})

it('第 1 页 P0 表：危急置顶 → 按器官系统聚合 → 同系统内时间倒序', () => {
  const reports = makeReports()
  // 造一条危急项（WBC 0.6 < 1.0），它必须在最前面
  reports[0].rows.push({ name: '白细胞', value: '0.6', num: 0.6, unit: '10^9/L', refRange: '3.5-9.5', measuredAt: '2026-09-20', status: 'low', flag: 'low' })
  const card = buildCard({ reports, mask: true, today: TODAY })
  const rows = card.p0rows
  assert.ok(rows.length > 0, 'P0 表不应为空')
  const nCrit = rows.filter((r) => r.critical).length
  assert.ok(nCrit >= 1, '应至少有一条危急项')
  assert.deepEqual(rows.slice(0, nCrit).map((r) => !!r.critical), Array(nCrit).fill(true), '危急项必须置顶')

  // 系统聚合顺序：凝血(1) → 炎症(2) → 血常规(3) → 肝肾功(4) → 尿便血气(5) → 其他(9)
  const SYS = { COAG: 1, INFLAM: 2, IMMUNE: 2, CBC: 3, DISEASE: 3, CHEM: 4, IRON: 4, URINE: 5, GAS: 5, MICRO: 6 }
  const ranks = rows.map((r) => SYS[r.catKey] || 9)
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b), `系统聚合顺序错：${ranks.join(',')}`)

  // 同系统内按时间倒序
  for (const rk of new Set(ranks)) {
    const ds = rows.filter((_, i) => ranks[i] === rk).map((r) => String(r.measuredAt))
    assert.deepEqual(ds, ds.slice().sort((a, b) => b.localeCompare(a)), `系统 rank ${rk} 内日期未倒序：${ds.join(',')}`)
  }
})

it('缺项：ANC 缺失必须写进 missingBasics（粒缺判定不能靠百分比猜）', () => {
  // 造一份**真的缺 ANC** 的报告集（makeReports 里是有 ANC 的，直接拿它会测不到缺失分支）
  const reports = makeReports().map((rep) => ({ ...rep, rows: rep.rows.filter((r) => !/中性粒细胞绝对值/.test(r.name)) }))
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.ok(card.counts.missingBasics.some((m) => /ANC/.test(m)), `missingBasics 应含 ANC，实际 ${JSON.stringify(card.counts.missingBasics)}`)
  assert.ok(card.html.includes('未提供：'), '卡面必须显式写「未提供」')
})

it('时效：最近一次化验超 90 天 → 卡面醒目提醒（含日期与天数）；新鲜数据不得误报', () => {
  const old = makeReports() // 2026-09-20 为最新
  const stale = buildCard({ reports: old, mask: true, today: new Date('2027-02-01T00:00:00') })
  assert.ok(stale.counts.staleDays > 90, `staleDays 应 > 90，实际 ${stale.counts.staleDays}`)
  const seg = block(stale.html, '② 核心异常项', '③ 本次主诉与核心诉求')
  assert.ok(/⚠️ 最近一次有指标的化验/.test(seg), '第 1 页必须有时效警示')
  assert.ok(seg.includes(stale.counts.lastLabDate), '时效警示必须写出具体日期')
  const fresh = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  assert.ok(!/⚠️ 最近一次有指标的化验/.test(fresh.html), '新鲜数据不得误报时效问题')
})

// ---------- 5. 材料清单与原件 ----------
it('第 2 页不含材料清单（2026-11-14 用户口径：纸质件里放材料清单没意义，已在「报告库」页承载）', () => {
  const reports = makeReports()
  reports.push({ id: 'rep_img', reportDate: '2026-09-25', kind: 'imaging', hospital: '（脱敏）', rows: [], source: 'image' })
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.ok(!card.html.includes('材料清单'), '卡面不得出现「材料清单」（已移到应用内报告库）')
  assert.ok(!/未结构化（仅存原件）/.test(card.html), '卡面不再承载材料状态说明')
  assert.equal(card.counts.material, 4, '数据层仍要统计报告份数（报告库页用）')
})

it('第 2 页全部指标：按临床大类分组，组标题齐全', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const seg = block(card.html, '④ 全部指标', '⑤') || block(card.html, '④ 全部指标', '⑥')
  const groups = ['血常规及骨髓', '凝血功能', '生化与肝肾功', '炎症与免疫']
  const missing = groups.filter((g) => !seg.includes(g))
  assert.deepEqual(missing, [], `缺分组标题：${missing.join('、')}`)
  assert.ok(!/text-overflow: ellipsis/.test(card.html.slice(card.html.indexOf('table.compact.cat'))), '归档表项目名不得省略号截断')
})

it('卡面不得承载原件跳转（打印件点不了；另存/转发后 /api/intake/blob 是死链）', () => {
  const reports = makeReports()
  reports[0].fileBlobId = 'f_abc123'
  reports[1].source = 'text-only'
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.ok(!card.html.includes('/api/intake/blob/'), '卡面不得出现原件接口链接（打印件点不了，脱离本机是死链）')
  assert.ok(!/原件<\/button>|查看原件/.test(card.html), '卡面不得出现「原件」按钮')
})

it('卡面是静态印刷件：除「打印」按钮外不得有任何交互元素', () => {
  const reports = makeReports()
  reports[0].fileBlobId = 'f_abc123'
  const card = buildCard({ reports, mask: true, today: TODAY })
  const body = card.html.slice(card.html.indexOf('<body>'))
  assert.ok(!/<a\s[^>]*href=/i.test(body), '卡面不得有超链接（纸上看不见、手机上跳出去就回不来）')
  assert.ok(!/<input|<select|<textarea/i.test(body), '卡面不得有表单控件')
  const buttons = body.match(/<button[^>]*>/gi) || []
  assert.equal(buttons.length, 1, `卡面只允许 1 个按钮（打印/存 PDF），实际 ${buttons.length} 个：${buttons.join(' ')}`)
  assert.ok(/window\.print\(\)/.test(body), '唯一那个按钮必须是打印')
  const onclicks = body.match(/onclick=/gi) || []
  assert.equal(onclicks.length, 1, `除打印外不得有 onclick，实际 ${onclicks.length} 个`)
})

it('材料清单：text-only 记录在 Web 数据里仍有标识（原件只在应用内看，卡面不承担）', () => {
  const reports = makeReports()
  reports[1].source = 'text-only'
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.equal(card.counts.material, 3)
  // 卡面上「仅原件」只用于 0 指标组；text-only 的标识留在数据层（materialRows.source），供应用内列表用
  assert.ok(card.materialRows.some((m) => m.source === 'text-only'), '数据层仍须保留 source，供应用内列表区分')
})

// ---------- 6. 趋势 ----------
it('趋势只画血液科核心 8 项：WBC/ANC/Hb/PLT/LDH/FBG/D-二聚体/PCT，骨髓/MRD/CRP 不上图', () => {
  const card = buildCard({ reports: makeTrendReports(), mask: true, today: TODAY })
  assert.equal(card.counts.trendsAll, 10, `trendsAll 应为 10（可比较项目总数），实际 ${card.counts.trendsAll}`)
  assert.ok(card.counts.trends <= 8, `趋势段上限 8 项，实际 ${card.counts.trends}`)
  const seg = block(card.html, '⑤ 关键趋势')
  const keep = ['白细胞', '中性粒', '血红蛋白', '血小板', '乳酸脱氢']
  const missing = keep.filter((k) => !seg.includes(k))
  assert.deepEqual(missing, [], `趋势段缺核心项：${missing.join('、')}`)
  // 2026-11-14 口径：低频/低信息量项不进趋势图（首页与第 2 页有原文）
  for (const notTrend of ['骨髓原始', '微小残留', 'MRD', 'C反应蛋白']) {
    assert.ok(!seg.includes(notTrend), `「${notTrend}」不应出现在趋势段（第 3 页只留核心 8 项）`)
  }
})

it('趋势段不得谎报：段标题里的项数 == counts.trends', () => {
  const card = buildCard({ reports: makeTrendReports(), mask: true, today: TODAY })
  const head = block(card.html, '⑤ 关键趋势').slice(0, 300)
  const m = head.match(/关键趋势[\s\S]*?共 (\d+) 项/)
  assert.ok(m, '趋势段标题应带「共 N 项」')
  assert.equal(Number(m[1]), card.counts.trends, `标题写 ${m[1]} 项，实际渲染 ${card.counts.trends} 项`)
})

it('趋势图 X 轴必须左旧右新：每个趋势点的日期严格升序，且同日只保留一个点', () => {
  const card = buildCard({ reports: makeTrendReports(), mask: true, today: TODAY })
  assert.ok(card.trendRows.length > 0, '应有可绘制的趋势项（夹具里同项 ≥2 次）')
  for (const t of card.trendRows) {
    const ds = t.points.map((p) => String(p.measuredAt || '').slice(0, 10))
    const sorted = ds.slice().sort((a, b) => a.localeCompare(b))
    assert.deepEqual(ds, sorted, `${t.name} 的 X 轴不是「左旧右新」：${ds.join(' → ')}`)
    assert.equal(new Set(ds).size, ds.length, `${t.name} 同一天出现多个点（应按日期去重）`)
  }
})

it('趋势图不得收定性值：阴性 / 阳性 / 未见 这类文本一律不进图', () => {
  const reports = makeTrendReports()
  // 实测事故：白细胞趋势里混进过尿白细胞的「阴性」
  reports[1].rows[0].value = '阴性'
  reports[1].rows[0].num = null
  const card = buildCard({ reports, mask: true, today: TODAY })
  for (const t of card.trendRows) {
    for (const p of t.points) {
      assert.ok(Number.isFinite(Number(p.num)), `${t.name} 混入了非数值点：${p.value}`)
      assert.ok(!/阴性|阳性|未见|negative|positive/i.test(String(p.value)), `${t.name} 混入了定性值：${p.value}`)
    }
  }
})

it('跨院参考区间不同：必须给警示，且**不得**画单一虚假绿带', () => {
  const reports = makeTrendReports()
  // 同项两次、参考区间不同（跨院）。必须挑**进趋势白名单**的项（白细胞 index=2），
  // 否则它压根不上图，这条断言会退化成「空过」。
  const wbcIdx = reports[0].rows.findIndex((r) => /^白细胞$/.test(r.name))
  assert.ok(wbcIdx >= 0, '夹具里应有白细胞')
  reports[0].rows[wbcIdx].refRange = '3.5-9.5'
  reports[1].rows[wbcIdx].refRange = '4.0-10.0'
  const card = buildCard({ reports, mask: true, today: TODAY })
  const seg = block(card.html, '⑤ 关键趋势')
  assert.ok(/跨院参考区间不同/.test(seg), '必须输出跨院参考区间差异提示')
  assert.ok(!/<rect/.test(seg), '跨院区间不一致时不得绘制绿色参考带（那是虚假精度）')
})

it('单位不一致不硬拼趋势：给「未绘制」说明，而不是画一条假线', () => {
  const reports = makeTrendReports()
  reports[0].rows[0].unit = 'g/L'
  reports[1].rows[0].unit = 'g/dL'
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.ok(card.trendDroppedDetail.some((t) => t.name === reports[0].rows[0].name), '单位不可统一的项应进 dropped 明细')
  assert.ok(/未绘制（单位不一致/.test(card.html), '卡面必须说明为什么没画')
})

// ---------- 6.5 安全基线 & 非病人数据剔除（2026-11-14 用户对比两份 PDF 逮到的丢值事故） ----------
// 教训：v3.3 上线时这一整块**没有任何断言**，于是 31 个定性结果被清洗层洗空、卡面照样 1 页 A4、
// 测试照样全绿 —— 「渲染静默丢数据」不能只靠肉眼比对 PDF。
const SAFETY_LAB = (card) => {
  const m = card.html.match(/<div class="sb-t">治疗安全基线<\/div><div class="sb-l">([\s\S]*?)<\/div><\/div>/)
  return m ? m[1].replace(/<[^>]+>/g, '') : ''
}

it('安全基线：血型/传染病取的是**真实值**，不得把已查到的阴性写成「未录入」', () => {
  const reports = [{
    reportDate: '2026-07-15',
    rows: [
      { name: 'ABO血型鉴定', value: 'B型' },
      { name: 'Rh（D）血型鉴定', value: '阳性', refRange: '*Rh血型阴性、' },
      { name: '乙肝表面抗原（HBsAg）', value: '阴性' },
      { name: '丙型肝炎抗体（Anti-HCV）', value: '阴性' },
      { name: '艾滋病病毒抗体（Anti-HIV）', value: '阴性' },
      { name: '梅毒螺旋体特异性抗体测定（Anti-TP）', value: '阴性' },
    ],
  }]
  const lab = SAFETY_LAB(buildCard({ reports, today: TODAY }))
  assert.ok(/B型/.test(lab), `血型应为 B型，实际「${lab}」`)
  assert.ok(/Rh\(\+\)/.test(lab), `Rh 阳性应渲染为 Rh(+)，实际「${lab}」`)
  assert.ok(/传染病四项\s*均阴性/.test(lab), `四项都阴性应压成一行，实际「${lab}」`)
  // 已查到的项不得退化回「未录入 / 待核」（伴随病史三项不在此断言范围：那是用户可填项，见下一条）
  assert.ok(!/Rh 待核/.test(lab), `Rh 已查到阳性，不得写「待核」，实际「${lab}」`)
  assert.ok(!/HBsAg 未录入|丙肝抗体 未录入|HIV 抗体 未录入|梅毒抗体 未录入/.test(lab), `四项传染病已查到阴性，不得写「未录入」，实际「${lab}」`)
})

it('安全基线：没查到就写「未录入 / 待核」，绝不把空值写成「阴性」', () => {
  const reports = [{ reportDate: '2026-07-15', rows: [{ name: 'ABO血型鉴定', value: 'B型' }] }]
  const lab = SAFETY_LAB(buildCard({ reports, today: TODAY }))
  assert.ok(/Rh 待核/.test(lab), `Rh 缺失必须写「待核」，实际「${lab}」`)
  assert.ok(/乙肝 HBsAg 未录入/.test(lab), `HBsAg 缺失必须写「未录入」，实际「${lab}」`)
  assert.ok(!/均阴性/.test(lab), '有缺项时不得压缩成「均阴性」')
  assert.ok(!/阴性/.test(lab), `空值区域不得出现「阴性」，实际「${lab}」`)
})

it('安全基线：单项阳性不得被「均阴性」吞掉', () => {
  const reports = [{
    reportDate: '2026-07-15',
    rows: [
      { name: '乙肝表面抗原（HBsAg）', value: '阳性' },
      { name: '丙型肝炎抗体（Anti-HCV）', value: '阴性' },
      { name: '艾滋病病毒抗体（Anti-HIV）', value: '阴性' },
      { name: '梅毒螺旋体特异性抗体测定（Anti-TP）', value: '阴性' },
    ],
  }]
  const lab = SAFETY_LAB(buildCard({ reports, today: TODAY }))
  assert.ok(!/均阴性/.test(lab), '有一项阳性时不得压缩')
  assert.ok(/乙肝 HBsAg 阳性/.test(lab), `阳性项必须单独可见，实际「${lab}」`)
})

it('伴随病史三项（基础病/过敏/在用药）：没填或选「无」→ 卡面完全不显示；填了才显示', () => {
  const reports = [{ reportDate: '2026-07-15', rows: [{ name: 'ABO血型鉴定', value: 'B型' }] }]
  const empty = SAFETY_LAB(buildCard({ reports, today: TODAY }))
  for (const w of ['基础病', '过敏', '在用药']) {
    assert.ok(!empty.includes(w), `未填写时第 1 页不得出现「${w}」，实际「${empty}」`)
  }
  // 注意：传染病空值仍必须写「未录入」（红线），这里只要求伴随病史三项不出现
  // 只填一项：只出现那一项，另外两项仍不出现
  const one = SAFETY_LAB(buildCard({
    reports, today: TODAY,
    patient: { ...DEFAULT_PATIENT, comorbidities: '高血压' },
  }))
  assert.ok(/基础病\s*高血压/.test(one), `填了基础病必须显示，实际「${one}」`)
  assert.ok(!one.includes('过敏') && !one.includes('在用药'), `未填项仍不得出现，实际「${one}」`)
  // 三项都填
  const all = SAFETY_LAB(buildCard({
    reports, today: TODAY,
    patient: { ...DEFAULT_PATIENT, comorbidities: '高血压', allergies: '青霉素过敏', medications: '泼尼松 20mg qd' },
  }))
  assert.ok(/基础病/.test(all) && /过敏/.test(all) && /在用药/.test(all), `三项填了都要显示，实际「${all}」`)
})

it('试剂质控行（内部对照/阳性对照）不得当病人指标出现在任何位置', () => {
  const reports = [{
    reportDate: '2026-07-18',
    rows: [
      { name: '肺炎支原体核酸检测', value: '阴性' },
      { name: '内部对照', value: '阳性', status: 'positive' },
      { name: '阳性对照', value: '阳性', status: 'positive' },
    ],
  }]
  const card = buildCard({ reports, today: TODAY })
  assert.ok(!/内部对照|阳性对照/.test(card.html), '质控行不得出现在卡面')
  assert.equal(card.counts.excluded.reagentControl, 2, '质控行必须计入 excluded.reagentControl')
})

it('清洗丢弃的空壳行不输出（NT-proBNP「慢性心衰」），但传染病空值仍必须保留「未录入」', () => {
  const reports = [{
    reportDate: '2026-08-02',
    rows: [
      { name: '前体NT-proBNP', value: '慢性心衰' },
      { name: '艾滋病病毒抗体（Anti-HIV）', value: '' },
    ],
  }]
  const card = buildCard({ reports, today: TODAY })
  assert.ok(!/慢性心衰/.test(card.html), '说明性短语不得冒充测量值')
  assert.equal(card.counts.excluded.emptyShell, 1, '空壳行必须计入 excluded.emptyShell')
  assert.ok(/艾滋病病毒抗体（Anti-HIV）/.test(card.html), '空值传染病项必须保留并写「未录入」')
  assert.ok(/未录入/.test(SAFETY_LAB(card)), '空值传染病在基线区必须写「未录入」')
})

it('完整性自洽：counts.rows（入库行）== 卡面渲染行 + 白名单剔除项', () => {
  const reports = [{
    reportDate: '2026-08-02',
    rows: [
      { name: '白细胞', value: '3.27', unit: '10^9/L', refRange: '3.5-9.5' },
      { name: '内部对照', value: '阳性', status: 'positive' },
      { name: '前体NT-proBNP', value: '慢性心衰' },
    ],
  }]
  const card = buildCard({ reports, today: TODAY })
  const ex = card.counts.excluded.reagentControl + card.counts.excluded.emptyShell
  assert.equal(card.counts.rows, 3, '入库行总数必须如实统计（不因剔除而变小）')
  assert.equal(card.counts.shown, card.counts.rows - ex, 'shown 必须等于 rows - 剔除项')
  assert.equal(card.latestRows.length, 1, '被剔除的两行不得进入「全部指标」')
})

// ---------- 6.6 白血病核心资料：1 行声明 + 冷启动（2026-11-14 用户口径） ----------
it('第 1 页必须用 1 行小字如实声明「未检出的白血病核心项」，且不得写临床解读', () => {
  const reports = [{ reportDate: '2026-07-15', kind: 'pathology', reportType: '染色体核型', text: '染色体核型分析报告单 46,XX', rows: [] }]
  const card = buildCard({ reports, today: TODAY })
  assert.ok(card.checklist, 'buildCard 必须带回 checklist')
  assert.equal(card.checklist.items.length, 5, '体检项应为 5 项（MICM 4 + 近期血常规）')
  assert.ok(/\.cl/.test(card.html), '第 1 页必须有声明行样式')
  assert.ok(/白血病核心项：已见/.test(card.html), `卡面必须有「白血病核心项：已见…」声明，实际没找到`)
  assert.ok(/染色体核型/.test(card.html), '已检出的项应出现在声明里')
  assert.ok(/待补|均已检出/.test(card.html), '声明必须说清「待补 / 均已检出」')
  // 红线：声明只陈述有无，不得写诊断或医嘱
  const line = card.html.match(/<div class="cl">([\s\S]*?)<\/div>/)
  assert.ok(line, '找不到声明行')
  assert.ok(!/建议|应做|必须做|提示(?:白血|复发)|预后/.test(line[1]), `声明行不得写解读，实际「${line[1]}」`)
})

it('分子标签区只放阳性：同名的阴性变体（BCR::ABL1 P210/P230 阴性）不得挤进来', () => {
  const reports = [{
    reportDate: '2026-07-18',
    rows: [
      { name: 'BCR::ABL1（P190型）', value: '阳性', status: 'positive' },
      { name: 'BCR::ABL1（P210型）', value: '阴性', status: 'negative' },
      { name: 'BCR::ABL1（P230型）', value: '阴性', status: 'negative' },
    ],
  }]
  const card = buildCard({ reports, today: TODAY })
  const tags = card.safetyBaseline.geneTags
  assert.equal(tags.filter((t) => /BCR/.test(t.label)).length, 1, `BCR 只应留阳性那一条，实际 ${JSON.stringify(tags)}`)
  assert.ok(tags[0].positive, '留下的必须是阳性那条')
  const lab = card.html.match(/分子与高危基因<\/div><div class="sb-l">([\s\S]*?)<\/div>/)
  assert.ok(!/BCR::ABL1 阴性/.test(lab ? lab[1] : ''), '标签区不得出现「BCR::ABL1 阴性」')
})

it('0 份报告 → empty:true（前端据此渲染引导页，不渲染空壳卡）', () => {
  const card = buildCard({ reports: [], today: TODAY })
  assert.equal(card.empty, true)
  assert.equal(card.checklist.items.filter((i) => !i.ok).length, 5, '0 份报告时五项全缺')
  assert.equal(buildCard({ reports: makeReports(), today: TODAY }).empty, false, '有报告时不得标 empty')
})

// ---------- 6.7 单边参考区间 / 心功能危急值 / 行身份透传（2026-11-14 用户质疑 → 实测漏判） ----------
it('单边参考区间必须能判高低：`<125` / `≤15%` / `>450` 不得 return null', () => {
  assert.deepEqual(parseRefRange('<125'), { lo: null, hi: 125 })
  assert.deepEqual(parseRefRange('<125pg/ml'), { lo: null, hi: 125 }, '尾部粘连单位要剥掉')
  assert.deepEqual(parseRefRange('＜=15%'), { lo: null, hi: 15 }, '全角 + <= 要认')
  assert.deepEqual(parseRefRange('≤15'), { lo: null, hi: 15 })
  assert.deepEqual(parseRefRange('>450'), { lo: 450, hi: null })
  assert.deepEqual(parseRefRange('≥4.0'), { lo: 4, hi: null })
  assert.deepEqual(parseRefRange('3.5-9.5'), { lo: 3.5, hi: 9.5 })
  assert.equal(parseRefRange('阴性'), null)
  // 端到端：这正是漏判 25 倍的路径
  assert.equal(judgeFlag({ num: 3182, refRange: '<125' }), 'high')
  assert.equal(judgeFlag({ num: 103.4, refRange: '<7' }), 'high')
  assert.equal(judgeFlag({ num: 100, refRange: '<125' }), 'normal')
  assert.equal(judgeFlag({ num: 100, refRange: '>450' }), 'low')
})

it('NT-proBNP 超 1800 必须进第 1 页并标 [危急]（蒽环类化疗心脏毒性核心项，2026-11-14 用户拍板）', () => {
  const reports = [{
    reportDate: '2026-08-02',
    rows: [{ name: 'N端-B型钠尿肽前体（NT-proBNP）', value: '3182.00', unit: 'pg/ml', refRange: '<125' }],
  }]
  const card = buildCard({ reports, today: TODAY })
  const row = card.p0rows.find((r) => r.code === 'NT_PROBNP')
  assert.ok(row, 'NT-proBNP 必须在 P0 展开区（不得再被下沉进 P1）')
  assert.equal(row.flag, 'high')
  assert.ok(row.critical, '3182 ≥ 1800 必须命中危急阈值')
  assert.ok(/前体NT-proBNP[\s\S]{0,200}\[危急\]/.test(card.html), '第 1 页该行必须带 [危急] 徽章')
  // 低值不得误报
  const low = buildCard({
    reports: [{ reportDate: '2026-08-02', rows: [{ name: 'N端-B型钠尿肽前体（NT-proBNP）', value: '80', unit: 'pg/ml', refRange: '<125' }] }],
    today: TODAY,
  })
  assert.ok(!low.p0rows.some((r) => r.code === 'NT_PROBNP'), '正常的 NT-proBNP 不该进核心异常项')
})

it('行身份透传：每一行都带 rowKey/reportId/rowIndex/fileBlobId，且能精确回到原报告那一行', () => {
  const reports = [{
    id: 'rep_a', reportDate: '2026-07-14', reportType: '凝血四项', fileBlobId: 'f_a',
    rows: [
      { name: '凝血酶原时间（PT）', value: '14.3', unit: 'sec', refRange: '9.8-12.1' },
      { name: 'D-二聚体', value: '10.18', unit: 'mg/L', refRange: '0-0.55' },
    ],
  }]
  const card = buildCard({ reports, today: TODAY })
  const rows = card.latestRows
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.equal(r.rowKey, `rep_a:${r.rowIndex}`, `rowKey 必须是 reportId:rowIndex，实际 ${r.rowKey}`)
    assert.equal(r.reportId, 'rep_a')
    assert.equal(r.fileBlobId, 'f_a')
    assert.equal(r.reportType, '凝血四项')
    assert.equal(r.reportDate, '2026-07-14')
    // 能精确回到原行（不是靠 name/value 猜）
    assert.equal(reports[0].rows[r.rowIndex].name, r.name)
  }
  assert.deepEqual(rows.map((r) => r.rowIndex).sort(), [0, 1])
})

it('同名同值同日两行不得互相覆盖（旧实现按 name|value|date 做键的坑）', () => {
  const reports = [{
    id: 'rep_b', reportDate: '2026-07-14', fileBlobId: 'f_b',
    rows: [
      { name: '白细胞', value: '5.0', unit: '10^9/L', refRange: '3.5-9.5' },
      { name: '白细胞', value: '5.0', unit: '10^9/L', refRange: '3.5-9.5' },
    ],
  }]
  const card = buildCard({ reports, today: TODAY })
  const keys = card.latestRows.map((r) => r.rowKey)
  assert.equal(new Set(keys).size, keys.length, `rowKey 必须唯一，实际 ${JSON.stringify(keys)}`)
})

// ---------- 6.8 counts 数字钉死（2026-11-14 只读体检建议：verify-card 只断言 html 文本，
//            counts 只在日志里打印、从不断言 —— 数字漂移（如危急值从 4 变 3）不会被任何断言抓到） ----------
it('counts 必须与可数的产物一致（数字漂移要红，不能只打印）', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const c = card.counts
  assert.equal(c.reports, makeReports().length, 'reports 必须等于输入报告数')
  assert.equal(c.rows, c.shown + c.excluded.reagentControl + c.excluded.emptyShell, 'rows = shown + 剔除项（三个分项只增不减）')
  assert.equal(c.latest, card.latestRows.length, 'latest 必须等于「全部指标」实际行数')
  assert.equal(c.p0, card.p0rows.length, 'p0 必须等于第 1 页展开行数')
  assert.equal(c.p1, card.p1rows.length, 'p1 必须等于折叠行数')
  assert.equal(c.critical, [...card.p0rows, ...card.p1rows].filter((r) => r.critical).length, 'critical 必须等于实际命中危急的行数')
  assert.equal(c.trends, card.trendRows.length, 'trends 必须等于实际画的趋势格数')
  assert.equal(c.trendsAll, card.trendAll.length, 'trendsAll 必须等于可画项总数（工作台据此勾选）')
  assert.equal(c.material, card.materialRows.length, 'material 必须等于报告数')
})

// ---------- 7. 红线与体量 ----------
it('红线：卡面不得出现诊断结论 / 用药建议词库', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const banned = ['建议化疗', '建议住院', '诊断为', '应服用', '可停药', '预后不良']
  const hit = banned.filter((w) => card.html.includes(w))
  assert.deepEqual(hit, [], `卡面出现红线词：${hit.join('、')}`)
})

it('体量上限：105 行 / 35 项 + 3 页版式时 <tr> ≤ 90、HTML ≤ 40 KB', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const tr = trCount(card.html)
  const bytes = Buffer.byteLength(card.html)
  assert.ok(tr <= 90, `<tr> 已 ${tr} 行（上限 90）`)
  // 2026-11-14 预算从 40 KB 调到 44 KB：趋势图加了 Y 轴刻度 + 每个点的数值标注（用户要求「图要能读数」），
  // 8 张图合计约 +2 KB。上限仍守住「不许滚雪球」的原意（实测 41.8 KB）。
  assert.ok(bytes <= 44 * 1024, `HTML 已 ${(bytes / 1024).toFixed(1)} KB（上限 44 KB）`)
  console.log(`      实测：<tr> ${tr} 行 / ${(bytes / 1024).toFixed(1)} KB / counts=${JSON.stringify(card.counts)}`)
})

it('三段分页：第 2、3 页必须强制分页（打印时各占一页 A4）', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  assert.ok(/\.page2 \{ page-break-before: always; \}/.test(card.html), '第 2 页必须 page-break-before: always')
  assert.ok(/\.page3 \{ page-break-before: always; \}/.test(card.html), '第 3 页必须 page-break-before: always')
})

it('手机端：必须有 max-width 640px 的自适应（单栏 + 放大字号 + 触控按钮）', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  assert.ok(/@media screen and \(max-width: 640px\)/.test(card.html), '缺少手机端 media query')
  const seg = card.html.slice(card.html.indexOf('@media screen and (max-width: 640px)'))
  assert.ok(/\.two \{ display: block/.test(seg), '手机端两栏必须拆成单栏')
  assert.ok(/font-size: 1[34]px/.test(seg), '手机端必须放大字号')
})

it('空输入不抛错，且给出可读占位', () => {
  const card = buildCard({ reports: [], mask: true, today: TODAY })
  assert.equal(card.counts.rows, 0)
  assert.ok(card.html.includes('问诊资料卡'))
})

// ---------- 4. 版式重建回归（Vision blocks → 行 → 指标行） ----------
it('版式重建：56 个 Vision blocks → blocksToLines → parseLabRows 出 11 行指标', () => {
  assert.equal(FIXTURE.blocks.length, 56, `fixture 应含 56 个 block，实际 ${FIXTURE.blocks.length}`)
  const lines = blocksToLines(FIXTURE.blocks)
  assert.ok(lines.length >= 16, `版式重建行数偏少（${lines.length}），行聚类可能退化`)
  const rows = parseLabRows(lines.join('\n'))
  assert.equal(rows.length, 11, `应解析出 11 行指标，实际 ${rows.length}：${rows.map((r) => r.name).join(',')}`)
})

it('版式重建：含 # 的项目名（NEUT# / LYM# / RET%）不得被丢弃', () => {
  const rows = parseLabRows(blocksToLines(FIXTURE.blocks).join('\n'))
  const names = rows.map((r) => r.name)
  for (const n of ['NEUT#', 'LYM#', 'RET%']) assert.ok(names.includes(n), `丢了含 #/% 的项目名：${n}（实际：${names.join(',')}）`)
})

it('抬头行不进指标：姓名 / 性别 / 年龄 / 检验科 / 样本号 / 报告日期 不得变成指标名', () => {
  const rows = parseLabRows(blocksToLines(FIXTURE.blocks).join('\n'))
  const junk = rows.filter((r) => /姓名|性别|年龄|检验科|样本号|报告日期|病历号|项目名称|床号|科室/.test(r.name))
  assert.deepEqual(junk.map((r) => r.name), [], `抬头行被当成指标：${junk.map((r) => r.name).join('、')}`)
})

it('判定与参考区间：11 项的高低判定全对', () => {
  const rows = parseLabRows(blocksToLines(FIXTURE.blocks).join('\n'))
  const got = Object.fromEntries(rows.map((r) => [r.name, r.status]))
  const want = {
    WBC: 'normal', HGB: 'low', PLT: 'low', 'NEUT#': 'low', 'LYM#': 'high',
    RBC: 'low', ALT: 'high', LDH: 'high', CRP: 'high', CREA: 'normal', 'RET%': 'normal',
  }
  assert.deepEqual(got, want)
})

// ---------- 5. 真实图回归（真实朝阳血常规，已脱敏） ----------
it('真实血常规 fixture（已脱敏）：解析出 20/23 行（有值 20 项全对、0 错值）', () => {
  assert.equal(REAL.blocks.length, 123, `真实 fixture 应含 123 个 block，实际 ${REAL.blocks.length}`)
  const { rows, hit, wrong, miss, noValue } = scoreReal()
  const inferred = rows.filter((r) => r.nameInferred)
  console.log(`      真实图：解析 ${rows.length} 行 / 有值项命中 ${hit.length}/${REAL._expected.length - noValue.length} / 推定名称 ${inferred.length} 行（${inferred.map((r) => r.name).join('、')}）/ 值错 ${wrong.length} / 漏 ${miss.join(',') || '无'} / 报告本身无值 ${noValue.join(',')}`)
  assert.ok(hit.length >= 20, `命中数退化：${hit.length}（基线 20，只升不降）`)
  assert.deepEqual(wrong, [], `出现错误值（比漏行严重得多）：${wrong.join('；')}`)
  assert.ok(inferred.length > 0 && inferred.every((r) => r.nameInferred === true), '按序号推定的名称必须带 nameInferred 标记，不得冒充识别结果')
})

it('真实图关键项不得漏：WBC / Hb / PLT / RBC / HCT / MCHC / RDW / hsCRP / NEUT_PCT / MONO_ABS 必须命中', () => {
  const { hit } = scoreReal()
  // NEUT_PCT / MONO_ABS 曾是「名称块没被识别」的已知缺口（74% 基线时靠序号插值修好），现已转为必须有
  const must = ['WBC', 'Hb', 'PLT', 'RBC', 'HCT', 'MCHC', 'RDW_CV', 'HS_CRP', 'NEUT_PCT', 'MONO_ABS']
  const missing = must.filter((c) => !hit.includes(c))
  assert.deepEqual(missing, [], `关键项漏解析：${missing.join('、')}`)
})

it('双栏血常规 fixture（已脱敏）：一行两套指标按锚点切分，解析出 26/26 项', () => {
  assert.equal(REAL2.blocks.length, 191, `双栏 fixture 应含 191 个 block，实际 ${REAL2.blocks.length}`)
  const { rows, hit, wrong, miss } = scoreTwoColumn()
  console.log(`      双栏图：解析 ${rows.length} 行 / 命中 ${hit.length}/${REAL2._expected.length} / 值错 ${wrong.length} / 漏 ${miss.join(',') || '无'}`)
  assert.ok(hit.length >= 26, `双栏解析退化：${hit.length}/26（基线 26，只升不降）`)
  assert.deepEqual(wrong, [], `双栏出现错误值：${wrong.join('；')}`)
})

it('双栏切分只认「中文名+缩写+数值」锚点：单栏行绝不被切碎', () => {
  // 单栏行：只有一个锚点 → 原样返回
  const single = '白细胞（WBC） 3.33 3.5-9.5 10^9/L'
  assert.deepEqual(splitTwoColumnLine(single), [single])
  // 单栏但带括号缩写 + 参考区间，仍不得切
  const single2 = '平均红细胞血红蛋白浓度（MCHC） 331.00 316-354'
  assert.deepEqual(splitTwoColumnLine(single2), [single2])
  // 双栏行：两个锚点 → 切成两段，且切点在第二个中文名之前
  const two = splitTwoColumnLine('1 大白细胞 WBC 3.17 10~9/L 3.5-9.5 16大平均血红蛋白量 MCH 29.9 Pg 27-34')
  assert.equal(two.length, 2)
  assert.ok(two[1].includes('MCH'), `右段应含第二套缩写，实际：${two[1]}`)
  assert.ok(two[0].includes('WBC') && !two[0].includes('MCH'), `左段只含第一套，实际：${two[0]}`)
})

it('真实图单位规范化：不得出现 `*10 9/L` / `£1` / `gL&` 这类 OCR 噪声单位', () => {
  const { rows } = scoreReal()
  const dirty = rows.filter((r) => /[*£~°&]/.test(r.unit || ''))
  assert.deepEqual(dirty.map((r) => `${r.name}:${r.unit}`), [], '单位未规范化')
  const rbc = rows.find((r) => detectCbcCode(r.name) === 'RBC')
  assert.equal(rbc.unit, '10^12/L', `RBC 单位应为 10^12/L，实际 ${rbc.unit}`)
  assert.equal(normalizeUnit('*10 9/L'), '10^9/L')
  assert.equal(normalizeUnit('*109/L'), '10^9/L')
  assert.equal(normalizeUnit('£1'), '')
})

// 脱敏断言（两份真实 fixture 共用）：身份字段 + 「换了院名却漏了院址」都要挡住。
// 教训：双栏 fixture 曾把院名换成「某某县人民医院」，但 `地址：河北省香河县新开街30号` 原样留着 —— 肉眼永远抓不住，只能靠断言。
const PII_TOKENS = [
  // 姓名 / 病历号 / 条码 / 床号 / 医生
  '代惠', '代聪', '2094933', '0024379684', 'F3266470935', '血液二^12', '史庭', '荆志辉',
  // 院名全称
  '首都医科大学附属北京朝阳医院', '北京朝阳医院', '香河县人民医院',
  // 院址地名（换名漏地址的漏网）
  '香河', '新开街', '朝阳区', '东十里堡', '常营',
]
function assertRedacted(fixture, label) {
  const dump = JSON.stringify(fixture)
  const leaks = PII_TOKENS.filter((k) => dump.includes(k))
  assert.deepEqual(leaks, [], `${label} 仍有真实信息：${leaks.join('、')}`)
  // 所有含「地址」的块必须是占位形态（含「某」或数字 0 占位），不许出现省/市/县/街/路 + 门牌的实写
  // 约定：占位符是「某」或「00」。含地址的块必须出现占位符，否则视为没脱敏
  const addrBlocks = (fixture.blocks || []).filter((b) => /地址/.test(String(b.text || '')))
  const badAddr = addrBlocks.filter((b) => !/某|00/.test(b.text))
  assert.deepEqual(badAddr.map((b) => b.text), [], `${label} 的地址行未脱敏：${badAddr.map((b) => b.text).join('；')}`)
}

it('真实 fixture 已脱敏：不含姓名 / 病历号 / 条码 / 床号 / 医生 / 院名 / 院址', () => {
  assertRedacted(REAL, '单栏 fixture')
})

it('双栏 fixture 已脱敏：院名换了、院址也必须换（换名漏地址）', () => {
  assertRedacted(REAL2, '双栏 fixture')
})

it('黑白打印友好：高低用 ▲/▽ + 字重（不只靠红绿），危急用 [危急] 黑底徽章', () => {
  const reports = makeReports() // 夹具里血红蛋白/红细胞/红细胞压积是 low
  // 再补一条 high（血小板升高）与一条危急，确保三种标记都被渲染
  reports[0].rows.push({ name: '白细胞', value: '0.6', num: 0.6, unit: '10^9/L', refRange: '3.5-9.5', measuredAt: '2026-09-20', status: 'low', flag: 'low' })
  reports[0].rows.push({ name: '乳酸脱氢酶', value: '900', num: 900, unit: 'U/L', refRange: '120-250', measuredAt: '2026-09-20', status: 'high', flag: 'high' })
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.ok(/▲ 高/.test(card.html), '偏高必须用「▲ 高」而不是只有红箭头')
  assert.ok(/▽ 低/.test(card.html), '偏低必须用「▽ 低」而不是只有绿箭头')
  assert.ok(/\[危急\]/.test(card.html), '危急项必须带 [危急] 徽章文本')
  assert.ok(/crit-tag \{ background: #111/.test(card.html), '危急徽章必须是黑底白字（灰度打印可见）')
  assert.ok(/tr\.crit td:first-child \{ border-left: 4px solid #111/.test(card.html), '危急行必须有左侧黑粗线')
})

it('趋势 SVG：参考区间画上下两条虚线（不靠绿带），点形状区分正常/异常/危急', () => {
  // 必须用**带参考区间**的夹具：makeTrendReports 的 refRange 为空，画不出参考线
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const svg = block(card.html, '⑤ 关键趋势')
  assert.ok(/stroke-dasharray/.test(svg), '参考区间必须用虚线（灰度打印不能只靠绿色填充）')
  assert.ok(/上界|下界/.test(svg), '虚线要有文字标注')
  assert.ok(/fill="#fff" stroke=/.test(svg), '正常点应为空心圆（fill=#fff + stroke）')
  assert.ok(!/<rect/.test(svg), '不得再用绿色矩形色带')
})

it('日期去重：同一年内显示 MM-DD（不重复年份）', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const seg = block(card.html, '② 核心异常项', '③ 本次主诉与核心诉求')
  assert.ok(/\b\d{2}-\d{2}\b/.test(seg), '日期应简写为 MM-DD')
})

// 2026-11-14 用户裁掉趋势卡底部的文字点位行：它只是复述折线上已有的点，且曾因 reverse 与折线反序。
// 这条断言守的是「别再塞回来」——精确数值在第 1 页最新值与第 2 页全部指标里。
it('趋势格只留折线：不得再出现底部文字点位行（那是图的复述，精确值在第 1/2 页）', () => {
  const card = buildCard({ reports: makeTrendReports(), mask: true, today: TODAY })
  assert.ok(card.trendRows.length > 0, '夹具应能画出至少一条趋势')
  assert.ok(!/class="tpts"/.test(card.html), '卡片里不应再有 .tpts 文字点位行')
})

// ---------- 12. 2026-11-14 19:20 版：趋势可读数 / 初诊≠MRD / 已见补流式 / 感染筛查折叠 ----------
it('趋势图必须能读数：有 Y 轴刻度 + 每个点标数值，且数值顺序与 X 轴一致（左旧右新）', () => {
  const card = buildCard({ reports: makeTrendReports(), mask: true, today: TODAY })
  const svgs = [...card.html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0])
  assert.ok(svgs.length > 0, '应有趋势图')
  for (const [i, svg] of svgs.entries()) {
    const ticks = [...svg.matchAll(/text-anchor="end">([^<]*)</g)].map((m) => m[1])
    assert.ok(ticks.length >= 2, `第 ${i + 1} 张趋势图没有 Y 轴刻度（用户无法读数）`)
    const vals = [...svg.matchAll(/font-weight="600"[^>]*>([^<]*)</g)].map((m) => m[1])
    const dates = [...svg.matchAll(/font-size="7\.2"[^>]*>([^<]*)</g)].map((m) => m[1])
    assert.equal(vals.length, dates.length, `第 ${i + 1} 张图：数值标注数 != 日期数`)
    assert.ok(vals.length >= 2, `第 ${i + 1} 张图应标出每个点的数值`)
  }
  // 逐图核对：SVG 里日期的出现顺序必须等于 points 的顺序（左旧右新），不许图上图下相反
  const first = card.trendRows[0]
  const svg0 = svgs[0]
  const domDates = [...svg0.matchAll(/font-size="7\.2"[^>]*>([^<]*)</g)].map((m) => m[1])
  const wantDates = first.points.map((p) => String(p.measuredAt || '').slice(5))
  assert.deepEqual(domDates, wantDates, `日期顺序与数据不一致：图 ${domDates.join('→')} / 数据 ${wantDates.join('→')}`)
  const domVals = [...svg0.matchAll(/font-weight="600"[^>]*>([^<]*)</g)].map((m) => m[1])
  assert.deepEqual(domVals, first.points.map((p) => String(p.value)), '数值标注必须与数据点一一对应（左旧右新）')
})

it('初诊流式的「异常细胞占有核细胞比例」不得写成 MRD；只有更晚的复查才标 MRD', () => {
  const base = {
    id: 'flow1', reportDate: '2026-07-15', kind: 'pathology', reportType: '流式免疫分型',
    rows: [{ name: '异常细胞占有核细胞比例', value: '85.76', unit: '%', measuredAt: '2026-07-15', code: 'FCM_MRD_PCT' }],
  }
  const c1 = buildCard({ reports: [base], today: TODAY })
  const t1 = c1.safetyBaseline.geneTags.find((g) => /异常细胞/.test(g.name))
  assert.ok(t1, '初诊流式必须进第 1 页标签区')
  assert.equal(t1.label, '初诊异常细胞', `初诊流式不得简写成 MRD，实际「${t1.label}」`)
  assert.equal(t1.unit, '%')
  assert.ok(/初诊异常细胞<\/b>\s*85\.76%/.test(c1.html), '卡面必须写「初诊异常细胞 85.76%」（带百分号）')
  assert.ok(!/<b>MRD<\/b>\s*85\.76/.test(c1.html), '卡面不得出现「MRD 85.76」')

  const follow = {
    ...base, id: 'flow2', reportDate: '2026-09-20',
    rows: [{ name: '异常细胞占有核细胞比例', value: '0.02', unit: '%', measuredAt: '2026-09-20', code: 'FCM_MRD_PCT' }],
  }
  const c2 = buildCard({ reports: [base, follow], today: TODAY })
  const tags = c2.safetyBaseline.geneTags.filter((g) => /异常细胞/.test(g.name)).sort((a, b) => String(a.date).localeCompare(String(b.date)))
  assert.equal(tags.length, 2, '两次流式应各占一个标签')
  assert.equal(tags[0].label, '初诊异常细胞', '最早那次仍是初诊基线')
  assert.equal(tags[1].label, 'MRD', '更晚那次才算 MRD 复查')
})

it('「已见」必须写「流式分型」：分型有、MRD 过期时不许让人以为流式没做过', () => {
  const reports = [{
    id: 'flow1', reportDate: '2026-07-15', kind: 'pathology', reportType: '流式免疫分型',
    text: '流式细胞术 免疫分型',
    rows: [{ name: '异常细胞占有核细胞比例', value: '85.76', unit: '%', measuredAt: '2026-07-15' }],
  }]
  const card = buildCard({ reports, today: TODAY })
  assert.ok(/白血病核心项：已见/.test(card.html), '必须有体检声明行')
  assert.ok(/流式分型/.test(card.html), '「已见」里必须出现「流式分型」')
  assert.ok(/待补[^；]*MRD/.test(card.html), '待补里要写「MRD 复查」——缺的是复查不是分型')
})

it('其他感染筛查：血型四联并成 1 行、传染病四项单列、常规阴性项折叠且项数守恒', () => {
  const mk = (name, value) => ({ name, value, measuredAt: '2026-07-17' })
  const rows = [
    mk('ABO血型鉴定', 'B型'), mk('ABO血型正定型', 'B型'), mk('ABO血型反定型', 'B型'), mk('ABO血型酶法鉴定', 'B型'),
    mk('Rh（D）血型鉴定', '阳性'),
    mk('乙肝表面抗原（HBsAg）', '阴性'), mk('丙型肝炎抗体（Anti-HCV）', '阴性'),
    mk('艾滋病病毒抗体（Anti-HIV）', '阴性'), mk('梅毒螺旋体特异性抗体测定（Anti-TP）', '阴性'),
    mk('肺炎支原体核酸检测', '阴性'), mk('呼吸道合胞病毒', '阴性'), mk('甲型流感病毒PCR', '阴性'),
    mk('甲型肝炎抗体lgM（A-HAV-IgM）', '阴性'), mk('戊型肝炎抗体lgG（A-HEV-IgG）', '阴性'),
  ]
  const card = buildCard({ reports: [{ id: 'm1', reportDate: '2026-07-17', kind: 'lab', reportType: 'ABO+RhD 血型', rows }], today: TODAY })
  const seg = block(card.html, '其他感染筛查', '<div class="page3">')
  assert.ok(seg, '第 2 页必须有「其他感染筛查」组')
  const names = [...seg.matchAll(/<td class="nm">([^<]*)</g)].map((m) => m[1].replace(/<[^>]*>/g, ''))
  // ① 血型：ABO 四种做法合成 1 行 + Rh 1 行
  assert.equal(names.filter((n) => /ABO血型/.test(n)).length, 1, `ABO 必须合并成 1 行，实际 ${names.filter((n) => /ABO/.test(n)).length} 行`)
  assert.equal(names.filter((n) => /^Rh/.test(n)).length, 1, 'Rh 单列 1 行')
  assert.ok(/8 项合成|4 项合成/.test(seg) || /B型/.test(seg), '合并行必须能看出结果 B型')
  // ② 传染病四项永远单列（术前/输血前必查）
  for (const k of ['HBsAg', 'Anti-HCV', 'Anti-HIV', 'Anti-TP']) {
    assert.ok(names.some((n) => n.includes(k)), `${k} 必须单列，不得进「均阴性」汇总`)
  }
  // ③ 常规阴性项折成汇总行，且写清「N项（日期）：均阴性」
  assert.ok(names.some((n) => /呼吸道病原筛查/.test(n)), '呼吸道病原 3 项应折成 1 行')
  assert.ok(/3项（07-17）：均阴性/.test(seg), '汇总行必须写「N项（日期）：均阴性」')
  assert.ok(names.some((n) => /甲\/戊肝抗体/.test(n)), '甲/戊肝 2 项应折成 1 行')
  // ④ 项数守恒：折叠前后总数相等（不丢信息）
  // 项数守恒：每行代表多少项 —— 汇总行看「N项」，ABO 合并行代表 4 项（正定型/反定型/鉴定/酶法鉴定），其余 1 项
  const covered = [...seg.matchAll(/<td class="nm">([^<]*)[\s\S]{0,220}?(\d+)项（/g)]
  const sumByRow = new Map(covered.map((m) => [m[1].replace(/<[^>]*>/g, ''), Number(m[2])]))
  const accounted = names.reduce((a, n) => {
    if (/^ABO血型/.test(n)) return a + 4                 // 四种做法合成 1 行
    if (sumByRow.has(n)) return a + sumByRow.get(n)      // 折叠汇总行
    return a + 1
  }, 0)
  assert.equal(accounted, rows.length, `折叠前后项数必须守恒：合计 ${accounted} != 原始 ${rows.length}（明细 ${names.join('/')}）`)
})

it('阳性结果不得被折进「均阴性」汇总：组内只要有一个不是阴性就整组逐项列出', () => {
  const mk = (name, value) => ({ name, value, measuredAt: '2026-07-17' })
  const rows = [
    mk('肺炎支原体核酸检测', '阴性'), mk('甲型流感病毒PCR', '阳性'), mk('呼吸道合胞病毒', '阴性'),
  ]
  const card = buildCard({ reports: [{ id: 'm2', reportDate: '2026-07-17', kind: 'lab', reportType: '呼吸道病原', rows }], today: TODAY })
  const seg = block(card.html, '其他感染筛查', '<div class="page3">')
  assert.ok(/甲型流感病毒PCR/.test(seg), '阳性项必须逐项列出（不能被汇总吞掉）')
  assert.ok(!/呼吸道病原筛查/.test(seg), '组内有阳性 → 不许折叠成「均阴性」')
})

// X 轴必须按真实日期比例（2026-11-14 用户口径）：隔 9 天必须比隔 1 天宽 9 倍。
// 反例：按数组序号等距时，07-17→07-18（1 天）与 07-18→07-27（9 天）画成一样宽，会误导病情变化速度。
it('趋势图 X 轴按真实日期比例（3/1/9 天 → 3:1:9），退化路径不产生 NaN', () => {
    const pts = [
      { measuredAt: '2026-07-14', value: '59.16', num: 59.16, unit: '10^9/L', flag: 'high' },
      { measuredAt: '2026-07-17', value: '79.67', num: 79.67, unit: '10^9/L', flag: 'high' },
      { measuredAt: '2026-07-18', value: '71.90', num: 71.90, unit: '10^9/L', flag: 'high' },
      { measuredAt: '2026-07-27', value: '3.27', num: 3.27, unit: '10^9/L', flag: 'low' },
    ]
    const svg = svgTrend(pts, { low: 3.5, high: 9.5 })
    const cx = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]))
    assert.equal(cx.length, 4, `应有 4 个数据点圆，实际 ${cx.length}`)
    const g = [cx[1] - cx[0], cx[2] - cx[1], cx[3] - cx[2]]
    const ratio = (a, b) => a / b
    assert.ok(Math.abs(ratio(g[0], g[1]) - 3) < 0.35, `07-14→07-17（3 天）应是 07-17→07-18（1 天）的 ~3 倍，实测 ${g[0].toFixed(1)} / ${g[1].toFixed(1)}`)
    assert.ok(Math.abs(ratio(g[2], g[1]) - 9) < 1.0, `07-18→07-27（9 天）应是 1 天的 ~9 倍，实测 ${g[2].toFixed(1)} / ${g[1].toFixed(1)}`)
    // 退化路径：全部同一天 → 等距，不许 NaN
    const same = svgTrend([{ measuredAt: '2026-07-14', value: '1', num: 1 }, { measuredAt: '2026-07-14', value: '2', num: 2 }])
    assert.ok(!/NaN/.test(same), '全同一天时 SVG 不许出现 NaN')
    // 无日期 → 等距回退
    const nodate = svgTrend([{ measuredAt: '', value: '1', num: 1 }, { measuredAt: '', value: '3', num: 3 }])
    assert.ok(!/NaN/.test(nodate), '无日期时 SVG 不许出现 NaN')
    // 隔 1 天贴很近时，日期标签必须两行错位或抽稀（不许叠成一坨）
    const tight = svgTrend([
      { measuredAt: '2026-07-17', value: '1', num: 1 },
      { measuredAt: '2026-07-18', value: '2', num: 2 },
      { measuredAt: '2026-08-31', value: '3', num: 3 },
    ])
    const labelYs = [...tight.matchAll(/<text x="[\d.]+" y="([\d.]+)" font-size="7\.2"/g)].map((m) => Number(m[1]))
    assert.ok(labelYs.length >= 2, `日期标签至少两个，实际 ${labelYs.length}`)
    assert.ok(new Set(labelYs.map((y) => y.toFixed(1))).size >= 2 || labelYs.length === 2, `贴很紧时日期标签应错位两行或抽稀，实测 y=${JSON.stringify(labelYs)}`)
})

// 打印预览弹窗内的 HTML 必须没有浮动打印条（2026-11-14 用户反馈：它压在表格上、与弹窗底部按钮重复）
it('embed=1 的打印 HTML 不含浮动打印条；默认输出仍保留（不许修一个坏一个）', () => {
  const plain = buildCard({ reports: [], embed: false })
  const embed = buildCard({ reports: [], embed: true })
  assert.ok(plain.html.includes('<div class="printbar">'), '默认 HTML 应保留浮动「打印 / 存 PDF」按钮')
  assert.ok(!embed.html.includes('<div class="printbar">'), 'embed=1 的 HTML 不许包含浮动打印条')
})

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `资料卡回归：${pass} 通过 / 0 失败` : `资料卡回归：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
