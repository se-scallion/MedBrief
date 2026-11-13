// ===================== MedData → MedBrief 数据适配层 =====================
// 目的：MedData 的识别组件（ImportFlow / DocImportFlow / DataGrid / AiTaskCenter ...）
// 直接嵌进 MedBrief 的「资料导入」tab，但**数据真相源只有一个**：data/reports.json。
//
// 做法：Vite 构建时把 meddata/src 里对 ../data/store.js 的引用重定向到本文件
//      （见 web/vite.config.js 的 medbrief-meddata-shim 插件），组件源码不改。
//
// 红线：
//  1. 不连 8787、不写 MedData 任何库、不建第二套存储；
//  2. 保存一律走 MedBrief 自有 POST /api/intake/reports（含 sha256/dhash/内容指纹三道查重）；
//  3. 原件不重复保存：由 docFileStore shim 按 sha256 复用 blob，再以 sourceBlobs 关联入库。
import { useSyncExternalStore } from 'react'
import { takeBlobRefs } from './docFileStore.js'

const EVT_SAVED = 'medbrief:report-saved'
const EVT_FAILED = 'medbrief:report-failed'

function emit(type, detail) {
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }))
  } catch { /* 非浏览器环境忽略 */ }
}

// ---- 内存态：只用于 MedData 组件的「读」侧（类型目录 / 查重 / 网格列） ----
// 真正的持久化在后端 reports.json；这里每次保存成功后重新拉取对齐。
let state = {
  records: [], docs: [], events: [], courses: [], stays: [], invoices: [],
  drugPrices: [], diseaseMetrics: [], typeCatalog: {}, customFields: {},
  patientMeta: {}, feverThresholds: {}, tempDrugs: {},
}
const listeners = new Set()
const notify = () => { for (const cb of listeners) { try { cb() } catch { /* 忽略单个订阅者 */ } } }
const set = (next) => { state = { ...state, ...next }; notify() }

export function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) }
export function getState() { return state }
export function setState(fn) {
  const patch = typeof fn === 'function' ? fn(state) : fn
  state = { ...state, ...(patch || {}) }
  notify()
  return state
}
export function replaceState(next) { state = { ...state, ...(next || {}) }; notify(); return state }
export function useStore() { return useSyncExternalStore(subscribe, getState, getState) }
export function whenReady() { return hydrate() }

// ---- 把 MedBrief 的报告映射成 MedData 的记录形状（只读，供查重与列表） ----
function pointFromRow(r = {}) {
  return {
    name: r.name || '',
    value: r.value ?? '',
    unit: r.unit || '',
    ref_range: r.refRange || '',
    standard_code: r.code || r.standardCode || '',
    status: r.status || 'unknown',
    flag: r.flag || '',
  }
}
function rowFromPoint(p = {}, date = '') {
  const value = String(p.value ?? '').trim()
  const num = Number(value.replace(/[^\d.\-]/g, ''))
  const refRange = String(p.ref_range || p.refRange || '')
  let status = p.status || 'unknown'
  let flag = p.flag || ''
  if (status === 'high' || status === 'low') flag = status
  else if (status === 'normal') flag = ''
  return {
    name: p.name || p.item_name || p.item || '',
    value, num: Number.isFinite(num) ? num : null,
    unit: p.unit || '', refRange, flag, status,
    code: p.standard_code || '',
    reportDate: date, measuredAt: p.measuredAt || p.reportDate || date,
  }
}
function reportToRecord(r = {}) {
  return {
    id: r.id,
    date: r.reportDate || '',
    report_type: r.reportType || '',
    data_points: (r.rows || []).map(pointFromRow),
    notes: '', report_text: r.text || '',
    file_hash: r.sha256 || '', image_hash: r.sha256 || '',
    sha256: r.sha256 || '', kind: r.kind || '',
    _medbrief: true,
  }
}

let hydrated = false
export async function hydrate(force = false) {
  if (hydrated && !force) return state
  try {
    const res = await fetch('/api/intake/reports')
    const j = await res.json()
    const reports = Array.isArray(j.reports) ? j.reports : []
    const records = []
    const docs = []
    for (const r of reports) {
      const rec = reportToRecord(r)
      if ((r.rows || []).length || r.kind === 'lab') records.push(rec)
      else docs.push({ ...rec, doc_type: r.reportType || '', kind: r.kind || 'doc', title: '', file: { sha256: r.sha256 || '' } })
    }
    set({ records, docs })
    hydrated = true
  } catch (e) {
    console.warn('[medbrief/meddata] 读取已有报告失败：', e)
  }
  return state
}

// ---- 保存：MedData record/doc → MedBrief /api/intake/reports ----
function composeText(record) {
  const raw = String(record.report_text || '').trim()
  if (raw) return raw
  return (record.data_points || [])
    .map((p) => [p.name || '', p.value ?? '', p.unit || '', p.ref_range || ''].filter(Boolean).join(' '))
    .join('\n')
}

async function postReport(payload) {
  const res = await fetch('/api/intake/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await res.json().catch(() => ({}))
  if (j.ok && j.report) {
    await hydrate(true)
    emit(EVT_SAVED, { id: j.report.id, total: j.total, source: 'meddata' })
    return j.report.id
  }
  const reason = j.duplicate
    ? (j.hint || '这张报告已导入过') + `（与 ${j.duplicate.of || '已有记录'} 相似）`
    : (j.error || `入库失败 HTTP ${res.status}`)
  emit(EVT_FAILED, { error: reason, duplicate: !!j.duplicate })
  return null
}

/** 化验单记录。返回真实 report id；失败/重复返回 null（MedData 组件据此停在保存页并提示）。 */
export async function addRecord(record = {}) {
  const date = String(record.date || '')
  const rows = (record.data_points || []).map((p) => rowFromPoint(p, date))
  const sourceBlobs = takeBlobRefs()
  return postReport({
    image: record.image || '',
    text: composeText(record),
    rows,
    meta: {
      kind: 'lab',
      reportType: record.report_type || '',
      reportDate: date,
      sourceFile: '',
      sourceBlobs,
      origin: 'meddata-import',
      traceId: record.trace_id || '',
      fileHash: record.file_hash || '',
    },
    sourceBlobs,
  })
}

/** 检查/结论类报告：全文型，rows 必须为空（MedBrief 后端 textOnly 约定，避免把表头解析成假指标）。 */
export async function addDoc(doc = {}) {
  const parts = [doc.raw_text, doc.findings, doc.conclusion, doc.notes].filter((x) => String(x || '').trim())
  const sourceBlobs = takeBlobRefs()
  return postReport({
    image: doc.image || '',
    text: parts.join('\n\n'),
    rows: [],
    meta: {
      kind: doc.kind || 'imaging',
      reportType: doc.doc_type || '',
      reportDate: String(doc.date || ''),
      textOnly: true,
      sourceBlobs,
      origin: 'meddata-import',
      title: doc.title || '',
      fileHash: (doc.file && doc.file.sha256) || doc.sha || '',
    },
    sourceBlobs,
  })
}

/** MedBrief 暂不改记录的端点；覆盖式写入明确回报失败，绝不假装成功。 */
export async function writeRecord() {
  emit(EVT_FAILED, { error: 'MedBrief 当前不支持覆盖已有报告；请在「已导入报告」里删除后重新导入' })
  return { ok: false, action: 'unsupported' }
}

// ---- 查重：后端是最终裁决；这里给组件一个轻量的前端预判 ----
function contentKey(rec = {}) {
  const pts = (rec.data_points || []).map((p) => `${p.name || ''}=${p.value ?? ''}`).join('|')
  return `${rec.date || ''}|${rec.report_type || ''}|${pts}`
}
export function findDuplicateRecord(candidate = {}) {
  const hashes = [candidate.file_hash, candidate.image_hash, candidate.sha256].filter(Boolean)
  if (hashes.length) {
    const hit = state.records.find((r) => hashes.includes(r.sha256) || hashes.includes(r.file_hash))
    if (hit) return hit
  }
  const key = contentKey(candidate)
  if (!key.split('|').slice(2).join('|')) return null
  return state.records.find((r) => contentKey(r) === key) || null
}
export function findDuplicateDoc(candidate = {}) {
  const sha = (candidate.file && candidate.file.sha256) || candidate.sha || ''
  if (sha) return state.docs.find((d) => d.file?.sha256 === sha) || null
  return null
}
export const findSimilarDoc = () => null
export const findDuplicateInvoice = () => null
export function findCrossEntitySource() { return null }

export function docCategory(d = {}) { return String(d.kind || d.doc_type || 'other') }
export function getCustomFields() { return { ...(state.customFields || {}) } }

// ---- 以下为 MedData 其它模块可能引用的导出：本工作台不使用，保持无副作用 ----
const noop = () => undefined
export const collectChanges = () => ({})
export const markSynced = noop
export const resetSyncSnapshot = noop
export const replaceRecords = (records) => set({ records: Array.isArray(records) ? records : [] })
export const addCatalogEntry = noop
export const removeCatalogEntry = noop
export const addCustomField = noop
export const removeCustomField = noop
export const updateRecord = noop
export const deleteRecord = noop
export const updatePatientMeta = (m) => set({ patientMeta: { ...state.patientMeta, ...(m || {}) } })
export const updateFeverThresholds = noop
export const toggleTempDrug = noop
export const addEvent = noop
export const updateEvent = noop
export const deleteEvent = noop
export const addCourse = noop
export const updateCourse = noop
export const deleteCourse = noop
export const ensureDefaultCourse = noop
export const addDrugPrice = noop
export const updateDrugPrice = noop
export const deleteDrugPrice = noop
export const addStay = noop
export const updateStay = noop
export const deleteStay = noop
export const addInvoice = noop
export const updateInvoice = noop
export const deleteInvoice = noop
export const linkInvoiceToStay = noop
export const deleteDiseaseMetric = noop
export const updateDoc = noop
export const deleteDoc = noop
export const backfillDiseaseMetrics = noop
