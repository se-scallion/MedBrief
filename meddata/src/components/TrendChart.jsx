// ===================== 病情时序趋势分析图表（Apache ECharts） =====================

import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { Button, Table, Tag } from 'antd'
import { parseRefRange, computeStatus, STATUS_META } from '../utils/normalize.js'
import { FIELD_BY_CODE, REPORT_TYPES, RECORD_CATEGORIES, OTHER_CATEGORY, CATEGORY_GROUPS, mergedCategoryOf, recordCategoryOf, reportTypeLabel, applyCategorySizePolicy } from '../data/dictionary.js'
import { hasTrend } from '../utils/trendNav.js'
import { findPoint } from '../utils/export.js'
import { affects, affectsView, eventLabel, diagnoseTransfusion } from '../utils/transfusion.js'
import { deleteRecord } from '../data/store.js'
import SectionFilterBar from './SectionFilterBar.jsx'
import { pad2, toTs, fmtLocal } from '../utils/chartAxis.js'
import AssetBadge from './AssetBadge.jsx'
import DocOriginalModal from './DocOriginalModal.jsx'
import { LAB_KIND_REPORT_TYPE, kindLabel } from '../data/docKinds.js'
import { docHeading } from '../utils/docHeading.js'

// 记录 report_type → 归档 kind：用于「记录没有原件、但同一天同类型报告已归档了原件」时
// 把用户一步送到原件上（2026-10-27 用户要求：在对应记录 / 指标上能跳转到原件报告）。
const KIND_BY_REPORT_TYPE = {
  BONE_MARROW_MORPHOLOGY: 'bonemarrow',
  FLOW_CYTOMETRY: 'flow',
}

const num = (v) => {
  const n = parseFloat(v)
  return Number.isNaN(n) ? null : n
}

// 采集时间优先取 checked_at（导入保存的「采集时间，如 2026-08-02 10:16」），
// 回退兼容旧字段 time / reported_time；用于时间轴偏移与 tooltip / 数据点时间标注
const extractTimeStr = (r) => (r && (r.checked_at || r.time || r.reported_time)) || ''
const extractHHmm = (r) => {
  const s = extractTimeStr(r)
  const m = /(\d{1,2}):(\d{2})/.exec(s)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''
}

// ===== 日期统一走「本地时区」= 数据点 / markArea / markPoint / tooltip / axisLabel 全部同一转换，
// 实现集中在 utils/chartAxis.js（与 StreamChart 共用，避免两处漂移）=====

// 按「接近真实颜色」着色：白细胞→白色系，红细胞/血红蛋白→红色系，血小板→黄色系
// （图表区域为深色背景 #0f172a，白/红/黄三系均清晰可辨）
const SERIES_COLOR = {
  // 白细胞系统（白 / 灰白系，嗜酸略偏淡紫以区分）
  WBC: '#ffffff',
  NEUT_ABS: '#e2e8f0',
  LYM_ABS: '#cbd5e1',
  MONO_ABS: '#94a3b8',
  EO_ABS: '#c7d2fe',
  BASO_ABS: '#64748b',
  NEUT_PCT: '#e2e8f0',
  LYM_PCT: '#cbd5e1',
  MONO_PCT: '#94a3b8',
  EO_PCT: '#c7d2fe',
  BASO_PCT: '#64748b',
  HS_CRP: '#fb923c', // 炎症指标（橙）
  // 红细胞系统（红系）
  RBC: '#ef4444',
  Hb: '#dc2626',
  HCT: '#f87171',
  MCV: '#f87171',
  MCH: '#fca5a5',
  MCHC: '#ef4444',
  RDW_SD: '#b91c1c',
  RDW_CV: '#f87171',
  // 血小板系统（黄系）
  PLT: '#fbbf24',
  PDW: '#eab308',
  MPV: '#facc15',
  PLT_PCT: '#f59e0b',
}

// 多指标兜底调色板（按系列序号取色）
const PALETTE = [
  '#0d9488', '#ef4444', '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981',
  '#e11d48', '#06b6d4', '#f97316', '#84cc16', '#a855f7', '#64748b',
]

// 全血细胞分析全项：指标全集（按系统分组，仅用于生成全部指标清单）
export const CBC_GROUPS = [
  {
    key: 'wbc',
    title: '白细胞系统（计数 + 分类百分比 + 炎症指标）',
    series: [
      { code: 'WBC', y: 0 },
      { code: 'NEUT_ABS', y: 0 },
      { code: 'LYM_ABS', y: 0 },
      { code: 'MONO_ABS', y: 0 },
      { code: 'EO_ABS', y: 0 },
      { code: 'BASO_ABS', y: 0 },
      { code: 'NEUT_PCT', y: 0 },
      { code: 'LYM_PCT', y: 0 },
      { code: 'MONO_PCT', y: 0 },
      { code: 'EO_PCT', y: 0 },
      { code: 'BASO_PCT', y: 0 },
      { code: 'HS_CRP', y: 0 },
    ],
  },
  {
    key: 'rbc',
    title: '红细胞系统（计数 / 血红蛋白 / 红细胞指数）',
    series: [
      { code: 'RBC', y: 0 },
      { code: 'Hb', y: 0 },
      { code: 'HCT', y: 0 },
      { code: 'MCV', y: 0 },
      { code: 'MCH', y: 0 },
      { code: 'MCHC', y: 0 },
      { code: 'RDW_SD', y: 0 },
      { code: 'RDW_CV', y: 0 },
    ],
  },
  {
    key: 'platelet',
    title: '血小板系统（计数 + 血小板指数）',
    series: [
      { code: 'PLT', y: 0 },
      { code: 'PDW', y: 0 },
      { code: 'MPV', y: 0 },
      { code: 'PLT_PCT', y: 0 },
    ],
  },
]

// Y 轴分组：偶 y=左轴（真实数值/绝对值，按量纲+量级分组），奇 y=右轴（百分比 %，共用一根）；scale:true 自适应范围，不截断线条
const AXIS_GROUP = {
  // 左1 · 10⁹/L 细胞计数（低量级）：白细胞计数 / 分类绝对值 / 红细胞计数
  WBC: 0, NEUT_ABS: 0, LYM_ABS: 0, MONO_ABS: 0, EO_ABS: 0, BASO_ABS: 0, RBC: 0,
  // 右1 · % 百分比（共用一根）：分类百分比 / 红细胞压积 / 血小板压积 / 分布宽度
  NEUT_PCT: 1, LYM_PCT: 1, MONO_PCT: 1, EO_PCT: 1, BASO_PCT: 1, HCT: 1, PLT_PCT: 1, RDW_CV: 1,
  // 左2 · 10⁹/L 血小板计数（高量级，独立轴避免与低量级计数互相压平）
  PLT: 2,
  // 左3 · g/L 血红蛋白 / 平均血红蛋白浓度
  Hb: 4, MCHC: 4,
  // 左4 · fL / pg 红细胞·血小板指数
  MCV: 6, RDW_SD: 6, PDW: 6, MPV: 6, MCH: 6,
  // 左5 · mg/L 炎症标志物
  HS_CRP: 8,
}

// 参考区间绿带（markArea）的「基准指标」优先级。
// 背景：绿带原是每个 series 各画自己 code 的参考区间，而各 series 分属不同 Y 轴 ——
// 于是同一绘图区里会叠出多条数值互不相干、坐标系各不相同的绿带，视觉上伪造出多套坐标系，
// 这是图表看起来「乱」的真正元凶（且 label 关闭，用户无从分辨哪条带属于谁）。
// 收敛策略：整个图只画 1 条绿带，取自下表中当前视图存在的第一个指标；
// 归属由图例说明文字标注，其余指标的参考区间交给「详细走势」的单指标图（那里单轴单带，无歧义）。
const BAND_BASELINE_PRIORITY = ['WBC', 'Hb', 'PLT', 'NEUT_ABS']

// 取出当前视图的绿带基准指标（视图无指标时返回 null）
export function pickBandBaseline(specs = []) {
  for (const code of BAND_BASELINE_PRIORITY) {
    if (specs.some((s) => s.code === code)) return code
  }
  return specs.length ? specs[0].code : null
}

// 核心指标：临床第一梯队，用线宽/不透明度拉开层次（次要指标让位，不抢视线）
const CORE_CODES = new Set(['WBC', 'Hb', 'PLT'])

// 窄屏下钳制 grid 边距：多根 Y 轴的标签会在 grid 外并排占位，屏幕越窄绘图区被挤得越狠。
// 超过容器宽度的 maxRatio 时强制收敛——宁可轴标签拥挤，也要保住绘图区的可用宽度。
function clampAxisPad(pad, containerWidth, maxRatio) {
  if (!containerWidth || containerWidth <= 0) return pad
  return Math.min(pad, Math.max(40, Math.round(containerWidth * maxRatio)))
}

// 生成参考区间带（markArea，按相邻日期分段）
export function buildBand(dates, byDate, code) {
  const pts = dates.map((d) => {
    const r = byDate[d]
    const p = r && findPoint(r, code)
    return p ? parseRefRange(p.ref_range) : null
  })
  const items = []
  let seg = null
  for (let i = 0; i < pts.length; i++) {
    const ref = pts[i]
    if (ref && ref.low != null && ref.high != null) {
      if (!seg) seg = { x1: dates[i], low1: ref.low, high1: ref.high }
      seg.x2 = dates[i]
      seg.low2 = ref.low
      seg.high2 = ref.high
    } else if (seg) {
      items.push(seg)
      seg = null
    }
  }
  if (seg) items.push(seg)
  return items.map((s) => ({
    name: '参考区间',
    itemStyle: { color: 'rgba(16,185,129,0.15)', borderColor: 'rgba(16,185,129,0.5)', borderWidth: 1 },
    label: { show: false },
    data: [
      [{ coord: [toTs(s.x1), s.low1], value: '低' }, { coord: [toTs(s.x2), s.high2], value: '高' }],
    ],
  }))
}

// 制品关联与输血效果诊断（PRODUCT_IMPACT / resolveProduct / affects / eventLabel / diagnoseTransfusion）
// 已提取至 src/utils/transfusion.js（纯函数，可独立单测）：仅用核心指标判定输血效果，避免形态学指标误报。

// ===== 事件在时间轴上的定位 =====
// 事件默认只存日期（无时刻）。若直接用当日午夜 toTs(e.date)，而检查点是「日期 + 采集时刻」，
// 同一天既有检查又有事件时，事件线会被画在当天所有检查之前（如 11:59 检查 → 事件 → 20:xx 复查，
// 事件却显示在 11:59 之前），顺序明显颠倒。
// 定位规则：
//  1) 事件填了时间（e.time，HH:mm）→ 用该时刻（最精确）；
//  2) 未填时间但当天有检查 → 落在当天「首个检查之后」（临床常规先检查后输血，也符合
//     「11:59 检查 → 输血 → 20:xx 复查」的实际顺序），保证事件线不早于当天第一次检查；
//  3) 当天无检查 → 退回当日午夜（跨天对比不受影响）。
function eventTs(e, recordSlots = []) {
  const base = toTs(e.date)
  const m = /(\d{1,2}):(\d{2})/.exec(e.time || '')
  if (m) return base + (Number(m[1]) * 60 + Number(m[2])) * 60000
  const sameDay = recordSlots
    .filter((s) => s.date === e.date)
    .map((s) => s.ts)
    .sort((a, b) => a - b)
  return sameDay.length ? sameDay[0] + 60000 : base
}

// ===== 输血跳变：输血属「干预事件」，输后指标应表现为事件日竖直跳变，而非跨越多天的缓慢斜线 =====
// 对每个指标，仅对「影响该指标」的输血事件（affects 过滤）插入跳变虚拟点：
// 输血前值水平延伸至事件日 → 事件日竖直跳到输血后值 → 水平延伸至下一采样点。
// 虚拟点仅参与连线（不画符号），其承载的仍是前后两天的真实测量值。
// 关键规则：只有「输血后值 ≥ 输血前值」（上升或持平）才插入跳变虚拟点；
// 若数据在输血前后是下降的，不插入虚拟点、按普通折线连接——输血属「提升性干预」，
// 竖直下降会误导成「输血导致指标骤降」，故下降段一律不画人工跳变。
function applyJump(rows, events, code, recordSlots = []) {
  const evs = events.filter((e) => affects(e, code))
  const tsOf = (x) => (x.ts != null ? x.ts : toTs(x.d))
  if (!evs.length || rows.length < 2) {
    return rows.map((x) => ({ ...x, ts: tsOf(x) }))
  }
  const evTs = evs.map((e) => eventTs(e, recordSlots)).sort((a, b) => a - b)
  // 输血日（按日期）：仅当输血日「严格介于」相邻两真实点之间才插跳变虚拟点
  const evDates = new Set(evs.map((e) => e.date))
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const t0 = tsOf(rows[i])
    out.push({ ...rows[i], ts: t0 })
    if (i < rows.length - 1) {
      const t1 = tsOf(rows[i + 1])
      // 该区间内（含后端点、不含前端点）最早的输血事件日
      const ev = evTs.find((t) => t > t0 && t <= t1)
      // 若相邻任一端就在输血当天，跳变由当天真实数据点体现，不再插虚拟点（避免与真实点形成三叉连线）
      if (ev != null && rows[i + 1].v >= rows[i].v && !evDates.has(rows[i].d) && !evDates.has(rows[i + 1].d)) {
        // 事件日上保持输血前值（虚拟点，不画符号）
        out.push({ ...rows[i], ts: ev, virtual: true })
        // 事件日严格在两点之间时再补输血后值虚拟点，形成竖直跳变段
        if (ev < t1) out.push({ ...rows[i + 1], ts: ev, virtual: true })
      }
    }
  }
  return out
}

// containerWidth：绘图容器像素宽度，供窄屏 grid 边距钳制用（0/缺省 = 不限制，保持旧行为）
function buildOption(dates, byDate, events, specs, recordSlots = [], byTs = new Map(), containerWidth = 0) {
  // 实际使用到的 Y 轴侧（0=左，1=右），映射为连续的 yAxisIndex
  const usedY = [...new Set(specs.map((s) => s.y))].sort((a, b) => a - b)
  const yMap = Object.fromEntries(usedY.map((y, i) => [y, i]))
  // 左右轴数量（用于 grid 留宽）：按 y 值奇偶（偶=左，奇=右），而非 usedY 索引
  const leftAxes = usedY.filter((y) => y % 2 === 0).length
  const rightAxes = usedY.filter((y) => y % 2 === 1).length

  // 在首末日期之间补齐所有中间日期，空档日期用 null（配合 connectNulls:false 不连线）
  const first = dates[0]
  const last = dates[dates.length - 1]
  const fullDates = []
  if (first && last) {
    const cur = new Date(`${first}T00:00:00`)
    const end = new Date(`${last}T00:00:00`)
    while (cur <= end) {
      fullDates.push(`${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}`)
      cur.setDate(cur.getDate() + 1)
    }
  }

  // 参考区间绿带：整个图只画基准指标 1 条（逐系列画带会在多轴下伪造多套坐标系）
  const bandCode = pickBandBaseline(specs)

  const series = specs.map((spec, si) => {
    const color = SERIES_COLOR[spec.code] || PALETTE[si % PALETTE.length]
    const yAxisIndex = yMap[spec.y]
    // 百分比类（奇 y = 右侧 % 轴）一律虚线：同色系的绝对值与百分比从此可分辨
    // （如 NEUT_ABS 实线 vs NEUT_PCT 虚线，二者在 SERIES_COLOR 中同色，靠线型区分）
    const isPct = (spec.y ?? 0) % 2 === 1
    const isCore = CORE_CODES.has(spec.code)
    // 实际有值点 + 输血事件日插入的跳变虚拟点：
    // ECharts 按 data 顺序连线（time 轴无需 null 占位），空档日天然跨过；
    // 虚拟点把输血前后连线改为「水平 → 竖直跳变 → 水平」，避免输血效果被画成缓慢斜线
    const rows = recordSlots
      .map(({ r, ts, date }) => {
        const p = findPoint(r, spec.code)
        const v = p ? num(p.value) : null
        return v != null ? { d: date, v, ts } : null
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts)
    const data = applyJump(rows, events, spec.code).map((x) => [x.ts, x.v])
    const field = FIELD_BY_CODE[spec.code]

    // 事件标记：贯穿全图的彩色竖向虚线 + 顶部标签（只挂第一个系列，避免每条线重复绘制同样的标记）
    const markLine =
      si === 0 && events.length
        ? {
            symbol: 'none',
            silent: true,
            tooltip: {
              show: true,
              formatter: (p) => p.data.evText,
              backgroundColor: '#1e293b',
              borderColor: '#334155',
              textStyle: { color: '#e2e8f0' },
            },
            data: events.map((e) => {
              const lbl = eventLabel(e)
              return {
                name: lbl,
                evText: `${e.date}${e.time ? ' ' + e.time : ''} ${lbl}`,
                xAxis: eventTs(e, recordSlots),
                lineStyle: { color: e.color || '#f59e0b', width: 2, type: 'dashed' },
                label: {
                  show: true,
                  position: 'insideEndTop',
                  distance: 2,
                  color: '#0f172a',
                  backgroundColor: e.color || '#f59e0b',
                  borderRadius: 4,
                  padding: [3, 2],
                  fontSize: 10,
                  fontWeight: 600,
                  // 竖排（逐字换行）：横排标签宽 50-70px 会盖住走势线，竖排后横向仅占约 12px。
                  // 完整文本（含日期时刻）仍由 markLine 的 tooltip 提供。
                  formatter: () => lbl.slice(0, 6).split('').join('\n'),
                  lineHeight: 11,
                },
              }
            }),
          }
        : null

    return {
      name: field ? field.name : spec.code,
      type: 'line',
      data,
      yAxisIndex,
      smooth: true,
      // 只在 x 单调段平滑：输血跳变的竖直段保持笔直，不被平滑拉弯
      smoothMonotone: 'x',
      symbol: 'circle',
      symbolSize: isCore ? 8 : 6,
      lineStyle: { width: isCore ? 3.5 : 2, color, type: isPct ? 'dashed' : 'solid', opacity: isCore ? 1 : 0.75 },
      itemStyle: { color, opacity: isCore ? 1 : 0.85 },
      emphasis: { focus: 'series' },
      // 参考区间带（绿色）：只有基准指标画，避免多轴下多条绿带伪造多套坐标系
      ...(spec.code === bandCode ? { markArea: buildBand(fullDates, byDate, spec.code) } : {}),
      ...(markLine ? { markLine } : {}),
      z: 10,
    }
  })

  // tooltip 同时展示指标名、原始值、单位与参考区间，便于对照化验单
  const tooltip = {
    trigger: 'axis',
    confine: true,
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    textStyle: { color: '#e2e8f0' },
    formatter: (params) => {
      if (!params || !params.length) return ''
      // ECharts time 轴的 axisValue 是毫秒时间戳，统一按本地时区转回 YYYY-MM-DD（与坐标轴标签同一规则）
      const axisVal = params[0].axisValue
      const tsNum =
        typeof axisVal === 'number'
          ? axisVal
          : typeof axisVal === 'string' && /^\d+$/.test(axisVal)
          ? Number(axisVal)
          : null
      const d = tsNum != null ? fmtLocal(tsNum) : String(axisVal).slice(0, 10)
      // 按天聚合：列出当天「所有报告」（同天多份逐份显示，用采集时间区分），而非只命中一个被错开的数据点
      const daySlots = recordSlots.filter((s) => s.date === d)
      if (!daySlots.length) return `<div style="font-weight:600;margin-bottom:2px">${d}</div><div style="color:#94a3b8">无数据</div>`
      const blocks = []
      for (const s of daySlots) {
        const rec = s.r
        const recTime = extractHHmm(rec)
        const items = []
        specs.forEach((spec, si) => {
          const p = findPoint(rec, spec.code)
          if (!p) return
          const v = num(p.value)
          if (v == null) return
          const field = FIELD_BY_CODE[spec.code]
          const color = SERIES_COLOR[spec.code] || PALETTE[si % PALETTE.length]
          const unit = p.unit || (field && field.unit) || ''
          const ref = p.ref_range || (field && field.ref) || ''
          items.push(
            `<div style="display:flex;align-items:center;gap:6px;margin:2px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span><span style="flex:1">${field ? field.name : spec.code}</span> <b>${v}</b> ${unit}<span style="color:#94a3b8"> · 参考 ${ref}</span></div>`
          )
        })
        if (items.length) {
          blocks.push((recTime ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8">${recTime}</div>` : '') + items.join(''))
        }
      }
      return `<div style="font-weight:600;margin-bottom:2px">${d}</div>` + blocks.join('')
    },
  }

  return {
    animationDuration: 400,
    tooltip,
    legend: { top: 0, left: 8, type: 'scroll', textStyle: { fontSize: 12, color: '#cbd5e1' } },
    grid: {
      left: clampAxisPad(44 + Math.max(0, leftAxes - 1) * 30, containerWidth, 0.25),
      right: clampAxisPad(44 + Math.max(0, rightAxes - 1) * 30, containerWidth, 0.22),
      top: 44,
      bottom: 60,
    },
    xAxis: {
      type: 'time',
      axisLabel: {
        fontSize: 11,
        color: '#94a3b8',
        // 显式按本地时区格式化，保证坐标轴刻度与浮层日期永不差一天
        formatter: (ts) => {
          const t = new Date(ts)
          return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`
        },
      },
      axisLine: { lineStyle: { color: '#334155' } },
      axisTick: { alignWithLabel: true },
    },
    yAxis: usedY.map((y) => ({
      type: 'value',
      scale: true,
      position: y % 2 === 0 ? 'left' : 'right',
      // 右侧为百分比轴，标注 %；左侧不加轴名（图例已含单位，避免拥挤）
      name: y % 2 === 1 ? '%' : '',
      nameTextStyle: { color: '#94a3b8', fontSize: 10, padding: [0, 0, 0, 2] },
      splitLine: { lineStyle: { type: 'dashed', color: '#334155' } },
      axisLabel: {
        fontSize: 10,
        color: y % 2 === 1 ? '#64748b' : '#94a3b8',
        formatter: (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(1)))),
      },
    })),
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      {
        type: 'slider',
        height: 18,
        bottom: 8,
        borderColor: '#334155',
        backgroundColor: '#0f172a',
        fillerColor: 'rgba(148,163,184,0.25)',
        textStyle: { color: '#94a3b8', fontSize: 10 },
      },
    ],
    series,
  }
}

// ===== 单指标详细走势图（供 CBCDetailView 全屏详情页逐项展示）=====
// 三段区域：绿带=参考区间（正常区）、橙带=低于参考下限（偏低风险）、红带=高于参考上限（偏高风险）；
// 危急值点用静态深红圆点高亮（不做闪烁动画）；Y 轴显式 min/max（数据+参考边界+呼吸边距），
// 避免风险带使用边界常量把坐标轴撑爆。
export function calcYRange(rows) {
  let min = Infinity
  let max = -Infinity
  for (const x of rows) {
    if (x.v != null) {
      min = Math.min(min, x.v)
      max = Math.max(max, x.v)
    }
    if (x.ref) {
      if (x.ref.low != null) min = Math.min(min, x.ref.low)
      if (x.ref.high != null) max = Math.max(max, x.ref.high)
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
  if (min === max) {
    min -= 1
    max += 1
  }
  const pad = (max - min) * 0.1
  return { min: min - pad, max: max + pad }
}

// 风险区带（markArea）：低于参考下限 → 橙色；高于参考上限 → 红色；按相邻日期分段（与 buildBand 同规则）
function buildRiskBand(dates, byDate, code, yMin, yMax) {
  const pts = dates.map((d) => {
    const r = byDate[d]
    const p = r && findPoint(r, code)
    return p ? parseRefRange(p.ref_range) : null
  })
  const segs = []
  let seg = null
  for (let i = 0; i < pts.length; i++) {
    const ref = pts[i]
    if (ref && (ref.low != null || ref.high != null)) {
      if (!seg) seg = { x1: dates[i], low1: ref.low, high1: ref.high }
      seg.x2 = dates[i]
      seg.low2 = ref.low
      seg.high2 = ref.high
    } else if (seg) {
      segs.push(seg)
      seg = null
    }
  }
  if (seg) segs.push(seg)

  const items = []
  for (const s of segs) {
    // 偏低风险带：[yMin, low]
    if (s.low1 != null || s.low2 != null) {
      const l1 = s.low1 != null ? s.low1 : s.low2
      const l2 = s.low2 != null ? s.low2 : s.low1
      if (l1 > yMin || l2 > yMin) {
        items.push({
          name: '偏低风险',
          itemStyle: { color: 'rgba(251,146,60,0.12)', borderColor: 'rgba(251,146,60,0.4)', borderWidth: 1 },
          label: { show: false },
          data: [
            [
              { coord: [toTs(s.x1), yMin], value: '偏低风险' },
              { coord: [toTs(s.x2), l2], value: '偏低风险' },
            ],
          ],
        })
      }
    }
    // 偏高风险带：[high, yMax]
    if (s.high1 != null || s.high2 != null) {
      const h1 = s.high1 != null ? s.high1 : s.high2
      const h2 = s.high2 != null ? s.high2 : s.high1
      if (h1 < yMax || h2 < yMax) {
        items.push({
          name: '偏高风险',
          itemStyle: { color: 'rgba(239,68,68,0.14)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1 },
          label: { show: false },
          data: [
            [
              { coord: [toTs(s.x1), h1], value: '偏高风险' },
              { coord: [toTs(s.x2), yMax], value: '偏高风险' },
            ],
          ],
        })
      }
    }
  }
  return items
}

// 单指标走势图 option：单 Y 轴（显式 min/max）、折线（数据点按状态着色）、
// 正常区绿带 + 偏低/偏高风险区橙红带、危急值静态深红圆点高亮、
// 关联输血事件 markLine（仅显示影响该指标的事件，如中性粒细胞图不显示输注红细胞）、时间缩放 dataZoom
export function buildSingleOption(dates, byDate, events, code, recordSlots = [], byTs = new Map()) {
  const field = FIELD_BY_CODE[code]
  const color = SERIES_COLOR[code] || PALETTE[0]
  const daySeq = {}
  const baseRows = recordSlots
    .map(({ r, ts, date }) => {
      const p = findPoint(r, code)
      if (!p) return null
      const v = num(p.value)
      if (v == null) return null
      daySeq[date] ||= 0
      const idxInDay = daySeq[date]++
      return {
        d: date,
        v,
        ts,
        idxInDay,
        // 采集时间（HH:mm）用于同一天多次采样时的点标注，区分不同报告/复查
        timeText: extractHHmm(r),
        ref: parseRefRange(p.ref_range),
        // 旧数据可能无 status 字段：按值+参考区间即时计算，保证危急/偏离高亮不遗漏
        status: p.status || computeStatus(code, p.value, p.ref_range),
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts)
  // 同一天出现多次（不同报告/复查）时，给各数据点标注时间（无时间则标同日序号）便于区分
  const dayCount = {}
  for (const x of baseRows) dayCount[x.d] = (dayCount[x.d] || 0) + 1
  const pointLabel = (x) => (dayCount[x.d] > 1 ? (x.timeText || `#${x.idxInDay + 1}`) : '')
  // 输血事件日插入跳变虚拟点：连线改为「输血前水平 → 事件日竖直跳变 → 输血后水平」
  const rows = applyJump(baseRows, events, code, recordSlots)
  const { min, max } = calcYRange(rows)
  // 数据点按状态着色（危急深红、偏低/偏高琥珀、正常系统色）；虚拟点不画符号、仅参与连线
  const pointColor = (x) => {
    if (x.status.startsWith('CRITICAL')) return '#dc2626'
    if (x.status === 'LOW' || x.status === 'HIGH') return '#f59e0b'
    return color
  }
  const data = rows.map((x) => ({
    value: [x.ts, x.v],
    ...(x.virtual ? { symbol: 'none' } : {}),
    itemStyle: { color: pointColor(x) },
    // 同一天多条记录：在非虚拟真实点上标注时间，避免重叠点无法区分
    ...(!x.virtual && pointLabel(x)
      ? {
          label: {
            show: true,
            position: 'top',
            fontSize: 9,
            color: '#cbd5e1',
            formatter: () => pointLabel(x),
          },
        }
      : {}),
  }))
  const criticalPts = rows.filter((x) => !x.virtual && x.status.startsWith('CRITICAL'))

  // 关联输血事件标记：按「对照关联」口径（affectsView，比 affects 宽）显示事件时间竖线——
  // 白细胞/中性粒细胞图也会显示「输注红细胞 2U」，便于对照「输红细胞后白细胞出现变化」。
  // 竖线只作时间参照、不代表因果；是否画竖直跳变仍由 applyJump 内的 affects（严格口径）决定，
  // 避免把「红细胞→白细胞」这类非直接作用画成跳变而误导。
  const relatedEvents = events.filter((e) => affectsView(e, code))
  const markLine = relatedEvents.length
    ? {
        symbol: 'none',
        silent: true,
        tooltip: {
          show: true,
          formatter: (p) => p.data.evText,
          backgroundColor: '#1e293b',
          borderColor: '#334155',
          textStyle: { color: '#e2e8f0' },
        },
        data: relatedEvents.map((e) => {
          const lbl = eventLabel(e)
          return {
            name: lbl,
            evText: `${e.date}${e.time ? ' ' + e.time : ''} ${lbl}`,
            xAxis: eventTs(e, recordSlots),
            lineStyle: { color: e.color || '#f59e0b', width: 2, type: 'dashed' },
            label: {
              show: true,
              position: 'insideEndTop',
              distance: 2,
              color: '#0f172a',
              backgroundColor: e.color || '#f59e0b',
              borderRadius: 4,
              padding: [3, 2],
              fontSize: 10,
              fontWeight: 600,
              // 竖排（逐字换行，与主图同口径）：避免横排标签盖住走势线
              formatter: () => lbl.slice(0, 6).split('').join('\n'),
              lineHeight: 11,
            },
          }
        }),
      }
    : null

  // 折线：数据点按状态着色（危急深红、偏低/偏高琥珀、正常系统色）
  const lineSeries = {
    name: field ? field.name : code,
    type: 'line',
    data,
    smooth: true,
    // 只在 x 单调段平滑：输血跳变的竖直段保持笔直，不被平滑拉弯
    smoothMonotone: 'x',
    symbol: 'circle',
    symbolSize: 6,
    lineStyle: { width: 2.5, color },
    markArea: [...buildBand(dates, byDate, code), ...buildRiskBand(dates, byDate, code, min, max)],
    markLine,
    z: 10,
  }

  // 危急值点：静态深红圆点叠加高亮（不带雷达波动画，仅在有危急点时叠加）
  const scatterSeries = criticalPts.length
    ? {
        name: '危急值',
        type: 'scatter',
        data: criticalPts.map((x) => [x.ts, x.v]),
        symbolSize: 11,
        itemStyle: { color: '#b91c1c', borderColor: '#fff', borderWidth: 1.5 },
        z: 20,
      }
    : null

  const tooltip = {
    trigger: 'axis',
    confine: true,
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    textStyle: { color: '#e2e8f0' },
    formatter: (params) => {
      if (!params || !params.length) return ''
      // ECharts time 轴 axisValue 为毫秒时间戳，统一按本地时区转回 YYYY-MM-DD（与坐标轴标签同一规则）
      const axisVal = params[0].axisValue
      const tsNum =
        typeof axisVal === 'number'
          ? axisVal
          : typeof axisVal === 'string' && /^\d+$/.test(axisVal)
          ? Number(axisVal)
          : null
      const d = tsNum != null ? fmtLocal(tsNum) : String(axisVal).slice(0, 10)
      // 按天聚合：当天若有多次报告，逐份列出（用采集时间区分），而非只命中一个被错开的数据点
      const daySlots = recordSlots.filter((s) => s.date === d)
      if (!daySlots.length) return ''
      const blocks = []
      for (const s of daySlots) {
        const rec = s.r
        const recTime = extractHHmm(rec)
        const p = findPoint(rec, code)
        if (!p) continue
        const v = num(p.value)
        if (v == null) continue
        const unit = p.unit || (field && field.unit) || ''
        const ref = p.ref_range || (field && field.ref) || ''
        const st = p.status || computeStatus(code, p.value, p.ref_range)
        const stMeta = st && STATUS_META[st]
        const stColor = stMeta ? (stMeta.color === 'red' ? '#f87171' : stMeta.color === 'amber' ? '#fbbf24' : '#34d399') : ''
        const stHtml = stMeta ? ` <span style="color:${stColor}">· ${stMeta.label}</span>` : ''
        blocks.push(
          (recTime ? `<div style="margin-top:3px;font-size:11px;color:#94a3b8">${recTime}</div>` : '') +
            `<div style="font-size:12px">${v} ${unit}<span style="color:#94a3b8"> · 参考 ${ref}</span>${stHtml}</div>`
        )
      }
      return `<div style="font-weight:600;margin-bottom:2px">${field ? field.name : code} · ${d}</div>` + blocks.join('')
    },
  }

  return {
    animationDuration: 400,
    tooltip,
    grid: { left: 48, right: 20, top: 40, bottom: 56 },
    xAxis: {
      type: 'time',
      axisLabel: {
        fontSize: 10,
        color: '#94a3b8',
        // 显式按本地时区格式化，保证坐标轴刻度与浮层日期永不差一天
        formatter: (ts) => {
          const t = new Date(ts)
          return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`
        },
      },
      axisLine: { lineStyle: { color: '#334155' } },
      axisTick: { alignWithLabel: true },
    },
    yAxis: {
      type: 'value',
      min,
      max,
      axisLabel: {
        fontSize: 10,
        color: '#94a3b8',
        formatter: (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(1)))),
      },
      splitLine: { lineStyle: { type: 'dashed', color: '#334155' } },
    },
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      {
        type: 'slider',
        height: 16,
        bottom: 8,
        borderColor: '#334155',
        backgroundColor: '#0f172a',
        fillerColor: 'rgba(148,163,184,0.25)',
        textStyle: { color: '#94a3b8', fontSize: 10 },
      },
    ],
    series: scatterSeries ? [lineSeries, scatterSeries] : [lineSeries],
  }
}

// 共享数据准备：主图表与 CBCDetailView 共用同一套「排序 → 同天合并 → 事件过滤 → 断档诊断」聚合，
// 保证两处图表数据口径一致
export function prepareTrendData(records = [], events = []) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : 1))
  const dates = [...new Set(sorted.map((r) => r.date))].sort()

  // 同一天可能有多份记录（血常规 + 尿常规 + 肝肾功 + 凝血等），若只保留最后一条，
  // 当天「最后保存的那份恰好不含 WBC/Hb/PLT」时，血常规指标会全部丢失 → 断线成孤立点。
  // 改为合并同一天全部记录的所有指标（后保存的同指标覆盖先保存的），保证每天都保留完整指标集。
  const byDate = {}
  for (const r of sorted) {
    const prev = byDate[r.date]
    if (!prev) {
      byDate[r.date] = r
    } else {
      const pts = new Map((prev.data_points || []).map((p) => [p.standard_code, p]))
      for (const p of r.data_points || []) pts.set(p.standard_code, p)
      byDate[r.date] = { ...prev, data_points: [...pts.values()] }
    }
  }

  // 每个保存的记录独立成图上的时间锚点：使同一天多份报告（如早晚两次血常规）显示为多个点，
  // 而非被「按天合并」压成一点。同天多份 / 缺采集时间时，用「时间 + 同天序号」做分钟级偏移保证不重叠
  const daySlots = {}
  const recordSlots = sorted.map((r) => {
    const base = toTs(r.date)
    let off = 0
    const m = /(\d{1,2}):(\d{2})/.exec(extractTimeStr(r))
    if (m) off = (Number(m[1]) * 60 + Number(m[2])) * 60000
    let ts = base + off
    daySlots[r.date] ||= []
    while (daySlots[r.date].includes(ts)) ts += 60000
    daySlots[r.date].push(ts)
    return { r, ts, date: r.date }
  })
  const byTs = new Map(recordSlots.map((s) => [s.ts, s.r]))

  const fields = [...new Set(records.flatMap((r) => (r.data_points || []).map((p) => p.standard_code)))].filter(Boolean)

  // 仅「输血」类别事件绘制在趋势图上（用药事件仅记录，不进图表；旧数据无 category 者按输血处理以兼容历史标记）
  const markerEvents = events.filter(
    (e) => (e.kind || 'marker') === 'marker' && (e.category || 'transfusion') === 'transfusion'
  )

  // 断档诊断：哪些天有血常规数据、哪些区间缺数据（解释"为什么没连线"）
  const cbcCodes = new Set(CBC_GROUPS.flatMap((g) => g.series.map((s) => s.code)))
  const cbcDays = [
    ...new Set(
      records
        .filter((r) =>
          (r.data_points || []).some((p) => {
            if (!cbcCodes.has(p.standard_code)) return false
            const n = parseFloat(p.value)
            return !Number.isNaN(n)
          })
        )
        .map((r) => r.date)
    ),
  ].sort()

  let gapNote = ''
  if (cbcDays.length === 0) {
    gapNote = '无血常规数据'
  } else if (cbcDays.length === 1) {
    gapNote = `仅 ${cbcDays.length} 天有血常规数据（${cbcDays[0].slice(5)}），单点无法连线`
  } else {
    const gaps = []
    for (let i = 1; i < cbcDays.length; i++) {
      const gap = Math.round((new Date(cbcDays[i]) - new Date(cbcDays[i - 1])) / 86400000)
      if (gap > 1) gaps.push(`${cbcDays[i - 1].slice(5)}~${cbcDays[i].slice(5)} 缺 ${gap - 1} 天`)
    }
    const days = cbcDays.map((d) => d.slice(5)).join('、')
    gapNote = `血常规有值：${days}（${cbcDays.length} 天）${gaps.length ? `；断档 ${gaps.join('；')}` : '，连续无断档'}`
  }

  // 数据中实际出现过危急值的指标（供「危急指标」动态扩充）
  const criticalSeen = new Set()
  records.forEach((r) =>
    (r.data_points || []).forEach((p) => {
      if (p.status && p.status.startsWith('CRITICAL')) criticalSeen.add(p.standard_code)
    })
  )

  return { sorted, dates, byDate, fields, markerEvents, cbcDays, gapNote, criticalSeen, recordSlots, byTs }
}

// 指标范围切换维度：重要（默认） / 危急。
// 全部指标的浏览由「📊 详细走势」页承载（分组卡片 + 单指标放大），不再在此重复堆叠折线
const RANGES = [
  { key: 'important', label: '重要指标' },
  { key: 'critical', label: '危急指标' },
]

// 重要指标：临床最常关注的 CBC 关键项
const IMPORTANT_CODES = ['WBC', 'NEUT_ABS', 'LYM_ABS', 'RBC', 'Hb', 'HCT', 'PLT', 'HS_CRP']

// 危急指标：与危急值强相关的候选，并动态并入数据中实际出现过危急值的指标
const CRITICAL_CODES = ['WBC', 'NEUT_ABS', 'Hb', 'PLT']

/* ============ 单图渲染（供主图表与 CBC 分图复用） ============ */
export function MiniChart({ dates, byDate, events, specs, height, recordSlots = [], byTs = new Map(), build = buildOption, lazy = false }) {
  const ref = useRef(null)
  const inst = useRef(null)

  // 懒渲染：详细走势页一次可能渲染 90+ 个指标卡片，若同时挂载会瞬间 init 大量 ECharts 实例。
  // 仅当卡片进入视口（rootMargin 预加载 200px）才 init；数据变化（如切换 showFlat）时 effect
  // 重跑并重新 observe，仍在视口则再次触发 render 以刷新 option。lazy=false 时立即 init（主图等场景）。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let io
    const render = () => {
      if (!inst.current) inst.current = echarts.init(el)
      // 传入容器宽度供窄屏 grid 边距钳制（仅首次取值，避免 resize 重播入场动画）
      inst.current.setOption(build(dates, byDate, events, specs, recordSlots, byTs, inst.current.getWidth()), true)
    }
    if (!lazy) {
      render()
    } else {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            render()
            io.disconnect()
          }
        },
        { root: null, rootMargin: '240px' }
      )
      io.observe(el)
    }
    return () => io && io.disconnect()
  }, [dates, byDate, events, specs, lazy])

  // 尺寸变化重绘：窗口缩放、卡片折行、栅格变化都要跟随。
  // 只调 resize() 不 setOption —— 保留 dataZoom 缩放状态，也不重播入场动画。
  // ResizeObserver 捕获容器自身尺寸变化，window resize 兜底；rAF 合并高频调用（拖拽窗口时）。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (inst.current) inst.current.resize()
      })
    }
    window.addEventListener('resize', schedule)
    let ro
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule)
      ro.observe(el)
    }
    return () => {
      window.removeEventListener('resize', schedule)
      if (ro) ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(
    () => () => {
      if (inst.current) {
        inst.current.dispose()
        inst.current = null
      }
    },
    []
  )

  return <div ref={ref} style={{ width: '100%', height, background: '#0f172a', borderRadius: 12 }} />
}

/* ============ 主图表 ============ */
export default function TrendChart({ records, events, onExpandCBC, badges }) {
  const [range, setRange] = useState('important')

  // 右上角范围按钮上的计数徽标：指标种类 / 危急值 / 偏离值并入按钮，点击即切换视图
  const badgeOf = { important: badges?.abnormal, critical: badges?.critical }
  const hintOf = {
    important: `重要指标 · 当前偏离 ${badges?.abnormal ?? 0} 种（按最近一次记录）`,
    critical: `危急指标 · 当前危急 ${badges?.critical ?? 0} 种（按最近一次记录）`,
  }
  // 共享数据准备：排序 → 同天合并 → 事件过滤 → 断档诊断（与 CBCDetailView 同一口径）
  const { dates, byDate, fields, markerEvents, cbcDays, gapNote, criticalSeen, recordSlots, byTs } = useMemo(
    () => prepareTrendData(records, events),
    [records, events]
  )

  // 按范围取指标子集，量纲各异 → 参考区间归一化合并为单图
  const specs = useMemo(() => {
    let codes = range === 'important' ? IMPORTANT_CODES : [...new Set([...CRITICAL_CODES, ...criticalSeen])]
    codes = codes.filter((c) => fields.includes(c))
    // 「危急指标」无可用数据时回退到全部指标，避免空图
    if (range === 'critical' && codes.length === 0) {
      codes = CBC_GROUPS.flatMap((g) => g.series.map((s) => s.code)).filter((c) => fields.includes(c))
    }
    return codes.map((code) => ({ code, y: AXIS_GROUP[code] ?? 0 }))
  }, [fields, range, criticalSeen])

  // 绿带（参考区间）当前归属于哪个指标 —— 多轴下只能画一条，必须显式告知用户它属于谁
  const bandName = useMemo(() => {
    const code = pickBandBaseline(specs)
    const f = code && FIELD_BY_CODE[code]
    return f ? f.name : ''
  }, [specs])

  // 有血常规数据时才启用「详细走势」入口
  const hasCBC = records.length > 0 && specs.length > 0

  // 输血时序/效果合理性诊断（依据「输血一般晚于检查、属提升性干预」规律）
  const transfusionNotes = useMemo(() => {
    const reportDatesByCode = {}
    for (const d of dates) {
      for (const code of fields) {
        const r = byDate[d]
        if (r && findPoint(r, code)) (reportDatesByCode[code] ||= []).push(d)
      }
    }
    return diagnoseTransfusion(markerEvents, reportDatesByCode, byDate, findPoint, num)
  }, [dates, byDate, fields, markerEvents])

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-semibold text-slate-700">全血细胞分析</h3>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg overflow-hidden border border-slate-200 text-xs">
              {RANGES.map((r) => {
                const n = badgeOf[r.key] || 0
                return (
                  <button
                    key={r.key}
                    onClick={() => setRange(r.key)}
                    title={hintOf[r.key]}
                    className={`px-3 py-1.5 transition-colors ${
                      range === r.key ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {r.label}
                    {n > 0 && (
                      <span
                        className={`ml-1.5 rounded px-1 py-0.5 text-[10px] leading-none font-medium ${
                          range === r.key
                            ? 'bg-white/25 text-white'
                            : r.key === 'critical'
                              ? 'bg-rose-100 text-rose-600'
                              : r.key === 'important'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-200 text-slate-500'
                        }`}
                      >
                        {n}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            <button
              onClick={onExpandCBC}
              disabled={!hasCBC}
              className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                hasCBC
                  ? 'bg-brand-600 text-white shadow-sm hover:bg-brand-700'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              <span aria-hidden>📊</span> 详细走势
            </button>
          </div>
        </div>

        {records.length === 0 ? (
          <div className="h-72 flex flex-col items-center justify-center text-slate-400">
            <div className="text-4xl mb-2">📈</div>
            <p className="text-sm">暂无数据，先在前几步导入并保存化验记录</p>
          </div>
        ) : specs.length > 0 ? (
          <MiniChart dates={dates} byDate={byDate} events={markerEvents} specs={specs} recordSlots={recordSlots} byTs={byTs} height={420} />
        ) : (
          <div className="h-72 flex items-center justify-center text-slate-400 text-sm">该数据中无全血细胞分析指标</div>
        )}

        <p className="text-xs text-slate-400 mt-2">
          左侧为真实数值（绝对值）刻度、右侧为百分比（%）刻度；虚线为百分比指标
          {bandName
            ? `；绿带为${bandName}参考区间（其余指标的参考区间见「详细走势」单指标图）`
            : '；本视图无参考区间带'}
          ；彩色竖线为治疗事件。输血后指标在事件日竖直上升，下降段不画人工跳变，避免误读为「输血导致骤降」
        </p>
        {transfusionNotes.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-amber-600 font-bold" aria-hidden>!</span>
              <span className="font-semibold">输血效果待核查</span>
            </div>
            <div className="space-y-1">
              {transfusionNotes.map((n, i) =>
                n.type === 'not-risen' ? (
                  <div key={i} className="flex items-baseline gap-2 leading-tight">
                    <span className="font-mono shrink-0">{n.date}</span>
                    <span className="font-mono shrink-0 text-[11px] text-slate-500">{n.label}</span>
                    <span className="shrink-0">
                      {n.codeName}
                      <span className="text-slate-500 text-[10px]"> {n.beforeVal}
                        <span className="text-amber-600">→</span>
                        {n.afterVal}
                        {n.unit && ` ${n.unit}`}</span>
                    </span>
                    <span className="text-amber-600 shrink-0" title={`${n.beforeDate} → ${n.afterDate} 复查未见升高`}>↓</span>
                  </div>
                ) : (
                  <div key={i} className="flex items-baseline gap-2 leading-tight">
                    <span className="font-mono shrink-0">{n.date}</span>
                    <span className="font-mono shrink-0 text-[11px] text-slate-500">{n.label}</span>
                    <span>输血后未复查相关指标</span>
                  </div>
                )
              )}
            </div>
            <p className="mt-1.5 text-[10px] text-amber-600/80">
              输血属提升性干预，复查指标未见升高（或未复查），建议核对原始化验单
            </p>
          </div>
        )}
        <p className="text-xs text-slate-500 mt-1.5 font-mono">{gapNote}</p>
      </div>
    </div>
  )
}

/* ============ 已归档记录列表 ============ */
// 报告类型 → Tag 配色（与检查报告列表的分类标签共用 antd 色板）
const TYPE_COLOR = {
  CBC: 'blue',
  CBC_hsCRP: 'blue',
  LIVER: 'green',
  LIVER_KIDNEY_ION: 'green',
  BIOCHEM: 'green',
  COAGULATION: 'purple',
  CARDIAC: 'red',
  THYROID: 'cyan',
  FUNGUS: 'magenta',
  INFECTION: 'magenta',
  URINALYSIS: 'gold',
  STOOL: 'gold',
  BLOOD_TYPE: 'geekblue',
  ANEMIA: 'orange',
  BONE_MARROW_MORPHOLOGY: 'volcano',
  UNKNOWN: 'default',
}

const PAGE_SIZE = 20

// 检验记录列表（报告页内嵌）。
// 文本检索与时间区间已由报告页统一施加（`records` 传进来就是命中的集合，见 utils/reportFilter.js），
// 故这里只保留自己这一层的「报告类型分类」筛选与分页——两处各存一份搜索谓词必然漂移。
export function RecordsTable({ records, labDocs = [], onViewChart, onViewDetail, onOpenDoc }) {
  const [category, setCategory] = useState('all')
  const [page, setPage] = useState(1)
  // 图文报告行「原件」直达的弹层（只看原件，不带识别内容——那走「查看报告」的 DocDetail）。
  // 两道入口并存是用户口径（2026-10-30）：图文报告也有文字录入，原件与识别内容都要能看到。
  const [originalDoc, setOriginalDoc] = useState(null)

  // 一份清单：检验记录（项目-数值）+ 检验图文报告（原件归档）同轴混排、按日期倒序。
  // 用户口径（2026-10-27）：**不区分「指标型 / 图文型」**——不加类型标签、不分段、不加二级筛选，
  // 找报告只按时间；两类行各自的渲染保留，但排在一条时间轴上。
  // 为什么不并成一张"行字段相同"的表：两库字段无交集（见 ReportsPage 头部），并表要裁掉各自专有信息。
  const items = useMemo(() => {
    const recItems = records.map((r) => ({
      __t: 'record',
      id: r.id,
      date: r.checked_at || r.date || '',
      created_at: r.created_at || '',
      raw: r,
    }))
    const docItems = labDocs.map((d) => ({
      __t: 'doc',
      id: d.id,
      date: d.date || '',
      created_at: d.created_at || '',
      raw: d,
    }))
    return [...recItems, ...docItems].sort((a, b) => {
      if (a.date !== b.date) return a.date > b.date ? -1 : 1
      // 同一天按创建时间倒序，新记录在最上
      return String(b.created_at).localeCompare(String(a.created_at))
    })
  }, [records, labDocs])

  // 「记录不带原件、但归档里有同一份报告的原件」索引：key = 日期|kind。
  // 只做跳转用途，不改数据、不合并两条记录（是否同一份报告由用户自己看日期/类型判断）。
  const docOriginalByKey = useMemo(() => {
    const m = new Map()
    for (const d of labDocs) {
      const pid = (d.file && (d.file.id || d.file.name)) || d.id
      if (!pid) continue
      m.set(`${String(d.date || '').slice(0, 10)}|${d.kind}`, d)
    }
    return m
  }, [labDocs])

  const originalDocOf = (r) => {
    if (r && (r.original_image_id || r.image)) return null // 自己就有原件，走「查看报告」
    const kind = KIND_BY_REPORT_TYPE[r && r.report_type]
    if (!kind) return null
    return docOriginalByKey.get(`${String(r.date || '').slice(0, 10)}|${kind}`) || null
  }

  // 分类 key（明细）→ 展示 key：骨髓形态学/流式/融合基因合并成「骨髓检查」（CATEGORY_GROUPS）。
  // 图文报告的 kind 先映射回同一套明细 report_type，才能和记录落在同一个分类里。
  const typeCodeOf = (it) =>
    it.__t === 'record' ? it.raw.report_type || 'UNKNOWN' : LAB_KIND_REPORT_TYPE[it.raw.kind] || 'UNKNOWN'
  const displayCatOf = (it) => {
    const raw = recordCategoryOf(typeCodeOf(it))
    const merged = mergedCategoryOf(raw)
    return merged ? merged.key : raw
  }

  const categories = useMemo(() => {
    const counts = new Map()
    for (const it of items) {
      const cat = displayCatOf(it)
      counts.set(cat, (counts.get(cat) || 0) + 1)
    }
    const byKey = new Map(RECORD_CATEGORIES.map((c) => [c.key, c]))
    const groupLabel = new Map(CATEGORY_GROUPS.map((g) => [g.key, g.label]))
    const present = [...counts.entries()]
      .filter(([k]) => byKey.has(k) || k === OTHER_CATEGORY.key || groupLabel.has(k))
      .map(([k, count]) => ({
        value: k,
        label: groupLabel.get(k) || (byKey.get(k) || OTHER_CATEGORY).label,
        count,
      }))
    present.sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
    // 规模策略（用户 2026-10-27）：>5 份的「基因检测」才单独成类，只有 1 份的分类并入「其他」
    return [{ value: 'all', label: '全部', count: items.length }, ...applyCategorySizePolicy(present)]
  }, [items])

  // 「其他」要能命中被规模策略折叠掉的分类（members 里带着它们的 key）
  const activeCatMembers = useMemo(() => {
    const c = categories.find((x) => x.value === category)
    return c && c.members ? c.members : [category]
  }, [categories, category])
  const filtered = useMemo(
    () => items.filter((it) => category === 'all' || activeCatMembers.includes(displayCatOf(it))),
    [items, category, activeCatMembers]
  )

  const columns = [
    {
      title: '日期',
      key: 'date',
      width: 200,
      render: (_, it) => {
        const r = it.raw
        const main = it.__t === 'record' ? r.checked_at || r.date : r.date
        const reported = r.reported_at
        return (
          <div className="font-mono text-xs text-slate-700 whitespace-nowrap">
            <div className="truncate">{main}</div>
            {reported && reported !== main && <div className="text-slate-400 truncate">报告 {reported}</div>}
            {reported && reported === main && r.time && <div className="text-slate-400 truncate">{r.time}</div>}
          </div>
        )
      },
    },
    {
      title: '报告类型',
      key: 'report_type',
      render: (_, it) =>
        it.__t === 'record' ? (
          <span className="inline-flex items-center gap-1.5">
            <Tag color={TYPE_COLOR[it.raw.report_type] || 'default'}>
              {reportTypeLabel(it.raw.report_type) || '未识别'}
            </Tag>
            <AssetBadge entity={it.raw} noun="原图" />
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <Tag color={TYPE_COLOR[LAB_KIND_REPORT_TYPE[it.raw.kind]] || 'default'}>
              {it.raw.doc_type || kindLabel(it.raw.kind)}
            </Tag>
            <AssetBadge entity={it.raw} noun="原件" />
          </span>
        ),
    },
    {
      title: '指标数',
      key: 'count',
      width: 80,
      align: 'right',
      render: (_, it) => (it.__t === 'record' ? (it.raw.data_points || []).length : '—'),
    },
    {
      title: '危急/偏离',
      key: 'status',
      width: 120,
      render: (_, it) => {
        if (it.__t !== 'record') return <span className="text-slate-300">—</span>
        const critical = (it.raw.data_points || []).filter((p) => (p.status || '').startsWith('CRITICAL')).length
        const abnormal = (it.raw.data_points || []).filter((p) => p.status === 'LOW' || p.status === 'HIGH').length
        if (critical > 0) return <span className="text-red-600 font-medium">{critical} 危急</span>
        if (abnormal > 0) return <span className="text-amber-600">{abnormal} 偏离</span>
        return <span className="text-emerald-600">全部正常</span>
      },
    },
    {
      title: '备注',
      key: 'notes',
      ellipsis: true,
      render: (_, it) => {
        // 图文报告：结论 → 所见 → **有信息量的标题**（模板抬头如「…检查报告单」不再当备注显示）
        const text =
          it.__t === 'record'
            ? it.raw.notes || ''
            : it.raw.conclusion || it.raw.findings || docHeading(it.raw).main || ''
        return (
          <span className="text-slate-500" title={text}>
            {text || '—'}
          </span>
        )
      },
    },
    {
      title: '',
      key: 'actions',
      width: 200,
      align: 'right',
      render: (_, it) => {
        if (it.__t === 'doc') {
          return (
            <span className="whitespace-nowrap">
              {/* 原件与识别内容都保留入口：行上「原件」直达图片/PDF，「查看报告」进图文两栏详情 */}
              <Button
                type="link"
                size="small"
                onClick={() => setOriginalDoc(it.raw)}
                title="只看原件（图片 / PDF）"
              >
                原件
              </Button>
              <Button type="link" size="small" onClick={() => onOpenDoc && onOpenDoc(it.raw)}>
                查看报告
              </Button>
            </span>
          )
        }
        const r = it.raw
        const originalDoc = originalDocOf(r)
        return (
          <span className="whitespace-nowrap">
            {/* 记录本身没有原件、但同一天同类型的报告已归档原件 → 一步跳到那份原件 */}
            {originalDoc && (
              <Button type="link" size="small" onClick={() => onOpenDoc && onOpenDoc(originalDoc)}>
                原件
              </Button>
            )}
            {hasTrend(r) && (
              <Button type="link" size="small" onClick={() => onViewChart(r)}>
                查看趋势
              </Button>
            )}
            <Button type="link" size="small" onClick={() => onViewDetail(r)}>
              查看报告
            </Button>
            <Button type="link" size="small" danger onClick={() => deleteRecord(r.id)}>
              删除
            </Button>
          </span>
        )
      },
    },
  ]

  return (
    <>
      {/* 零命中（库里空 或 报告页的搜索/时间条件没命中）时不渲染一排「0」分类 —— 只留空态说明 */}
      {items.length > 0 && (
        <SectionFilterBar
          tabsOnly
          categories={categories}
          value={category}
          onChange={setCategory}
          onResetPaging={() => setPage(1)}
        />
      )}
      <Table
        dataSource={filtered}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={
          filtered.length > PAGE_SIZE
            ? {
                current: page,
                pageSize: PAGE_SIZE,
                onChange: setPage,
                showTotal: (t) => `共 ${t} 条`,
                size: 'small',
              }
            : false
        }
        locale={{
          emptyText:
            items.length === 0 ? (
              <div className="py-6 text-sm text-slate-400">
                <p className="mb-1">暂无检验记录</p>
                <p className="text-xs">
                  可能还没导入化验单，或当前搜索 / 时间条件没有命中；用上方「＋ 导入化验单」可继续导入
                </p>
              </div>
            ) : (
              <span className="text-sm text-slate-400">未找到匹配的记录</span>
            ),
        }}
      />
      {originalDoc && <DocOriginalModal doc={originalDoc} onClose={() => setOriginalDoc(null)} />}
    </>
  )
}
