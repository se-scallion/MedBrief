// 报告类型识别（2026-11-15 用户要求：照 MedData 的机制抄全，别半吊子）
//
// MedData 的做法（meddata/src/utils/parseDoc.js:detectTitle + data/reportCatalog.js:inferReportType）
// 关键点有三条，我上次一条都没照做，所以出了「染色体核型报告被判成融合基因」这种错：
//   1. **只看抬头前几行**找标题（标题/医院名几乎总在最前，正文引用语不会跑上来）；
//   2. **标题优先，正文只兜底** —— 本次事故就是正文里出现了「融合基因」四个字（核型结论里写
//      「t(9;22) 易位形成 BCR::ABL 融合基因」），正文关键词把标题盖掉了；
//   3. 标题行要排除字段行/注释行（「报告时间：…」「注：…」不能当标题）。
//
// 本模块不搬 MedData 的类型词表（那是它自己业务的 30 多种文档），而是用**本库已有的 reportType**
// （真实库 56 份里出现过 30 种）来建映射 —— 这样识别出来的名字与资料卡分组、历史记录完全一致。

const CJK = /[\u4e00-\u9fa5]/

/** 标题行去重复拼接（PDF 分栏常把标题拼两遍） */
function dedupeHalf(s) {
  const t = String(s || '').trim()
  if (t.length >= 4 && t.length % 2 === 0 && t.slice(0, t.length / 2) === t.slice(t.length / 2)) return t.slice(0, t.length / 2)
  return t
}

// 字段行/App 界面噪声行：绝不能当标题。
// 实测（手机截屏类报告）：抬头是「12:06 / < 检验报告 •• / 患者信息 …」，
// 而「报告单号 P2026…」只因含「报告单」就被当成标题 → 类型随即判空。
const FIELD_LINE = /^(注[:：]|注释|仅供|本报告|签名|当前页|总页数|报告日期|报告时间|检查时间|检查日期|住院号|姓名|性别|年龄|科室|床号|标本|条码|病历号|临床诊断|检测方法|检测设备|接收时间|采集时间|送检|报告单号|报告编号|报告单编号|项目名称|申请项目)/
const UI_NOISE = /^(\d{1,2}[:：]\d{2})|检验报告$|^患者信息|^[<>•·\s]+$|^[\d\s.:]+$/
const TITLE_KW = /报告单|检查单|检查报告|检测报告|分析报告|基因检测|基因测序|基因芯片|活检报告|彩色多普勒|心电图|超声|磁共振|CT|MRI|X线|X-Ray|培养|涂片|病理|免疫分型|核型|染色体|融合基因|血气|血常规|尿常规|粪便|凝血|生化|病原|mNGS|抗体筛查|血型/

/**
 * 从正文里找「标题行」——照 MedData 的三条排除规则。
 * @returns {string}
 */
export function detectTitle(text = '') {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/[ \t\u3000]+/g, ' ').trim()).filter(Boolean)
  const clean = lines.filter((l) => !UI_NOISE.test(l))
  // ① 「项目名称 / 检查项目 / 检验项目」的值就是本页真正的标题（MedData parseDoc:extractTestItem 同口径）。
  //    实测（手机截屏类影像报告）抬头全是 App 界面文字，只有这一行写着「超声-床旁超声」「磁共振-头颈」。
  for (const l of clean.slice(0, 14)) {
    const m = l.match(/^(?:项目名称|检查项目|检验项目|检测项目|申请项目)[:：\s]+(.{2,30})$/)
    if (m && CJK.test(m[1])) return m[1].trim()
  }
  const head = clean.slice(0, 10)
  for (const raw of head) {
    let t = dedupeHalf(raw)
    if (t.length < 2 || t.length > 40) continue
    if (FIELD_LINE.test(t)) continue
    // 去掉行内机构前缀（「××医院检验科 血常规报告单」→「血常规报告单」）
    const m = t.match(/([\u4e00-\u9fa5A-Za-z]{2,}报告单)/)
    if (m) return m[1]
    const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length
    if (TITLE_KW.test(t) && cn >= 2) return t
  }
  // 抬头没有标题：退化到前 8 行整体判断（有些系统只在页眉打一行中文名）
  const head2 = head.join(' ')
  if (TITLE_KW.test(head2) && CJK.test(head2)) return head2.slice(0, 40)
  return ''
}

// 科目类型规则：**只看标题**（顺序 = 优先级）。命名与真实库现有 reportType 对齐。
const TYPE_RULES = [
  [/染色体.{0,4}核型|核型分析|Karyotype/i, '染色体核型', 'pathology'],
  [/融合基因|基因重排|BCR.{0,2}ABL.{0,6}定量|P210|P190/i, '融合基因', 'pathology'],
  [/流式.{0,6}(免疫)?分型|免疫分型|MRD|残留病/i, '流式免疫分型', 'pathology'],
  [/骨髓.{0,4}(形态|涂片|细胞学|活检)|骨穿|骨髓穿刺/i, '骨髓形态学（骨穿）', 'pathology'],
  [/血气/i, '血气', 'lab'],
  [/凝血/i, '凝血四项', 'lab'],
  [/血常规|全血细胞|血细胞分析|血球计数/i, '血常规', 'lab'],
  [/(尿|尿液)(常规|沉渣|分析)/i, '尿常规', 'lab'],
  [/粪便|大便常规|便常规/i, '粪便常规', 'lab'],
  [/生化|肝功|肾功|电解质|心肌酶/i, '生化', 'lab'],
  [/不规则抗体|抗体筛查/i, '不规则抗体筛查', 'lab'],
  [/ABO|RhD|Rh（D）|血型/i, 'ABO+RhD 血型', 'lab'],
  [/传染病四项|传染病.{0,6}(检测|筛查)|乙肝.{0,6}丙肝|术前四项|酶免法/i, '传染病四项', 'lab'],
  [/甲肝|甲型|HAV/i, '甲肝 IgM', 'lab'],
  [/戊型|戊肝|HEV/i, '戊肝抗体', 'lab'],
  [/呼吸道病原|上呼吸道|呼吸道.{0,4}核酸|鼻病毒|腺病毒|支原体|mNGS|病原.{0,4}宏基因组/i, '呼吸道病原', 'lab'],
  [/心电图|ECG|EKG/i, '心电图', 'imaging'],
  [/心衰|NT.{0,3}proBNP|钠尿肽|BNP|感染标志物|PCT|IL-?6|降钙素原|脓毒症/i, '心衰+感染标志物', 'lab'],
]

// 影像：模态-部位（与库里命名一致，如「磁共振-头颈」「CT-胸部」「超声-心脏」）
const MODALITY = [
  [/磁共振|MRI|MR(?!\w)/i, '磁共振'],
  [/CT/i, 'CT'],
  [/彩色多普勒|多普勒|超声|彩超|B超/i, '超声'],
  [/X线|X-Ray|DR|放射/i, '放射'],
]
const PART = [
  [/头颈|颈部|颅脑|头颅|脑/i, '头颈'],
  [/胸部|肺|胸腔/i, '胸部'],
  [/腹部|肝胆胰脾|上腹|下腹/i, '腹部'],
  [/妇科|子宫|附件|盆腔/i, '妇科'],
  [/血管|静脉|动脉/i, '血管'],
  [/心脏|心动图/i, '心脏'],
  [/床旁|床边/i, '床旁'],
]

function imagingType(title, text = '') {
  // 模态只在**标题**里找：正文里出现「CT」不等于这是一份 CT 报告（实测：心衰标志物报告的
  // 抬头里有 CT 字样，被误判成 CT 报告）。标题没有模态就不猜。
  const mod = MODALITY.find(([re]) => re.test(title))
  if (!mod) return null
  const hay = `${title} ${String(text || '').slice(0, 80)}`
  // 部位优先从标题取；标题没有就从前 120 字找
  const part = PART.find(([re]) => re.test(title)) || PART.find(([re]) => re.test(hay))
  let name = part ? `${mod[1]}-${part[1]}` : `${mod[1]}-常规`
  // 库里对增强扫描有专门的命名（CT-血管增强），保留「增强」这一层区分
  if (/增强/.test(title) && /血管/.test(name)) name = `${mod[1]}-血管增强`
  return { reportType: name, kind: 'imaging', evidence: 'title:影像' }
}

/**
 * 判定报告类型：**标题优先**，标题判不出才用正文兜底（兜底也只在前 6 行找，不扫全文）。
 * @returns {{reportType:string, kind:string, evidence:string} | null}
 */
export function classifyByTitle(text = '') {
  const title = detectTitle(text)
  const scope = title || String(text || '').split(/\r?\n/).slice(0, 6).join(' ')
  if (!scope) return null
  for (const [re, reportType, kind] of TYPE_RULES) {
    if (re.test(scope)) return { reportType, kind, evidence: title ? 'title' : 'head6' }
  }
  const img = imagingType(scope, text)
  if (img) return img
  return null
}

// ---------------- 按「项目集」反推类型（照 MedData inferReportType 的第 2 步：项集签名打分） ----------------
// MedData 用 catalog 里每个类型的 signature（该类型应有哪些项）给项集打分；
// 这里不搬它的词表，而是用**本库历史报告**：每个 reportType 见过哪些项目名 → 用 Jaccard 相似度反向匹配。
// 适用场景：手机截屏类化验单，抬头全是 App 界面文字，标题行根本不存在，但指标行是齐的。

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()

export function buildTypeRowIndex(reports = []) {
  const byType = new Map()
  for (const r of reports || []) {
    const type = String(r?.reportType || '').trim()
    if (!type) continue
    const rows = Array.isArray(r?.rows) ? r.rows : []
    if (!rows.length) continue
    if (!byType.has(type)) byType.set(type, new Map())
    const m = byType.get(type)
    for (const row of rows) {
      const n = norm(row?.name || row?.originalName)
      if (n.length < 2) continue
      m.set(n, (m.get(n) || 0) + 1)
    }
  }
  return byType
}

/**
 * @param {Array} rows 待判定的指标行
 * @param {Map} index buildTypeRowIndex() 的结果
 * @returns {{reportType:string, kind:string, evidence:string, score:number} | null}
 */
export function classifyByRows(rows = [], index, { minOverlap = 3, minScore = 0.5 } = {}) {
  if (!index?.size) return null
  const mine = new Set((Array.isArray(rows) ? rows : []).map((r) => norm(r?.name || r?.originalName)).filter((n) => n.length >= 2))
  if (mine.size < minOverlap) return null
  let best = null
  for (const [type, m] of index) {
    const theirs = new Set(m.keys())
    if (!theirs.size) continue
    let inter = 0
    for (const n of mine) if (theirs.has(n)) inter += 1
    if (inter < minOverlap) continue
    const union = mine.size + theirs.size - inter
    const jaccard = inter / union
    const coverage = inter / Math.min(mine.size, theirs.size)
    const score = Math.max(jaccard, coverage * 0.9)
    if (score < minScore) continue
    if (!best || score > best.score) best = { reportType: type, kind: 'lab', evidence: 'rows', score }
  }
  return best
}
