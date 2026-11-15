// 报告元信息推断（2026-11-15 用户要求：按 MedData 的既有逻辑来，别自己拍脑袋）
//
// 来源：MedData `meddata/src/utils/parseDoc.js` 的日期抽取（label 优先 + 退化链）。
// 当初那套是踩着真实 bug 修出来的，这里**照搬其判据**：
//   1) **标签优先**：
//      · 检查/采样类标签（检查时间/检查日期/采集/接收/送检/取样/采取/取材/采样）→ 记为「检查(采样)日期 date」
//      · 报告类标签（报告时间/报告日期/签发/出报告/回报）→ 记为「报告时间 reported_at」
//      两类都有且不同 → 检查日期为主、报告时间另存（**不覆盖**）；
//   2) 无标签但有「时分」→ 第一个为检查、最后一个不同者为报告；
//   3) 无标签仅日期 → 第一个为检查、最后一个不同日期为报告。
// 绝不能"取全文最后一个日期"：报告单末尾常有「打印时间/送达时间/有效期」，
// 那样会把打印日期当成报告日期（用户 2026-11-15 实测就是这种情况）。

const D = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** 文本里所有「YYYY-MM-DD / YYYY年M月D日 / YYYY.M.D[/ 带时分]」出现 */
function allDates(text = '') {
  const re = /(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})(?:\s*[T\s]?\s*(\d{1,2})[:：](\d{2}))?/g
  const out = []
  let m
  while ((m = re.exec(String(text)))) {
    out.push({
      date: D(m[1], m[2], m[3]),
      time: m[4] ? `${String(m[4]).padStart(2, '0')}:${m[5]}` : '',
      index: m.index,
    })
  }
  return out
}

const LABEL_CHECK = ['检查时间', '检查日期', '采集时间', '采集日期', '接收时间', '接收日期', '送检日期', '取样日期',
  '采取日期', '采取时间', '取材日期', '取材时间', '采样日期', '采样时间']
const LABEL_REPORT = ['报告时间', '报告日期', '签发时间', '签发日期', '出报告时间', '回报时间', '回报日期', '审核时间', '审核日期']

/** 取「标签之后 40 字符内」的第一个日期（同一行优先，允许换行/空格分隔） */
function afterLabel(text, labels, window = 40) {
  const t = String(text || '')
  for (const lb of labels) {
    const re = new RegExp(`${lb}[^\\d]{0,12}(20\\d{2}\\s*[-年/.]\\s*\\d{1,2}\\s*[-月/.]\\s*\\d{1,2}(?:\\s*[T\\s]?\\s*\\d{1,2}[:：]\\d{2})?)`, 'g')
    let m
    while ((m = re.exec(t))) {
      const one = allDates(m[1])[0]
      if (one) return one
      if (re.lastIndex > t.length) break
    }
    // 标签与日期分处两行（PDF 分栏常见）：标签行之后 window 个字符内找第一个日期
    const idx = t.indexOf(lb)
    if (idx >= 0) {
      const tail = t.slice(idx + lb.length, idx + lb.length + window)
      const found = allDates(tail)[0]
      if (found) return found
    }
  }
  return null
}

/**
 * 抽取「检查(采样)日期」与「报告时间」。
 * @returns {{date:string, time:string, reportedAt:string, source:string}}
 */
export function extractDocDates(text = '') {
  const t = String(text || '')
  const checked = afterLabel(t, LABEL_CHECK)
  const reported = afterLabel(t, LABEL_REPORT)
  if (checked || reported) {
    const main = checked || reported
    const rep = reported && (reported.date !== main.date || reported.time !== main.time) ? reported : null
    return {
      date: main.date,
      time: main.time,
      reportedAt: rep ? `${rep.date}${rep.time ? ' ' + rep.time : ''}` : '',
      source: checked && reported ? 'label-both' : checked ? 'label-checked' : 'label-reported',
    }
  }
  const all = allDates(t)
  if (!all.length) return { date: '', time: '', reportedAt: '', source: 'none' }
  const withTime = all.filter((x) => x.time)
  if (withTime.length) {
    const first = withTime[0]
    const last = withTime[withTime.length - 1]
    const rep = last.date !== first.date || last.time !== first.time ? last : null
    return { date: first.date, time: first.time, reportedAt: rep ? `${rep.date} ${rep.time}` : '', source: 'fallback-time' }
  }
  const first = all[0]
  const last = all[all.length - 1]
  return { date: first.date, time: '', reportedAt: last.date !== first.date ? last.date : '', source: 'fallback-first' }
}

/** 条码：V + 8 位以上；或 8 位数字 + G + 6 位以上 */
export function guessBarcode(text = '') {
  const m = String(text || '').match(/\bV\d{8,}\b|\b\d{8}G\d{6,}\b/)
  return m ? m[0] : ''
}

// 医院名清理：OCR/排版常把「医院」重复一遍（实测库里有「新疆军区总医院医院」）。
function tidyHospital(name = '') {
  return String(name || '').trim().replace(/(医院|卫生院|保健院)\1+/g, '$1')
}

const HOSP_RE = /[\u4e00-\u9fa5（）()·\-]{2,20}(?:医院|医学检验实验室|检验中心|卫生院|保健院)/

/**
 * 文本里所有「像医院/实验室的名字」，按可信度排序。
 * 顺序：① 标签同行有值的（就诊医院：XXX）→ ② 其余出现的候选（抬头/落款，先去重、去掉已知噪声行）。
 * 为什么要全部候选：PDF 分栏时「就诊医院(Hospital)：」的值常被排版甩到几十行之后（实测就是），
 * 标签同行取不到值，这时**不能**就此认定抬头上的检验实验室——要交给上层用「本库已知医院」再挑一次。
 */
export function hospitalCandidates(text = '') {
  const t = String(text || '')
  const out = []
  const push = (v) => {
    const name = tidyHospital(v)
    if (!name || name.length < 3 || out.includes(name)) return
    // 2026-11-15 实测（用户真截图）：页脚「本结果仅供参考，请以医院纸质报告及医生意见为准。」
    // 被抽成院名 `请以医院`，一入库就把「请以医院」写进报告抬头。
    // 判据（语言学形态，不是医院黑名单）：**院名必须以地名/机构名起头**——中文虚词/动词起头的
    // 一定不是机构名（请以/至/到/该/本/此…）。故先剔虚词起头，再要求去掉后缀后仍有 ≥2 字落名。
    if (/^(请|以|至|到|去|该|本|此|贵|我|你|其|按|凭|据|依|见|从|向|若|如|则|并|及|和|与)/.test(name)) return
    out.push(name)
  }
  // ① 标签同行带值
  const inline = t.match(new RegExp(`(?:就诊医院|送检医院|医院名称|检查医院|机构名称)\\s*(?:[(（][^)）]{0,20}[)）])?\\s*[:：]?\\s*(${HOSP_RE.source})`))
  if (inline) push(inline[1])
  // ② 逐行候选（排除检验科/打印/条码/免责声明等噪声行）
  const lines = t.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/报告单|检验科|科室|送检|打印|审核|标本|电话|地址|条码|编号/.test(l))
    .filter((l) => !/仅供参考|免责|请以|纸质报告|为准|声明/.test(l))
  for (const l of lines) {
    const m = l.match(HOSP_RE)
    if (m) push(m[0])
  }
  return out
}

/**
 * 医院名：候选里**优先取本库已知的医院**（同一条码/同一病人的报告口径才能对齐），
 * 都不认识时退回第一个候选。knownHospitals 由调用方（server）从 data/reports.json 提供。
 */
export function guessHospital(text = '', { knownHospitals = [] } = {}) {
  const cands = hospitalCandidates(text)
  if (!cands.length) return ''
  const known = (knownHospitals || []).map((h) => tidyHospital(h)).filter(Boolean)
  if (known.length) {
    // 完全相等优先，其次「一方包含另一方」（「××医院」vs「××医院（本部）」）
    const exact = cands.find((c) => known.includes(c))
    if (exact) return exact
    const loose = cands.find((c) => known.some((k) => k.includes(c) || c.includes(k)))
    if (loose) return loose
  }
  return cands[0]
}

/**
 * 汇总成前端表单项可用的 meta 建议。
 * 口径（与 MedData 一致）：报告日期字段 = **报告时间**（有则用），采样/检查日期另存为 sampledAt 供核对。
 * @returns {null | {reportDate:string, sampledAt:string, reportType:string, kind:string, hospital:string, barcode:string, dateSource:string}}
 */
export function guessMeta(text = '', rows = [], { classifyReport = null, knownHospitals = [] } = {}) {
  const dates = extractDocDates(text)
  const out = {}
  const reportedDay = String(dates.reportedAt || '').slice(0, 10)
  if (reportedDay) {
    out.reportDate = reportedDay
    out.sampledAt = dates.date ? `${dates.date}${dates.time ? ' ' + dates.time : ''}` : ''
  } else if (dates.date) {
    out.reportDate = dates.date
    out.sampledAt = dates.time ? `${dates.date} ${dates.time}` : ''
  }
  out.dateSource = dates.source || 'none'
  // 只有 dateSource 不算「有内容」：没日期/没条码/没医院/没类型时返回 null，前端不乱填
  const bc = guessBarcode(text)
  if (bc) out.barcode = bc
  const hos = guessHospital(text, { knownHospitals })
  if (hos) out.hospital = hos
  if (typeof classifyReport === 'function') {
    try {
      const cls = classifyReport({ text, rows: Array.isArray(rows) ? rows : [] })
      if (cls?.reportType && cls.reportType !== 'LAB_PANEL') out.reportType = cls.reportType
      if (cls?.kind) out.kind = cls.kind
    } catch {}
  }
  const meaningful = ['reportDate', 'sampledAt', 'barcode', 'hospital', 'reportType', 'kind'].some((k) => out[k])
  return meaningful ? out : null
}
