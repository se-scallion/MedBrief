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
import { ST, KIND_OPTIONS, FLAG_TEXT, uid, fmtSize, rawJson, postJson } from './intake/shared.js'
import UploadPanel from './intake/UploadPanel.jsx'
import ReviewPanel from './intake/ReviewPanel.jsx'

// MedData 四引擎工作台：原来是与本页「平级」的第二个 Segmented 入口（同一件事两条路）。
// 2026-11-13 收敛：主路径只有本页这一套；四引擎降级为抽屉里的**实验备选**，不占导航、不并列。
const MedDataWorkbench = React.lazy(() => import('../meddata/MedDataWorkbench.jsx'))


export default function IntakePage() {
  const { message, modal } = AntApp.useApp()
  const { pushLog } = useLog()

  const [items, setItems] = useState([])
  // 一键批量（2026-11-15 用户：每张都点「识别这张」太累，要一键识别 / 一键导入）
  // 串行执行（识别是重任务，并发会打架且难定位失败）；随时可停；单张失败不中断整批。
  const [batch, setBatch] = useState(null)          // { mode:'ocr'|'import', done, total }
  const batchStop = useRef(false)
  const [selected, setSelected] = useState([]) // 勾选做拼接的图片 id
  const [stitching, setStitching] = useState(false)


  // 2026-11-13 用户口径：卡片是给医生看的，默认不脱敏；需要给外部转发时再打开

  const [reports, setReports] = useState([])
  const [mdOpen, setMdOpen] = useState(false) // 四引擎实验台（抽屉）

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
  const addFiles = useCallback(
    (fileList) => {
      const accepted = []
      for (const f of fileList) {
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')
        if (!isPdf && !/^image\//.test(f.type || '')) {
          message.warning(`${f.name} 既不是图片也不是 PDF，已跳过`)
          continue
        }
        accepted.push({
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
          meta: { kind: 'lab', reportDate: '', hospital: '' },
          _file: f,
        })
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
      pushLog(`已加入 ${accepted.length} 个文件（图片/PDF），等待识别`, 'info')
    },
    [message, pushLog],
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

  const removeItem = (id) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
    setSelected((prev) => prev.filter((x) => x !== id))
  }

  // ---------- 2. 两张拼一张 ----------
  const toggleSelect = (id) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= 2) return [prev[1], id]
      return [...prev, id]
    })
  }

  const doStitch = async () => {
    if (selected.length !== 2) {
      message.warning('请勾选恰好两张图片再拼接')
      return
    }
    const [a, b] = selected.map((id) => items.find((it) => it.id === id)).filter(Boolean)
    if (!a || !b || !a.dataUrl || !b.dataUrl || a.isPdf || b.isPdf) {
      if (a?.isPdf || b?.isPdf) message.warning('PDF 不能拼接，请直接识别（PDF 内部多页会自动按页处理）')
      else message.warning('请选择两张已读取完成的图片')
      message.warning('图片还没读取完成，稍后再试')
      return
    }
    setStitching(true)
    try {
      const { body } = await postJson('/api/intake/stitch', { images: [a.dataUrl, b.dataUrl] })
      if (!body.ok) throw new Error(body.error || '拼接失败')
      const merged = {
        id: uid(),
        name: `拼接-${a.name}+${b.name}`,
        size: null,
        status: 'pending',
        source: 'stitch',
        stitchRole: 'merged',
        fromIds: [a.id, b.id],
        dataUrl: body.dataUrl,
        text: '',
        rows: [],
        parsed: null,
        meta: { kind: a.meta.kind || b.meta.kind || 'lab', reportDate: '', hospital: '' },
      }
      // 用返回图替换这两张（并保留 stitching 的来源链，方便回查原图）
      setItems((prev) => [...prev.filter((it) => it.id !== a.id && it.id !== b.id), merged])
      setSelected([])
      pushLog(`已把「${a.name}」与「${b.name}」纵向拼接为一张（${body.width}×${body.height}）`, 'ok')
      message.success('拼接完成，已替换为一张')
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
        kind: m.kind || meta.kind || 'lab',
        reportDate: m.reportDate || meta.reportDate || '',
        sampledAt: m.sampledAt || meta.sampledAt || '',
        hospital: m.hospital || meta.hospital || '',
        reportType: m.reportType || meta.reportType || '',
        barcode: m.barcode || meta.barcode || '',
      }
      return { meta: next }
    })
  }, [])

  // ---------- 3. 识别 + 解析 ----------
  const recognize = async (item) => {
    if (!item.dataUrl) {
      message.warning('图片还没读取完成')
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
      patchItem(item.id, {
        status: 'done',
        text: body.text || '',
        rows: body.rows || [],
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
    const payload = {
      image: item.isPdf ? '' : (item.dataUrl || ''),
      // PDF 不入 sha256 查重图指纹（它是文档不是截图）；靠内容指纹查重
      pdf: item.isPdf ? (item.dataUrl || '') : '',
      force,
      text: item.text || '',
      rows: item.rows || [],
      meta: item.meta || {},
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
    let ok = 0; let bad = 0
    for (let i = 0; i < targets.length; i++) {
      if (batchStop.current) { pushLog(`批量识别已停止（完成 ${i}/${targets.length}）`, 'warn'); break }
      setBatch({ mode: 'ocr', done: i, total: targets.length })
      try {
        await recognize(targets[i])
        ok++
      } catch (e) {
        bad++
        pushLog(`「${targets[i].name}」识别异常：${e.message}`, 'err')
      }
    }
    setBatch(null)
    pushLog(`一键识别结束：成功 ${ok} 张${bad ? `，异常 ${bad} 张` : ''}`, bad ? 'warn' : 'ok')
    message[bad ? 'warning' : 'success'](`识别完成：成功 ${ok} 张${bad ? `，异常 ${bad} 张` : ''}`)
  }

  // ---------- 一键导入全部（只导入已解析出指标行的） ----------
  const importAll = async () => {
    const targets = items.filter((it) => !it.saved && Array.isArray(it.rows) && it.rows.length > 0)
    if (!targets.length) { message.info('没有可入库的条目（先识别，或识别后补上指标行）'); return }
    batchStop.current = false
    setBatch({ mode: 'import', done: 0, total: targets.length })
    pushLog(`开始一键导入：共 ${targets.length} 张（疑似重复的会自动跳过并记日志）`, 'info')
    let ok = 0; let dup = 0; let bad = 0
    for (let i = 0; i < targets.length; i++) {
      if (batchStop.current) { pushLog(`批量导入已停止（完成 ${i}/${targets.length}）`, 'warn'); break }
      setBatch({ mode: 'import', done: i, total: targets.length })
      try {
        const r = await saveReport(targets[i], { silent: true })
        if (r?.duplicate) dup++
        else if (r?.ok) ok++
      } catch (e) {
        bad++
        pushLog(`「${targets[i].name}」入库失败：${e.message}`, 'err')
      }
    }
    setBatch(null)
    pushLog(`一键导入结束：入库 ${ok} 张${dup ? `，跳过重复 ${dup} 张` : ''}${bad ? `，失败 ${bad} 张` : ''}`, bad ? 'warn' : 'ok')
    message[bad ? 'warning' : 'success'](`入库完成：${ok} 张${dup ? `（跳过重复 ${dup}）` : ''}${bad ? `，失败 ${bad}` : ''}`)
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
        {item.rows.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={item.status === 'failed' ? '未识别：没有解析出指标行' : '还没有指标行，先识别或粘贴文本后解析'}
          />
        ) : (
          <Table
            size="small"
            rowKey={(r, i) => `${r.name}-${i}`}
            pagination={false}
            columns={rowColumns}
            dataSource={item.rows.map((r, i) => ({ ...r, __itemId: item.id, __idx: i }))}
            onRow={(r) =>
              r.status === 'unknown'
                ? { style: { background: '#fffbe6' } }
                : r.status === 'abnormal'
                  ? { style: { background: '#fff1f0' } }
                  : {}
            }
          />
        )}
      </div>

      <Divider style={{ margin: '4px 0' }} />

      <Space wrap>
        <Text style={{ fontSize: 12 }}>报告类型</Text>
        <Select
          size="small"
          style={{ width: 130 }}
          value={item.meta.kind}
          options={KIND_OPTIONS}
          onChange={(v) => patchItem(item.id, (it) => ({ meta: { ...it.meta, kind: v } }))}
        />
        <Space size={4}>
          <Text style={{ fontSize: 12 }}>报告日期</Text>
          {item.meta.sampledAt && (
            <Tooltip title="按 MedData 口径：报告日期取「报告时间」，采样/检查日期单独保留，便于核对">
              <Text type="secondary" style={{ fontSize: 11 }}>（采样 {String(item.meta.sampledAt)}）</Text>
            </Tooltip>
          )}
        </Space>
        <Input
          size="small"
          style={{ width: 130 }}
          placeholder="2026-11-01"
          value={item.meta.reportDate}
          onChange={(e) => patchItem(item.id, (it) => ({ meta: { ...it.meta, reportDate: e.target.value } }))}
        />
        <Text style={{ fontSize: 12 }}>医院</Text>
        <Input
          size="small"
          style={{ width: 160 }}
          placeholder="如：某某医院"
          value={item.meta.hospital}
          onChange={(e) => patchItem(item.id, (it) => ({ meta: { ...it.meta, hospital: e.target.value } }))}
        />
        <Button type="primary" size="small" onClick={() => onSaveReport(item)} disabled={!item.rows.length && !item.text}>
          入库这份报告
        </Button>
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
        selected={selected}
        setSelected={setSelected}
        stitching={stitching}
        addFiles={addFiles}
        recognize={recognize}
        doStitch={doStitch}
        removeItem={removeItem}
        toggleSelect={toggleSelect}
        batch={batch}
        onBatchStop={() => { batchStop.current = true }}
        onRecognizeAll={recognizeAll}
      />
      </div>

      {/* 3 + 4：识别校对与入库 */}
      <div id="sec-review" style={{ scrollMarginTop: 56 }}>
        <ReviewPanel items={items} renderItemBody={renderItemBody} batch={batch}
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
