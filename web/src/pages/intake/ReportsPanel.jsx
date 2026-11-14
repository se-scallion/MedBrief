// 报告库：已入库报告清单（2026-11-13 从「资料录入」页独立出来，成为 Sider 里的一个菜单项）
//
// 为什么独立：用户抱怨「全杂在一个页面」——录入页应当只做「上传→校对」，
// 报告清单是「查/翻/回看原件」的日常动作，放在录入页底部等于每次都要滚到底。
// 这里自包含取数（不再从 IntakePage 传 reports 进来），页面之间不共享状态。
//
// 2026-11-14 用户口径：「以后都优先使用已有组件或框架组件」——原本手写的 flex 列表
// （.rb-list / .rb-head / .rb-row）换成 antd `Table`：手写列表拿不到排序箭头、固定表头、
// 分页与列宽拖拽，于是「单号想排序」就得从头造一套。排序口径照 MedData `DataGrid.jsx`：
//   · 点列头三态循环（升 → 降 → 取消），一次只按一列；
//   · **缺失值恒排最后**（升序降序都一样），否则没有单号/日期的行会插到最前面冒充「最新」；
//   · 中文字符串用 `localeCompare(x, 'zh-Hans-CN')`，不是码点序。
//   ⚠️ antd 的 `sorter` 会把比较结果乘以方向（降序时缺值会翻到最前），所以这里用
//   **受控排序**：列头只负责显示箭头（`sorter: true` + `sortOrder`），真正的排序在本文件里做，
//   这样「缺值恒末位」这条才守得住。
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App as AntApp, Button, Card, Empty, Input, Modal, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { jget, jpost } from '../../api.js'
import { KIND_OPTIONS } from './shared.js'
import { DEFAULT_SORT, sortReports, nextSort } from './reportSort.js'

const { Text } = Typography

// 报告日期缺失时，用**入库时间**兜底排序（绝不把导入日期写进 reportDate ——
// 那是临床事实，会被资料卡的时效与趋势直接消费）。两种日期在列里也必须看得出区别。
const kindLabel = (r) => r.reportType || KIND_OPTIONS.find((k) => k.value === r.kind)?.label || r.kind || ''
const rowCountOf = (r) => (Array.isArray(r.rows) ? r.rows.length : 0)
const abnormalOf = (r) => (Array.isArray(r.rows) ? r.rows.filter((x) => ['high', 'low', 'positive'].includes(x.status)).length : 0)
const fmtWhen = (iso) => {
  const t = String(iso || '')
  if (!/^\d{4}-\d{2}-\d{2}T/.test(t)) return t.slice(0, 10) || '—'
  return `${t.slice(5, 10)} ${t.slice(11, 16)}`
}

export default function ReportsPanel() {
  const { message } = AntApp.useApp()
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  // 排序状态（受控）：默认「日期 降」，与「医生最想看最近那张」一致；取消排序时回到这个默认
  const [sort, setSort] = useState(DEFAULT_SORT)
  // 人工纠错（2026-11-14）：展开某份报告 → 改医院/日期/指标行 → 保存
  // 初值必须来自 ?normalized=1（清洗后视图），否则「三列左移」的原始行会在编辑框里错位
  const [editing, setEditing] = useState(null) // { id, hospital, reportDate, rows: [...] }
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await jget('/api/intake/reports')
      setReports(j.reports || []) // 排序交给表格（受控），这里不再预排
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
        reportType: rep.reportType || '',
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
        reportType: editing.reportType,
        rows: editing.rows.map((r, index) => ({ index, name: r.name, value: r.value, unit: r.unit, refRange: r.refRange })),
      })
      if (!body.ok) throw new Error(body.error || '保存失败')
      message.success(`已保存 ${body.changed.length} 处修改（旧值已记入 patchLog）`)
      setEditing(null)
      load()
    } catch (e) { message.error(e.message) } finally { setSaving(false) }
  }

  const kw = q.trim()
  const hit = useMemo(() => (kw
    ? reports.filter((r) => [r.id, r.hospital, r.reportType, r.kind, r.reportDate, r.barcode, r.patientName].filter(Boolean).join(' ').includes(kw))
    : reports), [reports, kw])

  // 受控排序：缺值恒末位 + 中文 localeCompare（见文件头注释）
  const sorted = useMemo(() => {
    // 排序口径全在 reportSort.js（纯函数、可单测）：三态循环 + 缺值恒末位 + 中文 localeCompare。
    // 这里只补一个「显示用的类型标签」，让「看到的顺序」与「排出来的顺序」一致。
    const withLabel = hit.map((r) => ({ ...r, _typeLabel: kindLabel(r) }))
    return sortReports(withLabel, sort)
  }, [hit, sort])

  const totalRows = reports.reduce((a, r) => a + rowCountOf(r), 0)
  const unstructured = reports.filter((r) => rowCountOf(r) === 0).length
  const noOriginal = reports.filter((r) => r.hasOriginal === false).length

  const sortable = (key, extra = {}) => ({
    sorter: true,
    sortOrder: sort.key === key ? sort.order : null,
    ...extra,
  })

  const columns = [
    {
      title: '日期',
      key: 'date',
      width: 150,
      ...sortable('date'),
      render: (_, r) => (r.reportDate
        ? <Text>{r.reportDate}</Text>
        : (
          <Tooltip title="报告日期未识别：按**入库时间**参与排序，不会写进 reportDate（那是临床事实）">
            <Text type="secondary" style={{ fontSize: 12 }}>未提供 · 入库 {fmtWhen(r.createdAt)}</Text>
          </Tooltip>
          )),
    },
    {
      title: '医院',
      key: 'hospital',
      ellipsis: true,
      ...sortable('hospital'),
      render: (_, r) => r.hospital || <Text type="secondary" style={{ fontSize: 12 }}>未填医院</Text>,
    },
    {
      title: '类型',
      key: 'type',
      width: 130,
      ...sortable('type'),
      render: (_, r) => kindLabel(r) || '—',
    },
    {
      title: '单号',
      key: 'barcode',
      width: 150,
      ...sortable('barcode', {
        // 单号有三种前缀（V02… / 20260727G… / P2026…），按字符串排会**按前缀分组**，不等于时间序
        showSorterTooltip: { title: '按单号字符串排序（三种前缀会分组，不等于时间序）；无单号的恒排最后' },
      }),
      render: (_, r) => (r.barcode
        ? <Text code style={{ fontSize: 12 }}>{r.barcode}</Text>
        : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>),
    },
    {
      title: '指标',
      key: 'rows',
      width: 120,
      ...sortable('rows'),
      render: (_, r) => {
        const n = rowCountOf(r)
        return n > 0 ? `${n} 项` : <Tag color="default">全文型（无指标行）</Tag>
      },
    },
    {
      title: '异常',
      key: 'abnormal',
      width: 96,
      ...sortable('abnormal'),
      render: (_, r) => {
        const abn = abnormalOf(r)
        return abn > 0 ? <Tag color="error">{abn} 项</Tag> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
      },
    },
    {
      title: '原件',
      key: 'blob',
      width: 110,
      render: (_, r) => (r.fileBlobId ? (
        <Button size="small" type="link" style={{ paddingInline: 0 }} onClick={() => window.open(`/api/intake/blob/${encodeURIComponent(r.fileBlobId)}`, '_blank')}>
          {r.fileBlobType === 'application/pdf' ? 'PDF' : '原件'}
        </Button>
      ) : (
        <Tooltip title="这份是页面导入的，入库时没有保存原图字节 —— 无法回看/重识别，需要重新导入">
          <Text type="secondary" style={{ fontSize: 12 }}>无原件</Text>
        </Tooltip>
      )),
    },
    {
      title: '操作',
      key: 'op',
      width: 96,
      render: (_, r) => (
        <Space size={2}>
          <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => openEdit(r.id)}>编辑</Button>
          {r.patchedAt && <Tooltip title={`最近改动 ${r.patchedAt}`}><Tag color="success" style={{ marginInlineStart: 0 }}>已核对</Tag></Tooltip>}
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 15 }}>报告库</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {reports.length} 份 · 指标 {totalRows} 行 · 未结构化 {unstructured} 份（只存原件，不是解析失败）
            {noOriginal > 0 && ` · 无原件 ${noOriginal} 份`}
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

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={sorted}
          // 受控排序：只改状态，排序在 useMemo 里做（保证「缺值恒末位」不被 antd 的方向翻转让破坏）
          // 三态循环由 nextSort 决定（升 → 降 → 取消回默认日期降），不依赖 antd 内部怎么算 order ——
          // 我们传的是受控 sortOrder，箭头显示由状态驱动，两边不会打架。
          onChange={(_, __, sorter) => {
            const s = Array.isArray(sorter) ? sorter[0] : sorter
            setSort(nextSort(sort, s?.columnKey || sort.key))
          }}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: (t) => `共 ${t} 份` }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={kw ? `没有匹配「${kw}」的报告` : '还没有入库的报告，先去「资料录入」上传'} /> }}
        />
      </Card>

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
              <span>报告日期：<Input size="small" style={{ width: 130 }} placeholder="YYYY-MM-DD" value={editing.reportDate} onChange={(e) => setEditing({ ...editing, reportDate: e.target.value })} /></span>
              <span>报告类型：<Input size="small" style={{ width: 170 }} placeholder="如 血常规 / 超声-心脏" value={editing.reportType} onChange={(e) => setEditing({ ...editing, reportType: e.target.value })} /></span>
              <Button size="small" type="primary" loading={saving} onClick={saveEdit}>保存修改</Button>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              初值来自清洗后视图；保存只改白名单字段（医院 / 日期 / 类型 / 指标行的名称·数值·单位·参考区间），旧值会自动记入 patchLog。
              报告日期留空就是「未提供」——不要用它代替导入时间。
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
        description="资料卡（打印件）不承载任何跳转——纸上点不了，另存转发后链接也是死链。回看原图/PDF 请在这里点「原件」。标注「无原件」的是页面导入且入库时未保存原图字节，只能重新导入。"
      />
    </Space>
  )
}
