// 报告导入层单元测试（纯函数，零网络零磁盘）
// 运行：node tests/verify-intake.mjs

import assert from 'node:assert/strict'
import {
  sha256Bytes, dhash64, hamming64, findDuplicate, NEAR_DUP_THRESHOLD,
  parseLabRows, classifyAnalyte, buildReportFingerprint, groupForDoctorCard, summarizeForCard,
  normalizeUnit, detectCbcCode, CBC_ORDER, splitTwoColumnLine, dedupeStitchRows, joinTwoLineNameRows, textSim, rowsForType,
} from '../lib/reportIntake.mjs'
import { FIELD_META, fieldMeta, expectedUnitRef } from '../lib/fieldDict.mjs'

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

it('拼接去重：同码同值同日期合并为一行，并留痕（不静默删）', () => {
  const rows = [
    { name: '血红蛋白', value: '53', num: 53, measuredAt: '2026-08-08' },
    { name: '白细胞', value: '3.17', num: 3.17, measuredAt: '2026-08-08' },
    { name: '血红蛋白', value: '53', num: 53, measuredAt: '2026-08-08' },
  ]
  const out = dedupeStitchRows(rows)
  assert.equal(out.rawCount, 3)
  assert.equal(out.merged, 1)
  assert.equal(out.rows.length, 2)
  const hb = out.rows.find((r) => r.name === '血红蛋白')
  assert.equal(hb.dedupedFrom, 2, '被合并的行必须记录合并了几条')
  assert.equal(hb.suspectedStitchDuplicate, true, '必须打疑似拼接重复标记')
})

it('拼接去重：同名不同值不合并（不同日期的复查不是重复）', () => {
  const out = dedupeStitchRows([
    { name: '血红蛋白', value: '53', measuredAt: '2026-08-08' },
    { name: '血红蛋白', value: '92', measuredAt: '2026-09-20' },
  ])
  assert.equal(out.rows.length, 2)
  assert.equal(out.merged, 0)
})

it('单图导入不受影响：parseLabRows 的产物永远不带拼接去重标记', () => {
  const rows = parseLabRows('白细胞 6.83 3.5-9.5 10^9/L\n血红蛋白 113 130-175 g/L')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.filter((r) => r.suspectedStitchDuplicate).map((r) => r.name), [])
})

it('空输入不抛错', () => {
  assert.deepEqual(parseLabRows(''), [])
  assert.deepEqual(groupForDoctorCard([]), [])
  assert.equal(sha256Bytes(Buffer.from('')).length, 64)
})

// ---------- 两行式版式（2026-11-15 手机端「检验报告详情」实测） ----------
// 原文：项目名单独一行，下一行是「正常范围：3.5~9.5<TAB>4.66*10~9/L」。
// 修复前 3 张截图 OCR 出 345~400 字却 **0 行**（用户以为识别失败了）。
it('两行式版式：项目名一行 + 正常范围行 → 必须解析成行（修复前是 0 行）', () => {
  const text = [
    '白细胞（WBC）',
    '正常范围：3.5~9.5\t4.66*10~9/L',
    '中性粒细胞百分比（NEUT%）',
    '正常范围：40~75\t64.7%',
    '血红蛋白（HGB）',
    '正常范围：115~150\t88 g/L',
  ].join('\n')
  const rows = parseLabRows(text)
  assert.equal(rows.length, 3, `应解析出 3 行，实际 ${rows.length}`)
  const hb = rows.find((r) => /血红蛋白/.test(r.name))
  assert.equal(hb.value, '88')
  assert.equal(hb.refRange, '115-150')
  assert.equal(hb.status, 'low', '血红蛋白 88 < 115 应判偏低')
  const wbc = rows.find((r) => /白细胞/.test(r.name))
  assert.equal(wbc.value, '4.66')
  assert.equal(wbc.unit, '10^9/L', '`10~9/L` 必须归一成 `10^9/L`')
  assert.equal(wbc.status, 'normal')
})

it('两行式版式：全角波浪号区间 `9～13` / `82～100` 必须能判高低（旧 REF_RE 只认 ASCII ~）', () => {
  const text = [
    '红细胞平均体积（MCV）',
    '正常范围：82～100\t102.4fL',
    '平均血小板体积（MPV）',
    '正常范围：9～13\t7.8fL',
  ].join('\n')
  const rows = parseLabRows(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].refRange, '82-100')
  assert.equal(rows[0].status, 'high', 'MCV 102.4 > 100 应判偏高')
  assert.equal(rows[1].refRange, '9-13')
  assert.equal(rows[1].status, 'low', 'MPV 7.8 < 9 应判偏低')
})

it('两行式拼接：幂等（已是一行的文本不再变），且不吞非两行式的行', () => {
  const single = '白细胞 6.83 3.5-9.5 10^9/L'
  assert.equal(joinTwoLineNameRows(single), single, '已是一行不该被改写')
  const mixed = '检验报告详情\n白细胞（WBC）\n正常范围：3.5~9.5\t4.66*10~9/L\n返回'
  const out = joinTwoLineNameRows(mixed).split('\n')
  assert.deepEqual(out, ['检验报告详情', '白细胞（WBC） 4.66 3.5~9.5 *10^9/L', '返回'], '只拼「名称+范围行」这一对，其余原样')
})

it('两行式版式：整份手机截图（23 项）必须全部出炉，且高低判定与截图箭头一致', () => {
  // 真实三屏合并后的行（值/区间照抄 OCR 原文，单位按归一后的写法）
  const src = [
    ['白细胞（WBC）', '3.5~9.5', '4.66', '10^9/L'],
    ['中性粒细胞百分比（NEUT%）', '40~75', '64.7', '%'],
    ['淋巴细胞百分比（LYM%）', '20~50', '28.9', '%'],
    ['单核细胞百分比（MXD%）', '3~10', '5.7', '%'],
    ['嗜酸性粒细胞百分比（EO%）', '0.4~8', '0.3', '%'],
    ['嗜碱性粒细胞百分比（BASO%）', '0.00~1', '0.40', '%'],
    ['中性粒细胞绝对值（NEUT#）', '1.8~6.3', '3.01', '*10^9/L'],
    ['淋巴细胞绝对值（LYM#）', '1.1～3.2', '1.35', '*10^9/L'],
    ['单核细胞绝对值（MXD#）', '0.10~0.60', '0.27', '*10^9/L'],
    ['嗜酸性粒细胞绝对值（EO#）', '0.02~0.52', '0.01', '*10^9/L'],
    ['嗜碱性粒细胞绝对值（BASO#）', '0.00～0.06', '0.02', '*10^9/L'],
    ['血红蛋白（HGB）', '115~150', '88', 'g/L'],
    ['红细胞（RBC）', '4.1~5.3', '2.63', '*10^12/L'],
    ['红细胞压积（HCT）', '35~45', '26.9', '%'],
    ['红细胞平均体积（MCV）', '82～100', '102.4', 'fL'],
    ['平均血红蛋白量（MCH）', '27~34', '33.4', 'pg'],
    ['平均血红蛋白浓度（MCHC）', '316~354', '326', 'g/L'],
    ['红细胞分布宽度（RDW-CV）', '11~16', '16.0', '%'],
    ['红细胞分布宽度（RDW-SD）', '37~54', '58.9', 'fL'],
    ['血小板（PLT）', '100~300', '275', '*10^9/L'],
    ['血小板压积（PCT）', '0.08~0.32', '0.21', '%'],
    ['平均血小板体积（MPV）', '9～13', '7.8', 'fL'],
    ['血小板分布宽度（PDW）', '9~17', '16.4', '%'],
  ]
  const text = src.map(([n, ref, v, u]) => `${n}\n正常范围：${ref}\t${v}${u}`).join('\n')
  const rows = parseLabRows(text)
  assert.equal(rows.length, 23, `应解析 23 项，实际 ${rows.length}`)
  assert.equal(rows.filter((r) => r.status === 'unknown').length, 0, '每一项都必须判出高低（unknown 意味着漏判）')
  assert.deepEqual(rows.filter((r) => r.status === 'high').map((r) => r.name.replace(/（.*?）/g, '')).sort(), ['红细胞平均体积', '红细胞分布宽度'].sort())
  assert.deepEqual(rows.filter((r) => r.status === 'low').map((r) => r.name.replace(/（.*?）/g, '')).sort(),
    ['嗜酸性粒细胞百分比', '嗜酸性粒细胞绝对值', '平均血小板体积', '红细胞', '红细胞压积', '血红蛋白'].sort())
})

// ---------- 查重：同一份报告的不同文件形态（2026-11-15 实测） ----------
// 事故：一份染色体核型 PDF 与库里已有的同一份（截图/旧提取）条码、类型全相同，
// 但字节不同（PDF vs png）、文本型报告又没有 dHash → 旧查重两条全落空 → **重复入库成功**。
it('查重：同条码 + 同日期 + 同类型 → 判重复（barcode-date）', () => {
  const lib = [{ id: 'a', barcode: 'V1', reportDate: '2026-07-15', reportType: '染色体核型' }]
  const r = findDuplicate({ barcode: 'V1', reportDate: '2026-07-15', reportType: '染色体核型' }, lib)
  assert.equal(r.dup, true); assert.equal(r.kind, 'barcode-date'); assert.equal(r.of, 'a')
})

it('查重：日期口径不同但互指（报告日期 / 采样 / 接检任一天相同）→ 仍判重复', () => {
  const lib = [{ id: 'a', barcode: 'V1', reportDate: '2026-07-15', sampledAt: '2026-07-15 12:51', receivedAt: '2026-07-17 10:07', reportType: '染色体核型' }]
  // 新抽取取了「接检 2026-07-17」当报告日期 —— 只比 reportDate 会漏判
  const r = findDuplicate({ barcode: 'V1', reportDate: '2026-07-17', reportType: '染色体核型' }, lib)
  assert.equal(r.dup, true, '跨日期口径必须判重复')
  assert.equal(r.kind, 'barcode-date-crosscheck')
})

it('查重不得误杀：同条码不同日期/不同类型 → 不判重复（同批共用条码很常见）', () => {
  const lib = [
    { id: 'a', barcode: 'V1', reportDate: '2026-07-18', reportType: '融合基因' },
    { id: 'b', barcode: 'V1', reportDate: '2026-07-15', reportType: '染色体核型' },
  ]
  assert.equal(findDuplicate({ barcode: 'V1', reportDate: '2026-07-19', reportType: '融合基因' }, lib).dup, false, '不同日期不得判重')
  assert.equal(findDuplicate({ barcode: 'V1', reportDate: '2026-07-15', reportType: '融合基因' }, lib).dup, false, '同日期不同类型不得判重')
  assert.equal(findDuplicate({ reportDate: '2026-07-15', reportType: '染色体核型' }, lib).dup, false, '没有条码时不按日期判重')
})

it('查重：任一方缺类型时退回旧行为（只看 sha/dHash），不按条码+日期拦（同批同条码很常见）', () => {
  const lib = [{ id: 'a', barcode: 'V1', reportDate: '2026-10-16', sha256: 'sha_old', dhash: '0'.repeat(64), fingerprint: 'fp_old' }]
  const r = findDuplicate({ barcode: 'V1', reportDate: '2026-10-16', sha256: 'sha_new', fingerprint: 'fp_new' }, lib)
  assert.equal(r.dup, false, '没有类型时不得仅凭「同条码同日期」判重')
  const withType = findDuplicate({ barcode: 'V1', reportDate: '2026-10-16', sha256: 'sha_new', fingerprint: 'fp_new', reportType: '血常规' }, lib)
  assert.equal(withType.dup, false, '库里那条没类型，仍然只能按 sha/dHash 判')
})

it('查重：文本型报告同一份文档的两次抽取（Jaccard ≥ 0.9）→ 判重复', () => {
  const t1 = '染色体核型分析报告单 检测结论 46,XX,t(9;22)(q34;q11.2)[2]/46,XX[13] 结果描述：正常核型。'
  const t2 = '染色体核型分析报告单 检测结论: 46,XX,t(9;22)(q34;q11.2)[2]/46,XX[13] 结果描述：正常核型'
  assert.ok(textSim(t1, t2) >= 0.9, `同一份文本相似度应 ≥0.9，实际 ${textSim(t1, t2)}`)
  const lib = [{ id: 'a', barcode: 'V1', reportDate: '2026-07-15', reportType: '染色体核型', text: t1 }]
  const r = findDuplicate({ barcode: 'V1', reportDate: '2026-07-16', reportType: '染色体核型', text: t2 }, lib)
  assert.equal(r.dup, true); assert.equal(r.kind, 'text-similar')
  // 不同报告不得被判重
  assert.ok(textSim(t1, '融合基因 BCR::ABL1 P210 定量 结果 12.3% 参考 0-0.1') < 0.6)
})

// ---------- 图文型报告不收指标行（2026-11-15 真报告实测） ----------
// 骨髓形态学的表是「细胞名称/(%)/参考值/均值/标准差」且大量空单元；流式是两列并排的「细胞群/比例%」。
// 硬按四列解析会产出垃圾（髓片 31 行垃圾；流式把 176,646 截成 176、造出「Cx=105」）。
it('图文型报告（骨髓形态/病理/流式）一律不出指标行，且 dropped 数如实上报', () => {
  const junk = [{ name: '原始粒细胞', value: '1.50' }, { name: '晚幼', value: '1.5' }]
  for (const ty of ['骨髓形态学（骨穿）', '病理活检', '流式免疫分型', '出院记录', '诊断证明']) {
    const r = rowsForType(junk, ty)
    assert.deepEqual(r.rows, [], `${ty} 不该出行`)
    assert.equal(r.dropped, 2, `${ty} 的 dropped 应如实为 2`)
  }
})

it('化验/分子类报告照常出行（PCR 的 BCR-ABL 定量三行是准的）', () => {
  const good = [{ name: 'BCR-ABL P190', value: '0' }, { name: 'ABL', value: '395707' }, { name: 'BCR-ABL P190/ABL', value: '0%' }]
  for (const ty of ['融合基因', '血常规', '凝血四项', '生化', '尿常规', '心衰+感染标志物']) {
    const r = rowsForType(good, ty)
    assert.equal(r.rows.length, 3, `${ty} 应保留 3 行`)
    assert.equal(r.dropped, 0)
  }
  assert.deepEqual(rowsForType([], '骨髓形态学（骨穿）'), { rows: [], dropped: 0 })
})

// ---------- 真截图回归（2026-11-15 用户两张 20260718 血常规截图，已脱敏）----------
// 那次实测暴露 6 类缺陷，全部用这份原文守着：
//   ① `中性粒细胞百分 •20.1J 40-75 %` 的值前有 `•` → 名称正则的 lookahead 不认 → 整行丢（11 项只出 10）
//   ② `报告单号 20260101G0000001` 被解析成 `报告单号=20260101` → 卡片凭空多一个假指标
//   ③ `10~9/L`、`fI`、`PG`、`FL` 不在单位表里 → 单位整格丢失
//   ④ `＜=15%` 是单边阈值不是区间 → 旧逻辑把 % 当单位、区间丢失 → 12.6 判 unknown（本应正常）
//   ⑤ 名称折行（续行排在值行之后）→ 31.9 与 362 两条不同指标都叫「红细胞平均血红」
//   ⑥ 免责声明「请以医院纸质报告…」被抽成院名 `请以医院`（这条在 verify-import-report 里守）
const PAGE1 = `12:12
<	检验报告	◎
全血细胞计数＋五分类
患者信息 张三（00000000）◎女|
30岁
报告单号 20260101G0000001
报告时间 2026-01-01 07:56:07	更多
检验项目
检验项目	结果	参考范围	单位
白细胞计数	71.90	3.5-9.5	10~9/L
红细胞计数	4.08	3.8-5.1	10~12/L
血红蛋白	130	115-150	G/L
红细胞比积	35.9	35-45	%
红细胞平均体积	88.0	82-100	fl
红细胞平均血红	31.9	27-34	PG
蛋白含量
红细胞平均血红	362 个	316-354	G/L
蛋白浓度
淋巴细胞百分比	78.8个	20-50	%
单核细胞百分比	0.7	3-10	%
中性粒细胞百分	•20.1J	40-75	%
比
嗜酸性粒细胞百	0.3	0.4-8	%
分比
⑦分享报告`
const PAGE2 = `12:12
<	检验报告	••	◎
、~	~
比
嗜酸性粒细胞百	0.3J	0.4-8	%
分比
嗜碱性粒细胞百	0.1	0-1	%
分比
淋巴细胞计数	56.66个	1.1-3.2	10~9/L
单核细胞计数	0.50	0.1-0.6	10~9/L
嗜酸性粒细胞计	0.22	0.02-0.52	10~9/L
数
嗜碱性粒细胞计	0.07个	0-0.06	10~9/L
数
红细胞分布宽度	12.6	＜=15%	fl
变异系数
血小板分布宽度	16.6	fI
血小板平均体积	8.3	fI
血小板	104	125-350	10~9/L
中性粒细胞计数 14.45个	1.8-6.3	10~9/L
红细胞分布宽度	38.10	FL
标准差
血小板压积	0.086	％
检验免责声明：
本结果仅供参考，请以医院纸质报告及医生意见为准。
C分享报告`

it('真截图 A：抬头行不得变成指标行（报告单号=20260101 这类假行）', () => {
  const rows = parseLabRows('报告单号 20260101G0000001\n报告时间 2026-01-01 07:56:07')
  assert.equal(rows.length, 0, `抬头行不得解析成指标，实际 ${JSON.stringify(rows.map((r) => r.name))}`)
})

it('真截图 B：值前噪声（•20.1J）不得让整行消失', () => {
  const rows = parseLabRows('中性粒细胞百分\t•20.1J\t40-75\t%')
  assert.equal(rows.length, 1, '整行被丢 = 卡片少一个数')
  assert.equal(rows[0].value, '20.1')
  assert.equal(rows[0].refRange, '40-75')
  assert.equal(rows[0].status, 'low')
})

it('真截图 C：两页合并 23 项、0 假行、名称/单位/单边区间全对（用户报「识别数出错」的那一份）', () => {
  const p1 = parseLabRows(PAGE1)
  const p2 = parseLabRows(PAGE2)
  assert.equal(p1.length, 11, `页1 应出 11 行，实际 ${p1.length}（少一行 = 卡片少一个数）`)
  assert.equal(p2.length, 13, `页2 应出 13 行，实际 ${p2.length}`)
  const all = [...p1, ...p2]
  const seen = new Set()
  const uniq = all.filter((r) => { const k = r.name + '|' + r.value; if (seen.has(k)) return false; seen.add(k); return true })
  assert.equal(uniq.length, 23, `两页合并应为 23 项，实际 ${uniq.length}`)
  assert.ok(!all.some((r) => /报告单号|报告时间|患者信息|检验项目/.test(r.name)), '抬头行不得出现在指标里')
  const mch = uniq.find((r) => r.code === 'MCH')
  const mchc = uniq.find((r) => r.code === 'MCHC')
  assert.ok(mch && mchc, `MCH/MCHC 必须能区分，实际 ${JSON.stringify(uniq.map((r) => r.name))}`)
  assert.notEqual(mch.name, mchc.name, '两个不同指标不得同名')
  assert.deepEqual([mch.name, mch.value, mch.unit], ['红细胞平均血红蛋白含量', '31.9', 'pg'])
  assert.deepEqual([mchc.name, mchc.value, mchc.unit], ['红细胞平均血红蛋白浓度', '362', 'g/L'])
  assert.equal(uniq.find((r) => r.code === 'WBC').unit, '10^9/L')
  assert.equal(uniq.find((r) => r.code === 'PLT').unit, '10^9/L')
  assert.equal(uniq.find((r) => r.code === 'PDW').unit, 'fL')
  assert.equal(uniq.find((r) => r.code === 'RDW_SD').unit, 'fL')
  const rdwcv = uniq.find((r) => r.code === 'RDW_CV')
  assert.equal(rdwcv.refRange, '<15%', `单边阈值必须保留，实际「${rdwcv.refRange}」`)
  assert.equal(rdwcv.unit, '', '阈值里的 % 不是这一项的单位')
  assert.equal(rdwcv.status, 'normal')
  const abn = uniq.filter((r) => r.status === 'high' || r.status === 'low').map((r) => `${r.code}:${r.status}`).sort()
  assert.deepEqual(abn, ['BASO_ABS:high', 'EO_PCT:low', 'LYM_ABS:high', 'LYM_PCT:high', 'MCHC:high', 'MONO_PCT:low', 'NEUT_ABS:high', 'NEUT_PCT:low', 'PLT:low', 'WBC:high'])
})

it('真截图 D：单边阈值（<15% / ≤0.5）不得被当成区间下限、也不得抢走单位', () => {
  const a = parseLabRows('红细胞分布宽度 12.6 ＜=15%')
  assert.equal(a[0].refRange, '<15%')
  assert.equal(a[0].unit, '')
  assert.equal(a[0].status, 'normal')
  const b = parseLabRows('降钙素原 0.02 ≤0.5 ng/mL')
  assert.equal(b[0].refRange, '<0.5')
  assert.equal(b[0].unit, 'ng/mL')
  assert.equal(b[0].status, 'normal')
})

it('真截图 E：幂次单位与字形变体归一（10~9/L → 10^9/L，不猜不删）', () => {
  assert.equal(normalizeUnit('10~9/L'), '10^9/L')
  assert.equal(normalizeUnit('10°9/L'), '10^9/L')
  assert.equal(normalizeUnit('10 9/L'), '10^9/L')
  assert.equal(normalizeUnit('fI'), 'fL')
  assert.equal(normalizeUnit('FL'), 'fL')
  assert.equal(normalizeUnit('PG'), 'pg')
})


it('指标字段元数据：标准单位/参考区间可查，认不出的码返回空（不猜）', () => {
  assert.ok(FIELD_META.length >= 150, `字段数量异常：${FIELD_META.length}`)
  assert.deepEqual(expectedUnitRef('WBC'), { unit: '10^9/L', ref: '3.5-9.5' })
  assert.deepEqual(expectedUnitRef('MCHC'), { unit: 'g/L', ref: '316-354' })
  assert.equal(fieldMeta('NOPE_NOT_A_CODE'), null, '未知码必须返回 null，不许编')
  assert.deepEqual(expectedUnitRef('NOPE_NOT_A_CODE'), { unit: '', ref: '' })
  // 红线：元数据里的 ref 只是「常见区间」，不得被当成判定依据（各院区间不同）
  assert.ok(!/判定|judge/i.test(String(fieldMeta('WBC').ref)), 'ref 只是展示用区间')
})

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `报告导入层：${pass} 通过 / 0 失败` : `报告导入层：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
