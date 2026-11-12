// 统一 API 调用：一律走同源（server.mjs 5174），不写死 host。
export async function jfetch(path, opts = {}) {
  const res = await fetch(path, opts)
  const body = await res.json().catch(() => ({}))
  if (!res.ok || (body && body.ok === false)) {
    const err = new Error(body?.error || body?.message || `HTTP ${res.status}`)
    err.body = body
    err.status = res.status
    throw err
  }
  return body
}

export const jget = (path) => jfetch(path)

export const jpost = (path, data) =>
  jfetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  })
