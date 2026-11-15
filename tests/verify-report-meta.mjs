// 报告元信息推断门禁（2026-11-15）：日期/条码/医院，口径照 MedData parseDoc.js
// 跑法：node tests/verify-report-meta.mjs
import assert from 'node:assert/strict'
import { extractDocDates, guessBarcode, guessHospital, guessMeta } from '../lib/reportMeta.mjs'

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

it('标签优先：采样/报告两个标签都在 → date=采样、reportedAt=报告（打印时间不得被当成报告日期）', () => {
  const t = '检验报告单\n采样时间 2026-10-10 16:14\n报告时间：2026-10-16 15:13\n打印时间 2026-11-15 09:00'
  const r = extractDocDates(t)
  assert.equal(r.date, '2026-10-10')
  assert.equal(r.reportedAt, '2026-10-16 15:13')
  assert.equal(r.source, 'label-both')
})

it('只有报告标签 → reportDate 用它；只有采样标签 → 也用它', () => {
  assert.equal(extractDocDates('报告日期：2026-10-16').date, '2026-10-16')
  assert.equal(extractDocDates('采集日期 2026.10.10').date, '2026-10-10')
})

it('骨穿/病理的「采取/取材/回报」写法要被认（旧实现只认「采样」会漏）', () => {
  const a = extractDocDates('采取日期 2026.10.10\n回报日期 2026.10.12')
  assert.equal(a.date, '2026-10-10')
  assert.equal(a.reportedAt, '2026-10-12')
  const b = extractDocDates('取材时间：2026年8月5日')
  assert.equal(b.date, '2026-08-05')
})

it('无标签但带时分 → 第一个当检查、最后一个不同者当报告', () => {
  const r = extractDocDates('2026-10-10 16:14 采样\n2026-10-16 15:13 发出')
  assert.equal(r.date, '2026-10-10')
  assert.equal(r.reportedAt, '2026-10-16 15:13')
  assert.equal(r.source, 'fallback-time')
})

it('无标签仅日期 → 第一个为检查、最后一个不同日期为报告', () => {
  const r = extractDocDates('2026-10-10 ... 2026-10-16')
  assert.equal(r.date, '2026-10-10')
  assert.equal(r.reportedAt, '2026-10-16')
})

it('没有日期 → 空值，不猜', () => {
  const r = extractDocDates('本报告仅作参考')
  assert.equal(r.date, '')
  assert.equal(r.reportedAt, '')
  assert.equal(r.source, 'none')
})

it('条码 / 医院：只认明确形态，不瞎认', () => {
  assert.equal(guessBarcode('检测条码(Barcode)：V02008911352'), 'V02008911352')
  assert.equal(guessBarcode('单号 20260714G0116021'), '20260714G0116021')  // 8位+G+6位以上 都要认（真实报告单号就是这个形态）
  assert.equal(guessBarcode('单号 20260701G0000000'), '20260701G0000000')
  assert.equal(guessHospital('乌鲁木齐康圣达医学检验实验室'), '乌鲁木齐康圣达医学检验实验室')
  assert.equal(guessHospital('科室 血液科病区'), '')
})

it('guessMeta：报告日期字段取「报告时间」，采样另存 sampledAt', () => {
  const m = guessMeta('采样时间 2026-10-10 16:14\n报告时间 2026-10-16 15:13\n条码 V02008911352\n某某市人民医院', [])
  assert.equal(m.reportDate, '2026-10-16')
  assert.equal(m.sampledAt, '2026-10-10 16:14')
  assert.equal(m.barcode, 'V02008911352')
  assert.equal(m.hospital, '某某市人民医院')
  assert.equal(m.dateSource, 'label-both')
})

it('guessMeta：识别不出任何字段时返回 null（前端就不会乱填）', () => {
  assert.equal(guessMeta('无任何可识别信息', []), null)
})

console.log(`\n${'='.repeat(46)}`)
console.log(`报告元信息推断：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { console.log('失败：' + fails.join('、')); process.exit(1) }
