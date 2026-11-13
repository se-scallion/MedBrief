// ===================== 影像/心电报告解析引擎 =====================
// 与化验单（表格 OCR）不同，这类报告是「结论型文本 + 少量测量值」，
// 无法完全结构化。策略：提取一切能提取的内容（全文/日期/类型/所见/结论/测量值），
// 生成可检索的解析索引；原件 PDF 由 docFileStore.js 完整保存。

import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PATCHES } from '../data/patches.js'
import { applyPatches } from '../data/applyPatches.js'

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker
}

// ---------- PDF 全文提取 ----------

async function dataUrlToBuffer(dataUrl) {
  const b64 = dataUrl.split(',')[1] || ''
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf
}

// 普通报告：按 y 聚行、行内按 x 排序（保留阅读顺序）
function joinLinesByY(items) {
  const byY = {}
  for (const it of items) {
    ;(byY[it.y] = byY[it.y] || []).push(it)
  }
  return Object.keys(byY)
    .map(Number)
    .sort((a, b) => b - a) // PDF y 轴向下为正
    .map((y) => byY[y].sort((a, b) => a.x - b.x).map((i) => i.str).join(' ').trim())
    .filter(Boolean)
}

// 变异表格页判定：基因检测「临床意义未明突变」是典型多列表格，表头含「变异位点」「变异类型」
function isVariantTablePage(items) {
  let hasLocus = false
  let hasType = false
  for (const it of items) {
    if (it.str.includes('变异位点')) hasLocus = true
    if (it.str.includes('变异类型')) hasType = true
    if (hasLocus && hasType) return true
  }
  return false
}

// 变异表格重建：单个变异跨多行（基因/NM_/外显子/类型/ID 在不同 y 但同属一个变异块）。
// 做法：最左列（基因列 x<=80）的每个基因符号是一个变异锚点；其余单元格按 y 距离归入最近的
// 基因锚点（离所有锚点过远者如页脚 SNID/页码直接丢弃，避免污染变异行）；块内按列 x 升序拼接，
// 输出「一行一个变异」的干净文本，避免列被逐行阅读顺序交错。
export function rebuildVariantTable(items) {
  const isGene = (it) => it.x <= 80 && /^[A-Z][A-Za-z0-9]+$/.test(it.str.trim()) && it.str.trim().length >= 2 && it.str.trim().length <= 8
  const geneCol = items.filter(isGene).sort((a, b) => b.y - a.y)
  if (geneCol.length < 2) return joinLinesByY(items)
  const topY = geneCol[0].y
  const variantClusters = geneCol.map((g) => [g])
  const header = items.filter((it) => it.y > topY)
  const clusters = header.length ? [header, ...variantClusters] : variantClusters
  for (const it of items) {
    if (isGene(it) || it.y > topY) continue
    let best = 0
    let bestD = Infinity
    for (let k = 0; k < geneCol.length; k++) {
      const d = Math.abs(it.y - geneCol[k].y)
      if (d < bestD) { bestD = d; best = k }
    }
    if (bestD > 150) continue // 页脚等远处内容丢弃，避免污染变异行
    variantClusters[best].push(it)
  }
  return clusters.map((cl) => cl.sort((a, b) => a.x - b.x).map((i) => i.str).join(' ').trim()).filter(Boolean)
}

// 读取 File（PDF）→ 提取所有页文本层（保留行结构）
// 返回：{ pageCount, text, isScanned }
export async function extractDocContent(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

  const buf = await dataUrlToBuffer(dataUrl)
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const pageCount = pdf.numPages
  const lines = []

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i)
    const tc = await page.getTextContent()
    const items = []
    for (const item of tc.items) {
      if (!item.str || !item.str.trim()) continue
      items.push({ x: Math.round(item.transform[4]), y: Math.round(item.transform[5]), str: item.str })
    }
    // 基因检测报告的「临床意义未明突变」是典型多列表格（单个变异跨多行）。
    // 此类页改用表格感知重建：按 y 间距聚成变异块、块内按列 x 重排，输出「一行一变异」；
    // 其余页保持原按 y 逐行拼接逻辑，避免影响其他报告类型。
    const pageLines = isVariantTablePage(items) ? rebuildVariantTable(items) : joinLinesByY(items)
    lines.push(...pageLines)
  }

  const text = lines.join('\n')
  return { pageCount, text, isScanned: text.trim() === '' }
}

// ---------- 报告类型识别 ----------

// 「骨髓」的 OCR 形近误识归一（与 reportKind.fixOcrVariants 同口径）。
// 变体实测（794 骨髓活检 1071px 图）：×1 读「骨骨/骨崩」、×1.68 读「骨亿/骨项」，
// 标题与「取材」字段都会命中，统一归一。
function fixOcrVariants(text) {
  return String(text || '').replace(/骨通|骨随|骨骨|骨亿|骨项|骨崩/g, '骨髓')
}

// 标题行识别：**按标题分类**（用户口径 2026-10-20：「文书要和标题强相关，根据标题来分类」）。
// 只看抬头前 6 个非空行里第一条「像标题」的行——标题/医院名几乎总在这几行，正文段落不会跑上来。
// 三条排除规则，都是为了不让正文里的引用语冒充标题：
//   ① 「详见出院记录」「另附诊断证明书」这类引用语不是标题；
//   ② 标题行不会很长（>40 字的必是正文）；
//   ③ 只在前 6 行找，压住「出院记录正文中途出现『诊断证明书另开』」的场景。
const TITLE_LIKE_RE = /出院记录|出院小结|出[院医辽联]记录|诊断证明书|病情证明书|诊断证明|病情证明/
const TITLE_NOT_RE = /详见|另见|另附|另开|开具|参见|如上/
function titleLine(text, n = 6) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
  for (const ln of lines) {
    const flat = ln.replace(/\s+/g, '')
    if (!TITLE_LIKE_RE.test(flat)) continue
    if (TITLE_NOT_RE.test(flat)) continue
    if (flat.length > 40) continue
    return flat
  }
  return ''
}

// 病历文书两类标题的识别词。「出院诊断证明书」同时含「诊断证明」与「出院」前缀，故用两个
// 词表分级判定，不靠谁先命中：抬头 → 正文双证据 → 正文单关键词。
const DOC_CERT_RE = /诊断证明书|病情证明书|出院诊断证明|诊断证明|病情证明/
const DOC_DISCHARGE_RE = /出院记录|出院小结|出[院医辽联]记录/

function detectDocType(text) {
  const t = text.replace(/\s+/g, '')
  const has = (re) => re.test(t)
  // 病历文书：出院记录 / 诊断证明（出院小结等同出院记录）。两类必须最优先判定，且证据分级：
  //   ① **标题行**（前 6 行里第一条像标题的行，含 OCR 变体）——最强，命中即定，不看正文；
  //   ② 正文「出院类章节 + 入院类章节」同时出现——出院记录正文的稳定特征，基因/影像报告不会
  //      同时具备（血液科出院记录正文几乎必含「融合基因/染色体」，漏判就会被下方 genetic 分支吞掉）；
  //   ③ 正文单关键词兜底（标题被 OCR 打烂时）。
  // 为什么不能只看「谁先命中」：出院诊断证明书正文写着「出院医嘱：详见出院记录」，全文匹配
  // 「出院记录」会把证明书判成出院记录 → 再按出院记录的章节切段 → 把页脚「说明：1. 本证明书
  // 一式两份…」当成出院诊断/医嘱、入院日期与住院天数抽空（2026-10-20 真机实测，用户报障）。
  const hasDischargeChapters =
    has(/出院日期|出院诊断|出院医嘱|出院情况/) && has(/入院日期|入院情况|入院初步诊断/)
  // 标题行命中即定（标题里同时含「出院」与「诊断证明书」的，按证书处理——先判 cert）
  const title = titleLine(text)
  if (title) {
    if (DOC_CERT_RE.test(title)) return { kind: 'cert', doc_type: '诊断证明' }
    return { kind: 'discharge', doc_type: '出院记录' }
  }
  if (hasDischargeChapters) return { kind: 'discharge', doc_type: '出院记录' }
  // 抬头被 OCR 打烂时的兜底：证明书正文几乎必写「诊断证明书」；只有它没有出院记录字样才认
  if (DOC_CERT_RE.test(t)) return { kind: 'cert', doc_type: '诊断证明' }
  if (DOC_DISCHARGE_RE.test(t)) return { kind: 'discharge', doc_type: '出院记录' }
  // 流式细胞术（FCM）免疫分型 / 白血病免疫表型：最优先判定，须排在基因检测与骨髓之前。
  // 理由：流式报告的结论模板几乎必写「请结合融合基因、基因检测、染色体、骨髓细胞形态学…」，
  // 这些引用性文字会分别触发下方 gene / bonemarrow 分支，把流式报告误判成基因检测或骨穿
  // （实测本例标本类型是「血」，被判成骨穿会污染时间线）。关键词取流式专属词：
  // 抗原 panel「所检测抗原」、设门「CD45/SSC」、报告抬头「免疫表型/免疫分型」「流式细胞」。
  if (has(/流式细胞|免疫表型|免疫分型|所检测抗原|CD45\/SSC|设门/i)) {
    return { kind: 'flow', doc_type: '流式免疫分型' }
  }
  // 基因检测报告优先：文档型、非数值化验单，归入归档。关键词取高区分度词，
  // 避免「无家族遗传史」等普通文本误触发（故不用裸「遗传」）；且须在 CT 之前判定，
  // 否则附录基因列表里的 ACTB/CTCF 等会触发裸 CT 误判。
  if (has(/基因检测|基因测序|基因芯片|基因变异|染色体|拷贝数变异|NGS|二代测序|高通量测序|FISH检测/)) {
    if (has(/核型|染色体芯片|染色体微阵列|染色体核型|微阵列|array|CGH/)) return { kind: 'genetic', doc_type: '染色体/芯片' }
    return { kind: 'genetic', doc_type: '基因检测' }
  }
  if (has(/心电图/)) return { kind: 'ecg', doc_type: '心电图' }
  if (has(/超声|彩超/)) {
    // 命名规范：统一用「模态 + 部位」，把检查技术「彩色多普勒（彩超）」收进「超声」大类，
    // 避免「技术名」与「部位名」混排造成归类歧义（如超声心动图既叫超声也叫彩超）。
    // 注意：各彩超页脚都带「EF:左心室射血分数」注释，不能用 EF/射血分数判断心脏
    if (has(/心脏|左房|右房|左室|右室|室间隔|心包|二尖瓣|三尖瓣|主动脉瓣/)) return { kind: 'ultrasound', doc_type: '超声心动图' }
    if (has(/生殖|阴囊|附睾|睾丸|前列腺|精囊/)) return { kind: 'ultrasound', doc_type: '生殖超声' }
    if (has(/浅表|淋巴结|颈部|甲状腺|乳腺/)) return { kind: 'ultrasound', doc_type: '浅表超声' }
    if (has(/下肢|股总|股浅|腘|胫前|胫后|大隐静脉|小隐静脉|股静脉|腘静脉|小腿肌间|足背动脉|踝动脉/)) return { kind: 'ultrasound', doc_type: '下肢超声' }
    if (has(/腹部|肝|胆囊|胆|脾|胰腺|胰|肾/)) return { kind: 'ultrasound', doc_type: '腹部超声' }
    return { kind: 'ultrasound', doc_type: '超声' }
  }
  // 裸 CT 需排除前后紧跟字母（否则「HCT」「ACTB」「CTCF」等会被误判为 CT 检查）
  if (has(/(^|[^A-Za-z])CT(?![A-Za-z])|计算机断层/)) return { kind: 'ct', doc_type: 'CT' }
  if (has(/磁共振|MRI/)) return { kind: 'mri', doc_type: '磁共振MRI' }
  if (has(/X线|X-Ray|DR|数字摄影/)) return { kind: 'xray', doc_type: 'X线/DR' }
  if (has(/胃镜|肠镜|内镜/)) return { kind: 'endoscopy', doc_type: '内镜' }
  // 骨髓 / 细胞形态学图文报告（骨穿）：报告主体是「检查所见 / 诊断意见」图文描述，
  // 按检查报告归档（用户定稿 2026-09-10，见 bugs.md Bug 087）。须在 other 之前判定，
  // 否则会落「其他检查」再触发 AI 读图兜底、被旧逻辑切去化验页。
  // 「骨通/骨随」是「骨髓」的 OCR 形近误识（与 reportKind.fixOcrVariants 同口径）。
  // 病理 / 活检报告（骨髓活检、淋巴结活检、组织病理）：主体是「镜下所见 / 免疫组化 /
  // 综合诊断」。须排在骨髓分支之前——骨髓活检报告常含「未见巨核细胞」会被骨髓分支先吞成
  // 「骨髓形态学（骨穿）」（实测 2026-09-12）；又须排在内镜/超声之后（「胃镜取活检」
  // 「超声引导穿刺活检」属内镜/超声报告，不能改判病理）。
  if (has(/活检|病理诊断|病理报告|病理学检查|组织病理|免疫组化|镜下所见/)) {
    return { kind: 'pathology', doc_type: '病理活检' }
  }
  if (has(/骨髓|骨通|骨随|骨穿|细胞形态学|涂片分类|粒红比|巨核细胞/)) return { kind: 'bonemarrow', doc_type: '骨髓形态学（骨穿）' }
  return { kind: 'other', doc_type: '其他检查' }
}

// ---------- 日期/时间提取（优先带时分，优先“检查时间”） ----------

// 同时识别「检查时间」与「报告时间」（两者可能不是同一天）。
// 返回 { date, time, reported_at }：
//   - date/time: 检查时间（优先“检查”类标签，其次全文首个带时分日期）
//   - reported_at: 报告时间 'YYYY-MM-DD[ HH:mm]'，与检查时间不同才记录；
//                  无报告标签时取全文最后一个不同日期
function extractDateTime(text) {
  const re = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[ T](\d{1,2})[:：;]+(\d{2}))?/g
  const matches = [...text.matchAll(re)]
  if (!matches.length) return null

  const fmt = (m) => ({
    date: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`,
    time: m[4] ? `${String(m[4]).padStart(2, '0')}:${m[5]}` : '',
  })

  // 标签后 40 字符内找第一个日期（标签与日期间可能被 OCR 插空格/冒号/换行）
  const afterLabel = (keys) => {
    for (const k of keys) {
      const idx = text.indexOf(k)
      if (idx < 0) continue
      const m = text
        .slice(idx + k.length, idx + k.length + 40)
        .match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[ T](\d{1,2})[:：;]+(\d{2}))?/)
      if (m) return fmt(m)
    }
    return null
  }

  // 宽松标签词（检查/报告）：须独立成词且日期紧跟同行（仅空格/冒号间隔），
  // 避免「检查所见」「报告编号」等普通词被误判
  const bareLabel = (keys) => {
    const re = (k) =>
      new RegExp(
        `(^|[^\\u4e00-\\u9fa5A-Za-z0-9])${k}[ \\t]{0,2}[:：;]?[ \\t]{0,2}(\\d{4})[-/年.](\\d{1,2})[-/月.](\\d{1,2})日?(?:[ T](\\d{1,2})[:：;]+(\\d{2}))?`
      )
    for (const k of keys) {
      const m = text.match(re(k))
      if (!m) continue
      return {
        date: `${m[2]}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`,
        time: m[5] ? `${String(m[5]).padStart(2, '0')}:${m[6]}` : '',
      }
    }
    return null
  }

  // 1) 标签优先：检查类 → 检查时间；报告类 → 报告时间。
  //    病理/活检报告没有「检查时间」标签，最早的检查相关日期是标本「接收/送检/取样」日期
  //    （实测 794 骨髓活检：接收 2026-08-05、报告 2026-08-11；不收这些标签时 checked 落空，
  //    date 会被迫回退成报告时间、reported_at 反而丢掉）。
  //    「采取/取材/采样」是标本类报告（骨穿、活检）对采集动作的另一种写法——朝阳医院骨穿报告写
  //    「采取日期 2026.10.10」，旧表不收这三个词 → checked 落空 → 退化成「取全文第一个日期」，
  //    而该报告末尾还有「回报日期 2026.10.12」，OCR 一旦把 2026 读成 2006 就把 date 读成 2006-10-12
  //    （2026-10-25 实测，直接导致归档查重漏判重复）。补标签即从根上钉住采集日。
  const checked =
    afterLabel([
      '检查时间', '检查日期', '采集时间', '采集日期',
      '接收时间', '接收日期', '送检日期', '取样日期',
      '采取日期', '采取时间', '取材日期', '取材时间', '采样日期', '采样时间',
    ]) || bareLabel(['检查']) || null
  const reported =
    afterLabel([
      '报告时间', '报告日期', '签发时间', '签发日期', '出报告时间',
      '回报时间', '回报日期', // 骨穿/细胞形态报告常用「回报日期」写法
    ]) ||
    bareLabel(['报告']) ||
    null
  if (checked || reported) {
    const c = checked || reported // 只有报告标签时，检查时间回退为报告时间
    const r = reported && (reported.date !== c.date || reported.time !== c.time) ? reported : null
    return {
      date: c.date,
      time: c.time,
      reported_at: r ? `${r.date}${r.time ? ' ' + r.time : ''}` : '',
    }
  }

  // 2) 无标签：带时分优先（检查一般早于报告，取首尾）
  const withTime = matches.filter((m) => m[4])
  if (withTime.length) {
    const first = fmt(withTime[0])
    const last = fmt(withTime[withTime.length - 1])
    const r = last.date !== first.date || last.time !== first.time ? last : null
    return {
      date: first.date,
      time: first.time,
      reported_at: r ? `${r.date} ${r.time}` : '',
    }
  }

  // 3) 仅日期：第一个为检查，最后一个不同日期为报告
  const first = fmt(matches[0])
  const last = fmt(matches[matches.length - 1])
  return {
    date: first.date,
    time: first.time,
    reported_at: last.date !== first.date ? last.date : '',
  }
}

// ---------- 报告标题 ----------

// 标题行常因 PDF 分栏被重复拼接（如「彩色多普勒超声检查报告单 彩色多普勒超声检查报告单」），去掉后半重复
function dedupeHalf(s) {
  const t = s.trim()
  if (t.length >= 4 && t.length % 2 === 0 && t.slice(0, t.length / 2) === t.slice(t.length / 2)) {
    return t.slice(0, t.length / 2)
  }
  return t
}

// ---------- 检验 / 检测项目（优先于通用报告名作标题） ----------
// 同类报告的不同页常共用一个通用名（如整本基因报告每页都叫「基因检测报告」），
// 而「检验项目」字段才是本页真正的检查内容（TP53 突变 / IgH 基因重排 / CSRP2 基因表达…）。
// 命中该字段时直接用作标题，便于归档列表一眼区分各页。
function extractTestItem(lines) {
  for (const line of lines) {
    const m = line.match(/(?:检验项目|检测项目)\s*[:：]?\s*(.+)$/)
    if (!m) continue
    const v = m[1].replace(/[，。,;；\s]+$/, '').trim()
    if (v.length < 2 || v.length > 30) continue
    if (/^\d+$/.test(v)) continue // 纯数字（页码/编号）不作标题
    return v
  }
  return ''
}

function detectTitle(lines) {
  for (const line of lines) {
    // OCR 常在一行内插入大量对齐空格（如「Sa     CT检查报告单影像号: T000035237」），压缩后判断
    const compact = line.replace(/[ \t\u3000]+/g, ' ').trim()
    const t = dedupeHalf(compact)
    if (t.length < 2 || t.length > 40) continue
    // 排除字段行 / 页脚注释行（避免「注：本报告…超声医师…」这类含关键词的注释被误判为标题）
    if (/^注[:：]|^注释[:：]?|^仅供|^本报告|^签名|^当前页|^总页数|^报告日期|^报告时间/.test(t)) continue
    if (/报告时间|报告日期|检查时间|检查日期|住院号|姓名|检查部位|检查项目|检查方法|所见|描述|结论|诊断|提示/.test(t)) continue
    const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length
    // 明确的中文报告名关键词
    // 「活检报告」入关键词：病理报告标题「骨髓活检报告」不含「报告单」，不收则永远落兜底名
    // （实测 794：OCR 标题行「骨亿活检报告」归一为「骨髓活检报告」后仍被判非标题）
    const kw = /报告单|检查单|彩色多普勒|心电图|超声|磁共振|X线|X-Ray|基因检测|检测报告|基因测序|基因芯片|活检报告/i
    // CT 类：要求行内含中文（避免「CTATBIRG」这类纯字母 OCR 乱码被误判为标题）
    const ctKw = /^CT[检查平扫增强扫描]|胸部CT|CT检查|CT报告|CT扫描/i
    const bareKw = /^(心电图报告单|超声检查报告|CT检查报告|MRI检查报告|磁共振检查报告|X线检查报告|彩色多普勒检查报告)$/
    if (kw.test(t) || (cn > 0 && ctKw.test(t)) || bareKw.test(t.trim())) {
      // 标题行常被拼入后续字段（「CT检查报告单 影像号: T000035237」），提取核心「X检查报告单」
      const m = t.match(/([\u4e00-\u9fa5A-Za-z]{2,}报告单)/)
      if (m) return m[1]
      // 去掉行首 OCR 噪声（如「Sa CT检查报告音光」）后，必须仍然以报告关键词结尾，
      // 否则说明该行已被 OCR 污染，继续向下找更干净的标题行。
      const cleaned = t.replace(/^[^\u4e00-\u9fa5]+/, '')
      if (/(报告单|检查单|检查报告|超声|心电图|磁共振|X线|多普勒|检查|报告)$/i.test(cleaned) || bareKw.test(cleaned)) {
        return cleaned
      }
      continue
    }
    // CT/MR 检查项目行即标题（如「腹部（上腹+下腹）+盆腔 CT 平扫」「头颅 CT 增强」）：
    // 形如「中文部位串 + CT/MR + 平扫/增强/扫描」，且不含「报告」字样（避免与页眉「CT诊断报告单」混淆）、
    // 不含 所见/诊断/描述 等章节词（避免 所见 行里提及 CT 平扫 被误当标题）。
    // CT/MR 检查项目行即标题（如「腹部（上腹+下腹）+盆腔 CT 平扫」「头颅 CT 增强」）：
    // 行内含「CT/MR/MRI + 平扫/增强/扫描/成像」且以中文开头，且不含「报告」字样（避免与页眉「CT诊断报告单」混淆）、
    // 不含 所见/诊断/描述 等章节词（避免 所见 行里提及 CT 平扫 被误当标题）。取「部位 + 模态」整段作标题。
    const examKw = /(?:CT|MR|MRI)\s*(?:平扫|增强|扫描|成像)/
    if (examKw.test(t) && /^[\u4e00-\u9fa5]/.test(t) && !/报告|所见|诊断|描述|提示|结论|序列|影像|扫描序列/.test(t)) {
      const em = t.match(/^.*?(?:CT|MR|MRI)\s*(?:平扫|增强|扫描|成像)/i)
      if (em) {
        const cand = em[0].replace(/[，。、,.\s:：]+$/, '').trim()
        if (cand && !/^(北京|首都|附属|人民|中心|医院|大学)/.test(cand)) return cand
      }
    }
  }
  return ''
}

// 报告标题机构前缀裁剪：如「首都医科大学附属北京朝阳医院常营院区心电图报告」
// →「心电图报告」。仅当标题确以机构边界词开头、且其后仍是报告关键词时才裁剪，
// 避免误伤「动态心电图报告」「超声报告」等（无机构前缀或含修饰词）的标题。
const HOSP_BOUNDARY = ['医科大学', '医学院', '医院', '院区', '附属', '中心', '医疗', '门诊', '诊疗']
function stripHospitalPrefix(t) {
  if (!t) return t
  let cut = -1
  for (const h of HOSP_BOUNDARY) {
    const i = t.lastIndexOf(h)
    if (i >= 0) cut = Math.max(cut, i + h.length)
  }
  if (cut > 0 && cut < t.length) {
    const rest = t.slice(cut)
    if (/(心电图|超声|彩色多普勒|磁共振|X线|CT|报告单|检查报告|报告)$/.test(rest)) return rest
  }
  return t
}

// 剔除心电图/影像波形网格被 OCR 误读成的乱码行（大量「| [ ]」隔开的孤立汉字），
// 这些行无检索/诊断价值，且会显著膨胀提取全文。仅按波形网格特征（方框字符/竖线）判定，
// 化验单表格行不含此类字符，不会误伤。
function isWaveformNoiseLine(line) {
  const s = line.trim()
  if (!s) return false
  if (s.includes('[') || s.includes(']')) return true
  const bars = (s.match(/\|/g) || []).length
  if (bars >= 2) return true
  // 含竖线且无任何数字/字母：波形残留（如「站 | 让  |的 .| 下」）
  if (bars >= 1 && !/\d/.test(s) && !/[A-Za-z]/.test(s)) return true
  return false
}
// 波形/边框噪声符号（心电波形、表格边框被 OCR 读成 | [ ] 等）
const WAVE_SYMBOLS_RE = /[[\]|｜]+/g

// 噪声行救回：波形符号常与真实文字糊在同一行，整行删除会连同行内的诊断结论一起丢
// （实测骨髓报告唯一结论行 `[We | | | |检验意见'ALL…` 被整行砍掉 → 结论框全空）。
// 故删除前先剥离噪声符号：仅当剩余文本确实含结论段关键词、且有成句中文时才保留，
// 其余波形行照旧剔除——避免把纯噪声行灌进所见/结论影响其它报告类型。
function salvageNoisyLine(line) {
  const stripped = line.replace(WAVE_SYMBOLS_RE, ' ').replace(/\s+/g, ' ').trim()
  const cjk = stripped.replace(/[^一-龥]/g, '')
  const hasConclusionKw = [...STRONG_CONCLUSION_KW, ...CONCLUSION_SECTIONS].some((k) => stripped.includes(k))
  return hasConclusionKw && cjk.length >= 4 ? stripped : ''
}

export function cleanReportText(text) {
  if (!text) return text
  return text
    .split('\n')
    .map((l) => (isWaveformNoiseLine(l) ? salvageNoisyLine(l) : l))
    .filter(Boolean)
    .join('\n')
}

// ---------- 检查部位提取 ----------
// 报告常在「检查部位」后给出受检区域（如「胸部CT」「上腹部CT」「头颅」），
// 抽出来供归档列表一眼区分查的是哪。
function extractBodyPart(text) {
  // 1) 显式标签：检查部位 / 检查名称 / 检查项目（如「检查名称: 头部 CT 平扫」）
  const labeled = text.match(
    /(?:(?:检查)?部位|检查名称|检查项目)\s*[:：]?\s*(?:为|是)?\s*([^\s：:，,；;。为是]{1,20})/i
  )
  if (labeled) return labeled[1].trim()
  // 1.5) 多部位模态行：检查项目行形如「腹部（上腹+下腹）+盆腔 CT 平扫」「头颅+胸部 CT 增强」，
  //      抽取模态词（CT/MR/MRI）前的完整受检部位串（含括号、加号、顿号，兼容 OCR 把（）读成〈〉），
  //      覆盖「单部位无标签」与「多部位组合」两类，避免旧逻辑在「腹部+盆腔 CT」里只拿到末位「盆腔」。
  //      要求模态词后紧跟 平扫/增强/扫描/成像，排除页眉「CT 诊断报告单」类误命中。
  // 用「排除模态词/模态后缀」的否定类，遇到任意 OCR 标点噪声（（）→〈〉、全半角混用）都能跨过，
  // 直到首个 CT/MR/MRI + 平扫/增强/扫描/成像 处截断，拿到完整部位串。
  const modal = text.match(
    /([^CTMR\n平扫增强扫描成像]{1,40}?)\s*(?:CT|MR|MRI)\s*(?:平扫|增强|扫描|成像)/i
  )
  if (modal) {
    const p = modal[1].replace(/[，。、,.\s]+$/, '').trim()
    if (p && !/^(北京|首都|附属|人民|中心|医院|大学)/.test(p)) return p
  }
  // 2) 兜底：单部位无「平扫/增强/扫描」字样（如「头部 CT」「胸部 CT」）时从模态词前抓受检部位
  const kw = text.match(
    /(头部|头颅|胸部|纵隔|腹部|全腹|上腹部|中腹部|下腹部|盆腔|腰椎|颈椎|胸椎|骶尾|鼻窦|副鼻窦|鞍区|小脑|脑干|肾上腺|甲状腺|乳腺|心脏|冠脉|冠状动脉|膝关节|肩关节|髋关节)\s*(?:CT|MR|MRI|平扫|增强|扫描)/i
  )
  if (kw) return kw[1]
  return ''
}

// ---------- 检查所见 / 诊断结论 段落拆分 ----------

// ---------- 章节分流：findings / conclusion / exclude ----------
// 基因检测报告里，除患者相关片段外，还有大量模板/参考资料（129 基因目录、缩写对照、
// 方法学声明、变异分级说明等）。这些模板在同类报告中完全一致，灌进检索索引只会污染搜索
// 相关性；原件已在 IndexedDB 完整保留，故归入 exclude 直接剔除出索引。
const FINDINGS_SECTIONS = [
  '检查所见', '超声描述', '超声所见', '声像图表现', '影像所见', '扫描所见', '心电图描述', '检查描述', '描述', '所见',
  // 病理 / 活检报告（骨髓活检、淋巴结活检、组织病理）的所见段名。必须显式登记：
  // matchSectionStart 走 startsWith，只登记 '所见' 匹配不到「镜下所见」→ 整段描述落空。
  // 「免疫组化」作段名，使抗原标记列表归入所见（其后内容照常进所见）。
  '镜下所见', '免疫组化',
  // 基因检测（患者相关、可检索）
  '检测内容', '与疾病相关变异临床意义', '临床意义未明突变', '质控结果', '备注',
  // 骨髓 / 细胞形态学图文报告的所见段名：「特征」下分子「骨髓:」「血片:」两段描述
  '特征', '骨髓象', '血片',
  // 检验/基因报告的「结果:」章头：作章节头而非正文内容（其后内容照常进所见）。
  // 注意只收「结果」二字：不能收「检测结果」，否则「检测结果检测范围内检出…」这类粘连章头
  // 会被截断，formatGeneticFindings 认不出「检测结果」导致分级小标题美化失效。
  '结果',
]
const CONCLUSION_SECTIONS = [
  '诊断结论', '超声提示', '检查结论', '影像诊断', '诊断意见', '心电图提示', '提示意见', '结论意见', '结论', '提示', '诊断',
  // 病理 / 活检报告的结论段名（同因 startsWith：「综合诊断」匹配不到裸「诊断」）
  '综合诊断',
  // 基因检测：总检小结
  '检测结果小结', '检测结论', '检测小结',
  // 染色体核型报告：结论段名就是「分析结果」（核型串 + 分裂相计数 + 建议）。
  // 此前未登记 → 结论整段落空（实测 265141：conclusion=""），只有核型串靠
  // 基因类默认通道落进 findings。须排得比 findings 的裸「结果」长（4 字 > 2 字），
  // SECTION_MATCHERS 按长度降序匹配，故「分析结果」优先命中结论。
  '分析结果',
]
const EXCLUDE_SECTIONS = [
  // 基因检测报告模板/参考资料，剔除出索引
  '检测基因列表', '缩写及中文对照', '血液及淋巴系统肿瘤缩写',
  '检测方法与声明', '检测结果和结论注释', '参考二代测序技术', '变异等级分为以下三类',
  '检测方法',
]

// 关键词按长度降序匹配，优先更长更具体的关键词；type 决定进入 findings / conclusion / 剔除
function buildSectionMatchers() {
  return [
    ...FINDINGS_SECTIONS.map((name) => ({ name, type: 'findings' })),
    ...CONCLUSION_SECTIONS.map((name) => ({ name, type: 'conclusion' })),
    ...EXCLUDE_SECTIONS.map((name) => ({ name, type: 'exclude' })),
  ].sort((a, b) => b.name.length - a.name.length)
}
let SECTION_MATCHERS = buildSectionMatchers()

// ORC 优化运行时补丁（数据层 · A 半）：doc / case 段落名词表。
// 段名词表一变，派生索引 SECTION_MATCHERS 必须重建，否则补丁不生效。
// 铁律：失败只警告、不抛出（补丁写坏不能连累整条解析链）。
try {
  const _patchRes = applyPatches(PATCHES, {
    sections: { findings: FINDINGS_SECTIONS, conclusion: CONCLUSION_SECTIONS, exclude: EXCLUDE_SECTIONS },
  })
  if (_patchRes.applied) SECTION_MATCHERS = buildSectionMatchers()
  if (_patchRes.errors.length) console.warn('[patches] parseDoc 段落补丁有错误：', _patchRes.errors)
} catch (e) {
  console.warn('[patches] parseDoc 补丁应用失败，已忽略：', e && e.message)
}

// 基因检测报告章节标题常带「1.」「2、」「3)」等编号前缀，匹配前去掉以便识别
function stripSectionNumber(s) {
  return s.replace(/^\d+[.、)）]?\s*/, '')
}

// 页脚/元信息行：不应进入检查所见或诊断结论
const FOOTER_RE = /^(?:录入员|报告医师|报告医生|审核医师|审核医生|检查技师|操作医师|申请医生|检验者|审核者|SNID|第\s*\d+\s*页|申请科室|报告日期|检查科室|检查号|报告号|住院号|病历号|床号|当前页|总页数|注[:：]|注释[:：]|仅供|签名|本报告|本结果)/
// 结论段落内遇到这些关键词也应停止（OCR 变体较多，用宽松匹配，且测试前会去除空格）
const FOOTER_LOOSE_RE = /报告医生|报告医师|审核医生|审核医师|本报告|仅供|纸质版|手写|涂改|无效|最终|不作为诊断|临床诊断|参考|报告日期|报告时间|^报告|^医生|^审核|^医师|^申请|^录入|录人员|^输录/

// 报告元信息行（用户反馈 2026-09-10：基因报告「检查所见」里混入机构名、报告标题、
// 编号、姓名性别、送检日期、取材、地址电话等废话，无检索/诊断价值）。
// 匹配基于去空白去标点的行（OCR 常在汉字间插空格），按行首标签判定，真实描述句不会以这些词开头。
const META_LINE_RE =
  /^(?:血研所|检验中心|诊断中心|实验中心|中心实验室|实验室|医院|院区|科室|科别|姓名|性别|年龄|编号|卡号|条码|样本号|标本|病历号|门诊号|住院号|床号|送检|采样|采集|接收|临床诊断|取材|检验项目|检测项目|检查项目|项目名称|检验者|检验人|审核|报告时间|报告日期|签发|地址|电话|联系方式|本报告|仅供|声明|签名)/
// 报告标题行（如「基因检测报告」「检验报告单」）：已单独作为 title，正文里重复出现属噪声
const TITLE_LINE_RE = /^[一-龥A-Za-z]{2,12}(?:报告单|检测报告|检验报告|检查报告|基因报告)$/
function isMetaLine(line, nl) {
  if (META_LINE_RE.test(nl)) return true
  if (TITLE_LINE_RE.test(nl)) return true
  // 职务行常与前一行人名粘连（文字层把「程镕琪」「审核医生:」拼成一行），行首是人名匹配不到，按包含判定
  if (nl.length <= 20 && /审核医生|审核医师|检验者|检验人|报告医生|报告医师/.test(nl)) return true
  // 纯编号/短码行（如 TZ2608635）：无中文、无运算符号，属编号噪声
  if (/^[A-Za-z0-9]{4,20}$/.test(line.trim())) return true
  return false
}

// 装饰性噪声行：报告页脚印章 / 边框被 OCR 读成 > < | ＝ * · 等（如「> 二 >」），真实中英文几乎不以此类符号为主。
// 当装饰符号数 ≥ 真实字符数（且真实字符 ≤ 2）时视为噪声剔除，避免「>二>」之类的页脚被塞进诊断结论。
function isDecorativeLine(s) {
  if (!s) return false
  const deco = (s.match(/[>|<│|＝=*·．•・\s]/g) || []).length
  const real = (s.match(/[一-龥A-Za-z0-9]/g) || []).length
  return deco >= real && real <= 2
}

// OCR 乱码行：散点图 / 图表区被 OCR 读成碎片（流式免疫分型实测的「涝2 本 册」「8 El E 汪 LRT」
// 「一Yesme内=一内」「天下导二办二」等）。这类行无检索与临床价值，会把「检查所见」灌满噪声
// （用户反馈 2026-09-10）。判据保守：行内只要含任何报告/医学语义词，或含抗原、百分比等有效
// token，一律放行；只有「无语义词」且呈碎片形态的行才剔除。
const REPORT_WORD_RE =
  /抗原|抗体|表达|设门|印象|结论|分析|细胞|标本|送检|条码|编号|姓名|性别|年龄|科室|医院|院区|报告|提示|诊断|所见|描述|检测|检验|结果|参考|单位|阳性|阴性|比例|百分|异常|未见|正常|增大|减小|回声|信号|密度|结节|肿块|积液|增粗|扩张|狭窄|钙化|囊肿|血流|形态|大小|范围|边缘|清晰|均匀|规则|随访|复查|建议|结合|临床|样本|本次|仅供|声明|签名|医师|医生|审核|日期|时间|地址|电话|原始|幼稚|淋巴|粒系|红系|巨核|骨髓|血片|涂片|核型|染色|基因|突变|融合|有核|治疗|病史|主诉|检查|测量|心电|超声|头部|颈部|脾|肝|肾|肺|心|血|尿|胸|腹|骨/
// 有效 token：抗原编号（CD34 / HLA-DR / cCD79a）与百分比数值（1.2%）——流式报告整行可能只有这些
const VALID_TOKEN_RE = /(?:CD|HLA|CB|CP|FMC|MPO|KAPPA|LAMBDA)\s*\d|\d+(?:\.\d+)?\s*%/i
// 噪声符号：散点图坐标轴 / 边框被 OCR 读成 = - | ~ < > * · 等
const GARBLE_SYMBOL_RE = /[=|~—_<>*·•・]|--/
const SENTENCE_PUNCT_RE = /[，。、；：？！,.;:?!]/

function isGarbledLine(line, nl) {
  const s = String(line || '')
  const t = String(nl || '')
  if (!t) return true
  if (REPORT_WORD_RE.test(t)) return false
  if (VALID_TOKEN_RE.test(t.replace(/\s+/g, ''))) return false
  const cjk = (t.match(/[一-龥]/g) || []).length
  // ① 无中文且无有效 token：默认视为纯字母/数字碎片（EEC、51DRREDR、ss）。
  //    例外：结构化的字母数字数据行是有价值内容（基因变异行
  //    「ARID1B NM_017519 Exon13 deletion COSV543323」），按 token 数或变异标记放行。
  if (cjk === 0) {
    const tokens = s.trim().split(/\s+/).filter(Boolean)
    // 「字母数字混合」或长 token 才是真数据（ARID1B / NM_017519 / COSV543323）；
    // 「5 1 DR RE DR」这类纯短字母/数字碎片仍是噪声。
    const solid = tokens.filter((t) => /[A-Za-z]/.test(t) && /\d/.test(t)).length + tokens.filter((t) => t.length >= 5).length
    if (solid >= 2) return false
    if (/NM_|COSV|Exon\d|rs\d{3,}|HGVS|delins|deletion|insertion|dup|ins\b/i.test(s)) return false
    return true
  }
  // ② 含噪声符号：图表残影（「=一人」「和和w|堆2是中」「性|imw3上本汪下和攻关」）
  if (GARBLE_SYMBOL_RE.test(s)) return true
  // ③ 中文 ≤3 字：孤立单字碎片（村、长史5、本7本8外）
  if (cjk <= 3) return true
  // ④ 混成串拉丁字母碎片且中文 ≤6 字（可区va避民）
  if (/[A-Za-z]{2,}/.test(s) && cjk <= 6) return true
  // ⑥ 中文被空格拆成 1~2 字的孤立片段（「天下  导二   办:    二」）：真实行文不会逐词断开，
  //    这是散点图/图例区被 OCR 读碎的典型形态。
  const cjkSegs = s.replace(/[^一-龥\s]/g, ' ').match(/[一-龥]+/g) || []
  if (cjk <= 10 && cjkSegs.length >= 3 && cjkSegs.length >= Math.ceil(cjk / 2)) return true
  // ⑥.5 图像区乱码的另一形态：CJK 被拆成大量 ≤3 字碎片且全程无语义词
  // （实测 794 骨髓活检 ×1.68 附图区：「人 全个 人 Oh 生、昌 了华夏 多友人9计2 PC」——
  //  行内一个 OCR 插入的顿号即可绕过 ⑤ 的标点 rescue，13 个 CJK 又超了 ⑥ 的字数上限；
  //  改按「分段碎」本身判定：≥4 段且每段 ≤3 字。真实描述句的分段总有 ≥4 字的连续成分，
  //  且多数会先被 REPORT_WORD_RE/VALID_TOKEN_RE 放行，不受影响）。
  if (cjkSegs.length >= 4 && cjkSegs.every((seg) => seg.length <= 3)) return true
  // ⑤ 纯汉字碎片、无句读标点（页脚地址被读碎的「地直北京夺内区未十旦和3全北京有攻辽区」）：
  // 真实报告行文几乎必带标点或语义词，无标点且无语义词的长串基本都是 OCR 碎片。
  if (!SENTENCE_PUNCT_RE.test(s)) return true
  return false
}

// 页脚职务行（录入员/报告医师/审核医生/技师/申请医生等）：
// 其前一行常是孤立的人名（如「李牧遥」与「录入员：」被文字层拆成两行），回溯清理时据此判断
const ROLE_LINE_RE = /^(?:录入|报告医师|报告医生|审核医师|审核医生|检查技师|操作医师|申请医生|报告日期|报告时间|医生|医师|技师|申请)/
// 常见姓氏（含常见复姓），用于识别孤立人名行
const SURNAME_RE = /^(?:欧阳|司马|上官|诸葛|王|李|张|刘|陈|杨|黄|赵|吴|周|徐|孙|马|朱|胡|郭|何|高|林|罗|郑|梁|谢|宋|唐|许|韩|冯|邓|曹|彭|曾|肖|田|董|袁|潘|蒋|蔡|余|杜|叶|程|苏|魏|吕|丁|任|沈|姚|卢|姜|崔|钟|谭|陆|汪|范|金|石|廖|贾|夏|韦|付|方|白|邹|孟|熊|秦|邱|江|尹|薛|闫|段|雷|侯|龙|史|陶|黎|贺|顾|毛|郝|龚|邵|万|钱|严|覃|武|戴|莫|孔|向|汤)/
// 医学/检查常见词：孤立人名行不应包含这些词（避免误删「未见异常」等结论短句）
const MEDICAL_WORD_RE = /未见|异常|正常|增厚|肿大|清晰|信号|回声|淋巴|血流|可见|明显|范围|良好|光整|规则|均匀|尚可|欠佳|超声|检查|测量|阴性|阳性|动脉|静脉|心电|左右|上下|内外|大小|建议|随访|复查/

function normalizeForSection(s) {
  // 注意：保留半角/全角小数点（. ．），否则测量值如「1.0cm」会被误删成「10cm」
  return s.replace(/[\s:：，,;。、！!()（）【】\[\]"'"“”]/g, '')
}

function matchSectionStart(s) {
  const ns = stripSectionNumber(normalizeForSection(s))
  for (const { name, type } of SECTION_MATCHERS) {
    if (ns.startsWith(name)) {
      const rest = ns.slice(name.length)
      // 目录（TOC）条目形如「2. 检测内容 1」：剥离前缀编号后，标题后残留的是页码（纯数字），
      // 与真实章节标题（标题后接正文或为空）区分，避免目录被误当成正文章节。
      if (rest && /^[\d.\s．·]+$/.test(rest)) return null
      return { type, name, rest }
    }
  }
  return null
}

// 行内（非行首）结论头检测：报告排版常把「诊断结论」与左栏患者信息/测量值拼到同一行
// （如「姓名: 代陪 … 诊断结论:1、窦性心律」），matchSectionStart 只认行首会漏掉。
// 仅用「强结论关键词」（标题式、不会出现在正文句中）做行内检测；并要求关键词后紧跟
// 标点/数字/结尾（即确为章节头），避免误命中「结合影像诊断考虑…」这类正文句子。
const STRONG_CONCLUSION_KW = [
  '诊断结论', '心电图提示', '超声提示', '影像诊断', '诊断意见', '提示意见', '结论意见', '检查结论', '心电图诊断',
  // 骨髓 / 细胞形态学图文报告的结论段名（其内部写的就是「检验意见：…」）；
  // 这类段名常被 OCR 拼在乱码装饰之后（行首不是段名），故必须走「行内关键词」通道。
  '检验意见',
  // 病理 / 活检报告的结论段名，同样常被 OCR 与装饰噪声拼在一行 → 走行内通道兜住。
  '综合诊断',
]
function detectMidConclusionKeyword(s) {
  const ns = stripSectionNumber(normalizeForSection(s))
  for (const kw of STRONG_CONCLUSION_KW) {
    const i = ns.indexOf(kw)
    if (i > 0) {
      const after = ns.slice(i + kw.length)
      // 段名后允许接标点 / 编号。额外容忍两类 OCR 噪声，否则整段漏抽：
      // ① 冒号被错读成单引号/竖线等符号（「检验意见'ALL…」）；
      // ② 冒号整个丢失、段名后直接接英文缩写（「检验意见ALL治疗后骨髓象」，本例实测）。
      if (
        after === '' ||
        /^[:：，,;.。、！!()（）\d'’`´"“”|｜]/.test(after) ||
        /^[A-Za-z]/.test(after)
      ) {
        return kw
      }
    }
  }
  return null
}

function splitSections(lines, kind) {
  let mode = null
  let midConclusion = false
  // 基因检测报告无「检查所见」式显式小标题，整份报告主体即所见；
  // 未归入结论/页脚的普通行默认收进 findings（非基因报告保持 null，依赖显式小标题，避免影响 CT/超声）。
  // 流式免疫分型同基因：主体是「印象(Impression)」描述段 + 抗原列表，没有「检查所见」式小标题，
  // 不留默认通道会整段丢失；「结论(Conclusion)」仍能靠 CONCLUSION_SECTIONS 的「结论」单独识别。
  const DEFAULT_MODE = kind === 'genetic' || kind === 'flow' ? 'findings' : null
  const findings = []
  const conclusion = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const nl = normalizeForSection(line)
    // OCR 会在汉字间插入空格（如「医生 审核 医生」），页脚检测需基于去空格后的文本
    if (FOOTER_RE.test(line) || (mode === 'conclusion' && FOOTER_LOOSE_RE.test(nl))) {
      // 职务行（录入员/报告医师/技师…）前常跟孤立的人名行：文字层会把「李牧遥」与
      // 「录入员：」拆成两行，人名行无前缀无法被 FOOTER_RE 命中，需从段落末尾回溯移除
      if (ROLE_LINE_RE.test(line)) {
        const arr = mode === 'findings' ? findings : mode === 'conclusion' ? conclusion : null
        if (arr && arr.length) {
          const lastN = normalizeForSection(arr[arr.length - 1])
          // 仅当末尾片段像「孤立人名」（常见姓 + 2~4 纯汉字 + 不含医学词）时才移除
          if (/^[\u4e00-\u9fa5]{2,4}$/.test(lastN) && SURNAME_RE.test(lastN) && !MEDICAL_WORD_RE.test(lastN)) {
            arr.pop()
          }
        }
      }
      mode = null
      midConclusion = false
      continue
    }

    // 装饰性噪声行（页脚印章/边框被 OCR 读成 > < | ＝ * · 等，如「> 二 >」）无检索价值，剔除出所见/结论
    if (isDecorativeLine(nl)) continue

    // —— 行内结论优先提取（必须在元信息/乱码丢弃之前）——
    // 心电图等报告常把「诊断结论」与左栏患者信息/测量值拼在同一行（如
    // 「姓名: … PR间期: … 诊断结论:1、窦性心律 …」），若先走 isMetaLine 会把整行当作
    // 元信息丢弃，导致结论全空。故先处理行内结论，命中即进入结论模式并取其内容。
    if (mode === 'conclusion' && midConclusion) {
      // 行内多行结论续接：已进入结论模式且由行内关键词触发，后续行右栏为「N、结论项」，
      // 左栏为患者信息/测量值（姓名/性别/年龄…），跳过元信息/乱码丢弃，仅取结论项。
      // 编号项判定用「数字 + 标点 + 中文」（如「3、左心室高电压」），避免误命中左栏
      // 测量值的小数点（如「2. 851」）。无编号项则视为结论段结束。
      const numIdx = line.search(/\d{1,2}[、．]\s*[一-龥]/)
      if (numIdx >= 0) { conclusion.push(line.slice(numIdx)); continue }
      mode = null
      midConclusion = false
    }
    const midKw = detectMidConclusionKeyword(line)
    if (midKw) {
      mode = 'conclusion'
      midConclusion = true
      const ki = line.indexOf(midKw)
      const restN = (ki >= 0 ? line.slice(ki + midKw.length) : '').replace(/^[:：，,;.。、！!()（）\s]+/, '').trim()
      if (restN) conclusion.push(restN)
      continue
    }

    // OCR 乱码行（散点图 / 图表区碎片，如「涝2本册」「一Yesme内=一内」）剔除出所见/结论
    if (isGarbledLine(line, nl)) continue

    // 元信息行（机构/标题/患者与样本信息/页脚联系方式）剔除，避免混入所见与结论
    if (isMetaLine(line, nl)) continue

    // OCR 会把「影像所见」「影像诊断」等关键词拆成两行，尝试与下一行合并匹配（支持正序/倒序）。
    // 关键：仅当关键词确实「跨行拆分」（本行尾部 + 下行头部拼出关键词）才合并；
    // 否则会把「检查部位…」这类普通行误吞进下一行的所见/结论 rest。
    let merged = line
    let mergedN = nl
    let consumedNext = false
    const next = lines[i + 1] ? lines[i + 1].trim() : ''
    if (next && !matchSectionStart(line)) {
      const nNext = normalizeForSection(next)
      let mergedPair = null
      for (const { name, type } of SECTION_MATCHERS) {
        if (type === 'exclude') continue
        if (name.length < 2) continue
        for (let k = 1; k < name.length; k++) {
          const head = name.slice(0, k)
          const tail = name.slice(k)
          if (nl.endsWith(head) && nNext.startsWith(tail)) {
            mergedPair = { merged: line + next, mergedN: nl + nNext }
            break
          }
          if (nNext.endsWith(head) && nl.startsWith(tail)) {
            mergedPair = { merged: next + line, mergedN: nNext + nl }
            break
          }
        }
        if (mergedPair) break
      }
      if (mergedPair) {
        merged = mergedPair.merged
        mergedN = mergedPair.mergedN
        consumedNext = true
      }
    }

    // 行内（非行首）结论头已在上方元信息/乱码丢弃之前优先处理（含 consumedNext 合并场景），
    // 此处不再重复；以下走章节头（行首）匹配。
    const sec = matchSectionStart(merged)
    if (sec) {
      if (sec.type === 'exclude') {
        mode = null
        midConclusion = false
        if (consumedNext) i++
        continue
      }
      mode = sec.type
      midConclusion = false
      // rest：去掉 section 关键词（含编号前缀）与随后的标点（基于去空格文本，与匹配保持一致）
      const restN = sec.rest.replace(/^[:：，,;.。、！!()（）]+/, '').trim()
      if (mode === 'findings') {
        if (restN) findings.push(restN)
      } else {
        if (restN) conclusion.push(restN)
      }
      if (consumedNext) i++
      continue
    }

    // section 标题的冒号被 OCR 拆成单独一行（如「影像 / 诊断 / :」），直接跳过
    if (mode && /^[:：，,;.。、！!()（）]+$/.test(line)) continue

    if (mode === 'findings') findings.push(nl)
    else if (mode === 'conclusion') {
      if (midConclusion) {
        // 行内触发的结论多为「N、」编号列表，左栏测量值也拼在同一行；
        // 只取首个编号项（含其后结论文本），其余左栏内容丢弃；编号列表结束则退出结论模式。
        const numIdx = line.search(/\d{1,2}[、．]/)
        if (numIdx >= 0) conclusion.push(line.slice(numIdx))
        else { mode = null; midConclusion = false }
      } else {
        conclusion.push(nl)
      }
    }
    else if (DEFAULT_MODE) {
      // 基因报告：未落入任何小标题/页脚的普通行归入 findings（含报告开头引言、变异表、质控等）
      mode = DEFAULT_MODE
      if (DEFAULT_MODE === 'findings') findings.push(nl)
      else conclusion.push(nl)
    }
  }
  return {
    findings: findings.filter(Boolean).join('；'),
    conclusion: conclusion.filter(Boolean).join('；'),
  }
}

// 基因检测「检测结果」章节美化：该章节标题常与摘要粘连（PDF 同行，如「检测结果检测范围内…」），
// 其后紧跟「明确与疾病相关突变/一级变异/二级变异…」等纯中文分级小标题。这里只做排版：
// 1) 把粘连处插「：」拆成「检测结果：检测范围内…」；
// 2) 其后纯中文短段（分级小标题）用换行替代 '；' 平铺，更易读。
// 仅作用于基因检测报告，且只在命中「检测结果」时改动，其余 findings 原样保留；
// 检索按子串匹配、展示层 whitespace-pre-wrap 会换行，故不影响检索与显示。
const GENETIC_SUBHEADER_RE = /^[一-龥]{2,14}$/
export function formatGeneticFindings(findings) {
  let s = findings.replace('检测结果检测范围内', '检测结果：检测范围内')
  const parts = s.split('；')
  const idx = parts.findIndex((p) => p.startsWith('检测结果'))
  if (idx < 0) return s
  let out = parts.slice(0, idx).join('；')
  if (idx > 0) out += '；'
  out += parts[idx]
  for (let i = idx + 1; i < parts.length; i++) {
    const p = parts[i]
    if (GENETIC_SUBHEADER_RE.test(p)) out += '\n' + p
    else out += '；' + p
  }
  return out
}

// ---------- 关键测量值提取 ----------

// ---------- 心电图专属测量值提取（间期 / 振幅 / 电轴，带参考区间与异常标记） ----------
// 心电报告是高度结构化数值报告（与影像「所见/结论」不同），把关键间期/振幅/电轴全部结构化，
// 供详情面板展示与列表检索。measures 结构扩展为 { name, value, unit, ref, flag }，
// ref/flag 为展示增强（可选字段），对其它报告类型无影响。
const ECG_REF_RE = /[（(]\s*(-?[\d.]+)\s*[-–~]\s*(-?[\d.]+)\s*[)）]/
function extractEcgMeasures(text) {
  const out = []
  const seen = new Set()
  const add = (name, value, unit, ref, flag) => {
    if (value == null || value === '' || Number.isNaN(parseFloat(value))) return
    const key = `${name}|${value}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name, value: String(value), unit: unit || '', ref: ref || '', flag: flag || '' })
  }
  const num = (s) => parseFloat(s)
  const flagFor = (v, r, arrow) => {
    if (arrow === '↑' || arrow === '↓') return arrow
    if (r && v > r.hi) return '↑'
    if (r && v < r.lo) return '↓'
    return ''
  }
  // 从某关键词锚点起 80 字内取最近的参考区间（如「（60-100）」）
  const refNear = (anchorRe) => {
    const m = text.match(anchorRe)
    if (!m) return null
    const r = text.slice(m.index, m.index + 80).match(ECG_REF_RE)
    return r ? { lo: parseFloat(r[1]), hi: parseFloat(r[2]) } : null
  }

  // 心率
  {
    const m = text.match(/心率\s*[:：]?\s*([1-9]\d{1,2})\s*(?:bpm|次\/分|次\/min|次\/分钟)?/i)
    if (m) {
      const r = refNear(/心率/) || { lo: 60, hi: 100 }
      add('心率', m[1], 'bpm', `${r.lo}-${r.hi}`, flagFor(num(m[1]), r, ''))
    }
  }
  // P-R 间期
  {
    const m = text.match(/P-?R\s*间期\s*[:：]?\s*([1-9]\d{1,2})/)
    if (m) {
      const r = refNear(/P-?R\s*间期/) || { lo: 120, hi: 200 }
      add('P-R间期', m[1], 'ms', `${r.lo}-${r.hi}`, flagFor(num(m[1]), r, ''))
    }
  }
  // QRS 时限
  {
    const m = text.match(/QRS\s*时限\s*[:：]?\s*([1-9]\d{1,2})/)
    if (m) {
      const r = refNear(/QRS\s*时限/) || { lo: 60, hi: 100 }
      add('QRS时限', m[1], 'ms', `${r.lo}-${r.hi}`, flagFor(num(m[1]), r, ''))
    }
  }
  // QT / QTc 间期（两个值）
  {
    const m = text.match(/QT\s*\/?\s*QTc\s*间期\s*[:：]?\s*([\d.]+)\s*(?:ms)?\s*(?:[（(][^）)]*[）)])?\s*[/／]\s*([\d.]+)/)
    if (m) {
      // 参考区间紧贴各自数值之后；从数值位置起取最近区间，避免误取另一项的括号
      const qtPos = text.indexOf(m[1], m.index)
      const qtRef = qtPos >= 0 ? text.slice(qtPos, qtPos + 40).match(ECG_REF_RE) : null
      const rQt = qtRef ? { lo: parseFloat(qtRef[1]), hi: parseFloat(qtRef[2]) } : { lo: 320, hi: 440 }
      const qtcPos = text.indexOf(m[2], m.index)
      const qtcRef = qtcPos >= 0 ? text.slice(qtcPos, qtcPos + 40).match(ECG_REF_RE) : null
      const rQtc = qtcRef ? { lo: parseFloat(qtcRef[1]), hi: parseFloat(qtcRef[2]) } : { lo: 320, hi: 450 }
      add('QT间期', m[1], 'ms', `${rQt.lo}-${rQt.hi}`, flagFor(num(m[1]), rQt, ''))
      add('QTc间期', m[2], 'ms', `${rQtc.lo}-${rQtc.hi}`, flagFor(num(m[2]), rQtc, ''))
    }
  }
  // P-QRS-T 电轴（三个值，数值后可能带 ° 单位）
  {
    const m = text.match(/[Pp]-?QRS-?[Tt]\s*电轴\s*[:：]?\s*(-?\d{1,3})°?\s*[/／]\s*(-?\d{1,3})°?\s*[/／]\s*(-?\d{1,3})°?/)
    if (m) add('P-QRS-T电轴', `${m[1]}/${m[2]}/${m[3]}`, '°', '', '')
  }
  // RV5 / SV1 值
  {
    const m = text.match(/RV5\s*\/\s*SV1\s*值\s*[:：]?\s*([\d.]+)\s*(↑|↓)?\s*(?:mV)?\s*(?:[（(][^）)]*[）)])?\s*[/／]\s*([\d.]+)/)
    if (m) {
      const r = refNear(/RV5\s*\/\s*SV1/) || { lo: 0, hi: 2.5 }
      add('RV5', m[1], 'mV', `${r.lo}-${r.hi}`, flagFor(num(m[1]), r, m[2] || ''))
      add('SV1', m[3], 'mV', '', '')
    }
  }
  // RV5+SV1 振幅
  {
    const m = text.match(/RV5\s*\+\s*SV1\s*振幅\s*[:：]?\s*([\d.]+)/)
    if (m) {
      const r = refNear(/RV5\s*\+\s*SV1/) || { lo: 0, hi: 4 }
      add('RV5+SV1振幅', m[1], 'mV', `${r.lo}-${r.hi}`, flagFor(num(m[1]), r, ''))
    }
  }
  return out.slice(0, 30)
}

// ---------- 超声心动图「联想词纠正」：形近字混淆加权模糊匹配 ----------
// OCR 对心脏超声测量项名称的误读以「单字 形近字」为主（窦→罕、脉→肪、舒→合、末→林、
// 隔→师、壁→尾、缩→纵、主→上…）。用规范术语词典 + 混淆加权编辑距离纠正：仅当 OCR 名
// 与某规范术语只差「一个已知混淆对」替换（代价 0.3，远低于非混淆替换的 1.0）时才纠正，
// 杜绝跨字臆造。此法比 ocr.js 的定长短语表更泛化——未知 形近字 变体也能被覆盖。
const ECHO_CONFUSION_PAIRS = new Set([
  '窦罕', '窦灵', '窦卖', // 窦 常被读成 罕/灵
  '脉肪', '脉咏', // 脉→肪（主动脉→主动肪）
  '舒合', '舒捨', // 舒→合（舒张→合张）
  '末林', '末本', // 末→林（舒张末→合张林）
  '隔师', '隔融', // 隔→师（间隔→间师）
  '壁尾', '壁絮', // 壁→尾（后壁→后尾）
  '缩纵', '缩综', // 缩→纵（收缩→收纵）
  '主上', '主生', // 主→上（主肺动脉→上策动脉）
  '差莹', // 差→莹（峰值压差→峰值压莹）
])
function isConfusion(a, b) {
  if (a === b) return true
  return ECHO_CONFUSION_PAIRS.has(a + b) || ECHO_CONFUSION_PAIRS.has(b + a)
}
// 混淆加权编辑距离：插删 = 1，混淆对替换 = 0.3，其它替换 = 1
function confusionEdit(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i <= n; i++) dp[i][0] = i
  for (let j = 0; j <= m; j++) dp[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const ca = a[i - 1]
      const cb = b[j - 1]
      const sub = ca === cb ? 0 : isConfusion(ca, cb) ? 0.3 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + sub)
    }
  }
  return dp[n][m]
}
// 规范术语词典（含 OCR 常丢「左室/右室」前缀的短形，便于短名直接归位）
const ECHO_TERM_VOCAB = [
  '窦部内径', '升主动脉内径', '主肺动脉内径',
  '左室舒张末内径', '左室收缩末内径', '舒张末内径', '收缩末内径',
  '室间隔厚度', '左室后壁厚度', '后壁厚度',
  '右室基底内径', '基底内径',
  '左房前后径', '左房左右径', '左房上下径', '右房左右径', '右房上下径',
  '二尖瓣E峰', '二尖瓣A峰',
  '三尖瓣反流速度', '三尖瓣反流压差',
  '收缩峰值流速',   '主动脉瓣收缩峰值流速', '主动脉瓣峰值压差',
  '肺动脉瓣收缩峰值流速', '肺动脉瓣峰值压差',
  '峰值压差', // 裸名（OCR 常丢「主动脉瓣/肺动脉瓣」前缀）
  '射血分数', 'E/A比值', '二尖瓣环e’间隔', 'E/e’', 'TAPSE', '心率',
]
function correctEchoMeasureName(name) {
  if (!name) return name
  if (ECHO_TERM_VOCAB.includes(name)) return name
  let best = null
  let bestD = Infinity
  for (const v of ECHO_TERM_VOCAB) {
    const d = confusionEdit(name, v)
    if (d < bestD) { bestD = d; best = v }
  }
  // 仅接受「单字混淆替换」（代价 0.3）级别纠正，其它一律保留原词
  return bestD <= 0.5 && best ? best : name
}
// 心脏测量单位 OCR 变体归一：内径/厚度/径线维度 m/um/nm/mn/nn→mm；
// 速度 cmys→cm/s；压差 mmilg/mnkHtg…→mmHg。仅作用于 measures，不污染自由文本。
function normalizeMeasureUnit(name, unit) {
  if (!unit) return unit
  let u = unit.replace(/\s+/g, '')
  // 仅当确有 s/y 尾巴（cmys / cms / cm/s）才归为速度 cm/s；
  // 裸「CM」是长度单位（实测 794 骨髓活检「标本长度: 1.3CM」曾被误归 cm/s）
  if (/^cm(ys|s|\/s)$/i.test(u)) u = 'cm/s'
  else if (/^cm$/i.test(u)) u = 'cm'
  else if (/mmi?l?g|mmk?h?tg|mmiig|mmntg|mmhg/i.test(u)) u = 'mmHg'
  // 心脏径线维度：OCR 常把 mm 读成 m/um/nm/mn/nn/imm 等字母变体 → 统一 mm
  if (/(内径|厚度|径|直径|长度|宽度)/.test(name) && /^[muni]+$/i.test(u)) u = 'mm'
  return u
}

function extractMeasures(text, kind) {
  // 心电图：结构化数值报告，走专属提取（含参考区间与异常标记）
  if (kind === 'ecg' || /心电图|心电力/.test(text)) return extractEcgMeasures(text)
  const out = []
  const seen = new Set()
  const add = (name, value, unit) => {
    const cname = correctEchoMeasureName(name)
    const cunit = normalizeMeasureUnit(cname, unit)
    const k = `${cname}${value}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ name: cname, value: String(value), unit: cunit })
  }

  const patterns = [
    { name: '心率', re: /(?:心率|HR)\s*[:：]?\s*(\d{2,3})\s*(?:bpm|次\/分|次\/min)/i, unit: 'bpm' },
    { name: '射血分数', re: /(?:EF|射血分数|和射性分数|射性分数)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/, unit: '%' },
    { name: 'FS 缩短分数', re: /FS\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/, unit: '%' },
    { name: 'LAVI 左房容积指数', re: /LAVI\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*(?:ml\/m²|ml\/m2)/i, unit: 'ml/m²' },
    // E/A 比值：OCR 常把小数用空格拆开（"E/A 1. 2"），合并成 1.2
    { name: 'E/A比值', re: /E\/A\s*[:：]?\s*(\d+)\s*\.?\s*(\d+)/i, unit: '' },
    { name: 'TAPSE', re: /TAPSE\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)/i, unit: 'mm' },
    // 二尖瓣血流频谱 E 峰 / A 峰（名含拉丁字母，走专属正则）
    { name: '二尖瓣E峰', re: /E峰\s*(\d{1,3}(?:\.\d+)?)\s*(?:cm\/s|cmys|cmy s)?/i, unit: 'cm/s' },
    { name: '二尖瓣A峰', re: /A峰\s*(\d{1,3}(?:\.\d+)?)\s*(?:cm\/s|cmys|cmy s)?/i, unit: 'cm/s' },
    // 二尖瓣环 E/e' 比值（dimentionless）：OCR 把撇号读成 y（"E/ey 6.1"），先由 ocr.js 纠正为 E/e’
    { name: 'E/e’', re: /E\/e['’]\s*(\d{1,2}(?:\.\d+)?)/, unit: '' },
  ]
  for (const p of patterns) {
    const m = text.match(p.re)
    if (!m) continue
    // E/A 比值正则含两组（小数被空格拆开），合并成 "1.2"
    const val = m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]
    add(p.name, val, p.unit)
  }

  // 脾脏测量：PDF 常把「脾脏…厚4.3cm，长13.0cm」分行，围绕「脾」字就近匹配
  const spleenIdx = text.indexOf('脾')
  if (spleenIdx >= 0) {
    const ctx = text.slice(spleenIdx, spleenIdx + 60)
    const thick = ctx.match(/厚\s*[:：]?\s*(\d+(?:\.\d+)?)\s*cm/)
    if (thick) add('脾厚', thick[1], 'cm')
    const len = ctx.match(/长\s*[:：]?\s*(\d+(?:\.\d+)?)\s*cm/)
    if (len) add('脾长径', len[1], 'cm')
  }

  // 结节/囊肿/淋巴结尺寸（支持 cm / mm）
  const lesionRe = /(?:结节|肿块|占位|囊肿|淋巴结|囊性)[^。；，,]{0,10}?(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(cm|mm)/g
  for (const m of text.matchAll(lesionRe)) {
    const unit = m[3] === 'cm' ? 'cm' : 'mm'
    add('结节/囊肿大小', `${m[1]}×${m[2]}`, unit)
  }

  // 通用「名称：数值 单位」模式（内径/厚度/血流速度/径线/压差等）
  // 后缀含 径（前后径/左右径/上下径）、压差/压莹（峰值压差 OCR 成 压莹）；
  // 数值允许被空格/逗号拆开的小数（"12. 0"→12.0、"8, 3"→8.3）
  const genericRe = /([\u4e00-\u9fa5]{2,10}(?:内径|厚度|长度|直径|宽度|径|压差|压莹|流速|速度|指数|比值|容积))[:：]?\s*(\d+(?:[.,]\s*\d+)?(?:[x×*]\d+(?:[.,]\s*\d+)?)?)\s*([a-zA-Z/°²]+)/g
  // 心房径线消歧：取该测量前方最近的房室标签（左房/右房，不含"左心/右心"以免误中左心室/右心室）作前缀
  const chamberRe = /(左心房|左房|右心房|右房)/
  for (const m of text.matchAll(genericRe)) {
    const name = m[1]
    if (name === '脾厚' || name === '脾长' || name === '脾长径') continue // 已用精确规则
    const val = m[2].replace(/\s/g, '').replace(',', '.')
    let cname = name
    if (/(前后径|左右径|上下径)/.test(name)) {
      const labels = text.slice(0, m.index).match(new RegExp(chamberRe, 'g'))
      const label = labels && labels[labels.length - 1]
      if (label) cname = (label.startsWith('左') ? '左房' : '右房') + name
    }
    add(cname, val, m[3])
  }
  return out.slice(0, 30)
}

// ---------- 病历文书结构化字段抽取 ----------
// 出院记录 / 诊断证明等非影像报告，除所见 / 结论外还有强结构字段
// （出院日期 / 住院天数 / 出院诊断 / 出院医嘱、诊断 / 建议休息天数 / 科室 / 医师）。
// 这里从全文懒抽取，找不到就留空；主展示仍回退 findings / conclusion，保证检索不丢。
// 标签与值之间的分隔符：OCR 常把全角冒号「：」读成「，」「,」（如「入院日期，2026-08-19」），
// 必须一并放行，否则整项抽不到。
const LABEL_SEP = '\\s*[：:，,]?\\s*'
const pad2 = (n) => String(n).padStart(2, '0')

function pickDateTime(text, labelRe) {
  // 红线：labelRe.source 含 `|`（如「出院日期|出院时间」），**必须整体包成非捕获组**。
  // 否则 `|` 优先级最低，拼接出的正则是「出院日期」或「出院时间+日期」——只匹配到裸标签也算
  // 命中，捕获组全为 undefined，拼出 "undefined-undefined-undefined"（界面显示 Invalid Date）。
  const m = String(text || '').match(
    new RegExp(
      `(?:${labelRe.source})${LABEL_SEP}(\\d{4})[-/年.](\\d{1,2})[-/月.](\\d{1,2})(?:\\s*(\\d{1,2}):(\\d{2}))?`
    )
  )
  if (!m || !m[1] || !m[2] || !m[3]) return null
  return { date: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`, time: m[4] ? `${pad2(m[4])}:${m[5]}` : '' }
}
function pickDate(text, labelRe) {
  const dt = pickDateTime(text, labelRe)
  return dt ? dt.date : ''
}
function pickInline(text, labelRe) {
  for (const ln of String(text || '').split('\n')) {
    const m = ln.match(labelRe)
    if (!m) continue
    // 只剥掉「标签 + 分隔符」，保留原文标点。
    // 红线：不可用 split(分隔符).slice(1).join(':') —— 那会把值里的逗号全改成冒号。
    return ln.slice(ln.indexOf(m[0]) + m[0].length).replace(/^\s*/, '').trim()
  }
  return ''
}

// 病历文书的段落标签（判断「下一段从哪开始」的唯一依据）
const CASE_SECTION_LABELS = [
  '入院情况', '诊疗经过', '阳性辅助检查结果', '出院时症状与体征', '出院情况', '出院医嘱',
  '出院诊断', '入院初步诊断', '出院小结',
]
const CASE_SECTION_STOP_RE = new RegExp(`^(?:${CASE_SECTION_LABELS.join('|')})\\s*[：:，,]`)

// 出院记录每页都重复的抬头 / 页眉页脚 / 患者信息行——不是正文，必须剔除。
// 教训：曾把「整篇原文」当所见回退，结果页眉、患者编号、重复标题全灌进去，全是废话。
function isCaseNoiseLine(line) {
  const ln = String(line || '').trim()
  if (!ln) return true
  // nl = 去掉全部空白的版本：页眉常被 OCR 插入大段空格（「首都医科大学附属    <二全刘医」），
  // 用 ln.length 判断会被撑过阈值而漏网，必须用 nl 判断长度。
  const nl = ln.replace(/\s+/g, '')
  if (isMetaLine(ln, nl)) return true
  if (isDecorativeLine(ln)) return true
  // 「姓名:」及 OCR 变体「克名:」（姓→克）
  if (/^[\u4e00-\u9fa5]{0,2}名\s*[：:，,]/.test(ln)) return true
  if (/患者编号|病案号/.test(nl) && nl.length <= 32) return true
  // 医院抬头：「北京朝阳医院出医记录」「首都医科大学附属…」（OCR 变体：出辽/出联/出医）
  if (/(?:医学院|医科大学|附属)/.test(nl) && nl.length <= 20) return true
  if (/^[\u4e00-\u9fa5]{2,10}医院[\u4e00-\u9fa5]{0,6}(?:记录|报告)$/.test(nl)) return true
  return false
}

// 取一个段落：从标签行起，收至下一个段落标签（或文末），逐行剔除页眉噪声。
function extractCaseSection(text, label) {
  const lines = String(text || '').split('\n')
  const startRe = new RegExp(`${label}\\s*[：:，,]`)
  const start = lines.findIndex((l) => startRe.test(l))
  if (start < 0) return ''
  const head = lines[start].split(startRe).slice(1).join('').trim()
  const out = []
  if (head) out.push(head)
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i].trim()
    if (!ln) continue
    if (CASE_SECTION_STOP_RE.test(ln)) break
    if (isCaseNoiseLine(ln)) continue
    out.push(ln)
  }
  return out.join('\n').trim()
}

// label 为纯标签名（如「出院诊断」）；requireSep=true 表示必须紧跟分隔符
// （「诊断」这类短词必须要求，否则「诊断证明书」标题行会被当成值）。
function pickBlock(text, label, requireSep = false) {
  const sep = requireSep ? '[：:，,]' : '[：:，,]?'
  const startRe = new RegExp(`${label}\\s*${sep}`)
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      // 只剥掉「标签 + 分隔符」，保留原文标点（不能用 split 再 join，会把逗号改成冒号）
      const head = lines[i].replace(startRe, '').trim()
      const more = []
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j].trim()
        if (!ln) continue
        // 只在「真正的下一段落标签」处停止。不能因行内出现「5、出院用药:」就断——
        // 否则出院医嘱会丢掉整份出院用药清单。
        if (CASE_SECTION_STOP_RE.test(ln)) break
        if (isCaseNoiseLine(ln)) continue
        more.push(ln)
      }
      return [head, ...more].join(' ').trim()
    }
  }
  return ''
}

// 病历文书的「所见 / 结论」：按出院记录的真实段落映射，而不是把整篇原文塞进去。
//   所见 = 入院情况 + 诊疗经过（发现了什么、做了什么）
//   结论 = 出院时症状与体征 + 出院情况（结果如何）
// 「阳性辅助检查结果」是长串化验值，与检验记录重复且会淹没叙述，刻意不进所见
// （原文仍完整保存在 IndexedDB，详情页「提取全文」可查）。
export function extractCaseNarrative(text, kind) {
  if (kind !== 'discharge') return { findings: '', conclusion: '' }
  const findings = [extractCaseSection(text, '入院情况'), extractCaseSection(text, '诊疗经过')]
    .filter(Boolean)
    .join('\n\n')
  const conclusion = [
    extractCaseSection(text, '出院时症状与体征'),
    extractCaseSection(text, '出院情况'),
  ]
    .filter(Boolean)
    .join('\n\n')
  return { findings, conclusion }
}

// 脏值防御：修复前的错误正则曾产出 "undefined-undefined-undefined" 并可能已落库，
// 日期字段必须是 YYYY-MM-DD，否则按空处理（界面不再显示 Invalid Date）。
const CASE_DATE_FIELDS = ['discharge_date', 'admission_date']
export function sanitizeCaseFields(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || v === '') continue
    if (CASE_DATE_FIELDS.includes(k) && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) continue
    out[k] = v
  }
  return out
}

// 住院天数推算：原文未写明时，用「出院日期 − 入院日期」的**自然日差**。
// 口径说明：国内医院「实际住院天数」通用算法即出院日减入院日（不计时刻），
// 例 2026-08-19 16:49 入院、2026-08-25 14:00 出院 → 记 6 天（按满 24h 只有 5.88 天）。
// 故本值属**推算**，原文写明时一律以原文为准，且用户可在录入表单直接改。
function deriveHospitalDays(admissionDate, dischargeDate) {
  if (!admissionDate || !dischargeDate) return ''
  const a = new Date(`${admissionDate}T00:00:00`)
  const d = new Date(`${dischargeDate}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(d.getTime())) return ''
  const days = Math.round((d - a) / 86400000)
  return days > 0 && days < 3650 ? String(days) : ''
}

// ---------- 诊断证明书（表单版式）字段抽取 ----------
// 证明书不是叙述式文书，而是「标签 + 值」的表单：主要诊断／其他诊断／入院日期／出院日期／
// 入院科室／出院科室／出院类别／出院医嘱。页脚还固定带一段免责声明（「说明：1. 本证明书
// 一式两份…」「在线查看胶片说明…」）。用出院记录的段落切分器去切它，会把页脚说明当诊断。
const CERT_SECTION_LABELS = [
  '主要诊断', '其他诊断', '入院诊断', '出院诊断', '临床诊断', '诊断',
  '出院医嘱', '建议休息', '休息', '损伤中毒原因',
  '入院日期', '信院日期', '出院日期', '住院天数',
  '入院科室', '出院科室', '出院类别', '科室',
  '姓名', '性别', '年龄', '医师', '医生', '说明', '在线查看胶片说明',
]
// 表单标签行：标签后常是「，」或全角冒号，OCR 也可能吞掉分隔符 → 分隔符可选。
const CERT_STOP_RE = new RegExp(`^(?:${CERT_SECTION_LABELS.join('|')})\\s*[：:，,、]?`)

// 剥掉证明书页脚：免责声明与云胶片广告都不是医学内容，留着必被当诊断/医嘱。
function stripCertFooter(text) {
  const lines = String(text || '').split('\n')
  const idx = lines.findIndex(
    (l) => /^\s*(说明|备注|注)\s*[：:，,]?\s*\d\s*[.、．]/.test(l) || /在线查看胶片说明|一式两份/.test(l)
  )
  return (idx > 0 ? lines.slice(0, idx) : lines).join('\n')
}

// 按表单标签取一个字段块：命中标签行后向下收集，遇到下一个表单标签即停。
function pickCertBlock(text, labels) {
  const lines = String(text || '').split('\n')
  for (const label of labels) {
    const startRe = new RegExp(`^\\s*${label}\\s*[：:，,、]`)
    for (let i = 0; i < lines.length; i++) {
      if (!startRe.test(lines[i])) continue
      const head = lines[i].replace(startRe, '').trim()
      const more = []
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j].trim()
        if (!ln) continue
        if (CERT_STOP_RE.test(ln)) break
        if (isCaseNoiseLine(ln)) continue
        more.push(ln)
      }
      const v = [head, ...more].join(' ').trim()
      if (v) return v
    }
  }
  return ''
}

// 证明书科室：表单把「入院科室／出院科室／出院类别」挤在同一行，只取第一个值，
// 不能整行照抄（否则科室会变成「血液内科出院类别:出院」）。
function pickCertDept(text) {
  const m = String(text || '').match(/(?:入院|出院)?科室\s*[：:，,]\s*([^\n]+)/)
  if (!m) return ''
  return (
    m[1]
      .split(/出院科室|入院科室|出院类别|出院日期|入院日期|出院医嘱|住院天数|医师|医生|科室/)[0]
      .replace(/^[\s，,、;；]+|[\s，,、;；]+$/g, '')
      .trim()
  )
}

export function extractCaseFields(text, kind) {
  const t = String(text || '')
  const fields = {}
  if (kind === 'discharge') {
    const dischargeDate = pickDate(t, /出院日期|出院时间/)
    const admissionDate = pickDate(t, /入院日期|入院时间/)
    // 住院天数写法多：「住院 14 天」「住院天数：14 天」「共住院 14 天」「住院天数：14」（无「天」）。
    // 仍要求「天」或显式「天数：」标签，防「住院号 123456」被误抽成天数。
    const daysM =
      t.match(/(?:共|计|总计)?\s*住院\s*(?:天数)?\s*[:：]?\s*(?:共|计)?\s*(\d{1,4})\s*天/) ||
      t.match(/住院天数\s*[:：]\s*(\d{1,4})/)
    // 分隔符可选：OCR 常吞掉全角冒号，只留「出院诊断」标签
    const diagnosis = pickBlock(t, '出院诊断')
    const advice = pickBlock(t, '出院医嘱')
    // 原文写明优先；未写明才按「出院日 − 入院日」推算
    const hospitalDays = daysM ? daysM[1] : deriveHospitalDays(admissionDate, dischargeDate)
    if (dischargeDate) fields.discharge_date = dischargeDate
    if (admissionDate) fields.admission_date = admissionDate
    if (hospitalDays) fields.hospital_days = hospitalDays
    if (diagnosis) fields.discharge_diagnosis = diagnosis
    if (advice) fields.discharge_advice = advice
  } else if (kind === 'cert') {
    // 表单版证明书：先剥页脚免责声明，再按表单标签取值（「主要诊断」优先于「诊断」）
    const body = stripCertFooter(t)
    const diagnosis =
      pickCertBlock(body, ['主要诊断', '出院诊断', '临床诊断', '入院诊断', '诊断']) ||
      pickInline(body, /临床诊断[:：]/)
    const restM = body.match(/休息\s*(?:治疗)?\s*(\d+)\s*天/) || body.match(/建议休息\s*(\d+)/)
    const dept = pickCertDept(body) || pickInline(body, /科室[:：]/)
    const doctor = pickInline(body, /医师\s*[：:，,]|医生\s*[：:，,]/)
    if (diagnosis) fields.diagnosis = diagnosis
    if (restM) fields.rest_days = restM[1]
    if (dept) fields.department = dept
    if (doctor) fields.doctor = doctor
  }
  return sanitizeCaseFields(fields)
}

// ---------- 总入口：全文 → 解析索引 ----------

export function parseDocText(text) {
  // 「骨髓」常被 OCR 误识为「骨通 / 骨随」（与 reportKind.fixOcrVariants 同口径）。
  // 在解析入口统一纠正一次，标题判定与所见段落识别才能同时受益。
  text = fixOcrVariants(cleanReportText(text))
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const { kind, doc_type } = detectDocType(text)
  const dt = extractDateTime(text)
  const { findings, conclusion } = splitSections(lines, kind)
  // 病历文书（出院记录 / 诊断证明）归入 case 类并抽取结构化字段；其它报告为 exam 类
  const category = ['discharge', 'cert'].includes(kind) ? 'case' : 'exam'
  const fields = category === 'case' ? extractCaseFields(text, kind) : {}
  // 病历文书没有「检查所见 / 诊断结论」章节，splitSections 返回空；改用真实段落映射
  const narrative = category === 'case' ? extractCaseNarrative(text, kind) : { findings: '', conclusion: '' }
  // 出院记录的归档日期必须是「出院日期」：全文首个日期通常是「入院日期」，
  // 直接取 dt 会把出院记录记成入院那天（列表排序也跟着错）。
  let date = dt ? dt.date : ''
  let time = dt ? dt.time : ''
  let reported_at = dt ? dt.reported_at : ''
  // 证明书同理：表单上「入院日期」在前、「出院日期」在后，取全文首个日期会记成入院那天。
  if (category === 'case' && (kind === 'discharge' || kind === 'cert')) {
    const dd = pickDateTime(text, /出院日期|出院时间/)
    if (dd) {
      date = dd.date
      time = dd.time || time
      reported_at = `${dd.date}${dd.time ? ' ' + dd.time : ''}`
    }
  }

  return {
    kind,
    doc_type,
    category,
    fields,
    date,
    time,
    reported_at,
    title:
      (category === 'case' && doc_type) ||
      extractTestItem(lines) ||
      stripHospitalPrefix(detectTitle(lines)) ||
      (doc_type ? `${doc_type}检查报告` : ''),
    part: extractBodyPart(text),
    findings: kind === 'genetic' ? formatGeneticFindings(findings) : narrative.findings || findings,
    conclusion: narrative.conclusion || conclusion,
    measures: category === 'case' ? [] : extractMeasures(text, kind),
  }
}
