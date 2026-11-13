// ===================== 资料卡（首页顶部左侧）=====================
// 一张「病人 ↔ 医生」共读的简要档案：就诊医院 / 初诊时间 / 分型 / 基因特点 / 当前疗程 / 当前阶段。
// 口径：只做证据归位，不做诊断推断；每个「有去处」的行整行可点跳转（固定位置，不做 hover 才出现的按钮）。
// 脱敏：姓名只留首字；右上角眼睛可一键隐藏「姓名 / 医院 / 初诊时间」三项敏感值（打印或给外人看时用）。
// 派生逻辑全在 utils/typingCard.js（纯函数，可单测），本组件只负责渲染、脱敏开关与导航。

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from 'antd'
import { useStore } from '../data/store.js'
import { buildTypingCard } from '../utils/typingCard.js'
import { todayStr } from '../utils/diseaseGrade.js'

const ROW = 'group flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-slate-50'
const LABEL = 'w-10 shrink-0 pt-0.5 text-[11px] leading-5 text-slate-400'
const VALUE = 'flex-1 text-[13px] leading-5 text-slate-700'
const HIDDEN_TEXT = '••••'

// 眼睛图标：功能性控件（开/关敏感信息），不是装饰
function EyeIcon({ open }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.8 12S5.4 5.2 12 5.2 22.2 12 22.2 12 18.6 18.8 12 18.8 1.8 12 1.8 12Z" />
      <circle cx="12" cy="12" r="3.2" />
      {!open && <path d="M3 3l18 18" />}
    </svg>
  )
}

function Chevron() {
  return (
    <span aria-hidden className="mt-0.5 shrink-0 text-slate-300 transition-all group-hover:translate-x-0.5 group-hover:text-brand-500">
      ›
    </span>
  )
}

function Row({ label, title, onClick, children }) {
  return (
    <button type="button" className={`${ROW} ${onClick ? 'cursor-pointer' : 'cursor-default'}`} onClick={onClick} title={title}>
      <span className={LABEL}>{label}</span>
      <span className={VALUE}>{children}</span>
      {onClick && <Chevron />}
    </button>
  )
}

const Empty = () => <span className="text-slate-400">未记录</span>

export default function TypingCard() {
  const navigate = useNavigate()
  const store = useStore()
  // 敏感信息默认可见；点眼睛隐藏（给外人看 / 打印带出去时用）
  const [peek, setPeek] = useState(true)
  const view = useMemo(
    () =>
      buildTypingCard(
        {
          patientMeta: store.patient_meta,
          records: store.records,
          docs: store.docs,
          courses: store.courses,
          invoices: store.invoices,
          stays: store.stays,
          diseaseMetrics: store.diseaseMetrics,
        },
        todayStr()
      ),
    [store.patient_meta, store.records, store.docs, store.courses, store.invoices, store.stays, store.diseaseMetrics]
  )

  const { identity, hospital, onset, typing, genes, course, stage } = view
  const attrs = [identity.gender, identity.age, identity.department].filter(Boolean).join(' · ')
  const hide = (text) => (peek ? text : HIDDEN_TEXT)

  return (
    <Card data-testid="typing-card" styles={{ body: { padding: 16 } }} className="!h-full">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="m-0 text-sm font-semibold text-slate-800">
            资料卡
            {identity.name && <span className="ml-2 font-normal text-slate-500">{hide(identity.name)}</span>}
          </h3>
          <p className="mt-1 text-[11px] text-slate-400">{attrs || '基本信息未记录'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              stage.tier >= 3 ? 'bg-emerald-50 text-emerald-700' : stage.tier >= 1 ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500'
            }`}
            title={`病情三维度判定层级（与指标页同一套阈值）${stage.certify === 'molecular' ? ' · 本次仅分子学证据（FCM 未确认）' : ''}`}
          >
            {stage.label || '未判定'}
            {stage.certify === 'molecular' && <span className="ml-1 font-normal text-slate-400">仅分子学</span>}
          </span>
          <button
            type="button"
            onClick={() => setPeek((v) => !v)}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            title={peek ? '隐藏姓名 / 医院 / 初诊时间（给外人看或打印时用）' : '显示敏感信息'}
            aria-label={peek ? '隐藏敏感信息' : '显示敏感信息'}
            aria-pressed={!peek}
          >
            <EyeIcon open={peek} />
          </button>
        </div>
      </div>

      <div className="mt-2 divide-y divide-slate-100">
        <Row label="医院" title="就诊医院：查看费用与票据（医院/住院段）→ 费用页" onClick={() => navigate('/cost')}>
          {hospital ? hide(hospital) : <Empty />}
        </Row>

        <Row label="初诊" title="库内最早一条记录/报告的日期；点开看全部报告 → 报告页" onClick={() => navigate('/reports')}>
          {onset.date ? (
            <span className="font-mono">
              {hide(onset.date)}
              {onset.days != null && <span className="ml-1 font-sans text-slate-400">（{onset.days} 天）</span>}
            </span>
          ) : (
            <Empty />
          )}
        </Row>

        <Row label="分型" title="查看诊断证明 / 出院记录等病历文书 → 报告页·检查" onClick={() => navigate('/reports?tab=doc')}>
          {typing.text ? <span className="font-medium text-slate-800">{typing.text}</span> : <Empty />}
        </Row>

        <Row label="基因" title="查看基因检测 / 融合基因报告 → 报告页·检查（悬停标签看解释）" onClick={() => navigate('/reports?tab=doc')}>
          {genes.length ? (
            <span className="flex flex-wrap gap-1">
              {genes.map((g) => (
                <span
                  key={g.text}
                  title={g.hint || ''}
                  className={`rounded-full border px-2 py-0.5 text-[11px] leading-4 ${
                    g.hot ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-600'
                  }`}
                >
                  {g.text}
                </span>
              ))}
            </span>
          ) : (
            <Empty />
          )}
        </Row>

        <Row label="疗程" title="查看 / 编辑疗程 → 病程页" onClick={() => navigate('/course')}>
          {course.text ? (
            <>
              {course.text}
              {course.active && <span className="ml-1 rounded bg-brand-50 px-1 text-[11px] text-brand-700">进行中</span>}
            </>
          ) : (
            <Empty />
          )}
        </Row>

        {/* 层级只在卡头徽标里出现一次，本行只给三个数值维；原文口径/阈值/日期走悬停 */}
        <Row label="阶段" title={stage.tip || '查看残留病三维度与走势 → 指标页'} onClick={() => navigate('/cbc')}>
          <span className="font-mono text-[12px] text-slate-600">{stage.detail}</span>
          {stage.gaps.length > 0 && (
            <span className="mt-0.5 block text-[11px] text-amber-600" title={stage.gaps.join('；')}>
              {stage.gaps[0]}
              {stage.gaps.length > 1 ? ` 等 ${stage.gaps.length} 项缺口` : ''}
            </span>
          )}
        </Row>
      </div>
    </Card>
  )
}
