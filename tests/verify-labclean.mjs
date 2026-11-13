// 化验行字段清洗回归（守「看起来正常、实际是错值」这一类静默失败）
//
// 背景（2026-11-13 排雷实测，54 份真实报告 / 204 行）：
//   有 9 行的三列整体左移 —— `名称(含着真值) | 值=参考区间 | 参考区间=单位`。
//   这类行在旧卡面上「值」显示的是参考区间、参考区间显示的是单位，且因为 refRange='sec' 不是区间，
//   无法判定高低 → status=unknown → **既不进异常项、也不报错**，是最典型的静默失败。
//   还有 unit/refRange 串位、名称里嵌数值（`pCO2→pCO` 这类误剥）等。
//
// 断言原则（不贴实现细节，贴不变量）：
//   1. 幂等：清洗两次 == 清洗一次（有损规则最容易在这里第二次改坏数据）；
//   2. 干净行零改动：清洗层不许碰本来就对的字段（否则它本身就是新的污染源）；
//   3. 还原正确性：被左移的真值必须回到 value，区间回到 refRange，单位回到 unit —— 逐值核对；
//   4. 固有数字不剥：`CO2 / pCO2 / CD34+ / 白介素6 / P190型` 是项目名的一部分，剥掉就是造错名；
//   5. 串码防护：同名异轴项必须分 code（MCH≠Hb、血气 Hct≠血常规 HCT、尿白细胞≠血白细胞、尿糖≠血糖）；
//   6. 覆盖率不变量：快照里 ≥99% 的行必须拿到 code（code 是去重/趋势/危急值的唯一键）。
//
// 运行：node tests/verify-labclean.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeRow, cleanName, isUnitLike, isRange, extractNameValue, repairColumnShift } from '../lib/labClean.mjs'
import { classifyAnalyte } from '../lib/reportIntake.mjs'

const SNAP = JSON.parse(fs.readFileSync(new URL('./fixtures/card-snapshot-v3.json', import.meta.url), 'utf8'))
const ALL_ROWS = SNAP.reports.flatMap((r) => r.rows)

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

console.log(`化验行清洗回归（快照 ${SNAP.reports.length} 份 / ${ALL_ROWS.length} 行）\n`)

// ---------------- 1. 幂等 ----------------
it('幂等：清洗两次 == 清洗一次（全量，逐字段）', () => {
  const bad = []
  for (const row of ALL_ROWS) {
    const a = normalizeRow(row)
    const b = normalizeRow(a)
    for (const f of ['name', 'value', 'unit', 'refRange']) {
      if (String(a[f] ?? '') !== String(b[f] ?? '')) bad.push(`${row.name}.${f}: ${a[f]} → ${b[f]}`)
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `有 ${bad.length} 行二次清洗又被改动：${bad.slice(0, 5).join('；')}`)
})

// ---------------- 2. 干净行零改动 ----------------
it('干净行零改动：本来就对的字段一个不动', () => {
  const cleanRows = [
    { name: '白细胞计数', value: '6.83', unit: '10^9/L', refRange: '3.5-9.5', num: 6.83 },
    { name: '血红蛋白', value: '113', unit: 'g/L', refRange: '130-175', num: 113 },
    { name: '血小板', value: '321', unit: '10^9/L', refRange: '125-350', num: 321 },
    { name: 'C反应蛋白', value: '1.2', unit: 'mg/L', refRange: '0-8', num: 1.2 },
    { name: '骨髓原始细胞', value: '85.76', unit: '%', refRange: '', num: 85.76 },
  ]
  for (const row of cleanRows) {
    const out = normalizeRow(row)
    assert.deepEqual(out.repaired, [], `干净行被误改：${row.name} → repaired=${out.repaired.join('+')}`)
    assert.equal(out.name, row.name)
    assert.equal(out.value, row.value)
    assert.equal(out.unit, row.unit)
    assert.equal(out.refRange, row.refRange)
  }
})

// ---------------- 3. 列左移还原（真实脏行的真值必须回到 value） ----------------
it('列左移还原：真实 9 行的真值/区间/单位三列各归其位', () => {
  // 期望值来自原图原文（人工核对）：名称里被吞的那个数就是实测值
  const expected = [
    ['凝血酶原时间（P12.2个T）', '12.2', '9.8-12.1', 'sec'],
    ['中性粒细胞百分87.2个比', '87.2', '40-75', '%'],
    ['中性粒细胞计数12.59个', '12.59', '1.8-6.3', '10~9/L'],
    ['活化部分凝血活35.7个酶时间（APTT）', '35.7', '25-31.3', 'seC'],
    ['D-二聚体（D-Di10.18个mer）', '10.18', '0-0.55', 'mg/L'],
    ['中性粒细胞百分15.8', '15.8', '40-75', '%'],
  ]
  for (const [name, value, refRange, unit] of expected) {
    const raw = ALL_ROWS.find((r) => r.name === name)
    assert.ok(raw, `快照里找不到脏行「${name}」（快照是否已重新生成？）`)
    const out = normalizeRow(raw)
    assert.equal(out.value, value, `${name} 的值应为 ${value}，实际 ${out.value}`)
    assert.equal(out.refRange, refRange, `${name} 的参考区间应为 ${refRange}，实际 ${out.refRange}`)
    assert.equal(out.unit, unit, `${name} 的单位应为 ${unit}，实际 ${out.unit}`)
    assert.ok(out.repaired.includes('column-shift'), `${name} 应标记 column-shift 留痕`)
  }
})

it('列左移还原后可判定高低（旧行为是 status=unknown 静默漏判）', () => {
  const cases = [
    ['中性粒细胞百分87.2个比', 'high'],
    ['中性粒细胞计数12.59个', 'high'],
    ['D-二聚体（D-Di10.18个mer）', 'high'],
    ['活化部分凝血活35.7个酶时间（APTT）', 'high'],
  ]
  for (const [name, want] of cases) {
    const out = normalizeRow(ALL_ROWS.find((r) => r.name === name))
    const [lo, hi] = String(out.refRange).split('-').map(Number)
    const num = Number(out.value)
    const got = num > hi ? 'high' : num < lo ? 'low' : 'normal'
    assert.equal(got, want, `${name}：${num} 对 [${lo},${hi}] 应为 ${want}，实际 ${got}`)
  }
})

it('单位/区间串位纠正：unit 里存了区间 → 换回 refRange', () => {
  const out = normalizeRow({ name: '纤维蛋白原（FBG）', value: '3.2', unit: '1.8-3.5', refRange: '', num: 3.2 })
  assert.equal(out.unit, '', `单位应为空，实际 ${out.unit}`)
  assert.equal(out.refRange, '1.8-3.5', `参考区间应为 1.8-3.5，实际 ${out.refRange}`)
})

// ---------------- 4. 固有数字不剥 ----------------
it('固有数字不剥：CO2 / pCO2 / CD34+ / 白介素6 / P190型 全部保持原样', () => {
  for (const n of ['二氧化碳（CO2）', 'pCO2', 'CD34+细胞占有核细胞比例', '白介素6', 'BCR::ABL1（P190型）', 'HCO3-', 'BEecfC']) {
    assert.equal(cleanName(n), n, `「${n}」被改成了「${cleanName(n)}」（固有数字/编号不得剥离）`)
  }
})

it('value 尾巴噪声：22.00小 → 22.00（且不改 <0.01 这类真值）', () => {
  assert.equal(normalizeRow({ name: 'pCO2', value: '22.00小', num: 22 }).value, '22.00')
  assert.equal(normalizeRow({ name: '某项目', value: '<0.01' }).value, '<0.01')
})

it('名称噪声：圈号 / 尾部单字母 / 定性结果 / OCR 截断', () => {
  assert.equal(cleanName('二氧化碳（CO2）⑦'), '二氧化碳（CO2）')
  assert.equal(cleanName('血小板压积C'), '血小板压积')
  assert.equal(cleanName('丙型肝炎抗体（A阴性（-）nti-HCV）'), '丙型肝炎抗体（Anti-HCV）')
  assert.equal(cleanName('中性粒细胞百分15.8'), '中性粒细胞百分比')
})

it('脏名要标出来，不许当正常项：nameDirty 只命中真脏行', () => {
  const dirty = ALL_ROWS.map(normalizeRow).filter((r) => r.nameDirty)
  assert.equal(dirty.length, 1, `nameDirty 应只命中 1 行（NT-proBNP 那行），实际 ${dirty.length}`)
  assert.ok(/急性心衰/.test(dirty[0].name), `脏名应含「急性心衰」片段，实际 ${dirty[0].name}`)
})

// ---------------- 5. 串码防护（同名异轴项） ----------------
it('串码防护：MCH ≠ Hb、血气 Hct ≠ 血常规 HCT、尿白细胞 ≠ 血白细胞、尿糖 ≠ 血糖', () => {
  const code = (n) => classifyAnalyte(n).code
  assert.equal(code('红细胞平均血红蛋白含量'), 'MCH')
  assert.notEqual(code('红细胞平均血红蛋白含量'), 'Hb')
  assert.equal(code('血红蛋白'), 'Hb')
  assert.equal(code('Hct'), 'BG_HCT')
  assert.equal(code('红细胞比积'), 'HCT')
  assert.notEqual(code('Hct'), code('红细胞比积'))
  assert.equal(code('白细胞（LEU）'), 'U_LEU')
  assert.notEqual(code('白细胞（LEU）'), 'WBC')
  assert.equal(code('葡萄糖（glu）'), 'U_GLU')
  assert.equal(code('葡萄糖（GLU）'), 'GLU')
  assert.notEqual(code('葡萄糖（glu）'), code('葡萄糖（GLU）'))
  assert.equal(code('酮体（KET）'), 'U_KET')
})

it('名称归一：同一项的不同写法归到同一 code', () => {
  assert.equal(classifyAnalyte('白细胞计数').code, classifyAnalyte('白细胞').code)
  assert.equal(classifyAnalyte('中性粒细胞百分比').code, 'NEUT_PCT')
  assert.equal(classifyAnalyte('中性粒细胞计数').code, 'NEUT_ABS')
  assert.equal(classifyAnalyte('凝血酶原时间（PT）').code, 'PT')
  assert.equal(classifyAnalyte('纤维蛋白原（FBG）').code, 'FIB')
  assert.equal(classifyAnalyte('国际标准化比值（INR）').code, 'INR')
  assert.equal(classifyAnalyte('降钙素原（PCT）').code, 'PCT')
  assert.notEqual(classifyAnalyte('血小板压积').code, 'PCT') // 血小板压积不得占用降钙素原的 code
})

// ---------------- 6. 覆盖率不变量 ----------------
it('code 覆盖率 ≥ 99%（快照全量）：code 是去重/趋势/危急值的唯一键', () => {
  const noCode = [...new Set(ALL_ROWS.map(normalizeRow).filter((r) => !classifyAnalyte(r.name).code).map((r) => r.name))]
  const ratio = 1 - noCode.length / ALL_ROWS.length
  assert.ok(ratio >= 0.99, `覆盖率 ${(ratio * 100).toFixed(1)}%（应 ≥99%），未归类：${noCode.join('、')}`)
})

it('无 code 的残留行必须是「已标脏名」的行（不许悄悄漏进 OTHER 组当正常项）', () => {
  const silent = ALL_ROWS.map(normalizeRow)
    .filter((r) => !classifyAnalyte(r.name).code && !r.nameDirty)
    .map((r) => r.name)
  assert.deepEqual([...new Set(silent)], [], `这些行既无 code 又没标脏名（会静默进「其他项」）：${[...new Set(silent)].join('、')}`)
})

// ---------------- 7. 纯函数边界（不抛错、不乱判） ----------------
it('边界：空行/纯白字段不抛错，且不产生虚假修复', () => {
  assert.deepEqual(normalizeRow({}).repaired, [])
  assert.deepEqual(normalizeRow({ name: '', value: '', unit: '', refRange: '' }).repaired, [])
  assert.equal(isRange('10~9/L'), false)
  assert.equal(isUnitLike('10~9/L'), true, '`10~9/L` 是单位，不是区间（否则白细胞单位永远判不成）')
  assert.equal(isUnitLike('1.8-3.5'), false)
  assert.equal(extractNameValue('二氧化碳（CO2）'), '2')
  assert.equal(repairColumnShift({ name: 'pCO2', value: '1-2', refRange: 'mmHg' }), null, '`pCO2` 的 2 是项目名，不得当作被吞的真值')
})

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `化验行清洗：${pass} 通过 / 0 失败` : `化验行清洗：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
