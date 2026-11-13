// ===================== 出院医嘱 → 用药候选 + 增量写入计划（纯函数，无 DOM，可 node 直连单测） =====================
import { groupMedCourses } from './medCourses.js'

// 背景：出院记录里的「出院医嘱 / 出院用药」段落就是一份完整的每日用药清单，
// 但 OCR 把它识别成带噪声的纯文本（见 scripts/verify-med-extract.mjs 的真实 fixture），
// 过去只能人工抄进「疗程」页。
//
// 本模块做三件事，全部只读入、只产出数据，不碰 store：
//   1) 切日期搂取：`extractMedSection` 从出院记录全文里剥出「出院医嘱」段落；
//   2) 逐行解析：`parseMedLine` → 药名 / 规格 / 用法 / 每日剂量（含单位）；
//   3) 增量判定：`rowAction` 对照已有用药事件给出 新增 / 改量 / 重启 / 已在服 四态，
//      `planMedWrites` 产出「新增还是覆盖更新」的最小写入计划（幂等：同一份文书重复导入不会产生第二条）。
//
// —— 为什么必须有「药名归一 + 模糊匹配」——
// OCR 会把药名的字打错（泊那替尼→泊那蔡尼、肾上腺色腙→肾上腺色逐、奥美拉唑→奥美拉只），
// 若照抄原文入库，同一药会被当成新药另起一档，剂量阶梯断裂、费用翻倍算。
// 所以解析产物只是「候选」，最终由用户在勾选项里确认 —— 这也是「绝不全自动写库」的红线。
//
// —— 剂量口径（用户 2026-09-20 定）——
// 跟随系统现有记录：片剂按「片/粒」计数，只有纯 mg / μg 型处方才记 mg / μg。
// 例：肾上腺色腙片 早午晚饭后 1 粒 → 3 片/日；泊那替尼 午餐后 30mg → 30 mg/日；贝林妥 28μg/d → 28 μg/日。

// ---------- OCR 噪声净化（只在本模块使用，不影响其它解析链路） ----------

// 计数单位的 OCR 高频错字：站 / 泣 / 料 ← 粒（"1粒"→"1站"/"1料"）
const COUNT_UNIT_OCR = { 站: '粒', 泣: '粒', 料: '粒', 片: '片', 丸: '丸', 袋: '袋', 颗: '颗', 支: '支' }
// 计数单位（与 cost.js COUNT_UNITS 同口径）：片/粒/丸/袋…无需按规格折算
const COUNT_UNITS = ['片', '粒', '丸', '袋', '颗', '支', '瓶', '盒', '贴', '包', '枚']
// 质量/体积单位归一：OCR 常见 ug（无所谓大小写）
const MASS_UNIT_CANON = { ug: 'μg', μg: 'μg', mg: 'mg', g: 'g', ml: 'mL', mL: 'mL' }

// 行级净化：擦掉 OCR 特有的空格、被读成 y 的斜杠、被读成 #+ 的乘号
function cleanLine(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim()
  // 数字里被插入空格：「0. 375g」→「0.375g」
  s = s.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')
  // 斜杠被打成 y：「0.5mgy片」→「0.5mg/片」、「28ugy/d」→「28ug//d」（多余斜杠不影响数值匹配）
  s = s.replace(/(\d|(?:μg|ug|mg|g|mL|ml))\s*y(?=[一-龥A-Za-z/])/g, '$1/')
  // 规格乘号被读成 # / #+ / 十：「0.375g#+8片」→「0.375g*8片」
  s = s.replace(/#\+?/g, '*')
  return s.trim()
}

// ---------- 段落定位 ----------

const MED_HEAD_RE = /(出院医嘱|出院带药|出院用药)\s*[：:，,]/
const NEXT_SECTION_RE =
  /^(?:入院情况|诊疗经过|阳性辅助检查结果|出院时症状与体征|出院情况|出院诊断|入院初步诊断|入院记录|门诊病历)\s*[：:，,]/
const STOP_LINE_RE = /^(?:病案号|住院号|住院天数|医师|主治医师|记录者|记录时间|第\s*\d+\s*页)/

// 取「出院医嘱」段：从标签行起收到下一个大段为止，保留原始行结构（行结构是后续逐行解析的唯一依据）
export function extractMedSection(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const start = lines.findIndex((l) => MED_HEAD_RE.test(l))
  if (start < 0) return []
  const out = []
  const head = lines[start].replace(MED_HEAD_RE, '').trim()
  if (head) out.push(head)
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i]
    if (NEXT_SECTION_RE.test(ln) || STOP_LINE_RE.test(ln)) break
    out.push(ln)
  }
  return out
}

// ---------- 候选行识别 ----------

// 单位 token：含 OCR 错字 站/泣（否则「(早餐前1站)」抽不到单次量，整行只能手填）
const UNIT_TOKEN = '(?:μg|ug|mg|g|mL|ml|粒|站|泣|料|片|丸|袋|颗|支|U|万U|IU)'
const DOSE_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT_TOKEN}`, 'i')
const VERB_RE = /(口服|外用|含服|冲服|静脉|静滴|泵入|雾化|舌下|皮下|肌注|肌肉注射)/

// 同在「出院医嘱」段里但不是每日处方的话：升白针、输血医嘱、复查安排……
// 真实样本（2026-09-20 出院记录）：
//   「细胞刺激因子300ug皮下注射升白细胞治疗;」「血红蛋白和60g/L，悬浮红细胞输注对症;」
// 它们都带剂量单位，若不排除会被当成新药写进系统。
const ADVICE_NOISE_RE = /输注|升白细胞|刺激因子|对症|复查|就诊|门诊|急诊|不适|随诊|加强营养|注意休息|避免|预约住院|提前/

// 是否是「药行」：必须有中文、（出现剂量单位 或 出现给药动词），且不是宣教/支持治疗性医嘱。
export function isMedLine(raw) {
  const s = cleanLine(raw)
  if (s.length < 4 || s.length > 60) return false
  if (!/[一-龥]/.test(s)) return false
  if (ADVICE_NOISE_RE.test(s)) return false
  return DOSE_RE.test(s) || VERB_RE.test(s)
}

// ---------- 剂量折算 ----------

// 频次词组 → 每日次数。早/午/晚/睡前各计一次，去重后相加（早、晚=2；早午晚=3）
const FREQ_SLOTS = [
  { re: /睡前|临睡|睡眠前|睡时/, slot: 'sleep' },
  { re: /早|晨/, slot: 'morning' },
  { re: /午/, slot: 'noon' }, // 只认「午」本身，「中餐」不映射（避免误伤）
  { re: /晚/, slot: 'night' },
]
function countSlots(usage) {
  const slots = new Set()
  for (const { re, slot } of FREQ_SLOTS) if (re.test(usage)) slots.add(slot)
  if (slots.size) return slots.size
  const explicit =
    usage.match(/每[日天]\s*(\d+)\s*次/i) ||
    usage.match(/(\d+)\s*次\s*[／/]\s*[日天]/) ||
    usage.match(/一[日天]\s*(\d+)\s*次/)
  if (explicit) return Number(explicit[1])
  if (/\b(tid|TID)/.test(usage)) return 3
  if (/\b(bid|BID)/.test(usage)) return 2
  if (/\b(qd|QD)/.test(usage)) return 1
  return 1
}

const AMOUNT_RE = new RegExp(`(\\d+(?:\\.\\d+)?|半)\\s*(${UNIT_TOKEN})`, 'gi')

// 取用法里「单次用量 + 单位」：取最后一处（「每日2次每次1片」这种情况命中的是后面的单次量）
function takeAmount(usage) {
  if (!usage) return { value: null, unit: '' }
  const hits = [...String(usage).matchAll(AMOUNT_RE)]
  if (!hits.length) return { value: null, unit: '' }
  const last = hits[hits.length - 1]
  const rawNum = String(last[1]).trim()
  const value = rawNum === '半' ? 0.5 : Number(rawNum)
  if (!Number.isFinite(value) || value < 0) return { value: null, unit: '' }
  const rawUnit = String(last[2]).trim()
  const unit = COUNT_UNIT_OCR[rawUnit] || MASS_UNIT_CANON[rawUnit] || MASS_UNIT_CANON[rawUnit.toLowerCase()] || rawUnit
  return { value, unit }
}

// ---------- 药名提取与归一 ----------

// 括号组：OCR 常把配对的括号读错（"(早、午、晚餐/餐后]粒)"），
// 故闭合端必须把 ] [ 也认作闭合符，否则整组识别不出来、单次量丢失。
const GROUP_RE = /[([【〈《]([^()（）[\]【】〈《》〉]*)[)\]】〉》]/g
// 罗马数字括号里的 OCR 变体：〈《IL ) → (II)、 (T) → (I)
function canonRoman(s) {
  const t = String(s || '')
    .replace(/\s+/g, '')
    .toUpperCase()
  if (!t) return ''
  const map = { IL: 'II', LL: 'II', L1: 'II', T: 'I', I: 'I', II: 'II', III: 'III' }
  return map[t] || t
}
// 药名尾部可能黏着的用法词（无括号行的药名要剔除它们）
// 红线：复合词必须排在单纯词前面。「泊那蔡尼午餐后30mg」的尾部是「午餐后」，
// 若先匹配到裸的「餐后」，会剥出「泊那蔡尼午」这种畸形药名（实数教训）。
const NAME_TAIL_RE =
  /(?:[早午晚][餐饭][前后]|早餐|午餐|晚餐|早饭|午饭|晚饭|[早午晚][餐饭]|餐前|餐后|饭前|饭后|睡前|口服|外用|含服|冲服|静脉泵入|静脉滴注|静脉注射|皮下注射|雾化|持续口服|长期服用)$/

export function normalizeDrugName(raw) {
  return String(raw || '')
    .replace(/\s+/g, '')
    .replace(/[、,，;；。]+$/g, '')
    .trim()
}

// 拆一行：药名 / 规格 / 用法 / 每日剂量
export function parseMedLine(raw) {
  const line = cleanLine(raw).replace(/^\d+\s*[、.．)\]]\s*/, '') // 去掉「5、」这类序号
  if (!line) return null

  const groups = [...line.matchAll(GROUP_RE)].map((m) => ({ text: m[1], index: m.index }))
  // 药名边界：优先取到第一个括号；无括号则取到第一个数字前
  let cut = line.length
  if (groups.length) cut = groups[0].index
  else {
    const dIdx = line.search(/\d/)
    if (dIdx > 0) cut = dIdx
  }
  let name = line
    .slice(0, cut)
    .replace(/[()（）[\]【】〈《》〉]/g, '') // OCR 常有「〈《IL )」这类错配括号，残留符号不属于药名
    .trim()
  // 无括号行会把用法词黏进药名（「泊那蔡尼午餐后30mg」→ 需剥掉「午餐后」）
  for (let guard = 0; guard < 4 && NAME_TAIL_RE.test(name) && name.length > 2; guard++) {
    name = name.replace(NAME_TAIL_RE, '').trim()
  }

  // 紧跟其后的「无数字括号」是规格标号（Ⅱ / I），归属药名而非规格
  let gi = 0
  let spec = ''
  const usageParts = []
  for (let i = 0; i < groups.length; i++) {
    const t = groups[i].text.trim()
    if (!/\d/.test(t)) {
      // 只认短拉丁/罗马标号（(II)/(I)/(T)）；若不限定，形如「(早、午、晚餐/餐后]」的用法括号
      // 会被当成标号拼进药名，产出「肾上腺色脏片(早、午、晚餐/餐后)」这种畸形名（真实踩坑）
      const tr = t.trim()
      const rn = /^[A-Za-z]{1,4}$/.test(tr) ? canonRoman(tr) : ''
      if (rn) name += `(${rn})`
      else usageParts.push(t)
      continue
    }
    if (!spec && /[*x×]|片|粒|丸|袋|颗|支|瓶|μg|ug|mg|g|mL|ml/.test(t)) {
      spec = t
      continue
    }
    usageParts.push(t)
  }
  // 用法：优先取最后一个含频次词 / 单次量单位的括号，并接上括号后残留的文字
  // （OCR 常把「1粒」读成「]粒」，残留里可能才是真正的单次量）。
  const usageGroup = usageParts.filter((t) => countSlots(t) > 0 || AMOUNT_RE.test(t)).pop() || ''
  const lastGroup = groups[groups.length - 1]
  const tail = lastGroup ? line.slice(lastGroup.index + lastGroup.text.length + 2) : line.slice(cut)
  let usage = [usageGroup, tail].filter(Boolean).join(' ').trim()
  if (!usage) usage = line.slice(name.length).trim()

  const freq = countSlots(usage)
  const { value: single, unit: singleUnit } = takeAmount(usage)
  let dose = null
  let unit = ''
  if (single != null) {
    dose = Math.round(single * freq * 1000) / 1000
    unit = singleUnit
  }

  return {
    name: normalizeDrugName(name),
    spec: groups.length ? (groups.find((g) => /\d/.test(g.text) && /[*x×]|片|粒|丸|袋|颗|支|瓶|μg|ug|mg|g|mL|ml/.test(g.text)) || { text: '' }).text.trim() : spec,
    usage,
    freq,
    single,
    dose,
    unit,
    needConfirm: dose == null, // 判定不了剂量 → 交给用户手填，绝不猜
  }
}

// ---------- 药名匹配（OCR 噪声的主人竟然也是 avatar 拼谷物） ----------

// 常见剂型后缀：剥掉后比「核心名」，解决「奥美拉唑肠溶胶囊」vs「奥美拉唑」
const FORM_SUFFIX_RE =
  /(?:缓释片|控释片|分散片|咀嚼片|泡腾片|肠溶胶囊|肠溶片|软胶囊|胶囊|片剂|颗粒|注射液|注射剂|干粉|滴剂|软膏|栓剂)$/
function coreName(name) {
  let n = normalizeDrugName(name).replace(/\(.*?\)/g, '')
  for (let guard = 0; guard < 3 && FORM_SUFFIX_RE.test(n) && n.length > 2; guard++) {
    n = n.replace(FORM_SUFFIX_RE, '')
  }
  return n
}
// 同长度且仅一字之差 → OCR 错字（泊那替尼/泊那蔡尼、肾上腺色腙/肾上腺色逐）。
// 末位不同的短名（≤4 字）不认：现实中「头孢克洛」与「头孢克肟」就是这样撞上的两种抗生素，
// 合起来会把新药挂到旧药档次上。≥5 字的名字末位出错概率远低于恰好存在另一种药的概率，放行。
function oneCharDiff(a, b) {
  if (a.length !== b.length || a.length < 3) return false
  let diff = 0
  let pos = -1
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diff++
      pos = i
    }
  }
  if (diff !== 1) return false
  return a.length >= 5 || pos < a.length - 1
}

// 返回 { key, score }：key 为命中到的既有药名（未命中返回 ''）
export function matchDrug(name, roster = []) {
  const target = normalizeDrugName(name)
  if (!target) return { key: '', score: 0 }
  const keys = [...new Set((roster || []).map((k) => normalizeDrugName(k)).filter(Boolean))]
  if (!keys.length) return { key: '', score: 0 }
  // ① 完全相等
  const exact = keys.find((k) => k === target)
  if (exact) return { key: exact, score: 1 }
  const tcore = coreName(target)
  // ② 剥掉剂型后缀后相等（奥美拉只肠溶胶囊 → 奥美拉唑）
  const coreHit = keys.find((k) => coreName(k) === tcore && tcore.length >= 2)
  if (coreHit) return { key: coreHit, score: 0.9 }
  // ③ 一字之差（OCR 打错单字）
  const nearHit = keys.find((k) => oneCharDiff(coreName(k), tcore) || oneCharDiff(k, target))
  if (nearHit) return { key: nearHit, score: 0.8 }
  // ④ 前缀包含且长度差 ≥2（贝林妥欧单抗 → 贝林妥；长度差 1 不认，防 泼尼松/泼尼松龙 误并）
  const prefixHit = keys.find(
    (k) =>
      (target.startsWith(k) || k.startsWith(target)) &&
      Math.abs(k.length - target.length) >= 2 &&
      Math.min(k.length, target.length) >= 3
  )
  if (prefixHit) return { key: prefixHit, score: 0.6 }
  return { key: '', score: 0 }
}

// ---------- 增量判定 ----------

// 剂量等价：数值相等且单位同类。计数单位（片/粒/丸…）互相视作等价 ——
// 「肾上腺色腙片 3颗/日」与系统里已记的「3片/日」是同一档剂量，不该判成改量。
const sameDose = (a, b) => {
  if (!a || !b) return false
  if (Number(a.dose) !== Number(b.dose)) return false
  const ua = String(a.unit || '').trim()
  const ub = String(b.unit || '').trim()
  return ua === ub || (COUNT_UNITS.includes(ua) && COUNT_UNITS.includes(ub))
}

// 对照已有用药课程（groupMedCourses 的结果）给出四态：
//   new 新增 | change 改量 | restart 重启（曾被停用）| same 已在服·无变化
export function rowAction(row, groups = [], date = '') {
  const key = normalizeDrugName(row && row.matchedKey)
  const drug = normalizeDrugName(row && row.name)
  if (!key && !drug) return 'new'
  const g = (groups || []).find((x) => normalizeDrugName(x.key) === (key || drug))
  if (!g) return 'new'
  // 已停药：无论剂量是否相同，都要在该日新增一条剂量事件才能重启（阶梯会自然续接）
  if (g.status === 'stopped') return 'restart'
  if (!g.current || g.current.dose == null) return 'restart'
  if (row && (row.dose == null || row.needConfirm)) return 'restart'
  return sameDose(g.current, row) ? 'same' : 'change'
}

export const ACTION_LABEL = {
  new: '新增',
  change: '改量',
  restart: '重启',
  same: '已在服·跳过',
}

// 默认勾选：新增 / 改量 / 重启；剂量判定不了的不勾（强制手填）
export function defaultChecked(row) {
  if (row.needConfirm || row.dose == null) return false
  return ['new', 'change', 'restart'].includes(row.action)
}

// 用户输入改动后重算（改了药名会重新匹配、重判动作）
export function reconcileRow(row, { groups = [], date = '', roster = [] } = {}) {
  const name = normalizeDrugName(row.name)
  const hit = matchDrug(name, roster)
  const next = { ...row, name, matchedKey: hit.key || '' }
  // 单位继承：命中已有药且双方都是计数单位 → 沿用系统里在用的那个（片 vs 粒 不再互相漂移）。
  // 与 MedDoseForm.pickDrug「选中已有药自动带出其单位」同口径。
  const g = (groups || []).find((x) => normalizeDrugName(x.key) === next.matchedKey)
  if (g && g.lastUnit && COUNT_UNITS.includes(String(row.unit || '').trim()) && COUNT_UNITS.includes(String(g.lastUnit).trim())) {
    next.unit = g.lastUnit
  }
  if (g && g.current) {
    next.currentDose = g.current.dose
    next.currentUnit = g.current.unit || ''
  }
  next.action = rowAction(next, groups, date)
  if (row.checked == null) next.checked = defaultChecked(next)
  return next
}

// ---------- 两个组合出口 ----------

// 全文 → 候选行（已做初步匹配，但动作未知，需后续 reconcile）
export function extractMedInstructions(rawText, roster = []) {
  return extractMedSection(rawText)
    .filter(isMedLine)
    .map((line) => {
      const p = parseMedLine(line)
      if (!p) return null
      const hit = matchDrug(p.name, roster)
      return { ...p, raw: line, matchedKey: hit.key || '', matchScore: hit.score }
    })
    .filter(Boolean)
}

// 候选行 + 已有事件 → 带动作、带默认勾选的最终行列表（UI 直接用）
export function diffMedList(list, events = [], { date = '', roster = [] } = {}) {
  const gs = groupMedCourses(events || [])
  return (list || []).map((row) => reconcileRow({ ...row, checked: null }, { groups: gs, date, roster }))
}

// UI 侧「改了药名要重判」的统一出口（上层无需关心 groupMedCourses）
export function refreshRow(row, events = [], { date = '', roster = [] } = {}) {
  return reconcileRow(row, { groups: groupMedCourses(events || []), date, roster })
}

// 勾选行 → 最小写入计划（幂等：同日同药已有非停药事件 → 覆盖更新而非新增）
export function planMedWrites(rows = [], events = [], date = '') {
  const out = []
  for (const r of rows || []) {
    if (!r.checked) continue
    const name = normalizeDrugName(r.name)
    if (!name || r.dose == null || !Number.isFinite(Number(r.dose))) continue
    const hit = (events || []).find(
      (e) =>
        e.category === 'medication' &&
        normalizeDrugName(e.drug || e.text) === name &&
        e.date === date &&
        (e.time || '') === '' &&
        e.stop !== true
    )
    out.push({ drug: name, dose: Number(r.dose), unit: r.unit || '', mode: hit ? 'update' : 'add', id: hit ? hit.id : null })
  }
  return out
}
