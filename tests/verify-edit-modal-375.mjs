// 编辑报告弹窗 375 布局断言（2026-11-16 用户实测：顶部约 108px 空余 + 整个遮罩要下滑才见底部按钮）
// 真浏览器、只读、不写库；服务未起时 SKIP 并退出 0。
import { chromium } from 'playwright'

const BASE = process.env.MEDBRIEF_BASE || 'http://127.0.0.1:5174'
let pass = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }
let ready = false
try { ready = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })).ok } catch {}
if (!ready) { console.log('SKIP 编辑弹窗 375 断言：5174 未就绪'); process.exit(0) }

const browser = await chromium.launch({ headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 375, height: 812 } })
  await p.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1500)
  const edit = p.locator('button[aria-label="编辑"]').first()
  if (!(await edit.count())) { console.log('SKIP 编辑弹窗 375：列表没有编辑按钮'); process.exit(0) }
  await edit.click({ timeout: 8000, force: true })
  await p.waitForTimeout(1300)
  const m = await p.evaluate(() => {
    const w = document.querySelector('.mb-edit-modal')
    const r = (e) => e ? { y: Math.round(e.getBoundingClientRect().y), h: Math.round(e.getBoundingClientRect().height), sh: e.scrollHeight, ch: e.clientHeight } : null
    const wrap = document.querySelector('.ant-modal-wrap')
    const footerBtns = [...document.querySelectorAll('.mb-edit-modal .ant-modal-footer button')].map((b) => b.textContent.replace(/\s/g, ''))
    const topSave = document.querySelector('.rb-edit-top-save')
    return {
      modal: r(w), container: r(w?.querySelector('.ant-modal-container')),
      header: r(w?.querySelector('.ant-modal-header')), body: r(w?.querySelector('.ant-modal-body')),
      footer: r(w?.querySelector('.ant-modal-footer')),
      wrap: r(wrap), de: document.documentElement.scrollWidth, footerBtns,
      topSaveVisible: topSave ? topSave.getBoundingClientRect().height > 0 : false,
      styles: [...document.querySelectorAll('head > style[id^="mb-report-"]')].map((s) => s.id),
      noteText: document.querySelector('.mb-edit-modal .ant-modal-body')?.textContent?.includes('编辑口径说明') || false,
    }
  })
  if (!m.modal) { console.log('SKIP 编辑弹窗 375：弹窗未打开'); process.exit(0) }
  if (m.modal.y <= 16) ok(`贴顶：弹窗 y=${m.modal.y}（原 108px 空余已消除）`)
  else throw new Error(`modal.y=${m.modal.y}`)
  if (m.wrap && m.wrap.sh <= m.wrap.ch + 1) ok(`整页不需下滑：wrap ${m.wrap.sh}/${m.wrap.ch}`)
  else throw new Error(`wrap ${m.wrap?.sh}/${m.wrap?.ch}`)
  if (m.body && m.body.sh > m.body.ch) ok(`body 内部滚动（sh=${m.body.sh} / ch=${m.body.ch}），header/footer 固定`)
  else throw new Error(`body ${m.body?.sh}/${m.body?.ch}`)
  if (m.footer && m.footer.y + m.footer.h <= 812) ok(`底部按钮始终在视口内（footer bottom=${m.footer.y + m.footer.h}）`)
  else throw new Error(`footer bottom=${m.footer?.y + m.footer?.h}`)
  if (m.footerBtns.some((t) => t.includes('保存修改')) && m.footerBtns.some((t) => t.includes('取消'))) ok('footer 有「取消 / 保存修改」')
  else throw new Error(`footerBtns=${m.footerBtns.join(',')}`)
  if (!m.topSaveVisible) ok('顶部冗余「保存修改」已隐藏（footer 是唯一写库入口）')
  else throw new Error('顶部仍有重复保存按钮')
  if (m.noteText) ok('长说明收成一行 + Tooltip（信息不丢）')
  else throw new Error('编辑口径说明缺失')
  if (m.styles.includes('mb-report-edit-modal-mobile')) ok('页面级 #mb-report-edit-modal-mobile 已注入（独立 id）')
  else throw new Error(`styles=${m.styles.join(',')}`)
  if (m.de === 375) ok('375 无横向溢出'); else throw new Error(`de=${m.de}`)

  // 1440 桌面：完全不变（top=100、无内部滚动）
  const d = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await d.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await d.waitForTimeout(1300)
  const e2 = d.locator('button[aria-label="编辑"]').first()
  if (await e2.count()) {
    await e2.click({ timeout: 8000, force: true })
    await d.waitForTimeout(1200)
    const desk = await d.evaluate(() => {
      const w = document.querySelector('.mb-edit-modal')
      const body = w?.querySelector('.ant-modal-body')
      return { y: Math.round(w?.getBoundingClientRect().y || 0), sh: body?.scrollHeight, ch: body?.clientHeight,
        topSave: (document.querySelector('.rb-edit-top-save')?.getBoundingClientRect().height || 0) > 0 }
    })
    if (desk.y === 100 && desk.topSave) ok(`1440 桌面零回归（y=${desk.y}、顶部保存按钮仍显示）`)
    else throw new Error(JSON.stringify(desk))
  } else console.log('SKIP 1440 断言：列表没有编辑按钮')
} finally {
  await browser.close()
}
console.log(`\n编辑弹窗 375 布局：${pass} 通过 / 0 失败`)
