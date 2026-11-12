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
  const flat = flattenRows(groups)

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
  const trendTop = trendRows.slice().sort((a, b) => TREND_PRIORITY(a.name) - TREND_PRIORITY(b.name)).slice(0, 8)
  const showName = mask ? maskName(patient.name) : patient.name
  const card = {
    ok: true,
    generatedAt: new Date().toISOString(),
    masked: !!mask,
    patient: { ...patient, name: showName },
    counts: { reports: reports.length, rows: flat.length, latest: latestRows.length, trends: trendTop.length, trendsAll: trendRows.length, groups: groups.length },
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
      })
    }
  }
  return out
}

// 一页 A4 的排版约束（2026-11-12 实测：35 项 × 3 份 ≈ 105 行，去掉「最近三次」列 + 10px/10mm 才装得下）
function renderHtml(card) {
  const p = card.patient || {}
  const s = card.summary || {}
  const rows = flattenRows(card.groups)
  const abnormal = rows.filter((r) => r.flag === 'high' || r.flag === 'low' || r.flag === 'abnormal')

  // 每一项一行：绝不能一组只渲染一行（曾导致 105 项只显示 6 行 = 静默丢 99 项）
  const tr = (r) => `<tr>
      <td>${esc(r.name)}</td>
      <td style="color:${flagColor(r.flag)};font-weight:600;white-space:nowrap">${esc(r.value ?? '')} ${esc(r.unit)}</td>
      <td style="white-space:nowrap">${esc(r.refRange || '—')}</td>
      <td style="white-space:nowrap">${esc(r.measuredAt || '—')}</td>
      <td style="color:${flagColor(r.flag)};white-space:nowrap">${flagText(r.flag)}</td>
    </tr>`

  const table = (list, empty, withCat) => {
    if (!list || !list.length) return `<div class="q">${esc(empty)}</div>`
    let body = ''
    let curCat = ''
    for (const r of list) {
      if (withCat && r.cat !== curCat) {
        curCat = r.cat
        body += `<tr class="cat"><td colspan="5">${esc(curCat)}</td></tr>`
      }
      body += tr(r)
    }
    return `<table><thead><tr><th>项目</th><th>结果</th><th>参考区间</th><th>日期</th><th>判定</th></tr></thead><tbody>${body}</tbody></table>`
  }

  const missing = s.missingBasics || s.missing || []

  // 两栏并排：35 项一行一栏会撑到 2 页，拆两栏后 18 行装得下
  const twoCol = (list) => {
    const half = Math.ceil(list.length / 2)
    return `<div class="two">${[list.slice(0, half), list.slice(half)]
      .map((part) => `<div><table><thead><tr><th>项目</th><th>结果</th><th>参考</th><th>日期</th><th>判定</th></tr></thead><tbody>${part.map(tr).join('')}</tbody></table></div>`)
      .join('')}</div>`
  }
  const trendTable = (list) => (list.length
    ? `<table><thead><tr><th>项目</th><th>最近三次（新 → 旧）</th></tr></thead><tbody>${list.map((t) => `<tr><td style="white-space:nowrap">${esc(t.name)}</td><td style="font-size:9.5px">${t.points.map((x) => `${esc(x.value)}${x.unit ? ' ' + esc(x.unit) : ''}（${esc(x.measuredAt || '—')}${x.flag === 'high' ? ' ↑' : x.flag === 'low' ? ' ↓' : ''}）`).join(' → ')}</td></tr>`).join('')}</tbody></table>`
    : '<div class="q">暂无可比较的历史值（同一项目出现 2 次以上才会显示趋势）</div>')

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>问诊资料卡 · ${esc(p.name || '病友')}</title>
<style>
  @page { size: A4; margin: 9mm; }
  body { font: 10.5px/1.4 -apple-system, "PingFang SC", sans-serif; color: #111827; margin: 0; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .meta { color: #4b5563; font-size: 10px; margin-bottom: 4px; }
  h2 { font-size: 11.5px; margin: 7px 0 3px; padding-bottom: 1px; border-bottom: 1px solid #e5e7eb; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #e5e7eb; padding: 1px 4px; text-align: left; font-size: 9.5px; }
  th { background: #f9fafb; font-weight: 600; }
  tr.cat td { background: #f3f4f6; font-weight: 600; font-size: 9px; color: #374151; }
  .warn { background: #fff7ed; border: 1px solid #fdba74; padding: 3px 6px; font-size: 9.5px; margin-bottom: 4px; }
  .q { border: 1px dashed #d1d5db; padding: 3px 6px; font-size: 9.5px; min-height: 13px; color: #6b7280; }
  .foot { margin-top: 5px; color: #6b7280; font-size: 9px; }
  .two { display: flex; gap: 6px; }
  .two > div { flex: 1; min-width: 0; }
</style></head><body>
<h1>问诊资料卡 · ${esc(p.name || '（姓名未填）')} ${esc(p.sex || '')}${p.age ? ' · ' + esc(p.age) + '岁' : ''}</h1>
<div class="meta">
  诊断：${esc(p.diagnosis || '—')}${p.subtype ? '（' + esc(p.subtype) + '）' : ''} ｜ 阶段：${esc(p.stage || '—')} ｜
  报告 ${card.counts.reports} 份 / 指标 ${card.counts.rows} 项 / 异常 ${abnormal.length} 项 ｜ 生成：${esc(String(card.generatedAt).slice(0, 16).replace('T', ' '))}
</div>
${card.masked ? '<div class="warn">姓名已脱敏；资料由家属提供、未经本院核实，仅用于门诊沟通。</div>' : ''}
${missing.length ? `<div class="warn">未提供：${missing.map(esc).join('、')} —— 「没查」与「没给我」临床含义不同，请医生注意。</div>` : ''}
<h2>① 异常项（优先看，${abnormal.length} 项）</h2>
${table(abnormal, '本次资料里没有越出参考区间的项目（或未识别到参考区间）', false)}
<h2>② 最新指标（每项取最近一次，共 ${card.counts.latest} 项）</h2>
${twoCol(card.latestRows || [])}
<h2>③ 关键趋势（同项 ≥2 次才显示，共 ${card.counts.trends} 项）</h2>
${trendTable(card.trendRows || [])}
<h2>④ 家属三问</h2>
<div class="two">
  <div class="q">本次最想解决：${esc(p.questions?.focus || '')}</div>
  <div class="q">想请医生确认：${esc(p.questions?.confirm || '')}</div>
  <div class="q">下次复查时间：${esc(p.questions?.nextVisit || '')}</div>
</div>
<div class="foot">本卡只陈述家属提供的数值、日期与判定，不含诊断结论与治疗建议。MedBrief 问诊资料卡。</div>
</body></html>`
}

export const INTAKE_ROOT = ROOT
