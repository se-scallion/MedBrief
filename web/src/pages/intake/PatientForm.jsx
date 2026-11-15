// PatientForm —— 「编辑病友档案与本次诉求」弹窗（2026-11-15 用户给的新版布局）
//
// 布局四区（按用户图）：
//   1. 基本信息与诊断：姓名/性别/年龄/医院（窄） + 诊断全称（占 2/3） + 分型危险度/阶段
//      · 「流式免疫表型推断…」这类长串不再塞进输入框，改为输入框下方只读小字
//   2. 本次来意与核心诉求：★ 患者口述新情况（整行 TextArea，置顶到卡面） + 三问（多行）
//   3. 白血病治疗与关键检查原句：近期治疗与在用药 / 骨穿·MRD·染色体与关键影像原句（2 行 TextArea 两列）
//   4. 其他伴随情况：其他基础病 / 过敏史（默认「无」，选「有」才展开）
//
// 关键口径（用户拍板）：
//   · 「在用药」从底部开关区**上提到第 3 区**，与化疗方案并列 —— 白血病患者的 TKI 靶向药是核心，
//     不能和「高血压/过敏史」一起默认隐藏成「无」；
//   · 「关键结论（染色体/骨穿/影像）」三格是**人工摘录**，留空则卡片自动用报告原文摘录，
//     所以每格下方必须写清「留空 = 自动使用原文摘录（当前已自动提取：…）」，否则用户看见空框会重抄一遍；
//   · [填入提问参考模板] 只在用户点击且对应框为空时填入，从不覆盖已写内容。
import React, { useEffect, useRef } from 'react'
import { Button, Col, Form, Input, Modal, Radio, Row, Select, Space, Typography, Divider, Dropdown, Tag } from 'antd'

const { Text, Paragraph } = Typography

const TEMPLATES = {
  newFinding: {
    label: '新发现异常 / 二诊评估',
    focus: '外院影像发现头部阴影/结节，是否为白血病中枢侵犯或感染？本次能否定性排查（腰穿/脑脊液、复查影像）？',
    confirm: '需要补做哪些检查（腰穿+脑脊液、增强 MRI、PET-CT）？现有方案是否需要调整或加鞘内注射？',
    nextVisit: '现服达沙替尼 100mg qd；下次复查血常规 2 周后、骨穿 1 个月后；发热≥38.5℃ 或剧烈头痛呕吐立即急诊。',
  },
  routine: {
    label: '常规复查评估',
    focus: '本次复查血常规/生化异常项的意义（如中性粒细胞低、肝酶升高），是否需要处理？',
    confirm: '当前是否仍处于完全缓解？下一步是继续巩固、维持还是做移植评估？',
    nextVisit: '下次复查血常规 2 周后；如出现发热、出血倾向或明显乏力随时就诊。',
  },
}

/**
 * @param {object} p
 * @param {boolean} p.open
 * @param {Function} p.onClose
 * @param {object} p.form            antd Form 实例（由 CardPage 持有）
 * @param {object} p.patient         当前档案（用于显示「档案更新于」）
 * @param {boolean} p.saving
 * @param {Function} p.onSave
 * @param {string} p.focusField      打开时聚焦的字段名
 * @param {Array}  p.autoConclusions 卡片上**已自动抽取**的关键结论（{key,label,date,text,source}）
 */
export default function PatientForm({ open = true, onClose, form, patient, saving, onSave, focusField, autoConclusions = [] }) {
  const comorbiditiesHas = Form.useWatch('comorbiditiesHas', form)
  const allergiesHas = Form.useWatch('allergiesHas', form)
  const bodyRef = useRef(null)

  // 打开时聚焦指定字段（antd 给每个控件的 id 就是 Form.Item 的 name）
  useEffect(() => {
    if (!open || !focusField) return
    const el = document.getElementById(focusField)
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.focus()
    }
  }, [open, focusField])

  const autoOf = (key) => autoConclusions.find((x) => x.key === key && x.source !== 'manual')
  const autoNote = (key) => {
    const a = autoOf(key)
    return a
      ? `留空 = 自动使用报告原文摘录（当前已自动提取：${a.date ? a.date.slice(5) + ' ' : ''}${a.text}）`
      : '留空 = 自动使用报告原文摘录（当前未从报告里提取到，卡片该行不显示）'
  }

  // 只在「对应框为空」时填入模板，绝不覆盖用户已写内容
  const fillTemplate = (which) => {
    const t = TEMPLATES[which]
    const cur = form.getFieldsValue(['focus', 'confirm', 'nextVisit'])
    const next = {}
    if (!String(cur.focus || '').trim()) next.focus = t.focus
    if (!String(cur.confirm || '').trim()) next.confirm = t.confirm
    if (!String(cur.nextVisit || '').trim()) next.nextVisit = t.nextVisit
    if (Object.keys(next).length) form.setFieldsValue(next)
  }

  const cancel = () => {
    form.resetFields()
    onClose && onClose()
  }

  return (
    <Modal
      open={open}
      onCancel={cancel}
      title="编辑病友档案与本次诉求"
      width={900}
      style={{ top: 24 }}
      footer={[
        <Space key="f" style={{ float: 'left' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>身份证、手机号、住址一律不收集（后端直接丢弃）</Text>
        </Space>,
        <Button key="cancel" onClick={cancel}>取消</Button>,
        <Button key="save" type="primary" onClick={onSave} loading={saving}>保存并刷新资料卡</Button>,
      ]}
      destroyOnClose={false}
    >
      <div ref={bodyRef} style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
        <Form form={form} layout="vertical" size="small">

          {/* ---------------- 1. 基本信息与诊断 ---------------- */}
          <Divider orientation="left" plain style={{ margin: '4px 0 8px' }}>1. 基本信息与诊断</Divider>
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item name="name" label="姓名"><Input placeholder="病友姓名" /></Form.Item>
            </Col>
            <Col xs={12} md={3}>
              <Form.Item name="sex" label="性别">
                <Select allowClear options={[{ value: '男', label: '男' }, { value: '女', label: '女' }]} />
              </Form.Item>
            </Col>
            <Col xs={12} md={3}>
              <Form.Item name="age" label="年龄"><Input placeholder="如 34" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="hospital" label="原/主诊医院"><Input placeholder="如 某某医院" /></Form.Item>
            </Col>
            <Col xs={24} md={16}>
              <Form.Item name="diagnosis" label="诊断全称" extra="卡面抬头直接显示，请写全（含分型）">
                <Input placeholder="如 急性B淋巴细胞白血病（Common-B-ALL）" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="stage" label="当前阶段"><Input placeholder="如 巩固第 2 疗程" /></Form.Item>
            </Col>
            <Col xs={24} md={16}>
              <Form.Item
                name="subtype"
                label="分型 / 危险度"
                extra={patient?.diagnosisNote || patient?.subtypeNote || '（依据见报告库，不用抄进这一格）'}
              >
                <Input placeholder="如 Ph+(BCR::ABL1 P190) · 高危" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="attending" label="主管医生（可选）"><Input placeholder="可不填" /></Form.Item>
            </Col>
          </Row>

          {/* ---------------- 2. 本次来意与核心诉求 ---------------- */}
          <Divider orientation="left" plain style={{ margin: '12px 0 8px' }}>
            <Space>
              2. 本次来意与核心诉求
              <Dropdown
                trigger={['click']}
                menu={{
                  items: Object.entries(TEMPLATES).map(([k, v]) => ({ key: k, label: v.label })),
                  onClick: ({ key }) => fillTemplate(key),
                }}
              >
                <Button size="small" type="link" style={{ padding: 0 }}>填入提问参考模板 ▾</Button>
              </Dropdown>
            </Space>
          </Divider>
          <Form.Item
            name="chiefComplaint"
            label={<span>★ 本次来意 / 患者口述新情况 <Tag color="red" style={{ marginLeft: 4 }}>患者口述</Tag></span>}
            extra="整行显示在资料卡第 1 页最上方，并在安全基线处再提示一次，防止医生只看数字漏掉主观线索"
          >
            <Input.TextArea rows={2} placeholder="如：外院 10-16 头颈 MRI 发现头部阴影/结节，担心中枢侵犯或感染，特来二诊评估" />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Form.Item name="focus" label="① 最想弄清的新异常/症状">
                <Input.TextArea rows={3} placeholder="如：头部阴影是中枢侵犯还是感染？本次能否定性排查？" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="confirm" label="② 最想请医生定夺的方案">
                <Input.TextArea rows={3} placeholder="如：要不要做腰穿/脑脊液？需不需调整方案或做移植评估？" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="nextVisit" label="③ 下步复查与急诊红线">
                <Input.TextArea rows={3} placeholder="如：2 周后复查血常规、1 个月后骨穿；发热≥38.5℃ 或剧烈头痛呕吐立即急诊" />
              </Form.Item>
            </Col>
          </Row>

          {/* ---------------- 3. 白血病治疗与关键检查原句 ---------------- */}
          <Divider orientation="left" plain style={{ margin: '12px 0 8px' }}>3. 白血病治疗与关键检查原句</Divider>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item
                name="lastChemo"
                label="近期治疗与在用药"
                extra="写清化疗方案与天数 + 靶向药 / 升白 / 输血（TKI 等口服药别漏）"
              >
                <Input.TextArea rows={2} placeholder="如：达沙替尼 100mg qd 在服；7-20 VDCLP 化疗后；近期未输血" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="recentTxOrGcsf" label="近期输血 / 升白针">
                <Input.TextArea rows={2} placeholder="如：9-22 输血小板 1 治疗量；9-25 起 G-CSF 300μg qd×3" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="marrowSummary" label="骨穿 / MRD 关键原句" extra="建议直接照抄报告结论原句">
                <Input.TextArea rows={2} placeholder="如：7-17 流式 异常细胞 85.76%；MRD 阴性（<0.01%）" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="kcKaryotype" label="染色体核型结论原句（人工摘录）" extra={autoNote('karyotype')}>
                <Input.TextArea rows={2} placeholder="留空即可：卡片会自动用报告原文摘录" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="kcImaging" label="关键影像结论原句（人工摘录）" extra={autoNote('imaging')}>
                <Input.TextArea rows={2} placeholder="留空即可：卡片会自动用报告原文摘录" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="kcMarrow" label="骨穿结论原句（人工摘录，可选）" extra={autoNote('marrow')}>
                <Input.TextArea rows={2} placeholder="留空即可：卡片会自动用报告原文摘录" />
              </Form.Item>
            </Col>
          </Row>

          {/* ---------------- 4. 其他伴随情况 ---------------- */}
          <Divider orientation="left" plain style={{ margin: '12px 0 8px' }}>4. 其他伴随情况</Divider>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item name="comorbiditiesHas" label="其他基础病（高血压/糖尿病等）" initialValue="none">
                <Radio.Group size="small" optionType="button" buttonStyle="solid"
                  options={[{ label: '无', value: 'none' }, { label: '有', value: 'has' }]} />
              </Form.Item>
              {comorbiditiesHas === 'has' && (
                <Form.Item name="comorbidities"><Input placeholder="如：高血压、2 型糖尿病" /></Form.Item>
              )}
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="allergiesHas" label="过敏史" initialValue="none">
                <Radio.Group size="small" optionType="button" buttonStyle="solid"
                  options={[{ label: '无', value: 'none' }, { label: '有', value: 'has' }]} />
              </Form.Item>
              {allergiesHas === 'has' && (
                <Form.Item name="allergies"><Input placeholder="如：青霉素过敏" /></Form.Item>
              )}
            </Col>
          </Row>
        </Form>
        {patient?.updatedAt && (
          <Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 0' }}>
            档案更新于 {new Date(patient.updatedAt).toLocaleString('zh-CN')}　·　资料卡只陈述数值、日期、出处，不写诊断结论与治疗建议。
          </Paragraph>
        )}
      </div>
    </Modal>
  )
}
