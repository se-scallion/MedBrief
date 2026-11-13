// ===================== AI 复查触发（OCR 识别内容发给 AI 整理复查）=====================
// 与 feedback.js 平行：识别完成后把内容发给 server.mjs 中枢，agent 产出「AI 复查建议」，
// 前端「建议面板」展示、用户确认才改（人在回路）。仅 dev 环境（server.mjs 在跑）时生效。
const REVIEW_ENDPOINT = '/api/ocr-review'
const BACKLOG_PREFIX = 'review:'

// 已成功发送过的 id（会话内去重，避免 HMR / 重识别重复触发）
const sentIds = new Set()

export async function postOcrReview(payload) {
  if (!payload || !payload.id) return { ok: false, persisted: false }
  // 门禁：agent 模式 off 不发（GET /api/agent-mode）
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
  // 本地兜底：先存，再尝试落盘；失败保留供补投
  try {
    localStorage.setItem(BACKLOG_PREFIX + payload.id, JSON.stringify(payload))
  } catch {
    /* 满则忽略 */
  }
  let persisted = false
  try {
    const res = await fetch(REVIEW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error('review endpoint ' + res.status)
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

// 页面加载时补投：server 不可达时本地暂存的建议，恢复后重发；已发送过的跳过。
export async function flushReviewBacklog() {
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
      const res = await fetch(REVIEW_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })
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
