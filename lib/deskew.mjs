// ===================== 图像倾斜矫正（deskew） =====================
// 为什么需要（2026-11-12 单变量失真实测，合成 11 项化验单，全程走 /api/intake/ocr）：
//   原图 11/11 ｜ 旋转 1° 11/11 ｜ **旋转 2° 8/11（掉 27%）** ｜ 3° 9/11 ｜ 5° 9/11
//   缩到 800px 宽 11/11 ｜ 灰度+低对比 11/11
//   → 瓶颈**不是清晰度/分辨率**，而是 `groupBlocksIntoRows` 靠「同一行 y 相近」聚类：整页一倾斜，
//     同一行跨 y，行聚类直接崩。矫正回正后 11/11 完全恢复。
//
// 做法：缩到 ~300px 宽 → 灰度二值化 → 在 [-5°, +5°] 上按 0.5° 步长做**投影 profile**：
//   把黑点按旋转后行号累加，取「行投影方差最大」的角度（文字对齐时行间留白最干净、方差最大）。
// 纯本地计算，不调 OCR；estimate 目标 ≤ 150ms。
//
// 语义约定：estimateSkew 返回的 angle 就是**矫正所需的旋转角**，可直接传给 deskewImage。

export const SKEW_MAX_DEG = 5
export const SKEW_STEP_DEG = 0.5
/** 低于该角度不动：二次插值本身会让字变糊，收益小于损失 */
export const SKEW_MIN_APPLY_DEG = 0.5

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  const s = String(input || '')
  return Buffer.from(s.replace(/^data:image\/[a-z+]+;base64,/i, ''), 'base64')
}

/**
 * 估倾斜角
 * @param {Buffer|string} input 图片 Buffer 或 dataUrl
 * @param {{maxDeg?:number, stepDeg?:number, targetWidth?:number}} opts
 * @returns {Promise<{angle:number, confidence:number, profile:Array<{angle:number,variance:number}>}>}
 *   angle 为**矫正所需旋转角**（度，正负对应 canvas rotate 的弧度方向）
 */
export async function estimateSkew(input, opts = {}) {
  const maxDeg = Number(opts.maxDeg) || SKEW_MAX_DEG
  const stepDeg = Number(opts.stepDeg) || SKEW_STEP_DEG
  const targetWidth = Number(opts.targetWidth) || 300
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')

  const img = await loadImage(toBuffer(input))
  const scale = Math.min(1, targetWidth / img.width)
  const w = Math.max(40, Math.round(img.width * scale))
  const h = Math.max(40, Math.round(img.height * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data

  // 灰度二值化：文字=1
  const dark = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
      if (g < 140) dark.push(x, y)
    }
  }
  const n = dark.length / 2
  if (n < 50) return { angle: 0, confidence: 0, profile: [] }

  const cx = w / 2
  const cy = h / 2
  const profile = []
  for (let deg = -maxDeg; deg <= maxDeg + 1e-9; deg += stepDeg) {
    const rad = (deg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    // 把黑点投到「旋转后」的行号上：ry = (y-cy)*cos - (x-cx)*sin + cy
    const rows = new Int32Array(h + 2 * Math.ceil(Math.abs(sin) * w + Math.abs(cos) * h) || h)
    const offset = Math.ceil(Math.abs(sin) * w / 2 + Math.abs(cos) * h / 2)
    for (let k = 0; k < n; k++) {
      const x = dark[k * 2] - cx
      const y = dark[k * 2 + 1] - cy
      const ry = Math.round(y * cos - x * sin + offset)
      if (ry >= 0 && ry < rows.length) rows[ry]++
    }
    // 行投影方差
    let sum = 0
    for (let i = 0; i < rows.length; i++) sum += rows[i]
    const mean = sum / rows.length
    let varc = 0
    for (let i = 0; i < rows.length; i++) varc += (rows[i] - mean) * (rows[i] - mean)
    profile.push({ angle: deg, variance: varc / rows.length })
  }

  let best = profile[0]
  for (const p of profile) if (p.variance > best.variance) best = p
  const sorted = profile.slice().sort((a, b) => b.variance - a.variance)
  const second = sorted[1] || { variance: 0 }
  const confidence = best.variance > 0 ? 1 - second.variance / best.variance : 0
  // 反号：estimate 直接把「图斜了多少」变成「要转回去多少」
  const angle = Math.abs(best.angle) < SKEW_MIN_APPLY_DEG ? 0 : -best.angle
  return { angle: Number(angle.toFixed(1)), confidence: Number(confidence.toFixed(3)), profile }
}

/**
 * 按给定角度旋转图片（白底填充，画布放大到能容纳旋转后的整图）
 * @param {Buffer|string} input
 * @param {number} angleDeg 旋转角（度）；正负与 canvas rotate 一致（顺时针为正）
 * @returns {Promise<string>} dataUrl（png）
 */
export async function deskewImage(input, angleDeg) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const img = await loadImage(toBuffer(input))
  const rad = (Number(angleDeg || 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const w = Math.round(img.width * cos + img.height * sin)
  const h = Math.round(img.width * sin + img.height * cos)
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.translate(w / 2, h / 2)
  ctx.rotate(rad)
  ctx.drawImage(img, -img.width / 2, -img.height / 2)
  return `data:image/png;base64,${(await canvas.encode('png')).toString('base64')}`
}

/** 便捷封装：估角 + 条件矫正（|angle| < 0.5° 不动） */
export async function autoDeskew(input, opts = {}) {
  const t0 = Date.now()
  const est = await estimateSkew(input, opts)
  const ms = Date.now() - t0
  if (Math.abs(est.angle) < SKEW_MIN_APPLY_DEG) {
    return { image: typeof input === 'string' ? input : null, angle: 0, detected: est.angle, applied: false, confidence: est.confidence, ms }
  }
  const image = await deskewImage(input, est.angle)
  return { image, angle: est.angle, detected: est.angle, applied: true, confidence: est.confidence, ms }
}
