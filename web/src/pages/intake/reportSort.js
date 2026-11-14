// 报告库的排序口径（纯函数，零依赖，可在 node 里直接测）
//
// 为什么单独抽出来：排序规则里有三条**不变量**，写在 JSX 里就只能靠肉眼验：
//   ① 点列头三态（升 → 降 → 取消），一次只按一列；取消后回到默认「日期 降」；
//   ② **缺失值恒排最后**——升序降序都一样。这条最容易被 antd `sorter` 破坏：
//      它把比较结果乘以方向，降序时缺值会翻到最前面冒充「最新」；
//   ③ 中文字符串用 `localeCompare(x, 'zh-Hans-CN')`（码点序会把「北京」排到「上海」后面）。
// 口径照 MedData `src/components/DataGrid.jsx:277-400`（那边是同一套三态 + 缺值末位）。

export const DEFAULT_SORT = { key: 'date', order: 'descend' }

/** 排序用的日期：报告日期优先，缺失退回**入库日期**（绝不写回 reportDate —— 那是临床事实） */
export const dateKeyOf = (r) => String(r?.reportDate || '').slice(0, 10) || String(r?.createdAt || '').slice(0, 10)

const rowCountOf = (r) => (Array.isArray(r?.rows) ? r.rows.length : 0)
const abnormalOf = (r) => (Array.isArray(r?.rows) ? r.rows.filter((x) => ['high', 'low', 'positive'].includes(x?.status)).length : 0)

/** 每个可排序列取值。type 用「显示出来的那串字」排，保证「看到的顺序」与「排出来的顺序」一致 */
export const SORT_VALUE = {
  date: dateKeyOf,
  hospital: (r) => String(r?.hospital || ''),
  type: (r) => String(r?._typeLabel || r?.reportType || r?.kind || ''),
  barcode: (r) => String(r?.barcode || ''),
  rows: rowCountOf,
  abnormal: abnormalOf,
}

const isMissing = (v) => v === '' || v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))

/**
 * @param {Array}  list  原始清单（不改原数组）
 * @param {{key:string, order:'ascend'|'descend'|null}} sort 排序状态；order 为 null = 取消 → 默认日期降序
 * @returns {Array} 排好序的新数组
 */
export function sortReports(list = [], sort = DEFAULT_SORT) {
  const arr = (Array.isArray(list) ? list : []).slice()
  const byDateDesc = (a, b) => dateKeyOf(b).localeCompare(dateKeyOf(a), 'zh-Hans-CN')
  const key = sort?.key || DEFAULT_SORT.key
  const order = sort?.order === 'ascend' || sort?.order === 'descend' ? sort.order : null
  if (!order) return arr.sort(byDateDesc)          // 取消排序 → 默认「日期 降」
  const value = SORT_VALUE[key] || dateKeyOf
  const dir = order === 'ascend' ? 1 : -1
  return arr.sort((a, b) => {
    const va = value(a); const vb = value(b)
    const ma = isMissing(va); const mb = isMissing(vb)
    if (ma && mb) return byDateDesc(a, b)          // 都缺 → 内部仍按日期降，避免顺序抖动
    if (ma) return 1                              // 缺值恒末位（不随方向翻转）
    if (mb) return -1
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir || byDateDesc(a, b)
    return String(va).localeCompare(String(vb), 'zh-Hans-CN') * dir || byDateDesc(a, b)
  })
}

/** 列头点击的三态循环：升 → 降 → 取消（取消即回默认日期降） */
export function nextSort(cur, columnKey) {
  if (!cur || cur.key !== columnKey || !cur.order) return { key: columnKey, order: 'ascend' }
  if (cur.order === 'ascend') return { key: columnKey, order: 'descend' }
  return { ...DEFAULT_SORT }
}
