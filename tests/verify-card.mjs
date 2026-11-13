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
import { buildCard } from '../lib/intakeCard.js'
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
  const seg = block(card.html, '④ 全部指标', '⑤ 材料清单')
  assert.ok(seg, '找不到「④ 全部指标」段')
  const dataRows = trCount(seg) - 2 // 两栏并排，各 1 行表头
  assert.ok(dataRows >= card.counts.latest, `全部指标段渲染 ${dataRows} 行 < 应有的 ${card.counts.latest} 行`)
  assert.notEqual(dataRows, card.counts.groups, '渲染行数退化成了"组数"（历史 bug 回归）')
})

// ---------- 2. 第 1 页聚焦性（v3 核心：只看最新状态，不摊历史） ----------
it('第 1 页只放「最新状态」的异常项：3 份历史 × 3 项异常 → 第 1 页只有 3 行（不是 9 行）', () => {
  const card = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  const seg = block(card.html, '② 核心异常项', '③ 家属三问')
  const rows = trCount(seg) - 1
  assert.equal(card.counts.p0, 3, `P0 应为 3 项（血红蛋白/红细胞/红细胞压积各一项最新），实际 ${card.counts.p0}`)
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
  const seg = block(card.html, '② 核心异常项', '③ 家属三问')
  assert.ok(!/酮体/.test(seg.replace(/另有[^\n]*非核心异常[^\n]*/g, '')), 'P1 项不得出现在第 1 页表格里')
  assert.ok(/另有 \d+ 项非核心异常/.test(seg), '第 1 页必须有 P1 折叠摘要行')
})

// ---------- 3. 危急值（置顶 + 底纹，不允许只有绿标造成安全错觉） ----------
it('危急值：命中阈值 → 置顶 + 底纹 + 「危急」标记（且低值不只是一片绿）', () => {
  const reports = makeReports()
  // WBC 0.6 < 1.0（危急），但参考区间判为 low —— 旧版式只会画成绿色
  reports[0].rows.push({ name: '白细胞', value: '0.6', num: 0.6, unit: '10^9/L', refRange: '3.5-9.5', measuredAt: '2026-09-20', status: 'low', flag: 'low' })
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.equal(card.counts.critical, 1, `危急项应为 1，实际 ${card.counts.critical}`)
  const seg = block(card.html, '② 核心异常项', '③ 家属三问')
  assert.ok(/class="crit"/.test(seg), '危急行必须有底纹样式类 crit')
  assert.ok(/危急/.test(seg), '危急行必须有「危急」标记')
  const firstRow = seg.slice(seg.indexOf('<tbody>') + 7)
  assert.ok(/白细胞/.test(firstRow.slice(0, 220)), '危急项必须排在 P0 表第一行')
})

// ---------- 4. 缺项与时效（临床安全：不能让医生把 100 天前的数当本周的） ----------
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
  const seg = block(stale.html, '② 核心异常项', '③ 家属三问')
  assert.ok(/⚠️ 最近一次有指标的化验/.test(seg), '第 1 页必须有时效警示')
  assert.ok(seg.includes(stale.counts.lastLabDate), '时效警示必须写出具体日期')
  const fresh = buildCard({ reports: makeReports(), mask: true, today: TODAY })
  assert.ok(!/⚠️ 最近一次有指标的化验/.test(fresh.html), '新鲜数据不得误报时效问题')
})

// ---------- 5. 材料清单与原件 ----------
it('材料清单：0 行报告标「未结构化（仅存原件）」，绝不许标「0 项」', () => {
  const reports = makeReports()
  reports.push({ id: 'rep_img', reportDate: '2026-09-25', kind: 'imaging', hospital: '（脱敏）', rows: [], source: 'image', fileBlobId: 'f_test1' })
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.equal(card.counts.material, 4)
  assert.equal(card.counts.unstructured, 1)
  const seg = block(card.html, '⑤ 材料清单', '⑥ 关键趋势')
  assert.ok(seg.includes('未结构化（仅存原件）'), '影像报告必须标「未结构化（仅存原件）」')
  assert.ok(!/>\s*0 项\s*</.test(seg), '不得出现「0 项」（会被读成解析失败丢数据）')
})

it('材料清单按「日期 + 医院」聚合：同日同院的多份压成 1 组（防第 2 页被材料清单撑爆）', () => {
  const reports = makeReports() // 3 份不同日期
  reports.push({ ...makeReports()[0], id: 'rep_dup', rows: makeReports()[0].rows }) // 与第一份同日同院
  const card = buildCard({ reports, mask: true, today: TODAY })
  assert.equal(card.counts.material, 4)
  assert.equal(card.counts.materialGroups, 3, `同日同院应合并为 1 组，实际 ${card.counts.materialGroups} 组`)
  const seg = block(card.html, '⑤ 材料清单', '⑥ 关键趋势')
  assert.ok(new RegExp(`聚合为 3 组`).test(seg), '材料清单标题必须写明聚合组数')
})

it('材料清单：0 行报告不得出现「0 项」（聚合行用「仅原件」+ 图例说清）', () => {
  const reports = makeReports()
  reports.push({ id: 'rep_img2', reportDate: '2026-09-25', kind: 'imaging', hospital: '（脱敏）', rows: [], source: 'image', fileBlobId: 'f_x' })
  const card = buildCard({ reports, mask: true, today: TODAY })
  const seg = block(card.html, '⑤ 材料清单', '⑥ 关键趋势')
  assert.ok(!/\d 份 · 0 项/.test(seg), '聚合行不得出现「0 项」')
  assert.ok(seg.includes('仅原件'), '0 行组应显示「仅原件」')
  assert.ok(/未结构化（仅存原件）/.test(seg), '图例必须写明「未结构化（仅存原件）」的完整含义')
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
it('趋势截断：10 个可比较项目 → trends ≤ 8 且 trendsAll == 10，关键项必须留', () => {
  const card = buildCard({ reports: makeTrendReports(), mask: true, today: TODAY })
  assert.equal(card.counts.trendsAll, 10, `trendsAll 应为 10（可比较项目总数），实际 ${card.counts.trendsAll}`)
  assert.ok(card.counts.trends <= 8, `趋势段上限 8 项，实际 ${card.counts.trends}`)
  const seg = block(card.html, '⑥ 关键趋势')
  const keep = ['骨髓原始', 'MRD', '白细胞', '中性粒', '血红蛋白', '血小板']
  const missing = keep.filter((k) => !seg.includes(k))
  assert.deepEqual(missing, [], `趋势段缺关键项：${missing.join('、')}（关键项应优先于边缘项）`)
})

it('趋势段不得谎报：段标题里的项数 == counts.trends', () => {
  const card = buildCard({ reports: makeTrendReports(), mask: true, today: TODAY })
  const head = block(card.html, '⑥ 关键趋势').slice(0, 300)
  const m = head.match(/关键趋势[\s\S]*?共 (\d+) 项/)
  assert.ok(m, '趋势段标题应带「共 N 项」')
  assert.equal(Number(m[1]), card.counts.trends, `标题写 ${m[1]} 项，实际渲染 ${card.counts.trends} 项`)
})

it('跨院参考区间不同：必须给警示，且**不得**画单一虚假绿带', () => {
  const reports = makeTrendReports()
  // 同项两次、参考区间不同（跨院）
  reports[0].rows[0].refRange = '3.5-9.5'
  reports[1].rows[0].refRange = '4.0-10.0'
  const card = buildCard({ reports, mask: true, today: TODAY })
  const seg = block(card.html, '⑥ 关键趋势')
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
  assert.ok(bytes <= 40 * 1024, `HTML 已 ${(bytes / 1024).toFixed(1)} KB（上限 40 KB）`)
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

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `资料卡回归：${pass} 通过 / 0 失败` : `资料卡回归：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
