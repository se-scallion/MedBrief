// ===================== 报告行「模态 + 部位」统一口径（纯函数，零依赖）=====================
// 问题（用户 2026-10-27 报障）：
//   · CT 行：Tag 只有「CT」，部位却挤在标题位（腹部〈上腹+下腹) +盆腔）；
//   · 超声行：Tag 是「下肢彩超」（部位混进类型名），标题位是「彩色多普勒超声检查报告单」这句废话。
//   同一个列表里两种排法，读起来不一致，也很难扫。
//
// 统一口径：**Tag = 部位 + 模态**（如「胸部CT」「下肢超声」「心电图」），
//           标题位只放**有信息量的**标题；模板抬头（…检查报告单 / …报告）不再占位。
// 归一路径（都不改存储值，只做展示）：
//   1) 模态：优先按 kind 映射（ct→CT / ultrasound→超声 / ecg→心电图…），doc_type 只作兜底；
//   2) 部位：依次尝试 part → doc_type → title，剥掉模态词与模板尾缀后取「部位短语」
//      （保留「腹部〈上腹+下腹)+盆腔」这类多部位写法，不硬拆成单个器官）；
//   3) 标题：命中模板 / 与 Tag 冗余 → 不显示（行内已有结论摘要可读）。

// kind → 模态短名（标签里用的就是它）
const MODALITY_BY_KIND = {
  ecg: '心电图',
  ultrasound: '超声',
  ct: 'CT',
  mri: '磁共振',
  xray: 'X线',
  endoscopy: '内镜',
  pathology: '病理',
  nuclear: '核医学',
  genetic: '基因检测',
  flow: '流式免疫分型',
  bonemarrow: '骨髓形态',
  other: '其他',
}

// 模态词（从部位串里剥掉）：长词在前，避免「超声心动图」被「超声」先剥成「心动图」
const MODALITY_TOKENS = [
  '彩色多普勒超声心动图', '彩色多普勒超声', '彩色多普勒', '经阴道超声', '经直肠超声',
  '超声心动图', '彩超', '超声', '多普勒',
  '计算机断层扫描', 'CT平扫', 'CT增强', 'CT', 'MRI平扫', 'MRI', '磁共振', '核磁共振',
  'X线摄影', 'X-Ray', 'X线', 'X光', '数字摄影', 'DR',
  '心电图', '心电', '内镜', '胃镜', '肠镜', '支气管镜',
  '基因检测', '染色体核型', '核型分析', '荧光原位杂交', 'FISH', '二代测序', 'NGS',
  '流式细胞术', '流式', '免疫分型', '免疫表型',
  '骨髓细胞形态学', '骨髓形态', '骨穿', '涂片分类',
]

// 模板尾缀 / 抬头词（判定「标题是不是废话」时剥掉）
const TEMPLATE_TAIL = /(检查)?(结果)?(报告单|报告书|报告)$/g
const TEMPLATE_FILLER = /检查|结果|临床|本院|科室|联合实验室/g
// 医院名（标题里最常见、但完全没有信息量的成分）
const HOSPITAL_RE = /(首都医科大学附属)?[\u4e00-\u9fa5]{0,12}(医院|院区|医学中心|保健院|卫生院|门诊部)/g

// 部位词表：命中即认为是部位短语（只用于"这句话里有没有部位"，不重写部位写法）
const PART_WORDS = [
  '上腹部', '下腹部', '腹部', '盆腔', '胸部', '颅脑', '头部', '颈部血管', '颈部', '下肢', '上肢',
  '心脏', '心动图', '浅表器官', '浅表', '生殖系统', '泌尿系统', '消化系统',
  '甲状腺', '乳腺', '肝脏', '胆囊', '脾脏', '胰腺', '肾脏', '膀胱', '前列腺', '子宫', '附件',
  '淋巴结', '关节', '腰椎', '颈椎', '脊柱', '骨髓', '纵隔', '双侧', '全身',
]

const clean = (s) => String(s || '').replace(/\s+/g, '')
// 展示用：把连续空白折成一个空格（clean 是**判定用**的，删光空格会把英文/编号标题粘成
// 「AI重读e2e用例」这种——2026-10-28 修复，见 verify-doc-heading 的空格用例）
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const stripToken = (s) => {
  let out = clean(s)
  for (const t of MODALITY_TOKENS) out = out.split(t).join('')
  return out.replace(TEMPLATE_TAIL, '').replace(/^[·・,，、:：\-—_/]+|[·・,，、:：\-—_/]+$/g, '')
}

// doc_type 兜底时只认模态词（避免把「下肢彩超」的「下肢」当模态）
const MODALITY_ALIASES = [
  [/超声|彩超|多普勒|心动图/, '超声'],
  [/CT|计算机断层/i, 'CT'],
  [/MRI|磁共振|核磁/i, '磁共振'],
  [/X-?ray|X线|X光|(^|[^A-Za-z])DR(?![A-Za-z])|数字摄影/i, 'X线'],
  [/心电/, '心电图'],
  [/内镜|胃镜|肠镜|支气管镜/, '内镜'],
  [/病理|活检/, '病理'],
  [/核医学|PET-?CT|SPECT|骨扫描/i, '核医学'],
  [/基因检测|染色体|核型|FISH|突变/i, '基因检测'],
  [/流式|免疫分型|免疫表型/, '流式免疫分型'],
  [/骨髓|骨穿|涂片/, '骨髓形态'],
]

/** 这份报告的模态短名（标签用）：kind 优先，doc_type 只兜底认模态词 */
export function modalityOf(doc) {
  if (!doc) return ''
  const byKind = MODALITY_BY_KIND[doc.kind]
  if (byKind) return byKind
  const dt = clean(doc.doc_type)
  const hit = MODALITY_ALIASES.find(([re]) => re.test(dt))
  return hit ? hit[1] : ''
}

/** 标题是不是模板废话（…检查报告单 / …报告 / 只剩医院名） */
export function isTemplateTitle(title) {
  const core = clean(title)
  if (!core) return true
  const noHosp = core.replace(HOSPITAL_RE, '')
  let stripped = stripToken(noHosp).replace(TEMPLATE_FILLER, '')
  // 抬头常重复两遍（「彩色多普勒超声检查报告单 彩色多普勒超声检查报告单」）→ 循环剥到不变
  for (let i = 0; i < 3; i++) {
    const next = stripToken(stripped).replace(TEMPLATE_FILLER, '')
    if (next === stripped) break
    stripped = next
  }
  if (stripped.length === 0) return true
  // 只剩 1-2 个字的残渣（如「通知」「说明」）也算模板
  return stripped.length <= 2 && !PART_WORDS.some((w) => stripped.includes(w))
}

// 报告/结论类字样：出现即说明这段是"标题/结论"而不是部位
const NOT_PART_RE = /检测|检验|实验|结果|结论|诊断|建议|随访|报告|分析|评估|阴性|阳性/

/**
 * 从一段文本里抽部位短语（保留多部位写法，如「腹部〈上腹+下腹)+盆腔」）。
 * @param {string} text
 * @param {{trusted?:boolean}} opts trusted=true 表示来自结构化 part 字段（可较长、可多部位）；
 *        doc_type / title 只接受**短部位短语**，防止把整条标题当部位（如「…-骨髓A4」）。
 */
export function partFrom(text, opts = {}) {
  const raw = String(text || '')
  if (!raw || isTemplateTitle(raw)) return ''
  const stripped = stripToken(raw)
  if (!stripped) return ''
  if (!PART_WORDS.some((w) => stripped.includes(w))) return ''
  if (!opts.trusted) {
    if (stripped.length > 8) return ''
    if (NOT_PART_RE.test(stripped)) return ''
  }
  return stripped
}

/** 部位：part → doc_type → title 依次尝试 */
export function partOf(doc) {
  if (!doc) return ''
  const p0 = partFrom(doc.part, { trusted: true })
  if (p0) return p0
  for (const cand of [doc.doc_type, doc.title]) {
    const p = partFrom(cand)
    if (p) return p
  }
  // 「超声心动图」这类：模态词里就带部位
  if (/心动图/.test(clean(doc.doc_type)) || /心动图/.test(clean(doc.title))) return '心脏'
  return ''
}

/** 标题与 Tag 是否冗余（标题只是部位+模态的组合，如「胸部 CT 平扫」） */
function isRedundantTitle(title, part, modality) {
  const t = stripToken(title)
  if (!t) return true
  const joined = clean(part + modality)
  return t === joined || (part && t === clean(part)) || t === clean(modality)
}

/**
 * 报告行的统一展示口径（2026-10-27 定稿，A/B 两案比较后选 B）。
 * **Tag = 模态**（CT / 超声 / 心电图…，值域收敛、与筛选条一一对应）；
 * **正文首位 = 部位**（胸部 / 腹部〈上腹+下腹)+盆腔 / 下肢…）；无部位时退回有信息量的标题；
 * 模板抬头（…检查报告单 / 只剩医院名）与和 Tag 冗余的标题一律不占位。
 * 为什么不让部位进 Tag：Tag 是"分类"，正文是"具体"。部位进 Tag 会让标签值域发散（实测 3–14 字、
 * 8 种以上写法）、与筛选维度错位，且与检验 tab（Tag=报告类型）不同构。比较过程见 docs/ 讨论与
 * .agents/architecture.md「报告行标题统一」。
 * @param {object} doc 归档报告（kind / doc_type / part / title）
 * @returns {{tag:string, modality:string, part:string, main:string}} main 为空串表示这行没有正文标题
 */
export function docHeading(doc) {
  const modality = modalityOf(doc)
  const part = partOf(doc)
  const title = String((doc && doc.title) || '')
  const informativeTitle = isTemplateTitle(title) || isRedundantTitle(title, part, modality) ? '' : tidy(title)
  // Tag 只放模态；模态都判不出时退回 doc_type（保证标签不为空）
  const tag = modality || clean(doc && doc.doc_type) || '其他'
  // 正文：部位优先（最具体），其次有信息量的标题
  const main = part || informativeTitle
  return { tag, modality, part, main }
}
