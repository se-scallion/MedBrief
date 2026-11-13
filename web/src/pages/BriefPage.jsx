import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import { jget, jpost } from '../api.js'
import { useLog } from '../App.jsx'

const { Text, Paragraph } = Typography

const STATUS_TAG = {
  HIGH: <Tag color="red">偏高</Tag>,
  LOW: <Tag color="blue">偏低</Tag>,
  NORMAL: <Tag color="green">正常</Tag>,
}

const LABEL = {
  WBC: '白细胞 WBC',
  PLT: '血小板 PLT',
  Hb: '血红蛋白 Hb',
  BM_BLAST_PCT: '骨髓原始细胞比例',
  FCM_MRD_PCT: '流式 MRD',
  NEUT_ABS: '中性粒细胞绝对值',
  HS_CRP: '超敏 CRP',
  BCR_ABL1_RATIO: 'BCR-ABL1 比值',
}

export default function BriefTab() {
  const { message } = AntApp.useApp()
  const { pushLog } = useLog()
  const [summary, setSummary] = useState(null)
  const [summaryErr, setSummaryErr] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)

  const [brief, setBrief] = useState(null)
  const [briefLoading, setBriefLoading] = useState(false)

  const [bundle, setBundle] = useState(null)
  const [bundleLoading, setBundleLoading] = useState(false)
  const [form] = Form.useForm()
  const fileRef = useRef(null)

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryErr(null)
    try {
      const j = await jget('/api/meddata/summary')
      if (j.unavailable) {
        setSummary(null)
        setSummaryErr(j)
        pushLog(`本机 MedData 不可用：${j.reason}，已切到「导入 .meddata 文件」`, 'warn')
      } else {
        setSummary(j)
        pushLog(`已从本机 MedData 载入 ${Object.keys(j.latest || {}).length} 项最新指标`, 'ok')
      }
    } catch (e) {
      setSummary(null)
      setSummaryErr({ reason: e.message, hint: '改用导入 .meddata 文件' })
    } finally {
      setSummaryLoading(false)
    }
  }, [pushLog])

  const loadBrief = useCallback(async () => {
    setBriefLoading(true)
    try {
      const j = await jget('/api/brief/visit-summary?limit=3')
      setBrief(j)
      pushLog(`已生成一页速览（数据源：${j.meta?.sourceLabel || '未知'}）`, 'ok')
    } catch (e) {
      message.error(e.message)
    } finally {
      setBriefLoading(false)
    }
  }, [message, pushLog])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  const importFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const content = await file.text()
      const j = await jpost('/api/brief/import', { content })
      pushLog(`已导入 ${file.name}（${j.summary?.records ?? '?'} 条记录）`, 'ok')
      message.success('导入成功')
      loadBrief()
    } catch (err) {
      message.error(err.message)
    } finally {
      e.target.value = ''
    }
  }

  const exportBundle = async (values) => {
    setBundleLoading(true)
    try {
      const j = await jpost('/api/brief/bundle', {
        patient: {
          name: values.name,
          idCard: values.idCard,
          diagnosis: values.diagnosis,
        },
        chiefComplaint: values.chiefComplaint,
        presentIllness: values.presentIllness,
      })
      setBundle(j)
      pushLog(`已生成交换包 ${j.filename}，SHA-256 ${String(j.sha256).slice(0, 12)}…`, 'ok')
      message.success('交换包已生成')
    } catch (e) {
      message.error(e.message)
    } finally {
      setBundleLoading(false)
    }
  }

  const download = () => {
    if (!bundle) return
    const blob = new Blob([JSON.stringify(bundle.bundle, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = bundle.filename
    a.click()
    URL.revokeObjectURL(a.href)
    pushLog(`已下载 ${bundle.filename}`, 'ok')
  }

  const latestRows = Object.entries(summary?.latest || {}).map(([code, v]) => ({
    key: code,
    label: v.label || LABEL[code] || code,
    value: v.value,
    unit: v.unit,
    refRange: v.refRange,
    date: v.date,
    status: v.status,
  }))

  return (
    <div>
      <Card
        size="small"
        title="就诊前 · 从 MedData 载入近期指标"
        extra={
          <Space>
            <Button size="small" type="primary" loading={summaryLoading} onClick={loadSummary}>
              从本地 MedData 载入
            </Button>
            <Button size="small" onClick={() => fileRef.current?.click()}>
              导入 .meddata 文件
            </Button>
            <input ref={fileRef} type="file" accept=".meddata,application/json" style={{ display: 'none' }} onChange={importFile} />
          </Space>
        }
      >
        {summaryLoading ? (
          <Spin />
        ) : summaryErr ? (
          <Alert
            type="warning"
            showIcon
            message={summaryErr.reason || '本机 MedData 数据服务不可用'}
            description={summaryErr.hint || '改用「导入 .meddata 文件」，功能不受影响。'}
          />
        ) : latestRows.length === 0 ? (
          <Empty description="尚无数据，点上方按钮载入" />
        ) : (
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={latestRows}
            columns={[
              { title: '指标', dataIndex: 'label' },
              {
                title: '最新值',
                dataIndex: 'value',
                render: (v, r) => (
                  <Space size={4}>
                    <Text strong>{v}</Text>
                    <Text type="secondary">{r.unit}</Text>
                    {STATUS_TAG[r.status] || null}
                  </Space>
                ),
              },
              { title: '参考区间', dataIndex: 'refRange', render: (v) => v || '—' },
              { title: '日期', dataIndex: 'date', width: 110 },
            ]}
          />
        )}
      </Card>

      <Card
        size="small"
        style={{ marginTop: 16 }}
        title="本次就诊一页速览（只陈述数值与趋势，不含诊断结论）"
        extra={
          <Button size="small" loading={briefLoading} onClick={loadBrief}>
            生成 / 刷新速览
          </Button>
        }
      >
        {briefLoading ? (
          <Spin />
        ) : !brief ? (
          <Empty description="点「生成 / 刷新速览」（需先载入指标或导入 .meddata）" />
        ) : (
          <>
            <Descriptions size="small" column={2} style={{ marginBottom: 8 }}>
              <Descriptions.Item label="就诊人">{brief.meta?.patientName || '未填'}</Descriptions.Item>
              <Descriptions.Item label="年龄 / 性别">
                {brief.meta?.age ?? '—'} 岁 / {brief.meta?.gender === 'Male' ? '男' : brief.meta?.gender || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="诊断" span={2}>
                {brief.meta?.diagnosis || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="数据源" span={2}>
                <Space>
                  <Tag color="blue">{brief.meta?.sourceLabel || '—'}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    生成于 {brief.meta?.generatedAt ? new Date(brief.meta.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
                  </Text>
                </Space>
              </Descriptions.Item>
            </Descriptions>
            <Row gutter={12}>
              {Object.entries(brief.series || {}).map(([code, rows]) => (
                <Col xs={24} lg={12} key={code}>
                  <Card size="small" style={{ marginBottom: 12 }} title={LABEL[code] || code}>
                    <Table
                      size="small"
                      rowKey={(r) => `${code}-${r.date}-${r.value}`}
                      pagination={false}
                      dataSource={rows}
                      columns={[
                        { title: '日期', dataIndex: 'date', width: 110 },
                        {
                          title: '结果',
                          render: (_, r) => (
                            <Space size={4}>
                              <Text strong>{r.value}</Text>
                              <Text type="secondary">{r.unit}</Text>
                            </Space>
                          ),
                        },
                        { title: '趋势', dataIndex: 'trend', width: 60, render: (v) => v || '—' },
                        { title: '判读', dataIndex: 'status', width: 70, render: (v) => STATUS_TAG[v] || '—' },
                      ]}
                    />
                  </Card>
                </Col>
              ))}
            </Row>
            <Divider style={{ margin: '4px 0 12px' }} />
            <Paragraph style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginBottom: 8 }} copyable={{ text: brief.text }}>
              {brief.text}
            </Paragraph>
            <Space>
              <Button size="small" onClick={() => window.print()}>
                打印速览
              </Button>
            </Space>
          </>
        )}
      </Card>

      <Card size="small" style={{ marginTop: 16 }} title="就诊后 · 导出 .meddata 交换包">
        <Form form={form} layout="vertical" onFinish={exportBundle} initialValues={{ name: '', idCard: '', diagnosis: '急性B淋巴细胞白血病 (B-ALL)' }}>
          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Form.Item name="name" label="就诊人姓名" rules={[{ required: true, message: '请填写姓名' }]}>
                <Input allowClear placeholder="例：代聪" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="idCard" label="身份证">
                <Input allowClear maxLength={18} placeholder="18 位（可留空）" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="diagnosis" label="诊断">
                <Input allowClear />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="chiefComplaint" label="主诉">
            <Input.TextArea rows={2} placeholder="例：确诊 B-ALL 1 年余，拟复查 MRD" />
          </Form.Item>
          <Form.Item name="presentIllness" label="现病史 / 本次想问的问题">
            <Input.TextArea rows={3} placeholder="时间线、用药、当前指标异常与想确认的问题" />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={bundleLoading}>
              生成交换包
            </Button>
            <Button disabled={!bundle} onClick={download}>
              下载 {bundle?.filename || '.meddata'}
            </Button>
            {bundle && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                SHA-256 {String(bundle.sha256).slice(0, 16)}…
              </Text>
            )}
          </Space>
        </Form>
      </Card>
    </div>
  )
}
