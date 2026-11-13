// ===================== AI 结构化数据导出引擎 =====================

import { FIELD_BY_CODE, STANDARD_FIELDS, REPORT_TYPES, RECORD_CATEGORIES, OTHER_CATEGORY, recordCategoryOf, reportTypeLabel } from '../data/dictionary.js'
import { getBaseType, catalogBaseLabel } from '../data/reportCatalog.js'
import { STATUS_META } from './normalize.js'
import { classifyFever, FEVER_META } from './temperature.js'

const STATUS_TEXT = {
  CRITICAL_LOW: '危急低值',
  CRITICAL_HIGH: '危急高值',
  LOW: '偏低',
  HIGH: '偏高',
  NORMAL: '正常',
}

function fmt(v) {
  const n = parseFloat(v)
  return Number.isNaN(n) ? String(v ?? '') : String(n)
}

// 全部事件均为治疗事件（旧待办任务已迁移为用药事件），进入导出时间线；
// 保留 kind 过滤以兼容可能残留的旧数据
export function markerEventsOf(events = []) {
  return events.filter((e) => (e.kind || 'marker') === 'marker')
}

// 构建符合 PRD JSON Schema 的完整数据结构
export function buildJson(record, patientMeta, events = []) {
  const rtLabel = reportTypeLabel(record.report_type)
  const markerEvents = markerEventsOf(events)
  return {
    patient_meta: { ...patientMeta },
    record_date: record.checked_at || record.date,
    ...(record.reported_at ? { reported_at: record.reported_at } : {}),
    report_type: record.report_type,
    report_type_label: rtLabel,
    data_points: (record.data_points || []).map((p) => ({
      standard_code: p.standard_code || 'UNKNOWN',
      original_name: p.original_name,
      value: fmt(p.value),
      unit: p.unit,
      ref_range: p.ref_range,
      status: p.status,
    })),
    medical_notes: record.notes || '',
    report_text: record.report_text || '', // 报告原文（机器转录，不含患者身份信息）
    ...(markerEvents.length ? { timeline_events: markerEvents } : {}),
  }
}

// 单条记录 -> Markdown
// opts.withReportText：是否附带「报告原文」（默认附带，用于备份留档；
// buildPrompt 走的是同一函数，那里传 false —— AI 需要原文时直接读原件图，不必塞整页 OCR 噪声）
export function toMarkdown(record, patientMeta, { withReportText = true } = {}) {
  const rtLabel = reportTypeLabel(record.report_type)
  const lines = []
  lines.push(`# 化验记录 · ${record.checked_at || record.date}`)
  lines.push('')
  if (record.reported_at) lines.push(`- **报告时间**：${record.reported_at}`)
  lines.push(`- **患者**：${patientMeta.age}岁 / ${patientMeta.gender} / ${patientMeta.diagnosis}`)
  lines.push(`- **报告类型**：${rtLabel}`)
  if (record.notes) lines.push(`- **备注**：${record.notes}`)
  lines.push('')
  lines.push('| 标准代码 | 项目 | 结果 | 单位 | 参考范围 | 状态 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const p of record.data_points || []) {
    const arrow = p.arrow ? p.arrow : ''
    const status = `${STATUS_TEXT[p.status] || p.status}${arrow ? ' ' + arrow : ''}`
    lines.push(
      `| ${p.standard_code || '—'} | ${p.original_name || ''} | ${fmt(p.value)} | ${p.unit || ''} | ${p.ref_range || ''} | ${status} |`
    )
  }
  if (withReportText && record.report_text) {
    lines.push('')
    lines.push('**报告原文（机器转录）**')
    lines.push('')
    lines.push(record.report_text)
  }
  return lines.join('\n')
}

// ============ 多日 / 全病程结构化 JSON（AI 深度分析用）============
// 原始需求是「导出全部数据」做跨日趋势解读，而非单日。这里把多份报告、
// 事件时间线、按指标纵向序列一并结构化导出，方便 AI 直接做趋势分析。

export function buildJsonAll(records, events = [], patientMeta = {}) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : 1))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const markerEvents = markerEventsOf(events)

  // 按标准指标纵向汇总：{ code: [{date, value, unit, ref_range, status}...] }
  const seriesByCode = {}
  for (const r of sorted) {
    for (const p of r.data_points || []) {
      const code = p.standard_code || 'UNKNOWN'
      if (!seriesByCode[code]) seriesByCode[code] = []
      seriesByCode[code].push({
        date: r.date,
        value: fmt(p.value),
        unit: p.unit,
        ref_range: p.ref_range,
        status: p.status,
      })
    }
  }

  return {
    schema_version: 1,
    patient_meta: { ...patientMeta },
    meta: {
      report_count: sorted.length,
      event_count: markerEvents.length,
      date_range: sorted.length
        ? { start: first.date, end: last.date }
        : null,
      report_types: [...new Set(sorted.map((r) => r.report_type))],
    },
    timeline_events: markerEvents.map((e) => ({
      date: e.date,
      text: e.text,
      category: e.category,
    })),
    reports: sorted.map((r) => {
      const rtLabel = reportTypeLabel(r.report_type)
      return {
        date: r.checked_at || r.date,
        ...(r.reported_at ? { reported_at: r.reported_at } : {}),
        report_type: r.report_type,
        report_type_label: rtLabel,
        data_points: (r.data_points || []).map((p) => ({
          standard_code: p.standard_code || 'UNKNOWN',
          original_name: p.original_name,
          value: fmt(p.value),
          unit: p.unit,
          ref_range: p.ref_range,
          status: p.status,
        })),
        medical_notes: r.notes || '',
        report_text: r.report_text || '',
      }
    }),
    // 按指标纵向展开，AI 可直接看出每个指标随时间的变化趋势
    indicator_series: Object.entries(seriesByCode)
      .map(([code, points]) => ({
        standard_code: code,
        display_name: (FIELD_BY_CODE[code] && FIELD_BY_CODE[code].name) || null,
        unit: points.length ? points[points.length - 1].unit : null,
        ref_range: points.length ? points[points.length - 1].ref_range : null,
        history: points,
      }))
      .sort((a, b) => a.standard_code.localeCompare(b.standard_code)),
  }
}

// 全部记录汇总 -> Markdown（用于多日趋势解读）
export function toMarkdownAll(records, patientMeta) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : 1))
  const blocks = ['']
  for (const r of sorted) blocks.push(toMarkdown(r, patientMeta), '')
  const header = [
    `# MedData-AI 病程数据汇总（${sorted.length} 次检测）`,
    '',
    `**患者**：${patientMeta.age}岁 / ${patientMeta.gender} / ${patientMeta.diagnosis}`,
    '',
  ].join('\n')
  return header + blocks.join('\n---\n')
}

// 内置 Prompt 模板库
export const PROMPT_TEMPLATES = [
  {
    id: 'A',
    name: '病情解读（造血恢复 / 感染风险）',
    template: (md) =>
      `我是一名 ${'{diagnosis}'} 患者，以下是我近期（${'{range}'}）的血常规与生化指标演变数据，请分析当前造血恢复情况及感染风险：\n\n${md}`,
  },
  {
    id: 'B',
    name: '药物毒性评估（肝肾 / 心肌）',
    template: (md) =>
      `这是我化疗后的肝肾功能与心肌酶指标数据，请评估是否存在脏器毒性损伤，并给出处理建议：\n\n${md}`,
  },
  {
    id: 'C',
    name: '危急值速报（今日重点）',
    template: (md) =>
      `以下是我今日的检验结果，请先列出所有「危急值 / 明显异常」项目，并说明需要紧急处理的事项：\n\n${md}`,
  },
]

// 生成模板 Prompt 文本
export function buildPrompt(templateId, record, patientMeta, records) {
  const tpl = PROMPT_TEMPLATES.find((t) => t.id === templateId)
  if (!tpl) return ''
  const md = toMarkdown(record, patientMeta, { withReportText: false })
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : 1))
  const range = sorted.length ? `${sorted[0].date} ~ ${sorted[sorted.length - 1].date}` : record.date
  return tpl.template(md)
    .replace('{diagnosis}', patientMeta.diagnosis)
    .replace('{range}', range)
}

// ============ 报告归档（影像/心电）导出：可检索索引 ============
// 原件在 IndexedDB 中，这里导出的是解析索引（含结论/所见/测量值/全文），
// 方便直接交给 AI 关联化验趋势做综合病程分析。

const DOC_KIND_TEXT = {
  ecg: '心电图',
  ultrasound: '超声',
  ct: 'CT',
  mri: '磁共振',
  xray: 'X线/DR',
  endoscopy: '内镜',
  genetic: '基因检测',
  flow: '流式免疫分型',
  bonemarrow: '骨髓形态',
  pathology: '病理活检',
  discharge: '出院记录',
  cert: '诊断证明',
  other: '其他',
}

// 归档索引 -> Markdown
export function docsToMarkdown(docs, patientMeta) {
  const sorted = [...docs].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
  const lines = [`# 影像/心电报告归档索引（${sorted.length} 份）`, '']
  lines.push(`**患者**：${patientMeta.age}岁 / ${patientMeta.gender} / ${patientMeta.diagnosis}`, '')
  for (const d of sorted) {
    lines.push(
      `## ${d.date}${d.time ? ' ' + d.time : ''}${d.reported_at && d.reported_at.slice(0, 10) !== d.date ? `（报告 ${d.reported_at}）` : ''} · ${d.doc_type || DOC_KIND_TEXT[d.kind] || '其他'}`
    )
    lines.push('')
    if (d.title) lines.push(`- **报告**：${d.title}`)
    if (d.findings) lines.push(`- **检查所见**：${d.findings}`)
    if (d.conclusion) lines.push(`- **诊断结论**：${d.conclusion}`)
    if (d.measures && d.measures.length) {
      lines.push(`- **关键测量值**：${d.measures.map((m) => `${m.name} ${m.value}${m.unit}`).join('；')}`)
    }
    if (d.notes) lines.push(`- **备注**：${d.notes}`)
    if (d.file) lines.push(`- **原件**：${d.file.name}`)
    lines.push('')
  }
  return lines.join('\n')
}

// 归档索引 -> JSON
export function docsToJson(docs) {
  return {
    schema_version: 1,
    doc_count: docs.length,
    docs: docs
      .map((d) => ({
        date: d.date,
        time: d.time,
        reported_at: d.reported_at || '',
        doc_type: d.doc_type,
        title: d.title,
        findings: d.findings,
        conclusion: d.conclusion,
        measures: d.measures,
        notes: d.notes,
        file_name: d.file ? d.file.name : null,
        is_scanned: !!d.is_scanned,
      }))
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1)),
  }
}

// 病历文书（出院记录 / 诊断证明）导出：结构化字段 + 检索索引 + 原文链接。
// 与检查报告导出并列放在「导出」弹层，便于把病程文书一起交给 AI 做综合解读。
const CASE_FIELD_LABEL = {
  discharge_date: '出院日期',
  admission_date: '入院日期',
  hospital_days: '住院天数',
  discharge_diagnosis: '出院诊断',
  discharge_advice: '出院医嘱',
  discharge_meds: '出院用药',
  diagnosis: '诊断',
  rest_days: '建议休息天数',
  department: '科室',
  doctor: '医师',
}

export function casesToMarkdown(cases, patientMeta) {
  const sorted = [...cases].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
  const lines = [`# 病历文书归档索引（${sorted.length} 份）`, '']
  if (patientMeta && (patientMeta.diagnosis || patientMeta.age)) {
    lines.push(`**患者**：${patientMeta.age ?? ''}岁 / ${patientMeta.gender ?? ''} / ${patientMeta.diagnosis ?? ''}`, '')
  }
  for (const d of sorted) {
    lines.push(
      `## ${d.date}${d.time ? ' ' + d.time : ''}${d.reported_at && d.reported_at.slice(0, 10) !== d.date ? `（报告 ${d.reported_at}）` : ''} · ${d.doc_type || (d.kind === 'cert' ? '诊断证明' : '出院记录')}`
    )
    lines.push('')
    if (d.title) lines.push(`- **标题**：${d.title}`)
    const f = d.fields || {}
    for (const [k, v] of Object.entries(f)) {
      if (v == null || v === '') continue
      lines.push(`- **${CASE_FIELD_LABEL[k] || k}**：${v}`)
    }
    if (d.findings) lines.push(`- **所见**：${d.findings}`)
    if (d.conclusion) lines.push(`- **结论**：${d.conclusion}`)
    if (d.notes) lines.push(`- **备注**：${d.notes}`)
    if (d.file) lines.push(`- **原件**：${d.file.name}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function casesToJson(cases) {
  return {
    schema_version: 1,
    case_count: cases.length,
    cases: cases
      .map((d) => ({
        date: d.date,
        time: d.time,
        doc_type: d.doc_type,
        kind: d.kind,
        title: d.title,
        fields: d.fields || {},
        findings: d.findings,
        conclusion: d.conclusion,
        notes: d.notes,
        file_name: d.file ? d.file.name : null,
        is_scanned: !!d.is_scanned,
      }))
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1)),
  }
}

// 便捷复制
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 降级：兼容非 HTTPS 环境
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}

// 图表用小工具：取某记录中指定标准代码的数据点
export function findPoint(record, code) {
  return (record.data_points || []).find((p) => p.standard_code === code)
}

// ===================== 文件下载（浏览器本地，零上传） =====================

// 把文本以指定文件名触发布局下载；Blob + a[download] 兼容主流浏览器。
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  try {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return true
  } catch {
    return false
  }
}

// ===================== 体温导出（Markdown） =====================
// 体温事件（events.category==='temperature'）导出为 Markdown 表格，
// 与化验总览/归档导出并列放在「导出」弹层。分级沿用首页预警阈值（low/high）。

const TEMP_DEFAULT_FEVER = { low: 37.3, high: 38.5 }

export function tempToMarkdown(temps = [], thresholds = TEMP_DEFAULT_FEVER, patientMeta = {}) {
  const lines = ['# 体温记录', '']
  if (patientMeta && (patientMeta.diagnosis || patientMeta.age)) {
    lines.push(`**患者**：${patientMeta.age ?? ''}岁 / ${patientMeta.gender ?? ''} / ${patientMeta.diagnosis ?? ''}`, '')
  }
  if (!temps.length) {
    lines.push('暂无体温记录。')
    return lines.join('\n')
  }
  lines.push(`| 日期 | 时刻 | 体温(℃) | 分级 | 备注 |`)
  lines.push(`| --- | --- | --- | --- | --- |`)
  for (const t of temps) {
    const level = classifyFever(t.temp, thresholds)
    lines.push(`| ${t.date} | ${t.time || '—'} | ${t.temp} | ${FEVER_META[level]?.label || level} | ${t.note || ''} |`)
  }
  return lines.join('\n')
}

// ===================== 全病程总览（按检测报告类型分类） =====================
// 按 report_type 分组，每组一张横向趋势表：行 = 指标，列 = 日期，
// 单元格 = 数值 + 状态符号（↓ 偏低 / ↑ 偏高 / !! 危急）。人眼直接看趋势，
// AI 解析 Markdown 表格或 JSON by_report_type 均无障碍。
// 规则：组内按日期升序；同一天多次检测取最后一份。

const OVERVIEW_STATUS_SYMBOL = {
  CRITICAL_LOW: '!!',
  CRITICAL_HIGH: '!!',
  LOW: '↓',
  HIGH: '↑',
  NORMAL: '',
}

// 日期列标签：全部日期在同一年内时压缩为 MM-DD，跨年则用完整 YYYY-MM-DD
function overviewDateLabel(date, allDates) {
  const years = new Set(allDates.map((d) => String(d).slice(0, 4)))
  return years.size > 1 ? String(date) : String(date).slice(5)
}

// 指标排序：已知标准字段按字典序定义顺序优先，未知字段按 code 排后
function sortIndicatorCodes(codes) {
  const knownOrder = new Map(STANDARD_FIELDS.map((f, i) => [f.code, i]))
  const known = codes.filter((c) => knownOrder.has(c))
  const unknown = codes.filter((c) => !knownOrder.has(c)).sort()
  known.sort((a, b) => knownOrder.get(a) - knownOrder.get(b))
  return [...known, ...unknown]
}

// 去重的报告类型列表（保持 records 出现顺序）
export function listReportTypes(records) {
  return [...new Set(records.map((r) => r.report_type).filter(Boolean))]
}

// 按报告类型集合过滤记录；types 为空 / null / 已覆盖全部类型时返回原数组（保持引用）
export function filterRecordsByTypes(records, types) {
  if (!records.length || !types || !types.length) return records
  const set = new Set(types)
  const out = records.filter((r) => set.has(r.report_type))
  return out.length === records.length ? records : out
}

// 合并分类口径（与列表页一致）：按 RECORD_CATEGORIES 归类，仅含数据项、固定顺序、OTHER 兜底
export function listRecordCategories(records) {
  const counts = new Map()
  for (const r of records) {
    const cat = recordCategoryOf(r.report_type || 'UNKNOWN')
    counts.set(cat, (counts.get(cat) || 0) + 1)
  }
  const list = []
  for (const c of RECORD_CATEGORIES) {
    if (counts.has(c.key)) list.push({ key: c.key, label: c.label, count: counts.get(c.key) })
  }
  if (counts.has(OTHER_CATEGORY.key)) {
    list.push({ key: OTHER_CATEGORY.key, label: OTHER_CATEGORY.label, count: counts.get(OTHER_CATEGORY.key) })
  }
  return list
}

// 按合并分类集合过滤；cats 为空 / null / 已覆盖全部分类时返回原数组（保持引用）
export function filterRecordsByCategories(records, cats) {
  if (!records.length || !cats || !cats.length) return records
  const set = new Set(cats)
  const out = records.filter((r) => set.has(recordCategoryOf(r.report_type || 'UNKNOWN')))
  return out.length === records.length ? records : out
}

// 按报告类型分组：默认按「基础类型」聚合，使 CBC_hsCRP 与 CBC 合并到同一趋势组（实例维度仍保留 report_type）
export function groupRecordsByType(records, { byBase = true } = {}) {
  const groups = new Map()
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : 1))
  for (const r of sorted) {
    const instanceType = r.report_type || 'OTHER'
    const type = byBase ? (getBaseType(instanceType) || instanceType) : instanceType
    if (!groups.has(type)) {
      groups.set(type, { report_type: type, label: catalogBaseLabel(instanceType), dates: [], records: new Map() })
    }
    const g = groups.get(type)
    g.records.set(r.date, r) // 同一天取最后一份
  }
  const list = [...groups.values()]
  for (const g of list) g.dates = [...g.records.keys()].sort()
  // 按该类型最早检测日期排序，更贴近病程时间线
  list.sort((a, b) => (a.dates[0] < b.dates[0] ? -1 : 1))
  return list
}

function collectIndicators(group) {
  const codeSet = new Set()
  for (const r of group.records.values()) {
    for (const p of r.data_points || []) {
      if (p.standard_code) codeSet.add(p.standard_code)
    }
  }
  return sortIndicatorCodes([...codeSet])
}

// 取某组某指标在指定日期的数据点（无则 null）
function pointOn(group, date, code) {
  const rec = group.records.get(date)
  if (!rec || !rec.data_points) return null
  return rec.data_points.find((p) => p.standard_code === code) || null
}

// 全病程总览 -> Markdown（横向趋势表）
export function buildOverviewMarkdown(records, events = [], patientMeta = {}) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : 1))
  const groups = groupRecordsByType(sorted)
  const allDates = sorted.map((r) => r.date)
  const lines = []
  lines.push(
    `# MedData-AI 全病程总览（${sorted.length} 次检测 / ${sorted.length ? `${sorted[0].date} ~ ${sorted[sorted.length - 1].date}` : '—'}）`
  )
  lines.push('')
  lines.push(`**患者**：${patientMeta.age}岁 / ${patientMeta.gender} / ${patientMeta.diagnosis}`)
  lines.push('')
  const markerEvents = markerEventsOf(events)
  if (markerEvents.length) {
    lines.push('**时间线事件**：')
    for (const e of [...markerEvents].sort((a, b) => (a.date < b.date ? -1 : 1))) {
      lines.push(`- ${e.date}：${e.text}`)
    }
    lines.push('')
  }
  groups.forEach((g, gi) => {
    const codes = collectIndicators(g)
    const dateCols = g.dates.map((d) => overviewDateLabel(d, allDates))
    lines.push(`## ${gi + 1}、${g.label}（${g.records.size} 次检测）`)
    lines.push('')
    lines.push(`| 项目 | 参考范围 | 单位 | ${dateCols.join(' | ')} |`)
    lines.push(`| --- | --- | --- | ${dateCols.map(() => '---').join(' | ')} |`)
    for (const code of codes) {
      const field = FIELD_BY_CODE[code]
      let unit = field ? field.unit : ''
      let ref = field ? field.ref : ''
      const cells = g.dates.map((d) => {
        const p = pointOn(g, d, code)
        if (!p || p.value === '' || p.value == null) return '—'
        if (p.unit) unit = p.unit
        if (p.ref_range) ref = p.ref_range
        return `${fmt(p.value)}${OVERVIEW_STATUS_SYMBOL[p.status] || ''}`
      })
      lines.push(`| ${field ? field.name : code} ${code} | ${ref} | ${unit} | ${cells.join(' | ')} |`)
    }
    lines.push('')
  })
  return lines.join('\n')
}

// 全病程总览 -> JSON（AI 直接消费，与 Markdown 同构）
export function buildOverviewJson(records, events = [], patientMeta = {}) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : 1))
  const groups = groupRecordsByType(sorted)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const markerEvents = markerEventsOf(events)
  return {
    schema_version: 2,
    kind: 'overview',
    patient_meta: { ...patientMeta },
    meta: {
      record_count: sorted.length,
      event_count: markerEvents.length,
      date_range: sorted.length ? { start: first.date, end: last.date } : null,
    },
    timeline_events: markerEvents.map((e) => ({
      date: e.date,
      text: e.text,
      category: e.category,
    })),
    by_report_type: groups.map((g) => ({
      report_type: g.report_type,
      report_type_label: g.label,
      dates: g.dates,
      indicators: collectIndicators(g).map((code) => {
        const field = FIELD_BY_CODE[code]
        let unit = field ? field.unit : ''
        let ref = field ? field.ref : ''
        const values = []
        for (const d of g.dates) {
          const p = pointOn(g, d, code)
          if (!p || p.value === '' || p.value == null) continue
          if (p.unit) unit = p.unit
          if (p.ref_range) ref = p.ref_range
          values.push({ date: d, value: fmt(p.value), status: p.status || 'NORMAL' })
        }
        return {
          standard_code: code,
          display_name: field ? field.name : null,
          unit,
          ref_range: ref,
          values,
        }
      }),
    })),
  }
}
