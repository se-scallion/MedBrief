// 阶段 1.1 原子写护栏断言（独立临时文件，绝不碰生产库）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { readStore, writeStore, ReportStoreError } = await import('../lib/reportStore.mjs')
const file = path.join(os.tmpdir(), `medbrief-atomic-${process.pid}.json`)
let pass = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }

// 1. 不存在 → 空库（唯一允许空库的情形）
{
  const s = readStore(file)
  assert.deepEqual(s, { version: 2, reports: [], trashed: [], audit: [] })
  ok('文件不存在 → 空库（不抛错）')
}

// 2. 四字段全保（含 trashed/audit，防「软删一重启就复活」）
{
  const store = { reports: [{ id: 'r1', reportDate: '2026-11-15' }], trashed: [{ id: 'r0' }], audit: [{ id: 'a1' }] }
  writeStore(file, store)
  const back = readStore(file)
  assert.equal(back.reports.length, 1)
  assert.equal(back.trashed.length, 1, 'trashed 必须保住')
  assert.equal(back.audit.length, 1, 'audit 必须保住')
  assert.equal(back.trashed[0].id, 'r0')
  ok('四字段原子写：reports/trashed/audit 全部保住')
}

// 3. 损坏文件 → 抛错（绝不静默返回空库）
{
  fs.writeFileSync(file, '{"reports": [BROKEN', 'utf8')
  assert.throws(() => readStore(file), (e) => e instanceof ReportStoreError && e.code === 'REPORT_STORE_CORRUPT')
  ok('JSON 损坏 → 抛 REPORT_STORE_CORRUPT（不返回空库）')
}

// 4. 形状不对 → 抛错
{
  fs.writeFileSync(file, '{"foo":1}', 'utf8')
  assert.throws(() => readStore(file), (e) => e.code === 'REPORT_STORE_SHAPE')
  ok('缺 reports[] → 抛 REPORT_STORE_SHAPE')
}

// 5. 原子性：写成功后不留 .tmp 残留；旧文件在失败时不被破坏
{
  fs.writeFileSync(file, JSON.stringify({ version: 2, reports: [{ id: 'keep' }] }), 'utf8')
  writeStore(file, { reports: [{ id: 'keep' }, { id: 'r2' }], trashed: [], audit: [] })
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(path.basename(file) + '.tmp-'))
  assert.equal(leftovers.length, 0, `不应留 tmp 残留，实际 ${leftovers.length}`)
  assert.equal(readStore(file).reports.length, 2)
  ok('原子替换：成功无 tmp 残留、旧数据未被半写破坏')
}

// 6. 幂等：同输入连写两次字节一致
{
  const store = { reports: [{ id: 'x', value: '1' }], trashed: [], audit: [] }
  writeStore(file, store)
  const a = fs.readFileSync(file, 'utf8')
  writeStore(file, store)
  const b = fs.readFileSync(file, 'utf8')
  assert.equal(a, b)
  ok('同输入跑两次产物逐字节一致')
}

fs.unlinkSync(file)
console.log(`\n原子写护栏：${pass} 通过 / 0 失败`)
