import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Badge, Card, Col, Descriptions, Empty, Row, Segmented, Space,
  Statistic, Table, Tag, Timeline, Typography,
} from 'antd'
import BookingPage from './BookingPage.jsx'

const { Title, Text, Paragraph } = Typography

// 迁移状态：done = 已在 React 内重建；todo = 仍是旧 index.html 里的实现，迁移中
const TABS = [
  { key: 'monitor', label: '排班监控', state: 'done' },
  { key: 'guahao', label: '114 挂号', state: 'done' },
  { key: 'brief', label: '病历整理', state: 'todo' },
  { key: 'orders', label: '预约凭证', state: 'todo' },
  { key: 'auth', label: '登录凭据', state: 'todo' },
]

async function jfetch(url, opts) {
  const r = await fetch(url, opts)
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`)
  return j
}

// ---------- 排班监控（旧 index.html 的 tab-monitor 重建）----------
function MonitorPane() {
  const [live, setLive] = useState(null)
  const [countdown, setCountdown] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [a, b] = await Promise.all([
        jfetch('/api/guahao/monitor/realtime'),
        jfetch('/api/guahao/monitor/countdown'),
      ])
      setLive(a)
      setCountdown(b)
      setError('')
    } catch (e) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const columns = useMemo(() => [
    { title: '院区/科室', dataIndex: 'department', width: 170 },
    { title: '时段', dataIndex: 'period', width: 70 },
    { title: '日期', dataIndex: 'dateHeader', width: 110 },
    { title: '等级', dataIndex: 'level', width: 100 },
    { title: '费用', dataIndex: 'fee', width: 80, render: (v) => (v ? `¥${v}` : '—') },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (v, r) => (v === 'active'
        ? <Tag color="green">{r.statusText || '出诊'}</Tag>
        : <Tag color="red">{r.statusText || '停诊'}</Tag>),
    },
  ], [])

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message="排班加载失败" description={error} />}
      <Row gutter={12}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="出诊槽位" value={live?.activeCount ?? '—'} valueStyle={{ color: '#237804' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="停诊槽位" value={live?.suspendedCount ?? '—'} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="距 07:00 放号" value={countdown?.countdown ?? '—'} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="目标就诊日" value={countdown?.targetDateForBooking ?? '—'} />
          </Card>
        </Col>
      </Row>
      <Card
        size="small"
        title={`${live?.hospital || '首都医科大学附属北京朝阳医院'} · ${live?.doctor || '主鸿鹄'} 出诊排班`}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>{loading ? '加载中…' : live?.lastFetchedAt || ''}</Text>}
      >
        <Table
          size="small"
          rowKey={(r) => `${r.department}-${r.dateHeader}-${r.period}`}
          columns={columns}
          dataSource={live?.slots || []}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无排班数据" /> }}
        />
        {live?.ruleNotice && (
          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            {live.ruleNotice}
          </Paragraph>
        )}
      </Card>
      <Alert
        type="info"
        showIcon
        message="数据来源"
        description={live?.source || '朝阳医院官网 Index_1220.html 实时抓取'}
      />
    </Space>
  )
}

function TodoPane({ title, legacyTab }) {
  return (
    <Card>
      <Title level={5}>{title}</Title>
      <Timeline
        items={[
          { color: 'green', children: '排班监控：已在 React 内重建（组件化 + antd 表格）' },
          { color: 'green', children: '114 挂号：已迁入（原 /guahao 页面，去掉 iframe 嵌套）' },
          { color: 'blue', children: `${title}：迁移中，当前仍由旧版页面提供` },
        ]}
      />
      <Paragraph type="secondary">
        迁移期间旧版页面照常可用：
        {' '}
        <a href={`/?tab=${legacyTab}`}>打开旧版 {title}</a>
        {' '}（旧版入口在全部 tab 迁移完成后下线）
      </Paragraph>
    </Card>
  )
}

export default function App() {
  const [tab, setTab] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('tab')
    return TABS.some((t) => t.key === q) ? q : 'monitor'
  })

  // 与旧版 index.html 的 switchTab 行为对齐：切 tab 写进 URL，可刷新/分享
  const onTab = (key) => {
    setTab(key)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', key)
    window.history.replaceState(null, '', url.toString())
  }

  const bodyRef = useRef(null)
  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' })
  }, [tab])

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', padding: '16px 16px 48px' }} ref={bodyRef}>
      <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          MedBrief · 挂号与问诊资料工作台
        </Title>
        <Text type="secondary" style={{ fontSize: 12 }}>
          面向白血病与重大血液病患者 · 目标：北京朝阳医院 血液科 主鸿鹄
        </Text>
      </Space>

      <Segmented
        block
        value={tab}
        onChange={onTab}
        options={TABS.map((t) => ({
          value: t.key,
          label: (
            <Space size={6}>
              <span>{t.label}</span>
              <Badge status={t.state === 'done' ? 'success' : 'processing'} />
            </Space>
          ),
        }))}
        style={{ marginBottom: 16 }}
      />

      {tab === 'monitor' && <MonitorPane />}
      {tab === 'guahao' && <BookingPage />}
      {tab === 'brief' && <TodoPane title="病历整理" legacyTab="brief" />}
      {tab === 'orders' && <TodoPane title="预约凭证" legacyTab="orders" />}
      {tab === 'auth' && <TodoPane title="登录凭据" legacyTab="sniper" />}
    </div>
  )
}
