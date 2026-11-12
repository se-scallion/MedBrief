import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  Alert, App, AutoComplete, Badge, Button, Card, Col, DatePicker, Descriptions,
  Divider, Empty, Form, Image, Input, Modal, Progress, Result, Row,
  Select, Space, Spin, Statistic, Tag, Timeline, Tooltip, Typography,
} from 'antd'
import dayjs from 'dayjs'

const { Title, Text, Paragraph } = Typography

const STAGE_META = {
  idle: { label: '待启动', color: 'default', step: 0 },
  launching: { label: '启动浏览器', color: 'processing', step: 1 },
  login_page: { label: '打开登录页', color: 'processing', step: 1 },
  captcha_solving: { label: '识别图形验证码', color: 'processing', step: 2 },
  captcha_manual: { label: '等待人工填图形码', color: 'warning', step: 2 },
  sms_sent: { label: '短信已发出', color: 'processing', step: 3 },
  waiting_sms: { label: '等待短信验证码', color: 'warning', step: 3 },
  logged_in: { label: '登录成功', color: 'success', step: 4 },
  checking_patient: { label: '检查就诊人', color: 'processing', step: 4 },
  patient_ok: { label: '就诊人就绪', color: 'success', step: 4 },
  need_patient: { label: '需先绑定就诊人', color: 'error', step: 4, terminal: true },
  loading_schedule: { label: '加载号源', color: 'processing', step: 5 },
  slots_ready: { label: '已取到号源', color: 'warning', step: 5 },
  need_confirm: { label: '等待你确认号源', color: 'warning', step: 6 },
  booking: { label: '提交预约', color: 'processing', step: 7 },
  booked: { label: '预约成功', color: 'success', step: 8, terminal: true },
  waf_blocked: { label: '被 WAF 拦截', color: 'error', step: 5, terminal: true },
  failed: { label: '流程失败', color: 'error', step: 0, terminal: true },
  aborted: { label: '已中止', color: 'default', step: 0, terminal: true },
}

// 号源窗口：114 一般只放未来 14 天（医院页 openTime 决定具体节奏）
const MAX_ADVANCE_DAYS = 14

async function jfetch(url, opts) {
  const r = await fetch(url, opts)
  const j = await r.json().catch(() => ({}))
  if (!r.ok && j && j.error) throw new Error(j.error)
  return j
}

export default function BookingPage() {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm()

  const [hospitals, setHospitals] = useState([])
  const [hosMeta, setHosMeta] = useState(null)
  const [hosLoading, setHosLoading] = useState(false)

  const [depts, setDepts] = useState([])
  const [deptMeta, setDeptMeta] = useState(null)
  const [deptLoading, setDeptLoading] = useState(false)

  const [session, setSession] = useState(null)      // { loggedIn, user }
  const [sessionLoading, setSessionLoading] = useState(true)
  const [forceLogin, setForceLogin] = useState(false)
  const [doctorHistory, setDoctorHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('medbrief.114.doctors') || '[]') } catch { return [] }
  })
  const [doctorOptions, setDoctorOptions] = useState([])
  const [flow, setFlow] = useState(null)
  const [starting, setStarting] = useState(false)
  const [smsCode, setSmsCode] = useState('')
  const [captchaCode, setCaptchaCode] = useState('')

  const flowIdRef = useRef(null)
  const timerRef = useRef(null)

  const watched = Form.useWatch([], form) || {}
  const hosCode = watched.hosCode
  const dept1Code = watched.dept1Code
  const doctor = (watched.doctor || '').trim()
  const hasDate = !!watched.date

  // ---------- 目录加载 ----------
  useEffect(() => {
    jfetch('/api/guahao/doctors')
      .then((j) => setDoctorOptions(j.doctors || []))
      .catch(() => setDoctorOptions([]))
  }, [])

  // 医生一律给"选项"：本地医生档案在前，历史手输在后，可搜索、可留空
  const doctorSelectOptions = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const d of doctorOptions) {
      const v = (d.name || '').trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push({ value: v, label: d.title ? `${v} · ${d.title}` : v, title: v })
    }
    for (const v of doctorHistory) {
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push({ value: v, label: v, title: v })
    }
    return out
  }, [doctorOptions, doctorHistory])

  const loadHospitals = useCallback(async (force = false) => {
    setHosLoading(true)
    try {
      const j = await jfetch(`/api/guahao/114/catalog/hospitals${force ? '?force=1' : ''}`)
      setHospitals(j.list || [])
      setHosMeta({ count: j.count, fetchedAt: j.fetchedAt, stale: j.stale })
      if (force) message.success(`医院目录已刷新：${j.count} 条`)
    } catch (e) {
      message.error(e.message || '医院目录加载失败')
    } finally {
      setHosLoading(false)
    }
  }, [message])

  const loadDepts = useCallback(async (code, force = false) => {
    if (!code) return
    setDeptLoading(true)
    try {
      const j = await jfetch(
        `/api/guahao/114/catalog/depts?hosCode=${encodeURIComponent(code)}${force ? '&force=1' : ''}`,
      )
      setDepts(j.list || [])
      setDeptMeta({ fetchedAt: j.fetchedAt, stale: j.stale })
      if (force) message.success(`科室目录已刷新：${(j.list || []).length} 个一级科室`)
    } catch (e) {
      message.error(e.message || '科室目录加载失败')
      setDepts([])
    } finally {
      setDeptLoading(false)
    }
  }, [message])

  const loadSession = useCallback(async () => {
    setSessionLoading(true)
    try {
      const j = await jfetch('/api/guahao/114/session')
      setSession(j.loggedIn ? { loggedIn: true, user: j.user } : { loggedIn: false, error: j.error })
    } catch (e) {
      setSession({ loggedIn: false, error: e.message })
    } finally {
      setSessionLoading(false)
    }
  }, [])

  useEffect(() => { loadHospitals(false); loadSession() }, [loadHospitals, loadSession])
  useEffect(() => {
    form.setFieldsValue({ dept1Code: undefined, dept2Code: undefined })
    setDepts([])
    setDeptMeta(null)
    if (hosCode) loadDepts(hosCode, false)
  }, [hosCode, form, loadDepts])

  // ---------- 选项 ----------
  const hospitalOptions = useMemo(() => {
    const main = []
    const branch = []
    for (const h of hospitals) {
      const opt = {
        value: h.code,
        label: `${h.name}${h.level ? ' · ' + h.level : ''}${h.area ? ' · ' + h.area : ''}`,
        title: h.name,
      }
      if (h.isBranch) branch.push(opt)
      else main.push(opt)
    }
    const out = []
    if (main.length) out.push({ label: '本院 / 独立医院', options: main })
    if (branch.length) out.push({ label: '分院 / 院区', options: branch })
    return out
  }, [hospitals])

  const dept1Options = useMemo(
    () => depts.map((d) => ({
      value: d.code,
      label: `${d.name}${d.nationalKeyDept ? '（国家重点）' : ''}`,
    })),
    [depts],
  )

  const dept2Options = useMemo(() => {
    const d1 = depts.find((d) => d.code === dept1Code)
    if (!d1) return []
    return (d1.subs || []).map((s) => ({
      value: s.code,
      label: `${s.name}${s.nationalKeyDept ? '（国家重点）' : ''}`,
    }))
  }, [depts, dept1Code])

  // ---------- 意图提示：不同字段组合的结果差异 ----------
  const intent = useMemo(() => {
    if (doctor && hasDate) {
      return {
        type: 'success',
        title: '精确匹配：指定医生 + 指定日期',
        body: `只匹配「${doctor}」在 ${dayjs(watched.date).format('YYYY-MM-DD')} 的号源。命中即自动提交；未命中则停下，不会改挂别人。`,
        autoSubmit: true,
      }
    }
    if (doctor && !hasDate) {
      return {
        type: 'success',
        title: '指定医生：自动匹配最近有号日期',
        body: `在「${doctor}」有号的日期里选最近的一天，命中即自动提交。若该医生暂无号，会停下并列出同科室其他医生供你改选。`,
        autoSubmit: true,
      }
    }
    if (!doctor && hasDate) {
      return {
        type: 'info',
        title: '只指定日期：停在确认环节',
        body: `在 ${dayjs(watched.date).format('YYYY-MM-DD')} 有号的医生里挑第一个，然后停下等你点确认，不会自动提交。`,
        autoSubmit: false,
      }
    }
    return {
      type: 'warning',
      title: '未指定医生与日期：停在确认环节',
      body: '取第一个有号号源，然后停下等你确认。医生和时段可能不是你想要的，建议至少填医生。',
      autoSubmit: false,
    }
  }, [doctor, hasDate, watched.date])

  // ---------- 流程轮询 ----------
  const stopPolling = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }

  const poll = useCallback(async () => {
    const id = flowIdRef.current
    if (!id) return
    try {
      const j = await jfetch(`/api/guahao/114/flow/${encodeURIComponent(id)}`)
      if (j.ok && j.flow) {
        setFlow(j.flow)
        if (!j.flow.terminal) {
          timerRef.current = setTimeout(poll, 1500)
        } else {
          stopPolling()
          setStarting(false)
        }
      } else {
        timerRef.current = setTimeout(poll, 3000)
      }
    } catch {
      timerRef.current = setTimeout(poll, 3000)
    }
  }, [])

  useEffect(() => () => stopPolling(), [])

  // ---------- 提交 ----------
  const onFinish = async (values) => {
    const hos = hospitals.find((h) => h.code === values.hosCode)
    const d1 = depts.find((d) => d.code === values.dept1Code)
    const d2 = (d1?.subs || []).find((s) => s.code === values.dept2Code)

    setStarting(true)
    setFlow(null)
    try {
      const j = await jfetch('/api/guahao/114/flow/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: values.phone.trim(),
          hospital: hos?.name || '',
          hosCode: values.hosCode,
          dept1Code: values.dept1Code,
          dept2Code: values.dept2Code,
          deptName: d2?.name || '',
          patientName: values.patientName.trim(),
          doctor: (values.doctor || '').trim(),
          date: values.date ? dayjs(values.date).format('YYYY-MM-DD') : '',
          reuseSession: !forceLogin,
          allowSessionPhoneMismatch: true,
        }),
      })
      if (!j.ok) throw new Error(j.error || '启动失败')
      flowIdRef.current = j.flowId
      const doc = (values.doctor || '').trim()
      if (doc) {
        const next = [doc, ...doctorHistory.filter((d) => d !== doc)].slice(0, 20)
        setDoctorHistory(next)
        try { localStorage.setItem('medbrief.114.doctors', JSON.stringify(next)) } catch {}
      }
      message.success(`流程已启动 ${j.flowId}`)
      poll()
    } catch (e) {
      setStarting(false)
      message.error(e.message || '启动失败')
    }
  }

  const submitSms = async () => {
    if (!/^\d{6}$/.test(smsCode)) { message.warning('请输入 6 位短信验证码'); return }
    try {
      const j = await jfetch(`/api/guahao/114/flow/${encodeURIComponent(flowIdRef.current)}/sms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: smsCode }),
      })
      if (!j.ok) throw new Error(j.error)
      setSmsCode('')
      message.success('验证码已提交')
      poll()
    } catch (e) { message.error(e.message) }
  }

  const submitCaptcha = async () => {
    if (!/^\d{4}$/.test(captchaCode)) { message.warning('请输入 4 位图形验证码'); return }
    try {
      const j = await jfetch(`/api/guahao/114/flow/${encodeURIComponent(flowIdRef.current)}/captcha`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: captchaCode }),
      })
      if (!j.ok) throw new Error(j.error)
      setCaptchaCode('')
      poll()
    } catch (e) { message.error(e.message) }
  }

  const confirmSlot = async (approve) => {
    try {
      await jfetch(`/api/guahao/114/flow/${encodeURIComponent(flowIdRef.current)}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve }),
      })
      poll()
    } catch (e) { message.error(e.message) }
  }

  const abortFlow = async () => {
    if (!flowIdRef.current) return
    await jfetch(`/api/guahao/114/flow/${encodeURIComponent(flowIdRef.current)}/abort`, { method: 'POST' })
    stopPolling()
    setStarting(false)
    poll()
  }

  // ---------- 渲染 ----------
  const stageMeta = STAGE_META[flow?.stage] || STAGE_META.idle
  const pickedSlot = flow?.slots?.[0]

  const resetAll = () => {
    stopPolling()
    flowIdRef.current = null
    setFlow(null)
    setStarting(false)
    setSmsCode('')
    setCaptchaCode('')
  }

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '24px 16px 64px' }}>
      <Space align="center" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 24 }}>🏥</span>
        <Title level={3} style={{ margin: 0 }}>MedBrief · 114 真实挂号</Title>
        <Tag color="blue">京通渠道 · 浏览器自动流程</Tag>
      </Space>
      <Paragraph type="secondary" style={{ marginBottom: 20 }}>
        用真实浏览器登录 114 并选号。图形验证码自动识别（OCR → AI → 人工兜底），短信验证码需你从手机抄录。
        <b>指定医生时命中即自动提交</b>（114 预约不扣费）；未指定医生时停在确认环节。
      </Paragraph>

      <Row gutter={[16, 16]}>
        {/* 左：表单 */}
        <Col xs={24} lg={15}>
          <Card
            title={<Space>挂号条件</Space>}
            extra={
              <Tooltip title="重新抓取医院全量（约 15 秒）">
                <Button size="small" loading={hosLoading}
                  onClick={() => loadHospitals(true)}>刷新目录</Button>
              </Tooltip>
            }
          >
            <Alert
              type={session?.loggedIn && !forceLogin ? 'success' : 'info'}
              showIcon
              style={{ marginBottom: 16 }}
              message={
                sessionLoading
                  ? '正在检查浏览器里的 114 登录态…'
                  : session?.loggedIn && !forceLogin
                    ? `已复用登录态：${session.user?.mobile || ''} ${session.user?.name || ''}（${session.user?.authStatusView || '已登录'}）`
                    : '将走短信登录（会向手机号发送验证码）'
              }
              description={
                sessionLoading ? null : (
                  <Space orientation="vertical" size={4}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {session?.loggedIn && !forceLogin
                        ? '登录态保存在 ego lite 浏览器里，无需每次都发短信。如需换账号，勾选下面的「强制重新登录」。'
                        : session?.error
                          ? `探测失败：${session.error}`
                          : '本次会打开登录页并发送短信验证码。'}
                    </Text>
                    <Space>
                      <Button size="small" onClick={loadSession} loading={sessionLoading}>重新检测登录态</Button>
                      <label style={{ fontSize: 12 }}>
                        <input type="checkbox" checked={forceLogin}
                          onChange={(e) => setForceLogin(e.target.checked)} style={{ marginRight: 4 }} />
                        强制重新登录（走短信）
                      </label>
                    </Space>
                  </Space>
                )
              }
            />

            <Form
              form={form}
              layout="vertical"
              onFinish={onFinish}
              initialValues={{ date: null }}
              requiredMark="optional"
              disabled={starting && !flow?.terminal}
            >
              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="phone"
                    label="114 登录手机号"
                    rules={[
                      { required: !session?.loggedIn || forceLogin, message: '请填写登录手机号' },
                      {
                        validator: (_, v) => {
                          if (!v) return Promise.resolve()
                          return /^1\d{10}$/.test(v)
                            ? Promise.resolve()
                            : Promise.reject(new Error('需 11 位大陆手机号'))
                        },
                      },
                    ]}
                    extra={
                      session?.loggedIn && !forceLogin
                        ? '已复用登录态，此处可留空（填了也不影响本次会话）'
                        : '短信验证码会发到这个号码'
                    }
                  >
                    <Input placeholder="11 位手机号" maxLength={11} allowClear />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="patientName"
                    label="就诊人姓名"
                    rules={[
                      { required: true, message: '请填写就诊人姓名' },
                      { min: 2, max: 20, message: '姓名 2–20 字' },
                    ]}
                    extra="须与 114 账号下已绑定的就诊人一致"
                  >
                    <Input placeholder="例：代聪" allowClear />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item
                name="hosCode"
                label={
                  <Space>
                    医院
                    {hosMeta?.stale && <Tag color="orange">目录已过期，后台刷新中</Tag>}
                  </Space>
                }
                rules={[{ required: true, message: '请选择医院' }]}
                extra={
                  hosMeta
                    ? `本地目录 ${hosMeta.count} 条（含分院）· 抓取于 ${dayjs(hosMeta.fetchedAt).format('MM-DD HH:mm')}`
                    : '正在加载本地目录'
                }
              >
                <Select
                  showSearch
                  loading={hosLoading}
                  placeholder="搜索医院名称 / 编码"
                  options={hospitalOptions}
                  optionFilterProp="title"
                  filterOption={(input, option) =>
                    (option?.title || option?.label || '').includes(input) ||
                    (option?.value || '').toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={hosLoading ? <Spin size="small" /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配医院" />}
                />
              </Form.Item>

              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="dept1Code"
                    label="一级科室"
                    rules={[{ required: true, message: '请选择一级科室' }]}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      loading={deptLoading}
                      disabled={!hosCode}
                      placeholder={hosCode ? '请选择' : '先选医院'}
                      options={dept1Options}
                      onChange={() => form.setFieldValue('dept2Code', undefined)}
                      notFoundContent={deptLoading ? <Spin size="small" /> : '该医院暂无科室数据'}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="dept2Code"
                    label={
                      <Space>
                        二级科室
                        {deptMeta?.stale && <Tag color="orange">缓存</Tag>}
                      </Space>
                    }
                    rules={[{ required: true, message: '请选择二级科室' }]}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      disabled={!dept1Code}
                      placeholder={dept1Code ? '请选择' : '先选一级科室'}
                      options={dept2Options}
                      notFoundContent="该一级科室下暂无二级科室"
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="doctor"
                    label="指定医生"
                    rules={[{ max: 20, message: '医生姓名过长' }]}
                    extra="选医生 → 命中即自动提交；留空 → 停在确认环节等你点头"
                  >
                    <Select
                      showSearch
                      allowClear
                      placeholder="选择医生（留空 = 不指定）"
                      options={doctorSelectOptions}
                      optionFilterProp="label"
                      filterOption={(input, opt) =>
                        (opt?.label || '').includes(input) || (opt?.value || '').includes(input)
                      }
                      notFoundContent={<span style={{ fontSize: 12 }}>本地医生档案里没有该姓名</span>}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="date"
                    label="就诊日期"
                    extra={`可挂号窗口约 ${MAX_ADVANCE_DAYS} 天；留空 = 取最近有号`}
                  >
                    <DatePicker
                      style={{ width: '100%' }}
                      placeholder="留空则不限日期"
                      format="YYYY-MM-DD"
                      disabledDate={(d) =>
                        !d ||
                        d.isBefore(dayjs().startOf('day')) ||
                        d.isAfter(dayjs().add(MAX_ADVANCE_DAYS, 'day').endOf('day'))
                      }
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Alert
                type={intent.type === 'success' ? 'success' : intent.type === 'info' ? 'info' : 'warning'}
                showIcon
                style={{ marginBottom: 16 }}
                message={intent.title}
                description={
                  <Space orientation="vertical" size={2}>
                    <Text>{intent.body}</Text>
                    <Text strong={intent.autoSubmit} type={intent.autoSubmit ? 'success' : 'secondary'}>
                      {intent.autoSubmit ? '执行方式：命中后自动提交' : '执行方式：停下等你点确认'}
                    </Text>
                  </Space>
                }
              />

              <Space>
                <Button
                  type="primary"
                  htmlType="submit"
                  size="large"

                  loading={starting && !flow?.terminal}
                >
                  {starting && !flow?.terminal ? '流程执行中…' : '开始真实挂号'}
                </Button>
                {(starting || flow) && (
                  <Button danger onClick={abortFlow}>中止流程</Button>
                )}
                {flow?.terminal && <Button onClick={resetAll}>重置</Button>}
              </Space>
            </Form>
          </Card>
        </Col>

        {/* 右：进度 */}
        <Col xs={24} lg={9}>
          <Card
            title={<Space>执行进度</Space>}
            extra={<Badge status={stageMeta.terminal ? (flow?.stage === 'booked' ? 'success' : 'error') : (flow ? 'processing' : 'default')} text={stageMeta.label} />}
          >
            {!flow && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="填好左侧条件后开始" />}

            {flow && (
              <>
                <Progress
                  percent={Math.min(100, Math.round((stageMeta.step / 8) * 100))}
                  status={flow.stage === 'booked' ? 'success' : flow.stage === 'failed' || flow.stage === 'waf_blocked' ? 'exception' : 'active'}
                  size="small"
                />

                {['captcha_manual'].includes(flow.stage) && flowIdRef.current && (
                  <Card size="small" style={{ marginTop: 12, borderColor: '#faad14' }}
                    title={<Space>图形验证码需人工辨认</Space>}>
                    <Space orientation="vertical" style={{ width: '100%' }}>
                      <Image
                        src={`/api/guahao/114/flow/${encodeURIComponent(flowIdRef.current)}/captcha.png?t=${Date.now()}`}
                        width={160} style={{ borderRadius: 6, border: '1px solid #eee' }}
                      />
                      <Space.Compact style={{ width: '100%' }}>
                        <Input maxLength={4} placeholder="4 位图形码" value={captchaCode}
                          onChange={(e) => setCaptchaCode(e.target.value)} onPressEnter={submitCaptcha} />
                        <Button type="primary" onClick={submitCaptcha}>提交</Button>
                      </Space.Compact>
                    </Space>
                  </Card>
                )}

                {flow.stage === 'waiting_sms' && (
                  <Card size="small" style={{ marginTop: 12, borderColor: '#1677ff' }}
                    title={<Space>短信已发出（5 分钟内有效）</Space>}>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input maxLength={6} placeholder="6 位短信验证码" value={smsCode}
                        onChange={(e) => setSmsCode(e.target.value)} onPressEnter={submitSms} />
                      <Button type="primary" onClick={submitSms}>提交</Button>
                    </Space.Compact>
                  </Card>
                )}

                {flow.stage === 'need_confirm' && (
                  <Card size="small" style={{ marginTop: 12, borderColor: '#722ed1' }}
                    title="待确认号源">
                    <Descriptions size="small" column={1}>
                      <Descriptions.Item label="日期">{pickedSlot?.date || '未知'}</Descriptions.Item>
                      <Descriptions.Item label="医生">{pickedSlot?.doctors?.[0]?.doctorName || '不限'}</Descriptions.Item>
                      <Descriptions.Item label="剩余">
                        {pickedSlot?.doctors?.[0]?.remaining ?? '未知'}
                      </Descriptions.Item>
                    </Descriptions>
                    <Space style={{ marginTop: 8 }}>
                      <Button type="primary" onClick={() => confirmSlot(true)}>确认提交</Button>
                      <Button onClick={() => confirmSlot(false)}>放弃</Button>
                    </Space>
                  </Card>
                )}

                {flow.stage === 'booked' && (
                  <Result status="success" title="预约成功"
                    subTitle={
                      <Space orientation="vertical" size={0}>
                        {flow.result?.slot?.doctorName && <Text>医生：{flow.result.slot.doctorName}</Text>}
                        {flow.result?.slot?.date && <Text>日期：{flow.result.slot.date}</Text>}
                        {flow.orderPersist?.order?.orderId && <Text code>{flow.orderPersist.order.orderId}</Text>}
                      </Space>
                    }
                    style={{ padding: '12px 0' }}
                  />
                )}

                {flow.stage === 'waf_blocked' && (
                  <Alert style={{ marginTop: 12 }} type="warning" showIcon
                    message="号源接口被瑞数 WAF 拦截"
                    description={
                      <Space orientation="vertical" size={2}>
                        <Text>浏览器已登录成功，页面仍在。你可以直接在浏览器里手动选号；或等 30–60 分钟风控冷却后重试。</Text>
                        <Text type="secondary">{flow.error?.message}</Text>
                      </Space>
                    }
                  />
                )}

                {flow.stage === 'need_patient' && (
                  <Alert style={{ marginTop: 12 }} type="warning" showIcon
                    message="未找到匹配就诊人"
                    description="该 114 账号下没有同名就诊人。绑定需本人身份证完成实名认证，请先在 114 完成后再试。" />
                )}

                {flow.stage === 'failed' && (
                  <Alert style={{ marginTop: 12 }} type="error" showIcon
                    message="流程失败" description={flow.error?.message} />
                )}

                {flow.stage === 'slots_ready' && (
                  <Alert style={{ marginTop: 12 }} type="info" showIcon
                    message="已取到号源但未命中条件"
                    description={flow.error?.message || '未找到符合「医生/日期」的号源，可放宽条件重试。'} />
                )}

                <Divider style={{ margin: '12px 0' }} orientation="left" plain>阶段</Divider>
                <Timeline
                  items={Object.entries(STAGE_META)
                    .filter(([, m]) => m.step > 0)
                    .sort((a, b) => a[1].step - b[1].step)
                    .filter(([k], i, arr) => arr.findIndex(([k2, m2]) => m2.step === STAGE_META[k].step) === i)
                    .map(([k, m]) => {
                      const cur = STAGE_META[flow.stage]?.step || 0
                      const done = m.step < cur
                      const active = m.step === cur
                      return {
                        color: done ? 'green' : active ? 'blue' : 'gray',
                        children: <Text type={done || active ? undefined : 'secondary'} strong={active}>{m.label}</Text>,
                      }
                    })}
                />
              </>
            )}
          </Card>

          {flow?.logs?.length > 0 && (
            <Card size="small" title="执行日志" style={{ marginTop: 16 }}
              extra={<Text type="secondary" style={{ fontSize: 12 }}>{flow.logs.length} 行</Text>}>
              <pre style={{
                fontSize: 11, lineHeight: 1.6, maxHeight: 260, overflow: 'auto',
                background: '#0f172a', color: '#a5f3fc', padding: 10, borderRadius: 8,
                whiteSpace: 'pre-wrap', margin: 0,
              }}>{flow.logs.join('\n')}</pre>
            </Card>
          )}
        </Col>
      </Row>
    </div>
  )
}
