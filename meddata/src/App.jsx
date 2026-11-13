// ===================== MedData-AI：个人医疗检测数据管理 =====================
// 首页 = 数据大屏（仪表盘）；「添加数据」一键导入（上传 → 自动 OCR → 核对保存）

import { useCallback, useEffect, useRef, useState, useMemo, Component } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { pageVariants } from './motion/presets.js'
import Dashboard from './components/Dashboard.jsx'
import TempManagePage from './components/TempManagePage.jsx'
import ImportFlow from './components/ImportFlow.jsx'
import ExportPanel from './components/ExportPanel.jsx'
import ReportDetail from './components/ReportDetail.jsx'
import DocImportFlow from './components/DocImportFlow.jsx'
import DocDetail from './components/DocDetail.jsx'
import CleanPanel from './components/CleanPanel.jsx'
import CBCDetailView from './components/CBCDetailView.jsx'
import CoursePage from './components/CoursePage.jsx'
import CostPage from './components/CostPage.jsx'
import InvoiceImportFlow from './components/InvoiceImportFlow.jsx'
import ReportsPage from './components/ReportsPage.jsx'
import CasesSection from './components/CasesSection.jsx'
import CaseImportFlow from './components/CaseImportFlow.jsx'
import CaseDetail from './components/CaseDetail.jsx'
import TopNav from './components/TopNav.jsx'
import AiTaskCenter from './components/AiTaskCenter.jsx'
import SettingsPage from './components/SettingsPage.jsx'
import { useStore, deleteDoc, docCategory } from './data/store.js'
import { reportTypeLabel } from './data/dictionary.js'
import { gotoTrendNav } from './utils/trendNav.js'
import { countBacklog, flushFeedbackBacklog } from './utils/feedback.js'
import { flushReviewBacklog } from './utils/review.js'
import { warmupOcr } from './utils/ocr.js'
import { useDevBridge } from './devBridge.js'
import { setPendingFiles, peekFiles, getLastSelfToken, setPendingText, clearPendingText } from './utils/pendingImport.js'
import { detectReportKind } from './utils/reportKind.js'
import { ocrTextFast, pdfTextLayer, pdfFirstPageToDataUrl } from './utils/ocr.js'
import { downscaleImage, toPdfDataUrl } from './components/ImageUploader.jsx'
import { initDataSource } from './utils/apiStore.js'
import SyncDot from './components/SyncDot.jsx'
import CloseButton from './components/CloseButton.jsx'
import { useEscClose, useBodyScrollLock } from './utils/overlay.js'
import { whenReady } from './data/store.js'

import appVersion from './data/app-version.json'

// 路由级错误边界：任一页面渲染抛错时，不再整页白屏，而是显示可复制的报错堆栈，便于定位。
// key 用 location.pathname：切换路由时自动重置，崩过的页面点其它导航即可恢复。
class RouteErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('[RouteErrorBoundary]', error, info)
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const msg = String((error && error.stack) || error || '未知错误')
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h2 className="text-base font-semibold text-rose-600">页面渲染出错（已阻止白屏）</h2>
        <p className="mt-2 text-sm text-slate-600">
          本页组件渲染时抛错。下面是错误详情，复制给我即可定位修复。
        </p>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
          {msg}
        </pre>
        <div className="mt-3 flex gap-2">
          <button className="btn-secondary" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              window.location.hash = '#/'
              window.location.reload()
            }}
          >
            回到首页
          </button>
        </div>
      </div>
    )
  }
}

function Toast({ toast }) {
  if (!toast) return null
  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-5 py-3 rounded-xl text-sm font-medium shadow-2xl text-white ${
        toast.type === 'error' ? 'bg-red-600' : 'bg-emerald-600'
      }`}
    >
      {toast.msg}
    </div>
  )
}

// 添加报告路由页：检验（化验）与检查报告**共用一条导入路由** `/reports/add?flow=lab|doc`。
// 为什么合：两条链路本来就共用同一套骨架（pendingImport 文件缓存 + 批次翻页 + 类型改判 + 回跳），
// 分成两个顶级页只带来两跳与「改判后回跳丢 tab」的毛病。合并后 lab ↔ doc 改判是**就地换手势**
// （只换 flow 参数，key 变化强制重挂载，pending 文件不丢）；改判成病历文书仍跳独立模块 /cases/add
// ——文书是另一类实体（出院记录/诊断证明），不并入报告页。
// 旧路由 /records/add、/archive/add 保留（书签 + e2e 脚本直连），用 forcedFlow 固定流向。
function AddReportPage({ navigate, location, showToast, forcedFlow }) {
  // 待导入文件一律由**导航显式携带**（state.token）：改判流向时由导入页现场登记并带过来
  // （见 pendingImport.ensurePendingSlot）。只有"整页直开、没有任何导航 state"（书签 / e2e 直连
  // 老路由）才回退读模块级自登记槽——那个槽是全局单值，可能是上一批文件，带 state 的导航回退它
  // 会把别的批次张冠李戴（2026-10-27 排查 mlz7n 时确认）。
  // ⚠ token 只解析**一次**并缓存：`getLastSelfToken()` 是模块级可变槽，若每次渲染都读，
  // 任何一次无关的 re-render（例如在「待确认新项」面板点确认 → 写 store → App 重渲染）
  // 都会让 `key={lab-${token}-${index}}` 变化 → ImportFlow 重挂载 → 整页 OCR 从头再跑一遍
  // （2026-10-24 实测：确认新项后页面回到「正在识别化验单表格」）。只有**新导航携带新 token**
  // （又拖入了另一批文件）时才更新。
  const navToken = location.state?.token || ''
  const tokenRef = useRef(navToken || (location.state ? '' : getLastSelfToken()))
  if (navToken && navToken !== tokenRef.current) tokenRef.current = navToken
  else if (!navToken && location.state && tokenRef.current) tokenRef.current = ''
  const token = tokenRef.current
  const search = new URLSearchParams(location.search)
  const flow = forcedFlow || (search.get('flow') === 'doc' ? 'doc' : 'lab')
  const index = Number(search.get('i') || 0)
  const total = token ? peekFiles(token).length : 0

  // 回跳：从报告页进来时一律落到「刚保存的那类报告」对应 tab——否则在「检查」tab 上导入完
  // 一份检查报告、回来却发现停在「检验」tab，看不到自己刚存的东西。
  const fromState = location.state?.from
  const backTo =
    fromState && !fromState.startsWith('/reports') && !fromState.startsWith('/records') && !fromState.startsWith('/archive')
      ? fromState
      : `/reports?tab=${flow}`
  const back = () => navigate(backTo, { replace: true })
  const advance = () => {
    if (total > 1 && index < total - 1) {
      navigate(`/reports/add?flow=${flow}&i=${index + 1}&n=${total}`, { state: { token, from: fromState }, replace: true })
    } else {
      back()
    }
  }
  // 改判流向：导入页可能现场登记了一份**新** token（页内上传 / 从 AI 任务恢复的草稿），
  // 那份才装着用户眼前这份文件；URL 上的 token 是"切过来之前"那批，照它走会丢文件或张冠李戴。
  // 故 opts.token 一旦显式给出（含空串＝确实没有文件），就以它为准。
  const switchFlow = (next, opts = {}) => {
    const path = next === 'case' ? '/cases/add' : addPathFor(next === 'doc' ? 'doc' : 'lab')
    const carried = opts.token !== undefined
    const useToken = carried ? opts.token : token
    const useIndex = carried ? opts.index || 0 : index
    const useTotal = carried ? (useToken ? peekFiles(useToken).length : 1) : total
    navigate(withTask(withBatch(path, useIndex, useTotal), opts.taskId), { state: { token: useToken, from: fromState }, replace: true })
  }
  // ?task=<id>：从「AI 任务」回来继续业务线（见 DocImportFlow::loadFromTask）
  const taskId = search.get('task') || ''
  return flow === 'doc' ? (
    <DocImportFlow
      key={`doc-${token}-${index}-${taskId}`}
      onClose={back}
      onSaved={() => showToast('报告已归档（原件 + 解析索引）')}
      pendingToken={token}
      pendingIndex={index}
      batchTotal={total}
      onAdvance={advance}
      onSwitchFlow={switchFlow}
      taskId={taskId}
      onOpenDoc={(docId) => navigate(`/reports?tab=doc&open=${encodeURIComponent(docId)}`)}
    />
  ) : (
    <ImportFlow
      key={`lab-${token}-${index}-${taskId}`}
      onClose={back}
      onSaved={(date, n) => showToast(`已归档 ${date} 的化验记录（${n} 项指标）`)}
      pendingToken={token}
      pendingIndex={index}
      batchTotal={total}
      onAdvance={advance}
      onSwitchFlow={switchFlow}
      taskId={taskId}
    />
  )
}

// 添加病历文书路由页：与 AddReportPage 对称，进入后顶栏导航随时可离开。
function AddCasePage({ navigate, location, showToast }) {
  // 同 AddReportPage：token 只解析一次并缓存，避免无关 re-render 改 key 导致 ImportFlow 重挂载重跑
  const navToken = location.state?.token || ''
  const tokenRef = useRef(navToken || (location.state ? '' : getLastSelfToken()))
  if (navToken && navToken !== tokenRef.current) tokenRef.current = navToken
  else if (!navToken && location.state && tokenRef.current) tokenRef.current = ''
  const token = tokenRef.current
  const from = location.state?.from || '/cases'
  const search = new URLSearchParams(location.search)
  const index = Number(search.get('i') || 0)
  const total = token ? peekFiles(token).length : 0
  // ?manual=1：无原件手动录入入口（文书页「手动录入（无原件）」进入，不经过上传）
  const initialManual = search.get('manual') === '1'

  const back = () => navigate(from, { replace: true })
  const advance = () => {
    if (total > 1 && index < total - 1) {
      navigate(`/cases/add?i=${index + 1}&n=${total}`, { state: { token, from }, replace: true })
    } else {
      back()
    }
  }
  // 改判到报告类（检验 / 检查）统一走合并后的报告导入路由；改判为文书留在本模块
  // 同 AddReportPage.switchFlow：以导入页显式携带的 token 为准
  const switchFlow = (flow, opts = {}) => {
    const path = flow === 'case' ? '/cases/add' : addPathFor(flow === 'doc' ? 'doc' : 'lab')
    const carried = opts.token !== undefined
    const useToken = carried ? opts.token : token
    const useIndex = carried ? opts.index || 0 : index
    const useTotal = carried ? (useToken ? peekFiles(useToken).length : 1) : total
    navigate(withTask(withBatch(path, useIndex, useTotal), opts.taskId), { state: { token: useToken, from }, replace: true })
  }
  // ?task=<id>：从「AI 任务」回来继续业务线（见 CaseImportFlow::loadFromTask）
  const taskId = search.get('task') || ''
  return (
    <CaseImportFlow
      key={`case-${token}-${index}${initialManual ? '-manual' : ''}-${taskId}`}
      initialManual={initialManual}
      taskId={taskId}
      onClose={back}
      onSaved={(m) => showToast(m || '病历文书已归档（原件 + 结构化字段）')}
      pendingToken={token}
      pendingIndex={index}
      batchTotal={total}
      onAdvance={advance}
      onSwitchFlow={switchFlow}
    />
  )
}

// 导入页路径：报告类统一 /reports/add?flow=lab|doc，文书留在独立模块
const addPathFor = (flow) => (flow === 'case' ? '/cases/add' : `/reports/add?flow=${flow}`)

// 批次翻页参数：单份文件不挂 i/n（URL 干净，也避免 n=0 这种无意义噪声）
const batchQuery = (index, total) => (total > 1 ? `i=${index}&n=${total}` : '')

// 带批次参数的跳转地址
const withBatch = (path, index, total) => {
  const q = batchQuery(index, total)
  return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path
}

// 附加 ?task=<id>：改判到另一页时把「这条 AI 任务」一起带过去。原件带不过去的任务
// （doc-text 没有落图 / 原图副本已清）靠它在目标页 loadFromTask 里接住已完成结果。
const withTask = (path, taskId) =>
  taskId ? `${path}${path.includes('?') ? '&' : '?'}task=${encodeURIComponent(taskId)}` : path

// AI 反馈工作状态徽章（顶栏常驻）：轮询 server.mjs 的 /api/feedback-status，
// 展示反馈队列处理进度与最近一次 AI 分析结论（复现 PASS/FAIL、建议改动层）。
// 服务端未启动或队列为空时静默隐藏，不打扰用户。
// 把 AI 的「建议改动层」技术描述翻译成用户能懂的直白话：去掉 JS 文件名，只说改了什么。
// 仅影响界面展示；底层 feedback 文件里的原始技术文本保持不变（AI 链路仍读精确信息）。
const HUMAN_LAYER = [
  ['ocr.js 读值 / normalize.js 数值解析', '修正具体数值读错'],
  ['dictionary.js 标准档案 / normalize.js 单位·参考归一', '修正单位识别乱码'],
  ['dictionary.js 别名表 / normalize.js 字段映射', '补全项目别名，修正项目名识别错乱'],
  ['（无 manual 值修改，仅 diff 统计，无直接算法改动点）', '本次未改动算法（无手动数值修正）'],
  ['（复现 FAIL 条目为算法当前仍未识别对，优先按上面层修）', ''],
]
const humanSuggestLayer = (text) => {
  if (!text) return text
  return text
    .split('；')
    .map((p) => {
      const t = p.trim()
      const hit = HUMAN_LAYER.find(([from]) => t === from || t.startsWith(from))
      return hit ? hit[1] : t
    })
    .filter(Boolean)
    .join('；')
}

const MODE_LABEL = {
  oneshot: '一次性 CLI',
  off: '仅分析',
}
const MODE_TIP = {
  oneshot: '一次提交 = 一个独立 agent 会话（dsh headless）：成本最低、进程隔离（默认）',
  off: '只自动分析，不自动调用 agent，结果留在队列由人工处理',
}
// —— 反馈卡片的人话翻译层 ——
// 背景（2026-09-04 用户反馈「记录里的信息我看不懂」）：卡片此前直接铺内部产物——
//   ❌ FAIL [VALUE] expect={"code":"LYM_ABS",...}、suggestLayer「dictionary.js 标准档案 / normalize.js 单位归一」
// 这些是给 AI/开发排查用的，对用户是天书。故卡片只留两句人话（现状 + AI 干了什么），
// 原始 diff / 层名 / AI 完整说明一律收进「详情」折叠区，想深挖再看。
const verifySentence = (rs, processed) => {
  if (!processed) return '正在分析你的修改…'
  const fails = (rs?.failLines || []).filter((l) => l.includes('❌')).length
  if (rs?.verify === 'FAIL') return `用最新算法重跑，仍有 ${fails || rs?.expectedCount || '若干'} 项和你的修正不一致`
  if (rs?.verify === 'PASS') return '用最新算法重跑，已和你的修正完全一致'
  if (rs?.verify === 'SKIP-NO-VALUE') return '这次没填手动修正值，无法核验对错（只记了改动统计）'
  if (rs?.verify === 'SKIP-NO-IMAGE') return '原图缺失，无法复现核验'
  if (rs?.verify === 'UNKNOWN') return '核验未完成'
  return '尚未核验'
}
// 注意 doneStatus==='done' 但复现仍 FAIL 的情况：agent 自报「已处理并存档」，
// 但算法并没修好（多是 OCR 读图层问题改不动），此时绝不能显示「已修复」——
// 那正是用户看到「已修复存档」+「复现失败」并列时看不懂的根源。
const agentHeadline = (A, rs) => {
  const v = rs?.verify
  if (A?.state === 'done' && A.doneStatus === 'done') {
    if (v === 'FAIL') {
      return {
        tone: 'text-amber-300',
        title: 'AI 已处理：这次没修成',
        desc: 'AI 判断错在图片识别环节（不是匹配规则），暂时改不动；已把该报告存为防退化样例，以后不许更差',
      }
    }
    return { tone: 'text-emerald-300', title: `已修复并存档 ${A.tag || 'v' + (A.doneVersion || '?')}`, desc: '算法已升级，问题已修掉' }
  }
  if (A?.state === 'done' && A.doneStatus === 'skipped') {
    return { tone: 'text-slate-400', title: 'AI 已看：无需改动', desc: 'AI 分析后认为算法不需要调整' }
  }
  if (A?.state === 'done' && A.doneStatus === 'failed') {
    return { tone: 'text-amber-300', title: 'AI 已排查：确认修不了', desc: 'AI 查过后判定当前算法无法修正，已存档备查' }
  }
  if (A?.state === 'failed') {
    const t = A.resetAt
      ? new Date(A.resetAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : ''
    return {
      tone: 'text-red-300',
      title: 'AI 处理中断',
      desc: A.rateLimited ? `账号用量超限，${t} 恢复后自动重试` : 'AI 会话异常中断，将自动重试',
    }
  }
  if (A?.state === 'running') {
    return { tone: 'text-sky-300', title: 'AI 正在优化…', desc: `正在定位并修改算法${A.attempts > 1 ? `（第 ${A.attempts} 次尝试）` : ''}` }
  }
  if (A?.state === 'lost') return { tone: 'text-red-300', title: 'AI 会话中断，等待重试', desc: '' }
  if (A?.state === 'pending') return { tone: 'text-amber-300', title: '排队等待 AI 处理', desc: '' }
  if (v === 'FAIL' || v === 'UNKNOWN') return { tone: 'text-red-300/80', title: '尚未交给 AI', desc: '' }
  return { tone: 'text-slate-400', title: '无需 AI 处理', desc: '' }
}

function FeedbackBadge() {
  const boxRef = useRef(null)
  const [status, setStatus] = useState({
    queue: [],
    err: false,
    open: false,
    backlog: 0,
    flushMsg: '',
    mode: '',
    modeMsg: '',
    recogVersion: null,
    retrying: null,
    retryMsg: null,
    openDetail: null,
  })
  const refresh = useCallback(async () => {
    let err = false
    let queue = []
    let recogVersion = null
    try {
      const res = await fetch('/api/feedback-status')
      if (!res.ok) throw new Error('status ' + res.status)
      const j = await res.json()
      queue = Array.isArray(j.queue) ? j.queue : []
      recogVersion = j.recogVersion || null
    } catch {
      err = true
    }
    setStatus((s) => ({ ...s, queue, err, backlog: countBacklog(), recogVersion }))
    if (!err) {
      try {
        const r2 = await fetch('/api/agent-mode')
        const j2 = await r2.json()
        if (j2?.ok) setStatus((s) => ({ ...s, mode: j2.mode }))
      } catch {
        /* 模式查询失败不影响徽章主体 */
      }
    }
  }, [])
  const switchMode = useCallback(
    async (mode) => {
      try {
        const res = await fetch('/api/agent-mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
        const j = await res.json()
        setStatus((s) =>
          j?.ok
            ? { ...s, mode: j.mode, modeMsg: `已切换：${MODE_LABEL[j.mode]}` }
            : { ...s, modeMsg: '切换失败' },
        )
      } catch {
        setStatus((s) => ({ ...s, modeMsg: '服务未连接，切换未生效' }))
      }
      refresh()
    },
    [refresh],
  )
  const doFlush = useCallback(async () => {
    const r = await flushFeedbackBacklog()
    setStatus((s) => ({
      ...s,
      flushMsg: r.sent > 0 ? `补投成功 ${r.sent} 条，已进入 AI 队列` : r.ok ? '本地无待补投' : '服务未连接，暂存已保留',
    }))
    refresh()
  }, [refresh])
  const retryingRef = useRef(null)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 闭环兜底：对某条反馈重跑 analyze（用当前算法核验旧结论是否已被顺带修复），
  // 服务端分析完成会自动对账触发 agent —— 用于会话中断/历史遗留/算法已升级的条目。
  // 交互上必须给三段反馈：点击即置「重跑中」→ 轮询等 resultSummary 刷新 → 回显「旧结论 → 新结论」。
  // 教训（2026-09-04 N359）：只 fire-and-forget 会在结论无变化时让 UI 毫无动静，用户判定「点了没反应」。
  const retryTrace = useCallback(
    async (traceId) => {
      if (retryingRef.current) return
      retryingRef.current = traceId
      // 先取当前结论快照，用于重跑后对比（结论没变也要明说，否则等于没反馈）
      let before = null
      try {
        const j0 = await (await fetch('/api/feedback-status')).json()
        before = (j0.queue || []).find((q) => q.traceId === traceId)?.resultSummary || null
      } catch {
        /* 取快照失败不阻塞重跑 */
      }
      const setMsg = (text) => setStatus((s) => ({ ...s, flushMsg: text, retryMsg: { traceId, text } }))
      setStatus((s) => ({ ...s, retrying: traceId }))
      setMsg(`正在重跑核验 ${traceId}…（用当前算法重算，约需数秒至 1 分钟）`)
      let done = null
      try {
        const r = await fetch('/api/feedback-reanalyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ traceId }),
        })
        if (!r.ok) throw new Error('status ' + r.status)
        const t0 = Date.now()
        while (Date.now() - t0 < 120000) {
          await sleep(2000)
          try {
            const j = await (await fetch('/api/feedback-status')).json()
            const it = (j.queue || []).find((q) => q.traceId === traceId)
            if (it?.resultSummary?.at && it.resultSummary.at !== before?.at) {
              done = it.resultSummary
              break
            }
          } catch {
            /* 轮询失败继续重试，直到超时 */
          }
        }
      } catch {
        setMsg('重跑触发失败（服务未连接？）')
        retryingRef.current = null
        setStatus((s) => ({ ...s, retrying: null }))
        return
      }
      const v0 = before?.verify || '未知'
      const v1 = done?.verify || '未知'
      setMsg(
        done
          ? `重跑完成 ${traceId}：${v0} → ${v1}${v0 === v1 ? '（结论未变，该问题当前算法仍未修复）' : '（结论已变化）'}`
          : `重跑已提交，但 2 分钟内未见结果更新（${traceId}）：请确认 server.mjs 在运行`,
      )
      retryingRef.current = null
      setStatus((s) => ({ ...s, retrying: null }))
      refresh()
    },
    [refresh],
  )
  useEffect(() => {
    flushFeedbackBacklog().then(() => refresh()) // 页面加载：自动补投失败的反馈
    flushReviewBacklog().catch(() => {}) // 页面加载：补投失败的 AI 复查
    const t = setInterval(refresh, 8000)
    const onSub = () => refresh() // 保存反馈后即时刷新
    window.addEventListener('meddata:feedback-submitted', onSub)
    return () => {
      clearInterval(t)
      window.removeEventListener('meddata:feedback-submitted', onSub)
    }
  }, [refresh])
  // 点击面板外关闭详情面板，避免面板常驻遮挡内容
  useEffect(() => {
    if (!status.open) return
    const onDown = (e) => {
      if (!boxRef.current?.contains(e.target)) setStatus((s) => ({ ...s, open: false }))
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [status.open])
  // Esc 关闭：走统一栈，弹层开着时先关弹层（原来各自监听 window，一次 Esc 会把弹层和面板一起关掉）
  useEscClose(() => setStatus((s) => ({ ...s, open: false })), status.open)
  // 无队列且无本地暂存 → 不显示；服务端不可用但有本地暂存 → 仍显示（失败兜底入口）
  if ((status.err || !status.queue.length) && !status.backlog && !status.flushMsg) return null
  const pending = status.queue.filter((q) => !q.processed).length
  const last =
    status.queue.findLast?.((q) => q.processed && q.resultSummary) ||
    [...status.queue].reverse().find((q) => q.processed && q.resultSummary)
  const v = last?.resultSummary?.verify
  const a = last?.agent
  // 闭环主状态：agent 终态（agent-done）优先于 analyze 快照 —— 修复完成的反馈不再显示成「复现失败」，
  // 会话中断/从未被 agent 接手的 FAIL 以红/amber 提醒并可一键重跑
  const toneOf = { emerald: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/40', amber: 'bg-amber-400/15 text-amber-300 border-amber-400/40', red: 'bg-red-400/15 text-red-300 border-red-400/40', slate: 'bg-slate-700 text-slate-300 border-slate-600' }
  const dotOf = { emerald: 'bg-emerald-400', amber: 'bg-amber-400', red: 'bg-red-400', slate: 'bg-slate-400' }
  let badge
  if (pending > 0) badge = { text: `AI 处理中 ${pending} 条`, key: 'amber', pulse: true }
  else if (status.backlog > 0) badge = { text: `反馈暂存 ${status.backlog} 条`, key: 'amber', pulse: true }
  else if (v === 'PASS') badge = { text: 'AI 复现通过', key: 'emerald' }
  else if (a?.state === 'done' && a.doneStatus === 'done') badge = { text: `AI 已修复 v${a.tag || a.doneVersion || '?'}`, key: 'emerald' }
  else if (a?.state === 'done' && a.doneStatus === 'skipped') badge = { text: 'AI 已处理', key: 'slate' }
  else if (a?.state === 'done' && a.doneStatus === 'failed') badge = { text: '已排查未能修复', key: 'amber' }
  else if (a?.state === 'running') badge = { text: `AI 优化中${a.attempts > 1 ? `（第${a.attempts}次）` : ''}`, key: 'amber', pulse: true }
  else if (a?.state === 'pending') badge = { text: '待 AI 优化', key: 'amber' }
  else if (a?.state === 'lost') badge = { text: 'AI 会话中断', key: 'red' }
  else if (v === 'FAIL') badge = { text: 'AI 复现失败', key: 'red' }
  else badge = { text: 'AI 已处理', key: 'slate' }
  return (
    <div className="relative shrink-0" ref={boxRef}>
      <button
        type="button"
        aria-expanded={status.open}
        className={`btn-top border ${toneOf[badge.key]} ${status.open ? 'brightness-125' : 'hover:brightness-125'}`}
        onClick={() => setStatus((s) => ({ ...s, open: !s.open }))}
        title="AI 反馈闭环状态：点击查看详情（含每条的分析结论与优化进度）"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotOf[badge.key]} ${badge.pulse ? 'animate-pulse' : ''}`} />
        {badge.text}
      </button>
      {status.open && (
        <div className="absolute right-0 top-full mt-1 w-80 max-h-80 overflow-auto rounded-xl bg-slate-800 border border-slate-600 shadow-2xl text-left z-40">
          <div className="px-3 py-2 text-[11px] text-slate-400 border-b border-slate-700 flex items-center justify-between">
            <span>AI 反馈队列（{status.queue.length} 条）</span>
            <button className="underline hover:text-slate-200" onClick={refresh}>刷新</button>
          </div>
          {status.mode && (
            <div className="px-3 py-2 text-[11px] border-b border-slate-700/60">
              <div className="text-slate-400 mb-1.5">优化链路（agent 如何接手）</div>
              <div className="flex gap-1">
                {Object.keys(MODE_LABEL).map((m) => (
                  <button
                    key={m}
                    className={`flex-1 rounded px-1.5 py-1 text-[10px] border ${
                      status.mode === m
                        ? 'bg-sky-500/20 text-sky-300 border-sky-400/40'
                        : 'bg-slate-700/40 text-slate-300 border-slate-600 hover:bg-slate-700'
                    }`}
                    onClick={() => switchMode(m)}
                    title={MODE_TIP[m]}
                  >
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
              {status.modeMsg && <div className="mt-1 text-[10px] text-slate-500">{status.modeMsg}</div>}
            </div>
          )}
          {status.backlog > 0 && (
            <div className="px-3 py-2 text-[11px] border-b border-slate-700/60 flex items-center justify-between gap-2">
              <span className="text-amber-300" title="自动反馈曾失败，数据暂存于本机浏览器，服务恢复后可一键补投">本地暂存 {status.backlog} 条（未确认落盘）</span>
              <button className="shrink-0 underline hover:text-amber-200" onClick={doFlush}>补投</button>
            </div>
          )}
          {status.flushMsg && (
            <div className="px-3 py-1.5 text-[10px] text-slate-400 border-b border-slate-700/60">{status.flushMsg}</div>
          )}
          {status.queue.map((q, i) => {
            const rs = q.resultSummary
            const A = q.agent
            // —— 人话结论：agent 终态 + 核验结果合成一句话（原始 diff/层名收进「详情」）——
            const head = agentHeadline(A, rs)
            const agBtn =
              ['lost', 'pending'].includes(A?.state) ||
              (A?.state === 'failed' && !A.rateLimited) || // 限流期手动重试只会再撞 429，交给自动重试
              (!A && (rs?.verify === 'FAIL' || rs?.verify === 'UNKNOWN'))
            // stale：分析时点算法版本 < 当前 → verify FAIL 结论可能已被更新版本顺带修复，提示重跑核验
            const stale =
              rs?.verify === 'FAIL' &&
              rs?.analyzedVersion &&
              status.recogVersion &&
              rs.analyzedVersion !== status.recogVersion
            // 算法已升级 → 旧结论可能已被新版本修好，即使 AI 已结案也允许重跑核验（不冲突：只重算 verify）
            const needRecheck = agBtn || stale
            const detailOpen = status.openDetail === (q.traceId || i)
            const reportLabel = rs?.reportType ? reportTypeLabel(rs.reportType) : ''
            const key = q.traceId || i
            return (
              <div key={key} className="px-3 py-2 border-b border-slate-700/60 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-300 truncate" title={`${reportLabel} ${q.traceId || ''}`.trim()}>
                    {reportLabel || '报告'}
                    {rs?.date ? ` · ${rs.date.slice(5)}` : ''}
                  </span>
                  <span className={`text-[11px] font-medium shrink-0 ${head.tone}`}>{head.title}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-slate-400">{verifySentence(rs, q.processed)}</div>
                {head.desc && <div className="mt-0.5 text-[10px] text-slate-500">{head.desc}</div>}
                {status.retryMsg?.traceId === q.traceId && (
                  <div className="mt-1 text-[10px] text-sky-200/90">{status.retryMsg.text}</div>
                )}
                <div className="mt-1 flex items-center gap-3">
                  <button
                    type="button"
                    className="text-[10px] underline text-slate-400 hover:text-slate-200"
                    onClick={() => setStatus((s) => ({ ...s, openDetail: detailOpen ? null : key }))}
                  >
                    {detailOpen ? '收起' : '详情'}
                  </button>
                  {needRecheck &&
                    (status.retrying === q.traceId ? (
                      <span className="text-[10px] text-sky-300 animate-pulse">重跑中…</span>
                    ) : (
                      <button
                        type="button"
                        className="text-[10px] underline text-sky-300 hover:text-sky-200 disabled:opacity-40 disabled:no-underline"
                        disabled={!!status.retrying}
                        onClick={() => retryTrace(q.traceId)}
                        title="用当前算法重跑核验（结论可能已过期或上次中断时使用）"
                      >
                        重跑分析
                      </button>
                    ))}
                </div>
                {detailOpen && (
                  <div className="mt-1.5 space-y-1 border-t border-slate-700/60 pt-1.5">
                    {A?.summary && (
                      <div className="text-[10px] text-slate-300 whitespace-pre-wrap">AI 说明：{A.summary}</div>
                    )}
                    {rs?.summary && (
                      <div className="text-[10px] text-slate-500">
                        本次共改动 {rs.summary.total || 0} 项 · 你手动修正 {rs.summary.manual || 0} 处
                        {rs.expectedCount ? ` · 提交真值 ${rs.expectedCount} 条` : ''}
                      </div>
                    )}
                    {rs?.suggestLayer && (
                      <div className="text-[10px] text-slate-400">AI 定位：{humanSuggestLayer(rs.suggestLayer)}</div>
                    )}
                    {rs?.failLines?.length > 0 && (
                      <div className="text-[10px] text-red-300/80 font-mono space-y-0.5">
                        {rs.failLines.slice(0, 8).map((l, li) => (
                          <div key={li} className="break-all">{l}</div>
                        ))}
                      </div>
                    )}
                    {stale && (
                      <div className="text-[9px] text-slate-500">
                        分析于 v{rs.analyzedVersion}，当前算法 v{status.recogVersion}，结论可能已过期
                      </div>
                    )}
                    <div className="text-[10px] text-slate-600 font-mono break-all">{q.traceId}</div>
                    {q.processedAt && (
                      <div className="text-[10px] text-slate-600">处理于 {new Date(q.processedAt).toLocaleString()}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 顶栏支持「拖文件直达」的按钮：
// 1) 用进出计数判定真正离开，按钮内子元素（图标/文字）触发的 dragleave 不再导致高亮闪烁；
// 2) 只响应文件拖拽，拖选文字等不会误亮；
// 3) dropEffect 设为 copy，光标给出正确反馈；
// 4) 放下或拖出后必定复位高亮，不会卡在激活态。
function DropButton({ onFiles, onActive, className, title, children, ...rest }) {
  const depth = useRef(0)
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
  const reset = () => {
    depth.current = 0
    onActive(false)
  }
  return (
    <button
      type="button"
      className={className}
      title={title}
      {...rest}
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        depth.current += 1
        onActive(true)
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return
        depth.current -= 1
        if (depth.current <= 0) reset()
      }}
      onDrop={(e) => {
        e.preventDefault()
        reset()
        onFiles(e.dataTransfer.files)
      }}
    >
      {children}
    </button>
  )
}

// ===================== 导入类型选择（顶栏唯一入口） =====================
// 交互（2026-10-22 用户拍板）：
//   ① **点按钮**（无文件）→ 直接三选，不跑任何识别（没有文件就没有文字证据）；
//   ② **拖入文件** → 先跑一次「快速判型」（PDF 文字层毫秒级 / 图片单遍快速 OCR），
//      弹层显示「类型判断中…」；判出 → 对应项**预选中** + 卡片下方提示 + **2 秒倒计时**后自动进入；
//      判不出（unknown / 置信度低）→ 停在三选并说明原因，绝不瞎猜；
//   ③ 任何时刻点任一类型 = 立即打断判断/倒计时，按点击的走。
//
// 两条硬约束（都是踩过的坑）：
//   · **判型 OCR 绝不在 drop 回调里同步 await**（Bug 102：UI 卡数秒被误认"预热"）——
//     这里 drop 只登记文件 + 开弹层，识别在弹层内异步跑、有可见进度、可随时打断；
//   · **判型结果必须复用**：文本经 setPendingText 缓存，检查报告/文书导入页直接取用，
//     不会变成"判一次 + 导入页再识别一次"的双份开销。
const IMPORT_TYPES = [
  { flow: 'lab', label: '检验报告', desc: '化验单 / 血常规 / 生化 / 凝血…（识别成指标表格）' },
  { flow: 'doc', label: '检查报告', desc: '超声 / CT / 磁共振 / X线 / 心电 / 病理 / 骨穿…（原件 + 所见结论）' },
  { flow: 'case', label: '病历文书', desc: '出院记录 / 诊断证明（提取结构化字段）' },
]

const KIND_LABEL = { lab: '检验报告', doc: '检查报告', case: '病历文书' }
const AUTO_ENTER_MS = 2000 // 判出类型后停留 2 秒再自动进入（给用户取消/改选的机会）

function ImportTypePicker({ pick, onPick, onClose }) {
  const { open, files = [], state = 'idle', detected = null, progress = 0, countdown = 0 } = pick || {}
  // Esc 取消选型（判型中/倒计时中同样可打断；关闭时会清掉 pending 文本与计时器，由 onClose 负责）
  useEscClose(onClose, open)
  if (!open) return null
  const detectedFlow = detected && detected.flow
  const fileCount = files.length
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="card w-full max-w-lg overflow-hidden" role="dialog" aria-modal="true" aria-label="选择导入类型">
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">
              {state === 'detecting'
                ? '类型判断中…'
                : state === 'detected'
                ? `已识别为${KIND_LABEL[detectedFlow] || ''}`
                : state === 'undetermined'
                ? '没判出类型，请手动选'
                : '导入什么资料？'}
            </h3>
            <p className="text-xs text-slate-500 mt-1" data-testid="import-pick-status">
              {state === 'detecting' ? (
                <>
                  正在本机离线识别第 1 份文件（约 5–20 秒；PDF 有文字层则秒级）
                  {progress > 0 && <span className="ml-1 tabular-nums text-slate-400">{progress}s</span>}
                  <span className="block mt-1 text-slate-400">也可以直接点下面的类型，立即进入（不等待判断）</span>
                </>
              ) : state === 'detected' ? (
                <>
                  {fileCount > 1 ? `按第 1 份判型，共 ${fileCount} 份；` : ''}
                  依据：{detected.reason || '报告特征'}
                </>
              ) : state === 'undetermined' ? (
                <>
                  {detected && detected.reason ? `原因：${detected.reason}` : '特征不足'}
                  <span className="block mt-1 text-slate-400">直接选一个类型进入即可；进去后若不对还能一键改判</span>
                </>
              ) : (
                '选择类型后进入对应导入页；识别完若发现选错，页面里可一键改判，原件不会丢'
              )}
            </p>
          </div>
          <CloseButton onClick={onClose} testId="import-pick-close" />
        </div>

        <div className="p-3 space-y-1.5">
          {IMPORT_TYPES.map((t) => {
            const selected = detectedFlow === t.flow
            return (
              <button
                key={t.flow}
                type="button"
                data-testid={`import-pick-${t.flow}`}
                onClick={() => onPick(t.flow)}
                className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors cursor-pointer ${
                  selected
                    ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-300'
                    : 'border-slate-200 hover:border-brand-300 hover:bg-brand-50/40'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">{t.label}</span>
                  {selected && (
                    <span
                      className="text-[10px] rounded px-1.5 py-0.5 bg-brand-600 text-white font-medium"
                      data-testid={`import-pick-${t.flow}-selected`}
                    >
                      已选中
                    </span>
                  )}
                </span>
                <span className="block text-[11px] text-slate-500 mt-0.5">{t.desc}</span>
              </button>
            )
          })}
        </div>

        {/* 倒计时提示放在卡片下方（固定位置、非 hover 浮层）：随时可点其他类型打断 */}
        {state === 'detected' && (
          <div
            className="px-5 py-2.5 border-t border-brand-100 bg-brand-50/60 text-[11px] text-brand-800"
            data-testid="import-pick-countdown"
          >
            <span className="tabular-nums font-medium">{countdown}</span> 秒后自动进入
            {KIND_LABEL[detectedFlow]}导入 · 点其他类型可立即改选
          </div>
        )}

        <div className="px-5 py-3 border-t border-slate-100 flex justify-end">
          <button type="button" className="btn-secondary" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const store = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { patient_meta, records, events, docs, courses = [] } = store
  // 病历文书（case）与检查报告（exam）共用 docs 存储，按 category 拆成两条平行链路
  const examDocs = useMemo(() => docs.filter((d) => docCategory(d) === 'exam'), [docs])
  // 检验图文报告（骨髓 / 流式 / 基因）：归「检验」侧计数，别让顶栏「报告」数字漏掉它们
  const labDocs = useMemo(() => docs.filter((d) => docCategory(d) === 'lab'), [docs])
  const casesDocs = useMemo(() => docs.filter((d) => docCategory(d) === 'case'), [docs])
  // 深链：/reports?tab=doc&open=<docId> —— 从「AI 任务」的「打开归档」直接落到那份报告详情。
  // 只在命中数据后执行一次（docs 水合前为空，不能因为找不到就把目标丢掉）。
  const openedDeepLinkRef = useRef('')
  useEffect(() => {
    if (location.pathname !== '/reports') return
    const openId = new URLSearchParams(location.search).get('open') || ''
    if (!openId || openedDeepLinkRef.current === openId) return
    const hit = docs.find((d) => d.id === openId)
    if (!hit) return
    openedDeepLinkRef.current = openId
    if (docCategory(hit) === 'case') setDetailCase(hit)
    else setDetailDoc(hit)
  }, [location.pathname, location.search, docs])
  const [exportOpen, setExportOpen] = useState(false)
  const [cleanOpen, setCleanOpen] = useState(false)
  // 两个由 App 自己持有的浮层：Esc 关闭 + 背景滚动锁（清洗弹层的 Esc 在 CleanPanel 内，
  // 叠了对比/重识别弹窗时由栈顶那层先吃掉，见 utils/escStack.js）
  useEscClose(() => setExportOpen(false), exportOpen)
  useBodyScrollLock(exportOpen || cleanOpen)
  const [toast, setToast] = useState(null)
  const [detailRecord, setDetailRecord] = useState(null) // 查看单份化验报告详情
  const [detailDoc, setDetailDoc] = useState(null) // 查看报告归档详情
  const [detailCase, setDetailCase] = useState(null) // 查看病历文书详情
  const [btnDrag, setBtnDrag] = useState(false)
  const [storageError, setStorageError] = useState(false)
  const [ready, setReady] = useState(false)
  // 等待本地 IndexedDB 状态水合完成，避免首屏空数据闪烁、保证迁移跑完
  useEffect(() => {
    let alive = true
    whenReady().then(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [])
  const [vCopied, setVCopied] = useState(false)
  const copyVersion = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(appVersion.version)
      setVCopied(true)
      setTimeout(() => setVCopied(false), 1200)
    } catch {
      /* 剪贴板不可用时忽略，文字仍可手动选中复制 */
    }
  }, [])

  // 本地存储写入失败（配额不足）时给出可见告警，避免数据静默丢失
  // 数据源（SQLite 唯一数据源）：必须等 IndexedDB 水合完成（ready）再启动同步——
  // 否则服务端 state 会覆盖尚未载入的本地数据，离线期间的改动会被冲掉。之后由写入事件驱动推送。
  useEffect(() => {
    if (!ready) return
    initDataSource()
  }, [ready])

  useEffect(() => {
    const h = () => setStorageError(true)
    window.addEventListener('meddata:storage-error', h)
    return () => window.removeEventListener('meddata:storage-error', h)
  }, [])

  // 开发模式本地控制桥：让本机命令行能直接修改浏览器内数据（生产包不包含）
  useDevBridge()

  // 预热 OCR worker：应用启动后空闲时间提前创建 worker、编译 wasm、加载 traineddata，
  // 把首次识别的冷启动开销从识别路径挪到启动后空闲，避免「第一次点识别撞 90s 超时失败」。
  // 挂载后空闲即主动预热 OCR worker（eng+zh），尽早开始 wasm 编译 + traineddata 加载，
  // 尽量在用户点「识别」前完成，减少「首次失败、二次才成功」的冷启动体验。
  // 不阻塞首屏：createWorker 异步、wasm 编译在 worker 线程；requestIdleCallback 退化为 setTimeout。
  useEffect(() => {
    const idle =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback.bind(window)
        : (cb) => setTimeout(cb, 50)
    const id = idle(() => warmupOcr())
    return () => {
      if (typeof id === 'number') window.cancelIdleCallback?.(id)
      else clearTimeout(id)
    }
  }, [])

  const showToast = useCallback((msg, type = 'ok') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // 「查看趋势」统一入口（见 utils/trendNav.js）：按报告类型跳到 /cbc 对应分组锚点。
  const gotoTrend = useCallback((record) => gotoTrendNav({ navigate, record }), [navigate])

  // 「从哪来回哪去」：带上查询串，回到报告页时能恢复当时的 tab / 搜索 / 时间区间
  const fromHere = useCallback(() => location.pathname + location.search, [location.pathname, location.search])

  // ===== 导入入口：类型由**用户显式选择**，不再按当前页面猜（2026-10-21 拍板）=====
  // 旧实现 defaultFlowFor() 只看 pathname：站在概览/指标/疗程（起点页）时一律落到化验流，
  // 传一张超声/骨穿/出院记录入口就错。现改为：点「导入资料」或拖入文件 → 三选类型 → 进对应导入页。
  // 各业务页另有自己的「＋ 导入」（报告页按 tab、文书页按模块），落点即声明；见各页组件。
  // 判型（detectReportKind）在拖入时**预先**跑一次，只用于「预选中 + 2 秒自动进入」；判不出就交回手动。
  const [importPick, setImportPick] = useState({
    open: false,
    files: [],
    token: '',
    state: 'idle', // idle | detecting | detected | undetermined
    detected: null, // { kind, flow, confidence, reason }
    progress: 0,
    countdown: 0,
  })
  const pickTimerRef = useRef(null) // 倒计时 interval
  const pickCountdownRef = useRef(null) // 自动进入 timeout
  const detectSeqRef = useRef(0) // 判型代次：用户中途手选/取消后，过期的判型结果直接丢弃
  const probeTimerRef = useRef(null) // 「判断中」的秒表

  const clearPickTimers = useCallback(() => {
    if (pickTimerRef.current) clearInterval(pickTimerRef.current)
    if (pickCountdownRef.current) clearTimeout(pickCountdownRef.current)
    if (probeTimerRef.current) clearInterval(probeTimerRef.current)
    pickTimerRef.current = null
    pickCountdownRef.current = null
    probeTimerRef.current = null
  }, [])

  // 真正进入导入页（倒计时到点 / 用户手选都会走这里）
  const enterImport = useCallback(
    (flow, token, files) => {
      clearPickTimers()
      detectSeqRef.current += 1 // 让在途判型结果作废
      setImportPick({ open: false, files: [], token: '', state: 'idle', detected: null, progress: 0, countdown: 0 })
      const from = fromHere()
      if (token || (files && files.length)) {
        const tk = token || setPendingFiles(files)
        navigate(addPathFor(flow), { state: { token: tk, from } })
      } else {
        navigate(addPathFor(flow), { state: { from } })
      }
    },
    [navigate, fromHere, clearPickTimers]
  )

  const pickImportFlow = useCallback(
    (flow) => enterImport(flow, importPick.token, importPick.files),
    [enterImport, importPick.token, importPick.files]
  )

  // 文件 → 判型用文本：PDF 优先抽文字层（毫秒级），扫描件退到快速 OCR；图片直接快速 OCR
  const textForDetect = useCallback(async (file) => {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
    if (isPdf) {
      const dataUrl = await toPdfDataUrl(file)
      const layer = await pdfTextLayer(dataUrl).catch(() => '')
      if (layer.trim().length >= 20) return layer
      // 扫描版 PDF：渲染首页当图识别（比整本 OCR 便宜得多）
      const pageImg = await pdfFirstPageToDataUrl(dataUrl, 1600).catch(() => '')
      return pageImg ? await ocrTextFast(pageImg).catch(() => '') : ''
    }
    const dataUrl = await downscaleImage(file)
    return await ocrTextFast(dataUrl).catch(() => '')
  }, [])

  const openImportPicker = useCallback(
    (files) => {
      const list = Array.from(files || []).filter(Boolean)
      clearPickTimers()
      if (!list.length) {
        // 点按钮、没有文件 → 纯三选，不跑任何识别
        setImportPick({ open: true, files: [], token: '', state: 'idle', detected: null, progress: 0, countdown: 0 })
        return
      }
      // 拖入 → 立刻登记文件（这样「取消」也不会丢文件），再异步判型
      const token = setPendingFiles(list)
      const seq = ++detectSeqRef.current
      setImportPick({ open: true, files: list, token, state: 'detecting', detected: null, progress: 0, countdown: 0 })
      const t0 = Date.now()
      probeTimerRef.current = setInterval(() => {
        setImportPick((p) => (p.state === 'detecting' ? { ...p, progress: Math.round((Date.now() - t0) / 1000) } : p))
      }, 1000)
      ;(async () => {
        let text = ''
        try {
          text = await textForDetect(list[0])
        } catch {
          text = ''
        }
        if (seq !== detectSeqRef.current) return // 用户已手选/取消
        if (probeTimerRef.current) clearInterval(probeTimerRef.current)
        probeTimerRef.current = null
        const kind = detectReportKind({ fileName: list[0].name || '', mime: list[0].type || '', text })
        const decided = kind.kind !== 'unknown' && kind.confidence !== 'low'
        if (text) setPendingText(token, 0, text) // 复用：导入页不再重复 OCR（检查报告/文书侧直接取用）
        const detected = { ...kind, flow: kind.kind } // flow 供 UI 预选中 / 文案
        if (!decided) {
          setImportPick((p) => ({ ...p, state: 'undetermined', detected, progress: 0 }))
          return
        }
        // 判出 → 预选中 + 2 秒倒计时后自动进入
        setImportPick((p) => ({ ...p, state: 'detected', detected, progress: 0, countdown: Math.ceil(AUTO_ENTER_MS / 1000) }))
        let left = Math.ceil(AUTO_ENTER_MS / 1000)
        pickTimerRef.current = setInterval(() => {
          left -= 1
          setImportPick((p) => (p.state === 'detected' ? { ...p, countdown: Math.max(0, left) } : p))
          if (left <= 0 && pickTimerRef.current) clearInterval(pickTimerRef.current)
        }, 1000)
        pickCountdownRef.current = setTimeout(() => {
          if (seq !== detectSeqRef.current) return
          enterImport(kind.kind, token, list)
        }, AUTO_ENTER_MS)
      })()
    },
    [clearPickTimers, textForDetect, enterImport]
  )

  const closeImportPicker = useCallback(() => {
    clearPickTimers()
    detectSeqRef.current += 1
    if (importPick.token) clearPendingText(importPick.token)
    setImportPick({ open: false, files: [], token: '', state: 'idle', detected: null, progress: 0, countdown: 0 })
  }, [clearPickTimers, importPick.token])

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center text-slate-400 text-sm">
        正在加载本地数据…
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-slate-100">
      {/* 顶栏 */}
      <header className="bg-slate-900 text-white sticky top-0 z-30 shadow-lg topbar-glow">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="w-9 h-9 rounded-lg bg-brand-500 flex items-center justify-center font-bold text-lg shrink-0">
            M
          </div>
          <div className="min-w-0">
            <h1 className="font-semibold leading-tight flex items-center gap-2">
              MedData-AI
              <button
                type="button"
                onClick={copyVersion}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-slate-300 hover:text-white cursor-pointer transition-colors"
                title="点击复制版本号（也可直接选中文字复制）"
              >
                v{appVersion.version}{vCopied ? ' ✓' : ''}
              </button>
              <SyncDot />
            </h1>
            <p className="hidden sm:block text-[11px] text-slate-400 truncate">
              个人医疗检测数据管理 · 隐私第一 / 零成本 / AI 友好
            </p>
          </div>

          {/* 窄屏：导航整行下移并横向滚动（不折成竖排字），宽屏恢复原位 */}
          <div className="order-last -mx-1 w-full overflow-x-auto sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible">
            <TopNav
              counts={{
                records: records.length,
                docs: examDocs.length + labDocs.length,
                events: events.length,
                cases: casesDocs.length,
                invoices: (store.invoices || []).length,
              }}
            />
          </div>

          <div className="ml-auto flex items-center justify-end gap-2 flex-wrap">
            <AiTaskCenter />
            <FeedbackBadge />
            <button
              type="button"
              onClick={() => navigate('/settings')}
              className={`btn-top-ghost ${location.pathname === '/settings' ? 'ring-1 ring-white/40' : ''}`}
              title="设置（识别补丁 / AI 接入等）"
              data-testid="settings-entry"
            >
              设置
            </button>
            <DropButton
              className={btnDrag ? 'btn-top-primary ring-2 ring-brand-300 bg-brand-400' : 'btn-top-primary'}
              onActive={setBtnDrag}
              onFiles={openImportPicker}
              onClick={() => openImportPicker()}
              title="点击选择要导入的资料类型，或把文件拖到此处（拖入后同样让你选一次类型）"
            >
              <span className="text-sm leading-none">＋</span> 导入资料
            </DropButton>
          </div>
        </div>
      </header>

      {/* 存储配额告警：localStorage 写入失败时的可见提示 */}
      {storageError && (
        <div className="bg-red-600 text-white text-xs text-center py-2 px-4">
          ⚠️ 浏览器本地（IndexedDB）存储空间不足，部分数据可能未能保存。建议立即「导出」备份，并及时清理过期记录。
          <button className="ml-3 underline" onClick={() => setStorageError(false)}>
            知道了
          </button>
        </div>
      )}

      {/* 主视图：数据大屏 / 添加化验数据（独立路由页）/ 添加检查报告（独立路由页） */}
      <main className="max-w-screen-2xl mx-auto px-2 py-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={location.pathname}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <RouteErrorBoundary key={location.pathname}>
            <Routes location={location}>
          <Route
            path="/"
            element={
              <Dashboard
                records={records}
                events={events}
                onViewDetail={setDetailRecord}
                onExpandCBC={() => navigate('/cbc')}
                onClean={() => setCleanOpen(true)}
                onExport={() => setExportOpen(true)}
                onImport={() => openImportPicker()}
              />
            }
          />
          {/* 旧「病情」入口已并入指标页（/cbc），保留重定向避免书签白屏 */}
          <Route path="/streams" element={<Navigate to="/cbc" replace />} />
          {/* 报告：检验（化验）+ 检查报告合并入口 —— 一页两 tab，搜索与时间区间跨两库共享。
              合并的是「入口与检索」，不是「表」：两库行字段/详情页/导入流程各自独立（理由见 ReportsPage 头部）。 */}
          <Route
            path="/reports"
            element={
              <ReportsPage
                records={records}
                docs={docs}
                onViewChart={gotoTrend}
                onViewDetail={setDetailRecord}
                onOpenDoc={setDetailDoc}
              />
            }
          />
          {/* 报告导入（检验 / 检查共用一个页面，改判就地换 flow，不再跨顶级菜单跳转） */}
          <Route
            path="/reports/add"
            element={<AddReportPage navigate={navigate} location={location} showToast={showToast} />}
          />
          {/* 旧路由兼容：书签与 e2e 脚本直连 /records、/archive 仍可用，渲染合并页的对应 tab */}
          <Route
            path="/records"
            element={
              <ReportsPage
                records={records}
                docs={docs}
                onViewChart={gotoTrend}
                onViewDetail={setDetailRecord}
                onOpenDoc={setDetailDoc}
                defaultTab="lab"
              />
            }
          />
          <Route
            path="/records/add"
            element={<AddReportPage navigate={navigate} location={location} showToast={showToast} forcedFlow="lab" />}
          />
          {/* 疗程：用药 / 输血 / 住院 / 花费 的时间线与归集（原「日程」+「费用」合并） */}
          <Route path="/course" element={<CoursePage events={events} />} />
          {/* 旧路径重定向：合并后不再单独存在，避免书签 / 历史链接白屏 */}
          <Route path="/schedule" element={<Navigate to="/course" replace />} />
          {/* 费用：两本账（住院实掏 + 发票票面）+ 对账 + 发票库（2026-10-21 从疗程页独立出来） */}
          <Route path="/cost" element={<CostPage showToast={showToast} />} />
          {/* 添加发票 / 结算单：独立页面，进入后顶栏导航可随时离开 */}
          <Route
            path="/cost/add"
            element={<InvoiceImportFlow navigate={navigate} location={location} showToast={showToast} />}
          />
          <Route
            path="/archive"
            element={
              <ReportsPage
                records={records}
                docs={docs}
                onViewChart={gotoTrend}
                onViewDetail={setDetailRecord}
                onOpenDoc={setDetailDoc}
                defaultTab="doc"
              />
            }
          />
          <Route
            path="/archive/add"
            element={<AddReportPage navigate={navigate} location={location} showToast={showToast} forcedFlow="doc" />}
          />
          {/* 病历文书：出院记录 / 诊断证明等，独立顶级模块 */}
          <Route
            path="/cases"
            element={
              <CasesSection
                docs={casesDocs}
                onOpen={setDetailCase}
                onAddManual={() => navigate('/cases/add?manual=1', { state: { from: '/cases' } })}
                onAdd={() => navigate('/cases/add', { state: { from: '/cases' } })}
              />
            }
          />
          {/* 添加病历文书：独立页面，进入后顶栏导航可随时点击离开 */}
          <Route
            path="/cases/add"
            element={<AddCasePage navigate={navigate} location={location} showToast={showToast} />}
          />
          {/* 全血细胞详细走势：由概览趋势图按钮进入，不在顶栏重复 */}
          <Route
            path="/cbc"
            element={
              <CBCDetailView
                records={records}
                events={events}
                onBack={() => navigate(-1)}
                onOpenDoc={setDetailDoc}
                onOpenRecord={setDetailRecord}
                onNotify={showToast}
              />
            }
          />
          {/* 体温管理页：由指标页体温卡点标题放大进入，独立全屏工作台；不在顶栏加入口 */}
          <Route
            path="/temperature"
            element={<TempManagePage events={events} onNotify={showToast} onBack={() => navigate(-1)} />}
          />
          {/* 设置页：识别补丁等"改代码级"配置的唯一入口（不进顶栏数据导航，走右上角工具簇） */}
          <Route path="/settings" element={<SettingsPage onBack={() => navigate(-1)} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </RouteErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="max-w-screen-2xl mx-auto px-4 pb-8 text-center text-[11px] text-slate-400">
        MedData-AI · 本地数据存于浏览器 IndexedDB，可选同步到数据源备份 · OCR 图片仅含脱敏后的表格区域 · 本工具不构成医疗建议
      </footer>

      {/* 导出弹层 */}
      {exportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="card w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="导出">
            <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between shrink-0">
              <div>
                <h3 className="font-semibold text-slate-800">AI 结构化数据导出</h3>
                <p className="text-xs text-slate-500 mt-0.5">Markdown / JSON / Prompt 模板，复制即用</p>
              </div>
              <CloseButton onClick={() => setExportOpen(false)} testId="export-close" />
            </div>
            <div className="flex-1 overflow-auto p-5">
              <ExportPanel records={records} events={events} docs={examDocs} cases={casesDocs} patientMeta={patient_meta} />
            </div>
          </div>
        </div>
      )}

      {/* 导入类型选择（点击「导入资料」或拖入文件后） */}
      <ImportTypePicker pick={importPick} onPick={pickImportFlow} onClose={closeImportPicker} />

      {/* 数据清洗弹层 */}
      {cleanOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="card w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto p-4">
              <CleanPanel
                records={records}
                onClose={() => setCleanOpen(false)}
                onDone={(summary) =>
                  showToast(
                    `清洗完成：删除重复 ${summary.removeRecords} 条 · 修正标题 ${summary.titleFixes} 条 · 重映射 ${summary.pointFixes} 项`
                  )
                }
              />
            </div>
          </div>
        </div>
      )}

      {/* 单份报告详情弹层 */}
      {detailRecord && (
        <ReportDetail record={detailRecord} patientMeta={patient_meta} onClose={() => setDetailRecord(null)} />
      )}

      {/* 报告归档详情弹层 */}
      {detailDoc && (
        <DocDetail
          doc={detailDoc}
          onClose={() => setDetailDoc(null)}
          onDelete={(id) => {
            deleteDoc(id)
            setDetailDoc(null)
            showToast('归档已删除（含原件）')
          }}
        />
      )}

      {/* 病历文书详情弹层 */}
      {detailCase && (
        <CaseDetail
          doc={detailCase}
          onClose={() => setDetailCase(null)}
          onDelete={(id) => {
            deleteDoc(id)
            setDetailCase(null)
            showToast('文书已删除（含原件）')
          }}
        />
      )}

      <Toast toast={toast} />
    </div>
  )
}
