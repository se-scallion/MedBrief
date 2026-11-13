// ===================== 待导入文件的跨路由缓存 =====================
// 「添加数据」页面化后，文件需要从一个路由页传到另一个路由页。
// 不把 File 塞进 history state（刷新/前进后退会失效或膨胀），改为模块级缓存：
// 顶栏按钮拿到文件 → setPendingFiles 得 token → navigate(导入页路由 + ?i=&n=, { state: { token } })；
// 导入页按 token 取值。刷新页面后 token 仍在（内存未清），若已失效则导入页优雅退化为「空上传态」。

const store = new Map()
let seq = 0

const MAX_ENTRIES = 20 // 超出即淘汰最旧，避免长时间使用累积占用内存

function evictIfNeeded() {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

function entry(token) {
  return token ? store.get(token) : undefined
}

/**
 * 登记待导入文件。
 * 注意：这里**不记**每份文件的「流向」——2026-10-21 起导入类型由**入口页面显式声明**
 * （各页「＋ 导入」按钮 / 顶栏拖放后三选），流向只存在于路由参数 `?flow=`；
 * 原先的 `flows[]` + `setFlow/getFlow/getFlows` 是 write-only 死代码（无人读取），已删除。
 * @param {File[]} files
 * @returns {string} token
 */
export function setPendingFiles(files) {
  const list = Array.from(files || []).filter(Boolean)
  const token = `p_${Date.now().toString(36)}_${(seq++).toString(36)}`
  store.set(token, { files: list, createdAt: Date.now() })
  evictIfNeeded()
  return token
}

export function peekFiles(token) {
  return entry(token)?.files ?? []
}

// 预识别阶段（App 路由分流）已跑过的 OCR 全文：存入以避免导入页二次 OCR。
// 仅作性能优化，缺失时导入页会自行 OCR，不影响正确性。
const textCache = new Map()

export function setPendingText(token, index, text) {
  const e = entry(token)
  if (!e) return
  textCache.set(`${token}#${index}`, text)
}

export function getPendingText(token, index) {
  return textCache.get(`${token}#${index}`) ?? ''
}

export function clearPendingText(token) {
  if (!token) return
  for (const k of [...textCache.keys()]) {
    if (k.startsWith(`${token}#`)) textCache.delete(k)
  }
}

// AI 精读结果随文件跨路由：检查报告导入里 AI 判出「这份是出院记录 / 诊断证明」并改判到
// 文书录入时，把 AI 读出的字段一并带过去——否则文书表单只能退回规则解析，而规则层对
// 「出院诊断证明书」这类文书抽不全（「主要诊断」「信院日期」等写法都会漏）。
const aiCache = new Map()

export function setPendingAi(token, index, ai) {
  if (!token || !ai) return
  aiCache.set(`${token}#${index}`, ai)
}

export function getPendingAi(token, index) {
  return aiCache.get(`${token}#${index}`) || null
}

// 取走（读取即删除）：AI 结果只属于它对应的那一份文件，用完即弃，避免同一 token 槽位换文件后
// 把上一份的字段套到新文件上。
export function takePendingAi(token, index) {
  const key = `${token}#${index}`
  const ai = aiCache.get(key) || null
  if (ai) aiCache.delete(key)
  return ai
}

export function clearPendingAi(token) {
  if (!token) return
  for (const k of [...aiCache.keys()]) {
    if (k.startsWith(`${token}#`)) aiCache.delete(k)
  }
}

// 取走文件（同一 token 的批量推进过程中不释放，避免中途丢失；仅在清空时调用）
export function takeFiles(token) {
  const e = entry(token)
  if (!e) return []
  return e.files
}

export function getFileName(token, index) {
  const f = peekFiles(token)[index]
  return f && f.name ? f.name : ''
}

export function clearPending(token) {
  if (token) {
    store.delete(token)
    clearPendingText(token)
    clearPendingAi(token)
  }
}

// ---------- 页内上传的自登记 token ----------
// 用户直接在导入页（非顶栏入口）选文件时没有 pendingToken，流程切换（如化验页识别出
// 检查报告后切归档页）会因跨路由拿不到文件而丢上传。导入页登记文件后把 token 存到
// 这个模块级槽，目标路由页在 state.token 缺失时回退读取。
let lastSelfToken = ''

export function setSelfPendingFiles(files) {
  const token = setPendingFiles(files)
  lastSelfToken = token
  return token
}

export function getLastSelfToken() {
  return lastSelfToken
}

/**
 * 改判流向（改为病历文书 / 改为检验报告…）前，确保目标页能从缓存里取到**当前这份原件**。
 *
 * 为什么需要：改判只是换页面，文件得跟着走。原实现 `pendingToken || getLastSelfToken()` 有两处漏
 * （2026-10-27 AI 任务 #mlz7n 实测：检查报告导入页点「改为病历文书」→ 文书页停在空白上传态）：
 * ① **从 AI 任务恢复的草稿**（`?task=`）文件是现场从任务里拉的 File，从没登记进本缓存，
 *    token 为空 → 目标页取不到文件 → 空页；
 * ② 回退拿到的模块级 token 可能是**上一批文件**留下的，会把别的文件带过去（张冠李戴）。
 *
 * 口径：token 槽位上正是这份文件（同名）才沿用；否则现场给这份文件单独登记一个 token（index=0），
 * 并把预识别全文一并存进去（图片免二次 OCR）。没有原件时返回空 token，由调用方改带任务 id。
 * @param {{token?: string, index?: number, file?: File|null, text?: string}} p
 * @returns {{token: string, index: number}}
 */
export function ensurePendingSlot({ token, index = 0, file = null, text = '' } = {}) {
  const cur = peekFiles(token)[index] || null
  if (cur && (!file || cur.name === file.name)) {
    if (text) setPendingText(token, index, text)
    return { token, index }
  }
  if (!file) return { token: '', index: 0 }
  const next = setSelfPendingFiles([file])
  if (text) setPendingText(next, 0, text)
  return { token: next, index: 0 }
}
