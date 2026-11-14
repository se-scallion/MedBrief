#!/usr/bin/env node
// 回填报告类型（幂等，默认 dry-run）—— 用 lib/reportClassify.mjs 从内容推断 kind/reportType
//
// 为什么要有：类型推断是 2026-11-14 才接进入库路径的，**之前入库的**记录不会自动补。
// 实测库里 55 份有 1 份（rep_mwg22hwaloc，心脏彩超截图）`reportType` 空、`kind` 走默认 'lab' ——
// 一份超声被当成化验单，列表里看不出类型，资料卡也按 lab 处理。
//
// 口径：
//   · **只补空值**：已有 reportType 的一律不碰（人工填的、适配器给的都是权威）；
//   · 写 `reportTypeInferred: true` + `inferEvidence`，并进 `patchLog`（可审计、可回滚）；
//   · 不改 rows / text / 日期等任何其他字段；
//   · 默认 dry-run，只打印计划；`--apply` 才写盘，写前留 `.bak-<ts>`。
//
// 用法：
//   node tools/backfill-report-type.mjs            # 只看计划
//   node tools/backfill-report-type.mjs --apply    # 真写
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyReport } from '../lib/reportClassify.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'data', 'reports.json')
const APPLY = process.argv.includes('--apply')

const store = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const reports = store.reports || []
const plan = []

for (const r of reports) {
  if (String(r.reportType || '').trim()) continue          // 已有类型 → 不碰
  const cls = classifyReport({ text: r.text || '', rows: r.rows || [], kind: r.kind || '', reportType: '' })
  if (!cls.inferred) continue                              // 判不出来就留空（不硬猜）
  plan.push({ id: r.id, from: { kind: r.kind || '', reportType: '' }, to: { kind: cls.kind, reportType: cls.reportType }, evidence: cls.evidence })
}

console.log(`报告类型回填：${reports.length} 份中待补 ${plan.length} 份${APPLY ? '（APPLY）' : '（dry-run，未写盘）'}`)
for (const p of plan) console.log(`  - ${p.id}  kind ${p.from.kind || '(空)'} → ${p.to.kind} ｜ 类型 → ${p.to.reportType} ｜ 依据 ${p.evidence}`)

if (!plan.length) { console.log('没有需要回填的记录。'); process.exit(0) }
if (!APPLY) { console.log('\n加 --apply 才会写盘。'); process.exit(0) }

const bak = `${FILE}.bak-${Date.now()}`
fs.writeFileSync(bak, JSON.stringify(store, null, 2))
const at = new Date().toISOString()
for (const p of plan) {
  const r = reports.find((x) => x.id === p.id)
  r.kind = p.to.kind
  r.reportType = p.to.reportType
  r.reportTypeInferred = true
  r.inferEvidence = p.evidence
  r.patchLog = Array.isArray(r.patchLog) ? r.patchLog : []
  r.patchLog.push({ at, field: 'reportType', from: p.from.reportType, to: p.to.reportType, reason: `按内容推断（${p.evidence}）`, by: 'tools/backfill-report-type.mjs' })
  if (p.from.kind !== p.to.kind) r.patchLog.push({ at, field: 'kind', from: p.from.kind, to: p.to.kind, reason: '按内容推断', by: 'tools/backfill-report-type.mjs' })
}
fs.writeFileSync(FILE, JSON.stringify(store, null, 2))
console.log(`\n✅ 已写 ${plan.length} 条；备份 ${bak}`)
