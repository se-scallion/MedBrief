// ===================== 病情三维度 · 从报告生成指标（自动，不手工录入）=====================
// 数据源（用户 2026-10-20 / 2026-10-21 定稿）：
//   ① 检验记录里的「骨髓形态学（涂片分类）」：records.report_type = BONE_MARROW_MORPHOLOGY
//      （业务上骨穿就是检验科细胞学检验，走化验通道录入，双列 -骨髓片/-血片 逐行入库）
//   ② 检验记录里的「白血病融合基因检测(骨髓)」：项目名含 BCR-ABL / 融合基因的定量报告 → 分子流
//   ③ 历史归档的检查报告：kind = bonemarrow / flow / genetic（老数据兼容，仍按所见/结论抽取）
// 产出直接是「已确认」点（verified:true），由报告原文背书；页面上可删除误识别项，但不提供手工新增。
// 每条报告/记录用 streamIngestedAt 标记，避免每次启动重复抽取（否则删掉的点会复活）。

import { extractStreamMetrics } from './streamExtract.js'
import { STREAMS } from '../data/diseaseThresholds.js'

const DOC_KINDS = new Set(['bonemarrow', 'flow', 'genetic'])
// 「白血病融合基因」检验报告的特征：项目名/备注里出现 BCR-ABL 或融合基因
const FUSION_RE = /BCR[\s\-–—/]?ABL|融合基因/i
// 骨髓形态学检验记录的特征：report_type 是它，或项目名带 -骨髓片/-血片 双列后缀
const MARROW_TYPE_RE = /BONE_MARROW_MORPHOLOGY|骨髓形态|骨髓细胞形态|涂片分类/i
const MARROW_ROW_RE = /(骨髓片|血片)/
// 流式免疫分型（FCM-MRD）检验记录的特征：report_type 是它，或项目名就是那行「流式MRD残留」
const FLOW_TYPE_RE = /FLOW_CYTOMETRY|流式|免疫分型|免疫表型|FCM/i
const FLOW_ROW_RE = /流式MRD|FCM[-_ ]?MRD|MRD|微小残留|残留白血病细胞|异常细胞群体/i
// 数字文本：允许 <0.01 / 未检出 / 阴性
const NUM_RE = /[<＜]?\s*\d+(?:\.\d+)?/

const dateOf = (x) => String((x && (x.checked_at || x.date || x.reported_at)) || '').slice(0, 10)

function toPoint(c, source) {
  return {
    ...c,
    date: dateOf({ date: c.date }),
    verified: true,
    source,
    flags: Array.isArray(c.flags) ? c.flags : [],
  }
}

/**
 * 检查报告 → 指标点（纯函数）
 * @param {Object} doc 归档报告（含 kind/findings/conclusion/measures/date）
 * @returns {Array} 直接可入库的点（verified=true）
 */
export function pointsFromDoc(doc) {
  if (!doc || !DOC_KINDS.has(doc.kind)) return []
  const res = extractStreamMetrics({
    kind: doc.kind,
    text: doc.raw_text || '',
    findings: doc.findings || '',
    conclusion: doc.conclusion || '',
    measures: doc.measures || [],
    date: dateOf(doc),
  })
  return res.candidates.map((c) => toPoint(c, { type: 'doc', doc_id: doc.id, track: 'ocr' }))
}

/** 检验记录是否像「白血病融合基因」定量报告 */
export function recordLooksLikeFusion(record) {
  if (!record) return false
  const names = (record.data_points || [])
    .map((p) => `${p.original_name || ''} ${p.name || ''} ${p.standard_code || ''}`)
    .join(' ')
  const hay = `${names} ${record.notes || ''} ${record.report_type || ''} ${record.title || ''} ${record.doc_type || ''}`
  return FUSION_RE.test(hay)
}

// 结构化项目名 → 直接取数（比把项目名拼成句子再正则更稳）
function directPcrFromPoints(record) {
  const out = []
  for (const p of record.data_points || []) {
    const name = `${p.original_name || ''} ${p.name || ''}`
    if (!/BCR/i.test(name) || !/ABL/i.test(name)) continue
    const rawValue = String(p.value == null ? '' : p.value).trim()
    const unit = String(p.unit || '%').trim()
    const lt = /^[<＜]/.test(rawValue)
    const nd = /未检出|阴性/.test(rawValue)
    if (nd) {
      out.push({
        stream: 'pcr',
        code: 'BCR_ABL1_RATIO',
        analyte: (name.match(/P\s*(190|210|230)/i) || [])[1] ? `P${(name.match(/P\s*(190|210|230)/i) || [])[1]}` : 'other',
        specimen: /外周血/.test(name) ? 'peripheral_blood' : 'bone_marrow',
        date: dateOf(record),
        value: null,
        qualifier: 'nd',
        unit: '%',
        lod: null,
        is_standardized: /IS|国际标准/i.test(name),
        raw: `${name}: ${rawValue}`,
        evidence: `${name}: ${rawValue}`,
        confidence: 0.9,
        flags: [],
      })
      continue
    }
    const num = parseFloat(rawValue.replace(/[<>＜]/g, ''))
    if (!Number.isFinite(num)) continue
    // 只取比率（%）：单位是 % 或项目名含「比率」；纯拷贝数不在此处理
    const isPercent = unit === '%' || /%|比率/.test(name)
    if (!isPercent) continue
    const tx = (name.match(/P\s*(190|210|230)/i) || [])[1]
    // 0 在 log 轴画不出来，判定按「未检出」，但数值保留 0（展示 0%，2026-10-24 用户拍板）
    const zero = num === 0
    out.push({
      stream: 'pcr',
      code: 'BCR_ABL1_RATIO',
      analyte: (name.match(/P\s*(190|210|230)/i) || [])[1] ? `P${(name.match(/P\s*(190|210|230)/i) || [])[1]}` : 'other',
      specimen: /外周血/.test(name) ? 'peripheral_blood' : 'bone_marrow',
      date: dateOf(record),
      value: num,
      qualifier: zero ? 'nd' : lt ? 'lt' : 'eq',
      unit: '%',
      lod: lt ? num : null,
      is_standardized: /IS|国际标准/i.test(name),
      raw: `${name}: ${rawValue}${unit === '%' ? '%' : ' ' + unit}`,
      evidence: `${name}: ${rawValue}${unit === '%' ? '%' : ' ' + unit}`,
      confidence: 0.85,
      flags: lt ? ['below_lod'] : [],
    })
  }
  return out
}

// ---------- 骨髓形态学（检验记录）→ 形态学流 ----------
// 业务口径（2026-10-21）：骨穿 = 检验科细胞学检验 → 走化验通道录入，
// 双列分类逐行入库（-骨髓片 / -血片，见 dictionary 的 BONE_MARROW_MORPHOLOGY 26 项）。
// 形态学目标值 = 骨髓片「原始 + 幼稚」之和（粒系原始/幼稚不属本流，与文本抽取器同口径）。
// 严谨口径（用户 2026-10-21 拍板）：**空白单元格不等于 0**——报告没写原始/幼稚比例就不产点，
// 由页面提示「需另导含原始细胞比例的骨穿报告」，绝不把「没分类」猜成 0% 去认证 CR。
const BLAST_NAME_RE = /原始|幼稚|原幼/ // 原幼淋 / 原幼粒 = 原始+幼稚的缩写写法
// 不属于本流的分项：①髓系（原始粒/幼稚粒/原幼粒）②红系（原始红/早幼红/原幼红/幼稚红）
// ③其它系（单核/巨核/嗜酸/嗜碱/浆/血小板）。2026-10-24 事故：「原始红细胞 0.5%」被当成原始细胞，
// 把 2026-10-10 骨穿的 CR 数值取成了红系前体（该份真实值为「原幼淋 1.5%」）。
const NOT_TARGET_LINEAGE_RE = /粒|红|单核|巨核|嗜酸|嗜碱|浆细胞|血小板/
const BLOOD_SPECIMEN_RE = /血片\s*$/

/** 检验记录是否像「骨髓形态学（涂片分类）」 */
export function recordLooksLikeMarrow(record) {
  if (!record) return false
  if (MARROW_TYPE_RE.test(String(record.report_type || ''))) return true
  return (record.data_points || []).some((p) => MARROW_ROW_RE.test(`${p.original_name || ''} ${p.name || ''}`))
}

/** 检验记录是否像「流式免疫分型（FCM-MRD）」 */
export function recordLooksLikeFlow(record) {
  if (!record) return false
  if (FLOW_TYPE_RE.test(String(record.report_type || ''))) return true
  return (record.data_points || []).some((p) => {
    const name = `${p.original_name || ''} ${p.name || ''} ${p.standard_code || ''}`
    return p.standard_code === 'FCM_MRD' || FLOW_ROW_RE.test(name)
  })
}

// 流式记录 → 形态学之外的第二条流（fcm）：一行 MRD 结果（数值 / 上界 / 未检出）
function flowPointsFromRecord(record) {
  const dp = (record.data_points || []).find((p) => {
    const name = `${p.original_name || ''} ${p.name || ''} ${p.standard_code || ''}`
    return p.standard_code === 'FCM_MRD' || FLOW_ROW_RE.test(name)
  })
  if (!dp) return []
  const raw = String(dp.value == null ? '' : dp.value).trim()
  if (!raw) return [] // 空白/无值不产点（与形态学同一严谨口径）
  const specimen = /外周血/.test(`${dp.original_name || ''} ${dp.name || ''}`) ? 'peripheral_blood' : 'bone_marrow'
  const evidence = `${dp.original_name || dp.name || '流式MRD残留'}: ${raw}${dp.unit || ''}`
  let value = null
  let qualifier = 'eq'
  let lod = null
  if (/未检出|未见异常|阴性|^0(\.0+)?%?$/.test(raw)) {
    qualifier = 'nd'
    // 报告写的是数字 0 → 保留 0（展示 0%）；写「阴性 / 未检出」→ 无数值（展示 未检出）
    const z = parseFloat(raw.replace(/%/g, ''))
    if (Number.isFinite(z) && z === 0) value = 0
  } else {
    const lt = /^[<＜]/.test(raw)
    const num = parseFloat(raw.replace(/[<>＜%]/g, ''))
    if (!Number.isFinite(num)) return []
    if (lt) {
      // 「MRD<0.01%」：上界即该院灵敏度，值按上界记录 + below_lod（log 轴画不出 0，同 doc 口径）
      qualifier = 'lt'
      value = num
      lod = num
    } else if (num === 0) {
      // 0 在 log 轴画不出来，判定按未检出，但数值保留 0（展示 0%）
      qualifier = 'nd'
      value = 0
    } else {
      value = num
    }
  }
  const lodFromRef = parseFloat(String(dp.ref_range || '').replace(/[<>＜%]/g, ''))
  return [
    {
      stream: 'fcm',
      code: STREAMS.fcm.code,
      analyte: null,
      specimen,
      date: dateOf(record),
      value: qualifier === 'nd' && !(value === 0) ? null : value,
      qualifier,
      unit: '%',
      lod: lod != null ? lod : qualifier === 'lt' ? value : Number.isFinite(lodFromRef) ? lodFromRef : null,
      raw: evidence,
      evidence,
      confidence: 0.9,
      flags: qualifier === 'lt' ? ['below_lod'] : [],
    },
  ]
}

function morphPointsFromMarrowRecord(record) {
  const bySpecimen = { bone_marrow: [], peripheral_blood: [] }
  const cells = []
  for (const p of record.data_points || []) {
    const name = String(p.original_name || p.name || '').trim()
    if (!name || !BLAST_NAME_RE.test(name)) continue
    if (NOT_TARGET_LINEAGE_RE.test(name)) continue
    const v = parseFloat(String(p.value == null ? '' : p.value).replace(/[<>＜]/g, ''))
    if (!Number.isFinite(v)) continue // 空白/无值 → 按严谨口径丢弃，不当 0
    const specimen = BLOOD_SPECIMEN_RE.test(name) ? 'peripheral_blood' : 'bone_marrow'
    // 「原幼淋 / 原始+幼稚淋巴细胞」是合计写法的单行，与拆成两行的报告互斥：
    // 同一标本下若出现合计行，只认合计行，避免 原始2% + 幼稚1.5% + 合计3.5% 被累加成 7%。
    const combined = /原幼|原始\s*[+及和、/]\s*幼稚/.test(name)
    cells.push({ name, value: v, specimen, combined })
    bySpecimen[specimen].push({ name, value: v, combined })
  }
  if (!cells.length) return []
  const diluted = /取材稀释|稀释|取材不佳|有核细胞偏少|细胞偏少/.test(
    `${record.notes || ''} ${record.title || ''} ${record.report_type || ''}`
  )
  const out = []
  for (const specimen of ['bone_marrow', 'peripheral_blood']) {
    const all = bySpecimen[specimen]
    if (!all.length) continue
    const list = all.some((x) => x.combined) ? all.filter((x) => x.combined) : all
    const value = Number(list.reduce((a, x) => a + x.value, 0).toFixed(2))
    const raw = list.map((x) => `${x.name} ${x.value}%`).join(' + ')
    out.push({
      stream: 'morph',
      code: STREAMS.morph.code,
      analyte: null,
      specimen,
      date: dateOf(record),
      value,
      qualifier: 'eq',
      unit: '%',
      lod: null,
      raw,
      evidence: raw,
      confidence: list.length >= 2 ? 0.9 : 0.8,
      flags: diluted ? ['diluted_sample'] : [],
    })
  }
  return out
}

/**
 * 检验记录 → 指标点（纯函数）
 * ① 骨髓形态学（涂片分类）→ 形态学流（原始+幼稚%；空白不当 0）
 * ② 流式免疫分型（FCM-MRD）→ 流式流（一行 MRD：数值 / <0.01 / 未检出）
 * ③ 白血病融合基因检测(骨髓) → 分子流（结构化项目名优先，其次拼文本走 qPCR 抽取）
 * @param {Object} record
 * @returns {Array} 直接可入库的点（verified=true）
 */
export function pointsFromRecord(record) {
  if (!record) return []
  const src = { type: 'record', record_id: record.id }
  const out = []

  // ① 骨髓形态学：一条记录最多出「骨髓片」「血片」两个点
  if (recordLooksLikeMarrow(record)) out.push(...morphPointsFromMarrowRecord(record))

  // ② 流式免疫分型：一行 MRD → fcm 点
  if (recordLooksLikeFlow(record)) out.push(...flowPointsFromRecord(record))

  // ③ 融合基因定量
  if (recordLooksLikeFusion(record)) {
    const direct = directPcrFromPoints(record)
    if (direct.length) out.push(...direct)
    else {
      // 项目名不规范时，把「名称 值 单位」拼成文本交给 qPCR 抽取器
      const text = (record.data_points || [])
        .map((p) => {
          const name = p.original_name || p.name || p.standard_code || ''
          if (!name) return ''
          const v = p.value == null ? '' : p.value
          return `${name} ${v} ${p.unit || ''}`.trim()
        })
        .filter(Boolean)
        .join('；')
      if (NUM_RE.test(text)) {
        const res = extractStreamMetrics({ kind: 'genetic', text, date: dateOf(record) })
        out.push(...res.candidates)
      }
    }
  }

  return out.map((c) => toPoint(c, src))
}


