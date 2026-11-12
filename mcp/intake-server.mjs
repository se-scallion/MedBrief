#!/usr/bin/env node
// MedBrief 资料导入 · MCP server（stdio，零依赖，零协议库）
//
// 目的：让任何支持 MCP 的 AI 客户端直接「把检查单塞进 MedBrief」——
//   拍/传一张图 → 识别 → 解析成指标行 → 入库（含查重）→ 出给门诊医生看的一页资料卡。
//
// 边界（与产品口径一致）：
//   - 本进程**只做通路**，不复制任何识别/切块/去重算法；所有能力都转发给本机 MedBrief HTTP 接口
//     （node server.mjs，默认 http://127.0.0.1:5174）。
//   - 不落盘身份信息：病友档案的 idCard / phone / address 由后端丢弃，这里也不接受这三个字段。
//   - 不编造临床事实：识别不出就是空行 + 明确的 ok:false，绝不填默认值。
//
// 协议：MCP stdio = **换行分隔的 JSON-RPC 2.0**（不是 LSP 的 Content-Length 头）。
//   stdout 只允许输出协议消息；所有日志一律走 stderr，否则客户端会解析失败。
//
// 用法：node mcp/intake-server.mjs        （环境变量 MEDBRIEF_URL 可改后端地址）

import { readFileSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.env.MEDBRIEF_URL || 'http://127.0.0.1:5174').replace(/\/+$/, '')
const SERVER_INFO = { name: 'medbrief-intake', version: '1.0.0' }
const PROTOCOL_FALLBACK = '2024-11-05'
const log = (...a) => console.error('[medbrief-mcp]', ...a)

// ---------------- 图片读写 ----------------

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/** 本地图片路径 → dataUrl。AI 客户端给的多是路径（它自己没法 base64 大图）。 */
function fileToDataUrl(p) {
  const abs = resolve(String(p))
  const mime = MIME[extname(abs).toLowerCase()]
  if (!mime) throw new Error(`不支持的图片格式：${extname(abs) || '(无扩展名)'}（支持 png/jpg/jpeg/webp/gif）`)
  return `data:${mime};base64,${readFileSync(abs).toString('base64')}`
}

/** 任何「路径 / dataUrl / {path} / {dataUrl}」都归一成 dataUrl。 */
function toDataUrl(input) {
  if (input && typeof input === 'object') return toDataUrl(input.dataUrl || input.path || input.imagePath || input.image)
  const s = String(input || '')
  if (s.startsWith('data:image/')) return s
  if (!s) throw new Error('缺少图片：请给 imagePath（本地文件路径）或 dataUrl')
  return fileToDataUrl(s)
}

function dataUrlToFile(dataUrl, name = `medbrief-${Date.now().toString(36)}.png`) {
  const m = String(dataUrl).match(/^data:image\/([a-z+]+);base64,(.*)$/i)
  if (!m) throw new Error('dataUrl 格式不对')
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg')
  const out = join(tmpdir(), name.replace(/\.[a-z]+$/i, '') + '.' + ext)
  writeFileSync(out, Buffer.from(m[2], 'base64'))
  return out
}

// ---------------- HTTP 转发 ----------------

async function request(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Number(process.env.MEDBRIEF_TIMEOUT_MS) || 180000),
  })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${method} ${path} 返回非 JSON（HTTP ${r.status}）：${text.slice(0, 200)}`)
  }
  return { status: r.status, json }
}

/** 后端把「重复 / 未识别 / 上游不可用」都表达成 HTTP 200 + ok:false，这里原样透出，不抛错。 */
async function call(path, body) {
  const { json } = await request(body ? 'POST' : 'GET', path, body)
  return json
}

// ---------------- 工具实现 ----------------
//
// 每个工具输出都刻意「瘦」：大字段（原文 text、资料卡 html）默认折叠或落盘，
// 避免把几十 KB 塞进对话上下文，把 AI 的注意力从「数值与判定」上挤走。

const tools = {
  async intake_ocr_image(args = {}) {
    // imagePaths 多张时先拼接（手机把一张单拍成两张的常见情形），再识别。
    let dataUrl
    let stitchInfo = null
    const paths = Array.isArray(args.imagePaths) ? args.imagePaths : null
    if (paths && paths.length > 1) {
      const st = await call('/api/intake/stitch', { images: paths.map(toDataUrl) })
      if (!st.ok) throw new Error(`拼接失败：${st.error || '未知原因'}`)
      dataUrl = st.dataUrl
      stitchInfo = { width: st.width, height: st.height, count: st.count }
    } else {
      dataUrl = toDataUrl(paths && paths.length === 1 ? paths[0] : args.imagePath || args.dataUrl)
    }
    const stitched = paths && paths.length > 1 ? true : Boolean(args.stitched)
    const j = await call('/api/intake/ocr', stitched ? { image: dataUrl, stitched: true } : { image: dataUrl })
    if (!j.ok) {
      // 显式「未识别」：不返回空表让上层误以为「这项没做」
      return {
        ok: false,
        recognized: false,
        unavailable: !!j.unavailable,
        reason: j.reason || j.error || '识别服务返回空',
        hint: '可改用 intake_parse_text 直接喂报告文本',
      }
    }
    const out = {
      ok: true,
      recognized: true,
      rows: j.rows || [],
      rowCount: (j.rows || []).length,
      rawRowCount: j.rawRowCount ?? null,
      stitches: stitchInfo,
      stitchedDeduped: j.stitchedDeduped ?? 0,
      // 预处理链的留痕：AI 与人都能据此判断「这个行数是怎么来的」
      preprocessing: {
        cropped: !!j.cropped,
        contentSize: j.contentWidth && j.contentHeight ? { width: j.contentWidth, height: j.contentHeight } : null,
        chunked: !!j.chunked,
        chunks: j.chunks ?? 1,
        chunkAspect: j.chunkAspect ?? null,
        chunkMerged: j.chunkMerged ?? 0,
        chunkValueConflicts: j.chunkValueConflicts ?? 0,
        deskewed: !!j.deskewed,
        deskewAngle: j.deskewAngle ?? 0,
        deskewMs: j.deskewMs ?? null,
      },
      engine: j.engine || '',
      layout: j.layout || '',
    }
    if (args.includeText) out.text = j.text || ''
    else out.textLength = (j.text || '').length
    return out
  },

  async intake_parse_text(args = {}) {
    const text = String(args.text || '')
    if (!text.trim()) throw new Error('text 不能为空')
    const j = await call('/api/intake/parse', { text })
    if (!j.ok) throw new Error(j.error || '解析失败')
    return { ok: true, rows: j.rows || [], rowCount: (j.rows || []).length, groups: j.groups || null, summary: j.summary || null }
  },

  async intake_stitch_images(args = {}) {
    const paths = Array.isArray(args.imagePaths) ? args.imagePaths : []
    if (paths.length < 2) throw new Error('imagePaths 至少给 2 张')
    const st = await call('/api/intake/stitch', { images: paths.map(toDataUrl) })
    if (!st.ok) throw new Error(st.error || '拼接失败')
    // 拼接图本身很大，落盘给路径，别塞进上下文
    const savedAt = dataUrlToFile(st.dataUrl, args.saveAs || `medbrief-stitched-${Date.now().toString(36)}.png`)
    return { ok: true, savedAt, width: st.width, height: st.height, count: st.count }
  },

  async intake_save_report(args = {}) {
    const meta = args.meta || {}
    const forbidden = ['idCard', 'phone', 'address'].filter((k) => k in meta)
    if (forbidden.length) throw new Error(`不接受身份类字段：${forbidden.join(', ')}（后端也会丢弃，这里直接拒）`)
    const body = { meta }
    if (args.imagePath) body.image = toDataUrl(args.imagePath)
    if (args.dataUrl) body.image = toDataUrl(args.dataUrl)
    if (Array.isArray(args.rows) && args.rows.length) body.rows = args.rows
    if (args.text) body.text = String(args.text)
    if (args.force === true) body.force = true
    if (!body.rows && !body.text) throw new Error('至少给 rows 或 text（否则入库的是空报告）')
    if (!meta.reportDate) throw new Error('meta.reportDate 必填（YYYY-MM-DD）——没有日期，资料卡的趋势段就无锚点')
    const j = await call('/api/intake/reports', body)
    if (j.ok) return { ok: true, reportId: j.report?.id, total: j.total, rowCount: (j.report?.rows || []).length }
    if (j.duplicate) {
      // 永不静默丢弃：把「像哪一张」原样交回，由调用方决定是否 force:true 重发
      return {
        ok: false,
        duplicate: true,
        kind: j.duplicate.kind || 'unknown',
        ofReportId: j.duplicate.of || null,
        hint: j.hint || '疑似重复',
        nextStep: '确认要保留为独立记录时，用同样的参数加 force:true 重新调用（后端仍会存原图指纹，后续查重照样提示）',
      }
    }
    throw new Error(j.error || '入库失败')
  },

  async intake_list_reports() {
    const j = await call('/api/intake/reports')
    if (!j.ok) throw new Error(j.error || '读取失败')
    return {
      ok: true,
      total: j.total,
      reports: (j.reports || []).map((r) => ({
        id: r.id,
        kind: r.kind,
        reportDate: r.reportDate,
        hospital: r.hospital,
        rowCount: (r.rows || []).length,
        createdAt: r.createdAt,
      })),
    }
  },

  async intake_get_patient() {
    const j = await call('/api/intake/patient')
    if (!j.ok) throw new Error(j.error || '读取失败')
    return { ok: true, patient: j.patient }
  },

  async intake_update_patient(args = {}) {
    const body = {}
    for (const k of ['name', 'sex', 'age', 'diagnosis', 'subtype', 'stage', 'hospital', 'attending']) {
      if (args[k] !== undefined) body[k] = args[k]
    }
    if (args.questions) body.questions = args.questions
    const j = await call('/api/intake/patient', body)
    if (!j.ok) throw new Error(j.error || '保存失败')
    return { ok: true, patient: j.patient, notStored: j.notStored || [] }
  },

  async intake_get_card(args = {}) {
    const mask = args.mask === false || args.mask === 0 || args.mask === '0' ? 0 : 1
    const j = await call(`/api/intake/card?mask=${mask}`)
    if (!j.ok) throw new Error(j.error || '生成资料卡失败')
    const out = {
      ok: true,
      masked: !!j.masked,
      counts: j.counts,
      summary: j.summary,
      htmlBytes: (j.html || '').length,
    }
    if (args.includeHtml) out.html = j.html
    if (args.saveHtml || !args.includeHtml) {
      // 默认落盘：AI 拿路径就能交给浏览器/打印，不必把 13KB HTML 塞进上下文
      const p = join(tmpdir(), args.saveHtml || `medbrief-card-${Date.now().toString(36)}${mask ? '-masked' : ''}.html`)
      writeFileSync(p, j.html || '', 'utf8')
      out.htmlPath = p
      out.hint = '直接双击/用浏览器打开即可打印或另存 PDF'
    }
    return out
  },
}

const toolSchemas = [
  {
    name: 'intake_ocr_image',
    description:
      '识别一张检查单/报告图片，返回结构化指标行（项目/值/单位/参考区间/判定）。后端会自动做倾斜矫正、超高图切块；给 imagePaths 多张时会先纵向拼接（手机把一张单拍成两张的情形）。不要用它读真人隐私信息以外的东西——它只做报告识别。',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: '本地图片绝对路径（png/jpg/jpeg/webp/gif）' },
        dataUrl: { type: 'string', description: '也可以直接给 data:image/...;base64,' },
        imagePaths: { type: 'array', items: { type: 'string' }, description: '多张图片路径：会自动纵向拼接后识别' },
        stitched: { type: 'boolean', description: '这张图是拼接产物时置 true，后端会合并重叠区的重复行' },
        includeText: { type: 'boolean', description: '是否返回 OCR 原文（默认只回长度，省上下文）' },
      },
    },
  },
  {
    name: 'intake_parse_text',
    description: '把报告/化验单的纯文本解析成指标行（不识别图片）。识别失败或手上有文字版报告时用这个。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '报告文本，一行一个项目或表格复制出来的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'intake_stitch_images',
    description: '把多张图片纵向拼成一张（手机分两张截图时用），返回落盘后的文件路径，可直接喂给 intake_ocr_image。',
    inputSchema: {
      type: 'object',
      properties: {
        imagePaths: { type: 'array', items: { type: 'string' }, description: '至少 2 张，按上到下的顺序' },
        saveAs: { type: 'string', description: '可选：拼接结果保存路径' },
      },
      required: ['imagePaths'],
    },
  },
  {
    name: 'intake_save_report',
    description:
      '把识别/解析结果入库（精确 sha256 + 近似 dhash + 内容指纹查重）。重复时返回 ok:false + duplicate:true 并指出像哪一张，绝不静默丢弃；确认要保留时加 force:true 重发。',
    inputSchema: {
      type: 'object',
      properties: {
        rows: { type: 'array', description: 'intake_ocr_image / intake_parse_text 返回的 rows' },
        text: { type: 'string', description: '没有 rows 时给原文，由后端解析' },
        imagePath: { type: 'string', description: '可选：原始图片路径（用来算 sha256/dhash，建议给）' },
        force: { type: 'boolean', description: '用户已确认「仍要导入」时置 true' },
        meta: {
          type: 'object',
          description: '报告元信息。reportDate 必填；不接受 idCard/phone/address',
          properties: {
            kind: { type: 'string', description: '血常规 / 生化 / 凝血 / 骨穿 / 出院小结 …' },
            reportDate: { type: 'string', description: 'YYYY-MM-DD' },
            hospital: { type: 'string', description: '医院名（北京朝阳医院本部写「本部（工体南路）」）' },
            patientName: { type: 'string', description: '病友姓名（会原样存，资料卡默认脱敏打印）' },
          },
          required: ['reportDate'],
        },
      },
    },
  },
  {
    name: 'intake_list_reports',
    description: '列出已导入的报告（只含元信息与行数，不含原文与原图）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'intake_get_patient',
    description: '读取病友档案（资料卡抬头）：姓名/性别/年龄/诊断/分型/阶段/医院/主管医生/三问。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'intake_update_patient',
    description: '写入病友档案。身份类字段（身份证/手机号/住址）会被拒绝或丢弃——这是产品红线，不是疏漏。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        sex: { type: 'string' },
        age: { type: 'string' },
        diagnosis: { type: 'string' },
        subtype: { type: 'string' },
        stage: { type: 'string' },
        hospital: { type: 'string' },
        attending: { type: 'string' },
        questions: {
          type: 'object',
          description: '给医生的三问',
          properties: { focus: { type: 'string' }, confirm: { type: 'string' }, nextVisit: { type: 'string' } },
        },
      },
    },
  },
  {
    name: 'intake_get_card',
    description:
      '生成给门诊医生看的一页 A4 资料卡（默认脱敏）。返回统计数字与 HTML 落盘路径；要正文时用 includeHtml。',
    inputSchema: {
      type: 'object',
      properties: {
        mask: { type: 'boolean', description: '默认 true 脱敏（姓名打码）；false 关闭脱敏' },
        includeHtml: { type: 'boolean', description: '是否直接返回 HTML 文本（默认只给路径）' },
        saveHtml: { type: 'string', description: '可选：HTML 保存路径' },
      },
    },
  },
]

// ---------------- JSON-RPC 分发 ----------------

async function handle(msg) {
  const { id, method, params } = msg || {}
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  // 通知（无 id）不需要回包
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client initialized')
    return null
  }
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'MedBrief 资料导入通路。典型链路：intake_ocr_image（或 intake_parse_text）→ 校对 rows → intake_save_report → intake_get_card。' +
          '重复入库会返回 duplicate;确认要保留时加 force:true。身份类字段一律不存（红线）。',
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: toolSchemas })
    case 'tools/call': {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      const fn = tools[name]
      if (!fn) return fail(-32602, `未知工具：${name}`)
      try {
        const out = await fn(args)
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false })
      } catch (e) {
        log('tool error', name, e.message)
        return reply({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }, null, 2) }], isError: true })
      }
    }
    default:
      return fail(-32601, `不支持的方法：${method}`)
  }
}

// ---------------- stdio 主循环 ----------------

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }) + '\n')
      continue
    }
    handle(msg)
      .then((res) => {
        if (res) process.stdout.write(JSON.stringify(res) + '\n')
      })
      .catch((e) => {
        log('handler crash', e.message)
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: e.message } }) + '\n',
        )
      })
  }
})
process.stdin.on('end', () => process.exit(0))
log(`ready · backend ${BASE}`)
