// ===================== 病情三维度 · 判定（纯函数）=====================
// 单点达标 → 单流状态 → 缓解阶梯。零依赖（除阈值常量），可在 node 直接跑。
//
// 阶梯口径（用户 2026-10-19 拍板，2026-10-28 增补 CMR 单证与持续口径）：
//   「CR 只是及格线，CMR 才是金牌准入证。」
//   → 先过形态学闸门（≤5% 且非取材稀释、非陈旧），再看分子/免疫深度；
//   → 缺数据/陈旧不认证更高层级，而是明确写出缺口（不拿陈旧数据领金牌）。
//   → 例外（2026-10-28 拍板）：CMR 的锚定项是**分子学**（BCR-ABL1 未检出），FCM 是佐证。
//     故 qPCR 未检出时，FCM**未做/陈旧**不再否决第 4 级，而是标 certify:'molecular'（单证）；
//     FCM**阳性**仍是真矛盾 → 停在第 2 级 + conflicts，不升 4 级。
//
// 单点状态：pass | fail | nd | pending（未确认）| invalid（不一致）| missing（无点）
// 阶梯层级：0 未达 CR（含缺/陈旧/稀释）｜1 形态学缓解｜2 MMR｜3 深度缓解｜4 CMR（双证/单证）

import { STREAMS, TARGETS, CMR_STREAK } from '../data/diseaseThresholds.js'

const DAY_MS = 86400000
const dateOnly = (d) => String(d == null ? '' : d).slice(0, 10)
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/** 两个 YYYY-MM-DD 之间相差的天数（to - from）；非法输入返回 null */
export function daysBetween(from, to) {
  const a = new Date(`${dateOnly(from)}T00:00:00`).getTime()
  const b = new Date(`${dateOnly(to)}T00:00:00`).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / DAY_MS)
}

/** 本地今天（YYYY-MM-DD） */
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 百分比格式化（按量级自适应，避免 0.0012 被截成 0） */
export function formatPct(v) {
  const n = num(v)
  if (n == null) return '—'
  if (n === 0) return '0'
  if (n >= 100) return String(Math.round(n * 10) / 10)
  if (n >= 1) return String(Math.round(n * 100) / 100)
  if (n >= 0.01) return String(Math.round(n * 1000) / 1000)
  return String(Number(n.toPrecision(3)))
}

/**
 * 单点是否达标
 * @param {'morph'|'fcm'|'pcr'} streamKey
 * @param {Object} point
 * @returns {'pass'|'fail'|'nd'|'pending'|'invalid'|'missing'}
 */
export function gradePoint(streamKey, point, targets = TARGETS) {
  const def = STREAMS[streamKey]
  if (!def) return 'missing'
  if (!point) return 'missing'
  if (point.verified === false) return 'pending'
  if (point.qualifier === 'nd') return 'nd'
  const v = num(point.value)
  if (v == null) return 'invalid'
  if (v === 0) {
    // 0 在形态学是有效值（0%），在 fcm/pcr 是「未检出」的另一种写法
    return streamKey === 'morph' ? 'pass' : 'nd'
  }
  const target = num(targets[streamKey])
  if (target == null) return 'invalid'
  if (def.target.op === 'lt') return v < target ? 'pass' : 'fail'
  return v <= target ? 'pass' : 'fail'
}

/**
 * 参与「判定」的标本来源：**形态学只认骨髓片**。
 * 血片原幼% 由 streamExtract 另存（`specimen='peripheral_blood'`），只作展示/对照，不参与 CR 判定与阶梯认证。
 * fcm / pcr 不做标本过滤（同一流内可比）。
 */
const JUDGE_SPECIMEN = { morph: 'bone_marrow' }

/**
 * 该点是否属于该流的「判定标本」（缺 specimen 的历史点按骨髓片处理，与 diseaseIngest 默认口径一致）。
 * 2026-11-03 修复：此前判定层只按 stream+code 过滤，报告「血片：原幼 8%」抽出的点会顶替骨髓点
 * 成为「最新点」，把整条阶梯判成未达 CR —— 与 streamExtract 的「血片不参与 CR」自相矛盾。
 */
export function isJudgedSpecimen(streamKey, point) {
  const want = JUDGE_SPECIMEN[streamKey]
  if (!want) return true
  return ((point && point.specimen) || 'bone_marrow') === want
}

/** 点是否可用于「认证」层级：已确认、达标、非陈旧、非稀释标本、判定标本来源 */
export function isCertifiable(streamKey, point, stale) {
  if (!point || stale) return false
  if (!isJudgedSpecimen(streamKey, point)) return false
  const level = gradePoint(streamKey, point)
  if (level !== 'pass' && level !== 'nd') return false
  if (streamKey === 'morph' && (point.flags || []).includes('diluted_sample')) return false
  return true
}

/**
 * 单条流的当前状态（只统计「已确认」点；未确认点单独计数，不上图/不判定）
 * 判定只看**判定标本**（形态学只认骨髓片，见 JUDGE_SPECIMEN）：血片点照常展示，但不参与判定。
 * @param {Array} points 全部病情点
 * @param {'morph'|'fcm'|'pcr'} streamKey
 * @param {string} today YYYY-MM-DD
 * @param {{primaryAnalyte?:string}} [opts] pcr 只看主标志物通道
 */
export function streamState(points, streamKey, today, opts = {}) {
  const def = STREAMS[streamKey]
  if (!def) return null
  const all = (Array.isArray(points) ? points : []).filter((p) => {
    if (!p || p.stream !== streamKey || p.code !== def.code) return false
    if (streamKey === 'pcr' && opts.primaryAnalyte && p.analyte && p.analyte !== opts.primaryAnalyte) return false
    return true
  })
  // 判定集：去掉非判定标本（血片）；未确认点仍以该流全量为基数计数，不因标本过滤而漏报
  const judged = all.filter((p) => isJudgedSpecimen(streamKey, p))
  const verified = judged.filter((p) => p.verified !== false)
  const pending = all.length - all.filter((p) => p.verified !== false).length
  const sorted = [...verified].sort((a, b) => {
    const d = dateOnly(a.date).localeCompare(dateOnly(b.date))
    if (d !== 0) return d
    return String(a.created_at || '').localeCompare(String(b.created_at || ''))
  })
  const latest = sorted.length ? sorted[sorted.length - 1] : null
  const level = gradePoint(streamKey, latest)
  const daysSince = latest ? daysBetween(latest.date, today) : null
  const stale = daysSince != null && daysSince > def.staleDays
  const certifiable = isCertifiable(streamKey, latest, stale)
  return {
    stream: streamKey,
    latest,
    level,
    daysSince,
    stale,
    missing: !latest,
    certifiable,
    pending,
    count: verified.length,
    points: sorted,
    // 本流里存在、但不参与判定的点（目前只有形态学的血片点）：UI 可据此说明「已另存、不认证」
    excludedCount: all.length - judged.length,
  }
}

/**
 * qPCR 主标志物：初诊（最早一次）唯一阳性通道；没有阳性则取最早出现的通道；再兜底 P190。
 * 不与其它转录本相加/比较。
 */
export function pickPrimaryAnalyte(points) {
  const pcr = (Array.isArray(points) ? points : []).filter(
    (p) => p && p.stream === 'pcr' && p.verified !== false && p.analyte && p.analyte !== 'other'
  )
  if (!pcr.length) {
    const others = (Array.isArray(points) ? points : []).filter(
      (p) => p && p.stream === 'pcr' && p.verified !== false && p.analyte === 'other'
    )
    return others.length ? 'other' : 'P190'
  }
  const sorted = [...pcr].sort((a, b) => dateOnly(a.date).localeCompare(dateOnly(b.date)))
  const firstDate = dateOnly(sorted[0].date)
  const sameDay = sorted.filter((p) => dateOnly(p.date) === firstDate)
  const positive = sameDay.find((p) => num(p.value) > 0 && p.qualifier !== 'nd')
  if (positive) return positive.analyte
  // 初诊当天全未检出：优先取「历史上真正检出过」的最早通道，避免把旁路通道当靶标
  const ever = sorted.find((p) => num(p.value) > 0 && p.qualifier !== 'nd')
  if (ever) return ever.analyte
  return sorted[0].analyte
}

/**
 * 该转录本通道是否「检出过」：存在任一点为阳性（qualifier 非 nd 且值 > 0）。
 * 一旦阳性过就一直算「检出」，此后转阴仍是同一病人的监测靶标（不因 CMR 被折叠）。
 */
export function analyteEverDetected(points, analyte) {
  return (Array.isArray(points) ? points : []).some(
    (p) =>
      p &&
      p.stream === 'pcr' &&
      p.verified !== false &&
      (p.analyte || 'other') === analyte &&
      p.qualifier !== 'nd' &&
      num(p.value) > 0
  )
}

/**
 * 分子流展示哪些转录本通道（用户 2026-10-24 口径：一个病人一般只有一种分型，
 * 只展示检出的那一型）：
 *   - 主标志物通道 + 任何检出过的通道 → 展示（真共表达时两型都留）；
 *   - 整列都是「未检出」的旁路通道 → 折叠（不占表格行、不进图例）。
 * @returns {{shown:string[], hidden:string[]}} 顺序：主标志物在前，其余按字母序
 */
export function pcrChannels(points, primary) {
  const seen = [...new Set((Array.isArray(points) ? points : []).map((p) => (p && p.analyte) || 'other'))]
  const shown = []
  const hidden = []
  for (const a of seen) {
    if (a === primary || analyteEverDetected(points, a)) shown.push(a)
    else hidden.push(a)
  }
  const byPrimary = (a, b) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b))
  return { shown: shown.sort(byPrimary), hidden: hidden.sort((a, b) => a.localeCompare(b)) }
}

/** 相对基线的 log 下降（log10(baseline / current)）；任一无效返回 null */
export function logReduction(baseline, current) {
  const b = num(baseline)
  const c = num(current)
  if (b == null || c == null || b <= 0 || c <= 0) return null
  return Math.log10(b / c)
}

/** 基线值：最早一次已确认 pcr 点的数值（未检出则 null） */
export function pcrBaseline(points, analyte) {
  const list = (Array.isArray(points) ? points : [])
    .filter((p) => p && p.stream === 'pcr' && p.verified !== false)
    .filter((p) => !analyte || p.analyte === analyte)
    .sort((a, b) => dateOnly(a.date).localeCompare(dateOnly(b.date)))
  const first = list[0]
  return first ? num(first.value) : null
}

/**
 * 「未检出」的两种写法：qualifier==='nd'，或报告直接写 0%（value 0）。
 * 与 gradePoint 同口径（:60-62「0 在 fcm/pcr 是未检出的另一种写法」）——
 * 2026-10-28 修：此前 cmrStreak 只认 qualifier==='nd'，会把「报告写 0%」的点当成阳性打断连续段。
 */
export function isUndetectable(point) {
  if (!point) return false
  if (point.qualifier === 'nd') return true
  return num(point.value) === 0
}

/** 'YYYY-MM-DD' 加 n 个日历年（2/29 → 该年 2 月最后一天）；非法输入返回 null */
export function addYears(dateStr, n) {
  const d = dateOnly(dateStr)
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const y = Number(m[1]) + n
  const mo = Number(m[2])
  const day = Number(m[3])
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate() // 该月最后一天
  return `${y}-${String(mo).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

/**
 * qPCR 连续未检出（CMR 持续性）：从最近一次往前数连续未检出的条数、天数跨度、段内最大间隔。
 *
 * 2026-10-28 增：**间隔超 maxGapDays（180）即打断**，否则「只查两次、相隔 1409 天」会被算成
 * 1409 天连续缓解（脱管黑盒）。被打断的上一段写入 broken，供 UI 显示历史。
 * 只统计已确认点；只做记录，不预测复发。
 *
 * @returns {{count:number, days:number, from:string|null, to:string|null, maxGapDays:number,
 *            broken:null|{gapDays:number, count:number, days:number, from:string, to:string}}}
 */
export function cmrStreak(points, analyte, opts = {}) {
  const gapLimit = num(opts.maxGapDays) ?? CMR_STREAK.maxGapDays
  const list = (Array.isArray(points) ? points : [])
    .filter((p) => p && p.stream === 'pcr' && p.verified !== false)
    .filter((p) => !analyte || p.analyte === analyte)
    .sort((a, b) => dateOnly(a.date).localeCompare(dateOnly(b.date)))

  const segDays = (seg) =>
    seg.length > 1 ? Math.max(0, daysBetween(seg[0].date, seg[seg.length - 1].date) || 0) : 0

  let cur = null // 当前可信连续段
  let prev = null // 被间隔打断的上一段
  let breakGap = null
  for (const p of list) {
    if (!isUndetectable(p)) {
      cur = null // 阳性点：段归零
      continue
    }
    if (cur) {
      const gap = daysBetween(cur[cur.length - 1].date, p.date)
      if (gap != null && gap > gapLimit) {
        prev = cur
        breakGap = gap
        cur = null
      }
    }
    if (!cur) cur = []
    cur.push(p)
  }

  const seg = cur || []
  const count = seg.length
  const from = count ? dateOnly(seg[0].date) : null
  const to = count ? dateOnly(seg[count - 1].date) : null
  let maxGap = 0
  for (let i = 1; i < seg.length; i++) {
    maxGap = Math.max(maxGap, daysBetween(seg[i - 1].date, seg[i].date) || 0)
  }

  return {
    count,
    days: segDays(seg),
    from,
    to,
    maxGapDays: maxGap,
    broken: prev
      ? {
          gapDays: breakGap,
          count: prev.length,
          days: segDays(prev),
          from: dateOnly(prev[0].date),
          to: dateOnly(prev[prev.length - 1].date),
        }
      : null,
  }
}

/**
 * 「持续 CMR」进度（展示用，不改档位）。
 * 终点 = 首次未检出 + milestoneYears 个日历年（闰年安全，见 addYears）。
 * state：none 无连续段｜fresh 最近一次在有效期内｜due 超过 qPCR 有效期（此时档位已降级）
 */
export function cmrProgress(streak, today, opts = {}) {
  const years = num(opts.milestoneYears) ?? CMR_STREAK.milestoneYears
  const staleDays = STREAMS.pcr.staleDays
  const empty = {
    state: 'none',
    years,
    staleDays,
    targetDate: null,
    totalDays: 0,
    elapsedDays: 0,
    restDays: 0,
    pct: 0,
    sinceLast: null,
    lastDate: null,
  }
  if (!streak || !streak.count || !streak.from) return empty
  const targetDate = addYears(streak.from, years)
  const totalDays = Math.max(1, daysBetween(streak.from, targetDate) || 0)
  const elapsedDays = Math.max(0, streak.days || 0)
  const sinceLast = streak.to ? daysBetween(streak.to, today) : null
  return {
    state: sinceLast == null ? 'none' : sinceLast > staleDays ? 'due' : 'fresh',
    years,
    staleDays,
    targetDate,
    totalDays,
    elapsedDays,
    restDays: Math.max(0, totalDays - elapsedDays),
    pct: Math.max(0, Math.min(100, Math.round((elapsedDays / totalDays) * 100))),
    sinceLast,
    lastDate: streak.to,
  }
}

export const TIER_LABELS = Object.freeze({
  0: '未达 CR',
  1: '形态学缓解',
  2: 'MMR',
  3: '深度缓解',
  4: 'CMR',
})

function tier0(reason, label, extra = {}) {
  return {
    tier: 0,
    reason,
    certify: null,
    label,
    certifiers: [],
    gaps: extra.gaps || [],
    conflicts: extra.conflicts || [],
  }
}

/**
 * 缓解阶梯
 * @param {{morph:Object, fcm:Object, pcr:Object}} states 三条流的 streamState 结果
 * @param {string} today
 */
export function ladderOf(states = {}, today) {
  const m = states.morph
  const p = states.pcr
  const f = states.fcm
  const gaps = []
  const conflicts = []

  // ---- 闸门：形态学 CR ----
  if (!m || m.missing) {
    return tier0('missing', '未达 CR 判定（缺形态学数值）', { gaps: ['形态学未检测或报告未给出原始/幼稚比例'] })
  }
  if (m.level === 'pending') return tier0('pending', '形态学待确认', { gaps: ['形态学候选点尚未确认'] })
  if (m.level === 'invalid') return tier0('invalid', '形态学数据异常', { gaps: ['形态学数值无法判读'] })
  if (m.level === 'fail') {
    return tier0('fail', '未达 CR', {
      gaps: [`原始/幼稚淋巴细胞 ${formatPct(m.latest.value)}%（目标 ≤5%）`],
    })
  }
  if (m.stale) {
    return tier0('stale', 'CR 待复查（形态学数据陈旧）', {
      gaps: [`形态学最近一次在 ${m.daysSince} 天前（有效期 ${STREAMS.morph.staleDays} 天）`],
    })
  }
  if ((m.latest.flags || []).includes('diluted_sample')) {
    return tier0('diluted', 'CR 待复核（形态学取材稀释）', { gaps: ['该次骨髓取材稀释，比例不能认证 CR'] })
  }

  // ---- 深度：分子 + 免疫 ----
  const pcrFresh = p && !p.missing && !p.stale
  const fcmFresh = f && !f.missing && !f.stale
  const pcrNd = pcrFresh && p.level === 'nd'
  const pcrPass = pcrFresh && p.level === 'pass'
  const fcmNeg = fcmFresh && (f.level === 'pass' || f.level === 'nd')

  if (p.missing) gaps.push('qPCR 未检测')
  else if (p.stale) gaps.push(`qPCR 数据陈旧（${p.daysSince} 天前，有效期 ${STREAMS.pcr.staleDays} 天）`)
  else if (p.level === 'invalid') gaps.push('qPCR 拷贝数与百分数不一致，待人工核对')
  else if (p.level === 'fail') gaps.push(`qPCR ${formatPct(p.latest.value)}% 未达 MMR（≤0.1%）`)
  if (f.missing) gaps.push('FCM 未检测')
  else if (f.stale) gaps.push(`FCM 数据陈旧（${f.daysSince} 天前，有效期 ${STREAMS.fcm.staleDays} 天）`)
  else if (f.level === 'invalid') gaps.push('FCM 数值无法判读，待核对')
  else if (f.level === 'fail') gaps.push(`FCM-MRD 阳性（${formatPct(f.latest.value)}%）`)

  // 两法方向不一致（同一时点：一方达标/未检出、另一方阳性）
  if (pcrFresh && fcmFresh) {
    if ((pcrNd || pcrPass) && f.level === 'fail') {
      conflicts.push('qPCR 达标而 FCM 阳性：两法方向不一致，建议核对标本/引物覆盖/免疫表型')
    } else if (p.level === 'fail' && fcmNeg) {
      conflicts.push('qPCR 未达标而 FCM 阴性：两法方向不一致，建议核对采样与检测方法')
    }
  }

  const certifiers = ['morph']
  const fcmFail = fcmFresh && f.level === 'fail'

  // 第 4 级 CMR：锚定项是分子学（qPCR 未检出），FCM 是佐证（2026-10-28 拍板）
  //   ① 双证：FCM 阴性/未检出 → 金标
  //   ② 单证：FCM 未做/陈旧/无法判读 → 仍判 4 级，但明确标注「仅分子学」，不当双证卖
  //   ③ FCM 阳性 → 真矛盾（反证据≠缺证据）→ 不升 4 级，停在 2 级 + conflict 人工核对
  if (pcrNd && !fcmFail) {
    const double = fcmNeg
    certifiers.push('pcr')
    if (double) certifiers.push('fcm')
    else if (f.latest && f.level === 'fail') {
      // 上一次流式是阳性、只是过了有效期：属「陈旧的反证据」，不能静默当缺证据
      gaps.push('上次 FCM 为阳性（已陈旧）：单证 CMR 仍需核对流式是否真的转阴')
    } else gaps.push('本次只有分子学证据（单证 CMR），非双证')
    return {
      tier: 4,
      reason: 'cmr',
      certify: double ? 'double' : 'molecular',
      label: double ? 'CMR（qPCR 未检出 + FCM 阴性）' : 'CMR（仅分子学·FCM 未确认）',
      certifiers,
      gaps,
      conflicts,
    }
  }
  if (pcrPass && fcmNeg) {
    certifiers.push('pcr', 'fcm')
    return {
      tier: 3,
      reason: 'deep',
      certify: null,
      label: '深度缓解（MMR + FCM 阴性）',
      certifiers,
      gaps,
      conflicts,
    }
  }
  if (pcrNd) {
    // qPCR 未检出但 FCM 阳性 → 停在第 2 级，等人工核对矛盾
    certifiers.push('pcr')
    return {
      tier: 2,
      reason: 'mmr',
      certify: null,
      label: 'MMR（qPCR 未检出；FCM 阳性待核对）',
      certifiers,
      gaps,
      conflicts,
    }
  }
  if (pcrPass) {
    certifiers.push('pcr')
    return { tier: 2, reason: 'mmr', certify: null, label: 'MMR（BCR-ABL1 ≤0.1%）', certifiers, gaps, conflicts }
  }
  // 第 1 级只说形态学：完整 CR 还要求血象恢复（NEUT ≥1.0 / PLT ≥100）、外周血无原始、无髓外病灶，
  // 本系统都没有这两项数据，故不宣称「CR」（2026-10-28 用户口径）。
  return {
    tier: 1,
    reason: 'cr',
    certify: null,
    label: '形态学缓解（骨髓 ≤5%；血象与髓外未评价）',
    certifiers,
    gaps,
    conflicts,
  }
}
