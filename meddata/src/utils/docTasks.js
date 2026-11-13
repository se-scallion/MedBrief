// ===================== AI 识别任务 · 客户端队列 =====================
// 为什么需要：AI 精读是 30–70 秒的异步 agent，页面等着 = 用户被绑住；不等 = 结果无处可去。
// 本模块做两件事：
//   ① 把「已提交的 AI 任务」持久化到 localStorage —— 用户切页 / 刷新 / 关页面后回来，任务还在；
//   ② 统一轮询入口 pollAiTask（原逻辑在 DocImportFlow 里写死 3s × 60 次，且超时口径与
//      ocrEngines.js 的 300s 不一致，这里收口成一处）。
//
// 服务端才是任务真相源（logs/ai-docread-<id>.json ↔ ai-docread-done-<id>.json）：
// 本模块的记录只用于「本机 UI 展示与重连」，P2 的 AI 任务中心会用 GET /api/ai-tasks 与之对账。

const TASK_KEY = 'meddata_ai_tasks'
const MAX_TASKS = 50

// 任务终态（与服务端 status 端点一致）
export const AI_TERMINAL = ['done', 'failed']

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(TASK_KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function write(list) {
  try {
    localStorage.setItem(TASK_KEY, JSON.stringify(list.slice(0, MAX_TASKS)))
  } catch {
    /* 配额满则放弃持久化：任务仍在服务端，刷新后可凭 id 重连 */
  }
}

// 新建（或覆盖）一条任务记录
export function upsertTask(task) {
  if (!task || !task.id) return
  const list = read().filter((t) => t.id !== task.id)
  list.unshift({ ...task, updatedAt: new Date().toISOString() })
  write(list)
}

// 局部更新（终态、已核对等）
export function patchTask(id, patch) {
  const list = read().map((t) => (t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t))
  write(list)
  return list.find((t) => t.id === id) || null
}

export function getTask(id) {
  return read().find((t) => t.id === id) || null
}

export function removeTask(id) {
  write(read().filter((t) => t.id !== id))
}

// 列表（默认按提交时间倒序；filter 可选 'running' | 'pending' | 'failed'）
export function listTasks(filter) {
  const list = read()
  if (!filter) return list
  if (filter === 'running') return list.filter((t) => !AI_TERMINAL.includes(t.state))
  if (filter === 'failed') return list.filter((t) => t.state === 'failed' || t.state === 'rate_limited')
  if (filter === 'pending') return list.filter((t) => t.state === 'done' && !t.reviewed)
  return list
}

// 进行中任务数（顶栏胶囊角标）
export function runningCount() {
  return listTasks('running').length
}

// 轮询 AI 任务终态：返回状态端点 JSON（含 state/status/...）；超时返回 { state:'timeout' }。
// signal 可中断（组件卸载 / 用户取消等待）；注意：取消只停止等待，agent 仍会在后台跑完并落 done 文件。
// 单次状态查询（服务端真相源）：{ state: 'running'|'done'|'failed'|'rate_limited', ... }
export async function fetchTaskStatus(id) {
  try {
    const res = await fetch(`/api/ai-docread-status?id=${encodeURIComponent(id)}`)
    if (!res.ok) return {}
    return await res.json()
  } catch {
    return {}
  }
}

export async function pollAiTask(id, { timeoutMs = 300_000, intervalMs = 3000, onTick, signal } = {}) {
  const t0 = Date.now()
  let n = 0
  while (Date.now() - t0 < timeoutMs) {
    if (signal && signal.aborted) return { state: 'aborted' }
    await new Promise((r) => setTimeout(r, intervalMs))
    if (signal && signal.aborted) return { state: 'aborted' }
    n += 1
    const s = await fetchTaskStatus(id)
    if (onTick) onTick(s, Date.now() - t0)
    if (s.state === 'done' || s.state === 'failed' || s.state === 'rate_limited') {
      patchTask(id, { state: s.state === 'done' ? (s.status === 'failed' ? 'failed' : 'done') : s.state, error: s.message || '' })
      return s
    }
  }
  patchTask(id, { state: 'timeout' })
  return { state: 'timeout' }
}

// ===================== 服务端任务列表对账（P2 任务中心）=====================
// 服务端是真相源（logs 里的请求/终态文件），localStorage 只补「本机展示信息」：
// 文件名兜底、是否已核对（reviewed）、以及核对后落到哪条归档（docId）。
// 拉服务端任务列表。⚠ 服务端有条数上限（?limit，默认 60 / 上限 500），必须显式要够：
// 老实现不带 limit → 恒拿最近 40 条，而 logs 里常有 150+ 条回归测试任务 →
// 「删了一条数量不减」（第 41 条补位）+「老任务按 sha/文件名捡不回来」（列表被截断搜不到）。
// 2026-10-27 用户实测 #nj9h9：删除其实成功（`OK ai-task-delete … removed=2`），是列表口径的锅。
export const TASK_LIST_LIMIT = 500

// all:true → 连回归/自检任务（服务端 test:true 标记）一起要，对应任务中心「显示测试任务」开关。
// 服务端默认不返回它们（否则每跑一次 test:doc 就顶满列表），开关必须显式带 all=1 才拿得到。
export async function fetchServerTasks(limit = TASK_LIST_LIMIT, { all = false } = {}) {
  try {
    const res = await fetch(`/api/ai-tasks?limit=${encodeURIComponent(limit)}${all ? '&all=1' : ''}`)
    if (!res.ok) return { tasks: [], total: 0, testTotal: 0 }
    const d = await res.json()
    return {
      tasks: Array.isArray(d.tasks) ? d.tasks : [],
      total: Number(d.total) || (Array.isArray(d.tasks) ? d.tasks.length : 0),
      // 服务端默认隐藏的回归/自检任务数（前端没拿到它们时也要能显示「已隐藏 N 条」）
      testTotal: Number(d.testTotal) || 0,
    }
  } catch {
    return { tasks: [], total: 0, testTotal: 0 }
  }
}

// 本机元数据合并（纯函数部分抽出来，列表 / 带总数两个入口共用一份口径）
function mergeLocal(serverTasks) {
  const local = new Map(read().map((t) => [t.id, t]))
  return serverTasks.map((t) => {
    const l = local.get(t.id) || {}
    return {
      ...t,
      fileName: t.fileName || l.fileName || '(未知文件)',
      reviewed: !!(t.reviewed || l.reviewed),
      docId: t.docId || l.docId || '',
      dismissed: !!(t.dismissed || l.dismissed),
      note: t.note || l.note || '',
    }
  })
}

// 任务中心用：连**服务端真实总数**一起返回（列表可能被 limit 截断，UI 要如实说明）
export async function listAllTasksPage({ all = false } = {}) {
  const { tasks, total, testTotal } = await fetchServerTasks(TASK_LIST_LIMIT, { all })
  return { tasks: mergeLocal(tasks), total, testTotal }
}

// 服务端任务 + 本地元数据合并。
// reviewed / docId 以**服务端为准**（2026-10-25 起回写 logs/ai-docread-review-<id>.json）：
// 只存 localStorage 时，换浏览器/换设备任务中心会把已采用的记录又显示成「待核对」，
// 「点任务跳归档」也永远接不上。本地只兜底老任务（回写接口上线前采用的）。
export async function listAllTasks() {
  const { tasks } = await fetchServerTasks()
  return mergeLocal(tasks)
}

// 任务列表需要"立刻反映"的操作（删除 / 丢弃 / 采用）统一发这条事件：
// 任务中心在任意页面（例如导入页「丢弃并删除结果」）点完都能当场刷新，
// 而不是等下一次 30s 轮询 —— 那 30s 正是用户判定"点了没用"的窗口。
export const AI_TASKS_CHANGED = 'meddata:ai-tasks-changed'
function notifyTasksChanged() {
  try {
    window.dispatchEvent(new CustomEvent(AI_TASKS_CHANGED))
  } catch {
    /* 非浏览器环境（单测）忽略 */
  }
}

// 任务 ↔ 归档回写（采用/归档后调用）：服务端落 sidecar，本机同时留一份便于离线展示。
export async function postTaskReview(id, docId) {
  patchTask(id, { reviewed: true, docId: docId || '' })
  try {
    const res = await fetch('/api/ai-task-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 采用即等于"不再丢弃"：两态互斥，避免一行同时显示"已归档"和"已丢弃"
      body: JSON.stringify({ id, docId: docId || '', reviewed: true, dismissed: false }),
    })
    const d = await res.json().catch(() => ({}))
    if (res.ok && d.ok !== false) notifyTasksChanged()
    return { ok: res.ok && d.ok !== false, error: d.error || '' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 丢弃一条结果（不采用、不归档）。服务端落 dismissed 标记 —— 可撤销，也不会误删已付费的产物。
// 为什么不能只在本机删：`移除` 原来只删 localStorage 记录，而任务列表是从服务端对账出来的，
// 下一次刷新它又原样回来（点了等于没点）。丢弃必须是服务端状态。
export async function postTaskDismiss(id, dismissed = true) {
  patchTask(id, { dismissed })
  try {
    const res = await fetch('/api/ai-task-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, dismissed }),
    })
    const d = await res.json().catch(() => ({}))
    if (res.ok && d.ok !== false) notifyTasksChanged()
    return { ok: res.ok && d.ok !== false, error: d.error || '' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 彻底删除一条任务（不可逆）：删掉请求/终态/回写/原图/agent 日志，并把本机记录一起清掉。
// 与 postTaskDismiss 的区别：丢弃只是打标记，随时能撤销；这里是物理删除，服务端会拒绝
// 「已归档」与「仍在跑」两类任务（见 server.mjs /api/ai-task-delete 的两道闸）。
export async function deleteTaskRemote(id) {
  try {
    const res = await fetch('/api/ai-task-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const d = await res.json().catch(() => ({}))
    if (res.ok && d.ok !== false) {
      removeTask(id) // 本机列表记录也删，避免"删了还在"的错觉
      notifyTasksChanged()
      return { ok: true, removed: d.removed || [] }
    }
    return { ok: false, error: d.error || `HTTP ${res.status}`, docId: d.docId || '' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 删除失败时的可读文案（服务端两类拒绝对用户有实际指导意义，不要只抛 status）
export const DELETE_TASK_ERR = {
  'already-archived': '这条结果已经归档，删任务会让归档记录失去 AI 来源。请先删除那条归档，或改用「丢弃」。',
  'still-running': '这条还在读图，删掉会让正在跑的任务失去原件。等它出结果后再删，或先「丢弃」。',
  'task not found': '任务文件已不存在（可能已被清理）。',
}

// 取任务元信息（源文件名 / sha256 / 入口 / 是否有原图）+ 已完成结果：供「继续导入」复原草稿
export async function fetchTaskBundle(id) {
  try {
    const res = await fetch(`/api/ai-task?id=${encodeURIComponent(id)}`)
    if (!res.ok) return null
    const d = await res.json()
    return d && d.ok ? d : null
  } catch {
    return null
  }
}

// 任务的**源文件**（图片或 PDF）→ Blob；都没有返回 null。
// 走 /api/ai-task-file：服务端优先给 logs 里落盘的图，其次按 blobId 代理 data-server 里的原件。
// 所以 doc-text（PDF 文字层）任务也能把原件拿回来 —— 用户口径是"要链接到源文件，而不是只有文件名"。
export async function fetchTaskImage(id) {
  try {
    const res = await fetch(`/api/ai-task-file?id=${encodeURIComponent(id)}`)
    if (!res.ok) return null
    return await res.blob()
  } catch {
    return null
  }
}

// 取某任务的完整产物（status 端点在 done 时会把整个 done 文件展开返回）
export async function fetchTaskResult(id) {
  try {
    const res = await fetch(`/api/ai-docread-status?id=${encodeURIComponent(id)}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// 手动重试（服务端从落盘请求取回 mode/version 重新触发 agent）
export async function retryTask(id) {
  try {
    const res = await fetch('/api/ai-retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || d.ok === false) return { ok: false, error: d.error || `HTTP ${res.status}` }
    patchTask(id, { state: 'running', error: '' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
