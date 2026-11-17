// 资料卡页 = 交互式问诊工作台（2026-11-14 用户口径，v3.5）
//
// 主画面不再平铺「长表单 + 3 页 A4 iframe」（改造前页面高 1705px，一屏只见档案表单），
// 改为三件事：
//   ① 顶部工具栏：病友抬头 + [编辑档案与三问] + [打印预览 / 存 PDF]（主按钮）
//   ② 白血病核心资料体检条（仅屏幕，不进打印；绝不阻塞打印）
//   ③ 三个标签页：临床指标总览 / 动态趋势看板 / 全病程原件轴
// 点击任意指标行 / 趋势圆点 / 病程条目 → 【原件溯源弹窗】；打印走【A4 打印预览弹窗】。
//
// 打印件本身零改动：仍由 buildCard().html 那份自包含静态 3 页渲染，本页只负责「什么时候打开它」。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Card, Empty, Form, Space, Spin, Tabs, Tag, Typography } from 'antd'
import { jget } from '../api.js'
import { useLog, useNav } from '../App.jsx'
import { postJson } from './intake/shared.js'
import PatientForm from './intake/PatientForm.jsx'
import CardPreview from './intake/CardPreview.jsx'
import OverviewTab from './card/OverviewTab.jsx'
import TrendsTab from './card/TrendsTab.jsx'
import TimelineTab from './card/TimelineTab.jsx'
import SourceModal from './card/SourceModal.jsx'

const { Text, Title } = Typography

// 移动端（≤575px）适配样式：只在资料卡页挂载期间生效（useEffect 注入 head、卸载即移除）。
// W10 起顶栏规则统一归 App.jsx 的全局窄屏 CSS（单一 owner）：这里只留资料卡页专属的窄屏规则，
// 不再碰 .ant-layout-header，避免两处各写一份将来漂移。桌面端完全不受影响（媒体查询仅 ≤575px）。
const CARD_MOBILE_CSS = `
@media (max-width: 575px) {
  .ant-card-head { flex-wrap: wrap; height: auto; }
  /* P0-5（AI 审核 r1）：extra 上的 overflow:hidden 会把卡头里偏高的内容（如「生成中」状态行）
     垂直裁掉下半截。改为可见 + 允许换行，宽度仍受 max-width:100% 约束（不会撑破页面）。 */
  .ant-card-head .ant-card-extra { max-width: 100%; margin-inline-start: 0; overflow: visible; }
  /* P0-1（AI 审核 r1）：extra 强排一行时会把标题挤成 15px 宽（只剩「可」字）⇒ 窄屏让 extra 独占一行 */
  .ant-card-head .ant-card-head-wrapper { flex-wrap: wrap; row-gap: 6px; }
  .ant-card-head .ant-card-head-title { flex: 1 1 100%; min-width: 0; overflow: visible; white-space: normal; }
  .ant-card-head .ant-card-extra { flex: 1 1 100%; }
  .ant-spin .ant-spin-text { line-height: 1.5; padding-top: 6px; white-space: nowrap; }
  .ant-card-head .ant-card-extra .ant-space { flex-wrap: wrap; }
  .ant-segmented { max-width: 100%; overflow-x: auto; }
  .ant-table table { table-layout: fixed; }
  .ant-table th, .ant-table td { word-break: break-word; }
  .mb-timeline-table col:nth-child(1) { width: 108px !important; }
  .mb-timeline-table col:nth-child(2) { width: 84px !important; }
  .mb-timeline-table .ant-table-cell { padding-inline: 6px !important; }
  .mb-baseline-grid { grid-template-columns: 1fr !important; }
  .mb-compact-grid { grid-template-columns: 1fr !important; }
  .mb-compact-row { grid-template-columns: 1fr auto 46px !important; }
  .mb-compact-row > span:nth-child(3) { display: none !important; }
  /* 2026-11-17 移动端趋势网格：**本行是 ≤575 的唯一真源（卡最小 320）**，桌面档由
     TrendsTab.jsx 的内联 minmax(min(380px,100%),1fr) 决定，两者按断点分工、互不覆盖。
     旧写法 repeat(auto-fit,minmax(0,1fr)) 会按卡片数量均分（9 张 ⇒ 每张 28.33px），
     把人眼可见的「卡片」压成竖条；min() 保证容器不足 320 时退化为单列满宽。 */
  .mb-trends-grid { grid-template-columns: minmax(min(320px, 100%), 1fr) !important; }
  .mb-source-left, .mb-source-right { min-width: 0 !important; flex-basis: 100% !important; }
  /* W13-A3：原件轴窄屏行块，摘要整行两行截断，不撑宽文档 */
  .mb-timeline-blocks { width: 100%; overflow: hidden; }
  .mb-timeline-row { width: 100%; max-width: 100%; box-sizing: border-box; }
  /* W3b：Tab 栏吸顶，滚到页面中部也能切视图（2026-11-14 实测确定 top:0 —— header 为 static，
     祖先链无 overflow:hidden；弹窗 zIndex=1000，此处 2 不会遮挡打印预览）。
     antd 的 CSS-in-JS 自带 .ant-tabs-nav{position:relative} 且层叠更高，实测不加 !important 不生效。 */
  .ant-tabs-nav { position: sticky !important; top: 0 !important; z-index: 2; background: #fff; }
}
`

export default function CardPage() {
  const { message } = AntApp.useApp()
  const { pushLog } = useLog()
  const { go, permissions } = useNav()
  // 用户口径第1条（2026-11-17）：普通用户能看资料卡页面，但**不能打印/下载** ⇒
  // 打印入口按权限**不渲染**（不是 disabled、不是灰按钮），后端 /api/intake/card?embed=1 同步 403。
  const canExport = !!(permissions && (permissions.role === 'admin' || permissions.card_export))
  const [form] = Form.useForm()
  const iframeRef = useRef(null)

  const [patient, setPatient] = useState(null)
  const [patientSaving, setPatientSaving] = useState(false)
  const [card, setCard] = useState(null)
  const [cardLoading, setCardLoading] = useState(false)
  // 打印预览弹窗 iframe 专用：/api/intake/card?...&embed=1 的输出没有浮动打印条（W13-A2）。
  // 新窗口「新窗口打开纯净打印页」仍用 card.html 全量版（保留「打印 / 存 PDF」按钮）。
  const [embedHtml, setEmbedHtml] = useState('')
  const [mask, setMask] = useState(false)     // 默认不脱敏（给医生看）

  const [tab, setTab] = useState('overview')
  const [printOpen, setPrintOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [focusField, setFocusField] = useState('')
  const [source, setSource] = useState({ open: false, target: null })

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
          chiefComplaint: j.patient.chiefComplaint || '',
          focus: j.patient.questions?.focus || '',
          confirm: j.patient.questions?.confirm || '',
          nextVisit: j.patient.questions?.nextVisit || '',
          lastChemo: j.patient.clinicalContext?.lastChemo || '',
          recentTxOrGcsf: j.patient.clinicalContext?.recentTxOrGcsf || '',
          marrowSummary: j.patient.clinicalContext?.marrowSummary || '',
          kcKaryotype: j.patient.keyConclusions?.karyotype || '',
          kcMarrow: j.patient.keyConclusions?.marrow || '',
          kcImaging: j.patient.keyConclusions?.imaging || '',
          comorbidities: j.patient.comorbidities || '',
          allergies: j.patient.allergies || '',
          medications: j.patient.medications || '',
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
      // 同一份卡再取一次 embed=1 版给弹窗 iframe：默认行为不变，新窗口仍走 card.html。
      // 旧进程尚未支持 embed 时，CardPreview 会做幂等剥离兜底（不重启服务）。
      try {
        const e = await jget(`/api/intake/card?mask=${nextMask ? 1 : 0}&embed=1`)
        setEmbedHtml(e.html || '')
      } catch { setEmbedHtml('') }
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
        diagnosis: v.diagnosis || '', subtype: v.subtype || '',
        // 分型「原文依据」单独存：subtype 只放短标签（如 Ph+·高危），依据留作只读注释
        subtypeNote: patient?.subtypeNote || '',
        stage: v.stage || '',
        hospital: v.hospital || '', attending: v.attending || '',
        // 选「无」= 明确清空（卡面完全不显示该项）；选「有」才落库文本
        comorbidities: v.comorbiditiesHas === 'has' ? (v.comorbidities || '') : '',
        allergies: v.allergiesHas === 'has' ? (v.allergies || '') : '',
        medications: v.medicationsHas === 'has' ? (v.medications || '') : '',
        // 2026-11-15 用户口径：本次来意置顶展示；关键结论三格是「人工摘录」，留空则卡片用自动抽取
        chiefComplaint: v.chiefComplaint || '',
        keyConclusions: { karyotype: v.kcKaryotype || '', marrow: v.kcMarrow || '', imaging: v.kcImaging || '' },
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
      setProfileOpen(false)
      await makeCard(mask)   // 保存后重刷工作台数据
    } catch (e) {
      message.error(e.message)
    } finally {
      setPatientSaving(false)
    }
  }

  useEffect(() => { loadPatient() }, [loadPatient])
  // 进来就自动生成一次：这一页存在的意义就是「看工作台」，不该还要再点一次「生成」
  useEffect(() => { makeCard(false) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ≤575px 才把窄屏样式挂到 head：用 useEffect 保证离开资料卡页就移除，不污染其它页面。
  useEffect(() => {
    const style = document.createElement('style')
    style.id = 'mb-card-mobile'
    style.textContent = CARD_MOBILE_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

  // 打印弹窗没开时按 Cmd/Ctrl+P：**不打印工作台**，改为打开打印预览
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || (e.key !== 'p' && e.key !== 'P')) return
      if (printOpen) return   // 弹窗自己的监听会把快捷键转给 iframe
      if (!canExport) {       // 无导出权限：不打开打印件，给一句人话
        e.preventDefault()
        message.info('未开通导出权限，请联系管理员')
        return
      }
      e.preventDefault()
      setPrintOpen(true)
      message.info('请在弹出的打印预览里点「立即打印 / 存为 PDF」')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [printOpen, message, canExport])

  const openSource = useCallback((target) => setSource({ open: true, target }), [])
  const openProfile = useCallback((field) => { setFocusField(field || ''); setProfileOpen(true) }, [])

  const coldStart = card ? (card.empty || card.counts?.reports === 0) : false
  const missing = card?.checklist?.missingDetail || []
  const p = card?.patient || patient || {}
  const counts = card?.counts || {}

  const headline = useMemo(() => (
    <Space direction="vertical" size={0}>
      <Space size={8} wrap align="baseline">
        <Title level={4} style={{ margin: 0 }}>{p.name || '（姓名未填）'}</Title>
        <Text type="secondary">{p.sex || ''}{p.age ? ` · ${p.age} 岁` : ''}</Text>
        <Tag color="blue">{p.diagnosis || '未录入诊断'}</Tag>
        {counts.staleDays > 90 ? <Tag color="orange">最新化验距今 {counts.staleDays} 天</Tag> : null}
      </Space>
      <Text type="secondary" style={{ fontSize: 12 }}>
        共 {counts.reports ?? 0} 份报告 / {counts.latest ?? 0} 项指标 / 异常 {(counts.p0 ?? 0) + (counts.p1 ?? 0)} 项 ·
        点任意指标可看原件 · 打印件为零改动的静态 3 页 A4
      </Text>
    </Space>
  ), [p, counts])

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* ---------- 顶部操作栏 ---------- */}
      <Card size="small" style={{ borderLeft: '3px solid #111' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          {headline}
          <Space wrap>
            <Button onClick={() => openProfile('')}>编辑档案与三问</Button>
            <Button size="small" onClick={() => makeCard(mask)} loading={cardLoading}>刷新数据</Button>
            {canExport && (
              <Button type="primary" onClick={() => setPrintOpen(true)} disabled={!card?.html}>打印预览 / 存 PDF</Button>
            )}
          </Space>
        </div>
      </Card>

      {/* ---------- 白血病核心资料体检条（仅屏幕） ---------- */}
      {missing.length > 0 && (
        <Alert
          className="checklist"
          type="warning"
          showIcon
          message={`暂未检出 ${missing.length} 项白血病核心资料`}
          description={
            <Space direction="vertical" size={2}>
              <Text style={{ fontSize: 12 }}>{missing.map((m) => `${m.label}：${m.detail}`).join('；')}</Text>
              <Space size={8}>
                <Button size="small" type="primary" ghost onClick={() => go('intake')}>去补传报告</Button>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {canExport ? '不影响打印，卡片仍可照常导出' : '补传后可让资料更完整'}
                </Text>
              </Space>
            </Space>
          }
        />
      )}

      {/* ---------- 主体 ---------- */}
      {coldStart ? (
        <Card size="small">
          <Empty
            description={
              <Space direction="vertical" size={4}>
                <Text strong>还没有导入任何报告</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  工作台和资料卡都是用「报告库」里的真实化验单生成的；先导入报告，或先把病友信息填好。
                </Text>
              </Space>
            }
          >
            <Space wrap>
              <Button type="primary" onClick={() => go('intake')}>去导入报告</Button>
              <Button onClick={() => go('reports')}>看报告库</Button>
              <Button onClick={() => openProfile('')}>先建档</Button>
            </Space>
          </Empty>
        </Card>
      ) : cardLoading && !card ? (
        <Card size="small"><Spin tip="生成中…" /></Card>
      ) : (
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'overview', label: '临床指标总览', children: <OverviewTab card={card} onOpenSource={openSource} onEditProfile={openProfile} /> },
            { key: 'trends', label: `动态趋势看板${card?.trendAll?.length ? `（${card.trendAll.length}）` : ''}`, children: <TrendsTab card={card} onOpenSource={openSource} /> },
            { key: 'timeline', label: `全病程原件轴${card?.timeline?.length ? `（${card.timeline.length}）` : ''}`, children: <TimelineTab card={card} onOpenSource={openSource} /> },
          ]}
        />
      )}

      {/* ---------- 三个弹窗 ---------- */}
      <PatientForm
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        form={form}
        patient={patient}
        saving={patientSaving}
        autoConclusions={card?.keyConclusions || []}
        onSave={savePatient}
        focusField={focusField}
      />
      <CardPreview
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        card={card}
        embedHtml={embedHtml}
        loading={cardLoading}
        mask={mask}
        onMaskChange={(v) => { setMask(v); if (card) makeCard(v) }}
        iframeRef={iframeRef}
        onNotify={(type, msg) => (type === 'warning' ? message.warning(msg) : message.info(msg))}
      />
      <SourceModal
        open={source.open}
        target={source.target}
        card={card}
        onClose={() => setSource((s) => ({ ...s, open: false }))}
        onSaved={() => makeCard(mask)}
      />
    </Space>
  )
}
