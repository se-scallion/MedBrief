// 全病程原件轴（Tab 3）
//
// 用户口径（2026-11-14）：打印版第 2 页不再有材料清单，影像/病理/基因这些不在卡面出现的报告
// 需要在应用里能按日期回看 —— 这里按日期倒序串联**全部已导入报告**，点击直接开原件大图。
//
// 区分同一天多份报告（实测 2026-10-16 一天 8 份、其中 4 份都叫「磁共振-头颈」）：
// 摘要用「类型 · 报告单号 · 报告时间(时分)」，而不是只写类型 —— 单号/时间从报告 OCR 正文里取
// （实测 55 份中单号可提取 45 份、报告时间 47 份、项目名称 26 份），取不到就写「未识别」。
import React, { useMemo, useState } from 'react'
import { Card, Empty, Input, Segmented, Space, Table, Tag, Typography } from 'antd'

const { Text } = Typography

const KIND_LABEL = { lab: '化验', pathology: '病理/骨穿', imaging: '影像', discharge: '出院小结', drug: '用药', unknown: '其他' }

export default function TimelineTab({ card, onOpenSource }) {
  const [kind, setKind] = useState('全部')
  const [q, setQ] = useState('')
  const all = card?.timeline || []

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return all.filter((r) => {
      if (kind !== '全部' && KIND_LABEL[r.kind] !== kind) return false
      if (!kw) return true
      return [r.reportType, r.hospital, r.reportNo, r.itemName, r.summary]
        .filter(Boolean).join(' ').toLowerCase().includes(kw)
    })
  }, [all, kind, q])

  // 按日期分组（一天多份时给组头，避免视线反复横跳）
  const byDate = useMemo(() => {
    const m = new Map()
    for (const r of filtered) {
      const d = r.date || '日期未识别'
      if (!m.has(d)) m.set(d, [])
      m.get(d).push(r)
    }
    return [...m.entries()]
  }, [filtered])

  const open = (r) => onOpenSource({
    reportId: r.id, fileBlobId: r.fileBlobId, name: r.itemName || r.reportType || '报告原件',
    date: r.date, hospital: r.hospital,
  })

  if (!all.length) return <Empty description="还没有导入任何报告" />

  const columns = [
    { title: '报告时间', dataIndex: 'reportTime', width: 150, render: (v, r) => v || <Text type="secondary">{r.date}</Text> },
    { title: '类型', dataIndex: 'reportType', width: 120, render: (v, r) => v || KIND_LABEL[r.kind] || '—' },
    {
      title: '摘要',
      render: (_, r) => (
        <Space size={6} wrap>
          <span>{r.summary}</span>
          {r.reportNo ? <Text type="secondary" style={{ fontSize: 12 }}>单号 {r.reportNo}</Text> : null}
          {r.itemName ? <Text type="secondary" style={{ fontSize: 12 }}>· {r.itemName}</Text> : null}
        </Space>
      ),
    },
    { title: '医院', dataIndex: 'hospital', width: 150, ellipsis: true, render: (v) => v || <Text type="secondary">未记录</Text> },
    {
      title: '原件',
      width: 96,
      render: (_, r) => (r.hasBlob ? <Tag color="blue">原件 1 份</Tag> : <Tag>无原件</Tag>),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small" title={`全病程原件轴（${all.length} 份）`} extra={
        <Space wrap>
          <Input.Search allowClear size="small" placeholder="搜类型 / 单号 / 医院" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Segmented size="small" value={kind} onChange={setKind}
            options={['全部', '化验', '病理/骨穿', '影像', '出院小结', '用药']} />
        </Space>
      }>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {byDate.map(([date, list]) => (
            <div key={date}>
              <div style={{ fontWeight: 700, fontSize: 13, borderLeft: '3px solid #94a3b8', paddingLeft: 6, marginBottom: 2 }}>
                {date}
                <Text type="secondary" style={{ fontSize: 12, fontWeight: 400, marginInlineStart: 8 }}>{list.length} 份</Text>
              </div>
              <Table
                size="small"
                rowKey="id"
                dataSource={list}
                columns={columns}
                pagination={false}
                onRow={(r) => ({ onClick: () => open(r), style: { cursor: 'pointer' } })}
              />
            </div>
          ))}
          {!filtered.length && <Empty description="没有匹配的报告" />}
        </Space>
      </Card>
      <Text type="secondary" style={{ fontSize: 12 }}>
        说明：这里列出的是**导入时留存的全部报告**（含没有结构化数值的影像/病理原件）；点击任意一行看原件。
        打印版第 2 页不含材料清单（2026-11-13 用户口径：纸上点不了「原件」）。
      </Text>
    </Space>
  )
}
