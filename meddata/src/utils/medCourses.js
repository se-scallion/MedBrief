// ===================== 用药疗程聚合（纯函数，无 DOM 依赖，可 node 直连单测） =====================
// 背景：用药事件原是「日期 + 一段描述文字」的平铺记录，无法表达「同一个药在一段时间内剂量逐段变化」。
// 现改为「改量事件式」：一条事件 =「自 X 日起，药 Y 每日剂量改为 Z」，同药事件按日期自动聚合成疗程阶梯。
//
// —— 日期口径（全局唯一口径，UI 文案必须与之一致）——
// 1) 事件日期 = 变更**生效日（含当日）**：08-01 记「60mg」即 08-01 当天起按 60mg/日。
// 2) 某段的结束日 = 下一条事件生效日的前一天：08-01 记 60mg、08-05 记 40mg → 60mg 段为 08-01~08-04。
// 3) 最后一段无后续事件 → 开放态（to = null，UI 显示「至今」，表示仍在服用）。
// 4) 停药事件（stop）不产生剂量段，只把上一段截止到「停药生效日的前一天」，并把疗程置为「已停药」；
//    停药后再记剂量 → 同一疗程自然续接（不拆「疗程实例」，YAGNI）。
//
// —— 数据形态（扩展现有 events，不建新表、不做破坏性迁移）——
// 结构化用药事件：{ category:'medication', drug, dose, unit, stop?, text }
// 旧纯文本事件：  { category:'medication', text } → 分组 key 退化为 text，显示为「仅记录（未填剂量）」。

// 常用剂量单位（录入时联想；可手输其它单位）
export const MED_UNITS = ['mg', 'g', 'μg', '片', '粒', 'U', '万U', 'mL', '袋']

// 与 dictionary.js EVENT_CATEGORIES 中「用药」同色
export const MED_COLOR = '#3b82f6'

// ===================== 持续输注（剂量折算） =====================
// 连续输注类药（贝林妥）不直接填「每日剂量」，而是记配液与输注参数，由系统折算：
//   配后浓度(µg/mL) = 原液浓度 × 抽取体积 ÷ 配后总体积
//   每日剂量(µg/日) = 配后浓度 × 速率(mL/h) × 24
// 实测校准：原液 11.67 µg/mL、抽 0.32 mL + 52 mL 盐水、5.8 mL/h → 0.0714 µg/mL → 9.93 ≈ 10 µg/日；
//          大袋 0.84 mL + 135 mL 同样速率 → 10.04 µg/日（与手工折算一致）。
// 设计取舍：折算结果直接写进 dose（单位 µg），参数另存 infusion 仅用于编辑回填 ——
// 这样 buildSegments / 体温图 / 费用计算全部零改动，老事件（只有 dose）行为不变。
export const INFUSION_UNIT = 'μg'

export function infusionDose(inf = {}) {
  const s = Number(inf.stock)
  const d = Number(inf.draw)
  const b = Number(inf.bag)
  const r = Number(inf.rate)
  if (![s, d, b, r].every((n) => Number.isFinite(n) && n > 0)) return null
  const bagConc = (s * d) / b
  const daily = bagConc * r * 24
  if (!Number.isFinite(daily) || daily <= 0) return null
  return { bagConc: Math.round(bagConc * 1e4) / 1e4, daily: Math.round(daily * 100) / 100 }
}

// ===================== 基础工具 =====================

const pad = (n) => String(n).padStart(2, '0')

export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 本机今日（按本地时区，避免 toISOString 在 UTC+8 的凌晨算成前一天）
export function localToday() {
  return toISODate(new Date())
}

// 是否合法 'YYYY-MM-DD'（日期类工具统一口径，避免各处复制正则）
export const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))

// 取某日的前一天（'YYYY-MM-DD' → 'YYYY-MM-DD'），非法输入返回 null
export function prevDay(date) {
  if (!isDateStr(date)) return null
  const [y, m, d] = String(date).split('-').map(Number)
  return toISODate(new Date(y, m - 1, d - 1))
}

// 取某日的后一天
export function nextDay(date) {
  if (!isDateStr(date)) return null
  const [y, m, d] = String(date).split('-').map(Number)
  return toISODate(new Date(y, m - 1, d + 1))
}

// 闭区间天数（含首尾两天）
export function daysBetween(a, b) {
  if (!a || !b) return 1
  const [ay, am, ad] = String(a).split('-').map(Number)
  const [by, bm, bd] = String(b).split('-').map(Number)
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000) + 1
}

// 'YYYY-MM-DD' → 本地午夜时间戳（与 TrendChart/TempTrendChart 同口径，避免 UTC 差一天）。
// 统一上移到 medCourses，供分段/图表共用，杜绝各文件重复实现。
export function dateTs(d) {
  if (!isDateStr(d)) return NaN
  return new Date(`${d}T00:00:00`).getTime()
}

// 'HH:mm' → 当日毫秒偏移（与 TempTrendChart.timeOffset 同口径）。缺省/非法 → 0（退化为当天 00:00）
export function timeOffset(t) {
  const m = /(\d{1,2}):(\d{2})/.exec(t || '')
  if (!m) return 0
  return (Number(m[1]) * 60 + Number(m[2])) * 60000
}

// 事件的有效时间戳：日期 + 可选时刻。无时刻 → 当天 00:00（按天事件退化为日粒度）。
// 全仓分段/排序/图表都以它为准，从而支持「小时级」输注记录且旧数据零迁移。
export function eventTs(e) {
  if (!e) return NaN
  const d = dateTs(e.date)
  if (Number.isNaN(d)) return NaN
  return d + timeOffset(e.time)
}

// 药名归一化：折叠任意空白（含全角空格 \u3000、NBSP \u00a0）为单个普通空格并去首尾。
// 否则粘贴来的「贝林妥\u3000」与手输「贝林妥」会被当成两种药 → 体温叠图出现两条同名 series、浮层重复两行。
export const normDrug = (s) => String(s || '').replace(/\s+/g, ' ').trim()

// 分组 key：结构化事件取 drug，旧纯文本事件退化为 text（合并/重命名时只改 drug，原 text 保留）
export const medKey = (e) => normDrug(e && (e.drug || e.text))

// 展示/导出文本：结构化事件一律由此合成，保证 export.js 的 timeline_events 可读
export function composeMedText({ drug, dose, unit, stop }) {
  const name = normDrug(drug)
  if (stop) return `${name} 停药`
  if (dose != null && dose !== '') return `${name} ${dose}${unit || ''}/日`
  return name
}

// 判断是否用药事件：严格按 category === 'medication'，避免把无 category 的历史标记当成用药
export const isMedEvent = (e) => !!e && e.category === 'medication'

// 结构化剂量事件：有药名 + 有剂量数字 + 非停药；空串/NaN 视为无剂量（与 buildMedEvent 口径一致）
export function isDoseEvent(e) {
  return isMedEvent(e) && !!e.drug && e.stop !== true && e.dose != null && e.dose !== '' && Number.isFinite(Number(e.dose))
}

// 停药事件
export const isStopEvent = (e) => isMedEvent(e) && e.stop === true

// ===================== 分段与分组 =====================

// 升序事件流 → 剂量分段；停药事件不产生段，只把上一段截止到其生效日前一天
//
// 结束日（to）口径，两条来源按优先级：
// 1) 事件自带 end（用户在分段编辑里手工设定）→ 优先采用；
// 2) 否则按下一条事件生效日 − 1 推导；末段无后续事件 → null（开放态 = 至今）。
//
// 手工 end 会被夹取到 [from, 推导值] 闭区间（clamp 而非报错，模型即兜底）：
// - 上限（推导值=下一段生效日−1）：防止与下一段重叠；
// - 下限（from）：防止退化成负区间；
// - 区间内部若 end < 下一段生效日−1，则如实保留 → 段与段之间出现「间隔/空档」，
//   正是消炎药「断续服用（间接使用）」的表达方式。
export function buildSegments(entries = []) {
  // 按事件时间戳升序（同药事件可能带时刻，必须按精确时间排，不能只排日期）
  const list = [...(entries || [])].sort((a, b) => eventTs(a) - eventTs(b))
  const out = []
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    if (isStopEvent(e)) continue
    const from = e.date
    const fromTs = eventTs(e)
    const fromTime = e.time || ''
    const next = list[i + 1]
    // 下一段的「起始边界」与「自动推导终点」，按精度与类型分三种口径：
    //  - 带时刻的剂量：边界 = 其精确时刻，自动推导终点 = 其 date（连续输注，无空档）
    //  - 不带时刻的剂量（按天变更）：边界 = 其 date（显式 end 可延伸到换量当天，连续）；
    //      自动推导终点 = date − 1（保留「断续空档」语义，不回退）
    //  - 停药：药效最后一天 = 停药生效日 − 1（边界与推导一致）
    let derivedTo = null
    let derivedToTs = null
    let nextStartTs = null
    if (next) {
      if (isStopEvent(next)) {
        derivedTo = prevDay(next.date)
        derivedToTs = derivedTo ? dateTs(derivedTo) : null
        nextStartTs = derivedToTs
      } else if (next.time) {
        derivedTo = next.date
        derivedToTs = eventTs(next)
        nextStartTs = derivedToTs
      } else {
        derivedTo = prevDay(next.date)
        derivedToTs = derivedTo ? dateTs(derivedTo) : null
        nextStartTs = dateTs(next.date)
      }
    }

    let to = derivedTo
    let toTs = derivedToTs
    let toTime = derivedTo ? (next && next.time ? next.time : '') : ''

    if (isDateStr(e.end)) {
      // 显式「输完日」：
      //  - 早于本段起点 → 退化为起点（防负区间）；
      //  - 越过下一段起始边界 → 夹取到边界（防重叠，且保持连续衔接而非凭空空档）。
      //  关键修复：上限从旧版的「下一条.date − 1」改为「下一段起始边界」，
      //  从而让 7→8、8→9 这类连续多袋在「同一天/换量当天」如实衔接，不再被压回「隔天」。
      to = e.end
      toTime = e.endTime || ''
      toTs = dateTs(e.end) + timeOffset(toTime)
      if (toTs < fromTs) {
        to = from
        toTime = fromTime
        toTs = fromTs
      } else if (nextStartTs != null && toTs > nextStartTs) {
        if (next && next.time) {
          to = next.date
          toTime = next.time
        } else if (isStopEvent(next)) {
          to = prevDay(next.date)
          toTime = ''
        } else {
          to = next.date
          toTime = ''
        }
        toTs = nextStartTs
      }
    } else if (to != null && toTs != null && toTs < fromTs) {
      to = from // 同日重复事件（异常数据）不退化为负区间
      toTime = fromTime
      toTs = fromTs
    }
    out.push({
      id: e.id,
      from,
      to, // null = 至今（开放态）
      fromTs,
      toTs, // null = 至今（开放态）
      fromTime,
      toTime,
      dose: e.dose != null && Number.isFinite(Number(e.dose)) ? Number(e.dose) : null,
      unit: e.unit || '',
      entry: e,
    })
  }
  return out
}

// 某条用药事件在同药事件流里的「推导结束日」：与 buildSegments 推导分支同源（按时间戳），
// 但只针对单条、且可用新日期试算。返回值为日期字符串（编辑框的「结束日期」比对只看日期；
// 精确到时刻由 saveEdit 的「endTime 是否填写」判定是否落库）。
//  - 下一条带时刻 → 返回其 date（连续输注，无空档）
//  - 下一条不带时刻（按天） → 返回其 date − 1 天（保留断续空档语义）
// 没有下一条 → null（至今）。
export function derivedEndOf(events, id, date) {
  const me = (events || []).find((e) => e.id === id)
  if (!me || !isMedEvent(me)) return null
  const key = medKey(me)
  if (!key) return null
  // 试算起点：用传入的新日期（带本事件的时刻）；未传则用本事件自身时间戳
  const fromTs = date ? dateTs(date) + timeOffset(me.time) : eventTs(me)
  const next = (events || [])
    .filter((e) => isMedEvent(e) && e.id !== id && isDateStr(e.date) && medKey(e) === key)
    .sort((a, b) => eventTs(a) - eventTs(b))
    .find((e) => eventTs(e) > fromTs)
  if (!next) return null
  return next.time ? next.date : prevDay(next.date)
}

// 全部用药事件 → 按药分组的疗程（进行中优先，其次按开始日倒序）
// today 用于「未来停药事件」防御（Bug 080）：日期晚于今天的 stop 事件视为无效数据，直接忽略，
// 否则还在吃的药会被判成「已停药」并显示出未来的结束日。
export function groupMedCourses(events = [], today = localToday()) {
  const map = new Map()
  for (const e of events || []) {
    if (!isMedEvent(e)) continue
    const key = medKey(e)
    if (!key) continue
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(e)
  }
  const groups = []
  for (const [key, list] of map) {
    // 按事件时间戳升序（同日可能多条带时刻事件，必须按精确时间排，否则分段错乱）
    const entries = [...list]
      .sort((a, b) => eventTs(a) - eventTs(b))
      .filter((e) => !isStopEvent(e) || e.date <= today) // 未来停药事件无效（Bug 080）
    if (!entries.length) continue // 该药只有一条未来 stop（异常数据）→ 不产生疗程
    const last = entries[entries.length - 1]
    const stopped = isStopEvent(last)
    const segments = buildSegments(entries)
    const cur = segments.length ? segments[segments.length - 1] : null
    let lastUnit = ''
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].unit) {
        lastUnit = entries[i].unit
        break
      }
    }
    groups.push({
      key,
      drug: key,
      color: last.color || MED_COLOR,
      entries,
      segments,
      status: stopped ? 'stopped' : 'ongoing',
      start: entries[0].date,
      stopAt: stopped ? last.date : null,
      // end：已停药=停药事件生效日；进行中=末段若手工设了结束日则用它，否则 null（至今）
      end: stopped ? last.date : (cur && cur.to) || null,
      current: cur && cur.dose != null ? { dose: cur.dose, unit: cur.unit } : null,
      lastUnit,
    })
  }
  groups.sort((a, b) =>
    a.status === b.status ? (a.start < b.start ? 1 : a.start > b.start ? -1 : 0) : a.status === 'ongoing' ? -1 : 1
  )
  return groups
}

// 药名候选（隐式药品登记：由事件流派生，零新增持久化状态）
export function drugRoster(events = []) {
  return groupMedCourses(events)
    .map((g) => ({
      key: g.key,
      count: g.entries.length,
      start: g.start,
      // 停药课程：end 用「末次剂量日」(courseEndDay)，与卡片头 rangeText 口径一致，不显示成停药次日
      end: g.status === 'stopped' ? courseEndDay(g) : null,
      lastDate: g.entries[g.entries.length - 1].date,
      lastUnit: g.lastUnit,
      current: g.current,
      stopped: g.status === 'stopped',
    }))
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0))
}

// 同药「同日同时刻」是否已有记录（命中则更新，未命中则新增）。
// 时刻精度下：同日不同时刻视为不同事件（允许多次浓度升档）；同日无时刻（按天药）仍覆盖更新。
export function upsertTarget(events, { date, key, time }) {
  const k = normDrug(key)
  if (!date || !k) return null
  const t = time || ''
  return (events || []).find((e) => isMedEvent(e) && medKey(e) === k && e.date === date && (e.time || '') === t) || null
}

// ===================== 录入 / 编辑 =====================

// 构造一条用药事件（新增或覆盖更新共用），text 一律由 composeMedText 合成
// end = 该分段的「输完日」（可选，'YYYY-MM-DD'）；留空/非法 → null，表示「按下一条事件生效时刻推导」。
// endTime = 输完时刻（可选，'HH:mm'），仅当 end 合法时生效。
// end 只表示「本袋/本段用到哪天(时刻)」，与「停药」完全解耦（停药由 stop 控制）。
// packs = 本段【实耗包装数】（整支出库的针剂：用户实际开了几支/几只），可选。
//   命中即视为「财务口径的真值」：费用 = packs × 单价，不再用「剂量 × 天数 ÷ 含量」推算（避免小数支、
//   以及「显示 12 支却按 11.9983 支计费」这类显示/计费不同源）。留空 = 沿用剂量推算（零回退）。
//   三态语义（配合 updateEvent 浅合并）：数字 = 设定；null = 显式清除；undefined = 不动（保留原值）。
export function buildMedEvent({ date, drug, dose, unit, end, endTime, stop, time, color, infusion, packs }) {
  const name = normDrug(drug)
  const ev = { date, category: 'medication', color: color || MED_COLOR, drug: name }
  if (stop) {
    ev.stop = true
    ev.end = null // 停药事件不产生剂量段，结束日无意义，置空防残留
    if (packs !== undefined) ev.packs = null
  } else {
    ev.stop = false // 显式置否：updateEvent 是浅合并，停药改回剂量时若不覆盖会把 stop 留在事件上
    const dn = Number(dose)
    // 允许「空剂量」：旧纯文本/无剂量记录仅记药名（改名）时，dose 置 null 而非法 0
    if (dose == null || dose === '' || !Number.isFinite(dn) || dn < 0) {
      ev.dose = null
    } else {
      ev.dose = dn
      ev.unit = normDrug(unit)
    }
    // 显式置 null 而非省略键：updateEvent 是浅合并，省略会把上一次的 end/endTime 留在事件上（与 stop 同口径）。
    // 早于生效日等越界值不在这里纠正，统一交给 buildSegments clamp。
    if (isDateStr(end)) {
      ev.end = end
      if (endTime && /^\d{1,2}:\d{2}$/.test(endTime)) ev.endTime = endTime
    } else {
      ev.end = null
    }
    // 输注参数：显式写 null 才能配合 updateEvent 浅合并清掉上一次的取值（与 end / stop 同口径）
    ev.infusion = infusion && Object.keys(infusion).length ? { ...infusion } : null
    // 实耗包装数：只在调用方显式给出该键时才动它（undefined = 保留原值，见函数头三态语义）
    if (packs !== undefined) {
      const pk = Number(packs)
      ev.packs = packs == null || packs === '' || !Number.isFinite(pk) || pk <= 0 ? null : Math.round(pk * 10000) / 10000
    }
  }
  if (time) ev.time = time
  ev.text = composeMedText({ drug: name, dose: stop ? null : ev.dose, unit: stop ? '' : ev.unit, stop: !!stop })
  return ev
}

// 快速录入（MedDoseForm）提交时的落地载荷：命中同药同日同时刻 → 覆盖更新，否则新增。
// ★ 覆盖语义 = 「改这次填的东西」，不是「把没填的全清空」：没填「输完日」时沿用原记录的输完日。
// 否则用户只想改个剂量，重新提交一次就把该段的结束日抹掉，段被下一条推导接管（与 Bug 219 同源）。
export function doseSubmitPayload(events, { date, time, drug, dose, unit, end, endTime, infusion, packs } = {}) {
  const key = normDrug(drug)
  if (!key || !date) return { hit: null, payload: null }
  const hit = upsertTarget(events, { date, key, time })
  const isRange = !!end && end >= date
  const range = isRange
    ? { end, endTime }
    : hit && isDateStr(hit.end)
      ? { end: hit.end, endTime: hit.endTime } // 沿用原输完日（含时刻），不把结束日抹掉
      : {}
  // 实耗包装数同口径：本次没填 → 沿用原记录的（改剂量不该把「实耗几支」抹掉）
  const packsOut = Number(packs) > 0 ? Number(packs) : hit && Number(hit.packs) > 0 ? Number(hit.packs) : undefined
  const payload = buildMedEvent({
    date,
    drug: key,
    dose,
    unit,
    ...range,
    time,
    infusion,
    ...(packsOut !== undefined ? { packs: packsOut } : {}),
    ...(hit ? { color: hit.color } : {}),
  })
  return { hit, payload }
}

// 段编辑表单的回填值（纯函数，UI 只负责 setState）。
// ★ 口径（Bug 219）：一律取【事件真实值】entry.*；本疗程的裁剪区间（seg.from/seg.to）只用于 chip 展示，
// 绝不回填进表单 —— 否则「保存」会把疗程边界写成事件自己的 end。
// stockFallback：药品管理里的原液浓度（输注段未填浓度时自动带出），不影响 end/date 口径。
export function segmentEditForm(course = {}, entry = {}, { stockFallback = null } = {}) {
  const infusion = entry.infusion ? { ...entry.infusion } : { stock: '', draw: '', bag: '', rate: '' }
  const stockAuto = !!(entry.infusion && (!infusion.stock || infusion.stock === '') && stockFallback != null)
  if (stockAuto) infusion.stock = String(stockFallback)
  return {
    stockAuto,
    init: {
      date: entry.date || '',
      time: entry.time || '',
      end: entry.end || '', // 事件真实结束日；空 = 未设（按下一条记录推导）
      endTime: entry.endTime || '',
      drug: entry.drug || course.key || entry.text || '',
      dose: entry.dose != null ? String(entry.dose) : '',
      packs: entry.packs != null ? String(entry.packs) : '', // 实耗包装数（真值，非推算）
      unit: entry.unit || course.lastUnit || '',
      note: entry.note || '',
      infusion,
      infusionOn: !!entry.infusion,
    },
  }
}

// 重命名 / 合并同药 → 补丁列表（UI 遍历调 updateEvent）
// 口径：结构化事件改写 drug 并重算 text；旧纯文本事件只补 drug 归属，原 text 保留（不抹用户原话）
export function planRename(events, fromKey, toKey) {
  const from = normDrug(fromKey)
  const to = normDrug(toKey)
  if (!from || !to || from === to) return []
  return (events || [])
    .filter((e) => isMedEvent(e) && medKey(e) === from)
    .map((e) => {
      const structured = !!e.drug && (e.stop === true || e.dose != null)
      return structured
        ? { id: e.id, patch: { drug: to, text: composeMedText({ drug: to, dose: e.dose, unit: e.unit, stop: e.stop }) } }
        : { id: e.id, patch: { drug: to } }
    })
}

// ===================== 展示辅助 =====================

// 升降方向：升 up（绿）/ 降 down（琥珀）/ 持平 flat / 无可比前段 null
export function arrowOf(prev, next) {
  if (prev == null || next == null) return null
  if (next > prev) return 'up'
  if (next < prev) return 'down'
  return 'flat'
}

// 日期展示：同年压缩为 MM-DD，跨年时 forceYear 传 true 显示完整日期
export function fmtD(date, forceYear = false) {
  const s = String(date || '')
  if (!s) return ''
  return forceYear ? s : s.slice(5)
}

// 日期+时刻展示：带时刻显示「MM-DD HH:mm」，无时刻退化为 fmtD（仅日期）。
// 跨年时 forceYear 传 true 显示完整日期。供分段 chip / 阶梯 title 等统一口径。
export function fmtDT(date, time, forceYear = false) {
  const d = fmtD(date, forceYear)
  if (!d) return ''
  return time ? `${d} ${time}` : d
}

// 某段占的天数（开放段按今天计）
export function segmentDays(seg, today = localToday()) {
  const to = seg.to || (seg.from > today ? seg.from : today)
  return Math.max(1, daysBetween(seg.from, to))
}

// 疗程末日（阶梯条总跨度用）：已停药 → 停药生效日前一天（即末次剂量日）；同日剂量+停药等异常形态夹紧到 start，避免退化
// 未停药但末段手工设了结束日 → 疗程就到那天为止（不再按 today 兜底成「至今」），
// 这样「断续服用完后停掉」的表现与阶梯条、体温图一致。
export function courseEndDay(course, today = localToday()) {
  if (course.stopAt) {
    const end = prevDay(course.stopAt) || course.stopAt
    return end < course.start ? course.start : end
  }
  const last = course.segments && course.segments.length ? course.segments[course.segments.length - 1] : null
  if (last && last.to) return last.to < course.start ? course.start : last.to
  return course.start > today ? course.start : today
}

// 疗程总天数（阶梯条按此分配各段宽度）
export function courseDays(course, today = localToday()) {
  return Math.max(1, daysBetween(course.start, courseEndDay(course, today)))
}

// ===================== 治疗疗程（顶层时间轴分段）裁剪 =====================
// 疗程 = 治疗阶段（诱导 / 巩固 / 维持），只记起始日，结束由下一疗程起始日推导（见 cost.courseRanges）。
// 用药事件【不挂 courseId】：同药的完整时间线按疗程区间裁剪即可 —— 跨疗程持续用药（如泼尼松从诱导
// 吃到巩固）自动连续出现在两个疗程里，无需在疗程边界重复录一条同剂量事件，也无需破坏性迁移。

// 把若干剂量段裁剪到 [from, to]（日期粒度；to = null 表示开放到「至今」）。
// 返回新段数组（与区间无交集 → []）。被裁掉的边界时刻一并去掉（那一头不属于本疗程）。
export function clipSegmentsToRange(segments = [], from, to, today = localToday()) {
  if (!isDateStr(from)) return []
  const out = []
  for (const s of segments || []) {
    if (!isDateStr(s.from)) continue
    const sTo = s.to || today // 开放段（至今）按今天计
    const a = s.from > from ? s.from : from
    const b = to ? (sTo < to ? sTo : to) : sTo
    if (a > b) continue
    const keepFromTime = a === s.from
    const keepToTime = b === sTo
    // 原段开放且疗程也开放（最后一个疗程）→ 仍视作开放，界面显示「至今」
    const openEnd = s.to === null && !to && b >= today
    out.push({
      ...s,
      from: a,
      to: openEnd ? null : b,
      fromTs: dateTs(a) + (keepFromTime ? timeOffset(s.fromTime) : 0),
      toTs: openEnd ? null : dateTs(b) + (keepToTime ? timeOffset(s.toTime) : 0),
      fromTime: keepFromTime ? s.fromTime : '',
      toTime: keepToTime && !openEnd ? s.toTime : '',
    })
  }
  return out
}

// 本疗程内「有关的」用药事件：有段落在本疗程显示者（含从上一疗程延续进来的段——其事件日期可早于疗程首日）
// + 落在疗程区间内的停药事件（停药不产生段，但属于本疗程的事实）。
// 只给 UI 做「本疗程范围内」的读写；跨疗程的全量在 allEntries。
export function entriesInRange(entries = [], segments = [], range = {}) {
  const ids = new Set((segments || []).map((s) => s.id))
  const start = range && range.start
  const end = range && range.end
  return (entries || []).filter(
    (e) => ids.has(e.id) || (isStopEvent(e) && isDateStr(start) && e.date >= start && (!isDateStr(end) || e.date <= end))
  )
}

// 按疗程分组：疗程 → 疗程内的药 → 该药在本疗程区间内的剂量段（无段的药不出现）。
// 返回对象保留原 course 的全部字段（status / start / stopAt…），只把 segments 换成裁剪后的，
// 这样卡片头的「进行中 / 已停药」等语义仍来自完整时间线，不会因裁剪而失真。
//
// ★ 安全默认（Bug 219）：phased 卡上的 entries 只承载【本疗程内】的事件，全量放到 allEntries。
// 否则任何从 entries 取数的代码（首段剂量预填 / 删除 / 停药…）都会静默跨疗程 ——
// 「编辑」曾因此把 2026-09-04 的 7.79µg 预填进 贝林妥*12 卡（该疗程实际是 10-17 起的 26µg）。
// 需要药级（整条时间线）操作时必须显式读 allEntries：漏写只会多出一个按钮，不会静默改错数据。
// range 一并挂在药上，供 UI 判断「首段起于本疗程内 / 延续自上一疗程」。
export function groupCoursesByPhase(courses = [], ranges = [], today = localToday()) {
  return (ranges || []).map((range) => {
    const drugs = []
    for (const c of courses || []) {
      const segments = clipSegmentsToRange(c.segments, range.start, range.end, today)
      if (!segments.length) continue
      drugs.push({ ...c, segments, entries: entriesInRange(c.entries, segments, range), allEntries: c.entries, range })
    }
    return { range, drugs }
  })
}

// 卡头「编辑」在 phased 卡上应该编辑哪一条（纯函数：UI 只渲染，不自行推导作用域）。
// - 首个可见段起于本疗程内 → 段编辑（所见即所改，写的就是那一条事件）
// - 首个可见段是从上一疗程延续来的（entry.date < range.start）→ 不能段编辑：
//   它改的是上游事件，会同时改上一个疗程的显示。改为预填表单、在疗程首日新建一条改量事件。
// - 非 phased → 整条记录编辑（药级，与旧版行为一致）
export function editTarget({ phased = false, range = null, segments = [] } = {}) {
  if (!phased) return { mode: 'course', entryId: null, prefill: null }
  const seg = (segments || [])[0]
  if (!seg || !seg.entry) return { mode: 'none', entryId: null, prefill: null }
  const start = range && range.start
  if (isDateStr(start) && isDateStr(seg.entry.date) && seg.entry.date < start) {
    return { mode: 'newFromRangeStart', entryId: null, prefill: { date: start, dose: seg.dose, unit: seg.unit } }
  }
  return { mode: 'segment', entryId: seg.id, prefill: null }
}
