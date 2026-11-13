// ===================== 详情页 · AI 重读对比弹窗（检查报告 / 病历文书共用）=====================
// 与草稿期的三轨模型不同：已归档记录是**人工核对过的既有事实**，AI 只提供候选新值，
// 用户在弹窗里**逐字段勾选**采用（绝不自动覆盖）——见 proposals §4.4。
//
// 两条默认策略：
//   ① AI 给出非空新值 → 默认勾选（这是用户点「AI 重读」的意图）；
//   ② AI 读出为空（empty=true，采用即清空原值）→ **默认不勾选**并明示，避免静默丢数据。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox } from 'antd'
import { updateDoc } from '../data/store.js'
import {
  diffDocVsAi,
  aiPatchFor,
  diffCaseVsAi,
  aiCasePatchFor,
  diffText,
  aiConfidenceLabel,
  evidenceOf,
} from '../utils/docAi.js'
import CloseButton from './CloseButton.jsx'
import EscClose from './EscClose.jsx'
import { useEscClose, useBodyScrollLock } from '../utils/overlay.js'

const CONF_CN = { high: '高', medium: '中', low: '低' }

// variant：'exam'（检查报告，比对所见/结论/篇幅字段）| 'case'（病历文书，比对诊断/医嘱/日期等结构化字段）
export default function DocAiRereadModal({
  doc,
  result,
  running,
  elapsedMs,
  error,
  onClose,
  onApplied,
  aiMode,
  variant = 'exam',
  // 轮询超时后（后端仍在跑）的取回入口：任务没丢，点一下把已完成的结果读回来继续对比
  onLoadPending,
  loadingPending = false,
  // 结果来自「上次已跑完但没应用」的任务：明示不要重复付费，并给一键重新读图
  fromCache = false,
  cacheNote = '',
  onRerun,
}) {
  const computeDiffs = useMemo(
    () => (r) => (r ? (variant === 'case' ? diffCaseVsAi(doc, r) : diffDocVsAi(doc, r)) : []),
    [doc, variant]
  )
  const diffs = useMemo(() => computeDiffs(result), [computeDiffs, result])
  const [confirming, setConfirming] = useState(false)
  // Esc 关闭本弹窗；内层「确认写入」框开着时由它先吃掉（EscClose 后挂载＝栈顶）
  useEscClose(onClose)
  useBodyScrollLock()
  // ⚠ 默认勾选必须在**结果到达后**再算一次：本弹窗是「先打开（运行中）→ 后拿结果」，
  //   若用 useState 惰性初值，初次渲染时 diffs 还是空的，之后所有复选框永远是未选状态、
  //   用户根本应用不了（2026-10-18 e2e 抓到的必然性 bug）。故用 effect 跟 result 走。
  const [selected, setSelected] = useState(() => new Set())
  const lastResultRef = useRef(null)
  useEffect(() => {
    if (result === lastResultRef.current) return
    lastResultRef.current = result
    // 默认勾选「AI 给出非空新值」的字段；AI 读出为空的（采用即清空原值）默认不勾选
    setSelected(new Set(computeDiffs(result).filter((d) => !d.empty).map((d) => d.field)))
  }, [result, computeDiffs])

  const toggle = (field, on) => {
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(field)
      else next.delete(field)
      return next
    })
  }

  const apply = () => {
    const fields = [...selected]
    // 病历文书的结构化字段要合并进 doc.fields（未勾选保留旧值），检查报告则直接写顶层
    const patch =
      variant === 'case' ? aiCasePatchFor(doc, result, fields, result.category) : aiPatchFor(result, fields)
    if (variant !== 'case' && (result.category === 'exam' || result.category === 'case')) {
      // AI 若一并给出类别裁决，跟随采用（仅当该字段被勾选）
      if (fields.includes('kind')) patch.category = result.category
    }
    patch.ai = {
      engine: 'ai',
      mode: aiMode === 'doc-text' ? 'text' : 'vision',
      version: result.version || 2,
      at: new Date().toISOString(),
      confidence: (result.confidence && result.confidence.overall) || '',
      evidence_count: (result.evidence || []).length,
      task_id: result.id || '',
    }
    updateDoc(doc.id, patch)
    setConfirming(false)
    onApplied && onApplied(Object.keys(patch))
    onClose()
  }

  const conf = result ? aiConfidenceLabel(result) : ''
  const hasDiff = diffs.length > 0

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="card w-full max-w-[880px] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="AI 重读对比"
      >
        <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold">AI 重读 · {variant === 'case' ? '文书' : '检查报告'}逐字段对比</h2>
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              {doc.date} · {doc.doc_type || ''}
              {result && result.title ? ` · ${result.title}` : ''}
            </p>
          </div>
          <CloseButton tone="dark" onClick={onClose} testId="ai-reread-close" />
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-3">
          {running && (
            <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800 flex items-center gap-2">
              <span className="inline-block w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
              AI 正在读原件…
              <span className="text-brand-700">{Math.round((elapsedMs || 0) / 1000)}s</span>
              <span className="text-slate-500 text-xs">（可以关闭本弹窗，结果会进「AI 任务」）</span>
            </div>
          )}
          {fromCache && !running && result && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-800 flex items-center justify-between gap-3">
              <span>
                这是上次已完成、尚未应用的结果（没有重复读图，也没有再产生费用）。
                {cacheNote ? <span className="text-sky-700"> {cacheNote}</span> : null}
              </span>
              {onRerun && (
                <button className="btn-secondary text-xs shrink-0" onClick={onRerun}>
                  重新读图
                </button>
              )}
            </div>
          )}
          {running && (elapsedMs || 0) > 60_000 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[11px] text-slate-500">
              读图通常 30 秒–2 分钟，偶尔更久（本地 agent 在逐字核对，不是卡死）。可以先关掉弹窗去干别的，结果会进「AI 任务」。
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {error}
              {onLoadPending && (
                <button className="btn-primary text-xs mt-2 block" disabled={loadingPending} onClick={onLoadPending}>
                  {loadingPending ? '取回中…' : '载入后台结果'}
                </button>
              )}
            </div>
          )}

          {!running && !error && result && !hasDiff && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              AI 读出的内容与现有记录一致，无需修改。
            </div>
          )}

          {!running && result && hasDiff && (
            <>
              <div className="text-xs text-slate-500">
                共 {diffs.length} 处差异 · 已选 {selected.size} 项
                {conf ? ` · AI 置信度 ${CONF_CN[conf] || conf}` : ''}
                {result.notes ? <span className="block mt-1 text-[11px] text-slate-400">AI 说明：{result.notes}</span> : null}
              </div>
              <ul className="space-y-2">
                {diffs.map((d) => {
                  const quotes = evidenceOf(result, d.field)
                  return (
                    <li
                      key={d.field}
                      className={`rounded-lg border px-3 py-2 ${d.empty ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200'}`}
                      data-testid={`ai-reread-diff-${d.field}`}
                    >
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={selected.has(d.field)}
                          onChange={(e) => toggle(d.field, e.target.checked)}
                          aria-label={`采用 ${d.label}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-slate-600">
                            {d.label}
                            {d.empty && <span className="ml-2 text-amber-700">AI 读出为空，采用将清空原值（默认不勾选）</span>}
                          </div>
                          <div className="mt-1 text-xs leading-relaxed">
                            <span className="text-slate-400">现状：</span>
                            <span className="text-slate-500 line-through decoration-slate-300">{diffText(d.old)}</span>
                          </div>
                          <div className="text-xs leading-relaxed">
                            <span className="text-slate-400">AI：</span>
                            <span className={`whitespace-pre-wrap ${d.empty ? 'text-amber-700' : 'text-emerald-700 font-medium'}`}>
                              {diffText(d.new)}
                            </span>
                          </div>
                          {quotes.length > 0 && (
                            <details className="mt-1">
                              <summary className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-600">
                                原文引文 {quotes.length}
                              </summary>
                              <div className="mt-1 space-y-0.5">
                                {quotes.map((q, i) => (
                                  <p key={i} className="text-[11px] text-slate-500">
                                    「{q}」
                                  </p>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <p className="text-[11px] text-slate-500">只写入勾选项；未勾选的字段保持现状不变。</p>
          <div className="flex gap-2">
            <button className="btn-secondary text-xs" onClick={onClose}>
              取消
            </button>
            <button className="btn-primary text-xs" disabled={!hasDiff || selected.size === 0} onClick={() => setConfirming(true)}>
              应用选中项（{selected.size}）
            </button>
          </div>
        </div>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/30" onClick={() => setConfirming(false)}>
          <EscClose onClose={() => setConfirming(false)} />
          <div className="bg-white rounded-lg shadow-xl border border-slate-200 p-4 w-80" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium text-slate-800">确认写入选中的 {selected.size} 项？</p>
            <p className="mt-1.5 text-xs text-slate-500">
              将用 AI 重读结果覆盖本条检查报告的对应字段（本地写入，可再次编辑）。未勾选字段不受影响。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn-ghost text-xs" onClick={() => setConfirming(false)}>
                取消
              </button>
              <button className="text-xs px-3 py-1 rounded bg-sky-500 text-white hover:bg-sky-600" onClick={apply} data-testid="ai-reread-apply">
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
