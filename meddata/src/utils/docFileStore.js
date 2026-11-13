// ===================== 报告原件存储（IndexedDB） =====================
// 原件（PDF/图片）是二进制大文件、提取全文也可能达数十 KB，
// 都不适合塞进 localStorage（5MB 限制）。
// 分层：
//   - store 'files'：报告原件 Blob（按 file.id）
//   - store 'texts'：提取全文（按 doc.id）
// 结构化状态现也统一存 IndexedDB（store.js 的 stateDb），本文件只负责大二进制 Blob。
// 本地浏览器 IndexedDB 是权威副本；开启数据源同步时，原件 Blob / 提取全文 / 记录原图都会由
// apiStore.fillMissingBlobs 增量补传到服务端（/blob 接口，全文 kind=text），用于双机共享与备份。

import { fileFingerprint } from './fileHash.js'

const DB_NAME = 'meddata_doc_files'
const DB_VERSION = 4
const STORE = 'files'
const TEXT_STORE = 'texts'
// 化验记录原图（区别于 docs 原件，独立 store 便于备份/清理隔离，ID 用 r_ 前缀）
const REC_IMG_STORE = 'record_images'
// 内容寻址索引：sha256 → 原件 id。同一份字节只存一份（用户口径「尽量保存，只要不重复保存」）。
// 为什么必须做：历史库里 347 份 blob 有 227 份内容完全相同（可省 64MB），且「从 AI 任务恢复草稿」
// 每次都会重建一份 File 再落盘 —— 没有这层索引，恢复 = 复制。
const SHA_STORE = 'blob_sha'

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (!req.result.objectStoreNames.contains(TEXT_STORE)) {
        req.result.createObjectStore(TEXT_STORE, { keyPath: 'id' })
      }
      if (!req.result.objectStoreNames.contains(REC_IMG_STORE)) {
        req.result.createObjectStore(REC_IMG_STORE, { keyPath: 'id' })
      }
      if (!req.result.objectStoreNames.contains(SHA_STORE)) {
        req.result.createObjectStore(SHA_STORE, { keyPath: 'sha' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

// ---- 数据源联动（唯一数据源 = 服务端 SQLite，IndexedDB 降级为本地缓存） ----
// 写入：本地落一份（离线可用）后发事件，由 apiStore 上传服务端
// 读取：本地命中直接返回；未命中才向服务端要，取回后写回本地缓存
function fire(name, detail) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  }
}

// 按 id 写入本地缓存（不生成新 id，用于回填服务端取回的原件）
export async function putBlobLocal(id, blob) {
  if (!id) return
  const db = await openDb()
  const store = String(id).startsWith('r_') ? REC_IMG_STORE : STORE
  await new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put({ id, blob })
    tx.oncomplete = resolve
    tx.onerror = resolve
  })
  // 顺手补内容索引（失败不影响可用性：只是下次少一次去重机会）
  if (store === STORE) {
    fileFingerprint(blob)
      .then((sha) => (sha ? putShaIndex(sha, id) : null))
      .catch(() => {})
  }
}

// 本地没有 → 向服务端要（动态 import 避免 docFileStore → apiStore → store → docFileStore 循环）
async function fetchRemote(id, kind) {
  try {
    const mod = await import('./apiStore.js')
    return await mod.getBlob(id, kind)
  } catch {
    return null
  }
}

// ---- 内容寻址（sha256 → 原件 id）----
// 语义：同一份字节只落一份。命中索引时直接复用旧 id，**不复制**。
// 调用方拿到的 id 可能被多条实体共用（例如同一份原件归档了一次、又从 AI 任务恢复过一次），
// 因此删除原件时有共享保护（见 store.js deleteDoc：同一 file.id 仍有其它引用就跳过物理删除）。
async function putShaIndex(sha, id) {
  if (!sha || !id) return
  const db = await openDb()
  await new Promise((resolve) => {
    const tx = db.transaction(SHA_STORE, 'readwrite')
    tx.objectStore(SHA_STORE).put({ sha, id })
    tx.oncomplete = resolve
    tx.onerror = resolve
  })
}

async function findBlobIdBySha(sha) {
  if (!sha) return ''
  const db = await openDb()
  const hit = await new Promise((resolve) => {
    const tx = db.transaction(SHA_STORE, 'readonly')
    const req = tx.objectStore(SHA_STORE).get(sha)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => resolve(null)
  })
  if (!hit || !hit.id) return ''
  // 索引可能指向已被物理删除的原件（历史数据/外部清理）→ 确认本体还在，否则视为未命中
  const exists = await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(hit.id)
    req.onsuccess = () => resolve(!!req.result)
    req.onerror = () => resolve(false)
  })
  return exists ? hit.id : ''
}

// 保存原件 Blob，返回文件 id。内容相同 → 复用已有 id（不重复占盘）。
export async function saveDocFile(blob) {
  const sha = await fileFingerprint(blob).catch(() => '')
  const dupId = await findBlobIdBySha(sha)
  if (dupId) return dupId
  const db = await openDb()
  const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ id, blob })
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  await putShaIndex(sha, id)
  fire('meddata:blob-saved', { id, blob })
  return id
}

// 取原件 Blob，不存在返回 null
export async function getDocFile(id) {
  if (!id) return null
  const db = await openDb()
  const local = await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result ? req.result.blob : null)
    req.onerror = () => resolve(null)
  })
  if (local) return local
  // 本地缓存未命中（另一台电脑导入的原件）：向服务端要，取回后写回缓存
  const remote = await fetchRemote(id)
  if (remote) await putBlobLocal(id, remote)
  return remote
}

// 删除原件
export async function deleteDocFile(id) {
  if (!id) return
  const db = await openDb()
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = resolve
    tx.onerror = resolve
  })
  fire('meddata:blob-deleted', { id })
}

// ---- 提取全文（大文本，独立 store，按 doc.id 存） ----

export async function saveDocText(id, text) {
  if (!id || !text) return
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE, 'readwrite')
    tx.objectStore(TEXT_STORE).put({ id, text })
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  fire('meddata:blob-saved', { id, text, kind: 'text' })
}

export async function getDocText(id) {
  if (!id) return ''
  const db = await openDb()
  const local = await new Promise((resolve) => {
    const tx = db.transaction(TEXT_STORE, 'readonly')
    const req = tx.objectStore(TEXT_STORE).get(id)
    req.onsuccess = () => resolve(req.result ? req.result.text : '')
    req.onerror = () => resolve('')
  })
  if (local) return local
  const remote = await fetchRemote(id, 'text')
  if (!remote) return ''
  const text = await remote.text()
  if (text) {
    await new Promise((resolve) => {
      const tx = db.transaction(TEXT_STORE, 'readwrite')
      tx.objectStore(TEXT_STORE).put({ id, text })
      tx.oncomplete = resolve
      tx.onerror = resolve
    })
  }
  return text
}

export async function deleteDocText(id) {
  if (!id) return
  const db = await openDb()
  await new Promise((resolve) => {
    const tx = db.transaction(TEXT_STORE, 'readwrite')
    tx.objectStore(TEXT_STORE).delete(id)
    tx.oncomplete = resolve
    tx.onerror = resolve
  })
  fire('meddata:blob-deleted', { id })
}

// ---- 整库备份 / 恢复辅助（供 backup.js 调用，避免把 store 名泄漏到上层） ----

// 取出全部原件记录 [{ id, blob }]
export async function getAllDocFiles() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

// 取出全部提取全文 [{ id, text }]
export async function getAllDocTexts() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE, 'readonly')
    const req = tx.objectStore(TEXT_STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

// 清空并整体写入原件 store（恢复用）
export async function replaceAllDocFiles(rows) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const os = tx.objectStore(STORE)
    os.clear()
    for (const r of rows) os.put(r)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// 清空并整体写入全文 store（恢复用）
export async function replaceAllDocTexts(rows) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE, 'readwrite')
    const os = tx.objectStore(TEXT_STORE)
    os.clear()
    for (const r of rows) os.put(r)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// 生成可下载 URL（使用后需 revokeObjectURL）
export function blobToUrl(blob) {
  return URL.createObjectURL(blob)
}

// dataURL（base64）转 Blob：老记录内嵌的 900px 存档图迁移进 IndexedDB 时用到
export function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',')
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// ===================== 化验记录原图（IndexedDB） =====================
// 记录原图（用户上传的原始图片/PDF）体积大，不进 localStorage，独立 store 存储。
// record 仅持 original_image_id 引用；详情页据 id 取原图高清预览，删除记录时联动清理。

// 保存原图 Blob，返回 id（r_ 前缀，避免与 docs 原件 f_ 混淆）
export async function saveRecordImage(blob) {
  const db = await openDb()
  const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  await new Promise((resolve, reject) => {
    const tx = db.transaction(REC_IMG_STORE, 'readwrite')
    tx.objectStore(REC_IMG_STORE).put({ id, blob })
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  fire('meddata:blob-saved', { id, blob })
  return id
}

// 取原图 Blob，不存在返回 null
export async function getRecordImage(id) {
  if (!id) return null
  const db = await openDb()
  const local = await new Promise((resolve) => {
    const tx = db.transaction(REC_IMG_STORE, 'readonly')
    const req = tx.objectStore(REC_IMG_STORE).get(id)
    req.onsuccess = () => resolve(req.result ? req.result.blob : null)
    req.onerror = () => resolve(null)
  })
  if (local) return local
  const remote = await fetchRemote(id)
  if (remote) await putBlobLocal(id, remote)
  return remote
}

// 删除原图（删除记录时联动；fire-and-forget）
export async function deleteRecordImage(id) {
  if (!id) return
  const db = await openDb()
  await new Promise((resolve) => {
    const tx = db.transaction(REC_IMG_STORE, 'readwrite')
    tx.objectStore(REC_IMG_STORE).delete(id)
    tx.oncomplete = resolve
    tx.onerror = resolve
  })
  fire('meddata:blob-deleted', { id })
}

// 取出全部记录原图（备份用）
export async function getAllRecordImages() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REC_IMG_STORE, 'readonly')
    const req = tx.objectStore(REC_IMG_STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

// 清空并整体写入（恢复用）
export async function replaceAllRecordImages(rows) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REC_IMG_STORE, 'readwrite')
    const os = tx.objectStore(REC_IMG_STORE)
    os.clear()
    for (const r of rows) os.put(r)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}
