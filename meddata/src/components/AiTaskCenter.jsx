// ===================== AI 任务中心（顶栏胶囊 + 抽屉）=====================
// 为什么必须有：AI 精读是 30–70 秒的异步 agent——页面等着用户被绑住、不等则结果无处可去。
// 本组件是「提交后可离开」这个承诺的落点（见 .agents/proposals/ai-first-doc-recognition.md §4.2）。
//
// 真相源是服务端（GET /api/ai-tasks 扫 logs 里的请求/终态文件），localStorage 只补展示信息，
// 所以换浏览器 / 刷新 / 重开页面都不会「任务消失」。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Modal } from 'antd'
import {
  listAllTasksPage,
  fetchTaskResult,
  retryTask,
  postTaskDismiss,
  deleteTaskRemote,
  DELETE_TASK_ERR,
  AI_TASKS_CHANGED,
} from '../utils/docTasks.js'
import { MODE_CN, originLabel, shortId, resumePath, isTestTask } from '../utils/taskMeta.js'
import { AGENT_ROWS_HEADER, agentBodyRows } from '../utils/agentRows.js'

const STATE_META = {
  running: { label: '读图中', cls: 'bg-brand-500/20 text-brand-200 border-brand-400/40' },
  done: { label: '已完成', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30' },
  failed: { label: '失败', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/40' },
  stale: { label: '疑似中断', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/40' },
  rate_limited: { label: '限流', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/40' },
  skipped: { label: '已跳过', cls: 'bg-slate-500/20 text-slate-300 border-slate-400/30' },
  timeout: { label: '超时', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/40' },
}

const CASE_FIELD_CN = {
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

const CONF_CN = { high: '高', medium: '中', low: '低' }
const fmtElapsed = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms || 0}ms`)
const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function AiTaskCenter() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState([])
  // 服务端真实总数（列表可能被 limit 截断）：删一条要能看见数变小，就必须显示真总数而不是本地数组长度
  const [total, setTotal] = useState(0)
  // 服务端默认隐藏的回归/自检任务数（客户端拿不到它们时也要能显示「已隐藏 N 条」+ 给"显示"开关）
  const [testTotal, setTestTotal] = useState(0)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [showTest, setShowTest] = useState(false) // 是否显示回归脚本产生的测试任务
  const [detail, setDetail] = useState(null) // 结果弹层数据
  // 溯源缩略图：任务服务端留存的原始报告图（无原图的任务不显示）
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const boxRef = useRef(null)

  const refresh = async () => {
    // 「显示测试任务」开着时向服务端要 all=1：服务端默认已把回归/自检任务挡在列表外
    const { tasks: list, total: n, testTotal: tn } = await listAllTasksPage({ all: showTest })
    setTasks(list)
    setTotal(n)
    setTestTotal(tn)
    return list
  }

  // 轮询：抽屉打开或仍有进行中任务时勤一点，否则慢一点（避免无谓请求）
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const { tasks: list, total: n, testTotal: tn } = await listAllTasksPage({ all: showTest })
      if (alive) {
        setTasks(list)
        setTotal(n)
        setTestTotal(tn)
      }
    }
    tick()
    const t = setInterval(tick, open || tasks.some((x) => x.state === 'running' || x.state === 'stale') ? 6000 : 30000)
    // 任意页面上的删除 / 丢弃 / 采用都立刻刷新，不等下一次轮询（用户点完 30s 内看到的是旧数字 = "点了没用"）
    const onChanged = () => tick()
    window.addEventListener(AI_TASKS_CHANGED, onChanged)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener(AI_TASKS_CHANGED, onChanged)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showTest, tasks.map((x) => x.state).join(',')])

  // 点击外部收起
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (!boxRef.current || boxRef.current.contains(e.target)) return
      // 弹层（确认删除 / 查看结果）渲染在 body 的 portal 里，点它不该收起抽屉：
      // 否则「点删除 → 确认 → 抽屉已关」看不到行消失、也看不到计数变小，用户会判定"点了没用"。
      if (e.target && e.target.closest && e.target.closest('.ant-modal-root, .ant-modal-wrap, .ant-modal')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // 默认只显示"你的"任务：回归脚本提交的 docverify-* 混在里面会让列表全是 source.txt
  //（实测 134 条测试 vs 27 条真实）。勾选「含测试任务」才显示，且它们永不进角标计数。
  const realTasks = useMemo(() => (showTest ? tasks : tasks.filter((t) => !isTestTask(t))), [tasks, showTest])
  const running = realTasks.filter((t) => t.state === 'running' || t.state === 'stale')
  const failed = realTasks.filter((t) => t.state === 'failed' || t.state === 'rate_limited' || t.state === 'timeout')
  // 「待核对」不含已丢弃：丢弃是明确表态（这条结果不要了），再挂在角标上就是打扰
  const pending = realTasks.filter((t) => t.state === 'done' && !t.reviewed && !t.dismissed)
  const dismissed = realTasks.filter((t) => t.dismissed)
  const filtered = useMemo(() => {
    if (filter === 'running') return running
    if (filter === 'pending') return pending
    if (filter === 'failed') return failed
    if (filter === 'dismissed') return dismissed
    // 「全部」里把已丢弃的排到末尾（默认仍可找回，但不再占据视线）
    return realTasks.slice().sort((a, b) => Number(!!a.dismissed) - Number(!!b.dismissed))
  }, [filter, realTasks, running, pending, failed, dismissed])
  const testCount = tasks.filter((t) => isTestTask(t)).length

  const badge = running.length > 0 ? `${running.length}` : pending.length > 0 ? `${pending.length}` : ''
  const tone = failed.length
    ? 'border-amber-400/40 text-amber-200'
    : running.length
      ? 'border-brand-400/40 text-brand-200'
      : pending.length
        ? 'border-emerald-400/40 text-emerald-200'
        : 'border-slate-600 text-slate-300'

  const showDetail = async (id) => {
    setDetailLoading(true)
    setDetail({ id })
    const r = await fetchTaskResult(id)
    setDetail({ id, result: r })
    setDetailLoading(false)
  }

  const doRetry = async (id) => {
    setBusy(id)
    await retryTask(id)
    setBusy('')
    refresh()
  }

  // 彻底删除（不可逆）：物理删掉这次识别的产物。不可撤销，必须二次确认。
  const doDelete = (id, label) => {
    Modal.confirm({
      title: '删除这条识别结果？',
      content: `将永久删除 ${label || '这条任务'} 的原图与识别结果（不可恢复，也不影响已归档的报告）。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setBusy(id)
        const r = await deleteTaskRemote(id)
        setBusy('')
        if (!r.ok) {
          Modal.error({
            title: '删除失败',
            content: DELETE_TASK_ERR[r.error] || `请稍后重试（${r.error}）`,
          })
        } else {
          // 乐观移除：删成功就当场从列表与总数里拿掉，不等服务端回列表（否则又被 limit 补位看着"没删掉"）
          setTasks((prev) => prev.filter((t) => t.id !== id))
          setTotal((n) => Math.max(0, n - 1))
        }
        refresh()
      },
    })
  }

  // 丢弃 / 撤销丢弃：必须写服务端，否则刷新后行又回来（原「移除」就是这个毛病）
  const doDismiss = async (id, dismissed) => {
    setBusy(id)
    const r = await postTaskDismiss(id, dismissed)
    setBusy('')
    if (!r.ok && r.error) console.warn('丢弃失败：', r.error)
    refresh()
  }

  const FILTERS = [
    ['all', `全部 ${realTasks.length}`],
    ['running', `进行中 ${running.length}`],
    ['pending', `待核对 ${pending.length}`],
    ['failed', `失败 ${failed.length}`],
    ...(dismissed.length ? [['dismissed', `已丢弃 ${dismissed.length}`]] : []),
  ]

  return (
    <div className="relative shrink-0" ref={boxRef}>
      <button
        type="button"
        data-testid="ai-task-pill"
        aria-expanded={open}
        className={`btn-top border ${tone} ${open ? 'brightness-125' : 'hover:brightness-125'}`}
        onClick={() => setOpen((v) => !v)}
        title="AI 识别任务：提交后可离开页面，结果在这里；点开查看进度与结果"
      >
        AI 任务{badge ? ` ${badge}` : ''}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-[26rem] max-h-[70vh] overflow-auto rounded-xl bg-slate-800 border border-slate-600 shadow-2xl text-left z-40"
          data-testid="ai-task-drawer"
        >
          <div className="px-3 py-2 text-[11px] text-slate-400 border-b border-slate-700 flex items-center justify-between sticky top-0 bg-slate-800">
            <span>AI 识别任务</span>
            <button className="underline hover:text-slate-200" onClick={refresh}>
              刷新
            </button>
          </div>

          <div className="px-3 py-2 flex gap-1 border-b border-slate-700/60">
            {FILTERS.map(([k, label]) => (
              <button
                key={k}
                data-testid={`ai-task-filter-${k}`}
                onClick={() => setFilter(k)}
                className={`rounded px-2 py-1 text-[10px] border ${
                  filter === k ? 'bg-sky-500/20 text-sky-300 border-sky-400/40' : 'border-slate-600 text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {total > tasks.length && (
            <div className="px-3 py-1.5 border-b border-slate-700/60 text-[10px] text-amber-300/80">
              服务端共 {total} 条，这里只列出最近 {tasks.length} 条（单次最多 500 条）
            </div>
          )}
          {testCount > 0 || testTotal > 0 ? (
            <div className="px-3 py-1.5 border-b border-slate-700/60 flex items-center justify-between text-[10px] text-slate-400">
              <span>
                {showTest
                  ? `已显示 ${testCount} 条回归测试任务`
                  : `已隐藏 ${Math.max(testCount, testTotal)} 条回归测试任务（docverify-* / source.txt 之类，不是你的文件）`}
              </span>
              <button className="underline hover:text-slate-200" onClick={() => setShowTest((v) => !v)}>
                {showTest ? '隐藏测试任务' : '显示'}
              </button>
            </div>
          ) : null}

          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-[11px] text-slate-500 text-center">
              暂无任务。在检查报告导入页点「AI 识别」后，任务会出现在这里（提交完可以离开页面）。
            </p>
          ) : (
            <ul>
              {filtered.map((t) => {
                const meta = STATE_META[t.state] || STATE_META.running
                return (
                  <li key={t.id} className="px-3 py-2 border-b border-slate-700/50 last:border-0" data-testid={`ai-task-row-${t.state}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] rounded border px-1.5 py-0.5 shrink-0 ${meta.cls}`}>{meta.label}</span>
                      <span className="text-xs text-slate-200 truncate">{t.fileName}</span>
                      <span className="ml-auto text-[10px] text-slate-500 shrink-0">{fmtTime(t.requestedAt)}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-slate-400 flex flex-wrap gap-x-2">
                      <span className="text-slate-300">{shortId(t.id)}</span>
                      <span>{MODE_CN[t.mode] || '读原图'}</span>
                      <span>{originLabel(t.origin)}</span>
                      <span>用时 {fmtElapsed(t.elapsedMs)}</span>
                      {t.confidence && <span>置信度 {CONF_CN[t.confidence] || t.confidence}</span>}
                      {t.retried > 0 && <span>已自动重试 {t.retried} 次</span>}
                      {t.state === 'done' && (
                        <span className={t.dismissed ? 'text-slate-500' : ''}>
                          {t.docId ? '已归档' : t.dismissed ? '已丢弃' : t.reviewed ? '已采用' : '待核对'}
                        </span>
                      )}
                    </div>
                    {t.summary && <p className="mt-1 text-[11px] text-slate-300 line-clamp-2">{t.summary}</p>}
                    <div className="mt-1.5 flex gap-2 flex-wrap">
                      {t.state === 'done' && (
                        <button
                          className="text-[10px] underline text-emerald-300 hover:text-emerald-200"
                          title="回到检查报告导入页，用这条结果继续核对并归档（不重新读图、不重复计费）"
                          onClick={() => {
                            setOpen(false)
                            navigate(resumePath(t))
                          }}
                        >
                          继续导入
                        </button>
                      )}
                      {t.state === 'done' && t.docId && (
                        <button
                          className="text-[10px] underline text-sky-300 hover:text-sky-200"
                          title="打开这条结果归档到的那份报告"
                          onClick={() => {
                            setOpen(false)
                            navigate(`/reports?tab=doc&open=${encodeURIComponent(t.docId)}`)
                          }}
                        >
                          打开归档
                        </button>
                      )}
                      {t.state === 'done' && (
                        <button className="text-[10px] underline text-sky-300 hover:text-sky-200" onClick={() => showDetail(t.id)}>
                          查看结果
                        </button>
                      )}
                      {(t.state === 'failed' || t.state === 'stale' || t.state === 'timeout') && (
                        <button
                          className="text-[10px] underline text-amber-300 hover:text-amber-200 disabled:opacity-50"
                          disabled={busy === t.id}
                          onClick={() => doRetry(t.id)}
                        >
                          {busy === t.id ? '重试中…' : '重试'}
                        </button>
                      )}
                      {t.state === 'running' && (
                        <button className="text-[10px] underline text-sky-300 hover:text-sky-200" onClick={() => showDetail(t.id)}>
                          查看进度
                        </button>
                      )}
                      {t.dismissed ? (
                        <button
                          className="text-[10px] underline text-slate-400 hover:text-slate-200 disabled:opacity-50"
                          disabled={busy === t.id}
                          title="撤销丢弃，这条结果会回到「待核对」"
                          onClick={() => doDismiss(t.id, false)}
                        >
                          撤销丢弃
                        </button>
                      ) : (
                        <button
                          className="text-[10px] underline text-slate-400 hover:text-slate-200 disabled:opacity-50"
                          disabled={busy === t.id}
                          title="不要这条结果了（可撤销；产物文件仍保留在服务端，不重复计费）"
                          onClick={() => doDismiss(t.id, true)}
                        >
                          丢弃
                        </button>
                      )}
                      {!t.docId && (t.state === 'done' || t.state === 'failed') && (
                        <button
                          className="text-[10px] underline text-rose-300 hover:text-rose-200 disabled:opacity-50"
                          disabled={busy === t.id}
                          title="永久删除这条结果（含原图与识别产物，不可恢复）"
                          onClick={() => doDelete(t.id, t.fileName)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <Modal
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={null}
        width={760}
        title={`AI 识别结果${detail && detail.result && detail.result.doc_type ? ' · ' + detail.result.doc_type : ''}`}
      >
        {detailLoading ? (
          <p className="py-6 text-center text-xs text-slate-400">读取中…</p>
        ) : detail && detail.result && detail.result.state === 'done' ? (
          <div className="space-y-3 text-sm max-h-[70vh] overflow-auto">
            {/* 溯源条：这份结果对应哪张图、哪次任务、哪个入口 —— 用户核对「是不是这一份」的唯一依据 */}
            {(() => {
              const t = tasks.find((x) => x.id === detail.id) || {}
              return (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 flex items-start gap-3" data-testid="ai-task-trace">
                  <img
                    src={`/api/ai-task-image?id=${encodeURIComponent(detail.id)}`}
                    alt=""
                    title={t.sha256 ? `原件 sha256: ${t.sha256}` : ''}
                    className="w-16 h-20 object-cover rounded border border-slate-200 bg-white shrink-0"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none'
                    }}
                  />
                  <div className="min-w-0 text-[11px] text-slate-500 leading-5">
                    <p className="text-slate-700 font-medium truncate" title={t.fileName || ''}>
                      源文件：{t.fileName || '(未记录文件名)'}
                    </p>
                    <p>
                      <a
                        className="underline text-sky-700 hover:text-sky-900"
                        href={`/api/ai-task-file?id=${encodeURIComponent(detail.id)}`}
                        target="_blank"
                        rel="noreferrer"
                        title="打开这次识别用的原件（图片 / PDF）"
                      >
                        打开原件
                      </a>
                      <span className="text-slate-400">（图片走缩略图，PDF 走新窗口）</span>
                    </p>
                    <p>
                      <span className="text-slate-600">{shortId(detail.id)}</span> · {MODE_CN[t.mode] || '读原图'} ·{' '}
                      {originLabel(t.origin)}
                    </p>
                    <p>提交 {fmtTime(t.requestedAt) || '—'}{t.docId ? ' · 已归档' : t.reviewed ? ' · 已采用' : ' · 待核对'}</p>
                  </div>
                </div>
              )
            })()}
            <div className="text-xs text-slate-500">
              {detail.result.date || ''} {detail.result.time || ''}
              {detail.result.part ? ` · ${detail.result.part}` : ''}
              {detail.result.confidence && detail.result.confidence.overall
                ? ` · 置信度 ${CONF_CN[detail.result.confidence.overall] || detail.result.confidence.overall}`
                : ''}
            </div>
            {detail.result.title && <p className="font-medium text-slate-800">{detail.result.title}</p>}
            {/* 化验转录（mode:'lab'）的产物是 rows=[名称,结果,参考,单位]，不是 title/findings。
                不在这里渲染 → 这类任务点「查看结果」是一片空白（2026-10-28 #ruyd81 用户现场）。 */}
            {Array.isArray(detail.result.rows) &&
              detail.result.rows.length > 0 &&
              (() => {
                const body = agentBodyRows(detail.result.rows)
                return (
                  <section data-testid="ai-task-rows">
                    <h4 className="text-xs font-semibold text-slate-500 mb-1">识别指标（{body.length} 项）</h4>
                    <div className="rounded border border-slate-200 overflow-hidden max-h-72 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-slate-500 sticky top-0">
                          <tr>
                            {AGENT_ROWS_HEADER.map((h) => (
                              <th key={h} className="text-left font-medium px-2 py-1 whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {body.map((r, i) => (
                            <tr key={i} className="border-t border-slate-100">
                              {AGENT_ROWS_HEADER.map((_, j) => (
                                <td key={j} className="px-2 py-1 text-slate-700">
                                  {String(r?.[j] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">
                      化验转录结果。点下方「继续导入并核对」把它落成检验记录草稿（不重新读图、不重复计费）。
                    </p>
                  </section>
                )
              })()}
            {detail.result.findings && (
              <section>
                <h4 className="text-xs font-semibold text-slate-500 mb-1">检查所见</h4>
                <p className="text-xs text-slate-700 whitespace-pre-wrap">{detail.result.findings}</p>
              </section>
            )}
            {detail.result.conclusion && (
              <section>
                <h4 className="text-xs font-semibold text-slate-500 mb-1">诊断结论</h4>
                <p className="text-xs text-slate-700 whitespace-pre-wrap">{detail.result.conclusion}</p>
              </section>
            )}
            {detail.result.fields &&
              typeof detail.result.fields === 'object' &&
              Object.keys(detail.result.fields).length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold text-slate-500 mb-1">结构化字段</h4>
                  <div className="space-y-1">
                    {Object.entries(detail.result.fields).map(([k, v]) =>
                      v ? (
                        <p key={k} className="text-xs text-slate-700">
                          <span className="text-slate-400">{CASE_FIELD_CN[k] || k}：</span>
                          <span className="whitespace-pre-wrap">{String(v)}</span>
                        </p>
                      ) : null
                    )}
                  </div>
                </section>
              )}
            {Array.isArray(detail.result.measures) && detail.result.measures.length > 0 && (
              <section>
                <h4 className="text-xs font-semibold text-slate-500 mb-1">关键测量值</h4>
                <div className="flex flex-wrap gap-2">
                  {detail.result.measures.map((m, i) => (
                    <span key={i} className="text-[11px] rounded bg-slate-100 px-2 py-0.5 text-slate-600">
                      {m.name} {m.value}
                      {m.unit}
                    </span>
                  ))}
                </div>
              </section>
            )}
            {detail.result.notes && (
              <section>
                <h4 className="text-xs font-semibold text-slate-500 mb-1">AI 说明</h4>
                <p className="text-[11px] text-slate-500 whitespace-pre-wrap">{detail.result.notes}</p>
              </section>
            )}
            {Array.isArray(detail.result.evidence) && detail.result.evidence.length > 0 && (
              <details className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <summary className="text-[11px] text-slate-500 cursor-pointer">原文引文（{detail.result.evidence.length} 条）</summary>
                <div className="mt-1 space-y-1">
                  {detail.result.evidence.map((e, i) => (
                    <p key={i} className="text-[11px] text-slate-500">
                      <span className="text-slate-400">{e.field}:</span> 「{e.quote}」
                    </p>
                  ))}
                </div>
              </details>
            )}
            {/* 底部动作：结果必须能"用起来"，而不只是"看一眼"（2026-10-25 用户当场质疑的核心） */}
            <div className="border-t border-slate-100 pt-2 flex flex-wrap items-center gap-2">
              {(() => {
                const t = tasks.find((x) => x.id === detail.id) || {}
                return (
                  <>
                    <Button
                      type="primary"
                      size="small"
                      onClick={() => {
                        setDetail(null)
                        setOpen(false)
                        // mode 必须一起带：lab（化验转录）回检验报告导入页，doc 回检查报告导入页
                        navigate(
                          resumePath({
                            id: detail.id,
                            origin: (tasks.find((x) => x.id === detail.id) || {}).origin,
                            mode: (tasks.find((x) => x.id === detail.id) || {}).mode,
                          })
                        )
                      }}
                    >
                      继续导入并核对
                    </Button>
                    {t.docId && (
                      <Button
                        size="small"
                        onClick={() => {
                          setDetail(null)
                          setOpen(false)
                          navigate(`/reports?tab=doc&open=${encodeURIComponent(t.docId)}`)
                        }}
                      >
                        打开已归档报告
                      </Button>
                    )}
                    <button
                      className="text-[11px] underline text-slate-400 hover:text-slate-600 disabled:opacity-50"
                      disabled={busy === detail.id}
                      title="不要这条结果了（可撤销；产物文件仍保留，不重复计费）"
                      onClick={async () => {
                        await doDismiss(detail.id, !(tasks.find((x) => x.id === detail.id) || {}).dismissed)
                        setDetail(null)
                      }}
                    >
                      {(tasks.find((x) => x.id === detail.id) || {}).dismissed ? '撤销丢弃' : '丢弃这条结果'}
                    </button>
                    {!((tasks.find((x) => x.id === detail.id) || {}).docId) && (
                      <button
                        className="text-[11px] underline text-rose-400 hover:text-rose-600 disabled:opacity-50"
                        disabled={busy === detail.id}
                        title="永久删除这条结果（含原图与识别产物，不可恢复）"
                        onClick={() => {
                          const t = tasks.find((x) => x.id === detail.id) || {}
                          doDelete(detail.id, t.fileName)
                          setDetail(null)
                        }}
                      >
                        删除结果
                      </button>
                    )}
                    <span className="text-[11px] text-slate-400">
                      继续导入不会再读图、不会重复计费；报告已归档时也可在该记录详情页点「AI 重读」按字段采用。
                    </span>
                  </>
                )
              })()}
            </div>
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-slate-500">
            {detail && detail.result && detail.result.state === 'running' ? '仍在读图，稍后刷新查看' : '暂无结果（任务未完成或已中断）'}
          </div>
        )}
      </Modal>
    </div>
  )
}
