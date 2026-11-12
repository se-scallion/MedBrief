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
//   - GET  /api/guahao/sniper/status 114 会话与时钟差校准状态
//   - POST /api/guahao/reset         排班与订单重置（供自动化测试隔离用）
//   - 静态托管：apps/medbrief-web/index.html 及静态资源

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createGuahaoManager } from './lib/guahaoCore.js'
import { buildMedDataBundle, parseMedDataBundle } from './lib/meddataBundle.js'
import { fetchLiveDoctorSchedule } from './lib/bjcyhScraper.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = parseInt(process.env.PORT || '5174', 10)
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const STORAGE_FILE = path.join(DATA_DIR, 'guahao-orders.json')
const AUTH_FILE = path.join(DATA_DIR, '114-auth.json')
const guahaoManager = createGuahaoManager({ storageFile: STORAGE_FILE, fs })

let activeLoginBrowser = null

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
    const bridgeScript = path.join(__dirname, '..', '..', 'tools', 'guahao', 'bridge.py')
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
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      app: 'medbrief',
      name: 'MedBrief Standalone Workbench',
      port: PORT,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    })
    return
  }

function getNextReleaseCountdown() {
  const now = new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const beijingNow = new Date(utc + 3600000 * 8)
  
  const target = new Date(beijingNow)
  target.setHours(7, 0, 0, 0)
  if (beijingNow.getTime() >= target.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  
  const diffMs = target.getTime() - beijingNow.getTime()
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const targetReleaseDate = new Date(beijingNow)
  targetReleaseDate.setDate(targetReleaseDate.getDate() + 14)
  const yyyy = targetReleaseDate.getFullYear()
  const mm = String(targetReleaseDate.getMonth() + 1).padStart(2, '0')
  const dd = String(targetReleaseDate.getDate()).padStart(2, '0')

  return {
    nowBeijing: beijingNow.toISOString().replace('T', ' ').slice(0, 19),
    targetReleaseTime: target.toISOString().replace('T', ' ').slice(0, 19),
    targetDateForBooking: `${yyyy}-${mm}-${dd}`,
    diffMs,
    countdown: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
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

  // 3. GET /api/guahao/orders
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

  // 4b. GET /api/guahao/114/auth
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
    let payload = {}
    try {
      payload = rawBody ? JSON.parse(rawBody) : {}
    } catch (e) {
      sendJson(res, 400, { ok: false, error: '无效的 JSON 请求体: ' + e.message })
      return
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
            name: patient.name || '代聪',
            idCard: patient.idCard || '511025199605011511',
            phone: patient.phone || '13800100114',
            diagnosis,
            stage,
            hospital: patient.hospital || '北京朝阳医院',
            onset: patient.onset || '2024-03',
            genes: patient.genes || ['IKZF1缺失', 'CD19+', 'CD22+'],
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
  }

  // 9. 静态页面请求
  if (req.method === 'GET') {
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname)
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      serveStatic(req, res, filePath)
      return
    }
    // 单页回退
    const indexHtml = path.join(__dirname, 'index.html')
    if (fs.existsSync(indexHtml)) {
      serveStatic(req, res, indexHtml)
      return
    }
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[MedBrief] 服务已在独立端口 ${PORT} 启动: http://127.0.0.1:${PORT}`)
})

export default server
