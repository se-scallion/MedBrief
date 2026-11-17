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
import { createHash } from 'node:crypto'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createGuahaoManager } from './lib/guahaoCore.js'
import { buildMedDataBundle, parseMedDataBundle } from './lib/meddataBundle.js'
import { blocksToLines } from './lib/visionLayout.mjs'
import { normalizeRow, looksColumnShifted } from './lib/labClean.mjs'
import { classifyAnalyte } from './lib/reportIntake.mjs'
import {
  sha256Bytes, findDuplicate, stitchVertically,
  parseLabRows, buildReportFingerprint, groupForDoctorCard, summarizeForCard, dedupeStitchRows, mergeChunkRows,
} from './lib/reportIntake.mjs'
import { loadPatient, savePatient, loadPatientFor, savePatientFor, buildCard } from './lib/intakeCard.js'
import { saveBlob, saveBlobIfAbsent, getBlob, listBlobs, linkBlobToReport, deleteBlob, blobStats } from './lib/blobStore.mjs'
import { appendCorrections, listCorrections, correctionsStats } from './lib/correctionsStore.mjs'
import { readStore, writeStore } from './lib/reportStore.mjs'
import { planChunks, cropChunks, imageSize, cropToContent } from './lib/imageChunker.mjs'
import { autoDeskew } from './lib/deskew.mjs'
import { readPdf, guessReportDate } from './lib/pdfIntake.mjs'
import { classifyReport } from './lib/reportClassify.mjs'
import { rowsForType } from './lib/reportIntake.mjs'
import { buildSignatureIndex, suggestBySignature, nameLooksUnusable } from './lib/analyteSignature.mjs'
import { guessMeta } from './lib/reportMeta.mjs'
import { detectReportType, buildTypeRowIndex } from './lib/reportTypeDetect.mjs'
import { summarizeState, formatSummaryText } from './lib/metricsSummary.js'
import { buildVisitBrief } from './lib/visitBrief.js'
import { fetchLiveDoctorSchedule } from './lib/bjcyhScraper.js'
// M2a 切流：MEDREC_BACKEND=8011 时走统一识别服务；=legacy（默认）时本模块不参与，行为零变化
import { isService as medrecOn, extractImage as medrecExtractImage, extractText as medrecExtractText, ocrImage as medrecOcrImage, backend as medrecBackend } from './medrec-adapter.mjs'
// M3 观测件：只记一次命中，不改响应、不降级、不重试
import { bump as bumpRecognitionHit, summary as recognitionSummary } from './lib/recognitionHits.mjs'
import { createGuahao114Service } from './lib/guahao114Service.js'
import { mountMedData } from './meddata/mount.mjs'
import * as accounts from './lib/accounts.mjs'
import * as authn from './lib/auth.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 会话密钥：优先环境变量；否则读本地 .mb-secret（600，gitignore，绝不落 data/）
if (!process.env.MB_SESSION_SECRET) {
  try {
    const sf = path.join(__dirname, '.mb-secret')
    if (fs.existsSync(sf)) {
      for (const line of fs.readFileSync(sf, 'utf8').split('\n')) {
        const m = line.match(/^\s*MB_SESSION_SECRET\s*=\s*(.+?)\s*$/)
        if (m) { process.env.MB_SESSION_SECRET = m[1]; break }
      }
    }
  } catch {}
}
// 会话依赖启动自检（q1 Q1-G5：缺 SESSION_SECRET → 立即退出，不静默降级）
try {
  const raw = String(process.env.MB_SESSION_SECRET || '')
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.length || list.some((s) => s.length < 32)) throw new Error('MB_SESSION_SECRET 必须设置且每段 ≥32 字符')
} catch (e) {
  console.error(`[MedBrief] 会话依赖不可用：${e.message}`)
  process.exit(1)
}
accounts.cleanupOldAttempts(7)

const PORT = parseInt(process.env.PORT || '5174', 10)
// 生产只允许绑 loopback（反代与 Node 同宿主机，反代打 127.0.0.1:5174）。
// 默认保持 0.0.0.0 以免破坏本地开发；生产由 systemd 注入 MEDBRIEF_BIND=127.0.0.1（D0-5②，v0.5a）
const BIND = process.env.MEDBRIEF_BIND || '0.0.0.0'
// 进程启动信息：用于判断「长驻进程是否落后于代码」（配合 /api/health.head 比对 git HEAD）
const SERVER_STARTED_AT = new Date().toISOString()
const SERVER_GIT = (() => {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim()
    // 启动时工作树是否干净：head 只是「启动那一刻的提交」，若当时工作树有未提交改动，
    // head 会落后于实际加载的代码（2026-11-12 实测踩到：行为已是新版，head 却显示旧提交）。
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: __dirname, encoding: 'utf8' }).trim()
    const dirtyCount = dirty ? dirty.split('\n').filter(Boolean).length : 0
    return { head, source: 'git', dirty: dirtyCount > 0, dirtyCount }
  } catch {
    // 服务器不带 .git（投递不含）：回退到构建机注入的 MEDBRIEF_COMMIT。
    // 注意：env 可被伪造，所以 source 必须如实回显，禁止把它当唯一真相（r5 P1-1）。
    const envHead = String(process.env.MEDBRIEF_COMMIT || '').trim()
    return { head: envHead || 'unknown', source: envHead ? 'env' : 'none', dirty: null, dirtyCount: null }
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

// 挂号浏览器总开关（2026-11-15 用户要求：「挂号监控设置个开关，现在用不上，别一直打开了」）。
// 关掉后不再拉起 ego-browser / Playwright / Chrome 窗口：挂号监控 realtime、114 会话检查、
// 114 目录抓取、114 挂号流程、launch-login 全部直接返回 disabled。
// 开法：环境变量 GUAHO_BROWSER=on/1，或 data/guahao-browser.flag 内容不是 off/0；二者都缺省时视为开（老行为）。
const GUAHO_BROWSER_FLAG = path.join(DATA_DIR, 'guahao-browser.flag')
function guahaoBrowserOn() {
  const env = (process.env.GUAHO_BROWSER || '').trim().toLowerCase()
  if (env === 'on' || env === '1') return true
  if (env === 'off' || env === '0') return false
  try {
    const flag = fs.readFileSync(GUAHO_BROWSER_FLAG, 'utf8').trim().toLowerCase()
    return flag !== 'off' && flag !== '0'
  } catch {
    return true
  }
}
const GUAHO_BROWSER_DISABLED = { code: 'BROWSER_DISABLED', error: '挂号浏览器已关（GUAHO_BROWSER=off / data/guahao-browser.flag=off），要用时先打开开关' }

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

function setCors(_req, res) {
  // 带 cookie 的会话不能用 `*`；回显同源 Origin（无 Origin 头时不设，同源浏览器请求不需要）
  const req = _req || res.__mbReq
  const origin = req?.headers?.origin
  const host = req?.headers?.host
  if (origin && host) {
    try {
      const u = new URL(origin)
      if (u.host === host) res.setHeader('Access-Control-Allow-Origin', origin)
    } catch {}
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
}

function sendJson(res, statusCode, data) {
  setCors(null, res)
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
    // 2026-11-17：pdf.js worker 是 .mjs 且用动态 import 加载；octet-stream 会被浏览器拒绝执行
    // （"Failed to fetch dynamically imported module"）⇒ PDF 原件预览失败。必须给 JS MIME。
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.meddata': 'application/json; charset=utf-8',
  }

  const contentType = mimeMap[ext] || 'application/octet-stream'
  setCors(null, res)
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  fs.createReadStream(filePath).pipe(res)
}

// ---------- 报告库文件位置（模块级常量） ----------
// 为什么放这里而不是 request handler 里：整站路由都在下面那个 createServer 回调里，
// 回调里的 const 在 `server.listen` 回调里看不到（会直接 ReferenceError），所以路径常量必须在模块级。
// 2026-11-14 用户批准：加环境变量兜底，**只有测试进程会设它**（副本库跑删除/恢复，绝不碰真实库）。
// 默认路径与行为一个字不变；设了变量但文件不存在 → 立刻报错退出，
// 绝不「找不到就新建空库」（那会把一次路径笔误变成一次静默数据丢失）。
const REPORTS_FILE = process.env.MEDBRIEF_REPORTS_FILE || path.join(__dirname, 'data', 'reports.json')
if (process.env.MEDBRIEF_REPORTS_FILE && !fs.existsSync(REPORTS_FILE)) {
  console.error(`[MedBrief] MEDBRIEF_REPORTS_FILE 指向的文件不存在：${REPORTS_FILE}`)
  process.exit(1)
}

const server = http.createServer(async (req, res) => {
  res.__mbReq = req // setCors 从 res 反查同源判定（sendJson 只拿得到 res）
  setCors(req, res)

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = parsedUrl.pathname

  // ==================== 鉴权守卫（账号系统方案 v0.8 §1）====================
  // 放在 pathname 解析之后、OBSERVED bump / 任何业务路由之前；默认拒绝，公开路由白名单。
  const AUTH_ENABLED = process.env.MEDBRIEF_AUTH !== 'off'
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)

  // --- /api/auth/* 登录态接口（公开，自带限流）---
  if (AUTH_ENABLED && pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      // 登录守卫在 body 统一收集（下方）之前，自己读一次流
      const chunks = []
      for await (const c of req) chunks.push(c)
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {}
      req.__rawBody = Buffer.concat(chunks).toString('utf8') // 防止下游再读
      const result = await authn.login(req, body?.phone, body?.password)
      if (result.backoff > 0) await new Promise((r) => setTimeout(r, result.backoff * 1000))
      if (!result.ok) {
        res.setHeader('Retry-After', String(result.retryAfter || Math.ceil(result.backoff || 1)))
        return sendJson(res, result.status, { ok: false, error: result.error })
      }
      res.setHeader('Set-Cookie', result.cookie)
      return sendJson(res, 200, { ok: true, user: result.user })
    } catch (e) { return sendJson(res, 500, { ok: false, error: `登录失败：${e.message}` }) }
  }
  if (AUTH_ENABLED && pathname === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', authn.clearSessionCookie())
    return sendJson(res, 200, { ok: true })
  }

  // --- 公开路由：health / auth / 静态页面资源；其余 /api/** 都要登录 ---
  const PUBLIC_PATHS = (p) => p === '/api/health' || p.startsWith('/api/auth/') ||
    !p.startsWith('/api/') // 非 /api 走静态白名单（见 9c-gate），不在此处拦

  let mbUser = null // 当前登录用户（handler 里做 owner 校验时用）
  // 测试专用身份：仅 loopback + 设置了 MB_TEST_BEARER + 请求带匹配 Bearer。
  // 这是给硬编码 5174 的回归测试用的（D3 认证故事）；生产不设该变量即完全无效。
  const testBearer = process.env.MB_TEST_BEARER
  if (testBearer && isLoopback && req.headers?.authorization === `Bearer ${testBearer}`) {
    mbUser = accounts.listUsers().find((u) => u.phone === '13228372097') || null
  }
  if (AUTH_ENABLED && pathname.startsWith('/api/') && !PUBLIC_PATHS(pathname)) {
    if (!mbUser) {
      const session = await authn.readSession(req)
      mbUser = authn.currentUser(session)
    }
    if (!mbUser) return sendJson(res, 401, { ok: false, error: '请先登录' })
    // MEDBRIEF_TEST_USER：仅 loopback + 非 production 的测试注入（D3 P1-1）
    // 若设置且当前无有效会话，用该手机号的 user 作为主体（只在测试进程设）。
  }
  if (!AUTH_ENABLED && pathname.startsWith('/api/')) {
    // off 旁路：仅 loopback 允许；LAN 仍要登录
    if (!isLoopback) {
      const session = await authn.readSession(req)
      if (!authn.currentUser(session)) return sendJson(res, 401, { ok: false, error: '请先登录' })
    }
  }
  req.mbUser = mbUser // 供下游 handler 做 owner 校验

  // --- 功能权限判定（精确 > 最长前缀 > 默认拒绝；admin 全通）---
  // 只在 AUTH_ENABLED 时生效。card_export / guahao 是逐人授权位。
  if (AUTH_ENABLED && mbUser && mbUser.role !== 'admin') {
    const p = pathname
    const m = req.method
    let need = null
    // guahao：全部挂号/监控/114 会话接口
    if (p.startsWith('/api/guahao/')) need = 'guahao'
    // card_export：导出/打印/出卡/摘要/交换包读、原件
    else if (p === '/api/intake/card' ||
             p.startsWith('/api/intake/blob/') || p === '/api/brief/visit-summary' ||
             p === '/api/brief/bundle' || p === '/api/meddata/summary') need = 'card_export'
    // patient 档案：登录用户各自读写自己那份（r6-add P0-2 分桶后已隔离，不再要求 card_export）
    // admin-only：报告写以外的管理面、OCR 打爆面、病历导入
    else if (p === '/api/recognition-hits' || p === '/api/intake/parse' ||
             p === '/api/intake/ocr' || p === '/api/ai-docread' || p === '/api/intake/stitch' ||
             p === '/api/brief/import' || p === '/api/guahao/reset' ||
             (p.startsWith('/api/guahao/114/') && m === 'POST') ||
             p.startsWith('/api/admin/')) need = 'admin'
    if (need === 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })
    if (need && !authn.can(mbUser, need)) return sendJson(res, 403, { ok: false, error: '功能未授权，请联系管理员开通' })

    // owner 校验：报告详情/写路径，user 只能碰自己的；admin 豁免（守卫层提前拦，handler 不必再判）
    const rm = pathname.match(/^\/api\/intake\/reports\/([^/]+)/)
    if (rm && mbUser.role !== 'admin') {
      const reportId = decodeURIComponent(rm[1])
      if (!authn.owns(mbUser, reportId)) return sendJson(res, 403, { ok: false, error: '无权访问此报告' })
    }
    // corrections 子路由（/reports/:id/corrections）已被上面正则覆盖
  }

  // /api/auth/me（在守卫之后，能拿到 mbUser）
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    if (!AUTH_ENABLED) {
      let u = authn.currentUser(await authn.readSession(req))
      // auth=off + 本机回环：注入测试管理员身份（全权限），让前端 UI 回归测试能正常渲染。
      // LAN 请求不走这里（守卫层已要求登录）；生产不设 off 则此分支永不可达。
      if (!u && isLoopback) {
        const adm = accounts.listUsers().find((x) => x.role === 'admin')
        if (adm) u = accounts.publicUser(adm)
      }
      return sendJson(res, 200, { ok: !!u, user: u, auth: 'off', permissions: u ? { card_export: true, guahao: true, role: u.role } : null })
    }
    const u = mbUser || authn.currentUser(await authn.readSession(req))
    if (!u) return sendJson(res, 401, { ok: false, error: '请先登录' })
    return sendJson(res, 200, { ok: true, user: u, permissions: { role: u.role, card_export: !!u.card_export, guahao: !!u.guahao } })
  }

  // M3 前置观测：记录「这条识别请求走的是 legacy 还是 8011」。
  // 只 bump 一次、不进入任何判定；异常由 bump 内部吞掉，绝不影响响应。
  const OBSERVED_ROUTES = new Set(['/api/intake/ocr', '/api/intake/parse', '/api/ai-docread'])
  if (OBSERVED_ROUTES.has(pathname) && req.method === 'POST') {
    const kind = pathname === '/api/intake/parse' ? 'parse' : pathname === '/api/ai-docread' ? 'docread' : 'ocr'
    bumpRecognitionHit({ side: 'medbrief', route: pathname, backend: medrecBackend(), kind })
  }

  // 0. M3 观测汇总（只读，不改任何状态）：curl -s /api/recognition-hits?days=7
  if (req.method === 'GET' && pathname === '/api/recognition-hits') {
    const days = Math.max(1, Math.min(90, Number(parsedUrl.searchParams.get('days') || 7)))
    return sendJson(res, 200, { ok: true, ...recognitionSummary({ days }) })
  }

  // 1. GET /api/health
  //    ⚠️ 带上 head/startedAt：长驻 node 进程不热更新，改了 lib/* 忘重启会静默用旧模块
  //    （2026-11-12 真实踩到：intakeCard.js 改了但进程还是旧的，卡片脚注看不到）。
  //    判据：`curl /api/health | jq -r .head` 与 `git rev-parse --short HEAD` 不一致 = 进程落后于代码。
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      head: SERVER_HEAD,
      bind: BIND,
      commitSource: SERVER_GIT.source,
      // 判据：head ≠ git HEAD 时先看 dirty —— dirty:true 表示「启动时工作树有未提交改动」，
      // 那种情况下 head 会落后于实际加载的代码，属无害错位；dirty:false 且仍不一致才是进程真的落后。
      dirty: SERVER_GIT.dirty,
      dirtyCount: SERVER_GIT.dirtyCount,
      startedAt: SERVER_STARTED_AT,
      app: 'medbrief',
      name: 'MedBrief Standalone Workbench',
      auth: process.env.MEDBRIEF_AUTH === 'off' ? 'off' : 'on',
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
/**
 * 读报告库。v2 起多两个库级字段：
 *   - `trashed[]`：**软删除**的报告（连同原 patchLog 一起搬过来，字段一个不改，可原样恢复）
 *   - `audit[]`：彻底删除的记录（报告本体已不在了，只剩这条审计，可回查谁删的、删前长什么样）
 * 旧文件（无这两个字段）照读，默认空数组 —— 不迁移、不改写历史数据。
 */
function readReports() {
  // v2 阶段 1.1：解析失败/坏文件一律抛错，绝不静默返回空库（否则下一次写入会覆盖真实数据）。
  // 唯一允许空库的情况是「文件本来就不存在」，由 reportStore 内部处理。
  const { version, reports, trashed, audit } = readStore(REPORTS_FILE)
  return { reports, trashed, audit, version }
}

// 报告原件反查（2026-11-13 v3 第 1 步）：
// 原件字节早在 SQLite blobs 表里、且每条都写了 report_id（实测 54/54 份全覆盖），
// 所以**不需要**向 data/reports.json 回写 fileBlobId（那是就地改真实医疗数据）；
// 读侧按 report_id 反查即可，历史报告立刻也能点开原件。
// 同一份报告可能有多条 blob（原图 + 转出的 PDF）：优先 image/*（原图），其次 PDF。
function attachBlobIds(reports = []) {
  let blobs = []
  try { blobs = listBlobs() } catch { blobs = [] }
  const byReport = new Map()
  for (const b of blobs) {
    if (!b.report_id) continue
    const cur = byReport.get(b.report_id)
    const isImg = String(b.type || '').startsWith('image/')
    const curImg = cur ? String(cur.type || '').startsWith('image/') : false
    if (!cur || (isImg && !curImg)) byReport.set(b.report_id, b)
  }
  return reports.map((r) => {
    const b = byReport.get(r.id)
    return { ...r, fileBlobId: r.fileBlobId || (b ? b.id : ''), hasOriginal: !!b }
  })
}
function writeReports(store) {
  // v2 阶段 1.1：tmp + fsync + rename 原子写，保 {version, reports, trashed, audit} 四字段；
  // 进程内单写者队列防并发交错。旧实现 writeFileSync 直写目标文件，崩在半途会覆盖 63 份报告。
  return writeStore(REPORTS_FILE, store)
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
    if (!guahaoBrowserOn()) {
      sendJson(res, 200, { ok: true, disabled: true, slots: [], slotCount: 0, activeCount: 0, suspendedCount: 0, countdown: getNextReleaseCountdown(), ...GUAHO_BROWSER_DISABLED })
      return
    }
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
    if (!guahaoBrowserOn()) {
      sendJson(res, 503, { ok: false, ...GUAHO_BROWSER_DISABLED })
      return
    }
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
    if (!guahaoBrowserOn()) {
      sendJson(res, 503, { ok: false, ...GUAHO_BROWSER_DISABLED })
      return
    }
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
    if (!guahaoBrowserOn()) {
      sendJson(res, 200, { ok: true, loggedIn: false, disabled: true, ...GUAHO_BROWSER_DISABLED })
      return
    }
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
      setCors(req, res)
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

  // ===== 管理员账号管理：列表（GET，body 收集块外）=====
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    // auth 关掉时账号管理整体不可用（不能因"没有登录"就默认免检）
    if (!AUTH_ENABLED) return sendJson(res, 503, { ok: false, error: '账号管理需开启认证（MEDBRIEF_AUTH=on）' })
    if (!mbUser || mbUser.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })
    try {
      sendJson(res, 200, { ok: true, users: accounts.listUsers(), audit: accounts.listAuthz(50) })
    } catch (e) { sendJson(res, 500, { ok: false, error: e.message }) }
    return
  }

  // 读取 POST/PUT 请求体（v0.6 第 4 段：PUT /reports/:id 也要读体；
  // 原本只判 POST，导致 PUT 的 readJsonBody 恒空 → 400「缺 rowsReplace」）
  let bodyBuffer = []
  if (req.method === 'POST' || req.method === 'PUT') {
    for await (const chunk of req) {
      bodyBuffer.push(chunk)
    }
    const rawBody = Buffer.concat(bodyBuffer).toString('utf8')
    // POST/PUT 体已被本分支读空；留一份给后续处理器（如 /api/intake/*）
    req.__rawBody = rawBody
    let payload = {}
    try {
      payload = rawBody ? JSON.parse(rawBody) : {}
    } catch (e) {
      sendJson(res, 400, { ok: false, error: '无效的 JSON 请求体: ' + e.message })
      return
    }

    // ===== 管理员账号管理：建号/改号/授权/停用/踢下线（POST，body 已收集）=====
    if (pathname.startsWith('/api/admin/users')) {
      // auth 关掉时账号管理整体不可用；开启时必须 admin 本人
      if (!AUTH_ENABLED) return sendJson(res, 503, { ok: false, error: '账号管理需开启认证（MEDBRIEF_AUTH=on）' })
      const admin = mbUser || (req.headers?.cookie ? authn.currentUser(await authn.readSession(req)) : null)
      if (!admin || admin.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })
      const actor = admin.id
      const action = pathname === '/api/admin/users' ? 'create' : pathname.split('/').pop()
      try {
        if (action === 'create') {
          // 建号一律 ≥8 位：不开放 allowWeak 后门（弱密码只存在于 bootstrap 的一次性历史特例）
          const u = accounts.createUser({ phone: payload.phone, password: payload.password, role: payload.role === 'admin' ? 'admin' : 'user', cardExport: !!payload.card_export, guahao: !!payload.guahao, actorUserId: actor })
          return sendJson(res, 200, { ok: true, user: u })
        }
        const target = accounts.getUserById(payload.id)
        if (!target) return sendJson(res, 404, { ok: false, error: '用户不存在' })
        if (action === 'permissions') {
          const patch = {}
          for (const k of ['card_export', 'guahao', 'role', 'disabled']) if (k in payload) patch[k] = payload[k]
          return sendJson(res, 200, { ok: true, user: accounts.setPermissions(target.id, patch, actor) })
        }
        if (action === 'phone') {
          const u = accounts.changePhone(target.id, payload.phone, actor)
          return sendJson(res, 200, { ok: true, user: u, note: '改号已使该用户全部会话失效，需重新登录' })
        }
        if (action === 'kick') {
          const u = accounts.bumpSessionVersion(target.id, 'admin_kick', actor)
          return sendJson(res, 200, { ok: true, user: u, note: '已踢下线（该用户全部设备需重新登录）' })
        }
        return sendJson(res, 404, { ok: false, error: '未知操作：' + action })
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }) }
    }

    // ===== 114 真实浏览器挂号：动作类接口 =====
    // POST /api/guahao/114/flow/start
    if (pathname === '/api/guahao/114/flow/start') {
      if (!guahaoBrowserOn()) {
        sendJson(res, 503, { ok: false, ...GUAHO_BROWSER_DISABLED })
        return
      }
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
      if (!guahaoBrowserOn()) {
        sendJson(res, 503, { ok: false, ...GUAHO_BROWSER_DISABLED })
        return
      }
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
    // 账号系统 v0.8：user 只能看自己 owner 的报告；admin 豁免。列表与回收站都过滤。
    const viewer = req.mbUser
    const ownedSet = viewer && viewer.role !== 'admin' ? new Set(accounts.listOwners().filter((o) => o.user_id === viewer.id).map((o) => o.report_id)) : null
    const visible = (arr) => ownedSet ? arr.filter((r) => ownedSet.has(r.id)) : arr
    const reportsView = visible(store.reports)
    const trashedView = visible(store.trashed)
    // ?trash=1 → 只列**回收站**里的（软删除）；默认只列活报告。两边的行形状完全一致（同一套清洗/原件反查），
    // 回收站里看到的就是「恢复后原样回来」的那一份。
    const wantTrash = parsedUrl.searchParams.get('trash') === '1'
    // ?normalized=1：返回**清洗后视图**（列左移还原 / 单位↔区间 / 名称别名 / code 补全），
    // 供报告库的编辑表单与控制台核对使用。默认仍是原始行 —— 不动存储，只换读出形态。
    const normalized = parsedUrl.searchParams.get('normalized') === '1'
    const shape = (r) => {
      if (!normalized) return r.rows
      return (r.rows || []).map((row) => {
        const n = normalizeRow(row)
        return { ...n, code: row.code || classifyAnalyte(n.name, { loose: !!n.nameDirty }).code || null }
      })
    }
    sendJson(res, 200, {
      ok: true,
      total: (wantTrash ? trashedView : reportsView).length,
      trashCount: trashedView.length,
      trash: wantTrash,
      normalized,
      reports: attachBlobIds(wantTrash ? trashedView : reportsView).map((r) => ({
        ...r, rows: shape(r), images: undefined, text: undefined,
        // hasImage 必须是**真判据**：此前写的是 `!!r.sha256`（有指纹就算有图），
        // 而 rep_mwg22hwaloc 正是 sha256 有、字节不在 —— 这个假信号让「能不能回看原件」判不出来。
        // 现在取 attachBlobIds 算出的 hasOriginal（blob 表里真有字节）。
        hasImage: !!r.hasOriginal,
        // 原件类型（前端列表用来显示「PDF / 原件」标签）：取 role=original 的第一个 blob 的 mime
        fileBlobType: (() => {
          const b = (r.sourceBlobs || []).find((x) => x.role === 'original')
          if (!b || !b.blobId) return ''
          try { const row = getBlob(b.blobId); return row ? row.type || '' : '' } catch { return '' }
        })(),
      })),
    })
    return
  }

  // 10d. 单份详情（报告库「查看」用）：列表接口为省负载把 text 剥掉了（text: undefined），
  //     全文型报告因此「在库里但界面上任何地方都读不到」。全文与逐行清洗视图只从这里取。
  if (req.method === 'GET' && /^\/api\/intake\/reports\/[^/]+$/.test(pathname)) {
    const id = decodeURIComponent(pathname.slice('/api/intake/reports/'.length))
    const store = readReports()
    const rep = store.reports.find((r) => r.id === id)
    if (!rep) return sendJson(res, 404, { ok: false, error: `报告不存在：${id}` })
    const [withBlob] = attachBlobIds([rep])
    // 逐行给**清洗后视图**（与编辑弹窗、资料卡同一口径），原始行留在 rawRows 供回查
    const viewRows = (rep.rows || []).map((row) => {
      const n = normalizeRow(row)
      return { ...n, code: row.code || classifyAnalyte(n.name, { loose: !!n.nameDirty }).code || null }
    })
    const originals = (rep.sourceBlobs || [])
      .filter((b) => b && b.blobId)
      .map((b) => {
        try { const row = getBlob(b.blobId); return row ? { blobId: b.blobId, role: b.role || 'original', type: row.type || '', size: row.size || 0 } : null } catch { return null }
      })
      .filter(Boolean)
    // 单图导入且服务端代存过原件的（没有 sourceBlobs）也要能看到原件
    const fallbackOriginal = withBlob.fileBlobId ? [{ blobId: withBlob.fileBlobId, role: 'original', type: withBlob.fileBlobType || '', size: 0 }] : []
    sendJson(res, 200, {
      ok: true,
      report: { ...withBlob, rows: undefined, text: rep.text || '', rowCount: (rep.rows || []).length },
      rows: viewRows,
      rawRows: rep.rows || [],
      originals: originals.length ? originals : fallbackOriginal,
      patchLog: rep.patchLog || [],
    })
    return
  }

  // 10s. 报告软删除 / 恢复 / 彻底删除（2026-11-14 用户新决策：报告要能删，但必须可恢复）
  //
  // 口径（Manager 2026-11-14 批准）：
  //   ① **软删除**：把报告从 `store.reports` 搬进 `store.trashed[]`，字段一个不改、原 patchLog 一起搬
  //      → 资料卡（/api/intake/card 只读 store.reports）自动不含它，lib/intakeCard.js 一行不用改。
  //   ② **恢复**：搬回 `store.reports`，位置/字段原样；不改任何业务字段。
  //   ③ **彻底删除**：**只允许对回收站里的报告**（活报告上来就 400）—— 挡掉「误点一次就永久没了」。
  //      原件字节只在「没有别的报告引用同一 sha256/blobId」时才删（库内 blob 按 sha256 复用，
  //      共享字节被删会把另一份报告的原件一起弄没 —— MedData 有过「GC 误删 33 张原图」的先例）。
  //   ④ **审计**：软删/恢复写进该报告的 patchLog；彻底删除时报告本体已不在，写进库级 `store.audit[]`。
  if (req.method === 'DELETE' && /^\/api\/intake\/reports\/[^/]+$/.test(pathname)) {
    const id = decodeURIComponent(pathname.slice('/api/intake/reports/'.length))
    const purge = parsedUrl.searchParams.get('purge') === '1'
    const store = readReports()
    const at = new Date().toISOString()
    const live = store.reports.find((r) => r.id === id)
    const dead = store.trashed.find((r) => r.id === id)

    if (!purge) {
      if (!live) return sendJson(res, 404, { ok: false, error: dead ? `已在回收站里：${id}` : `报告不存在：${id}` })
      live.patchLog = Array.isArray(live.patchLog) ? live.patchLog : []
      live.patchLog.push({ at, field: 'deleted', from: 'active', to: 'trashed', reason: '用户手动删除（可恢复）', by: 'manual' })
      live.deletedAt = at
      store.reports = store.reports.filter((r) => r.id !== id)
      store.trashed.push({ ...live, deletedBy: 'manual' })
      writeReports(store)
      return sendJson(res, 200, { ok: true, id, action: 'delete', trashCount: store.trashed.length, deletedAt: at })
    }

    // ── 彻底删除 ──
    if (live) return sendJson(res, 400, { ok: false, error: '先删除进回收站，再从回收站彻底删除' })
    if (!dead) return sendJson(res, 404, { ok: false, error: `回收站里没有这份报告：${id}` })
    // 原件字节：先算「这份报告引用了哪些 blob」，再看是否还有别的报告（活的或回收站里的）引用同一 sha256
    let blobs = []
    try { blobs = listBlobs() } catch { blobs = [] }
    const byId = new Map(blobs.map((b) => [b.id, b]))
    const refs = new Set((dead.sourceBlobs || []).map((b) => b && b.blobId).filter(Boolean))
    const linked = blobs.find((b) => b.report_id === id)
    if (linked) refs.add(linked.id)
    const others = [...store.reports, ...store.trashed.filter((r) => r.id !== id)]
    const stillReferenced = (blobId) => {
      const b = byId.get(blobId)
      const hex = b ? b.sha256 : ''
      for (const r of others) {
        if ((r.sourceBlobs || []).some((x) => x && (x.blobId === blobId || (hex && x.sha256 === hex)))) return true
        if (hex && String(r.sha256 || '') === hex) return true
      }
      return false
    }
    const deleted = []
    const kept = []
    for (const blobId of refs) {
      if (stillReferenced(blobId)) { kept.push(blobId); continue }
      try { deleteBlob(blobId); deleted.push(blobId) } catch (e) { console.error('[purge] deleteBlob 失败', blobId, e.message); kept.push(blobId) }
    }
    store.trashed = store.trashed.filter((r) => r.id !== id)
    store.audit.push({
      at,
      action: 'purge',
      reportId: id,
      by: 'manual',
      snapshot: { reportDate: dead.reportDate || '', hospital: dead.hospital || '', reportType: dead.reportType || '', kind: dead.kind || '', barcode: dead.barcode || '', rowCount: (dead.rows || []).length, deletedAt: dead.deletedAt || '' },
      blobsDeleted: deleted,
      blurbsKept: kept,
      bytesKept: kept.length > 0,
    })
    writeReports(store)
    return sendJson(res, 200, { ok: true, id, action: 'purge', bytesKept: kept.length > 0, blobsDeleted: deleted, blobsKept: kept, audit: store.audit[store.audit.length - 1] })
  }

  if (req.method === 'POST' && /^\/api\/intake\/reports\/[^/]+\/restore$/.test(pathname)) {
    const id = decodeURIComponent(pathname.slice('/api/intake/reports/'.length, -'/restore'.length))
    const store = readReports()
    const dead = store.trashed.find((r) => r.id === id)
    if (!dead) return sendJson(res, 404, { ok: false, error: store.reports.some((r) => r.id === id) ? `该报告本来就在报告库里：${id}` : `回收站里没有这份报告：${id}` })
    const at = new Date().toISOString()
    const back = { ...dead }
    delete back.deletedAt
    delete back.deletedBy
    back.patchLog = Array.isArray(back.patchLog) ? back.patchLog : []
    back.patchLog.push({ at, field: 'restored', from: 'trashed', to: 'active', reason: '用户手动恢复', by: 'manual' })
    store.trashed = store.trashed.filter((r) => r.id !== id)
    store.reports.push(back)
    writeReports(store)
    return sendJson(res, 200, { ok: true, id, action: 'restore', total: store.reports.length, trashCount: store.trashed.length })
  }

  // 10r. 已入库报告的人工纠错（2026-11-14，用户批准的最小闭环）
  //     护栏①：每次改动把旧值记进 patchLog[{at, field, from, to}]，可审计
  //     护栏②：name/value/refRange 改动后读侧重算 num/flag/code（不落库派生值，避免双份真相）；
  //             人工改过的行标 verified:true，卡面据此清掉 `?` 脏标记
  //     护栏③：**不提供删除**；白名单之外的字段一律忽略（不报错也不写）
  if (req.method === 'POST' && /^\/api\/intake\/reports\/[^/]+\/patch$/.test(pathname)) {
    const id = decodeURIComponent(pathname.slice('/api/intake/reports/'.length, -'/patch'.length))
    const body = await readJsonBody(req).catch(() => ({}))
    const store = readReports()
    const rep = store.reports.find((r) => r.id === id)
    if (!rep) return sendJson(res, 404, { ok: false, error: `报告不存在：${id}` })
    const log = Array.isArray(rep.patchLog) ? rep.patchLog : []
    const at = new Date().toISOString()
    const changed = []
    const push = (field, from, to) => { if (String(from ?? '') !== String(to ?? '')) { log.push({ at, field, from: from ?? '', to: to ?? '' }); changed.push(field) } }

    // 报告级白名单：医院/日期 + 类型（2026-11-14 扩：用户要求列表显示「对应类型」，如 超声-床旁超声 / CT-胸部）
    // kind 只能在固定枚举内（前端 KIND_OPTIONS 与 meddata/store.js 的 lab/影像分流都依赖它）
    const KIND_ENUM = ['lab', 'pathology', 'imaging', 'discharge', 'drug', 'unknown']
    // 2026-11-17 扩 barcode：单号是**查重键**（barcode+日期+类型），OCR 把单号年份读错时
    // 不修它 ⇒ 同一份单再导入会因单号不一致而漏判重复。修单号必须留审计（走本接口即自动记 patchLog）。
    for (const f of ['hospital', 'reportDate', 'reportType', 'kind', 'barcode']) {
      if (body[f] === undefined) continue
      const v = String(body[f]).trim()
      if (f === 'kind' && !KIND_ENUM.includes(v)) continue
      if (f === 'reportType' && !v) continue
      if (f === 'barcode' && !v) continue   // 单号不允许清空（清空 = 查重键残缺）
      push(f, rep[f], v); rep[f] = v
    }
    // 护栏④（2026-11-14，沙箱实证后新增）：**左移行不许半写**。
    //   存储形如 `{value:"9.8-12.1", refRange:"sec"}` 的行，真参考区间只存在于 value 里；
    //   若只提交 value，读侧还原不再触发 → 参考区间永久丢失，还会被标成 repaired:["unit-range-swap"]
    //   这种「假修复」。整行回写（name/value/unit/refRange）才是唯一干净出口。
    if (Array.isArray(body.rows)) {
      for (const patch of body.rows) {
        const i = Number(patch?.index)
        if (!Number.isInteger(i) || !Array.isArray(rep.rows) || i < 0 || i >= rep.rows.length) continue
        if (patch.value === undefined || patch.refRange !== undefined || patch.unit !== undefined) continue
        if (!looksColumnShifted(rep.rows[i])) continue
        return sendJson(res, 400, {
          ok: false,
          error: '该行是读侧修复的左移行，必须同时提交 name / unit / refRange —— 只写 value 会把参考区间永久丢掉',
          field: `rows[${i}]`,
          hint: '前端请用 web/src/pages/intake/shared.js 的 buildRowPatch() 生成整行载荷',
        })
      }
    }
    // 行级白名单：name / value / unit / refRange，按行在数组里的 index 定位（不引 rowId，保持数据形状不变）
    if (Array.isArray(body.rows)) {
      for (const patch of body.rows) {
        const i = Number(patch?.index)
        if (!Number.isInteger(i) || i < 0 || !Array.isArray(rep.rows) || i >= rep.rows.length) continue
        const row = rep.rows[i]
        let rowTouched = false
        for (const f of ['name', 'value', 'unit', 'refRange']) {
          if (patch[f] === undefined) continue
          const next = String(patch[f]).trim()
          if (String(row[f] ?? '') === next) continue   // 值没变就不记（否则「打开就保存」会污染 patchLog）
          push(`rows[${i}].${f}`, row[f], next)
          row[f] = next
          rowTouched = true
        }
        // 只有真的改过这一行，才算「人工核对过」→ 清掉脏名标记，卡面不再打 `?`
        if (rowTouched) {
          row.verified = true
          row.nameDirty = false
          changed.push(`rows[${i}].verified`)
        }
      }
    }
    if (changed.length) {
      rep.patchedAt = at
      rep.patchedFields = [...new Set([...(rep.patchedFields || []), ...changed])]
      rep.patchLog = log
      writeReports(store)
    }
    return sendJson(res, 200, { ok: true, id, changed, patchedAt: rep.patchedAt || null, patchLogCount: log.length, report: rep })
  }

  // 10o2. v0.6 第 4 段：「更新原报告」（PUT /api/intake/reports/:id）
  // 与 POST /patch 的区别：整行替换 rows + text 一起更新，**原地改、不 push 第二条**。
  // r3 A：force 重导会 push 出两份同源报告（材料清单 +1 / 同日同码两值），故不用 force。
  // r4 P0：patch 白名单原本没有 text，只换 rows 会留下「新指标行 + 旧结论」。
  // r5 P1-1：text 的 patchLog 只存 {fromLen,toLen,fromSha,toSha}，绝不复制患者原文进 reports.json。
  // r5 P1-2：rows.added/removed 快照只存 {name,value,unit} 截 40 字，严禁 rawSnippet，removed 上限 50 行。
  if (req.method === 'PUT' && /^\/api\/intake\/reports\/[^/]+$/.test(pathname)) {
    const id = decodeURIComponent(pathname.slice('/api/intake/reports/'.length))
    const body = await readJsonBody(req).catch(() => ({}))
    const store = readReports()
    const rep = store.reports.find((r) => r.id === id)
    if (!rep) return sendJson(res, 404, { ok: false, error: `报告不存在：${id}` })
    // r5：只有 rowsReplace===true 且带 fromReportId 时才接受 text；空值拒绝（清空必须留标记）
    const rowsReplace = body.rowsReplace === true
    const fromReportId = String(body.fromReportId || '')
    if (!rowsReplace || !fromReportId) return sendJson(res, 400, { ok: false, error: '更新原报告须带 rowsReplace:true + fromReportId' })
    if (fromReportId !== id) return sendJson(res, 400, { ok: false, error: 'fromReportId 与目标报告不一致' })
    if (!Array.isArray(body.rows)) return sendJson(res, 400, { ok: false, error: 'rows 必须是数组（空数组表示全文型）' })

    const log = Array.isArray(rep.patchLog) ? rep.patchLog : []
    const at = new Date().toISOString()
    const sha = (v) => createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12)
    const clip = (v) => String(v ?? '').slice(0, 40)
    const snapshot = (r) => ({ name: clip(r?.name), value: clip(r?.value), unit: clip(r?.unit) })
    const oldRows = Array.isArray(rep.rows) ? rep.rows : []
    const newRows = body.rows.filter((r) => String(r?.value ?? '').trim() !== '')  // r3 B：空值行不入库
    const dropped = body.rows.length - newRows.length

    // r4：两份行数不同时不按 index 硬对齐，用 added/removed 分条 + 被删行快照
    const n = Math.min(oldRows.length, newRows.length)
    const changedRows = []
    for (let i = 0; i < n; i++) {
      const a = snapshot(oldRows[i]); const b = snapshot(newRows[i])
      if (JSON.stringify(a) !== JSON.stringify(b)) changedRows.push({ index: i, from: a, to: b })
    }
    const added = newRows.slice(n).map(snapshot)
    const removed = oldRows.slice(n).map(snapshot).slice(0, 50)
    const textOld = String(rep.text || '')
    const textNew = body.text === undefined ? textOld : String(body.text || '')
    if (body.text !== undefined && !textNew.trim()) return sendJson(res, 400, { ok: false, error: 'text 不许清空（清空必须留标记）' })

    log.push({
      at, field: 'rowsReplace', fromReportId,
      rows: { from: oldRows.length, to: newRows.length, changed: changedRows.length,
        added: added.length, removed: removed.length, droppedEmptyValue: dropped },
      // 只留「有哪些行变了」的可审计摘要 + 被删行快照（不含原文行切片）
      addedSnapshot: added.slice(0, 50), removedSnapshot: removed,
      // r5 P1-1：text 只存长度 + sha，绝不 from/to 原文
      text: body.text === undefined ? null : { fromLen: textOld.length, toLen: textNew.length, fromSha: sha(textOld), toSha: sha(textNew) },
    })
    rep.rows = newRows
    if (body.text !== undefined) rep.text = textNew
    if (body.meta?.reportDate !== undefined) rep.reportDate = String(body.meta.reportDate)
    if (body.meta?.reportType !== undefined) rep.reportType = String(body.meta.reportType)
    rep.patchedAt = at
    rep.patchedFields = [...new Set([...(rep.patchedFields || []), 'rowsReplace', ...(body.text !== undefined ? ['text'] : [])])]
    rep.patchLog = log
    writeReports(store)   // lib/reportStore.mjs 原子写，保 {version,reports,trashed,audit}
    return sendJson(res, 200, { ok: true, id, changed: ['rowsReplace', ...(body.text !== undefined ? ['text'] : [])],
      rows: newRows.length, droppedEmptyValue: dropped, added: added.length, removed: removed.length,
      patchLogCount: log.length, report: rep })
  }

  // 10p. 报告编辑「操作记录」（2026-11-15 用户口径：记录操作用于优化反馈；Manager 审核放行 D1）
  //     与 patch 的分工必须分清（方案 .agents/plan-reportgrid-1115.md R6/F2）：
  //       · POST /patch  → 改库，字段级 from/to 进 patchLog（**唯一真相**）
  //       · POST /corrections → **只追加**「用户怎么操作的」序列，绝不改报告、绝不回灌
  //     为什么需要它：只存 diff 区分不了「OCR 认错（真值信号）」与「用户手滑（噪声）」，op 序列才能区分。
  if (req.method === 'POST' && /^\/api\/intake\/reports\/[^/]+\/corrections$/.test(pathname)) {
    const id = decodeURIComponent(pathname.slice('/api/intake/reports/'.length, -'/corrections'.length))
    const body = await readJsonBody(req).catch(() => ({}))
    const store = readReports()
    const exists = store.reports.some((r) => r.id === id) || store.trashed.some((r) => r.id === id)
    if (!exists) return sendJson(res, 404, { ok: false, error: `报告不存在：${id}` })
    const ops = Array.isArray(body.ops) ? body.ops : []
    if (!ops.length) return sendJson(res, 400, { ok: false, error: 'ops 不能为空（没有操作就不该上报）' })
    try {
      const r = appendCorrections(ops, { reportId: id, sessionId: body.sessionId || '' })
      sendJson(res, 200, { ok: true, id, ...r, stats: correctionsStats() })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `存操作记录失败：${e.message}` })
    }
    return
  }

  if (req.method === 'GET' && /^\/api\/intake\/reports\/[^/]+\/corrections$/.test(pathname)) {
    const id = decodeURIComponent(pathname.slice('/api/intake/reports/'.length, -'/corrections'.length))
    try {
      const items = listCorrections({ reportId: id, sessionId: parsedUrl.searchParams.get('session') || '', limit: parsedUrl.searchParams.get('limit') || 500 })
      sendJson(res, 200, { ok: true, id, total: items.length, items })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
    return
  }

  // 10a. 病友档案（资料卡的抬头）：只收非身份字段，身份类一律不收
  if (req.method === 'GET' && pathname === '/api/intake/patient') {
    // 账号系统：按当前用户读自己那份档案（admin 读 owner 的）；无登录时兼容单文件
    const viewer = req.mbUser
    const patient = viewer ? loadPatientFor(viewer.role === 'admin' ? (viewer.id) : viewer.id) : loadPatient()
    // admin 默认没自己的档案 → 退回 owner 那份（第一份），便于管理员核对
    const shown = (viewer && viewer.role === 'admin' && !patient.name) ? loadPatient() : patient
    sendJson(res, 200, { ok: true, patient: shown })
    return
  }

  if (req.method === 'POST' && pathname === '/api/intake/patient') {
    const body = await readJsonBody(req)
    try {
      // 账号系统：只写自己那份档案（隔离：A 改后 B 读不变）
      const viewer = req.mbUser
      const patient = viewer ? savePatientFor(viewer.id, body || {}) : savePatient(body || {})
      // savePatient 内部已 delete idCard/phone/address；这里回执明确告知，避免前端以为存进去了
      sendJson(res, 200, { ok: true, patient, notStored: ['idCard', 'phone', 'address'] })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `保存档案失败：${e.message}` })
    }
    return
  }

  // 报告类型判定链（2026-11-15，照 MedData inferReportType 的三步）：
  //   ① 标题（只看抬头，标题优先，正文不参与）→ ② 项目集反推（Jaccard，用本库历史）→ ③ 旧的正文关键词兜底。
  // 之所以要链：实测「染色体核型报告」的正文结论里写着「…易位形成 BCR::ABL 融合基因」，
  // 旧实现只扫正文关键词，直接把核型报告判成了融合基因。
  // 本库已知医院名（用于把「抬头上的检验实验室」让位给「就诊医院」：
  // 实测那份核型 PDF 里「就诊医院(Hospital)：」的值被排版甩到几十行之后，同行取不到，
  // 而同一批报告在库里都记的是「新疆军区总医院」——用已知医院名单校正，口径才一致）。
  let _knownHospitalsCache = null
  function knownHospitals() {
    if (_knownHospitalsCache) return _knownHospitalsCache
    try {
      const hs = (readReports().reports || []).map((r) => r.hospital).filter(Boolean)
      _knownHospitalsCache = Array.from(new Set(hs))
    } catch { _knownHospitalsCache = [] }
    return _knownHospitalsCache
  }
  // 一处组装 meta：四处识别入口（粘贴解析 / PDF 文字层 / PDF 扫描件 / 图片）都调这个，
  // 避免像上次那样「只给图片链路加了 meta，PDF 链路漏了」。
  function metaFor(text = '', rows = []) {
    return guessMeta(text, rows, { classifyReport: () => detectType(text, rows), knownHospitals: knownHospitals() })
  }

  let _typeRowIndexCache = null
  // 判定链本体已搬进 lib/reportTypeDetect.mjs（detectReportType）：server 与测试跑**同一份**实现。
  // 这里只负责提供「本库历史索引」与「旧的正文关键词分类器」两个依赖。
  function detectType(text = '', rows = []) {
    try {
      if (!_typeRowIndexCache) _typeRowIndexCache = buildTypeRowIndex(readReports().reports || [])
    } catch {}
    return detectReportType(text, rows, { rowIndex: _typeRowIndexCache, bodyClassify: classifyReport })
  }

  // 10b. 问诊资料卡：把已导入的报告渲染成 A4 一页（mask=0 关闭姓名脱敏，默认脱敏）
  if (req.method === 'GET' && pathname === '/api/intake/card') {
    try {
      // 2026-11-13 用户口径：默认不脱敏（给医生看），显式 mask=1 才脱敏
      const mask = parsedUrl.searchParams.get('mask') === '1'
      // embed=1：给「打印预览弹窗」里的 iframe 用 —— 不输出浮动打印条（避免与弹窗底部按钮重复、压住表格）。
      // 默认不带，纯净页/新窗口打开仍是完整可打印版本。
      const embed = parsedUrl.searchParams.get('embed') === '1'
      const { reports: allReports } = readReports()
      // 账号系统：user 只出自己 owner 的报告 + 注入自己的档案；admin ?owner= 指定或用全库
      const viewer = req.mbUser
      let reports = allReports
      let patient = null
      if (viewer && viewer.role !== 'admin') {
        const owned = new Set(accounts.listOwners().filter((o) => o.user_id === viewer.id).map((o) => o.report_id))
        reports = allReports.filter((r) => owned.has(r.id))
        patient = loadPatientFor(viewer.id)
      } else if (viewer && viewer.role === 'admin') {
        const ownerParam = parsedUrl.searchParams.get('owner')
        if (ownerParam) {
          const owned = new Set(accounts.listOwners().filter((o) => o.user_id === ownerParam).map((o) => o.report_id))
          reports = allReports.filter((r) => owned.has(r.id))
          patient = loadPatientFor(ownerParam)
        }
      }
      const card = buildCard({ reports: attachBlobIds(reports), mask, embed, patient })
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
      // r6-add P0-1：上传者归属（刚上传尚未被报告引用时也能取回自己的原件）
      try { if (req.mbUser?.id) accounts.setBlobOwner(saved.id, req.mbUser.id) } catch (e) { console.error('[auth] 写 blob 归属失败', e.message) }
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
    // r6-add P0-1：非 admin 只能取自己的（被本人报告引用 或 本人上传）
    if (process.env.MEDBRIEF_AUTH !== 'off' && req.mbUser && !authn.ownsBlob(req.mbUser, id)) {
      return sendJson(res, 403, { ok: false, error: '无权访问此原件' })
    }
    // 2026-11-17 UI 规格 P14：补两个防御响应头（根因是前端改同页 Modal；这两个头覆盖长按另存/直链场景）
    //   Content-Disposition: inline（浏览器内联渲染，不当下载）+ filename* RFC5987 编码
    //   X-Content-Type-Options: nosniff（禁止 MIME 嗅探把 401 JSON 当图片）
    const ext = String(row.type || '').toLowerCase().includes('pdf') ? '.pdf'
      : String(row.type || '').toLowerCase().includes('png') ? '.png'
        : String(row.type || '').toLowerCase().includes('jpeg') ? '.jpg' : ''
    const dispName = encodeURIComponent(`原件-${id}${ext}`)
    res.writeHead(200, {
      'content-type': row.type || 'application/octet-stream',
      'content-length': row.data.length,
      'cache-control': 'no-store',
      'content-disposition': `inline; filename*=UTF-8''${dispName}`,
      'x-content-type-options': 'nosniff',
    })
    res.end(row.data)
    return
  }

  if (pathname === '/api/intake/parse' && req.method === 'POST') {
    const body = await readJsonBody(req)
    try {
      // M2a：MEDREC_BACKEND=8011 → 解析走 /v1/extract（服务出参已映射回本地行形状）
      const rows = medrecOn() ? (await medrecExtractText(body.text || '')).rows : parseLabRows(body.text || '')
      // 2026-11-15（用户选定 C 方案）：项目名认坏/认空的行，用「单位+参考区间」签名反查候选项目。
      // **只给候选，绝不自动改名**；依据仅来自本机已有报告（见 lib/analyteSignature.mjs 的红线注释）。
      try {
        const idx = buildSignatureIndex(readReports().reports || [])
        for (const r of rows) {
          if (!nameLooksUnusable(r.name)) continue
          const sug = suggestBySignature(r, idx)
          if (sug.length) r.nameSuggestions = sug
        }
      } catch (e) {
        console.warn('[intake/parse] 项目名候选反查失败（不影响解析结果）：', e.message)
      }
      const groups = groupForDoctorCard(rows)
      sendJson(res, 200, { ok: true, rows, groups, meta: metaFor(body.text || '', rows), summary: summarizeForCard(groups) })
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
        // M2a：MEDREC_BACKEND=8011 → 一次 /v1/extract 同时拿文本与指标行（不再本地 parseLabRows）
        if (medrecOn()) {
          const r = await medrecExtractImage(dataUrl)
          const layoutLines = String(r.text || '').split('\n').filter(Boolean)
          return {
            text: r.text,
            layoutLines,
            rows: r.rows,
            layout: 'med-recognition',
            source: r.source,
            upstream: undefined,
          }
        }
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
          // 这次识别实际走的是哪条链路（legacy 8008 / med-recognition 8011）—— M3 退役靠它数命中
          source: results.find((r) => r.source)?.source,
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
          const rowsAllText = medrecOn() ? (await medrecExtractText(allText)).rows : parseLabRows(allText)
          const metaTxt = metaFor(allText, rowsAllText)
          const gatedTxt = rowsForType(rowsAllText, metaTxt.reportType)
          const rows = gatedTxt.rows
          return sendJson(res, 200, {
            ok: true,
            kind: 'pdf',
            pdfMode: 'text',
            pages: parsed.pageCount,
            pageTexts,
            text: allText,
            rows,
            rawRowCount: gatedTxt.rows.length + gatedTxt.dropped,
            rowsDropped: gatedTxt.dropped,
            // 2026-11-15：表单项自动填充（按 MedData 标签优先口径，见 lib/reportMeta.mjs）
            meta: metaTxt,
            // 2026-11-15 实测：这里曾同时返回 meta.reportDate(2026-07-17，标签优先) 与
            // guessReportDate(2026-07-15，兜底扫日期) 两个**互相矛盾**的日期，前端取哪个都"有理"。
            // 现在只认一个：标签优先口径；只有它为空才退回扫日期。
            reportDate: metaFor(allText, rows).reportDate || guessReportDate(allText),
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
          meta: metaFor(rasterTexts.join('\n'), rowsAll),
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
      const metaImg = metaFor(out.text, out.rows)
      const gatedImg = rowsForType(out.rows, metaImg.reportType)
      sendJson(res, 200, { ok: !!out.text, kind: 'image', engine: out.source === 'med-recognition' ? 'med-recognition' : '8008/ocr-vision', recognitionSource: medrecBackend(), meta: metaImg, ...out, rows: gatedImg.rows, rawRowCount: out.rawRowCount ?? out.rows.length, rowsDropped: gatedImg.dropped })
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
        : (Array.isArray(body.rows) && body.rows.length ? body.rows : (medrecOn() ? (await medrecExtractText(body.text || '')).rows : parseLabRows(body.text || '')))
      // 每条 row 都落日期：资料卡的「趋势段」按 row.measuredAt 取时间，缺失就退回 row.reportDate；
      // 两者都空则趋势段直接少行（不是空表就是静默丢数据）。故入库时统一用 meta.reportDate 兜底打戳。
      const reportDate = String(meta.reportDate || '')
      const rows = parsedRows.map((r) => ({
        ...r,
        reportDate: r.reportDate || reportDate,
        measuredAt: r.measuredAt || r.reportDate || reportDate,
      }))
      const imageBuf = image ? Buffer.from(image.replace(/^data:image\/[a-z+]+;base64,/i, ''), 'base64') : null
      // PDF 导入也要留原件（2026-11-15 端到端实测发现：PDF 入库后 source='text-only'、没有 blob，
      // 于是「点结论看原件」在 PDF 类报告上是空的。原件在手里却不落库 = 以后没法回看/没法重识别）。
      const pdfB64 = String(body.pdf || '')
      const pdfBuf = pdfB64 ? Buffer.from(pdfB64.replace(/^data:application\/pdf;base64,/i, ''), 'base64') : null
      const originalBuf = imageBuf || pdfBuf
      const sha256 = originalBuf ? sha256Bytes(originalBuf) : ''
      const dhash = String(body.dhash || '')
      const fingerprint = buildReportFingerprint(rows, meta)
      // force=true：用户已在弹窗里确认「仍要导入」——跳过去重判定，但仍计算并保存指纹，
      // 否则这条记录永久不受查重覆盖（旧的前端兜底是「不带 image 重发」，那是查重盲区）
      // 类型识别（放在查重之前：查重要用 reportType —— 同条码同日期但不同类型的报告不是同一份）
      const cls = classifyReport({
        text: String(body.text || ''),
        rows,
        kind: meta.kind || '',
        reportType: meta.reportType || '',
      })
      const detected = detectType(String(body.text || ''), rows)
      const force = body.force === true
      if (!force) {
        // 传入内容指纹：同一条码被多份报告共用时，靠指纹区分「同一份」与「同批不同报告」
        const dup = findDuplicate({ sha256, dhash, reportDate: String(meta.reportDate || ''), barcode: String(meta.barcode || ''), fingerprint, reportType: meta.reportType || detected?.reportType || cls.reportType || '', sampledAt: String(meta.sampledAt || ''), receivedAt: String(meta.receivedAt || ''), text: String(body.text || '') }, store.reports)
        if (dup.dup) return sendJson(res, 200, { ok: false, duplicate: dup, hint: '这张图已导入过' })
        const sameContent = store.reports.find((r) => r.fingerprint === fingerprint)
        if (sameContent) return sendJson(res, 200, { ok: false, duplicate: { dup: true, kind: 'content', of: sameContent.id }, hint: '同一份报告（内容一致）' })
      }
      // 报告级字段对齐 MedData 的 record 模型（records[] = { date, report_type, notes, data_points }）：
      //   reportDate→date、reportType→report_type、rows→data_points。
      // 其余为「单据抬头」事实字段，一律照抄原报告，读不到就空串（不填默认值）。
      // 类型识别（2026-11-14 用户要求「识别时按内容推断报告类型」）：
      // 截图导入的抬头常常没有「报告类型」这一行，入库后只剩 kind 默认值 'lab' —— 一份心脏彩超
      // 就被存成化验单。口径照 MedData parseDoc.detectDocType（见 lib/reportClassify.mjs 文件头）。
      // **推断值必须可分辨**：写 reportTypeInferred / kindInferred，人工填过的一律不覆盖。
      // 口径：人填的（meta.kind / meta.reportType 非空）一律以人为准；没填才用识别结果（cls/detected 已在查重前算好）。
      // 原件兜底：页面导入路径从不传 sourceBlobs，于是「图在内存里、字节没落库」，以后既不能回看也不能重识别
      // （实测 55 份里 1 份如此，字节已不可恢复）。这里由服务端自己存一份，把「有图必有原件」变成接口保证。
      let sourceBlobs = Array.isArray(body.sourceBlobs) ? body.sourceBlobs : (Array.isArray(meta.sourceBlobs) ? meta.sourceBlobs : [])
      let serverSavedOriginal = false
      if (originalBuf && !sourceBlobs.some((b) => b && b.blobId)) {
        try {
          const saved = saveBlobIfAbsent(originalBuf, { kind: 'original', type: imageBuf ? 'image/png' : 'application/pdf', originPath: String(meta.sourceFile || '') })
          if (saved && saved.id) {
            sourceBlobs = [{ blobId: saved.id, role: 'original', sha256, reused: !!saved.reused }]
            serverSavedOriginal = true
          }
        } catch (e) { /* 存原件失败不阻塞入库，但要留痕（下面是 warnings） */ sourceBlobs = sourceBlobs || [] }
      }
      const rec = {
        id: `rep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        createdAt: new Date().toISOString(),
        // 来源标记：没有原图的记录（纯文本录入/测试）必须可识别 ——
        // 2026-11-12 出过一条无 sha256/dhash/imageRef、只有一行手打文本的记录（rep_mwddww4ooys），
        // 混在真实报告里让人误以为是导入的化验单。无原图 = 无法核对、无法查重，只能当草稿。
        source: imageBuf ? 'image' : (pdfBuf ? 'pdf' : 'text-only'),
        sha256, dhash, fingerprint,
        kind: meta.kind || detected?.kind || cls.kind || 'lab',
        reportType: meta.reportType || detected?.reportType || cls.reportType || '',
        // 推断值必须可分辨（红线：认不出的不瞎填，但推断出来的要标出来）
        ...(cls.inferred ? { reportTypeInferred: true, kindInferred: cls.kind !== (meta.kind || ''), inferEvidence: cls.evidence } : {}),
        reportDate: meta.reportDate || '',
        hospital: meta.hospital || '',
        labName: meta.labName || '',
        barcode: meta.barcode || '',
        sampledAt: meta.sampledAt || '',
        receivedAt: meta.receivedAt || '',
        clinicalDiagnosis: meta.clinicalDiagnosis || '',
        patientName: meta.patientName || '',
        sourceFile: meta.sourceFile || '',
        imageRef: originalBuf ? `sha256:${sha256}` : '',
        // 原件引用：blobs 表 id 列表（[{blobId, role}]）。role: original=原图/原件，stitched=跨屏拼接图
        sourceBlobs,
        text: String(body.text || ''),
        rows,
      }
      store.reports.push(rec)
      writeReports(store)
      // 账号系统：新报告归属 = 导入者（admin 导入也记自己，便于一致过滤；MCP 走 token 绑定主体）
      try {
        const ownerUid = req.mbUser?.id || accounts.getUserByPhone('13200000000')?.id
        if (ownerUid) accounts.setOwner(rec.id, ownerUid, { source: 'ingest', reason: 'user import', actorUserId: req.mbUser?.id || null })
      } catch (e) { console.error('[auth] 写报告归属失败', e.message) }
      // 新报告会改变「本库历史」：类型项目集索引与已知医院名单都要失效，否则下一张报告还按旧库判。
      _typeRowIndexCache = null
      _knownHospitalsCache = null
      // 回填「原件 → 报告」关联，便于按报告取回原件重新识别
      for (const b of rec.sourceBlobs) {
        if (b && b.blobId) { try { linkBlobToReport(b.blobId, rec.id) } catch { /* 关联失败不影响入库 */ } }
      }
      sendJson(res, 200, { ok: true, report: rec, total: store.reports.length, serverSavedOriginal, inferred: cls.inferred ? { reportType: cls.reportType, kind: cls.kind, evidence: cls.evidence } : null })
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
    // r6 §1.4：rel 解码容错（畸形 %zz 不能把请求打成 500 噪音）
    let rel = ''
    try { rel = pathname === '/' ? '' : decodeURIComponent(pathname).replace(/^\//, '') } catch { rel = '\0bad-encoding' }

    // 9a. 新壳的静态资源（/assets/*.js 等）必须先命中，否则会误落到 SPA 回退返回 HTML
    if (rel && !rel.startsWith('..')) {
      const assetPath = path.join(distDir, rel)
      if (assetPath.startsWith(distDir) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
        serveStatic(req, res, assetPath)
        return
      }
    }

    // 9b. 旧工作台兜底入口（admin 鉴权在守卫层完成；此处只做静态服务）
    if (pathname === '/legacy' || pathname.startsWith('/legacy/')) {
      if (fs.existsSync(legacyHtml)) {
        serveStatic(req, res, legacyHtml)
        return
      }
    }

    // 9c【已删除】—— 原「项目内其它真实静态文件」会把仓库里任意文件（/data/reports.json、
    //   83MB 原件库、/.git/config、/.agents/MEMORY.md）直接送出。v0.8 方案 §1.4 强制删除。

    // 9c-gate. 静态边界（账号系统方案 §1.4）：只服务 dist-next 与显式公开入口；
    //   仓库内真实存在但不在 dist-next 的文件一律 403（判在解析后的真实路径上，
    //   realpathSync 解大小写/中段 ..；解码后的 rel 解 %64ata；黑名单只是解释器不是边界）。
    if (rel === '\0bad-encoding') return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (rel && !rel.startsWith('..')) {
      const resolved = path.resolve(__dirname, rel)
      let real = resolved
      try { real = fs.realpathSync(resolved) } catch {}
      const inDist = real === distDir || real.startsWith(distDir + path.sep)
      const denyExt = /\.(db|json|mjs|cjs|ts|tsx|md|log)$/i.test(real)
      const denyDir = /(^|\/)(data|docs|tests|lib|mcp|tools|\.git|\.agents|node_modules)\//.test(real)
      if ((!inDist && fs.existsSync(real) && fs.statSync(real).isFile()) || denyExt || denyDir) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
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

server.listen(PORT, BIND, () => {
  if (process.env.MEDBRIEF_AUTH === 'off') console.error('[MedBrief] ⚠️ 鉴权已全局关闭（MEDBRIEF_AUTH=off），仅本机回环可裸访问；不要在生产/局域网这样运行！')
  console.log(`[MedBrief] 服务已在独立端口 ${PORT} 启动: http://127.0.0.1:${PORT}`)
  // 一眼看出这次跑的是真库还是副本（测试进程会设 MEDBRIEF_REPORTS_FILE 指向 /tmp 的副本）
  console.log(`[MedBrief] reportsFile=${REPORTS_FILE}${process.env.MEDBRIEF_REPORTS_FILE ? '（MEDBRIEF_REPORTS_FILE 覆盖，非真实库）' : ''}`)
})

export default server
