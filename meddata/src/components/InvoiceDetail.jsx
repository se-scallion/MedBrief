// ===================== 发票详情（弹层） =====================
// 2026-10-28 按「住院发票多页」重新设计：
//   左：页签（票据页 / 明细第 1..N 页）+ 当前页预览（图片等比 / PDF 内框）+ 下载本页 / 下载全部页
//       —— 一页都没识别出来时也能就地补页（「添加明细页」选文件 → 落 Blob → 挂 attachments）
//   右：票面字段（可改）+ 明细页管理（移出）+ 对账提示 + 删除
// 原件 Blob 走 docFileStore（跨机未命中会自动向数据源取），下载走 invoiceDownload（规范文件名 + 页后缀）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tag } from 'antd'
import InvoiceFields from './InvoiceFields.jsx'
import { deleteInvoice, updateInvoice, useStore } from '../data/store.js'
import { getDocFile, blobToUrl, saveDocFile } from '../utils/docFileStore.js'
import { downloadInvoice, downloadInvoicePage } from '../utils/invoiceDownload.js'
import { invoiceDetailCount, invoicePageFiles, reconcileStay } from '../utils/invoice.js'
import { parsePageText } from '../utils/invoiceParse.js'
import { extractDocContent } from '../utils/parseDoc.js'
import { ocrImageToText, ocrScannedPdfToText } from '../utils/ocr.js'
import { fmtMoney } from '../utils/cost.js'
import CloseButton from './CloseButton.jsx'
import EscClose from './EscClose.jsx'
import { useEscClose, useBodyScrollLock } from '../utils/overlay.js'

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = reject
    fr.readAsDataURL(file)
  })

// 只为拿「第 x 页 共 y 页」这类页信息，识别失败也照样挂页（原件留档优先）
async function pageTextOf(file) {
  const isPdf = (file.type || '').includes('pdf') || /\.pdf$/i.test(file.name || '')
  try {
    if (isPdf) {
      const { text, isScanned } = await extractDocContent(file)
      if (!isScanned && text && text.trim()) return text
      return (await ocrScannedPdfToText(file)) || ''
    }
    return (await ocrImageToText(await fileToDataUrl(file))) || ''
  } catch {
    return ''
  }
}

const isPdfPage = (page) =>
  !!page &&
  !!page.file &&
  (page.file.type === 'application/pdf' || /\.pdf$/i.test(page.file.name || ''))

export default function InvoiceDetail({ invoice, onClose, onNotify }) {
  const store = useStore()
  const stays = store.stays || []
  const invoices = store.invoices || []

  // ⚠ 只能按 id 从 store 里取「活的那条」，不能直接用 props 传进来的快照：
  // 父组件是在点开弹层那一刻把对象快照塞进 state 的，之后 updateInvoice 会生成**新对象**，
  // 快照永远不变 → 弹层里加了明细页／移出页／改了归属，页面却要关掉重开才看得到（用户实测反馈）。
  const live = useMemo(() => {
    const id = invoice && invoice.id
    return (id && invoices.find((v) => v.id === id)) || invoice
  }, [invoices, invoice])

  const [draft, setDraft] = useState(live)
  const [urls, setUrls] = useState({}) // fileId → objectURL
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [active, setActive] = useState('')
  const [adding, setAdding] = useState(false)
  const fileInputRef = useRef(null)
  // 票面字段是「改了要点保存」的草稿：直接关会静默丢改动，所以有未保存改动时先问一句
  const [confirmClose, setConfirmClose] = useState(false)
  const requestClose = () => {
    if (dirty) setConfirmClose(true)
    else if (onClose) onClose()
  }
  useEscClose(requestClose)
  useBodyScrollLock()

  // 弹层换了另一张票才重置编辑态；同一张票的数据更新（如新增明细页）不重置，避免冲掉用户正在改的字段
  useEffect(() => {
    setDraft(live)
    setActive('')
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice && invoice.id])

  // 记录变了但用户没有未保存修改 → 跟着刷新（`保存修改` 后 draft 自动回到最新）
  useEffect(() => {
    if (!dirty) setDraft(live)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, dirty])

  const pages = useMemo(() => (live ? invoicePageFiles(live) : []), [live])
  const current = pages.find((p) => (p.file && p.file.id) === active) || pages[0] || null

  // 逐页取原件（本地未命中会向数据源要）
  useEffect(() => {
    let alive = true
    const made = []
    setLoading(true)
    ;(async () => {
      const map = {}
      for (const page of pages) {
        const id = page.file && page.file.id
        if (!id) continue
        try {
          const blob = await getDocFile(id)
          if (blob && alive) {
            const u = blobToUrl(blob)
            made.push(u)
            map[id] = u
          }
        } catch (e) {
          console.error('发票原件读取失败', id, e)
        }
      }
      if (alive) {
        setUrls(map)
        setLoading(false)
      }
    })()
    return () => {
      alive = false
      made.forEach((u) => URL.revokeObjectURL(u))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice && invoice.id, pages.map((p) => p.file && p.file.id).join(',')])

  const stay = useMemo(() => stays.find((s) => s.id === (draft && draft.stay_id)) || null, [stays, draft])
  const rec = useMemo(() => (stay ? reconcileStay(stay, invoices) : null), [stay, invoices])

  const save = () => {
    updateInvoice(live.id, draft)
    setDirty(false)
    onNotify && onNotify('发票已更新')
  }

  // 补页：把用户手上的明细页/票据页挂进本张票（识别只用于取页码，失败也照挂）
  const addPages = async (list) => {
    const arr = Array.from(list || []).filter(Boolean)
    if (!arr.length) return
    setAdding(true)
    try {
      const added = []
      for (const f of arr) {
        const text = await pageTextOf(f)
        const parsed = text ? parsePageText(text) : { fields: {} }
        const meta = await saveDocFile(f)
        added.push({
          id: meta,
          name: f.name,
          type: f.type,
          size: f.size,
          role: parsed.role === 'invoice' ? 'invoice' : 'detail',
          page_no: parsed.fields && parsed.fields.page_no ? Number(parsed.fields.page_no) : null,
          page_count: parsed.fields && parsed.fields.page_count ? Number(parsed.fields.page_count) : null,
        })
      }
      const next = [...(live.attachments || []), ...added.map(({ id, ...rest }) => ({ id, ...rest }))]
      updateInvoice(live.id, { attachments: next, has_file: true })
      onNotify && onNotify(`已添加 ${added.length} 页原件`)
    } catch (e) {
      onNotify && onNotify(`添加失败：${(e && e.message) || e}`)
    } finally {
      setAdding(false)
    }
  }

  // 移出附件页（只改记录，Blob 交给 doctor:blobs 的孤儿清理，避免误删被其它记录共用的字节）
  const removePage = (page) => {
    const id = page.file && page.file.id
    if (!id) return
    const next = (live.attachments || []).filter((a) => a.id !== id)
    updateInvoice(live.id, { attachments: next, has_file: !!(live.file && live.file.id) || next.length > 0 })
    onNotify && onNotify('已移出该页')
  }

  if (!live) return null

  const detailCount = invoiceDetailCount(live)
  const pageUrl = current && current.file ? urls[current.file.id] : ''
  const pageLabel = (p) =>
    p.role === 'invoice'
      ? '票据页'
      : `明细${p.page_no ? ` 第${p.page_no}页` : ''}${p.page_count ? `/${p.page_count}` : ''}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 backdrop-blur-sm">
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="发票详情"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-800">
              {live.doc_kind === 'settlement' ? '医保结算单' : '发票'} · {live.invoice_no || '无票号'}
              {detailCount > 0 && <span className="ml-2 text-[11px] font-normal text-slate-500">含 {detailCount} 页明细</span>}
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {live.issued_at || '无开票日期'} · {fmtMoney(live.amount_total)} 元
              {live.hospital ? ` · ${live.hospital}` : ''}
              {live.hospital_suspect ? '（OCR 可能不准，请核对）' : ''}
              {pages.length > 1 ? ` · 共 ${pages.length} 页` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="small"
              onClick={async () => {
                const r = await downloadInvoice(live)
                onNotify && onNotify(r.ok ? (r.count > 1 ? `已导出 ${r.count} 页原件` : '已开始下载原件') : r.reason || '下载失败')
              }}
            >
              {pages.length > 1 ? `下载全部 ${pages.length} 页` : '下载原件'}
            </Button>
            <Button
              size="small"
              danger
              onClick={() => {
                deleteInvoice(live.id)
                onClose && onClose()
                onNotify && onNotify('发票已删除（含全部页原件）')
              }}
            >
              删除
            </Button>
            <CloseButton onClick={requestClose} testId="invoice-detail-close" />
          </div>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-0 overflow-auto md:grid-cols-2">
          {/* 原件预览：页签 + 当前页 */}
          <div className="border-b border-slate-200 bg-slate-50 p-3 md:border-b-0 md:border-r">
            {pages.length > 1 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {pages.map((p) => {
                  const on = current && p.file && p.file.id === current.file.id
                  return (
                    <button
                      key={p.file.id}
                      type="button"
                      onClick={() => setActive(p.file.id)}
                      className={`rounded border px-2 py-0.5 text-[11px] ${
                        on ? 'border-brand-300 bg-white text-brand-700' : 'border-slate-200 bg-white/60 text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      {pageLabel(p)}
                    </button>
                  )
                })}
              </div>
            )}
            {loading && <div className="py-10 text-center text-xs text-slate-400">正在读取原件…</div>}
            {!loading && !pageUrl && (
              <div className="py-10 text-center text-xs text-slate-400">
                {live.has_file ? '原件不在本机且数据源未取到（可在导入时重新保存）' : '无原件（手动录入）'}
              </div>
            )}
            {!loading && pageUrl && isPdfPage(current) && (
              <iframe title="发票原件" src={pageUrl} className="h-[62vh] w-full rounded-lg border border-slate-200 bg-white" />
            )}
            {!loading && pageUrl && !isPdfPage(current) && (
              <img src={pageUrl} alt="发票原件" className="max-h-[62vh] w-full rounded-lg border border-slate-200 bg-white object-contain" />
            )}
            {!loading && pageUrl && (
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
                <span className="truncate">{current && current.file && current.file.name}</span>
                <button
                  type="button"
                  className="ml-auto shrink-0 text-slate-600 hover:underline"
                  onClick={async () => {
                    const r = await downloadInvoicePage(live, current)
                    onNotify && onNotify(r.ok ? '已开始下载本页' : r.reason || '下载失败')
                  }}
                >
                  下载本页
                </button>
              </div>
            )}
          </div>

          {/* 字段与对账 */}
          <div className="p-3">
            {rec && rec.state !== 'no-invoice' && (
              <div
                className={`mb-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${
                  rec.state === 'over' || rec.state === 'residual'
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                }`}
              >
                <div className="font-medium">与住院段对账</div>
                <div className="mt-0.5">
                  住院实掏 {fmtMoney(rec.system)} · 票面 {fmtMoney(rec.total)}
                  {rec.insurance != null ? ` · 统筹 ${fmtMoney(rec.insurance)}` : ''}
                  {rec.state === 'over' && ' · 实掏大于票面（请核对）'}
                  {rec.state === 'residual' && ` · 残差 ${fmtMoney(rec.residual)}`}
                  {rec.state === 'derived' && rec.derivedInsurance != null && ` · 推定报销 ${fmtMoney(rec.derivedInsurance)}`}
                  {rec.state === 'closed' && ' · 三数闭合'}
                </div>
              </div>
            )}
            <InvoiceFields value={draft} onChange={(p) => { setDraft((d) => ({ ...d, ...p })); setDirty(true) }} stays={stays} compact />

            {/* 明细页管理 */}
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-500">原件页（{pages.length}）</span>
                <Button size="small" type="text" loading={adding} onClick={() => fileInputRef.current && fileInputRef.current.click()}>
                  + 添加明细页
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="application/pdf,image/*"
                className="hidden"
                onChange={(e) => {
                  addPages(e.target.files)
                  e.target.value = ''
                }}
              />
              <div className="space-y-1">
                {pages.map((p) => (
                  <div key={p.file.id} className="flex items-center gap-2 text-[11px] text-slate-600">
                    <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5">{pageLabel(p)}</span>
                    <span className="min-w-0 truncate">{p.file.name || p.file.id}</span>
                    {p.role === 'detail' ? (
                      <button type="button" className="ml-auto shrink-0 text-slate-400 hover:text-amber-600" onClick={() => removePage(p)}>
                        移出
                      </button>
                    ) : (
                      <span className="ml-auto shrink-0 text-slate-300">主件</span>
                    )}
                  </div>
                ))}
                {!pages.length && <div className="text-[11px] text-slate-400">无原件</div>}
              </div>
              {live.detail_note && <div className="mt-1 text-[11px] text-amber-600">{live.detail_note}</div>}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Button type="primary" size="small" onClick={save} disabled={!dirty}>
                保存修改
              </Button>
              {dirty && <span className="text-[11px] text-amber-600">有未保存的修改</span>}
              {live.dup_of && <Tag color="orange">重复件（原件：{live.dup_of}）</Tag>}
            </div>
          </div>
        </div>
      </div>

      {/* 未保存改动确认（应用内浮层，非浏览器 confirm）：Esc 只会关这一层 */}
      {confirmClose && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-900/40" onClick={() => setConfirmClose(false)}>
          <EscClose onClose={() => setConfirmClose(false)} />
          <div
            className="w-80 rounded-lg border border-slate-200 bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="放弃未保存的修改"
          >
            <p className="text-sm font-medium text-slate-800">放弃未保存的修改？</p>
            <p className="mt-1.5 text-xs text-slate-500">票面字段改动还没保存，关闭后这些改动会丢失。</p>
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn-ghost text-xs" onClick={() => setConfirmClose(false)}>
                继续编辑
              </button>
              <button
                className="text-xs px-3 py-1 rounded bg-red-500 text-white hover:bg-red-600"
                onClick={() => {
                  setConfirmClose(false)
                  onClose && onClose()
                }}
              >
                放弃并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
