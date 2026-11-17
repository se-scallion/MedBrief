// 报告库 · ≤575px 按天分组列表（v0.4 终审通过版）
//
// 设计口径（逐条对应 .agents/reportlib-ui-1116-plan.md v0.4）：
//  · antd List split={false} 自绘 section（不做成另一张表）；组头只写一次日期
//  · 日期键 = String(reportDate||'').slice(0,10)，空值单独「日期未识别」组；
//    绝不 dayjs(undefined)（会悄悄归今天）、绝不复用 dateKeyOf 的 createdAt 兜底
//  · 主行是真实 <button>（不 div 套 button），内部只放纯文本 + <sup aria-hidden>；
//    Tag/图标一律放次行，可访问名不含次行文案
//  · 全文型 Tag 恒在；推断=小上标、无原件=图标位；次行文本标记 ≤2
//  · 操作区 stopPropagation，点按钮不开抽屉；2026-11-17 删除按钮已移出列表
//  · 2026-11-17：manage 开关下线（删除移到详情抽屉），列表不再有管理态
//  · 按组分页：Pagination.total=组数，showTotal 覆盖「共 X 份 · Y 天」
//
// 零新增依赖：图标用内联 SVG（项目既有惯例，见 TrendsTab.jsx / SourceModal.jsx）。

import React, { useMemo, useState } from 'react'
import { Badge, Button, Empty, List, Pagination, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'

const { Text } = Typography

// ---------------- 内联 SVG 图标（纯展示，aria-hidden；按钮的 aria-label 在父级） ----------------
const Svg = ({ d, size = 16, ...rest }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
    <path d={d} />
  </svg>
)
export const ICONS = {
  view: <Svg d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />,
  edit: <Svg d="M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  file: <Svg d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6" />,
  trash: <Svg d="M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14 M10 11v5 M14 11v5" />,
  restore: <Svg d="M3 12a9 9 0 1 0 3-6.7 M3 4v5h5" />,
  purge: <Svg d="M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14 M10 11v5 M14 11v5 M5 2l14 20" />,
  noFile: <Svg d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6 M4 4l16 16" />,
}

/** 32px 热区图标按钮：纯图标、带 aria-label，不引入 @ant-design/icons */
export function IconBtn({ icon, label, danger, loading, onClick, stop = true, ...rest }) {
  return (
    <Button
      type="text" size="small" aria-label={label} title={label} danger={danger} loading={loading}
      style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
      onClick={(e) => { if (stop) e.stopPropagation(); onClick?.(e) }}
      {...rest}
    >{icon}</Button>
  )
}

/** 日期分组键：只认 reportDate，空值归 '__none__'（绝不今天、绝不 createdAt） */
export const dayKeyOf = (r) => String(r?.reportDate || '').slice(0, 10) || '__none__'

export function groupByDay(rows = []) {
  const map = new Map()
  for (const r of rows || []) {
    const k = dayKeyOf(r)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  // 真实日期按字符串降序（最新在前）；未识别组恒末位（与 sortReports 的「缺值恒末位」同口径）
  const keys = [...map.keys()].sort((a, b) => {
    if (a === '__none__') return 1
    if (b === '__none__') return -1
    return b.localeCompare(a, 'zh-Hans-CN')
  })
  return keys.map((key) => ({ key, rows: map.get(key) }))
}

const fmtDay = (key) => {
  if (key === '__none__') return { title: '日期未识别', sub: '按入库时间', badge: null }
  const d = dayjs(key, 'YYYY-MM-DD')
  if (!d.isValid()) return { title: key, sub: '', badge: null }
  return { title: key, sub: d.locale('zh-cn').format('ddd'), badge: null }
}

/** 次行文本标记：全文型恒在；其余最多再 1 个（v0.4 r3） */
const secondaryTags = (r) => {
  const out = []
  if (!(Array.isArray(r.rows) && r.rows.length)) out.push(<Tag key="full" color="default" style={{ marginInlineEnd: 0 }}>全文型</Tag>)
  if (r.inferredText) out.push(<Text key="hit" type="secondary" style={{ fontSize: 11 }}>{r.inferredText}</Text>)
  return out.slice(0, 2)
}

export default function ReportDayList({
  rows = [], tab = 'active', acting = '', q = '',
  onOpen, onEdit, onBlob, onDelete, onRestore, onPurge,
  groupsPerPage = 7,
}) {
  const [page, setPage] = useState(1)
  const groups = useMemo(() => groupByDay(rows), [rows])
  const pageCount = Math.max(1, Math.ceil(groups.length / groupsPerPage))
  const safePage = Math.min(page, pageCount)
  const shown = groups.slice((safePage - 1) * groupsPerPage, safePage * groupsPerPage)
  const totalRecords = rows.length
  const emptyText = q ? `没有匹配「${q}」的报告` : (tab === 'trash' ? '回收站是空的' : '还没有入库的报告，先去「资料录入」上传')

  if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />

  return (
    <div className="rb-day-wrap">
      <List
        split={false}
        dataSource={shown}
        rowKey={(g) => g.key}
        renderItem={(g) => {
          const head = fmtDay(g.key)
          return (
            <section className="rb-day-section" data-day={g.key} key={g.key}>
              <header className="rb-day-head">
                <span className="rb-day-date">{head.title}</span>
                {head.sub && <span className="rb-day-week">{head.sub}</span>}
                <Badge count={g.rows.length} showZero overflowCount={99} style={{ backgroundColor: '#e6f0ff', color: '#1d4ed8', fontSize: 11 }} />
              </header>
              <div className="rb-day-rows">
                {g.rows.map((r) => {
                  const inferred = !!r.reportTypeInferred
                  const noOriginal = r.hasOriginal === false || !r.fileBlobId
                  const tags = secondaryTags(r)
                  return (
                    <div className="rb-day-row" key={r.id} data-report-id={r.id}
                      // 2026-11-17 UI 规格：整行可点（52px ≥44），不再只有 22px 的 .rb-day-main；
                      // 操作区已 stopPropagation，按钮不误触。
                      onClick={() => onOpen?.(r.id)}>
                      {/* 主行：纯展示（整行已可点），保留 button 供键盘/读屏 */}
                      <button type="button" className="rb-day-main" onClick={(e) => { e.stopPropagation(); onOpen?.(r.id) }}
                        aria-label={`查看报告 ${r.id}：${kindName(r)}`}>
                        <span className="rb-day-type">{kindName(r) || '—'}</span>
                        {inferred && <sup aria-hidden="true" className="rb-day-inferred">?</sup>}
                      </button>
                      <div className="rb-day-sub">
                        {tags}
                        {noOriginal && <Tooltip title="入库时未保存原图字节，无法回看/重识别"><span className="rb-day-icon" aria-label="无原件">{ICONS.noFile}</span></Tooltip>}
                        {g.key === '__none__' && <Text type="secondary" style={{ fontSize: 11 }}>入库 {fmtWhen(r.createdAt)}</Text>}
                      </div>
                      <div className="rb-day-actions" onClick={(e) => e.stopPropagation()}>
                        {/* 2026-11-17：眼睛「查看」删掉（整行已可点，重复）；删除移到详情抽屉底部（防误触） */}
                        {r.fileBlobId && <IconBtn icon={ICONS.file} label="查看原件" onClick={() => onBlob?.(r)} />}
                        {tab === 'active' ? (
                          <IconBtn icon={ICONS.edit} label="编辑" onClick={() => onEdit?.(r.id)} />
                        ) : (
                          <>
                            <Popconfirm title="恢复到报告库？" okText="恢复" cancelText="取消" onConfirm={() => onRestore?.(r.id)}>
                              <IconBtn icon={ICONS.restore} label="恢复" loading={acting === r.id} stop={false} />
                            </Popconfirm>
                            <Popconfirm title="彻底删除？不可恢复。" okText="彻底删除" cancelText="取消"
                              okButtonProps={{ danger: true }} onConfirm={() => onPurge?.(r.id)}>
                              <IconBtn icon={ICONS.purge} label="彻底删除" danger loading={acting === r.id} stop={false} />
                            </Popconfirm>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        }}
      />
      {groups.length > groupsPerPage && (
        <div className="rb-day-pager">
          <Pagination
            size="small" current={safePage} pageSize={groupsPerPage} total={groups.length}
            showSizeChanger={false}
            showTotal={() => `共 ${totalRecords} 份 · ${groups.length} 天`}
            onChange={(p) => setPage(p)}
          />
        </div>
      )}
    </div>
  )
}

const kindName = (r) => String(r?._typeLabel || r?.reportType || r?.kind || '').trim()
const fmtWhen = (iso) => {
  const t = String(iso || '')
  return /^\d{4}-\d{2}-\d{2}T/.test(t) ? `${t.slice(5, 10)} ${t.slice(11, 16)}` : t.slice(0, 10)
}
