// ===================== 报告归档详情 =====================
// 展示解析索引（类型/日期/所见/结论/测量值）+ 原件预览与下载。

import { useEffect, useCallback, useState } from 'react'
import { Modal, Tag, Button, Table, Collapse, App, Input, Select } from 'antd'
import { getDocFile, getDocText, blobToUrl } from '../utils/docFileStore.js'
import { reRecognizeDoc } from '../utils/reRecognize.js'
import { updateDoc } from '../data/store.js'
import ReviewSuggestions from './ReviewSuggestions.jsx'
import ReRecognizeDocModal from './ReRecognizeDocModal.jsx'
import DocAiRereadModal from './DocAiRereadModal.jsx'
import { dateAnomaly } from '../utils/docAi.js'
import CloudConsentModal, { hasCloudConsent } from './CloudConsentModal.jsx'
import { useDocAiReread } from '../utils/useDocAiReread.js'
import { getConfig, getStatus } from '../utils/apiStore.js'
import { assetStatusOf } from '../utils/assetStatus.js'
import { attachDocFile } from '../utils/assetAttach.js'
import AssetFallback from './AssetFallback.jsx'

const KIND_COLOR = {
  ecg: 'red',
  ultrasound: 'cyan',
  ct: 'purple',
  mri: 'geekblue',
  xray: 'orange',
  endoscopy: '#0d9488',
  genetic: 'green',
  flow: 'magenta',
  bonemarrow: 'volcano',
  discharge: 'blue',
  cert: 'gold',
  other: 'default',
}

// 空字段说明：原因是"原件本来没有这一段"或"识别没覆盖到"，两者都不是数据丢失 → 文案要区分于报错
const EMPTY_HINT = '（原件可能没有这一段，可用「AI 重读」重跑识别）'

export default function DocDetail({ doc, onClose, onDelete, onEdit }) {
  const { modal } = App.useApp()
  const [blobUrl, setBlobUrl] = useState(null)
  // 原件 MIME：图片与 PDF 的预览方式不同（img 等比适配窗 vs iframe 由 PDF 查看器自适应）
  const [blobType, setBlobType] = useState('')
  const [loading, setLoading] = useState(true)
  const [probed, setProbed] = useState(false) // 原件是否已探测完（决定能否下"未找到"的结论）
  const [reloadTick, setReloadTick] = useState(0)
  const [fullText, setFullText] = useState('')
  const [recoResult, setRecoResult] = useState(null)
  const [recoLoading, setRecoLoading] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(true)
  // 编辑归档字段（标题 / 报告类型 / 日期时间 / 所见 / 结论 / 备注）。
  // 为什么必须有：标题常是 AI 从表头堆出来的（如「北京市医疗机构临床检验结果报告单 首医…血液科报告」），
  // 日期也可能读错，而此前详情页没有任何编辑入口（DocDetail 有 onEdit 形参，但 App 从来没传 → 按钮不出现）。
  const [editOpen, setEditOpen] = useState(false)
  const [editForm, setEditForm] = useState(null)
  const [previewZoom, setPreviewZoom] = useState(1)
  const zoomStep = (d) => setPreviewZoom((z) => Math.min(3, Math.max(0.3, +(z + d).toFixed(2))))

  // 用最新算法对原件重跑解析，弹出「旧 vs 新」对比，由用户确认后才写入（绝不自动覆盖）
  const startReRecognize = async () => {
    setRecoLoading(true)
    try {
      const res = await reRecognizeDoc(doc)
      if (res.skipped === 'no-image') {
        modal.info({
          title: '无法重新识别',
          content: '该归档未保留原件（file.id 缺失），无法用新算法重跑。',
        })
        return
      }
      if (res.skipped === 'error') {
        modal.error({ title: '重新识别失败', content: res.error || '未知错误' })
        return
      }
      // 始终打开对比弹窗：即便内容/类型与现有一致，也要让用户看到「重新识别已重跑」的结果
      // （报告类型、所见/结论等逐字段展示，无差异则显示「无变化」）。否则无差异时直接弹
      // 「未发现差异」并关闭，会让用户误以为重新识别没生效——正是当初「类型识别不出来」的症状。
      setRecoResult(res)
    } catch (e) {
      console.error('重新识别失败', e)
      modal.error({ title: '重新识别失败', content: String((e && e.message) || e) })
    } finally {
      setRecoLoading(false)
    }
  }

  // AI 重读状态机（取原件 → 提交 → 轮询）统一在 useDocAiReread（与病历文书共用同一链路）
  const [aiOpen, setAiOpen] = useState(false)
  const [consentAsk, setConsentAsk] = useState(null)

  const fileId = doc.file && doc.file.id
  const ai = useDocAiReread({ doc, fileId })

  // 顺序很重要：先把同意门过了再开重读弹窗。反过来会出「重读弹窗(z-1100) 压住同意框(z-70)」
  // 的可点性 Bug——用户看得见按钮却点不到（2026-10-18 e2e 抓到）。
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

  // 提取全文（raw_text）已迁至 IndexedDB，按 doc.id 懒加载
  useEffect(() => {
    let alive = true
    if (doc.has_text && !doc.raw_text) {
      getDocText(doc.id).then((t) => {
        if (alive) setFullText(t)
      })
    }
    return () => {
      alive = false
    }
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

  // 应用 AI 复查建议（检查报告）：按字段（findings/conclusion）替换文本，用户确认才改
  const applyDocSuggestions = useCallback((suggestions) => {
    const patch = {}
    for (const s of suggestions) {
      if (s.kind === 'fix' && (s.ref === 'findings' || s.ref === 'conclusion')) {
        patch[s.ref] = s.suggested
      }
    }
    if (Object.keys(patch).length) updateDoc(doc.id, patch)
  }, [doc.id])

  const fmtSize = (bytes) =>
    bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB'

  const measureColumns = [
    { title: '项目', dataIndex: 'name', key: 'name' },
    { title: '数值', dataIndex: 'value', key: 'value', align: 'right', render: (v) => <b>{v}</b> },
    { title: '单位', dataIndex: 'unit', key: 'unit', width: 56, align: 'right', render: (v) => <span className="text-slate-400">{v}</span> },
  ]

  return (
    <>
      <Modal
        open
      onCancel={onClose}
      footer={null}
      width="96%"
      style={{ maxWidth: 1280, top: 20 }}
      title={
        <div className="flex items-center gap-3">
          <Tag color={KIND_COLOR[doc.kind] || KIND_COLOR.other}>{doc.doc_type || doc.kind}</Tag>
          <span className="text-base font-semibold text-slate-800">{doc.title || '报告'}</span>
          {dateAnomaly(doc) && (
            <span className="text-[11px] px-2 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800" title={dateAnomaly(doc)}>
              时间可疑
            </span>
          )}
        </div>
      }
      styles={{ body: { padding: 0 } }}
    >
      <div
        className="overflow-hidden grid max-h-[80vh]"
        style={{ gridTemplateColumns: previewOpen ? 'minmax(420px, 1.35fr) 1fr' : '56px 1fr' }}
      >
        {previewOpen ? (
          // 左栏高度必须**确定**且与 grid 的 80vh 同口径，两个坑一次解决：
          // ① 用 max-h 时装不下时外层 overflow-hidden 会把底部切掉（内容撑到 ~1000px）；
          // ② 只给 max-h 时若右栏内容很短，这一栏会缩到内容高（~300px），预览被压成邮票。
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
                <Button size="small" onClick={download} disabled={!blobUrl} title={blobUrl ? '' : assetStatus.text || '无原件可下载'}>
                  下载原件
                </Button>
                <Button
                  size="small"
                  data-testid="doc-edit"
                  onClick={() =>
                    onEdit
                      ? onEdit()
                      : (setEditForm({
                          title: doc.title || '',
                          doc_type: doc.doc_type || '',
                          part: doc.part || '',
                          date: doc.date || '',
                          time: doc.time || '',
                          reported_at: doc.reported_at || '',
                          findings: doc.findings || '',
                          conclusion: doc.conclusion || '',
                          notes: doc.notes || '',
                        }),
                        setEditOpen(true))
                  }
                >
                  编辑
                </Button>
                <Button
                  size="small"
                  data-testid="doc-ai-reread"
                  onClick={startAiReread}
                  disabled={ai.running || !fileId || (probed && !blobUrl)}
                  title={
                    !fileId
                      ? '无原件，无法 AI 重读'
                      : probed && !blobUrl
                        ? `${assetStatus.text}，无法读图（可先补传原件）`
                        : '让 AI 读原件，与现有记录逐字段对比后由你勾选采用'
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
                      : '用最新算法重跑原件解析并对比'
                  }
                >
                  {recoLoading ? '识别中…' : '重新识别'}
                </Button>
                <Button size="small" onClick={() => setPreviewOpen(false)} title="收起预览">
                  收起
                </Button>
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
            <Button size="small" className="!px-1" onClick={() => setPreviewOpen(true)} title="展开预览">
              预览
            </Button>
            <Button size="small" className="!px-1" onClick={download} disabled={!blobUrl} title="下载原件">
              下载
            </Button>
          </div>
        )}

        {/* 右：解析索引 */}
        <div className="p-5 overflow-y-auto space-y-4 max-h-[80vh]">
          <p className="text-xs text-slate-400">
            检查 {doc.date}
            {doc.time ? ' ' + doc.time : ''}
            {doc.reported_at && doc.reported_at.slice(0, 10) !== doc.date ? ` · 报告 ${doc.reported_at}` : ''}
            {doc.file ? ` · 原件 ${doc.file.name}（${fmtSize(doc.file.size)}）` : ''}
          </p>
          {doc.kind === 'ecg' && doc.measures && doc.measures.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 mb-2">心电图关键指标</h3>
              <div className="grid grid-cols-2 gap-2">
                {doc.measures.map((m, i) => (
                  <div
                    key={i}
                    className={`rounded-lg border px-3 py-2 ${
                      m.flag ? 'border-rose-200 bg-rose-50' : 'border-slate-100 bg-slate-50'
                    }`}
                  >
                    <div className="text-[11px] text-slate-400">{m.name}</div>
                    <div className={`text-base font-semibold leading-tight ${m.flag ? 'text-rose-600' : 'text-slate-800'}`}>
                      {m.value}
                      <span className="text-xs font-normal text-slate-400 ml-0.5">{m.unit}</span>
                      {m.flag && <span className="text-rose-500 ml-1">{m.flag}</span>}
                    </div>
                    {m.ref && <div className="text-[10px] text-slate-400 mt-0.5">参考 {m.ref}</div>}
                  </div>
                ))}
              </div>
            </section>
          )}
          {/* 空字段要写清"为什么空"，不能留一个 —：用户会以为数据丢了（2026-10-30 口径） */}
          <section>
            <h3 className="text-xs font-semibold text-slate-500 mb-1.5">检查所见</h3>
            {doc.findings ? (
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{doc.findings}</p>
            ) : (
              <p className="text-sm text-slate-400">
                未识别到{EMPTY_HINT}
              </p>
            )}
          </section>
          <section className={doc.kind === 'ecg' ? 'rounded-lg bg-amber-50 border border-amber-200 px-3 py-2' : ''}>
            <h3 className="text-xs font-semibold text-slate-500 mb-1.5">诊断结论</h3>
            {doc.conclusion ? (
              <p className={`text-sm text-slate-700 leading-relaxed whitespace-pre-wrap ${doc.kind === 'ecg' ? 'font-medium' : ''}`}>
                {doc.conclusion}
              </p>
            ) : (
              <p className="text-sm text-slate-400">未识别到{EMPTY_HINT}</p>
            )}
          </section>
          {/* AI 复查建议：归档后 agent 产出，用户确认才改（检查报告仅此一功能） */}
          <ReviewSuggestions target="doc" id={doc.id} onApply={applyDocSuggestions} />
          {doc.kind !== 'ecg' && doc.measures && doc.measures.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 mb-1.5">关键测量值</h3>
              <Table
                dataSource={doc.measures}
                columns={measureColumns}
                pagination={false}
                size="small"
                rowKey={(m, i) => i}
              />
            </section>
          )}
          {doc.notes && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 mb-1.5">备注</h3>
              <p className="text-sm text-slate-700">{doc.notes}</p>
            </section>
          )}
          {(doc.raw_text || fullText) && (
            <Collapse
              size="small"
              items={[
                {
                  key: 'full',
                  label: `提取全文（${(doc.raw_text || fullText).length} 字）`,
                  children: (
                    <pre className="text-xs text-slate-600 whitespace-pre-wrap max-h-56 overflow-auto">
                      {doc.raw_text || fullText}
                    </pre>
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
                    title: '删除归档',
                    content: '删除该归档（含原件）？此操作不可恢复。',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => onDelete(doc.id),
                  })
                }
              >
                删除归档
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
    {recoResult && (
      <ReRecognizeDocModal
        doc={doc}
        result={recoResult}
        onClose={() => setRecoResult(null)}
        onApplied={() => setRecoResult(null)}
      />
    )}
      {aiOpen && (
        <DocAiRereadModal
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
          onApplied={(keys) => {
            ai.markApplied()
            modal.success({ title: '已应用 AI 重读结果', content: `更新字段：${keys.filter((k) => k !== 'ai').join(' / ')}` })
            // 弹层里持有的是「点开那一刻」的记录快照，写入后不会自动刷新 —— 直接关闭，
            // 让用户回到列表看到最新值（否则会出现「刚应用完，详情还是旧值」的错觉）。
            onClose && onClose()
          }}
        />
      )}
      {consentAsk && (
        <CloudConsentModal
          engine={consentAsk}
          onClose={() => setConsentAsk(null)}
          onOk={() => {
            setConsentAsk(null)
            setAiOpen(true) // 同意后才开弹窗（顺序见 startAiReread 注释）
            void ai.run()
          }}
        />
      )}

      {/* 编辑归档字段（人工核对就是权威：这里改什么就是什么，不再被 AI 覆盖） */}
      <Modal
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        width={720}
        title="编辑报告"
        okText="保存"
        cancelText="取消"
        onOk={() => {
          if (!editForm) return
          const patch = {
            title: editForm.title.trim(),
            doc_type: editForm.doc_type.trim(),
            part: editForm.part.trim(),
            date: editForm.date.trim(),
            time: editForm.time.trim(),
            reported_at: editForm.reported_at.trim(),
            findings: editForm.findings,
            conclusion: editForm.conclusion,
            notes: editForm.notes,
          }
          if (!patch.date) {
            modal.error({ title: '检查日期不能为空', content: '归档记录的检查日期是查重与趋势的锚点，请填写 YYYY-MM-DD。' })
            return
          }
          updateDoc(doc.id, patch)
          setEditOpen(false)
          modal.success({ title: '已更新', content: '改动立即生效并参与查重（同一原件再导入会被拦）。' })
        }}
      >
        {editForm && (
          <div className="space-y-3 text-sm">
            <div>
              <label className="label">标题</label>
              <Input
                data-testid="doc-edit-title"
                value={editForm.title}
                maxLength={120}
                placeholder="如：流式免疫分型（骨髓 MRD）"
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              />
              <p className="text-[11px] text-slate-400 mt-1">原值常是 AI 从报告表头堆出来的，改成你自己认得出的名字即可。</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">报告类型</label>
                <Input
                  value={editForm.doc_type}
                  onChange={(e) => setEditForm({ ...editForm, doc_type: e.target.value })}
                  placeholder="如：流式免疫分型"
                />
              </div>
              <div>
                <label className="label">检查部位</label>
                <Input value={editForm.part} onChange={(e) => setEditForm({ ...editForm, part: e.target.value })} placeholder="如：骨髓" />
              </div>
              <div>
                <label className="label">检查日期</label>
                <Input value={editForm.date} onChange={(e) => setEditForm({ ...editForm, date: e.target.value })} placeholder="YYYY-MM-DD" />
              </div>
              <div>
                <label className="label">检查时间</label>
                <Input value={editForm.time} onChange={(e) => setEditForm({ ...editForm, time: e.target.value })} placeholder="HH:mm" />
              </div>
              <div>
                <label className="label">报告时间</label>
                <Input
                  value={editForm.reported_at}
                  onChange={(e) => setEditForm({ ...editForm, reported_at: e.target.value })}
                  placeholder="YYYY-MM-DD HH:mm"
                />
              </div>
            </div>
            <div>
              <label className="label">检查所见</label>
              <Input.TextArea rows={5} value={editForm.findings} onChange={(e) => setEditForm({ ...editForm, findings: e.target.value })} />
            </div>
            <div>
              <label className="label">诊断结论</label>
              <Input.TextArea rows={3} value={editForm.conclusion} onChange={(e) => setEditForm({ ...editForm, conclusion: e.target.value })} />
            </div>
            <div>
              <label className="label">备注</label>
              <Input.TextArea rows={2} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
            </div>
          </div>
        )}
      </Modal>
    </>
    )
    }
