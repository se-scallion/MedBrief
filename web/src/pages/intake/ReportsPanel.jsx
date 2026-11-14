// 报告库：已入库报告清单（2026-11-13 从「资料录入」页独立出来，成为 Sider 里的一个菜单项）
//
// 为什么独立：用户抱怨「全杂在一个页面」——录入页应当只做「上传→校对」，
// 报告清单是「查/翻/回看原件」的日常动作，放在录入页底部等于每次都要滚到底。
// 这里自包含取数（不再从 IntakePage 传 reports 进来），页面之间不共享状态。
import React, { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Card, Empty, Input, Modal, Space, Table, Tag, Typography } from 'antd'
import { jget, jpost } from '../../api.js'
import { KIND_OPTIONS } from './shared.js'

const { Text } = Typography

export default function ReportsPanel() {
  const { message } = AntApp.useApp()
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  // 人工纠错（2026-11-14）：展开某份报告 → 改医院/日期/指标行 → 保存
  // 初值必须来自 ?normalized=1（清洗后视图），否则「三列左移」的原始行会在编辑框里错位
  const [editing, setEditing] = useState(null) // { id, hospital, reportDate, rows: [...] }
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await jget('/api/intake/reports')
      // 按报告日期倒序（接口按入库顺序返回，医生要的是「最近做的那张」在最上面）
      const list = (j.reports || []).slice().sort((a, b) => String(b.reportDate || '').localeCompare(String(a.reportDate || '')))
      setReports(list)
    } catch (e) {
      message.error(`报告清单读取失败：${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { load() }, [load])

  const openEdit = useCallback(async (id) => {
    try {
      const j = await jget('/api/intake/reports?normalized=1')
      const rep = (j.reports || []).find((r) => r.id === id)
      if (!rep) return message.error('报告不存在')
      setEditing({
        id,
        hospital: rep.hospital || '',
        reportDate: rep.reportDate || '',
        rows: (rep.rows || []).map((r) => ({ name: r.name || '', value: r.value ?? '', unit: r.unit || '', refRange: r.refRange || '' })),
      })
    } catch (e) { message.error(`读取清洗视图失败：${e.message}`) }
  }, [message])

  const saveEdit = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const { body } = await jpost(`/api/intake/reports/${encodeURIComponent(editing.id)}/patch`, {
        hospital: editing.hospital,
        reportDate: editing.reportDate,
        rows: editing.rows.map((r, index) => ({ index, name: r.name, value: r.value, unit: r.unit, refRange: r.refRange })),
      })
      if (!body.ok) throw new Error(body.error || '保存失败')
      message.success(`已保存 ${body.changed.length} 处修改（旧值已记入 patchLog）`)
      setEditing(null)
      load()
    } catch (e) { message.error(e.message) } finally { setSaving(false) }
  }

  const kw = q.trim()
  const hit = kw
    ? reports.filter((r) => [r.id, r.hospital, r.kind, r.reportDate].filter(Boolean).join(' ').includes(kw))
    : reports
  const totalRows = reports.reduce((a, r) => a + (Array.isArray(r.rows) ? r.rows.length : 0), 0)
  const unstructured = reports.filter((r) => !(Array.isArray(r.rows) && r.rows.length)).length

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 15 }}>报告库</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {reports.length} 份 · 指标 {totalRows} 行 · 未结构化 {unstructured} 份（只存原件，不是解析失败）
          </Text>
        </Space>
        <Space>
          <Input.Search
            allowClear
            size="small"
            placeholder="搜医院 / 日期 / 类型 / 报告号"
            style={{ width: 240 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button size="small" onClick={load} loading={loading}>刷新</Button>
        </Space>
      </div>

      {reports.length === 0 ? (
        <Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有入库的报告，先去「资料录入」上传" /></Card>
      ) : (
        <Card size="small" styles={{ body: { padding: 0 } }}>
          <div className="rb-list">
            <div className="rb-head">
              <span className="c1">日期</span>
              <span className="c2">医院</span>
              <span className="c3">类型</span>
              <span className="c4">指标</span>
              <span className="c5">原件 / 编辑</span>
            </div>
            {hit.map((r) => {
              const n = Array.isArray(r.rows) ? r.rows.length : 0
              return (
                <div className="rb-row" key={r.id}>
                  <span className="c1">{r.reportDate || '—'}</span>
                  <span className="c2" title={r.hospital}>{r.hospital || <Text type="secondary" style={{ fontSize: 12 }}>未填医院</Text>}</span>
                  <span className="c3">{KIND_OPTIONS.find((k) => k.value === r.kind)?.label || r.kind || '—'}</span>
                  <span className="c4">
                    {n > 0 ? `${n} 项` : <Tag color="default">未结构化（仅存原件）</Tag>}
                  </span>
                  <span className="c5">
                    {r.fileBlobId ? (
                      <Button size="small" type="link" onClick={() => window.open(`/api/intake/blob/${encodeURIComponent(r.fileBlobId)}`, '_blank')}>
                        查看原件
                      </Button>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12 }}>{r.source === 'text-only' ? '无原件' : '—'}</Text>
                    )}
                    <Button size="small" type="link" onClick={() => openEdit(r.id)} style={{ paddingInline: 4 }}>编辑</Button>
                  </span>
                </div>
              )
            })}
            {hit.length === 0 && <div className="rb-row"><span>没有匹配「{kw}」的报告</span></div>}
          </div>
        </Card>
      )}

      <Modal
        open={!!editing}
        title={editing ? `编辑报告 ${editing.id}` : '编辑报告'}
        width={900}
        onCancel={() => setEditing(null)}
        onOk={saveEdit}
        okText="保存修改"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        {editing && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap>
              <span>医院：<Input size="small" style={{ width: 200 }} value={editing.hospital} onChange={(e) => setEditing({ ...editing, hospital: e.target.value })} /></span>
              <span>报告日期：<Input size="small" style={{ width: 130 }} value={editing.reportDate} onChange={(e) => setEditing({ ...editing, reportDate: e.target.value })} /></span>
              <Button size="small" type="primary" loading={saving} onClick={saveEdit}>保存修改</Button>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              初值来自清洗后视图；保存只改白名单字段（医院 / 日期 / 指标行的名称·数值·单位·参考区间），旧值会自动记入 patchLog。
            </Text>
            <Table
              size="small"
              rowKey={(_, i) => i}
              pagination={false}
              dataSource={editing.rows}
              columns={[
                { title: '项目', dataIndex: 'name', render: (v, r, i) => <Input size="small" value={v} onChange={(e) => { const rows = editing.rows.slice(); rows[i] = { ...rows[i], name: e.target.value }; setEditing({ ...editing, rows }) }} /> },
                { title: '数值', dataIndex: 'value', width: 130, render: (v, r, i) => <Input size="small" value={v} onChange={(e) => { const rows = editing.rows.slice(); rows[i] = { ...rows[i], value: e.target.value }; setEditing({ ...editing, rows }) }} /> },
                { title: '单位', dataIndex: 'unit', width: 100, render: (v, r, i) => <Input size="small" value={v} onChange={(e) => { const rows = editing.rows.slice(); rows[i] = { ...rows[i], unit: e.target.value }; setEditing({ ...editing, rows }) }} /> },
                { title: '参考区间', dataIndex: 'refRange', width: 130, render: (v, r, i) => <Input size="small" value={v} onChange={(e) => { const rows = editing.rows.slice(); rows[i] = { ...rows[i], refRange: e.target.value }; setEditing({ ...editing, rows }) }} /> },
              ]}
            />
          </Space>
        )}
      </Modal>

      <Alert
        type="info"
        showIcon
        message="原件在哪看？"
        description="资料卡（打印件）不承载任何跳转——纸上点不了，另存转发后链接也是死链。回看原图/PDF 请在这里点「查看原件」。"
      />

      <style>{`
        .rb-list { font-size: 13px; }
        .rb-head, .rb-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid #f2f3f5; }
        .rb-head { color: #6b7280; font-size: 12px; background: #fafafa; }
        .rb-row:hover { background: #fafafa; }
        .rb-head span, .rb-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .c1 { width: 96px; flex: none; }
        .c2 { flex: 1 1 auto; min-width: 0; }
        .c3 { width: 110px; flex: none; }
        .c4 { width: 150px; flex: none; }
        .c5 { width: 150px; flex: none; text-align: right; white-space: nowrap; }
        @media (max-width: 640px) { .c1, .c3, .c4, .c5 { width: auto; } .rb-head { display: none; } .rb-row { flex-wrap: wrap; } }
      `}</style>
    </Space>
  )
}
