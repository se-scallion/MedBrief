// ===================== 检查报告 / 病历文书「重新识别」对比弹窗 =====================
// 用最新算法重跑原件解析后，把「旧识别 vs 新识别」逐字段对比展示：
//   - 顶部日期行：旧日期 ↔ 新识别日期，差异时可「采用新日期」（需显式点选，确认时才写入）
//   - 文本/结构化字段（出院诊断/出院医嘱/出院用药/所见/结论/标题…）逐项可勾「采用新值」
//   - 底部「应用选中项（n）」只把**勾中**的新值写回，未勾中的一律保留库里旧值。
// 绝不整条覆盖：早先只有一个「应用新结果」按钮，一点就把全部字段（含识别错的）写进去，
// 用户没法只留「日期校正了、其它项识别错了」的正确部分——这是本弹窗改为逐项采用的由来。
// 外壳与确认框照 CompareModal 既有范式（点击遮罩关闭、固定浮层、不 hover-follow）。

import { useMemo, useState } from 'react'
import { updateDoc } from '../data/store.js'
import { buildDocPatch } from '../utils/reRecognize.js'
import DiffListView from './DiffListView.jsx'
import CloseButton from './CloseButton.jsx'
import EscClose from './EscClose.jsx'
import { useEscClose, useBodyScrollLock } from '../utils/overlay.js'

// docLabel：展示用文案（检查报告 / 出院记录 / 诊断证明）
// onApply：提供时进入「草稿模式」——把 patch 交回调用方（导入流程的表单），而不是直接写库
export default function ReRecognizeDocModal({ doc, result, onClose, onApplied, docLabel = '检查报告', onApply }) {
  const dd = result.dateDiff || { old: doc.date || '', new: '', changed: false }
  const [dateAdopted, setDateAdopted] = useState(false)
  // 已勾选采用新值的字段 key（默认全不勾：由用户显式挑出识别正确的项，避免误应用）
  const [adopted, setAdopted] = useState(() => new Set())
  const [confirmBox, setConfirmBox] = useState(null)
  // Esc 关闭本弹窗；内层确认框开着时由它先吃掉（EscClose 后挂载＝栈顶）
  useEscClose(onClose)
  useBodyScrollLock()

  const diffs = result.diffs || []
  const changedKeys = useMemo(() => diffs.filter((d) => d.differs).map((d) => d.field), [diffs])
  const diffCount = result.diffCount + (dd.changed ? 1 : 0)
  const isAllAdopted = changedKeys.length > 0 && adopted.size === changedKeys.length
  const nothingPicked = adopted.size === 0 && !dateAdopted
  // 类型被纠正（如把「出院记录」判成「诊断证明」）：采用 kind 会清掉旧类型的专属字段，必须明示
  const kindChanged = adopted.has('kind') && result.nextFields && result.nextFields.kind && result.nextFields.kind !== doc.kind
  const KIND_CN = { discharge: '出院记录', cert: '诊断证明' }

  const toggle = (key) =>
    setAdopted((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const toggleAll = () => setAdopted(isAllAdopted ? new Set() : new Set(changedKeys))

  // 只把「勾中」的新值合并到旧数据上：未勾字段沿用旧值（合并逻辑在 reRecognize.buildDocPatch，可单测）
  const buildPatch = () => buildDocPatch({ doc, result, adopted, dateAdopted })

  const doConfirm = () => {
    const patch = buildPatch()
    // 草稿模式（导入流程）：patch 交回表单，由用户继续核对后自行保存
    if (onApply) onApply(patch)
    else updateDoc(doc.id, patch)
    setConfirmBox(null)
    onApplied && onApplied()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="card w-full max-w-[860px] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="重新识别对比"
      >
        {/* 头部 */}
        <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold">重新识别 · {docLabel}对比</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {doc.date} · {doc.doc_type || ''} · 共 {diffs.length} 个字段
            </p>
          </div>
          <CloseButton tone="dark" onClick={onClose} testId="rerecognize-doc-close" />
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-auto p-5 space-y-3">
          {/* 日期行（可审查字段） */}
          <div className={`card p-3 flex items-center justify-between gap-3 ${dd.changed ? 'border-orange-300 bg-orange-50' : ''}`}>
            <div className="min-w-0">
              <div className="text-[11px] text-slate-500">报告日期</div>
              <div className="text-sm mt-0.5">
                <span className="text-slate-500">{dd.old || '（空）'}</span>
                {dd.changed && (
                  <>
                    <span className="mx-2 text-slate-400">→</span>
                    <span className="font-semibold text-emerald-700">{dd.new}</span>
                  </>
                )}
              </div>
            </div>
            {dd.changed && !dateAdopted && (
              <button className="btn-primary text-xs shrink-0" onClick={() => setDateAdopted(true)}>
                采用新日期
              </button>
            )}
            {dd.changed && dateAdopted && <span className="text-xs text-emerald-700 shrink-0">已采用新日期 ✓</span>}
            {!dd.changed && <span className="text-xs text-slate-400 shrink-0">无变化</span>}
          </div>

          {kindChanged && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              类型将被纠正为「{KIND_CN[result.nextFields.kind] || result.nextFields.kind}」：
              旧类型的专属字段（{doc.kind === 'discharge' ? '出院诊断 / 出院医嘱 / 出院用药' : '诊断 / 建议休息天数'}）会一并清除。
            </div>
          )}

          {/* 字段 diff：逐项勾选，只采用勾中的新值 */}
          <DiffListView
            items={diffs.map((d) => ({ key: d.field, label: d.label, old: d.old, new: d.new, differs: d.differs }))}
            selected={adopted}
            onToggle={toggle}
          />
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <p className="text-[11px] text-slate-500">
            差异 <b className="text-orange-600">{diffCount}</b> 处 · 已选 <b className="text-emerald-700">{adopted.size}</b> 项
            {dateAdopted && <span className="ml-2 text-emerald-700">· 含新日期</span>}
          </p>
          <div className="flex gap-2">
            {changedKeys.length > 0 && (
              <button className="btn-secondary text-xs" onClick={toggleAll}>
                {isAllAdopted ? '取消全选' : '全选'}
              </button>
            )}
            <button className="btn-secondary text-xs" onClick={onClose}>
              取消
            </button>
            <button
              className="btn-primary text-xs disabled:opacity-50"
              disabled={nothingPicked}
              title={nothingPicked ? '请先勾选要采用的新值' : ''}
              onClick={() =>
                setConfirmBox({
                  title: '确认采用选中的新识别结果？',
                  message: `${
                    onApply
                      ? `将用新识别结果替换当前录入表单的 ${adopted.size} 项${dateAdopted ? ' 及日期' : ''}，其余 ${changedKeys.length - adopted.size} 处差异保留原值。保存后才会归档。`
                      : `将采用 ${adopted.size} 项新识别值写入本条${docLabel}${dateAdopted ? '（含新日期）' : ''}，其余 ${changedKeys.length - adopted.size} 处差异保留原值。\n此为本地覆盖，建议确认无误后再写入。`
                  }${kindChanged ? `\n类型改为「${KIND_CN[result.nextFields.kind] || result.nextFields.kind}」后，旧类型的专属字段会被清除。` : ''}`,
                  okLabel: '应用选中项',
                  onOk: doConfirm,
                })
              }
            >
              应用选中项（{adopted.size}）
            </button>
          </div>
        </div>
      </div>

      {/* 应用内确认框 */}
      {confirmBox && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/30" onClick={() => setConfirmBox(null)}>
          <EscClose onClose={() => setConfirmBox(null)} />
          <div className="bg-white rounded-lg shadow-xl border border-slate-200 p-4 w-80" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium text-slate-800">{confirmBox.title}</p>
            {confirmBox.message && <p className="mt-1.5 text-xs text-slate-500 whitespace-pre-line">{confirmBox.message}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn-ghost text-xs" onClick={() => setConfirmBox(null)}>
                取消
              </button>
              <button
                className="text-xs px-3 py-1 rounded bg-sky-500 text-white hover:bg-sky-600"
                onClick={() => confirmBox.onOk && confirmBox.onOk()}
              >
                {confirmBox.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
