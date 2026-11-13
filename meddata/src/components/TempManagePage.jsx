// ===================== 体温管理页（/temperature） =====================
// 全屏工作台：顶部工具条（返回 / 标题 / 状态）+ 左 3 列上排 统计/设置/记体温、下排图表(3)；右列 明细 顶到右上并通到底。
// 进入动画走 FLIP 放大（用首页卡片 rect 由 motion 反向播放），reduced-motion 下自动退化（由 MotionConfig 处理）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import DateInput from './DateInput.jsx'
import { Segmented, InputNumber, Input, Button, TimePicker, Popover, Switch } from 'antd'
import dayjs from 'dayjs'
import {
  useStore,
  addEvent,
  updateEvent,
  deleteEvent,
  updateFeverThresholds,
  toggleTempDrug,
} from '../data/store.js'
import {
  buildTempEvent,
  tempEventsOf,
  rangeOf,
  filterByRange,
  statsOf,
  classifyFever,
  FEVER_META,
  TEMP_MIN,
  TEMP_MAX,
} from '../utils/temperature.js'
import { drugRoster, normDrug } from '../utils/medCourses.js'
import { takeFlip } from '../utils/flip.js'
import TempTrendChart from './TempTrendChart.jsx'
import BackButton from './BackButton.jsx'

const pad2 = (n) => String(n).padStart(2, '0')
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
const nowTimeStr = () => {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const RANGES = [
  { value: 'today', label: '今天' },
  { value: '24h', label: '24H' },
  { value: 'yesterday', label: '昨天' },
  { value: 'week', label: '一周' },
  { value: 'all', label: '全部' },
]

const TONE = {
  normal: 'bg-slate-100 text-slate-500',
  low: 'bg-amber-100 text-amber-700',
  high: 'bg-red-100 text-red-700',
}

// 统计摘要卡（右栏上→改置左上第1位）：最高/最低/平均/发热次数/最近一次/记录数
function TempStatBar({ stats, latestLevel }) {
  const cells = [
    { id: 'max', label: '最高', value: stats.max == null ? '—' : `${stats.max}℃`, hot: latestLevel === 'high' },
    { id: 'min', label: '最低', value: stats.min == null ? '—' : `${stats.min}℃` },
    { id: 'avg', label: '平均', value: stats.avg == null ? '—' : `${stats.avg}℃` },
    { id: 'fever', label: '发热次数', value: String(stats.feverCount) },
    { id: 'latest', label: '最近一次', value: stats.latest ? `${stats.latest.date.slice(5)} ${stats.latest.time || ''}`.trim() : '—' },
    { id: 'count', label: '记录数', value: String(stats.count) },
  ]
  return (
    <div data-testid="temp-stat" className="card p-3 grid grid-cols-3 gap-2 shrink-0">
      {cells.map((c) => (
        <div key={c.id} data-testid={`temp-stat-${c.id}`} className="rounded-lg bg-slate-50 px-2 py-1.5">
          <div className="text-[11px] text-slate-400">{c.label}</div>
          <div className={`text-[18px] font-semibold leading-tight ${c.hot ? 'text-red-600' : 'text-slate-700'}`}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}

// 明细列表卡（右列：顶到右上角并通到底，占满整列高度）
function TempRecordList({ items, onEdit, onDelete, className }) {
  if (!items.length) {
    return <div className={`card p-4 text-center text-xs text-slate-400 ${className || ''}`}>该时段暂无体温记录</div>
  }
  return (
    <div data-testid="temp-list" className={`card p-2 flex-1 overflow-auto ${className || ''}`}>
      <div className="px-2 py-1.5 text-[11px] font-medium text-slate-500">明细（{items.length}）</div>
      <ul className="divide-y divide-slate-100">
        {items.map((e) => {
          const level = classifyFever(e.temp)
          return (
            <li key={e.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <span className="text-slate-500 tabular-nums w-20 shrink-0">{e.date.slice(5)} {e.time || ''}</span>
              <span className={`font-semibold ${level === 'high' ? 'text-red-600' : level === 'low' ? 'text-amber-600' : 'text-slate-700'}`}>
                {e.temp}℃
              </span>
              <span className={`text-[10px] px-1 rounded ${TONE[level]}`}>{FEVER_META[level].label}</span>
              {e.note && <span className="text-slate-400 truncate flex-1">{e.note}</span>}
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <button className="text-[11px] text-slate-400 hover:text-slate-700" onClick={() => onEdit(e)}>编</button>
                <button className="text-[11px] text-slate-400 hover:text-red-600" onClick={() => onDelete(e.id)}>删</button>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default function TempManagePage({ events, onNotify, onBack }) {
  const state = useStore()
  const thresholds = useMemo(() => state.feverThresholds || { low: 37.3, high: 38.5 }, [state.feverThresholds])
  const ignoredDrugs = useMemo(() => state.tempIrrelevantDrugs || [], [state.tempIrrelevantDrugs])

  const [rangeKey, setRangeKey] = useState('week')
  const temps = useMemo(() => tempEventsOf(events), [events])
  const nowRef = useRef(Date.now())
  const range = useMemo(() => rangeOf(rangeKey, temps, nowRef.current), [rangeKey, temps])
  const filtered = useMemo(() => filterByRange(temps, range).slice().reverse(), [temps, range])
  const stats = useMemo(() => statsOf(filtered, thresholds), [filtered, thresholds])

  // ---- FLIP 放大进入：用首页卡片缓存的 rect，在 useLayoutEffect 内直接对根元素做 transform 过渡 ----
  const flipRect = takeFlip('temp')
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !flipRect) return
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    const dx = flipRect.left - r.left
    const dy = flipRect.top - r.top
    const sx = flipRect.width / r.width
    const sy = flipRect.height / r.height
    el.style.transformOrigin = 'top left'
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
    el.style.opacity = '0.45'
    el.style.transition = 'none'
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'transform 260ms cubic-bezier(0.2,0.8,0.2,1), opacity 200ms'
        el.style.transform = ''
        el.style.opacity = '1'
      })
    })
  }, [flipRect])

  // ---- 阈值本地缓冲（防抖 400ms + 失焦/回车立即提交，避免每按键广播） ----
  const [th, setTh] = useState({ low: thresholds.low, high: thresholds.high })
  const thRef = useRef(th)
  const thTimer = useRef(null)
  useEffect(() => {
    thRef.current = { low: thresholds.low, high: thresholds.high }
    setTh((p) => (p.low === thresholds.low && p.high === thresholds.high ? p : { low: thresholds.low, high: thresholds.high }))
  }, [thresholds.low, thresholds.high])
  const commitThresholds = useCallback((next) => {
    const patch = {}
    if (Number.isFinite(next.low) && next.low > 0 && next.low < 45) patch.low = next.low
    if (Number.isFinite(next.high) && next.high > 0 && next.high < 45) patch.high = next.high
    if (Object.keys(patch).length) updateFeverThresholds(patch)
  }, [])
  const commitNow = useCallback(() => {
    if (thTimer.current) {
      clearTimeout(thTimer.current)
      thTimer.current = null
    }
    commitThresholds(thRef.current)
  }, [commitThresholds])
  const setThVal = (key, raw) => {
    const v = raw === '' || raw == null ? '' : Number(raw)
    const next = { ...thRef.current, [key]: v }
    thRef.current = next
    setTh(next)
    if (thTimer.current) clearTimeout(thTimer.current)
    thTimer.current = setTimeout(() => {
      thTimer.current = null
      commitThresholds(thRef.current)
    }, 400)
  }
  const effectiveThresholds = useMemo(
    () => ({
      low: Number.isFinite(th.low) ? th.low : thresholds.low,
      high: Number.isFinite(th.high) ? th.high : thresholds.high,
    }),
    [th.low, th.high, thresholds.low, thresholds.high]
  )

  // ---- 记体温：常驻表单；编辑态回填并带取消 ----
  const [editId, setEditId] = useState(null)
  const [f, setF] = useState({ date: todayStr(), time: nowTimeStr(), temp: '', note: '' })
  const reset = () => {
    setF({ date: todayStr(), time: nowTimeStr(), temp: '', note: '' })
    setEditId(null)
  }
  const closeAdd = () => {
    reset()
  }
  const save = () => {
    const t = Number(f.temp)
    if (!f.date || !Number.isFinite(t) || t < TEMP_MIN || t > TEMP_MAX) {
      onNotify && onNotify('请填写合法的体温（30~45℃）')
      return
    }
    const payload = buildTempEvent({ date: f.date, time: f.time || '', temp: t, note: f.note || '' })
    if (editId) {
      updateEvent(editId, payload)
      onNotify && onNotify('体温已修改')
    } else {
      addEvent(payload)
      onNotify && onNotify('体温已记录')
    }
    closeAdd()
  }
  const handleEdit = useCallback((ev) => {
    setEditId(ev.id)
    setF({ date: ev.date, time: ev.time || '', temp: String(ev.temp), note: ev.note || '' })
  }, [])

  // ---- 用药叠加开关 ----
  const roster = useMemo(
    () => drugRoster(events).filter((d) => d.count > 0),
    [events]
  )
  const shownSet = useMemo(() => new Set(ignoredDrugs), [ignoredDrugs])
  const drugContent = (
    <div className="w-56 max-h-64 overflow-auto space-y-1">
      {roster.length === 0 && <div className="text-xs text-slate-400 px-1 py-2">暂无用药记录</div>}
      {roster.map((d) => {
        const key = normDrug(d.key)
        const shown = !shownSet.has(key)
        return (
          <div key={d.key} className="flex items-center justify-between gap-2 px-1 py-1">
            <span className="text-xs text-slate-600 truncate">{d.key}</span>
            <Switch
              size="small"
              checked={shown}
              onChange={() => toggleTempDrug(key)}
              title={shown ? '已叠加到体温图' : '已隐藏'}
            />
          </div>
        )
      })}
    </div>
  )

  const status = stats.latest ? classifyFever(stats.latest.temp, thresholds) : 'normal'

  return (
    <div ref={ref} data-testid="temp-page-root" className="flex flex-col gap-3 h-[calc(100vh-92px)]">
      {/* 顶部工具条 */}
      <div className="sticky top-[60px] z-20 flex flex-wrap items-center gap-2 rounded-xl bg-white/95 backdrop-blur border border-slate-200 shadow-sm px-3 py-2">
        <BackButton onClick={onBack} tone="light" testId="temp-back" enableEsc />
        <h2 className="text-base font-semibold text-slate-800 shrink-0">体温</h2>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${TONE[status]}`}>
          {stats.latest ? FEVER_META[status].label : '无数据'}
        </span>
      </div>

      {/* 主体 4 列：左 3 列上排 统计/设置/记体温、下排 图表(3)；右列 明细 顶到右上并通到底 */}
      <div className="grid lg:grid-cols-4 lg:grid-rows-[auto_1fr_1fr_1fr] gap-3 flex-1 min-h-0 items-stretch">
        {/* 左列上排：统计(第1位) / 设置小长方形(第2位) / 记体温(第3位) */}
        <TempStatBar stats={stats} latestLevel={status} />

        {/* 设置卡：单列堆叠。
            原为 grid-cols-2 并排 —— 左格「时段」5 个选项塞不下会溢出，被右格 w-full 的
            「用药叠加」按钮盖住，导致「一周 / 全部」点不到（点到的是用药叠加）。
            改为纵向堆叠后不再有覆盖；「用药叠加」去掉 w-full 改为内容自适应宽度。 */}
        {/* items-start：避免 flex 子项被 stretch 到满宽（否则「用药叠加」按钮会被拉成 100%） */}
        <div className="card flex flex-col items-start gap-1.5 p-3 min-w-0">
          <div data-testid="temp-range" className="flex items-center gap-1.5 min-w-0 w-full">
            <span className="text-[11px] text-slate-400 shrink-0">时段</span>
            <div className="min-w-0 flex-1 overflow-x-auto">
              <Segmented options={RANGES} value={rangeKey} onChange={setRangeKey} size="small" />
            </div>
          </div>
          <Popover content={drugContent} title="用药叠加（勾选画入体温图）" trigger="click" placement="bottomRight">
            <Button size="small" data-testid="temp-drug-pop">用药叠加</Button>
          </Popover>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="shrink-0">低≥</span>
            <InputNumber data-testid="temp-th-low" size="small" step={0.1} value={th.low} onChange={(v) => setThVal('low', v)} onBlur={commitNow} onPressEnter={commitNow} style={{ width: 52 }} />
            <span className="shrink-0">高≥</span>
            <InputNumber data-testid="temp-th-high" size="small" step={0.1} value={th.high} onChange={(v) => setThVal('high', v)} onBlur={commitNow} onPressEnter={commitNow} style={{ width: 52 }} />
            <span className="text-slate-400">℃</span>
          </div>
        </div>

        {/* 记体温：常驻；编辑态显示「编辑体温」并带取消 */}
        <div className="card p-3 min-w-0">
          <div className="text-[11px] font-medium text-slate-500 mb-1.5">{editId ? '编辑体温' : '记体温'}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="flex items-center gap-1">
              <span className="field-label">体温 (℃)</span>
              <InputNumber size="small" step={0.1} min={TEMP_MIN} max={TEMP_MAX} autoFocus={!editId} placeholder="37.0" value={f.temp === '' ? null : Number(f.temp)} onChange={(v) => setF({ ...f, temp: v == null ? '' : String(v) })} onPressEnter={save} style={{ width: 72, textAlign: 'center' }} />
            </div>
            <div className="flex items-center gap-1">
              <span className="field-label">日期</span>
              <DateInput size="small" style={{ width: 140 }} value={f.date ? dayjs(f.date) : null} onChange={(d, ds) => setF({ ...f, date: ds })} allowClear={false} />
            </div>
            <div className="flex items-center gap-1">
              <span className="field-label">时刻</span>
              <TimePicker size="small" style={{ width: 104 }} value={f.time ? dayjs(`2000-01-01T${f.time}`) : null} onChange={(t, ts) => setF({ ...f, time: ts })} format="HH:mm" allowClear={false} />
            </div>
            <div className="flex items-center gap-1 min-w-[160px] flex-1">
              <span className="field-label">备注</span>
              <Input size="small" placeholder="如：贝林妥输注后 2h" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} onPressEnter={save} />
            </div>
            <Button type="primary" size="small" onClick={save} data-testid="temp-add-ok">确定</Button>
            {editId && <Button size="small" onClick={closeAdd} data-testid="temp-add-cancel">取消</Button>}
          </div>
        </div>

        {/* 右列：明细，顶到右上角并通到底（占满整列高度） */}
        <TempRecordList className="lg:col-start-4 lg:row-span-4" items={filtered} onEdit={handleEdit} onDelete={(id) => { deleteEvent(id); onNotify && onNotify('体温已删除') }} />

        {/* 左列下排：图表占 3 列 */}
        <div className="card p-2 scan-in min-h-0 flex flex-col lg:col-span-3 lg:row-span-3">
          <TempTrendChart
            events={events}
            thresholds={effectiveThresholds}
            ignoredDrugs={ignoredDrugs}
            onEdit={handleEdit}
            height="100%"
            range={range}
            dense
          />
        </div>
      </div>
    </div>
  )
}
