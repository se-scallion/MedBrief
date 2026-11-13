// ===================== 住院台账（每段一次，总额按住院天数均摊） =====================
// 住院段是区间实体：入院日 / 出院日 / 该段**实掏**总额。系统按「总额 ÷ 天数」得到日均，
// 再按疗程 / 月份与住院段的重叠天数归集，跨月跨疗程都不会算漏或算重。
//
// 2026-10-21（费用模块）：本表迁到 /cost，并成为「两本账」的对账台——
//   stays.total = 实掏（本表录入，权威）｜发票票面 = 另一本账（只读引用）
//   差额不是错误，而是「推定报销额」；只有「实掏 > 票面」才红标（见 utils/invoice.js::reconcileStay）。

import { useState } from 'react'
import DateInput from './DateInput.jsx'
import dayjs from 'dayjs'
import { addStay, deleteStay, updateStay } from '../data/store.js'
import { daysBetween, fmtD, isDateStr, localToday } from '../utils/medCourses.js'
import { fmtMoney } from '../utils/cost.js'
import { invoicesOfStay, reconcileStay } from '../utils/invoice.js'
import { downloadInvoices } from '../utils/invoiceDownload.js'

// 与出院文书「弱绑定」：不存关联 ID，只在录入时提供一键采用文书日期（OCR 日期可能有误，采用后仍可改），
// 并对「有出院记录但没记费用」给出漏记提醒。
export default function CostStayTable({ stays = [], caseDocs = [], invoices = [], onOpenInvoice, onNotify, status = null }) {
  const [expanded, setExpanded] = useState(null) // 展开哪个住院段的发票
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [f, setF] = useState({ start: localToday(), end: '', total: '', note: '' })
  const [e, setE] = useState({ start: '', end: '', total: '', note: '' })

  const rows = [...stays].sort((a, b) => (a.start < b.start ? -1 : 1))
  // 出院记录里已解析出入院日，但还没有对应住院段 → 视为「漏记」，提供一键采用
  const unrecorded = (caseDocs || []).filter((d) => {
    const ad = d && d.fields && d.fields.admission_date
    return ad && !stays.some((s) => s.start === ad)
  })
  const notify = (m) => onNotify && onNotify(m)

  const submit = () => {
    const total = Number(f.total)
    if (!f.start || !Number.isFinite(total) || total <= 0) return
    addStay({ start: f.start, end: isDateStr(f.end) ? f.end : null, total, note: f.note.trim() })
    setF({ start: localToday(), end: '', total: '', note: '' })
    setOpen(false)
    notify(`已记住院 ${f.start} 起 ${fmtMoney(total)} 元`)
  }

  const startEdit = (r) => {
    setEditingId(r.id)
    setE({ start: r.start || '', end: r.end || '', total: String(r.total ?? ''), note: r.note || '' })
  }

  const saveEdit = () => {
    const total = Number(e.total)
    if (!e.start || !Number.isFinite(total) || total <= 0) return
    updateStay(editingId, { start: e.start, end: isDateStr(e.end) ? e.end : null, total, note: e.note.trim() })
    setEditingId(null)
    notify('住院记录已更新')
  }

  const daysOf = (r) => Math.max(0, daysBetween(r.start, isDateStr(r.end) ? r.end : localToday()) - 1)

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">住院台账</h3>
          <p className="text-[11px] text-slate-400">每次住院记一条（该段实掏，报销后实际花的钱），按天数均摊到疗程与月份；右侧为与发票的对账结果</p>
        </div>
        <div className="flex items-center gap-3">
          {/* 卡头状态槽（费用页放「待核对 N 段」；不传则整块不渲染） */}
          {status}
          <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={() => setOpen(!open)}>
            {open ? '收起' : '＋ 记住院'}
          </button>
        </div>
      </div>

      {/* 出院文书：点了就把入院/出院日带进表单（金额仍需手填） */}
      {unrecorded.length > 0 && (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5">
          <div className="text-[11px] text-amber-700 mb-1">有 {unrecorded.length} 次出院记录还没记费用：</div>
          <div className="space-y-1">
            {unrecorded.map((d) => {
              const ad = d.fields.admission_date
              const dd = d.fields.discharge_date || ''
              return (
                <div key={d.id} className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-600">
                  <span className="font-mono text-slate-500">
                    {fmtD(ad)}
                    {dd ? ` ~ ${fmtD(dd)}` : ' 起'}
                  </span>
                  <span className="text-slate-400">{d.fields.hospital_days ? `${d.fields.hospital_days} 天` : ''}</span>
                  <span className="text-slate-400 truncate max-w-[240px]">{d.title || '出院记录'}</span>
                  <button
                    type="button"
                    className="ml-auto rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100 cursor-pointer"
                    onClick={() => {
                      setF({ ...f, start: ad, end: isDateStr(dd) ? dd : '', total: f.total })
                      setOpen(true)
                    }}
                  >
                    用这个日期
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {open && (
        <div className="flex flex-wrap gap-2 items-end mb-3 rounded-lg bg-slate-50 p-2.5">
          <div>
            <label className="label">入院日</label>
            <DateInput
              className="w-36"
              value={f.start ? dayjs(f.start) : null}
              onChange={(d) => setF({ ...f, start: d ? d.format('YYYY-MM-DD') : '' })}
              allowClear={false}
            />
          </div>
          <div>
            <label className="label">出院日（留空=仍在院）</label>
            <DateInput
              className="w-36"
              value={f.end ? dayjs(f.end) : null}
              onChange={(d) => setF({ ...f, end: d ? d.format('YYYY-MM-DD') : '' })}
              allowClear
              placeholder="留空"
            />
          </div>
          <div className="w-32">
            <label className="label">实掏金额（元）</label>
            <input
              className="input text-center"
              type="number"
              min="0"
              step="any"
              value={f.total}
              onChange={(ev) => setF({ ...f, total: ev.target.value })}
              onKeyDown={(ev) => ev.key === 'Enter' && submit()}
            />
          </div>
          <div className="min-w-[140px] flex-1">
            <label className="label">备注</label>
            <input
              className="input"
              placeholder="如：人民医院 · 化疗"
              value={f.note}
              onChange={(ev) => setF({ ...f, note: ev.target.value })}
              onKeyDown={(ev) => ev.key === 'Enter' && submit()}
            />
          </div>
          <div className="flex gap-2 pb-0.5">
            <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={submit}>
              保存
            </button>
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-white transition-colors"
              onClick={() => setOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="px-1 py-3 text-xs text-slate-400">还没有住院费用记录。</p>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => {
            const days = daysOf(r)
            const daily = r.total / days
            if (editingId === r.id) {
              return (
                <div key={r.id} className="flex flex-wrap gap-2 items-end rounded-lg bg-slate-50 p-2">
                  <div>
                    <label className="label">入院日</label>
                    <DateInput className="w-36" value={e.start ? dayjs(e.start) : null} onChange={(d) => setE({ ...e, start: d ? d.format('YYYY-MM-DD') : '' })} allowClear={false} />
                  </div>
                  <div>
                    <label className="label">出院日</label>
                    <DateInput className="w-36" value={e.end ? dayjs(e.end) : null} onChange={(d) => setE({ ...e, end: d ? d.format('YYYY-MM-DD') : '' })} allowClear placeholder="留空" />
                  </div>
                  <div className="w-28">
                    <label className="label">总额</label>
                    <input className="input text-center" type="number" min="0" step="any" value={e.total} onChange={(ev) => setE({ ...e, total: ev.target.value })} />
                  </div>
                  <div className="min-w-[120px] flex-1">
                    <label className="label">备注</label>
                    <input className="input" value={e.note} onChange={(ev) => setE({ ...e, note: ev.target.value })} />
                  </div>
                  <div className="flex gap-2 pb-0.5">
                    <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={saveEdit}>
                      保存
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-white transition-colors"
                      onClick={() => setEditingId(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )
            }
            const rec = reconcileStay(r, invoices)
            const mine = invoicesOfStay(r.id, invoices)
            const open = expanded === r.id
            const badge =
              rec.state === 'over'
                ? { text: '实掏超票面', cls: 'bg-red-50 text-red-700 border-red-200' }
                : rec.state === 'residual'
                ? { text: `残差 ${fmtMoney(rec.residual)}`, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
                : rec.state === 'closed'
                ? { text: '账票闭合', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
                : rec.state === 'derived'
                ? { text: '推定报销', cls: 'bg-slate-100 text-slate-600 border-slate-200' }
                : { text: '无票', cls: 'bg-white text-slate-400 border-slate-200' }
            return (
              <div key={r.id} className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-[11px] text-slate-400">
                    {r.start} ~ {r.end || '在院'}
                  </span>
                  <span className="text-slate-400">{days} 天</span>
                  <span className="font-medium text-slate-700">实掏 {fmtMoney(r.total)}</span>
                  <span className="text-slate-400">日均 {fmtMoney(daily)}</span>
                  {rec.count > 0 && <span className="text-slate-500">票面 {fmtMoney(rec.total)}</span>}
                  {rec.insurance != null && <span className="text-slate-500">统筹 {fmtMoney(rec.insurance)}</span>}
                  {rec.state === 'derived' && rec.derivedInsurance != null && (
                    <span className="text-slate-500">推定报销 {fmtMoney(rec.derivedInsurance)}</span>
                  )}
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
                  {rec.rangeMismatch && <span className="text-[10px] text-amber-600">票面区间与住院段不一致</span>}
                  {r.note && <span className="text-[11px] text-slate-500">· {r.note}</span>}
                  <div className="ml-auto flex items-center gap-2.5">
                    <button
                      type="button"
                      className="cursor-pointer text-slate-600 hover:underline"
                      onClick={() => setExpanded(open ? null : r.id)}
                    >
                      凭证 {mine.length ? `(${mine.length})` : ''}
                    </button>
                    <button type="button" className="text-slate-600 hover:underline cursor-pointer" onClick={() => startEdit(r)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="text-slate-400 hover:text-red-600 cursor-pointer"
                      onClick={() => {
                        deleteStay(r.id)
                        notify('已删除住院费用记录（关联发票已解绑）')
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="mt-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                    {mine.length === 0 ? (
                      <div className="text-[11px] text-slate-400">该段还没有发票。可在「发票库」添加后选这个住院段。</div>
                    ) : (
                      <div className="space-y-1">
                        {mine.map((v) => (
                          <div key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
                            <span className="font-mono text-slate-500">{v.issued_at || '—'}</span>
                            <span className="font-mono text-slate-400">{v.invoice_no || '无票号'}</span>
                            <span className="font-medium text-slate-700">{fmtMoney(v.amount_total)}</span>
                            {v.amount_insurance != null && <span className="text-slate-400">统筹 {fmtMoney(v.amount_insurance)}</span>}
                            <div className="ml-auto flex items-center gap-2">
                              <button type="button" className="text-slate-600 hover:underline" onClick={() => onOpenInvoice && onOpenInvoice(v)}>
                                查看
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {mine.length > 0 && (
                      <div className="mt-1.5 border-t border-slate-100 pt-1.5">
                        <button
                          type="button"
                          className="text-[11px] text-slate-600 hover:underline"
                          onClick={async () => {
                            const res = await downloadInvoices(mine)
                            notify(
                              res.ok
                                ? `已导出 ${res.count} 份原件${res.missing ? `（${res.missing} 份缺原件）` : ''}`
                                : res.reason || '导出失败'
                            )
                          }}
                        >
                          下载本段全部原件
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
