#!/usr/bin/env node
// 一次性修数（可复跑，幂等）：①把 manifest 里核对好的 rows 写回 reports.json ②把 blobs 关联到报告
// 起因（2026-11-13 实测）：首次入库时 sourceBlobs 放在了 meta 里，服务端只读 body.sourceBlobs，
// 导致 53 个原件全部 unlinked、报告的 sourceBlobs 为空。本脚本按 sha256 前 8 位（= archive 目录名）
// 把「原件 → 报告」重新对上，并用改进后的解析器覆盖 rows。
//
// 用法：node tools/repair-import.mjs [--apply]   （默认 dry-run 只打印计划）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseOcrTable } from './ocr-table-rows.mjs'
import { listBlobs, linkBlobToReport } from '../lib/blobStore.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const REPORTS = path.join(ROOT, 'data', 'reports.json')
const MANIFEST = path.join(ROOT, 'data', 'tmp', 'inbox', 'manifest.json')

const mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const store = JSON.parse(fs.readFileSync(REPORTS, 'utf8'))
const blobs = listBlobs()
// blob sha256 前 8 位 → 报告（报告的 sourceFile 是 archive/<sha8> 目录）
const bySha8 = new Map()
for (const b of blobs) {
  const k = String(b.sha256 || '').slice(0, 8)
  if (!bySha8.has(k)) bySha8.set(k, [])
  bySha8.get(k).push(b)
}
console.log('blobs', blobs.length, '｜报告', store.reports.length, '｜manifest', mf.entries.length)

let rowsFixed = 0, blobsLinked = 0
for (const e of mf.entries) {
  const rep = store.reports.find((r) => (e.no ? r.barcode === e.no : r.reportType === e.type && r.reportDate === e.date))
  if (!rep) { console.log('  ✗ 找不到报告:', e.no || e.type); continue }
  // ① rows 覆盖（lab/拼接用改进后的解析；影像保持空行 + textOnly）
  if (e.kind !== 'imaging') {
    const rows = e.rows.length ? e.rows : []
    const fresh = rows.map((r) => ({ ...r, reportDate: e.date, measuredAt: r.measuredAt || e.date }))
    const changed = JSON.stringify(fresh.map((r) => r.name + '=' + r.value)) !== JSON.stringify((rep.rows || []).map((r) => r.name + '=' + r.value))
    if (changed) { rowsFixed++; console.log(`  行修正 ${e.no || e.type}: ${(rep.rows || []).length} → ${fresh.length} 行`) }
    if (APPLY) rep.rows = fresh
  }
  // ② blob 关联
  const want = []
  const sha8s = (e.sourceFiles || []).map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 8))
  for (const k of sha8s) for (const b of bySha8.get(k) || []) want.push({ blobId: b.id, role: 'original', sha256: b.sha256 })
  if (e.kind === 'lab-stitched') {
    const sb = blobs.find((b) => b.kind === 'stitched' && String(b.origin_path).endsWith(path.basename(e.file)))
    if (sb) want.push({ blobId: sb.id, role: 'stitched', sha256: sb.sha256 })
  }
  if (want.length && (rep.sourceBlobs || []).length !== want.length) {
    blobsLinked += want.length
    if (APPLY) {
      rep.sourceBlobs = want
      for (const w of want) { try { linkBlobToReport(w.blobId, rep.id) } catch { /* 已关联 */ } }
    }
  }
}
console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}｜待修行数 ${rowsFixed} 份｜待关联原件 ${blobsLinked} 个`)
if (APPLY) {
  fs.writeFileSync(REPORTS + '.bak-' + Date.now(), JSON.stringify(store, null, 2), 'utf8')
  fs.writeFileSync(REPORTS, JSON.stringify(store, null, 2), 'utf8')
  console.log('已写入 reports.json（含 .bak 备份）')
}
