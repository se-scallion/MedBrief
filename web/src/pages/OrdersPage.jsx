import React, { useCallback, useEffect, useState } from 'react'
import { App as AntApp, Button, Card, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import { jget, jpost } from '../api.js'
import { useLog } from '../App.jsx'

const { Text } = Typography

const STATUS_COLOR = { RESERVED: 'green', CANCELLED: 'default', FAILED: 'red' }

export default function OrdersTab() {
  const { message } = AntApp.useApp()
  const { pushLog } = useLog()
  const [loading, setLoading] = useState(false)
  const [orders, setOrders] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await jget('/api/guahao/orders')
      setOrders(j.orders || [])
    } catch (e) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  const cancel = async (orderId) => {
    try {
      await jpost('/api/guahao/cancel', { orderId })
      pushLog(`已取消本地订单 ${orderId}（号源已回滚）`, 'ok')
      message.success('已取消')
      load()
    } catch (e) {
      message.error(e.message)
    }
  }

  const columns = [
    { title: '预约单号', dataIndex: 'orderId', width: 190, render: (v) => <Text code>{v}</Text> },
    {
      title: '状态',
      dataIndex: 'statusLabel',
      width: 90,
      render: (v, r) => <Tag color={STATUS_COLOR[r.status] || 'blue'}>{v}</Tag>,
    },
    { title: '就诊人', dataIndex: 'patientName', width: 90 },
    { title: '医生', dataIndex: 'doctorName', width: 100 },
    {
      title: '就诊时间',
      width: 190,
      render: (_, r) => `${r.visitDate || ''} ${r.visitPeriodLabel || ''}`,
    },
    { title: '地点', dataIndex: 'location', ellipsis: true },
    {
      title: '操作',
      width: 100,
      render: (_, r) =>
        r.status === 'RESERVED' ? (
          <Popconfirm title="确认取消该预约？" onConfirm={() => cancel(r.orderId)}>
            <Button size="small" danger>
              取消
            </Button>
          </Popconfirm>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ]

  return (
    <Card
      size="small"
      title="预约记录"
      extra={
        <Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {orders.length} 条（本地演练订单，与 114 真实订单分开记）
          </Text>
          <Button size="small" loading={loading} onClick={load}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="orderId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={orders}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
      />
    </Card>
  )
}
