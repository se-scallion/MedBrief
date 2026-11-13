// ===================== 用药快速录入（改量事件式） =====================
// 一条记录 =「自 X 日起，药 Y 每日剂量改为 Z」。同药事件由 medCourses 自动聚合成疗程阶梯，
// 这里只管「录入极简」：药名联想（隐式登记，来自已有事件）+ 单位继承 + 停药模式 + 同药同日 upsert。
// 典型路径：点「最近用药」chip → 改剂量数字 → 回车，两次点击完成一次改量。

import { useEffect, useMemo, useRef, useState } from 'react'
import DateInput from './DateInput.jsx'
import dayjs from 'dayjs'
import { INFUSION_UNIT, MED_UNITS, buildMedEvent, doseSubmitPayload, drugRoster, fmtD, infusionDose, localToday, normDrug, upsertTarget } from '../utils/medCourses.js'
import { addEvent, updateEvent } from '../data/store.js'
import InfusionFields from './InfusionFields.jsx'

export default function MedDoseForm({ events, prefill, onSaved }) {
  const [date, setDate] = useState(localToday)
  const [time, setTime] = useState('') // 可选：时刻(HH:mm)，精度升级到小时（如持续输注的浓度升档点）
  const [end, setEnd] = useState('') // 可选：输完日 → 本袋/本段输到的日期（不与「停药」绑定）
  const [endTime, setEndTime] = useState('') // 可选：输完时刻(HH:mm)
  const [drug, setDrug] = useState('')
  const [dose, setDose] = useState('')
  const [unit, setUnit] = useState('')
  const [mode, setMode] = useState('dose') // 'dose' | 'stop'
  // 持续输注：勾选后才展开配液参数（口服药表单完全不变）
  const [infusionOn, setInfusionOn] = useState(false)
  const [infusion, setInfusion] = useState({ stock: '', draw: '', bag: '', rate: '' })
  const doseRef = useRef(null)
  const rootRef = useRef(null) // 表单根节点：回填后滚到可见处

  // 药名候选：由已记录的事件派生（隐式登记，零新增存储），含每药最近单位与当前剂量
  const roster = useMemo(() => drugRoster(events), [events])
  const hit = useMemo(() => upsertTarget(events, { date, key: normDrug(drug) }), [events, date, drug])

  // 选中/输入已有药名 → 自动带出该药最近使用的单位
  const pickDrug = (name) => {
    const key = normDrug(name)
    setDrug(key)
    const found = roster.find((r) => r.key === key)
    if (found && found.lastUnit) setUnit(found.lastUnit)
  }

  // 阶梯卡上点「＋记改量」/ 卡头「编辑」（首段延续自上一疗程时）→ 回填药名，可带日期/剂量/单位，并聚焦剂量框。
  // prefill 协议：字符串 = 仅药名；对象 = { drug, date?, dose?, unit? }（date 用于「疗程首日新建改量」）
  useEffect(() => {
    if (!prefill) return
    pickDrug(prefill.drug || prefill)
    setMode('dose')
    if (prefill.date) setDate(prefill.date)
    if (prefill.dose != null && prefill.dose !== '') setDose(String(prefill.dose))
    if (prefill.unit) setUnit(prefill.unit)
    // 表单在疗程列表上方：回填后滚到可见处，否则用户点了卡上的按钮却看不到填好的表单
    rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    doseRef.current?.focus()
    doseRef.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill])

  const reset = () => {
    setDose('')
    setMode('dose')
    setEnd('')
    setTime('')
    setEndTime('')
  }

  const submit = () => {
    if (!date) return
    const key = normDrug(drug)
    if (!key) return
    // 停药模式：自该日起停用。结束日期仅剂量模式支持，故停药模式忽略结束日期，避免「按了没反应」
    if (mode === 'stop') {
      const hit = upsertTarget(events, { date, key, time })
      const payload = buildMedEvent({ date, drug: key, stop: true, time, ...(hit ? { color: hit.color } : {}) })
      if (hit) updateEvent(hit.id, payload)
      else addEvent(payload)
      onSaved?.(hit ? `已更新 ${fmtD(date)} 的用药记录：${key} 停药` : `已记录 ${fmtD(date)} 起：${key} 停药`)
      reset()
      doseRef.current?.focus()
      return
    }
    // 持续输注：由四项参数折算每日剂量（写进 dose），参数另存 infusion 供编辑回填
    const inf = infusionOn ? infusionDose(infusion) : null
    if (infusionOn && !inf) return
    const d = inf ? inf.daily : Number(dose)
    if (!inf && (dose === '' || !Number.isFinite(d) || d < 0)) return
    // 输完日：仅作为本袋/本段的结束日落到单条事件上，不自动生成停药事件——
    // 「输完」与「停药」已解耦，连续多袋在边界日自然衔接、不会被迫隔天或误停产。
    // 覆盖命中同一条记录且未填输完日时，沿用原记录的输完日（改剂量不该把结束日抹掉）。
    const isRange = !!end && end >= date
    const { hit, payload } = doseSubmitPayload(events, {
      date,
      time,
      drug: key,
      dose: d,
      unit: inf ? INFUSION_UNIT : unit,
      end,
      endTime,
      infusion: inf ? infusion : null,
    })
    if (hit) updateEvent(hit.id, payload)
    else addEvent(payload)
    const label = `${key} ${d}${unit || ''}/日`
    onSaved?.(
      isRange
        ? `已记录 ${fmtD(date)}${time ? ' ' + time : ''} 起、输完于 ${fmtD(end)}${endTime ? ' ' + endTime : ''}：${label}（分段持续，不停药）`
        : hit
        ? `已更新 ${fmtD(date)}${time ? ' ' + time : ''} 的用药记录：${label}`
        : `已记录 ${fmtD(date)}${time ? ' ' + time : ''} 起：${label}`
    )
    reset()
    doseRef.current?.focus()
  }

  const canSubmit =
    !!date &&
    !!normDrug(drug) &&
    (mode === 'stop' ||
      (infusionOn
        ? !!infusionDose(infusion)
        : dose !== '' && Number.isFinite(Number(dose)) && Number(dose) >= 0)) &&
    (mode === 'stop' || !end || end >= date)

  return (
    <div className="flex-1 min-w-[260px]" ref={rootRef}>
      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="label">开始日期</label>
          <DateInput
            className="w-36"
            value={date ? dayjs(date) : null}
            onChange={(d) => setDate(d ? d.format('YYYY-MM-DD') : '')}
            placeholder="选择日期"
            allowClear={false}
          />
        </div>
        <div>
          <label className="label">时刻</label>
          <input
            className="input w-28"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            title="可选：精确到小时。持续输注记录每次浓度升档的时刻"
          />
        </div>
        <div>
          <label className="label">输完日(可选)</label>
          <DateInput
            className="w-36"
            value={end ? dayjs(end) : null}
            onChange={(d) => setEnd(d ? d.format('YYYY-MM-DD') : '')}
            placeholder="本袋输完日"
            disabled={mode === 'stop'}
            allowClear={{ clearIcon: <span title="清除输完日">×</span> }}
          />
        </div>
        {end && (
          <div>
            <label className="label">输完时刻</label>
            <input
              className="input w-28"
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              disabled={mode === 'stop'}
              title="可选：本袋输完的时刻"
            />
          </div>
        )}
        <div className="min-w-[120px] flex-1">
          <label className="label">药名</label>
          <input
            className="input"
            list="med-drug-candidates"
            value={drug}
            placeholder="如：泊那替尼"
            onChange={(e) => pickDrug(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <datalist id="med-drug-candidates">
            {roster.map((r) => (
              <option key={r.key} value={r.key} />
            ))}
          </datalist>
        </div>
        {mode === 'dose' && !infusionOn ? (
          <>
            <div className="w-24">
              <label className="label">剂量</label>
              <input
                ref={doseRef}
                className="input text-center"
                type="number"
                min="0"
                step="any"
                value={dose}
                placeholder="45"
                onChange={(e) => setDose(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>
            <div className="w-24">
              <label className="label">单位</label>
              <input
                className="input"
                list="med-unit-candidates"
                value={unit}
                placeholder="mg"
                onChange={(e) => setUnit(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
              <datalist id="med-unit-candidates">
                {MED_UNITS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </div>
          </>
        ) : mode === 'stop' ? (
          <div className="flex-1 min-w-[160px]">
            <label className="label">停药</label>
            <div
              className="h-[38px] flex items-center text-xs text-slate-500"
              title="自该日起停用；上一段剂量截止到该日的前一天"
            >
              自该日起停用
            </div>
          </div>
        ) : null}
        <div>
          <label className="label">类型</label>
          <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
            <button
              type="button"
              className={`px-3 py-2 text-xs font-medium transition-colors ${
                mode === 'dose' ? 'bg-brand-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
              onClick={() => setMode('dose')}
            >
              记剂量
            </button>
            <button
              type="button"
              className={`px-3 py-2 text-xs font-medium border-l border-slate-300 transition-colors ${
                mode === 'stop' ? 'bg-brand-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
              title="自该日起停用；上一段剂量截止到该日的前一天（切到停药会清空已选的结束日期）"
              onClick={() => { setMode('stop'); setEnd('') }}
            >
              停药
            </button>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-2 cursor-pointer" title="连续输注类药（如贝林妥）：按配液与速率自动折算每日剂量">
          <input type="checkbox" checked={infusionOn} disabled={mode === 'stop'} onChange={(e) => setInfusionOn(e.target.checked)} />
          持续输注
        </label>
        {mode === 'dose' && infusionOn && <InfusionFields value={infusion} onChange={setInfusion} />}
        {end && (
          <p className="mt-1 text-[11px] text-slate-400">
            已选输完日 {fmtD(end)}{endTime ? ' ' + endTime : ''}：本袋/本段输到这一天（时刻），药是否停由「停药」单独控制，不会自动停产。
          </p>
        )}
        <button
          type="button"
          className="btn-primary cursor-pointer disabled:cursor-not-allowed"
          disabled={!canSubmit}
          onClick={submit}
          title={hit ? '该药该日已有记录，提交将覆盖为本次填写的剂量' : '记录：自该日起按此剂量服用'}
        >
          {hit ? `更新 ${fmtD(date)} 记录` : '＋ 新增剂量'}
        </button>
        {!hit && normDrug(drug) && roster.some((r) => r.key === normDrug(drug)) && (
          <p className="w-full text-[11px] text-amber-500">
            该药已有记录：提交会【新增】一段（{fmtD(date)} 起）；要改已有记录请点用药卡片里的「编辑当前剂量」或下方分段。
          </p>
        )}
      </div>

      {roster.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-400">最近用药</span>
          {roster.slice(0, 6).map((r) => (
            <button
              key={r.key}
              type="button"
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                r.stopped
                  ? 'border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100'
                  : 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
              }`}
              title={`${r.key} · ${r.count} 条记录${r.current ? ` · 当前 ${r.current.dose}${r.current.unit}/日` : ''}`}
              onClick={() => {
                pickDrug(r.key)
                setMode('dose')
                if (r.current && r.current.dose != null) setDose(String(r.current.dose))
                doseRef.current?.focus()
                doseRef.current?.select()
              }}
            >
              {r.key}
              {r.current ? ` ${r.current.dose}${r.current.unit}/日` : ''}
              {r.stopped ? ' · 已停' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
