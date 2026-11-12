#!/usr/bin/env node
// MCP server 冒烟：真起一个子进程，按 MCP stdio 协议走 initialize → tools/list → tools/call。
// 不做协议库、不发网络包到别处；只与本机 MedBrief（:5174）交互。
//
// 运行：node mcp/smoke-test.mjs [/tmp/fake-lab-report.png]
// 退出码：任一断言失败 → 1。会往 data/reports.json 写 1 条**测试记录**，测完按 id 精确删除。

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IMG = process.argv[2] || '/tmp/fake-lab-report.png'

let failed = 0
const ok = (m) => console.log('PASS ', m)
const bad = (m) => { failed++; console.log('FAIL ', m) }

const child = spawn(process.execPath, [join(HERE, 'intake-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
let seq = 0
child.stdout.setEncoding('utf8')
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const r = pending.get(msg.id)
    if (r) { pending.delete(msg.id); r(msg) }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => process.env.MCP_DEBUG && process.stderr.write(d))

const rpc = (method, params) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, res)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} 超时`)) } }, 180000)
  })

const callTool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args })
  const text = r.result?.content?.[0]?.text || '{}'
  return { isError: !!r.result?.isError, data: JSON.parse(text) }
}

try {
  // 1. initialize
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  init.result?.serverInfo?.name === 'medbrief-intake' && init.result?.capabilities?.tools
    ? ok(`initialize 通过（${init.result.serverInfo.name} v${init.result.serverInfo.version}）`)
    : bad(`initialize 返回不对：${JSON.stringify(init).slice(0, 200)}`)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // 2. tools/list
  const list = await rpc('tools/list', {})
  const names = (list.result?.tools || []).map((t) => t.name)
  names.length === 8 && names.every((n) => n.startsWith('intake_'))
    ? ok(`tools/list 返回 ${names.length} 个工具：${names.join(', ')}`)
    : bad(`tools/list 异常：${names.join(',')}`)
  const noSchema = (list.result?.tools || []).filter((t) => !t.inputSchema)
  noSchema.length ? bad(`有工具缺 inputSchema：${noSchema.map((t) => t.name)}`) : ok('每个工具都带 inputSchema')

  // 3. 识别真图（走 8008）
  const ocr = await callTool('intake_ocr_image', { imagePath: IMG })
  ocr.data.ok && ocr.data.rowCount === 12
    ? ok(`intake_ocr_image：${ocr.data.rowCount} 行，raw ${ocr.data.rawRowCount}，切块 ${ocr.data.preprocessing.chunked}，deskew ${ocr.data.preprocessing.deskewed}`)
    : bad(`intake_ocr_image 异常：${JSON.stringify(ocr.data).slice(0, 200)}`)

  // 4. 纯文本解析
  const parsed = await callTool('intake_parse_text', { text: '白细胞\t6.83\t10^9/L\t3.5-9.5\t正常' })
  parsed.data.ok && parsed.data.rowCount >= 1 ? ok(`intake_parse_text：${parsed.data.rowCount} 行`) : bad(`intake_parse_text 异常：${JSON.stringify(parsed.data)}`)

  // 5. 身份字段必须被拒（红线）
  const rej = await callTool('intake_save_report', { text: 'x', meta: { reportDate: '2026-11-12', phone: '13200000000' } })
  rej.isError && /身份类字段/.test(rej.data.error) ? ok('intake_save_report 拒绝身份类字段（红线生效）') : bad(`身份字段没被拒：${JSON.stringify(rej.data)}`)

  // 6. 入库（测试记录，随后按 id 删）
  const save = await callTool('intake_save_report', {
    rows: ocr.data.rows,
    imagePath: IMG,
    meta: { kind: '血常规', reportDate: '2026-11-12', hospital: '本部（工体南路）', patientName: 'MCP冒烟' },
  })
  save.data.ok && save.data.reportId ? ok(`intake_save_report：入库 ${save.data.reportId}（${save.data.rowCount} 行，总计 ${save.data.total}）`) : bad(`入库失败：${JSON.stringify(save.data)}`)

  // 7. 重复检测（不带 force 应报 duplicate，且指出像哪张）
  const dup = await callTool('intake_save_report', {
    rows: ocr.data.rows,
    imagePath: IMG,
    meta: { kind: '血常规', reportDate: '2026-11-12', hospital: '本部（工体南路）', patientName: 'MCP冒烟' },
  })
  dup.data.ok === false && dup.data.duplicate === true
    ? ok(`重复检测生效：kind=${dup.data.kind}，指向 ${dup.data.ofReportId}，附 nextStep`)
    : bad(`重复检测失效：${JSON.stringify(dup.data).slice(0, 200)}`)

  // 8. 出卡
  const card = await callTool('intake_get_card', { mask: true })
  card.data.ok && card.data.masked === true && card.data.htmlBytes > 500 && card.data.htmlPath
    ? ok(`intake_get_card：脱敏=${card.data.masked}，HTML ${card.data.htmlBytes} B → ${card.data.htmlPath}`)
    : bad(`出卡异常：${JSON.stringify(card.data).slice(0, 200)}`)
  try { readFileSync(card.data.htmlPath) } catch { /* 文件不存在也不算致命 */ }

  // 9. 档案读取
  const pat = await callTool('intake_get_patient', {})
  pat.data.ok ? ok(`intake_get_patient：${pat.data.patient?.name || '(空档案)'}`) : bad('intake_get_patient 失败')

  // 清理：按 id 精确删自己写的测试记录
  if (save.data.reportId) {
    const f = join(ROOT, 'data', 'reports.json')
    const j = JSON.parse(readFileSync(f, 'utf8'))
    const before = j.reports.length
    j.reports = j.reports.filter((r) => r.id !== save.data.reportId)
    writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
    ok(`清理测试记录：${before} → ${j.reports.length} 条`)
  }
} catch (e) {
  bad(`异常：${e.message}`)
} finally {
  child.stdin.end()
  child.kill()
  console.log(failed ? `\n${failed} 项失败` : '\nMCP 冒烟全部通过')
  process.exit(failed ? 1 : 0)
}
