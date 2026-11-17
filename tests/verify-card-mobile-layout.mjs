// 资料卡移动端版面门禁（L1–L13 + A1–A4）—— 趋势看板 / 原件溯源弹窗 / 账号管理页 / 触控热区
//
// 规格：.agents/card-mobile-layout-1117-spec.md + 主理人 2026-11-17 裁定
//       + AI 审核 r1（.agents/ui-audit-1117-review-r1.md）追加的 4 类可复跑判据
//
// 用户故障（真机截图）：约 400px 安卓上指标卡被压成几十 px 竖条、点列表一字符一行、图表缩到看不出形状。
// 病根是 CardPage 窄屏媒体查询 repeat(auto-fit,minmax(0,1fr)) 按卡片数量均分（9 张 ⇒ 28.33px/张）。
// 主判据因此是**卡宽**；scrollWidth<=innerWidth 同时保留（抓页面级横向溢出，如账号页 103px）。
//
// 运行：node tests/verify-card-mobile-layout.mjs
// 判据：
//   L1  375 首卡 clientWidth ≈ 轨道宽−2 ±1 且 ≥300（改前 26px）
//   L2  375 卡内 svg 宽 ≥300、点列表容器宽 ≥300（改前 2px / 2px）
//   L3  375 点列表 2 行截断（clamp=2）+ 共 N 次 + title 全文
//   L4  375/1440 文档均无横向溢出
//   L5  375 弹窗整屏贴边、每侧内距 12±1、标题/工具栏/原件左缘极差 ≤1、工具栏单行
//   L6  1440 仍 3 列 × 401±2（不退化）、弹窗内距 12±1、两栏并排
//   L7  弹窗内距只有一层（body 0 + 左栏 12；antd container padding 已归零）
//   L8  375 账号管理页无横向溢出（改前 478−375=103px）
//   L9  375 账号表格单元格 nowrap + 内部横滑 + 无单元格内容截断
//   L10 刻度字号**渲染实测** ≥9px（375 与 1440）
//   L11 375 弹窗总高 ≤ 视口（用 100dvh）且长内容在 body 内部滚动
//   L12 顶栏/登录按钮触控热区 ≥44（用 elementFromPoint 验伪元素外扩，不是量 rect）
//   L13 有原件 blob 夹具时：原件图片渲染宽度 > 0 且弹窗仍 ≤ 视口（A8 要求的真夹具）
//   A1  标题与工具组 rect 交集面积 = 0，且工具组 scrollWidth <= clientWidth（零遮挡/零水平裁切）
//   A2  point 行 scrollHeight <= clientHeight + 1（可见 2 行、不外溢）
//   A3  所有 svg text 渲染高 ≥9px，且参考刻度 bbox 与点值标签 bbox 零相交
//   A4  趋势卡 scrollIntoView 后额外落盘截图（.agents/ui-audit-1117/shots/）
//
// 证伪（--falsify=…，exit 1 = 真红；exit 0 = 判据恒绿 = 测试失效）：
//   --falsify=grid     窄屏网格塞回 repeat(auto-fit,minmax(0,1fr)) ⇒ L1/L2/A3 必须红
//   --falsify=padding  body 塞回 12 + 左栏 8 双层内距           ⇒ L5/L7 必须红

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const FALSIFY = (process.argv.find((a) => a.startsWith('--falsify=')) || '').split('=')[1] || ''
const PORT = 5210 + Math.floor(Math.random() * 60)
const ROOT = path.join(import.meta.dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'medbrief-mobile-'))
const REPORTS = path.join(TMP, 'reports.json')
const DATA_DIR = path.join(TMP, 'data')
// 截图落在独立子目录：不覆盖巡检线已有的 shots/ 原图（那是别人的证据文件）
const SHOTS = path.join(ROOT, '.agents', 'ui-audit-1117', 'shots', 'verify-mobile')
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })
fs.copyFileSync(path.join(ROOT, 'data', 'reports.json'), REPORTS)

const ENV = {
  ...process.env,
  PORT: String(PORT),
  MEDBRIEF_REPORTS_FILE: REPORTS,
  MEDBRIEF_DATA_DIR: DATA_DIR,
  MB_SESSION_SECRET: 'verify-card-mobile-layout-secret-32chars-ok',
  MEDBRIEF_AUTH: 'on',
}
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealth(timeout = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return } catch {}
    await sleep(120)
  }
  throw new Error('服务未能启动')
}

// 1×1 红点 PNG：够验「有原件 blob」路径（渲染宽度 > 0、内距、缩放容器不塌）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ============ 页面内测量 ============
const M_TRENDS = () => {
  const g = document.querySelector('.mb-trends-grid')
  if (!g) return { error: 'no grid' }
  const cards = [...g.children]
  const c0 = cards[0]
  const body = c0.querySelector('.ant-card-body')
  const outer = [...body.querySelectorAll('div')].find((d) => (d.getAttribute('style') || '').includes('margin-top: 4px'))
  const inner = outer ? outer.querySelector('div[title]') : null
  const svg = c0.querySelector('svg')
  const cs = (e) => (e ? getComputedStyle(e) : null)
  const nonEmpty = getComputedStyle(g).gridTemplateColumns.split(' ').filter((v) => parseFloat(v) > 0).length
  // 标题 vs 工具组
  let optHead = null
  for (const h of document.querySelectorAll('.ant-card-head')) if (/可选指标/.test(h.textContent || '')) { optHead = h; break }
  const headTitle = optHead?.querySelector('.ant-card-head-title')
  const headExtra = optHead?.querySelector('.ant-card-extra')
  const inter = (a, c) => {
    const ox = Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left))
    const oy = Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top))
    return Math.round(ox * oy)
  }
  let otherOverlaps = 0
  for (const h of document.querySelectorAll('.ant-card-head')) {
    const tt = h.querySelector('.ant-card-head-title'), ee = h.querySelector('.ant-card-extra')
    if (tt && ee && inter(tt.getBoundingClientRect(), ee.getBoundingClientRect()) > 0) otherOverlaps++
  }
  const extraRect = headExtra?.getBoundingClientRect()
  const clippedBtn = headExtra ? [...headExtra.querySelectorAll('button, .ant-segmented')].filter((x) => {
    const r = x.getBoundingClientRect()
    return extraRect && (r.left < extraRect.left - 1 || r.right > extraRect.right + 1)
  }).length : 0
  // svg 文字
  const vb = svg.getAttribute('viewBox').split(' ').map(Number)
  const scale = svg.getBoundingClientRect().width / vb[2]
  const texts = [...svg.querySelectorAll('text')].map((t) => ({
    h: +t.getBoundingClientRect().height.toFixed(1), r: t.getBoundingClientRect(), fill: t.getAttribute('fill'),
  }))
  let refVsVal = 0
  const refs = texts.filter((x) => x.fill === '#6b7280').map((x) => x.r)
  const vals = texts.filter((x) => x.fill === '#374151').map((x) => x.r)
  for (const a of refs) for (const c of vals) if (a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) refVsVal++
  return {
    scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    gridW: g.clientWidth, tracks: nonEmpty, cardW: c0.clientWidth,
    svgW: Math.round(svg.getBoundingClientRect().width),
    pointW: outer ? outer.clientWidth : 0, pointH: outer ? Math.round(outer.getBoundingClientRect().height) : 0,
    pointScrollH: outer ? outer.scrollHeight : 0, pointClientH: outer ? outer.clientHeight : 0,
    clamp: inner ? cs(inner).webkitLineClamp : null,
    pointTitleLen: inner ? (inner.title || '').length : 0,
    pointHasCount: outer ? /共 \d+ 次/.test(outer.textContent) : false,
    renderedPx: texts.length ? +(parseFloat(cs(svg.querySelector('text')).fontSize) * scale).toFixed(2) : 0,
    minTextH: texts.length ? Math.min(...texts.map((x) => x.h)) : 0,
    refVsValOverlaps: refVsVal,
    optTitleOverlap: (headTitle && headExtra) ? inter(headTitle.getBoundingClientRect(), headExtra.getBoundingClientRect()) : 0,
    optTitleW: headTitle ? Math.round(headTitle.getBoundingClientRect().width) : null,
    otherCardOverlaps: otherOverlaps,
    toolbarScrollW: headExtra?.scrollWidth ?? 0, toolbarClientW: headExtra?.clientWidth ?? 0,
    clippedButtons: clippedBtn,
  }
}

const M_MODAL = () => {
  const dlg = document.querySelector('[role="dialog"]')
  if (!dlg) return { error: 'no dialog' }
  const modal = dlg.closest('.ant-modal') || dlg
  const container = modal.querySelector('.ant-modal-container')
  const bodyEl = modal.querySelector('.ant-modal-body')
  const header = modal.querySelector('.ant-modal-header')
  const title = modal.querySelector('.ant-modal-title') || header
  const leftCol = modal.querySelector('.mb-source-left')
  const rightCol = modal.querySelector('.mb-source-right')
  const toolbar = leftCol ? leftCol.querySelector('.ant-space') : null
  const preview = leftCol ? [...leftCol.querySelectorAll('div')].find((d) => (d.getAttribute('style') || '').includes('overflow: auto')) : null
  const img = leftCol ? leftCol.querySelector('img, iframe') : null
  const cs = (e) => (e ? getComputedStyle(e) : null)
  const r = (e) => (e ? e.getBoundingClientRect() : null)
  const px = (e, p) => parseFloat(cs(e)?.[p] || '0')
  const L = (e) => { const x = r(e); return x ? +x.left.toFixed(1) : null }
  const m = r(modal)
  const tbr = r(toolbar)
  const clipped = toolbar ? [...toolbar.querySelectorAll('button')].filter((x) => {
    const q = r(x); return q.left < tbr.left - 1 || q.right > tbr.right + 1
  }).length : 0
  const deltas = [L(title), L(toolbar), L(preview)].filter((v) => v !== null)
  return {
    modalW: Math.round(m.width), modalH: Math.round(m.height), vh: window.innerHeight,
    containerPad: px(container, 'paddingLeft'), bodyPad: px(bodyEl, 'paddingLeft'), leftPad: px(leftCol, 'paddingLeft'),
    insetPerSide: +(px(bodyEl, 'paddingLeft') + px(leftCol, 'paddingLeft')).toFixed(1),
    titleLeftX: L(title), toolbarLeftX: L(toolbar), previewLeftX: L(preview),
    alignSpread: deltas.length ? +(Math.max(...deltas) - Math.min(...deltas)).toFixed(1) : null,
    toolbarRects: toolbar ? toolbar.getClientRects().length : null,
    toolbarScrollW: toolbar?.scrollWidth ?? 0, toolbarClientW: toolbar?.clientWidth ?? 0, clippedButtons: clipped,
    bodyScrollH: bodyEl ? bodyEl.scrollHeight : 0, bodyClientH: bodyEl ? bodyEl.clientHeight : 0,
    previewH: preview ? Math.round(r(preview).height) : 0,
    imgW: img ? Math.round(r(img).width) : 0,
    twoCol: !!(leftCol && rightCol && Math.abs(r(leftCol).top - r(rightCol).top) < 2 && r(leftCol).right < r(rightCol).right),
  }
}

// 触控热区：伪元素不进 rect ⇒ 用 elementFromPoint 在中心上下/左右各 10px 打点，命中同一按钮才算 ≥44
const M_TOUCH = () => {
  const out = {}
  for (const cls of ['mb-nav-trigger', 'mb-logout', 'mb-log-btn']) {
    const el = document.querySelector('.' + cls)
    if (!el) { out[cls] = { ok: false, why: 'not found' }; continue }
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const hit = (x, y) => {
      const t = document.elementFromPoint(x, y)
      return !!(t && (t === el || el.contains(t) || (t.closest && t.closest('.' + cls) === el)))
    }
    const up = hit(cx, r.top - 10), down = hit(cx, r.bottom + 10)
    out[cls] = { rectH: Math.round(r.height), up, down, ok: up && down }
  }
  return out
}

// ============ 页面流程 ============
async function loginCtx(browser, w, h, phone, password) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } })
  const page = await ctx.newPage()
  const res = await ctx.request.post(BASE + '/api/auth/login', { data: { phone, password } })
  if (!res.ok()) throw new Error(`登录失败 ${res.status()} (${phone})`)
  return { ctx, page }
}

async function run(browser, results) {
  const T = (name, fn) => {
    try { fn(); results.push({ name, ok: true }) } catch (e) { results.push({ name, ok: false, msg: e.message }) }
  }
  const near = (a, b, tol, label) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${label}: ${a} vs ${b} 差 ${Math.abs(a - b).toFixed(1)} > ${tol}`) }
  const ge = (a, b, label) => { if (!(a >= b)) throw new Error(`${label}: ${a} < ${b}`) }
  const eq = (a, b, label) => { if (a !== b) throw new Error(`${label}: ${a} !== ${b}`) }

  // ---------- 375 用户端 ----------
  {
    const { ctx, page } = await loginCtx(browser, 375, 812, '13200000000', '123456')
    try {
      await page.goto(BASE + '/?tab=card', { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      if (FALSIFY === 'grid') await page.addStyleTag({ content: '@media (max-width:575px){ .mb-trends-grid{ grid-template-columns: repeat(auto-fit, minmax(0,1fr)) !important; } }' })
      if (FALSIFY === 'padding') await page.addStyleTag({ content: '[role="dialog"] .ant-modal-body{ padding: 12px 12px !important; } .mb-source-left{ padding: 8px !important; }' })
      await page.locator('.ant-tabs-tab', { hasText: '动态趋势看板' }).first().click()
      await page.waitForTimeout(1600)
      const t = await page.evaluate(M_TRENDS)

      T('L1 375 首卡满宽（轨道宽−2±1 且 ≥300）', () => { near(t.cardW, t.gridW - 2, 1, '卡宽/轨道宽'); ge(t.cardW, 300, '卡宽') })
      T('L2 375 图表与点列表不塌缩（各 ≥300）', () => { ge(t.svgW, 300, 'svg 宽'); ge(t.pointW, 300, '点列表宽') })
      T('L3 375 点列表 2 行截断 + 共 N 次 + title 全文', () => {
        eq(String(t.clamp), '2', 'clamp'); if (!(t.pointH <= 60)) throw new Error(`点列表高 ${t.pointH} > 60`)
        ge(t.pointTitleLen, 20, 'title 全量'); if (!t.pointHasCount) throw new Error('缺「共 N 次」')
      })
      T('L4a 375 文档无横向溢出', () => { if (!(t.scrollWidth <= t.innerWidth)) throw new Error(`scrollWidth ${t.scrollWidth} > ${t.innerWidth}`) })
      T('A1 标题与工具组零交集（含全部卡）', () => {
        eq(t.optTitleOverlap, 0, '「可选指标」标题∩工具组面积'); eq(t.otherCardOverlaps, 0, '其它卡头重叠数')
        ge(t.optTitleW, 120, '标题可见宽度'); eq(t.clippedButtons, 0, '被水平裁切的按钮数')
        if (!(t.toolbarScrollW <= t.toolbarClientW)) throw new Error(`工具组 scrollW ${t.toolbarScrollW} > clientW ${t.toolbarClientW}（内容被裁）`)
      })
      T('A2 点列表可见 2 行不外溢（scrollHeight≤clientHeight+1）', () => { if (!(t.pointScrollH <= t.pointClientH + 1)) throw new Error(`scrollH ${t.pointScrollH} > clientH ${t.pointClientH} + 1`) })
      T('A3 SVG 文字渲染高 ≥9 且参考刻度与点值零叠字', () => { ge(t.minTextH, 9, '最小文字渲染高'); eq(t.refVsValOverlaps, 0, '参考刻度∩点值标签') })
      T('L10a 375 刻度渲染字号 ≥9px', () => { ge(t.renderedPx, 9, '渲染字号') })

      // A4：滚动到趋势卡后落盘截图（人眼可复核 U1）
      await page.locator('.mb-trends-grid').first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(500)
      const shot = path.join(SHOTS, '05-card-trends-375-cards.png')
      await page.screenshot({ path: shot })
      T('A4 趋势卡截图已落盘（scrollIntoView 后）', () => {
        const st = fs.statSync(shot)
        if (!(st.size > 10000)) throw new Error(`截图只有 ${st.size}B`)
      })

      // 弹窗（含原件 blob 夹具）
      await page.locator('.ant-tabs-tab', { hasText: '临床指标总览' }).first().click()
      await page.waitForTimeout(1200)
      await page.locator('tr.ant-table-row').first().click({ timeout: 6000 })
      await page.waitForTimeout(2200)
      const d = await page.evaluate(M_MODAL)
      fs.writeFileSync(path.join(SHOTS, '12-modal-source-375-with-blob.png'), await page.screenshot())
      T('L5a 375 弹窗贴边整屏（375±1）', () => { if (d.error) throw new Error(d.error); near(d.modalW, 375, 1, '弹窗宽') })
      T('L5b 375 每侧内距 12±1（改前 20 + antd container 24）', () => { near(d.insetPerSide, 12, 1, '每侧内距') })
      T('L5c 375 标题/工具栏/原件左缘极差 ≤1', () => { if (!(d.alignSpread <= 1)) throw new Error(`左缘极差 ${d.alignSpread}px`) })
      T('L5d 375 工具栏单行且无按钮被裁', () => { eq(d.toolbarRects, 1, '工具栏行数'); eq(d.clippedButtons, 0, '被裁按钮数'); if (!(d.toolbarScrollW <= d.toolbarClientW)) throw new Error(`工具栏 scrollW ${d.toolbarScrollW} > clientW ${d.toolbarClientW}`) })
      T('L7 弹窗内距只有一层（container 0 + body 0 + 左栏 12）', () => { eq(d.containerPad, 0, 'container padding'); eq(d.bodyPad, 0, 'body padding'); eq(d.leftPad, 12, '左栏 padding') })
      T('L11 375 弹窗总高 ≤ 视口且内容内部滚动', () => { if (!(d.modalH <= d.vh + 1)) throw new Error(`弹窗高 ${d.modalH} > 视口 ${d.vh}`); if (!(d.bodyScrollH > d.bodyClientH)) throw new Error(`内容未内部滚动 ${d.bodyScrollH}/${d.bodyClientH}`) })
      T('L13 有原件夹具：图片渲染宽 > 0 且原件区 > 0', () => { ge(d.imgW, 100, '原件渲染宽'); ge(d.previewH, 100, '原件区高') })
    } finally { await ctx.close() }
  }

  // ---------- 375 管理员（U3 + 触控热区）----------
  {
    const { ctx, page } = await loginCtx(browser, 375, 812, '13228372097', 'scallion')
    try {
      await page.goto(BASE + '/?tab=accounts', { waitUntil: 'networkidle' })
      await page.waitForTimeout(2200)
      const a = await page.evaluate(() => {
        const tables = [...document.querySelectorAll('.ant-table')]
        const box = tables[0]?.querySelector('.ant-table-content')
        const cells = [...document.querySelectorAll('.ant-table-tbody td')]
        return {
          scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
          tables: tables.length,
          tableScrolls: box ? box.scrollWidth > box.clientWidth + 1 : false,
          cellOverflow: cells.filter((td) => td.scrollWidth > td.clientWidth + 1).length,
          phoneWhiteSpace: cells[0] ? getComputedStyle(cells[0]).whiteSpace : null,
        }
      })
      await page.screenshot({ path: path.join(SHOTS, '11-accounts-375.png') })
      T('L8 375 账号管理页无横向溢出', () => { if (!(a.scrollWidth <= a.innerWidth)) throw new Error(`scrollWidth ${a.scrollWidth} > ${a.innerWidth}（溢出 ${a.scrollWidth - a.innerWidth}px）`) })
      T('L9 375 表格 nowrap + 内部横滑 + 无内容截断', () => { eq(a.phoneWhiteSpace, 'nowrap', '手机号单元格 white-space'); if (!a.tableScrolls) throw new Error('未启用横向滚动'); eq(a.cellOverflow, 0, '被截断单元格数') })
      const touch = await page.evaluate(M_TOUCH)
      T('L12 顶栏按钮触控热区 ≥44（伪元素外扩）', () => {
        for (const [k, v] of Object.entries(touch)) if (!v.ok) throw new Error(`${k} 热区不足（上 ${v.up} / 下 ${v.down}，rect 高 ${v.rectH}）`)
      })
    } finally { await ctx.close() }
  }

  // ---------- 1440 ----------
  {
    const { ctx, page } = await loginCtx(browser, 1440, 900, '13200000000', '123456')
    try {
      await page.goto(BASE + '/?tab=card', { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      await page.locator('.ant-tabs-tab', { hasText: '动态趋势看板' }).first().click()
      await page.waitForTimeout(1600)
      const t2 = await page.evaluate(M_TRENDS)
      await page.locator('tr.ant-table-row').first().click({ timeout: 6000 }).catch(() => {})
      await page.waitForTimeout(300)
      T('L6a 1440 仍 3 列且卡宽 ≥380（不退化）', () => { eq(t2.tracks, 3, '列数'); ge(t2.cardW, 380, '卡宽') })
      T('L4b 1440 文档无横向溢出', () => { if (!(t2.scrollWidth <= t2.innerWidth)) throw new Error(`scrollWidth ${t2.scrollWidth} > ${t2.innerWidth}`) })
      T('L10b 1440 刻度渲染字号 ≥9px（不得变小）', () => { ge(t2.renderedPx, 9, '渲染字号') })
      T('A3b 1440 参考刻度与点值零叠字', () => { eq(t2.refVsValOverlaps, 0, '参考刻度∩点值标签'); ge(t2.minTextH, 9, '最小文字渲染高') })
    } finally { await ctx.close() }
  }

  // ---------- 1440 弹窗两栏 ----------
  {
    const { ctx, page } = await loginCtx(browser, 1440, 900, '13200000000', '123456')
    try {
      await page.goto(BASE + '/?tab=card', { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      await page.locator('tr.ant-table-row').first().click({ timeout: 6000 })
      await page.waitForTimeout(2200)
      const d2 = await page.evaluate(M_MODAL)
      T('L6b 1440 弹窗每侧内距 12±1', () => { if (d2.error) throw new Error(d2.error); near(d2.insetPerSide, 12, 1, '每侧内距') })
      T('L6c 1440 弹窗两栏并排', () => { if (!d2.twoCol) throw new Error('左右栏未并排') })
    } finally { await ctx.close() }
  }
}

// ============ 主流程 ============
const main = async () => {
  process.env.MEDBRIEF_DATA_DIR = DATA_DIR
  const accounts = await import('../lib/accounts.mjs')
  const blobStore = await import('../lib/blobStore.mjs')
  const owner = accounts.createUser({ phone: '13200000000', password: '123456', role: 'user', allowWeak: true })
  accounts.createUser({ phone: '13228372097', password: 'scallion', role: 'admin' })
  // 有原件夹具（A8/boundary②）：先存一张 PNG，再把报告指向它，最后登记归属
  const blob = blobStore.saveBlob(Buffer.from(PNG_B64, 'base64'), { kind: 'original', type: 'image/png', width: 1, height: 1 })
  accounts.setBlobOwner(blob.id, owner.id)
  const rep = JSON.parse(fs.readFileSync(REPORTS, 'utf8'))
  // 所有报告都指向夹具原件：门禁点的是「首行」，不保证是同一份报告
  for (const r of rep.reports) r.fileBlobId = r.fileBlobId || blob.id
  for (const id of [...rep.reports, ...(rep.trashed || [])].map((x) => x.id)) accounts.setOwner(id, owner.id, { source: 'bootstrap' })
  fs.writeFileSync(REPORTS, JSON.stringify(rep))

  const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  srv.stderr.on('data', (d) => { stderr += d.toString() })
  const results = []
  let browser
  try {
    await waitHealth()
    browser = await chromium.launch()
    await run(browser, results)
  } finally {
    if (browser) await browser.close().catch(() => {})
    srv.kill('SIGKILL')
    await new Promise((r) => { srv.once('exit', r); setTimeout(r, 2500) })
    await sleep(200)
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
    try { (await import('../lib/accounts.mjs')).closeDb?.() } catch {}
  }

  console.log('\n===== 资料卡移动端版面（L/A 判据）=====')
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  ← ' + r.msg}`)
  const pass = results.filter((r) => r.ok).length, fail = results.length - pass
  console.log(`\n通过 ${pass} / 失败 ${fail}${stderr.trim() ? '\n[stderr] ' + stderr.trim().split('\n').slice(-2).join(' | ') : ''}`)

  if (FALSIFY) {
    const expectedRed = FALSIFY === 'grid'
      ? results.filter((r) => /^L[12] |^A3 /i.test(r.name) || /^L1 |^L2 /.test(r.name))
      : results.filter((r) => /^L5b|^L5c|^L7/.test(r.name))
    const anyRed = expectedRed.some((r) => !r.ok)
    console.log(anyRed
      ? `\n[falsify=${FALSIFY}] 期望判据确实红了 → exit 1（真红，判据有分辨力）`
      : `\n[falsify=${FALSIFY}] 期望判据仍全绿 → exit 0（判据失去分辨力，测试失效）`)
    process.exit(anyRed ? 1 : 0)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('门禁异常：', e.message); process.exit(1) })
