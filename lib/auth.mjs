// 鉴权核心（账号系统方案 v0.8）：登录 / 会话 / 守卫 / 权限 / owner 过滤
//
// 会话选型：iron-session 9.1.0（vendored 到 vendor/，q1 裁定 B），只用它的 sealData/unsealData。
//   · 原生 node:http 下手工读 Cookie / 写 Set-Cookie，不依赖框架中间件（小样第 8 条）。
//   · unsealData 校验失败返回 {}（fail-closed）⇒ 守卫判 session.uid 存在与否即可（q1 实测）。
//   · 「登出」只清客户端 cookie；真撤销 = users.sessionVersion+1（方案 D0 写死）。
//   · SESSION_SECRET env 读，≥32 字符，绝不落 data/；轮转用数组 [new, old]。
//
// 本模块只提供纯函数/拦截器，不碰 server.mjs 的路由分发（由 server 调用）。

import crypto from 'node:crypto'
import { sealData, unsealData } from './session/index.mjs'
import * as accounts from './accounts.mjs'

const COOKIE_NAME = 'mb_session'
const SESSION_TTL = 8 * 60 * 60 // 8 小时

function secrets() {
  const raw = process.env.MB_SESSION_SECRET || ''
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.length || list.some((s) => s.length < 32)) {
    throw Object.assign(new Error('MB_SESSION_SECRET 必须设置且每段 ≥32 字符（多段逗号分隔用于轮换）'), { code: 'NO_SECRET' })
  }
  return list
}

/** 启动时自检：缺 secret / 缺包 → 明确退出（q1 Q1-G5：不许静默降级） */
export function assertSessionReady() {
  const s = secrets()
  // 试封一次，确认 vendored 包可用（导出在 import 时已验证）
  return sealData({ probe: 1 }, { password: s[0], ttl: 60 }).then(() => true)
}

// ---------- cookie 读写（原生 node:http）----------
function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export async function createSessionCookie(user) {
  const s = secrets()
  const sealed = await sealData({ uid: user.id, v: user.sessionVersion }, { password: s[0], ttl: SESSION_TTL })
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sealed)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL}`,
  ]
  if (process.env.MB_COOKIE_SECURE === '1') parts.push('Secure')
  return parts.join('; ')
}
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

/** 解 cookie；返回 {uid, v} 或 null（篡改/过期/错 secret 都 fail-closed 到 null） */
export async function readSession(req) {
  const raw = parseCookies(req.headers?.cookie)[COOKIE_NAME]
  if (!raw) return null
  let val = raw
  try { val = decodeURIComponent(raw) } catch {}
  for (const secret of secrets()) {
    try {
      const s = await unsealData(val, { password: secret, ttl: SESSION_TTL })
      if (s && s.uid && Number.isInteger(s.v)) return { uid: s.uid, v: s.v }
    } catch {}
  }
  return null
}

// ---------- 登录（含限流）----------
function clientIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  return xf || req.socket?.remoteAddress || 'unknown'
}

/**
 * 登录。返回 { ok:true, user, cookie } 或 { ok:false, status, error, retryAfter? }
 * 三组响应（无此号/密码错/锁定）正文一致，防枚举；不存在号也跑一次 dummy scrypt 对齐时长。
 */
export async function login(req, phoneRaw, password) {
  const phone = String(phoneRaw || '')
  const ipKey = 'ip:' + clientIp(req)
  const phoneKey = 'phone:' + phone
  const ipAttempt = accounts.getAttempt(ipKey)
  const phoneAttempt = accounts.getAttempt(phoneKey)
  const locked = accounts.backoffSeconds(ipAttempt) === -1 || accounts.backoffSeconds(phoneAttempt) === -1
  if (locked) {
    return { ok: false, status: 429, error: '账号或密码错误', retryAfter: 60 }
  }
  // 退避：未到锁定但处于退避窗口 → 仍受理但让调用方知道延迟（由 server 决定是否 sleep；本模块不挂连接）
  const backoff = Math.max(accounts.backoffSeconds(ipAttempt), accounts.backoffSeconds(phoneAttempt), 0)

  const user = accounts.getUserByPhone(phone)
  const dummySalt = '00000000000000000000000000000000'
  const dummyHash = '0'.repeat(128)
  const good = user ? accounts.verifyPassword(password, user.salt, user.password_hash)
                    : accounts.verifyPassword(password, dummySalt, dummyHash) // 同分布 dummy scrypt

  if (!good || !user || user.disabled) {
    accounts.recordFailedAttempt(phoneKey, 'phone')
    accounts.recordFailedAttempt(ipKey, 'ip')
    return { ok: false, status: 401, error: '账号或密码错误', backoff }
  }
  accounts.clearPhoneAttempts(phone)
  return { ok: true, user: accounts.publicUser(user), cookie: await createSessionCookie(user), backoff }
}

/** 守卫层解析当前用户：解 cookie → 查库 → 比对 sessionVersion → 返回 publicUser 或 null */
export function currentUser(session) {
  if (!session) return null
  const u = accounts.getUserById(session.uid)
  if (!u || u.disabled || u.sessionVersion !== session.v) return null
  return accounts.publicUser(u)
}

// ---------- 权限判定 ----------
export function can(user, perm) {
  if (!user) return false
  if (user.role === 'admin') return true
  if (perm === 'login') return true
  if (perm === 'card_export') return !!user.card_export
  if (perm === 'guahao') return !!user.guahao
  return false
}
/** owner 校验：admin 豁免；user 仅本人报告 */
export function owns(user, reportId) {
  if (!user) return false
  if (user.role === 'admin') return true
  const o = accounts.getOwner(reportId)
  return !!o && o.user_id === user.id
}
/** blob 取回：admin 豁免；user = 被我的报告引用 或 我上传的 */
export function ownsBlob(user, blobId) {
  if (!user) return false
  if (user.role === 'admin') return true
  if (accounts.getBlobOwner(blobId)?.user_id === user.id) return true
  // 被我的报告引用：blobs.report_id → report_owners
  return accounts.blobReferencedByUser(blobId, user.id)
}

// ---------- 审计 ----------
export function auditLoginFail(req, phone, reason) {
  accounts.appendAuthz({ targetUserId: null, action: 'login_fail', after: JSON.stringify({ phone: phone.slice(0, 3) + '****' + phone.slice(-4), reason, ip: clientIp(req) }) })
}

export { COOKIE_NAME, clientIp }
