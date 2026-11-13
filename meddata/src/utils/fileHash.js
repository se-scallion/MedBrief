// ===================== 文件内容指纹（SHA-256） =====================
// 用途：导入查重。同一份文件（字节完全一致）→ 哈希必然一致，可 100% 精确命中重复导入，
// 不受 OCR 随机性影响（内容指纹 fingerprint 会因两次识别的个别指标差异而漏判）。
//
// 与内容指纹的关系（双通道查重，二者互补）：
//   - 文件哈希：同一文件重复导入 → 精确命中（本模块）
//   - 内容指纹：同一报告的不同文件（拍照两次 / 截图两次）→ 语义命中（normalize.fingerprint）
// 上层查重应先比文件哈希，未命中再退到内容指纹。

// 计算文件的 SHA-256 十六进制串（32 字节 → 64 位十六进制）。
// WebCrypto 原生实现，无需第三方库；非安全上下文（罕见）降级为「体积+名称」弱指纹，
// 保证功能不中断（弱指纹仍可拦住「同名同大小文件重复导入」这一最常见场景）。
export async function fileFingerprint(file) {
  if (!file) return ''
  try {
    const buf = await file.arrayBuffer()
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buf)
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  } catch {
    // 落到下面的弱指纹兜底
  }
  return `weak:${file.size}|${file.name}`
}

// 存档图（dataURL 字符串）的 SHA-256 —— 历史记录补哈希专用。
// 为什么需要第二路哈希：file_hash 基于「原文件字节」，而历史记录入库时还没这个字段，
// 原文件也早已拿不到（浏览器不保留 File 对象）。但每条记录都存了 900px 存档图
// （`record.image`，由 compressImageDataUrl 生成），同一文件 → 同一压缩流程 → 同一 dataURL，
// 因此可用它反推「是否同一份文件」，让老记录也能参与精确查重。
// 口径纪律：新记录的 image_hash 必须在**保存时同一条压缩链路**（compressImageDataUrl 900px/0.8）
// 上计算，否则与历史值对不上。
export async function dataUrlFingerprint(dataUrl) {
  if (!dataUrl) return ''
  try {
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const bytes = new TextEncoder().encode(dataUrl)
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  } catch {
    // 落到下面的弱指纹兜底
  }
  return `weakimg:${dataUrl.length}`
}
