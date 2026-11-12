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

export function findDuplicate({ sha256, dhash }, existing = [], threshold = NEAR_DUP_THRESHOLD) {
  for (const it of existing) {
    if (sha256 && it.sha256 === sha256) return { dup: true, kind: 'exact', of: it.id }
  }
  for (const it of existing) {
    if (dhash && it.dhash && hamming64(dhash, it.dhash) <= threshold) {
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
 * 把 OCR 的「文字块」重建成表格行（按 y 聚行、行内按 x 排序）。
 * 为什么需要：8008 的 `/api/ocr-vision`（macOS Vision）返回的是**按阅读序排列的单块**，
 * 名称、结果、单位、参考区间各自成块，直接按行喂 parseLabRows 会一行都解析不出来
 * （实测：朝阳医院血常规 1092 字 → 0 行）。
 * 坐标约定：boundingBox 为归一化值，**y 自下而上**（y 越大越靠上），故按 y 降序 = 从上到下。
 * @param {Array} blocks [{ text, boundingBox:{x,y,width,height}, confidence, index }]
 * @param {object} opts { yTolRatio } 同一行的纵向容差（相对块高中位数）
 * @returns {string[]} 每行一条，块间以空格连接（列序即 x 序）
 */
export function blocksToLines(blocks = [], { yTolRatio = 0.6 } = {}) {
  const list = (blocks || [])
    .filter((b) => b && b.text && b.boundingBox)
    .map((b) => ({
      text: String(b.text).trim(),
      x: Number(b.boundingBox.x) || 0,
      y: Number(b.boundingBox.y) || 0,
      h: Number(b.boundingBox.height) || 0,
      cy: (Number(b.boundingBox.y) || 0) + (Number(b.boundingBox.height) || 0) / 2,
      idx: Number(b.index) || 0,
    }))
    .filter((b) => b.text)
  if (!list.length) return []

  const heights = list.map((b) => b.h).filter((h) => h > 0).sort((a, b) => a - b)
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0.02
  const tol = Math.max(medH * yTolRatio, 0.004)

  // 自上而下：cy 大者在先（y 自下而上）
  list.sort((a, b) => b.cy - a.cy || a.x - b.x)
  const rows = []
  for (const b of list) {
    const cur = rows[rows.length - 1]
    if (cur && Math.abs(cur.cy - b.cy) <= tol) {
      cur.blocks.push(b)
      cur.cy = (cur.cy * (cur.blocks.length - 1) + b.cy) / cur.blocks.length
    } else {
      rows.push({ cy: b.cy, blocks: [b] })
    }
  }
  return rows
    .map((r) => r.blocks.sort((a, b) => a.x - b.x).map((b) => b.text).join(' '))
    .filter((line) => line.trim())
}

export function parseLabRows(text = '') {
  const rows = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim()
    if (!line || line.length > 120) continue
    // 抬头/表头行不是指标（实测：'北京市朝阳区某医院 检验科 样本号 20260920-118 报告日期：2026-09-20'
    // 会被解析成「医院=2026」这种垃圾行）
    if (/项目名称|检验科|样本号|报告日期|病历号|条码|采样时间|打印时间|审核者|送检/.test(line)) continue

    // 名称：取行首的中文/字母串（允许括号内中文）
    const nameMatch = line.match(/^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9()（）\-_/·%#＋+ ]{1,30}?)\s{1,}(?=[<≤>≥\-\d阴未检阳])/)
    if (!nameMatch) continue
    const name = nameMatch[1].trim()
    if (!name || /^[0-9]+$/.test(name)) continue

    // 结果值：名称之后的第一个数字（带可选比较符）
    const rest = line.slice(nameMatch[0].length)
    const valMatch = rest.match(/(<|>|≤|≥)?\s*(\d+(?:\.\d+)?)/)
    if (!valMatch) {
      // 定性结果（阴性/阳性）
      const qual = rest.match(/阴性|阳性|未检出|检出/)
      if (!qual) continue
      rows.push({ name, value: qual[0], num: null, unit: '', refRange: '', flag: qual[0] === '阳性' ? 'positive' : 'negative', status: qual[0] === '阳性' ? 'abnormal' : 'normal' })
      continue
    }
    const num = Number(valMatch[2])
    const afterVal = rest.slice(valMatch.index + valMatch[0].length)

    const unit = (afterVal.match(UNIT_RE) || line.match(UNIT_RE) || [''])[0].replace(/\s+/g, '')
    const ref = afterVal.match(REF_RE) || line.match(REF_RE)
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

    rows.push({ name, value: valMatch[1] ? `${valMatch[1]}${valMatch[2]}` : String(valMatch[2]), num, unit, refRange, flag, status })
  }
  return rows
}

// ---------------- 4. 指标归类（医生关注什么） ----------------

// 医生 30 秒速读血液科病人时关心的项：异常项优先，但**常规项也要在**（正常值本身是信息）。
export const ANALYTE_CATALOG = {
  CBC: {
    label: '血常规',
    order: 1,
    items: {
      白细胞: 'WBC', 中性粒细胞绝对值: 'NEUT_ABS', 中性粒细胞百分比: 'NEUT_PCT',
      血红蛋白: 'Hb', 红细胞: 'RBC', 血小板: 'PLT', 网织红细胞: 'RET',
      淋巴细胞绝对值: 'LYM_ABS', 单核细胞绝对值: 'MONO_ABS', 红细胞压积: 'HCT', 平均红细胞体积: 'MCV',
    },
  },
  CHEM: {
    label: '生化 / 脏器功能',
    order: 2,
    items: {
      谷丙转氨酶: 'ALT', 丙氨酸氨基转移酶: 'ALT', 谷草转氨酶: 'AST', 天门冬氨酸氨基转移酶: 'AST',
      总胆红素: 'TBIL', 直接胆红素: 'DBIL', 白蛋白: 'ALB', 肌酐: 'CREA', 尿素: 'BUN', 尿酸: 'UA',
      乳酸脱氢酶: 'LDH', 钾: 'K', 钠: 'NA', 钙: 'CA', 葡萄糖: 'GLU',
    },
  },
  INFLAM: {
    label: '炎症 / 感染',
    order: 3,
    items: { 'C反应蛋白': 'CRP', 超敏C反应蛋白: 'HS_CRP', 降钙素原: 'PCT', 血沉: 'ESR', 白介素6: 'IL6' },
  },
  COAG: {
    label: '凝血',
    order: 4,
    items: { 凝血酶原时间: 'PT', 活化部分凝血活酶时间: 'APTT', 纤维蛋白原: 'FIB', 'D-二聚体': 'D_DIMER', 国际标准化比值: 'INR' },
  },
  IRON: {
    label: '铁代谢 / 营养',
    order: 5,
    items: { 铁蛋白: 'FERRITIN', 血清铁: 'FE', 转铁蛋白饱和度: 'TSAT', 叶酸: 'FOLATE', 维生素B12: 'VB12' },
  },
  IMMUNE: {
    label: '免疫 / 免疫球蛋白',
    order: 6,
    items: { 免疫球蛋白G: 'IGG', 免疫球蛋白A: 'IGA', 免疫球蛋白M: 'IGM', 'CD4+': 'CD4', 'CD8+': 'CD8' },
  },
  DISEASE: {
    label: '疾病特异（骨髓 / 流式 / 遗传）',
    order: 0, // 血液科医生最先看：残留病与遗传标志
    items: {
      骨髓原始细胞: 'BM_BLAST_PCT', 原始细胞比例: 'BM_BLAST_PCT',
      '微小残留病': 'MRD', 'MRD': 'MRD', 融合基因: 'FUSION', 染色体核型: 'KARYOTYPE',
      'BCR-ABL1': 'BCR_ABL1', 基因突变: 'MUTATION',
    },
  },
}

const NAME_TO_CODE = (() => {
  const map = new Map()
  for (const [cat, def] of Object.entries(ANALYTE_CATALOG)) {
    for (const [name, code] of Object.entries(def.items)) map.set(name, { code, cat })
  }
  return map
})()

export function classifyAnalyte(name = '') {
  const clean = String(name).replace(/[\s()（）]/g, '')
  if (NAME_TO_CODE.has(clean)) return NAME_TO_CODE.get(clean)
  for (const [k, v] of NAME_TO_CODE) {
    if (clean.includes(k) || k.includes(clean)) return v
  }
  return { code: null, cat: 'OTHER' }
}

// ---------------- 5. 报告查重（内容指纹） ----------------

/** 报告级指纹：去掉数字里的排版噪声后对「项目名 + 值」排序取哈希，同一份单子重拍也能命中。 */
export function buildReportFingerprint(rows = [], meta = {}) {
  const parts = rows
    .map((r) => `${String(r.name).replace(/\s/g, '')}=${String(r.value).replace(/\s/g, '')}`)
    .sort()
  const head = `${meta.reportDate || ''}|${meta.hospital || ''}|${meta.kind || ''}`
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
    const { code, cat } = classifyAnalyte(r.name)
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
