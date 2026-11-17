// 原件溯源与指标详情弹窗（2026-11-14 用户口径）
//
// 为什么是「宽弹窗」而不是右侧窄抽屉：原件既有宽幅 A4 扫描/PDF，又有细长手机截图
// （实测真实库 65 个原件：jpeg 25 / png 33 / application-pdf 7），窄抽屉里两者都看不清。
//
// 布局：左 ~62% 原件预览器，右 ~38% 数据侧（报告头 / 该指标全历史 / 同报告其他指标 / 修正数值）。
// 边界：报告没有原件时（实测 1 份）→ 明确说「仅存结构化数据，无原件」，右栏数据照常显示。
// 修正：一律走 `buildRowPatch()` 提交 **name/value/unit/refRange 四元组** ——
//       只提交 value 会把左移行还原出来的参考区间永久丢掉（见 shared.js 注释与 verify-rowpatch.mjs）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Descriptions, Divider, Empty, Input, Modal, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd'
import { jpost } from '../../api.js'
import { buildRowPatch } from '../intake/shared.js'

const { Text } = Typography

const FLAG_TAG = {
  high: <Tag color="red">▲ 高</Tag>,
  low: <Tag color="green">▽ 低</Tag>,
  normal: <Tag>正常</Tag>,
}

/** 迷你折线（只画数值点；不依赖任何图表库，SVG 直接出，灰阶打印也分得清） */
function MiniTrend({ points = [], height = 96 }) {
  const vals = points.filter((p) => Number.isFinite(Number(p.num)))
  if (vals.length < 2) return <Text type="secondary" style={{ fontSize: 12 }}>仅 {vals.length} 个数值点，不足以看趋势</Text>
  const w = 420
  const pad = { l: 34, r: 24, t: 10, b: 16 }
  const nums = vals.map((p) => Number(p.num))
  let min = Math.min(...nums)
  let max = Math.max(...nums)
  if (max === min) { max += 1; min -= 1 }
  const x = (i) => pad.l + (i * (w - pad.l - pad.r)) / (vals.length - 1)
  const y = (v) => height - pad.b - ((v - min) / (max - min)) * (height - pad.t - pad.b)
  const path = vals.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.num)).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} style={{ display: 'block' }}>
      <line x1={pad.l} y1={height - pad.b} x2={w - pad.r} y2={height - pad.b} stroke="#d1d5db" strokeWidth="0.8" />
      <path d={path} fill="none" stroke="#2563eb" strokeWidth="1.5" />
      {vals.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(Number(p.num))} r="2.8"
          fill={p.flag === 'high' || p.flag === 'low' ? '#111827' : '#fff'} stroke="#111827" strokeWidth="0.9" />
      ))}
      {vals.map((p, i) => (
        <text key={`d${i}`} x={x(i)} y={height - 4} fontSize="8.5" fill="#9ca3af" textAnchor="middle">{String(p.date || '').slice(5)}</text>
      ))}
    </svg>
  )
}

export default function SourceModal({ open, target, card, onClose, onSaved }) {
  const { message } = AntApp.useApp()
  const [blobUrl, setBlobUrl] = useState('')
  const [blobKind, setBlobKind] = useState('')   // 'image' | 'pdf' | 'none'
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [scale, setScale] = useState(1)
  const [rotate, setRotate] = useState(0)
  const [fit, setFit] = useState('width')        // 'width' | 'height' | 'free'
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState(null)   // { name, value, unit, refRange }
  const [saving, setSaving] = useState(false)
  const urlRef = useRef('')
  // 2026-11-17 移动端版面：≤575 走整屏弹窗 + 单行横滑工具栏 + 8px 内距（桌面 12px）
  const previewRef = useRef(null)
  const [nat, setNat] = useState({ w: 0, h: 0 })          // 原件自然尺寸（旋转适配用）
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 })  // 预览容器尺寸
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 575px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 575px)')
    const on = () => setIsNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const report = useMemo(
    () => (card?.timeline || []).find((r) => r.id === target?.reportId) || null,
    [card, target],
  )
  // 该指标的全历史（有 code 就用 code 键；否则用规范化名称键）
  const history = useMemo(() => {
    if (!card?.historyByCode || !target) return null
    const keys = Object.keys(card.historyByCode)
    const byCode = target.code && card.historyByCode[target.code]
    if (byCode) return byCode
    const byRow = keys.find((k) => card.historyByCode[k].points.some((p) => p.rowKey === target.rowKey))
    if (byRow) return card.historyByCode[byRow]
    return historyByKeyFallback(card, target)
  }, [card, target])

  // 同报告下的其他指标
  const siblings = useMemo(
    () => (card?.latestRows || []).filter((r) => r.reportId && r.reportId === target?.reportId).slice(0, 12),
    [card, target],
  )

  const reset = useCallback(() => {
    setScale(1); setRotate(0); setFit('width'); setPage(1); setEditing(null); setErr('')
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = '' }
    setBlobUrl(''); setBlobKind('')
  }, [])

  // 打开时按需拉原件（fetch → blob.type 判定图片/PDF，避免再改后端契约）
  useEffect(() => {
    if (!open) { reset(); return }
    const id = target?.fileBlobId
    if (!id) { setBlobKind('none'); return }
    let alive = true
    setLoading(true); setErr('')
    fetch(`/api/intake/blob/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`原件读取失败（HTTP ${res.status}）`)
        const blob = await res.blob()
        if (!alive) return
        const url = URL.createObjectURL(blob)
        urlRef.current = url
        setBlobUrl(url)
        setBlobKind(/pdf/i.test(blob.type) ? 'pdf' : /^image\//i.test(blob.type) ? 'image' : 'pdf')
      })
      .catch((e) => { if (alive) { setErr(e.message); setBlobKind('none') } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, target?.fileBlobId, reset])

  const startEdit = () => {
    const p = history?.points?.find((x) => x.rowKey === target?.rowKey) || history?.points?.[history.points.length - 1]
    if (!p) return message.warning('没有可编辑的数值点')
    setEditing({ name: p.name || history.name, value: p.value, unit: p.unit, refRange: p.refRange })
  }

  const saveEdit = async () => {
    if (!editing || target?.rowIndex == null) return message.warning('缺少行位置，无法修正')
    setSaving(true)
    try {
      // 四元组回写（见 shared.js buildRowPatch 注释：只写 value 会丢参考区间）
      const row = { name: editing.name, value: editing.value, unit: editing.unit, refRange: editing.refRange }
      const [patch] = buildRowPatch([row])
      // 同上：jpost 返回的是 body 本身，不是 { body }（rawJson/postJson 才返回 { httpStatus, body }）
      const body = await jpost(`/api/intake/reports/${encodeURIComponent(target.reportId)}/patch`, {
        rows: [{ ...patch, index: target.rowIndex }],
      })
      if (!body.ok) throw new Error(body.error || '保存失败')
      if (!body.changed || !body.changed.length) message.info('内容没有变化，未写入')
      else message.success(`已修正 ${body.changed.length} 处（旧值已记入 patchLog）`)
      setEditing(null)
      onSaved && onSaved()
    } catch (e) { message.error(e.message) } finally { setSaving(false) }
  }

  const zoomIn = () => { setFit('free'); setScale((s) => Math.min(4, +(s + 0.2).toFixed(2))) }
  const zoomOut = () => { setFit('free'); setScale((s) => Math.max(0.2, +(s - 0.2).toFixed(2))) }

  // U23（审核 r1）：旋转 90° 后宽高互换，CSS transform 不进 layout/scroll 尺寸 ⇒ 实测左裁 73px。
  // 解法：旋转时按**旋转后**包围盒重算宽高（wrapper 用 layout 尺寸承载，图片在内部居中旋转），
  // 于是 scale=1 时必然落在容器内；zoom>1 时 wrapper 变大、容器双向可滚。
  const rotated90 = rotate % 180 === 90
  const fitRot = (nat.w && boxSize.w && boxSize.h)
    ? Math.min(boxSize.w / nat.h, boxSize.h / nat.w)
    : 0

  const imgStyle = fit === 'height'
    ? { maxHeight: '100%', maxWidth: 'none', objectFit: 'contain', transform: `rotate(${rotate}deg)`, transformOrigin: 'center center' }
    : fit === 'width'
      ? { width: '100%', height: 'auto', transform: `rotate(${rotate}deg)`, transformOrigin: 'center center' }
      : { width: `${scale * 100}%`, maxWidth: 'none', height: 'auto', transform: `rotate(${rotate}deg)`, transformOrigin: 'center center' }

  // 预览容器尺寸（ResizeObserver）：旋转适配要按当前可视区重算
  useEffect(() => {
    const el = previewRef.current
    if (!el) return undefined
    const sync = () => setBoxSize({ w: el.clientWidth, h: el.clientHeight })
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, blobKind])

  const title = target?.name ? `原件溯源 · ${target.name}` : '原件溯源'
  // 每侧水平内距：统一 12（主理人 2026-11-17 改判，原「手机 8」作废）；改前是 body 12 + 左栏 8 = 20 双层
  const EDGE = 12
  // 图片可视高：手机按可视视口（100dvh —— iOS 地址栏展开/收起都算准）扣头部/工具栏/footer 预算；
  // 桌面 min380 + 扣 240。禁用 100vh：iOS Safari 会把地址栏算进去，底部按钮被遮。
  const IMG_H = 'calc(100dvh - 220px)'

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      width={isNarrow ? '100vw' : '92vw'}
      style={isNarrow ? { top: 0, maxWidth: '100vw', margin: 0, paddingBottom: 0 } : { maxWidth: 1120, top: 24 }}
      rootClassName="mb-src-modal"
      styles={{
        // 内距只留一层（主理人 2026-11-17 改判：统一 12px）：body 0、左栏 12、header paddingInline 12
        // ⇒ 每侧内距 = 12（改前是 body 12 + 左栏 8 = 20 双层叠加），标题/工具栏/原件三缘同一条线
        // U4（2026-11-17 实测）：375 下改前弹窗总高 1598px（> 视口 812），整页跟着滚、体验碎片化。
        // 手机改为 body 内部滚动（maxHeight = 视口 − 头部/底部预算 140（实测 812−140 后弹窗总高收在视口内）），弹窗本身收在视口内。
        // L11（审核 r1）：dialog.h ≤ 视口 − 96 ⇒ body 上限 = 100dvh − 176（头部+footer ≈76 + 96 余量），
        // 两档同一套；**禁 100vh**（iOS 地址栏会遮底部）。底部再让 safe-area。
        body: { padding: 0, maxHeight: 'calc(100dvh - 176px)', overflowY: 'auto', ...(isNarrow ? { paddingBottom: 'env(safe-area-inset-bottom)' } : {}) },
        header: { paddingInline: EDGE },
      }}
      footer={[
        <Text key="hint" type="secondary" style={{ fontSize: 12, float: 'left', lineHeight: '24px' }}>
          原件来自导入时的原始图片 / PDF，只读；数值以原件为准
        </Text>,
        <Button key="close" onClick={onClose}>关闭</Button>,
      ]}
      destroyOnClose={false}
    >
      <style>{`
        /* P0-2（AI 审核 r1）：antd 的 .ant-modal-container 自带 padding 20/24，实测把「标题/工具栏/原件」
           左缘顶到距屏 32-36px。**两个视口都归零**：1440 实测 dlg.x=160/w=1120、leftCol.x=184、title.x=196
           ⇒ container 24 也在吃内距，只清 375 会留下 1440 的 36px 假绿。 */
        .mb-src-modal .ant-modal-container { padding: 0 !important; }
      `}</style>
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* ---------- 左：原件预览器（~62%；窄屏由 CardPage 的 .mb-source-left 改 flex-basis:100% 堆叠） ---------- */}
        <div className="mb-source-left" style={{ flex: '1 1 58%', minWidth: 0, background: 'transparent', borderRadius: 0, padding: EDGE, display: 'flex', flexDirection: 'column' }}>
          {/* P0-2（AI 审核 r1）：①无原件时缩放/旋转无意义 ⇒ 整条工具栏隐藏，把首屏让给元数据与历史；
              ②手机单行横滑但**不得裁按钮**：文案精简（适宽/适高/旋转）+ 横向滚动。 */}
          {blobKind === 'none' ? null : (
          <Space size={4} wrap={!isNarrow} style={isNarrow ? { marginBottom: 8, overflowX: 'auto', whiteSpace: 'nowrap', height: 32, width: '100%', flexWrap: 'nowrap' } : { marginBottom: 8 }}>
            <Button size="small" onClick={zoomOut} disabled={blobKind !== 'image'}>{isNarrow ? '−' : '− 缩小'}</Button>
            <Button size="small" onClick={zoomIn} disabled={blobKind !== 'image'}>{isNarrow ? '＋' : '＋ 放大'}</Button>
            <Button size="small" type={fit === 'width' ? 'primary' : 'default'} onClick={() => { setFit('width'); setScale(1) }}>{isNarrow ? '适宽' : '适应宽度'}</Button>
            <Button size="small" type={fit === 'height' ? 'primary' : 'default'} onClick={() => { setFit('height'); setScale(1) }}>{isNarrow ? '适高' : '适应高度'}</Button>
            <Tooltip title="PDF 由浏览器原生查看器渲染，不支持旋转（只能旋转图片）">
              <Button size="small" disabled={blobKind !== 'image'} onClick={() => setRotate((r) => (r + 90) % 360)}>{isNarrow ? '旋转' : '旋转 90°'}</Button>
            </Tooltip>
            {blobKind === 'pdf' && (
              <Space size={2}>
                <Button size="small" onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
                <Text style={{ fontSize: 12 }}>第</Text>
                <Input size="small" style={{ width: 48 }} value={page} onChange={(e) => setPage(Math.max(1, Number(e.target.value) || 1))} />
                <Text style={{ fontSize: 12 }}>页</Text>
                <Button size="small" onClick={() => setPage((p) => p + 1)}>下一页</Button>
              </Space>
            )}
            {blobKind === 'image' && <Text type="secondary" style={{ fontSize: 12 }}>{Math.round(scale * 100)}%</Text>}
          </Space>
          )}
          <div ref={previewRef} style={{ flex: 1, minHeight: blobKind === 'none' ? 96 : (isNarrow ? IMG_H : 380), maxHeight: blobKind === 'none' ? 120 : (isNarrow ? IMG_H : 'calc(100dvh - 240px)'), overflow: 'auto', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: 4, display: 'flex', alignItems: rotated90 ? 'flex-start' : 'flex-start', justifyContent: rotated90 ? 'flex-start' : 'center' }}>
            {loading ? <Spin style={{ marginTop: 80 }} />
              : err ? <Alert type="error" showIcon message={err} style={{ margin: 16 }} />
                : blobKind === 'image' ? (rotated90 && fitRot > 0
                  ? (
                    <div style={{ width: nat.h * fitRot * scale, height: nat.w * fitRot * scale, position: 'relative', flex: '0 0 auto' }}>
                      <img src={blobUrl} alt="原件" onLoad={(e) => setNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
                        style={{ position: 'absolute', left: '50%', top: '50%', width: nat.w * fitRot * scale, height: nat.h * fitRot * scale, maxWidth: 'none', maxHeight: 'none', transform: 'translate(-50%,-50%) rotate(90deg)' }} />
                    </div>
                  )
                  : <img src={blobUrl} alt="原件" onLoad={(e) => setNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })} style={imgStyle} />)
                  : blobKind === 'pdf' ? <iframe title="原件 PDF" src={`${blobUrl}#page=${page}&zoom=page-width`} style={{ width: '100%', height: '66vh', border: 'none' }} />
                    : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '12px 0' }} description="该报告没有存原件（仅结构化数据）" />}
          </div>
        </div>

        {/* ---------- 右：报告头 + 该指标全历史 + 同报告其他指标（~38%；窄屏堆叠） ---------- */}
        <div className="mb-source-right" style={{ flex: '1 1 34%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Descriptions size="small" column={1} bordered
            items={[
              { key: 'd', label: '报告日期', children: report?.date || target?.date || '—' },
              { key: 't', label: '类型', children: report?.reportType || report?.kind || '—' },
              { key: 'h', label: '医院', children: (report?.hospital || target?.hospital) || '未记录' },
              { key: 'n', label: '报告单号', children: report?.reportNo || '未识别' },
              { key: 'g', label: '报告时间', children: report?.reportTime || '未识别' },
            ]}
          />

          <div>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text strong>{history?.name || target?.name}</Text>
              <Space size={4}>
                {history?.unit ? <Text type="secondary" style={{ fontSize: 12 }}>{history.unit}</Text> : null}
                <Tag color="default">{history?.count ?? 0} 次</Tag>
              </Space>
            </Space>
            <MiniTrend points={history?.points || []} />
            <Table
              size="small"
              rowKey={(r) => r.rowKey || `${r.date}-${r.value}`}
              pagination={false}
              scroll={{ y: 168 }}
              dataSource={[...(history?.points || [])].reverse()}
              columns={[
                { title: '日期', dataIndex: 'date', width: 84, render: (v) => String(v).slice(5) },
                { title: '数值', render: (_, r) => <span>{r.value}{r.unit ? ` ${r.unit}` : ''}</span> },
                { title: '参考', dataIndex: 'refRange', render: (v) => v || '—' },
                { title: '判定', dataIndex: 'flag', width: 68, render: (v) => FLAG_TAG[v] || <Text type="secondary">—</Text> },
              ]}
            />
          </div>

          <Divider style={{ margin: '4px 0' }} />

          <div>
            <Text strong style={{ fontSize: 13 }}>同报告的其他指标</Text>
            <Table
              size="small"
              rowKey={(r) => r.rowKey || r.name}
              pagination={false}
              scroll={{ y: 150 }}
              dataSource={siblings}
              locale={{ emptyText: '这份报告没有可关联的指标行（多为影像/病理）' }}
              columns={[
                { title: '项目', dataIndex: 'name', ellipsis: true },
                { title: '数值', width: 120, render: (_, r) => `${r.value ?? ''}${r.unit ? ' ' + r.unit : ''}` },
                { title: '判定', dataIndex: 'flag', width: 68, render: (v) => FLAG_TAG[v] || <Text type="secondary">—</Text> },
              ]}
            />
          </div>

          <div>
            {!editing ? (
              <Button block disabled={target?.rowIndex == null} onClick={startEdit}>
                修正数值（走 patch，旧值记入 patchLog）
              </Button>
            ) : (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Alert type="warning" showIcon style={{ padding: '4px 8px' }}
                  message="整行回写：名称/数值/单位/参考区间会一起写入（只写数值会把左移行还原出的参考区间丢掉）" />
                <Input addonBefore="项目" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <Space.Compact style={{ width: '100%' }}>
                  <Input addonBefore="数值" value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
                  <Input addonBefore="单位" style={{ width: 150 }} value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })} />
                </Space.Compact>
                <Input addonBefore="参考" value={editing.refRange} onChange={(e) => setEditing({ ...editing, refRange: e.target.value })} />
                <Space>
                  <Button type="primary" size="small" loading={saving} onClick={saveEdit}>保存</Button>
                  <Button size="small" onClick={() => setEditing(null)}>取消</Button>
                  <Text type="secondary" style={{ fontSize: 12 }}>不提供删除</Text>
                </Space>
              </Space>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** 没有 code 的兜底：按「同名历史」找 */
function historyByKeyFallback(card, target) {
  const name = target?.name
  if (!name) return null
  for (const k of Object.keys(card.historyByCode || {})) {
    const h = card.historyByCode[k]
    if (h.name === name) return h
  }
  return null
}
