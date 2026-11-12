// ===================== 本次就诊一页速览（纯函数） =====================
// 契约：
//   buildVisitBrief({ state, patientMeta, limit, generatedAt, source })
//     → { meta, series, text, html }
//   **红线：只陈述数值、时间点、趋势与参考区间，不下诊断结论、不给治疗建议、不做风险分级。**
//   （"原始细胞 1.5% 说明缓解/复发" 这类话一律不许出现在本页；判断权归医生。）
//
// 数据来源：MedData state（records / diseaseMetrics）——来自 8787 `/api/state` 或 .meddata 包 payload。
// 趋势箭头：相邻两次对比，变化幅度 ≤1% 记 `→`；无上一侧数据记 `—`。

export const VISIT_METRICS = [
  { code: 'WBC', label: '白细胞', abbr: 'WBC', kind: 'lab' },
  { code: 'PLT', label: '血小板', abbr: 'PLT', kind: 'lab' },
  { code: 'Hb', label: '血红蛋白', abbr: 'Hb', kind: 'lab' },
  { code: 'BM_BLAST_PCT', label: '骨髓原始细胞比例', abbr: 'BM-Blast', kind: 'disease' },
  { code: 'FCM_MRD_PCT', label: '流式 MRD', abbr: 'FCM-MRD', kind: 'disease' },
]

const STATUS_TEXT = { LOW: '偏低', HIGH: '偏高', NORMAL: '正常', ABNORMAL: '异常' }

function parseNum(raw) {
  const s = String(raw ?? '').trim().replace(/[,，\s]/g, '').replace(/^[<>≤≥]/, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// 参考区间解析：OCR 里常见 `126--350` / `3.5--9.5`（双连字符）、en/em dash、全角波浪
// ⚠️ 坑：若把 `-?` 同时允许给上下限，`126--350` 会被解析成 low=126 / high=-350 → 假「偏高」。
// 故先把连续分隔符归一成单个 `-`，再只允许**下限**带负号（化验区间下限为负极罕见，但保号不错）。
export function parseRefRange(refRange) {
  const s = String(refRange || '')
    .replace(/\s/g, '')
    .replace(/[–—~〜]/g, '-')
    .replace(/-{2,}/g, '-')
  const m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  const low = Number(m[1])
  const high = Number(m[2])
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return null
  return { low, high }
}

// 取某个指标的时间倒序序列（最多 limit 条，跳过空值）
export function collectSeries(state = {}, limit = 3) {
  const records = Array.isArray(state.records) ? state.records : []
  const metrics = Array.isArray(state.diseaseMetrics) ? state.diseaseMetrics : []
  const out = {}

  for (const def of VISIT_METRICS) {
    const items = []
    if (def.kind === 'lab') {
      for (const rec of records) {
        for (const dp of Array.isArray(rec.data_points) ? rec.data_points : []) {
          if (dp.standard_code !== def.code) continue
          const raw = dp.value
          if (raw === null || raw === undefined || String(raw).trim() === '') continue
          items.push({
            date: rec.date || '',
            createdAt: rec.created_at || '',
            value: String(raw).trim(),
            num: parseNum(raw),
            unit: dp.unit || '',
            refRange: dp.ref_range || '',
            status: dp.status || '',
          })
        }
      }
    } else {
      for (const m of metrics) {
        if (m.code !== def.code) continue
        if (m.value === null || m.value === undefined || String(m.value).trim() === '') continue
        items.push({
          date: m.date || '',
          createdAt: m.created_at || '',
          value: String(m.value).trim(),
          num: parseNum(m.value),
          unit: m.unit || '',
          refRange: '', // 骨髓/流式无统一参考区间：不标异常、不下判断
          status: '',
          qualifier: m.qualifier || 'eq',
        })
      }
    }
    // 时间倒序（同日期按 created_at）
    items.sort((a, b) => {
      const d = String(b.date).localeCompare(String(a.date))
      return d !== 0 ? d : String(b.createdAt).localeCompare(String(a.createdAt))
    })
    // 趋势在**完整序列**上算（否则第 3 条永远是 `—`），算完再截取近 limit 次
    const withTrend = items.map((it, i) => ({ ...it, trend: trendSymbol(it, items[i + 1]) }))
    out[def.code] = withTrend.slice(0, limit)
  }
  return out
}

// 趋势箭头：新值 vs 旧值，变化 ≤1% 记平稳
export function trendSymbol(curr, prev) {
  if (!prev) return '—'
  if (curr.num === null || prev.num === null) return '—'
  if (prev.num === 0) return curr.num === 0 ? '→' : '↑'
  const delta = (curr.num - prev.num) / Math.abs(prev.num)
  if (Math.abs(delta) <= 0.01) return '→'
  return delta > 0 ? '↑' : '↓'
}

// 单条记录是否异常：优先用报告自带 status，其次按参考区间比较
export function isAbnormal(item) {
  if (item.status === 'LOW' || item.status === 'HIGH' || item.status === 'ABNORMAL') return true
  if (item.num === null) return false
  const ref = parseRefRange(item.refRange)
  if (!ref) return false
  return item.num < ref.low || item.num > ref.high
}

// 短标记：仅用于文本里逐个数值标注（低/高），骨髓/流式无参考区间则不给标记
export function shortFlag(item) {
  if (!isAbnormal(item)) return ''
  const ref = parseRefRange(item.refRange)
  if (item.status === 'LOW') return '低'
  if (item.status === 'HIGH') return '高'
  if (ref && item.num !== null) return item.num < ref.low ? '低' : '高'
  return '异常'
}

function statusLabel(item) {
  if (item.status && STATUS_TEXT[item.status]) return STATUS_TEXT[item.status]
  if (item.num === null) return ''
  const ref = parseRefRange(item.refRange)
  if (!ref) return ''
  if (item.num < ref.low) return '低于参考区间'
  if (item.num > ref.high) return '高于参考区间'
  return '在参考区间内'
}

function fmtDate(d) {
  if (!d) return '日期未知'
  // 2026-09-20 / 2026-09-20T... 一律取前 10 位
  return String(d).slice(0, 10)
}

function fmtValue(item) {
  return `${item.value}${item.unit ? ' ' + item.unit : ''}`
}

/**
 * 构建一页速览
 * @param {object} options { state, patientMeta, limit, generatedAt, sourceLabel }
 */
export function buildVisitBrief(options = {}) {
  const state = options.state || {}
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 3
  const patientMeta = options.patientMeta || state.patient_meta || state.patientMeta || {}
  const generatedAt = options.generatedAt || new Date().toISOString()
  const sourceLabel = options.sourceLabel || 'MedData 本机数据（只读）'

  const series = collectSeries(state, limit)
  const labDefs = VISIT_METRICS.filter((d) => d.kind === 'lab')
  const diseaseDefs = VISIT_METRICS.filter((d) => d.kind === 'disease')

  const meta = {
    patientName: patientMeta.name || '',
    gender: patientMeta.gender || '',
    age: patientMeta.age ?? '',
    diagnosis: patientMeta.diagnosis || '',
    generatedAt,
    sourceLabel,
    limit,
  }

  // ---------- 纯文本 ----------
  const lines = []
  const whoStr = [meta.patientName || '（姓名未填）']
  if (meta.gender || meta.age) whoStr.push(`（${meta.gender === 'Male' ? '男' : meta.gender === 'Female' ? '女' : meta.gender || ''}${meta.age ? ` / ${meta.age} 岁` : ''}）`)
  if (meta.diagnosis) whoStr.push(`　诊断：${meta.diagnosis}`)
  lines.push('MedBrief · 本次就诊一页速览')
  lines.push(whoStr.join(''))
  lines.push(`生成：${generatedAt.replace('T', ' ').slice(0, 16)}　数据源：${sourceLabel}`)
  lines.push('说明：本页只陈述数值、时间点与趋势，不含诊断结论与治疗建议。')
  lines.push('')
  lines.push(`【一】血常规关键指标（时间倒序，最多近 ${limit} 次；↑ 较上次升高 / ↓ 降低 / → 基本持平 / — 无上次数据；〔低〕〔高〕= 越出参考区间）`)
  lines.push('')
  for (const def of labDefs) {
    const items = series[def.code] || []
    if (!items.length) {
      lines.push(`${def.label}（${def.abbr}）：无记录`)
      continue
    }
    const cells = items
      .map((it) => {
        const flag = shortFlag(it)
        return `${it.value}${it.trend}${flag ? `〔${flag}〕` : ''}（${fmtDate(it.date)}）`
      })
      .join('　')
    const ref = items[0].refRange ? `　参考区间 ${items[0].refRange} ${items[0].unit}` : ''
    const flag = isAbnormal(items[0]) ? `　【异常·${statusLabel(items[0])}】` : ''
    lines.push(`${def.label}（${def.abbr}）：${cells}${ref}${flag}`)
  }
  lines.push('')
  lines.push('【二】骨髓与残留病指标（时间倒序；无统一参考区间，故不作异常判定）')
  lines.push('')
  for (const def of diseaseDefs) {
    const items = series[def.code] || []
    if (!items.length) {
      lines.push(`${def.label}（${def.abbr}）：无记录`)
      continue
    }
    const cells = items.map((it) => `${it.value}${it.unit ? ' ' + it.unit : ''}${it.trend}（${fmtDate(it.date)}）`).join('　')
    lines.push(`${def.label}（${def.abbr}）：${cells}`)
  }
  lines.push('')
  lines.push('【三】本页不含：报告原文与影像、用药与费用明细、以及任何诊断或治疗意见；相关材料见同批 .meddata 交换包。')

  // ---------- HTML 可打印卡片 ----------
  const labRows = labDefs
    .map((def) => {
      const items = series[def.code] || []
      if (!items.length) return `<tr><td class="k">${def.label}</td><td colspan="2" class="muted">无记录</td><td class="muted">—</td></tr>`
      const cells = items
        .map((it) => {
          const bad = isAbnormal(it)
          return `<span class="${bad ? 'bad' : ''}">${it.value}${it.trend}<small>（${fmtDate(it.date)}）</small></span>`
        })
        .join(' ')
      const latest = items[0]
      const badLatest = isAbnormal(latest)
      const status = statusLabel(latest)
      return `<tr>
        <td class="k">${def.label}<small>${def.abbr}</small></td>
        <td>${cells}</td>
        <td class="ref">${latest.refRange ? `${latest.refRange} ${latest.unit}` : '—'}</td>
        <td class="${badLatest ? 'bad' : 'muted'}">${badLatest ? '⚠ ' + status : status || '—'}</td>
      </tr>`
    })
    .join('')

  const diseaseRows = diseaseDefs
    .map((def) => {
      const items = series[def.code] || []
      if (!items.length) return `<tr><td class="k">${def.label}</td><td colspan="2" class="muted">无记录</td><td class="muted">—</td></tr>`
      const cells = items
        .map((it) => `<span>${it.value}${it.unit ? ' ' + it.unit : ''}${it.trend}<small>（${fmtDate(it.date)}）</small></span>`)
        .join(' ')
      return `<tr><td class="k">${def.label}<small>${def.abbr}</small></td><td>${cells}</td><td class="ref">无统一参考区间</td><td class="muted">—</td></tr>`
    })
    .join('')

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>本次就诊一页速览 · ${escapeHtml(meta.patientName || '')}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 12px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #111; margin: 0; padding: 18px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .who { color: #333; }
  .meta { color: #666; font-size: 11px; margin-top: 2px; }
  .warn { margin: 10px 0; padding: 6px 10px; border: 1px solid #d1d5db; background: #f9fafb; color: #374151; font-size: 11px; }
  h2 { font-size: 12px; margin: 14px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #e5e7eb; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 5px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { text-align: left; font-weight: 600; color: #555; font-size: 11px; }
  td.k { width: 22%; font-weight: 600; }
  td.k small, td span small { color: #888; font-weight: 400; margin-left: 2px; }
  td.ref { width: 20%; color: #555; }
  .bad { color: #c81e1e; font-weight: 600; }
  .muted { color: #9ca3af; }
  .foot { margin-top: 14px; color: #6b7280; font-size: 10.5px; }
  @media print { body { padding: 0; } }
</style></head>
<body>
  <h1>MedBrief · 本次就诊一页速览</h1>
  <div class="who">${escapeHtml(whoStr.join(''))}</div>
  <div class="meta">生成：${escapeHtml(generatedAt.replace('T', ' ').slice(0, 16))}　数据源：${escapeHtml(sourceLabel)}</div>
  <div class="warn">本页只陈述数值、时间点与趋势；<b>不含诊断结论与治疗建议</b>。↑ 较上次升高 / ↓ 降低 / → 基本持平 / — 无上次数据。</div>
  <h2>一、血常规关键指标（时间倒序，最多近 ${limit} 次）</h2>
  <table>
    <thead><tr><th>指标</th><th>历次数值</th><th>参考区间</th><th>最新状态</th></tr></thead>
    <tbody>${labRows}</tbody>
  </table>
  <h2>二、骨髓与残留病指标</h2>
  <table>
    <thead><tr><th>指标</th><th>历次数值</th><th>参考</th><th></th></tr></thead>
    <tbody>${diseaseRows}</tbody>
  </table>
  <div class="foot">本页不含报告原文与影像、用药与费用明细，亦不含任何诊断或治疗意见；相关材料见同批 .meddata 交换包。异常标红仅依据报告自带状态或参考区间，骨髓/流式指标无统一参考区间故不作判定。</div>
</body></html>`

  return { meta, series, text: lines.join('\n'), html }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}
