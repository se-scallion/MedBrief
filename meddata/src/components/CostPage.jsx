// ===================== 费用页（/cost）：两本账 + 对账 =====================
// 两本账（用户 2026-10-21 定口径）：
//   ① 实掏账 = stays.total（住院段录入，实际花了多少）
//   ② 票面账 = invoices（发票/结算单原件 + 票面金额）
// 差额不是错误：票面 − 实掏 = 推定报销额；只有「实掏 > 票面」才是真问题（红标）。
//
// 与疗程页的分工：疗程页回答「这段治疗花了多少」（时间轴），本页回答「钱有没有票、票对不对账」（凭证台账）。
// 系统推算总花费仍由 utils/cost.js 计算（药费 + 住院均摊），本页只读不写，发票金额绝不并入（否则重复计费）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from 'antd'
import CostStayTable from './CostStayTable.jsx'
import InvoiceTable from './InvoiceTable.jsx'
import InvoiceDetail from './InvoiceDetail.jsx'
import { addStay, docCategory, linkInvoiceToStay, useStore } from '../data/store.js'
import { fmtMoney, summarizeCost, UNPRICED_LABEL } from '../utils/cost.js'
import { matchStay, summarizeInvoices } from '../utils/invoice.js'
import { setPendingFiles } from '../utils/pendingImport.js'
import { fmtD, localToday } from '../utils/medCourses.js'

function StatCard({ label, amount, raw, sub, detail, tone }) {
  return (
    <div className="card p-3.5">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`mt-1 break-words font-mono text-xl leading-none font-semibold sm:text-2xl ${tone || 'text-brand-700'}`}>
        {raw != null ? raw : fmtMoney(amount)}
      </div>
      <div className="mt-1.5 text-[11px] text-slate-500">{sub}</div>
      {detail && <div className="mt-0.5 text-[10px] text-slate-400">{detail}</div>}
    </div>
  )
}

export default function CostPage({ showToast }) {
  const navigate = useNavigate()
  const store = useStore()
  const events = store.events || []
  const courses = store.courses || []
  const drugPrices = store.drugPrices || []
  const stays = store.stays || []
  const invoices = store.invoices || []
  const docs = store.docs || []
  const today = localToday()

  const [msg, setMsg] = useState('')
  const [detail, setDetail] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const dragDepth = useRef(0)

  const notify = useCallback((m) => {
    setMsg(m)
    showToast && showToast(m)
    setTimeout(() => setMsg((cur) => (cur === m ? '' : cur)), 3000)
  }, [showToast])

  // 从导入页「打开已有的」跳回来时带 openInvoice
  const pendingOpen = useMemo(() => {
    const st = window.history.state && window.history.state.usr
    return st && st.openInvoice ? st.openInvoice : null
  }, [])
  useEffect(() => {
    if (pendingOpen) {
      const v = invoices.find((x) => x.id === pendingOpen)
      if (v) setDetail(v)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, invoices.length])

  const sys = useMemo(
    () => summarizeCost({ events, courses, drugPrices, stays, today }),
    [events, courses, drugPrices, stays, today]
  )
  // 当前疗程 = 最后一个（与「疗程」页同一取法：byCourse 已按 start 升序）
  const cur = sys.byCourse.length ? sys.byCourse[sys.byCourse.length - 1] : null
  const invSum = useMemo(() => summarizeInvoices(invoices, stays), [invoices, stays])
  const caseDocs = useMemo(() => docs.filter((d) => docCategory(d) === 'case' && d.fields && d.fields.admission_date), [docs])

  // 孤儿住院票：票在、住院段不在 —— 常态是「这段住院系统里还没记」。
  // 但有时住院段其实存在（历史数据没绑票）→ 先按纯函数算一次归属建议：
  //   命中已有段 → 一律「挂到该段」（绝不让他再建一个重复段）；没命中 → 才给「据此建住院段」。
  const orphans = useMemo(
    () =>
      invoices
        .filter((v) => !v.stay_id && (v.category || 'inpatient') === 'inpatient')
        .map((v) => ({ inv: v, match: matchStay(v, stays, { today }) })),
    [invoices, stays, today]
  )

  const toast = msg

  const createStayFrom = (inv) => {
    const start = inv.service_from || inv.issued_at
    if (!start) return notify('这张票没有住院起止/开票日期，无法建段，请先补日期')
    const end = inv.service_to || null
    // 实掏优先取票面「个人现金」；没有就留空让用户填（绝不拿票面总额冒充实掏）
    const total = Number(inv.amount_cash)
    addStay({
      start,
      end,
      total: Number.isFinite(total) && total > 0 ? total : 0,
      note: `${inv.hospital || '医院'} · 票号 ${inv.invoice_no || '—'}（由发票建段）`,
    })
    notify(
      Number.isFinite(total) && total > 0
        ? `已建住院段 ${start}~${end || '在院'}，实掏按票面现金 ${fmtMoney(total)} 元，请核对`
        : '已建住院段，但票面没有现金支付金额，请补实掏金额'
    )
  }

  const goAdd = (files) => {
    const list = Array.from(files || []).filter(Boolean)
    if (!list.length) return navigate('/cost/add')
    const token = setPendingFiles(list)
    navigate('/cost/add', { state: { token } })
  }

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      {/* 汇总四卡：本疗程 / 上月 / 总花费 / 票据合计。
          前三个来自 utils/cost.js 的 summarizeCost（与「疗程」页同一份推算，2026-10-31 从疗程页顶部并过来），
          第四个是票面账。两本账各自的口径直接写进卡标签，避免「哪个数算数」还要解释。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="本疗程花费"
          amount={cur ? cur.total : 0}
          sub={cur ? `${cur.range.name} ${fmtD(cur.range.start)} 起 · ${cur.days} 天` : '在「疗程」页建疗程'}
          detail={cur ? `药费 ${fmtMoney(cur.drugTotal)} + 住院 ${fmtMoney(cur.stayTotal)}` : ''}
        />
        <StatCard
          label="上月花费"
          amount={sys.lastMonth ? sys.lastMonth.total : 0}
          sub={sys.lastMonth ? `${fmtD(sys.lastMonth.from)} ~ ${fmtD(sys.lastMonth.to)}` : '无上月数据'}
          detail={sys.lastMonth ? `药费 ${fmtMoney(sys.lastMonth.drugTotal)} + 住院 ${fmtMoney(sys.lastMonth.stayTotal)}` : ''}
        />
        <StatCard
          label="总花费（药费 + 住院实掏）"
          amount={sys.total.total}
          sub={`${fmtD(sys.total.from)} ~ ${fmtD(sys.total.to)}`}
          detail={`药费 ${fmtMoney(sys.total.drugTotal)} + 住院实掏 ${fmtMoney(sys.total.stayTotal)}`}
        />
        <StatCard
          label="票据合计（票面口径）"
          amount={invSum.total}
          sub={`${invSum.count} 张${invSum.settlementCount ? ` + 结算单 ${invSum.settlementCount}` : ''} · 现金 ${
            invSum.cash != null ? fmtMoney(invSum.cash) : '—'
          }${invSum.insurance != null ? ` · 统筹 ${fmtMoney(invSum.insurance)}` : ''}`}
          detail="票面金额不是你的实际花费，两者差额=报销"
          tone="text-slate-700"
        />
      </div>

      {/* 未计价药：与总额同页提示（2026-10-31 从疗程页搬来），补价入口仍在疗程页的「药品管理」 */}
      {sys.unpricedDrugs.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          以下药未计入花费（不算 0，只是没数据）：
          {sys.unpricedDrugs.map((u) => `${u.drug}（${u.reasons.map((r) => UNPRICED_LABEL[r] || r).join('、')}）`).join('；')}
          。补单价在「疗程」页下方「药品管理」里点「改价」。
          <button
            type="button"
            className="ml-2 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100"
            onClick={() => navigate('/course')}
          >
            去补单价
          </button>
        </div>
      )}

      {/* 添加发票：拖拽区（页面内最直接的入口）+ 按钮 */}
      <div
        className={`card flex flex-wrap items-center justify-between gap-3 p-3 transition-colors ${
          dragOver ? 'ring-2 ring-brand-300' : ''
        }`}
        onDragEnter={(e) => {
          if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
          e.preventDefault()
          dragDepth.current += 1
          setDragOver(true)
        }}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={() => {
          dragDepth.current -= 1
          if (dragDepth.current <= 0) setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          dragDepth.current = 0
          setDragOver(false)
          goAdd(e.dataTransfer.files)
        }}
      >
        <div>
          <div className="text-sm font-medium text-slate-700">把发票 / 结算单拖到这里</div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            PDF 或图片 · 住院发票可一次拖入票据页 + 收费明细页（按票号自动分组）· 自动抽票面字段 · 按日期归到住院段 ·
            原件留档随时下载
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => goAdd(null)}>添加发票</Button>
        </div>
      </div>

      {/* 孤儿住院票：一键建段 */}
      {orphans.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="text-[11px] font-medium text-amber-800">
            有 {orphans.length} 张住院票还没挂到住院段（这段住院可能还没记实掏）：
          </div>
          <div className="mt-1 space-y-1">
            {orphans.slice(0, 5).map(({ inv: v, match }) => {
              const hit = match.stay_id ? stays.find((x) => x.id === match.stay_id) : null
              return (
                <div key={v.id} className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-600">
                  <span className="font-mono text-slate-500">
                    {v.service_from || v.issued_at || '无日期'}
                    {v.service_to ? ` ~ ${v.service_to}` : ''}
                  </span>
                  <span>{v.hospital || '未知医院'}</span>
                  <span className="font-medium text-slate-700">票面 {fmtMoney(v.amount_total)}</span>
                  {v.amount_cash != null && <span className="text-slate-500">现金 {fmtMoney(v.amount_cash)}</span>}
                  <div className="ml-auto flex items-center gap-2">
                    {hit ? (
                      <button
                        type="button"
                        className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100"
                        onClick={() => {
                          linkInvoiceToStay(v.id, hit.id)
                          notify(`已挂到住院段 ${hit.start}~${hit.end || '在院'}`)
                        }}
                      >
                        挂到 {hit.start}~{hit.end || '在院'} 那段
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100"
                        onClick={() => createStayFrom(v)}
                      >
                        据此建住院段
                      </button>
                    )}
                    <button type="button" className="text-[11px] text-slate-600 hover:underline" onClick={() => setDetail(v)}>
                      查看
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 住院台账（含对账） */}
      <CostStayTable
        stays={stays}
        caseDocs={caseDocs}
        invoices={invoices}
        onOpenInvoice={(v) => setDetail(v)}
        onNotify={notify}
        status={
          <div className="text-right leading-tight">
            <div className={`text-xs font-medium ${invSum.pending || invSum.orphan ? 'text-amber-600' : 'text-emerald-600'}`}>
              待核对 {invSum.pending} 段
            </div>
            <div className="text-[10px] text-slate-400">
              住院段 {stays.length} 段 · 未归属票 {invSum.unlinked} 张
              {invSum.orphan
                ? ` · 其中 ${invSum.orphan} 张未挂段`
                : !invSum.pending
                  ? ' · 账票一致'
                  : ''}
            </div>
          </div>
        }
      />

      {/* 发票库 */}
      <InvoiceTable invoices={invoices} stays={stays} onOpen={(v) => setDetail(v)} onNotify={notify} />

      {toast && <p className="text-[11px] text-emerald-600">{toast}</p>}

      <p className="px-1 text-[11px] text-slate-400">
        口径：住院段记「实际花费（实掏）」，发票记「票面总额」，两张账各自权威——票面 − 实掏 = 推定报销额；补上医保结算单后三数闭合、残差可校验。
        只有「实掏 &gt; 票面」才提示错误。系统推算总花费只含药费 + 住院实掏，不含发票金额（避免重复计费）。
        金额来源：药费 = 每日剂量 ÷ 规格 × 当时生效单价 × 天数，住院费 = 段总额 ÷ 住院天数 × 落在区间天数，疗程之间的空档并入前一个疗程；
        总花费起点取最早用药 / 住院日（可早于首个疗程），故不等于各疗程之和。
      </p>

      {detail && (
        <InvoiceDetail
          invoice={detail}
          onClose={() => setDetail(null)}
          onNotify={notify}
        />
      )}
    </div>
  )
}
