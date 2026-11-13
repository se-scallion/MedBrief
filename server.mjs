// ===================== MedBrief 独立后端服务 =====================
// 适用场景：MedBrief 挂号与问诊资料整理独立 Web 服务
// 独立端口：5174（独立于 MedData 的 5173）
// 提供 API：
//   - GET  /api/health               服务健康与状态探活
//   - GET  /api/guahao/schedule      医院科室排班号源看板
//   - POST /api/guahao/book          预约下单与生成凭证
//   - GET  /api/guahao/orders        历史预约与凭证列表
//   - POST /api/guahao/cancel        取消预约并回滚释放号源
//   - POST /api/brief/bundle         问诊病历录入并打包为 MedData 标准交换包 (.meddata)
//   - GET  /api/meddata/summary      就诊前从本机 MedData 数据服务(8787)载入近期指标（不可用则 ok:false，前端降级导入 .meddata）
//   - POST /api/brief/import         导入 .meddata 交换包并解析出近期指标（通道 2 的降级路径）
//   - GET  /api/intake/reports       已导入报告清单（不含原图/原文）
//   - POST /api/intake/reports       报告入库（查重：图片 sha256/dhash + 内容指纹）
//   - GET  /api/intake/patient       病友档案（不含身份证/手机号/住址）
//   - POST /api/intake/patient       更新病友档案（patch，身份类字段一律不收）
//   - GET  /api/intake/card          问诊资料卡（A4 一页 HTML；?mask=0 关闭姓名脱敏）
//   - GET  /api/brief/visit-summary  本次就诊一页速览（纯文本 + 可打印 HTML；只陈述数值与趋势，不下结论）
//   - GET  /api/guahao/sniper/status 114 会话与时钟差校准状态
//   - POST /api/guahao/reset         排班与订单重置（供自动化测试隔离用）
//   - GET  /api/guahao/114/catalog/hospitals        114 医院目录（免登录）
//   - GET  /api/guahao/114/catalog/depts?hosCode=   114 科室树（免登录）
//   - POST /api/guahao/114/flow/start               启动真实浏览器挂号流程
//   - GET  /api/guahao/114/flow/:id                 轮询流程状态
//   - GET  /api/guahao/114/flow/latest              最近一次流程
//   - GET  /api/guahao/114/flow/:id/captcha.png     图形验证码图（手动兜底用）
//   - POST /api/guahao/114/flow/:id/sms             提交 6 位短信验证码
//   - POST /api/guahao/114/flow/:id/captcha         提交 4 位图形验证码
//   - POST /api/guahao/114/flow/:id/confirm         确认 / 放弃待确认号源
//   - POST /api/guahao/114/flow/:id/abort           中止流程
//   - 静态托管：apps/medbrief-web/index.html 及静态资源

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createGuahaoManager } from './lib/guahaoCore.js'
import { buildMedDataBundle, parseMedDataBundle } from './lib/meddataBundle.js'
import { blocksToLines } from './lib/visionLayout.mjs'
import {
  sha256Bytes, findDuplicate, stitchVertically,
  parseLabRows, buildReportFingerprint, groupForDoctorCard, summarizeForCard, dedupeStitchRows, mergeChunkRows,
} from './lib/reportIntake.mjs'
import { loadPatient, savePatient, buildCard } from './lib/intakeCard.js'
import { saveBlob, getBlob, listBlobs, linkBlobToReport, blobStats } from './lib/blobStore.mjs'
import { planChunks, cropChunks, imageSize, cropToContent } from './lib/imageChunker.mjs'
import { autoDeskew } from './lib/deskew.mjs'
import { readPdf, guessReportDate } from './lib/pdfIntake.mjs'
import { summarizeState, formatSummaryText } from './lib/metricsSummary.js'
import { buildVisitBrief } from './lib/visitBrief.js'
import { fetchLiveDoctorSchedule } from './lib/bjcyhScraper.js'
import { createGuahao114Service } from './lib/guahao114Service.js'
import { mountMedData } from './meddata/mount.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = parseInt(process.env.PORT || '5174', 10)
// 进程启动信息：用于判断「长驻进程是否落后于代码」（配合 /api/health.head 比对 git HEAD）
const SERVER_STARTED_AT = new Date().toISOString()
const SERVER_GIT = (() => {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim()
    // 启动时工作树是否干净：head 只是「启动那一刻的提交」，若当时工作树有未提交改动，
    // head 会落后于实际加载的代码（2026-11-12 实测踩到：行为已是新版，head 却显示旧提交）。
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: __dirname, encoding: 'utf8' }).trim()
    const dirtyCount = dirty ? dirty.split('\n').filter(Boolean).length : 0
    return { head, dirty: dirtyCount > 0, dirtyCount }
  } catch {
    return { head: 'unknown', dirty: null, dirtyCount: null }
  }
})()
const SERVER_HEAD = SERVER_GIT.head
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const STORAGE_FILE = path.join(DATA_DIR, 'guahao-orders.json')
const AUTH_FILE = path.join(DATA_DIR, '114-auth.json')
const guahaoManager = createGuahaoManager({ storageFile: STORAGE_FILE, fs })
const guahao114 = createGuahao114Service({ dataDir: DATA_DIR, ordersFile: STORAGE_FILE })

let activeLoginBrowser = null
// 最近一次导入的 .meddata state（内存态，仅用于生成「本次就诊一页速览」，不落盘）
let lastImportedState = null

function getStoredAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    } catch {
      return {}
    }
  }
  return {}
}

function saveStoredAuth(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), 'utf8')
}

function runBridge(payload) {
  return new Promise((resolve) => {
    // 历史遗留通道：票据直连（已被瑞数 WAF 证伪，仅保留给 /api/guahao/sniper/status 的兼容展示）。
    // 真实挂号请走 /api/guahao/114/flow/*（浏览器流程）。
    const bridgeScript = path.join(__dirname, 'tools', 'bridge.py')
    if (!fs.existsSync(bridgeScript)) {
      resolve({ ok: false, error: `bridge 脚本缺失：${bridgeScript}` })
      return
    }
    const py = spawn('python3', [bridgeScript])
    let out = ''
    let err = ''
    py.stdout.on('data', (d) => { out += d })
    py.stderr.on('data', (d) => { err += d })
    py.on('close', () => {
      try {
        resolve(JSON.parse(out))
      } catch (e) {
        resolve({ ok: false, error: out.trim() || err.trim() || e.message })
      }
    })
    py.stdin.write(JSON.stringify(payload))
    py.stdin.end()
  })
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
}

function sendJson(res, statusCode, data) {
  setCors(res)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function serveStatic(req, res, filePath) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: 'File Not Found' })
    return
  }

  const ext = path.extname(filePath).toLowerCase()
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.meddata': 'application/json; charset=utf-8',
  }

  const contentType = mimeMap[ext] || 'application/octet-stream'
  setCors(res)
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  fs.createReadStream(filePath).pipe(res)
}

const server = http.createServer(async (req, res) => {
  setCors(res)

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = parsedUrl.pathname

  // 1. GET /api/health
  //    ⚠️ 带上 head/startedAt：长驻 node 进程不热更新，改了 lib/* 忘重启会静默用旧模块
  //    （2026-11-12 真实踩到：intakeCard.js 改了但进程还是旧的，卡片脚注看不到）。
  //    判据：`curl /api/health | jq -r .head` 与 `git rev-parse --short HEAD` 不一致 = 进程落后于代码。
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      head: SERVER_HEAD,
      // 判据：head ≠ git HEAD 时先看 dirty —— dirty:true 表示「启动时工作树有未提交改动」，
      // 那种情况下 head 会落后于实际加载的代码，属无害错位；dirty:false 且仍不一致才是进程真的落后。
      dirty: SERVER_GIT.dirty,
      dirtyCount: SERVER_GIT.dirtyCount,
      startedAt: SERVER_STARTED_AT,
      app: 'medbrief',
      name: 'MedBrief Standalone Workbench',
      port: PORT,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    })
    return
  }

  // 1a. GET /api/meddata/summary — 就诊前从本机 MedData 数据服务（8787）载入近期指标
  // 口径见 INTERFACE.md 通道 2。8787 不可用时**不报错**，回 ok:false + unavailable:true，
  // 前端据此自动降级到「导入 .meddata 文件」。token 只从环境变量取，绝不下发前端。
  if (req.method === 'GET' && pathname === '/api/meddata/summary') {
    const dataUrl = process.env.MEDDATA_DATA_URL || 'http://127.0.0.1:8787'
    const token = process.env.MEDDATA_SYNC_TOKEN || ''
    try {
      const r = await fetch(`${dataUrl}/api/summary`, {
        headers: token ? { 'x-sync-token': token } : {},
        signal: AbortSignal.timeout(2500),
      })
      if (!r.ok) throw new Error(`8787 返回 HTTP ${r.status}`)
      const j = await r.json()
      if (!j || j.ok !== true) throw new Error(j?.error || '8787 返回内容异常')
      sendJson(res, 200, { ...j, source: 'live', sourceUrl: dataUrl, text: formatSummaryText(j) })
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        unavailable: true,
        source: 'unavailable',
        sourceUrl: dataUrl,
        reason: e.name === 'TimeoutError' ? '8787 超时未响应' : e.message,
        fallback: 'import',
        hint: '本机 MedData 数据服务未启动；改用「导入 .meddata 文件」即可，功能不受影响。',
      })
    }
    return
  }

  // 1c. GET /api/brief/visit-summary — 本次就诊一页速览（只陈述数值/时间/趋势，不下结论）
  // 数据源：优先用本次会话导入的 .meddata state；否则读 8787 /api/state（只读）。两者都不可用则回 unavailable。
  if (req.method === 'GET' && pathname === '/api/brief/visit-summary') {
    const limit = Math.min(10, Math.max(1, parseInt(parsedUrl.searchParams.get('limit') || '3', 10) || 3))
    const source = parsedUrl.searchParams.get('source') || 'auto'
    try {
      let state = null
      let sourceLabel = ''
      if (source !== 'live' && lastImportedState) {
        state = lastImportedState
        sourceLabel = '导入的 .meddata 交换包'
      } else if (source === 'import') {
        sendJson(res, 409, {
          ok: false,
          error: '本次会话还没有导入过 .meddata 包',
          hint: '先点「导入 .meddata 文件」，再生成速览。',
        })
        return
      } else {
        const dataUrl = process.env.MEDDATA_DATA_URL || 'http://127.0.0.1:8787'
        const token = process.env.MEDDATA_SYNC_TOKEN || ''
        const r = await fetch(`${dataUrl}/api/state`, {
          headers: token ? { 'x-sync-token': token } : {},
          signal: AbortSignal.timeout(3000),
        })
        if (!r.ok) throw new Error(`8787 返回 HTTP ${r.status}`)
        const j = await r.json()
        state = j.state || j
        sourceLabel = '本机 MedData（8787，只读）'
      }
      const brief = buildVisitBrief({ state, limit, sourceLabel, generatedAt: new Date().toISOString() })
      sendJson(res, 200, { ok: true, ...brief })
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        unavailable: true,
        reason: e.name === 'TimeoutError' ? '8787 超时未响应' : e.message,
        hint: '本机 MedData 未启动；先「导入 .meddata 文件」再生成速览。',
      })
    }
    return
  }


async function readJsonBody(req) {
  const raw = req.__rawBody != null ? req.__rawBody : ''
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

// ---------- 报告入库存储（data/reports.json，本机文件，不入 git） ----------
const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json')
function readReports() {
  try {
    const j = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'))
    return { reports: Array.isArray(j.reports) ? j.reports : [] }
  } catch {
    return { reports: [] }
  }
}
function writeReports(store) {
  fs.mkdirSync(path.dirname(REPORTS_FILE), { recursive: true })
  fs.writeFileSync(REPORTS_FILE, JSON.stringify({ version: 1, reports: store.reports }, null, 2), 'utf8')
}

function getNextReleaseCountdown() {
  // 全部用「epoch 毫秒 + 固定 +08:00」计算，再用 getUTC* 读北京墙上时间。
  // 旧实现用 toISOString() 打印位移后的 Date，会把 UTC 当成北京时间（显示 09:30 而非 17:30）；
  // 且放号对应就诊日错用了「今天 +14」，与院方口径「次日 07:00 放第 14 天号源」差一天。
  const BJ = 8 * 3600 * 1000
  const pad = (n) => String(n).padStart(2, '0')
  const fmtBj = (ms) => {
    const d = new Date(ms + BJ)
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  }
  const nowMs = Date.now()
  const bj = new Date(nowMs + BJ) // 其 getUTC* 即北京墙上时间
  let targetMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 7, 0, 0) - BJ
  if (nowMs >= targetMs) targetMs += 24 * 3600 * 1000

  const diffMs = targetMs - nowMs
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  // 放号日当天释放的是「放号日 + 14 天」的就诊号源
  const releaseBj = new Date(targetMs + BJ)
  const bookDay = new Date(Date.UTC(releaseBj.getUTCFullYear(), releaseBj.getUTCMonth(), releaseBj.getUTCDate() + 14))
  const targetDateForBooking = `${bookDay.getUTCFullYear()}-${pad(bookDay.getUTCMonth() + 1)}-${pad(bookDay.getUTCDate())}`

  return {
    nowBeijing: fmtBj(nowMs),
    targetReleaseTime: fmtBj(targetMs),
    targetDateForBooking,
    diffMs,
    countdown: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`,
    hours,
    minutes,
    seconds,
  }
}

  // 1b. GET /api/guahao/monitor/realtime
  if (req.method === 'GET' && pathname === '/api/guahao/monitor/realtime') {
    try {
      const force = parsedUrl.searchParams.get('force') === 'true'
      const schedule = await fetchLiveDoctorSchedule(force)
      const countdown = getNextReleaseCountdown()
      sendJson(res, 200, {
        ...schedule,
        countdown,
      })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // 1c. GET /api/guahao/monitor/countdown
  if (req.method === 'GET' && pathname === '/api/guahao/monitor/countdown') {
    try {
      const countdown = getNextReleaseCountdown()
      sendJson(res, 200, { ok: true, ...countdown })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // ===== 114 真实浏览器挂号：查询类接口 =====
  // GET /api/guahao/114/catalog/hospitals?force=1
  if (req.method === 'GET' && pathname === '/api/guahao/114/catalog/hospitals') {
    try {
      const force = parsedUrl.searchParams.get('force') === '1'
      const data = await guahao114.fetchHospitals({ force })
      sendJson(res, 200, { ok: true, ...data })
    } catch (e) {
      sendJson(res, e.code === 'WAF_BLOCKED' ? 503 : 500, { ok: false, code: e.code || 'ERROR', error: e.message })
    }
    return
  }

  // GET /api/guahao/114/catalog/depts?hosCode=xxx&force=1
  if (req.method === 'GET' && pathname === '/api/guahao/114/catalog/depts') {
    try {
      const hosCode = parsedUrl.searchParams.get('hosCode') || ''
      if (!hosCode) {
        sendJson(res, 400, { ok: false, error: '缺少 hosCode' })
        return
      }
      const force = parsedUrl.searchParams.get('force') === '1'
      const data = await guahao114.fetchDepts(hosCode, { force })
      sendJson(res, 200, { ok: true, ...data })
    } catch (e) {
      sendJson(res, e.code === 'WAF_BLOCKED' ? 503 : 500, { ok: false, code: e.code || 'ERROR', error: e.message })
    }
    return
  }

  // GET /api/guahao/114/session —— 浏览器里现有登录态（不触发短信）
  if (req.method === 'GET' && pathname === '/api/guahao/114/session') {
    try {
      const r = await guahao114.checkSession()
      if (!r.ok) {
        sendJson(res, 200, { ok: true, loggedIn: false, error: r.error })
        return
      }
      const u = r.result.user || {}
      sendJson(res, 200, {
        ok: true,
        loggedIn: !!r.result.loggedIn,
        user: r.result.loggedIn
          ? {
              mobile: u.mobileConfound || null,
              name: u.nameConfound || null,
              idCard: u.idCardNoConfound || null,
              authStatus: u.authStatus,
              authStatusView: u.authStatusView || null,
            }
          : null,
      })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // GET /api/guahao/114/catalog/stats —— 目录缓存体检
  if (req.method === 'GET' && pathname === '/api/guahao/114/catalog/stats') {
    try {
      sendJson(res, 200, { ok: true, ...guahao114.catalogStats() })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // GET /api/guahao/114/flow/latest
  if (req.method === 'GET' && pathname === '/api/guahao/114/flow/latest') {
    const flow = guahao114.latestFlow()
    sendJson(res, 200, { ok: true, flow })
    return
  }

  // GET /api/guahao/114/flow/:id/captcha.png
  {
    const m = pathname.match(/^\/api\/guahao\/114\/flow\/([^/]+)\/captcha\.png$/)
    if (req.method === 'GET' && m) {
      const img = guahao114.captchaImagePath(m[1])
      if (!img || !fs.existsSync(img)) {
        sendJson(res, 404, { ok: false, error: '验证码图片不存在或已过期' })
        return
      }
      setCors(res)
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'no-store')
      fs.createReadStream(img).pipe(res)
      return
    }
  }

  // GET /api/guahao/114/flow/:id
  {
    const m = pathname.match(/^\/api\/guahao\/114\/flow\/([^/]+)$/)
    if (req.method === 'GET' && m) {
      const flow = guahao114.getFlow(m[1])
      if (!flow) {
        sendJson(res, 404, { ok: false, error: '流程不存在' })
        return
      }
      sendJson(res, 200, { ok: true, flow })
      return
    }
  }

  // 2. GET /api/guahao/schedule
  if (req.method === 'GET' && pathname === '/api/guahao/schedule') {
    try {
      const hospital = parsedUrl.searchParams.get('hospital') || '北京朝阳医院'
      const department = parsedUrl.searchParams.get('department') || '血液科'
      const date = parsedUrl.searchParams.get('date') || '2026-11-16'
      const doctorName = parsedUrl.searchParams.get('doctorName') || ''
      const result = guahaoManager.getSchedule({ hospital, department, date, doctorName })
      sendJson(res, 200, result)
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // 2b. GET /api/guahao/doctors — 本地医生档案（前端「选项」数据源）
  if (req.method === 'GET' && pathname === '/api/guahao/doctors') {
    try {
      sendJson(res, 200, guahaoManager.getDoctors())
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/guahao/orders') {
    try {
      const patientName = parsedUrl.searchParams.get('patientName') || ''
      const idCard = parsedUrl.searchParams.get('idCard') || ''
      const result = guahaoManager.getOrders({ patientName, idCard })
      sendJson(res, 200, result)
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // 4. GET /api/guahao/sniper/status
  if (req.method === 'GET' && pathname === '/api/guahao/sniper/status') {
    try {
      const auth = getStoredAuth()
      const localStatus = guahaoManager.getSniperStatus()
      const ticket = auth.ticket || ''
      const cookie = auth.cookie || ''

      let bridgeInfo = { isLogin: false }
      let deltaInfo = { deltaMs: -120 }

      if (ticket || cookie) {
        bridgeInfo = await runBridge({ action: 'check_session', ticket, cookie })
        const td = await runBridge({ action: 'time_diff', ticket, cookie })
        if (td.ok) deltaInfo.deltaMs = td.deltaMs
      }

      sendJson(res, 200, {
        ...localStatus,
        isLogin: !!bridgeInfo.isLogin,
        user: bridgeInfo.user || null,
        patients: bridgeInfo.patients || [],
        clockDelta: deltaInfo.deltaMs,
        sessionTicket: ticket ? (ticket.slice(0, 8) + '****' + ticket.slice(-4)) : null,
        hasCustomCookie: !!cookie,
        realMode: !!bridgeInfo.isLogin,
        modeLabel: bridgeInfo.isLogin ? '114 官方在线直连模式' : '本地沙盒/仿真预约模式',
      })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // 4b. GET /api/guahao/114/auth（仅排障，见 7b 说明；正常流程用 /api/guahao/114/session）
  if (req.method === 'GET' && pathname === '/api/guahao/114/auth') {
    const auth = getStoredAuth()
    const ticket = auth.ticket || ''
    sendJson(res, 200, {
      ok: true,
      hasTicket: !!ticket,
      hasCookie: !!auth.cookie,
      maskedTicket: ticket ? (ticket.slice(0, 8) + '****' + ticket.slice(-4)) : '',
      updatedAt: auth.updatedAt || null,
    })
    return
  }

  // 读取 POST 请求体
  let bodyBuffer = []
  if (req.method === 'POST') {
    for await (const chunk of req) {
      bodyBuffer.push(chunk)
    }
    const rawBody = Buffer.concat(bodyBuffer).toString('utf8')
    // POST 体已被本分支读空；留一份给后续非 POST 作用域的处理器（如 /api/intake/*）
    req.__rawBody = rawBody
    let payload = {}
    try {
      payload = rawBody ? JSON.parse(rawBody) : {}
    } catch (e) {
      sendJson(res, 400, { ok: false, error: '无效的 JSON 请求体: ' + e.message })
      return
    }

    // ===== 114 真实浏览器挂号：动作类接口 =====
    // POST /api/guahao/114/flow/start
    if (pathname === '/api/guahao/114/flow/start') {
      try {
        const result = guahao114.startFlow(payload)
        sendJson(res, result.ok ? 200 : 409, result)
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
      return
    }

    // POST /api/guahao/114/flow/:id/{sms,captcha,confirm,abort}
    {
      const m = pathname.match(/^\/api\/guahao\/114\/flow\/([^/]+)\/(sms|captcha|confirm|abort)$/)
      if (m) {
        const [, id, action] = m
        try {
          if (action === 'sms') {
            const r = await guahao114.submitSms(id, payload.code)
            sendJson(res, r.ok ? 200 : 400, r)
          } else if (action === 'captcha') {
            const r = guahao114.submitCaptcha(id, payload.code)
            sendJson(res, r.ok ? 200 : 400, r)
          } else if (action === 'confirm') {
            const r = guahao114.submitConfirm(id, payload.approve)
            sendJson(res, r.ok ? 200 : 400, r)
          } else {
            const r = await guahao114.abortFlow(id)
            sendJson(res, r.ok ? 200 : 400, r)
          }
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e.message })
        }
        return
      }
    }

    // 5. POST /api/guahao/book
    if (pathname === '/api/guahao/book') {
      try {
        const result = guahaoManager.bookAppointment(payload)
        const order = result.voucher || result.order || {}
        sendJson(res, result.ok ? 200 : 400, {
          ...result,
          order,
          voucher: order,
          orderId: result.orderId || order.orderId,
        })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
      return
    }

    // 6. POST /api/guahao/cancel
    if (pathname === '/api/guahao/cancel') {
      try {
        const result = guahaoManager.cancelOrder(payload.orderId)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
      return
    }

    // 7. POST /api/guahao/reset
    if (pathname === '/api/guahao/reset') {
      try {
        guahaoManager.reset()
        sendJson(res, 200, { ok: true, message: '排班与订单数据已恢复重置' })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
      return
    }

    // 7b. POST /api/guahao/114/auth
    // ⚠️ 仅排障通道：要求用户从 F12 手工复制 cmi-user-ticket，与「面向普通患者、禁止 F12」的产品原则冲突，
    //    且票据直连在瑞数 WAF 下实测返回 462（见 .agents/MEMORY.md）。
    //    正常登录请走 /api/guahao/114/flow/*（ego 浏览器复用登录态），不要给患者暴露本接口。
    if (pathname === '/api/guahao/114/auth') {
      try {
        const ticket = String(payload.ticket || '').trim()
        const cookie = String(payload.cookie || '').trim()
        saveStoredAuth({
          ticket,
          cookie,
          updatedAt: new Date().toISOString(),
        })

        // 立即验证连接
        const check = await runBridge({ action: 'check_session', ticket, cookie })
        sendJson(res, 200, {
          ok: true,
          saved: true,
          isLogin: !!check.isLogin,
          user: check.user || null,
          patients: check.patients || [],
          message: check.isLogin ? '114 会话鉴权成功，已直连官方账号！' : (check.error || '凭据已保存，但 114 鉴权未通过'),
        })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
      return
    }

    // 7c. POST /api/guahao/114/launch-login (方案1：弹出真实窗口无感捕获)
    if (pathname === '/api/guahao/114/launch-login') {
      try {
        if (activeLoginBrowser) {
          try { await activeLoginBrowser.close() } catch {}
          activeLoginBrowser = null
        }

        const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        const browser = await chromium.launch({
          executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
          headless: false,
          args: ['--window-size=500,720', '--window-position=300,100'],
        })
        activeLoginBrowser = browser
        const context = await browser.newContext({
          viewport: { width: 480, height: 680 },
          locale: 'zh-CN',
        })
        const page = await context.newPage()
        await page.goto('https://www.114yygh.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})

        let captured = false
        const checkInterval = setInterval(async () => {
          if (captured || !activeLoginBrowser) {
            clearInterval(checkInterval)
            return
          }
          try {
            const cookies = await context.cookies()
            const ticketCookie = cookies.find((c) => c.name === 'cmi-user-ticket')
            if (ticketCookie && ticketCookie.value) {
              captured = true
              clearInterval(checkInterval)
              const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
              saveStoredAuth({
                ticket: ticketCookie.value,
                cookie: cookieStr,
                updatedAt: new Date().toISOString(),
                loginMethod: 'browser_auto_capture',
              })
              console.log('[114-LOGIN] 成功捕获官方登录票据:', ticketCookie.value.slice(0, 10) + '...')
              await browser.close()
              activeLoginBrowser = null
            }
          } catch (e) {
            clearInterval(checkInterval)
          }
        }, 1500)

        setTimeout(async () => {
          clearInterval(checkInterval)
          if (activeLoginBrowser) {
            try { await activeLoginBrowser.close() } catch {}
            activeLoginBrowser = null
          }
        }, 180000)

        sendJson(res, 200, {
          ok: true,
          status: 'launched',
          message: '已在您的屏幕上唤起 114 官方登录窗口，完成微信扫码或短信登录后，窗口将自动关闭并保存凭据。',
        })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
      return
    }

    // 7d. POST /api/guahao/114/close-login
    if (pathname === '/api/guahao/114/close-login') {
      try {
        if (activeLoginBrowser) {
          await activeLoginBrowser.close()
          activeLoginBrowser = null
        }
        sendJson(res, 200, { ok: true, message: '登录窗口已关闭' })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
      return
    }

    // 8. POST /api/brief/bundle (问诊病历资料一键打包 MedData 标准交换包)
    if (pathname === '/api/brief/bundle') {
      try {
        const patient = payload.patient || {}
        const chiefComplaint = payload.chiefComplaint || ''
        const presentIllness = payload.presentIllness || ''
        const diagnosis = patient.diagnosis || payload.diagnosis || '急性B淋巴细胞白血病 (B-ALL)'
        const stage = patient.stage || payload.stage || '微小残留病(MRD)监测阶段'

        // 构造 MedData 规范的 state 结构
        const stateToBundle = {
          patientMeta: {
            // 不写死任何真实就诊人：由前端表单提供，缺就留空（旧版默认值把真实姓名/身份证/手机号打进每个包，隐私隐患）
            name: patient.name || '',
            idCard: patient.idCard || '',
            phone: patient.phone || '',
            diagnosis,
            stage,
            hospital: patient.hospital || '北京朝阳医院',
            // 不写死临床默认值：既往史与基因型必须由表单提供。旧默认值等于给每个导出包塞
            // 无来源的「2024-03 起病 / IKZF1缺失 / CD19+ / CD22+」，医生看了会当事实（代诊-报告指出）
            onset: patient.onset || '',
            genes: Array.isArray(patient.genes) ? patient.genes : [],
          },
          docs: [
            {
              id: 'doc_outpatient_brief_001',
              title: '门诊问诊病历与代诊诉求小结',
              kind: 'outpatient',
              date: new Date().toISOString().slice(0, 10),
              chiefComplaint,
              presentIllness,
              diagnosis,
              hospital: patient.hospital || '北京朝阳医院',
            },
            ...(Array.isArray(payload.docs) ? payload.docs : []),
          ],
          records: Array.isArray(payload.records) ? payload.records : [],
          diseaseMetrics: Array.isArray(payload.diseaseMetrics) ? payload.diseaseMetrics : [],
          courses: Array.isArray(payload.courses) ? payload.courses : [],
          invoices: Array.isArray(payload.invoices) ? payload.invoices : [],
        }

        const bundle = buildMedDataBundle(stateToBundle, {
          exportedBy: 'MedBrief-Standalone/1.0.0',
          today: new Date().toISOString().slice(0, 10),
        })

        // 自验还原：parseMedDataBundle 返回 state 对象，抛出异常表示失败
        const parsedCheck = parseMedDataBundle(bundle) // 若校验失败会 throw
        if (!parsedCheck || typeof parsedCheck !== 'object') {
          throw new Error('生成的交换包自检失败：解析返回为空')
        }

        sendJson(res, 200, {
          ok: true,
          bundle,
          sha256: bundle.manifest.fingerprint,
          schemaVersion: bundle.manifest.schemaVersion,
          format: bundle.manifest.format,
          typingSummary: bundle.manifest.typingSummary,
          filename: `MedData-${stateToBundle.patientMeta.name}-${new Date().toISOString().slice(0, 10)}.meddata`,
        })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
      return
    }

    // 8c. POST /api/brief/import — 导入 .meddata 交换包（通道 2 的降级路径）
    // 解析放在服务端：lib/meddataBundle.js 是 ESM，index.html 是 classic script，
    // 前端不重复实现一份解析器（避免两份实现漂移）。
    if (pathname === '/api/brief/import') {
      try {
        const input = payload.bundle ?? payload.content ?? payload
        if (!input) throw new Error('缺少 bundle 或 content 字段')
        const state = parseMedDataBundle(input) // 指纹不匹配会 throw
        lastImportedState = state // 缓存：供 GET /api/brief/visit-summary?source=import 复用
        const summary = summarizeState(state)
        const patientMeta = state.patient_meta || {}
        sendJson(res, 200, {
          ok: true,
          source: 'bundle',
          sha256: state._manifest?.fingerprint || null,
          schemaVersion: state._manifest?.schemaVersion || null,
          exportedAt: state._manifest?.exportedAt || null,
          patient: {
            name: patientMeta.name || '',
            diagnosis: patientMeta.diagnosis || '',
            age: patientMeta.age ?? null,
            gender: patientMeta.gender ?? null,
          },
          counts: {
            ...summary.counts,
            events: (state.events || []).length,
            courses: (state.courses || []).length,
          },
          latest: summary.latest,
          aliases: summary.aliases,
          text: formatSummaryText(summary),
        })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `交换包校验失败：${e.message}` })
      }
      return
    }
  }

  // 8b. 旧 React 挂号页 /guahao 已合并进主页面（新壳 /），只保留重定向，避免两套 UI 并存
  if (req.method === 'GET' && (pathname === '/guahao' || pathname === '/guahao/' || pathname === '/next' || pathname === '/next/')) {
    res.statusCode = 302
    res.setHeader('Location', '/?merged=guahao')
    res.end()
    return
  }

  // 10. 报告导入（问诊资料卡的取数层）：拼接 / 解析 / OCR / 入库
  //     数据只来自用户导入；不读 MedData 任何库（MedData 只当 OCR 引擎）。
  if (req.method === 'GET' && pathname === '/api/intake/reports') {
    const store = readReports()
    sendJson(res, 200, {
      ok: true,
      total: store.reports.length,
      reports: store.reports.map((r) => ({ ...r, images: undefined, text: undefined, hasImage: !!r.sha256 })),
    })
    return
  }

  // 10a. 病友档案（资料卡的抬头）：只收非身份字段，身份类一律不收
  if (req.method === 'GET' && pathname === '/api/intake/patient') {
    sendJson(res, 200, { ok: true, patient: loadPatient() })
    return
  }

  if (req.method === 'POST' && pathname === '/api/intake/patient') {
    const body = await readJsonBody(req)
    try {
      const patient = savePatient(body || {})
      // savePatient 内部已 delete idCard/phone/address；这里回执明确告知，避免前端以为存进去了
      sendJson(res, 200, { ok: true, patient, notStored: ['idCard', 'phone', 'address'] })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `保存档案失败：${e.message}` })
    }
    return
  }

  // 10b. 问诊资料卡：把已导入的报告渲染成 A4 一页（mask=0 关闭姓名脱敏，默认脱敏）
  if (req.method === 'GET' && pathname === '/api/intake/card') {
    try {
      // 2026-11-13 用户口径：默认不脱敏（给医生看），显式 mask=1 才脱敏
      const mask = parsedUrl.searchParams.get('mask') === '1'
      const { reports } = readReports()
      const card = buildCard({ reports, mask })
      sendJson(res, 200, card) // { ok, masked, patient, counts, summary, groups, html }
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `生成资料卡失败：${e.message}` })
    }
    return
  }

  if (pathname === '/api/intake/stitch' && req.method === 'POST') {
    const body = await readJsonBody(req)
    try {
      const imgs = Array.isArray(body.images) ? body.images : []
      if (!imgs.length) return sendJson(res, 400, { ok: false, error: 'images 不能为空' })
      const r = await stitchVertically(imgs)
      sendJson(res, 200, { ok: true, ...r })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `拼接失败：${e.message}` })
    }
    return
  }

  // 10d. 报告原件 Blob（表结构照 MedData blobs；以后升级识别模型可直接取回原件重跑识别）
  if (pathname === '/api/intake/blob' && req.method === 'POST') {
    const body = await readJsonBody(req)
    try {
      const raw = String(body.dataUrl || body.base64 || '')
      if (!raw) return sendJson(res, 400, { ok: false, error: 'dataUrl/base64 不能为空' })
      const m = raw.match(/^data:([^;]+);base64,([\s\S]*)$/)
      const mime = m ? m[1] : String(body.mime || 'application/octet-stream')
      const buf = Buffer.from(m ? m[2] : raw, 'base64')
      if (!buf.length) return sendJson(res, 400, { ok: false, error: '解码后为空' })
      const saved = saveBlob(buf, { kind: body.kind || 'original', type: mime, originPath: body.originPath || '', width: body.width || null, height: body.height || null })
      sendJson(res, 200, { ok: true, ...saved })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `存原件失败：${e.message}` })
    }
    return
  }

  if (pathname === '/api/intake/blobs' && req.method === 'GET') {
    try {
      sendJson(res, 200, { ok: true, storage: blobStats(), blobs: listBlobs() })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  if (pathname.startsWith('/api/intake/blob/') && req.method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/api/intake/blob/'.length))
    const row = getBlob(id)
    if (!row) return sendJson(res, 404, { ok: false, error: 'blob 不存在' })
    res.writeHead(200, { 'content-type': row.type || 'application/octet-stream', 'content-length': row.data.length, 'cache-control': 'no-store' })
    res.end(row.data)
    return
  }

  if (pathname === '/api/intake/parse' && req.method === 'POST') {
    const body = await readJsonBody(req)
    try {
      const rows = parseLabRows(body.text || '')
      const groups = groupForDoctorCard(rows)
      sendJson(res, 200, { ok: true, rows, groups, summary: summarizeForCard(groups) })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  if (pathname === '/api/intake/ocr' && req.method === 'POST') {
    const body = await readJsonBody(req)
    try {
      const image = String(body.image || '')
      const pdfData = String(body.pdf || '')
      if (!image.startsWith('data:image/') && !(pdfData && /^data:application\/pdf/.test(pdfData))) {
        return sendJson(res, 400, { ok: false, error: 'image 需要 data:image/*;base64,，pdf 需要 data:application/pdf;base64,' })
      }

      // 单次 OCR（一块图 → 文本 + 行）
      const ocrOnce = async (dataUrl) => {
        const id = `intake-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
        const r = await fetch('http://127.0.0.1:8008/api/ocr-vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, image: dataUrl }),
          signal: AbortSignal.timeout(90000),
        })
        const j = await r.json().catch(() => ({}))
        const blocks = Array.isArray(j.blocks) ? j.blocks : []
        const hasBoxes = blocks.some((b) => b && b.boundingBox)
        const layoutLines = hasBoxes ? blocksToLines(blocks) : []
        const text = layoutLines.length
          ? layoutLines.join('\n')
          : (j.text || j.result || blocks.map((b) => b.text || '').join('\n'))
        return { text, layoutLines, rows: parseLabRows(text), layout: hasBoxes ? 'reconstructed' : 'raw-text', upstream: j.ok === false ? j.error : undefined }
      }

      // 图像链（图片与「扫描版 PDF 的每一页」共用）：
      //   deskew → cropToContent → planChunks → 逐块 OCR → 合并（mergeChunkRows）
      const runImagePipeline = async (srcImage, { stitched = false } = {}) => {
        const skew = await autoDeskew(srcImage)
        const workImage = skew.applied && skew.image ? skew.image : srcImage

        // 顺序铁律：deskew → cropToContent → planChunks。deskew 旋转会补白边把宽度撑大（内容没变宽），
        // 不先归一到墨迹 bbox，planChunks 会拿「回正后」的尺寸把超重图误判成不超高
        // （实测 2223×6490 h/w 2.92 → 回正后 2448×6564 h/w 2.68 → 判不切 → 48 行只出 43 行）。
        const crop = await cropToContent(workImage).catch(() => null)
        const sizedImage = crop && crop.cropped && crop.image ? crop.image : workImage

        let dim = null
        try { dim = await imageSize(sizedImage) } catch { dim = null }
        const plan = planChunks(dim || {}, {})
        let parts = [sizedImage]
        if (plan.chunked) {
          const sliced = await cropChunks(sizedImage, plan.chunks)
          parts = sliced.parts
        }

        // 块间并行（2026-11-12 实测：8008 可并发，12 路并行时单份延迟 1.7s、吞吐仍线性上升；
        // 超高图 h/w 3.06 切 2 块时，串行 1.83s → 并行 1.09–1.29s）。Promise.all 保序，合并逻辑不受影响。
        const results = await Promise.all(parts.map((part) => ocrOnce(part)))

        const text = results.map((r) => r.text).filter(Boolean).join('\n')
        const layoutLines = results.flatMap((r) => r.layoutLines)
        const rawRows = results.flatMap((r) => r.rows)
        const chunkMerge = plan.chunked ? mergeChunkRows(rawRows) : { rows: rawRows, merged: 0, conflicts: 0 }
        const wantsDedupe = stitched === true || body.stitched === true || Number(body.stitchedFrom) > 1
        const stitchedDedupe = wantsDedupe ? dedupeStitchRows(chunkMerge.rows) : { rows: chunkMerge.rows, merged: 0 }

        return {
          text,
          lines: layoutLines,
          rows: stitchedDedupe.rows,
          rawRowCount: rawRows.length,
          chunked: plan.chunked,
          chunks: parts.length,
          chunksPlanned: plan.planned,
          chunkHeights: plan.chunks.map((c) => c.h),
          chunkAspect: Number(plan.aspect.toFixed(2)),
          chunkMerged: chunkMerge.merged || 0,
          chunkValueConflicts: chunkMerge.conflicts || 0,
          stitchedDeduped: stitchedDedupe.merged || 0,
          cropped: !!(crop && crop.cropped),
          cropBox: crop && crop.cropped ? crop.box : null,
          contentWidth: dim ? dim.width : null,
          contentHeight: dim ? dim.height : null,
          deskewAngle: skew.angle,
          deskewed: skew.applied,
          deskewMs: skew.ms,
          deskewConfidence: skew.confidence,
          layout: results[0]?.layout || 'raw-text',
          upstream: results.find((r) => r.upstream)?.upstream,
        }
      }

      // ---------- PDF：先认文字层，没有文字层才栅格化 ----------
      if (pdfData) {
        const parsed = await readPdf(pdfData, { rasterDpi: Number(body.rasterDpi) || 200 })
        const pageTexts = parsed.pages.map((p) => p.text || '')
        const allText = pageTexts.join('\n')
        const textMode = allText.replace(/\s/g, '').length >= 40

        if (textMode) {
          // 有文字层：直接抽文本解析（快、准；报告类 PDF 可能出 0 行指标，那属正常 —— 它会以文本形式入库）
          const rows = parseLabRows(allText)
          return sendJson(res, 200, {
            ok: true,
            kind: 'pdf',
            pdfMode: 'text',
            pages: parsed.pageCount,
            pageTexts,
            text: allText,
            rows,
            rawRowCount: rows.length,
            reportDate: guessReportDate(allText),
            layout: 'pdf-text',
            chunked: false,
            chunks: pageTexts.length,
            deskewed: false,
            deskewAngle: 0,
            engine: 'pdf-text(pymupdf)',
          })
        }

        // 扫描版 PDF：逐页栅格化后走图像链（每页独立 deskew/切块），再把各页行拼起来
        const raster = await readPdf(pdfData, { rasterDpi: Number(body.rasterDpi) || 200, wantPng: true })
        const rowsAll = []
        const rasterTexts = []
        let rawTotal = 0
        let anyChunked = false
        for (const page of raster.pages) {
          const one = await runImagePipeline(`data:image/png;base64,${page.png}`)
          rowsAll.push(...one.rows)
          rasterTexts.push(one.text)
          rawTotal += one.rawRowCount
          anyChunked = anyChunked || one.chunked
        }
        return sendJson(res, 200, {
          ok: true,
          kind: 'pdf',
          pdfMode: 'raster',
          pages: raster.pageCount,
          pageTexts: rasterTexts,
          text: rasterTexts.filter(Boolean).join('\n'),
          rows: rowsAll,
          rawRowCount: rawTotal,
          reportDate: guessReportDate(rasterTexts.join('\n')),
          layout: 'reconstructed',
          chunked: anyChunked,
          chunks: raster.pages.length,
          deskewed: false,
          deskewAngle: 0,
          engine: 'pdf-raster(pymupdf)→8008/ocr-vision',
        })
      }

      // ---------- 图片 ----------
      const out = await runImagePipeline(image)
      sendJson(res, 200, { ok: !!out.text, kind: 'image', engine: '8008/ocr-vision', ...out })
    } catch (e) {
      sendJson(res, 200, { ok: false, unavailable: true, reason: e.message, fallback: 'paste-text' })
    }
    return
  }

  if (pathname === '/api/intake/reports' && req.method === 'POST') {
    const body = await readJsonBody(req)
    try {
      const store = readReports()
      const image = String(body.image || '')
      const meta = body.meta || {}
      // 全文型（结论/病理）报告 rows 为空是设计结果：绝不回退 parseLabRows(text)，
      // 否则「检测结果(ISCN 2024)」这类版式表头会被重新解析成假指标（2026-11-12 实测）。
      // 其它路径（网页纯文本导入、rows 被用户清空）保留原有回退语义，不改既有行为。
      const parsedRows = meta.textOnly === true
        ? (Array.isArray(body.rows) ? body.rows : [])
        : (Array.isArray(body.rows) && body.rows.length ? body.rows : parseLabRows(body.text || ''))
      // 每条 row 都落日期：资料卡的「趋势段」按 row.measuredAt 取时间，缺失就退回 row.reportDate；
      // 两者都空则趋势段直接少行（不是空表就是静默丢数据）。故入库时统一用 meta.reportDate 兜底打戳。
      const reportDate = String(meta.reportDate || '')
      const rows = parsedRows.map((r) => ({
        ...r,
        reportDate: r.reportDate || reportDate,
        measuredAt: r.measuredAt || r.reportDate || reportDate,
      }))
      const imageBuf = image ? Buffer.from(image.replace(/^data:image\/[a-z+]+;base64,/i, ''), 'base64') : null
      const sha256 = imageBuf ? sha256Bytes(imageBuf) : ''
      const dhash = String(body.dhash || '')
      const fingerprint = buildReportFingerprint(rows, meta)
      // force=true：用户已在弹窗里确认「仍要导入」——跳过去重判定，但仍计算并保存指纹，
      // 否则这条记录永久不受查重覆盖（旧的前端兜底是「不带 image 重发」，那是查重盲区）
      const force = body.force === true
      if (!force) {
        const dup = findDuplicate({ sha256, dhash, reportDate: String(meta.reportDate || ''), barcode: String(meta.barcode || '') }, store.reports)
        if (dup.dup) return sendJson(res, 200, { ok: false, duplicate: dup, hint: '这张图已导入过' })
        const sameContent = store.reports.find((r) => r.fingerprint === fingerprint)
        if (sameContent) return sendJson(res, 200, { ok: false, duplicate: { dup: true, kind: 'content', of: sameContent.id }, hint: '同一份报告（内容一致）' })
      }
      // 报告级字段对齐 MedData 的 record 模型（records[] = { date, report_type, notes, data_points }）：
      //   reportDate→date、reportType→report_type、rows→data_points。
      // 其余为「单据抬头」事实字段，一律照抄原报告，读不到就空串（不填默认值）。
      const rec = {
        id: `rep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        createdAt: new Date().toISOString(),
        // 来源标记：没有原图的记录（纯文本录入/测试）必须可识别 ——
        // 2026-11-12 出过一条无 sha256/dhash/imageRef、只有一行手打文本的记录（rep_mwddww4ooys），
        // 混在真实报告里让人误以为是导入的化验单。无原图 = 无法核对、无法查重，只能当草稿。
        source: imageBuf ? 'image' : 'text-only',
        sha256, dhash, fingerprint,
        kind: meta.kind || 'lab',
        reportType: meta.reportType || '',
        reportDate: meta.reportDate || '',
        hospital: meta.hospital || '',
        labName: meta.labName || '',
        barcode: meta.barcode || '',
        sampledAt: meta.sampledAt || '',
        receivedAt: meta.receivedAt || '',
        clinicalDiagnosis: meta.clinicalDiagnosis || '',
        patientName: meta.patientName || '',
        sourceFile: meta.sourceFile || '',
        imageRef: imageBuf ? `sha256:${sha256}` : '',
        // 原件引用：blobs 表 id 列表（[{blobId, role}]）。role: original=原图/原件，stitched=跨屏拼接图
        sourceBlobs: Array.isArray(body.sourceBlobs) ? body.sourceBlobs : (Array.isArray(meta.sourceBlobs) ? meta.sourceBlobs : []),
        text: String(body.text || ''),
        rows,
      }
      store.reports.push(rec)
      writeReports(store)
      // 回填「原件 → 报告」关联，便于按报告取回原件重新识别
      for (const b of rec.sourceBlobs) {
        if (b && b.blobId) { try { linkBlobToReport(b.blobId, rec.id) } catch { /* 关联失败不影响入库 */ } }
      }
      sendJson(res, 200, { ok: true, report: rec, total: store.reports.length })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // 8.5 MedData 页面独立挂载：/meddata 静态页、/tesseract 与 /traineddata 识别资源、
  //     /api/data/* 本地镜像、MedData 页面用到的 /api/* 识别端点转 8008。
  //     MedBrief 自有端点全部在上面优先处理；本模块不写 MedData 任何库（见 meddata/mount.mjs）。
  if (await mountMedData(req, res, pathname, parsedUrl)) return

  // 9. 静态与页面托管
  //    /        → 新 React 壳（web/dist-next，构建：MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web）
  //    /legacy  → 旧单文件工作台 index.html（新壳未覆盖的能力临时兜底，迁完即删）
  if (req.method === 'GET' || req.method === 'HEAD') {
    const distDir = path.join(__dirname, 'web', 'dist-next')
    const legacyHtml = path.join(__dirname, 'index.html')
    const rel = pathname === '/' ? '' : decodeURIComponent(pathname).replace(/^\//, '')

    // 9a. 新壳的静态资源（/assets/*.js 等）必须先命中，否则会误落到 SPA 回退返回 HTML
    if (rel && !rel.startsWith('..')) {
      const assetPath = path.join(distDir, rel)
      if (assetPath.startsWith(distDir) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
        serveStatic(req, res, assetPath)
        return
      }
    }

    // 9b. 旧工作台兜底入口
    if (pathname === '/legacy' || pathname.startsWith('/legacy/')) {
      if (fs.existsSync(legacyHtml)) {
        serveStatic(req, res, legacyHtml)
        return
      }
    }

    // 9c. 项目内其它真实静态文件（如 docs 里的图片）
    if (rel && !rel.startsWith('..')) {
      const filePath = path.join(__dirname, rel)
      if (filePath.startsWith(__dirname) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        serveStatic(req, res, filePath)
        return
      }
    }

    // 9d. 新壳首页与 SPA 回退
    const spaIndex = path.join(distDir, 'index.html')
    if (fs.existsSync(spaIndex)) {
      serveStatic(req, res, spaIndex)
      return
    }

    // 9e. 新壳未构建：退回旧工作台，服务不至于打不开
    if (fs.existsSync(legacyHtml)) {
      serveStatic(req, res, legacyHtml)
      return
    }
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[MedBrief] 服务已在独立端口 ${PORT} 启动: http://127.0.0.1:${PORT}`)
})

export default server
