// ===================== 分型资料卡 · 派生逻辑（纯函数）=====================
// 定位：一张「病人↔医生」共读的简要分型档案，只做**证据归位**，不做诊断推断。
// 六项固定信息：就诊医院 / 患病时间 / 分型 / 基因特点 / 当前疗程 / 当前阶段。
//
// 三条硬口径（与 docs/分型资料卡-design-v1.md 一致）：
//   ① 只列**检出**的分子通道（主标志物优先），全阴通道不占位；
//   ② 数值/病名照抄来源报告，不换算、不推测；拿不到就返回空串，由 UI 显示「未记录」；
//   ③ 患者身份脱敏：姓名脱离散（maskName），不输出住院号/证件号。
//
// 本模块零依赖浏览器 API（可在 node 直接 import 做单测）：只依赖 diseaseGrade / diseaseThresholds。

import { pickPrimaryAnalyte, streamState, ladderOf, formatPct, todayStr, daysBetween, TIER_LABELS } from './diseaseGrade.js'

const S = (v) => (v == null ? '' : String(v)).trim()
const d10 = (v) => S(v).slice(0, 10)
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}
const byDateDesc = (a, b) => d10(b && (b.date || b.issued_at || b.start)).localeCompare(d10(a && (a.date || a.issued_at || a.start)))

// ---- 病历文书：诊断结论只认「诊断证明 / 出院记录」这类结构化文书 ----
const CASE_DOC_RE = /诊断证明|出院记录|入院记录|病程记录/
// 诊断长串的分隔符：OCR 常把「；」读成引号/顿号（实测「”恶性肿瘤维持性化学治疗”…」），一律当分隔
const DX_SEP_RE = /[；;，,、。”"“\n]/
// 病名解析只依赖「疾病类别后缀词表」，**不写具体病名**——任何以这些后缀结尾的诊断串都能解析
// （写死「急性淋巴细胞白血病」这类具体名字，换个病人就哑了）。
const DX_SUFFIX =
  '(?:白血病|淋巴瘤|骨髓瘤|骨髓增生异常综合征|骨髓增殖性肿瘤|骨髓增生性肿瘤|骨髓纤维化|再生障碍性贫血|真性红细胞增多症|原发性血小板增多症|阵发性睡眠性血红蛋白尿)'
const DX_NAME_RE = new RegExp(`[\\u4e00-\\u9fa5]{0,9}${DX_SUFFIX}`)
// 诊断串里的前置动词/虚词（「考虑急性…」「初步诊断为…」）在取病名时剥掉
const DX_LEAD_RE = /^(?:考虑|诊断|符合|疑似|倾向|临床诊断|病理诊断|出院诊断|初步诊断|为|系|及)+/
// 基因检测报告的类型判定（检查报告 doc_type / kind 两种写法都要认）
const GENETIC_DOC_RE = /基因检测|基因突变|染色体\/芯片|融合基因/

/** 姓名脱敏：保留首字，其余替换为 *（单字保留原样，空返回空） */
export function maskName(name) {
  const s = S(name)
  if (!s) return ''
  const chars = [...s]
  if (chars.length === 1) return chars[0]
  return chars[0] + '*'.repeat(Math.min(chars.length - 1, 3))
}

/** 病历文书（诊断证明 / 出院记录 …），按日期倒序 */
function caseDocsOf(docs = []) {
  return (docs || [])
    .filter((d) => d && (d.category === 'case' || CASE_DOC_RE.test(S(d.doc_type))))
    .sort(byDateDesc)
}

/** 从诊断长串里取出病名：按「疾病类别后缀」匹配，剥掉前置动词；取不到即返回空（不猜） */
function pickDiseaseName(raw) {
  const segs = S(raw)
    .split(DX_SEP_RE)
    .map((x) => x.trim())
    .filter(Boolean)
  for (const seg of segs) {
    const m = seg.match(DX_NAME_RE)
    if (!m) continue
    const name = m[0].replace(DX_LEAD_RE, '').replace(/[（(].*$/, '').trim()
    if (name.length >= 3) return name
  }
  return ''
}

/**
 * 诊断结论：取最近一份病历文书的「出院诊断」里的病名。
 * 同一份文书优先 `diagnosis`（诊断证明，逐字录入最干净），再退回 discharge_/admission_ 版本。
 */
function pickDiagnosis(docs = []) {
  for (const d of caseDocsOf(docs)) {
    const f = d.fields || {}
    for (const raw of [f.diagnosis, f.discharge_diagnosis, f.admission_diagnosis]) {
      const name = pickDiseaseName(raw)
      if (name) return { text: name, date: d10(d.date), department: S(f.department) }
    }
  }
  return { text: '', date: '', department: '' }
}

/** 就诊医院：最近一张发票（票面最可靠）→ 最近住院段备注里的院名 → 空 */
function pickHospital({ invoices = [], stays = [] } = {}) {
  const inv = (invoices || [])
    .filter((v) => v && (S(v.hospital) || S(v.hospital_short)))
    .sort((a, b) => d10(b.issued_at).localeCompare(d10(a.issued_at)))[0]
  if (inv) return S(inv.hospital_short) || S(inv.hospital)
  const stay = (stays || []).filter((x) => x && S(x.note)).sort(byDateDesc)[0]
  if (stay) {
    const m = S(stay.note).match(/[\u4e00-\u9fa5]{2,12}医院/)
    if (m) return m[0]
  }
  return ''
}

/** 患病（起病）时间：库内最早一条证据（化验记录 / 检查文书 / 病情点）的日期 */
function pickOnset({ records = [], docs = [], diseaseMetrics = [] } = {}) {
  const all = [
    ...(records || []).map((r) => d10(r.date || r.checked_at || r.reported_at)),
    ...(docs || []).map((d) => d10(d.date || d.reported_at)),
    ...(diseaseMetrics || []).map((m) => d10(m.date)),
  ].filter(Boolean)
  return all.sort()[0] || ''
}

/** 分子通道文案：'P190' → 'p190'（其余原样，如 other） */
const analyteLabel = (a) => {
  const s = S(a)
  if (!s) return ''
  return /^p\d+$/i.test(s) ? `p${s.slice(1)}` : s.toLowerCase() === 'other' ? 'other' : s
}

// ===================== 基因检测报告 → 标签（通用解析，不写基因名单）=====================
// 只看报告**原文说的**：报告标题里的基因符号 + 所见/结论里的「阳性 / 未见突变 / 缺失 / 重排 / 表达值」。
// 以前这里是「IKZF1 / CSRP2 / TP53 / IgH」四条写死规则 —— 换个病人、换份报告就哑了（用户 2026-10-27 指出）。
// 现在改成词法解析：任何基因名都能出来；判不出状态就不出标签（宁缺勿猜）。

// 基因符号：报告标题里的拉丁字母串（IKZF1 / TP53 / CSRP2 / IgH / FLT3-ITD / NPM1 / JAK2 …）
const GENE_SYMBOL_RE = /(?:^|[^A-Za-z])([A-Z][A-Za-z0-9]{1,9}(?:[\/-][A-Za-z0-9]{1,9})?)(?![A-Za-z])/
// 大写英文缩写白名单式排除：不是基因的标题词（报告名/单位/方法）
const NON_GENE = /^(?:PCR|RT|DNA|RNA|CDNA|NGS|FISH|ALL|AML|MDS|CML|MPN|MRD|ABL|BM|NGS|COV|ID|TUBE|EXON)$/i

// 异常类型（按报告用词，不按基因猜）
const KIND_RES = [
  [/缺失|deletion/i, '缺失'],
  [/重排|rearrange/i, '重排'],
  [/表达|转录本|拷贝数|表达量/, '表达'],
  [/突变|变异|mutation|variant|ITD/i, '突变'],
]
// 阴性/阳性判定（报告用词）
const NEGATIVE_RE = /未见突变|未检出|未见(?:与疾病相关|明显异常|异常)|阴性|正常表达|野生型|未发现/
const POSITIVE_RE = /阳性|检出|阳性突变|高表达/

function geneSymbolOf(title) {
  const m = S(title).match(GENE_SYMBOL_RE)
  if (!m) return ''
  const sym = m[1]
  return NON_GENE.test(sym) ? '' : sym
}

function kindOf(text) {
  for (const [re, kind] of KIND_RES) if (re.test(text)) return kind
  return ''
}

// 定量表达的上下调：报告写法「…=113.4%；正常值<1.8%」
function expressionVerdict(text) {
  const pcts = [...S(text).matchAll(/=\s*(\d+(?:\.\d+)?)\s*%/g)].map((m) => num(m[1])).filter((v) => v != null)
  const ref = S(text).match(/正常值?\s*[<＜≤]\s*(\d+(?:\.\d+)?)\s*%/i)
  const v = pcts.length ? pcts[pcts.length - 1] : null
  const limit = ref ? num(ref[1]) : null
  if (v == null || limit == null) return ''
  if (v > limit) return '高表达'
  if (v < limit) return '' // 低于参考不等于「低表达」结论，不臆造
  return ''
}

/**
 * 基因特点标签（芯片）：主标志物（分子流）+ 每份基因检测报告的原文结论。
 * hot = 报告**检出了异常**（需关注），不代表预后判断——预后是该由医生下的结论，卡不做推断。
 */
function buildGenes(diseaseMetrics = [], docs = []) {
  const out = []
  const push = (text, hot = false, hint = '', rank = 9) => {
    if (text && !out.some((x) => x.text === text)) out.push({ text, hot, hint, rank })
  }

  // ① 主标志物：来自分子流（融合基因定量报告自动抽取的点），报告检出过才出标签
  const detected = (diseaseMetrics || []).some((m) => m && m.stream === 'pcr' && m.qualifier !== 'nd' && num(m.value) > 0)
  const primary = pickPrimaryAnalyte(diseaseMetrics || [])
  if (detected && primary)
    push(`BCR-ABL1 ${analyteLabel(primary)} 阳性`, true, '融合基因定量报告检出该转录本，是分型与疗效监测的靶标（定量见「阶段」）', 0)

  // ② 基因检测报告：标题里的基因符号 + 所见/结论里的状态词
  const genetic = (docs || [])
    .filter((d) => d && (GENETIC_DOC_RE.test(S(d.doc_type)) || d.kind === 'genetic'))
    .sort(byDateDesc)
  for (const d of genetic) {
    const title = S(d.title)
    const text = `${title} ${S(d.findings)} ${S(d.conclusion)}`
    const gene = geneSymbolOf(title)
    if (!gene) continue // 无基因符号（如「淋系肿瘤 129 基因」这类 panel）→ 不逐条编标签
    const kind = kindOf(text)
    const date = d10(d.date)
    const vm = text.match(/[△Δ]\s*(\d+)\s*[-–—~]\s*(\d+)/)
    const variant = vm ? [vm[1], vm[2]] : null
    const neg = NEGATIVE_RE.test(text) && !/阳性/.test(text)
    if (neg) {
      // 「未见突变 / 未检出重排」这类阴性结果也照报告写出来（原文措辞）
      const label = kind === '表达' ? `${gene} 表达正常` : `${gene} 未见${kind || '异常'}`
      push(label, false, `报告原文：未见该异常（${date}）；这是阴性结果，不是缺失或阳性`, 5)
      continue
    }
    // 定量表达类：报告常常不写「阳性」，只给「=113.4%；正常值<1.8%」——用数值与参考上限比大小判定
    const ex = kind === '表达' ? expressionVerdict(text) : ''
    if (ex) {
      push(`${gene} ${ex}`, true, `报告定量高于参考上限（${date}）；是否影响预后由医生结合分型判断`, 3)
      continue
    }
    if (!POSITIVE_RE.test(text)) continue // 既不说阳性、也没有可比数值 → 不臆造
    let label = `${gene} ${kind || '阳性'}`
    if (variant) label = `${gene} Δ${variant[0]}-${variant[1]} ${kind || '缺失'}`
    const hintByKind = {
      缺失: `报告检出缺失（区间见标签），是可追踪的克隆性异常（${date}）`,
      重排: `报告检出基因重排，可作为克隆追踪标记（${date}）`,
      突变: `报告检出该基因变异（${date}）；是否影响预后由医生结合分型判断`,
      表达: `报告定量显示高于参考上限（${date}）`,
    }
    push(label, true, hintByKind[kind] || `报告检出该异常（${date}）`, kind === '表达' ? 3 : kind === '重排' ? 4 : 1)
  }

  return out.sort((a, b) => a.rank - b.rank).slice(0, 3).map(({ text, hot, hint }) => ({ text, hot, hint }))
}

/** 当前疗程：进行中（end 为空）优先，否则最近一次已结束的疗程 */
function buildCourse(courses = []) {
  const list = (courses || []).filter((c) => c && S(c.name)).sort((a, b) => d10(b.start).localeCompare(d10(a.start)))
  const active = list.find((c) => !S(c.end))
  if (active) {
    return { name: S(active.name), start: d10(active.start), end: '', active: true, text: `${S(active.name)}（${d10(active.start)} 起）` }
  }
  const last = list[0]
  if (last) {
    return {
      name: S(last.name),
      start: d10(last.start),
      end: d10(last.end),
      active: false,
      text: `${S(last.name)}（${d10(last.start)}${last.end ? ` – ${d10(last.end)}` : ''}，已结束）`,
    }
  }
  return { name: '', start: '', end: '', active: false, text: '' }
}

// 单维数值文案：**有数字就照抄数字，没数字才写「未检出」，且只写一个说法**。
//   ① 报告给出数字（含 0，如 `0/793000=0%`）→ 就写数字：`0%`；判定仍按未检出（在悬停里说明）
//   ② 报告只给定性结论（阴性 / 未见异常免疫表型），无数字 → `未检出`
//   ③ 判低于检出限 → `<0.01%`；④ 该维无数据 → `未检测`
// 不再写 `0%（未检出）` 这种半数字半解释的拼接（前两轮反馈：一句话说三遍）。
function streamValueText(st) {
  if (!st || st.missing) return '未检测'
  const p = st.latest
  if (!p) return '未检测'
  const v = num(p.value)
  if (v == null) return p.qualifier === 'nd' ? '未检出' : '未检测'
  if (p.qualifier === 'lt') return `<${formatPct(v)}%`
  return `${formatPct(v)}%`
}

// 单维悬停说明：报告原文口径（报告写 0 就写 0，写阴性就写阴性）+ 日期 + 阈值
function streamTipText(st, target) {
  if (!st || st.missing) return '未检测'
  const p = st.latest
  if (!p) return '未检测'
  const d = String(p.date || '').slice(0, 10)
  const v = num(p.value)
  const reported =
    p.qualifier === 'nd' ? (v == null ? '阴性/未检出' : `报告写 ${formatPct(v)}%（阴性）`) : p.qualifier === 'lt' ? `<${formatPct(v)}%` : `${formatPct(v)}%`
  return `${reported}（${d}）· 目标 ${target}`
}

/** 当前阶段：复用病情三维度的缓解阶梯（阈值只读，口径与 /cbc 一致） */
function buildStage(diseaseMetrics = [], today) {
  const primary = pickPrimaryAnalyte(diseaseMetrics || [])
  const states = {
    morph: streamState(diseaseMetrics || [], 'morph', today),
    fcm: streamState(diseaseMetrics || [], 'fcm', today),
    pcr: streamState(diseaseMetrics || [], 'pcr', today, { primaryAnalyte: primary }),
  }
  const ladder = ladderOf(states, today)
  // 卡面：三维各一个说法，不再重复层级名（层级已在卡头徽标）
  const detail = [
    `形态 ${streamValueText(states.morph)}`,
    `流式 ${streamValueText(states.fcm)}`,
    `分子 ${streamValueText(states.pcr)}`,
  ].join(' · ')
  const tip = [
    `形态学 ${streamTipText(states.morph, '≤5%')}`,
    `流式 ${streamTipText(states.fcm, '<0.01%')}`,
    `分子 ${streamTipText(states.pcr, '≤0.1%')}`,
    '卡面照抄报告数字；0% 与「阴性」判定相同（都按未检出）',
  ].join('；')
  return {
    tier: ladder.tier,
    label: TIER_LABELS[ladder.tier] || '',
    // 第 4 级的证据强度：'double' 双证（qPCR 未检出 + FCM 阴性）｜'molecular' 仅分子学单证
    certify: ladder.certify || null,
    detail,
    tip,
    gaps: ladder.gaps || [],
  }
}

/**
 * 分型资料卡视图模型（纯函数）
 * @param {Object} state { patientMeta, records, docs, events, courses, invoices, stays, diseaseMetrics }
 * @param {string} [today] YYYY-MM-DD
 * @returns {{identity:Object, hospital:string, onset:Object, typing:Object, genes:Array, course:Object, stage:Object}}
 */
export function buildTypingCard(state = {}, today = todayStr()) {
  const { patientMeta = {}, records = [], docs = [], courses = [], invoices = [], stays = [], diseaseMetrics = [] } = state || {}

  const gender = /^f/i.test(S(patientMeta.gender)) ? '女' : /^m/i.test(S(patientMeta.gender)) ? '男' : ''
  const age = num(patientMeta.age)
  const dx = pickDiagnosis(docs)

  // 分型：诊断名（照抄病历）+ Ph 状态（均由已入库数据判定；转录本放「基因特点」标签，不在此重复）
  const pcrDetected = (diseaseMetrics || []).some((m) => m && m.stream === 'pcr' && m.qualifier !== 'nd' && num(m.value) > 0)
  const corpus = (docs || []).map((d) => `${S(d.findings)} ${S(d.conclusion)}`).join(' ')
  const phPositive = pcrDetected || /t\(9;22\)|Ph\+|费城染色体/.test(corpus)
  const baseDx = dx.text || S(patientMeta.diagnosis)
  // 分型只写「Ph 状态 + 病名」：转录本（p190 等）属于分子标志，放在「基因特点」标签里，
  // 不在两处重复（Ph+ 本身已由 BCR-ABL1 融合定义，括号再写一遍是冗余）。
  const typingText = baseDx ? `${phPositive ? 'Ph+ ' : ''}${baseDx}` : ''

  const onset = pickOnset({ records, docs, diseaseMetrics })
  const days = onset ? daysBetween(onset, today) : null

  return {
    identity: {
      name: maskName(patientMeta.name),
      gender,
      age: age == null ? '' : `${age} 岁`,
      department: dx.department,
    },
    hospital: pickHospital({ invoices, stays }),
    onset: { date: onset, days: days == null ? null : days, text: onset ? `${onset}${days != null ? `（${days} 天）` : ''}` : '' },
    typing: { text: typingText, sourceDate: dx.date, phPositive },
    genes: buildGenes(diseaseMetrics, docs),
    course: buildCourse(courses),
    stage: buildStage(diseaseMetrics, today),
  }
}
