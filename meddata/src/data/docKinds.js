// ===================== 检查报告类别（kind）单一事实源 =====================
// 三处共用，禁止各写一份：
//   ① 前端导入/详情表单的类别下拉（DocImportFlow / CaseImportFlow / DocDetail）
//   ② AI 精读 prompt 的类别枚举（scripts/agent-task.mjs::buildDocUnderstandPrompt）——
//      AI 要在同一份枚举里挑 kind，靠 hint 判类，避免各写一套标签导致 AI 回填的 kind 落不进下拉
//   ③ 病历文书（category='case'）与检查报告（category='exam'）的分流：CASE_KINDS
//
// hint 面向 AI/规则层判类，不展示给用户；label 是界面文案。

export const DOC_KINDS = [
  { value: 'ecg', label: '心电图', hint: '心电图 / 心电报告 / ECG，含心率、PR/QRS/QTc 间期、各波形态描述' },
  { value: 'ultrasound', label: '超声', hint: '超声 / 彩超 / 多普勒，含「超声描述」「超声提示」；部位如腹部/心脏/血管/甲状腺' },
  { value: 'ct', label: 'CT', hint: 'CT / 计算机断层，含「影像所见」「影像诊断」' },
  { value: 'mri', label: '磁共振', hint: 'MRI / 磁共振 / 核磁共振，含「影像所见」「影像诊断」' },
  { value: 'xray', label: 'X线/DR', hint: 'X 线 / DR / 胸片 / 平片' },
  { value: 'endoscopy', label: '内镜', hint: '胃镜 / 肠镜 / 支气管镜 / 内镜，含「镜下所见」「活检部位」' },
  { value: 'genetic', label: '基因检测', hint: '基因 / 染色体核型 / 融合基因 / 突变检测（如 ISCN 核型串、BCR-ABL 定量）' },
  { value: 'flow', label: '流式免疫分型', hint: '流式细胞术 / 免疫分型 / MRD，含各系细胞百分比、CD 分子标记' },
  {
    value: 'bonemarrow',
    label: '骨髓形态',
    hint: '骨髓细胞形态检查 / 骨髓象 / 骨髓涂片 / 骨穿，含「骨髓片」「血片」双列细胞分类、粒红比、M/E',
  },
  { value: 'pathology', label: '病理活检', hint: '病理 / 活检 / 免疫组化，含「病理诊断」「镜下描述」' },
  {
    value: 'discharge',
    label: '出院记录',
    // 口径（2026-10-20，与 parseDoc.detectDocType 对齐）：**叙述式**出院记录 / 出院小结——
    // 有「入院情况 / 诊疗经过 / 出院情况」这类章节。表单版「出院诊断证明书」不归这里（见 cert）。
    hint: '标题为「出院记录 / 出院小结」（category=case）的**叙述式**文书：含入院情况、诊疗经过、出院情况、出院医嘱。判类看标题，不看正文里出现的「出院日期/出院医嘱」等词',
  },
  {
    value: 'cert',
    label: '诊断证明',
    // 表单版文书：标签 + 值（主要诊断 / 其他诊断 / 入院日期 / 出院日期 / 出院医嘱 / 出院类别）。
    // 「出院诊断证明书」正文常写「出院医嘱：详见出院记录」，但它不是叙述式出院记录——归 cert。
    hint: '诊断证明书 / 出院诊断证明书 / 病情证明（category=case）：表单版式，含「主要诊断」「其他诊断」「出院日期」「出院类别」；标题带「诊断证明书 / 病情证明」一律归这里',
  },
  { value: 'other', label: '其他', hint: '以上都不匹配时的兜底' },
]

export const KIND_LABELS = Object.fromEntries(DOC_KINDS.map((k) => [k.value, k.label]))

// 病历文书类（归档时 category='case'，与检查报告 exam 分栏隔离；见 store.docCategory）
export const CASE_KINDS = ['discharge', 'cert']

// ---- 检验类（图文型）归档报告：**类型是检验，载体是图文原件**（用户口径 2026-10-27）----
// 骨髓形态学 / 流式免疫分型 / 基因（分子）这三类由检验科出具，属**检验报告**；
// 它们的结果不是「项目-数值」表格，而是图文报告（所见/结论 + 原件），因此才归档存原件。
// 判据是**报告类型**，不是「有没有图文」——不能让报告体裁反过来决定分类
// （这正是「检验报告躺在检查 tab」的根因，见 .agents/architecture.md 报告三轴口径）。
export const LAB_DOC_KINDS = ['bonemarrow', 'flow', 'genetic']

// 检验图文报告 kind → 明细分类 code（仅供**列表分类归类**使用：让归档的报告与化验记录
// 落在同一个分类里，如骨髓形态学两者都进「骨髓检查」）。
// 'genetic'（核型 / 突变 / 重排 / 表达）在化验侧没有对应指标类型，故映射到「基因检测」这个
// **可升级分类**（dictionary.MOLECULAR）：份数 ≥6 才单独占一格，少时自动并入「其他」。
export const LAB_KIND_REPORT_TYPE = {
  bonemarrow: 'BONE_MARROW_MORPHOLOGY',
  flow: 'FLOW_CYTOMETRY',
  genetic: 'MOLECULAR',
}

/** 归档大类：'lab' 检验（图文型） / 'exam' 检查 / 'case' 病历文书 */
export function categoryOfKind(kind) {
  if (CASE_KINDS.includes(kind)) return 'case'
  if (LAB_DOC_KINDS.includes(kind)) return 'lab'
  return 'exam'
}

// ---- 病历文书 doc_type 归一（2026-10-20，用户口径：「诊断证明」和「诊断证明书」是同一个意思）----
// 为什么必须归一而不是改 prompt：`doc_type` 参与归档查重键（date + doc_type + file_name），
// 规则层给「诊断证明」、AI 给「诊断证明书」，同一份原件两次导入就会漏判重复。
// 同义写法在本项目里必然反复出现（AI 自拟 / 用户手输 / 别家医院抬头），
// 所以按「效果」归一到两个规范值，而不是要求上游每个来源都把字打对。
const CERT_DOC_TYPE_RE = /诊断证明|病情证明/
const DISCHARGE_DOC_TYPE_RE = /出院记录|出院小结|出[院医辽联]记录/

// 规范化病历文书的 doc_type：命中同义词族 → 规范值（诊断证明 / 出院记录）；非病历文书原样返回。
// kind 优先（判类已定时以 kind 为准），kind 缺失时才看 doc_type 词。
export function normalizeCaseDocType(docType, kind) {
  const t = String(docType || '').trim()
  if (kind === 'cert') return '诊断证明'
  if (kind === 'discharge') return '出院记录'
  if (CERT_DOC_TYPE_RE.test(t)) return '诊断证明'
  if (DISCHARGE_DOC_TYPE_RE.test(t)) return '出院记录'
  return t
}

export const kindLabel = (kind) => KIND_LABELS[kind] || KIND_LABELS.other
