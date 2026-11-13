// ===================== 病历文书归档导入（出院记录 / 诊断证明等） =====================
// 上传 PDF / 图片 → 提取全文 → 自动解析并抽取结构化字段（出院日期 / 出院诊断 / 出院医嘱…）
// → 按子类型渲染专属字段模板 → 人工核对 → 保存：原件进 IndexedDB，索引（含字段）进 IndexedDB。

import { useEffect, useRef, useState } from 'react'
import DateInput from './DateInput.jsx'
import { Select, Input, Button, Alert, Modal } from 'antd'
import dayjs from 'dayjs'
import { extractDocContent, parseDocText, cleanReportText } from '../utils/parseDoc.js'

import BackButton from './BackButton.jsx'
import MedImportList from './MedImportList.jsx'
import { saveDocFile, saveDocText } from '../utils/docFileStore.js'
import { addDoc, findDuplicateDoc, getState, addEvent, updateEvent } from '../data/store.js'
import { buildMedEvent } from '../utils/medCourses.js'
import { diffMedList, extractMedInstructions, planMedWrites, refreshRow } from '../utils/medExtract.js'
import { docFileToText, reRecognizeDocWithParsed } from '../utils/reRecognize.js'
import ReRecognizeDocModal from './ReRecognizeDocModal.jsx'
import { ocrImageToText, ocrScannedPdfToText } from '../utils/ocr.js'
import { mergeAiIntoCaseDraft, docReadModeFor, aiMetaFrom } from '../utils/docAi.js'
import { postDocRead } from '../utils/classify.js'
import { upsertTask, patchTask, pollAiTask, postTaskReview, fetchTaskBundle, fetchTaskImage, deleteTaskRemote, DELETE_TASK_ERR } from '../utils/docTasks.js'
import { docImageForAi } from '../utils/docImage.js'
import { shortId, fmtStamp } from '../utils/taskMeta.js'
import CloudConsentModal, { hasCloudConsent } from './CloudConsentModal.jsx'
import { peekFiles, getFileName, getPendingText, takePendingAi, setSelfPendingFiles, getLastSelfToken, ensurePendingSlot } from '../utils/pendingImport.js'
import { detectReportKind } from '../utils/reportKind.js'
import { postOcrReview } from '../utils/review.js'
import { fileFingerprint } from '../utils/fileHash.js'
import { resolveDraftSha } from '../utils/docDraftSha.js'

// File → dataURL（OCR 接口用）
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
}

const KIND_LABELS = {
  discharge: '出院记录',
  cert: '诊断证明',
  other: '其他文书',
}
const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))

// 各子类型的结构化字段模板（标签 / 控件类型）
const FIELD_SCHEMA = {
  discharge: [
    { key: 'discharge_date', label: '出院日期', type: 'date' },
    { key: 'admission_date', label: '入院日期', type: 'date' },
    { key: 'hospital_days', label: '住院天数', type: 'number', placeholder: '如 14' },
    { key: 'discharge_diagnosis', label: '出院诊断', type: 'textarea' },
    { key: 'discharge_advice', label: '出院医嘱', type: 'textarea' },
  ],
  cert: [
    { key: 'diagnosis', label: '诊断', type: 'textarea' },
    { key: 'rest_days', label: '建议休息天数', type: 'number', placeholder: '如 30' },
    { key: 'department', label: '科室', type: 'text', placeholder: '如 血液科' },
    { key: 'doctor', label: '医师', type: 'text', placeholder: '如 王医生' },
  ],
}

// 页面化录入：由路由页 /cases/add 渲染。pendingToken / pendingIndex 对应待导入文件在缓存中的位置。
export default function CaseImportFlow({
  onClose,
  onSaved,
  pendingToken,
  pendingIndex = 0,
  batchTotal = 0,
  onAdvance,
  onSwitchFlow,
  initialManual = false,
  // 从「AI 任务」回来（/cases/add?task=<id>）：把已完成结果重新落成草稿
  taskId = '',
}) {
  const fileRef = useRef(null)
  const [file, setFile] = useState(null)
  const [manual, setManual] = useState(false) // 手动录入（无原件）：file 为空，字段全靠粘贴/手填
  const [pasteText, setPasteText] = useState('') // 手动录入时粘贴的原文（可选，用于自动解析）
  const [status, setStatus] = useState('idle') // idle | extracting | editing | saving
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState(null)
  const [dup, setDup] = useState(null)
  const [fileSha, setFileSha] = useState('') // 原件 SHA-256（查重主通道）
  const [kindInfo, setKindInfo] = useState(null)
  // ---- AI 精读轨（2026-10-25 接通）：与检查报告同一条链路（提交 → 轮询 → 并入草稿）----
  // 接通前病历文书完全没有 AI：从检查报告导入页跑出的 AI 结果只能靠「改为病历文书」带过来，
  // 而本页自己发不了任务 —— 这也是「AI 任务里那条结果无处落地」的成因之一。
  const [aiState, setAiState] = useState('idle') // idle | running | done | failed | skipped | background
  const [aiResult, setAiResult] = useState(null)
  const [aiError, setAiError] = useState('')
  const [aiElapsed, setAiElapsed] = useState(0)
  const [aiBlocked, setAiBlocked] = useState('')
  const [consentAsk, setConsentAsk] = useState(false) // 云端同意门
  const [taskInfo, setTaskInfo] = useState(null) // 从任务恢复时记录来源（#短码）
  const aiTimerRef = useRef(null)
  const aiAbortRef = useRef(null)
  const consentCbRef = useRef(null)
  const taskLoadedRef = useRef('')
  // 药名候选：现有用药事件 + 药品价目表（隐式药品登记，零新增存储）
  const buildRoster = () => {
    const st = getState()
    return [
      ...new Set(
        [
          ...(st.events || []).filter((e) => e.category === 'medication').map((e) => e.drug || e.text),
          ...(st.drugPrices || []).map((p) => p.drug),
        ].filter(Boolean)
      ),
    ]
  }

  // 手动录入（无原件）：有出院小结文字就粘贴自动解析，只有纸质/记忆就直接填字段。
  // 一套 UI 覆盖两种场景，不新增路由、不新增页面。
  const startManual = () => {
    setFile(null)
    setManual(true)
    setDup(null)
    setError('')
    setNotice('')
    setPasteText('')
    const roster = buildRoster()
    setMedRoster(roster)
    setMedRows([])
    setForm({
      kind: 'discharge',
      doc_type: '出院记录',
      part: '',
      date: '', // 日期绝不默认今天：填不出就留空，保存时拦截（与化验导入同口径）
      time: '',
      reported_at: '',
      title: '出院记录',
      fields: {},
      findings: '',
      conclusion: '',
      notes: '',
      is_scanned: false,
      ocr_status: '',
      page_count: 1,
      raw_text: '',
    })
    setStatus('editing')
  }

  // 粘贴原文 → 解析并填充表单（同时重算用药候选）
  const parsePasted = () => {
    const rawText = String(pasteText || '')
    if (!rawText.trim()) return
    const parsed = parseDocText(rawText)
    const roster = medRoster.length ? medRoster : buildRoster()
    const kind = parsed.kind || form.kind
    const date = parsed.date || form.date
    setForm((f) => ({
      ...f,
      kind,
      doc_type: parsed.doc_type || f.doc_type,
      date,
      time: parsed.time || '',
      reported_at: parsed.reported_at || '',
      title: parsed.title || f.title,
      fields: { ...(f.fields || {}), ...(parsed.fields || {}) },
      findings: parsed.findings || f.findings,
      conclusion: parsed.conclusion || f.conclusion,
      raw_text: cleanReportText(rawText),
    }))
    setMedRows(
      kind === 'discharge'
        ? diffMedList(extractMedInstructions(rawText, roster), getState().events, { date, roster })
        : []
    )
    setNotice('已按粘贴内容解析字段，请核对后再保存')
    setTimeout(() => setNotice(''), 4000)
  }

  // 出院医嘱里识别到的用药候选（点击保存时，勾选行一并写入用药事件）
  const [medRows, setMedRows] = useState([])
  const [medRoster, setMedRoster] = useState([])
  // 重新识别：再跑一次原件解析 → 「旧 vs 新」对比 → 用户确认后才替换表单（不写库）
  const [recoLoading, setRecoLoading] = useState(false)
  const [recoResult, setRecoResult] = useState(null)

  const isExternalBatch = batchTotal > 1
  const isBatch = isExternalBatch
  const curIndex = isExternalBatch ? pendingIndex + 1 : 0
  const curTotal = isExternalBatch ? batchTotal : 0
  const curFileName = getFileName(pendingToken, pendingIndex) || (file ? file.name : '') || ''

  useEffect(() => {
    // ?manual=1 直达：不经过上传，直接进手动录入表单
    if (initialManual) {
      startManual()
      return
    }
    const f = peekFiles(pendingToken)[pendingIndex]
    if (f) pickFile(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 实时查重：原件哈希（fileSha）为主通道，date+doc_type+文件名 为历史兜底（见 utils/docDup.js）
  useEffect(() => {
    if (!form || !file) return
    setDup(
      findDuplicateDoc({
        date: form.date,
        doc_type: form.doc_type,
        file_name: file.name,
        file_sha256: fileSha,
        kind: form.kind, // 显式告知大类：查重按 category 隔离，缺了它病历文书永远匹配不上
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form && form.date, form && form.doc_type, file && file.name, fileSha])

  const handleFiles = (fileList) => {
    const list = Array.from(fileList || []).filter(Boolean)
    if (list.length) pickFile(list[0])
  }

  const advance = () => {
    if (onAdvance) return onAdvance()
    onClose && onClose()
  }

  // AI 通道可用性预检（与检查报告导入页同口径：关掉链路时给明确原因，而不是点了没反应）
  useEffect(() => {
    let alive = true
    fetch('/api/agent-mode')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no-server'))))
      .then((j) => {
        if (!alive) return
        if (j.mode === 'off') setAiBlocked('AI 链路已关闭（顶栏「AI 反馈」面板可切回 oneshot / off）')
      })
      .catch(() => {
        if (alive) setAiBlocked('AI 服务未连接（需 pnpm run dev:full 起 8008）')
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(
    () => () => {
      if (aiTimerRef.current) clearInterval(aiTimerRef.current)
      if (aiAbortRef.current) aiAbortRef.current.abort()
    },
    []
  )

  // AI 精读：原图/文字层交给 agent，产出 kind / 各类日期 / 诊断 / 医嘱 / 结构化字段
  const runAiRead = async () => {
    if (!file || !form) return
    if (!hasCloudConsent('ai')) {
      consentCbRef.current = runAiRead
      setConsentAsk(true)
      return
    }
    const id = `docread-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const isImage = (file.type || '').startsWith('image/')
    const mode = docReadModeFor({ isImage, isScanned: !!form.is_scanned, textLen: (form.raw_text || '').length })
    setAiState('running')
    setAiError('')
    setAiElapsed(0)
    const t0 = Date.now()
    if (aiTimerRef.current) clearInterval(aiTimerRef.current)
    aiTimerRef.current = setInterval(() => setAiElapsed(Date.now() - t0), 1000)
    const ac = new AbortController()
    aiAbortRef.current = ac
    try {
      let image = ''
      if (mode === 'doc') image = (await docImageForAi(file)).dataUrl
      upsertTask({
        id,
        kind: 'doc',
        state: 'running',
        mode,
        fileName: file.name,
        docType: form.doc_type || '',
        startedAt: new Date(t0).toISOString(),
        reviewed: false,
      })
      const sha = fileSha || (await fileFingerprint(file).catch(() => ''))
      // 原件存进 blob（内容寻址去重）：任务要能链接回源文件，而不是只记一个文件名
      const blobId = await saveDocFile(file).catch(() => '')
      const posted = await postDocRead({
        id,
        mode,
        image,
        text: form.raw_text || '',
        reportType: form.doc_type || '',
        fileName: file.name,
        sha256: sha,
        origin: 'case',
        blobId,
      })
      if (posted && posted.skipped) {
        setAiState('skipped')
        setAiError(aiBlocked || 'AI 链路已关闭')
        return
      }
      if (!posted || !posted.persisted) {
        setAiState('failed')
        setAiError('AI 服务未连接（需 pnpm run dev:full 起 8008）')
        patchTask(id, { state: 'failed', error: 'server-unreachable' })
        return
      }
      // 前台只等 2 分钟，超时转后台（与检查报告同口径：骨穿/图版文书可能要跑很久）
      let done = await pollAiTask(id, { signal: ac.signal, timeoutMs: 120_000, intervalMs: 3000 })
      if (done.state === 'timeout') {
        setAiState('background')
        patchTask(id, { state: 'running', note: '2 分钟未出结果，已转后台继续精读' })
        done = await pollAiTask(id, { signal: ac.signal, timeoutMs: 28 * 60_000, intervalMs: 5000 })
      }
      if (done.state === 'aborted') {
        patchTask(id, { state: 'running' })
        return
      }
      if (done.state === 'rate_limited') {
        setAiState('failed')
        setAiError(done.message || 'AI 接口限流中')
        return
      }
      if (done.state === 'timeout') {
        setAiState('background')
        setAiError('AI 仍在后台精读；可到「AI 任务」查看，完成后点「继续导入」回到本页')
        return
      }
      if (done.state === 'failed' || (done.status && done.status !== 'done')) {
        setAiState('failed')
        setAiError('AI 精读失败（agent 未能读出内容，可到「AI 任务」重试）')
        return
      }
      const elapsed = Date.now() - t0
      setForm((f) => {
        const merged = mergeAiIntoCaseDraft(f, done)
        merged._ai = aiMetaFrom(id, done, elapsed)
        return merged
      })
      setAiResult(done)
      setAiElapsed(elapsed)
      setAiState('done')
      upsertTask({
        id,
        kind: 'doc',
        state: 'done',
        mode,
        fileName: file.name,
        docType: (done && done.doc_type) || form.doc_type || '',
        confidence: (done && done.confidence && done.confidence.overall) || '',
        elapsedMs: elapsed,
        startedAt: new Date(t0).toISOString(),
        reviewed: false,
      })
    } catch (e) {
      console.error('AI 精读失败', e)
      setAiState('failed')
      setAiError('AI 精读异常：' + ((e && e.message) || String(e)))
      patchTask(id, { state: 'failed', error: (e && e.message) || String(e) })
    } finally {
      if (aiTimerRef.current) clearInterval(aiTimerRef.current)
      aiAbortRef.current = null
    }
  }

  // 从「AI 任务」回来继续业务线（/cases/add?task=<id>）：拉回原件 + 已完成结果，直接进核对态
  const loadFromTask = async (tid) => {
    setStatus('extracting')
    setError('')
    setNotice('')
    const bundle = await fetchTaskBundle(tid)
    if (!bundle) {
      setError('任务读取失败：服务端不可达（需 8008 在跑）')
      setStatus('idle')
      return
    }
    if (bundle.state !== 'done') {
      setError(
        bundle.state === 'failed'
          ? '该任务上次没有读出结果，可在「AI 任务」里重试'
          : '该任务仍在读图；完成后在「AI 任务」里点「继续导入」即可回到这里'
      )
      setStatus('idle')
      return
    }
    const done = bundle.done || {}
    const req = bundle.request || {}
    const fileName = req.fileName || `task-${tid}.jpg`
    let f = null
    // hasFile = 有源文件（logs 图 或 blob 原件）；老服务端只回 hasImage，故兜底
    if (req.hasFile !== false && (req.hasFile || req.hasImage)) {
      const blob = await fetchTaskImage(tid)
      if (blob && blob.size) f = new File([blob], fileName, { type: blob.type || 'image/jpeg' })
    }
    const roster = buildRoster()
    setMedRoster(roster)
    const draft = mergeAiIntoCaseDraft(
      {
        kind: 'discharge',
        doc_type: '',
        category: 'case',
        part: '',
        date: '',
        time: '',
        reported_at: '',
        title: '',
        findings: '',
        conclusion: '',
        fields: {},
        notes: '',
        is_scanned: !!req.hasImage,
        ocr_status: '',
        page_count: 1,
        raw_text: bundle.text || '',
      },
      done
    )
    draft._ai = aiMetaFrom(tid, done, 0)
    setFile(f)
    setManual(!f) // 无原件 → 走「手动录入（无原件）」形态：允许保存，只是没有原件可存
    // 同 DocImportFlow::loadFromTask：任务没带 sha 就用原件字节现算（口径见 utils/docDraftSha.js）
    setFileSha('')
    resolveDraftSha({ requestSha: req.sha256, file: f, fingerprint: fileFingerprint })
      .then((h) => h && setFileSha((prev) => prev || h))
      .catch(() => {})
    setForm(draft)
    setAiResult(done)
    setAiState('done')
    setTaskInfo({ id: tid, fileName, requestedAt: req.requestedAt || '' })
    setMedRows([])
    setKindInfo(null)
    setStatus('editing')
  }

  useEffect(() => {
    if (!taskId || taskLoadedRef.current === taskId) return
    taskLoadedRef.current = taskId
    loadFromTask(taskId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const pickFile = async (f) => {
    if (!f) return
    // 页内上传没有 pendingToken：自登记一个，改判流向（改为检查报告 / 改为检验报告）时才不会丢原件
    if (!pendingToken) setSelfPendingFiles([f], 'case')
    // AI 精读结果只认「同一 token 槽位上的同一份文件」：文件名不一致说明用户换过原件，不套用
    const aiToken = pendingToken || getLastSelfToken()
    const aiSlotName = (peekFiles(aiToken)[pendingIndex] || {}).name || ''
    const aiForPickedFile = aiSlotName && aiSlotName === f.name ? takePendingAi(aiToken, pendingIndex) : null
    setFile(f)
    setManual(false)
    setPasteText('')
    setDup(null)
    setFileSha('')
    fileFingerprint(f)
      .then((h) => setFileSha(h || ''))
      .catch(() => {})
    setError('')
    setNotice('')
    setTaskInfo(null)
    setAiResult(null)
    setAiState('idle')
    setAiError('')
    setStatus('extracting')
    try {
      const isImage = (f.type || '').startsWith('image/')
      let rawText = ''
      let isScanned = false
      let pageCount = 1
      let ocrStatus = ''

      if (isImage) {
        const preText = getPendingText(pendingToken, pendingIndex)
        if (preText) {
          rawText = preText
          ocrStatus = 'ok'
        } else {
          try {
            rawText = await ocrImageToText(await fileToDataUrl(f))
            ocrStatus = 'ok'
          } catch {
            ocrStatus = 'failed'
          }
        }
      } else {
        const { text, isScanned: scanned, pageCount: pc } = await extractDocContent(f)
        pageCount = pc
        isScanned = scanned
        if (scanned) {
          try {
            rawText = await ocrScannedPdfToText(f)
            ocrStatus = 'ok'
          } catch {
            ocrStatus = 'failed'
          }
        } else {
          rawText = text
        }
      }

      const parsed = parseDocText(rawText || '')
      const fields = parsed.fields && Object.keys(parsed.fields).length ? parsed.fields : {}
      const draft = mergeAiIntoCaseDraft(
        {
          kind: parsed.kind,
          doc_type: parsed.doc_type,
          category: 'case',
          part: parsed.part || '',
          date: parsed.date,
          time: parsed.time,
          reported_at: parsed.reported_at || '',
          title: parsed.title || (f.name || '').replace(/\.(pdf|jpe?g|png|webp|gif)$/i, ''),
          findings: parsed.findings,
          conclusion: parsed.conclusion,
          fields,
          notes: '',
          is_scanned: isScanned,
          ocr_status: ocrStatus,
          page_count: pageCount,
          raw_text: cleanReportText(rawText),
        },
        aiForPickedFile
      )
      // AI 结果是「从检查报告导入页改判带过来」的：把任务 id 也记进草稿元数据，
      // 保存时才写 postTaskReview —— 否则那条任务永远停在任务中心的「待核对」里。
      if (aiForPickedFile && aiForPickedFile.id) draft._ai = aiMetaFrom(aiForPickedFile.id, aiForPickedFile, 0)
      setForm(draft)
      if (draft._aiUsed) {
        setNotice('已采用 AI 精读结果（出院日期 / 入院日期 / 诊断 / 医嘱等），请核对后保存')
        setTimeout(() => setNotice(''), 6000)
      }
      // 出院记录：顺带从「出院医嘱」里识别用药清单（只产出候选，写入与否由用户勾选决定）
      const st = getState()
      const roster = buildRoster()
      setMedRoster(roster)
      setMedRows(
        draft.kind === 'discharge'
          ? diffMedList(extractMedInstructions(rawText || '', roster), st.events, { date: draft.date, roster })
          : []
      )
      setKindInfo(detectReportKind({ fileName: f.name || '', text: rawText }))
      setStatus('editing')
    } catch (e) {
      console.error(e)
      setError('解析失败：' + (e.message || String(e)))
      setStatus('idle')
    }
  }

  // 出院日期被手改 → 按新日期重算增量判定（纯函数，开销可忽略）
  useEffect(() => {
    if (!form || !medRows.length) return
    setMedRows((rows) => rows.map((r) => refreshRow(r, getState().events, { date: form.date, roster: medRoster })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form && form.date])

  const setField = (k, v) => setForm({ ...form, fields: { ...(form.fields || {}), [k]: v } })

  // 改药名会重新匹配已有药并重判动作（新/改量/重启/已在服）
  const setMedRow = (i, patch) =>
    setMedRows((rows) =>
      rows.map((r, k) => (k === i ? refreshRow({ ...r, ...patch }, getState().events, { date: form.date, roster: medRoster }) : r))
    )

  // 重新识别：对同一份原件重跑解析，与当前表单内容做对比（草稿态，落库仍等用户点保存）
  const startReRecognize = async () => {
    if (!file) return
    setRecoLoading(true)
    try {
      const rawText = await docFileToText(file)
      const parsed = parseDocText(rawText || '')
      const result = reRecognizeDocWithParsed(parsed, {
        id: 'draft',
        kind: form.kind,
        doc_type: form.doc_type,
        part: form.part,
        date: form.date,
        time: form.time,
        fields: form.fields || {},
        findings: form.findings,
        conclusion: form.conclusion,
        title: form.title,
      })
      result.applyRawText = rawText || ''
      setRecoResult(result)
    } catch (e) {
      console.error('重新识别失败', e)
      setError('重新识别失败：' + (e.message || String(e)))
    } finally {
      setRecoLoading(false)
    }
  }

  const applyReco = (patch) => {
    const rawText = recoResult && recoResult.applyRawText
    const nextDate = patch.date || form.date
    setForm((f) => ({ ...f, ...patch, raw_text: rawText ? cleanReportText(rawText) : f.raw_text }))
    // 原文变了 → 用药候选按新原文重算（否则会沿用旧识别的用药清单）
    if (rawText) {
      const st = getState()
      setMedRows(
        (patch.kind || form.kind) === 'discharge'
          ? diffMedList(extractMedInstructions(rawText, medRoster), st.events, { date: nextDate, roster: medRoster })
          : []
      )
    }
    setRecoResult(null)
  }
  // 脏值防御：历史数据可能残留非日期字符串，直接 dayjs() 会渲染成 Invalid Date
  const dateVal = (v) => (v && dayjs(v).isValid() ? dayjs(v) : null)

  // 改判到报告类（检验 / 检查）：与 DocImportFlow::switchTo 同口径——文件跟着走，
  // 缓存里没有这份原件就现场登记（从 AI 任务恢复的草稿本来就取不到 token）。
  const switchTo = (flow) => {
    if (!onSwitchFlow) return
    const slot = ensurePendingSlot({
      token: pendingToken,
      index: pendingIndex,
      file,
      text: (form && form.raw_text) || '',
    })
    // 无原件（doc-text 任务 / 手动录入）时带任务 id，让目标页用 loadFromTask 接住结果
    onSwitchFlow(flow, { token: slot.token, index: slot.index, taskId: slot.token ? '' : (taskInfo && taskInfo.id) || '' })
  }

  const save = async () => {
    // 手动录入模式允许无原件；上传模式必须有文件
    if (!form || (!file && !manual)) return
    if (!form.date) {
      setError('请填写出院 / 开具日期')
      return
    }
    // doc_type 归一到规范值后再查重/落库：「诊断证明书」「出院诊断证明书」与「诊断证明」是同一个意思，
    // 不归一会让查重键（date+doc_type+file_name）漏判重复（2026-10-20 用户口径）
    const caseDocType = normalizeCaseDocType(form.doc_type, form.kind)
    // 原件哈希：保存前必做一次字节级核对（手动录入无原件 → 空，自动退到三项通道）
    const sha = file ? fileSha || (await fileFingerprint(file)) || '' : ''
    const dup = findDuplicateDoc({
      date: form.date,
      doc_type: caseDocType,
      file_name: file ? file.name : '',
      file_sha256: sha,
      kind: form.kind,
    })
    if (dup) {
      setError(
        manual
          ? `与已归档文书（${dup.date} · ${dup.doc_type}）重复，已禁止保存，请修改日期或类型`
          : `当前文件（${file.name}）与已归档文书（${dup.date} · ${dup.doc_type} · ${dup.file && dup.file.name ? dup.file.name : ''}）重复，已禁止保存`
      )
      return
    }
    setStatus('saving')
    try {
      const docId = `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const fileId = file ? await saveDocFile(file) : null
      if (form.raw_text) await saveDocText(docId, form.raw_text)
      addDoc({
        id: docId,
        kind: form.kind,
        doc_type: caseDocType,
        category: 'case',
        fields: form.fields || {},
        part: form.part || '',
        date: form.date,
        time: form.time,
        reported_at: form.reported_at || '',
        title: form.title,
        findings: form.findings,
        conclusion: form.conclusion,
        notes: form.notes,
        has_text: !!form.raw_text,
        is_scanned: file ? !!form.is_scanned : false,
        page_count: file ? form.page_count : 1,
        // 识别元数据（含 AI 轨来源与任务号），供列表徽章 / 详情页审计与「任务 ↔ 归档」回跳
        ai: form._ai
          ? {
              engine: 'ai',
              mode: aiModeNow === 'doc-text' ? 'text' : 'vision',
              version: form._ai.version,
              at: form._ai.at,
              elapsed_ms: form._ai.elapsedMs,
              confidence: form._ai.confidence,
              evidence_count: (form._ai.evidence || []).length,
              task_id: form._ai.id,
            }
          : { engine: 'ocr', at: new Date().toISOString() },
        // 手动录入：无原件可存（详情页据此提示、禁用重新识别与下载）
        no_file: !file,
        file: file
          ? {
              id: fileId,
              name: file.name,
              size: file.size,
              mime: file.type || 'application/pdf',
              sha256: sha, // 归档查重主通道（同一份文件 → 字节一致）
            }
          : null,
      })
      // 任务采用回写（服务端侧记 docId）：任务中心才能「点任务直接打开这条归档」
      if (form._ai && form._ai.id) postTaskReview(form._ai.id, docId)
      postOcrReview({
        type: 'case',
        id: docId,
        docType: form.doc_type,
        date: form.date,
        findings: form.findings,
        conclusion: form.conclusion,
        fields: form.fields,
      })
      // 勾选用药 → 写入用药事件（幂等：同日同药已有则覆盖更新，不会重复堆积）
      let medCount = 0
      for (const p of planMedWrites(medRows, getState().events, form.date)) {
        const payload = buildMedEvent({ date: form.date, drug: p.drug, dose: p.dose, unit: p.unit })
        if (p.mode === 'update' && p.id) updateEvent(p.id, payload)
        else addEvent(payload)
        medCount++
      }
      onSaved && onSaved(medCount ? `病历文书已归档，写入 ${medCount} 项用药记录（生效日 ${form.date}）` : '')
      advance()
    } catch (e) {
      console.error(e)
      setError('保存失败：' + (e.message || String(e)))
      setStatus('editing')
    }
  }

  const schema = FIELD_SCHEMA[form && form.kind] || []
  // 保存时写入 mode：文本整理 vs 读图（aiResult 不带 mode，按是否扫描件/图片反推，与提交时同口径）
  const aiModeNow = form && (form.is_scanned || (file && (file.type || '').startsWith('image/'))) ? 'doc' : 'doc-text'

  return (
    <div className="space-y-4">
      <div className="card overflow-hidden flex flex-col">
        <div className="px-6 py-4 bg-slate-900 text-white">
          <div className="flex items-center gap-4">
            <BackButton onClick={onClose} tone="dark" title={isBatch ? '退出批量' : '返回'} testId="case-import-back" />
            <div className="min-w-0">
              <h2 className="font-semibold">{isBatch ? `批量录入（${curIndex}/${curTotal}）` : '添加病历文书'}</h2>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                {isBatch && file ? `当前文件：${file.name}` : '原件 PDF 完整保存本地 · 自动抽取结构化字段'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-auto">
              {!manual && (
                <Button
                  size="small"
                  className="!bg-slate-700 !border-slate-600 !text-white"
                  onClick={startReRecognize}
                  disabled={recoLoading}
                  title="对同一份原件再跑一次识别，先看差异再决定要不要采用"
                >
                  {recoLoading ? '识别中…' : '↻ 重新识别'}
                </Button>
              )}
              {!manual && onSwitchFlow && (
                <>
                  <Button size="small" className="!bg-slate-700 !border-slate-600 !text-white" onClick={() => switchTo('doc')}>
                    改为检查报告
                  </Button>
                  <Button size="small" className="!bg-slate-700 !border-slate-600 !text-white" onClick={() => switchTo('lab')}>
                    改为检验报告
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          {status === 'idle' && (
            <div>
              {notice && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg px-4 py-3 mb-4">✓ {notice}</div>}
              <div
                className="border-2 border-dashed border-slate-200 rounded-xl p-10 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50/30 transition-colors"
                onClick={() => fileRef.current && fileRef.current.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
              >
                <input ref={fileRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
                <p className="text-3xl mb-2">📄</p>
                <p className="text-sm text-slate-600 font-medium">点击或拖拽 PDF / 图片到此处</p>
                <p className="text-xs text-slate-400 mt-1">出院记录、诊断证明、门诊病历等病历文书</p>
              </div>
              <div className="text-center">
                <Button onClick={startManual}>无原件？手动录入 / 粘贴原文</Button>
                <p className="text-xs text-slate-400 mt-2">
                  没有电子版文书时可用：粘贴出院小结文字自动解析，或直接填写结构化字段
                </p>
              </div>
            </div>
          )}

          {status === 'extracting' && (
            <div className="text-center py-12">
              <div className="inline-block w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm text-slate-600">正在提取 / OCR 识别文书内容…</p>
              <p className="text-xs text-slate-400 mt-1">{file ? file.name : ''}</p>
            </div>
          )}

          {error && status !== 'saving' && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}

          {status === 'editing' && form && (
            <div className="space-y-4">
              {notice && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg px-4 py-3">✓ {notice}</div>}
              {dup && (
                <div className="bg-amber-50 border border-amber-300 text-amber-800 text-sm rounded-lg px-4 py-3">
                  <div className="font-semibold mb-1">⚠️ 疑似重复归档</div>
                  <p>
                    {file
                      ? `当前文件 ${file.name}（${form.date || '未填日期'} · ${form.doc_type || '未填类型'}）与已归档文书${
                          fileSha && dup.file && String(dup.file.sha256 || '') === fileSha
                            ? '是同一份文件（原件字节完全相同）'
                            : '完全一致'
                        }，保存将被禁止。`
                      : '已归档过同日期同类型的文书，保存将被禁止。'}
                  </p>
                </div>
              )}
              {manual && (
                <div className="rounded-lg border border-brand-100 bg-brand-50/40 p-4 space-y-2">
                  <p className="text-xs font-semibold text-brand-700">手动录入（无原件）</p>
                  <div>
                    <label className="label">粘贴原文（可选）</label>
                    <Input.TextArea
                      rows={4}
                      value={pasteText}
                      placeholder="把出院小结 / 出院医嘱的文字粘进来（没有就直接填下面的字段）"
                      onChange={(e) => setPasteText(e.target.value)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="small" type="primary" onClick={parsePasted} disabled={!pasteText.trim()}>
                      解析并填充
                    </Button>
                    <span className="text-[11px] text-slate-400">会按原文自动填字段并识别出院用药；不解析也能直接手填</span>
                  </div>
                </div>
              )}
              {form.ocr_status === 'ok' && (
                <div className="bg-sky-50 border border-sky-200 text-sky-800 text-sm rounded-lg px-4 py-3">
                  🔍 已通过 OCR 识别（共 {(form.raw_text || '').length} 字），以下为自动解析结果，请核对修正。
                </div>
              )}
              {!manual && !form.is_scanned && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-lg px-4 py-2">
                  ✓ 已提取全文 {form.page_count || 1} 页，共 {(form.raw_text || '').length} 字
                </div>
              )}

              {/* 从 AI 任务恢复的草稿：明示来源（哪条任务、什么时候提交、有没有再花钱） */}
              {taskInfo && (
                <div className="bg-sky-50 border border-sky-200 text-sky-800 text-sm rounded-lg px-4 py-3" data-testid="case-from-task">
                  <div className="font-semibold mb-1">本草稿来自 AI 任务 {shortId(taskInfo.id)}</div>
                  <p className="text-xs">
                    源文件 {taskInfo.fileName}
                    {taskInfo.requestedAt ? ` · 提交于 ${fmtStamp(taskInfo.requestedAt)}` : ''}
                    　结果已完成，本次没有再读图、也没有再产生费用。核对后直接保存即可。
                  </p>
                  {!file && <p className="text-xs mt-1 text-amber-700">该任务未留存原图，将保存为「无原件」文书（后续可补传原件）。</p>}
                  <p className="text-xs mt-1 flex flex-wrap items-center gap-x-3">
                    <button
                      type="button"
                      className="underline text-sky-700 hover:text-sky-900"
                      onClick={() => onClose && onClose()}
                      title="草稿只存在于当前页面，返回即丢弃（不保存任何内容；任务结果仍留在「AI 任务」里，可再来）"
                    >
                      丢弃草稿并返回
                    </button>
                    <button
                      type="button"
                      className="underline text-rose-600 hover:text-rose-800"
                      onClick={() => {
                        Modal.confirm({
                          title: '丢弃草稿并删除这条识别结果？',
                          content: '会连同原图与识别产物一起永久删除（不可恢复）。已归档的文书不受影响。',
                          okText: '删除',
                          okType: 'danger',
                          cancelText: '取消',
                          onOk: async () => {
                            const r = await deleteTaskRemote(taskInfo.id)
                            if (!r.ok) {
                              Modal.error({ title: '删除失败', content: DELETE_TASK_ERR[r.error] || `请稍后重试（${r.error}）` })
                              return
                            }
                            setTaskInfo(null)
                            onClose && onClose()
                          },
                        })
                      }}
                      title="不要这条结果了，并且把服务端的原图与识别产物一起删掉"
                    >
                      丢弃并删除结果
                    </button>
                    <span className="text-slate-500">（前者只离开、结果仍留在「AI 任务」；后者连结果一起删）</span>
                  </p>
                </div>
              )}

              {/* AI 精读状态条（与检查报告同一口径：非阻塞、可在任务中心看结果） */}
              {!manual && (
                <div className="rounded-lg border border-brand-200 bg-brand-50/60 px-4 py-2.5 flex flex-wrap items-center gap-3">
                  <Button
                    size="small"
                    type="primary"
                    loading={aiState === 'running'}
                    onClick={runAiRead}
                    disabled={aiState === 'running' || !file}
                    title={aiBlocked || '让 AI 读原件，自动抽出日期 / 诊断 / 医嘱等字段（结果以 AI 为准，手改优先）'}
                  >
                    {aiState === 'running'
                      ? `AI 读图中 ${Math.round((aiElapsed || 0) / 1000)}s`
                      : aiState === 'done'
                        ? '重新 AI 识别'
                        : 'AI 识别'}
                  </Button>
                  <span className="text-[11px] text-slate-500">
                    {aiState === 'done'
                      ? '已并入 AI 结果（下方字段可逐项修改；手改过的字段不会被覆盖）'
                      : aiState === 'background'
                        ? 'AI 仍在后台精读，可先核对；完成后到「AI 任务」点「继续导入」回来'
                        : aiState === 'failed'
                          ? '本次 AI 未成功，可重试或手动填写'
                          : 'AI 精读约 30s–2 分钟；提交后可以离开页面，结果进「AI 任务」'}
                  </span>
                </div>
              )}
              {aiError && <Alert type="warning" showIcon message={aiError} closable onClose={() => setAiError('')} />}

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="label">文书类别</label>
                  <Select className="w-full" value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} options={KIND_OPTIONS} />
                </div>
                <div>
                  <label className="label">文书类型</label>
                  <Input value={form.doc_type} placeholder="如：出院记录 / 诊断证明" onChange={(e) => setForm({ ...form, doc_type: e.target.value })} />
                </div>
                <div>
                  <label className="label">出院 / 开具日期</label>
                  <DateInput className="w-full" value={form.date ? dayjs(form.date) : null} onChange={(d) => setForm({ ...form, date: d ? d.format('YYYY-MM-DD') : '' })} placeholder="选择日期" allowClear clearIcon={<span title="清除日期">×</span>} />
                </div>
                <div>
                  <label className="label">标题</label>
                  <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
              </div>

              {/* 结构化字段（按子类型渲染专属模板） */}
              {schema.length > 0 && (
                <div className="rounded-lg border border-brand-100 bg-brand-50/40 p-4 space-y-3">
                  <p className="text-xs font-semibold text-brand-700">结构化字段（自动抽取，可修改）</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    {schema.map((f) =>
                      f.type === 'date' ? (
                        <div key={f.key}>
                          <label className="label">{f.label}</label>
                          <DateInput className="w-full" value={dateVal(form.fields && form.fields[f.key])} onChange={(d) => setField(f.key, d ? d.format('YYYY-MM-DD') : '')} placeholder="选择日期" allowClear clearIcon={<span>×</span>} />
                        </div>
                      ) : f.type === 'textarea' ? (
                        <div key={f.key} className="md:col-span-2">
                          <label className="label">{f.label}</label>
                          <Input.TextArea rows={2} value={(form.fields && form.fields[f.key]) || ''} placeholder={f.placeholder} onChange={(e) => setField(f.key, e.target.value)} />
                        </div>
                      ) : (
                        <div key={f.key}>
                          <label className="label">{f.label}</label>
                          <Input value={(form.fields && form.fields[f.key]) || ''} placeholder={f.placeholder} onChange={(e) => setField(f.key, e.target.value)} />
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              <MedImportList rows={medRows} roster={medRoster} date={form.date} onChange={setMedRow} />

              <div>
                <label className="label">所见 / 描述</label>
                <Input.TextArea rows={3} value={form.findings} placeholder="自动提取，可修改" onChange={(e) => setForm({ ...form, findings: e.target.value })} />
              </div>
              <div>
                <label className="label">结论</label>
                <Input.TextArea rows={2} value={form.conclusion} placeholder="自动提取，可修改" onChange={(e) => setForm({ ...form, conclusion: e.target.value })} />
              </div>
              <div>
                <label className="label">备注</label>
                <Input value={form.notes} placeholder="如：补开证明、关联就诊等" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>

              {form.raw_text && (
                <details className="bg-slate-50 rounded-lg border border-slate-100">
                  <summary className="px-4 py-2 text-xs text-slate-500 cursor-pointer hover:text-slate-700">查看提取的原文（{form.raw_text.length} 字）</summary>
                  <pre className="px-4 pb-3 text-xs text-slate-600 whitespace-pre-wrap max-h-48 overflow-auto">{form.raw_text}</pre>
                </details>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                <p className="text-xs text-slate-400">
                  {file ? (
                    <>
                      原件：<span className="text-slate-600">{file.name}</span>（{(file.size / 1024).toFixed(1)} KB）
                    </>
                  ) : (
                    <span className="text-slate-500">手动录入，无原件（保存后不能再重新识别）</span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setStatus('idle')
                      setForm(null)
                      setDup(null)
                      setError('')
                      setNotice('')
                      setMedRows([])
                      setManual(false)
                      setPasteText('')
                    }}
                  >
                    {manual ? '放弃并返回' : '重新选择'}
                  </Button>
                  <Button type="primary" onClick={save} loading={status === 'saving'}>
                    {manual ? '保存（无原件）' : isBatch ? `保存并继续（${curIndex}/${curTotal}）` : '保存归档（原件 + 字段）'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {recoResult && (
        <ReRecognizeDocModal
          doc={form}
          result={recoResult}
          docLabel={form.kind === 'cert' ? '诊断证明' : '出院记录'}
          onClose={() => setRecoResult(null)}
          onApply={applyReco}
        />
      )}
      {/* 云端/AI 隐私同意门（与检查报告导入页同口径） */}
      {consentAsk && (
        <CloudConsentModal
          engine="ai"
          onClose={() => {
            setConsentAsk(false)
            consentCbRef.current = null
          }}
          onOk={() => {
            setConsentAsk(false)
            const cb = consentCbRef.current
            consentCbRef.current = null
            if (cb) cb()
          }}
        />
      )}
    </div>
  )
}

