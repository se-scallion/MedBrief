#!/usr/bin/env node
// 原件体检（只读）：报告引用的原件里，有几份在库里根本不存在。
//
// 为什么要有（2026-11-14 实测）：`POST /api/intake/reports` 只把图片算成 sha256 记指纹，
// **不写 blobs 表**；写原件只在 CLI（`tools/import-inbox.mjs` 先 POST /api/intake/blob）。
// 资料录入页走的入库 payload 不带 sourceBlobs（`web/src/meddata/docFileStore.js` 才是正路），
// 于是「页面导入的报告没有原件」——界面上只是少了个按钮，不报错、计数也对得上。
// 首例：rep_mwg22hwaloc（心脏彩超，55 份里第 55 份，blobs 表查不到它的 sha256，字节已不可恢复）。
//
// 口径（照 MedData scripts/check-blob-integrity.mjs）：
//   ★ 只认**结构化引用**（sourceBlobs[].blobId / blobs.report_id），绝不把「长得像 blob id 的字符串」当引用。
//   ★ 「有 sha256」不等于「有原件」——`/api/intake/reports` 的 hasImage: !!sha256 就是这种假信号。
//
// 用法：
//   node tools/check-blob-integrity.mjs            # 查 data/reports.json + data/medbrief.db
//   node tools/check-blob-integrity.mjs --strict   # 有缺失时退出码 1（适合进 CI，暂不进 test:intake）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = process.env.MEDBRIEF_DATA_DIR || path.join(ROOT, 'data')
const REPORTS = path.join(DATA, 'reports.json')
const DB = path.join(DATA, 'medbrief.db')
const STRICT = process.argv.includes('--strict')

const reports = (() => {
  try { return JSON.parse(fs.readFileSync(REPORTS, 'utf8')).reports || [] } catch { return [] }
})()

let blobs = []
try {
  const db = new DatabaseSync(DB, { readOnly: true })
  blobs = db.prepare('SELECT id, sha256, type, size, report_id FROM blobs').all()
  db.close()
} catch (e) {
  console.log(`（读不到 blobs 表：${e.message} —— 只做「引用是否有 blob」的静态检查）`)
}
const byId = new Map(blobs.map((b) => [b.id, b]))
const bySha = new Map(blobs.filter((b) => b.sha256).map((b) => [b.sha256, b]))
const reportIds = new Set(reports.map((r) => r.id))

const missingRef = []   // 引用了 blobId，但库里没有这条 blob
const noOriginal = []   // 报告有原图指纹（sha256/imageRef），但没有任何原件引用
const orphanBlob = []   // blob 挂着 report_id，但报告不存在

for (const r of reports) {
  const refs = (r.sourceBlobs || []).filter((b) => b && b.blobId)
  const hasBytes = refs.some((b) => byId.has(b.blobId))
  for (const b of refs) if (!byId.has(b.blobId)) missingRef.push({ id: r.id, blobId: b.blobId })
  if (!hasBytes) {
    // 退一步：按 sha256 找同字节的 blob（CLI 路径会复用同一份字节，不依赖 sourceBlobs）
    const hex = String(r.sha256 || '').replace(/^sha256:/, '')
    if (hex && bySha.has(hex)) continue
    if (r.sha256 || r.imageRef) noOriginal.push({ id: r.id, sha256: String(r.sha256 || '').slice(0, 12), source: r.source })
  }
}
for (const b of blobs) if (b.report_id && !reportIds.has(b.report_id)) orphanBlob.push({ blobId: b.id, reportId: b.report_id })

const n = reports.length
const ok = n - noOriginal.length - new Set(missingRef.map((x) => x.id)).size
console.log(`原件体检：${n} 份报告 · blobs ${blobs.length} 条`)
console.log(`  有原件（可按 blobId 或同 sha256 回取）  ${ok}`)
console.log(`  引用了不存在的 blob（结构化引用断链）  ${missingRef.length}`)
console.log(`  有原图指纹但库里没有原件字节          ${noOriginal.length}   ← 不可恢复，只能重导原件`)
for (const x of noOriginal) console.log(`    - ${x.id}  sha256 ${x.sha256}…  source=${x.source}`)
console.log(`  blob 挂着不存在的报告（孤儿）          ${orphanBlob.length}`)
for (const x of orphanBlob.slice(0, 5)) console.log(`    - ${x.blobId} → ${x.reportId}`)

const bad = missingRef.length + noOriginal.length
console.log(bad ? `\n⚠️ ${bad} 处缺失：原件是「以后能不能重新识别、能不能核对原件」的唯一凭据，缺了只能让用户重导。` : '\n✅ 全部报告的原始件都能回取。')
process.exit(STRICT && bad ? 1 : 0)
