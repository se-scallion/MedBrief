// ===================== 用户自定义别名（本机动态学习） =====================
// 场景：同一指标各医院缩写写法千差万别（纤维蛋白原有 FIB / FIBG / Fbg / FBG / FG 等），
//       静态字典不可能穷举，且硬塞进字典会污染全局匹配（3 字母缩写参与子串匹配，
//       FBG 在英文语境又是「空腹血糖 fasting blood glucose」，有跨报告误配风险）。
// 策略：用户在「粘贴解析」里给出缩写、且该行最终确定了标准代码 → 把「缩写 → 代码」记在本机。
//       之后 mapAlias 全链路（含 OCR 识别归一化）同一缩写直接命中。
// 作用域：仅本机 localStorage，不动静态字典 → 全量 OCR 回归基线零影响。
// 撤销：解析面板内「已学缩写」chip 可逐条删除（学错即撤）。

const KEY = 'meddata_user_aliases'

const normKey = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase()

// 内存镜像：① 无 localStorage 环境（node 单测）退化为纯内存存储；
//          ② mapAlias 是热路径，避免每次调用都 getItem + JSON.parse。
let cache = null

function read() {
  if (cache) return cache
  try {
    if (typeof localStorage === 'undefined') return (cache = {})
    const j = JSON.parse(localStorage.getItem(KEY) || '{}')
    cache = j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    cache = {}
  }
  return cache
}

function write(map) {
  cache = map
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* 隐私模式/配额满：学习失败不影响主流程 */
  }
}

// 全部已学别名（{ 大写缩写: 标准代码 }）
export function getUserAliases() {
  return read()
}

// 删除一条已学别名
export function forgetAlias(alias) {
  const m = read()
  if (!m[normKey(alias)]) return false
  delete m[normKey(alias)]
  write(m)
  return true
}

// 学习一条别名：返回 { alias, code }（新增或改写）；无需学习时返回 null。
// 只收「纯字母数字缩写」（2-12 字符）：避免把整句项目名/中文名当缩写学进去，
// 也避免把「代码本身」重复记一遍。
export function learnAlias(alias, code) {
  const k = normKey(alias)
  const c = String(code || '').trim()
  if (!k || !c) return null
  if (!/^[A-Z0-9#%^\-]{2,12}$/.test(k)) return null
  if (k === normKey(c)) return null
  const m = read()
  if (m[k] === c) return null
  m[k] = c
  write(m)
  return { alias: k, code: c }
}

// 查表（精确，忽略大小写与空白）
export function mapUserAlias(rawName) {
  const k = normKey(rawName)
  if (!k) return null
  return read()[k] || null
}
