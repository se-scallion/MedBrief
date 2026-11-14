// 资料卡 PDF 页数取证（无头 Chromium，一次性脚本，**不进 server.mjs**）
//
// 为什么单独跑、不进服务（用户 2026-11-13 拍板）：验收对象是**浏览器原生「存为 PDF」**（打印同源），
// 服务端只做无头取证，不值得为它给长驻进程加一个浏览器依赖。
//
// 用法：
//   node tools/card-pdf.mjs                       # 用真实库 data/reports.json
//   node tools/card-pdf.mjs --fixture             # 用脱敏快照（可复跑、与用户导入无关）
//   node tools/card-pdf.mjs --max-pages 3 --out /tmp/card.pdf
//
// 判据（同时打印，便于人工核对）：
//   - 总页数 ≤ --max-pages（默认 3）：正文 1 + 归档 1 + 趋势 1
//   - 第 1 页高度 ≤ A4 可打印高度：否则第 1 页会溢到第 2 页（"一页看完"就不成立）

import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { buildCard } from '../lib/intakeCard.js'

const args = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true)
}
const USE_FIXTURE = args.includes('--fixture')
const MAX_PAGES = Number(flag('max-pages', 3))
const OUT = String(flag('out', '/tmp/medbrief-card.pdf'))

const SNAP = path.join('tests', 'fixtures', 'card-snapshot-v3.json')
let reports
let label
if (USE_FIXTURE) {
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'))
  reports = snap.reports
  label = `脱敏快照（${snap._meta.reportCount} 份 / ${snap._meta.rowCount} 行）`
} else {
  const raw = JSON.parse(fs.readFileSync(path.join('data', 'reports.json'), 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.reports || []
  // 真实库没有 fileBlobId（读侧反查才有）：这里给占位，只为让材料清单渲染出按钮
  reports = list.map((r, i) => ({ ...r, fileBlobId: `f_probe_${i}` }))
  label = `真实库 data/reports.json（${reports.length} 份）`
}

const card = buildCard({ reports, mask: false })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } })
await page.setContent(card.html, { waitUntil: 'load' })
const ALLOW_OVERLAP = args.includes('--allow-overlap')
const geo = await page.evaluate(() => {
  const h = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : null }
  // 像素级重叠/裁切检查（2026-11-14 用户报「数值+单位压到参考区间」「Rh 行被页边裁切」）：
  //   ① 值列文本右边界不得越过参考列文本左边界（撞车）
  //   ② 任何单元格内的元素不得溢出单元格（nowrap 撑破）
  //   ③ 参考列文本不得越过表格右边界（被页边裁切）
  const box = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect() }
  const overlaps = []
  for (const tr of document.querySelectorAll('tr')) {
    const tds = [...tr.children]
    if (tds.length < 3) continue
    const vTd = tds[tds.length - 2]
    const refTd = tds[tds.length - 1]
    const label = String(tds[0].textContent || '').trim().slice(0, 18)
    const vr = box(vTd)
    const rr = box(refTd)
    if (vr.width && rr.width && vr.right > rr.left + 0.5) {
      overlaps.push({ kind: '撞车', row: label, over: Math.round(vr.right - rr.left) })
    }
    const tbl = tr.closest('table')
    if (tbl && rr.width && rr.right > tbl.getBoundingClientRect().right + 0.5) {
      overlaps.push({ kind: '裁切', row: label, over: Math.round(rr.right - tbl.getBoundingClientRect().right) })
    }
    for (const cell of [vTd, refTd]) {
      const cr = cell.getBoundingClientRect()
      for (const el of cell.querySelectorAll('*')) {
        const er = el.getBoundingClientRect()
        if (er.width && (er.right > cr.right + 0.5 || er.left < cr.left - 0.5)) {
          overlaps.push({ kind: '溢出', row: label, over: Math.round(er.right - cr.right) })
        }
      }
    }
  }
  return { page1: h('.page1'), page2: h('.page2'), page3: h('.page3'), body: Math.round(document.body.scrollHeight), overlaps: overlaps.slice(0, 20), overlapCount: overlaps.length }
})
await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  margin: { top: '9mm', bottom: '9mm', left: '9mm', right: '9mm' },
})
await browser.close()

const buf = fs.readFileSync(OUT)
const txt = buf.toString('latin1')
const counts = [...txt.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]))
const pages = counts.length ? Math.max(...counts) : null

// A4 可打印高度：297mm - 18mm 边距 = 279mm ≈ 1054px（96dpi）
const A4_CONTENT_PX = Math.round((279 / 25.4) * 96)
const page1Fits = geo.page1 != null && geo.page1 <= A4_CONTENT_PX

console.log(`\n资料卡 PDF 取证 · ${label}`)
console.log(`  counts        ${JSON.stringify(card.counts)}`)
console.log(`  第 1 页高度   ${geo.page1} px（A4 可打印 ${A4_CONTENT_PX} px）→ ${page1Fits ? '✅ 压在 1 页 A4 内' : '❌ 溢出'}`)
console.log(`  第 2/3 页高度 ${geo.page2} / ${geo.page3} px（第 2 页余量 ${A4_CONTENT_PX - (geo.page2 ?? 0)} px）`)
console.log(`  重叠/裁切   ${geo.overlapCount === 0 ? '✅ 0 处' : `❌ ${geo.overlapCount} 处 → ${JSON.stringify(geo.overlaps.slice(0, 6))}`}`)
console.log(`  PDF 总页数    ${pages}（上限 ${MAX_PAGES}）${pages != null && pages <= MAX_PAGES ? ' ✅' : ' ❌'}`)
console.log(`  输出          ${OUT}（${(buf.length / 1024).toFixed(1)} KB）`)

const cleanFits = ALLOW_OVERLAP || geo.overlapCount === 0
const ok = page1Fits && pages != null && pages <= MAX_PAGES && cleanFits
if (!ok) {
  console.error(`\n❌ 版式未达判据：第 1 页 ${page1Fits ? 'OK' : '溢出'} / 总页数 ${pages}（上限 ${MAX_PAGES}）` +
    (cleanFits ? '' : ` / 重叠或裁切 ${geo.overlapCount} 处`))
  process.exit(1)
}
console.log('\n✅ 版式达判据：第 1 页 1 页 A4、总页数在上限内、第 2 页零重叠零裁切')
