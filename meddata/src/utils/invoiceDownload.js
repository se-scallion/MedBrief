// ===================== 发票原件下载（单页 / 单份全部页 / 批量全部页） =====================
// 原件一律从 IndexedDB 取（docFileStore 的 f_ 前缀），本地未命中会自动向数据源要，故跨机也能下。
// 文件名规范见 invoice.js::invoiceFileName（日期_医院_金额_票号后6位），多页时按页加 `_明细n` 后缀。
//
// 多页住院发票（2026-10-28）：一张票 = 票据页 + 若干明细页，
//   ① 「下载本页」只下当前预览页；② 「下载全部页」按页序写盘；③ 批量导出 = 每张票的全部页。
//
// 批量下载的现实约束：
//   - 逐个 a[download] 在 Chrome 会弹「是否允许下载多个文件」，且文件名排布混乱；
//   - 所以优先用 File System Access API 选一个目录，把原件按规范名**直接写进去**（零弹窗）；
//   - 不支持的浏览器退回逐个下载，并提示可能被拦截。

import { getDocFile } from './docFileStore.js'
import { invoiceFileName, invoicePageFiles } from './invoice.js'

// 单页扩展名：先看这一页自己的文件名/MIME
export function extOfPage(page) {
  const f = (page && page.file) || {}
  const name = String(f.name || '')
  const m = name.match(/\.([a-z0-9]{2,5})$/i)
  if (m) return m[1].toLowerCase()
  if (f.type === 'application/pdf') return 'pdf'
  if (f.type === 'image/png') return 'png'
  if (f.type === 'image/webp') return 'webp'
  return 'jpg'
}

// 兼容旧调用方（列表里只想问「这份原件是什么扩展名」）
export function extOf(inv) {
  const pages = invoicePageFiles(inv)
  return extOfPage(pages[0] || { file: inv && inv.file })
}

async function fetchBlob(blobId) {
  if (!blobId) return null
  try {
    return await getDocFile(blobId)
  } catch {
    return null
  }
}

// 把一张票展开成「页 × Blob」
async function pagesOf(inv) {
  const out = []
  for (const page of invoicePageFiles(inv)) {
    const blob = await fetchBlob(page.file && page.file.id)
    if (blob) out.push({ inv, page, blob, name: invoiceFileName(inv, extOfPage(page), page) })
  }
  return out
}

function clickDownload(item) {
  const url = URL.createObjectURL(item.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = item.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// 单份：下载**全部页**（单页票表现为一次下载，行为与旧版一致）
export async function downloadInvoice(inv) {
  const items = await pagesOf(inv)
  if (!items.length) return { ok: false, reason: '原件缺失（可能未同步到本机）' }
  if (items.length === 1) {
    clickDownload(items[0])
    return { ok: true, count: 1 }
  }
  // 多页：优先选目录一次写完（避免浏览器「允许下载多个文件」的弹窗风暴）
  const dir = await pickDirectory()
  if (dir) {
    for (const it of items) await writeInto(dir, it)
    return { ok: true, count: items.length, mode: 'directory' }
  }
  for (const it of items) {
    clickDownload(it)
    await new Promise((r) => setTimeout(r, 250))
  }
  return { ok: true, count: items.length, mode: 'sequential' }
}

// 只下载某一页（预览区「下载本页」）
export async function downloadInvoicePage(inv, page) {
  const blob = await fetchBlob(page && page.file && page.file.id)
  if (!blob) return { ok: false, reason: '这一页原件缺失' }
  clickDownload({ blob, name: invoiceFileName(inv, extOfPage(page), page) })
  return { ok: true }
}

async function pickDirectory() {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) return null
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' })
  } catch (e) {
    // 用户取消授权不是错误；其它异常也退回逐个下载
    return null
  }
}

async function writeInto(dir, item) {
  const fh = await dir.getFileHandle(item.name, { create: true })
  const w = await fh.createWritable()
  await w.write(item.blob)
  await w.close()
}

// 批量导出：每张票的**所有页**都导出
export async function downloadInvoices(list = []) {
  const rows = (list || []).filter(Boolean)
  if (!rows.length) return { ok: false, reason: '没有可导出的发票' }
  const items = []
  let missing = 0
  for (const inv of rows) {
    const pages = await pagesOf(inv)
    if (!pages.length) missing++
    items.push(...pages)
  }
  if (!items.length) return { ok: false, reason: '全部原件缺失（可能未同步到本机）' }

  const dir = await pickDirectory()
  if (dir) {
    let n = 0
    for (const it of items) {
      try {
        await writeInto(dir, it)
        n++
      } catch {
        /* 单个失败不阻断其余 */
      }
    }
    return { ok: true, count: n, files: items.length, mode: 'directory', missing }
  }

  for (const it of items) {
    clickDownload(it)
    await new Promise((r) => setTimeout(r, 250)) // 间隔，避免浏览器判定为恶意连点
  }
  return { ok: true, count: items.length, files: items.length, mode: 'sequential', missing }
}
