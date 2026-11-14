#!/usr/bin/env node
// ===================== 补丁回放沙箱（`POST /api/intake/reports/:id/patch`） =====================
// 为什么要有它：真实病历库 55 份不能拿来试写。但「修正数值」这条写路径从没在数据上真跑过，
// 只验证到「表单能打开」——而它有个**静默丢数据**的理论风险：
//   三列左移的存储行（`value` 里放的是参考区间、`refRange` 里放的是单位）靠**读侧还原**
//   （`repairColumnShift` 靠 isRange(value) && isUnitLike(refRange) 判形态）才恢复出真值。
//   若人工只提交 `value`，形态判据不再成立 → 还原不触发 → 原区间被覆盖，**永久丢失且不报错**。
//
// 本脚本用一次性 worktree + 独立端口把这条路径真跑一遍：
//   用例 A（现状风险）：只提交 {index, value} → 断言参考区间丢了（读侧不再还原）
//   用例 B（正确用法）：四元组 {index, name, value, unit, refRange} → 断言区间保住、patchLog 留痕
//
// 用法：node tools/patch-replay.mjs [--keep]
//   --keep  跑完保留 worktree 与 5199 服务（排障用），默认清理
//
// 硬约束（不要改）：
//   - 只读真实仓库；`data/reports.json` 一个字都不写（脚本开始/结束各算一次 sha256 比对）
//   - 不碰 5174，不碰白名单外文件，不挂进 test:intake 链（它要起第二个服务）

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WT = process.env.MB_REPLAY_WT || path.join(os.tmpdir(), 'mb-replay')
const PORT = Number(process.env.MB_REPLAY_PORT || 5199)
const BASE = `http://127.0.0.1:${PORT}`
const KEEP = process.argv.includes('--keep')
const SRC_STORE = path.join(ROOT, 'data', 'reports.json')

const ok = (m) => console.log(`PASS  ${m}`)
const bad = (m) => { failures++; console.log(`FAIL  ${m}`) }
let failures = 0
const step = (m) => console.log(`\n== ${m}`)

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, json: j }
}

/** 逐字段对比表：字段 | 改前 | 改后 */
function table(title, rows) {
  console.log(`\n${title}`)
  const w = Math.max(...rows.map((r) => String(r[0]).length), 4)
  for (const [k, before, after] of rows) {
    console.log(`  ${String(k).padEnd(w)} | ${String(before)}  →  ${String(after)}`)
  }
}

// ---------------- 0. 前置检查 ----------------
let server = null
let wtReady = false
const srcHashBefore = fs.existsSync(SRC_STORE) ? sha256(SRC_STORE) : ''
if (!srcHashBefore) {
  console.error(`找不到真实库：${SRC_STORE}`)
  process.exit(2)
}

try {
  // ---------------- 1. 一次性 worktree ----------------
  step(`准备临时 worktree：${WT}`)
  if (fs.existsSync(WT)) {
    try { execFileSync('git', ['worktree', 'remove', '--force', WT], { cwd: ROOT, stdio: 'pipe' }) } catch {}
    fs.rmSync(WT, { recursive: true, force: true })
  }
  execFileSync('git', ['worktree', 'add', '--detach', WT, 'HEAD'], { cwd: ROOT, stdio: 'pipe' })
  wtReady = true
  // worktree 不带 node_modules（gitignore），server.mjs 依赖 playwright / better-sqlite3 / canvas
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WT, 'node_modules'), 'dir')
  fs.mkdirSync(path.join(WT, 'data'), { recursive: true })
  const WT_STORE = path.join(WT, 'data', 'reports.json')
  const pristine = path.join(WT, 'data', 'reports.json.pristine')
  fs.copyFileSync(SRC_STORE, pristine)          // 只复制，源文件不动
  fs.copyFileSync(pristine, WT_STORE)
  ok(`worktree = HEAD，库已复制（${(fs.statSync(pristine).size / 1024).toFixed(0)} KB），源库未改动`)

  // ---------------- 2. 独立端口起服务 ----------------
  step(`起独立服务：PORT=${PORT}（不碰 5174）`)
  const logPath = path.join(WT, 'server.log')
  const out = fs.openSync(logPath, 'w')
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: WT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', out, out],
  })
  let up = false
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      const h = await req('GET', '/api/health')
      if (h.json?.ok) { up = true; break }
    } catch { /* 还没起来 */ }
    if (server.exitCode !== null) break
  }
  if (!up) throw new Error(`服务没起来（看 ${logPath}）：${fs.readFileSync(logPath, 'utf8').slice(-400)}`)
  ok(`服务就绪 ${BASE}（pid ${server.pid}）`)

  // ---------------- 3. 挑一个「三列左移」的存储行 ----------------
  step('挑样本行：isRange(value) && isUnitLike(refRange)')
  const { isRange, isUnitLike } = await import(pathToFileURL(path.join(WT, 'lib', 'labClean.mjs')).href)
  const store = JSON.parse(fs.readFileSync(path.join(WT, 'data', 'reports.json'), 'utf8'))
  let pick = null
  for (const rep of store.reports) {
    ;(rep.rows || []).forEach((row, index) => {
      if (pick) return
      if (isRange(row.value) && isUnitLike(row.refRange)) pick = { reportId: rep.id, index, row }
    })
    if (pick) break
  }
  if (!pick) throw new Error('库里没有三列左移样本行，本脚本不适用')
  const { reportId, index } = pick
  console.log(`  报告 ${reportId} 第 ${index} 行：name=${JSON.stringify(pick.row.name)}`)
  console.log(`  存储原样：value=${JSON.stringify(pick.row.value)} unit=${JSON.stringify(pick.row.unit)} refRange=${JSON.stringify(pick.row.refRange)}`)

  const detail = async () => (await req('GET', `/api/intake/reports/${encodeURIComponent(reportId)}`)).json
  const patch = (rows, extra = {}) => req('POST', `/api/intake/reports/${encodeURIComponent(reportId)}/patch`, { rows, ...extra })
  const resetStore = () => fs.copyFileSync(path.join(WT, 'data', 'reports.json.pristine'), path.join(WT, 'data', 'reports.json'))

  const before = await detail()
  const beforeView = before.rows?.[index]
  const beforeRaw = before.rawRows?.[index]
  console.log(`  读侧还原后：value=${JSON.stringify(beforeView?.value)} unit=${JSON.stringify(beforeView?.unit)} refRange=${JSON.stringify(beforeView?.refRange)} repaired=${JSON.stringify(beforeView?.repaired)}`)

  // ---------------- 4. 用例 A：只提交 value ----------------
  step('用例 A：只提交 { index, value }（理论风险，应为「区间丢失」）')
  const newValue = '10.5'
  const aRes = await patch([{ index, value: newValue }])
  if (!aRes.json?.ok) throw new Error(`patch 失败：${JSON.stringify(aRes.json).slice(0, 200)}`)
  const afterA = await detail()
  const viewA = afterA.rows?.[index]
  const rawA = afterA.rawRows?.[index]
  table('用例 A · 逐字段', [
    ['value(读侧)', beforeView?.value, viewA?.value],
    ['unit(读侧)', beforeView?.unit, viewA?.unit],
    ['refRange(读侧)', beforeView?.refRange, viewA?.refRange],
    ['repaired', JSON.stringify(beforeView?.repaired), JSON.stringify(viewA?.repaired)],
    ['refRange(存储)', beforeRaw?.refRange, rawA?.refRange],
  ])
  const rangeLost = !isRange(String(viewA?.refRange || '')) && !isRange(String(rawA?.refRange || ''))
  const repairGone = !(viewA?.repaired || []).includes('column-shift')
  // 只看**结构化字段**：rawSnippet 是原文证据，里面本来就还留着区间串（人工回查用），不参与本判定
  const structuredA = [rawA?.value, rawA?.unit, rawA?.refRange].map((v) => String(v ?? '')).join('|')
  const origRange = String(beforeView?.refRange || '')
  const rangeGoneFromFields = !structuredA.includes(origRange)
  const snippetKeepsIt = String(rawA?.rawSnippet || '').includes(origRange)
  repairGone ? ok('A1 读侧不再还原（repaired 里没有 column-shift）') : bad(`A1 仍在还原：${JSON.stringify(viewA?.repaired)}`)
  rangeLost ? ok(`A2 参考区间读不出来（refRange=${JSON.stringify(viewA?.refRange)}，不是区间形态）`) : bad(`A2 区间仍在：${viewA?.refRange}`)
  rangeGoneFromFields
    ? ok(`A3 原区间 ${JSON.stringify(origRange)} 已从结构化字段（value/unit/refRange）消失`)
    : bad(`A3 原区间仍在结构化字段：${structuredA}`)
  console.log(
    `      备注：rawSnippet ${snippetKeepsIt ? '仍含' : '不含'}原区间串 —— ${snippetKeepsIt ? '人工可回查，但不是程序可用的区间' : '原文也没了'}`,
  )

  // ---------------- 5. 用例 B：四元组整行回写 ----------------
  step('用例 B：四元组 { index, name, value, unit, refRange }（正确用法）')
  resetStore()                                    // 回到原始存储行，两个用例互不影响
  const fixedNames = []
  const cleanName = String(beforeView?.name || '').trim()
  const keepUnit = String(beforeView?.unit || pick.row.refRange || '').trim()
  const keepRange = String(beforeView?.refRange || pick.row.value || '').trim()
  const bRes = await patch([{ index, name: cleanName, value: newValue, unit: keepUnit, refRange: keepRange }])
  if (!bRes.json?.ok) throw new Error(`patch 失败：${JSON.stringify(bRes.json).slice(0, 200)}`)
  const afterB = await detail()
  const viewB = afterB.rows?.[index]
  const rawB = afterB.rawRows?.[index]
  table('用例 B · 逐字段', [
    ['name', beforeView?.name, viewB?.name],
    ['value(读侧)', beforeView?.value, viewB?.value],
    ['unit(读侧)', beforeView?.unit, viewB?.unit],
    ['refRange(读侧)', beforeView?.refRange, viewB?.refRange],
    ['repaired', JSON.stringify(beforeView?.repaired), JSON.stringify(viewB?.repaired)],
  ])
  String(rawB?.refRange || '') === keepRange ? ok(`B1 参考区间完整保留：refRange=${JSON.stringify(rawB?.refRange)}`) : bad(`B1 区间没保住：${JSON.stringify(rawB?.refRange)} ≠ ${JSON.stringify(keepRange)}`)
  String(rawB?.unit || '') === keepUnit ? ok(`B2 单位归位：unit=${JSON.stringify(rawB?.unit)}`) : bad(`B2 单位不对：${JSON.stringify(rawB?.unit)}`)
  !(viewB?.repaired || []).includes('column-shift') ? ok('B3 不再需要读侧还原（repaired 无 column-shift）') : bad(`B3 仍在还原：${JSON.stringify(viewB?.repaired)}`)
  const log = afterB.patchLog || []
  const fields = log.map((l) => l.field)
  const shapeOk = log.length > 0 && log.every((l) => l.at && l.field && l.from !== undefined && l.to !== undefined)
  shapeOk ? ok(`B4 patchLog 留痕 ${log.length} 条，字段齐全 {at, field, from, to}`) : bad(`B4 patchLog 形状不对：${JSON.stringify(log).slice(0, 200)}`)
  const want = [`rows[${index}].value`, `rows[${index}].unit`, `rows[${index}].refRange`]
  const allLogged = want.every((f) => fields.includes(f))
  allLogged ? ok(`B5 三处改动都进日志：${want.join(' / ')}`) : bad(`B5 日志缺字段：${JSON.stringify(fields)}`)

  // ---------------- 6. 收尾 ----------------
  step('收尾')
  const srcHashAfter = sha256(SRC_STORE)
  srcHashBefore === srcHashAfter ? ok('真实库 sha256 未变（源文件一字未改）') : bad('真实库被改动了！')
  if (srcHashBefore !== srcHashAfter) fixedNames.push('RESTORE_REQUIRED')
} catch (e) {
  bad(`脚本异常：${e.message}`)
} finally {
  if (server) { try { server.kill('SIGTERM') } catch {} }
  await sleep(400)
  if (wtReady && !KEEP) {
    try { execFileSync('git', ['worktree', 'remove', '--force', WT], { cwd: ROOT, stdio: 'pipe' }) } catch {}
    try { fs.rmSync(WT, { recursive: true, force: true }) } catch {}
    console.log(`\n已清理 worktree 与 ${PORT} 服务`)
  } else if (KEEP) {
    console.log(`\n--keep：保留 ${WT} 与 ${BASE}（pid ${server?.pid ?? '-'}），用完记得 kill + git worktree remove --force ${WT}`)
  }
  console.log(failures ? `\n${failures} 项失败` : '\nA / B 两段全部 PASS')
  process.exit(failures ? 1 : 0)
}
