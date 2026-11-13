// ===================== 报告大类检测：检验报告（化验单） vs 检查报告（影像 / 心电等） =====================
// 用于「添加数据」统一入口的分流：判为检验报告走化验导入（OCR 表格 → 指标入库），
// 判为检查报告走检查报告导入（提取全文 → 所见/结论/测量值索引 + 原件归档）。
//
// 设计约束：
//  1) 零依赖（不引 pdfjs / ocr.js / React），Node 与浏览器都能直接跑，便于 scripts/verify-report-kind.mjs 单测；
//  2) 纯分类，不参与既有识别策略选优与归一化，不改变任何 OCR 质量相关行为；
//  3) 输入容错：text 可来自 PDF 文字层、OCR 整页文本或 OCR 网格拼成的文本（OCR 常在汉字间插空格，
//     故同时基于「去空白文本」匹配）；特征不足时返回 unknown，由调用方按所在页面默认值处理。

// ---------- 检查报告特征 ----------

// 影像 / 心电模态词（强信号：命中即高度指向检查报告）
const DOC_MODALITY = [
  { re: /心电图|心电力|心电检查/, label: '心电图' },
  { re: /超声|彩超|彩色多普勒|多普勒/, label: '超声' },
  // 裸 CT 需排除前后紧跟字母的情况：否则「HCT（红细胞压积）」会被误判为 CT 检查
  { re: /(^|[^A-Za-z])CT(?![A-Za-z])|计算机断层|断层扫描/, label: 'CT' },
  { re: /磁共振|MRI/i, label: '磁共振' },
  // 裸 DR 需排除「HLA-DR / CD45-DR」这类抗原名（前面是连字符）：否则流式报告抗原列表会被判成 X 线摄影。
  { re: /X线|X-Ray|X光|数字摄影|(^|[^A-Za-z\-–—/])DR(?![A-Za-z])/, label: 'X线' },
  { re: /内镜|胃镜|肠镜|支气管镜|膀胱镜/, label: '内镜' },
  { re: /PET-?CT|SPECT|骨扫描|核医学/, label: '核医学' },
]

// ---------- 分子 / 细胞遗传学（检验科出具，图文报告）----------
// 用户口径（2026-10-27）：染色体核型、基因突变/重排/表达、FISH 这几类**是检验报告**，
// 由检验科分子室 / 细胞遗传室出具；只是结果不是「项目-数值」表格，而是图文报告（核型串 + 分析结论）。
// 故：通道仍走归档（存原件 + 结论），但**类型标 lab、载体标 narrative**。
// 为什么不能只改类型就送进化验网格：实测（scripts/verify-chromosome-kind.mjs）核型报告走网格通道
// 会出 grid 22 行噪声 + P=2 / Ca=24 / PLT=20 三项无中生有指标。
// 也正因此它们不再属于 DOC_MODALITY（那不是"影像模态词"，而是检验科的报告体裁）。
const MOLECULAR_KIND = [
  { re: /染色体核型|核型分析|染色体检查|细胞遗传学/, label: '染色体核型' },
  {
    // 注意：**不含「融合基因 / BCR-ABL」**——融合基因定量是「项目-数值」表格型检验报告，
    // 走化验网格出百分比指标（见下方 lab 分支与 verify-fusion-report.mjs），不能拉进图文归档。
    re: /基因检测|基因测序|基因芯片|染色体|拷贝数变异|NGS|二代测序|高通量测序|FISH检测|基因变异|突变检测|基因重排|基因表达/i,
    label: '分子检测',
  },
]

// 检查报告的段落结构（所见 / 结论）
const DOC_SECTION = [
  '检查所见', '超声描述', '超声所见', '声像图表现', '影像所见', '影像学表现',
  '扫描所见', '检查描述', '心电图描述',
  '影像诊断', '影像学诊断', '诊断意见', '超声提示', '检查结论', '心电图提示',
]

// 检查报告的元信息字段
const DOC_FIELD = [
  '检查部位', '检查方法', '影像号', '超声号', '检查号', '申请科室',
  '报告医师', '报告医生', '审核医师', '审核医生', '检查技师', '检查设备',
]

// ---------- 检验报告特征 ----------

const LAB_TITLE = [
  '检验报告单', '检验报告', '化验单', '临床检验', '检验结果报告', '检验结果',
  '生化检验', '免疫检验', '微生物检验',
]

const LAB_HEADER = {
  name: /项目|名称|指标|检验项目|检测项目|化验项目/,
  result: /结果|测定值|检测值|数值|检验结果/,
  ref: /参考范围|参考区间|参考值|正常范围|正常参考|生物参考/,
  unit: /单位/,
}

// 文件名弱信号（仅作平局/弱特征时的倾斜，不足以单独定性）
const NAME_DOC = /超声|彩超|CT|MRI|磁共振|X线|DR|心电|内镜|胃镜|肠镜/i
const NAME_LAB = /化验|血常规|生化|凝血|尿常规|甲功|肝功|肾功|检验/i

const clampText = (s) => String(s || '').slice(0, 20000)

// OCR 常在汉字之间插入空格（如「影 像 所 见」），去掉全部空白后再匹配段落/字段词
function compact(text) {
  return String(text || '').replace(/\s+/g, '')
}

// 骨髓标题的 OCR 形近字变体归一：tesseract 对这类字体常把「骨髓」误识为「骨通/骨随/骨骨」
// （与 ImportFlow 的 TITLE_OCR_FIX 同口径）。在判定入口统一纠正，否则预检分流
// （App 拿 ocrImageToText 原文直接判）会因标题认不出而把骨髓图文报告送进化验页。
function fixOcrVariants(text) {
  return String(text || '').replace(/骨通|骨随|骨骨/g, '骨髓')
}

function countHits(text, words) {
  let n = 0
  for (const w of words) if (text.includes(w)) n += 1
  return n
}

function matchModality(text) {
  for (const { re, label } of DOC_MODALITY) {
    if (re.test(text)) return label
  }
  return ''
}

// 已映射指标数 → 分值：检验单识别后会有成规模的标准指标，影像报告通常只有零星测量值
function scorePoints(points) {
  const n = (points || []).filter((p) => p && p.standard_code).length
  if (n >= 5) return { score: 3, mapped: n }
  if (n >= 3) return { score: 2, mapped: n }
  if (n >= 1) return { score: 1, mapped: n }
  return { score: 0, mapped: 0 }
}

/**
 * 判定报告大类。
 * @param {object} input
 * @param {string} [input.fileName] 文件名（弱信号）
 * @param {string} [input.mime]     MIME（当前仅作留档，不参与打分）
 * @param {string} [input.text]     PDF 文字层 / OCR 整页文本 / OCR 网格拼文本
 * @param {Array}  [input.points]   已归一化并映射的指标（带 standard_code）
 * @returns {{kind:'lab'|'doc'|'case'|'unknown', confidence:'high'|'medium'|'low', reason:string}}
 */
export function detectReportKind({ fileName = '', mime = '', text = '', points = [] } = {}) {
  const raw = clampText(text)
  const flat = compact(fixOcrVariants(raw))

  // ---- 检查报告打分 ----
  let docScore = 0
  const docHits = []

  const modality = matchModality(flat) || matchModality(raw)
  if (modality) {
    docScore += 3
    docHits.push(`影像模态词：${modality}`)
  }

  const sectionHits = countHits(flat, DOC_SECTION)
  if (sectionHits >= 2) {
    docScore += 3
    docHits.push('检查段落结构（所见 / 结论）')
  } else if (sectionHits === 1) {
    docScore += 2
    docHits.push('检查段落结构（所见 / 结论）')
  }

  const fieldHits = Math.min(2, countHits(flat, DOC_FIELD))
  if (fieldHits > 0) {
    docScore += fieldHits
    docHits.push('检查报告字段')
  }

  // ---- 检验报告打分 ----
  let labScore = 0
  const labHits = []

  const title = LAB_TITLE.find((t) => flat.includes(compact(t)))
  if (title) {
    labScore += 3
    labHits.push(`检验标题词：${title}`)
  }

  const hasName = LAB_HEADER.name.test(flat)
  const hasResult = LAB_HEADER.result.test(flat)
  if (hasName && hasResult) {
    labScore += 3
    labHits.push('表头：项目 + 结果')
  } else if (hasName || hasResult) {
    labScore += 1
    labHits.push('表头：项目或结果')
  }
  if (LAB_HEADER.ref.test(flat)) {
    labScore += 1
    labHits.push('表头：参考范围')
  }
  if (LAB_HEADER.unit.test(flat)) {
    labScore += 1
    labHits.push('表头：单位')
  }

  const { score: ptScore, mapped } = scorePoints(points)
  if (ptScore > 0) {
    labScore += ptScore
    labHits.push(`已映射指标 ${mapped} 项`)
  }

  // 流式专属词 / 病理专属词：两者都是「这份报告是什么模态」的硬信号，先算好供下面复用。
  // 流式报告结论是模板句，常写「请结合融合基因、染色体、骨髓细胞形态学…」，
  // 若不在最后独占定性，这些引用词（基因/核型分支）会把一份检验报告改判成检查报告。
  const PATHOLOGY_RE = /活检|病理|免疫组化|镜下所见|综合诊断/
  const FLOW_RE = /流式细胞|免疫表型|免疫分型|所检测抗原|CD45\/SSC|设门/i
  const isPathologyReport = PATHOLOGY_RE.test(flat)
  const isFlowReport = FLOW_RE.test(flat) && !isPathologyReport

  // 流式免疫分型（FCM-MRD）→ **检验报告（lab）**。
  // 业务归属（2026-10-21 用户拍板）：这份报告同样由检验科出具、抬头就是「临床检验结果报告单」，
  // 属检验项目；识别能力在化验通道补齐——该报告没有指标表格，只有「印象/结论」里的一句 MRD 百分比
  // （异常细胞群体约占有核细胞的 X%），故化验 AI 通道为它单列 C 类口径：只转录一行「流式MRD残留」。
  // 判据：流式专属词（所检测抗原 / CD45-SSC 设门 / 免疫表型），且不是病理/活检。
  if (isFlowReport) {
    labScore += 4
    labHits.push('流式免疫分型（FCM-MRD）：检验科流式细胞术报告')
  }

  // 骨髓形态学（涂片分类）→ **检验报告（lab）**。
  // 业务归属先于识别能力（2026-10-21 用户拍板）：这份报告由检验科血液细胞室出具，
  // 主体是「细胞名称 | 血片% | 参考范围 | 骨髓片%」分类计数表，属临床血液学检验项目，
  // 因此走化验通道录入；识别能力（双列结构、26 个标准名）在化验侧补齐——字典已有
  // BONE_MARROW_MORPHOLOGY 26 项、AI 化验通道有骨髓感知长格式口径（见 buildDocReadLabPrompt）。
  // 判定要件：① 有骨髓/骨穿/髓片字样；② 有双列分类表特征（骨髓片/血片/粒红比/巨核细胞/分类计数）；
  // ③ 不是影像/流式模态报告（流式结论常引用「请结合骨髓细胞形态学」这类字样，不能据此改判）；
  // ④ 不是活检/病理（骨髓活检属病理检查报告，见下方病理分支）。
  const MARROW_WORD = /骨髓|骨穿|髓片|细胞形态学|涂片分类/
  const MARROW_TABLE = /骨髓片|血片|粒红比|M:E|巨核细胞|分类计数|细胞分类|涂片分类|NAP积分/
  if (MARROW_WORD.test(flat) && MARROW_TABLE.test(flat) && !modality && !isFlowReport && !isPathologyReport) {
    labScore += 4
    labHits.push('骨髓形态学（涂片分类）：检验科细胞学检验报告')
  }

  // 病理 / 活检报告（骨髓活检、淋巴结活检、组织病理）：主体是「镜下所见 / 免疫组化 /
  // 综合诊断」图文描述，可入库数值指标为 0，同样必须走检查报告归档（存原件 + 所见/结论），
  // 否则会被化验网格通道收成乱码级假指标（实测该图网格通道出了 NEUT_ABS/MCV/MONO_PCT 等
  // 7 项无中生有的指标）。
  // 关键词取病理专属词；其中「镜下所见 / 综合诊断」是化验网格通道（ocrFullText 由表格 items
  // 拼成、标题常被读丢）里仍能存活的信号——2026-09-12 实测该图网格通道丢失「骨髓/巨核细胞」，
  // 只剩「镜下所见」「综合诊断」可依。化验单页眉的「病理号」不含下述任一短语，不会误触。
  if (/活检|病理报告|病理诊断|病理学检查|组织病理|免疫组化|镜下所见|综合诊断/.test(flat)) {
    docHits.push('病理 / 活检报告')
    if (labScore > 0) docScore = Math.max(docScore, labScore + 2)
    else docScore += 3
  }

  // 分子 / 细胞遗传学（染色体核型、基因突变/重排/表达、FISH）：**类型是检验**（检验科出具），
  // 但主体是「核型描述 / 突变结论」图文，可入库数值指标为 0 —— 若送进化验网格只会把核型串、
  // 页眉与核型图碎片收成假指标（实测 265141：grid 22 行全噪声，POINTS 出 P=2 / Ca=24 / PLT=20），
  // 且表头「检验项目 / 结果 / 参考范围 / 单位」让 lab 分（7）压过 doc 分（4）→ 被送进化验页。
  // 故：通道强制归档（doc），但类型标 lab、载体标 narrative（见文件底部 type/form 口径）。
  const molecular = MOLECULAR_KIND.find((m) => m.re.test(flat))
  if (molecular) {
    docHits.push(`${molecular.label}（检验科图文报告）`)
    if (labScore > 0) docScore = Math.max(docScore, labScore + 2)
    else docScore += 3
  }

  // 病历文书：出院记录 / 诊断证明（出院小结等同出院记录）。正文常罗列大量检验指标与参考范围、
  // 单位，会被上方 lab 分支误判为化验单并送进化验数据页；同时它也不是影像/心电等检查报告（doc）。
  // 故在此强制归入第三类「病历文书（case）」——独立顶级模块，与检验 / 检查报告并列。
  // 关键词为极特异短语，不会与影像 / 检验报告中的「诊断结论」「出院后复查」等混淆。
  // 命中即短路返回 case（最高优先级，覆盖 lab / doc）。
  if (/出院记录|出院小结|诊断证明书|病情证明书|诊断证明|病情证明/.test(flat)) {
    return {
      kind: 'case',
      type: 'case',
      form: 'narrative',
      confidence: 'high',
      reason: `病历文书（出院记录 / 诊断证明）→ case（doc ${docScore} / lab ${labScore}）`,
    }
  }

  // ---- 文件名信号 ----
  // 文件名命中影像模态词属中等信号（无正文时仍可定性，但置信度标 low）；
  // 其它关键词仅作弱倾斜，不足以单独定性。
  const name = String(fileName || '')
  const nameModality = matchModality(name)
  if (nameModality) {
    docScore += 2
    docHits.push(`文件名模态词：${nameModality}`)
  } else if (NAME_DOC.test(name)) {
    docScore += 1
    docHits.push('文件名含检查类关键词')
  } else if (NAME_LAB.test(name)) {
    labScore += 1
    labHits.push('文件名含检验类关键词')
  }

  const diff = docScore - labScore
  const reasons = [...docHits.map((h) => `doc:${h}`), ...labHits.map((h) => `lab:${h}`)]
  void mime // 保留参数位，当前判定不依赖 MIME

  // ---- 定性 ----
  // 双方都无特征 → 无法判定，交由调用方按所在页面默认值处理
  if (docScore === 0 && labScore === 0) {
    return { kind: 'unknown', type: 'unknown', form: '', confidence: 'low', reason: '未检出报告特征' }
  }

  let kind = 'unknown'
  if (diff >= 2 && docScore >= 3) kind = 'doc'
  else if (diff <= -2 && labScore >= 3) kind = 'lab'
  // 只有一方有强信号且对方无信号时，允许在小分差下定性（如「心电图」标题 + 少量通用词）
  else if (diff >= 1 && (modality || nameModality) && labScore === 0) kind = 'doc'
  else if (diff <= -1 && title && docScore === 0) kind = 'lab'
  // 流式独占定性：报告模态是流式细胞术，业务上就是检验项目（用户 2026-10-21 拍板）。
  // 结论模板句引用的「融合基因 / 染色体 / 骨髓细胞形态学」等其他检查名，不得把它改判成检查报告。
  if (isFlowReport) {
    return {
      kind: 'lab',
      type: 'lab',
      form: 'tabular',
      confidence: 'high',
      reason: `流式免疫分型（检验科流式细胞术报告，doc ${docScore} / lab ${labScore}）`,
    }
  }

  // 模态词独占定性：影像 / 心电的模态词命中，说明这份报告的正文结构就是模态描述，
  // 同页的通用「临床检验」标题词与零散表头词不足以把整份报告改判成化验单。
  // （真实场景：流式报告抬头就是「北京市医疗机构临床检验结果报告单」，结论还引用
  //  「请结合骨髓细胞形态学」，lab 分数会反超而误判成 unknown/lab。）
  else if (modality && docScore >= 3 && labScore <= docScore + 1) kind = 'doc'

  let confidence = 'low'
  const gap = Math.abs(diff)
  if (gap >= 4) confidence = 'high'
  else if (gap >= 2) confidence = 'medium'

  // ---- type / form（2026-10-27 定稿口径）----
  // kind  = **走哪条通道**：lab（化验网格，出数值指标）/ doc（归档原件 + 所见结论）/ case（病历文书）
  // type  = **这条报告是什么**：lab 检验 / exam 检查 / pathology 病理 / case 病历文书
  // form  = **载体**：tabular（项目-数值表格）/ narrative（图文报告）
  // 关键：type 由学科与结果本质决定，**不由报告体裁决定**——骨髓形态学、流式、融合基因、核型/突变
  // 都是检验（type='lab'），其中核型/突变是图文载体，所以仍走归档通道（kind='doc'）。
  // 这层拆开后，"检验报告躺在检查 tab"这种误归才有地方修（见 docKinds.categoryOfKind）。
  const typeOfKind = () => {
    if (kind === 'lab') return 'lab'
    if (isPathologyReport) return 'pathology'
    if (molecular) return 'lab' // 分子/细胞遗传学：检验，图文载体
    return 'exam'
  }
  const formOfKind = () => (kind === 'lab' ? 'tabular' : 'narrative')

  if (kind === 'unknown') {
    const t = molecular ? 'lab' : 'unknown'
    return {
      kind,
      type: t,
      form: molecular ? 'narrative' : '',
      confidence: 'low',
      reason: `特征不足（doc ${docScore} / lab ${labScore}）：${reasons.join('，') || '无'}`,
    }
  }

  const side = kind === 'doc' ? docHits : labHits
  return {
    kind,
    type: typeOfKind(),
    form: formOfKind(),
    confidence,
    reason: `${side.join('，') || '特征'}（doc ${docScore} / lab ${labScore}）`,
  }
}

// OCR 网格（二维数组）→ 单行文本：与 ImportFlow 内 inferReportType 的取文口径保持一致
export function textFromGrid(grid) {
  if (!Array.isArray(grid)) return ''
  return grid.flat().map((c) => String(c == null ? '' : c)).join(' ')
}
