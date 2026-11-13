// ===================== 发票库（列表 + 筛选 + 批量导出） =====================
// 只负责展示与交互；查重/归属/对账判定全在 utils/invoice.js（已单测）。
// 未归属的住院票置顶提醒 —— 它们的常态是「这段住院系统里还没记」，正是一键建住院段的入口。

import { useMemo, useState } from 'react'
import { Button, Checkbox, Empty, Select, Tag } from 'antd'
import { downloadInvoice, downloadInvoices } from '../utils/invoiceDownload.js'
import { invoiceDetailCount, invoicePageCount } from '../utils/invoice.js'
import { fmtMoney } from '../utils/cost.js'

const STATE_LABEL = {
  linked: { text: '已归属', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  unlinked: { text: '未归属', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  dup: { text: '重复件', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  nofile: { text: '无原件', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
}

const CATEGORY_LABEL = { inpatient: '住院', outpatient: '门诊', pharmacy: '药房', other: '其他' }

export default function InvoiceTable({ invoices = [], stays = [], onOpen, onNotify }) {
  const [catFilter, setCatFilter] = useState('all')
  const [stateFilter, setStateFilter] = useState('all')
  const [q, setQ] = useState('')
  const [checked, setChecked] = useState([])
  const [busy, setBusy] = useState(false)
  const [limit, setLimit] = useState(50)

  const stayOf = useMemo(() => Object.fromEntries((stays || []).map((s) => [s.id, s])), [stays])

  const rows = useMemo(() => {
    const key = q.trim().toLowerCase()
    const list = (invoices || []).filter((v) => {
      if (catFilter !== 'all' && (v.category || 'inpatient') !== catFilter) return false
      const st = v.stay_id ? 'linked' : 'unlinked'
      const state = v.dup_of ? 'dup' : !v.has_file ? 'nofile' : st
      if (stateFilter !== 'all' && state !== stateFilter) return false
      if (!key) return true
      return [v.invoice_no, v.check_code, v.hospital, v.note].filter(Boolean).join(' ').toLowerCase().includes(key)
    })
    // 未归属住院票置顶，其余按开票日期倒序
    return list.sort((a, b) => {
      const ua = !a.stay_id && (a.category || 'inpatient') === 'inpatient' ? 0 : 1
      const ub = !b.stay_id && (b.category || 'inpatient') === 'inpatient' ? 0 : 1
      if (ua !== ub) return ua - ub
      return String(b.issued_at || '').localeCompare(String(a.issued_at || ''))
    })
  }, [invoices, catFilter, stateFilter, q])

  // 结算单与票据是同一笔钱的两份凭证，**不能相加**（否则票面合计翻倍）
  const slips = rows.filter((v) => (v.doc_kind || 'invoice') === 'invoice')
  const sum = slips.reduce((n, v) => n + (Number(v.amount_total) || 0), 0)
  const settleCount = rows.length - slips.length
  const orphanCount = rows.filter((v) => !v.stay_id && (v.category || 'inpatient') === 'inpatient').length
  const pageCount = rows.reduce((n, v) => n + invoicePageCount(v), 0)

  const toggle = (id, on) => setChecked((c) => (on ? [...new Set([...c, id])] : c.filter((x) => x !== id)))
  const checkedInvoices = rows.filter((v) => checked.includes(v.id))

  const exportMany = async () => {
    setBusy(true)
    const r = await downloadInvoices(checkedInvoices)
    setBusy(false)
    onNotify &&
      onNotify(
        r.ok
          ? `已导出 ${r.count} 页原件${r.missing ? `（${r.missing} 份缺原件）` : ''}${r.mode === 'directory' ? '到所选文件夹' : ''}`
          : r.reason || '导出失败'
      )
  }

  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">发票库</h3>
          <p className="mt-0.5 text-[11px] text-slate-400">
            共 {invoices.length} 份（票据 {slips.length} 张{settleCount ? ` · 结算单 ${settleCount} 份` : ''}
            {pageCount > 0 ? ` · 原件 ${pageCount} 页` : ''}）· 当前筛选合计{' '}
            {fmtMoney(sum)} 元
            {orphanCount > 0 ? ` · 未归属住院票 ${orphanCount} 张` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input h-8 w-40 text-xs"
            placeholder="搜票号 / 医院 / 备注"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select
            size="small"
            className="w-24"
            value={catFilter}
            onChange={setCatFilter}
            options={[{ value: 'all', label: '全部类别' }, ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))]}
          />
          <Select
            size="small"
            className="w-24"
            value={stateFilter}
            onChange={setStateFilter}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'linked', label: '已归属' },
              { value: 'unlinked', label: '未归属' },
              { value: 'dup', label: '重复件' },
              { value: 'nofile', label: '无原件' },
            ]}
          />
          <Button size="small" disabled={!checked.length || busy} loading={busy} onClick={exportMany}>
            导出勾选（{checked.length}）
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <Empty description={invoices.length ? '没有符合筛选的发票' : '还没有发票（点上方「添加发票」）'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] text-slate-400">
                <th className="w-8 py-1.5">
                  <Checkbox
                    checked={rows.length > 0 && checked.length === rows.length}
                    indeterminate={checked.length > 0 && checked.length < rows.length}
                    onChange={(e) => setChecked(e.target.checked ? rows.map((r) => r.id) : [])}
                  />
                </th>
                <th className="py-1.5">开票日期</th>
                <th className="py-1.5">医院 / 类型</th>
                <th className="py-1.5">票号</th>
                <th className="py-1.5 pl-4 text-right">票面</th>
                <th className="py-1.5 pl-4 text-right">统筹</th>
                <th className="py-1.5 pl-4 text-right">现金</th>
                <th className="py-1.5 pl-4">归属住院段</th>
                <th className="py-1.5">状态</th>
                <th className="py-1.5 pl-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((v) => {
                const stay = v.stay_id ? stayOf[v.stay_id] : null
                const state = v.dup_of ? 'dup' : !v.has_file ? 'nofile' : v.stay_id ? 'linked' : 'unlinked'
                const lab = STATE_LABEL[state]
                return (
                  <tr key={v.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-1.5">
                      <Checkbox checked={checked.includes(v.id)} onChange={(e) => toggle(v.id, e.target.checked)} />
                    </td>
                    <td className="whitespace-nowrap py-1.5 font-mono text-[11px] text-slate-600">{v.issued_at || '—'}</td>
                    <td className="max-w-[220px] truncate py-1.5 text-slate-700" title={v.hospital || ''}>
                      {v.hospital || '—'}
                      <span className="ml-1 text-[10px] text-slate-400">
                        {v.doc_kind === 'settlement' ? '结算单' : CATEGORY_LABEL[v.category] || '住院'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-1.5 font-mono text-[11px] text-slate-600">
                      {v.invoice_no || '—'}
                      {invoicePageCount(v) > 1 && (
                        <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-normal text-slate-500">
                          {invoicePageCount(v)} 页{invoiceDetailCount(v) ? `（明细 ${invoiceDetailCount(v)}）` : ''}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pl-4 text-right font-medium text-slate-700">{fmtMoney(v.amount_total)}</td>
                    <td className="whitespace-nowrap py-1.5 pl-4 text-right text-slate-500">{v.amount_insurance == null ? '—' : fmtMoney(v.amount_insurance)}</td>
                    <td className="whitespace-nowrap py-1.5 pl-4 text-right text-slate-500">{v.amount_cash == null ? '—' : fmtMoney(v.amount_cash)}</td>
                    <td className="whitespace-nowrap py-1.5 pl-4 text-slate-600">
                      {stay ? `${stay.start} ~ ${stay.end || '在院'}` : <span className="text-amber-600">未归属</span>}
                    </td>
                    <td className="whitespace-nowrap py-1.5">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${lab.cls}`}>{lab.text}</span>
                    </td>
                    <td className="whitespace-nowrap py-1.5 pl-4 text-right">
                      <button type="button" className="text-slate-600 hover:underline" onClick={() => onOpen && onOpen(v)}>
                        详情
                      </button>
                      <span className="mx-1.5 text-slate-200">|</span>
                      <button
                        type="button"
                        className="text-slate-600 hover:underline"
                        onClick={async () => {
                          const r = await downloadInvoice(v)
                          onNotify && onNotify(r.ok ? '已开始下载原件' : r.reason || '下载失败')
                        }}
                      >
                        下载
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length > limit && (
            <div className="mt-2 text-center">
              <Button size="small" type="text" onClick={() => setLimit((n) => n + 100)}>
                显示更多（还有 {rows.length - limit} 张）
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
