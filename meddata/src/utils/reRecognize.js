// ===================== 重新识别（用最新算法重跑原件识别） =====================
// 用途：算法会持续更新，但历史归档报告的识别内容是用旧算法跑的。本模块用**当前**算法
// 对每件原件的 Blob 重跑识别，产出「旧识别 vs 新识别」对比，供用户在弹窗里逐项/整条确认后落库。
// 绝不自动覆盖旧数据——写入动作由 Modal 在用户确认时显式调用。
//
// 设计原则（与导入链路保持一致，避免落库形状偏差）：
//   - 记录：getRecordImage(blob) → runOCRWithRetry → normalizeGridToPoints → withStatus(computeStatus)
//   - 文档：getDocFile(blob) → File → 图片走 ocrImageToText / PDF 走 extractDocContent+ocrScannedPdfToText → parseDocText
//   - 旧/新对齐：记录复用 clean.js 的 buildCompareRows（按 standard_code 对齐）；文档走文本 diff
//
// 复用件：本项目唯一的逻辑复用点——单条入口、批量控制器、两个对比 Modal 都调用本模块。

import { getRecordImage, getDocFile } from './docFileStore.js'
import { runOCRWithRetry, ocrImageToText, ocrScannedPdfToText } from './ocr.js'
import { normalizeGridToPoints, computeStatus, inferReportType } from './normalize.js'
import { recognizeWithEngine } from './ocrEngines.js'
import { fuseEnginePoints } from './ocrFuse.js'
import { extractDocContent, parseDocText } from './parseDoc.js'
import { isMedLine, parseMedLine } from './medExtract.js'
import { normalizeCaseDocType, categoryOfKind } from '../data/docKinds.js'
import { extractReportTitle } from './reportTitle.js'
import { buildCompareRows, applyPointToPoints } from './clean.js'
import { version as RECOGNITION_VERSION } from '../data/recognition-version.json'

// 与 ImportFlow.withStatus 完全一致：逐点补 status，使重识别结果与导入时形状相同
function withStatus(points) {
  return (points || []).map((p) => ({
    ...p,
    status: computeStatus(p.standard_code, p.value, p.ref_range, p.arrow, p.unit),
  }))
}

// Blob → dataURL（OCR 接口用）
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

// ===== 化验记录：原件重跑 OCR =====
// 纯处理内核：给定 OCR 结果 {grid, date} 与旧记录，产出「旧 vs 新」对齐与差异。
// 不碰 IndexedDB / tesseract worker，便于在 node 端注入真实 OCR 结果做验证（见 scripts/verify-rerecognize.mjs）。
// 与 ImportFlow.startOcr 同口径：OCR 结果 → 数据点 + 类型识别（报告类型/标题/时间）。
// 抽出来是为保证「重新识别」与「初次识别」对类型的判定完全一致（同一套 inferReportType + 标题提取）。
function recognizeRecordFromOcr({ grid, items, date, time, reportedAt }) {
  const points = withStatus(normalizeGridToPoints(grid))
  const titleText = [(items || []).map((it) => (it.text || '')).join(' '), (grid || []).flat().join(' ')]
    .filter(Boolean)
    .join(' ')
  const reportType = inferReportType(points, titleText).code
  const reportTitle = extractReportTitle(items || [])
  const repTime = reportedAt && reportedAt.includes(' ') ? reportedAt.slice(reportedAt.lastIndexOf(' ') + 1) : ''
  return { points, reportType, reportTitle, time: time || '', reportedTime: repTime || '' }
}

export function reRecognizeRecordWithGrid({ grid, items, date, time, reportedAt }, record) {
  const { points, reportType, reportTitle, time: rTime, reportedTime } = recognizeRecordFromOcr({
    grid,
    items,
    date,
    time,
    reportedAt,
  })
  // 旧 vs 新：复用 buildCompareRows，cells[0]=旧、cells[1]=新、differs 标差异
  const rows = buildCompareRows([{ data_points: record.data_points || [] }, { data_points: points }])
  const diffCount = rows.filter((r) => r.differs).length

  // 类型/标题/时间：重新识别与初次识别同口径重跑，逐项可审查、可单独采用
  const typeRows = [
    { key: 'report_type', label: '报告类型', old: record.report_type || '', new: reportType, differs: (record.report_type || '') !== reportType },
    { key: 'report_title', label: '报告标题', old: record.report_title || '', new: reportTitle, differs: (record.report_title || '') !== reportTitle },
    { key: 'time', label: '报告时间', old: record.time || '', new: rTime, differs: (record.time || '') !== rTime },
    { key: 'reported_time', label: '采集时间', old: record.reported_time || '', new: reportedTime, differs: (record.reported_time || '') !== reportedTime },
  ]

  const newDate = date || ''
  const dateChanged = !!(newDate && record.date && newDate !== record.date)
  return {
    skipped: false,
    type: 'record',
    id: record.id,
    oldPoints: record.data_points || [],
    nextPoints: points,
    rows,
    diffCount,
    typeRows,
    dateDiff: { old: record.date || '', new: newDate, changed: dateChanged },
  }
}

export async function reRecognizeRecord(record, engine = 'local', opts = {}) {
  // E2E 测试钩子（scripts/test-rerecognize-ui.mjs）：浏览器测试时注入确定性识别结果，
  // 跳过真实 OCR，聚焦验证 UI 交互链路。生产环境不设置该 flag，行为完全不变。
  if (typeof window !== 'undefined' && typeof window.__MEDDATA_RR_RECORD_HOOK__ === 'function') {
    return window.__MEDDATA_RR_RECORD_HOOK__(record)
  }
  const id = record.original_image_id
  if (!id) return { skipped: 'no-image', id: record.id }
  const blob = await getRecordImage(id)
  if (!blob) return { skipped: 'no-image', id: record.id }

  const dataUrl = await blobToDataUrl(blob)
  // 多引擎：非 local 引擎走 ocrEngines（vision/mineru/ai），结果统一转成与 local 同形状的
  // 对比结构（typeRows 置空——换读字引擎不重推断类型/日期，保留旧值由用户在弹窗审查）。
  if (engine && engine !== 'local') {
    const res = await recognizeWithEngine(engine, dataUrl, {
      signal: opts.signal,
      id: `rr-${record.id}`,
      origin: 'rerec',
    })
    return reRecognizeRecordWithPoints(res, record)
  }
  const { grid, date, time, reportedAt, items } = await runOCRWithRetry(dataUrl)
  return reRecognizeRecordWithGrid({ grid, items, date, time, reportedAt }, record)
}

// 非本地引擎的对比结构：points 已过 normalize 理解层（ocrEngines 统一产出），
// rows 仍用 buildCompareRows 按 standard_code 对齐（与 local 完全同口径）。
// typeRows 置空：vision/mineru/ai 不产出报告类型/标题/日期（一期），保留旧值不动。
export function reRecognizeRecordWithPoints({ points, engine, elapsedMs, rawMeta }, record) {
  const rows = buildCompareRows([{ data_points: record.data_points || [] }, { data_points: points }])
  const diffCount = rows.filter((r) => r.differs).length
  return {
    skipped: false,
    type: 'record',
    id: record.id,
    engine,
    elapsedMs: elapsedMs || 0,
    degraded: !!rawMeta?.degraded,
    oldPoints: record.data_points || [],
    nextPoints: points,
    rows,
    diffCount,
    typeRows: [],
    dateDiff: { old: record.date || '', new: record.date || '', changed: false },
  }
}

// 多引擎结果融合（评审定稿契约）：以 results[0]（通常 local）为基准，其余引擎按 standard_code
// 补漏（标 _source）+ 冲突值并列（_conflicts），绝不覆盖基准值（Bug 031 红线）。
// 融合后重建 rows：与旧 data_points 对齐的口径完全不变。
export function fuseEngineResults(record, results) {
  const usable = (results || []).filter((r) => r && Array.isArray(r.nextPoints))
  if (!usable.length) return null
  const fused = fuseEnginePoints(
    usable[0].nextPoints,
    usable.slice(1).map((r) => ({ engine: r.engine, points: r.nextPoints })),
  )
  const rows = buildCompareRows([{ data_points: record.data_points || [] }, { data_points: fused }])
  const diffCount = rows.filter((r) => r.differs).length
  return {
    skipped: false,
    type: 'record',
    id: record.id,
    engine: 'fused',
    engines: usable.map((r) => r.engine),
    fused: true,
    oldPoints: record.data_points || [],
    nextPoints: fused,
    rows,
    diffCount,
    typeRows: [],
    dateDiff: { old: record.date || '', new: record.date || '', changed: false },
  }
}

// 文档做文本对比的字段（date 单独走 dateDiff，不在此列）
const DOC_TEXT_FIELDS = [
  ['findings', '所见'],
  ['conclusion', '结论'],
  ['measures', '关键指标'],
  ['title', '标题'],
]

// 病历文书（出院记录 / 诊断证明）的结构化字段。
// 之前只比 findings/conclusion/measures/title，出院记录重识别后显示「无变化」——
// 而出院日期/出院诊断/出院医嘱恰恰是最容易 OCR 错、也最影响下游（用药、住院天数）的字段。
const CASE_DIFF_FIELDS = {
  discharge: [
    ['discharge_date', '出院日期'],
    ['admission_date', '入院日期'],
    ['hospital_days', '住院天数'],
    ['discharge_diagnosis', '出院诊断'],
    ['discharge_advice', '出院医嘱'],
    ['discharge_meds', '出院用药'],
  ],
  cert: [
    ['diagnosis', '诊断'],
    ['rest_days', '建议休息天数'],
    ['department', '科室'],
    ['doctor', '医师'],
  ],
}
// 结构化字段之后仍要带的通用文本字段。注意：不含 measures（关键指标）——病历文书（出院/诊断证明）
// 无化验指标，比它只会产生「空→空」噪声（见 verify-rerecognize-core [3]）。关键指标仅在检查报告分支
// （DOC_TEXT_FIELDS）参与比对。
const CASE_TAIL_FIELDS = [['title', '标题'], ['findings', '所见'], ['conclusion', '结论']]

// 从「出院医嘱」段落（已剥去段头的纯文本块）里抽「出院用药」清单，格式化为逐药一行的可读文本。
// 供重新识别作为独立差异项比对/展示；不单独写库，勾选后随 patch 作为 doc.fields.discharge_meds 一并入库。
function dischargeMedsText(advice) {
  if (!advice) return ''
  const rows = String(advice)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(isMedLine)
    .map(parseMedLine)
    .filter(Boolean)
  if (!rows.length) return ''
  return rows
    .map((r) => [r.name, r.spec, r.usage].filter(Boolean).join(' ').trim())
    .filter(Boolean)
    .join('\n')
}

// 所有文档类型都要比对的「类型」字段：初次识别会产出 doc_type/kind，重新识别也由 parseDocText
// 重解析了，必须进 diff 供用户审查/采用，否则会出现「类型没被重新识别」的观感（原 Bug 119 修复点）。
const TYPE_FIELDS = [
  ['doc_type', '报告类型'],
  ['kind', '报告类别'],
]
// 仅检查报告（超声 / CT / MR / X 光 / 心电图 / 骨髓等）有「检查部位 / 检查时间」概念；
// 病历文书（出院记录 / 诊断证明）无此概念，part/time 恒空、比对纯属噪声，故只给检查报告分支。
const EXAM_META_FIELDS = [
  ['part', '部位'],
  ['time', '报告时间'],
]

// 报告类别 code → 中文标签（diff 里展示用，避免裸 code）
const KIND_LABELS = {
  lab: '化验单',
  doc: '检查报告',
  case: '病历文书',
  ecg: '心电图',
  ultrasound: '超声',
  ct: 'CT',
  mri: '磁共振',
  xray: 'X 光',
  bonemarrow: '骨髓形态',
  discharge: '出院记录',
  cert: '诊断证明',
  other: '其他检查',
}
const kindLabel = (k) => (k ? KIND_LABELS[k] || k : '')

function pickDocFields(doc) {
  const o = {}
  for (const [k] of DOC_TEXT_FIELDS) o[k] = doc[k] || ''
  return o
}

// 把任意字段值规整成可显示/可对比的文本。关键点：空值（空串 / 空数组 / 空对象 /
// 其字符串形态 '[]' '{}' '""'）一律归一成 ''，否则「旧='' ↔ 新=[]」会被判成差异，
// 实为两边皆空、纯属噪声（见重新识别弹窗「关键指标 （空）→[]」伪差异）。
const asText = (v) => {
  if (v == null) return ''
  if (typeof v === 'string') {
    const s = v.trim()
    return s === '' || s === '[]' || s === '{}' || s === '""' ? '' : s
  }
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : ''
  if (typeof v === 'object') return Object.keys(v).length ? JSON.stringify(v) : ''
  return String(v)
}

// 差异字段清单按文书类型分发：
//  - 病历文书（出院记录/诊断证明）：比「类型」(doc_type/kind) + 结构化字段 + 标题/所见/结论；
//  - 检查报告：比「类型」+「检查部位/时间」(EXAM_META_FIELDS) + 所见/结论/关键指标/标题。
function diffSchema(kind) {
  const caseFields = CASE_DIFF_FIELDS[kind]
  const typeCommon = TYPE_FIELDS.map(([k, label]) => ({ k, label, root: null }))
  if (!caseFields) {
    return [
      ...typeCommon,
      ...EXAM_META_FIELDS.map(([k, label]) => ({ k, label, root: null })),
      ...DOC_TEXT_FIELDS.map(([k, label]) => ({ k, label, root: null })),
    ]
  }
  return [
    ...typeCommon,
    ...caseFields.map(([k, label]) => ({ k, label, root: 'fields' })),
    ...CASE_TAIL_FIELDS.map(([k, label]) => ({ k, label, root: null })),
  ]
}

function docTextDiffs(doc, nextFields, kind) {
  return diffSchema(kind).map(({ k, label, root }) => {
    let oldV = root ? (doc.fields || {})[k] : doc[k]
    let newV = root ? (nextFields.fields || {})[k] : nextFields[k]
    if (k === 'kind') {
      oldV = kindLabel(oldV)
      newV = kindLabel(newV)
    }
    oldV = asText(oldV).trim()
    newV = asText(newV).trim()
    return { field: root ? `${root}.${k}` : k, label, old: oldV, new: newV, differs: oldV !== newV }
  })
}

// 导入流程用：对内存中的 File 重跑一次「提取全文」（与 reRecognizeDoc 同源，但不经过 IndexedDB）。
// 图片 → OCR；PDF → 有文字层直接取文字，扫描件走内嵌图 OCR。
export async function docFileToText(file) {
  const isImage = (file.type || '').startsWith('image/')
  if (isImage) return ocrImageToText(await blobToDataUrl(file))
  const content = await extractDocContent(file)
  return content.isScanned ? ocrScannedPdfToText(file) : content.text || ''
}

// ===== 检查报告：原件重跑解析 =====
export async function reRecognizeDoc(doc) {
  // E2E 测试钩子：浏览器测试时注入确定性解析结果，跳过真实 OCR/PDF 解析。
  // 生产环境不设置该 flag，行为完全不变。
  if (typeof window !== 'undefined' && typeof window.__MEDDATA_RR_DOC_HOOK__ === 'function') {
    return window.__MEDDATA_RR_DOC_HOOK__(doc)
  }
  const fid = doc.file && doc.file.id
  if (!fid) return { skipped: 'no-image', id: doc.id }
  const blob = await getDocFile(fid)
  if (!blob) return { skipped: 'no-image', id: doc.id }

  const name = (doc.file && doc.file.name) || 'doc'
  const file = new File([blob], name, {
    type: blob.type || (doc.file && doc.file.type) || 'application/pdf',
  })

  const isImage = (file.type || '').startsWith('image/')
  let rawText = ''
  if (isImage) {
    // 图片：无文字层，直接 OCR（与 DocImportFlow 图片分支一致）
    rawText = await ocrImageToText(await blobToDataUrl(blob))
  } else {
    // PDF：先判定是否有文字层；扫描件无文字层 → 提取内嵌图再 OCR（与 DocImportFlow 扫描件分支一致）
    const content = await extractDocContent(file)
    if (content.isScanned) rawText = await ocrScannedPdfToText(file)
    else rawText = content.text
  }

  const parsed = parseDocText(rawText || '')
  return reRecognizeDocWithParsed(parsed, doc)
}

// 纯处理内核：给定 parseDocText 解析结果 parsed 与旧 doc，产出文本字段差异。不碰 IndexedDB。
export function reRecognizeDocWithParsed(parsed, doc) {
  const isDischarge = parsed.kind === 'discharge'
  // 出院用药：从「出院医嘱」里单独抽出用药清单，作为独立差异项（旧医嘱用药 ↔ 新医嘱用药），
  // 让重新识别聚焦到用药本身、而非比整段出院医嘱。勾选后以 doc.fields.discharge_meds 入库。
  const oldMeds = isDischarge ? dischargeMedsText((doc.fields || {}).discharge_advice) : ''
  const newMeds = isDischarge ? dischargeMedsText((parsed.fields || {}).discharge_advice) : ''
  const nextFields = {
    kind: parsed.kind,
    doc_type: parsed.doc_type,
    // 大类必须与 docDup.docCategoryOf 同源：重识别会给 doc **显式写回** category，
    // 若这里写死 'exam'，一份骨髓/流式/基因报告被重识别后就会带着 exam 落库，
    // 与新增的按 kind 推导（lab）不一致 → 同份报告还能被再归档一次（查重按 category 隔离）。
    category: parsed.category || categoryOfKind(parsed.kind),
    fields: { ...(parsed.fields || {}), ...(isDischarge ? { discharge_meds: newMeds } : {}) },
    part: parsed.part || '',
    date: parsed.date,
    time: parsed.time,
    reported_at: parsed.reported_at || '',
    title: parsed.title,
    findings: parsed.findings,
    conclusion: parsed.conclusion,
    measures: parsed.measures,
  }

  // 出院用药用「旧医嘱用药 / 新医嘱用药」对齐：把抽出的旧用药挂到 diffDoc.fields.discharge_meds，
  // 这样 docTextDiffs 直接比对两份用药清单；双方皆空则不展示该行（避免无用药记录时多一行空噪声）。
  const diffDoc = oldMeds ? { ...doc, fields: { ...(doc.fields || {}), discharge_meds: oldMeds } } : doc
  // 字段清单以**新解析的类型**为准：类型被纠正时（出院记录 → 诊断证明）若仍按旧类型选清单，
  // 会拿「出院诊断/出院医嘱」去比一份证明书，结果全是「→ 空」，而真正的「诊断」根本没有可比的行。
  let diffs = docTextDiffs(diffDoc, nextFields, parsed.kind || doc.kind)
  if (isDischarge && !oldMeds && !newMeds) diffs = diffs.filter((d) => d.field !== 'discharge_meds')
  const diffCount = diffs.filter((d) => d.differs).length
  const newDate = parsed.date || ''
  const dateChanged = !!(newDate && doc.date && newDate !== doc.date)
  return {
    skipped: false,
    type: 'doc',
    id: doc.id,
    oldFields: pickDocFields(doc),
    nextFields,
    diffs,
    diffCount,
    dateDiff: { old: doc.date || '', new: newDate, changed: dateChanged },
  }
}

// ===== 逐项采用：只把「用户勾中」的新值合并进旧数据 =====
// 为何要单独成函数：早先对比弹窗底部只有一个「应用新结果」，一点就把整条新结果（含识别错的
// 出院诊断、出院医嘱）写库，用户没法只留「日期校正了、其它项识别错了」的正确部分。
// 现在写入一律走这里：
//   - adopted：Set<字段 key>，key 与 result.diffs[].field 同口径（'title' / 'fields.discharge_diagnosis'）
//   - 未勾选的字段一律沿用旧值（含 doc.fields 下的结构化字段），绝不整条覆盖
//   - 日期只有 dateAdopted 才写；category 跟随 kind 派生
//   - recognition_version 只在「全部差异都采用」= 等价整条新结果时标记；
//     部分采用属混采态，保留旧版本号，日后仍能被「待重识别候选」筛出
const TOP_FIELDS = ['kind', 'doc_type', 'title', 'findings', 'conclusion', 'measures', 'part', 'time']
const FIELD_PREFIX = 'fields.'

export function buildDocPatch({ doc, result, adopted = new Set(), dateAdopted = false }) {
  const diffs = result.diffs || []
  const nf = result.nextFields || {}
  const nfFields = nf.fields || {}
  const patch = {}

  // 结构化字段（出院日期/入院日期/住院天数/出院诊断/出院医嘱/出院用药…）：逐项合并
  const fieldDiffs = diffs.filter((d) => d.field.startsWith(FIELD_PREFIX))
  if (fieldDiffs.some((d) => adopted.has(d.field))) {
    const merged = { ...(doc.fields || {}) }
    for (const d of fieldDiffs) {
      if (!adopted.has(d.field)) continue
      const k = d.field.slice(FIELD_PREFIX.length)
      merged[k] = nfFields[k]
    }
    patch.fields = merged
  }

  // 顶层字段（所见/结论/标题/类型…）：同样逐项合并
  for (const k of TOP_FIELDS) {
    if (adopted.has(k) && nf[k] !== undefined) patch[k] = nf[k]
  }
  // 文书 doc_type 归一到规范值（「诊断证明书/出院诊断证明书」≡「诊断证明」），
  // 否则查重键 date+doc_type+file_name 会因一个「书」字漏判重复
  if (patch.doc_type !== undefined) patch.doc_type = normalizeCaseDocType(patch.doc_type, nf.kind || doc.kind)
  // category 由 kind 派生：只有采用新 kind 才跟着改，否则保留旧类别
  if (adopted.has('kind')) {
    patch.category = nf.category || (['discharge', 'cert'].includes(nf.kind) ? 'case' : 'exam')
  }
  // 类型被改判（出院记录 ↔ 诊断证明）时清掉旧类型的专属字段：否则库里会留下
  // 「kind=cert 但 fields.discharge_diagnosis=…」的混合态，详情页还会把出院诊断当成证明书字段显示。
  if (adopted.has('kind') && nf.kind !== doc.kind) {
    const stale =
      nf.kind === 'cert'
        ? ['discharge_diagnosis', 'discharge_advice', 'discharge_meds']
        : nf.kind === 'discharge'
          ? ['diagnosis', 'rest_days']
          : []
    // 即使一个 fields 都没勾，也要把「旧类型专属字段」清掉：否则 kind 变了字段没变（混合态）
    if (stale.length) {
      patch.fields = { ...(patch.fields || doc.fields || {}) }
      for (const k of stale) delete patch.fields[k]
    }
  }

  const newDate = (result.dateDiff || {}).new || ''
  if (dateAdopted && newDate) patch.date = newDate

  const changed = diffs.filter((d) => d.differs)
  if (changed.length && changed.every((d) => adopted.has(d.field))) {
    patch.recognition_version = CURRENT_RECOGNITION_VERSION
  }
  return patch
}

// 当前识别算法版本（落库追溯用：标记该报告由哪版算法识别，便于日后筛「待重识别候选」）
export const CURRENT_RECOGNITION_VERSION = RECOGNITION_VERSION

// ===== 批量顺序重跑（OCR 重负载，必须顺序，避免并行打满 CPU）=====
// items: [{ kind:'record'|'doc', ref, label }]
// onProgress({ done, total, current })；isCancelled() 返回 true 时优雅中止
// 返回结果数组（每条含 skipped/error 等状态，供批量清单渲染）
export async function runBatchReRecognize({ items, onProgress, isCancelled }) {
  const results = []
  const total = items.length
  let done = 0
  for (const item of items) {
    if (isCancelled && isCancelled()) break
    onProgress && onProgress({ done, total, current: item })
    try {
      const res =
        item.kind === 'doc' ? await reRecognizeDoc(item.ref) : await reRecognizeRecord(item.ref)
      res.label = item.label
      res.kind = item.kind
      results.push(res)
    } catch (e) {
      // 单条失败不应中断整批：记录错误后继续，由清单标记「失败」
      console.error('[reRecognize] 单条重识别失败', item, e)
      results.push({
        skipped: 'error',
        error: String((e && e.message) || e),
        id: item.ref && item.ref.id,
        label: item.label,
        kind: item.kind,
      })
    }
    done++
    onProgress && onProgress({ done, total, current: null })
  }
  return results
}
