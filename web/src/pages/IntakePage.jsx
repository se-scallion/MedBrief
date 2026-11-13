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

// 常量与工具已搬到 ./intake/shared.js（2026-11-13 抽页）；此处只保留页面状态与副作用。
import { ST, KIND_OPTIONS, FLAG_TEXT, uid, fmtSize, rawJson, postJson } from './intake/shared.js'
import UploadPanel from './intake/UploadPanel.jsx'
import ReviewPanel from './intake/ReviewPanel.jsx'
import ProfilePanel from './intake/ProfilePanel.jsx'
import ReportsPanel from './intake/ReportsPanel.jsx'


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
  // 2026-11-13 用户口径：卡片是给医生看的，默认不脱敏；需要给外部转发时再打开
  const [mask, setMask] = useState(false)

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
          lastChemo: j.patient.clinicalContext?.lastChemo || '',
          recentTxOrGcsf: j.patient.clinicalContext?.recentTxOrGcsf || '',
          marrowSummary: j.patient.clinicalContext?.marrowSummary || '',
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
        // v3：第 1 页「临床背景与骨穿节点」区块（可选，只展示不推断；不填就显示「未录入」）
        clinicalContext: {
          lastChemo: v.lastChemo || '',
          recentTxOrGcsf: v.recentTxOrGcsf || '',
          marrowSummary: v.marrowSummary || '',
        },
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

  const openCardInNewWindow = () => {
    if (!card?.html) {
      message.warning('资料卡还没生成')
      return
    }
    const w = window.open('', '_blank')
    if (!w) {
      message.warning('浏览器拦截了新窗口，请允许弹窗后重试')
      return
    }
    w.document.write(card.html)
    w.document.close()
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
      />

      {/* 3 + 4：识别校对与入库 */}
      <ReviewPanel items={items} renderItemBody={renderItemBody} />

      {/* 5：资料卡 */}
      <ProfilePanel
        form={form}
        patient={patient}
        patientSaving={patientSaving}
        savePatient={savePatient}
        card={card}
        cardLoading={cardLoading}
        makeCard={makeCard}
        mask={mask}
        setMask={setMask}
        iframeRef={iframeRef}
        printCard={printCard}
        openCardInNewWindow={openCardInNewWindow}
      />

      {/* 已导入报告 */}
      <ReportsPanel reports={reports} loadReports={loadReports} />
    </Space>
  )
}
