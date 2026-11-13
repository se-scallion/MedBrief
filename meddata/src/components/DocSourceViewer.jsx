// ===================== 检查报告 · 原件查看器（核对态左栏）=====================
// 核对检查报告的核心动作是「看着原件改字段」，故原件与字段并排。
// 复用 DocDetail 的 iframe + CSS zoom 预览范式（图片与 PDF 同一套控件），零新增依赖。
import { useEffect, useState } from 'react'
import { Button } from 'antd'

// 可选 downloadName：给了就在头部多一个「下载」（列表行「原件」直达弹层要用，导入核对态不需要）
export default function DocSourceViewer({ file, note, className = '', downloadName }) {
  const [url, setUrl] = useState(null)
  const [zoom, setZoom] = useState(1)
  const isImage = (file && file.type ? file.type : '').startsWith('image/')

  useEffect(() => {
    if (!file) {
      setUrl(null)
      return
    }
    const u = URL.createObjectURL(file)
    setUrl(u)
    setZoom(1)
    return () => URL.revokeObjectURL(u)
  }, [file])

  const step = (d) => setZoom((z) => Math.min(3, Math.max(0.4, +(z + d).toFixed(2))))

  return (
    <div className={`bg-slate-100 flex flex-col min-h-0 ${className}`} data-testid="doc-source-viewer">
      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-slate-500 shrink-0">原件</span>
          {file && <span className="text-[11px] text-slate-400 truncate">{file.name}</span>}
        </div>
        <div className="flex items-center gap-1 text-slate-500 shrink-0">
          <Button size="small" className="!px-1.5" onClick={() => step(-0.1)} disabled={zoom <= 0.4} title="缩小">
            －
          </Button>
          <span className="text-[11px] tabular-nums w-9 text-center">{Math.round(zoom * 100)}%</span>
          <Button size="small" className="!px-1.5" onClick={() => step(0.1)} disabled={zoom >= 3} title="放大">
            ＋
          </Button>
          <Button size="small" className="!px-1.5" onClick={() => setZoom(1)} title="适配窗口">
            适配
          </Button>
          {downloadName && url && (
            <Button
              size="small"
              onClick={() => {
                const a = document.createElement('a')
                a.href = url
                a.download = downloadName
                a.click()
              }}
              title="下载原件"
            >
              下载
            </Button>
          )}
        </div>
      </div>
      {note && <p className="px-3 pb-1 text-[11px] text-amber-600">{note}</p>}
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {!url ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-400">原件读取中…</div>
        ) : isImage ? (
          <img src={url} alt="检查报告原件" className="mx-auto block" style={{ width: `${zoom * 100}%` }} />
        ) : (
          <div style={{ width: `${zoom * 100}%`, minWidth: '100%', height: '100%', minHeight: 420 }}>
            <iframe title="原件预览" src={url} style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
          </div>
        )}
      </div>
    </div>
  )
}
