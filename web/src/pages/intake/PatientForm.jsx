// PatientForm —— 只管「病友档案录入」（2026-11-14 从 ProfilePanel 拆出，去掉 hideActions 反向开关）
// 职责边界：只渲染表单与保存动作；不碰卡片生成/打印（那是 CardPreview 的事）。
import React from 'react'
import { Button, Card, Col, Form, Input, Row, Select, Space, Typography } from 'antd'

const { Text, Paragraph } = Typography

export default function PatientForm({ form, patient, saving, onSave }) {
  return (
    <Card size="small" title="① 病友信息（资料卡抬头）">
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
          <Col xs={24} md={8}>
            <Form.Item name="comorbidities" label="基础病（可选，进安全基线）">
              <Input placeholder="如：高血压、2 型糖尿病" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="allergies" label="过敏史（可选）">
              <Input placeholder="如：青霉素过敏" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="medications" label="在用药（可选）">
              <Input placeholder="如：泼尼松 20mg qd" />
            </Form.Item>
          </Col>
        </Row>
        <Space wrap style={{ marginBottom: 8 }}>
          <Button type="primary" onClick={onSave} loading={saving}>
            保存病友信息
          </Button>
          {patient?.updatedAt && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              档案更新于 {new Date(patient.updatedAt).toLocaleString('zh-CN')}
            </Text>
          )}
        </Space>
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          身份证、手机号、住址一律不收集（后端会直接丢弃这三类字段）。资料卡不含诊断结论与治疗建议。
        </Paragraph>
      </Form>
    </Card>
  )
}
