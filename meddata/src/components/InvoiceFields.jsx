// ===================== 发票字段编辑器（导入页与详情页共用） =====================
// 只做「受控表单 + 派生数字提示」，不做判定：查重/归属/对账全在 utils/invoice.js（纯函数，已单测）。
// 派生提示的作用是让用户在保存前就看见「票面 - 实掏 = 推定报销」这类关系，而不是保存后再回来算。

import { InputNumber, Select } from 'antd'
import DateInput from './DateInput.jsx'
import dayjs from 'dayjs'
import { Form } from 'antd'
import { fmtMoney } from '../utils/cost.js'

const CATEGORY_OPTIONS = [
  { value: 'inpatient', label: '住院' },
  { value: 'outpatient', label: '门诊' },
  { value: 'pharmacy', label: '药房' },
  { value: 'other', label: '其他' },
]

const KIND_OPTIONS = [
  { value: 'invoice', label: '收费票据' },
  { value: 'settlement', label: '医保结算单' },
]

const moneyInput = (value, onChange, placeholder) => (
  <InputNumber
    className="w-full"
    min={0}
    step={0.01}
    precision={2}
    value={value == null ? null : Number(value)}
    onChange={(v) => onChange(v == null ? null : Number(v))}
    placeholder={placeholder}
  />
)

const dateInput = (value, onChange, placeholder) => (
  <DateInput
    className="w-full"
    style={{ minWidth: 0 }}
    value={value ? dayjs(value) : null}
    onChange={(d) => onChange(d ? d.format('YYYY-MM-DD') : '')}
    placeholder={placeholder || '选择日期'}
    allowClear
  />
)

// value: 发票对象；onChange(patch)；stays: 可选住院段（用于手工归属）
// compact: 窄容器（详情弹层右栏约 460px）用两列——四列时 DatePicker 最小宽度会顶掉一半日期文字
export default function InvoiceFields({ value = {}, onChange, stays = [], showStay = true, compact = false }) {
  const set = (k, v) => onChange && onChange({ [k]: v })
  const total = Number(value.amount_total)
  const cash = Number(value.amount_cash)
  const ins = Number(value.amount_insurance)
  const hasTotal = Number.isFinite(total) && total > 0
  const derived =
    hasTotal && Number.isFinite(cash) && value.amount_cash != null && (value.amount_insurance == null || !Number.isFinite(ins))
      ? Math.round((total - cash) * 100) / 100
      : null

  return (
    <div className="space-y-3">
      <div className={compact ? 'grid grid-cols-2 gap-x-3 gap-y-2' : 'grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4'}>
        <div>
          <label className="label">票据类型</label>
          <Select
            className="w-full"
            value={value.doc_kind || 'invoice'}
            options={KIND_OPTIONS}
            onChange={(v) => set('doc_kind', v)}
          />
        </div>
        <div>
          <label className="label">类别</label>
          <Select className="w-full" value={value.category || 'inpatient'} options={CATEGORY_OPTIONS} onChange={(v) => set('category', v)} />
        </div>
        <div>
          <label className="label">票据代码</label>
          <input className="input font-mono" value={value.invoice_code || ''} onChange={(e) => set('invoice_code', e.target.value)} placeholder="8–12 位" />
        </div>
        <div>
          <label className="label">票据号码</label>
          <input
            className="input font-mono"
            value={value.invoice_no || ''}
            onChange={(e) => set('invoice_no', e.target.value)}
            placeholder="查重依据"
          />
        </div>
        <div>
          <label className="label">开票日期</label>
          {dateInput(value.issued_at, (v) => set('issued_at', v))}
        </div>
        <div>
          <label className="label">校验码</label>
          <input
            className="input font-mono"
            value={value.check_code || ''}
            onChange={(e) => set('check_code', e.target.value)}
            placeholder="可空（OCR 常读错）"
          />
        </div>
        <div>
          <label className="label">住院/就诊起</label>
          {dateInput(value.service_from, (v) => set('service_from', v), '票面起止，可空')}
        </div>
        <div>
          <label className="label">住院/就诊止</label>
          {dateInput(value.service_to, (v) => set('service_to', v), '可空')}
        </div>
      </div>

      <div className="rounded-lg bg-slate-50 p-2.5">
        <div className="mb-1.5 text-[11px] font-medium text-slate-500">金额（票面）</div>
        <div className={compact ? 'grid grid-cols-2 gap-x-3 gap-y-2' : 'grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4'}>
          <div>
            <label className="label">票面总额</label>
            {moneyInput(value.amount_total, (v) => set('amount_total', v), '价税合计')}
          </div>
          <div>
            <label className="label">医保统筹</label>
            {moneyInput(value.amount_insurance, (v) => set('amount_insurance', v), '票面无则留空')}
          </div>
          <div>
            <label className="label">个人账户</label>
            {moneyInput(value.amount_account, (v) => set('amount_account', v), '可空')}
          </div>
          <div>
            <label className="label">个人现金</label>
            {moneyInput(value.amount_cash, (v) => set('amount_cash', v), '实掏的票面证据')}
          </div>
          <div>
            <label className="label">预缴金额</label>
            {moneyInput(value.prepaid, (v) => set('prepaid', v), '可空')}
          </div>
          <div>
            <label className="label">退费金额</label>
            {moneyInput(value.refund, (v) => set('refund', v), '可空')}
          </div>
          <div>
            <label className="label">补缴金额</label>
            {moneyInput(value.supplement, (v) => set('supplement', v), '可空')}
          </div>
          <div>
            <label className="label">票据住院天数</label>
            <input
              className="input"
              type="number"
              min="0"
              value={value.hospital_days ?? ''}
              onChange={(e) => set('hospital_days', e.target.value === '' ? null : Number(e.target.value))}
              placeholder="仅作校验"
            />
          </div>
        </div>
        {derived != null && (
          <div className="mt-1.5 text-[11px] text-slate-500">
            票面 − 现金 = <span className="font-mono text-slate-700">{fmtMoney(derived)}</span>（推定报销/未付部分）
          </div>
        )}
      </div>

      <div className={compact ? 'grid grid-cols-1 gap-x-3 gap-y-2' : 'grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-3'}>
        <div className={compact ? '' : 'sm:col-span-2'}>
          <label className="label">医院 / 开票单位</label>
          <input className="input" value={value.hospital || ''} onChange={(e) => set('hospital', e.target.value)} placeholder="如：首都医科大学附属北京朝阳医院" />
        </div>
        {showStay && (
          <div>
            <label className="label">归属住院段</label>
            <Select
              className="w-full"
              value={value.stay_id || ''}
              onChange={(v) => onChange && onChange({ stay_id: v || null, stay_link: v ? 'manual' : 'none' })}
              options={[
                { value: '', label: '不归属（门诊/药房/待定）' },
                ...(stays || []).map((s) => ({
                  value: s.id,
                  label: `${s.start} ~ ${s.end || '在院'} · ${fmtMoney(s.total)} 元`,
                })),
              ]}
            />
          </div>
        )}
      </div>

      <div>
        <label className="label">备注</label>
        <input className="input" value={value.note || ''} onChange={(e) => set('note', e.target.value)} placeholder="可空" />
      </div>
    </div>
  )
}
