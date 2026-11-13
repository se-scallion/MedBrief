// ===================== 数据源客户端（同步到项目机 SQLite） =====================
// 本地权威数据在 macbook 浏览器的 IndexedDB（store.js 的 stateDb）；本模块是「远程备份 / 双机共享」层。
// 默认开启（cfg.enabled=true）。开启后：拉 GET /api/state（服务端为准覆盖本地）、推 PUT /api/state。
// ⚠️ 同步时若服务端数据与本地不同步，会以服务端覆盖本地 IndexedDB。
// 断网时本地照常用，恢复后下一轮推送自动补上。

import { getState, replaceState, collectChanges, markSynced, resetSyncSnapshot } from '../data/store.js'
import { preserveUnsyncedEntities } from './mergeState.js' // 服务端没返回的实体键 ≠ 空（见该函数注释）

const CFG_KEY = 'meddata_data_source'
const PUSH_DEBOUNCE_MS = 800
const REQ_TIMEOUT_MS = 10000
const HEARTBEAT_MS = 30000

// 默认走同源 /api/data：由 Vite 代理转发到数据服务（DATA_SERVER 环境变量 / 设置页可改直连地址）。
// 不再出现硬编码 IP：跨机器时由设置页手填 http://<项目机IP>:8787/api，或部署机设 DATA_SERVER 环境变量。
function defaultBaseUrl() {
  return '/api/data'
}
const DEFAULT_CFG = { enabled: true, baseUrl: defaultBaseUrl(), token: '' }

let cfg = loadCfg()
let version = 0 // 最近一次拿到的服务端版本（"写前先拉"的依据）
let hydrated = false // 推送门：首次拉取完成前禁止任何推送
let pushTimer = null
let heartbeatTimer = null
let applyingRemote = false

const status = { state: 'off', lastSyncAt: '', version: 0, error: '', online: false }
// 服务端原件 id 清单（/state 与 /blobs 都会带）。列表徽标据此判断「引用有、库里没有」，
// 不必为每一行去取 blob。null = 还不知道（同步关闭 / 尚未拉取），此时不下任何结论。
let remoteBlobIds = null
const listeners = new Set()

function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) return { ...DEFAULT_CFG, ...JSON.parse(raw) }
  } catch {
    /* 配置损坏则用默认 */
  }
  return { ...DEFAULT_CFG }
}

export function getConfig() {
  return { ...cfg }
}

export function setConfig(patch) {
  const prevUrl = cfg.baseUrl
  cfg = { ...cfg, ...(patch || {}) }
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg))
  } catch {
    /* 忽略 */
  }
  // 切换数据源地址 → 旧快照失效，清空让下次 collectChanges 重新全量（不误删/不漏推）
  if (patch && patch.baseUrl && patch.baseUrl !== prevUrl) {
    resetSyncSnapshot()
  }
  notify()
  return getConfig()
}

export function getStatus() {
  return { ...status }
}

// 某原件 id 在服务端是否存在：true / false / null(=不知道)。null 时不要据此判"缺失"。
export function hasRemoteBlob(id) {
  if (!id) return null
  if (!cfg.enabled || !remoteBlobIds) return null
  return remoteBlobIds.has(String(id))
}

export function getRemoteBlobCount() {
  return remoteBlobIds ? remoteBlobIds.size : null
}

export function subscribe(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function notify() {
  status.version = version
  listeners.forEach((l) => l())
}

// 默认同源 /api（由 data-server 托管 dist 时开箱即用）；两台各自跑 dev 时填 http://<项目机IP>:8787/api
function apiBase() {
  const raw = (cfg.baseUrl || '/api').replace(/\/+$/, '')
  return raw
}

async function req(pathname, init = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  const headers = { ...(init.headers || {}) }
  if (cfg.token) headers['x-sync-token'] = cfg.token
  try {
    return await fetch(apiBase() + pathname, { ...init, headers, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// ---- 拉：服务端为准 ----
export async function pull() {
  if (!cfg.enabled) return null
  status.state = 'syncing'
  notify()
  try {
    const res = await req('/state')
    if (!res.ok) throw new Error(`拉取失败 ${res.status}`)
    const data = await res.json()
    const remote = data.state || {}
    if (Array.isArray(data.blobs)) remoteBlobIds = new Set(data.blobs.map((b) => String(b && b.id)))
    // ⚠ 不能用 remote 直接整体替换：服务端不认识的新实体（还没重启 data-server）根本不会出现在
    // remote 里，replaceState 会把本地已有数据清空（2026-10-21 invoices 事故）。见 mergeState
    // 的 preserveUnsyncedEntities 注释。快照仍用**服务端原始 remote**，这样本地独有实体保持
    // 「未同步」，下次推送会重试，服务端重启后自动补齐。
    const merged = preserveUnsyncedEntities(remote, getState())
    const unsyncedKeys = Object.keys(merged).filter((k) => !(k in remote))
    applyingRemote = true
    try {
      replaceState(merged)
      markSynced(remote) // 用服务端终态重建同步快照（仅指纹），持久化到 IndexedDB
    } finally {
      setTimeout(() => {
        applyingRemote = false
      }, 0)
    }
    if (unsyncedKeys.length) {
      // 只在首次告警 + 给一次延迟重试，避免与新实体推送形成风暴
      if (!warnedUnsynced) {
        console.warn(
          `[apiStore] 服务端未返回实体：${unsyncedKeys.join(', ')}（本地数据已保留，未同步）。` +
            '多半是 data-server 进程还是旧代码，重启后即可正常同步。'
        )
        warnedUnsynced = true
      }
      scheduleUnsyncedRetry()
    } else {
      clearUnsyncedRetry() // 服务端已认识全部实体 → 恢复正常
    }
    version = Number(data.version || 0)
    status.state = 'ok'
    status.online = true
    status.error = ''
    status.lastSyncAt = new Date().toISOString()
    hydrated = true
    notify()
    return remote
  } catch (e) {
    markError(e)
    hydrated = true // 连不上也要开门，否则本机永远无法写入（本地缓存仍可用）
    notify()
    return null
  }
}

// 服务端不认识某实体时（多半是 data-server 还是旧进程）：
//   - 只告警一次，别刷屏；
//   - 每 30s 重试推送一次，最多 20 次（10 分钟）—— 用户重启服务端后**自动**把积压实体补上去，
//     不需要他再动一次数据。全部实体都回来了就清零，恢复正常增量同步。
let warnedUnsynced = false
let unsyncedRetryTimer = null
let unsyncedTries = 0
const UNSYNCED_RETRY_MS = 30000
const UNSYNCED_MAX_TRIES = 20
function scheduleUnsyncedRetry() {
  if (unsyncedRetryTimer || unsyncedTries >= UNSYNCED_MAX_TRIES) return
  unsyncedRetryTimer = setTimeout(() => {
    unsyncedRetryTimer = null
    unsyncedTries += 1
    push().catch(() => {})
  }, UNSYNCED_RETRY_MS)
}
function clearUnsyncedRetry() {
  if (unsyncedRetryTimer) clearTimeout(unsyncedRetryTimer)
  unsyncedRetryTimer = null
  unsyncedTries = 0
  warnedUnsynced = false
}

// ---- 增量写：只提交 collectChanges 产出的实际变动 ----
async function putIncremental(changes, baseVersion) {
  const res = await req('/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes, baseVersion }),
  })
  if (!res.ok) throw new Error(`推送失败 ${res.status}`)
  const data = await res.json()
  version = Number(data.version || version)
  status.state = 'ok'
  status.online = true
  status.error = ''
  status.lastSyncAt = new Date().toISOString()
  notify()
  return data
}

// 整库写（fullSync：备份恢复 / 首次迁移 / 上传本机数据），保留「缺失即删」语义
async function putState(baseVersion) {
  const res = await req('/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // force 与服务端保险丝配对：仅当用户在设置页显式确认过（ackEmptyGuard）才携带，
    // 允许空客户端整库覆盖；未确认时空 state 会被服务端 409 拒绝。
    body: JSON.stringify({ state: getState(), baseVersion, force: emptyGuardAcked() || undefined }),
  })
  if (res.status === 409) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || '服务端拒绝整库覆盖（409）')
  }
  if (!res.ok) throw new Error(`推送失败 ${res.status}`)
  const data = await res.json()
  version = Number(data.version || version)
  status.state = 'ok'
  status.online = true
  status.error = ''
  status.lastSyncAt = new Date().toISOString()
  notify()
  return data
}

// 是否有任何实际变动（增量推送前判定，空变更就不打服务端）
function hasAnyChange(changes) {
  for (const k of Object.keys(changes.upserts || {})) {
    if ((changes.upserts[k] || []).length) return true
  }
  if ((changes.deletes || []).length) return true
  if (Object.keys(changes.meta || {}).length) return true
  return false
}

// ---- 推：先推本地增量，再拉服务端终态（顺序不能反，避免覆盖丢失）----
export async function push() {
  if (!cfg.enabled || !hydrated) return null
  const changes = collectChanges()
  // 空客户端保护：本地无实体却要删服务端数据 = 新 origin 的空端在宣布「全被删了」，拒绝
  if (localEntityCount() === 0 && (changes.deletes || []).length > 0 && !emptyGuardAcked()) {
    console.warn('[apiStore] 空客户端保护：本机无数据但本次变更含删除，已拦截推送（只允许拉取）。')
    await pull()
    return getState()
  }
  status.state = 'syncing'
  notify()
  try {
    if (hasAnyChange(changes)) {
      await putIncremental(changes, version)
    }
    await fillMissingBlobs() // E2：补传本地有、服务端缺的原件（断网期间新增的）
    await pull() // 拉取终态对齐 + 重建快照
    return getState()
  } catch (e) {
    markError(e)
    return null
  }
}

function markError(e) {
  status.state = 'error'
  status.online = false
  status.error = String((e && e.message) || e)
  notify()
}

function schedulePush() {
  if (!cfg.enabled || !hydrated || applyingRemote) return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    if (applyingRemote) return
    push()
  }, PUSH_DEBOUNCE_MS)
}

// ---- 原件 / 全文 ----
export async function putBlob(id, body, type, kind) {
  if (!cfg.enabled || !id) return false
  try {
    const res = await req(`/blob/${encodeURIComponent(id)}${kind === 'text' ? '?kind=text' : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'x-blob-type': type || 'application/octet-stream' },
      body,
    })
    return res.ok
  } catch {
    return false
  }
}

export async function getBlob(id, kind) {
  if (!cfg.enabled || !id) return null
  try {
    const res = await req(`/blob/${encodeURIComponent(id)}${kind === 'text' ? '?kind=text' : ''}`)
    if (!res.ok) return null
    return await res.blob()
  } catch {
    return null
  }
}

export async function delBlob(id) {
  if (!cfg.enabled || !id) return
  try {
    await req(`/blob/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch {
    /* 离线删除忽略，下次推送以列表缺失为准 */
  }
}

// ---- 首次自动迁移：本机旧数据 → 项目机（无需手动上传）----
const ENTITY_KEYS = ['records', 'events', 'docs', 'courses', 'drugPrices', 'stays']
const countEntities = (s) => ENTITY_KEYS.reduce((n, k) => n + ((s && s[k] && s[k].length) || 0), 0)

async function remoteIsEmpty() {
  try {
    const res = await req('/state')
    if (!res.ok) return false
    const data = await res.json()
    return countEntities(data.state || {}) === 0
  } catch {
    return false
  }
}

async function localHasData() {
  if (countEntities(getState() || {}) > 0) return true
  try {
    const { getAllDocFiles, getAllDocTexts, getAllRecordImages } = await import('./docFileStore.js')
    const [f, t, i] = await Promise.all([getAllDocFiles(), getAllDocTexts(), getAllRecordImages()])
    return f.length > 0 || t.length > 0 || i.length > 0
  } catch {
    return false
  }
}

// 补传原件：本地有、服务端缺的 id 才上传（不全量重传）。
// 服务端已删除的原件（墓碑）：服务端判定为重复副本/孤儿并删掉的 id。
// 为什么必须记：补传的判据是"服务端没有我就上传"，不看墓碑的话，一次同步就把服务端删掉的
// 223 份重复副本原样传回去（实测库从 21MB 涨回 84MB）。墓碑由服务端 /api/state 与 /api/blobs 下发。
const tombstonedBlobs = new Set()

export function noteTombstonedBlobs(list) {
  for (const id of list || []) if (id) tombstonedBlobs.add(String(id))
}

// 传入 remoteBlobs 则直接用；否则自取 /blobs（push() 路径）。
async function fillMissingBlobs(remoteBlobs) {
  const have = new Set((remoteBlobs || []).map((b) => String(b && b.id)))
  if (!remoteBlobs) {
    try {
      const r = await req('/blobs')
      if (r.ok) {
        const d = await r.json()
        for (const b of d.blobs || []) have.add(String(b.id))
        noteTombstonedBlobs(d.deleted)
      }
    } catch {
      /* 取远端 blob 列表失败则跳过补传，下次推送再试 */
    }
  }
  try {
    const { getAllDocFiles, getAllDocTexts, getAllRecordImages } = await import('./docFileStore.js')
    const [files, texts, images] = await Promise.all([getAllDocFiles(), getAllDocTexts(), getAllRecordImages()])
    const need = (id) => !have.has(String(id)) && !tombstonedBlobs.has(String(id))
    for (const f of files) {
      if (need(f.id)) await putBlob(f.id, f.blob, (f.blob && f.blob.type) || 'application/octet-stream')
    }
    for (const t of texts) {
      if (need(t.id)) await putBlob(t.id, t.text, 'text/plain', 'text')
    }
    for (const i of images) {
      if (need(i.id)) await putBlob(i.id, i.blob, (i.blob && i.blob.type) || 'application/octet-stream')
    }
  } catch {
    /* 原件补传失败不影响结构化数据 */
  }
}

// ---- 空客户端保护（2026-10-12 事故防呆）----
// 事故：换了访问地址（新 origin）→ 本地 IndexedDB 是空的 → 启动同步把「本地缺失」全生成为
// deletes 推给服务端，唯一数据源被反向清空。防线：本地无任何实体时，绝不推送 deletes——
// 只允许 pull（新端首次接入应当先「收养」服务端数据，而不是宣布它全被删了）。
const EMPTY_GUARD_KEY = 'meddata_empty_guard_ack'
function localEntityCount() {
  return countEntities(getState() || {})
}
function emptyGuardAcked() {
  try { return localStorage.getItem(EMPTY_GUARD_KEY) === '1' } catch { return false }
}
// 显式确认「我真的要从一个空客户端覆盖服务端」（设置页兜底入口用）
export function ackEmptyGuard() {
  try { localStorage.setItem(EMPTY_GUARD_KEY, '1') } catch { /* ignore */ }
}

// ---- 启动同步：先推本地增量，再以服务端终态对齐 ----
// 顺序不能反：pull 是「服务端整体覆盖本地」，而数据服务不可达期间在本机的离线改动只存在于
// 本地 IndexedDB，一旦先 pull 就永久丢失。故先增量 PUT（仅本次变动），再 pull。
async function syncOnStart() {
  let snap = null
  try {
    const res = await req('/state')
    if (!res.ok) throw new Error(`拉取失败 ${res.status}`)
    snap = await res.json()
  } catch (e) {
    // 连不上：本地照常用（IndexedDB 数据在），恢复后由变更/心跳补推
    markError(e)
    hydrated = true
    notify()
    return
  }
  const remote = snap.state || {}
  const remoteCount = countEntities(remote)
  const localCount = localEntityCount()
  version = Number(snap.version || 0)
  // 防呆红线：本地空、服务端有数据 → 禁止推送（deletes 会反向清空唯一数据源）。
  // 除非用户显式 ack（例如真的是要从备份重置过的空端覆盖，设置页确认过）。
  if (localCount === 0 && remoteCount > 0 && !emptyGuardAcked()) {
    console.warn(
      `[apiStore] 空客户端保护：本机 ${localCount} 条 / 服务端 ${remoteCount} 条，跳过推送只拉取。` +
      `如果确实要用空端覆盖服务端，请在设置页执行「强制覆盖」确认。`
    )
    hydrated = true
    await pull() // 只收养服务端数据，不推 deletes
    return
  }
  try {
    // 首次：服务端为空且本机有数据 → 整库迁移，让它成为唯一数据源（含原件）
    if (remoteCount === 0 && (await localHasData())) {
      await uploadLocalData() // 内部走 fullSync + 拉取 + 重建快照
      return
    }
    // 增量：先推本地未推送的变动，推失败则保住本地、不拉（避免覆盖丢失）
    const changes = collectChanges()
    if (hasAnyChange(changes)) {
      await putIncremental(changes, version)
    }
    // 原件自愈：**即使没有任何结构化变更**也要对齐一次（只传服务端缺的 id，成本可忽略）。
    // 2026-10-21：服务端孤儿回收曾有 bug 把化验原图全删，而客户端只在「有变更」时才补传，
    // 结果缺了就一直缺。启动即对齐，缺什么补什么。
    noteTombstonedBlobs(snap.deleted) // 先记下服务端已删的原件，再补传（否则删掉的副本会被传回去）
    await fillMissingBlobs(snap.blobs || [])
  } catch (e) {
    markError(e)
    hydrated = true
    notify()
    return
  }
  hydrated = true
  await pull() // 终态对齐 + 重建快照
}

// ---- 启动 ----
let bound = false
export async function initDataSource() {
  if (!bound) {
    bound = true // 「重连」会重复调用本函数，事件只注册一次
    window.addEventListener('meddata:state-changed', () => schedulePush())
    window.addEventListener('meddata:blob-saved', (e) => {
      const d = e.detail || {}
      if (!d.id) return
      if (d.kind === 'text') putBlob(d.id, d.text, 'text/plain', 'text')
      else if (d.blob) putBlob(d.id, d.blob, d.blob.type || 'application/octet-stream', 'blob')
    })
    window.addEventListener('meddata:blob-deleted', (e) => {
      const d = e.detail || {}
      if (d.id) delBlob(d.id)
    })
  }
  if (!cfg.enabled) return
  await syncOnStart()
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (!cfg.enabled) return
    req('/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((h) => {
        if (Number(h.version) !== version) pull()
      })
      .catch(() => {
        /* 心跳失败不打扰：可能是服务没开 */
      })
  }, HEARTBEAT_MS)
}

export function stopDataSource() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (pushTimer) clearTimeout(pushTimer)
  heartbeatTimer = null
  pushTimer = null
  status.state = 'off'
  notify()
}

// 存量迁移：把本机现有的 localStorage + IndexedDB 全部推到服务端（可重复执行）
export async function uploadLocalData() {
  const { getAllDocFiles, getAllDocTexts, getAllRecordImages } = await import('./docFileStore.js')
  if (!cfg.enabled) return { ok: false, reason: '未启用数据源' }
  hydrated = true // 迁移是显式动作，放行推送
  const [files, texts, images] = await Promise.all([getAllDocFiles(), getAllDocTexts(), getAllRecordImages()])
  for (const f of files) await putBlob(f.id, f.blob, (f.blob && f.blob.type) || 'application/octet-stream')
  for (const t of texts) await putBlob(t.id, t.text, 'text/plain', 'text')
  for (const i of images) await putBlob(i.id, i.blob, (i.blob && i.blob.type) || 'application/octet-stream')
  // 整库覆盖写（fullSync）：把本机全量推上去作为唯一数据源
  try {
    const cur = await req('/state')
    const baseV = cur.ok ? Number((await cur.json()).version || 0) : 0
    await putState(baseV)
  } catch {
    /* 写入失败不阻塞 */
  }
  await pull() // 拉取终态 + 重建快照
  return { ok: true, files: files.length, texts: texts.length, images: images.length }
}

// e2e / 手动钩子：供 scripts/verify-dual-client.mjs 在浏览器里驱动读写（也方便排查）
if (typeof window !== 'undefined') {
  window.__meddata = {
    ready: true,
    getRecords: () => getState().records,
    putRecord: async (rec) => {
      const { addRecord, updateRecord } = await import('../data/store.js')
      const exists = getState().records.some((r) => r.id === rec.id)
      if (exists) updateRecord(rec.id, rec)
      else addRecord(rec)
      await push()
    },
    deleteRecord: async (id) => {
      const { deleteRecord } = await import('../data/store.js')
      deleteRecord(id)
      await push()
    },
    pull: () => pull(),
    push: () => push(),
    initDataSource: () => initDataSource(),
    putBlob: async (blob) => {
      const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      await putBlob(id, blob, blob.type || 'application/octet-stream')
      return id
    },
    getBlob: (id) => getBlob(id),
    uploadLocalData: () => uploadLocalData(),
    getStatus: () => getStatus(),
    setConfig: (patch) => setConfig(patch),
  }
}
