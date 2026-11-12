// MedBrief · 问诊资料卡（渲染层）
// 分工：取数/识别/查重/拼接在 lib/reportIntake.mjs（代诊-报告维护）；本文件只做「病友档案 + 一页资料卡」。
// 设计文档：docs/问诊资料卡.md
//
// 隐私边界（不可改）：
//   1. 只落本机 data/intake/**（已 gitignore），不上外网，不进版本库；
//   2. 不收集身份证/手机号；姓名默认脱敏（可关）；
//   3. 卡片只陈述数值、日期、出处与趋势，不写诊断结论/治疗建议（红线见 testing-lessons）。

import fs from 'node:fs'
import path from 'node:path'
import { groupForDoctorCard, summarizeForCard } from './reportIntake.mjs'

const ROOT = path.resolve('data', 'intake')
const PATIENT_FILE = path.join(ROOT, 'patient.json')

const DEFAULT_PATIENT = {
  id: 'p1',
  name: '',
  sex: '',
  age: '',
  diagnosis: '',
  subtype: '',
  stage: '',
  hospital: '',
  attending: '',
  source: '病友家属提供（未经本院核实）',
  questions: { focus: '', confirm: '', nextVisit: '' },
  updatedAt: null,
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function loadPatient() {
  const p = readJson(PATIENT_FILE, null)
  return p ? { ...DEFAULT_PATIENT, ...p, questions: { ...DEFAULT_PATIENT.questions, ...(p.questions || {}) } } : { ...DEFAULT_PATIENT }
}

export function savePatient(patch = {}) {
  const cur = loadPatient()
  const next = { ...cur, ...patch, questions: { ...cur.questions, ...(patch.questions || {}) }, id: 'p1', updatedAt: new Date().toISOString() }
  // 隐私：身份类字段一律不收
  delete next.idCard
  delete next.phone
  delete next.address
  writeJson(PATIENT_FILE, next)
  return next
}

const maskName = (s) => {
  const t = String(s || '').trim()
  if (t.length <= 1) return t
  return t[0] + '*'.repeat(Math.max(1, t.length - 1))
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const flagText = (f) => (f === 'high' ? '高 ↑' : f === 'low' ? '低 ↓' : f === 'normal' ? '正常' : '—')
const flagColor = (f) => (f === 'high' || f === 'low' ? '#b91c1c' : '#374151')

/**
 * 生成资料卡
 * @param {object} opts
 * @param {Array}  opts.reports  已导入的报告（每条含 rows[]、reportDate、kind、hospital）
 * @param {boolean} opts.mask    是否脱敏姓名（默认 true）
 */
export function buildCard({ reports = [], mask = true } = {}) {
  const patient = loadPatient()
  const rows = []
  for (const rep of reports) {
    for (const r of rep.rows || []) {
      rows.push({
        ...r,
        measuredAt: r.measuredAt || rep.reportDate || '',
        reportId: rep.id,
        kind: rep.kind || 'lab',
        hospital: rep.hospital || '',
      })
    }
  }
  const groups = groupForDoctorCard(rows)
  const summary = summarizeForCard(groups)
  const showName = mask ? maskName(patient.name) : patient.name
  const card = {
    ok: true,
    generatedAt: new Date().toISOString(),
    masked: !!mask,
    patient: { ...patient, name: showName },
    counts: { reports: reports.length, rows: rows.length, groups: groups.length },
    summary,
    groups,
  }
  card.html = renderHtml(card)
  return card
}

function renderHtml(card) {
  const p = card.patient || {}
  const s = card.summary || {}
  const row = (g) => {
    const latest = (g.rows && g.rows[0]) || g.latest || {}
    const recent = (g.rows || []).slice(0, 3)
      .map((r) => `${esc(r.value)}${r.unit ? ' ' + esc(r.unit) : ''}${r.measuredAt ? '（' + esc(r.measuredAt) + '）' : ''}`)
      .join(' → ')
    const flag = latest.flag || latest.status
    return `<tr>
      <td>${esc(g.label || g.name || g.analyte || g.category || '')}</td>
      <td style="color:${flagColor(flag)};font-weight:600">${esc(latest.value ?? '')} ${esc(latest.unit || '')}</td>
      <td>${esc(latest.refRange || '—')}</td>
      <td>${esc(latest.measuredAt || '—')}</td>
      <td style="color:${flagColor(flag)}">${flagText(flag)}</td>
      <td style="font-size:11px;color:#6b7280">${recent}</td>
    </tr>`
  }
  const tableFor = (list, empty) => (list && list.length
    ? `<table><thead><tr><th>项目</th><th>最新值</th><th>参考区间</th><th>日期</th><th>判定</th><th>最近三次</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>`
    : `<div class="q">${esc(empty)}</div>`)

  const abnormalGroups = (card.groups || []).filter((g) => {
    const f = ((g.rows && g.rows[0]) || g.latest || {}).flag || ((g.rows && g.rows[0]) || g.latest || {}).status
    return f === 'high' || f === 'low' || f === 'abnormal'
  })
  const missing = s.missingBasics || s.missing || []

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>问诊资料卡 · ${esc(p.name || '病友')}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font: 12px/1.55 -apple-system, "PingFang SC", sans-serif; color: #111827; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  .meta { color: #4b5563; font-size: 11px; margin-bottom: 8px; }
  h2 { font-size: 13px; margin: 12px 0 4px; padding-bottom: 2px; border-bottom: 1px solid #e5e7eb; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #e5e7eb; padding: 3px 5px; text-align: left; font-size: 11px; }
  th { background: #f9fafb; font-weight: 600; }
  .warn { background: #fff7ed; border: 1px solid #fdba74; padding: 6px 8px; font-size: 11px; margin-bottom: 6px; }
  .q { border: 1px dashed #d1d5db; padding: 6px 8px; font-size: 11px; min-height: 18px; color: #6b7280; }
  .foot { margin-top: 10px; color: #6b7280; font-size: 10px; }
</style></head><body>
<h1>问诊资料卡 · ${esc(p.name || '（姓名未填）')} ${esc(p.sex || '')}${p.age ? ' · ' + esc(p.age) + '岁' : ''}</h1>
<div class="meta">
  诊断：${esc(p.diagnosis || '—')}${p.subtype ? '（' + esc(p.subtype) + '）' : ''} ｜ 阶段：${esc(p.stage || '—')} ｜
  报告 ${card.counts.reports} 份 / 指标 ${card.counts.rows} 项 ｜ 生成：${esc(String(card.generatedAt).slice(0, 16).replace('T', ' '))}
</div>
${card.masked ? '<div class="warn">姓名已脱敏；本卡资料由家属提供、未经本院核实，仅用于门诊沟通。</div>' : ''}
${missing.length ? `<div class="warn">未提供：${missing.map(esc).join('、')} —— 「没查」与「没给我」临床含义不同，请医生注意。</div>` : ''}
<h2>① 异常项（优先看）</h2>
${tableFor(abnormalGroups, '本次导入的资料里没有越出参考区间的项目（或未识别到参考区间）')}
<h2>② 全部指标</h2>
${tableFor(card.groups, '尚未识别出指标')}
<h2>③ 家属三问</h2>
<div class="q">本次最想解决：${esc(p.questions?.focus || '')}</div>
<div class="q" style="margin-top:4px">想请医生确认：${esc(p.questions?.confirm || '')}</div>
<div class="q" style="margin-top:4px">下次复查时间：${esc(p.questions?.nextVisit || '')}</div>
<div class="foot">本卡只陈述家属提供的数值、日期与趋势，不含诊断结论与治疗建议。MedBrief 问诊资料卡。</div>
</body></html>`
}

export const INTAKE_ROOT = ROOT
