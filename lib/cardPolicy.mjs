// MedBrief · 资料卡临床口径（P0/P1 分层 · 危急值 · 缺项声明 · 时效提醒）
//
// 这一层只放「什么该展开、什么该折叠、什么必须报警」的口径，不放渲染。
// 改动这里等于改临床判断，**必须同步改 tests/verify-card.mjs 的断言**。
//
// 依据：用户 2026-11-13 定稿的《问诊卡逻辑 v3》§二「异常判定与危急值警示」/ §三 版式，
// 以及排雷后确认的三条口径：
//   1. 尿潜血 / 尿红细胞 / 尿白细胞 **永远 P0**（化疗/移植后出血性膀胱炎、感染的线索，不按报告类型一刀切）；
//   2. ANC 缺失必须显式写进 missingBasics（粒缺判定不能靠百分比猜）；
//   3. 危急值优先于分层与排序：无论属于 P0 还是 P1，命中危急阈值一律置顶 + 底纹。

/** P0 核心码（正面展开）。
 *  2026-11-14 用户口径：**首屏只留核心** —— WBC/Hb/PLT/ANC、凝血、肝肾功能、重要感染指标、疾病特异项、尿三项。
 *  红细胞比积(HCT)、单核/嗜碱百分比等**次级衍生参数下沉 P1 折叠**（P0 曾膨胀到 27 行，把首屏挤满）。
 *  注意：下沉不等于不报警 —— 命中危急阈值仍会被 `isP0()` 强制升回 P0（见下）。 */
export const P0_CODES = new Set([
  // 血常规核心（其余 CBC 项（HCT/RBC/MCV/MCH/MCHC/RDW/PDW/MPV/各类百分比与绝对值）下沉 P1）
  'WBC', 'NEUT_ABS', 'Hb', 'PLT',
  // 凝血
  'PT', 'APTT', 'FIB', 'D_DIMER', 'INR', 'PTR', 'TT', 'FDP', 'AT3',
  // 肝肾功能
  'ALT', 'AST', 'GGT', 'ALP', 'TBIL', 'DBIL', 'IBIL', 'TP', 'ALB', 'GLOB', 'AG_RATIO',
  'CREA', 'BUN', 'UA', 'LDH',
  // 炎症 / 感染（重要感染指标）
  'CRP', 'HS_CRP', 'PCT', 'IL6',
  // 心功能（2026-11-14 用户拍板）：NT-proBNP 是蒽环类化疗心脏毒性监测的核心项，
  // 之前被下沉进 P1，导致 `3182.00（25.5× 上限）` 在第 1 页完全看不见 —— 与「蒽环类必看」的口径自相矛盾。
  'NT_PROBNP', 'BNP',
  // 疾病特异（骨髓 / 流式 / MRD / 遗传）—— 血液科最先看
  'BM_BLAST_PCT', 'MRD', 'FCM_MRD_PCT', 'FCM_CD34_PCT',
  'custom:fcm-gran-pct', 'custom:fcm-lymph-pct', 'custom:fcm-mono-pct', 'custom:fcm-nrbc-pct',
  'BCR_ABL1', 'FUSION', 'KARYOTYPE', 'MUTATION',
  // 跨科高危：血气乳酸（v3 点名）
  'LAC',
  // 尿：潜血 / 尿白细胞 / 尿红细胞 —— 永远 P0（用户 2026-11-13 拍板）
  'U_ERY', 'U_LEU', 'U_NS_RBC',
])

/** 下沉到 P1（折叠摘要）的次级衍生参数 —— 只为可读性与代码自证，判定逻辑用 P0_CODES 反查。 */
export const P1_DEMOTED_CODES = new Set([
  'HCT', 'RBC', 'RET', 'NRBC',
  'NEUT_PCT', 'LYM_PCT', 'MONO_PCT', 'EO_PCT', 'BASO_PCT',
  'LYM_ABS', 'MONO_ABS', 'EO_ABS', 'BASO_ABS',
  'MCV', 'MCH', 'MCHC', 'RDW_CV', 'RDW_SD', 'PLT_PCT', 'PDW', 'MPV', 'P_LCR',
  'K', 'NA', 'CL', 'CA', 'CO2', 'GLU', 'CK', 'CK_MB', 'HBDH',
  'FERRITIN', 'FE', 'TSAT', 'FOLATE', 'VB12', 'ESR',   // NT_PROBNP 已升 P0（见上）
])

/** 危急值阈值（v3 §二.2 默认值，可配置）。命中即置顶 + 底纹，且强制升入 P0 展开区。 */
export const CRITICAL_RULES = [
  { codes: ['WBC'], test: (v) => v < 1.0 || v > 50, label: 'WBC', range: '<1.0 或 >50' },
  { codes: ['NEUT_ABS'], test: (v) => v < 0.5, label: 'ANC', range: '<0.5' },
  { codes: ['Hb'], test: (v) => v < 60, label: 'Hb', range: '<60' },
  { codes: ['PLT'], test: (v) => v < 20 || v > 1000, label: 'PLT', range: '<20 或 >1000' },
  { codes: ['FIB'], test: (v) => v < 1.0, label: 'FIB', range: '<1.0' },
  { codes: ['LAC', 'BG_LAC'], test: (v) => v >= 4.0, label: 'Lac', range: '≥4.0' },
  { codes: ['IL6'], test: (v) => v >= 1000, label: 'IL-6', range: '≥1000' },
  { codes: ['PT'], test: (v) => v >= 20, label: 'PT', range: '≥20（重度延长）' },
  { codes: ['APTT'], test: (v) => v >= 60, label: 'APTT', range: '≥60（重度延长）' },
  { codes: ['K', 'BG_K'], test: (v) => v < 2.8 || v > 6.0, label: 'K+', range: '<2.8 或 >6.0' },
  // 心功能（2026-11-14 用户拍板）：取成人急性心衰最高年龄分层的界值 1800 pg/mL ——
  // 既覆盖「确诊级」升高，也避免把 450/900 这类分层值当危急造成误报刷屏。
  { codes: ['NT_PROBNP'], test: (v) => v >= 1800, label: 'NT-proBNP', range: '≥1800' },
]

/** 命中危急阈值？返回命中的规则（供卡面标「危急」与人工回查），不命中返回 null。 */
export function criticalOf(row = {}) {
  const code = row.code || ''
  const num = Number(row.num ?? row.value)
  if (!code || !Number.isFinite(num)) return null
  for (const rule of CRITICAL_RULES) {
    if (!rule.codes.includes(code)) continue
    if (rule.test(num)) return { label: rule.label, range: rule.range, value: num }
  }
  return null
}

/** 尿三项的名称兜底：真实报告常写成「尿潜血（BLD）」「尿红细胞（U-RBC）」且 code 可能为空，
 *  按 policy §1「尿潜血/尿红细胞/尿白细胞永远 P0」，这里补一层名称判定，避免它们被折叠进 P1。 */
const URINE_P0_RE = /潜血|尿红细胞|尿白细胞|\bBLD\b|U-?RBC|U-?LEU/i

/** 试剂质控行（不是病人的指标，2026-11-14 用户口径：不得出现在卡面任何位置）。
 *  实测：07-18 的 PCR 报告里 `内部对照 阳性`、`阳性对照 阳性` 被当成指标混进「其他感染筛查」，
 *  还因为 value=阳性 被标了 `▲ 高` —— 医生会以为病人某项阳性。 */
export const REAGENT_CONTROL_RE = /^(?:内部?对照|阳性对照|阴性对照|空白对照|质控|标准品|校准品|阴阳性对照)$|对照(?:品|孔|管)?$/

/** 这一行是不是试剂质控（按名称判定；code 为空才是常态）。 */
export const isReagentControl = (name) => REAGENT_CONTROL_RE.test(String(name || '').trim())

/** 是否进 P0 展开区（code 白名单；姓名兜底的尿三项；危急值强制升 P0）。 */
export const isP0 = (row = {}) =>
  !!criticalOf(row) || P0_CODES.has(row.code || '') || URINE_P0_RE.test(String(row.name || ''))

/** missingBasics：血液科门诊必须有的项。缺失时卡面必须显式写「未提供」（没查 ≠ 没给我）。 */
export const REQUIRED_BASICS = [
  { code: 'WBC', label: '白细胞(WBC)' },
  { code: 'Hb', label: '血红蛋白(Hb)' },
  { code: 'PLT', label: '血小板(PLT)' },
  { code: 'NEUT_ABS', label: '中性粒细胞绝对值(ANC)' },
  { code: 'PT', label: '凝血酶原时间(PT)' },
  { code: 'APTT', label: '活化部分凝血活酶时间(APTT)' },
  { code: 'FIB', label: '纤维蛋白原(FIB)' },
  { code: 'LDH', label: '乳酸脱氢酶(LDH)' },
]

/** 数据时效阈值：最近一次有指标的化验超过这么多天 → 卡面必须提醒（防医生把 100 天前的数当本周的）。 */
export const STALE_DAYS = 90

/** 计算「距今天数」。today 可注入，便于测试固定时间。 */
export function daysAgo(dateStr, today = new Date()) {
  const d = String(dateStr || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  const t = new Date(`${d}T00:00:00`)
  if (Number.isNaN(t.getTime())) return null
  const base = new Date(today)
  base.setHours(0, 0, 0, 0)
  return Math.round((base.getTime() - t.getTime()) / 86400000)
}

// ===================== 2026-11-14：第 1 页「疾病标签与安全基线」口径 =====================
// 设计原则：**只提取、不推断**。抓到就给值，抓不到就给「未录入 / 待核」，绝不猜。
// 数据形状注意（真实数据实测）：
//   BCR::ABL1（P190型）的 value 是空串，阳性信息在 status='positive' 里 → 必须读 status；
//   Rh(D) 血型 value 为空 → 只能显示「待核」；
//   HBsAg / Anti-HCV / Anti-HIV / Anti-TP 的 value 全为空 → 显示「未录入」（≠「阴性」）。

/** 分子与高危基因标签：命中即置顶（阳性优先）。 */
export const DISEASE_TAG_PATTERNS = [
  { re: /BCR[:\s]*ABL/i, label: 'BCR::ABL1' },
  { re: /TP53/i, label: 'TP53' },
  { re: /KMT2A|MLL/i, label: 'KMT2A' },
  { re: /IKZF1/i, label: 'IKZF1' },
  { re: /MRD|微小残留|残留病/i, label: 'MRD' },
  // 2026-11-14 用户口径：初诊流式的「异常细胞占有核细胞比例」不是 MRD，也不能笼统叫「原始细胞比例」——
  // 它就是初诊时的异常细胞占比（基线）。复查时才由 intakeCard 的后处理改标 MRD。
  { re: /异常细胞占/, label: '初诊异常细胞' },
  { re: /骨髓原始|原始细胞比例|BM_BLAST/i, label: '原始细胞比例' },
  { re: /CD34/i, label: 'CD34+' },
  { re: /融合基因/i, label: '融合基因' },
  { re: /染色体|核型|KARYOTYPE/i, label: '染色体核型' },
  { re: /突变|MUTATION/i, label: '基因突变' },
]

/** 初诊基线峰值：血常规主项 + LDH（按 code，避免「白细胞」与「白细胞计数」两个名字被当成两项）。 */
export const BASELINE_CODES = [
  { code: 'WBC', label: 'WBC' },
  { code: 'LDH', label: 'LDH' },
]

/** 治疗安全基线：传染病四项（都是「必须知道」的安全项，不是诊断项）。 */
export const INFECTION_CODES = [
  { code: 'HBSAG', label: '乙肝 HBsAg' },
  { code: 'ANTI_HCV', label: '丙肝抗体' },
  { code: 'ANTI_HIV', label: 'HIV 抗体' },
  { code: 'ANTI_TP', label: '梅毒抗体' },
]

/** 血型（ABO + Rh 分开查：真实数据里 ABO 有值、Rh 为空）。 */
export const BLOOD_TYPE_CODES = [
  { code: 'ABO', label: 'ABO' },
  { code: 'RH_D', label: 'Rh(D)' },
]

/** 系统分组旁的通俗注释（给家属/非专科医生读，不是诊断结论）。 */
export const CATEGORY_HINTS = {
  血常规及骨髓: '看贫血、感染、出血风险与残留病',
  凝血功能: '评估出血 / 血栓风险',
  生化与肝肾功: '化疗药物代谢与脏器耐受',
  炎症与免疫: '提示感染 / 炎症程度',
  尿便与血气: '感染灶、酸碱与氧合',
  其他感染筛查: '输血与用药前的安全筛查',
  其他: '',
}
