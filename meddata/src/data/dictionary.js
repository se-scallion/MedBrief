// ===================== MedData-AI 标准化字典 =====================
// 报告归类体系（血常规 / 血常规+超敏CRP / 肝功 / 肝功+肾功+离子 / 凝血 / 心肌 / 甲功 / 真菌）+ 标准字段 + 同义词映射表

import { mapUserAlias } from './userAlias.js'
import { PATCHES } from './patches.js'
import { applyPatches } from './applyPatches.js'

export const REPORT_TYPES = [
  { code: 'CBC', label: '全血细胞分析', keyFields: ['WBC', 'RBC', 'Hb', 'HCT', 'PLT', 'NEUT_ABS', 'NEUT_PCT', 'LYM_ABS', 'LYM_PCT', 'MONO_ABS', 'MONO_PCT', 'EO_ABS', 'EO_PCT', 'BASO_ABS', 'BASO_PCT', 'RET_ABS', 'RET_PCT'] },
  { code: 'CBC_hsCRP', label: '全血细胞分析 + 超敏C反应蛋白', keyFields: ['WBC', 'RBC', 'Hb', 'HCT', 'PLT', 'NEUT_ABS', 'NEUT_PCT', 'LYM_ABS', 'MONO_ABS', 'HS_CRP'] },
  { code: 'LIVER', label: '肝功能', keyFields: ['ALT', 'AST', 'TBIL', 'DBIL', 'ALB', 'ALP', 'GGT', 'TP_PROTEIN'] },
  { code: 'LIVER_KIDNEY_ION', label: '肝功能 + 肾功能 + 离子', keyFields: ['ALT', 'AST', 'TBIL', 'DBIL', 'ALB', 'Cr', 'BUN', 'K', 'Na', 'Cl', 'Ca'] },
  { code: 'COAGULATION', label: '凝血六项', keyFields: ['PT', 'PT_PCT', 'INR', 'APTT', 'FIB', 'TT', 'D_DIMER'] },
  { code: 'CARDIAC', label: '心肌四项', keyFields: ['CTNI', 'CK_MB', 'MYO', 'NT_PROBNP', 'BNP'] },
  { code: 'THYROID', label: '甲功七项', keyFields: ['TSH', 'FT3', 'FT4', 'TT3', 'TT4', 'TPOAB', 'TGAB'] },
  { code: 'FUNGUS', label: '真菌 G+GM 试验', keyFields: ['G_TEST', 'GM_TEST'] },
  { code: 'URINALYSIS', label: '尿常规', keyFields: ['UGLU', 'UPRO', 'UBIL', 'URO', 'UKET', 'UNIT', 'UBLD', 'ULEU', 'URBC', 'USG', 'UPH', 'UVC'] },
  { code: 'INFECTION', label: '感染八项', keyFields: ['HBsAg', 'HBsAb', 'HBeAg', 'HBeAb', 'HBcAb', 'HCV', 'TP', 'HIV'] },
  { code: 'STOOL', label: '便常规', keyFields: ['STOOL_OB', 'STOOL_WBC', 'STOOL_RBC'] },
  { code: 'BLOOD_TYPE', label: '血型鉴定', keyFields: ['ABO', 'RH_D'] },
  { code: 'ANEMIA', label: '贫血组合', keyFields: ['FERR', 'FOLATE', 'VIT_B12'] },
  { code: 'EPO', label: '促红细胞生成素', keyFields: ['EPO'] },
  { code: 'BIOCHEM', label: '生化全项', keyFields: ['ALT', 'AST', 'TBIL', 'DBIL', 'ALB', 'TP_PROTEIN', 'BUN', 'Cr', 'K', 'Na', 'Cl', 'Ca', 'CA_P_PRODUCT', 'GLU', 'TC', 'TG'] },
  { code: 'BONE_MARROW_MORPHOLOGY', label: '骨髓形态学（涂片分类）', keyFields: ['MYELOBLAST_BF', 'MYELOBLAST_MF', 'PROMYELO_BF', 'PROMYELO_MF', 'NEU_MYEL_BF', 'NEU_MYEL_MF', 'NEU_META_BF', 'NEU_META_MF', 'NEU_BAND_BF', 'NEU_BAND_MF', 'NEU_SEG_BF', 'NEU_SEG_MF', 'EOS_BF', 'EOS_MF', 'BASO_BF', 'BASO_MF', 'LYMBLAST_BF', 'LYMBLAST_MF', 'IMMLYM_BF', 'IMMLYM_MF', 'LYM_BF', 'LYM_MF', 'MONO_BF', 'MONO_MF', 'ERY_BF', 'ERY_MF', 'MEGA', 'ME_RATIO', 'BF_WBC', 'MF_NC'] },
  // 流式免疫分型（FCM-MRD）：业务上同样是检验科出的检验报告（化验通道），
  // 但其结果不是表格而是「印象/结论」里的一个 MRD 百分比 + 一堆散点图，
  // 故化验通道对它只转录一行 MRD 结果（见 buildDocReadLabPrompt C 类口径）。
  { code: 'FLOW_CYTOMETRY', label: '流式免疫分型', keyFields: ['FCM_MRD'] },
  // 白血病融合基因定量（BCR-ABL1 P190/P210/P230）：化验性质，可定性（阴性/阳性）+ 定量（%）
  { code: 'FUSION_PCR', label: '融合基因定量', keyFields: ['BCR_ABL1_P190_Q', 'BCR_ABL1_P190_PCT', 'BCR_ABL1_P210_Q', 'BCR_ABL1_P210_PCT', 'BCR_ABL1_P230_Q', 'BCR_ABL1_P230_PCT'] },
  { code: 'UNKNOWN', label: '未识别', keyFields: [] },
]

// ===================== 检验报告列表分类（合并 + 短名） =====================
// 列表筛选用的「粗分类」：把明细 report_type 合并成更少的短名 Tab（如 全血细胞分析+超敏CRP → 血常规；
// 肝功能 / 肝功肾功离子 / 生化全项 / 含肝功肾功离子血糖血脂的动态组合 → 生化）。
// 顺序即归类优先级：动态组合 code（'A+B+C'）按检测组交集取「排在前面」的分类。
export const RECORD_CATEGORIES = [
  { key: 'CBC', label: '血常规', codes: ['CBC', 'CBC_hsCRP'], groups: ['CBC', 'HS_CRP'] },
  { key: 'BIOCHEM', label: '生化', codes: ['BIOCHEM', 'LIVER', 'LIVER_KIDNEY_ION'], groups: ['LIVER', 'KIDNEY', 'ION', 'GLU', 'LIPID'] },
  { key: 'COAGULATION', label: '凝血', codes: ['COAGULATION'], groups: [] },
  { key: 'ANEMIA', label: '贫血', codes: ['ANEMIA', 'EPO'], groups: ['ANEMIA', 'EPO'] },
  { key: 'BONE_MARROW', label: '骨髓', codes: ['BONE_MARROW_MORPHOLOGY'], groups: ['BONE_MARROW'] },
  { key: 'FLOW', label: '流式', codes: ['FLOW_CYTOMETRY'], groups: ['FLOW'] },
  { key: 'FUSION', label: '融合基因', codes: ['FUSION_PCR'], groups: ['FUSION'] },
  // 用户口径（2026-10-27）：「心肌」是部位名、不是老百姓口中的指标名 → 改「心脏指标」。
  { key: 'CARDIAC', label: '心脏指标', codes: ['CARDIAC'], groups: [] },
  { key: 'THYROID', label: '甲功', codes: ['THYROID'], groups: [] },
  { key: 'URINALYSIS', label: '尿常规', codes: ['URINALYSIS'], groups: [] },
  { key: 'STOOL', label: '便常规', codes: ['STOOL'], groups: ['STOOL'] },
  { key: 'BLOOD_TYPE', label: '血型', codes: ['BLOOD_TYPE'], groups: ['BLOOD_TYPE'] },
  // 用户口径（2026-10-27）：真菌 G/GM 试验并入「感染」——老百姓找的是"有没有感染"，
  // 不会单独去找一个只有 1 条数据的「真菌」分类。明细 report_type=FUNGUS 保持不变。
  { key: 'INFECTION', label: '感染', codes: ['INFECTION', 'FUNGUS'], groups: ['INFECTION', 'FUNGUS'] },
  // 基因检测 / 染色体核型 / 突变（检验科图文报告）：**可升级分类**——见 CATEGORY_SIZE_POLICY，
  // 报告份数够多（>5）才单独占一格，份数少时并入「其他」，不为偶尔一两份占一条筛选位。
  { key: 'MOLECULAR', label: '基因检测', codes: [], groups: [] },
]
export const OTHER_CATEGORY = { key: 'OTHER', label: '其他' }

// ---------- 展示级分类合并（不改数据口径，只影响筛选条 tab 的个数）----------
// 动因（用户 2026-10-24）：骨髓形态学 / 流式免疫分型 / 融合基因同属「骨穿相关」报告，
// 数量都很少，列表页分成三个 tab 只让筛选条变长、并不能帮人更快找到东西 → 展示时合并成一个。
// 原则：**只合并语义同族且数量少的分类**，不为合并而合并；其它分类（血常规/生化/凝血…）保持独立。
// 命名（用户 2026-10-27 定稿）：叫「骨髓检查」而不是「骨髓报告」——与报告自己的抬头
// 「骨髓细胞形态检查图文报告」一致，且「骨穿」是操作名、不能拿来当报告分类名。
export const CATEGORY_GROUPS = [
  { key: 'MARROW', label: '骨髓检查', members: ['BONE_MARROW', 'FLOW', 'FUSION'] },
]
const CATEGORY_GROUP_BY_MEMBER = new Map()
for (const g of CATEGORY_GROUPS) for (const m of g.members) CATEGORY_GROUP_BY_MEMBER.set(m, g)

// ---------- 分类规模策略（展示级，用户 2026-10-27 定稿）----------
// 规则来自用户原话：「其他里边都是 6 个基因检测 —— 数量超过 5 个的时候可以考虑单独分类；
// 当分类数量为 1 个的时候，考虑合并。」
//   · 可升级分类（PROMOTABLE）：份数 ≥ promoteMin(6) 才单独成 tab，否则并入「其他」；
//   · 任一分类只有 1 份（foldWhen）：不值得单独占一条筛选位 → 并入「其他」；
//   · 「其他」自身始终保留并汇总被折叠的份数。
// 只在**展示层**生效：数据里的 report_type / kind 一律不动，折叠后仍可用搜索与「全部」找到。
export const CATEGORY_SIZE_POLICY = { promoteMin: 6, foldWhen: 1 }
export const PROMOTABLE_CATEGORIES = ['MOLECULAR']

/**
 * 按规模策略整理筛选条分类。
 * @param {Array<{value:string,label:string,count:number}>} items 已按明细口径统计好的分类
 * @returns {Array<{value,label,count,folded?:string[]}>} 折叠后的分类（「其他」汇总被折叠的份数）
 */
export function applyCategorySizePolicy(items, opts = {}) {
  const { promoteMin, foldWhen } = { ...CATEGORY_SIZE_POLICY, ...opts }
  const otherKey = OTHER_CATEGORY.key
  const otherLabel = OTHER_CATEGORY.label
  const kept = []
  const foldedMembers = []
  let foldedCount = 0
  for (const it of items) {
    if (it.value === otherKey) continue // 「其他」最后统一补（汇总被折叠的份数）
    const promotable = PROMOTABLE_CATEGORIES.includes(it.value)
    const tooFew = promotable ? it.count < promoteMin : it.count <= foldWhen
    if (tooFew) {
      foldedMembers.push(it.value)
      foldedCount += it.count
      continue
    }
    kept.push({ ...it, members: it.members || [it.value] })
  }
  const existingOther = items.find((it) => it.value === otherKey)
  const otherCount = (existingOther ? existingOther.count : 0) + foldedCount
  if (otherCount > 0) {
    kept.push({
      value: otherKey,
      label: otherLabel,
      count: otherCount,
      // 被折叠的明细分类 key 都在这里：列表筛选时「其他」要能命中它们
      members: [otherKey, ...foldedMembers, ...((existingOther && existingOther.members) || [])],
    })
  }
  return kept
}

/** 明细分类 key → 展示分类（未合并的返回 null，表示保持自身） */
export function mergedCategoryOf(key) {
  const g = CATEGORY_GROUP_BY_MEMBER.get(key)
  return g ? { key: g.key, label: g.label } : null
}

// 指标分组（STANDARD_FIELDS.group）→ 报告分类：指标页的锚点索引复用报告页同一套分类，
// 避免 17 个分组各占一个 chip（用户 2026-10-24：「指标页顶部的索引太多了」）。
export const FIELD_GROUP_CATEGORY = {
  血常规: 'CBC',
  炎症指标: 'CBC',
  肝功能: 'BIOCHEM',
  肾功能: 'BIOCHEM',
  离子: 'BIOCHEM',
  血糖: 'BIOCHEM',
  血脂: 'BIOCHEM',
  凝血: 'COAGULATION',
  贫血: 'ANEMIA',
  心肌: 'CARDIAC',
  甲功: 'THYROID',
  尿常规: 'URINALYSIS',
  便常规: 'STOOL',
  血型: 'BLOOD_TYPE',
  感染八项: 'INFECTION',
  真菌: 'FUNGUS',
  骨髓形态学: 'MARROW',
  流式免疫分型: 'MARROW',
  融合基因: 'MARROW',
}

// 精确实例 + 动态组合组名 → 分类 key（O(1) 命中，按 RECORD_CATEGORIES 顺序建表）
const CAT_BY_CODE = new Map()
const CAT_BY_GROUP = new Map()
for (const cat of RECORD_CATEGORIES) {
  for (const c of cat.codes) if (!CAT_BY_CODE.has(c)) CAT_BY_CODE.set(c, cat.key)
  for (const g of cat.groups) if (!CAT_BY_GROUP.has(g)) CAT_BY_GROUP.set(g, cat.key)
}

// code → 列表分类 key：静态 code 精确命中 → 动态组合（'A+B'）按检测组交集取排在前面的分类 → 兜底 OTHER
export function recordCategoryOf(code) {
  if (!code) return OTHER_CATEGORY.key
  if (CAT_BY_CODE.has(code)) return CAT_BY_CODE.get(code)
  // 直接传「分类 key」时原样返回（如图文报告映射出的 'MOLECULAR'——它没有专属 report_type code）
  if (RECORD_CATEGORIES.some((c) => c.key === code)) return code
  if (code.includes('+')) {
    for (const g of code.split('+')) {
      if (CAT_BY_GROUP.has(g)) return CAT_BY_GROUP.get(g)
    }
  }
  return OTHER_CATEGORY.key
}

// ===================== 动态组合报告类型 =====================
// 真实医院报告组合无穷无尽（肝功能+肾功能+离子+血糖+血脂…），静态预置列表覆盖不全。
// 因此 detectReportType 对「组合体系」按识别到的检测组动态拼接 code（如 'LIVER+KIDNEY+ION+GLU+LIPID'），
// label 由 reportTypeLabel() 按组名自动生成「肝功能 + 肾功能 + 离子 + 血糖 + 血脂」。

// 检测组 → 展示名
export const REPORT_GROUPS = {
  CBC: '全血细胞分析',
  HS_CRP: '超敏C反应蛋白',
  LIVER: '肝功能',
  KIDNEY: '肾功能',
  ION: '离子',
  GLU: '血糖',
  LIPID: '血脂',
  INFECTION: '感染八项',
  STOOL: '便常规',
  BLOOD_TYPE: '血型鉴定',
  ANEMIA: '贫血组合',
  EPO: '促红细胞生成素',
  BONE_MARROW: '骨髓形态学',
  FLOW: '流式免疫分型',
  FUSION: '融合基因',
  UNKNOWN: '未识别',
}

// 检测组 → 特征字段（命中任一字段即视为该组存在）
export const GROUP_FIELD_SETS = {
  CBC: ['WBC', 'RBC', 'Hb', 'HCT', 'PLT', 'RET_ABS', 'RET_PCT'],
  HS_CRP: ['HS_CRP'],
  LIVER: ['ALT', 'AST', 'TBIL', 'DBIL', 'ALB', 'ALP', 'GGT', 'TP_PROTEIN'],
  KIDNEY: ['Cr', 'BUN', 'UA', 'CYS_C'],
  ION: ['K', 'Na', 'Cl', 'Ca', 'P', 'Mg'],
  GLU: ['GLU'],
  LIPID: ['TC', 'TG', 'HDL_C', 'LDL_C', 'VLDL_C', 'APOA', 'APOB', 'LPA'],
  INFECTION: ['HBsAg', 'HBsAb', 'HBeAg', 'HBeAb', 'HBcAb', 'HCV', 'TP', 'HIV'],
  STOOL: ['STOOL_OB', 'STOOL_WBC', 'STOOL_RBC'],
  ANEMIA: ['FERR', 'FOLATE', 'VIT_B12'],
  EPO: ['EPO'],
  BONE_MARROW: ['MYELOBLAST_BF', 'MYELOBLAST_MF', 'PROMYELO_BF', 'PROMYELO_MF', 'NEU_MYEL_BF', 'NEU_MYEL_MF', 'NEU_META_BF', 'NEU_META_MF', 'NEU_BAND_BF', 'NEU_BAND_MF', 'NEU_SEG_BF', 'NEU_SEG_MF', 'EOS_BF', 'EOS_MF', 'BASO_BF', 'BASO_MF', 'LYMBLAST_BF', 'LYMBLAST_MF', 'IMMLYM_BF', 'IMMLYM_MF', 'LYM_BF', 'LYM_MF', 'MONO_BF', 'MONO_MF', 'ERY_BF', 'ERY_MF', 'MEGA', 'ME_RATIO', 'BF_WBC', 'MF_NC'],
  FLOW: ['FCM_MRD'],
  FUSION: ['BCR_ABL1_P190_Q', 'BCR_ABL1_P190_PCT', 'BCR_ABL1_P210_Q', 'BCR_ABL1_P210_PCT', 'BCR_ABL1_P230_Q', 'BCR_ABL1_P230_PCT'],
}

// 常见组合 key → 静态预置 code（兼容存量数据：'LIVER+KIDNEY+ION' → 旧 code 'LIVER_KIDNEY_ION'）
export const STATIC_COMBO = {
  'CBC': 'CBC',
  'CBC+HS_CRP': 'CBC_hsCRP',
  'LIVER': 'LIVER',
  'LIVER+KIDNEY+ION': 'LIVER_KIDNEY_ION',
}

// code → 展示名（静态命中用静态 label；动态组合 code 按组拼接）
export function reportTypeLabel(code) {
  if (!code) return ''
  if (code === 'GENERIC') return '其他 / 通用'
  const st = REPORT_TYPES.find((t) => t.code === code)
  if (st) return st.label
  return code.split('+').map((g) => REPORT_GROUPS[g] || g).join(' + ')
}

// code → 重点字段列表（动态组合 code 展开为各组的特征字段，供 DataGrid「本报告重点字段」/「新增行」使用）
export function reportTypeKeyFields(code) {
  const st = REPORT_TYPES.find((t) => t.code === code)
  if (st) return st.keyFields
  if (!code) return []
  return code.split('+').flatMap((g) => GROUP_FIELD_SETS[g] || [])
}

// 仅返回「已被当前数据实际命中组」对应的关键字段。
// 目的：避免 reportType 多声明了某个「完全没出现」的组（如生化单被误判含 CBC）时，
// 自动补齐补出无关项。命中判定：某组在 existingCodes 中至少命中 1 个特征字段即视为该组存在。
// 注意：若某组是因 OCR 误识别（如把肌酐误识别成 Hb）而被「命中」，本函数仍会保留该组——
// 这种情况需先修正 reportType 或 OCR 根因，而非本函数能拦截。
export function reportTypeKeyFieldsMatched(reportType, existingCodes) {
  const allFields = reportTypeKeyFields(reportType)
  const codes = Array.isArray(existingCodes) ? existingCodes.filter(Boolean) : []
  if (codes.length === 0) return allFields
  const groupsOf = (code) => {
    const gs = []
    for (const g of Object.keys(GROUP_FIELD_SETS)) {
      if (GROUP_FIELD_SETS[g].includes(code)) gs.push(g)
    }
    return gs
  }
  const hitGroups = new Set()
  for (const c of codes) {
    for (const g of groupsOf(c)) hitGroups.add(g)
  }
  return allFields.filter((code) => {
    const gs = groupsOf(code)
    if (gs.length === 0) return true // 未在组内登记的字段，保守保留
    return gs.some((g) => hitGroups.has(g))
  })
}

// 标准字段定义（含默认单位 / 参考范围，用于自动补全与参考区间带）
export const STANDARD_FIELDS = [
  // ---- 血常规 ----
  { code: 'WBC', name: '白细胞计数', unit: '10^9/L', ref: '3.5-9.5', group: '血常规' },
  { code: 'RBC', name: '红细胞计数', unit: '10^12/L', ref: '4.3-5.8', group: '血常规' },
  { code: 'Hb', name: '血红蛋白', unit: 'g/L', ref: '130-175', group: '血常规' },
  { code: 'HCT', name: '红细胞压积', unit: '%', ref: '40-50', group: '血常规' },
  { code: 'MCV', name: '平均红细胞体积', unit: 'fL', ref: '82-100', group: '血常规' },
  { code: 'MCH', name: '平均血红蛋白量', unit: 'pg', ref: '27-34', group: '血常规' },
  { code: 'MCHC', name: '平均血红蛋白浓度', unit: 'g/L', ref: '316-354', group: '血常规' },
  { code: 'PLT', name: '血小板计数', unit: '10^9/L', ref: '125-350', group: '血常规' },
  { code: 'NEUT_ABS', name: '中性粒细胞绝对值', unit: '10^9/L', ref: '1.8-6.3', group: '血常规' },
  { code: 'NEUT_PCT', name: '中性粒细胞百分比', unit: '%', ref: '40-75', group: '血常规' },
  { code: 'LYM_ABS', name: '淋巴细胞绝对值', unit: '10^9/L', ref: '1.1-3.2', group: '血常规' },
  { code: 'LYM_PCT', name: '淋巴细胞百分比', unit: '%', ref: '20-50', group: '血常规' },
  { code: 'MONO_ABS', name: '单核细胞绝对值', unit: '10^9/L', ref: '0.1-0.6', group: '血常规' },
  { code: 'MONO_PCT', name: '单核细胞百分比', unit: '%', ref: '3-10', group: '血常规' },
  { code: 'EO_ABS', name: '嗜酸性粒细胞绝对值', unit: '10^9/L', ref: '0.02-0.52', group: '血常规' },
  { code: 'EO_PCT', name: '嗜酸性粒细胞百分比', unit: '%', ref: '0.4-8', group: '血常规' },
  { code: 'BASO_ABS', name: '嗜碱性粒细胞绝对值', unit: '10^9/L', ref: '0-0.06', group: '血常规' },
  { code: 'BASO_PCT', name: '嗜碱性粒细胞百分比', unit: '%', ref: '0-1', group: '血常规' },
  { code: 'RDW_SD', name: '红细胞体积分布宽度-SD', unit: 'fL', ref: '40-53', group: '血常规' },
  { code: 'RDW_CV', name: '红细胞体积分布宽度-CV', unit: '%', ref: '0-15', group: '血常规' },
  { code: 'PDW', name: '血小板体积分布宽度', unit: 'fL', ref: '9-17', group: '血常规' },
  { code: 'MPV', name: '平均血小板体积', unit: 'fL', ref: '6.8-13.5', group: '血常规' },
  { code: 'PLT_PCT', name: '血小板压积', unit: '%', ref: '0.11-0.27', group: '血常规' },
  { code: 'P_LCR', name: '大型血小板比率', unit: '%', ref: '13-43', group: '血常规' },
  { code: 'NRBC_PCT', name: '有核红细胞百分比', unit: '%', ref: '0-0.5', group: '血常规' },
  { code: 'NRBC_ABS', name: '有核红细胞数', unit: '10^9/L', ref: '0-0.03', group: '血常规' },
  { code: 'RET_ABS', name: '网织红细胞绝对值', unit: '10^9/L', ref: '35.8-99.6', group: '血常规' },
  { code: 'RET_PCT', name: '网织红细胞百分比', unit: '%', ref: '0.83-2.24', group: '血常规' },
  { code: 'HS_CRP', name: '超敏C反应蛋白', unit: 'mg/L', ref: '0-5', group: '炎症指标' },
  // ---- 肝功能 ----
  { code: 'ALT', name: '丙氨酸氨基转移酶', unit: 'U/L', ref: '9-50', group: '肝功能' },
  { code: 'AST', name: '天门冬氨酸氨基转移酶', unit: 'U/L', ref: '15-40', group: '肝功能' },
  { code: 'TBIL', name: '总胆红素', unit: 'umol/L', ref: '3.4-20.5', group: '肝功能' },
  { code: 'DBIL', name: '直接胆红素', unit: 'umol/L', ref: '0-6.8', group: '肝功能' },
  { code: 'IBIL', name: '间接胆红素', unit: 'umol/L', ref: '1.7-13.7', group: '肝功能' },
  { code: 'ALB', name: '白蛋白', unit: 'g/L', ref: '40-55', group: '肝功能' },
  { code: 'TP_PROTEIN', name: '总蛋白', unit: 'g/L', ref: '65-85', group: '肝功能' },
  { code: 'ALP', name: '碱性磷酸酶', unit: 'U/L', ref: '45-125', group: '肝功能' },
  { code: 'GGT', name: 'γ-谷氨酰转移酶', unit: 'U/L', ref: '10-60', group: '肝功能' },
  { code: 'LDH', name: '乳酸脱氢酶', unit: 'U/L', ref: '120-250', group: '肝功能' },
  { code: 'TBA', name: '总胆汁酸', unit: 'umol/L', ref: '0-10', group: '肝功能' },
  { code: 'GLO', name: '球蛋白', unit: 'g/L', ref: '20-40', group: '肝功能' },
  { code: 'AG', name: '白球比', unit: '', ref: '1.2-2.4', group: '肝功能' },
  { code: 'CHE', name: '胆碱酯酶', unit: 'U/L', ref: '4620-11500', group: '肝功能' },
  { code: 'PA', name: '前白蛋白', unit: 'mg/L', ref: '200-430', group: '肝功能' },
  // ---- 肾功能 / 离子 ----
  { code: 'Cr', name: '肌酐', unit: 'umol/L', ref: '57-97', group: '肾功能' },
  { code: 'BUN', name: '尿素氮', unit: 'mmol/L', ref: '3.1-8.0', group: '肾功能' },
  { code: 'UA', name: '尿酸', unit: 'umol/L', ref: '208-428', group: '肾功能' },
  { code: 'K', name: '钾离子', unit: 'mmol/L', ref: '3.5-5.3', group: '离子' },
  { code: 'Na', name: '钠离子', unit: 'mmol/L', ref: '137-147', group: '离子' },
  { code: 'Cl', name: '氯离子', unit: 'mmol/L', ref: '99-110', group: '离子' },
  { code: 'Ca', name: '钙离子', unit: 'mmol/L', ref: '2.11-2.52', group: '离子' },
  { code: 'Mg', name: '镁离子', unit: 'mmol/L', ref: '0.75-1.02', group: '离子' },
  { code: 'P', name: '磷', unit: 'mmol/L', ref: '0.85-1.51', group: '离子' },
  { code: 'CA_P_PRODUCT', name: '钙磷乘积', unit: 'mg^2/dL^2', ref: '35-40', group: '离子' },
  { code: 'AST_ALT', name: 'AST/ALT 比值', unit: '', ref: '', group: '肝功能' },
  // ---- 凝血 ----
  { code: 'PT', name: '凝血酶原时间', unit: 's', ref: '11-15', group: '凝血' },
  { code: 'PT_PCT', name: '凝血酶原时间百分率', unit: '%', ref: '70-130', group: '凝血' },
  { code: 'INR', name: '国际标准化比值', unit: '', ref: '0.8-1.2', group: '凝血' },
  { code: 'APTT', name: '活化部分凝血活酶时间', unit: 's', ref: '25-35', group: '凝血' },
  { code: 'FIB', name: '纤维蛋白原', unit: 'g/L', ref: '2-4', group: '凝血' },
  { code: 'TT', name: '凝血酶时间', unit: 's', ref: '14-21', group: '凝血' },
  { code: 'D_DIMER', name: 'D-二聚体', unit: 'mg/L', ref: '0-0.5', group: '凝血' },
  { code: 'FDP', name: '纤维蛋白(原)降解产物', unit: 'ug/ml', ref: '0-5', group: '凝血' },
  // ---- 心肌 ----
  { code: 'CTNI', name: '肌钙蛋白I', unit: 'ng/mL', ref: '0-0.04', group: '心肌' },
  { code: 'CK_MB', name: '肌酸激酶同工酶', unit: 'U/L', ref: '0-25', group: '心肌' },
  { code: 'MYO', name: '肌红蛋白', unit: 'ng/mL', ref: '0-70', group: '心肌' },
  { code: 'NT_PROBNP', name: 'N端前脑钠肽', unit: 'pg/mL', ref: '0-125', group: '心肌' },
  // B型钠尿肽（BNP）与 N端前脑钠肽（NT-proBNP）是两种不同检测（BNP=活性激素本身，NT-proBNP=其代谢片段），
  // 单位同为 pg/mL 但参考范围不同，故独立字段，避免两者数值混算。
  { code: 'BNP', name: 'B型钠尿肽', unit: 'pg/mL', ref: '0-100', group: '心肌' },
  { code: 'HBDH', name: 'α-羟丁酸脱氢酶', unit: 'U/L', ref: '72-182', group: '心肌' },
  { code: 'CK', name: '肌酸激酶', unit: 'U/L', ref: '50-310', group: '心肌' },
  // ---- 肾功能（扩展）----
  { code: 'EGFR', name: '肾小球滤过率', unit: 'ml/min', ref: '', group: '肾功能' },
  // ---- 离子（扩展）----
  { code: 'CO2', name: '二氧化碳', unit: 'mmol/L', ref: '23.0-29.0', group: '离子' },
  { code: 'OSM', name: '渗透压', unit: 'mOsm/L', ref: '278.5-320', group: '离子' },
  { code: 'ANION_GAP', name: '阴离子间隙', unit: 'mmol/L', ref: '8-16', group: '离子' },
  // ---- 甲功 ----
  { code: 'TSH', name: '促甲状腺激素', unit: 'mIU/L', ref: '0.27-4.2', group: '甲功' },
  { code: 'FT3', name: '游离三碘甲状腺原氨酸', unit: 'pmol/L', ref: '3.1-6.8', group: '甲功' },
  { code: 'FT4', name: '游离甲状腺素', unit: 'pmol/L', ref: '12-22', group: '甲功' },
  { code: 'TT3', name: '总三碘甲状腺原氨酸', unit: 'nmol/L', ref: '1.3-3.1', group: '甲功' },
  { code: 'TT4', name: '总甲状腺素', unit: 'nmol/L', ref: '66-181', group: '甲功' },
  { code: 'TPOAB', name: '甲状腺过氧化物酶抗体', unit: 'IU/mL', ref: '0-34', group: '甲功' },
  { code: 'TGAB', name: '甲状腺球蛋白抗体', unit: 'IU/mL', ref: '0-115', group: '甲功' },
  // ---- 真菌（G 试验 / GM 试验）----
  { code: 'G_TEST', name: '真菌(1-3)-β-D葡聚糖', unit: 'pg/ml', ref: '0-60', group: '真菌' },
  { code: 'GM_TEST', name: '曲霉半乳甘露聚糖', unit: 'ug/l', ref: '0-0.25', group: '真菌' },
  // ---- 尿常规 ----
  { code: 'UGLU', name: '尿葡萄糖', unit: 'mmol/L', ref: '阴性', group: '尿常规' },
  { code: 'UPRO', name: '尿蛋白', unit: 'g/L', ref: '阴性', group: '尿常规' },
  { code: 'UBIL', name: '尿胆红素', unit: '', ref: '阴性', group: '尿常规' },
  { code: 'URO', name: '尿胆原', unit: '', ref: '阴性', group: '尿常规' },
  { code: 'UKET', name: '尿酮体', unit: '', ref: '阴性', group: '尿常规' },
  { code: 'UNIT', name: '亚硝酸盐', unit: '', ref: '阴性', group: '尿常规' },
  { code: 'UBLD', name: '尿隐血', unit: '', ref: '阴性', group: '尿常规' },
  { code: 'ULEU', name: '尿白细胞', unit: '', ref: '阴性', group: '尿常规' },
  { code: 'URBC', name: '尿红细胞', unit: '/HPF', ref: '阴性', group: '尿常规' },
  { code: 'USG', name: '尿比重', unit: '', ref: '1.003-1.032', group: '尿常规' },
  { code: 'UPH', name: '尿pH', unit: '', ref: '4.5-8.0', group: '尿常规' },
  { code: 'UVC', name: '维生素C', unit: 'mmol/L', ref: '', group: '尿常规' },
  // ---- 血糖 ----
  { code: 'GLU', name: '血糖', unit: 'mmol/L', ref: '3.9-6.1', group: '血糖' },
  // ---- 血脂 ----
  { code: 'TC', name: '总胆固醇', unit: 'mmol/L', ref: '0-5.2', group: '血脂' },
  { code: 'TG', name: '甘油三酯', unit: 'mmol/L', ref: '0-1.7', group: '血脂' },
  { code: 'HDL_C', name: '高密度脂蛋白胆固醇', unit: 'mmol/L', ref: '1.03-1.55', group: '血脂' },
  { code: 'LDL_C', name: '低密度脂蛋白胆固醇', unit: 'mmol/L', ref: '0-3.37', group: '血脂' },
  { code: 'VLDL_C', name: '极低密度脂蛋白', unit: 'mmol/L', ref: '0.08-0.62', group: '血脂' },
  { code: 'APOA', name: '载脂蛋白A1', unit: 'g/L', ref: '1.2-1.6', group: '血脂' },
  { code: 'APOB', name: '载脂蛋白B', unit: 'g/L', ref: '0.8-1.1', group: '血脂' },
  { code: 'LPA', name: '脂蛋白(a)', unit: 'mg/L', ref: '0-300', group: '血脂' },
  // ---- 感染八项（乙肝五项 + 丙肝 + 梅毒 + 艾滋病）----
  { code: 'HBsAg', name: '乙肝表面抗原', unit: '', ref: '阴性', group: '感染八项' },
  { code: 'HBsAb', name: '乙肝表面抗体', unit: '', ref: '阴性～阳性', group: '感染八项' },
  { code: 'HBeAg', name: '乙肝e抗原', unit: '', ref: '阴性', group: '感染八项' },
  { code: 'HBeAb', name: '乙肝e抗体', unit: '', ref: '阴性', group: '感染八项' },
  { code: 'HBcAb', name: '乙肝核心抗体', unit: '', ref: '阴性', group: '感染八项' },
  { code: 'HCV', name: '丙型肝炎病毒抗体', unit: '', ref: '阴性', group: '感染八项' },
  { code: 'TP', name: '梅毒螺旋体抗体', unit: '', ref: '阴性', group: '感染八项' },
  { code: 'HIV', name: 'HIV抗原抗体联合检测', unit: 'S/CO', ref: '0.00-1.00', group: '感染八项' },
  // ---- 便常规（大便常规）----
  { code: 'STOOL_OB', name: '大便隐血', unit: '', ref: '阴性', group: '便常规' },
  { code: 'STOOL_WBC', name: '粪便镜检白细胞', unit: '/HPF', ref: '阴性', group: '便常规' },
  { code: 'STOOL_RBC', name: '粪便镜检红细胞', unit: '/HPF', ref: '阴性', group: '便常规' },
  // ---- 血型鉴定 ----
  { code: 'ABO', name: 'ABO血型', unit: '', ref: '', group: '血型' },
  { code: 'RH_D', name: 'Rh(D)血型', unit: '', ref: '', group: '血型' },
  // ---- 贫血组合（铁蛋白 / 叶酸 / 维生素B12）----
  { code: 'FERR', name: '铁蛋白', unit: 'ng/mL', ref: '30-400', group: '贫血' },
  { code: 'FOLATE', name: '叶酸', unit: 'ng/mL', ref: '3.1-20.5', group: '贫血' },
  { code: 'VIT_B12', name: '维生素B12', unit: 'pg/mL', ref: '190-824', group: '贫血' },
  { code: 'EPO', name: '促红细胞生成素', unit: 'mIU/mL', ref: '2.6-19', group: '贫血' },
  // ---- 骨髓形态学（涂片分类：血片 + 骨髓片 有核细胞分类计数）----
  { code: 'MYELOBLAST_BF', name: '原始粒细胞-血片', unit: '%', ref: '0-1', group: '骨髓形态学' },
  { code: 'MYELOBLAST_MF', name: '原始粒细胞-骨髓片', unit: '%', ref: '0-2', group: '骨髓形态学' },
  { code: 'PROMYELO_BF', name: '早幼粒细胞-血片', unit: '%', ref: '0-1', group: '骨髓形态学' },
  { code: 'PROMYELO_MF', name: '早幼粒细胞-骨髓片', unit: '%', ref: '1-5', group: '骨髓形态学' },
  { code: 'NEU_MYEL_BF', name: '中性中幼粒细胞-血片', unit: '%', ref: '0-1', group: '骨髓形态学' },
  { code: 'NEU_MYEL_MF', name: '中性中幼粒细胞-骨髓片', unit: '%', ref: '5-10', group: '骨髓形态学' },
  { code: 'NEU_META_BF', name: '中性晚幼粒细胞-血片', unit: '%', ref: '0-2', group: '骨髓形态学' },
  { code: 'NEU_META_MF', name: '中性晚幼粒细胞-骨髓片', unit: '%', ref: '10-20', group: '骨髓形态学' },
  { code: 'NEU_BAND_BF', name: '中性杆状核粒细胞-血片', unit: '%', ref: '1-5', group: '骨髓形态学' },
  { code: 'NEU_BAND_MF', name: '中性杆状核粒细胞-骨髓片', unit: '%', ref: '10-20', group: '骨髓形态学' },
  { code: 'NEU_SEG_BF', name: '中性分叶核粒细胞-血片', unit: '%', ref: '40-70', group: '骨髓形态学' },
  { code: 'NEU_SEG_MF', name: '中性分叶核粒细胞-骨髓片', unit: '%', ref: '10-20', group: '骨髓形态学' },
  { code: 'EOS_BF', name: '嗜酸性粒细胞-血片', unit: '%', ref: '0.5-5', group: '骨髓形态学' },
  { code: 'EOS_MF', name: '嗜酸性粒细胞-骨髓片', unit: '%', ref: '0-5', group: '骨髓形态学' },
  { code: 'BASO_BF', name: '嗜碱性粒细胞-血片', unit: '%', ref: '0-1', group: '骨髓形态学' },
  { code: 'BASO_MF', name: '嗜碱性粒细胞-骨髓片', unit: '%', ref: '0-1', group: '骨髓形态学' },
  // 原始/幼稚淋巴细胞（ALL 的核心判据，形态学 CR 就看这一项）：
  // 曾因字典缺这两项，「原始淋巴细胞-骨髓片」被 LYM 子串抢码后去重丢掉，ALL 的 CR 依据整行消失
  // （2026-10-21 实测：骨穿双列表里原始/幼稚淋巴细胞两行在化验网格中被静默吞掉）。
  { code: 'LYMBLAST_BF', name: '原始淋巴细胞-血片', unit: '%', ref: '0', group: '骨髓形态学' },
  { code: 'LYMBLAST_MF', name: '原始淋巴细胞-骨髓片', unit: '%', ref: '0', group: '骨髓形态学' },
  { code: 'IMMLYM_BF', name: '幼稚淋巴细胞-血片', unit: '%', ref: '0', group: '骨髓形态学' },
  { code: 'IMMLYM_MF', name: '幼稚淋巴细胞-骨髓片', unit: '%', ref: '0', group: '骨髓形态学' },
  { code: 'LYM_BF', name: '淋巴细胞-血片', unit: '%', ref: '20-40', group: '骨髓形态学' },
  { code: 'LYM_MF', name: '淋巴细胞-骨髓片', unit: '%', ref: '5-20', group: '骨髓形态学' },
  { code: 'MONO_BF', name: '单核细胞-血片', unit: '%', ref: '3-8', group: '骨髓形态学' },
  { code: 'MONO_MF', name: '单核细胞-骨髓片', unit: '%', ref: '1-5', group: '骨髓形态学' },
  { code: 'ERY_BF', name: '有核红细胞-血片', unit: '%', ref: '0', group: '骨髓形态学' },
  { code: 'ERY_MF', name: '幼红细胞-骨髓片', unit: '%', ref: '15-25', group: '骨髓形态学' },
  // ---- 白血病融合基因定量（BCR-ABL1）----
  // 报告形态：序号 | 项目名称 | 测试结果 | 方法，通常两行：定性行（阴性/阳性）+ 定量行（0/793000=0%）。
  // 2026-10-22 用户报障：这类报告只识别出 1 项（定性行）——定量行因名字纯 ASCII 且未收录被网格丢弃。
  { code: 'BCR_ABL1_P190_Q', name: 'BCR-ABL1 P190融合基因', unit: '', ref: '阴性', group: '融合基因' },
  { code: 'BCR_ABL1_P190_PCT', name: 'BCR-ABL1 P190/ABL1（%）', unit: '%', ref: '', group: '融合基因' },
  { code: 'BCR_ABL1_P210_Q', name: 'BCR-ABL1 P210融合基因', unit: '', ref: '阴性', group: '融合基因' },
  { code: 'BCR_ABL1_P210_PCT', name: 'BCR-ABL1 P210/ABL1（%）', unit: '%', ref: '', group: '融合基因' },
  { code: 'BCR_ABL1_P230_Q', name: 'BCR-ABL1 P230融合基因', unit: '', ref: '阴性', group: '融合基因' },
  { code: 'BCR_ABL1_P230_PCT', name: 'BCR-ABL1 P230/ABL1（%）', unit: '%', ref: '', group: '融合基因' },
  // 流式免疫分型（FCM-MRD）：结果只有一行 MRD 百分比（或「未检出」「<0.01」）
  { code: 'FCM_MRD', name: '流式MRD残留', unit: '%', ref: '<0.01', group: '流式免疫分型' },
  { code: 'MEGA', name: '巨核细胞', unit: '个', ref: '', group: '骨髓形态学' },
  { code: 'ME_RATIO', name: '粒红比', unit: '', ref: '2-4:1', group: '骨髓形态学' },
  { code: 'BF_WBC', name: '血片共数白细胞', unit: '个', ref: '', group: '骨髓形态学' },
  { code: 'MF_NC', name: '骨髓片共数有核细胞', unit: '个', ref: '', group: '骨髓形态学' },
]

export const FIELD_BY_CODE = Object.fromEntries(STANDARD_FIELDS.map((f) => [f.code, f]))

// 「详细走势」页分组标题：按报告类型/系统聚合指标。键须与 STANDARD_FIELDS 的 group 完全一致。
export const GROUP_TITLE = {
  血常规: '血常规（计数 · 分类 · 指数）',
  炎症指标: '炎症指标',
  肝功能: '肝功能',
  肾功能: '肾功能',
  离子: '电解质（离子）',
  凝血: '凝血功能',
  心肌: '心肌损伤标志物',
  甲功: '甲状腺功能',
  真菌: '真菌检测',
  尿常规: '尿常规',
  血糖: '血糖',
  血脂: '血脂',
  感染八项: '感染八项',
  便常规: '便常规',
  血型: '血型',
  贫血: '贫血相关指标',
  骨髓形态学: '骨髓形态学（涂片分类计数）',
}

// 数据驱动的分组：根据「实际出现过的指标集合」从标准字典动态生成分组卡片清单。
// 仅纳入 fieldSet 中存在的指标；定性结果（阴性/血型等）也会被纳入，但 CBCDetailView 会按
// 是否有数值点自动过滤，故这里不必区分定量/定性。返回结构兼容既有 CBC_GROUPS（series:[{code}]）。
export function buildFieldGroups(fieldSet = []) {
  const set = new Set(fieldSet)
  const byGroup = new Map()
  for (const f of STANDARD_FIELDS) {
    if (!set.has(f.code)) continue
    if (!byGroup.has(f.group)) byGroup.set(f.group, [])
    byGroup.get(f.group).push({ code: f.code })
  }
  return [...byGroup.entries()].map(([group, series]) => ({
    key: group,
    title: GROUP_TITLE[group] || group,
    series,
  }))
}

// 同义词映射表：识别到的原始项目名 -> 标准字段
export const ALIAS_MAP = {
  WBC: ['白细胞计数', '白细胞', '白细胞数', '白血球', 'WBC', 'WBC#', '白细胞计数(WBC)', 'WRC'],
  RBC: ['红细胞计数', '红细胞', '红血球', 'RBC', '红细胞计数(RBC)'],
  Hb: ['血红蛋白', '血红蛋白浓度', '血红蛋白测定', 'HGB', 'HB', 'Hb', '血红蛋白(HGB)'],
  HCT: ['红细胞压积', '红细胞比容', '血细胞比容', 'HCT', 'HCT%', '红细胞压积(HCT)'],
  MCV: ['平均红细胞体积', '平均红细胞容积', 'MCV'],
  // 「平均红细胞血红蛋白含量」为各常见写法（含「含量」二字），缺了会被「血红蛋白」子串截走降级成 Hb
  MCH: ['平均血红蛋白量', '平均血红蛋白含量', '平均红细胞血红蛋白量', '平均红细胞血红蛋白含量', 'MCH'],
  MCHC: ['平均血红蛋白浓度', '平均红细胞血红蛋白浓度', 'MCHC'],
  PLT: ['血小板计数', '血小板', '血小板数', '血小板(PLT)', 'PLT', 'PLT#'],
  NEUT_ABS: ['中性粒细胞绝对值', '中性粒细胞计数', '中性粒细胞数', '中性粒细胞', '中性粒绝对值', 'NEUT#', 'NEUT', 'NEUT#绝对值', '中性粒细胞绝对值(NEUT#)'],
  NEUT_PCT: ['中性粒细胞百分比', '中性粒细胞百分率', '中性粒细胞比率', 'NEUT%', 'NEUTPCT', 'NEU'],
  LYM_ABS: ['淋巴细胞绝对值', '淋巴细胞计数', '淋巴细胞数', 'LYM#', 'LYM', '淋巴细胞绝对值(LYM#)'],
  LYM_PCT: ['淋巴细胞百分比', '淋巴细胞百分率', '淋巴细胞比率', 'LYM%', 'LYMPH%'],
  MONO_ABS: ['单核细胞绝对值', '单核细胞计数', '单核细胞数', '单核细胞', 'MONO#', 'MONO'],
  MONO_PCT: ['单核细胞百分比', '单核细胞百分率', '单核细胞比率', 'MONO%'],
  EO_ABS: ['嗜酸性粒细胞绝对值', '嗜酸性粒细胞计数', '嗜酸性粒细胞', '嗜酸粒细胞绝对值', 'EO#', 'EO'],
  // 注：'EO' 加入本组，与 EO_ABS 共享该别名词干；具体落 EO_ABS / EO_PCT 由
  // mapAliasWithUnit 的「单位量纲消歧」裁决（% → EO_PCT，*10^9/L → EO_ABS），
  // 修复 OCR 把 EO_PCT 行名读成「EO…」、单位却是 %、被错配成 EO_ABS 的漏配（case-TR-20260830-MINQ7R）。
  EO_PCT: ['嗜酸性粒细胞百分比', '嗜酸性粒细胞百分率', '嗜酸性粒细胞比率', '嗜酸性细胞', '嗜酸粒细胞百分比', 'EO%', 'EO'],
  BASO_ABS: ['嗜碱性粒细胞绝对值', '嗜碱性粒细胞计数', '嗜碱性粒细胞', 'BASO#', 'BASO'],
  BASO_PCT: ['嗜碱性粒细胞百分比', '嗜碱性粒细胞百分率', '嗜碱性粒细胞比率', 'BASO%'],
  RDW_SD: ['红细胞体积分布宽度-SD', '红细胞分布宽度SD', '红细胞分布宽度-SD', '红细胞分布宽度标准差', 'RDW-SD', 'RDWSD', 'RDW-SD(SD)'],
  RDW_CV: ['红细胞体积分布宽度-CV', '红细胞分布宽度CV', '红细胞分布宽度-CV', '红细胞分布宽度变异系数', '分布宽度变异系数', 'RDW-CV', 'RDWCV'],
  PDW: ['血小板体积分布宽度', '血小板分布宽度', 'PDW'],
  MPV: ['平均血小板体积', 'MPV'],
  PLT_PCT: ['血小板压积', '血小板比容', '血小板容积', 'PCT', '血小板压积(PCT)', '血小板积压'],
  // 有核红细胞：必须先于 RBC（红细胞）被匹配。名称如「有核红细胞百分比 NRBC%」含子串「红细胞」，
  // 若放在 RBC 后会被其短别名「红细胞」误配。依赖 mapAlias ③ 的最长别名优先规则保证命中本组。
  NRBC_PCT: ['有核红细胞百分比', '有核红细胞比率', '有核红细胞(NRBC)%', 'NRBC%', 'NRBCPCT', '有以红细胞百分比', '有以红细胞比率'],
  NRBC_ABS: ['有核红细胞数', '有核红细胞计数', '有核红细胞(NRBC)#', 'NRBC#', 'NRBC', 'NRBC计数'],
  RET_ABS: ['网织红细胞绝对值', '网织红细胞计数', '网织红细胞数', '网织红绝对值', 'RET#', 'RET#绝对值', '网织红细胞(RET#)', '网织红细胞绝对值(RET#)'],
  RET_PCT: ['网织红细胞百分比', '网织红细胞百分率', '网织红百分比', 'RET%', 'RETM', 'RET%百分比', '网织红细胞(RET%)', '网织红细胞百分比(RET%)'],
  // 大型血小板比率：报告常写作「P-LCR」或「大型血小板 P-LCR」。须收录 P-LCR 代码别名，
  // 否则 P-LCR 无法映射（且 P-LCR 含子串 CR 需在 ③ 子串匹配前被整名/前缀规则先命中，避免被误配成肌酐）。
  // 「大血小板比率」（无「型」字）是常见写法，缺了会被「血小板」子串截走降级成 PLT
  P_LCR: ['大型血小板比率', '大型血小板比例', '大型血小板', '大血小板比率', '大血小板比例', 'P-LCR', 'PLCR', '大型血小板P-LCR', '大型血小板PLCR'],
  HS_CRP: ['超敏C反应蛋白', '高敏C反应蛋白', '超敏CRP', 'hs-CRP', 'hsCRP', 'Hs-CRP', 'C反应蛋白(超敏)', 'HS-CRP', 'CRP', 'C反应蛋白', 'bCRP', 'BCRP', 'B-CRP'],
  ALT: ['丙氨酸氨基转移酶', '谷丙转氨酶', 'ALT', '丙氨酸转氨酶'],
  AST: ['天门冬氨酸氨基转移酶', '天冬氨酸氨基转移酶', '谷草转氨酶', 'AST', '门冬氨酸氨基转移酶'],
  TBIL: ['总胆红素', 'TBIL', '总胆红素(TBIL)'],
  DBIL: ['直接胆红素', 'DBIL', '直接胆红素(DBIL)', 'DEIL', 'BIL'],
  IBIL: ['间接胆红素', 'IBIL'],
  ALB: ['白蛋白', 'ALB', '白蛋白(ALB)'],
  ALP: ['碱性磷酸酶', 'ALP'],
  GGT: ['γ-谷氨酰转移酶', '谷氨酰转肽酶', 'γ-GT', 'GGT', 'oT', '谷氨酰基转移酶', 'Gs', 'GS'],
  // 检测方法后缀（如「白蛋白(溴甲酚绿法)」「钾(离子选择电极法)」）由 mapAlias 剥离括号后命中核心名
  LDH: ['乳酸脱氢酶', '乳酸脱氢酶(LDH)', 'LDH'],
  TBA: ['总胆汁酸', '总胆汁酸(TBA)', 'TBA'],
  GLO: ['球蛋白', '球蛋白(GLO)', 'GLO'],
  AG: ['白球比', '白球比(A/G)', '白蛋白/球蛋白', 'A/G', 'AG'],
  CHE: ['胆碱酯酶', '胆碱酯酶(CHE)', 'CHE'],
  // 前白蛋白别名必须收录（含「白蛋白」子串，否则会被 ALB 子串匹配误配）
  PA: ['前白蛋白', '前白蛋白(PA)', 'PA', 'PAB', 'PAb'],
  Cr: ['肌酐', '血肌酐', 'CREA', 'Cr', 'CRE', '肌酐(Cr)'],
  BUN: ['尿素氮', '血尿素氮', 'BUN', '尿素', 'Urea'],
  UA: ['尿酸', '血尿酸', 'UA', '尿酸(UA)'],
  K: ['钾', '钾离子', '血清钾', 'K', 'K+', '血钾'],
  Na: ['钠', '钠离子', '血清钠', 'Na', 'Na+', '血钠'],
  Cl: ['氯', '氯离子', '血清氯', 'Cl', 'Cl-', '血氯'],
  Ca: ['钙', '钙离子', '血清钙', 'Ca', 'Ca2+', '血钙', '总钙'],
  Mg: ['镁', '血镁', '镁(Mg)', 'Mg'],
  P: ['磷', '无机磷', '血磷', '磷(P)', 'P'],
  // 钙磷乘积：由钙(Ca)与磷(P)计算得出，报告常写为「钙磷乘积」「钙磷积」「Ca×P」。单位 mg²/dL²。
  // 「钙磅乘积」为 OCR 把「磷」读成「磅」的变体（真实反馈 TR-20260828-3DQWJ6）。
  CA_P_PRODUCT: ['钙磷乘积', '钙磷积', '钙磷乘积(Ca×P)', '钙磷乘积(CaxP)', 'Ca×P', 'CaP乘积', '钙磅乘积'],
  // AST/ALT 比值（AST:ALT）：肝功能报告比值行，易被 OCR 读作 AST:ALT/(AST:ALT) 并误配到 AST/ALT 单字段
  // 或 AG。组合别名长度 7 在 mapAlias ③ 最长子串优先下胜过单字 AST/ALT（长度 3），不误伤单字段行。
  AST_ALT: ['AST/ALT 比值', 'AST:ALT', 'AST/ALT', '(AST:ALT)', 'AST/ALT比值', 'AST:ALT比值', '天门冬氨酸/丙氨酸比值'],
  PT: ['凝血酶原时间', 'PT', '凝血酶原时间(PT)'],
  PT_PCT: ['凝血酶原时间百分率', 'PT%', '凝血酶原活动度'],
  INR: ['国际标准化比值', 'INR', '国际标准化比率'],
  APTT: ['活化部分凝血活酶时间', '活化部分凝血活酶时间(APTT)', 'APTT', '部分凝血活酶时间'],
  FIB: ['纤维蛋白原', 'FIB', 'FIBG', '纤维蛋白原(FIB)'],
  TT: ['凝血酶时间', 'TT', '凝血酶时间(TT)'],
  D_DIMER: ['D-二聚体', 'D-Dimer', 'D二聚体', 'D-D', 'D二聚体(D-Dimer)'],
  // 报告项目名「FDP 纤维蛋白（原）降解产物浓度」含全角括号 + 「浓度」后缀，收录全角/半角变体
  FDP: ['纤维蛋白（原）降解产物浓度', '纤维蛋白(原)降解产物浓度', '纤维蛋白（原）降解产物', '纤维蛋白(原)降解产物', '纤维蛋白原降解产物', '纤维蛋白降解产物', 'FDP'],
  CTNI: ['肌钙蛋白I', '肌钙蛋白', 'cTnI', 'CTNI', '高敏肌钙蛋白I'],
  CK_MB: ['肌酸激酶同工酶', '肌酸激酶同工酶MB', 'CK-MB', 'CKMB'],
  MYO: ['肌红蛋白', 'MYO', '肌红蛋白(MYO)'],
  // NT_PROBNP（N端前脑钠肽）与 BNP（B型钠尿肽）名称高度近似，且 3 字符的 'BNP' 参与 mapAlias ③ 子串匹配，
  // 会把「丢失连字符」的变体（NTPROBNP / NTproBNP / 'NT proBNP'）与「脑钠肽前体」一并吞成 BNP（v1.8.7 踩过，v1.8.8 修复）。
  // 故本组显式收录无连字符 / 无前缀变体，靠「最长别名优先」压过 'BNP'；新增/改动本组别名务必按 §5.3 实测变体落点。
  NT_PROBNP: ['N端前脑钠肽', 'N端脑钠肽前体', 'NT-proBNP', 'N端前B型脑钠肽', 'NTPROBNP', '脑钠肽前体'],
  // B型钠尿肽（BNP）：报告申请项目常写「B型钠尿肽」，明细项目名常简写「钠尿肽」（本机报告即此写法）。
  // 独立于 NT_PROBNP——「钠尿肽」（钠-尿-肽）与「脑钠肽」字不同；「N端前…」由 ⓪ 整体精确匹配先命中 NT_PROBNP。
  BNP: ['B型钠尿肽', 'B型脑钠肽', 'B型利钠肽', '脑钠肽', '钠尿肽', 'BNP'],
  HBDH: ['α-羟丁酸脱氢酶', 'α-羟丁酸脱氢酶(HBDH)', '羟丁酸脱氢酶', 'HBDH'],
  CK: ['肌酸激酶', '肌酸激酶(CK)', 'CK', '磷酸肌酸激酶'],
  EGFR: ['肾小球滤过率', '肾小球滤过率(EGFR)', 'EGFR', 'eGFR'],
  CO2: ['二氧化碳', '二氧化碳(CO2)', 'CO2', '碳酸氢根', 'HCO3'],
  OSM: ['渗透压', '渗透压(OSM)', 'OSM', '0SM0', '血浆渗透压'],
  ANION_GAP: ['阴离子间隙', '阴离子间隙(AG)', 'ac', 'ANION_GAP'],
  TSH: ['促甲状腺激素', 'TSH', '促甲状腺素'],
  FT3: ['游离三碘甲状腺原氨酸', '游离T3', 'FT3'],
  FT4: ['游离甲状腺素', '游离T4', 'FT4'],
  TT3: ['总三碘甲状腺原氨酸', '总T3', 'TT3'],
  TT4: ['总甲状腺素', '总T4', 'TT4'],
  TPOAB: ['甲状腺过氧化物酶抗体', '抗甲状腺过氧化物酶抗体', 'TPOAb', 'TPO-Ab'],
  TGAB: ['甲状腺球蛋白抗体', '抗甲状腺球蛋白抗体', 'TGAb', 'TG-Ab'],
  // ---- 血糖 ----
  // 注意：尿常规 GLU 列名「GLU葡萄糖」映射 UGLU（尿葡萄糖），血糖报告为「葡萄糖/空腹血糖/血糖」映射 GLU
  GLU: ['葡萄糖', '血糖', '空腹血糖', '血清葡萄糖', 'GLU', 'GLY', '葡萄糖(GLU)', 'GLv', 'GLV'],
  // ---- 血脂 ----
  TC: ['总胆固醇', '胆固醇', 'TC', 'TC总胆固醇', 'CHOL', 'COL', '总胆固醇(TC)'],
  TG: ['甘油三酯', '甘油三脂', 'TG', 'Ts', 'TG甘油三酯', 'TRIG', '甘油三酯(TG)'],
  HDL_C: ['高密度脂蛋白胆固醇', '高密度脂蛋白', 'HDL-C', 'HDL', 'HDL_C', '高密度脂蛋白胆固醇(HDL-C)', 'CM'],
  LDL_C: ['低密度脂蛋白胆固醇', '低密度脂蛋白', 'LDL-C', 'LDL', 'LDL_C', '低密度脂蛋白胆固醇(LDL-C)'],
  VLDL_C: ['极低密度脂蛋白', 'VLDL'],
  APOA: ['载脂蛋白A1', '载脂蛋白A', 'APOA1', 'ApoA1'],
  APOB: ['载脂蛋白B', 'APOB', 'ApoB'],
  LPA: ['脂蛋白(a)', '脂蛋白a', 'LP(a)', 'Lp(0)', 'LP(0)', 'LPa', '0))'],
  // ---- 真菌（G 试验 / GM 试验）----
  // 注意：报告项目名形如「G 真菌（1-3）-β-D葡聚糖检测」，mapAlias 会先剥离字段代码前缀 G / Gm，
  // 因此别名需覆盖剥离后的中文名；另附 β-D葡聚糖 等子串兜底
  G_TEST: ['真菌（1-3）-β-D葡聚糖检测', '真菌(1-3)-β-D葡聚糖检测', '真菌（1-3）-β-D葡聚糖', 'β-D葡聚糖检测', 'β-D葡聚糖', '1,3-β-D葡聚糖检测', 'G试验', '真菌G试验'],
  GM_TEST: ['曲霉半乳甘露聚糖检测', '曲霉半乳甘露聚糖', '半乳甘露聚糖检测', '半乳甘露聚糖', 'GM试验', 'Gm试验', '曲霉GM试验'],
  // ---- 尿常规 ----
  UGLU: ['尿葡萄糖', 'GLU葡萄糖', '尿糖', 'UGLU'],
  UPRO: ['尿蛋白', 'PRO尿蛋白', 'PRO', '蛋白(尿)'],
  UBIL: ['胆红素', '尿胆红素', 'BIL胆红素'],
  URO: ['尿胆原', 'URO尿胆原'],
  UKET: ['酮体', 'KET酮体', '尿酮体'],
  UNIT: ['亚硝酸盐', 'NIT亚硝酸盐'],
  UBLD: ['尿隐血', '潜血', 'BLD隐血', 'BLD'],
  ULEU: ['白细胞', '尿白细胞', 'LEU白细胞', 'LEU'],
  URBC: ['尿红细胞', '尿红细胞(镜检)', '红细胞(尿)', 'RBC(尿)'],
  USG: ['比重', '尿比重', 'SG比重', 'SGSG比重', 'SG'],
  UPH: ['酸碱度', '尿酸碱度', 'PHPH', 'PH'],
  UVC: ['维生素C(VC)', '维生素C', 'VC维生素C(VC)', 'VC'],
  // ---- 感染八项（乙肝五项 + 丙肝 + 梅毒 + 艾滋病）----
  // 报告项目名形如「HCV 丙型肝炎病毒抗体检测」「TP 梅毒螺旋体抗体检测」「HBsAg 乙肝表面抗原」，
  // mapAlias 整体精确匹配优先：别名同时收录「英文+中文」整名与纯中文名。
  HBsAg: ['HBsAg 乙肝表面抗原', '乙肝表面抗原', '乙肝表面抗原(HBsAg)', 'HBsAg'],
  HBsAb: ['HBsAb 乙肝表面抗体', '乙肝表面抗体', '乙肝表面抗体(HBsAb)', 'HBsAb'],
  HBeAg: ['HBeAg 乙肝e抗原', '乙肝e抗原', '乙肝e抗原(HBeAg)', 'HBeAg'],
  HBeAb: ['HBeAb 乙肝e抗体', '乙肝e抗体', '乙肝e抗体(HBeAb)', 'HBeAb'],
  HBcAb: ['HBcAb 乙肝核心抗体', '乙肝核心抗体', '乙肝核心抗体(HBcAb)', 'HBcAb'],
  HCV: ['HCV 丙型肝炎病毒抗体检测', '丙型肝炎病毒抗体检测', '丙型肝炎病毒抗体', '丙肝抗体', '丙型肝炎抗体', 'HCV抗体', '抗-HCV', 'HCV'],
  TP: ['TP 梅毒螺旋体抗体检测', '梅毒螺旋体抗体检测', '梅毒螺旋体抗体', '梅毒抗体', 'TP抗体', '抗-TP', 'TP'],
  // TP 是生化「总蛋白」与感染八项「梅毒螺旋体抗体」的缩写冲突：
  // 总蛋白报告名形如「TP 总蛋白(双缩脲法)」，独立 code 避免误配成梅毒 TP（进而误判报告含感染八项）。
  TP_PROTEIN: ['TP 总蛋白(双缩脲法)', 'TP总蛋白(双缩脲法)', '总蛋白(双缩脲法)', 'TP 总蛋白', 'TP总蛋白', '总蛋白'],
  HIV: ['HIV HIV抗原抗体联合检测(化学发光法)', 'HIV抗原抗体联合检测(化学发光法)', 'HIV抗原抗体联合检测', '艾滋病抗体', 'HIV抗体', '抗-HIV', 'HIV'],
  // ---- 便常规（大便常规）----
  // 报告项目名形如「YX 隐血」「WBC WBC白细胞 未见」「RBC RBC红细胞 未见」，
  // 整体精确匹配优先：避免「隐血」被剥离 YX 后误配为尿常规 UBLD、
  // 避免「WBC/RBC + 未见」被误配为血常规（/HPF 镜检是便常规，参考范围与血常规完全不同）。
  STOOL_OB: ['YX 隐血', 'YX隐血', '大便隐血', '粪便隐血', '便隐血', '隐血试验', '隐血(OB)', 'OB隐血', '隐血', 'OB'],
  // 注意：别名必须带「未见/镜检/便」等便常规特征，不能裸用 'WBC 白细胞'/'RBC 红细胞'——
  // 血常规报告的 original_name 也常是「WBC 白细胞」「RBC 红细胞」，裸名会被抢成便常规，破坏血常规数据。
  STOOL_WBC: ['WBC WBC白细胞 未见', 'WBC白细胞 未见', 'WBC 白细胞 未见', '白细胞 未见', '镜检白细胞', '便白细胞', '大便白细胞', '粪便白细胞', '白细胞(镜检)'],
  STOOL_RBC: ['RBC RBC红细胞 未见', 'RBC红细胞 未见', 'RBC 红细胞 未见', '红细胞 未见', '镜检红细胞', '便红细胞', '大便红细胞', '粪便红细胞', '红细胞(镜检)'],
  // ---- 血型鉴定 ----
  // 报告项目名形如「ABO ABO血型(正定型）」「Rh(D) Rh(D)血型」，整体精确匹配优先。
  ABO: ['ABO ABO血型(正定型）', 'ABO血型(正定型）', 'ABO ABO血型(正定型)', 'ABO血型(正定型)', 'ABO血型', 'ABO'],
  RH_D: ['Rh(D) Rh(D)血型', 'Rh(D)血型', 'RH(D)血型', 'Rh血型', 'RH血型', 'RH(D)', 'Rh(D)'],
  // ---- 贫血组合 ----
  FERR: ['铁蛋白', 'Ferritin', '铁蛋白(Ferritin)', '铁蛋白(FERR)', 'FERR'],
  FOLATE: ['叶酸', 'Folate', 'FA', '叶酸(FA)', '叶酸(Folate)', 'FOLIC'],
  VIT_B12: ['维生素B12', 'VitB12', 'Vit B12', '维生素 B12', 'VB12', '钴胺素', 'VitB12'],
  EPO: ['促红细胞生成素', '红细胞生成素', '促红素', '促红细胞生成素(EPO)', 'Erythropoietin', 'EPO'],
  // ---- 骨髓形态学（血片 + 骨髓片 有核细胞分类）----
  // 报告常把「血片/骨髓片」作为后缀或前缀（如「中性分叶核粒细胞-血片」「骨髓片 中性分叶核粒细胞」），
  // 别名同时收录带后缀与带前缀两种写法；AI 分类兜底（B 方案）也会据此把图上的细胞名映射到稳定 code。
  MYELOBLAST_BF: ['原始粒细胞-血片', '原始粒细胞血片', '原始粒细胞(血片)', '血片原始粒细胞', 'MYELOBLAST_BF'],
  MYELOBLAST_MF: ['原始粒细胞-骨髓片', '原始粒细胞骨髓片', '原始粒细胞(骨髓片)', '骨髓片原始粒细胞', 'MYELOBLAST_MF'],
  PROMYELO_BF: ['早幼粒细胞-血片', '早幼粒细胞血片', '早幼粒细胞(血片)', '血片早幼粒细胞', 'PROMYELO_BF'],
  PROMYELO_MF: ['早幼粒细胞-骨髓片', '早幼粒细胞骨髓片', '早幼粒细胞(骨髓片)', '骨髓片早幼粒细胞', 'PROMYELO_MF'],
  NEU_MYEL_BF: ['中性中幼粒细胞-血片', '中性中幼粒细胞血片', '中幼粒细胞-血片', 'NEU_MYEL_BF'],
  NEU_MYEL_MF: ['中性中幼粒细胞-骨髓片', '中性中幼粒细胞骨髓片', '中幼粒细胞-骨髓片', 'NEU_MYEL_MF'],
  NEU_META_BF: ['中性晚幼粒细胞-血片', '中性晚幼粒细胞血片', '晚幼粒细胞-血片', 'NEU_META_BF'],
  NEU_META_MF: ['中性晚幼粒细胞-骨髓片', '中性晚幼粒细胞骨髓片', '晚幼粒细胞-骨髓片', '骨髓片晚幼粒细胞', 'NEU_META_MF'],
  NEU_BAND_BF: ['中性杆状核粒细胞-血片', '中性杆状核粒细胞血片', '杆状核粒细胞-血片', 'NEU_BAND_BF'],
  NEU_BAND_MF: ['中性杆状核粒细胞-骨髓片', '中性杆状核粒细胞骨髓片', '杆状核粒细胞-骨髓片', 'NEU_BAND_MF'],
  NEU_SEG_BF: ['中性分叶核粒细胞-血片', '中性分叶核粒细胞血片', '分叶核粒细胞-血片', '中性分叶核-血片', 'NEU_SEG_BF'],
  NEU_SEG_MF: ['中性分叶核粒细胞-骨髓片', '中性分叶核粒细胞骨髓片', '分叶核粒细胞-骨髓片', '中性分叶核-骨髓片', '骨髓片中性分叶核粒细胞', 'NEU_SEG_MF'],
  EOS_BF: ['嗜酸性粒细胞-血片', '嗜酸粒细胞-血片', 'EOS_BF'],
  EOS_MF: ['嗜酸性粒细胞-骨髓片', '嗜酸粒细胞-骨髓片', 'EOS_MF'],
  BASO_BF: ['嗜碱性粒细胞-血片', '嗜碱粒细胞-血片', 'BASO_BF'],
  BASO_MF: ['嗜碱性粒细胞-骨髓片', '嗜碱粒细胞-骨髓片', 'BASO_MF'],
  // 原始/幼稚淋巴细胞：带后缀、带前缀、「原幼淋」缩写三种写法都收。
  // 「原幼淋」是检验科对「原始+幼稚淋巴细胞」合计的惯用缩写；与形态学流的目标值同义。
  LYMBLAST_BF: ['原始淋巴细胞-血片', '原始淋巴细胞血片', '原始淋巴细胞(血片)', '血片原始淋巴细胞', '原始淋巴-血片', 'LYMBLAST_BF'],
  // 裸名（不带 -血片/-骨髓片 后缀）默认归骨髓片：骨穿表的主列是骨髓片，形态学目标值也取骨髓片
  LYMBLAST_MF: ['原始淋巴细胞-骨髓片', '原始淋巴细胞骨髓片', '原始淋巴细胞(骨髓片)', '骨髓片原始淋巴细胞', '原始淋巴-骨髓片', '原始淋巴细胞', '原始淋巴', '原幼淋', '原幼淋-骨髓片', '原始+幼稚淋巴细胞', '原始及幼稚淋巴细胞', 'LYMBLAST_MF'],
  IMMLYM_BF: ['幼稚淋巴细胞-血片', '幼稚淋巴细胞血片', '幼稚淋巴细胞(血片)', '血片幼稚淋巴细胞', '幼淋-血片', 'IMMLYM_BF'],
  IMMLYM_MF: ['幼稚淋巴细胞-骨髓片', '幼稚淋巴细胞骨髓片', '幼稚淋巴细胞(骨髓片)', '骨髓片幼稚淋巴细胞', '幼淋-骨髓片', '幼稚淋巴细胞', '幼淋', 'IMMLYM_MF'],
  LYM_BF: ['淋巴细胞-血片', '成熟淋巴细胞-血片', '血片淋巴细胞', 'LYM_BF'],
  LYM_MF: ['淋巴细胞-骨髓片', '成熟淋巴细胞-骨髓片', '骨髓片淋巴细胞', 'LYM_MF'],
  MONO_BF: ['单核细胞-血片', '成熟单核细胞-血片', '血片单核细胞', 'MONO_BF'],
  MONO_MF: ['单核细胞-骨髓片', '成熟单核细胞-骨髓片', '骨髓片单核细胞', 'MONO_MF'],
  ERY_BF: ['有核红细胞-血片', '有核红细胞血片', 'ERY_BF'],
  ERY_MF: ['幼红细胞-骨髓片', '晚幼红细胞-骨髓片', '有核红细胞-骨髓片', '骨髓片幼红细胞', 'ERY_MF'],
  // 流式：报告只在「印象/结论」里写一句（异常细胞群体约占 X% / MRD X% / 残留白血病细胞 X%），
  // 化验通道统一落成这一行，别名覆盖常见写法。
  // 融合基因：真实报告写法五花八门（BCR-ABL1 P190融合基因 / BCR-ABL1 P190/ABL1x100% /
  // BCR/ABL P190 拷贝数比率 / 裸「P190融合基因」），整名命中优先（纯 ASCII 名也能整体映射）。
  BCR_ABL1_P190_Q: ['BCR-ABL1 P190融合基因', 'BCR-ABL1 P190 融合基因', 'BCR/ABL P190融合基因', 'P190融合基因', 'BCR-ABL1 P190', 'BCR-ABL P190', 'BCR_ABL1_P190_Q'],
  BCR_ABL1_P190_PCT: ['BCR-ABL1 P190/ABL1x100%', 'BCR-ABL1 P190/ABL1', 'BCR/ABL1 P190/ABL1', 'BCR-ABL1(P190) 拷贝数/ABL 拷贝数', 'BCR/ABL P190 拷贝数比率', 'BCR-ABL1 P190 拷贝数比率', 'P190/ABL1', 'P190拷贝数比率', 'BCR_ABL1_P190_PCT'],
  BCR_ABL1_P210_Q: ['BCR-ABL1 P210融合基因', 'BCR-ABL1 P210 融合基因', 'BCR/ABL P210融合基因', 'P210融合基因', 'BCR-ABL1 P210', 'BCR-ABL P210', 'BCR_ABL1_P210_Q'],
  BCR_ABL1_P210_PCT: ['BCR-ABL1 P210/ABL1x100%', 'BCR-ABL1 P210/ABL1', 'BCR/ABL1 P210/ABL1', 'BCR-ABL1(P210) 拷贝数/ABL 拷贝数', 'BCR/ABL P210 拷贝数比率', 'BCR-ABL1 P210 拷贝数比率', 'P210/ABL1', 'P210拷贝数比率', 'BCR_ABL1_P210_PCT'],
  BCR_ABL1_P230_Q: ['BCR-ABL1 P230融合基因', 'BCR-ABL1 P230 融合基因', 'P230融合基因', 'BCR-ABL1 P230', 'BCR_ABL1_P230_Q'],
  BCR_ABL1_P230_PCT: ['BCR-ABL1 P230/ABL1x100%', 'BCR-ABL1 P230/ABL1', 'BCR-ABL1(P230) 拷贝数/ABL 拷贝数', 'P230/ABL1', 'P230拷贝数比率', 'BCR_ABL1_P230_PCT'],
  FCM_MRD: ['流式MRD残留', '流式MRD残留-外周血', '流式MRD残留-骨髓', '流式MRD', 'FCM-MRD', 'MRD(流式)', 'MRD', '微小残留病', '微小残留病灶', '残留白血病细胞', '异常细胞群体占有核细胞比例', '流式残留', 'FCM_MRD'],
  MEGA: ['巨核细胞', '巨核细胞计数', 'MEGA'],
  ME_RATIO: ['粒红比', '粒:红', '粒红比值', 'ME_RATIO'],
  BF_WBC: ['血片共数白细胞', '血片白细胞计数', '血片共数', 'BF_WBC'],
  MF_NC: ['骨髓片共数有核细胞', '骨髓片有核细胞计数', '骨髓片共数', 'MF_NC'],
}

// ===================== 报告标题特征词 =====================
// detectReportType 的辅助信号：即使项目名因字典未收录而未映射成标准字段（如新报告类型），
// 只要报告文本（grid 全部单元格 / original_name 拼接）含特征词即可识别类型，
// 避免「无特征 → 兜底误判成血常规」。特征词需足够特异，防止误配：
//   - 「隐血」不可作 STOOL 特征（尿常规「尿隐血」也含它），必须带「便/粪」前缀；
//   - 「血型」连写才命中，「血红蛋白」等不误伤。
export const TITLE_KEYWORDS = {
  BLOOD_TYPE: ['血型鉴定', 'ABO血型', 'ABO', 'Rh(D)', 'RH(D)', 'Rh血型', 'RH血型', '血型'],
  STOOL: ['大便常规', '粪便常规', '便常规', '大便隐血', '粪便隐血', '便隐血'],
  URINALYSIS: ['尿常规', '尿液分析'],
  FUNGUS: ['真菌', 'G试验', 'GM试验', '曲霉'],
  ANEMIA: ['贫血组合', '贫血', '铁蛋白', '叶酸', '维生素B12'],
  EPO: ['促红细胞生成素', '促红素', '红细胞生成素', 'EPO', 'Erythropoietin'],
  BIOCHEM: ['生化全项', '生化全套', '生化常规', '生化组合', '生化'],
  BONE_MARROW: ['骨髓形态学', '骨髓细胞学', '骨髓涂片', '骨髓穿刺', '髓片', '血片共数', '骨髓片共数', '粒红比', '骨髓片', '血片'],
  // 关键修复：key 必须与 REPORT_TYPES 的 code 完全一致（BONE_MARROW_MORPHOLOGY）。
  // 此前只挂了 BONE_MARROW，导致 buildTitleKeywords('BONE_MARROW_MORPHOLOGY') 查不到任何词、
  // 标题匹配永久失效，骨髓报告只能靠乱码项集签名 → 被误判成凝血功能。
  // 词表需覆盖真实标题「骨髓细胞形态检查图文报告」及 OCR 常见错字/变体。
  // 融合基因定量：关键词必须够特异且比「骨髓」（骨髓形态学在用）长，
  // 否则「白血病融合基因检测(骨髓)」会被判成骨髓形态学（2026-10-22 实测）。
  FUSION_PCR: ['白血病融合基因检测', '融合基因检测', 'BCR-ABL1融合基因', 'BCR/ABL', 'P190融合基因', 'P210融合基因', 'P230融合基因'],
  BONE_MARROW_MORPHOLOGY: [
    '骨髓细胞形态学', '骨髓细胞形态', '骨髓形态学', '骨髓形态', '骨髓象', '骨髓细胞学',
    '骨髓涂片', '骨髓穿刺', '髓细胞', '髓片', '血片共数', '骨髓片共数', '粒红比',
    '骨髓片', '血片', '细胞形态', '骨髓',
  ],
}

// 事件类别（用于日程管理；仅「输血」类绘制在趋势图上）
export const EVENT_CATEGORIES = [
  { key: 'transfusion', label: '输血', color: '#ef4444' },
  { key: 'medication', label: '用药', color: '#3b82f6' },
  { key: 'temperature', label: '体温', color: '#f97316' },
]

// 输血制品类型（趋势图跳变关联用）：auto 仅表单语义，不写入事件（走描述文字自动识别）
export const EVENT_PRODUCTS = [
  { key: 'auto', label: '自动识别', color: '#94a3b8' },
  { key: 'rbc', label: '红细胞', color: '#ef4444' },
  { key: 'plt', label: '血小板', color: '#f59e0b' },
  { key: 'plasma', label: '血浆', color: '#f97316' },
  { key: 'other', label: '其他', color: '#64748b' },
]

// 从事件描述文字自动识别制品类型（纯函数）；识别不出返回 undefined（未识别 → 趋势图按旧行为全指标跳变兜底）
export function inferProduct(text) {
  if (/(红细胞|红悬|浓缩红细胞|去白细胞红细胞|洗涤红细胞)/.test(text || '')) return 'rbc'
  if (/(血小板|单采血小板|浓缩血小板|机采血小板)/.test(text || '')) return 'plt'
  if (/(血浆|FFP|新鲜冰冻血浆|白蛋白)/.test(text || '')) return 'plasma'
  return undefined
}

// 纯字母数字别名 → 代码前缀候选（长前缀优先），用于「代码 + 名称」组合剥离。
// 覆盖「LEU LEU白细胞」这种代码重复的项目名：剥离第一个 LEU 后剩「LEU白细胞」仍可精确命中 ULEU；
// 也覆盖「WBC 白细胞计数」→ 剥 WBC → 白细胞计数 命中 WBC。
const PREFIX_CANDIDATES = []
for (const [code, aliases] of Object.entries(ALIAS_MAP)) {
  for (const a of aliases) {
    const key = a.replace(/\s+/g, '').toUpperCase()
    if (key.length >= 2 && /^[A-Z0-9#%^\-]+$/.test(key)) PREFIX_CANDIDATES.push({ key, code })
  }
}
PREFIX_CANDIDATES.sort((a, b) => b.key.length - a.key.length)

function matchAliasExact(s) {
  for (const [code, aliases] of Object.entries(ALIAS_MAP)) {
    if (aliases.some((a) => a.replace(/\s+/g, '').toUpperCase() === s)) return code
  }
  return null
}

// ===================== 名称变体匹配（删字变体兜底） =====================
// 标准代码是固定主键，一个 code 强绑定标准名称/单位/参考范围（FIELD_BY_CODE 即档案表）；
// 项目名称是变体集（ALIAS_MAP[code] 收敛全部别名）。OCR 对中文名常漏字/多一字
// （如「中粒细胞」vs 标准名「中性粒细胞」），mapAlias 是精确/子串匹配无法覆盖「差一字」。
// 此处对 mapAlias 落空的中文名做「删除/插入一个字符后相等」的变体匹配，
// 且要求跨字段候选唯一才采纳（防误配，如「中细胞」可能同时接近多个字段 → 不采纳）。
// 返回 { code, alias } 或 null
export function matchDroppedCharVariant(name) {
  if (!name) return null
  const s = String(name).replace(/\s+/g, '')
  if (s.length < 3 || !/[\u4e00-\u9fa5]/.test(s)) return null

  const isOneCharOff = (a, b) => {
    if (Math.abs(a.length - b.length) !== 1) return false
    const [longer, shorter] = a.length > b.length ? [a, b] : [b, a]
    for (let k = 0; k < longer.length; k++) {
      if (longer.slice(0, k) + longer.slice(k + 1) === shorter) return true
    }
    return false
  }

  const hits = []
  for (const [code, aliases] of Object.entries(ALIAS_MAP)) {
    for (const a of aliases) {
      const key = String(a).replace(/\s+/g, '')
      if (key.length < 3 || !/[\u4e00-\u9fa5]/.test(key)) continue
      if (isOneCharOff(s, key)) hits.push({ code, alias: key })
    }
  }
  if (hits.length === 0) return null
  // 跨字段候选唯一才采纳：多个字段都「差一字」说明存在歧义，宁可留空等待人工确认
  const codes = new Set(hits.map((h) => h.code))
  if (codes.size === 1) return hits[0]
  return null
}

// Levenshtein 编辑距离（字符级），用于错别字容错（含等长替换，如「中性粹细胞」→「中性粒细胞」）
function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const t = prev
    prev = curr
    curr = t
  }
  return prev[n]
}

// 模糊别名容错（编辑距离 ≤2）：与 matchDroppedCharVariant（仅差一字删/插）互补，
// 覆盖「等长替换型」错别字，如「中性粹细胞」→「中性粒细胞」（粹→粒）。
// 约束：中文名长度≥3；命中候选需唯一，或同属一个字段族（标准名公共前缀≥2 字，
// 如 NEUT_ABS/NEUT_PCT 都含「中性粒细胞」）才采纳，防跨字段误配。
function matchFuzzyVariant(name) {
  if (!name || name.length < 3 || !/[\u4e00-\u9fa5]/.test(name)) return null
  let bestDist = 3
  let bestCodes = []
  for (const [code, aliases] of Object.entries(ALIAS_MAP)) {
    for (const a of aliases) {
      const key = String(a).replace(/\s+/g, '')
      if (key.length < 3 || !/[\u4e00-\u9fa5]/.test(key)) continue
      const d = levenshtein(name, key)
      if (d < bestDist) {
        bestDist = d
        bestCodes = [code]
      } else if (d === bestDist) {
        bestCodes.push(code)
      }
    }
  }
  if (bestDist > 2 || bestCodes.length === 0) return null
  const uniq = [...new Set(bestCodes)]
  if (uniq.length === 1) return uniq[0]
  // 多 code 但同字段族（标准名公共前缀≥2 字）→ 采纳（后续 normalize 用数值/单位再细分 ABS/PCT）
  const names = uniq.map((c) => FIELD_BY_CODE[c]?.name || '').filter(Boolean)
  if (names.length === uniq.length) {
    let pref = names[0]
    for (const nm of names) {
      let k = 0
      while (k < pref.length && k < nm.length && pref[k] === nm[k]) k++
      pref = pref.slice(0, k)
    }
    if (pref.length >= 2) return uniq[0]
  }
  return null
}

// 括号缩写提取：报告常在中文项目名后附英文缩写，如「甘油三酯(TG)」「前白蛋白(PA)」；
// Tesseract 也常把缩写单独切出成独立 token "(Ts)"/"(Pa)"。这类 2 字符缩写（Ts/Pa/Ca/P…）
// 会被 mapAlias ③ 的长度过滤（key.length<3）跳过而漏配，故在此专门提取括号内容做精确/
// 子串匹配：命中即返回，且优先最长别名避免歧义（如 (BIL)→TBIL 而非 DBIL 的 BIL 子串）。
function matchParenAlias(name) {
  const re = /[（(]([^（）()]{1,6})[）)]/g
  let m
  let best = null
  let bestLen = 0
  while ((m = re.exec(name))) {
    const inner = m[1].replace(/\s+/g, '').toUpperCase()
    for (const [code, aliases] of Object.entries(ALIAS_MAP)) {
      for (const a of aliases) {
        const key = String(a).replace(/\s+/g, '').toUpperCase()
        if (key.length < 1) continue
        // 仅精确相等，或「括号内容包含该别名」（如 (PINS) 含 P、避免 TSH 反向吞 TS 这类误配）。
        // 单字母别名（K/Na/P…）要求「精确相等」：方法名括号（如 (DGKC法) 剥离「法」剩 DGKC）
        // 含 K 子串会误匹配成钾，故单字母仅精确相等命中，多字母允许包含，兼顾 (CK)→CK 等。
        const hit = key.length === 1 ? key === inner : (key === inner || inner.includes(key))
        if (hit) {
          if (key.length > bestLen) {
            best = code
            bestLen = key.length
          }
        }
      }
    }
  }
  return best
}

// 安全放行的最小缩写集：mapAlias 子串匹配默认跳过长 <3 的别名（避免 CR/HB/Na 等 2 字符
// 缩写作为子串被「P-LCR」「BCRP」等误吞）。仅本集合内的 2 字符别名允许作为子串命中，
// 且仍须经 mapAliasWithUnit 的「单位量纲消歧」裁决（% → 百分比项，*10^9/L → 绝对值项）。
// 当前仅含 'EO'：覆盖 OCR 把「嗜酸性粒细胞百分比」行名读成「(EO …」（无闭合括号、'EO' 仅 2 字）
// 导致 eosinophil 行无法别名命中、被碎片值抢码的漏配（case-TR-20260830-MINQ7R）。
const SAFE_2CHAR = new Set(['EO'])

// 由原始项目名匹配标准字段（忽略大小写与空白）
export function mapAlias(rawName) {
  if (!rawName) return null
  let name = String(rawName).replace(/\s+/g, '').toUpperCase()
  // 括号缩写优先（绕过 ③ 的长度过滤，专门处理 (Ts)/(Pa)/(Ca)/(P)/(COL)/(BIL) 等）
  const parenHit = matchParenAlias(name)
  if (parenHit) return parenHit
  // 预处理：剥离「检测方法」括号后缀（方法名各实验室写法多变，剥掉后剩核心名统一走 ⓪/①/②/③ 匹配）。
  // 例：(双缩脲法)/(离子选择电极法)/(IFCC法)/(DGKC法)/(计算值)。
  // 仅剥离「以‘法’结尾」或「计算值」的括号组；(PLT)/(A/G)/(VC) 等含关键信息的括号保留。
  // 同时避免前白蛋白(PA) 被 ALB 的「白蛋白」子串误配——剥括号后「前白蛋白」先经 ② 整名命中 PA。
  name = name.replace(/[（(](?:计算值|[^（）()]*法)[）)]/g, '')
  // ⓪ 原始名整体精确匹配优先。例：「GLU葡萄糖」整体命中 UGLU（尿葡萄糖），
  //    不先剥离 GLU 前缀（否则剩「葡萄糖」会被误配为血糖 GLU）
    const wholeHit = matchAliasExact(name)
    if (wholeHit) return wholeHit
    // ⓪b 用户本机学过的缩写（见 src/data/userAlias.js）：解析/校对里用户确认过的
    //    「缩写 → 代码」直连命中。空表时只多一次对象查表，对既有链路零影响。
    const userHit = mapUserAlias(name)
    if (userHit && FIELD_BY_CODE[userHit]) return userHit
  // ① 剥离「纯字母别名前缀」。例：
  //    「LEU LEU白细胞」→ 剥 LEU → 剩余「LEU白细胞」精确命中 ULEU（避免贪婪吃掉 LEULEU 剩「白细胞」被误配为血常规 WBC）
  //    「WBC 白细胞计数」→ 剥 WBC → 剩余「白细胞计数」命中 WBC
  for (const { key, code } of PREFIX_CANDIDATES) {
    if (name.startsWith(key) && name.length > key.length) {
      const rest = name.slice(key.length)
      const hit = matchAliasExact(rest)
      if (hit) return hit
      // 剩余名以中文开头但匹配不到时：若前缀唯一对应某字段（如「LEU 白细胞」→ 剥 LEU 剩「白细胞」歧义），
      // 直接返回前缀字段，避免「白细胞」被误配成血常规 WBC
      if (/[\u4e00-\u9fa5]/.test(rest[0]) && PREFIX_CANDIDATES.filter((c) => c.key === key).length === 1) return code
    }
  }
  // ② 原逻辑：剥离「字段代码 + 名称」组合的前缀（如 "NE# 中性粒细胞绝对值"、"hs-CRP 超敏C反应蛋白"）
  const codeMatch = name.match(/^([A-Z][A-Z0-9#%^\-]{0,8})(?=[\u4e00-\u9fa5])/)
  if (codeMatch) {
    const hit = matchAliasExact(name.slice(codeMatch[1].length))
    if (hit) return hit
  }
  // ③ 模糊包含匹配（如 “血小板计数(PLT)” 之类带括号变体已覆盖；再做子串兜底）。
  //    仅对长度 >=3 的别名做子串匹配：2 字符缩写（CR/HB/Na 等）作为子串极易误配
  //    （如 P-LCR 含 CR 被误判为肌酐、BCRP 含 HB 被误判为血红蛋白）。
  //    a) 正向匹配（name 含完整别名）：取「最长别名」优先而非第一个命中——如「有核红细胞百分比 NRBC%」
  //       含子串「红细胞」，按遍历顺序会先命中 RBC（3 字），而「有核红细胞百分比」（8 字）更长更精确，应优先 NRBC_PCT。
  //    b) 反向匹配（OCR 截断：name 是某别名前缀，如「红细胞分布宽度变异系」是「红细胞分布宽度变异系数」截断）：
  //       仅当 name >=4 字、别名比 name 多 1-2 字时启用，避免「红细胞」「血小板」等短名被
  //       「有核红细胞百分比」「血小板压积」反向吞并而误配。
  let best = null
  let bestLen = 0
  for (const [code, aliases] of Object.entries(ALIAS_MAP)) {
    for (const a of aliases) {
      const key = a.replace(/\s+/g, '').toUpperCase()
      if (key.length < 2) continue
      if (key.length === 2 && !SAFE_2CHAR.has(key)) continue
      let hit = false
      if (name.includes(key)) hit = true
      else if (name.length >= 4 && key.startsWith(name) && key.length - name.length <= 2) hit = true
      if (hit && key.length > bestLen) {
        best = code
        bestLen = key.length
      }
    }
  }
  // ④ 模糊容错（编辑距离 ≤2）：覆盖子串/删字均落空的「替换型错别字」，如「中性粹细胞」→「中性粒细胞」。
  // 仅在 ③ 无命中时启用，避免干扰已有精确/子串逻辑；跨字段歧义或多 code 不同族则拒绝（返回 null）。
  if (!best) {
    const fuzzy = matchFuzzyVariant(name)
    if (fuzzy) return fuzzy
  }
  return best
}

// ===================== 稳妥匹配（别名 + 删字变体） =====================
// 供「已有代码」场景使用：数据清洗重映射、网格「重新匹配标准字段」。
// 背景（用户反馈 2026-09-11）：mapAlias 的模糊包含会命中更泛化的短子串别名——
//   「平均红细胞血红蛋白含量」含「血红蛋白」→ Hb（把已正确的 MCH 降级）
//   「大血小板比率」含「血小板」→ PLT（把已正确的 P_LCR 降级）
// 而删字变体兜底（matchDroppedCharVariant）本可给出更精确的项目，却因为 mapAlias 已返回
// 非空结果而被跳过。此处二者结合：变体给出「更具体」的项目（标准名不比别名命中更短）时采纳变体。
// 返回 { code, variant }：variant=true 表示靠删字变体兜底命中（调用方可据此回填标准名）。
export function mapAliasRobust(rawName) {
  const code = mapAlias(rawName)
  if (!rawName) return { code, variant: false }
  const v = matchDroppedCharVariant(rawName)
  if (!v || !v.code) return { code, variant: false }
  if (!code) return { code: v.code, variant: true }
  if (v.code === code) return { code, variant: false }
  // 仅在「别名命中明显是短子串」时才让变体改判：命中别名比变体别名短 2 字以上，
  // 说明 mapAlias 是靠「血红蛋白」「血小板」这类泛化子串命中的（降级嫌疑）。
  // 反例保护：「葡萄糖」命中 GLU（别名整名 3 字）而变体给「尿葡萄糖」(UGLU)，
  // 命中并非短子串 → 绝不让变体改判，否则血糖会被改判成尿糖。
  const name = String(rawName).replace(/\s+/g, '').toUpperCase()
  const hitLen = longestAliasLenIn(code, name)
  const vLen = String(v.alias || '').replace(/\s+/g, '').length
  if (hitLen > 0 && vLen >= hitLen + 2 && FIELD_BY_CODE[v.code]) {
    return { code: v.code, variant: false }
  }
  return { code, variant: false }
}

// code 的别名中，被 name 包含的最长别名长度（0 = 不是靠整别名子串命中）
function longestAliasLenIn(code, name) {
  let best = 0
  for (const a of ALIAS_MAP[code] || []) {
    const k = String(a).replace(/\s+/g, '').toUpperCase()
    if (k && name.includes(k) && k.length > best) best = k.length
  }
  return best
}

// 多候选收集：返回所有命中的标准 code（含括号别名、精确、子串模糊、掉字变体），
// 供 normalize 做「value 是否落在 ref 范围内」的交叉验证裁决。
// 双栏报告常把多个指标的 name 揉进同一行（如 "RA MIER (AST)(ALT) M1540"），
// 单行 name 会同时命中多个 code，仅靠最长子串会误配；用 value/ref 二次裁决可纠正。
export function mapAliasAll(rawName) {
  if (!rawName) return []
  const name = String(rawName).replace(/\s+/g, '').toUpperCase()
  const found = new Map() // code -> score（越大越优先）
  const add = (code, score) => {
    if (!code) return
    found.set(code, Math.max(found.get(code) || 0, score))
  }
  // 括号缩写（精确/包含）
  const re = /[（(]([^（）()]{1,6})[）)]/g
  let m
  while ((m = re.exec(name))) {
    const inner = m[1].replace(/\s+/g, '').toUpperCase()
    for (const [code, aliases] of Object.entries(ALIAS_MAP)) {
      for (const a of aliases) {
        const key = String(a).replace(/\s+/g, '').toUpperCase()
        if (key.length < 1) continue
        const hit = key.length === 1 ? key === inner : (key === inner || inner.includes(key))
        if (hit) add(code, 100 + key.length)
      }
    }
  }
  // 精确 + 子串（含反向截断）
  for (const [code, aliases] of Object.entries(ALIAS_MAP)) {
    for (const a of aliases) {
      const key = String(a).replace(/\s+/g, '').toUpperCase()
      if (!key) continue
      if (key === name) add(code, 90)
      else if (name.includes(key)) add(code, key.length >= 3 ? 60 + key.length : 20 + key.length)
      else if (name.length >= 4 && key.startsWith(name) && key.length - name.length <= 2) add(code, 30)
    }
  }
  // 模糊（编辑距离≤2）/ 掉字变体 / 前缀剥离
  const fuzzy = matchFuzzyVariant(name)
  if (fuzzy) add(fuzzy, 40)
  const dropped = matchDroppedCharVariant(name)
  if (dropped) add(dropped, 35)
  return [...found.entries()].map(([code, score]) => ({ code, score })).sort((a, b) => b.score - a.score)
}

// 融合基因报告的项目名常被 OCR 读花：`BCR-ABL1 Pl907aBL1x100%`（= P190/ABL1x100%）、
// `BCR-ABL1 Pl90融合基因`（l→1）、`P210/ABLlx100%`（l→1）等。化验网格对纯 ASCII 行名要求
// 「整名命中别名」才认（见 buildGridPoints），所以这里先把常见误读修回可命中的写法。
// 实测（2026-10-22，朝阳 2026-10-10 融合基因报告）：定量行整行因此丢失。
export function repairFusionName(raw = '') {
  const s0 = String(raw || '')
  if (!/ABL|P\s*[12]\d\d/i.test(s0.replace(/[lI|]/g, '1'))) return ''
  const fixed = s0
    .replace(/[lI|]/g, '1') // l / I / | → 1（P19o、P1go、Pl90 等）
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/7\s*a/gi, '/') // 「7a」= 斜杠误读（Pl907aBL1 → P190/ABL1）
    .replace(/[×xX]\s*100\s*%/g, 'x100%')
    .replace(/\s+/g, '')
  const m = /P(190|210|230)\s*(\/|融合|$)/i.exec(fixed.replace(/ABL/gi, 'ABL'))
  if (!m) return ''
  const isPct = /\/|x100%|拷贝数|比率/i.test(fixed)
  return `BCR-ABL1 P${m[1]}${isPct ? '/ABL1x100%' : '融合基因'}`
}

// ===================== ORC 优化运行时补丁（数据层 · A 半） =====================
// 见 src/data/patches.js 头注：字段 / 别名 / keyFields 这类"表驱动增量"写补丁即生效，
// 不改逻辑、不需要隔离工作树；每次 recog 存档时沉淀回上面三张静态表并把 PATCHES 清空。
// 铁律 3：应用失败只警告、绝不抛出 —— 补丁写坏时退回"无补丁"识别，
//         绝不能让本模块加载失败（否则整条识别链全挂）。
try {
  const _patchRes = applyPatches(PATCHES, {
    fields: STANDARD_FIELDS,
    fieldByCode: FIELD_BY_CODE,
    aliasMap: ALIAS_MAP,
    reportTypes: REPORT_TYPES,
  })
  if (_patchRes.applied || _patchRes.errors.length) {
    console.info('[patches] dictionary 应用补丁', _patchRes.applied, '条', _patchRes.errors)
  }
} catch (e) {
  console.warn('[patches] dictionary 补丁应用失败，已忽略（按无补丁继续识别）：', e && e.message)
}
