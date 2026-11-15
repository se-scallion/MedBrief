// MedBrief → MedRecognition Adapter（M2a 切流用，2026-11-15）
//
// 设计口径（计划 §1 + 主理人拍板）：
//   · `MEDREC_BACKEND=legacy`（默认）→ 完全走老路径，本模块不参与，行为零变化
//   · `MEDREC_BACKEND=8011`        → 调 8011，再**重映射回 MedBrief 原有形状**，调用方几乎不改
//   · 服务不可用/超时 → 抛错由调用方按原逻辑兜底（**不留静默降级**，M3 要靠"0 命中"判断退役）
//   · 只做形状映射，不搬业务：查重/指纹/分组/拼接/日期 meta 全留 MedBrief 本地

const BASE = process.env.MEDREC_BASE || 'http://127.0.0.1:8011'

export const backend = () => (process.env.MEDREC_BACKEND === '8011' ? '8011' : 'legacy')
export const isService = () => backend() === '8011'

async function postJson(route, body, timeoutMs) {
  const r = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.ok === false) {
    const e = new Error(`识别服务 ${route} 失败：${j.code || r.status} ${j.error || ''}`.trim())
    e.rpc = j.code
    e.status = r.status
    throw e
  }
  return j
}

/** 服务返回的 measures[] → MedBrief 的行形状（name/originalName/code/value/num/unit/refRange/flag/status/ordinal/rawSnippet） */
export function mapMeasuresToRows(measures = []) {
  return (measures || []).map((m) => ({
    name: m.name || '',
    originalName: m.original_name || m.name || '',
    code: m.code || undefined,
    value: String(m.value ?? ''),
    num: typeof m.num === 'number' ? m.num : null,
    unit: m.unit || '',
    refRange: m.refRange ?? m.ref_range ?? '',
    // 服务已经把 flag/arrow 都给了；MedBrief 本地只用 flag
    flag: m.flag || '',
    status: m.status || 'unknown',
    ordinal: m.ordinal ?? undefined,
    // 服务不输出 rawSnippet（见 docs/schema-v1.md §6 的约定），这里用「原文名 + 值 + 单位」重组，
    // 只用于校对页展示原句，不参与任何判定
    rawSnippet: `${m.original_name || m.name || ''} ${m.value ?? ''} ${m.unit || ''}`.trim(),
  }))
}

/**
 * 图 → 行（一次调用同时拿到 OCR 文本与已解析的指标行）
 * @returns {Promise<{text:string, rows:Array, fields:object, extras:object, engine:'vision'|'service', source:'med-recognition'}>}
 */
export async function extractImage(imageDataUrl, { mode = 'report', timeoutMs = 95_000 } = {}) {
  const j = await postJson('/v1/extract', { mode, image: imageDataUrl }, timeoutMs)
  const d = j.data || {}
  return {
    text: d.raw_text || '',
    rows: mapMeasuresToRows(d.fields?.measures),
    fields: d.fields || {},
    extras: d.extras || {},
    engine: 'service',
    source: 'med-recognition',
  }
}

/** 文本 → 行（手工粘贴 / PDF 文字层 / 用户改过文本后重新解析都走这条） */
export async function extractText(text, { mode = 'report', timeoutMs = 30_000 } = {}) {
  const j = await postJson('/v1/extract', { mode, text: String(text || '') }, timeoutMs)
  const d = j.data || {}
  return {
    rows: mapMeasuresToRows(d.fields?.measures),
    fields: d.fields || {},
    extras: d.extras || {},
    source: 'med-recognition',
  }
}

/**
 * 只做 OCR（拿 blocks / 文本），用于需要自己保留版式信息（chunk/拼接）的路径。
 * @returns {Promise<{text:string, blocks:Array, averageConfidence:number|null, source:'med-recognition'}>}
 */
export async function ocrImage(imageDataUrl, { timeoutMs = 95_000 } = {}) {
  const j = await postJson('/v1/ocr', { image: imageDataUrl }, timeoutMs)
  const d = j.data || {}
  return { text: d.text || '', blocks: d.blocks || [], averageConfidence: d.average_confidence ?? null, source: 'med-recognition' }
}
