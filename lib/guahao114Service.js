// ===================== 114 挂号流程服务层 =====================
// 职责：
//   1. 流程注册表 + 互斥队列（同一时刻只允许一个浏览器流程在跑，避免并发拉起多个浏览器/重复下单）
//   2. 医院 / 科室目录拉取（免登录，带内存缓存，降低被瑞数风控的概率）
//   3. 真实下单成功后，写入既有的 data/guahao-orders.json（与 lib/guahaoCore.js 的订单结构对齐）

import fs from 'node:fs'
import path from 'node:path'
import { Guahao114Flow, STAGES, TERMINAL_STAGES } from './guahao114Flow.js'
import { createCatalogStore } from './catalogStore.js'
import { egoCheckLogin } from './egoDriver.js'

const MAX_RETAINED_FLOWS = 12

export function createGuahao114Service({ dataDir, ordersFile } = {}) {
  const flows = new Map()
  let running = null // 当前占用的 flow id
  // 下单落库所需的上下文只放内存，不写进 guahao-orders.json（避免污染数据文件）
  const pendingContext = { patientName: '', hospital: '', dept: '' }
  const catalog = createCatalogStore({ dir: path.join(dataDir || '.', '114-catalog') })

  function pruneFlows() {
    const finished = [...flows.values()]
      .filter((f) => TERMINAL_STAGES.has(f.stage))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    while (finished.length > MAX_RETAINED_FLOWS) {
      const f = finished.pop()
      flows.delete(f.id)
    }
  }

  async function fetchHospitals({ force = false } = {}) {
    try {
      const r = await catalog.getHospitals({ force })
      return { ...r, source: 'local-catalog' }
    } catch (e) {
      const err = new Error(`医院目录不可用：${e.message}`)
      err.code = 'CATALOG_ERROR'
      throw err
    }
  }

  async function fetchDepts(hosCode, { force = false } = {}) {
    try {
      const r = await catalog.getDepts(hosCode, { force })
      return { ...r, source: 'local-catalog' }
    } catch (e) {
      const err = new Error(`科室目录不可用：${e.message}`)
      err.code = 'CATALOG_ERROR'
      throw err
    }
  }

  function appendOrder(result) {
    if (!ordersFile) return null
    let store = { updatedAt: new Date().toISOString(), doctorsState: [], orders: [] }
    if (fs.existsSync(ordersFile)) {
      try {
        store = JSON.parse(fs.readFileSync(ordersFile, 'utf8'))
      } catch {}
    }
    store.orders = Array.isArray(store.orders) ? store.orders : []

    const slot = result.slot || {}
    const order = {
      // 与 lib/guahaoCore.js 订单结构对齐的关键字段
      orderId: `114-${Date.now().toString(36).toUpperCase()}`,
      status: 'CONFIRMED',
      statusLabel: '已预约',
      createdAt: result.bookedAt || new Date().toISOString(),
      patientName: pendingContext.patientName || '',
      hospital: pendingContext.hospital || '',
      department: pendingContext.dept || '',
      doctorName: slot.doctorName || '',
      visitDate: slot.date || '',
      fee: slot.fee ?? null,
      // 114 真实流程专有字段
      source: '114-live-browser',
      channel: 'jt',
      loginPhone: result.phone || null,
      doctorCode: slot.doctorCode || null,
      slotLabel: slot.label || null,
      slotRaw: slot.raw || null,
      pageUrl: result.url || null,
      pageTextDigest: (result.pageText || '').replace(/\s+/g, ' ').slice(0, 600),
      user: result.user || null,
      notice:
        '请于就诊当日携带就诊人身份证原件或电子医保码，提前 30 分钟到达门诊楼自助机或窗口取号报到就诊。',
    }
    store.orders.unshift(order)
    store.updatedAt = new Date().toISOString()
    try {
      fs.mkdirSync(path.dirname(ordersFile), { recursive: true })
      fs.writeFileSync(ordersFile, JSON.stringify(store, null, 2), 'utf8')
    } catch (e) {
      return { order, persistError: e.message }
    }
    return { order }
  }

  function stampOrderContext({ patientName, hospital, dept }) {
    pendingContext.patientName = patientName || ''
    pendingContext.hospital = hospital || ''
    pendingContext.dept = dept || ''
  }

  function startFlow(payload = {}) {
    if (running) {
      const cur = flows.get(running)
      if (cur && !TERMINAL_STAGES.has(cur.stage)) {
        return {
          ok: false,
          error: `已有流程在运行（${running}，阶段 ${cur.stage}），请等它结束或先中止`,
          runningFlowId: running,
        }
      }
      running = null
    }

    const phone = String(payload.phone || '').trim()
    if (!/^1\d{10}$/.test(phone)) return { ok: false, error: '手机号需为 11 位大陆号码' }

    const target = {
      hospital: payload.hospital || '',
      hosCode: payload.hosCode || '',
      dept1Code: payload.dept1Code || '',
      dept2Code: payload.dept2Code || '',
      deptName: payload.deptName || '',
      doctor: payload.doctor || '',
      date: payload.date || '',
    }
    if (!target.hosCode || !target.dept1Code || !target.dept2Code) {
      return { ok: false, error: '缺少 hosCode / dept1Code / dept2Code，请先选择医院与科室' }
    }

    const flow = new Guahao114Flow({
      phone,
      target,
      patient: { name: payload.patientName || '' },
      headless: payload.headless !== false,
      autoSubmitWithDoctor: payload.autoSubmitWithDoctor !== false,
      reuseSession: payload.reuseSession !== false,
      artifactsDir: path.join(dataDir || '.', '114-flow'),
    })

    stampOrderContext({
      patientName: payload.patientName || '',
      hospital: target.hospital,
      dept: target.deptName,
    })

    flow.on('captcha', (info) => { flow.captchaImage = info })
    flow.on('booked', (result) => {
      // 下单成功才落库（失败/待确认都不写）
      try {
        flow.orderPersist = appendOrder(result)
      } catch (e) {
        flow.orderPersist = { error: e.message }
      }
    })
    flow.on('stage', ({ stage }) => {
      if (TERMINAL_STAGES.has(stage)) {
        if (running === flow.id) running = null
        pruneFlows()
      }
    })

    flows.set(flow.id, flow)
    running = flow.id

    flow.start().catch((e) => flow.fail(e, 'start'))
    return { ok: true, flowId: flow.id, flow: flow.snapshot() }
  }

  function getFlow(id) {
    const f = flows.get(id)
    if (!f) return null
    const snap = f.snapshot()
    if (f.captchaImage) {
      snap.captcha = { imagePath: f.captchaImage.imagePath }
    }
    if (f.orderPersist) snap.orderPersist = f.orderPersist
    return snap
  }

  function latestFlow() {
    const all = [...flows.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return all.length ? getFlow(all[0].id) : null
  }

  async function submitSms(id, code) {
    const f = flows.get(id)
    if (!f) return { ok: false, error: '流程不存在' }
    const c = String(code || '').trim()
    if (!/^\d{6}$/.test(c)) return { ok: false, error: '短信验证码必须是 6 位数字' }
    if (![STAGES.WAITING_SMS, STAGES.SMS_SENT].includes(f.stage)) {
      return { ok: false, error: `当前阶段「${f.stage}」不接受短信验证码` }
    }
    if (f._smsSubmitting) return { ok: false, error: '验证码已提交，正在处理，请勿重复提交' }
    f._smsSubmitting = true
    // 提交后异步推进（网页表单这条路径没有 await waiter，直接推进）
    f.completeLogin(c)
      .catch((e) => f.fail(e, 'completeLogin'))
      .finally(() => { f._smsSubmitting = false })
    return { ok: true }
  }

  function submitCaptcha(id, code) {
    const f = flows.get(id)
    if (!f) return { ok: false, error: '流程不存在' }
    return f.submitCaptchaCode(code)
  }

  function submitConfirm(id, approve) {
    const f = flows.get(id)
    if (!f) return { ok: false, error: '流程不存在' }
    return f.submitConfirm(approve)
  }

  async function abortFlow(id) {
    const f = flows.get(id)
    if (!f) return { ok: false, error: '流程不存在' }
    await f.abort('用户手动中止')
    if (running === id) running = null
    return { ok: true, flow: f.snapshot() }
  }

  function captchaImagePath(id) {
    const f = flows.get(id)
    return f?.captchaImage?.imagePath || null
  }

  return {
    startFlow,
    getFlow,
    latestFlow,
    submitSms,
    submitCaptcha,
    submitConfirm,
    abortFlow,
    captchaImagePath,
    fetchHospitals,
    fetchDepts,
    catalogStats: () => catalog.stats(),
    checkSession: () => egoCheckLogin({ spaceName: 'medbrief-114-session' }),
    STAGES,
  }
}
