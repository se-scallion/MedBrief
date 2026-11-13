// ===================== 极简导入流程（上传 → 自动 OCR → 核对保存，免裁剪） =====================

import { useCallback, useEffect, useRef, useState } from 'react'
import ImageUploader, {
  downscaleImage,
  toPdfDataUrl,
  compressImageDataUrl,
  legacyArchiveHash,
} from './ImageUploader.jsx'
import { saveRecordImage } from '../utils/docFileStore.js'
import DataGrid from './DataGrid.jsx'
import RecognizeIssues from './RecognizeIssues.jsx'
import BackButton from './BackButton.jsx'
import { MOCK_OCR_GRID } from '../data/mockOcr.js'
import { runOCRWithRetry, pdfFirstPageToDataUrl } from '../utils/ocr.js'
import { normalizeGridToPoints, inferReportType, computeStatus, collectRecognizeIssues } from '../utils/normalize.js'
import { addRecord, findDuplicateRecord, findCrossEntitySource, writeRecord, getCustomFields } from '../data/store.js'
import { describeHit } from '../utils/dupScan.js'
import { makeTraceId, emitTrace, rowTraceId } from '../utils/trace.js'
import { buildFeedback, postFeedback } from '../utils/feedback.js'
import { pushOp, getOps, clearOps } from '../utils/oplog.js'
import { fileFingerprint, dataUrlFingerprint } from '../utils/fileHash.js'
import { peekFiles, getFileName, setSelfPendingFiles, getLastSelfToken, ensurePendingSlot } from '../utils/pendingImport.js'
import { detectReportKind, textFromGrid } from '../utils/reportKind.js'
import { correctMedicalText, extractReportTitle } from '../utils/reportTitle.js'
import { reRecognizeRecordWithGrid, fuseEngineResults } from '../utils/reRecognize.js'
import { recognizeWithEngine, ENGINES } from '../utils/ocrEngines.js'
import { composeReportText } from '../utils/flowNotes.js'
import { useEngineHealth, pickEngineAfterFailure } from '../utils/engineStatus.js'
import EngineSelect from './EngineSelect.jsx'
import { markNewItems, persistNewItems } from '../utils/customFieldManager.js'
import { collectGaps, buildDraftPatch } from '../utils/gapDraft.js'
import ReRecognizeRecordModal from './ReRecognizeRecordModal.jsx'
import NewItemsPanel from './NewItemsPanel.jsx'
import CloudConsentModal, { hasCloudConsent } from './CloudConsentModal.jsx'
import { fetchTaskBundle, fetchTaskImage, postTaskReview } from '../utils/docTasks.js'
import { shortId, fmtStamp, MODE_CN } from '../utils/taskMeta.js'
import { rowsToGrid, narrativeFromDone } from '../utils/agentRows.js'

const today = () => new Date().toISOString().slice(0, 10)
// date 一律留空：绝不用「今天」兜底——历史上多次出现「报告日期被静默填成导入当天」，
// 用户毫无察觉直接保存，导致时间轴错乱。识别不到就留空 + 黄条提示，由用户手选（save() 也会拦）。
const emptyDraft = () => ({ date: '', time: '', reported_date: '', reported_time: '', report_type: 'CBC_hsCRP', data_points: [], notes: '', report_text: '', report_text_edited: false })

// 标准化后补全状态判定，核对页打开即有高亮
function withStatus(points) {
  return points.map((p) => ({
    ...p,
    status: computeStatus(p.standard_code, p.value, p.ref_range, p.arrow, p.unit),
  }))
}

const PHASES = [
  { id: 'upload', num: 1, label: '上传文件' },
  { id: 'ocr', num: 2, label: '选择引擎识别' },
  { id: 'review', num: 3, label: '核对保存' },
]

// 页面化导入流程：由路由页 /records/add 渲染（顶栏导航随时可点，点了即离开本页）。
// pendingToken / pendingIndex：本次待导入文件在 pendingImport 缓存中的位置（支持批量逐份）；
// onSwitchFlow(kind)：仅在**用户点击**判型提示旁的按钮时调用（2026-10-21 起因判型不再自动跳页）；
// taskId：从「AI 任务」点「继续导入」回来的化验转录任务 id（?task=），挂载即用 done 的 rows 复原草稿。
export default function ImportFlow({
  onClose,
  onSaved,
  pendingToken,
  pendingIndex = 0,
  batchTotal = 0,
  onAdvance,
  onSwitchFlow,
  taskId = '',
}) {
  const [phase, setPhase] = useState('upload') // upload | ocr | review
  const [image, setImage] = useState(null)
  const [preview, setPreview] = useState(null)
  const [ocrError, setOcrError] = useState('')
  const [mockMode, setMockMode] = useState(false)
  const [autoDate, setAutoDate] = useState('')
  const [autoTime, setAutoTime] = useState('')
  const [autoReportedAt, setAutoReportedAt] = useState('')
  // 识别诊断统一出口 issues[]（日期 + grid 静默失败信号）：必须暴露给用户核对，绝不静默按今天落库。
  // 来源 ocr.js extractReportDate 的 issues + normalize.js collectRecognizeIssues。
  const [recognizeIssues, setRecognizeIssues] = useState([])
  const [dupWarn, setDupWarn] = useState(null) // 识别后自动查重命中的重复记录（保存前拦截）
  // 跨实体同源（软闸）：同一份原件已作为「检查报告」归档过 —— 只提示不硬拦（硬拦会挡死
  // 「老检查报告口径 → 新化验记录口径」的合法迁移，2026-09-03 骨髓 / 2026-08-20 流式就是这么来的）
  const [crossWarn, setCrossWarn] = useState(null) // { kind, item, sha }
  const [crossAck, setCrossAck] = useState(false) // 用户在黄条里显式确认过同源
  const [draft, setDraft] = useState(emptyDraft)
  const [traceId, setTraceId] = useState('') // 本次识别的 Trace ID（用于日志回查）
  const [originalPoints, setOriginalPoints] = useState([]) // 识别基线：识别后、编辑前的原始 points，供反馈 diff 对比
  const [ocrLoop, setOcrLoop] = useState(null) // 「识别-审计-重识别」闭环诊断：{retried, qualityScore, confidence, attempts}
  const [ocrElapsed, setOcrElapsed] = useState(0) // 识别进行中的已用秒数（动态计时，基于真实时间差）
  // AI 精读慢任务提示：这类报告单次 agent 可能跑几十分钟，2 分钟后明确告诉用户"还在读、别以为卡死"
  const [ocrSlowNote, setOcrSlowNote] = useState('')
  const [ocrDuration, setOcrDuration] = useState(null) // 本次识别总耗时（秒，识别完成后固定）
  const ocrT0Ref = useRef(0) // 识别计时起点（Date.now），动态计时与完成结算同源，保证显示不跳变
  const [discoveredTypes, setDiscoveredTypes] = useState([]) // 本次自动发现的新类型（只读审计视图）
  // 保存被拦（如「空指标」）时的行内提示，避免按钮点了没反应被当成坏了
  const [saveHint, setSaveHint] = useState('')
  // 重新识别（草稿态）：同一张图再跑一次 OCR，先看「旧 vs 新」差异再决定采用哪些指标
  const [recoLoading, setRecoLoading] = useState(false)
  const [fuseBusy, setFuseBusy] = useState(null) // 融合进行态：{ engine } | null
  // 待确认新项的人工改动（以识别出的**原名**为键）：面板改了名称/代码后上抛到这里，
  // 保存时作为 overrides 传给 persistNewItems —— 否则"面板改过、提交时又按老名字重算"。
  const [newItemOverrides, setNewItemOverrides] = useState({})
  const setNewItemOverride = (origName, patch) => {
    setNewItemOverrides((o) => ({ ...o, [origName]: patch === undefined ? undefined : { ...(o[origName] || {}), ...patch } }))
  }
  const [recoResult, setRecoResult] = useState(null)
  // 识别引擎（多引擎）：默认本地离线；非本地引擎走 recognizeWithEngine（理解层仍共用）
  // startOcr 是空依赖 useCallback，读 state 会拿到旧值 → 用 ref 同步（同 fileMetaRef 先例）
  const [ocrEngine, setOcrEngine] = useState('local')
  const ocrEngineRef = useRef('local')
  const selectEngine = (e) => {
    ocrEngineRef.current = e
    setOcrEngine(e)
  }
  // 引擎可用性（离线服务是否已启动）：下拉选项直接带「启动中…／服务未启动」提示
  const { health: engineHealth, healthRef: engineHealthRef } = useEngineHealth()
  // 识别失败后把引擎下拉切到「另一个可用引擎」：用户点重试才是换个引擎再试，
  // 而不是原样重试同一个刚失败的引擎（服务没起来，原样重试必然再失败一次）
  const [switchedFromEngine, setSwitchedFromEngine] = useState('') // 本次失败被换掉的引擎（提示文案用）
  const failoverEngine = (failed) => {
    const next = pickEngineAfterFailure(failed, engineHealthRef.current)
    if (next && next !== failed) {
      selectEngine(next)
      setSwitchedFromEngine(failed)
    }
    return next
  }
  // 云端引擎隐私确认（首次使用）：同意后经回调继续
  const [consentAsk, setConsentAsk] = useState(null)
  const consentCbRef = useRef(null)
  const askCloudConsentOr = (engine, run) => {
    if ((engine === 'mineru' || engine === 'ai') && !hasCloudConsent(engine)) {
      consentCbRef.current = run
      setConsentAsk({ engine })
      return false
    }
    return true
  }
  // 本次文件的指纹 { hash(SHA-256), name, size }：用于精确查重（同一文件重复导入 100% 命中）
  const [fileMeta, setFileMeta] = useState(null)
  // startOcr 是空依赖 useCallback（避免重建导致上传组件重渲染），闭包拿不到最新 fileMeta，
  // 故用 ref 同步一份，供识别完成时的查重读取。
  const fileMetaRef = useRef(null)
  const applyFileMeta = useCallback((meta) => {
    fileMetaRef.current = meta
    setFileMeta(meta)
  }, [])
  // 存档图哈希（image_hash）：与历史记录库存的 900px 存档图同口径压缩后取 SHA-256。
  // 意义：老记录无 file_hash 且原文件不可得，只有这一路能让「新导入 vs 老记录」精确命中。
  const [imageHash, setImageHash] = useState('')
  const imageHashRef = useRef('')
  // 存档压缩图与哈希同源算一次并复用：保证入库的 image 与 image_hash 严格对应
  const archivedRef = useRef(null)
  const applyImageHash = useCallback((hash) => {
    imageHashRef.current = hash
    setImageHash(hash)
  }, [])
  // 报告大类判定结果（检验报告 / 检查报告）：识别完成后用于展示与自动分流
  const [kindInfo, setKindInfo] = useState(null)
  // 用户已手动改判过 → 不再自动切换流程，避免两个页面来回抖动
  // 当前文件名（供报告大类判定使用；startOcr 是空依赖 useCallback，读不到最新 state）
  const fileNameRef = useRef('')
  // 从 AI 任务恢复的草稿来源（id/文件名/提交时间/是否留存原件）：有值就显示来源横幅
  const [taskInfo, setTaskInfo] = useState(null)

  // 顶栏「添加数据」拖放直达 / 批量队列当前份：挂载即处理，少点一次
  // StrictMode 下本 effect 会「setup → cleanup → setup」双跑，导致同一文件被 processFile
  // 两次、触发两次并发 OCR（慢的一次还会静默覆盖网格）。用 ref 去重，一次挂载只识别一次。
  const processedRef = useRef(false)

  // ===== 从 AI 任务恢复化验草稿（?task=<id>）=====
  // 与检查报告页 DocImportFlow::loadFromTask 同一思路，但产物口径不同：那边是「所见/结论」文本字段，
  // 这边是**指标表格 rows=[名称,结果,参考,单位]**（mode:'lab'，见 scripts/agent-task.mjs）。
  // 不做这层时，化验任务点「继续导入」会落到检查报告页 → 只认 title/findings/conclusion →
  // 横幅写着"结果已完成"而网格全空（2026-10-28 #ruyd81 用户现场：点进去什么都是空的）。
  const loadFromTask = useCallback(
    async (tid) => {
      setOcrError('')
      setSaveHint('')
      const bundle = await fetchTaskBundle(tid)
      if (!bundle) {
        setOcrError('任务读取失败：服务端不可达（需 8008 在跑）')
        return
      }
      if (bundle.state !== 'done') {
        setOcrError(
          bundle.state === 'failed'
            ? '该任务上次没有读出结果，可在「AI 任务」里点「重试」'
            : '该任务仍在读图；完成后在「AI 任务」里点「继续导入」即可回到这里'
        )
        return
      }
      const done = bundle.done || {}
      const req = bundle.request || {}
      // 产物口径不符（检查报告 mode:doc / 病历文书）→ 明说，别让用户对着空白网格发愣
      if (req.mode && req.mode !== 'lab') {
        setOcrError(`这条任务是「${MODE_CN[req.mode] || req.mode}」，不是化验转录，结果里没有指标表格；请在「AI 任务」里重新点「继续导入」`)
        return
      }
      // 原文件名原样保留：它参与归档查重键（date+report_type+file_name），改名会让查重失效
      const fileName = req.fileName || `task-${tid}.jpg`
      fileNameRef.current = fileName
      // 原件（服务端留存的原图 / PDF）→ File，走与页内上传同一条指纹与存档链路（查重通道不能少）
      let file = null
      if (req.hasFile !== false && (req.hasFile || req.hasImage)) {
        const blob = await fetchTaskImage(tid)
        if (blob && blob.size) file = new File([blob], fileName, { type: blob.type || 'image/jpeg' })
      }
      if (file) {
        const isImage = /^image\//.test(file.type)
        try {
          applyFileMeta({
            hash: await fileFingerprint(file),
            legacyHash: isImage ? await legacyArchiveHash(file) : '',
            original_id: await saveRecordImage(file),
            name: file.name,
            size: file.size,
          })
          const dataUrl = isImage ? await downscaleImage(file) : await toPdfDataUrl(file)
          setImage(dataUrl)
          const pv = isImage ? dataUrl : await pdfFirstPageToDataUrl(dataUrl).catch(() => '')
          setPreview(pv || '')
          if (pv) {
            const archived = await compressImageDataUrl(pv)
            archivedRef.current = archived
            applyImageHash(await dataUrlFingerprint(archived))
          }
        } catch (e) {
          // 原件读不回来不影响指标核对（仍可无原件归档），只失去查重通道
          console.warn('[AI 任务] 原件读取失败：', e)
        }
      }
      // rows → grid → points：表头归一与 AI 引擎现场识别共用一份规则（utils/agentRows.js）
      const grid = rowsToGrid(done.rows)
      const points = withStatus(markNewItems(normalizeGridToPoints(grid), getCustomFields()))
      const narrative = narrativeFromDone(done)
      const inference = inferReportType(points, (grid || []).flat().join(' '))
      setDiscoveredTypes(inference.discovered || [])
      setMockMode(false)
      setOriginalPoints(points) // 反馈基线：AI 结果即"编辑前"基线
      setRecognizeIssues(collectRecognizeIssues(points))
      setAutoDate('') // 任务产物不带采集时间；日期一律留空由用户手选（绝不用今天兜底）
      setAutoTime('')
      setAutoReportedAt('')
      setOcrDuration(null)
      setOcrLoop(null)
      setDraft((d) => ({
        ...d,
        data_points: points,
        report_type: inference.code,
        // 流式图文报告（C 类口径）的正文由 agent 的 narrative 拼装；没有就留空
        report_text: composeReportText(narrative) || '',
        report_text_edited: false,
      }))
      // 与页内识别同口径：识别完成即自动查重（文件哈希 → 内容指纹 → 模糊）
      setDupWarn(
        findDuplicateRecord({
          date: today(),
          report_type: inference.code,
          data_points: points,
          file_hash: fileMetaRef.current ? fileMetaRef.current.hash : '',
          image_hash: imageHashRef.current,
          image_hash_legacy: fileMetaRef.current ? fileMetaRef.current.legacyHash || '' : '',
        })
      )
      setCrossWarn(findCrossEntitySource({ file_sha256: fileMetaRef.current ? fileMetaRef.current.hash : '' }, { wantKind: 'doc' }))
      setTaskInfo({ id: tid, fileName, requestedAt: req.requestedAt || '', noOriginal: !file })
      setPhase('review')
    },
    [applyFileMeta, applyImageHash]
  )

  // 带 ?task= 进入：挂载即恢复（refguard 保证 StrictMode 双跑也只拉一次）
  const taskLoadedRef = useRef('')
  useEffect(() => {
    if (!taskId || taskLoadedRef.current === taskId) return
    taskLoadedRef.current = taskId
    loadFromTask(taskId)
  }, [taskId, loadFromTask])

  useEffect(() => {
    if (processedRef.current) return
    const file = peekFiles(pendingToken)[pendingIndex]
    if (file) {
      processedRef.current = true
      fileNameRef.current = file.name || ''
      processFile(file)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 识别计时：进入 ocr 阶段后按真实时间差刷新（基于 Date.now，避免定时器被
  // worker 密集任务节流后显示落后于真实耗时，与完成结算同源不跳变）
  useEffect(() => {
    if (phase !== 'ocr') return
    const timer = setInterval(() => {
      setOcrElapsed(Math.max(0, Math.round((Date.now() - ocrT0Ref.current) / 1000)))
    }, 500)
    return () => clearInterval(timer)
  }, [phase])



  // forcedEngine：调用方强制指定引擎（拖拽导入固定传 'local'）；未传则读引擎下拉（ocrEngineRef）
  const startOcr = useCallback(async (dataUrl, forcedEngine) => {
    clearOps() // 新一次识别 = 一段新的操作记录
    setPhase('ocr')
    setOcrError('')
    setSwitchedFromEngine('') // 新一次识别：清掉上一轮的「已换引擎」提示
    const t0 = Date.now() // 识别计时起点
    ocrT0Ref.current = t0
    setOcrElapsed(0)
    setOcrDuration(null)
    const engine = forcedEngine || ocrEngineRef.current || 'local'
    console.log('[OCR][DBG] startOcr 开始，dataUrl 长度=', dataUrl.length, '引擎=', engine)
    try {
      // 引擎执行段：local 走现有全链路（含日期/类型推断/质量徽章）；
      // 非 local 走 recognizeWithEngine（产物已过 normalize 理解层），缺 items/date/auditSummary
      // 时由下方后处理段自然降级（标题推断弱化、日期保持默认、质量徽章隐藏）。
      let grid = []
      let mock = false
      let date = ''
      let time = ''
      let collectedAt = ''
      let reportedAt = ''
      let auditSummary = null
      let ocrAttempts = []
      let retried = false
      let ocrItems = []
      let ocrIssues = []
      let ocrDateSource = ''
      let engineRes = null
      // 流式图文报告的正文（印象/结论）：本地通道来自 OCR 文本切段，AI 通道来自 agent 的 narrative 字段
      let narrative = null
      if (engine === 'local') {
        ;({ grid, mock, date, time, collectedAt, reportedAt, auditSummary, ocrAttempts, retried, items: ocrItems, issues: ocrIssues = [], dateSource: ocrDateSource, narrative } =
          await runOCRWithRetry(dataUrl))
      } else {
        setOcrSlowNote('')
        engineRes = await recognizeWithEngine(engine, dataUrl, {
          id: `import-${Date.now().toString(36)}`,
          fileName: fileNameRef.current || '',
          origin: 'lab',
          onSlow: (sec) =>
            setOcrSlowNote(`AI 精读较慢（已 ${sec} 秒）——这类表格/图版报告通常要几分钟到几十分钟；仍在读，出结果会自动填入下方校对网格`),
        })
        grid = (engineRes && engineRes.rawMeta && engineRes.rawMeta.grid) || []
        narrative = (engineRes && engineRes.rawMeta && engineRes.rawMeta.narrative) || null
      }
      console.log('[OCR][DBG] startOcr 成功，总耗时=', ((Date.now() - t0) / 1000).toFixed(1), 's，grid 行数=', (grid && grid.length) || 0)
      setMockMode(!!mock)
      const points = withStatus(markNewItems(engineRes ? engineRes.points : normalizeGridToPoints(grid), getCustomFields()))
      setOriginalPoints(points) // 反馈基线：编辑前的原始识别结果
      // 识别诊断统一出口：grid 静默失败信号（未映射/跳号/可疑值/多信号纠正/低置信度）+ 日期事件合并
      const gridIssues = collectRecognizeIssues(points)
      const allIssues = [...gridIssues, ...(ocrIssues || [])]
      setRecognizeIssues(allIssues)
      // OCR 识别出的采集时间+报告时间均记录；日期优先采集、其次报告，未识别则保持默认今天
      setAutoDate(date || '')
      setAutoTime(time || '')
      setAutoReportedAt(reportedAt || '')
      const repTime = reportedAt && reportedAt.includes(' ') ? reportedAt.slice(reportedAt.lastIndexOf(' ') + 1) : ''
      // 目录驱动推断：返回类型 code + 本次自动发现的新类型（只读审计）
      // 关键：grid 只含表格行，报告标题（如「骨髓细胞形态检查图文报告」）进不了 grid，
      // 故必须拼接 OCR 全量词项文本（items 含标题词），否则标题特征匹配永远失效、
      // 只能靠乱码项集签名 → 误判成凝血功能。normalizeText 会去空白，词级拼接可还原连续中文。
      // OCR 形近字纠错（医疗报告标题专用）：tesseract 对这类字体常把「骨髓」误识为「骨通」、
      // 「检验科」误识为「检验和」。在标题文本上做保守归一，避免标题/类型被乱码带偏。
      const ocrFullText = (ocrItems || []).map((it) => correctMedicalText(it.text || '')).join(' ')
      // 从 OCR 词项提取并纠正报告标题（兜底，不依赖外部 AI）：取含标题特征
      // （医院/检验/骨髓/图文报告/细胞形态…）的词项，按 y 排序拼接后做形近字纠正。
      const ocrTitle = extractReportTitle(ocrItems)
      const titleText = [ocrFullText, (grid || []).flat().join(' ')].filter(Boolean).join(' ')
      const inference = inferReportType(points, titleText)
      setDiscoveredTypes(inference.discovered || [])
      // 报告类型一律采用规则层推断结果（含兜底的 UNKNOWN/其他），由用户在下拉框手动改判。
      // 2026-09-10：原「AI 读图判定类型/标题」链路已整体删除——用户定稿「太慢，我自己选类型」。
      const effectiveReportType = inference.code
      setDraft((d) => ({
        ...d,
        date: date || d.date,
        time: time || d.time,
        reported_time: repTime || d.reported_time,
        // 报告日期独立于采集日期（跨日出报告）：识别到就填，用户可改
        reported_date: (reportedAt && reportedAt.slice(0, 10)) || d.reported_date,
        data_points: points,
        // 传入全文（含未映射项目名）供标题特征识别，避免新类型报告兜底误判
        report_type: effectiveReportType,
        // OCR 提取并纠正后的标题（本地兜底，不依赖外部 AI）
        report_title: ocrTitle || '',
        // 流式图文报告：把「抬头/所检测抗原/印象/结论/注」存进独立只读字段 report_text。
        // 为什么不写进 notes：备注是用户手写语义、且会随导出与 Prompt 提供给 AI（DataGrid 标签明写）；
        // 机器全文塞进去会与手写内容混排、无法区分。身份/重复信息已在抽取层排除（见 flowNotes.js 头注）。
        // 用户手动改过（report_text_edited）→ 识别结果不覆盖人工修改
        report_text: d.report_text_edited ? d.report_text : composeReportText(narrative) || d.report_text,
      }))
      // 操作记录：识别结果概览（后续所有校对动作都挂在这条之后）
      pushOp('ocr-done', { items: points.length, type: effectiveReportType, durationMs: Date.now() - t0 })
      setOcrLoop(auditSummary ? { retried: !!retried, qualityScore: auditSummary.qualityScore, confidence: auditSummary.confidence, attempts: ocrAttempts || [] } : null)
      // 报告大类判定：只作**建议**，不决定导航（2026-10-21 用户拍板「入口即声明」）。
      // 曾经这里在 kind=doc/case 且 confidence!=='low' 时**静默跳页**——用户在检验页导入、
      // 识别完被甩到检查页，且 confidence='low' 时又完全不提示（难样本=扫描件/骨穿图文反而
      // 最需要提示）。现改为：一律停在当前页，由页头「识别为 X」提示条高亮 + 一键切换。
      // text 必须包含完整 OCR 全文本（ocrFullText）：标题/模态词（心电图、超声、CT 等）
      // 可能不进表格 grid（grid 只含表格行），只用 grid 文本判定会把骨髓图文报告/
      // 心电图等漏判成 lab（实测复现）。ocrFullText 已做 correctMedicalText 纠正，
      // reportKind 内部再做 fixOcrVariants（骨通→骨髓）双保险。
      const kind = detectReportKind({
        fileName: fileNameRef.current,
        text: [ocrFullText, textFromGrid(grid)].filter(Boolean).join(' '),
        points,
      })
      setKindInfo(kind)
      setPhase('review')
      // 结算识别耗时（含重试轮次）
      setOcrDuration((Date.now() - t0) / 1000)
      // 生成 Trace ID 并落盘识别日志（供后续把 ID 发给 AI 回查原始识别数据）
      const tid = makeTraceId()
      setTraceId(tid)
      emitTrace(tid, {
        // 识别来源标注引擎：local 维持既有 'ocr'，其余记引擎名（vision/mineru/ai），便于 Trace 回查
        source: mock ? 'mock' : engine === 'local' ? 'ocr' : engine,
        recognizedAt: new Date().toISOString(),
        durationMs: Date.now() - t0, // 识别总耗时
        rawGrid: grid, // 原始 OCR 网格（含未映射行）
        collectedAt: collectedAt || date || '',
        reportedAt: reportedAt || '',
        // 识别诊断留痕（日期 + grid 静默失败信号）：供 Trace ID 回查——「日期被静默兜底成今天」
        // 这类问题必须可追溯，不能只靠肉眼发现。
        dateSource: ocrDateSource || '',
        recognizeIssues: allIssues,
        reportType: effectiveReportType,
        // 入口声明的流向（本页固定 lab）vs 内容判型：留痕用于量化
        // 「入口声明错」还是「规则判型错」哪个更常见（2026-10-21 起入口显式化）
        declaredFlow: 'lab',
        kindDetected: kind.kind,
        kindConfidence: kind.confidence,
        kindReason: kind.reason,
        // 「识别-审计-重识别」闭环诊断信息：供把 Trace ID 发给 AI 后回查各轮识别质量
        ocrLoop: {
          retried: !!retried,
          qualityScore: auditSummary?.qualityScore,
          confidence: auditSummary?.confidence,
          attempts: ocrAttempts || [],
        },
        // raw items 全量留存（A 方案）：OCR token 的文本 + 像素坐标。
        // 为什么必须存：算法升级若动了解析层（双栏/聚类/切格），事后重算必须能
        // 从**同一批 token** 重建 grid（buildGridFromItems），否则只能重跑 OCR。
        // 有了它，"导入一次 == 优化后再导入"才成立（见设计稿附录 F/J）。
        items: (ocrItems || []).map((it) => ({ text: it.text || '', x: it.x, y: it.y, w: it.w })),
        points: points.map((p, i) => ({ row: i, ...p })),
        // 识别缺口草稿（零隔离版第 2 步）：未映射且名称可读的项达到阈值时，
        // 连同可直接粘贴的补丁草稿一起落进 trace，供设置页「待处理缺口」一键取用。
        // 只提议、不落盘：草稿里的 code 是占位符，必须人改后再应用。
        gapDraft: (() => {
          const g = collectGaps(points)
          if (!g.meetsThreshold) return null
          return {
            count: g.count,
            items: g.items,
            readableRatio: Number(g.readableRatio.toFixed(3)),
            draft: buildDraftPatch(g, { reportType: effectiveReportType, traceId: tid }),
          }
        })(),
      })
      // 识别完成即自动查重：文件哈希（原文件 + 存档图）→ 内容指纹 → 模糊匹配，任一命中即提示
      // 哈希取 ref（startOcr 为空依赖 useCallback，读 state 会拿到旧值）
      const cand = {
        date: date || today(),
        report_type: effectiveReportType,
        data_points: points,
        file_hash: fileMetaRef.current ? fileMetaRef.current.hash : '',
        image_hash: imageHashRef.current,
        image_hash_legacy: fileMetaRef.current ? fileMetaRef.current.legacyHash || '' : '',
      }
      setDupWarn(findDuplicateRecord(cand))
      // 跨实体同源：同一份原件是否已作为「检查报告」归档过（只认原文件字节域）
      setCrossWarn(findCrossEntitySource({ file_sha256: cand.file_hash }, { wantKind: 'doc' }))
    } catch (e) {
      console.log('[OCR][DBG] startOcr 失败/超时，总耗时=', ((Date.now() - t0) / 1000).toFixed(1), 's，错误=', e && e.message)
      setOcrError(e.message || 'OCR 识别失败')
      setOcrDuration((Date.now() - t0) / 1000)
      setDraft((d) => ({ ...d, data_points: [] }))
      setPhase('review')
      // 失败后默认换引擎：下拉切到另一个可用引擎，重试才是「换引擎重试」而不是原样再来
      failoverEngine(engine)
    }
  }, [])

  // ===== 草稿换引擎重跑（六入口 ④）：直接用所选引擎重跑并原地替换草稿指标 =====
  // 与详情页（已入库）不同：草稿未入库、用户随时可改，无需「旧 vs 新」对比弹窗防护，
  // 这是用户明确要的快路径——选引擎、点一下、直接出新结果。
  const rerunDraftWithEngine = async () => {
    if (!image) return
    const engine = ocrEngineRef.current || 'local'
    const go = async () => {
      setRecoLoading(true)
      setOcrError('')
      setSwitchedFromEngine('') // 新一轮换引擎：清掉上一轮提示（防劣化/降级提示时误显示）
      try {
        if (engine === 'local') {
          await startOcr(image) // 本地走原全链路（日期/类型推断/查重/trace 一致）
          return
        }
        setOcrSlowNote('')
        const res = await recognizeWithEngine(engine, image, {
          id: `draft-${Date.now().toString(36)}`,
          fileName: fileNameRef.current || '',
          origin: 'lab',
          onSlow: (sec) => setOcrSlowNote(`AI 精读较慢（已 ${sec} 秒）——仍在读，出结果会自动填入下方校对网格`),
        })
        // 与主识别路径同口径打新项标记：否则「换引擎重跑」得到的字典未知项永远不会进待确认面板
        const pts = withStatus(markNewItems(res.points || [], getCustomFields()))
        const prev = (draft.data_points || []).length
        // 防劣化：新引擎结果明显少于当前草稿（<50%）时**保留原草稿**并提示——
        // 实测 macOS Vision 对紧凑化验表会把整块数据读成一个文本块（只能切出 1 项且值串行），
        // 静默替换会让「换引擎」越换越差。这类图请换 MinerU 云端（评测第一）或本地识别。
        if (prev > 0 && pts.length < prev * 0.5) {
          setOcrError(
            `${ENGINES[engine]?.label || engine} 本次只解析出 ${pts.length} 项（当前 ${prev} 项），` +
              '该图表格可能是紧凑排列、被整块读出，已保留原结果；建议改用 MinerU 云端或本地离线识别。',
          )
          return
        }
        if (res.rawMeta && (res.rawMeta.degraded || res.rawMeta.glued)) {
          setOcrError('提示：该图存在倾斜或表格行粘连，本引擎结果可能不完整，可换 MinerU 云端对比。')
        }
        setOriginalPoints(pts) // 反馈基线：换引擎后的结果即新基线
        setRecognizeIssues(collectRecognizeIssues(pts))
        setDraft((d) => ({ ...d, data_points: pts }))
        setOcrDuration(Number(((res.elapsedMs || 0) / 1000).toFixed(1)))
        pushOp('ocr-done', { items: pts.length, type: draft.report_type, engine, durationMs: res.elapsedMs || 0 })
      } catch (e) {
        console.error('草稿换引擎识别失败', e)
        setOcrError(String((e && e.message) || e)) // 失败不丢当前草稿
        failoverEngine(engine) // 换引擎也失败 → 下拉默认切到另一个可用引擎
      } finally {
        setRecoLoading(false)
      }
    }
    if (!askCloudConsentOr(engine, go)) return
    go()
  }

  // ===== 草稿多引擎融合补漏（六入口 ⑤）：其余引擎全跑，缺失补入、冲突并入草稿 =====
  const startDraftFuse = () => {
    const needConsent = ['mineru', 'ai'].some((e) => !hasCloudConsent(e))
    if (needConsent) {
      consentCbRef.current = () => runDraftFuse()
      setConsentAsk({ engine: 'mineru' })
      return
    }
    runDraftFuse()
  }

  const runDraftFuse = async () => {
    if (!image) return
    const base = draft.data_points || []
    setRecoLoading(true)
    setOcrError('')
    try {
      const results = [{ engine: 'local', nextPoints: base }] // 以当前草稿为基准
      for (const eng of ['vision', 'mineru', 'ai']) {
        setFuseBusy({ engine: eng })
        try {
          const res = await recognizeWithEngine(eng, image, {
            id: `fuse-${eng}-${Date.now().toString(36)}`,
            fileName: fileNameRef.current || '',
            origin: 'lab',
          })
          results.push({ engine: eng, nextPoints: res.points || [] })
        } catch (e) {
          console.warn(`融合：${eng} 引擎跳过`, e && e.message)
        }
      }
      const fused = fuseEngineResults({ id: 'draft', date: draft.date, data_points: base }, results)
      if (fused) {
        // 融合结果同样要过一遍新项标记（与主路径一致），否则融合出来的未知项不被提示
        const pts = withStatus(markNewItems(fused.nextPoints, getCustomFields()))
        setOriginalPoints(pts)
        setDraft((d) => ({ ...d, data_points: pts }))
        setRecognizeIssues(collectRecognizeIssues(pts))
      }
    } catch (e) {
      console.error('草稿多引擎融合失败', e)
      setOcrError(String((e && e.message) || e))
    } finally {
      setFuseBusy(null)
      setRecoLoading(false)
    }
  }

  // 重新识别：对同一张图再跑一次 OCR，并与初次识别同口径重跑「类型/标题/时间」推断，
  // 与当前草稿做「旧 vs 新」对比（草稿态，落库仍等用户点保存）。
  const startReRecognize = async () => {
    if (!image) return
    setRecoLoading(true)
    try {
      const { grid, date, time, reportedAt, items } = await runOCRWithRetry(image)
      setRecoResult(
        reRecognizeRecordWithGrid(
          { grid, items, date, time, reportedAt },
          {
            id: 'draft',
            date: draft.date,
            data_points: draft.data_points,
            report_type: draft.report_type,
            report_title: draft.report_title,
            time: draft.time,
            reported_time: draft.reported_time,
          }
        )
      )
    } catch (e) {
      console.error('重新识别失败', e)
      setOcrError(e && e.message ? e.message : '重新识别失败')
    } finally {
      setRecoLoading(false)
    }
  }

  const applyReco = (patch) => {
    setDraft((d) => ({
      ...d,
      data_points: patch.data_points,
      date: patch.date || d.date,
      report_type: patch.report_type != null ? patch.report_type : d.report_type,
      report_title: patch.report_title != null ? patch.report_title : d.report_title,
      time: patch.time != null ? patch.time : d.time,
      reported_time: patch.reported_time != null ? patch.reported_time : d.reported_time,
    }))
    // 采用后的结果即新的「编辑基线」，后续反馈 diff 以它为参照
    setOriginalPoints(patch.data_points)
    setRecoResult(null)
  }

  const handleImage = useCallback(
    (dataUrl, mime, forcedEngine) => {
      setImage(dataUrl)
      const isPdf = mime === 'application/pdf' || /^data:application\/pdf/i.test(dataUrl)
      if (isPdf) setPreview('')
      else setPreview(dataUrl)
      startOcr(dataUrl, forcedEngine)
      // 存档图 + 其哈希：与历史记录 image（compressImageDataUrl 900px/0.8）同口径，
      // 算一次并缓存，保存时直接复用（保证 image 与 image_hash 同源、严格对应）。
      // 异步几百毫秒，远早于 20s+ 的 OCR 结束，查重时必然已就绪。
      ;(async () => {
        try {
          const pv = isPdf ? await pdfFirstPageToDataUrl(dataUrl).catch(() => '') : dataUrl
          if (isPdf) setPreview(pv || '')
          if (!pv) return
          const archived = await compressImageDataUrl(pv)
          archivedRef.current = archived
          applyImageHash(await dataUrlFingerprint(archived))
        } catch {
          // 压缩/哈希失败不影响识别与保存，仅失去该通道，自动退到内容指纹
        }
      })()
    },
    [startOcr, applyImageHash]
  )



  // 外部文件（拖放到按钮直达）→ dataURL → 与上传组件同一识别链路
  const processFile = useCallback(
    async (file) => {
      if (!file) return
      const okImage = /^image\/(jpeg|png|webp)$/.test(file.type)
      const okPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
      if (!okImage && !okPdf) return
      // 页内上传（无 pendingToken，如点「添加数据」后在本页选文件）：登记进跨路由缓存，
      // 之后流程切换（识别为检查报告 → 切归档页）目标页才能拿到同一文件，不丢上传。
      if (!pendingToken) setSelfPendingFiles([file], 'lab')
      fileNameRef.current = file.name || ''
      // 文件指纹（SHA-256）：OCR 前算完，保证识别完成时哈希已就绪供精确查重
      // legacyHash：复现旧压缩链路，用于命中 08-27 前入库的老记录（PDF 无位图，跳过）
      applyFileMeta({
        hash: await fileFingerprint(file),
        legacyHash: okImage ? await legacyArchiveHash(file) : '',
        // 原图写入 IndexedDB（体积大，不进 localStorage），record 持 original_image_id
        original_id: await saveRecordImage(file),
        name: file.name,
        size: file.size,
      })
      const dataUrl = okImage ? await downscaleImage(file) : await toPdfDataUrl(file)
      // 拖放直达：固定本地离线识别（用户明确要求拖拽不经云端），引擎下拉不影响这条链路
      handleImage(dataUrl, okImage ? 'image/jpeg' : 'application/pdf', 'local')
    },
    [handleImage]
  )

  const loadDemo = () => {
    const points = withStatus(normalizeGridToPoints(MOCK_OCR_GRID))
    setOriginalPoints(points) // 反馈基线：演示数据的「原始识别结果」
    const inference = inferReportType(points, (MOCK_OCR_GRID || []).flat().join(' '))
    setDiscoveredTypes(inference.discovered || [])
    setDraft((d) => ({ ...d, data_points: points, report_type: inference.code }))
    setOcrError('')
    setMockMode(true)
    setAutoDate('')
    setRecognizeIssues([])
    setAutoTime('')
    setAutoReportedAt('')
    setDupWarn(null)
    fileMetaRef.current = null
    setFileMeta(null) // 演示数据无原文件，不参与文件哈希查重
    imageHashRef.current = ''
    setImageHash('')
    archivedRef.current = null
    setPhase('review')
  }

  const resetAll = () => {
    setImage(null)
    setPreview(null)
    setOcrError('')
    setSaveHint('')
    setMockMode(false)
    fileMetaRef.current = null
    setFileMeta(null)
    imageHashRef.current = ''
    setImageHash('')
    archivedRef.current = null
    setAutoDate('')
    setRecognizeIssues([])
    setAutoTime('')
    setAutoReportedAt('')
    setDupWarn(null)
    setDraft(emptyDraft())
    setOriginalPoints([])
    setDiscoveredTypes([])
    setOcrElapsed(0)
    setOcrDuration(null)
    setPhase('upload')
  }

  // 核对数据变更后，由下方 useEffect 基于最新 draft 实时重算查重（与 save() 同一 buildRecord 口径）。
  // 不再「任意编辑即清空 dupWarn」：删噪声行/改值若仍命中任一通道（文件哈希/内容指纹/模糊），
  // 提示保持；仅当真正不再相似时才消失。修复原粗暴清空导致删行即误消重复判定的问题。
  const updateDraft = useCallback((patch) => {
    setSaveHint('') // 任一编辑都清掉上次保存被拦的提示，避免提示与当前状态不符
    setDraft((d) => ({ ...d, ...patch }))
  }, [])

  // 组装待保存记录
  const buildRecord = (image = '') => {
    // 剥离核对用临时字段 _row（识别顺序行号）、_item_no/_item_no_src（项目序号及其来源）、
    // _editSrc/_source（反馈来源标注），仅用于校对网格与反馈计算，不入库
    const points = draft.data_points
      .filter((p) => String(p.value).trim() !== '')
      .map(({ _row, _item_no, _item_no_src, _source, _abbr, ...rest }) => rest)
    const checkedAt = draft.time ? `${draft.date} ${draft.time}` : ''
    // 报告时间戳 = 报告日期（跨日时与采集日期不同；留空则回退采集日期）+ 报告时间
    const repDate = draft.reported_date || draft.date
    const reportedAt = draft.reported_time ? `${repDate} ${draft.reported_time}` : draft.reported_date || ''
    return {
      date: draft.date,
      checked_at: checkedAt,
      reported_at: reportedAt,
      report_type: draft.report_type,
      data_points: points,
      notes: draft.notes,
      report_text: draft.report_text || '', // 报告原文（机器转录，用户可编辑；不含患者身份信息）
      report_text_edited: !!draft.report_text_edited, // 用户是否手动改过（重识别不再覆盖）
      image, // 脱敏原图（压缩存档，详情查看用）
      file_hash: fileMeta ? fileMeta.hash : '', // 原文件 SHA-256，供后续精确查重（老数据为空，走内容指纹兜底）
      image_hash: imageHash, // 存档图 SHA-256：与老记录回填值同口径，覆盖「跨版本同一文件」查重
      image_hash_legacy: fileMeta ? fileMeta.legacyHash || '' : '', // 旧压缩链路归档图哈希（对齐 08-27 前老记录）
      original_image_id: fileMeta ? fileMeta.original_id || '' : '', // IndexedDB 原图引用（高清详情预览用；体积大不进 localStorage）
      // 本次识别的 Trace ID：入库后仍保留，使后续（对比弹窗/详情页）的修正反馈
      // 能回溯到 logs/ocr-<traceId>.json 的原始识别数据，形成完整可追溯闭环。
      // 历史记录（本字段上线前导入的）为空，反馈时按缺失处理，不影响信号本身。
      trace_id: traceId || '',
    }
  }

  // 实时查重：网格/日期/类型/备注任一变化都重算 dupWarn，与 save() 同一 buildRecord 口径。
  // 命中（文件哈希/内容指纹/模糊）任一通道即保持提示；仅真正不再相似才消失。
  // 跳过演示模式（演示数据无原文件，不应提示重复）与非核对阶段。
  useEffect(() => {
    if (mockMode || phase !== 'review') return
    const rec = buildRecord()
    setDupWarn(findDuplicateRecord(rec) || null)
    setCrossWarn(findCrossEntitySource({ file_sha256: rec.file_hash }, { wantKind: 'doc' }) || null)
  }, [draft, fileMeta, imageHash, mockMode, phase])

  const save = () => {
    // 日期为空必须显式提示：静默 return 会被当成「保存按钮坏了」。
    // 这是「报告日期被静默填成导入当天」的最后一道闸门——宁可拦下，也不让错日期落库。
    if (!draft.date) {
      setSaveHint('请先选择采集日期：本次未识别到报告日期，不能按今天保存')
      return
    }
    const points = draft.data_points.filter((p) => String(p.value).trim() !== '')
    // 空指标必须显式提示：静默 return 会被当成「保存按钮坏了」
    if (points.length === 0) {
      setSaveHint('至少录入 1 项指标才能保存；若只需存档图文原件，请点右上角「改为检查报告」')
      return
    }
    setSaveHint('')
    // 已提示重复（dupWarn 非空）：必须先由黄色卡片操作（覆盖 / 仍要新增 / 取消导入）。
    // 此处主保存按钮不再自动落盘，避免「点到确认即存两条」——这正是上一版"查重没生效"的观感来源。
    if (dupWarn) return
    // 跨实体同源（软闸）：不硬拦，但不让"点一下主按钮"就把重复存进去——必须先由黄条显式确认
    if (crossWarn && !crossAck) {
      setSaveHint('该原件已作为检查报告归档过，请先在黄色卡片里确认「仍然新增」或取消导入')
      return
    }
    // 数据被修改过：保存前重新查重
    const dup = findDuplicateRecord(buildRecord())
    if (dup) {
      setDupWarn(dup)
      return
    }
    commitSave()
  }

  const commitSave = async (overwriteId = null) => {
    const points = draft.data_points.filter((p) => String(p.value).trim() !== '')
    // 脱敏原图压缩到 900px 存档：详情查看用，控制 localStorage 体积。
    // 优先复用上传时已算好的那一份（与 image_hash 同源，保证两者严格对应）
    let savedImage = archivedRef.current || ''
    if (!savedImage && preview) {
      try {
        savedImage = await compressImageDataUrl(preview)
      } catch {
        savedImage = ''
      }
    }
    const record = buildRecord(savedImage)
    // 写入必须**回读校验**：2026-10-29 事故是「提示保存成功、库里没有这条记录」——
    // 覆盖目标可能已被删除 / 同步回滚（store.writeRecord 现在会回退新增并回报结果）。
    let writeRes
    if (overwriteId) {
      // 真正覆盖：保留已有记录 id，用本次识别结果替换内容（含新算的哈希）
      writeRes = writeRecord({ id: overwriteId, patch: record, source: 'import' })
    } else {
      const newId = addRecord(record)
      writeRes = { ok: !!newId, action: 'append', id: newId }
    }
    if (!writeRes || !writeRes.ok) {
      console.error('[MedData] 保存失败（记录未写入本地库）：', writeRes)
      setSaveHint('保存失败：记录没写进本地库（存储异常或目标记录已不存在）。请重试一次；若反复失败，请先「导出全部数据备份」再刷新页面。')
      return
    }
    if (writeRes.action === 'append' && overwriteId) {
      setSaveHint('原记录已不存在（可能已被删除或同步回滚），已按新记录保存，请到列表核对。')
    }
    // 从 AI 任务恢复的草稿存完 → 标记该任务已被核对采用（任务中心据此从「待核对」移除），
    // 并把任务绑到这条归档（任务侧记 recordId 后可「打开归档」；不写则任务永远挂在待核对）
    if (taskId) postTaskReview(taskId, writeRes.id || overwriteId || '')
    // 报告提交即落库本次识别出的「待确认新项」（用户口径：提交后持久化，下次复用）。
    // 仅 _isNew 项入库，已知项（有 standard_code）不重复入库。
    persistNewItems(draft.data_points, { autoConfirm: true, overrides: newItemOverrides }).then((persisted) => {
      if (persisted.length) console.log('[customField] 提交时落库新项：', persisted)
    })
    // 用户修正反馈：相对识别基线（识别后、编辑前）的字段级修改，自动落盘 + 入队供 AI 分析。
    // 仅用户修改过的字段进入 edits（真值信号），未修改字段不作反馈。异步 fire-and-forget，不阻塞保存。
    if (traceId && originalPoints.length) {
      pushOp('save', { items: points.length, overwrite: !!overwriteId })
      postFeedback(
        buildFeedback({
          baselinePoints: originalPoints,
          currentPoints: draft.data_points,
          traceId,
          reportType: draft.report_type,
          date: draft.date,
          image: savedImage, // 900px 脱敏压缩图，AI 拿到即可复现验证
          ops: getOps(), // 操作记录：本次校对会话的完整动作时序
        })
      ).then((r) => {
        if (!r.persisted) {
          console.warn(`[feedback] ${traceId} 未落盘，已暂存本地浏览器；服务恢复后自动补投，或点顶栏「反馈暂存」手动补投`)
        }
      })
    }
    onSaved(draft.date, points.length)
    if (onAdvance) {
      // 批量核查：保存后直接进入下一份
      onAdvance()
      return
    }
    onClose()
  }

  const stageIdx = PHASES.findIndex((p) => p.id === phase)
  const curFileName = getFileName(pendingToken, pendingIndex) || fileMeta?.name || ''

  // 改判流向：原件存在跨路由缓存里（页内上传时本页自登记了一个 token），必须把这块 token
  // 显式交给目标页 —— 否则目标页退回模块级「上一次自登记」槽，可能拿到别的批次的文件。
  const switchTo = (kind) => {
    if (!onSwitchFlow) return
    const slot = ensurePendingSlot({ token: pendingToken || getLastSelfToken(), index: pendingIndex })
    onSwitchFlow(kind, { token: slot.token, index: slot.index })
  }

  return (
    <div className="space-y-4">
        <div className="card overflow-hidden">
            {/* 头部 */}
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center gap-4">
              <BackButton onClick={onClose} tone="dark" title={batchTotal > 1 ? '退出批量' : '返回'} testId="lab-import-back" />
              <div className="min-w-0">
                <h2 className="font-semibold">
                  {batchTotal > 1 ? `批量添加（${pendingIndex + 1}/${batchTotal}）` : '添加化验数据'}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5 truncate">
                  {batchTotal > 1 && curFileName
                    ? `当前文件：${curFileName}`
                    : '上传 → 选择识别引擎 → 快速核对，无需手动裁剪；默认本地离线，可换 macOS Vision / MinerU 云端 / AI 精读'}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-auto">
                {/* 判型提示：与当前页（化验）不一致时高亮为琥珀色 —— 这是「建议」，不是导航。
                    需要用户自己点右边按钮才切，避免被静默带走（2026-10-21）。 */}
                {kindInfo && kindInfo.kind !== 'unknown' && (() => {
                  const mismatch = kindInfo.kind === 'doc' || kindInfo.kind === 'case'
                  const label = kindInfo.kind === 'doc' ? '检查报告' : kindInfo.kind === 'case' ? '病历文书' : '检验报告'
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
                {/* 改判入口**常驻**：判型只是建议，认不出（kind=unknown）时更要留逃生口——
                    难样本（扫描件 / 骨穿图文）恰恰是判型最不准的地方，不能因为"没判出来"就把
                    用户锁死在化验页（2026-10-21 复核修回）。 */}
                {onSwitchFlow && (
                  <button
                    className={
                      kindInfo?.kind === 'doc' || kindInfo?.kind === 'case'
                        ? 'btn-secondary !border-amber-300 !bg-amber-400 !text-slate-900 text-xs'
                        : 'btn-secondary !bg-slate-700 !border-slate-600 !text-white text-xs'
                    }
                    title={
                      kindInfo?.kind === 'case'
                        ? '这份看起来是出院记录 / 诊断证明，改走病历文书录入（原件与已识别内容一并带过去）'
                        : kindInfo?.kind === 'doc'
                        ? '这份看起来是影像 / 心电 / CT 类报告，改走检查报告导入（原件与已识别内容一并带过去）'
                        : '这份不是化验单？改走检查报告导入（原件与已识别内容一并带过去）'
                    }
                    onClick={() => switchTo(kindInfo?.kind === 'case' ? 'case' : 'doc')}
                  >
                    改为{kindInfo?.kind === 'case' ? '病历文书' : '检查报告'}
                  </button>
                )}
                {batchTotal > 1 && (
                  <button
                    className="btn-secondary !bg-slate-700 !border-slate-600 !text-white text-xs"
                    onClick={() => onAdvance && onAdvance()}
                  >
                    跳过，下一份 →
                  </button>
                )}
              </div>
            </div>
            {/* 批量进度条 */}
            {batchTotal > 1 && (
              <div className="h-0.5 bg-slate-700">
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{ width: `${(pendingIndex / batchTotal) * 100}%` }}
                />
              </div>
            )}

            {/* 阶段条 */}
            <div className="px-5 py-3 border-b border-slate-200 bg-slate-50/60 flex items-center gap-3 overflow-x-auto">
              {PHASES.map((p, i) => (
                <div key={p.id} className="flex items-center gap-2 shrink-0">
                  {i > 0 && <span className="w-6 h-px bg-slate-300" />}
                  <span
                    className={`flex items-center gap-1.5 text-xs font-medium ${
                      i <= stageIdx ? 'text-brand-700' : 'text-slate-400'
                    }`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        i < stageIdx
                          ? 'bg-brand-500 text-white'
                          : i === stageIdx
                            ? 'bg-brand-600 text-white'
                            : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {i < stageIdx ? '✓' : p.num}
                    </span>
                    {p.label}
                  </span>
                </div>
              ))}
              <span className="ml-auto text-[11px] text-slate-400 shrink-0 hidden sm:block">
                上传文件后按所选引擎识别，全程仅需确认一次
              </span>
            </div>

            <div className="p-5">
              {/* 从 AI 任务恢复的草稿：明示来源，避免"这数据哪来的"（与检查报告页同一条横幅口径） */}
              {taskInfo && (
                <div className="mb-3 bg-sky-50 border border-sky-200 text-sky-800 text-sm rounded-lg px-4 py-3" data-testid="lab-from-task">
                  <div className="font-semibold mb-1">本草稿来自 AI 任务 {shortId(taskInfo.id)}</div>
                  <p className="text-xs">
                    源文件 {taskInfo.fileName}
                    {taskInfo.requestedAt ? ` · 提交于 ${fmtStamp(taskInfo.requestedAt)}` : ''}
                    　结果已完成，本次没有再读图、也没有再产生费用。核对后直接保存即可。
                  </p>
                  {taskInfo.noOriginal && (
                    <p className="text-xs mt-1 text-amber-700">
                      该任务没有留存原图（PDF 文字层任务按设计不落图，或副本已被清理），仍可归档为无原件记录。
                    </p>
                  )}
                  <p className="text-xs mt-1">
                    <button
                      type="button"
                      className="underline text-sky-700 hover:text-sky-900"
                      onClick={() => onClose && onClose()}
                      title="草稿只存在于当前页面，返回即丢弃（不保存任何内容；任务结果仍留在「AI 任务」里，可再来）"
                    >
                      丢弃草稿并返回
                    </button>
                  </p>
                </div>
              )}
              {/* 识别引擎选择：**只在上传阶段出现一处**。
                  复核阶段卡片里已有「识别引擎 + 换引擎重跑」那一组，两处绑同一 state 会互相联动，
                  用户看到两个下拉却分不清该改哪个（2026-10-24 反馈）→ 这里只保留上传阶段这一处。 */}
              {phase === 'upload' && (
                <div className="mb-3 flex items-center gap-2 flex-wrap">
                  <label className="text-[11px] text-slate-500 font-medium shrink-0">识别引擎</label>
                  <EngineSelect value={ocrEngine} onChange={selectEngine} health={engineHealth} className="!py-1" />
                  <span className="text-[11px] text-slate-400">默认本地离线；拖文件到下方区域固定走本地识别</span>
                </div>
              )}

              {/* 阶段 1：上传（保持挂载以保留状态） */}
              <div className={phase === 'upload' ? '' : 'hidden'}>
                <ImageUploader
                  image={image}
                  onImage={handleImage}
                  onFileMeta={applyFileMeta}
                  onFile={(f) => {
                    // 页内上传（无 pendingToken，如点「添加数据」后在本页选文件）：登记进
                    // 跨路由缓存，之后流程切换（识别为检查报告 → 切归档页）目标页才能拿到
                    // 同一文件，不丢上传（pendingImport.getLastSelfToken 回退读取）。
                    if (f && !pendingToken) setSelfPendingFiles([f], 'lab')
                  }}
                />
              </div>

              {/* 阶段 2：OCR 进行中 */}
              {phase === 'ocr' && (
                <div className="py-20 text-center">
                  <div className="inline-block w-12 h-12 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin mb-4" />
                  <p className="text-sm font-medium text-slate-700">正在识别化验单表格…</p>
                  <p className="text-xs text-slate-400 mt-2">
                    本机离线识别 · 首次约需 20 秒以上 · 全程不超过 90 秒
                  </p>
                  <p className="text-xs text-brand-600 font-mono mt-3 tabular-nums">
                    ⏱ 已用 {ocrElapsed} 秒
                  </p>
                  {ocrSlowNote && (
                    <p className="mx-auto mt-3 max-w-lg rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      {ocrSlowNote}
                    </p>
                  )}
                </div>
              )}

              {/* 阶段 3：核对保存 */}
              {phase === 'review' && (
                <div className="space-y-4">
                  {saveHint && (
                    <div className="card p-3 bg-amber-50 border-amber-200">
                      <p className="text-xs font-medium text-amber-800">{saveHint}</p>
                    </div>
                  )}
                  {/* 原件缺口必须在保存前就提示：图没上传成功时，详情页只会显示「从来没有原件」（NONE），
                      与"本来就没传过"不可区分，用户会以为图丢了/本来就没有。用内存里的 fileMeta 判断即可，
                      不做 blob 读校验（避免每次保存多一次请求）。2026-10-29 记录丢失事故的护栏之一。 */}
                  {preview && !(fileMetaRef.current && fileMetaRef.current.original_id) ? (
                    <div className="card p-3 bg-amber-50 border-amber-200">
                      <p className="text-xs font-medium text-amber-800">
                        原件未上传成功：本条记录保存后不会有原图（详情页显示「缺原件」）。建议先删掉重导一次；若网络受限可先只存指标，之后在详情页补传原件。
                      </p>
                    </div>
                  ) : null}
                  {/* 识别诊断统一出口：日期 + grid 静默失败信号，必须暴露给用户核对 */}
                  <RecognizeIssues issues={recognizeIssues} />
                  {/* 待确认新项（AI 识别出的字典未知项），人工确认或提交时落库 */}
                  <NewItemsPanel
                    points={draft.data_points}
                    overrides={newItemOverrides}
                    onOverride={setNewItemOverride}
                    onConfirmed={(code, item) => console.log('[customField] 人工确认新项：', code, item && item.name)}
                  />
                  {ocrError ? (
                    <div className="card p-4 bg-red-50 border-red-200">
                      <p className="text-sm font-medium text-red-700">OCR 识别失败：{ocrError}</p>
                      {ocrDuration != null && (
                        <p className="text-xs text-red-600 font-mono mt-1">
                          本次耗时 {ocrDuration.toFixed(0)} 秒（含首次加载引擎，通常为首次冷启动，重试即可成功）
                        </p>
                      )}
                      <p className="text-xs text-red-600 mt-1">
                        {switchedFromEngine
                          ? `已把引擎从「${ENGINES[switchedFromEngine]?.label || switchedFromEngine}」切到「${ENGINES[ocrEngine]?.label || ocrEngine}」，点「重试识别」即换引擎重试。`
                          : '可重试识别、载入演示数据体验，或直接手动录入。'}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 mt-3">
                        <label className="text-[11px] text-red-600 shrink-0">识别引擎</label>
                        <EngineSelect
                          value={ocrEngine}
                          onChange={selectEngine}
                          health={engineHealth}
                          showNote
                        />
                        <button
                          className="btn-primary text-xs"
                          disabled={!image}
                          onClick={() => image && startOcr(image)}
                        >
                          ↻ 重试识别
                        </button>
                        <button className="btn-secondary text-xs" onClick={loadDemo}>
                          载入演示数据
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="card p-4 bg-emerald-50 border-emerald-200 flex flex-wrap items-center gap-2 justify-between">
                        <p className="text-sm text-emerald-800">
                          ✅ 识别完成：已自动标准化 <b>{draft.data_points.length}</b> 项指标
                          {ocrDuration != null && (
                            <span className="text-emerald-600 font-mono text-xs ml-1">
                              （耗时 {ocrDuration.toFixed(1)} 秒）
                            </span>
                          )}
                          {(autoDate || autoTime || autoReportedAt) && (
                            <>
                              ，并自动识别检查时间{' '}
                              <b className="font-mono">
                                采集 {autoDate}
                                {autoTime ? ` ${autoTime}` : ''}
                                {autoReportedAt ? ` · 报告 ${autoReportedAt}` : ''}
                              </b>
                            </>
                          )}
                          ，请快速核对后保存
                        </p>
                        {draft.report_title && (
                          <p className="text-xs text-emerald-700 mt-1 w-full">
                            📄 报告标题：<b>{draft.report_title}</b>
                          </p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap">
                          <label className="text-[11px] text-emerald-700 shrink-0">识别引擎</label>
                          <EngineSelect
                            value={ocrEngine}
                            onChange={selectEngine}
                            disabled={recoLoading}
                            health={engineHealth}
                            className="!py-1"
                          />
                          <button
                            className="btn-ghost text-xs"
                            disabled={!image || recoLoading}
                            onClick={rerunDraftWithEngine}
                            title="用所选引擎对同一张图重跑，直接替换下方指标（草稿未入库，随时可再换）"
                          >
                            {recoLoading ? '识别中…' : '↻ 换引擎重跑'}
                          </button>
                          <button
                            className="btn-ghost text-xs"
                            disabled={!image || recoLoading}
                            onClick={startDraftFuse}
                            title="依次用其余引擎跑一遍，把当前缺失的指标补进来；读值冲突会标注供你裁决"
                          >
                            ⊕ 多引擎融合补漏
                          </button>
                          {ocrLoop && (
                            <span
                              className={
                                'text-[11px] px-2 py-1 rounded border ' +
                                (ocrLoop.confidence === 'high'
                                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                  : ocrLoop.confidence === 'medium'
                                  ? 'bg-amber-50 border-amber-200 text-amber-700'
                                  : 'bg-red-50 border-red-200 text-red-700')
                              }
                              title={
                                `识别置信度 ${ocrLoop.confidence}（质量分 ${Math.round((ocrLoop.qualityScore || 0) * 100)}%）` +
                                (ocrLoop.retried ? ' · 已自动重识别择优' : '') +
                                (ocrLoop.attempts?.length ? ` · 共 ${ocrLoop.attempts.length} 轮策略` : '')
                              }
                            >
                              {ocrLoop.confidence === 'high' ? '✓ 识别质量高' : ocrLoop.confidence === 'medium' ? '⚠ 识别质量中' : '⚠ 识别质量低'}
                              {ocrLoop.retried ? ' · 已重识别' : ''}
                            </span>
                          )}
                          <button className="btn-ghost text-xs" onClick={resetAll}>
                            ↺ 重新上传
                          </button>
                        </div>
                      </div>
                      {mockMode && (
                        <div className="card p-4 bg-amber-50 border-amber-200 text-amber-800 text-xs leading-relaxed">
                          <b>🧪 演示数据：</b>以下为内置示例数据，用于体验完整导入流程，不会进入真实识别。
                        </div>
                      )}
                    </>
                  )}

                  {/* 防重复导入：识别后自动检测，保存前拦截确认 */}
                  {dupWarn && (
                    <div className="card p-4 bg-amber-50 border-amber-300">
                      <p className="text-sm font-medium text-amber-900">
                        ⚠️ 检测到疑似重复的化验单（已自动查重）
                      </p>
                      <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                        已有 {dupWarn.date} 的记录（{dupWarn.report_type_label || dupWarn.report_type}，共{' '}
                        {(dupWarn.data_points || []).length} 项指标），与本次识别结果指标高度一致（同日或相邻日、报告类型相同），很可能是同一张化验单被重复导入。
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        保存按钮已锁定，请从下方选择操作。
                      </p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <button
                          className="btn-primary text-xs"
                          onClick={() => commitSave(dupWarn.id)}
                        >
                          覆盖该记录（用本次导入替换）
                        </button>
                        <button
                          className="btn-secondary text-xs"
                          onClick={() => commitSave()}
                        >
                          仍要新增一条
                        </button>
                        <button
                          className="btn-secondary text-xs"
                          onClick={resetAll}
                        >
                          取消导入
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 跨实体同源（软闸）：同一份原件已归档为检查报告。只提示 + 需显式确认，绝不静默放行 */}
                  {crossWarn && (
                    <div className="card p-4 bg-amber-50 border-amber-300">
                      <p className="text-sm font-medium text-amber-900">该原件已作为检查报告归档过</p>
                      <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                        归档里已有 <b>{describeHit(crossWarn)}</b>，原件字节与本份完全相同（sha256{' '}
                        {String(crossWarn.sha || '').slice(0, 8)}…）。继续保存会得到「检查报告 + 化验记录」两条同一份报告。
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        建议先到归档页删除旧条目；确实要新增结构化化验记录时，请点下方确认。
                      </p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <button
                          className="btn-primary text-xs"
                          onClick={() => {
                            setCrossAck(true)
                            commitSave()
                          }}
                        >
                          仍然新增（已确认同源）
                        </button>
                        <button className="btn-secondary text-xs" onClick={resetAll}>
                          取消导入
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 新类型发现审计视图：只读、非阻塞，展示本次 Agent 自动写入动态目录的新类型 */}
                  {discoveredTypes.length > 0 && (
                    <div className="card p-4 bg-slate-50 border-slate-200 mb-4">
                      <p className="text-xs font-medium text-slate-700 mb-2">
                        🤖 新类型已自动发现并入库（Agent 全自动、无人工关卡）
                      </p>
                      <div className="space-y-2">
                        {discoveredTypes.map((t) => (
                          <div
                            key={t.code}
                            className="flex flex-wrap items-center justify-between gap-2 text-xs rounded-md border border-slate-200 bg-white px-3 py-2"
                          >
                            <div className="min-w-0">
                              <span className="font-medium text-slate-800">{t.label}</span>
                              <span className="ml-2 font-mono text-slate-500">{t.code}</span>
                            </div>
                            <span className="shrink-0 text-slate-400">签名 {t.signature?.length || 0} 项 · {t.discoveredAt?.slice(0, 10)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}


                  <DataGrid
                    croppedImage={preview}
                    autoDate={autoDate}
                    autoTime={autoTime}
                    autoReportedAt={autoReportedAt}
                    date={draft.date}
                    time={draft.time}
                    reportedDate={draft.reported_date}
                    reportedTime={draft.reported_time}
                    onDateChange={(v) => updateDraft({ date: v })}
                    onTimeChange={(v) => updateDraft({ time: v })}
                    onReportedDateChange={(v) => updateDraft({ reported_date: v })}
                    onReportedTimeChange={(v) => updateDraft({ reported_time: v })}
                    reportType={draft.report_type}
                    onReportTypeChange={(v) => updateDraft({ report_type: v })}
                    points={draft.data_points}
                    onPointsChange={(pts) => updateDraft({ data_points: pts })}
                    reportText={draft.report_text}
                    onReportTextChange={(v) => updateDraft({ report_text: v, report_text_edited: true })}
                    traceId={traceId}
                    baselinePoints={originalPoints}
                    onSave={save}
                    onReset={resetAll}
                  />
                </div>
              )}
            </div>
          </div>

      {recoResult && (
        <ReRecognizeRecordModal
          record={{ id: 'draft', date: draft.date, data_points: draft.data_points }}
          result={recoResult}
          onClose={() => setRecoResult(null)}
          onApply={applyReco}
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
    </div>
  )
}
