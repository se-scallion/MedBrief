// ===================== 自定义指标管理（AI 新项）=====================
// 背景：AI 精读（dsh headless）把化验报告转成 rows，前端经 normalizeGridToPoints 走
// 字典/别名理解层。本次「AI 识别出新项」需求 = 让 AI 转录出的、字典里没有的项目，
// 能被识别为「待确认新项」，经人工确认 / 报告提交后落库成可复用自定义字段。
//
// 简化决策（双向排雷后）：
//  - 已知项沿用名称反查（mapAlias，实测 CBC 24/24 锚定），不依赖 AI 出 code（M2：避免错配）。
//  - 新项完全由「前端字典查重」判定：standard_code 为空 = 字典未知 → _isNew=true（M6：不误标已知项）。
//  - 持久层在浏览器 IndexedDB（store.customFields）；AI agent 在服务端读不到，复用靠前端在
//    POST /api/ai-docread 时把 customFields 注入请求（M0 闭环，见 ocrEngines.js）。
//  - 持久化只发生在「人工确认」或「报告提交」两处（用户口径：先确认/提交再落库）。
//
// 模块化约定：本文件**顶层不 import store**（store 依赖 IndexedDB，node 单测无该环境会崩）。
// 仅 persist/confirm 这类浏览器侧动作函数内部用动态 import('../data/store.js')；
// 纯逻辑函数（slugForField / collectNewItems / markNewItems）零外部依赖，可在 node 直接测。

// 由名称 + 单位 + 参考范围生成稳定的自定义 code slug（纯本地、无依赖）。
// 仅用于「提交/确认时」为无标准 code 的项生成 custom:<slug>，命名空间隔离避免与标准 code 撞名。
export function slugForField(name = '', unit = '', ref = '') {
  // 2026-10-24 修：旧实现在「纯中文名称」下 core 为空 → 产出 `custom:-e69f90e6…`（前导连字符 +
  // 一串十六进制），既不可读也过不了 isValidCustomCode —— 这正是用户说的「代码里多出文字」。
  // 现规则：ascii 部分规整成 slug；没有可用 ascii 就用 `item` 兜底；整串再兜一次合法性。
  const base = String(name).replace(/\s+/g, '').replace(/[（）()]/g, '')
  const ascii = base.replace(/[^\x00-\x7F]/g, '')
  let core = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (core.length < 2) core = 'item'
  const seed = encodeURIComponent(`${name}|${unit}|${ref}`)
    .replace(/%/g, '')
    .slice(0, 8)
    .toLowerCase()
  const slug = `${core}-${seed}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `custom:${slug || `item-${Date.now().toString(36)}`}`
}

// 自定义 code 的规范形态：`custom:<slug>`，slug 仅允许 [a-z0-9_-]。
// 为什么要人能改：自动 slug 由 OCR 出的名称拼出来，名称里带多余文字（单位、括号、误识字符）
// 时代码会跟着脏（如 custom:item-xxxx、把「静脉血」读进代码）。代码一旦落库就是**主键**，
// 脏了以后趋势/同步/自定义字段匹配都会跟着歪 —— 所以在确认前必须让人能改。
export const CUSTOM_CODE_RE = /^custom:[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidCustomCode(code) {
  return CUSTOM_CODE_RE.test(String(code || '').trim())
}

/**
 * 把用户输入规整成合法 code：
 *  - 允许用户只填 slug（自动补 custom: 前缀）；
 *  - 大写转小写、空格与非法字符转 '-'、连续 '-' 折叠；
 *  - 中文/符号在 slug 里无法表达，直接剔除（剔完为空则返回 ''，由调用方禁用确认）。
 */
export function normalizeCustomCode(input = '') {
  let s = String(input).trim()
  if (!s) return ''
  if (!/^custom:/i.test(s)) s = `custom:${s}`
  const slug = s
    .slice(s.indexOf(':') + 1)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return ''
  return `custom:${slug.slice(0, 64)}`
}

// 标记一份识别结果里「字典未知」的项（待确认新项）。
// 入参：points（normalizeGridToPoints 产出）；customFields（浏览器侧由 getCustomFields() 注入）。
// 规则：
//  - 已有 standard_code（内置字典命中）→ 不动（M6：不误标已知项为新项）。
//  - 无 standard_code 但名称命中已确认的自定义字段 → 补 standard_code = 该 custom code，
//    不标 _isNew（M0 浏览器侧复用闭环：下次识别同类报告直接认出，不重复提示）。
//  - 其余字典未知项 → _isNew=true（待人工确认 / 提交落库）。
export function markNewItems(points, customFields = {}) {
  if (!Array.isArray(points)) return points
  const byName = new Map(
    Object.values(customFields || {}).map((c) => [String(c.name).trim().toUpperCase(), c]),
  )
  return points.map((p) => {
    if (p.standard_code) return p
    const name = String(p.original_name || p.abbr || '').trim().toUpperCase()
    if (!name) return p
    const hit = byName.get(name)
    if (hit) {
      return { ...p, standard_code: hit.code, _customMatched: true }
    }
    return { ...p, _isNew: true }
  })
}

// 收集一份已标记结果里待确认的新项（去重：按 name 聚合，保留首个 unit/ref）。
export function collectNewItems(points) {
  const seen = new Map()
  for (const p of points || []) {
    if (!p._isNew) continue
    const name = (p.original_name || p.abbr || '').trim()
    if (!name) continue
    if (!seen.has(name)) {
      seen.set(name, {
        name,
        unit: p.unit || '',
        ref: p.ref_range || '',
        value: p.value || '',
      })
    }
  }
  return [...seen.values()]
}

// 把确认/提交时仍标记为 _isNew 的项落库为自定义字段（浏览器侧）。
// 入参：points（含 _isNew）、autoConfirm（true=提交时一次性全部入库）。
// 返回成功落库的 code 列表。已知项（有 standard_code）/ 已存在同名 custom 项不入库。
export async function persistNewItems(points, { autoConfirm = false, overrides = {} } = {}) {
  if (!autoConfirm) return [] // 仅提交时走此处；人工确认由 confirmNewItem 单独落库
  const { addCustomField, getCustomFields } = await import('../data/store.js')
  const custom = getCustomFields()
  const persisted = []
  for (const p of points || []) {
    if (!p._isNew) continue
    const rawName = (p.original_name || p.abbr || '').trim()
    if (!rawName) continue
    // 用户在「待确认新项」面板改过的 code / 名称优先（overrides 以**识别出的原名**为键）
    const ov = overrides[rawName] || {}
    const name = String(ov.name || rawName).trim()
    const already = Object.values(custom).some(
      (c) => c.name === name && String(c.code).startsWith('custom:'),
    )
    if (already) continue
    const code = isValidCustomCode(ov.code) ? ov.code : slugForField(name, p.unit || '', p.ref_range || '')
    addCustomField({ code, name, unit: p.unit || '', ref: p.ref_range || '' })
    persisted.push(code)
  }
  return persisted
}

// 人工在「待确认新项」面板确认单条：直接落库（浏览器侧）。
export async function confirmNewItem({ name, unit = '', ref = '', code: inputCode = '' }) {
  if (!name || !name.trim()) return null
  const { addCustomField } = await import('../data/store.js')
  // 人工给的合法 code 优先；否则按名称自动生成。落库 code 永远是 `custom:` 命名空间内。
  const code = isValidCustomCode(inputCode) ? String(inputCode).trim() : slugForField(name.trim(), unit, ref)
  addCustomField({ code, name: name.trim(), unit, ref })
  return code
}
