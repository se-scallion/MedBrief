// 报告导入与结构化（问诊资料卡的取数层）
//
// 目标（用户 2026-11-12 定的根本需求）：
//   病友把「病例/报告单」的照片或截图批量丢进来 → OCR/AI 识别 → 结构化 → 查重 → 拼成一页问诊资料卡，
//   给门诊医生 30 秒看懂病情。**数据来源只有用户导入的文件，不读 MedData 的任何库。**
//
// 本文件是纯函数层 + 一个可选的图片拼接实现（依赖 @napi-rs/canvas，来自 MedData 的 node_modules 软链）：
//   - sha256Bytes       精确查重（同一张图重复导入）
//   - dhash64           近重复查重（同一张单子拍两次 / 截图带不同状态栏）
//   - hamming64         汉明距离比较
//   - stitchVertically  多张截图纵向拼接（手机把一张检查单拍成两张时用）
//   - parseLabRows      OCR 文本 → 化验行 [{name,value,unit,refRange,flag,status}]
//   - classifyAnalyte   指标归类（医生关注的血常规/生化/炎症/凝血/铁代谢/免疫/疾病特异…）
//   - buildReportFingerprint 报告级内容指纹（去掉排版噪声后的文本指纹，用于报告查重）
//   - groupForDoctorCard 按医生阅读顺序分组 + 标异常 + 算趋势
//
// 设计原则：**不编造任何临床事实**。识别不出就是空，不做默认值填充。

import { createHash } from 'node:crypto'

// ---------------- 1. 查重：精确 + 近重复 ----------------

export function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 64 位差值哈希（dHash）：缩到 9x8 灰度，比较相邻像素，抗轻微缩放/亮度差。 */
export function dhash64(gray, w = 9, h = 8) {
  if (!gray || gray.length !== w * h) throw new Error(`dhash64: 期望 ${w * h} 个灰度值`)
  let bits = ''
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      bits += gray[y * w + x] > gray[y * w + x + 1] ? '1' : '0'
    }
  }
  return bits // 64 bit 字符串，便于直接存 JSON
}

export function hamming64(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return Number.MAX_SAFE_INTEGER
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

/** 近重复判定阈值：汉明距离 ≤ 6/64 视为同一张单子的不同次拍摄。 */
export const NEAR_DUP_THRESHOLD = 6

export function findDuplicate({ sha256, dhash, reportDate, barcode } = {}, existing = [], threshold = NEAR_DUP_THRESHOLD) {
  for (const it of existing) {
    if (sha256 && it.sha256 === sha256) return { dup: true, kind: 'exact', of: it.id }
  }
  // 近重复护栏（2026-11-13 实测加的）：文本截图的 dHash 只记得版式，
  // 「凝血 07-26」与「凝血 08-04」汉明距离 = 0，14 张不同影像报告会被聚成一簇。
  // 故 dHash 命中必须同时满足「同一份文档」：单号相同，或报告日期相同；两者都没给才退回旧行为。
  const sameDoc = (it) => {
    if (barcode && it.barcode) return barcode === it.barcode
    if (reportDate && it.reportDate) return reportDate === it.reportDate
    return true
  }
  for (const it of existing) {
    if (dhash && it.dhash && sameDoc(it) && hamming64(dhash, it.dhash) <= threshold) {
      return { dup: true, kind: 'near', of: it.id, distance: hamming64(dhash, it.dhash) }
    }
  }
  return { dup: false }
}

// ---------------- 2. 图片拼接（多张截图 → 一张） ----------------

/**
 * 纵向拼接多张 dataURL 图片。用于「一张检查单被手机拍成两张截图」。
 * @napi-rs/canvas 在 MedData 的 node_modules 里（本仓 node_modules 是软链），失败时抛错由调用方降级。
 */
export async function stitchVertically(dataUrls, { gap = 8, bg = '#ffffff' } = {}) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const images = []
  for (const url of dataUrls) {
    const b64 = String(url).replace(/^data:image\/[a-z+]+;base64,/i, '')
    images.push(await loadImage(Buffer.from(b64, 'base64')))
  }
  if (!images.length) throw new Error('没有可拼接的图片')
  const width = Math.max(...images.map((i) => i.width))
  const height = images.reduce((s, i) => s + i.height, 0) + gap * (images.length - 1)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)
  let y = 0
  for (const img of images) {
    ctx.drawImage(img, Math.round((width - img.width) / 2), y)
    y += img.height + gap
  }
  const buf = await canvas.encode('png')
  return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, width, height, count: images.length }
}

// ---------------- 3. 化验行解析 ----------------

const UNIT_RE = /(10\^?\d+\s*\/\s*L|×10\^?\d+\s*\/\s*L|g\/L|mg\/L|mg\/dL|mmol\/L|umol\/L|μmol\/L|U\/L|IU\/L|ng\/mL|pg\/mL|%|fL|pg|mmHg|s|秒|份)/
const REF_RE = /(<|>|≤|≥)?\s*(\d+(?:\.\d+)?)\s*(?:--|—|–|~|〜|-|至)\s*(\d+(?:\.\d+)?)/
// ⚠️ 坑：不能用 \bL\b 判「偏低」—— 单位里的 `/L`、`10^9/L` 全部会误命中，
// 表现为「白细胞 6.83 3.5-9.5 10^9/L」被判成偏低。H/L 必须是独立 token。
const FLAG_MAP = [
  [/[↑⇑]/, 'high'],
  [/[↓⇓]/, 'low'],
  [/(?:^|[\s(（])H(?=$|[\s)）])|偏高|增高|升高/, 'high'],
  [/(?:^|[\s(（])L(?=$|[\s)）])|偏低|降低/, 'low'],
  [/阳性|（\+）|\(\+\)|＋/, 'positive'],
  [/阴性|未检出/, 'negative'],
]

/**
 * 从 OCR 文本解析化验行。宽松匹配：不追求全量，只保证「认出来的不写错，认不出的不瞎填」。
 * 每行形如：`白细胞 6.83 3.5-9.5 10^9/L` / `血红蛋白 113↓ 130-175 g/L` / `血小板 321 ↑`
 */
/**
 * 血常规（+CRP）标准项目序列：序号 → 标准名/代码。
 * 用途：真实单据里常有个别行的**名称块没被 OCR 识别**（实测：NEUT% / BASO% / MO# 三行只剩数值），
 * 行内往往还带着「序号」，于是可以用序号插值把名称补回来 —— 但补回来的名称必须标记 `nameInferred`，
 * 绝不冒充「识别到的」。
 */
export const CBC_ORDER = [
  { ord: 1, code: 'WBC', name: '白细胞' },
  { ord: 2, code: 'NEUT_PCT', name: '中性粒细胞%' },
  { ord: 3, code: 'LYM_PCT', name: '淋巴细胞%' },
  { ord: 4, code: 'MONO_PCT', name: '单核细胞%' },
  { ord: 5, code: 'EO_PCT', name: '嗜酸性粒细胞%' },
  { ord: 6, code: 'BASO_PCT', name: '嗜碱性粒细胞%' },
  { ord: 7, code: 'NEUT_ABS', name: '中性粒细胞#' },
  { ord: 8, code: 'LYM_ABS', name: '淋巴细胞#' },
  { ord: 9, code: 'MONO_ABS', name: '单核细胞#' },
  { ord: 10, code: 'EO_ABS', name: '嗜酸性粒细胞#' },
  { ord: 11, code: 'BASO_ABS', name: '嗜碱性粒细胞#' },
  { ord: 12, code: 'RBC', name: '红细胞' },
  { ord: 13, code: 'Hb', name: '血红蛋白' },
  { ord: 14, code: 'HCT', name: '红细胞压积' },
  { ord: 15, code: 'MCV', name: '平均红细胞体积' },
  { ord: 16, code: 'MCH', name: '平均红细胞血红蛋白含量' },
  { ord: 17, code: 'MCHC', name: '平均红细胞血红蛋白浓度' },
  { ord: 18, code: 'RDW_CV', name: '红细胞分布宽度-CV' },
  { ord: 19, code: 'PLT', name: '血小板' },
  { ord: 20, code: 'PDW', name: '血小板分布宽度' },
  { ord: 21, code: 'MPV', name: '血小板平均体积' },
  { ord: 22, code: 'P_LCR', name: '大血小板比率' },
  { ord: 23, code: 'HS_CRP', name: '全血C反应蛋白' },
]

/**
 * 单位规范化：Vision 会把上标拆成空格/乱码 —— `*10 9/L`、`*10~9/L`、`*10°9/L`、`*109/L`、`*1012/L`、`gL&`。
 * 统一成 `10^9/L` / `10^12/L` / `g/L`；纯噪声单位（`£1`、`£I`）返回空串。
 */
export function normalizeUnit(raw) {
  let u = String(raw || '').trim()
  if (!u) return ''
  if (/^[£¥$*~^°|Il1\s]+$/.test(u)) return ''
  u = u.replace(/^[*~^°£¥|\s]+/, '').replace(/[*~^°£¥|\s]+$/, '')
  u = u.replace(/^10\s*[~^°]?\s*(\d{2})\s*\/\s*L$/i, '10^$1/L') // 1012/L
  u = u.replace(/^10\s*[~^°]?\s*(\d)\s*\/\s*L$/i, '10^$1/L')   // 10 9/L、109/L
  u = u.replace(/^g\s*L&?$/i, 'g/L')
  return u
}


// 名称 → 标准项目码（真实单据里名称混着 OCR 错字：LTS=LYM%、M0%=MONO%、ONPY=MPV、CMCH=MCH、bCRP=HS_CRP）
// ⚠️ 顺序敏感：MCHC 必须在 MCH 之前判；NE#/LY#/MO#/EO#/BA# 必须在 NEUT%/BA% 之前判。
const CBC_NAME_PATTERNS = [
  // 顺序即优先级：越具体越靠前。括号绝对值(#) 必须早于百分比(%)；
  // MCHC 早于 MCH；RDW-SD 早于 RDW-CV；PCT/PDW/MPV/P-LCR 早于泛称「血小板」。
  ['NRBC_ABS', /NRBC#|有核红细胞#/i],
  ['NRBC_PCT', /NRBC%|有核红细胞%/i],
  ['WBC', /WBC|白细胞/i],
  ['NEUT_ABS', /NEUT#|NE#|中性细胞数|中性粒细胞#/i],
  ['LYM_ABS', /LYMPH#|LY#|淋巴细胞数|淋巴细胞#/i],
  ['MONO_ABS', /MONO#|MO#|单核细胞#/i],
  ['EO_ABS', /EO#|嗜酸性粒细胞#/i],
  ['BASO_ABS', /BASO#|BA#|嗜碱性粒细胞#/i],
  ['NEUT_PCT', /NEUT%|中性细胞比率|中性粒细胞%/i],
  ['LYM_PCT', /LTS|LYMPH%|LYM%|淋巴细胞比率|淋巴细胞%/i],
  ['MONO_PCT', /MON0%|M0%|MONO%|单核细胞比率|单核细胞%/i],
  ['EO_PCT', /E0%|EO%|嗜酸性粒细胞%/i],
  ['BASO_PCT', /BAS0%|BA%|嗜碱性粒细胞比率|嗜碱性粒细胞%/i],
  ['MCHC', /MCHC/i], // 不含 CMCH：`CMCH）` 是 OCR 把 (MCH 读坏，属 MCH
  ['MCH', /CMCH|MCH(?!C)/i],
  ['PCT', /PCT|血小板压积/i],
  ['PDW', /PDW|血小板分布/i],
  ['MPV', /MPV|ONPY|平均血小板体积|血小板平均体积|血小顿平均体积/i],
  ['P_LCR', /P-LCR|大型血小板比率|大血小板比率/i],
  ['MCV', /MCV|红细胞平均体积|平均红细胞体积/i],
  ['HCT', /HCT|红细胞压积/i],
  ['RBC', /RBC/],
  ['Hb', /HGB|^血红蛋白|血红蛋白（/i],
  ['RDW_SD', /RDW-SD|标准差/i],
  ['RDW_CV', /RDW-CV|RDW_CV|RDW/i],
  ['PLT', /PLT|血小板(?!压积|分布|平均|体积)/i],
  ['HS_CRP', /CRP|C反应蛋白/i],
  // 非血常规面板的常见项（只用于「行合并/去重的键」与名称归一，不参与 CBC 序号插值）
  ['RET', /网织红细胞|RET%/i],
  ['LDH', /乳酸脱氢|乳酸脫氢|LDH/i],
  ['ALT', /丙氨酸氨基转移酶|ALT/i],
  ['AST', /天门冬氨酸氨基转移酶|AST/i],
  ['TBIL', /总胆红素|TBIL/i],
  ['DBIL', /直接胆红素|DBIL/i],
  ['CREA', /肌酐|CREA/i],
  ['UREA', /尿素|UREA/i],
  ['FERR', /铁蛋白|FERR/i],
  ['DDIMER', /D-二聚体|D二聚体|DDIMER/i],
  ['FIB', /纤维蛋白原|FIB/i],
]

export function detectCbcCode(name = '') {
  const t = String(name || '')
  for (const [code, re] of CBC_NAME_PATTERNS) if (re.test(t)) return code
  return null
}


/**
 * 双栏单据切分：一行并排两套「序号 项目 缩写 结果 单位 参考区间」（实测香河县人民医院版式）。
 * 判据：行内出现**第二处「缩写 + 数值」锚点**（如 `MCH 29.9`、`MCHC 340`），在此前的中文名处切开。
 * ⚠️ 不用像素距离/gutter 猜版式（Manager 实测：按间距切会把单栏切碎 20→6 行；按 gutter 切阈值一抖就崩）。
 * 单栏与合成单据行内只有一个「缩写+数值」锚点 → 原样返回，不触发切分。
 */
export function splitTwoColumnLine(line = '') {
  const text = String(line || '')
  // 锚点 = 「中文项目名 +（可带括号的）英文缩写 + 紧接的数值」。
  // 只用缩写会误命中单位尾巴（`10~9/L 3.5` 里的 `L`），所以必须由中文名起头。
  const re = /([\u4e00-\u9fa5][\u4e00-\u9fa5*$~·]{1,12})\s*(?:[（(]\s*([A-Za-z][A-Za-z0-9%#\-]{0,7})\s*[)）]|([A-Za-z][A-Za-z0-9%#\-]{0,7}))\s*(?=[<>≤≥]?\d)/g
  const hits = [...text.matchAll(re)]
  if (hits.length < 2) return [text]
  // 在第 2 套锚点的「中文名起点」处切开；序号（如 `16大平均血红蛋白量` 的 16）跟着右段走
  let cut = hits[1].index
  while (cut > 0 && /\d/.test(text[cut - 1])) cut--
  if (cut <= 0) return [text]
  const left = text.slice(0, cut).trim()
  const right = text.slice(cut).trim()
  if (!left || !right) return [text]
  return [left, right]
}

/**
 * 拼接产物的行级去重（**只对拼接图启用，单图导入永远不调用**）。
 * 背景（2026-11-12 挂号实测）：重叠带正好切在某项目行中间时，OCR 会把被切的那行在两半里各认一次
 * ——重叠 15/30/50px 三组均复现「血红蛋白」出现 2 行（拼接 13 行 > 期望 12 行）；
 * 而裁掉重叠（0px）虽不重复，却因两半都认不全而**漏掉**该行。故保留重叠 + 去重，不做裁切。
 * 判据：键 = (标准码|名称, 值, 日期)；只合并**同值同日期**的重复，不合并同名不同值（不同日期的复查不算重复）。
 * 留痕：被合并的行标记 `suspectedStitchDuplicate: true` 与 `dedupedFrom: n`，绝不静默删除。
 * @returns {{ rows: Array, merged: number, rawCount: number }}
 */
export function dedupeStitchRows(rows = [], { mark = 'suspectedStitchDuplicate' } = {}) {
  const seen = new Map()
  const out = []
  let merged = 0
  for (const r of rows) {
    const key = `${detectCbcCode(r.name) || r.name}|${r.value}|${r.measuredAt || r.reportDate || ''}`
    const prev = seen.get(key)
    if (prev) {
      prev.dedupedFrom = (prev.dedupedFrom || 1) + 1
      prev[mark] = true
      merged++
      continue
    }
    seen.set(key, r)
    out.push(r)
  }
  return { rows: out, merged, rawCount: rows.length }
}

/**
 * 切块合并（只用于「超高图被切成多块」的场景）：把各块解析出的行按 (标准码|名称, 日期) 分组。
 * 为什么不用 dedupeStitchRows 的「值必须相同」判据：块边界会把某行切残，残行常带**错值**
 * （实测 2000×6424 样本里「血小板 45」在边界块被切出「血小板 10」）。单纯按值去重会把它当新行留下。
 * 做法：同一(码,日期)内**按值投票**——出现次数最多的值胜出（被切断的值只出现一次），
 * 并把冲突与合并都留痕：`chunkMerged` / `dedupedFrom` / `valueConflict`。
 * 语义边界：同一份报告里同一项目只应出现一次；跨日期是同名不同键，不会被合并。
 */
export function mergeChunkRows(rows = []) {
  const groups = new Map()
  for (const r of rows) {
    const key = `${detectCbcCode(r.name) || r.name}|${r.measuredAt || r.reportDate || ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const out = []
  let merged = 0
  let conflicts = 0
  for (const list of groups.values()) {
    const byValue = new Map()
    for (const r of list) {
      const vk = `${r.value}|${r.unit || ''}`
      if (!byValue.has(vk)) byValue.set(vk, [])
      byValue.get(vk).push(r)
    }
    let best = null
    for (const arr of byValue.values()) if (!best || arr.length > best.length) best = arr
    const winner = { ...best[0] }
    if (list.length > 1) {
      winner.chunkMerged = true
      winner.dedupedFrom = list.length
      merged += list.length - 1
    }
    if (byValue.size > 1) {
      winner.valueConflict = true // 块边界切残导致的值冲突：保留多数值，但如实标记
      conflicts++
    }
    out.push(winner)
  }
  return { rows: out, merged, conflicts, rawCount: rows.length }
}

/**
 * 「这一行看起来像化验指标吗」—— 兜底解析的可信度闸门。
 * 实测（2026-11-12 染色体核型报告）：`检测结果(ISCN 2024) 检测结论` 被解析成
 * 项目名「检测结果(ISCN」+ 值 2024（其实是 ISCN 版本号）；退出码 0，`--apply` 会把假指标写库，
 * 比「解析出 0 行」更危险。只做**窄判据**：仅当该行没有任何可信标记（单位 / 参考区间 /
 * 箭头 / 定性结果）时才按「括号未闭合」或「年份型整数」否决；带单位/区间的行一律放行，
 * 避免 OCR 丢单位时误杀真实指标行。被丢的行由 parseLabRows 留痕在 rows.droppedLines。
 */
export function isPlausibleLabRow(row = {}) {
  const name = String(row.name || '')
  const value = String(row.value || '').trim()
  const hasMark = !!(String(row.unit || '').trim() || String(row.refRange || '').trim() || String(row.flag || '').trim())
    || /阴性|阳性|未检出|检出/.test(value)
    || /^[<>≤≥]/.test(value)
  if (hasMark) return true
  const opens = (name.match(/[（(]/g) || []).length
  const closes = (name.match(/[）)]/g) || []).length
  if (opens !== closes) return false
  if (/^(19|20)\d{2}$/.test(value)) return false
  return true
}

export function parseLabRowsDetailed(text = '') {
  const rows = []
  const droppedLines = [] // 被可信度闸门丢掉的原文行（不静默丢：挂在返回值上供适配器写 warning）
  const pending = [] // 无名称行（序号 + 结果 + 参考），循环后按序号插值补名
  let order = 0
  // 先按「双栏锚点」把长行切成若干段，每段各自完整走一遍解析（单栏/合成单据只有一段）
  const segments = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim()
    if (!line) continue
    for (const seg of splitTwoColumnLine(line)) segments.push(seg)
  }

  for (const line of segments) {
    if (line.length > 120) continue
    // 抬头/表头行不是指标（实测：'北京市朝阳区某医院 检验科 样本号 20260920-118 报告日期：2026-09-20'
    // 会被解析成「医院=2026」这种垃圾行）
    // 抬头/表头行不是指标（实测两类混入：① 「…医院 检验科 样本号 … 报告日期：…」被解析成「医院=2026」；
    // ② 「姓名 某某 性别 男 年龄 30」被解析成「姓名=30」，因为行内含数字）
    if (/项目名称|检验科|样本号|标本编号|报告日期|病历号|条码|采样时间|打印时间|审核者|送检|申请项目|标本类型|样本状态|患者ID|住院号|门诊号|^姓名|姓名\s|性别|年龄|床号|^科室|备注/.test(line)) continue

    // 序号前缀：真实单据的行首常带「序号」（版式重建后变成 `12 *红细胞（RBC） 1.85 ...`），
    // 名称正则从中文/字母起头，带序号整行就被丢（实测 23 项只剩 6 行）。先剥掉 1–3 位纯数字序号。
    // 序号可能与名称粘连（双栏右栏实测 `16大平均血红蛋白量 MCH 29.9`），两种形态都要剥
    const ordMatch = line.match(/^(\d{1,3})(?:\s+(?=[^\d.])|(?=[\u4e00-\u9fa5*$~·]))/)
    const lineOrd = ordMatch ? Number(ordMatch[1]) : null
    const body = line.replace(/^\d{1,3}(?:\s+(?=[^\d.])|(?=[\u4e00-\u9fa5*$~·]))/, '')

    // 名称：取行首的中文/字母串（允许括号内中文）
    // ⚠️ 真实单据（2026-11-12 朝阳血常规实测）Vision 会把噪声符号混进名称：`淋巴细胞$（LTS）`、
    // `嗜酸性粒细胞*（E0%）`、`*红细胞（RBC）`、`文血小板（PLT）`。字符类不含 `$ * £ ^ ~` 时
    // **整行被判为无效直接丢弃** —— 23 项的报告因此只剩 3 行。故把噪声符纳入字符类，取出后再清洗。
    const nameMatch = body.match(/^([\u4e00-\u9fa5A-Za-z*$£¥~^°·][\u4e00-\u9fa5A-Za-z0-9()（）\-_/·%#＋+$£¥~^*° ]{1,30}?)\s{1,}(?=[<≤>≥\-\d阴未检阳])/)
    if (!nameMatch) {
      // 无名称行：版式重建后常见「序号 + 结果 + 参考区间」单独成行（名称块没被 OCR 识别）。
      // 先收起来，循环结束后按序号插值补名称（补出来的必须带 nameInferred 标记）。
      const c = body.match(/^(?:(\d{1,3})\s+)?((?:[<>≤≥]\s*)?\d+(?:\.\d+)?)\s*(.*)$/)
      if (c) {
        const tail = c[3] || ''
        if (!/^\s*[-–—一~]\s*\d/.test(tail)) { // 区间下限不是结果值
          pending.push({ ord: c[1] ? Number(c[1]) : lineOrd, value: c[2], tail, order: order++ })
        }
      }
      continue
    }
    const name = nameMatch[1].trim().replace(/^[*$£¥~^°·\s]+|[*$£¥~^°·\s]+$/g, '').replace(/[*$£¥~^°·]/g, '')
    if (!name || /^[0-9]+$/.test(name)) continue

    // 结果值：名称之后的第一个数字（带可选比较符）
    const rest = body.slice(nameMatch[0].length)
    const valMatch = rest.match(/(<|>|≤|≥)?\s*(\d+(?:\.\d+)?)/)
    if (!valMatch) {
      // 定性结果（阴性/阳性）
      const qual = rest.match(/阴性|阳性|未检出|检出/)
      if (!qual) continue
      rows.push({ name, value: qual[0], num: null, unit: '', refRange: '', flag: qual[0] === '阳性' ? 'positive' : 'negative', status: qual[0] === '阳性' ? 'abnormal' : 'normal', rawSnippet: line })
      continue
    }
    // 防「参考区间当成结果」：真实单据里有的行价值块没被识别，只剩参考区间（`PDW £1 9.0-18.1`），
    // 正则会把区间的下限 `9.0` 当结果值（实测 PDW/MPV/P-LCR 三行因此写错值）。
    // 判据：命中的数字**后面紧跟区间分隔符**（如 `9.0-18.1`）→ 它是区间下限，不是结果，整行放弃。
    const tail = rest.slice(valMatch.index + valMatch[0].length)
    if (/^\s*[-–—一~]\s*\d/.test(tail)) continue

    const num = Number(valMatch[2])
    const afterVal = tail

    const unit = normalizeUnit((afterVal.match(UNIT_RE) || body.match(UNIT_RE) || [''])[0])
    const ref = afterVal.match(REF_RE) || body.match(REF_RE)
    const refRange = ref ? `${ref[2]}-${ref[3]}` : ''

    let flag = ''
    for (const [re, f] of FLAG_MAP) {
      if (re.test(rest)) { flag = f; break }
    }

    // 状态判定：先信显式箭头/字母，再看参考区间
    let status = 'unknown'
    if (flag === 'high' || flag === 'positive') status = 'abnormal'
    else if (flag === 'low') status = 'abnormal'
    else if (flag === 'negative') status = 'normal'
    else if (refRange) {
      const [lo, hi] = refRange.split('-').map(Number)
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
        status = num < lo ? 'low' : num > hi ? 'high' : 'normal'
        if (status !== 'normal') flag = status
      }
    }

    const row = {
      name,
      value: valMatch[1] ? `${valMatch[1]}${valMatch[2]}` : String(valMatch[2]),
      num, unit, refRange, flag, status,
      ordinal: lineOrd,
      code: detectCbcCode(name),
      order: order++,
      nameInferred: false,
      // 原文片段：核对表与事后回查都要能指到「具体那一行」（docs/字段字典.md §三 的 rawSnippet）
      rawSnippet: line,
    }
    if (!isPlausibleLabRow(row)) { droppedLines.push(line); continue }
    rows.push(row)
  }

  // ---- 序号插值：给「无名称行」补回标准名（只在序号唯一可定、且该槽位尚未占用时）----
  if (pending.length) {
    // 名称能判出标准码的行：序号可用标准序列补齐（用于计算「缺哪几个序号」）
    for (const r of rows) {
      if (!Number.isFinite(r.ordinal) && r.code) {
        const tpl = CBC_ORDER.find((c) => c.code === r.code)
        if (tpl) r.ordinal = tpl.ord
      }
    }
    const usedOrds = new Set(rows.map((r) => r.ordinal).filter((v) => Number.isFinite(v)))
    const usedCodes = new Set(rows.map((r) => r.code).filter(Boolean))
    const known = rows.filter((r) => Number.isFinite(r.ordinal)).sort((a, b) => a.ordinal - b.ordinal)

    for (const p of pending) {
      let ord = Number.isFinite(p.ord) ? p.ord : null
      if (ord == null) {
        const before = known.filter((r) => r.order < p.order).pop()
        const after = known.filter((r) => r.order > p.order)[0]
        if (before && after && after.ordinal - before.ordinal > 1) {
          const gap = []
          for (let o = before.ordinal + 1; o < after.ordinal; o++) if (!usedOrds.has(o)) gap.push(o)
          if (gap.length === 1) ord = gap[0]
        }
      }
      if (ord == null || usedOrds.has(ord)) continue
      const tpl = CBC_ORDER.find((c) => c.ord === ord)
      if (!tpl || usedCodes.has(tpl.code)) continue

      const ref = p.tail.match(REF_RE)
      const refRange = ref ? `${ref[2]}-${ref[3]}` : ''
      const unit = normalizeUnit((p.tail.match(UNIT_RE) || [''])[0])
      const num = Number(String(p.value).replace(/[^\d.]/g, ''))
      let status = 'unknown'
      let flag = ''
      if (refRange) {
        const [lo, hi] = refRange.split('-').map(Number)
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
          status = num < lo ? 'low' : num > hi ? 'high' : 'normal'
          if (status !== 'normal') flag = status
        }
      }
      rows.push({
        name: tpl.name, value: String(p.value), num, unit, refRange, flag, status,
        ordinal: ord, order: p.order, nameInferred: true, // ⚠️ 名称按序号推定，不是 OCR 识别到的
        rawSnippet: `序号${ord}：${String(p.value)} ${String(p.tail || '').trim()}`.trim(),
      })
      usedOrds.add(ord)
      usedCodes.add(tpl.code)
    }
  }

  const out = rows
    .sort((a, b) => (Number.isFinite(a.ordinal) && Number.isFinite(b.ordinal) ? a.ordinal - b.ordinal : a.order - b.order))
    .map(({ order, ...rest }) => rest)
  return { rows: out, droppedLines }
}

/**
 * 对外契约不变：永远返回**纯数组**（既有 `assert.deepEqual(parseLabRows(''), [])` 等断言依赖）。
 * 需要看「被可信度闸门丢掉哪些行」的调用方改用它上面的 parseLabRowsDetailed。
 */
export function parseLabRows(text = '') {
  return parseLabRowsDetailed(text).rows
}

// ---------------- 4. 指标归类（医生关注什么） ----------------

// 医生 30 秒速读血液科病人时关心的项：异常项优先，但**常规项也要在**（正常值本身是信息）。
export const ANALYTE_CATALOG = {
  DISEASE: {
    label: '疾病特异（骨髓 / 流式 / 遗传）',
    order: 0, // 血液科医生最先看：残留病与遗传标志
    items: {
      骨髓原始细胞: 'BM_BLAST_PCT', 原始细胞比例: 'BM_BLAST_PCT',
      '微小残留病': 'MRD', 'MRD': 'MRD', 融合基因: 'FUSION', 染色体核型: 'KARYOTYPE',
      'BCR-ABL1': 'BCR_ABL1', 基因突变: 'MUTATION',
      // 流式细胞术免疫分型报告单（康圣达/海思特版式）的原文项目名。
      // ⚠️ 必须用**原文名**入目录，不许把它们改写成「原始细胞比例」：报告只说「异常细胞占 85.76%」，
      // 推断成「骨髓原始细胞 85.76%」就是编造临床事实（红线）。原文名同时避免与血常规
      // 「淋巴细胞/单核细胞/粒细胞绝对值」串码（classifyAnalyte 的 includes 双向匹配会误命中）。
      // code 全部对齐 MedData 的字段命名空间（见 docs/字段字典.md）：
      //   FCM_MRD_PCT = MedData 已有的流式流 code（定义即「异常表型细胞/有核细胞 %」），
      //   FCM_CD34_PCT = 本轮新建的标准 code（MedData 侧需同步登记），
      //   custom:fcm-*-pct = MedData 的「字典外项目」命名空间（不占标准 code）。
      '异常细胞占有核细胞比例': 'FCM_MRD_PCT',
      'CD34+细胞占有核细胞比例': 'FCM_CD34_PCT',
      // CD45/SSC 各群细胞占**有核细胞**比例：必须逐条登记原文名。
      // 不登记会被 classifyAnalyte 的 `clean.includes(k)` 模糊匹配串到血常规
      // （实测：`有核红细胞占有核细胞比例` 命中键 `红细胞`→RBC，2.51% 会冒充「红细胞 2.51%」）。
      '粒细胞占有核细胞比例': 'custom:fcm-gran-pct',
      '淋巴细胞占有核细胞比例': 'custom:fcm-lymph-pct',
      '单核细胞占有核细胞比例': 'custom:fcm-mono-pct',
      '有核红细胞占有核细胞比例': 'custom:fcm-nrbc-pct',
      'BCR::ABL1（P190型）': 'BCR_ABL1', 'BCR::ABL1（P210型）': 'BCR_ABL1', 'BCR::ABL1（P230型）': 'BCR_ABL1',
    },
  },
  CBC: {
    label: '血常规',
    order: 1,
    items: {
      白细胞: 'WBC', 白细胞计数: 'WBC',
      中性粒细胞绝对值: 'NEUT_ABS', 中性粒细胞计数: 'NEUT_ABS', '中性粒细胞#': 'NEUT_ABS', 'NE#': 'NEUT_ABS',
      中性粒细胞百分比: 'NEUT_PCT', '中性粒细胞%': 'NEUT_PCT', 中性细胞比率: 'NEUT_PCT',
      淋巴细胞绝对值: 'LYM_ABS', 淋巴细胞计数: 'LYM_ABS', '淋巴细胞#': 'LYM_ABS', 'LY#': 'LYM_ABS',
      淋巴细胞百分比: 'LYM_PCT', '淋巴细胞%': 'LYM_PCT', 淋巴细胞比率: 'LYM_PCT',
      单核细胞绝对值: 'MONO_ABS', 单核细胞计数: 'MONO_ABS', '单核细胞#': 'MONO_ABS',
      单核细胞百分比: 'MONO_PCT', '单核细胞%': 'MONO_PCT',
      嗜酸性粒细胞绝对值: 'EO_ABS', 嗜酸性粒细胞计数: 'EO_ABS', '嗜酸性粒细胞#': 'EO_ABS',
      嗜酸性粒细胞百分比: 'EO_PCT', '嗜酸性粒细胞%': 'EO_PCT',
      嗜碱性粒细胞绝对值: 'BASO_ABS', 嗜碱性粒细胞计数: 'BASO_ABS', '嗜碱性粒细胞#': 'BASO_ABS',
      嗜碱性粒细胞百分比: 'BASO_PCT', '嗜碱性粒细胞%': 'BASO_PCT',
      红细胞: 'RBC', 红细胞计数: 'RBC',
      血红蛋白: 'Hb', 红细胞比积: 'HCT', 红细胞压积: 'HCT',
      红细胞平均体积: 'MCV', 平均红细胞体积: 'MCV', 红细胞平均血红蛋白含量: 'MCH',
      红细胞平均血红蛋白浓度: 'MCHC', 红细胞分布宽度变异系数: 'RDW_CV', 红细胞分布宽度标准差: 'RDW_SD',
      血小板: 'PLT', 血小板计数: 'PLT',
      // ⚠️ 血小板压积用 PLT_PCT，不得用 PCT —— PCT 在本项目统一指「降钙素原」（见 INFLAM）。
      //    旧 detectCbcCode 表里 PCT 指血小板压积，那是 OCR 路径的历史口径，两处不得混用。
      血小板压积: 'PLT_PCT', 血小板分布宽度: 'PDW', 血小板平均体积: 'MPV', 大血小板比率: 'P_LCR',
      网织红细胞: 'RET', '网织红细胞%': 'RET', 有核红细胞: 'NRBC',
    },
  },
  COAG: {
    label: '凝血',
    order: 2,
    items: {
      凝血酶原时间: 'PT', '凝血酶原时间（PT）': 'PT',
      凝血酶原时间比值: 'PTR', 国际标准化比值: 'INR',
      活化部分凝血活酶时间: 'APTT', 活化部分凝血活酶时间APTT: 'APTT',
      凝血活酶时间: 'TT', 纤维蛋白原: 'FIB',
      'D-二聚体': 'D_DIMER', 'D-二聚体（D-Dimer）': 'D_DIMER',
      纤维蛋白原降解产物: 'FDP', '纤维蛋白（原）降解产物': 'FDP',
      抗凝血酶: 'AT3', 抗凝血酶III: 'AT3',
    },
  },
  CHEM: {
    label: '生化 / 脏器功能',
    order: 3,
    items: {
      谷丙转氨酶: 'ALT', 丙氨酸氨基转移酶: 'ALT',
      谷草转氨酶: 'AST', 天门冬氨酸氨基转移酶: 'AST',
      'γ-谷氨酰基转移酶': 'GGT', 'y-谷氨酰基转移酶': 'GGT', 碱性磷酸酶: 'ALP',
      总胆红素: 'TBIL', 直接胆红素: 'DBIL', 间接胆红素: 'IBIL',
      总蛋白: 'TP', 白蛋白: 'ALB', 球蛋白: 'GLOB', 白球比值: 'AG_RATIO',
      肌酐: 'CREA', 尿素: 'BUN', 尿酸: 'UA',
      乳酸脱氢酶: 'LDH', 'α-羟基丁酸脱氢酶': 'HBDH', a羟基丁酸脱氢酶: 'HBDH',
      // ⚠️ 血葡萄糖与尿糖同名靠括号内缩写区分（原文就是 GLU / glu 两种写法，不要归一化大小写）
      葡萄糖: 'GLU', '葡萄糖（GLU）': 'GLU',
      肌酸激酶: 'CK', 肌酸激酶MB同工酶: 'CK_MB', '血清肌酸激酶一MB同工酶': 'CK_MB',
      酶比值: 'AST_ALT_RATIO', '酶比值1': 'AST_ALT_RATIO', '血清肌酸激酶MB同工酶': 'CK_MB',
      钾: 'K', 钠: 'NA', 氯: 'CL', 钙: 'CA', 二氧化碳: 'CO2',
    },
  },
  INFLAM: {
    label: '炎症 / 感染',
    order: 4,
    items: {
      'C反应蛋白': 'CRP', 超敏C反应蛋白: 'HS_CRP', 全血C反应蛋白: 'HS_CRP',
      降钙素原: 'PCT', 血沉: 'ESR', 白介素6: 'IL6',
      '前体NT-proBNP': 'NT_PROBNP', 'NT-proBNP': 'NT_PROBNP',
      '前体NT-proBN': 'NT_PROBNP',
    },
  },
  IRON: {
    label: '铁代谢 / 营养',
    order: 5,
    items: { 铁蛋白: 'FERRITIN', 血清铁: 'FE', 转铁蛋白饱和度: 'TSAT', 叶酸: 'FOLATE', 维生素B12: 'VB12', 维生素C: 'VITC' },
  },
  IMMUNE: {
    label: '免疫 / 免疫球蛋白',
    order: 6,
    items: { 免疫球蛋白G: 'IGG', 免疫球蛋白A: 'IGA', 免疫球蛋白M: 'IGM', 'CD4+': 'CD4', 'CD8+': 'CD8' },
  },
  GAS: {
    label: '血气',
    order: 7,
    items: {
      pH: 'BG_PH', pCO2: 'BG_PCO2', PO2: 'BG_PO2',
      'HCO3-': 'BG_HCO3', HCO3std: 'BG_HCO3_STD', BEecfC: 'BG_BE', Lac: 'LAC',
      // 血气里的 Na/K/Ca/Hct/Glu 与生化同名但**不同测量轴**，必须分 code，
      // 否则血气 Hct 会冒充血常规红细胞比积（实测：血气 Hct 18% 与 HCT 30.4% 并列）。
      Nat: 'BG_NA', 'K+': 'BG_K', 'Cat+': 'BG_CA', Hct: 'BG_HCT', Glu: 'BG_GLU',
    },
  },
  URINE: {
    label: '尿便常规',
    order: 8,
    items: {
      尿比重: 'U_SG', 尿胆原: 'U_UBG', 亚硝酸盐: 'U_NIT', 潜血: 'U_ERY', '潜血（ERY）': 'U_ERY',
      尿镜检: 'U_NS', '尿镜检NSRBC': 'U_NS_RBC', 尿pH: 'U_PH', 'PH（CH）（PH）': 'U_PH',
      蛋白质: 'U_PRO', 白细胞LEU: 'U_LEU', 胆红素BILI: 'U_BIL', 酮体: 'U_KET',
      葡萄糖glu: 'U_GLU', 尿镜检NS: 'U_NS',
      粪便外观: 'S_APPEAR', 粪便隐血试验: 'S_OB', 霉菌: 'S_FUNGUS', 脂肪球: 'S_FAT', 虫卵: 'S_OVA', 夏雷登氏晶体: 'S_CHARCOT',
    },
  },
  MICRO: {
    label: '血型 / 免疫血清 / 病原',
    order: 9,
    items: {
      ABO血型正定型: 'ABO_FWD', ABO血型反定型: 'ABO_REV', ABO血型鉴定: 'ABO', ABO血型酶法鉴定: 'ABO_ENZ',
      'Rh（D）血型鉴定': 'RH_D', 红细胞抗体筛查: 'AB_SCREEN', 抗人球蛋白试验: 'COOMBS',
      乙肝表面抗原: 'HBSAG', 丙型肝炎抗体: 'ANTI_HCV', 艾滋病病毒抗体: 'ANTI_HIV',
      梅毒螺旋体特异性抗体测定: 'ANTI_TP', 甲型肝炎抗体lgM: 'ANTI_HAV_IGM',
      戊型肝炎抗体lgG: 'ANTI_HEV_IGG', 戊型肝炎抗体lgM: 'ANTI_HEV_IGM',
      筛选细胞: 'AB_SCREEN', '筛选细胞II有不规则抗体存在': 'AB_SCREEN', '筛选细胞I性': 'AB_SCREEN',
      '筛选细胞|I': 'AB_SCREEN',
      阳性对照: 'QC_POS', 内部对照: 'QC_NEG',
      甲型流感病毒PCR: 'FLU_A', 乙型流感病毒PCR: 'FLU_B', 呼吸道合胞病毒: 'RSV',
      腺病毒: 'ADENO', 人鼻病毒: 'HRV', 肺炎支原体核酸检测: 'MP',
    },
  },
}

/** classifyAnalyte 的键归一化：去掉空格与所有括号/分隔符，让「原文名」也能精确命中。 */
export function normalizeAnalyteKey(name = '') {
  return String(name || '').replace(/[\s()（）\[\]【】|｜·]/g, '')
}

const NAME_TO_CODE = (() => {
  const map = new Map()
  for (const [cat, def] of Object.entries(ANALYTE_CATALOG)) {
    for (const [name, code] of Object.entries(def.items)) map.set(normalizeAnalyteKey(name), { code, cat, key: normalizeAnalyteKey(name) })
  }
  return map
})()

/**
 * 项目名 → { code, cat }。
 * 三级：① 归一化精确命中 → ② 模糊命中（要求长度差 ≤2，防「红细胞平均血红蛋白含量」被 `血红蛋白` 抢走）→ ③ OTHER。
 * ⚠️ 模糊匹配是历史事故源（MCH 冒充 Hb、`有核红细胞占有核细胞比例` 冒充 RBC），
 *    收紧后仍保底：真实数据里所有已知项都必须在 ① 精确命中（test:labclean 有覆盖率断言）。
 */
export function classifyAnalyte(name = '', { loose = false } = {}) {
  const clean = normalizeAnalyteKey(name)
  if (!clean) return { code: null, cat: 'OTHER' }
  if (NAME_TO_CODE.has(clean)) { const m = NAME_TO_CODE.get(clean); return { code: m.code, cat: m.cat } }
  // ② 前缀命中 + 纯缩写尾巴：`总蛋白TProt` / `钠Na` / `纤维蛋白原FBG` / `国际标准化比值INR`
  //    尾巴必须是纯字母数字缩写（不含中文），否则不允许 —— 防止 `白细胞LEU` 这类同名异轴项被误并入血常规。
  const ABBR_TAIL = /^[A-Za-z0-9\-_/*+.%#HP个]{1,24}$/
  let best = null
  for (const [k, v] of NAME_TO_CODE) {
    if (!k || k.length < 1) continue
    if (clean.startsWith(k)) {
      const tail = clean.slice(k.length)
      if (!tail || ABBR_TAIL.test(tail)) {
        if (!best || k.length > (best.bestKey || '').length) best = { ...v, bestKey: k, how: 'prefix' }
      }
    }
  }
  if (best) return { code: best.code, cat: best.cat }
  // ③ 包含命中的后门：**只给 OCR 脏名用**（调用方必须显式传 loose）。
  //    实测坑：`平均血红蛋白量`（MCH）含 `血红蛋白` 会被并进 Hb，`红细胞分布宽度` 会被并进 RDW ——
  //    正常名称绝不允许走包含匹配，否则「按 code 去重」会静默合并不同项目（35 项变 33 项）。
  if (!loose) return { code: null, cat: 'OTHER' }
  for (const [k, v] of NAME_TO_CODE) {
    if (!k || k.length < 4) continue
    if (clean.includes(k) && clean.length <= k.length * (loose ? 12 : 3)) {
      if (!best || k.length > (best.bestKey || '').length) best = { ...v, bestKey: k, how: 'contains' }
    }
  }
  return { code: null, cat: 'OTHER' }
}

// ---------------- 5. 报告查重（内容指纹） ----------------

/** 报告级指纹：去掉数字里的排版噪声后对「项目名 + 值」排序取哈希，同一份单子重拍也能命中。 */
export function buildReportFingerprint(rows = [], meta = {}) {
  const parts = rows
    .map((r) => `${String(r.name).replace(/\s/g, '')}=${String(r.value).replace(/\s/g, '')}`)
    .sort()
  // 0 行（结论/全文型）报告没有「项目名+值」可区分：同日同院的两份不同报告会撞指纹被判重复。
  // 靠 reportType + 条码补上区分维度；有行报告的口径保持不变（既有精确/内容查重不受影响）。
  const head = rows.length
    ? `${meta.reportDate || ''}|${meta.hospital || ''}|${meta.kind || ''}`
    : `${meta.reportDate || ''}|${meta.hospital || ''}|${meta.kind || ''}|${meta.reportType || ''}|${meta.barcode || ''}`
  return sha256Bytes(Buffer.from(head + '||' + parts.join(';'), 'utf8'))
}

// ---------------- 6. 医生视角分组（资料卡取数） ----------------

export function groupForDoctorCard(rows = []) {
  const groups = []
  for (const [cat, def] of Object.entries(ANALYTE_CATALOG)) {
    groups.push({ cat, label: def.label, order: def.order, items: [] })
  }
  groups.push({ cat: 'OTHER', label: '其他项', order: 9, items: [] })
  const byCat = new Map(groups.map((g) => [g.cat, g]))

  for (const r of rows) {
    // 脏名（OCR 把名称拼成长串）才允许宽松匹配，正常名称一律精确/前缀
    const { code, cat } = classifyAnalyte(r.name, { loose: !!r.nameDirty })
    const g = byCat.get(cat) || byCat.get('OTHER')
    g.items.push({
      name: r.name,
      code: code || null,
      value: r.value,
      num: r.num,
      unit: r.unit,
      refRange: r.refRange,
      flag: r.flag || '',
      abnormal: r.status === 'abnormal' || r.status === 'high' || r.status === 'low',
      reportDate: r.reportDate || '',
      // 兼容字段：资料卡渲染层（lib/intakeCard.js，代诊-Manager 维护）按 r.measuredAt 读日期、
      // 按 g.rows 取组内行。这里补别名，不改语义、不影响既有调用方。
      measuredAt: r.measuredAt || r.reportDate || '',
      status: r.status || '',
      reportId: r.reportId || '',
      // 2026-11-14：行身份与溯源字段（源头赋值、全程透传；前端点行溯源/修正靠 rowKey + rowIndex）
      rowKey: r.rowKey || '',
      rowIndex: Number.isInteger(r.rowIndex) ? r.rowIndex : null,
      reportType: r.reportType || '',
      fileBlobId: r.fileBlobId || '',
    })
  }

  // 组内排序：异常项在前，其后按名称；整组按医生阅读顺序
  for (const g of groups) {
    g.items.sort((a, b) => (Number(b.abnormal) - Number(a.abnormal)) || a.name.localeCompare(b.name, 'zh'))
    g.abnormalCount = g.items.filter((i) => i.abnormal).length
    // 兼容别名：资料卡渲染层按 g.rows[0] 取最新一行（与 items 同一数组引用，不复制）
    g.rows = g.items
  }
  return groups
    .filter((g) => g.items.length)
    .sort((a, b) => a.order - b.order)
}

/** 资料卡顶部摘要：异常项清单 + 缺项提示（缺项本身是信息，医生要知道「没查」还是「没给」）。 */
export function summarizeForCard(groups = []) {
  const abnormal = []
  for (const g of groups) for (const i of g.items) if (i.abnormal) abnormal.push(`${g.label}·${i.name} ${i.value}${i.unit || ''}`)
  const expected = ['WBC', 'Hb', 'PLT']
  const seen = new Set()
  for (const g of groups) for (const i of g.items) if (i.code) seen.add(i.code)
  const missing = expected.filter((c) => !seen.has(c))
  return { abnormalCount: abnormal.length, abnormal, missingBasics: missing }
}
