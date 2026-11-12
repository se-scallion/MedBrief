// ===================== 114 真实浏览器挂号流程引擎 =====================
// 面向 MedBrief「挂号工作台」：把 2026-11-12 实跑通的登录链路固化下来。
//
// 环境硬条件（缺一不可，见 .agents/MEMORY.md）：
//   1. UA 必须含 MicroMessenger，否则瑞数 WAF 返回 462；
//   2. 渠道必须 pathchannel=jt（京通，渠道 value 16），dp 会返回 8888。
//
// 交互坑位（见 .agents/testing-lessons.md）：
//   - fill() 不触发 Vue 更新 → 手机号/验证码必须真实键盘输入；
//   - 按钮常在视口下方 → 先 scrollIntoView({block:'center'}) 再点；
//   - 图形验证码是一次性的，须同会话内立即填入；
//   - 短信验证码有 60s 冷却（/phoneCode 返回 data.time=60）。
//
// 浏览器驱动：ego-browser（见 lib/egoDriver.js 顶部注释，Playwright 会被 WAF 挡在文档层）。
// 状态通过 stage 事件对外暴露，由 server.mjs（网页表单）或 tools/browser-guahao.mjs（命令行）消费。

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { solveCaptcha } from './captchaSolver.mjs'
import {
  egoLoginRequestSms,
  egoSubmitCaptcha,
  egoSubmitSms,
  egoCheckPatient,
  egoLoadSchedule,
  egoSubmitSlot,
  egoScreenshot,
  egoFinish,
  egoCheckLogin,
} from './egoDriver.js'

export const STAGES = {
  IDLE: 'idle',
  LAUNCHING: 'launching',
  LOGIN_PAGE: 'login_page',
  CAPTCHA_SOLVING: 'captcha_solving',
  CAPTCHA_MANUAL: 'captcha_manual',
  SMS_SENT: 'sms_sent',
  WAITING_SMS: 'waiting_sms',
  LOGGED_IN: 'logged_in',
  CHECKING_PATIENT: 'checking_patient',
  NEED_PATIENT: 'need_patient',
  PATIENT_OK: 'patient_ok',
  LOADING_SCHEDULE: 'loading_schedule',
  SLOTS_READY: 'slots_ready',
  NEED_CONFIRM: 'need_confirm',
  BOOKING: 'booking',
  BOOKED: 'booked',
  WAF_BLOCKED: 'waf_blocked',
  FAILED: 'failed',
  ABORTED: 'aborted',
}

export const TERMINAL_STAGES = new Set([
  STAGES.BOOKED,
  STAGES.WAF_BLOCKED,
  STAGES.FAILED,
  STAGES.ABORTED,
  STAGES.NEED_PATIENT,
])

function nowIso() {
  return new Date().toISOString()
}

function phoneMatches(full, masked) {
  if (!full || !masked) return true
  const f = String(full)
  const m = String(masked)
  if (m.length !== f.length) return false
  for (let i = 0; i < f.length; i++) {
    if (m[i] !== '*' && m[i] !== f[i]) return false
  }
  return true
}

function maskPhone(p) {
  return String(p || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}

export class Guahao114Flow extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.phone        登录手机号（11 位）
   * @param {object} opts.target       { hospital, hosCode, dept1Code, dept2Code, deptName, doctor, date }
   * @param {object} [opts.patient]    { name }
   * @param {string} [opts.artifactsDir]
   * @param {boolean} [opts.autoSubmitWithDoctor] 指定医生时是否自动提交（默认 true）
   */
  constructor(opts = {}) {
    super()
    this.phone = String(opts.phone || '').trim()
    this.target = opts.target || {}
    this.patient = opts.patient || {}
    this.artifactsDir = opts.artifactsDir || path.resolve('data/114-flow')
    this.autoSubmitWithDoctor = opts.autoSubmitWithDoctor !== false
    // 默认复用浏览器里已存在的 114 登录态，避免每次都发短信（既省事也降低被风控概率）
    this.reuseSession = opts.reuseSession !== false

    this.id = `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    this.spaceName = `medbrief-114-${this.id}`
    this.stage = STAGES.IDLE
    this.logs = []
    this.error = null
    this.result = null
    this.slots = []
    this.calendarRaw = null
    this.calendarStatus = null
    this.screenshots = []
    this.aborted = false

    this._smsWaiter = null
    this._captchaWaiter = null
    this._confirmWaiter = null

    this.createdAt = nowIso()
    this.updatedAt = this.createdAt
  }

  setStage(stage, detail = null) {
    this.stage = stage
    this.updatedAt = nowIso()
    if (detail) this.log(`[${stage}] ${detail}`)
    this.emit('stage', { stage, detail, at: this.updatedAt })
  }

  log(msg) {
    const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`
    this.logs.push(line)
    if (this.logs.length > 400) this.logs.shift()
    this.emit('log', line)
  }

  snapshot() {
    return {
      id: this.id,
      stage: this.stage,
      phone: maskPhone(this.phone),
      target: this.target,
      patient: this.patient.name ? { name: this.patient.name } : null,
      logs: this.logs.slice(-100),
      error: this.error,
      result: this.result,
      slots: this.slots,
      screenshots: this.screenshots.slice(-6),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      terminal: TERMINAL_STAGES.has(this.stage),
    }
  }

  async shot(tag) {
    try {
      fs.mkdirSync(this.artifactsDir, { recursive: true })
      const file = path.join(this.artifactsDir, `${this.id}_${String(tag).replace(/[^\w-]+/g, '_')}.png`)
      const r = await egoScreenshot({ spaceName: this.spaceName, outPath: file })
      if (r.ok) {
        this.screenshots.push({ tag, file, at: nowIso() })
        return file
      }
      this.log(`截图失败(${tag}): ${r.error}`)
    } catch (e) {
      this.log(`截图异常(${tag}): ${e.message}`)
    }
    return null
  }

  // ---------- 主流程 ----------
  async start() {
    try {
      this.setStage(STAGES.LAUNCHING, '检查是否已有 114 登录态')
      if (this.reuseSession) {
        const r = await egoCheckLogin({ spaceName: this.spaceName })
        if (r.ok && r.result.loggedIn) {
          this.userInfo = r.result.user || {}
          const masked = this.userInfo.mobileConfound || ''
          this.log(`复用已有登录态：${masked} ${this.userInfo.nameConfound || ''}（authStatus=${this.userInfo.authStatus}）`)
          if (this.phone && masked && !phoneMatches(this.phone, masked)) {
            this.log(`注意：会话登录号 ${masked} 与表单填写 ${maskPhone(this.phone)} 不一致，本次按会话登录号继续`)
          }
          this.sessionReused = true
          this.setStage(STAGES.LOGGED_IN, '已复用浏览器登录态，跳过短信验证')
          this.emit('loggedIn', { user: redactUser(this.userInfo), reused: true })
          await this._checkPatient()
          return this.snapshot()
        }
        this.log('未检测到有效登录态，走短信登录')
      }
      if (!/^1\d{10}$/.test(this.phone)) throw new Error('手机号格式不正确，需 11 位大陆手机号')
      this.setStage(STAGES.LOGIN_PAGE, '驱动 ego lite 浏览器打开 114 登录页')
      await this._loginAndRequestSms()
      return this.snapshot()
    } catch (e) {
      await this.fail(e, 'start')
      return this.snapshot()
    }
  }

  async _loginAndRequestSms() {
    this.setStage(STAGES.LOGIN_PAGE, '打开登录页并输入手机号')
    const r = await egoLoginRequestSms({
      spaceName: this.spaceName,
      phone: this.phone,
      captchaPath: path.join(this.artifactsDir, `${this.id}_captcha.png`),
    })
    if (!r.ok) throw new Error(r.error || '登录页操作失败')
    if (!r.result.needCaptcha) {
      this.setStage(STAGES.SMS_SENT, '短信已发出（无图形验证码）')
      this.setStage(STAGES.WAITING_SMS, '等待用户提供 6 位短信验证码')
      return
    }
    await this._handleCaptcha(r.result.dataUrl)
  }

  async _handleCaptcha(dataUrl) {
    this.setStage(STAGES.CAPTCHA_SOLVING, '识别图形验证码')
    fs.mkdirSync(this.artifactsDir, { recursive: true })
    const imgPath = path.join(this.artifactsDir, `${this.id}_captcha.png`)
    const b64 = String(dataUrl).split(',')[1] || ''
    if (!b64) throw new Error('图形验证码图片为空')
    fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'))

    let code = null
    let method = null
    const solved = await solveCaptcha(imgPath, { allowAI: true })
    for (const a of solved.attempts) {
      this.log(`验证码识别 ${a.method} → ${a.code || '失败'}${a.error ? '（' + a.error + '）' : ''}`)
    }
    if (solved.code) {
      code = solved.code
      method = solved.method
    } else {
      this.setStage(STAGES.CAPTCHA_MANUAL, '自动识别失败，等待人工填入图形验证码')
      this.emit('captcha', { imagePath: imgPath, imageDataUrl: dataUrl })
      code = await this.waitForCaptchaCode()
      method = 'manual'
      if (!code) throw new Error('图形验证码未提供，流程中止')
    }
    this.log(`图形验证码 ${code}（来源：${method}）`)

    const r = await egoSubmitCaptcha({ spaceName: this.spaceName, code })
    if (!r.ok) throw new Error(r.error || '提交图形验证码失败')
    if (!r.result.smsRequested) {
      await this.shot('captcha_rejected')
      throw new Error(`图形验证码未通过（识别为 ${code}），请重跑流程`)
    }
    this.setStage(STAGES.SMS_SENT, '短信已发出，60 秒内有效')
    this.setStage(STAGES.WAITING_SMS, '等待用户提供 6 位短信验证码')
  }

  // ---------- 外部输入 ----------
  waitForSmsCode() { return new Promise((resolve) => { this._smsWaiter = resolve }) }
  waitForCaptchaCode() { return new Promise((resolve) => { this._captchaWaiter = resolve }) }
  waitForConfirm() { return new Promise((resolve) => { this._confirmWaiter = resolve }) }

  submitSmsCode(code) {
    const c = String(code || '').trim()
    if (!/^\d{6}$/.test(c)) return { ok: false, error: '短信验证码必须是 6 位数字' }
    if (!this._smsWaiter) return { ok: false, error: '当前流程不在等待短信验证码状态' }
    const w = this._smsWaiter
    this._smsWaiter = null
    w(c)
    return { ok: true }
  }

  submitCaptchaCode(code) {
    const c = String(code || '').trim()
    if (!/^\d{4}$/.test(c)) return { ok: false, error: '图形验证码必须是 4 位数字' }
    if (!this._captchaWaiter) return { ok: false, error: '当前流程不在等待图形验证码状态' }
    const w = this._captchaWaiter
    this._captchaWaiter = null
    w(c)
    return { ok: true }
  }

  submitConfirm(approve) {
    if (!this._confirmWaiter) return { ok: false, error: '当前流程不在等待确认状态' }
    const w = this._confirmWaiter
    this._confirmWaiter = null
    w({ approve: !!approve })
    return { ok: true }
  }

  // ---------- 登录提交 → 就诊人 → 号源 ----------
  async completeLogin(smsCode) {
    try {
      this.setStage(STAGES.LOGGED_IN, '提交短信验证码')
      const r = await egoSubmitSms({ spaceName: this.spaceName, code: String(smsCode || '').trim() })
      if (!r.ok) throw new Error(r.error || '提交短信验证码失败')
      const user = r.result.user
      this.log(`/user/get → ${JSON.stringify(user).slice(0, 180)}`)
      if (!user || user.code !== '0000') {
        await this.shot('login_failed')
        throw new Error(`登录未成功：${JSON.stringify(user).slice(0, 200)}`)
      }
      this.userInfo = user.data || {}
      this.log(`登录成功：${maskPhone(this.phone)}${this.userInfo ? '' : '（未取到用户详情）'}`)
      this.emit('loggedIn', { user: redactUser(this.userInfo) })
      await this._checkPatient()
      return this.snapshot()
    } catch (e) {
      await this.fail(e, 'completeLogin')
      return this.snapshot()
    }
  }

  async _checkPatient() {
    this.setStage(STAGES.CHECKING_PATIENT, '检查就诊人')
    const r = await egoCheckPatient({ spaceName: this.spaceName })
    if (!r.ok) throw new Error(r.error || '就诊人页面读取失败')
    const text = r.result.text || ''
    const wantName = String(this.patient.name || '').trim()
    // 页面脱敏显示形如「*聪」，退化为尾字匹配
    const hit = wantName ? text.includes(wantName) || text.includes(wantName.slice(-1)) : true
    if (!hit) {
      await this.shot('no_patient')
      this.setStage(STAGES.NEED_PATIENT, '未找到匹配就诊人，需先在 114 绑定（本人身份证实名认证）')
      this.emit('needPatient', { wantName })
      return
    }
    this.log(`就诊人匹配通过（${wantName || '未指定姓名'}）`)
    this.setStage(STAGES.PATIENT_OK, '就诊人就绪')
    setImmediate(() => this.loadSchedule().catch((e) => this.fail(e, 'loadSchedule')))
  }

  async loadSchedule() {
    try {
      const { hosCode, dept1Code, dept2Code } = this.target
      if (!hosCode || !dept1Code || !dept2Code) {
        throw new Error('缺少挂号目标编码：hosCode / dept1Code / dept2Code')
      }
      this.setStage(STAGES.LOADING_SCHEDULE, `加载号源 ${hosCode}/${dept2Code}`)
      const r = await egoLoadSchedule({ spaceName: this.spaceName, hosCode, dept1Code, dept2Code })
      if (!r.ok) throw new Error(r.error || '号源页加载失败')

      this.calendarStatus = r.result.calendarStatus
      this.calendarRaw = r.result.calendar
      this.slots = normalizeCalendar(r.result.calendar)

      if (this.calendarStatus && this.calendarStatus >= 400) {
        await this.shot('waf_blocked')
        this.setStage(
          STAGES.WAF_BLOCKED,
          `号源接口被瑞数 WAF 拦截（HTTP ${this.calendarStatus}）。浏览器页面仍在，可直接手动选号；或等 30–60 分钟风控冷却后重试。`,
        )
        return this.snapshot()
      }
      if (!this.slots.length) {
        await this.shot('no_slots')
        this.setStage(
          STAGES.WAF_BLOCKED,
          `未取到号源数据（接口状态 ${this.calendarStatus ?? '未触发'}）。页面文本：${(r.result.text || '').replace(/\s+/g, ' ').slice(0, 120)}`,
        )
        return this.snapshot()
      }

      this.setStage(STAGES.SLOTS_READY, `取到 ${this.slots.length} 个排班项`)
      return await this._decide()
    } catch (e) {
      await this.fail(e, 'loadSchedule')
      return this.snapshot()
    }
  }

  async _decide() {
    const doctor = String(this.target.doctor || '').trim()
    const picked = pickSlot(this.slots, { doctor, date: this.target.date })
    if (!picked) {
      await this.shot('no_match')
      this.setStage(STAGES.SLOTS_READY, doctor ? `未找到「${doctor}」有号排班` : '未找到可选排班')
      return this.snapshot()
    }
    this.pickedSlot = picked
    this.log(`候选号源：${picked.label || ''} 剩余=${picked.remaining ?? '未知'}`)

    if (doctor && this.autoSubmitWithDoctor) {
      this.log('已指定医生 → 按用户口径直接提交（114 预约不扣费）')
      return await this._submit(picked)
    }

    this.setStage(STAGES.NEED_CONFIRM, doctor ? '指定医生未命中，等待你确认替代号源' : '未指定医生，等待你确认号源')
    this.emit('needConfirm', { slot: picked, slots: this.slots })
    const ans = await this.waitForConfirm()
    if (!ans.approve) {
      this.setStage(STAGES.ABORTED, '用户在确认环节放弃')
      return this.snapshot()
    }
    return await this._submit(picked)
  }

  async _submit(picked) {
    try {
      this.setStage(STAGES.BOOKING, '提交预约')
      const labels = []
      if (picked.doctorName) labels.push(picked.doctorName)
      if (picked.date) labels.push(picked.date)
      const r = await egoSubmitSlot({ spaceName: this.spaceName, labels })
      if (!r.ok) throw new Error(r.error || '提交动作失败')
      const res = r.result
      this.log(`点击「${res.clicked || '未命中'}」，提交按钮「${res.submitted || '未找到'}」`)

      if (res.needPay) {
        await this.shot('need_pay')
        this.setStage(STAGES.NEED_CONFIRM, '该号源疑似需要在线支付，已停下等你确认（避免误扣款）')
        this.emit('needPay', { pageText: res.beforeText })
        return this.snapshot()
      }
      if (!res.submitted) {
        await this.shot('submit_not_found')
        this.setStage(STAGES.NEED_CONFIRM, '未找到提交按钮，已停在确认页等你手动提交')
        return this.snapshot()
      }

      await this.shot('after_submit')
      const success = /预约成功|挂号成功|预约申请成功|已预约|预约完成/.test(res.afterText || '')
      if (success) {
        this.result = {
          ok: true,
          bookedAt: nowIso(),
          url: res.url,
          pageText: res.afterText,
          slot: picked,
          user: redactUser(this.userInfo || {}),
          phone: this.phone,
        }
        this.setStage(STAGES.BOOKED, '预约成功')
        this.emit('booked', this.result)
      } else {
        this.result = {
          ok: false,
          bookedAt: nowIso(),
          url: res.url,
          pageText: res.afterText,
          slot: picked,
        }
        this.setStage(STAGES.NEED_CONFIRM, '提交后未检出成功文案，请看截图确认')
      }
      return this.snapshot()
    } catch (e) {
      await this.fail(e, 'submit')
      return this.snapshot()
    }
  }

  async fail(e, where) {
    this.error = { where, message: String((e && e.message) || e) }
    this.log(`失败(${where}): ${this.error.message}`)
    this.setStage(STAGES.FAILED, this.error.message)
  }

  async abort(reason = '用户中止') {
    this.aborted = true
    if (this._smsWaiter) { const w = this._smsWaiter; this._smsWaiter = null; w(null) }
    if (this._captchaWaiter) { const w = this._captchaWaiter; this._captchaWaiter = null; w(null) }
    if (this._confirmWaiter) { const w = this._confirmWaiter; this._confirmWaiter = null; w({ approve: false }) }
    this.setStage(STAGES.ABORTED, reason)
    await this.close()
  }

  async close() {
    await egoFinish({ spaceName: this.spaceName }).catch(() => {})
  }
}

function redactUser(u = {}) {
  return {
    mobileConfound: u.mobileConfound || null,
    nameConfound: u.nameConfound || null,
    idCardNoConfound: u.idCardNoConfound || null,
    authStatus: u.authStatus,
    authStatusView: u.authStatusView || null,
    userId: u.userId || null,
  }
}

/**
 * 日历接口结构尚未取得 200 成功样本（2026-11-12 本会话稳定 461/462），
 * 因此做结构容错解析：尽力从多种可能形态里抽日期/医生/剩余号，
 * 抽不出来时保留原始数据供前端展示，不臆造字段。
 */
export function normalizeCalendar(body) {
  const out = []
  if (!body || typeof body !== 'object') return out
  const root = body.data || body
  const lists = []
  for (const key of ['calendarList', 'calendars', 'list', 'dutyList', 'detailList']) {
    if (Array.isArray(root && root[key])) lists.push(root[key])
  }
  if (Array.isArray(root)) lists.push(root)

  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const date = item.dutyDate || item.date || item.visitDate || null
      const detail = Array.isArray(item.detail) ? item.detail : []
      const doctors = detail.map((d) => ({
        doctorName: d.doctorName || d.name || null,
        doctorCode: d.doctorCode || null,
        title: d.doctorTitle || d.title || null,
        remaining: d.remaining != null ? d.remaining : (d.leftNum != null ? d.leftNum : null),
        fee: d.fee != null ? d.fee : (d.price != null ? d.price : null),
        periods: Array.isArray(d.period) ? d.period : [],
      }))
      out.push({
        date,
        status: item.status != null ? item.status : null,
        statusClass: item.statusClass || null,
        label: item.statusView || item.dutyDateView || null,
        doctors,
      })
    }
  }
  return out
}

/** 从排班项里挑一个号源：优先指定医生，其次指定日期，否则第一个有号的 */
export function pickSlot(slots, { doctor = '', date = '' } = {}) {
  if (!Array.isArray(slots) || !slots.length) return null
  const wantsDoctor = String(doctor || '').trim()
  const wantsDate = String(date || '').replace(/-/g, '')

  const flat = []
  for (const s of slots) {
    const docs = s.doctors || []
    if (!docs.length) {
      flat.push({ date: s.date, doctorName: null, remaining: null, label: s.date || '', status: s.status })
      continue
    }
    for (const d of docs) {
      flat.push({
        date: s.date,
        doctorName: d.doctorName,
        doctorCode: d.doctorCode,
        title: d.title,
        remaining: d.remaining,
        fee: d.fee,
        status: s.status,
        label: [d.doctorName, s.date].filter(Boolean).join(' '),
      })
    }
  }

  const avail = flat.filter((x) => x.remaining == null || Number(x.remaining) > 0)
  let cands = avail.length ? avail : flat

  if (wantsDate) {
    const byDate = cands.filter((x) => String(x.date || '') === wantsDate)
    if (byDate.length) cands = byDate
  }
  if (wantsDoctor) {
    const byDoc = cands.filter(
      (x) => (x.doctorName || '').includes(wantsDoctor) || wantsDoctor.includes(x.doctorName || '\u00a7'),
    )
    if (!byDoc.length) return null
    cands = byDoc
  }
  return cands[0] || null
}
