// MedBrief · 问诊资料卡（渲染层 · v3）
// 分工：取数/识别/查重/拼接在 lib/reportIntake.mjs（代诊-报告维护）；字段清洗在 lib/labClean.mjs；
//       临床口径（P0/P1、危急值、缺项、时效）在 lib/cardPolicy.mjs；本文件只做「病友档案 + 1+1+1 资料卡」。
// 设计文档：docs/问诊卡逻辑.md（v3）
//
// 隐私边界（不可改）：
//   1. 只落本机 data/intake/**（已 gitignore），不上外网，不进版本库；
//   2. 不收集身份证/手机号；姓名默认**不**脱敏（2026-11-13 用户口径：这是给医生看的），显式 mask=1 才脱敏；
//   3. 卡片只陈述数值、日期、出处与趋势，不写诊断结论/治疗建议（红线见 testing-lessons）。
//
// v3 版式（1+1+1）：
//   第 1 页 核心速览：抬头(含缺项/时效警示) → 临床背景与骨穿节点 → 核心异常项(P0 展开/P1 折叠) → 家属三问
//   第 2 页 全量归档：全部指标(按 code 去重，按临床大类分组双栏)。材料清单**不进纸**——它在应用内「报告库」页
//   第 3 页 关键趋势：内联 SVG，跨院参考区间不同则给警示而不是画假绿带

import fs from 'node:fs'
import path from 'node:path'
import { groupForDoctorCard } from './reportIntake.mjs'
import { classifyAnalyte } from './reportIntake.mjs'
import { normalizeRow } from './labClean.mjs'
import { criticalOf, isP0, REQUIRED_BASICS, STALE_DAYS, daysAgo } from './cardPolicy.mjs'

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
  // v3 新增：血液科关键临床背景（可选，只读展示；录入走 patient.json 或 UI 表单，卡面不写）
  clinicalContext: { lastChemo: '', recentTxOrGcsf: '', marrowSummary: '' },
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
  if (!p) return { ...DEFAULT_PATIENT, questions: { ...DEFAULT_PATIENT.questions }, clinicalContext: { ...DEFAULT_PATIENT.clinicalContext } }
  return {
    ...DEFAULT_PATIENT,
    ...p,
    questions: { ...DEFAULT_PATIENT.questions, ...(p.questions || {}) },
    clinicalContext: { ...DEFAULT_PATIENT.clinicalContext, ...(p.clinicalContext || {}) },
  }
}

export function savePatient(patch = {}) {
  const cur = loadPatient()
  const next = {
    ...cur,
    ...patch,
    questions: { ...cur.questions, ...(patch.questions || {}) },
    clinicalContext: { ...cur.clinicalContext, ...(patch.clinicalContext || {}) },
    id: 'p1',
    updatedAt: new Date().toISOString(),
  }
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
const color = (f) => (f === 'high' ? '#b91c1c' : f === 'low' ? '#15803d' : '#111827')
const arrow = (f) => (f === 'high' ? '↑' : f === 'low' ? '↓' : '')

/** 参考区间解析：非法（high < low）返回 null —— 不猜。 */
export function parseRefRange(s) {
  const m = String(s || '').match(/(-?\d+(?:\.\d+)?)\s*(?:--|—|–|~|〜|-|至)\s*(-?\d+(?:\.\d+)?)/)
  if (!m) return null
  const lo = Number(m[1]); const hi = Number(m[2])
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null
  return { lo, hi }
}

/**
 * 判定高低：① 先认报告自带箭头（flag）→ ② 再按参考区间比 → ③ 区间非法则置空不猜。
 * ⚠️ 必须在字段清洗之后调用：清洗前有 9 行 refRange 里存的是单位（`sec`/`%`），
 *    照旧值判会得到 unknown，那些真异常的项就静默消失了。
 */
export function judgeFlag(row = {}) {
  const own = String(row.flag || row.status || '')
  if (own === 'high' || own === 'low') return own
  if (own === 'positive') return 'high'      // 定性阳性按异常处理（不写程度）
  if (own === 'normal' || own === 'negative') return 'normal'
  const ref = parseRefRange(row.refRange)
  const num = Number(row.num ?? row.value)
  if (!ref || !Number.isFinite(num)) return ''
  if (num > ref.hi) return 'high'
  if (num < ref.lo) return 'low'
  return 'normal'
}

/**
 * 生成资料卡
 * @param {object}  opts
 * @param {Array}   opts.reports  已导入的报告（每条含 rows[]、reportDate、kind、hospital，可选 fileBlobId）
 * @param {boolean} opts.mask     是否脱敏姓名（默认 false —— 给医生看）
 * @param {Date}    opts.today    注入「今天」用于时效计算（测试用；默认当前时间）
 */
export function buildCard({ reports = [], mask = false, today = null, patient: injectPatient = null } = {}) {
  const patient = injectPatient || loadPatient()
  const todayDate = today ? new Date(today) : new Date()

  // ---------- 1) 展平 + 读侧清洗 + code 注入 ----------
  const rows = []
  for (const rep of reports) {
    for (const raw of rep.rows || []) {
      const n = normalizeRow(raw)
      const code = raw.code || classifyAnalyte(n.name, { loose: !!n.nameDirty }).code || null
      rows.push({
        ...n,
        code,
        measuredAt: n.measuredAt || rep.reportDate || '',
        reportDate: rep.reportDate || '',
        reportId: rep.id || '',
        kind: rep.kind || 'lab',
        hospital: rep.hospital || '',
        fileBlobId: rep.fileBlobId || '',
      })
    }
  }

  // ---------- 2) 分组（唯一登记处是 reportIntake 的 ANALYTE_CATALOG） ----------
  // groupForDoctorCard 只保留固定字段：把清洗层判定先挂在 name 上做键，回贴时再取（见下方 extra map）
  const groups = groupForDoctorCard(rows)
  const flat = flattenRows(groups)
  // groupForDoctorCard 只保留固定字段 → 把清洗层的留痕字段按 (名称|值|日期) 贴回
  const extra = new Map()
  for (const r of rows) extra.set(`${r.name}|${r.value}|${r.measuredAt}`, r)
  for (const r of flat) {
    const src = extra.get(`${r.name}|${r.value}|${r.measuredAt}`)
    if (!src) continue
    r.nameDirty = src.nameDirty
    r.qualitative = src.qualitative
    r.proseValue = src.proseValue
    r.repaired = src.repaired
    r.unit = r.unit || src.unit
    if (src.valueConflict || src.conflict) r.valueConflict = true
  }
  // 判定：一律按「清洗后的字段」重算，报告自带箭头优先
  for (const r of flat) r.flag = judgeFlag(r)

  // ---------- 3) 每项取最近一次（v3：异常项只看最新状态，历史波动交给趋势页） ----------
  const keyOf = (r) => r.code || `name:${r.name}`
  const byKey = new Map()
  for (const r of flat) {
    const k = keyOf(r)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(r)
  }
  for (const list of byKey.values()) list.sort((a, b) => {
    const d = String(b.measuredAt).localeCompare(String(a.measuredAt))
    if (d) return d
    // 同一天同一项可能有两行：一行是真值、一行是 OCR 把参考说明写成了值（实测 NT-proBNP「慢性心衰」）
    // → 有数值的优先，避免卡面展示一句描述当测量值
    return Number(Number.isFinite(Number(b.num)) && !b.proseValue) - Number(Number.isFinite(Number(a.num)) && !a.proseValue)
  })

  const latestAll = []      // 全部指标：每项一行（取最新）
  const abnormalLatest = [] // 最新状态下的异常项
  for (const [k, list] of byKey) {
    const top = list[0]
    latestAll.push(top)
    if (top.flag === 'high' || top.flag === 'low') abnormalLatest.push(top)
  }

  // ---------- 4) P0/P1 分层 + 排序（危急优先 → 日期新到旧） ----------
  const p0rows = []
  const p1rows = []
  for (const r of abnormalLatest) {
    r.critical = criticalOf(r)
    if (isP0(r)) p0rows.push(r); else p1rows.push(r)
  }
  const byDateDesc = (a, b) => String(b.measuredAt).localeCompare(String(a.measuredAt))
  // 2026-11-13 用户口径：① 危急值顶格；② 其余按器官系统聚合（凝血→炎症→血常规→肝肾功→其他），
  // 同一系统内再按时间新→旧 —— 否则医生视线会在不同系统之间反复横跳。
  const SYS_RANK = { COAG: 1, INFLAM: 2, IMMUNE: 2, CBC: 3, DISEASE: 3, CHEM: 4, IRON: 4, URINE: 5, GAS: 5, MICRO: 6 }
  const sysOf = (r) => SYS_RANK[r.catKey] || 9
  p0rows.sort((a, b) => (Number(!!b.critical) - Number(!!a.critical)) || (sysOf(a) - sysOf(b)) || byDateDesc(a, b))
  p1rows.sort((a, b) => (sysOf(a) - sysOf(b)) || byDateDesc(a, b))

  // ---------- 5) 趋势（按 code 聚类，单位不可统一则不硬拼） ----------
  // 趋势优先序：按 code **或** 名称关键词判（真实数据里骨髓/MRD 项常常没有 code，
  // 只按 code 排会让它们掉到末尾、被 8 项上限截掉 —— 而那正是血液科最该看的）
  // 用户 2026-11-13 指定：**只画血液科核心 8 项**，MCH/MCHC/PDW/中性粒% 这类次要参数直接不上图。
  // 判定按 code（唯一），name 只在没有 code 时兜底 —— 否则 `中性粒|ANC` 这类模糊正则会同时命中
  // 「中性粒细胞百分比」和「中性粒细胞计数」，把次要项挤进前 8（实测踩到）。
  const TREND_CODES = [
    'BM_BLAST_PCT', 'FCM_MRD_PCT', 'MRD',           // 疾病特异
    'WBC', 'NEUT_ABS', 'Hb', 'PLT',                  // 血常规核心
    'LDH', 'FIB', 'D_DIMER', 'PCT', 'CRP', 'HS_CRP', // 生化 / 凝血 / 炎症
  ]
  const TREND_NAME_FALLBACK = [
    [/骨髓原始|原始细胞/, 0], [/MRD|微小残留|异常细胞占/i, 1],
    [/白细胞(?!介素)/, 3], [/中性粒细胞计数|ANC/i, 4], [/血红蛋白|^Hb$/i, 5], [/^血小板|血小板(?!分布|平均|压积)/, 6],
    [/乳酸脱氢|LDH/i, 7], [/纤维蛋白原|FIB/i, 8], [/D-?二聚体|D_?DIMER/i, 9],
    [/降钙素原|PCT/i, 10], [/CRP|C反应蛋白/i, 11],
  ]
  const trendRank = (row) => {
    // 有 code 就以 code 为准：不在白名单 = 99（不许再拿名字兜回白名单，否则 MCH/MCHC/PDW 会顶掉核心项）
    if (row.code) { const i = TREND_CODES.indexOf(row.code); return i >= 0 ? i : 99 }
    const hit = TREND_NAME_FALLBACK.find(([re]) => re.test(row.name))
    return hit ? hit[1] : 99   // 99 = 不在白名单 → 不画
  }
  const trendCandidates = []
  for (const [k, list] of byKey) {
    if (list.length < 2) continue
    // 单位归一后再比较：`seC`/`sec`、`10~9/L`/`10^9/L` 是同一个单位的不同 OCR 写法，
    // 不做归一化会让同一项被判成「不可比」而悄悄丢掉趋势（实测丢了 27/35 条）。
    const unitKey = (u) => String(u || '').trim().toLowerCase().replace(/[×\s]/g, '').replace(/10[~^°]/, '10^')
    const units = new Set(list.filter((r) => !r.qualitative).map((r) => unitKey(r.unit)).filter(Boolean))
    const comparable = units.size <= 1   // 单位确实不一致且无换算表 → 不硬拼（v3：宁缺不错）
    // 只留「有数值」的点（定性值如「阴性/阳性/未见」会画成 0 或错点 —— 实测白细胞图里混进过尿白细胞「阴性」）
    // 同一天可能有多份报告各出一个值（实测 07-17 出现两次）→ 按日期去重，保留当天最后一条
    const byDay = new Map()
    for (const r of list) {
      if (!Number.isFinite(Number(r.num)) || r.qualitative) continue
      const d = String(r.measuredAt || '').slice(0, 10)
      if (!byDay.has(d)) byDay.set(d, r)
    }
    const numPoints = [...byDay.values()].sort((a, b) => String(b.measuredAt).localeCompare(String(a.measuredAt)))
    if (numPoints.length < 2) continue
    // X 轴必须「左旧右新」：list 是降序（新→旧），取最近 6 个后 reverse 成正序
    const picked = numPoints.slice(0, 6).reverse()
    trendCandidates.push({
      key: k, name: list[0].name, code: list[0].code,
      points: picked.map((r) => ({ value: r.value, num: Number(r.num), unit: r.unit, measuredAt: r.measuredAt, flag: r.flag, hospital: r.hospital, refRange: r.refRange })),
      comparable, units: [...units],
      rank: trendRank(list[0]),
      refRanges: [...new Set(numPoints.map((r) => String(r.refRange || '').trim()).filter(Boolean))],
    })
  }
  const trendTop = trendCandidates
    .filter((t) => t.comparable && t.rank < 99)   // 白名单外的一律不画（不是「排后面」，是不出现在图上）
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 8)

  // ---------- 6) 缺项 / 时效 ----------
  const seenCodes = new Set(latestAll.map((r) => r.code).filter(Boolean))
  const missingBasics = REQUIRED_BASICS.filter((b) => !seenCodes.has(b.code)).map((b) => b.label)
  const labDates = reports
    .filter((r) => (r.rows || []).length > 0)
    .map((r) => String(r.reportDate || '').slice(0, 10))
    .filter(Boolean)
    .sort()
  const lastLabDate = labDates.length ? labDates[labDates.length - 1] : ''
  const staleDays = lastLabDate ? daysAgo(lastLabDate, todayDate) : null

  // ---------- 7) 材料清单（含无 rows 的报告：标「未结构化（仅存原件）」，绝不标「0 项」） ----------
  const materialRows = reports
    .map((r) => ({
      id: r.id || '',
      reportDate: r.reportDate || '',
      hospital: r.hospital || '',
      kind: r.kind || 'lab',
      rowCount: (r.rows || []).length,
      source: r.source || 'image',
      fileBlobId: r.fileBlobId || '',
    }))
    .sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)))

  // 「日期 + 医院」聚合（纸质/PDF 一行一组；Web 可展开）
  const materialGroups = (() => {
    const m = new Map()
    for (const r of materialRows) {
      const key = `${r.reportDate}|${r.hospital}`
      if (!m.has(key)) m.set(key, { reportDate: r.reportDate, hospital: r.hospital, items: [], byKind: {}, rowCount: 0 })
      const g = m.get(key)
      g.items.push(r)
      g.byKind[r.kind] = (g.byKind[r.kind] || 0) + 1
      g.rowCount += r.rowCount
    }
    return [...m.values()]
  })()

  const card = {
    ok: true,
    generatedAt: new Date().toISOString(),
    masked: !!mask,
    patient: { ...patient, name: mask ? maskName(patient.name) : patient.name },
    counts: {
      reports: reports.length,
      rows: flat.length,
      latest: latestAll.length,
      groups: groups.length,
      p0: p0rows.length,
      p1: p1rows.length,
      critical: [...p0rows, ...p1rows].filter((r) => r.critical).length,
      trends: trendTop.length,
      trendsAll: trendCandidates.length,
      trendsDropped: trendCandidates.length - trendTop.length,
      trendsIncomparable: trendCandidates.filter((t) => !t.comparable).length,
      valueConflicts: flat.filter((r) => r.valueConflict).length,
      material: materialRows.length,
      materialGroups: materialGroupCount(materialRows),
      unstructured: materialRows.filter((m) => m.rowCount === 0).length,
      missingBasics,
      lastLabDate,
      staleDays,
    },
    p0rows,
    p1rows,
    latestRows: latestAll,
    trendRows: trendTop,
    trendDroppedDetail: trendCandidates.filter((t) => !t.comparable).map((t) => ({ name: t.name, units: t.units })),
    materialRows,
    materialGroups,
    groups,
  }
  card.html = renderHtml(card)
  return card
}

function materialGroupCount(rows = []) {
  return new Set(rows.map((r) => `${r.reportDate}|${r.hospital}`)).size
}

function flattenRows(groups) {
  const out = []
  for (const g of groups || []) {
    for (const it of g.items || g.rows || []) {
      out.push({
        cat: g.label || g.cat || '其他项',
        catKey: g.cat || '',
        name: it.name || it.label || it.code || '',
        code: it.code || null,
        value: it.value,
        unit: it.unit || '',
        refRange: it.refRange || '',
        num: it.num,
        measuredAt: it.measuredAt || it.reportDate || '',
        flag: it.flag || (it.status === 'high' ? 'high' : it.status === 'low' ? 'low' : it.status === 'normal' ? 'normal' : ''),
        valueConflict: !!(it.valueConflict || it.conflict),
        proseValue: !!it.proseValue,
        hospital: it.hospital || '',
      })
    }
  }
  return out
}

// ===================== v3 版式（1+1+1） =====================

function svgTrend(points = [], { low = null, high = null, w = 300, h = 76 } = {}) {
  const vals = points.map((p) => Number(p.num ?? p.value)).filter((n) => Number.isFinite(n))
  if (vals.length < 2) return ''
  const pad = 16
  let min = Math.min(...vals, ...(low !== null ? [low] : []))
  let max = Math.max(...vals, ...(high !== null ? [high] : []))
  if (max === min) { max += 1; min -= 1 }
  const span = max - min
  min -= span * 0.14
  max += span * 0.14
  const x = (i) => pad + (i * (w - pad * 2)) / (points.length - 1)
  const y = (v) => h - pad - ((Number(v) - min) / (max - min)) * (h - pad * 2)
  const band = (low !== null && high !== null)
    ? `<rect x="${pad}" y="${y(high).toFixed(1)}" width="${w - pad * 2}" height="${Math.max(1, y(low) - y(high)).toFixed(1)}" fill="#22c55e" opacity="0.10"/>`
    : ''
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.num ?? p.value).toFixed(1)}`).join(' ')
  const dots = points.map((p, i) => {
    const f = p.flag
    const c = f === 'high' ? '#b91c1c' : f === 'low' ? '#15803d' : '#6b7280'
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.num ?? p.value).toFixed(1)}" r="2.6" fill="${c}"/>`
  }).join('')
  const labels = points.map((p, i) => `<text x="${x(i).toFixed(1)}" y="${h - 3}" font-size="7.5" fill="#9ca3af" text-anchor="middle">${esc(String(p.measuredAt || '').slice(5))}</text>`).join('')
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg">${band}<path d="${path}" fill="none" stroke="#2563eb" stroke-width="1.4"/>${dots}${labels}</svg>`
}

function renderHtml(card) {
  const p = card.patient || {}
  const c = card.counts || {}
  const ctx = p.clinicalContext || {}
  const KIND_LABEL = { lab: '化验', pathology: '病理/流式', imaging: '影像', discharge: '出院小结', drug: '用药', unknown: '其他' }

  // 少一列：判定并入「数值」列，箭头右对齐（高=红↑ / 低=绿↓）
  const tr = (r, { critical = false, showHospital = true } = {}) => `<tr${critical ? ' class="crit"' : ''}>
      <td>${esc(r.name)}${r.nameDirty ? '<sup title="名称含异常字符，需人工核对原文">?</sup>' : ''}${critical ? ' <span class="crit-tag">危急</span>' : ''}</td>
      <td class="v"><div class="vwrap"><span class="num" style="color:${color(r.flag)}">${esc(r.value ?? '')}${esc(r.unit ? ' ' + r.unit : '')}</span><span class="ar" style="color:${color(r.flag)}">${arrow(r.flag)}${r.valueConflict ? '*' : ''}</span></div></td>
      <td class="ref">${esc(r.refRange || '—')}</td>
      <td class="d">${esc(r.measuredAt || '—')}${showHospital && r.hospital ? ' ' + esc(r.hospital) : ''}</td>
    </tr>`

  // 第 2 页「全部指标」：按临床大类分组 + 组内双栏（2026-11-13 用户口径）
  //   字号 10px，项目名**允许换行、不截断**（宁可行高一点，也不许出现「…」）
  const CAT_GROUPS = [
    { label: '血常规及骨髓', cats: ['CBC', 'DISEASE'] },
    { label: '凝血功能', cats: ['COAG'] },
    { label: '生化与肝肾功', cats: ['CHEM', 'IRON'] },
    { label: '炎症与免疫', cats: ['INFLAM', 'IMMUNE'] },
    { label: '尿便与血气', cats: ['URINE', 'GAS'] },
    { label: '其他感染筛查', cats: ['MICRO'] },
    { label: '其他', cats: ['OTHER'] },
  ]
  const groupedRows = (rows) => {
    const out = []
    for (const g of CAT_GROUPS) {
      const items = rows.filter((r) => g.cats.includes(r.catKey))
      if (!items.length) continue
      const half = Math.ceil(items.length / 2)
      const cols = [items.slice(0, half), items.slice(half)]
      const row = (r) => `<tr>
      <td class="nm">${esc(r.name)}${r.valueConflict ? '<sup>*</sup>' : ''}${r.nameDirty ? '<sup>?</sup>' : ''}</td>
      <td class="v"><div class="vwrap"><span class="num" style="color:${color(r.flag)}">${esc(r.value ?? '')}${esc(r.unit ? ' ' + r.unit : '')}</span><span class="ar" style="color:${color(r.flag)}">${arrow(r.flag)}</span></div></td>
      <td class="ref">${esc(r.refRange || '—')}</td>
    </tr>`
      out.push(`<div class="catgrp"><div class="cath">${esc(g.label)} <span>${items.length} 项</span></div>
        <div class="two">${cols.map((part, ci) => `<div><table class="compact cat"><thead${ci ? ' class="ghost"' : ''}><tr><th>项目</th><th class="v">数值</th><th class="ref">参考区间</th></tr></thead><tbody>${part.map(row).join('') || '<tr><td colspan="3">—</td></tr>'}</tbody></table></div>`).join('')}</div>
      </div>`)
    }
    return out.join('')
  }

  // 材料清单三栏并排：54 份报告如果单栏排会撑掉整整一页 A4（实测 2213px → 超）。
  // 每栏自带表头，序号保持全局连续，读的时候按栏竖着扫。
  // 材料清单：按「日期 + 医院」聚合（用户 2026-11-13 定稿）。
  //   纸质/PDF：每组一行（`2026-07-18 某院A  化验 4 · 影像 1  共 19 项`），54 份压成 10 余行，
  //             给第 2 页「全部指标」腾出 200px+ 安全余量；
  //   Web/手机：默认聚合，点开看单份并点「原件」。
  //   绝不为了卡死 3 页而截断指标 —— 指标量真的超一页时允许自然分页（3→4 页）。
  const KIND_SHORT = { lab: '化验', pathology: '病理/流式', imaging: '影像', discharge: '小结', drug: '用药', unknown: '其他' }
  // 材料清单 = **纯静态索引**（2026-11-13 用户拍板：「我打印出来，我还能在纸上点原件吗？」）
  //
  // 删掉按钮的三条理由（按硬度排序）：
  //   1. 打印件上点不了 —— 这是纸，不是屏幕；
  //   2. 卡片是**自包含 HTML**：另存 .html / 发微信 / 转发给医生之后，`/api/intake/blob/...` 是死链
  //      （那个接口只在本机 5174 活着），按钮从「可点」变成「点了 404」，比没有更糟；
  //   3. 真要回看原件，正确位置是应用内「已导入的报告」列表（那里有 id、有缩略图、有上下文），
  //      而不是医生手上这张纸。
  // 所以卡面只留「编号 + 日期 + 医院 + 类型 + 份/项」——纸能口头对上「第 3 份单子」，就够了。
  const materialGroup = (g, i) => {
    const kinds = Object.entries(g.byKind).map(([k, n]) => `${KIND_SHORT[k] || k} ${n}`).join(' · ')
    return `<div class="matg">
      <span class="idx">${i + 1}</span>
      <span class="dt">${esc(String(g.reportDate || '').slice(5) || '—')}</span>
      <span class="hs">${esc(g.hospital || '—')}</span>
      <span class="kd">${esc(kinds)}</span>
      <span class="ct">${g.items.length} 份 · ${g.rowCount > 0 ? g.rowCount + ' 项' : '仅原件'}</span>
    </div>`
  }
  const materialList = (groups) => groups.length
    ? `<div class="matlist">${groups.map((g, i) => materialGroup(g, i)).join('')}</div>`
    : '<div class="q">还没有入库的报告</div>'

  const staleWarn = (c.staleDays != null && c.staleDays > STALE_DAYS)
    ? `<div class="stale">⚠️ 最近一次有指标的化验为 ${esc(c.lastLabDate)}（距今 ${c.staleDays} 天，已超 ${STALE_DAYS} 天），请注意时效性 —— 下列「最新」均为该日期前的数值，不代表本周情况。</div>`
    : ''

  const p1Summary = card.p1rows.length
    ? `<div class="p1note">另有 ${card.p1rows.length} 项非核心异常（${[...new Set(card.p1rows.map((r) => r.cat))].slice(0, 3).join('/')}${card.p1rows.length > 3 ? ' 等' : ''}），见第 2 页「全部指标」。</div>`
    : ''

  const ctxLine = (label, val) => `<div class="ctx"><span class="k">${label}</span><span class="v">${esc(val || '未录入')}</span></div>`

  const trendCell = (t) => {
    const multiRef = t.refRanges.length > 1
    const ref = multiRef ? null : parseRefRange(t.refRanges[0] || '')
    const warn = multiRef
      ? `<div class="refwarn">⚠️ 跨院参考区间不同：${t.refRanges.map(esc).join(' / ')}</div>`
      : ''
    return `<div class="trend-cell">
      <div class="t">${esc(t.name)} <span>（参考 ${esc(t.refRanges[0] || '—')}）</span>${multiRef ? ' <span class="refwarn-tag">跨院区间</span>' : ''}</div>
      ${warn}${svgTrend(t.points, { low: ref ? ref.lo : null, high: ref ? ref.hi : null })}
      <div class="tpts">${t.points.slice().reverse().map((pt) => `${esc(String(pt.measuredAt || '').slice(5))} ${esc(pt.value)}`).join(' · ')}</div>
    </div>`
  }

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>问诊资料卡 · ${esc(p.name || '病友')}</title>
<style>
  @page { size: A4; margin: 9mm; }
  * { box-sizing: border-box; }
  body { font: 10.5px/1.45 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #111827; margin: 0; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .meta { color: #4b5563; font-size: 10px; margin-bottom: 4px; }
  h2 { font-size: 11.5px; margin: 6px 0 2px; padding-bottom: 1px; border-bottom: 1px solid #e5e7eb; }
  h2 .cnt { color: #6b7280; font-weight: 400; font-size: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #e5e7eb; padding: 1px 4px; text-align: left; font-size: 9.5px; }
  th { background: #f9fafb; font-weight: 600; }
  th.v, td.v { white-space: nowrap; width: 20%; }
  td.v .vwrap { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  td.v .num { font-weight: 600; }
  td.v .ar { font-weight: 700; text-align: right; min-width: 10px; }
  th.ref, td.ref { width: 22%; }
  th.d, td.d { width: 18%; }
  td.ref, td.d { white-space: nowrap; color: #6b7280; }
  tr.crit td { background: #fef2f2; }
  .crit-tag { background: #b91c1c; color: #fff; border-radius: 3px; padding: 0 3px; font-size: 8.5px; }
  .warn { background: #fff7ed; border: 1px solid #fdba74; padding: 3px 6px; font-size: 9.5px; margin-bottom: 4px; }
  .stale { background: #fffbeb; border: 1px solid #f59e0b; color: #92400e; padding: 3px 6px; font-size: 9.5px; margin: 2px 0 4px; border-radius: 3px; }
  .p1note { color: #6b7280; font-size: 9px; margin-top: 2px; }
  .q { border: 1px dashed #d1d5db; padding: 3px 6px; font-size: 9.5px; min-height: 13px; color: #374151; }
  .two { display: flex; gap: 6px; } .two > div { flex: 1; min-width: 0; }
  .three { display: flex; gap: 5px; } .three > div { flex: 1 1 0; min-width: 0; }
  /* 26 组三栏并排（单栏排要 390px），把余量留给「全部指标」；纯静态，无交互 */
  .matlist { margin-top: 2px; display: flex; flex-wrap: wrap; column-gap: 8px; }
  .matg { border-bottom: 1px dotted #e5e7eb; width: calc(33.33% - 6px); display: flex; gap: 5px; align-items: baseline; font-size: 8.2px; line-height: 1.35; }
  .matg > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .matg summary::-webkit-details-marker { display: none; }
  .matg .idx { width: 5%; text-align: right; color: #6b7280; flex: none; }
  .matg .dt { width: 12%; color: #374151; flex: none; }
  .matg .hs { width: 30%; color: #111827; font-weight: 600; }
  .matg .kd { width: 28%; color: #374151; }
  .matg .ct { width: 25%; color: #6b7280; }
  .legend { color: #6b7280; font-size: 8px; margin-top: 2px; line-height: 1.3; }
  .legend b { color: #374151; }
  /* 第 2 页归档表：10px、项目名允许换行不截断（用户口径：宁可高一点，不许出现「…」） */
  table.compact { table-layout: fixed; width: 100%; border-collapse: collapse; }
  table.compact td, table.compact th { border-left: none; border-right: none; }
  table.compact tr:last-child td { border-bottom: none; }
  table.compact.cat th, table.compact.cat td { font-size: 10px; line-height: 1.26; padding: 0 3px; }
  table.compact.cat thead.ghost th { visibility: hidden; padding: 0; height: 0; border: none; }
  table.compact.cat td.nm { white-space: normal; word-break: break-word; }
  table.compact.cat th:nth-child(1) { width: 52%; } table.compact.cat th.v { width: 24%; }
  table.compact.cat th.ref { width: 24%; }
  .catgrp { margin-bottom: 3px; }
  .cath { font-size: 10px; font-weight: 700; color: #1f2937; border-left: 3px solid #94a3b8; padding-left: 5px; margin: 2px 0 1px; }
  .cath span { font-weight: 400; color: #9ca3af; font-size: 9px; }
  .ctx-grid { display: grid; grid-template-columns: 1fr; gap: 1px; }
  .ctx { display: flex; gap: 6px; font-size: 9.5px; border-bottom: 1px dotted #e5e7eb; padding: 1px 0; }
  .ctx .k { color: #6b7280; min-width: 96px; flex: 0 0 96px; }
  .ctx .v { color: #111827; }
  .page2 { page-break-before: always; }
  .page3 { page-break-before: always; }
  .trend-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
  .trend-cell { border: 1px solid #e5e7eb; border-radius: 4px; padding: 3px 5px; }
  .trend-cell .t { font-size: 10px; font-weight: 600; margin-bottom: 1px; }
  .trend-cell .t span { font-weight: 400; color: #6b7280; }
  .tpts { color: #6b7280; font-size: 8.5px; }
  .refwarn { color: #b45309; font-size: 8.5px; }
  .refwarn-tag { color: #b45309; font-size: 8.5px; border: 1px solid #fcd34d; border-radius: 3px; padding: 0 2px; }
  .muted { color: #9ca3af; }
  td.idx { width: 5%; text-align: right; color: #6b7280; }
  td.act { width: 12%; text-align: center; }
  .lnk { font: 9px -apple-system; padding: 1px 5px; border: 1px solid #d1d5db; background: #fff; border-radius: 4px; cursor: pointer; }
  .foot { margin-top: 5px; color: #6b7280; font-size: 9px; }
  .page1 h1, .page1 .meta { padding-right: 132px; } /* 别被右上角固定按钮压住抬头文字（两行 meta 需要更宽） */
  .printbar { position: fixed; top: 6px; right: 6px; z-index: 9; background: #fff; padding: 2px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .printbar button { font: 11px -apple-system; padding: 4px 10px; border: 1px solid #d1d5db; background: #fff; border-radius: 6px; cursor: pointer; }
  .only-print { display: none; }
  @media print { .printbar { display: none !important; } }
  /* 手机直开 HTML：单栏、放大、触控友好（A4 版式在手机上会挤成一条线） */
  @media screen and (max-width: 640px) {
    body { font-size: 14px; line-height: 1.55; padding: 8px; }
    h1 { font-size: 18px; }
    h2 { font-size: 15px; margin-top: 14px; }
    .meta { font-size: 12px; }
    .two { display: block; }
    .two > div { width: 100%; }
    th, td { font-size: 13px; padding: 4px 6px; }
    .trend-grid { grid-template-columns: 1fr; }
    .three { display: block; }
    table.compact th, table.compact td, table.mat td, table.mat th { font-size: 13px; padding: 3px 5px; }
    .matg { width: 100%; font-size: 13px; padding: 3px 0; flex-wrap: wrap; }
    .page2, .page3 { page-break-before: auto; margin-top: 14px; }
    .ctx .k { min-width: 88px; flex: 0 0 88px; }
    .lnk { font-size: 13px; padding: 6px 12px; }
    /* 手机上把打印按钮挪到底部：固定在右上会压住姓名和诊断第一行（实测） */
    .printbar { top: auto; bottom: 12px; right: 12px; }
    .printbar button { font-size: 15px; padding: 10px 16px; }
    .page1 h1, .page1 .meta { padding-right: 0; }
    .stale, .warn, .q { font-size: 13px; }
    table { display: block; overflow-x: auto; }
  }
</style></head><body>
<div class="printbar"><button onclick="window.print()">打印 / 存 PDF</button></div>

<!-- ============ 第 1 页：核心速览 ============ -->
<div class="page1">
<h1>问诊资料卡 · ${esc(p.name || '（姓名未填）')} ${esc(p.sex || '')}${p.age ? ' · ' + esc(p.age) + '岁' : ''}</h1>
<div class="meta">
  诊断：${esc(p.diagnosis || '—')}${p.subtype ? '（' + esc(p.subtype) + '）' : ''} ｜ 阶段：${esc(p.stage || '—')} ｜
  报告 ${c.reports} 份（${esc(c.lastLabDate || '—')} 前）｜ 指标 ${c.rows} 项 / 去重 ${c.latest} 项 ｜ 异常 ${c.p0 + c.p1} 项 ｜ 生成：${esc(String(card.generatedAt).slice(0, 16).replace('T', ' '))}
</div>
${card.masked ? '<div class="warn">姓名已脱敏（给医生看时建议关闭脱敏）。</div>' : ''}
${c.missingBasics && c.missingBasics.length ? `<div class="warn">未提供：${c.missingBasics.map(esc).join('、')} —— 「没查」与「没给我」临床含义不同，请医生注意。</div>` : ''}

<h2>① 临床背景与骨穿节点</h2>
<div class="ctx-grid">
  ${ctxLine('近期治疗节点', ctx.lastChemo)}
  ${ctxLine('近期输血 / 升白针', ctx.recentTxOrGcsf)}
  ${ctxLine('骨穿 / MRD 关键结论', ctx.marrowSummary)}
</div>

<h2>② 核心异常项 <span class="cnt">（每项只看最近一次；P0 展开 ${c.p0} 项）</span></h2>
${staleWarn}
${card.p0rows.length
  ? `<table><thead><tr><th>项目</th><th class="v">数值</th><th class="ref">参考</th><th class="d">日期 · 医院</th></tr></thead><tbody>${card.p0rows.map((r) => tr(r, { critical: !!r.critical })).join('')}</tbody></table>`
  : '<div class="q">本次资料里 P0 核心项没有越出参考区间的记录（或未识别到参考区间）</div>'}
${p1Summary}

<h2>③ 家属三问</h2>
<div class="two">
  <div class="q">本次最想解决：${esc(p.questions?.focus || '')}</div>
  <div class="q">想请医生确认：${esc(p.questions?.confirm || '')}</div>
  <div class="q">下次复查时间：${esc(p.questions?.nextVisit || '')}</div>
</div>
</div>

<!-- ============ 第 2 页：全量归档与原件索引 ============ -->
<div class="page2">
<h2>④ 全部指标 <span class="cnt">（按标准编码去重后共 ${c.latest} 项，按临床大类分组；每项取最近一次，全量不删项）</span></h2>
${card.latestRows.length ? groupedRows(card.latestRows) : '<div class="q">尚未识别出指标</div>'}
</div>

<!-- ============ 第 3 页：关键趋势 ============ -->
<div class="page3">
<h2>⑥ 关键趋势 <span class="cnt">（同项 ≥2 次才画，共 ${c.trends} 项；参考区间取自报告原文）</span></h2>
${card.trendRows.length
  ? `<div class="trend-grid">${card.trendRows.map(trendCell).join('')}</div>`
  : '<div class="q">暂无可比较的历史值（同一项目出现 2 次以上才会显示趋势）</div>'}
${card.trendDroppedDetail && card.trendDroppedDetail.length
  ? `<div class="foot">未绘制（单位不一致，不做换算硬拼，避免假趋势）：${card.trendDroppedDetail.map((t) => esc(t.name) + '（' + t.units.map(esc).join('/') + '）').join('、')}</div>`
  : ''}
</div>

${c.valueConflicts ? `<div class="foot" style="color:#b45309">注：标 * 的 ${c.valueConflicts} 项在原图切块边界上读出过不同数值，已按出现次数最多的取值采用，原始单据可回查。</div>` : ''}
<div class="foot">本卡只陈述家属提供的数值、日期与判定，不含诊断结论与治疗建议。标 ? 的项目名称含异常字符，需人工核对原件。MedBrief 问诊资料卡 v3。</div>
</body></html>`
}

export const INTAKE_ROOT = ROOT
