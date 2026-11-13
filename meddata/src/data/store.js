// ===================== 本地持久化（IndexedDB） =====================
// 本地权威数据存在浏览器（macbook 的 IndexedDB）；默认经 apiStore.js 同步到项目机 SQLite（data-server.mjs）做备份 / 双机共享（设置页可关；服务端不可达时本地照常用）。
// 全部数据（结构化状态 + 报告原件 Blob + 记录原图 + 提取全文）统一落在 IndexedDB：
//   - store.js 的 stateDb：结构化状态（patient_meta / records / events / docs 索引 / ...）
//   - docFileStore：报告原件 Blob（files）+ 提取全文（texts）+ 记录原图（record_images）
// 早期版本结构化状态用 localStorage（5MB 上限，文档量大就超配额），现已迁到 IndexedDB（配额数 GB）。
// localStorage 仅作一次性迁移来源与少量辅助缓存（trace / feedback 暂存），不再承载主数据。

import { useSyncExternalStore } from 'react'
import { deleteDocFile, saveDocText, deleteDocText, getDocFile } from '../utils/docFileStore.js'
import { fingerprint } from '../utils/normalize.js'
import { isFuzzyDup } from '../utils/clean.js'
import { dataUrlFingerprint, fileFingerprint } from '../utils/fileHash.js'
import { findDocDuplicateIn, findSimilarDocIn, docCategoryOf } from '../utils/docDup.js'
import { findCrossEntityHit } from '../utils/dupScan.js'
import { isDateStr, normDrug } from '../utils/medCourses.js'
import { deleteRecordImage, saveRecordImage, dataUrlToBlob } from '../utils/docFileStore.js'
import { buildSnapshot, diffState } from '../utils/syncDiff.js'
import { upsertPoints } from '../utils/diseaseStore.js'
import { pointsFromDoc, pointsFromRecord } from '../utils/diseaseIngest.js'
import { planRecordWrite, isWritePersisted, WRITE_APPEND } from '../utils/recordWrite.js'
import { findDuplicateInvoice as findDupInvoice, invoicePageFiles } from '../utils/invoice.js'

const KEY = 'meddata_ai_v1' // 旧版 localStorage 状态键：仅用于首次迁移，迁移后不再写入

// ---- IndexedDB 状态库（结构化状态统一落 IndexedDB，配额数 GB，告别 localStorage 5MB 瓶颈）----
const STATE_DB = 'meddata_state'
const STATE_DB_VERSION = 2
const STATE_STORE = 'state'
const STATE_ID = 'current'
const SYNC_META_STORE = 'sync_meta'
const SYNC_SNAPSHOT_ID = 'snapshot'
let stateDbPromise = null
function openStateDb() {
  if (stateDbPromise) return stateDbPromise
  stateDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(STATE_DB, STATE_DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STATE_STORE)) {
        req.result.createObjectStore(STATE_STORE, { keyPath: 'id' })
      }
      if (!req.result.objectStoreNames.contains(SYNC_META_STORE)) {
        req.result.createObjectStore(SYNC_META_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return stateDbPromise
}

// ---- 同步快照（上次成功同步到服务端时的轻量指纹快照）----
// 内存态 + 持久化到 IndexedDB，避免「删了东西没推送就刷新 → 复活」。
let syncSnapshot = null
async function loadSyncSnapshot() {
  try {
    const db = await openStateDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(SYNC_META_STORE, 'readonly')
      const r = tx.objectStore(SYNC_META_STORE).get(SYNC_SNAPSHOT_ID)
      r.onsuccess = () => resolve(r.result ? r.result.snap : null)
      r.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}
async function persistSyncSnapshot(snap) {
  try {
    const db = await openStateDb()
    await new Promise((resolve) => {
      const tx = db.transaction(SYNC_META_STORE, 'readwrite')
      if (snap) {
        tx.objectStore(SYNC_META_STORE).put({ id: SYNC_SNAPSHOT_ID, snap, updated_at: new Date().toISOString() })
      } else {
        tx.objectStore(SYNC_META_STORE).delete(SYNC_SNAPSHOT_ID)
      }
      tx.oncomplete = resolve
      tx.onerror = () => resolve()
    })
  } catch {
    /* 快照持久化失败不影响主流程 */
  }
}
async function loadStateFromDb() {
  try {
    const db = await openStateDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(STATE_STORE, 'readonly')
      const r = tx.objectStore(STATE_STORE).get(STATE_ID)
      r.onsuccess = () => resolve(r.result ? r.result.state : null)
      r.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}
async function persistStateToDb(s) {
  try {
    const db = await openStateDb()
    await new Promise((resolve) => {
      const tx = db.transaction(STATE_STORE, 'readwrite')
      tx.objectStore(STATE_STORE).put({ id: STATE_ID, state: s, updated_at: new Date().toISOString() })
      tx.oncomplete = resolve
      tx.onerror = () => resolve() // 写入失败不阻塞主流程
    })
  } catch (e) {
    console.error('[MedData] IndexedDB 状态写入失败（可能超出浏览器配额）：数据可能无法持久化', e)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('meddata:storage-error', { detail: String((e && e.message) || e) }))
    }
  }
}

const DEFAULT_STATE = {
  patient_meta: {
    age: 30,
    gender: 'Male',
    diagnosis: 'B-cell Acute Lymphoblastic Leukemia (B-ALL)',
  },
  // 发烧阈值（℃，可微调并持久化）：≥ low 标「低热」，≥ high 标「高热」
  feverThresholds: { low: 37.3, high: 38.5 },
  records: [], // [{ id, date, report_type, data_points, notes, created_at }]
  // 统一事件数组：治疗事件（输血 / 用药），全部记录在时间线上。
  // 旧版待办任务（kind:'task'）已由 migrateStoredTasks 一次性迁移为用药事件，不再区分。
  events: [],
  // docs 索引（轻量）：raw_text 全文已剥离，存 IndexedDB（docFileStore.texts），按 doc.id 关联
  docs: [], // [{ id, kind, doc_type, category('exam'|'case'), fields{}, date, time, title, findings, conclusion, measures, has_text, file, notes, created_at }]
            // category 老数据惰性推导（见 docCategory）：出院记录/诊断证明→'case'，其余→'exam'；fields 仅病历文书有结构化字段。
  // 病情三维度指标点（独立于 records/docs；流式/分子/形态学各自成流，不合并）
  // { id, stream, code, analyte, specimen, date, value, qualifier, unit, lod, flags, source, verified, created_at, updated_at }
  // 去重键 = stream|code|analyte|specimen|date（见 utils/diseaseStore.js）
  diseaseMetrics: [],
  // Agent 自动发现的报告类型目录（运行时动态层，叠加在 src/data/reportCatalog.js 静态 schema 上）
  typeCatalog: {}, // { [code]: CatalogEntry }
  tempIrrelevantDrugs: [], // string[]
  // 用户自定义指标字典（AI 识别出的新项，经人工确认 / 报告提交后持久化）。
  // 复用整状态持久化（persistStateToDb 存整 state），无需单独 IndexedDB 表。
  // key = custom:<slug>（命名空间隔离，避免与标准 code 撞名）；value = { code, name, unit, ref, addedAt }。
  // 注意：这是浏览器侧 IndexedDB，AI agent（服务端 dsh headless）读不到；复用靠前端在
  // POST /api/ai-docread 时把 customFields 注入请求 → 落盘进 ai-docread-<id>.json → prompt 读取。
  customFields: {}, // { [code]: { code, name, unit, ref, addedAt } }
  // ---- 疗程与费用（区间实体，独立于 events 时间点流）----
  // 疗程 = 顶层治疗阶段（诱导 / 巩固 / 维持…）。只记起始日：
  //   结束 = 下一疗程起始日 − 1，最后一个疗程 = 至今（end 不落库，由 courseRanges 推导）。
  // 用药 / 住院 / 输血按【日期】自动归入疗程（不在事件上挂 courseId：
  // 否则跨疗程持续用药要被拆成两条事件，且需破坏性迁移）。
  courses: [], // [{ id, name, start, note }]
  // 药品价格档案（自费药才填；同一药多行 = 价格变动史，只记生效日 from，
  // 结束由同药下一条的 from − 1 推导，最后一条 = 至今）。
  // 一条 = 一个「每包装规格」：content 含量 + contentUnit 含量单位(mg/μg/g) +
  //   volume 体积(mL, 针剂/输注填, 口服留空) + pkgUnit 包装单位(片/只/支/袋) + price 单价(元/pkgUnit)。
  // 原液浓度 = 含量÷体积（仅针剂）；费用 = 每日剂量÷每包装含量×单价（按量计费）。
  // wholePack=true → 整支出库：每段用量向上取整到整只/整瓶（针剂余量弃用），缺省/false = 按比例。
  drugPrices: [], // [{ id, drug, from, content, contentUnit, volume, pkgUnit, price, brand, wholePack }]
  // 住院段：每次住院一条，total 为该段自费总额，按住院天数均摊到每一天再归集到疗程 / 月份。
  // 口径（用户 2026-10-21 定）：total = **实际花费（实掏，报销后）**，不是票面总额。
  stays: [], // [{ id, start, end, total, note }]
  // 发票 / 医保结算单（凭证实体）。与 stays 是**两本账**：stays 记实掏，这里记票面。
  // 查重键 = 票号（utils/invoice.js::invoiceKey）；原件 Blob 走 docFileStore 的 f_ 前缀。
  // stay_id 是**落库的**归属结果（不每次现算：否则改住院日期会让历史归属静默漂移）；
  // stay_link='manual' 表示用户手改过，自动匹配永不再覆盖。
  invoices: [], // [{ id, invoice_code, invoice_no, check_code, file_hash, issued_at, service_from, service_to, amount_*, stay_id, stay_link, file{}, doc_kind, ... }]
}

let state = structuredClone(DEFAULT_STATE)
const listeners = new Set()
let hydrated = false

// 水合：启动后从 IndexedDB（首次则回退旧版 localStorage 迁移）载入权威状态，
// 再跑一次性迁移，最后标记已就绪并落盘。组件用 useStore 会在状态变化后自动重渲染。
const readyPromise = (async () => {
  let saved = await loadStateFromDb()
  syncSnapshot = await loadSyncSnapshot() // 载入上次同步快照（可能为空）
  if (!saved) {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) saved = JSON.parse(raw)
    } catch {
      /* 旧 localStorage 解析失败则用默认 */
    }
  }
  if (saved) {
    state = { ...DEFAULT_STATE, ...saved }
    listeners.forEach((l) => l())
  }
  await runMigrations()
  hydrated = true
  await persistStateToDb(state)
})().catch((e) => {
  console.error('[MedData] 状态水合失败，使用默认空状态', e)
  hydrated = true
})

// 供 App 在首屏等待水合完成（避免空数据闪烁、保证迁移跑完）
export function whenReady() {
  return readyPromise
}

function save() {
  // 通知数据源层：本地已变更，debounce 后推送到服务端（若启用）。
  // 用事件而非直接 import，避免 store ↔ apiStore 循环依赖。
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('meddata:state-changed'))
  }
  // 水合完成前不落盘：避免覆盖尚未载入的权威数据
  if (hydrated) persistStateToDb(state)
}

export function getState() {
  return state
}

// opts.deferNotify：先改内存态、**下一个微任务**再通知订阅者。
// 用于「渲染期被动写入」的场景（如 utils/clean.js 在 useMemo 里跑标题重判 → reportCatalog 自动登记
// 新发现的组合类型）：同步通知会让 React 报 "Cannot update a component while rendering a different
// component"，而那些订阅者只是拿目录做下拉/标签展示，晚一个微任务刷新完全无感。
export function setState(fn, { deferNotify = false } = {}) {
  state = fn(state)
  save()
  if (deferNotify) {
    queueMicrotask(() => listeners.forEach((l) => l()))
    return
  }
  listeners.forEach((l) => l())
}

// 整库恢复：用备份的完整状态整体替换本地数据（覆盖式），写回并通知所有订阅者
export function replaceState(next) {
  state = { ...DEFAULT_STATE, ...next }
  save()
  listeners.forEach((l) => l())
}

// ---- 同步快照层（与 syncDiff.js 配合）----
// collectChanges：与上次同步快照 diff，产出仅实际变动的 Changes；
//                 无快照时全量 upsert、零 deletes（不会误删）。
// markSynced：用服务端终态重建快照并持久化（推送+拉取成功后调用）。
// resetSyncSnapshot：清空快照，下次 collectChanges 视为全量 upsert（如切换数据源）。
export function collectChanges() {
  return diffState(syncSnapshot, state)
}

export function markSynced(serverState) {
  syncSnapshot = buildSnapshot(serverState)
  persistSyncSnapshot(syncSnapshot)
}

export function resetSyncSnapshot() {
  syncSnapshot = null
  persistSyncSnapshot(null)
}

export function subscribe(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useStore() {
  return useSyncExternalStore(subscribe, getState)
}

// ---- 类型目录操作 ----

export function addCatalogEntry(entry, opts = {}) {
  if (!entry || !entry.code) return false
  setState(
    (s) => {
      if (s.typeCatalog[entry.code]) return s
      return {
        ...s,
        typeCatalog: { ...s.typeCatalog, [entry.code]: entry },
      }
    },
    { deferNotify: !!opts.deferNotify }
  )
  return true
}

export function removeCatalogEntry(code) {
  setState((s) => {
    const { [code]: _, ...rest } = s.typeCatalog
    return { ...s, typeCatalog: rest }
  })
}

// ---- 自定义指标字典（AI 新项经确认 / 提交后持久化）----
// 命名空间隔离：外部传入的 slug 统一加 `custom:` 前缀，绝不覆盖标准 code。
export function addCustomField({ code, name, unit = '', ref = '' }) {
  if (!code || !name) return false
  const key = code.startsWith('custom:') ? code : `custom:${code}`
  setState((s) => ({
    ...s,
    customFields: {
      ...s.customFields,
      [key]: { code: key, name, unit, ref, addedAt: new Date().toISOString() },
    },
  }))
  return key
}

export function removeCustomField(code) {
  const key = code.startsWith('custom:') ? code : `custom:${code}`
  setState((s) => {
    const { [key]: _, ...rest } = s.customFields
    return { ...s, customFields: rest }
  })
}

export function getCustomFields() {
  return { ...(getState().customFields || {}) }
}

// ---- 记录操作 ----

export function addRecord(record) {
  const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  let ok = false
  try {
    setState((s) => {
      const rec = {
        id,
        created_at: new Date().toISOString(),
        ...record,
        streamIngestedAt: new Date().toISOString(),
      }
      // 白血病融合基因检验报告 → 分子流指标点（自动，来源可溯，页面可删）
      const points = pointsFromRecord(rec)
      return {
        ...s,
        records: [...s.records, rec],
        diseaseMetrics: upsertPoints(s.diseaseMetrics || [], points),
      }
    })
  } catch (e) {
    // 绝不静默：状态更新中途抛错时记录并不会写入，调用方必须能感知（见 utils/recordWrite.js 头注）
    console.error('[MedData] addRecord 写入失败：', e)
    return null
  }
  ok = isWritePersisted({ id }, state && state.records)
  return ok ? id : null
}

export function updateRecord(id, patch) {
  setState((s) => {
    const records = s.records.map((r) =>
      r.id === id ? { ...r, ...patch, streamIngestedAt: new Date().toISOString() } : r
    )
    const target = records.find((r) => r.id === id)
    const points = target ? pointsFromRecord(target) : []
    return { ...s, records, diseaseMetrics: upsertPoints(s.diseaseMetrics || [], points) }
  })
}

// ---- 写入收口：单一写入口 + 用户优先 ----
// 凡「程序（重新识别 / 迁移 / 清洗 / 开发工具）写回已存在记录」都经 writeRecord，
// 字段级保留用户手动编辑，杜绝 Bug 093/089 类「异步/整体覆盖把用户改值静默回滚」。
// source 语义：
//   'manual'      用户在 UI 主动保存（ReportDetail / CompareModal）
//   'import'      导入页落库 / 覆盖已有记录（ImportFlow）
//   'rerecognize' 重新识别回写（ReRecognizeRecordModal）
//   'devbridge'   开发桥批量改写（devBridge）
//   'migrate'/'clean' 数据迁移 / 清洗整表替换（用户知情，整体覆盖，不走合并）
export function writeRecord({ id, patch, source = 'manual' }) {
  if (source === 'migrate' || source === 'clean') {
    updateRecord(id, patch)
    return { ok: isWritePersisted({ id }, state && state.records), action: 'replace', id }
  }
  const plan = planRecordWrite(state && state.records, { id })
  // 覆盖目标不存在（并发删除 / 同步回滚 / 候选 id 过期）→ 回退新增，绝不静默丢弃。
  // 2026-10-29 事故：这里原先 map 不命中就什么都不写，而调用方照常提示"保存成功"。
  if (plan.action === WRITE_APPEND) {
    const newId = addRecord(patch)
    if (!newId) return { ok: false, action: WRITE_APPEND, id: null }
    console.warn('[MedData] writeRecord 目标记录不存在，已回退为新增：', id, '→', newId)
    return { ok: true, action: WRITE_APPEND, id: newId }
  }
  try {
    setState((s) => {
      const records = s.records.map((r) =>
        r.id === plan.id ? { ...mergeRespectingEdits(r, patch), streamIngestedAt: new Date().toISOString() } : r
      )
      const target = records.find((r) => r.id === plan.id)
      const points = target ? pointsFromRecord(target) : []
      return { ...s, records, diseaseMetrics: upsertPoints(s.diseaseMetrics || [], points) }
    })
  } catch (e) {
    console.error('[MedData] writeRecord 写入失败：', e)
    return { ok: false, action: plan.action, id: plan.id }
  }
  return { ok: isWritePersisted({ id: plan.id }, state && state.records), action: plan.action, id: plan.id }
}

// 字段是否被用户手动编辑（权威，程序不得覆盖）
export function isUserEdited(point, field) {
  if (!point) return false
  if (point._editSrc && point._editSrc[field] === 'manual') return true
  if (field === 'value' && point._valueEdited) return true
  return false
}

// 顶层字段（date/report_type/notes 等）直接取 patch；data_points 做字段级合并。
function mergeRespectingEdits(existing, patch) {
  const next = { ...existing, ...patch }
  if (Array.isArray(patch.data_points)) {
    next.data_points = mergePointsRespectingEdits(existing.data_points || [], patch.data_points)
  }
  next.updated_at = new Date().toISOString()
  return next
}

// 按 standard_code（无 code 则用 _row）对齐；字段级保留用户手动编辑，新增项采用 patch。
function mergePointsRespectingEdits(existingPts, patchPts) {
  const byKey = new Map()
  for (const p of existingPts) {
    const k = p.standard_code || `__row_${p._row}`
    if (!byKey.has(k)) byKey.set(k, p)
  }
  return patchPts.map((np) => {
    const k = np.standard_code || `__row_${np._row}`
    const ep = byKey.get(k)
    if (!ep) return np
    const out = { ...np }
    for (const f of Object.keys(np)) {
      if (isUserEdited(ep, f)) out[f] = ep[f] // 保留用户手动编辑，程序不覆盖
    }
    out._editSrc = { ...(ep._editSrc || {}), ...(np._editSrc || {}) }
    out._valueEdited = out._valueEdited || ep._valueEdited
    return out
  })
}

export function deleteRecord(id) {
  const rec = state.records.find((r) => r.id === id)
  setState((s) => ({ ...s, records: s.records.filter((r) => r.id !== id) }))
  // 联动清理 IndexedDB 原图（fire-and-forget，失败不影响记录删除；老记录无 original_image_id 则跳过）。
  // 内容寻址/历史合并后同一张原图可能被多条记录共用（例如同一份化验单导了两次），
  // 共享时**不能**物理删除，否则别的记录的原图一起没了（服务端仍有，但本地要重下一次）。
  const imgId = rec && rec.original_image_id
  if (imgId) {
    const shared = (state.records || []).some((r) => r.id !== id && r.original_image_id === imgId)
    if (shared) console.info(`[MedData] 原图 ${imgId} 仍被其它记录共用，保留不删`)
    else deleteRecordImage(imgId).catch(() => {})
  }
}

// 整表替换 records（数据清洗后写回）
export function replaceRecords(records) {
  setState((s) => ({ ...s, records }))
}

// 计算一条记录的指标指纹：同一天 + 同一份报告 + 相同指标值集合 → 判定为同一张化验单。
// 只有识别/导出才可能产生值完全相同的重复，手输的不同记录不会误判。
// 查重：返回与 candidate 相同的已存在记录。判定放宽：指标指纹一致，且
// （同日）或（相邻 ±1 天且报告类型相同）→ 视为疑似重复，交由导入弹窗提示，避免重复入库。
// 三通道查重，优先级从强到弱：
//   0) 文件哈希（SHA-256）：同一文件字节完全一致 → 100% 精确命中，不受 OCR 随机性影响
//      file_hash = 原文件字节哈希（新记录才有）；image_hash = 存档图哈希（历史记录回填，见 backfillImageHash）；
//      image_hash_legacy = 旧压缩链路存档图哈希（对齐 08-27 前入库的老记录，见 legacyArchiveHash）。
//      三路任一命中即判重复——否则「老记录 vs 新导入」会因哈希口径不同而静默漏检。
//   1) 内容指纹：指标值集合完全一致（同日 / 相邻±1天同类型）
//   2) 模糊匹配：同一报告的不同文件（拍照两次 / OCR 差异）→ 指标集高度重合且共有值基本一致
const FILE_HASH_KEYS = ['file_hash', 'image_hash', 'image_hash_legacy']

export function findDuplicateRecord(candidate) {
  // 0) 文件哈希优先（精确、零误判）
  const hashes = FILE_HASH_KEYS.map((k) => candidate[k]).filter(Boolean)
  if (hashes.length) {
    const byHash = state.records.find((r) =>
      FILE_HASH_KEYS.some((k) => r[k] && hashes.includes(r[k]))
    )
    if (byHash) return byHash
  }
  const fp = fingerprint(candidate)
  if (!fp) return null
  // 1) 内容指纹全等 → 直接判重复，不再约束日期。
  //    所有指标值完全一致 = 同一份报告，这本身就是极强信号；若仍要求日期相近，
  //    「日期被修正过」的重复（旧记录 fallback 到导入当天、修正后为真值）将永远查不出来。
  const exact = state.records.find((r) => fingerprint(r) === fp)
  if (exact) return exact
  // 2) 模糊匹配（同一张图 OCR 两次结果略有差异：个别项缺失/脏值/值微差）
  //    同类型 + 指标集高度重合 + 共有值基本一致 → 视为疑似重复。
  //    日期窗口卡在 ±3 天：值完全一致的重复已由上面的「内容指纹全等」通道覆盖、
  //    且不拘日期；模糊通道只需 catch「同一张图被重新导入/二次 OCR」，其与原报告日期
  //    必然极近（同日或 ±几天）。放宽到 ±30 天会把「隔多天/数周的同类型复查」误报为
  //    重复（见 2026-08-30 用户 8-21 单 vs 8-09 单误报）。故收紧到 ±3 天，并要求
  //    共有值一致比例 ≥ 0.9（仅容忍个别 OCR 差异项），以区分「真实不同次采集」。
  const fuzzy = state.records.find((r) => isFuzzyDup(candidate, r, { maxDateGap: 3, minValueAgreement: 0.9 }))
  return fuzzy || null
}

export function updatePatientMeta(meta) {
  setState((s) => ({ ...s, patient_meta: { ...s.patient_meta, ...meta } }))
}

// 发烧阈值微调：low/high 任一可单独更新；非有限数（NaN/越界）忽略该项，保证持久化值永远合法
export function updateFeverThresholds(patch = {}) {
  setState((s) => {
    const next = { ...s.feverThresholds }
    if (Number.isFinite(patch.low) && patch.low > 0 && patch.low < 45) next.low = patch.low
    if (Number.isFinite(patch.high) && patch.high > 0 && patch.high < 45) next.high = patch.high
    return { ...s, feverThresholds: next }
  })
}

// 体温图用药开关：切换某药是否画进首页体温叠加图（不影响其在日程页的完整记录）
export function toggleTempDrug(key) {
  const k = String(key || '').trim()
  if (!k) return
  setState((s) => {
    const set = new Set(s.tempIrrelevantDrugs || [])
    if (set.has(k)) set.delete(k)
    else set.add(k)
    return { ...s, tempIrrelevantDrugs: [...set] }
  })
}

// ---- 事件标记操作 ----

export function addEvent(ev) {
  setState((s) => {
    const events = [
      ...s.events,
      { id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind: 'marker', ...ev },
    ].sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : 1))
    // 新增「从未记录过」的药品 → 默认不画进体温叠加图（体温图开关默认不勾选）；
    // 已是日程页存在的药则沿用其当前开关状态，不被重置。
    let tempIrrelevantDrugs = s.tempIrrelevantDrugs
    if (ev && ev.category === 'medication' && ev.drug) {
      const k = normDrug(ev.drug)
      const known = s.events.some((e) => e.category === 'medication' && normDrug(e.drug) === k)
      if (k && !known && !(tempIrrelevantDrugs || []).includes(k)) {
        tempIrrelevantDrugs = [...(tempIrrelevantDrugs || []), k]
      }
    }
    return { ...s, events, tempIrrelevantDrugs }
  })
}

export function updateEvent(id, patch) {
  setState((s) => ({ ...s, events: s.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
}

export function deleteEvent(id) {
  setState((s) => ({ ...s, events: s.events.filter((e) => e.id !== id) }))
}

// ---- 疗程 / 药品价格 / 住院段 ----
// 三份都是「区间实体」而非时间点事件，故独立于 events 存放：
// 体温图 / 趋势图等下游按 category 过滤 events，塞进去会污染它们。

const uid = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
const byStart = (a, b) => ((a.start || '') < (b.start || '') ? -1 : (a.start || '') > (b.start || '') ? 1 : 0)

export function addCourse(course) {
  setState((s) => ({ ...s, courses: [...s.courses, { id: uid('c'), note: '', ...course }].sort(byStart) }))
}

export function updateCourse(id, patch) {
  setState((s) => ({ ...s, courses: s.courses.map((c) => (c.id === id ? { ...c, ...patch } : c)).sort(byStart) }))
}

export function deleteCourse(id) {
  setState((s) => ({ ...s, courses: s.courses.filter((c) => c.id !== id) }))
}

// 首次进入（已有用药记录但还没有疗程）时自动建一个「诱导」疗程，起始日取最早一条用药记录。
// 幂等：已有任何疗程则不动。零疗程时费用页也允许手动新建，这里只是省一次录入。
export function ensureDefaultCourse() {
  if (state.courses && state.courses.length) return null
  const meds = (state.events || []).filter((e) => e.category === 'medication' && isDateStr(e.date))
  if (!meds.length) return null
  const start = meds.map((e) => e.date).sort()[0]
  const course = { name: '诱导', start, note: '' }
  addCourse(course)
  return course
}

export function addDrugPrice(row) {
  setState((s) => ({ ...s, drugPrices: [...s.drugPrices, { id: uid('p'), ...row }] }))
}

export function updateDrugPrice(id, patch) {
  setState((s) => ({ ...s, drugPrices: s.drugPrices.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
}

export function deleteDrugPrice(id) {
  setState((s) => ({ ...s, drugPrices: s.drugPrices.filter((p) => p.id !== id) }))
}

export function addStay(stay) {
  setState((s) => ({ ...s, stays: [...s.stays, { id: uid('s'), note: '', ...stay }].sort(byStart) }))
}

export function updateStay(id, patch) {
  setState((s) => ({ ...s, stays: s.stays.map((x) => (x.id === id ? { ...x, ...patch } : x)).sort(byStart) }))
}

export function deleteStay(id) {
  setState((s) => ({
    ...s,
    stays: s.stays.filter((x) => x.id !== id),
    // 发票不删，只解绑：票是凭证，住院段删了它还得留着对账 / 重新归属
    invoices: (s.invoices || []).map((v) =>
      v.stay_id === id ? { ...v, stay_id: null, stay_link: 'none', match_note: '原住院段已删除', updated_at: new Date().toISOString() } : v
    ),
  }))
}

// ---- 发票 / 医保结算单（凭证账，与 stays 的实掏账并行） ----
// 两条硬规则：
//   ① 发票原件 Blob 存 IndexedDB（f_ 前缀），删除发票必须联动删 Blob，否则孤儿文件永占配额且每次都进备份；
//   ② 修改一律写 updated_at（跨机同步按 LWW 取较新），与其它实体不同——发票允许人工改金额，必须有时间戳。
export function addInvoice(inv) {
  const id = inv.id || uid('inv')
  const row = {
    doc_kind: 'invoice',
    category: 'inpatient',
    stay_id: null,
    stay_link: 'none',
    match_note: '',
    reconcile_note: '',
    path_source: 'manual',
    created_at: new Date().toISOString(),
    ...inv,
    id,
    updated_at: new Date().toISOString(),
  }
  setState((s) => ({ ...s, invoices: [...(s.invoices || []), row] }))
  return id
}

export function updateInvoice(id, patch) {
  setState((s) => ({
    ...s,
    invoices: (s.invoices || []).map((v) => (v.id === id ? { ...v, ...patch, updated_at: new Date().toISOString() } : v)),
  }))
}

export function deleteInvoice(id) {
  const target = (state.invoices || []).find((v) => v.id === id)
  // 原件联动清理：多页住院发票的**每一页**都要删（票据页 + 全部明细页），
  // 否则删掉一张票会留下 N 份孤儿 Blob，永占配额且每次备份都带上。
  // 但同一份字节可能被别的记录共用（内容寻址去重）→ 逐页判引用，仍被引用就不删。
  for (const page of invoicePageFiles(target)) {
    const fid = page.file && page.file.id
    if (!fid) continue
    if (fileIdStillUsed(fid, id)) continue
    deleteDocFile(fid)
  }
  setState((s) => ({ ...s, invoices: (s.invoices || []).filter((v) => v.id !== id) }))
}

// 软查重：返回 { doc, reason } | null。只用于提示"疑似同一份"，**不拦保存**
// （硬拦仅限 findDuplicateDoc 的两路：字节哈希 / 同日同类型同文件名）。
export function findSimilarDoc(candidate) {
  return findSimilarDocIn(state.docs || [], candidate)
}

// 查重（票号）：返回已存在的发票或 null。判定口径全在 utils/invoice.js（纯函数，可 node 直测）。
export function findDuplicateInvoice(candidate) {
  return findDupInvoice(candidate, state.invoices || [])
}

// 手工改归属：一旦 manual，自动匹配永不再覆盖（用户明确改过的就是权威）。
export function linkInvoiceToStay(id, stayId) {
  updateInvoice(id, { stay_id: stayId || null, stay_link: stayId ? 'manual' : 'none', match_note: '' })
}

// ---- 病情三维度指标点 ----
// 指标由报告自动生成（见 diseaseIngest.js + addDoc/addRecord），页面只允许删除误识别项；
// 不提供手工新增，因此这里只有删除操作。
export function deleteDiseaseMetric(id) {
  setState((s) => ({ ...s, diseaseMetrics: (s.diseaseMetrics || []).filter((p) => p.id !== id) }))
}

// ---- 报告原件归档（影像/心电等非表格报告） ----
// docs 是轻量索引（localStorage），原件 Blob 与提取全文在 IndexedDB（docFileStore）。

export function addDoc(doc) {
  const { raw_text, ...rest } = doc
  const id = rest.id || `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  delete rest.id
  if (raw_text) {
    // 全文单独入 IndexedDB；即使写入失败也不影响轻量索引入库
    saveDocText(id, raw_text)
    rest.has_text = true
  }
  const docRow = {
    id,
    created_at: new Date().toISOString(),
    ...rest,
    streamIngestedAt: new Date().toISOString(),
  }
  // 骨髓相关检查报告（骨穿/流式/融合基因）→ 对应流指标点（自动）
  const points = pointsFromDoc(docRow)
  setState((s) => ({
    ...s,
    docs: [...s.docs, docRow],
    diseaseMetrics: upsertPoints(s.diseaseMetrics || [], points),
  }))
  return id
}

export function updateDoc(id, patch) {
  setState((s) => {
    const docs = s.docs.map((d) =>
      d.id === id ? { ...d, ...patch, streamIngestedAt: new Date().toISOString() } : d
    )
    const target = docs.find((d) => d.id === id)
    const points = target ? pointsFromDoc(target) : []
    return { ...s, docs, diseaseMetrics: upsertPoints(s.diseaseMetrics || [], points) }
  })
}

// 原件是否仍被其它实体引用（内容寻址去重后，同一 file.id 可能被多条记录共用）
// 去重口径见 utils/docFileStore.js saveDocFile：同一份字节只落一份，
// 因此删除单条记录时**不能**无脑删原件，否则会把别的记录的原始报告一起删掉。
function fileIdStillUsed(fileId, exceptDocId) {
  if (!fileId) return false
  if ((state.docs || []).some((d) => d.id !== exceptDocId && d.file && d.file.id === fileId)) return true
  return (state.invoices || []).some(
    (v) => v.id !== exceptDocId && invoicePageFiles(v).some((p) => p.file && p.file.id === fileId)
  )
}

// 删除归档：同时清理 IndexedDB 原件与提取全文
export function deleteDoc(id) {
  const target = state.docs.find((d) => d.id === id)
  if (target) {
    const fid = target.file && target.file.id
    if (fid && !fileIdStillUsed(fid, id)) deleteDocFile(fid)
    else if (fid) console.info(`[MedData] 原件 ${fid} 仍被其它记录共用，保留不删`)
    deleteDocText(id)
  }
  setState((s) => ({ ...s, docs: s.docs.filter((d) => d.id !== id) }))
}

// 文档大类惰性推导：病历文书（出院记录 / 诊断证明）归 'case'，其余归 'exam'。
// 老数据无 category 字段，按 kind 退化识别，无需破坏性迁移；新数据写入时由导入流直接赋值。
export function docCategory(d) {
  return docCategoryOf(d)
}

// 归档查重：两路通道（实现与 rationale 见 utils/docDup.js，纯函数、可单测）——
//   通道 0：原件字节哈希 doc.file.sha256 相等 → 同一份文件，与日期/类型/文件名读数抖动无关；
//   通道 1：category + date + doc_type + 文件名 全等（历史无哈希归档 / 无原件手动录入的兜底）。
// candidate 可带 file_sha256（导入时算好的原件 SHA-256）。
export function findDuplicateDoc(candidate) {
  return findDocDuplicateIn(state.docs, candidate)
}

// 跨实体同源查重（docs ↔ records，原字节域）：软闸专用，只提示不阻断。
// 为什么必须单列一路（2026-10-28 现场）：findDuplicateDoc 只比 docs、findDuplicateRecord 只比 records，
// **跨实体从来没人比** → 「2026-09-03 骨髓形态学」「2026-08-20 流式免疫分型」同一份原件被两条通道
// 各收录一次而无人报警。判据与域隔离见 utils/dupScan.js（压缩域 image_hash 不参与跨实体比较）。
// opts: { wantKind:'doc'|'record', skipKind }
export function findCrossEntitySource(candidate, opts = {}) {
  return findCrossEntityHit({ docs: state.docs || [], records: state.records || [] }, candidate, opts)
}

// 一次性迁移：把旧版 localStorage docs 里的 raw_text（提取全文）搬到 IndexedDB，
// 之后 localStorage 只留轻量索引。这样报告积累到几十上百 MB 时，
// 压力也落在 IndexedDB（配额数 GB），而不是 5MB 的 localStorage。
async function migrateStoredDocTexts() {
  const toMove = state.docs.filter((d) => d.raw_text)
  if (!toMove.length) return
  for (const d of toMove) {
    try {
      await saveDocText(d.id, d.raw_text)
    } catch (e) {
      console.warn('迁移提取全文失败（可忽略，索引仍可用）：', d.id, e)
    }
  }
  setState((s) => ({
    ...s,
    docs: s.docs.map((d) => (d.raw_text ? { ...d, raw_text: undefined, has_text: true } : d)),
  }))
}

// 一次性清理历史重复归档（保留最早一份）：早期查重字段名 bug 曾使同一报告可被反复导入，
// 这类数据本不应存在，启动时自动清理（幂等，无重复时零开销），联动删除 IndexedDB 原件与全文。
// 注：不做"一键去重"按钮——重复导入现已被禁止，不会再产生新的重复数据。
async function dedupeStoredDocs() {
  const seen = new Set()
  const dupIds = []
  for (const d of state.docs) {
    const name = d.file && d.file.name
    const key = name ? `${d.date}|${d.doc_type}|${name}` : ''
    if (!key) continue
    if (seen.has(key)) dupIds.push(d.id)
    else seen.add(key)
  }
  if (!dupIds.length) return
  for (const id of dupIds) {
    const t = state.docs.find((x) => x.id === id)
    if (t) {
      const fid = t.file && t.file.id
      // 与 deleteDoc 同口径：原件被保留记录共用时不物理删除（内容寻址去重后可能共享）
      if (fid && !fileIdStillUsed(fid, id)) deleteDocFile(fid)
      deleteDocText(id)
    }
  }
  setState((s) => ({ ...s, docs: s.docs.filter((d) => !dupIds.includes(d.id)) }))
  console.warn(`[MedData] 已自动清理 ${dupIds.length} 份历史重复归档`)
}

// ---- 一次性迁移：旧版待办任务（kind:'task'）→ 用药事件（category:'medication'） ----
// 提醒功能已整体移除（2026-08-21）：遗留任务转成用药记录，保留在时间线上可查可删；
// 幂等——迁移后 kind 不再为 'task'，不会重复执行。零额外状态，老数据无缝升级。
const MEDICATION_COLOR = '#3b82f6' // 与 dictionary.js EVENT_CATEGORIES 中「用药」一致

function localDateOf(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10) || ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function migrateStoredTasks() {
  const tasks = state.events.filter((e) => e.kind === 'task')
  if (!tasks.length) return
  const converted = tasks.map((t) => {
    const { name, due_at, completed, ...rest } = t // 丢弃提醒专属字段
    return {
      ...rest,
      kind: 'marker',
      category: t.category || 'medication',
      color: t.color || MEDICATION_COLOR,
      text: name || t.text || '用药',
      date: t.date || localDateOf(due_at) || '',
    }
  })
  const events = [...state.events.filter((e) => e.kind !== 'task'), ...converted].sort((a, b) =>
    (a.date || '') < (b.date || '') ? -1 : 1
  )
  setState((s) => ({ ...s, events }))
  console.warn(`[MedData] 已将 ${tasks.length} 条旧待办提醒迁移为用药事件`)
}

// 已有用药记录但还没有疗程 → 自动建第一个疗程「诱导」（起点取最早用药日，可改）。
// 放在迁移之后、保证读到的是迁移后的 events；无用药记录时不建（等用户录入后再建）。

// ---- 一次性迁移：为历史记录补「存档图哈希」image_hash ----
// 背景：file_hash（原文件 SHA-256）是后加的字段，历史记录为空且原 File 对象早已不可得，
// 导致同一文件重复导入时哈希通道静默失效，只能退到内容指纹/模糊匹配（阈值一过就漏检）。
// 每条记录都存了 900px 存档图 dataURL（record.image），同一文件经同一压缩链路字节稳定，
// 用它反推即可让老记录重新获得「精确查重」能力。
// 幂等：补完后 image_hash 非空，下次启动跳过；无image 的记录保持为空，继续走旧通道。
async function backfillImageHash() {
  const todo = state.records.filter((r) => !r.image_hash && r.image)
  if (!todo.length) return
  const hashed = new Map()
  for (const r of todo) {
    try {
      const h = await dataUrlFingerprint(r.image)
      if (h) hashed.set(r.id, h)
    } catch {
      // 单条失败不影响其余记录
    }
  }
  if (!hashed.size) return
  setState((s) => ({
    ...s,
    records: s.records.map((r) => (hashed.has(r.id) ? { ...r, image_hash: hashed.get(r.id) } : r)),
  }))
  console.info(`[MedData] 已为 ${hashed.size} 条历史记录补算存档图哈希（精确查重生效）`)
}

// ---- 一次性迁移：为历史归档补「原件字节哈希」doc.file.sha256 ----
// 背景：归档查重的通道 0（原件 SHA-256）是 2026-10-25 新增，此前 doc.file 只有 id/name/size/mime，
// 于是「同一份原件二次导入」只能靠 date+doc_type+文件名三项，任一项被 OCR 读歪就静默放行重复归档
// （实测漏判：骨穿报告「采取日期 2026.10.10」被读成 2006.10.12，与归档的 2026-10-10 不等）。
// 原件 Blob 仍在 IndexedDB（f_ 前缀）/服务端 blobs，按 file.id 取回即可补算，老归档立刻恢复字节级查重。
// 幂等：补完 sha256 非空 → 下次跳过；取不到原件（已删 / 别的库）标 sha256_missing，避免每次启动重试。
async function backfillDocFileHash() {
  const todo = state.docs.filter(
    (d) => d.file && d.file.id && !d.file.sha256 && !d.file.sha256_missing
  )
  if (!todo.length) return
  const patch = new Map() // doc.id -> { sha256 } | { sha256_missing: true }
  const failed = [] // 读原件抛异常（另一台机器导入 / 服务端不可达）：不写标记，下次启动重试
  for (const d of todo) {
    try {
      const blob = await getDocFile(d.file.id)
      if (!blob) {
        patch.set(d.id, { sha256_missing: true })
        continue
      }
      const h = await fileFingerprint(blob)
      patch.set(d.id, h ? { sha256: h } : { sha256_missing: true })
    } catch (e) {
      // 单条失败（如另一台机器导入、服务端不可达）不影响其余；但**必须留痕**：
      // 2026-10-25 实测 29 条归档 sha256 覆盖为 0、连 sha256_missing 都没有 ——
      // 静默 catch 让"哈希根本没补上"这件事长期隐身，而它正是「任务↔归档按字节对齐」的前提。
      failed.push(`${d.id}(${(e && e.message) || e})`)
    }
  }
  if (!patch.size) {
    if (failed.length) console.warn(`[MedData] 原件哈希补算失败 ${failed.length} 份（下次启动重试）：${failed.slice(0, 3).join(' / ')}`)
    return
  }
  setState((s) => ({
    ...s,
    docs: s.docs.map((d) => (patch.has(d.id) ? { ...d, file: { ...d.file, ...patch.get(d.id) } } : d)),
  }))
  const n = [...patch.values()].filter((v) => v.sha256).length
  const miss = [...patch.values()].filter((v) => v.sha256_missing).length
  if (n) console.info(`[MedData] 已为 ${n} 份历史归档补算原件哈希（字节级查重生效）`)
  if (miss)
    console.warn(
      `[MedData] ${miss} 份历史归档取不到原件、已标 sha256_missing：这些记录无法按字节查重，也无法和 AI 任务按哈希对齐（可先补传原件）`
    )
  if (failed.length) console.warn(`[MedData] 原件哈希补算失败 ${failed.length} 份（下次启动重试）：${failed.slice(0, 3).join(' / ')}`)
}

// 一次性迁移：把老记录内嵌的 900px 存档图 dataURL 从 localStorage 搬到 IndexedDB，
// 避免每条记录都带一张图把 5MB 配额撑爆，导致新记录静默写失败（刷新即丢失）。
// 新记录已只持 original_image_id（IndexedDB 引用）、不内嵌 image；此处补齐老记录。
// 幂等：搬完后 record.image 被剥离，下次启动不再处理；搬失败的记录保留 image，不丢数据。
async function migrateStoredRecordImages() {
  const todo = state.records.filter(
    (r) => r.image && typeof r.image === 'string' && r.image.startsWith('data:')
  )
  if (!todo.length) return
  const byId = new Map()
  for (const r of todo) {
    try {
      const blob = dataUrlToBlob(r.image)
      const id = await saveRecordImage(blob)
      byId.set(r.id, r.original_image_id || id)
    } catch (e) {
      console.warn('[MedData] 迁移老记录原图失败（保留 image，可忽略）：', r.id, e)
    }
  }
  if (!byId.size) return
  setState((s) => ({
    ...s,
    records: s.records.map((r) =>
      byId.has(r.id) ? { ...r, original_image_id: byId.get(r.id), image: undefined } : r
    ),
  }))
  console.warn(`[MedData] 已将 ${byId.size} 条老记录的存档图搬入 IndexedDB（释放 localStorage）`)
}

// 一次性迁移：老「mg/片」价格记录（含旧标量 spec、无 content）→ 结构化包装规格。
// 一律按 mg/片 处理（口服药零回退）；贝林妥等输注药即便被迁成 mg 也不比现状更差，
// 其正确规格（µg/只·mL）预期由用户在药品管理重新录入。幂等：已含 content 的不处理。
function migrateDrugPricesSpec() {
  const todo = state.drugPrices.filter((p) => p && p.spec != null && p.content == null)
  if (!todo.length) return
  setState((s) => ({
    ...s,
    drugPrices: s.drugPrices.map((p) =>
      p && p.spec != null && p.content == null
        ? { ...p, content: Number(p.spec), contentUnit: 'mg', pkgUnit: '片', volume: null }
        : p
    ),
  }))
  console.info(`[MedData] 已将 ${todo.length} 条旧「mg/片」药价迁移为结构化规格`)
}

// 旧数据一次性回填：把此前已归档的骨髓/流式/基因报告与融合基因检验记录抽成指标点。
// 用每条实体自己的 streamIngestedAt 做幂等标记（不用全局标记：同步拉取不会把它抹掉，
// 也不会在用户删点后每次启动复活）。新报告在 addDoc/addRecord 时已即时抽取。
export function backfillDiseaseMetrics() {
  const now = new Date().toISOString()
  let added = 0
  setState((s) => {
    const points = []
    const docs = (s.docs || []).map((d) => {
      if (d.streamIngestedAt) return d
      points.push(...pointsFromDoc(d))
      return { ...d, streamIngestedAt: now }
    })
    const records = (s.records || []).map((r) => {
      if (r.streamIngestedAt) return r
      points.push(...pointsFromRecord(r))
      return { ...r, streamIngestedAt: now }
    })
    added = points.length
    return { ...s, docs, records, diseaseMetrics: upsertPoints(s.diseaseMetrics || [], points) }
  })
  if (added) console.info(`[MedData] 病情指标回填：从历史报告生成 ${added} 个点`)
  return added
}

// 汇总：启动水合时一次性执行上述迁移（均为函数声明，调用前已就绪）。
// 历史迁移必须放在状态从 IndexedDB/localStorage 载入之后，否则会作用于空 state。
async function runMigrations() {
  await migrateStoredDocTexts()
  await dedupeStoredDocs()
  await migrateStoredTasks()
  ensureDefaultCourse()
  await backfillImageHash()
  await backfillDocFileHash()
  await migrateStoredRecordImages()
  await migrateDrugPricesSpec()
  backfillDiseaseMetrics()
}
