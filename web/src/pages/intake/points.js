// MedBrief rows ⇄ MedData DataGrid points 的唯一映射（v0.6 实施第 1 段）。
//
// 2026-11-16 前：这两份函数在 ReportsPanel.jsx:39-55 里本地定义；录入面要挂 DataGrid 时
// 若复制一份，改一处漏一处必然漂移（审核 v0.6 R5/F6）。故抽成共用模块，**逐字搬**。
//
// 形状差异：MedBrief 存 {name,value,unit,refRange,flag,code}；
// DataGrid 用 {standard_code,original_name,value,unit,ref_range,arrow,_row,_item_no,_source}。
// 医疗红线（r3 B）：DataGrid 的「智能补项」会加出「有单位/区间但 value=''」的推测行，
// 必须保留 `_source:'inferred'` 标记，供入库前过滤，绝不让空值行进患者库。

export const toPoints = (rows = []) => (rows || []).map((r, i) => ({
  _row: i,
  _item_no: i + 1,
  standard_code: r.code || '',
  original_name: r.name || '',
  value: r.value ?? '',
  unit: r.unit || '',
  ref_range: r.refRange || '',
  arrow: r.flag === 'high' ? '↑' : r.flag === 'low' ? '↓' : '',
  ...(r.inferred ? { _source: 'inferred' } : {}),
}))

export const fromPoints = (points = []) => (points || []).map((p) => ({
  name: p.original_name || p.name || '',
  value: p.value ?? '',
  unit: p.unit || '',
  refRange: p.ref_range || '',
  code: p.standard_code || '',
  // r3 B：保留推测行标记；saveReport 入库前据此 + 空 value 一起过滤
  ...(p._source === 'inferred' || p.inferred ? { inferred: true } : {}),
}))

/** 入库前护栏：空 value 不入患者库（定性结果「阴性/未检出」value 非空，不受影响）。 */
export const filterEmptyValueRows = (rows = []) => {
  const kept = (rows || []).filter((r) => String(r.value ?? '').trim() !== '')
  return { rows: kept, dropped: (rows || []).length - kept.length }
}
