#!/usr/bin/env node
// 批量入库（带原件）：把「我已核对过的识别结果」写进 MedBrief，同时把原件存进 SQLite blobs
//
// 为什么不用 tools/import-report.mjs：那条链路用项目自带的 parseLabRows，
// 会丢掉定性结果行（ABO 血型 B型、粪便常规 未见/阴性 等），且不归档 blob。
// 本脚本走 manifest（由人工/AI 核对后的 rows），并且：
//   1. 每份报告先 POST /api/intake/blob 存原件（role=original，跨屏再加 role=stitched）
//   2. 原件同时复制到 data/intake/<patient>/archive/<sha8>/（兼容旧 CLI 的归档目录约定）
//   3. POST /api/intake/reports 显式带 rows/text/meta.sourceBlobs
//
// 用法：
//   node tools/import-inbox.mjs --manifest data/tmp/inbox/manifest.json            # dry-run（只打印计划）
//   node tools/import-inbox.mjs --manifest data/tmp/inbox/manifest.json --apply    # 真入库
//   环境变量 MEDBRIEF_PORT 指定后端端口（默认 5174）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.MEDBRIEF_PORT || 5174)
const BASE = `http://127.0.0.1:${PORT}`
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const APPLY = argv.includes('--apply')
const patient = arg('--patient', 'p1')
const manifestFile = arg('--manifest', 'data/tmp/inbox/manifest.json')

const sha8 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8)
const mimeOf = (p) => (/.png$/i.test(p) ? 'image/png' : /.pdf$/i.test(p) ? 'application/pdf' : 'image/jpeg')

async function api(p, body) {
  const r = await fetch(BASE + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({ ok: false, error: 'non-json ' + r.status }))
  return j
}

async function uploadBlob(file, kind) {
  const buf = fs.readFileSync(file)
  const j = await api('/api/intake/blob', { dataUrl: `data:${mimeOf(file)};base64,${buf.toString('base64')}`, kind, originPath: file })
  if (!j.ok) throw new Error('存原件失败：' + (j.error || '?'))
  // 兼容旧归档目录：data/intake/<patient>/archive/<sha8>/<原文件名>
  const dir = path.join(ROOT, 'data', 'intake', patient, 'archive', sha8(buf))
  fs.mkdirSync(dir, { recursive: true })
  const dst = path.join(dir, path.basename(file))
  if (!fs.existsSync(dst)) fs.copyFileSync(file, dst)
  return { blobId: j.id, sha256: j.sha256, size: j.size, archive: dir }
}

const mf = JSON.parse(fs.readFileSync(path.isAbsolute(manifestFile) ? manifestFile : path.join(ROOT, manifestFile), 'utf8'))
const entries = mf.entries || []
console.log(`[${APPLY ? 'APPLY' : 'DRY-RUN'}] manifest ${entries.length} 份 → ${BASE}（patient=${patient}）`)

const out = []
let i = 0
for (const e of entries) {
  i++
  const tag = String(i).padStart(2, '0') + ' ' + (e.no || '无单号')
  if (!APPLY) {
    console.log(`  ${tag} ${e.type} ${e.date} ${e.rows.length} 行 ← ${path.basename(e.file)}`)
    continue
  }
  try {
    // 1) 原件入库
    const blobs = []
    for (const src of e.sourceFiles || [e.file]) blobs.push({ role: 'original', ...(await uploadBlob(src, 'original')) })
    if (e.kind === 'lab-stitched') blobs.push({ role: 'stitched', ...(await uploadBlob(e.file, 'stitched')) })
    // 2) 报告入库（rows 用我核对过的结果；text 存全文，供以后重识别比对）
    const imageBuf = fs.readFileSync(e.file)
    const body = {
      image: `data:${mimeOf(e.file)};base64,${imageBuf.toString('base64')}`,
      text: e.text || '',
      rows: e.rows || [],
      meta: {
        kind: e.kind === 'imaging' ? 'imaging' : 'lab',
        reportType: e.type,
        reportDate: e.date || '',
        hospital: e.hospital || '',
        barcode: e.no || '',
        patientName: '刘梦圆',
        textOnly: e.kind === 'imaging',
        sourceFile: blobs[0]?.archive || '',
        sourceBlobs: blobs.map((b) => ({ blobId: b.blobId, role: b.role, sha256: b.sha256, file: path.basename(b.archive ? path.join(b.archive, '') : '') })),
        importedBy: 'tools/import-inbox.mjs',
        stitchedFrom: e.stitchedFrom || undefined,
        dateInferredFrom: e.dateInferredFrom || undefined,
      },
    }
    const j = await api('/api/intake/reports', body)
    if (j.ok) out.push({ tag, ok: true, id: j.report.id, rows: j.report.rows.length, blobs: blobs.length })
    else out.push({ tag, ok: false, dup: j.duplicate || null, hint: j.hint || j.error })
    console.log(`  ${j.ok ? '✓' : '✗'} ${tag} ${e.type} → ${j.ok ? j.report.id + ' (' + j.report.rows.length + ' 行, ' + blobs.length + ' 个原件)' : (j.hint || JSON.stringify(j.duplicate) || j.error)}`)
  } catch (err) {
    out.push({ tag, ok: false, error: err.message })
    console.log(`  ✗ ${tag} ${err.message}`)
  }
}
if (APPLY) {
  const ok = out.filter((x) => x.ok).length
  console.log(`\n成功 ${ok}/${out.length}｜失败 ${out.length - ok}`)
  fs.writeFileSync(path.join(ROOT, 'data/tmp/inbox/import-result.json'), JSON.stringify({ at: new Date().toISOString(), out }, null, 1))
}
