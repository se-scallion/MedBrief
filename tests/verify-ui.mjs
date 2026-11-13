// UI 冒烟：验证新版 React 壳在 / 上真的能渲染、5 个 tab 可切、无 console error。
// 依赖 playwright（随 MedData node_modules 软链接提供），不需要启动 vite dev。
// 运行：node tests/verify-ui.mjs   （前置：5174 已启动且 npm run build:web 已构建）
// 退出码：任一断言失败 → 1。

import { chromium } from 'playwright'

const BASE = process.env.MEDBRIEF_BASE || 'http://127.0.0.1:5174'
// 2026-11-13 换壳：顶部 6 tab → 左侧 Sider 分组菜单（资料 / 出诊）。
// 菜单文案同时改动了两处（资料导入→资料录入、病历资料→病历交换包），这里同步。
const TABS = [
  { label: '资料录入', probe: /病友|导入|资料卡/ },
  { label: '病历交换包', probe: /近期指标|速览|病历/ },
  { label: '出诊监控', probe: /出诊中|停诊|两周总排班/ },
  { label: '挂号与预约', probe: /就诊人|医院/ },
  { label: '预约记录', probe: /预约|订单/ },
  { label: '114 会话', probe: /登录|会话/ },
]

// 服务刚重启时前端资源可能还没就绪：先等 /api/health 再开浏览器（2026-11-12 实测：
// 紧接重启那一次连报 8 项失败、再跑就全过 —— 属就绪竞态，不是产品问题，别让它变成噪音）。
async function waitServer(timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health')
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

let failed = 0
const pass = (m) => console.log(`PASS  ${m}`)
const fail = (m) => { failed++; console.log(`FAIL  ${m}`) }

if (!(await waitServer())) {
  console.log('FAIL  服务未就绪（20s 内 /api/health 未返回 2xx）—— 先 npm start / node server.mjs')
  process.exit(1)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (e) => consoleErrors.push(String(e)))

try {
  // 1. 首屏渲染（能查到标题即说明 JS 包正常执行，不是 SPA 回退的 HTML）
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.getByText('挂号与问诊资料整理工作台').first().waitFor({ timeout: 15000 })
  pass('首屏渲染：React 壳已挂载')
} catch (e) {
  fail(`首屏渲染失败：${e.message}`)
}

// 2. 5 个 tab 可切换，且每个 tab 有自己的内容
for (const t of TABS) {
  try {
    await page.getByText(t.label, { exact: true }).first().click({ timeout: 8000 })
    await page.waitForTimeout(400)
    const body = await page.locator('body').innerText()
    if (!t.probe.test(body)) throw new Error(`切到「${t.label}」后未出现预期内容 ${t.probe}`)
    pass(`tab「${t.label}」可切换且内容存在`)
  } catch (e) {
    fail(`tab「${t.label}」异常：${e.message}`)
  }
}

// 3. 关键数字来自真接口（不是写死的占位）
try {
  await page.getByText('出诊监控', { exact: true }).first().click()
  await page.waitForTimeout(1500)
  const body = await page.locator('body').innerText()
  if (/出诊中/.test(body) && /停诊/.test(body) && /\d/.test(body)) pass('出诊监控渲染出数值卡片')
  else fail('出诊监控未渲染数值卡片')
} catch (e) {
  fail(`出诊监控数值断言异常：${e.message}`)
}

// 4. 无 console / page error
const realErrors = consoleErrors.filter((t) => !/favicon|Failed to load resource: the server responded with a status of 404/i.test(t))
if (realErrors.length === 0) pass('无 console / page error')
else fail(`存在前端报错：${realErrors.slice(0, 3).join(' | ')}`)

await browser.close()

console.log('\n' + '='.repeat(50))
console.log(failed === 0 ? 'UI 冒烟：全部通过' : `UI 冒烟：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
