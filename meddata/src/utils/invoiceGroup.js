// ===================== 多页住院发票：把「N 份文件」分组为「M 张票」 =====================
// 一次住院的凭证形态（用户 2026-10-28 提出，实测两套样本都长这样）：
//   1 张「北京市医疗住院收费票据（电子）」= 发票页（票号/开票日/金额/支付构成）
//   + 0~N 页「医疗收费明细（电子）」     = 明细页（200 项左右，底部有「合计」与「第 x 页 共 y 页」）
// 旧实现把每份文件当一张独立的票：明细页同样有分类名+金额 → 被解析成「另一张票」，
// 库里于是出现了票号缺失、金额等于总额的幽灵票；而真正的票据页只有一张时，
// 医院名/票号那一次没认出来就永远空着（用户 08-25 那次的症状）。
//
// 本模块只做**纯函数**分组判定（无 DOM、无 store、无 OCR），导入页与单测共用：
//   分组键 = 票号（code|no）。明细页自己带「所属电子票据号码」，天然能对上它的票据页。
// 口径（沿用既有拍板，改这里前先读 docs/cost-invoice-module-plan.md §6）：
//   ① 一张票 = 一条 invoices 记录，明细页只作**原件附件**，不进明细表（2026-10-21 拍板）；
//   ② 明细页的「合计」只用于与票面总额交叉校验，不一致就黄标，绝不覆盖票面；
//   ③ 明细页能补上票据页缺的票号/医院名（补到已有发票），但绝不覆盖用户已填的值。

import { normInvoiceNo } from './invoice.js'

// 分组键：票号优先（同一次住院的票据页与明细页都印同一个号）
export function pageGroupKey(fields = {}, role = 'invoice') {
  const code = normInvoiceNo(fields.invoice_code || fields.owner_invoice_code)
  const no = normInvoiceNo(fields.invoice_no || fields.owner_invoice_no)
  if (code || no) return `${code}|${no}`
  return ''
}

// 库内已有发票的索引（分组键 → 发票）
export function existingIndex(invoices = []) {
  const map = new Map()
  for (const v of invoices || []) {
    if (!v || v.dup_of) continue
    const k = normInvoiceNo(v.invoice_code) + '|' + normInvoiceNo(v.invoice_no)
    if (k !== '|') map.set(k, v)
  }
  return map
}

// 兜底认领：票号缺失的历史记录（用户 08-25 那条就是「票号空 + 医院空」）无法按票号对上，
// 但明细页的「合计」等于票面总额，开票日期也对得上 —— 唯一命中时才给建议，绝不瞎配。
export function findExistingByAmount(detailFields = {}, invoices = []) {
  const amt = Number(detailFields && detailFields.total)
  if (!Number.isFinite(amt) || amt <= 0) return null
  const day = String((detailFields && detailFields.issued_at) || '')
  const hits = (invoices || []).filter((v) => {
    if (!v || v.dup_of) return false
    const a = Number(v.amount_total)
    // 严格到「分」：这是推断，宁可认不出让用户手点，也不能认错一张票
    if (!Number.isFinite(a) || Math.round(a * 100) !== Math.round(amt * 100)) return false
    // 两边都有开票日期就必须一致（缺一边则不卡，交给用户确认）
    if (day && v.issued_at && v.issued_at !== day) return false
    return true
  })
  return hits.length === 1 ? hits[0] : null
}

const byPageNo = (a, b) => {
  const pa = Number(a && a.page_no)
  const pb = Number(b && b.page_no)
  if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb
  return 0
}

/**
 * 分组主函数。
 * @param items [{ key, name, role, fields }]  role 取自 invoiceParse.classifyPageText
 * @param opts.existing 库内已有发票（用于「补到已有发票」）
 * @returns {{ groups: Group[], warnings: string[] }}
 *   Group = {
 *     id, kind, mainIndex, detailIndexes[], duplicateIndexes[],
 *     fields, key, existingId, pendingNew,
 *     detailTotal, totalCheck, note, warnings[]
 *   }
 */
export function groupInvoicePages(items = [], opts = {}) {
  // role:'skip' = 用户把这一页「移出本批」（导入页的 − 按钮）。仍然占着 items 下标，
  // 但不能进任何分组——否则被移出的页会以「未识别」组的形态复活。
  const list = (items || []).map((it, i) => ({ ...it, index: i })).filter((it) => it.role !== 'skip')
  const existing = existingIndex(opts.existing || [])
  const groups = []
  const warnings = []
  const byKey = new Map()

  // ---- ① 票据页各自成组；同票号的两张票据页并组（重复扫描）----
  for (const it of list) {
    if (it.role !== 'invoice') continue
    const key = pageGroupKey(it.fields, 'invoice')
    if (key && byKey.has(key)) {
      const g = byKey.get(key)
      g.duplicateIndexes.push(it.index)
      g.warnings.push(`「${it.name || '另一份'}」票号与「${list[g.mainIndex].name || '首份'}」相同，按同一张票处理`)
      continue
    }
    const g = {
      id: `g${groups.length + 1}`,
      kind: 'invoice',
      mainIndex: it.index,
      detailIndexes: [],
      duplicateIndexes: [],
      fields: it.fields || {},
      key,
      existingId: key && existing.has(key) ? existing.get(key).id : null,
      detailTotal: null,
      totalCheck: null,
      note: '',
      warnings: [],
    }
    if (!key) g.warnings.push('没认出票号：这张票无法自动查重，保存后请补票号')
    if (g.existingId) g.note = '库里已有同票号的发票，可覆盖原件或记为重复件'
    groups.push(g)
    if (key) byKey.set(key, g)
  }

  // ---- ② 明细页按「所属票号」归组；没有票号就挂到它前面最近的那张票 ----
  // 「前面」按文件选择顺序判：用户一次拖入时票据页通常在最前（实测两套样本都是），
  // 但绝不假设一定是第 1 份，所以按 index 找「index 更小的最后一个票据组」。
  const invoiceGroups = () => groups.filter((g) => g.kind === 'invoice' && g.mainIndex != null)
  const nearestPrevInvoice = (index) =>
    invoiceGroups().filter((g) => g.mainIndex < index).sort((a, b) => b.mainIndex - a.mainIndex)[0] || null
  for (const it of list) {
    if (it.role !== 'detail') continue
    const key = pageGroupKey(it.fields, 'detail')
    let target = key ? byKey.get(key) : null
    if (target) {
      target.detailIndexes.push(it.index)
      continue
    }
    // 库内已有该票号的发票 → 建「补到已有发票」组（这就是 08-25 那次的修复路径）
    if (key && existing.has(key)) {
      const v = existing.get(key)
      const g = {
        id: `g${groups.length + 1}`,
        kind: 'detail-only',
        mainIndex: null,
        detailIndexes: [it.index],
        duplicateIndexes: [],
        fields: {},
        key,
        existingId: v.id,
        detailTotal: null,
        totalCheck: null,
        note: '这些都是已有发票的明细页：并入后原件留档，并可补上该票缺的票号/医院名',
        warnings: [],
      }
      groups.push(g)
      byKey.set(key, g)
      continue
    }
    // 票号对不上：看是否能用「合计 + 开票日」唯一认领到库里某张历史票
    const byAmt = findExistingByAmount(it.fields, opts.existing || [])
    if (byAmt) {
      const g = {
        id: `g${groups.length + 1}`,
        kind: 'detail-only',
        mainIndex: null,
        detailIndexes: [it.index],
        duplicateIndexes: [],
        fields: {},
        key: '',
        existingId: byAmt.id,
        detailTotal: null,
        totalCheck: null,
        note: `明细合计 ${byAmt.amount_total} 与库里「${byAmt.issued_at || '无日期'} · 票号 ${byAmt.invoice_no || '—'}」一致，按金额认领（请确认）`,
        warnings: [],
      }
      groups.push(g)
      continue
    }
    // 无票号：挂到顺序上最近的前一张票据页
    const near = nearestPrevInvoice(it.index) || invoiceGroups()[0] || null
    if (near) {
      near.detailIndexes.push(it.index)
      near.warnings.push(`「${it.name || '明细页'}」没印所属票号，按顺序并入本张票，请核对`)
    } else {
      const g = {
        id: `g${groups.length + 1}`,
        kind: 'detail-only',
        mainIndex: null,
        detailIndexes: [it.index],
        duplicateIndexes: [],
        fields: {},
        key: '',
        existingId: null,
        detailTotal: null,
        totalCheck: null,
        note: '只有明细页：请补上对应的票据页，或把它并到已有发票上',
        warnings: [],
      }
      groups.push(g)
      warnings.push('有一页明细没有对应的票据页')
    }
  }
  // ---- ③ 结算单 / 无法判定：各自成组，交给用户填 ----
  for (const it of list) {
    if (it.role === 'invoice' || it.role === 'detail') continue
    const key = it.role === 'settlement' ? pageGroupKey(it.fields, 'settlement') : ''
    groups.push({
      id: `g${groups.length + 1}`,
      kind: it.role === 'settlement' ? 'settlement' : 'unknown',
      mainIndex: it.index,
      detailIndexes: [],
      duplicateIndexes: [],
      fields: it.fields || {},
      key,
      existingId: key && existing.has(key) ? existing.get(key).id : null,
      detailTotal: null,
      totalCheck: null,
      note: it.role === 'settlement' ? '医保结算单' : '没认出这是发票还是明细，请手填',
      warnings: [],
    })
  }

  // ---- ④ 每组的明细页按页码排序 + 合计交叉校验 ----
  for (const g of groups) {
    g.detailIndexes.sort((a, b) => byPageNo(list[a].fields, list[b].fields) || a - b)
    const totals = g.detailIndexes.map((i) => list[i].fields && list[i].fields.total).filter((x) => x != null)
    g.detailTotal = totals.length ? Math.max(...totals) : null
    g.totalCheck = checkDetailTotal(g.fields && g.fields.amount_total, g.detailTotal)
    // 明细页的页码信息（第 x 页 共 y 页）用于提示「明细缺页」
    const counts = g.detailIndexes.map((i) => list[i].fields && list[i].fields.page_count).filter((x) => Number.isFinite(x))
    const expect = counts.length ? Math.max(...counts) : null
    g.detailExpect = expect
    if (expect && g.detailIndexes.length < expect) g.warnings.push(`明细页应有 ${expect} 页，当前只有 ${g.detailIndexes.length} 页`)
  }

  return { groups, warnings }
}

// 明细合计 vs 票面总额：ok=true 一致 / false 不一致 / null 缺项（缺项不算错，N9 同口径）
export function checkDetailTotal(invoiceTotal, detailTotal) {
  const a = Number(invoiceTotal)
  const b = Number(detailTotal)
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) return null
  // 按「分」比，避免 12118.01 vs 12118.02 这类浮点误差把 1 分差判成不一致
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 1
}

// 「补到已有发票」时要写回已有记录的补丁（只补空值，绝不覆盖用户已填内容）
export function patchFromDetailPages(inv = {}, group = {}, detailFieldsList = [], opts = {}) {
  const patch = {}
  if (!inv.invoice_no) {
    const no = (detailFieldsList.map((f) => f && f.owner_invoice_no).filter(Boolean)[0]) || ''
    if (no) patch.invoice_no = no
  }
  if (!inv.invoice_code) {
    const code = (detailFieldsList.map((f) => f && f.owner_invoice_code).filter(Boolean)[0]) || ''
    if (code) patch.invoice_code = code
  }
  if (!inv.hospital) {
    const r = opts.hospital || null
    if (r && r.hospital) {
      patch.hospital = r.hospital
      if (r.raw && r.raw !== r.hospital) patch.hospital_raw = r.raw
    }
  }
  if (!inv.service_from && group.fields && group.fields.service_from) patch.service_from = group.fields.service_from
  if (!inv.service_to && group.fields && group.fields.service_to) patch.service_to = group.fields.service_to
  if (group.totalCheck === false) patch.detail_note = `明细合计 ${group.detailTotal} 与票面总额不一致`
  return patch
}
