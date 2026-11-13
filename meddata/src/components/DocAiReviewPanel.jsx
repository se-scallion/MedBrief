// ===================== 检查报告 · 字段核对面板（核对态右栏）=====================
// 承载三轨模型的可视化：每个字段一行 = 标签 + 轨切换器 + 输入控件（+ 引文展开）。
// 设计见 .agents/proposals/ai-first-doc-recognition.md §4.1(b)/(c)：
//   · 任何手动输入都会把该字段锁定为「已手改」轨（onEdit 内部调 markUserEdit）；
//   · 引文走**固定位置的内联展开区**（不是鼠标跟随浮层），符合 UI 铁律「浮层内不放可点控件」；
//   · 两轨不同的字段在标签旁给可点的差异跳转锚点。
import { useState } from 'react'
import DateInput from './DateInput.jsx'
import { Select, Input, Button } from 'antd'
import dayjs from 'dayjs'
import { KIND_LABELS } from '../data/docKinds.js'
import DocMeasuresEditor from './DocMeasuresEditor.jsx'
import DocTrackSwitcher from './DocTrackSwitcher.jsx'
import { aiConfidenceLabel, evidenceOf, evidenceFields } from '../utils/docAi.js'

const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))

// 字段外壳：标签 + 轨切换器（+ 差异标记 + 引文开关）
function Row({ label, field, form, onSwitch, trackProps, ai, children, className = '' }) {
  const [showEv, setShowEv] = useState(false)
  const quotes = ai ? evidenceOf(ai, field) : []
  return (
    <div className={className} id={`doc-field-${field}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="label !mb-0">{label}</label>
        <div className="flex items-center gap-1.5">
          {quotes.length > 0 && (
            <button
              type="button"
              data-testid={`doc-evidence-${field}`}
              className="text-[11px] rounded border border-transparent px-1 text-slate-400 hover:text-brand-600 hover:bg-brand-50"
              title="查看 AI 的原文引文（对不上就说明没真读到）"
              onClick={() => setShowEv((v) => !v)}
            >
              引文 {quotes.length}
            </button>
          )}
          <DocTrackSwitcher form={form} field={field} onSwitch={onSwitch} />
        </div>
      </div>
      {children}
      {showEv && (
        <div className="mt-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 space-y-1">
          {quotes.map((q, i) => (
            <p key={i} className="text-[11px] text-slate-500 leading-relaxed">
              「{q}」
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DocAiReviewPanel({ form, ai, onEdit, onSwitch, className = '' }) {
  const trackProps = { form, onSwitch }
  const conf = aiConfidenceLabel(ai)
  const covered = ai ? evidenceFields(ai).length : 0
  const lowFields = ai && ai.confidence && ai.confidence.per_field
    ? Object.entries(ai.confidence.per_field).filter(([, v]) => v === 'low').map(([k]) => k)
    : []

  return (
    <div className={`p-4 space-y-3 overflow-y-auto ${className}`} data-testid="doc-ai-review-panel">
      {/* AI 自评摘要：置信度 + 引文覆盖 + 低置信字段提示 */}
      {ai && ai.status === 'done' && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            conf === '低' || lowFields.length ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-600'
          }`}
        >
          AI 置信度 {conf || '未标注'} · 引文覆盖 {covered} 个字段
          {ai.elapsedMs ? ` · 用时 ${Math.round(ai.elapsedMs / 1000)}s` : ''}
          {lowFields.length > 0 && <span> · 低置信字段（请重点核对）：{lowFields.join(' / ')}</span>}
          {ai.notes && <p className="mt-1 text-[11px] text-slate-500 leading-relaxed">AI 说明：{ai.notes}</p>}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Row label="报告类别" field="kind" ai={ai} onSwitch={onSwitch} trackProps={trackProps} form={form}>
          <Select className="w-full" size="small" value={form.kind} onChange={(v) => onEdit('kind', v)} options={KIND_OPTIONS} />
        </Row>
        <Row label="报告类型" field="doc_type" ai={ai} onSwitch={onSwitch} trackProps={trackProps} form={form}>
          <Input size="small" value={form.doc_type} placeholder="如：腹部超声 / 超声心动图" onChange={(e) => onEdit('doc_type', e.target.value)} />
        </Row>
        <Row label="检查日期" field="date" ai={ai} onSwitch={onSwitch} trackProps={trackProps} form={form}>
          <DateInput
            className="w-full"
            size="small"
            value={form.date ? dayjs(form.date) : null}
            onChange={(d) => onEdit('date', d ? d.format('YYYY-MM-DD') : '')}
            placeholder="选择日期"
            allowClear={{ clearIcon: <span title="清除日期">×</span> }}
          />
        </Row>
        <Row label="检查时间" field="time" ai={ai} onSwitch={onSwitch} trackProps={trackProps} form={form}>
          <input type="time" className="input" value={form.time} onChange={(e) => onEdit('time', e.target.value)} />
        </Row>
        <Row
          label="报告日期（可选，通常与检查同日）"
          field="reported_at"
          ai={ai}
          onSwitch={onSwitch}
          trackProps={trackProps}
          form={form}
          className="md:col-span-2"
        >
          <div className="flex gap-2">
            <DateInput
              className="flex-1"
              size="small"
              value={form.reported_at ? dayjs(form.reported_at.split(' ')[0]) : null}
              onChange={(d) =>
                onEdit('reported_at', d ? `${d.format('YYYY-MM-DD')}${(form.reported_at || '').split(' ')[1] ? ' ' + (form.reported_at || '').split(' ')[1] : ''}` : '')
              }
              placeholder="报告 / 签发日期"
              allowClear={{ clearIcon: <span title="清除日期">×</span> }}
            />
            <input
              type="time"
              className="input w-32"
              value={(form.reported_at || '').split(' ')[1] || ''}
              title="报告 / 签发时间（可空）"
              onChange={(e) => {
                const d = (form.reported_at || '').split(' ')[0] || ''
                onEdit('reported_at', e.target.value ? `${d} ${e.target.value}`.trim() : d)
              }}
            />
          </div>
        </Row>
        <Row label="报告标题" field="title" ai={ai} onSwitch={onSwitch} trackProps={trackProps} form={form}>
          <Input size="small" value={form.title} onChange={(e) => onEdit('title', e.target.value)} />
        </Row>
        <Row label="检查部位" field="part" ai={ai} onSwitch={onSwitch} trackProps={trackProps} form={form}>
          <Input size="small" value={form.part} placeholder="如：肝脏 / 骨髓 / 盆腔" onChange={(e) => onEdit('part', e.target.value)} />
        </Row>
      </div>

      <Row label="检查所见 / 描述" field="findings" ai={ai} onSwitch={onSwitch} trackProps={trackProps} form={form}>
        <Input.TextArea rows={5} value={form.findings} placeholder="自动识别结果，可修改" onChange={(e) => onEdit('findings', e.target.value)} />
      </Row>
      <Row label="诊断结论 / 提示" field="conclusion" ai={ai} onSwitch={onSwitch} trackProps={trackProps} form={form}>
        <Input.TextArea
          rows={3}
          value={form.conclusion}
          placeholder="自动识别结果，可修改"
          onChange={(e) => onEdit('conclusion', e.target.value)}
        />
      </Row>

      <div>
        <label className="label">关键测量值（可增删改）</label>
        <DocMeasuresEditor measures={form.measures} onChange={(m) => onEdit('measures', m)} trackProps={trackProps} />
      </div>

      <div>
        <label className="label">备注</label>
        <Input size="small" value={form.notes} placeholder="如：复查对比、医生建议…" onChange={(e) => onEdit('notes', e.target.value)} />
      </div>

      {ai && ai.status === 'done' && ai.evidence && ai.evidence.length > 0 && (
        <details className="rounded-lg border border-slate-100 bg-slate-50">
          <summary className="px-3 py-1.5 text-[11px] text-slate-500 cursor-pointer hover:text-slate-700">
            查看全部 AI 引文（{ai.evidence.length} 条）
          </summary>
          <div className="px-3 pb-2 space-y-1 max-h-40 overflow-auto">
            {ai.evidence.map((e, i) => (
              <p key={i} className="text-[11px] text-slate-500">
                <span className="text-slate-400">{e.field}:</span> 「{e.quote}」
              </p>
            ))}
          </div>
        </details>
      )}

      {form.raw_text && (
        <details className="rounded-lg border border-slate-100 bg-slate-50">
          <summary className="px-3 py-1.5 text-[11px] text-slate-500 cursor-pointer hover:text-slate-700">
            查看本地识别原文（{form.raw_text.length} 字）
          </summary>
          <pre className="px-3 pb-2 text-[11px] text-slate-600 whitespace-pre-wrap max-h-48 overflow-auto">{form.raw_text}</pre>
        </details>
      )}
    </div>
  )
}
