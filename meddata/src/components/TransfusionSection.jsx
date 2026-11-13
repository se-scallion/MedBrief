// ===================== 输血记录（录入 + 列表） =====================
// 从原日程页抽出（日程页已并入 /course 疗程页），支持三种用法：
//   ① 页面顶部记录区：showForm（表单默认收起）+ showList（仅「未建疗程」时列全量）
//   ② 疗程卡内：传 range → 只列该疗程区间的输血，行内可编辑/删除
// 事件仍写入 events（category:'transfusion'），趋势图与导出链路零改动。

import { useState } from 'react'
import DateInput from './DateInput.jsx'
import dayjs from 'dayjs'
import { EVENT_PRODUCTS, inferProduct } from '../data/dictionary.js'
import { addEvent, deleteEvent, updateEvent } from '../data/store.js'
import { localToday } from '../utils/medCourses.js'
import { itemsInRange } from '../utils/cost.js'

export default function TransfusionSection({ events, range = null, showForm = false, showList = true, onNotify }) {
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [date, setDate] = useState(localToday())
  const [time, setTime] = useState('')
  const [product, setProduct] = useState('plt')
  const [amount, setAmount] = useState('2U')
  const [f, setF] = useState({ date: '', time: '', product: 'plt', amount: '2U' })

  const notify = (m) => onNotify && onNotify(m)

  const submit = () => {
    if (!date || !amount.trim()) return
    addEvent({
      date,
      time: time || undefined,
      category: 'transfusion',
      color: EVENT_PRODUCTS.find((p) => p.key === product)?.color || '#ef4444',
      product,
      amount: amount.trim(),
      text: '',
    })
    setAmount('2U')
    setTime('')
    notify(`已记录 ${date} 输血：${EVENT_PRODUCTS.find((p) => p.key === product)?.label || '其他'} ${amount.trim()}`)
  }

  const startEdit = (e) => {
    setEditingId(e.id)
    setF({ date: e.date || '', time: e.time || '', product: e.product || 'plt', amount: e.amount || '2U' })
  }

  const saveEdit = () => {
    if (!editingId || !f.date || !f.amount.trim()) return
    updateEvent(editingId, {
      date: f.date,
      time: f.time || undefined,
      category: 'transfusion',
      product: f.product,
      amount: f.amount.trim(),
      text: '',
    })
    setEditingId(null)
    notify('输血记录已更新')
  }

  const list = itemsInRange(
    (events || []).filter((e) => e.category === 'transfusion'),
    range ? range.start : '',
    range ? range.end : null
  ).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  return (
    <div>
      {showForm && (
        <div className="rounded-lg bg-slate-50 p-2.5">
          <div className="flex flex-wrap gap-2 items-end">
            <div>
              <label className="label">日期</label>
              <DateInput
                className="w-36"
                value={date ? dayjs(date) : null}
                onChange={(d) => setDate(d ? d.format('YYYY-MM-DD') : '')}
                allowClear={false}
              />
            </div>
            <div>
              <label className="label">时间（可选）</label>
              <input className="input w-28" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div>
              <label className="label">制品</label>
              <select className="input w-28" value={product} onChange={(e) => setProduct(e.target.value)}>
                {EVENT_PRODUCTS.filter((p) => p.key !== 'auto').map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">数量</label>
              <input
                className="input w-24 text-center"
                value={amount}
                placeholder="如 2U / 1袋"
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>
            <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={submit}>
              保存
            </button>
          </div>
        </div>
      )}

      {showList && (
        <ul className="mt-1.5 space-y-1">
          {list.length === 0 ? (
            <li className="px-1 py-1 text-[11px] text-slate-400">
              {range ? '本疗程内没有输血记录' : '暂无输血记录'}
            </li>
          ) : (
            list.map((e) =>
              editingId === e.id ? (
                <li key={e.id} className="rounded-lg border border-brand-300 bg-brand-50 p-2">
                  <div className="flex flex-wrap gap-2 items-end">
                    <div>
                      <label className="label">日期</label>
                      <DateInput
                        className="w-36"
                        value={f.date ? dayjs(f.date) : null}
                        onChange={(d) => setF({ ...f, date: d ? d.format('YYYY-MM-DD') : '' })}
                        allowClear={false}
                      />
                    </div>
                    <div>
                      <label className="label">时间</label>
                      <input className="input w-28" type="time" value={f.time} onChange={(ev) => setF({ ...f, time: ev.target.value })} />
                    </div>
                    <div>
                      <label className="label">制品</label>
                      <select className="input w-24" value={f.product} onChange={(ev) => setF({ ...f, product: ev.target.value })}>
                        {EVENT_PRODUCTS.filter((p) => p.key !== 'auto').map((p) => (
                          <option key={p.key} value={p.key}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label">数量</label>
                      <input
                        className="input w-24 text-center"
                        value={f.amount}
                        onChange={(ev) => setF({ ...f, amount: ev.target.value })}
                        onKeyDown={(ev) => ev.key === 'Enter' && saveEdit()}
                      />
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
                </li>
              ) : (
                <li key={e.id} className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 rounded-lg px-2.5 py-1">
                  <span className="font-mono text-[11px] text-slate-400">
                    {e.date}
                    {e.time ? ' ' + e.time : ''}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate cursor-pointer hover:text-brand-700 transition-colors"
                    title="点击编辑"
                    onClick={() => startEdit(e)}
                  >
                    <span className="rounded-full border border-red-200 bg-red-50 px-1.5 text-[10px] font-medium text-red-600">
                      输血
                    </span>{' '}
                    {EVENT_PRODUCTS.find((x) => x.key === (e.product || inferProduct(e.text || '') || 'other'))?.label || '其他'}
                    {e.amount ? ` ${e.amount}` : e.text ? ` ${e.text}` : ''}
                  </span>
                  <button
                    type="button"
                    className="text-slate-400 hover:text-red-600 cursor-pointer"
                    onClick={() => {
                      deleteEvent(e.id)
                      notify('已删除输血记录')
                    }}
                  >
                    删除
                  </button>
                </li>
              )
            )
          )}
        </ul>
      )}
    </div>
  )
}
