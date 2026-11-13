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

/** P0 核心码（正面展开）。按 code 判，不按分组名判 —— 分组会随目录调整漂移。 */
export const P0_CODES = new Set([
  // 血常规（v3：WBC/ANC/Hb/PLT/网织红；其余 CBC 项一并展开，医生看单子本来就是整张看）
  'WBC', 'NEUT_ABS', 'Hb', 'PLT', 'RET', 'NRBC', 'HCT', 'RBC',
  'NEUT_PCT', 'LYM_PCT', 'MONO_PCT', 'EO_PCT', 'BASO_PCT',
  'LYM_ABS', 'MONO_ABS', 'EO_ABS', 'BASO_ABS',
  'MCV', 'MCH', 'MCHC', 'RDW_CV', 'RDW_SD', 'PLT_PCT', 'PDW', 'MPV', 'P_LCR',
  // 凝血
  'PT', 'APTT', 'FIB', 'D_DIMER', 'INR', 'PTR', 'TT', 'FDP', 'AT3',
  // 肝肾功 / 电解质
  'ALT', 'AST', 'GGT', 'ALP', 'TBIL', 'DBIL', 'IBIL', 'TP', 'ALB', 'GLOB', 'AG_RATIO',
  'CREA', 'BUN', 'UA', 'LDH', 'HBDH', 'GLU', 'CK', 'CK_MB',
  'K', 'NA', 'CL', 'CA', 'CO2',
  // 炎症 / 感染
  'CRP', 'HS_CRP', 'PCT', 'IL6', 'ESR', 'NT_PROBNP',
  // 疾病特异（骨髓 / 流式 / MRD / 遗传）—— 血液科最先看
  'BM_BLAST_PCT', 'MRD', 'FCM_MRD_PCT', 'FCM_CD34_PCT',
  'custom:fcm-gran-pct', 'custom:fcm-lymph-pct', 'custom:fcm-mono-pct', 'custom:fcm-nrbc-pct',
  'BCR_ABL1', 'FUSION', 'KARYOTYPE', 'MUTATION',
  // 铁代谢
  'FERRITIN', 'FE', 'TSAT', 'FOLATE', 'VB12',
  // 跨科高危：血气乳酸（v3 点名）
  'LAC',
  // 尿：潜血 / 尿白细胞 / 尿红细胞 —— 永远 P0（用户 2026-11-13 拍板）
  'U_ERY', 'U_LEU', 'U_NS_RBC',
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

/** 是否进 P0 展开区（code 白名单；危急值强制升 P0）。 */
export const isP0 = (row = {}) => !!criticalOf(row) || P0_CODES.has(row.code || '')

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
