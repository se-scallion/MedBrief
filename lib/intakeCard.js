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
export function buildCard({ reports = [], mask = false } = {}) {  // 2026-11-13 用户定：给医生看，默认不脱敏
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
  const flat = flattenRows(groups)
  // groupForDoctorCard 只保留固定字段，valueConflict 会在那一层丢掉 → 这里按 (名称|值) 回贴
  const conflictKeys = new Set(rows.filter((r) => r.valueConflict || r.conflict).map((r) => `${r.name}|${r.value}`))
  if (conflictKeys.size) for (const r of flat) if (conflictKeys.has(`${r.name}|${r.value}`)) r.valueConflict = true

  // 按项目取「最新一次」：医生先看现在多重，而不是把所有历史摊开（105 行会撑到 3 页，实测）
  const byName = new Map()
  for (const r of flat) {
    if (!byName.has(r.name)) byName.set(r.name, [])
    byName.get(r.name).push(r)
  }
  const latestRows = []
  const trendRows = []
  const KEY = /白细胞|血红蛋白|血小板|中性粒|CRP|C反应蛋白|乳酸脱氢|骨髓原始|MRD/i
  const TREND_PRIORITY = (name) => {
    const order = [/骨髓原始/, /MRD/i, /白细胞/, /中性粒/, /血红蛋白/, /血小板/, /C反应蛋白|CRP/i, /乳酸脱氢/]
    const i = order.findIndex((re) => re.test(name))
    return i < 0 ? 99 : i
  }
  for (const [name, list] of byName) {
    const sorted = list.slice().sort((a, b) => String(b.measuredAt).localeCompare(String(a.measuredAt)))
    latestRows.push(sorted[0])
    if (sorted.length >= 2 && KEY.test(name)) trendRows.push({ name, points: sorted.slice(0, 3) })
  }
  // 趋势只保留最关键的 8 项（一页 A4 装得下的上限；实测 27 项会溢出到第 2 页）
  // 切块边界可能对同一项读出不同值（已按多数票取用）—— 数量要如实反映给医生
  const valueConflictRows = flat.filter((r) => r.valueConflict || r.conflict).length
  const trendTop = trendRows.slice().sort((a, b) => TREND_PRIORITY(a.name) - TREND_PRIORITY(b.name)).slice(0, 8)
  const showName = mask ? maskName(patient.name) : patient.name
  const card = {
    ok: true,
    generatedAt: new Date().toISOString(),
    masked: !!mask,
    patient: { ...patient, name: showName },
    counts: { reports: reports.length, rows: flat.length, latest: latestRows.length, trends: trendTop.length, trendsAll: trendRows.length, groups: groups.length, valueConflicts: valueConflictRows },
    latestRows,
    trendRows: trendTop,
    summary,
    groups,
  }
  card.html = renderHtml(card)
  return card
}

function flattenRows(groups) {
  const out = []
  for (const g of groups || []) {
    for (const it of g.items || g.rows || []) {
      out.push({
        cat: g.label || g.cat || '其他项',
        name: it.name || it.label || it.code || '',
        value: it.value,
        unit: it.unit || '',
        refRange: it.refRange || '',
        measuredAt: it.measuredAt || it.reportDate || '',
        flag: it.flag || (it.status === 'high' ? 'high' : it.status === 'low' ? 'low' : it.status === 'normal' ? 'normal' : ''),
        // 切块边界残值冲突要一路带到卡片（否则脚注永远数不到）
        valueConflict: !!(it.valueConflict || it.conflict),
      })
    }
  }
  return out
}

// ===================== 2026-11-13 版式（用户口径）=====================
// 1) 给医生看 → 默认不脱敏（mask 可关）；
// 2) 异常项按时间倒序（新→旧）排在最前，因此「最新指标」段取消（重复信息）；
// 3) 全部指标模块压到最后，值后面直接跟箭头，高=红/低=绿，箭头右对齐 → 少一列「判定」；
// 4) 趋势图（同项 ≥2 次）单独放最后一页，打印时强制分页；
// 5) 顶部固定「打印 / 存 PDF」按钮，打印时自动隐藏。

function svgTrend(points = [], { low = null, high = null, w = 300, h = 78 } = {}) {
  // 自包含 SVG：不依赖任何 JS/外部资源，打印与下载 .html 都能出图
  const vals = points.map((p) => Number(p.value)).filter((n) => Number.isFinite(n))
  if (vals.length < 2) return ''
  const pad = 18
  let min = Math.min(...vals, ...(low !== null ? [low] : []))
  let max = Math.max(...vals, ...(high !== null ? [high] : []))
  if (max === min) { max += 1; min -= 1 }
  const span = max - min
  min -= span * 0.12
  max += span * 0.12
  const x = (i) => pad + (i * (w - pad * 2)) / (points.length - 1)
  const y = (v) => h - pad - ((Number(v) - min) / (max - min)) * (h - pad * 2)
  const band = (low !== null && high !== null)
    ? `<rect x="${pad}" y="${y(high).toFixed(1)}" width="${w - pad * 2}" height="${Math.max(1, y(low) - y(high)).toFixed(1)}" fill="#22c55e" opacity="0.08"/>`
    : ''
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const dots = points.map((p, i) => {
    const c = p.flag === 'high' ? '#b91c1c' : p.flag === 'low' ? '#15803d' : '#6b7280'
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.6" fill="${c}"/>`
  }).join('')
  const labels = points.map((p, i) => `<text x="${x(i).toFixed(1)}" y="${h - 4}" font-size="7.5" fill="#9ca3af" text-anchor="middle">${(p.measuredAt || '').slice(5)}</text>`).join('')
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg">${band}<path d="${path}" fill="none" stroke="#2563eb" stroke-width="1.4"/>${dots}${labels}</svg>`
}

function renderHtml(card) {
  const p = card.patient || {}
  const s = card.summary || {}
  const rows = flattenRows(card.groups)
  const byName = new Map()
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, [])
    byName.get(r.name).push(r)
  }
  // 异常项：全部历史异常，按时间新→旧（用户口径）
  const abnormal = rows
    .filter((r) => r.flag === 'high' || r.flag === 'low' || r.flag === 'abnormal')
    .sort((a, b) => String(b.measuredAt).localeCompare(String(a.measuredAt)))
  // 全部指标：每项取最近一次，按医生阅读顺序（沿用分组顺序）
  const latestByName = []
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.name)) continue
    seen.add(r.name)
    latestByName.push(r)
  }
  // 趋势：同项 ≥2 次且有关键词优先，最多 8 条
  const trendRows = []
  for (const [name, list] of byName) {
    if (list.length < 2) continue
    if (!/白细胞|血红蛋白|血小板|中性粒|CRP|C反应蛋白|乳酸脱氢|骨髓原始|MRD/i.test(name)) continue
    const sorted = list.slice().sort((a, b) => String(b.measuredAt).localeCompare(String(a.measuredAt)))
    trendRows.push({ name, points: sorted.slice(0, 6), refRange: sorted[0].refRange })
  }
  const trendTop = trendRows.slice(0, 8)
  const missing = s.missingBasics || s.missing || []

  const color = (f) => (f === 'high' ? '#b91c1c' : f === 'low' ? '#15803d' : '#111827')
  const arrow = (f) => (f === 'high' ? '↑' : f === 'low' ? '↓' : '')
  const refText = (r) => r.refRange || ((r.refLow !== null || r.refHigh !== null) ? `${r.refLow ?? ''}–${r.refHigh ?? ''}` : '—')
  // 少一列：判定并入「数值」列，箭头右对齐
  const tr = (r) => `<tr>
      <td>${esc(r.name)}</td>
      <td class="v"><div class="vwrap"><span class="num" style="color:${color(r.flag)}">${esc(r.value ?? '')}${esc(r.unit ? ' ' + r.unit : '')}</span><span class="ar" style="color:${color(r.flag)}">${arrow(r.flag)}${r.valueConflict ? '*' : ''}</span></div></td>
      <td class="ref">${esc(refText(r))}</td>
      <td class="d">${esc(r.measuredAt || '—')}</td>
    </tr>`

  const twoCol = (list) => {
    const half = Math.ceil(list.length / 2)
    return `<div class="two">${[list.slice(0, half), list.slice(half)]
      .map((part) => `<div><table><thead><tr><th>项目</th><th class="v">数值</th><th class="ref">参考</th><th class="d">日期</th></tr></thead><tbody>${part.map(tr).join('')}</tbody></table></div>`)
      .join('')}</div>`
  }

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>问诊资料卡 · ${esc(p.name || '病友')}</title>
<style>
  @page { size: A4; margin: 9mm; }
  body { font: 10.5px/1.45 -apple-system, "PingFang SC", sans-serif; color: #111827; margin: 0; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .meta { color: #4b5563; font-size: 10px; margin-bottom: 4px; }
  h2 { font-size: 11.5px; margin: 8px 0 3px; padding-bottom: 1px; border-bottom: 1px solid #e5e7eb; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #e5e7eb; padding: 1px 4px; text-align: left; font-size: 9.5px; }
  th { background: #f9fafb; font-weight: 600; }
  td.v { white-space: nowrap; width: 20%; }
  td.v .vwrap { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  td.v .num { font-weight: 600; }
  td.v .ar { font-weight: 700; text-align: right; min-width: 10px; }
  th.v { width: 20%; }
  th[data-col='name'], td:first-child { width: 42%; }
  th.ref, td.ref { width: 22%; }
  th.d, td.d { width: 16%; }
  td.ref, td.d { white-space: nowrap; color: #6b7280; }
  .warn { background: #fff7ed; border: 1px solid #fdba74; padding: 3px 6px; font-size: 9.5px; margin-bottom: 4px; }
  .q { border: 1px dashed #d1d5db; padding: 3px 6px; font-size: 9.5px; min-height: 13px; color: #6b7280; }
  .two { display: flex; gap: 6px; } .two > div { flex: 1; min-width: 0; }
  .trends { page-break-before: always; }
  .trend-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
  .trend-cell { border: 1px solid #e5e7eb; border-radius: 4px; padding: 3px 5px; }
  .trend-cell .t { font-size: 10px; font-weight: 600; margin-bottom: 1px; }
  .trend-cell .t span { font-weight: 400; color: #6b7280; }
  .foot { margin-top: 5px; color: #6b7280; font-size: 9px; }
  .printbar { position: fixed; top: 6px; right: 6px; z-index: 9; background: #fff; padding: 2px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .printbar button { font: 11px -apple-system; padding: 4px 10px; border: 1px solid #d1d5db; background: #fff; border-radius: 6px; cursor: pointer; }
  @media print { .printbar { display: none !important; } }
</style></head><body>
<div class="printbar"><button onclick="window.print()">打印 / 存 PDF</button></div>
<h1>问诊资料卡 · ${esc(p.name || '（姓名未填）')} ${esc(p.sex || '')}${p.age ? ' · ' + esc(p.age) + '岁' : ''}</h1>
<div class="meta">
  诊断：${esc(p.diagnosis || '—')}${p.subtype ? '（' + esc(p.subtype) + '）' : ''} ｜ 阶段：${esc(p.stage || '—')} ｜
  报告 ${card.counts.reports} 份 / 指标 ${card.counts.rows} 项 / 异常 ${abnormal.length} 项 ｜ 生成：${esc(String(card.generatedAt).slice(0, 16).replace('T', ' '))}
</div>
${card.masked ? '<div class="warn">姓名已脱敏（给医生看时建议关闭脱敏）。</div>' : ''}
${missing.length ? `<div class="warn">未提供：${missing.map(esc).join('、')} —— 「没查」与「没给我」临床含义不同，请医生注意。</div>` : ''}

<h2>① 异常项（按时间从新到旧，共 ${abnormal.length} 项）</h2>
${abnormal.length
  ? `<table><thead><tr><th>项目</th><th class="v">数值</th><th class="ref">参考</th><th class="d">日期</th></tr></thead><tbody>${abnormal.map(tr).join('')}</tbody></table>`
  : '<div class="q">本次资料里没有越出参考区间的项目（或未识别到参考区间）</div>'}

<h2>② 家属三问</h2>
<div class="two">
  <div class="q">本次最想解决：${esc(p.questions?.focus || '')}</div>
  <div class="q">想请医生确认：${esc(p.questions?.confirm || '')}</div>
  <div class="q">下次复查时间：${esc(p.questions?.nextVisit || '')}</div>
</div>

<h2>③ 全部指标（每项取最近一次，共 ${latestByName.length} 项）</h2>
${latestByName.length ? twoCol(latestByName) : '<div class="q">尚未识别出指标</div>'}

<div class="trends">
<h2>④ 关键趋势（同项 ≥2 次才显示，共 ${trendTop.length} 项）</h2>
${trendTop.length
  ? `<div class="trend-grid">${trendTop.map((t) => {
      const [lo, hi] = String(t.refRange || '').split('-').map((x) => (x === '' || x === undefined ? null : Number(x)))
      return `<div class="trend-cell"><div class="t">${esc(t.name)} <span>（参考 ${esc(t.refRange || '—')}）</span></div>${svgTrend(t.points, { low: Number.isFinite(lo) ? lo : null, high: Number.isFinite(hi) ? hi : null })}</div>`
    }).join('')}</div>`
  : '<div class="q">暂无可比较的历史值（同一项目出现 2 次以上才会显示趋势）</div>'}
</div>

${card.counts.valueConflicts ? `<div class="foot" style="color:#b45309">注：标 * 的 ${card.counts.valueConflicts} 项在原图切块边界上读出过不同数值，已按出现次数最多的取值采用，原始单据可回查。</div>` : ''}
<div class="foot">本卡只陈述家属提供的数值、日期与判定，不含诊断结论与治疗建议。MedBrief 问诊资料卡。</div>
</body></html>`
}

export const INTAKE_ROOT = ROOT
