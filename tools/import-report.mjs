#!/usr/bin/env node
// ===================== 报告导入 · 固定流程（CLI，支持批量）=====================
// 一句话：**一批报告 → 版式适配器 → 指标行 → 查重 → 人工核对（只核可疑行）→ 入库 → 出 A4 卡**。
//
// 设计取舍（2026-11-12 实测后定）：
//   - 瓶颈是「一份一轮对话 + 串行 OCR」，不是解析。故本 CLI 支持**一次批多份 + 并发**，
//     并把「人核对」从「每份都通读」收敛成「只通读首份 + 只核可疑行」（`--review`）。
//   - 8008 可并发（实测 12 路并行：吞吐 594ms/份 → 143ms/份），故默认并发 4（长尾可控）。
//   - 默认 dry-run：不写库；`--apply` 才写。查重命中不中断批量（标记 duplicate 继续）。
//
// 用法：
//   node tools/import-report.mjs <a.pdf> <b.png> ...   [选项]   # 多文件
//   node tools/import-report.mjs --dir <目录>          [选项]   # 目录里所有 pdf/png/jpg/webp/txt
//
// 选项：
//   --apply               真的入库（默认只打印计划）
//   --concurrency <n>     并发份数，默认 4（上限 8）
//   --review all|suspect|none   核对粒度：all=逐份全表；suspect=只列可疑行（默认：单文件 all，多文件 suspect）；none=不打印行
//   --force               查重命中仍入库（会留重复记录，只在人确认「确实不同」时用）
//   --patient <id>        病友档案 id，默认 p1
//   --update-patient      用报告抬头**填空**病友档案（只填空字段，不覆盖已有非空值）
//   --diagnosis/--subtype/--stage <文本>   显式写档案的这三项（不传就不动 —— 诊断不猜）
//   --no-mask             资料卡不脱敏姓名（默认脱敏）
//   --json                只输出机器可读 JSON（给自动化用）
//   env MEDBRIEF_PORT     后端端口，默认 5174
//
// 退出码：0 全部处理完毕（含查重跳过）｜2 单文件模式查重命中｜3 有文件无适配器/解析 0 行｜4 有文件失败
//
// 新增一种报告版式：只加 tools/report-adapters/<form>.mjs 并登记到 index.mjs（见 docs/报告导入流程.md §二）

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pickAdapter, ADAPTERS, collectSuspects } from './report-adapters/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.MEDBRIEF_PORT || 5174)
const BASE = `http://127.0.0.1:${PORT}`
const EXT_OK = /\.(pdf|png|jpe?g|webp|tiff?|txt)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|heic|tiff?)$/i

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`)
  console.error('用法：node tools/import-report.mjs <报告.pdf|截图.png|文本.txt> ... [--apply] [--dir <目录>] [--concurrency 4] [--review all|suspect|none]')
  process.exit(4)
}

function parseArgs(argv) {
  const opts = { apply: false, force: false, patient: 'p1', updatePatient: false, mask: true, json: false, concurrency: 4, dir: null, review: null }
  const files = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--force') opts.force = true
    else if (a === '--update-patient') opts.updatePatient = true
    else if (a === '--no-mask') opts.mask = false
    else if (a === '--json') opts.json = true
    else if (a === '--patient') opts.patient = argv[++i]
    else if (a === '--dir') opts.dir = argv[++i]
    else if (a === '--concurrency') opts.concurrency = clamp(Number(argv[++i]) || 4, 1, 8)
    else if (a === '--review') opts.review = argv[++i]
    else if (a === '--diagnosis') opts.diagnosis = argv[++i]
    else if (a === '--subtype') opts.subtype = argv[++i]
    else if (a === '--stage') opts.stage = argv[++i]
    else if (a.startsWith('-')) usage(`未知参数 ${a}`)
    else files.push(a)
  }
  if (opts.dir) {
    if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) usage(`--dir 不是目录：${opts.dir}`)
    for (const f of fs.readdirSync(opts.dir).sort()) {
      const p = path.join(opts.dir, f)
      if (fs.statSync(p).isFile() && EXT_OK.test(f)) files.push(p)
    }
  }
  if (!files.length) usage('没有输入文件（给文件路径或 --dir <目录>）')
  if (opts.review && !['all', 'suspect', 'none'].includes(opts.review)) usage('--review 只能是 all|suspect|none')
  if (!opts.review) opts.review = files.length === 1 ? 'all' : 'suspect'
  return { opts, files }
}

async function api(pathname, init) {
  const r = await fetch(BASE + pathname, init)
  const j = await r.json().catch(() => ({}))
  if (!r.ok && !j.error) j.error = `HTTP ${r.status}`
  return j
}

// ---------------- 1. 取数（PDF 文本层 / 图片 OCR / 纯文本）----------------

function runPython(args) {
  const r = spawnSync(process.env.PYTHON || 'python3', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`调用 python3 失败（需要 PyMuPDF / Pillow）：${r.error.message}`)
  return String(r.stdout || '').trim()
}

function pdfExtract(file, renderDir) {
  const args = [path.join(__dirname, 'pdf-extract.py'), file]
  if (renderDir) args.push('--render', renderDir)
  const raw = runPython(args)
  try {
    const j = JSON.parse(raw)
    if (!j.ok) throw new Error(j.error || 'PDF 文本层提取失败')
    return j
  } catch (e) {
    throw new Error(`PDF 文本层提取失败：${e.message}${raw ? `｜输出片段：${raw.slice(0, 160)}` : ''}`)
  }
}

function imageDhash(file) {
  try {
    const j = JSON.parse(runPython([path.join(__dirname, 'dhash.py'), file]))
    return j.ok ? String(j.dhash || '') : ''
  } catch {
    return ''
  }
}

async function ocrDataUrl(dataUrl) {
  const r = await api('/api/intake/ocr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
  if (!r.ok) throw new Error(r.reason || 'OCR 失败（8008 网关是否在跑？curl -s 127.0.0.1:8008/api/agent-mode）')
  return r
}

async function loadSource(file, opts) {
  const ext = path.extname(file).toLowerCase()
  const buf = fs.readFileSync(file)
  const digest = sha256(buf)

  if (ext === '.pdf') {
    const j = pdfExtract(file)
    const firstPage = (j.pages?.[0]?.lines || []).join('\n')
    if (j.hasTextLayer && firstPage.trim()) {
      return { mode: 'pdf-text-layer', text: j.pages.map((p) => (p.lines || []).join('\n')).join('\n\n'), pageCount: j.pageCount, sha256: digest, note: `PDF 文本层（${j.pageCount} 页，未做 OCR/未走视觉模型）` }
    }
    // 扫描件：渲染逐页 → 并发 OCR
    const tmp = path.join(ROOT, 'data', 'tmp', `import-${digest.slice(0, 8)}`)
    fs.mkdirSync(tmp, { recursive: true })
    pdfExtract(file, tmp)
    const pages = fs.readdirSync(tmp).filter((f) => /^page-\d+\.png$/.test(f)).sort()
    const pngs = pages.map((p) => path.join(tmp, p))
    const results = await Promise.all(pngs.map((p) => ocrDataUrl(`data:image/png;base64,${fs.readFileSync(p).toString('base64')}`)))
    return {
      mode: 'pdf-ocr',
      text: results.map((r) => r.text || '').join('\n'),
      pageCount: j.pageCount,
      sha256: digest,
      image: `data:image/png;base64,${fs.readFileSync(pngs[0]).toString('base64')}`,
      note: `PDF 无文本层 → 渲染后 8008 OCR（${pngs.length} 页并发）`,
    }
  }

  if (IMAGE_EXT.test(ext)) {
    const mime = ext === '.png' ? 'png' : 'jpeg'
    const dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`
    const r = await ocrDataUrl(dataUrl)
    return { mode: 'image-ocr', text: r.text || '', pageCount: 1, sha256: digest, image: dataUrl, note: `8008 OCR（切块=${r.chunked ? '是' : '否'}）` }
  }

  return { mode: 'text', text: buf.toString('utf8'), pageCount: 1, sha256: digest, note: '纯文本（跳过 OCR）' }
}

// ---------------- 2. 归档原件 ----------------

function archive(file, src, opts) {
  const dir = path.join(ROOT, 'data', 'intake', opts.patient, 'archive', src.sha256.slice(0, 8))
  fs.mkdirSync(dir, { recursive: true })
  const dst = path.join(dir, path.basename(file))
  if (!fs.existsSync(dst)) fs.copyFileSync(file, dst)
  fs.writeFileSync(path.join(dir, 'text.txt'), src.text, 'utf8')
  if (src.mode === 'pdf-text-layer') {
    try { pdfExtract(file, dir) } catch { /* 渲染失败不影响入库 */ }
  }
  return dir
}

// ---------------- 4. 单份：取数 → 适配器 → 行 ----------------

async function planOne(file, opts) {
  const t0 = Date.now()
  const base = { file, name: path.basename(file) }
  let src
  try {
    src = await loadSource(file, opts)
  } catch (e) {
    return { ...base, status: 'failed', error: e.message, ms: Date.now() - t0 }
  }
  const picked = pickAdapter(src.text)
  if (!picked) {
    return { ...base, src, status: 'no-adapter', ms: Date.now() - t0, hint: `为该版式新增 tools/report-adapters/<form>.mjs（已注册：${ADAPTERS.map((a) => a.id).join(', ')}）` }
  }
  const parsed = picked.adapter.parse({ text: src.text })
  // 唯一例外：结论/病理类「全文型」报告（textOnly）没有指标行是设计结果，全文进 report.text 回查；
  // 其它版式 0 行一律判 empty（退出码 3），绝不把空表当导入成功。
  const textOnly = !!(parsed.textOnly || parsed.meta?.textOnly)
  if (!parsed.rows.length && !textOnly) {
    return { ...base, src, adapter: picked.adapter, status: 'empty', ms: Date.now() - t0, parsed, hint: `适配器 ${picked.adapter.id} 解析出 0 行 —— 版式没吃下，需要为它写适配器` }
  }
  return { ...base, src, adapter: picked.adapter, parsed, status: 'parsed', ms: Date.now() - t0, suspects: collectSuspects(parsed), textOnly }
}

// ---------------- 5. 单份：入库 ----------------

async function applyOne(r, opts) {
  // 写库前最后一道守卫：0 行且不是全文型报告一律拒绝，防止适配器日后退化把空表静默写进库。
  if (!r.parsed?.rows?.length && !r.textOnly && !r.parsed?.meta?.textOnly) {
    return { ...r, status: 'empty', hint: '守卫拒绝写库：没有指标行且不是全文型报告' }
  }
  const dir = archive(r.file, r.src, opts)
  const body = { image: r.src.image || null, text: r.src.text, rows: r.parsed.rows, meta: { ...r.parsed.meta, sourceFile: dir }, force: opts.force }
  let hashImage = null
  if (body.image) {
    hashImage = path.join(dir, 'page-1.png')
    if (!fs.existsSync(hashImage)) {
      hashImage = path.join(ROOT, 'data', 'tmp', `dh-${r.src.sha256.slice(0, 8)}.png`)
      fs.mkdirSync(path.dirname(hashImage), { recursive: true })
      fs.writeFileSync(hashImage, Buffer.from(body.image.replace(/^data:image\/[a-z+]+;base64,/i, ''), 'base64'))
    }
  } else {
    const png = path.join(dir, 'page-1.png')
    if (fs.existsSync(png)) { body.image = `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`; hashImage = png }
  }
  if (hashImage) body.dhash = imageDhash(hashImage)

  const saved = await api('/api/intake/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (saved.duplicate) return { ...r, status: 'duplicate', archiveDir: dir, duplicate: saved.duplicate, hint: saved.hint }
  if (!saved.ok) return { ...r, status: 'failed', archiveDir: dir, error: saved.error || '入库失败' }
  r.archiveDir = dir
  r.reportId = saved.report?.id
  r.total = saved.total
  return { ...r, status: 'imported' }
}

// ---------------- 6. 并发池 ----------------

async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      try { out[i] = await fn(items[i], i) } catch (e) { out[i] = { file: items[i], status: 'failed', error: e.message } }
    }
  })
  await Promise.all(workers)
  return out
}

// ---------------- 7. 打印 ----------------

const ICON = { imported: '✓', parsed: '·', duplicate: '⧉', empty: '⚠', 'no-adapter': '⚠', failed: '✗' }

function printRowTable(r) {
  const m = r.parsed.meta
  console.log(`\n── ${r.name} ──  [${r.status}] ${r.adapter?.id || ''}｜${r.src.note}`)
  console.log(`   抬头：${m.patientName || '—'} ${m.patientSex || ''} ${m.patientAge ? m.patientAge + '岁' : ''}｜${m.hospital || '—'}｜报告日期 ${m.reportDate || '—'}${m.reportType ? '｜' + m.reportType : ''}`)
  if (!r.parsed.rows.length) console.log('   （全文型报告：无结构化指标行；核型公式 / 结论 / 结果解释留在 report.text 回查）')
  for (const x of r.parsed.rows) {
    console.log(`   ${String(x.name).padEnd(24)} ${String(x.value).padEnd(9)} ${String(x.unit || '').padEnd(4)} ${String(x.refRange || '—').padEnd(10)} ${x.status.padEnd(8)} ${x.code || '—'}`)
    if (x.rawSnippet) console.log(`        原文：${x.rawSnippet}`)
  }
}

function printPlan(results, opts, wallMs) {
  console.log(`\n=== 报告导入（${results.length} 份，并发 ${opts.concurrency}，${opts.apply ? 'APPLY' : 'DRY-RUN 不写库'}，核对=${opts.review}）===`)
  let i = 0
  for (const r of results) {
    i++
    const tail = r.status === 'duplicate' ? `｜重复于 ${r.duplicate?.of}` : r.error ? `｜${r.error}` : r.hint ? `｜${r.hint}` : r.textOnly ? '｜全文型：0 指标行，全文入库回查' : ''
    const rows = r.parsed?.rows?.length ?? 0
    console.log(`[${String(i).padStart(2)}/${results.length}] ${ICON[r.status] || '·'} ${String(r.name).padEnd(34)} ${String(r.status).padEnd(11)} ${String(rows).padStart(3)} 行 ${String(r.ms ?? 0).padStart(5)}ms${tail}`)
  }
  if (opts.review === 'all') for (const r of results) if (r.parsed) printRowTable(r)
  const suspects = results.filter((r) => r.suspects?.length)
  if (opts.review !== 'none' && suspects.length) {
    console.log('\n⚠️ 需要人核对的地方：')
    for (const r of suspects) for (const s of r.suspects) console.log(`  - ${r.name}：${s}`)
  }
  // 失败类要显式喊出来（不许「解析出空表也算成功」）：给人和自动化都留一句可 grep 的话
  for (const r of results) {
    if (r.status === 'empty') console.error(`✗ ${r.name}：未解析出任何指标行（适配器 ${r.adapter?.id || '?'}）—— 不写库，需要为该版式写适配器`)
    if (r.status === 'no-adapter') console.error(`✗ ${r.name}：没有匹配的版式适配器 —— ${r.hint || ''}`)
    if (r.status === 'failed') console.error(`✗ ${r.name}：${r.error}`)
  }
  const counts = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m }, {})
  const rowsTotal = results.reduce((n, r) => n + (r.parsed?.rows?.length || 0), 0)
  console.log(`\n合计：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}｜指标 ${rowsTotal} 行｜wall ${wallMs}ms（平均 ${Math.round(wallMs / results.length)}ms/份）`)
  // 「import-report」默认只出计划：实测有人把退出码 0 + parsed 读成「已导入」，故每次收尾都说清楚。
  if (!opts.apply) console.log('提示：以上为 DRY-RUN，未写库；核对无误后加 --apply 重跑。')
}

// ---------------- 8. 主流程 ----------------

async function main() {
  const { opts, files } = parseArgs(process.argv.slice(2))
  const t0 = Date.now()
  const planned = await pool(files, opts.concurrency, (f) => planOne(f, opts))
  let results = planned

  if (opts.apply) {
    const importable = planned.filter((r) => r.status === 'parsed')
    const done = await pool(importable, opts.concurrency, (r) => applyOne(r, opts))
    results = planned.map((r) => done.find((d) => d.file === r.file) || r)
  }

  const wallMs = Date.now() - t0
  if (!opts.json) printPlan(results, opts, wallMs)

  let cardPaths = null
  if (opts.apply) {
    if (opts.updatePatient) {
      const cur = (await api('/api/intake/patient')).patient || {}
      const patch = {}
      const fill = (k, v) => { if (v && !String(cur[k] || '').trim()) patch[k] = String(v) }
      const first = results.find((r) => r.parsed)?.parsed?.meta || {}
      fill('name', first.patientName); fill('sex', first.patientSex); fill('age', first.patientAge)
      fill('hospital', first.hospital); fill('attending', first.attending)
      if (opts.diagnosis) patch.diagnosis = opts.diagnosis
      if (opts.subtype) patch.subtype = opts.subtype
      if (opts.stage) patch.stage = opts.stage
      if (Object.keys(patch).length) {
        const r = await api('/api/intake/patient', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        if (!opts.json) console.log(r.ok ? `病历抬头已更新：${Object.keys(patch).join('、')}` : `✗ 档案写入失败：${r.error}`)
      }
    }
    const card = await api(`/api/intake/card?mask=${opts.mask ? 1 : 0}`)
    if (card.ok && card.html) {
      const outDir = path.join(ROOT, 'data', 'intake')
      fs.mkdirSync(outDir, { recursive: true })
      const htmlPath = path.join(outDir, 'card.html')
      const jsonPath = path.join(outDir, 'card.json')
      fs.writeFileSync(htmlPath, card.html, 'utf8')
      fs.writeFileSync(jsonPath, JSON.stringify({ ...card, html: undefined }, null, 2), 'utf8')
      cardPaths = { htmlPath, jsonPath, counts: card.counts }
    }
    if (!opts.json) {
      if (cardPaths) console.log(`资料卡：${cardPaths.htmlPath}（counts ${JSON.stringify(cardPaths.counts)}）`)
      else console.log('⚠️ 资料卡生成失败（/api/intake/card 未返回 html）')
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      ok: results.every((r) => r.status !== 'failed'),
      applied: opts.apply,
      wallMs,
      results: results.map((r) => ({ file: r.file, status: r.status, adapter: r.adapter?.id, textOnly: !!r.textOnly, rows: r.parsed?.rows?.length || 0, reportId: r.reportId, ms: r.ms, suspects: r.suspects || [], error: r.error, hint: r.hint })),
      card: cardPaths,
      reports: results.map((r) => ({ reportId: r.reportId, meta: r.parsed?.meta, rows: r.parsed?.rows })).filter((x) => x.meta),
    }, null, 2))
  }

  // 退出码：单文件保持原语义；批量只在「有失败/无适配器/空解析」时非 0
  const bad = results.filter((r) => ['failed', 'no-adapter', 'empty'].includes(r.status))
  const singles = results.length === 1 ? results[0] : null
  if (singles?.status === 'duplicate') process.exit(2)
  if (bad.length) process.exit(bad.some((r) => r.status === 'failed') ? 4 : 3)
  process.exit(0)
}

// 只有「被直接执行」时才跑主流程（被测试 import 时不得有副作用）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`)
    process.exit(4)
  })
}
