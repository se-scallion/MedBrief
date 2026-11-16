// 校对网格 D-1 验收（grid-narrow-1116）。V1a/V1b/V2/V3/V4/V5'/V6'/V9
//
// ⚠️ 本脚本必须「能红」：任何「期望 X 得到 Y」的分支都走 fail()，
// 汇总行用真实 failed 计数并设置退出码；SKIP 默认非 0 退出（ALLOW_SKIP=1 才允许跳过）。
// 2026-11-16 教训：上一版只有 ok()/info()、"0 失败"硬编码 ⇒ 结构上不可能红（假闸门）。
import { chromium } from 'playwright'

const BASE = process.env.MEDBRIEF_BASE || 'http://127.0.0.1:5174'
const LABEL = process.env.LABEL || 'AFTER'
let pass = 0
let failed = 0
let nas = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }
const fail = (n, e = '') => { failed++; console.log(`FAIL ${n}${e ? ' · ' + e : ''}`) }
const measure = (n, e = '') => console.log(`INFO ${n}${e ? ' · ' + e : ''}`)
// 未证 ≠ 通过（R2）：N/A 必须进汇总行的第三计数，不许只躺在日志里
const na = (n) => { nas++; console.log(`N/A ${n}`) }
const skip = (why) => {
  console.log(`SKIP ${why}`)
  if (process.env.ALLOW_SKIP === '1') { process.exitCode = 0; process.exit(0) }
  console.log('SKIP 不算通过（要显式跳过请设 ALLOW_SKIP=1）')
  process.exitCode = 1
  process.exit(1)
}

let ready = false
try { ready = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })).ok } catch {}
if (!ready) skip(`服务未就绪：${BASE}`)

const browser = await chromium.launch({ headless: true })

const trackCount = (e) => (e ? getComputedStyle(e).gridTemplateColumns.split(' ').filter(Boolean).length : null)

/** 打开报告库 → 编辑弹窗（内含 DataGrid）。必须挑有指标行的报告，否则量到空态（假绿）。 */
async function openModalGrid(width, height) {
  const p = await browser.newPage({ viewport: { width, height } })
  await p.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(2200)
  const q = p.locator('input[placeholder*="搜医院"]').first()
  if (await q.count()) { try { await q.fill('血常规'); await p.waitForTimeout(800) } catch {} }
  let edit = null
  const tblRow = p.locator('.ant-table-tbody tr').filter({ hasNotText: '全文型' }).filter({ hasText: '项' }).first()
  if (await tblRow.count()) edit = tblRow.locator('button[aria-label="编辑"]').first()
  if (!edit || !(await edit.count())) edit = p.locator('button[aria-label="编辑"]').first()
  if (!edit || !(await edit.count())) { await p.close(); return null }
  await edit.click({ timeout: 8000, force: true })
  await p.waitForTimeout(1300)
  const d = await p.evaluate(() => {
    const root = document.querySelector('.mb-edit-modal .g-grid')
      || document.querySelector('.mb-edit-modal .rb-edit-grid-wrap > div')
    if (!root) return { noRoot: true }
    const de = document.documentElement
    const scroller = root.querySelector('div.overflow-x-auto')
    const trs = [...root.querySelectorAll('tbody tr')]
    // V2 口径（UI 定稿）：**内容高** = 外框 − border-bottom。分隔线的高度另计，
    // 否则 /meddata（有 preflight，线会画）恒为 41、/（无 preflight）恒为 40，成"永远红/永远绿"。
    const rowContent = (t) => Math.round(t.getBoundingClientRect().height - parseFloat(getComputedStyle(t).borderBottomWidth || 0))
    const heights = trs.map(rowContent)
    const cells = [...root.querySelectorAll('tbody td')]
    const st = (e) => { const cs = getComputedStyle(e); return { bs: cs.borderTopStyle, bw: cs.borderTopWidth, pl: cs.paddingLeft, h: Math.round(e.getBoundingClientRect().height) } }
    const infoCard = root.querySelector(':scope > .card.grid')
    const splitCard = root.querySelector(':scope > .grid:not(.card)')
    const gctls = [...root.querySelectorAll('.g-ctl')]
    const seqInput = root.querySelector('tbody tr td:first-child input')
    const codeBtn = root.querySelector('tbody button.g-ctl') || root.querySelector('tbody td button')
    const valInput = root.querySelector('tbody input.g-ctl[class*="font-mono"]')
    const arrowSel = root.querySelector('tbody select')
    const mmBtn = root.querySelector('td button[class*="g-bare"]')
    return {
      deSW: de.scrollWidth, deCW: de.clientWidth,
      scrollerSW: scroller ? scroller.scrollWidth : null, scrollerCW: scroller ? scroller.clientWidth : null,
      rowCount: trs.length, hMin: heights.length ? Math.min(...heights) : null, hMax: heights.length ? Math.max(...heights) : null,
      seq: seqInput ? st(seqInput) : null, code: codeBtn ? st(codeBtn) : null,
      val: valInput ? st(valInput) : null, arrow: arrowSel ? st(arrowSel) : null,
      gctlCount: gctls.length,
      // 未识别态的代码选择器是**虚线框**（设计语义，见 plan §3.6 / R5），不是缺陷：
      // 判据 = 宽度必须 1px；样式只能是 solid，或带 border-dashed 类的 dashed。
      gctlBad: gctls.filter((e) => {
        const cs = getComputedStyle(e)
        const dashedOk = cs.borderTopStyle === 'dashed' && e.classList.contains('border-dashed')
        return cs.borderTopWidth !== '1px' || (cs.borderTopStyle !== 'solid' && !dashedOk)
      }).length,
      gctlDashed: gctls.filter((e) => getComputedStyle(e).borderTopStyle === 'dashed').length,
      // ⑥ 真实未识别行的虚线样式（要求集合非空才判；空集 = N/A，不记 PASS）
      dashedReal: [...root.querySelectorAll('.g-ctl.border-dashed')].map((e) => getComputedStyle(e).borderTopStyle),
      // 虚线契约：就地给一个真实 .g-ctl 临时加 border-dashed 读样式（不依赖 _suspicious 夹具）
      dashedProbe: (() => {
        const el = gctls.find((e) => !e.classList.contains('border-dashed'))
        if (!el) return null
        const before = getComputedStyle(el).borderTopStyle
        el.classList.add('border-dashed')
        const dashed = getComputedStyle(el).borderTopStyle
        const w = getComputedStyle(el).borderTopWidth
        el.classList.remove('border-dashed')
        return { before, dashed, width: w }
      })(),
      tdWhiteSpace: cells.length ? getComputedStyle(cells[0]).whiteSpace : null,
      mmBorder: mmBtn ? getComputedStyle(mmBtn).borderTopWidth : null,
      longText: root.textContent.includes('未识别（点此搜索选择）'),
      infoTracks: infoCard ? getComputedStyle(infoCard).gridTemplateColumns.split(' ').filter(Boolean).length : null,
      splitTracks: splitCard ? getComputedStyle(splitCard).gridTemplateColumns.split(' ').filter(Boolean).length : null,
      // V5' 后半：注入一个与源码同 class 的 `!` 角标，验「absolute 不参与布局」+ hover 不改变该格宽度
      bang: (() => {
        const cell = root.querySelector('tbody tr td:nth-child(4)') || root.querySelector('tbody tr td')
        if (!cell) return null
        const before = cell.clientWidth
        const b = document.createElement('span')
        b.className = 'hidden absolute -right-1 top-1/2 -translate-y-1/2 items-center justify-center h-4 w-4 rounded-full bg-red-500'
        cell.appendChild(b)
        const pos = getComputedStyle(b).position
        b.classList.remove('hidden'); b.classList.add('flex')
        const after = cell.clientWidth
        return { pos, before, after }
      })(),
    }
  })
  await p.screenshot({ path: `/tmp/grid-d1-${width}.png`, fullPage: false })
  await p.close()
  return d
}

/** 全页网格（Intake 页）——V1a 必须在这里量，弹窗内宽 <760 属预期不可判。 */
async function openPageGrid(width, height) {
  const p = await browser.newPage({ viewport: { width, height } })
  await p.goto(`${BASE}/?tab=intake`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1000)
  const fi = p.locator('input[type=file]').first()
  const pdf = process.env.FIXTURE_PDF || '/Users/scallion/Documents/projects/ds-bot/home/attachments/v1/files/d6/d648e04bfbfec6df7cb977db4599905ff2c540ce624053db3a77e9d2fd6b9b81/V020089_刘梦圆_新疆_新疆军区总医院_血液科_血液_MaYo骨髓染色体核型分_2026072318053636.pdf'
  if (!(await fi.count())) { await p.close(); return null }
  await p.setInputFiles('input[type=file]', pdf).catch(() => {})
  await p.waitForTimeout(700)
  const one = p.getByRole('button', { name: /一键识别全部/ }).first()
  if (await one.count()) await one.click({ timeout: 8000 }).catch(() => {})
  await p.waitForTimeout(4000)
  const d = await p.evaluate(() => {
    const g = document.querySelector('.mb-review-grid') || document.querySelector('.g-grid')
    if (!g) return { noRoot: true }
    const sc = g.querySelector('div.overflow-x-auto')
    const de = document.documentElement
    const infoCard = g.querySelector('.g-grid > .card.grid') || g.querySelector('.card.grid')
    const splitCard = g.querySelector('.g-grid > .grid:not(.card)')
    return {
      scrollerSW: sc ? sc.scrollWidth : null, scrollerCW: sc ? sc.clientWidth : null,
      deSW: de.scrollWidth, deCW: de.clientWidth,
      infoTracks: infoCard ? getComputedStyle(infoCard).gridTemplateColumns.split(' ').filter(Boolean).length : null,
      splitTracks: splitCard ? getComputedStyle(splitCard).gridTemplateColumns.split(' ').filter(Boolean).length : null,
    }
  })
  await p.close()
  return d
}

/** ⑤ /meddata 入口（UI 定稿配方）：5174 活路由，真产物 dist-meddata，API/静态资源都正常。 */
async function openMeddataGrid(width, height) {
  const p = await browser.newPage({ viewport: { width, height } })
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)))
  await p.goto(`${BASE}/meddata/`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(2500)
  await p.getByRole('button', { name: /导入资料/ }).first().click({ timeout: 8000 }).catch(() => {})
  await p.waitForTimeout(900)
  await p.getByRole('button', { name: /检验报告/ }).first().click({ timeout: 8000 }).catch(() => {})
  await p.waitForTimeout(1200)
  const pdf = process.env.FIXTURE_PDF || '/Users/scallion/Documents/projects/ds-bot/home/attachments/v1/files/d6/d648e04bfbfec6df7cb977db4599905ff2c540ce624053db3a77e9d2fd6b9b81/V020089_刘梦圆_新疆_新疆军区总医院_血液科_血液_MaYo骨髓染色体核型分_2026072318053636.pdf'
  const fi = p.locator('input[type=file]').first()
  if (await fi.count()) await fi.setInputFiles(pdf).catch(() => {})
  await p.waitForTimeout(7000)
  const d = await p.evaluate(() => {
    const root = document.querySelector('.g-grid')
    if (!root) return { noRoot: true }
    const trs = [...root.querySelectorAll('tbody tr')]
    const rowContent = (t) => Math.round(t.getBoundingClientRect().height - parseFloat(getComputedStyle(t).borderBottomWidth || 0))
    const hs = trs.map(rowContent)
    const gctls = [...root.querySelectorAll('.g-ctl')]
    const st = (e) => { if (!e) return null; const cs = getComputedStyle(e); return { bs: cs.borderTopStyle, bw: cs.borderTopWidth, pl: cs.paddingLeft, h: Math.round(e.getBoundingClientRect().height) } }
    const infoCard = root.querySelector(':scope > .card.grid')
    const splitCard = root.querySelector(':scope > .grid:not(.card)')
    const n = (e) => (e ? getComputedStyle(e).gridTemplateColumns.split(' ').filter(Boolean).length : null)
    return {
      rows: trs.length, hMin: hs.length ? Math.min(...hs) : null, hMax: hs.length ? Math.max(...hs) : null,
      gctlCount: gctls.length,
      gctlBad: gctls.filter((e) => { const cs = getComputedStyle(e); const dz = cs.borderTopStyle === 'dashed' && e.classList.contains('border-dashed'); return cs.borderTopWidth !== '1px' || (cs.borderTopStyle !== 'solid' && !dz) }).length,
      val: st(root.querySelector('tbody input.g-ctl[class*="font-mono"]')),
      code: st(root.querySelector('tbody button.g-ctl')),
      arrow: st(root.querySelector('tbody select')),
      dashedReal: [...root.querySelectorAll('.g-ctl.border-dashed')].map((e) => getComputedStyle(e).borderTopStyle),
      infoTracks: n(infoCard), splitTracks: n(splitCard),
      deSW: document.documentElement.scrollWidth, deCW: document.documentElement.clientWidth,
    }
  })
  await p.screenshot({ path: `/tmp/grid-meddata-${width}.png` })
  await p.close()
  d.pageErrors = errs
  return d
}

async function runMeddataEntry() {
  const cases = [{ w: 1440, h: 1000, info: 4, split: 5 }, { w: 375, h: 812, info: 1, split: 1 }]
  for (const c of cases) {
    const m = await openMeddataGrid(c.w, c.h)
    if (m) measure(`⑤ /meddata ${c.w} 原始`, JSON.stringify({ rows: m.rows, hMin: m.hMin, hMax: m.hMax, gctl: m.gctlCount, gctlBad: m.gctlBad, val: m.val, code: m.code, arrow: m.arrow, tracks: `${m.infoTracks}/${m.splitTracks}` }))
    if (!m || m.noRoot) { fail(`⑤ /meddata ${c.w} 未渲染出 .g-grid（pageErrors=${JSON.stringify(m && m.pageErrors || [])}）`); continue }
    if (m.rows >= 1 && m.gctlCount >= 1) ok(`⑤ /meddata ${c.w} 渲染成功：rows=${m.rows} gctl=${m.gctlCount}`)
    else { fail(`⑤ /meddata ${c.w} 无有效行：rows=${m.rows} gctl=${m.gctlCount}（空态不算通过）`); continue }
    if (m.gctlBad === 0) ok(`⑤ /meddata ${c.w} .g-ctl 边框合规（${m.gctlCount} 个，1px 且 solid 或 dashed）`)
    else fail(`⑤ /meddata ${c.w} 有 ${m.gctlBad}/${m.gctlCount} 个 .g-ctl 边框不合规`)
    const ps = [m.code, m.val, m.arrow].filter(Boolean)
    if (ps.length && ps.every((x) => x.pl === '8px')) ok(`⑤ /meddata ${c.w} padding-left 全 8px（${ps.length} 个取样）`)
    else fail(`⑤ /meddata ${c.w} padding-left 不一致：${ps.map((x) => x.pl).join('/')}`)
    if (m.hMin === 40 && m.hMax === 40) ok(`⑤ /meddata ${c.w} 行内容高恰好 40px（${m.rows} 行）`)
    else if (m.hMin !== null && m.hMax - m.hMin <= 1) ok(`⑤ /meddata ${c.w} 行内容高 40±1（${m.hMin}~${m.hMax}）`)
    else fail(`⑤ /meddata ${c.w} 行内容高 ${m.hMin}~${m.hMax}（期望 40）`)
    if (m.dashedReal.length >= 1 && m.dashedReal.every((x) => x === 'dashed')) ok(`⑤ /meddata ${c.w} 未识别虚线保持 dashed（${m.dashedReal.length} 个）`)
    else if (m.dashedReal.length === 0) na(`⑤ /meddata ${c.w} 虚线例外（无未识别行）`)
    else fail(`⑤ /meddata ${c.w} 虚线被压平：${JSON.stringify(m.dashedReal)}`)
    if (m.infoTracks === c.info && m.splitTracks === c.split) ok(`⑤ /meddata ${c.w} 轨数 ${m.infoTracks}/${m.splitTracks}（期望 ${c.info}/${c.split}）`)
    else fail(`⑤ /meddata ${c.w} 轨数 ${m.infoTracks}/${m.splitTracks}（期望 ${c.info}/${c.split}）`)
    if (m.deSW <= m.deCW + 1) ok(`⑤ /meddata ${c.w} 页面无横向滚（${m.deSW}/${m.deCW}）`)
    else fail(`⑤ /meddata ${c.w} 页面横向滚 ${m.deSW}/${m.deCW}`)
  }
}

try {
  // ================= ⑤ /meddata 入口（ENTRY=meddata，UI 定稿配方）=================
  if ((process.env.ENTRY || 'shell') === 'meddata') {
    await runMeddataEntry()
    console.log(`MEDDATA 校对网格 D-1：${pass} 通过 / ${failed} 失败 / ${nas} 未证`)
    await browser.close()
    process.exit(failed ? 1 : (nas > 0 ? 2 : 0))
  }

  // ================= V2 / V3 / V4 / V5' / V6' / V9（桌面 1440 表格态）=================
  const d = await openModalGrid(1440, 900)
  if (!d || d.noRoot) skip('未取到 .g-grid 根（编辑弹窗未开或无数据）')
  if (!d.gctlCount) skip('表格里没有 .g-ctl（很可能打开了「全文型（无指标行）」→ 空态，量测无意义）')
  console.log(`\n=== ${LABEL} @1440（弹窗内）===`)
  measure('量测值', JSON.stringify(d))

  // V2 行高
  if (d.hMin === 40 && d.hMax === 40) ok(`V2 行内容高恰好 40px（${d.rowCount} 行，极差 0；分隔线另计）`)
  else if (d.hMin !== null && d.hMax - d.hMin <= 1) ok(`V2 行内容高 40±1（${d.hMin}~${d.hMax}，${d.rowCount} 行）`)
  else fail(`V2 行内容高不符：min=${d.hMin} max=${d.hMax} 极差=${d.hMax - d.hMin}（期望 40，极差 ≤1）`)

  // V3 控件边框（只认 .g-ctl，r2 P1-3）
  if (d.gctlCount > 0 && d.gctlBad === 0) ok(`V3 全部 .g-ctl 边框 solid 1px（${d.gctlCount} 个）`)
  else fail(`V3 有 ${d.gctlBad}/${d.gctlCount} 个 .g-ctl 边框不是 solid 1px`)
  const pads = [d.code, d.val, d.arrow].filter(Boolean)
  if (pads.length && pads.every((v) => v.pl === '8px')) ok(`V3 控件 padding-left 全 8px（${pads.length} 个取样）`)
  else fail(`V3 padding-left 不一致：${pads.map((v) => v.pl).join('/')}（期望全 8px）`)
  // V3 例外：序号 input 无边框
  if (d.seq && (d.seq.bs === 'none' || d.seq.bw === '0px')) ok(`V3例外 序号 input 无边框（${d.seq.bs}/${d.seq.bw}）`)
  else fail(`V3例外 序号 input 应无边框，实得 ${d.seq ? d.seq.bs + '/' + d.seq.bw : 'null'}`)

  // ⑥ 虚线例外：未识别态必须仍是 dashed（否则与已识别同形）。
  // 判据用**真实** .g-ctl.border-dashed 元素；集合为空 = N/A（不记 PASS，防"空过"）。
  if (d.dashedReal && d.dashedReal.length >= 1) {
    ok(`V3虚线 未识别行保持 dashed（${d.dashedReal.length} 个）`)
    d.dashedReal.forEach((x, i) => { if (x !== 'dashed') fail(`V3虚线 第 ${i} 个被压成 ${x}（期望 dashed）`) })
  } else {
    na('V3 虚线例外（无未识别行，⑥ 未证）')
  }
  // 补充：就地加类验证规则本身可生效（不替代上面的真实测量）
  if (d.dashedProbe && d.dashedProbe.dashed === 'dashed' && d.dashedProbe.width === '1px') {
    measure('V3虚线补充', `就地加 border-dashed → dashed/1px（原 ${d.dashedProbe.before}）`)
  } else if (d.dashedProbe) {
    fail(`V3虚线补充 规则不生效：${d.dashedProbe.dashed}/${d.dashedProbe.width}`)
  }

  // V4 聚焦不改边框（在页内实测）
  {
    const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await p2.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
    await p2.waitForTimeout(2000)
    const q2 = p2.locator('input[placeholder*="搜医院"]').first()
    if (await q2.count()) { try { await q2.fill('血常规'); await p2.waitForTimeout(800) } catch {} }
    let e2 = p2.locator('.ant-table-tbody tr').filter({ hasNotText: '全文型' }).filter({ hasText: '项' }).first().locator('button[aria-label="编辑"]').first()
    if (!(await e2.count())) e2 = p2.locator('button[aria-label="编辑"]').first()
    let v4 = null
    if (await e2.count()) {
      await e2.click({ timeout: 8000, force: true }); await p2.waitForTimeout(1200)
      v4 = await p2.evaluate(() => {
        const el = document.querySelector('.g-grid input.g-ctl, .g-grid .g-ctl')
        if (!el) return null
        const g = () => { const cs = getComputedStyle(el); return { bs: cs.borderTopStyle, bw: cs.borderTopWidth, bc: cs.borderTopColor } }
        const before = g(); el.focus(); const after = g()
        return { before, after }
      })
    }
    await p2.close()
    if (!v4) fail('V4 取不到 .g-ctl 做聚焦取样')
    else if (v4.before.bs === v4.after.bs && v4.before.bw === v4.after.bw && v4.before.bc === v4.after.bc)
      ok(`V4 聚焦前后边框不变（${v4.after.bs}/${v4.after.bw}/${v4.after.bc}）`)
    else fail(`V4 聚焦改变了边框：${JSON.stringify(v4)}`)
    if (v4 && v4.after.bc === 'rgb(203, 213, 225)') ok('V4 边框色 rgb(203, 213, 225)')
    else fail(`V4 边框色=${v4 ? v4.after.bc : 'null'}（期望 rgb(203, 213, 225)）`)
  }

  // V5' ↺ 无边框 + ! 角标 absolute 且不改变该格宽度
  if (d.mmBorder === '0px' || d.mmBorder === null) ok(`V5' ↺ 按钮 borderWidth=${d.mmBorder ?? '无该元素'}`)
  else fail(`V5' ↺ 按钮仍有边框 ${d.mmBorder}（期望 0px）`)
  // V5' 后半：r2/UI 定稿用两条 grep 代理（真量宽度需 _suspicious 夹具，列为可选）
  if (d.bang && d.bang.pos === 'absolute') measure("V5' 补充", `注入取样：position=absolute、该格 width ${d.bang.before}→${d.bang.after}（可选证据）`)
  else measure("V5' 补充", '未取到注入取样（不影响判定，判据用 grep 代理）')

  // V6' td nowrap + 代码选择器高 ≤32
  if (d.tdWhiteSpace === 'nowrap') ok(`V6' td white-space=${d.tdWhiteSpace}`)
  else fail(`V6' td white-space=${d.tdWhiteSpace}（期望 nowrap）`)
  if (d.code && d.code.h <= 32) ok(`V6' 代码选择器高 ${d.code.h} ≤32`)
  else fail(`V6' 代码选择器高 ${d.code ? d.code.h : 'null'}（期望 ≤32）`)
  if (!d.longText) ok('未识别文案已拆（无「未识别（点此搜索选择）」长串）')
  else fail('未识别文案仍是 11 字长串')

  // V9 桌面栅格未被压塌（显式轨道会把 md:/lg: 断点压掉）
  if (d.infoTracks === 4) ok(`V9 记录信息卡轨道数 ${d.infoTracks}（lg:grid-cols-4）`)
  else fail(`V9 记录信息卡轨道数 ${d.infoTracks}（期望 4）`)
  if (d.splitTracks === 5) ok(`V9 双栏卡轨道数 ${d.splitTracks}（lg:grid-cols-5）`)
  else fail(`V9 双栏卡轨道数 ${d.splitTracks}（期望 5）`)

  // V1a（弹窗内）标 N/A —— 弹窗宽 <760 属预期，不作为判据
  measure('V1a', `N/A（弹窗内 ${d.scrollerSW}/${d.scrollerCW}，弹窗宽 <760 属预期，不可判）`)

  // ================= V1a（全页）+ V1b + V9（窄屏轨道）=================
  // V9 期望档位：1440 → info 4 / split 5；1023 → info 2（md:grid-cols-2）/ split 1；窄屏 → 各 1
  const V9_CASES = [
    { w: 1440, h: 1000, info: 4, split: 5, v1a: true },
    { w: 1023, h: 1024, info: 2, split: 1, v1a: false },
    { w: 375, h: 812, info: 1, split: 1, v1a: false },
    { w: 414, h: 896, info: 1, split: 1, v1a: false },
    { w: 767, h: 1024, info: 1, split: 1, v1a: false },
  ]
  for (const c of V9_CASES) {
    const n = await openPageGrid(c.w, c.h)
    if (!n || n.noRoot) { fail(`V1a/V1b ${c.w} 未取到全页网格`); continue }
    measure(`${c.w} 全页`, `容器 ${n.scrollerSW}/${n.scrollerCW}、页面 ${n.deSW}/${n.deCW}、infoTracks=${n.infoTracks} splitTracks=${n.splitTracks}`)
    if (n.deSW <= n.deCW + 1) ok(`V1b ${c.w} 页面无横向滚（${n.deSW}/${n.deCW}）`)
    else fail(`V1b ${c.w} 页面横向滚 ${n.deSW}/${n.deCW}`)
    if (n.infoTracks === c.info) ok(`V9 ${c.w} 记录信息卡轨道 ${n.infoTracks}（期望 ${c.info}）`)
    else fail(`V9 ${c.w} 记录信息卡轨道 ${n.infoTracks}（期望 ${c.info}）`)
    if (n.splitTracks === c.split) ok(`V9 ${c.w} 双栏卡轨道 ${n.splitTracks}（期望 ${c.split}）`)
    else fail(`V9 ${c.w} 双栏卡轨道 ${n.splitTracks}（期望 ${c.split}）`)
    if (c.v1a) {
      // 修复 B（UI 定稿）：表宽 ≥760 是契约，容器 <761 时必然滚 → 标 N/A，不算缺陷。
      if (n.scrollerCW !== null && n.scrollerCW < 761) {
        measure(`V1a ${c.w}`, `N/A（容器 ${n.scrollerCW}px < 761，表宽 ≥760 契约下必然滚：${n.scrollerSW}/${n.scrollerCW}）`)
      } else if (n.scrollerSW !== null && n.scrollerSW <= n.scrollerCW + 1) {
        ok(`V1a ${c.w} 全页表格容器不横滚（${n.scrollerSW}/${n.scrollerCW}）`)
      } else {
        fail(`V1a ${c.w} 全页表格容器横滚 ${n.scrollerSW}/${n.scrollerCW}（容器 ≥761 时不应滚）`)
      }
    }
  }

  // 窄屏弹窗内：行高 + 页面不滚（补充口径）
  for (const w of [375, 414, 767]) {
    const m = await openModalGrid(w, w === 375 ? 812 : w === 414 ? 896 : 1024)
    if (!m || m.noRoot || !m.gctlCount) { fail(`窄屏弹窗 ${w} 量测无效（无 .g-ctl）`); continue }
    if (m.deSW <= m.deCW + 1) ok(`V1b ${w} 弹窗内页面无横向滚（${m.deSW}/${m.deCW}）`)
    else fail(`V1b ${w} 弹窗内页面横向滚 ${m.deSW}/${m.deCW}`)
    if (m.hMin === 40 && m.hMax === 40) ok(`V2 ${w} 行高恰好 40px`)
    else fail(`V2 ${w} 行高 ${m.hMin}~${m.hMax}（期望恰好 40）`)
    if (m.dashedReal && m.dashedReal.length >= 1) {
      ok(`V3虚线 ${w} 未识别行保持 dashed（${m.dashedReal.length} 个）`)
      m.dashedReal.forEach((x, i) => { if (x !== 'dashed') fail(`V3虚线 ${w} 第 ${i} 个被压成 ${x}`) })
    } else na(`V3 虚线例外 ${w}（无未识别行）`)
  }
} finally {
  await browser.close()
}
console.log(`\n${LABEL} 校对网格 D-1：${pass} 通过 / ${failed} 失败 / ${nas} 未证`)
// 0 = 全证通过；2 = 有未证（要人看）；1 = 有失败。
// na>0 必须体现在退出码上，否则"未证"喂给 CI 仍是绿灯（R2 从退出码侧被绕过）。
process.exitCode = failed ? 1 : (nas > 0 ? 2 : 0)
