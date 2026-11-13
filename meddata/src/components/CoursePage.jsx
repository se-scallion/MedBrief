// ===================== 疗程页（/course）：治疗时间线 =====================
// 全站唯一的「疗程」概念 = 治疗阶段（诱导 / 巩固 / 维持）。本页管「这段时间做了什么」：
// 用药录入 / 输血录入 / 疗程卡（卡内：用药阶梯 · 输血 · 住院分摊 · 花费明细）/ 药品管理。
// 钱的三数汇总（本疗程 / 上月 / 总花费）与未计价提示已并到「费用」页（/cost，2026-10-31）；
// 住院段录入与发票对账也只在费用页。药价维护仍在本页「药品管理」（按药一行，改价只填单价 + 生效日）。

import { useMemo, useState } from 'react'
import DateInput from './DateInput.jsx'
import dayjs from 'dayjs'
import MedDoseForm from './MedDoseForm.jsx'
import MedCoursesSection from './MedCoursesSection.jsx'
import CourseCard from './CourseCard.jsx'
import MedDrugManager from './MedDrugManager.jsx'
import TransfusionSection from './TransfusionSection.jsx'
import { addCourse, ensureDefaultCourse, useStore } from '../data/store.js'
import { summarizeCost } from '../utils/cost.js'
import { isDateStr, localToday, normDrug } from '../utils/medCourses.js'

export default function CoursePage({ events = [] }) {
  const store = useStore()
  const courses = store.courses || []
  const drugPrices = store.drugPrices || []
  const stays = store.stays || []
  const today = localToday()

  const s = useMemo(
    () => summarizeCost({ events, courses, drugPrices, stays, today }),
    [events, courses, drugPrices, stays, today]
  )

  const [msg, setMsg] = useState('')
  const [prefill, setPrefill] = useState(null) // 卡内「＋记改量」回填用药表单
  const [txOpen, setTxOpen] = useState(false) // 输血录入表单（默认收起）
  const [openAdd, setOpenAdd] = useState(false)
  const [f, setF] = useState({ name: '', start: today, end: '', note: '' })

  const notify = (m) => {
    setMsg(m)
    setTimeout(() => setMsg((cur) => (cur === m ? '' : cur)), 3000)
  }

  const submitCourse = () => {
    const name = normDrug(f.name) || '疗程'
    if (!isDateStr(f.start)) return
    addCourse({ name, start: f.start, end: isDateStr(f.end) ? f.end : null, note: f.note.trim() })
    setF({ name: '', start: today, end: '', note: '' })
    setOpenAdd(false)
    notify(`已新增疗程「${name}」（${f.start} 起）`)
  }

  return (
    <div className="max-w-5xl mx-auto space-y-3">
      {/* 汇总卡已并到「费用」页（2026-10-31）：本页只留一行未计价指针，金额与原因都在费用页 */}
      {s.unpricedDrugs.length > 0 && (
        <p className="px-1 text-[11px] text-amber-700">
          {s.unpricedDrugs.map((u) => u.drug).join('、')} 未计价，金额未计入（补单价见下方「药品管理」；完整提示在「费用」页）
        </p>
      )}

      {/* 记录区：用药录入 + 输血录入（表单默认收起） */}
      <div className="card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-slate-700">记录</h3>
          <div className="flex items-center gap-2">
            {!courses.length && (
              <button
                type="button"
                className="btn-secondary text-xs px-3 py-1.5"
                onClick={() => {
                  const c = ensureDefaultCourse()
                  notify(c ? `已按最早用药记录建疗程「诱导」（${c.start} 起）` : '还没有用药记录，先在左侧记一条用药')
                }}
              >
                按最早用药自动建「诱导」
              </button>
            )}
            <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={() => setOpenAdd(!openAdd)}>
              {openAdd ? '收起' : '＋ 新增疗程'}
            </button>
            <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={() => setTxOpen(!txOpen)}>
              {txOpen ? '收起输血' : '＋ 记输血'}
            </button>
          </div>
        </div>

        {openAdd && (
          <div className="flex flex-wrap gap-2 items-end mb-3 rounded-lg bg-slate-50 p-2.5">
            <div className="min-w-[130px]">
              <label className="label">疗程名称</label>
              <input
                className="input"
                list="course-add-names"
                placeholder="诱导"
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
              />
              <datalist id="course-add-names">
                {['诱导', '巩固', '强化', '维持', '移植', '桥接'].map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="label">开始日</label>
              <DateInput
                className="w-36"
                value={f.start ? dayjs(f.start) : null}
                onChange={(d) => setF({ ...f, start: d ? d.format('YYYY-MM-DD') : '' })}
                allowClear={false}
              />
            </div>
            <div>
              <label className="label">结束日（留空=至今）</label>
              <DateInput
                className="w-36"
                value={f.end ? dayjs(f.end) : null}
                onChange={(d) => setF({ ...f, end: d ? d.format('YYYY-MM-DD') : '' })}
                allowClear
                placeholder="留空"
              />
            </div>
            <div className="min-w-[160px] flex-1">
              <label className="label">备注</label>
              <input
                className="input"
                placeholder="如：泼尼松 + 泊那替尼"
                value={f.note}
                onChange={(e) => setF({ ...f, note: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && submitCourse()}
              />
            </div>
            <div className="flex gap-2 pb-0.5">
              <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={submitCourse}>
                保存
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-white transition-colors"
                onClick={() => setOpenAdd(false)}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {txOpen && (
          <div className="mb-3">
            <TransfusionSection events={events} showForm showList={false} onNotify={notify} />
          </div>
        )}

        <MedDoseForm events={events} prefill={prefill} onSaved={notify} />
      </div>

      {/* 疗程时间线 */}
      {s.byCourse.length > 0 ? (
        <div className="space-y-3">
          {s.byCourse.map((item) => (
            <CourseCard
              key={item.range.id}
              item={item}
              events={events}
              prices={drugPrices}
              onQuickDose={(p) => setPrefill({ ...(typeof p === 'string' ? { drug: p } : p), at: Date.now() })}
              onNotify={notify}
            />
          ))}
        </div>
      ) : (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-1">
            用药 <span className="ml-1 font-normal text-[11px] text-slate-400">未建疗程时按药展示完整时间线</span>
          </h3>
          <MedCoursesSection
            events={events}
            courses={[]}
            prices={drugPrices}
            onQuickDose={(p) => setPrefill({ ...(typeof p === 'string' ? { drug: p } : p), at: Date.now() })}
            onNotify={notify}
          />
          <div className="mt-2">
            <TransfusionSection events={events} showList onNotify={notify} />
          </div>
        </div>
      )}

      {/* 药品管理：药价（含改价史）/ 重命名 / 体温图开关。无疗程时由下方用药区自带，避免重复 */}
      {s.byCourse.length > 0 && (
        <div className="card p-4">
          <MedDrugManager events={events} onNotify={notify} />
        </div>
      )}

      {msg && <p className="text-[11px] text-emerald-600">{msg}</p>}

      <p className="px-1 text-[11px] text-slate-400">
        卡内金额是系统推算值（药费 + 住院实掏），口径与三数汇总见「费用」页；只统计填了单价的自费药，未计价的药在费用页列明。
      </p>
    </div>
  )
}
