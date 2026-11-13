// ===================== 检查报告导入（AI 主识别 · 双轨）=====================
// 链路：本地识别先行出草稿（图片走 OCR / PDF 走文字层）→ 草稿区常驻「AI 识别」按钮
//      → AI 结果作为**权威轨**并入（可逐字段切回本地识别轨对照）→ 人工核对 → 保存归档。
//
// 设计依据：.agents/proposals/ai-first-doc-recognition.md（§3 双轨/三轨、§4.1 页面设计）
// 并行安全红线：本地识别迟到的结果**只写 OCR 轨**，绝不覆盖已生效的 AI 值（src/utils/docAi.js）。
// 人工优先红线：用户手打过的字段锁定为「已手改」轨，任何机器结果只提示不覆盖。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Input, Modal } from 'antd'
import { extractDocContent, parseDocText, cleanReportText } from '../utils/parseDoc.js'
import BackButton from './BackButton.jsx'
import { saveDocFile, saveDocText } from '../utils/docFileStore.js'
import { addDoc, findDuplicateDoc, findSimilarDoc, findCrossEntitySource } from '../data/store.js'
import { describeHit } from '../utils/dupScan.js'
import { ocrImageToText, ocrScannedPdfToText } from '../utils/ocr.js'
import { peekFiles, getFileName, getPendingText, setPendingAi, setSelfPendingFiles, ensurePendingSlot } from '../utils/pendingImport.js'
import { detectReportKind } from '../utils/reportKind.js'
import { postOcrReview } from '../utils/review.js'
import { postAiClassify, fetchClassifyStatus, postDocRead } from '../utils/classify.js'
import { docImageForAi, fileToDataUrl } from '../utils/docImage.js'
import { fileFingerprint } from '../utils/fileHash.js'
import { resolveDraftSha } from '../utils/docDraftSha.js'
import {
  mergeOcrIntoDraft,
  mergeAiIntoDraft,
  markUserEdit,
  switchTrack,
  diffTracks,
  docReadModeFor,
  aiMetaFrom,
  dateAnomaly,
  DOC_TRACK_FIELDS,
} from '../utils/docAi.js'
import { upsertTask, patchTask, pollAiTask, postTaskReview, fetchTaskBundle, fetchTaskImage, deleteTaskRemote, DELETE_TASK_ERR } from '../utils/docTasks.js'
import DocSourceViewer from './DocSourceViewer.jsx'
import DocAiReviewPanel from './DocAiReviewPanel.jsx'
import DocAiStatusBar from './DocAiStatusBar.jsx'
import CloudConsentModal, { hasCloudConsent } from './CloudConsentModal.jsx'
import { shortId } from '../utils/taskMeta.js'

// 任务提交时间：任务中心与草图横幅用同一口径（MM-DD HH:mm），便于两边肉眼对齐
const fmtStamp = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 页面化检查报告导入：由路由页 /archive/add 渲染（顶栏导航随时可点，点了即离开本页）。
// pendingToken / pendingIndex：本次待导入文件在 pendingImport 缓存中的位置（支持批量逐份）；
// onSwitchFlow('lab'|'case')：用户手动改判大类时切换走对应导入页。
export default function DocImportFlow({
  onClose,
  onSaved,
  pendingToken,
  pendingIndex = 0,
  batchTotal = 0,
  onAdvance,
  onSwitchFlow,
  // 打开某条已归档报告（软查重横幅里的「打开这条对比」用）
  onOpenDoc,
  // 从「AI 任务」回来时带的任务 id（/reports/add?flow=doc&task=<id>）：
  // 详见下方 loadFromTask —— 让已跑完的 AI 结果重新落到草稿上，而不是只读地摆在任务中心。
  taskId = '',
}) {
  const fileRef = useRef(null)
  const [file, setFile] = useState(null)
  const [status, setStatus] = useState('idle') // idle | extracting | editing | saving
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('') // 批量完成等中性提示
  const [form, setForm] = useState(null)
  const [dup, setDup] = useState(null) // 硬查重：命中即禁止保存
  const [similar, setSimilar] = useState(null) // 软查重 {doc, reason}：疑似同一份，只提示
  // 跨实体同源（软闸）：同一份原件已作为「化验记录」存在（方向与 ImportFlow 相反）。
  // 只提示 + 需显式确认，绝不静默放行 —— 2026-10-28 两条重复正是「检查报告 → 化验记录」单向迁移留下的。
  const [cross, setCross] = useState(null) // { kind, item, sha }
  const [fileSha, setFileSha] = useState('') // 原件 SHA-256（查重主通道，选文件即算）
  const [queue, setQueue] = useState(null) // 弹层内批量队列：{ files: [], index }
  const [kindInfo, setKindInfo] = useState(null) // 报告大类判定（检验报告 / 检查报告）
  const [recoLoading, setRecoLoading] = useState(false) // 重新识别（同一份原件再跑一次本地识别）
  const userDecidedRef = useRef(false) // 用户已手动改判 → 不再自动切换

  // ---- 双轨状态：本地识别（先行） + AI 精读（权威轨） ----
  const [ocrState, setOcrState] = useState('idle') // idle | running | done | failed
  const [ocrElapsed, setOcrElapsed] = useState(0)
  const [aiState, setAiState] = useState('idle') // idle | running | done | failed | rate_limited | skipped
  const [aiResult, setAiResult] = useState(null) // v2 产物（含 evidence / confidence）
  const [aiError, setAiError] = useState('')
  const [aiElapsed, setAiElapsed] = useState(0)
  const [aiBlocked, setAiBlocked] = useState('') // AI 不可用的原因串（agent off / 服务未连接）
  const [readModeNote, setReadModeNote] = useState('')
  const [aiMode, setAiMode] = useState('')
  const [consentAsk, setConsentAsk] = useState(null) // 隐私同意门：'ai' 时弹框
  const consentCbRef = useRef(null)
  const aiTimerRef = useRef(null)
  const aiAbortRef = useRef(null)
  const ocrTimerRef = useRef(null)
  const ocrT0Ref = useRef(0)

  // 其他检查 → AI 分类兜底（判类型 + 必要时切回化验 / 病历文书流程）
  const [classifyState, setClassifyState] = useState(null) // null | 'running' | {done, reportType, reportName} | 'failed' | 'skipped'

  // 批量来源：外部（顶栏按钮多文件拖入，由 App 驱动）或内部（上传区多选）
  const isExternalBatch = batchTotal > 1
  const isBatch = isExternalBatch || (queue ? queue.files.length > 1 : false)
  const curIndex = isExternalBatch ? pendingIndex + 1 : queue ? queue.index + 1 : 0
  const curTotal = isExternalBatch ? batchTotal : queue ? queue.files.length : 0
  const curFileName = getFileName(pendingToken, pendingIndex) || (file ? file.name : '') || ''
  const diffs = useMemo(() => (form ? diffTracks(form) : []), [form])
  // ---- 从 AI 任务恢复草稿（?task=<id>）----
  // AI 精读中位 110s、44% 超 120s（见 DocImportFlow 前台等待窗），结果落在服务端，
  // 但"能接住结果的草稿"原本只活在本次页面内存里 —— 关掉页面 = 白跑。
  // 这里把任务当草稿源：拉回原图 + 已完成结果，直接进核对态，不重跑 OCR、不重跑 AI。
  const [taskInfo, setTaskInfo] = useState(null) // { id, fileName, requestedAt }
  const [noOriginal, setNoOriginal] = useState(false) // 任务没留原图 → 只读结果，禁止保存
  const taskLoadedRef = useRef('')

  // AI 通道可用性预检（agent 模式 off / Trace 服务未起 时给出明确原因，而不是静默失败）
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

  // 从任务恢复草稿：done 结果 + 服务端落盘的原图 → 核对态（不重跑 OCR、不重跑 AI、不重复计费）
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
    // 原文件名必须原样保留：它参与归档查重键（date+doc_type+file_name），改名会让查重失效
    const fileName = req.fileName || `task-${tid}.jpg`
    let f = null
    // hasFile = 有源文件（logs 图 或 blob 原件）；老服务端只回 hasImage，故兜底
    if (req.hasFile !== false && (req.hasFile || req.hasImage)) {
      const blob = await fetchTaskImage(tid)
      if (blob && blob.size) f = new File([blob], fileName, { type: blob.type || 'image/jpeg' })
    }
    const base = {
      is_scanned: !!req.hasImage,
      ocr_status: '',
      page_count: 1,
      raw_text: bundle.text || '',
      notes: '',
    }
    const next = mergeAiIntoDraft({ ...base }, done)
    next.__file = fileName
    next._ai = aiMetaFrom(tid, done, 0)
    setFile(f)
    setNoOriginal(!f)
    // 查重口径见 utils/docDraftSha.js：任务没带 sha 就用原件字节现算，别让「字节通道」静默失效
    setFileSha('')
    resolveDraftSha({ requestSha: req.sha256, file: f, fingerprint: fileFingerprint })
      .then((h) => h && setFileSha((prev) => prev || h))
      .catch(() => {})
    setForm(next)
    setAiResult(done)
    setAiState('done')
    setAiElapsed(0)
    setClassifyState(null)
    setOcrState('idle')
    setTaskInfo({ id: tid, fileName, requestedAt: req.requestedAt || '' })
    setStatus('editing')
  }

  // 带 ?task= 进入：挂载即恢复（refguard 保证只拉一次）
  useEffect(() => {
    if (!taskId || taskLoadedRef.current === taskId) return
    taskLoadedRef.current = taskId
    loadFromTask(taskId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  // 顶栏「添加数据」拖放直达 / 批量队列当前份：挂载即自动解析，少点一次
  useEffect(() => {
    const f = peekFiles(pendingToken)[pendingIndex]
    if (f) pickFile(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 弹层内批量：队列变化时自动解析当前份
  useEffect(() => {
    if (queue) {
      const f = queue.files[queue.index]
      if (f) pickFile(f)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue])

  // 实时查重：解析完成或用户修改 检查日期 / 报告类型 / 文件名 时立即重新检测。
  // 原件哈希（fileSha）是主通道：命中即同一份文件，不受 OCR 把日期/类型读歪的影响（见 utils/docDup.js）。
  // 实时查重：原件哈希（fileSha）是主通道。
  // ⚠ 无原件（从 AI 任务恢复的 doc-text 任务 / 原图副本已清）时也要查：
  //   有 sha（新版任务请求里带 sha256）→ 仍走字节通道；没有 sha → 退回 date+doc_type+文件名三项。
  //   原实现要求 file 存在，导致这类草稿"完全不查重"，等于放行重复归档。
  useEffect(() => {
    if (!form) return
    const fileName = (file && file.name) || (taskInfo && taskInfo.fileName) || ''
    if (!form.date && !fileName) return
    const cand = { date: form.date, doc_type: form.doc_type, file_name: fileName, file_sha256: fileSha, kind: form.kind }
    const hard = findDuplicateDoc(cand)
    setDup(hard)
    // 跨实体同源：同一份原件是否已作为「化验记录」存在（只认原文件字节域）
    setCross(findCrossEntitySource({ file_sha256: cand.file_sha256 }, { wantKind: 'record' }))
    // 软查重只在没命中硬查重时才算（硬拦已经把话说明白了，不需要再叠一条）
    setSimilar(
      hard
        ? null
        : findSimilarDoc({ ...cand, conclusion: form.conclusion, findings: form.findings })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form && form.date, form && form.doc_type, file && file.name, fileSha, taskInfo && taskInfo.fileName])

  // 卸载：停掉计时器与在途轮询（agent 仍会在后台跑完，结果落 done 文件，回来可凭 id 重连）
  useEffect(
    () => () => {
      if (aiTimerRef.current) clearInterval(aiTimerRef.current)
      if (ocrTimerRef.current) clearInterval(ocrTimerRef.current)
      if (aiAbortRef.current) aiAbortRef.current.abort()
    },
    [],
  )

  // 接收拖入/选择的文件：单文件直接解析，多文件进入批量队列
  const handleFiles = (fileList) => {
    const list = Array.from(fileList || []).filter(Boolean)
    if (!list.length) return
    if (list.length === 1) {
      pickFile(list[0])
      return
    }
    setNotice('')
    setQueue({ files: list, index: 0 })
  }

  // 批量前进：外部批量交给 App 队列；内部批量走本地队列
  const advance = () => {
    if (onAdvance) {
      onAdvance()
      return
    }
    if (!queue) {
      onClose && onClose()
      return
    }
    const next = queue.index + 1
    if (next >= queue.files.length) {
      setStatus('idle')
      setFile(null)
      setForm(null)
      setError('')
      setNotice(`本批 ${queue.files.length} 份已处理完毕，可继续拖入下一批`)
      setQueue(null)
      return
    }
    setQueue({ ...queue, index: next })
  }

  // ---- 本地识别轨：提取 + 解析（图片 OCR / PDF 文字层 → parseDocText）----
  // 返回草稿所需字段 + 分类信息；结果一律经 mergeOcrIntoDraft 并入（只写 OCR 轨）。
  const runRecognition = async (f) => {
    const isImage = (f.type || '').startsWith('image/')
    let rawText = ''
    let pageCount = 1
    let isScanned = false
    let ocrStatus = '' // '' 有文字层(直接提取) | 'ok' OCR成功 | 'failed' OCR失败

    if (isImage) {
      // 图片：无文字层，直接 OCR 识别
      isScanned = true
      // 路由分流阶段（App 预检）已跑过一次 OCR 的，复用其全文，避免二次识别
      const preText = getPendingText(pendingToken, pendingIndex)
      if (preText) {
        rawText = preText
        ocrStatus = 'ok'
      } else {
        try {
          rawText = await ocrImageToText(await fileToDataUrl(f))
          ocrStatus = 'ok'
        } catch (ocrErr) {
          console.warn('图片 OCR 失败，降级为手动填写：', ocrErr)
          ocrStatus = 'failed'
        }
      }
    } else {
      const { text, isScanned: scanned, pageCount: pc } = await extractDocContent(f)
      pageCount = pc
      isScanned = scanned
      if (scanned) {
        // 扫描件 PDF：无文字层 → 提取内嵌图再 OCR
        try {
          rawText = await ocrScannedPdfToText(f)
          ocrStatus = 'ok'
        } catch (ocrErr) {
          console.warn('扫描件 OCR 失败，降级为手动填写：', ocrErr)
          ocrStatus = 'failed'
        }
      } else {
        rawText = text
      }
    }

    const parsed = parseDocText(rawText || '')
    const base = {
      is_scanned: isScanned,
      ocr_status: ocrStatus,
      page_count: pageCount,
      raw_text: cleanReportText(rawText),
      notes: '',
    }
    // 本地识别的字段值（三轨模型里的 OCR 轨）
    const ocrValues = {
      kind: parsed.kind,
      doc_type: parsed.doc_type,
      part: parsed.part || '',
      date: parsed.date,
      time: parsed.time,
      reported_at: parsed.reported_at || '',
      title: parsed.title || (f.name || '').replace(/\.(pdf|jpe?g|png|webp|gif)$/i, ''),
      findings: parsed.findings,
      conclusion: parsed.conclusion,
      measures: parsed.measures || [],
    }
    const kindInfo = detectReportKind({ fileName: f.name || '', text: rawText })
    return { base, ocrValues, parsed, kindInfo, rawText, isScanned, pageCount, ocrStatus, isImage }
  }

  // 接收文件：初次识别（本地）→ 填充草稿 → 必要时 AI 分类兜底
  const pickFile = async (f) => {
    if (!f) return
    // 页内上传没有 pendingToken：自登记一个，改判流向（改为病历文书 / 改为检验报告）时才不会丢原件
    if (!pendingToken) setSelfPendingFiles([f], 'doc')
    setFile(f)
    setDup(null)
    setSimilar(null)
    setFileSha('')
    setTaskInfo(null)
    setNoOriginal(false)
    // 原件哈希并行算（不阻塞识别）：算完写入 fileSha，查重 effect 会自动重跑并命中「同一份文件」。
    fileFingerprint(f)
      .then((h) => setFileSha(h || ''))
      .catch(() => {})
    setError('')
    setNotice('')
    setAiResult(null)
    setAiState('idle')
    setAiError('')
    setAiElapsed(0)
    setClassifyState(null)
    setOcrState('running')
    setOcrElapsed(0)
    ocrT0Ref.current = Date.now()
    if (ocrTimerRef.current) clearInterval(ocrTimerRef.current)
    ocrTimerRef.current = setInterval(() => setOcrElapsed(Date.now() - ocrT0Ref.current), 1000)
    setStatus('extracting')
    try {
      const { base, ocrValues, kindInfo, rawText, isImage, isScanned } = await runRecognition(f)
      setForm((prev) => {
        // 换文件时不要带上上一份的轨元数据
        const fresh = prev && prev.__file === f.name ? prev : {}
        const next = mergeOcrIntoDraft({ ...fresh, ...base, ...ocrValues }, ocrValues)
        next.__file = f.name
        return next
      })
      setKindInfo(kindInfo)
      setOcrState('done')
      // 读取方式提示：真文字层 PDF 走文本整理（不读图，约省一半时间）
      const mode = docReadModeFor({ isImage, isScanned, textLen: (rawText || '').length })
      setReadModeNote(mode === 'doc-text' ? '该 PDF 有文字层，AI 走文本整理（不读图，更快）' : '')
      // 「其他检查」不再**自动**发 AI 判类型（2026-10-18）：
      // 一份认不出的报告过去会先跑一次 classify agent、用户再点「AI 识别」又跑一次，白烧一次会话；
      // 而 v2 的 AI 精读本身就会回 kind/doc_type（结果以 AI 为准，合并时会修正类型）。
      // 故降级为手动按钮：只有用户确实需要「判类型并据此切换导入页」时才发。
      setStatus('editing')
    } catch (e) {
      console.error(e)
      setError('解析失败：' + (e.message || String(e)))
      setOcrState('failed')
      setStatus('idle')
    } finally {
      if (ocrTimerRef.current) clearInterval(ocrTimerRef.current)
    }
  }

  // 重新识别（本地轨）：对同一份原件重跑本地识别，结果只更新 OCR 轨 / 归 OCR 管的字段
  const startReRecognize = async () => {
    if (!file) return
    setRecoLoading(true)
    setError('')
    setOcrState('running')
    const t0 = Date.now()
    setOcrElapsed(0)
    if (ocrTimerRef.current) clearInterval(ocrTimerRef.current)
    ocrTimerRef.current = setInterval(() => setOcrElapsed(Date.now() - t0), 1000)
    try {
      const { base, ocrValues, kindInfo, rawText, isScanned } = await runRecognition(file)
      setForm((f) => mergeOcrIntoDraft({ ...f, ...base }, ocrValues))
      setKindInfo(kindInfo)
      setOcrState('done')
      setNotice('本地识别已重跑（AI 轨结果不受影响）')
      const mode = docReadModeFor({ isImage: (file.type || '').startsWith('image/'), isScanned, textLen: (rawText || '').length })
      setReadModeNote(mode === 'doc-text' ? '该 PDF 有文字层，AI 走文本整理（不读图，更快）' : '')
    } catch (e) {
      console.error('重新识别失败', e)
      setError('重新识别失败：' + (e.message || String(e)))
      setOcrState('failed')
    } finally {
      setRecoLoading(false)
      if (ocrTimerRef.current) clearInterval(ocrTimerRef.current)
    }
  }

  // ---- AI 精读轨（权威轨）：提交 → 轮询 → 并入草稿 ----
  const runAiRead = async () => {
    if (!file || !form) return
    // 隐私同意门（与化验单多引擎同口径）
    if (!hasCloudConsent('ai')) {
      consentCbRef.current = runAiRead
      setConsentAsk('ai')
      return
    }
    const id = `docread-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const isImage = (file.type || '').startsWith('image/')
    const mode = docReadModeFor({ isImage, isScanned: !!form.is_scanned, textLen: (form.raw_text || '').length })
    setAiMode(mode)
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
      let stitchedNote = ''
      if (mode === 'doc') {
        const r = await docImageForAi(file)
        image = r.dataUrl
        stitchedNote = r.note || ''
      }
      upsertTask({
        id,
        kind: 'doc',
        state: 'running',
        mode,
        fileName: file.name,
        docType: form.doc_type || '',
        startedAt: new Date(t0).toISOString(),
        note: stitchedNote,
        reviewed: false,
      })
      // 溯源锚：提交时就把原件字节哈希交给服务端，任务与归档从此按 sha 对齐（不再只能靠文件名）
      const sha = fileSha || (await fileFingerprint(file).catch(() => ''))
      // 原件本体也存进 blob（内容寻址去重，同一份字节只落一份）：任务因此**链接得到源文件**，
      // 而不只是一个上传时的文件名（doc-text 的 PDF 也终于有原件可打开）。
      const blobId = await saveDocFile(file).catch(() => '')
      const posted = await postDocRead({
        id,
        mode,
        image,
        text: form.raw_text || '',
        reportType: form.doc_type || '',
        fileName: file.name,
        sha256: sha,
        origin: 'import',
        blobId,
      })
      if (posted && posted.skipped) {
        setAiState('skipped')
        setAiBlocked('AI 链路已关闭（顶栏「AI 反馈」面板可切回 oneshot / off）')
        patchTask(id, { state: 'skipped' })
        return
      }
      if (!posted || !posted.persisted) {
        setAiState('failed')
        setAiError('AI 服务未连接（需 pnpm run dev:full 起 8008）')
        patchTask(id, { state: 'failed', error: 'server-unreachable' })
        return
      }
      // 前台只等 2 分钟：实测慢任务（骨穿双列表 / 流式图版）的 agent 可能跑几十分钟，
      // 让用户在页面上干等 5 分钟没有意义。超时**不再判「失败」**，而是转后台继续轮询——
      // 页面立刻还给用户（可先核对/保存本地识别结果），AI 晚到就在原页面自动并入草稿；
      // 关掉页面也会留在「AI 任务」里可重连（2026-10-21 观测：3 份图版报告 agent 用时 4300–5000s）。
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
        setAiState('rate_limited')
        setAiError(done.message || 'AI 接口限流中')
        return
      }
      if (done.state === 'timeout') {
        // 后台也等满了（30 分钟）：仍不判失败，明确让用户去 AI 任务看
        setAiState('background')
        setAiError('AI 仍在后台精读，超过 30 分钟未回；可到「AI 任务」查看或重试')
        return
      }
      if (done.state === 'failed' || (done.status && done.status !== 'done')) {
        setAiState('failed')
        setAiError('AI 精读失败（agent 未能读出内容）')
        return
      }
      // 并入草稿：AI 为权威轨，手改字段除外，空值不清空（见 docAi.js 规则 2/3）
      const elapsed = Date.now() - t0
      setForm((f) => {
        const merged = mergeAiIntoDraft(f, done)
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

  // 取消等待（agent 可能仍在后台跑完；结果会进 AI 任务）
  const cancelAiWait = () => {
    if (aiAbortRef.current) aiAbortRef.current.abort()
    if (aiTimerRef.current) clearInterval(aiTimerRef.current)
    setAiState('idle')
    setAiElapsed(0)
  }

  // 字段编辑：任何手动输入都把该字段锁定为「已手改」轨
  const onEditField = (field, value) => {
    setForm((f) => markUserEdit({ ...f, [field]: value }, field))
  }
  const onSwitchTrack = (field, track) => {
    setForm((f) => switchTrack(f, field, track))
  }

  // 「其他检查」AI 读图兜底：规则层认不出时让 AI 判类型；判出是化验类报告（含骨髓形态学）
  // 只把「改为检验报告」建议点亮，不自动跳页（2026-10-21 拍板：判型是建议，导航由用户点）。
  // 骨髓形态学归「检验」而不是就地落成检查报告——业务上它是检验科细胞学检验（2026-10-21 定稿），
  // 双列分类表只有化验通道能结构化入库（字典 BONE_MARROW_MORPHOLOGY 26 项）。
  const runDocAiClassify = async (f, rawText) => {
    const id = `doc-ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    try {
      const dataUrl = await fileToDataUrl(f)
      setClassifyState('running')
      const posted = await postAiClassify({ id, image: dataUrl, text: rawText, points: [] })
      if (posted && posted.skipped) {
        setClassifyState('skipped')
        return
      }
      const result = await pollDocAi(id)
      const rt = result && (result.report_type || result.reportType)
      const name = (result && (result.title || result.report_name)) || rt || ''
      if (rt && !/^(UNKNOWN|GENERIC)/i.test(rt)) {
        setClassifyState({
          done: true,
          reportType: rt,
          reportName: rt === 'BONE_MARROW_MORPHOLOGY' ? '骨髓形态学（涂片分类）' : name,
          suggestsLab: true,
        })
      } else {
        setClassifyState('failed')
      }
    } catch {
      setClassifyState('failed')
    }
  }

  const pollDocAi = (id) =>
    new Promise((resolve) => {
      let n = 0
      const t = setInterval(async () => {
        n += 1
        try {
          const s = await fetchClassifyStatus(id)
          if (s.state === 'done') {
            clearInterval(t)
            resolve(s)
            return
          }
          if (s.state === 'failed' || s.state === 'rate_limited') {
            clearInterval(t)
            resolve(null)
            return
          }
        } catch {}
        if (n > 50) {
          clearInterval(t)
          resolve(null)
        }
      }, 3000)
    })

  const save = async (force = false) => {
    if (!form) return
    if (!file && !taskInfo) return // 既没原件也不是从任务恢复的草稿：没有可存的东西
    if (!form.date) {
      setError('请填写检查日期')
      return
    }
    // 无原件（doc-text 任务 / 副本已清）：仍允许归档，只是标 no_file，之后可在详情页补传原件。
    // 为什么不干脆禁止：AI 已经读出了完整字段，拦住用户等于让这次识别白跑（用户的原始抱怨）。
    const fileName = (file && file.name) || (taskInfo && taskInfo.fileName) || ''
    // 原件哈希：有文件就现算；无文件时用任务请求里带的 sha256（新版任务才有，老任务为空）
    const sha = file ? fileSha || (await fileFingerprint(file)) || '' : fileSha || ''
    const dup = findDuplicateDoc({
      date: form.date,
      doc_type: form.doc_type,
      file_name: fileName,
      file_sha256: sha,
    })
    if (dup) {
      const viaHash = !!sha && dup.file && dup.file.sha256 === sha
      setError(
        `当前文件（${fileName}）与已归档记录（${dup.date} · ${dup.doc_type} · ${dup.file && dup.file.name ? dup.file.name : ''}）重复，已禁止保存` +
          (viaHash ? '（原件字节完全相同，确为同一份文件）' : '') +
          '，请跳过此文件或修改日期/类型'
      )
      return
    }
    // 跨实体同源（软闸）：已存在同原件的化验记录。不硬拦，但要用户显式确认一次
    if (cross && !force) {
      setError('该原件已作为化验记录存在，请先在黄色卡片里确认「仍然归档」或取消')
      return
    }
    setStatus('saving')
    try {
      const docId = `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const fileId = file ? await saveDocFile(file) : null
      // 提取全文体积较大，单独存 IndexedDB（texts store），localStorage 只保留轻量索引
      if (form.raw_text) await saveDocText(docId, form.raw_text)
      addDoc({
        id: docId,
        kind: form.kind,
        doc_type: form.doc_type,
        part: form.part || '',
        date: form.date,
        time: form.time,
        reported_at: form.reported_at || '',
        title: form.title,
        findings: form.findings,
        conclusion: form.conclusion,
        measures: form.measures,
        notes: form.notes,
        has_text: !!form.raw_text,
        is_scanned: !!form.is_scanned,
        page_count: form.page_count,
        // 识别元数据（含 AI 轨来源与置信度），供列表徽章 / 详情页审计；下划线元数据一律不入库
        ai: form._ai
          ? {
              engine: 'ai',
              mode: aiMode === 'doc-text' ? 'text' : 'vision',
              version: form._ai.version,
              at: form._ai.at,
              elapsed_ms: form._ai.elapsedMs,
              confidence: form._ai.confidence,
              evidence_count: (form._ai.evidence || []).length,
              task_id: form._ai.id,
            }
          : { engine: 'ocr', at: new Date().toISOString() },
        // 无原件归档（no_file）：详情页据此提示「可补传原件」，不显示"原件丢失"的警报
        no_file: !file,
        file: file
          ? {
              id: fileId,
              name: file.name,
              size: file.size,
              mime: file.type || 'application/pdf',
              // 原件 SHA-256：归档查重的主通道（同一份文件 → 字节必然一致，不受 OCR 读数抖动影响）
              sha256: sha,
            }
          : null,
      })
      // 标记该 AI 任务已被核对采用（任务中心据此从「待核对」移除），并回写服务端：
      // 任务侧记下 docId，任务中心才能「点任务直接打开归档」，换设备也不丢这条绑定。
      if (form._ai && form._ai.id) postTaskReview(form._ai.id, docId)
      // 检查报告归档即发 AI 复查（仅建议，用户确认才改）
      postOcrReview({
        type: 'doc',
        id: docId,
        docType: form.doc_type,
        date: form.date,
        findings: form.findings,
        conclusion: form.conclusion,
        measures: form.measures,
      })
      onSaved && onSaved()
      if (!file) {
        setNotice(`已归档（无原件：${fileName || '任务未留存原图'}）；可在该报告详情页补传原件，补传后自动参与字节级查重`)
        setTimeout(() => setNotice(''), 8000)
      }
      // 从 AI 任务回来的草稿存完后**直接落到该条记录详情**：用户刚核对的这份东西在哪，
      // 应该马上看得见（回列表还得自己再找一遍）。批量与普通导入仍走原来的回跳逻辑。
      if (taskInfo && !isBatch && onOpenDoc) onOpenDoc(docId)
      else advance()
    } catch (e) {
      console.error(e)
      setError('保存失败：' + (e.message || String(e)))
      setStatus('editing')
    }
  }

  // AI 判出这是病历文书（出院记录 / 诊断证明）时给一键改判入口
  const aiSaysCase = aiResult && aiResult.category === 'case' && onSwitchFlow
  const switchTo = (flow) => {
    userDecidedRef.current = true
    // 改判只换页面、不换这份原件：目标页必须能从缓存里取到**同一份文件**，否则切过去就是空白上传态。
    // 从 AI 任务恢复的草稿（?task=）文件是现场从任务里拉的，从没登记进缓存 —— 必须现登记（2026-10-27 mlz7n）。
    const slot = ensurePendingSlot({
      token: pendingToken,
      index: pendingIndex,
      file,
      text: (form && form.raw_text) || '',
    })
    // AI 已读出的字段随文件一起交给文书录入（否则切过去只剩规则解析，诊断/入院日期会被漏抽）
    if (flow === 'case' && aiResult) setPendingAi(slot.token, slot.index, aiResult)
    // 没有原件（doc-text 任务 / 原件副本已清）时文件带不过去，改带任务 id：目标页用 loadFromTask 接住已完成结果
    onSwitchFlow(flow, { token: slot.token, index: slot.index, taskId: slot.token ? '' : (taskInfo && taskInfo.id) || '' })
  }

  const ocrFieldCount = form
    ? DOC_TRACK_FIELDS.filter(([f]) => {
        const v = (form._tracks && form._tracks.ocr && form._tracks.ocr[f]) !== undefined ? form._tracks.ocr[f] : form[f]
        return String(v === undefined || v === null ? '' : v).trim() !== ''
      }).length
    : 0

  return (
    <div className="space-y-4">
      <div className="card overflow-hidden flex flex-col">
        {/* 头部 */}
        <div className="px-6 py-4 bg-slate-900 text-white">
          <div className="flex items-center gap-4">
            <BackButton onClick={onClose} tone="dark" title={isBatch ? '退出批量' : '返回'} testId="doc-import-back" />
            <div className="min-w-0">
              <h2 className="font-semibold">{isBatch ? `批量归档（${curIndex}/${curTotal}）` : '添加检查报告'}</h2>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                {isBatch && file ? `当前文件：${file.name}` : '原件 PDF 完整保存本地 · 先本地识别出草稿，再可让 AI 精读'}
              </p>
            </div>
            {file && (
              <div className="flex items-center gap-2 shrink-0 ml-auto">
                {kindInfo && kindInfo.kind !== 'unknown' && (() => {
                  // 与当前页（检查报告）不一致时高亮：判型只是建议，不接管导航
                  const mismatch = kindInfo.kind === 'lab' || kindInfo.kind === 'case'
                  const label = kindInfo.kind === 'lab' ? '检验报告' : kindInfo.kind === 'case' ? '病历文书' : '检查报告'
                  return (
                    <span
                      className={
                        mismatch
                          ? 'text-[11px] px-2 py-1 rounded border border-amber-300/60 bg-amber-400/20 text-amber-100 font-medium'
                          : 'text-[11px] px-2 py-1 rounded border border-white/25 bg-white/10 text-slate-200'
                      }
                      title={`${kindInfo.reason || ''}${mismatch ? '｜建议改用右侧入口重新导入（原件与已识别内容会一并带过去）' : ''}`}
                    >
                      识别为{label}
                    </span>
                  )
                })()}
                {onSwitchFlow && (
                  <>
                    <Button
                      size="small"
                      onClick={() => switchTo('case')}
                      className="!bg-slate-700 !border-slate-600 !text-white"
                      title="这份是出院记录 / 诊断证明，改为走病历文书录入"
                    >
                      改为病历文书
                    </Button>
                    <Button
                      size="small"
                      onClick={() => switchTo('lab')}
                      className={
                        classifyState && classifyState.suggestsLab
                          ? '!bg-amber-400 !border-amber-300 !text-slate-900'
                          : '!bg-slate-700 !border-slate-600 !text-white'
                      }
                      title={
                        classifyState && classifyState.suggestsLab
                          ? `AI 认为这是检验报告${classifyState.reportName ? `（${classifyState.reportName}）` : ''}，点击改走检验报告导入`
                          : '这份是化验单，改为走检验报告导入'
                      }
                    >
                      改为检验报告
                    </Button>
                  </>
                )}
                {isBatch && (
                  <Button size="small" onClick={advance} className="!bg-slate-700 !border-slate-600 !text-white">
                    跳过，下一份 →
                  </Button>
                )}
              </div>
            )}
          </div>
          {isBatch && (
            <div className="h-0.5 bg-slate-700 mt-3">
              <div className="h-full bg-brand-500 transition-all" style={{ width: `${(curIndex / curTotal) * 100}%` }} />
            </div>
          )}
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          {/* 上传区 */}
          {status === 'idle' && (
            <div>
              {notice && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg px-4 py-3 mb-4">
                  {notice}
                </div>
              )}
              <div
                className="border-2 border-dashed border-slate-200 rounded-xl p-10 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50/30 transition-colors"
                onClick={() => fileRef.current && fileRef.current.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  handleFiles(e.dataTransfer.files)
                }}
              >
                <input ref={fileRef} type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
                <p className="text-sm text-slate-600 font-medium">点击或拖拽 PDF / 图片到此处</p>
                <p className="text-xs text-slate-400 mt-1">支持多文件批量：拖入多份将逐个核查 · 心电图、超声、CT、磁共振、X线等</p>
                <p className="text-xs text-slate-400 mt-2">
                  上传后先本地识别出草稿（图片约 30 秒）；不用等它——识别中就能点「AI 识别」，结果以 AI 为准。
                </p>
              </div>
            </div>
          )}

          {status === 'extracting' && (
            <div className="text-center py-12">
              <div className="inline-block w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm text-slate-600">正在本地识别报告内容（图片 OCR / PDF 文字层）…</p>
              <p className="text-xs text-slate-400 mt-1">{file ? file.name : ''}</p>
            </div>
          )}

          {error && status !== 'saving' && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}

          {/* 核对编辑区 */}
          {status === 'editing' && form && (
            <div className="space-y-4">
              {/* 分隔流提示（沿用既有通道） */}
              {/* 规则层认不出类型时的手动逃生口（不再自动发，避免与 AI 精读重复烧一次会话） */}
              {(form.kind === 'other' || form.doc_type === '其他检查') && !(classifyState && classifyState.done) && (
                <div className="bg-slate-50 border border-slate-200 text-slate-600 text-xs rounded-lg px-4 py-2.5 flex items-center gap-3 flex-wrap">
                  <span>规则层没认出这份报告的类型。可以直接点上方「AI 识别」（会顺带修正类型），也可以只判类型：</span>
                  <Button
                    size="small"
                    data-testid="doc-ai-classify"
                    loading={classifyState === 'running'}
                    onClick={() => file && runDocAiClassify(file, (form && form.raw_text) || '')}
                  >
                    AI 判类型
                  </Button>
                </div>
              )}
              {classifyState === 'running' && (
                <div className="bg-brand-50 border border-brand-200 text-brand-800 text-sm rounded-lg px-4 py-3 flex items-center gap-2">
                  <span className="inline-block w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                  正在用 AI 判定报告类型…
                </div>
              )}
              {classifyState && classifyState.done && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg px-4 py-3">
                  AI 识别为：<b>{classifyState.reportName}</b>
                  {classifyState.reportType === 'BONE_MARROW_MORPHOLOGY' ? '（已就地落成骨髓形态类别）' : '（这是检验报告，正在切换到检验报告导入…）'}
                </div>
              )}
              {classifyState === 'failed' && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3">
                  AI 未能判定报告类型，可在下方「报告类别 / 报告类型」手动选择。
                </div>
              )}
              {aiSaysCase && (
                <div className="bg-sky-50 border border-sky-200 text-sky-800 text-sm rounded-lg px-4 py-3 flex items-center gap-3">
                  <span>AI 判定这份更像病历文书（出院记录 / 诊断证明）。</span>
                  <Button size="small" onClick={() => switchTo('case')}>
                    改为病历文书
                  </Button>
                </div>
              )}

              {/* 从 AI 任务恢复的草稿：明示来源，避免"这数据哪来的" */}
              {taskInfo && (
                <div className="bg-sky-50 border border-sky-200 text-sky-800 text-sm rounded-lg px-4 py-3" data-testid="doc-from-task">
                  <div className="font-semibold mb-1">本草稿来自 AI 任务 {shortId(taskInfo.id)}</div>
                  <p className="text-xs">
                    源文件 {taskInfo.fileName}
                    {taskInfo.requestedAt ? ` · 提交于 ${fmtStamp(taskInfo.requestedAt)}` : ''}
                    　结果已完成，本次没有再读图、也没有再产生费用。核对后直接保存即可。
                  </p>
                  {noOriginal && (
                    <p className="text-xs mt-1 text-amber-700">
                      该任务没有留存原图（PDF 文字层任务按设计不落图，或副本已被清理）。仍可归档为本报告的「无原件」记录，
                      之后在详情页补传原件即可；补传后会自动参与字节级查重。
                    </p>
                  )}
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
                          content: '会连同原图与识别产物一起永久删除（不可恢复）。已归档的报告不受影响。',
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

              {/* 实时重复检测 */}
              {dup && (
                <div className="bg-amber-50 border border-amber-300 text-amber-800 text-sm rounded-lg px-4 py-3">
                  <div className="font-semibold mb-1">疑似重复归档</div>
                  <p>
                    当前文件 <b>{(file && file.name) || (taskInfo && taskInfo.fileName) || ''}</b>（{form.date || '未填日期'} ·{' '}
                    {form.doc_type || '未填类型'}）与已归档记录{' '}
                    <b>
                      {dup.date} · {dup.doc_type} · {dup.file && dup.file.name}
                    </b>
                    {/* 命中原因必须如实说：字节通道命中时三项其实可能各异（AI 措辞、导入时文件被改名） */}
                    {fileSha && dup.file && String(dup.file.sha256 || '') === fileSha
                      ? ' 是同一份文件（原件字节完全相同）。'
                      : ' 三项相同（检查日期 / 报告类型 / 文件名）。'}
                  </p>
                  <p className="text-xs mt-1 text-amber-700">
                    保存将被禁止。请确认是否为同一份报告误重复拖入；若确为不同报告，请修改日期 / 类型或改用不同文件名后保存。
                  </p>
                </div>
              )}
              {/* 日期自检（护栏）：报告时间早于检查日期是不可能组合，任何报告上都必须当场显形 */}
              {form && dateAnomaly(form) && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-2" data-testid="doc-date-anomaly">
                  {dateAnomaly(form)}
                </div>
              )}

              {/* 软查重：同日同类型 / 文本几乎一致 —— 不拦保存，但必须让用户看见 */}
              {/* 跨实体同源（软闸）：同一份原件已有化验记录。只提示 + 需显式确认 */}
              {cross && (
                <div className="bg-amber-50 border border-amber-300 text-amber-800 text-sm rounded-lg px-4 py-3">
                  <div className="font-semibold mb-1">该原件已作为化验记录存在</div>
                  <p>
                    已有：<b>{describeHit(cross)}</b>
                  </p>
                  <p className="text-xs mt-1 text-amber-700">
                    原件字节完全相同（sha256 {String(cross.sha || '').slice(0, 8)}…）。继续归档会得到「化验记录 + 检查报告」两条同一份报告；
                    若这份报告只需要保留一条，建议去记录页处理，别在这里归档。
                  </p>
                  <button
                    type="button"
                    className="text-xs underline text-amber-800 hover:text-amber-900 mt-1"
                    onClick={() => save(true)}
                  >
                    仍然归档（已确认同源）
                  </button>
                </div>
              )}

              {similar && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3" data-testid="doc-similar">
                  <div className="font-semibold mb-1">
                    {similar.reason === 'same-text'
                      ? '疑似同一份报告（结论文本逐字相同）'
                      : similar.reason === 'similar-text'
                        ? `疑似同一份报告（内容相似度 ${Math.round((similar.score || 0) * 100)}%）`
                        : '同日已有一份同类报告'}
                  </div>
                  <p>
                    已归档：
                    <b>
                      {similar.doc.date} · {similar.doc.doc_type}
                      {similar.doc.title ? ` · ${similar.doc.title}` : ''}
                    </b>
                    {similar.doc.file && similar.doc.file.name ? `（原件 ${similar.doc.file.name}）` : '（无原件）'}
                  </p>
                  <p className="text-xs mt-1 text-amber-700">
                    {similar.reason === 'same-text' || similar.reason === 'similar-text'
                      ? '两份内容高度一致，基本可断定是同一份报告。确认重复就别保存，直接返回（草稿可丢弃）。'
                      : '日期与报告类型相同但文件名不同（例如从 AI 任务恢复的草稿没有原件名）。同一天做两项同类检查是可能的，请自行确认是否重复。'}
                  </p>
                  <button
                    type="button"
                    className="text-xs underline text-amber-800 hover:text-amber-900 mt-1"
                    title="新标签打开，当前这份草稿不会被丢掉"
                    onClick={() => {
                      // 必须新标签：同标签跳转会把眼前这份还没保存的草稿（纯内存）直接扔掉，
                      // 用户只是"想去看一眼像不像"，不该付这个代价。
                      const url = `${window.location.origin}${window.location.pathname}#/reports?tab=doc&open=${encodeURIComponent(similar.doc.id)}`
                      window.open(url, '_blank', 'noopener')
                    }}
                  >
                    新标签打开这条已归档记录对比
                  </button>
                </div>
              )}

              {form.ocr_status === 'failed' && form.is_scanned && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3">
                  本地识别未成功（无文字层且 OCR 失败）。原件仍会完整保存——可点上方「AI 识别」读原件转录，或手动填写。
                </div>
              )}

              {/* 双轨状态条：本地识别（先行） + AI 精读（权威轨） */}
              <DocAiStatusBar
                ocrState={ocrState}
                ocrElapsedMs={ocrElapsed}
                ocrFieldCount={ocrFieldCount}
                ocrLabel={form.is_scanned ? '本地识别（OCR）' : '本地识别（PDF 文字层）'}
                aiState={aiState}
                aiElapsedMs={aiElapsed}
                aiResult={aiResult}
                aiError={aiError}
                aiBlockedReason={aiBlocked}
                readModeNote={readModeNote}
                onRun={runAiRead}
                onCancel={cancelAiWait}
                onReRecognize={startReRecognize}
                recoLoading={recoLoading}
              />

              {/* 两轨差异汇总：差异不是错误，而是「这里值得多看一眼」的路标 */}
              {diffs.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800" data-testid="doc-diff-bar">
                  <span className="font-medium">{diffs.length} 个字段两轨不同</span>
                  <span className="text-amber-700">（当前生效轨：{form._track && form._track[diffs[0].field] === 'ocr' ? '本地识别' : 'AI 精读'}）</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {diffs.map((d) => (
                      <a
                        key={d.field}
                        href={`#doc-field-${d.field}`}
                        className="rounded border border-amber-300 bg-white/70 px-1.5 py-0.5 hover:bg-white"
                        title={d.aiMissing ? 'AI 未读出该字段，当前保留的是本地识别值' : '点击跳到该字段并切换轨道对照'}
                      >
                        {d.label}
                        {d.aiMissing ? '（AI 未读出）' : ''}
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* 左右分栏：原件 ↔ 字段 */}
              <div className="grid gap-4 lg:grid-cols-[minmax(320px,1fr)_minmax(360px,1fr)]">
                <DocSourceViewer file={file} className="rounded-lg border border-slate-200 min-h-[420px] lg:max-h-[70vh]" />
                <DocAiReviewPanel
                  form={form}
                  ai={aiResult ? { ...aiResult, elapsedMs: aiElapsed } : null}
                  onEdit={onEditField}
                  onSwitch={onSwitchTrack}
                  className="rounded-lg border border-slate-200 lg:max-h-[70vh]"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                <p className="text-xs text-slate-400">
                  {file ? (
                    <>
                      原件：<span className="text-slate-600">{file.name}</span>（{(file.size / 1024).toFixed(1)} KB）
                    </>
                  ) : (
                    <>无原件（{noOriginal ? '该任务未留存原图' : '未选择文件'}）· 可归档为无原件，之后补传</>
                  )}
                </p>
                <div className="flex gap-2">
                  {!isExternalBatch && (
                    <Button
                      onClick={() => {
                        setStatus('idle')
                        setForm(null)
                        setDup(null)
                        setError('')
                        setNotice('')
                        setQueue(null)
                        setAiState('idle')
                        setAiResult(null)
                        setOcrState('idle')
                        if (fileRef.current) fileRef.current.value = ''
                      }}
                    >
                      重新选择
                    </Button>
                  )}
                  <Button
                    type="primary"
                    onClick={save}
                    loading={status === 'saving'}
                    title={noOriginal ? '无原件也可归档（标为无原件，之后可补传）' : ''}
                    data-testid="doc-save"
                  >
                    {isBatch ? `保存并继续（${curIndex}/${curTotal}）` : '保存归档（原件 + 索引）'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 云端/AI 隐私同意门（与化验单多引擎同口径） */}
      {consentAsk && (
        <CloudConsentModal
          engine={consentAsk}
          onClose={() => {
            setConsentAsk(null)
            consentCbRef.current = null
          }}
          onOk={() => {
            setConsentAsk(null)
            const cb = consentCbRef.current
            consentCbRef.current = null
            if (cb) cb()
          }}
        />
      )}
    </div>
  )
}
