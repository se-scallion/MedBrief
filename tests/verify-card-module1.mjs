// 模块① Ph 两时点展示门禁（UI 规格 v1.3 §5 + §6 判据 M1–M7）
//
// 用户口径：模块① Ph 区显示「定性阳性 → 定量归零，相隔 N 天」，只摆原始值/日期/方法/派生天数，
//   **不写"转阴/缓解/分子学反应"等结论**（保持"半覆盖"、不定判断条件）。
//   A 线 6 格仍挂起、B 线打印附页未动 —— M6 断言本批不偷带它们。
//
// 运行：node tests/verify-card-module1.mjs
// 判据：M1 两时点（同年短格式/跨年完整）  M2 相隔N天 + .ph-gap 加粗 M3 天数动态（+1/-1天变74/72）
//       M4 版面不破（4格等宽/page1≤1055）  M5 字号口径  M6 不偷带A线(.risk-grid不存在)  M7 Ph块内无结论词
// 证伪：--falsify=hardcode（天数写成字面量73）⇒ M3 红；--falsify=conclusion（塞"分子学反应良好"）⇒ M7 红。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import { buildCard } from '../lib/intakeCard.js'

const FALSIFY = (process.argv.find((a) => a.startsWith('--falsify=')) || '').split('=')[1] || ''
const REPORTS = JSON.parse(fs.readFileSync(new URL('../data/reports.json', import.meta.url), 'utf8'))
const clone = () => JSON.parse(JSON.stringify(REPORTS.reports))
const BAN_WORDS = /转阴|阴转|分子学反应|MRR|CMR|完全缓解|缓解|良好|显著|有效|达标|优于|提示/

const results = []
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }) }
  catch (e) { results.push({ name, ok: false, msg: e.message }) }
}

// ---- 造 fixture：真实库；证伪时改数据流 ----
let reports = clone()
const quantRow = () => {
  for (const r of reports) for (const row of (r.rows || [])) {
    if (/P190/i.test(row.name || '') && /\/ABL/i.test(row.name || '') && /%/.test(row.unit || '')) return row
  }
  return null
}
if (FALSIFY === 'date-plus1' || FALSIFY === 'date-minus1') {
  const row = quantRow()
  assert.ok(row, 'fixture 应有 P190/ABL 定量行')
  const d = new Date(`${row.reportDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + (FALSIFY === 'date-plus1' ? 1 : -1))
  const nd = d.toISOString().slice(0, 10)
  row.reportDate = nd; row.measuredAt = nd
}
const card = buildCard({ reports })
let html = card.html
if (FALSIFY === 'hardcode') html = html.replace(/相隔 \d+ 天/g, '相隔 73 天')
if (FALSIFY === 'conclusion') html = html.replace('</div></div></div>', '分子学反应良好</div></div></div>')

// Ph 渲染块（page1 之后第一个 .ph-duo），避免量到 CSS 注释
const bodyHtml = html.slice(html.indexOf('<div class="page1"'))
const phStart = bodyHtml.indexOf('<div class="ph-duo"')
const phBlock = phStart < 0 ? '' : bodyHtml.slice(phStart, bodyHtml.indexOf('</div></div>', phStart) + 12)

check('M1 两时点都在（同年短格式；日期随 fixture）', () => {
  const q = card.phHits?.quant?.date || ''
  const second = q ? (q.slice(0, 4) === (card.phHits?.qual?.date || '').slice(0, 4) ? q.slice(5) : q) : '09-29'
  assert.ok(phBlock.includes('07-18'), 'Ph 块缺 07-18')
  assert.ok(phBlock.includes(second), `Ph 块缺第二时点 ${second}`)
})
check('M2 相隔天数出现且 Ph 块无硬编码以外的形态', () => {
  const want = FALSIFY === 'date-plus1' ? 74 : FALSIFY === 'date-minus1' ? 72 : 73
  assert.ok(phBlock.includes(`相隔 ${want} 天`), `Ph 块应含"相隔 ${want} 天"，实际: ${phBlock}`)
})
check('M3 天数不是字面量（+1/-1 天 ⇒ 74/72）', () => {
  if (FALSIFY === 'hardcode') {
    // 证伪模式：源码被替换成硬编码，改日期后仍 73 ⇒ 应红
    const r2 = clone(); const q = (() => { for (const r of r2) for (const x of (r.rows||[])) if (/P190/i.test(x.name||'')&&/\/ABL/i.test(x.name||'')&&/%/.test(x.unit||'')) return x })()
    const d = new Date(`${q.reportDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+1); const nd=d.toISOString().slice(0,10); q.reportDate=nd; q.measuredAt=nd
    const h2 = buildCard({ reports: r2 }).html.replace(/相隔 \d+ 天/g, '相隔 73 天')
    const b2 = h2.slice(h2.indexOf('<div class="page1"'))
    assert.ok(!b2.includes('相隔 74 天'), '硬编码时 +1 天不该变 74（若变了说明证伪没生效）')
    throw new Error('硬编码证伪：+1 天后仍应为 73，证明天数确实是字面量（M3 红）')
  }
  const want = FALSIFY === 'date-plus1' ? 74 : FALSIFY === 'date-minus1' ? 72 : 73
  assert.equal(card.phHits?.days, want, `phHits.days=${card.phHits?.days} 应=${want}`)
})
check('M6 不偷带 A 线 6 格', () => {
  assert.ok(!html.includes('risk-grid'), '本批不应渲染 .risk-grid（A 线挂起）')
})
check('M7 Ph 块内无结论词', () => {
  const hit = phBlock.match(BAN_WORDS)
  assert.equal(hit, null, `Ph 块含结论词「${hit}」：${phBlock}`)
})
check('合同：源码无"73"字面量、禁词不在 Ph 渲染模板', () => {
  const src = fs.readFileSync(new URL('../lib/intakeCard.js', import.meta.url), 'utf8')
  assert.ok(!/相隔\s*73\s*天/.test(src), '源码不得写死"相隔 73 天"')
})

// ---- 浏览器量几何（M4/M5/M2 字号） ----
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } })
  await page.setContent(html)
  const geo = await page.evaluate(() => {
    const gap = document.querySelector('.ph-duo .ph-gap')
    const row = document.querySelector('.ph-duo .ph-row')
    const src = document.querySelector('.ph-duo .ph-src')
    const cells = document.querySelectorAll('.sb-cell')
    const xs = [...cells].map((c) => Math.round(c.getBoundingClientRect().x))
    const widths = [...new Set(xs)].sort((a,b)=>a-b).map((x) => [...cells].find((c)=>Math.round(c.getBoundingClientRect().x)===x).getBoundingClientRect().width)
    const cs = (el) => el ? getComputedStyle(el) : null
    return {
      gapText: gap?.textContent || '',
      gapWeight: cs(gap)?.fontWeight, gapSize: cs(gap)?.fontSize,
      rowSize: cs(row)?.fontSize, srcSize: cs(src)?.fontSize,
      cellCount: cells.length, widths,
      page1H: document.querySelector('.page1')?.getBoundingClientRect().height || 0,
    }
  })
  check('M2b .ph-gap 8px/700', () => {
    assert.equal(geo.gapWeight, '700', `fontWeight=${geo.gapWeight}`)
    assert.equal(geo.gapSize, '8px', `fontSize=${geo.gapSize}`)
  })
  check('M5 字号口径 .ph-row=9 / .ph-src=8', () => {
    assert.equal(geo.rowSize, '9px', `ph-row=${geo.rowSize}`)
    assert.equal(geo.srcSize, '8px', `ph-src=${geo.srcSize}`)
  })
  check('M4 四格等宽 + page1 ≤1055px', () => {
    assert.equal(geo.cellCount, 4, `sb-cell=${geo.cellCount}`)
    assert.ok(geo.widths.length && Math.abs(geo.widths[0]-geo.widths[geo.widths.length-1])<=1, `列宽: ${geo.widths}`)
    assert.ok(geo.page1H <= 1055, `page1 高=${geo.page1H.toFixed(1)} > 1055`)
  })
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.msg ? ' → ' + r.msg : ''}`)
console.log(`\n模块① Ph 两时点门禁：${results.length - failed.length} 通过 / ${failed.length} 失败${FALSIFY ? '（证伪 ' + FALSIFY + '）' : ''}`)

if (FALSIFY) {
  const want = FALSIFY === 'hardcode' ? 'M3' : FALSIFY === 'conclusion' ? 'M7' : null
  const right = want ? failed.some((f) => f.name.startsWith(want)) : false
  console.log(`证伪 ${FALSIFY}：期望红 ${want || '—'} → ${right ? '真红' : '未命中'}`)
  process.exit(right ? 1 : 0)
}
process.exit(failed.length ? 1 : 0)
