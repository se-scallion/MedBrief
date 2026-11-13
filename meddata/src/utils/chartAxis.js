// ===================== 图表时间轴（本地时区，单一实现）=====================
// ECharts time 轴按 UTC 解析 'YYYY-MM-DD'，而浮层/日期 key 用本地时区 → 会差一天。
// 所有图表统一走这里：TrendChart（CBC 走势）与 StreamChart（病情三流）共用同一份。
// 只放纯函数，零依赖，可被 node 单测引用。

export const pad2 = (n) => String(n).padStart(2, '0')

/** YYYY-MM-DD[ HH:mm] → 本地午夜时间戳（time 轴坐标值） */
export const toTs = (d) => new Date(`${String(d == null ? '' : d).slice(0, 10)}T00:00:00`).getTime()

/** 时间戳 → 本地 YYYY-MM-DD（与 byDate 的 key 一致，供 tooltip 回查记录） */
export const fmtLocal = (ts) => {
  const t = new Date(ts)
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`
}
