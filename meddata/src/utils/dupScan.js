// ===================== 跨实体同源扫描 · 纯函数，零 DOM / 零 store 依赖 =====================
// 为什么需要（2026-10-28 实测漏判）：2026-09-03 骨髓形态学、2026-08-20 流式免疫分型
// 同一份原件被两条通道各收录一次（检查报告 docs + 化验记录 records），而查重是**按实体切分**的：
//   utils/docDup.js:findDocDuplicateIn 只比 docs；data/store.js:findDuplicateRecord 只比 records。
// 于是「骨穿/流式改判到化验」这条合法迁移，必然留下「旧归档 + 新记录」两条而无人报警。
//
// 三个通道（缺一不可）：
//   通道 A 跨实体同源 · 原字节域：docs.file.sha256 == records.file_hash
//   通道 B 裸记录：有 original_image_id/image_id，但 file_hash 与 image_hash 皆空
//     —— 这类记录永远进不了任何哈希通道（本案例两条都是这个形状）。
//   通道 C 原件字节副本：同一 sha256 在 blobs 里存在 >1 份（含无引用副本）→ 存储层重复。
//
// ⚠ 域（domain）红线：records.image_hash 是 900px 存档压缩图的哈希，docs.file.sha256 是原文件
//   字节哈希（来历见 src/utils/fileHash.js:30-34）。**两者不同域，严禁直接比较** ——
//   "取第一个非空哈希"式的归一必然永不命中，是假归一。本模块用 domain 显式隔离。

export const DOMAIN_BYTES = 'bytes' // 原文件字节域：可跨实体比较
export const DOMAIN_ARCHIVE = 'archive' // 存档压缩图域：只能与同域比

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase()

// 一个实体（docs / records / 导入候选）的「同源键」：优先原字节域，压缩域单列
// 形状兼容三种现成写法：
//   { file: { sha256 } }  docs / DocImportFlow 的已归档对象
//   { file_hash }         records（导入时算的原文件 SHA-256）
//   { file_sha256 }       查重候选（与 utils/docDup.js:findDocDuplicateIn 的 candidate 同一字段名）
export function sourceHashOf(entity) {
  if (!entity || typeof entity !== 'object') return null
  const fileSha = entity.file && typeof entity.file.sha256 === 'string' ? norm(entity.file.sha256) : ''
  if (fileSha) return { domain: DOMAIN_BYTES, sha: fileSha, field: 'file.sha256' }
  const fh = norm(entity.file_hash)
  if (fh) return { domain: DOMAIN_BYTES, sha: fh, field: 'file_hash' }
  const candSha = norm(entity.file_sha256)
  if (candSha) return { domain: DOMAIN_BYTES, sha: candSha, field: 'file_sha256' }
  const ih = norm(entity.image_hash)
  if (ih) return { domain: DOMAIN_ARCHIVE, sha: ih, field: 'image_hash' }
  return null
}

// 记录侧的原件引用 id（与 data-server blobRefsDeclared 的窄口径一致）
export function archiveRefIdOf(record) {
  if (!record || typeof record !== 'object') return ''
  for (const k of ['original_image_id', 'image_id']) {
    if (typeof record[k] === 'string' && record[k].trim()) return record[k].trim()
  }
  return ''
}

const pickDoc = (d) => ({ id: d.id, date: d.date || '', type: d.doc_type || '', title: d.title || '' })
const pickRecord = (r) => ({ id: r.id, date: r.date || '', type: r.report_type || '', title: r.title || '' })

// 扫描：输入全是普通对象/数组，便于浏览器、脚本（doctor:dup）与 data-server（/api/health）共用同一口径
//   docs / records：实体数组
//   blobs：[{ id, sha, size }]（sha 由调用方算，本模块不做 IO）
//   referencedIds：被任何实体引用的 blob id 集合（不传则按 docs+records 的窄口径自行推）
export function scanCrossDup({ docs = [], records = [], blobs = [], referencedIds = null } = {}) {
  const docList = Array.isArray(docs) ? docs.filter(Boolean) : []
  const recList = Array.isArray(records) ? records.filter(Boolean) : []

  // ---- 通道 A：跨实体同源（只比原字节域）----
  const docBySha = new Map()
  for (const d of docList) {
    const h = sourceHashOf(d)
    if (!h || h.domain !== DOMAIN_BYTES) continue
    if (!docBySha.has(h.sha)) docBySha.set(h.sha, [])
    docBySha.get(h.sha).push(d)
  }
  const recBySha = new Map()
  for (const r of recList) {
    const h = sourceHashOf(r)
    if (!h || h.domain !== DOMAIN_BYTES) continue // 压缩域不参与跨实体比对
    if (!recBySha.has(h.sha)) recBySha.set(h.sha, [])
    recBySha.get(h.sha).push(r)
  }
  const crossSources = []
  for (const [sha, ds] of docBySha) {
    const rs = recBySha.get(sha)
    if (!rs || !rs.length) continue
    // 已解释豁免：record.mergedFrom.docId 指向组内 doc（上一次人工合并的痕迹）
    // 否则每次体检都报同一组 → 把已处置的历史问题固化成常驻噪声。
    const covered = new Set(rs.map((r) => (r.mergedFrom && r.mergedFrom.docId ? String(r.mergedFrom.docId) : '')))
    const explained = ds.every((d) => covered.has(String(d.id)))
    crossSources.push({
      sha,
      docs: ds.map(pickDoc),
      records: rs.map(pickRecord),
      explained,
      explainedBy: explained ? rs.map((r) => r.id) : [],
    })
  }

  // ---- 通道 B：裸记录（有原图、无任何哈希）----
  const nakedRecords = recList
    .filter((r) => archiveRefIdOf(r) && !norm(r.file_hash) && !norm(r.image_hash))
    .map((r) => ({ ...pickRecord(r), imageId: archiveRefIdOf(r) }))

  // ---- 通道 C：原件字节副本（同 sha 多份）----
  const refs =
    referencedIds instanceof Set
      ? referencedIds
      : referencedIds && Array.isArray(referencedIds)
        ? new Set(referencedIds.map(String))
        : new Set([
            ...docList.map((d) => (d.file && typeof d.file.id === 'string' ? d.file.id : '')).filter(Boolean),
            ...recList.map(archiveRefIdOf).filter(Boolean),
          ])
  const bySha = new Map()
  for (const b of Array.isArray(blobs) ? blobs : []) {
    if (!b || !b.id) continue
    const sha = norm(b.sha)
    if (!sha) continue
    if (!bySha.has(sha)) bySha.set(sha, [])
    bySha.get(sha).push(b)
  }
  const dupBlobs = []
  for (const [sha, arr] of bySha) {
    if (arr.length < 2) continue
    const unreferenced = arr.filter((b) => !refs.has(String(b.id))).map((b) => b.id)
    dupBlobs.push({
      sha,
      size: arr[0].size || 0,
      ids: arr.map((b) => b.id),
      unreferenced,
    })
  }

  const unexplained = crossSources.filter((g) => !g.explained).length
  return {
    crossSources,
    nakedRecords,
    dupBlobs,
    explained: crossSources.length - unexplained,
    counts: {
      crossSources: crossSources.length,
      unexplained,
      nakedRecords: nakedRecords.length,
      dupBlobs: dupBlobs.length,
    },
  }
}

// 事前查找（导入保存前的软闸用）：candidate 与「另一类实体」是否存在同源原件。
// 只认原字节域；压缩域一律不参与（无原文件可比，避免假阳性）。
// 返回 { kind:'doc'|'record', item, sha } 或 null。
export function findCrossEntityHit(pool, candidate, opts = {}) {
  const h = sourceHashOf(candidate)
  if (!h || h.domain !== DOMAIN_BYTES) return null
  const skip = opts.skipKind || ''
  const want = opts.wantKind || '' // 'doc' → 只找 docs；'record' → 只找 records；空 → 两类都找
  const lists = []
  if (want !== 'record') for (const d of pool.docs || []) lists.push({ kind: 'doc', item: d })
  if (want !== 'doc') for (const r of pool.records || []) lists.push({ kind: 'record', item: r })
  for (const { kind, item } of lists) {
    if (skip && skip === kind) continue
    const e = sourceHashOf(item)
    if (!e || e.domain !== DOMAIN_BYTES) continue
    if (e.sha === h.sha) return { kind, item, sha: h.sha }
  }
  return null
}

// 摘要文案（体检脚本与 health 共用，避免两处口径漂移）
export function describeHit(hit) {
  if (!hit) return ''
  const it = hit.item || {}
  const date = it.date || ''
  const type = (hit.kind === 'doc' ? it.doc_type : it.report_type) || ''
  const title = it.title || ''
  const who = hit.kind === 'doc' ? '检查报告' : '化验记录'
  return `${date} · ${type}${title ? ' · ' + title : ''}（${who}）`
}
