// 端到端：把用户发来的那份真 PDF 真的拖进界面，看四个表单项是否自动填上、入库记录是否正确。
// 跑在**副本库**上（PORT=5175 + MEDBRIEF_REPORTS_FILE/MEDBRIEF_DATA_DIR 指向 /tmp），绝不写真实库。
// 用法：node tools/e2e-real-pdf.mjs [--shots <dir>]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PDF_NAME = 'V020089_刘梦圆_新疆_新疆军区总医院_血液科_血液_MaYo骨髓染色体核型分_2026072318053636.pdf'
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : ''
const PORT = 5175
const BASE = `http://127.0.0.1:${PORT}`

function findPdf() {
  if (process.env.MEDBRIEF_REAL_PDF) return process.env.MEDBRIEF_REAL_PDF
  const root = path.join(os.homedir(), 'Documents/projects/ds-bot/home/attachments/v1/files')
  const walk = (dir, d = 0) => {
    if (d > 4 || !fs.existsSync(dir)) return ''
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { const r = walk(p, d + 1); if (r) return r } else if (e.name === PDF_NAME) return p
    }
    return ''
  }
  return walk(root)
}

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`PASS ${n}${extra ? ' · ' + extra : ''}`)) : (fail++, console.log(`FAIL ${n}${extra ? ' · ' + extra : ''}`)) }

const pdf = findPdf()
if (!pdf) { console.log(`SKIP 找不到真 PDF（${PDF_NAME}）`); process.exit(0) }

// ---- 副本库：reports.json 复制一份，data 目录另开（blobs 写到 /tmp，不碰真实 sqlite）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medbrief-e2e-'))
const tmpData = path.join(tmp, 'data')
fs.mkdirSync(tmpData, { recursive: true })
const tmpReports = path.join(tmp, 'reports.json')
fs.copyFileSync(path.join(ROOT, 'data/reports.json'), tmpReports)

const srv = spawn('node', ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), MEDBRIEF_REPORTS_FILE: tmpReports, MEDBRIEF_DATA_DIR: tmpData },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let srvLog = ''
srv.stdout.on('data', (d) => { srvLog += d })
srv.stderr.on('data', (d) => { srvLog += d })

const waitServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

let browser
try {
  if (!(await waitServer())) throw new Error(`副本服务未就绪\n${srvLog.slice(-800)}`)
  const h = await (await fetch(`${BASE}/api/health`)).json()
  console.log(`副本服务就绪 port=${PORT} reportsFile=副本(${JSON.parse(fs.readFileSync(tmpReports, 'utf8')).reports.length} 份) head=${h.head}`)

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errs = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  page.on('pageerror', (e) => errs.push(String(e)))

  console.log('[e2e] 打开界面')
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.getByText('资料录入', { exact: true }).first().click({ timeout: 15000 })
  await page.waitForTimeout(500)

  // 上传这份 PDF（真文件，走 PDF 文字层链路）
  console.log('[e2e] 上传真 PDF')
  await page.setInputFiles('input[type=file]', pdf, { timeout: 10000 })
  await page.waitForTimeout(800)
  // 走用户实际会点的入口：一键识别全部（一张时等价于单张「识别」）
  const oneClick = page.getByRole('button', { name: /一键识别全部/ }).first()
  ok('界面：有「一键识别全部」按钮', (await oneClick.count()) > 0)
  await oneClick.click({ timeout: 10000 })
  console.log('[e2e] 已点一键识别全部')
  // 等表单项被填上（最多 30s）
  const typeInput = page.locator('input[placeholder="如 染色体核型 / 血常规"]').first()
  let filled = false
  for (let i = 0; i < 40; i++) {
    // 每次都给短超时：不给的话 inputValue() 会用默认 30s 等元素，60 轮能挂半小时
    const v = await typeInput.inputValue({ timeout: 800 }).catch(() => '')
    if (v) { filled = true; break }
    await page.waitForTimeout(500)
  }
  console.log(`[e2e] 等待表单自动填 · ${filled ? '已填' : '超时'}`)
  ok('界面：报告类型被自动填上', filled, filled ? '' : '30s 内输入框仍为空')

  const bodyText = await page.locator('body').innerText()
  const val = async (sel) => await page.locator(sel).first().inputValue({ timeout: 1500 }).catch(() => '')
  const typeVal = await val('input[placeholder="如 染色体核型 / 血常规"]')
  const dateVal = await val('input[placeholder="2026-11-01"]')
  const hospVal = await val('input[placeholder="如：某某医院"]')
  ok('界面：报告类型 = 染色体核型', typeVal === '染色体核型', `值「${typeVal}」`)
  ok('界面：报告日期 = 2026-07-17（取报告口径，不是采集 07-15）', dateVal === '2026-07-17', `值「${dateVal}」`)
  ok('界面：医院 = 新疆军区总医院（就诊医院，不是抬头实验室）', hospVal === '新疆军区总医院', `值「${hospVal}」`)
  const autoTags = await page.locator('.ant-tag', { hasText: '自动识别' }).count()
  ok('界面：报告类型旁打了「自动识别」标', autoTags > 0, `${autoTags} 个`)
  ok('界面：条码可见', /条码\s*V\d{8,}/.test(bodyText))
  ok('界面：识别后校对区自动展开（不是折叠着让人以为没填）', await page.locator('input[placeholder="如 染色体核型 / 血常规"]').first().isVisible({ timeout: 2000 }).catch(() => false))
  ok('界面：大类 = 病理 / 骨穿', /病理 \/ 骨穿/.test(bodyText))

  if (shotsDir) {
    fs.mkdirSync(shotsDir, { recursive: true })
    // 截到「填好的表单项」本身：先把校对区滚进视野，再截图（否则只拍到上面的 ① 批量导入）
    // 滚到表单项本身再截（页面用 window 滚动；实测该输入框在 y≈1225，不滚就截不到）
    // 表单项在页面最底部（实测 1440 下 y≈1225，滚到底才看得见）；scrollIntoView 在这套布局里不生效，
    // 实测 window.scrollTo 才动（直接用 document.documentElement.scrollHeight）
    // 表单项在页面最底部。实测：window.scrollTo / scrollIntoView 在这套布局里都可能被吞掉，
    // 只有鼠标滚轮事件稳定生效 —— 滚 4 次到底再截。
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(120) }
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(shotsDir, 'e2e-1-1440-识别后表单.png'), fullPage: false })
    await page.setViewportSize({ width: 375, height: 900 })
    await page.waitForTimeout(400)
    // 表单项在页面最底部（实测 1440 下 y≈1225，滚到底才看得见）；scrollIntoView 在这套布局里不生效，
    // 实测 window.scrollTo 才动（直接用 document.documentElement.scrollHeight）
    // 表单项在页面最底部。实测：window.scrollTo / scrollIntoView 在这套布局里都可能被吞掉，
    // 只有鼠标滚轮事件稳定生效 —— 滚 4 次到底再截。
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(120) }
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(shotsDir, 'e2e-2-375-识别后表单.png'), fullPage: false })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.waitForTimeout(400)
  }

  // ---- 入库：走界面按钮，落到副本库
  const saveBtn = page.getByRole('button', { name: '入库这份报告' }).first()
  await saveBtn.click({ timeout: 10000 })
  await page.waitForTimeout(1500)

  const list = await (await fetch(`${BASE}/api/intake/reports`)).json()
  // 取**本次新入库**的那条：按 createdAt 最新
  const byNewest = [...(list.reports || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const saved = byNewest[0]
  console.log('[e2e] 最新记录：', JSON.stringify({ id: saved?.id, createdAt: saved?.createdAt, date: saved?.reportDate, type: saved?.reportType, kind: saved?.kind, hosp: saved?.hospital, src: saved?.source }))
  ok('入库：副本库多了一条 2026-07-17 的报告', !!saved, saved ? `id=${saved.id}` : '未找到')
  if (saved) {
    ok('入库：reportType 存的是「染色体核型」', saved.reportType === '染色体核型', `存「${saved.reportType}」`)
    ok('入库：hospital 存的是「新疆军区总医院」', saved.hospital === '新疆军区总医院', `存「${saved.hospital}」`)
    ok('入库：reportDate 存的是 2026-07-17', saved.reportDate === '2026-07-17', `存「${saved.reportDate}」`)
    ok('入库：kind = pathology', saved.kind === 'pathology', `存「${saved.kind}」`)
    ok('入库：条码一致', saved.barcode === 'V02008911352', `存「${saved.barcode}」`)
    ok('入库：PDF 原件也落了库（不是 text-only，能回看）', saved.source === 'pdf' && (saved.sourceBlobs || []).length > 0,
      `source=${saved.source} / blobs=${(saved.sourceBlobs || []).length}`)
  }
  ok('界面：全过程无 console 报错', errs.length === 0, errs.slice(0, 2).join(' | '))
} catch (e) {
  fail += 1
  console.log(`FAIL 端到端异常：${e.message}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  srv.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
