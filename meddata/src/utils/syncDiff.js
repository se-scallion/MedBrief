// ===================== 同步差异计算（纯函数，浏览器 / Node 共用） =====================
// 职责：把「当前 state」与「上次同步成功的快照」比对，产出仅含实际变动的 Changes。
// 不依赖 updated_at 是否存在（现状多数实体不写 updated_at），只用内容指纹。
//
// E3（关键）：fingerprint 必须是 canonical 序列化（递归键排序），否则对象键序不确定会
// 让每次 collectChanges 都判成「变了」→ 每次推全量 → 写放大原样复活。

import { SYNC_ENTITIES } from './mergeState.js'

// 与 data-server.mjs 的 META_KEYS 保持一致
export const META_KEYS = ['patient_meta', 'feverThresholds', 'typeCatalog', 'tempIrrelevantDrugs', 'customFields']

// 递归 canonical 序列化：对象键排序（任意深度），数组保持顺序（data_points 的顺序是语义）。
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

export function fingerprint(entity) {
  return canonical(entity)
}

// 轻量快照：每个实体 id → 内容指纹；meta 标量 → 内容指纹。仅存指纹，不存全量。
export function buildSnapshot(state) {
  const snap = { entities: {}, meta: {} }
  for (const key of SYNC_ENTITIES) {
    const list = Array.isArray(state[key]) ? state[key] : []
    const m = {}
    for (const item of list) {
      if (item && item.id != null) m[String(item.id)] = fingerprint(item)
    }
    snap.entities[key] = m
  }
  for (const k of META_KEYS) {
    snap.meta[k] = fingerprint(state[k])
  }
  return snap
}

// 产出增量 Changes：仅本次实际变动的 upserts / deletes + 被改动的 meta。
// prev 为 null（无快照，首次同步）时自然全量 upsert、零 deletes（不误删）。
export function diffState(prev, state) {
  const prevSnap = prev && prev.entities ? prev : { entities: {}, meta: {} }
  const changes = { upserts: {}, deletes: [], meta: {} }
  for (const key of SYNC_ENTITIES) {
    const list = Array.isArray(state[key]) ? state[key] : []
    const prevMap = prevSnap.entities[key] || {}
    const curMap = {}
    const ups = []
    for (const item of list) {
      if (!item || item.id == null) continue
      const id = String(item.id)
      const fp = fingerprint(item)
      curMap[id] = fp
      if (prevMap[id] !== fp) ups.push(item)
    }
    if (ups.length) changes.upserts[key] = ups
    for (const id of Object.keys(prevMap)) {
      if (!curMap[id]) changes.deletes.push({ entity: key, id })
    }
  }
  for (const k of META_KEYS) {
    const fp = fingerprint(state[k])
    if (fp !== (prevSnap.meta[k])) changes.meta[k] = state[k]
  }
  return changes
}
