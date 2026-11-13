// ===================== MedData → MedBrief 原件适配层 =====================
// Vite 构建时把 meddata/src 里 ../utils/docFileStore.js 的引用重定向到本文件。
// 原件统一存 MedBrief 的 SQLite blobs（POST /api/intake/blob），按 sha256 复用，绝不重复保存。
// 指纹用浏览器原生 Web Crypto 计算（不引 node: 内置模块，浏览器打包不可用）。
async function sha256Hex(buf) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function toArrayBuffer(blob) {
  if (blob instanceof ArrayBuffer) return blob
  if (ArrayBuffer.isView(blob)) return blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
  if (typeof Blob !== 'undefined' && blob instanceof Blob) return blob.arrayBuffer()
  return Promise.resolve(new ArrayBuffer(0))
}

function toDataUrl(blob, mime = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'))
    try { reader.readAsDataURL(new Blob([blob], { type: mime })) }
    catch (e) { reject(e) }
  })
}

// 本次导入会话积攒的原件引用，由 store.addRecord/addDoc 一次性取走并写进 sourceBlobs。
let pendingRefs = []
export function takeBlobRefs() {
  const refs = pendingRefs.slice()
  pendingRefs = []
  return refs
}

const textCache = new Map()

/**
 * 存一份原件。先算 sha256 并查已有 blobs：命中就直接复用 id（同一张图只留一份字节）。
 * 返回 MedData 期望的 id 字符串。
 */
async function putBlob(input, { kind = 'original', role = 'original' } = {}) {
  const buf = await toArrayBuffer(input)
  if (!buf.byteLength) return null
  const hex = await sha256Hex(buf)
  try {
    const res = await fetch('/api/intake/blobs')
    const j = await res.json()
    const hit = (j.blobs || []).find((b) => b.sha256 === hex)
    if (hit) {
      pendingRefs.push({ blobId: hit.id, role, sha256: hex, reused: true })
      return hit.id
    }
  } catch (e) {
    console.warn('[medbrief/meddata] 原件查重失败，将按新文件保存：', e)
  }
  const mime = (input && input.type) || 'application/octet-stream'
  const dataUrl = await toDataUrl(input, mime)
  const res = await fetch('/api/intake/blob', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, kind, originPath: (input && input.name) || '' }),
  })
  const j = await res.json().catch(() => ({}))
  if (!j.ok || !j.id) throw new Error(j.error || `原件保存失败 HTTP ${res.status}`)
  pendingRefs.push({ blobId: j.id, role, sha256: hex, reused: false })
  return j.id
}

async function readBlob(id) {
  if (!id) return null
  const res = await fetch(`/api/intake/blob/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  return res.blob()
}

export async function saveDocFile(blob) { return putBlob(blob, { kind: 'original', role: 'original' }) }
export async function saveRecordImage(blob) { return putBlob(blob, { kind: 'original', role: 'original' }) }
export async function putBlobLocal(id, blob) { return putBlob(blob) }

export async function getDocFile(id) { return readBlob(id) }
export async function getRecordImage(id) { return readBlob(id) }

export async function saveDocText(id, text) { textCache.set(String(id), String(text ?? '')); return id }
export async function getDocText(id) { return textCache.get(String(id)) || '' }
export async function deleteDocText(id) { textCache.delete(String(id)); return true }

export function blobToUrl(blob) {
  if (!blob) return ''
  try { return URL.createObjectURL(blob) } catch { return '' }
}
export function dataUrlToBlob(dataUrl = '') {
  const m = String(dataUrl).match(/^data:([^;]+);base64,([\s\S]*)$/)
  if (!m) return new Blob()
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: m[1] })
}

// 以下导出供 MedData 的数据导入/导出模块引用；本工作台不走这些路径，保持空实现。
export const deleteDocFile = async () => true
export const deleteRecordImage = async () => true
export const getAllDocFiles = async () => []
export const getAllDocTexts = async () => []
export const getAllRecordImages = async () => []
export const replaceAllDocFiles = async () => true
export const replaceAllDocTexts = async () => true
export const replaceAllRecordImages = async () => true
