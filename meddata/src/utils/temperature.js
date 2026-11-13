// ===================== 体温事件（纯函数，无 DOM 依赖，可 node 直连单测） =====================
// 体温作为 events 中 category:'temperature' 的新事件类型，复用 store 的
// addEvent/updateEvent/deleteEvent（由它们补 id / kind:'marker'），本模块只负责构造与判定。
//
// 事件形态：{ category:'temperature', date, time?, temp:Number, unit:'°C', note? }

export const TEMP_UNIT = '℃'

// 默认发烧阈值（℃）：≥ low 低热，≥ high 高热
export const DEFAULT_FEVER = { low: 37.3, high: 38.5 }

// 分级展示元数据（UI 徽标用）：语义色呼应「发烧」暖橙红
export const FEVER_META = {
  normal: { label: '正常', tone: 'slate' },
  low: { label: '低热', tone: 'amber' },
  high: { label: '高热', tone: 'red' },
}

// 体温数值合法范围（℃）
export const TEMP_MIN = 30
export const TEMP_MAX = 45

// 构造一条体温事件（新增或覆盖更新共用）。不生成 id / kind —— 由 store 的 addEvent 负责。
// temp 非有限数（NaN/空）→ 抛错，由调用方在录入校验时拦截，避免脏数据入库。
export function buildTempEvent({ date, time, temp, unit = TEMP_UNIT, note }) {
  const t = Number(temp)
  if (!date || !Number.isFinite(t) || t < TEMP_MIN || t > TEMP_MAX) {
    throw new Error('体温事件非法：需要合法日期与 30~45℃ 的体温数值')
  }
  const ev = { category: 'temperature', date, temp: t, unit }
  if (time) ev.time = String(time)
  if (note) ev.note = String(note)
  ev.text = tempText({ temp: t, unit: ev.unit, time: ev.time, note: ev.note })
  return ev
}

// 是否体温事件（严格按 category，避免把无 category 的历史标记当成体温）
export const isTempEvent = (e) => !!e && e.category === 'temperature'

// 发烧分级：'normal' | 'low' | 'high'
export function classifyFever(temp, thresholds = DEFAULT_FEVER) {
  const t = Number(temp)
  if (!Number.isFinite(t)) return 'normal'
  if (t >= thresholds.high) return 'high'
  if (t >= thresholds.low) return 'low'
  return 'normal'
}

// 取全部体温事件，按「日期 + 时刻」升序（同日时刻空者排前）
export function tempEventsOf(events = []) {
  return (events || [])
    .filter(isTempEvent)
    .slice()
    .sort((a, b) => {
      const ka = `${a.date} ${a.time || '00:00'}`
      const kb = `${b.date} ${b.time || '00:00'}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
}

// 体温事件展示文本（仿 composeMedText，保证导出/列表可读）
export function tempText({ temp, unit = TEMP_UNIT, time, note }) {
  const head = `体温 ${temp}${unit}${time ? ' ' + time : ''}`
  return note ? `${head} · ${note}` : head
}

// ===================== 时段 / 统计（纯函数，管理页与单测共用） =====================
const DAY = 86400000

// 体温事件 → 时间戳（本地时区解析，空时刻按 00:00）
export function tempTs(e) {
  return new Date(`${e.date} ${e.time || '00:00'}`).getTime()
}

const startOfDay = (ts) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 时段口径（写死）：今天 / 24H / 昨天 / 一周 / 全部。空体温数组返回 null 不崩。
// 今天·一周的 to 取 max(now, 末点)，避免末点早于当前时刻时右轴把未来空档露出来。
export function rangeOf(key, temps = [], now = Date.now()) {
  if (!temps.length) return null
  const tss = temps.map(tempTs).filter(Number.isFinite)
  if (!tss.length) return null
  const first = Math.min(...tss)
  const last = Math.max(...tss)
  const sod = startOfDay(now)
  switch (key) {
    case 'today':
      return { from: sod, to: Math.max(now, last) }
    case '24h':
      return { from: now - DAY, to: now }
    case 'yesterday':
      return { from: sod - DAY, to: sod - 1 } // 昨天 23:59:59.999
    case 'week':
      return { from: sod - 6 * DAY, to: Math.max(now, last) } // 含今天共 7 天
    case 'all':
      return { from: first, to: last }
    default:
      return { from: sod - 6 * DAY, to: Math.max(now, last) }
  }
}

// 按区间过滤（边界点包含）：from/to 由 rangeOf 给出，range 为空返回全量
export function filterByRange(temps = [], range) {
  if (!range) return temps.slice()
  return temps.filter((e) => {
    const ts = tempTs(e)
    return ts >= range.from && ts <= range.to
  })
}

// 时段统计：最高 / 最低 / 平均（保留 1 位）/ 发热次数（≥low 计一次，high 不重复）/ 最近一次 / 记录数
// 空数组全 null 不崩。latest 返回该事件本身（含 date/time/temp），便于 UI 直接展示。
export function statsOf(temps = [], thresholds = DEFAULT_FEVER) {
  if (!temps.length) {
    return { max: null, min: null, avg: null, feverCount: 0, latest: null, count: 0 }
  }
  const vals = temps.map((e) => Number(e.temp))
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  const sum = vals.reduce((a, b) => a + b, 0)
  const avg = Math.round((sum / vals.length) * 10) / 10
  const feverCount = temps.filter((e) => classifyFever(e.temp, thresholds) !== 'normal').length
  const latest = temps
    .slice()
    .sort((a, b) => tempTs(a) - tempTs(b))
    .pop()
  return { max, min, avg, feverCount, latest, count: temps.length }
}
