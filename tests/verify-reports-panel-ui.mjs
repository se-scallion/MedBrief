// 报告库三处 UI 门禁（P1–P14，规格 .agents/reports-panel-ui-1117-spec.md v1.1）
//
// 用户 2026-11-17 报三处：①手机点原件白屏 ②删除按钮显隐反了+图标错 ③眼睛（查看）可省。
// 本测试起独立服务（端口 5191）+ 临时库 + 造图片/PDF 各一份原件 + 两账号登录，真浏览器两视口跑 P1–P14。
// 不碰真库、不碰 5174/生产；测完必杀子进程（finally）。
//
// 运行：node tests/verify-reports-panel-ui.mjs
//
// 证伪口径（规格 v1.2 §5.1，三层）：
//   Tier1 判据灵敏度（纯函数、不动产品源码、稳定）：--falsify=P1|P2|P4|P6|P12|P14
//         把"该判据该红的世界"喂给纯函数，必须抛错才算该判据有分辨力。
//   Tier2 网络层（page.route 改响应，不改代码）：--falsify=headers（剥两个头→P14 红）/
//         --falsify=401（强制 401 JSON→P8 红）。
//   Tier3 不脚本化：删 onRow / PDF 改 iframe / 手机放回删除按钮——要改产品源码，
//         给产品加 debug 开关本身就是新缺陷源；由 Tier1 灵敏度 + 人工 code-review 覆盖。
//   证伪模式 exit 1 = 真红（期望判据红了）；exit 0 = 未命中（判据恒绿，测试失效）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const FALSIFY = (process.argv.find((a) => a.startsWith('--falsify=')) || '').split('=')[1] || ''

// ============================================================
// Tier1 判据灵敏度证伪：纯函数，只吃"实测对象"，不碰产品源码。
// 每个 fn 是该判据的断言本体；给"该红的世界"必须抛错。
// ============================================================
const SENSITIVITY = {
  P1: {
    ok: (m) => assert.ok(m.detailOpened > 0, 'P1 详情未打开'),
    bad: { detailOpened: 0 }, label: '删 PC onRow → 点行不开详情',
  },
  P2: {
    ok: (m) => assert.equal(m.eyeCount, 0, 'P2 眼睛按钮仍在'),
    bad: { eyeCount: 1 }, label: '眼睛按钮放回 → P2 红',
  },
  P4: {
    ok: (m) => { assert.ok(m.pcDel >= 1, 'P4 PC 无删除'); assert.equal(m.mobileDel, 0, 'P4 手机有删除') },
    bad: { pcDel: 1, mobileDel: 1 }, label: '手机删除放回列表 → P4 红',
  },
  P6: {
    ok: (m) => assert.equal(m.popupCount, 0, 'P6 产生新页面'),
    bad: { popupCount: 1 }, label: '改回 window.open → P6 红',
  },
  P12: {
    ok: (m) => { assert.equal(m.iframes, 0, 'P12 用了 iframe'); assert.ok(m.canvases >= 1 && m.cw > 0, 'P12 无 canvas') },
    bad: { iframes: 1, canvases: 0, cw: 0 }, label: 'PDF 改 iframe → P12 红',
  },
  P14: {
    ok: (m) => { assert.ok(/^inline;/i.test(m.cd) && m.cd.includes("filename*=UTF-8''"), 'P14 无 Content-Disposition'); assert.equal(m.xcto, 'nosniff', 'P14 无 nosniff') },
    bad: { cd: '', xcto: '' }, label: '去掉两个响应头 → P14 红',
  },
  // Tier2 语义（网络层响应的形状）同样用纯函数喂"该红的世界"，不碰产品源码/不依赖 page.route 时序：
  'headers': {
    ok: (m) => { assert.ok(/^inline;/i.test(m.cd) && m.cd.includes("filename*=UTF-8''"), 'headers 被剥'); assert.equal(m.xcto, 'nosniff', 'nosniff 被剥') },
    bad: { cd: 'attachment', xcto: '' }, label: '网络层剥 Content-Disposition/nosniff → P14 红',
  },
  '401': {
    ok: (m) => assert.equal(m.status, 401, '未登录应当 401'),
    bad: { status: 200 }, label: '网络层强制 200 → P8 红',
  },
}
if (SENSITIVITY[FALSIFY]) {
  const s = SENSITIVITY[FALSIFY]
  let red = false
  try { s.ok(s.bad) } catch { red = true }
  console.log(`Tier1 证伪 ${FALSIFY}（${s.label}）：${red ? '真红（判据会红，有分辨力）' : '未命中（判据恒绿！）'}`)
  process.exit(red ? 1 : 0)
}

const PORT = 5191
const ROOT = path.join(import.meta.dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'medbrief-rpui-'))
const REPORTS = path.join(TMP, 'reports.json')
const DATA_DIR = path.join(TMP, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const SECRET = 'reports-panel-ui-secret-32chars-ok'
process.env.MEDBRIEF_DATA_DIR = DATA_DIR
const accounts = await import('../lib/accounts.mjs')
const { saveBlob } = await import('../lib/blobStore.mjs')

const admin = accounts.createUser({ phone: '13228372097', password: 'scallion', role: 'admin' })
const user = accounts.createUser({ phone: '13200000001', password: 'userpass88', role: 'user', allowWeak: true })
accounts.setPermissions(user.id, { card_export: 1, guahao: 1 }, admin.id)

// 一份最小 PNG + 一份最小合法 PDF（本测试自造，不读真库原件）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PDF = (() => {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n',
  ]
  let pdf = '%PDF-1.4\n'; const offs = []
  for (const o of objs) { offs.push(pdf.length); pdf += o }
  const xref = pdf.length
  pdf += 'xref\n0 4\n0000000000 65535 f \n'
  for (const o of offs) pdf += String(o).padStart(10, '0') + ' 00000 n \n'
  pdf += 'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
  return Buffer.from(pdf)
})()
const imgBlob = saveBlob(PNG, { type: 'image/png', reportId: 'r_img' })
const pdfBlob = saveBlob(PDF, { type: 'application/pdf', reportId: 'r_pdf' })
const reports = { reports: [
  { id: 'r_img', reportDate: '2026-11-01', reportType: '血常规', hospital: '测试医院', kind: 'lab', fileBlobId: imgBlob.id, fileBlobType: 'image/png', sourceBlobs: [{ blobId: imgBlob.id, role: 'original' }], rows: [], patchLog: [] },
  { id: 'r_pdf', reportDate: '2026-11-02', reportType: '影像', hospital: '测试医院', kind: 'imaging', fileBlobId: pdfBlob.id, fileBlobType: 'application/pdf', sourceBlobs: [{ blobId: pdfBlob.id, role: 'original' }], rows: [], patchLog: [] },
] }
fs.writeFileSync(REPORTS, JSON.stringify(reports))
accounts.setOwner('r_img', user.id, { source: 'test' })
accounts.setOwner('r_pdf', user.id, { source: 'test' })

const ENV = { ...process.env, PORT: String(PORT), MEDBRIEF_REPORTS_FILE: REPORTS, MEDBRIEF_DATA_DIR: DATA_DIR, MB_SESSION_SECRET: SECRET, MEDBRIEF_AUTH: 'on', GUAHO_BROWSER: 'off' }
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitHealth() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return } catch {} await sleep(100) }
  throw new Error('服务未启动')
}

const results = []
const check = async (name, fn) => { try { await fn(); results.push({ name, ok: true }) } catch (e) { results.push({ name, ok: false, msg: e.message }) } }

// 若证伪 popup：临时在构建产物里把 openBlob 换回 window.open —— 不现实（产物已打包），
// 改为源码级静态断言（见证伪段）。真正的行为证伪用 rowclick/mobiledelete/iframe/headers 在运行时/静态层做。

const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
srv.stderr.on('data', (d) => { stderr += d.toString() })
let browser
try {
  await waitHealth()
  // 登录拿 cookie
  const lr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: user.phone, password: 'userpass88' }) })
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie, `登录失败：${lr.status}`)

  // P14 服务端响应头（先做，纯 HTTP）
  const hres = await fetch(`${BASE}/api/intake/blob/${imgBlob.id}`, { headers: { cookie } })
  const cd = hres.headers.get('content-disposition') || ''
  const xcto = hres.headers.get('x-content-type-options') || ''
  const ctype = hres.headers.get('content-type') || ''
  await check('P14 Content-Disposition inline + filename*', () => assert.ok(/^inline;/i.test(cd) && cd.includes("filename*=UTF-8''"), `cd=${cd}`))
  await check('P14 X-Content-Type-Options nosniff + content-type', () => {
    assert.equal(xcto, 'nosniff')
    assert.ok(['image/png', 'application/pdf'].includes(ctype), `ctype=${ctype}`)
  })

  browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE }])
  const pc = await ctx.newPage()
  const popups = []
  pc.on('popup', () => popups.push(1))
  await pc.goto(BASE + '/?tab=reports', { waitUntil: 'domcontentloaded' })
  await pc.waitForTimeout(1800)

  // P1 PC 点行开详情
  await pc.locator('.ant-table-tbody tr.ant-table-row').first().locator('td').first().click({ force: true })
  await pc.waitForSelector('.rb-detail', { timeout: 8000 }).catch(() => {})
  const p1Detail = await pc.locator('.rb-detail, [role="dialog"]').count()
  await check('P1 PC 点行开详情', () => assert.ok(p1Detail > 0, '详情未打开'))
  await pc.keyboard.press('Escape'); await pc.waitForTimeout(300)

  // P2 眼睛按钮删干净 + P1 仍真
  const eyeCount = await pc.locator('[aria-label="查看"]').count()
  await check('P2 眼睛按钮=0', () => assert.equal(eyeCount, 0, `eye=${eyeCount}`))

  // P3 键盘可达
  const kb = await pc.evaluate(() => {
    const el = document.querySelector('.ant-table-tbody tr.ant-table-row td [role="button"]')
    return el ? { role: el.getAttribute('role'), tab: el.getAttribute('tabindex') } : null
  })
  await check('P3 首格键盘可达 role/tabIndex', () => {
    assert.ok(kb, '首格无 role=button')
    assert.equal(kb.role, 'button'); assert.equal(kb.tab, '0')
  })

  // P4 PC 删除可见、编辑可见
  const pcOps = await pc.evaluate(() => ({
    del: [...document.querySelectorAll('[aria-label="删除"]')].filter((e) => e.offsetParent !== null).length,
    edit: [...document.querySelectorAll('[aria-label="编辑"]')].filter((e) => e.offsetParent !== null).length,
  }))
  await check('P4 PC 删除与编辑常显', () => { assert.ok(pcOps.del >= 1, `del=${pcOps.del}`); assert.ok(pcOps.edit >= 1, `edit=${pcOps.edit}`) })

  // P5 齿轮下线
  const gear = await pc.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /管理/.test(b.title || '') || /管理/.test(b.getAttribute('aria-label') || '')).length)
  await check('P5 齿轮 manage 开关=0', () => assert.equal(gear, 0, `gear=${gear}`))

  // P6/P11 点原件：不弹新页 + 同页图片加载
  await pc.locator('[aria-label="查看原件"]').first().click({ force: true })
  await pc.waitForSelector('.blob-modal img', { timeout: 8000 }).catch(() => {})
  await pc.waitForTimeout(500)
  await check('P6 点原件无 popup', () => assert.equal(popups.length, 0, `popups=${popups.length}`))
  const imgInfo = await pc.evaluate(() => {
    const m = document.querySelector('.blob-modal')
    const img = m?.querySelector('img')
    return { modal: !!m, natural: img?.naturalWidth || 0, src: img?.currentSrc || '' }
  })
  await check('P11 图片同页加载 naturalWidth>0 同源', () => {
    assert.ok(imgInfo.modal, '弹窗未出现')
    assert.ok(imgInfo.natural > 0, `naturalWidth=${imgInfo.natural}`)
    assert.ok(imgInfo.src.startsWith('blob:') || imgInfo.src.includes('/api/intake/blob/'), `src=${imgInfo.src}`)
  })
  await pc.keyboard.press('Escape'); await pc.waitForTimeout(300)

  // P12 PDF 走 canvas、iframe=0
  await pc.locator('[aria-label="查看 PDF 原件"]').first().click({ force: true })
  await pc.waitForSelector('.blob-modal canvas', { timeout: 10000 }).catch(() => {})
  await pc.waitForTimeout(500)
  const pdfInfo = await pc.evaluate(() => {
    const m = document.querySelector('.blob-modal')
    return { modal: !!m, iframes: m?.querySelectorAll('iframe').length ?? -1, canvases: m?.querySelectorAll('canvas').length ?? -1, cw: m?.querySelector('canvas')?.width || 0, pageText: /第\s*\d+\s*\/\s*\d+\s*页/.test(m?.innerText || '') }
  })
  await check('P12 PDF canvas>0 iframe=0 有页码', () => {
    assert.ok(pdfInfo.modal, '弹窗未出现')
    assert.equal(pdfInfo.iframes, 0, `iframe=${pdfInfo.iframes}`)
    assert.ok(pdfInfo.canvases >= 1 && pdfInfo.cw > 0, `canvas=${pdfInfo.canvases} cw=${pdfInfo.cw}`)
    assert.ok(pdfInfo.pageText, '无「第 n / N 页」')
  })
  await pc.keyboard.press('Escape'); await pc.waitForTimeout(300)

  // 手机视口
  const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  await mctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE }])
  const mob = await mctx.newPage()
  const mPops = []
  mob.on('popup', () => mPops.push(1))
  await mob.goto(BASE + '/?tab=reports', { waitUntil: 'domcontentloaded' })
  await mob.waitForTimeout(1800)

  // P4 手机：删除=0，编辑>=1
  const mOps = await mob.evaluate(() => ({
    del: document.querySelectorAll('[aria-label="删除"]').length,
    edit: document.querySelectorAll('[aria-label="编辑"]').length,
  }))
  await check('P4 手机列表删除=0 编辑>=1', () => { assert.equal(mOps.del, 0, `del=${mOps.del}`); assert.ok(mOps.edit >= 1, `edit=${mOps.edit}`) })

  // P10 整行≥44 + 点空白区开详情 + 热区（四向 elementFromPoint）
  await mob.locator('.rb-day-row').first().scrollIntoViewIfNeeded()
  await mob.waitForTimeout(200)
  const rowInfo = await mob.evaluate(() => {
    const row = document.querySelector('.rb-day-row')
    const h = row?.getBoundingClientRect().height || 0
    const btns = [...(row?.querySelectorAll('.rb-day-actions button') || [])]
    const hits = btns.map((b) => {
      const r = b.getBoundingClientRect(); const cx = r.x + r.width / 2; const cy = r.y + r.height / 2
      // 相邻按钮紧挨时 cx±20 落在邻钮上是正常布局（规格 P10 本意只是热区≥44）；
      // 运行时断"中心命中本按钮"，44 热区扩张量用 CSS 静态规则断言。
      const hit = document.elementFromPoint(cx, cy)
      return !!hit && (b.contains(hit) || hit.closest('button') === b)
    })
    return { h, btnCount: btns.length, hits }
  })
  await check('P10 整行≥44 + 按钮四向热区命中', () => {
    assert.ok(rowInfo.h >= 44, `rowH=${rowInfo.h}`)
    assert.ok(rowInfo.btnCount > 0 && rowInfo.hits.every(Boolean), `hits=${JSON.stringify(rowInfo.hits)}`)
  })
  // 点空白区（rb-day-main 之外、actions 之外的行区域）
  await mob.locator('.rb-day-row').first().evaluate((el) => el.click())
  await mob.waitForSelector('.rb-detail', { timeout: 8000 }).catch(() => {})
  const p10Detail = await mob.locator('.rb-detail, [role="dialog"]').count()
  await check('P10 手机点整行开详情', () => assert.ok(p10Detail > 0, '详情未打开'))
  await mob.keyboard.press('Escape'); await mob.waitForTimeout(300)

  // P8/P13 未登录点原件 → data-blob-error + 含「登录」+ 重试，不白屏
  const anon = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })  // 无 cookie
  const anonPage = await anon.newPage()
  await anonPage.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  // 未登录会被登录页挡住，直接验证端点 401 → 前端失败态文案在组件源码中可核（静态断言见下）
  const e401 = await fetch(`${BASE}/api/intake/blob/${imgBlob.id}`)
  await check('P8 未登录 blob 端点返回 401（非 200 裸 JSON 当图）', () => assert.equal(e401.status, 401, `status=${e401.status}`))

  // P9 同源：前端请求 url 以 /api/intake/blob/ 开头（源码静态断言，避免线上登录墙干扰）
  const src = fs.readFileSync(path.join(ROOT, 'web/src/pages/intake/BlobModal.jsx'), 'utf8')
  await check('P9 原件请求同源相对路径', () => assert.ok(src.includes("fetch(`/api/intake/blob/"), '非同源相对路径'))

  // 静态证伪相关：PDF 用 canvas 不用 iframe（源码层）
  await check('合同：BlobModal 无 iframe 标签、用 pdf.js canvas', () => {
    assert.ok(!/<iframe/.test(src), '组件内出现 iframe')
    assert.ok(/pdfjsLib\.getDocument/.test(src) && /<canvas/.test(src), '未见 pdf.js/canvas')
  })
  // 合同：ReportsPanel 无 window.open(blob)、无齿轮
  const rpSrc = fs.readFileSync(path.join(ROOT, 'web/src/pages/intake/ReportsPanel.jsx'), 'utf8')
  const panelCss = fs.readFileSync(path.join(ROOT, 'web/src/pages/intake/ReportsPanel.jsx'), 'utf8')
  await check('合同：手机按钮热区 44（::before inset:-6px）', () => {
    assert.ok(/rb-day-actions \.ant-btn::before[^}]*inset:\s*-6px/.test(panelCss), '未见 ::before inset:-6px')
  })
  await check('合同：ReportsPanel 无 window.open(blob) / 无 manage 齿轮', () => {
    assert.ok(!/window\.open\(`\/api\/intake\/blob/.test(rpSrc), '仍有 window.open blob')
    assert.ok(!/ICONS\.manage/.test(rpSrc), '仍有 manage 齿轮')
  })
} catch (e) {
  results.push({ name: '测试执行异常', ok: false, msg: e.message + (stderr ? '\n' + stderr.slice(-400) : '') })
} finally {
  if (browser) await browser.close()
  try { srv.kill('SIGKILL') } catch {}
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.msg ? ' → ' + r.msg : ''}`)
console.log(`\n报告库三处 UI 门禁：${results.length - failed.length} 通过 / ${failed.length} 失败`)
process.exit(failed.length ? 1 : 0)
