// 值类型签名反查项目（2026-11-15 用户选定「C 方案」）
//
// 用途：OCR 把「项目名」那一栏认坏/认空时（血常规那种只有数值+参考区间、名字列糊了的报告），
//      用**纯数据驱动**的签名（单位 + 参考区间形态）去反查「这行可能是哪个项目」，给**候选**，
//      由用户点一下确认。
//
// 三条红线（必须遵守，否则就是拿病人的检验结果开玩笑）：
//   1. **只给候选，绝不自动改名** —— 名字是报告原文，改错了整行结果就挂到别的项目上；
//   2. **不猜值、不猜参考区间、不猜单位** —— 本模块只回答「这行可能是哪个项目」，不产生任何新数值；
//   3. 依据只来自**本机已有报告**（同一份数据里出现过的 项目→单位/参考区间 组合），
//      不是从外部知识库硬编码的医学常识；因此新项目第一次出现时可能没有任何候选，这是预期行为。
//
// 与 MedData 的关系：MedData 的 normalize.js 里是「值类型签名 + 序号锚定 + LLM 语义推断」的整套实现；
// 这里只搬其中最保守的一层 —— 单位/参考区间形态匹配（确定性、可解释、可复跑）。

const norm = (s) => String(s || '')
  .replace(/\s+/g, '').toLowerCase()
  .replace(/[~]/g, '^')   // 10~9/L 与 10^9/L 视为同一单位
  .replace(/[–—−]/g, '-')  // 各种破折号统一
  .replace(/[（）]/g, (c) => (c === '（' ? '(' : ')'))

/** 一行是否「名字缺失或明显不可用」（只有这时才给候选） */
export function nameLooksUnusable(name) {
  const n = String(name || '').trim()
  if (!n) return true
  if (n.length <= 1) return true
  if (/^[\d.\-+/%()（）]+$/.test(n)) return true          // 纯数字/符号
  if (/^[a-zA-Z]{1,3}$/.test(n)) return true              // 一两个字母的残片
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(n)) return true
  return false
}

/**
 * 从已有报告建立「单位 + 参考区间 → 候选项目」索引。
 * @param {Array} reports 已入库报告（含 rows[]）
 * @returns {{byKey: Map<string, Map<string, {code,name,count}>>, size: number}}
 */
export function buildSignatureIndex(reports = []) {
  const byKey = new Map()
  // 注意：库里的行**大多数不存 code**（code 是读侧按 ANALYTE_CATALOG 注入的，203 行里只有 6 行直接带 code），
  // 所以索引以**项目名**为主键：反查出来的是「这个名字」，采用后读侧自然会给它配上 code。
  const bump = (key, name, code) => {
    const nm = String(name || '').trim()
    if (!key || !nm) return
    if (!byKey.has(key)) byKey.set(key, new Map())
    const m = byKey.get(key)
    const cur = m.get(nm) || { name: nm, code: String(code || ''), count: 0 }
    cur.count += 1
    if (!cur.code && code) cur.code = String(code)
    m.set(nm, cur)
  }
  for (const r of reports || []) {
    for (const row of (Array.isArray(r?.rows) ? r.rows : [])) {
      const code = String(row?.code || '').trim()
      const u = norm(row?.unit)
      const ref = norm(row?.refRange)
      if (!u && !ref) continue
      bump(`${u}|${ref}`, row?.name, code)
    }
  }
  return { byKey, size: byKey.size }
}

/**
 * 给一行「名字不可用」的结果猜项目候选。
 * @param {{unit?:string, refRange?:string, value?:string, name?:string}} row
 * @param {ReturnType<typeof buildSignatureIndex>} index
 * @param {{max?:number}} opts
 * @returns {Array<{code:string,name:string,score:number,why:string}>}
 */
export function suggestBySignature(row = {}, index, { max = 3 } = {}) {
  if (!index?.byKey?.size) return []
  if (!nameLooksUnusable(row?.name)) return []
  const u = norm(row?.unit)
  const ref = norm(row?.refRange)
  if (!u && !ref) return []
  const out = []
  const pushMap = (m, why, weight) => {
    if (!m) return
    for (const c of m.values()) out.push({ code: c.code, name: c.name, score: c.count * weight, why })
  }
  // ① 单位与参考区间都相同 —— 最可信
  pushMap(index.byKey.get(`${u}|${ref}`), '单位+参考区间都一致', 3)
  // ② 只有参考区间一致（单位栏常被 OCR 吃掉）：按 `|ref` 后缀扫
  if (ref) {
    for (const [k, m] of index.byKey) if (k.endsWith(`|${ref}`)) pushMap(m, '参考区间一致', 2)
  }
  // ③ 只有单位一致 —— 最弱，仅当作兜底
  if (u) {
    for (const [k, m] of index.byKey) if (k.startsWith(`${u}|`)) pushMap(m, '仅单位一致', 1)
  }
  // 去重 + 排序
  const seen = new Map()
  for (const c of out) {
    const cur = seen.get(c.name)
    if (!cur || c.score > cur.score) seen.set(c.name, c)
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, max)
}
