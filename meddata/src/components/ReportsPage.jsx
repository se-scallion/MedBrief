// ===================== 报告页：检验 + 检查报告合并入口 =====================
// 为什么合并「壳」而不合并「表」：
//   · 检验（records）= 数值指标矩阵（data_points 带参考范围/状态，能进趋势图），详情走 ReportDetail；
//   · 检查报告（docs）= 原件 + 叙述文本（findings/conclusion/measures），详情走 DocDetail，AI 精读。
// 两个库行内字段没有交集，混排成一张表只能做两套行渲染并裁掉各自专有信息（净亏）。
// 但用户找报告时只记得日期/医院、不记得是「化验」还是「检查」，而顶栏「检验」与「检查报告」
// 只差一字常年点错 → 真正要合的是**入口与检索**：一页两 tab，搜索与时间区间跨两库共享，
// tab 内沿用各自原列表（行渲染、详情、导入流程一律不动）。
//
// URL 契约（可分享、可前进后退、可被脚本直接访问）：
//   /reports?tab=lab|doc&q=<文本>&range=all|3m|1y|3y
// 旧路由 /records（lab）与 /archive（doc）由 App 渲染同一组件的对应 tab，书签与 e2e 脚本不受影响。

import { useEffect, useMemo } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Input } from 'antd'
import { RecordsTable } from './TrendChart.jsx'
import DocsSection from './DocsSection.jsx'
import { DATE_RANGES, filterReports, normalizeRange } from '../utils/reportFilter.js'
import { docCategory } from '../data/store.js'

const TABS = [
  { key: 'lab', label: '检验' },
  { key: 'doc', label: '检查' },
]

// 记忆上次看的 tab：从顶栏点「报告」回来时落在上次那一类，而不是每次都回到检验
// （会话级内存态，不写 localStorage——这是导航偏好，不是数据）
let lastTab = 'lab'

export default function ReportsPage({
  records = [],
  docs = [],
  onViewChart,
  onViewDetail,
  onOpenDoc,
  defaultTab,
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const [sp] = useSearchParams()

  // docs 里混着三类归档（检验图文报告 / 检查报告 / 病历文书），按归档大类拆开：
  //   · 'lab'  → 进「检验」tab（骨髓形态学 / 流式 / 基因等，由检验科出具，用户口径 2026-10-27）
  //   · 'exam' → 进「检查」tab
  //   · 'case' → 病历文书独立模块，报告页不列（App 里另有 /cases）
  const labDocs = useMemo(() => docs.filter((d) => docCategory(d) === 'lab'), [docs])
  const examDocs = useMemo(() => docs.filter((d) => docCategory(d) === 'exam'), [docs])

  const rawTab = sp.get('tab')
  const tab = rawTab === 'doc' || rawTab === 'lab' ? rawTab : defaultTab || lastTab
  useEffect(() => {
    lastTab = tab
  }, [tab])
  const range = normalizeRange(sp.get('range'))
  const query = sp.get('q') || ''
  const filtering = !!query.trim() || range !== 'all'

  // 参数一律写回 /reports 的规范 URL：从旧路由（/records、/archive）进来后任何一次筛选都会自愈到合并页
  const setParam = (key, value, replace = false) => {
    const p = new URLSearchParams(sp)
    p.set('tab', key === 'tab' ? value : tab)
    const drop = value === '' || value == null || (key === 'range' && value === 'all')
    if (drop) p.delete(key)
    else p.set(key, value)
    const qs = p.toString()
    navigate(qs ? `/reports?${qs}` : '/reports', { replace })
  }

  // 检验 tab 的清单 = 检验记录（指标）+ 检验图文报告（归档原件），同一条时间轴；检查 tab 只有检查报告。
  const hit = filterReports(records, examDocs, { query, range })
  const labDocHit = filterReports([], labDocs, { query, range }).docs
  const hits = { lab: hit.records.length + labDocHit.length, doc: hit.docs.length }
  const totals = { lab: records.length + labDocs.length, doc: examDocs.length }
  const other = tab === 'lab' ? 'doc' : 'lab'
  const otherLabel = other === 'lab' ? '检验' : '检查'

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">
            报告（{totals.lab + totals.doc}）
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            检验 {totals.lab} 份 · 检查 {totals.doc} 份 · 原件与数据均在本机
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400">数据仅保存在本机浏览器（IndexedDB）</span>
          {/* 落点即声明：按钮跟随当前 tab 决定导入哪一类，用户不必猜、系统也不必判 */}
          <button
            type="button"
            data-testid={`reports-import-${tab}`}
            onClick={() =>
              navigate(`/reports/add?flow=${tab}`, {
                state: { from: location.pathname + location.search },
              })
            }
            className="btn-primary text-xs"
            title={
              tab === 'lab'
                ? '导入化验单：识别成指标表格，可进趋势图'
                : '导入检查报告：原件完整保存 + 所见/结论索引'
            }
          >
            ＋ 导入{tab === 'lab' ? '化验单' : '检查报告'}
          </button>
        </div>
      </div>

      {/* 一层：类型 tab（两库命中数） + 跨库搜索 + 时间区间 */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shrink-0">
          {TABS.map((t) => {
            const active = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                data-testid={`reports-tab-${t.key}`}
                title={`${t.label}报告共 ${totals[t.key]} 份${filtering ? `，当前条件命中 ${hits[t.key]} 份` : ''}`}
                onClick={() => setParam('tab', t.key)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors cursor-pointer outline-none ${
                  active ? 'bg-brand-600 text-white font-medium' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.label}
                <span className={`ml-1 ${active ? 'text-white/80' : 'text-slate-400'}`}>{hits[t.key]}</span>
              </button>
            )
          })}
        </div>

        <Input.Search
          allowClear
          value={query}
          onChange={(e) => setParam('q', e.target.value, true)}
          placeholder="搜索两类：日期 / 类型 / 指标名 / 结论"
          className="w-full sm:w-96 sm:flex-none"
        />

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-slate-400 shrink-0">时间</span>
          {DATE_RANGES.map((r) => {
            const active = range === r.key
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => setParam('range', r.key, true)}
                className={`text-[11px] rounded border px-2 py-0.5 transition-colors cursor-pointer ${
                  active
                    ? 'border-brand-300 bg-brand-50 text-brand-700 font-medium'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700'
                }`}
              >
                {r.label}
              </button>
            )
          })}
        </div>

        {filtering && (
          <button
            type="button"
            onClick={() => {
              const p = new URLSearchParams(sp)
              p.delete('q')
              p.delete('range')
              navigate(`/reports?${p.toString()}`, { replace: true })
            }}
            className="text-[11px] text-slate-400 hover:text-brand-700 underline cursor-pointer"
          >
            清除筛选
          </button>
        )}
      </div>

      {/* 交叉提示：当前 tab 没命中，但另一类有 —— 别让用户以为数据丢了 */}
      {filtering && hits[tab] === 0 && hits[other] > 0 && (
        <div className="mb-2 text-[11px] text-slate-500">
          {tab === 'lab' ? '检验' : '检查'}无匹配，{otherLabel}报告有 {hits[other]} 条匹配
          <button
            type="button"
            onClick={() => setParam('tab', other)}
            className="ml-1 text-brand-700 underline cursor-pointer"
          >
            切到{otherLabel}
          </button>
        </div>
      )}

      {/* 二层：子分类（检验按报告类型 / 检查按报告种类 + AI 状态）由各列表自己提供 */}
      {tab === 'lab' ? (
        <RecordsTable
          records={hit.records}
          labDocs={labDocHit}
          onViewChart={onViewChart}
          onViewDetail={onViewDetail}
          onOpenDoc={onOpenDoc}
        />
      ) : (
        <DocsSection docs={hit.docs} onOpen={onOpenDoc} />
      )}
    </div>
  )
}
