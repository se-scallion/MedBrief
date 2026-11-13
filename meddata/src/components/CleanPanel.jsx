// ===================== 数据清洗面板 =====================
// 对历史 records 执行三类清洗（先预览确认，再执行）：
//   1. 内容重映射：按新字典用原始项目名重新匹配标准字段、重算状态
//   2. 标题修正：按重映射后的数据点重算报告类型
//   3. 去重：同日期 + 指标指纹一致的多条记录合并为一条（保留识别最全者）

import { useMemo, useState, useRef } from 'react'
import { Button, Checkbox } from 'antd'
import { analyzeRecords, cleanRecords } from '../utils/clean.js'
import { replaceRecords, useStore } from '../data/store.js'
import { reportTypeLabel } from '../data/dictionary.js'
import { runBatchReRecognize } from '../utils/reRecognize.js'
import CompareModal from './CompareModal.jsx'
import ReRecognizeRecordModal from './ReRecognizeRecordModal.jsx'
import ReRecognizeDocModal from './ReRecognizeDocModal.jsx'
import CloseButton from './CloseButton.jsx'
import { useEscClose } from '../utils/overlay.js'

const label = (code) => reportTypeLabel(code) || code || '未识别'

export default function CleanPanel({ records, onClose, onDone }) {
  const [done, setDone] = useState(false)
  const [resultSummary, setResultSummary] = useState(null)
  const analysis = useMemo(() => analyzeRecords(records), [records])
  const { totals, dupGroups, fuzzyGroups, titleFixes, pointFixes } = analysis
  // 重复（精确+疑似）默认全部勾选，用户可取消，避免误删同一天真实的两份报告
  const [checkedFuzzy, setCheckedFuzzy] = useState(() =>
    new Set([...dupGroups.map((g) => g.key), ...fuzzyGroups.map((g) => g.key)])
  )
  // 对比弹窗：当前打开的重复组（原图并排 + 手动选保留 + 就地修正指标）
  const [compareGroup, setCompareGroup] = useState(null)
  // 用户在弹窗中手动指定的保留记录 { groupKey: recordId }，优先于系统判定的 keep
  const [keepOverride, setKeepOverride] = useState({})
  // 跨行错配改判：单独分组、默认全部勾选，用户可逐条取消（改 code 风险高于改单位/参考范围）
  const crossRowFixes = pointFixes.filter((p) => p.kind === 'crossrow')
  const crossRowKey = (p) => `${p.recordId}|${p.from}|${p.to}|${p.value}`
  const [checkedCrossRow, setCheckedCrossRow] = useState(() => new Set(crossRowFixes.map(crossRowKey)))
  // Esc 退出清洗面板（面板由 App 的浮层包着，这里只负责按键这一半）
  useEscClose(onClose)
  const nothing =
    totals.removeRecords === 0 &&
    totals.titleFixes === 0 &&
    totals.pointFixes === 0 &&
    fuzzyGroups.length === 0

  // 弹窗确认：keepId 为 null 表示「两份都保留」→ 取消该组勾选，不合并任何记录
  const handleCompareConfirm = (group, keepId) => {
    setCompareGroup(null)
    setCheckedFuzzy((prev) => {
      const next = new Set(prev)
      if (keepId) next.add(group.key)
      else next.delete(group.key)
      return next
    })
    setKeepOverride((prev) => {
      const next = { ...prev }
      if (keepId) next[group.key] = keepId
      else delete next[group.key]
      return next
    })
  }

  const execute = () => {
    const mergeFuzzyKeys = [
      ...dupGroups.filter((g) => checkedFuzzy.has(g.key)),
      ...fuzzyGroups.filter((g) => checkedFuzzy.has(g.key)),
    ].map((g) => g.key)
    // 用户取消勾选的跨行错配改判不应用，保持原样
    const skipCrossRow = crossRowFixes.filter((p) => !checkedCrossRow.has(crossRowKey(p))).map(crossRowKey)
    const { records: cleaned, summary } = cleanRecords(records, { mergeFuzzyKeys, keepOverride, skipCrossRow })
    replaceRecords(cleaned)
    setResultSummary(summary)
    setDone(true)
    if (onDone) onDone(summary)
  }

  // ===== 批量重新识别：用最新算法对全部原件（化验记录 + 检查报告）顺序重跑，逐条出对比 =====
  const docs = useStore().docs
  const totalCount = records.length + docs.length
  const [batch, setBatch] = useState({ running: false, progress: { done: 0, total: 0, current: null }, results: [], finished: false })
  const [openResult, setOpenResult] = useState(null)
  const [appliedIds, setAppliedIds] = useState(() => new Set())
  const cancelRef = useRef(false)

  const startBatch = async () => {
    if (totalCount === 0) return
    cancelRef.current = false
    const items = [
      ...records.map((r) => ({ kind: 'record', ref: r, label: `${r.date} · ${label(r.report_type)}` })),
      ...docs.map((d) => ({ kind: 'doc', ref: d, label: `${d.date} · ${d.doc_type || d.kind}` })),
    ]
    setBatch({ running: true, progress: { done: 0, total: items.length, current: null }, results: [], finished: false })
    const results = await runBatchReRecognize({
      items,
      isCancelled: () => cancelRef.current,
      onProgress: ({ done, total, current }) => setBatch((b) => ({ ...b, progress: { done, total, current } })),
    })
    setBatch((b) => ({ ...b, running: false, results, finished: true }))
  }
  const cancelBatch = () => {
    cancelRef.current = true
  }
  const findSource = (res) =>
    res.kind === 'doc' ? docs.find((d) => d.id === res.id) : records.find((r) => r.id === res.id)

  const statusOf = (r) => {
    if (r.skipped === 'no-image') return { text: '无原件，跳过', cls: 'text-slate-400' }
    if (r.skipped === 'error') return { text: '失败：' + (r.error || ''), cls: 'text-red-600' }
    const d = r.diffCount + (r.dateDiff && r.dateDiff.changed ? 1 : 0)
    if (d > 0) return { text: `已变化 · 差异 ${d} 处`, cls: 'text-orange-600' }
    return { text: '无变化', cls: 'text-slate-400' }
  }

  return (
    <div className="space-y-4">
      {/* 批量重新识别：用最新算法对全部原件顺序重跑，逐条出对比清单 */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold">重新识别（全部）</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              用最新识别算法对全部 {totalCount} 份原件（化验记录 {records.length} + 检查报告 {docs.length}）重跑，
              列出「旧 vs 新」差异，逐条确认后才写入（数据 100% 本机，不会上传）
            </p>
          </div>
          {!batch.running && (
            <Button
              size="small"
              type="primary"
              disabled={totalCount === 0}
              className="!bg-sky-500 hover:!bg-sky-600 !border-0 shrink-0"
              onClick={startBatch}
            >
              重新识别全部（{totalCount}）
            </Button>
          )}
        </div>

        <div className="p-5 space-y-3">
          {batch.running && (
            <div>
              <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                <span>
                  进度 {batch.progress.done}/{batch.progress.total}
                  {batch.progress.current ? ` · 正在识别：${batch.progress.current.label}` : ''}
                </span>
                <Button size="small" danger type="link" onClick={cancelBatch}>
                  取消
                </Button>
              </div>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-sky-500 transition-all"
                  style={{ width: `${batch.progress.total ? (batch.progress.done / batch.progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {batch.finished && batch.results.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500">
                  共 {batch.results.length} 份 · 有变化 {batch.results.filter((r) => !r.skipped && r.diffCount + (r.dateDiff?.changed ? 1 : 0) > 0).length} 份
                </p>
                <Button size="small" onClick={startBatch}>
                  重新运行
                </Button>
              </div>
              <div className="space-y-1.5 max-h-72 overflow-auto">
                {batch.results.map((r, i) => {
                  const st = statusOf(r)
                  const clickable = !r.skipped
                  return (
                    <div
                      key={r.id || i}
                      className={`flex items-center justify-between gap-3 text-xs rounded-lg border px-3 py-2 ${
                        clickable ? 'border-slate-200 bg-slate-50 hover:border-sky-400 cursor-pointer' : 'border-slate-100 bg-slate-50'
                      }`}
                      onClick={() => clickable && setOpenResult(r)}
                    >
                      <div className="min-w-0 flex items-center gap-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${
                            r.kind === 'doc'
                              ? 'bg-purple-50 text-purple-700 border-purple-200'
                              : 'bg-sky-50 text-sky-700 border-sky-200'
                          }`}
                        >
                          {r.kind === 'doc' ? '报告' : '化验'}
                        </span>
                        <span className="truncate text-slate-700">{r.label}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {appliedIds.has(r.id) && <span className="text-emerald-600">已写入 ✓</span>}
                        <span className={st.cls}>{st.text}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {!batch.running && !batch.finished && (
            <p className="text-xs text-slate-400">
              点「重新识别全部」后会在后台逐份重跑（顺序执行，不并行打满 CPU），跑完在此列出可逐份点开审查。
            </p>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold">数据清洗</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              按最新识别规则修正历史记录：内容重映射 / 标题修正 / 重复合并（数据 100% 本机，不会上传）
            </p>
          </div>
          <CloseButton tone="dark" onClick={onClose} />
        </div>

        <div className="p-5 space-y-4">
          {done ? (
            <div className="card p-6 bg-emerald-50 border-emerald-200 text-center">
              <p className="text-lg font-semibold text-emerald-800">✅ 清洗完成</p>
              <p className="text-sm text-emerald-700 mt-1">
                删除重复 {resultSummary ? resultSummary.removeRecords : totals.removeRecords} 条 · 修正标题{' '}
                {totals.titleFixes} 条 · 重映射指标 {totals.pointFixes} 项
              </p>
              <p className="text-xs text-emerald-600 mt-2">
                现有记录 {records.length} 条 → 清洗后 {resultSummary ? resultSummary.recordsAfter : totals.recordsAfter} 条
              </p>
              {(() => {
                const s = resultSummary || totals
                const fixed = s.nameFixed + s.unitFixed + (s.codeReversed || 0)
                const hints = s.unitMismatch + s.refNear + s.refMismatch
                if (fixed + hints + s.suspicious === 0) return null
                return (
                  <p className="text-xs text-emerald-700 mt-2">
                    识别审计：自动修正 {fixed} 项 · 提示 {hints} 项 · 疑错 {s.suspicious} 项
                  </p>
                )
              })()}
              <Button type="primary" size="small" className="mt-4" onClick={onClose}>
                完成
              </Button>
            </div>
          ) : nothing ? (
            <div className="card p-6 bg-emerald-50 border-emerald-200 text-center">
              <p className="text-sm font-medium text-emerald-800">🎉 无需清洗：所有记录已符合最新规则，无重复、标题一致、内容已对齐。</p>
              <Button size="small" className="mt-4" onClick={onClose}>
                关闭
              </Button>
            </div>
          ) : (
            <>
              {/* 统计卡片 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="card p-4 text-center">
                  <p className="text-2xl font-bold text-red-600">
                    {dupGroups.filter((g) => checkedFuzzy.has(g.key)).length}/{dupGroups.length}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">重复记录（勾选合并）</p>
                </div>
                <div className="card p-4 text-center">
                  <p className="text-2xl font-bold text-orange-600">
                    {fuzzyGroups.filter((g) => checkedFuzzy.has(g.key)).length}/{fuzzyGroups.length}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">疑似重复（勾选合并）</p>
                </div>
                <div className="card p-4 text-center">
                  <p className="text-2xl font-bold text-amber-600">{totals.titleFixes}</p>
                  <p className="text-xs text-slate-500 mt-1">报告标题（待修正）</p>
                </div>
              </div>

              {/* 重复记录明细（精确重复，需勾选才合并，绝不自动删除）*/}
              {dupGroups.length > 0 && (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">🔄 重复记录（勾选合并，保留识别最全的一条）</h3>
                  <div className="space-y-2 max-h-48 overflow-auto">
                    {dupGroups.map((g) => (
                      <div
                        key={g.key}
                        className={`text-xs border rounded-lg p-2.5 ${
                          checkedFuzzy.has(g.key) ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50 opacity-60'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-0">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={checkedFuzzy.has(g.key)}
                              onChange={(e) => {
                                const next = new Set(checkedFuzzy)
                                if (e.target.checked) next.add(g.key)
                                else next.delete(g.key)
                                setCheckedFuzzy(next)
                              }}
                            />
                            <span className="min-w-0">
                              <span className="text-slate-800 font-medium">
                                {g.keep.date} · {label(g.keep.report_type)} · {g.keep.data_points.length} 项
                              </span>
                              <br />
                              <span className="text-slate-500">
                                合并重复 {g.remove.length} 条（
                                {g.remove.map((r) => `${r.date} ${label(r.report_type)} ${r.data_points.length}项`).join('；')}）
                              </span>
                            </span>
                          </label>
                          <Button
                            size="small"
                            onClick={() => setCompareGroup(g)}
                            className="!shrink-0 !text-[11px] !px-2 !py-0.5"
                          >
                            打开对比
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 疑似重复明细（隐性重复：识别差异导致值不同） */}
              {fuzzyGroups.length > 0 && (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">
                    ⚠️ 疑似重复（同一化验单因识别差异值不同，需确认）
                  </h3>
                  <p className="text-[11px] text-slate-500 mb-2">
                    同一天同一类型、指标集合高度重合，但数值存在差异（多为小数点错位/列错位导致）。
                    默认勾选合并，若确为同一天真实的两份（如早晚复查），请取消勾选。
                  </p>
                  <div className="space-y-2 max-h-56 overflow-auto">
                    {fuzzyGroups.map((g) => (
                      <div
                        key={g.key}
                        className={`text-xs border rounded-lg p-2.5 ${
                          checkedFuzzy.has(g.key)
                            ? 'border-orange-300 bg-orange-50'
                            : 'border-slate-200 bg-slate-50 opacity-60'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-0">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={checkedFuzzy.has(g.key)}
                              onChange={(e) => {
                                const next = new Set(checkedFuzzy)
                                if (e.target.checked) next.add(g.key)
                                else next.delete(g.key)
                                setCheckedFuzzy(next)
                              }}
                            />
                            <span className="min-w-0">
                              <span className="text-slate-800 font-medium">
                                {g.keep.date} · {label(g.keep.report_type)} · {g.keep.data_points.length} 项
                              </span>
                              <span className="text-orange-600 ml-1">（{g.shift}，保留此条）</span>
                              <br />
                              <span className="text-slate-500">
                                合并 {g.remove.length} 条（
                                {g.remove.map((r) => `${r.data_points.length}项`).join('；')}）
                              </span>
                            </span>
                          </label>
                          <Button
                            size="small"
                            onClick={() => setCompareGroup(g)}
                            className="!shrink-0 !text-[11px] !px-2 !py-0.5"
                          >
                            打开对比
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 标题修正明细 */}
              {titleFixes.length > 0 && (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">🏷 报告标题修正</h3>
                  <div className="space-y-1.5 max-h-48 overflow-auto">
                    {titleFixes.map((t) => (
                      <p key={t.id} className="text-xs text-slate-600">
                        <b className="text-slate-800">{t.date}</b>：{label(t.from)} → <b className="text-brand-700">{label(t.to)}</b>
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {/* 跨行错配改判明细（单独分组、默认勾选、可取消） */}
              {crossRowFixes.length > 0 && (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">
                    ⛓ 跨行错配改判（{crossRowFixes.length} 项 · 整行的 结果/单位/参考范围 实则来自另一指标行）
                  </h3>
                  <p className="text-[11px] text-slate-500 mb-2">
                    如「血小板计数」三列被挂到「红细胞计数」名下。按三列一致性改判项目归属，结果数值原样保留。
                    默认全部勾选，可逐条取消。
                  </p>
                  <div className="space-y-2 max-h-48 overflow-auto">
                    {crossRowFixes.map((p) => {
                      const key = crossRowKey(p)
                      const on = checkedCrossRow.has(key)
                      return (
                        <label key={key} className={`flex items-start gap-2 text-xs border rounded-lg p-2.5 cursor-pointer ${
                          on ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-slate-50 opacity-60'
                        }`}>
                          <Checkbox className="mt-0.5" checked={on} onChange={(e) => {
                            const next = new Set(checkedCrossRow)
                            if (e.target.checked) next.add(key)
                            else next.delete(key)
                            setCheckedCrossRow(next)
                          }} />
                          <span className="min-w-0">
                            <span className="text-slate-800 font-medium">{p.date} · 「{p.original}」</span>
                            <span className="text-slate-500">：{p.from} → </span>
                            <b className="text-sky-700">{p.to}</b>
                            <br />
                            <span className="text-slate-500">{p.reason}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 指标重映射明细（不含跨行错配，那类单独成组） */}
              {pointFixes.filter((p) => p.kind !== 'crossrow').length > 0 && (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">
                    🔧 指标重映射（{pointFixes.filter((p) => p.kind !== 'crossrow').length} 项 · 按原始项目名匹配最新字典）
                  </h3>
                  <div className="space-y-1.5 max-h-48 overflow-auto">
                    {pointFixes.filter((p) => p.kind !== 'crossrow').map((p, i) => (
                      <p key={i} className="text-xs text-slate-600">
                        <b className="text-slate-800">{p.date}</b> · 「{p.original}」
                        {p.kind === 'fill' ? (
                          <span>
                            ：补全为 <b className="text-sky-700">{p.to}</b>
                          </span>
                        ) : p.kind === 'reverse' ? (
                          <span>
                            ：<b className="text-teal-700">数值+参考范围反推修正</b>为 {p.to}
                          </span>
                        ) : (
                          <span>
                            ：{p.from || '未识别'} → <b className="text-sky-700">{p.to}</b>
                          </span>
                        )}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              <div className="card p-4 bg-amber-50 border-amber-200 text-xs text-amber-800 leading-relaxed">
                ⚠️ 清洗将以<b>原始项目名</b>为准重新匹配标准字段（与导入时的「重新匹配」一致）。若您曾手动改过某条记录的标准字段，
                清洗后可能被还原为按原始名匹配的结果，请在下方确认后再执行。执行前建议先「导出」备份。
              </div>

              <div className="flex gap-2 justify-end">
                <Button size="small" onClick={onClose}>
                  取消
                </Button>
                <Button danger type="primary" size="small" onClick={execute}>
                  确认执行清洗（合并 {dupGroups.concat(fuzzyGroups).filter((g) => checkedFuzzy.has(g.key)).reduce((s, g) => s + g.remove.length, 0)} 条重复）
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 两份报告对比弹窗：原图并排核对 + 手动选择保留 + 就地修正指标 */}
      {compareGroup && (
        <CompareModal
          group={compareGroup}
          onClose={() => setCompareGroup(null)}
          onConfirm={(keepId) => handleCompareConfirm(compareGroup, keepId)}
        />
      )}

      {/* 批量重新识别：点开某条结果 → 审查并确认写入 */}
      {openResult &&
        (openResult.kind === 'doc' ? (
          <ReRecognizeDocModal
            doc={findSource(openResult)}
            result={openResult}
            onClose={() => setOpenResult(null)}
            onApplied={() => {
              setAppliedIds((s) => new Set(s).add(openResult.id))
              setOpenResult(null)
            }}
          />
        ) : (
          <ReRecognizeRecordModal
            record={findSource(openResult)}
            result={openResult}
            onClose={() => setOpenResult(null)}
            onApplied={() => {
              setAppliedIds((s) => new Set(s).add(openResult.id))
              setOpenResult(null)
            }}
          />
        ))}
    </div>
  )
}
