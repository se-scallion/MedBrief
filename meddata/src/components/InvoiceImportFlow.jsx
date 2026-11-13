// ===================== 添加发票 / 结算单（独立导入页 /cost/add） =====================
// 2026-10-28 按「住院发票多页」重新设计（用户提出：一次住院 = 1 张票据 + 若干收费明细页）。
//
// 旧版：「一份文件 = 一张票」，明细页同样带分类名+金额 → 被当成另一张票入库（幽灵票），
//       而票据页那一次没认出医院名/票号就永远空着（用户 08-25 那次的症状）。
// 新版三段式：
//   ① 识别：逐份抽文字 → 分类（票据页 / 明细页 / 结算单 / 认不出），显示进度；
//   ② 分组：按「票号」把明细页挂到它的票据页上（纯函数 utils/invoiceGroup.js），
//           票据页缺票号时按文件顺序归到前面最近的一张票，并明示「请核对」；
//   ③ 校验+保存：明细合计 vs 票面总额交叉校验 → 一组存一条记录（票据页 = file，明细页 = attachments）。
// 另外两条口子保留：粘贴票面文字 / 纯手填（识别失败绝不阻断保存）。
// 判定全部复用纯函数：查重 invoiceKey/findDuplicateInvoice、归属 matchStay、分组 groupInvoicePages。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Empty, Select, Tag } from 'antd'
import BackButton from './BackButton.jsx'
import InvoiceFields from './InvoiceFields.jsx'
import { addInvoice, findDuplicateInvoice, updateInvoice, useStore } from '../data/store.js'
import { extractDocContent } from '../utils/parseDoc.js'
import { ocrImageToText, ocrScannedPdfToText } from '../utils/ocr.js'
import { fileFingerprint } from '../utils/fileHash.js'
import { saveDocFile } from '../utils/docFileStore.js'
import { mergeInvoiceFields, parsePageText, resolveHospital, bestHospitalFromTexts } from '../utils/invoiceParse.js'
import { groupInvoicePages, patchFromDetailPages } from '../utils/invoiceGroup.js'
import { matchStay } from '../utils/invoice.js'
import { clearPending, peekFiles, setPendingFiles } from '../utils/pendingImport.js'
import { fmtMoney } from '../utils/cost.js'

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = reject
    fr.readAsDataURL(file)
  })

// 文本抽取：PDF 有文字层直接抽（A 档），扫描件/图片走本地 OCR（B 档）
async function textOf(file) {
  const isPdf = (file.type || '').includes('pdf') || /\.pdf$/i.test(file.name || '')
  if (isPdf) {
    try {
      const { text, isScanned, pageCount } = await extractDocContent(file)
      if (!isScanned && text && text.trim()) return { text, source: 'pdf-text', pageCount }
      const ocrText = await ocrScannedPdfToText(file)
      return { text: ocrText || '', source: 'ocr', pageCount }
    } catch (e) {
      return { text: '', source: 'ocr', error: String((e && e.message) || e) }
    }
  }
  try {
    const dataUrl = await fileToDataUrl(file)
    const text = await ocrImageToText(dataUrl)
    return { text: text || '', source: 'ocr' }
  } catch (e) {
    return { text: '', source: 'ocr', error: String((e && e.message) || e) }
  }
}

function compact(obj = {}) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue
    if (['categories', 'totals', 'conflicts', 'org', 'doc_kind', 'hospital_candidates', 'hospital_raw'].includes(k)) continue
    out[k] = v
  }
  return out
}

// 解析结果 → 待保存字段（票据页 / 结算单 / 手填三种口径各不相同）
function fieldsFromParsed(role, fields, extra = {}) {
  if (role === 'settlement') {
    const st = fields || {}
    return {
      ...compact(st),
      doc_kind: 'settlement',
      category: 'inpatient',
      invoice_no: st.settle_no || '',
      amount_total: st.total ?? null,
      amount_cash: st.personal_due ?? null,
      issued_at: st.calc_date || null,
      hospital: st.org || '',
    }
  }
  if (role === 'invoice') {
    return { ...compact(mergeInvoiceFields(fields || {}, {})), doc_kind: 'invoice', category: 'inpatient', ...extra }
  }
  return { ...compact(fields || {}), doc_kind: 'invoice', category: 'inpatient', ...extra }
}

const ROLE_LABEL = {
  invoice: '票据页',
  detail: '收费明细页',
  settlement: '医保结算单',
  unknown: '未识别',
}

const KIND_LABEL = {
  invoice: '住院发票',
  'detail-only': '只有明细页',
  settlement: '医保结算单',
  unknown: '未识别',
}

export default function InvoiceImportFlow({ navigate, location, showToast }) {
  const store = useStore()
  const stays = store.stays || []
  const existing = store.invoices || []
  const routeToken = location?.state?.token || null
  const [localToken, setLocalToken] = useState(null)
  const token = routeToken || localToken
  const files = useMemo(() => (token ? peekFiles(token) : []), [token])
  const fileInputRef = useRef(null)

  // items：每份文件的识别结果（顺序 = 用户选择顺序）
  const [items, setItems] = useState([])
  const [phase, setPhase] = useState('idle') // idle | reading | ready
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [drafts, setDrafts] = useState({}) // groupId → 可编辑字段
  const [openIds, setOpenIds] = useState({}) // groupId → 字段表单展开
  const [mergeTargets, setMergeTargets] = useState({}) // groupId → 明细页并入的已有发票 id'' = 单独存凭证
  const [busy, setBusy] = useState('') // 正在保存的 groupId
  const [savedCount, setSavedCount] = useState(0)
  const [err, setErr] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  // 已知医院名（用于把 OCR 错字对齐成规范名）
  const knownHospitals = useMemo(
    () => [...new Set((existing || []).map((v) => v.hospital).filter(Boolean))],
    [existing]
  )

  // ---- ① 识别（单份）：文件 → 页面角色 + 票面/明细字段 ----
  // 医院名在第一道就对齐到库内规范名：OCR 会把「附属」读成「失重/队吕/附和」、
  // 「朝阳」读成「彰阳/棚阳」，靠相似度对齐已知医院比手改可靠。
  const analyzeOne = useCallback(
    async (f, i) => {
      const { text, source, error, pageCount } = await textOf(f)
      const parsed = text ? parsePageText(text, { knownHospitals }) : { role: 'unknown', fields: {} }
      let fields = parsed.fields || {}
      if (fields.hospital_raw) {
        const r = resolveHospital(fields.hospital_raw, knownHospitals)
        fields = { ...fields, hospital: r.hospital, hospital_snapped: r.snapped, hospital_suspect: !!r.suspect }
      }
      const hash = await fileFingerprint(f).catch(() => '')
      return {
        key: `i${i}`,
        name: f.name || `文件 ${i + 1}`,
        file: f,
        role: text ? parsed.role : 'unknown',
        fields,
        text,
        source: text ? source : 'manual',
        error: error || (!text ? '没抽到文字，请手填或改用「粘贴票面文字」' : ''),
        pageCount: pageCount || fields.page_count || null,
        file_hash: hash,
      }
    },
    [knownHospitals]
  )

  // ---- ① 识别（整批）+ ② 分组 ----
  const analyzeAll = useCallback(
    async (list) => {
      if (!list.length) return
      setPhase('reading')
      setErr('')
      setProgress({ done: 0, total: list.length })
      const out = []
      for (let i = 0; i < list.length; i++) {
        out.push(await analyzeOne(list[i], i))
        setItems([...out])
        setProgress({ done: i + 1, total: list.length })
      }
      setPhase('ready')
    },
    [analyzeOne]
  )

  // 只重跑某一组的那几页（绝不重跑已保存的组，避免它们被「复活」成待保存）
  const reanalyzeGroup = useCallback(
    async (g) => {
      const idxs = groupIndexes(g).filter((i) => items[i] && items[i].file)
      if (!idxs.length) return
      setPhase('reading')
      setErr('')
      setProgress({ done: 0, total: idxs.length })
      for (let n = 0; n < idxs.length; n++) {
        const i = idxs[n]
        const fresh = await analyzeOne(items[i].file, i)
        setItems((list) => list.map((it, j) => (j === i ? { ...fresh, _drop: it._drop } : it)))
        setProgress({ done: n + 1, total: idxs.length })
      }
      // 字段重算后要重建草稿，否则界面还显示旧字段
      setDrafts((d) => {
        const next = { ...d }
        delete next[g.id]
        return next
      })
      setPhase('ready')
    },
    [analyzeOne, items]
  )

  useEffect(() => {
    if (files.length) analyzeAll(files)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // 分组（纯函数）：items 变化即重算
  const { groups, warnings } = useMemo(() => {
    if (!items.length) return { groups: [], warnings: [] }
    return groupInvoicePages(
      items.map((it) => ({
        key: it.key,
        name: it.name,
        // 被「移出」的页标成 skip：groupInvoicePages 直接跳过它，但 items 下标不变
        // （下标是分组结果与草稿的索引，绝不能因删元素而平移）
        role: it._drop ? 'skip' : it.role,
        fields: it.fields,
      })),
      { existing }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, existing])

  // 分组变化 → 初始化草稿（保留用户已改的内容，不被重算覆盖）
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev }
      for (const g of groups) {
        if (next[g.id]) continue
        const main = g.mainIndex != null ? items[g.mainIndex] : null
        const base = fieldsFromParsed(main ? main.role : 'invoice', main ? main.fields : g.fields || {}, {
          file_hash: main ? main.file_hash : '',
          source: main ? main.source : 'manual',
        })
        // 明细页只有的组：金额取明细合计（票面总额的等价来源），等用户确认
        if (g.kind === 'detail-only' && g.detailTotal != null) base.amount_total = g.detailTotal
        const m = matchStay(base, stays, {})
        next[g.id] = { ...base, stay_id: m.stay_id, stay_link: m.stay_link, match_note: m.match_note, _match: m }
      }
      return next
    })
    setOpenIds((prev) => {
      const next = { ...prev }
      groups.forEach((g, i) => {
        if (next[g.id] === undefined) next[g.id] = i === 0
      })
      return next
    })
  }, [groups, items, stays])

  const patchDraft = (gid, p) => setDrafts((d) => ({ ...d, [gid]: { ...d[gid], ...p } }))

  const pickFiles = (list) => {
    const arr = Array.from(list || []).filter(Boolean)
    if (!arr.length) return
    const t = setPendingFiles(arr)
    setLocalToken(t)
    setItems([])
    setDrafts({})
    setOpenIds({})
    setErr('')
    setPhase('idle')
    setPasteOpen(false)
    analyzeAll(arr)
  }

  // 把某页移出（= 本批不导入这一页）：只打标记，不改 items 下标；
  // 底部给「撤销移出」，不做不可逆删除（用户手上那份原件不会消失）。
  const dropPage = (index) => setItems((list) => list.map((it, i) => (i === index ? { ...it, _drop: true } : it)))
  const undoDrop = () => setItems((list) => list.map((it) => (it._drop ? { ...it, _drop: false } : it)))

  // ---- ③ 保存 ----
  const savePageMeta = async (file) => {
    const id = await saveDocFile(file)
    return { id, name: file.name, type: file.type, size: file.size }
  }

  const attachmentsOf = async (g) => {
    const out = []
    for (const idx of g.detailIndexes) {
      const it = items[idx]
      if (!it || !it.file) continue
      const meta = await savePageMeta(it.file)
      out.push({
        ...meta,
        role: 'detail',
        page_no: it.fields && it.fields.page_no ? Number(it.fields.page_no) : null,
        page_count: it.fields && it.fields.page_count ? Number(it.fields.page_count) : null,
        file_hash: it.file_hash || '',
      })
    }
    return out
  }

  // 明细页组的并入目标：用户选的优先，其次分组自动命中的那张
  const targetFor = (g) => (mergeTargets[g.id] !== undefined ? mergeTargets[g.id] : g.existingId || '')

  const saveGroup = async (g, opts = {}) => {
    const draft = drafts[g.id]
    if (!draft) return
    setBusy(g.id)
    setErr('')
    try {
      const clean = { ...draft }
      delete clean._match
      const main = g.mainIndex != null ? items[g.mainIndex] : null
      const attachments = await attachmentsOf(g)
      const fileMeta = main && main.file ? await savePageMeta(main.file) : null

      // 补到已有发票：只补空字段 + 追加明细页原件
      const mergeInto = targetFor(g)
      if (g.kind === 'detail-only' && mergeInto) {
        const target = existing.find((v) => v.id === mergeInto)
        if (!target) throw new Error('目标发票已不存在，请刷新')
        const detailFields = g.detailIndexes.map((i) => items[i] && items[i].fields).filter(Boolean)
        const hosp = bestHospitalFromTexts(detailFields.map((f) => f.hospital_raw || ''), knownHospitals)
        const patch = patchFromDetailPages(target, g, detailFields, { hospital: hosp })
        const merged = [...(target.attachments || [])]
        for (const a of attachments) {
          if (!merged.some((m) => m.id === a.id)) merged.push(a)
        }
        patch.attachments = merged
        if (g.totalCheck === false) patch.detail_note = `明细合计 ${fmtMoney(g.detailTotal)} 与票面总额 ${fmtMoney(target.amount_total)} 不一致`
        else if (g.totalCheck === true) patch.detail_note = ''
        updateInvoice(target.id, patch)
        showToast && showToast(`已并入已有发票${patch.invoice_no ? ` ${patch.invoice_no}` : ''}（+${attachments.length} 页明细）`)
        setSavedCount((n) => n + 1)
        setBusy('')
        afterSaved(g)
        return
      }

      // 明细页单独成凭证时没有票据页（file = null），但仍算「有原件」——页清单里是明细页
      const row = { ...clean, file: fileMeta, has_file: !!(fileMeta || attachments.length), attachments }
      const dup = opts.force || clean.dup_of ? null : findDuplicateInvoice(clean, existing)
      if (dup) {
        setErr('这张票已经入库过，请用组内的三个选项处理')
        setBusy('')
        return
      }
      if (opts.overwriteId) {
        const target = existing.find((v) => v.id === opts.overwriteId)
        const merged = [...(target?.attachments || [])]
        for (const a of attachments) if (!merged.some((m) => m.id === a.id)) merged.push(a)
        updateInvoice(opts.overwriteId, { ...row, attachments: merged, stay_id: target?.stay_id ?? row.stay_id, stay_link: target?.stay_link ?? row.stay_link })
        showToast && showToast('已用新原件覆盖该发票')
      } else {
        addInvoice(opts.markDupOf ? { ...row, dup_of: opts.markDupOf } : row)
        showToast &&
          showToast(
            `已保存${row.doc_kind === 'settlement' ? '结算单' : '发票'}${row.invoice_no ? ` ${row.invoice_no}` : ''}${
              attachments.length ? `（含 ${attachments.length} 页明细）` : ''
            }`
          )
      }
      setSavedCount((n) => n + 1)
      setBusy('')
      // 保存后从待保存清单里移除该组
      setItems((list) => list.filter((_, i) => !groupIndexes(g).includes(i)))
      afterSaved(g)
    } catch (e) {
      setErr(`保存失败：${(e && e.message) || e}`)
      setBusy('')
    }
  }

  const groupIndexes = (g) => [g.mainIndex, ...(g.detailIndexes || []), ...(g.duplicateIndexes || [])].filter((x) => x != null)

  // 存档收尾：全部组都存完了就自动回费用页（不用用户再点一次「返回费用」）；
  // 还有组没存（多页批量）就留在本页继续。
  const afterSaved = (g) => {
    const done = groupIndexes(g).length
    if (items.filter((it) => !it._drop).length - done <= 0) {
      clearPending(token)
      navigate('/cost', { replace: true })
    }
  }

  const saveAll = async () => {
    for (const g of groups) {
      // 明细页组要用户先指认并入目标（避免又把明细页存成幽灵票）
      if (g.kind === 'detail-only' && !targetFor(g) && !(drafts[g.id] && drafts[g.id].invoice_no)) continue
      await saveGroup(g)
    }
  }

  const parsePaste = () => {
    const text = pasteText.trim()
    if (!text) return
    setErr('')
    const parsed = parsePageText(text, { knownHospitals })
    const role = parsed.role === 'detail' ? 'invoice' : parsed.role // 粘贴的是票面文字，按票据处理
    const fields = fieldsFromParsed(role, parsed.fields, { source: 'manual' })
    const it = {
      key: 'paste0',
      name: '粘贴的票面文字',
      file: null,
      role: 'invoice',
      fields: { ...parsed.fields, ...fields },
      text,
      source: 'manual',
      error: '',
    }
    setItems((list) => [...list, it])
    setPhase('ready')
    if (!fields.invoice_no && !fields.amount_total) setErr('这段文字里没认出票号或金额，请手动填写')
  }

  const back = () => {
    clearPending(token)
    navigate('/cost', { replace: true })
  }

  const droppedCount = items.filter((it) => it._drop).length
  const finished = phase === 'ready' && items.filter((it) => !it._drop).length === 0

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <BackButton onClick={back} label="返回费用" />
      <Card className="!rounded-xl" styles={{ body: { padding: 16 } }}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">添加发票 / 结算单</h3>
            <p className="mt-0.5 text-[11px] text-slate-400">
              住院发票可一次拖入多页（票据页 + 收费明细页）· 按票号自动分组 · 明细页作原件附件留档
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <Button size="small" type="text" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
              选择文件
            </Button>
            <Button size="small" type="text" onClick={() => setPasteOpen((v) => !v)}>
              粘贴票面文字
            </Button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="application/pdf,image/*"
          className="hidden"
          onChange={(e) => pickFiles(e.target.files)}
        />

        {pasteOpen && (
          <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div className="mb-1 text-[11px] text-slate-500">
              把票面文字（或结算单文字）粘贴进来，自动抽票号 / 日期 / 金额；抽不到的再手填。
            </div>
            <textarea
              className="input h-24 w-full resize-y font-mono text-[11px]"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="票据代码:11060226  票据号码:0020104754  开票日期:2026-10-20 …"
            />
            <div className="mt-1.5 flex gap-2">
              <Button size="small" type="primary" onClick={parsePaste}>
                解析文字
              </Button>
              <Button size="small" type="text" onClick={() => setPasteOpen(false)}>
                收起
              </Button>
            </div>
          </div>
        )}

        {/* 空态 */}
        {!items.length && phase !== 'reading' && (
          <div className="py-6">
            <Empty description="选择发票 / 结算单文件（可多选；一次住院的票据页与明细页建议一起选）">
              <div className="flex justify-center gap-2">
                <Button type="primary" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
                  选择文件
                </Button>
                <Button onClick={() => setPasteOpen(true)}>粘贴票面文字</Button>
                <Button type="text" onClick={back}>
                  返回费用
                </Button>
              </div>
            </Empty>
            <div
              className="mx-auto mt-3 max-w-md rounded-xl border-2 border-dashed border-slate-200 px-4 py-6 text-center text-[11px] text-slate-400"
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(e) => {
                e.preventDefault()
                pickFiles(e.dataTransfer.files)
              }}
            >
              把 PDF / 图片拖到这里（住院发票的票据页 + 明细页可以一起拖）
            </div>
          </div>
        )}

        {/* 识别进度 */}
        {phase === 'reading' && (
          <div className="py-6 text-center">
            <div className="text-sm text-slate-600">
              正在识别第 {Math.min(progress.done + 1, progress.total)}/{progress.total} 份…
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-100">
              <div
                className="h-full bg-brand-500 transition-all"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            {/* 正在识别哪一份：多页一次拖入时，进度要落在具体文件上 */}
            <div className="mt-1.5 truncate text-[11px] text-slate-500">
              {(files[Math.min(progress.done, Math.max(0, files.length - 1))] || {}).name || ''}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-400">PDF 有文字层直抽；图片走本地 OCR（不联网，可能较慢）</div>
          </div>
        )}

        {phase === 'ready' && items.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span>
              共 {items.length} 份文件 → 分成 {groups.length} 组
            </span>
            {warnings.map((w) => (
              <span key={w} className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700">
                {w}
              </span>
            ))}
          </div>
        )}

        {err && <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">{err}</div>}

        {/* 分组卡片 */}
        <div className="space-y-3">
          {(phase === 'ready' ? groups : []).map((g) => {
            const draft = drafts[g.id] || {}
            const main = g.mainIndex != null ? items[g.mainIndex] : null
            const dup = draft && draft.invoice_no && !draft.dup_of ? findDuplicateInvoice(draft, existing) : null
            const open = !!openIds[g.id]
            return (
              <div key={g.id} className="rounded-xl border border-slate-200 bg-white">
                {/* 卡头 */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Tag color={g.kind === 'invoice' ? 'blue' : g.kind === 'detail-only' ? 'orange' : 'default'} className="!mr-0">
                        {KIND_LABEL[g.kind] || g.kind}
                      </Tag>
                      <span className="truncate text-[12px] font-medium text-slate-700">
                        {draft.invoice_no ? `票号 ${draft.invoice_no}` : '无票号'}
                        {draft.issued_at ? ` · ${draft.issued_at}` : ''}
                        {draft.amount_total != null ? ` · ${fmtMoney(draft.amount_total)} 元` : ''}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
                      {/* 医院名认不出来要显眼（用户 08-25 那次的症状就是「医院名一片空」） */}
                      <span className={draft.hospital ? 'text-slate-500' : 'text-amber-600'}>
                        {draft.hospital || '医院名未识别，请手填'}
                        {draft.hospital_snapped
                          ? '（已按库内记录纠正 OCR 错字）'
                          : draft.hospital_suspect
                          ? '（OCR 可能不准，请核对）'
                          : ''}
                      </span>
                      <span>{g.detailIndexes.length} 页明细</span>
                      {g.detailTotal != null && (
                        <span className={g.totalCheck === false ? 'text-amber-600' : 'text-slate-400'}>
                          明细合计 {fmtMoney(g.detailTotal)}
                          {g.totalCheck === true ? '（与票面一致）' : g.totalCheck === false ? '（与票面不一致，请核对）' : ''}
                        </span>
                      )}
                      {main && <span className="truncate">{main.name}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="small" type="text" onClick={() => setOpenIds((o) => ({ ...o, [g.id]: !o[g.id] }))}>
                      {open ? '收起字段' : '编辑字段'}
                    </Button>
                  </div>
                </div>

                {/* 页面清单 */}
                <div className="border-b border-slate-100 px-3 py-2">
                  <div className="flex flex-wrap gap-1.5">
                    {g.mainIndex != null && (
                      <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">
                        票据页 · {items[g.mainIndex].name}
                      </span>
                    )}
                    {g.duplicateIndexes.map((i) => (
                      <span key={i} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">
                        重复票据页 · {items[i].name}
                      </span>
                    ))}
                    {g.detailIndexes.map((i) => {
                      const it = items[i] || {}
                      const f = it.fields || {}
                      return (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600"
                        >
                          明细{f.page_no ? ` 第${f.page_no}页` : ''}
                          {f.page_count ? `/${f.page_count}` : ''} · {it.name}
                          <button type="button" className="text-slate-400 hover:text-amber-600" title="本批不导入这一页" onClick={() => dropPage(i)}>
                            −
                          </button>
                        </span>
                      )
                    })}
                    {g.detailIndexes.length === 0 && g.kind === 'invoice' && (
                      <span className="text-[11px] text-slate-400">没有明细页（只存票据页也可以）</span>
                    )}
                  </div>
                  {g.warnings.length > 0 && (
                    <div className="mt-1.5 space-y-0.5">
                      {g.warnings.map((w) => (
                        <div key={w} className="text-[11px] text-amber-600">
                          {w}
                        </div>
                      ))}
                    </div>
                  )}
                  {g.note && <div className="mt-1 text-[11px] text-slate-500">{g.note}</div>}
                </div>

                {/* 明细页只有的组：选一个并入目标 / 或独立保存 */}
                {g.kind === 'detail-only' && (
                  <div className="border-b border-slate-100 px-3 py-2">
                    <div className="mb-1 text-[11px] text-slate-500">
                      {g.existingId ? '这些明细页属于库里已有的这张票：' : '这些明细页没有对应的票据页，请指定并入哪张票（或单独存为凭证）：'}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        size="small"
                        className="min-w-[280px]"
                        value={targetFor(g)}
                        onChange={(v) => setMergeTargets((m) => ({ ...m, [g.id]: v }))}
                        options={[
                          { value: '', label: '不并入（单独存为凭证）' },
                          ...existing
                            .filter((v) => !v.dup_of)
                            .map((v) => ({
                              value: v.id,
                              label: `${v.issued_at || '无日期'} · 票号 ${v.invoice_no || '—'} · ${fmtMoney(v.amount_total)} 元${
                                v.hospital ? ` · ${v.hospital}` : ''
                              }`,
                            })),
                        ]}
                      />
                    </div>
                  </div>
                )}

                {/* 字段表单 */}
                {open && (
                  <div className="px-3 py-2">
                    {dup && (
                      <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                        <div className="font-medium">这张票已经入库过：</div>
                        <div className="mt-0.5 text-[11px] text-amber-700">
                          {dup.issued_at || '无开票日期'} · 票号 {dup.invoice_no || '—'} · {fmtMoney(dup.amount_total)} 元
                          {dup.stay_id ? ' · 已归属住院段' : ' · 未归属'}
                          {dup.attachments && dup.attachments.length ? ` · 已有 ${dup.attachments.length} 页明细` : ''}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button size="small" onClick={() => navigate('/cost', { state: { openInvoice: dup.id } })}>
                            打开已有的
                          </Button>
                          {main && main.file && (
                            <Button size="small" onClick={() => saveGroup(g, { overwriteId: dup.id })}>
                              用新原件覆盖
                            </Button>
                          )}
                          <Button size="small" type="text" onClick={() => patchDraft(g.id, { dup_of: dup.id })}>
                            仍然新增（记为重复件）
                          </Button>
                        </div>
                      </div>
                    )}
                    {draft._match && draft._match.match_note && (
                      <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-600">
                        归属建议：{draft._match.match_note}
                        {['ambiguous', 'suspect'].includes(draft._match.reason) ? '（请确认后再保存）' : ''}
                      </div>
                    )}
                    <InvoiceFields value={draft} onChange={(p) => patchDraft(g.id, p)} stays={stays} />
                  </div>
                )}

                {/* 底部操作 */}
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2">
                  <Button
                    type="primary"
                    size="small"
                    loading={busy === g.id}
                    disabled={!!dup || busy === g.id}
                    onClick={() => saveGroup(g)}
                  >
                    {g.kind === 'detail-only' ? (targetFor(g) ? '并入这张票' : '单独存为凭证') : '保存这一组'}
                  </Button>
                  {main && main.file && (
                    <Button size="small" type="text" onClick={() => reanalyzeGroup(g)} disabled={phase === 'reading'}>
                      重新识别本组
                    </Button>
                  )}
                  <span className="ml-auto text-[11px] text-slate-400">
                    {draft.source === 'pdf-text' ? '字段来自 PDF 文字层' : draft.source === 'ocr' ? '字段来自本地 OCR（请核对）' : '手动录入'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        {/* 底部汇总 */}
        {phase === 'ready' && items.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <Button type="primary" loading={!!busy || phase === 'reading'} onClick={saveAll}>
              保存全部（{groups.length} 组）
            </Button>
            <Button type="text" onClick={back}>
              返回费用
            </Button>
            {savedCount > 0 && <span className="text-[11px] text-emerald-600">本次已保存 {savedCount} 组</span>}
            {droppedCount > 0 && (
              <span className="text-[11px] text-slate-500">
                已移出 {droppedCount} 页（本批不导入）
                <button type="button" className="ml-1 text-brand-600 hover:underline" onClick={undoDrop}>
                  撤销移出
                </button>
              </span>
            )}
          </div>
        )}

        {finished && (
          <div className="py-6 text-center">
            <div className="text-sm text-emerald-600">全部已保存</div>
            <Button className="mt-2" onClick={back}>
              返回费用
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
