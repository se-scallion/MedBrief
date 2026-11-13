// ===================== 归档（检查报告 / 病历文书）查重 · 纯函数，零 DOM 依赖 =====================
// 两路通道，缺一不可：
//   通道 0 · 原件字节哈希（doc.file.sha256）：同一份文件 → 必然同一份报告。
//            与 date / doc_type / 文件名**全部无关**，因此不受「OCR 把 2026 读成 2006」「规则层判
//            '其他检查'、AI 判 '骨髓形态学（骨穿）'」这类读数抖动影响。
//   通道 1 · date + doc_type + 文件名：历史归档没有 sha256 时唯一可用的路（也覆盖「无原件手动录入」）。
//
// 为什么必须补通道 0（2026-10-25 实测漏判）：
//   骨穿报告二次导入，原件字节完全相同（sha256 一致），但本地识别轨把「采取日期 2026.10.10」
//   OCR 成 `采取碧丽2026.10.i0`（正则不认），全文唯一可解析日期变成末尾的 `2006.10.12`（2026→2006），
//   于是 date 与归档里的 2026-10-10 不等 → 三项全不等 → 静默放行重复归档。
//   只看三项的查重，等于把「OCR 随机性」写进了查重键。
//
// 为什么不能只有通道 0：
//   老归档（2026-10-25 之前入库）没有 sha256，只能靠三项；故两路并存，任一命中即判重。
//   历史归档的 sha256 由 store.js 的 backfillDocFileHash() 从原件 Blob 回填。

// 归档大类（'lab' 检验图文报告 / 'exam' 检查 / 'case' 病历文书）的单一事实源在 docKinds.js，
// 这里不再自己维护 kind 名单——名单写两份必然漂移（2026-10-27 分类改三档时就踩到这点）。
import { categoryOfKind } from '../data/docKinds.js'

// 文档大类惰性推导：病历文书（出院记录 / 诊断证明）→ 'case'；检验类图文报告（骨髓形态 / 流式 /
// 基因）→ 'lab'；其余检查报告 → 'exam'。老数据无 category 字段，按 kind 退化识别，无需破坏性迁移。
// ⚠ 口径单一事实源在 docKinds.categoryOfKind，这里不再自己列 kind 名单
// （2026-10-27：分类改成三档，若两处各写一份名单必然漂移）。
export function docCategoryOf(d) {
  if (!d) return 'exam'
  if (d.category) return d.category
  return categoryOfKind(d.kind)
}

// 候选侧的大类推断（仅在**候选对象本身**没带 category / kind 时兜底）：
// 归档侧靠 category/kind，而导入流以前只传 { date, doc_type, file_name } → 候选被推成 'exam'，
// 于是「category 隔离」把病历文书（category='case'）全部挡在门外，同日同类型的重复出院记录
// 实际上从来没被拦过（2026-10-25 跑单测才发现）。这里按 doc_type 词族兜底，与 docKinds.js
// 的同义词族同口径；同时导入流已改成显式传 kind，双保险。
const CASE_TYPE_RE = /出院记录|出院小结|出[院医辽联]记录|诊断证明|病情证明/
const LAB_TYPE_RE = /骨髓|骨穿|涂片分类|流式|免疫分型|免疫表型|基因|染色体|核型|FISH|突变/i
function candidateCategory(cand) {
  if (cand.category) return cand.category
  if (cand.kind) return docCategoryOf(cand)
  const t = String(cand.doc_type || '')
  if (CASE_TYPE_RE.test(t)) return 'case'
  if (LAB_TYPE_RE.test(t)) return 'lab'
  return 'exam'
}

// doc_type 的**比较键**规范化（只用于比较，绝不改存储值）：
// 全角→半角、去所有空白、大小写归一。同一份原件两次导入时，「骨髓形态学（骨穿）」与
// 「骨髓形态学 (骨穿)」不该被判成两种报告；而这类差异纯粹是输入法/AI 措辞的产物。
// 注意：这不是「同义词词表」——不把「腹部彩超」并成「超声」，那属于展示层口径（见 docKinds.js）。
export function normalizeDocTypeKey(docType) {
  return String(docType || '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角 ASCII → 半角
    .replace(/\u3000/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

// 查重主函数：返回命中的已归档 doc，未命中返回 null。
// candidate: { date, doc_type, file_name, file_sha256, category?, kind? }
export function findDocDuplicateIn(docs, candidate) {
  const list = Array.isArray(docs) ? docs : []
  const cand = candidate || {}

  // ---- 通道 0：原件字节哈希（精确、零误判，跨日期/类型/文件名） ----
  const sha = String(cand.file_sha256 || '').trim()
  if (sha) {
    const hit = list.find((d) => d && d.file && String(d.file.sha256 || '').trim() === sha)
    if (hit) return hit
  }

  // ---- 通道 1：category + date + doc_type + 文件名（历史兜底） ----
  // 必须按 category 隔离——「同日 + 出院记录」与「同日 + 某检查报告」doc_type 不同但同日，
  // 若不限 category 会被误并。保存时文件名存于 doc.file.name（无顶层 file_name）。
  const candCat = candidateCategory(cand)
  const candDate = String(cand.date || '')
  const candType = normalizeDocTypeKey(cand.doc_type)
  const candName = String(cand.file_name || '').trim()
  return (
    list.find((d) => {
      if (!d) return false
      if (docCategoryOf(d) !== candCat) return false
      if (String(d.date || '') !== candDate) return false
      if (normalizeDocTypeKey(d.doc_type) !== candType) return false
      // 无原件（手动录入）时可省略文件名匹配
      return candName ? String((d.file && d.file.name) || '').trim() === candName : true
    }) || null
  )
}

// ===================== 软查重（"疑似同一份"，不拦保存但必须提示）=====================
// 为什么需要它（2026-10-27 实测漏判）：从 AI 任务恢复的草稿没有原件、文件名是任务的临时名
// （如 source.txt），而归档那条的文件名是原件名（2215726.pdf）。于是
//   · 字节通道：候选没有 sha（老任务请求里没带）→ 不动
//   · 三项通道：文件名不等 → 判"不重复"
// 但两条记录的 **日期 + 报告类型完全一致**（2026-08-10 · 浅表器官彩超），且结论文本几乎逐字相同。
// 只靠"文件名"当键，等于把"文件从哪来"写进了查重键。
// 判据分层（从强到弱，命中即返回）：
//   · same-text：结论/所见规范化后完全相同（≥20 字）→ 可断定同一份
//   · similar-text：合并文本的 2-gram Jaccard ≥ 0.85（OCR 抖动/签名混入也能扛）→ 基本可断定
//     实测（颈部彩超二次导入，文件名不同）：findings 1.00、结论文本 0.92、合并 0.949
//   · same-date-type：同 category + 同 date + 同 doc_type → 疑似（同一天做两项同类检查也可能，故不拦）
const TEXT_MIN_LEN = 20
const SIMILAR_MIN_LEN = 40
const SIMILAR_MIN_SCORE = 0.85

// 2-gram Jaccard：中文文本最省事的相似度，对字序抖动/多一个字都宽容
function bigrams(t) {
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}
const normText = (v) =>
  String(v || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；、：,.;:!！?？·…—\-()（）【】\[\]"'"']/g, '')
    .toLowerCase()

export function findSimilarDocIn(docs, candidate) {
  const list = Array.isArray(docs) ? docs : []
  const cand = candidate || {}
  const candCat = candidateCategory(cand)
  const candDate = String(cand.date || '')
  const candType = normalizeDocTypeKey(cand.doc_type)
  const candText = normText([cand.conclusion, cand.findings].filter(Boolean).join(''))

  const candGrams = candText.length >= SIMILAR_MIN_LEN ? bigrams(candText) : null
  let soft = null
  for (const d of list) {
    if (!d) continue
    if (docCategoryOf(d) !== candCat) continue
    const dt = normText([d.conclusion, d.findings].filter(Boolean).join(''))
    // ① 文本完全相同（最强软信号，跨日期也认）
    if (candText.length >= TEXT_MIN_LEN && dt && dt === candText) return { doc: d, reason: 'same-text', score: 1 }
    // ①b 高度相似（OCR 抖动/签名混入）
    if (candGrams) {
      const score = jaccard(candGrams, bigrams(dt))
      if (score >= SIMILAR_MIN_SCORE) return { doc: d, reason: 'similar-text', score: Math.round(score * 100) / 100 }
    }
    // ② 同日同类型（只是疑似，记下来继续找更强的）
    if (!soft && candDate && candType && String(d.date || '') === candDate && normalizeDocTypeKey(d.doc_type) === candType) {
      soft = { doc: d, reason: 'same-date-type' }
    }
  }
  return soft
}
