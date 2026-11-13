// ===================== 上传组件（图片 / PDF → 直接回调原始 dataURL，免裁剪） =====================

import { useCallback, useRef, useState } from 'react'
import { Button, Alert } from 'antd'
import { fileFingerprint, dataUrlFingerprint } from '../utils/fileHash.js'
import { saveRecordImage } from '../utils/docFileStore.js'

export default function ImageUploader({ image, onImage, onFileMeta, onFile }) {
  const [dragOver, setDragOver] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  const handleFile = useCallback(async (file) => {
    setError('')
    if (!file) return
    const okImage = /^image\/(jpeg|png|webp)$/.test(file.type)
    const okPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    if (!okImage && !okPdf) {
      setError('仅支持 JPG / PNG / 单页 PDF 文件')
      return
    }
    // 原始 File 回调（在转 dataURL 前）：导入页用于把文件登记进跨路由缓存，
    // 之后流程切换（如化验页识别出检查报告后切归档页）目标页才能拿到同一文件。
    if (onFile) onFile(file)
    setLoading(true)
    try {
      // 文件指纹（SHA-256）：OCR 前同步算完（几 MB 文件 <100ms，远快于 20s+ 的识别），
      // 保证识别完成时哈希已就绪，导入查重可精确命中「同一文件重复导入」。
      // legacyHash：复现旧压缩链路的存档图哈希，用于命中 08-27 前入库的老记录。
      if (onFileMeta) {
        const [hash, legacyHash, originalId] = await Promise.all([
          fileFingerprint(file),
          okImage ? legacyArchiveHash(file) : Promise.resolve(''),
          // 原图写入 IndexedDB（体积大，不进 localStorage）；PDF 也存原件，详情页可复用
          saveRecordImage(file),
        ])
        onFileMeta({ hash, legacyHash, original_id: originalId, name: file.name, size: file.size })
      }
      // PDF：dataURL 前缀强制为 application/pdf（浏览器对 file.type 的识别可能为空串 /
      //      octet-stream，前缀不符会让 runOCR 误走图片通道；统一后必走 pdfjs 文本提取，秒级）
      // 图片：先降采样再转 dataURL（Tesseract 纯 CPU 识别耗时与像素数近似线性，
      //       缩放后保证在 90 秒识别标准内完成）
      const dataUrl = okImage ? await downscaleImage(file) : await toPdfDataUrl(file)
      onImage(dataUrl, okImage ? 'image/jpeg' : 'application/pdf')
    } catch (e) {
      setError('文件解析失败：' + e.message)
    } finally {
      setLoading(false)
    }
  }, [onImage, onFileMeta, onFile])

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files && e.dataTransfer.files[0]
    handleFile(file)
  }

  return (
    <div className="space-y-4">
      {/* 隐私声明条 */}
      <div className="card p-4 flex gap-3 items-start bg-brand-50 border-brand-200">
        <div className="text-brand-700 text-xl leading-none mt-0.5">🔒</div>
        <div>
          <p className="text-sm font-medium text-brand-800">隐私第一 · 全程本地离线识别</p>
          <p className="text-xs text-brand-700 mt-0.5">
            化验单在本机浏览器内离线识别，图片不外发。识别结果保存在本机
            （本机浏览器 IndexedDB），结构化数据可按需同步到自建数据源。首次识别需加载识别引擎，约 20 秒以上。
          </p>
        </div>
      </div>

      {/* 上传区 */}
      <div
        className={`card p-8 text-center transition-colors cursor-pointer border-2 border-dashed ${
          dragOver ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-brand-400'
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current && fileInputRef.current.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
          className="hidden"
          onChange={(e) => { handleFile(e.target.files && e.target.files[0]); e.target.value = '' }}
        />
        <div className="mx-auto w-14 h-14 rounded-full bg-brand-100 flex items-center justify-center text-2xl mb-3">
          📄
        </div>
        <p className="text-sm font-medium text-slate-700">
          {loading ? '正在解析文件…' : '拖拽化验单到此处，或点击选择文件'}
        </p>
        <p className="text-xs text-slate-400 mt-1">支持 JPG / PNG / 单页 PDF · 上传后自动开始识别</p>
      </div>
      {error && <Alert type="error" showIcon className="mt-2" message={error} />}

      {/* 已上传预览 */}
      {image && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700">已上传文件</h3>
            <Button size="small" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
              更换文件
            </Button>
          </div>
          <img src={image} alt="化验单" className="max-h-64 rounded-lg border border-slate-200 mx-auto" />
        </div>
      )}
    </div>
  )
}

// 文件 → dataURL（PDF 原样透传用）
export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

// PDF dataURL：统一强制 application/pdf 前缀，保证 runOCR 走文本提取秒级通道
export async function toPdfDataUrl(file) {
  const raw = await readAsDataUrl(file)
  const b64 = raw.split(',')[1] || ''
  return `data:application/pdf;base64,${b64}`
}

// 图片识别前降采样：宽度上限 1200px。
// Tesseract 纯 CPU 识别，耗时与像素数近似线性；手机照片常 3000px+，
// 缩放后通常 20s 以上完成，满足「识别不超过 90 秒」的时间标准。
const MAX_IMAGE_WIDTH = 1200
const JPEG_QUALITY = 0.85

export async function downscaleImage(file) {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_WIDTH / bitmap.width)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    // 原图宽度 ≤ MAX_IMAGE_WIDTH：无需降采样，直接透传原文件 dataURL。
    // 避免「不缩放却重编码为 JPEG 0.85」引入有损压缩，导致数字粘连/整行丢失
    // （如 TBA 17.4 被读成 41.3、白蛋白行整行消失）。
    if (scale === 1 && w === bitmap.width && h === bitmap.height) {
      return await readAsDataUrl(file)
    }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    // 白底填充（JPEG 无透明通道，避免透明区域变黑）
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } finally {
    bitmap.close()
  }
}

// 复现「旧压缩链路」（recog-v1.2.1 / Bug 037 之前）的存档图，并取 SHA-256。
// 为什么需要：旧 downscaleImage 无论原图大小都走 canvas JPEG 0.85 重编码，而现行实现在
// 原图 ≤1200px 时直接透传原文件字节——同一份文件，两次导入产出的存档图 dataURL 并不相同。
// 于是「08-27 前入库的老记录」与「现在导入的同一文件」按新链路哈希对不上，查重静默漏检。
// 解法：新导入额外算一份旧链路哈希作为候选，与老记录回填的 image_hash 对齐。
// PDF 无位图可解码 → 返回 ''，该通道自动失效（PDF 本就走文本提取，重复风险由内容指纹兜底）。
export async function legacyArchiveHash(file) {
  try {
    const bitmap = await createImageBitmap(file)
    let recoded = ''
    try {
      const scale = Math.min(1, MAX_IMAGE_WIDTH / bitmap.width)
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(bitmap, 0, 0, w, h)
      recoded = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    } finally {
      bitmap.close()
    }
    if (!recoded) return ''
    return await dataUrlFingerprint(await compressImageDataUrl(recoded))
  } catch {
    return ''
  }
}

// dataURL → 压缩 JPEG dataURL（存档用：控制体积，仅用于详情查看，不影响 OCR）
export function compressImageDataUrl(dataUrl, maxWidth = 900, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width)
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = reject
    img.src = dataUrl
  })
}
