// 账号系统端到端验证（独立端口 5196 + 临时库，绝不碰真实库/真 5174）
// 覆盖：静态闸 7×403 + 3×200、登录/限流、401/403、owner 过滤、card_export/guahao 授权、
//       sessionVersion 撤销、cookie 篡改、档案隔离。
// 运行：node tests/verify-auth.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

// 每次随机端口，避开连续跑时的 TIME_WAIT / 孤儿进程竞态
const PORT = 5200 + Math.floor(Math.random() * 300)
const ROOT = path.join(import.meta.dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'medbrief-auth-'))
const REPORTS = path.join(TMP, 'reports.json')
const DATA_DIR = path.join(TMP, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
// 真库副本（只读复制，测试里写也不影响真库）
fs.copyFileSync(path.join(ROOT, 'data', 'reports.json'), REPORTS)

const SECRET = 'verify-auth-secret-32chars-minimum-ok'
const ENV = {
  ...process.env,
  PORT: String(PORT),
  MEDBRIEF_REPORTS_FILE: REPORTS,
  MEDBRIEF_DATA_DIR: DATA_DIR,
  MB_SESSION_SECRET: SECRET,
  MEDBRIEF_AUTH: 'on',
}

const BASE = `http://127.0.0.1:${PORT}`
async function req(p, opts = {}) {
  const r = await fetch(BASE + p, { redirect: 'manual', ...opts })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, body, headers: r.headers }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealth(timeout = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return } catch {}
    await sleep(100)
  }
  throw new Error('服务未能启动')
}

async function login(phone, password) {
  return req('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  })
}
function cookieOf(r) {
  const sc = r.headers.get('set-cookie') || ''
  return sc.split(';')[0]
}

async function main() {
  // 临时库里建测试账号（用 accounts 模块指向临时 DATA_DIR）
  process.env.MEDBRIEF_DATA_DIR = DATA_DIR
  const accounts = await import('../lib/accounts.mjs')
  const admin = accounts.createUser({ phone: '13228372097', password: 'scallion', role: 'admin' })
  const owner = accounts.createUser({ phone: '13200000000', password: '123456', role: 'user', allowWeak: true })
  const other = accounts.createUser({ phone: '13900000000', password: 'otherpass', role: 'user' })
  // 归属：所有报告归 owner
  const rep = JSON.parse(fs.readFileSync(REPORTS, 'utf8'))
  const ids = [...rep.reports, ...(rep.trashed || [])].map((r) => r.id)
  for (const id of ids) accounts.setOwner(id, owner.id, { source: 'bootstrap' })
  const sampleId = ids[0]

  const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  srv.stderr.on('data', (d) => { stderr += d.toString() })
  try {
    await waitHealth()
    let pass = 0, fail = 0
    const T = (name, cond) => { if (cond) { pass++; console.log('PASS ', name) } else { fail++; console.log('FAIL ', name) } }

    // ---- 静态闸 ----
    const deny = ['/data/reports.json', '/%64ata/reports.json', '/DATA/reports.json', '/web/%2e%2e/data/reports.json', '/.git/config', '/web/index.html', '/web/src/App.jsx']
    for (const u of deny) {
      const r = await req(u)
      T(`静态 403 ${u}`, r.status === 403)
    }
    for (const u of ['/', '/index.html']) {
      const r = await req(u)
      T(`静态 200 ${u}`, r.status === 200)
    }
    const idx = await req('/index.html')
    T('/index.html 是 SPA 壳 <2KB', String(idx.body).length < 2000)
    // 资产肯定断言（非空守卫）
    const home = await req('/')
    const asset = String(home.body).match(/\/assets\/[^"']+\.js/)?.[0]
    T('首页能取到资产 URL', !!asset)
    if (asset) T(`资产 200 ${asset}`, (await req(asset)).status === 200)

    // ---- 未登录 401 ----
    T('未登录 reports 401', (await req('/api/intake/reports')).status === 401)

    // ---- 登录 ----
    const la = await login(admin.phone, 'scallion')
    T('admin 登录 200', la.status === 200 && la.body.ok)
    const adminCookie = cookieOf(la)
    T('admin cookie 存在', !!adminCookie)
    const lo = await login(owner.phone, '123456')
    T('owner 登录 200', lo.status === 200 && lo.body.ok)
    const ownerCookie = cookieOf(lo)
    const lot = await login(other.phone, 'otherpass')
    T('未授权用户登录 200', lot.status === 200 && lot.body.ok)
    const otherCookie = cookieOf(lot)
    T('错密码 401', (await login(admin.phone, 'wrong')).status === 401)

    // cookie 篡改：改 seal 串中间一字节（Fe26.* 紧凑串的中段）→ 401
    const rawCookie = decodeURIComponent(adminCookie.split('=').slice(1).join('='))
    const tampered = rawCookie.slice(0, 30) + (rawCookie[30] === 'A' ? 'B' : 'A') + rawCookie.slice(31)
    const badCookie = adminCookie.split('=')[0] + '=' + encodeURIComponent(tampered)
    T('cookie 篡改 401', (await req('/api/auth/me', { headers: { cookie: badCookie } })).status === 401)

    // /me
    const me = await req('/api/auth/me', { headers: { cookie: ownerCookie } })
    T('/me 返回 owner 身份', me.status === 200 && me.body.user?.phone === '13200000000' && me.body.permissions?.role === 'user')

    // ---- owner 过滤 ----
    const adminList = await req('/api/intake/reports', { headers: { cookie: adminCookie } })
    T('admin 看全库 >0', adminList.status === 200 && adminList.body.total > 0)
    const ownerList = await req('/api/intake/reports', { headers: { cookie: ownerCookie } })
    T('owner 看自己 >0', ownerList.status === 200 && ownerList.body.total > 0)
    const otherList = await req('/api/intake/reports', { headers: { cookie: otherCookie } })
    T('第三方看 0 条', otherList.status === 200 && otherList.body.total === 0)
    T('第三方读他人报告 403', (await req(`/api/intake/reports/${sampleId}`, { headers: { cookie: otherCookie } })).status === 403)

    // ---- 功能授权 ----
    T('普通用户 card 403', (await req('/api/intake/card', { headers: { cookie: ownerCookie } })).status === 403)
    T('admin card 200', (await req('/api/intake/card', { headers: { cookie: adminCookie } })).status === 200)
    T('普通用户 guahao 403', (await req('/api/guahao/orders', { headers: { cookie: ownerCookie } })).status === 403)
    // 授权后放行
    accounts.setPermissions(owner.id, { card_export: 1, guahao: 1 }, admin.id)
    T('授权后 card 200', (await req('/api/intake/card', { headers: { cookie: ownerCookie } })).status === 200)
    T('授权后 guahao 200', (await req('/api/guahao/orders', { headers: { cookie: ownerCookie } })).status === 200)

    // ---- 档案隔离 ----
    const pa = await req('/api/intake/patient', { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'owner改名' }) })
    T('owner 改自己档案 200', pa.status === 200)
    const po = await req('/api/intake/patient', { headers: { cookie: otherCookie } })
    T('他人档案不受影响（隔离）', po.status === 200 && po.body.patient?.name !== 'owner改名')

    // ---- sessionVersion 撤销 ----
    accounts.bumpSessionVersion(owner.id, 'manual_kick', admin.id)
    T('sessionVersion+1 后旧 cookie 401', (await req('/api/auth/me', { headers: { cookie: ownerCookie } })).status === 401)

    // ---- 限流 ----
    for (let i = 0; i < 10; i++) await login('13900000009', 'wrongpw')
    const locked = await login('13900000009', 'wrongpw')
    T('第11次锁定 429', locked.status === 429)

    // ---- 管理员账号管理接口（端到端）----
    const adminHeaders = { cookie: adminCookie, 'content-type': 'application/json' }
    const userList = await req('/api/admin/users', { headers: { cookie: adminCookie } })
    T('admin GET /api/admin/users 200', userList.status === 200 && (userList.body.users?.length || 0) >= 3)
    T('非 admin GET 管理列表 403', (await req('/api/admin/users', { headers: { cookie: otherCookie } })).status === 403)
    const created = await req('/api/admin/users', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ phone: '13900000005', password: 'newpass88', role: 'user', card_export: false, guahao: true }) })
    T('admin 建号 200', created.status === 200 && created.body.user?.phone === '13900000005')
    const newId = created.body.user?.id
    const perm = await req('/api/admin/users/permissions', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: newId, card_export: true }) })
    T('admin 授权 card_export 生效', perm.status === 200 && perm.body.user?.card_export === 1)
    const chg = await req('/api/admin/users/phone', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: newId, phone: '13900000006' }) })
    T('admin 改号 + sessionVersion+1', chg.status === 200 && chg.body.user?.phone === '13900000006' && chg.body.user?.sessionVersion === 1)
    const kick = await req('/api/admin/users/kick', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: newId }) })
    T('admin 踢下线 sessionVersion+1', kick.status === 200 && kick.body.user?.sessionVersion === 2)

    console.log(`\n==========\n通过 ${pass} / 失败 ${fail}`)
    if (fail) process.exitCode = 1
  } finally {
    srv.kill('SIGKILL')
    // 等进程真正退出再删临时库，避免 sqlite 句柄残留导致下一次跑拿到半删的库
    if (srv.exitCode === null && srv.signalCode === null) {
      await new Promise((r) => { srv.once('exit', r); setTimeout(r, 500) })
    }
    if (stderr && process.env.AUTH_TEST_DEBUG) console.error('server stderr:', stderr.slice(-2000))
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  }
}

main().catch((e) => { console.error('测试异常:', e); process.exitCode = 1 })
