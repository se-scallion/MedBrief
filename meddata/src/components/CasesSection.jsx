// ===================== 病历文书列表（出院记录 / 诊断证明等） =====================
// 与检查报告平行但独立：按 category==='case' 过滤，子类型分色 Tag，全文检索覆盖结构化字段。

import { useMemo, useState } from 'react'
import { Tag, List, Empty, Button } from 'antd'
import SectionFilterBar from './SectionFilterBar.jsx'
import AssetBadge from './AssetBadge.jsx'

const KIND_COLOR = {
  discharge: 'blue',
  cert: 'gold',
  other: 'default',
}

const KIND_FILTER_LABEL = {
  all: '全部',
  discharge: '出院记录',
  cert: '诊断证明',
  other: '其他文书',
}

// 结构化字段中文标签（用于检索命中高亮与列表副标题）
const CASE_FIELD_LABEL = {
  discharge_date: '出院日期',
  admission_date: '入院日期',
  hospital_days: '住院天数',
  discharge_diagnosis: '出院诊断',
  discharge_advice: '出院医嘱',
  discharge_meds: '出院用药',
  diagnosis: '诊断',
  rest_days: '建议休息天数',
  department: '科室',
  doctor: '医师',
}

function fieldSummary(fields) {
  if (!fields) return ''
  return Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `${CASE_FIELD_LABEL[k] || k}：${v}`)
    .join(' · ')
}

export default function CasesSection({ docs, onOpen, onAddManual, onAdd }) {
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [visibleLimit, setVisibleLimit] = useState(50)

  const sorted = useMemo(
    () => [...docs].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1)),
    [docs]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sorted.filter((d) => {
      if (kindFilter !== 'all' && d.kind !== kindFilter) return false
      if (!q) return true
      // raw_text 全文已迁至 IndexedDB，搜索只覆盖轻量索引字段（含结构化 fields）
      const fieldsText = Object.values(d.fields || {}).join(' ')
      const hay = [d.doc_type, d.title, d.part, d.date, d.reported_at, d.findings, d.conclusion, d.notes, fieldsText]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [sorted, query, kindFilter])

  const kinds = ['all', 'discharge', 'cert', 'other']
  const categories = useMemo(
    () =>
      kinds.map((k) => ({
        value: k,
        label: KIND_FILTER_LABEL[k],
        count: docs.filter((d) => k === 'all' || d.kind === k).length,
      })),
    [docs]
  )

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <SectionFilterBar
        title="病历文书"
        total={docs.length}
        subtitle="出院记录 / 诊断证明等 · 原件完整保存本地 · 结构化字段可检索"
        searchPlaceholder="搜索：子类型 / 日期 / 出院诊断 / 出院医嘱 / 科室，如「B-ALL」「休息」…"
        query={query}
        onQueryChange={setQuery}
        categories={categories}
        value={kindFilter}
        onChange={setKindFilter}
        onResetPaging={() => setVisibleLimit(50)}
          />
        </div>
        {onAddManual && (
          <Button size="small" onClick={onAddManual} title="没有电子版文书时：粘贴出院小结文字自动解析，或直接填写字段">
            手动录入（无原件）
          </Button>
        )}
        {onAdd && (
          <Button size="small" type="primary" onClick={onAdd} title="上传出院记录 / 诊断证明原件，自动抽取结构化字段">
            ＋ 导入文书
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        docs.length === 0 ? (
          <Empty
            className="py-10"
            description={
              <div className="text-sm text-slate-400">
                <p className="mb-1">还没有病历文书</p>
                <p className="text-xs">点右上角「＋ 导入文书」上传出院记录 / 诊断证明，系统会自动抽取结构化字段</p>
              </div>
            }
          />
        ) : (
          <Empty className="py-10" description="未找到匹配的文书" />
        )
      ) : (
        <List
          dataSource={filtered.slice(0, visibleLimit)}
          split
          renderItem={(d) => (
            <List.Item
              key={d.id}
              className="cursor-pointer hover:bg-slate-50 rounded-lg px-2 -mx-2 transition-colors"
              onClick={() => onOpen(d)}
            >
              <div className="flex items-start gap-3 w-full">
                <Tag color={KIND_COLOR[d.kind] || KIND_COLOR.other} className="mt-0.5 shrink-0">
                  {d.doc_type || (d.kind === 'cert' ? '诊断证明' : '出院记录')}
                </Tag>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-slate-800 truncate">{d.title || d.doc_type || '未命名文书'}</span>
                    <span className="text-xs text-slate-400 shrink-0">{d.date}</span>
                    <AssetBadge entity={d} noun="原件" />
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                    {fieldSummary(d.fields) || d.conclusion || d.findings || d.notes || '（无提取内容）'}
                  </p>
                </div>
              </div>
            </List.Item>
          )}
        />
      )}
      {filtered.length > visibleLimit && (
        <div className="pt-3 text-center">
          <Button type="link" onClick={() => setVisibleLimit((n) => n + 50)}>
            显示更多（还有 {filtered.length - visibleLimit} 条）
          </Button>
        </div>
      )}
    </div>
  )
}
