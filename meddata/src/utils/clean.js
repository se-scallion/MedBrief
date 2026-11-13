// ===================== 历史数据清洗 =====================
// 场景：早期规则/字典不完善，导致历史 records 存在三类问题，本工具一次性修正：
//   1. 内容识别差异：规则/字典改过，历史 data_points 的 standard_code 与现在不一致
//   2. 标题识别错误：report_type 与内容不符（如血糖血脂报告被识别成 CBC_hsCRP）
//   3. 重复导入：同一化验单被多次导入（含"识别规则不同导致指纹不同"的隐性重复）
//
// 清洗策略（与 DataGrid「重新匹配」reMatchAll 语义一致）：
//   - 以 original_name（OCR 原始项目名）为准重新映射 standard_code；能映射即覆盖
//   - 补全单位/参考范围（仅当缺失）；重算 status
//   - 用重映射后的数据点重算 report_type
//   - 最后按 date + 指纹去重，每组保留识别最全的一条

import { mapAliasRobust, FIELD_BY_CODE } from '../data/dictionary.js'
import {
  isMissingPerL,
  unitOcrNoise,
  fingerprint,
  dateWithinDays,
  detectReportType,
  computeStatus,
  normalizeUnit,
  detectSuspiciousValue,
  auditPoint,
  reverseFieldMatch,
  resolveCrossRowDuplicates,
  normValue,
} from './normalize.js'

// 同族百分比/绝对值互改（如 LYM_PCT↔LYM_ABS）：属 OCR/字典歧义，风险高，清洗时不自动改，留给用户手动核对
function isPctAbsCross(a, b) {
  if (!a || !b) return false
  const ba = String(a).split('_')[0]
  const bb = String(b).split('_')[0]
  if (ba !== bb) return false
  const set = new Set([a, b])
  return set.has(ba + '_PCT') && set.has(ba + '_ABS')
}

// 单条记录质量排名：[已映射到字典的指标数, 指标总数, 可疑项取反, 导入时间取反]（越大越好）
function rankOf(record) {
  const pts = record.data_points || []
  const mapped = pts.filter((p) => p.standard_code && FIELD_BY_CODE[p.standard_code]).length
  const suspicious = pts.filter((p) => p._suspicious).length
  return [mapped, pts.length, -suspicious, -(new Date(record.created_at || 0).getTime())]
}

// a 是否优于 b（逐项比较，避免 join 字符串比较的跨位数误判）
function betterThan(a, b) {
  const ra = rankOf(a)
  const rb = rankOf(b)
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i]
  }
  return false
}

// ===== 疑似重复检测（隐性重复：同一化验单因识别差异值不同）=====
// 场景：同一张报告被导入两次，一次识别正确、一次小数点错位 / 列错位，
// 精确指纹（standard_code=值）不同，但项目集合高度重合、值存在系统性比例关系
// （如全部 ×0.1 / ×10），本质是同一份。这类只能提示，由用户确认后合并。
function byCode(record) {
  const m = new Map()
  for (const p of record.data_points || []) {
    if (p.standard_code) m.set(p.standard_code, p)
  }
  return m
}

// 项目集合 Jaccard 相似度
function codeSimilarity(a, b) {
  const sa = new Set((a.data_points || []).map((p) => p.standard_code).filter(Boolean))
  const sb = new Set((b.data_points || []).map((p) => p.standard_code).filter(Boolean))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const c of sa) if (sb.has(c)) inter++
  return inter / (sa.size + sb.size - inter)
}

// 系统性比例差异：交集项目的值统一呈 ×10^n 关系（小数点错位）
// 返回 { shift, count, total } 或 null
function systemicShift(a, b) {
  const mb = byCode(b)
  const lgs = []
  for (const pa of a.data_points || []) {
    const pb = mb.get(pa.standard_code)
    if (!pb) continue
    const va = parseFloat(pa.value)
    const vb = parseFloat(pb.value)
    if (!isFinite(va) || !isFinite(vb) || va === 0 || vb === 0) continue
    const r = vb / va
    if (r <= 0) continue
    const lg = Math.round(Math.log10(r))
    if (Math.abs(lg) <= 0.7) continue // 量级接近（0.2~5 倍）不算错位信号
    lgs.push(lg)
  }
  if (lgs.length < 3) return null
  const counts = new Map()
  for (const lg of lgs) counts.set(lg, (counts.get(lg) || 0) + 1)
  let best = null
  for (const [lg, cnt] of counts) if (!best || cnt > best.cnt) best = { lg, cnt }
  if (best.cnt >= Math.max(3, Math.ceil(lgs.length * 0.6))) {
    return { shift: Math.pow(10, best.lg), count: best.cnt, total: lgs.length }
  }
  return null
}

// 共有指标的值一致比例：用于「疑似重复」的弱信号判定。
// 同天同类型的两次真实不同采集，共有指标的值会明显不同；而同一张化验单的两次 OCR 差异，
// 共有指标的值基本一致（只是个别项目缺失/多了脏值）。用这个比例区分两者，避免误报。
function matchedValueAgreement(a, b) {
  const mb = byCode(b)
  let same = 0
  let total = 0
  for (const pa of a.data_points || []) {
    if (!pa.standard_code) continue
    const pb = mb.get(pa.standard_code)
    if (!pb) continue
    total++
    if (normValue(pa.value) === normValue(pb.value)) same++
  }
  return { ratio: total ? same / total : 0, same, total }
}

// 判断两条记录是否为「疑似重复」
// opts.maxDateGap：允许的日期相差天数，默认 0（必须同日，清洗阶段的保守口径）。
// 导入查重传 30 —— 因为「日期识别修正后，同一份报告的新旧记录日期可能相差多天」：
// 旧记录的日期曾 fallback 到「导入当天」（见 bugs.md Bug 038），修正后才识别为报告真值，
// 于是同一份报告的两条记录日期可能相差数天乃至数周。若只认同日，
// 这类「日期被修正过的重复」将永远查不出来。日期在此仅作粗筛——
// 真正的判据是后面三重相似度约束（同类型 + 指标集重合 + 共有值一致）。
export function isFuzzyDup(a, b, opts) {
  const maxDateGap = (opts && opts.maxDateGap) || 0
  if (maxDateGap > 0) {
    if (!dateWithinDays(a.date, b.date, maxDateGap)) return false
  } else if (a.date !== b.date) {
    return false
  }
  if (!a.report_type || a.report_type === 'UNKNOWN') return false
  if (a.report_type !== b.report_type) return false
  if (fingerprint(a) === fingerprint(b)) return false // 值也一致的交给精确去重
  const sim = codeSimilarity(a, b)
  if (sim < 0.7) return false
  // 强信号：项目高度重合且值系统性错位（小数点错位型重复）
  if (sim >= 0.75 && systemicShift(a, b)) return true
  // 弱信号：同天同类型 + 指标集高度重合 + 共有指标的值基本一致
  // （OCR 识别差异导致个别指标缺失/错位，本质仍是同一张化验单）——视为疑似重复，交由用户确认
  // minValueAgreement：共有值一致比例门槛，默认 0.5（清洗保守口径）。导入查重传入 0.9——
  // 只有「值几乎全部一致」才判重复，避免把「隔几天复查、数值略变」的真实不同采集误报。
  const minVal = (opts && opts.minValueAgreement) != null ? opts.minValueAgreement : 0.5
  return matchedValueAgreement(a, b).ratio >= minVal
}

// 重映射单条记录；返回 { record, pointFixes, titleChange }
// pointFixes: [{ recordId, date, original, from, to, kind }]  kind: 'remap' | 'fill'
// skipCrossRow：Set<"id|from|to|value">，清洗执行阶段由用户取消勾选的跨行错配改判 key；
// 传入则这些条不应用（保持原样）。预览阶段（analyzeRecords）不传，全部应用以便展示。
function cleanRecord(record, skipCrossRow = null) {
  const pointFixes = []
  const data_points = (record.data_points || [])
    .map((p) => {
      const orig = String(p.original_name || '').trim()
      // 用「稳妥匹配」而非裸 mapAlias：mapAlias 命中更泛化的短子串时（如「大血小板比率」→PLT），
      // 会把已正确的具体代码降级；mapAliasRobust 会用删字变体（P_LCR）纠正。
      const { code: mapped, variant: variantFixed } = mapAliasRobust(orig)
      let code = mapped
      // ===== 确定值反推（数值 + 参考范围锁定项目）=====
      // 名称匹配落空/不可信、或当前代码与报告参考范围严重矛盾（如 MCHC 行被误识别成
      // HS_CRP：值 328 + 参考范围 316-354 与 MCHC 档案精确吻合且唯一）时，反推真实字段。
      // 仅当数值落在报告参考范围内才自动修正；值不在范围内（参考范围列串行嫌疑）仅提示。
      let reverseFrom = ''
      let reverseHint = null
      if (p.value != null && String(p.value).trim() !== '' && p.ref_range) {
        const rev = reverseFieldMatch(code || p.standard_code, {
          value: p.value,
          ref_range: p.ref_range,
          unit: p.unit,
          original_name: orig,
        })
        if (rev.codeReversed) {
          reverseFrom = rev.reverseFrom || p.standard_code || ''
          code = rev.code
        } else if (rev.hint) {
          reverseHint = rev.hint
        }
      }
      const f = code ? FIELD_BY_CODE[code] : null
      const next = { ...p }
      if (code && code !== p.standard_code) {
        // 保守护栏：百分比↔绝对值同族互改风险高，不自动改，仅标记待手动核对
        if (isPctAbsCross(p.standard_code, code)) {
          next._warn = `同族百分比/绝对值歧义，未自动重映射（${p.standard_code}→${code}），请手动核对`
        } else {
          pointFixes.push({
            recordId: record.id,
            date: record.date,
            original: orig,
            from: p.standard_code || '',
            to: code,
            kind: reverseFrom ? 'reverse' : p.standard_code ? 'remap' : 'fill',
          })
          next.standard_code = code
        }
      }
      if (f) {
        if (!next.unit && f.unit) {
          next.unit = f.unit
        } else if (next.unit && f.unit) {
          // 高确定性自动修复：同一单位仅漏写 /L（mmol→mmol/L）、或 OCR 噪声变体（410^9/L→10^9/L）
          if (isMissingPerL(next.unit, f.unit)) next.unit = f.unit
          else if (unitOcrNoise(next.unit, f.unit)) next.unit = f.unit
        } else if (next.unit && !f.unit) {
          // 标准无单位却误带单位（如比值类白球比误带 umol/L）→ 误带，清空
          next.unit = ''
        }
        if (!next.ref_range && f.ref) next.ref_range = f.ref
        // 变体收敛 / 反推修正时回填标准名（与识别链路 displayName 语义一致）
        if (
          (variantFixed || reverseFrom) &&
          orig &&
          String(orig).replace(/\s+/g, '') !== String(f.name).replace(/\s+/g, '')
        ) {
          next.original_name = f.name
        }
      }
      if (next.unit) next.unit = normalizeUnit(next.unit)
      next.status = computeStatus(next.standard_code, next.value, next.ref_range, next.arrow, next.unit)
      if (next.standard_code) {
        const suspect = detectSuspiciousValue(next.standard_code, next.value, next.ref_range, next.unit)
        next._suspicious = suspect.suspicious
        next._fix = suspect.suspicious ? { reason: suspect.reason, candidates: suspect.candidates } : null
      }
      // 多维识别审计（标准档案校验），下划线字段不进导出
      next._audit = auditPoint(next, {
        nameFixed: variantFixed || !!reverseFrom,
        codeReversed: !!reverseFrom,
        codeReversedFrom: reverseFrom || null,
        reverseHint,
      })
      return next
    })
    .filter((p) => String(p.value ?? '').trim() !== '')

  // ===== 跨行错配改判（与导入链路共用同一判据 resolveCrossRowDuplicates，避免两套实现分叉）=====
  // 必须在项目名称重映射 / 确定值反推之后执行：改判依赖「本记录内 standard_code 的占用情况」，
  // 须等所有点都拿到各自 code 才能统计。仅改项目归属（结果/单位/参考范围原样保留），
  // 数值永不改写（Bug 031）。allow 回调接住用户的勾选——被取消的改判整条跳过、保持原样。
  const allow = skipCrossRow && skipCrossRow.size ? (c) => !skipCrossRow.has(`${record.id}|${c.from}|${c.to}|${c.value}`) : null
  const crossRowFixes = resolveCrossRowDuplicates(data_points, allow)
  for (const c of crossRowFixes) {
    pointFixes.push({
      recordId: record.id,
      date: record.date,
      original: c.name || '',
      from: c.from,
      to: c.to,
      kind: 'crossrow',
      reason: c.reason,
    })
  }

  // 标题重判：先按「项集」判（signature 评分），项集判不出来（UNKNOWN）才回落到「项目名拼接」。
  // 不能直接把项目名当标题传：reportCatalog.titleMatch 里标题特征词是最高优先级、命中即 return，
  // 而项目名本身常嵌着标题词（「凝血酶时间」含「凝血」、「B型钠尿肽」含「钠尿肽」）。实测 2026-08-03
  // 一条血常规+CRP（27 项里 21 项命中 CBC 签名）只因混进一行「凝血酶时间」就被重判成 COAGULATION（Bug 218）。
  // 回落路径仍须保留：单项报告（如只做 BNP、项目名「B型钠尿肽」）项集评分到不了阈值，只能靠名字救回。
  const nameText = data_points.map((p) => p.original_name || '').join(' ')
  let report_type = detectReportType(data_points, '')
  if (!report_type || report_type === 'UNKNOWN') report_type = detectReportType(data_points, nameText)
  const titleChange = report_type !== record.report_type ? { from: record.report_type, to: report_type } : null

  // 尿常规上下文校正：镜检尿常规的「白细胞/红细胞」（0/HP 计数）常被旧规则映射成血常规 WBC/RBC，
  // 若不改归 ULEU/URBC，这些 0 值会污染血常规趋势图（如某天出现 WBC=0/RBC=0 假点）。
  // 仅当整条记录重判为 URINALYSIS 时执行——尿常规报告不会测血常规白细胞/红细胞计数。
  let finalPts = data_points
  if (report_type === 'URINALYSIS') {
    const mapped = data_points.map((p) => {
      if (p.standard_code === 'WBC') {
        pointFixes.push({ recordId: record.id, date: record.date, original: p.original_name || '', from: 'WBC', to: 'ULEU', kind: 'remap' })
        return { ...p, standard_code: 'ULEU', status: computeStatus('ULEU', p.value, p.ref_range, p.arrow, p.unit) }
      }
      if (p.standard_code === 'RBC') {
        pointFixes.push({ recordId: record.id, date: record.date, original: p.original_name || '', from: 'RBC', to: 'URBC', kind: 'remap' })
        return { ...p, standard_code: 'URBC', status: computeStatus('URBC', p.value, p.ref_range, p.arrow, p.unit) }
      }
      return p
    })
    if (mapped.some((p, i) => p !== data_points[i])) finalPts = mapped
  }
  return { record: { ...record, data_points: finalPts, report_type }, pointFixes, titleChange }
}

// 按「指纹 + 日期相邻(±1天)同类型」聚类：同一份报告被多次导入的多条记录归为一组
function clusterDuplicates(staged) {
  const byFp = new Map()
  for (const r of staged) {
    const fp = fingerprint(r)
    if (!fp) continue
    if (!byFp.has(fp)) byFp.set(fp, [])
    byFp.get(fp).push(r)
  }
  const clusters = []
  for (const arr of byFp.values()) {
    if (arr.length < 2) continue
    const sorted = [...arr].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    let cluster = [sorted[0]]
    for (let i = 1; i < sorted.length; i++) {
      const prev = cluster[cluster.length - 1]
      const adj = prev.date === sorted[i].date ||
        (prev.report_type === sorted[i].report_type && dateWithinDays(prev.date, sorted[i].date, 1))
      if (adj) cluster.push(sorted[i])
      else {
        clusters.push(cluster)
        cluster = [sorted[i]]
      }
    }
    clusters.push(cluster)
  }
  return clusters
    .filter((c) => c.length >= 2)
    .map((arr) => {
      let keep = arr[0]
      for (const r of arr.slice(1)) if (betterThan(r, keep)) keep = r
      return { key: 'dup:' + arr.map((r) => r.id).join(','), keep, remove: arr.filter((r) => r !== keep) }
    })
}

// 文件哈希重复：导入时「同一文件即判重」(file_hash / 兜底 image_hash)，但清洗原仅按内容指纹聚类，
// 故用户「仍要插入」的修正版（改了日期/数值、内容指纹已变）会从清洗网漏出。
// 此处补上文件哈希信号作兜底：仅当非空哈希相等才聚类，空哈希不参与（避免历史空值被全聚）。
function clusterByFileHash(staged, exclude = new Set()) {
  const byHash = new Map()
  for (const r of staged) {
    if (exclude.has(r.id)) continue
    const h = (r.file_hash && r.file_hash.trim()) || (r.image_hash && r.image_hash.trim()) || ''
    if (!h) continue
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h).push(r)
  }
  const groups = []
  for (const arr of byHash.values()) {
    if (arr.length < 2) continue
    const sorted = [...arr].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    let keep = sorted[0]
    for (const r of sorted.slice(1)) if (betterThan(r, keep)) keep = r
    groups.push({ key: 'hash:' + sorted.map((r) => r.id).join(','), keep, remove: sorted.filter((r) => r !== keep) })
  }
  return groups
}

// 分析（只读，不修改数据）：返回清洗预览
export function analyzeRecords(records) {
  const pointFixes = []
  const titleFixes = []
  const staged = records.map((r) => {
    const { record, pointFixes: pf, titleChange } = cleanRecord(r)
    pointFixes.push(...pf)
    if (titleChange) titleFixes.push({ id: r.id, date: r.date, from: titleChange.from, to: titleChange.to })
    return record
  })

  // 去重：先重映射再按「指纹 + 日期相邻(±1天)同类型」聚类。仅分组并保留识别最全的一条，
  // 是否合并交由用户勾选（清洗绝不自动删除数据）。
  const contentGroups = clusterDuplicates(staged)

  // 文件哈希重复（导入「仍要插入」的残留重复兜底）：与内容指纹组去重后并入精确重复
  const exactIds0 = new Set(contentGroups.flatMap((g) => [g.keep.id, ...g.remove.map((r) => r.id)]))
  const fileHashGroups = clusterByFileHash(staged, exactIds0)
  const dupGroups = [...contentGroups, ...fileHashGroups]

  // 精确重复已处理的记录（内容指纹 + 文件哈希），不再参与疑似重复
  const exactIds = new Set([
    ...exactIds0,
    ...fileHashGroups.flatMap((g) => [g.keep.id, ...g.remove.map((r) => r.id)]),
  ])

  // 疑似重复：同日期 + 同类型 + 项目集合高度重合但值不同（隐性重复）
  const fuzzyGroups = []
  const usedFuzzy = new Set()
  for (let i = 0; i < staged.length; i++) {
    if (exactIds.has(staged[i].id) || usedFuzzy.has(i)) continue
    const group = [i]
    for (let j = i + 1; j < staged.length; j++) {
      if (exactIds.has(staged[j].id) || usedFuzzy.has(j)) continue
      if (isFuzzyDup(staged[i], staged[j])) {
        group.push(j)
        usedFuzzy.add(j)
      }
    }
    if (group.length < 2) continue
    usedFuzzy.add(i)
    const arr = group.map((k) => staged[k])
    let keep = arr[0]
    for (const r of arr.slice(1)) {
      if (betterThan(r, keep)) keep = r
    }
    const shift = systemicShift(arr[0], keep) || systemicShift(keep, arr[0])
    fuzzyGroups.push({
      key: `${staged[i].date}|${staged[i].report_type}|${staged[i].id}`,
      keep,
      remove: arr.filter((r) => r !== keep),
      shift: shift ? `数值整体相差 ${shift.shift} 倍` : '指标集合高度一致',
    })
  }

  // 清洗审计统计：聚合所有暂存记录数据点的多维审计（自动修正/提示/疑错），
  // 与识别链路 summarizeAudit 的字段保持一致，供清洗页摘要展示
  const audit = { nameFixed: 0, codeReversed: 0, unitFixed: 0, unitMismatch: 0, refNear: 0, refMismatch: 0, suspicious: 0 }
  for (const r of staged) {
    for (const p of r.data_points || []) {
      const a = p && p._audit
      if (!a) continue
      if (a.nameFixed) audit.nameFixed++
      if (a.codeReversed) audit.codeReversed++
      if (a.unit === 'fixed') audit.unitFixed++
      if (a.unit === 'mismatch') audit.unitMismatch++
      if (a.ref === 'near') audit.refNear++
      if (a.ref === 'mismatch') audit.refMismatch++
      if (p._suspicious) audit.suspicious++
    }
  }
  const potentialRemove =
    dupGroups.reduce((s, g) => s + g.remove.length, 0) +
    fuzzyGroups.reduce((s, g) => s + g.remove.length, 0)
  return {
    dupGroups,
    fuzzyGroups,
    titleFixes,
    pointFixes,
    totals: {
      removeRecords: potentialRemove,
      dupGroups: dupGroups.length,
      fuzzyGroups: fuzzyGroups.length,
      titleFixes: titleFixes.length,
      pointFixes: pointFixes.length,
      recordsAfter: staged.length - potentialRemove,
      ...audit,
    },
  }
}

// ===== 重复组差异明细（供清洗面板展开对比，UI 按需调用，不参与分析主流程）=====

// 单条记录的判定依据，与 rankOf 前三个维度一一对应，用于向用户解释「为什么保留这条」。
// 返回 { mapped, total, suspicious, createdAt }
export function rankStats(record) {
  const pts = record.data_points || []
  const mapped = pts.filter((p) => p.standard_code && FIELD_BY_CODE[p.standard_code]).length
  const suspicious = pts.filter((p) => p._suspicious).length
  return { mapped, total: pts.length, suspicious, createdAt: record.created_at || '' }
}

// 指标级对比：以 standard_code 对齐 keep 与各 remove，标出值差异与量级倍数（小数点错位）。
// 返回 [{ code, name, unit, keepMissing, keepValue, others: [{ value, unit, missing, differs, shiftLabel }], anyDiff }]
// anyDiff 的项排在最前，便于快速定位分歧点。
export function buildDiff(keep, removes) {
  const arr = Array.isArray(removes) ? removes : []
  const byCode = (rec) => {
    const m = new Map()
    for (const p of rec.data_points || []) {
      if (p.standard_code) m.set(p.standard_code, p)
    }
    return m
  }
  const mk = byCode(keep)
  const codes = new Set(mk.keys())
  const mrs = arr.map(byCode)
  for (const m of mrs) for (const c of m.keys()) codes.add(c)

  const rows = []
  for (const code of codes) {
    const f = FIELD_BY_CODE[code]
    const kp = mk.get(code)
    const others = mrs.map((m) => {
      const op = m.get(code)
      if (!op) return { value: '', unit: '', missing: true, differs: true, shiftLabel: '' }
      const differs = !kp || normValue(kp.value) !== normValue(op.value)
      let shiftLabel = ''
      if (kp) {
        const va = parseFloat(kp.value)
        const vb = parseFloat(op.value)
        if (isFinite(va) && isFinite(vb) && va !== 0) {
          const ratio = vb / va
          const lg = Math.round(Math.log10(Math.abs(ratio)))
          // 恰为 10^n 量级差（小数点错位特征）才标注，避免把随机波动标成错位
          if (Math.abs(lg) >= 1 && Math.abs(Math.pow(10, lg) - Math.abs(ratio)) < 1e-6 && ratio > 0) {
            shiftLabel = lg > 0 ? `×${Math.pow(10, lg)}` : `÷${Math.pow(10, -lg)}`
          }
        }
      }
      return { value: op.value, unit: op.unit || '', missing: false, differs, shiftLabel }
    })
    rows.push({
      code,
      name: (kp && kp.original_name) || (f && f.name) || code,
      unit: (kp && kp.unit) || (f && f.unit) || '',
      keepMissing: !kp,
      keepValue: kp ? kp.value : '',
      others,
      anyDiff: !kp || others.some((o) => o.differs),
    })
  }
  rows.sort((a, b) => Number(b.anyDiff) - Number(a.anyDiff))
  return rows
}

// 多份记录横向对齐（对比弹窗用）：按 standard_code 合并成行，标出差异，差异项排最前。
// 与 buildDiff 的区别：本函数是对称的 N 份对比，且保留 point 引用与 pointIdx 供 UI 就地编辑。
// 返回 [{ code, name, cells: [{ present, point, value, unit, status, pointIdx }], differs }]
export function buildCompareRows(recs) {
  const arr = Array.isArray(recs) ? recs : []
  const maps = arr.map((r) => {
    const m = new Map()
    for (const p of r.data_points || []) if (p.standard_code) m.set(p.standard_code, p)
    return m
  })
  const codes = new Set()
  for (const m of maps) for (const c of m.keys()) codes.add(c)
  const out = []
  for (const code of codes) {
    const f = FIELD_BY_CODE[code]
    const cells = arr.map((r, i) => {
      const p = maps[i].get(code)
      if (!p) return { present: false }
      return {
        present: true,
        point: p,
        value: p.value,
        unit: p.unit || '',
        status: p.status,
        pointIdx: (r.data_points || []).indexOf(p),
      }
    })
    const presentVals = cells.filter((c) => c.present).map((c) => normValue(c.value))
    // 差异：存在的值不统一，或某份缺失该项
    const differs = new Set(presentVals).size > 1 || cells.some((c) => !c.present)
    const first = cells.find((c) => c.present)
    out.push({
      code,
      name: (f && f.name) || (first ? first.point.original_name : '') || code,
      cells,
      differs,
    })
  }
  out.sort((a, b) => Number(b.differs) - Number(a.differs))
  return out
}

// 把源指标写入目标记录的数据点数组：已有同 standard_code 则覆盖，否则追加。
// 用于对比弹窗的「以此值为准同步给对方」：对方缺失该项时即补齐漏识别的指标。
// 返回新的 data_points 数组（纯函数，不碰 store）；值变更后重算状态并清除疑似错位标记。
export function applyPointToPoints(points, srcPoint) {
  const pts = [...(points || [])]
  if (!srcPoint || !srcPoint.standard_code) return pts
  const code = srcPoint.standard_code
  const idx = pts.findIndex((p) => p.standard_code === code)
  // 单位/参考范围：源有则用源，源缺则沿用目标原有的，避免把有效信息清成空
  const unit = normalizeUnit(srcPoint.unit || '') || (idx >= 0 ? pts[idx].unit : '') || ''
  const ref = srcPoint.ref_range || (idx >= 0 ? pts[idx].ref_range : '') || ''
  const next = {
    ...srcPoint,
    unit,
    ref_range: ref,
    status: computeStatus(code, srcPoint.value, ref, idx >= 0 ? pts[idx].arrow : srcPoint.arrow, unit),
    _suspicious: false,
    _fix: null,
  }
  if (idx >= 0) pts[idx] = { ...pts[idx], ...next }
  else pts.push(next)
  return pts
}

// 执行清洗：返回 { records: 清洗后, summary }
// opts.mergeFuzzyKeys：用户勾选确认的疑似重复组 key，这些组也执行合并
export function cleanRecords(records, opts = {}) {
  const analysis = analyzeRecords(records)
  const mergeKeys = new Set(opts.mergeFuzzyKeys || [])
  // 用户在对比弹窗里手动指定的保留项：{ groupKey: recordId }，优先于系统判定的 keep
  const keepOverride = opts.keepOverride || {}
  // 用户取消勾选的跨行错配改判（key 集合），执行时跳过这些条，保持原样
  const skipCrossRow = opts.skipCrossRow && opts.skipCrossRow.length ? new Set(opts.skipCrossRow) : null
  const removeIds = new Set()
  let merged = 0
  // 仅合并用户勾选确认的组（精确重复 + 疑似重复一视同仁），未勾选的保留，绝不自动删除
  for (const g of [...analysis.dupGroups, ...analysis.fuzzyGroups]) {
    if (!mergeKeys.has(g.key)) continue
    const all = [g.keep, ...(g.remove || [])].filter(Boolean)
    const want = keepOverride[g.key]
    const chosen = want && all.some((r) => r.id === want) ? want : g.keep.id
    for (const r of all) {
      if (r.id === chosen) continue
      removeIds.add(r.id)
      merged += 1
    }
  }
  const cleaned = []
  for (const r of records) {
    if (removeIds.has(r.id)) continue
    const { record } = cleanRecord(r, skipCrossRow)
    cleaned.push(record)
  }
  // 按日期排序（与导入列表习惯一致）
  cleaned.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const summary = {
    ...analysis.totals,
    removeRecords: merged,
    recordsAfter: cleaned.length,
    // 用户取消勾选的跨行错配改判不计入执行结果（预览中原全量展示）
    pointFixes: skipCrossRow ? analysis.totals.pointFixes - skipCrossRow.size : analysis.totals.pointFixes,
  }
  return { records: cleaned, summary }
}
