// ===================== 报告归档列表（可检索的解析索引） =====================
// 按日期倒序展示所有影像/心电等报告归档，支持对索引字段全文搜索。

import { useMemo, useState } from 'react'
import { Tag, List, Empty, Button } from 'antd'
import SectionFilterBar from './SectionFilterBar.jsx'
import AssetBadge from './AssetBadge.jsx'
import { DOC_KINDS, CASE_KINDS, LAB_DOC_KINDS } from '../data/docKinds.js'
import { applyCategorySizePolicy } from '../data/dictionary.js'
import { docHeading } from '../utils/docHeading.js'

const KIND_COLOR = {
  ecg: 'red',
  ultrasound: 'cyan',
  ct: 'purple',
  mri: 'geekblue',
  xray: 'orange',
  endoscopy: '#0d9488',
  genetic: 'green',
  flow: 'magenta',
  bonemarrow: 'volcano',
  pathology: 'brown',
  discharge: 'blue',
  cert: 'gold',
  other: 'default',
}

// 检查 tab 的筛选条只列**检查报告**的种类：基因 / 流式 / 骨髓形态已按类型归为检验
// （LAB_DOC_KINDS，见 docKinds.js），它们现在出现在检验 tab 的清单里，不再属于这里。
// 从 DOC_KINDS 派生而不是手写数组：手写数组就是漂移源（2026-10-27 分类改动时被发现写死 11 项）。
const KIND_FILTER_LABEL = {
  all: '全部',
  ...Object.fromEntries(
    DOC_KINDS.filter((k) => !CASE_KINDS.includes(k.value) && !LAB_DOC_KINDS.includes(k.value)).map((k) => [
      k.value,
      k.label,
    ])
  ),
}

// AI 识别状态（doc.ai 由检查报告 AI 主识别链路写入；老记录无该字段 = 未 AI，零迁移）
//   ai.engine==='ai'  → 走过 AI 精读（悬停可看置信度 / 引文覆盖 / 用时 / 任务号）
//   ai.engine==='ocr' → 只做过本地识别
//   无 ai 字段         → 改造前的历史记录
function aiBadge(d) {
  const a = d.ai
  if (a && a.engine === 'ai') {
    const conf = { high: '高', medium: '中', low: '低' }[a.confidence] || a.confidence || '未标注'
    return {
      key: 'ai',
      label: 'AI 已识别',
      cls: 'bg-brand-50 text-brand-700 border-brand-200',
      title: `AI ${a.mode === 'text' ? '文本整理' : '读原图'} · 置信度 ${conf}${
        a.evidence_count ? ` · 引文 ${a.evidence_count} 条` : ''
      }${a.elapsed_ms ? ` · 用时 ${Math.round(a.elapsed_ms / 1000)}s` : ''}${a.at ? ` · ${String(a.at).slice(0, 16).replace('T', ' ')}` : ''}`,
    }
  }
  if (a && a.engine === 'ocr') return { key: 'ocr', label: '本地识别', cls: 'bg-slate-100 text-slate-500 border-slate-200', title: '仅本地识别结果' }
  return { key: 'none', label: '未 AI', cls: 'bg-white text-slate-400 border-slate-200', title: '改造前归档的历史记录，可打开详情点「AI 重读」' }
}

export default function DocsSection({ docs, onOpen }) {
  const [kindFilter, setKindFilter] = useState('all')
  const [aiFilter, setAiFilter] = useState('all')
  const [visibleLimit, setVisibleLimit] = useState(50)

  const sorted = useMemo(
    () => [...docs].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1)),
    [docs]
  )

  const kinds = Object.keys(KIND_FILTER_LABEL)
  const categories = useMemo(() => {
    const counts = kinds
      .filter((k) => k !== 'all')
      .map((k) => ({ value: k, label: KIND_FILTER_LABEL[k], count: docs.filter((d) => d.kind === k).length }))
      .filter((c) => c.count > 0)
    // 规模策略（用户 2026-10-27）：只有 1 份的种类并入「其他」，不占一条筛选位
    return [{ value: 'all', label: KIND_FILTER_LABEL.all, count: docs.length, members: ['all'] }, ...applyCategorySizePolicy(counts)]
  }, [docs])
  // 「其他」要能命中被折叠的种类（members 里带着它们的 kind）
  const activeMembers = useMemo(() => {
    const c = categories.find((x) => x.value === kindFilter)
    return c && c.members ? c.members : [kindFilter]
  }, [categories, kindFilter])

  // 文本检索与时间区间由报告页统一施加（`docs` 传进来就是命中的集合，见 utils/reportFilter.js），
  // 这里只保留自己这一层的「报告种类 + AI 状态」筛选。
  const filtered = useMemo(
    () =>
      sorted.filter((d) => {
        if (kindFilter !== 'all' && !activeMembers.includes(d.kind)) return false
        if (aiFilter !== 'all' && aiBadge(d).key !== aiFilter) return false
        return true
      }),
    [sorted, kindFilter, aiFilter, activeMembers]
  )

  return (
    <>
      {/* 无可展示的报告（库里空 或 报告页的搜索/时间条件没命中）时，不渲染全 0 的分类条与 AI 状态条 —— 
          零命中还挂一排「0」按钮既误导又占高度，此时只留一句说明 */}
      {docs.length > 0 && (
        <>
          <SectionFilterBar
            tabsOnly
            categories={categories}
            value={kindFilter}
            onChange={setKindFilter}
            onResetPaging={() => setVisibleLimit(50)}
          />

          {/* AI 识别状态筛选（存量清理用：一眼看出哪些报告还没让 AI 读过） */}
          <div className="flex items-center gap-1.5 px-0.5 pb-2 -mt-1">
        <span className="text-[11px] text-slate-400 shrink-0">AI 状态</span>
        {[
          ['all', '全部', docs.length],
          ['ai', 'AI 已识别', docs.filter((d) => aiBadge(d).key === 'ai').length],
          ['ocr', '本地识别', docs.filter((d) => aiBadge(d).key === 'ocr').length],
          ['none', '未 AI', docs.filter((d) => aiBadge(d).key === 'none').length],
        ].map(([k, label, n]) => (
          <button
            key={k}
            type="button"
            data-testid={`doc-ai-filter-${k}`}
            onClick={() => {
              setAiFilter(k)
              setVisibleLimit(50)
            }}
            className={`text-[11px] rounded border px-2 py-0.5 transition-colors ${
              aiFilter === k ? 'border-brand-300 bg-brand-50 text-brand-700 font-medium' : 'border-slate-200 text-slate-500 hover:text-slate-700'
            }`}
          >
            {label} {n}
          </button>
            ))}
          </div>
        </>
      )}

      {filtered.length === 0 ? (
        docs.length === 0 ? (
          <Empty
            className="py-10"
            description={
              <div className="text-sm text-slate-400">
                <p className="mb-1">暂无检查报告</p>
                <p className="text-xs">
                  可能还没归档，或当前搜索 / 时间条件没有命中；用上方「＋ 导入检查报告」上传 PDF 原件会自动提取索引
                </p>
              </div>
            }
          />
        ) : (
          <Empty className="py-10" description="当前分类下没有报告" />
        )
      ) : (
        <List
          dataSource={filtered.slice(0, visibleLimit)}
          split
          renderItem={(d) => {
            // 统一口径：Tag = 部位 + 模态（如「胸部 CT」「下肢 超声」），标题位只放有信息量的标题；
            // 模板抬头（…检查报告单 / 只剩医院名）不再占位。见 utils/docHeading.js。
            const h = docHeading(d)
            return (
            <List.Item
              key={d.id}
              className="cursor-pointer hover:bg-slate-50 rounded-lg px-2 -mx-2 transition-colors"
              onClick={() => onOpen(d)}
            >
              <div className="flex items-start gap-3 w-full">
                <Tag color={KIND_COLOR[d.kind] || KIND_COLOR.other} className="mt-0.5 shrink-0">
                  {h.tag || d.kind}
                </Tag>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    {h.main && (
                      <span className="text-sm font-medium text-slate-800 truncate">{h.main}</span>
                    )}
                    <span className="text-xs text-slate-400 shrink-0">{d.date}</span>
                    {d.reported_at && d.reported_at.slice(0, 10) !== d.date && (
                      <span className="text-[10px] text-slate-400 bg-slate-100 rounded px-1.5 py-0.5 shrink-0">
                        报告 {d.reported_at}
                      </span>
                    )}
                    {d.is_scanned && <span className="text-[10px] text-amber-500 shrink-0">扫描件</span>}
                    {(() => {
                      const b = aiBadge(d)
                      return (
                        <span
                          className={`text-[10px] border rounded px-1.5 py-0.5 shrink-0 ${b.cls}`}
                          title={b.title}
                          data-testid={`doc-ai-badge-${b.key}`}
                        >
                          {b.label}
                        </span>
                      )
                    })()}
                    <AssetBadge entity={d} noun="原件" />
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                    {d.conclusion || d.findings || d.notes || '（无提取内容）'}
                  </p>
                  {d.kind === 'ecg' ? (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {d.measures
                        .filter((m) => ['心率', 'QTc间期', 'P-QRS-T电轴'].includes(m.name))
                        .map((m, i) => (
                          <span
                            key={i}
                            className={`text-[11px] px-1.5 py-0.5 rounded ${
                              m.flag ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {m.name} {m.value}
                            {m.unit}
                            {m.flag}
                          </span>
                        ))}
                    </div>
                  ) : (
                    d.measures &&
                    d.measures.length > 0 && (
                      <p className="text-[11px] text-slate-400 mt-1 truncate">
                        {d.measures.map((m) => `${m.name} ${m.value}${m.unit}`).join(' · ')}
                      </p>
                    )
                  )}
                </div>
              </div>
            </List.Item>
            )
          }}
        />
      )}
      {filtered.length > visibleLimit && (
        <div className="pt-3 text-center">
          <Button type="link" onClick={() => setVisibleLimit((n) => n + 50)}>
            显示更多（还有 {filtered.length - visibleLimit} 条）
          </Button>
        </div>
      )}
    </>
  )
}
