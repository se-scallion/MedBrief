// 资料卡档案注入端到端验收（账号线 bug：injectPatient 键不匹配）
// 独立端口 5197 + 临时库，两账号各自档案；断言各自 html 含自己姓名、不含对方。
// 补 admin ?owner= 指定 + mask 脱敏不回填真名。
// 运行：node tests/verify-card-inject.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const PORT = 5197
const ROOT = path.join(import.meta.dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'medbrief-cardinject-'))
const REPORTS = path.join(TMP, 'reports.json')
const DATA_DIR = path.join(TMP, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.copyFileSync(path.join(ROOT, 'data', 'reports.json'), REPORTS)
const SECRET = 'card-inject-secret-32chars-minimum-ok'

process.env.MEDBRIEF_DATA_DIR = DATA_DIR
const accounts = await import('../lib/accounts.mjs')
const { loadPatientFor, savePatientFor } = await import('../lib/intakeCard.js')

const admin = accounts.createUser({ phone: '13228372097', password: 'scallion', role: 'admin' })
const alice = accounts.createUser({ phone: '13200000000', password: '123456', role: 'user', allowWeak: true })
const bob = accounts.createUser({ phone: '13900000001', password: 'bobpass88', role: 'user' })
// 各自写自己的档案（走 savePatientFor 隔离路径）
savePatientFor(alice.id, { name: '爱丽丝甲', diagnosis: '甲之诊断' })
savePatientFor(bob.id, { name: '鲍勃乙', diagnosis: '乙之诊断' })
// 报告归属：全部给 alice；bob 也有 1 份，便于各自身份出卡
const rep = JSON.parse(fs.readFileSync(REPORTS, 'utf8'))
for (const r of rep.reports) accounts.setOwner(r.id, alice.id, { source: 'bootstrap' })
if (rep.reports[1]) accounts.setOwner(rep.reports[1].id, bob.id, { source: 'bootstrap' })
// 出卡需要 card_export 授权（守卫层要求）；模拟主理人已授权
accounts.setPermissions(alice.id, { card_export: 1 }, admin.id)
accounts.setPermissions(bob.id, { card_export: 1 }, admin.id)

const ENV = { ...process.env, PORT: String(PORT), MEDBRIEF_REPORTS_FILE: REPORTS, MEDBRIEF_DATA_DIR: DATA_DIR, MB_SESSION_SECRET: SECRET, MEDBRIEF_AUTH: 'on' }
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitHealth() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return } catch {} await sleep(100) }
  throw new Error('服务未启动')
}
async function login(phone, password) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) })
  return (r.headers.get('set-cookie') || '').split(';')[0]
}
async function card(cookie, qs = '') {
  const r = await fetch(BASE + '/api/intake/card' + qs, { headers: { cookie } })
  const j = await r.json()
  return { status: r.status, html: j.html || '', patient: j.patient }
}

let pass = 0, fail = 0
const T = (name, cond) => { if (cond) { pass++; console.log('PASS ', name) } else { fail++; console.log('FAIL ', name) } }

const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
srv.stderr.on('data', (d) => { stderr += d.toString() })
try {
  await waitHealth()
  const cAdmin = await login(admin.phone, 'scallion')
  const cAlice = await login(alice.phone, '123456')
  const cBob = await login(bob.phone, 'bobpass88')

  // ① alice 出卡：含自己姓名，不含 bob 姓名
  const a = await card(cAlice)
  T('alice card 200', a.status === 200)
  T('alice html 含自己姓名「爱丽丝甲」', a.html.includes('爱丽丝甲'))
  T('alice html 不含 bob「鲍勃乙」', !a.html.includes('鲍勃乙'))
  T('alice patient 注入生效（非默认刘梦圆）', a.patient?.name === '爱丽丝甲')

  // ② bob 出卡：含自己姓名，不含 alice 姓名（关键：修复前两人都看到默认"刘梦圆"）
  const b = await card(cBob)
  T('bob card 200', b.status === 200)
  T('bob html 含自己姓名「鲍勃乙」', b.html.includes('鲍勃乙'))
  T('bob html 不含 alice「爱丽丝甲」', !b.html.includes('爱丽丝甲'))
  T('bob patient 注入生效（非默认刘梦圆）', b.patient?.name === '鲍勃乙')

  // ③ admin ?owner= 指定：能看到 alice 的档案
  const ao = await card(cAdmin, '?owner=' + alice.id)
  T('admin ?owner=alice 含 alice 姓名', ao.html.includes('爱丽丝甲'))
  const ao2 = await card(cAdmin, '?owner=' + bob.id)
  T('admin ?owner=bob 含 bob 姓名', ao2.html.includes('鲍勃乙'))

  // ④ mask 脱敏：不回填真名（注入档案后脱敏仍生效）
  const masked = await card(cAlice, '?mask=1')
  T('mask=1 不含完整真名', !masked.html.includes('爱丽丝甲'))
  T('mask=1 有脱敏痕迹（星号或姓氏保留）', /[*＊]/.test(masked.html) || masked.html.includes('爱'))

  console.log(`\n==========\n通过 ${pass} / 失败 ${fail}`)
  if (fail) process.exitCode = 1
} catch (e) {
  console.error('测试异常:', e.message, '\nstderr:', stderr.slice(-1500))
  process.exitCode = 1
} finally {
  srv.kill('SIGTERM')
  fs.rmSync(TMP, { recursive: true, force: true })
}
