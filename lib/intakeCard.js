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
import { buildChecklist } from './leukemiaChecklist.mjs'
import { pickKeyConclusions, mergeKeyConclusions } from './conclusionExtract.mjs'
import {
  criticalOf, isP0, REQUIRED_BASICS, STALE_DAYS, daysAgo, isReagentControl,
  DISEASE_TAG_PATTERNS, BASELINE_CODES, INFECTION_CODES, BLOOD_TYPE_CODES, CATEGORY_HINTS,
} from './cardPolicy.mjs'

const ROOT = path.resolve('data', 'intake')
const PATIENT_FILE = path.join(ROOT, 'patient.json')

export const DEFAULT_PATIENT = {
  id: 'p1',
  name: '',
  sex: '',
  age: '',
  diagnosis: '',
  subtype: '',
  // 分型的「原文依据」（如「流式免疫表型推断（2026-07-17）；送检临床诊断原文「AL?」」）
  // 2026-11-15 用户口径：这段长串不再塞进「分型/危险度」输入框，改为只读注释，避免用户以为要手改。
  subtypeNote: '',
  stage: '',
  hospital: '',
  attending: '',
  source: '病友家属提供（未经本院核实）',
  // 2026-11-14：治疗安全基线（只读展示，不参与任何判定；没填就显示「未录入」）
  comorbidities: '',   // 基础病：高血压 / 糖尿病 / 心脏病 …
  allergies: '',       // 过敏史
  medications: '',     // 在用药
  // v3 新增：血液科关键临床背景（可选，只读展示；录入走 patient.json 或 UI 表单，卡面不写）
  clinicalContext: { lastChemo: '', recentTxOrGcsf: '', marrowSummary: '' },
  questions: { focus: '', confirm: '', nextVisit: '' },
  // 2026-11-14 用户口径：本次来意/患者口述新情况（置顶展示）、关键结论人工摘录（覆盖自动抽取）
  chiefComplaint: '',
  keyConclusions: { karyotype: '', marrow: '', imaging: '' },
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

// 2026-11-15：老数据把「分型依据（原文）」存进了 subtype。这里做一次只读搬家（不改历史数据：
// 只影响返回值，用户下次保存时自然写成 subtype/subtypeNote 两个字段）。
function splitSubtype(p) {
  if (!p) return p
  const sub = String(p.subtype || '').trim()
  if (!sub || p.subtypeNote) return p
  if (/流式免疫表型推断|送检临床诊断原文|推断/.test(sub) || sub.length > 24) {
    return { ...p, subtype: '', subtypeNote: sub }
  }
  return p
}

export function loadPatient() {
  const p = splitSubtype(readJson(PATIENT_FILE, null))
  if (!p) return { ...DEFAULT_PATIENT, questions: { ...DEFAULT_PATIENT.questions }, clinicalContext: { ...DEFAULT_PATIENT.clinicalContext } }
  return {
    ...DEFAULT_PATIENT,
    ...p,
    questions: { ...DEFAULT_PATIENT.questions, ...(p.questions || {}) },
    clinicalContext: { ...DEFAULT_PATIENT.clinicalContext, ...(p.clinicalContext || {}) },
    keyConclusions: { ...DEFAULT_PATIENT.keyConclusions, ...(p.keyConclusions || {}) },
  }
}

export function savePatient(patch = {}) {
  const cur = loadPatient()
  const next = {
    ...cur,
    ...patch,
    questions: { ...cur.questions, ...(patch.questions || {}) },
    clinicalContext: { ...cur.clinicalContext, ...(patch.clinicalContext || {}) },
    // 关键结论三格是嵌套对象：局部保存时不能把没提交的格子清空
    keyConclusions: { ...(cur.keyConclusions || {}), ...(patch.keyConclusions || {}) },
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
// 黑白打印友好：形状（▲/▽）与字重独立于颜色，灰阶也能分辨
const arrow = (f) => (f === 'high' ? '▲ 高' : f === 'low' ? '▽ 低' : '')

/** 参考区间解析：非法（high < low）返回 null —— 不猜。 */
export function parseRefRange(s) {
  // 符号归一：全角/半角、常见异体都收；`≤ / ≥` 直接换成 `<= / >=`
  const t = String(s || '')
    .replace(/[＜﹤]/g, '<').replace(/[＞﹥]/g, '>')
    .replace(/[≤≦]/g, '<=').replace(/[≥≧]/g, '>=')
    .replace(/[～〜]/g, '~').replace(/[－—–]/g, '-')
    .replace(/\s+/g, '')
  if (!t) return null

  // ① 双边区间 —— 允许尾部粘连单位/说明（`3.5-9.5mmol/L`、`0-0.05ng/ml`）
  const m = t.match(/^(-?\d+(?:\.\d+)?)(?:--|~|-|至)(-?\d+(?:\.\d+)?)/)
  if (m) {
    const lo = Number(m[1]); const hi = Number(m[2])
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null
    return { lo, hi }
  }

  // ② 单边阈值 —— 2026-11-14 用户报的真 bug：`<125` / `<7` 一律 return null，
  //    于是 `前体NT-proBNP 3182（25.5×上限）`、`白介素6 103.4（14.8×上限）` **静默漏标**，
  //    既不进异常项也不显 ▲高。单边区间必须能判。
  //    返回值用 null 表示「该侧无界」（不返回 ±Infinity：趋势图会拿它算 Math.min/max 变 NaN）。
  const up = t.match(/^<=?(-?\d+(?:\.\d+)?)/)
  if (up) {
    const hi = Number(up[1])
    return Number.isFinite(hi) ? { lo: null, hi } : null
  }
  const low = t.match(/^>=?(-?\d+(?:\.\d+)?)/)
  if (low) {
    const lo = Number(low[1])
    return Number.isFinite(lo) ? { lo, hi: null } : null
  }
  return null
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
  // 单边区间（`<125` / `>450`）只有一侧有界，另一侧为 null —— 不能拿 null 直接比大小
  if (ref.hi != null && num > ref.hi) return 'high'
  if (ref.lo != null && num < ref.lo) return 'low'
  return 'normal'
}

/**
 * 第 1 页「疾病标签与安全基线」：只提取、不推断（2026-11-14 用户口径）。
 * 抓不到的一律返回空，由渲染层写「未录入 / 待核」；**绝不生成数据里没有的结论**。
 */
export function buildSafetyBaseline(rows = [], patient = {}) {
  const day = (r) => String(r.measuredAt || r.reportDate || '').slice(0, 10)

  // ① 分子与高危基因标签：阳性优先（真实数据里 BCR::ABL1 的阳性写在 status，不在 value）
  const geneTags = []
  for (const r of rows) {
    // 2026-11-14 用户口径：**名称优先**。此前只要 code 命中就套标签，于是初诊流式
    // 「异常细胞占有核细胞比例 85.76%」（code=FCM_MRD_PCT）被简写成「MRD 85.76」——
    // 初诊流式不是治疗后 MRD，差一个字就换了临床含义。
    const nameHit = DISEASE_TAG_PATTERNS.find((d) => d.re.test(r.name))
    const codeHit = nameHit ? null : DISEASE_TAG_PATTERNS.find((d) => d.re.test(r.code || ''))
    const hit = nameHit || codeHit
    if (!hit) continue
    const positive = r.status === 'positive' || r.flag === 'high'
    const val = String(r.value ?? '').trim()
    // 只收「有值」或「明确阳性」的；阴性项不进标签区（否则一张单子上 3 个 BCR 变体全挤进来）
    if (!val && !positive) continue
    // 2026-11-14：定性阴性结果修好保留之后，`BCR::ABL1 P210/P230 阴性` 会重新出现在标签区
    // （原来它们被洗成空值，靠上面那行被顺带过滤）。阴性变体在这里只有噪声价值 —— 阳性才是标签。
    if (!positive && /^(?:阴性|neg|未见|未检出)/i.test(val)) continue
    geneTags.push({
      label: hit.label,
      value: val || (positive ? '阳性' : ''),
      positive: positive || /阳性|\+/.test(val),
      date: day(r),
      name: r.name,
      unit: String(r.unit || '').trim(),
    })
  }
  // 残留病口径：`异常细胞占有核细胞比例` 在**初诊**流式里是基线，不是 MRD。
  //   判据：① 名称明确写 MRD/微小残留/残留病 → 一定是 MRD；
  //         ② 否则只有「比最早那次流式晚」才算复查 MRD，最早那次写「初诊异常细胞」。
  const mrdLike = geneTags.filter((g) => /MRD|初诊异常细胞/.test(g.label))
  const firstDate = mrdLike.map((g) => g.date).filter(Boolean).sort()[0] || ''
  for (const g of mrdLike) {
    const explicit = /MRD|微小残留|残留病/i.test(g.name || '')
    g.label = explicit || (g.date && firstDate && g.date > firstDate) ? 'MRD' : '初诊异常细胞'
  }
  geneTags.sort((a, b) => Number(b.positive) - Number(a.positive) || String(b.date).localeCompare(String(a.date)))

  // ② 初诊基线峰值：按 code 聚合（「白细胞」与「白细胞计数」是同一项）
  const baseline = []
  for (const b of BASELINE_CODES) {
    const list = rows
      .filter((r) => (r.code || '') === b.code && Number.isFinite(Number(r.num)) && !r.qualitative)
      .sort((x, y) => String(day(x)).localeCompare(String(day(y))))
    if (!list.length) continue
    const first = list[0]
    const peak = list.slice().sort((x, y) => Number(y.num) - Number(x.num))[0]
    const latest = list[list.length - 1]
    baseline.push({
      label: b.label,
      first: { value: first.value, num: first.num, date: day(first) },
      peak: { value: peak.value, num: peak.num, date: day(peak) },
      latest: { value: latest.value, num: latest.num, date: day(latest) },
      samples: list.length,
    })
  }

  // ③ 治疗安全基线：血型 / 传染病 / 合并症 / 过敏 / 用药
  const pick = (code) => rows.find((r) => (r.code || '') === code && String(r.value ?? '').trim())
  const abo = pick('ABO')
  const rh = pick('RH_D')
  const infections = INFECTION_CODES.map((i) => {
    const r = pick(i.code)
    return { label: i.label, value: r ? String(r.value).trim() : '', date: r ? day(r) : '', checked: !!r }
  })
  const safety = {
    bloodType: abo ? String(abo.value).trim() : '',
    rh: rh ? String(rh.value).trim() : '',
    infections,
    comorbidities: String(patient.comorbidities || '').trim(),
    allergies: String(patient.allergies || '').trim(),
    medications: String(patient.medications || '').trim(),
  }

  // ④ 近期治疗节点（沿用档案里的 clinicalContext；没填就是没填）
  const ctx = patient.clinicalContext || {}
  const treatment = {
    lastChemo: String(ctx.lastChemo || '').trim(),
    recentTxOrGcsf: String(ctx.recentTxOrGcsf || '').trim(),
    marrowSummary: String(ctx.marrowSummary || '').trim(),
  }

  return { geneTags, baseline, safety, treatment }
}

/**
 * 生成资料卡
 * @param {object}  opts
 * @param {Array}   opts.reports  已导入的报告（每条含 rows[]、reportDate、kind、hospital，可选 fileBlobId）
 * @param {boolean} opts.mask     是否脱敏姓名（默认 false —— 给医生看）
 * @param {Date}    opts.today    注入「今天」用于时效计算（测试用；默认当前时间）
 */
export function buildCard({ reports = [], mask = false, today = null, patient: injectPatient = null, embed = false } = {}) {
  const patient = injectPatient || loadPatient()
  const todayDate = today ? new Date(today) : new Date()

  // ---------- 1) 展平 + 读侧清洗 + code 注入 ----------
  const rows = []
  for (const rep of reports) {
    // 2026-11-14 用户口径：**行身份必须在源头赋值**。
    // 旧实现靠 `${name}|${value}|${measuredAt}` 内容做键回贴清洗结果 —— labClean 会改写
    // name/value/refRange，同报告内同名同值同日两行还会互相覆盖；而且交互端「点行 → 溯源 / 修正」
    // 必须能精确回到原报告的那一行（patch 端点的 rows[i].index 就是它）。
    // 现在源头挂 rowKey = reportId:rowIndex，全程透传，不再反查内容。
    for (let i = 0; i < (rep.rows || []).length; i++) {
      const raw = rep.rows[i]
      const n = normalizeRow(raw)
      const code = raw.code || classifyAnalyte(n.name, { loose: !!n.nameDirty }).code || null
      rows.push({
        ...n,
        code,
        rowIndex: i,
        rowKey: `${rep.id || 'noid'}:${i}`,
        measuredAt: n.measuredAt || rep.reportDate || '',
        reportDate: rep.reportDate || '',
        reportId: rep.id || '',
        reportType: rep.reportType || '',
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
  // groupForDoctorCard 只保留固定字段 → 按 **rowKey** 把清洗层留痕与溯源字段贴回
  // （2026-11-14：原实现用 `${name}|${value}|${measuredAt}` 做键，左移行改写 name/value 后会失配，
  //   同报告内同名同值同日两行还会互相覆盖 —— 改成稳定身份 rowKey 后彻底消除）
  const extra = new Map()
  for (const r of rows) if (r.rowKey) extra.set(r.rowKey, r)
  for (const r of flat) {
    const src = r.rowKey ? extra.get(r.rowKey) : null
    if (!src) continue
    r.nameDirty = src.nameDirty
    r.qualitative = src.qualitative
    r.proseValue = src.proseValue
    r.noteRow = src.noteRow          // 解释文本行（清洗层标记）→ 卡面剔除
    r.refRangeNote = src.refRangeNote // 原参考列里的注意事项文本（仅留痕，不显示）
    r.status = src.status || r.status || ''
    r.repaired = src.repaired
    r.unit = r.unit || src.unit
    if (src.valueConflict || src.conflict) r.valueConflict = true
  }
  // 判定：一律按「清洗后的字段」重算，报告自带箭头优先
  for (const r of flat) {
    r.flag = judgeFlag(r)
    // 定性结果（如 BCR::ABL1 三个变体）原文只有 status、没有数值 → 显式写「阳性/阴性」，不留空
    if (!String(r.value ?? '').trim() && (r.status === 'positive' || r.status === 'negative')) {
      r.value = r.status === 'positive' ? '阳性' : '阴性'
      r.qualitative = true
    }
  }

  // ---------- 2.5) 非病人数据的行：**不进卡面任何位置**（2026-11-14 用户口径） ----------
  // 两类，白名单式判定，绝不按「看着没用」批量删：
  //   a) 试剂质控行：`内部对照 阳性` / `阳性对照 阳性` —— 是 PCR 试剂对照，不是病人的结果。
  //      实测它们会被标成 `▲ 高` 混进「其他感染筛查」，医生会误读成病人阳性。
  //   b) 清洗丢弃的空壳行：值被判定为「说明性短语」清空（实测仅 `前体NT-proBNP` 的「慢性心衰」），
  //      既无数值也无疑性状态 → 留着只有一行空格。用户口径：「若原件无有效数值则不输出空壳行」。
  // 注意：**value 为空的传染病四项 / Rh 不在此列** —— 它们必须显式写「未录入 / 待核」。
  const excludedRows = { reagentControl: 0, emptyShell: 0, noteText: 0 }
  const shown = []
  for (const r of flat) {
    if (isReagentControl(r.name)) { excludedRows.reagentControl++; continue }
    // 解释文本行（清洗层标记）：OCR 把参考说明切成了结果列，不是数值也不是定性结果
    if (r.noteRow) { excludedRows.noteText++; continue }
    const hasStatus = r.status && r.status !== 'unknown'
    if (r.proseValue && !String(r.value ?? '').trim() && !hasStatus) { excludedRows.emptyShell++; continue }
    shown.push(r)
  }

  // ---------- 3) 每项取最近一次（v3：异常项只看最新状态，历史波动交给趋势页） ----------
  const keyOf = (r) => r.code || `name:${r.name}`
  const byKey = new Map()
  for (const r of shown) {
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
  // 2026-11-14 用户口径（推翻 11-13 的「危急置顶 + 按系统聚合」）：
  //   **所有展开项严格按 measuredAt 从新到旧**；危急值不再插队，只保留整行浅红底纹 + 「危急」微标。
  //   旧实现的两个副作用（用户实测指出）：
  //     ① 危急值被顶到第一行，打断时间轴；
  //     ② 按系统聚合会让「尿常规 08-02」排到「肝肾功 07-14」后面（URINE=5 > CHEM=4），
  //        看上去像日期错乱 —— 其实是二级排序键干的。所以这里只留**一个**排序键：时间。
  p0rows.sort(byDateDesc)
  p1rows.sort(byDateDesc)

  // ---------- 5) 趋势（按 code 聚类，单位不可统一则不硬拼） ----------
  // 趋势优先序：按 code **或** 名称关键词判（真实数据里骨髓/MRD 项常常没有 code，
  // 只按 code 排会让它们掉到末尾、被 8 项上限截掉 —— 而那正是血液科最该看的）
  // 用户 2026-11-13 指定：**只画血液科核心 8 项**，MCH/MCHC/PDW/中性粒% 这类次要参数直接不上图。
  // 判定按 code（唯一），name 只在没有 code 时兜底 —— 否则 `中性粒|ANC` 这类模糊正则会同时命中
  // 「中性粒细胞百分比」和「中性粒细胞计数」，把次要项挤进前 8（实测踩到）。
  // 2026-11-14 用户口径：第 3 页只画**血液科核心动态** 8 项（WBC/ANC/Hb/PLT/LDH/FBG/D-二聚体/PCT）。
  //   分工是「第 1 页看最新现状、第 3 页看疗效趋势」：骨髓/MRD 这类低频项不进趋势图（它们在首页与第 2 页有原文），
  //   CRP/HS_CRP/FIB 之外的炎症项也不上图，避免 8 格被低信息量项占满。
  //   FBG = 纤维蛋白原 = FIB（同一项，报告单两种写法）。
  const TREND_CODES = [
    'WBC', 'NEUT_ABS', 'Hb', 'PLT',   // 血常规核心
    'LDH', 'FIB', 'D_DIMER', 'PCT',   // 生化 / 凝血 / 感染
    // 2026-11-14 用户口径：血小板平均体积（MPV，修好 fI→fL 后终于可比较）**只能排最末位**，
    // 有上面 8 项时它不上图；只有核心项不足时才补位（所以它排在第 9 位而不是被删）。
    'MPV',
  ]
  const TREND_NAME_FALLBACK = [
    [/白细胞(?!介素)/, 0], [/中性粒细胞计数|ANC/i, 1], [/血红蛋白|^Hb$/i, 2], [/^血小板|血小板(?!分布|平均|压积)/, 3],
    [/乳酸脱氢|LDH/i, 4], [/纤维蛋白原|FBG|FIB/i, 5], [/D-?二聚体|D_?DIMER/i, 6],
    [/降钙素原|PCT/i, 7], [/血小板平均体积|MPV/i, 8],
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
      points: picked.map((r) => ({
        value: r.value, num: Number(r.num), unit: r.unit, measuredAt: r.measuredAt, flag: r.flag,
        hospital: r.hospital, refRange: r.refRange, critical: !!criticalOf({ code: r.code, num: r.num }),
        // 溯源字段：交互端「点圆点 → 原件溯源弹窗」要能直接定位到那一份报告
        reportId: r.reportId || '', fileBlobId: r.fileBlobId || '', rowIndex: r.rowIndex ?? null, rowKey: r.rowKey || '',
      })),
      comparable, units: [...units],
      rank: trendRank(list[0]),
      refRanges: [...new Set(numPoints.map((r) => String(r.refRange || '').trim()).filter(Boolean))],
    })
  }
  const trendTop = trendCandidates
    .filter((t) => t.comparable && t.rank < 99)   // 白名单外的一律不画（不是「排后面」，是不出现在图上）
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 8)

  // ---------- 5b) 交互工作台数据（2026-11-14）：打印版不用、只给卡片页消费 ----------
  // ① trendAll：**全部可比项**（打印版只画前 8 条白名单项，交互端允许自由勾选任意 ≥2 次的指标）。
  //    实测真实库 32 条候选、incomparable 0 —— 也就是这 32 条前端都能画。
  const trendAll = trendCandidates
    .filter((t) => t.comparable)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'zh'))
    .map((t) => ({
      key: t.key, name: t.name, code: t.code, unit: t.points[0]?.unit || '',
      refRange: t.refRanges[0] || '', rank: t.rank, core: t.rank < 99,
      points: t.points,
    }))

  // ② historyByCode：任意指标的全历史数值点（不限 8 项、不限条数），供「点开某指标看历次」。
  //    键与去重键一致（code 优先，无 code 才用规范化名称），单点也保留（只有 1 次的项也要能查到）。
  const historyByCode = {}
  for (const r of shown) {
    const k = r.code || `name:${r.name}`
    if (!historyByCode[k]) historyByCode[k] = { key: k, name: r.name, code: r.code || '', unit: r.unit || '', points: [] }
    historyByCode[k].points.push({
      date: String(r.measuredAt || r.reportDate || '').slice(0, 10),
      value: r.value ?? '', num: Number.isFinite(Number(r.num)) && r.num != null ? Number(r.num) : null,
      unit: r.unit || '', refRange: r.refRange || '', flag: r.flag || '', status: r.status || '',
      qualitative: !!r.qualitative,
      hospital: r.hospital || '', reportId: r.reportId || '', reportType: r.reportType || '',
      fileBlobId: r.fileBlobId || '', rowIndex: r.rowIndex ?? null, rowKey: r.rowKey || '',
      critical: !!criticalOf(r),
    })
    if (!historyByCode[k].unit && r.unit) historyByCode[k].unit = r.unit
  }
  for (const h of Object.values(historyByCode)) {
    h.points.sort((a, b) => String(a.date).localeCompare(String(b.date)))   // 左旧右新
    h.count = h.points.length
  }

  // ③ timeline：按日期倒序串联**全部已导入报告**（含不在打印版里出现的影像/病理），供「全病程原件轴」。
  //    只陈述事实：类型 / 报告单号 / 报告时间 / 结构化行数 / 是否存有原件。不做任何结论推断。
  const timeline = reports.map((rep) => {
    const txt = String(rep.text || rep.rawText || '')
    const pick = (re) => { const m = txt.match(re); return m ? String(m[1]).trim() : '' }
    const rowsOfRep = (rep.rows || []).length
    const abnormal = (rep.rows || []).filter((row) => row.status === 'high' || row.status === 'low' || row.status === 'positive').length
    return {
      id: rep.id || '',
      date: String(rep.reportDate || rep.sampledAt || '').slice(0, 10),
      hospital: rep.hospital || '',
      kind: rep.kind || 'lab',
      reportType: rep.reportType || '',
      labName: rep.labName || '',
      reportNo: pick(/报告单号[：:\s]*([A-Za-z0-9\-]{5,})/),
      reportTime: pick(/报告时间[：:\s]*(20\d\d-\d\d-\d\d\s*\d\d:\d\d)/),
      itemName: pick(/项目名称[：:\s]*([^\n]{2,30})/),
      rowCount: rowsOfRep,
      abnormalCount: abnormal,
      fileBlobId: rep.fileBlobId || (rep.sourceBlobs && rep.sourceBlobs[0] && rep.sourceBlobs[0].blobId) || '',
      hasBlob: !!(rep.fileBlobId || (rep.sourceBlobs || []).length),
      unstructured: rowsOfRep === 0,
      summary: rowsOfRep
        ? `${rep.reportType || '化验'} · ${rowsOfRep} 项${abnormal ? ` · 异常 ${abnormal}` : ''}`
        : `${rep.reportType || rep.kind || '未分类'} · 仅存原件（未结构化）`,
    }
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)))

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

  // ⚠️ 必须用**全量原始行**：去重集只剩「每项最新」，会丢掉初诊值与 history（实测 WBC 首诊 59.16 会变成 3.27）
  const safetyBaseline = buildSafetyBaseline(rows, patient)

  // 白血病核心资料体检（2026-11-14 用户口径）：缺失只做「提示 + 1 行声明」，**绝不阻塞打印**。
  const checklist = buildChecklist(reports, todayDate)

  // 关键结论原文摘录（2026-11-14 用户口径）：染色体 / 骨穿 / 关键影像各一条。
  // 人工填写优先于自动抽取；auto 标 [原文摘录]、manual 标 [人工摘录]，**抓不到就空着，绝不编**。
  const keyConclusions = mergeKeyConclusions(pickKeyConclusions(reports), patient.keyConclusions)

  const card = {
    ok: true,
    empty: reports.length === 0,   // 0 份报告 → 前端渲染引导页，不渲染空壳卡
    checklist,
    generatedAt: new Date().toISOString(),
    masked: !!mask,
    patient: { ...patient, name: mask ? maskName(patient.name) : patient.name },
    counts: {
      reports: reports.length,
      rows: flat.length,          // 入库行总数（不变；卡面渲染行数 = rows - excluded 之和）
      shown: shown.length,        // 实际参与卡面渲染的行数
      excluded: excludedRows,     // { reagentControl, emptyShell } 白名单剔除项
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
    trendAll,
    historyByCode,
    timeline,
    trendDroppedDetail: trendCandidates.filter((t) => !t.comparable).map((t) => ({ name: t.name, units: t.units })),
    safetyBaseline,
    keyConclusions,
    checklist,
    materialRows,
    materialGroups,
    groups,
  }
  card.html = renderHtml(card, { embed })
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
        status: it.status || '',
        valueConflict: !!(it.valueConflict || it.conflict),
        proseValue: !!it.proseValue,
        hospital: it.hospital || '',
        // 溯源字段（2026-11-14）：来源报告 + 在报告 rows[] 里的下标，供前端「点行 → 原件 / 修正」精确定位
        reportId: it.reportId || '',
        reportDate: it.reportDate || '',
        reportType: it.reportType || '',
        fileBlobId: it.fileBlobId || '',
        rowIndex: Number.isInteger(it.rowIndex) ? it.rowIndex : null,
        rowKey: it.rowKey || '',
      })
    }
  }
  return out
}

// ===================== v3 版式（1+1+1） =====================

export function svgTrend(points = [], { low = null, high = null, w = 300, h = 76 } = {}) {
  const vals = points.map((p) => Number(p.num ?? p.value)).filter((n) => Number.isFinite(n))
  if (vals.length < 2) return ''
  // 2026-11-14 用户口径（19:05 版反馈）：
  //   ① 图必须有 Y 轴刻度，否则「看趋势看不出量级」；② 每个点必须标出数值，且与 X 轴同序（左旧右新）。
  //   左边留 26px 放刻度标签、上边留 12px 放数值标注；刻度取 3 档（min/中/max 的实际绘制区间）。
  const PAD = { l: 28, r: 10, t: 13, b: 13 }
  let min = Math.min(...vals, ...(low !== null ? [low] : []))
  let max = Math.max(...vals, ...(high !== null ? [high] : []))
  if (max === min) { max += 1; min -= 1 }
  // 刻度用**真实值域**（不把 16% 留白算进刻度，否则 WBC 3.27~79.67 会量出 -8.95 这种刻度）
  const tickLo = min, tickHi = max
  const span = max - min
  min -= span * 0.16
  max += span * 0.16
  if (tickLo >= 0 && min < 0) min = 0   // 全为正的指标不许画到负区间
  // X 轴按**真实日期比例**（2026-11-14 用户口径）：隔 9 天必须比隔 1 天宽 9 倍，
  // 否则「07-17→07-18（1 天）」与「07-18→07-27（9 天）」画成一样宽，会严重误导病情变化速度。
  // 退化路径一律回退等距（绝不产生 NaN）：有效日期 < 2 个 / 全部同一天 / 该点无日期。
  const tsOf = (pt) => {
    const raw = String(pt.measuredAt || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null
    const t = Date.parse(`${raw.slice(0, 10)}T00:00:00Z`)
    return Number.isFinite(t) ? t : null
  }
  const times = points.map(tsOf)
  const validTimes = times.filter((t) => t !== null)
  const t0 = validTimes.length ? Math.min(...validTimes) : null
  const t1 = validTimes.length ? Math.max(...validTimes) : null
  const useTime = validTimes.length >= 2 && t1 > t0
  const plotW = w - PAD.l - PAD.r
  const x = (i) => (useTime && times[i] !== null
    ? PAD.l + ((times[i] - t0) / (t1 - t0)) * plotW
    : PAD.l + (i * plotW) / (points.length - 1))
  const y = (v) => h - PAD.b - ((Number(v) - min) / (max - min)) * (h - PAD.t - PAD.b)
  // 刻度数字的位数跟着量级走：PLT 三位数取整、PCT 一位、WBC 两位
  const tickFmt = (v) => {
    const a = Math.abs(v)
    if (a >= 100) return String(Math.round(v))
    if (a >= 10) return String(Math.round(v * 10) / 10)
    return String(Math.round(v * 100) / 100)
  }
  const yTicks = [tickHi, (tickHi + tickLo) / 2, tickLo]
    .map((v) => ({ v, y: y(v) }))
    .map((t) => `<line x1="${(PAD.l - 3).toFixed(1)}" y1="${t.y.toFixed(1)}" x2="${PAD.l}" y2="${t.y.toFixed(1)}" stroke="#d1d5db" stroke-width="0.7"/>` +
      `<text x="${PAD.l - 4.5}" y="${(t.y + 2.4).toFixed(1)}" font-size="6.5" fill="#6b7280" text-anchor="end">${esc(tickFmt(t.v))}</text>`)
    .join('')
  const yAxis = `<line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${(h - PAD.b).toFixed(1)}" stroke="#9ca3af" stroke-width="0.7"/>${yTicks}`
  // 黑白打印友好：参考区间不再画淡绿填充（灰度会消失），改为上下两条虚线边界
  // 参考边界逐侧独立：单边区间（`<125` / `>450`）只有一侧有界，就只画那一条虚线
  // （旧实现要求 low/high 同时非空，单边项干脆不画，等于把参考线静默丢了）
  const bandLine = (v, label, dy) => (v == null ? '' :
    `<line x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${w - PAD.r}" y2="${y(v).toFixed(1)}" stroke="#9ca3af" stroke-width="0.8" stroke-dasharray="3 2"/>` +
    `<text x="${w - PAD.r - 1}" y="${(y(v) + dy).toFixed(1)}" font-size="6" fill="#9ca3af" text-anchor="end" stroke="#fff" stroke-width="1.6" paint-order="stroke">${label} ${v}</text>`)
  const band = bandLine(high, '上界', -1.5) + bandLine(low, '下界', 6.5)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.num ?? p.value).toFixed(1)}`).join(' ')
  // 点形状独立于颜色：正常=空心圆、异常=实心圆、危急=双圈靶心（灰度打印也分得清）
  const dots = points.map((p, i) => {
    const f = p.flag
    const c = f === 'high' ? '#b91c1c' : f === 'low' ? '#15803d' : '#111827'
    const cx = x(i).toFixed(1); const cy = y(p.num ?? p.value).toFixed(1)
    const crit = Number.isFinite(Number(p.criticalValue)) || p.critical
    if (crit) return `<circle cx="${cx}" cy="${cy}" r="4" fill="none" stroke="${c}" stroke-width="1"/><circle cx="${cx}" cy="${cy}" r="1.8" fill="${c}"/>`
    if (f === 'high' || f === 'low') return `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${c}"/>`
    return `<circle cx="${cx}" cy="${cy}" r="2.4" fill="#fff" stroke="${c}" stroke-width="0.9"/>`
  }).join('')
  // 真实比例下相邻点可能贴得很近（隔 1 天），日期标签会叠字 —— 两级避让：
  // ① 间距 < 26px：奇偶两行错位（图底部加高 8px，避免被 viewBox 裁切）；
  // ② 仍 < 13px：智能抽稀，只留首点、末点、每月首个点（点值标签不受影响，读数不丢）。
  const xs = points.map((_, i) => x(i))
  let minGap = Infinity
  for (let i = 1; i < xs.length; i++) minGap = Math.min(minGap, xs[i] - xs[i - 1])
  const twoRows = xs.length > 1 && minGap < 26
  const H = h + (twoRows ? 8 : 0)
  const tooTight = xs.length > 1 && minGap < 13
  const keepLabel = (i) => {
    if (i === 0 || i === xs.length - 1) return true
    if (!tooTight) return true
    const cur = String(points[i].measuredAt || '').slice(0, 7)
    const prev = String(points[i - 1].measuredAt || '').slice(0, 7)
    return cur !== prev
  }
  const labels = points.map((p, i) => (keepLabel(i)
    ? `<text x="${xs[i].toFixed(1)}" y="${(twoRows && i % 2 ? H - 10 : H - 2.5).toFixed(1)}" font-size="7.2" fill="#9ca3af" text-anchor="middle">${esc(String(p.measuredAt || '').slice(5))}</text>`
    : '')).join('')
  // 点上方标数值（2026-11-14 用户口径：图必须能读数）。与 X 轴同序，左旧右新。
  // 贴顶的点把标注压到点下方，避免被 viewBox 裁掉；白描边保证压在虚线/折线上也读得清。
  const valLabels = points.map((p, i) => {
    const cy = y(p.num ?? p.value)
    const above = cy - PAD.t > 8
    const f = p.flag
    const c = f === 'high' ? '#b91c1c' : f === 'low' ? '#15803d' : '#111827'
    return `<text x="${x(i).toFixed(1)}" y="${(above ? cy - 4.2 : cy + 8.4).toFixed(1)}" font-size="7" font-weight="600" fill="${c}" text-anchor="middle" stroke="#fff" stroke-width="1.8" paint-order="stroke">${esc(String(p.value ?? p.num ?? ''))}</text>`
  }).join('')
  return `<svg viewBox="0 0 ${w} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">${yAxis}${band}<path d="${path}" fill="none" stroke="#2563eb" stroke-width="1.4"/>${dots}${valLabels}${labels}</svg>`
}

/**
 * 日期简写（用户口径）：同一年内显示 MM-DD，跨年才带年。
 * 判定用「卡片里出现过的年份集合」——只出现一个年份就全省略年份。
 */
function clipText(s, max = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

function makeDateFmt(rows = []) {
  const years = new Set(rows.map((r) => String(r.measuredAt || '').slice(0, 4)).filter(Boolean))
  const single = years.size <= 1
  return (d) => {
    const t = String(d || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return t || '—'
    return single ? t.slice(5) : t
  }
}

function renderHtml(card, opts = {}) {
  // embed=true：这份 HTML 是嵌在「打印预览」弹窗 iframe 里的，浮动「打印 / 存 PDF」按钮
  // 会压在表格文字上、还和弹窗底部主按钮重复（2026-11-14 用户反馈）。
  // 整段不输出（不是 CSS 隐藏），避免有人对着弹窗按 Ctrl+P 时又冒出来。
  // 注意：「新窗口打开纯净打印页」不带 embed，那一页仍要保留浮动按钮。
  const embed = opts.embed === true
  const p = card.patient || {}
  const c = card.counts || {}
  const ctx = p.clinicalContext || {}
  const sb = card.safetyBaseline || { geneTags: [], baseline: [], safety: {}, treatment: {} }
  const fmtD = makeDateFmt(card.latestRows || [])
  // 关键结论摘录（①-b，2026-11-14 用户口径）：染色体 / 骨穿 / 关键影像各一条原句，≤90 字。
  // 标来源：自动抽取 [原文摘录]、人工填写 [人工摘录]。一条都没抽到就整段不出现
  // （**不写「请点报告库查看」—— 纸面上点不了**）。
  const hints = Array.isArray(card.checklist?.hints) ? card.checklist.hints : []
  const hintHtml = hints.length
    ? `<div class="cl-hint">${hints.map((x) => `⚠ ${esc(x.detail)}`).join('　')}</div>`
    : ''
  // 本次来意 / 患者口述新情况（2026-11-14 用户口径）：置顶到模块 ③，并在模块 ① 安全基线末尾联动一行，
  // 防止医生只看指标漏掉最新的主观线索。未填则两处都不出现。
  const chief = String(p.chiefComplaint || '').trim()
  const chiefHtml = chief
    ? `<div class="chief"><span class="chief-tag">[患者口述]</span>${esc(chief)}</div>`
    : ''
  const chiefHint = chief
    ? `<div class="chief-hint">⚠ 患者口述新情况：${esc(clipText(chief, 60))}（详见 ③）</div>`
    : ''
  const kc = Array.isArray(card.keyConclusions) ? card.keyConclusions : []
  const keyConcHtml = kc.length
    ? `<div class="kc"><div class="kc-t">关键结论摘录 <span class="cnt">（原句照录，未作改写）</span></div>`
      + kc.map((x) => `<div class="kc-row"><span class="kc-k">${esc(x.label)}${x.date ? `（${esc(fmtD(x.date))}）` : ''}</span>`
        + `<span class="kc-src">${x.source === 'manual' ? '[人工摘录]' : '[原文摘录]'}</span>`
        + `<span class="kc-v">${esc(x.text)}</span></div>`).join('')
      + '</div>'
    : ''

  // 安全基线：四格里「抓到什么写什么，抓不到写未录入/待核」，绝不猜
  const sbGene = sb.geneTags.length
    ? sb.geneTags.map((g) => `${/阳性/.test(g.value) ? `<span class="badge-on">${esc(g.label)} 阳性</span>` : `<b>${esc(g.label)}</b> ${esc(g.value)}${g.unit ? esc(g.unit) : ''}`}`).join('　')
    : '<span class="sb-muted">待核（报告里未检出基因/残留病项目）</span>'
  const sbBase = sb.baseline.length
    ? sb.baseline.map((b) => {
        const same = b.first.value === b.latest.value
        return `<b>${esc(b.label)}</b> 初诊 ${esc(b.first.value)}（${esc(fmtD(b.first.date))}）` +
          (b.peak.value !== b.first.value ? ` · 峰值 ${esc(b.peak.value)}（${esc(fmtD(b.peak.date))}）` : '') +
          (same ? ' · <span class="sb-muted">仅一次</span>' : ` · 最新 ${esc(b.latest.value)}（${esc(fmtD(b.latest.date))}）`)
      }).join('　')
    : '<span class="sb-muted">未录入（缺 WBC / LDH 数值）</span>'
  // 传染病四项（2026-11-14 用户口径）：**四项都查到且都阴性 → 压成一行**，省视线；
  // 任一项缺或阳性 → 逐项列出（阳性必须单独可见，不能被「均阴性」吞掉）。
  // 空值一律写「未录入」—— 没查 ≠ 阴性，这是红线。
  const infChecked = sb.safety.infections.filter((i) => i.value)
  const infAllNeg = infChecked.length === sb.safety.infections.length && infChecked.every((i) => /^阴性|^neg/i.test(i.value))
  const infLatest = infChecked.map((i) => i.date).filter(Boolean).sort().slice(-1)[0] || ''
  const infText = infAllNeg
    ? `传染病四项 <b>均阴性</b>${infLatest ? ` <span class="sb-muted">（${esc(fmtD(infLatest))}）</span>` : ''}`
    : sb.safety.infections.map((i) => `${esc(i.label)} ${i.value ? `<b>${esc(i.value)}</b>` : '<span class="sb-muted">未录入</span>'}`).join('　')
  // Rh(D)：报告写「阳性/阴性」，卡面用临床惯写 Rh(+) / Rh(−)；空值仍「待核」，绝不猜。
  const rhMark = /^阳性|^\+|^pos/i.test(sb.safety.rh) ? '(+)'
    : /^阴性|^-|^neg/i.test(sb.safety.rh) ? '(−)'
      : ` ${sb.safety.rh}`
  const rhText = sb.safety.rh ? ` · <b>Rh${esc(rhMark)}</b>` : ' · <span class="sb-muted">Rh 待核</span>'
  const sbSafe = [
    `血型 <b>${sb.safety.bloodType ? esc(sb.safety.bloodType) : '<span class="sb-muted">未录入</span>'}</b>${rhText}`,
    infText,
    // 伴随病史三项（2026-11-14 用户口径）：**有内容才显示，没填/选「无」就不出现**
    // （不写「无」也不写「未录入」——避免第 1 页挂一串占位符）。血型与传染病不适用此规则。
    sb.safety.comorbidities ? `基础病 <b>${esc(sb.safety.comorbidities)}</b>` : '',
    sb.safety.allergies ? `过敏 <b>${esc(sb.safety.allergies)}</b>` : '',
    sb.safety.medications ? `在用药 <b>${esc(sb.safety.medications)}</b>` : '',
  ].filter(Boolean).join('　')
  const sbTreat = [sb.treatment.lastChemo, sb.treatment.recentTxOrGcsf, sb.treatment.marrowSummary].some(Boolean)
    ? [
        `治疗节点 <b>${sb.treatment.lastChemo ? esc(sb.treatment.lastChemo) : '<span class="sb-muted">未录入</span>'}</b>`,
        `输血/升白 <b>${sb.treatment.recentTxOrGcsf ? esc(sb.treatment.recentTxOrGcsf) : '<span class="sb-muted">未录入</span>'}</b>`,
        `骨穿/MRD <b>${sb.treatment.marrowSummary ? esc(sb.treatment.marrowSummary) : '<span class="sb-muted">未录入</span>'}</b>`,
      ].join('　')
    : '<span class="sb-muted">未录入（可在「资料卡」页填：近期方案 / 输血升白 / 骨穿结论）</span>'
  const KIND_LABEL = { lab: '化验', pathology: '病理/流式', imaging: '影像', discharge: '出院小结', drug: '用药', unknown: '其他' }

  // 少一列：判定并入「数值」列，箭头右对齐（高=红↑ / 低=绿↓）
  const tr = (r, { critical = false, showHospital = true } = {}) => `<tr${critical ? ' class="crit"' : ''}>
      <td>${esc(r.name)}${r.nameDirty ? '<sup title="名称含异常字符，需人工核对原文">?</sup>' : ''}${critical ? ' <span class="crit-tag">[危急]</span>' : ''}</td>
      <td class="v"><div class="vwrap"><span class="num" style="color:${color(r.flag)}">${esc(r.value ?? '')}${esc(r.unit ? ' ' + r.unit : '')}</span><span class="ar" style="color:${color(r.flag)}">${arrow(r.flag)}${r.valueConflict ? '*' : ''}</span></div></td>
      <td class="ref">${esc(r.refRange || '—')}</td>
      <td class="d">${esc(fmtD(r.measuredAt))}${showHospital && r.hospital ? ' ' + esc(r.hospital) : ''}</td>
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
  // ---------- 第 2 页「其他感染筛查」折叠（2026-11-14 用户口径） ----------
  //  ① ABO 的 正定型/反定型/鉴定/酶法鉴定 是同一次检测的四种做法，结果必然一致 → 压成 1 行「ABO血型」；
  //     Rh 另占 1 行（共 2 行，不再占 5 行）。
  //  ② 传染病四项（乙肝/丙肝/HIV/梅毒）**永远单列**：阴性也要一眼看到——术前/输血前必查项。
  //     任何阳性结果也永远单列（绝不进「均阴性」汇总，否则阳性会被汇总吞掉）。
  //  ③ 其余常规病毒/抗体：全部阴性 → 按主题折成 1 行「呼吸道病原筛查 6项（07-17）：均阴性」；
  //     组内只要有一个不是阴性 → 不折叠，逐项列出（宁可行多，不许把阳性藏进汇总）。
  //  判据写成不变量：**折叠前后「项数」必须相等**，且每个折叠行都要写出日期，否则不许折。
  const FOLD_THEMES = [
    { key: 'resp', label: '呼吸道病原筛查', re: /支原体|合胞|流感|腺病毒|鼻病毒|偏肺|博卡|冠状|新冠/i },
    { key: 'hepatitis', label: '甲/戊肝抗体', re: /甲型肝炎|戊型肝炎|A-HAV|A-HEV/i },
    { key: 'antibody', label: '不规则抗体筛查', re: /红细胞抗体|筛选细胞|抗体筛查|不规则抗体/i },
  ]
  const KEEP_ALWAYS = /乙肝表面抗原|HBsAg|丙型肝炎抗体|Anti-?HCV|艾滋病|Anti-?HIV|梅毒|Anti-?TP/i
  const isNeg = (r) => /^(阴性|neg|未见|未检出|正常|-|—)$/i.test(String(r.value || '').trim())
  function foldMicro(items) {
    const out = []          // 输出行
    const folded = []       // { label, n, date, items }
    // ① 血型合并
    const abo = items.filter((r) => /^ABO\s*血型|ABO血型/.test(r.name))
    const rh = items.filter((r) => /Rh/.test(r.name))
    const used = new Set([...abo, ...rh])
    if (abo.length) {
      const vals = [...new Set(abo.map((r) => String(r.value || '').trim()).filter(Boolean))]
      // 四种做法结果不一致 → 不合并（这是真异常，必须逐条看）
      const consistent = vals.length <= 1
      const base = abo[0]
      out.push(consistent
        ? { ...base, name: 'ABO血型', value: vals[0] || '', unit: '', refRange: '', isMerged: `${abo.length} 项合成` }
        : { ...base, name: 'ABO血型（结果不一致，见第 2 页原项）', value: vals.join('/'), unit: '', refRange: '' })
      if (!consistent) for (const r of abo.slice(1)) out.push(r)
    }
    for (const r of rh) out.push(r)
    // ② 其余：先挑出「必留」的（四项/阳性），剩下的按主题折
    const rest = items.filter((r) => !used.has(r))
    const keep = []
    const other = []
    const byTheme = new Map()
    const nonNeg = (r) => r.status === 'positive' || r.flag === 'high' || /^阳性|^\+$/.test(String(r.value || '').trim()) || !isNeg(r)
    // 注意：**必须让阳性行也参与主题归组**，否则「组内有一个阳性」永远判不出来，
    //       结果就是阳性单独留着、其余阴性被折成「均阴性」——读者只看汇总行会以为全阴。
    for (const r of rest) {
      if (KEEP_ALWAYS.test(r.name)) { keep.push(r); continue }
      const t = FOLD_THEMES.find((x) => x.re.test(r.name))
      if (!t) { other.push(r); continue }
      if (!byTheme.has(t.key)) byTheme.set(t.key, { label: t.label, items: [], mustList: false })
      const g = byTheme.get(t.key)
      g.items.push(r)
      if (nonNeg(r)) g.mustList = true
    }
    // 折叠的两条硬约束：
    //   ① **组内只要有一个不是阴性 → 整组逐项列出**（绝不让阳性躲进「均阴性」）；
    //   ② 只有 1 项的组不折（「1项：均阴性」是纯噪声，实测不规则抗体筛查只剩 1 项）。
    for (const v of byTheme.values()) {
      if (v.mustList || v.items.length < 2) keep.push(...v.items)
      else folded.push({ label: v.label, items: v.items })
    }
    if (other.length >= 2) folded.push({ label: '其他筛查', items: other })
    else keep.push(...other)
    // 折叠行：日期取组内最新，项数写清，值恒为「均阴性」
    for (const f of folded) {
      const date = f.items.map((r) => String(r.measuredAt || '').slice(5)).filter(Boolean).sort().slice(-1)[0] || ''
      out.push({
        name: f.label,
        value: `${f.items.length}项${date ? `（${date}）` : ''}：均阴性`,
        unit: '',
        refRange: '',
        isSummary: true,
        foldedCount: f.items.length,
        foldedNames: f.items.map((r) => r.name),
      })
    }
    for (const r of keep) out.push(r)
    return out
  }

  const groupedRows = (rows) => {
    const out = []
    for (const g of CAT_GROUPS) {
      let items = rows.filter((r) => g.cats.includes(r.catKey))
      if (!items.length) continue
      if (g.cats.includes('MICRO')) items = foldMicro(items)   // 血型合并 + 阴性常规项折叠
      const half = Math.ceil(items.length / 2)
      const cols = [items.slice(0, half), items.slice(half)]
      const row = (r) => `<tr>
      <td class="nm">${esc(r.name)}${r.valueConflict ? '<sup>*</sup>' : ''}${r.nameDirty ? '<sup>?</sup>' : ''}</td>
      <td class="v"><div class="vwrap"><span class="num" style="color:${color(r.isSummary ? '' : r.flag)}">${esc(r.value ?? '')}${esc(r.unit ? ' ' + r.unit : '')}</span><span class="ar" style="color:${color(r.isSummary ? '' : r.flag)}">${r.isSummary ? '' : arrow(r.flag)}</span></div>${r.isMerged ? `<div class="merged-h">${esc(r.isMerged)}</div>` : ''}</td>
      <td class="ref">${esc(r.refRange || '—')}</td>
    </tr>`
      const hint = CATEGORY_HINTS[g.label] || ''
      out.push(`<div class="catgrp"><div class="cath">${esc(g.label)} ${hint ? `<span class="cath-h">（${esc(hint)}）</span>` : ''} <span>${items.length} 项</span></div>
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
    </div>`
    // 底部文字点位行已删（2026-11-14 用户裁掉）：它只是把折线上的点再念一遍，没有独立信息量，
    // 且曾因 .slice().reverse() 与折线反序（图上左旧右新、字却 07-27→07-14），图文相反比顺序错更难发现。
    // 精确数值在第 1 页「最新值」与第 2 页「全部指标」里都有，删掉不丢信息。
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
  /* 模块标题：1 秒定位（用户口径）。左竖条 + 下细线，黑白打印也成立 */
  h2 { font-size: 12px; font-weight: 700; margin: 7px 0 3px; padding: 1px 0 2px 6px; border-left: 3px solid #111; border-bottom: 1px solid #111; }
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
  /* 危急：黑白打印也必须一眼看见 —— 黑底白字徽章 + 左 4px 黑粗线 + 数值加粗；彩色模式再叠浅红底 */
  tr.crit td { background: #fef2f2; }
  tr.crit td:first-child { border-left: 4px solid #111; }
  tr.crit .num { font-weight: 800; }
  .crit-tag { background: #111; color: #fff; border-radius: 2px; padding: 0 4px; font-size: 8.5px; font-weight: 700; letter-spacing: .3px; }
  @media print { tr.crit td { background: #f2f2f2; } }
  .warn { background: #fff7ed; border: 1px solid #fdba74; padding: 3px 6px; font-size: 9.5px; margin-bottom: 4px; }
  .stale { background: #fffbeb; border: 1px solid #f59e0b; color: #92400e; padding: 3px 6px; font-size: 9.5px; margin: 2px 0 4px; border-radius: 3px; }
  .p1note { color: #6b7280; font-size: 9px; margin-top: 2px; }
  .ph { color: #c3c7ce; } /* 未填时的提示语：浅灰、不抢视线 */
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
  /* 2026-11-14 用户报「数值+单位与参考区间撞车」：值列原为 24% + nowrap，35（++）umol/L 约 30mm
     只能溢出压到参考列。改为 44/32/24 且允许折行（值本身不拆，只在「值 ↔ 箭头」之间可折）。
     注意：这段 CSS 在模板字符串里，注释中不许出现反引号。 */
  table.compact.cat th, table.compact.cat td { font-size: 10px; line-height: 1.2; padding: 0 3px; }
  table.compact.cat thead.ghost th { visibility: hidden; padding: 0; height: 0; border: none; }
  table.compact.cat td.nm { white-space: normal; word-break: break-word; }
  table.compact.cat th:nth-child(1) { width: 44%; } table.compact.cat th.v { width: 32%; }
  table.compact.cat th.ref { width: 24%; }
  table.compact.cat td.v { white-space: normal; }
  table.compact.cat td.v .vwrap { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 3px; }
  table.compact.cat td.v .num { white-space: nowrap; }
  table.compact.cat td.v .ar { margin-left: auto; flex: none; }
  table.compact.cat td.ref { white-space: normal; word-break: break-word; }
  /* 分组间距再压一档（字号不变），把第 2 页余量从 24px 扩到 60px+（用户 2026-11-14 批准） */
  .catgrp { margin-bottom: 1px; }
  .cath { font-size: 10px; font-weight: 700; color: #1f2937; border-left: 3px solid #94a3b8; padding-left: 5px; margin: 1px 0 0; line-height: 1.25; }
  .cath span { font-weight: 400; color: #9ca3af; font-size: 9px; }
  .cath .cath-h { color: #6b7280; font-weight: 400; font-size: 9px; }
  /* 第 1 页顶部：疾病标签与安全基线（四格，两列） */
  .sb { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; margin: 2px 0 3px; }
  .sb-cell { border: 1px solid #d1d5db; border-left: 3px solid #111; padding: 3px 5px; border-radius: 2px; }
  .kc { margin-top: 4px; border-left: 2px solid #d1d5db; padding-left: 6px; }
  .kc-t { font-size: 9.5px; color: #374151; font-weight: 600; }
  .kc-row { font-size: 9px; line-height: 1.35; margin-top: 1px; }
  .kc-k { color: #111827; font-weight: 600; margin-right: 3px; }
  .kc-src { color: #6b7280; font-size: 8px; margin-right: 3px; }
  .kc-v { color: #1f2937; }
  .chief { border: 1px solid #111827; border-radius: 4px; padding: 3px 6px; font-size: 10px; line-height: 1.4; margin-bottom: 3px; }
  .chief-tag { font-weight: 700; margin-right: 4px; }
  .chief-hint { margin-top: 3px; font-size: 8.5px; color: #111827; }
  .cl-hint { margin-top: 3px; font-size: 8.5px; color: #b45309; line-height: 1.35; }
  .sb-t { font-size: 9px; font-weight: 700; color: #111; margin-bottom: 2px; }
  .sb-l { font-size: 9px; color: #374151; line-height: 1.35; }
  .sb-l b { font-weight: 700; }
  .sb-muted { color: #9ca3af; font-weight: 400; }
  .badge-on { background: #111; color: #fff; border-radius: 2px; padding: 0 4px; font-weight: 700; font-size: 8.5px; }
  .badge-warn { border: 1px solid #111; border-radius: 2px; padding: 0 4px; font-weight: 700; font-size: 8.5px; }
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
  .merged-h { color: #6b7280; font-size: 8px; line-height: 1.1; }
  .refwarn { color: #b45309; font-size: 8.5px; }
  .refwarn-tag { color: #b45309; font-size: 8.5px; border: 1px solid #fcd34d; border-radius: 3px; padding: 0 2px; }
  .muted { color: #9ca3af; }
  td.idx { width: 5%; text-align: right; color: #6b7280; }
  td.act { width: 12%; text-align: center; }
  .lnk { font: 9px -apple-system; padding: 1px 5px; border: 1px solid #d1d5db; background: #fff; border-radius: 4px; cursor: pointer; }
  .foot { margin-top: 5px; color: #6b7280; font-size: 9px; }
  /* 白血病核心项声明：1 行小字、灰、细虚线分隔 —— 如实但不抢临床信息的视线 */
  .cl { margin-top: 3px; padding-top: 2px; border-top: 1px dotted #d1d5db; color: #6b7280; font-size: 8.5px; line-height: 1.3; }
  .page1 h1, .page1 .meta { padding-right: 132px; } /* 别被右上角固定按钮压住抬头文字（两行 meta 需要更宽） */
  .printbar { position: fixed; top: 6px; right: 6px; z-index: 9; background: #fff; padding: 2px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .printbar button { font: 11px -apple-system; padding: 4px 10px; border: 1px solid #d1d5db; background: #fff; border-radius: 6px; cursor: pointer; }
  .only-print { display: none; }
  @media print { .printbar { display: none !important; } }

  /* embed=1（打印预览弹窗里的 iframe，2026-11-15 用户口径）：
     屏幕预览要像"看一页纸"—— 浅灰底 + 白色纸张 + 四周留白 + 轻阴影；
     打印时这些全部撤销（@page margin:9mm 负责纸面留白），所以「预览好看」不会改变打印结果。 */
  html, body { background: #eef1f4; }
  body.embed-preview { padding: 16px; }
  body.embed-preview .page1, body.embed-preview .page2, body.embed-preview .page3 {
    background: #fff; max-width: 794px; margin: 0 auto 16px; padding: 28px 26px;
    border-radius: 4px; box-shadow: 0 2px 10px rgba(15, 23, 42, .10);
  }
  @media print {
    html, body { background: #fff !important; }
    body.embed-preview { padding: 0 !important; }
    body.embed-preview .page1, body.embed-preview .page2, body.embed-preview .page3 {
      max-width: none !important; margin: 0 !important; padding: 0 !important;
      border-radius: 0 !important; box-shadow: none !important;
    }
  }
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
</style></head><body${embed ? ' class="embed-preview"' : ''}>
${embed ? '' : '<div class="printbar"><button onclick="window.print()">打印 / 存 PDF</button></div>'}

<!-- ============ 第 1 页：核心速览 ============ -->
<div class="page1">
<h1>问诊资料卡 · ${esc(p.name || '（姓名未填）')} ${esc(p.sex || '')}${p.age ? ' · ' + esc(p.age) + '岁' : ''}</h1>
<div class="meta">
  <b>${esc((p.diagnosis || '未录入诊断').split('（')[0])}</b>${p.stage ? ' ｜ 阶段：' + esc(p.stage) : ''}
  ${sb.geneTags.filter((g) => /阳性/.test(g.value)).map((g) => `<span class="badge-on" style="margin-left:6px">${esc(g.label)} 阳性</span>`).join('')}
  ${p.subtype ? `<span class="badge-on" style="margin-left:6px">${esc(p.subtype)}</span>` : ''}
</div>

<h2>① 疾病标签与安全基线</h2>
<div class="sb">
  <div class="sb-cell"><div class="sb-t">分子与高危基因</div><div class="sb-l">${sbGene}</div></div>
  <div class="sb-cell"><div class="sb-t">初诊基线（对比最新）</div><div class="sb-l">${sbBase}</div></div>
  <div class="sb-cell"><div class="sb-t">治疗安全基线</div><div class="sb-l">${sbSafe}</div></div>
  <div class="sb-cell"><div class="sb-t">近期治疗节点</div><div class="sb-l">${sbTreat}</div></div>
</div>
${keyConcHtml}${chiefHint}${hintHtml}
${(p.subtypeNote || p.subtype) ? `<div class="sb-l sb-muted" style="margin:-1px 0 2px">分型依据（原文）：${esc(p.subtypeNote || p.subtype)}</div>` : ''}
${card.masked ? '<div class="warn">姓名已脱敏（给医生看时建议关闭脱敏）。</div>' : ''}
${c.missingBasics && c.missingBasics.length ? `<div class="warn">未提供：${c.missingBasics.map(esc).join('、')} —— 「没查」与「没给我」临床含义不同，请医生注意。</div>` : ''}

<h2>② 核心异常项 <span class="cnt">（每项只看最近一次；P0 展开 ${c.p0} 项）</span></h2>
${staleWarn}
${card.p0rows.length
  ? `<table><thead><tr><th>项目</th><th class="v">数值</th><th class="ref">参考</th><th class="d">日期 · 医院</th></tr></thead><tbody>${card.p0rows.map((r) => tr(r, { critical: !!r.critical })).join('')}</tbody></table>`
  : '<div class="q">本次资料里 P0 核心项没有越出参考区间的记录（或未识别到参考区间）</div>'}
${p1Summary}

<h2>③ 本次主诉与核心诉求 <span class="cnt">（没填就留白，可打印后手写；浅灰是提示语，不会打印成正文）</span></h2>
${chiefHtml}
<div class="two">
  <div class="q"><b>① 最想弄清的新异常/症状：</b>${p.questions?.focus ? esc(p.questions.focus) : '<span class="ph">例：10-16 头颈 MRI 见头部阴影/结节，是否为中枢侵犯或感染？本次能否定性排查？</span>'}</div>
  <div class="q"><b>② 最想请医生定夺的方案：</b>${p.questions?.confirm ? esc(p.questions.confirm) : '<span class="ph">例：要不要做腰穿/脑脊液检查？是否需调整化疗方案或做移植评估？</span>'}</div>
  <div class="q"><b>③ 当前用药与下步计划：</b>${p.questions?.nextVisit ? esc(p.questions.nextVisit) : '<span class="ph">例：现服达沙替尼 100mg qd；下次复查血常规 2 周后、骨穿 1 个月后；发热≥38.5℃ 立即急诊。</span>'}</div>
</div>
${card.checklist?.cardLine ? `<div class="cl">${esc(card.checklist.cardLine)}（据已导入报告自动比对，不代表医嘱）</div>` : ''}
</div>

<!-- ============ 第 2 页：全量归档与原件索引 ============ -->
<div class="page2">
<h2>④ 全部指标 <span class="cnt">（按标准编码去重后共 ${c.latest} 项，按临床大类分组；每项取最近一次，全量不删项）</span></h2>
${card.latestRows.length ? groupedRows(card.latestRows) : '<div class="q">尚未识别出指标</div>'}
</div>

<!-- ============ 第 3 页：关键趋势 ============ -->
<div class="page3">
<h2>⑤ 关键趋势 <span class="cnt">（同项 ≥2 次才画，共 ${c.trends} 项；参考区间取自报告原文）</span></h2>
${card.trendRows.length
  ? `<div class="trend-grid">${card.trendRows.map(trendCell).join('')}</div>`
  : '<div class="q">暂无可比较的历史值（同一项目出现 2 次以上才会显示趋势）</div>'}
${card.trendDroppedDetail && card.trendDroppedDetail.length
  ? `<div class="foot">未绘制（单位不一致，不做换算硬拼，避免假趋势）：${card.trendDroppedDetail.map((t) => esc(t.name) + '（' + t.units.map(esc).join('/') + '）').join('、')}</div>`
  : ''}
</div>

${c.valueConflicts ? `<div class="foot" style="color:#b45309">注：标 * 的 ${c.valueConflicts} 项在原图切块边界上读出过不同数值，已按出现次数最多的取值采用，原始单据可回查。</div>` : ''}
<div class="foot">生成：${esc(String(card.generatedAt).slice(0, 16).replace('T', ' '))} ｜ 本卡只陈述家属提供的数值、日期与判定，不含诊断结论与治疗建议。标 ? 的项目名称含异常字符，需人工核对原件。MedBrief 问诊资料卡 v3。</div>
</body></html>`
}

export const INTAKE_ROOT = ROOT
