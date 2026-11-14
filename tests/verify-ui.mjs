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

    // 5.0 W3b 补丁硬断言（2026-11-14）：顶栏瘦身，防「横向溢出换成纵向吞噬」。
    // 判据：header 高度 ≤80 与 scrollWidth ≤375 必须同时成立，且不得靠 flex-wrap:wrap 换行达标。
    try {
      await mobile.screenshot({ path: '/tmp/w3b-header-375.png', fullPage: false })
      await mobile.screenshot({ path: '/tmp/w3b-mobile.png', fullPage: false })
      console.log('       截图 /tmp/w3b-header-375.png、/tmp/w3b-mobile.png（首屏：正常高度 header + Tab 栏 + 内容）')
      const slim = await mobile.evaluate(() => {
        const h = document.querySelector('.ant-layout-header')
        if (!h) return { missing: true }
        const left = h.querySelector('.mb-header-left')
        const c = getComputedStyle(h)
        // W10 插入汉堡按钮后下标整体后移，不能再用固定 children[1]/[2]（曾误把 MedBrief 当 Tag 判绿）。
        // 按文本找元素 + 量 display/宽，才不会被 DOM 顺序骗过。
        const byText = (kw) => [...left.children].find((x) => (x.textContent || '').includes(kw))
        const disp = (el) => el ? getComputedStyle(el).display : 'missing'
        const brand = byText('MedBrief'), tag = byText('北京朝阳医院'), sub = byText('挂号与问诊资料整理工作台')
        return {
          headerH: Math.round(h.getBoundingClientRect().height),
          de: document.documentElement.scrollWidth,
          flexWrap: c.flexWrap,
          brandDisplay: disp(brand), brandW: brand ? Math.round(brand.getBoundingClientRect().width) : 0,
          tagDisplay: disp(tag), subtitleDisplay: disp(sub),
        }
      })
      if (!slim.missing && slim.headerH <= 80 && slim.de <= 375) pass(`375×812 顶栏瘦身：header 高 ${slim.headerH}px ≤80 且 scrollWidth=${slim.de} ≤375（两者同时成立）`)
      else fail(`375×812 顶栏瘦身未达标：${JSON.stringify(slim)}`)
      if (!slim.missing && slim.flexWrap === 'nowrap') pass('375×812 顶栏保持 flex-wrap:nowrap（未用换行换宽度）')
      else fail(`375×812 顶栏仍是 wrap：${JSON.stringify(slim)}`)
      if (!slim.missing && slim.tagDisplay === 'none' && slim.subtitleDisplay === 'none') pass('375×812 院区 Tag / 副标题已隐藏（按文本定位，不受汉堡按钮下标偏移影响）')
      else fail(`375×812 院区 Tag / 副标题未隐藏：${JSON.stringify(slim)}`)
      // W10 更正 1：首屏内容起点 ≤96px（防「顶栏压到 79 却把内容往下挤」）。
      // 用 content.top + scrollY 取文档坐标，滚动到中部也照样能判。
      const contentTop = await mobile.evaluate(() => Math.round(document.querySelector('.ant-layout-content').getBoundingClientRect().top + window.scrollY))
      if (contentTop <= 96) pass(`375×812 首屏内容起点 y=${contentTop}px ≤96（顶栏未把内容往下挤）`)
      else fail(`375×812 首屏内容起点 y=${contentTop}px >96（首屏被吃掉）`)
      if (!slim.missing && slim.brandDisplay !== 'none' && slim.brandW > 0) pass(`375×812「MedBrief」标题仍可见（宽 ${slim.brandW}px，未被汉堡按钮下标偏移误隐藏）`)
      else fail(`375×812「MedBrief」标题被误隐藏：${JSON.stringify(slim)}`)

      // 反例自证伪：临时把 header 覆盖回 5d907aa 的 wrap + 显示长文本，判据必须判红；随后移除注入，确认上下文恢复。
      await mobile.evaluate(() => {
        const s = document.createElement('style')
        s.id = 'w3b-assert-falsify'
        s.textContent = `@media (max-width: 575px) {
          .ant-layout-header { flex-wrap: wrap !important; padding-block: 8px !important; }
          .mb-header-left > .ant-space-item:nth-child(2),
          .mb-header-left > .ant-space-item:nth-child(3) { display: block !important; }
        }`
        document.head.appendChild(s)
      })
      await mobile.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const falsified = await mobile.evaluate(() => {
        const h = document.querySelector('.ant-layout-header')
        return { headerH: Math.round(h.getBoundingClientRect().height), flexWrap: getComputedStyle(h).flexWrap }
      })
      if (falsified.headerH > 80) pass(`反例自证伪：还原 5d907aa 的 wrap 后 header 高 ${falsified.headerH}px >80，高度断言会判红（非空过）`)
      else fail(`反例自证伪失败：还原 wrap 后 header 仍 ${falsified.headerH}px，高度断言可能空过`)
      await mobile.evaluate(() => { document.getElementById('w3b-assert-falsify')?.remove() })
      await mobile.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const restored = await mobile.evaluate(() => Math.round(document.querySelector('.ant-layout-header').getBoundingClientRect().height))
      if (restored <= 80) pass(`反例注入移除后恢复 header 高 ${restored}px ≤80（不污染后续断言）`)
      else fail(`反例注入移除后 header 仍 ${restored}px，后续断言上下文被污染`)

      // 414×896 也 ≤80（plan 里 W3c 的加严项，正式卡未要求，一并满足）
      const wide = await browser.newPage({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 1 })
      try {
        await wide.goto(BASE + '/?tab=card', { waitUntil: 'domcontentloaded', timeout: 20000 })
        await wide.locator('.ant-tabs-tab').first().waitFor({ timeout: 15000 })
        await wide.waitForTimeout(1200)
        const w = await wide.evaluate(() => {
          const h = document.querySelector('.ant-layout-header')
          return { headerH: Math.round(h.getBoundingClientRect().height), de: document.documentElement.scrollWidth }
        })
        if (w.headerH <= 80 && w.de <= 414) pass(`414×896 顶栏高 ${w.headerH}px ≤80 且 scrollWidth=${w.de} ≤414`)
        else fail(`414×896 顶栏未达标：${JSON.stringify(w)}`)
      } catch (e) {
        fail(`414×896 顶栏断言异常：${e.message}`)
      }
      await wide.close()
    } catch (e) {
      fail(`375×812 顶栏瘦身断言异常：${e.message}`)
    }

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
      const midHeader = await mobile.evaluate(() => {
        const h = document.querySelector('.ant-layout-header')
        return { headerH: Math.round(h.getBoundingClientRect().height), headerTop: Math.round(h.getBoundingClientRect().top) }
      })
      if (midHeader.headerH <= 80) pass(`375×812 滚到中部时 header 仍 ${midHeader.headerH}px ≤80（top=${midHeader.headerTop}，已滚出视口、不遮挡 Tab）`)
      else fail(`375×812 滚到中部时 header 又变高：${JSON.stringify(midHeader)}`)
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

// 7. W10（2026-11-14）：手机端隐藏 Sider + 顶部菜单入口（用户批准方案②）。
// 判据全部量真实 DOM / 真点击 / 真 URL，不用「元素存在」代替「可见可点」；反例自证伪必须判红。
try {
  const w10 = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 })
  const w10Errors = []
  w10.on('pageerror', (e) => w10Errors.push(String(e)))
  const PAGES_7 = [
    ['intake', '资料录入'], ['reports', '报告库'], ['card', '资料卡'], ['brief', '病历交换包'],
    ['monitor', '出诊监控'], ['booking', '挂号与预约'], ['session', '114 会话'],
  ]
  try {
    await w10.goto(BASE + '/?tab=card', { waitUntil: 'domcontentloaded', timeout: 20000 })
    await w10.locator('.ant-layout-header').waitFor({ timeout: 15000 })
    await w10.waitForTimeout(1800)

    // 7.1 Sider 不可见 + 菜单入口可见可点
    const closed = await w10.evaluate(() => {
      const s = document.querySelector('.ant-layout-sider')
      const btn = document.querySelector('.mb-nav-trigger')
      const h = document.querySelector('.ant-layout-header')
      return {
        siderDisplay: getComputedStyle(s).display,
        siderW: Math.round(s.getBoundingClientRect().width),
        siderOffsetNull: s.offsetParent === null,
        btnDisplay: btn ? getComputedStyle(btn).display : 'missing',
        btnVisible: btn ? btn.getBoundingClientRect().width > 0 : false,
        headerH: Math.round(h.getBoundingClientRect().height),
        contentW: Math.round(document.querySelector('.ant-layout-content').getBoundingClientRect().width),
        de: document.documentElement.scrollWidth,
      }
    })
    const siderHidden = closed.siderDisplay === 'none' || closed.siderW === 0 || closed.siderOffsetNull
    if (siderHidden) pass(`375 Sider 已隐藏（display=${closed.siderDisplay}, 宽=${closed.siderW}, 正文=${closed.contentW}px）`)
    else fail(`375 Sider 未隐藏：${JSON.stringify(closed)}`)
    if (closed.btnDisplay !== 'none' && closed.btnVisible) pass(`375 顶部菜单入口可见（display=${closed.btnDisplay}）`)
    else fail(`375 顶部菜单入口不可见：${JSON.stringify(closed)}`)
    await w10.screenshot({ path: '/tmp/w10-nav-closed-375.png', fullPage: false })
    console.log('       截图 /tmp/w10-nav-closed-375.png')

    // 7.2 点菜单入口 → 菜单项可见 → 点「资料卡」→ 真切页（先停在别的页，再切回来）
    await w10.goto(BASE + '/?tab=intake', { waitUntil: 'domcontentloaded' })
    await w10.waitForTimeout(1400)
    await w10.locator('.mb-nav-trigger').click({ timeout: 8000 })
    await w10.waitForTimeout(500)
    const opened = await w10.evaluate(() => {
      const drawer = document.querySelector('.ant-drawer')
      const titles = [...document.querySelectorAll('.ant-drawer .ant-menu-item-group-title')].map((x) => x.textContent.trim())
      const items = [...document.querySelectorAll('.ant-drawer .ant-menu-item')].map((x) => x.textContent.trim())
      return { drawerVisible: !!drawer && getComputedStyle(drawer).display !== 'none', groupCount: titles.length, groups: titles, itemCount: items.length, items }
    })
    if (opened.drawerVisible && opened.groupCount === 2 && opened.itemCount === 7 && opened.groups.join('/') === '资料/出诊') pass(`375 菜单展开：两组（${opened.groups.join('/')}）+ 7 项齐全`)
    else fail(`375 菜单展开缺件：${JSON.stringify(opened)}`)
    await w10.screenshot({ path: '/tmp/w10-nav-open-375.png', fullPage: false })
    console.log('       截图 /tmp/w10-nav-open-375.png')
    await w10.locator('.ant-drawer .ant-menu-item').filter({ hasText: '资料卡' }).first().click({ timeout: 8000 })
    await w10.waitForTimeout(1500)
    const switched = await w10.evaluate(() => ({
      url: window.location.href,
      tabs: [...document.querySelectorAll('.ant-tabs-tab')].map((x) => x.textContent.trim()),
      drawerOpen: !!document.querySelector('.ant-drawer-open'),
      de: document.documentElement.scrollWidth,
    }))
    const reallySwitched = /[?&]tab=card/.test(switched.url) && switched.tabs.some((t) => /临床指标总览/.test(t)) && !switched.drawerOpen
    if (reallySwitched) pass(`375 点菜单「资料卡」真切页（URL tab=card、内容出现三视图、菜单自动关闭）`)
    else fail(`375 点菜单未真切页：${JSON.stringify(switched)}`)

    // 7.3 375 硬约束：header ≤80 且 de ≤375（W3b/W3c 断言不许放宽）
    const hard = await w10.evaluate(() => ({ headerH: Math.round(document.querySelector('.ant-layout-header').getBoundingClientRect().height), de: document.documentElement.scrollWidth }))
    if (hard.headerH <= 80 && hard.de <= 375) pass(`375 硬约束：header ${hard.headerH}px ≤80 且 scrollWidth=${hard.de} ≤375（两者同时）`)
    else fail(`375 硬约束未达标：${JSON.stringify(hard)}`)

    // 7.4 更正 2：7 页逐页记录改前/改后 scrollWidth，要求「改后 ≤ 改前」（不许因导航改造变差）。
    // 改前基线是本卡动手前实测（仅资料卡 375，其余 415/435，属各页自身宽表，不算在 App.jsx 头上）。
    // 资料卡仍必须 ≤375（现有断言不动）。
    const BEFORE_W10 = { intake: 415, reports: 415, card: 375, brief: 435, monitor: 415, booking: 415, session: 415 }
    const seven = []
    for (const [key, label] of PAGES_7) {
      await w10.goto(`${BASE}/?tab=${key}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await w10.waitForTimeout(1300)
      const g = await w10.evaluate(() => {
        const h = document.querySelector('.ant-layout-header')
        return {
          de: document.documentElement.scrollWidth, headerScrollW: h.scrollWidth,
          headerH: Math.round(h.getBoundingClientRect().height),
          siderDisplay: getComputedStyle(document.querySelector('.ant-layout-sider')).display,
        }
      })
      seven.push({ label, key, before: BEFORE_W10[key], ...g })
    }
    const worse = seven.filter((x) => x.de > x.before || x.headerH > 80 || x.siderDisplay !== 'none')
    const cardWorse = seven.find((x) => x.key === 'card' && x.de > 375)
    console.log(`       7 页改前/改后：${seven.map((x) => `${x.label} ${x.before}→${x.de}（header.scrollW=${x.headerScrollW}）`).join(' / ')}`)
    if (worse.length === 0 && !cardWorse) pass(`375 七页改后均 ≤ 改前（资料卡 ${seven.find(x=>x.key==='card').de} ≤375），顶栏全局收敛，无页面变差`)
    else fail(`375 七页有变差/未达标：${JSON.stringify(worse.concat(cardWorse ? [seven.find(x=>x.key==='card')] : []))}`)
    if (seven.every((x) => x.headerScrollW <= 375)) pass(`375 六页顶栏额外收益：header.scrollWidth 全部 ≤375（${seven.map(x=>x.label+'='+x.headerScrollW).join('/')}）`)
    else fail(`375 顶栏仍有页面自身超宽：${JSON.stringify(seven.filter(x=>x.headerScrollW>375))}`)

    // 7.5 反例自证伪：临时撤销 Sider 隐藏 → 判据必须判红；移除后恢复
    await w10.evaluate(() => {
      const s = document.createElement('style')
      s.id = 'w10-assert-falsify'
      s.textContent = '@media (max-width: 575px) { .ant-layout-sider { display: block !important; width: 56px !important; } }'
      document.head.appendChild(s)
    })
    await w10.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const falsified = await w10.evaluate(() => {
      const s = document.querySelector('.ant-layout-sider')
      return { display: getComputedStyle(s).display, w: Math.round(s.getBoundingClientRect().width), offsetNull: s.offsetParent === null }
    })
    const wouldFail = !(falsified.display === 'none' || falsified.w === 0 || falsified.offsetNull)
    if (wouldFail) pass(`W10 反例自证伪：撤销隐藏后 Sider ${falsified.display}/${falsified.w}px 可见，「Sider 不可见」断言会判红（非空过）`)
    else fail(`W10 反例自证伪失败：撤销隐藏后 Sider 仍判隐藏 ${JSON.stringify(falsified)}`)
    await w10.evaluate(() => { document.getElementById('w10-assert-falsify')?.remove() })
    await w10.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const restored = await w10.evaluate(() => getComputedStyle(document.querySelector('.ant-layout-sider')).display)
    if (restored === 'none') pass('W10 反例注入移除后 Sider 恢复 none（不污染后续断言）')
    else fail(`W10 反例注入移除后 Sider 仍 ${restored}`)

    if (w10Errors.length) fail(`W10 375 期间前端报错：${w10Errors.slice(0, 2).join(' | ')}`)
    await w10.close()
  } catch (e) {
    fail(`W10 375 断言异常：${e.message}`)
    await w10.close().catch(() => {})
  }

  // 7.6 992 / 1440：Sider 常驻、菜单结构不变、de 不变、手机菜单入口隐藏
  for (const vw of [992, 1440]) {
    const d = await browser.newPage({ viewport: { width: vw, height: 950 }, deviceScaleFactor: 1 })
    try {
      await d.goto(BASE + '/?tab=card', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await d.locator('.ant-layout-sider').first().waitFor({ timeout: 15000 })
      await d.waitForTimeout(1800)
      const g = await d.evaluate(() => {
        const s = document.querySelector('.ant-layout-sider')
        const groups = [...s.querySelectorAll('.ant-menu-item-group-title')].map((x) => x.textContent.trim())
        const items = [...s.querySelectorAll('.ant-menu-item')].map((x) => x.textContent.trim())
        return {
          de: document.documentElement.scrollWidth,
          siderDisplay: getComputedStyle(s).display, siderW: Math.round(s.getBoundingClientRect().width),
          headerH: Math.round(document.querySelector('.ant-layout-header').getBoundingClientRect().height),
          groups, itemCount: items.length,
          navBtnDisplay: getComputedStyle(document.querySelector('.mb-nav-trigger')).display,
          mediaMatches: window.matchMedia('(max-width: 575px)').matches,
        }
      })
      const ok = g.de === vw && g.siderDisplay === 'block' && g.siderW === 168 && g.headerH === 64
        && g.groups.join('/') === '资料/出诊' && g.itemCount === 7 && g.navBtnDisplay === 'none' && !g.mediaMatches
      if (ok) pass(`${vw} 桌面零影响：de=${g.de}、Sider ${g.siderW}px 可见、header ${g.headerH}px、菜单两组 7 项、手机入口 hidden`)
      else fail(`${vw} 桌面被改动：${JSON.stringify(g)}`)
      if (vw === 1440) {
        await d.screenshot({ path: '/tmp/w10-nav-1440.png', fullPage: false })
        console.log('       截图 /tmp/w10-nav-1440.png')
      }
    } catch (e) {
      fail(`${vw} 桌面断言异常：${e.message}`)
    }
    await d.close()
  }
} catch (e) {
  fail(`W10 冒烟无法启动：${e.message}`)
}

// 6. 无 console / page error
const realErrors = consoleErrors.filter((t) => !/favicon|Failed to load resource: the server responded with a status of 404/i.test(t))
if (realErrors.length === 0) pass('无 console / page error')
else fail(`存在前端报错：${realErrors.slice(0, 3).join(' | ')}`)

await browser.close()

console.log('\n' + '='.repeat(50))
console.log(failed === 0 ? 'UI 冒烟：全部通过' : `UI 冒烟：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
