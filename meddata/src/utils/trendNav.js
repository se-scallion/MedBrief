// ===================== 「查看趋势」统一跳转 =====================
// 所有定量指标的趋势目前都聚合在 /cbc（CBCDetailView：数据驱动分组，按 STANDARD_FIELDS.group
// 动态生成卡片 + 锚点 id=`grp-<group>`）。因此「查看趋势」无论哪类报告，目标都是 /cbc，
// 区别只在于滚到哪个分组锚点。本文件把这层「记录 → 目标分组」的解析收敛到一处，避免三处列表
// 各写一遍跳转逻辑、且解决了旧 gotoChart「吞掉 date、一律滚到概览 CBC 总图」的缺陷。

import { FIELD_BY_CODE } from '../data/dictionary.js'

const toNum = (v) => {
  const n = parseFloat(v)
  return Number.isNaN(n) ? null : n
}

// 趋势页路由（全定量指标的唯一承载页）
export const TREND_ROUTE = '/cbc'

// 记录是否含有可画趋势（定量数值）的指标：至少一个数据点数值可解析且其 code 在标准字典内。
// 纯定性报告（血型、部分阴性的感染/真菌判定等）无数值点 → 没有趋势图，应隐藏按钮。
export function hasTrend(record) {
  const pts = record?.data_points || []
  return pts.some((p) => FIELD_BY_CODE[p.code] && toNum(p.value) != null)
}

// 记录归属的趋势分组（标准字典 group 名，如 血常规 / 肝功能 / 肾功能 / 离子 …），与
// CBCDetailView 的 grp-<group> 锚点一一对应。取第一个「有数值」指标的所属分组；无匹配返回 null。
export function trendGroupFor(record) {
  for (const p of record?.data_points || []) {
    if (FIELD_BY_CODE[p.code] && toNum(p.value) != null) {
      return FIELD_BY_CODE[p.code].group
    }
  }
  return null
}

// 统一跳转：记录 → /cbc，并平滑滚动到对应分组锚点。
// 通过 location.state.expandGroup 让目标分组在 /cbc 挂载后默认展开（否则折叠组只显示表头、
// 看不到图）；navigate 后再延时滚动，确保跨路由渲染完成、锚点元素已存在。
export function gotoTrendNav({ navigate, record }) {
  const group = trendGroupFor(record)
  navigate(TREND_ROUTE, group ? { state: { expandGroup: group } } : undefined)
  const anchor = group ? `grp-${group}` : null
  setTimeout(() => {
    const el = anchor ? document.getElementById(anchor) : null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, 250)
}
