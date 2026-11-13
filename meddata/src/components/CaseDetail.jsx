// ===================== 病历文书详情（出院记录 / 诊断证明等） =====================
// 左：原件预览 / 下载；右：结构化字段卡片 + 所见 / 结论（保留可检索内容）+ 全文 + 删除。

import { useEffect, useState, useMemo } from 'react'
import { Modal, Tag, Button, Collapse, App } from 'antd'
import { getDocFile, getDocText, blobToUrl } from '../utils/docFileStore.js'
import { extractCaseFields, sanitizeCaseFields } from '../utils/parseDoc.js'
import { updateDoc } from '../data/store.js'
import { reRecognizeDoc } from '../utils/reRecognize.js'
import ReviewSuggestions from './ReviewSuggestions.jsx'
import ReRecognizeDocModal from './ReRecognizeDocModal.jsx'
import DocAiRereadModal from './DocAiRereadModal.jsx'
import CloudConsentModal, { hasCloudConsent } from './CloudConsentModal.jsx'
import { useDocAiReread } from '../utils/useDocAiReread.js'
import { getConfig, getStatus } from '../utils/apiStore.js'
import { assetStatusOf } from '../utils/assetStatus.js'
import { attachDocFile } from '../utils/assetAttach.js'
import AssetFallback from './AssetFallback.jsx'

const KIND_COLOR = {
  discharge: 'blue',
  cert: 'gold',
  other: 'default',
}

const CASE_FIELD_LABEL = {
  discharge_date: '出院日期',
  admission_date: '入院日期',
  hospital_days: '住院天数',
  discharge_diagnosis: '出院诊断',
  discharge_advice: '出院医嘱',
  discharge_meds: '出院用药',
  diagnosis: '诊断',
  rest_days: '建议休息天数',
  department: '科室',
  doctor: '医师',
}

export default function CaseDetail({ doc, onClose, onDelete }) {
  const { modal } = App.useApp()
  const [blobUrl, setBlobUrl] = useState(null)
  // 原件 MIME：图片与 PDF 的预览方式不同（img 等比适配窗 vs iframe 由 PDF 查看器自适应）
  const [blobType, setBlobType] = useState('')
  const [loading, setLoading] = useState(true)
  const [probed, setProbed] = useState(false) // 原件是否已探测完（决定能否下"未找到"的结论）
  const [reloadTick, setReloadTick] = useState(0)
  const [fullText, setFullText] = useState('')
  const [previewOpen, setPreviewOpen] = useState(true)
  const [previewZoom, setPreviewZoom] = useState(1)
  const [recoResult, setRecoResult] = useState(null)
  const [recoLoading, setRecoLoading] = useState(false)
  const zoomStep = (d) => setPreviewZoom((z) => Math.min(3, Math.max(0.3, +(z + d).toFixed(2))))

  // 老数据（升级前）可能无 fields：按 kind 从所见 / 结论懒抽取，保证结构化模板不空白。
  const fields = useMemo(() => {
    // 老数据可能含修复前的脏日期值（"undefined-undefined-undefined"），必须先清理再展示
    if (doc.fields && Object.keys(doc.fields).length) return sanitizeCaseFields(doc.fields)
    if (['discharge', 'cert'].includes(doc.kind)) {
      return extractCaseFields(`${(doc.findings || '').replace(/\n/g, ' ')} ${(doc.conclusion || '').replace(/\n/g, ' ')}`, doc.kind)
    }
    return doc.fields || {}
  }, [doc])

  // 用最新算法对原件重跑解析 → 「旧 vs 新」对比，确认后才写入（绝不自动覆盖）
  const startReRecognize = async () => {
    setRecoLoading(true)
    try {
      const res = await reRecognizeDoc(doc)
      if (res.skipped === 'no-image') {
        modal.info({ title: '无法重新识别', content: '该文书未保留原件，无法用新算法重跑。' })
        return
      }
      if (res.skipped === 'error') {
        modal.error({ title: '重新识别失败', content: res.error || '未知错误' })
        return
      }
      // 始终打开对比弹窗：即便内容/类型与现有一致，也要让用户看到「重新识别已重跑」的结果
      // （出院日期、出院诊断、出院医嘱、出院用药等逐字段展示，无差异则显示「无变化」）。
      // 否则无差异时直接弹「未发现差异」并关闭，会让用户误以为重新识别没生效。
      setRecoResult(res)
    } catch (e) {
      console.error('重新识别失败', e)
      modal.error({ title: '重新识别失败', content: String((e && e.message) || e) })
    } finally {
      setRecoLoading(false)
    }
  }

  const fileId = doc.file && doc.file.id

  // ---- AI 重读（与检查报告同一条链路）：本地 Tesseract 对表单类文书（诊断证明书）天然吃力，
  // 走 AI 读原件后逐字段勾选采用，绝不自动覆盖。（2026-10-20 用户报障：证明书重识别只有日期对）
  const [aiOpen, setAiOpen] = useState(false)
  const [consentAsk, setConsentAsk] = useState(null)
  const ai = useDocAiReread({ doc, fileId })
  // 顺序：先过隐私同意门，再开弹窗（否则重读弹窗 z-1100 会压住同意框 z-70，按钮点不到）
  const startAiReread = () => {
    if (!hasCloudConsent('ai')) {
      setConsentAsk('ai')
      return
    }
    setAiOpen(true)
    // 先捡上次已跑完但没应用的结果，捡不到才真跑（读图数十秒到数分钟，别让用户重复付费）
    void ai.recover().then((hit) => {
      if (!hit) void ai.run()
    })
  }

  useEffect(() => {
    let alive = true
    if (doc.has_text && !doc.raw_text) {
      getDocText(doc.id).then((t) => { if (alive) setFullText(t) })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.has_text])

  useEffect(() => {
    let url = null
    let alive = true
    setLoading(true)
    setProbed(false)
    setBlobUrl(null)
    setBlobType('')
    ;(async () => {
      try {
        const blob = await getDocFile(fileId)
        if (!alive) return
        if (blob) {
          url = blobToUrl(blob)
          setBlobUrl(url)
          setBlobType(blob.type || (doc.file && doc.file.mime) || '')
        }
      } catch (e) {
        console.error('原件读取失败', e)
      } finally {
        if (alive) {
          setProbed(true)
          setLoading(false)
        }
      }
    })()
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, reloadTick])

  const download = () => {
    if (!blobUrl) return
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = doc.file ? doc.file.name : `${doc.date}_${doc.doc_type}.pdf`
    a.click()
  }

  // 原件三态（唯一口径见 utils/assetStatus.js）：探测结束才允许判「未找到」；
  // 数据源离线时只说"暂不可读"，避免把"连不上"渲染成"丢了"。
  const assetStatus = assetStatusOf(doc, {
    noun: '原件',
    manualLabel: '手动录入',
    hasBlob: probed ? !!blobUrl : null,
    online: getStatus().online,
    syncEnabled: getConfig().enabled,
  })
  const attach = async (file) => {
    try {
      await attachDocFile(doc, file)
      setReloadTick((n) => n + 1)
    } catch (e) {
      modal.error({ title: '补传原件失败', content: String((e && e.message) || e) })
    }
  }

  const fmtSize = (bytes) =>
    bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB'

  const fieldEntries = Object.entries(fields).filter(([, v]) => v != null && v !== '')

  // AI 复查建议落地：与 DocDetail 完全同口径（病历文书同样是 findings / conclusion 文本字段），
  // 只覆盖用户勾选的 ref 字段 —— 人在回路，AI 不直接改数据。
  const applyCaseSuggestions = (suggestions) => {
    const patch = {}
    for (const s of suggestions) {
      if (s.kind === 'fix' && (s.ref === 'findings' || s.ref === 'conclusion')) patch[s.ref] = s.suggested
    }
    if (Object.keys(patch).length) updateDoc(doc.id, patch)
  }

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width="96%"
      style={{ maxWidth: 1280, top: 20 }}
      title={
        <div className="flex items-center gap-3">
          <Tag color={KIND_COLOR[doc.kind] || KIND_COLOR.other}>{doc.doc_type || (doc.kind === 'cert' ? '诊断证明' : '出院记录')}</Tag>
          <span className="text-base font-semibold text-slate-800">{doc.title || '病历文书'}</span>
        </div>
      }
      styles={{ body: { padding: 0 } }}
    >
      <div className="overflow-hidden grid max-h-[80vh]" style={{ gridTemplateColumns: previewOpen ? 'minmax(420px, 1.35fr) 1fr' : '56px 1fr' }}>
        {previewOpen ? (
          // 高度取确定的 80vh（与 grid 同口径）：只给 max-h 时，右栏内容短会把预览栏压成邮票；
          // 不给上限时内容撑高又被外层 overflow-hidden 切掉底部。
          <div className="bg-slate-100 p-4 flex flex-col h-[80vh]">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-slate-500">原件预览</p>
                <div className="flex items-center gap-1 text-slate-500">
                  <Button size="small" className="!px-1.5" onClick={() => zoomStep(-0.1)} disabled={previewZoom <= 0.3} title="缩小">－</Button>
                  <span className="text-[11px] tabular-nums w-9 text-center">{Math.round(previewZoom * 100)}%</span>
                  <Button size="small" className="!px-1.5" onClick={() => zoomStep(0.1)} disabled={previewZoom >= 3} title="放大">＋</Button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="small"
                  data-testid="case-ai-reread"
                  onClick={startAiReread}
                  disabled={ai.running || !fileId || (probed && !blobUrl)}
                  title={
                    !fileId
                      ? '无原件，无法 AI 重读'
                      : probed && !blobUrl
                        ? `${assetStatus.text}，无法读图（可先补传原件）`
                        : '让 AI 读原件，与现有字段逐项对比后由你勾选采用'
                  }
                >
                  {ai.running ? `AI 重读 ${Math.round(ai.ms / 1000)}s` : 'AI 重读'}
                </Button>
                <Button
                  size="small"
                  onClick={startReRecognize}
                  disabled={recoLoading || !fileId || (probed && !blobUrl)}
                  title={
                    probed && !blobUrl
                      ? `${assetStatus.text}，无法重新识别（可先补传原件）`
                      : '用最新算法（本地 OCR）重跑原件解析并对比'
                  }
                >
                  {recoLoading ? '识别中…' : '重新识别'}
                </Button>
                <Button size="small" onClick={download} disabled={!blobUrl}>下载原件</Button>
                <Button size="small" onClick={() => setPreviewOpen(false)} title="收起预览">收起</Button>
              </div>
            </div>
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-xs text-slate-400">原件读取中…</div>
            ) : blobUrl ? (
              // 100% 时整页放进预览窗、不留内层滚动条：
              // · 图片原件 → <img> 等比适配（iframe 会把原图按原始像素铺开，自己多出一条滚动条）；
              // · PDF 原件 → iframe（Chrome 的 PDF 查看器自适应窗口），外框按 210/297 取窗内最大尺寸。
              // 只有放大到 >100% 才由这张卡片滚动：图片用 transform（父级 max-* 会让 CSS zoom 失效），PDF 用 zoom。
              /^image\//.test(blobType) ? (
                <div className="card flex-1 min-h-0 overflow-auto p-2 flex items-center justify-center">
                  <img
                    src={blobUrl}
                    alt="原件预览"
                    style={{
                      display: 'block',
                      maxWidth: '100%',
                      maxHeight: '100%',
                      objectFit: 'contain',
                      transform: `scale(${previewZoom})`,
                      transformOrigin: '0 0',
                    }}
                  />
                </div>
              ) : (
                <div className="card flex-1 min-h-0 overflow-auto p-2" style={{ containerType: 'size' }}>
                  <div
                    style={{
                      width: 'min(100cqw, calc(100cqh * 210 / 297))',
                      height: 'min(100cqh, calc(100cqw * 297 / 210))',
                      margin: '0 auto',
                    }}
                  >
                    <iframe title="原件预览" src={blobUrl} style={{ zoom: previewZoom, width: '100%', height: '100%', border: 0, display: 'block' }} />
                  </div>
                </div>
              )
            ) : (
              <AssetFallback
                status={assetStatus}
                noun="原件"
                onAttach={attach}
                onRetry={() => setReloadTick((n) => n + 1)}
              />
            )}
          </div>
        ) : (
          <div className="bg-slate-100 flex flex-col items-center gap-2 py-3">
            <Button size="small" className="!px-1" onClick={() => setPreviewOpen(true)} title="展开预览">预览</Button>
            <Button size="small" className="!px-1" onClick={download} disabled={!blobUrl} title="下载原件">下载</Button>
          </div>
        )}

        {/* 右：结构化字段 + 检索内容 */}
        {/* 高度自管滚动：外层 grid 是 overflow-hidden + 80vh，右栏若不封顶会把整行撑高、底部内容不可达 */}
        <div className="p-5 overflow-y-auto space-y-4 max-h-[80vh]">
          <p className="text-xs text-slate-400">
            {doc.kind === 'cert' ? '开具' : '出院'} {doc.date}
            {doc.time ? ' ' + doc.time : ''}
            {doc.file ? ` · 原件 ${doc.file.name}（${fmtSize(doc.file.size)}）` : ''}
          </p>

          {fieldEntries.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 mb-2">结构化字段</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {fieldEntries.map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                    <div className="text-[11px] text-slate-400">{CASE_FIELD_LABEL[k] || k}</div>
                    <div className="text-sm text-slate-800 font-medium leading-snug whitespace-pre-wrap">{v}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {doc.findings && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 mb-1.5">所见 / 描述</h3>
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{doc.findings}</p>
            </section>
          )}
          {doc.conclusion && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 mb-1.5">结论</h3>
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{doc.conclusion}</p>
            </section>
          )}
          {doc.notes && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 mb-1.5">备注</h3>
              <p className="text-sm text-slate-700">{doc.notes}</p>
            </section>
          )}

          <ReviewSuggestions target="case" id={doc.id} onApply={applyCaseSuggestions} />

          {(doc.raw_text || fullText) && (
            <Collapse
              size="small"
              items={[
                {
                  key: 'full',
                  label: `提取全文（${(doc.raw_text || fullText).length} 字）`,
                  children: (
                    <pre className="text-xs text-slate-600 whitespace-pre-wrap max-h-56 overflow-auto">{doc.raw_text || fullText}</pre>
                  ),
                },
              ]}
            />
          )}

          <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
            <span className="text-[11px] text-slate-300">
              {doc.is_scanned ? '扫描件（无文字层）' : '文本层已提取'}
              {doc.created_at ? ` · ${new Date(doc.created_at).toLocaleDateString()} 归档` : ''}
            </span>
            {onDelete && (
              <Button
                danger
                type="link"
                size="small"
                onClick={() =>
                  modal.confirm({
                    title: '删除文书',
                    content: '删除该文书（含原件）？此操作不可恢复。',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => onDelete(doc.id),
                  })
                }
              >
                删除文书
              </Button>
            )}
          </div>
        </div>
      </div>

      {recoResult && (
        <ReRecognizeDocModal
          doc={doc}
          result={recoResult}
          docLabel={doc.kind === 'cert' ? '诊断证明' : '出院记录'}
          onClose={() => setRecoResult(null)}
          onApplied={() => setRecoResult(null)}
        />
      )}

      {aiOpen && (
        <DocAiRereadModal
          variant="case"
          doc={doc}
          result={ai.res}
          running={ai.running}
          elapsedMs={ai.ms}
          error={ai.err}
          aiMode={ai.mode}
          fromCache={ai.fromCache}
          cacheNote={ai.cacheNote}
          onRerun={() => void ai.run()}
          onLoadPending={ai.loadPending}
          loadingPending={ai.loadingPending}
          onClose={() => setAiOpen(false)}
          onApplied={() => {
            ai.markApplied()
            setAiOpen(false)
          }}
        />
      )}

      {consentAsk && (
        <CloudConsentModal
          engine={consentAsk}
          onClose={() => setConsentAsk(null)}
          onOk={() => {
            setConsentAsk(null)
            setAiOpen(true)
            void ai.run()
          }}
        />
      )}
    </Modal>
  )
}
