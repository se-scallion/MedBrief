#!/usr/bin/env node
// ============ 截图报告处理工作流（唯一入口）============
// 把「手机截图/微信导出的报告图片」变成「可入库的报告清单」的固定流水线：
//   发现 → 魔数识别 → OCR → 身份识别 → 查重 → 行抽取 → 跨屏配对 → 产出清单/文件夹 →（可选）入库
//
// 为什么要有这个工作流（2026-11-13 实测踩过的坑，别重新踩）：
//   1) 微信 temp/RWTemp/<月> 是**明文** JPEG；msg/attach 里的 07085632 头 .dat 是 V2 加密，解不出 → 只收明文
//   2) 同一张图会有多个副本（_t 缩略图、换编码、不同导出）→ 必须 sha256 + 单号/日期双查重
//   3) 一张报告可能被截成两屏 → 无抬头页要用「页1 尾部 k 行 == 页2 头部 k 行（名称+数值）」配对，
//      不能用文本相似度（同版式不同日期的血常规文字几乎一样，会误配）
//   4) 拼接图整图重跑 OCR 会丢行 → rows 用两页各自 OCR 的并集，拼接图只作原件
//   5) dHash 在文本截图上不可用（不同报告距离可为 0）→ 查重键 = 单号+日期（+行值指纹）
//
// 用法：
//   node tools/workflow-screenshots.mjs --src <目录> [--src <目录>...] [--out data/tmp/inbox] [--apply] [--import]
//   默认 dry-run：只打印计划，不写任何文件。--apply 产出文件夹+manifest.json；--import 再跑入库。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseOcrTable, parseTwoColumnTable } from './ocr-table-rows.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.MEDBRIEF_PORT || 5174)
const BASE = 'http://127.0.0.1:' + PORT
const argv = process.argv.slice(2)
const many = (k) => argv.reduce((acc, v, i) => (v === k && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), [])
const one = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const SRC = many('--src')
const OUT = path.resolve(ROOT, one('--out', 'data/tmp/inbox'))
const APPLY = argv.includes('--apply')
const DO_IMPORT = argv.includes('--import')
const CONC = Math.max(1, Math.min(8, Number(one('--concurrency', 6))))

if (!SRC.length) { console.error('用法：node tools/workflow-screenshots.mjs --src <目录> [--src ...] [--apply] [--import]'); process.exit(1) }

// ---------- 1. 发现 ----------
function walk(dir, out = [], depth = 0) {
  if (depth > 2) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!/^(node_modules|\.git)$/.test(e.name)) walk(p, out, depth + 1) }
    else out.push(p)
  }
  return out
}
function sniff(file) {
  const fd = fs.openSync(file, 'r')
  const b = Buffer.alloc(64)
  const n = fs.readSync(fd, b, 0, 64, 0)
  fs.closeSync(fd)
  const buf = b.subarray(0, n)
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'image/gif'
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf'
  return '' // 含微信 V2 加密 .dat（07085632…）→ 解不出，跳过
}

const files = []
for (const d of SRC) for (const f of walk(path.resolve(ROOT, d))) {
  const st = fs.statSync(f)
  if (st.size < 20 * 1024) continue
  if (/_t\.[a-z]+$/i.test(f)) continue // 微信缩略图
  const mime = sniff(f)
  if (!mime) continue
  files.push({ file: f, mime, size: st.size })
}
console.log('[1/7] 发现 ' + files.length + ' 个可读文件（已跳过缩略图/加密 .dat/<20KB）')

// ---------- 2. OCR ----------
const pdfText = (file) => {
  const r = spawnSync('/usr/bin/python3', [ path.join(__dirname, 'pdf-extract.py'), file ], { encoding: 'utf8', maxBuffer: 1 << 26 })
  try {
    const j = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}')
    return { text: (j.pages || []).map((pg) => (pg.lines || []).join('\n')).join('\n\n'), pages: j.pageCount || 0, hasTextLayer: !!j.hasTextLayer }
  } catch { return { text: '', pages: 0, hasTextLayer: false } }
}
const ocr = async (f) => {
  if (f.mime === 'application/pdf') { const p = pdfText(f.file); f.pdfPages = p.pages; f.pdfTextLayer = p.hasTextLayer; return p.text }
  const b64 = fs.readFileSync(f.file).toString('base64')
  const r = await fetch(BASE + '/api/intake/ocr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'data:' + f.mime + ';base64,' + b64 }) })
    .then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }))
  return r.text || ''
}
const CACHE_FILE = path.join(ROOT, 'data/tmp/wf-ocr-cache.json')
let wfCache = {}
try { wfCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) } catch { wfCache = {} }
let ocrHits = 0
for (let i = 0; i < files.length; i += CONC) await Promise.all(files.slice(i, i + CONC).map(async (f) => {
  const ck = f.file + '|' + f.size + '|' + fs.statSync(f.file).mtimeMs
  if (wfCache[ck]) { f.text = wfCache[ck]; ocrHits++; } else { f.text = await ocr(f); wfCache[ck] = f.text }
  f.sha256 = crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex')
}))
try { fs.writeFileSync(CACHE_FILE, JSON.stringify(wfCache)) } catch { /* 缓存失败不影响主流程 */ }
console.log('      OCR 缓存命中 ' + ocrHits + '/' + files.length)
console.log('[2/7] OCR 完成 ' + files.filter((f) => f.text).length + '/' + files.length)

// ---------- 3. 身份 ----------
const flat = (s) => String(s || '').replace(/\s/g, '')
const NO_RE = [
  /(?:报告单号|条码号|报告编号|检测条码|Barcode|条形码)[^A-Z0-9]{0,3}([A-Z0-9]{6,})/,
  /(MAX\d{6,})/,
  /(V\d{11})/,
  /(\d{12,})/,
]
const DATE_RE = /(?:报告时间|报告日期|送检日期|采集时间|接检时间|检测日期)[^0-9]{0,30}(\d{4}-\d{2}-\d{2})(\d{2}:\d{2})?/
for (const f of files) {
  const t = flat(f.text)
  f.no = ((NO_RE.map((re) => (t.match(re) || [])[1]).find(Boolean)) || '').replace(/^([A-Z]?\d{11,12}).*$/, '$1')
  const dm = t.match(DATE_RE)
  f.date = dm ? dm[1] : ''
  f.clock = dm && dm[2] ? dm[2] : ''
  if (!f.date) { const all = t.match(/\d{4}-\d{2}-\d{2}/g); if (all && all.length) { f.date = all[all.length - 1]; f.dateFromFallback = true } }
  f.hospital = (t.match(/就诊医院[^科项]{2,16}/) || t.match(/送检单位[：:]([^姓条]{2,16})/) || [''])[0].replace(/^(就诊医院|送检单位)[：:]?/, '')
  f.item = (t.match(/项目名称([^报]{2,16})/) || ['', ''])[1]
  f.rows = parseOcrTable(f.text).rows
  // PDF 的分子报告是两列定性表；两列比四列多就用两列
  const two = parseTwoColumnTable(f.text)
  if (two.rows.length > f.rows.length) f.rows = two.rows
  if (f.rows.length <= 1 && f.mime === 'application/pdf') f.rows = []   // 单行几乎必是误解析 → 走全文型
  f.invoice = /发票号码|价税合计|电子发票/.test(t)
  // 影像/全文型判定：没有四列指标行，但有检查所见/描述/建议/项目名称
  f.textOnly = f.rows.length < 2
}
// 与库里已有记录对齐（单号 + 报告日期）：已入库的不再重复导
const dbReports = await fetch(BASE + '/api/intake/reports').then((r) => r.json()).catch(() => ({ reports: [] }))
const dbKey = new Set((dbReports.reports || []).map((r) => (r.barcode || '') + '|' + (r.reportDate || '')))
for (const f of files) if (f.no && f.date && dbKey.has(f.no + '|' + f.date)) { f.alreadyInDb = true }
console.log('[3/7] 身份识别：有单号 ' + files.filter((f) => f.no).length + '｜有日期 ' + files.filter((f) => f.date).length + '｜有指标行 ' + files.filter((f) => f.rows.length).length)

// ---------- 4. 查重 ----------
const kept = [], dropped = []
// 查重用的类型判定（要早于完整分类，故抽成独立函数）
const typeOfPre = (f) => {
  const _t = _typeOfPre(f); return normalizeType(_t)
}
const _typeOfPre = (f) => {
  if (f.invoice) return '票据'
  // 版式优先（PDF 分子/核型/病原报告都是全文型，靠行判断会退化成「影像报告」）
  if (/融合基因|BCR::ABL1|BCR-ABL/.test(f.text)) return '融合基因'
  if (/ISCN|染色体核型/.test(f.text)) return '染色体核型'
  if (/高通量测序|宏基因组|mNGS/.test(f.text)) return '病原mNGS'
  if (/免疫分型|Hematolog/.test(f.text)) return '流式免疫分型'
  if (f.textOnly) return f.item || '影像/全文'
  const clean = (s) => String(s).replace(/[（）()\s]/g, '')
  const names = f.rows.map((r) => clean(r.name)).join(' ')
  if (/全血细胞计数|白细胞计数/.test(names)) return '血常规'
  if (/凝血酶原时间|国际标准化比值/.test(names)) return '凝血四项'
  if (/总蛋白|白蛋白|丙氨酸氨基转移/.test(names)) return '生化'
  if (/PH（CH）|尿比重|尿胆原/.test(names)) return '尿常规'
  if (/粪便外观|脂肪球|虫卵/.test(names)) return '粪便常规'
  if (/ABO血型/.test(names)) return 'ABO+RhD 血型'
  if (/红细胞抗体筛查|筛选细胞/.test(names)) return '不规则抗体筛查'
  if (/乙肝表面抗原|丙型肝炎抗体/.test(names)) return '传染病四项'
  if (/甲型肝炎抗体/.test(names)) return '甲肝 IgM'
  if (/戊型肝炎抗体/.test(names)) return '戊肝抗体'
  if (/钠尿肽前体|降钙素原/.test(names)) return '心衰+感染标志物'
  if (/肌红蛋白|肌酸激酶同工酶|肌钙蛋白/.test(names)) return '心肌标志物'
  if (/^pH=|pCO2|剩余碱/.test(names)) return '血气'
  if (/腺病毒/.test(names)) return '呼吸道病原'
  if (/BCR::ABL1|融合基因/.test(f.text)) return '融合基因'
  if (/ISCN|核型/.test(f.text)) return '染色体核型'
  if (/高通量测序|mNGS/.test(f.text)) return '病原mNGS'
  return f.item || '化验其他'
}
const archiveSha = new Set()
try {
  const archRoot = path.join(ROOT, 'data', 'intake')
  for (const pat of fs.readdirSync(archRoot)) {
    const ap = path.join(archRoot, pat, 'archive')
    if (!fs.existsSync(ap)) continue
    for (const d of fs.readdirSync(ap)) {
      const dp = path.join(ap, d)
      if (!fs.statSync(dp).isDirectory()) continue
      for (const f2 of fs.readdirSync(dp)) archiveSha.add(crypto.createHash('sha256').update(fs.readFileSync(path.join(dp, f2))).digest('hex'))
    }
  }
} catch { /* 归档目录不存在就不去重 */ }
const bySha = new Map()
for (const f of files) {
  if (bySha.has(f.sha256)) { dropped.push({ f, why: '字节重复（sha256 相同）' }); continue }
  if (archiveSha.has(f.sha256)) { dropped.push({ f, why: '原件已在 data/intake/**/archive（同一字节，曾导入过）' }); continue }
  bySha.set(f.sha256, f)
}
const byKey = new Map()
for (const f of bySha.values()) {
  const key = f.no ? f.no + '|' + typeOfPre(f) + '|' + f.date : 'NOID|' + f.file
  if (byKey.has(key)) {
    const prev = byKey.get(key)
    const win = f.size > prev.size ? f : prev
    dropped.push({ f: win === f ? prev : f, why: '同单号+同报告时间（保留字节更大者）' })
    byKey.set(key, win)
  } else byKey.set(key, f)
}
for (const f of byKey.values()) kept.push(f)
for (const f of files) if (f.alreadyInDb) { dropped.push({ f, why: '库里已有同单号+同报告日期的记录（不重复导）' }) }
const keptFinal = kept.filter((f) => !f.alreadyInDb)
kept.length = 0; kept.push(...keptFinal)
console.log('[4/7] 查重：' + files.length + ' → ' + kept.length + '（丢弃 ' + dropped.length + '）')
for (const d of dropped) console.log('    - ' + path.basename(d.f.file) + ' — ' + d.why)

// ---------- 5. 跨屏配对 ----------
// 类型命名统一（与库内已入库口径一致）：超声-床旁超声 → 超声-床旁 等
const normalizeType = (t) => {
  const map = {
    '超声-床旁超声': '超声-床旁', '超声-常规超声': '超声-常规', '超声-血管超声': '超声-血管',
    '妇产科-妇科超声': '超声-妇科', '心电图-普通心电': '心电图', 'CT类血管增强': 'CT-血管增强',
    'FLOW_CYTOMETRY': '流式免疫分型', '融合基因（定性）': '融合基因', '融合基因筛查': '融合基因',
  }
  return map[t] || t
}
const num = (s) => { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN }
const nm = (s) => String(s).replace(/[（）()\s]/g, '')
const keyOf = (r) => nm(r.name).replace(/[⑦⑧◎••·]/g, '') + '=' + String(r.value).replace(/[个↑↓丄』J，,]/g, '').slice(0, 6)
const withHead = kept.filter((f) => f.no && f.rows.length)
const noHead = kept.filter((f) => !f.no && f.rows.length)
const pairs = [], orphans = []

// 血常规跨屏铁证：白细胞计数 × 淋巴细胞百分比 ≈ 淋巴细胞计数（分子/分母可以分布在两页上）
const arithOK = (a, b) => {
  const pick = (rows, re) => rows.find((r) => re.test(nm(r.name)))
  const wbc = pick(a.rows, /^白细胞计数/), pctA = pick(a.rows, /淋巴细胞百分比/), lymA = pick(a.rows, /^淋巴细胞计数/)
  const pctB = pick(b.rows, /淋巴细胞百分比/), lymB = pick(b.rows, /^淋巴细胞计数/)
  const combos = [[pctA, lymB], [pctB, lymA], [pctA, lymA], [pctB, lymB]]
  for (const [pct, lym] of combos) {
    if (!wbc || !pct || !lym) continue
    const exp = num(wbc.value) * num(pct.value) / 100, got = num(lym.value)
    if (isFinite(exp) && isFinite(got) && got > 0 && Math.abs(exp - got) / got < 0.05) return true
  }
  return false
}
const novelRatio = (a, b) => {
  const A = new Set(a.rows.map(nm))
  const hit = b.rows.filter((r) => A.has(nm(r.name))).length
  return 1 - hit / Math.max(b.rows.length, 1)
}
const candidates = []
for (const b of noHead) {
  const B = b.rows.map(keyOf)
  for (const a of withHead) {
    const A = a.rows.map(keyOf)
    let k = 0
    // 重叠区可能落在这两屏的交界：b 允许顶部多几行（j≤3），a 允许尾部多一行（i+t ≥ len-1）
    for (let t = Math.min(A.length, B.length); t >= 1 && !k; t--) {
      for (let j = 0; j <= Math.min(3, B.length - t) && !k; j++) {
        const blk = B.slice(j, j + t).join('¦')
        for (let i = Math.max(0, A.length - t - 1); i + t <= A.length; i++) {
          if (A.slice(i, i + t).join('¦') === blk) { k = t; break }
        }
      }
    }
    const arith = arithOK(a, b)
    const novel = novelRatio(a, b)
    const tailHead = A.length && B.length && A[A.length - 1] === B[0] // 页1 末行 == 页2 首行（严格邻接）
    // 三条接受路径：① 算术铁证 ② 重叠≥2 行且 b 大多是续页新行 ③ 末行/首行严格邻接
    if (!(arith || (k >= 2 && novel >= 0.5) || tailHead)) continue
    const score = (arith ? 100 : 0) + (tailHead ? 30 : 0) + k * 10 + novel * 5
    candidates.push({ a, b, k, arith, tailHead, novel: Number(novel.toFixed(2)), score })
  }
}
// 贪心独占分配：一份页1 只能配一份页2，分数高者优先；落选者进孤页（可能是重复截图）
candidates.sort((x, y) => y.score - x.score)
const usedA = new Set(), usedB = new Set()
for (const cd of candidates) {
  if (usedA.has(cd.a.file) || usedB.has(cd.b.file)) continue
  usedA.add(cd.a.file); usedB.add(cd.b.file)
  pairs.push({ p1: cd.a, p2: cd.b, overlap: cd.k, arith: cd.arith, tailHead: cd.tailHead, novel: cd.novel })
}
for (const b of noHead) if (!usedB.has(b.file)) orphans.push(b)
console.log('[5/7] 跨屏配对：成对 ' + pairs.length + ' 组｜无头且无法配对 ' + orphans.length + ' 张')
for (const p of pairs) console.log('    ✓ ' + (p.p1.no || '?') + ' ← ' + path.basename(p.p2.file) + '（重叠 ' + p.overlap + ' 行）')
for (const o of orphans) console.log('    · 孤页 ' + path.basename(o.file))

// ---------- 6. 分类 ----------
const pairedIds = new Set(pairs.flatMap((p) => [p.p1.file, p.p2.file]))
const orphanIds = new Set(orphans.map((f) => f.file))
const invoices = kept.filter((f) => f.invoice)
const lab = kept.filter((f) => !f.textOnly && !f.invoice && !pairedIds.has(f.file) && !orphanIds.has(f.file) && f.rows.length)
const imaging = kept.filter((f) => f.textOnly && !f.invoice && !pairedIds.has(f.file) && !orphanIds.has(f.file))
// 兜底：既没有指标行、也没有全文特征的文件（OCR 出空）→ 一律进孤页，绝不静默丢弃
for (const f of kept) {
  if (f.invoice || pairedIds.has(f.file) || orphanIds.has(f.file) || lab.includes(f) || imaging.includes(f)) continue
  orphans.push(f); orphanIds.add(f.file)
}
if (invoices.length) console.log('    ⚠ 票据（不进报告库，走票据表）：' + invoices.map((f) => path.basename(f.file)).join(', '))
console.log('[6/7] 分类：化验单屏 ' + lab.length + '｜影像/全文 ' + imaging.length + '｜拼接 ' + pairs.length + '｜孤页 ' + orphans.length)
console.log('    合计 ' + (lab.length + imaging.length + pairedIds.size + orphans.length + invoices.length) + '（= 去重后 ' + kept.length + '；拼接计 ' + pairedIds.size + ' 张源页）')

// ---------- 7. 产出 ----------
const entries = []
const mk = (dir, sub) => { const p = path.join(dir, sub); fs.mkdirSync(p, { recursive: true }); return p }
const nameOf = (f, i, label) => String(i).padStart(2, '0') + '_' + (f.date || '00000000').replace(/-/g, '') + '_' + (f.no || '无单号') + '_' + label.slice(0, 14).replace(/[\/\\:*?"<>|]/g, '') + path.extname(f.file)
const typeOf = (f) => {
  const names = f.rows.map((r) => nm(r.name)).join(' ')
  if (/全血细胞计数|白细胞计数/.test(names)) return '血常规'
  if (/凝血酶原时间|国际标准化比值/.test(names)) return '凝血四项'
  if (/总蛋白|白蛋白|丙氨酸氨基转移/.test(names)) return '生化'
  if (/PH（CH）|尿比重|尿胆原/.test(names)) return '尿常规'
  if (/粪便外观|脂肪球|虫卵/.test(names)) return '粪便常规'
  if (/ABO血型/.test(names)) return 'ABO+RhD 血型'
  if (/红细胞抗体筛查|筛选细胞/.test(names)) return '不规则抗体筛查'
  if (/乙肝表面抗原|丙型肝炎抗体/.test(names)) return '传染病四项'
  if (/甲型肝炎抗体/.test(names)) return '甲肝 IgM'
  if (/戊型肝炎抗体/.test(names)) return '戊肝抗体'
  if (/钠尿肽前体|降钙素原/.test(names)) return '心衰+感染标志物'
  if (/肌红蛋白|肌酸激酶同工酶|肌钙蛋白/.test(names)) return '心肌标志物'
  if (/^pH=|pCO2|剩余碱/.test(names)) return '血气'
  if (/腺病毒/.test(names)) return '呼吸道病原'
  return f.item || (f.textOnly ? '影像报告' : '化验其他')
}
if (APPLY) {
  const A = mk(OUT, '批A'), B = mk(OUT, '批B'), J = mk(OUT, '拼接'), JS = mk(OUT, '拼接/源页'), O = mk(OUT, '孤页'), T = mk(OUT, '文字识别')
  let i = 0
  for (const f of lab) {
    i++; const nn = nameOf(f, i, typeOf(f)); fs.copyFileSync(f.file, path.join(A, nn))
    fs.writeFileSync(path.join(T, '化验_' + (f.no || '无号') + '.txt'), f.text, 'utf8')
    entries.push({ file: path.join(A, nn), kind: 'lab', no: f.no, date: f.date, clock: f.clock, hospital: f.hospital, type: typeOf(f), rows: f.rows, text: f.text, sourceFiles: [f.file] })
  }
  for (const f of imaging) {
    i++; const nn = nameOf(f, i, f.item || '影像'); fs.copyFileSync(f.file, path.join(B, nn))
    fs.writeFileSync(path.join(T, '影像_' + (f.no || '无号') + '.txt'), f.text, 'utf8')
    entries.push({ file: path.join(B, nn), kind: 'imaging', no: f.no, date: f.date, clock: f.clock, hospital: f.hospital || '', type: f.item || '影像报告', rows: [], text: f.text, sourceFiles: [f.file] })
  }
  for (const p of pairs) {
    i++
    const a = p.p1, b = p.p2
    const st = await fetch(BASE + '/api/intake/stitch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: [a, b].map((x) => 'data:' + x.mime + ';base64,' + fs.readFileSync(x.file).toString('base64')) }) }).then((x) => x.json())
    if (!st.ok) { console.log('    拼接失败 ' + a.no + '：' + st.error); orphans.push(a, b); continue }
    const outPng = path.join(J, (a.no || '无单号') + '_' + typeOf(a) + '_拼接.png')
    fs.writeFileSync(outPng, Buffer.from(String(st.dataUrl).replace(/^data:image\/[a-z+]+;base64,/i, ''), 'base64'))
    fs.copyFileSync(a.file, path.join(JS, path.basename(a.file)))
    fs.copyFileSync(b.file, path.join(JS, path.basename(b.file)))
    const seen = new Set(), rows = []
    for (const r of [ ...a.rows, ...b.rows ]) { const k = nm(r.name) + '|' + String(r.value).replace(/\s/g, ''); if (seen.has(k)) continue; seen.add(k); rows.push(r) }
    entries.push({ file: outPng, kind: 'lab-stitched', no: a.no, date: a.date, clock: a.clock, hospital: a.hospital, type: typeOf(a), rows, text: a.text + '\n' + b.text, sourceFiles: [a.file, b.file], stitchedFrom: [a.file, b.file], overlapRows: p.overlap })
  }
  for (const f of orphans) { i++; fs.copyFileSync(f.file, path.join(O, '孤页_' + path.basename(f.file))) }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), patient: one('--patient', 'p1'), entries }, null, 1), 'utf8')
}
if (process.env.WF_DEBUG) {
  const nm4 = (f) => path.basename(f.file)
  console.log('  化验:', lab.map(nm4).join(', ') || '-')
  console.log('  影像:', imaging.map(nm4).join(', ') || '-')
  console.log('  拼接:', pairs.map((p) => nm4(p.p1)).join(', ') || '-')
  console.log('  孤页:', orphans.map(nm4).join(', ') || '-')
  console.log('  票据:', invoices.map(nm4).join(', ') || '-')
}
console.log('[7/7] ' + (APPLY ? '已产出 ' + OUT + '（manifest ' + entries.length + ' 份）' : 'DRY-RUN：加 --apply 才会写文件夹与 manifest'))
if (APPLY && DO_IMPORT) {
  const r = spawnSync(process.execPath, [ path.join(__dirname, 'import-inbox.mjs'), '--manifest', path.join(OUT, 'manifest.json'), '--apply' ], { stdio: 'inherit', env: { ...process.env, MEDBRIEF_PORT: String(PORT) } })
  process.exit(r.status || 0)
}
