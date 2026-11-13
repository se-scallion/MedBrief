// ===================== AI 分类兜底（规则层判 UNKNOWN 时让 AI 读图抽字段）=====================
// 与 review.js 平行：识别判为 UNKNOWN 时把原图 + OCR 文本发给 server，agent 产出结构化字段，
// 前端轮询状态、done 后补填草稿（人在回路：只进草稿，保存前用户可改）。仅 dev 环境（server.mjs 在跑）生效。
const CLASSIFY_ENDPOINT = '/api/ai-classify'
const STATUS_ENDPOINT = '/api/ai-classify-status'
const BACKLOG_PREFIX = 'classify:'

// 已成功发送过的 id（会话内去重，避免 HMR / 重复识别重复触发）
const sentIds = new Set()

export async function postAiClassify(payload) {
  if (!payload || !payload.id) return { ok: false, persisted: false }
  try {
    const m = await fetch('/api/agent-mode')
    if (m.ok) {
      const j = await m.json()
      if (j.mode === 'off') return { ok: true, skipped: true, reason: 'agent-off' }
    }
  } catch {
    /* 拿不到模式也照发（兼容旧 server） */
  }
  if (sentIds.has(payload.id)) return { ok: true, skipped: true, reason: 'dedup' }
  try {
    localStorage.setItem(BACKLOG_PREFIX + payload.id, JSON.stringify(payload))
  } catch {
    /* 满则忽略 */
  }
  let persisted = false
  try {
    const res = await fetch(CLASSIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error('ai-classify endpoint ' + res.status)
    persisted = true
    sentIds.add(payload.id)
    try {
      localStorage.removeItem(BACKLOG_PREFIX + payload.id)
    } catch {
      /* ignore */
    }
  } catch {
    persisted = false
  }
  return { ok: true, persisted }
}

// 页面加载时补投：server 不可达时本地暂存的分类请求，恢复后重发；已发送过的跳过。
export async function flushClassifyBacklog() {
  if (typeof localStorage === 'undefined') return { ok: true, sent: 0 }
  const keys = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(BACKLOG_PREFIX)) keys.push(k)
  }
  if (!keys.length) return { ok: true, sent: 0 }
  let sent = 0
  for (const k of keys) {
    const id = k.slice(BACKLOG_PREFIX.length)
    if (sentIds.has(id)) {
      localStorage.removeItem(k)
      continue
    }
    try {
      const raw = localStorage.getItem(k)
      if (!raw) continue
      const res = await fetch(CLASSIFY_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })
      if (res.ok) {
        localStorage.removeItem(k)
        sentIds.add(id)
        sent++
      }
    } catch {
      /* 单条失败保留，下次再试 */
    }
  }
  return { ok: true, sent }
}

// 轮询分类终态：未就绪返回 { state: 'pending' | 'running' }，done 返回 { state:'done', report_type, data_points }。
export async function fetchClassifyStatus(id) {
  try {
    const res = await fetch(`${STATUS_ENDPOINT}?id=${encodeURIComponent(id)}`)
    if (!res.ok) return { state: 'unknown' }
    return await res.json()
  } catch {
    return { state: 'unknown' }
  }
}

// ===================== AI 精读检查报告（AI 主识别，契约 v2）=====================
// 与 AI 分类兜底平行：把原图（或 PDF 文字层全文）发给 server，agent 读成结构化字段，
// 前端轮询状态、done 后按「三轨模型」并入草稿（见 src/utils/docAi.js）。
//
// 契约版本与读取方式（server.mjs 按 mode/version 路由 prompt）：
//   v2 + mode='doc'      → 读原图转录全字段（图片 / 扫描件，约 30–60s）
//   v2 + mode='doc-text' → **不读图**，只整理文字层全文（PDF 有文字层，约 10–20s）
//   v1                   → 旧「AI 精读重填」（只回所见/结论/标题/部位），留作回滚
// mode/version 由调用方按输入分级决定；缺省仍按 v2 读图（AI 主识别的默认口径）。
const DOCREAD_ENDPOINT = '/api/ai-docread'
const DOCREAD_STATUS_ENDPOINT = '/api/ai-docread-status'

// v2 产物契约版本（与 scripts/agent-task.mjs::buildDocUnderstandPrompt 的 version 字段对齐）
export const DOCREAD_CONTRACT_VERSION = 2

// 提交一次精读请求；server 不可达返回 { ok:false, persisted:false }，agent 模式 off 返回 skipped。
export async function postDocRead(payload) {
  if (!payload || !payload.id) return { ok: false, persisted: false }
  try {
    const m = await fetch('/api/agent-mode')
    if (m.ok) {
      const j = await m.json()
      if (j.mode === 'off') return { ok: true, skipped: true, reason: 'agent-off' }
    }
  } catch {
    /* 拿不到模式也照发（兼容旧 server） */
  }
  try {
    const res = await fetch(DOCREAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: DOCREAD_CONTRACT_VERSION, mode: 'doc', ...payload }),
    })
    if (!res.ok) throw new Error('ai-docread endpoint ' + res.status)
    const d = await res.json().catch(() => ({}))
    return { ok: true, persisted: true, version: d.version, mode: d.mode }
  } catch {
    return { ok: false, persisted: false }
  }
}

// 轮询精读终态：done 返回 { state:'done', title, part, findings, conclusion, measures }。
export async function fetchDocReadStatus(id) {
  try {
    const res = await fetch(`${DOCREAD_STATUS_ENDPOINT}?id=${encodeURIComponent(id)}`)
    if (!res.ok) return { state: 'unknown' }
    return await res.json()
  } catch {
    return { state: 'unknown' }
  }
}
