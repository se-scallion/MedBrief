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
  { label: '报告库', probe: /报告库|报告|原件/ },
  { label: '资料卡', probe: /资料卡|打印|一页/ },
  { label: '病历交换包', probe: /近期指标|速览|病历/ },
  { label: '出诊监控', probe: /出诊中|停诊|两周总排班/ },
  { label: '挂号与预约', probe: /就诊人|医院|发起挂号/ },
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

// 3.5 资料卡工作台（v3.5 交互化）：无长 iframe、三大弹窗、快捷键拦截
try {
  await page.getByText('资料卡', { exact: true }).first().click()
  await page.waitForTimeout(1800)
  const iframes = await page.locator('iframe').count()
  if (iframes === 0) pass('工作台主视图不含长 iframe（打印件改为按需弹窗）')
  else fail(`工作台主视图仍有 ${iframes} 个 iframe（应改为打印弹窗内按需渲染）`)

  const tabs = await page.locator('.ant-tabs-tab').allInnerTexts()
  if (tabs.length >= 3) pass(`工作台三视图齐全：${tabs.map((t) => t.replace(/（.*?）/, '')).join(' / ')}`)
  else fail(`工作台视图数不足：${tabs.join(',')}`)

  // 点核心异常项第一行 → 原件溯源弹窗
  await page.locator('.ant-table-tbody tr').first().click()
  await page.waitForTimeout(1200)
  const srcTitle = await page.locator('.ant-modal-title').last().innerText()
  if (/原件溯源/.test(srcTitle)) pass(`点指标行打开溯源弹窗：${srcTitle}`)
  else fail(`点指标行没有打开溯源弹窗（实际「${srcTitle}」）`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 档案弹窗
  await page.getByRole('button', { name: '编辑档案与三问' }).first().click()
  await page.waitForTimeout(700)
  const profTitle = await page.locator('.ant-modal-title').last().innerText()
  if (/编辑档案/.test(profTitle)) pass('「编辑档案与三问」以弹窗形式打开')
  else fail(`档案弹窗未打开（实际「${profTitle}」）`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 打印预览弹窗：弹窗内有 iframe + 立即打印按钮
  await page.getByRole('button', { name: /打印预览/ }).first().click()
  await page.waitForTimeout(1000)
  const printModal = page.locator('.ant-modal').last()
  const hasPrintIframe = await printModal.locator('iframe').count()
  const hasPrintBtn = await printModal.getByRole('button', { name: /立即打印/ }).count()
  if (hasPrintIframe === 1 && hasPrintBtn === 1) pass('打印预览弹窗：3 页 A4 iframe + 立即打印按钮')
  else fail(`打印预览弹窗缺件（iframe ${hasPrintIframe} / 打印按钮 ${hasPrintBtn}）`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 快捷键：弹窗关闭时 Ctrl+P 不得直接打印工作台，应打开打印预览
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(600)
  const afterHotkey = await page.locator('.ant-modal-title').last().innerText().catch(() => '')
  if (/打印预览/.test(afterHotkey)) pass('Ctrl+P 被拦截并转为打开打印预览（不打印工作台）')
  else fail(`Ctrl+P 未经拦截（弹窗标题「${afterHotkey}」）`)
  await page.keyboard.press('Escape')
} catch (e) {
  fail(`资料卡工作台冒烟异常：${e.message}`)
}

// 5. 移动端 375×812：三个标签页 + 打印预览弹窗都不得有横向滚动（2026-11-14 W3）
// 判据取 documentElement.scrollWidth（用户口径），不是 body.scrollWidth；
// 每个视图都截图到 /tmp/w3-<tab>.png，方便人工复核「内容可读」而不只是数字过关。
try {
  const mobile = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 })
  const mErrors = []
  mobile.on('pageerror', (e) => mErrors.push(String(e)))
  const pages = [
    { key: 'overview', label: '临床指标总览' },
    { key: 'trends', label: '动态趋势看板' },
    { key: 'timeline', label: '全病程原件轴' },
  ]
  const checkNoOverflow = async (tag) => {
    const sw = await mobile.evaluate(() => document.documentElement.scrollWidth)
    if (sw <= 375) pass(`375×812「${tag}」无横向滚动（scrollWidth=${sw}）`)
    else fail(`375×812「${tag}」横向溢出（scrollWidth=${sw} > 375）`)
    return sw
  }
  try {
    await mobile.goto(BASE + '/?tab=card', { waitUntil: 'domcontentloaded', timeout: 20000 })
    await mobile.locator('.ant-tabs-tab').first().waitFor({ timeout: 15000 })
    await mobile.waitForTimeout(1500)
    for (const t of pages) {
      await mobile.locator('.ant-tabs-tab').filter({ hasText: t.label }).first().click({ timeout: 10000 })
      await mobile.waitForTimeout(700)
      await checkNoOverflow(t.label)
      await mobile.screenshot({ path: `/tmp/w3-${t.key}.png`, fullPage: false })
      console.log(`       截图 /tmp/w3-${t.key}.png`)
    }

    // 5.1 W3b 回归（2026-11-14）：375×812 滚到页面中部，Tab 栏仍吸顶可见且可点。
    // 判据不只看 computed，还量视口内 y 坐标 + 真点击切换，防止「样式写了但被 antd 层叠压过」的空过。
    try {
      const half = await mobile.evaluate(() => Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2))
      await mobile.evaluate((y) => window.scrollTo(0, y), half)
      // 等两帧：早先实测过切 Tab 后浏览器可能尚未重算 sticky，单帧读数会假阳性。
      await mobile.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const sticky = await mobile.evaluate(() => {
        const nav = document.querySelector('.ant-tabs-nav')
        if (!nav) return { missing: true }
        const r = nav.getBoundingClientRect(), c = getComputedStyle(nav)
        return {
          scrollY: Math.round(window.scrollY),
          position: c.position, top: Math.round(r.top), bottom: Math.round(r.bottom),
          height: Math.round(r.height), de: document.documentElement.scrollWidth,
        }
      })
      const visible = !sticky.missing && sticky.scrollY > 0 && sticky.position === 'sticky'
        && sticky.top >= 0 && sticky.top <= 2 && sticky.bottom > 0 && sticky.bottom <= 812
      if (visible) pass(`375×812 滚到中部（scrollY=${sticky.scrollY}）Tab 栏吸顶可见（top=${sticky.top}, bottom=${sticky.bottom}, position=${sticky.position}）`)
      else fail(`375×812 滚到中部 Tab 栏未吸顶可见：${JSON.stringify(sticky)}`)
      if (sticky.de <= 375) pass(`375×812 吸顶后仍无横向滚动（scrollWidth=${sticky.de}）`)
      else fail(`375×812 吸顶后横向溢出（scrollWidth=${sticky.de} > 375）`)
      await mobile.screenshot({ path: '/tmp/w3b-sticky.png', fullPage: false })
      console.log('       截图 /tmp/w3b-sticky.png')
      // 可点：滚到中部直接点「动态趋势看板」，并确认激活态真的切过去了
      await mobile.locator('.ant-tabs-tab').filter({ hasText: '动态趋势看板' }).first().click({ timeout: 10000 })
      await mobile.waitForTimeout(700)
      const active = (await mobile.locator('.ant-tabs-tab-active').allInnerTexts()).join('')
      if (/动态趋势看板/.test(active)) pass(`375×812 滚到中部 Tab 栏可点（激活=${active.replace(/\s+/g, '')}）`)
      else fail(`375×812 滚到中部点击后未切到「动态趋势看板」（激活=${active}）`)
      // 恢复原上下文：打印预览弹窗仍从最后一个标签页打开（与 W3 四条断言等价）
      await mobile.locator('.ant-tabs-tab').filter({ hasText: '全病程原件轴' }).first().click({ timeout: 10000 })
      await mobile.waitForTimeout(500)
    } catch (e) {
      fail(`375×812 吸顶回归异常：${e.message}`)
    }

    // 打印预览弹窗：在最后一个标签页上打开，断言同样不溢出
    await mobile.getByRole('button', { name: /打印预览/ }).first().click()
    await mobile.waitForTimeout(1100)
    await checkNoOverflow('打印预览弹窗')
    if (mErrors.length) fail(`375 冒烟期间前端报错：${mErrors.slice(0, 2).join(' | ')}`)
    await mobile.close()
  } catch (e) {
    fail(`375×812 冒烟异常：${e.message}`)
    await mobile.close().catch(() => {})
  }
} catch (e) {
  fail(`375×812 冒烟无法启动：${e.message}`)
}

// 6. 无 console / page error
const realErrors = consoleErrors.filter((t) => !/favicon|Failed to load resource: the server responded with a status of 404/i.test(t))
if (realErrors.length === 0) pass('无 console / page error')
else fail(`存在前端报错：${realErrors.slice(0, 3).join(' | ')}`)

await browser.close()

console.log('\n' + '='.repeat(50))
console.log(failed === 0 ? 'UI 冒烟：全部通过' : `UI 冒烟：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
