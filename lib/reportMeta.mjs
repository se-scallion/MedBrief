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

/** 医院/实验室名：优先「××医院」，其次「××医学检验实验室/检验中心」；排除检验科/抬头噪声行 */
export function guessHospital(text = '') {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/报告单|检验科|科室|送检|打印|审核|标本|电话|地址|条码|编号/.test(l))
  for (const l of lines) {
    const m = l.match(/[\u4e00-\u9fa5（）()]{2,20}(?:医院|医学检验实验室|检验中心|卫生院|保健院)/)
    if (m) return m[0]
  }
  return ''
}

/**
 * 汇总成前端表单项可用的 meta 建议。
 * 口径（与 MedData 一致）：报告日期字段 = **报告时间**（有则用），采样/检查日期另存为 sampledAt 供核对。
 * @returns {null | {reportDate:string, sampledAt:string, reportType:string, kind:string, hospital:string, barcode:string, dateSource:string}}
 */
export function guessMeta(text = '', rows = [], { classifyReport = null } = {}) {
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
  const hos = guessHospital(text)
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
