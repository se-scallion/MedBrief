// CardPreview —— 只管「资料卡展示与打印」（2026-11-14 从 ProfilePanel 拆出）
// 职责边界：只接收已生成好的 card；生成、存档、脱敏开关的副作用都由调用方处理。
import React from 'react'
import { Card, Empty, Space, Spin, Switch, Tag, Typography } from 'antd'

const { Text } = Typography

export default function CardPreview({ card, loading, mask, onMaskChange, iframeRef }) {
  return (
    <Card size="small" title="② 资料卡预览"
      extra={
        <Space>
          <Text style={{ fontSize: 12 }}>脱敏</Text>
          <Switch size="small" checked={mask} onChange={onMaskChange} />
        </Space>
      }
    >

      {loading ? (
        <Space>
          <Spin size="small" />
          <Text type="secondary">生成中…</Text>
        </Space>
      ) : card?.html ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap align="center">
            <Tag color={card.masked ? 'green' : 'orange'}>{card.masked ? '已脱敏（姓名打码）' : '未脱敏'}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              报告 {card.counts?.reports ?? 0} 份 · 指标 {card.counts?.latest ?? card.counts?.rows ?? 0} 项 ·
              异常 {(card.counts?.p0 ?? 0) + (card.counts?.p1 ?? 0)} 项
              {card.counts?.staleDays > 90 ? ` · ⚠️ 最新化验距今 ${card.counts.staleDays} 天` : ''}
            </Text>
          </Space>
          <iframe
            ref={iframeRef}
            title="问诊资料卡预览"
            srcDoc={card.html}
            style={{ width: '100%', height: 'min(78vh, 1180px)', border: '1px solid #f0f0f0', borderRadius: 8, background: '#fff' }}
          />
        </Space>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成资料卡" />
      )}
    </Card>
  )
}
