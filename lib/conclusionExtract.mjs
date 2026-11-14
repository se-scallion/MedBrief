// 关键结论「原文摘录」抽取（2026-11-14 用户口径）
//
// 为什么需要它：染色体核型、骨穿、关键影像（MRI/CT）都是「全文型」报告 —— 报告里有正文 text，
// 但卡面上过去只写「已见 染色体核型(07-15)」，医生看不到结论原句（是否为复杂核型？影像是否见结节？）。
//
// 红线（不许违反）：
//   1. **只摘原句，不做任何推断**。抓不到就返回 null，绝不拼接、绝不改写、绝不补词；
//   2. 抽取结果必须能被人在原文里逐字找到（返回的是原文切片）；
//   3. 卡片上要标 `[原文摘录]`，人工填写的标 `[人工摘录]`，两者不混淆。

/** 卡片上每条摘录的最大长度（含省略号），用户口径：超 90 字优雅截断 */
export const MAX_QUOTE_CHARS = 90

const clean = (s) => String(s || '').replace(/\u3000/g, ' ').replace(/[ \t]+/g, ' ').trim()

export function clipQuote(s, max = MAX_QUOTE_CHARS) {
  const t = clean(s)
  if (!t) return ''
  if (t.length <= max) return t
  return t.slice(0, Math.max(0, max - 1)).replace(/[，,、；;：:\s]+$/, '') + '…'
}

const LINES = (text) => String(text || '')
  .split(/\r?\n/)
  .map((l) => clean(l))
  .filter(Boolean)

/** 按关键词打分挑一句；找不到返回 null */
function pickLine(lines, patterns, { minLen = 6, maxLen = 220 } = {}) {
  for (const re of patterns) {
    for (const l of lines) {
      if (l.length < minLen || l.length > maxLen) continue
      if (re.test(l)) return l
    }
  }
  return null
}

// ---------------- 染色体核型 ----------------
// 顺序即优先级：① 报告自己写的结论段（「结果描述/结果解释/检测结论」最贴近医生要的）
// ② ISCN 核型式样（`46,XX,t(9;22)(q34;q11.2)[2]/…`）③ 含克隆/复杂核型判断的句子。
// 明确排除抬头/页脚行（「染色体核型分析报告单」「XX实验室」），否则会摘到标题。
const JUNK_KARYO = /(报告单|检验实验室|检测实验室|防伪|参考区间|标本类型|采集时间|检测方法)/ 
const KARYO_PATTERNS = [
  /^(结果描述|结果解释|检测结论|结论|诊断意见)[:：]\s*\S/,
  /\d{2}\s*,\s*[XY]{1,2}\s*,.*\[/,
  /(复杂核型|正常核型|克隆性异常|未见克隆性异常)/,
  /(核型)[^。]{6,}/,
]

export function extractKaryotype(report) {
  const lines = LINES(report?.text).filter((l) => !JUNK_KARYO.test(l))
  return pickLine(lines, KARYO_PATTERNS)
}

// ---------------- 骨穿 / 骨髓形态 ----------------
const MARROW_PATTERNS = [
  /(骨髓|BM)[^。]{0,40}(增生|增生活跃|增生减低|极度活跃)/,
  /(原始细胞|原幼细胞|幼淋巴细胞)[^。]{0,30}\d/,
  /(结论|诊断意见|骨髓象)[:：]\s*\S/,
  /(完全缓解|部分缓解|未缓解|CR|PR)/,
]

export function extractMarrow(report) {
  const lines = LINES(report?.text)
  return pickLine(lines, MARROW_PATTERNS)
}

// ---------------- 影像（MRI / CT / 超声 / 放射） ----------------
// 用户口径：同一天有多份影像时，优先挑「含头/颅/脑/肺等关键部位」的那份。
export const KEY_ANATOMY = /(头|颅|脑|肺|胸|纵隔|骨髓|脊柱|眼眶|鼻咽|颈部|肝|脾)/
// 部位权重（用户口径：同一天多份影像时优先「含头/颅/脑/肺等关键部位」的那份）
export function anatomyWeight(report) {
  const hay = `${report?.reportType || ''} ${String(report?.text || '').slice(0, 600)}`
  if (/(头|颅|脑)/.test(hay)) return 4
  if (/(肺|胸|纵隔|脊柱|骨髓)/.test(hay)) return 3
  if (/(眼眶|鼻咽|颈部)/.test(hay)) return 2
  if (/(肝|脾|胆|胰|肾|腹)/.test(hay)) return 1
  return 0
}
// 模态权重：MRI/CT 优于超声（超声多为床旁筛查，结论粒度粗）
export function modalityWeight(report) {
  const t = String(report?.reportType || '')
  // 磁共振/MRI 优先级最高：脑部病变的细节（强化、SWI 微出血）只有 MRI 能给
  if (/MRI|MR|核磁|磁共振/i.test(t)) return 3
  if (/CT/i.test(t)) return 2
  if (/X线|X-ray|放射/i.test(t)) return 1
  return 0   // 超声等：多为床旁筛查，结论粒度粗
}
// 真实库里影像多为「手机截屏 OCR」，正文夹着 App 界面噪声（抖音/证件号码/项目名称/报告单号…）。
// 这些行必须整行丢弃，否则会把「检查报告详情」当成影像结论。
const JUNK_IMAGING = /(检查报告详情|抖音|证件号码|项目名称|报告单号|报告时间|就诊医院|科室|申请科室|检查医师|审核医师|打印时间|^\d{1,2}:\d{2}\b)/
const IMAGING_CONCLUSION_PATTERNS = [
  /^(结论|诊断意见|影像诊断|检查结论|印象|意见|影像所见|检查所见)[:：]\s*\S/,
  /(考虑|提示|符合|不除外|未见|可见|见)[^。]{6,}/,
  /(结节|占位|肿块|片状|强化|信号|密度|阴影|低密度|高密度)[^。]{4,}/,
]

// 「检查结果 / 结论 / 诊断意见」这类**分段标题**后面的内容才是医生要的结论；
// 正文常被 OCR 按固定宽度折行（"脑实质未见明显异常强化影；对比2026-08-20日片，左侧 / 额叶强化结节…"），
// 所以要把标题后面的连续行**拼回整句**再截断。
const RESULT_HEAD = /^(检查结果|检查结论|诊断意见|影像诊断|诊断结果|结论|印象|意见)[:：]?\s*(.*)$/
const SECTION_END = /^(检查描述|检查所见|影像所见|检查建议|电子报告|返回|报告单号|报告时间|项目名称|检查医师|审核医师)/

export function extractImaging(report) {
  const all = LINES(report?.text).filter((l) => !JUNK_IMAGING.test(l))
  if (!all.length) return null
  // ① 先找分段标题，把标题后（含同行剩余文字）的连续句子拼起来
  for (let i = 0; i < all.length; i++) {
    const m = all[i].match(RESULT_HEAD)
    if (!m) continue
    const parts = []
    if (m[2]) parts.push(m[2].trim())
    for (let j = i + 1; j < all.length; j++) {
      if (SECTION_END.test(all[j])) break
      parts.push(all[j])
    }
    const merged = parts.join('').replace(/\s+/g, '')
    if (merged.length >= 6) return merged
  }
  // ② 再退回单句匹配
  const hit = pickLine(all, IMAGING_CONCLUSION_PATTERNS)
  if (hit) return hit
  // 兜底：取最长的「像话」一行（长度够、不是页眉页脚/电话/地址）
  const junk = /(电话|地址|邮编|传真|报告单|仅供参考|签字|审核|检验|实验室$|^\d{5,}$)/
  const cand = all.filter((l) => l.length >= 12 && !junk.test(l)).sort((a, b) => b.length - a.length)
  return cand[0] || null
}

// ---------------- 类型判定 ----------------
export const isKaryotype = (r) => /核型|karyotype/i.test(String(r?.reportType || ''))
export const isMarrow = (r) => /(骨穿|骨髓形态|骨髓涂片|骨髓检查|骨髓细胞学)/.test(String(r?.reportType || ''))
const NOT_IMAGING = /(融合基因|基因|病理|流式|免疫分型|骨髓形态|骨髓涂片|染色体|核型|血常规|生化|尿|便|心电图)/
export const isImaging = (r) => {
  const t = String(r?.reportType || '')
  if (NOT_IMAGING.test(t)) return false
  return /(MRI|MR|CT|磁共振|核磁|超声|彩超|B超|X线|X-ray|放射|影像|PET)/i.test(t)
    || String(r?.kind || '') === 'imaging'
}

/**
 * 从一批报告里挑出「染色体 / 骨穿 / 关键影像」三类各一条结论。
 * @returns {{key:string,label:string,reportId:string,date:string,reportType:string,text:string}[]}
 */
export function pickKeyConclusions(reports = []) {
  const out = []
  const dateOf = (r) => String(r?.reportDate || r?.sampledAt || '').slice(0, 10)

  const karyo = reports.filter((r) => isKaryotype(r) && String(r.text || '').trim())
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)))
  if (karyo.length) {
    const r = karyo[0]
    const t = extractKaryotype(r)
    if (t) out.push({ key: 'karyotype', label: '染色体核型', reportId: r.id, date: dateOf(r), reportType: r.reportType || '', text: clipQuote(t) })
  }

  const marrow = reports.filter((r) => isMarrow(r) && String(r.text || '').trim())
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)))
  if (marrow.length) {
    const r = marrow[0]
    const t = extractMarrow(r)
    if (t) out.push({ key: 'marrow', label: '骨穿/MRD', reportId: r.id, date: dateOf(r), reportType: r.reportType || '', text: clipQuote(t) })
  }

  // 影像：优先「含关键部位」的，其次最新
  const imaging = reports.filter((r) => isImaging(r) && String(r.text || '').trim())
  if (imaging.length) {
    const scored = imaging.map((r) => ({
      r,
      anatomy: anatomyWeight(r),
      modality: modalityWeight(r),
      date: dateOf(r),
    })).sort((a, b) => (b.anatomy - a.anatomy) || (b.modality - a.modality) || b.date.localeCompare(a.date))
    for (const { r } of scored) {
      const t = extractImaging(r)
      if (t) { out.push({ key: 'imaging', label: '关键影像', reportId: r.id, date: dateOf(r), reportType: r.reportType || '', text: clipQuote(t) }); break }
    }
  }
  return out
}

/**
 * 合并「自动抽取」与「人工填写」：人工优先（用户口径），并标来源。
 * @param {Array} auto  pickKeyConclusions() 的结果
 * @param {Object} manual patient.keyConclusions = { karyotype, marrow, imaging }
 */
export function mergeKeyConclusions(auto = [], manual = {}) {
  const labels = { karyotype: '染色体核型', marrow: '骨穿/MRD', imaging: '关键影像' }
  return ['karyotype', 'marrow', 'imaging'].map((key) => {
    const m = clean(manual?.[key] || '')
    if (m) return { key, label: labels[key], date: '', reportType: '', text: clipQuote(m), source: 'manual' }
    const a = auto.find((x) => x.key === key)
    return a ? { ...a, source: 'auto' } : null
  }).filter(Boolean)
}
