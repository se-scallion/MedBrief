// ===================== Web 可视化校对网格（类 Excel 编辑） =====================

import { useEffect, useMemo, useRef, useState } from 'react'
import DateInput from './DateInput.jsx'
import dayjs from 'dayjs'
import { REPORT_TYPES, STANDARD_FIELDS, FIELD_BY_CODE, mapAlias, mapAliasRobust, matchDroppedCharVariant, reportTypeLabel, reportTypeKeyFields, reportTypeKeyFieldsMatched } from '../data/dictionary.js'
import { computeStatus, STATUS_META, auditPoint, reverseFieldMatch, summarizeAudit, detectSuspiciousValue, buildFixSuggestion } from '../utils/normalize.js'
import { parseScatteredText } from '../utils/pasteParse.js'
import { buildFeedback, EDITABLE_FIELDS } from '../utils/feedback.js'
import { matchCodeTerm } from '../utils/codeSearch.js'
import { useStore } from '../data/store.js'
import { pushOp, getOps } from '../utils/oplog.js'
import { learnAlias, getUserAliases, forgetAlias } from '../data/userAlias.js'
import { readTraceLocal } from '../utils/trace.js'

const ARROW_OPTIONS = [
  { value: '', label: '—' },
  { value: '↓', label: '↓ 偏低' },
  { value: '↑', label: '↑ 偏高' },
]

// 反馈编辑标记：用户修改过的字段显示蓝色下划线（区别于疑错红框/单位橙框等审计色），
// 提示该字段将作为反馈改进识别算法。模块级组件避免每次渲染重建导致输入框失焦。
function EditedMark({ edited, title = '已修改，将作为反馈改进识别算法', children }) {
  // 始终返回同一层包裹元素（span.block.w-full），避免编辑状态切换时
  // 结构从「裸 input」变成「span>input」导致 React 重建节点、输入框失焦
  return (
    <span className="relative block w-full">
      {children}
      {edited && (
        <span className="pointer-events-none absolute left-0 right-0 bottom-0 h-[2px] rounded-full bg-brand-500" title={title} />
      )}
    </span>
  )
}

function statusClass(status) {
  const color = STATUS_META[status]?.color
  if (color === 'red') return 'bg-red-50 text-red-700 ring-1 ring-red-200'
  if (color === 'amber') return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
  return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
}

function rowBg(status) {
  const color = STATUS_META[status]?.color
  if (color === 'red') return 'bg-red-50/60'
  if (color === 'amber') return 'bg-amber-50/50'
  return ''
}

// 各报告类型的标准字段分组（用于下拉选择）
function groupedFields(reportType) {
  const keySet = new Set(reportTypeKeyFields(reportType))
  const all = [...STANDARD_FIELDS]
  const keyed = all.filter((f) => keySet.has(f.code))
  const groups = []
  if (keyed.length) groups.push({ name: '★ 本报告重点字段', fields: keyed })
  for (const g of [...new Set(all.map((f) => f.group))]) {
    const fields = all.filter((f) => f.group === g && !keySet.has(f.code))
    if (fields.length) groups.push({ name: g, fields })
  }
  return groups
}

// 标准代码选择器：原生 <select> 选项过长、难核对，且「报告写 FBG、字典叫 FIB」这类同义缩写
// 用户无从得知。改为可搜索：按 代码 / 中文名 / 同义词缩写 / 本机已学缩写 / 拉丁缩写单字替换近似 匹配。
// 每行独立维护搜索态；下拉用 fixed 定位（避免被表格滚动容器裁剪）。
function CodeSelectCell({ value, reportType, onChange, userAliases = {} }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [rect, setRect] = useState(null)
  const boxRef = useRef(null)
  const inputRef = useRef(null)
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setOpen(false)
        setQ('')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // 本机学过的别名反向映射成 code -> [alias]，供搜索
  const learnedByCode = useMemo(() => {
    const m = {}
    for (const [a, c] of Object.entries(userAliases)) (m[c] = m[c] || []).push(a)
    return m
  }, [userAliases])

  const groups = useMemo(() => {
    const all = groupedFields(reportType)
    const term = q.trim()
    if (!term) return all
    // matchCodeTerm：代码 / 中文名 / 同义词缩写 / 本机已学缩写 / 拉丁缩写单字替换近似（FBG≈FIB）
    return all
      .map((g) => ({
        ...g,
        fields: g.fields.filter((f) => matchCodeTerm(f, term, learnedByCode)),
      }))
      .filter((g) => g.fields.length)
  }, [reportType, q, learnedByCode])

  const cur = value ? FIELD_BY_CODE[value] : null
  const hasResult = groups.some((g) => g.fields.length)

  const choose = (code) => {
    onChange(code)
    setOpen(false)
    setQ('')
  }
  const openBox = () => {
    setRect(btnRef.current ? btnRef.current.getBoundingClientRect() : null)
    setOpen(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  if (!open) {
    return (
      <div className="relative" ref={btnRef}>
        <button
          type="button"
          onClick={openBox}
          className={`g-ctl w-full rounded-md border px-1.5 py-1.5 text-left text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40 ${
            cur ? 'border-slate-300 bg-white' : 'border-dashed border-slate-300 text-slate-400'
          }`}
        >
          {cur ? (
            // 代码为准：单元格只放标准代码（窄列放得下），全名走 hover 提示
            <span className="font-mono truncate block" title={`${cur.code} · ${cur.name || ''}`}>
              {cur.code}
            </span>
          ) : (
            <span className="truncate" title="未识别：点此搜索选择标准代码">未识别</span>
          )}
        </button>
      </div>
    )
  }

  const DD_H = 256
  const below = rect && rect.bottom + DD_H <= window.innerHeight
  const ddStyle = rect
    ? { left: rect.left, top: below ? rect.bottom + 4 : rect.top - DD_H - 4 }
    : null

  return (
    <div className="relative" ref={boxRef}>
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && groups[0]?.fields[0]) choose(groups[0].fields[0].code)
          if (e.key === 'Escape') {
            setOpen(false)
            setQ('')
          }
        }}
        placeholder="搜索代码/中文名/缩写，如 FBG"
        className="w-full rounded-md border border-brand-400 px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40"
      />
      {rect && (
        <div
          className="fixed z-40 mt-1 max-h-64 w-56 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg"
          style={ddStyle}
        >
          <div
            role="option"
            onClick={() => choose('')}
            className="cursor-pointer px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-50"
          >
            未识别
          </div>
          {!hasResult && <div className="px-2 py-2 text-xs text-slate-400">无匹配项</div>}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="sticky top-0 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                {g.name}
              </div>
              {g.fields.map((f) => (
                <div
                  key={f.code}
                  role="option"
                  onClick={() => choose(f.code)}
                  className={`cursor-pointer px-2 py-1.5 text-xs hover:bg-brand-50 ${
                    f.code === value ? 'bg-brand-50 font-semibold text-brand-700' : ''
                  }`}
                >
                  <span className="flex items-baseline gap-2 min-w-0">
                    <span className="font-mono shrink-0">{f.code}</span>
                    <span className="truncate text-[11px] text-slate-400">{f.name}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DataGrid({
  croppedImage,
  autoDate = '',
  autoTime = '',
  autoReportedAt = '',
  date,
  time = '',
  reportedDate = '',
  reportedTime = '',
  onDateChange,
  onTimeChange,
  onReportedDateChange,
  onReportedTimeChange,
  reportType,
  onReportTypeChange,
  points,
  onPointsChange,
  reportText,
  onReportTextChange,
  traceId = '',
  baselinePoints = [],
  onSave,
  onReset,
}) {
  // 报告类型下拉：静态类型表 + Agent 自动发现的新类型（store.typeCatalog，由
  // reportCatalog.registerDiscoveredType 写入）+ 当前值兜底；「其他 / 未识别」永远垫底。
  // 需求（2026-10-22 用户）：识别出一份新报告类型时，类型可选框里要能看到并选中它，
  // 不能只把「当前值」偷偷塞一个 option 进去。
  const store = useStore()
  const typeOptions = useMemo(() => {
    const base = REPORT_TYPES.map((t) => ({ code: t.code, label: t.label }))
    const head = base.filter((t) => t.code !== 'UNKNOWN')
    const tail = base.filter((t) => t.code === 'UNKNOWN')
    const known = new Set([...head, ...tail].map((t) => t.code))
    const dyn = Object.values(store.typeCatalog || {})
      .filter((e) => e && e.code && !known.has(e.code))
      .map((e) => ({ code: e.code, label: e.label || e.code }))
      .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    const extra =
      reportType && ![...head, ...dyn, ...tail].some((t) => t.code === reportType)
        ? [{ code: reportType, label: reportTypeLabel(reportType) }]
        : []
    return [...head, ...dyn, ...extra, ...tail]
  }, [store.typeCatalog, reportType])

  // 复制文本到剪贴板（带短暂反馈）
  const copyText = (text, el) => {
    if (!text) return
    navigator.clipboard?.writeText(text).then(() => {
      if (el) {
        const orig = el.textContent
        el.textContent = '已复制 ✓'
        setTimeout(() => { el.textContent = orig }, 1200)
      }
    }).catch(() => {})
  }
  // 编辑网格滚动容器 ref：新增行后滚动到底部，方便直接校对/填写
  const gridScrollRef = useRef(null)
  const scrollGridToBottom = () => {
    requestAnimationFrame(() => {
      const el = gridScrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }
  const [zoom, setZoom] = useState(1)
  const [parseOpen, setParseOpen] = useState(false)
  const [parseText, setParseText] = useState('')
  const [parsedPoints, setParsedPoints] = useState(null) // 解析预览
  const [parseError, setParseError] = useState('')
  // 「结果」列排序：null=按默认（序号），'asc'=结果数值升序，'desc'=结果数值降序
  const [resultSort, setResultSort] = useState(null)
  // 「序号」列排序：null=默认（报告数字顺序），'asc'=序号升序，'desc'=序号降序
  const [seqSort, setSeqSort] = useState(null)
  // 「标准代码」列排序：null=默认，'asc'=代码升序，'desc'=代码降序
  const [codeSort, setCodeSort] = useState(null)
  // 「原始项目」列排序：null=默认，'asc'=名称升序，'desc'=名称降序
  const [nameSort, setNameSort] = useState(null)
  // 一键修正的反馈提示（临时显示修正条数）
  const [unitFixMsg, setUnitFixMsg] = useState('')
  // 识别基线（trace snapshot.points：识别后、编辑前的原始数据）。首次挂载固定，
  // 用于计算「用户相对识别结果改了哪些字段」的反馈 diff；重新识别会重挂载组件，ref 随之重建。
  const baselineRef = useRef(null)
  if (!baselineRef.current && Array.isArray(baselinePoints) && baselinePoints.length) {
    baselineRef.current = baselinePoints
  }
  const baseline = baselineRef.current || []

  // 操作记录第 1 条：网格打开时的初始状态（有几行、识别基线几行、报告类型）
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return // StrictMode 下 effect 会跑两次，操作记录只记一条
    openedRef.current = true
    pushOp('open-grid', { rows: points.length, baseline: baseline.length, reportType })
    // 仅挂载时记一次：后续变化由各操作埋点记录
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 已学缩写（本机动态别名，见 src/data/userAlias.js）：解析确认时自动学习，此处供展示与删除
  const [userAliases, setUserAliases] = useState(() => getUserAliases())
  const aliasList = Object.entries(userAliases || {})

  // 本次相对识别基线的修改统计（已修改 N 项 · 手动 M 项），随编辑实时重算
  const editStats = useMemo(() => {
    if (!baseline.length) return null
    return buildFeedback({ baselinePoints: baseline, currentPoints: points }).summary
  }, [points, baseline])
  // 待修正项数：已匹配标准字段且有可修正建议（单位/参考范围）的行数。
  // 数值永不建议修改（Bug 031：值越界≠识别错误，用户的值可能本来就是异常值）。
  const fixableCount = points.filter((p) => {
    if (!p.standard_code) return false
    const sug = buildFixSuggestion(p)
    return !!sug
  }).length

  // 提取结果数值（兼容 "12.1↓"、">100"、区间等），无法解析返回 null（排到最后）
  const extractValue = (p) => {
    const m = String(p.value || '').match(/-?\d+(\.\d+)?/)
    return m ? parseFloat(m[0]) : null
  }

  // 渲染顺序：未启用结果排序时，优先按报告数字顺序（_item_no 序号）升序展示，序号相同（或无序号）再按识别次序（_row）
  // 排序。手动添加的行无 _row 排在最后；同时保留原始数组索引供 update/remove 使用。
  const orderedPoints = useMemo(() => {
    return points
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        // 序号列排序开启时：按报告序号（_item_no）升/降序，无序号项排最后
        if (seqSort) {
          const na = a.p._item_no
          const nb = b.p._item_no
          if (na == null && nb == null) return a.i - b.i
          if (na == null) return 1
          if (nb == null) return -1
          return seqSort === 'asc' ? na - nb : nb - na
        }
        // 结果列排序开启时：按数值升/降序，数值缺失的项排最后
        if (resultSort) {
          const va = extractValue(a.p)
          const vb = extractValue(b.p)
          if (va == null && vb == null) return a.i - b.i
          if (va == null) return 1
          if (vb == null) return -1
          return resultSort === 'asc' ? va - vb : vb - va
        }
        // 标准代码列排序：按代码字符串升/降序，无代码项排最后
        if (codeSort) {
          const ca = a.p.standard_code || ''
          const cb = b.p.standard_code || ''
          if (!ca && !cb) return a.i - b.i
          if (!ca) return 1
          if (!cb) return -1
          return codeSort === 'asc' ? ca.localeCompare(cb, 'zh-Hans-CN') : cb.localeCompare(ca, 'zh-Hans-CN')
        }
        // 原始项目列排序：按名称字符串升/降序，无名项排最后
        if (nameSort) {
          const na = a.p.original_name || ''
          const nb = b.p.original_name || ''
          if (!na && !nb) return a.i - b.i
          if (!na) return 1
          if (!nb) return -1
          return nameSort === 'asc' ? na.localeCompare(nb, 'zh-Hans-CN') : nb.localeCompare(na, 'zh-Hans-CN')
        }
        // ① 优先按报告序号（_item_no）升序：让展示顺序贴合报告原序号（1、2、3…）
        const na = a.p._item_no
        const nb = b.p._item_no
        if (na != null && nb != null) {
          if (na !== nb) return na - nb
        } else if (na == null && nb != null) {
          return 1
        } else if (na != null && nb == null) {
          return -1
        }
        // ② 同序号（含都无序号）→ 按识别次序（_row）排序
        const ra = a.p._row
        const rb = b.p._row
        if (ra == null && rb == null) return a.i - b.i
        if (ra == null) return 1
        if (rb == null) return -1
        return ra - rb
      })
  }, [points, resultSort, seqSort, codeSort, nameSort])

  // 点击列头循环切换：默认 → 升序 → 降序 → 默认；四列排序互斥（开启一列清除其余）
  const clearSorts = (except) => {
    if (except !== 'seq') setSeqSort(null)
    if (except !== 'result') setResultSort(null)
    if (except !== 'code') setCodeSort(null)
    if (except !== 'name') setNameSort(null)
  }
  // 三步循环：默认 → 升序 → 降序 → 默认（同时记一条操作记录）
  const cycleSort = (cur, set) => {
    const n = cur === null ? 'asc' : cur === 'asc' ? 'desc' : null
    set(n)
    return n || 'default'
  }
  const toggleSeqSort = () => {
    clearSorts('seq')
    pushOp('sort', { column: 'seq', dir: cycleSort(seqSort, setSeqSort) })
  }
  const toggleResultSort = () => {
    clearSorts('result')
    pushOp('sort', { column: 'result', dir: cycleSort(resultSort, setResultSort) })
  }
  const toggleCodeSort = () => {
    clearSorts('code')
    pushOp('sort', { column: 'code', dir: cycleSort(codeSort, setCodeSort) })
  }
  const toggleNameSort = () => {
    clearSorts('name')
    pushOp('sort', { column: 'name', dir: cycleSort(nameSort, setNameSort) })
  }

  const updatePoint = (idx, patch) => {
    onPointsChange(
      points.map((p, i) => {
        if (i !== idx) return p
        const next = { ...p, ...patch }
        // 反馈来源标注：手动编辑 → manual（仅白名单字段；联动重算的 status/_audit 等不进反馈）
        for (const f of Object.keys(patch)) {
          if (EDITABLE_FIELDS.includes(f)) {
            next._editSrc = { ...(next._editSrc || {}), [f]: 'manual' }
          }
        }
        // 用户主动从下拉框选择标准代码 → 联动更新单位与参考范围（以标准档案为准），
        // 避免出现「选了百分比却保留绝对值单位/参考范围」的错配（如 EO_PCT 配 10^9/L、0.02-0.52）。
        // 选择「未识别」（空代码）时不动单位/参考范围，留给用户自行填写。
        if (patch.standard_code !== undefined) {
          const f = FIELD_BY_CODE[next.standard_code]
          if (f) {
            // 联动写入的 unit/ref 标 _editSrc='linked'：避免 buildFeedback 把它们
            // 缺省算成 manual 真值（如 TR-20260911-SBLXJ7 选 PA 后单位/参考被联动改写，
            // 实际不是用户手敲，不应计入 manual 编辑数）。patch 自带 unit/ref 时以用户为准。
            if (patch.unit === undefined) {
              next.unit = f.unit
              next._editSrc = { ...(next._editSrc || {}), unit: 'linked' }
            }
            if (patch.ref_range === undefined) {
              next.ref_range = f.ref
              next._editSrc = { ...(next._editSrc || {}), ref_range: 'linked' }
            }
            // 选择标准字段时，若原始项目名仍为空，回填标准名称便于阅读
            if (!next.original_name) next.original_name = f.name
          }
        }
        // 原始项目名变化时尝试自动匹配标准字段（精确别名 → 删字变体兜底 → 数值+参考范围反推）
        let autoReversed = false
        if (patch.original_name !== undefined && !next.standard_code) {
          let code = mapAlias(next.original_name)
          if (!code) {
            const v = matchDroppedCharVariant(next.original_name)
            if (v) code = v.code
          }
          // 名称落空时用「数值+参考范围」反推（如名称被读错/乱码）
          if (!code && next.value && String(next.value).trim() !== '' && next.ref_range) {
            const rev = reverseFieldMatch('', {
              value: next.value,
              ref_range: next.ref_range,
              unit: next.unit,
              original_name: next.original_name,
            })
            if (rev.codeReversed) {
              code = rev.code
              autoReversed = true
            }
          }
          if (code) {
            next.standard_code = code
            const f = FIELD_BY_CODE[code]
            if (!next.unit && f) {
              next.unit = f.unit
              next._editSrc = { ...(next._editSrc || {}), unit: 'linked' }
            }
            if (!next.ref_range && f) {
              next.ref_range = f.ref
              next._editSrc = { ...(next._editSrc || {}), ref_range: 'linked' }
            }
            if (autoReversed && f && next.original_name !== f.name) next.original_name = f.name
          }
        }
        next.status = computeStatus(next.standard_code, next.value, next.ref_range, next.arrow, next.unit)
        // 用户手动改过数值 → 该值视为权威（标记 _valueEdited），
        // 后续「一键修正」不再对数值提候选、也不再标数值疑似错位，
        // 避免把用户修正后的真实低/高值（如 PLT 24）重新覆盖成系统推断的范围内值（见 bugs.md Bug 031）。
        if (patch.value !== undefined) next._valueEdited = true
        // 编辑后重算多维审计：单位写法变体归一 / 单位内容不符 / 参考范围差异分档
        next._audit = auditPoint(next, {
          rawUnit: patch.unit !== undefined ? patch.unit : next.unit,
          codeReversed: autoReversed,
          codeReversedFrom: autoReversed ? '' : null,
        })
        // 编辑后重算疑似错位（数值与参考范围差异异常）：沿用识别/清洗阶段口径，
        // 已手动修正的项据此消除红色标记；用户已改过的数值视为权威，不再提小数点位移候选
        const suspect =
          next.standard_code && !next._valueEdited
            ? detectSuspiciousValue(next.standard_code, next.value, next.ref_range, next.unit)
            : { suspicious: false, candidates: [] }
        next._suspicious = suspect.suspicious
        next._fix = suspect.suspicious ? { reason: suspect.reason, candidates: suspect.candidates } : null
        // 操作记录：单元格编辑（同一行同一字段的连续输入会自动合并，见 oplog.js）
        const rowKey = p._row != null ? p._row : p.row != null ? p.row : idx
        for (const f of Object.keys(patch)) {
          if (EDITABLE_FIELDS.includes(f)) {
            pushOp('edit-field', {
              row: rowKey,
              code: next.standard_code || '',
              name: next.original_name || '',
              field: f,
              from: p[f] ?? '',
              to: next[f] ?? '',
            })
          }
        }
        // 动态别名学习：粘贴解析带进来的缩写（_abbr）在本行被指定代码后，记住「缩写 → 代码」
        if (patch.standard_code && next.standard_code && p._abbr) {
          const learned = learnAlias(p._abbr, next.standard_code)
          if (learned) {
            setUserAliases(getUserAliases())
            pushOp('learn-alias', { alias: learned.alias, code: learned.code, from: 'paste-code' })
          }
        }
        return next
      })
    )
  }

  // 下一个可智能补项：仅基于「当前数据实际命中组」补全缺失关键字段，
  // 避免 reportType 误判（含完全没出现的组）时补出无关项；无缺失字段时为 ''
  const nextSuggested = useMemo(() => {
    const keyFields = reportTypeKeyFieldsMatched(reportType, points.map((p) => p.standard_code))
    const existing = new Set(points.map((p) => p.standard_code))
    return keyFields.find((c) => !existing.has(c)) || ''
  }, [reportType, points])

  const addRow = () => {
    const suggested = nextSuggested
    if (!suggested) return
    const f = FIELD_BY_CODE[suggested]
    // 新增行的项目序号：取现有最大序号 +1，缺失则从 1 起
    const nextNo = (points.reduce((mx, p) => (p._item_no != null ? Math.max(mx, p._item_no) : mx), 0)) + 1
    onPointsChange([
      ...points,
      {
        standard_code: suggested,
        original_name: f ? f.name : '',
        value: '',
        unit: f ? f.unit : '',
        ref_range: f ? f.ref : '',
        arrow: '',
        status: 'NORMAL',
        _item_no: nextNo,
        _item_no_src: 'inferred', // 手动添加行：序号为推理生成（取最大序号+1），非报告识别
        _source: 'inferred', // 反馈来源：智能补项新增行（无识别基线）
      },
    ])
    pushOp('add-row', { code: suggested, name: f ? f.name : '' })
    scrollGridToBottom()
  }

  // 新增一行完全空白的行：标准代码/项目名/单位/参考均留空，由用户手动填写。
  // 用于避免「智能补项」自动补齐误补（如报告类型误判时补出无关项）的场景。
  const addBlankRow = () => {
    const nextNo = (points.reduce((mx, p) => (p._item_no != null ? Math.max(mx, p._item_no) : mx), 0)) + 1
    onPointsChange([
      ...points,
      {
        standard_code: '',
        original_name: '',
        value: '',
        unit: '',
        ref_range: '',
        arrow: '',
        status: 'NORMAL',
        _item_no: nextNo,
        _item_no_src: 'inferred',
        _source: 'inferred', // 反馈来源：手动新增空白行（无识别基线）
      },
    ])
    pushOp('add-blank-row', {})
    scrollGridToBottom()
  }

  // 一键修正：对已匹配标准字段的项，批量应用 buildFixSuggestion 给出的可修正维度——
  // 单位（含不同质如 CK mmol/L→U/L、Ca umol/L→mmol/L）、参考范围（与标准差异显著）。
  // 数值永不通过一键修正改写（Bug 031：值越界≠识别错误，用户的值可能本来就是异常值）。
  // 合法等效单位（如 Lp(a) nmol/L ≡ mg/L）会被建议跳过，不会误改。
  // 关键：修正可能级联暴露新问题（如改参考范围后数值越界又出新候选），故**迭代修正直至稳定**，
  // 一次点击即可消除全部待修正项（fixableCount 归零），而非每点只修一轮。
  // 返回修正条数，供按钮反馈。
  const applyFixes = () => {
    // 对单个点做一轮三维修正，返回 { patched, fixed }
    const applyOnce = (p) => {
      if (!p.standard_code) return { patched: p, fixed: false }
      const sug = buildFixSuggestion(p)
      if (!sug) return { patched: p, fixed: false }
      const patched = { ...p }
      const src = { ...(p._editSrc || {}) }
      let fixed = false
      if (sug.unit !== undefined && sug.unit !== p.unit) {
        patched.unit = sug.unit
        src.unit = 'autoFix'
        fixed = true
      }
      if (sug.ref !== undefined && sug.ref !== p.ref_range) {
        patched.ref_range = sug.ref
        src.ref_range = 'autoFix'
        fixed = true
      }
      // 数值维度：buildFixSuggestion 已不产出 value 建议（Bug 031），此处不做覆盖
      if (!fixed) return { patched: p, fixed: false }
      patched._editSrc = src
      // 修正后重算状态/审计/疑似错位，红标随修正消除（也作为下一轮修正的输入）
      const suspect = patched.standard_code
        ? detectSuspiciousValue(patched.standard_code, patched.value, patched.ref_range, patched.unit)
        : { suspicious: false, candidates: [] }
      return {
        patched: {
          ...patched,
          status: computeStatus(patched.standard_code, patched.value, patched.ref_range, patched.arrow, patched.unit),
          _audit: auditPoint(patched, { rawUnit: patched.unit }),
          _suspicious: suspect.suspicious,
          _fix: suspect.suspicious ? { reason: suspect.reason, candidates: suspect.candidates } : null,
        },
        fixed: true,
      }
    }
    let fixedCount = 0
    const next = points.map((p) => {
      let cur = p
      // 每点最多迭代 6 轮，防止极端级联死循环
      for (let i = 0; i < 6; i++) {
        const { patched, fixed } = applyOnce(cur)
        if (!fixed) break
        fixedCount++
        cur = patched
      }
      return cur
    })
    onPointsChange(next)
    return fixedCount
  }

  const removeRow = (idx) => {
    const p = points[idx]
    if (p) {
      pushOp('remove-row', {
        row: p._row != null ? p._row : p.row != null ? p.row : idx,
        code: p.standard_code || '',
        name: p.original_name || '',
        value: p.value || '',
      })
    }
    onPointsChange(points.filter((_, i) => i !== idx))
  }

  // 粘贴解析：把散乱的字段文本解析成数据点预览
  const handleParse = () => {
    if (!parseText.trim()) return
    setParseError('')
    try {
      const pts = parseScatteredText(parseText)
      if (!pts.length) {
        setParseError('未解析出有效字段，请确认文本包含项目名/缩写/数值')
      }
      // 操作记录：把「用户粘了什么、解析成什么」记下来（缩写是否被认出来是判断别名缺失的直接证据）
      pushOp('parse-run', {
        chars: parseText.trim().length,
        // 记一小段原始粘贴文本（截断），便于事后还原「用户当时粘了什么」——
        // 否则仅有 chars 长度无法判断粘贴意图（如 TR-20260911-SBLXJ7 粘 11 字符只解出 0.7）。
        text: parseText.trim().slice(0, 80),
        items: pts.map((p) => ({
          abbr: p.abbr || '',
          name: p.original_name || '',
          code: p.standard_code || '',
          value: p.value || '',
          unit: p.unit || '',
          ref: p.ref_range || '',
        })),
      })
      setParsedPoints(pts)
    } catch (e) {
      setParseError('解析失败：' + e.message)
      setParsedPoints(null)
    }
  }

  // 确认：把解析结果追加到网格（并排到最前，便于校对）
  const confirmParsed = () => {
    if (!parsedPoints?.length) return
    const learned = []
    const added = parsedPoints.map((p, i) => {
      // 动态别名：解析出的缩写 + 本行确定的代码 → 记入本机别名表，下次（含 OCR 识别）直接命中
      if (p.abbr && p.standard_code) {
        const l = learnAlias(p.abbr, p.standard_code)
        if (l) learned.push(l)
      }
      return {
        standard_code: p.standard_code || '',
        original_name: p.original_name || p.abbr || '',
        value: p.value || '',
        unit: p.unit || '',
        ref_range: p.ref_range || '',
        arrow: p.arrow || '',
        status: p.status || 'NORMAL',
        _abbr: p.abbr || '', // 用户写的缩写（仅学习/反馈用，入库前由 ImportFlow 剥离）
        _row: -100 - i, // 排最前
        _source: 'paste', // 反馈来源：粘贴解析新增行（无识别基线）
      }
    })
    if (learned.length) setUserAliases(getUserAliases())
    pushOp('parse-confirm', { items: added.length, learned: learned.map((l) => `${l.alias}→${l.code}`) })
    onPointsChange([...added, ...points])
    setParseText('')
    setParsedPoints(null)
    setParseOpen(false)
    scrollGridToBottom()
  }

  const reMatchAll = () => {
    pushOp('rematch-all', { rows: points.length })
    onPointsChange(
      points.map((p) => {
        // 稳妥匹配（别名 + 删字变体，见 dictionary.mapAliasRobust）→ 保留原代码 → 数值+参考范围反推
        // 不用裸 mapAlias：它会把「大血小板比率」这类变体降级成泛化项目（PLT）
        let code = mapAliasRobust(p.original_name).code
        if (!code) code = p.standard_code
        let reverseFrom = ''
        let reverseHint = null
        if (p.value && String(p.value).trim() !== '' && p.ref_range) {
          const rev = reverseFieldMatch(code, {
            value: p.value,
            ref_range: p.ref_range,
            unit: p.unit,
            original_name: p.original_name,
          })
          if (rev.codeReversed) {
            reverseFrom = rev.reverseFrom || code
            code = rev.code
          } else if (rev.hint) {
            reverseHint = rev.hint
          }
        }
        const f = FIELD_BY_CODE[code]
        const next = { ...p, standard_code: code }
        if (f) {
          if (!next.unit) next.unit = f.unit
          if (!next.ref_range) next.ref_range = f.ref
          // 反推修正时回填标准名称（原名称识别错误）
          if (reverseFrom && next.original_name !== f.name) next.original_name = f.name
        }
        // 反馈来源标注：重新匹配实际改动的字段 → reMatch（仅相对原值变化的字段）
        const src = { ...(p._editSrc || {}) }
        for (const fld of ['standard_code', 'unit', 'ref_range', 'original_name']) {
          if (String(p[fld] ?? '') !== String(next[fld] ?? '')) src[fld] = 'reMatch'
        }
        if (Object.keys(src).length) next._editSrc = src
        next.status = computeStatus(next.standard_code, next.value, next.ref_range, next.arrow, next.unit)
        next._audit = auditPoint(next, {
          nameFixed: !!reverseFrom,
          codeReversed: !!reverseFrom,
          codeReversedFrom: reverseFrom || null,
          reverseHint,
        })
        return next
      })
    )
  }

  const criticalCount = points.filter((p) => (p.status || '').startsWith('CRITICAL')).length
  const abnormalCount = points.filter((p) => p.status === 'LOW' || p.status === 'HIGH').length

  // 多维识别校验摘要：以标准档案（代码↔名称/单位/参考范围）核对识别结果，
  // 随网格编辑重算，无任何修正/提示/疑错时隐藏
  const auditSum = summarizeAudit(points)
  const seqWarn = {
    missing: auditSum.seq?.missingNos?.length > 0,
    low: !!(auditSum.seq?.hasSeq && auditSum.seq.detectedRatio < 0.6 && auditSum.seq.total > 5),
  }
  const auditActive =
    auditSum.codeReversed +
      auditSum.nameFixed +
      auditSum.unitFixed +
      auditSum.unitMismatch +
      auditSum.refNear +
      auditSum.refMismatch +
      auditSum.suspicious +
      (seqWarn.missing ? 1 : 0) +
      (seqWarn.low ? 1 : 0) >
    0

  return (
    <div className="g-grid space-y-4">
      {/* 记录信息栏 */}
      <div className="card p-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label flex items-center gap-2">
            采集日期 · 时间
            {(autoDate || autoTime) && (
              <span className="text-[10px] font-normal text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                已自动识别
              </span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-2">
            <DateInput
              className="w-full"
              value={date ? dayjs(date) : null}
              onChange={(d) => {
                const v = d ? d.format('YYYY-MM-DD') : ''
                pushOp('set-date', { from: date, to: v })
                onDateChange(v)
              }}
              placeholder="选择日期"
              allowClear clearIcon={<span title="清除日期">×</span>}
            />
            <input
              type="time"
              className="input"
              value={time}
              title="精确到分钟（可选）"
              onChange={(e) => onTimeChange(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="label flex items-center gap-2">
            报告日期（可选）
            {autoReportedAt && (
              <span className="text-[10px] font-normal text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                已自动识别
              </span>
            )}
          </label>
          {/* 检验报告可能隔天出报告：报告日 ≠ 采集日时单独填，不能只选时间。
              留空则沿用采集日期（老记录与同日出具的报告行为不变）。 */}
          <input
            type="date"
            className="input"
            value={reportedDate}
            title="报告出具日期，可跨日；留空＝与采集日期相同"
            onChange={(e) => onReportedDateChange(e.target.value)}
          />
        </div>
        <div>
          <label className="label">报告时间（可选）</label>
          <input
            type="time"
            className="input"
            value={reportedTime}
            title="精确到分钟（可选）"
            onChange={(e) => onReportedTimeChange(e.target.value)}
          />
        </div>
        <div className="lg:col-span-2">
          <label className="label">报告类型（自动识别，可手动调整）</label>
          <select className="input" value={reportType} onChange={(e) => {
            pushOp('set-report-type', { from: reportType, to: e.target.value })
            onReportTypeChange(e.target.value)
          }}>
            {typeOptions.map((t) => (
              <option key={t.code} value={t.code}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button className="btn-secondary w-full" onClick={reMatchAll}>↻ 重新匹配标准字段</button>
        </div>
        {reportText ? (
          <div className="md:col-span-2 lg:col-span-4">
            <label className="label">报告原文（机器转录，可编辑；不含患者信息）</label>
            {/* 可编辑：识别错字、漏字由用户直接改（2026-10-28 用户要求「为什么不可编辑」）。
                改动会打 report_text_edited 标记，重新识别/换引擎不再覆盖人工修改。 */}
            <textarea
              className="input"
              rows={6}
              value={reportText}
              onChange={(e) => onReportTextChange && onReportTextChange(e.target.value)}
            />
          </div>
        ) : null}
      </div>

      {/* 双栏对比：左图右表 */}
      <div className="grid gap-4 lg:grid-cols-5">
        {/* 左：原图 */}
        <div className="card p-3 lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-slate-700">脱敏原图（放大对照）</h3>
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <button className="btn-ghost px-2 py-0.5" onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))}>−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button className="btn-ghost px-2 py-0.5" onClick={() => setZoom((z) => Math.min(3, z + 0.2))}>＋</button>
            </div>
          </div>
          <div className="card bg-slate-50 overflow-auto" style={{ maxHeight: 420 }}>
            {croppedImage ? (
              <img src={croppedImage} alt="脱敏化验单" className="max-w-none mx-auto" style={{ width: `${zoom * 100}%` }} />
            ) : (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">暂无裁剪图</div>
            )}
          </div>
        </div>

        {/* 右：编辑网格 */}
        <div className="card p-3 lg:col-span-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-slate-700">
              校对网格
              <span className="ml-2 text-xs font-normal text-slate-400">共 {points.length} 项</span>
              {editStats && (editStats.total > 0 || editStats.removed > 0) && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-[11px] font-normal text-brand-700 bg-brand-50 border border-brand-200 rounded-full px-2 py-0.5"
                  title="相对识别结果你修改过的字段，保存后将自动作为反馈改进识别算法；未修改字段不作为反馈"
                >
                  已修改 {editStats.total} 项{editStats.removed > 0 ? ` · 删 ${editStats.removed} 行` : ''}（手动 {editStats.manual}）
                </span>
              )}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                className="btn-primary text-xs px-2 py-1"
                title={
                  nextSuggested
                    ? `智能补项：按报告类型自动补全一个尚未录入的重点字段（算法推断，可能误补，请核对）`
                    : '当前报告类型的重点字段已全部录入，无可补项'
                }
                onClick={addRow}
                disabled={!nextSuggested}
              >智能补项</button>
              <button
                className="btn-secondary text-xs px-2 py-1"
                title="空白行：新增一行完全空白的记录，由你手动填写，不会自动带出任何内容"
                onClick={addBlankRow}
              >+空白行</button>
              <button
                className="btn-secondary text-xs px-2 py-1"
                title="一键修正：批量应用已匹配标准字段项的可修正维度（单位、参考范围）。数值永不自动改写——值越界（异常）不等于识别错误。等效单位（如 Lp(a) nmol/L）不会误改。无待修正项时禁用。"
                disabled={!fixableCount}
                onClick={() => {
                  const n = applyFixes()
                  pushOp('fix-all', { n, fixable: fixableCount })
                  setUnitFixMsg(n > 0 ? `已修正 ${n} 项` : '无可修正项')
                  setTimeout(() => setUnitFixMsg(''), 2000)
                }}
              >一键修正</button>
              {fixableCount > 0 && (
                <span className="text-brand-700 font-medium">{fixableCount} 项待修正</span>
              )}
              {unitFixMsg && <span className="text-slate-500">{unitFixMsg}</span>}
              <button
                className="btn-secondary text-xs px-2 py-1"
                title={
                  baseline.length
                    ? '复制反馈：合并「你的修改字段 diff + 原始 OCR 文本网格 rawGrid + 识别诊断 ocrLoop」，发给 AI 即可一站式改进识别算法，无需再单独复制识别日志。'
                    : '本报告无识别基线（如手动录入），无可复制反馈'
                }
                onClick={(e) => {
                  const fb = buildFeedback({ baselinePoints: baseline, currentPoints: points, traceId, reportType, date, ops: getOps() })
                  pushOp('copy-feedback', { edits: fb.edits.length, added: fb.addedRows.length, removed: fb.removedRows.length })
                  const trace = traceId ? readTraceLocal(traceId) : null
                  copyText(JSON.stringify({
                    feedback: fb,
                    rawGrid: trace?.rawGrid || null,
                    ocrLoop: trace?.ocrLoop || null,
                    recognizedAt: trace?.recognizedAt || null,
                    durationMs: trace?.durationMs || null,
                    collectedAt: trace?.collectedAt || null,
                    reportedAt: trace?.reportedAt || null,
                  }), e.currentTarget)
                }}
                disabled={!baseline.length || !traceId}
              >复制反馈</button>
              <button
                className={`btn-secondary text-xs px-2 py-1 ${parseOpen ? 'ring-2 ring-brand-500/60' : ''}`}
                onClick={() => {
                  pushOp('parse-panel', { open: !parseOpen })
                  setParseOpen(!parseOpen)
                }}
              >
                📋 解析输入
              </button>
            </div>
          </div>

          {/* 状态 tag 行：危急值/偏离值（浅底胶囊）与识别校验摘要（方形描边/实心）形态差异化，同一行排列 */}
          {(criticalCount > 0 || abnormalCount > 0 || auditActive) && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3 text-xs">
            {criticalCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                {criticalCount} 项危急值
              </span>
            )}
            {abnormalCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                {abnormalCount} 项偏离值
              </span>
            )}
            {auditActive && (
              <>
                {auditSum.codeReversed + auditSum.nameFixed + auditSum.unitFixed > 0 && (
                  <span className="rounded border border-slate-300 bg-slate-50 text-slate-600 font-medium px-2 py-0.5">
                    已修正 {auditSum.codeReversed + auditSum.nameFixed + auditSum.unitFixed} 项
                  </span>
                )}
                {auditSum.unitMismatch + auditSum.refNear + auditSum.refMismatch > 0 && (
                  <span className="rounded border border-amber-300 bg-amber-50 text-amber-700 font-medium px-2 py-0.5">
                    提示 {auditSum.unitMismatch + auditSum.refNear + auditSum.refMismatch} 项
                  </span>
                )}
                {seqWarn.low && (
                  <span className="rounded border border-amber-300 bg-amber-50 text-amber-700 font-medium px-2 py-0.5">
                    序号置信度低（{Math.round(auditSum.seq.detectedRatio * 100)}%）
                  </span>
                )}
                {auditSum.suspicious + (seqWarn.missing ? 1 : 0) > 0 && (
                  <span className="rounded bg-red-600 text-white font-semibold px-2 py-0.5">
                    疑错 {auditSum.suspicious} 项{seqWarn.missing ? '· 漏项' : ''}
                  </span>
                )}
              </>
            )}
          </div>
          )}

          {/* 解析输入面板：粘贴散乱字段文本，自动解析为数据点 */}
          {parseOpen && (
            <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50/50 p-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-brand-800">📋 粘贴解析</h4>
                <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setParseOpen(false)}>收起 ✕</button>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed mb-2">
                把一个项目的字段粘贴进来（可散乱分布在多行/单行），系统自动识别 <b>项目名 / 缩写 / 结果 / 单位 / 参考范围 / 箭头</b>。
                多个项目用<b>空行</b>分隔；解析出的<b>缩写会自动记住</b>（下次同缩写直接命中标准代码，可在下方删除）。例：
                <span className="font-mono">NEUT% / 12.1↓ % / 40-75 / 2 中性细胞比率</span>
              </p>
              <textarea
                className="input w-full font-mono text-xs h-28"
                placeholder={'NEUT%\n12.1↓ %\n40-75\n2 中性细胞比率'}
                value={parseText}
                onChange={(e) => setParseText(e.target.value)}
              />
              <div className="flex items-center gap-2 mt-2">
                <button className="btn-primary text-xs" onClick={handleParse}>⟳ 解析</button>
                {parseError && <span className="text-xs text-red-600">{parseError}</span>}
              </div>

              {/* 已学缩写：解析里出现过的「缩写 → 代码」自动记在本机，下次（含 OCR 识别）直接命中；学错可删 */}
              {aliasList.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-slate-500">已学缩写（下次自动识别）：</span>
                  {aliasList.map(([a, c]) => (
                    <span
                      key={a}
                      className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-white px-2 py-0.5 font-mono text-brand-700"
                    >
                      {a}→{c}
                      <button
                        className="text-slate-400 hover:text-red-600"
                        title={`删除已学缩写 ${a}→${c}`}
                        onClick={() => {
                          forgetAlias(a)
                          setUserAliases(getUserAliases())
                          pushOp('forget-alias', { alias: a, code: c })
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {parsedPoints && parsedPoints.length > 0 && (
                <div className="mt-3">
                  <div className="text-xs font-medium text-slate-600 mb-1.5">解析预览（{parsedPoints.length} 项）</div>
                  <div className="card overflow-x-auto">
                    <table className="w-full text-xs border-collapse min-w-[520px]">
                      <thead>
                        <tr className="text-left text-[11px] text-slate-400 border-b border-slate-200 bg-slate-50">
                          <th className="py-1.5 px-2 font-medium">代码</th>
                          <th className="py-1.5 px-2 font-medium">项目名</th>
                          <th className="py-1.5 px-2 font-medium">缩写</th>
                          <th className="py-1.5 px-2 font-medium">结果</th>
                          <th className="py-1.5 px-2 font-medium">单位</th>
                          <th className="py-1.5 px-2 font-medium">参考范围</th>
                          <th className="py-1.5 px-2 font-medium">状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsedPoints.map((p, i) => (
                          <tr key={i} className="border-b border-slate-100">
                            <td className="py-1.5 px-2 font-mono">{p.standard_code || '—'}</td>
                            <td className="py-1.5 px-2">{p.original_name || p.abbr || '—'}</td>
                            <td className="py-1.5 px-2 font-mono">{p.abbr || '—'}</td>
                            <td className="py-1.5 px-2 font-mono">{p.value || '—'}{p.arrow}</td>
                            <td className="py-1.5 px-2">{p.unit || '—'}</td>
                            <td className="py-1.5 px-2 font-mono">{p.ref_range || '—'}</td>
                            <td className="py-1.5 px-2">
                              <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[11px] font-medium ${statusClass(p.status)}`}>
                                {STATUS_META[p.status]?.symbol || STATUS_META[p.status]?.label || '—'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <button className="btn-primary text-xs" onClick={confirmParsed}>
                      ✓ 加入网格（{parsedPoints.length} 项）
                    </button>
                    <span className="text-[11px] text-slate-400">加入后可在网格中继续编辑</span>
                  </div>
                </div>
              )}
            </div>
          )}

          <div ref={gridScrollRef} className="overflow-x-auto" style={{ maxHeight: 'clamp(320px, calc(100vh - 320px), 560px)' }}>
            <table className="g-main w-full text-sm border-collapse min-w-[760px]">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-2 font-medium w-[68px]">
                    <button
                      className="inline-flex items-center gap-1 select-none hover:text-brand-700"
                      title={
                        seqSort === 'asc'
                          ? '当前按序号升序排列，点击切换为降序'
                          : seqSort === 'desc'
                            ? '当前按序号降序排列，点击恢复默认顺序'
                            : '项目序号：绿点=报告自带（确定）；灰点斜体=自动按序填充（推理）。点击按序号排序'
                      }
                      onClick={toggleSeqSort}
                    >
                      序号
                      <span className="text-[10px] leading-none w-3 text-center">
                        {seqSort === 'asc' ? '↑' : seqSort === 'desc' ? '↓' : ''}
                      </span>
                    </button>
                  </th>
                  <th className="py-2 pr-2 font-medium w-24">
                    <button
                      className="inline-flex items-center gap-1 select-none hover:text-brand-700"
                      title={
                        codeSort === 'asc'
                          ? '当前按代码升序排列，点击切换为降序'
                          : codeSort === 'desc'
                            ? '当前按代码降序排列，点击恢复默认顺序'
                            : '按标准代码排序（升序），点击快速定位对应记录'
                      }
                      onClick={toggleCodeSort}
                    >
                      标准代码
                      <span className="text-[10px] leading-none w-3 text-center">
                        {codeSort === 'asc' ? '↑' : codeSort === 'desc' ? '↓' : ''}
                      </span>
                    </button>
                  </th>
                  <th className="py-2 pr-2 font-medium">
                    <button
                      className="inline-flex items-center gap-1 select-none hover:text-brand-700"
                      title={
                        nameSort === 'asc'
                          ? '当前按名称升序排列，点击切换为降序'
                          : nameSort === 'desc'
                            ? '当前按名称降序排列，点击恢复默认顺序'
                            : '按原始项目名称排序（升序），点击快速定位对应记录'
                      }
                      onClick={toggleNameSort}
                    >
                      原始项目
                      <span className="text-[10px] leading-none w-3 text-center">
                        {nameSort === 'asc' ? '↑' : nameSort === 'desc' ? '↓' : ''}
                      </span>
                    </button>
                  </th>
                  <th className="py-2 pr-2 font-medium w-20">
                    <button
                      className="inline-flex items-center gap-1 select-none hover:text-brand-700"
                      title={
                        resultSort === 'asc'
                          ? '当前按结果数值升序排列，点击切换为降序'
                          : resultSort === 'desc'
                            ? '当前按结果数值降序排列，点击恢复默认序号排序'
                            : '按结果数值排序（升序），点击快速定位对应记录'
                      }
                      onClick={toggleResultSort}
                    >
                      结果
                      <span className="text-[10px] leading-none w-3 text-center">
                        {resultSort === 'asc' ? '↑' : resultSort === 'desc' ? '↓' : ''}
                      </span>
                    </button>
                  </th>
                  <th className="py-2 pr-2 font-medium w-24">单位</th>
                  <th className="py-2 pr-2 font-medium w-28">参考范围</th>
                  <th className="py-2 pr-2 font-medium w-16">箭头</th>
                  <th className="py-2 font-medium w-16">操作</th>
                </tr>
              </thead>
              <tbody>
                {points.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-slate-400">
                      暂无数据，请先执行 OCR 识别，或点击「添加行」手动录入
                    </td>
                  </tr>
                )}
                {orderedPoints.map(({ p, i }) => {
                  const uAudit = p._audit?.unit
                  const rAudit = p._audit?.ref
                  // 标准代码已选、但原始项目名非空且与标准名不一致 → 显示可点击的替换提示，
                  // 由用户决定是否把名称改成标准名（保留 OCR 原文作对照锚点，不自动覆盖）
                  const nameField = FIELD_BY_CODE[p.standard_code]
                  const nameMismatch = nameField && p.original_name && p.original_name.trim() && p.original_name !== nameField.name
                  return (
                  <tr key={i} className={`group border-b border-slate-100 ${rowBg(p.status)}`}>
                    <td className="py-1.5 pr-2 text-center">
                      <span className="inline-flex items-center justify-center gap-1">
                        {/* 序号来源指示点：绿点=报告自带（确定）；灰点=自动按序填充（推理）；蓝点=手动编辑 */}
                        {p._item_no_src === 'detected' && (
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        )}
                        {p._item_no_src === 'inferred' && (
                          <span className="h-1 w-1 rounded-full border border-slate-300" />
                        )}
                        {p._item_no_src === 'manual' && (
                          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                        )}
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={p._item_no ?? ''}
                          placeholder="—"
                          onChange={(e) => {
                            const raw = e.target.value
                            const n = raw === '' ? null : parseInt(raw, 10)
                            // 非法输入（如 NaN）直接忽略，保持原值
                            if (raw !== '' && (isNaN(n) || n < 1)) return
                            updatePoint(i, { _item_no: n, _item_no_src: 'manual' })
                          }}
                          title={
                            p._item_no_src === 'detected'
                              ? `序号 ${p._item_no}：报告自带，成功识别（确定）。点击可修改`
                              : p._item_no_src === 'manual'
                                ? `序号 ${p._item_no}：手动编辑。点击可修改`
                                : `序号 ${p._item_no ?? '—'}：报告未带，自动按序填充（推理）。点击可修改`
                          }
                          className={`g-bare w-10 bg-transparent text-center font-mono text-xs outline-none focus:ring-1 focus:ring-brand-400 focus:rounded-sm ${
                            p._item_no_src === 'detected'
                              ? 'font-semibold text-slate-700'
                              : p._item_no_src === 'manual'
                                ? 'font-semibold text-slate-700'
                                : 'italic text-slate-300'
                          }`}
                        />
                      </span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <EditedMark edited={!!p._editSrc?.standard_code}>
                        <CodeSelectCell
                          value={p.standard_code}
                          reportType={reportType}
                          userAliases={userAliases}
                          onChange={(code) => updatePoint(i, { standard_code: code })}
                        />
                      </EditedMark>
                    </td>
                    <td className="py-1.5 pr-2">
                      <EditedMark edited={!!p._editSrc?.original_name}>
                        <div className="relative min-w-[150px]">
                          <input
                            className={`g-ctl w-full rounded-md border px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40 ${
                              p._audit?.codeReversed ? 'border-teal-400 bg-teal-50/40' : 'border-slate-300'
                            } ${nameMismatch ? 'pr-8' : ''}`}
                            value={p.original_name}
                            placeholder="如：血小板计数"
                            title={
                              p._audit?.codeReversed
                                ? `🛠 ${p._audit.codeReversedFrom ? `原识别为「${FIELD_BY_CODE[p._audit.codeReversedFrom]?.name || p._audit.codeReversedFrom}」，` : ''}已按数值+参考范围反推修正为「${FIELD_BY_CODE[p.standard_code]?.name || p.standard_code}」`
                                : ''
                            }
                            onChange={(e) => updatePoint(i, { original_name: e.target.value })}
                          />
                          {nameMismatch && (
                            <button
                              type="button"
                              className="g-bare absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded bg-brand-100 text-[11px] leading-none text-brand-700 hover:bg-brand-200"
                              title={`当前名称与所选代码「${p.standard_code}」的标准名不一致；点击替换为「${nameField.name}」`}
                              onClick={() => updatePoint(i, { original_name: nameField.name })}
                            >
                              ↺
                            </button>
                          )}
                        </div>
                      </EditedMark>
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="relative flex items-center gap-1.5">
                        <EditedMark edited={!!p._editSrc?.value}>
                          <input
                            className={`g-ctl w-full rounded-md border px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500/40 ${
                              p._suspicious ? 'border-red-300 bg-red-50/40' : 'border-slate-300'
                            }`}
                            value={p.value}
                            title={p._suspicious ? `🚨 疑似错位：${p._fix?.reason || '数值与参考范围差异异常'}` : ''}
                            onChange={(e) => updatePoint(i, { value: e.target.value })}
                          />
                        </EditedMark>
                        {p._suspicious && (
                          <span
                            className="hidden absolute -right-1 top-1/2 -translate-y-1/2 items-center justify-center h-4 w-4 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none cursor-help group-hover:flex"
                            title={`🚨 疑似错位\n${p._fix?.reason || ''}\n${
                              p._fix?.candidates?.length
                                ? `修正候选：${p._fix.candidates.map((c) => `${c.factor} → ${c.fixed}`).join('、')}`
                                : '无可自动修正候选，请人工核对'
                            }`}
                          >
                            !
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-1.5 pr-2">
                      <EditedMark edited={!!p._editSrc?.unit}>
                        <input
                          className={`g-ctl w-full rounded-md border px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40 ${
                            uAudit === 'mismatch' ? 'border-orange-400 bg-orange-50/40' : 'border-slate-300'
                          }`}
                          value={p.unit}
                          title={uAudit === 'mismatch' ? `⚠️ ${p._audit.unitHint}` : ''}
                          onChange={(e) => updatePoint(i, { unit: e.target.value })}
                        />
                      </EditedMark>
                    </td>
                    <td className="py-1.5 pr-2">
                      <EditedMark edited={!!p._editSrc?.ref_range}>
                        <input
                          className={`g-ctl w-full rounded-md border px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500/40 ${
                            rAudit === 'mismatch'
                              ? 'border-orange-400 bg-orange-50/40'
                              : rAudit === 'near'
                                ? 'border-amber-300 bg-amber-50/40'
                                : 'border-slate-300'
                          }`}
                          value={p.ref_range}
                          placeholder="125-350"
                          title={rAudit ? `⚠️ ${p._audit.refHint}` : ''}
                          onChange={(e) => updatePoint(i, { ref_range: e.target.value })}
                        />
                      </EditedMark>
                    </td>
                    <td className="py-1.5 pr-2">
                      <EditedMark edited={!!p._editSrc?.arrow}>
                        <select
                          className="g-ctl w-full rounded-md border border-slate-300 px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                          value={p.arrow}
                          onChange={(e) => updatePoint(i, { arrow: e.target.value })}
                        >
                          {ARROW_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </EditedMark>
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <button
                        className="text-slate-400 hover:text-red-600 text-sm"
                        title="删除此行"
                        onClick={() => removeRow(i)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 保存 */}
      <div className="flex items-center justify-end gap-3">
        <p className="text-xs text-slate-400 mr-auto">
          状态自动按「参考范围 + 箭头 + 危急值规则」计算
        </p>
        <button className="btn-secondary" onClick={onReset}>清空本次</button>
        <button
          className="btn-primary"
          disabled={!date || points.filter((p) => p.value !== '').length === 0}
          onClick={onSave}
        >
          保存到本地数据库 →
        </button>
      </div>
    </div>
  )
}
