#!/usr/bin/env node
// 报告编辑「操作记录」（corrections 表）—— 端到端回归（**跑副本库 + 副本 SQLite，绝不碰真实库**）
//
// 为什么要真起服务测（纯函数测不出四件事）：
//   ① 端点是否真的把记录写进了**副本库的 medbrief.db**（而不是真实库）；
//   ② 是否**只追加**（同一批提交两次必须变 2 倍，不能覆盖 —— 覆盖就把「改了几次」丢了）；
//   ③ 是否**绝不改报告**（reports.json 字节不变；操作记录不许回灌成事实）；
//   ④ 不认识报告 / 空 ops 的护栏。
//
// 用法：node tests/verify-corrections.mjs
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
const PORT = 5198
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
const fails = []
const it = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); pass++ } catch (e) { console.log(`FAIL  ${name} → ${e.message}`); fails.push(name) }
}
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const realShaBefore = sha256File(REAL_REPORTS)
const realDbShaBefore = sha256File(REAL_DB)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-corr-'))
const tmpReports = path.join(tmp, 'reports.json')
fs.copyFileSync(REAL_REPORTS, tmpReports)
fs.copyFileSync(REAL_DB, path.join(tmp, 'medbrief.db'))
const tmpReportsShaBefore = sha256File(tmpReports)

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
    try { const { body } = await req('GET', '/api/health'); if (body.ok) return log } catch { /* 等 */ }
  }
  throw new Error(`服务未起来（PORT=${PORT}）：\n${log.slice(-800)}`)
}
function shutdown() {
  if (child) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
}
const corrCount = () => {
  const db = new DatabaseSync(path.join(tmp, 'medbrief.db'), { readOnly: true })
  const n = db.prepare('SELECT COUNT(*) n FROM corrections').get().n
  db.close()
  return n
}

const OPS = [
  { op: 'edit-field', row: 3, field: 'value', from: '130', to: '131', source: 'manual' },
  { op: 'edit-field', row: 3, field: 'value', from: '131', to: '132', source: 'manual' }, // 连打字：两次都要留
  { op: 'edit-field', row: 5, field: 'unit', from: '', to: 'g/L', source: 'manual' },
  { op: 'save', source: 'manual' },
]

try {
  await boot()
  const list = await req('GET', '/api/intake/reports')
  const target = (list.body.reports || [])[0]
  assert.ok(target, '副本库里应至少有一份报告（否则测试无意义）')

  await it('端点存在且把记录写进副本库的 medbrief.db', async () => {
    const r = await req('POST', `/api/intake/reports/${target.id}/corrections`, { ops: OPS, sessionId: 's-test-1' })
    assert.equal(r.status, 200, `应 200，实际 ${r.status} ${JSON.stringify(r.body)}`)
    assert.equal(r.body.stored, OPS.length, `应存 ${OPS.length} 条，实际 ${r.body.stored}`)
    assert.equal(corrCount(), OPS.length, `副本库里应有 ${OPS.length} 行，实际 ${corrCount()}`)
  })

  await it('只追加：同一批再提交一次 → 行数翻倍（不是覆盖，覆盖会丢「改了几次」）', async () => {
    const r = await req('POST', `/api/intake/reports/${target.id}/corrections`, { ops: OPS, sessionId: 's-test-1' })
    assert.equal(r.status, 200)
    assert.equal(corrCount(), OPS.length * 2, `应 ${OPS.length * 2} 行（只追加），实际 ${corrCount()}`)
  })

  await it('每条记录字段落全：op/row/field/from/to/source/session 一个不少', async () => {
    const r = await req('GET', `/api/intake/reports/${target.id}/corrections?session=s-test-1`)
    assert.equal(r.status, 200)
    const items = r.body.items || []
    assert.equal(items.length, OPS.length * 2)
    const first = items[0]
    assert.equal(first.op, 'edit-field')
    assert.equal(first.row_index, 3)
    assert.equal(first.field, 'value')
    assert.equal(first.from_value, '130')
    assert.equal(first.to_value, '131')
    assert.equal(first.source, 'manual')
    assert.equal(first.session_id, 's-test-1')
    assert.ok(first.created_at, 'created_at 必须有')
    // 连打字两次都要留（不能像 patchLog 那样只剩最终值）
    const typed = items.filter((x) => x.field === 'value').map((x) => `${x.from_value}->${x.to_value}`)
    assert.deepEqual(typed.slice(0, 2), ['130->131', '131->132'], `连打字两次都要留，实际 ${JSON.stringify(typed)}`)
  })

  await it('绝不改报告：corrections 写完，副本 reports.json 字节不变（不许回灌成事实）', async () => {
    assert.equal(sha256File(tmpReports), tmpReportsShaBefore, 'corrections 不得修改 reports.json')
  })

  await it('护栏：未知报告 404、空 ops 400', async () => {
    const a = await req('POST', '/api/intake/reports/rep_not_exist_xxx/corrections', { ops: OPS })
    assert.equal(a.status, 404)
    const b = await req('POST', `/api/intake/reports/${target.id}/corrections`, { ops: [] })
    assert.equal(b.status, 400)
  })

  await it('批次上限：超过 MAX_BATCH 的批次只收前 500 条并如实报 dropped', async () => {
    const many = Array.from({ length: 620 }, (_, i) => ({ op: 'edit-field', row: i, field: 'value', from: '1', to: '2' }))
    const r = await req('POST', `/api/intake/reports/${target.id}/corrections`, { ops: many, sessionId: 's-big' })
    assert.equal(r.status, 200)
    assert.equal(r.body.stored, 500, `应只收 500 条，实际 ${r.body.stored}`)
    assert.equal(r.body.dropped, 120, `应如实报 dropped=120，实际 ${r.body.dropped}`)
  })

  await it('真实库绝未被动过：data/reports.json 与 data/medbrief.db 的 sha256 前后一致', async () => {
    assert.equal(sha256File(REAL_REPORTS), realShaBefore, '真实 data/reports.json 被改了')
    assert.equal(sha256File(REAL_DB), realDbShaBefore, '真实 data/medbrief.db 被改了')
  })
} finally {
  shutdown()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `报告编辑操作记录：${pass} 通过 / 0 失败` : `报告编辑操作记录：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
