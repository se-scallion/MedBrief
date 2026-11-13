// ===================== 单份报告详情查看（弹层） =====================
// 支持行内编辑：点击任意指标行即可就地修改项目 / 结果 / 单位 / 参考范围，
// 保存时自动重算状态（computeStatus），弹窗内容随 store 即时刷新。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tag, Input, Select, App } from 'antd'
import { useStore, deleteRecord, writeRecord } from '../data/store.js'
import { FIELD_BY_CODE, STANDARD_FIELDS, mapAlias, reportTypeLabel } from '../data/dictionary.js'
import { STATUS_META, computeStatus, normalizeUnit, parseRefRange, auditPoint, buildFixSuggestion, unitOcrNoise } from '../utils/normalize.js'
import { toMarkdown, copyText } from '../utils/export.js'
import { getRecordImage } from '../utils/docFileStore.js'
import { reRecognizeRecord, fuseEngineResults } from '../utils/reRecognize.js'
import { recomputeRecordFromTrace } from '../utils/recompute.js'
import { ENGINES } from '../utils/ocrEngines.js'
import ReRecognizeRecordModal from './ReRecognizeRecordModal.jsx'
import CloudConsentModal, { hasCloudConsent } from './CloudConsentModal.jsx'
import { getConfig, getStatus } from '../utils/apiStore.js'
import { assetStatusOf } from '../utils/assetStatus.js'
import { attachRecordImage } from '../utils/assetAttach.js'
import AssetFallback from './AssetFallback.jsx'
import CloseButton from './CloseButton.jsx'
import { useEscClose, useBodyScrollLock } from '../utils/overlay.js'

const BADGE_COLOR = { red: 'red', amber: 'orange', emerald: 'green', slate: 'default' }

// 报告参考范围与字典标准差异 >50% 视为串行/错位（仪器差异通常 <20%）
function detectRefMismatch(reportRef, dictRef) {
  const r = parseRefRange(reportRef)
  const d = parseRefRange(dictRef)
  if (!r || !d || d.high == null || d.high <= 0) return false
  return Math.abs(r.high - d.high) / d.high > 0.5
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status]
  if (!meta) return null
  return (
    <Tag color={BADGE_COLOR[meta.color] || 'default'} className="!rounded-full !text-[10px] !font-semibold !mr-0">
      {meta.symbol || meta.label}
    </Tag>
  )
}

// 结果数值旁的状态标记：异常显示「箭头色块」，正常无任何标记
function StatusArrow({ status }) {
  const meta = STATUS_META[status]
  if (!meta?.symbol) return null
  const critical = meta.color === 'red'
  return (
    <span
      className={`ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold leading-none align-middle ${
        critical ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'
      }`}
      title={meta.label}
    >
      {meta.symbol}
    </span>
  )
}

const INPUT_CLS =
  'w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300'

// 只读行：点击任意位置进入编辑；onViewSource 存在且该行有 _bbox 时显示「原图」定位按钮
function PointRow({ p, onEdit, onDelete, onRecode, onViewSource }) {
  const field = FIELD_BY_CODE[p.standard_code]
  const statusBg =
    p.status === 'CRITICAL_HIGH' || p.status === 'CRITICAL_LOW'
      ? 'bg-red-50'
      : p.status === 'HIGH' || p.status === 'LOW'
        ? 'bg-amber-50'
        : ''
  return (
    <tr
      className={`border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer transition-colors ${statusBg}`}
      onClick={onEdit}
      title="点击修改该项"
    >
      <td className="px-3 py-2 text-xs">
        <div className="font-medium text-slate-700">{field ? field.name : p.original_name || '—'}</div>
        {p.standard_code && <div className="font-mono text-[10px] text-slate-400">{p.standard_code}</div>}
      </td>
      <td className="px-3 py-2 text-xs font-semibold text-slate-800 whitespace-nowrap break-words">
        {p.value}
        <StatusArrow status={p.status} />
      </td>
      <td className="px-3 py-2 text-xs text-slate-500 break-words">{p.unit || '—'}</td>
      <td className="px-3 py-2 text-xs text-slate-500 break-words">{p.ref_range || '—'}</td>
      <td className="px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-1">
          {p._audit?.codeReversed && (
            <span
              className="inline-block px-2 py-0.5 rounded-full border border-teal-300 bg-teal-50 text-teal-600 text-[10px] font-medium cursor-help"
              title={`${p._audit.codeReversedFrom ? `原识别：「${FIELD_BY_CODE[p._audit.codeReversedFrom]?.name || p._audit.codeReversedFrom}」\n` : ''}数值+参考范围与「${FIELD_BY_CODE[p.standard_code]?.name || p.standard_code}」标准档案吻合，已反推修正`}
            >
              已反推修正
            </span>
          )}
          {p._audit?.reverseHint && (
            <span
              className="inline-block px-2 py-0.5 rounded-full border border-sky-300 bg-sky-50 text-sky-700 text-[10px] font-medium cursor-help"
              title={p._audit.reverseHint}
            >
              反推指向 {p._audit.suggestName || p._audit.suggestCode || '其他项'}
            </span>
          )}
          {p._audit?.suggestCode && onRecode && (
            <Button
              size="small"
              type="text"
              className="!px-1.5 !py-0.5 !text-[10px] !font-medium !border !border-sky-300 !text-sky-700 hover:!bg-sky-50"
              onClick={(e) => {
                e.stopPropagation()
                onRecode()
              }}
              title={`改判为「${p._audit.suggestName || p._audit.suggestCode}」：保留结果 / 单位 / 参考范围，仅改项目`}
            >
              改判为此项
            </Button>
          )}
          {p._audit?.unit === 'mismatch' && (
            <span
              className="inline-block px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-600 text-[10px] font-medium cursor-help"
              title={`${p._audit.unitHint || '单位与标准档案不符'}\n点击该行可在编辑中预填标准单位`}
            >
              单位不符
            </span>
          )}
          {p._audit?.ref === 'mismatch' && (
            <span
              className="inline-block px-2 py-0.5 rounded-full border border-orange-300 bg-orange-50 text-orange-600 text-[10px] font-medium cursor-help"
              title={`${p._audit.refHint || '参考范围与标准档案不符'}\n点击该行可在编辑中预填标准参考范围`}
            >
              参考范围不符
            </span>
          )}
          {p._audit?.ref === 'near' && (
            <span
              className="inline-block px-2 py-0.5 rounded-full border border-slate-300 bg-slate-50 text-slate-500 text-[10px] font-medium cursor-help"
              title={p._audit.refHint || '参考范围与标准档案差异较大，可能为仪器标准不同'}
            >
              参考范围差异
            </span>
          )}
          {p._suspicious && p._fix && (
            <span
              className="inline-block px-2 py-0.5 rounded-full border border-orange-300 bg-orange-50 text-orange-600 text-[10px] font-medium cursor-help"
              title={`疑似识别错位：${p._fix.reason}\n${
                p._fix.candidates[0]
                  ? `修正候选：${p.value} → ${p._fix.candidates[0].fixed}（×${p._fix.candidates[0].factor}）`
                  : ''
              }\n点击该行可确认修正`}
            >
              疑似错位
            </span>
          )}
          {onViewSource && p._bbox && (
            <Button
              type="text"
              size="small"
              className="!px-1.5 !py-0.5 !text-[10px] !font-medium !border !border-slate-300 !text-slate-600 hover:!bg-slate-50"
              onClick={(e) => {
                e.stopPropagation()
                onViewSource(p._bbox)
              }}
              title="在左侧原图上定位并高亮该指标所在区域"
            >
              原图
            </Button>
          )}
          <Button
            type="text"
            danger
            size="small"
            className="!ml-auto !text-sm !leading-none"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title="删除该指标行"
          >
            ✕
          </Button>
        </div>
      </td>
    </tr>
  )
}

// 编辑行：就地修改字段，保存后重算状态
function EditableRow({ p, draft, onDraft, onSave, onCancel, onDelete }) {
  const previewCode = mapAlias(draft.name) || p.standard_code
  const previewStatus = computeStatus(previewCode, draft.value, draft.ref, draft.arrow, normalizeUnit(draft.unit))
  return (
    <tr className="border-b border-sky-100 bg-sky-50/60">
      <td className="px-3 py-2">
        <Input
          size="small"
          list="meddata-field-options"
          value={draft.name}
          placeholder="项目名称（可匹配标准字段）"
          onChange={(e) => onDraft({ ...draft, name: e.target.value })}
        />
        <datalist id="meddata-field-options">
          {STANDARD_FIELDS.map((f) => (
            <option key={f.code} value={f.name} />
          ))}
        </datalist>
        {previewCode && <div className="font-mono text-[10px] text-sky-600 mt-1">{previewCode}</div>}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <Input
            size="small"
            value={draft.value}
            placeholder="结果"
            onChange={(e) => onDraft({ ...draft, value: e.target.value })}
          />
          <Select
            size="small"
            value={draft.arrow}
            title="箭头方向"
            style={{ width: 56 }}
            onChange={(v) => onDraft({ ...draft, arrow: v })}
            options={[
              { value: '', label: '—' },
              { value: '↑', label: '↑' },
              { value: '↓', label: '↓' },
            ]}
          />
          <StatusArrow status={previewStatus} />
        </div>
      </td>
      <td className="px-3 py-2">
        <Input
          size="small"
          value={draft.unit}
          placeholder="单位"
          onChange={(e) => onDraft({ ...draft, unit: e.target.value })}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          size="small"
          value={draft.ref}
          placeholder="参考范围"
          onChange={(e) => onDraft({ ...draft, ref: e.target.value })}
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-1">
          <Button size="small" type="primary" onClick={onSave}>
            保存
          </Button>
          <Button size="small" onClick={onCancel}>
            取消
          </Button>
          <Button size="small" type="text" danger onClick={onDelete} title="删除该指标行">
            ✕
          </Button>
        </div>
      </td>
    </tr>
  )
}

export default function ReportDetail({ record, patientMeta, onClose }) {
  const [copied, setCopied] = useState(false)
  const [editIdx, setEditIdx] = useState(-1)
  const [draft, setDraft] = useState(null)
  // 从 store 取最新记录：行内编辑保存后弹窗展示随数据即时刷新
  const storeRecords = useStore().records
  const latest = storeRecords.find((r) => r.id === record.id) || record
  const { modal } = App.useApp()
  const [recoResult, setRecoResult] = useState(null)
  // 重识别弹窗开关：与 recoResult 解耦——点「重新识别」只开弹窗（空态选引擎），
  // 不再先跑一遍本地 OCR（旧交互要等 ~34s 才弹窗，用户明确要求倒转）。
  const [rrOpen, setRrOpen] = useState(false)
  // 多引擎识别：busy 进行态 / fuseBusy 融合进行态 / recoError 弹窗内错误 / consentAsk 隐私确认
  const [recoBusy, setRecoBusy] = useState(null)
  const [fuseBusy, setFuseBusy] = useState(null)
  const [recoError, setRecoError] = useState(null)
  const [consentAsk, setConsentAsk] = useState(null)
  const recoAbortRef = useRef(null)
  const consentCbRef = useRef(null)

  // 关闭口径（用户明确要求）：右上角只剩一个 × 图标，Esc 同样能关。
  // 叠了「重新识别 / 隐私确认」等内层弹窗时，Esc 只关最上层那一个（见 utils/escStack.js）。
  useEscClose(onClose)
  useBodyScrollLock()

  // 隐私确认放行：MinerU/AI 首次使用弹免责框，同意后执行挂起的回调
  const askCloudConsentOr = (engine, run) => {
    if ((engine === 'mineru' || engine === 'ai') && !hasCloudConsent(engine)) {
      consentCbRef.current = run
      setConsentAsk({ engine })
      return false
    }
    return true
  }

  // 打开重识别弹窗（空态）：先选引擎、再点「开始识别」——不再默认先跑本地 OCR
  const openReRecognize = () => {
    setRecoError(null)
    setRecoResult(null)
    setRrOpen(true)
  }

  // 快速重算（不重跑 OCR）：用留档 rawGrid/items 走新算法重映射，毫秒级。
  // 为什么要独立于「重新识别」：补丁/字典升级后只是"映射规则变了"，图没变、OCR 不必重跑；
  // 差别在于结果与「现在重新导入一次」等价（设计稿附录 F.2），且不产生 AI/CPU 成本。
  // 纪律：结果只进 ReRecognizeRecordModal 的逐项采纳，绝不整表覆盖用户手改。
  const quickRecompute = async () => {
    if (!record.trace_id) {
      modal.info({ title: '无法快速重算', content: '该记录没有识别留档（trace），请用「重新识别」重跑 OCR。' })
      return
    }
    setRecoError(null)
    setRecoBusy({ engine: 'recompute' })
    try {
      const res = await fetch(`/api/log?id=${encodeURIComponent(record.trace_id)}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`)
      const r = recomputeRecordFromTrace(record, j.snapshot)
      if (r.skipped) {
        setRecoError(
          r.skipped === 'no-material'
            ? '留档里没有可重算的识别材料，请用「重新识别」重跑 OCR'
            : r.skipped === 'no-points'
              ? '该记录没有指标行，无需重算'
              : `无法重算：${r.skipped}`,
        )
        return
      }
      setRecoResult(r)
      setRrOpen(true)
    } catch (e) {
      setRecoError(`快速重算失败：${e && e.message}`)
    } finally {
      setRecoBusy(null)
    }
  }

  // 换引擎重跑（弹窗内引擎选择器触发）：AbortController 取消旧任务；云端先过隐私确认
  const rerunWithEngine = async (engine) => {
    const go = () => {
      recoAbortRef.current?.abort()
      const ac = new AbortController()
      recoAbortRef.current = ac
      setRecoError(null)
      setRecoBusy({ engine })
      ;(async () => {
        try {
          const res = await reRecognizeRecord(record, engine, { signal: ac.signal })
          if (res.skipped === 'no-image') {
            modal.info({ title: '无法重新识别', content: '该报告未保留原件，无法用该引擎重跑。' })
            return
          }
          if (res.skipped) {
            setRecoError(`引擎未执行：${res.skipped}`)
            return
          }
          setRecoResult(res)
        } catch (e) {
          if (e && e.name === 'AbortError') return
          console.error('换引擎重识别失败', e)
          setRecoError(String((e && e.message) || e))
        } finally {
          if (recoAbortRef.current === ac) recoAbortRef.current = null
          setRecoBusy(null)
        }
      })()
    }
    // 云端引擎未同意 → askCloudConsentOr 挂起回调并弹确认框（确认后由 onOk 调 go）；
    // 非云端引擎（local / vision）直接放行 → **必须显式调用 go()**（此前漏调导致点「换引擎重跑」无反应）
    if (!askCloudConsentOr(engine, go)) return
    go()
  }

  // 多引擎融合补漏：以当前结果为基准，依次跑其余引擎 → fuseEngineResults（补漏 + 冲突并列）
  const startFuse = async () => {
    const needConsent = ['mineru', 'ai'].some((e) => !hasCloudConsent(e))
    if (needConsent) {
      consentCbRef.current = () => runFuse()
      setConsentAsk({ engine: 'mineru' }) // 用上传风险最高的 MinerU 文案
      return
    }
    runFuse()
  }

  const runFuse = async () => {
    if (!recoResult) return
    const baseEngine = recoResult.engine === 'fused' ? 'local' : recoResult.engine || 'local'
    const results = [{ engine: baseEngine, nextPoints: recoResult.nextPoints }]
    const others = Object.keys(ENGINES).filter((e) => e !== 'local' && e !== baseEngine)
    recoAbortRef.current?.abort()
    const ac = new AbortController()
    recoAbortRef.current = ac
    setRecoError(null)
    try {
      for (let i = 0; i < others.length; i++) {
        const eng = others[i]
        setFuseBusy({ engine: eng, idx: i + 1, total: others.length })
        const res = await reRecognizeRecord(record, eng, { signal: ac.signal })
        if (!res.skipped) results.push({ engine: res.engine, nextPoints: res.nextPoints })
      }
      const fused = fuseEngineResults(record, results)
      if (fused) setRecoResult(fused)
    } catch (e) {
      if (e && e.name === 'AbortError') return
      console.error('多引擎融合失败', e)
      setRecoError(String((e && e.message) || e))
    } finally {
      if (recoAbortRef.current === ac) recoAbortRef.current = null
      setFuseBusy(null)
    }
  }

  const rtLabel = reportTypeLabel(latest.report_type)
  const critical = latest.data_points.filter((p) => p.status && p.status.startsWith('CRITICAL')).length
  const abnormal = latest.data_points.filter((p) => p.status === 'LOW' || p.status === 'HIGH').length

  // 优先取 IndexedDB 高清原图（original_image_id），非图片类型（PDF）回退到 900px 缩略图
  const [originalUrl, setOriginalUrl] = useState(null)
  const [probed, setProbed] = useState(false) // 原图是否已探测完（决定能否下"未找到"的结论）
  const [reloadTick, setReloadTick] = useState(0)

  // —— 源图定位（多引擎识别 bbox 契约：point._bbox 为 0-1 归一化比例）——
  // 渲染要点（评审定稿）：原图 <img> 与高亮框同处一个 Wrapper；bbox 用百分比定位；
  // 缩放/拖拽只改外层 transform，浏览器 GPU 自动同步高亮框，JS 不参与坐标重算。
  const previewRef = useRef(null)
  const [imgRatio, setImgRatio] = useState(1.4) // naturalHeight / naturalWidth
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [highlight, setHighlight] = useState(null)
  const highlightTimer = useRef(null)
  const dragRef = useRef(null)

  const resetPreview = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setHighlight(null)
  }

  // 定位：高亮 + 顺手放大，并把 bbox 中心平移到预览窗中心（pan = 中心 - zoom×元素坐标）
  const locateBbox = (bbox) => {
    setHighlight(bbox)
    const wrap = previewRef.current
    if (!wrap) return
    const z = 1.6
    const cw = wrap.clientWidth || 1
    const ch = wrap.clientHeight || 380
    const imgH = cw * imgRatio
    const cx = (bbox.x + bbox.w / 2) * cw
    const cy = (bbox.y + bbox.h / 2) * imgH
    const px = Math.min(0, Math.max(cw - cw * z, cw / 2 - z * cx))
    const py = Math.min(0, Math.max(Math.min(0, ch - imgH * z), ch / 2 - z * cy))
    setZoom(z)
    setPan({ x: px, y: py })
    clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlight(null), 10_000)
  }

  // 滚轮缩放：React 的 onWheel 是 passive，preventDefault 必须走原生非 passive 监听
  useEffect(() => {
    const el = previewRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      setZoom((z) => Math.min(4, Math.max(0.5, z * (e.deltaY < 0 ? 1.15 : 0.87))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPreviewMouseDown = (e) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
    setDragging(true)
  }
  const onPreviewMouseMove = (e) => {
    const d = dragRef.current
    if (!d) return
    setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) })
  }
  const endPreviewDrag = () => {
    dragRef.current = null
    setDragging(false)
  }
  useEffect(() => {
    let alive = true
    const id = latest.original_image_id
    setProbed(false)
    if (!id) {
      setOriginalUrl(null)
      setProbed(true)
      return
    }
    getRecordImage(id)
      .then((blob) => {
        if (!alive || !blob) return
        if (blob.type && blob.type.startsWith('image/')) {
          const url = URL.createObjectURL(blob)
          setOriginalUrl(url)
        } else {
          setOriginalUrl(null) // PDF 等：详情页仍用缩略图
        }
      })
      .catch(() => setOriginalUrl(null))
      .finally(() => {
        if (alive) setProbed(true)
      })
    return () => {
      alive = false
      setOriginalUrl((u) => {
        if (u) URL.revokeObjectURL(u)
        return null
      })
    }
  }, [latest.original_image_id, reloadTick])

  // 原图三态（唯一口径见 utils/assetStatus.js）：最新一条记录为「人工录入/回填」时如实标注，
  // 数据源离线时只说"暂不可读"；缩略图（latest.image）在也算有原件。
  const hasAnyImage = !!(originalUrl || latest.image)
  const assetStatus = assetStatusOf(latest, {
    noun: '原图',
    manualLabel: '人工录入',
    noRefIsManual: true,
    hasBlob: probed ? hasAnyImage : null,
    online: getStatus().online,
    syncEnabled: getConfig().enabled,
  })
  const attach = async (file) => {
    try {
      await attachRecordImage(latest, file)
      setReloadTick((n) => n + 1)
    } catch (e) {
      console.error('补传原图失败', e)
    }
  }

  const markdown = useMemo(() => toMarkdown(latest, patientMeta), [latest, patientMeta])

  const doCopy = async () => {
    const ok = await copyText(markdown)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const doDelete = () => {
    modal.confirm({
      title: '删除报告',
      content: '确定删除这份报告？删除后不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        deleteRecord(latest.id)
        onClose()
      },
    })
  }

  const beginEdit = (idx) => {
    const p = latest.data_points[idx]
    const field = FIELD_BY_CODE[p.standard_code]
    // 疑似错位时预填修正候选；单位/参考范围与字典标准不符时预填字典值供确认
    const fix = p._fix && p._fix.candidates && p._fix.candidates[0]
    const unitFix = field && field.unit && p.unit && normalizeUnit(p.unit).toLowerCase() !== field.unit.toLowerCase()
    const refFix = field && field.ref && p.ref_range && detectRefMismatch(p.ref_range, field.ref)
    setDraft({
      name: (field && field.name) || p.original_name || '',
      value: fix ? String(fix.fixed) : p.value || '',
      arrow: p.arrow || '',
      unit: unitFix ? field.unit : p.unit || '',
      ref: refFix ? field.ref : p.ref_range || '',
    })
    setEditIdx(idx)
  }

  const cancelEdit = () => {
    setEditIdx(-1)
    setDraft(null)
  }

  const saveEdit = () => {
    if (!draft) return
    const code = mapAlias(draft.name) || ''
    const unit = normalizeUnit(draft.unit)
    const pts = latest.data_points.map((pt, i) => {
      if (i !== editIdx) return pt
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
        // 重算多维审计：以编辑后的项目/单位/参考范围为准，确认后提示自动消除或更新
        _audit: auditPoint(
          { standard_code: code, original_name: draft.name || pt.original_name, unit, ref_range: draft.ref },
          { rawUnit: draft.unit }
        ),
      }
    })
    writeRecord({ id: latest.id, patch: { data_points: pts }, source: 'manual' })
    cancelEdit()
  }

  // 删除某一指标行：多余的/识别多余的行可在此删除
  const deletePoint = (idx) => {
    modal.confirm({
      title: '删除指标行',
      content: '确定删除该指标行？',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        const pts = latest.data_points.filter((_, i) => i !== idx)
        writeRecord({ id: latest.id, patch: { data_points: pts }, source: 'manual' })
        cancelEdit()
      },
    })
  }

  // 一键修正全部可疑项：对单位/参考范围的可疑维度批量应用建议值（标准值）。
  // 数值永不通过一键修正改写（Bug 031：值越界≠识别错误，用户的值可能本来就是异常值）。
  const applyAllFixes = () => {
    const pts = (latest.data_points || []).map((pt) => {
      const sug = buildFixSuggestion(pt)
      if (!sug) return pt
      const next = { ...pt }
      let changed = false
      if (sug.unit !== undefined) { next.unit = normalizeUnit(sug.unit); changed = true }
      if (sug.ref !== undefined) { next.ref_range = sug.ref; changed = true }
      if (!changed) return pt
      const code = next.standard_code
      return {
        ...next,
        status: computeStatus(code, next.value, next.ref_range, next.arrow, next.unit),
        _suspicious: false,
        _fix: null,
        _audit: auditPoint(next, { rawUnit: next.unit }),
      }
    })
    writeRecord({ id: latest.id, patch: { data_points: pts }, source: 'manual' })
  }

  // 改判为反推建议的项目：用于修正「跨行错配」类识别错误——如整行的 结果/单位/参考范围
  // 其实来自另一个指标行（PLT 的三列被挂到「红细胞计数」名下）。
  // 报告自带的结果 / 单位 / 参考范围本就来自目标行，故原样保留（数值永不改写，Bug 031），
  // 仅改项目代码，并按目标档案归一单位噪声写法、重算状态与审计。
  const recodePoint = (idx) => {
    const p = latest.data_points[idx]
    const target = p && p._audit && p._audit.suggestCode
    if (!target) return
    const f = FIELD_BY_CODE[target]
    const dup = latest.data_points.some((x, i) => i !== idx && x.standard_code === target)
    const apply = () => {
      const pts = latest.data_points.map((pt, i) => {
        if (i !== idx) return pt
        // 单位仅做 OCR 噪声归一（如 410^9/L → 10^9/L），不套用字典值覆盖报告原值
        let unit = pt.unit
        if (f && f.unit && unit) {
          const noise = unitOcrNoise(unit, f.unit)
          if (noise) unit = noise
        }
        const next = { ...pt, standard_code: target, original_name: (f && f.name) || pt.original_name, unit }
        next.status = computeStatus(target, next.value, next.ref_range, next.arrow, unit)
        next._suspicious = false
        next._fix = null
        next._audit = auditPoint(
          { standard_code: target, original_name: next.original_name, unit, ref_range: next.ref_range },
          { rawUnit: unit, codeReversed: true, codeReversedFrom: pt.standard_code, nameFixed: true }
        )
        return next
      })
      writeRecord({ id: latest.id, patch: { data_points: pts }, source: 'manual' })
    }
    if (dup) {
      modal.confirm({
        title: '重复项',
        content: `本报告已有「${f ? f.name : target}」一项，改判后将重复并存。仍要改判？`,
        okText: '仍要改判',
        cancelText: '取消',
        onOk: apply,
      })
      return
    }
    apply()
  }

  const hasFixable = (latest.data_points || []).some((p) => buildFixSuggestion(p))

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
        <div
          className="card w-full max-w-[1500px] max-h-[92vh] flex flex-col overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-label={`${rtLabel || '报告'}详情 ${latest.date || ''}`}
        >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h3 className="font-semibold text-slate-800 truncate">
              {rtLabel || '报告'} · {latest.date}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              采集 {latest.checked_at || latest.date}
              {latest.received_at ? ` · 接收 ${latest.received_at}` : ''}
              {latest.reported_at ? ` · 报告 ${latest.reported_at}` : ''}
              {critical > 0 && <span className="text-red-600 font-medium"> · {critical} 项危急</span>}
              {abnormal > 0 && <span className="text-amber-600"> · {abnormal} 项偏离</span>}
            </p>
            {/* 合并留痕：本记录吸收过一份同源的归档检查报告（2026-10-28 起结构化，见 utils/dupScan.js） */}
            {latest.mergedFrom && (
              <p className="text-xs text-slate-500 mt-0.5">
                来源：已并入原归档 {latest.mergedFrom.date || ''} {latest.mergedFrom.docType || ''}
                {latest.mergedFrom.sha256 ? ` · sha256 ${String(latest.mergedFrom.sha256).slice(0, 8)}` : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="small"
              onClick={quickRecompute}
              loading={!!recoBusy && recoBusy.engine === 'recompute'}
              disabled={!!recoBusy && recoBusy.engine !== 'recompute'}
              title="用识别留档 + 当前算法重新映射（不重跑 OCR，毫秒级）；补丁/字典升级后用这个"
              data-testid="quick-recompute"
            >
              快速重算
            </Button>
            <Button size="small" onClick={openReRecognize} disabled={!!recoBusy} title="选择识别引擎后重跑原件识别并对比">
              重新识别
            </Button>
            <CloseButton onClick={onClose} testId="report-detail-close" />
          </div>
        </div>

        {/* 主体：左原图 + 右指标表 */}
        <div className="flex-1 overflow-auto p-5">
          <div className="grid gap-5 lg:grid-cols-5">
            {/* 左侧：脱敏原图（可缩放/拖拽 + 指标定位高亮） + 备注 */}
            <div className="lg:col-span-1 space-y-4">
              <div className="card p-3">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-slate-500">脱敏原图对照</h4>
                  {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
                    <button className="text-[10px] text-slate-400 hover:text-slate-600" onClick={resetPreview}>
                      重置视图
                    </button>
                  )}
                </div>
                {originalUrl || latest.image ? (
                  <div
                    ref={previewRef}
                    className={`relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50 select-none ${
                      dragging ? 'cursor-grabbing' : 'cursor-grab'
                    }`}
                    style={{ height: 380 }}
                    onMouseDown={onPreviewMouseDown}
                    onMouseMove={onPreviewMouseMove}
                    onMouseUp={endPreviewDrag}
                    onMouseLeave={endPreviewDrag}
                  >
                    {/* Wrapper：img 与高亮框同层，缩放/拖拽只动这一个 transform（GPU 同步） */}
                    <div
                      className="absolute top-0 left-0 origin-top-left"
                      style={{
                        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                        transition: dragging ? 'none' : 'transform 0.18s ease-out',
                        width: '100%',
                      }}
                    >
                      <img
                        src={originalUrl || latest.image}
                        alt="报告原图"
                        className="w-full block"
                        draggable={false}
                        onLoad={(e) => setImgRatio((e.target.naturalHeight || 1) / (e.target.naturalWidth || 1))}
                      />
                      {highlight && (
                        <div
                          className="absolute border-2 border-amber-400 bg-amber-300/25 rounded pointer-events-none"
                          style={{
                            left: `${highlight.x * 100}%`,
                            top: `${highlight.y * 100}%`,
                            width: `${highlight.w * 100}%`,
                            height: `${highlight.h * 100}%`,
                          }}
                        />
                      )}
                    </div>
                    {/* 工具条 */}
                    <div className="absolute bottom-2 right-2 flex gap-1">
                      <button
                        className="px-2 py-0.5 rounded bg-white/90 border border-slate-200 text-xs hover:bg-white"
                        onClick={(e) => {
                          e.stopPropagation()
                          setZoom((z) => Math.max(0.5, z / 1.25))
                        }}
                      >
                        −
                      </button>
                      <button
                        className="px-2 py-0.5 rounded bg-white/90 border border-slate-200 text-xs hover:bg-white"
                        onClick={(e) => {
                          e.stopPropagation()
                          setZoom((z) => Math.min(4, z * 1.25))
                        }}
                      >
                        +
                      </button>
                      <button
                        className="px-2 py-0.5 rounded bg-white/90 border border-slate-200 text-xs hover:bg-white"
                        onClick={(e) => {
                          e.stopPropagation()
                          resetPreview()
                        }}
                      >
                        重置
                      </button>
                      <button
                        className="px-2 py-0.5 rounded bg-white/90 border border-slate-200 text-xs hover:bg-white"
                        onClick={(e) => {
                          e.stopPropagation()
                          window.open(originalUrl || latest.image, '_blank', 'noreferrer')
                        }}
                        title="新标签页查看原图"
                      >
                        ↗
                      </button>
                    </div>
                    {highlight && (
                      <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-amber-500 text-white text-[10px] pointer-events-none">
                        已定位 · 10 秒后自动取消
                      </div>
                    )}
                  </div>
                ) : (
                  <AssetFallback
                    status={assetStatus}
                    noun="原图"
                    onAttach={attach}
                    onRetry={() => setReloadTick((n) => n + 1)}
                    extra={
                      <span className="text-[10px] text-slate-400">新导入的报告会自动附带原图</span>
                    }
                  />
                )}
                {originalUrl && (
                  <p className="text-[10px] text-emerald-600 mt-1">
                    已加载高清原图 · 滚轮缩放 / 拖拽移动 · 点指标行「原图」定位
                  </p>
                )}
              </div>
              {/* 报告原文（机器转录）：流式等图文报告的抬头/所检测抗原/印象/结论/注。
                  只读——它是报告本体文字，不是用户备注；患者身份信息已在识别层排除。 */}
              {latest.report_text ? (
                <div className="card p-3">
                  <h4 className="text-xs font-semibold text-slate-500 mb-1">报告原文（机器转录）</h4>
                  <p className="text-xs text-slate-700 whitespace-pre-wrap">{latest.report_text}</p>
                </div>
              ) : null}
              {latest.notes ? (
                <div className="card p-3">
                  <h4 className="text-xs font-semibold text-slate-500 mb-1">备注</h4>
                  <p className="text-xs text-slate-700 whitespace-pre-wrap">{latest.notes}</p>
                </div>
              ) : null}
            </div>

            {/* 右侧：完整指标表 */}
            <div className="lg:col-span-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-slate-500">
                  完整指标明细（{latest.data_points.length} 项）
                </h4>
                <div className="flex items-center gap-2">
                  {hasFixable && (
                    <Button
                      size="small"
                      onClick={applyAllFixes}
                      title="对单位/参考范围的可疑项一键应用标准值。数值永不自动改写——值越界（异常）不等于识别错误"
                    >
                      一键修正全部可疑项
                    </Button>
                  )}
                  <span className="text-[10px] text-sky-600">点击任意行可修改该项</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                {/* 固定表格布局：只读/编辑行共用同一组列宽，避免切换编辑时列宽抖动错乱 */}
                <table className="w-full text-sm bg-white table-fixed">
                  <thead>
                    <tr className="text-left text-[11px] text-slate-500 border-b border-slate-200 bg-slate-50">
                      <th className="px-3 py-2 font-medium w-[22%]">项目</th>
                      <th className="px-3 py-2 font-medium w-[12%]">结果</th>
                      <th className="px-3 py-2 font-medium w-[14%]">单位</th>
                      <th className="px-3 py-2 font-medium w-[18%]">参考范围</th>
                      <th className="px-3 py-2 font-medium w-[30%]">提示</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latest.data_points.map((p, i) =>
                      editIdx === i ? (
                        <EditableRow
                          key={`edit-${p.standard_code}-${i}`}
                          p={p}
                          draft={draft}
                          onDraft={setDraft}
                          onSave={saveEdit}
                          onCancel={cancelEdit}
                          onDelete={() => deletePoint(i)}
                        />
                      ) : (
                        <PointRow
                          key={`${p.standard_code}-${i}`}
                          p={p}
                          onEdit={() => beginEdit(i)}
                          onDelete={() => deletePoint(i)}
                          onRecode={() => recodePoint(i)}
                          onViewSource={locateBbox}
                        />
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <Button type={copied ? 'primary' : 'default'} size="small" onClick={doCopy}>
            {copied ? '✓ 已复制 Markdown' : '复制为 Markdown'}
          </Button>
          <Button type="text" size="small" danger onClick={doDelete}>
            删除该记录
          </Button>
        </div>
      </div>
    </div>
    {(rrOpen || recoResult) && (
      <ReRecognizeRecordModal
        record={record}
        result={recoResult}
        onClose={() => {
          setRrOpen(false)
          setRecoResult(null)
        }}
        onApplied={() => {
          setRrOpen(false)
          setRecoResult(null)
        }}
        onStart={rerunWithEngine}
        onRerunEngine={rerunWithEngine}
        onFuse={startFuse}
        busy={recoBusy}
        fuseBusy={fuseBusy}
        error={recoError}
      />
    )}
    {consentAsk && (
      <CloudConsentModal
        engine={consentAsk.engine}
        onOk={() => {
          const cb = consentCbRef.current
          consentCbRef.current = null
          setConsentAsk(null)
          cb && cb()
        }}
        onClose={() => {
          consentCbRef.current = null
          setConsentAsk(null)
        }}
      />
    )}
    </>
  )
}
