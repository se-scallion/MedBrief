// 报告导入层单元测试（纯函数，零网络零磁盘）
// 运行：node tests/verify-intake.mjs

import assert from 'node:assert/strict'
import {
  sha256Bytes, dhash64, hamming64, findDuplicate, NEAR_DUP_THRESHOLD,
  parseLabRows, classifyAnalyte, buildReportFingerprint, groupForDoctorCard, summarizeForCard,
  normalizeUnit, detectCbcCode, CBC_ORDER,
} from '../lib/reportIntake.mjs'

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`) } catch (e) { fails.push(name); console.error(`FAIL  ${name} → ${e.message}`) }
}

// ---------- 化验行解析 ----------
it('解析：常规行「项目 值 区间 单位」', () => {
  const rows = parseLabRows('白细胞 6.83 3.5-9.5 10^9/L')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '白细胞')
  assert.equal(rows[0].num, 6.83)
  assert.equal(rows[0].refRange, '3.5-9.5')
  assert.equal(rows[0].unit, '10^9/L')
  assert.equal(rows[0].status, 'normal')
})

it('解析：箭头 ↑ 判为偏高（不依赖参考区间）', () => {
  const rows = parseLabRows('血红蛋白 113↑ 130-175 g/L')
  assert.equal(rows[0].flag, 'high')
  assert.equal(rows[0].status, 'abnormal')
})

it('解析：OCR 双连字符区间 126--350 不得判成异常（真实脏数据形态）', () => {
  const rows = parseLabRows('血小板 238 126--350 10^9/L')
  assert.equal(rows[0].refRange, '126-350')
  assert.equal(rows[0].status, 'normal')
})

it('解析：低于下限判为 low', () => {
  const rows = parseLabRows('血红蛋白 63 130-175 g/L')
  assert.equal(rows[0].status, 'low')
  assert.equal(rows[0].flag, 'low')
})

it('解析：定性结果（阴性/阳性）', () => {
  const rows = parseLabRows('尿蛋白 阳性')
  assert.equal(rows[0].value, '阳性')
  assert.equal(rows[0].status, 'abnormal')
})

it('解析：认不出的行不瞎填（只出能确定的）', () => {
  const rows = parseLabRows('报告编号：2026-11-12-001\n检验科 张医生')
  assert.equal(rows.length, 0)
})

it('解析：多行混合只提取化验行', () => {
  const text = `血常规\n白细胞 6.83 3.5-9.5 10^9/L\n血红蛋白 113↓ 130-175 g/L\n血小板 79 125-350 10^9/L\n本报告仅供临床参考`
  const rows = parseLabRows(text)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.name), ['白细胞', '血红蛋白', '血小板'])
})

// ---------- 查重 ----------
it('dhash64 输出 64 bit', () => {
  const gray = Array.from({ length: 72 }, (_, i) => (i % 9) * 10)
  const h = dhash64(gray)
  assert.equal(h.length, 64)
})

it('近重复：轻微差异仍命中，完全不同不命中', () => {
  const a = dhash64(Array.from({ length: 72 }, (_, i) => (i % 9) * 10))
  const b = dhash64(Array.from({ length: 72 }, (_, i) => (i % 9) * 10 + 1))
  const c = dhash64(Array.from({ length: 72 }, (_, i) => ((72 - i) % 9) * 10))
  assert.ok(hamming64(a, b) <= NEAR_DUP_THRESHOLD, `a-b 距离 ${hamming64(a, b)}`)
  assert.ok(hamming64(a, c) > NEAR_DUP_THRESHOLD, `a-c 距离 ${hamming64(a, c)}`)
})

it('查重：精确优先，其次近重复', () => {
  const existing = [{ id: 'r1', sha256: 'aaa', dhash: '0'.repeat(64) }]
  assert.equal(findDuplicate({ sha256: 'aaa', dhash: '1'.repeat(64) }, existing).kind, 'exact')
  assert.equal(findDuplicate({ sha256: 'bbb', dhash: '0'.repeat(63) + '1' }, existing).kind, 'near')
  assert.equal(findDuplicate({ sha256: 'bbb', dhash: '1'.repeat(64) }, existing).dup, false)
})

it('报告指纹：同一份单子行序打乱仍同指纹，改一个值即不同', () => {
  const rows1 = [{ name: '白细胞', value: '6.83' }, { name: '血小板', value: '238' }]
  const rows2 = [{ name: '血小板', value: '238' }, { name: '白细胞', value: '6.83' }]
  const rows3 = [{ name: '白细胞', value: '6.84' }, { name: '血小板', value: '238' }]
  const meta = { reportDate: '2026-09-20', hospital: '北京朝阳医院', kind: 'lab' }
  assert.equal(buildReportFingerprint(rows1, meta), buildReportFingerprint(rows2, meta))
  assert.notEqual(buildReportFingerprint(rows1, meta), buildReportFingerprint(rows3, meta))
})

// ---------- 归类与资料卡 ----------
it('归类：中文项目名 → 标准 code 与分组', () => {
  assert.deepEqual(classifyAnalyte('中性粒细胞绝对值'), { code: 'NEUT_ABS', cat: 'CBC' })
  assert.equal(classifyAnalyte('乳酸脱氢酶').cat, 'CHEM')
  assert.equal(classifyAnalyte('铁蛋白').cat, 'IRON')
  assert.equal(classifyAnalyte('骨髓原始细胞').cat, 'DISEASE')
  assert.equal(classifyAnalyte('某个没见过的项').cat, 'OTHER')
})

it('资料卡：疾病特异组排第一，组内异常项排前面', () => {
  const rows = [
    { name: '白细胞', value: '6.83', num: 6.83, status: 'normal' },
    { name: '血红蛋白', value: '113', num: 113, status: 'low', flag: 'low' },
    { name: '骨髓原始细胞', value: '1.5', num: 1.5, status: 'normal' },
  ]
  const groups = groupForDoctorCard(rows)
  assert.equal(groups[0].cat, 'DISEASE')
  const cbc = groups.find((g) => g.cat === 'CBC')
  assert.equal(cbc.items[0].name, '血红蛋白', '异常项应排在组内第一')
  assert.equal(cbc.abnormalCount, 1)
})

it('资料卡摘要：异常清单 + 缺项提示（缺 WBC/PLT 要报出来）', () => {
  const rows = [{ name: '血红蛋白', value: '113', num: 113, status: 'low', flag: 'low', unit: 'g/L' }]
  const groups = groupForDoctorCard(rows)
  const s = summarizeForCard(groups)
  assert.equal(s.abnormalCount, 1)
  assert.deepEqual(s.missingBasics.sort(), ['PLT', 'WBC'])
})

it('资料卡兼容字段：组上带 rows 别名、行上带 measuredAt（供 lib/intakeCard.js 渲染层读取）', () => {
  const rows = [{ name: '白细胞', value: '6.83', num: 6.83, unit: '10^9/L', refRange: '3.5-9.5', status: 'normal', measuredAt: '2026-09-20', reportId: 'rep_x' }]
  const groups = groupForDoctorCard(rows)
  assert.equal(groups.length, 1)
  assert.ok(Array.isArray(groups[0].rows), 'group.rows 必须是数组')
  assert.equal(groups[0].rows, groups[0].items, 'rows 应与 items 是同一数组（别名，不复制）')
  assert.equal(groups[0].rows[0].measuredAt, '2026-09-20', '渲染层按 measuredAt 显示日期')
  assert.equal(groups[0].rows[0].reportId, 'rep_x')
})

it('资料卡兼容字段：无 measuredAt 时回落 reportDate（不出现空日期）', () => {
  const groups = groupForDoctorCard([{ name: '血小板', value: '321', num: 321, status: 'normal', reportDate: '2026-09-03' }])
  assert.equal(groups[0].rows[0].measuredAt, '2026-09-03')
})

it('单位规范化：OCR 拆坏的 10^n/L 与噪声单位', () => {
  assert.equal(normalizeUnit('*10 9/L'), '10^9/L')
  assert.equal(normalizeUnit('*10~9/L'), '10^9/L')
  assert.equal(normalizeUnit('*10°9/L'), '10^9/L')
  assert.equal(normalizeUnit('*109/L'), '10^9/L')
  assert.equal(normalizeUnit('*1012/L'), '10^12/L')
  assert.equal(normalizeUnit('gL&'), 'g/L')
  assert.equal(normalizeUnit('£1'), '')
  assert.equal(normalizeUnit('mg/L'), 'mg/L')
})

it('项目码判定：中文百分号 / 绝对值 # 不混淆，MCH 与 MCHC 不混淆', () => {
  assert.equal(detectCbcCode('中性粒细胞%'), 'NEUT_PCT')
  assert.equal(detectCbcCode('中性粒细胞#'), 'NEUT_ABS')
  assert.equal(detectCbcCode('单核细胞#'), 'MONO_ABS')
  assert.equal(detectCbcCode('平均红细胞血红蛋白含量CMCH）'), 'MCH')
  assert.equal(detectCbcCode('平均红细胞血红蛋白浓度（MCHC）'), 'MCHC')
  assert.equal(detectCbcCode('红细胞分布宽度-CV（RDW-CV）'), 'RDW_CV')
  assert.equal(detectCbcCode('完全不相干的行'), null)
  assert.equal(CBC_ORDER.length, 23)
})

it('序号插值：名称缺失的值行按序号补名，且必须打 nameInferred 标记', () => {
  // 第 1 行有名有号，第 2 行只有「序号 + 结果 + 区间」（真实单据里名称块没被识别）
  const text = ['1 白细胞（WBC） 3.33 3.5-9.5 10^9/L', '2 64.0 40-75'].join('\n')
  const rows = parseLabRows(text)
  assert.equal(rows.length, 2)
  const inferred = rows.find((r) => r.nameInferred)
  assert.ok(inferred, '第 2 行应被序号插值补名')
  assert.equal(inferred.name, '中性粒细胞%')
  assert.equal(inferred.value, '64.0')
  assert.equal(rows[0].nameInferred, false, '识别到的行不得标记为推定')
})

it('空输入不抛错', () => {
  assert.deepEqual(parseLabRows(''), [])
  assert.deepEqual(groupForDoctorCard([]), [])
  assert.equal(sha256Bytes(Buffer.from('')).length, 64)
})

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `报告导入层：${pass} 通过 / 0 失败` : `报告导入层：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
