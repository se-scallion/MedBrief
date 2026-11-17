// 原件预览弹窗（2026-11-17 UI 规格 reports-panel-ui-1117-spec.md §1）
// 为什么同页 Modal 而不是 window.open 新标签：手机端新标签可能不带同域 session cookie ⇒
//   /api/intake/blob/:id 返回 401 JSON，被当图片渲染 = 白屏（运维只读取证：网关/WAF 无关）。
// 规格硬条：PDF 走 pdf.js 逐页渲 canvas，**禁止 iframe**（iOS Safari 对 iframe PDF 支持差）；
//   图片走 <img> object-fit:contain；失败态 Alert 文案含「登录」+ 重试 + data-blob-error；
//   底部保留「下载 / 在浏览器打开」兜底（同源下载通道，不是新标签渲染的替代品）。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Space, Spin, Typography } from 'antd'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// pdf.js 内部会把默认 workerSrc 设成 './pdf.worker.mjs'（构建产物里不存在），
// 所以必须无条件覆盖成 vite ?url 产出的带 hash 路径，不能 `if (!workerSrc)` 跳过。
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

const { Text } = Typography
const FAIL_TEXT = '原件打不开：可能需要重新登录，或该原件已不存在'
const PAGE_BATCH = 3
const MAX_AUTO_PAGES = 12

/** 用 pdf.js 把单页渲到 canvas（页宽=容器宽、DPR 上限 2）。 */
async function renderPage(doc, pageNo, canvas) {
  const page = await doc.getPage(pageNo)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const base = canvas.parentElement?.clientWidth || 640
  const viewport = page.getViewport({ scale: 1 })
  const scale = (base - 24) / viewport.width
  const vp = page.getViewport({ scale: scale * dpr })
  canvas.width = Math.floor(vp.width)
  canvas.height = Math.floor(vp.height)
  canvas.style.width = `${Math.floor(vp.width / dpr)}px`
  canvas.style.height = `${Math.floor(vp.height / dpr)}px`
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
}

/**
 * BlobModal —— 同页原件预览。
 * @param {{blobId:string,type?:string,name?:string,date?:string}|null} target 目标（null 不渲染）
 * @param {() => void} onClose 关闭回调
 */
export default function BlobModal({ target, onClose }) {
  const [kind, setKind] = useState('')
  const [blobUrl, setBlobUrl] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [pdfPages, setPdfPages] = useState(0)
  const [rendered, setRendered] = useState(0)
  const docRef = useRef(null)
  const scrollRef = useRef(null)
  const canvasRefs = useRef([])

  // 清理：URL 与 pdf doc
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl) }, [blobUrl])
  useEffect(() => () => { try { docRef.current?.destroy() } catch {} docRef.current = null }, [])
  useEffect(() => {
    if (!target?.blobId) return
    let alive = true
    setLoading(true); setErr(''); setKind(''); setBlobUrl(''); setPdfPages(0); setRendered(0)
    canvasRefs.current = []
    try { docRef.current?.destroy() } catch {}
    docRef.current = null
    fetch(`/api/intake/blob/${encodeURIComponent(target.blobId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const ct = (res.headers.get('content-type') || '').toLowerCase()
        const type = ct.includes('pdf') ? 'application/pdf' : ct.startsWith('image/') ? ct.split(';')[0] : (target.type || '')
        if (!/^image\//.test(type) && type !== 'application/pdf') throw new Error(`不支持的类型：${type || '未知'}`)
        const blob = new Blob([await res.arrayBuffer()], { type })
        const url = URL.createObjectURL(blob)
        if (!alive) { URL.revokeObjectURL(url); return }
        setBlobUrl(url); setKind(type === 'application/pdf' ? 'pdf' : 'image')
        if (type === 'application/pdf') {
          const doc = await pdfjsLib.getDocument({ url }).promise
          if (!alive) { try { doc.destroy() } catch {}; return }
          docRef.current = doc
          setPdfPages(doc.numPages)
        }
        setLoading(false)
      })
      .catch((e) => { if (alive) { setErr(`${FAIL_TEXT}（${e.message}）`); setLoading(false) } })
    return () => { alive = false }
  }, [target?.blobId, attempt])

  // pdf 首屏渲染 3 页；滚到底续 3 页（最多 12 页后给「继续加载」按钮）
  const loadMore = useCallback(async (force = false) => {
    if (kind !== 'pdf' || !docRef.current) return
    const next = Math.min(pdfPages, rendered + PAGE_BATCH)
    if (next <= rendered && !force) return
    for (let p = rendered + 1; p <= next; p++) {
      const canvas = canvasRefs.current[p - 1]
      if (canvas && !canvas.dataset.done) {
        try { await renderPage(docRef.current, p, canvas); canvas.dataset.done = '1' } catch (e) { setErr(`第 ${p} 页渲染失败：${e.message}`) }
      }
    }
    setRendered(next)
  }, [kind, pdfPages, rendered])

  useEffect(() => { if (!loading && kind === 'pdf') loadMore(true) }, [loading, kind, pdfPages, loadMore])

  const onScroll = (e) => {
    if (kind !== 'pdf' || rendered >= pdfPages) return
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) loadMore()
  }

  const url = target?.blobId ? `/api/intake/blob/${encodeURIComponent(target.blobId)}` : ''
  return (
    <Modal
      className="blob-modal"
      open={!!target}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={typeof window !== 'undefined' && window.innerWidth <= 575 ? 'calc(100vw - 24px)' : 900}
      style={{ maxWidth: '90vw', top: 24 }}
      title={<Text style={{ fontSize: 12 }}>{target?.name || '原件'}{target?.date ? ` · ${target.date}` : ''}</Text>}
    >
      <div data-blob-error={err ? '1' : undefined}>
        {err ? (
          <Space direction="vertical" align="center" style={{ width: '100%', padding: 24 }}>
            <Alert type="error" showIcon message={err} />
            <Button onClick={() => setAttempt((n) => n + 1)}>重试</Button>
          </Space>
        ) : loading ? (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin size="large" /></div>
        ) : kind === 'image' ? (
          <div style={{ maxHeight: 'calc(84vh - 96px)', overflow: 'auto', textAlign: 'center' }}>
            <img src={blobUrl} alt="原件" style={{ maxWidth: '100%', maxHeight: 'calc(84vh - 96px)', objectFit: 'contain' }} />
          </div>
        ) : kind === 'pdf' ? (
          <div ref={scrollRef} onScroll={onScroll} style={{ maxHeight: 'calc(84vh - 96px)', overflow: 'auto', textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>第 {rendered || 1} / {pdfPages} 页</Text>
            {Array.from({ length: rendered }, (_, i) => (
              <canvas key={i} ref={(el) => { canvasRefs.current[i] = el }} style={{ display: 'block', margin: '8px auto' }} />
            ))}
            {rendered < pdfPages && <Button size="small" onClick={() => loadMore(true)}>继续加载</Button>}
          </div>
        ) : null}
      </div>
      <div style={{ marginTop: 8, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
        <Space size={8} wrap>
          <Button type="link" size="small" href={url} target="_blank" rel="noreferrer">下载 / 在浏览器打开</Button>
          <Text type="secondary" style={{ fontSize: 12 }}>若上面看不全，可下载后用系统阅读器打开</Text>
        </Space>
      </div>
    </Modal>
  )
}
