// ===================== 单个疗程卡（时间线主单元） =====================
// 一卡 = 一个疗程：卡头（名称 / 状态 / 起止 / 天数 / 该疗程花费）+ 卡内四块
// 用药（按疗程裁剪的剂量阶梯）· 输血（区间内事件）· 住院（落在区间的段 + 分摊）· 花费明细。
// 结束日口径：填了 = 疗程最后一天（含当天）；留空 = 至今。若后面还有疗程，两者之间的空档并入本疗程。

import { useMemo, useState } from 'react'
import DateInput from './DateInput.jsx'
import dayjs from 'dayjs'
import MedDrugCard from './MedDrugCard.jsx'
import TransfusionSection from './TransfusionSection.jsx'
import { deleteCourse, updateCourse } from '../data/store.js'
import { fmtMoney, fmtPacks, mergeDrugLines } from '../utils/cost.js'
import { fmtD, groupCoursesByPhase, groupMedCourses, localToday, normDrug } from '../utils/medCourses.js'

export default function CourseCard({ item, events, onQuickDose, onNotify, prices = [] }) {
  const range = item.range
  const today = localToday()
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState({ name: range.name, start: range.start, end: range.ownEnd || '', note: range.note || '' })

  // 本疗程内的用药（按药分组，段已按疗程区间裁剪；跨疗程持续用药自动续接）
  const drugs = useMemo(() => {
    const all = groupMedCourses(events)
    const g = groupCoursesByPhase(all, [range], today)
    return g.length ? g[0].drugs : []
  }, [events, range, today])

  const notify = (m) => onNotify && onNotify(m)

  const save = () => {
    const name = normDrug(f.name) || '疗程'
    if (!f.start) return
    updateCourse(range.id, { name, start: f.start, end: f.end || null, note: f.note.trim() })
    setEditing(false)
    notify(`疗程「${name}」已更新`)
  }

  const remove = () => {
    if (!window.confirm(`删除疗程「${range.name}」？用药与住院记录会保留，只是不再按它归集。`)) return
    deleteCourse(range.id)
    notify(`已删除疗程「${range.name}」`)
  }

  const stateLabel = range.end ? '已结束' : '进行中'

  return (
    <div className="card p-3">
      {/* 卡头 */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="rounded bg-brand-50 px-2 py-0.5 text-[13px] font-semibold text-brand-700">{range.name}</span>
        <span
          className={`rounded-full px-1.5 py-px text-[10px] font-medium ${
            range.end ? 'bg-slate-100 text-slate-500' : 'bg-slate-700 text-white'
          }`}
        >
          {stateLabel}
        </span>
        <span className="font-mono text-[11px] text-slate-400">
          {fmtD(range.start)} ~ {range.end ? fmtD(range.end) : '至今'}
        </span>
        <span className="text-[11px] text-slate-400">{item.days} 天</span>
        <span className="ml-auto font-mono text-[15px] font-semibold text-slate-800">{fmtMoney(item.total)}</span>
        <button
          type="button"
          className="text-[11px] text-slate-600 hover:underline cursor-pointer"
          onClick={() => {
            setF({ name: range.name, start: range.start, end: range.ownEnd || '', note: range.note || '' })
            setEditing(!editing)
          }}
        >
          {editing ? '收起' : '编辑'}
        </button>
        <button type="button" className="text-[11px] text-slate-400 hover:text-red-600 cursor-pointer" onClick={remove}>
          删除
        </button>
      </div>

      {range.note && <div className="mt-0.5 text-[11px] text-slate-400">{range.note}</div>}

      {/* 疗程编辑：名称 / 开始 / 结束日（可留空=至今）/ 备注 */}
      {editing && (
        <div className="mt-2 flex flex-wrap gap-2 items-end rounded-lg bg-slate-50 p-2.5">
          <div className="min-w-[120px]">
            <label className="label">名称</label>
            <input className="input" list="course-name-options" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <datalist id="course-name-options">
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
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          </div>
          <div className="flex gap-2 pb-0.5">
            <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={save}>
              保存
            </button>
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-white transition-colors"
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
          <p className="w-full text-[11px] text-slate-400">
            结束日 = 疗程最后一天（含当天）。留空表示进行中；若后面还有疗程，中间空档的花费并入本疗程。
          </p>
        </div>
      )}

      {/* 卡内四块：用药 / 输血 / 住院 / 花费 */}
      <div className="mt-2.5 grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-semibold text-slate-600">用药（{drugs.length}）</div>
          {drugs.length === 0 ? (
            <p className="text-[11px] text-slate-400">本疗程内没有用药记录</p>
          ) : (
            <div className="space-y-2">
              {drugs.map((d) => (
                <MedDrugCard
                  key={d.key}
                  course={d}
                  events={events}
                  today={today}
                  phased
                  prices={prices}
                  onQuickDose={onQuickDose}
                  onNotify={notify}
                />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[11px] font-semibold text-slate-600">输血</div>
            <TransfusionSection events={events} range={range} showList onNotify={notify} />
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold text-slate-600">住院分摊</div>
            {item.stayLines.length === 0 ? (
              <p className="text-[11px] text-slate-400">本疗程内没有住院费用</p>
            ) : (
              <div className="space-y-1">
                {item.stayLines.map((l) => (
                  <div key={l.id} className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-600">
                    <span className="font-mono text-slate-400">
                      {fmtD(l.start)}~{l.end ? fmtD(l.end) : '在院'}
                    </span>
                    <span className="text-slate-400">
                      落本疗程 {l.overlapDays}/{l.days} 天
                    </span>
                    <span className="ml-auto font-mono text-slate-700">{fmtMoney(l.sub)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold text-slate-600">花费明细</div>
            {mergeDrugLines(item.drugLines).length === 0 ? (
              <p className="text-[11px] text-slate-400">本疗程内没有可计价的用药</p>
            ) : (
              <div className="space-y-1">
                {mergeDrugLines(item.drugLines).map((l) => (
                  <div key={l.drug}>
                    <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-600">
                      <span className="font-medium text-slate-700">{l.drug}</span>
                      <span className="text-slate-400">{l.days} 天</span>
                      <span className="text-slate-400">{l.doses.join('→')}/日</span>
                      <span className="text-slate-400">{l.prices.join('→')} 元/{l.pkgUnit || '片'}</span>
                      <span className="text-slate-500">
                        {fmtPacks(l.packs)} {l.pkgUnit || '片'}
                        {l.manualPacks > 0 ? '（实耗）' : ''}
                      </span>
                      <span className="ml-auto font-mono text-slate-700">{fmtMoney(l.sub)}</span>
                    </div>
                    {/* 实际分多段（调剂量 / 改价）时展开分段明细 */}
                    {l.segs && l.segs.length > 1 && (
                      <div className="mt-0.5 space-y-0.5 pl-3">
                        {l.segs.map((s) => (
                          <div
                            key={`${s.from}~${s.to}~${s.dose}~${s.price}`}
                            className="flex flex-wrap items-center gap-x-2 text-[10px] text-slate-400"
                          >
                            <span className="font-mono">
                              {fmtD(s.from)}~{fmtD(s.to)}
                            </span>
                            <span>{s.days} 天</span>
                            <span>
                              {s.dose}
                              {s.unit}/日
                            </span>
                            <span>
                              {fmtPacks(s.packs)} {s.pkgUnit || '片'}
                              {s.packsSrc === 'manual' ? '（实耗）' : ''}
                            </span>
                            <span className="ml-auto font-mono">{fmtMoney(s.sub)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1.5 flex items-center gap-2 border-t border-slate-100 pt-1.5 text-[11px] text-slate-500">
              <span>药费 {fmtMoney(item.drugTotal)}</span>
              <span>+ 住院 {fmtMoney(item.stayTotal)}</span>
              <span className="ml-auto font-mono font-semibold text-slate-700">{fmtMoney(item.total)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 本疗程内未定价的药（不算 0，只是没数据） */}
      {item.unpriced.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
          本疗程未计价：{item.unpriced.map((u) => u.drug).join('、')}（未填单价或缺规格，在下方「药品管理」里补价）
        </div>
      )}
    </div>
  )
}
