// ===================== 用户修正反馈（User Correction Feedback）=====================
// 原理：用户在校对网格里直接修改的字段 = 对 OCR 算法的权威反馈（真值信号）；
//       用户未修改的字段不一定正确，绝不作为真值。
// 链路：DataGrid 编辑时给每行打来源标记（_editSrc 字段级 / _source 行级）→
//       保存时 buildFeedback 对比「当前 points vs 识别基线 points」算出字段级 diff →
//       postFeedback 经 /api/feedback 落盘 logs/feedback-<traceId>.json 并追加队列。
// 基线来源：ImportFlow emitTrace 的 snapshot.points（识别后、编辑前的原始点，带 row 索引）。

const FEEDBACK_ENDPOINT = '/api/feedback'

// 用户可编辑、且属于 OCR 算法输出的字段白名单（仅这些字段参与反馈 diff）
export const EDITABLE_FIELDS = ['standard_code', 'original_name', 'value', 'unit', 'ref_range', 'arrow', '_item_no']

const norm = (v) => String(v ?? '').trim()

// 字段名对外契约映射（内部 _item_no → 对外 item_no，避免下划线污染反馈 JSON）
const FIELD_OUT = { _item_no: 'item_no' }

// 计算字段级 diff：基线 points（带 row） vs 当前 points（带 _row）。
// - 按 row 对齐，删除/新增行不扰乱；新增行（无基线）进 addedRows，行级来源取 _source（paste/inferred）
// - 已有行：白名单字段逐一对比，source 取字段级 _editSrc[field]（manual/autoFix/reMatch），缺省 manual
// - 基线有当前无 → removedRows（OCR 多识别/噪声行，用户删除也是有效信号）
// - wholeReport = 当前全量数据（仅上下文，非真值）
export function buildFeedback({ baselinePoints = [], currentPoints = [], traceId = '', reportType = '', date = '', image = '', ops = [] }) {
  const baseByRow = new Map()
  for (const b of baselinePoints) {
    const r = b.row != null ? b.row : b._row
    if (r != null && !baseByRow.has(r)) baseByRow.set(r, b)
  }
  const curRows = new Set()
  const edits = []
  const addedRows = []
  const summary = { total: 0, manual: 0, reMatch: 0, autoFix: 0, paste: 0, inferred: 0, removed: 0 }
  for (const p of currentPoints) {
    const r = p._row != null ? p._row : p.row
    const base = r != null ? baseByRow.get(r) : undefined
    if (!base) {
      // 无基线 → 新增行（粘贴解析 / 智能补项 / 空白行手动录入）
      const source = p._source === 'paste' ? 'paste' : 'inferred'
      summary[source]++
      summary.total++
      // abbr：粘贴解析时用户写的缩写（未入库的临时字段），带上便于 AI 判断「该缩写应映射到哪个代码」
      addedRows.push({ row: r, code: p.standard_code || '', name: p.original_name || '', value: p.value || '', abbr: p._abbr || '', source })
      continue
    }
    curRows.add(r)
    for (const f of EDITABLE_FIELDS) {
      const ov = base[f]
      const cv = p[f]
      if (norm(ov) !== norm(cv)) {
        const source = p._editSrc?.[f] || 'manual'
        summary[source] = (summary[source] || 0) + 1
        summary.total++
        edits.push({
          row: r,
          code: p.standard_code || base.standard_code || '',
          field: FIELD_OUT[f] || f,
          original: ov ?? '',
          corrected: cv ?? '',
          source,
        })
      }
    }
  }
  const removedRows = []
  for (const [r, base] of baseByRow) {
    if (!curRows.has(r)) {
      summary.removed++
      // 连单位/参考/箭头一并带出：只剩 row/code/name/value 时，AI 无法判断被删的是
      // 「纯 OCR 噪声行」还是「带完整参考区间却被误删的真指标」（如 TR-20260911-SBLXJ7
      // 的 TP 梅毒 56.2 实为总蛋白值被套代码，缺 unit/ref 难以归因）。
      removedRows.push({
        row: r,
        code: base.standard_code || '',
        name: base.original_name || '',
        value: base.value || '',
        unit: base.unit || '',
        ref: base.ref_range || '',
        arrow: base.arrow || '',
      })
    }
  }
  const wholeReport = currentPoints
    .filter((p) => String(p.value).trim() !== '')
    .map((p) => ({
      row: p._row != null ? p._row : p.row,
      code: p.standard_code || '',
      name: p.original_name || '',
      value: p.value || '',
      unit: p.unit || '',
      ref: p.ref_range || '',
      arrow: p.arrow || '',
    }))
  return {
    traceId,
    ts: new Date().toISOString(),
    reportType,
    date,
    image, // 900px 脱敏压缩图 dataURL（AI 拿到即可复现）
    edits, // 权威真值信号：仅用户修改过的字段
    addedRows, // 无基线新增行（含来源）
    removedRows, // 用户删除的识别行
    operations: ops, // 操作记录：按时间顺序的用户动作（解析/增删行/修正/排序/编辑…），用于区分「算法问题」与「操作问题」
    summary, // 按来源统计
    wholeReport, // 当前全量上下文（显式非真值）
  }
}

// 入库后修正的反馈（对比弹窗 / 报告详情编辑等场景）。
// 与 buildFeedback 的区别：
//   ① 基线按 standard_code 对齐（入库时 _row/_editSrc 已被 ImportFlow 剥离，无行号可用）
//   ② 带 source='compare-edit' 与 recordId，便于 AI 区分「导入校对」与「入库后修正」两类信号
// 修正即真值：改前=OCR/历史识别结果，改后=用户确认的正确值。
export function buildEditFeedback({
  beforePoints = [],
  afterPoints = [],
  recordId = '',
  traceId = '',
  ocrTraceId = '', // 该记录入库时的原始 OCR Trace ID；AI 据此读 logs/ocr-<ocrTraceId>.json 回溯原始识别
  reportType = '',
  date = '',
  image = '',
}) {
  const beforeByCode = new Map()
  for (const b of beforePoints) {
    if (b.standard_code && !beforeByCode.has(b.standard_code)) beforeByCode.set(b.standard_code, b)
  }
  const afterByCode = new Map()
  for (const a of afterPoints) {
    if (a.standard_code && !afterByCode.has(a.standard_code)) afterByCode.set(a.standard_code, a)
  }
  const edits = []
  const addedRows = []
  const removedRows = []
  const summary = { total: 0, manual: 0, added: 0, removed: 0 }
  // 已有项：白名单字段级 diff
  for (const [code, after] of afterByCode) {
    const before = beforeByCode.get(code)
    if (!before) {
      summary.added++
      summary.total++
      addedRows.push({ code, name: after.original_name || '', value: after.value || '', source: 'manual' })
      continue
    }
    for (const f of EDITABLE_FIELDS) {
      const ov = before[f]
      const cv = after[f]
      if (norm(ov) !== norm(cv)) {
        summary.manual++
        summary.total++
        edits.push({
          code,
          name: after.original_name || before.original_name || '',
          field: FIELD_OUT[f] || f,
          original: ov ?? '',
          corrected: cv ?? '',
          source: 'manual',
        })
      }
    }
  }
  // 删除项：改前有、改后无（误识别/多余行的负信号，同样是有效反馈）
  for (const [code, before] of beforeByCode) {
    if (!afterByCode.has(code)) {
      summary.removed++
      summary.total++
      removedRows.push({ code, name: before.original_name || '', value: before.value || '', source: 'manual' })
    }
  }
  const wholeReport = afterPoints
    .filter((p) => String(p.value ?? '').trim() !== '')
    .map((p) => ({
      code: p.standard_code || '',
      name: p.original_name || '',
      value: p.value || '',
      unit: p.unit || '',
      ref: p.ref_range || '',
      arrow: p.arrow || '',
    }))
  return {
    traceId,
    ts: new Date().toISOString(),
    source: 'compare-edit', // 与导入校对（缺省）区分
    recordId,
    ocrTraceId, // 原始识别日志 Trace（历史记录可能为空）
    reportType,
    date,
    image,
    edits, // 权威真值：用户改过的字段
    addedRows, // 补齐的漏识别项
    removedRows, // 删除的误识别项
    summary,
    wholeReport,
  }
}

// 入库后修正的 Trace ID（入库记录未保留 OCR traceId，故为每次修正会话生成一个唯一 ID）
export function makeEditTraceId() {
  return `FIX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

// 把反馈落盘：先写 localStorage 兜底，再 POST /api/feedback（server.mjs 落盘 + 入队）
export async function postFeedback(feedback) {
  if (!feedback || !feedback.traceId) return { ok: false, persisted: false }
  // 无任何修改信号（edits/增行/删行全空）→ 不进 AI 反馈，直接跳过（ImportFlow/CompareModal 共用入口）
  const signalCount = (feedback.edits?.length || 0) + (feedback.addedRows?.length || 0) + (feedback.removedRows?.length || 0)
  if (!signalCount) return { ok: true, skipped: true }
  const payload = { traceId: feedback.traceId, feedback }
  try {
    localStorage.setItem(`feedback:${feedback.traceId}`, JSON.stringify(payload))
  } catch {
    /* localStorage 满（含脱敏图）时静默忽略 */
  }
  let persisted = false
  try {
    const res = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error('feedback endpoint ' + res.status)
    const j = await res.json().catch(() => ({}))
    persisted = true
    // 通知前端刷新「AI 工作状态」徽章（App 顶栏轮询监听此事件即时刷新）
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('meddata:feedback-submitted'))
    }
    return { ok: true, persisted, file: j.file }
  } catch {
    // 后端不可用：降级 localStorage（不阻塞保存），并通知徽章显示「本地暂存」
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('meddata:feedback-submitted'))
    }
    return { ok: true, persisted: false }
  }
}

// 本地暂存（未确认落盘）的反馈条数；以及补投：把 localStorage 里
// 服务端「还没入队」的反馈重新 POST，成功则清掉本地备份。
// 触发时机：页面加载 / 保存后 / 徽章手动补投。服务不可达时保留备份，下次再试。
const BACKLOG_PREFIX = 'feedback:'

export const countBacklog = () => {
  if (typeof localStorage === 'undefined') return 0
  let n = 0
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(BACKLOG_PREFIX)) n++
  }
  return n
}

export async function flushFeedbackBacklog() {
  if (typeof localStorage === 'undefined') return { ok: true, sent: 0 }
  const keys = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(BACKLOG_PREFIX)) keys.push(k)
  }
  if (!keys.length) return { ok: true, sent: 0 }
  // 服务端可达性检查 + 已入队集合
  let queued
  try {
    const res = await fetch('/api/feedback-status')
    if (!res.ok) throw new Error('status ' + res.status)
    const j = await res.json()
    queued = new Set((j.queue || []).map((q) => q.traceId))
  } catch {
    // 服务不可达：无法补投，保留本地备份（数据不丢，等恢复后再投）
    return { ok: false, sent: 0, reason: 'server unreachable' }
  }
  let sent = 0
  for (const k of keys) {
    const tid = k.slice(BACKLOG_PREFIX.length)
    try {
      if (queued.has(tid)) {
        // 其实早已入队（POST 曾成功）→ 清冗余备份
        localStorage.removeItem(k)
        continue
      }
      const raw = localStorage.getItem(k)
      if (!raw) continue
      const res = await fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      })
      if (res.ok) {
        localStorage.removeItem(k)
        sent++
      }
    } catch {
      /* 单条失败保留，下次再试 */
    }
  }
  if (sent > 0 && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('meddata:feedback-submitted'))
  }
  return { ok: true, sent }
}
