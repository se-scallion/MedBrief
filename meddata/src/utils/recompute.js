// ===================== 用留档材料重算（不重跑 OCR）=====================
//
// 目的（零隔离版第 3 步）：算法/字典升级后，让「已经导入过的那条记录」立刻用新规则重算，
// 用户不必重传图、也不必重跑 OCR。
//
// 关键事实（决定实现方式）：
//  · 映射层（dictionary / reportCatalog / 单位归一）是**纯函数**：同一份 grid 进 → 同一份 points 出。
//    所以补丁一生效，重算就是毫秒级，且结果 == "现在重新导入一次"（设计稿附录 F.2）。
//  · 解析层（ocr.js 的双栏/聚类/切格）改了才需要重建 grid —— 留档 items 就是为了这个
//    （ImportFlow → emitTrace 已存 token 文本 + 坐标，见附录 J）。
//  · 引擎层（vision/mineru/AI）改了**必须重跑引擎**，那是 reRecognizeRecord 的活，不在本文件。
//
// 纪律：本文件只产出"候选结果"（与 reRecognizeRecord 同形状），落库必须经
// ReRecognizeRecordModal 的逐项采纳 —— 绝不整表覆盖用户手改的值。

import { buildGridFromItems } from './ocr.js'
import { reRecognizeRecordWithGrid } from './reRecognize.js'

/**
 * 从 trace 快照取 grid。
 *
 * 默认 **prefer:'rawGrid'** —— 那是导入时真正用的那张表，映射层（字典/别名/目录/单位）重算时
 * 保真度最高，且不引入重建误差。
 * 只有解析层（双栏判定/行聚类/切格）升级时，才该用 prefer:'items' 从留档 token 重建；
 * 重建结果若有大量"名字列空行"，说明重建不可靠 → 自动退回 rawGrid（宁可少算，不算错）。
 *
 * @param {any} snapshot trace 快照
 * @param {{ prefer?: 'rawGrid'|'items' }} opts
 * @returns {{ grid:any[], source:'items'|'rawGrid'|'none', items:any[], note?:string }}
 */
export function gridFromTrace(snapshot, { prefer = 'rawGrid' } = {}) {
  const snap = snapshot || {}
  const rawGrid = Array.isArray(snap.rawGrid) ? snap.rawGrid : []
  const items = Array.isArray(snap.items)
    ? snap.items.filter((it) => it && it.text && Number.isFinite(it.x) && Number.isFinite(it.y))
    : []

  const rebuild = () => {
    if (!items.length) return null
    try {
      const grid = buildGridFromItems(items)
      if (!Array.isArray(grid) || !grid.length) return null
      // 保真度闸：数据行里名字列空的比例过高 → 重建不可靠（实测合成 token 会产出空名行）
      const dataRows = grid.filter((r) => Array.isArray(r) && r.some((c) => String(c || '').trim()))
      const emptyName = dataRows.filter((r) => !String(r[0] || '').trim()).length
      if (dataRows.length && emptyName / dataRows.length > 0.5) return null
      return grid
    } catch {
      return null
    }
  }

  if (prefer === 'items') {
    const g = rebuild()
    if (g) return { grid: g, source: 'items', items }
    if (rawGrid.length) return { grid: rawGrid, source: 'rawGrid', items, note: 'items 重建不可靠，已退回 rawGrid' }
    return { grid: [], source: 'none', items }
  }

  if (rawGrid.length) return { grid: rawGrid, source: 'rawGrid', items }
  const g = rebuild()
  if (g) return { grid: g, source: 'items', items }
  return { grid: [], source: 'none', items }
}

/**
 * 用留档材料对一条化验记录重算，产出与 reRecognizeRecord 同形状的结果对象。
 *
 * @param {any} record 现有记录（需含 data_points；不强求 id）
 * @param {any} snapshot trace 快照（logs/ocr-<traceId>.json 的 snapshot）
 * @returns {any} { skipped } 或 { rows, nextPoints, diffCount, ... }
 */
export function recomputeRecordFromTrace(record, snapshot, { prefer = 'rawGrid' } = {}) {
  const rec = record || {}
  if (!Array.isArray(rec.data_points) || !rec.data_points.length) return { skipped: 'no-points' }
  const snap = snapshot || {}
  const { grid, source, items } = gridFromTrace(snap, { prefer })
  if (!grid.length) return { skipped: 'no-material' }
  const res = reRecognizeRecordWithGrid(
    {
      grid,
      items,
      date: snap.collectedAt || rec.date || '',
      time: rec.time || '',
      reportedAt: snap.reportedAt || rec.reported_at || '',
    },
    rec,
  )
  // 标记来源，供 UI 显示「毫秒重算（解析层：items / 映射层：rawGrid）」而不是「重新识别」
  return { ...res, recomputed: true, materialSource: source }
}
