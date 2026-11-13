// ===================== 报告页（检验 + 检查合并）共用筛选 =====================
// 检验记录（records：数值指标）与检查报告（docs：原件 + 叙述文本）字段不同，但「找东西」的
// 两个维度是共通的：谁（文本）· 什么时候（日期区间）。故把这两层筛选提到公共模块，
// 报告页对两个库同时套用同一份条件，tab 上的数字就是「该类命中多少条」。
//
// 单一来源约束：这里的匹配/区间判定是唯一实现，列表组件不再各自维护一份搜索谓词
// （否则两处谓词一漂移，tab 计数就和列表内容对不上）。

import dayjs from 'dayjs'
import { reportTypeLabel } from '../data/dictionary.js'

// 时间区间档位：按「今天往前推」算，不依赖数据里的最大日期（数据断了也能照常筛）
export const DATE_RANGES = [
  { key: 'all', label: '全部时间', months: null },
  { key: '3m', label: '近3个月', months: 3 },
  { key: '1y', label: '近一年', months: 12 },
  { key: '3y', label: '近三年', months: 36 },
]

export const DATE_RANGE_KEYS = DATE_RANGES.map((r) => r.key)

/** 归一化 URL 里的区间参数（非法值一律回落 all） */
export function normalizeRange(v) {
  return DATE_RANGE_KEYS.includes(v) ? v : 'all'
}

/** 日期是否落在区间内；缺日期（老数据）在「全部时间」之外的档位一律不计入 */
export function inDateRange(dateStr, rangeKey = 'all') {
  const months = DATE_RANGES.find((r) => r.key === rangeKey)?.months
  if (!months) return true
  const d = dayjs(String(dateStr || '').slice(0, 10))
  if (!d.isValid()) return false
  return !d.startOf('day').isBefore(dayjs().subtract(months, 'month').startOf('day'))
}

/** 报告时间锚点：采集/检查日期（date）为主，缺则退到 checked_at / reported_at */
const dateOf = (x) => x?.date || x?.checked_at || x?.reported_at || ''

// 检验记录的检索面：日期 + 报告类型 + 备注 + 指标名/标准代码
export function recordHaystack(r) {
  return [
    r.date,
    r.checked_at,
    r.reported_at,
    reportTypeLabel(r.report_type),
    r.notes,
    ...(r.data_points || []).map((p) => `${p.name || ''} ${p.standard_code || ''}`),
  ]
    .join(' ')
    .toLowerCase()
}

// 检查报告的检索面：类型/标题/部位/日期 + 所见/结论/备注 + 测量值
// （raw_text 全文已迁至 IndexedDB，不进列表数据，故只覆盖轻量索引字段）
export function docHaystack(d) {
  return [
    d.doc_type,
    d.title,
    d.part,
    d.date,
    d.reported_at,
    d.findings,
    d.conclusion,
    d.notes,
    ...(d.measures || []).map((m) => `${m.name}${m.value}${m.unit}`),
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * 对两类报告同时套用「文本 + 日期区间」筛选。
 * @param {any[]} records 检验记录
 * @param {any[]} docs 检查报告
 * @param {{query?: string, range?: string}} cond
 * @returns {{records: any[], docs: any[]}} 命中后的两个列表（保持原顺序，排序由各列表自己负责）
 */
export function filterReports(records = [], docs = [], { query = '', range = 'all' } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const hit = (dateStr, hay) =>
    inDateRange(dateStr, range) && (!q || hay.includes(q))
  return {
    records: records.filter((r) => hit(dateOf(r), recordHaystack(r))),
    docs: docs.filter((d) => hit(dateOf(d), docHaystack(d))),
  }
}
