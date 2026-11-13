// ===================== 粘贴文本 → 数据点解析 =====================
// 用户从 PDF/网页/图片查看器复制化验单表格文本（Ctrl+C），本模块尝试还原为结构化数据点。
//
// 支持的复制格式（按可靠性排序）：
//   A. 行格式（推荐）：每行一条完整记录「序号? 项目名 缩写 结果 单位 参考区间」
//      例：12红细胞 RBC 1.33 10^12/L 4.3-5.8
//      得到方式：在 PDF/网页中「框选整个表格区域」（从左上角拖到右下角）后复制。
//   B. 列块格式：项目名 / 缩写 / 结果 / 单位 / 参考区间 各成一整块堆叠（PDF 按列复制的产物）
//   C. 兜底：整行当作原始项目名，其余字段留空，交由用户在校对网格手动补全。

import { mapAlias, FIELD_BY_CODE } from '../data/dictionary.js'
import { computeStatus, normalizeUnit } from './normalize.js'

// 行格式：序号? 中文名 缩写 值 [箭头] 单位 参考区间
const ROW_RE =
  /^\s*(?:(\d{1,2})\s*)?([\u4e00-\u9fa5·]{2,15})\s+([A-Za-z][A-Za-z0-9#%^\-]{1,10})\s+([<>]?\d+(?:\.\d+)?)\s*([↑↓]?)\s+([^\s]+)\s+([<>]?\d+(?:\.\d+)?)\s*[-~—]\s*([<>]?\d+(?:\.\d+)?)\s*$/

// 兜底行：行内含中文项目名（无缩写/值/单位时用）
const NAME_ONLY_RE = /([\u4e00-\u9fa5·]{2,15})/

// 参考区间：数字-数字（如 4.3-5.8、0-0.06）
const REF_RE = /^([<>]?\d+(?:\.\d+)?)\s*[-~—]\s*([<>]?\d+(?:\.\d+)?)$/

function buildPoint(name, abbr, value, unit, ref, arrow, row) {
  const code = mapAlias(abbr) || mapAlias(name) || ''
  const f = FIELD_BY_CODE[code]
  return {
    standard_code: code,
    original_name: name || abbr,
    abbr: abbr || '',
    value: value || '',
    unit: normalizeUnit(unit) || (f ? f.unit : ''),
    ref_range: ref || (f ? f.ref : ''),
    arrow: /↓/.test(arrow) ? '↓' : /↑/.test(arrow) ? '↑' : '',
    status: 'NORMAL',
    _row: row,
  }
}

// 行格式解析：每行一条完整记录
function parseRowFormat(rawLines) {
  const points = []
  const leftover = []
  let row = 0
  for (const raw of rawLines) {
    const line = String(raw || '').trim()
    if (!line) continue
    const m = line.match(ROW_RE)
    if (m) {
      const [, , name, abbr, value, arrow, unit, refLow, refHigh] = m
      points.push(buildPoint(name, abbr, value, unit, refLow && refHigh ? `${refLow}-${refHigh}` : '', arrow, row))
      row++
    } else {
      leftover.push(line)
    }
  }
  return { points, leftover }
}

// 列块格式解析：名称/缩写/结果/单位/参考 各成一整块，按列序 zip
function classifyLine(s) {
  if (/[\u4e00-\u9fa5]/.test(s)) return 'name' // 含中文 → 项目名
  if (/^\d+(?:\.\d+)?$/.test(s)) return 'value' // 纯数字 → 结果
  if (REF_RE.test(s)) return 'ref' // 数字-数字 → 参考区间
  if (/^[A-Za-z][A-Za-z0-9#%^\-]*$/.test(s)) return 'abbr' // 纯英文缩写
  if (/[\^/%]|L$|fL|pg/.test(s)) return 'unit' // 单位（10^9/L、%、fL、pg）
  return null
}

function parseColumnFormat(rawLines) {
  // 按行分类，识别连续同类块
  const blocks = []
  for (const raw of rawLines) {
    const line = String(raw || '').trim()
    if (!line) continue
    const type = classifyLine(line)
    if (!type) continue
    const last = blocks[blocks.length - 1]
    if (last && last.type === type) last.lines.push(line)
    else blocks.push({ type, lines: [line] })
  }
  // 双栏交错（出现多个 name 块）→ 无法可靠对齐，放弃
  const nameBlocks = blocks.filter((b) => b.type === 'name')
  if (nameBlocks.length !== 1) return { points: [], leftover: [] }

  // 期望列序：name → abbr → value → unit → ref（缺列跳过）
  const order = ['name', 'abbr', 'value', 'unit', 'ref']
  let bi = blocks.findIndex((b) => b.type === 'name')
  const cols = []
  for (const t of order) {
    if (bi >= blocks.length) break
    if (blocks[bi].type === t) {
      cols.push(blocks[bi].lines)
      bi++
    } else {
      cols.push(null)
    }
  }
  const maxLen = Math.max(...cols.filter(Boolean).map((c) => c.length))
  const points = []
  for (let i = 0; i < maxLen; i++) {
    const name = cols[0]?.[i] || ''
    const abbr = cols[1]?.[i] || ''
    const value = cols[2]?.[i] || ''
    const unit = cols[3]?.[i] || ''
    const ref = cols[4]?.[i] || ''
    if (!name && !abbr && !value) continue
    points.push(buildPoint(name, abbr, value, unit, ref, '', points.length))
  }
  return { points, leftover: [] }
}

// ===================== 散乱字段解析（单指标多行/单行，用于网格内快速录入） =====================
// 用户在「校对网格 → 解析输入」粘贴一个指标散乱在各行的字段，例如：
//   NEUT%
//   12.1↓ %
//   40-75
//   2 中性细胞比率
// 或单行：PLT 8 125-350 20 血小板
// 按「空行」分隔可一次解析多个指标。

// 常见单位（归一化用）
// 注：mg/dL、g/dL、ug/mL 为纤维蛋白原/血脂/激素类常见写法（如「Fbg 263.2 mg/dL 200-400」），
// 缺了它们解析会把单位整个丢掉（该 token 既不匹配缩写规则也不匹配单位规则）。
const UNIT_RE =
  /^(10\^?9\/L|10\^?12\/L|10\^?3\/L|10\^?6\/L|10~?9\/L|10~?12\/L|g\/L|mg\/L|mg\/dL|g\/dL|ng\/dL|mmol\/L|umol\/L|μmol\/L|U\/L|mIU\/L|ng\/mL|ug\/L|μg\/L|ug\/mL|μg\/mL|fL|pg|%|个\/L|L\/L|s|min)$/

// 解析单个指标的散乱字段 → 数据点（可能缺少部分字段）
function parseOneScattered(text) {
  // 预处理：先把换行符换成占位符，避免「箭头+数字」合并误跨行（如 ↑\n10^9/L）
  let s = String(text || '')
    .trim()
    .replace(/\n/g, '\u0000')
    // 合并「数字 箭头」「箭头 数字」「数字 - 数字」之间的空格（仅限同行，占位符阻断）
    .replace(/(\d+(?:\.\d+)?)\s*([↓↑])/g, '$1$2')
    .replace(/([↓↑])\s*(\d+(?:\.\d+)?)/g, '$1$2')
    .replace(/(\d+(?:\.\d+)?)\s*[-~—]{1,2}\s*(\d+(?:\.\d+)?)/g, '$1-$2')
    .replace(/10[°"'‘’`′″ʺ˝*×·~↑↓]?([0-9]{1,3})\/L/g, '10^$1/L')
    .replace(/10([⁰¹²³⁴⁵⁶⁷⁸⁹])\/L/g, (_, c) => `10^${'⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)}/L`)
    .replace(/\u0000/g, '\n')
  const tokens = s.match(/[^\s]+/g) || []
  let name = ''
  let abbr = ''
  let value = ''
  let unit = ''
  let ref = ''
  let arrow = ''
  const numCands = [] // { v, isInt, nearName }
  const abbrCands = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // 含中文 → 项目名（多个中文块拼接）
    if (/[\u4e00-\u9fa5·]/.test(t)) {
      let rest = t
      // 前缀粘连单位（如「umol/L★肌酐…」）：剥离为 unit，避免单位丢失且污染项目名
      const uM = rest.match(/^([A-Za-z0-9^%°·~\/]+?)\s*([★\u4e00-\u9fa5（(])/)
      if (uM && UNIT_RE.test(uM[1])) {
        unit = normalizeUnit(uM[1])
        rest = rest.slice(uM[1].length)
      }
      // OCR 常把「项目名+数值」粘连成一个 token（如「★肌酉(酶法)(CREA,酶法)93.4」），
      // 若整体当名称，尾部数值会丢失导致解析不出结果值；拆出尾部数字作为候选值。
      // 可能粘连三种形态，按精确到宽松尝试：
      //   a) 值 + 参考区间连写（如「阴离子间隙(AG)8.40.0-14.0」= 8.4 + 0.0-14.0）
      //   b) 值 + 参考区间，值后带符号箭头（如「8.4↑0.0-14.0」）
      //   c) 仅尾部单个数字当候选值（原有逻辑）
      const rM = rest.match(/^(.*?)(\d+(?:\.\d+)?)([↓↑]?)(\d+(?:\.\d+)?[-~—]\d+(?:\.\d+)?)$/)
      if (rM && rM[1] && /[\u4e00-\u9fa5·]/.test(rM[1]) && rM[2] && rM[4]) {
        // 确认「值+参考」无缝拼接回原串（防误切），如 8.4 + 0.0-14.0 = 8.40.0-14.0
        const glued = `${rM[2]}${rM[3]}${rM[4]}`
        if (rest.endsWith(glued)) {
          name += rM[1]
          numCands.push({ v: rM[2], isInt: !rM[2].includes('.'), nearName: false })
          ref = rM[4]
          if (rM[3]) arrow = rM[3]
          continue
        }
      }
      // 仅「项目名+参考区间」粘连（无值），如「阴离子间隙(AG)0.0-14.0」→ 剥离参考区间
      const refM = rest.match(/^(.*?)(\d+(?:\.\d+)?[-~—]\d+(?:\.\d+)?)$/)
      if (refM && refM[1] && /[\u4e00-\u9fa5·]/.test(refM[1]) && refM[2]) {
        name += refM[1]
        ref = refM[2]
        continue
      }
      const m = rest.match(/^(.*?)(\d+(?:\.\d*)?)$/)
      if (m && m[1] && m[2] && /[\u4e00-\u9fa5·]/.test(m[1])) {
        name += m[1]
        numCands.push({ v: m[2], isInt: !m[2].includes('.'), nearName: false })
        continue
      }
      name += rest
      continue
    }
    // 是否紧邻中文（判断孤立整数是否为「序号」）
    const prevCJK = i > 0 && /[\u4e00-\u9fa5·]/.test(tokens[i - 1])
    const nextCJK = i < tokens.length - 1 && /[\u4e00-\u9fa5·]/.test(tokens[i + 1])
    const nearName = prevCJK || nextCJK
    let m
    if ((m = t.match(/^(\d+(?:\.\d+)?)([↓↑])$/))) {
      value = m[1]
      arrow = m[2]
      continue
    }
    if ((m = t.match(/^([↓↑])(\d+(?:\.\d+)?)$/))) {
      value = m[2]
      arrow = m[1]
      continue
    }
    if ((m = t.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/))) {
      ref = t
      continue
    }
    if ((m = t.match(/^(\d+(?:\.\d+)?)$/))) {
      numCands.push({ v: m[1], isInt: !m[1].includes('.'), nearName })
      continue
    }
    if (UNIT_RE.test(t)) {
      unit = normalizeUnit(t)
      continue
    }
    if (/^[A-Za-z][A-Za-z0-9#%^\-]*$/.test(t)) {
      abbrCands.push(t)
      continue
    }
    if (/^[↓↑]$/.test(t)) {
      arrow = t
      continue
    }
  }
  // 数字候选消歧：
  //   · 仅一个候选且尚无值 → 必为结果值（即使紧邻中文，如「★谷草转氨酯(AST) 11」= AST=11，
  //     此时 11 是值而非序号，否则解析不出结果）
  //   · 多个候选：带小数 → 值；整数且紧邻中文（已有名称）→ 序号；否则为值
  const hasName = name.length > 0
  if (numCands.length === 1) {
    if (!value) value = numCands[0].v
  } else {
    for (const c of numCands) {
      if (value) continue // 已有值 → 其余视为序号
      if (!c.isInt) {
        value = c.v
      } else if (c.nearName && hasName) {
        // 序号，忽略
      } else {
        value = c.v
      }
    }
  }
  abbr = abbrCands[0] || ''
  return buildPoint(name, abbr, value, unit, ref, arrow, 0)
}

// 统一入口：散乱文本 → 数据点数组（按空行分隔多指标）
export function parseScatteredText(text) {
  if (!text || !text.trim()) return []
  const groups = String(text)
    .split(/\n\s*\n/)
    .map((g) => g.trim())
    .filter(Boolean)
  const points = groups.map(parseOneScattered)
  return points.map((p) => ({
    ...p,
    status: computeStatus(p.standard_code, p.value, p.ref_range, p.arrow, p.unit),
  }))
}

// 统一入口：text → 数据点数组
export function parsePastedText(text) {
  if (!text || !text.trim()) return []
  const rawLines = String(text).split(/\r?\n/)
  // 剔除页眉/页脚/患者信息等非表格行
  const lines = rawLines
    .map((l) => String(l || '').trim())
    .filter((l) => l && !/(条码号|条形码|报告单|检验报告|第\s*\d+\s*页|共\s*\d+\s*页|姓\s*名|性\s*别|年\s*龄|科\s*室|病历号|标本|流水号|送检医师|临床诊断|检测仪器|采样时间|接收时间|报告时间|参考区间$|^项目|^结果|^缩写|^单位|^序号|^代号)/.test(l))

  // 1) 行格式（最可靠）
  const rowRes = parseRowFormat(lines)
  // 2) 行格式命中不足且剩余行较多时，尝试列块格式
  let colRes = { points: [], leftover: [] }
  if (rowRes.points.length < 3 && rowRes.leftover.length >= 6) {
    colRes = parseColumnFormat(lines)
  }
  const points = [...rowRes.points, ...colRes.points]
  // 3) 兜底：剩余含中文的行 → 只填项目名，留待用户校对
  const seen = new Set(points.map((p) => p.original_name))
  for (const l of rowRes.leftover) {
    const m = l.match(NAME_ONLY_RE)
    if (m && !seen.has(m[1])) {
      seen.add(m[1])
      points.push(buildPoint(m[1], '', '', '', '', '', points.length))
    }
  }
  // 计算状态
  return points.map((p) => ({
    ...p,
    status: computeStatus(p.standard_code, p.value, p.ref_range, p.arrow, p.unit),
  }))
}
