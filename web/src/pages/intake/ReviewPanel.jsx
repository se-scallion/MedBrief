// ReviewPanel：从 IntakePage.jsx 原样切出的第 ② 块（2026-11-13 抽页，JSX 逐字未改）
import React from 'react'
import {
  Alert, App as AntApp, Button, Card, Col, Collapse, Divider, Empty, Form, Image,
  Input, Modal, Row, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography, Upload,
} from 'antd'
const { Dragger } = Upload
import { ST, KIND_OPTIONS, FLAG_TEXT, uid, fmtSize, rawJson, postJson } from './shared.js'

const { Text, Paragraph } = Typography
export default function ReviewPanel({ items, renderItemBody, batch, onBatchStop, onImportAll }) {
  const importable = items.filter((it) => !it.saved && Array.isArray(it.rows) && it.rows.length > 0).length
  // 3 + 4：识别校对与入库
  return (
    <Card size="small" title="② 识别与校对（每张可改可删，确认后入库）"
      extra={batch?.mode === 'import' ? (
        <Space>
          <Tag color="processing">导入中 {batch.done}/{batch.total}</Tag>
          <Button size="small" danger onClick={onBatchStop}>停止</Button>
        </Space>
      ) : (
        <Button size="small" type="primary" onClick={onImportAll}
          title={importable ? '逐张入库（疑似重复会自动跳过）' : '还没有可入库的条目：先识别并确认有指标行'}>
          一键导入全部{importable ? `（${importable}）` : ''}
        </Button>
      )}>
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先导入图片" />
      ) : (
        <Collapse
          accordion={false}
          items={items.map((item) => {
            const st = ST[item.status] || ST.pending
            return {
              key: item.id,
              label: (
                <Space size={8} wrap>
                  <Tag color={st.color}>{st.label}</Tag>
                  <Text style={{ fontSize: 12 }}>{item.name}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{item.rows.length} 行</Text>
                  {item.saved && <Tag color="green">已入库</Tag>}
                </Space>
              ),
              children: renderItemBody(item),
            }
          })}
        />
      )}
    </Card>
  )
}
