// 白血病核心资料体检回归（MICM 分型 + 近期血常规缺失探测）
//
// 为什么要断言（2026-11-14 用户口径）：
//   体检条要给家属「该补传什么」的准确清单。判错两个方向都危险 ——
//   谎报「已做」会让医生以为资料齐了；漏报清单写成一片「未检出」会让人白跑。
// 三条硬口径：
//   1. **不信 `kind`**：实测 3 份「融合基因」报告 `kind=imaging`，按 kind 判会误报缺；
//   2. **正文可作证据**：染色体核型报告 `rows=[]`，但正文标题就是「染色体核型分析报告单」；
//   3. **区分「没做」与「过期/缺项」**：MRD 做过但 122 天前 → 待补项应写「MRD 复查」，不是「未检出 MRD」。
//
// 运行：node tests/verify-checklist.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildChecklist, RECENT_CBC_DAYS, RECENT_MRD_DAYS } from '../lib/leukemiaChecklist.mjs'

const SNAP = JSON.parse(fs.readFileSync(new URL('./fixtures/card-snapshot-v3.json', import.meta.url), 'utf8'))
const TODAY = new Date('2026-11-14T09:00:00')

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

const lab = (date, rows, extra = {}) => ({ reportDate: date, kind: 'lab', rows, ...extra })
const patho = (date, type, text, rows = []) => ({ reportDate: date, kind: 'pathology', reportType: type, text, rows })

/** 一套「齐全」的报告：MICM 四项 + 30 天内血常规（WBC/ANC/Hb/PLT 齐）。 */
function fullSet() {
  return [
    patho('2026-11-10', '骨髓形态学', '骨髓细胞学检查报告单：增生活跃'),
    patho('2026-11-10', '流式免疫分型', '流式细胞检测：异常细胞 2.1%', [
      { name: 'MRD（流式）', value: '2.1', unit: '%', code: 'MRD', measuredAt: '2026-11-10' },
    ]),
    patho('2026-11-10', '染色体核型', '染色体核型分析报告单：46,XX[20]'),
    lab('2026-11-10', [{ name: '融合基因 BCR::ABL1（P190型）', value: '阴性', code: 'BCR_ABL1', measuredAt: '2026-11-10' }], { reportType: '融合基因' }),
    lab('2026-11-11', [
      { name: '白细胞', value: '4.1', unit: '10^9/L', code: 'WBC', measuredAt: '2026-11-11' },
      { name: '中性粒细胞绝对值', value: '2.2', unit: '10^9/L', code: 'NEUT_ABS', measuredAt: '2026-11-11' },
      { name: '血红蛋白', value: '112', unit: 'g/L', code: 'Hb', measuredAt: '2026-11-11' },
      { name: '血小板', value: '156', unit: '10^9/L', code: 'PLT', measuredAt: '2026-11-11' },
    ], { reportType: '血常规' }),
  ]
}

console.log(`白血病核心资料体检（快照 ${SNAP.reports.length} 份）\n`)

it('齐全：MICM 四项 + 30 天内血常规四项齐 → 无待补项，summary 说「均已检出」', () => {
  const c = buildChecklist(fullSet(), TODAY)
  assert.deepEqual(c.missing, [], `不应有待补项，实际 ${JSON.stringify(c.missing)}`)
  assert.equal(c.micmOk, 4, `MICM 应为 4/4，实际 ${c.micmOk}`)
  assert.equal(c.micmTotal, 4)
  assert.ok(/均已检出/.test(c.summary), `summary 应说明齐全，实际「${c.summary}」`)
})

it('不信 kind：融合基因报告被误标 imaging 仍必须检出', () => {
  const set = fullSet()
  const i = set.findIndex((r) => r.reportType === '融合基因')
  set[i] = { ...set[i], kind: 'imaging' }   // 实测真实库里就是这种错标
  set[i].reportDate = '2026-11-10'
  const c = buildChecklist(set, TODAY)
  const fusion = c.items.find((x) => x.key === 'fusion')
  assert.ok(fusion.ok, `kind=imaging 的融合基因报告必须仍算检出，detail=${fusion.detail}`)
})

it('正文可作证据：染色体核型 rows=[] 但正文有标题 → 检出', () => {
  const c = buildChecklist([patho('2026-07-15', '染色体核型', '染色体核型分析报告单 CG-R001.11 姓名：某某 46,XX')], TODAY)
  assert.ok(c.items.find((x) => x.key === 'karyotype').ok, '正文里有「染色体核型分析报告单」就应该算有')
})

it('缺项要报缺：没有骨髓形态学 → 待补里必须有「骨髓形态学报告」', () => {
  const set = fullSet().filter((r) => r.reportType !== '骨髓形态学')
  const c = buildChecklist(set, TODAY)
  assert.ok(c.missing.includes('骨髓形态学报告'), `待补项应含骨髓形态学，实际 ${JSON.stringify(c.missing)}`)
  assert.equal(c.micmOk, 3)
})

it('区分「没做」与「过期」：MRD 做过但超 90 天 → 待补写「MRD 复查」并说明天数', () => {
  const set = fullSet()
  const i = set.findIndex((r) => r.reportType === '流式免疫分型')
  set[i] = { ...set[i], reportDate: '2026-07-15', rows: [{ name: 'MRD（流式）', value: '85.76', unit: '%', code: 'MRD', measuredAt: '2026-07-15' }] }
  const c = buildChecklist(set, TODAY)
  const flow = c.items.find((x) => x.key === 'flow-mrd')
  assert.ok(!flow.ok, 'MRD 过期时该项应为缺')
  assert.ok(c.missing.includes('MRD 复查'), `待补项应写「MRD 复查」而不是「未检出流式」，实际 ${JSON.stringify(c.missing)}`)
  // 2026-11-14 只读体检建议：原来写 `RegExp(`${RECENT_MRD_DAYS}|122`)` 属「或」兜底 —— 两种都能过，
  // 等于两个都可能错。改成**精确断言算出来的天数**（TODAY 与 MRD 日期都是测试自己定的，天数唯一确定）。
  const days = Math.round((TODAY - new Date('2026-07-15T00:00:00')) / 86400000)
  assert.equal(days, 122, '测试自身的天数算错了')
  assert.ok(flow.detail.includes(`${days} 天前`), `detail 必须写准确的天数「${days} 天前」，实际「${flow.detail}」`)
  assert.ok(flow.detail.includes(`超 ${RECENT_MRD_DAYS} 天`), `detail 必须说明阈值 ${RECENT_MRD_DAYS} 天，实际「${flow.detail}」`)
})

it('近期血常规：30 天外的血常规不算「近期」，且缺项要指名（ANC 缺 → 提示 ANC）', () => {
  const stale = buildChecklist([lab('2026-10-01', [
    { name: '白细胞', value: '4.1', code: 'WBC' },
    { name: '中性粒细胞绝对值', value: '2.2', code: 'NEUT_ABS' },
    { name: '血红蛋白', value: '112', code: 'Hb' },
    { name: '血小板', value: '156', code: 'PLT' },
  ])], TODAY)
  const cbc = stale.items.find((x) => x.key === 'recent-cbc')
  assert.ok(!cbc.ok, `${RECENT_CBC_DAYS} 天外的血常规不能算近期（detail=${cbc.detail}）`)

  const partial = buildChecklist([lab('2026-11-11', [
    { name: '白细胞', value: '4.1', code: 'WBC' },
    { name: '血红蛋白', value: '112', code: 'Hb' },
    { name: '血小板', value: '156', code: 'PLT' },
  ])], TODAY)
  const c2 = partial.items.find((x) => x.key === 'recent-cbc')
  assert.ok(!c2.ok, '缺 ANC 时不能算齐')
  assert.ok(/中性粒细胞绝对值/.test(c2.detail), `应指名缺 ANC，实际「${c2.detail}」`)
})

it('空输入不抛错：0 份报告 → 五项全缺，summary 可读', () => {
  const c = buildChecklist([], TODAY)
  assert.equal(c.items.length, 5)
  assert.ok(c.items.every((x) => !x.ok))
  assert.equal(c.missing.length, 5)
  assert.ok(/待补/.test(c.summary))
  assert.ok(/待补/.test(c.cardLine) || /待补/.test(c.summary))
})

it('真实快照：MICM 至少检出融合基因 / 染色体核型，骨髓形态学必须报缺', () => {
  const c = buildChecklist(SNAP.reports, TODAY)
  const byKey = Object.fromEntries(c.items.map((x) => [x.key, x]))
  assert.ok(byKey.fusion.ok, `快照里应有融合基因，detail=${byKey.fusion.detail}`)
  assert.ok(byKey.karyotype.ok, `快照里应有染色体核型，detail=${byKey.karyotype.detail}`)
  assert.ok(!byKey['marrow-morph'].ok, '快照里没有骨髓形态学报告，必须报缺')
  assert.ok(c.cardLine.length <= 90, `卡面那行小字必须能放进 1 行（限制 90 字），实际 ${c.cardLine.length} 字`)
})

// 中枢神经系统（CNS）资料核对提示（2026-11-14 用户口径）
// 触发三条任一；已见腰穿/脑脊液报告则**不再提示**；且绝不能进 missing（它不是"缺项"，是提醒）。
it('CNS 提示：Ph+ / 高 WBC / 头颅影像任一触发，已见腰穿则不再提示', () => {
  const base = [{ id: 'r1', reportDate: '2026-11-01', kind: 'lab', reportType: '血常规', rows: [{ code: 'WBC', name: '白细胞计数', value: '3.2', num: 3.2 }], text: '' }]
  // ① 都不满足 → 无提示
  const none = buildChecklist(base, new Date('2026-11-14'))
  assert.equal(none.hints.length, 0, `不该提示，实际 ${JSON.stringify(none.hints)}`)
  // ② 高 WBC 触发
  const high = buildChecklist([{ ...base[0], rows: [{ code: 'WBC', name: '白细胞计数', value: '79.67', num: 79.67 }] }], new Date('2026-11-14'))
  assert.equal(high.hints.length, 1, 'WBC 79.67 ≥50 应触发 CNS 提示')
  // ③ Ph+ 触发
  const ph = buildChecklist([{ ...base[0], kind: 'pathology', reportType: '融合基因', rows: [{ code: 'BCR_ABL1', name: 'BCR::ABL1', value: '阳性', num: null, status: 'positive' }], text: '' }], new Date('2026-11-14'))
  assert.equal(ph.hints.length, 1, 'BCR-ABL1 阳性应触发 CNS 提示')
  // ④ 头颅影像触发
  const img = buildChecklist([{ ...base[0], kind: 'imaging', reportType: '磁共振-头颈', text: '脑实质未见明显异常' }], new Date('2026-11-14'))
  assert.equal(img.hints.length, 1, '头颅影像应触发 CNS 提示')
  // ⑤ 已见腰穿/脑脊液 → 抑制提示
  const withCsf = buildChecklist([
    { ...base[0], kind: 'pathology', reportType: '融合基因', rows: [{ code: 'BCR_ABL1', value: '阳性', status: 'positive' }], text: '' },
    { id: 'r9', reportDate: '2026-11-10', kind: 'pathology', reportType: '脑脊液检查', text: '脑脊液常规：未见异常' },
  ], new Date('2026-11-14'))
  assert.equal(withCsf.hints.length, 0, '已检测到腰穿/脑脊液报告就不该再提示')
  // ⑥ 提示不许进 missing（否则会拉低体检完成度）
  assert.ok(!high.missing.some((m) => /中枢|腰穿|脑脊液/.test(m)), 'CNS 提示不得进 missing 列表')
})

console.log(`\n${'='.repeat(46)}`)
console.log(`白血病核心资料体检：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { console.log(`失败：${fails.join('、')}`); process.exit(1) }
