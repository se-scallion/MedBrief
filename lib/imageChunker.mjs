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

/**
 * 按「墨迹 bbox」裁掉四周白边（纯本地，不调 OCR）。
 * 为什么必须有这一步（2026-11-12 真实 bug）：deskew 旋转会给四角补白，宽度被撑大、内容没变宽，
 * 于是 `planChunks` 拿到的是**回正后**的尺寸 → 本该切块的超重图被判成「不超高」：
 *   实测 2223×6490（h/w 2.92，该切）→ deskew 后 2448×6564（h/w 2.68，判成不切）→ 48 行只出 43 行。
 *   裁掉白边后 1864×6295（h/w 3.38）→ 切 2 块 → 48 行、12 项。白边是唯一变量，因果闭合。
 * 因此 OCR 链固定为：deskew → cropToContent → planChunks → 逐块 OCR → 合并。
 *
 * 边界（都不许抛错）：整页几乎没有白边 → 原样返回；纯白/纯黑等 bbox 异常 → 原样返回；
 * 裁完比原图小不到 `minGainPx` → 视为「本来就贴边」，原样返回（避免为几个像素反复重采样）。
 *
 * @param {string|Buffer} input dataUrl 或 Buffer
 * @param {{padding?:number, threshold?:number, minGainPx?:number}} opts
 * @returns {Promise<{image:string|null, cropped:boolean, box:{x:number,y:number,w:number,h:number}, width:number, height:number, original:{width:number,height:number}}>}
 */
export async function cropToContent(input, opts = {}) {
  const padding = Math.max(0, Number(opts.padding ?? 10))
  const threshold = Number(opts.threshold ?? 140)
  const minGainPx = Math.max(0, Number(opts.minGainPx ?? 16))
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const b64 = String(input).replace(/^data:image\/[a-z+]+;base64,/i, '')
  const img = await loadImage(Buffer.isBuffer(input) ? input : Buffer.from(b64, 'base64'))
  const W = img.width
  const H = img.height
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, H)
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, W, H).data

  let left = W
  let right = -1
  let top = H
  let bottom = -1
  let ink = 0
  for (let y = 0; y < H; y++) {
    const rowBase = y * W * 4
    for (let x = 0; x < W; x++) {
      const i = rowBase + x * 4
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
      if (g < threshold) {
        ink++
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }

  const original = { width: W, height: H }
  const unchanged = { image: null, cropped: false, box: { x: 0, y: 0, w: W, h: H }, width: W, height: H, original }
  // 纯白（没有墨迹）或整页墨迹铺满（bbox 异常）→ 不裁、不抛错
  if (ink < 20 || right < 0 || bottom < 0) return unchanged
  if (right - left < W * 0.05 || bottom - top < H * 0.05) return unchanged

  const x = Math.max(0, left - padding)
  const y = Math.max(0, top - padding)
  const w = Math.min(W - x, right - left + 1 + padding * 2)
  const h = Math.min(H - y, bottom - top + 1 + padding * 2)
  if (W - w < minGainPx && H - h < minGainPx) return unchanged // 本来就贴边

  const out = createCanvas(w, h)
  const octx = out.getContext('2d')
  octx.fillStyle = '#ffffff'
  octx.fillRect(0, 0, w, h)
  octx.drawImage(img, x, y, w, h, 0, 0, w, h)
  return {
    image: `data:image/png;base64,${(await out.encode('png')).toString('base64')}`,
    cropped: true,
    box: { x, y, w, h },
    width: w,
    height: h,
    original,
  }
}

/** 读图像尺寸（不裁切） */
export async function imageSize(dataUrl) {
  const { loadImage } = await import('@napi-rs/canvas')
  const b64 = String(dataUrl).replace(/^data:image\/[a-z+]+;base64,/i, '')
  const img = await loadImage(Buffer.from(b64, 'base64'))
  return { width: img.width, height: img.height }
}
