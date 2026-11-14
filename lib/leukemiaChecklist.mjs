// MedBrief · 白血病核心资料体检（缺失探测，纯函数，只读不推断）
//
// 为什么要这一层（2026-11-14 用户口径）：
//   白血病门诊问诊必须齐「MICM 分型 + 近期血常规监测」，缺哪一项都要让家属知道该补传什么。
//   但**绝不阻塞打印**：缺项只做温和提示条（仅屏幕）+ 卡面 1 行如实声明，卡片照常出。
//
// 判定纪律（吃过教训，写死在这里）：
//   1. **不信 `kind`**：实测有 3 份「融合基因」报告被标成 `kind=imaging`，按 kind 判会误报「未检出」。
//      一律看 `reportType` + 正文 + 指标名。
//   2. **判不出就报缺**：宁可让家属多传一次，也不能谎称「已做」。
//   3. 只做「有没有这份材料」的探测，**不解读结果**（不做任何诊断性结论）。
//
// 实测底数（55 份真实报告 / 2026-11-14）：骨髓形态学缺、流式有(07-17)、融合基因有、染色体核型有(07-15)、
//   MRD 仅 07-15 一次无复查、最近一次化验 2026-08-05（101 天前 → 近期血常规缺）。

import { classifyAnalyte } from './reportIntake.mjs'

/** 「近期」口径：血常规 30 天内算近期；MRD 复查 90 天内算近期（白血病 MRD 随访通常按疗程）。 */
export const RECENT_CBC_DAYS = 30
export const RECENT_MRD_DAYS = 90

const dayOf = (rep) => String(rep.reportDate || rep.sampledAt || '').slice(0, 10)

/** 报告全文摘要（正文只取前 400 字：报告单抬头就写着「染色体核型分析报告单」这类标题）。 */
const haystack = (rep) =>
  [
    rep.reportType || '',
    rep.labName || '',
    rep.title || '',
    String(rep.text || rep.rawText || '').slice(0, 400),
    (rep.rows || []).map((r) => r.name || '').join(' '),
  ].join(' ')

const daysBetween = (from, to) => {
  const a = new Date(`${String(from || '').slice(0, 10)}T00:00:00`)
  const b = new Date(`${String(to || '').slice(0, 10)}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

const latestDate = (list) => list.map(dayOf).filter(Boolean).sort().slice(-1)[0] || ''

/**
 * @param {Array}  reports 已导入报告（每份含 reportType / text / rows / reportDate）
 * @param {Date}   today   注入「今天」便于测试
 * @returns {{items:Array<{key,label,ok,detail,date}>, missing:string[], summary:string, micmOk:number, micmTotal:number}}
 */
export function buildChecklist(reports = [], today = new Date()) {
  const todayStr = today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10)
  const reps = (reports || []).filter(Boolean)
  const items = []

  // ① 骨髓形态学（MICM 的 M）
  const morph = reps.filter((r) => /骨髓(?:形态|涂片|细胞学|穿刺|活检)|形态学分型|骨髓细胞学/.test(haystack(r)))
  items.push({
    key: 'marrow-morph',
    label: '骨髓形态学报告',
    missingLabel: '骨髓形态学报告',
    ok: morph.length > 0,
    date: latestDate(morph),
    detail: morph.length ? `${morph.length} 份` : '未检出',
  })

  // ② 流式免疫分型 + MRD（MICM 的 I）—— 分型有、但 MRD 复查过期也要说清楚
  const flow = reps.filter((r) => /免疫分型|流式细胞|流式.*(?:检测|分析)|FCM/i.test(haystack(r)))
  const mrdRows = reps.flatMap((r) => (r.rows || []).filter((row) => {
    const code = row.code || classifyAnalyte(row.name || '', {}).code || ''
    return ['MRD', 'FCM_MRD_PCT', 'BM_BLAST_PCT'].includes(code) || /MRD|微小残留|残留病/.test(row.name || '')
  }).map((row) => ({ ...row, reportDate: dayOf(r) })))
  const mrdDates = mrdRows.map((r) => String(r.measuredAt || r.reportDate || '').slice(0, 10)).filter(Boolean).sort()
  const mrdLatest = mrdDates.slice(-1)[0] || ''
  const mrdAge = mrdLatest ? daysBetween(mrdLatest, todayStr) : null
  const mrdFresh = mrdAge != null && mrdAge <= RECENT_MRD_DAYS
  const flowOk = flow.length > 0
  items.push({
    key: 'flow-mrd',
    label: '流式免疫分型 + MRD',
    // 缺的到底是「整份分型」还是「MRD 复查」，提示语必须分开说 —— 家属要知道补传哪一种
    missingLabel: flowOk ? 'MRD 复查' : '流式免疫分型',
    // 2026-11-14 用户口径：分型有、MRD 过期时，**「已见」里必须写「流式分型」**——
    // 否则家属看到「已见」只有基因/核型，以为流式根本没做过（实际做过，缺的是复查）。
    seenLabel: flowOk ? '流式分型' : '',
    seenDate: flowOk ? latestDate(flow) : '',
    ok: flowOk && mrdFresh,
    date: latestDate(flow) || mrdLatest,
    detail: !flowOk
      ? '未检出流式免疫分型报告'
      : mrdFresh
        ? `MRD 最近 ${mrdLatest}`
        : mrdLatest
          ? `有分型，但 MRD 仅 ${mrdLatest}（${mrdAge} 天前，超 ${RECENT_MRD_DAYS} 天）`
          : '有分型，但未检出 MRD 结果',
  })

  // ③ 融合基因（MICM 的 M 的分子部分）
  const fusion = reps.filter((r) => /融合基因|FISH|BCR[:\s]*ABL|PML[-\s]*RAR|染色体易位|基因重排/.test(haystack(r)))
  items.push({
    key: 'fusion',
    label: '融合基因 / FISH',
    missingLabel: '融合基因',
    ok: fusion.length > 0,
    date: latestDate(fusion),
    detail: fusion.length ? `${fusion.length} 份` : '未检出',
  })

  // ④ 染色体核型（MICM 的 C）
  const karyo = reps.filter((r) => /染色体核型|核型分析|G\s*显带|R\s*显带/.test(haystack(r)))
  items.push({
    key: 'karyotype',
    label: '染色体核型',
    missingLabel: '染色体核型',
    ok: karyo.length > 0,
    date: latestDate(karyo),
    detail: karyo.length ? `${karyo.length} 份` : '未检出',
  })

  // ⑤ 近期血常规（WBC / ANC / Hb / PLT 四项是否齐、是否在 30 天内）
  const cbcReports = reps.filter((r) => (r.rows || []).some((row) => {
    const code = row.code || classifyAnalyte(row.name || '', {}).code || ''
    return ['WBC', 'Hb', 'PLT', 'NEUT_ABS'].includes(code)
  }))
  const cbcDates = cbcReports.map(dayOf).filter(Boolean).sort()
  const cbcLatest = cbcDates.slice(-1)[0] || ''
  const cbcAge = cbcLatest ? daysBetween(cbcLatest, todayStr) : null
  const cbcFresh = cbcAge != null && cbcAge <= RECENT_CBC_DAYS
  // 缺项只看「最近一次血常规」里四项齐不齐（历史缺项不算，避免用老数据糊弄）
  const lastCbc = cbcReports.filter((r) => dayOf(r) === cbcLatest).slice(-1)[0]
  const lastCbcCodes = new Set((lastCbc?.rows || []).map((row) => row.code || classifyAnalyte(row.name || '', {}).code || ''))
  const expected = [['WBC', '白细胞(WBC)'], ['NEUT_ABS', '中性粒细胞绝对值(ANC)'], ['Hb', '血红蛋白(Hb)'], ['PLT', '血小板(PLT)']]
  const cbcMissing = cbcLatest ? expected.filter(([code]) => !lastCbcCodes.has(code)).map(([, label]) => label) : expected.map(([, label]) => label)
  items.push({
    key: 'recent-cbc',
    label: '近 30 天血常规',
    missingLabel: '近 30 天血常规',
    ok: cbcFresh && cbcMissing.length === 0,
    date: cbcLatest,
    detail: !cbcLatest
      ? '未检出任何血常规'
      : !cbcFresh
        ? `最近 ${cbcLatest}（${cbcAge} 天前，超 ${RECENT_CBC_DAYS} 天）`
        : cbcMissing.length
          ? `最近 ${cbcLatest}，缺 ${cbcMissing.join('、')}`
          : `最近 ${cbcLatest}，四项齐`,
  })

  const missing = items.filter((i) => !i.ok)
  const micmItems = items.filter((i) => i.key !== 'recent-cbc')
  // 「已见」= 完全齐的项 + 部分齐的项（如分型有但 MRD 过期 → 已见写「流式分型」、待补写「MRD 复查」）
  const seen = [
    ...items.filter((i) => i.ok).map((i) => ({ label: i.label, date: i.date })),
    ...items.filter((i) => !i.ok && i.seenLabel).map((i) => ({ label: i.seenLabel, date: i.seenDate || '' })),
  ]

  // 卡面第 1 页那 1 行小字：只陈述「已见/未检出」，不写任何临床解读
  const fmt = (list) => list.map((i) => (i.date ? `${i.label}(${i.date.slice(5)})` : i.label)).join('、')
  // 缺项带一句「为什么算缺」（未检出 / 过期 / 缺项），否则「未检出 MRD」会被误读成「没做过 MRD」
  const missText = (i) => {
    const label = i.missingLabel || i.label
    const d = String(i.detail || '')
    if (/未检出|未查出/.test(d)) return label
    return `${label}（${d}）`
  }
  const summary = missing.length
    ? `已见 ${seen.length ? fmt(seen) : '无'}；待补 ${missing.map(missText).join('、')}`
    : 'MICM 与近期血常规均已检出'

  // 卡面第 1 页那 1 行小字：**必须短**（1 行内），只写「已见哪些 / 待补哪些」，不带原因，
  // 原因留给屏幕上的提示条（`.checklist` 不进打印，见 CardPage）。
  // 只压「太长会把 1 行小字顶成 2 行」的那两项；核型/融合基因保持原名（缩短会让医生对不上报告抬头）
  const SHORT = { '流式免疫分型 + MRD': '流式分型', '骨髓形态学报告': '骨髓形态', '近 30 天血常规': '血常规' }
  const shortSeen = seen.map((i) => (i.date ? `${SHORT[i.label] || String(i.label).split(' ')[0]}(${i.date.slice(5)})` : (SHORT[i.label] || i.label))).join('、')
  const cardLine = missing.length
    ? `白血病核心项：已见 ${shortSeen || '无'}；待补 ${missing.map((i) => i.missingLabel || i.label).join('、')}`
    : `白血病核心项：MICM 与近期血常规均已检出（${shortSeen}）`

  return {
    items,
    cardLine,
    missing: missing.map((i) => i.missingLabel || i.label),
    missingDetail: missing.map((i) => ({ label: i.missingLabel || i.label, detail: i.detail })),
    summary,
    micmOk: micmItems.filter((i) => i.ok).length,
    micmTotal: micmItems.length,
  }
}
