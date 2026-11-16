// 编辑报告弹窗 375 版面断言（G1–G12，按 .agents/edit-modal-1116-review-r1.md §6）
//
// 用户两轮实测：(1) 顶部 108px 空余 + 整页下滑；(2) 两层 padding 叠加 + 版面对不齐。
// 本文件钉死整改后的几何判据，防止下次会话把 padding 又加回去。
// 真浏览器、只读、不写库；服务未起时 SKIP 并退出 0。
import { chromium } from 'playwright'

const BASE = process.env.MEDBRIEF_BASE || 'http://127.0.0.1:5174'
let pass = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }
let ready = false
try { ready = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })).ok } catch {}
if (!ready) { console.log('SKIP 编辑弹窗 375 断言：5174 未就绪'); process.exit(0) }

const browser = await chromium.launch({ headless: true })

/** 打开报告库 → 编辑弹窗，返回量到的全部几何 */
async function measure(width, height) {
  const p = await browser.newPage({ viewport: { width, height } })
  await p.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1500)
  const edit = p.locator('button[aria-label="编辑"]').first()
  if (!(await edit.count())) { await p.close(); return null }
  await edit.click({ timeout: 8000, force: true })
  await p.waitForTimeout(1300)
  const m = await p.evaluate(() => {
    const w = document.querySelector('.mb-edit-modal')
    if (!w) return null
    const body = w.querySelector('.ant-modal-body')
    const head = w.querySelector('.ant-modal-header')
    const foot = w.querySelector('.ant-modal-footer')
    const close = w.querySelector('.ant-modal-close')
    const title = w.querySelector('.ant-modal-title')
    const wrap = document.querySelector('.ant-modal-wrap')
    const cs = getComputedStyle(body)
    const mr = w.getBoundingClientRect()
    const first = body.firstElementChild
    const grid = w.querySelector('.rb-edit-grid-wrap > div > .grid')
    const footBtns = [...foot.querySelectorAll('button')]
    // 真正的横向滚动容器：排除 input/textarea/select（它们 scrollWidth>clientWidth 是文字溢出，
    // 不是滚动区；判词 G6 的原始过滤式会把十几个输入框算进来，必须在实现里排除表单元素）
    const scrollers = [...body.querySelectorAll('*')]
      .filter((e) => !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName))
      .filter((e) => getComputedStyle(e).overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1)
      .map((e) => ({ cls: String(e.className).slice(0, 40), sw: e.scrollWidth, cw: e.clientWidth }))
    const toolbar = w.querySelector('.rb-edit-grid-wrap .card > .flex.items-center.justify-between')
    return {
      y: Math.round(mr.y), right: Math.round(mr.right), x: Math.round(mr.x), width: Math.round(mr.width),
      containerPad: getComputedStyle(w.querySelector('.ant-modal-container')).padding,
      bodyPad: cs.padding,
      bodySW: body.scrollWidth, bodyCW: body.clientWidth,
      contentW: body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      bodySH: body.scrollHeight, bodyCH: body.clientHeight,
      titleX: Math.round(title.getBoundingClientRect().x),
      firstX: Math.round(first?.getBoundingClientRect().x || 0),
      firstRight: Math.round(first?.getBoundingClientRect().right || 0),
      footLastRight: Math.round(footBtns[footBtns.length - 1]?.getBoundingClientRect().right || 0),
      gridW: grid ? Math.round(grid.getBoundingClientRect().width) : null,
      scrollers,
      closeBottom: Math.round(close.getBoundingClientRect().bottom),
      headBottom: Math.round(head.getBoundingClientRect().bottom),
      footBottom: Math.round(foot.getBoundingClientRect().bottom),
      footBtns: footBtns.map((b) => b.textContent.replace(/\s/g, '')),
      wrapSW: wrap.scrollHeight, wrapCH: wrap.clientHeight,
      toolbarBtns: toolbar ? [...toolbar.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height)) : [],
      toolbarSW: toolbar ? toolbar.scrollWidth : 0, toolbarCW: toolbar ? toolbar.clientWidth : 0,
      topSaveVisible: (document.querySelector('.rb-edit-top-save')?.getBoundingClientRect().height || 0) > 0,
      noteText: body.textContent.includes('编辑口径说明'),
      de: document.documentElement.scrollWidth,
      styles: [...document.querySelectorAll('head > style[id^="mb-report-"]')].map((s) => s.id),
      // C 批（用户点头「三项全做」）
      c1Count: w.querySelectorAll('.rb-edit-grid-wrap .card:has(> .card > .h-48)').length,
      c1Hidden: (() => { const c = w.querySelector('.rb-edit-grid-wrap .card:has(> .card > .h-48)'); return c ? getComputedStyle(c).display === 'none' : null })(),
      c1ImgPresent: w.querySelectorAll('.rb-edit-grid-wrap .card:has(> .card > .h-48) img').length,
      c2Margins: [...(w.querySelector('.rb-edit-grid-wrap > div')?.children || [])].map((c) => getComputedStyle(c).marginTop),
      c3TextareaHeights: [...w.querySelectorAll('.rb-edit-grid-wrap textarea.input')].map((t) => Math.round(t.getBoundingClientRect().height)),
      // 冗余保存按钮（2026-11-16 用户指出）：网格内「保存到本地数据库」与 footer「保存修改」同一 handler
      gridSaveVisible: [...w.querySelectorAll('.rb-edit-grid-wrap button')]
        .filter((x) => x.getBoundingClientRect().height > 0 && /保存到本地/.test(x.textContent)).length,
      gridResetVisible: [...w.querySelectorAll('.rb-edit-grid-wrap button')]
        .filter((x) => x.getBoundingClientRect().height > 0 && /清空本次/.test(x.textContent)).length,
      gridToolbarVisible: [...w.querySelectorAll('.rb-edit-grid-wrap button')]
        .filter((x) => x.getBoundingClientRect().height > 0 && /智能补项|空白行|一键修正/.test(x.textContent)).length,
    }
  })
  await p.screenshot({ path: `/tmp/edit-modal-${width}-after.png`, fullPage: false })
  await p.close()
  return m
}

try {
  // ---------------- 375 主档：G1–G10 ----------------
  const m = await measure(375, 812)
  if (!m) { console.log('SKIP 编辑弹窗 375：列表没有编辑按钮'); process.exit(0) }

  if (Math.abs(m.y - 8) <= 1) ok(`G1 贴顶：modal.y=${m.y}（原 108px 空余已消除）`)
  else throw new Error(`G1 modal.y=${m.y}`)

  if (m.bodySW <= m.bodyCW + 1) ok(`G2 body 无横向溢出：${m.bodySW}/${m.bodyCW}`)
  else throw new Error(`G2 body ${m.bodySW}/${m.bodyCW}`)

  if (m.contentW >= 335) ok(`G3 正文可用宽 ${m.contentW}px ≥335（改前 287）`)
  else throw new Error(`G3 contentW=${m.contentW}`)

  const gridOk = m.gridW !== null && m.gridW <= m.contentW + 1
  if (m.titleX === m.firstX && m.titleX === m.x + 12 && gridOk) {
    ok(`G4 左边界对齐：title.x=body.firstChild.x=${m.titleX}（=modal.x+12），轨道 ${m.gridW}px ≤ 正文 ${m.contentW}px`)
  } else throw new Error(`G4 titleX=${m.titleX} firstX=${m.firstX} modalX=${m.x} gridW=${m.gridW} contentW=${m.contentW}`)

  if (m.firstRight === m.right - 12 && m.footLastRight === m.right - 12) {
    ok(`G5 右边界对齐：body 子项 / footer 末位按钮 right=${m.footLastRight}（=modal.right−12）`)
  } else throw new Error(`G5 firstRight=${m.firstRight} footLastRight=${m.footLastRight} modalRight=${m.right}`)

  // G6：真正的滚动区恰好 1 个（排除 input/textarea，见 measure 里的说明）
  const only = m.scrollers
  if (only.length === 1 && /overflow-x-auto/.test(only[0].cls) && only[0].sw >= 760) {
    ok(`G6 单一横向滚动容器：${only[0].cls} ${only[0].sw}/${only[0].cw}`)
  } else throw new Error(`G6 scrollers=${JSON.stringify(only.slice(0, 4))} count=${only.length}`)

  if (m.toolbarBtns.length && m.toolbarBtns.every((h) => h <= 40) && m.toolbarSW <= m.toolbarCW + 1) {
    ok(`G7 工具栏不竖排：按钮高 ${m.toolbarBtns.join('/')} ≤40，且不溢出`)
  } else throw new Error(`G7 toolbarBtns=${m.toolbarBtns.join('/')} sw/cw=${m.toolbarSW}/${m.toolbarCW}`)

  if (m.closeBottom <= m.headBottom) ok(`G8 关闭按钮不压 body：close.bottom=${m.closeBottom} ≤ header.bottom=${m.headBottom}`)
  else throw new Error(`G8 close=${m.closeBottom} header=${m.headBottom}`)

  if (m.footBottom <= 812 && m.wrapSW <= m.wrapCH + 1) {
    ok(`G9 footer 常驻 + 整页不下滑：footer.bottom=${m.footBottom}，wrap ${m.wrapSW}/${m.wrapCH}`)
  } else throw new Error(`G9 footer=${m.footBottom} wrap=${m.wrapSW}/${m.wrapCH}`)

  if (m.bodySH > m.bodyCH) ok(`G9b body 内部滚动（sh=${m.bodySH} / ch=${m.bodyCH}），header/footer 固定`)
  else throw new Error(`G9b body ${m.bodySH}/${m.bodyCH}`)

  const uniq = new Set(m.styles).size === m.styles.length
  if (uniq && m.styles.length === 3 && m.styles.includes('mb-report-edit-modal-mobile')) {
    ok(`G10 三段页面级 style 并存且 id 唯一（${m.styles.join(' / ')}）`)
  } else throw new Error(`G10 styles=${m.styles.join(',')}`)

  // ---- C 批（用户 2026-11-16 点头「三项全做」）----
  if (m.c1ImgPresent === 0 && m.c1Hidden === true) {
    ok(`C1 无图时收起「脱敏原图」空占位卡（命中 ${m.c1Count} 个，display:none）`)
  } else if (m.c1ImgPresent > 0) {
    ok('C1 有裁剪图时卡片保留（选择器带 > .card > .h-48 守卫，未误伤）')
  } else throw new Error(`C1 count=${m.c1Count} hidden=${m.c1Hidden} img=${m.c1ImgPresent}`)

  const marginsOk = m.c2Margins.length > 1 && m.c2Margins.slice(1).every((v) => parseFloat(v) === 10)
  if (marginsOk) ok(`C2 大块间距 16→10px（实测 ${m.c2Margins.join(' / ')}）`)
  else throw new Error(`C2 margins=${m.c2Margins.join(',')}`)

  if (m.c3TextareaHeights.length && m.c3TextareaHeights.every((h) => h <= 100)) {
    ok(`C3 原文框收到 ≤96px（实测 ${m.c3TextareaHeights.join('/')}），仍可滚可编辑`)
  } else throw new Error(`C3 textarea=${m.c3TextareaHeights.join(',')}`)

  if (m.bodySH <= 1300) ok(`C 批纵向收益：body scrollHeight=${m.bodySH}（A+B 时 1580，目标 ≈1258）`)
  else throw new Error(`C 批后 bodySH=${m.bodySH} 仍偏高`)

  // 冗余按钮：只留 footer 的「保存修改」；网格内那个（同 handler + 恒 disabled）隐藏
  if (m.gridSaveVisible === 0) ok('网格内「保存到本地数据库」已隐藏（与 footer「保存修改」重复，且 date="" 恒灰）')
  else throw new Error(`gridSaveVisible=${m.gridSaveVisible}`)
  if (m.gridResetVisible === 1) ok('「清空本次」保留（页面无其它重置入口）')
  else throw new Error(`gridResetVisible=${m.gridResetVisible}`)
  if (m.gridToolbarVisible === 3) ok('工具栏 3 个按钮未被误伤（智能补项/空白行/一键修正）')
  else throw new Error(`gridToolbarVisible=${m.gridToolbarVisible}`)

  if (m.footBtns.some((t) => t.includes('保存修改')) && m.footBtns.some((t) => t.includes('取消'))) ok('footer 有「取消 / 保存修改」')
  else throw new Error(`footBtns=${m.footBtns.join(',')}`)
  if (!m.topSaveVisible) ok('顶部冗余「保存修改」已隐藏（footer 是唯一写库入口）')
  else throw new Error('顶部仍有重复保存按钮')
  if (m.noteText) ok('长说明收成一行 + Tooltip（信息不丢）')
  else throw new Error('编辑口径说明缺失')
  if (m.de === 375) ok('375 无横向溢出（de=375）'); else throw new Error(`de=${m.de}`)

  // ---------------- G11 桌面 1440 零回归 ----------------
  const d = await measure(1440, 900)
  if (d) {
    if (d.y === 100 && d.width === 900) ok(`G11a 桌面位置零回归：y=${d.y}、width=${d.width}`)
    else throw new Error(`G11a y=${d.y} w=${d.width}`)
    if (d.containerPad === '20px 24px') ok('G11b 桌面 container padding 仍为 antd 默认 20px 24px')
    else throw new Error(`G11b containerPad=${d.containerPad}`)
    if (d.bodySW === d.bodyCW && d.topSaveVisible) ok(`G11c 桌面 body 无内部横向滚（${d.bodySW}/${d.bodyCW}）+ 顶部保存按钮仍显示`)
    else throw new Error(`G11c body ${d.bodySW}/${d.bodyCW} topSave=${d.topSaveVisible}`)
    if (d.de === 1440) ok('G11d 1440 无横向溢出'); else throw new Error(`de=${d.de}`)
    if (d.c1Hidden !== true) ok('G11e 桌面「脱敏原图」卡仍在（C1 只作用于 ≤575px）')
    else throw new Error('C1 误伤桌面')
    if (d.c3TextareaHeights.every((h) => h > 96)) ok(`G11f 桌面原文框仍是 rows=6 原高（${d.c3TextareaHeights.join('/')}）`)
    else throw new Error(`桌面 textarea=${d.c3TextareaHeights.join(',')}`)
  } else console.log('SKIP G11：1440 列表没有编辑按钮')

  // ---------------- G12 320 / 414 复跑 ----------------
  for (const [w, h, minW] of [[320, 700, 280], [414, 896, 374]]) {
    const s = await measure(w, h)
    if (!s) { console.log(`SKIP G12 ${w}：没有编辑按钮`); continue }
    const problems = []
    if (Math.abs(s.y - 8) > 1) problems.push(`y=${s.y}`)
    if (s.bodySW > s.bodyCW + 1) problems.push(`body溢出 ${s.bodySW}/${s.bodyCW}`)
    if (s.contentW < minW) problems.push(`正文宽 ${s.contentW}<${minW}`)
    if (s.titleX !== s.firstX) problems.push(`左边界 ${s.titleX}/${s.firstX}`)
    if (s.footLastRight !== s.right - 12) problems.push(`右边界 ${s.footLastRight}/${s.right - 12}`)
    if (s.closeBottom > s.headBottom) problems.push(`X压body ${s.closeBottom}>${s.headBottom}`)
    if (s.wrapSW > s.wrapCH + 1) problems.push(`整页下滑 ${s.wrapSW}/${s.wrapCH}`)
    if (problems.length === 0) ok(`G12 ${w}px 复跑通过：正文 ${s.contentW}px、轨道 ${s.gridW}px、对齐 ${s.titleX}/${s.footLastRight}、单一横滚 ${s.scrollers.length}`)
    else throw new Error(`G12 ${w}px: ${problems.join('; ')}`)
  }
} finally {
  await browser.close()
}
console.log(`\n编辑弹窗 375 版面：${pass} 通过 / 0 失败`)
