// 报告行修正载荷回归（守「只改 value 会永久丢掉参考区间」这一类静默数据损失）
//
// 背景（2026-11-14 用户质疑 → 实测确认）：
//   三列左移的存储行 `{name:"凝血酶原时间（P12.2个T）", value:"9.8-12.1", refRange:"sec"}`
//   靠 labClean 的读侧还原才能显示成 `PT / 12.2 / sec / 参考 9.8-12.1`。
//   若「修正数值」只提交 value=12.2：左移还原不再触发，参考区间在存储里没有第二份 → 永久丢失。
// 不变量：任何写入都必须提交 name / value / unit / refRange 四元组。
//
// 运行：node tests/verify-rowpatch.mjs

import assert from 'node:assert/strict'
import { buildRowPatch } from '../web/src/pages/intake/shared.js'
import { normalizeRow } from '../lib/labClean.mjs'
import { judgeFlag } from '../lib/intakeCard.js'

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

console.log('报告行修正载荷（四元组回写）\n')

it('载荷必须永远带 name / value / unit / refRange 四个字段（缺一即视为半写）', () => {
  const rows = [
    { name: '凝血酶原时间（PT）', value: '12.2', unit: 'sec', refRange: '9.8-12.1' },
    { name: '白细胞', value: '3.27', unit: '10^9/L', refRange: '3.5-9.5' },
  ]
  const patch = buildRowPatch(rows)
  assert.equal(patch.length, 2)
  for (const p of patch) {
    for (const f of ['index', 'name', 'value', 'unit', 'refRange']) {
      assert.ok(f in p, `缺少字段 ${f}：${JSON.stringify(p)}`)
    }
  }
  assert.deepEqual(patch.map((p) => p.index), [0, 1], 'index 必须等于行在报告里的下标（patch 端点按它定位）')
})

it('左移行：只写 value 会丢参考区间（反例固定住），四元组回写则完整保留', () => {
  const stored = { name: '凝血酶原时间（P12.2个T）', value: '9.8-12.1', refRange: 'sec', measuredAt: '2026-07-14' }
  const view = normalizeRow(stored)
  assert.equal(view.value, '12.2')
  assert.equal(view.unit, 'sec')
  assert.equal(view.refRange, '9.8-12.1', '读侧应还原出参考区间')

  // 反例：只落 value
  const halfWritten = normalizeRow({ ...stored, value: view.value, verified: true })
  assert.equal(halfWritten.refRange, '', '只写 value 时参考区间确实会变成空（这就是必须整行回写的原因）')

  // 正例：四元组回写（用 buildRowPatch 生成载荷里的四字段）
  const p = buildRowPatch([view])[0]
  const full = normalizeRow({ name: p.name, value: p.value, unit: p.unit, refRange: p.refRange, verified: true })
  assert.equal(full.name, '凝血酶原时间（PT）')
  assert.equal(full.value, '12.2')
  assert.equal(full.unit, 'sec')
  assert.equal(full.refRange, '9.8-12.1', '四元组回写后参考区间必须保住')
  assert.deepEqual(full.repaired, [], '固化后不该再依赖读侧还原（repaired 应为空）')
})

it('单边参考区间经四元组回写后仍能判高低（`<125` / `>450`）', () => {
  const cases = [
    [{ name: '前体NT-proBNP', value: '3182.00', unit: 'pg/ml', refRange: '<125' }, 'high'],
    [{ name: '某项目', value: '100', unit: 'x', refRange: '<125' }, 'normal'],
    [{ name: '某项目', value: '100', unit: 'x', refRange: '>450' }, 'low'],
    [{ name: '某项目', value: '900', unit: 'x', refRange: '>=450' }, 'normal'],
  ]
  for (const [row, want] of cases) {
    const p = buildRowPatch([row])[0]
    const n = normalizeRow({ name: p.name, value: p.value, unit: p.unit, refRange: p.refRange, verified: true })
    assert.equal(judgeFlag(n), want, `${row.value} vs ${row.refRange} 应判为 ${want}`)
  }
})

it('空值行不得被补成假值：空字段原样传空串（不写 null / undefined / 0）', () => {
  const p = buildRowPatch([{ name: '某项目' }])[0]
  assert.equal(p.value, '')
  assert.equal(p.unit, '')
  assert.equal(p.refRange, '')
})

console.log(`\n${'='.repeat(46)}`)
console.log(`报告行修正载荷：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { console.log(`失败：${fails.join('、')}`); process.exit(1) }
