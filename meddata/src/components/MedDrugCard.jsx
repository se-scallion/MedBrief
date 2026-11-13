// ===================== 单个药的用药记录卡（剂量阶梯 + 分段/整体编辑） =====================
// 从 MedCoursesSection 抽出：一卡 = 一个药。分为两种宿主：
//   phased=false → 卡片代表该药的完整时间线（未建疗程时的旧行为，零回归）；
//   phased=true  → 卡片挂在某个疗程下：segments / entries 都是【本疗程内】的，全量时间线在 allEntries。
//
// 作用域纪律（Bug 219）——「展示用裁剪值，编辑用真实值」：
// 1) 卡头「编辑」= 编辑本疗程首段（editTarget 纯函数决定：首段若延续自上一疗程，则改为预填表单、
//    在本疗程首日新建一条改量记录，因为直接段编辑会改上游事件、连带改上一个疗程的显示）；
// 2) 段编辑框的 date/end/endTime 一律回填【事件自己的值】，seg.from/to 只用于 chip 展示 ——
//    否则「保存」会把疗程边界写死成事件的 end（甲钴胺 08-20 开放段在 贝林妥*8 卡上一点保存就变成 end=10-15）；
// 3) 药级动作（改整条记录 / 停药 / 恢复 / 删除）一律读 allEntries，且确认文案必须列出跨疗程的具体日期。

import { useRef, useState } from 'react'
import DateInput from './DateInput.jsx'
import dayjs from 'dayjs'
import {
  INFUSION_UNIT,
  MED_UNITS,
  buildMedEvent,
  courseEndDay,
  daysBetween,
  derivedEndOf,
  editTarget,
  fmtD,
  fmtDT,
  infusionDose,
  isDateStr,
  nextDay,
  normDrug,
  segmentEditForm,
  upsertTarget,
} from '../utils/medCourses.js'
import { addEvent, deleteEvent, updateEvent } from '../data/store.js'
import { dailyDrugCost, priceAt, stockFromSpec } from '../utils/cost.js'
import InfusionFields from './InfusionFields.jsx'

const ARROW = { up: '↑', down: '↓', flat: '=' }
const ARROW_COLOR = { up: 'text-slate-500', down: 'text-slate-500', flat: 'text-slate-400' }

// 取该段相对上一段的升降方向（跳过无剂量的旧记录段，与最近一个有剂量的段比）
function arrowOfPrev(segments, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (segments[j].dose != null) {
      const prev = segments[j].dose
      const cur = segments[i].dose
      if (cur == null) return null
      return { dir: cur > prev ? 'up' : cur < prev ? 'down' : 'flat' }
    }
  }
  return null
}

export default function MedDrugCard({ course, events, today, phased = false, onQuickDose, onNotify, prices = [] }) {
  const [editingId, setEditingId] = useState(null) // 正在编辑的某一段剂量
  const [editingSeg, setEditingSeg] = useState(null) // 该段在本疗程内的裁剪结果（只用于提示，不用于写库）
  const [editingCourse, setEditingCourse] = useState(null) // 正在编辑的整条用药记录（药级）
  const baseRef = useRef(null) // 段编辑的初始回填快照：与它相同的字段视为「用户没动」，一律沿用事件原值
  const [stockAuto, setStockAuto] = useState(false) // 原液浓度是否由药品管理规格自动带出（显示提示，可手改覆盖）
  // 当前生效价（含每包装规格）→ 由含量÷体积推导原液浓度（µg/mL），供输注表单自动带出
  const curPrice = priceAt(prices, course.drug, today)
  const suggestedStock = stockFromSpec(curPrice)
  const stockVal = suggestedStock != null ? Math.round(suggestedStock * 100) / 100 : null
  const pkgUnit = (curPrice && curPrice.pkgUnit) || ''
  const stockHint =
    curPrice && curPrice.volume ? `原液浓度来自药品管理：${curPrice.content}${curPrice.contentUnit}÷${curPrice.volume}ml≈${stockVal}（可手改）` : ''
  const [f, setF] = useState({
    date: '',
    end: '',
    time: '',
    endTime: '',
    drug: '',
    dose: '',
    unit: '',
    packs: '',
    note: '',
    infusion: { stock: '', draw: '', bag: '', rate: '' },
    infusionOn: false,
  })
  const EMPTY_F = {
    date: '',
    end: '',
    time: '',
    endTime: '',
    drug: '',
    dose: '',
    unit: '',
    packs: '',
    note: '',
    infusion: { stock: '', draw: '', bag: '', rate: '' },
    infusionOn: false,
  }

  // ★ 表单草稿区间（Bug 226）：编辑框里的「本段区间 / 推算支数 / 反推日均 / 天数」必须跟着**输入**走，
  // 不能读已保存的段（segments/editingSeg）——否则改完日期或输完日，这些派生值要等保存+刷新才更新，
  // 用户会误判「没保存成功」。
  const draftEnd = isDateStr(f.end) ? f.end : derivedEndOf(events, editingId, f.date)
  const draftDays = isDateStr(f.date) ? Math.max(1, daysBetween(f.date, draftEnd || today)) : null
  const draftRange = isDateStr(f.date) ? `${fmtDT(f.date, f.time, false)}~${draftEnd ? fmtDT(draftEnd, isDateStr(f.end) ? f.endTime : '', false) : '至今'}` : ''
  // 实耗支数提示：填了就按「实耗 × 单价」计费，并把反推的日均剂量显出来（只读，不改剂量）
  const manualPacks = Number(f.packs) > 0 ? Number(f.packs) : null
  const packsHint = (() => {
    if (manualPacks == null || !curPrice || f.infusionOn) return ''
    const days = draftDays
    const derived = dailyDrugCost({ dose: Number(f.dose), unit: f.unit }, curPrice)
    const derivedPacks = days && derived.tablets ? derived.tablets * days : null
    const backDose =
      days && Number(curPrice.content) > 0 && curPrice.contentUnit
        ? (manualPacks / days) * Number(curPrice.content)
        : null
    const fmt = (n) => String(Math.round(n * 100) / 100)
    return [
      `本段实耗 ${fmt(manualPacks)} ${pkgUnit} → 金额按 ${fmt(manualPacks)} × ${curPrice.price} 元计（不再用剂量推算）`,
      derivedPacks != null ? `剂量推算 ${fmt(derivedPacks)} ${pkgUnit}` : '',
      backDose != null ? `反推日均 ≈ ${fmt(backDose)}${curPrice.contentUnit}/日（仅提示，不改剂量）` : '',
    ]
      .filter(Boolean)
      .join('；')
  })()

  // 点分段 chip：只改这一段（日期 / 时刻 / 结束日期 / 输完时刻 / 剂量 / 单位 / 药名）。用药记录的起止不在这里改。
  const startEdit = (entry) => {
    setEditingId(entry.id)
    setEditingCourse(null)
    // 裁剪段只用于提示（本疗程内显示成哪个区间），绝不参与写库
    setEditingSeg(course.segments.find((x) => x.id === entry.id) || null)
    // 回填值一律取事件真值（口径见 medCourses.segmentEditForm，纯函数已单测）
    const { init, stockAuto: auto } = segmentEditForm(course, entry, { stockFallback: stockVal })
    setStockAuto(auto)
    setF(init)
    baseRef.current = { ...init, infusion: { ...init.infusion } }
  }

  // 药级动作的作用面：phased 卡上 course.entries 只有【本疗程内】的事件，全量在 allEntries（Bug 219）。
  // 任何改整条记录 / 停药 / 恢复 / 删除都必须走这里，不得再用 course.entries。
  const allEntries = course.allEntries || course.entries || []
  const inRange = (e) => !course.range || (e.date >= course.range.start && (!course.range.end || e.date <= course.range.end))
  const splitByRange = (list) => ({ inside: list.filter(inRange), outside: list.filter((e) => !inRange(e)) })
  const entryBrief = (e) => `${fmtD(e.date)}${e.stop ? ' 停药' : e.dose != null ? '=' + e.dose + (e.unit || '') : ''}`

  // 点卡片头「编辑」：编辑整条用药记录（药名 / 开始日 / 首段剂量 / 是否停药 + 最后服药日）。
  // 「何时停」只有这一个入口，内部统一换算成「最后服药日的次日」的停药事件。
  // ★ 药级动作：作用面 = 该药全部事件（allEntries），与「段编辑」严格区分。
  const startEditCourse = () => {
    const byDate = (a, b) => String(a.date || '').localeCompare(String(b.date || ''))
    const doses = allEntries.filter((e) => e.stop !== true).sort(byDate)
    const first = doses[0] || allEntries.slice().sort(byDate)[0]
    const stopEv = allEntries.find((e) => e.stop === true)
    setEditingId(null)
    setEditingCourse({
      key: course.key,
      drug: (first && (first.drug || first.text)) || course.key,
      start: (first && first.date) || course.start,
      dose: first && first.dose != null ? String(first.dose) : '',
      unit: (first && first.unit) || course.lastUnit || '',
      doseId: first && first.id,
      color: course.color,
      stopped: !!stopEv,
      lastDay: stopEv ? dayjs(stopEv.date).subtract(1, 'day').format('YYYY-MM-DD') : '',
    })
  }

  // 段编辑保存。口径：**没被用户改动的字段一律沿用事件原值**（与回填快照 baseRef 比对），
  // 杜绝「回填 → 保存 → 把裁剪/推导值沉淀成事实」这一类数据污染（Bug 219）。
  const saveEdit = () => {
    const key = normDrug(f.drug)
    if (!f.date || !key) return
    const prev = events.find((e) => e.id === editingId)
    const b = baseRef.current || {}
    const keep = (k) => b[k] !== undefined && String(f[k] ?? '') === String(b[k] ?? '')

    // 持续输注：由参数折算每日剂量（写进 dose），参数另存 infusion 供下次编辑回填。
    // 参数没动 → 沿用原 dose，避免浮点重算把 26 变成 25.99。
    const infTouched =
      !!f.infusionOn &&
      ['stock', 'draw', 'bag', 'rate'].some((k) => String((f.infusion || {})[k] ?? '') !== String((b.infusion || {})[k] ?? ''))
    let n
    if (f.infusionOn) {
      const inf = infusionDose(f.infusion)
      if (!inf) return
      n = prev && prev.infusion && !infTouched ? prev.dose : inf.daily
    } else {
      n = Number(f.dose)
      if (f.dose !== '' && (!Number.isFinite(n) || n < 0)) return
    }
    const hasDose = f.infusionOn ? true : f.dose !== '' && Number.isFinite(n) && n >= 0

    // 结束日：没动过就沿用事件原值（原值为空 = 推导，绝不再算一次写成显式 end）
    let end = ''
    let endTime = ''
    if (keep('end') && keep('endTime')) {
      end = (prev && prev.end) || ''
      endTime = (prev && prev.endTime) || ''
    } else {
      // 走到这里 = 用户动过「输完日/输完时刻」（未动的话上面 keep 分支已沿用原值），故一律落库：
      // 旧代码在「填的值恰好等于下一条记录的推导值」时把它丢掉不存（本意是防派生值沉淀），
      // 但回填早已改成事件真值（Bug 219），这条抑制只剩副作用——手填值在后续增删记录后静默消失。
      // 唯一保留的防御：早于本段生效日（非法区间）不落库。
      const endExplicit = isDateStr(f.end) && f.end >= f.date
      end = endExplicit ? f.end : ''
      endTime = endExplicit ? f.endTime : ''
    }

    const unit = keep('unit') ? ((prev && prev.unit) || '') : f.unit
    const drug = keep('drug') ? (prev && prev.drug) || key : key
    const time = keep('time') ? (prev && prev.time) || '' : f.time || ''
    const infusion = f.infusionOn ? (prev && prev.infusion && !infTouched ? prev.infusion : f.infusion) : null
    // 实耗包装数（财务口径真值）：没动过 → 不动原值（undefined 交给浅合并保留）；动过 → 有值设定 / 清空置 null
    const packs = keep('packs')
      ? undefined
      : Number(f.packs) > 0
        ? Number(f.packs)
        : null

    let note = keep('note') ? prev && prev.note : f.note
    if (!note && prev && !prev.drug && prev.text && normDrug(prev.text) !== key) note = prev.text

    updateEvent(editingId, {
      ...buildMedEvent({
        date: f.date,
        drug,
        dose: hasDose ? n : null,
        unit: f.infusionOn ? INFUSION_UNIT : hasDose ? unit : '',
        end,
        endTime,
        time,
        infusion,
        packs,
        color: prev && prev.color,
      }),
      // buildMedEvent 不写空 time（浅合并下清不掉），这里显式清
      ...(time ? {} : { time: '' }),
      note,
    })
    setEditingId(null)
    setEditingSeg(null)
    baseRef.current = null
    setF(EMPTY_F)
    // 回执回显「到底存了什么」：用户不必再靠刷新去猜（Bug 226 的直接诱因之一）
    const effPacks = packs !== undefined ? packs : (prev && prev.packs) || null
    onNotify &&
      onNotify(
        `已保存：${fmtDT(f.date, time)} 起 ${hasDose ? `${n}${f.infusionOn ? INFUSION_UNIT : unit}/日` : '（无剂量）'}` +
          `${end ? `，输完 ${fmtD(end)}${endTime ? ' ' + endTime : ''}` : '，结束日按下一条推导'}` +
          `${Number(effPacks) > 0 ? `，实耗 ${effPacks}${pkgUnit}` : ''}`
      )
  }

  const saveCourseEdit = () => {
    const c = editingCourse
    if (!c) return
    const key = normDrug(c.drug)
    if (!c.start || !key) return
    const n = Number(c.dose)
    const hasDose = c.dose !== '' && Number.isFinite(n) && n >= 0
    if (c.dose !== '' && !hasDose) return
    const mine = events.filter((e) => (e.drug && normDrug(e.drug) === c.key) || (!e.drug && String(e.text || '').includes(c.key)))
    if (c.doseId) {
      const prev = events.find((e) => e.id === c.doseId)
      updateEvent(c.doseId, {
        ...buildMedEvent({ date: c.start, drug: key, dose: hasDose ? n : null, unit: hasDose ? c.unit : '', end: prev && prev.end, endTime: prev && prev.endTime, packs: prev && prev.packs, color: prev && prev.color }),
        note: prev && prev.note,
      })
    }
    if (normDrug(c.key) !== key) {
      mine
        .filter((e) => e.id !== c.doseId)
        .forEach((e) => {
          updateEvent(e.id, { ...buildMedEvent({ date: e.date, drug: key, dose: e.dose != null ? e.dose : null, unit: e.unit || '', end: e.end, endTime: e.endTime, packs: e.packs, stop: e.stop === true, color: e.color }), note: e.note })
        })
    }
    const stops = mine.filter((e) => e.stop === true)
    if (c.stopped && c.lastDay) {
      const sd = nextDay(c.lastDay)
      const payload = buildMedEvent({ date: sd, drug: key, stop: true, color: c.color })
      if (stops[0]) updateEvent(stops[0].id, payload)
      else addEvent(payload)
      stops.slice(1).forEach((e) => deleteEvent(e.id))
    } else {
      stops.forEach((e) => deleteEvent(e.id))
    }
    setEditingCourse(null)
    onNotify && onNotify(
      c.stopped && c.lastDay ? `${key} 已记为 ${fmtD(c.start)}~${fmtD(c.lastDay)} 的用药记录` : `${key} 已更新（进行中，自 ${fmtD(c.start)} 起）`
    )
  }

  // 记停药：默认今天，可在卡片头选择历史停药日期；同药同日唯一（命中则覆盖）
  const stopCourse = (sd = today) => {
    const hit = upsertTarget(events, { date: sd, key: course.key })
    const payload = buildMedEvent({ date: sd, drug: course.key, stop: true, color: course.color })
    if (hit) updateEvent(hit.id, payload)
    else addEvent(payload)
    onNotify && onNotify(`已记录：${course.drug} 自 ${fmtD(sd)} 停药`)
  }

  // 恢复进行中（Bug 080）：把「已停药」翻回来的直达入口——删掉停药事件即可，
  // 不必进「编辑」表单去取消勾选，也不受分段 chip 无法表达「至今」的限制。
  const resumeCourse = () => {
    const stops = allEntries.filter((e) => e.stop === true)
    if (!stops.length) return
    stops.forEach((e) => deleteEvent(e.id))
    onNotify && onNotify(`${course.drug} 已恢复为进行中`)
  }

  const deleteCourse = () => {
    const { inside, outside } = splitByRange(allEntries)
    // 药级删除：必须让用户看见「跨疗程」的具体日期，否则在 贝林妥*12 卡上删除会连 贝林妥*8 的记录一起没（Bug 219）
    const lines = [
      `删除「${course.drug}」的全部 ${allEntries.length} 条用药记录？此操作不可撤销。`,
      inside.length ? `本疗程内：${inside.map(entryBrief).join('、')}` : '',
      outside.length ? `本疗程外（会被一并删除）：${outside.map(entryBrief).join('、')}` : '',
    ]
    if (!window.confirm(lines.filter(Boolean).join('\n'))) return
    allEntries.forEach((e) => deleteEvent(e.id))
    onNotify && onNotify(`已删除 ${course.drug} 的 ${allEntries.length} 条用药记录`)
  }

  // 卡头区间：按疗程分组时只显示本疗程内的跨度，否则显示完整时间线
  const rangeText = () => {
    if (phased) {
      const segs = course.segments
      const from = segs[0].from
      const last = segs[segs.length - 1]
      return `${fmtD(from)} ~ ${last.to ? fmtD(last.to) : '至今'}`
    }
    if (course.status === 'stopped') {
      const end = courseEndDay(course, today)
      const shown = end < course.start ? course.start : end
      const y = String(course.start).slice(0, 4) !== String(shown).slice(0, 4)
      return `${fmtD(course.start, y)}~${fmtD(shown, y)} 停`
    }
    const y = String(course.start).slice(0, 4) !== String(today).slice(0, 4)
    return `${fmtD(course.start, y)} 起`
  }

  // 分段区间文本（带时刻则显示「MM-DD HH:mm」；跨年时才显示年份）
  const rangeOf = (s) => {
    const y = String(s.from).slice(0, 4) !== String(s.to || today).slice(0, 4)
    return `${fmtDT(s.from, s.fromTime, y)}~${s.to ? fmtDT(s.to, s.toTime, y) : '至今'}`
  }

  // 卡头「编辑」= 本疗程首次用药那一段的编辑；作用域由纯函数决定（见 medCourses.editTarget）：
  // 首段起于本疗程内 → 直接段编辑；首段延续自上一疗程 → 预填表单在疗程首日新建（不动上游事件）。
  const editTargetInfo = editTarget({ phased, range: course.range, segments: course.segments })
  const editTitle =
    editTargetInfo.mode === 'newFromRangeStart'
      ? `本段延续自上一疗程（起于 ${course.segments[0].entry.date}）：直接改会连带改上一疗程，故改为新建「${fmtD(course.range.start)} 起」的改量记录`
      : editTargetInfo.mode === 'segment'
        ? `编辑本疗程首次用药那一段：${course.segments[0].from} 起（只改这一段）`
        : '编辑整条用药记录：药名 / 开始日期 / 剂量 / 是否停药与最后服药日'
  const onEditClick = () => {
    if (editTargetInfo.mode === 'course') return startEditCourse()
    if (editTargetInfo.mode === 'segment') {
      const seg = course.segments.find((s) => s.id === editTargetInfo.entryId)
      if (seg) startEdit(seg.entry)
      return
    }
    if (editTargetInfo.mode === 'newFromRangeStart') {
      const p = editTargetInfo.prefill
      onQuickDose && onQuickDose({ drug: course.key, date: p.date, dose: p.dose, unit: p.unit })
      onNotify && onNotify(`已回填 ${fmtD(p.date)} 起 ${p.dose ?? ''}${p.unit || ''}/日，确认后提交`)
    }
  }

  return (
    <div className="card p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13px] font-semibold text-slate-800">{course.drug}</span>
        <span
          className={`rounded-full px-1.5 py-px text-[10px] font-medium ${
            course.status === 'ongoing' ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-500'
          }`}
        >
          {course.status === 'ongoing' ? '进行中' : '已停药'}
        </span>
        <span className="text-[11px] text-slate-400">{rangeText()}</span>
        <div className="ml-auto flex items-center gap-2.5 text-[11px]">
          <button
            type="button"
            className="text-slate-600 hover:underline cursor-pointer"
            title="快速记录该药今日新剂量：回填药名到上方表单"
            onClick={() => onQuickDose && onQuickDose(course.key)}
          >
            ＋记改量
          </button>
          <button type="button" className="text-slate-600 hover:underline cursor-pointer" title={editTitle} onClick={onEditClick}>
            编辑
          </button>
          {phased && (
            <button
              type="button"
              className="text-slate-600 hover:underline cursor-pointer"
              title={`编辑「${course.drug}」整条记录（${allEntries.length} 条，跨全部疗程）：药名 / 开始日 / 历史停药日`}
              onClick={startEditCourse}
            >
              全时间线
            </button>
          )}
          {course.status === 'ongoing' && (
            <button
              type="button"
              className="text-slate-500 hover:underline cursor-pointer"
              title={phased ? '快速记为今天停药；要记历史停药日期请用「全时间线」' : '快速记为今天停药；要记历史停药日期请用「编辑」'}
              onClick={() => stopCourse(today)}
            >
              今日停药
            </button>
          )}
          {course.status === 'stopped' && (
            <button
              type="button"
              className="text-slate-600 hover:underline cursor-pointer"
              title="删掉停药记录，恢复为进行中（不必进编辑表单）"
              onClick={resumeCourse}
            >
              恢复进行中
            </button>
          )}
          <button
            type="button"
            className="text-slate-400 hover:text-red-600 cursor-pointer"
            title={`删除全部 ${allEntries.length} 条记录（跨全部疗程）`}
            onClick={deleteCourse}
          >
            删除
          </button>
        </div>
      </div>

      {/* 分段明细：一行 chip（剂量 + 区间），点击进编辑；进行中的末段用底色区分 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {course.segments.map((s, i) => {
          const entry = s.entry
          const arrow = i === 0 ? null : arrowOfPrev(course.segments, i)
          if (editingId === entry.id) {
            return (
              <div key={entry.id} className="card bg-slate-50 p-2 w-full">
                <div className="flex flex-wrap gap-2 items-end">
                  <div>
                    <label className="label">日期</label>
                    <DateInput
                      className="w-36"
                      value={f.date ? dayjs(f.date) : null}
                      onChange={(d) => setF({ ...f, date: d ? d.format('YYYY-MM-DD') : '' })}
                      allowClear={false}
                    />
                  </div>
                  <div>
                    <label className="label">时刻</label>
                    <input
                      className="input w-28"
                      type="time"
                      value={f.time}
                      onChange={(e) => setF({ ...f, time: e.target.value })}
                      title="可选：精确到小时。持续输注记录浓度升档的时刻"
                    />
                  </div>
                  <div>
                    <label className="label">输完日</label>
                    <DateInput
                      className="w-36"
                      value={f.end ? dayjs(f.end) : null}
                      onChange={(d) => setF({ ...f, end: d ? d.format('YYYY-MM-DD') : '' })}
                      allowClear
                      placeholder="留空=推导"
                    />
                  </div>
                  <div>
                    <label className="label">输完时刻</label>
                    <input
                      className="input w-28"
                      type="time"
                      value={f.endTime}
                      onChange={(e) => setF({ ...f, endTime: e.target.value })}
                      disabled={!f.end}
                      title="可选：本袋输完的时刻"
                    />
                  </div>
                  <div className="min-w-[120px] flex-1">
                    <label className="label">药名</label>
                    <input className="input" value={f.drug} onChange={(e) => setF({ ...f, drug: e.target.value })} />
                  </div>
                  <div className="w-24">
                    <label className="label">实耗（{pkgUnit || '支'}）</label>
                    <input
                      className="input text-center"
                      type="number"
                      min="0"
                      step="any"
                      value={f.packs}
                      placeholder="留空=推算"
                      title="本段实际用掉的整支/整只数（药房出库口径）。填了就用它 × 单价算钱；留空则按「剂量 × 天数 ÷ 含量」推算"
                      onChange={(e) => setF({ ...f, packs: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                    />
                  </div>
                  {packsHint && <p className="w-full text-[11px] text-slate-500">{packsHint}</p>}
                  {!f.infusionOn && (
                    <>
                      <div className="w-24">
                        <label className="label">剂量</label>
                        <input
                          className="input text-center"
                          type="number"
                          min="0"
                          step="any"
                          value={f.dose}
                          autoFocus
                          onChange={(e) => setF({ ...f, dose: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                        />
                      </div>
                      <div className="w-24">
                        <label className="label">单位</label>
                        <input
                          className="input"
                          list="med-edit-units"
                          value={f.unit}
                          onChange={(e) => setF({ ...f, unit: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                        />
                        <datalist id="med-edit-units">
                          {MED_UNITS.map((u) => (
                            <option key={u} value={u} />
                          ))}
                        </datalist>
                      </div>
                    </>
                  )}
                  <label
                    className="flex items-center gap-1.5 text-xs text-slate-600 pb-2 cursor-pointer"
                    title="连续输注类药：按配液与速率自动折算每日剂量"
                  >
                    <input
                      type="checkbox"
                      checked={f.infusionOn}
                      onChange={(e) => {
                        const on = e.target.checked
                        if (on && (!f.infusion.stock || f.infusion.stock === '') && stockVal != null) {
                          setF({ ...f, infusionOn: true, infusion: { ...f.infusion, stock: String(stockVal) } })
                          setStockAuto(true)
                        } else {
                          setF({ ...f, infusionOn: on })
                          if (!on) setStockAuto(false)
                        }
                      }}
                    />
                    持续输注
                  </label>
                  {f.infusionOn && (
                    <InfusionFields
                      value={f.infusion}
                      hint={stockAuto ? stockHint : ''}
                      onChange={(v) => {
                        setF({ ...f, infusion: v })
                        if ('stock' in v) setStockAuto(false)
                      }}
                    />
                  )}
                  <div className="min-w-[180px] flex-1">
                    <label className="label">备注</label>
                    <input
                      className="input"
                      value={f.note}
                      placeholder="如：0.51ml + 稳定剂1.68ml"
                      onChange={(e) => setF({ ...f, note: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                    />
                  </div>
                  <p className="w-full text-[11px] text-slate-400">
                    本段区间 {draftRange}：可填「输完日 / 输完时刻」手动截止本段（精确到小时）；留空则按下一条记录生效时刻推导。连续输注（如贝林妥）两段在边界时刻自然衔接，不自动停药。
                  </p>
                  {entry.date !== s.from && (
                    <p className="w-full text-[11px] text-amber-500">
                      本段起于 {fmtD(entry.date)}（上一疗程），本疗程从 {fmtD(s.from)} 起显示；改动会同步影响上一疗程。
                    </p>
                  )}
                  {String(s.to || '') !== String(entry.end || '') && (
                    <p className="w-full text-[11px] text-slate-400">
                      结束日：{entry.end ? fmtD(entry.end) : '未设（按下一条记录推导）'}；本疗程内显示到 {s.to ? fmtD(s.to) : '至今'}。
                    </p>
                  )}
                  <div className="flex gap-2 pb-0.5">
                    <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={saveEdit}>
                      保存
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-white transition-colors"
                      onClick={() => {
                        setEditingId(null)
                        setEditingSeg(null)
                        baseRef.current = null
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-400 hover:border-red-200 hover:text-red-600 transition-colors"
                      onClick={() => {
                        deleteEvent(editingId)
                        setEditingId(null)
                        setEditingSeg(null)
                        baseRef.current = null
                        onNotify && onNotify('已删除该条用药记录')
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            )
          }
          const ongoing = s.to === null && course.status === 'ongoing'
          return (
            <button
              key={entry.id}
              type="button"
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] cursor-pointer transition-colors ${
                ongoing ? 'bg-slate-100 text-slate-700 hover:bg-slate-200' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
              }`}
              onClick={() => startEdit(entry)}
              title={`${s.dose != null ? `${s.dose}${s.unit}/日` : '未记录剂量'} · 点击编辑`}
            >
              <span className={arrow ? ARROW_COLOR[arrow.dir] : 'text-slate-300'}>{arrow ? ARROW[arrow.dir] : '·'}</span>
              {s.dose != null && <span className="font-medium">{s.dose}{s.unit}/日</span>}
              <span className="font-mono text-[10px] text-slate-400">{rangeOf(s)}</span>
              {entry.note && <span className="text-[10px] text-slate-500">· {entry.note}</span>}
            </button>
          )
        })}
      </div>

      {/* 整条用药记录编辑：药名 / 开始 / 剂量 / 是否停药 + 最后服药日 */}
      {editingCourse && (
        <div className="card bg-slate-50 p-2 mt-1.5 w-full">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="min-w-[120px] flex-1">
              <label className="label">药名</label>
              <input className="input" value={editingCourse.drug} onChange={(e) => setEditingCourse({ ...editingCourse, drug: e.target.value })} />
            </div>
            <div>
              <label className="label">开始日期</label>
              <DateInput
                className="w-36"
                value={editingCourse.start ? dayjs(editingCourse.start) : null}
                onChange={(d) => setEditingCourse({ ...editingCourse, start: d ? d.format('YYYY-MM-DD') : '' })}
                allowClear={false}
              />
            </div>
            <div className="w-24">
              <label className="label">剂量</label>
              <input
                className="input text-center"
                type="number"
                min="0"
                step="any"
                value={editingCourse.dose}
                onChange={(e) => setEditingCourse({ ...editingCourse, dose: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && saveCourseEdit()}
              />
            </div>
            <div className="w-24">
              <label className="label">单位</label>
              <input
                className="input"
                list="med-course-units"
                value={editingCourse.unit}
                onChange={(e) => setEditingCourse({ ...editingCourse, unit: e.target.value })}
              />
              <datalist id="med-course-units">
                {MED_UNITS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={editingCourse.stopped}
                onChange={(e) =>
                  setEditingCourse({ ...editingCourse, stopped: e.target.checked, lastDay: e.target.checked ? editingCourse.lastDay || today : '' })
                }
              />
              已停药
            </label>
            {editingCourse.stopped && (
              <div>
                <label className="label">最后服药日</label>
                <DateInput
                  className="w-36"
                  value={editingCourse.lastDay ? dayjs(editingCourse.lastDay) : null}
                  onChange={(d) => setEditingCourse({ ...editingCourse, lastDay: d ? d.format('YYYY-MM-DD') : '' })}
                  allowClear={false}
                />
              </div>
            )}
            <div className="flex gap-2 pb-0.5">
              <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={saveCourseEdit}>
                保存
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-white transition-colors"
                onClick={() => setEditingCourse(null)}
              >
                取消
              </button>
            </div>
          </div>
          <p className="mt-1 w-full text-[11px] text-slate-400">
            {editingCourse.stopped
              ? `用药记录显示到「最后服药日」${editingCourse.lastDay ? fmtD(editingCourse.lastDay) : '未填'}（内部记为其次日停药）。`
              : '不勾「已停药」= 进行中。记历史停药请勾上并选最后服药日。'}
          </p>
        </div>
      )}
    </div>
  )
}
