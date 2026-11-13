/**
 * 报告类型目录（Catalog）与双维互推核心。
 *
 * 职责：
 * 1. 把 dictionary.js 中分散的 REPORT_TYPES / GROUP_FIELD_SETS / STATIC_COMBO / TITLE_KEYWORDS
 *    收敛为单一可信源 STATIC_CATALOG（含 signature / aliases / base / modifiers）。
 * 2. 运行时把静态 schema 与 store 中 Agent 自动发现的动态目录叠加为合并视图。
 * 3. 提供「标题特征 → 子项目集（正向）」与「子项目集 → 类型（反向）」的双向互推。
 * 4. 当组合未命中静态目录时，Agent 全自动把新组合登记为动态目录项并持久化。
 *
 * 设计约束：
 * - 代码侧（本文件）只维护稳定 schema；运行时不自动修改。
 * - 动态目录写 store，无人工关卡，但保留 `origin:'dynamic'` 与发现来源供审计视图只读展示。
 * - 与 dictionary.js 中既有兼容性函数（reportTypeLabel / reportTypeKeyFields）解耦，上层按需切换。
 */

import {
  REPORT_TYPES,
  REPORT_GROUPS,
  GROUP_FIELD_SETS,
  STATIC_COMBO,
  TITLE_KEYWORDS,
  reportTypeLabel as legacyReportTypeLabel,
  reportTypeKeyFields as legacyReportTypeKeyFields,
} from './dictionary.js'
import { addCatalogEntry, getState } from './store.js'

/**
 * @typedef {Object} CatalogEntry
 * @property {string} code              唯一类型 code（与旧 REPORT_TYPES code 共用命名空间）
 * @property {string} label             展示名
 * @property {string[]} aliases         同义名/归一名（如 全血细胞检测=全血细胞分析=血常规）
 * @property {string[]} titleKeywords   标题特征词（最高优先级）
 * @property {string[]} signature       标准子项目集合（反向互推用的"签名"）
 * @property {string|null} base         聚合归属基础类型；CBC_hsCRP.base = 'CBC'
 * @property {string[]} modifiers       附加修饰（如 ['HS_CRP']）
 * @property {'static'|'dynamic'} origin 来源
 * @property {string} [discoveredAt]    动态项发现时间 ISO 字符串
 */

// ========== 常量：识别阈值 ==========
const MIN_COVERAGE = 0.30   // signature 被命中的比例下限
const MIN_PRECISION = 0.20  // 命中项占全部识别项的比例下限
const MIN_SCORE = 0.15      // coverage * precision 综合分下限

// ========== 静态 Schema：派生自 dictionary.js ==========

/** 通用别名：把同一临床含义的不同说法归一到 code */
const ALIASES = {
  CBC: ['全血细胞分析', '全血细胞检测', '全血细胞', '血常规', '血细胞分析', '血细胞', 'CBC'],
  CBC_hsCRP: ['全血细胞分析+超敏C反应蛋白', '全血细胞+CRP', '全血细胞加C反应蛋白', '全血细胞加超敏C反应蛋白', 'CBC+hsCRP', '血常规+CRP'],
  LIVER: ['肝功能', '肝功', '肝功能检查', '肝功能检测', '肝功能全套', 'liver function'],
  LIVER_KIDNEY_ION: ['肝功能+肾功能+离子', '肝肾功能+离子', '肝肾离子', '肝功肾功电解质', '肝肾电解质'],
  KIDNEY: ['肾功能', '肾功', '肾功能检查', '肾功能检测', '肾功能全套'],
  ION: ['电解质', '离子', '电解质检查'],
  COAGULATION: ['凝血', '凝血功能', '凝血六项', '凝血检查', 'coagulation'],
  // 利钠肽家族（BNP / NT-proBNP）：报告申请项目常写「B型钠尿肽」，明细项目常简写「钠尿肽」。
  // 收录为标题特征词，使「单做 BNP 一项」的报告也能靠标题判为心肌（否则 signature 覆盖率不足）。
  CARDIAC: ['心肌', '心肌损伤', '心肌酶', '心肌四项', 'cardiac', 'B型钠尿肽', 'B型脑钠肽', 'B型利钠肽', '脑钠肽', '钠尿肽', 'BNP'],
  THYROID: ['甲功', '甲状腺', '甲功七项', '甲状腺功能', 'thyroid'],
  FUNGUS: ['真菌', '真菌G', '真菌GM', 'G试验', 'GM试验'],
  URINALYSIS: ['尿常规', '尿液分析', '尿检', '尿液常规'],
  INFECTION: ['感染', '感染八项', '术前免疫', '乙肝五项', '感染四项'],
  STOOL: ['便常规', '大便常规', '粪便常规'],
  BLOOD_TYPE: ['血型', '血型鉴定', 'ABO血型', 'ABO/Rh血型'],
  BIOCHEM: ['生化全项', '生化全套', '生化常规', '生化组合', '生化检查', '生化'],
  ANEMIA: ['贫血组合', '贫血', '铁蛋白叶酸B12', '铁蛋白叶酸维生素B12'],
  BONE_MARROW_MORPHOLOGY: ['骨髓形态学', '骨髓细胞形态学', '骨髓细胞形态检查', '骨髓象', '骨髓涂片分类', '骨髓形态学（涂片分类）'],
  // 流式免疫分型（FCM-MRD）：业务归属检验（化验通道），结果只取一行 MRD 百分比。
  // 「所检测抗原」是流式报告独有的版式词（正文列 CD1~CD235a 检测清单），且比骨髓形态学的
  // 裸词「骨髓」长——MRD 报告标本类型永远是骨髓，只靠「骨髓」会被误判成骨髓形态学
  // （2026-10-28 实测：含「标本类型: 骨髓」的流式报告被判 BONE_MARROW_MORPHOLOGY）。
  FLOW_CYTOMETRY: ['流式免疫分型', '流式细胞', '免疫分型', 'FCM-MRD', 'MRD', '微小残留', '所检测抗原', '所测抗原'],
}

/** 标题特征词：从 TITLE_KEYWORDS 与别名合并 */
function buildTitleKeywords(code) {
  const fromDict = Array.isArray(TITLE_KEYWORDS[code]) ? TITLE_KEYWORDS[code] : []
  const fromAlias = ALIASES[code] || []
  const fromLabel = [REPORT_TYPES.find((t) => t.code === code)?.label].filter(Boolean)
  return [...new Set([...fromLabel, ...fromAlias, ...fromDict])].filter((k) => k && k.trim())
}

/** 静态类型的 signature：keyFields  plus 针对大 panel 的扩展 */
function buildSignature(code, keyFields) {
  const base = [...new Set(keyFields || [])]
  if (code === 'BIOCHEM') {
    // 生化全项是涵盖最广的组合 panel：肝 + 肾 + 离子 + 糖 + 脂 + 常见附加项
    const extras = [
      'TBA', 'GLO', 'AG', 'CHE', 'PA', 'LDH', 'IBIL', 'CK', 'HBDH',
      'EGFR', 'CYS_C', 'P', 'Mg', 'CO2', 'OSM', 'ANION_GAP', 'CA_P_PRODUCT',
      'TC', 'TG', 'HDL_C', 'LDL_C', 'VLDL_C', 'APOA', 'APOB', 'LPA',
    ]
    return [...new Set([...base, ...extras])]
  }
  if (code === 'LIVER') {
    // 肝功能报告实际常带的扩展项
    return [...new Set([...base, 'TBA', 'GLO', 'AG', 'CHE', 'PA', 'LDH', 'IBIL'])]
  }
  if (code === 'CBC') {
    // 全血细胞常见扩展形态学指标
    return [...new Set([...base, 'MCV', 'MCH', 'MCHC', 'RDW_CV', 'RDW_SD', 'PDW', 'MPV', 'PCT', 'NRBC'])]
  }
  if (code === 'CBC_hsCRP') {
    // 组合项继承完整 CBC 签名 + HS_CRP，保证 CBC 子项充足时仍能区分 CBC 与 CBC_hsCRP
    const cbc = REPORT_TYPES.find((t) => t.code === 'CBC')
    return [...new Set([...(cbc ? buildSignature('CBC', cbc.keyFields) : []), 'HS_CRP'])]
  }
  return base
}

/** 静态目录：code -> CatalogEntry。组合静态类型显式声明 base/modifiers，其余基础类型 base=自身。 */
export const STATIC_CATALOG = Object.fromEntries(
  REPORT_TYPES.filter((t) => t.code !== 'UNKNOWN').map((t) => {
    const code = t.code
    let base = code
    const modifiers = []

    // 已知组合：CBC_hsCRP -> base=CBC, modifiers=[HS_CRP]
    if (code === 'CBC_hsCRP') {
      base = 'CBC'
      modifiers.push('HS_CRP')
    }

    const titleKeywords = buildTitleKeywords(code)
    const aliases = ALIASES[code] || []

    return [code, {
      code,
      label: t.label,
      aliases,
      titleKeywords,
      signature: buildSignature(code, t.keyFields),
      base,
      modifiers,
      origin: 'static',
    }]
  })
)

// 为组合静态类型补齐 signature（如 LIVER_KIDNEY_ION 应包含三组 trigger 的并集）
for (const [combo, code] of Object.entries(STATIC_COMBO)) {
  if (!STATIC_CATALOG[code]) continue
  const groups = combo.split('+')
  const union = groups.flatMap((g) => GROUP_FIELD_SETS[g] || [])
  STATIC_CATALOG[code].signature = [...new Set([...STATIC_CATALOG[code].signature, ...union])]
}

// ========== 合并视图：静态 schema + 运行时动态目录 ==========

/**
 * 返回静态 schema 与 store 动态目录的合并只读视图。
 * 动态项与静态项共用命名空间；动态项不会覆盖静态项（register 时校验）。
 */
export function getMergedCatalog() {
  const dynamic = getState().typeCatalog || {}
  return { ...STATIC_CATALOG, ...dynamic }
}

// ========== 辅助：标题 / 项集归一 ==========

function normalizeText(str) {
  return String(str || '').replace(/\s+/g, '')
}

function extractCodeSet(points) {
  const set = new Set()
  const list = []
  for (const p of points || []) {
    const code = p.standard_code || p.code
    if (code) {
      set.add(code)
      list.push(code)
    }
  }
  return { set, list }
}

// ========== 正向互推：type -> expected items ==========

/** 由类型 code 得到期望子项目集合（正向推断）。 */
export function getExpectedCodes(code) {
  const entry = getMergedCatalog()[code]
  return entry ? [...(entry.signature || [])] : []
}

/** 得到聚合用的基础类型 code；若本身就是基础类型则返回自身。 */
export function getBaseType(code) {
  const entry = getMergedCatalog()[code]
  if (!entry) return null
  return entry.base || code
}

/** 基础类型的展示标签。 */
export function catalogBaseLabel(code) {
  const base = getBaseType(code)
  if (!base || base === code) return catalogLabel(code)
  return catalogLabel(base)
}

// ========== 标签与字段兼容层 ==========

/** 优先用 catalog，回退 dictionary.js 既有函数。 */
export function catalogLabel(code) {
  const entry = getMergedCatalog()[code]
  if (entry) return entry.label
  return legacyReportTypeLabel(code)
}

/** 返回某类型的重点/关键字段集合。 */
export function catalogKeyFields(code) {
  const entry = getMergedCatalog()[code]
  if (entry) return [...(entry.signature || [])]
  return legacyReportTypeKeyFields(code)
}

/** 在给定已识别 code 集合中，返回该类型命中的关键字段。 */
export function catalogKeyFieldsMatched(code, existingCodes) {
  const fields = catalogKeyFields(code)
  const existing = new Set(existingCodes || [])
  return fields.filter((f) => existing.has(f))
}

/** 列出当前合并目录下所有类型（静态 + 动态）。 */
export function catalogList() {
  const catalog = getMergedCatalog()
  return Object.values(catalog)
}

// ========== 反向互推：items -> type ==========

function scoreEntry(codeSet, entry) {
  const signature = entry.signature || []
  const modifiers = entry.modifiers || []
  const matched = signature.filter((c) => codeSet.has(c))
  const coverage = signature.length ? matched.length / signature.length : 0
  const precision = codeSet.size ? matched.length / codeSet.size : 0
  let score = coverage * precision

  // 修饰项全部命中时给组合类型一点优势，但仅在基础项也足够时
  const modMatched = modifiers.filter((c) => codeSet.has(c))
  const allModifiersPresent = modifiers.length === 0 || modMatched.length === modifiers.length
  if (modifiers.length && allModifiersPresent && coverage >= 0.5) {
    score += 0.06
  }
  // 过滤：signature 命中太少时直接置 0，避免超大 signature 的误匹配
  if (coverage < MIN_COVERAGE || precision < MIN_PRECISION) {
    score = 0
  }
  return { code: entry.code, coverage, precision, score, matched, allModifiersPresent, entry }
}

function titleMatch(normalizedTitle, catalog) {
  const hits = []
  for (const entry of Object.values(catalog)) {
    const kws = entry.titleKeywords || []
    const matched = kws.filter((k) => normalizedTitle.includes(k))
    if (matched.length) {
      const longest = Math.max(...matched.map((k) => k.length))
      hits.push({ code: entry.code, longest, origin: entry.origin, entry })
    }
  }
  // 优先最长关键词；同长度时静态优先
  hits.sort((a, b) => {
    if (b.longest !== a.longest) return b.longest - a.longest
    if ((a.origin === 'static') !== (b.origin === 'static')) {
      return a.origin === 'static' ? -1 : 1
    }
    return 0
  })
  return hits[0] || null
}

/** 从 GROUP_FIELD_SETS 命中情况生成组合 code；兼容 STATIC_COMBO 映射。 */
function buildComboCode(codeSet) {
  const groups = []
  for (const [group, fields] of Object.entries(GROUP_FIELD_SETS)) {
    if (fields.some((f) => codeSet.has(f))) groups.push(group)
  }
  const combo = groups.join('+')
  if (!combo) return null
  return STATIC_COMBO[combo] || combo
}

/** 为未命中静态目录的组合构造动态 CatalogEntry。 */
function buildComboCatalogEntry(code, groups, presentCodes) {
  const label = groups.map((g) => REPORT_GROUPS[g] || g).join(' + ')
  const signatureUnion = [...new Set(groups.flatMap((g) => GROUP_FIELD_SETS[g] || []))]
  const presentSet = [...new Set(presentCodes || [])]
  // 若当前项集已覆盖并集的超集，优先用实际项；否则用并集作为初始签名
  const signature = signatureUnion.length ? signatureUnion : presentSet

  // base 启发：组合中的第一个「本身是静态目录中的基础类型」的组
  let base = null
  for (const g of groups) {
    const e = STATIC_CATALOG[g]
    if (e && e.origin === 'static' && e.modifiers.length === 0) {
      base = g
      break
    }
  }

  return {
    code,
    label,
    aliases: [],
    titleKeywords: [],
    signature,
    base,
    modifiers: groups.filter((g) => g !== base),
    origin: 'dynamic',
    discoveredAt: new Date().toISOString(),
  }
}

/** Agent 全自动：把新类型写入 store 动态目录。 */
export function registerDiscoveredType(code, entry) {
  const catalog = getMergedCatalog()
  if (catalog[code]) return false
  // deferNotify：本函数可能在**渲染期**被调到（clean.js 的 analyzeRecords 在 useMemo 里重判标题 →
  // inferReportType 自动发现组合类型）。目录本身同步写入（后续同步调用能立刻命中、幂等），
  // 只把「通知订阅者重渲染」推迟到微任务，避免 React "setState while rendering" 警告。
  addCatalogEntry({ ...entry, code, origin: 'dynamic' }, { deferNotify: true })
  console.warn(`[reportCatalog] 新类型已自动发现并写入: ${code} - ${entry.label}`)
  return true
}

/**
 * 双向互推核心：标题特征优先 → 子项目签名匹配 → 组合兜底 + 自动发现。
 *
 * @param {any[]} points    数据点，元素需有 standard_code 或 code
 * @param {string} titleText OCR 标题文本（grid.flat().join(' ') 等）
 * @param {Object} [options]
 * @param {boolean} [options.autoRegister=true] 未命中时是否自动注册新类型
 * @returns {{ code: string|null, discovered: CatalogEntry[], scores: any[], expected: string[] }}
 */
export function inferReportType(points, titleText, { autoRegister = true } = {}) {
  const { set: codeSet } = extractCodeSet(points)
  const catalog = getMergedCatalog()
  const discovered = []

  // 0) 标题特征最高优先级
  const normalizedTitle = normalizeText(titleText)
  const titleHit = normalizedTitle ? titleMatch(normalizedTitle, catalog) : null
  if (titleHit) {
    return { code: titleHit.code, discovered, scores: [titleHit], expected: getExpectedCodes(titleHit.code) }
  }

  // 1) 反向互推：用项集签名评分
  const scored = Object.values(catalog)
    .map((entry) => scoreEntry(codeSet, entry))
    .filter((s) => s.score >= MIN_SCORE && s.coverage >= MIN_COVERAGE && s.precision >= MIN_PRECISION)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.coverage !== a.coverage) return b.coverage - a.coverage
    if (b.precision !== a.precision) return b.precision - a.precision
    // signature 更长的更具体
    return (b.entry.signature?.length || 0) - (a.entry.signature?.length || 0)
  })

  if (scored.length) {
    const best = scored[0]
    return { code: best.code, discovered, scores: scored, expected: getExpectedCodes(best.code) }
  }

  // 2) 组合兜底：遍历 GROUP_FIELD_SETS 生成组合 code，未命中则自动发现
  const combo = buildComboCode(codeSet)
  if (combo) {
    if (!catalog[combo] && autoRegister) {
      const groups = Object.entries(GROUP_FIELD_SETS)
        .filter(([_, fields]) => fields.some((f) => codeSet.has(f)))
        .map(([g]) => g)
      const entry = buildComboCatalogEntry(combo, groups, [...codeSet])
      if (registerDiscoveredType(combo, entry)) {
        discovered.push(entry)
      }
    }
    return { code: combo, discovered, scores: [], expected: catalog[combo] ? getExpectedCodes(combo) : [] }
  }

  // 3) 没有任何已知项：返回 UNKNOWN，不注册空类型
  return { code: 'UNKNOWN', discovered, scores: [], expected: [] }
}

/**
 * 与旧 detectReportType 保持相同签名的包装函数。
 * @param {any[]} points
 * @param {string} titleText
 * @returns {string}
 */
export function detectReportType(points, titleText) {
  return inferReportType(points, titleText, { autoRegister: true }).code || 'UNKNOWN'
}
