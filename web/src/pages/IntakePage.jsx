import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Collapse,
  Divider,
  Empty,
  Form,
  Image,
  Input,
  Modal,
  Row,
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

// 状态机：待识别 → 识别中 → 已识别 / 未识别 / 疑似重复
const ST = {
  pending: { label: '待识别', color: 'default' },
  ocr: { label: '识别中', color: 'processing' },
  done: { label: '已识别', color: 'green' },
  failed: { label: '未识别', color: 'red' },
  dup: { label: '疑似重复', color: 'orange' },
}

const KIND_OPTIONS = [
  { value: 'lab', label: '化验单' },
  { value: 'pathology', label: '病理 / 骨穿' },
  { value: 'imaging', label: '影像' },
  { value: 'discharge', label: '出院小结' },
  { value: 'drug', label: '处方 / 用药' },
  { value: 'unknown', label: '不确定' },
]

const FLAG_TEXT = { high: '偏高 ↑', low: '偏低 ↓', normal: '正常', positive: '阳性', negative: '阴性' }

function uid() {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 裸 fetch：/api/intake/* 用「HTTP 200 + ok:false」表达「重复 / 未识别 / 上游不可用」，不能当成异常抛掉。 */
async function rawJson(path, opts = {}) {
  const res = await fetch(path, opts)
  const body = await res.json().catch(() => ({}))
  return { httpStatus: res.status, body }
}

const postJson = (path, data) =>
  rawJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  })

export default function IntakePage() {
  const { message, modal } = AntApp.useApp()
  const { pushLog } = useLog()

  const [items, setItems] = useState([])
  const [selected, setSelected] = useState([]) // 勾选做拼接的图片 id
  const [stitching, setStitching] = useState(false)

  const [patient, setPatient] = useState(null)
  const [patientSaving, setPatientSaving] = useState(false)
  const [form] = Form.useForm()

  const [card, setCard] = useState(null)
  const [cardLoading, setCardLoading] = useState(false)
  const [mask, setMask] = useState(true)

  const [reports, setReports] = useState([])
  const iframeRef = useRef(null)

  // ---------- 病友档案 ----------
  const loadPatient = useCallback(async () => {
    try {
      const j = await jget('/api/intake/patient')
      setPatient(j.patient || null)
      if (j.patient) {
        form.setFieldsValue({
          name: j.patient.name || '',
          sex: j.patient.sex || undefined,
          age: j.patient.age || '',
          diagnosis: j.patient.diagnosis || '',
          subtype: j.patient.subtype || '',
          stage: j.patient.stage || '',
          hospital: j.patient.hospital || '',
          attending: j.patient.attending || '',
          focus: j.patient.questions?.focus || '',
          confirm: j.patient.questions?.confirm || '',
          nextVisit: j.patient.questions?.nextVisit || '',
        })
      }
    } catch (e) {
      message.error(`病友档案读取失败：${e.message}`)
    }
  }, [form, message])

  const loadReports = useCallback(async () => {
    try {
      const j = await jget('/api/intake/reports')
      setReports(j.reports || [])
    } catch {
      setReports([])
    }
  }, [])

  useEffect(() => {
    loadPatient()
    loadReports()
  }, [loadPatient, loadReports])

  // ---------- 1. 批量导入 ----------
  const addFiles = useCallback(
    (fileList) => {
      const accepted = []
      for (const f of fileList) {
        if (!/^image\//.test(f.type || '')) {
          message.warning(`${f.name} 不是图片，已跳过`)
          continue
        }
        accepted.push({
          id: uid(),
          name: f.name || '截图',
          size: f.size,
          status: 'pending',
          source: 'upload',
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
      pushLog(`已加入 ${accepted.length} 张图片，等待识别`, 'info')
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
    if (!a || !b || !a.dataUrl || !b.dataUrl) {
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
      const payload = { image: item.dataUrl }
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
      })
      const deduped = body.stitchedDeduped || 0
      pushLog(
        `「${item.name}」识别完成，得到 ${(body.rows || []).length} 行` +
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
  const saveReport = async (item, { force = false } = {}) => {
    const payload = {
      image: item.dataUrl || '',
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
      return
    }

    if (body.duplicate) {
      const of = body.duplicate.of || '已存在的报告'
      patchItem(item.id, { status: 'dup' })
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

  const onSaveReport = async (item) => {
    try {
      await saveReport(item)
    } catch (e) {
      message.error(e.message)
      pushLog(`入库失败：${e.message}`, 'err')
    }
  }

  // ---------- 5. 资料卡 ----------
  const savePatient = async () => {
    const v = form.getFieldsValue()
    setPatientSaving(true)
    try {
      const { body } = await postJson('/api/intake/patient', {
        name: v.name || '',
        sex: v.sex || '',
        age: v.age || '',
        diagnosis: v.diagnosis || '',
        subtype: v.subtype || '',
        stage: v.stage || '',
        hospital: v.hospital || '',
        attending: v.attending || '',
        questions: { focus: v.focus || '', confirm: v.confirm || '', nextVisit: v.nextVisit || '' },
      })
      if (!body.ok) throw new Error(body.error || '保存失败')
      setPatient(body.patient)
      pushLog('病友档案已保存（身份证 / 手机号 / 住址一律不存）', 'ok')
      message.success('已保存')
    } catch (e) {
      message.error(e.message)
    } finally {
      setPatientSaving(false)
    }
  }

  const makeCard = async (nextMask = mask) => {
    setCardLoading(true)
    try {
      const j = await jget(`/api/intake/card?mask=${nextMask ? 1 : 0}`)
      setCard(j)
      pushLog(`资料卡已生成（${nextMask ? '脱敏' : '未脱敏'}）`, 'ok')
    } catch (e) {
      message.error(`生成资料卡失败：${e.message}`)
      setCard(null)
    } finally {
      setCardLoading(false)
    }
  }

  const printCard = () => {
    const win = iframeRef.current?.contentWindow
    if (!win) {
      message.warning('资料卡还没生成')
      return
    }
    win.focus()
    win.print()
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
            <Text strong>{v}</Text>
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
        <Text style={{ fontSize: 12 }}>报告日期</Text>
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
          placeholder="如：北京朝阳医院"
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
      <Card
        size="small"
        title="① 批量导入"
        extra={
          <Space>
            <Tag>共 {items.length} 张</Tag>
            {pendingCount > 0 && <Tag color="default">待识别 {pendingCount}</Tag>}
            {failedCount > 0 && <Tag color="red">未识别 {failedCount}</Tag>}
            {dupCount > 0 && <Tag color="orange">疑似重复 {dupCount}</Tag>}
          </Space>
        }
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Dragger
            multiple
            accept="image/*"
            showUploadList={false}
            // 注意：antd 对每个文件都会调用一次 beforeUpload，且第二个参数是「整个批次」。
            // 若在这里 addFiles(fileList)，选 2 张就会被加进 2×2=4 条（重复导入）。
            beforeUpload={(file) => {
              addFiles([file])
              return false
            }}
          >
            <p style={{ margin: '8px 0', fontSize: 13 }}>点这里选择图片，或把报告截图拖进来（支持多选）</p>
            <p style={{ margin: 0, fontSize: 12, color: '#8c8c8c' }}>
              也可以直接 Ctrl/⌘+V 粘贴截图。手机把一张单拍成两张时，勾选这两张后点「拼接」。
            </p>
          </Dragger>

          {items.length > 0 && (
            <>
              <Space wrap>
                <Text style={{ fontSize: 12 }}>已勾选 {selected.length}/2（用于拼接）</Text>
                <Button size="small" onClick={doStitch} loading={stitching} disabled={selected.length !== 2}>
                  拼接选中的两张
                </Button>
                <Button size="small" onClick={() => setSelected([])} disabled={!selected.length}>
                  清空勾选
                </Button>
              </Space>

              <Row gutter={[10, 10]}>
                {items.map((item) => {
                  const st = ST[item.status] || ST.pending
                  const picked = selected.includes(item.id)
                  return (
                    <Col xs={24} sm={12} md={8} key={item.id}>
                      <Card
                        size="small"
                        style={{ borderColor: picked ? '#1677ff' : undefined }}
                        title={
                          <Space size={6} wrap>
                            <Tag color={st.color}>{st.label}</Tag>
                            <Text style={{ fontSize: 12 }} ellipsis={{ tooltip: item.name }}>
                              {item.name}
                            </Text>
                          </Space>
                        }
                        extra={
                          <Space size={4}>
                            <Button
                              size="small"
                              type={picked ? 'primary' : 'default'}
                              onClick={() => toggleSelect(item.id)}
                            >
                              {picked ? '已选' : '选'}
                            </Button>
                            <Button size="small" type="text" danger onClick={() => removeItem(item.id)}>
                              删
                            </Button>
                          </Space>
                        }
                      >
                        <Space direction="vertical" size={6} style={{ width: '100%' }}>
                          {item.dataUrl ? (
                            <Image src={item.dataUrl} height={120} style={{ objectFit: 'contain' }} />
                          ) : (
                            <Space>
                              <Spin size="small" />
                              <Text type="secondary" style={{ fontSize: 12 }}>读取中…</Text>
                            </Space>
                          )}
                          <Space size={6} wrap>
                            <Text type="secondary" style={{ fontSize: 12 }}>{fmtSize(item.size)}</Text>
                            {item.source === 'stitch' && <Tag color="blue">拼接图</Tag>}
                            {item.chunked && (
                              <Tooltip
                                title={`拼图过高（h/w ${item.chunkAspect}），Vision 会内部降采样、中间带成片丢行，已切成 ${item.chunks} 块分别识别后合并`}
                              >
                                <Tag color="purple">已切 {item.chunks} 块识别</Tag>
                              </Tooltip>
                            )}
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {item.rows.length ? `${item.rows.length} 行` : '0 行'}
                            </Text>
                          </Space>
                          <Button size="small" onClick={() => recognize(item)} loading={item.status === 'ocr'} block>
                            {item.status === 'done' ? '重新识别' : '识别'}
                          </Button>
                        </Space>
                      </Card>
                    </Col>
                  )
                })}
              </Row>
            </>
          )}

          {items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有图片" />}
        </Space>
      </Card>

      {/* 3 + 4：识别校对与入库 */}
      <Card size="small" title="② 识别与校对（每张可改可删，确认后入库）">
        {items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先导入图片" />
        ) : (
          <Collapse
            accordion={false}
            items={items.map((item) => {
              const st = ST[item.status] || ST.pending
              return {
                key: item.id,
                label: (
                  <Space size={8} wrap>
                    <Tag color={st.color}>{st.label}</Tag>
                    <Text style={{ fontSize: 12 }}>{item.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{item.rows.length} 行</Text>
                    {item.saved && <Tag color="green">已入库</Tag>}
                  </Space>
                ),
                children: renderItemBody(item),
              }
            })}
          />
        )}
      </Card>

      {/* 5：资料卡 */}
      <Card
        size="small"
        title="③ 病友信息与问诊资料卡"
        extra={
          <Space>
            <Text style={{ fontSize: 12 }}>脱敏打印</Text>
            <Switch
              size="small"
              checked={mask}
              onChange={(v) => {
                setMask(v)
                if (card) makeCard(v)
              }}
            />
          </Space>
        }
      >
        <Form form={form} layout="vertical" size="small">
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item name="name" label="姓名">
                <Input placeholder="病友姓名" />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item name="sex" label="性别">
                <Select allowClear options={[{ value: '男', label: '男' }, { value: '女', label: '女' }]} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item name="age" label="年龄">
                <Input placeholder="如 34" />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item name="diagnosis" label="诊断全称">
                <Input placeholder="如 急性B淋巴细胞白血病（B-ALL）" />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item name="subtype" label="分型 / 危险度">
                <Input placeholder="如 B-ALL 高危 / IKZF1 缺失" />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item name="stage" label="当前阶段">
                <Input placeholder="如 诱导缓解第 2 疗程" />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item name="hospital" label="就诊医院">
                <Input placeholder="如 北京朝阳医院" />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item name="attending" label="主管医生（可选）">
                <Input placeholder="可不填" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="focus" label="主诉 / 最担心的事">
                <Input.TextArea rows={2} placeholder="如：化疗后反复发热 2 周" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="confirm" label="想确认的问题">
                <Input.TextArea rows={2} placeholder="如：现在是否达到完全缓解" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="nextVisit" label="下一步该做什么">
                <Input.TextArea rows={2} placeholder="如：是否需要移植评估" />
              </Form.Item>
            </Col>
          </Row>
          <Space wrap>
            <Button onClick={savePatient} loading={patientSaving}>
              保存病友信息
            </Button>
            <Button type="primary" onClick={() => makeCard()} loading={cardLoading}>
              生成资料卡
            </Button>
            <Button onClick={printCard} disabled={!card}>
              打印 / 存 PDF
            </Button>
            {patient?.updatedAt && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                档案更新于 {new Date(patient.updatedAt).toLocaleString('zh-CN')}
              </Text>
            )}
          </Space>
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            身份证、手机号、住址一律不收集（后端会直接丢弃这三类字段）。资料卡不含诊断结论与治疗建议。
          </Paragraph>
        </Form>

        <Divider style={{ margin: '12px 0' }} />

        {cardLoading ? (
          <Space>
            <Spin size="small" />
            <Text type="secondary">生成中…</Text>
          </Space>
        ) : card?.html ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={card.masked ? 'green' : 'orange'}>{card.masked ? '已脱敏（姓名打码）' : '未脱敏'}</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                报告 {card.counts?.reports ?? 0} 份 · 指标 {card.counts?.latest ?? card.counts?.rows ?? 0} 项 ·
                异常 {card.summary?.abnormalCount ?? 0} 项
              </Text>
            </Space>
            <iframe
              ref={iframeRef}
              title="问诊资料卡预览"
              srcDoc={card.html}
              style={{ width: '100%', height: 900, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fff' }}
            />
          </Space>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成资料卡" />
        )}
      </Card>

      {/* 已导入报告 */}
      <Card size="small" title="已导入的报告" extra={<Button size="small" onClick={loadReports}>刷新</Button>}>
        {reports.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有入库的报告" />
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={reports}
            columns={[
              { title: '报告', dataIndex: 'id', width: 150 },
              {
                title: '类型',
                dataIndex: 'kind',
                width: 100,
                render: (v) => KIND_OPTIONS.find((k) => k.value === v)?.label || v || '—',
              },
              { title: '日期', dataIndex: 'reportDate', width: 110, render: (v) => v || '—' },
              { title: '医院', dataIndex: 'hospital', render: (v) => v || '—' },
              { title: '指标行', dataIndex: 'rows', width: 90, render: (v) => (Array.isArray(v) ? v.length : 0) },
            ]}
          />
        )}
      </Card>
    </Space>
  )
}
