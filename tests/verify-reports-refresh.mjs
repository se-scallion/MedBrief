// 报告库「跨页/跨标签页新鲜度」回归（2026-11-16 用户实测：A 页导入，B 页搜索不到，要手动刷新）
//
// 根因（已修）：搜索/排序/分页全是**本地内存**（useMemo 过滤 + sortReports + Table 分页），
// 而 load() 只在挂载与切 tab 时跑 ⇒ 另一个标签页拿的是它挂载那一刻的快照。
// 修法：window focus / visibilitychange → 静默重取（quiet，不闪全表 loading），3 秒节流。
//
// 本测试证明三件事：① 不刷新页面，切回焦点后列表自动变新；② 搜索能命中新记录；
// ③ 全程只写**副本库**（真实库 sha 前后一致）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const REAL = path.join(ROOT, 'data', 'reports.json')
const realBefore = fs.readFileSync(REAL, 'utf8')
let pass = 0
let failed = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }
const fail = (n, e = '') => { failed++; console.log(`FAIL ${n}${e ? ' · ' + e : ''}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-refresh-'))
const tr = path.join(tmp, 'reports.json')
fs.copyFileSync(REAL, tr)
const PORT = 5193
const BASE = `http://127.0.0.1:${PORT}`
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), MEDBRIEF_REPORTS_FILE: tr, MEDBRIEF_DATA_DIR: tmp }, stdio: 'ignore',
})
const browser = await chromium.launch({ headless: true })
try {
  let up = false
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) { up = true; break } } catch {} await new Promise((r) => setTimeout(r, 250)) }
  assert.ok(up, '副本服务未起来')

  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const total = async () => Number((await p.locator('text=/共 \\d+ 份/').first().innerText()).match(/共 (\d+) 份/)[1])
  await p.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(4200)   // 越过 3 秒节流窗（真实使用中用户切窗口也在数秒之后）
  const before = await total()
  ok(`副本库初始清单：共 ${before} 份`)

  const marker = `REFRESH-${Date.now()}`
  const created = await (await fetch(`${BASE}/api/intake/reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: '', pdf: '', force: true, text: marker,
      rows: [{ name: '白细胞', value: '9.9', unit: '10^9/L', refRange: '3.5-9.5' }],
      meta: { reportDate: '2026-11-16', reportType: '血常规', hospital: `${marker}医院`, barcode: marker } }),
  })).json()
  assert.ok(created.ok, '副本库新增失败')

  // 关键：**不刷新页面**，只触发 focus（模拟切回另一个标签页）
  await p.evaluate(() => { window.dispatchEvent(new Event('focus')) })
  await p.waitForTimeout(2500)
  const after = await total()
  if (after === before + 1) ok(`focus 后自动变新：${before} → ${after}（无需手动刷新）`)
  else fail(`focus 后清单未变：${before} → ${after}（期望 +1）`)

  const tbodyText = await p.locator('.ant-table-tbody').innerText()
  if (tbodyText.includes(marker)) ok('新记录已出现在列表首屏（按日期降序置顶）')
  else fail('新记录未出现在列表')

  await p.locator('input[placeholder*="搜医院"]').first().fill(marker)
  await p.waitForTimeout(900)
  if ((await p.locator('.ant-table-tbody').innerText()).includes(marker)) ok('搜索能命中该记录（本地过滤基于刷新后的快照）')
  else fail('搜索未命中该记录')

  if (fs.readFileSync(REAL, 'utf8') === realBefore) ok('真实库 sha 前后一致（本测试只写副本库）')
  else fail('真实库被写入！')
} finally {
  await browser.close()
  srv.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n报告库跨页刷新：${pass} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
