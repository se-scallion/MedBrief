#!/usr/bin/env node
// 报告类型识别「路径覆盖」只读探针（诊断，不是闸门）
//
// 为什么要有：`tests/verify-library.mjs` 只用 `classifyByTitle` 量了**第一段路径**的覆盖
// （标题 35/95），却把失败文案写成「类型识别对真实数据不可用」—— 而真实机制是三步
// （标题 → 项目集反推 → 正文兜底，`lib/reportTypeDetect.mjs:200 detectReportType`）。
// 缺的是**端到端**测量，不是"测试坏了"。本探针把三段路径分别量一遍，供台账取证。
//
// 口径（与 tests/verify-library.mjs 一致，勿擅自改）：
//   A = classifyByTitle(text)                                  标题路径
//   B = A || classifyByRows(rows, idx)                         标题 ∪ 项目集（全 95 口径）
//   B′=同一个式子，但分母只算「有指标行」的报告（= verify-library:147 的 continue 口径）
//   C = detectReportType(text, rows, { rowIndex, bodyClassify: classifyReport })   端到端
//
// 铁律：
//   · **只读**。本脚本不写任何库（跑完用 sha256 前后比对自证，不一致即 exit 2）。
//   · **不下结论**。`C` 的不符项只列「库内标注 vs 判出类型 + 证据」，到底该改库标注还是改词表
//     由报告识别一线拿原件判，本脚本不替它拍。
//   · **不假绿**：`C` 有不符即 exit 1（这不是"覆盖率低"，是错判）。
//
// 用法：node tools/type-coverage-report.mjs [--json]
//   环境变量 MEDBRIEF_REPORTS_FILE 可指向副本库（默认 data/reports.json，只读）。

import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyByTitle, buildTypeRowIndex, classifyByRows, detectReportType } from '../lib/reportTypeDetect.mjs'
import { classifyReport } from '../lib/reportClassify.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = process.env.MEDBRIEF_REPORTS_FILE || path.join(ROOT, 'data/reports.json')
const asJson = process.argv.includes('--json')

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

let before
try {
  before = fs.readFileSync(FILE)
} catch (e) {
  console.log(`SKIP 读不到报告库：${FILE}（${e.code || e.message}）`)
  process.exit(2)
}
const beforeSha = sha(before)

const parsed = JSON.parse(String(before))
const reports = Array.isArray(parsed) ? parsed : parsed.reports || []
const withText = reports.filter((r) => String(r.text || '').trim())
const withRows = reports.filter((r) => Array.isArray(r.rows) && r.rows.length)
const idx = buildTypeRowIndex(reports)

// 一条路径一个 tally：返回覆盖数、不符明细、未认出明细
function tally(list, pick) {
  let covered = 0
  const bad = []
  const unknown = []
  for (const r of list) {
    const got = pick(r)
    if (!got || !got.reportType) {
      unknown.push(r.id)
      continue
    }
    covered++
    if (got.reportType !== r.reportType) {
      bad.push({ id: r.id, stored: r.reportType, got: got.reportType, evidence: got.evidence || null, kind: got.kind || null })
    }
  }
  return { total: list.length, covered, bad, unknown }
}

const e2ePick = (r) => detectReportType(r.text, r.rows, { rowIndex: idx, bodyClassify: classifyReport })

const A = tally(withText, (r) => classifyByTitle(r.text))
const B = tally(withText, (r) => classifyByTitle(r.text) || classifyByRows(r.rows, idx))
const Bprime = tally(withRows, (r) => classifyByTitle(r.text || '') || classifyByRows(r.rows, idx))
const C = tally(withText, e2ePick)

const afterSha = sha(fs.readFileSync(FILE))
const unchanged = beforeSha === afterSha

const rows = [
  ['A  标题路径    classifyByTitle', A],
  ['B  标题∪项目集（全库口径）', B],
  ["B′ 标题∪项目集（仅算有指标行 = verify-library 口径）", Bprime],
  ['C  端到端（标题→项目集→正文兜底）', C],
]

if (asJson) {
  console.log(JSON.stringify({ file: FILE, reports: reports.length, withText: withText.length, withRows: withRows.length, A, B, Bprime, C, libraryShaUnchanged: unchanged }, null, 2))
} else {
  console.log(`报告库：${FILE}`)
  console.log(`总量：${reports.length} 份 · 带正文 ${withText.length} · 有指标行 ${withRows.length}`)
  console.log('')
  for (const [name, t] of rows) {
    const extra = t.bad.length ? ` · 不符 ${t.bad.length}` : ' · 不符 0'
    console.log(`${name.padEnd(46)} 覆盖 ${t.covered}/${t.total}${extra} · 未认出 ${t.unknown.length}`)
  }
  if (C.bad.length) {
    console.log('')
    console.log(`C 不符明细（${C.bad.length} 条，归属：报告识别一线，需拿原件核「库标注错」还是「词表/序错」）`)
    for (const b of C.bad) console.log(`  - ${b.id}  库内=${b.stored} → 判出=${b.got}  证据=${b.evidence}`)
  }
  if (C.unknown.length) console.log(`\nC 未认出 id：${C.unknown.join(', ')}`)
  console.log('')
  console.log(`只读自证：报告库 sha256 ${unchanged ? '前后一致 ✓' : '前后不一致 ✗（有东西写了库）'}`)
}

if (!unchanged) process.exit(2)
process.exit(C.bad.length ? 1 : 0)
