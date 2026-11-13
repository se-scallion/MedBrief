// ===================== 疗程与费用计算（纯函数，无 DOM，可 node 直连单测） =====================
// 口径（全局唯一，UI 文案必须与之一致）：
// 1) 疗程只记起始日：结束 = 下一疗程起始日 − 1，最后一个疗程 = 至今（end 不落库，实时推导）。
// 2) 药品价格只记生效日 from：结束 = 同药下一条价格 from − 1，最后一条 = 至今。
//    同一天只会有一条生效价格，天然无缝无重叠。
// 3) 每日药费 = 每日剂量折算出的片数 × 当时生效单价；剂量单位本就是「片/粒/袋」时直接 剂量 × 单价。
// 4) 住院费 = 该段总额 ÷ 住院天数（出院日−入院日，不含出院当天，即实际住院天数）得到日均，再按区间重叠天数累加。
// 5) 未定价 / 缺规格的药不计入金额，但必须进 unpriced 清单由 UI 提示（绝不静默当 0）。

import {
  clipSegmentsToRange,
  daysBetween,
  groupMedCourses,
  isDateStr,
  localToday,
  nextDay,
  normDrug,
  prevDay,
  toISODate,
} from './medCourses.js'

// 计数单位：剂量即为每日片数，不需要规格折算
export const COUNT_UNITS = ['片', '粒', '袋', '支', '颗', '瓶', '盒', '贴', '包', '枚']
// 质量单位 → µg 换算系数（含量/剂量统一折算成 µg 再相除；μg = 1, mg = 1000, g = 1e6）
const MG_FACTOR = { mg: 1000, g: 1e6, μg: 1, ug: 1 }

export const isCountUnit = (unit) => COUNT_UNITS.includes(String(unit || '').trim())

// 把任意质量单位折算成 µg（含量与剂量统一量纲后再相除，消除「µg 剂量 ÷ mg 规格」差 1000 倍的 bug）
export function toMicrograms(value, unit) {
  const v = Number(value)
  if (!Number.isFinite(v)) return 0
  const f = MG_FACTOR[String(unit || '').trim()]
  return f ? v * f : 0
}

// 原液浓度（µg/mL）：含量(转µg) ÷ 体积(mL)；无体积(口服药) 返回 null
export function stockFromSpec(price) {
  if (!price) return null
  const vol = Number(price.volume)
  if (!Number.isFinite(vol) || vol <= 0) return null
  const ug = toMicrograms(price.content, price.contentUnit)
  if (!ug) return null
  return ug / vol
}

// 规格展示串：口服药「10mg/片」；针剂「35µg/只·3ml/只」
export function formatSpec(price) {
  if (!price) return ''
  const parts = []
  if (price.content != null && price.content !== '') parts.push(`${price.content}${price.contentUnit || 'mg'}/${price.pkgUnit || ''}`)
  if (price.volume != null && price.volume !== '') parts.push(`${price.volume}ml/${price.pkgUnit || ''}`)
  return parts.join('·')
}

// ===================== 疗程区间 =====================

// 疗程 → 带 end 的归集区间列表。结束日口径（用户 2026-09-19 定）：
// 1) 可手工填 end = 疗程最后一天（含当天）；留空 = 进行中。
// 2) 之后还有疗程 → 结束 = max(填的 end, 下一疗程 start − 1)：两个疗程之间的空档期
//    【并入前一个疗程】（用户选择），保证花费连续不漏。
// 3) 最后一个疗程（后面没有疗程）→ 结束 = 填的 end，没填则 null（至今）。
//    这也是「填结束日」的价值：填了就不会无限算到今天。
// ownEnd 保留用户填的原文，供 UI 显示「标注结束」与编辑回填。
export function courseRanges(courses = [], today = localToday()) {
  const list = (courses || [])
    .filter((c) => isDateStr(c.start))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  return list.map((c, i) => {
    const next = list[i + 1]
    let own = isDateStr(c.end) && c.end >= c.start ? c.end : null // 非法 / 早于开始日 → 忽略
    let end = own
    if (next && isDateStr(next.start)) {
      const fill = prevDay(next.start) // 空档填补到下一疗程前一天
      if (fill && (!end || fill > end)) end = fill
    }
    // 异常数据（下一疗程不晚于本疗程 → 填补值早于开始日）夹紧到开始日，杜绝负区间
    if (end && end < c.start) end = c.start
    return {
      id: c.id,
      name: String(c.name || '').trim() || '疗程',
      start: c.start,
      end: end || null,
      ownEnd: own,
      note: c.note || '',
    }
  })
}

// ===================== 药品价格 =====================

// 某天某药生效的价格条目（取 from ≤ date 中最晚的一条）；无 → null
export function priceAt(prices = [], drug, date) {
  const key = normDrug(drug)
  let hit = null
  for (const p of prices || []) {
    if (normDrug(p.drug) !== key) continue
    if (!isDateStr(p.from) || p.from > date) continue
    if (!hit || p.from > hit.from) hit = p
  }
  return hit
}

// 把 [from, to] 按该药的价格有效期切成若干段（含「无价空档」段，price = null）。
// 用于同一段用药跨越改价点时分段计价（正版 140 → 仿制 30）。
export function priceSpans(prices = [], drug, from, to) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) return []
  const key = normDrug(drug)
  const mine = (prices || [])
    .filter((p) => normDrug(p.drug) === key && isDateStr(p.from))
    .sort((a, b) => (a.from < b.from ? -1 : 1))
  const spans = []
  let cur = from
  for (let i = 0; i < mine.length && cur <= to; i++) {
    const p = mine[i]
    const next = mine[i + 1]
    const pEnd = next && isDateStr(next.from) ? prevDay(next.from) : null
    if (pEnd && pEnd < cur) continue // 这一段价格在本区间之前就已失效
    const a = p.from > cur ? p.from : cur
    const b = pEnd ? (pEnd < to ? pEnd : to) : to
    if (a > b) continue
    if (a > cur) spans.push({ from: cur, to: prevDay(a), price: null }) // 生效前的无价空档
    spans.push({ from: a, to: b, price: p })
    cur = nextDay(b)
  }
  if (cur <= to) spans.push({ from: cur, to, price: null })
  return spans
}

// 某段用药在某天的日费用。算不出（无剂量 / 未定价 / 缺规格）→ amount 0 且带 reason，由调用方计入未定价提示。
export function dailyDrugCost(seg, price) {
  const dose = seg && seg.dose != null ? Number(seg.dose) : null
  if (dose == null || !Number.isFinite(dose) || dose <= 0) return { amount: 0, reason: 'no-dose' }
  if (!price) return { amount: 0, reason: 'no-price' }
  const priceNum = Number(price.price)
  if (!Number.isFinite(priceNum) || priceNum < 0) return { amount: 0, reason: 'no-price' }
  const unit = String(seg.unit || '').trim()
  if (isCountUnit(unit)) return { amount: dose * priceNum, tablets: dose }
  // 质量单位（mg/g/μg）：按量计费 —— 每日剂量(µg) ÷ 每包装含量(µg) × 单价（贝林妥 28µg÷35µg×9615≈7692 元/日）
  const doseUg = toMicrograms(dose, unit)
  const contentUg = toMicrograms(price.content, price.contentUnit)
  if (!doseUg || !contentUg) return { amount: 0, reason: 'no-content' }
  const vials = doseUg / contentUg
  return { amount: vials * priceNum, tablets: vials }
}

// ===================== 归集 =====================

// drugSegs: [{ drug, segments }]（segments 为全时间线，内部按 [from,to] 裁剪）
export function drugCostInRange(drugSegs = [], prices = [], from, to, today = localToday()) {
  const lines = []
  const unpriced = new Map()
  let total = 0
  const addUnpriced = (drug, reason) => {
    // 只在「该药已在药品管理登记过」时提示未计价——未登记的默认算住院/医保包含，不提示（自费药才需提示）
    if (!prices.some((p) => normDrug(p.drug) === normDrug(drug))) return false
    const set = unpriced.get(drug) || new Set()
    set.add(reason)
    unpriced.set(drug, set)
    return true
  }
  for (const g of drugSegs) {
    const segs = clipSegmentsToRange(g.segments, from, to, today)
    for (const seg of segs) {
      const segTo = seg.to || today
      // 实耗包装数（用户填的真值）：它是「整段」的用量，被价格区间/疗程区间切开时按天数比例分摊，
      // 分摊分母必须用【未裁剪】的原始段长，否则跨两个疗程时会多算/少算。
      const fullSeg = (g.segments || []).find((x) => x.id === seg.id) || seg
      const fullDays = Math.max(1, daysBetween(fullSeg.from, fullSeg.to || today))
      const manual = Number(fullSeg.entry && fullSeg.entry.packs)
      const manualPacks = Number.isFinite(manual) && manual > 0 ? manual : null
      for (const sp of priceSpans(prices, g.drug, seg.from, segTo)) {
        const d = daysBetween(sp.from, sp.to)
        if (manualPacks != null) {
          // 财务口径真值优先：金额 = 实耗包装数 × 当时的单价，与「剂量 × 天数 ÷ 含量」解耦。
          // 好处：① 整支出库的药能如实表达「实际开了 12 支」；② 显示支数与计费支数同源，
          //       不再出现「显示 12 支、实际按 11.9983 支算钱」的错位。剂量缺失（null）也能计价。
          const priceNum = sp.price ? Number(sp.price.price) : NaN
          if (!sp.price || !Number.isFinite(priceNum) || priceNum < 0) {
            addUnpriced(g.drug, 'no-price')
            continue
          }
          const packs = (manualPacks * d) / fullDays
          const sub = packs * priceNum
          total += sub
          lines.push({
            drug: g.drug,
            from: sp.from,
            to: sp.to,
            days: d,
            dose: seg.dose,
            unit: seg.unit || '',
            pkgUnit: sp.price.pkgUnit || '',
            price: sp.price.price,
            brand: sp.price.brand || '',
            sub,
            packs,
            packsSrc: 'manual', // 用户填的实耗数（真值）→ UI 据此标「实耗」
          })
          continue
        }
        const r = dailyDrugCost(seg, sp.price)
        if (r.reason) {
          addUnpriced(g.drug, r.reason)
          continue
        }
        // 该段用掉的包装数（只/片/支）= 每日用量 × 天数。
        // 整支出库（wholePack）：向上取整到整只/整瓶，余量弃用 —— 贝林妥 90µg÷35µg/只 → 3 只而非 2.57 只。
        // 减 1e-9 是必须的：浮点下 105/35 可能算成 3.0000000001，直接 ceil 会多进一位成 4。
        const packsRaw = (r.tablets || 0) * d
        const packs = sp.price.wholePack ? Math.ceil(packsRaw - 1e-9) : packsRaw
        // 金额按（取整后的）包装数计；wholePack 关闭时 packs×单价 与原 amount×天数 代数恒等 → 零回退
        const sub = packs * Number(sp.price.price)
        total += sub
        lines.push({
          drug: g.drug,
          from: sp.from,
          to: sp.to,
          days: d,
          dose: seg.dose,
          unit: seg.unit || '',
          pkgUnit: sp.price.pkgUnit || '',
          price: sp.price.price,
          brand: sp.price.brand || '',
          sub,
          packs,
          packsSrc: 'derived',
        })
      }
    }
  }
  return { total, lines, unpriced: [...unpriced].map(([drug, reasons]) => ({ drug, reasons: [...reasons] })) }
}

export function stayCostInRange(stays = [], from, to, today = localToday()) {
  const lines = []
  let total = 0
  const rangeTo = to || today
  for (const st of stays || []) {
    if (!isDateStr(st.start)) continue
    const sFrom = st.start
    const sEnd = isDateStr(st.end) ? st.end : today
    if (sEnd < sFrom) continue
    const amount = Number(st.total)
    if (!Number.isFinite(amount) || amount <= 0) continue
    // 实际住院天数 = 出院日 − 入院日（不含出院当天），与医院「住院天数」口径一致；
    // 用药段是「含首尾」（首日末日都给药），住院是「算间隔」，二者不可混用 daysBetween 的 +1。
    const days = daysBetween(sFrom, sEnd) - 1
    if (days <= 0) continue
    const daily = amount / days
    const a = sFrom > from ? sFrom : from
    // 重叠天数同样按「不含出院当天」口径：疗程结束日当天仍在院，故 end 取下一日的 00:00（半开区间）
    const bRaw = sEnd < rangeTo ? sEnd : rangeTo
    const bExcl = bRaw >= sEnd ? bRaw : nextDay(bRaw)
    if (a > bExcl) continue
    const overlap = daysBetween(a, bExcl) - 1
    const sub = daily * overlap
    total += sub
    lines.push({
      id: st.id,
      start: sFrom,
      end: isDateStr(st.end) ? st.end : null,
      days,
      daily,
      overlapDays: overlap,
      sub,
      total: amount,
      note: st.note || '',
    })
  }
  return { total, lines }
}

// 自然月区间（offset = -1 → 上月）
export function monthRange(anchor, offset = 0) {
  const [y, m] = String(anchor || '').split('-').map(Number)
  if (!y || !m) return null
  const d = new Date(y, m - 1 + offset, 1)
  return { from: toISODate(d), to: toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }
}

// 总花费起点：用药 / 住院 / 疗程中最早的一天（保证疗程开始前的花费也不漏）
function earliestDate(events, stays, courses, today) {
  const dates = []
  for (const e of events || []) if (isDateStr(e.date) && e.category === 'medication') dates.push(e.date)
  for (const s of stays || []) if (isDateStr(s.start)) dates.push(s.start)
  for (const c of courses || []) if (isDateStr(c.start)) dates.push(c.start)
  return dates.length ? dates.sort()[0] : today
}

function mergeUnpriced(lists = []) {
  const map = new Map()
  for (const l of lists) {
    for (const it of l || []) {
      const set = map.get(it.drug) || new Set()
      it.reasons.forEach((r) => set.add(r))
      map.set(it.drug, set)
    }
  }
  return [...map].map(([drug, reasons]) => ({ drug, reasons: [...reasons] }))
}

// 全量汇总：按疗程 / 上月 / 总计三个口径
export function summarizeCost({ events = [], courses = [], drugPrices = [], stays = [], today = localToday() } = {}) {
  const ranges = courseRanges(courses, today)
  const groups = groupMedCourses(events).map((c) => ({ drug: c.drug, key: c.key, segments: c.segments }))

  const byCourse = ranges.map((range) => {
    const drug = drugCostInRange(groups, drugPrices, range.start, range.end, today)
    const stay = stayCostInRange(stays, range.start, range.end, today)
    return {
      range,
      days: daysBetween(range.start, range.end || today),
      drugTotal: drug.total,
      stayTotal: stay.total,
      total: drug.total + stay.total,
      drugLines: drug.lines,
      stayLines: stay.lines,
      unpriced: drug.unpriced,
    }
  })

  const lm = monthRange(today, -1)
  const lmDrug = lm ? drugCostInRange(groups, drugPrices, lm.from, lm.to, today) : { total: 0, lines: [], unpriced: [] }
  const lmStay = lm ? stayCostInRange(stays, lm.from, lm.to, today) : { total: 0, lines: [] }

  const from = earliestDate(events, stays, courses, today)
  const tDrug = drugCostInRange(groups, drugPrices, from, today, today)
  const tStay = stayCostInRange(stays, from, today, today)

  return {
    today,
    ranges,
    byCourse,
    lastMonth: lm
      ? { ...lm, drugTotal: lmDrug.total, stayTotal: lmStay.total, total: lmDrug.total + lmStay.total, drugLines: lmDrug.lines, stayLines: lmStay.lines }
      : null,
    total: {
      from,
      to: today,
      drugTotal: tDrug.total,
      stayTotal: tStay.total,
      total: tDrug.total + tStay.total,
      drugLines: tDrug.lines,
      stayLines: tStay.lines,
    },
    unpricedDrugs: mergeUnpriced([...byCourse.map((c) => c.unpriced), lmDrug.unpriced, tDrug.unpriced]),
  }
}

// 把时间点条目（输血事件等）按疗程区间过滤：to = null 表示开放（至今，无上限）。
// from 非法（未建疗程等）→ 原样返回，不做静默丢弃。
export function itemsInRange(list = [], from, to, key = 'date') {
  if (!isDateStr(from)) return [...(list || [])]
  const end = to || '9999-12-31'
  return (list || []).filter((it) => {
    const d = it && it[key]
    return isDateStr(d) && d >= from && d <= end
  })
}

// 金额展示：千分位 + 两位小数
export function fmtMoney(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100
  const [i, d] = v.toFixed(2).split('.')
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d
}

// 用量展示：保留 2 位小数，整数不带小数点（8.06 只 / 34 片）
export function fmtPacks(n) {
  return String(Math.round((Number(n) || 0) * 100) / 100)
}

// 未定价原因 → 人话（UI 提示用，避免把缺失当 0 混进总额）
export const UNPRICED_LABEL = {
  'no-price': '未填单价',
  'no-content': '缺含量/规格',
  'no-dose': '无剂量',
}

// 明细展示：把「药 × 价格段」的多行合并成每药一行（天数/小计/用量求和，单价/剂量列出出现过的值）。
// segs 保留该药原始分段行，供 UI 在分多段时展开分段小行（剂量调整 / 改价都会切段）。
export function mergeDrugLines(lines = []) {
  const map = new Map()
  for (const l of lines || []) {
    const it =
      map.get(l.drug) || { drug: l.drug, days: 0, sub: 0, packs: 0, manualPacks: 0, segs: [], prices: new Set(), doses: new Set(), unit: l.unit || '', pkgUnit: l.pkgUnit || '' }
    it.days += l.days
    it.sub += l.sub
    it.packs += l.packs || 0
    if (l.packsSrc === 'manual') it.manualPacks += l.packs || 0
    it.segs.push(l)
    it.prices.add(Number(l.price))
    it.doses.add(`${l.dose}${l.unit || ''}`)
    map.set(l.drug, it)
  }
  return [...map.values()]
    .map((x) => ({
      drug: x.drug,
      days: x.days,
      sub: x.sub,
      packs: x.packs,
      manualPacks: x.manualPacks, // 其中来自「用户填的实耗支数」的部分（UI 据此标「实耗」）
      segs: x.segs,
      unit: x.unit,
      pkgUnit: x.pkgUnit,
      prices: [...x.prices],
      doses: [...x.doses],
    }))
    .sort((a, b) => b.sub - a.sub)
}

// 同药价格行的失效日（由下一条生效日推导；最后一条为 null = 至今）
export function priceExpiry(prices = [], row) {
  const key = normDrug(row && row.drug)
  const next = (prices || [])
    .filter((p) => normDrug(p.drug) === key && isDateStr(p.from) && p.from > row.from)
    .sort((a, b) => (a.from < b.from ? -1 : 1))[0]
  return next ? prevDay(next.from) : null
}
