// ===================== 病情三维度 · 报告文本抽取（规则层）=====================
// 输入一份报告（kind + 文本/所见/结论/通用 measures + 日期），输出**候选点**，不写库、不依赖 store。
// 分流是硬路由（由 kind 决定），绝不跨 kind 猜：
//   bonemarrow → morph；flow → fcm；genetic → pcr（且必须同句解析出数值）
//
// 真实性守卫（都来自本机真实报告，2026-10-19 实测）：
//   1) 「淋巴细胞占12.5%」不是原始细胞 → 无「原始/幼稚」绝不产点；
//   2) 「原始+幼稚淋巴细胞」中间常不带「细胞」二字；「原始粒细胞」不算（(?!粒)）；
//   3) 「异常细胞群体，约占有核细胞的1.2%」中间有「，约/的」，必须放行；
//   4) `BCRABLP210=0BCRABLP190=…` 相邻无分隔符，`=0` 后要用 lookahead 才能匹配；
//   5) NGS 定性（「具有BCRABLP190融合基因」）不产点；WT1/IKZF1/CSRP2 的 /ABL 比率不产点。
//
// 设计正文：.agents/proposals/disease-stream-trends.md §6.2（计划：disease-stream-plan.md S1）

import { STREAMS } from '../data/diseaseThresholds.js'

// ---------- 文本归一 ----------
// 全角数字/百分号/冒号等逐字归一；只对「数字,数字%」形态的逗号小数做替换，避免把列表逗号当小数点。
const FW_MAP = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '％': '%', '＜': '<', '＞': '>', '：': ':', '＝': '=', '／': '/',
  '－': '-', '＋': '+', '　': ' ',
}
const isFW = (ch) => Object.prototype.hasOwnProperty.call(FW_MAP, ch)

function normalizeText(text) {
  const s = String(text == null ? '' : text)
  let out = ''
  for (const ch of s) out += isFW(ch) ? FW_MAP[ch] : ch
  return out
    .replace(/\u00a0/g, ' ')
    .replace(/(\d)[,，](\d+)(\s*%)/g, '$1.$2$3') // 170,8% → 170.8%
}

const toNum = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '.'))
  return Number.isFinite(n) ? n : null
}

// 送检/采样日期（qPCR 的趋势时间应取采样日，不是报告日）
function parseSampledAt(text) {
  const m = text.match(/(?:送检|采样|采集|取样)日期\s*[:：]?\s*(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/)
  if (!m) return undefined
  const p = (n) => String(n).padStart(2, '0')
  return `${m[1]}-${p(m[2])}-${p(m[3])}`
}

// ---------- 形态学（morph）----------
// 报告常以「骨髓：… 血片：…」分两段；形态学目标只取骨髓段（血片原始% 另存、不参与 CR）。
function splitMarrow(text) {
  const idx = text.search(/血\s*片\s*[:：]/)
  if (idx < 0) return { marrow: text, blood: '' }
  return { marrow: text.slice(0, idx), blood: text.slice(idx) }
}

const BM_COMBO = /原始(?:淋巴)?(?:细胞)?\s*[+及和、/]\s*幼稚(?:淋巴)?细胞/
const BM_COMBO_VALUE = /[^。；\n，,]{0,16}?(\d+(?:\.\d+)?)\s*%/
// (?!粒|红)：原始粒细胞/幼稚粒细胞属髓系、原始红细胞/幼稚红细胞属红系，都不是本流目标（本例为 ALL）。
// 2026-10-24 事故：只看 (?!粒) 时「原始红细胞 0.5%」被当成原始细胞，覆盖了真实值「原幼淋 1.5%」。
const BM_EACH = /(原始|幼稚)(?!粒|红)(?:淋巴)?(?:细胞)?[^。；\n，,\d]{0,8}?(\d+(?:\.\d+)?)\s*%/g
// 「原幼淋 / 原幼细胞」是检验科对「原始+幼稚淋巴细胞」合计的缩写（「原幼红」「原幼粒」不属本流）
const BM_ABBR = /原幼(?!红|粒|单核|巨核|嗜酸|嗜碱)[^。；\n，,\d]{0,8}?(\d+(?:\.\d+)?)\s*%/g

function collectMarrowBlasts(segment) {
  const combo = segment.match(BM_COMBO)
  if (combo) {
    const tail = segment.slice(combo.index)
    const m = tail.match(BM_COMBO_VALUE)
    if (!m) return []
    // 否定句（「原始+幼稚淋巴细胞未见」后误跟其它百分数）不当阳性
    const beforeNum = tail.slice(0, tail.search(/[\d.]/))
    if (/未见|未检出|未发现|无|阴性|消失/.test(beforeNum)) return []
    return [{ label: '原始+幼稚', value: toNum(m[1]), raw: tail.slice(0, 32).trim(), confidence: 0.95 }]
  }
  const out = []
  for (const m of segment.matchAll(BM_ABBR)) {
    const chunk = m[0]
    const beforeNum = chunk.slice(0, chunk.search(/[\d.]/))
    if (/未见|未检出|未发现|无|阴性|消失/.test(beforeNum)) continue
    out.push({ label: '原幼', value: toNum(m[1]), raw: chunk.trim(), confidence: 0.9, combined: true })
  }
  if (out.length) {
    // 合计写法（原幼淋 X%）单独成立，不再与拆分行相加，避免重复计数
    return out.map((x) => ({ label: '原始+幼稚', value: x.value, raw: x.raw, confidence: x.confidence }))
  }
  for (const m of segment.matchAll(BM_EACH)) {
    const chunk = m[0]
    const beforeNum = chunk.slice(0, chunk.search(/[\d.]/))
    // 否定句（未见原始细胞…）不当阳性
    if (/未见|未检出|未发现|无|阴性|消失/.test(beforeNum)) continue
    out.push({ label: m[1], value: toNum(m[2]), raw: chunk.trim(), confidence: 0.9 })
  }
  // 同一段里「原始 X% + 幼稚 Y%」→ 求和；只有一项则按偏低置信度采用
  if (out.length >= 2) {
    const labels = new Set(out.map((x) => x.label))
    if (labels.has('原始') && labels.has('幼稚')) {
      const sum = out.reduce((a, x) => a + (x.value || 0), 0)
      return [{ label: '原始+幼稚', value: Number(sum.toFixed(2)), raw: out.map((x) => x.raw).join(' + '), confidence: 0.9 }]
    }
  }
  return out.map((x) => ({ ...x, confidence: 0.85 }))
}

function extractMorph(text, date, measures = []) {
  const { marrow, blood } = splitMarrow(text)
  const candidates = []
  const notes = []

  const bm = collectMarrowBlasts(marrow)
  if (bm.length) {
    const v = bm[0].value
    if (v != null) {
      candidates.push({
        stream: 'morph',
        code: STREAMS.morph.code,
        analyte: null,
        specimen: 'bone_marrow',
        date,
        value: v,
        qualifier: 'eq',
        unit: '%',
        lod: null,
        raw: bm[0].raw,
        evidence: bm[0].raw,
        confidence: bm[0].confidence,
        flags: [],
      })
    }
  } else {
    // 兜底：结构化 measures 里若明确是「原始/幼稚」项——必须排除髓系/红系/单核等分项，
    // 否则「原始红细胞 0.5%」会被当成本流的原始细胞（2026-10-24 事故）。
    const hit = measures.find(
      (m) =>
        m &&
        /原始|幼稚|原幼/.test(String(m.name || '')) &&
        !/粒|红|单核|巨核|嗜酸|嗜碱|浆细胞|血小板/.test(String(m.name || '')) &&
        toNum(m.value) != null
    )
    if (hit) {
      candidates.push({
        stream: 'morph',
        code: STREAMS.morph.code,
        analyte: null,
        specimen: 'bone_marrow',
        date,
        value: toNum(hit.value),
        qualifier: 'eq',
        unit: '%',
        lod: null,
        raw: `${hit.name}: ${hit.value}${hit.unit || '%'}`,
        evidence: `${hit.name}: ${hit.value}${hit.unit || '%'}`,
        confidence: 0.7,
        flags: [],
      })
    } else {
      notes.push('报告未给出原始/幼稚淋巴细胞比例（「淋巴细胞占比」不等于原始细胞）')
    }
  }

  // 血片段：单独一个点（虚线展示、不参与 CR 判定）
  const bl = collectMarrowBlasts(blood)
  if (bl.length && bl[0].value != null) {
    candidates.push({
      stream: 'morph',
      code: STREAMS.morph.code,
      analyte: null,
      specimen: 'peripheral_blood',
      date,
      value: bl[0].value,
      qualifier: 'eq',
      unit: '%',
      lod: null,
      raw: bl[0].raw,
      evidence: bl[0].raw,
      confidence: 0.8,
      flags: [],
    })
  }

  // 质量标记：取材稀释时比例仅供参考，不能认证 CR
  if (/取材稀释|稀释|取材不佳|凝集|部分溶解|有核细胞偏少|细胞偏少/.test(text)) {
    for (const c of candidates) c.flags.push('diluted_sample')
  }

  return { candidates, notes, conflicts: [] }
}

// ---------- 流式（fcm）----------
const F_LOD = /(?:检测)?(?:灵敏度|最低检出限|检测下限|LOD)\s*[:：]?\s*([\d.]+)\s*%/
const F_LT = /(?:MRD|微小残留)[^。；\n]{0,8}?[<＜]\s*([\d.]+)\s*%/
const F_MRD = /(?:MRD|微小残留(?:病|病灶)?|残留(?:白血病)?细胞)[^。；\n]{0,12}?(\d+(?:\.\d+)?)\s*%/
const F_ABN = /(?:异常|原始|幼稚|白血病)(?:细胞|淋巴细胞)?(?:群体)?\s*[,，]?\s*(?:约)?占[^。；\n]{0,8}?(\d+(?:\.\d+)?)\s*%/
const F_PRE = /(\d+(?:\.\d+)?)\s*%\s*(?:的)?(?:异常|原始|幼稚)[^。；\n]{0,10}/
const F_NEG = /(?:未见|未检出|未发现)[^。；\n]{0,12}?(?:异常|原始|幼稚|白血病|残留)/
const F_NEG2 = /MRD[^。；\n]{0,6}?阴性/

function specimenOf(text, fallback = 'bone_marrow') {
  const m = text.match(/标本(?:类型)?\s*[:：]?\s*(骨髓|外周血|静脉血|全血|血)/)
  if (!m) return { specimen: fallback, inferred: true }
  return { specimen: /骨髓/.test(m[1]) ? 'bone_marrow' : 'peripheral_blood', inferred: false }
}

function extractFlow(text, date, measures = []) {
  const lod = toNum((text.match(F_LOD) || [])[1])
  const { specimen } = specimenOf(text)
  const neg = F_NEG.test(text) || F_NEG2.test(text)
  const conflicts = []
  const notes = []

  let value = null
  let qualifier = 'eq'
  let evidence = ''
  let flags = []
  let confidence = 0.9

  const lt = text.match(F_LT)
  const mrd = text.match(F_MRD)
  const abn = text.match(F_ABN)
  const pre = text.match(F_PRE)

  if (lt) {
    // 「MRD<0.01%」：上界即该院 LOD（报告没写灵敏度时按此推断）
    value = toNum(lt[1])
    qualifier = 'lt'
    evidence = lt[0]
    confidence = 0.9
  } else if (mrd) {
    value = toNum(mrd[1])
    evidence = mrd[0]
    confidence = 0.9
  } else if (abn) {
    value = toNum(abn[1])
    evidence = abn[0]
    flags.push('surrogate')
    confidence = 0.8
  } else if (pre) {
    value = toNum(pre[1])
    evidence = pre[0]
    flags.push('surrogate')
    confidence = 0.75
  } else if (neg) {
    qualifier = 'nd'
    evidence = (text.match(F_NEG) || text.match(F_NEG2) || [''])[0]
    confidence = 0.9
  } else {
    const hit = measures.find((m) => m && /异常|MRD|原始|幼稚|残留/.test(String(m.name || '')) && toNum(m.value) != null)
    if (hit) {
      value = toNum(hit.value)
      evidence = `${hit.name}: ${hit.value}${hit.unit || '%'}`
      flags.push('surrogate')
      confidence = 0.65
    }
  }

  if (value == null && qualifier !== 'nd') {
    notes.push('流式报告未给出可解析的 MRD 数值')
    return { candidates: [], notes, conflicts }
  }
  if (value === 0) {
    qualifier = 'nd'
    value = null
  }
  // 数字与「未见异常」并存 → 取数字，但标记冲突供人工核对
  if (value != null && neg) {
    conflicts.push('流式报告同时出现数值与「未见异常」表述：已按数值入图，请核对原文')
  }
  if (value != null && lod != null && value < lod) flags.push('below_lod')

  return {
    candidates: [
      {
        stream: 'fcm',
        code: STREAMS.fcm.code,
        analyte: null,
        specimen,
        date,
        value,
        qualifier,
        unit: '%',
        lod: lod != null ? lod : qualifier === 'lt' ? value : null,
        raw: evidence,
        evidence,
        confidence,
        flags,
      },
    ],
    notes,
    conflicts,
  }
}

// ---------- 分子 qPCR（pcr）----------
// 转录本通道：兼容 BCRABLP190 / BCR-ABL1 P190 / bcr/abl p190 / BCR-ABL(P210)
const ABL = 'BCR[\\s\\-–—/]?ABL(?:1)?'
const P_COMPOUND = new RegExp(
  `${ABL}[\\s\\-–—]*(?:P)?\\s*(190|210|230)\\s*[=:：]\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*(\\d+(?:\\.\\d+)?)\\s*(?:[=:：]\\s*([\\d.]+)\\s*%)?`,
  'gi'
)
// 拷贝数式：BCR-ABL1(P210) 拷贝数 25，ABL 拷贝数 100000（无百分号，需除以内参）
const P_COPIES = new RegExp(
  `${ABL}[^。；\\n]{0,16}?(\\d+(?:\\.\\d+)?)[^。；\\n]{0,8}?ABL[^。；\\n]{0,10}?(\\d+(?:\\.\\d+)?)`,
  'gi'
)
// 单值式：=0 / =0.05；值后可能紧跟下一个 BCR（无分隔符）→ lookahead 放行
const P_SINGLE = new RegExp(
  `${ABL}[\\s\\-–—]*(?:P)?\\s*(190|210|230)\\s*[=:：]\\s*([\\d.]+)\\s*(?=[%％;；\\s]|$|BCR)`,
  'gi'
)
// 括号/空格式：BCR-ABL1(P210) 0.012%
const P_PAREN = new RegExp(
  `${ABL}[^。；\\n]{0,10}?[(（]?\\s*(P?(?:190|210|230))\\s*[)）]?[^。；\\n\\d]{0,8}?([\\d.]+)\\s*%`,
  'gi'
)
// 未检出/阴性（无数字）
const P_ND = new RegExp(`${ABL}[\\s\\-–—]*(?:P)?\\s*(190|210|230)?[^。；\\n]{0,12}?(?:未检出|阴性)`, 'gi')
// 上界：BCR-ABL1(P210) <0.001%
const P_LT = new RegExp(
  `${ABL}[\\s\\-–—]*(?:P)?\\s*(190|210|230)?[^。；\\n]{0,8}?[<＜]\\s*([\\d.]+)\\s*%`,
  'gi'
)
// 无转录本的裸百分数（最后兜底）：BCR-ABL1 0.012%
const P_BARE = new RegExp(`${ABL}[^。；\\n\\d]{0,12}?([\\d.]+)\\s*%`, 'gi')
const P_CTRL = /ABL\s*(?:基因)?\s*拷贝数\s*[=:：]\s*(\d+(?:\.\d+)?)/i

function extractPcr(text, date) {
  const sampled_at = parseSampledAt(text)
  const { specimen } = specimenOf(text)
  const ctrl = toNum((text.match(P_CTRL) || [])[1])
  const isStd = /国际标准|\bIS\b/i.test(text)
  const byKey = new Map() // analyte → candidate（高分模式先写，低分跳过）
  const conflicts = []
  const notes = []
  const put = (key, cand, priority) => {
    const prev = byKey.get(key)
    if (prev && prev._priority <= priority) return
    byKey.set(key, { ...cand, _priority: priority })
  }

  for (const m of text.matchAll(P_COMPOUND)) {
    const [, tx, copiesS, ctrlS, pctS] = m
    const copies = toNum(copiesS)
    const control = toNum(ctrlS)
    let value = pctS != null ? toNum(pctS) : control ? (copies / control) * 100 : null
    if (value == null) continue
    const flags = []
    if (pctS != null && control) {
      const expected = (copies / control) * 100
      const tol = Math.max(0.02, expected * 0.05)
      if (Math.abs(value - expected) > tol) {
        flags.push('ratio_inconsistent')
        conflicts.push(
          `P${tx} 拷贝数/百分数不一致：${copies}/${control} = ${expected.toFixed(4)}%，报告写 ${value}%`
        )
      }
    }
    put('P' + tx, {
      stream: 'pcr',
      code: STREAMS.pcr.code,
      analyte: 'P' + tx,
      specimen,
      date,
      sampled_at,
      value, // 报告写 0 就存 0：判定靠 qualifier='nd'，展示照抄报告数值（2026-10-24 用户拍板）
      qualifier: value === 0 ? 'nd' : 'eq',
      unit: '%',
      lod: null,
      is_standardized: isStd,
      copies,
      control_copies: control,
      raw: m[0],
      evidence: m[0],
      confidence: flags.length ? 0.5 : 0.95,
      flags,
    }, 1)
  }

  for (const m of text.matchAll(P_COPIES)) {
    // 复合式（copies/control）已由 P_COMPOUND 处理；含斜杠的片段留给它。
    // 另：跨两个转录本的片段（如 `P210=0BCRABLP190`）会被本模式误读成「拷贝数 210 / 190」，
    // 用「两个数都像转录本号 / 片段里出现多次 BCR」排除。
    if (m[0].includes('/')) continue
    if (/^(190|210|230)$/.test(m[1]) && /^(190|210|230)$/.test(m[2])) continue
    if ((m[0].match(/BCR/gi) || []).length > 1) continue
    const copies = toNum(m[1])
    const control = toNum(m[2])
    if (copies == null || !control) continue
    const value = (copies / control) * 100
    put('other', {
      stream: 'pcr',
      code: STREAMS.pcr.code,
      analyte: 'other',
      specimen,
      date,
      sampled_at,
      value, // 报告写 0 就存 0：判定靠 qualifier='nd'，展示照抄报告数值（2026-10-24 用户拍板）
      qualifier: value === 0 ? 'nd' : 'eq',
      unit: '%',
      lod: null,
      is_standardized: isStd,
      copies,
      control_copies: control,
      raw: m[0],
      evidence: m[0],
      confidence: 0.8,
      flags: [],
    }, 2)
  }

  for (const m of text.matchAll(P_SINGLE)) {
    const [, tx, valS] = m
    const value = toNum(valS)
    if (value == null) continue
    put('P' + tx, {
      stream: 'pcr',
      code: STREAMS.pcr.code,
      analyte: 'P' + tx,
      specimen,
      date,
      sampled_at,
      value, // 报告写 0 就存 0：判定靠 qualifier='nd'，展示照抄报告数值（2026-10-24 用户拍板）
      qualifier: value === 0 ? 'nd' : 'eq',
      unit: '%',
      lod: null,
      is_standardized: isStd,
      copies: null,
      control_copies: ctrl,
      raw: m[0],
      evidence: m[0],
      confidence: 0.85,
      flags: [],
    }, 3)
  }

  for (const m of text.matchAll(P_LT)) {
    const tx = m[1] ? 'P' + m[1] : 'other'
    const value = toNum(m[2])
    if (value == null) continue
    put(tx, {
      stream: 'pcr',
      code: STREAMS.pcr.code,
      analyte: tx,
      specimen,
      date,
      sampled_at,
      value,
      qualifier: 'lt',
      unit: '%',
      lod: value,
      is_standardized: isStd,
      copies: null,
      control_copies: ctrl,
      raw: m[0],
      evidence: m[0],
      confidence: 0.85,
      flags: ['below_lod'],
    }, 4)
  }

  for (const m of text.matchAll(P_PAREN)) {
    const tx = String(m[1]).replace(/^P/, '')
    const value = toNum(m[2])
    if (value == null) continue
    put('P' + tx, {
      stream: 'pcr',
      code: STREAMS.pcr.code,
      analyte: 'P' + tx,
      specimen,
      date,
      sampled_at,
      value, // 报告写 0 就存 0：判定靠 qualifier='nd'，展示照抄报告数值（2026-10-24 用户拍板）
      qualifier: value === 0 ? 'nd' : 'eq',
      unit: '%',
      lod: null,
      is_standardized: isStd,
      copies: null,
      control_copies: ctrl,
      raw: m[0],
      evidence: m[0],
      confidence: 0.85,
      flags: [],
    }, 5)
  }

  for (const m of text.matchAll(P_ND)) {
    const tx = m[1] ? 'P' + m[1] : 'other'
    put(tx, {
      stream: 'pcr',
      code: STREAMS.pcr.code,
      analyte: tx,
      specimen,
      date,
      sampled_at,
      value: null,
      qualifier: 'nd',
      unit: '%',
      lod: null,
      is_standardized: isStd,
      copies: null,
      control_copies: ctrl,
      raw: m[0],
      evidence: m[0],
      confidence: 0.9,
      flags: [],
    }, 6)
  }

  // 只在完全没有任何带转录本结果时，才用裸百分数兜底（避免重复出 other 通道）
  if (!byKey.size) {
    for (const m of text.matchAll(P_BARE)) {
      const value = toNum(m[1])
      if (value == null) continue
      put('other', {
        stream: 'pcr',
        code: STREAMS.pcr.code,
        analyte: 'other',
        specimen,
        date,
        sampled_at,
        value, // 报告写 0 就存 0（同上）
        qualifier: value === 0 ? 'nd' : 'eq',
        unit: '%',
        lod: null,
        is_standardized: isStd,
        copies: null,
        control_copies: ctrl,
        raw: m[0],
        evidence: m[0],
        confidence: 0.6,
        flags: [],
      }, 7)
    }
  }

  const candidates = [...byKey.values()].map(({ _priority, ...rest }) => rest)
  if (!candidates.length && /BCR[\s\-–—/]?ABL/i.test(text)) {
    notes.push('报告提及 BCR-ABL 但未给出可解析的数值（定性结论不入流）')
  }
  return { candidates, notes, conflicts }
}

// ---------- 对外入口 ----------
/**
 * 从一份报告抽取病情指标候选点（纯函数，无副作用）。
 * @param {Object} input
 * @param {'bonemarrow'|'flow'|'genetic'} input.kind 报告类别（决定分流）
 * @param {string} [input.text]          报告全文
 * @param {string} [input.findings]      检查所见
 * @param {string} [input.conclusion]    结论
 * @param {Array}  [input.measures]      通用关键测量值 [{name,value,unit}]
 * @param {string} [input.date]          报告日期 YYYY-MM-DD（采样日由文本内「送检日期」补）
 * @returns {{candidates: Array, notes: string[], conflicts: string[]}}
 */
export function extractStreamMetrics(input = {}) {
  const { kind, text = '', findings = '', conclusion = '', measures = [], date = '' } = input
  const full = normalizeText([text, findings, conclusion].filter(Boolean).join('\n'))
  const ms = Array.isArray(measures) ? measures : []

  if (kind === 'bonemarrow') return extractMorph(full, date, ms)
  if (kind === 'flow') return extractFlow(full, date, ms)
  if (kind === 'genetic') return extractPcr(full, date)
  return { candidates: [], notes: ['该报告类别不进入病情三维度（仅 bonemarrow/flow/genetic）'], conflicts: [] }
}
