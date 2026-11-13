// ===================== 识别 Trace 工具 =====================
// 每次 OCR 识别生成一个 Trace ID，并配套落盘一个日志文件（经 /api/log），
// 便于把 Trace ID 发给 AI 后，AI 直接读 logs/ocr-<traceId>.json 查原始识别数据。
//
// 设计：
//  - 每次识别 → 一个 traceId（如 TR-20260821-a1b2c3）
//  - 行级 ID = `${traceId}#${rowIndex}`（rowIndex 为网格渲染顺序，便于定位）
//  - 日志结构见 emitTrace()

const LOG_ENDPOINT = '/api/log'

// 生成 Trace ID：TR-<YYYYMMDD>-<6位随机>
export function makeTraceId(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `TR-${y}${m}${d}-${rand}`
}

export function rowTraceId(traceId, rowIndex) {
  return `${traceId}#${rowIndex}`
}

// 把识别快照发到本后端落盘；失败（如在纯 vite dev 下无 server）则静默降级到 localStorage
export async function emitTrace(traceId, snapshot) {
  const payload = { traceId, snapshot, ts: new Date().toISOString() }
  // 兜底：始终写一份到 localStorage，确保即使后端不可用也能本地回看
  try {
    const key = `trace:${traceId}`
    localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    /* ignore */
  }
  // 尝试落盘到后端（logs/ocr-<traceId>.json）
  try {
    const res = await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error('log endpoint ' + res.status)
    return { ok: true, persisted: true }
  } catch {
    return { ok: true, persisted: false }
  }
}

// 从 localStorage 读回（后端不可用时 AI 仍可让用户粘贴）
export function readTraceLocal(traceId) {
  try {
    const raw = localStorage.getItem(`trace:${traceId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
