#!/usr/bin/env node
// P15 门禁自检（规格 .agents/reports-panel-ui-1117-spec.md v1.2 P15）：
// 逐个跑 verify-reports-panel-ui.mjs 的 --falsify 开关——必须 exit 1（真红），
// 无参模式必须 exit 0（全绿）。任何一条不符 = 判据恒绿/门禁坏掉 = 判不合格。
// 运行：node tests/verify-reports-panel-ui-selfcheck.mjs
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const GATE = path.join(ROOT, 'tests/verify-reports-panel-ui.mjs')
const FALSIFIERS = ['P1', 'P2', 'P4', 'P6', 'P12', 'P14', 'headers', '401']

const run = (args) => spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 })

const results = []
// 无参：必须全绿 exit 0
const normal = run([])
results.push({ name: '无参门禁全绿', ok: normal.status === 0, detail: `exit=${normal.status}` })
// 每条证伪：必须 exit 1（真红）
for (const f of FALSIFIERS) {
  const r = run([`--falsify=${f}`])
  results.push({ name: `证伪 ${f} 真红`, ok: r.status === 1, detail: `exit=${r.status} · ${(r.stdout || '').split('\n')[0]}` })
}

let bad = 0
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' · ' + r.detail : ''}`)
  if (!r.ok) bad++
}
console.log(`\nP15 门禁自检：${results.length - bad} 通过 / ${bad} 失败（${FALSIFIERS.length} 条证伪 + 1 条全绿）`)
process.exit(bad ? 1 : 0)
