// ===================== 双端共用的实体级合并 =====================
// 局域网同步的核心：两台电脑都可能各自新增/修改/删除，整体覆盖必然丢数据，
// 所以同步的最小单位是「实体（一条记录 / 一个事件 / 一份归档…）」：
//   - 新增：并集（两端各自的都保留）
//   - 修改：同 id 取 updated_at 较新的一方（LWW）
//   - 删除：靠墓碑（tombstones）表达——否则「并集」会把另一台已删的实体复活
// 本文件被浏览器（apiStore.js 的同步流程）与数据服务（data-server.mjs）同时 import，
// 保证两端判定口径完全一致（纯函数，不得引用任何浏览器 API）。

export const SYNC_ENTITIES = ['records', 'events', 'docs', 'courses', 'drugPrices', 'stays', 'diseaseMetrics', 'invoices']

// 墓碑保留时长：过期后清理，避免无限增长（90 天足够覆盖任何一台电脑的离线时长）
export const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)

function tsOf(x) {
  return x && typeof x.updated_at === 'string' ? x.updated_at : ''
}

// 取较新的一方：都有时间戳比大小；只有一方有则取有的一方；都没有取前者（保持稳定）
function newer(a, b) {
  const ta = tsOf(a)
  const tb = tsOf(b)
  if (ta && tb) return ta >= tb ? a : b
  if (ta) return a
  if (tb) return b
  return a
}

// ---- 墓碑 ----

export function normalizeTombstones(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const t of list) {
    if (!t || !t.id || !t.entity) continue
    if (!SYNC_ENTITIES.includes(t.entity)) continue
    out.push({ entity: t.entity, id: String(t.id), deleted_at: t.deleted_at || new Date(0).toISOString() })
  }
  return out
}

// 墓碑并集：同一 (entity,id) 取 deleted_at 最新；顺带清理过期墓碑
export function mergeTombstones(a, b, now = Date.now()) {
  const map = new Map()
  for (const t of [...normalizeTombstones(a), ...normalizeTombstones(b)]) {
    const k = `${t.entity}|${t.id}`
    const prev = map.get(k)
    if (!prev || t.deleted_at > prev.deleted_at) map.set(k, t)
  }
  const out = []
  for (const t of map.values()) {
    const age = now - new Date(t.deleted_at).getTime()
    if (Number.isFinite(age) && age > TOMBSTONE_TTL_MS) continue // 过期丢弃
    out.push(t)
  }
  return out
}

// 墓碑是否命中某实体：墓碑时间 ≥ 实体最后修改时间 → 判定为已删除
export function isTombstoned(tombstones, entity, item) {
  const t = tombstones.find((x) => x.entity === entity && x.id === String(item && item.id))
  if (!t) return false
  const ut = tsOf(item)
  return !ut || t.deleted_at >= ut
}

// 服务端**完全不返回**某实体键时，保留本地数据（undefined ≠ []）。
// 事故（2026-10-21，费用模块上线当天）：新增 invoices 实体后，data-server 进程还是旧代码，
// readState() 只遍历它自己的 ENTITY_TABLES，不返回 invoices 键；而客户端 pull() 是
// replaceState(服务端 state) 整体替换 → DEFAULT_STATE.invoices=[] 生效 → **刚保存的发票被抹掉**，
// 用户看到的是「点保存→跳回→闪一下→发票没了」。根因不是保存逻辑，是「缺失被当成空」。
// 口径：只有「服务端明确返回了空数组」才算删除；键都没返回 = 服务端还不认识这个实体。
// 这类实体保持本地值并维持「未同步」，下次推送会重试（服务端重启后自动补齐）。
export function preserveUnsyncedEntities(remote, local, entities = SYNC_ENTITIES) {
  const out = { ...(remote || {}) }
  const tombed = new Set(
    normalizeTombstones((remote || {}).tombstones).map((t) => `${t.entity}|${String(t.id)}`)
  )
  // 字典类（typeCatalog / customFields）：按 code 并集，服务端同 code 优先。
  // 这两类不是数组实体，若不并集，pull 用 replaceState 整体替换就会把本地新增的
  // 报告类型 / 自定义项目（项目库）抹掉（2026-10-22 事故）。
  for (const key of ['typeCatalog', 'customFields']) {
    const mine = local && typeof local[key] === 'object' && !Array.isArray(local[key]) ? local[key] : {}
    const theirs = out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {}
    const union = { ...mine, ...theirs }
    if (Object.keys(union).length) out[key] = union
  }

  for (const key of entities) {
    const mine = Array.isArray(local && local[key]) ? local[key].filter((x) => x && x.id != null) : []
    if (!(key in out)) {
      if (mine.length) out[key] = mine
      continue
    }
    // 服务端明确返回空数组 ≠ 全被删：若本地的这些 id 在服务端没有墓碑，说明服务端"还没有"
    // 这批实体（新表从未推送过 / 换库 / 服务端旧代码只建表不写），不能当成删除。
    // 事故（2026-10-21 diseaseMetrics）：指标点在本地有 4 条、data-server 的 disease_metrics
    // 表刚建好还是空的 → 每次 pull 按"服务端为准"整体替换 → 本地指标点被空数组抹掉，
    // 且因 streamIngestedAt 已打标，backfill 不会再生成 → 用户看到"残留病监测全空"。
    // 口径与上面的"缺键"一致：只有墓碑才算删除；空数组 + 本地有货 + 无墓碑 → 保留本地、维持未同步，
    // 下次推送补齐（push 走 collectChanges，快照里没有这些 id 就必然带上）。
    const theirs = out[key]
    if (Array.isArray(theirs) && theirs.length === 0 && mine.length) {
      const alive = mine.filter((x) => !tombed.has(`${key}|${String(x.id)}`))
      if (alive.length) out[key] = alive
    }
  }
  return out
}

// ---- 状态合并 ----
// mergeState(base, incoming)：base 是「已有的一方」（服务端视角=服务端，客户端视角=本地），
// incoming 是「新来的一方」。除实体集合按 LWW 并集外：
//   - patient_meta / feverThresholds：标量配置，取 incoming（后写入者为准，语义等同 LWW）
//   - typeCatalog：按 code 并集（AI 动态发现的报告类型，谁发现都算数，互不覆盖）
//   - tempIrrelevantDrugs：并集（任一端把某药移出体温图即生效，避免"一端开了另一端又画出来"）
export function mergeState(base, incoming) {
  const a = isObj(base) ? base : {}
  const b = isObj(incoming) ? incoming : {}
  const tombstones = mergeTombstones(a.tombstones, b.tombstones)
  const out = { ...a, ...b } // 标量/未知字段：incoming 优先（保留新端新增的字段）

  for (const key of SYNC_ENTITIES) {
    const listA = Array.isArray(a[key]) ? a[key] : []
    const listB = Array.isArray(b[key]) ? b[key] : []
    const byId = new Map()
    for (const it of listA) {
      if (it && it.id != null) byId.set(String(it.id), it)
    }
    for (const it of listB) {
      if (!it || it.id == null) continue
      const k = String(it.id)
      const prev = byId.get(k)
      byId.set(k, prev ? newer(prev, it) : it)
    }
    out[key] = [...byId.values()].filter((it) => !isTombstoned(tombstones, key, it))
  }

  // 字典/数组类：并集而非覆盖
  out.typeCatalog = { ...(isObj(a.typeCatalog) ? a.typeCatalog : {}), ...(isObj(b.typeCatalog) ? b.typeCatalog : {}) }
  // 自定义指标（项目库 customFields）同样是 code→定义 的字典：必须并集，不能整体覆盖。
  // 事故（2026-10-22）：它既不在 SYNC_ENTITIES 也不是服务端 META_KEYS → 推送丢掉、拉取覆盖成本地空，
  // 表现就是「AI 识别出的新项目保存了、项目库里却没有」。这里并集 + 服务端 META_KEYS 落盘双管齐下。
  out.customFields = {
    ...(isObj(a.customFields) ? a.customFields : {}),
    ...(isObj(b.customFields) ? b.customFields : {}),
  }
  const drugsA = Array.isArray(a.tempIrrelevantDrugs) ? a.tempIrrelevantDrugs : []
  const drugsB = Array.isArray(b.tempIrrelevantDrugs) ? b.tempIrrelevantDrugs : []
  out.tempIrrelevantDrugs = [...new Set([...drugsA, ...drugsB])]

  out.tombstones = tombstones
  return out
}

// 是否已经没有差异（用于避免无意义的写盘 / 通知 UI）
export function stateFingerprint(state) {
  const s = isObj(state) ? state : {}
  const parts = SYNC_ENTITIES.map((k) => {
    const list = Array.isArray(s[k]) ? s[k] : []
    return `${k}:${list.length}:${list.map((it) => `${it && it.id}@${tsOf(it)}`).sort().join(',')}`
  })
  parts.push(`tomb:${(s.tombstones || []).map((t) => `${t.entity}|${t.id}@${t.deleted_at}`).sort().join(',')}`)
  return parts.join('|')
}
