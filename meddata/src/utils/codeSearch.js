// ===================== 标准代码选择器搜索匹配（纯函数，可单测） =====================
// 用于校对网格里「标准代码」下拉的搜索增强：按 代码 / 中文名 / 同义词缩写 /
// 本机已学缩写 / 拉丁缩写单字替换近似（如 FBG≈FIB） 匹配。
// 关键取舍：仅在 UI 搜索增强使用，**不改全局识别**（mapAlias 不动）→ 不污染静态字典，
//   也不把 FBG 这类在英文里指「空腹血糖」的缩写塞进全局映射，避免跨报告误配。
import { ALIAS_MAP } from '../data/dictionary.js'

// 同长度、恰好 1 个字符不同的近似（如 HGB≈HGB 拼写错一位）
export function oneEdit(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  return diff === 1
}

// 搜索专用同义桥接：报告缩写与字典代码差 2 字以上、但确为同义的（如 FBG↔FIB：
// F-B-G 与 F-I-B 差 2 字符，单字替换近似抓不到）。只用于搜索增强，**不进 mapAlias**，
// 因此不影响全局识别与 OCR 回归基线。
const SEARCH_SYNONYMS = {
  FBG: 'FIB', // 纤维蛋白原：部分报告缩写为 FBG（fasting blood glucose 在英文报告里也是 FBG，
  //   但本应用为中文化验单语境，此处仅作搜索同义桥接，不污染全局识别）
}

// field: { code, name }；term: 用户输入（已 trim）；learnedByCode: { [code]: [alias,...] }
export function matchCodeTerm(field, term, learnedByCode = {}) {
  const up = term.toUpperCase()
  if (field.code.toUpperCase().includes(up)) return true
  if (field.name.includes(term)) return true
  const aliases = ALIAS_MAP[field.code] || []
  if (aliases.some((a) => String(a).replace(/\s+/g, '').toUpperCase().includes(up))) return true
  if ((learnedByCode[field.code] || []).some((a) => a.toUpperCase().includes(up))) return true
  // 拉丁缩写单字替换近似（同长度 1 字符差异）
  if (/^[A-Z0-9#%^\-]+$/.test(up)) {
    if (aliases.some((a) => {
      const k = String(a).replace(/\s+/g, '').toUpperCase()
      return k.length === up.length && oneEdit(k, up)
    })) {
      return true
    }
  }
  // 搜索同义桥接（差 2 字以上的确切同义，如 FBG→FIB）
  if (SEARCH_SYNONYMS[up] === field.code) return true
  return false
}
