// ===================== 归档列表页共用筛选条 =====================
// 检验报告 / 检查报告 / 病历文书三页的「标题计数 + 搜索 + 分类筛选」结构完全同构，
// 收敛到一处实现：分类选项由各页按自身数据算好后传入（[{ value, label, count }]，含 'all'），
// 组件不感知任何业务字段，三页改一次即全生效。
//
// 分类筛选器统一为「可横向滚动的 Tab 条」：固定宽度（大屏）+ 超宽在容器内横向滚动（滚动条隐藏），
// 窄屏随外层 flex-wrap 落到下一行并占满宽度。三页形态一致，不随分类数量退化成下拉。
// 内容超宽时可滚动，并在最左/最右显示箭头与边缘渐隐提示（仅在确有溢出时出现）。
//
// tabsOnly：只渲染滚动 tab 条，跳过标题行与搜索框——报告页（检验 + 检查合并）已在外层提供
// 统一的标题与跨库搜索，内嵌列表只需保留自己那一层「子分类」筛选。

import { useEffect, useRef, useState } from 'react'
import { Input } from 'antd'

// 内联箭头图标（避免引入额外图标依赖）
const ChevronLeft = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 18 9 12 15 6" />
  </svg>
)
const ChevronRight = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

export default function SectionFilterBar({
  title,
  total = 0,
  subtitle = '',
  searchPlaceholder = '',
  query,
  onQueryChange,
  categories = [],
  value = 'all',
  onChange,
  onResetPaging, // 搜索/分类变化后重置分页或可见条数
  actions = null, // 标题行右侧附加内容
  tabsOnly = false, // 只渲染分类 tab 条（报告页内嵌列表用）
}) {
  const changeQuery = (v) => {
    onQueryChange(v)
    if (onResetPaging) onResetPaging()
  }
  const changeCategory = (v) => {
    onChange(v)
    if (onResetPaging) onResetPaging()
  }

  const scrollRef = useRef(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const update = () => {
    const el = scrollRef.current
    if (!el) return
    const overflow = el.scrollWidth - el.clientWidth > 1
    setHasOverflow(overflow)
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    update()
    const onScroll = () => update()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => update())
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
    // categories 变化（分类数/条数变化）时重算溢出与边界
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories])

  const scrollBy = (dir) => {
    const el = scrollRef.current
    if (el) el.scrollBy({ left: dir * 200, behavior: 'smooth' })
  }

  return (
    <>
      {!tabsOnly && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">
              {title}（{total}）
            </h3>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 mb-3">
        {!tabsOnly && (
          <Input.Search
            allowClear
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            className="w-full sm:w-1/3 sm:flex-none sm:min-w-[180px]"
          />
        )}
        {/* 滚动 Tab 条：外包裹 relative 用于挂载箭头/渐隐；吃掉搜索框之外的剩余宽度，窄屏折行占满 */}
        <div className="relative flex-1 min-w-[200px]">
          {hasOverflow && canLeft && (
            <>
              <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-10 bg-gradient-to-r from-white to-transparent z-10" />
              <button
                type="button"
                aria-label="向左滚动分类"
                onClick={() => scrollBy(-1)}
                className="absolute left-0 top-0 bottom-0 z-20 flex items-center pl-1 pr-2 text-slate-400 hover:text-brand-700 cursor-pointer outline-none"
              >
                <ChevronLeft />
              </button>
            </>
          )}
          {hasOverflow && canRight && (
            <>
              <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-white to-transparent z-10" />
              <button
                type="button"
                aria-label="向右滚动分类"
                onClick={() => scrollBy(1)}
                className="absolute right-0 top-0 bottom-0 z-20 flex items-center pr-1 pl-2 text-slate-400 hover:text-brand-700 cursor-pointer outline-none"
              >
                <ChevronRight />
              </button>
            </>
          )}
          <div
            ref={scrollRef}
            className="overflow-x-auto whitespace-nowrap border-b border-slate-200 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {categories.map((c) => {
              const active = c.value === value
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => changeCategory(c.value)}
                  className={`inline-block px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors cursor-pointer outline-none focus-visible:bg-slate-50 ${
                    active
                      ? 'text-brand-700 border-brand-600 font-medium'
                      : 'text-slate-500 border-transparent hover:text-slate-800'
                  }`}
                >
                  {c.label}
                  <span className={`ml-1 ${active ? 'text-brand-700/70' : 'text-slate-400'}`}>{c.count}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
