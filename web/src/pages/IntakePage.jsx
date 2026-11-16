import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Collapse,
  Divider,
  Drawer,
  Empty,
  Form,
  Image,
  Input,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import { jget } from '../api.js'
import { useLog } from '../App.jsx'

const { Text, Paragraph } = Typography
const { Dragger } = Upload

// 常量与工具已搬到 ./intake/shared.js（2026-11-13 抽页）；此处只保留页面状态与副作用。
import { runBatch, ST, KIND_OPTIONS, FLAG_TEXT, uid, fmtSize, rawJson, postJson, sha256FileSafe } from './intake/shared.js'
import UploadPanel from './intake/UploadPanel.jsx'
import ReviewPanel from './intake/ReviewPanel.jsx'
// v0.6 第 2 段：② 校对区整份复用 MedData DataGrid（与报告库编辑弹窗同一个组件、同一个 bundle）
import DataGrid from '../../../meddata/src/components/DataGrid.jsx'
import { toPoints, fromPoints, filterEmptyValueRows } from './intake/points.js'
import { emitTrace } from '../../../meddata/src/utils/trace.js'
import '../meddata/embedded.css'

// MedData 四引擎工作台：原来是与本页「平级」的第二个 Segmented 入口（同一件事两条路）。
// 2026-11-13 收敛：主路径只有本页这一套；四引擎降级为抽屉里的**实验备选**，不占导航、不并列。
const MedDataWorkbench = React.lazy(() => import('../meddata/MedDataWorkbench.jsx'))

// v0.6 第 2 段：② 校对区整份挂 DataGrid 后，375 实测（截图 /tmp/v06-shots/e2e-2-375…）
// 表头「序号/标准代码」被 min-w-[760px] 的网格挤成竖排单字、底部「保存到本地数据库」按钮
// 折成 3 行占大块。DataGrid 是 MedData 组件、不改跨项目文件，这里用页面级注入收窄：
//   · 网格容器自身横向滚动（表格仍 760px 可左右看，不压正文）；
//   · 表头 th/button 一律 nowrap，禁止中文逐字折行；
//   · 底部保存区保持横排、按钮不竖排、说明文字隐藏（表单下方已有说明行）。
const REVIEW_GRID_MOBILE_CSS = `
@media (max-width: 575px) {
  .mb-review-grid { max-width: 100% !important; overflow: hidden !important; }
  .mb-review-grid .card { padding: 8px !important; max-width: 100% !important; }
  /* 表格 760px 必须在容器内横向滚动；容器绝不能被表格撑到 760（375 实测 de=818 的真因） */
  .mb-review-grid .overflow-x-auto { max-width: 100% !important; width: 100% !important;
    overflow-x: auto !important; overflow-y: visible !important; }
  .mb-review-grid table { min-width: 760px !important; }
  .mb-review-grid th, .mb-review-grid th button { white-space: nowrap !important; }
  .mb-review-grid th button { display: inline-flex !important; flex-wrap: nowrap !important; }
  .mb-review-grid .flex.items-center.justify-end.gap-3 { flex-wrap: nowrap !important; gap: 6px !important; }
  .mb-review-grid .flex.items-center.justify-end.gap-3 > p { display: none !important; }
  .mb-review-grid .flex.items-center.justify-end.gap-3 > button { white-space: nowrap !important; flex: 0 0 auto !important; }
  .mb-review-grid .btn-primary, .mb-review-grid .btn-secondary { padding: 4px 10px !important; font-size: 12px !important; }
  /* 去掉与页面「入库这份报告」重复的空按钮（本页 onSave 只弹提示）。
     精确到保存行（flex justify-end gap-3）的直接子按钮，避免误伤工具栏的
     「智能补项/解析/确认解析」三个 .btn-primary。「清空本次」(.btn-secondary) 保留。 */
  .mb-review-grid .flex.items-center.justify-end.gap-3 > .btn-primary { display: none !important; }
  .mb-review-grid .grid.gap-4.lg\\:grid-cols-5 { gap: 8px !important; }
}
`



export default function IntakePage() {
  const { message, modal } = AntApp.useApp()
  const { pushLog } = useLog()

  const [items, setItems] = useState([])
  // 一键批量（2026-11-15 用户：每张都点「识别这张」太累，要一键识别 / 一键导入）
  // 串行执行（识别是重任务，并发会打架且难定位失败）；随时可停；单张失败不中断整批。
  const [batch, setBatch] = useState(null)          // { mode:'ocr'|'import', done, total }
  const batchStop = useRef(false)
  const [selected, setSelected] = useState([]) // 通用多选（批量移除 / 拼接），顺序 = 勾选顺序
  // 2026-11-17 批量导入改造（计划 v0.14 / 规格 v1.8）：
  //   MAX_SELECT = 一次能勾几张；MAX_STITCH = 一次能拼几张（C-9 未放行 ⇒ 常量锁 2，
  //   闸门在 doStitch 函数里，不靠按钮 disabled —— disabled 只是第二道保险）。
  const MAX_SELECT = 4
  // 2026-11-17 用户两次点名「现在就要拼三段」⇒ C-9 放行：一次最多拼 4 张。
  // 服务端护栏见 lib/reportIntake.mjs 的 MAX_STITCH_IMAGES / MAX_STITCH_HEIGHT（不许只靠前端）。
  const MAX_STITCH = 4
  // 批内查重索引：必须跨多次 addFiles 累计（"拖一次 + 粘贴一次"是两次调用）
  const batchIdx = useRef(new Map())      // sha256 -> itemId
  const batchIdxLoose = useRef(new Map()) // `${name}|${size}` -> itemId（仅 sha 为 null 时兜底）
  const [stitching, setStitching] = useState(false)


  // 2026-11-13 用户口径：卡片是给医生看的，默认不脱敏；需要给外部转发时再打开

  const [reports, setReports] = useState([])
  const [mdOpen, setMdOpen] = useState(false) // 四引擎实验台（抽屉）
  // ② 校对区折叠面板的展开键：识别完自动把这张展开，用户才看得见系统填了什么
  const [openKeys, setOpenKeys] = useState([])
  // ≤575px 注入 ② 校对区 DataGrid 窄屏样式（独立 id、独立 effect、卸载即移除）
  useEffect(() => {
    const style = document.createElement('style')
    style.id = 'mb-review-grid-mobile'
    style.textContent = REVIEW_GRID_MOBILE_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

  // 页内分段（2026-11-13）：①②③ 原本纵向堆叠、一屏只见 ①，医生/家属要一路往下滚。
  // 这里加一条吸顶分段条：点哪段滚到哪段，滚动时高亮当前段。不动 state、不拆页面。
  // 资料卡已独立成菜单项（pages/CardPage.jsx），录入页只管「导入 → 校对」
  const SECS = [
    { key: 'upload', label: '① 导入', id: 'sec-upload' },
    { key: 'review', label: '② 校对', id: 'sec-review' },
  ]
  const [sec, setSec] = useState('upload')
  const scrollLock = useRef(0) // 点击分段后短暂锁住观察器，否则「点了③却被②抢走高亮」
  const gotoSection = useCallback((key) => {
    const target = SECS.find((x) => x.key === key)
    if (!target) return
    setSec(key)
    scrollLock.current = Date.now() + 900
    document.getElementById(target.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  // 滚动时反查当前所在的段（用 IntersectionObserver，避免手写 scroll 节流）
  useEffect(() => {
    const els = SECS.map((x) => document.getElementById(x.id)).filter(Boolean)
    if (!els.length) return
    const io = new IntersectionObserver(
      (entries) => {
        if (Date.now() < scrollLock.current) return // 点击引发的滚动期间不抢高亮
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (visible) setSec(visible.target.id.replace('sec-', ''))
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: [0.1, 0.4, 0.8] },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])
  const iframeRef = useRef(null)

  const loadReports = useCallback(async () => {
    try {
      const j = await jget('/api/intake/reports')
      setReports(j.reports || [])
    } catch {
      setReports([])
    }
  }, [])

  useEffect(() => {
    loadReports()
  }, [loadReports])

  // ---------- 1. 批量导入 ----------
  // 导入即查重：三路（规格 §7.1/§7.2）
  //   P1  批内强比对（sha 非空）：命中 ⇒ **不建第二张卡**（同批误选两次，零信息增量）
  //   P1′ 批内粗判（sha === null）：命中 ⇒ **仍建卡、只打标**（同名同大小的不同截图很常见，跳过=丢数据）
  //   P2  对库 exact：命中 ⇒ 仍建卡 + 橙 Tag「同一文件已导入过」（用户可能想覆盖/更新原报告）
  // 判定真相仍归服务端 findDuplicate（server.mjs:1683），这里只提示、不改入库结果。
  const addFiles = useCallback(
    async (fileList) => {
      if (!fileList || !fileList.length) return
      // 先把哈希全部算完，再一次性建卡（避免"先建卡再补 Tag"的闪烁）
      const hashed = await Promise.all(
        Array.from(fileList).map(async (f) => ({ f, res: await sha256FileSafe(f) })),
      )
      const libSha = new Map((reports || []).filter((r) => r.sha256).map((r) => [r.sha256, r.id]))
      const accepted = []
      let hashSkipped = 0
      for (const { f, res } of hashed) {
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')
        if (!isPdf && !/^image\//.test(f.type || '')) {
          message.warning(`${f.name} 既不是图片也不是 PDF，已跳过`)
          continue
        }
        const sha = res.sha
        const looseKey = `${f.name || '截图'}|${f.size}`
        if (sha && batchIdx.current.has(sha)) {
          message.warning('这张图本次已选过，已跳过')
          pushLog(`批内重复：${f.name} 已选过，已跳过`, 'warn')
          continue
        }
        let predup = null
        if (!sha) hashSkipped += 1
        // P1′：批内粗判只打标、绝不跳过
        if (!sha && batchIdxLoose.current.has(looseKey)) predup = { kind: 'name-size-suspect' }
        // P2：对库 exact（sha 非空时；降级态对库不做任何判断）
        if (sha && libSha.has(sha)) predup = { kind: 'exact-file', of: libSha.get(sha) }
        const item = {
          id: uid(),
          name: f.name || '截图',
          size: f.size,
          status: 'pending',
          source: isPdf ? 'pdf' : 'upload',
          isPdf,
          dataUrl: '',
          text: '',
          rows: [],
          parsed: null,
          meta: { reportDate: '', hospital: '' },
          _file: f,
          sha256: sha || '',
          hashSkipped: !sha,
          hashSkipReason: res.reason || '',
          predup,
        }
        if (sha) batchIdx.current.set(sha, item.id)
        batchIdxLoose.current.set(looseKey, item.id)
        accepted.push(item)
      }
      if (!accepted.length) return
      setItems((prev) => [...prev, ...accepted])
      // 逐个转 dataURL（缩略图用，识别/入库也用它）
      accepted.forEach((item) => {
        const fr = new FileReader()
        fr.onload = () => {
          setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, dataUrl: String(fr.result) } : it)))
        }
        fr.onerror = () => message.error(`${item.name} 读取失败`)
        fr.readAsDataURL(item._file)
      })
      const dupLib = accepted.filter((it) => it.predup && it.predup.kind === 'exact-file').length
      const dupLoose = accepted.filter((it) => it.predup && it.predup.kind === 'name-size-suspect').length
      const tail = [
        dupLib ? `库内已有同一文件 ${dupLib} 张` : '',
        dupLoose ? `可能重复（按文件名+大小粗判）${dupLoose} 张` : '',
        hashSkipped ? `${hashSkipped} 张未做文件查重` : '',
      ].filter(Boolean).join('；')
      pushLog(`已加入 ${accepted.length} 个文件（图片/PDF），等待识别${tail ? ` —— ${tail}` : ''}`, hashSkipped ? 'warn' : 'info')
    },
    [message, pushLog, reports],
  )

  // 整页粘贴截图
  useEffect(() => {
    const onPaste = (e) => {
      const files = Array.from(e.clipboardData?.files || []).filter((f) => /^image\//.test(f.type))
      if (!files.length) return
      e.preventDefault()
      addFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  const patchItem = (id, patch) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...(typeof patch === 'function' ? patch(it) : patch) } : it)))

  // 移除条目时必须**同键删两个 Map**，否则「移除后再拖回来」会被误判成批内重复（规格 §7.2）
  const forgetIndex = (item) => {
    if (!item) return
    if (item.sha256) batchIdx.current.delete(item.sha256)
    batchIdxLoose.current.delete(`${item.name}|${item.size}`)
  }
  const removeItem = (id) => {
    const target = items.find((it) => it.id === id)
    forgetIndex(target)
    setItems((prev) => prev.filter((it) => it.id !== id))
    setSelected((prev) => prev.filter((x) => x !== id))
  }
  // 批量移除 / 清空勾选（操作栏用）：只删本次未入库的内存条目，不碰库
  const removeSelected = (ids) => {
    const set = new Set(ids || [])
    if (!set.size) { setSelected([]); return }
    items.forEach((it) => { if (set.has(it.id)) forgetIndex(it) })
    setItems((prev) => prev.filter((it) => !set.has(it.id)))
    setSelected((prev) => prev.filter((x) => !set.has(x)))
  }

  // ---------- 2. 两张拼一张 ----------
  const toggleSelect = (id) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_SELECT) { message.info(`一次最多选 ${MAX_SELECT} 张；再拼请分批`); return prev }
      return [...prev, id]
    })
  }

  const doStitch = async () => {
    // 闸门在函数里（不靠按钮 disabled）：2..MAX_STITCH 张可拼，顺序 = 勾选顺序
    if (selected.length < 2 || selected.length > MAX_STITCH) {
      message.warning(`请勾选 2~${MAX_STITCH} 张图片再拼接（当前 ${selected.length} 张）`)
      return
    }
    const picked = selected.map((id) => items.find((it) => it.id === id)).filter(Boolean)
    if (picked.length !== selected.length) { message.warning('有图片已不在列表里，请重新勾选'); return }
    if (picked.some((it) => it.isPdf)) {
      message.warning('PDF 不能拼接，请直接识别（PDF 内部多页会自动按页处理）')
      return
    }
    if (picked.some((it) => !it.dataUrl)) {
      message.warning('图片还没读取完成，稍后再试')
      return
    }
    setStitching(true)
    try {
      const { body } = await postJson('/api/intake/stitch', { images: picked.map((it) => it.dataUrl) })
      if (!body.ok) throw new Error(body.error || '拼接失败')
      const merged = {
        id: uid(),
        name: `拼接-${picked.map((it) => it.name).join('+')}`,
        size: null,
        status: 'pending',
        source: 'stitch',
        stitchRole: 'merged',
        fromIds: picked.map((it) => it.id),
        dataUrl: body.dataUrl,
        text: '',
        rows: [],
        parsed: null,
        meta: { kind: picked.map((it) => it.meta.kind).find(Boolean) || '', reportDate: '', hospital: '' },
      }
      // 用返回图替换这几张（并保留来源链，方便回查原图）
      const drop = new Set(picked.map((it) => it.id))
      setItems((prev) => [...prev.filter((it) => !drop.has(it.id)), merged])
      setSelected([])
      pushLog(`已把 ${picked.length} 张纵向拼接为一张：${picked.map((it) => it.name).join(' + ')}（${body.width}×${body.height}）`, 'ok')
      message.success(`拼接完成（${picked.length} 张 → 1 张）`)
    } catch (e) {
      message.error(e.message)
      pushLog(`拼接失败：${e.message}`, 'err')
    } finally {
      setStitching(false)
    }
  }

  // 把后端推断出的 meta 合进表单项：**只填空字段，不覆盖用户已填**。
  // 识别（图片/PDF）与手工粘贴文本后的「重新解析」都走这一条，避免两处逻辑漂移。
  const mergeMeta = useCallback((itemId, meta) => {
    if (!meta) return
    patchItem(itemId, (it) => {
      const m = it.meta || {}
      const next = {
        ...m,
        kind: m.kind || meta.kind || '',
        reportDate: m.reportDate || meta.reportDate || '',
        sampledAt: m.sampledAt || meta.sampledAt || '',
        hospital: m.hospital || meta.hospital || '',
        reportType: m.reportType || meta.reportType || '',
        barcode: m.barcode || meta.barcode || '',
      }
      // 报告类型（具体类型，如「染色体核型」）是否由系统自动识别出来的：
      // 用户没手填过才打「自动识别」标；他一改就撤标（改过的以人为准）。
      const typeAuto = m.reportType ? !!it.typeAuto : !!meta.reportType
      return { meta: next, typeAuto }
    })
  }, [])

  // ---------- 3. 识别 + 解析 ----------
  const recognize = async (item) => {
    if (!item.dataUrl) {
      message.warning('图片还没读取完成')
      return
    }
    // r3 A / v0.6：已入库条目「重新识别」不静默清 saved、也不用 force 重导
    // （force 会 push 出第二份同源报告）。确认后生成一份**新的待校对副本**，
    // 带 sourceReportId，由用户明确选「更新原报告」或「另存为新报告」。
    if (item.saved) {
      modal.confirm({
        title: '这份已入库，重新识别会生成待校对副本',
        content: '原报告保持不变。改完内容后选「更新原报告」（原地更新，不产生第二份）或「另存为新报告」（库里会有两份同源报告）。',
        okText: '生成待校对副本', cancelText: '取消',
        onOk: () => {
          const copy = {
            ...item, id: uid(), name: `${item.name}（重新识别）`, saved: false, status: 'pending',
            reportId: undefined, sourceReportId: item.reportId || item.id,
            rows: [], baselineRows: [], text: '', ocrNote: '', parsed: null,
          }
          setItems((prev) => [...prev, copy])
          setOpenKeys((ks) => [...ks, copy.id])
          message.info('已生成待校对副本，请点「识别这张」')
        },
      })
      return
    }
    patchItem(item.id, { status: 'ocr' })
    try {
      // 拼接产物必须带 stitched:true：后端只对拼接结果做「重叠区重复行」合并。
      // 单图导入绝不能带——两次复查同名同值是正常的，合并就成了丢数据。
      // PDF 走独立字段：后端会先用 PyMuPDF 判断「有没有文字层」——
      // 有文字层直接抽文本（更快更准，不读图）；扫描件才栅格化成 PNG 走图像链。
      const payload = item.isPdf ? { pdf: item.dataUrl } : { image: item.dataUrl }
      if (item.source === 'stitch') payload.stitched = true
      const { body } = await postJson('/api/intake/ocr', payload)
      if (!body.ok) {
        // 上游不可用 or 识别为空：显式标「未识别」，绝不渲染成空表
        patchItem(item.id, {
          status: 'failed',
          ocrNote: body.unavailable ? `识别服务不可用：${body.reason || ''}（可手工粘贴文本）` : '未识别出文字',
          rows: [],
          parsed: null,
        })
        pushLog(`「${item.name}」未识别${body.unavailable ? '（8008 不可用）' : ''}`, 'warn')
        return
      }
      const rowsNow = body.rows || []
      // r2 #1 / r3：OCR 响应没有 blocks，只有版式行 lines。
      // snapshot 如实标注 layout-lines，不假造网格；emitTrace 先写 localStorage，
      // readTraceLocal 只读 localStorage → 不依赖后端可用，不新增端点。
      try {
        await emitTrace(item.id, {
          traceSource: 'recognize',
          rawGrid: { kind: 'layout-lines', lines: body.lines || body.layoutLines || [] },
          rawGridSource: 'layout-lines',
          ocrLoop: null,
          recognizedAt: new Date().toISOString(),
          reportType: body.meta?.reportType || '',
          source: body.engine || '',
        })
      } catch (e) {
        pushLog(`「${item.name}」识别留痕失败（不影响识别结果）：${e.message}`, 'warn')
      }
      patchItem(item.id, {
        status: 'done',
        text: body.text || '',
        rows: rowsNow,
        // 识别后、编辑前的真值快照：供 DataGrid 算 diff / 复制反馈（v0.6 第 3 段）
        baselineRows: rowsNow.map((r) => ({ ...r })),
        ocrNote: body.upstream ? `上游提示：${body.upstream}` : '',
        engine: body.engine || '',
        rawRowCount: body.rawRowCount ?? null,
        stitchedDeduped: body.stitchedDeduped ?? 0,
        // 超高图自动切块：h/w > 2.8 时后端切块分别识别（Vision 对超高图内部降采样会中间带成片丢行）。
        // 只做显示，判据与切块逻辑都在后端；这里把证据留全，出问题能看出是「切块」还是「去重」干的。
        chunked: !!body.chunked,
        chunks: body.chunks || 1,
        chunkAspect: body.chunkAspect ?? null,
        chunkMerged: body.chunkMerged || 0,
        chunkValueConflicts: body.chunkValueConflicts || 0,
        // 倾斜矫正：歪拍会让行聚类崩（实测 2° 就掉 27% 行）。界面不为它加任何东西——
        // 用户不关心我们转了几度，只在事件日志留一行，排障时能对上。
        deskewed: !!body.deskewed,
        deskewAngle: body.deskewAngle ?? null,
        deskewMs: body.deskewMs ?? null,
      })
      // 2026-11-15：识别完自动把「报告日期 / 类型 / 医院 / 条码」填进表单项（只在原值为空时才填，
      // 绝不覆盖用户已经改过的内容）。过去这几栏全靠手敲，用户反馈「识别完了表单还是空的」。
      mergeMeta(item.id, body.meta)
      // 并自动展开这张的校对区：表单填了但折叠着，用户看不见 = 等于没填（这个坑是 11-15 端到端跑出来的）
      setOpenKeys((ks) => (ks.includes(item.id) ? ks : [...ks, item.id]))
      const deduped = body.stitchedDeduped || 0
      pushLog(
        `「${item.name}」识别完成，得到 ${(body.rows || []).length} 行` +
          (body.deskewed
            ? `（图像倾斜 ${body.deskewAngle > 0 ? '+' : ''}${Number(body.deskewAngle).toFixed(1)}°，已自动回正，耗时 ${body.deskewMs}ms）`
            : '') +
          (body.chunked
            ? `（拼图过高 h/w ${body.chunkAspect}，已切 ${body.chunks} 块识别：原始 ${body.rawRowCount} 行 → 合并 ${body.chunkMerged || 0} 行` +
              `${body.chunkValueConflicts ? `，边界残值冲突 ${body.chunkValueConflicts} 行` : ''}）`
            : '') +
          (deduped ? `（重叠区合并 ${deduped} 行：原始 ${body.rawRowCount} → ${(body.rows || []).length}）` : ''),
        'ok',
      )
    } catch (e) {
      patchItem(item.id, { status: 'failed', ocrNote: e.message, rows: [], parsed: null })
      pushLog(`「${item.name}」识别失败：${e.message}`, 'err')
    }
  }

  const reparse = async (item) => {
    try {
      const { body } = await postJson('/api/intake/parse', { text: item.text || '' })
      if (!body.ok) throw new Error(body.error || '解析失败')
      patchItem(item.id, { rows: body.rows || [], parsed: body })
      mergeMeta(item.id, body.meta)
      pushLog(`「${item.name}」重新解析：${(body.rows || []).length} 行`, 'info')
    } catch (e) {
      message.error(e.message)
    }
  }

  const updateRow = (itemId, idx, patch) => {
    patchItem(itemId, (it) => ({
      rows: it.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }))
  }
  const deleteRow = (itemId, idx) => {
    patchItem(itemId, (it) => ({ rows: it.rows.filter((_, i) => i !== idx) }))
  }

  // ---------- 4. 入库（重复必须二次确认，绝不静默丢弃） ----------
  const saveReport = async (item, { force = false, silent = false } = {}) => {
    // r3 B：智能补项会加「有单位/区间但 value=''」的推测行，绝不入库
    // （定性结果「阴性/未检出」value 非空，不受影响）。
    const { rows: keptRows, dropped } = filterEmptyValueRows(item.rows || [])
    if (dropped) pushLog(`「${item.name}」${dropped} 行无值未入库（智能补项/空白行，不写空值）`, 'info')
    const isTextOnly = !keptRows.length && !!String(item.text || '').trim()
    const payload = {
      image: item.isPdf ? '' : (item.dataUrl || ''),
      // PDF 不入 sha256 查重图指纹（它是文档不是截图）；靠内容指纹查重
      pdf: item.isPdf ? (item.dataUrl || '') : '',
      force,
      text: item.text || '',
      rows: keptRows,
      // r2 ③：textOnly 只在这个 0 行全文型分支加，绝不放进公共 item.meta
      // （否则会关掉所有报告的文本回退解析）。服务端 :1585 已有该护栏。
      meta: isTextOnly ? { ...(item.meta || {}), textOnly: true } : (item.meta || {}),
    }
    const { body } = await postJson('/api/intake/reports', payload)

    if (body.ok) {
      patchItem(item.id, { status: 'done', reportId: body.report?.id, saved: true })
      loadReports()
      pushLog(`「${item.name}」已入库（${body.report?.id}），共 ${body.total} 份报告`, 'ok')
      message.success('已入库')
      return { ok: true, id: body.report?.id }
    }

    if (body.duplicate) {
      const of = body.duplicate.of || '已存在的报告'
      patchItem(item.id, { status: 'dup' })
      // 批量导入时不弹确认框（一次弹 N 个没法用）：记为「疑似重复·已跳过」，
      // 想强导的那张，单独点它的「入库」再确认即可。
      if (silent) {
        pushLog(`「${item.name}」疑似重复（与 ${of} 相似），批量导入已跳过；要强导请单独点这张的「入库」`, 'warn')
        return { duplicate: true, of }
      }
      modal.confirm({
        title: '这张可能已经导入过',
        content: (
          <Space direction="vertical" size={4}>
            <Text>
              {(body.hint || '检测到重复') + `（与报告 ${of} 相似）`}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              仍要导入的话，本条会作为独立记录保存（带原图指纹，后续查重仍会提示）。
            </Text>
          </Space>
        ),
        okText: '仍要导入',
        cancelText: '跳过这张',
        onOk: async () => {
          await saveReport(item, { force: true })
        },
        onCancel: () => {
          pushLog(`「${item.name}」疑似重复，用户选择跳过`, 'warn')
        },
      })
      return
    }

    throw new Error(body.error || '入库失败')
  }

  // ---------- 一键识别全部 ----------
  const recognizeAll = async () => {
    const targets = items.filter((it) => !it.saved && it.status !== 'ocr' && !(Array.isArray(it.rows) && it.rows.length > 0))
    if (!targets.length) { message.info('没有待识别的图片（已识别的不会重复跑）'); return }
    batchStop.current = false
    setBatch({ mode: 'ocr', done: 0, total: targets.length })
    pushLog(`开始一键识别：共 ${targets.length} 张（串行执行，可随时停止）`, 'info')
    const r = await runBatch(targets, (it) => recognize(it), {
      onProgress: (done) => setBatch({ mode: 'ocr', done, total: targets.length }),
      shouldStop: () => batchStop.current,
    })
    if (r.stopped) pushLog(`批量识别已停止（完成 ${r.done}/${r.total}）`, 'warn')
    setBatch(null)
    pushLog(`一键识别结束：成功 ${r.ok} 张${r.failed ? `，异常 ${r.failed} 张` : ''}`, r.failed ? 'warn' : 'ok')
    message[r.failed ? 'warning' : 'success'](`识别完成：成功 ${r.ok} 张${r.failed ? `，异常 ${r.failed} 张` : ''}`)
  }

  // ---------- 一键导入全部 ----------
  // v0.6：四态分类，替代原来「targets=[] 一律『没有可入库的条目』」的死提示。
  // 用户实测：识别成功并导入 → 再点一键导入 → 勾选条目 / 重新识别都仍是同一句提示。
  // 根因是 saved:true 后 targets 恒空，而勾选只用于两张拼接、重新识别不清 saved。
  const classifyImportable = (list = []) => {
    const saved = list.filter((it) => it.saved)
    const dup = list.filter((it) => !it.saved && it.status === 'dup')
    const failed = list.filter((it) => !it.saved && it.status !== 'dup' && it.status === 'failed')
    const unrecognized = list.filter((it) => !it.saved && it.status !== 'dup' && it.status !== 'failed'
      && !String(it.text || '').trim() && !(Array.isArray(it.rows) && it.rows.length))
    // 0 行但有文本的全文型报告：单张可入库，批量也应可入库（但须 status!=='failed'）。
    const textual = list.filter((it) => !it.saved && it.status !== 'dup' && it.status !== 'failed'
      && String(it.text || '').trim() && !(Array.isArray(it.rows) && it.rows.length))
    const lab = list.filter((it) => !it.saved && it.status !== 'dup' && it.status !== 'failed'
      && Array.isArray(it.rows) && it.rows.length > 0)
    return { targets: [...lab, ...textual], saved, dup, failed, unrecognized, textual, lab }
  }
  const importHint = (c) => {
    if (!c.targets.length && c.saved.length && !c.dup.length && !c.failed.length && !c.unrecognized.length) {
      return `这 ${c.saved.length} 张已入库（${c.saved.slice(0, 2).map((x) => x.reportId || x.id).join('、')}${c.saved.length > 2 ? '…' : ''}）。要改内容请点该张「重新识别」生成待校对副本，再选「更新原报告」或「另存为新报告」。`
    }
    const parts = []
    if (c.saved.length) parts.push(`${c.saved.length} 张已入库`)
    if (c.dup.length) parts.push(`${c.dup.length} 张疑似重复已跳过（要强导请单独点该张「入库」并确认）`)
    if (c.failed.length) parts.push(`${c.failed.length} 张识别失败（请先「一键识别全部」或粘贴文本重新解析）`)
    if (c.unrecognized.length) parts.push(`${c.unrecognized.length} 张还没有识别结果（先识别）`)
    return parts.length ? `${parts.join('；')}。` : '还没有图片，先在 ① 导入。'
  }
  const importAll = async () => {
    const c = classifyImportable(items)
    const targets = c.targets
    if (!targets.length) { message.info(importHint(c)); return }
    batchStop.current = false
    setBatch({ mode: 'import', done: 0, total: targets.length })
    pushLog(`开始一键导入：共 ${targets.length} 张（疑似重复的会自动跳过并记日志）`, 'info')
    const r = await runBatch(targets, (it) => saveReport(it, { silent: true }), {
      onProgress: (done) => setBatch({ mode: 'import', done, total: targets.length }),
      shouldStop: () => batchStop.current,
    })
    if (r.stopped) pushLog(`批量导入已停止（完成 ${r.done}/${r.total}）`, 'warn')
    setBatch(null)
    pushLog(`一键导入结束：入库 ${r.ok} 张${r.skipped ? `，跳过重复 ${r.skipped} 张` : ''}${r.failed ? `，失败 ${r.failed} 张` : ''}`, r.failed ? 'warn' : 'ok')
    message[r.failed ? 'warning' : 'success'](`入库完成：${r.ok} 张${r.skipped ? `（跳过重复 ${r.skipped}）` : ''}${r.failed ? `，失败 ${r.failed}` : ''}`)
  }

  // v0.6 第 4 段：「更新原报告」走 PUT + rowsReplace（原地更新，不 push 第二条）
  const updateOriginalReport = async (item) => {
    if (!item.sourceReportId) { message.error('这份不是待校对副本，无法更新原报告'); return }
    try {
      const { body } = await postJson(`/api/intake/reports/${encodeURIComponent(item.sourceReportId)}`, {
        rowsReplace: true, fromReportId: item.sourceReportId,
        rows: item.rows || [], text: item.text || '',
        meta: item.meta || {},
      }, 'PUT')
      if (!body.ok) throw new Error(body.error || '更新失败')
      patchItem(item.id, { saved: true, reportId: item.sourceReportId, sourceReportId: undefined, status: 'done' })
      loadReports()
      message.success(`已更新原报告 ${item.sourceReportId}（${body.rows} 行，未新增记录）`)
      pushLog(`「${item.name}」已更新原报告 ${item.sourceReportId}（原地更新）`, 'ok')
    } catch (e) { message.error(e.message) }
  }
  const onSaveReport = async (item) => {
    try {
      await saveReport(item)
    } catch (e) {
      message.error(e.message)
      pushLog(`入库失败：${e.message}`, 'err')
    }
  }

  // ---------- 渲染 ----------
  const pendingCount = items.filter((it) => it.status === 'pending').length
  const failedCount = items.filter((it) => it.status === 'failed').length
  const dupCount = items.filter((it) => it.status === 'dup').length
  // 导入即查重的两种命中分开计数（规格 §7.4：两种语义不合并）
  const predupCount = items.filter((it) => it.predup && it.predup.kind === 'name-size-suspect').length
  const libDupCount = items.filter((it) => it.predup && it.predup.kind === 'exact-file').length
  const hashSkippedCount = items.filter((it) => it.hashSkipped).length
  const importableCount = classifyImportable(items).targets.length

  const rowColumns = useMemo(
    () => [
      {
        title: '项目',
        dataIndex: 'name',
        key: 'name',
        width: '22%',
        render: (v, r) => (
          <Space size={4} wrap>
            <Text strong>{v || <Text type="secondary">（没认出名字）</Text>}</Text>
            {/* 项目名认坏/认空时的候选（2026-11-15 C 方案）：只给建议，点一下才改名，绝不自动改 */}
            {(r.nameSuggestions || []).map((sug) => (
              <Tooltip key={sug.name} title={`依据：${sug.why}（来自本机已有报告的同单位/同参考区间记录，仅供比对）`}>
                <Tag color="blue" style={{ cursor: 'pointer' }}
                  onClick={() => updateRow(r.__itemId, r.__idx, { name: sug.name })}>
                  可能：{sug.name}
                </Tag>
              </Tooltip>
            ))}
            {r.suspectedStitchDuplicate && (
              <Tooltip title="该行在拼接重叠区出现过多次，已合并为一行，原始值未丢弃">
                <Tag color="gold">重叠合并 {r.dedupedFrom ? `×${r.dedupedFrom}` : ''}</Tag>
              </Tooltip>
            )}
            {r.valueConflict && (
              <Tooltip title="该行正好落在切块边界，不同块读出了不同数值；已按出现次数最多的值保留，请人工核对">
                <Tag color="volcano">读数冲突</Tag>
              </Tooltip>
            )}
          </Space>
        ),
      },
      {
        title: '值',
        dataIndex: 'value',
        key: 'value',
        width: '14%',
        render: (v, r, idx) => (
          <Input
            size="small"
            value={v ?? ''}
            status={r.status === 'unknown' ? 'warning' : undefined}
            onChange={(e) =>
              updateRow(r.__itemId, idx, { value: e.target.value, num: Number(e.target.value) || null })
            }
          />
        ),
      },
      {
        title: '单位',
        dataIndex: 'unit',
        key: 'unit',
        width: '12%',
        render: (v, r, idx) => (
          <Input size="small" value={v || ''} onChange={(e) => updateRow(r.__itemId, idx, { unit: e.target.value })} />
        ),
      },
      {
        title: '参考区间',
        dataIndex: 'refRange',
        key: 'refRange',
        width: '16%',
        render: (v, r, idx) => (
          <Input
            size="small"
            value={v || ''}
            onChange={(e) => updateRow(r.__itemId, idx, { refRange: e.target.value })}
          />
        ),
      },
      {
        title: '判定',
        dataIndex: 'flag',
        key: 'flag',
        width: '22%',
        render: (v, r) => {
          const abnormal = r.status === 'abnormal' || v === 'high' || v === 'low' || v === 'positive'
          const unknown = r.status === 'unknown'
          return (
            <Space size={4}>
              <Tag color={abnormal ? 'red' : unknown ? 'orange' : 'green'}>
                {FLAG_TEXT[v] || (unknown ? '待确认' : '—')}
              </Tag>
              {unknown && <Text type="warning" style={{ fontSize: 11 }}>低置信</Text>}
            </Space>
          )
        },
      },
      {
        title: '',
        key: 'op',
        width: 56,
        render: (_, r, idx) => (
          <Button size="small" type="text" danger onClick={() => deleteRow(r.__itemId, idx)}>
            删
          </Button>
        ),
      },
    ],
    [],
  )

  const renderItemBody = (item) => (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {item.status === 'failed' && (
        <Alert
          type="warning"
          showIcon
          message="未识别"
          description={
            <Space direction="vertical" size={2}>
              <Text>这张没有识别出可用文字{item.ocrNote ? `（${item.ocrNote}）` : ''}。</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                可以在下面直接粘贴文本再点「重新解析」——不要留空，医生会以为「这项没做」。
              </Text>
            </Space>
          }
        />
      )}

      <div>
        <Space style={{ marginBottom: 6 }} wrap>
          <Text strong style={{ fontSize: 13 }}>识别原文（可编辑）</Text>
          <Button size="small" onClick={() => recognize(item)} loading={item.status === 'ocr'}>
            {item.status === 'done' ? '重新识别' : '识别这张'}
          </Button>
          <Button size="small" onClick={() => reparse(item)} disabled={!item.text}>
            重新解析为指标行
          </Button>
          {item.engine && <Text type="secondary" style={{ fontSize: 12 }}>引擎 {item.engine}</Text>}
        </Space>
        <Input.TextArea
          rows={5}
          value={item.text}
          placeholder="识别结果会出现在这里；识别失败时可以直接粘贴报告文本"
          onChange={(e) => patchItem(item.id, { text: e.target.value })}
        />
      </div>

      <div>
        {item.chunked && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            拼图过高（h/w {item.chunkAspect}），已切 {item.chunks} 块分别识别：原始 {item.rawRowCount} 行 → 合并后{' '}
            {item.rows.length} 行{item.chunkMerged ? `（切块合并 ${item.chunkMerged} 行）` : ''}
            {item.chunkValueConflicts
              ? `，其中 ${item.chunkValueConflicts} 行落在块边界、读数有冲突（已按多数值保留并标「读数冲突」）`
              : ''}
          </Text>
        )}
        <Space style={{ marginBottom: 6 }} wrap>
          <Text strong style={{ fontSize: 13 }}>指标行</Text>
          <Tag>{item.rows.length} 行</Tag>
          {item.status === 'failed' && <Tag color="red">未识别</Tag>}
        </Space>
        {/* v0.6：整份复用 MedData DataGrid（代码列 / 审计色 / 一键修正 / 智能补项 /
            重新匹配 / 粘贴解析 / 清空本次 / 复制反馈）。0 行也挂：DataGrid 自带 0 点空态与
            补行手段，条件渲染等于「半个组件」。
            2026-11-16 用户指出「网格底部『保存到本地数据库』与页面『入库这份报告』重复」：
            已按 REVIEW_GRID_MOBILE_CSS 隐藏网格内那个按钮（它在本页 onSave 只弹提示，是空按钮），
            写库唯一入口＝下方「入库这份报告」（它才带查重/空值过滤/textOnly/更新原报告分支）。 */}

        <div className="mb-review-grid">
        <DataGrid
          date={item.meta?.sampledAt || ''}
          time=""
          onDateChange={(v) => patchItem(item.id, (it) => ({ meta: { ...it.meta, sampledAt: v } }))}
          reportedDate={item.meta?.reportDate || ''}
          reportedTime=""
          onReportedDateChange={(v) => patchItem(item.id, (it) => ({ meta: { ...it.meta, reportDate: v } }))}
          onReportedTimeChange={() => {}}
          reportType={item.meta?.reportType || ''}
          onReportTypeChange={(v) => patchItem(item.id, (it) => ({ meta: { ...it.meta, reportType: v }, typeAuto: false }))}
          points={toPoints(item.rows || [])}
          onPointsChange={(next) => patchItem(item.id, { rows: fromPoints(next) })}
          reportText={item.text || ''}
          onReportTextChange={(v) => patchItem(item.id, { text: v })}
          baselinePoints={toPoints(item.baselineRows || [])}
          traceId={item.id}
          onSave={() => message.info('已应用到待入库内容，请点「入库这份报告」写库')}
          onReset={() => patchItem(item.id, { rows: (item.baselineRows || []).map((r) => ({ ...r })) })}
        />
        </div>
      </div>

      <Divider style={{ margin: '4px 0' }} />

      {/* 每个「标签 + 控件」用一个不换行的组包住：
          375 下原来是「报告类型」标签在上一行、输入框被挤到下一行，读起来像两个字段。 */}
      <Space wrap size={10}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <Text style={{ fontSize: 12 }}>报告大类</Text>
          <Select
            size="small"
            style={{ width: 110 }}
            value={item.meta.kind || undefined}
            placeholder="自动判断"
            options={KIND_OPTIONS}
            onChange={(v) => patchItem(item.id, (it) => ({ meta: { ...it.meta, kind: v } }))}
          />
        </span>
        {/* 报告类型（具体类型）2026-11-15：过去这里只有一个「大类」下拉，
            系统判出来的「染色体核型」这类**具体类型既不显示也改不了**，用户只能说「类型识别不了」。
            现在把具体类型显式摆出来、可编辑，自动识别出来的打「自动识别」标。 */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <Text style={{ fontSize: 12 }}>报告类型</Text>
          <Input
            size="small"
            style={{ width: 150 }}
            placeholder="如 染色体核型 / 血常规"
            value={item.meta.reportType || ''}
            onChange={(e) =>
              patchItem(item.id, (it) => ({ meta: { ...it.meta, reportType: e.target.value }, typeAuto: false }))
            }
          />
          {item.typeAuto && item.meta.reportType ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>自动识别</Tag> : null}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <Text style={{ fontSize: 12 }}>报告日期</Text>
          <Input
            size="small"
            style={{ width: 130 }}
            placeholder="2026-11-01"
            value={item.meta.reportDate}
            onChange={(e) => patchItem(item.id, (it) => ({ meta: { ...it.meta, reportDate: e.target.value } }))}
          />
          {item.meta.sampledAt && (
            <Tooltip title="按 MedData 口径：报告日期取「报告时间」，采样/检查日期单独保留，便于核对">
              <Text type="secondary" style={{ fontSize: 11 }}>（采样 {String(item.meta.sampledAt)}）</Text>
            </Tooltip>
          )}
        </span>
        {item.meta.barcode ? (
          <Tooltip title="检测条码（同批报告可能共用，用于查重与回溯原件）">
            <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>条码 {item.meta.barcode}</Text>
          </Tooltip>
        ) : null}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <Text style={{ fontSize: 12 }}>医院</Text>
          <Input
            size="small"
            style={{ width: 160 }}
            placeholder="如：某某医院"
            value={item.meta.hospital}
            onChange={(e) => patchItem(item.id, (it) => ({ meta: { ...it.meta, hospital: e.target.value } }))}
          />
        </span>
        {item.sourceReportId ? (
          <>
            <Button type="primary" size="small" onClick={() => updateOriginalReport(item)}
              title="原地更新原报告，不产生第二份同源记录">
              更新原报告
            </Button>
            <Button size="small" onClick={() => onSaveReport(item)}
              title="另存为新报告：库里会有两份同源报告（会走查重，可确认仍要导入）">
              另存为新报告
            </Button>
            <Tag color="blue">基于 {item.sourceReportId}</Tag>
          </>
        ) : (
          <Button type="primary" size="small" onClick={() => onSaveReport(item)} disabled={!item.rows.length && !item.text}>
            入库这份报告
          </Button>
        )}
        {item.saved && <Tag color="green">已入库 {item.reportId}</Tag>}
      </Space>
    </Space>
  )

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 15 }}>资料录入</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            上传 → 自动识别（本机）→ 逐行校对 → 入库；识别结果进 data/reports.json，原件按 sha256 只存一份
          </Text>
        </Space>
        <Button size="small" onClick={() => setMdOpen(true)}>
          四引擎识别（实验）
        </Button>
      </div>
      <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#f5f6f8', padding: '6px 0' }}>
        <Space size={8} align="center">
          <Segmented
            size="small"
            value={sec}
            onChange={gotoSection}
            options={SECS.map((x) => ({ label: x.label, value: x.key }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {sec === 'upload' ? '选图/拍照或 PDF，可多选、可两张拼接' : '逐行核对识别结果，改完再入库'}
          </Text>
        </Space>
      </div>
      <Alert
        type="info"
        showIcon
        message="导入病友的病例与报告单，生成给门诊医生看的资料卡"
        description={
          <Text style={{ fontSize: 12 }}>
            只整理数值、时间与出处，不下诊断结论、不给治疗建议。识别失败的会显式标「未识别」，不会当成「没查」。
          </Text>
        }
      />

      {/* 1 + 2：导入与拼接 */}
      <div id="sec-upload" style={{ scrollMarginTop: 56 }}>
      <UploadPanel
        items={items}
        pendingCount={pendingCount}
        failedCount={failedCount}
        dupCount={dupCount}
        predupCount={predupCount}
        libDupCount={libDupCount}
        hashSkippedCount={hashSkippedCount}
        importableCount={importableCount}
        selected={selected}
        stitching={stitching}
        addFiles={addFiles}
        recognize={recognize}
        doStitch={doStitch}
        removeItem={removeItem}
        toggleSelect={toggleSelect}
        removeSelected={removeSelected}
        batch={batch}
        onBatchStop={() => { batchStop.current = true }}
        onRecognizeAll={recognizeAll}
        onImportAll={importAll}
        maxSelect={MAX_SELECT}
        maxStitch={MAX_STITCH}
      />
      </div>

      {/* 3 + 4：识别校对与入库 */}
      <div id="sec-review" style={{ scrollMarginTop: 56 }}>
        <ReviewPanel items={items} renderItemBody={renderItemBody} batch={batch}
          openKeys={openKeys} onOpenChange={setOpenKeys}
          onBatchStop={() => { batchStop.current = true }} onImportAll={importAll} />
      </div>

      <Drawer
        title="MedData 四引擎识别（实验）"
        width="min(1200px, 96vw)"
        open={mdOpen}
        onClose={() => setMdOpen(false)}
        destroyOnHidden
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          备用通道：同一份单据也可以走 MedData 的四引擎（本地 tesseract / macOS Vision / MinerU / AI 精读）。
          结果同样落 MedBrief 的 data/reports.json。日常录入请用主路径，这里只在主路径识别不动时用。
        </Text>
        <div style={{ marginTop: 12 }}>
          {mdOpen ? (
            <Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>}>
              <MedDataWorkbench onImported={() => { loadReports(); setMdOpen(false) }} />
            </Suspense>
          ) : null}
        </div>
      </Drawer>
    </Space>
  )
}
