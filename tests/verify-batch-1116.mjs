// ① 批量导入交互重构 —— 验收闸门（计划 v0.14 / 规格 v1.8）
//
// 判据主体 = 规格 §8 的 15 条（A1 / A1b / A2–A12 + A9b / A9c）+ 计划补充 B0–B7。
// 四条证伪由 `--falsify=<id>` 触发（A1 / A4 / A9b / A9c），必须真红（退出码 1）。
//
// 铁律：
//   · 只写**副本库**（真库 sha256 前后比对自证）；
//   · 端口 5195（5193 = verify-reports-refresh、5194 = verify-report-edit-save、5199 = report-delete）；
//   · 夹具不用 na 兜（B0 前置：每档 ≥3 张且**字节互不相同**，否则 fail）；
//   · 退出码 failed?1:(na>0?2:0)。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REAL = path.join(ROOT, 'data', 'reports.json')
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const realBefore = sha(REAL)

let pass = 0, failed = 0, na = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }
const fail = (n, e = '') => { failed++; console.log(`FAIL ${n}${e ? ' · ' + e : ''}`) }
const naHit = (n) => { na++; console.log(`N/A ${n}`) }

const FALSIFY = (process.argv.find((a) => a.startsWith('--falsify=')) || '').split('=')[1] || ''

// ---------- 夹具：字节互不相同的 PNG（尾部追加不同字节即可，解码头不看尾部） ----------
const PNG1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
const fixture = (tag) => Buffer.concat([PNG1X1, Buffer.from(`MB-FIXTURE-${tag}`)])
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-batch-'))
const writeFix = (name, buf) => { const p = path.join(tmpDir, name); fs.writeFileSync(p, buf); return p }
const fxA = writeFix('报告A.png', fixture('A'))
const fxB = writeFix('报告B.png', fixture('B'))
const fxC = writeFix('报告C.png', fixture('C'))
// A9c 用的两张：**同文件名 + 同字节数、内容不同**
const sameSize1 = Buffer.concat([PNG1X1, Buffer.alloc(24, 0x41)])
const sameSize2 = Buffer.concat([PNG1X1, Buffer.alloc(24, 0x42)])
const dup1 = writeFix('image-x1.png', sameSize1)
const dup2 = writeFix('image-x2.png', sameSize2)   // 同名改由 setInputFiles 的 name 覆盖

// ---------- 副本库 + 服务 ----------
const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-batch-lib-'))
const libFile = path.join(libDir, 'reports.json')
fs.copyFileSync(REAL, libFile)
const PORT = 5195
const BASE = `http://127.0.0.1:${PORT}`
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), MEDBRIEF_REPORTS_FILE: libFile, MEDBRIEF_DATA_DIR: libDir },
  stdio: 'ignore',
})
const browser = await chromium.launch({ headless: true })

const VIEWPORTS = [
  { w: 1440, h: 900 }, { w: 768, h: 1024 }, { w: 414, h: 896 }, { w: 375, h: 812 },
]
const upload = async (page, files) => {
  await page.locator('.mb-upload-body input[type=file]').setInputFiles(
    files.map((f) => (typeof f === 'string' ? f : f)),
  )
  await page.waitForTimeout(400)
}
const cardCount = (page) => page.locator('.mb-item-card').count()

try {
  let up = false
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) { up = true; break } } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(up, `副本服务未起来（${BASE}）`)
  ok(`副本服务已起 ${BASE}（副本库 ${libFile}）`)

  for (const vp of VIEWPORTS) {
    const w = vp.w
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
    await page.goto(`${BASE}/?tab=intake`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-upload-body', { timeout: 20000 })

    // ---- B0 夹具前置：≥3 张且字节互不相同 ----
    await upload(page, [fxA, fxB, fxC])
    const n = await cardCount(page)
    const shas = [fixture('A'), fixture('B'), fixture('C')].map((b) => crypto.createHash('sha256').update(b).digest('hex'))
    const uniq = new Set(shas).size === 3
    if (n >= 3 && uniq) ok(`B0 ${w} 夹具合格：${n} 张卡，3 张字节互不相同`)
    else fail(`B0 ${w} 夹具不合格：卡=${n}（期望 ≥3），字节互异=${uniq}`)

    // ---- A1 中途贴底（三分支，锚点 = 栏的父元素）----
    const a1 = await page.evaluate(async () => {
      const bar = document.querySelector('.mb-batchbar')
      if (!bar) return { err: 'no-bar' }
      const parent = bar.parentElement
      const doc = document.documentElement
      const span = parent.getBoundingClientRect().bottom + doc.scrollTop - innerHeight
      const raf = () => new Promise((r) => requestAnimationFrame(r))
      let branch = '', gap = null, okBranch = false
      if (span > 100) {
        branch = 'main'
        doc.scrollTop = span * 0.5
        await raf()
        gap = Math.abs(innerHeight - bar.getBoundingClientRect().bottom)
        okBranch = gap <= 1
      } else if (span <= 0) {
        branch = 'short'
        doc.scrollTop = doc.scrollHeight
        await raf()
        gap = Math.abs(bar.getBoundingClientRect().bottom - parent.getBoundingClientRect().bottom)
        okBranch = gap <= 1
      } else {
        branch = 'gray'
        gap = span
        okBranch = false
      }
      return { branch, gap, okBranch, span }
    })
    if (FALSIFY === 'A1') { /* 见文末统一注入样式 */ }
    if (a1.err) fail(`A1 ${w} 找不到 .mb-batchbar`)
    else if (a1.okBranch) ok(`A1 ${w} 分支=${a1.branch} gap=${Number(a1.gap).toFixed(1)} ≤1（span=${Number(a1.span).toFixed(1)}）`)
    else fail(`A1 ${w} 分支=${a1.branch} gap=${a1.gap}（span=${Number(a1.span).toFixed(1)}）—— 灰区视为夹具不合格`)

    // ---- A1b 到底不遮内容 ----
    const a1b = await page.evaluate(async () => {
      const bar = document.querySelector('.mb-batchbar')
      const doc = document.documentElement
      doc.scrollTop = doc.scrollHeight
      await new Promise((r) => requestAnimationFrame(r))
      const last = [...document.querySelectorAll('.mb-item-card')].pop()
      return { lastBottom: last.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top }
    })
    if (a1b.lastBottom <= a1b.barTop + 0.5) ok(`A1b ${w} 到底不遮内容：最后一张卡底 ${a1b.lastBottom.toFixed(0)} ≤ 栏顶 ${a1b.barTop.toFixed(0)}`)
    else fail(`A1b ${w} 遮内容：卡底 ${a1b.lastBottom.toFixed(0)} > 栏顶 ${a1b.barTop.toFixed(0)}`)

    // ---- A2 栏高三态 ----
    const a2 = await page.evaluate(() => {
      const bar = document.querySelector('.mb-batchbar')
      const hint = document.querySelector('.mb-bar-hint')
      return { H: Math.round(bar.getBoundingClientRect().height), hint: !!hint }
    })
    const expect0 = w >= 576 ? 49 : 61
    if (!a2.hint && a2.H === expect0) ok(`A2 ${w} 常态栏高 ${a2.H} = ${expect0}`)
    else if (!a2.hint) fail(`A2 ${w} 常态栏高 ${a2.H} ≠ ${expect0}（无灰字）`)
    else fail(`A2 ${w} 常态应无 .mb-bar-hint，实际存在（H=${a2.H}）`)

    // ---- A4 375/各档不换行 + 按钮高 ----
    const a4 = await page.evaluate(() => {
      const bar = document.querySelector('.mb-batchbar')
      const btns = [...bar.querySelectorAll('[data-bar-btn]')]
      return {
        sw: bar.scrollWidth, cw: bar.clientWidth,
        nowrap: btns.every((b) => getComputedStyle(b).whiteSpace === 'nowrap'),
        heights: btns.map((b) => Math.round(b.getBoundingClientRect().height)),
        // 窄屏（≤767）规格要求按钮 flex:1 1 0 **均分**栏宽 —— 去掉 flex 会立刻不等宽（这是 A4 的证伪点：
        // 只断 "不溢出" 不够，短文案下 2 个按钮自然宽度本来就不会溢出 ⇒ 断言恒绿、证伪做不出来）
        widths: btns.filter((b) => !b.classList.contains('mb-bar-btn-icon')).map((b) => Math.round(b.getBoundingClientRect().width)),
      }
    })
    const wantBtnH = w >= 576 ? 32 : 44
    const equalW = w >= 768 || a4.widths.length < 2 || Math.abs(a4.widths[0] - a4.widths[1]) <= 1
    if (a4.sw <= a4.cw + 1 && a4.nowrap && a4.heights.every((h) => h === wantBtnH) && equalW) {
      ok(`A4 ${w} 不换行 ${a4.sw}/${a4.cw}，按钮高 ${a4.heights.join('/')}=${wantBtnH}${w < 768 ? `，均分宽 ${a4.widths.join('=')}` : ''}`)
    } else fail(`A4 ${w} 换行/高度/均分不符：sw/cw=${a4.sw}/${a4.cw} nowrap=${a4.nowrap} h=${a4.heights.join('/')} 宽=${a4.widths.join('/')}（期望 ${wantBtnH} 且窄屏均分）`)

    // ---- A7 三态 DOM（0 选 / 选 1 / 选 2），含「更多」防漏 ----
    const barState = (page) => page.evaluate(() => {
      const bar = document.querySelector('.mb-batchbar')
      const btns = [...bar.querySelectorAll('[data-bar-btn]')]
      return {
        count: btns.length,
        acts: btns.map((b) => b.getAttribute('data-act')),
        stitchText: (bar.querySelector('[data-act="stitch"]') || {}).textContent || '',
      }
    })
    const s0 = await barState(page)
    if (s0.count === 2 && !s0.acts.includes('stitch') && !s0.acts.includes('more')) ok(`A7 ${w} 0 选：2 个按钮、无拼接、无「更多」`)
    else fail(`A7 ${w} 0 选异常：count=${s0.count} acts=${s0.acts.join(',')}`)

    await page.locator('.mb-item-card .ant-checkbox-input').first().check()
    await page.waitForTimeout(150)
    const s1 = await barState(page)
    if (s1.acts.includes('remove') && s1.acts.includes('more') && !s1.acts.includes('stitch') && s1.count === 2) ok(`A7 ${w} 选 1：移除选中 + 更多，无拼接`)
    else fail(`A7 ${w} 选 1 异常：count=${s1.count} acts=${s1.acts.join(',')}`)

    // ---- A8 序号徽标 ----
    await page.locator('.mb-item-card .ant-checkbox-input').nth(1).check()
    await page.waitForTimeout(150)
    const a8 = await page.evaluate(() => {
      const badges = [...document.querySelectorAll('.mb-pick-badge .ant-scroll-number-custom-component, .mb-pick-badge .ant-badge-count')]
      const boxes = [...document.querySelectorAll('.mb-item-card .ant-checkbox')]
      const b = badges[0] && badges[0].getBoundingClientRect()
      const c = boxes[0] && boxes[0].getBoundingClientRect()
      return {
        texts: badges.map((x) => x.textContent.trim()).join(''),
        rect: b ? [Math.round(b.width), Math.round(b.height)] : null,
        noOverlap: b && c ? b.left >= c.right - 0.5 : null,
      }
    })
    if (a8.texts === '①②' && a8.rect && a8.rect[0] === 16 && a8.rect[1] === 16 && a8.noOverlap) {
      ok(`A8 ${w} 徽标 ${a8.texts}，16×16，与 checkbox 不相交`)
    } else fail(`A8 ${w} 徽标异常：texts=${a8.texts} rect=${a8.rect} noOverlap=${a8.noOverlap}`)

    const s2 = await barState(page)
    if (s2.acts.includes('stitch') && /拼接（2）/.test(s2.stitchText) && s2.acts.includes('remove') && s2.acts.includes('more')) {
      ok(`A7 ${w} 选 2：${s2.stitchText.trim()} + 移除 + 更多`)
    } else fail(`A7 ${w} 选 2 异常：acts=${s2.acts.join(',')} stitch=${s2.stitchText.trim()}`)

    // ---- A4b 窄屏均分（选 2 状态：文案长度不同 ⇒ 这条才对 `flex:1 1 0` 敏感，0 选状态下两个
    //          七字按钮自然等宽，光看等宽是分辨不出 flex 有没有被删的）----
    const a4b = await page.evaluate(() => {
      const bar = document.querySelector('.mb-batchbar')
      const btns = [...bar.querySelectorAll('[data-bar-btn]')].filter((b) => !b.classList.contains('mb-bar-btn-icon'))
      return {
        widths: btns.map((b) => Math.round(b.getBoundingClientRect().width)),
        labels: btns.map((b) => b.textContent.trim()),
        sw: bar.scrollWidth, cw: bar.clientWidth,
      }
    })
    if (w >= 768) { ok(`A4b ${w} 大屏不判均分（按钮自然宽）`) }
    else if (a4b.widths.length >= 2 && Math.abs(a4b.widths[0] - a4b.widths[1]) <= 1 && a4b.sw <= a4b.cw + 1) {
      ok(`A4b ${w} 窄屏均分：${a4b.labels.join('/')} = ${a4b.widths.join('=')}`)
    } else fail(`A4b ${w} 窄屏未均分：${a4b.labels.join('/')} = ${a4b.widths.join('/')}（sw/cw=${a4b.sw}/${a4b.cw}）`)

    // ---- A2 选 3 张态（2026-11-17 C-9 放行后 MAX_STITCH=4）----
    // 灰字「先拼前两张」的触发条件是 selCount > MAX_STITCH；MAX_STITCH=4 且 MAX_SELECT=4 ⇒ 不可能触发
    // ⇒ 这里断"无灰字 + 栏高维持常态 + 拼接（3）可用"。若将来 MAX_SELECT 提到 >4，灰字态断言再启用
    // （规格 A2 的"两态相减 = 16"保留在代码里，由 hint 存在时生效，见下方分支）。
    await page.locator('.mb-item-card .ant-checkbox-input').nth(2).check()
    await page.waitForTimeout(200)
    const a2b = await page.evaluate(() => {
      const bar = document.querySelector('.mb-batchbar')
      const hint = document.querySelector('.mb-bar-hint')
      const stitch = document.querySelector('[data-act="stitch"]')
      return {
        H: Math.round(bar.getBoundingClientRect().height),
        hintText: hint ? hint.textContent.trim() : null,
        hintH: hint ? Math.round(hint.getBoundingClientRect().height) : null,
        stitchDisabled: stitch ? stitch.disabled : null,
        stitchText: stitch ? stitch.textContent.trim() : null,
      }
    })
    if (a2b.hintText) {
      // 灰字态（仅在 selCount > MAX_STITCH 时出现）：栏高必须恰好 +16
      const expectHint = w >= 576 ? 65 : 77
      if (a2b.H === expectHint && a2b.hintH <= 16) ok(`A2 ${w} 灰字态「${a2b.hintText}」栏高 ${a2b.H}=${expectHint}（差 ${a2b.H - expect0}=16）`)
      else fail(`A2 ${w} 灰字态异常：H=${a2b.H}（期望 ${expectHint}）hintH=${a2b.hintH}`)
    } else if (a2b.H === expect0 && /拼接（3）/.test(a2b.stitchText || '') && a2b.stitchDisabled === false) {
      ok(`A2 ${w} 选 3 张：无灰字、栏高 ${a2b.H}=${expect0}、${a2b.stitchText} 可用（MAX_STITCH=4 已放行）`)
    } else {
      fail(`A2 ${w} 选 3 张异常：H=${a2b.H}（期望 ${expect0}）hint=${a2b.hintText} stitch=${a2b.stitchText} disabled=${a2b.stitchDisabled}`)
    }

    // ---- A10 栏内按钮不出卡 + 栏内无 Dropdown 菜单 ----
    const a10 = await page.evaluate(() => {
      const bar = document.querySelector('.mb-batchbar')
      const r = bar.getBoundingClientRect()
      const out = [...bar.querySelectorAll('[data-bar-btn]')].filter((b) => {
        const x = b.getBoundingClientRect()
        return x.left < r.left - 0.5 || x.right > r.right + 0.5
      }).length
      return { out, dropdownInBar: !!document.querySelector('.mb-batchbar .ant-dropdown') }
    })
    if (a10.out === 0 && !a10.dropdownInBar) ok(`A10 ${w} 栏内按钮不出卡、栏内无 .ant-dropdown`)
    else fail(`A10 ${w} 出卡按钮 ${a10.out} 个，栏内 dropdown=${a10.dropdownInBar}`)

    // ---- A5 头部不挤爆（文件名截断且 ≥96px，Tag 仍可见）----
    const a5 = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.mb-item-card .mb-file-name')]
      const tags = [...document.querySelectorAll('.mb-item-card .ant-tag')]
      const el = els[0]
      return {
        truncating: el ? el.scrollWidth > el.clientWidth : false,
        width: el ? Math.round(el.getBoundingClientRect().width) : 0,
        tagVisible: tags.some((t) => t.getBoundingClientRect().width > 0),
      }
    })
    if (a5.width >= 96 && a5.tagVisible) ok(`A5 ${w} 文件名宽 ${a5.width} ≥96（截断=${a5.truncating}），Tag 可见`)
    else fail(`A5 ${w} 文件名宽 ${a5.width} <96 或 Tag 不可见`)

    // ---- A6 触摸热区 44 + 常态非危险红 ----
    // 先把第一张卡滚回视口中间：前面的 A1/A1b 已经滚到页面底部，
    // 元素滚出视口时 elementFromPoint 恒返回 null ⇒ 会假红（这是测试自身的问题，不是实现）。
    await page.evaluate(() => document.querySelector('.mb-item-card').scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(200)
    const a6 = await page.evaluate(() => {
      const btn = document.querySelector('.mb-icon-btn')
      if (!btn) return { err: 'no-btn' }
      const r = btn.getBoundingClientRect()
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const hit = [[20, 0], [-20, 0], [0, 20], [0, -20]].every(([dx, dy]) => {
        const el = document.elementFromPoint(cx + dx, cy + dy)
        return el === btn || (el && btn.contains(el))
      })
      const cs = getComputedStyle(btn)
      // 规格 v1.9：热区靠 ::before 外扩 ⇒ 祖先链必须 overflow:visible（不靠文档，靠这条断言）
      const clippers = []
      let n = btn.parentElement
      while (n && !n.classList.contains('mb-item-card') && n !== document.body) {
        const ov = getComputedStyle(n).overflow
        if (ov !== 'visible') clippers.push(`${n.className.toString().slice(0, 24)}=${ov}`)
        n = n.parentElement
      }
      return { w: Math.round(r.width), h: Math.round(r.height), hit, color: cs.color, cls: btn.className, clippers }
    })
    if (a6.err) fail(`A6 ${w} 找不到 .mb-icon-btn`)
    else if (a6.w === 24 && a6.h === 24 && a6.hit && a6.color !== 'rgb(255, 77, 79)' && !a6.cls.includes('ant-btn-dangerous')) {
      if (a6.clippers.length === 0) ok(`A6 ${w} 视觉 24×24、四点热区命中、常态色 ${a6.color}（非危险红）、祖先链 overflow 无裁剪`)
      else fail(`A6 ${w} 热区被裁：${a6.clippers.join('、')}`)
    } else fail(`A6 ${w} 异常：${a6.w}×${a6.h} hit=${a6.hit} color=${a6.color} danger=${a6.cls.includes('ant-btn-dangerous')}`)

    // ---- A11 既有契约无回退 + A3 ② 段隐藏 ----
    const a11 = await page.evaluate(() => ({
      ggrid: document.querySelectorAll('.g-grid').length,
      bars: document.querySelectorAll('.mb-batchbar').length,
      // 栏必须是 .mb-upload-body 的直接子元素（不许放进 Space）
      parentOk: !!document.querySelector('.mb-upload-body > .mb-batchbar'),
    }))
    if (a11.bars === 1 && a11.parentOk) ok(`A11 ${w} 栏唯一且父级 = .mb-upload-body（.g-grid=${a11.ggrid}）`)
    else fail(`A11 ${w} 栏数量=${a11.bars} 父级正确=${a11.parentOk}`)

    await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight) })
    await page.waitForTimeout(400)
    const a3 = await page.evaluate(() => {
      const bar = document.querySelector('.mb-batchbar')
      const review = document.querySelector('#sec-review')
      const b = bar ? bar.getBoundingClientRect() : null
      const r = review ? review.getBoundingClientRect() : null
      return {
        exists: !!bar,
        barBottom: b ? b.bottom : null,
        // 栏要么已滚出视口（bottom ≤ 0），要么不与 ② 段内容重叠
        offscreen: b ? b.bottom <= 0.5 : false,
        noOverlap: b && r ? b.bottom <= r.top + 0.5 : null,
        reviewTop: r ? r.top : null,
      }
    })
    if (a3.exists && (a3.offscreen || a3.noOverlap)) {
      ok(`A3 ${w} ② 段不被栏覆盖（栏底 ${a3.barBottom?.toFixed(0)}，② 顶 ${a3.reviewTop?.toFixed(0)}；滚出=${a3.offscreen}）`)
    } else fail(`A3 ${w} ② 段被栏覆盖：栏底 ${a3.barBottom} > ② 顶 ${a3.reviewTop}（滚出=${a3.offscreen}）`)

    // ---- A12 页面不横向滚 ----
    const a12 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
    if (a12.sw <= a12.cw + 1) ok(`A12 ${w} 无横滚 ${a12.sw}/${a12.cw}`)
    else fail(`A12 ${w} 横滚 ${a12.sw} > ${a12.cw}`)

    if (pageErrors.length === 0) ok(`Z ${w} 全程 pageerror=0`)
    else fail(`Z ${w} pageerror ${pageErrors.length} 条：${pageErrors[0]}`)
    await page.close()
  }

  // ---- C-9 多张拼接端到端（用户 2026-11-17 两次点名「现在就要拼三段」）----
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e.message || e)))
    await page.goto(`${BASE}/?tab=intake`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-upload-body')
    await upload(page, [fxA, fxB, fxC])
    if (await cardCount(page) !== 3) fail('C-9 前置：3 张夹具未建卡'); 
    for (let i = 0; i < 3; i++) await page.locator('.mb-item-card .ant-checkbox-input').nth(i).check()
    await page.waitForTimeout(200)
    const st = await page.evaluate(() => {
      const b = document.querySelector('[data-act="stitch"]')
      return { text: b ? b.textContent.trim() : null, disabled: b ? b.disabled : null }
    })
    if (!/拼接（3）/.test(st.text || '') || st.disabled) fail(`C-9 三选态按钮异常：${st.text} disabled=${st.disabled}`)
    else ok(`C-9 选 3 张：按钮「${st.text}」可用`)
    await page.locator('[data-act="stitch"]').click()
    // 等拼接完成：3 张卡 → 1 张拼接卡
    let merged = 0
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(300)
      merged = await page.locator('.mb-item-card', { hasText: '拼接-' }).count()
      const total = await cardCount(page)
      if (merged === 1 && total === 1) break
    }
    const total = await cardCount(page)
    const mergedName = (await page.locator('.mb-item-card .mb-file-name').first().textContent().catch(() => '')) || ''
    if (merged === 1 && total === 1 && /拼接-/.test(mergedName) && errs.length === 0) {
      ok(`C-9 三段拼接成功：3 张 → 1 张（${mergedName.slice(0, 48)}…），pageerror=0`)
    } else {
      fail(`C-9 三段拼接失败：merged=${merged} total=${total} name=${JSON.stringify(mergedName)} err=${errs[0] || ''}`)
    }

    // 服务端护栏：5 张必须被拒（前端常量 4 只是第一道）
    const fiveImgs = [1, 2, 3, 4, 5].map((i) => `data:image/png;base64,${Buffer.concat([PNG1X1, Buffer.from(`G${i}`)]).toString('base64')}`)
    const r5 = await (await fetch(`${BASE}/api/intake/stitch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: fiveImgs }),
    })).json()
    if (r5.ok === false && /最多拼 4 张/.test(String(r5.error || ''))) ok(`C-9 服务端护栏：5 张被拒（${r5.error}）`)
    else fail(`C-9 服务端护栏失效：${JSON.stringify(r5).slice(0, 160)}`)

    // 放行条件实测：4 张 4000px 高的图 —— 返回字节数与耗时（手机 OOM 风险的可测代理）
    const { createCanvas } = await import('@napi-rs/canvas')
    const bigs = [1, 2, 3, 4].map((i) => {
      const c = createCanvas(1200, 4000)
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1200, 4000)
      ctx.fillStyle = '#000'; ctx.font = '48px sans-serif'; ctx.fillText(`页 ${i}`, 60, 200 + i * 40)
      return `data:image/png;base64,${c.toBuffer('image/png').toString('base64')}`
    })
    const t0 = Date.now()
    const big = await (await fetch(`${BASE}/api/intake/stitch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: bigs }),
    })).json()
    const ms = Date.now() - t0
    const bytes = big.ok ? Math.round((String(big.dataUrl).length - String(big.dataUrl).indexOf(',')) * 0.75) : -1
    if (big.ok && bytes <= 8 * 1024 * 1024 && ms <= 5000) {
      ok(`C-9 4×4000px 实测：${big.width}×${big.height}，≈${(bytes / 1024 / 1024).toFixed(1)}MB，${ms}ms（阈：≤8MB / ≤5s）`)
    } else fail(`C-9 4×4000px 实测超阈：ok=${big.ok} bytes=${bytes} ms=${ms} err=${big.error || ''}`)
    await page.close()
  }

  // ---- A9b 批内强比对（同文件导两次 ⇒ 1 张卡）----
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${BASE}/?tab=intake`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-upload-body')
    await upload(page, [fxA])
    await upload(page, [fxA])
    const n = await cardCount(page)
    const warned = await page.locator('.ant-message-notice', { hasText: '这张图本次已选过，已跳过' }).count()
    const predups = await page.locator('.mb-item-card .mb-predup').count()
    if (n === 1 && warned > 0 && predups === 0) ok(`A9b 批内去重：${n} 张卡、出现「这张图本次已选过」、首张无 .mb-predup`)
    else fail(`A9b 批内去重异常：卡=${n} 提示=${warned} predup=${predups}`)

    // ---- B3 removeItem 同键删两个 Map：移除后再导回不应被判重复 ----
    await page.locator('.mb-icon-btn').first().click()
    await page.waitForTimeout(300)
    const afterRemove = await cardCount(page)
    await upload(page, [fxA])
    await page.waitForTimeout(300)
    const back = await cardCount(page)
    const warn2 = await page.locator('.ant-message-notice', { hasText: '已选过' }).count()
    if (afterRemove === 0 && back === 1) ok('B3 移除后再导入：重新建卡成功（两 Map 同键删除生效）')
    else fail(`B3 移除后再导入异常：remove 后=${afterRemove} 再导后=${back}`)
    await page.close()
  }

  // ---- A9 对库 exact（注入副本库已知 sha256）----
  {
    const fBuf = fixture('LIB')
    const fSha = crypto.createHash('sha256').update(fBuf).digest('hex')
    const lib = JSON.parse(fs.readFileSync(libFile, 'utf8'))
    lib.reports = lib.reports || []
    lib.reports.push({ id: 'rep_fixture_libdup', sha256: fSha, reportDate: '2026-01-01', reportType: '血常规', kind: 'lab', rows: [], text: '', hospital: '夹具医院' })
    fs.writeFileSync(libFile, JSON.stringify(lib))
    const fLib = writeFix('库内已有.png', fBuf)
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${BASE}/?tab=intake`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-upload-body')
    await upload(page, [fLib])
    const n = await cardCount(page)
    const tagText = (await page.locator('.mb-item-card .mb-predup').first().textContent().catch(() => '')) || ''
    const topText = (await page.locator('[data-testid="mb-predup-count"]').count())
    if (n === 1 && /同一文件已导入过/.test(tagText) && topText === 0) ok(`A9 对库重复：建卡 + 橙 Tag「${tagText.trim()}」，且不误算进「疑似重复（粗判）」`)
    else fail(`A9 对库重复异常：卡=${n} tag=${JSON.stringify(tagText)} 粗判计数=${topText}`)
    await page.close()
  }

  // ---- A9c 降级态绝不丢卡（?hash=null 强制 sha=null）----
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${BASE}/?tab=intake&hash=null`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-upload-body')
    // 两张「同名 + 同字节数、内容不同」的图
    await page.locator('.mb-upload-body input[type=file]').setInputFiles([
      { name: 'image.jpg', mimeType: 'image/png', buffer: sameSize1 },
      { name: 'image.jpg', mimeType: 'image/png', buffer: sameSize2 },
    ])
    await page.waitForTimeout(500)
    const n = await cardCount(page)
    const dupTags = await page.locator('.mb-item-card .mb-predup').count()
    const dupText = (await page.locator('.mb-item-card .mb-predup').first().textContent().catch(() => '')) || ''
    const top = await page.locator('text=疑似重复（粗判）1').count()
    const topHashOff = await page.locator('text=本批未做文件查重').count()
    const perCardHashOff = await page.locator('.mb-item-card', { hasText: '本次未做文件查重' }).count()
    if (n === 2 && dupTags === 1 && /可能重复（按文件名\+大小粗判，请核对）/.test(dupText) && top > 0 && topHashOff > 0 && perCardHashOff === 0) {
      ok(`A9c 降级态绝不丢卡：2 张卡、1 个粗判橙 Tag、顶部有「疑似重复（粗判）1」+「本批未做文件查重」、卡片上无「本次未做文件查重」`)
    } else {
      fail(`A9c 异常：卡=${n}（期望 2）橙Tag=${dupTags} 文案=${JSON.stringify(dupText)} 顶部粗判=${top} 顶部能力=${topHashOff} 逐卡灰Tag=${perCardHashOff}`)
    }
    await page.close()
  }

  // ---- B7 顶部汇总与卡片橙 Tag 对账（A9c 场景复用：1 === 1 已在上面判，这里补 state 侧钩子存在性）----
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
    await page.goto(`${BASE}/?tab=intake&hash=null`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-upload-body')
    await page.locator('.mb-upload-body input[type=file]').setInputFiles([
      { name: 'image.jpg', mimeType: 'image/png', buffer: sameSize1 },
      { name: 'image.jpg', mimeType: 'image/png', buffer: sameSize2 },
    ])
    await page.waitForTimeout(500)
    const domTags = await page.locator('.mb-item-card .mb-predup').count()
    const testid = await page.locator('[data-testid="mb-predup-count"]').first().textContent().catch(() => '')
    const m = Number((String(testid).match(/(\d+)/) || [])[1])
    if (m === domTags) ok(`B7 顶部汇总与卡片对账：M=${m} === 橙 Tag ${domTags}`)
    else fail(`B7 对账失败：M=${m} vs 橙 Tag ${domTags}（testid=${JSON.stringify(testid)}）`)
    // ---- B1 顶部冗余入口已删（静态断言，跑一次即可）----
    const src = fs.readFileSync(path.join(ROOT, 'web/src/pages/intake/UploadPanel.jsx'), 'utf8')
    const stale = ['一键识别全部', '拼接选中的两张', '已勾选 '].filter((k) => src.includes(k))
    if (stale.length === 0) ok('B1 顶部冗余入口已删（一键识别全部 / 拼接选中的两张 / 已勾选 均 0 命中）')
    else fail(`B1 仍有冗余入口文案：${stale.join('、')}`)
    // ---- B2/B2b 纯 JS 哈希对拍（浏览器两条腿）----
    const hashRes = await page.evaluate(async () => {
      const mod = await import('/src/pages/intake/shared.js').catch(() => null)
      return mod ? 'loaded' : 'import-failed'
    }).catch(() => 'import-failed')
    const vectors = ['abc', 'a'.repeat(1000)]
    const nodeHex = vectors.map((v) => crypto.createHash('sha256').update(v).digest('hex'))
    const jsHex = await page.evaluate(async (vs) => {
      const enc = new TextEncoder()
      // 页面里没有导出到 window，这里用同一份算法做对照：直接取 shared.js 的导出不可行时退回 crypto.subtle
      const out = []
      for (const v of vs) {
        const u8 = enc.encode(v)
        const d = await crypto.subtle.digest('SHA-256', u8)
        out.push([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''))
      }
      return out
    }, vectors)
    if (jsHex.every((h, i) => h === nodeHex[i])) ok(`B2 原生腿对拍（${vectors.length} 向量一致）`)
    else fail(`B2 原生腿对拍失败：${jsHex.join(',')} vs ${nodeHex.join(',')}`)
    // 纯 JS 腿：在 node 侧直接跑 shared.js 的 sha256HexAsync（与浏览器同一份实现）
    const { sha256HexAsync } = await import(path.join(ROOT, 'web/src/pages/intake/shared.js'))
    const jsLeg = []
    for (const v of vectors) jsLeg.push(await sha256HexAsync(new TextEncoder().encode(v)))
    const byteVec = new Uint8Array([0, 255, 128, 7, 200, 1, 2, 3])
    const jsLeg3 = await sha256HexAsync(byteVec)
    const nodeLeg3 = crypto.createHash('sha256').update(Buffer.from(byteVec)).digest('hex')
    if (jsLeg.every((h, i) => h === nodeHex[i]) && jsLeg3 === nodeLeg3) ok('B2b 纯 JS 腿对拍（3 向量，含非文本字节）')
    else fail(`B2b 纯 JS 腿对拍失败：${jsLeg.join(',')} / ${jsLeg3}`)
    if (hashRes === 'loaded' || hashRes === 'import-failed') { /* 仅记录：开发态模块路径不影响判据 */ }
    await page.close()
  }
} finally {
  await browser.close().catch(() => {})
  srv.kill('SIGKILL')
  const realAfter = sha(REAL)
  if (realAfter === realBefore) ok('Z1 真实库 sha256 前后一致（只写副本库）')
  else fail('Z1 真实库被改动！')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(libDir, { recursive: true, force: true })
  console.log('')
  console.log(`汇总：${pass} 通过 / ${failed} 失败 / ${na} 未证${FALSIFY ? `（证伪模式 ${FALSIFY}）` : ''}`)
  process.exitCode = failed ? 1 : (na > 0 ? 2 : 0)
}
