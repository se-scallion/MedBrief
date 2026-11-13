// ===================== 体温功能区（快捷录入 + 叠加趋势图） =====================
// 嵌在「指标」页（/cbc）残留病三维度之下（2026-10-27 从首页迁入）。体温事件走统一 events 模型（category:'temperature'），
// 写操作直达 store（addEvent/updateEvent/deleteEvent），store 变更经 useStore 全局广播刷新。
// 发烧阈值微调在体温详情页(/temperature)；本节只做快捷录入与趋势查看。
// 顶部一行：标题 + 体温输入 + 日期/时刻，容器 flex-wrap 自动换行（不用 JS 判断宽度）；
// 「展开/收起」只控制备注 div 的高度（max-h-0 ↔ 自适应 + overflow-hidden），其它元素原地不动。

import { useCallback, useMemo, useRef, useState } from 'react'
import DateInput from './DateInput.jsx'
import { useNavigate } from 'react-router-dom'
import { InputNumber, Input, Button, TimePicker } from 'antd'
import dayjs from 'dayjs'
import { addEvent, updateEvent, useStore } from '../data/store.js'
import { buildTempEvent, TEMP_MIN, TEMP_MAX, tempEventsOf } from '../utils/temperature.js'
import { tempToMarkdown, copyText } from '../utils/export.js'
import { saveFlip } from '../utils/flip.js'
import TempTrendChart from './TempTrendChart.jsx'

const pad2 = (n) => String(n).padStart(2, '0')
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
// 当前时刻（HH:mm），作为时间输入默认填充，免得用户手填
const nowTimeStr = () => {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export default function TempSection({ events, onNotify }) {
  const navigate = useNavigate()
  const cardRef = useRef(null)
  const state = useStore()
  // 点卡（标题/空白区）→ 缓存卡片 rect，放大进入 /temperature（FLIP 起点由管理页用 motion 反向播放）
  const goTemp = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return
    if (cardRef.current) saveFlip('temp', cardRef.current.getBoundingClientRect())
    navigate('/temperature')
  }
  // 引用必须稳定：直接写 `|| {}` / `|| []` 每次渲染都产生新对象/数组，
  // 会让图表 memo 失效、并让 courses/medSeries 连锁重算触发无谓更新
  const thresholds = useMemo(() => state.feverThresholds || { low: 37.3, high: 38.5 }, [state.feverThresholds])
  const ignoredDrugs = useMemo(() => state.tempIrrelevantDrugs || [], [state.tempIrrelevantDrugs])

  // 快捷录入表单：体温/日期/时刻常显；editId 非空 = 浮层「编」回填（编辑模式，强制展开备注）
  const [f, setF] = useState({ date: todayStr(), time: nowTimeStr(), temp: '', note: '' })
  const [editId, setEditId] = useState(null)
  const [showMore, setShowMore] = useState(false)
  const expanded = showMore || !!editId

  // 体温导出：升序体温事件
  const temps = useMemo(() => tempEventsOf(events), [events])

  const reset = () => {
    setF({ date: todayStr(), time: nowTimeStr(), temp: '', note: '' })
    setEditId(null)
    setShowMore(false)
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
    reset()
  }

  // 浮层「编」→ 回填本表单并强制展开备注（最简：浮层只留编·删，不内嵌第二套表单）
  // useCallback：引用稳定，配合图表 memo，避免父组件每次渲染都带动图表
  const handleEdit = useCallback((ev) => {
    setEditId(ev.id)
    setF({ date: ev.date, time: ev.time || '', temp: String(ev.temp), note: ev.note || '' })
    setShowMore(true)
  }, [])

  return (
    <section ref={cardRef} onClick={goTemp} className="card p-4 cursor-pointer hover:border-orange-300 transition-colors">
      {/* 顶部一行：左侧「标题 + 体温输入 + 日期/时刻」自己 flex-wrap 折行；右侧按钮组固定在同一行右端，不参与折行 */}
      <div className="flex items-start gap-3 mb-2.5">
        <div className="flex flex-1 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-slate-700">
            <span aria-hidden className="text-orange-500">🌡</span>
            <button type="button" className="inline-flex items-center gap-0.5 hover:text-orange-600 transition-colors">
              体温 (℃)<span aria-hidden className="text-orange-400">›</span>
            </button>
          </h3>
          {/* 录入字段：标签已并入标题，只留输入框（placeholder + aria-label 兜底无障碍） */}
          <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <InputNumber
              data-testid="temp-home-temp"
              size="small"
              step={0.1}
              min={TEMP_MIN}
              max={TEMP_MAX}
              autoFocus={!editId}
              placeholder="37.0"
              aria-label="体温(℃)"
              value={f.temp === '' ? null : Number(f.temp)}
              onChange={(v) => setF({ ...f, temp: v == null ? '' : String(v) })}
              onPressEnter={save}
              style={{ width: 72, textAlign: 'center' }}
            />
          </div>
          {/* 日期 / 时刻：常显、原地不动；左侧空间不足时它们整体折到下一行，按钮不受影响 */}
          <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <DateInput
              size="small"
              value={f.date ? dayjs(f.date) : null}
              onChange={(d, ds) => setF({ ...f, date: ds })}
              allowClear={false}
              style={{ width: 140 }}
            />
            <TimePicker
              size="small"
              value={f.time ? dayjs(`2000-01-01T${f.time}`) : null}
              onChange={(t, ts) => setF({ ...f, time: ts })}
              format="HH:mm"
              allowClear={false}
              style={{ width: 104 }}
            />
          </div>
        </div>
        {/* 操作按钮组：录入操作（添加/展开，或编辑态确定/取消）与复制横向一排；shrink-0 保证永不被挤走 */}
        <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {editId ? (
            <>
              <Button type="primary" size="small" onClick={save}>确定</Button>
              <Button size="small" onClick={reset}>取消</Button>
            </>
          ) : (
            <>
              <Button type="primary" size="small" data-testid="temp-home-add" onClick={save}>＋ 添加</Button>
              <Button size="small" data-testid="temp-home-more" onClick={() => setShowMore((v) => !v)}>
                {expanded ? '收起' : '展开'}
              </Button>
            </>
          )}
          {temps.length > 0 && (
            <Button
              size="small"
              onClick={async () => {
                const ok = await copyText(tempToMarkdown(temps, thresholds, state.patient_meta))
                if (ok) onNotify?.('已复制体温记录（Markdown）')
              }}
            >
              复制
            </Button>
          )}
        </div>
      </div>

      {/* 备注：只有这个 div 的高度受「展开/收起」控制（max-h-0 ↔ 有高度），overflow-hidden 保证收起干净 */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`overflow-hidden transition-[max-height] duration-200 ease-out ${expanded ? 'max-h-16' : 'max-h-0'}`}
      >
        <div className="flex items-center gap-2 pb-2.5">
          <span className="field-label">备注</span>
          <Input
            size="small"
            placeholder="如：贝林妥输注后 2h"
            value={f.note}
            onChange={(e) => setF({ ...f, note: e.target.value })}
            onPressEnter={save}
          />
        </div>
      </div>

      {/* 趋势图全宽；默认 hover 浮层显示「体温 + 当天用药剂量」。ignoredDrugs=体温图忽略的用药（新增药品默认不勾选）。
          图表区 stopPropagation：保留首页点击体温点弹「编/删」浮层，不被卡片跳转吞掉。 */}
      <div onClick={(e) => e.stopPropagation()}>
        <TempTrendChart
          events={events}
          thresholds={thresholds}
          ignoredDrugs={ignoredDrugs}
          onEdit={handleEdit}
        />
      </div>
    </section>
  )
}
