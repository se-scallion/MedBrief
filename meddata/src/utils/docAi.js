// ===================== 检查报告 AI 主识别 · 三轨合并（OCR / AI / 手改）=====================
// 纯函数模块（**不得引用任何浏览器 API**），由 DocImportFlow 调用，并由 scripts/verify-doc-ai.mjs 单测。
// 设计与红线见 .agents/proposals/ai-first-doc-recognition.md §3.3 / §4.1(c)。
//
// 三轨模型：
//   _track[field]  = 该字段当前「生效」的轨：'ocr' | 'ai' | 'user'
//   _tracks.ocr    = 本地识别（tesseract / pdfjs 文字层 + parseDocText）读出的值（永远保留）
//   _tracks.ai     = AI 精读读出的值（永远保留）
//   _track[field]==='user' 表示用户亲手改过 → 锁定，任何机器轨只提示不覆盖
//
// 三条不可动摇的规则：
//   1) 【并行安全】OCR 结果**只能**写 _tracks.ocr；生效轨不是 'ocr' 时绝不改生效值
//      —— 否则「AI 先到、OCR 后到」的并行场景会把 AI 的结果冲掉（用户明确要求保证的点）。
//   2) 【结果以 AI 为准】AI 非空值覆盖生效值并把生效轨切到 'ai'，但**永不覆盖 user 轨**。
//   3) 【保守不删】AI 返回空值时**不清空**已有的非空值（空 = 没读到，不等于"该字段为空"），
//      只在两轨差异里标注「AI 未读出」；measures 同理，空数组不删已有项。
//      理由：医学数据「错值可见、丢值不可见」——清空会让用户失去核对锚点，而保留的值就摆在原图旁边可核对。
//      若日后要改成字面意义的「AI 为准（含清空）」，只需把 OVERWRITE_WITH_EMPTY 置 true。

import { normalizeCaseDocType } from '../data/docKinds.js'

export const OVERWRITE_WITH_EMPTY = false

export const TRACK_LABELS = { ocr: '本地识别', ai: 'AI 精读', user: '已手改' }

// 参与三轨的字段（顺序即 UI 顺序）。measures 是数组，单独处理（整体切轨）。
export const DOC_TRACK_FIELDS = [
  ['kind', '报告类别'],
  ['doc_type', '报告类型'],
  ['title', '报告标题'],
  ['part', '检查部位'],
  ['date', '检查日期'],
  ['time', '检查时间'],
  ['reported_at', '报告时间'],
  ['findings', '检查所见'],
  ['conclusion', '诊断结论'],
]

// 只看「有内容」的字段：空字符串在 UI 上不该标成「已识别」
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === ''

// 两轨值是否等价（数组序列化比较；字符串去首尾空白）
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || [])
  return String(a === undefined || a === null ? '' : a).trim() === String(b === undefined || b === null ? '' : b).trim()
}

// 空的轨元数据（幂等初始化；老草稿无此字段时直接给默认值即可，无需迁移）
export const emptyTrackState = () => ({ _track: {}, _tracks: { ocr: {}, ai: {} } })

// 把某个轨道的结果并入草稿（核心函数，mergeOcrIntoDraft / mergeAiIntoDraft 都走它）
//   source: 'ocr' | 'ai'
//   values: { [field]: value }，字段须在 DOC_TRACK_FIELDS 或 'measures'
export function recordTrack(form, source, values) {
  if (!form) return form
  const track = { ...(form._track || {}) }
  const tracks = {
    ocr: { ...((form._tracks || {}).ocr || {}) },
    ai: { ...((form._tracks || {}).ai || {}) },
  }
  const next = { ...form }
  const fields = [...DOC_TRACK_FIELDS.map(([f]) => f), 'measures']
  for (const field of fields) {
    if (!(field in (values || {}))) continue
    const v = values[field]
    tracks[source][field] = v
    const cur = track[field]
    if (source === 'ocr') {
      // 规则 1：并行安全——只有该字段本来就归 OCR 管（或还没人管）时才动生效值
      if (cur === undefined || cur === 'ocr') {
        next[field] = v
        track[field] = 'ocr'
      }
    } else if (source === 'ai') {
      // 规则 2 + 3：AI 为准，但不覆盖人工轨、不用空值清空已有内容
      if (cur === 'user') continue
      if (isEmpty(v) && !isEmpty(next[field]) && !OVERWRITE_WITH_EMPTY) continue
      next[field] = v
      track[field] = 'ai'
    }
  }
  next._track = track
  next._tracks = tracks
  return next
}

// OCR 轨并入（**只写 _tracks.ocr**，生效轨非 'ocr' 时不动生效值）
export const mergeOcrIntoDraft = (form, ocrValues) => recordTrack(form, 'ocr', ocrValues)

// AI 结果 → 可并入的字段集（v2 契约；status 非 done 时一律不写，保证失败零副作用）
export function aiValuesFromResult(ai) {
  if (!ai || (ai.status && ai.status !== 'done')) return {}
  const out = {}
  const put = (k, v) => {
    if (v !== undefined && v !== null) out[k] = v
  }
  put('kind', ai.kind)
  put('doc_type', ai.doc_type)
  put('title', ai.title)
  put('part', ai.part)
  put('date', ai.date)
  put('time', ai.time)
  put('reported_at', ai.reported_at)
  put('findings', ai.findings)
  put('conclusion', ai.conclusion)
  if (Array.isArray(ai.measures) && ai.measures.length) out.measures = ai.measures
  return out
}

// AI 轨并入（生效轨切 'ai'，手改字段除外）
export const mergeAiIntoDraft = (form, ai) => recordTrack(form, 'ai', aiValuesFromResult(ai))

// 用户手改某字段 → 锁定为 user 轨（之后任何机器结果都只提示不覆盖）
export function markUserEdit(form, field) {
  if (!form) return form
  return { ...form, _track: { ...(form._track || {}), [field]: 'user' } }
}

// 手动切轨（字段级 [AI ●][OCR ○] 切换器 / 「采用 AI 结果」按钮共用）：
// 把生效值换成目标轨已存的值。目标轨没有该字段的值则原样返回（不产生空切换）。
export function switchTrack(form, field, to) {
  if (!form || !['ocr', 'ai'].includes(to)) return form
  const bag = (form._tracks || {})[to] || {}
  if (!(field in bag)) return form
  return { ...form, [field]: bag[field], _track: { ...(form._track || {}), [field]: to } }
}

// 某字段当前生效轨；未记录时回退：有 AI 值算 ai、否则 ocr
export function trackOf(form, field) {
  const t = (form && form._track && form._track[field]) || ''
  if (t) return t
  const ai = ((form && form._tracks && form._tracks.ai) || {})[field]
  return ai !== undefined ? 'ai' : 'ocr'
}

// 两轨差异清单（底部差异条 + 字段旁 ⚠ 标记）：只列「两轨都有值且不同」与「一轨缺值」的字段
export function diffTracks(form) {
  const out = []
  if (!form || !form._tracks) return out
  const fields = [...DOC_TRACK_FIELDS, ['measures', '关键测量值']]
  for (const [field, label] of fields) {
    const ocr = (form._tracks.ocr || {})[field]
    const ai = (form._tracks.ai || {})[field]
    if (ocr === undefined && ai === undefined) continue
    if (sameValue(ocr, ai)) continue
    out.push({
      field,
      label,
      ocr,
      ai,
      effective: (form._track || {})[field] || '',
      // AI 有值但为空 → 「AI 未读出」（我们保留本地值，需要提示用户核对，而不是当成冲突）
      aiMissing: isEmpty(ai),
      ocrMissing: isEmpty(ocr),
    })
  }
  return out
}

// AI 置信度三档（UI 文案）
const CONF_LABEL = { high: '高', medium: '中', low: '低' }
export function aiConfidenceLabel(ai) {
  const c = ai && ai.confidence && ai.confidence.overall
  return CONF_LABEL[c] || ''
}

// 引文覆盖：有几个字段拿到了 evidence（防幻觉的核对锚点）
export function evidenceFields(ai) {
  const set = new Set()
  for (const e of (ai && ai.evidence) || []) {
    if (e && e.field) set.add(e.field)
  }
  return [...set]
}

// 某字段的引文（可与原图对照的原文片段）
export function evidenceOf(ai, field) {
  const hits = ((ai && ai.evidence) || []).filter((e) => e && e.field === field && e.quote)
  return hits.map((e) => String(e.quote).trim()).filter(Boolean)
}

// 读图 or 读文本：只有「真·PDF 文字层」才走 doc-text（不读图，约省一半时间）。
//
// ⚠ 判据必须是「文字从哪来」而不是「文本有多长」（2026-10-15 实测踩坑）：
//   OCR 出的乱码同样能有几百字（骨髓报告实测 541 字的乱码），喂给 doc-text 模式只会得到
//   findings 置信度 low 的垃圾（agent 诚实标 low、不编造，但用户什么都拿不到）。
//   故扫描件（isScanned，文本来自 OCR）一律走读图；只有 pdfjs 直抽的文字层才走文本模式。
export const DOC_TEXT_MIN_CHARS = 200
export function docReadModeFor({ isImage, isScanned, textLen }) {
  if (isImage || isScanned) return 'doc'
  return textLen >= DOC_TEXT_MIN_CHARS ? 'doc-text' : 'doc'
}

// ===================== 复用已完成的 AI 任务：命中优先级 =====================
// 为什么必须定优先级（2026-10-25）：点「AI 重读」时先捡上一次已跑完的结果，能省一次 agent 费用；
// 原实现只按 fileName 匹配（同名不同图 → 静默接上别人的结果）。真实语料里同名任务 6 组（同一张
// 出院诊断证明跑了 6 次），一旦其中混进"同名但不同图"，就会把错值摆到用户面前。
// 现在按「任务号 > 原件字节哈希 > 文件名」降级，并把命中依据返回给 UI 明示。
export const RECOVER_MATCH_LABELS = { task: '任务号', sha: '原件字节哈希', name: '文件名（弱匹配，需核对）' }

export function pickRecoverTask(tasks, { taskId, sha256, fileName } = {}) {
  const list = (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.state === 'done')
    .slice()
    // 新→旧：同一 sha 重跑过多次时优先拿最近一次（契约/prompt 都是最新的）
    .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))
  const preferFresh = (arr) => arr.find((t) => !t.reviewed) || arr[0] || null
  const tiers = [
    ['task', () => (taskId ? list.filter((t) => t.id === taskId) : [])],
    ['sha', () => (sha256 ? list.filter((t) => t.sha256 && t.sha256 === sha256) : [])],
    ['name', () => (fileName ? list.filter((t) => t.fileName && t.fileName === fileName) : [])],
  ]
  for (const [matchedBy, build] of tiers) {
    const hit = preferFresh(build())
    if (hit) return { task: hit, matchedBy }
  }
  return null
}

// AI 结果 → 存进草稿的元数据（_ai，下划线字段不落库、不进导出）
export function aiMetaFrom(id, ai, elapsedMs) {
  return {
    id,
    status: (ai && ai.status) || 'unknown',
    version: (ai && ai.version) || 1,
    kind: (ai && ai.kind) || '',
    docType: (ai && ai.doc_type) || '',
    category: (ai && ai.category) || '',
    confidence: (ai && ai.confidence && ai.confidence.overall) || '',
    perField: (ai && ai.confidence && ai.confidence.per_field) || {},
    evidence: (ai && ai.evidence) || [],
    notes: (ai && ai.notes) || '',
    elapsedMs: elapsedMs || 0,
    at: new Date().toISOString(),
  }
}

// ===================== 详情页「AI 重读」：旧记录 vs AI 结果逐字段差异 =====================
// 与草稿期的三轨模型不同：已归档记录是**人工核对过的既有事实**，AI 只提供「候选新值」，
// 由用户在弹窗里逐字段勾选采用（绝不自动覆盖）。见 proposals §4.4。

// 逐字段差异（只列 AI 给出了值的字段；两值等价则跳过）
//   empty=true 表示「AI 读出该字段为空」——即采用后会清空原值，UI 应默认不勾选并明示。
export function diffDocVsAi(doc, ai) {
  const values = aiValuesFromResult(ai)
  const out = []
  for (const [field, label] of [...DOC_TRACK_FIELDS, ['measures', '关键测量值']]) {
    if (!(field in values)) continue
    const oldV = (doc || {})[field]
    const newV = values[field]
    if (sameValue(oldV, newV)) continue
    out.push({ field, label, old: oldV, new: newV, empty: isEmpty(newV), ocrEmpty: isEmpty(oldV) })
  }
  return out
}

// 按勾选字段生成写库 patch（只包含 AI 真正给出值的字段）
export function aiPatchFor(ai, fields = []) {
  const values = aiValuesFromResult(ai)
  const patch = {}
  for (const f of fields) {
    if (f in values) patch[f] = values[f]
  }
  return patch
}

// 详情页展示用的差异文本（数组类字段转成可读串，避免 React 直接渲染对象数组报错）
export function diffText(v) {
  if (v === undefined || v === null || v === '') return '（空）'
  if (Array.isArray(v)) return v.map((m) => `${m.name} ${m.value}${m.unit || ''}`).join(' · ') || '（空）'
  return String(v)
}

// ===================== 病历文书（case）详情页「AI 重读」：旧记录 vs AI 逐字段差异 =====================
// 文书的结构化字段躺在 doc.fields 里（出院日期/入院日期/诊断/医嘱/科室/医师…），而 AI 结果的
// 顶层是 kind/doc_type/title/date/findings/conclusion。两边形状不同，逐字段对比前先铺平。
export const CASE_AI_FIELDS = [
  ['kind', '报告类别'],
  ['doc_type', '报告类型'],
  ['title', '标题'],
  ['date', '出院/开证日期'],
  ['admission_date', '入院日期'],
  ['discharge_date', '出院日期'],
  ['diagnosis', '诊断'],
  ['discharge_diagnosis', '出院诊断'],
  ['discharge_advice', '出院医嘱'],
  ['rest_days', '建议休息天数'],
  ['department', '科室'],
  ['doctor', '医师'],
  ['findings', '所见'],
  ['conclusion', '结论'],
]

// 这些字段在库里是 doc.fields[k]，不是 doc[k]
const CASE_FIELDS_ROOT = new Set([
  'admission_date',
  'discharge_date',
  'diagnosis',
  'discharge_diagnosis',
  'discharge_advice',
  'discharge_meds',
  'hospital_days',
  'rest_days',
  'department',
  'doctor',
])

// AI 结果 → 铺平后的 key→value（顶层优先，取不到再往 ai.fields 里找；空值一律跳过）
export function aiCaseValuesFromResult(ai) {
  if (!ai || (ai.status && ai.status !== 'done')) return {}
  const out = {}
  for (const [k] of CASE_AI_FIELDS) {
    if (!isEmpty(ai[k])) out[k] = ai[k]
    else if (ai.fields && !isEmpty(ai.fields[k])) out[k] = ai.fields[k]
  }
  return out
}

const caseOldValue = (doc, k) => (CASE_FIELDS_ROOT.has(k) ? (doc && doc.fields ? doc.fields[k] : undefined) : doc && doc[k])

// 逐字段差异（只列 AI 给出值的字段；等价则跳过）。empty=true 表示「采用会清空原值」。
export function diffCaseVsAi(doc, ai) {
  const values = aiCaseValuesFromResult(ai)
  const out = []
  for (const [field, label] of CASE_AI_FIELDS) {
    if (!(field in values)) continue
    const oldV = caseOldValue(doc, field)
    if (sameValue(oldV, values[field])) continue
    out.push({ field, label, old: oldV, new: values[field], empty: isEmpty(values[field]), ocrEmpty: isEmpty(oldV) })
  }
  return out
}

// 按勾选字段生成写库 patch（结构化字段合并进 doc.fields，其余写顶层；未勾选一律保留旧值）
export function aiCasePatchFor(doc, ai, fields = [], category = '') {
  const values = aiCaseValuesFromResult(ai)
  const patch = {}
  const picked = fields.filter((f) => f in values)
  if (!picked.length) return patch
  const structured = picked.filter((f) => CASE_FIELDS_ROOT.has(f))
  if (structured.length) {
    patch.fields = { ...((doc && doc.fields) || {}) }
    for (const f of structured) patch.fields[f] = values[f]
  }
  for (const f of picked) if (!CASE_FIELDS_ROOT.has(f)) patch[f] = values[f]
  // 文书 doc_type 归一：AI 常写「诊断证明书 / 出院诊断证明书」，与规则层的「诊断证明」是同一个意思，
  // 但会打挂查重键（date + doc_type + file_name）→ 写库前统一成规范值
  if (patch.doc_type !== undefined) {
    patch.doc_type = normalizeCaseDocType(patch.doc_type, values.kind || (doc && doc.kind))
  }
  // 类别跟随 kind（仅在采用 kind 时）
  if (picked.includes('kind')) {
    patch.category = category || (['discharge', 'cert'].includes(values.kind) ? 'case' : 'exam')
  }
  // 类型改判时清掉旧类型专属字段（与重识别 buildDocPatch 同口径，否则留下混合态）
  if (picked.includes('kind') && doc && values.kind && values.kind !== doc.kind) {
    const stale =
      values.kind === 'cert'
        ? ['discharge_diagnosis', 'discharge_advice', 'discharge_meds']
        : values.kind === 'discharge'
          ? ['diagnosis', 'rest_days']
          : []
    if (stale.length) {
      patch.fields = { ...(patch.fields || doc.fields || {}) }
      for (const k of stale) delete patch.fields[k]
    }
  }
  return patch
}

// ===================== 病历文书（case）改判路径：AI 结果 → 文书草稿 =====================
// 场景：检查报告导入页的 AI 精读判出「这份是出院记录 / 诊断证明」（category=case），用户改判到
// 文书录入；若只退回规则解析，规则层对「出院诊断证明书」这类文书抽不全（主要诊断 / 信院日期
// 等写法都会漏）。故把 AI 结果随文件带过去，在规则解析之上叠加。
// 口径与 recordTrack 一致：AI 非空值覆盖、空值绝不覆盖（错值可见、丢值不可见）。
export function mergeAiIntoCaseDraft(draft, ai) {
  if (!draft || !ai || (ai.status && ai.status !== 'done')) return draft
  const next = { ...draft, fields: { ...(draft.fields || {}) } }
  let used = 0
  for (const k of ['kind', 'doc_type', 'title', 'date', 'time', 'reported_at', 'findings', 'conclusion']) {
    if (isEmpty(ai[k])) continue
    next[k] = ai[k]
    used += 1
  }
  for (const [k, v] of Object.entries(ai.fields || {})) {
    if (isEmpty(v)) continue
    next.fields[k] = v
    used += 1
  }
  if (used > 0) next._aiUsed = true
  // 同口径归一：草稿与落库都用规范值（「诊断证明书」→「诊断证明」）
  next.doc_type = normalizeCaseDocType(next.doc_type, next.kind)
  return next
}

// ===================== 日期自检（护栏）=====================
// 为什么需要：AC 类检验单常同时印「采样 / 接收 / 报告」三个时间，AI 会把它们拆错
// （实测 Bug 190：报告时间 2026-10-15 早于检查日期 2026-10-16，逻辑上不可能；真值是采样 10-10 16:14 / 报告 10-16 15:13）。
// prompt 侧修法要改共享 prompt 并跑全量 test:doc，代价与并发风险都高；先加这条零风险自检，
// 让"报告时间早于检查日期"这类不可能组合**在任何报告上都会当场显形**，由用户用「编辑」改。
// 判据只认硬逻辑：同一天内不比时刻（只写日期的落款很常见），跨日才判。
export function dateAnomaly(v) {
  const date = String((v && v.date) || '').trim()
  const rep = String((v && v.reported_at) || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
  if (!/^\d{4}-\d{2}-\d{2}/.test(rep)) return ''
  const repDate = rep.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(repDate)) return ''
  if (repDate >= date) return ''
  return `报告时间（${repDate}）早于检查日期（${date}），两份时间必有一处读错，请对照原件核对`
}
