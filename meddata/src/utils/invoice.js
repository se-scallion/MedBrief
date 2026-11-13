// ===================== 发票 / 结算单：查重·归属·对账（纯函数，无 DOM、无 store） =====================
// 本文件只做判定，不碰 IndexedDB、不发请求，可用 node 直连单测（scripts/verify-invoice.mjs）。
//
// 口径（用户 2026-10-21 拍板，改这里前先读 docs/cost-invoice-module-plan.md §4）：
//   1) 两本账并行：`stays.total` = 实际花费（实掏，报销后）；`invoice.amount_total` = 票面总额。
//      两者都权威，差额就是「推定报销额」，不是错误。
//   2) 归属按「落库的 stay_id」表达，不每次现算——否则用户改一次住院日期，历史归属会静默漂移。
//   3) 查重键 = 票据代码|票据号码 → 校验码 → 文件指纹。校验码只作兜底：
//      实测 OCR 会把校验码读错（krpicd → krpied），当主键会让同一张票反复入库。
//   4) 归属匹配用**闭区间** [start, end]，与费用均摊的半开区间（不含出院当天）不同口径；
//      实测出院当天开票、出院后 4 天开票都存在，两种都必须命中。

import { daysBetween, isDateStr, nextDay } from './medCourses.js'

// ---------- 归一与查重 ----------

// 票号归一：全角→半角、去掉所有空白与连字符、字母转大写。
// 为什么不能只 trim：同票号在不同来源会写成「0020104754」「0020 1047 54」「００２０１０４７５４」。
export function normInvoiceNo(s) {
  const t = String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角→半角
    .replace(/\s+/g, '')
    .replace(/[-—_/]/g, '')
    .toUpperCase()
  return t
}

// 查重键：三级降级。返回 '' 表示这张票没有可用的查重身份（只能靠人工/文件名判断）。
export function invoiceKey(inv) {
  if (!inv) return ''
  const code = normInvoiceNo(inv.invoice_code)
  const no = normInvoiceNo(inv.invoice_no)
  if (code || no) return `${code}|${no}`
  const chk = normInvoiceNo(inv.check_code)
  if (chk) return `chk|${chk}`
  const h = String(inv.file_hash || '').trim()
  return h ? `fh|${h}` : ''
}

// 查重：命中返回已存在的那条（优先返回「原始件」而不是此前被记为重复的副本）。
// 同一张票既可能有 dup_of 副本，也可能有主记录——用户要打开的是主记录。
export function findDuplicateInvoice(candidate, list = []) {
  const key = invoiceKey(candidate)
  if (!key) return null
  const hits = (list || []).filter((v) => v && invoiceKey(v) === key)
  if (!hits.length) return null
  return hits.find((v) => !v.dup_of) || hits[0]
}

// 同票号但金额不同 = 冲突（OCR 读错 / 医院红冲重开）。查重命中不等于金额一致，必须分开提示。
export function invoiceAmountConflict(candidate, existing) {
  if (!candidate || !existing) return false
  const a = Number(candidate.amount_total)
  const b = Number(existing.amount_total)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) > 0.01
}

// ---------- 归属住院段 ----------

// 住院段的闭区间右端：end 为空 = 仍在院 → 视为很远（不限右端）；有 end 时含出院当天。
function stayEndClamped(stay, horizon) {
  return isDateStr(stay && stay.end) ? stay.end : horizon
}

// 归属：按优先级命中即停（规则表见设计文档 §4.2）。
//   opts.dischargeGraceDays  出院后多少天内开票仍算本次住院（默认 7；实测出院当天与 +4 天都存在）
//   opts.suspectWindowDays   完全没命中时，多少天内有住院段就标「疑似」（默认 30）
//   opts.today               仍住院段的右端基准日
// 返回 { stay_id, stay_link, candidates, match_note, reason }
//   reason: 'service-range' | 'in-range' | 'grace-after-discharge' | 'ambiguous' | 'suspect' | 'no-match'
export function matchStay(inv, stays = [], opts = {}) {
  const grace = Number.isFinite(opts.dischargeGraceDays) ? opts.dischargeGraceDays : 7
  const suspectWindow = Number.isFinite(opts.suspectWindowDays) ? opts.suspectWindowDays : 30
  const today = isDateStr(opts.today) ? opts.today : new Date().toISOString().slice(0, 10)
  const list = (stays || []).filter((s) => s && isDateStr(s.start))
  const none = { stay_id: null, stay_link: 'none', candidates: [], match_note: '' }
  if (!list.length) return { ...none, reason: 'no-match' }

  // 1) 票面自带住院起止 → 与各段重叠天数最长者（同日两段不猜，进 4）
  if (isDateStr(inv.service_from)) {
    const from = inv.service_from
    const to = isDateStr(inv.service_to) ? inv.service_to : from
    const scored = list
      .map((s) => {
        const sEnd = stayEndClamped(s, today)
        const a = from > s.start ? from : s.start // 闭区间重叠
        const b = to < sEnd ? to : sEnd
        const overlap = a <= b ? daysBetween(a, b) : 0
        return { s, overlap }
      })
      .filter((x) => x.overlap > 0)
      .sort((x, y) => y.overlap - x.overlap)
    if (scored.length === 1) {
      const only = scored[0].s
      const note = only.end && to > only.end ? `票面区间超出该段 ${to}` : ''
      return { stay_id: only.id, stay_link: 'auto', candidates: [only.id], match_note: note, reason: 'service-range' }
    }
    if (scored.length > 1) {
      // 重叠天数相同 → 真歧义；不同 → 取最长，但仍提示
      const top = scored[0].overlap
      const tied = scored.filter((x) => x.overlap === top)
      if (tied.length === 1) {
        const s = tied[0].s
        return {
          stay_id: s.id,
          stay_link: 'auto',
          candidates: scored.map((x) => x.s.id),
          match_note: `票面区间跨 ${scored.length} 段，取重叠最长（${top} 天）`,
          reason: 'service-range',
        }
      }
      return {
        ...none,
        candidates: tied.map((x) => x.s.id),
        match_note: `票面区间同时命中 ${tied.length} 段住院，待确认`,
        reason: 'ambiguous',
      }
    }
  }

  // 2) 开票日落在住院段闭区间内（含出院当天）
  if (isDateStr(inv.issued_at)) {
    const d = inv.issued_at
    const inside = list.filter((s) => d >= s.start && d <= stayEndClamped(s, today))
    if (inside.length === 1) {
      return { stay_id: inside[0].id, stay_link: 'auto', candidates: [inside[0].id], match_note: '', reason: 'in-range' }
    }
    if (inside.length > 1) {
      return {
        ...none,
        candidates: inside.map((s) => s.id),
        match_note: `开票日 ${d} 同时落在 ${inside.length} 段住院内，待确认`,
        reason: 'ambiguous',
      }
    }

    // 3) 出院后 grace 天内开票（医院普遍出院后才开票，实测 4 天）
    const after = list
      .filter((s) => isDateStr(s.end) && d > s.end && d <= addDaysSafe(s.end, grace))
      .sort((a, b) => (a.end > b.end ? -1 : 1))
    if (after.length === 1) {
      const gap = daysBetween(after[0].end, d) - 1
      return {
        stay_id: after[0].id,
        stay_link: 'auto',
        candidates: [after[0].id],
        match_note: `出院后 ${gap} 天开票`,
        reason: 'grace-after-discharge',
      }
    }
    if (after.length > 1) {
      return {
        ...none,
        candidates: after.map((s) => s.id),
        match_note: '出院后多段住院均可能在宽限期内，待确认',
        reason: 'ambiguous',
      }
    }

    // 4) 完全没命中：住院票 + 附近有住院段 → 标「疑似」给一键确认
    if (inv.category === 'inpatient') {
      const near = list.filter((s) => {
        const sEnd = stayEndClamped(s, today)
        return d >= addDaysSafe(s.start, -suspectWindow) && d <= addDaysSafe(sEnd, suspectWindow)
      })
      if (near.length === 1) {
        return {
          ...none,
          candidates: [near[0].id],
          match_note: '开票日不在该段住院区间内（超出宽限），请确认',
          reason: 'suspect',
        }
      }
    }
  }

  return { ...none, reason: 'no-match' }
}

// 日期加减（避免依赖 Date 解析字符串的时区行为；非法输入原样返回）
function addDaysSafe(dateStr, n) {
  if (!isDateStr(dateStr)) return dateStr
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(y, m - 1, d + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

// 归属是否仍需人工确认（UI 用它决定是否出黄色「待确认」条）
export function needsConfirm(match) {
  return match && (match.reason === 'ambiguous' || match.reason === 'suspect')
}

// 批量重算归属：只改 auto 的；manual 永不动；已绑定的保持（避免每次打开页面就重排）。
// 返回需要写回的补丁列表 [{ id, stay_id, stay_link, match_note, reason }]。
export function relinkAll(invoices = [], stays = [], opts = {}) {
  const out = []
  for (const inv of invoices || []) {
    if (!inv || inv.stay_link === 'manual') continue
    const m = matchStay(inv, stays, opts)
    if (m.stay_id !== (inv.stay_id || null) || m.match_note !== (inv.match_note || '')) {
      out.push({ id: inv.id, stay_id: m.stay_id, stay_link: m.stay_link, match_note: m.match_note, reason: m.reason })
    }
  }
  return out
}

// ---------- 对账（住院段粒度） ----------

// ⚠ 必须显式判 null/''：Number(null) === 0，会把「没取到的统筹额」当成 0 参与等式，
// 从而把「缺项」误判成残差（实测踩过：derived 被错算成 residual 3205.29）。
const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const sum = (arr) => arr.reduce((a, b) => a + b, 0)
const r2 = (n) => Math.round(n * 100) / 100

// 对账：三方等式 票面总额 = 统筹报销 + 个人实掏
//   已知两个 → 第三个是「推定」；三个都已知 → 校验残差。
//   state: 'no-invoice' | 'over' | 'closed' | 'residual' | 'derived'
//     over     实掏 > 票面：一定是错的（录错金额 / 票不全 / 两段住院拼一起），唯一需要红标的
//     closed   三数闭合（残差 ≤ 0.01）
//     residual 三数不闭合，差 residual
//     derived  只有票面 + 实掏 → 差额即推定报销额（正常状态，不是告警）
//   rangeMismatch 票面区间与该住院段不一致（单独一个布尔，因为它可以和 closed 同时成立）
export function reconcileStay(stay, invoices = []) {
  const all = (invoices || []).filter((v) => v && stay && v.stay_id === stay.id)
  // ⚠ 结算单与票据是**同一笔钱的两份凭证**（财政票据 3784.25 = 结算单总额 3784.25），
  // 相加会把住院金额翻倍（实测：导入「住院票据 + 医保结算单」后 total 变成 7568.50）。
  // 规则：金额只取票据；没有票据时才让结算单充当金额来源；结算单另用于交叉校验统筹额。
  const slips = all.filter((v) => (v.doc_kind || 'invoice') === 'invoice')
  const settles = all.filter((v) => v.doc_kind === 'settlement')
  const mine = slips.length ? slips : settles
  const total = r2(sum(mine.map((v) => num(v.amount_total) ?? 0)))
  const system = num(stay && stay.total) ?? 0
  const base = {
    stay_id: stay ? stay.id : null,
    count: slips.length,
    settlementCount: settles.length,
    total,
    system,
    insurance: null,
    insuranceFrom: null,
    derivedInsurance: null,
    residual: null,
    rangeMismatch: false,
    state: 'no-invoice',
  }
  if (!all.length) return base

  // 统筹额来源：① 票据自带且每张都有 → 用票据之和；② 否则用结算单「总额 − 个人应付」推算
  const ins = slips.map((v) => num(v.amount_insurance))
  let insurance = slips.length && ins.every((x) => x != null) ? r2(sum(ins)) : null
  let insuranceFrom = insurance != null ? 'invoice' : null
  if (insurance == null) {
    const stg = settles.find((v) => num(v.amount_total) != null && num(v.amount_cash) != null)
    if (stg) {
      insurance = r2(num(stg.amount_total) - num(stg.amount_cash))
      insuranceFrom = 'settlement'
    }
  }

  // 区间一致性：票面自带住院起止时，与住院段起止比对（出院日允许缺省）
  const withRange = mine.filter((v) => isDateStr(v.service_from))
  const rangeMismatch = withRange.some((v) => {
    const fromBad = isDateStr(stay.start) && v.service_from < stay.start
    const toBad = isDateStr(stay.end) && isDateStr(v.service_to) && v.service_to > stay.end
    return fromBad || toBad
  })

  let state = 'derived'
  let residual = null
  if (system > total + 0.01) {
    state = 'over'
  } else if (insurance != null) {
    residual = r2(total - system - insurance)
    state = Math.abs(residual) <= 0.01 ? 'closed' : 'residual'
  }

  return {
    ...base,
    insurance,
    insuranceFrom,
    derivedInsurance: insurance == null ? r2(total - system) : null,
    residual,
    rangeMismatch,
    state,
  }
}

// 全局汇总（费用页顶部三张卡用）：票面合计 / 统筹 / 现金 / 未归属数 / 待核对段数
export function summarizeInvoices(invoices = [], stays = []) {
  const all = invoices || []
  // 结算单不进「票据合计」（与票据是同一笔钱，相加即翻倍）；单独计数即可
  const list = all.filter((v) => (v.doc_kind || 'invoice') === 'invoice')
  const settlementCount = all.length - list.length
  const total = r2(sum(list.map((v) => num(v.amount_total) ?? 0)))
  const cash = r2(sum(list.map((v) => num(v.amount_cash) ?? 0)))
  const insAll = list.map((v) => num(v.amount_insurance))
  const insurance = insAll.length && insAll.every((x) => x != null) ? r2(sum(insAll)) : null
  const orphan = all.filter((v) => !v.stay_id && v.category === 'inpatient').length
  const unlinked = all.filter((v) => !v.stay_id).length
  const dups = all.filter((v) => v.dup_of).length
  const reconciles = (stays || []).map((s) => reconcileStay(s, all))
  const pending = reconciles.filter((r) => ['over', 'residual', 'no-invoice'].includes(r.state)).length
  const mismatched = reconciles.filter((r) => r.rangeMismatch).length
  return { count: list.length, settlementCount, total, cash, insurance, orphan, unlinked, dups, pending, mismatched, reconciles }
}

// 住院段是否有票（UI 用：无票段要提醒补票）
export function invoicesOfStay(stayId, invoices = []) {
  return (invoices || []).filter((v) => v && v.stay_id === stayId)
}

// ---------- 多页住院发票：页清单 ----------
// 一张住院发票 = 1 张「住院收费票据（电子）」页 + 0~N 页「医疗收费明细（电子）」。
// 存储口径（2026-10-28 重新设计，见 docs/cost-invoice-module-plan.md §6）：
//   inv.file        = 票据页原件（主件，兼容全部旧代码与旧数据）
//   inv.attachments = 明细页原件数组 [{ id, name, type, size, role:'detail', page_no, page_count }]
// 一页 = 一份 Blob（f_ 前缀，内容寻址去重）；PDF 多页文件不拆，整份当一页（`page_count` 记总页数）。
// 明细行（约 200 项）**不入库**（2026-10-21 拍板：化验已进 records、检查已进 docs、
// 用药已含在总额内），只留原件 + 底部「合计」用于交叉校验。
export function invoicePageFiles(inv) {
  const out = []
  // 票据页永远在第 1 位（它是主件，也是唯一有票号/金额的那一页）
  if (inv && inv.file && inv.file.id) {
    out.push({ role: 'invoice', file: inv.file, page_no: 1, page_count: Number(inv.file.page_count) || 1 })
  }
  const details = []
  for (const [i, a] of (Array.isArray(inv && inv.attachments) ? inv.attachments : []).entries()) {
    if (!a || !a.id) continue
    details.push({
      role: a.role || 'detail',
      file: a,
      page_no: Number.isFinite(Number(a.page_no)) ? Number(a.page_no) : null,
      page_count: Number.isFinite(Number(a.page_count)) ? Number(a.page_count) : null,
      _seq: i,
    })
  }
  // **页序按「第 x 页」排，不按导入顺序**：用户常常先拖第 2 页再拖第 1 页、
  // 或者隔天补中间缺的那页（实测就是这么用的）。没有页码的按导入顺序排在后面。
  details.sort((x, y) => {
    const px = x.page_no
    const py = y.page_no
    if (px != null && py != null && px !== py) return px - py
    if (px != null && py == null) return -1
    if (px == null && py != null) return 1
    return x._seq - y._seq
  })
  for (const d of details) out.push({ role: d.role, file: d.file, page_no: d.page_no, page_count: d.page_count })
  return out
}

// 页数 / 明细页数（列表徽标与「下载全部」用）
export function invoicePageCount(inv) {
  return invoicePageFiles(inv).length
}
export function invoiceDetailCount(inv) {
  return invoicePageFiles(inv).filter((p) => p.role === 'detail').length
}

// 票据展示名（下载文件名规范）：20261020_朝阳医院_3784.25_0020104754.pdf
// 医院名若来自 OCR 可能有错字，展示层只管可读；下载前用户可见可改。
// page 传入时按页加后缀（_明细2），保证「下载全部」时同一张票的各页不互相覆盖。
export function invoiceFileName(inv, ext, page) {
  const d = String((inv && (inv.issued_at || inv.service_to || inv.service_from)) || '').replace(/-/g, '')
  const hosp = String((inv && (inv.hospital_short || inv.hospital)) || '医院').replace(/[\\/:*?"<>|\s]/g, '')
  const amt = num(inv && inv.amount_total)
  const amtStr = amt == null ? '未知金额' : amt.toFixed(2)
  const no = normInvoiceNo((inv && inv.invoice_no) || '') || '无票号'
  const tail = no.length > 6 ? no.slice(-6) : no
  const suffix = page && page.role === 'detail' ? `_明细${page.page_no || ''}` : ''
  const e = ext || (inv && inv.file && inv.file.type === 'application/pdf' ? 'pdf' : 'jpg')
  return [d || '无日期', hosp, amtStr, tail + suffix].join('_') + '.' + e
}

// 住院天数（不含出院当天，与 cost.js / CostStayTable 同口径）：仅作对账展示用
export function stayDays(stay, today) {
  if (!stay || !isDateStr(stay.start)) return 0
  const end = isDateStr(stay.end) ? stay.end : isDateStr(today) ? today : new Date().toISOString().slice(0, 10)
  return Math.max(0, daysBetween(stay.start, end) - 1)
}

// 票面「住院天数」与区间推导天数是否一致（抽到才比；N10：区间推导为准）
export function daysMatchesStay(inv, stay) {
  const n = num(inv && inv.hospital_days)
  if (n == null) return null
  return n === stayDays(stay, inv && inv.issued_at)
}

// 供 UI 使用的 nextDay 透传（避免各组件重复 import 时漏掉边界日处理）
export { nextDay }
