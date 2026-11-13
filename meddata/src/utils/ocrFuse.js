// ===================== 多引擎识别 · 结果融合（纯函数，零 DOM 依赖） =====================
// 融合规则（评审定稿契约）：
//   1) 以主引擎（通常 local）结果为基准；其他引擎按 standard_code 只补「基准缺失」的项，
//      补入项标 _source: <engine>，其 _bbox 随点透传（AI 引擎无 bbox → 该行无 _bbox）。
//   2) 基准已有、其他引擎同 code 但值不同 → 不覆盖基准值，差异并列进 _conflicts.value:
//      [{ engine, val }]，UI 显 ⚠️ 角标，用户点击 Popover 选采纳后覆盖 value 并清 _conflicts。
//   3) 数值在容差内（绝对 0.01 或相对 0.5%，与 verify-report.mjs 同口径）视为一致，不进 conflicts。
//   4) 绝不自动改写数值（Bug 031 红线）：融合只增补与并列，永不修改基准值。
// 契约：
//   fuseEnginePoints(basePoints, others[]) → FusedPoint[]
//   others: [{ engine: string, points: Point[] }]
//   FusedPoint = Point & { _source?: string, _conflicts?: { value: [{engine, val}] }, _bbox?: {x,y,w,h}|null }

const numOf = (s) => {
  const m = String(s ?? '')
    .replace(/[,，]/g, '')
    .match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
// 数值等价（与 verify-report.mjs valEqual 同口径）；非数值则按字符串精确比较
const valueEq = (a, b) => {
  const na = numOf(a)
  const nb = numOf(b)
  if (na !== null && nb !== null) {
    const diff = Math.abs(na - nb)
    return diff <= 0.01 || diff / Math.max(1, Math.abs(na)) <= 0.005
  }
  return String(a ?? '').trim() === String(b ?? '').trim()
}

export function fuseEnginePoints(basePoints = [], others = []) {
  const byCode = new Map()
  const out = []
  for (const p of basePoints) {
    const key = p.standard_code || `__row_${p._row ?? out.length}`
    byCode.set(key, true)
    out.push({ ...p }) // 浅拷贝：后续写 _conflicts 不得污染调用方的基准数组（幂等红线）
  }
  for (const { engine, points = [] } of others) {
    for (const p of points) {
      const key = p.standard_code || `__row_${p._row ?? ''}`
      if (!key) continue
      if (byCode.has(key)) {
        // 基准已有该 code：值不同 → 并列进 _conflicts（不覆盖基准值）
        if (!p.value) continue
        const target = out.find((q) => (q.standard_code || `__row_${q._row}`) === key)
        if (!target || valueEq(target.value, p.value)) continue
        target._conflicts = target._conflicts || { value: [] }
        if (!target._conflicts.value.some((c) => c.engine === engine && c.val === p.value)) {
          target._conflicts.value.push({ engine, val: p.value })
        }
      } else {
        // 基准缺失：整点补入，标来源；AI 引擎无 bbox（其点本就无 _bbox，此处显式清掉防误导）
        byCode.set(key, true)
        out.push({ ...p, _source: engine, _bbox: engine === 'ai' ? null : p._bbox ?? null })
      }
    }
  }
  return out
}
