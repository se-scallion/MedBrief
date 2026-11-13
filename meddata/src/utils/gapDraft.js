// ===================== 识别缺口 → 补丁草稿（纯函数，可单测）=====================
//
// 目的（零隔离版第 2 步）：把「这份报告有 N 项字典不认识」变成一份**可直接粘贴的补丁草稿**，
// 让"加字段"从"翻代码找位置"降为"看一眼 → 点应用"。
//
// 三条纪律（都来自实际踩过的坑）：
//  1. **只提议、不落盘**：草稿永远是给人看的，绝不自动应用（草稿里的 code 是占位符 TBD1…）。
//  2. **名称必须可读才算缺口**：OCR 乱码（`人 本 和`、`全 作 个 人`、质量分 0% 那种）
//     不是字典缺口，是图不清楚（265141 流式乱码样本实测 19/23 未映射全是碎片）。
//     乱码进草稿只会污染字典，所以这里用"中文占比 + 长度 + 段落词前缀"三重过滤。
//  3. **段落词不是指标**：`备注 / 印象 / 结论 / 建议 / 诊断` 这类是报告段落抬头，
//     被 OCR 当成项目名（实测 `备注：` 会以 1 行 points 出现），必须排除。
//
// 与 customFieldManager 的关系：那边负责"用户确认后落成 custom: 字段"（浏览器侧、进库），
// 这边负责"要不要改字典"（算法侧、进补丁）。两者不互相替代：custom 是临时兜底，字典才是长期口径。

/** 段落抬头 / 元信息词：出现即不是指标名 */
const SECTION_PREFIX = /^(备注|印象|结论|建议|提示|分析|诊断|检查所?见|影像所?见|镜下所?见|检验者|审核|报告|地址|电话|第\s*\d+\s*页|注\s*[:：]|见\s*[:：])/

/** 纯数字 / 编号类噪声（如 `265141`、`2026-08-17`） */
const PURE_CODE = /^[\d\s\-./:]+$/

const strikeSpace = (s) => String(s || '').replace(/\s+/g, '')

/** 中文（含全角标点视为装饰）占比 */
function cjkRatio(s) {
  const str = strikeSpace(s)
  if (!str) return 0
  const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk / str.length
}

/**
 * 这个名字像不像一个真实检验/检查项目名？
 *
 * 判据（四道，按成本从低到高）：
 *  1. 长度 2–24（去空格后），排除纯编号/日期（`265141`、`2026-08-17`）；
 *  2. 不以段落抬头开头（`备注：`/`印象`/`结论`…）；
 *  3. **碎片检测**：OCR 乱码的典型形态是「单字 + 空格」拼接（实测 265141：
 *     `人 本 和`、`全 作 个 人`、`本 四 人`）。真实项目名不会在词内切空格，
 *     故要求「按空格切出的片段里，≥60% 的片段有效长度 ≥2」。
 *  4. 中文占比 ≥0.6，或含 ≥2 个拉丁字母（`NT-proBNP`/`CD19` 这类）。
 */
export function isReadableName(name) {
  const raw = String(name || '').trim()
  if (!raw || raw.length > 24) return false
  const s = strikeSpace(raw)
  if (s.length < 2) return false
  if (PURE_CODE.test(s)) return false
  if (SECTION_PREFIX.test(s)) return false

  // 片段完整性：单字碎片拼接 = OCR 乱码
  const chunks = raw.split(/\s+/).filter(Boolean)
  if (chunks.length > 1) {
    const solid = chunks.filter((c) => c.replace(/[^\w\u4e00-\u9fff]/g, '').length >= 2)
    if (solid.length / chunks.length < 0.6) return false
  }

  if (cjkRatio(s) >= 0.6) return true
  return (s.match(/[A-Za-z]/g) || []).length >= 2
}

/**
 * 从识别结果里收集"可读的未映射项"。
 * @param {any[]} points normalizeGridToPoints 的产物（可带 _isNew 标记）
 * @param {{ minCount?: number }} opts minCount：达到几项才算一次缺口（默认 2）
 * @returns {{ count:number, items:Array<{name:string,unit:string,ref:string,value:string}> , readableRatio:number }}
 */
export function collectGaps(points, { minCount = 2 } = {}) {
  const list = Array.isArray(points) ? points : []
  const unmapped = list.filter((p) => !String(p && (p.standard_code || p.code) || '').trim())
  const seen = new Map()
  for (const p of unmapped) {
    const name = String(p.original_name || p.name || p.abbr || '').trim()
    if (!isReadableName(name)) continue
    const key = strikeSpace(name).toUpperCase()
    if (seen.has(key)) continue
    seen.set(key, {
      name,
      unit: String(p.unit || '').trim(),
      ref: String(p.ref_range || p.ref || '').trim(),
      value: String(p.value == null ? '' : p.value).trim(),
    })
  }
  const items = [...seen.values()]
  return {
    count: items.length,
    items,
    readableRatio: unmapped.length ? items.length / unmapped.length : 0,
    meetsThreshold: items.length >= minCount,
  }
}

/** 占位 code：草稿里一律 TBD1/TBD2…，逼人改成有意义的缩写后再应用 */
function placeholderCode(i, name) {
  const ascii = String(name || '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toUpperCase()
  if (ascii.length >= 2 && ascii.length <= 12) return ascii
  return `TBD${i + 1}`
}

/**
 * 生成补丁草稿（可直接粘贴进设置页「识别补丁」输入框）。
 * 只产出 `fields`（新增字段）；**不碰别名/合并**——"这个名字其实等于已有字段"需要人判断，
 * 与 ORC-optimize §5.3「先判定新增独立字段 vs 并入已有字段」的纪律一致。
 *
 * @param {{ items:any[] }} gaps collectGaps 的返回值
 * @param {{ reportType?:string, traceId?:string }} ctx
 * @returns {null | { id:string, note:string, fields:any[] }}
 */
export function buildDraftPatch(gaps, { reportType = '', traceId = '' } = {}) {
  const items = Array.isArray(gaps && gaps.items) ? gaps.items : []
  if (!items.length) return null
  const fields = items.map((g, i) => ({
    code: placeholderCode(i, g.name),
    name: g.name,
    unit: g.unit || '',
    ref: g.ref || '',
    group: reportType || '',
  }))
  const id = `opt-${traceId || 'manual'}-${items.length}`
  return {
    id,
    note:
      `草稿（${reportType || '未知类型'}，${items.length} 项）：` +
      '请先把 code 改成有意义的缩写、核对 name/unit/ref；' +
      '若某项其实是已有字段的另一种写法，改去补别名而不是新增字段。',
    fields,
  }
}

/** 草稿转成可直接粘贴的 JSON 文本（设置页按钮用） */
export function draftPatchText(gaps, ctx) {
  const patch = buildDraftPatch(gaps, ctx)
  if (!patch) return ''
  return JSON.stringify(patch, null, 2)
}
