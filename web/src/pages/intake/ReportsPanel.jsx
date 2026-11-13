// ReportsPanel：从 IntakePage.jsx 原样切出的第 ④ 块（2026-11-13 抽页，JSX 逐字未改）
import React from 'react'
import {
  Alert, App as AntApp, Button, Card, Col, Collapse, Divider, Empty, Form, Image,
  Input, Modal, Row, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography, Upload,
} from 'antd'
const { Dragger } = Upload
import { ST, KIND_OPTIONS, FLAG_TEXT, uid, fmtSize, rawJson, postJson } from './shared.js'

const { Text, Paragraph } = Typography
export default function ReportsPanel({ reports, loadReports }) {
  // 已导入报告
  return (
    <Card size="small" title="已导入的报告" extra={<Button size="small" onClick={loadReports}>刷新</Button>}>
      {reports.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有入库的报告" />
      ) : (
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={reports}
          columns={[
            { title: '报告', dataIndex: 'id', width: 150 },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 100,
              render: (v) => KIND_OPTIONS.find((k) => k.value === v)?.label || v || '—',
            },
            { title: '日期', dataIndex: 'reportDate', width: 110, render: (v) => v || '—' },
            { title: '医院', dataIndex: 'hospital', render: (v) => v || '—' },
            {
              // 0 行 = 只存了原件、没解析出指标（影像报告等）——不许写「0」，否则像解析失败丢数据
              title: '指标 / 状态',
              dataIndex: 'rows',
              width: 130,
              render: (v, r) => {
                const n = Array.isArray(v) ? v.length : 0
                if (n > 0) return `${n} 项`
                return <Tag color="default">未结构化（仅存原件）</Tag>
              },
            },
            {
              title: '原件',
              dataIndex: 'fileBlobId',
              width: 90,
              render: (v, r) =>
                v ? (
                  <Button size="small" type="link" onClick={() => window.open(`/api/intake/blob/${encodeURIComponent(v)}`, '_blank')}>
                    查看原件
                  </Button>
                ) : (
                  <span style={{ color: '#9ca3af' }}>{r.source === 'text-only' ? '无原件' : '—'}</span>
                ),
            },
          ]}
        />
      )}
    </Card>
  )
}
