// MedData 页面在 MedBrief 内的运行时挂载层（隔离、非破坏）。
//
// 职责：
//  1. 静态托管 /meddata（构建产物 web/dist-meddata）与 /tesseract、/traineddata（源码里硬编码的绝对路径）。
//  2. /api/data/* 全部落 MedBrief 自己的 data/meddata-mirror/ —— 绝不连 8787，绝不写 MedData 任何库。
//  3. MedData 页面用到的 /api/* 识别端点转发到 8008 网关（launchd 常驻，与 INTERFACE.md 通道 1 一致）。
//
// 红线：不改动 meddata/src 下任何源码；MedBrief 自有 /api/* 端点全部优先于本模块。
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(HERE, '..', 'web', 'dist-meddata')
const DATA = path.resolve(HERE, '..', 'data', 'meddata-mirror')
const STATE_FILE = path.join(DATA, 'state.json')
const BLOB_DIR = path.join(DATA, 'blobs')

const GW_HOST = '127.0.0.1'
const GW_PORT = Number(process.env.MEDBRIEF_MEDDATA_GATEWAY_PORT || 8008)

// 只转发 MedData 页面确实会调用的网关端点；其它 /api/* 仍由 MedBrief 自己（或 404）处理。
const PROXY_PREFIXES = [
  '/api/agent-mode',
  '/api/log',
  '/api/feedback',
  '/api/patches',
  '/api/gaps',
  '/api/engine-status',
  '/api/review-status',
  '/api/ai-',
  '/api/ocr-',
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
  '.meddata': 'application/octet-stream',
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length })
  res.end(buf)
}

function serveFile(req, res, file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return false
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    })
    if (req.method === 'HEAD') { res.end(); return true }
    fs.createReadStream(file).pipe(res)
    return true
  } catch {
    return false
  }
}

// ---------------- 本地数据镜像（替代 8787） ----------------

function ensureDirs() {
  fs.mkdirSync(DATA, { recursive: true })
  fs.mkdirSync(BLOB_DIR, { recursive: true })
}

function readMirror() {
  try {
    const m = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return {
      version: Number(m.version) || 1,
      state: m.state && typeof m.state === 'object' ? m.state : {},
      blobs: m.blobs && typeof m.blobs === 'object' ? m.blobs : {},
      deleted: Array.isArray(m.deleted) ? m.deleted : [],
    }
  } catch {
    return { version: 1, state: {}, blobs: {}, deleted: [] }
  }
}

function saveMirror(m) {
  ensureDirs()
  const tmp = `${STATE_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

const blobFile = (id) => path.join(BLOB_DIR, `${id}.bin`)

function blobMeta(m) {
  return Object.values(m.blobs).map((b) => ({ id: b.id, kind: b.kind, type: b.type, size: b.size, updated_at: b.updatedAt }))
}

const ENTITY_KEYS = ['records', 'events', 'docs', 'courses', 'drugPrices', 'stays', 'diseaseMetrics', 'invoices']
const countEntities = (state) => ENTITY_KEYS.reduce((n, k) => n + (Array.isArray(state?.[k]) ? state[k].length : 0), 0)

// 增量协议：{ changes: { upserts: { <entity|其它键>: [...] }, deletes: [{ entity, id }] }, baseVersion }
function applyChanges(prev, changes) {
  const state = { ...prev }
  const upserts = changes?.upserts && typeof changes.upserts === 'object' ? changes.upserts : {}
  let appliedUpserts = 0
  for (const [key, list] of Object.entries(upserts)) {
    if (Array.isArray(list)) {
      const byId = new Map((Array.isArray(state[key]) ? state[key] : [])
        .filter((x) => x && x.id != null).map((x) => [String(x.id), x]))
      const extras = []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        if (item.id != null) byId.set(String(item.id), item)
        else extras.push(item)
        appliedUpserts += 1
      }
      state[key] = [...byId.values(), ...extras]
    } else if (list && typeof list === 'object') {
      state[key] = { ...(state[key] && typeof state[key] === 'object' && !Array.isArray(state[key]) ? state[key] : {}), ...list }
      appliedUpserts += 1
    } else if (list !== undefined) {
      state[key] = list
    }
  }
  let appliedDeletes = 0
  const deletes = Array.isArray(changes?.deletes) ? changes.deletes : []
  for (const d of deletes) {
    if (!d || !Array.isArray(state[d.entity])) continue
    const before = state[d.entity].length
    state[d.entity] = state[d.entity].filter((x) => String(x?.id) !== String(d.id))
    appliedDeletes += before - state[d.entity].length
  }
  return { state, appliedUpserts, appliedDeletes }
}

async function readBody(req) {
  if (typeof req.__rawBody === 'string') return Buffer.from(req.__rawBody)
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function handleMirror(req, res, pathname, search) {
  const sub = pathname.slice('/api/data'.length) || '/'
  const m = readMirror()

  if (req.method === 'GET' && sub === '/health') {
    return sendJson(res, 200, {
      ok: true, version: m.version, app: 'medbrief-meddata-mirror',
      counts: Object.fromEntries(ENTITY_KEYS.map((k) => [k, Array.isArray(m.state[k]) ? m.state[k].length : 0])),
      blobs: { total: Object.keys(m.blobs).length, referenced: Object.keys(m.blobs).length, missing: 0 },
    })
  }

  if (req.method === 'GET' && sub === '/state') {
    return sendJson(res, 200, { version: m.version, state: m.state, blobs: blobMeta(m), deleted: m.deleted })
  }

  if (req.method === 'GET' && sub === '/blobs') {
    return sendJson(res, 200, { blobs: blobMeta(m), deleted: m.deleted })
  }

  if (req.method === 'GET' && sub === '/summary') {
    return sendJson(res, 200, {
      ok: true, version: m.version, generatedAt: new Date().toISOString(),
      patient: {}, latest: {}, aliases: {}, counts: { records: Array.isArray(m.state.records) ? m.state.records.length : 0 },
    })
  }

  if (req.method === 'PUT' && sub === '/state') {
    let payload
    try { payload = JSON.parse((await readBody(req)).toString('utf8') || '{}') } catch (e) {
      return sendJson(res, 400, { error: `无效的 JSON: ${e.message}` })
    }
    if (payload.changes && typeof payload.changes === 'object') {
      const { state, appliedUpserts, appliedDeletes } = applyChanges(m.state, payload.changes)
      m.state = state
      m.version += 1
      saveMirror(m)
      return sendJson(res, 200, {
        ok: true, version: m.version,
        applied: { upserts: appliedUpserts, deletes: appliedDeletes }, rejected: [], ignored: [],
      })
    }
    const incoming = payload && typeof payload.state === 'object' ? payload.state : null
    if (!incoming) return sendJson(res, 400, { error: '缺少 changes 或 state 字段' })
    // 与 MedData/data-server.mjs 一致的保险丝：空客户端整库覆盖会清空唯一数据源
    if (countEntities(incoming) === 0 && countEntities(m.state) > 0 && payload.force !== true) {
      return sendJson(res, 409, { error: '拒绝空整库覆盖：镜像中仍有数据，需显式 force:true' })
    }
    m.state = incoming
    m.version += 1
    saveMirror(m)
    return sendJson(res, 200, { version: m.version, state: m.state, changed: true })
  }

  const bm = sub.match(/^\/blob\/([^/]+)$/)
  if (bm) {
    const id = decodeURIComponent(bm[1])
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return sendJson(res, 400, { error: '非法 id' })
    ensureDirs()
    if (m.deleted.includes(id) && req.method === 'PUT') {
      return sendJson(res, 200, { ok: true, id, skipped: true, reason: 'tombstoned' })
    }
    if (req.method === 'GET') {
      const meta = m.blobs[id]
      if (!meta || !fs.existsSync(blobFile(id))) return sendJson(res, 404, { error: '不存在' })
      const buf = fs.readFileSync(blobFile(id))
      res.writeHead(200, { 'Content-Type': meta.type || 'application/octet-stream', 'Content-Length': buf.length })
      res.end(buf)
      return
    }
    if (req.method === 'PUT') {
      const data = await readBody(req)
      const kind = new URLSearchParams(search).get('kind') === 'text' ? 'text' : 'blob'
      const type = req.headers['x-blob-type'] || req.headers['content-type'] || 'application/octet-stream'
      fs.writeFileSync(blobFile(id), data)
      m.blobs[id] = { id, kind, type: String(type).split(';')[0], size: data.length, updatedAt: new Date().toISOString() }
      m.version += 1
      saveMirror(m)
      return sendJson(res, 200, { ok: true, id, size: data.length })
    }
    if (req.method === 'DELETE') {
      try { fs.unlinkSync(blobFile(id)) } catch { /* 已不存在 */ }
      delete m.blobs[id]
      if (!m.deleted.includes(id)) m.deleted.push(id)
      m.version += 1
      saveMirror(m)
      return sendJson(res, 200, { ok: true })
    }
  }

  return sendJson(res, 404, { error: '镜像端点不存在', sub })
}

// ---------------- 8008 网关代理 ----------------

function proxyToGateway(req, res, pathname, search) {
  return new Promise((resolve) => {
    const cached = typeof req.__rawBody === 'string' ? Buffer.from(req.__rawBody) : null
    const headers = { ...req.headers }
    delete headers.host
    delete headers['content-length']
    headers.host = `${GW_HOST}:${GW_PORT}`
    if (cached) headers['content-length'] = cached.length
    const upstream = http.request(
      { hostname: GW_HOST, port: GW_PORT, path: pathname + search, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers)
        up.pipe(res)
        up.on('end', () => resolve(true))
      },
    )
    upstream.on('error', (e) => {
      if (!res.headersSent) sendJson(res, 502, { ok: false, unavailable: true, error: `8008 网关不可用: ${e.message}` })
      resolve(true)
    })
    if (cached) upstream.end(cached)
    else req.pipe(upstream)
  })
}

// ---------------- 入口 ----------------

export async function mountMedData(req, res, pathname, parsedUrl) {
  // 源码里 ocr.js 把 tesseract worker / traineddata 写成绝对路径 /tesseract/... 与 /traineddata/...
  if (pathname.startsWith('/tesseract/') || pathname.startsWith('/traineddata/')) {
    const rel = pathname.replace(/^\//, '')
    const file = path.resolve(DIST, rel)
    if (file.startsWith(DIST) && serveFile(req, res, file)) return true
    sendJson(res, 404, { error: '识别静态资源不存在', pathname })
    return true
  }

  if (pathname === '/meddata' || pathname.startsWith('/meddata/')) {
    const rel = pathname === '/meddata' ? '' : pathname.slice('/meddata/'.length)
    if (rel) {
      const file = path.resolve(DIST, rel)
      if (file.startsWith(DIST) && serveFile(req, res, file)) return true
    }
    if (serveFile(req, res, path.join(DIST, 'index.html'))) return true
    sendJson(res, 404, { error: 'MedData 页面未构建，请先运行 npm run build:meddata' })
    return true
  }

  // MedBrief 自有端点已在 server.mjs 前半段处理，这里只接管镜像与 MedData 的网关端点。
  if (pathname.startsWith('/api/data')) {
    await handleMirror(req, res, pathname, parsedUrl.search)
    return true
  }

  if (PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return await proxyToGateway(req, res, pathname, parsedUrl.search)
  }

  return false
}
