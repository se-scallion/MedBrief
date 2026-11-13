// 资料导入页的模块级常量与工具（2026-11-13 抽页时从 IntakePage.jsx 原样搬出）
// 唯一登记处：改 ST / KIND_OPTIONS / FLAG_TEXT 会影响上传、校对、档案、报告列表四处。

// 状态机：待识别 → 识别中 → 已识别 / 未识别 / 疑似重复
export const ST = {
  pending: { label: '待识别', color: 'default' },
  ocr: { label: '识别中', color: 'processing' },
  done: { label: '已识别', color: 'green' },
  failed: { label: '未识别', color: 'red' },
  dup: { label: '疑似重复', color: 'orange' },
}

export const KIND_OPTIONS = [
  { value: 'lab', label: '化验单' },
  { value: 'pathology', label: '病理 / 骨穿' },
  { value: 'imaging', label: '影像' },
  { value: 'discharge', label: '出院小结' },
  { value: 'drug', label: '处方 / 用药' },
  { value: 'unknown', label: '不确定' },
]

export const FLAG_TEXT = { high: '偏高 ↑', low: '偏低 ↓', normal: '正常', positive: '阳性', negative: '阴性' }

export function uid() {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export function fmtSize(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 裸 fetch：/api/intake/* 用「HTTP 200 + ok:false」表达「重复 / 未识别 / 上游不可用」，不能当成异常抛掉。 */
export async function rawJson(path, opts = {}) {
  const res = await fetch(path, opts)
  const body = await res.json().catch(() => ({}))
  return { httpStatus: res.status, body }
}

export const postJson = (path, data) =>
  rawJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
    })         // postJson 结尾
