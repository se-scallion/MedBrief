// ===================== 检查报告 → 交给 AI 读的图片 =====================
// 只在浏览器端使用（canvas / Image）；node 侧不 import 本模块。
//
// 为什么需要它：AI 读图通道要的是一张**图片**的 dataURL，而检查报告的原件可能是：
//   ① 图片（微信截图 / 翻拍）→ 原样；
//   ② 有文字层的 PDF → 本来走 doc-text 文本模式，不需要图（见 docAi.docReadModeFor）；
//   ③ 扫描件 PDF（无文字层）→ 必须渲染成图；**多页时不能只读第 1 页**（CT/MRI 报告常 2-4 页，
//      只读首页会静默丢一半内容），故纵向拼接为一张长图，高度封顶后等比缩放。
import { renderPdfAllPages } from './ocr.js'

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
}

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })

// 多张图纵向拼接（统一宽度；总高超过 maxHeight 时整体等比缩放，保证不裁切内容）
export async function stitchImagesVertical(dataUrls, { width = 1400, maxHeight = 5000 } = {}) {
  const imgs = await Promise.all(dataUrls.map(loadImage))
  if (!imgs.length) throw new Error('无可拼接图片')
  const scale = Math.min(...imgs.map((im) => width / (im.naturalWidth || width)))
  const drawW = Math.round((imgs[0].naturalWidth || width) * scale)
  const heights = imgs.map((im) => Math.round((im.naturalHeight || 1) * scale))
  const totalH = heights.reduce((a, b) => a + b, 0)
  const fit = totalH > maxHeight ? maxHeight / totalH : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(drawW * fit)
  canvas.height = Math.round(totalH * fit)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff' // PDF 渲染出的 JPEG 无透明通道，白底防拼接缝隙发黑
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let y = 0
  imgs.forEach((im, i) => {
    const w = Math.round((im.naturalWidth || drawW) * scale * fit)
    const h = Math.round(heights[i] * fit)
    ctx.drawImage(im, 0, y, w, h)
    y += h
  })
  return canvas.toDataURL('image/jpeg', 0.9)
}

// 检查报告 → AI 读图用的图片
//   file: 原始 File（图片或 PDF）
//   -> { dataUrl, pages, stitched, note }
export async function docImageForAi(file, { width = 1400, maxHeight = 5000 } = {}) {
  if ((file.type || '').startsWith('image/')) {
    return { dataUrl: await fileToDataUrl(file), pages: 1, stitched: false, note: '' }
  }
  const pdfUrl = await fileToDataUrl(file)
  const pages = await renderPdfAllPages(pdfUrl, width)
  if (!pages.length) throw new Error('PDF 渲染失败，无法交给 AI 读图')
  if (pages.length === 1) return { dataUrl: pages[0], pages: 1, stitched: false, note: '' }
  const stitched = await stitchImagesVertical(pages, { width, maxHeight })
  return {
    dataUrl: stitched,
    pages: pages.length,
    stitched: true,
    note: `已把 ${pages.length} 页纵向拼接为一张（避免只读第 1 页丢内容）`,
  }
}
