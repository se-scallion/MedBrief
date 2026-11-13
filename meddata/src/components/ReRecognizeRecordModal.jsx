// ===================== 化验记录「重新识别」对比弹窗 =====================
// 用最新算法重跑原件 OCR 后，把「旧识别 vs 新识别」按 standard_code 对齐展示：
//   - 顶部日期行：旧日期 ↔ 新识别日期，差异时可「采用新日期」（需显式点选，确认时才写入）
//   - 指标差异表：旧值(灰) / 新值(绿，差异行高亮)，每差异行可「采用新值」（覆盖/补入），表头「采用全部新值」
//   - 确认走应用内确认框，绝不静默覆盖旧数据
// 外壳与确认框照 CompareModal 既有范式（点击遮罩关闭、固定浮层、不 hover-follow）。

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { writeRecord } from '../data/store.js'
import { STATUS_META } from '../utils/normalize.js'
import { applyPointToPoints } from '../utils/clean.js'
import { CURRENT_RECOGNITION_VERSION } from '../utils/reRecognize.js'
import { ENGINES } from '../utils/ocrEngines.js'
import { useEngineHealth, pickEngineAfterFailure } from '../utils/engineStatus.js'
import EngineSelect from './EngineSelect.jsx'
import CloseButton from './CloseButton.jsx'
import EscClose from './EscClose.jsx'
import { useEscClose, useBodyScrollLock } from '../utils/overlay.js'

const STATUS_BADGE = {
  red: 'bg-red-100 text-red-700 border-red-200',
  amber: 'bg-amber-100 text-amber-700 border-amber-200',
  emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
}
function StatusBadge({ status }) {
  const meta = STATUS_META[status]
  if (!meta) return null
  return (
    <span className={`ml-1 inline-block px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${STATUS_BADGE[meta.color]}`} title={meta.label}>
      {meta.symbol || meta.label}
    </span>
  )
}

// onApply：提供时进入「草稿模式」——把 patch 交回调用方（导入流程的表单），而不是直接写库
// onStart(engine)：可选；弹窗「空态」（result=null，尚未跑过识别）时用它开始第一次识别
// onRerunEngine(engine)：可选；提供时显示「识别引擎」选择器（换引擎重跑由父组件执行——需原图与隐私确认）
// onFuse()：可选；多引擎融合补漏入口（父组件依次跑其余引擎并 fuseEngineResults）
// busy / fuseBusy：{ engine } | null —— 父组件的进行态（引擎选择行显示「识别中」）
// error：父组件传回的重跑/融合错误文案
// result=null 语义：交互倒转后的空态——先选引擎、点「开始识别」后才出对比（详情页不再先跑一遍本地）
export default function ReRecognizeRecordModal({
  record,
  result,
  onClose,
  onApplied,
  onApply,
  onStart,
  onRerunEngine,
  onFuse,
  busy,
  fuseBusy,
  error,
}) {
  // pendingPoints：从旧 data_points 起步，逐项「采用新值」时把该项换为新点；「采用全部」直接替换为新识别结果
  const [pendingPoints, setPendingPoints] = useState(record.data_points || [])
  const [adopted, setAdopted] = useState(() => new Set())
  const [allAdopted, setAllAdopted] = useState(false)
  const [dateAdopted, setDateAdopted] = useState(false)
  const [adoptedType, setAdoptedType] = useState(() => ({}))
  const [confirmBox, setConfirmBox] = useState(null)
  const [conflictsOpen, setConflictsOpen] = useState(() => new Set())
  const [engineSel, setEngineSel] = useState(result?.engine === 'fused' ? 'local' : result?.engine || 'local')

  // 引擎可用性（离线服务是否已启动）：选项上直接带「启动中…／服务未启动」提示
  const { health: engineHealth, healthRef: engineHealthRef } = useEngineHealth()
  // Esc 关闭：空态/对比态共用（组件本体就是这层浮层）；内层确认框开着时由它先吃掉
  useEscClose(onClose)
  useBodyScrollLock()
  const lastEngineRef = useRef(engineSel) // 最近一次真正跑过的引擎（失败后据此换人）
  const [switchedFrom, setSwitchedFrom] = useState('') // 本次失败被换掉的引擎（提示文案用）
  useEffect(() => {
    if (busy && busy.engine) {
      lastEngineRef.current = busy.engine
      setSwitchedFrom('') // 新一次识别开始：清掉上一轮的「已换引擎」提示
    }
  }, [busy])
  // 识别失败后把下拉默认切到「另一个可用引擎」：否则用户原样再点一次，必然再失败一次
  useEffect(() => {
    if (!error) return
    const failed = lastEngineRef.current
    setEngineSel((cur) => {
      if (cur !== failed) return cur
      const next = pickEngineAfterFailure(failed, engineHealthRef.current)
      if (next && next !== failed) {
        lastEngineRef.current = next
        setSwitchedFrom(failed)
      }
      return next || cur
    })
  }, [error, engineHealthRef])

  const adoptType = (key) => setAdoptedType((s) => ({ ...s, [key]: true }))

  const dd = result?.dateDiff || { old: record.date || '', new: '', changed: false }
  const pendingDate = dateAdopted ? dd.new : dd.old

  // 差异行 + 冲突行（融合后「旧==新」的行也可能带 _conflicts：其他引擎读出了不同值，同样要给用户看）
  // useMemo 隔离（勘查建议）：result 不变时避免每次 adopted/conflictsOpen setState 重复过滤
  const shownRows = useMemo(
    () => (result?.rows || []).filter((r) => r.differs || (r.cells[1]?.point?._conflicts?.value?.length || 0) > 0),
    [result],
  )
  const toggleConflicts = (code) =>
    setConflictsOpen((s) => {
      const next = new Set(s)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })

  // 冲突裁决：采纳某引擎的值 → 覆盖该点 value、清 _conflicts，并标记已采用
  const adoptConflict = (row, engine, val) => {
    const np = row.cells[1] && row.cells[1].point
    if (!np) return
    setPendingPoints((pts) => applyPointToPoints(pts, { ...np, value: val, _conflicts: undefined }))
    setAdopted((s) => new Set(s).add(row.code))
  }

  const adoptOne = (row) => {
    const np = row.cells[1] && row.cells[1].present ? row.cells[1].point : null
    if (!np) return
    setPendingPoints((pts) => applyPointToPoints(pts, np))
    setAdopted((s) => new Set(s).add(row.code))
  }

  const adoptAll = () => {
    if (!result) return
    setPendingPoints(result.nextPoints)
    setAdopted(new Set(result.rows.map((r) => r.code)))
    setAllAdopted(true)
  }

  const doConfirm = () => {
    // 类型字段（报告类型/标题/时间）逐项移到：未采用则保留旧值，采用则写入新识别结果
    const typePatch = Object.fromEntries(
      (result?.typeRows || []).map((r) => [r.key, adoptedType[r.key] ? r.new : r.old])
    )
    const patch = {
      data_points: pendingPoints,
      date: pendingDate,
      recognition_version: CURRENT_RECOGNITION_VERSION,
      ...typePatch,
    }
    if (onApply) onApply(patch)
    else writeRecord({ id: record.id, patch, source: 'rerecognize' })
    setConfirmBox(null)
    onApplied && onApplied()
    onClose()
  }

  // ===== 空态（result=null）：先选引擎、点「开始识别」后才跑 =====
  // 交互倒转（用户明确要求）：点「重新识别」立即弹窗，不再先跑一遍本地 OCR 才出现选项。
  // 放在所有 hooks 之后 return，hooks 顺序不受影响。
  if (!result) {
    const running = !!busy || !!fuseBusy
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
        <div className="card w-full max-w-[460px]" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="重新识别">
          <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-semibold">重新识别</h2>
              <p className="text-xs text-slate-400 mt-0.5">选择识别方式后开始，识别完成再逐项确认</p>
            </div>
            <CloseButton tone="dark" onClick={onClose} testId="rerecognize-close" />
          </div>
          <div className="p-5 space-y-3">
            <div>
              <div className="text-[11px] text-slate-500 font-semibold mb-1">识别引擎</div>
              <EngineSelect
                value={engineSel}
                onChange={setEngineSel}
                disabled={running}
                health={engineHealth}
                className="w-full !py-1.5"
                showNote
              />
              <p className="text-[11px] text-slate-400 mt-1.5">
                默认本地离线（不出本机）；MinerU 云端识别率最高但会上传原图，首次使用会提示确认。
              </p>
            </div>
            <button
              className="btn-primary text-xs w-full disabled:opacity-50"
              disabled={running}
              onClick={() => onStart && onStart(engineSel)}
            >
              开始识别
            </button>
            {busy && (
              <div className="text-xs text-sky-700 bg-sky-50 border border-sky-200 rounded p-2 flex items-center gap-2">
                <span className="inline-block w-3 h-3 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                {ENGINES[busy.engine]?.label || busy.engine} 识别中…
              </div>
            )}
            {error && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                识别失败：{error}
                {switchedFrom && (
                  <span className="block text-[11px] text-red-600 mt-1">
                    已把引擎从「{ENGINES[switchedFrom]?.label || switchedFrom}」切到
                    「{ENGINES[engineSel]?.label || engineSel}」，可直接重新点「开始识别」。
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="card w-full max-w-[1000px] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="重新识别对比"
      >
        {/* 头部 */}
        <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold">重新识别 · 化验记录对比</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {record.date} · {record.report_type || ''} · 旧识别 {record.data_points?.length || 0} 项 / 新识别 {result.nextPoints.length} 项
            </p>
          </div>
          <CloseButton tone="dark" onClick={onClose} testId="rerecognize-close" />
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {/* 识别引擎选择（多引擎重构）：换引擎重跑 / 多引擎融合补漏，均由父组件执行 */}
          {onRerunEngine && (
            <div className="card p-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500 font-semibold">识别引擎</div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  默认本地离线；MinerU / AI 为云端（首次使用会提示隐私须知）。重跑结果仅进本弹窗供逐项采用，绝不静默覆盖。
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <EngineSelect
                  value={engineSel}
                  onChange={setEngineSel}
                  disabled={!!busy || !!fuseBusy}
                  health={engineHealth}
                />
                <button
                  className="btn-primary text-xs disabled:opacity-50"
                  disabled={!!busy || !!fuseBusy}
                  onClick={() => onRerunEngine(engineSel)}
                >
                  换引擎重跑
                </button>
                {onFuse && (
                  <button
                    className="btn-secondary text-xs disabled:opacity-50"
                    disabled={!!busy || !!fuseBusy}
                    onClick={onFuse}
                    title="依次用其余引擎重跑，把缺失指标补入、冲突值并列供逐项裁决"
                  >
                    多引擎融合补漏
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 进行态 / 错误（异步引擎的进行态必须显式展示，不得渲染成终态） */}
          {busy && (
            <div className="card p-3 text-xs text-sky-700 bg-sky-50 border border-sky-200 flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
              {ENGINES[busy.engine]?.label || busy.engine} 识别中，请稍候…（关闭弹窗即取消）
            </div>
          )}
          {fuseBusy && (
            <div className="card p-3 text-xs text-sky-700 bg-sky-50 border border-sky-200 flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
              多引擎融合中：正在跑 {ENGINES[fuseBusy.engine]?.label || fuseBusy.engine}
              {fuseBusy.idx != null && fuseBusy.total ? `（${fuseBusy.idx}/${fuseBusy.total}）` : ''} …
            </div>
          )}
          {error && (
            <div className="card p-3 text-xs text-red-700 bg-red-50 border border-red-200">
              识别失败：{error}
              {switchedFrom && (
                <span className="block text-[11px] text-red-600 mt-1">
                  已把引擎从「{ENGINES[switchedFrom]?.label || switchedFrom}」切到
                  「{ENGINES[engineSel]?.label || engineSel}」，可直接「换引擎重跑」。
                </span>
              )}
            </div>
          )}

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
            {dd.changed && dateAdopted && (
              <span className="text-xs text-emerald-700 shrink-0">已采用新日期 ✓</span>
            )}
            {!dd.changed && <span className="text-xs text-slate-400 shrink-0">无变化</span>}
          </div>

          {/* 类型识别（可审查字段）：重新识别与初次识别同口径重跑了类型/标题/时间 */}
          <div className="card p-3 space-y-2">
            <div className="text-[11px] text-slate-500 font-semibold">类型识别（旧识别 vs 新识别）</div>
            {(result.typeRows || []).map((r) => (
              <div
                key={r.key}
                className={`flex items-center justify-between gap-3 rounded ${r.differs ? 'border border-orange-300 bg-orange-50 p-2' : ''}`}
              >
                <div className="min-w-0">
                  <div className="text-[11px] text-slate-500">{r.label}</div>
                  <div className="text-sm mt-0.5">
                    <span className="text-slate-500">{r.old || '（空）'}</span>
                    {r.differs && (
                      <>
                        <span className="mx-2 text-slate-400">→</span>
                        <span className="font-semibold text-emerald-700">{r.new || '（空）'}</span>
                      </>
                    )}
                  </div>
                </div>
                {r.differs && !adoptedType[r.key] && (
                  <button className="btn-primary text-xs shrink-0" onClick={() => adoptType(r.key)}>
                    采用新{r.label}
                  </button>
                )}
                {r.differs && adoptedType[r.key] && (
                  <span className="text-xs text-emerald-700 shrink-0">已采用新{r.label} ✓</span>
                )}
                {!r.differs && <span className="text-xs text-slate-400 shrink-0">无变化</span>}
              </div>
            ))}
          </div>

          {/* 指标对比表 */}
          <div className="card overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-sm font-semibold text-slate-700">指标对比（旧 vs 新）</h3>
              <div className="flex items-center gap-3">
                <p className="text-[11px] text-slate-500">
                  共 {result.rows.length} 项 · <b className="text-orange-600">差异 {result.diffCount} 项</b> · 一致 {result.rows.length - result.diffCount} 项
                </p>
                {result.diffCount > 0 && (
                  <button className="btn-primary text-[11px] px-2.5 py-1" onClick={adoptAll}>
                    采用全部新值
                  </button>
                )}
              </div>
            </div>
            <div className="overflow-auto" style={{ maxHeight: 380 }}>
              <table className="w-full text-xs border-collapse">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">指标</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-400">旧识别</th>
                    <th className="text-left px-3 py-2 font-medium text-emerald-700">新识别</th>
                    <th className="text-center px-2 py-2 font-medium text-slate-400">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((row) => {
                    const oldC = row.cells[0]
                    const newC = row.cells[1]
                    const newPresent = newC && newC.present
                    const isAdopted = adopted.has(row.code)
                    const conflicts = (newC?.point?._conflicts?.value || []).filter((c) => c && c.val)
                    const newSource = newC?.point?._source
                    const expanded = conflictsOpen.has(row.code)
                    return (
                      <Fragment key={row.code}>
                        <tr className={`${row.differs ? 'bg-orange-50' : 'bg-amber-50'} border-b border-orange-100`}>
                          <td className="px-3 py-1.5 text-slate-700 sticky left-0 bg-inherit">
                            {row.name}
                            <span className="ml-1 font-mono text-[10px] text-slate-400">{row.code}</span>
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {oldC && oldC.present ? (
                              <>
                                <span className="text-slate-500">{oldC.value}</span>
                                {oldC.unit ? <span className="text-slate-400 ml-1">{oldC.unit}</span> : null}
                                <StatusBadge status={oldC.status} />
                              </>
                            ) : (
                              <span className="text-slate-300">缺失</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {newPresent ? (
                              <>
                                <span className="font-semibold text-slate-900">{newC.value}</span>
                                {newC.unit ? <span className="text-slate-400 ml-1">{newC.unit}</span> : null}
                                <StatusBadge status={newC.status} />
                                {newSource && (
                                  <span className="ml-1 inline-block px-1 py-0.5 rounded bg-sky-50 border border-sky-200 text-[10px] text-sky-600" title={`该指标来自 ${newSource} 引擎补漏`}>
                                    {newSource}
                                  </span>
                                )}
                                {conflicts.length > 0 && (
                                  <button
                                    className={`ml-1 inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                                      expanded ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-100 text-amber-700 border-amber-300'
                                    }`}
                                    onClick={() => toggleConflicts(row.code)}
                                    title={`${conflicts.length} 个引擎读出了不同的值，点击展开逐个裁决`}
                                  >
                                    ⚠ {conflicts.length} 引擎不同值
                                  </button>
                                )}
                              </>
                            ) : (
                              <span className="text-slate-300">缺失</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-center whitespace-nowrap">
                            {newPresent && !isAdopted && (
                              <button
                                className="px-2 py-0.5 rounded border border-slate-300 bg-white text-slate-600 hover:border-sky-400 hover:text-sky-600 text-xs"
                                onClick={() => adoptOne(row)}
                                title="用新识别值覆盖/补入该项"
                              >
                                采用新值
                              </button>
                            )}
                            {isAdopted && <span className="text-[10px] text-emerald-700">已采用 ✓</span>}
                            {!newPresent && <span className="text-[10px] text-slate-400">新缺失</span>}
                          </td>
                        </tr>
                        {/* 冲突裁决展开行（点击触发、点别处收起——固定位置，非 hover-follow） */}
                        {expanded && conflicts.length > 0 && (
                          <tr className="bg-amber-50/60 border-b border-amber-100">
                            <td className="px-3 py-2" colSpan={4}>
                              <div className="text-[11px] text-slate-500 mb-1.5">
                                其他引擎对该指标的读值与当前值（<b className="text-slate-700">{newC?.value}</b>）不同，选择要采纳的值：
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {conflicts.map((c) => (
                                  <button
                                    key={`${c.engine}-${c.val}`}
                                    className="px-2 py-1 rounded border border-amber-300 bg-white text-xs hover:border-amber-500"
                                    onClick={() => adoptConflict(row, c.engine, c.val)}
                                    title={`采纳 ${c.engine} 引擎的读值`}
                                  >
                                    <b>{c.val}</b>
                                    <span className="ml-1 text-[10px] text-slate-400">来自 {c.engine}</span>
                                    <span className="ml-1 text-[10px] text-emerald-600">采纳</span>
                                  </button>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                  {shownRows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-xs text-slate-400">
                        新旧识别完全一致，且无引擎间读值冲突
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <p className="text-[11px] text-slate-500">
            已采用 <b className="text-slate-700">{adopted.size}</b> 项新值
            {dateAdopted && <span className="ml-2 text-emerald-700">· 含新日期</span>}
          </p>
          <div className="flex gap-2">
            <button className="btn-secondary text-xs" onClick={onClose}>
              取消
            </button>
            <button
              className="btn-primary text-xs"
              onClick={() =>
                setConfirmBox({
                  title: '确认写入新识别结果？',
                  message: `将用新算法识别结果覆盖本条报告的 ${adopted.size} 项指标${dateAdopted ? ' 及报告日期' : ''}。\n此为本地覆盖，建议确认无误后再写入。`,
                  okLabel: '确认写入',
                  onOk: doConfirm,
                })
              }
            >
              确认写入
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
