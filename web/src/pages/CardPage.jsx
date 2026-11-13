// 资料卡（2026-11-13 从「资料录入」页独立出来）
//
// 用户原话：「资料卡为什么要放到导入页面中？放在资料库也比放在导入页面中好啊。
//           资料卡可以用新页面或者用弹窗表示。你放在那个页面下方，又丑又长。」
//
// 所以：录入页只做「上传 → 校对 → 入库」，资料卡单独一个菜单项，一进来就是预览本身。
// 本页自包含（自己读档案、自己生成卡片），不依赖录入页的 state。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp, Button, Form, Space, Typography } from 'antd'
import { jget } from '../api.js'
import { useLog } from '../App.jsx'
import ProfilePanel from './intake/ProfilePanel.jsx'
import { postJson } from './intake/shared.js'

const { Text } = Typography

export default function CardPage() {
  const { message } = AntApp.useApp()
  const { pushLog } = useLog()
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
      <ProfilePanel
        form={form}
        patient={patient}
        patientSaving={patientSaving}
        savePatient={savePatient}
        card={card}
        cardLoading={cardLoading}
        makeCard={makeCard}
        mask={mask}
        setMask={setMask}
        iframeRef={iframeRef}
        printCard={printCard}
        openCardInNewWindow={openCardInNewWindow}
        hideActions
      />
    </Space>
  )
}
