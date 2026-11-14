// 交互工作台数据契约回归（守「前端点一行要能精确回到原件」这一类联动正确性）
//
// 为什么必须断言（2026-11-14 用户方案 §一.2 + 复核意见）：
//   1. 行身份靠**内容反查**（`name|value|measuredAt`）曾是错的：labClean 会改写 name/value，
//      同报告内同名同值同日两行还会互相覆盖 → 必须源头赋值 `rowKey = reportId:rowIndex` 并全程透传；
//   2. `fileBlobId` 允许为空 —— 实测真实库有 1 份报告没有原件（垃圾记录），
//      所以断言是「hasBlob ? 非空 : 允许空」，不是「每行都必须有」；
//   3. 打印 HTML 必须继续是**纯静态**：交互化只能加 JSON，不许往卡面里塞 <script>。
//
// 运行：node tests/verify-workbench.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildCard } from '../lib/intakeCard.js'

const SNAP = JSON.parse(fs.readFileSync(new URL('./fixtures/card-snapshot-v3.json', import.meta.url), 'utf8'))
const TODAY = new Date('2026-11-14T09:00:00')

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

const card = buildCard({ reports: SNAP.reports, today: TODAY, mask: true })
const byId = new Map(SNAP.reports.map((r) => [r.id, r]))

console.log(`交互工作台数据契约（快照 ${SNAP.reports.length} 份 / ${SNAP.reports.reduce((a, r) => a + (r.rows || []).length, 0)} 行）\n`)

// ---------- 1. 行身份 ----------
it('每一行都带 reportId / rowIndex / rowKey / reportType，且 rowKey 唯一', () => {
  const rows = card.latestRows
  assert.ok(rows.length > 0, '没有指标行')
  for (const r of rows) {
    assert.ok(r.reportId, `缺 reportId：${r.name}`)
    assert.equal(typeof r.rowIndex, 'number', `缺 rowIndex：${r.name}`)
    assert.equal(r.rowKey, `${r.reportId}:${r.rowIndex}`, `rowKey 格式不对：${r.name} → ${r.rowKey}`)
    assert.ok('reportType' in r, `缺 reportType：${r.name}`)
  }
  const keys = rows.map((r) => r.rowKey)
  assert.equal(new Set(keys).size, keys.length, 'rowKey 必须唯一')
})

it('rowIndex 必须能精确回到原报告的那一行（不是靠名字/数值猜）', () => {
  for (const r of card.latestRows) {
    const rep = byId.get(r.reportId)
    assert.ok(rep, `报告不存在：${r.reportId}`)
    assert.ok(Array.isArray(rep.rows) && rep.rows[r.rowIndex], `下标越界：${r.rowKey}`)
  }
})

it('fileBlobId：有原件必须非空；无原件的报告允许为空（hasBlob=false）', () => {
  for (const r of card.latestRows) {
    const rep = byId.get(r.reportId)
    const hasBlob = !!(rep.fileBlobId || (rep.sourceBlobs || []).length)
    if (hasBlob) assert.ok(r.fileBlobId, `报告有原件但行上没有 fileBlobId：${r.rowKey}`)
    else assert.equal(r.fileBlobId, '', `报告没有原件，行上不该编出一个 blobId：${r.rowKey}`)
  }
  // 反向用例：构造一份没有原件的报告
  const noBlob = buildCard({
    reports: [{ id: 'rep_noblob', reportDate: '2026-07-14', rows: [{ name: '白细胞', value: '5.0', unit: '10^9/L', refRange: '3.5-9.5' }] }],
    today: TODAY,
  })
  assert.equal(noBlob.latestRows[0].fileBlobId, '', '无原件时 fileBlobId 必须是空串')
  assert.equal(noBlob.timeline[0].hasBlob, false)
})

// ---------- 2. historyByCode ----------
it('historyByCode：每个指标都在、点按日期升序、每点可回到原件', () => {
  const keys = Object.keys(card.historyByCode)
  assert.ok(keys.length >= 90, `指标数偏少：${keys.length}`)
  for (const k of keys) {
    const h = card.historyByCode[k]
    assert.ok(h.points.length >= 1, `${k} 没有数值点`)
    assert.equal(h.count, h.points.length)
    const dates = h.points.map((p) => p.date)
    assert.deepEqual(dates, [...dates].sort(), `${k} 的点不是按日期升序（左旧右新）`)
    for (const p of h.points) {
      assert.ok(p.reportId, `${k} 的点缺 reportId`)
      assert.ok(p.rowKey, `${k} 的点缺 rowKey`)
      assert.ok('fileBlobId' in p, `${k} 的点缺 fileBlobId 字段`)
    }
  }
})

it('historyByCode 覆盖 latestRows 的每个指标（点开任何一项都能查到历次）', () => {
  for (const r of card.latestRows) {
    const k = r.code || `name:${r.name}`
    const h = card.historyByCode[k] || Object.values(card.historyByCode).find((x) => x.points.some((p) => p.rowKey === r.rowKey))
    assert.ok(h, `latestRows 里的「${r.name}」在 historyByCode 里找不到`)
  }
})

// ---------- 3. timeline ----------
it('timeline：条数 == 报告数、按日期倒序、影像也在（打印版看不到的也要能回看）', () => {
  const t = card.timeline
  assert.equal(t.length, SNAP.reports.length)
  const dates = t.map((x) => x.date).filter(Boolean)
  assert.deepEqual(dates, [...dates].sort().reverse(), 'timeline 必须按日期倒序')
  const img1016 = t.filter((x) => x.date === '2026-10-16' && x.kind === 'imaging')
  assert.ok(img1016.length >= 6, `10-16 的影像应在时间轴上（实测 8 份），实际 ${img1016.length}`)
  for (const x of t) {
    assert.ok(x.summary, '每条都要有摘要')
    assert.equal(typeof x.hasBlob, 'boolean')
    if (x.hasBlob) assert.ok(x.fileBlobId, `hasBlob 为真但没有 fileBlobId：${x.id}`)
  }
})

it('timeline 摘要里的报告单号 / 报告时间从正文提取（同日多份靠它区分）', () => {
  const reports = [
    {
      id: 'rep_t1', reportDate: '2026-10-16', kind: 'imaging', reportType: '磁共振-头颈', fileBlobId: 'f1',
      text: '检查报告详情 项目名称 磁共振-头颈 报告单号 38013293 报告时间 2026-10-16 11:12',
    },
    {
      id: 'rep_t2', reportDate: '2026-10-16', kind: 'imaging', reportType: '磁共振-头颈', fileBlobId: 'f2',
      text: '检查报告详情 项目名称 磁共振-头颈 报告单号 38013294 报告时间 2026-10-16 11:12',
    },
  ]
  const c = buildCard({ reports, today: TODAY })
  const [a, b] = c.timeline
  assert.equal(a.reportNo !== b.reportNo, true, `同日同类型两份必须靠单号区分，实际 ${a.reportNo} / ${b.reportNo}`)
  assert.match(a.reportTime, /2026-10-16 11:12/)
  assert.match(a.itemName, /磁共振/)
})

// ---------- 4. trendAll ----------
it('trendAll：条数 ≥ 打印版 8 条、每项 ≥2 点且点带溯源、日期升序', () => {
  const t = card.trendAll
  assert.ok(t.length >= 8, `可画趋势项偏少：${t.length}`)
  assert.ok(t.length >= card.counts.trends, 'trendAll 必须覆盖打印版那 8 条')
  for (const s of t) {
    assert.ok(s.points.length >= 2, `${s.name} 点数不足 2`)
    const dates = s.points.map((p) => p.measuredAt)
    assert.deepEqual(dates, [...dates].sort(), `${s.name} 的点不是左旧右新`)
    for (const p of s.points) {
      assert.ok(p.reportId, `${s.name} 的点缺 reportId`)
      assert.ok('fileBlobId' in p, `${s.name} 的点缺 fileBlobId`)
    }
  }
})

// ---------- 5. 向后兼容 ----------
it('counts 键只增不减（老前端/MCP 读到的字段不能消失）', () => {
  const required = ['reports', 'rows', 'latest', 'groups', 'p0', 'p1', 'critical', 'trends', 'trendsAll',
    'trendsDropped', 'trendsIncomparable', 'valueConflicts', 'material', 'materialGroups', 'unstructured',
    'missingBasics', 'lastLabDate', 'staleDays', 'shown', 'excluded']
  for (const k of required) assert.ok(k in card.counts, `counts 缺字段：${k}`)
})

// ---------- 6. 打印件必须继续是纯静态 ----------
it('打印 HTML 不得被交互化污染：无 <script>、无交互控件（material 清单例外已删）', () => {
  const html = card.html
  assert.ok(!/<script/i.test(html), '卡面 HTML 里出现了 <script>')
  // 唯一允许的交互是「打印」按钮（.printbar），且它在 @media print 里已被隐藏
  const body = html.replace(/<div class="printbar">[\s\S]*?<\/div>/g, '')
  assert.ok(!/onclick=/i.test(body), '除 .printbar 打印按钮外，卡面不得有 onclick')
  assert.ok(/@media print \{ \.printbar \{ display: none/.test(html), '打印时 .printbar 必须被隐藏')
  assert.ok(!/\.ant-/.test(html), '卡面 HTML 里混进了 antd 的 class（说明把前端组件渲进打印件了）')
  // 打印件仍必须是 3 段分页
  assert.ok(/\.page1/.test(html) && /\.page2/.test(html) && /\.page3/.test(html))
})

console.log(`\n${'='.repeat(46)}`)
console.log(`交互工作台数据契约：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { console.log(`失败：${fails.join('、')}`); process.exit(1) }
