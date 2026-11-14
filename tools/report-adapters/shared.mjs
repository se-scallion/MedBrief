// 适配器共用纯函数（叶子模块：不 import 任何适配器，避免循环依赖）
//
// ⚠️ 为什么单独一个文件：适配器要 import 这两个函数，而 index.mjs 又要 import 适配器。
// 三者放一个文件会形成环 —— 实测踩过：直接 `import('lab-panel.mjs')` 时报
// `ReferenceError: Cannot access 'labPanel' before initialization`（TDZ），
// 只有「从 index 进」才侥幸能跑。建门禁时从叶子文件直接 import 才暴露出来。

/**
 * 掉水印：真实单据（康圣达/海思特等）每行叠一次水印（姓名首字 + 条码）。
 * 判据用「跨行重复 + 形态」而不是固定词表：单字、或 `字母+6位以上数字`，且在 ≥3 行独立出现。
 * 只删**独立成词**的出现位置（`检测条码(Barcode)：V02008911352` 里的条码不是独立词，必须保留）。
 */
export function stripWatermarkTokens(lines = []) {
  const freq = new Map()
  for (const line of lines) {
    for (const tok of String(line).split(/\s+/)) {
      if (!tok) continue
      if (/^[\u4e00-\u9fa5]$/.test(tok) || /^[A-Za-z]{1,2}\d{6,}$/.test(tok)) {
        freq.set(tok, (freq.get(tok) || 0) + 1)
      }
    }
  }
  const marks = new Set([...freq.entries()].filter(([, n]) => n >= 3).map(([t]) => t))
  if (!marks.size) return lines.slice()
  return lines.map((line) => String(line)
    .split(/\s+/)
    .filter((tok) => !(marks.has(tok) && !/^[（(：:]/.test(tok)))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim())
}

// ---------------- 抬头能力（流式 / 核型 / 通用化验单共用）----------------
// 康圣达系版式的标签是「中文(EN)：值」且一行多组；早期只在 flow 适配器里实现，兜底 lab-panel
// 不认这种标签 → 姓名/医院/日期全丢（2026-11-12 核型报告实测）。下沉到这里，一处实现多处复用。

/** 顺序有讲究：`医生电话` 必须在 `医生` 之前，否则会被截成「医生」+「电话」。 */
export const LABEL_RE = /(姓名|年龄|性别|标本编号|就诊医院|就诊类型|医生电话|床号|医生|标本类型|病历号|接检时间|临床诊断|身份证号|采集时间|采样时间|科别|检测条码|检测方法|检测设备|外部条码)\s*[(（][^)）]{0,48}[)）]\s*[：:]?/g

/** 把一行「标签(EN)：值 标签(EN)：值」切成 { 标签: 值 }（值取到下一个标签前）。 */
export function splitLabeledLine(line = '') {
  const text = String(line)
  const hits = [...text.matchAll(LABEL_RE)]
  const out = {}
  for (let i = 0; i < hits.length; i++) {
    const end = hits[i].index + hits[i][0].length
    const next = i + 1 < hits.length ? hits[i + 1].index : text.length
    const value = text.slice(end, next).trim()
    out[hits[i][1]] = value
  }
  return out
}

/** 全文 → 抬头字段表（先去水印，再逐行切标签；后出现的同名标签不覆盖已有值）。 */
export function parseHeadFields(text = '') {
  const lines = stripWatermarkTokens(String(text).split(/\r?\n/)).map((l) => l.trim()).filter(Boolean)
  const fields = {}
  for (const line of lines) for (const [k, v] of Object.entries(splitLabeledLine(line))) if (!(k in fields)) fields[k] = v
  return fields
}

const pad2 = (n) => String(n).padStart(2, '0')
export function dateOnly(s) {
  const m = String(s || '').match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  return m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : ''
}

/**
 * 报告日期统一口径：**先信「报告日期 + 日期」连写**，没有才用采样/接检时间兜底，并留痕。
 * 不能只搜「报告日期」三个字 —— 页脚有「自报告日期起的三天内提出复检申请」（flow 实测踩过）。
 * 兜底不是编造：日期来自报告原文，且 warnings 明确写出来源（CLI 会进 --review suspect）。
 */
export function pickReportDate(text = '', fields = {}) {
  const sampledAt = String(fields['采集时间'] || fields['采样时间'] || '')
  const receivedAt = String(fields['接检时间'] || '')
  const hit = String(text).match(/报告日期\s*[（(][^)）]*[)）]?\s*[：:]?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
    || String(text).match(/报告日期\s*[：:]?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  const reportDate = hit ? `${hit[1]}-${pad2(hit[2])}-${pad2(hit[3])}` : (dateOnly(sampledAt) || dateOnly(receivedAt))
  const warnings = []
  if (!hit) warnings.push(`报告日期未读到，已用${dateOnly(sampledAt) ? '采样' : '接检'}日期兜底：${reportDate || '（也没有采样/接检时间）'}`)
  return { reportDate, sampledAt, receivedAt, warnings }
}

/**
 * 整份级可信度判据：只有 1–2 行、且全都缺单位/参考区间/箭头/定性结果时，
 * 判定「这不是化验表格版式」，宁可 0 行失败（退出码 3）也不许 1 行假行成功（退出码 0）。
 * 逐行窄判据在 lib/reportIntake.mjs 的 isPlausibleLabRow；这里只管整份，二者互补。
 */
export function assessLabRows(rows = []) {
  if (!rows.length) return { plausible: false, rows: [], reason: '未解析出任何指标行' }
  const strong = rows.filter((r) => String(r.unit || '').trim() || String(r.refRange || '').trim()
    || String(r.flag || '').trim() || /阴性|阳性|未检出|检出/.test(String(r.value || '')))
  if (!strong.length && rows.length <= 2) {
    return { plausible: false, rows: [], reason: `仅 ${rows.length} 行且都缺单位/参考区间/箭头/定性结果 —— 疑似非化验版式` }
  }
  return { plausible: true, rows, reason: '' }
}

/**
 * 哪些地方需要人核对？—— 只把「机器不确定」的项挑出来，而不是让人通读整份。
 * 判据全部是「留痕字段」：切块值冲突 / 名称按序号推定 / 值非纯数值 / 缺原文片段 / 抬头关键字段缺失。
 * @returns {string[]} 人读的原因列表（空数组 = 这份可以不再逐行看）
 */
export function collectSuspects({ rows = [], meta = {}, warnings = [] } = {}) {
  const out = []
  for (const r of rows) {
    if (r.valueConflict) out.push(`${r.name}：切块边界读出过不同值（已按多数票取用，请对原图核一次）`)
    if (r.nameInferred) out.push(`${r.name}：项目名是按序号推定的（不是识别到的）`)
    if (r.num === null || r.num === undefined) out.push(`${r.name}：值「${r.value}」不是纯数值，请核对`)
    if (!r.rawSnippet) out.push(`${r.name}：缺原文片段，无法回查`)
    if (/^(19|20)\d{2}$/.test(String(r.value || '').trim()) && !r.unit && !r.refRange) out.push(`${r.name}：值「${r.value}」像年份/版本号，疑似版式文字被当成指标`)
  }
  if (!meta.patientName) out.push('姓名未读到')
  if (!meta.reportDate) out.push('报告日期未读到')
  for (const w of warnings || []) if (!out.includes(w)) out.push(w)
  return out
}
