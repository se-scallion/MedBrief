// ===================== 用药方案区（按疗程分组的用药记录） =====================
// 全站只有一个「疗程」概念 = 治疗阶段（诱导 / 巩固 / 维持）。本区按疗程分组，
// 每个疗程下列出该疗程内各药的剂量阶梯（用药段按疗程区间裁剪，跨疗程持续用药自动出现在两侧疗程）。
// 未建疗程时退化为「按药一张卡（完整时间线）」，与旧行为完全一致（零回归）。
// 所有写操作直达 store（MedDrugCard 内），store 变更经 useStore 全局广播刷新。

import { useMemo } from 'react'
import MedDrugManager from './MedDrugManager.jsx'
import MedDrugCard from './MedDrugCard.jsx'
import { courseRanges } from '../utils/cost.js'
import { fmtD, groupCoursesByPhase, groupMedCourses, localToday } from '../utils/medCourses.js'

export default function MedCoursesSection({ events, courses = [], onQuickDose, onNotify, prices = [] }) {
  const today = localToday()
  const all = useMemo(() => groupMedCourses(events), [events])
  const ranges = useMemo(() => courseRanges(courses, today), [courses, today])
  const phased = useMemo(() => (ranges.length ? groupCoursesByPhase(all, ranges, today) : null), [all, ranges, today])

  if (!all.length) {
    return (
      <div>
        <p className="px-1 py-4 text-xs text-slate-400">暂无用药记录，可在上方录入（如：泊那替尼 45mg/日）</p>
        <MedDrugManager events={events} onNotify={onNotify} />
      </div>
    )
  }

  if (!phased) {
    return (
      <div className="space-y-2">
        {all.map((c) => (
          <MedDrugCard key={c.key} course={c} events={events} today={today} prices={prices} onQuickDose={onQuickDose} onNotify={onNotify} />
        ))}
        <MedDrugManager events={events} onNotify={onNotify} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {phased.map((p) => (
        <div key={p.range.id}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5">
            <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-semibold text-brand-700">{p.range.name}</span>
            <span className="font-mono text-[11px] text-slate-400">
              {fmtD(p.range.start)} ~ {p.range.end ? fmtD(p.range.end) : '至今'}
            </span>
            <span className="text-[11px] text-slate-400">{p.drugs.length} 种药</span>
            {p.range.note && <span className="text-[11px] text-slate-400">· {p.range.note}</span>}
          </div>
          {p.drugs.length ? (
            <div className="space-y-2">
              {p.drugs.map((d) => (
                <MedDrugCard
                  key={`${p.range.id}-${d.key}`}
                  course={d}
                  events={events}
                  today={today}
                  phased
                  prices={prices}
                  onQuickDose={onQuickDose}
                  onNotify={onNotify}
                />
              ))}
            </div>
          ) : (
            <p className="px-1 py-2 text-xs text-slate-400">本疗程内没有用药记录</p>
          )}
        </div>
      ))}
      <MedDrugManager events={events} onNotify={onNotify} />
    </div>
  )
}
