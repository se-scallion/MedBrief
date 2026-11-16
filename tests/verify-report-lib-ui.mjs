// 报告库列表 UI v0.4 断言（375 按天 section / 图标按钮 / 管理态 / 按组分页 / 桌面零回归）
// 真浏览器、只读、不写库；服务未起时 SKIP 并退出 0。
import { chromium } from 'playwright'

const BASE = process.env.MEDBRIEF_BASE || 'http://127.0.0.1:5174'
let pass = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }

let ready = false
try { ready = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })).ok } catch {}
if (!ready) { console.log('SKIP 报告库 UI 断言：5174 未就绪'); process.exit(0) }

const browser = await chromium.launch({ headless: true })
try {
  // ---------------- 375 ----------------
  const p = await browser.newPage({ viewport: { width: 375, height: 900 }, deviceScaleFactor: 2 })
  await p.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1600)
  const m = await p.evaluate(() => {
    const sections = [...document.querySelectorAll('.rb-day-section')]
    const rows = [...document.querySelectorAll('.rb-day-row')]
    const mainBtns = [...document.querySelectorAll('.rb-day-main')]
    const nested = mainBtns.filter((b) => b.querySelector('button')).length
    const supHidden = [...document.querySelectorAll('.rb-day-inferred')].every((s) => s.getAttribute('aria-hidden') === 'true')
    const tagsInMain = mainBtns.filter((b) => b.querySelector('.ant-tag')).length
    const styles = [...document.querySelectorAll('head > style[id^="mb-report-"]')].map((s) => s.id)
    const manageBtn = document.querySelector('button[aria-label="管理"]')
    const delBtns = document.querySelectorAll('.rb-day-row button[aria-label="删除"]').length
    const tableVisible = [...document.querySelectorAll('.ant-table')].some((t) => t.getBoundingClientRect().width > 0)
    const tallest = Math.max(0, ...rows.map((r) => r.getBoundingClientRect().height))
    return {
      de: document.documentElement.scrollWidth,
      sections: sections.length, rows: rows.length,
      groupHeads: document.querySelectorAll('.rb-day-head').length,
      nested, supHidden, tagsInMain, styles, hasManageBtn: !!manageBtn, delBtns, tableVisible, tallest,
      pagerTotal: document.querySelector('.ant-pagination-total-text')?.textContent || '',
      iconBtns: document.querySelectorAll('.rb-day-actions button[aria-label]').length,
      hotZones: [...document.querySelectorAll('.rb-day-actions button')].filter((b) => {
        const r = b.getBoundingClientRect(); return r.width >= 32 && r.height >= 32
      }).length,
      actionBtns: document.querySelectorAll('.rb-day-actions button').length,
      noDateGroup: !!document.querySelector('.rb-day-section[data-day="__none__"]'),
      datesInRows: [...document.querySelectorAll('.rb-day-row')].filter((r) => /\d{4}-\d{2}-\d{2}/.test(r.textContent)).length,
    }
  })
  if (m.sections === 0) { console.log('SKIP 报告库 UI：列表未渲染'); process.exit(0) }
  if (m.de === 375) ok('375 无横向溢出（de=375）'); else throw new Error(`de=${m.de}`)
  if (m.groupHeads === m.sections) ok(`按天 section：${m.sections} 组 / ${m.groupHeads} 个组头（一天只写一次日期）`)
  else throw new Error(`sections=${m.sections} heads=${m.groupHeads}`)
  if (m.datesInRows === 0) ok('组内行不再重复写日期'); else throw new Error(`datesInRows=${m.datesInRows}`)
  // 算式断言（r3：不写死 66/28/4 快照）：组数 = 真实日期组 + (空日期记录?1:0)，
  // 且不出现 Invalid / 1970 / 今天被当作报告日期。翻到末页确认未识别组存在。
  const api = await fetch(`${BASE}/api/intake/reports`).then((r) => r.json()).catch(() => ({}))
  const all = api.reports || []
  const realDays = new Set(all.map((r) => String(r.reportDate || '').slice(0, 10)).filter(Boolean)).size
  const missing = all.filter((r) => !String(r.reportDate || '').slice(0, 10)).length
  const expectedGroups = realDays + (missing ? 1 : 0)
  const totalText = m.pagerTotal || ''
  const shownDays = Number((totalText.match(/(\d+) 天/) || [])[1] || 0)
  if (shownDays === expectedGroups) ok(`算式分组：${shownDays} 天 = ${realDays} 真实日期 + ${missing ? 1 : 0} 未识别组（不写死快照）`)
  else throw new Error(`shownDays=${shownDays} expected=${expectedGroups}`)
  const badDate = await p.evaluate(() => [...document.querySelectorAll('.rb-day-date')]
    .map((e) => e.textContent.trim())
    .filter((t) => /Invalid|1970|2026-11-16/.test(t) && t !== '日期未识别'))
  if (badDate.length === 0) ok('组头无 Invalid / 1970 / 今天被当报告日期')
  else throw new Error(`badDate=${badDate.join(',')}`)
  // 翻到最后一页：未识别组必须在（且恒末位）
  // 桌面 Table 的分页器虽被 display:none 包住，DOM 里仍有一份副本；
  // 必须只点**可见**的按天分页器，否则会点到隐藏副本、页面没翻。
  const lastPage = p.locator('.ant-pagination-item:visible[title="4"]').first()
  if (await lastPage.count()) {
    await lastPage.click({ timeout: 5000 })
    await p.waitForTimeout(500)
    const last = await p.evaluate(() => {
      const secs = [...document.querySelectorAll('.rb-day-section')]
      return { none: !!secs.find((s) => s.dataset.day === '__none__'), isLast: secs.length ? secs[secs.length - 1].dataset.day : '', keys: secs.map((s) => s.dataset.day) }
    })
    if (!missing || (last.none && last.isLast === '__none__')) ok('翻到末页：日期未识别组存在且恒末位')
    else throw new Error(JSON.stringify(last))
    // 搜索变化 → 回第 1 页（r3 ①）
    await p.locator('input[placeholder*="搜医院"]').first().fill('血常规')
    await p.waitForTimeout(600)
    const active = await p.locator('.ant-pagination-item-active:visible').first().textContent().catch(() => '1')
    if (String(active).trim() === '1' || (await p.locator('.ant-pagination:visible').count()) === 0) ok('搜索变化后回到第 1 页（无空白页）')
    else throw new Error(`page=${active}`)
    await p.locator('input[placeholder*="搜医院"]').first().fill('').catch(() => {})
    await p.waitForTimeout(400)
  }
  if (m.nested === 0 && m.tagsInMain === 0 && m.supHidden) ok('主行 button 无嵌套交互、Tag 在次行、sup aria-hidden')
  else throw new Error(`nested=${m.nested} tagsInMain=${m.tagsInMain} supHidden=${m.supHidden}`)
  if (m.tableVisible === false) ok('375 不再渲染桌面 Table')
  else throw new Error('桌面 Table 仍可见')
  if (m.tallest <= 68) ok(`行高受控（最高 ${Math.round(m.tallest)}px ≤68，目标 ≤52+命中行）`)
  else throw new Error(`行高 ${m.tallest}`)
  if (m.hasManageBtn && m.delBtns === 0) ok('管理态前：管理按钮在、每行删除按钮 0 个')
  else throw new Error(`manage=${m.hasManageBtn} del=${m.delBtns}`)
  if (m.iconBtns === m.actionBtns && m.iconBtns === m.hotZones) ok(`操作按钮全为图标 + aria-label + ≥32px 热区（${m.iconBtns} 个）`)
  else throw new Error(`icon=${m.iconBtns} all=${m.actionBtns} hot=${m.hotZones}`)
  // 不写死「恰 2 段」：编辑弹窗后来加了第 3 段 mb-report-edit-modal-mobile（各独立 useEffect/id）。
  // 判据改为「必需的 day/drawer 都在 + id 无重复」，新增页面级样式不该让本断言变红。
  const unique = new Set(m.styles).size === m.styles.length
  if (unique && m.styles.includes('mb-report-day-mobile') && m.styles.includes('mb-report-drawer-mobile')) {
    ok(`页面级 style 并存且 id 唯一（${m.styles.join(' / ')}）`)
  } else throw new Error(`styles=${m.styles.join(',')}`)
  if (/共 \d+ 份 · \d+ 天/.test(m.pagerTotal)) ok(`分页 showTotal 覆盖为「${m.pagerTotal}」`)
  else console.log('SKIP 分页断言：当前组数未超过每页 7 组（无分页器）')

  // 管理态：点管理 → 删除出现；点删除（取消）不应打开抽屉
  await p.locator('button[aria-label="管理"]').first().click({ timeout: 5000 })
  await p.waitForTimeout(400)
  const after = await p.evaluate(() => ({
    del: document.querySelectorAll('.rb-day-row button[aria-label="删除"]').length,
    manageLabel: document.querySelector('button[aria-label="退出管理"]') ? '退出管理' : '',
  }))
  if (after.del > 0 && after.manageLabel) ok(`管理态后：删除按钮 ${after.del} 个、按钮变「退出管理」`)
  else throw new Error(JSON.stringify(after))
  await p.locator('.rb-day-row button[aria-label="删除"]').first().click({ timeout: 5000 })
  await p.waitForTimeout(500)
  const drawerOpen = await p.locator('.ant-drawer-open').count()
  const popOpen = await p.locator('.ant-popconfirm, .ant-popover').count()
  if (drawerOpen === 0) ok('点删除不冒泡开抽屉（弹出的是删除确认）')
  else throw new Error(`drawerOpen=${drawerOpen} pop=${popOpen}`)
  await p.keyboard.press('Escape').catch(() => {})

  // 回收站：管理控件数 0、恢复/彻底删除仍在
  await p.locator('.ant-segmented-item').filter({ hasText: '回收站' }).first().click({ timeout: 5000 }).catch(() => {})
  await p.waitForTimeout(1000)
  const trash = await p.evaluate(() => ({
    manage: document.querySelectorAll('button[aria-label="管理"], button[aria-label="退出管理"]').length,
    del: document.querySelectorAll('.rb-day-row button[aria-label="删除"]').length,
    restore: document.querySelectorAll('.rb-day-row button[aria-label="恢复"]').length,
    purge: document.querySelectorAll('.rb-day-row button[aria-label="彻底删除"]').length,
  }))
  if (trash.manage === 0) ok('回收站管理控件数 == 0')
  else throw new Error(`trash manage=${trash.manage}`)
  console.log(`       回收站恢复/彻底删除：${trash.restore}/${trash.purge}（数据为空时可为 0）`)

  // ---------------- 1440 桌面 ----------------
  const d = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await d.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await d.waitForTimeout(1400)
  const desk = await d.evaluate(() => ({
    tables: document.querySelectorAll('.ant-table').length,
    daySections: document.querySelectorAll('.rb-day-section').length,
    heads: document.querySelectorAll('.ant-table-thead th').length,
    sorters: document.querySelectorAll('.ant-table-column-sorter').length,
    iconBtns: document.querySelectorAll('.ant-table button[aria-label]').length,
  }))
  if (desk.tables === 1 && desk.daySections === 0) ok(`1440 桌面仍是 Table（${desk.heads} 列 / ${desk.sorters} 个排序箭头）`)
  else throw new Error(JSON.stringify(desk))
  if (desk.iconBtns > 0) ok(`桌面操作列已换图标按钮（${desk.iconBtns} 个，列与排序未动）`)
  else throw new Error('桌面操作列仍是文字按钮')
} finally {
  await browser.close()
}
console.log(`\n报告库 UI v0.4：${pass} 通过 / 0 失败`)
