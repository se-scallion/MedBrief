// ===================== 超高图切块（纯函数 + 裁切工具） =====================
// 为什么需要：拼接出来的「长图」会让 macOS Vision 在内部降采样，**中间带成片丢行**。
// 代诊-挂号 2026-11-12 实测（判定用 rawRowCount，不看单项在不在）：
//   - 丢行与段数、绝对像素高无关，只与拼图 **h/w** 有关：
//     h/w ≤ 2.8 → 12/12 稳定；h/w = 3.21 → 48 行只剩 35 行（掉 27%），中间带成片丢、头尾完好；
//   - 绝对高度无害：3000×7216（h/w 2.41）满分 36/36；3000×9624（h/w 3.21）掉 27%；
//   - 修法实测有效：2000×6424（h/w 3.21）按 3250 高切 2 块（各 h/w 1.63、重叠 60 图像 px）
//     分别 OCR → 35/48 → **48/48**，合并后仍是 12 个不同项目。
//
// 本模块只做两件事：
//   1. planChunks(dim, opts)：给定图像尺寸，算出该怎么切（纯函数，可单测）；
//   2. cropChunks(dataUrl, plan)：按 plan 裁成若干 dataUrl（需要 @napi-rs/canvas）。
// 切块结果的行合并与留痕在 server.mjs / reportIntake.dedupeStitchRows 里做。

/** 长宽比阈值：h/w ≤ maxAspect 一律不切（单块路径必须与未引入本模块时逐像素一致） */
export const MAX_ASPECT = 2.8
/** 切块目标长宽比：切完每块约 h/w = targetAspect，留出余量 */
export const TARGET_ASPECT = 2.4
/**
 * 块间重叠（图像像素）。取 96 而不是 60 的实测依据（2026-11-12，2000×6424 样本，2× 截图）：
 *   重叠 60 → 两块 24+23 = 47 行（边界那行在两块里都被切、谁都认不全）；
 *   重叠 90/120/160 → 24+24 = 48 行（满）。
 * 2× 截图一行高约 86px，故重叠必须 ≥ 一行高；96 是「覆盖常见行高」与「少切重复区」的折中。
 */
export const DEFAULT_OVERLAP_PX = 96

/**
 * 计算切块方案（纯函数）
 * @param {{width:number,height:number}} dim 图像像素尺寸
 * @param {{maxAspect?:number,targetAspect?:number,overlapPx?:number}} opts
 * @returns {{chunks:Array<{y:number,h:number}>, chunked:boolean, aspect:number, planned:number}}
 */
export function planChunks(dim = {}, opts = {}) {
  const width = Number(dim.width) || 0
  const height = Number(dim.height) || 0
  const maxAspect = Number(opts.maxAspect) > 0 ? Number(opts.maxAspect) : MAX_ASPECT
  const targetAspect = Number(opts.targetAspect) > 0 ? Number(opts.targetAspect) : TARGET_ASPECT
  const overlapPx = Math.max(0, Number(opts.overlapPx ?? DEFAULT_OVERLAP_PX) || 0)

  if (width <= 0 || height <= 0) return { chunks: [{ y: 0, h: Math.max(0, height) }], chunked: false, aspect: 0, planned: 1 }

  const aspect = height / width
  if (aspect <= maxAspect) {
    // 单块路径：一个像素都不切
    return { chunks: [{ y: 0, h: height }], chunked: false, aspect, planned: 1 }
  }

  const planned = Math.max(2, Math.ceil(height / (width * targetAspect)))
  // 每块高度：总高 + (n-1) 段重叠，均摊到 n 块
  const chunkH = Math.ceil((height + (planned - 1) * overlapPx) / planned)
  const chunks = []
  let y = 0
  for (let i = 0; i < planned; i++) {
    const h = Math.min(chunkH, height - y)
    if (h <= 0) break
    chunks.push({ y, h })
    if (y + h >= height) break
    y = y + h - overlapPx
  }
  return { chunks, chunked: chunks.length > 1, aspect, planned }
}

/**
 * 按 plan 裁切图像（需要 @napi-rs/canvas）
 * @param {string} dataUrl 原图 dataUrl
 * @param {Array<{y:number,h:number}>} chunks
 * @returns {Promise<{width:number,height:number,parts:string[]}>}
 */
export async function cropChunks(dataUrl, chunks = []) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const b64 = String(dataUrl).replace(/^data:image\/[a-z+]+;base64,/i, '')
  const img = await loadImage(Buffer.from(b64, 'base64'))
  const parts = []
  for (const c of chunks) {
    const h = Math.min(c.h, img.height - c.y)
    const canvas = createCanvas(img.width, h)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, img.width, h)
    ctx.drawImage(img, 0, c.y, img.width, h, 0, 0, img.width, h)
    parts.push(`data:image/png;base64,${(await canvas.encode('png')).toString('base64')}`)
  }
  return { width: img.width, height: img.height, parts }
}

/** 读图像尺寸（不裁切） */
export async function imageSize(dataUrl) {
  const { loadImage } = await import('@napi-rs/canvas')
  const b64 = String(dataUrl).replace(/^data:image\/[a-z+]+;base64,/i, '')
  const img = await loadImage(Buffer.from(b64, 'base64'))
  return { width: img.width, height: img.height }
}
