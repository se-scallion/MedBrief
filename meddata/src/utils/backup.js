// ===================== 整库备份 / 恢复 =====================
// 把 IndexedDB 结构化状态 + IndexedDB 原件/全文 打包成一个 JSON 文件下载，
// 换电脑 / 换浏览器后一键导入恢复，让数据可以随人走、随项目走。
// 备份文件完全由用户本地下载与导入（手动操作，不经任何网络自动上传）。

import { getState, replaceState } from '../data/store.js'
import {
  getAllDocFiles,
  getAllDocTexts,
  replaceAllDocFiles,
  replaceAllDocTexts,
  getAllRecordImages,
  replaceAllRecordImages,
} from './docFileStore.js'

const APP_TAG = 'meddata-ai-backup'
const BACKUP_VERSION = 1

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '')
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

function base64ToBlob(b64, type = 'application/octet-stream') {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

function errMsg(e) {
  return e && e.message ? e.message : String(e)
}

// 备份：打包全部数据（索引 + 原件 + 全文）为单个 JSON 并触发下载
export async function exportBackup() {
  const [fileRows, textRows, recImgRows] = await Promise.all([
    getAllDocFiles(),
    getAllDocTexts(),
    getAllRecordImages(),
  ])
  const files = await Promise.all(
    fileRows.map(async ({ id, blob }) => ({
      id,
      name: (blob && blob.name) || id,
      type: (blob && blob.type) || 'application/octet-stream',
      size: blob ? blob.size : 0,
      data: await blobToBase64(blob),
    }))
  )
  const recordImages = await Promise.all(
    recImgRows.map(async ({ id, blob }) => ({
      id,
      name: (blob && blob.name) || id,
      type: (blob && blob.type) || 'application/octet-stream',
      size: blob ? blob.size : 0,
      data: await blobToBase64(blob),
    }))
  )
  const texts = textRows.map(({ id, text }) => ({ id, text }))
  const backup = {
    app: APP_TAG,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    state: getState(),
    files,
    texts,
    recordImages,
  }
  const json = JSON.stringify(backup)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `meddata-backup-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return {
    records: (backup.state.records || []).length,
    events: (backup.state.events || []).length,
    docs: (backup.state.docs || []).length,
    files: files.length,
    recordImages: recordImages.length,
    size: blob.size,
  }
}

// 校验并解析备份文件（只读，不写入），返回 { backup, summary } 供确认后 apply
export async function inspectBackup(file) {
  const text = await file.text()
  let backup
  try {
    backup = JSON.parse(text)
  } catch (e) {
    throw new Error('不是有效的备份文件（JSON 解析失败）')
  }
  if (!backup || backup.app !== APP_TAG || !backup.state) {
    throw new Error('不是 MedData 整库备份文件，已中止')
  }
  return {
    backup,
    summary: {
      exported_at: backup.exported_at || '未知',
      records: (backup.state.records || []).length,
      events: (backup.state.events || []).length,
      docs: (backup.state.docs || []).length,
      files: (backup.files || []).length,
      recordImages: (backup.recordImages || []).length,
      texts: (backup.texts || []).length,
      size: text.length,
    },
  }
}

// 应用备份（覆盖式）：写回 IndexedDB 原件/全文 + 整体替换 IndexedDB 状态（replaceState 自动落盘）
export async function applyBackup(backup) {
  const state = backup.state || {}
  const docs = Array.isArray(state.docs) ? state.docs : []
  const files = Array.isArray(backup.files) ? backup.files : []
  const texts = Array.isArray(backup.texts) ? backup.texts : []
  const recordImages = Array.isArray(backup.recordImages) ? backup.recordImages : []

  const fileRows = files
    .filter((f) => f && f.id && f.data)
    .map((f) => ({ id: f.id, blob: base64ToBlob(f.data, f.type) }))
  const textRows = texts.filter((t) => t && t.id).map(({ id, text }) => ({ id, text }))
  const recImgRows = recordImages
    .filter((f) => f && f.id && f.data)
    .map((f) => ({ id: f.id, blob: base64ToBlob(f.data, f.type) }))

  // 兼容旧备份：索引里残留的 raw_text 补入 texts store，并剥离出 localStorage
  const extraTexts = []
  for (const d of docs) {
    if (d.raw_text && !textRows.some((t) => t.id === d.id)) {
      extraTexts.push({ id: d.id, text: d.raw_text })
    }
  }
  const cleanedState = {
    ...state,
    docs: docs.map((d) => (d.raw_text ? { ...d, raw_text: undefined, has_text: true } : d)),
  }

  // 旧备份无 recordImages 字段：不要清空现有原图（保留兼容，避免恢复旧备份误删新原图）
  const writes = [
    replaceAllDocFiles(fileRows),
    replaceAllDocTexts([...textRows, ...extraTexts]),
  ]
  if (Array.isArray(backup.recordImages)) writes.push(replaceAllRecordImages(recImgRows))
  await Promise.all(writes)
  replaceState(cleanedState)

  return {
    records: (cleanedState.records || []).length,
    events: (cleanedState.events || []).length,
    docs: cleanedState.docs.length,
    files: fileRows.length,
    recordImages: recImgRows.length,
    texts: textRows.length + extraTexts.length,
  }
}

export { errMsg }
