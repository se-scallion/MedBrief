// M3 观测件断言（独立临时文件，绝不碰生产计数）：append-only、并发不丢、按天聚合、门禁语义。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const file = path.join(os.tmpdir(), `medrec-hits-${process.pid}.jsonl`)
const M = await import(`../lib/recognitionHits.mjs?f=${process.pid}`)
let pass = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }

// 1. 时区与空文件
{
  assert.equal(M.dayKey(new Date('2026-11-15T16:30:00Z')), '2026-11-16', 'UTC+8 跨天必须按本地日算')
  const s = M.summary({ file, days: 3, now: new Date('2026-11-15T12:00:00Z') })
  assert.equal(s.lines, 0)
  assert.equal(s.retireGate, false, '没数据时不能判"0 命中可退役"')
  assert.ok(s.retireNote, '必须显式说明「不是 0 命中，是没数据」')
  ok('dayKey 按 UTC+8 分天；无数据 ≠ 0 命中（retireGate=false）')
}

// 2. append-only + 并发不丢（40 路同时写）
{
  const now = new Date('2026-11-15T04:00:00Z') // 本地 12:00，同一天
  await Promise.all(Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() =>
    M.bump({ side: i % 2 ? 'medbrief' : 'meddata', route: '/api/intake/ocr', backend: i % 3 === 0 ? 'legacy' : '8011', kind: 'ocr' }, { file, now })
  )))
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 40, `并发 40 次必须 40 行，实际 ${lines.length}（read-modify-write 会丢）`)
  assert.ok(lines.every((l) => JSON.parse(l).day === '2026-11-15'), '全部落在同一天')
  ok('append-only：40 路并发写一行不丢（F9 并发写冲突已规避）')
}

// 3. 聚合与门禁
{
  const now = new Date('2026-11-15T12:00:00Z')
  const s = M.summary({ file, days: 1, now })
  assert.equal(s.days[0].total, 40)
  assert.equal(s.days[0].legacy, 14, `legacy 应为 14（0,3,6…39），实际 ${s.days[0].legacy}`)
  assert.equal(s.days[0].svc, 26)
  assert.equal(s.lastNDaysLegacy, 14)
  assert.equal(s.retireGate, false, '有 legacy 命中时绝不许判可退役')
  assert.equal(s.days[0].legacyByRoute['meddata:/api/intake/ocr:ocr'] > 0, true)
  ok('聚合：total 40 / legacy 14 / svc 26 · retireGate=false · legacyByRoute 可定位到具体入口')
}
{
  // 只有 svc 命中的新文件 → 0 legacy 才允许退役
  const clean = path.join(os.tmpdir(), `medrec-hits-clean-${process.pid}.jsonl`)
  const now = new Date('2026-11-15T12:00:00Z')
  M.bump({ side: 'medbrief', route: '/api/intake/ocr', backend: '8011' }, { file: clean, now })
  const s = M.summary({ file: clean, days: 7, now, minSamples: 1 })
  assert.equal(s.lastNDaysLegacy, 0)
  assert.equal(s.retireGate, false, '只有 1 天有观测 → 不能判通过（必须 7 天都有数据）')
  assert.ok(s.retireNote.includes('天有观测'), '必须说明「只有 N 天有观测」')
  // 造满 7 天、每天 ≥1 次且全 svc → 门禁才通过
  for (let i = 0; i < 7; i++) {
    M.bump({ side: 'medbrief', route: '/api/intake/ocr', backend: '8011' },
      { file: clean, now: new Date(now.getTime() - i * 86400 * 1000) })
  }
  const full = M.summary({ file: clean, days: 7, now, minSamples: 7 })
  assert.equal(full.observedDays, 7)
  assert.equal(full.lastNDaysLegacy, 0)
  assert.equal(full.retireGate, true, '7 天都有观测、0 legacy、样本够 → 门禁通过')
  const few = M.summary({ file: clean, days: 7, now, minSamples: 100 })
  assert.equal(few.retireGate, false, '样本量不足时仍不许通过')
  ok('门禁语义：7 天全覆盖 + 0 legacy + 样本达标才 true；单日/样本不足都不通过')
  fs.unlinkSync(clean)
}

fs.unlinkSync(file)
console.log(`\nM3 观测件：${pass} 通过 / 0 失败`)
