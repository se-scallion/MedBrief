// ===================== 病情三维度 · 实体合并（纯函数）=====================
// 去重键：stream|code|analyte|specimen|date
//   —— 同一天同一流同一通道的重复抽取 → 原地更新（保留 id/created_at）；
//   —— 不同标本、不同转录本绝不互相覆盖（骨髓 MRD ≠ 外周血 MRD；P190 ≠ P210）。
// 用户手改（source.type==='manual' 或 flags 含 'manual'）是最高优先级：
//   后续任何自动抽取都不得覆盖它（与 records 的「手改不被机器覆盖」同一口径）。
// 本模块零依赖（不 import store），可在 node 单测里直接跑。

const dateOnly = (d) => String(d == null ? '' : d).slice(0, 10)

/** 去重键（导出便于单测与调试） */
export function pointKey(p) {
  if (!p) return ''
  return [p.stream || '', p.code || '', p.analyte || '', p.specimen || '', dateOnly(p.date)].join('|')
}

let seq = 0
function newId(now) {
  seq += 1
  return `dm_${now}_${seq}`
}

const isManual = (p) =>
  !!p && (p.source?.type === 'manual' || p.source?.track === 'user' || (p.flags || []).includes('manual'))

/**
 * 插入或更新一个点（不可变：返回新数组）
 * @param {Array} list 现有点
 * @param {Object} incoming 新点
 * @param {{now?:string, id?:string}} [opts] now 用于测试注入
 * @returns {Array} 新数组
 */
export function upsertPoint(list, incoming, opts = {}) {
  const arr = Array.isArray(list) ? list.slice() : []
  if (!incoming || !incoming.stream || !incoming.code || !incoming.date) return arr
  const now = opts.now || new Date().toISOString()
  const key = pointKey(incoming)
  const idx = arr.findIndex((p) => pointKey(p) === key)

  if (idx < 0) {
    const id = opts.id || incoming.id || newId(now)
    const point = {
      ...incoming,
      id,
      date: dateOnly(incoming.date),
      // 只有显式 verified:true 才算已确认；抽取候选默认未确认
      verified: incoming.verified === true,
      created_at: incoming.created_at || now,
      updated_at: now,
    }
    return [...arr, point]
  }

  const prev = arr[idx]
  // 手改点不被自动抽取覆盖
  if (isManual(prev) && !isManual(incoming)) return arr

  const next = {
    ...prev,
    ...incoming,
    id: prev.id,
    date: dateOnly(incoming.date || prev.date),
    created_at: prev.created_at || now,
    updated_at: now,
  }
  const out = arr.slice()
  out[idx] = next
  return out
}

/** 按 id 删除（不可变） */
export function removePoint(list, id) {
  const arr = Array.isArray(list) ? list : []
  return arr.filter((p) => p && String(p.id) !== String(id))
}

/** 把一组候选按去重键并入（顺序应用） */
export function upsertPoints(list, incomingList, opts = {}) {
  let out = Array.isArray(list) ? list : []
  for (const p of Array.isArray(incomingList) ? incomingList : []) {
    out = upsertPoint(out, p, opts)
  }
  return out
}

/** 某份报告的候选：全部标为未确认、来源记 doc（供确认面板使用） */
export function candidatesOfDoc(candidates, docId, track = 'ocr') {
  return (Array.isArray(candidates) ? candidates : []).map((c) => ({
    ...c,
    verified: false,
    source: { type: 'doc', doc_id: docId, track },
    flags: Array.isArray(c.flags) ? c.flags : [],
  }))
}
