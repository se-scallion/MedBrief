// 报告内容抽屉 ≤575px 指标行样式断言（2026-11-16 用户实测：4 列固定宽 Table 在 375 下
// 把「项目」列压成竖排单字、并与「数值」重叠）。
// 真浏览器、只读、不写库；服务未起时 SKIP 并退出 0。
import { chromium } from 'playwright'

const BASE = process.env.MEDBRIEF_BASE || 'http://127.0.0.1:5174'
let pass = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }

let ready = false
try { ready = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })).ok } catch {}
if (!ready) { console.log('SKIP 报告抽屉 375 断言：5174 未就绪'); process.exit(0) }

const browser = await chromium.launch({ headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 375, height: 900 } })
  await p.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1500)
  // 按用户截图那份（23 行血常规）搜索；找不到就取第一份有指标行的报告
  const search = p.locator('input[placeholder*="搜医院"]').first()
  if (await search.count()) { await search.fill('rep_mwil5zi7ub9'); await p.waitForTimeout(900) }
  const viewBtn = p.getByRole('button', { name: '查看', exact: true }).first()
  if (!(await viewBtn.count())) { console.log('SKIP 报告抽屉 375 断言：库里没有可查看的报告'); process.exit(0) }
  await viewBtn.click({ timeout: 8000 })
  await p.waitForTimeout(1600)
  const rowsTab = p.getByRole('tab', { name: /指标（/ }).first()
  if (await rowsTab.count()) await rowsTab.click({ timeout: 5000 }).catch(() => {})
  await p.waitForTimeout(600)

  const m = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.rb-row-card')]
    const names = cards.map((c) => c.querySelector('.rb-row-name'))
    const vals = cards.map((c) => c.querySelector('.rb-row-value'))
    const descs = document.querySelectorAll('.rb-detail .ant-descriptions-row')
    return {
      de: document.documentElement.scrollWidth,
      cards: cards.length,
      tables: document.querySelectorAll('.ant-drawer .ant-table').length,
      // 竖排单字的特征：名称框高度 > 2.2 行高（约 42px），或宽度 < 2 个汉字（约 26px）
      tallNames: names.filter((n) => n && n.getBoundingClientRect().height > 42).length,
      narrowNames: names.filter((n) => n && n.getBoundingClientRect().width < 26).length,
      // 值列不许换行（white-space: nowrap）
      wrappedValues: vals.filter((v) => v && getComputedStyle(v).whiteSpace !== 'nowrap').length,
      overflowCards: cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
      descRows: descs.length,
      // antd bordered 单元格自带上下内边距（实测 h=39），不能拿高度当「折行」判据；
      // 真正判据是 white-space 是否 nowrap + 内容是否被浏览器折成两行（scrollWidth > clientWidth）。
      descLabelWrapped: [...document.querySelectorAll('.rb-detail .ant-descriptions-item-label')]
        .filter((l) => getComputedStyle(l).whiteSpace !== 'nowrap' || l.scrollWidth > l.clientWidth + 1).length,
    }
  })
  if (m.cards === 0) { console.log('SKIP 报告抽屉 375 断言：该报告 0 指标行'); process.exit(0) }
  if (m.de === 375) ok('375 页面无横向溢出（de=375）')
  else throw new Error(`de=${m.de}`)
  if (m.cards > 0 && m.tables === 0) ok(`窄屏用行块卡片而非 Table（${m.cards} 张卡片 / 0 表格）`)
  else throw new Error(`cards=${m.cards} tables=${m.tables}`)
  if (m.tallNames === 0 && m.narrowNames === 0) ok('项目名不再竖排单字（高度 ≤42px、宽度 ≥26px）')
  else throw new Error(`tall=${m.tallNames} narrow=${m.narrowNames}`)
  if (m.wrappedValues === 0) ok('数值列 nowrap，不与项目名重叠')
  else throw new Error(`wrappedValues=${m.wrappedValues}`)
  if (m.overflowCards === 0) ok('行块卡片零横溢')
  else throw new Error(`overflow=${m.overflowCards}`)
  if (m.descRows > 0 && m.descLabelWrapped === 0) ok(`Descriptions 窄屏一列且标签不折行（${m.descRows} 行）`)
  else throw new Error(`descRows=${m.descRows} labelWrapped=${m.descLabelWrapped}`)

  // 桌面 ≥992 仍走原 Table（不能因为修手机把桌面改没了）
  const d = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await d.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await d.waitForTimeout(1400)
  const s2 = d.locator('input[placeholder*="搜医院"]').first()
  if (await s2.count()) { await s2.fill('rep_mwil5zi7ub9'); await d.waitForTimeout(800) }
  const vb2 = d.getByRole('button', { name: '查看', exact: true }).first()
  if (await vb2.count()) {
    await vb2.click({ timeout: 8000 })
    await d.waitForTimeout(1400)
    const n = await d.evaluate(() => ({
      cards: document.querySelectorAll('.rb-row-card').length,
      tables: document.querySelectorAll('.ant-drawer .ant-table').length,
    }))
    if (n.tables === 1 && n.cards === 0) ok('1440 桌面仍是原 Table（行块样式不污染桌面）')
    else throw new Error(`桌面 cards=${n.cards} tables=${n.tables}`)
  } else console.log('SKIP 桌面断言：搜索后无「查看」按钮')
} finally {
  await browser.close()
}
console.log(`\n报告抽屉 375 样式：${pass} 通过 / 0 失败`)
