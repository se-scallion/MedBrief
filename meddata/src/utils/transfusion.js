// ===================== 输血制品关联 + 输血效果时序诊断（纯函数，可独立单测） =====================
// 从 TrendChart.jsx 提取：制品识别/关联、事件标签、输血效果诊断，保证核心引擎可独立回归。
// 设计红线：
//  1) 制品识别：显式 product 字段优先，否则 inferProduct(text/amount) 自动识别；均识别不出返回 'other'。
//  2) 输血效果判定【仅用核心指标】（红细胞→Hb/HCT、血小板→PLT，见 PRODUCT_PRIMARY_CODES）；
//     形态学指标（MCV/MCH/MCHC/RDW_SD/RDW_CV、PDW/MPV/PLT_PCT）受稀释/测量波动影响、输注后本就不
//     必然升高，不参与「未见升高」判定，避免误报（2026-08-22 待办，见 roadmap.md）。
//  3) 判定采用「输血后区间峰值 < 输血前最近值」——看中间是否先升后落，减少两点比较造成的误报。

import { FIELD_BY_CODE, inferProduct, EVENT_PRODUCTS } from '../data/dictionary.js'

// YYYY-MM-DD → 本地午夜时间戳（与 TrendChart.toTs 同一口径，保证日期先后比较一致）
const toTs = (d) => new Date(`${d}T00:00:00`).getTime()

// 制品 → 受影响指标集合；未收录的制品（plasma / other / 未识别）不限定 → 全指标跳变（旧行为兜底）
export const PRODUCT_IMPACT = {
  rbc: new Set(['RBC', 'Hb', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW_SD', 'RDW_CV']),
  plt: new Set(['PLT', 'PDW', 'MPV', 'PLT_PCT']),
}

// 白细胞系统（计数 + 五分类绝对值/百分比）
const WBC_SYSTEM_CODES = [
  'WBC',
  'NEUT_ABS',
  'LYM_ABS',
  'MONO_ABS',
  'EO_ABS',
  'BASO_ABS',
  'NEUT_PCT',
  'LYM_PCT',
  'MONO_PCT',
  'EO_PCT',
  'BASO_PCT',
]

// 制品 → 图表「事件时间竖线（markLine）」的显示范围。
// 与 PRODUCT_IMPACT 的区别（两层口径，不可混用）：
//   PRODUCT_IMPACT = 「直接作用」口径，用于插跳变与输血效果判定，必须严格，否则会误导因果；
//   PRODUCT_VIEW_CODES = 「临床对照关联」口径，仅决定是否把事件时间画在图上供对照。
// 放宽显示的原因：输注红细胞后白细胞系确实可见变化（2026-09-03 用户观察确认），
// 若白细胞图上不显示红细胞事件，就无法看出「白细胞变化发生在输红细胞之后」。
// 竖线只是时间参照，不代表因果关系。
export const PRODUCT_VIEW_CODES = {
  // 红细胞制品：直接作用红细胞系；白细胞系按「输后可见变化」一并列为对照关联
  rbc: new Set([...PRODUCT_IMPACT.rbc, ...WBC_SYSTEM_CODES]),
  plt: new Set([...PRODUCT_IMPACT.plt]),
}

// 该输血事件是否「应显示」在指定指标的图表上（对照关联口径，仅用于事件时间竖线）
export const affectsView = (e, code) => {
  const set = PRODUCT_VIEW_CODES[resolveProduct(e)]
  return set ? set.has(code) : true
}

// 输血效果判定核心指标（按优先级）：红细胞直接看 Hb（血红蛋白）→ HCT → RBC，血小板直接看 PLT；
// 形态学指标（红细胞系 MCV/MCH/MCHC/RDW_*、血小板系 PDW/MPV/PLT_PCT）不参与判定，避免误报。
export const PRODUCT_PRIMARY_CODES = {
  rbc: ['Hb', 'HCT', 'RBC'],
  plt: ['PLT'],
}

// 统一解析事件的制品类型 key（纯函数）：
// 1) 显式 product 且非 'auto' 直接用；2) 否则从描述 text 自动识别；3) 仍无则从 amount 文本识别（如「血小板2U」）；4) 兜底 'other'
export const resolveProduct = (e) => {
  if (e.product && e.product !== 'auto') return e.product
  const fromText = inferProduct(e.text || '')
  if (fromText) return fromText
  const fromAmount = inferProduct(e.amount || '')
  if (fromAmount) return fromAmount
  return 'other'
}

// 该输血事件是否影响指定指标（纯函数）
export const affects = (e, code) => {
  const p = resolveProduct(e)
  const set = PRODUCT_IMPACT[p]
  return set ? set.has(code) : true
}

// 事件标记标签：输血显示「制品 数量单位」，无数量按描述兜底；用药显示描述
export const eventLabel = (e) => {
  if ((e.category || 'transfusion') === 'transfusion') {
    const p = resolveProduct(e)
    const meta = EVENT_PRODUCTS.find((x) => x.key === p)
    const label = meta ? meta.label : '其他'
    const qty = e.amount || (e.quantity != null ? `${e.quantity}${e.unit || 'U'}` : '')
    return qty ? `${label} ${qty}` : e.text ? `${label} ${e.text}` : label
  }
  return e.text || ''
}

// ===== 输血时序合理性诊断（依据「输血一般晚于检查」规律）=====
// 输入：transfusion 事件、各检查日期（按 code 分组）、各日期指标取值（byDate）
// 返回异常清单：
//  1) 效果异常（not-risen）：输血后核心指标「峰值」< 输血前最近一次检查值（提升性干预后全程未见升高）
//  2) 数据缺失（no-after）：输血后无相关指标复查（无法验证提升效果）
// 输出结构化字段（指标中文名 codeName、前后值/日期），由前端拼接紧凑展示，便于排版；
// 仅作提示，不参与绘图。
export function diagnoseTransfusion(events, reportDatesByCode, byDate, findPointFn, numFn) {
  const out = []
  const tfs = events.filter((e) => (e.category || 'transfusion') === 'transfusion' && resolveProduct(e) !== 'other')
  for (const e of tfs) {
    const p = resolveProduct(e)
    const codes = PRODUCT_IMPACT[p]
    if (!codes) continue // plasma/other 无明确对应系，不诊断
    const evTs = toTs(e.date)
    const codesArr = [...codes]
    // 收集该制品相关指标的全部检查日（升序）
    const allDates = [...new Set(codesArr.flatMap((c) => reportDatesByCode[c] || []))].sort()
    if (!allDates.length) continue
    const before = allDates.filter((d) => toTs(d) < evTs)
    const after = allDates.filter((d) => toTs(d) > evTs)
    // 输血当日复查（日期粒度无法定先后）：既不作为 before 也不作为 after（避免把输前/输后当日值误当基线），
    // 但存在当日复查时不应误报「无复查」（no-after）——临床常先查血后输血或输后当日复査。
    const sameDay = allDates.filter((d) => toTs(d) === evTs)
    const evLabel = eventLabel(e)
    // 1) 数据缺失：输血后「严格晚于输血日」无相关指标复查，且输血当日也无复查 → 无法验证提升效果
    if (!after.length && !sameDay.length) {
      out.push({ type: 'no-after', date: e.date, label: evLabel, codeName: '', beforeVal: null, afterVal: null })
      continue
    }
    // 2) 效果异常：仅用核心指标判定（见 PRODUCT_PRIMARY_CODES）。
    //    判定规则：输血后区间内该核心指标「峰值」< 输血前最近一次值 → 全程未见升高 → 报警；
    //    输血后曾升至 ≥ 输血前（中间先升后落）→ 干预有效，不报警（减少两点比较误报）。
    //    核心指标均无比对数据（如只查了 MCV/MPV）→ 无法可靠判定，不报警（避免形态学指标误判）。
    for (const c of PRODUCT_PRIMARY_CODES[p] || []) {
      if (!codes.has(c)) continue
      // 输血前最近一次该指标检查（在 before 内从后往前找该指标自身的有值日）
      let bDate = null
      let pb = null
      let vb = null
      for (let i = before.length - 1; i >= 0; i--) {
        const r = byDate[before[i]]
        const pt = r && findPointFn(r, c)
        const v = pt && numFn(pt.value)
        if (pt && v != null) {
          bDate = before[i]
          pb = pt
          vb = v
          break
        }
      }
      // 输血后区间内该指标全部检查值 → 取峰值及对应日期
      let aDate = null
      let pa = null
      let va = null
      for (const d of after) {
        const r = byDate[d]
        const pt = r && findPointFn(r, c)
        const v = pt && numFn(pt.value)
        if (pt && v != null && (va == null || v > va)) {
          aDate = d
          pa = pt
          va = v
        }
      }
      if (bDate && aDate) {
        if (va < vb) {
          const f = FIELD_BY_CODE[c]
          out.push({
            type: 'not-risen',
            date: e.date,
            label: evLabel,
            codeName: (f && f.name) || c,
            beforeVal: vb,
            afterVal: va,
            unit: (pb.unit || (f && f.unit)) || '',
            beforeDate: bDate,
            afterDate: aDate,
          })
        }
        break // 核心指标可比对即用其判定，不再尝试后续核心指标
      }
      // 该核心指标无比对数据 → 尝试下一个核心指标
    }
  }
  return out
}
