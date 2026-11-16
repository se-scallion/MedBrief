// 资料导入页的模块级常量与工具（2026-11-13 抽页时从 IntakePage.jsx 原样搬出）
// 唯一登记处：改 ST / KIND_OPTIONS / FLAG_TEXT 会影响上传、校对、档案、报告列表四处。

// 状态机：待识别 → 识别中 → 已识别 / 未识别 / 疑似重复
export const ST = {
  pending: { label: '待识别', color: 'default' },
  ocr: { label: '识别中', color: 'processing' },
  done: { label: '已识别', color: 'green' },
  failed: { label: '未识别', color: 'red' },
  // 2026-11-17 批量导入改造（规格 §7.4）：入库时后端 findDuplicate 判出的「单据级」重复。
  // 文案要和「导入时同一文件」区分开（后者是字节级 exact），别再写「疑似重复」四个字。
  dup: { label: '疑似同一份报告', color: 'orange' },
}

export const KIND_OPTIONS = [
  { value: 'lab', label: '化验单' },
  { value: 'pathology', label: '病理 / 骨穿' },
  { value: 'imaging', label: '影像' },
  { value: 'discharge', label: '出院小结' },
  { value: 'drug', label: '处方 / 用药' },
  { value: 'unknown', label: '不确定' },
]

export const FLAG_TEXT = { high: '偏高 ↑', low: '偏低 ↓', normal: '正常', positive: '阳性', negative: '阴性' }

export function uid() {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export function fmtSize(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 裸 fetch：/api/intake/* 用「HTTP 200 + ok:false」表达「重复 / 未识别 / 上游不可用」，不能当成异常抛掉。 */
export async function rawJson(path, opts = {}) {
  const res = await fetch(path, opts)
  const body = await res.json().catch(() => ({}))
  return { httpStatus: res.status, body }
}

// 第 3 个参数 method 只给「更新原报告」的 PUT 用；不传仍是 POST（所有既有调用零改动）
export const postJson = (path, data, method = 'POST') =>
  rawJson(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
    })         // postJson 结尾

/**
 * 报告行修正的提交载荷（2026-11-14 用户报的坑，务必整行回写）。
 *
 * 事故：三列左移的存储行 `{name:"凝血酶原时间（P12.2个T）", value:"9.8-12.1", refRange:"sec"}`
 * 由 labClean 在读侧还原成 `PT / 12.2 / sec / 参考 9.8-12.1`。若前端「修正数值」**只提交 value**：
 *   → 存储变成 `{value:"12.2", refRange:"sec"}`，左移还原不再触发（判据是「value 像区间」），
 *     真参考区间 9.8-12.1 在存储里本来就只存在于 value 里 → **永久丢失**（实测确认）。
 * 所以：一律提交 name / value / unit / refRange 四元组，初值取**清洗后视图**（?normalized=1），
 * 等于把读侧修复结果固化入库，`repaired` 清空、后续不再依赖还原逻辑。
 *
 * @param {Array<{name?,value?,unit?,refRange?}>} rows 清洗后视图里的行（顺序即报告内下标）
 * @returns {Array<{index:number,name:string,value:string,unit:string,refRange:string}>}
 */
export function buildRowPatch(rows = []) {
  return (rows || []).map((r, index) => ({
    index,
    name: String(r.name ?? '').trim(),
    value: String(r.value ?? '').trim(),
    unit: String(r.unit ?? '').trim(),
    refRange: String(r.refRange ?? '').trim(),
  }))
}

/**
 * 串行批量执行（2026-11-15 从 IntakePage 抽成纯函数，便于单测）：
 * 「一键识别 / 一键导入」都是这个模型 —— 逐条执行、可随时停、单条失败不中断整批、可统计重复跳过。
 *
 * @param {Array} items
 * @param {(item:any)=>Promise<any>} worker  返回 { ok?:boolean, duplicate?:boolean, skipped?:boolean }
 * @param {{onProgress?:(done:number,total:number)=>void, shouldStop?:()=>boolean}} opts
 * @returns {Promise<{stopped:boolean, done:number, total:number, ok:number, skipped:number, failed:number}>}
 */
export async function runBatch(items = [], worker, { onProgress, shouldStop } = {}) {
  const total = items.length
  const res = { stopped: false, done: 0, total, ok: 0, skipped: 0, failed: 0 }
  for (let i = 0; i < total; i++) {
    if (shouldStop && shouldStop()) { res.stopped = true; res.done = i; return res }
    if (onProgress) onProgress(i, total)
    try {
      const r = await worker(items[i])
      if (r?.duplicate || r?.skipped) res.skipped += 1
      else if (r?.ok === false) res.failed += 1
      else res.ok += 1
    } catch {
      res.failed += 1
    }
    res.done = i + 1
  }
  if (onProgress) onProgress(total, total)
  return res
}

// ---------- 文件指纹（批量导入「导入即查重」用；2026-11-17） ----------
//
// 为什么自写纯 JS SHA-256：server.mjs 绑 0.0.0.0 ⇒ 手机只能走 http://<局域网IP>:5174
// ⇒ 非安全上下文 ⇒ window.crypto.subtle === undefined。若只做原生 WebCrypto，
// 「导入即查重」在手机端（= 批量导入的主场）等于没做。
// 口径（规格 §7.3）：crypto.subtle 可用则走原生（快路径），否则自写纯 JS；**两者都是精确值**，
// 因此「批内同字节 ⇒ 不建第二张卡」这条对两条腿一视同仁；只有 sha === null 才一律建卡（只打标）。
// 零第三方依赖（红线：不引 crypto-js / js-sha256 之类，见规格 §1.1）。

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x, n) => (x >>> n) | (x << (32 - n))

/** 纯 JS SHA-256（分块 + 让出主线程，避免大图卡死 UI）。返回小写 hex。 */
export async function sha256HexAsync(bytes, { yieldEvery = 64 } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const len = u8.length
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6)
  padded.set(u8)
  padded[len] = 0x80
  const dv = new DataView(padded.buffer)
  const bitHi = Math.floor(len / 0x20000000) // len*8 的高 32 位
  const bitLo = (len << 3) >>> 0
  dv.setUint32(padded.length - 8, bitHi)
  dv.setUint32(padded.length - 4, bitLo)

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Uint32Array(64)

  for (let off = 0, blk = 0; off < padded.length; off += 64, blk++) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
    if (blk % yieldEvery === yieldEvery - 1) await new Promise((r) => setTimeout(r, 0))
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('')
}

/** 测试用强制入口（规格 §7.3：没有它，纯 JS 分支正常路径永不执行 = 写了永远绿）。 */
export function hashModeOverride() {
  try {
    const q = new URLSearchParams(window.location.search).get('hash')
    if (q === 'js' || q === 'null') return q
    const ls = window.localStorage.getItem('mb_force_js_hash')
    if (ls === '1' || ls === 'js') return 'js'
  } catch {}
  return ''
}

const SHA256_MAX_BYTES = 8 * 1024 * 1024 // 规格 §7.3：单文件 >8MB 不做预检（标「文件过大，未预检」）

/**
 * 算文件 sha256。**不抛异常**：失败返回 { sha: null, reason }。
 * reason ∈ '' | 'too-large' | 'error' | 'forced-null'
 * 失败时调用方必须「照常建卡 + 只打标」，绝不丢文件（规格 §7.3 / A9c）。
 */
export async function sha256FileSafe(file) {
  const mode = hashModeOverride()
  if (mode === 'null') return { sha: null, reason: 'forced-null' }
  try {
    const buf = await file.arrayBuffer()
    const u8 = new Uint8Array(buf)
    if (u8.byteLength > SHA256_MAX_BYTES) return { sha: null, reason: 'too-large' }
    const canNative = mode !== 'js' && typeof crypto !== 'undefined' && crypto.subtle
      && typeof crypto.subtle.digest === 'function'
    if (canNative) {
      const digest = await crypto.subtle.digest('SHA-256', u8)
      const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
      return { sha, reason: '' }
    }
    return { sha: await sha256HexAsync(u8), reason: '' }
  } catch {
    return { sha: null, reason: 'error' }
  }
}
