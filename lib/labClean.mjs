// MedBrief · 化验行字段清洗（读侧，纯函数，幂等）
//
// 为什么要有这一层（2026-11-13 排雷实测，54 份真实报告 / 204 行）：
//   真实数据里存在三类「看起来正常、实际是错值」的字段污染，全部不报错：
//   1) 列左移：`名称(含真值) | 值=区间 | 区间=单位`
//        例：{"name":"凝血酶原时间（P12.2个T）","value":"9.8-12.1","refRange":"sec"}
//        真义：PT = 12.2，参考 9.8-12.1，单位 sec —— 三列整体左移一格。
//        后果：这类行在卡面上「值」显示的是参考区间、参考区间显示的是单位，
//              且 refRange='sec' 不是区间 → 无法判定高低 → status=unknown → **静默不计入异常项**。
//        实测受影响行：PT 12.2 / NEUT% 87.2 / ANC 12.59 / APTT 35.7 / D-二聚体 10.18 等（全部漏判）。
//   2) 单位/区间串位：unit 里存了区间（`"1.8-3.5"`）、refRange 里存了单位（`"个"` / `"fl"`）。
//   3) 名称噪声：名称里嵌数值、箭头字（`上/小/个/比`）、定性结果（`阴性（-）`）、OCR 截断（`百分`）。
//
// 设计约束：
//   - **只在读侧修**，不迁移、不改写 data/reports.json（那是真实医疗数据，禁批量改）。
//   - **不编造**：任何无法 100% 确定的重构一律放弃，只留标记（nameDirty / repaired）。
//   - **幂等**：normalizeRow(normalizeRow(x)) 与原值等价；干净行必须零改动。
//   - 每次实际改动都留痕（`repaired` / `nameRepair`），供人工校对页回查原文（rawSnippet 原样保留）。

const RANGE_ONE = /^(<?|>?|≤|≥)?\s*(-?\d+(?:\.\d+)?)\s*(?:--|—|–|~|〜|-|至)\s*(\d+(?:\.\d+)?)$/
const RANGE_ANY = /(-?\d+(?:\.\d+)?)\s*(?:--|—|–|~|〜|-|至)\s*(-?\d+(?:\.\d+)?)/
const NUM_RE = /\d+(?:\.\d+)?/g

// 单位 token（与 reportIntake 的 UNIT_RE 同一语义，这里只用于「这一列到底是单位还是区间」的判据）
const UNIT_TOKEN = /^(?:10\s*[\^~°]?\s*\d+\s*\/\s*L|×\s*10\s*[\^~°]?\s*\d+\s*\/\s*L|g\s*\/\s*L|mg\s*\/\s*L|mg\s*\/\s*dL|mmol\s*\/\s*L|umol\s*\/\s*L|μmol\s*\/\s*L|U\s*\/\s*L|IU\s*\/\s*L|ng\s*\/\s*mL|pg\s*\/\s*mL|10\^?\d+\s*\/\s*L|%|fL|fl|pg|mmHg|sec|seC|Sec|S|s|秒|份|\/HP|个\/HP|个|f)$/i

export const isRange = (s) => RANGE_ONE.test(String(s || '').trim())
export const rangeMatch = (s) => String(s || '').trim().match(RANGE_ANY)

/** 这一列看起来是不是「单位」而不是「区间/数值」。 */
export function isUnitLike(s) {
  const t = String(s || '').trim()
  if (!t) return false
  // `10~9/L` / `10^12/L` 是单位不是区间（实测坑：先判区间会把最常见的白细胞单位判掉）
  const SCI = /^(?:×\s*)?10\s*[\^~°]?\s*\d+\s*\/\s*L$/i
  if (SCI.test(t)) return true
  if (/\d\s*(?:--|—|–|~|〜|-|至)\s*\d/.test(t)) return false // 含区间 → 不是单位
  if (UNIT_TOKEN.test(t)) return true
  // 纯字母单位串（≤6 字符，如 sec/mg/dL），但不把项目名缩写（APTT/PT/WBC）当单位
  return /^[A-Za-z][A-Za-z/^0-9]{0,5}$/.test(t) && !/^(APTT|PT|PTR|INR|TT|FIB|WBC|RBC|Hb|PLT|NE|LY|MO|EO|BA|MCH|MCV|RDW|PDW|MPV|PCT)$/i.test(t)
}

/** 从名称里取出「被吞掉的唯一数值」；多于一个数值或没有 → null（不确定就不动手）。 */
export function extractNameValue(name) {
  const nums = String(name || '').match(NUM_RE) || []
  if (nums.length !== 1) return null
  return nums[0]
}

// 名字里本来就有数字的项目（不能当「被吞掉的测量值」剥掉）
// 实测坑：`pCO2`→`pCO`、`二氧化碳（CO2）`→`CO`、`白介素6`→`白介素`。
const INTRINSIC_NUM_NAME = /白介素\s*\d|白细胞介素\s*\d|维生素\s*[BCDEK]?\d+|二氧化碳|CD\s*\d+|IL-?\d+|P\d{3}|HCO3|BE|pH/i

/** 判断名称里的那个数字是「项目名固有」还是「被 OCR 吞进来的测量值」。 */
function intrinsicNumber(name, nv) {
  if (INTRINSIC_NUM_NAME.test(name)) return true
  const i = name.indexOf(nv)
  if (i < 0) return true
  const before = name[i - 1] || ''
  const after = name.slice(i + nv.length, i + nv.length + 1) || ''
  const letterBefore = /[A-Za-z]/.test(before)
  const cjkBefore = /[\u4e00-\u9fa5]/.test(before)
  const noiseAfter = /[个小大上下比左右高低]/.test(after)
  const suffixAfter = after === '' || /[)）型+\-]/.test(after)
  if (noiseAfter) return false            // 数字后面紧跟「个/小/比」→ 一定是被吞的测量值
  if (letterBefore && suffixAfter) return true   // CO2 / pCO2 / P190型 / CD34+
  if (letterBefore && /[A-Za-z]/.test(after)) return true // IL6abc 之类
  if (cjkBefore && suffixAfter) return false     // 中文后接数字结尾 → 被吞的测量值
  return true
}

/** 名称里数值紧后面粘着的单字噪声（OCR 把箭头/标记读进了名字）。 */
const NOISE_NEAR_NUM = ['个', '小', '大', '上', '下', '比', '左', '右', '高', '低']

/**
 * 列左移还原：`名称(含真值) | 值=区间 | 区间=单位` → `真值 | 区间 | 单位`。
 * 三重条件同时成立才动手（缺一不改）：名称里有唯一数值 + value 整体是区间 + refRange 是单位。
 */
export function repairColumnShift(row = {}) {
  const name = String(row.name || '')
  const value = String(row.value ?? '').trim()
  const ref = String(row.refRange ?? '').trim()
  if (!isRange(value)) return null
  if (!isUnitLike(ref)) return null
  const nv = extractNameValue(name)
  if (nv == null) return null
  // 项目名固有编号（pCO2 的 2、CO2 的 2、P190 的 190）不是被吞的测量值 —— 不得当列左移还原
  if (intrinsicNumber(name, nv)) return null
  const num = Number(nv)
  if (!Number.isFinite(num)) return null
  // 排除「区间本身就是真值区间、名字里的数字是别的含义」：要求被吞的值落在区间附近的可解释范围外或内都行，
  // 我们不做临床合理性判断，只做「三列形态学错位」的还原 —— 形态成立即认为错位。
  return {
    value: nv,
    num,
    refRange: value,
    unit: ref,
    repaired: 'column-shift',
  }
}

/**
 * 名称别名（硬归一）：OCR 把说明文字整段拼进名字时，用**可辨识的化验学片段**还原规范名。
 * 实测唯一残留脏名：`P急性心衰急性心衰按年龄分层：<50岁：>450pg/ml50-75岁：900pg/ml>75岁：>1800pg/ml`
 * —— 它就是 NT-proBNP（心功能关键项，蒽环类化疗必看），但按名字匹配不到任何 code。
 * 只做「化验学上等价」的还原，不猜任何临床结论：文本里必须出现 proBNP/proBN 或「急性心衰+pg/ml 阈值」才认。
 */
const NAME_ALIASES = [
  { re: /pro-?bnp|probn|前体脑利钠肽|N\s*端脑钠肽/i, name: '前体NT-proBNP' },
  // 阈值说明被拼进名字的 NT-proBNP（含「按年龄分层」+ pg/ml 参考值特征）
  { re: /按年龄分层[\s\S]*pg\/ml|急性心衰[\s\S]*pg\/ml/i, name: '前体NT-proBNP' },
]
export function aliasName(raw = '') {
  const t = String(raw || '')
  for (const a of NAME_ALIASES) if (a.re.test(t)) return a.name
  return ''
}

/** 名称清洗：剥数值、剥箭头字噪声、剥定性结果、剥重复括号、修 OCR 截断。 */
export function cleanName(raw = '') {
  let n = String(raw || '').trim()
  if (!n) return ''
  const alias = aliasName(n)
  if (alias) return alias   // 硬归一优先：别名命中后不再做逐段剥离（剥离会把说明文字留成碎屑）
  const orig = n

  // 1) 定性结果被读进了名称：`丙型肝炎抗体（A阴性（-）nti-HCV）` → `丙型肝炎抗体（Anti-HCV）`
  n = n.replace(/(?:阴性|阳性)\s*[（(]\s*[-+＋]?\s*[)）]/g, '')
  n = n.replace(/[（(]\s*[-+＋]\s*[)）]\s*(?=[（)）]|$)/, '')

  // 2) 名称里被吞的唯一数值 + 紧邻单字噪声：`（P12.2个T）` → `（PT）`
  const nv = extractNameValue(n)
  if (nv != null && !intrinsicNumber(n, nv)) {
    const esc = nv.replace('.', '\\.')
    const re = new RegExp(`${esc}\\s*(?:${NOISE_NEAR_NUM.join('|')})?`, 'g')
    const candidate = n.replace(re, '')
    // 只有替换后仍是「可读名称」（含中文或 ≥2 个字母）才采用，否则保留原样
    if (/[\u4e00-\u9fa5]/.test(candidate) || /[A-Za-z]{2,}/.test(candidate)) n = candidate
  }

  // 3) 圈号等排版标记：`二氧化碳（CO2）⑦` → `二氧化碳（CO2）`
  n = n.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]+/g, '')

  // 3b) 孤立的噪声字（OCR 残留）：`百分•小比` → `百分`
  n = n.replace(/[•·、，,;；]+/g, '')
  n = n.replace(/(?:[个小大上下比左右高低])\s*比$/, '')
  n = n.replace(/[•·]\s*/g, '')

  // 4) 重复括号：`PH（CH）（PH）` → `PH`
  const dup = n.match(/^(.+?)[（(]([A-Za-z0-9%+\-]{1,10})[)）]\s*[（(]\2[)）]$/)
  if (dup) n = `${dup[1]}（${dup[2]}）`

  // 5) 尾部单字母噪声（`血小板压积C`、`葡萄糖（GLU）T`），只在去掉后仍可读时
  const tail = n.match(/^(.{2,}[）)\u4e00-\u9fa5])[CT]$/)
  if (tail) n = tail[1]

  // 6) OCR 截断：`中性粒细胞百分` → `中性粒细胞百分比`（格式修复，不是新增事实）
  let nameRepair = ''
  if (/(?:百分|比率)$/.test(n)) { n = n.replace(/(?:百分|比率)$/, '百分比'); nameRepair = 'truncated' }

  n = n.replace(/\s{2,}/g, ' ').trim()
  return n || String(raw || '').trim()
}

/**
 * 单位显示归一（只改写法，不改量纲）：
 *   `10-9/L` / `10~9/L` / `10^9/L` → `10^9/L`；`seC`/`SEC` → `sec`；`G/L` → `g/L`
 * 实测：卡面上曾出现 `14.3 SeC`、`106 G/L`、`3.27 10-9/L` —— 数值对、写法像乱码，医生会怀疑整张卡。
 */
export function normalizeUnitDisplay(raw = '') {
  let u = String(raw || '').trim()
  if (!u) return ''
  u = u.replace(/^10\s*[-~^°]\s*(\d+)\s*\/\s*L$/i, '10^$1/L')
  u = u.replace(/^×?\s*10\s*[-~^°]\s*(\d+)\s*\/\s*L$/i, '10^$1/L')
  u = u.replace(/^se?c$/i, 'sec')
  u = u.replace(/^G\/L$/, 'g/L')
  u = u.replace(/^MG\/L$/, 'mg/L')
  u = u.replace(/^MMOL\/L$/i, 'mmol/L')
  u = u.replace(/^UMOL\/L$/i, 'umol/L')
  // 实测卡面出现的写法：`PG`/`FL`/`NG/ML`/`MM`/`U/L` 大小写混乱
  u = u.replace(/^PG$/i, 'pg')
  u = u.replace(/^FL$/i, 'fL')
  // 实测：`血小板平均体积` 07-17 被 OCR 成 `fI`（大写 i 冒充小写 l）→ 与 07-14 的 `fL` 判成
  // 「单位不一致」，整项趋势被静默丢弃（第 3 页显示「未绘制：血小板平均体积（fl/fI）」）。
  u = u.replace(/^f[Il1]$/i, 'fL')
  u = u.replace(/^f$/, 'fL')
  u = u.replace(/^w(mol)\s*\/\s*L$/i, 'u$1/L')   // μ 被 OCR 成 w：`35 wmol/L` → `umol/L`
  // 单字母且不是已知单位（s/秒、g、L、m）→ OCR 噪声，清空（实测 `D-二聚体 unit='T'`，同项其余行都是 mg/L）
  if (/^[A-Za-z]$/.test(u) && !/^[sSgGlLmM]$/.test(u)) return ''
  u = u.replace(/^NG\/ML$/i, 'ng/mL')
  u = u.replace(/^MG\/ML$/i, 'mg/mL')
  u = u.replace(/^U\/L$/i, 'U/L')
  u = u.replace(/^MM$/i, 'mm')
  return u
}

/** value 尾巴噪声：`22.00小` → `22.00`；`3.27上` → `3.27`。定性值（`35（++）`）保留数值并标 qualitative。 */
export function cleanValue(raw) {
  let v = String(raw ?? '').trim()
  if (!v) return { value: v, qualitative: false }
  const chineseText0 = /^[\u4e00-\u9fa5]{2,}$/.test(v)
  // 定性结果一律 qualitative：带 (±)/(+)/(+++) 符号、以 + 结尾、含阳/阴性，
  // 或**整串不含数字**（`未见` / `褐色稀便` / `B型` / `neg` 都不是数值，必须挡在趋势与高低判定之外）。
  const qualitative = /[（(]\s*[-+＋]{1,4}\s*[)）]|\+{1,4}$|阳性|阴性/.test(v) || chineseText0 || !/\d/.test(v)
  // 纯中文描述（如 NT-proBNP 那行被 OCR 写成「慢性心衰」）—— 不是数值，也不是定性标记，
  // 必须标注为 qualitative，否则会被当成测量值参与趋势/危急值判定。
  //
  // ⚠️ 2026-11-14 事故（用户对比 11-13 / 11-14 两份 PDF 逮到）：
  //    旧规则是「≥2 个汉字且不含数字 → 一律当描述句清空」，结果把 **31 个合法定性结果**
  //    全洗成了空值：`阴性`×22 / `阳性`×4 / `未见`×4 / `褐色稀便`×1（Rh(D)、传染病四项、
  //    粪便镜检全中招）。真该清的只有 `慢性心衰` 一条。
  //    现在收紧为：**只在命中「说明性短语」词库时才清空**，并显式放过以定性结果词开头的值
  //    （阴性/阳性/未见/colour 描述…）。宁可留一句可疑文本，也绝不静默丢掉检验结果。
  const QUAL_PREFIX = /^(阴性|阳性|弱阳性|未见|未检出|未查|无|正常|异常|neg|pos|褐色|黄色|棕色|绿色|红色|白色|灰白色|淡黄色)/i
  const NOTE_LIKE = /心衰|衰竭|病史|参考值|参考范围|建议|提示|增高|减低|升高|降低/
  const chineseText = /^[\u4e00-\u9fa5]{2,}$/.test(v)   // 纯中文文本（无论是不是描述句，都不是数值）
  const prose = chineseText && !QUAL_PREFIX.test(v) && NOTE_LIKE.test(v)
  // 只有「纯数值 + 单字噪声」才清洗，避免误伤 `10^9/L`、`<0.01` 这类真值
  const m = v.match(/^([<>≤≥]?\s*-?\d+(?:\.\d+)?)\s*[个小大上下比左右高低]$/)
  if (m) return { value: m[1].replace(/\s/g, ''), qualitative, tailNoise: true }
  // 阈值 + 单位/说明被粘连：`<300pg/ml-非` → `<300`（保留比较符语义，剥的是后面的噪声）
  const th = v.match(/^([<>≤≥]\s*-?\d+(?:\.\d+)?)\s*(?:pg|ng|mg|mmol|umol)?\s*\/[^\d]*$/i)
  if (th) return { value: th[1].replace(/\s/g, ''), qualitative, tailNoise: true }
  return { value: v, qualitative, prose }
}

/**
 * 单位 ↔ 区间 串位纠正（三个方向）：
 *   a. unit 里存的是区间 → 换回 refRange；
 *   b. refRange 里存的是**单位**（unit 为空）→ 移到 unit，refRange 清空
 *      （实测：血小板分布宽度 refRange='fl'/'f'，导致趋势图把单位当参考带、还报「跨院区间不同 fl/f」）；
 *   c. 以上都不成立 → 原样。
 */
function swapUnitRange(unit, refRange) {
  let u = String(unit || '').trim()
  let r = String(refRange || '').trim()
  if (u && isRange(u) && (!r || isUnitLike(r))) return { unit: r, refRange: u, swapped: true }
  if (!u && r && isUnitLike(r)) return { unit: r, refRange: '', swapped: true }   // b
  if (u && r && isUnitLike(r) && !isUnitLike(u)) return { unit: r, refRange: '', swapped: true }
  return { unit: u, refRange: r }
}

/**
 * 统一入口（幂等）。返回新对象，不改入参。
 * 输出字段：name / nameRaw / value / num / unit / refRange / flag / repaired[]
 */
export function normalizeRow(row = {}) {
  // ⚠️ 必须优先用 name：实测 originalName 是**截断**的原文（`凝血酶原时间（P12.2个`），
  //    拿它清洗会把名称裁掉尾巴（`（PT）`→`（P`）。originalName 只作回查留痕。
  const nameRaw = row.name || row.nameRaw || row.originalName || ''
  let work = { ...row }

  // a) 列左移还原（最优先，后续都基于还原后的列判断）
  const shift = repairColumnShift(work)
  if (shift) {
    work = { ...work, value: shift.value, num: shift.num, refRange: shift.refRange, unit: shift.unit }
  }

  // b) 单位/区间串位
  const sw = swapUnitRange(work.unit, work.refRange)
  if (sw.swapped) {
    work = { ...work, unit: sw.unit, refRange: sw.refRange }
  }

  // b2) 参考区间的排版噪声：`*Rh血型阴性、` → `Rh血型阴性`
  //     前导 `*` 是报告单「本院参考值」的排版标记，尾部顿号/逗号是 OCR 残留 —— 都不是区间内容，
  //     留着会让第 2 页参考列被撑长、顶到页边被裁（用户 2026-11-14 报的 Rh 行裁切）。
  if (String(work.refRange || '').trim()) {
    const rr = String(work.refRange).trim().replace(/^[*＊·•]+/, '').replace(/[、，,；;]+$/, '').trim()
    if (rr !== String(work.refRange).trim()) work = { ...work, refRange: rr }
    // b3) 参考列里装的是**注意事项文本**而不是区间 → 置「—」（2026-11-14 用户口径）：
    //     Rh(D) 的 `*Rh血型阴性、阳性均为正常 / Rh阴性提示为稀有血型…` 是说明，不是参考区间；
    //     留着会与左列的「阳性」并排，医生读成「阳性 vs 阴性」自相矛盾。
    //     判据：不是数值区间 + 含说明性词（均为/提示/若为/请/血型/参考值/说明/筛查）→ 置空显示 —
    const rawRef = String(work.refRange || '').trim()
    // 数值区间（含**单边阈值** `<125` / `＞=4.0`）：单边区间是合法参考范围，绝不能被当成说明文字清掉
    // （2026-11-14 实测：`前体NT-proBNP` 的 `<125` 若不是区间就会被置空，进而判不出高低）
    const isNumericRange = /^\s*[<>≤≥＜＞]?=?\s*-?\d+(\.\d+)?\s*(?:--|—|–|~|～|-|至)?\s*-?\d*(\.\d+)?\s*[a-zA-Z%\/\^\d]*\s*$/.test(rawRef)
    const isPlainQuali = /^(阴性|阳性|正常|未见|无)$/.test(rawRef)
    if (!isNumericRange && !isPlainQuali && /均为|提示|若为|请|血型|参考值|说明|筛查/.test(rawRef)) {
      work = { ...work, refRange: '', refRangeNote: rawRef }
    }
  }

  // c) value 尾巴噪声
  const cv = cleanValue(work.value)
  if (cv.tailNoise) work = { ...work, value: cv.value, num: Number(cv.value) }

  // c1) 单位写法归一（量纲不变）
  const dispUnit = normalizeUnitDisplay(work.unit)
  if (dispUnit !== String(work.unit || '').trim()) work = { ...work, unit: dispUnit }

  // c2) 单位是纯噪声字（`个` / `份`）→ 清空（实测残留：unit='个' 让同一项被判成「单位不一致」而画不出趋势）
  if (/^[个份]$/.test(String(work.unit || '').trim())) work = { ...work, unit: '' }

  // c3) 值是一句中文描述（把参考说明/临床备注当成测量值，实测 NT-proBNP 行写成「慢性心衰」）
  //     → 值清空、不当数值；原文仍在 rawSnippet，卡面显示「—」而不是拿描述冒充数值
  if (cv.prose) work = { ...work, value: '', num: null }

  // c3b) **解释文本行**（2026-11-14 实测 NT-proBNP）：OCR 把「<300pg/ml-非急性心衰 / 按年龄分层…」
  //      这类参考说明切成了结果列，名称也被整段说明顶替。它不是测量值，也不是定性结果 ——
  //      标 noteRow，卡面直接剔除（另有数值核对：真值一律回原文核，见 data patchLog）。
  //    护栏：**不许只看名称**——真值行的名称也可能被说明文字污染（实测 `前体NT-proBNP 3182.00<125`
  //    的名称里就带着「按年龄分层」，那是脏名而不是脏值）。只有「值/参考列本身是说明」或
  //    「名称是说明且整行没有数值」才判定为解释文本行。
  const noteHit = /非急性|按年龄分层|均为正常|若为阳性|参考值说明/.test(`${work.value || ''} ${work.refRange || ''}`)
  const nameIsNote = /按年龄分层|均为正常|若为阳性/.test(String(work.name || '')) && !Number.isFinite(Number(work.num))
  const noteRow = noteHit || nameIsNote
  if (noteRow) {
    work = { ...work, noteRow: true, value: '', num: null }
  }

  // c4) 人工改过 value 后，num 必须以 value 为准重算（护栏②：状态同步）
  //     —— 存储里 num 是入库时的旧值，人工修正 value 后若不重算，卡面会继续按旧值判高低。
  if (work.verified) {
    const vnum = Number(String(work.value ?? '').replace(/[<>≤≥\s]/g, '').replace(/[^\d.\-]/g, ''))
    if (Number.isFinite(vnum)) work = { ...work, num: vnum }
  }

  // d) 名称清洗
  const aliased = aliasName(nameRaw)
  const name = cleanName(nameRaw)
  work = { ...work, name, nameRaw }

  const repaired = []
  if (shift) repaired.push('column-shift')
  if (aliased) repaired.push('name-alias')
  if (sw.swapped) repaired.push('unit-range-swap')
  if (cv.tailNoise) repaired.push('value-tail-noise')
  if (cv.prose) repaired.push('prose-dropped')
  if (noteRow) repaired.push('note-dropped')   // 解释文本行被清空（显式标记，不静默）
  if (name !== String(nameRaw).trim()) repaired.push('name')

  return {
    ...work,
    repaired,
    qualitative: !!cv.qualitative || !!cv.prose,
    proseValue: !!cv.prose,   // 值是一句中文描述（不是数值），卡面要标出来，不许当测量值
    // 名称里仍有多个数字（且不是「P190型 / CO2 / 白介素6」这类固有编号）→ 明显是脏名，
    // 卡面与校对页必须提示，不得当正常项处理（实测：NT-proBNP 那一行被 OCR 拼成了阈值说明长串）。
    // 已被别名归一的名称不再算脏名（残留数字是说明文字里的阈值，不是项目名）
    nameDirty: !aliased && (String(nameRaw).match(NUM_RE) || []).length > 1 && !INTRINSIC_NUM_NAME.test(String(nameRaw)),
  }
}

/**
 * 这一行在**存储**里是不是「三列左移」形态（读侧靠还原才能读对）。
 *
 * 判据（故意保守，宁可漏判也不误拦）：`value` 长得像区间 **且** `refRange` 长得像单位。
 * 实测样本：`{value:"9.8-12.1", refRange:"sec"}`（真义 PT=12.2、参考 9.8-12.1、单位 sec）。
 *
 * 为什么服务端需要它（2026-11-14 沙箱实证，`tools/patch-replay.mjs`）：
 *   这类行如果只提交 `value` 改正，左移还原的触发条件（「value 像区间」）就消失了，
 *   真参考区间在存储里**没有第二份** → 永久丢失；更糟的是读侧还会给出
 *   `repaired:["unit-range-swap"]` 这个**假修复标记**，看起来像「已经处理过」。
 *   所以 patch 端点必须拦住这种半写。
 */
export function looksColumnShifted(row = {}) {
  const v = String(row.value ?? '').trim()
  const r = String(row.refRange ?? '').trim()
  if (!v || !r) return false
  return isRange(v) && isUnitLike(r)
}

/** 批量（保持顺序，幂等）。 */
export const normalizeRows = (rows = []) => (rows || []).map(normalizeRow)
