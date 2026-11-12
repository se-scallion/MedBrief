// ===================== 近期指标聚合（纯函数） =====================
// 契约：把 MedData 的 state（records / diseaseMetrics / docs）归一成「最新值」视图。
//   1. summarizeState(state): 纯函数，无 I/O，可在浏览器、Node、服务端共用。
//   2. 取值口径（唯一实现，改动须同步 INTERFACE.md 通道 2 的字段表）：
//      - 化验指标：按 records[].date 倒序取「最新非空值」；同一天多份取 created_at 更晚的那份。
//      - 疾病指标：按 diseaseMetrics[].date 倒序取每个 code 的最新值；value 为 null 视为未测，跳过。
//      - 数值一律转成 number（保留原始字符串），非数字（如 "<0.01"）保留原串并置 numeric:false。
//   3. 不返回姓名、身份证、手机号等身份字段 —— 摘要只用于填「近期指标」，身份由 .meddata 包另带。

// 要进摘要的化验指标（键 = MedData 的 standard_code，实测库中血红蛋白是 Hb 不是 HGB）
export const LAB_CODES = ['WBC', 'PLT', 'Hb', 'RBC', 'NEUT_ABS', 'LYM_ABS', 'HS_CRP']

export const LAB_LABELS = {
  WBC: '白细胞',
  PLT: '血小板',
  Hb: '血红蛋白',
  RBC: '红细胞',
  NEUT_ABS: '中性粒细胞绝对值',
  LYM_ABS: '淋巴细胞绝对值',
  HS_CRP: '超敏C反应蛋白',
}

// 常见写法 → 库内标准 code（供调用方查别名，避免"文档写 HGB、库里叫 Hb"这类漂移）
export const LAB_CODE_ALIASES = {
  HGB: 'Hb',
  HB: 'Hb',
  HEMOGLOBIN: 'Hb',
  PLATELET: 'PLT',
  LEUKOCYTE: 'WBC',
}

// 要进摘要的疾病指标（diseaseMetrics.code）
export const DISEASE_CODES = ['BM_BLAST_PCT', 'FCM_MRD_PCT', 'BCR_ABL1_RATIO']

export const DISEASE_LABELS = {
  BM_BLAST_PCT: '骨髓原始细胞比例',
  FCM_MRD_PCT: '流式 MRD',
  BCR_ABL1_RATIO: 'BCR-ABL1 转录本',
}

function toNumber(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { numeric: false, num: null }
  const cleaned = s.replace(/[,，\s]/g, '').replace(/^[<>≤≥]/, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? { numeric: true, num: n } : { numeric: false, num: null }
}

function laterThan(a, b) {
  // a 是否比 b 更「新」：先比 date，再比 created_at（缺失按最旧处理）
  const d = String(a.date || '').localeCompare(String(b.date || ''))
  if (d !== 0) return d > 0
  return String(a.created_at || '').localeCompare(String(b.created_at || '')) > 0
}

/**
 * 聚合近期指标
 * @param {object} state MedData state（records / diseaseMetrics / docs / events 任意缺失均可）
 * @param {object} options { labCodes, diseaseCodes }
 * @returns {object} { ok, latest, aliases, counts }
 */
export function summarizeState(state = {}, options = {}) {
  const labCodes = Array.isArray(options.labCodes) && options.labCodes.length ? options.labCodes : LAB_CODES
  const diseaseCodes =
    Array.isArray(options.diseaseCodes) && options.diseaseCodes.length ? options.diseaseCodes : DISEASE_CODES

  const records = Array.isArray(state.records) ? state.records : []
  const metrics = Array.isArray(state.diseaseMetrics) ? state.diseaseMetrics : []
  const docs = Array.isArray(state.docs) ? state.docs : []
  const events = Array.isArray(state.events) ? state.events : []

  const latest = {}

  // ---- 化验指标：遍历所有 record 的 data_points，按日期取最新 ----
  for (const rec of records) {
    const points = Array.isArray(rec.data_points) ? rec.data_points : []
    for (const dp of points) {
      const code = dp.standard_code
      if (!labCodes.includes(code)) continue
      const rawValue = dp.value
      if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') continue
      const candidate = {
        code,
        label: LAB_LABELS[code] || dp.original_name || code,
        value: String(rawValue).trim(),
        unit: dp.unit || '',
        date: rec.date || '',
        createdAt: rec.created_at || '',
        created_at: rec.created_at || '',
        reportType: rec.report_type || '',
        status: dp.status || '',
        refRange: dp.ref_range || '',
      }
      const prev = latest[code]
      if (!prev || laterThan(candidate, prev)) latest[code] = candidate
    }
  }

  // ---- 疾病指标：按 code 取最新一次有值的记录 ----
  for (const m of metrics) {
    const code = m.code
    if (!diseaseCodes.includes(code)) continue
    if (m.value === null || m.value === undefined || String(m.value).trim() === '') continue
    const candidate = {
      code,
      label: DISEASE_LABELS[code] || code,
      value: String(m.value).trim(),
      unit: m.unit || '',
      date: m.date || '',
      createdAt: m.created_at || '',
      created_at: m.created_at || '',
      stream: m.stream || '',
      analyte: m.analyte || '',
      qualifier: m.qualifier || 'eq',
    }
    const prev = latest[code]
    if (!prev || laterThan(candidate, prev)) latest[code] = candidate
  }

  // 补数值解析（numeric/num），保持 value 原样
  for (const item of Object.values(latest)) {
    const { numeric, num } = toNumber(item.value)
    item.numeric = numeric
    item.num = num
  }

  return {
    ok: true,
    latest,
    aliases: { ...LAB_CODE_ALIASES },
    counts: {
      records: records.length,
      docs: docs.length,
      events: events.length,
      diseaseMetrics: metrics.length,
    },
  }
}

/**
 * 把摘要渲染成一段可直接塞进「近期指标」文本框的中文
 * @param {object} summary summarizeState 的返回
 * @returns {string}
 */
export function formatSummaryText(summary = {}) {
  const latest = summary.latest || {}
  const order = [...LAB_CODES, ...DISEASE_CODES]
  const lines = []
  for (const code of order) {
    const item = latest[code]
    if (!item) continue
    const date = item.date ? `${item.date} ` : ''
    const unit = item.unit ? ` ${item.unit}` : ''
    lines.push(`${date}${item.label} ${item.value}${unit}`.trim())
  }
  return lines.join('\n')
}
