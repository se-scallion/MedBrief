// ===================== 病情三维度 · 单流走势图（ECharts）=====================
// 三条流各自的坐标口径不同，不共用 TrendChart 的 buildOption（那里含参考区间/输血跳变假设）：
//   morph 线性 0–N；fcm / pcr 对数轴 + 底部「未检出」保留泳道。
// 时间轴换算（toTs/fmtLocal/extractHHmm）与 TrendChart 同源，但**复制**一份：
//   不改老图（避免 CBC 回归），两处注释互指，日后若要抽公共模块再统一。
// 实例生命周期照抄 MiniChart：init/dispose 只在挂载/卸载，数据变化只 setOption（MEMORY 红线）。

import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts'
import { STREAMS, SPECIMENS } from '../data/diseaseThresholds.js'
import { formatPct } from '../utils/diseaseGrade.js'
import { pad2, toTs, fmtLocal } from '../utils/chartAxis.js'
import { courseRanges } from '../utils/cost.js'

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

const ND_COLOR = '#f59e0b'
const TARGET_COLOR = '#f43f5e'

/** 一条系列（按标本或转录本拆）*/
function seriesOf({ name, color, dashed, points, stream }) {
  const data = []
  for (const p of points) {
    const v = num(p.value)
    const nd = p.qualifier === 'nd'
    const lt = p.qualifier === 'lt'
    const y = nd ? stream.floor : v
    // 对数轴不允许 <=0；线性轴允许 0
    if (y == null) continue
    if (stream.scale === 'log' && !(y > 0)) continue
    data.push({
      value: [toTs(p.date), y],
      symbol: nd ? 'diamond' : lt ? 'circle' : 'circle',
      symbolSize: nd ? 10 : 7,
      itemStyle: nd
        ? { color: ND_COLOR, borderColor: '#fff', borderWidth: 1 }
        : lt
          ? { color: '#fff', borderColor: color, borderWidth: 2 }
          : { color },
      _p: p,
    })
  }
  return {
    name,
    type: 'line',
    data,
    smooth: false,
    connectNulls: false,
    symbol: 'circle',
    symbolSize: 7,
    lineStyle: { width: dashed ? 1.5 : 2.5, color, type: dashed ? 'dashed' : 'solid' },
    itemStyle: { color },
    emphasis: { focus: 'series' },
    z: 10,
  }
}

function yMaxOf(stream, values) {
  const maxV = values.length ? Math.max(...values) : 0
  if (stream.scale === 'log') {
    const upper = Math.max(maxV * 10, stream.target.value * 10, 1)
    return Math.min(upper, stream.ceil)
  }
  return Math.min(100, Math.max(20, Math.ceil((maxV * 1.2) / 5) * 5))
}

/**
 * 构建单流图的 ECharts option（导出以便单测/调试）
 * @param {{streamKey:string, points:Array, courses:Array, today:string, primaryAnalyte?:string}} cfg
 */
export function buildStreamOption({ streamKey, points = [], courses = [], today, primaryAnalyte }) {
  const stream = STREAMS[streamKey]
  const pts = (points || []).filter((p) => p && p.stream === streamKey && p.verified !== false)
  const isLog = stream.scale === 'log'
  const yMin = isLog ? stream.floor : 0

  // 系列拆分：形态学/流式按标本；分子按转录本（主标志物实线，其它虚线）
  const seriesSpecs = []
  if (streamKey === 'pcr') {
    const analytes = [...new Set(pts.map((p) => p.analyte || 'other'))]
    const primary = primaryAnalyte && analytes.includes(primaryAnalyte) ? primaryAnalyte : analytes[0]
    analytes.sort((a, b) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)))
    for (const a of analytes) {
      seriesSpecs.push({
        name: a === primary ? `${a}（主标志）` : a,
        color: a === primary ? stream.color : '#94a3b8',
        dashed: a !== primary,
        points: pts.filter((p) => (p.analyte || 'other') === a).sort((x, y) => String(x.date).localeCompare(String(y.date))),
      })
    }
  } else {
    for (const sp of ['bone_marrow', 'peripheral_blood']) {
      const list = pts.filter((p) => (p.specimen || 'bone_marrow') === sp)
      if (!list.length) continue
      seriesSpecs.push({
        name: SPECIMENS[sp],
        color: sp === 'bone_marrow' ? stream.color : '#94a3b8',
        dashed: sp !== 'bone_marrow',
        points: [...list].sort((x, y) => String(x.date).localeCompare(String(y.date))),
      })
    }
  }

  const values = pts.map((p) => num(p.value)).filter((v) => v != null && v > 0)
  const series = seriesSpecs.map((s, i) => {
    const base = seriesOf({ ...s, stream })
    if (i === 0) {
      // 目标线（医学标准，只读）+ 达标区
      const markLines = [
        {
          name: stream.target.label,
          yAxis: stream.target.value,
          lineStyle: { color: TARGET_COLOR, width: 1.5, type: 'dashed' },
          label: {
            show: true,
            position: 'insideEndTop',
            formatter: stream.target.label,
            color: TARGET_COLOR,
            fontSize: 10,
            backgroundColor: 'rgba(255,255,255,0.85)',
            padding: [2, 3],
            borderRadius: 3,
          },
        },
      ]
      // 分子流额外画「较基线下降 3 log」参考线：非 IS 标化时比固定 0.1% 更稳
      if (streamKey === 'pcr') {
        const primaryPts = seriesSpecs[0]?.points || []
        const baseline = primaryPts.map((p) => num(p.value)).find((v) => v != null && v > 0)
        const threeLog = baseline ? baseline / 1000 : null
        if (threeLog && threeLog >= yMin && threeLog !== stream.target.value) {
          markLines.push({
            name: '较基线 3-log',
            yAxis: threeLog,
            lineStyle: { color: '#0f766e', width: 1, type: 'dotted' },
            label: {
              show: true,
              position: 'insideEndBottom',
              formatter: '3-log',
              color: '#0f766e',
              fontSize: 10,
              backgroundColor: 'rgba(255,255,255,0.85)',
              padding: [2, 3],
              borderRadius: 3,
            },
          })
        }
      }

      // 达标区：对数轴从 floor 起（0 不可画）
      const markAreaData = [
        [
          { yAxis: yMin, itemStyle: { color: 'rgba(16,185,129,0.08)' } },
          { yAxis: stream.target.value },
        ],
      ]
      // 疗程背景带（诱导/巩固/维持…），只作时间参照，不参与判定
      for (const r of courseRanges(courses, today)) {
        if (!r.start) continue
        markAreaData.push([
          { xAxis: toTs(r.start), itemStyle: { color: 'rgba(148,163,184,0.10)' } },
          { xAxis: toTs(r.end || today) },
        ])
      }
      base.markLine = { symbol: 'none', silent: true, data: markLines }
      base.markArea = { silent: true, data: markAreaData, label: { show: false } }
    }
    return base
  })

  const yMax = yMaxOf(stream, values)
  // 时间轴：单点或同日数据下，ECharts 会按小时切刻度、格式化成重复的「10-19」。
  // 显式给 min/max（单点前后各留一天）并限制 minInterval=1 天。
  const tsAll = seriesSpecs.flatMap((s) => s.points.map((p) => toTs(p.date))).filter((t) => Number.isFinite(t))
  const xMin = tsAll.length ? Math.min(...tsAll) : undefined
  const xMax = tsAll.length ? Math.max(...tsAll) : undefined
  const dayMs = 86400000
  const singleSpan = xMin != null && xMax != null && xMax - xMin < dayMs

  return {
    animationDuration: 300,
    legend: { top: 0, left: 8, type: 'scroll', textStyle: { fontSize: 11, color: '#475569' } },
    grid: { left: 56, right: 18, top: 34, bottom: pts.length > 4 ? 46 : 26 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: '#fff',
      borderColor: '#e2e8f0',
      textStyle: { color: '#0f172a', fontSize: 12 },
      formatter: (params) => {
        if (!params || !params.length) return ''
        const ts = params[0].axisValue
        const d = typeof ts === 'number' ? fmtLocal(ts) : String(ts).slice(0, 10)
        const blocks = []
        for (const it of params) {
          const p = it.data && it.data._p
          if (!p) continue
          const nd = p.qualifier === 'nd'
          const lt = p.qualifier === 'lt'
          // 有数字就照抄数字（0% 显示 0%）；只有定性「阴性/未检出」才显示文字
          const hasNum = p.value != null && Number.isFinite(Number(p.value))
          const v = hasNum ? (lt ? `<${formatPct(p.value)}` : formatPct(p.value)) : '未检出'
          const bits = []
          if (p.specimen) bits.push(SPECIMENS[p.specimen] || p.specimen)
          if (p.analyte) bits.push(p.analyte)
          if (p.lod != null) bits.push(`检出限 ${formatPct(p.lod)}%`)
          if (p.is_standardized === false) bits.push('非 IS 标化')
          const raw = String(p.raw || '').slice(0, 80)
          blocks.push(
            `<div style="margin:3px 0"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${it.color};margin-right:6px"></span>` +
              `<b>${v}${hasNum ? '%' : ''}</b> <span style="color:#64748b">· ${it.seriesName}</span>` +
              (bits.length ? `<div style="color:#94a3b8;font-size:11px;margin-left:13px">${bits.join(' · ')}</div>` : '') +
              (raw ? `<div style="color:#94a3b8;font-size:10px;margin-left:13px">原文：${raw}</div>` : '') +
              `</div>`
          )
        }
        return `<div style="font-weight:600;margin-bottom:2px">${stream.name} · ${d}</div>` + blocks.join('')
      },
    },
    xAxis: {
      type: 'time',
      min: singleSpan ? xMin - dayMs : undefined,
      max: singleSpan ? xMax + dayMs : undefined,
      minInterval: dayMs,
      axisLabel: {
        hideOverlap: true,
        fontSize: 10,
        color: '#94a3b8',
        formatter: (ts) => {
          const t = new Date(ts)
          return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`
        },
      },
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisTick: { alignWithLabel: true },
    },
    yAxis: {
      // ECharts 的线性轴类型是 'value'（不是 'linear'）；STREAMS.scale 只表达「线性/对数」语义
      type: stream.scale === 'log' ? 'log' : 'value',
      min: yMin,
      max: yMax,
      axisLabel: {
        fontSize: 10,
        color: '#94a3b8',
        formatter: (v) => (isLog && v <= stream.floor * 1.001 ? '未检出' : formatPct(v)),
      },
      splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } },
    },
    dataZoom:
      pts.length > 4
        ? [
            { type: 'inside', start: 0, end: 100 },
            {
              type: 'slider',
              height: 14,
              bottom: 6,
              borderColor: '#e2e8f0',
              backgroundColor: '#f8fafc',
              fillerColor: 'rgba(148,163,184,0.25)',
              textStyle: { color: '#94a3b8', fontSize: 10 },
            },
          ]
        : [],
    series,
  }
}

export default function StreamChart({ streamKey, points = [], courses = [], height = 240, primaryAnalyte }) {
  const ref = useRef(null)
  const inst = useRef(null)
  const first = useRef(true)
  const option = useMemo(
    () => buildStreamOption({ streamKey, points, courses, today: new Date().toISOString().slice(0, 10), primaryAnalyte }),
    [streamKey, points, courses, primaryAnalyte]
  )

  // 实例生命周期：只在挂载/卸载（数据变化只 setOption）
  useEffect(() => {
    const el = ref.current
    if (!el) return
    inst.current = echarts.init(el)
    const ro = new ResizeObserver(() => {
      try {
        inst.current && inst.current.resize()
      } catch {
        /* ignore */
      }
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (inst.current) {
        inst.current.dispose()
        inst.current = null
      }
      first.current = true
    }
  }, [])

  useEffect(() => {
    if (!inst.current) return
    // 首次 notMerge 保证干净；后续 merge + replaceMerge series，避免重置 dataZoom
    inst.current.setOption(option, { notMerge: first.current, replaceMerge: ['series'] })
    first.current = false
  }, [option])

  return <div ref={ref} style={{ height }} />
}
