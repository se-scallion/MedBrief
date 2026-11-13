// ===================== 体温叠加趋势图（Apache ECharts） =====================
// 单 Y 轴（℃）+ 时间 X 轴：体温折线 + 超阈红点 + 两条阈值虚线 + 用药疗程色带（markArea）。
// 与化验趋势图（TrendChart）独立，量纲不同，不混入 prepareTrendData，保证化验图零回归。
// 复用本地时区规则（eventTs/dateTs，与 medCourses 同口径），避免 ECharts time 轴按 UTC 解析差一天。
//
// 交互：沿用 ECharts 默认 hover 浮层（trigger:'axis'），悬停即看「体温 + 当天用药剂量」，
// 不做任何自定义点击/固定浮层逻辑（与化验趋势图一致，图表只负责看，编辑在录入表单/日程页）。

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { dateTs, eventTs, groupMedCourses, localToday, normDrug } from '../utils/medCourses.js'
import { useEscClose } from '../utils/overlay.js'
import { tempEventsOf, classifyFever } from '../utils/temperature.js'
import { deleteEvent } from '../data/store.js'

const POINT_COLOR = { normal: '#f97316', low: '#f59e0b', high: '#dc2626' }

function TempTrendChart({ events, thresholds = { low: 37.3, high: 38.5 }, ignoredDrugs = [], onEdit, height = 170, range = null, dense = false }) {
  const ref = useRef(null)
  const inst = useRef(null)
  const popRef = useRef(null)
  const seriesKeyRef = useRef(null)
  const [pop, setPop] = useState(null)

  const today = localToday()
  // 必须 memo：否则每次渲染都是新数组 → data 重算 → 更新 effect 被无谓触发
  const temps = useMemo(() => tempEventsOf(events), [events])
  const hasData = temps.length > 0
  // 只画「体温相关」的药；ignoredDrugs 里的药（按归一化药名）不进体温叠图，但仍完整保留在日程页
  const courses = useMemo(
    () => groupMedCourses(events).filter((c) => !ignoredDrugs.includes(normDrug(c.key))),
    [events, ignoredDrugs],
  )

  // 用药剂量折线：画在右轴（双 Y 轴），每种药一条 step 线。坐标用分段的时间戳（fromTs/toTs），
  // 从而支持「小时级」输注——同一袋跨日、相邻袋在边界时刻衔接都能精确延伸。
  const medSeries = useMemo(() => {
    return courses.map((c) => {
      const pts = []
      let prevToTs = null
      const segs = [...c.segments].sort((a, b) => (a.fromTs ?? 0) - (b.fromTs ?? 0))
      for (const s of segs) {
        if (s.dose == null) {
          prevToTs = s.toTs != null ? s.toTs : dateTs(today)
          continue
        }
        const x1 = s.fromTs ?? dateTs(s.from)
        const x2 = s.toTs != null ? s.toTs : dateTs(today)
        if (x2 < x1) {
          prevToTs = x2
          continue
        }
        // 与上一段间隔超过 1.5 天 → 插入断点，避免跨空档连成斜线
        if (prevToTs != null && x1 - prevToTs > 86400000 * 1.5) pts.push([prevToTs, null])
        // 每段起点带剂量标签（如 45mg），数值常驻可见；终点用纯数组不带标签，避免重复
        pts.push(
          {
            value: [x1, s.dose],
            label: { show: true, formatter: `${s.dose}${s.unit || ''}`, position: 'top', fontSize: 9, color: c.color, fontWeight: 600 },
          },
          [x2, s.dose],
        )
        prevToTs = x2
      }
      return {
        name: c.drug,
        type: 'line',
        yAxisIndex: 1,
        data: pts,
        step: 'end',
        smooth: false,
        symbol: 'none',
        label: { show: false },
        lineStyle: { width: 1.6, color: c.color },
        z: 5,
      }
    })
  }, [courses, today])

  // 体温数据点：超阈换色（低热橙 / 高热红），正常橙
  const data = useMemo(() => {
    return temps.map((e) => {
      const level = classifyFever(e.temp, thresholds)
      return {
        value: [eventTs(e), e.temp],
        id: e.id,
        date: e.date,
        time: e.time || '',
        temp: e.temp,
        level,
        itemStyle: { color: POINT_COLOR[level] },
      }
    })
  }, [temps, thresholds.low, thresholds.high])

  // Esc 关闭浮层（走统一栈：本浮层后挂载＝栈顶，不会连带触发页面级「Esc 返回」）
  useEscClose(() => setPop(null), !!pop)

  // 点击浮层外 → 关闭（固定浮层，非 hover 跟随）
  useEffect(() => {
    if (!pop) return
    const onDown = (e) => {
      if (popRef.current && popRef.current.contains(e.target)) return
      setPop(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pop])

  // 最简：浮层只有「编·删」——点「编」交给父级已有录入表单，点「删」直接删事件
  const doEdit = () => {
    onEdit && onEdit(pop)
    setPop(null)
  }
  const doDelete = () => {
    deleteEvent(pop.id)
    setPop(null)
  }

  // 生命周期：init / resize / dispose 只在挂载（或「有无数据」翻转）时执行。
  // 关键：数据更新时绝不再 dispose 重建——旧实现每次渲染都销毁重建图表，
  // 既丢失 dataZoom 缩放状态，又重放 400ms 入场动画。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    inst.current = echarts.init(el)
    const onResize = () => inst.current && inst.current.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (inst.current) {
        inst.current.dispose()
        inst.current = null
      }
    }
  }, [hasData])

  // 仅更新配置，绝不销毁实例
  useEffect(() => {
    if (!inst.current) return

    // X 轴范围由体温数据决定：用药线段不占位置（不向左/右撑开坐标轴）；
    // 最左侧即首个体温点（如 9/4 15:00），超出体温范围的用药段在轴边界处裁切。
    const tMin = data.length ? Math.min(...data.map((d) => d.value[0])) : undefined
    const tMax = data.length ? Math.max(...data.map((d) => d.value[0])) : undefined
    // 管理页传入 range 时，X 轴范围由时段决定（用药线段在区间外裁切，不撑开轴）；首页不传则按体温点
    const xMin = range ? range.from : tMin
    const xMax = range ? range.to : tMax
    const spanDays = xMin != null && xMax != null ? (xMax - xMin) / 86400000 : 0
    const denseTime = dense && spanDays < 3

    const option = {
      animationDuration: 400,
      // 更新（数据/阈值变化）时不再重放入场动画
      animationDurationUpdate: 0,
      grid: dense ? { left: 52, right: 52, top: 34, bottom: 0 } : { left: 44, right: 44, top: 26, bottom: 40 },
      // 单一浮层：关闭 hover 浮层，日期/体温/用药剂量/编·删 全在点击后的固定浮层里；
      // dense 模式开 axis 只读速览（hover 看数值），与点击固定浮层并存
      tooltip: dense
        ? { show: true, trigger: 'axis', backgroundColor: 'rgba(255,255,255,0.96)', borderColor: '#e2e8f0', textStyle: { fontSize: 10, color: '#334155' } }
        : { show: false },
      legend: {
        top: 0,
        left: 'center',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { fontSize: 9, color: '#64748b' },
        data: ['体温', ...courses.map((c) => c.drug)],
      },
      xAxis: {
        type: 'time',
        min: xMin,
        max: xMax,
        axisLabel: {
          fontSize: 10,
          color: '#94a3b8',
          // dense 模式日期标签翻到轴线上方（绘图区内），避免被裁切；外层 div 用负 margin 吸底
          position: dense ? 'top' : 'bottom',
          formatter: (ts) => {
            const t = new Date(ts)
            const md = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
            return denseTime
              ? `${md} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
              : md
          },
        },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      yAxis: [
        {
          type: 'value',
          name: '℃',
          scale: true,
          splitNumber: dense ? 8 : undefined,
          minInterval: dense ? 0.1 : undefined,
          position: 'left',
          nameTextStyle: { color: '#94a3b8', fontSize: 10 },
          axisLabel: { fontSize: 10, color: '#94a3b8' },
          splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } },
        },
        {
          type: 'value',
          name: '剂量',
          min: 0,
          scale: false,
          position: 'right',
          nameTextStyle: { color: '#94a3b8', fontSize: 10 },
          axisLabel: { fontSize: 10, color: '#94a3b8' },
          splitLine: { show: false },
        },
      ],
      dataZoom: dense
        ? [{ type: 'inside', start: 0, end: 100 }]
        : [
            { type: 'inside', start: 0, end: 100 },
            { type: 'slider', height: 18, bottom: 6, borderColor: '#e2e8f0', backgroundColor: '#f8fafc', fillerColor: 'rgba(249,115,22,0.2)', textStyle: { color: '#94a3b8', fontSize: 10 } },
          ],
      series: [
        {
          name: '体温',
          type: 'line',
          yAxisIndex: 0,
          data,
          smooth: true,
          smoothMonotone: 'x',
          symbol: 'circle',
          symbolSize: dense ? 7 : 9,
          label: dense
            ? { show: true, position: 'top', fontSize: 9, color: '#ea580c', fontWeight: 600 }
            : { show: false },
          lineStyle: { width: 2.5, color: '#f97316' },
          // 发烧阈值线
          markLine: {
            symbol: 'none',
            silent: true,
            data: [
              { yAxis: thresholds.low, lineStyle: { color: '#f59e0b', type: 'dashed', width: 1.5 }, label: { formatter: `低热 ${thresholds.low}℃`, color: '#b45309', fontSize: 10, position: 'insideEndTop' } },
              { yAxis: thresholds.high, lineStyle: { color: '#dc2626', type: 'dashed', width: 1.5 }, label: { formatter: `高热 ${thresholds.high}℃`, color: '#b91c1c', fontSize: 10, position: 'insideEndTop' } },
            ],
          },
          z: 10,
        },
        ...medSeries,
      ],
    }

    // series 集合变化（药品增删）或时段切换（range 变）才整体替换 option；否则走 merge，
    // 且去掉 dataZoom 配置，避免把用户当前的缩放/平移重置回 0-100。
    // 必须把 rangeKey 并入 structural：否则切时段 dataZoom 不重置、与新 xAxis min/max 打架。
    const rangeKey = range ? `${range.from}-${range.to}` : 'all'
    const seriesKey = rangeKey + '|' + courses.map((c) => c.drug).join('|')
    const structural = seriesKeyRef.current !== seriesKey
    seriesKeyRef.current = seriesKey
    let opt = option
    if (!structural) {
      opt = { ...option }
      delete opt.dataZoom
    }
    inst.current.setOption(opt, structural)
    // DEV 钩子：供 e2e 直读真值（xAxis 范围 / series 数 / markLine 阈值），生产包不含
    if (import.meta.env.DEV) window.__tempChart = inst.current

    // 点击体温数据点 → 弹固定浮层（日期+时刻 / 体温数值 / 编·删），点别处关闭
    inst.current.off('click')
    inst.current.on('click', (params) => {
      if (params.seriesName !== '体温' || !params.data || !params.data.id) return
      const d = params.data
      const ev = params.event?.event || params.event
      const px = ev?.offsetX ?? 60
      const py = ev?.offsetY ?? 0
      const meds = courses
        .map((c) => {
          const clickTs = d.value && d.value[0]
          const seg = c.segments.find(
            (s) => s.dose != null && (s.fromTs ?? dateTs(s.from)) <= clickTs && (s.toTs == null || s.toTs >= clickTs)
          )
          return seg ? { drug: c.drug, dose: seg.dose, unit: seg.unit || '', color: c.color } : null
        })
        .filter(Boolean)
      setPop({ id: d.id, date: d.date, time: d.time || '', temp: d.temp, note: d.note || '', meds, x: px, y: py })
    })

  }, [data, medSeries, courses, thresholds.low, thresholds.high, range])

  if (!temps.length) {
    return (
      <div
        className="flex items-center justify-center text-xs text-slate-400 rounded-lg border border-dashed border-slate-200"
        style={{ height: dense ? height : 112 }}
      >
        录入体温后，这里显示体温曲线，并叠加用药剂量（双轴）
      </div>
    )
  }

  return (
    <div className="relative" data-testid="temp-chart" style={{ width: '100%', height }}>
      <div ref={ref} style={{ width: '100%', height: '100%', marginBottom: -20 }} />
      {pop && (
        <div
          ref={popRef}
          data-testid="temp-popup"
          className="absolute z-20 w-48 rounded-xl border border-slate-200 bg-white shadow-lg p-3 text-xs text-slate-600"
          style={{ left: Math.max(4, Math.min(pop.x, 220)), top: Math.max(4, Math.min(pop.y, 110)) }}
        >
          {/* 缩写时间：月/日 + 时刻（无时刻只显 月/日），与项目既有浮层口径一致 */}
          <div className="mb-1 font-semibold text-slate-700">
            {pop.date ? `${Number(pop.date.slice(5, 7))}/${Number(pop.date.slice(8, 10))}` : ''}
            {pop.time ? ' ' + pop.time : ''}
          </div>
          <div className="mb-1 flex items-center gap-2">
            <span className="min-w-0 truncate">
              体温：<span className="font-medium text-orange-600">{pop.temp}℃</span>
              {pop.note ? ` · ${pop.note}` : ''}
            </span>
            {/* 编/删 跟在体温行末尾：小号纯文字，与日程页行内操作同一设计语言 */}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <button className="text-[11px] text-slate-400 hover:text-slate-700" onClick={doEdit}>
                编
              </button>
              <button className="text-[11px] text-slate-400 hover:text-red-600" onClick={doDelete}>
                删
              </button>
            </span>
          </div>
          {pop.meds && pop.meds.length > 0 && (
            <div className="mb-2 space-y-0.5">
              {pop.meds.map((m) => (
                <div key={m.drug} className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: m.color }} />
                  <span>
                    {m.drug}：{m.dose}
                    {m.unit}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// memo：父组件（录入表单）每次按键都会重渲染，props 未变时图表完全不参与重渲染
export default memo(TempTrendChart)
