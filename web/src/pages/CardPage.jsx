// 资料卡（2026-11-13 从「资料录入」页独立出来）
//
// 用户原话：「资料卡为什么要放到导入页面中？放在资料库也比放在导入页面中好啊。
//           资料卡可以用新页面或者用弹窗表示。你放在那个页面下方，又丑又长。」
//
// 所以：录入页只做「上传 → 校对 → 入库」，资料卡单独一个菜单项，一进来就是预览本身。
// 本页自包含（自己读档案、自己生成卡片），不依赖录入页的 state。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Card, Empty, Form, Space, Typography } from 'antd'
import { jget } from '../api.js'
import { useLog, useNav } from '../App.jsx'
import PatientForm from './intake/PatientForm.jsx'
import CardPreview from './intake/CardPreview.jsx'
import { postJson } from './intake/shared.js'

const { Text } = Typography

export default function CardPage() {
  const { message } = AntApp.useApp()
  const { pushLog } = useLog()
  const { go } = useNav()
  const [form] = Form.useForm()
  const iframeRef = useRef(null)

  const [patient, setPatient] = useState(null)
  const [patientSaving, setPatientSaving] = useState(false)
  const [card, setCard] = useState(null)
  const [cardLoading, setCardLoading] = useState(false)
  const [mask, setMask] = useState(false) // 默认不脱敏（给医生看）

  const loadPatient = useCallback(async () => {
    try {
      const j = await jget('/api/intake/patient')
      setPatient(j.patient || null)
      if (j.patient) {
        form.setFieldsValue({
          name: j.patient.name || '',
          sex: j.patient.sex || undefined,
          age: j.patient.age || '',
          diagnosis: j.patient.diagnosis || '',
          subtype: j.patient.subtype || '',
          stage: j.patient.stage || '',
          hospital: j.patient.hospital || '',
          attending: j.patient.attending || '',
          focus: j.patient.questions?.focus || '',
          confirm: j.patient.questions?.confirm || '',
          nextVisit: j.patient.questions?.nextVisit || '',
          lastChemo: j.patient.clinicalContext?.lastChemo || '',
          recentTxOrGcsf: j.patient.clinicalContext?.recentTxOrGcsf || '',
          marrowSummary: j.patient.clinicalContext?.marrowSummary || '',
          comorbidities: j.patient.comorbidities || '',
          allergies: j.patient.allergies || '',
          medications: j.patient.medications || '',
          // 三项开关：已有内容才打开「有」，否则默认「无」（卡面据此决定显示与否）
          comorbiditiesHas: j.patient.comorbidities ? 'has' : 'none',
          allergiesHas: j.patient.allergies ? 'has' : 'none',
          medicationsHas: j.patient.medications ? 'has' : 'none',
        })
      }
    } catch (e) {
      message.error(`病友档案读取失败：${e.message}`)
    }
  }, [form, message])

  const makeCard = useCallback(async (nextMask = mask) => {
    setCardLoading(true)
    try {
      const j = await jget(`/api/intake/card?mask=${nextMask ? 1 : 0}`)
      setCard(j)
      pushLog(`资料卡已生成（${nextMask ? '脱敏' : '未脱敏'}）`, 'ok')
    } catch (e) {
      message.error(`生成资料卡失败：${e.message}`)
      setCard(null)
    } finally {
      setCardLoading(false)
    }
  }, [mask, message, pushLog])

  const savePatient = async () => {
    const v = form.getFieldsValue()
    setPatientSaving(true)
    try {
      const { body } = await postJson('/api/intake/patient', {
        name: v.name || '', sex: v.sex || '', age: v.age || '',
        diagnosis: v.diagnosis || '', subtype: v.subtype || '', stage: v.stage || '',
        hospital: v.hospital || '', attending: v.attending || '',
        // 选「无」= 明确清空（卡面完全不显示该项）；选「有」才落库文本
        comorbidities: v.comorbiditiesHas === 'has' ? (v.comorbidities || '') : '',
        allergies: v.allergiesHas === 'has' ? (v.allergies || '') : '',
        medications: v.medicationsHas === 'has' ? (v.medications || '') : '',
        questions: { focus: v.focus || '', confirm: v.confirm || '', nextVisit: v.nextVisit || '' },
        clinicalContext: {
          lastChemo: v.lastChemo || '',
          recentTxOrGcsf: v.recentTxOrGcsf || '',
          marrowSummary: v.marrowSummary || '',
        },
      })
      if (!body.ok) throw new Error(body.error || '保存失败')
      setPatient(body.patient)
      pushLog('病友档案已保存（身份证 / 手机号 / 住址一律不存）', 'ok')
      message.success('已保存')
    } catch (e) {
      message.error(e.message)
    } finally {
      setPatientSaving(false)
    }
  }

  const openCardInNewWindow = () => {
    if (!card?.html) return message.warning('资料卡还没生成')
    const w = window.open('', '_blank')
    if (!w) return message.warning('浏览器拦截了新窗口，请允许弹窗后重试')
    w.document.write(card.html)
    w.document.close()
  }

  const printCard = () => {
    const win = iframeRef.current?.contentWindow
    if (!win) return message.warning('资料卡还没生成')
    win.focus()
    win.print()
  }

  // 0 份报告 = 冷启动：不渲染空壳卡片，改给引导页（用户 2026-11-14 口径）
  const coldStart = card ? (card.empty || card.counts?.reports === 0) : false
  const checklistMissing = card?.checklist?.missingDetail || []

  useEffect(() => { loadPatient() }, [loadPatient])
  // 进来就自动生成一次：这一页存在的意义就是「看卡片」，不该还要再点一次「生成」
  useEffect(() => { makeCard(false) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 15 }}>资料卡</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            给门诊医生看的一页 A4（第 1 页速览 / 第 2 页全部指标 / 第 3 页趋势）；数据来自「报告库」，只陈述数值与出处
          </Text>
        </Space>
        <Space>
          <Button size="small" onClick={() => makeCard(mask)} loading={cardLoading}>重新生成</Button>
          <Button size="small" onClick={printCard} disabled={!card?.html}>打印 / 存 PDF</Button>
          <Button size="small" onClick={openCardInNewWindow} disabled={!card?.html}>新窗口打开</Button>
        </Space>
      </div>
      <PatientForm form={form} patient={patient} saving={patientSaving} onSave={savePatient} />

      {/* 白血病核心资料体检条（2026-11-14 用户口径）：
          只在屏幕上提示，**不进打印/PDF**（打印走 iframe 内的 card.html，不包含这些 React 元素），
          且**绝不 disable 打印按钮** —— 缺资料不是不能出片的理由。 */}
      {checklistMissing.length > 0 && (
        <Alert
          className="checklist"
          type="warning"
          showIcon
          message={`暂未检出 ${checklistMissing.length} 项白血病核心资料`}
          description={
            <Space direction="vertical" size={2}>
              <Text style={{ fontSize: 12 }}>
                {checklistMissing.map((m) => `${m.label}：${m.detail}`).join('；')}
              </Text>
              <Space size={8}>
                <Button size="small" type="primary" ghost onClick={() => go('intake')}>去补传报告</Button>
                <Text type="secondary" style={{ fontSize: 12 }}>不影响打印，卡片仍可照常导出</Text>
              </Space>
            </Space>
          }
        />
      )}

      {coldStart ? (
        <Card size="small">
          <Empty
            description={
              <Space direction="vertical" size={4}>
                <Text strong>还没有导入任何报告</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  资料卡是用「报告库」里的真实化验单生成的；先导入报告，或先把病友信息填好。
                </Text>
              </Space>
            }
          >
            <Space wrap>
              <Button type="primary" onClick={() => go('intake')}>去导入报告</Button>
              <Button onClick={() => go('reports')}>看报告库</Button>
            </Space>
          </Empty>
        </Card>
      ) : (
        <CardPreview
          card={card}
          loading={cardLoading}
          mask={mask}
          onMaskChange={(v) => { setMask(v); if (card) makeCard(v) }}
          iframeRef={iframeRef}
        />
      )}
    </Space>
  )
}
