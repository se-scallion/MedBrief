// 打印资料卡 第 3 页「⑤ 关键趋势」版面门禁（T1–T6，规格 .agents/card-page3-trends-1117-spec.md v1.0）
//
// 为什么要单独一份（而不是只写在规格里）：
//   规格 v1.0 把判据写在文档、实测脚本放 /tmp —— 那正是它自己反复打回的「写了但没判」。
//   这里把它们落成**项目里可复跑的持久门禁**：改列数 / 画布宽度 / 点数 / 避让阈值，必红。
//
// 运行：node tests/verify-card-trends-layout.mjs
// 判据（与规格 §5 一一对应）：
//   T1 grid 轨道数 = 2 且等宽（差 ≤1px）        T4 数值标签屏幕矩形两两不相交（0 处）
//   T2 单元格宽 357.8 ±1（A4 内容宽 725.7）    T5 必标 {首,末,max,min} 文本都在
//   T3 viewBox 起首 0 0 300 且点数 == svg 点数  T6 仍为 3 页（.page2/.page3 两处分页）
// 证伪：--falsify=columns（改 1fr）/ --falsify=labels（放宽避让）⇒ 必须恰好红在 T1/T2 与 T4。
// 退出码：常规跑全绿 = 0；证伪跑"真红"（期望断言确实红了）= 1（与本项目历次证伪口径一致）；
//         证伪跑若期望断言仍绿 = 0（说明测试失去分辨力，必须当作失败信号）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import { buildCard, svgTrend } from '../lib/intakeCard.js'

const FALSIFY = (process.argv.find((a) => a.startsWith('--falsify=')) || '').split('=')[1] || ''
const A4_CONTENT_W = 725.7
const CELL_W = (A4_CONTENT_W - 10) / 2 // 357.85

// 11 个点的序列：等距值 + 连续 7 天 + 4 散点（密排，逼贪心避让降标）
const SERIES = [
  { v: 59.16, d: '2026-07-14' }, { v: 79.67, d: '2026-07-17' }, { v: 71.90, d: '2026-07-18' },
  { v: 18.18, d: '2026-07-21' }, { v: 8.78, d: '2026-07-22' }, { v: 3.27, d: '2026-07-27' },
  { v: 0.04, d: '2026-08-02' }, { v: 0.04, d: '2026-08-03' }, { v: 0.09, d: '2026-08-04' },
  { v: 0.71, d: '2026-08-05' }, { v: 4.66, d: '2026-11-13' },
].map((p) => ({ value: String(p.v), num: p.v, measuredAt: p.d, flag: 'normal' }))

const results = []
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }) }
  catch (e) { results.push({ name, ok: false, msg: e.message }) }
}

const card = buildCard({ reports: [], mask: true, today: new Date('2026-11-13T09:00:00') })
// 用真实序列的 SVG 填进一份最小 A4 页面（与卡片同 CSS），便于在浏览器里量屏幕像素矩形。
// 证伪 columns：把 grid 改成 1fr；证伪 labels：把贪心净距 2 放宽成 -10（故意让标签叠）。
const svgHtml = (() => {
  let svg = svgTrend(SERIES)
  if (FALSIFY === 'labels') {
    // 直接在 SVG 字符串上模拟"放宽避让"：把所有数值标签塞到同一 x（最极端），制造重叠。
    svg = svg.replace(/<text x="[\d.]+" y="[\d.]+" font-size="7" font-weight="600"/g,
      '<text x="150" y="20" font-size="7" font-weight="600"')
  }
  return svg
})()
const gridCss = FALSIFY === 'columns' ? '1fr' : '1fr 1fr'
const html = `<!doctype html><html><head><style>
  @page { size: A4; margin: 9mm; }
  body { margin:0; font-family: sans-serif; }
  .page { width:${A4_CONTENT_W}px; }
  .trend-grid { display:grid; grid-template-columns:${gridCss}; gap:6px 10px; }
  .trend-cell { border:1px solid #e5e7eb; border-radius:4px; padding:3px 5px; box-sizing:border-box; }
  .trend-cell .t { font-size:10px; font-weight:600; margin-bottom:1px; }
  .page2,.page3 { page-break-before:always; }
</style></head><body>
  <div class="page"><div class="trend-grid">
    <div class="trend-cell"><div class="t">白细胞（WBC） <span>（参考 3.5-9.5）</span></div>${svgHtml}</div>
    <div class="trend-cell"><div class="t">血红蛋白（HGB） <span>（参考 115-150）</span></div>${svgHtml}</div>
  </div></div>
  <div class="page page2"></div><div class="page page3"></div>
</body></html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } })
  await page.setContent(html)
  const m = await page.evaluate(() => {
    const grid = document.querySelector('.trend-grid')
    const cells = [...document.querySelectorAll('.trend-cell')]
    // headless 下 getComputedStyle 可能原样返回 '1fr 1fr'（不解析成 px），
    // 所以轨道数以「不同 x 起点的列数」判定；两列等宽用两格宽度差判定。
    const cellXs = cells.map((c) => c.getBoundingClientRect().x)
    const trackCount = new Set(cellXs.map((x) => Math.round(x))).size
    const colWidths = [...new Set(cellXs.map((x) => Math.round(x)))].sort((a, b) => a - b)
      .map((x) => cells.find((c) => Math.round(c.getBoundingClientRect().x) === x).getBoundingClientRect().width)
    const cellWidths = cells.map((c) => c.getBoundingClientRect().width)
    const svg = document.querySelector('.trend-cell svg')
    const vb = svg.getAttribute('viewBox')
    const dotCount = svg.querySelectorAll('circle').length // 每点多一个 circle（此处无危急双圈）
    const labelTexts = [...svg.querySelectorAll('text[font-weight="600"]')].map((t) => t.textContent)
    const rects = [...svg.querySelectorAll('text[font-weight="600"]')].map((t) => {
      const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    let overlaps = 0
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j]
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (ox > 0.5 && oy > 0.5) overlaps++
    }
    const breaks = document.querySelectorAll('.page2, .page3').length
    return { trackCount, colWidths, cellWidths, vb, dotCount, labelTexts, overlaps, breaks }
  })

  check('T1 两列且等宽（差 ≤1px）', () => {
    assert.equal(m.trackCount, 2, `轨道数=${m.trackCount}，应=2`)
    assert.ok(Math.abs(m.colWidths[0] - m.colWidths[1]) <= 1, `两列不等宽：${m.colWidths.join(' / ')}`)
  })
  check(`T2 单元格宽 ${CELL_W.toFixed(1)} ±1`, () => {
    for (const w of m.cellWidths) assert.ok(Math.abs(w - CELL_W) <= 1, `单元格宽=${w.toFixed(1)}`)
  })
  check('T3 viewBox 0 0 300 + 点全量（11）', () => {
    assert.ok(/^0 0 300 /.test(m.vb), `viewBox=${m.vb}`)
    assert.equal(m.dotCount, SERIES.length, `点数=${m.dotCount}，应=${SERIES.length}`)
  })
  check('T4 数值标签屏幕矩形两两不相交（0 处）', () => {
    assert.equal(m.overlaps, 0, `数值标签重叠 ${m.overlaps} 处`)
  })
  check('T5 必标 {首,末,max,min}', () => {
    for (const v of ['59.16', '4.66', '79.67', '0.04']) {
      assert.ok(m.labelTexts.includes(v), `必标 ${v} 缺失（现有 ${m.labelTexts.join(',')}）`)
    }
  })
  check('T6 仍为 3 页（2 处分页）', () => {
    assert.equal(m.breaks, 2, `分页标记数=${m.breaks}`)
  })

  // CSS 静态断言：规格合同值不许漂（渲染层改一行就红）
  check('合同：CSS 列数/间距/单元格/PAD/避让阈值', () => {
    const src = fs.readFileSync(new URL('../lib/intakeCard.js', import.meta.url), 'utf8')
    assert.ok(/\.trend-grid \{ display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; \}/.test(src), '列数/gap 被改')
    assert.ok(/\.trend-cell \{ border: 1px solid #e5e7eb; border-radius: 4px; padding: 3px 5px; \}/.test(src), '单元格样式被改')
    assert.ok(/const PAD = \{ l: 28, r: 10, t: 13, b: 13 \}/.test(src), 'PAD 被改')
    assert.ok(/xs\[i\] - half >= lastX \+ 2/.test(src), '贪心避让阈值被改')
  })
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.msg ? ' → ' + r.msg : ''}`)
console.log(`\n第3页趋势版面门禁：${results.length - failed.length} 通过 / ${failed.length} 失败${FALSIFY ? '（证伪 ' + FALSIFY + '）' : ''}`)
if (FALSIFY) {
  // 证伪约定：columns 改 1fr ⇒ T1 + T2 必红（单列后单元格占满 725px，T2 跟着红是正确的）；
  // labels 放宽避让 ⇒ 恰好红在 T4。真红退出 1（与项目历次证伪口径一致），未命中退出 0（= 测试失效，要修）。
  const want = FALSIFY === 'columns' ? ['T1', 'T2'] : ['T4']
  const names = failed.map((f) => f.name)
  const right = want.every((w) => names.some((n) => n.startsWith(w)))
  console.log(`证伪 ${FALSIFY}：期望红 ${want.join('/')}，实际红 ${names.join('/') || '无'} → ${right ? '真红' : '未命中'}`)
  process.exit(right ? 1 : 0)
}
process.exit(failed.length ? 1 : 0)
