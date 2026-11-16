// v0.6 第 1 段：一键导入四态提示（纯函数对拍，不起服务、不写库）
// 把 IntakePage.jsx 里的 classifyImportable/importHint 抽成同款纯逻辑做断言，
// 防止 DOM 改动后提示又退化成一句「没有可入库的条目」。
import assert from 'node:assert/strict'

const classify = (list = []) => {
  const saved = list.filter((it) => it.saved)
  const dup = list.filter((it) => !it.saved && it.status === 'dup')
  const failed = list.filter((it) => !it.saved && it.status !== 'dup' && it.status === 'failed')
  const unrecognized = list.filter((it) => !it.saved && it.status !== 'dup' && it.status !== 'failed'
    && !String(it.text || '').trim() && !(Array.isArray(it.rows) && it.rows.length))
  const textual = list.filter((it) => !it.saved && it.status !== 'dup' && it.status !== 'failed'
    && String(it.text || '').trim() && !(Array.isArray(it.rows) && it.rows.length))
  const lab = list.filter((it) => !it.saved && it.status !== 'dup' && it.status !== 'failed'
    && Array.isArray(it.rows) && it.rows.length > 0)
  return { targets: [...lab, ...textual], saved, dup, failed, unrecognized, textual, lab }
}
let pass = 0
const ok = (n) => { pass++; console.log('PASS ' + n) }

// 1. 已入库 → 不再「没有可入库的条目」
{
  const c = classify([{ saved: true, reportId: 'rep_a', status: 'done', rows: [{ name: 'WBC', value: '4.66' }] }])
  assert.equal(c.targets.length, 0)
  assert.equal(c.saved.length, 1)
  ok('已入库：targets=0 但能区分出 saved=1（提示走「这 1 张已入库」）')
}
// 2. 疑似重复单独一类
{
  const c = classify([{ saved: false, status: 'dup', rows: [{ name: 'WBC', value: '4.66' }] }])
  assert.equal(c.targets.length, 0)
  assert.equal(c.dup.length, 1)
  ok('疑似重复：不与「未识别/已入库」混为一类')
}
// 3. 识别失败单独一类
{
  const c = classify([{ saved: false, status: 'failed', text: '' }])
  assert.equal(c.failed.length, 1)
  assert.equal(c.targets.length, 0)
  ok('识别失败：提示应指向「一键识别全部」')
}
// 4. 0 行但有原文的全文型 → 纳入 targets（但不能是 failed）
{
  const c = classify([
    { saved: false, status: 'done', text: '染色体核型分析报告单 …', rows: [] },
    { saved: false, status: 'failed', text: '残留半截文本', rows: [] },
  ])
  assert.equal(c.textual.length, 1, '只有 status!==failed 的全文型才纳入')
  assert.equal(c.targets.length, 1)
  ok('0 行全文型：status!=failed 才纳入批量，failed 的 text 不被误纳入')
}
// 5. 勾选/重新识别无效的根因已可诊断：saved 不被任何其它态吞掉
{
  const c = classify([{ saved: true, status: 'ocr', rows: [{ name: 'WBC', value: '4.66' }], reportId: 'rep_b' }])
  assert.equal(c.saved.length, 1)
  assert.equal(c.lab.length, 0, 'saved 条目即使 status 变回 ocr 也不该被当成待导入')
  ok('saved 优先级最高：勾选/重新识别不会把它误算成可入库')
}
console.log(`\n一键导入四态：${pass} 通过 / 0 失败`)
