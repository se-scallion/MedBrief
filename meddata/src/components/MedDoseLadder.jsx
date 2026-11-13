// ===================== 用药剂量阶梯条（纯 CSS，无图表库） =====================
// 一条横向时间轴：每个色块 = 一个剂量段，宽度按该段天数占比；窄块不写字（信息走悬浮 title），
// 升降以 ↑↓ 示意；停药空档画成斜纹空档块；进行中的末段用品牌蓝渐变高亮。
// 整条可点：点击任意段直接进入该段的编辑（未记录剂量的段点击即补填）。

import { arrowOf, courseEndDay, daysBetween, fmtD, fmtDT, nextDay, prevDay } from '../utils/medCourses.js'

// 把疗程切成「剂量段 / 空档段」两类块，并算出各自的宽度占比
function ladderBlocks(course, today) {
  const endDay = courseEndDay(course, today)
  const total = Math.max(1, daysBetween(course.start, endDay))
  const blocks = []
  let cursor = course.start
  let prevDose = null
  for (const seg of course.segments) {
    const segEnd = seg.to || endDay
    if (seg.from > cursor) {
      const gapTo = prevDay(seg.from)
      blocks.push({ kind: 'gap', days: daysBetween(cursor, gapTo), from: cursor, to: gapTo })
      cursor = seg.from
    }
    const days = Math.max(1, daysBetween(seg.from, segEnd < seg.from ? seg.from : segEnd))
    blocks.push({
      kind: 'dose',
      days,
      seg,
      ongoing: seg.to === null,
      arrow: prevDose == null ? null : arrowOf(prevDose, seg.dose),
    })
    if (seg.dose != null) prevDose = seg.dose
    cursor = nextDay(segEnd) || cursor
  }
  return { blocks, total, endDay }
}

const ARROW = { up: '↑', down: '↓', flat: '=' }
const ARROW_COLOR = { up: 'text-emerald-500', down: 'text-amber-500', flat: 'text-slate-400' }

export default function MedDoseLadder({ course, today, onEdit }) {
  const { blocks, total, endDay } = ladderBlocks(course, today)
  const year = String(course.start).slice(0, 4) !== String(endDay).slice(0, 4)

  return (
    <div className="flex h-7 w-full overflow-hidden rounded-md border border-slate-200 bg-white">
      {blocks.map((b, i) => {
        if (b.kind === 'gap') {
          return (
            <div
              key={i}
              className="bg-[repeating-linear-gradient(45deg,#f8fafc,#f8fafc_3px,#e2e8f0_3px,#e2e8f0_6px)]"
              style={{ width: `${(b.days / total) * 100}%`, minWidth: 6 }}
              title={`${fmtD(b.from, year)}~${fmtD(b.to, year)} 未服用（停药空档 ${b.days} 天）`}
            />
          )
        }
        const has = b.seg.dose != null
        const label = has ? `${b.seg.dose}${b.seg.unit || ''}` : ''
        const range = `${fmtDT(b.seg.from, b.seg.fromTime, year)}~${b.seg.to ? fmtDT(b.seg.to, b.seg.toTime, year) : '至今'}`
        const share = b.days / total
        return (
          <div
            key={i}
            className={`flex items-center justify-center overflow-hidden border-r text-[10px] font-medium cursor-pointer transition-all hover:brightness-105 ${
              has
                ? b.ongoing
                  ? 'border-white/70 bg-gradient-to-r from-brand-500 to-brand-600 text-white'
                  : 'border-white/70 bg-slate-100 text-slate-600'
                : 'border-dashed border-slate-300 bg-slate-50 text-slate-400'
            }`}
            style={{ width: `${share * 100}%`, minWidth: has ? 20 : 10 }}
            title={has ? `${range} · ${label}/日（${b.days} 天）· 点击编辑` : `${range} · 未记录剂量，点击补填`}
            onClick={() => onEdit && onEdit(b.seg.entry)}
          >
            {has && share >= 0.12 && (
              <span className="truncate px-1">
                {b.arrow && <span className={ARROW_COLOR[b.arrow]}>{ARROW[b.arrow]} </span>}
                {label}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
