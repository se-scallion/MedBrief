// ===================== 状态判定与数据标准化 =====================

import { mapAlias, mapAliasAll, ALIAS_MAP, FIELD_BY_CODE, matchDroppedCharVariant, REPORT_TYPES, repairFusionName } from '../data/dictionary.js'
import { detectReportType as catalogDetectReportType, inferReportType as catalogInferReportType } from '../data/reportCatalog.js'

// 合法等效计量体系：同一项目可用不同计量体系出具，均属正确写法，不应判单位错位。
// 与单纯「等价单位名单」不同，这里把每套体系「自带的标准参考范围」一并登记——
// 因为不同计量体系的参考范围随体系自然不同（如 CK-MB 酶法 U/L 参考 0-25，
// 化学发光法 ng/ml 参考 0-5.6），参考范围校验也应按体系各自比对，而非一律跳过。
// 这样既能放行「同体系内的合法差异」，也能抓住「同一单位体系却把参考范围填错」的真错误
// （例如 ng/ml 体系却写成 0-500）。
const UNIT_SYSTEMS = {
  // Lp(a)：质量浓度 mg/L（参考 0-300）≡ 摩尔浓度 nmol/L（参考 0-75）
  LPA: { 'mg/L': '0-300', 'nmol/L': '0-75' },
  // CK-MB 肌酸激酶同工酶：酶法 U/L（参考 0-25）≡ 化学发光法/免疫比浊 ng/ml（参考 0-5.6）
  CK_MB: { 'U/L': '0-25', 'ng/ml': '0-5.6' },
}
// 报告单位是否为 code 项目的合法等效单位（语义上与字典单位等价，非 OCR 噪声）
function unitsEquivalent(code, reportUnit, stdUnit) {
  const sys = UNIT_SYSTEMS[code]
  if (!sys) return false
  const r = normalizeUnit(reportUnit || '').toLowerCase()
  const s = normalizeUnit(stdUnit || '').toLowerCase()
  return Object.keys(sys).some((u) => normalizeUnit(u).toLowerCase() === r) &&
    Object.keys(sys).some((u) => normalizeUnit(u).toLowerCase() === s)
}
// 报告单位命中某等效体系时，返回该体系的标准参考范围；否则返回 null。
// 用于把参考范围校验从「字典主参考范围」切换为「报告单位所属体系的标准参考范围」。
function equivUnitExpectedRef(code, reportUnit) {
  const sys = UNIT_SYSTEMS[code]
  if (!sys) return null
  const r = normalizeUnit(reportUnit || '').toLowerCase()
  const hit = Object.keys(sys).find((u) => normalizeUnit(u).toLowerCase() === r)
  return hit ? sys[hit] : null
}

// 单位消歧的项目名映射：当 name 同时命中多个字段（如「中性粒细胞」可命中 NEUT_ABS/NEUT_PCT），
// 且报告自带单位时，优先选用单位匹配的字段。这是 LLM 语义推断的「值类型签名」确定性实现：
// 「中性粒细胞」+ 单位 % → NEUT_PCT；+ 单位 ×10^9/L → NEUT_ABS。仅当单位能唯一锁定时才覆盖
// 原 mapAlias 结果（避免单位噪声/缺省时误改）。返回 string|null。
// 血常规（CBC）固定项目顺序：序号锚定用（LLM 推断的「序号→项目」映射的确定性实现）。
// 序号是 OCR 对这类表格最可靠的信号之一；当 name 乱码且 value+ref 反推失败时，
// 用序号直接锚定标准项目。key = 字段 code。
const CBC_SEQUENCE = [
  'WBC', 'NEUT_PCT', 'LYM_PCT', 'MONO_PCT', 'EO_PCT', 'BASO_PCT',
  'NEUT_ABS', 'LYM_ABS', 'MONO_ABS', 'EO_ABS', 'BASO_ABS',
  'RBC', 'Hb', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW_CV',
  'PLT', 'PDW', 'MPV', 'P_LCR', 'HS_CRP',
]

// 判定两个单位是否同量纲：仅用于「单位是否足以推翻中文名映射」的保守判断。
// % 与 ×10^9/L 明确不同；×10^9/L / 10^9/L / *10^9/L / 10*9/L 视为同量纲（同尺规）。
// 保守起见，仅当两者均为「明确互斥」类别时返回 false，否则返回 true（不推翻）。
function sameUnitClass(a, b) {
  const pct = (u) => /^%$|百分比|percent/i.test(u.trim())
  const count = (u) => /10\^?9|10\*9|10⁹|×10|\*10/i.test(u.trim())
  const gperl = (u) => /g\/l|mg\/l/i.test(u.trim())
  const fL = (u) => /f?l|fl|pg/i.test(u.trim())
  const cls = (u) => (pct(u) ? 'pct' : count(u) ? 'count' : gperl(u) ? 'gperl' : fL(u) ? 'fl' : 'other')
  const ca = cls(a)
  const cb = cls(b)
  // 明确互斥：百分比 vs 计数；百分比 vs g/L；计数 vs fL/pg
  const mutuallyExclusive =
    (ca === 'pct' && (cb === 'count' || cb === 'gperl' || cb === 'fl')) ||
    (cb === 'pct' && (ca === 'count' || ca === 'gperl' || ca === 'fl'))
  return !mutuallyExclusive
}

export function mapAliasWithUnit(rawName, unit) {
  const base = mapAlias(rawName)
  if (!base || !unit) return base
  const cands = mapAliasAll(rawName)
  if (!cands || cands.length < 2) return base
  const un = normalizeUnit(unit).toLowerCase().replace(/\s+/g, '')
  // 候选里与报告单位一致的字段
  const byUnit = cands.filter((c) => {
    const f = FIELD_BY_CODE[c.code]
    if (!f) return false
    const fu = normalizeUnit(f.unit || '').toLowerCase().replace(/\s+/g, '')
    return fu === un || (fu.includes('/l') && un.includes('/l')) // 同量纲（10^9/L 变体）
  })
  // 单位候选唯一，且与原映射不同 → 用单位消歧结果；否则保持原映射
  if (byUnit.length === 1 && byUnit[0].code !== base) return byUnit[0].code
  return base
}

// 单位量纲矛盾时的同族兄弟字段改投：name 别名命中的字段（如 EO_ABS）其单位量纲与本行
// 单位矛盾（EO_ABS 应为 *10^9/L，本行却是 %），但同前缀（EO_/NEUT_/LYM_/MONO_/BASO_/RET_）
// 且单位量纲吻合的兄弟字段（EO_PCT，%）存在 → 改投兄弟。覆盖 OCR 把「嗜酸性粒细胞绝对值」
// 读成 % 单位、实为「嗜酸性粒细胞百分比(EO_PCT)」的错配（case-TR-20260830-MINQ7R）。
// 仅当本行单位量纲与当前字段矛盾、且存在唯一单位吻合的兄弟时才改投，安全不误伤。
function siblingByUnit(code, unit) {
  if (!code || !unit) return null
  const fam = code.replace(/_(PCT|ABS|COUNT|RATIO)$/i, '')
  if (fam === code) return null // 无单位后缀，无兄弟字段
  const fu = (FIELD_BY_CODE[code] && FIELD_BY_CODE[code].unit) || ''
  if (!fu || sameUnitClass(unit, fu)) return null // 当前字段单位已吻合，无需改投
  for (const c of Object.keys(FIELD_BY_CODE)) {
    if (c === code) continue
    if (!c.startsWith(fam + '_')) continue
    const cu = FIELD_BY_CODE[c].unit || ''
    if (cu && sameUnitClass(unit, cu)) return c
  }
  return null
}

// 「检出下限型」字段：ref 是检出灵敏度（如流式 MRD 残留的 <0.01%），不是参考区间上限。
// 阳性值天然大于它（报告 <0.01 而测出 0.2% 恰恰就是阳性结果），不存在「小数点错位」语义，
// 故不做越界/小数点候选提示——否则会把正面结论 0.2 提示成 0.002（危险误导，等于劝用户改错值）。
const DETECTION_LIMIT_CODES = new Set(['FCM_MRD'])

// 危急值规则（超出参考范围之外更严格的红线，用于 CRITICAL 判定）
const CRITICAL_RULES = {
  WBC: { low: 1.0, high: 50 },
  Hb: { low: 60, high: 200 },
  PLT: { low: 20, high: 1000 },
  NEUT_ABS: { low: 0.5 },
  NEUT_PCT: { low: 5 },
  ALT: { high: 500 },
  AST: { high: 400 },
  TBIL: { high: 171 },
  K: { low: 2.5, high: 6.5 },
  Na: { low: 120, high: 160 },
  Ca: { low: 1.5, high: 3.5 },
  CTNI: { high: 0.5 },
  HS_CRP: { high: 100 },
  D_DIMER: { high: 10 },
}

// 常用质量浓度单位换算（相对 mg/L 的倍数），用于 computeStatus 危急判断前的单位归一化。
// 例：D-二聚体报告常以 ug/L 出具（558 ug/L = 0.558 mg/L），若不换算，558 会被危急规则 high:10 误判为危急高值。
const UNIT_TO_MGL = {
  'g/l': 1000,
  'mg/l': 1,
  'ug/l': 0.001,
  'μg/l': 0.001,
  'mcg/l': 0.001,
  'ng/ml': 0.001,
  'ng/l': 1e-6,
}

// 取某字段的规范缩写（如 MCH→"MCH"、HS_CRP→"HS-CRP"）：
// 从该字段全部别名中挑「纯英文/数字/符号（2-8 字符）」形式的别名，用于把
// OCR 读乱的缩写列（MCH→NMCI、PDW→Pow）回填成标准写法。
function canonicalAbbr(code) {
  if (!code) return ''
  const a = (ALIAS_MAP[code] || []).find((x) => /^[A-Za-z0-9#%^\-]{2,8}$/.test(x.replace(/\s+/g, '')))
  return a ? a.replace(/\s+/g, '').toUpperCase() : ''
}

// OCR 单位规范化：化验单上标「10^9/L、10^12/L」常被 OCR 读成
// 10°9/L、10"9/L、10'9/L、10~9/L、10*9/L、10⁹/L 等变体，
// 统一为字典标准写法，避免同一单位多种写法污染数据与显示。
// 上标 9/12 的常见 OCR 误识符号：° " ' ′ ″ ʺ ˝ * × · ~ ↑ ↓
export function normalizeUnit(u) {
  if (!u) return u
  let s = String(u).trim().replace(/\s+/g, '')
  // 单位里 OCR 把分隔斜杠 / 读成撇号 '（如 mIU'mL → mIU/mL），单位中 ' 无合法语义，直接归一
  s = s.replace(/'/g, '/')
  // 「百分比单位」OCR 碎片归一（2026-10-28 血常规反馈 TR-20261028-VCU1MO 实测）：
  // 双栏行内 token 归并会把邻栏序号码/% 符号挤进单位格 → "16%"、"4%"、"20%" 这类
  // 「1-2 位数字 + %」以及 "%y"、"%")"、"%)" 这类「% + 尾部杂字」都归一成 "%"。
  // 合法单位里没有「数字+%」或「%+杂字」形态，故可安全收敛（只动单位写法，绝不动数值）。
  s = s.replace(/^\d{1,2}(?=%)/, '').replace(/^%(\W|[a-zA-Z]){0,2}$/, '%')
  // 真上标字符：10⁹/L → 10^9/L
  s = s.replace(/10([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\/L/g, (_, sup) => `10^${[...sup].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)).join('')}/L`)
  // 误识符号夹在 10 与指数之间：10°9/L、10"9/L、10~9/L → 10^9/L
  s = s.replace(/10[°"'‘’`′″ʺ˝*×·~↑↓]([0-9]{1,3})\/L/g, '10^$1/L')
  // 常见 OCR 单位字形误读变体归一（仅字形/字符噪声，同一单位的不同写法，绝不改数值）：
  //   V/L→U/L（酶活单位 U 被读成 V）、amol/L→mmol/L、wol/L/wmol/L→umol/L、e/L→g/L
  //   真实反馈扩充（TR-20260828-3DQWJ6）：w/uw/wn 前缀 = µ 的 OCR 变体（wumol/L、uwmol/L、wnol/L）、
  //   umoly/L（l 读成 y）、me/L→mg/L（多余 e）、W/L→U/L（大写 W）、裸 mmol 补全 /L。
  const UNIT_OCR_FIX = {
    'v/l': 'u/l',
    'w/l': 'u/l',
    'amol/l': 'mmol/l',
    'wol/l': 'umol/l',
    'wmol/l': 'umol/l',
    'wumol/l': 'umol/l',
    'uwmol/l': 'umol/l',
    'wnol/l': 'umol/l',
    'umoly/l': 'umol/l',
    'e/l': 'g/l',
    'me/l': 'mg/l',
    'mmol': 'mmol/l',
  }
  const low = s.toLowerCase()
  if (UNIT_OCR_FIX[low]) s = UNIT_OCR_FIX[low]
  return s
}

// OCR 单位噪声修正判定：报告单位是否为「标准单位的 OCR 误读变体」。
// normalizeUnit 只归一符号变体（10°9/L→10^9/L），仍漏两类常见 OCR 噪声：
//   ① 幂次基数误读：标准 10^9/L 被读成 410^9/L（数字位串读）
//   ② 幂次前缀丢失：标准 10^9/L 被读成 9/L（丢了「10^」）
// 这类单位通过 standard_code 即可锁定标准单位（如 PLT/NRBC# → 10^9/L），
// 属「同一单位的噪声写法」，应直接修正回标准单位，而非判成 mismatch 降低质量分。
// 返回修正后的标准单位字符串；无法确证为噪声（真 mismatch，如 fL vs g/L）返回 null。
export function unitOcrNoise(reportUnit, stdUnit) {
  if (!reportUnit || !stdUnit) return null
  const r = String(reportUnit).replace(/\s+/g, '').toLowerCase()
  const s = String(stdUnit).replace(/\s+/g, '').toLowerCase()
  if (r === s) return stdUnit

  // 归一幂次符号：OCR 常把 ^ 读成 ° 、" 、‘ 、` 等（如 410°9/L、410"9/L）
  const powSym = '[\\^°"‘’`′″˝*×·~]'
  const rPow = r.replace(new RegExp(powSym, 'g'), '^')
  if (rPow !== r) return unitOcrNoise(rPow, stdUnit)

  // 标准单位为「10^N/L」幂次形态
  const mStd = s.match(/^10\^(\d+)\/l$/)
  if (!mStd) return null
  const stdExp = mStd[1]

  // ① 报告也是「N^exp/L」且指数相同（基数被 OCR 串读，如 410^9/L）→ 噪声
  const mPow = r.match(/^\d{2,}\^(\d+)\/l$/)
  if (mPow && mPow[1] === stdExp) return stdUnit
  // ② 报告是「exp/L」形态（丢了 10^ 前缀与幂次符，如 9/L）→ 噪声
  const mLone = r.match(/^(\d{1,3})\/l$/)
  if (mLone && mLone[1] === stdExp) return stdUnit

  return null
}

export const STATUS_META = {
  CRITICAL_LOW: { label: '危急低值', symbol: '↓', color: 'red' },
  CRITICAL_HIGH: { label: '危急高值', symbol: '↑', color: 'red' },
  LOW: { label: '偏低', symbol: '↓', color: 'amber' },
  HIGH: { label: '偏高', symbol: '↑', color: 'amber' },
  NORMAL: { label: '正常', symbol: '', color: 'emerald' },
}

// ===== 数值合理性校验（疑似 OCR 错位检测）=====
// 化验单识别常见问题：数值小数点错位（0.156→15.6）、单位列/参考范围列串行
// （MCHC 单位 fL 应为 g/L、MCH 参考 125~350 是 PLT 的）。此时 standard_code
// 通常映射正确，但值/单位/参考范围与字典基准明显不符。
// 策略：不自动改写数据（无法区分「真实危急值」与「错位值」），仅标记可疑并给出
// 小数点位移修正候选，由用户在编辑弹窗中一键确认。
// 判定以「报告自带参考范围」为准（报告是事实来源）：
//   · 值在报告范围内 → 仅单位错位标记（列错位强信号）；参考范围与字典差异
//     单独不标（不同医院仪器标准不同，如 hs-CRP 0-5 vs 0-10，属正常差异）
//   · 值越出报告范围 → 尝试小数点位移候选（必须落回报告范围才算有效修正），
//     有候选则标记；无候选且单位/参考范围均正常 → 视为真实危急/异常值不标记
// 返回 { suspicious, reason, candidates: [{ factor, fixed }] }
export function detectSuspiciousValue(code, value, reportRef, unit) {
  if (!code || value == null || String(value).trim() === '') return { suspicious: false, candidates: [] }
  const v = parseFloat(value)
  if (Number.isNaN(v)) return { suspicious: false, candidates: [] }

  const field = FIELD_BY_CODE[code]
  const dictRef = field ? parseRefRange(field.ref) : null
  const reportParsed = parseRefRange(reportRef)
  // 报告无参考范围时回退到字典范围
  const range = reportParsed || dictRef
  if (!range || (range.low == null && range.high == null)) return { suspicious: false, candidates: [] }

  // 值是否落在范围内（严格按报告范围；报告缺上限/下限时该侧不做约束）
  const inRange = (x) => {
    if (range.low != null && x < range.low) return false
    if (range.high != null && x > range.high) return false
    return true
  }

  // 列错位强信号：单位与字典不符。两种情形：
  //  ① 标准有单位但写法内容不同（如 MCHC 应为 g/L 被读成 fL）
  //  ② 标准无单位却解析出单位（如比值类白球比 AG 误带 umol/L）
  const unitNorm = normalizeUnit(unit || '')
  // 合法等效单位（如 Lp(a) nmol/L ≡ mg/L）不判错位
  const equivUnit = field && unitsEquivalent(code, unit, field.unit)
  const unitMismatch = !!(
    !equivUnit &&
    field &&
    unitNorm &&
    (field.unit ? unitNorm.toLowerCase() !== field.unit.toLowerCase() : true)
  )
  // 参考范围与字典差异 >50%（如 BASO_PCT 报告 3.0~10.0 而字典 0-1）
  let refMismatch = false
  if (dictRef && reportParsed && dictRef.high != null && reportParsed.high != null && dictRef.high > 0) {
    refMismatch = Math.abs(reportParsed.high - dictRef.high) / dictRef.high > 0.5
  }

  // 单位错位是列错位强信号（如 MCHC 应为 g/L 被读成 fL），值是否合理都标记
  if (unitMismatch) {
    return { suspicious: true, reason: '单位与标准不符，疑似列错位', candidates: [] }
  }

  // 检出下限型字段（流式 MRD 残留）：ref 是灵敏度上界，任何阳性值都必然越界，
  // 越界不是识别错误而是结论本身 → 不再提示小数点候选（见 DETECTION_LIMIT_CODES 注释）。
  if (DETECTION_LIMIT_CODES.has(code)) return { suspicious: false, candidates: [] }

  // 值在报告范围内：参考范围与字典不同不标记（不同医院仪器标准差异，如 hs-CRP 0-5 vs 0-10）
  if (inRange(v)) return { suspicious: false, candidates: [] }

  // 值越出报告范围且参考范围与字典差异显著（如 BASO_PCT 报告 3.0~10.0 而字典 0-1）
  // → 是参考范围列串行，标记并提示修正参考范围（不找小数点候选，避免把真实值改错）
  if (refMismatch) {
    return { suspicious: true, reason: '参考范围与标准不符，疑似列错位', candidates: [] }
  }

  // 值越出报告范围：尝试小数点位移候选（必须落回报告范围才算有效修正）
  // 候选命中说明识别把小数点错位了（如 15.6 → 0.156）；无候选则视为真实危急值
  // （如 PLT_PCT 0.01 虽低于 0.11，但 ×10 后 0.1 仍低于范围 → 无有效候选 → 不标记）。
  const candidates = []
  for (let n = 1; n <= 3 && !candidates.length; n++) {
    for (const factor of [Math.pow(10, n), 1 / Math.pow(10, n)]) {
      const fixed = Number((v * factor).toPrecision(8))
      if (inRange(fixed)) {
        candidates.push({ factor, fixed })
        break
      }
    }
  }
  if (!candidates.length) return { suspicious: false, candidates: [] }

  const crit = isCritical(code, v)
  const reason = crit
    ? '数值与报告参考范围差异极大，疑似识别错位；若为真实危急值请核对后保留'
    : '数值与报告参考范围差异过大，疑似小数点错位'
  return { suspicious: true, reason, candidates }
}

// 解析参考范围字符串："125-350" / "0-5" / ">0.5" / "<10"
export function parseRefRange(ref) {
  if (!ref) return null
  const s = String(ref).trim()
  // 允许 1-2 个分隔符（OCR 长参考区间常把单连字符读成双连字符：3--5.8、316--354、125--350）
  const m = s.match(/^([<>]?)\s*([\d.]+)\s*[-~—～]{1,2}\s*([\d.]+)$/)
  if (m) {
    const low = parseFloat(m[2])
    const high = parseFloat(m[3])
    if (!Number.isNaN(low) && !Number.isNaN(high)) return { low, high }
  }
  const gt = s.match(/^>\s*([\d.]+)$/)
  if (gt) return { low: parseFloat(gt[1]), high: null }
  const lt = s.match(/^<\s*([\d.]+)$/)
  if (lt) return { low: null, high: parseFloat(lt[1]) }
  return null
}

function isCritical(code, value) {
  // 危急值以「临床危急值规则表」为准，避免参考范围过窄导致的误报
  const rule = CRITICAL_RULES[code]
  if (rule) {
    if (rule.low != null && value < rule.low) return 'CRITICAL_LOW'
    if (rule.high != null && value > rule.high) return 'CRITICAL_HIGH'
  }
  return null
}

// 计算状态：参考值优先，其次参考箭头，危急规则兜底
// unit：报告单位，用于危急判断前的单位归一化（如 D-二聚体报告 ug/L，危急规则按字典基准 mg/L）。
// 参考范围判断用原始值——value 与 refRange 同源（同报告或同字典），单位一致直接比较自洽。
export function computeStatus(code, value, refRange, arrow = '', unit = '') {
  const v = parseFloat(value)
  if (Number.isNaN(v)) return 'NORMAL'
  const ref = parseRefRange(refRange)

  // 危急判断使用「基准单位」值：报告单位与字典基准单位不一致时先换算（如 D-二聚体 ug/L → mg/L）
  let baseV = v
  if (unit) {
    const dictUnit = (FIELD_BY_CODE[code]?.unit || '').toLowerCase()
    const from = UNIT_TO_MGL[unit.toLowerCase()]
    const to = UNIT_TO_MGL[dictUnit]
    if (from != null && to != null && from !== to) baseV = v * (from / to)
  }
  const crit = isCritical(code, baseV)
  if (crit) return crit

  const arrowUp = /↑|高|偏高|升高/.test(String(arrow || ''))
  const arrowDown = /↓|低|偏低|降低/.test(String(arrow || ''))

  if (ref && ref.low != null && ref.high != null) {
    if (v < ref.low) return 'LOW'
    if (v > ref.high) return 'HIGH'
  } else if (ref && ref.low != null && v < ref.low) {
    return 'LOW'
  } else if (ref && ref.high != null && v > ref.high) {
    return 'HIGH'
  }
  if (arrowUp) return 'HIGH'
  if (arrowDown) return 'LOW'
  return 'NORMAL'
}

// 检测多栏表头（如迈瑞血常规「左栏+右栏」报告），将 grid 按栏纵向切片返回子表；单栏返回 null
function splitMultiColumnGrid(grid) {
  // 表头行检测
  let headerIdx = -1
  let headerRow = null
  for (let i = 0; i < grid.length && i < 6; i++) {
    const row = grid[i].map((c) => String(c || '').trim())
    const joined = row.join('')
    if (!joined) continue
    if (/项目|名称|检测项目|指标|检验项目|化验项目/.test(joined) && /结果|测定值|检测值|数值|检验结果/.test(joined)) {
      headerIdx = i
      headerRow = row
      break
    }
  }
  if (headerIdx < 0 || !headerRow) {
    // 表头未识别（OCR 乱码）时，回退到基于每行的整页栏位标记 col（0=左/1=右）拆分双栏：
    // OCR 已把左右栏各自解析并打上整页栏位，此处据此把混排的行还原成左右两栏，
    // 避免左右栏按 y 交错后整表当单栏导致 value 串行错位、整行被吞。
    // 容错：忽略末列非数字（异常行）的少数行，只要绝大多数行带整页栏位且左右栏都有数据即拆分
    const colRows = grid.filter(
      (r) => Array.isArray(r) && r.length >= 2 && (r[r.length - 1] === 0 || r[r.length - 1] === 1)
    )
    if (colRows.length >= grid.length * 0.8 && colRows.length > 0) {
      const groups = [[], []]
      for (const r of colRows) {
        const c = r[r.length - 1]
        groups[c].push(r.slice(0, r.length - 1))
      }
      if (groups[0].length && groups[1].length) return [groups[0], groups[1]]
    }
    return null
  }

  const resultCols = []
  const nameCols = []
  headerRow.forEach((c, idx) => {
    if (/结果|数值|测定值|检测值/.test(c)) resultCols.push(idx)
    if (/项目|名称|指标|检验项目/.test(c)) nameCols.push(idx)
  })
  // 多栏判定：同一行出现 ≥2 个「结果」列
  if (resultCols.length < 2) return null

  const total = headerRow.length
  const bounds = resultCols.map((rc, k) => {
    const prevResult = k > 0 ? resultCols[k - 1] : -1
    // 本栏起始：rc 之前、上一个结果列之后最近的「项目/名称」列
    const nameBefore = nameCols.filter((n) => n > prevResult && n < rc).pop()
    const start = nameBefore != null ? nameBefore : k === 0 ? 0 : prevResult + 1
    // 本栏结束：下一个「项目/名称」列之前，否则到表尾
    const nameAfter = nameCols.filter((n) => n > rc).shift()
    const end = nameAfter != null ? nameAfter : total
    return { start, end: Math.max(end, start + 1) }
  })
  return bounds.map((b) => grid.map((r) => r.slice(b.start, b.end)))
}

// ===== 参考范围差异度量（审计与「确定值反推」共用）=====
// 度量：范围中心偏移 / 标准跨度（主指标）。端点相对差异易误报（如 HS_CRP 0-5 vs 0-10
// 达 100% 却是正常仪器差异）；中心偏移超过一个标准跨度则基本可判定错位/串行（如 MCHC
// 125-350 vs 316-354 中心偏移 2.5 个跨度）。单点范围（无跨度）回退到端点相对差异。
function refDiffMetrics(stdRef, reportRef) {
  const stdSpan = stdRef.high != null && stdRef.low != null && stdRef.high > stdRef.low ? stdRef.high - stdRef.low : null
  const reportSpan = reportRef.high != null && reportRef.low != null && reportRef.high > reportRef.low ? reportRef.high - reportRef.low : null
  const stdCenter = stdSpan != null ? (stdRef.high + stdRef.low) / 2 : null
  const reportCenter = reportSpan != null ? (reportRef.high + reportRef.low) / 2 : null
  const centerDiffRatio = stdSpan != null && reportCenter != null ? Math.abs(reportCenter - stdCenter) / stdSpan : null
  let maxRelDiff = 0
  if (stdRef.high != null && reportRef.high != null && stdRef.high !== 0) {
    maxRelDiff = Math.max(maxRelDiff, Math.abs(reportRef.high - stdRef.high) / Math.abs(stdRef.high))
  }
  if (stdRef.low != null && reportRef.low != null && stdRef.low !== 0) {
    maxRelDiff = Math.max(maxRelDiff, Math.abs(reportRef.low - stdRef.low) / Math.abs(stdRef.low))
  }
  return { centerDiffRatio, maxRelDiff }
}

// ===== 多维识别审计（标准档案校验）=====
// 借助「标准代码 ↔ 标准名称/单位/参考范围」绑定档案（FIELD_BY_CODE），
// 对单个数据点做校验，产出审计结果（由调用方挂到 _audit，下划线字段不进导出）：
//   名称维度   name: 'exact'（标准名或可信别名原话）| 'variant'（名称与标准名不一致）
//             | 'reversed'（名称/代码识别错误，已按数值+参考范围反推修正）
//             nameFixed: 是否已回填标准名（变体收敛 / 乱码修复 / 反推修正）
//   单位维度   unit: 'ok' | 'fixed'（写法变体已自动归一）| 'mismatch'（与标准单位内容不符）
//   参考范围维度 ref: 'ok' | 'near'（差异 30%~100%，可能仪器标准不同）| 'mismatch'（>100%，串行/错误强提示）
//   反推维度   codeReversed: 是否通过「数值+参考范围」反推修正了代码（值+范围锁定项目）
//             codeReversedFrom: 反推前的原代码
// 判定原则：数值不自动改写；单位写法变体（10°9/L→10^9/L）自动归一；
// 单位内容/参考范围不符仅提示并给出标准候选，由用户确认后修正。
export function auditPoint(p, opts = {}) {
  const field = p && p.standard_code ? FIELD_BY_CODE[p.standard_code] : null
  const audit = {
    name: 'other',
    nameFixed: false,
    nameMiss: false, // 项目名未匹配到任何标准字段（OCR 把指标名认错/漏字），权重最高
    codeReversed: !!opts.codeReversed, // 是否通过「数值+参考范围」反推修正了代码
    codeReversedFrom: opts.codeReversedFrom || null,
    reverseHint: opts.reverseHint || null,
    // 反推建议的目标字段：仅在「检测到矛盾但未自动改判」时给出（如名字优先护栏拦下的跨行错配），
    // 供 UI 展示「反推指向 X」并提供「改判为此项」操作，把已知结论交还给用户确认。
    suggestCode: opts.suggestCode || null,
    suggestName: opts.suggestName || null,
    unit: 'ok',
    unitHint: null,
    ref: 'ok',
    refHint: null,
  }
  if (!p) return audit

  // ---- 名称维度 ----
  if (field) {
    const stdName = String(field.name).replace(/\s+/g, '')
    const dispName = String(p.original_name || '').replace(/\s+/g, '')
    if (opts.codeReversed) audit.name = 'reversed' // 名称/代码识别错误，已按数值+参考范围反推修正
    else if (dispName === stdName) audit.name = 'exact'
    else if (mapAlias(dispName) === p.standard_code) audit.name = 'exact' // 可信别名原话（如「中性细胞比率」）
    else audit.name = 'variant'
    audit.nameFixed = !!(opts.nameFixed && dispName === stdName) || !!opts.codeReversed
  } else {
    // 无标准字段匹配：项目名未被字典识别（OCR 错认/漏字/乱码），这是最严重的识别错误
    audit.nameMiss = true
  }

  // ---- 单位维度 ----
  if (field && field.unit) {
    const raw = String(opts.rawUnit != null ? opts.rawUnit : p.unit || '').trim()
    const reportUnit = normalizeUnit(raw)
    const stdUnit = normalizeUnit(field.unit)
    if (!reportUnit) {
      audit.unit = 'ok' // 报告无单位列，已回填字典单位
    } else if (reportUnit.toLowerCase() === stdUnit.toLowerCase()) {
      // 写法变体自动归一（如 10°9/L → 10^9/L）
      audit.unit = raw && raw.toLowerCase() !== reportUnit.toLowerCase() ? 'fixed' : 'ok'
      if (audit.unit === 'fixed') audit.unitHint = `单位写法已自动归一（${raw} → ${stdUnit}）`
    } else if (unitsEquivalent(p.standard_code, raw, field.unit)) {
      // 合法等效单位（如 Lp(a) nmol/L ≡ mg/L）：写法虽不同但语义正确，不判 mismatch
      audit.unit = 'ok'
      audit.unitHint = `单位 ${raw} 与标准 ${stdUnit} 属等效单位（同一项目不同计量体系）`
    } else {
      // OCR 噪声单位（410^9/L→10^9/L、9/L→10^9/L）：语义同标准单位，只是被 OCR 误读，
      // 应视为「已自动归一修正」而非内容不符，避免误判成 mismatch/严重质量扣分。
      const ocrNoise = unitOcrNoise(raw, field.unit)
      if (ocrNoise) {
        audit.unit = 'fixed'
        audit.unitHint = `单位疑似 OCR 误读，已修正（${raw} → ${stdUnit}）`
      } else {
        audit.unit = 'mismatch'
        audit.unitHint = `单位与标准不符（标准：${field.unit}）`
      }
    }
  } else if (field && !field.unit) {
    // 标准项目无单位（如比值类 白球比 AG）：解析出单位属误带，应提示而非静默通过
    const rawU = String(p.unit || '').trim()
    if (rawU) {
      audit.unit = 'mismatch'
      audit.unitHint = `标准项目无单位，解析出单位「${rawU}」可能误带，建议清空`
    }
  }

  // ---- 参考范围维度（判定以报告自带参考范围为准，差异分档提示）----
  if (field && field.ref) {
    // 参考范围校验目标：报告单位命中某等效计量体系时，用「该体系自身标准参考范围」比对，
    // 而非字典主参考范围（不同体系参考范围天然不同，如 CK-MB 酶法 0-25 vs 化学发光法 0-5.6）；
    // 否则用字典主参考范围比对。这样既放行同体系内的合法差异，也能抓住「同单位体系但参考范围填错」的真错误。
    const raw = String(opts.rawUnit != null ? opts.rawUnit : p.unit || '').trim()
    const equivExpectedRef = raw ? equivUnitExpectedRef(p.standard_code, raw) : null
    const targetRef = equivExpectedRef || field.ref
    const stdRef = parseRefRange(targetRef)
    const reportRef = parseRefRange(p.ref_range)
    if (stdRef && reportRef) {
      const { centerDiffRatio, maxRelDiff } = refDiffMetrics(stdRef, reportRef)
      const refKind = equivExpectedRef ? `${raw} 体系标准` : '标准'
      if (centerDiffRatio != null && centerDiffRatio > 1.0) {
        audit.ref = 'mismatch'
        audit.refHint = `参考范围与${refKind}不符（${refKind}：${targetRef}）`
      } else if (centerDiffRatio != null && centerDiffRatio > 0.3) {
        audit.ref = 'near'
        audit.refHint = `参考范围与${refKind}差异较大，可能为仪器标准不同（${refKind}：${targetRef}）`
      } else if (centerDiffRatio == null && maxRelDiff > 1.0) {
        audit.ref = 'mismatch'
        audit.refHint = `参考范围与${refKind}不符（${refKind}：${targetRef}）`
      } else if (centerDiffRatio == null && maxRelDiff > 0.5) {
        audit.ref = 'near'
        audit.refHint = `参考范围与${refKind}差异较大，可能为仪器标准不同（${refKind}：${targetRef}）`
      }
    }
  }
  return audit
}

// 低风险单位补全：报告单位仅比标准单位少「/L」后缀（如 mmol→mmol/L、g→g/L、mg→mg/L）。
// 属同一单位的漏写，确定性高，可自动修正；区别于 mmol↔mg/L 这类不同质单位（后者只提示）。
export function isMissingPerL(reportUnit, stdUnit) {
  const r = String(reportUnit || '').replace(/\s+/g, '').toLowerCase()
  const s = String(stdUnit || '').replace(/\s+/g, '').toLowerCase()
  if (!r || !s) return false
  return s === r + '/l'
}

// ===== 修复建议产出（自动修复 / 一键确认共用）=====
// 对每个数据点产出「修复建议」。维度含置信度：
//   conf: 'auto'   高确定性，清洗阶段自动应用（缺省补全 / 符号变体 / 低风险补全 / 误带清空）
//   conf: 'manual' 低确定性，仅提示，交「一键修正全部可疑项」批量确认
// 返回 null 表示无需修复。
export function buildFixSuggestion(p) {
  const field = p && p.standard_code ? FIELD_BY_CODE[p.standard_code] : null
  if (!field) return null
  const reportUnit = normalizeUnit(p.unit || '')
  const stdUnit = normalizeUnit(field.unit || '')
  const sug = { unit: undefined, unitConf: null, ref: undefined, refConf: null, value: undefined, valueConf: null }

  // ---- 单位 ----
  if (field.unit) {
    if (!reportUnit) {
      sug.unit = field.unit
      sug.unitConf = 'auto'
    } else if (reportUnit.toLowerCase() === stdUnit.toLowerCase() || unitsEquivalent(p.standard_code, p.unit, field.unit)) {
      // 一致，或合法等效单位（如 Lp(a) nmol/L ≡ mg/L），无需建议
    } else if (unitOcrNoise(p.unit, field.unit)) {
      sug.unit = field.unit
      sug.unitConf = 'auto'
    } else if (isMissingPerL(reportUnit, stdUnit)) {
      sug.unit = field.unit
      sug.unitConf = 'auto'
    } else {
      // 不同质（如 mmol↔mg/L），只提示，待一键确认
      sug.unit = field.unit
      sug.unitConf = 'manual'
    }
  } else if (reportUnit) {
    // 标准无单位却误带单位（如比值类白球比误带 umol/L）→ 清空
    sug.unit = ''
    sug.unitConf = 'auto'
  }

  // ---- 参考范围 ----
  if (field.ref) {
    if (!p.ref_range) {
      sug.ref = field.ref
      sug.refConf = 'auto'
    } else {
      // 报告单位命中某等效计量体系时，用该体系自身标准参考范围作比对目标（而非字典主参考范围）；
      // 同体系内差异视为合法、不修正；同一单位体系却把参考范围填错时，建议修正为该体系的标准值。
      const equivExpectedRef = unitsEquivalent(p.standard_code, p.unit, field.unit)
        ? equivUnitExpectedRef(p.standard_code, p.unit)
        : null
      const targetRef = equivExpectedRef || field.ref
      const stdRef = parseRefRange(targetRef)
      const repRef = parseRefRange(p.ref_range)
      const diff = stdRef && repRef ? refDiffMetrics(stdRef, repRef) : null
      const mismatch =
        diff &&
        ((diff.centerDiffRatio != null && diff.centerDiffRatio > 0.3) ||
          (diff.centerDiffRatio == null && diff.maxRelDiff > 0.5))
      if (mismatch) {
        sug.ref = targetRef
        sug.refConf = 'manual'
      }
    }
  }

  // ---- 数值维度：永不建议修改 ----
  // 值越界（真实异常值）≠ 识别错误；用户的值本来就可能是异常的（如 PLT 24 低于
  // 参考范围 125-350）。因此数值绝不通过「一键修正」改写——无论该行是否被用户手动
  // 编辑过（_valueEdited 仍保留，用于让已编辑行连 _suspicious 红标都不再提示）。
  // _fix 候选仅用于 UI 展示「疑似错位」原因与人工核对（见 bugs.md Bug 031）。

  if (sug.unit !== undefined || sug.ref !== undefined) return sug
  return null
}

// ===== 确定值反推（数值 + 参考范围 + 单位锁定项目）=====
// 借助「标准档案」：项目的参考范围相对固定。若报告某行「数值 + 参考范围」与某个字段
// 的档案高度吻合且唯一，即使项目名称/缩写被 OCR 读错，也能反推出真实字段。
// 例：MCHC 行被误识别为 HS_CRP，但值 328 + 参考范围 316-354 与 MCHC 档案（316-354）
// 精确吻合且唯一 → 反推 MCHC，从而修正错误代码，并用正确档案校验（不再误报参考范围）。
// 返回 { code, name, ratio, inRange } 或 null（无候选 / 歧义无法唯一确定）。
//   ratio：报告参考范围中心相对标准跨度的偏移（≤0.05 为强吻合，≤0.3 为弱吻合）
//   inRange：数值落在报告参考范围内（值+范围双重吻合，反推可信度高）
export function matchFieldByValueRef(value, ref, unit) {
  if (value == null || String(value).trim() === '' || !ref) return null
  const reportRef = parseRefRange(ref)
  if (!reportRef || (reportRef.low == null && reportRef.high == null)) return null
  const v = parseFloat(value)
  const vNum = !Number.isNaN(v)
  const hits = []
  for (const f of Object.values(FIELD_BY_CODE)) {
    const stdRef = parseRefRange(f.ref)
    if (!stdRef || (stdRef.low == null && stdRef.high == null)) continue
    const { centerDiffRatio, maxRelDiff } = refDiffMetrics(stdRef, reportRef)
    const ratio = centerDiffRatio != null ? centerDiffRatio : maxRelDiff
    if (ratio == null || ratio > 0.3) continue
    const inRange = vNum && (reportRef.low == null || v >= reportRef.low) && (reportRef.high == null || v <= reportRef.high)
    // 单位维度：报告自带单位与该候选字段档案单位是否吻合（含 OCR 噪声变体归一，如 410^9/L→10^9/L）。
    // 供「跨行错配」判定使用：unit + ref 双列同时吻合的证据强于孤立的项目名。
    // 报告未带单位时返回 null（该维度不可用），不参与判定——避免误判「串行行无单位」的情形。
    const unitMatch = (() => {
      const stdUnit = normalizeUnit(f.unit || '')
      const repUnit = normalizeUnit(unit || '')
      if (!stdUnit || !repUnit) return null
      if (repUnit.toLowerCase() === stdUnit.toLowerCase()) return true
      if (unitsEquivalent(f.code, unit, f.unit)) return true
      return unitOcrNoise(unit, f.unit) ? true : false
    })()
    hits.push({ code: f.code, name: f.name, ratio, maxRelDiff, inRange, unitMatch })
  }
  if (!hits.length) return null
  hits.sort((a, b) => a.ratio - b.ratio)
  // 强吻合：报告参考范围中心相对标准跨度偏移 ≤5%（ref 基本一致，如 MCHC 316-354 精确吻合），
  // 且端点相对偏差 ≤30%（排除「中心接近但端点/跨度不同」的假并列，如 RDW_CV 0-15 与
  // IBIL 1.7-13.7 中心仅差 0.2 但 low 端点差 100%，会被 centerDiff 误判为强吻合并列）。
  // 只信「强吻合」候选：PA（200-430）对 316-354 中心偏移 8.7%，虽在 0.3 内但不足锁定，
  // 若采用「差值并列」判断会被误判为并列而干扰唯一性，故弱吻合仅作参考、不参与反推。
  // 强吻合阈值：中心偏移 ≤5% 且端点相对偏差 ≤10%（收紧自 0.3）。
  // 过宽会把「中心相同但跨度不同」的范围误判为同字段并列，如 WBC(3.5-9.5) 与
  // MONO_PCT(3-10) 中心同=6.5、但 low 端点差 14%，应排除而非并列。
  const strong = hits.filter((h) => h.ratio <= 0.05 && (h.maxRelDiff == null || h.maxRelDiff <= 0.1))
  if (!strong.length) return null // 无精确吻合 → 不足以反推（宁可不改）
  if (strong.length === 1) return strong[0]
  // 多个强吻合（如 HS_CRP/FDP 同为 0-5）：仅当报告自带单位能唯一区分
  // （mg/L → HS_CRP，ug/ml → FDP）时才采纳，否则放弃反推（宁可不改）。
  if (unit) {
    const un = normalizeUnit(unit).toLowerCase().replace(/\s+/g, '')
    const uniq = strong.filter(
      (h) => normalizeUnit(FIELD_BY_CODE[h.code].unit || '').toLowerCase().replace(/\s+/g, '') === un
    )
    if (uniq.length === 1) return uniq[0]
  }
  return null
}

// 仅按数值匹配字段：当 name 乱码且报告 ref 串行（反推的 reportRef 通道失效）时，
// 直接看 value 落在哪个标准字段的字典 ref 范围内（唯一落点）来定 code。
// 双栏不对齐导致 value 落错行、ref 被串行时，此通道能从数值本身恢复正确 code。
// 保守：要求「唯一」落点；多字段范围重叠（如 3.9 同时可能在多个范围）则放弃。
export function matchFieldByValueOnly(value) {
  const v = parseFloat(value)
  if (Number.isNaN(v)) return null
  const hits = []
  for (const f of Object.values(FIELD_BY_CODE)) {
    const stdRef = parseRefRange(f.ref)
    if (!stdRef || (stdRef.low == null && stdRef.high == null)) continue
    const lo = stdRef.low ?? -Infinity
    const hi = stdRef.high ?? Infinity
    if (v >= lo && v <= hi) hits.push(f.code)
  }
  if (hits.length === 1) return hits[0]
  return null
}


// 反推决策：把当前识别结果与「确定值反推」交叉验证。
// 返回 { code, codeReversed, reverseFrom, reverseReason, confirmed, hint }：
//   - code：最终代码（发生反推修正时为新代码）
//   - codeReversed：是否通过数值+参考范围反推修正了代码
//   - confirmed：识别与反推一致 → 强确认（识别确定正确，不再标问题）
//   - hint：反推指向其他字段但值不在其范围内时（更可能是参考范围列串行）的提示
// 决策规则（保守，宁可不改不错改）：
//   · 当前 code 与反推一致 → 确认无误（confirmed），不修正不提示
//   · code 为空（未识别）→ 反推唯一且值在报告范围内 → 自动识别
//   · code 与报告参考范围严重矛盾（中心偏移 >1 个标准跨度，即审计 mismatch）
//     且反推唯一、值在报告范围内 → 名称/代码识别错误（如 MCHC 被读成 HS_CRP）
//     → 自动修正代码，并用正确档案审计（避免「参考范围正确却标有问题」的误报）
//   · 其余情况（当前 code 与报告仅 normal/near 差异，如 hs-CRP 0-10 vs 0-5 属仪器
//     标准不同）→ 不修正不提示，避免把正常差异误判为别的项目
//   · 反推指向其他字段但值不在其范围内 → 更可能是参考范围列串行而非名称错 → 仅提示核对
export function reverseFieldMatch(code, p) {
  const value = p && p.value
  const ref = p && p.ref_range
  if (value == null || String(value).trim() === '' || !ref) {
    return { code, codeReversed: false, confirmed: false, hint: null }
  }
  const reversed = matchFieldByValueRef(value, ref, p && p.unit)
  if (!reversed) return { code, codeReversed: false, confirmed: false, hint: null }
  // 名字能否明确映射到标准字段（与 clean.js 填充通道 mapAlias/变体 同源）。
  // 能映射时不凭参考范围反推成别的字段，避免「甘油三酯」因 ref 碰巧吻合 CK_MB 而被误改。
  const nameRaw = p && p.original_name
  const nameCode = nameRaw ? (mapAlias(nameRaw) || (matchDroppedCharVariant(nameRaw) || {}).code || '') : ''
  if (code && reversed.code === code) {
    // 识别与「确定值反推」一致 → 强确认（值+参考范围锁定该字段，识别确定正确）
    return { code, codeReversed: false, confirmed: true, hint: null }
  }
  const reportRef = parseRefRange(ref)
  const curBad = (() => {
    if (!code || !reportRef) return false
    const f = FIELD_BY_CODE[code]
    if (!f || !f.ref) return false
    const stdRef = parseRefRange(f.ref)
    if (!stdRef) return false
    const { centerDiffRatio, maxRelDiff } = refDiffMetrics(stdRef, reportRef)
    const refMismatch = centerDiffRatio != null ? centerDiffRatio > 1.0 : maxRelDiff > 1.0
    // 额外维度：当前识别的 code 其 value 既不在报告 ref、也不在字典 ref 范围内
    // （双栏串行常使 value 落错行，如「(ALP)」行 value=344 实为 HBDH，344 不在 ALP 范围）→
    // 允许确定值反推介入纠正。仍要求反推候选 value 在其范围内才生效（见下方 reversed.inRange），避免误救。
    const v = parseFloat(value)
    const inReport = !Number.isNaN(v) && v >= (reportRef.low ?? -Infinity) && v <= (reportRef.high ?? Infinity)
    const inStd = !Number.isNaN(v) && stdRef && v >= (stdRef.low ?? -Infinity) && v <= (stdRef.high ?? Infinity)
    const valueOut = !(inReport || inStd)
    return refMismatch || valueOut
  })()
  const target = `「${reversed.name}（${reversed.code}）」`
  if (!code) {
    // 名字已明确映射到某字段，但与反推字段不同 → 信任清晰项目名，不凭参考范围反推成别的字段
    if (nameCode && nameCode !== reversed.code) {
      return { code: nameCode, codeReversed: false, confirmed: true, hint: null }
    }
    // 未识别（项目名丢失/残字）：已无可对照 code，「项目名读错」远常见于「参考范围串行」。
    // 但项目名为单字/符号噪声（如 ⭐ 异常标记被 OCR 读成「玄」）时：单字无法可靠对应标准字段，
    // 且常与相邻真实项（如 WBC）同行共享 value/ref，反推会误救成重复项。故视为噪声，不反推，
    // 保持 other（非标准项），交由人工/数值维度处理，避免重复计数。
    if (!p.original_name || [...p.original_name].length <= 1) {
      return { code, codeReversed: false, confirmed: false, hint: null }
    }
    // 参考范围强吻合且唯一即反推，值是否越界只作提示、不拒绝反推
    // （越界往往是真实偏高，如 WBC 16 超 3.5-9.5 上限）。
    return {
      code: reversed.code,
      codeReversed: true,
      reverseFrom: '',
      reverseReason: `参考范围 ${ref} 与${target}标准档案吻合（项目名未识别），已按确定值反推修正${reversed.inRange ? '' : `；数值 ${value} 超出参考范围，请核对`}`,
      confirmed: reversed.inRange,
    }
  }
  if (curBad) {
    // 注：「跨行错配」（整行 value/unit/ref 来自邻行、项目名是串行的那个）不在本函数处理。
    // 单点无法区分「名字串行」与「其余列串行」——两者形式完全相同（如「血红蛋白 + Cr 的
    // 单位/参考范围」与「红细胞计数 + PLT 的三列」），仅凭本行数据必然误判，这正是
    // 「名字优先」护栏存在的理由。改由 resolveByMultiSignal 的重复行阶段判定：那里能看到
    // 同报告内 code 的占用情况（当前 code 是否已被其它行占用、目标 code 是否空着），
    // 判据比单点可靠得多，且只在重复行上生效，不会误伤清晰项目名。
    // 名字与参考范围相互矛盾时，更可能是参考范围列串行而非名称错，
    // 信任清晰项目名、不自动反推；但把反推结论一并交还，供 UI 提示与用户一键改判。
    if (nameCode && nameCode !== reversed.code) {
      return {
        code,
        codeReversed: false,
        confirmed: true,
        hint: `项目名「${nameRaw}」指向${FIELD_BY_CODE[nameCode]?.name || nameCode}，与参考范围 ${ref} 吻合的${target}不一致，未自动反推，请核对参考范围是否串行`,
        suggestedCode: reversed.code,
        suggestedName: reversed.name,
      }
    }
    if (reversed.inRange) {
      return {
        code: reversed.code,
        codeReversed: true,
        reverseFrom: code || '',
        reverseReason: `数值 ${value} 与参考范围 ${ref} 与${target}标准档案吻合（原识别：${code ? FIELD_BY_CODE[code]?.name || code : '未识别'}），已按确定值反推修正`,
        confirmed: true,
      }
    }
    // 反推字段吻合但值不在其范围内（报告 ref 串行嫌疑）→ 再试「仅按数值匹配字段」通道：
    // 当 name 乱码且报告 ref 不可信时，用 value 本身落在哪个标准字段字典 ref 范围内（唯一落点）定 code。
    const vo = matchFieldByValueOnly(value)
    if (vo && vo !== code) {
      return {
        code: vo,
        codeReversed: true,
        reverseFrom: code || '',
        reverseReason: `数值 ${value} 落在${FIELD_BY_CODE[vo]?.name || vo}标准参考范围内（原识别：${code ? FIELD_BY_CODE[code]?.name || code : '未识别'}，报告参考范围串行不可信），已按数值反推修正`,
        confirmed: true,
      }
    }
    // 反推字段吻合但值不在其范围内 → 参考范围列串行嫌疑更大，提示不自动改
    return {
      code,
      codeReversed: false,
      confirmed: false,
      hint: `数值 ${value} 与参考范围 ${ref} 指向${target}，当前识别为${code ? `「${FIELD_BY_CODE[code]?.name || code}」` : '未识别'}，请核对`,
      suggestedCode: reversed.code,
      suggestedName: reversed.name,
    }
  }
  return { code, codeReversed: false, confirmed: false, hint: null }
}

// 聚合一组数据点的审计统计：供识别完成页 / 清洗页展示「自动修正 / 提示 / 疑错」摘要
// 反推修正（codeReversed）计入自动修正：数值+参考范围锁定项目，识别错误已修正
export function summarizeAudit(points) {
  const s = { nameFixed: 0, codeReversed: 0, unitFixed: 0, unitMismatch: 0, refNear: 0, refMismatch: 0, suspicious: 0, nameMiss: 0 }
  for (const p of points || []) {
    const a = p && p._audit
    if (!a) continue
    if (a.nameFixed) s.nameFixed++
    if (a.codeReversed) s.codeReversed++
    if (a.unit === 'fixed') s.unitFixed++
    if (a.unit === 'mismatch') s.unitMismatch++
    if (a.ref === 'near') s.refNear++
    if (a.ref === 'mismatch') s.refMismatch++
    if (a.nameMiss) s.nameMiss++
    if (p._suspicious) s.suspicious++
  }
  // ---- 序号维度（Step2）：序号来源置信度/连续性进入质量评分 ----
  const seq = inferSequenceIssues(points)
  const total = (points || []).length || 1
  // 参考权重：每跳号扣 5/100（疑似漏项一行，封顶 30/100），置信度低扣 10/100（仅报告自带序号但识别不全时）。
  // seq.hasSeq 为 false（报告本无序号、全部 inferred 兜底）时，序号维度不构成惩罚，避免无序号报告被误伤。
  const seqPenalty =
    (seq.missingNos.length > 0 ? Math.min(seq.missingNos.length * 0.05, 0.3) : 0) +
    (seq.hasSeq && seq.detectedRatio < 0.6 && total > 5 ? 0.1 : 0)
  // 识别质量评分（0-1）：用于「识别-审计-重识别」闭环决策。
  // 规则：全部行 name/unit/ref 通过且无 suspicious → 1.0；
  //       项目名未命中字典（nameMiss）权重最高（指标名错认 → 整行无意义），其次 suspicious；
  //       序号维度（seqPenalty）叠加作为轻量惩罚。
  const bad = s.nameMiss * 3 + s.unitMismatch + s.refNear + s.refMismatch + s.suspicious * 2
  const qualityScore = Math.max(0, 1 - bad / total - seqPenalty)
  // 置信度标签：供 UI 展示
  let confidence = 'high'
  if (qualityScore < 0.7) confidence = 'low'
  else if (qualityScore < 0.9) confidence = 'medium'
  return { ...s, total, qualityScore, confidence, seq }
}

// ===== 序号维度推理（Step1）=====
// 基于报告自带的序号（_item_no_src === 'detected'）做连续性与置信度判断。
// 全报告序号语义为连续 1..N；报告若自带序号，detected 序号理论上应连续。
// 跳号 → 中间序号的对应行漏识别（疑似漏项）；detected 占比低 → 序号多靠推理补全，维度可信度低。
// 返回 { missingNos, detectedRatio, totalInferred, hasSeq }
//   missingNos：detected 序号首尾之间缺失的整数（如 [3,5]）
//   detectedRatio：明确识别序号占全部有效点位比例（0~1）
//   totalInferred：推理/自动补全的序号数量
//   hasSeq：报告是否自带序号（detectedCount>0；全部 inferred 视为「报告本无序号」的正常兜底，不算失败）
export function inferSequenceIssues(points) {
  const validPoints = (points || []).filter((p) => p && p._item_no !== undefined && p._item_no !== null)
  if (validPoints.length === 0) return { missingNos: [], detectedRatio: 1, totalInferred: 0, hasSeq: false }

  const detectedNos = validPoints
    .filter((p) => p._item_no_src === 'detected')
    .map((p) => Number(p._item_no))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)

  // 寻找跳号（基于 detected 最小-最大范围）
  const missingNos = []
  if (detectedNos.length > 1) {
    const detectedSet = new Set(detectedNos)
    for (let i = detectedNos[0]; i <= detectedNos[detectedNos.length - 1]; i++) {
      if (!detectedSet.has(i)) missingNos.push(i)
    }
  }

  const totalPoints = validPoints.length
  const detectedCount = detectedNos.length
  const detectedRatio = totalPoints > 0 ? detectedCount / totalPoints : 1
  const totalInferred = totalPoints - detectedCount
  const hasSeq = detectedCount > 0

  return { missingNos, detectedRatio, totalInferred, hasSeq }
}

// 识别诊断契约：把散落在各 point 的「静默失败 / 不确定」信号收敛成统一 issues[]，
// 供 ImportFlow 统一渲染（替换原 dateEvents 黄条）。仅暴露、绝不自动改写（见 Bug 031 红线）。
// 每项聚合为单条，避免噪声刷屏：{ code, level: 'error'|'warn'|'info', message }
export function collectRecognizeIssues(points) {
  const issues = []
  if (!points || !points.length) return issues

  // 1) 未映射项：OCR 认出但字典无对应 standard_code 的行——可能是真项目被漏，也可能纯噪声
  const unmapped = points.filter((p) => !p.standard_code)
  if (unmapped.length) {
    const names = unmapped.map((p) => p.original_name || p.name).filter(Boolean).slice(0, 5)
    issues.push({
      code: 'unmapped_item',
      level: 'warn',
      message: `有 ${unmapped.length} 个指标未能匹配到字典${names.length ? `（如：${names.join('、')}）` : ''}，请核对是否为有效检验项`,
    })
  }

  // 2) 序号跳号：报告自带序号但中间缺失（疑似漏识别一行）
  const seq = inferSequenceIssues(points)
  if (seq.missingNos && seq.missingNos.length) {
    issues.push({
      code: 'seq_gap',
      level: 'warn',
      message: `项目序号缺失（#${seq.missingNos.join('、#')}），疑似对应行漏识别，请核对`,
    })
  }

  // 3) 可疑值：数值疑似错位/异常（仅提示，绝不自动改写，见 Bug 031）
  const suspect = points.filter((p) => p._suspicious)
  if (suspect.length) {
    const names = suspect.map((p) => p.original_name || p.name).filter(Boolean).slice(0, 5)
    issues.push({
      code: 'suspect_value',
      level: 'warn',
      message: `有 ${suspect.length} 个指标数值疑似错位/异常${names.length ? `（${names.join('、')}）` : ''}，请核对`,
    })
  }

  // 4) 多信号纠正：项目被自动重新归类（用户应知情）
  const corrected = points.filter((p) => p._multiSignal && p._multiSignal.corrected)
  if (corrected.length) {
    const names = corrected
      .map((p) => `${p.original_name || p.name || ''}→${p._multiSignal.to}`)
      .filter(Boolean)
      .slice(0, 5)
    issues.push({
      code: 'code_corrected',
      level: 'info',
      message: `有 ${corrected.length} 个项目已按多信号自动重新归类${names.length ? `（${names.join('、')}）` : ''}，请核对`,
    })
  }

  // 5) 整体低置信度：审计分偏低（多为项目名未命中字典）
  const audit = summarizeAudit(points)
  if (audit.qualityScore < 0.6 && audit.nameMiss > 0) {
    issues.push({
      code: 'low_confidence',
      level: 'warn',
      message: `整体识别置信度偏低（质量分 ${Math.round(audit.qualityScore * 100)}%），有 ${audit.nameMiss} 个指标名未命中字典，请重点核对`,
    })
  }

  return issues
}

// 提取项目序号（项目数字识别）：部分化验单会在项目名前带序号，如「1 白细胞」「2 中性细胞」、
// 「1.白细胞计数」「3、血小板」。取开头 1-2 位整数作为该项目的识别序号；无序号返回 null（由
// normalizeGridToPoints 按识别顺序自动按序填充）。
// 判定保守：序号后必须紧跟「空白或标点分隔」（空格 / . 、 , ： : ) ），避免把检测名开头的数字
// 误判成序号（如「25-羟维生素D」后跟 -、化学式「2h-PG」后跟字母）。连续写法「1白细胞」
// 虽不识别，也由自动按序填充兜底，保证顺序一致。
function extractItemNo(rawName) {
  if (!rawName) return null
  const m = String(rawName).trim().match(/^(\d{1,2})(?:[\s.、,、:：)）]+)/)
  return m ? Number(m[1]) : null
}

// 将 OCR 网格转为数据点（自动识别表头列 + 别名映射 + 多栏拆分）
// rowIdx：与 grid 行一一对应的原始识别行号（双栏拆分后用于还原原图上下交错顺序），缺省为行索引自身
export function normalizeGridToPoints(grid, reportType, rowIdx = null) {
  const pts = buildGridPoints(grid, reportType, rowIdx)
  // 项目序号兜底：报告未带序号的项按识别顺序自动按序填充（1、2、3…）。
  // 必须在最终合并结果上执行一次（多栏拆分各子网格内部不各自填充，避免左右栏序号重复）。
  autoFillItemNo(pts)
  resolveByMultiSignal(pts, reportType)
  // 融合基因定量行：报告常写「拷贝数/对照拷贝数=百分比」（如 0/793000=0%、3.2/793000=0.0004%）。
  // 指标值只取百分比，拷贝数另存副本字段供追溯——否则校对网格里显示的是整串复合写法。
  for (const p of pts) {
    if (!p.standard_code || !/_PCT$/.test(p.standard_code)) continue
    const raw = String(p.value == null ? '' : p.value).trim()
    const m = /^([\d.]+)\s*\/\s*([\d.]+)\s*=\s*([\d.]+)\s*%?$/.exec(raw)
    if (m) {
      p._copies = m[1]
      p._controlCopies = m[2]
      p.value = m[3]
      continue
    }
    // OCR 常把「0/793000=0%」读成「0779300F 0」「0/793000-0%」等：对这类 a/b=c% 写法，
    // 取最后一个数字当百分比、前两个当拷贝数/对照拷贝数（不猜也不改数值大小）。
    const nums = raw.match(/\d+(?:\.\d+)?/g) || []
    if (nums.length >= 2) {
      p._copies = nums[0]
      p._controlCopies = nums[1]
      p.value = nums[nums.length - 1]
    }
  }

  // 清理仍未识别的 gap 候选（乱码数值行，value+ref 反推/占用排除均未命中）：
  // 这些行不是检验项目（如标本条码号误入网格），残留会以 NORMAL 状态污染 UI 与入库数据。
  // 兜底清理（回归自旧 gapFillCBC 的移除逻辑，resolveByMultiSignal 替代时曾丢失）
  for (let i = pts.length - 1; i >= 0; i--) {
    if (!pts[i].standard_code && pts[i]._gapCandidate) pts.splice(i, 1)
  }
  return filterOffTypeNoise(pts)
}

// 血常规报告允许出现的检测组：血常规本体 + 常与血常规联合开单的超敏C反应蛋白。
// 用于剔除 OCR 把页眉/页脚/图表分析区误读成数据行而混入的「肝功/肾功/血脂/尿常规/凝血/离子」等指标
// （见 bugs.md Bug 020/058 与用户反馈 TR-20260904-6ROCOF：血常规报告被识别成血常规+肝功+肾+尿混合）。
const CBC_ALLOWED_GROUPS = new Set(['血常规', '炎症指标'])

// 剔除「明确不属于本报告主体类型」的混入指标（类型组黑名单）。
// 为什么用黑名单而非白名单：血常规长尾项极多（NRBC_ABS/RDW_CV/P_LCR/PCT/RET…），
// 用 REPORT_TYPES.keyFields 白名单会误杀这些真项目；而混入的噪声项（PA/UA/UPH/GGT/TG/P/TT…）
// 在字典里 group 归属明确（肝功能/肾功能/尿常规/血脂/离子/凝血），按 group 黑名单删可精确命中且不误伤。
// 触发条件（保守，双向防误杀）：
//   ① 血常规组指标 ≥5 项（真实血常规报告不会低于此）；
//   ② 血常规组指标数 > 其它组指标数 × 2（血常规占绝对多数，即 ≥2/3）。
// 生化/肝功等报告血常规项本就极少（<5），天然不满足 ①，不受影响。
// 未映射 code 或无 group 的项（字典新加字段等）一律保留，避免过滤逻辑比识别逻辑更激进。
export function filterOffTypeNoise(points) {
  if (!points || points.length === 0) return points
  const groupCount = new Map()
  for (const p of points) {
    const f = p.standard_code ? FIELD_BY_CODE[p.standard_code] : null
    if (!f || !f.group) continue
    groupCount.set(f.group, (groupCount.get(f.group) || 0) + 1)
  }
  const cbcCount = groupCount.get('血常规') || 0
  let otherCount = 0
  for (const [g, n] of groupCount) {
    if (!CBC_ALLOWED_GROUPS.has(g)) otherCount += n
  }
  // 非血常规报告（血常规项不足）→ 原样返回，不做任何剔除
  if (cbcCount < 5) return points
  // 单发混入（仅 1 个非血常规项）：保守保留。理由：① 可能是报告上的真实边缘项，
  // 不该被武断删掉；② 删掉会改变该策略的 mapped 计数，间接影响多策略选优平衡
  // （实测 case-1788095314581：删 1 个 GGT 噪声后，verify 选优从 LYM_PCT=74.7 策略
  // 切到 LYM_PCT=18 策略，导致本该 PASS 的 case 退化）。≥2 项混入才判定为「被污染」并过滤，
  // 既能挡住用户核心场景（TR-20260904-6ROCOF 混入 GGT/PA/UA/UPH 共 4 项），又避免误伤单发情形。
  if (otherCount < 2) return points
  // 血常规项不占绝对多数（≤ 其它组项数的 2 倍）→ 原样返回
  if (cbcCount <= otherCount * 2) return points
  return points.filter((p) => {
    const f = p.standard_code ? FIELD_BY_CODE[p.standard_code] : null
    if (!f || !f.group) return true
    return CBC_ALLOWED_GROUPS.has(f.group)
  })
}

// normalizeGridToPoints 的解析主体（不含项目序号兜底；供多栏拆分递归复用）
function buildGridPoints(grid, reportType, rowIdx = null) {
  if (!grid || grid.length === 0) return []

  // 双栏/多栏化验单：按栏拆分后分别解析并合并（保证右栏数据不丢失）
  const subs = splitMultiColumnGrid(grid)
  if (subs) {
    return subs.flatMap((sub) => buildGridPoints(sub, reportType, rowIdx))
  }

  // 表头检测：找到包含「项目/名称」与「结果/数值」的行
  let headerIdx = -1
  let colMap = null // { name, result, unit, ref, arrow }
  for (let i = 0; i < grid.length && i < 6; i++) {
    const row = grid[i].map((c) => String(c || '').trim())
    const joined = row.join('')
    if (!joined) continue
    const hasName = /项目|名称|检测项目|指标|检验项目|化验项目/.test(joined)
    const hasResult = /结果|测定值|检测值|数值|检验结果/.test(joined)
    if (hasName && hasResult) {
      headerIdx = i
      const pick = (patterns) => {
        const idx = row.findIndex((c) => patterns.some((p) => c.includes(p)))
        return idx >= 0 ? idx : null
      }
      colMap = {
        name: pick(['项目', '名称', '指标', '检验项目']),
        result: pick(['结果', '数值', '测定值', '检测值']),
        unit: pick(['单位']),
        ref: pick(['参考范围', '参考区间', '参考值', '正常范围', '范围']),
        arrow: pick(['提示', '箭头', '标志', '标识', '备注']),
      }
      break
    }
  }

  // 找不到表头：退化为「第一行当表头 / 前两列为 项目+结果」
  if (colMap == null) {
    headerIdx = 0
    colMap = { name: 0, result: 1, unit: null, ref: null, arrow: null }
  }

  // 序号锚定（CBC_SEQUENCE）仅对含血常规字段的报告生效：只有报告里确实识别到 WBC/RBC/PLT 等
  // 血常规字段（按名称可映射到 CBC_SEQUENCE 中的项）时，才认为本报告遵循血常规顺序、允许序号锚定。
  // 贫血组合（铁蛋白/叶酸/维生素B12）、肝功、心电图等不含血常规字段的报告 → 一律禁用序号锚定，
  // 避免把第 2 项叶酸错配成中性粒细胞百分比，或把心电图指标错配成血常规。无需报告类型入参。
  let _cbcFieldCount = 0
  for (const r of grid) {
    const cells = r.map((c) => String(c || '').trim())
    const n = colMap && colMap.name != null ? cells[colMap.name] : ''
    const c = n ? mapAlias(n) : ''
    if (c && CBC_SEQUENCE.indexOf(c) >= 0) _cbcFieldCount++
  }
  const isCbcReport = _cbcFieldCount >= 1

  const points = []
  const seq = rowIdx || grid.map((_, i) => i)
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i].map((c) => String(c || '').trim())
    const joined = row.join('')
    if (!joined) continue
    // 双栏 name 乱码行的反推救回标记（name/abbr 全空时用 value+ref 反推 code）
    let _garbledReverse = null

    const rawName = colMap.name != null ? row[colMap.name] : ''
    // 过滤页眉/页脚中带完整日期的元信息行（如「报告时间: 2026-08-04 11:09」「…(CRP) 2026-08-04 10044」）：
    // 这类行含 4 位年日期，绝不是检验项目名，却会被其中的缩写（如 (CRP)）误配成数据行（见本会话 8141 报告）。
    if (/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/.test(rawName)) continue
    // 把「项目名称+缩写」拆成中文项目名与英文缩写：
    //   · 含中文的 token → 项目名（如「中性细胞比率」）
    //   · 纯英文且能被 mapAlias 匹配 → 缩写（如「NEUT%」，是 mapAlias 的可靠命中信号）
    //   · 纯英文/符号但无法映射 → OCR 乱码（如「i920」「%°F」「As」），丢弃
    // 显示用中文项目名（original_name），匹配仍用完整 rawName（含缩写，保证鲁棒命中）。
    const nameToks = []
    const abbrToks = []
    for (const t of rawName.split(/\s+/)) {
      if (/[\u4e00-\u9fa5]/.test(t)) nameToks.push(t)
      else if (mapAlias(t)) abbrToks.push(t)
    }
    let name = nameToks.join(' ')
    let abbr = abbrToks.join(' ')
    // 纯 ASCII 行名（「BCR-ABL1 P190/ABL1x100%」「HbA1c」「HbA1c(%)」等）：逐 token 查别名查不到，
    // 但整名命中别名表时是可靠信号——先按整名映射，避免被当成乱码行丢掉。
    // 2026-10-22 实测：白血病融合基因定量报告的第二行（定量行）整行丢失，只剩定性行。
    if (!name && !abbr) {
      // 先试「修形后的融合基因标准名」再退回原名：原名里带 OCR 残渣（如尾部多出的 BCR-ABL1、
      // 读花的 P1907aBL1x100%）时，mapAlias 的子串匹配会把定量行错配成定性字段 _Q，
      // 随后与真正的定性行同 code 去重 → 定量行整行消失（2026-10-24 浏览器实测）。
      const _fixed = repairFusionName(rawName)
      const _whole = (_fixed && mapAlias(_fixed)) || mapAlias(rawName)
      if (_whole) {
        name = (FIELD_BY_CODE[_whole] && FIELD_BY_CODE[_whole].name) || rawName
        abbr = canonicalAbbr(_whole) || ''
      }
    }
    if (!name && !abbr) {
      // name 全乱码（双栏 name 行 OCR 乱码）："value 正确但 name 乱码"的行原本在此丢弃，
      // 导致双栏不对齐报告整项 missing。改用 value+ref 反推 code 救回（强吻合才采纳；
      // ref 串行的行不强吻合 → 仍丢弃，安全）。反推成功后用字段标准名作为 name，让后续
      // mapAlias 命中、value 原样保留——救回 missing 项（见 bugs.md Bug 015/016）。
      const _gv = colMap.result != null ? String(row[colMap.result] || '').replace(/\.$/, '').trim() : ''
      const _gr = colMap.ref != null ? String(row[colMap.ref] || '').trim() : ''
      const _gu = colMap.unit != null ? String(row[colMap.unit] || '').trim() : ''
      _garbledReverse = (_gv && _gr && matchFieldByValueRef(_gv, _gr, _gu)) || (_gv && matchFieldByValueOnly(_gv)) || null
      // 序号锚定兜底（LLM「序号→项目」推断）：血常规序号 1-23 与值/单位都能对上时，
      // 用序号锁定标准项目。仅当 value+ref 反推失败且序号命中 CBC 序列、且行单位与锚定
      // 字段单位相容、值不越出合理范围时才采纳——避免把非血常规报告强套序列。
      if (!_garbledReverse && isCbcReport) {
        const _ino = extractItemNo(rawName)
        const _target = _ino != null ? CBC_SEQUENCE[_ino - 1] : null
        if (_target && _gv) {
          const _tf = FIELD_BY_CODE[_target]
          const _inUnit = _tf && _gu && sameUnitClass(_gu, _tf.unit)
          const _tRef = _tf ? parseRefRange(_tf.ref) : null
          const _fv2 = parseFloat(_gv)
          const _inRange =
            _tf && _tRef && _fv2 != null && !Number.isNaN(_fv2) &&
            _fv2 >= (_tRef.low ?? -Infinity) * 0.5 && _fv2 <= (_tRef.high ?? Infinity) * 3
          // 需要单位相容（有单位时）或值在字段合理范围（放宽 0.5x~3x，兼容贫血等病理低值）
          if (_tf && (_inUnit || !_gu) && (_inRange || !_tRef)) {
            _garbledReverse = { code: _target, name: _tf.name || _target }
          }
        }
      }
      if (!_garbledReverse) {
        // 乱码行「名/缩写全空、value+ref 反推与序号锚定均失败」——不立即丢弃，
        // 保留为 gap 候选（code=null），供顶层 gapFillCBC 用「同报告已识别项占用排除」填充
        // （LLM「邻行位置」推断的确定性实现：如 29.70 在 CBC 候选 LYM_PCT/MCH/P_LCR 中，
        // 前两者已被本报告其它行识别占用 → 唯一剩余 MCH 即本行真实项目）。仅数值行保留。
        const _gvRaw = colMap.result != null ? String(row[colMap.result] || '').replace(/\.$/, '').trim() : ''
        const _gvNum = parseFloat(_gvRaw)
        // 条形码/流水号/手机号等超长纯数字行（如标本条码号「03266447359」被 OCR 误读并混入网格）：
        // 非检验项目值，不生成 gap 候选——与正常行的同规则过滤（/^\d{8,}$/，见下）保持一致，
        // 否则残留为 standard_code=null 的 NORMAL 行污染 UI/入库
        if (!Number.isNaN(_gvNum) && /^\d/.test(_gvRaw) && !/^\d{8,}$/.test(_gvRaw)) {
          points.push({
            standard_code: null,
            name: rawName,
            original_name: rawName,
            value: _gvRaw,
            unit: colMap.unit != null ? normalizeUnit(row[colMap.unit]) : '',
            ref_range: colMap.ref != null ? row[colMap.ref] : '',
            arrow: colMap.arrow != null ? row[colMap.arrow] : '',
            _row: i,
            _gapCandidate: true,
          })
        }
        continue
      }
      name = _garbledReverse.name
    }

    let value = colMap.result != null ? row[colMap.result] : ''
    let arrow = colMap.arrow != null ? row[colMap.arrow] : ''
    if (/[↑↓]/.test(value)) {
      // 部分化验单把箭头与数值挤在同一格（如「48↓」）：剥离箭头并提取到 arrow 字段
      const vm = value.match(/[↑↓]/)
      if (vm && !arrow) arrow = vm[0]
      value = value.replace(/[↑↓]/g, '').trim()
    }
    // 清理 OCR 误识别的尾部孤立小数点（"30." → "30"）：只删末尾单个小数点，
    // 不碰有效小数（"3.0"、"30.5" 保留）。
    value = value.replace(/\.$/, '')
    // 保留结果中的 < / > 前缀（低于/高于检测下限，如真菌「<40.0000」），它们是有意义的语义而非噪声

    const rawUnit = colMap.unit != null ? String(row[colMap.unit]).trim() : ''
    const unit = colMap.unit != null ? normalizeUnit(row[colMap.unit]) : ''
    const ref = colMap.ref != null ? row[colMap.ref] : ''

    // 匹配信号：优先用完整原始名（含缩写+中文），其次中文项目名，再缩写。
    // 完整名/缩写可命中的原因：报告口语中文名可能与字典不一致（如「中性细胞比率」≠
    // 字典「中性粒细胞比率」），而缩写「NEUT%」是稳定信号；同时避免「汪上南平均血红蛋向量」
    // 这类汉字乱码完全失配——若其中仍含可命中的缩写（如 MCH）也能匹配。
    // 单位消歧：name 命中多个字段（如「中性粒细胞」→NEUT_ABS/NEUT_PCT）时按报告单位锁定
    // （+% → PCT，+×10^9/L → ABS）。比 mapAlias 更接近 LLM 的「值类型签名」推断。
    // 仅当 name 本身映射到某字段时才用单位消歧覆盖；rawName 映射（含缩写）保持原优先级。
    const codeByUnit = mapAliasWithUnit(name, unit)
    let code = (codeByUnit || mapAliasWithUnit(rawName, unit) || mapAlias(rawName) || mapAlias(name)) || mapAlias(abbr) || ''
    // 胆红素三联体兜底（case-TR-20260911-SBLXJ7）：OCR 把「直接胆红素(DBIL)」行名重度乱码为
    // "Be ASt] E BIL)"（缺左括号、D 被吞），其中 BEAS[T] 子串被 mapAlias 误命中 AST，真正 DBIL 行被抢码；
    // 该行 rawName 仍含 "BIL"（胆红素专属 token，实验室中文语境下只有胆红素家族含 BIL）。
    // 胆红素家族仅 TBIL/IBIL/DBIL 三项，TBIL/IBIL 已由各自精确别名 (TBIL)/(IBIL) 命中，
    // 故「name 命中非胆红素 code 但 rawName 含 BIL」的残留行必为 DBIL。须在 rawName 被改写为
    // 标准名之前改投，且早于 buildGridPoints 末尾的「同 code 多行择优」——否则该行会被同 code(AST) 去重吞掉。
    if (code && !['TBIL', 'IBIL', 'DBIL'].includes(code) && /BIL/i.test(rawName || '')) code = 'DBIL'
    // 单位量纲矛盾 → 同族兄弟字段改投（见 siblingByUnit）：name 命中 EO_ABS 但本行单位 % 时改投 EO_PCT。
    if (code) {
      const sib = siblingByUnit(code, unit)
      if (sib) code = sib
    }    // 显式括号缩写（如「(DBIL)」「(osm)」「(Cr)」）是报告直接写出的高置信信号：
    // 只要原行名里就含「(CODE」这种括号写法，即视为强匹配，禁止下方的 value+ref 反推覆盖
    // （否则异常高值如 DBIL=59 会被误归到 MYO[0,70] 区间；渗透压值会被误归 LPA）。
    // 仅当缩写是「裸 token」（无括号，可能 OCR 误读）时才允许反推纠偏。
    const parenStrong = !!code && new RegExp(`[（(]\\s*${code}\\b`, 'i').test(rawName)
    // 缩写可疑时用 value+ref 反推纠偏：当 name 为乱码（空）、code 仅由缩写命中，且缩写映射的
    // 字段与行的单位/参考范围明显矛盾（如「tt」→TT 但行单位 %、「cr」→Cr 但行 ref 3--5.8），
    // 说明缩写被 OCR 误读。此时若 value+ref 能唯一反推另一字段，则以反推为准（LLM 的
    // 「值类型签名」推断：值/单位/参考区间比乱码缩写更可信）。仅强吻合（matchFieldByValueRef
    // 的严判）才采纳，弱/串行 ref 不干预，安全兜底。
    if (code && code !== 'WBC' && code !== 'Hb') {
      const _gv2 = colMap.result != null ? String(row[colMap.result] || '').replace(/\.$/, '').trim() : ''
      const _gr2 = colMap.ref != null ? String(row[colMap.ref] || '').trim() : ''
      const _gu2 = colMap.unit != null ? String(row[colMap.unit] || '').trim() : ''
      const fCur = FIELD_BY_CODE[code]
      const fv = _gv2 ? parseFloat(_gv2) : NaN
      const fRef = fCur ? parseRefRange(fCur.ref) : null
      const inCur =
        fCur && !Number.isNaN(fv) && fRef && fv >= (fRef.low ?? -Infinity) && fv <= (fRef.high ?? Infinity)
      const unitMismatch = unit && fCur && !sameUnitClass(unit, fCur.unit)
      const bad = unitMismatch || (fCur && fRef && !Number.isNaN(fv) && !inCur)
      // 序号锚定：报告自带序号是血常规最可靠信号。当序号命中 CBC 序列且序列目标与当前
      // code 冲突、且序列目标单位/值更相容时，以序号为准（LLM「序号→项目」推断的确定性实现）。
      // 用于：缩写误读（cr→Cr、tt→TT、Dw→PDW 但序号其实是 PLT）、中文名歧义等。
      const _ino = extractItemNo(rawName)
      const _target = _ino != null ? CBC_SEQUENCE[_ino - 1] : null
      const seqTarget = _target && _target !== code ? FIELD_BY_CODE[_target] : null
      const _seqInUnit = seqTarget && (_gu2 ? sameUnitClass(_gu2, seqTarget.unit) : true)
      const _seqRef = seqTarget ? parseRefRange(seqTarget.ref) : null
      const _seqInRange =
        !seqTarget || !_seqRef || Number.isNaN(fv) ||
        (fv >= (_seqRef.low ?? -Infinity) * 0.1 && fv <= (_seqRef.high ?? Infinity) * 5)
      const seqBetter = seqTarget && _seqInUnit && _seqInRange
      if (isCbcReport && seqBetter) {
        code = _target
      } else if ((bad && !seqBetter && !parenStrong) || (unitMismatch && !seqBetter)) {
        // 无序号可用时，退化为 value+ref 强反推（仅「name 与 abbr 全空」的纯乱码行）：
        // 若行内已有可识别缩写（abbr 非空），则该缩写是强信号，信任它而非 value+ref 反推，
        // 避免把 "CRP"/"ALP" 这类清晰缩写行反推成别的字段（见本会话 8141 报告：CRP 行被反推成 TBA）。
        if (!name && !abbr) {
          let replaced = null
          if (_gv2 && _gr2) {
            const rv = matchFieldByValueRef(_gv2, _gr2, _gu2)
            if (rv && rv.code && rv.code !== code) replaced = rv.code
          }
          if (replaced) code = replaced
        }
      }
    }
    // 过滤报告元信息行（医院名/报告编号/页数/患者信息/页眉页脚/病例号电话等），它们不是检验项目：
    // 这类行 name 经常因 OCR 把页眉字段（病例号/电话/条码/诊断/流水号/仪器）读成数据行而撞字典「尿酸/前白蛋白/尿pH」等
    // 真名（如「尿酸」「前白蛋白」），即便 name 已映射字典 code 也不能信（见 bugs.md Bug 020/058 与 TR-20260904-6ROCOF：
    // OCR 将「病理号 000729747900」误读为 UA 值，将「电话 0316-8328471」误读为 PA 的 ref）。除关键词匹配外，对所有 row 的
    // value/ref 字段统一做超长纯数字兜底丢弃（≥10 位数字典型为 11-12 位电话/病例号/条码）。
    if (!code) {
      // 页眉/页脚元信息行过滤：先移除 OCR 常在词间插入的空格再匹配关键词。
      // 否则「血液 科 二 病 区」「时 李 审核」这类关键词被空格拆开（病 区、审 核）会漏网，
      // 复发成多余识别项（见 bugs.md Bug 020）。真实检验项目名（已映射，code 非空）不受影响。
      const metaCompact = rawName.replace(/\s+/g, '')
      const metaHit =
        /院|医院|报告|共页|姓名|性别|年龄|科别|科室|病区|检验科|床号|标本|样本|编号|送检|采样|条码|条形码|条人|三号|码号|门诊|住院|电话|地址|审核|医师|签名|申请|就诊|病历|病例|日期|流水|临床|诊断|检测|仪器|分析仪|服务/.test(metaCompact) ||
        // 「第 3 页」「共 2 页」等含数字的页脚模式
        /第\s*\d*\s*页|共\s*\d*\s*页/.test(rawName)
      if (metaHit) continue
    }
    // 条形码/流水号/病例号/电话等超长纯数字（≥10 位纯数字；不依赖 code 状态，独立于上方 !code 守卫）：
    // OCR 把页眉/页脚的「病例号 000729747900」「电话 0316-8328471」「条码 202608081281」误读为数据行的
    // value 或 ref 字段（典型症状：name 看起来是真项目名「尿酸」「前白蛋白」，但 value/ref 是病历号/电话）
    // ——绝不可能是检验项目数值，必须丢弃。指标 ref 字段最大宽度约 6-7 位（如「125-350」「0.1-0.6」），
    // ≥10 位阈值可安全区分：仅真正的病历号/电话/条码命中。避免把 PLT 等标准 ref 误伤。
    {
      const vDigits = String(value || '').replace(/\D/g, '')
      const rDigits = String(ref || '').replace(/\D/g, '')
      if (vDigits.length >= 10 || rDigits.length >= 10) continue
    }
    let field = FIELD_BY_CODE[code]
    // ===== 双向校验：中文名反向验证缩写/标准代码 =====
    // 中文名若「可信」，就是与缩写并列的独立权威信号：
    //   · 缩写列被 OCR 读乱/缺失（MCH→NMCI、PDW→Pow）→ 用可信中文名锁定字段
    //   · 缩写列映射到别的字段（非精确命中）→ 以中文名为准，避免短缩写子串误配
    //   · 中文名可信时，把乱码缩写回填为该字段规范缩写（NMCI→MCH），修正显示
    // 可信度判定：整名可映射且「外来字」（不在该字段别名字符集中的字）≤1。
    let nameCode = name ? mapAlias(name) || '' : ''
    let nameTrust = 0
    if (nameCode) {
      const cset = new Set(
        (ALIAS_MAP[nameCode] || [])
          .flatMap((a) => Array.from(String(a).replace(/\s+/g, '')))
          .filter((c) => /[\u4e00-\u9fa5]/.test(c))
      )
      const chs = Array.from(name.replace(/\s+/g, ''))
      const foreign = chs.filter((c) => !cset.has(c))
      if (foreign.length === 0) nameTrust = 2
      else if (foreign.length === 1 && mapAlias(chs.filter((c) => c !== foreign[0]).join('')) === nameCode) nameTrust = 1
    }
    if (nameTrust >= 1) {
      // 缩写精确命中当前 code 时缩写信号强（如尿常规「葡萄糖 UGLU」行，中文名歧义应让位），
      // 否则以可信中文名为准。
      const abbrExact = abbr ? mapAlias(abbr) === code : false
      // 单位一致性：可信中文名映射的 nameCode 若与报告单位矛盾（如「中性粒细胞」nameCode=NEUT_ABS
      // 但行单位 % → NEUT_ABS 期望 ×10^9/L），则 unit 信号更权威，不应回退覆盖单位消歧后的 code。
      const unitConflict =
        unit && nameCode && FIELD_BY_CODE[nameCode] && !sameUnitClass(unit, FIELD_BY_CODE[nameCode].unit)
      if (code !== nameCode && !abbrExact && !unitConflict) {
        code = nameCode
        field = FIELD_BY_CODE[code]
      }
      // 回填规范缩写：仅当现有缩写不可信（无值/映射落空/映射到别字段）时
      if (code && (!abbr || mapAlias(abbr) !== code)) abbr = canonicalAbbr(code) || abbr
    }
    // 缩写列也被 OCR 读错（如 MCH→NMCI、PDW→Pow）导致 code 落空时的全局兜底：
    // 用中文名与所有字段标准名做「字符集重合率」模糊匹配，得分 ≥0.6 则采纳该字段，
    // 删字变体兜底（mapAlias / 缩写 / 字符集模糊均落空时）：中文名与某字段别名仅差一字
    // （如「中粒细胞」→「中性粒细胞」），跨字段唯一候选才采纳，避免误配。
    let variantHit = false
    if (!field && name) {
      const variant = matchDroppedCharVariant(name)
      if (variant) {
        code = variant.code
        field = FIELD_BY_CODE[variant.code]
        abbr = canonicalAbbr(code) || abbr
        variantHit = true
      }
    }
    // 后续校验块会据 field.name 回填干净的标准中文名。
    if (!field && name) {
      const chars = new Set(Array.from(name.replace(/\s+/g, '')))
      if (chars.size >= 3) {
        let bestCode = ''
        let bestScore = 0
        for (const c of Object.keys(ALIAS_MAP)) {
          const f = FIELD_BY_CODE[c]
          if (!f || !f.name) continue
          const stdChars = new Set(Array.from(String(f.name).replace(/\s+/g, '')))
          const inter = [...chars].filter((ch) => stdChars.has(ch)).length
          const score = inter / Math.max(chars.size, stdChars.size, 1)
          if (score > bestScore) {
            bestScore = score
            bestCode = c
          }
        }
        if (bestCode && bestScore >= 0.6) {
          code = bestCode
          field = FIELD_BY_CODE[bestCode]
          // 进入此分支说明缩写列不可信（否则已有 field），一并回填规范缩写
          abbr = canonicalAbbr(code) || abbr
        }
      }
    }
    // ---- 用缩写/标准代码校验中文项目名 ----
    // 中文项目名是 OCR 易错信号，缩写列/标准代码是稳定信号。
    // 已由 code（缩写/子串）命中字段后，用 field 的标准名+全部别名字符集筛除 OCR 乱码：
    //   A/B. 中文名缺失（OCR 全乱码被丢弃）或含 ≥2 个「外来字」（不在任何别名中的字）
    //        → 判定为乱码，回填标准中文名 field.name
    //   C.   仅 1 个外来字（如「光大型血小板比率」）→ 剔除该字后重新映射，
    //        仍命中同字段则用剔除版，否则用标准名
    //   D.   无外来字 → 保留报告原话（如「中性细胞比率」，不强行改成字典名「中性粒细胞百分比」）
    let displayName = name
    if (field) {
      const charset = new Set(
        (ALIAS_MAP[code] || [])
          .flatMap((a) => Array.from(String(a).replace(/\s+/g, '')))
          .filter((c) => /[\u4e00-\u9fa5]/.test(c))
      )
      const chars = Array.from(name.replace(/\s+/g, ''))
      if (chars.length < 2) {
        displayName = field.name
      } else {
        const foreign = chars.filter((c) => !charset.has(c))
        if (foreign.length >= 2) {
          displayName = field.name
        } else if (foreign.length === 1) {
          const cleaned = chars.filter((c) => c !== foreign[0]).join('')
          displayName = mapAlias(cleaned) === code ? cleaned : field.name
        }
      }
      // 删字变体命中：显示名收敛为标准名（自动修正，「中粒细胞」→「中性粒细胞绝对值」）
      if (variantHit) displayName = field.name
    }
    // 名称是否被修正（显示名被回填为标准名 / 剔除乱码字）：变体收敛与乱码修复的审计信号
    const nameFixed = !!(field && name && displayName && displayName !== name)
    let unitFinal = unit || (field ? field.unit : '')
    // OCR 单位噪声修正：报告单位为标准单位的误读变体（410^9/L→10^9/L、9/L→10^9/L）时，
    // 直接回填标准单位，避免后续 detectSuspiciousValue/auditPoint 误判成「单位不符」。
    if (field && unit && field.unit) {
      const ocrNoise = unitOcrNoise(unit, field.unit)
      if (ocrNoise) unitFinal = ocrNoise
    }
    let refFinal = ref || (field ? field.ref : '')
    // ===== 确定值反推（数值 + 参考范围锁定项目）=====
    // 名称/缩写被 OCR 读错（如 MCHC 行被读成「超敏C反应蛋白」→ code=HS_CRP）时，
    // 若该行「数值 + 参考范围」与另一字段档案精确吻合且唯一，则反推真实字段并修正代码。
    // 修正后用正确档案审计：参考范围 316-354 与 MCHC 档案吻合 → 不再误报「参考范围有问题」。
    // 修正条件（保守）：仅当代码为空或与报告参考范围严重矛盾（中心偏移 >1 个标准跨度）
    // 时才自动改，且要求数值落在报告参考范围内——避免把仪器标准差异（hs-CRP 0-10 vs 0-5）
    // 误判成别的项目；值不在范围内时（如参考范围列串行）仅提示核对，不自动改。
    let codeReversed = false
    let reverseFrom = ''
    let reverseHint = null
    // 反推建议的目标字段：检测到矛盾但未自动改判时（如名字优先护栏拦下），
    // 把结论存进 _audit，供 UI 展示「反推指向 X」并提供「改判为此项」。
    let suggestCode = null
    let suggestName = null
    // 确定值反推触发条件：
    //   ① code 为空，或 ② 仅「删字变体」弱命中，或 ③ code 已可疑（curBad：ref 中心偏移>1.0
    //      或 value 既不在报告 ref 也不在字典 ref 内，典型为双栏串行导致 value 落错行）。
    //   强别名精准命中且 value 在 ref 内（如 (Ts)→TG 值合理）仍不反推，避免误改。
    const codeSuspect = (() => {
      if (!code) return true
      if (variantHit) return true
      const v = parseFloat(value)
      const fr = parseRefRange(refFinal) || (field ? parseRefRange(field.ref) : null)
      if (!Number.isNaN(v) && fr) {
        const inFr = v >= (fr.low ?? -Infinity) && v <= (fr.high ?? Infinity)
        const stdRef = field ? parseRefRange(field.ref) : null
        const inStd = stdRef ? v >= (stdRef.low ?? -Infinity) && v <= (stdRef.high ?? Infinity) : true
        if (!inFr && !inStd) return true // value 越界 → 可疑，允许反推纠正
      }
      return false
    })()
    if (value && value.trim() !== '' && ref && codeSuspect) {
      // 单位必须用「报告自带原始单位」（rawUnit）：unitFinal 可能已回填当前 code 的档案单位，
      // 而当前 code 本身可能识别错误，其档案单位会干扰反推并列歧义的判断。
      const rev = reverseFieldMatch(code, { value, ref_range: refFinal, unit: rawUnit, original_name: displayName })
      if (rev.codeReversed) {
        codeReversed = true
        reverseFrom = rev.reverseFrom || code
        code = rev.code
        field = FIELD_BY_CODE[code]
        abbr = canonicalAbbr(code) || abbr
        // 名称回填标准名（原名称识别错误 / 未识别），并同步修正参考范围/单位回填
        if (field && (!displayName || displayName !== field.name)) displayName = field.name
        refFinal = ref || (field ? field.ref : '')
        unitFinal = unit || (field ? field.unit : '')
        // codeReversed 后 unitFinal 重置回报告单位，同样应用 OCR 单位噪声修正
        if (field && unit && field.unit) {
          const ocrNoise = unitOcrNoise(unit, field.unit)
          if (ocrNoise) unitFinal = ocrNoise
        }
      } else if (rev.hint) {
        reverseHint = rev.hint
        suggestCode = rev.suggestedCode || null
        suggestName = rev.suggestedName || null
      }
    }
    // 多候选 value 交叉验证：双栏聚合行常使单行 name 命中多个 code（如 "(AST)(ALT)(CK)(LDH)"），
    // 仅靠最长子串会误配（把 K 串行的 3.9 当成 AST）。若当前 code 的 value 不在 refFinal 内，
    // 改用「value 落在参考范围内」的候选 code 重新裁决，纠正跨指标串行误配。
    {
      const cands = mapAliasAll(rawName)
      if (cands.length > 1) {
        const v = parseFloat(value)
        const inRangeOf = (c) => {
          const fr = parseRefRange(refFinal) || (FIELD_BY_CODE[c] ? parseRefRange(FIELD_BY_CODE[c].ref) : null)
          if (!fr || Number.isNaN(v)) return false
          return v >= (fr.low ?? -Infinity) && v <= (fr.high ?? Infinity)
        }
        if (!inRangeOf(code)) {
          const better = cands.find((c) => c.code !== code && inRangeOf(c.code))
          if (better) {
            code = better.code
            field = FIELD_BY_CODE[code]
            abbr = canonicalAbbr(code) || abbr
            refFinal = ref || (field ? field.ref : '')
            unitFinal = unit || (field ? field.unit : '')
          }
        }
      }
    }
    const nameFixedFinal = nameFixed || codeReversed
    // 数值合理性校验：标记疑似错位（小数点错位 / 单位或参考范围列串行），
    // 供详情弹窗提示并预填修正候选；下划线字段不进入导出 JSON/Markdown。
    const suspect = code ? detectSuspiciousValue(code, value, refFinal, unitFinal) : { suspicious: false, candidates: [] }
    // 数值绝不自动改写（Bug 031）：值越界（真实异常值）≠ 识别错误。
    // 曾有「唯一候选且修正后非危急值 → 自动应用小数点位移修正」逻辑，会把真实异常值
    // （如 PLT 24，化疗后骨髓抑制）自动改成范围内的候选（240）——危险误修，且与用户
    // 「我的值本来就可能是不正常的」诉求相悖。现仅保留 _suspicious/_fix 作为提示
    // （红标 + 修正候选供人工核对），任何阶段（清洗 / 一键修正）都不再改动数值。
    let finalValue = value
    const point = {
      standard_code: code,
      // original_name：经标准代码校验后的干净中文名；仍无中文则用缩写兜底。
      // 融合基因类行特殊处理：原项目名是「BCR-ABL1 P190融合基因」这类中英混排，中文 token 只取到
      // 「融合基因」会丢掉关键转录本信息（用户 2026-10-24 反馈：原始项目列只剩「融合基因」）。
      // 这类字段直接用报告原文（rawName）作显示名，不改动任何数值/编码。
      original_name: (() => {
        if (/^BCR_ABL1_/.test(code || '') && rawName) {
          const fname = (FIELD_BY_CODE[code] && FIELD_BY_CODE[code].name) || ''
          // 原文与标准名长度相近（只是中英空格差异）→ 用原文，更贴近报告；
          // 原文带明显 OCR 残渣（如尾部多出 BCR-ABL1）→ 用标准名，避免脏名进网格。
          return rawName.length <= fname.length + 8 ? rawName : fname || rawName
        }
        return displayName || abbr
      })(),
      abbr,
      value: finalValue,
      unit: unitFinal,
      ref_range: refFinal,
      arrow: /↓/.test(arrow) ? '↓' : /↑/.test(arrow) ? '↑' : '',
      // 识别顺序行号：双栏报告左右栏按此还原原图交错顺序，便于与原图逐行对照
      _row: seq[i],
      // 栏位标记（0=左栏，1=右栏）：来自 buildGridFromItems 行数组第 6 列；单栏报告为 undefined。
      // 供 autoFillItemNo 做栏感知插值（左右栏是各自独立的连续序号序列，须同栏内插值）。
      _col_idx: row[5] !== undefined && row[5] !== null ? Number(row[5]) : undefined,
      // 源图定位：行包围盒（多引擎识别新增，第 7 列 {x0,y0,x1,y1} 像素系；ocrEngines 负责归一化为
      // 0-1 比例 {x,y,w,h}）。历史数据/策略补行无此列 → undefined，UI 据此隐藏「原图」按钮（零迁移降级）。
      _bbox: row[6] || undefined,
      // 项目序号（项目数字识别）：取自报告项目名前的序号（「1 白细胞」→1）；报告未带序号时
      // 置 null，由下方 autoFillItemNo 按识别顺序自动按序填充。
      // _item_no_src 标记序号来源，供 UI 区分「成功识别（确定）」与「推理/自动填充」：
      //   · detected：OCR 从报告项目名前确定识别出序号（报告自带）
      //   · 缺省/未带：报告未带序号，序号由 autoFillItemNo 推理填充（自动标 inferred）
      _item_no: extractItemNo(rawName),
      _item_no_src: extractItemNo(rawName) != null ? 'detected' : null,
      _suspicious: suspect.suspicious,
      _fix: suspect.suspicious ? { reason: suspect.reason, candidates: suspect.candidates } : null,
    }
    // 多维识别审计（标准档案校验）：名称/单位/参考范围维度，供校验摘要与提示徽标使用
    point._audit = auditPoint(
      { standard_code: code, original_name: point.original_name, unit: unitFinal, ref_range: refFinal },
      { nameFixed: nameFixedFinal, rawUnit, codeReversed, codeReversedFrom: reverseFrom, reverseHint, suggestCode, suggestName }
    )
    points.push(point)
  }
  // 同 code 多行择优：双 OCR 识别 / refBank 串行常使同一指标在 points 中出现多行
  // （如 GLU 既产出正确 4.44 也产出噪声 444、Ca 既产出 2.27 也产出噪声 476）。
  // 逐 code 仅保留「value 落在参考范围内」或「最接近参考范围中点」的一行，
  // 避免 verify 取到错误的噪声值。无 standard_code 的行（定性/页眉）原样保留。
  {
    const byCode = new Map()
    for (const p of points) {
      if (!p.standard_code) continue
      if (!byCode.has(p.standard_code)) byCode.set(p.standard_code, [])
      byCode.get(p.standard_code).push(p)
    }
    const chosen = new Map()
    for (const [code, arr] of byCode) {
      const inRange = (p) => {
        // 优先用字段字典 ref 判断「在 ref 内」：双栏串行时行的 reportRef 可能串行（如 LDH 行
        // value=8.4 配串行 ref 0-14，8.4 在 0-14 内误判 ir=true），用字典 ref（LDH 120-250）
        // 才能正确排除串行值（8.4 不在 120-250 → ir=false，让真正在范围内的 386 被选中）。
        // 字典 ref 缺失才回退 reportRef。
        const field = FIELD_BY_CODE[p.standard_code]
        const r = parseRefRange(field && field.ref ? field.ref : p.ref_range)
        if (!r) return false
        const v = parseFloat(p.value)
        if (Number.isNaN(v)) return false
        return v >= (r.low ?? -Infinity) && v <= (r.high ?? Infinity)
      }
      const midOf = (p) => {
        const field = FIELD_BY_CODE[p.standard_code]
        const r = parseRefRange(field && field.ref ? field.ref : p.ref_range)
        if (!r || r.low == null || r.high == null) return null
        return (r.low + r.high) / 2
      }
      const refMatchOf = (p) => {
        // 行的 reportRef 与字段字典 ref 是否吻合（中心偏移 ≤0.3 跨度）。
        // 双栏串行时行的 reportRef 可能串行（如 LDH 行 value=8.4 配串行 ref 0-14，与字典 120-250 矛盾），
        // 用 refMatch 优先选 reportRef 与字典吻合的行（386+120-250 吻合 → 优先；8.4+0-14 矛盾 → 降权），
        // 避免「都越字典 ref 时比中点」把串行值（8.4 近 0-14 中点）误选为结果。
        const field = FIELD_BY_CODE[p.standard_code]
        if (!field || !field.ref) return false
        const stdRef = parseRefRange(field.ref)
        const repRef = parseRefRange(p.ref_range)
        if (!stdRef || !repRef) return false
        const stdSpan = stdRef.high != null && stdRef.low != null ? stdRef.high - stdRef.low : null
        if (!stdSpan) return false
        const stdCenter = (stdRef.high + stdRef.low) / 2
        const repCenter = repRef.high != null && repRef.low != null ? (repRef.high + repRef.low) / 2 : null
        if (repCenter == null) return false
        return Math.abs(repCenter - stdCenter) / stdSpan <= 0.3
      }
      const scored = arr.map((p) => {
        const ir = inRange(p)
        const m = midOf(p)
        const v = parseFloat(p.value)
        const dist = m != null && !Number.isNaN(v) ? Math.abs(v - m) : Infinity
        return { p, ir, dist, rm: refMatchOf(p) }
      })
      scored.sort((a, b) => {
        // 优先 reportRef 与字典 ref 吻合的行（排除串行 reportRef），次 ir（字典 ref 内），次 dist
        const arm = a.rm ? 1 : 0
        const brm = b.rm ? 1 : 0
        if (arm !== brm) return brm - arm
        const ai = a.ir ? 1 : 0
        const bi = b.ir ? 1 : 0
        if (ai !== bi) return bi - ai
        return a.dist - b.dist
      })
      chosen.set(code, scored[0].p)
    }
    const seenCode = new Set()
    const deduped = []
    for (const p of points) {
      if (!p.standard_code) {
        deduped.push(p)
        continue
      }
      if (seenCode.has(p.standard_code)) continue
      seenCode.add(p.standard_code)
      deduped.push(chosen.get(p.standard_code))
    }
    return deduped
  }
}

// 按识别顺序为缺失序号的项自动按序填充 _item_no（项目数字识别兜底）。
// 规则：栏感知——先按 _col_idx（0=左栏，1=右栏）分组（无标记默认 0 栏，兼容单栏报告），
// 每组内在按 _row 升序后独立执行序列补全。
//  · 组内有 detected 锚点（报告自带且确定识别的序号）时，基于锚点做「双向线性插值/外推」，
//    保留左右栏各自独立的绝对序号语义（如左栏 1-15、右栏 16-27），避免 Z 字形 `_row`
//    跨栏把左栏序号误用于右栏缺失项（如 MCH 的 16 被错补成 2）。
//  · 组内无锚点（报告未自带序号）→ 按 1、2、3… 顺序兜底；仅 1 个锚点 → 以锚点偏移顺延。
// CBC 范围内「值→字段」候选（方案⑥邻行约束的基础）：返回所有 ref 范围包含该值的 CBC 字段
function matchCBCByValueOnly(v) {
  const val = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''))
  if (!isFinite(val)) return []
  return CBC_SEQUENCE.filter((c) => {
    const r = parseRefRange(FIELD_BY_CODE[c] && FIELD_BY_CODE[c].ref)
    return r && val >= r.low && val <= r.high
  })
}

// 邻行/占用约束 gap-fill（LLM「邻行位置」推断的确定性实现）：
// 对乱码未识别但带数值的行，若其值在 CBC 范围内的候选里「除一个外都已被本报告的其它行识别占用」，
// 则唯一剩余候选即本行真实项目（前提：值落在其 ref 范围，放宽容差兼容贫血等病理值）。
// 仅「唯一缺失」才采纳，否则放弃——安全，不误伤。仅当本报告已识别 ≥12 个 CBC 项时启用（确为血常规）。
function gapFillCBC(points) {
  const cbcSet = new Set(CBC_SEQUENCE)
  const occupied = new Set(points.map((p) => p.standard_code).filter((c) => cbcSet.has(c)))
  if (occupied.size < 12) return
  for (const p of points) {
    if (!p._gapCandidate || p.standard_code) continue
    const cands = matchCBCByValueOnly(p.value)
    if (cands.length === 0) continue
    const missing = cands.filter((c) => !occupied.has(c))
    if (missing.length !== 1) continue
    const c = missing[0]
    const r = parseRefRange(FIELD_BY_CODE[c].ref)
    const v = parseFloat(String(p.value == null ? '' : p.value).replace(/[^0-9.]/g, ''))
    if (r && isFinite(v) && v >= (r.low ?? -Infinity) * 0.5 && v <= (r.high ?? Infinity) * 3) {
      p.standard_code = c
      p.original_name = (FIELD_BY_CODE[c] && FIELD_BY_CODE[c].name) || c
      p.abbr = canonicalAbbr(c) || ''
      p.ref_range = FIELD_BY_CODE[c].ref
      p.unit = FIELD_BY_CODE[c].unit
      p._item_no = CBC_SEQUENCE.indexOf(c) + 1
      p._item_no_src = 'gapfill'
      p._gapFilled = true
      occupied.add(c)
    }
  }
  // 移除仍未填入的 gap 候选（避免污染 UI/其它逻辑）
  for (let i = points.length - 1; i >= 0; i--) {
    if (!points[i].standard_code && points[i]._gapCandidate) points.splice(i, 1)
  }
}

// ===== 多信号融合投票框架（字段级「多维互推」） =====
// 把原本零散分布的「name 别名 / value+ref 强吻合反推 / value-only 唯一落点 / 邻行占用排除」
// 四类信号统一为加权投票，对 point 的 standard_code 做确定性裁决。报告类型无关：
// 项集优先取 reportType.keyFields，缺失时回退全部字段（靠「已识别项占用排除」保证收敛安全）。
// 整合并替代原 gapFillCBC（CBC 专用）+ 部分反向补码逻辑，提升通用性、可解释性与跨报告复用。
//   SIGNAL_WEIGHT：各信号基础权重。name 别名歧义时，value+ref（权重最高）可打破平局。
const SIGNAL_WEIGHT = { baseline: 1.0, nameAlias: 2.0, valueRef: 3.0, valueOnly: 1.5 }

function reportCodeSet(reportType) {
  const def = (reportType && REPORT_TYPES.find((r) => r.code === reportType)) || null
  if (def && def.keyFields && def.keyFields.length) return def.keyFields
  // 回退到 CBC 项集：与历史 gapFillCBC 行为一致，保证收敛唯一性（乱码值落点候选可控）
  return CBC_SEQUENCE
}

function voteTally(votes, code, w, why) {
  if (!code) return
  const e = votes.get(code) || { score: 0, why: [] }
  e.score += w
  e.why.push(why)
  votes.set(code, e)
}

export function resolveByMultiSignal(points, reportType) {
  if (!points || !points.length) return points
  const codeSet = reportCodeSet(reportType)

  // —— 阶段1：邻行占用排除 gap-fill（等价并泛化原 gapFillCBC）——
  // 乱码未识别但带数值的行，若其值落点候选「除一个外都已被本报告的其它行识别占用」，
  // 则唯一剩余候选即本行真实项目。仅唯一缺失才采纳，安全不误伤；项集泛化为报告类型。
  const occupied = new Set(points.map((p) => p.standard_code).filter((c) => c && codeSet.includes(c)))
  for (const p of points) {
    if (p.standard_code) continue
    // 噪声行保护：邻行排除只能「补」有明确归属线索的孤儿数值行；
    // 纯裸数字（无名、无单位、且无任何别名命中）多为双栏/页眉碎片噪声，禁止强行套码，
    // 否则会把碎片值（如 "8"）错配成唯一空缺项（case-TR-20260830-MINQ7R：EO_PCT 被碎片 8 抢占）。
    if (!p.unit && !(p.original_name && mapAliasAll(p.original_name).length)) continue
    const val = parseFloat(String(p.value == null ? '' : p.value).replace(/[^0-9.]/g, ''))
    if (!isFinite(val)) continue
    const cands = codeSet.filter((c) => {
      const f = FIELD_BY_CODE[c]
      const r = f && parseRefRange(f.ref)
      if (!(r && val >= r.low && val <= r.high)) return false
      // 单位量纲互斥保护（Bug 031 衍生 / §5.1 双列误配）：本行已含明确单位时，
      // 仅保留与之一致量纲的候选——「%」绝不填进 *10^9/L 行，反之亦然，
      // 避免 EO#(6.00, *10^9/L) 被「value 落点唯一剩余」错配为 EO_PCT(%)。
      if (p.unit && f && !sameUnitClass(p.unit, f.unit)) return false
      return true
    })
    const missing = cands.filter((c) => !occupied.has(c))
    if (missing.length !== 1) continue
    const c = missing[0]
    const r = parseRefRange(FIELD_BY_CODE[c].ref)
    if (r && val >= (r.low ?? -Infinity) * 0.5 && val <= (r.high ?? Infinity) * 3) {
      p.standard_code = c
      p.original_name = (FIELD_BY_CODE[c] && FIELD_BY_CODE[c].name) || c
      p.abbr = canonicalAbbr(c) || ''
      p.ref_range = FIELD_BY_CODE[c].ref
      p.unit = FIELD_BY_CODE[c].unit
      if (p._item_no_src !== 'detected') {
        p._item_no = codeSet.indexOf(c) + 1
        p._item_no_src = 'multisignal'
      }
      p._multiSignal = { filled: 'neighbor-exclusion', candidates: cands, reason: 'value落点唯一剩余' }
      occupied.add(c)
    }
  }

  // —— 阶段2：加权投票（name / value+ref / value-only）——
  // 仅「无 code」或「name 信号未支持当前 code（歧义/误配）」时谨慎校正；
  // 已识别且 name 信号支持当前 code 的项绝不改动（避免回归）。
  for (const p of points) {
    const votes = new Map()
    if (p.standard_code) voteTally(votes, p.standard_code, SIGNAL_WEIGHT.baseline, 'baseline')
    for (const c of mapAliasAll(p.original_name || p.name || '')) {
      if (codeSet.includes(c)) voteTally(votes, c, SIGNAL_WEIGHT.nameAlias, 'name-alias')
    }
    const rv = matchFieldByValueRef(p.value, p.ref_range, p.unit)
    if (rv) voteTally(votes, rv.code, SIGNAL_WEIGHT.valueRef, 'value+ref')
    const vo = matchFieldByValueOnly(p.value)
    if (vo) voteTally(votes, vo, SIGNAL_WEIGHT.valueOnly, 'value-only')

    if (votes.size <= 1) continue
    const ranked = [...votes.entries()].sort((a, b) => b[1].score - a[1].score)
    const [topCode, top] = ranked[0]
    const second = ranked[1]
    const cur = p.standard_code
    // 无 code：取明显领先的最高票直接定
    if (!cur) {
      if (top.score >= SIGNAL_WEIGHT.valueRef && (!second || top.score > second.score)) {
        p.standard_code = topCode
        p._multiSignal = { filled: 'vote', votes: ranked.map(([c, v]) => ({ code: c, score: v.score, why: v.why })) }
      }
      continue
    }
    // 有 code：仅当 name 信号从未指向 cur，且投票明确转向另一唯一候选时才校正
    if (votes.get(cur)) continue
    if (topCode !== cur && top.score >= SIGNAL_WEIGHT.valueRef && (!second || top.score - second.score >= 1.0)) {
      p.standard_code = topCode
      p._multiSignal = { corrected: true, from: cur, to: topCode, votes: ranked.map(([c, v]) => ({ code: c, score: v.score, why: v.why })) }
    }
  }
  resolveCrossRowDuplicates(points)
  return points
}

// ===== 阶段3：重复 code 行的「跨行错配」改判 =====
// 真实病例：双栏血常规把 PLT 行的「14.3 / 10^9/L / 125-350」整行挂到「红细胞计数」名下，
// 与真正的 RBC 行（1.33 / 10^12/L / 4.3-5.8）并存 → 同一报告出现两个 RBC 点、而 PLT 缺失。
// 单看这一行无法区分「名字串行」与「其余列串行」（两者形式完全相同，见 reverseFieldMatch 注释），
// 但放到整份报告上下文里就能定：当前 code 已被另一个更合理的行占用，且目标 code 空着。
// 安全条件（全部满足才改判，缺一不可）：
//   ① 当前 code 在本报告内至少出现 2 次（本行属多余/重复行，改掉不会丢指标）
//   ② 本行「单位」与「参考范围」双双矛盾于当前 code 的标准档案（已排除 OCR 噪声变体/等效单位）
//   ③ 存在唯一候选字段，其「单位」与「参考范围」双双吻合本行
//   ④ 该候选字段在本报告内尚未被占用（改判后不产生重复）
// 单点情形（清晰项目名 + 单位/参考范围偶然矛盾，如「血红蛋白 + Cr 的单位/参考范围」）
// 因不满足 ① 而绝不触发，故「名字优先」的保护完整保留。
export function resolveCrossRowDuplicates(points, allow = null) {
  // 返回改判清单 [{ from, to, name, value, unit, ref_range, reason }]，供调用方展示明细；
  // 导入链路直接忽略返回值即可。
  // allow({ from, to, value }) => boolean：可选准入回调，让清洗面板把「是否应用该条改判」
  // 交还用户勾选（改 code 风险高于改单位/参考范围）；不传则全部应用（导入链路行为）。
  const changed = []
  if (!points || !points.length) return changed
  const countByCode = new Map()
  for (const p of points) {
    if (!p.standard_code) continue
    countByCode.set(p.standard_code, (countByCode.get(p.standard_code) || 0) + 1)
  }
  const occupied = new Set(countByCode.keys())
  for (const p of points) {
    if (!p.standard_code) continue
    // ① 仅处理重复 code 的行
    if ((countByCode.get(p.standard_code) || 0) < 2) continue
    const cur = p.standard_code
    const f = FIELD_BY_CODE[cur]
    if (!f || !f.ref) continue
    const reportRef = parseRefRange(p.ref_range)
    const stdRef = parseRefRange(f.ref)
    if (!reportRef || !stdRef) continue
    // ② 单位矛盾（排除噪声变体与等效单位）+ 参考范围矛盾（中心偏移 >1 个标准跨度）
    const unitConflict = (() => {
      const ru = normalizeUnit(p.unit || '')
      const su = normalizeUnit(f.unit || '')
      if (!ru || !su) return false
      if (ru.toLowerCase() === su.toLowerCase()) return false
      if (unitsEquivalent(cur, p.unit, f.unit)) return false
      return !unitOcrNoise(p.unit, f.unit)
    })()
    const { centerDiffRatio, maxRelDiff } = refDiffMetrics(stdRef, reportRef)
    const refConflict = centerDiffRatio != null ? centerDiffRatio > 1.0 : maxRelDiff > 1.0
    if (!unitConflict || !refConflict) continue
    // ③ 候选字段 unit + ref 双双吻合。刻意不要求「值落在参考范围内」——随访患者指标
    //    普遍异常（PLT 8~42 而参考 125-350），该门槛会让本逻辑在这类数据上形同虚设。
    const rev = matchFieldByValueRef(p.value, p.ref_range, p.unit)
    if (!rev || rev.code === cur) continue
    if (rev.unitMatch !== true) continue
    // ④ 目标 code 未被占用
    if (occupied.has(rev.code)) continue
    // 准入回调（清洗面板的用户勾选）：被取消的改判整条跳过，保持原样不改
    if (allow && !allow({ from: cur, to: rev.code, value: p.value })) continue
    const tf = FIELD_BY_CODE[rev.code]
    const from = cur
    p.standard_code = rev.code
    p.original_name = (tf && tf.name) || p.original_name
    // 用新 code 重算状态与审计（三列已吻合 → 单位/参考范围不再报不符）
    p.status = computeStatus(rev.code, p.value, p.ref_range, p.arrow, p.unit)
    const sus = detectSuspiciousValue(rev.code, p.value, p.ref_range, p.unit)
    p._suspicious = sus.suspicious
    p._fix = sus.suspicious ? { reason: sus.reason, candidates: sus.candidates } : null
    p._audit = auditPoint(
      { standard_code: rev.code, original_name: p.original_name, unit: p.unit, ref_range: p.ref_range },
      {
        rawUnit: p.unit,
        codeReversed: true,
        codeReversedFrom: from,
        nameFixed: true,
        reverseHint: `跨行错配：单位「${p.unit}」与参考范围「${p.ref_range}」均与「${f.name}」标准档案矛盾，而与「${rev.name}」双双吻合；同报告内已有另一个「${f.name}」行且「${rev.name}」缺失，已按三列一致性改判`,
      }
    )
    countByCode.set(from, countByCode.get(from) - 1)
    occupied.add(rev.code)
    changed.push({
      from,
      to: rev.code,
      name: p.original_name,
      value: p.value,
      unit: p.unit,
      ref_range: p.ref_range,
      reason: `单位「${p.unit}」与参考范围「${p.ref_range}」均与「${f.name}」标准档案矛盾，而与「${rev.name}」双双吻合；本记录已有另一个「${f.name}」行且「${rev.name}」缺失`,
    })
  }
  return changed
}

function autoFillItemNo(points) {
  if (!points || points.length === 0) return

  // 1. 按栏分组
  const colGroups = {}
  for (const p of points) {
    const col = p._col_idx ?? 0
    if (!colGroups[col]) colGroups[col] = []
    colGroups[col].push(p)
  }

  // 2. 每组独立执行序列补全
  for (const colPoints of Object.values(colGroups)) {
    const ordered = colPoints
      .map((p, idx) => ({ p, idx }))
      .sort((a, b) => (a.p._row ?? a.idx) - (b.p._row ?? b.idx))

    // 提取本栏 detected 锚点（报告自带且 OCR 确定识别的序号）
    const anchors = ordered
      .map((item, index) => ({ index, val: item.p._item_no, src: item.p._item_no_src }))
      .filter((a) => a.val != null && a.val > 0 && a.src === 'detected')

    // —— 防毒拦截（极简单调性过滤）——
    // 剔除破坏本栏单调递增趋势的噪声伪锚点。OCR 常把碎片（如「作」「有」等残字）误识成
    // 小序号 detected，混入序列末端会严重破坏左右栏 16-27 的单调递增性，并污染插值。
    // 规则：按 _row 顺序遍历，凡「较已见过的最大 detected 序号反而变小」的锚点，
    // 视为噪声，剥夺其 detected 身份（置 src=null，让它在 3b 被当作 inferred 重新编号）。
    // 注意：仅当已见最大序号存在才判（首个锚点无条件保留），避免误伤正常升序首锚。
    {
      let maxVal = -1
      for (const a of anchors) {
        if (a.val < maxVal) {
          // 剥夺 detected 身份 → 3b 会把它当普通缺序号项用邻近锚点重新推断
          ordered[a.index].p._item_no_src = null
          continue
        }
        maxVal = Math.max(maxVal, a.val)
      }
      // 收缩 anchors：只保留未被剔除的锚点
      let k = 0
      for (let i = 0; i < anchors.length; i++) {
        if (ordered[anchors[i].index].p._item_no_src === 'detected') anchors[k++] = anchors[i]
      }
      anchors.length = k
    }

    // 3a. 锚点不足 2 个：顺序兜底。无锚点从 1 起；单锚点以锚点值 - 相对行距偏移起始，
    //     使锚点前的缺项能顺延到正确绝对序号（如右栏唯一锚点 17 在行 3 → 行 2 应为 16）。
    if (anchors.length < 2) {
      let n = anchors.length === 1 ? anchors[0].val - anchors[0].index : 1
      for (const { p } of ordered) {
        if (p._item_no == null || p._item_no === 0) {
          p._item_no = n > 0 ? n : 1
          p._item_no_src = 'inferred'
        }
        n += 1
      }
      continue
    }

    // 3b. 锚点 ≥2：同栏内双向局部插值/外推
    for (let i = 0; i < ordered.length; i++) {
      const { p } = ordered[i]
      if (p._item_no_src === 'detected' && p._item_no != null) continue

      let left = null
      let right = null
      for (let j = i - 1; j >= 0; j--) {
        if (ordered[j].p._item_no_src === 'detected') { left = { i: j, v: ordered[j].p._item_no }; break }
      }
      for (let j = i + 1; j < ordered.length; j++) {
        if (ordered[j].p._item_no_src === 'detected') { right = { i: j, v: ordered[j].p._item_no }; break }
      }

      let inferredNo = 1
      if (left) inferredNo = left.v + (i - left.i)
      else if (right) inferredNo = right.v - (right.i - i)

      p._item_no = inferredNo > 0 ? inferredNo : 1
      p._item_no_src = 'inferred'
    }
  }
}

// 自动推断报告类型（依据识别出的字段 + 报告标题/项目名文本）
// 已重构为目录驱动：titleKeyword 最高优先级 + signature 双向互推 + 组合兜底 + 新类型自动发现。
// 旧判定顺序（固定体系/组合体系/UNKNOWN）由 src/data/reportCatalog.js 统一接管，保证单一可信源。
export function detectReportType(points, titleText = '') {
  return catalogDetectReportType(points, titleText)
}

// 目录驱动的详细推断：返回 { code, discovered, scores, expected }，用于 UI 审计视图与调试。
export function inferReportType(points, titleText = '') {
  return catalogInferReportType(points, titleText)
}

// ---- 共享：指标指纹 / 日期容差（导入查重与历史清洗去重共用，避免两套实现分叉）----
// 数值归一化：去掉尾随零与空格，仅对可解析数值做规范（保留 2 位小数精度），
// 让 OCR 的「83.3 / 83.30」「12.5 / 12.50」等写法判定为同一值。
export function normValue(v) {
  const s = String(v ?? '').trim()
  if (s === '') return ''
  const n = Number(s)
  if (Number.isNaN(n) || !Number.isFinite(n)) return s.toLowerCase()
  return String(Math.round(n * 100) / 100)
}

// 指标指纹：standard_code=归一值 按 code 排序拼接。只比较「已映射且有值」的点，
// 用于判断两份报告是否为同一张化验单（导入查重 / 清洗去重）。
export function fingerprint(record) {
  return (record.data_points || [])
    .filter((p) => String(p.value ?? '').trim() !== '')
    .map((p) => `${p.standard_code || '?'}=${normValue(p.value)}`)
    .sort()
    .join('|')
}

// 日期容差：a、b 相差不超过 days 天即视为「相邻」（用于相似报告放宽判定）
export function dateWithinDays(a, b, days = 1) {
  if (!a || !b) return false
  const da = new Date(a)
  const db = new Date(b)
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false
  return Math.abs(da - db) / 86400000 <= days + 1e-9
}
