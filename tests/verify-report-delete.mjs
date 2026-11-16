#!/usr/bin/env node
// 报告软删除 / 回收站恢复 / 彻底删除 —— 端到端回归（**跑副本库，绝不碰真实库**）
//
// 为什么要这么测：删除是唯一「点了就少东西」的入口，纯函数测不出「删了还在不在」「恢复后字段变没变」。
// 所以这里真起一个服务进程（独立端口 5199），但把 `MEDBRIEF_REPORTS_FILE` + `MEDBRIEF_DATA_DIR`
// 指向 /tmp 的**副本**（reports.json + medbrief.db 各复制一份），全程不写 data/。
// 收尾必断言：真实 data/reports.json 的 sha256 与开跑前一致。
//
// 覆盖的口径（Manager 2026-11-14 批准）：
//   ① 软删除：活报告 → 回收站，字段一个不改；资料卡（只读 store.reports）自动不含它
//   ② 恢复：回收站 → 报告库原位，字段与删除前完全一致
//   ③ 彻底删除：**只允许对回收站里的报告**（活报告直接 purge → 400）
//   ④ 共享字节保护：还有别的报告引用同一 sha256 → 只删记录、字节保留（bytesKept:true）
//   ⑤ 审计：软删/恢复写进该报告的 patchLog；彻底删除写进库级 store.audit[]
//
// 用法：node tests/verify-report-delete.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REAL_REPORTS = path.join(ROOT, 'data', 'reports.json')
const REAL_DB = path.join(ROOT, 'data', 'medbrief.db')
const PORT = 5199
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
const fails = []
const it = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); pass++ } catch (e) { console.log(`FAIL  ${name} → ${e.message}`); fails.push(name) }
}
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const realShaBefore = sha256File(REAL_REPORTS)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-del-'))
const tmpReports = path.join(tmp, 'reports.json')
// 测试必须从「空回收站」起步：真实库现在自带 1 条已软删记录（用户实际操作留下的），
// 整份复制会让「软删 1 条后 trashCount 应为 1」变成 2。
// 只清 trashed、保留 reports/audit/version，既隔离夹具又不改测试断言语义。
{
  const store = JSON.parse(fs.readFileSync(REAL_REPORTS, 'utf8'))
  fs.writeFileSync(tmpReports, JSON.stringify({ ...store, trashed: [] }, null, 2), 'utf8')
}
fs.copyFileSync(REAL_DB, path.join(tmp, 'medbrief.db'))

let child = null
const req = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, body: j }
}
const readTmp = () => JSON.parse(fs.readFileSync(tmpReports, 'utf8'))
const writeTmp = (j) => fs.writeFileSync(tmpReports, JSON.stringify(j, null, 2))
const tombstoneCount = () => {
  const db = new DatabaseSync(path.join(tmp, 'medbrief.db'), { readOnly: true })
  const n = db.prepare('SELECT COUNT(*) n FROM blob_tombstones').get().n
  db.close()
  return n
}

async function boot() {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MEDBRIEF_REPORTS_FILE: tmpReports, MEDBRIEF_DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150))
    try { const { body } = await req('GET', '/api/health'); if (body.ok) return log } catch { /* 还没起来 */ }
  }
  throw new Error(`服务未起来（PORT=${PORT}）：\n${log.slice(-800)}`)
}
function shutdown() {
  if (!child) return
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  child = null
}

try {
  const bootLog = await boot()
  // 护栏：启动日志必须打出实际用的 reportsFile，且指向副本（防止「以为测的是副本、其实写了真库」）
  assert.match(bootLog, /reportsFile=/, '启动日志必须打印 reportsFile=')
  assert.ok(bootLog.includes(tmp), `启动日志里的 reportsFile 应指向副本目录，实际日志：${bootLog.match(/reportsFile=\S*/)?.[0] || '(无)'}`)

  const before = readTmp()
  const liveIds = before.reports.map((r) => r.id)
  assert.ok(liveIds.length >= 3, '副本里应有至少 3 份报告才够测')
  const victimId = liveIds[0]
  const victimBefore = JSON.parse(JSON.stringify(before.reports.find((r) => r.id === victimId)))

  await it('软删除：从报告库消失、进回收站，且 trashCount 同步', async () => {
    const { body } = await req('DELETE', `/api/intake/reports/${victimId}`)
    assert.equal(body.ok, true, body.error)
    assert.equal(body.action, 'delete')
    const live = await req('GET', '/api/intake/reports')
    assert.equal(live.body.reports.some((r) => r.id === victimId), false, '软删后仍出现在报告库列表')
    assert.equal(live.body.trashCount, 1, `trashCount 应为 1，实际 ${live.body.trashCount}`)
    const trash = await req('GET', '/api/intake/reports?trash=1')
    assert.equal(trash.body.trash, true)
    assert.equal(trash.body.reports.some((r) => r.id === victimId), true, '回收站里看不到刚删的报告')
  })

  await it('软删除后资料卡自动不含它（/api/intake/card 只读 store.reports）', async () => {
    const { body } = await req('GET', '/api/intake/card?mask=1')
    assert.equal(body.ok, true)
    assert.equal(body.counts.reports, before.reports.length - 1, `资料卡报告数应为 ${before.reports.length - 1}，实际 ${body.counts.reports}`)
  })

  await it('回收站里的记录字段一个没改（行数/日期/医院/类型/单号全等）', async () => {
    const after = readTmp()
    const t = after.trashed.find((r) => r.id === victimId)
    assert.ok(t, 'trashed[] 里没有这条')
    for (const k of ['reportDate', 'hospital', 'reportType', 'kind', 'barcode', 'sha256']) {
      assert.deepEqual(t[k] ?? '', victimBefore[k] ?? '', `字段 ${k} 在软删后被改动了`)
    }
    assert.equal((t.rows || []).length, (victimBefore.rows || []).length, '行数变了')
    assert.ok(t.patchLog.some((e) => e.field === 'deleted'), '软删除必须留 patchLog 审计')
    assert.equal(after.trashed.length, 1)
  })

  await it('恢复：回到报告库原位，字段与删除前完全一致，回收站清空', async () => {
    const { body } = await req('POST', `/api/intake/reports/${victimId}/restore`, {})
    assert.equal(body.ok, true, body.error)
    const live = await req('GET', '/api/intake/reports')
    assert.equal(live.body.reports.some((r) => r.id === victimId), true, '恢复后没回到报告库')
    assert.equal(live.body.trashCount, 0, '恢复后回收站应为空')
    const restored = readTmp().reports.find((r) => r.id === victimId)
    for (const k of ['reportDate', 'hospital', 'reportType', 'kind', 'barcode', 'sha256']) {
      assert.deepEqual(restored[k] ?? '', victimBefore[k] ?? '', `恢复后字段 ${k} 与删除前不一致`)
    }
    assert.equal((restored.rows || []).length, (victimBefore.rows || []).length)
    assert.equal(restored.deletedAt, undefined, '恢复后不该残留 deletedAt')
    assert.ok(restored.patchLog.some((e) => e.field === 'restored'), '恢复必须留 patchLog 审计')
  })

  await it('活报告不许直接彻底删除（400 + 明确文案，挡掉误点一次就永久没）', async () => {
    const { status, body } = await req('DELETE', `/api/intake/reports/${victimId}?purge=1`)
    assert.equal(status, 400, `应 400，实际 ${status}`)
    assert.match(body.error, /先删除进回收站/, `错误文案要写清怎么做，实际：${body.error}`)
    assert.equal(readTmp().reports.some((r) => r.id === victimId), true, '被拒的 purge 不该动数据')
  })

  // ---- 共享字节保护：造两份共用同一 blob 的报告，逐个 purge ----
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const blobPost = await req('POST', '/api/intake/blob', { dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`, kind: 'original' })
  assert.equal(blobPost.body.ok, true, '准备共享原件失败')
  const sharedBlobId = blobPost.body.id
  const sharedSha = blobPost.body.sha256
  const mkShared = (id) => ({ id, createdAt: new Date().toISOString(), source: 'image', sha256: sharedSha, sourceBlobs: [{ blobId: sharedBlobId, role: 'original', sha256: sharedSha }], kind: 'lab', reportType: '共享字节测试', reportDate: '2026-01-01', hospital: '', barcode: '', rows: [], text: '' })
  const j0 = readTmp()
  j0.reports.push(mkShared('rep_deltest_sharedA'), mkShared('rep_deltest_sharedB'))
  writeTmp(j0)

  await it('共享字节保护：还有别的报告引用同一 sha256 → 只删记录，bytesKept:true', async () => {
    const tombBefore = tombstoneCount()
    assert.equal((await req('DELETE', '/api/intake/reports/rep_deltest_sharedA')).body.ok, true)
    const { body } = await req('DELETE', '/api/intake/reports/rep_deltest_sharedA?purge=1')
    assert.equal(body.ok, true, body.error)
    assert.equal(body.bytesKept, true, '另一份报告还引用着同一份字节，必须保留')
    assert.equal(tombstoneCount(), tombBefore, 'blob 不该被删（tombstone 数不该变）')
    const still = await fetch(`${BASE}/api/intake/blob/${sharedBlobId}`)
    assert.equal(still.status, 200, '共享的 blobs 字节应仍可取回')
    assert.equal(readTmp().reports.some((r) => r.id === 'rep_deltest_sharedA'), false)
  })

  await it('独占字节才真删：最后一份引用者 purge 后 tombstone +1、记录不在任何列表', async () => {
    const tombBefore = tombstoneCount()
    assert.equal((await req('DELETE', '/api/intake/reports/rep_deltest_sharedB')).body.ok, true)
    const { body } = await req('DELETE', '/api/intake/reports/rep_deltest_sharedB?purge=1')
    assert.equal(body.ok, true, body.error)
    assert.equal(body.bytesKept, false, '没有别的引用了，应真的删字节')
    assert.equal(tombstoneCount(), tombBefore + 1, `tombstone 应 +1，实际 ${tombstoneCount()}（前 ${tombBefore}）`)
    const gone = await fetch(`${BASE}/api/intake/blob/${sharedBlobId}`)
    assert.notEqual(gone.status, 200, '独占字节应已被删除')
    const live = await req('GET', '/api/intake/reports')
    const trash = await req('GET', '/api/intake/reports?trash=1')
    for (const id of ['rep_deltest_sharedA', 'rep_deltest_sharedB']) {
      assert.equal(live.body.reports.some((r) => r.id === id), false, `${id} 不该在报告库`)
      assert.equal(trash.body.reports.some((r) => r.id === id), false, `${id} 不该在回收站`)
    }
  })

  await it('彻底删除留库级审计：store.audit[] 记了谁删的、删前长什么样', async () => {
    const j = readTmp()
    assert.ok(Array.isArray(j.audit) && j.audit.length >= 2, `audit 应有 2 条，实际 ${(j.audit || []).length}`)
    const a = j.audit.find((x) => x.reportId === 'rep_deltest_sharedB')
    assert.ok(a, 'audit 里找不到被彻底删的那条')
    assert.equal(a.action, 'purge')
    assert.equal(a.by, 'manual')
    assert.ok(a.snapshot && typeof a.snapshot === 'object', 'audit 要保留删除前的快照')
    assert.equal(a.bytesKept, false)
  })

  await it('副本库可解析为 v2 结构（trashed/audit 持久化，不是内存态）', async () => {
    const j = readTmp()
    assert.equal(j.version, 2)
    assert.ok(Array.isArray(j.trashed) && Array.isArray(j.audit))
  })
} finally {
  shutdown()
  await new Promise((r) => setTimeout(r, 200))
  // 收尾：真实库一个字节都没动
  const realShaAfter = sha256File(REAL_REPORTS)
  await it('真实库 data/reports.json sha256 前后一致（副本测试绝不写真实库）', async () => {
    assert.equal(realShaAfter, realShaBefore, '真实库被改动了！')
  })
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `报告删除/恢复：${pass} 通过 / 0 失败` : `报告删除/恢复：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
