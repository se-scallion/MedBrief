// ProfilePanel：从 IntakePage.jsx 原样切出的第 ③ 块（2026-11-13 抽页，JSX 逐字未改）
import React from 'react'
import {
  Alert, App as AntApp, Button, Card, Col, Collapse, Divider, Empty, Form, Image,
  Input, Modal, Row, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography, Upload,
} from 'antd'
const { Dragger } = Upload
import { ST, KIND_OPTIONS, FLAG_TEXT, uid, fmtSize, rawJson, postJson } from './shared.js'

const { Text, Paragraph } = Typography
export default function ProfilePanel({ form, patient, patientSaving, savePatient, card, cardLoading, makeCard, mask, setMask, iframeRef, printCard, openCardInNewWindow, hideActions = false }) {
  // 5：资料卡
  return (
    <Card
      size="small"
      title="③ 病友信息与问诊资料卡"
      extra={
        <Space>
          <Text style={{ fontSize: 12 }}>脱敏打印</Text>
          <Switch
            size="small"
            checked={mask}
            onChange={(v) => {
              setMask(v)
              if (card) makeCard(v)
            }}
          />
        </Space>
      }
    >
      <Form form={form} layout="vertical" size="small">
        <Row gutter={12}>
          <Col xs={24} md={6}>
            <Form.Item name="name" label="姓名">
              <Input placeholder="病友姓名" />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="sex" label="性别">
              <Select allowClear options={[{ value: '男', label: '男' }, { value: '女', label: '女' }]} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="age" label="年龄">
              <Input placeholder="如 34" />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item name="diagnosis" label="诊断全称">
              <Input placeholder="如 急性B淋巴细胞白血病（B-ALL）" />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="subtype" label="分型 / 危险度">
              <Input placeholder="如 B-ALL 高危 / IKZF1 缺失" />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="stage" label="当前阶段">
              <Input placeholder="如 诱导缓解第 2 疗程" />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="hospital" label="就诊医院">
              <Input placeholder="如 北京朝阳医院" />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="attending" label="主管医生（可选）">
              <Input placeholder="可不填" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="focus" label="主诉 / 最担心的事">
              <Input.TextArea rows={2} placeholder="如：化疗后反复发热 2 周" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="confirm" label="想确认的问题">
              <Input.TextArea rows={2} placeholder="如：现在是否达到完全缓解" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="nextVisit" label="下一步该做什么">
              <Input.TextArea rows={2} placeholder="如：是否需要移植评估" />
            </Form.Item>
          </Col>
          {/* v3 第 1 页「临床背景与骨穿节点」：可选、只展示不推断；留空卡面写「未录入」 */}
          <Col xs={24} md={8}>
            <Form.Item name="lastChemo" label="近期治疗节点（可选）">
              <Input placeholder="如：VDCLP 方案第 12 天 / 上次化疗 9-20" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="recentTxOrGcsf" label="近期输血 / 升白针（可选）">
              <Input placeholder="如：9-22 输血小板 1 治疗量；9-25 起 G-CSF" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="marrowSummary" label="骨穿 / MRD 关键原句（可选）">
              <Input placeholder="如：7-17 流式 异常细胞 85.76%" />
            </Form.Item>
          </Col>
        </Row>
        {!hideActions && (
        <Space wrap>
          <Button onClick={savePatient} loading={patientSaving}>
            保存病友信息
          </Button>
          <Button type="primary" onClick={() => makeCard()} loading={cardLoading}>
            生成资料卡
          </Button>
          <Button onClick={printCard} disabled={!card?.html}>
            打印 / 存 PDF
          </Button>
          <Button onClick={openCardInNewWindow} disabled={!card?.html}>
            新窗口打开
          </Button>
          {patient?.updatedAt && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              档案更新于 {new Date(patient.updatedAt).toLocaleString('zh-CN')}
            </Text>
          )}
        </Space>
        )}
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          身份证、手机号、住址一律不收集（后端会直接丢弃这三类字段）。资料卡不含诊断结论与治疗建议。
        </Paragraph>
      </Form>

      <Divider style={{ margin: '12px 0' }} />

      {cardLoading ? (
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
