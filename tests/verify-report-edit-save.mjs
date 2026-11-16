// 报告库「编辑保存 / 恢复」回归 —— 2026-11-16 用户实测报错：
//   Cannot read properties of undefined (reading 'ok')
//
// 根因（已修）：`web/src/api.js` 的 `jpost()` 返回的是 **body 本身**（`jfetch` 已在
// `!res.ok` / `ok:false` 时抛错），而三处调用写成了 `const { body } = await jpost(...)`
// ⇒ `body` 是 `undefined` ⇒ 下一行 `body.ok` 抛 TypeError。三处：编辑保存 / 回收站恢复 /
// 原件页行修正（`ReportsPanel.jsx:339`、`:283`、`SourceModal.jsx:128`）。
// 注意 `rawJson` / `postJson`（`shared.js`）确实返回 `{ httpStatus, body }`，两套 helper 不一样，
// 这正是这个 bug 的成因 —— 所以本测试同时守一条**静态断言**（不许再出现 `const { body } = await jpost`）。
//
// 只写副本库：真库 sha256 前后必须一致。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REAL = path.join(ROOT, 'data', 'reports.json')
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const realBefore = sha(REAL)

let pass = 0, failed = 0, na = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }
const fail = (n, e = '') => { failed++; console.log(`FAIL ${n}${e ? ' · ' + e : ''}`) }
const skip = (n, e = '') => { na++; console.log(`N/A ${n}${e ? ' · ' + e : ''}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-editsave-'))
const tr = path.join(tmp, 'reports.json')
fs.copyFileSync(REAL, tr)
const PORT = 5194
const BASE = `http://127.0.0.1:${PORT}`

const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), MEDBRIEF_REPORTS_FILE: tr, MEDBRIEF_DATA_DIR: tmp },
  stdio: 'ignore',
})
const browser = await chromium.launch({ headless: true })

try {
  let up = false
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) { up = true; break } } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(up, `副本服务未起来（${BASE}）`)
  ok(`副本服务已起：${BASE}（副本库 ${tr}）`)

  // 静态守门：不许再出现把 jpost 当 rawJson 用的写法
  const rp = fs.readFileSync(path.join(ROOT, 'web/src/pages/intake/ReportsPanel.jsx'), 'utf8')
  const sm = fs.readFileSync(path.join(ROOT, 'web/src/pages/card/SourceModal.jsx'), 'utf8')
  const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/\/\/[^`]*const \{/.test(l)).join('\n')
  const badStatic = [...codeOnly(rp).matchAll(/const \{[^}]*\} = await jpost\(/g), ...codeOnly(sm).matchAll(/const \{[^}]*\} = await jpost\(/g)]
  if (badStatic.length === 0) ok('S1 静态断言：无 `const { body } = await jpost(...)` 解构误用')
  else fail(`S1 仍有 ${badStatic.length} 处解构误用（jpost 返回 body 本身）`)

  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  p.on('pageerror', (e) => pageErrors.push(String(e.message || e)))

  await p.goto(`${BASE}/?tab=reports`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('text=报告库', { timeout: 15000 })
  await p.waitForSelector('button[aria-label="编辑"]', { timeout: 15000 })
  ok('报告库已渲染（编辑入口存在）')

  // ---------- T1：编辑报告 → 改一个数值 → 保存 ----------
  await p.locator('button[aria-label="编辑"]').first().click()
  await p.waitForSelector('.ant-modal .g-ctl', { timeout: 15000 })
  const marker = `9${Math.floor(Math.random() * 8) + 1}.${Math.floor(Math.random() * 9)}`
  const inputs = p.locator('.ant-modal .g-ctl')
  const nInputs = await inputs.count()
  if (nInputs === 0) {
    skip('T1 编辑保存', '弹窗内没有 .g-ctl 输入（该报告无指标行？）')
  } else {
    // 只改第 2 个输入（通常是 value 单元格；改名字也能被 patch 记录，但不改 name 更安全）
    let target = null, before = ''
    for (let i = 0; i < Math.min(nInputs, 20); i++) {
      const el = inputs.nth(i)
      const v = await el.inputValue().catch(() => '')
      if (/^-?\d+(\.\d+)?$/.test(v)) { target = el; before = v; break }
    }
    if (!target) {
      target = inputs.nth(0)
      before = await target.inputValue().catch(() => '')
      skip('T1 目标列', '没找到纯数字单元格，退回第 1 个输入（可能改到名称列）')
    }
    await target.fill(marker)
    const footerBtn = p.locator('.ant-modal-footer button:has-text("保存修改")').first()
    await footerBtn.click()
    let msg = ''
    try {
      await p.waitForSelector('.ant-message-success', { timeout: 10000 })
      msg = (await p.locator('.ant-message-success').first().innerText()).trim()
    } catch { /* 下面判 */ }
    if (/已保存/.test(msg)) ok(`T1 编辑保存成功：${msg}（「${before}」→「${marker}」，输入框 ${nInputs} 个）`)
    else {
      const errMsg = await p.locator('.ant-message-error').first().innerText().catch(() => '')
      fail(`T1 编辑保存未成功：success=${JSON.stringify(msg)} error=${JSON.stringify(errMsg)}`)
    }

    // 副本库侧证：patchLog 有记录（说明真写进去了）
    const lib = JSON.parse(fs.readFileSync(tr, 'utf8'))
    const patched = (lib.reports || []).filter((r) => (r.patchLog || []).length > 0)
    if (patched.length > 0) ok(`T1b 副本库已落 patchLog：${patched.length} 份有改动记录（patchedAt=${patched[0].patchedAt || '—'}）`)
    else fail('T1b 副本库 patchLog 为空 —— 保存没落到库里')

    // 关弹窗，避免影响后续
    await p.locator('.ant-modal-close').first().click().catch(() => {})
    await p.waitForTimeout(300)
  }

  // ---------- T2：回收站恢复（同一类 bug 的第二处） ----------
  const alive = JSON.parse(fs.readFileSync(tr, 'utf8')).reports || []
  if (!alive.length) {
    skip('T2 回收站恢复', '副本库没有可回收的报告')
  } else {
    const victim = alive[0].id
    const del = await (await fetch(`${BASE}/api/intake/reports/${encodeURIComponent(victim)}`, { method: 'DELETE' })).json()
    if (!del.ok) {
      fail(`T2 前置：副本库软删失败 ${JSON.stringify(del)}`)
    } else {
      await p.reload({ waitUntil: 'domcontentloaded' })
      const libAfterDel = JSON.parse(fs.readFileSync(tr, 'utf8'))
      const aliveBefore = (libAfterDel.reports || []).length
      const trashBefore = (libAfterDel.trashed || []).length
      await p.waitForSelector('text=回收站', { timeout: 15000 })
      await p.locator('.ant-segmented-item:has-text("回收站")').first().click()
      await p.waitForSelector('button[aria-label="恢复"]', { timeout: 15000 })
      await p.locator('button[aria-label="恢复"]').first().click()
      const confirmOk = p.locator('.ant-popover:visible .ant-btn-primary').first()
      await confirmOk.click()
      let msg2 = ''
      try {
        await p.waitForSelector('.ant-message-success', { timeout: 10000 })
        msg2 = (await p.locator('.ant-message-success').first().innerText()).trim()
      } catch {}
      // 回收站里可能本来就有别的报告，且列表首行不一定是我们刚删的那份 —— 判据看**计数变化**（+1 活 / −1 回收站）
      const after = JSON.parse(fs.readFileSync(tr, 'utf8'))
      const aliveAfter = (after.reports || []).length
      const trashAfter = (after.trashed || []).length
      const restored = /已恢复到报告库原位/.test(msg2)
      if (restored && aliveAfter === aliveBefore + 1 && trashAfter === trashBefore - 1) {
        ok(`T2 回收站恢复成功：${msg2}（活库 ${aliveBefore}→${aliveAfter}，回收站 ${trashBefore}→${trashAfter}）`)
      } else {
        fail(`T2 回收站恢复失败：success=${JSON.stringify(msg2)}，活库 ${aliveBefore}→${aliveAfter}（期望 +1），回收站 ${trashBefore}→${trashAfter}（期望 −1）`)
      }
    }
  }

  // ---------- T3：全程零 pageerror（用户看到的就是这条 TypeError） ----------
  const typeErrs = pageErrors.filter((m) => /reading 'ok'|Cannot read properties of undefined/.test(m))
  if (pageErrors.length === 0) ok('T3 全程 pageerror=0')
  else if (typeErrs.length === 0) ok(`T3 无 "reading 'ok'" 类错误（其他 pageerror ${pageErrors.length} 条：${pageErrors.slice(0, 2).join(' | ')}）`)
  else fail(`T3 仍出现 reading 'ok' 类错误 ${typeErrs.length} 条：${typeErrs[0]}`)
} finally {
  await browser.close().catch(() => {})
  srv.kill('SIGKILL')
  const realAfter = sha(REAL)
  if (realAfter === realBefore) ok('Z1 真实库 sha256 前后一致（本测试只写副本库）')
  else fail('Z1 真实库被改动！')
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('')
  console.log(`汇总：${pass} 通过 / ${failed} 失败 / ${na} 未证`)
  process.exitCode = failed ? 1 : (na > 0 ? 2 : 0)
}
