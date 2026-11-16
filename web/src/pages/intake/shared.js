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

// 第 3 个参数 method 只给「更新原报告」的 PUT 用；不传仍是 POST（所有既有调用零改动）
export const postJson = (path, data, method = 'POST') =>
  rawJson(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
    })         // postJson 结尾

/**
 * 报告行修正的提交载荷（2026-11-14 用户报的坑，务必整行回写）。
 *
 * 事故：三列左移的存储行 `{name:"凝血酶原时间（P12.2个T）", value:"9.8-12.1", refRange:"sec"}`
 * 由 labClean 在读侧还原成 `PT / 12.2 / sec / 参考 9.8-12.1`。若前端「修正数值」**只提交 value**：
 *   → 存储变成 `{value:"12.2", refRange:"sec"}`，左移还原不再触发（判据是「value 像区间」），
 *     真参考区间 9.8-12.1 在存储里本来就只存在于 value 里 → **永久丢失**（实测确认）。
 * 所以：一律提交 name / value / unit / refRange 四元组，初值取**清洗后视图**（?normalized=1），
 * 等于把读侧修复结果固化入库，`repaired` 清空、后续不再依赖还原逻辑。
 *
 * @param {Array<{name?,value?,unit?,refRange?}>} rows 清洗后视图里的行（顺序即报告内下标）
 * @returns {Array<{index:number,name:string,value:string,unit:string,refRange:string}>}
 */
export function buildRowPatch(rows = []) {
  return (rows || []).map((r, index) => ({
    index,
    name: String(r.name ?? '').trim(),
    value: String(r.value ?? '').trim(),
    unit: String(r.unit ?? '').trim(),
    refRange: String(r.refRange ?? '').trim(),
  }))
}

/**
 * 串行批量执行（2026-11-15 从 IntakePage 抽成纯函数，便于单测）：
 * 「一键识别 / 一键导入」都是这个模型 —— 逐条执行、可随时停、单条失败不中断整批、可统计重复跳过。
 *
 * @param {Array} items
 * @param {(item:any)=>Promise<any>} worker  返回 { ok?:boolean, duplicate?:boolean, skipped?:boolean }
 * @param {{onProgress?:(done:number,total:number)=>void, shouldStop?:()=>boolean}} opts
 * @returns {Promise<{stopped:boolean, done:number, total:number, ok:number, skipped:number, failed:number}>}
 */
export async function runBatch(items = [], worker, { onProgress, shouldStop } = {}) {
  const total = items.length
  const res = { stopped: false, done: 0, total, ok: 0, skipped: 0, failed: 0 }
  for (let i = 0; i < total; i++) {
    if (shouldStop && shouldStop()) { res.stopped = true; res.done = i; return res }
    if (onProgress) onProgress(i, total)
    try {
      const r = await worker(items[i])
      if (r?.duplicate || r?.skipped) res.skipped += 1
      else if (r?.ok === false) res.failed += 1
      else res.ok += 1
    } catch {
      res.failed += 1
    }
    res.done = i + 1
  }
  if (onProgress) onProgress(total, total)
  return res
}
