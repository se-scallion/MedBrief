// ===================== AI 复查建议面板（通用，record/doc 复用）=====================
// 轮询 /api/review-status，展示 agent 产出的结构化建议；用户逐条勾选确认，
// 由父组件 onApply(selected) 落地（人在回路，AI 不改数据）。固定区块、非 hover。
//
// 2026-09-10 体验修复（用户反馈「应用选中点了没反应」）：
//   1) 每条建议标注动作类型（替换文本 / 改值 / 新增行 / 删除行），让"应用"语义可见；
//   2) 点「应用选中」先弹确认框，说明只覆盖勾选项；
//   3) 确认后标「✓ 已应用」、面板内显示「已应用 N 条」提示，不再静默无反馈；
//   4) 未勾选任何项时按钮给出「请勾选要应用的建议」提示（而非死灰让人以为坏了）。
import { useEffect, useRef, useState } from 'react'
import EscClose from './EscClose.jsx'

// 把建议映射成给用户看的「动作类型」，直接回答"应用是替换还是添加"
const actionLabel = (s, target) => {
  // doc（检查报告）与 case（病历文书）复查形态一致：都是 findings / conclusion 文本字段
  if (target === 'doc' || target === 'case') {
    const field = s.ref === 'conclusion' ? '诊断结论' : s.ref === 'findings' ? '检查所见' : s.ref || '字段'
    return `替换${field}`
  }
  if (s.kind === 'add') return '新增行'
  if (s.kind === 'remove') return '删除行'
  return '改值'
}

export default function ReviewSuggestions({ id, target, onApply }) {
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState({})
  const [applied, setApplied] = useState({}) // index -> true：已应用并锁定的项
  const [confirmOpen, setConfirmOpen] = useState(false)
  const initialized = useRef(false)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const r = await fetch(`/api/review-status?id=${encodeURIComponent(id)}`)
        if (r.ok) {
          const j = await r.json()
          if (alive) setData(j)
        }
      } catch {
        /* 服务未连，保持原态 */
      }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [id])

  // 首次拿到建议后，默认勾选 confidence>=0.7 的项（防误改，低置信需用户主动勾）
  useEffect(() => {
    if (initialized.current) return
    const sugs = data?.suggestions || []
    if (!sugs.length) return
    initialized.current = true
    const def = {}
    sugs.forEach((s, i) => {
      if ((s.confidence || 0) >= 0.7) def[i] = true
    })
    setSelected(def)
  }, [data])

  if (!data || data.state === 'pending' || data.state === 'running') {
    return (
      <div className="card p-3 bg-slate-50 border-slate-200 text-xs text-slate-500">
        🤖 AI 复查中…
      </div>
    )
  }
  const sugs = data.suggestions || []
  if (data.status === 'skipped' || !sugs.length) {
    return (
      <div className="card p-3 bg-emerald-50 border-emerald-200 text-xs text-emerald-700">
        ✓ AI 复查通过（{target === 'doc' ? '检查报告' : '检验报告'}未发现问题）
      </div>
    )
  }

  const toggle = (i) => setSelected((s) => ({ ...s, [i]: !s[i] }))

  // 待应用 = 已勾选且尚未应用的项
  const pendingIndices = sugs.map((_, i) => i).filter((i) => selected[i] && !applied[i])
  const appliedCount = Object.keys(applied).length

  const doApply = () => {
    const picked = pendingIndices.map((i) => sugs[i])
    if (!picked.length) return
    onApply && onApply(picked) // 落地（父组件改写数据，人在回路）
    const na = { ...applied }
    pendingIndices.forEach((i) => {
      na[i] = true
    })
    setApplied(na)
    setSelected((s) => {
      const n = { ...s }
      pendingIndices.forEach((i) => {
        delete n[i]
      })
      return n
    })
    setConfirmOpen(false)
  }

  return (
    <div className="card p-3 border-brand-200 bg-brand-50/40 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-brand-700">🤖 AI 复查建议（{sugs.length}）</p>
        <span className="text-[10px] text-slate-400">仅建议，确认才改</span>
      </div>
      {data.summary && <p className="text-[11px] text-slate-500 leading-relaxed">{data.summary}</p>}
      <div className="space-y-1.5">
        {sugs.map((s, i) => {
          const isApplied = !!applied[i]
          return (
            <label
              key={i}
              className={
                'flex items-start gap-2 text-xs rounded-md border border-slate-200 bg-white px-2 py-1.5 cursor-pointer hover:border-brand-300' +
                (isApplied ? ' opacity-60' : '')
              }
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!selected[i]}
                disabled={isApplied}
                onChange={() => toggle(i)}
              />
              <div className="min-w-0">
                <div className="text-slate-700">
                  <span className="text-[10px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 mr-1 align-middle">
                    {actionLabel(s, target)}
                  </span>
                  {s.name || s.ref}
                  {s.original != null && s.original !== '' ? (
                    <span>
                      {' '}
                      <span className="line-through text-slate-400">{s.original}</span> →{' '}
                      <b className="text-brand-700">{s.suggested}</b>
                    </span>
                  ) : (
                    <b className="text-brand-700"> {s.suggested}</b>
                  )}
                  {s.unit ? <span className="text-slate-400"> {s.unit}</span> : null}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  置信度 {Math.round((s.confidence || 0) * 100)}% · {s.reason || ''}
                  {isApplied && <span className="text-emerald-600 ml-1">· ✓ 已应用</span>}
                </div>
              </div>
            </label>
          )
        })}
      </div>
      <div className="flex items-center justify-between pt-1">
        <span className="text-[10px] text-slate-400">
          {pendingIndices.length ? `已选 ${pendingIndices.length} 条待应用` : appliedCount ? '已全部应用勾选项' : '请先勾选要应用的建议'}
        </span>
        <div className="flex items-center gap-2">
          {appliedCount > 0 && <span className="text-[10px] text-emerald-600">✓ 已应用 {appliedCount} 条</span>}
          <button
            className="btn-primary text-xs"
            disabled={!pendingIndices.length}
            onClick={() => setConfirmOpen(true)}
            title={pendingIndices.length ? '应用勾选的建议（仅覆盖勾选项）' : '请先勾选至少一条建议'}
          >
            应用选中
          </button>
        </div>
      </div>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/30"
          onClick={() => setConfirmOpen(false)}
        >
          <EscClose onClose={() => setConfirmOpen(false)} />
          <div
            className="bg-white rounded-xl p-5 w-[360px] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold mb-2">确认应用 {pendingIndices.length} 条 AI 建议？</p>
            <p className="text-xs text-slate-500 mb-4 leading-relaxed">
              仅覆盖你勾选的项，AI 不会改动未勾选项：检查报告会<b>替换</b>对应「所见 / 结论」文本段，
              检验报告按建议<b>改值 / 新增行 / 删除行</b>。写入后可继续手动编辑，不会静默丢失。
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn text-xs" onClick={() => setConfirmOpen(false)}>
                取消
              </button>
              <button className="btn-primary text-xs" onClick={doApply}>
                确认应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
