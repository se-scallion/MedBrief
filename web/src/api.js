// 统一 API 调用：一律走同源（server.mjs 5174），不写死 host。
export async function jfetch(path, opts = {}) {
  const res = await fetch(path, opts)
  const body = await res.json().catch(() => ({}))
  if (!res.ok || (body && body.ok === false)) {
    const err = new Error(body?.error || body?.message || `HTTP ${res.status}`)
    err.body = body
    err.status = res.status
    // 会话失效：通知 App 跳登录页（登录接口自身的 401 不触发，避免登录页自己把自己踢走）
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      try { window.dispatchEvent(new CustomEvent('mb:unauthorized')) } catch {}
    }
    // 403：交给 App 统一弹人话提示，避免手机上前端把 403 JSON 渲染成白屏（用户实际踩到过）
    if (res.status === 403) {
      try { window.dispatchEvent(new CustomEvent('mb:forbidden', { detail: body || {} })) } catch {}
    }
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
