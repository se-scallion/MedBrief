// ===================== 两份报告对比弹窗（清洗去重专用） =====================
// 解决三个问题：
//   1. 看原图：对比时直接并排查看两份原始化验单，判断到底是不是同一份
//   2. 自主选择保留：系统建议（字典映射数优先）仅作参考，最终保留哪份由用户单选决定，
//      也可选择「两份都保留」——避免把同一天真实做的两次检查误合并
//   3. 顺手修正指标：点击任意单元格就地编辑（项目/结果/单位/参考范围），
//      保存即落库并重算状态，对比表随 store 实时刷新
//
// 与 ReportDetail 的关系：编辑保存的重算链路一致（normalizeUnit → computeStatus → auditPoint），
// 但本组件是「多份记录横向对齐 + 差异高亮」，非单份详情。

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useStore, writeRecord } from '../data/store.js'
import { FIELD_BY_CODE, STANDARD_FIELDS, mapAlias, reportTypeLabel } from '../data/dictionary.js'
import { STATUS_META, computeStatus, normalizeUnit, auditPoint } from '../utils/normalize.js'
import { getRecordImage, blobToUrl } from '../utils/docFileStore.js'
import { rankStats, buildCompareRows, applyPointToPoints } from '../utils/clean.js'
import { buildEditFeedback, makeEditTraceId, postFeedback } from '../utils/feedback.js'
import CloseButton from './CloseButton.jsx'
import EscClose from './EscClose.jsx'
import { useEscClose, useBodyScrollLock } from '../utils/overlay.js'

const BADGE_CLASS = {
  red: 'bg-red-100 text-red-700 border-red-200',
  amber: 'bg-amber-100 text-amber-700 border-amber-200',
  emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
}
const INPUT_CLS =
  'w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300'
// 中间操作列按钮：常显带边框，不再依赖 hover 才出现
const BTN_SYNC =
  'w-7 h-6 rounded border border-slate-300 bg-white text-slate-600 hover:border-sky-400 hover:text-sky-600 text-xs leading-none disabled:opacity-30 disabled:cursor-not-allowed'
const BTN_DEL = 'w-7 h-6 rounded border border-red-300 bg-white text-red-600 hover:bg-red-50 text-xs leading-none'
const KEEP_BOTH = '__KEEP_BOTH__'

function StatusBadge({ status }) {
  const meta = STATUS_META[status]
  if (!meta) return null
  return (
    <span
      className={`ml-1 inline-block px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${BADGE_CLASS[meta.color]}`}
      title={meta.label}
    >
      {meta.symbol || meta.label}
    </span>
  )
}

// 批量加载各组记录的原图：IndexedDB 高清原图优先，回退到记录内嵌的 900px 缩略图。
// 返回 [{ url, size, type }]——size/type 用于判断多份记录是否共用同一张图，
// 同一张单被导入两次时只显示一张，避免无意义的并排。
function useOriginalImages(recs) {
  const key = recs.map((r) => (r && r.original_image_id) || '').join('|')
  const [items, setItems] = useState([])
  useEffect(() => {
    let alive = true
    const created = []
    const ids = recs.map((r) => (r && r.original_image_id) || '')
    if (!ids.some(Boolean)) {
      // 均无 IndexedDB 原图：直接回退到记录内嵌缩略图
      setItems(recs.map((r) => (r && r.image ? { url: r.image, size: -1, type: 'fallback' } : null)))
      return
    }
    Promise.all(ids.map((id) => (id ? getRecordImage(id).catch(() => null) : Promise.resolve(null)))).then((blobs) => {
      if (!alive) return
      const out = blobs.map((blob, i) => {
        if (blob && blob.type && blob.type.startsWith('image/')) {
          const url = blobToUrl(blob)
          created.push(url)
          return { url, size: blob.size, type: blob.type }
        }
        // PDF 等非图片类型、或原图已丢失 → 回退内嵌缩略图
        const fb = recs[i] && recs[i].image
        return fb ? { url: fb, size: -1, type: 'fallback' } : null
      })
      setItems(out)
    })
    return () => {
      alive = false
      created.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [key])
  return items
}

// 单张原图窗格，带独立缩放
function ImagePane({ item, title }) {
  const [zoom, setZoom] = useState(1)
  const url = item && item.url
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-medium text-slate-600">{title}</span>
        <div className="flex items-center gap-1">
          <button
            className="px-1.5 py-0.5 text-xs rounded border border-slate-300 bg-white hover:bg-slate-100"
            onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(1)))}
            title="缩小"
          >
            −
          </button>
          <span className="text-[10px] text-slate-500 w-9 text-center">{Math.round(zoom * 100)}%</span>
          <button
            className="px-1.5 py-0.5 text-xs rounded border border-slate-300 bg-white hover:bg-slate-100"
            onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)))}
            title="放大"
          >
            ＋
          </button>
          <button
            className="px-1.5 py-0.5 text-[10px] rounded border border-slate-300 bg-white hover:bg-slate-100"
            onClick={() => setZoom(1)}
          >
            复原
          </button>
        </div>
      </div>
      <div className="card bg-slate-100 overflow-auto" style={{ height: 320 }}>
        {url ? (
          <img src={url} alt={title} className="max-w-none mx-auto" style={{ width: `${zoom * 100}%` }} />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-slate-400">无原图（非图片类型或未保留）</div>
        )}
      </div>
    </div>
  )
}

export default function CompareModal({ group, onClose, onConfirm }) {
  const storeRecords = useStore().records
  // 从 store 取最新记录：编辑保存后弹窗即时刷新
  const recs = useMemo(() => {
    const all = [group.keep, ...(group.remove || [])]
    return all.map((r) => storeRecords.find((x) => x.id === r.id) || r)
  }, [storeRecords, group])

  // 保留哪一份：默认取系统建议（字典映射数优先），但用户可改；也可选「两份都保留」
  const [choice, setChoice] = useState(group.keep ? group.keep.id : KEEP_BOTH)
  const [editing, setEditing] = useState(null) // { recIdx, pointIdx, code }
  const [draft, setDraft] = useState(null)
  // 弹窗打开时的初始快照：关闭时与当前对比 → 得到「本次会话修了什么」，回传 AI 优化 OCR
  const [initialSnapshot] = useState(() =>
    recs.map((r) => ({ id: r.id, points: (r.data_points || []).map((p) => ({ ...p })) }))
  )
  // 应用内确认框（替代 window.confirm：浏览器原生弹窗定位在页面顶部，离操作点太远）
  const [confirmBox, setConfirmBox] = useState(null) // { title, message, okLabel, danger, onOk }
  const askConfirm = (title, message, onOk, opts = {}) =>
    setConfirmBox({ title, message, okLabel: opts.okLabel || '确认', danger: !!opts.danger, onOk })

  // 按 standard_code 横向对齐所有记录，标记差异（纯函数，逻辑层已进单测）
  const rows = useMemo(() => buildCompareRows(recs), [recs])

  const diffCount = rows.filter((r) => r.differs).length

  // 原图：若各份记录的图完全一致（同字节数、同类型），说明是同一张单被导入两次，只显示一张
  const images = useOriginalImages(recs)
  const sameImage =
    images.length > 1 &&
    images.every((it) => it && it.size > 0 && it.size === images[0].size && it.type === images[0].type)

  const beginEdit = (recIdx, pointIdx, code) => {
    const p = recs[recIdx].data_points[pointIdx]
    const field = FIELD_BY_CODE[p.standard_code]
    setDraft({
      name: (field && field.name) || p.original_name || '',
      value: p.value || '',
      arrow: p.arrow || '',
      unit: p.unit || '',
      ref: p.ref_range || '',
    })
    setEditing({ recIdx, pointIdx, code })
  }

  const cancelEdit = () => {
    setEditing(null)
    setDraft(null)
  }

  // 保存单项修正：重算状态与审计，落库后对比表即时刷新
  const saveEdit = () => {
    if (!editing || !draft) return
    const rec = recs[editing.recIdx]
    const code = mapAlias(draft.name) || rec.data_points[editing.pointIdx].standard_code
    const unit = normalizeUnit(draft.unit)
    const pts = (rec.data_points || []).map((pt, i) => {
      if (i !== editing.pointIdx) return pt
      return {
        ...pt,
        original_name: draft.name || pt.original_name,
        standard_code: code,
        value: draft.value,
        arrow: draft.arrow || '',
        unit,
        ref_range: draft.ref,
        status: computeStatus(code, draft.value, draft.ref, draft.arrow, unit),
        // 保存视为用户已确认，清除疑似错位标记
        _suspicious: false,
        _fix: null,
        _audit: auditPoint(
          { standard_code: code, original_name: draft.name || pt.original_name, unit, ref_range: draft.ref },
          { rawUnit: draft.unit }
        ),
      }
    })
    writeRecord({ id: rec.id, patch: { data_points: pts }, source: 'manual' })
    cancelEdit()
  }

  // 单向同步：以 fromIdx 的该项为准覆盖 toIdx（对方缺失该项时即为「补入」）
  const syncDirection = (fromIdx, toIdx, code) => {
    const srcRec = recs[fromIdx]
    const p = (srcRec.data_points || []).find((pt) => pt.standard_code === code)
    if (!p) return
    const tgtHas = (recs[toIdx].data_points || []).some((pt) => pt.standard_code === code)
    const act = tgtHas ? '覆盖' : '补入'
    askConfirm(
      '同步确认',
      `以「报告 ${fromIdx + 1}」的「${p.original_name || code}」= ${p.value} ${act}到报告 ${toIdx + 1}？`,
      () => {
        applyPointTo(fromIdx, toIdx, code)
        cancelEdit()
      }
    )
  }

  // 删除该项（中间操作列的唯一删除按钮）：
  // 两份都有 → 两份都删（整行消失）；仅一份有 → 只删那一份。
  const deleteRowItem = (code) => {
    const targets = recs
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => (r.data_points || []).some((pt) => pt.standard_code === code))
    if (!targets.length) return
    const sample = targets[0].r.data_points.find((pt) => pt.standard_code === code)
    const names = targets.map(({ i }) => `报告 ${i + 1}`).join('、')
    askConfirm(
      '删除该项',
      `确定删除「${sample.original_name || code}」？\n将从 ${names} 中移除该项，不可撤销。`,
      () => {
        for (const { r } of targets) {
          const pts = (r.data_points || []).filter((pt) => pt.standard_code !== code)
          writeRecord({ id: r.id, patch: { data_points: pts }, source: 'manual' })
        }
        cancelEdit()
      },
      { okLabel: '删除', danger: true }
    )
  }

  // 把 srcRecIdx 的某个指标写入 targetRecIdx：对方有则覆盖，无则追加（用于补齐漏识别的项）。
  // 覆盖/追加都会重算状态并清除疑似错位标记。
  const applyPointTo = (srcRecIdx, targetRecIdx, code) => {
    const srcRec = recs[srcRecIdx]
    const tgtRec = recs[targetRecIdx]
    if (!srcRec || !tgtRec) return
    const p = (srcRec.data_points || []).find((pt) => pt.standard_code === code)
    if (!p) return
    // 纯函数：已有同 code 则覆盖、缺失则追加，并已重算状态
    writeRecord({ id: tgtRec.id, patch: { data_points: applyPointToPoints(tgtRec.data_points, p) }, source: 'manual' })
  }

  // 提交本次会话的修正反馈：仅对真正发生过修改的记录各生成一条，
  // 每条含 edits（字段级真值）/ addedRows（补齐漏识别）/ removedRows（删除误识别）。
  const submitFeedback = () => {
    for (const snap of initialSnapshot) {
      const cur = recs.find((r) => r.id === snap.id)
      if (!cur) continue
      const after = cur.data_points || []
      if (JSON.stringify(snap.points) === JSON.stringify(after)) continue
      const fb = buildEditFeedback({
        beforePoints: snap.points,
        afterPoints: after,
        recordId: snap.id,
        traceId: makeEditTraceId(),
        // 该记录入库时保留的原始 OCR Trace：AI 可据此读 logs/ocr-<id>.json 回溯原始识别
        ocrTraceId: cur.trace_id || '',
        reportType: cur.report_type || '',
        date: cur.date || '',
        image: cur.image || '',
      })
      if (!fb.edits.length && !fb.addedRows.length && !fb.removedRows.length) continue
      // fire-and-forget：不阻塞交互；失败会暂存 localStorage，由顶栏「反馈暂存」徽章补投
      postFeedback(fb).then((r) => {
        if (!r.persisted) console.warn('[feedback] 对比修正未落盘，已暂存本地，服务恢复后自动补投')
      })
    }
  }

  const handleClose = () => {
    submitFeedback()
    onClose()
  }

  const doConfirm = () => {
    submitFeedback()
    if (choice === KEEP_BOTH) {
      onConfirm(null, [])
      return
    }
    const removeIds = recs.filter((r) => r.id !== choice).map((r) => r.id)
    onConfirm(choice, removeIds)
  }

  const removeCount = choice === KEEP_BOTH ? 0 : recs.filter((r) => r.id !== choice).length

  // Esc 关闭：内层确认框开着时由它先吃掉（EscClose 后挂载＝栈顶），不会连带关掉本弹窗
  useEscClose(handleClose)
  useBodyScrollLock()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4"
      onClick={handleClose}
    >
      <div
        className="card w-full max-w-[1500px] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="报告对比"
      >
        {/* 头部 */}
        <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold">报告对比 · 选择保留哪一份</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              并排查看原图核对，可就地修正指标；保留哪份由你决定（系统建议仅供参考，不代表该项更优）
            </p>
          </div>
          <CloseButton tone="dark" onClick={handleClose} testId="compare-close" />
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {/* 记录选择区 */}
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(recs.length, 3)}, minmax(0, 1fr))` }}>
            {recs.map((r, i) => {
              const s = rankStats(r)
              const selected = choice === r.id
              const suggested = group.keep && group.keep.id === r.id
              return (
                <label
                  key={r.id}
                  className={`block text-xs rounded-lg p-3 cursor-pointer border ${
                    selected ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      className="mt-0.5"
                      name="compare-keep"
                      checked={selected}
                      onChange={() => setChoice(r.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-slate-800">报告 {i + 1}</span>
                        {suggested && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[10px]">系统建议</span>
                        )}
                      </div>
                      <p className="text-slate-600 mt-0.5">
                        {r.date} · {reportTypeLabel(r.report_type) || r.report_type}
                      </p>
                      <p className="text-slate-500">
                        字典映射 <b>{s.mapped}</b>/{s.total} · 可疑 <b>{s.suspicious}</b>
                      </p>
                      <p className="text-slate-400 text-[10px]">导入 {String(s.createdAt).replace('T', ' ').slice(0, 16)}</p>
                    </div>
                  </div>
                </label>
              )
            })}
            {/* 两份都保留：确为同一天两次真实检查时用，避免误合并 */}
            <label
              className={`block text-xs rounded-lg p-3 cursor-pointer border ${
                choice === KEEP_BOTH ? 'border-sky-400 bg-sky-50' : 'border-slate-200 bg-slate-50'
              }`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="radio"
                  className="mt-0.5"
                  name="compare-keep"
                  checked={choice === KEEP_BOTH}
                  onChange={() => setChoice(KEEP_BOTH)}
                />
                <div className="min-w-0">
                  <span className="font-semibold text-slate-800">两份都保留</span>
                  <p className="text-slate-500 mt-0.5">不合并、不删除任何记录</p>
                  <p className="text-slate-400 text-[10px]">若是同一天两次真实检查（如用药前后复查），选这个</p>
                </div>
              </div>
            </label>
          </div>

          {/* 原图区：同一张单被导入两次时只显示一张，不同则并排供核对 */}
          <div className="card p-3">
            {sameImage ? (
              <>
                <p className="text-[11px] text-emerald-700 mb-2">
                  ✓ 两份记录使用的是同一张原图（同一张化验单被导入了两次）——只需核对一次，故仅显示一张
                </p>
                <div className="flex gap-3">
                  <ImagePane item={images[0]} title="共用原图" />
                </div>
              </>
            ) : (
              <div className="flex gap-3">
                {recs.map((r, i) => (
                  <ImagePane key={r.id} item={images[i]} title={`报告 ${i + 1} 原图`} />
                ))}
              </div>
            )}
          </div>

          {/* 指标对比表 */}
          <div className="card overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-sm font-semibold text-slate-700">指标对比</h3>
              <p className="text-[11px] text-slate-500">
                共 {rows.length} 项 · <b className="text-orange-600">差异 {diffCount} 项</b> · 一致 {rows.length - diffCount} 项
                <span className="ml-2 text-slate-400">
                  （点击数值修正 · 中间 <b className="text-sky-600">←</b>/<b className="text-sky-600">→</b> 按方向覆盖或补入 · <b className="text-red-500">✕</b> 删除该项）
                </span>
              </p>
            </div>
            <div className="overflow-auto" style={{ maxHeight: 380 }}>
              <table className="w-full text-xs border-collapse">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium sticky left-0 bg-slate-50">指标</th>
                    {recs.map((r, i) => (
                      <Fragment key={r.id}>
                        <th className="text-left px-3 py-2 font-medium">
                          报告 {i + 1}
                          <span className="ml-1 text-slate-400 font-normal">{String(r.date).slice(5)}</span>
                        </th>
                        {/* 操作列紧跟第一份之后，即位于两份报告「中间」 */}
                        {i === 0 && <th className="text-center px-2 py-2 font-medium text-slate-400">操作</th>}
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Fragment key={row.code}>
                      <tr className={row.differs ? 'bg-orange-50 border-b border-orange-100' : 'border-b border-slate-100'}>
                        <td className="px-3 py-1.5 text-slate-700 sticky left-0 bg-inherit">
                          {row.name}
                          <span className="ml-1 font-mono text-[10px] text-slate-400">{row.code}</span>
                        </td>
                        {row.cells.map((c, i) => (
                          <Fragment key={i}>
                            <td
                              className={`px-3 py-1.5 whitespace-nowrap ${c.present ? 'cursor-pointer hover:bg-sky-50' : ''}`}
                              onClick={() => c.present && beginEdit(i, c.pointIdx, row.code)}
                              title={c.present ? '点击修正此项' : '该报告无此项（可用中间箭头从另一份补入）'}
                            >
                              {c.present ? (
                                <>
                                  <span className={row.differs ? 'font-semibold text-slate-900' : 'text-slate-700'}>{c.value}</span>
                                  {c.unit ? <span className="text-slate-400 ml-1">{c.unit}</span> : null}
                                  <StatusBadge status={c.status} />
                                </>
                              ) : (
                                <span className="text-slate-300">缺失</span>
                              )}
                            </td>
                            {/* 中间操作列：← 用右侧覆盖左侧 / ✕ 删除该项 / → 用左侧覆盖右侧 */}
                            {i === 0 && (
                              <td className="px-2 py-1.5 text-center whitespace-nowrap">
                                <div className="inline-flex items-center gap-1">
                                  {recs.length === 2 ? (
                                    <>
                                      <button
                                        className={BTN_SYNC}
                                        disabled={!row.cells[1] || !row.cells[1].present}
                                        onClick={() => syncDirection(1, 0, row.code)}
                                        title="用报告 2 的值覆盖报告 1（报告 1 缺失该项则为补入）"
                                      >
                                        ←
                                      </button>
                                      <button
                                        className={BTN_DEL}
                                        onClick={() => deleteRowItem(row.code)}
                                        title="删除该项：两份都有则都删，仅一份有则删那一份"
                                      >
                                        ✕
                                      </button>
                                      <button
                                        className={BTN_SYNC}
                                        disabled={!row.cells[0] || !row.cells[0].present}
                                        onClick={() => syncDirection(0, 1, row.code)}
                                        title="用报告 1 的值覆盖报告 2（报告 2 缺失该项则为补入）"
                                      >
                                        →
                                      </button>
                                    </>
                                  ) : (
                                    <button className={BTN_DEL} onClick={() => deleteRowItem(row.code)} title="删除该项">
                                      ✕
                                    </button>
                                  )}
                                </div>
                              </td>
                            )}
                          </Fragment>
                        ))}
                      </tr>
                      {/* 编辑表单：展开在被编辑指标行的下方 */}
                      {editing && editing.code === row.code && draft && (
                        <tr className="bg-sky-50/70 border-b border-sky-100">
                          <td colSpan={recs.length + 2} className="px-3 py-2">
                            <div className="flex items-end gap-2 flex-wrap">
                              <span className="text-[11px] text-sky-700 font-medium self-center">
                                修正「报告 {editing.recIdx + 1}」的 {row.name}
                              </span>
                              <div className="w-44">
                                <div className="text-[10px] text-slate-500 mb-0.5">项目名称</div>
                                <input
                                  className={INPUT_CLS}
                                  list="meddata-field-options"
                                  value={draft.name}
                                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                                />
                                <datalist id="meddata-field-options">
                                  {STANDARD_FIELDS.map((f) => (
                                    <option key={f.code} value={f.name} />
                                  ))}
                                </datalist>
                              </div>
                              <div className="w-24">
                                <div className="text-[10px] text-slate-500 mb-0.5">结果</div>
                                <input
                                  className={INPUT_CLS}
                                  value={draft.value}
                                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                                />
                              </div>
                              <div className="w-28">
                                <div className="text-[10px] text-slate-500 mb-0.5">单位</div>
                                <input
                                  className={INPUT_CLS}
                                  value={draft.unit}
                                  onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
                                />
                              </div>
                              <div className="w-32">
                                <div className="text-[10px] text-slate-500 mb-0.5">参考范围</div>
                                <input
                                  className={INPUT_CLS}
                                  value={draft.ref}
                                  onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
                                />
                              </div>
                              <div className="w-16">
                                <div className="text-[10px] text-slate-500 mb-0.5">箭头</div>
                                <select
                                  className={INPUT_CLS}
                                  value={draft.arrow}
                                  onChange={(e) => setDraft({ ...draft, arrow: e.target.value })}
                                >
                                  <option value="">—</option>
                                  <option value="↑">↑</option>
                                  <option value="↓">↓</option>
                                </select>
                              </div>
                              <button className="btn-primary text-[11px] px-2.5 py-1" onClick={saveEdit}>
                                保存
                              </button>
                              <button className="btn-ghost text-[11px] px-2.5 py-1" onClick={cancelEdit}>
                                取消
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <p className="text-[11px] text-slate-500">
            {choice === KEEP_BOTH ? (
              <>将保留全部 {recs.length} 份报告，不做合并</>
            ) : (
              <>
                将保留 <b className="text-slate-700">报告 {recs.findIndex((r) => r.id === choice) + 1}</b>，移除其余 {removeCount} 份
              </>
            )}
          </p>
          <div className="flex gap-2">
            <button className="btn-secondary text-xs" onClick={handleClose}>
              取消
            </button>
            <button className="btn-primary text-xs" onClick={doConfirm}>
              确认
            </button>
          </div>
        </div>
      </div>
      {/* 应用内确认框：替代浏览器原生 confirm（后者定位在页面顶部，离操作点太远） */}
      {confirmBox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/30"
          onClick={() => setConfirmBox(null)}
        >
          <EscClose onClose={() => setConfirmBox(null)} />
          <div
            className="bg-white rounded-lg shadow-xl border border-slate-200 p-4 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium text-slate-800">{confirmBox.title}</p>
            {confirmBox.message && (
              <p className="mt-1.5 text-xs text-slate-500 whitespace-pre-line">{confirmBox.message}</p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn-ghost text-xs" onClick={() => setConfirmBox(null)}>
                取消
              </button>
              <button
                className={`text-xs px-3 py-1 rounded ${
                  confirmBox.danger ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-sky-500 text-white hover:bg-sky-600'
                }`}
                onClick={() => {
                  const ok = confirmBox.onOk
                  setConfirmBox(null)
                  ok && ok()
                }}
              >
                {confirmBox.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
