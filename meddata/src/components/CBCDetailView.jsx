// ===================== 全血细胞分析 · 详细走势（全屏详情页） =====================
// 按系统分组（白细胞 / 红细胞 / 血小板）展示每个指标的独立走势图：
// 绿带=正常区（参考区间内）、橙带=偏低风险（低于参考下限）、红带=偏高风险（高于参考上限）、
// 静态深红圆点=危急值；分组标题可折叠（折叠即卸载图表以节省资源）。
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Button, Tag } from 'antd'
import { MiniChart, buildSingleOption, prepareTrendData, calcYRange } from './TrendChart.jsx'
import StreamsSection from './StreamsSection.jsx'
import TempSection from './TempSection.jsx'
import { FIELD_BY_CODE, buildFieldGroups, FIELD_GROUP_CATEGORY, CATEGORY_GROUPS, RECORD_CATEGORIES, OTHER_CATEGORY } from '../data/dictionary.js'
import { computeStatus, STATUS_META, parseRefRange } from '../utils/normalize.js'
import { findPoint } from '../utils/export.js'

const STATUS_TAG_COLOR = { red: 'red', amber: 'orange', emerald: 'green', slate: 'default' }

const GROUP_STYLE = {
  wbc: { dot: '#94a3b8' },
  rbc: { dot: '#ef4444' },
  platelet: { dot: '#f59e0b' },
}

const BADGE_CLASS = {
  CRITICAL_LOW: 'bg-red-600 text-white',
  CRITICAL_HIGH: 'bg-red-600 text-white',
  LOW: 'bg-amber-100 text-amber-700',
  HIGH: 'bg-amber-100 text-amber-700',
  NORMAL: 'bg-emerald-100 text-emerald-700',
}

const toNum = (v) => {
  const n = parseFloat(v)
  return Number.isNaN(n) ? null : n
}

// 视觉可辨性阈值：数据跨度占 Y 轴显示范围（含参考区间带）的比例。
// 低于该比例时，260px 高的小图起伏不足 8px，肉眼看就是一条平线 → 默认不展示。
const FLAT_RATIO = 0.05
// 临床决策关键指标：即使视觉上变化不大也始终保留——它们的变化本身就是要盯的重点。
// （例如 RBC 若被个别脏参考范围撑大 Y 轴，看似无变化，但它仍是输血效果的核心判据）
const KEEP_CODES = new Set(['RBC', 'Hb', 'HCT', 'PLT', 'WBC', 'NEUT_ABS'])

export default function CBCDetailView({ records, events, onOpenDoc, onOpenRecord, onNotify }) {
  // 与主图表共用同一套数据聚合（排序 / 同天合并 / 事件过滤），口径一致
  const { dates, byDate, fields, markerEvents, recordSlots, byTs } = useMemo(() => prepareTrendData(records, events), [records, events])
  // 指标卡片「原件」跳转：点位带来源记录 id，点击打开那份记录的详情（左栏即高清原图，可点指标定位）
  const recordById = useMemo(() => new Map((records || []).map((r) => [r.id, r])), [records])
  // 从「查看趋势」跳来时带 state.expandGroup（标准字典 group 名），让目标分组默认展开，
  // 否则折叠组只显示表头、看不到对应图，跳转就「到了却没看到」。
  const location = useLocation()
  const [collapsed, setCollapsed] = useState({})
  // 变化过小（视觉上几乎是一条平线）的指标默认不展示，可一键展开
  const [showFlat, setShowFlat] = useState(false)
  const toggle = (key) => setCollapsed((s) => ({ ...s, [key]: !s[key] }))

  // 三组指标卡片：仅保留有数据的指标；每组统计危急项数（组内任一点为危急）
  const groups = useMemo(() => {
    // 「视觉无变化」判定：用图表实际绘制的数据点（recordSlots，同天多份各自成点）计算，
    // Y 轴范围与图上完全一致（含参考区间带），故该比例 = 肉眼看到的起伏占比。
    const isFlat = (code) => {
      if (KEEP_CODES.has(code)) return false
      const rows = recordSlots
        .map(({ r, ts, date }) => {
          const p = findPoint(r, code)
          const v = p ? toNum(p.value) : null
          return v == null ? null : { d: date, v, ts, ref: parseRefRange(p.ref_range) }
        })
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts)
      if (rows.length < 2) return false
      const vals = rows.map((x) => x.v)
      const span = Math.max(...vals) - Math.min(...vals)
      const { min: yMin, max: yMax } = calcYRange(rows)
      return yMax > yMin && span / (yMax - yMin) < FLAT_RATIO
    }
    return buildFieldGroups(fields).map((g) => {
      const cards = g.series
        .map((s) => s.code)
        .filter((c) => fields.includes(c))
        .map((code) => {
          const pts = []
          for (const d of dates) {
            const r = byDate[d]
            const p = r && findPoint(r, code)
            if (!p) continue
            const v = toNum(p.value)
            if (v == null) continue
            // 旧数据可能无 status 字段：按值+参考区间即时计算，保证危急/偏离徽章不遗漏
            pts.push({ d, p, v, rid: r.id, status: p.status || computeStatus(code, p.value, p.ref_range) })
          }
          return { code, pts, latest: pts.length ? pts[pts.length - 1] : null, flat: isFlat(code) }
        })
      const withData = cards.filter((c) => c.pts.length > 0)
      const kept = showFlat ? withData : withData.filter((c) => !c.flat)
      const critCount = kept.filter((c) => c.pts.some((x) => x.status.startsWith('CRITICAL'))).length
      return { ...g, cards: kept, critCount, hidden: withData.filter((c) => c.flat).length }
    })
  }, [dates, byDate, fields, recordSlots, showFlat])

  // 首屏默认折叠「无危急/偏离」的组，把初始实例数压到最小（通常几~十几个），其余指标卡片
  // 由 MiniChart 的懒渲染在滚动进入视口才 init。注意：此 effect 必须置于 groups 之后——
  // 依赖数组 [groups] 在注册时会读取 groups，若放在 const groups 之前会触发 TDZ 崩溃。
  useEffect(() => {
    setCollapsed((prev) => {
      if (Object.keys(prev).length) return prev
      const init = {}
      for (const g of groups) if (g.critCount === 0) init[g.key] = true
      // 若来自「查看趋势」跳转并指明了分组，则强制展开该组（即便它本无危急/偏离也默认收起）
      const expand = location.state?.expandGroup
      if (expand) init[expand] = false
      return init
    })
  }, [groups, location.state])

  const totalCount = groups.reduce((n, g) => n + g.cards.length, 0)
  const totalCrit = groups.reduce((n, g) => n + g.critCount, 0)
  const hiddenCount = groups.reduce((n, g) => n + g.hidden, 0)

  // 锚点导航：与报告页共用同一套分类（FIELD_GROUP_CATEGORY），把 17 个指标组收敛成几个分类 chip，
  // 点击滚到该分类下第一个分组（组内仍可折叠）。用户 2026-10-24：「指标页顶部索引太多了」。
  const navCats = useMemo(() => {
    const groupLabel = new Map(CATEGORY_GROUPS.map((g) => [g.key, g.label]))
    const catLabel = new Map(RECORD_CATEGORIES.map((c) => [c.key, c.label]))
    const order = []
    const byCat = new Map()
    for (const g of groups) {
      if (!g.cards.length) continue
      const cat = FIELD_GROUP_CATEGORY[g.key] || OTHER_CATEGORY.key
      if (!byCat.has(cat)) {
        byCat.set(cat, {
          key: cat,
          label: groupLabel.get(cat) || catLabel.get(cat) || OTHER_CATEGORY.label,
          target: g.key, // 滚到该分类下第一个分组
          crit: 0,
        })
        order.push(cat)
      }
      byCat.get(cat).crit += g.critCount
    }
    return order.map((k) => byCat.get(k))
  }, [groups])

  // 顶部工具条：与体温页 / 报告页同一套浅色卡片风格（白底 + 细边 + 轻阴影，不是深色页头），
  // 且不再放返回键——指标页是顶栏一级入口，离开走顶栏导航，无需页内返回。
  const header = (
    <div
      data-testid="cbc-toolbar"
      className="sticky top-[60px] z-20 rounded-xl bg-white/95 backdrop-blur border border-slate-200 shadow-sm px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h2 className="text-base font-semibold text-slate-800 shrink-0">指标 · 详细走势</h2>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
          共 {totalCount} 项指标
        </span>
        <span
          className={`text-[11px] px-2 py-0.5 rounded-full ${
            totalCrit ? 'bg-red-50 text-red-700 font-medium' : 'bg-slate-100 text-slate-500'
          }`}
        >
          {totalCrit ? `${totalCrit} 项危急` : '无危急项'}
        </span>
        {/* 单行可横向滚动的紧凑索引条：分组多时不再换行散落成多排 */}
        <div className="flex items-center gap-1.5 overflow-x-auto ml-auto min-w-0">
          <button
            type="button"
            onClick={() => document.getElementById('streams')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="shrink-0 rounded-full border border-brand-300 bg-brand-50 px-2.5 py-0.5 text-[11px] text-brand-700 hover:bg-brand-100 cursor-pointer"
          >
            残留病监测
          </button>
          {navCats.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                // 点击分类：展开该分类下第一个分组（折叠则展开），再平滑滚动定位
                setCollapsed((s) => (s[c.target] ? { ...s, [c.target]: false } : s))
                const el = document.getElementById(`grp-${c.target}`)
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] cursor-pointer transition-colors ${
                c.crit > 0
                  ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <div data-testid="cbc-page" className="space-y-3">
      {header}
      <div className="space-y-4">
        {/* 残留病监测：三条检测维度（数据来自检查报告 / 融合基因检验，自动生成） */}
        <StreamsSection onOpenDoc={onOpenDoc} />

        {/* 体温功能区：从首页迁来（首页只留分型卡与统计），体温属于日常监测，与残留病指标同页查看 */}
        <TempSection events={events} onNotify={onNotify} />

        {totalCount === 0 && (
          <div className="card p-8 text-center text-sm text-slate-400">
            暂无血细胞分析数据，先导入并保存化验记录后再查看（上方残留病指标来自检查报告）
          </div>
        )}

        {totalCount > 0 && (
          <>
        {/* 色带图例 */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(16,185,129,0.4)' }} />
            正常区（参考区间内）
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(251,146,60,0.4)' }} />
            偏低风险
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(239,68,68,0.4)' }} />
            偏高风险
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-700" />
            危急值
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="w-3 h-0.5"
              style={{ background: 'repeating-linear-gradient(90deg,#f59e0b 0 4px,transparent 4px 7px)' }}
            />
            输血事件（对应血细胞系统当日竖直上升）
          </span>
          {hiddenCount > 0 && !showFlat && (
            <span className="text-[11px] text-slate-400">已隐藏 {hiddenCount} 项变化不明显指标</span>
          )}
          <Button
            size="small"
            onClick={() => setShowFlat((v) => !v)}
            className="!ml-auto !rounded-lg !border-slate-300 !px-2.5 !py-1 !text-[11px] !text-slate-600 hover:!bg-slate-100"
          >
            {showFlat ? '隐藏无变化指标' : `显示无变化指标（${hiddenCount}）`}
          </Button>
        </div>

        {groups.map((g) => {
          if (!g.cards.length) return null
          const open = !collapsed[g.key]
          return (
            <section key={g.key} id={`grp-${g.key}`} className="card overflow-hidden scroll-mt-[132px]">
              <button
                onClick={() => toggle(g.key)}
                className="w-full flex items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: GROUP_STYLE[g.key]?.dot || '#0d9488' }}
                  />
                  <h2 className="text-sm font-semibold text-slate-700 truncate">{g.title}</h2>
                  <span className="text-[11px] text-slate-400 shrink-0">
                    {g.cards.length} 项
                    {g.critCount > 0 && (
                      <span className="ml-1.5 text-red-600 font-medium">{g.critCount} 项危急</span>
                    )}
                  </span>
                </div>
                <svg
                  className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>

              {open && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 px-4 pb-4">
                  {g.cards.map((card) => {
                    const field = FIELD_BY_CODE[card.code] || {}
                    const lp = card.latest
                    const unit = lp ? lp.p.unit || field.unit : field.unit
                    const ref = lp ? lp.p.ref_range || field.ref : field.ref
                    const st = lp ? lp.status : 'NORMAL'
                    return (
                      <div key={card.code} className="card overflow-hidden transition-shadow hover:shadow-md">
                        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-700 truncate">
                              {field.name || card.code}
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              {unit ? `${unit} · ` : ''}参考 {ref || '—'}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            {lp ? (
                              <>
                                <div className="text-base font-bold leading-tight">{lp.v}</div>
                                <Tag
                                  color={STATUS_TAG_COLOR[STATUS_META[st]?.color] || 'default'}
                                  className="!mt-1 !rounded !text-[10px] !font-medium !mr-0"
                                >
                                  {STATUS_META[st] ? STATUS_META[st].symbol || STATUS_META[st].label : st}
                                </Tag>
                                {/* 指标 → 原件：按点位来源记录打开详情（原图 + 该指标 bbox 高亮定位）。
                                    放在固定位置（卡片右上），不做 hover 浮层按钮（AGENTS.md UI 铁律）。 */}
                                {onOpenRecord && recordById.get(lp.rid) && (
                                  <button
                                    type="button"
                                    onClick={() => onOpenRecord(recordById.get(lp.rid))}
                                    className="mt-1 block w-full text-[10px] text-brand-700 hover:underline cursor-pointer"
                                    title="打开这条记录的原件报告（含该指标在原图上的位置）"
                                  >
                                    原件 / {String(lp.d || '').slice(5)}
                                  </button>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-slate-300">—</span>
                            )}
                          </div>
                        </div>
                        <MiniChart
                          dates={dates}
                          byDate={byDate}
                          events={markerEvents}
                          specs={[{ code: card.code }]}
                          recordSlots={recordSlots}
                          byTs={byTs}
                          height={260}
                          lazy
                          build={(d, b, e, s, rs, ts) => buildSingleOption(d, b, e, card.code, rs, ts)}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
          </>
        )}
      </div>
    </div>
  )
}
