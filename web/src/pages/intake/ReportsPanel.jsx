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
import { Alert, App as AntApp, Button, Card, Descriptions, Drawer, Empty, Grid, Input, Modal, Popconfirm, Segmented, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from 'antd'
import { jget, jpost } from '../../api.js'
import { rawJson } from './shared.js'
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
  // 「查看」抽屉（2026-11-14）：列表接口为省负载把 text 剥掉了，全文型报告在界面上**任何地方都读不到**。
  // 单份详情走 GET /api/intake/reports/:id —— 全文 + 逐行清洗视图 + 原件 + patchLog 一次给全。
  const [viewing, setViewing] = useState(null) // { id, loading, data, error }
  // 回收站（2026-11-14 用户新决策：报告要能删，但必须可恢复 —— 见服务端 10s 段）
  //   tab: active=报告库 / trash=回收站；trashCount 用于顶部入口显示「回收站（N）」
  const [tab, setTab] = useState('active')
  const [trashCount, setTrashCount] = useState(0)
  const [acting, setActing] = useState('') // 正在删除/恢复的那份 id（按钮 loading）
  // 窄屏（<576px，antd xs）适配：2026-11-14 W12 回归 —— 加了「回收站」切换条与「删除」按钮后，
  // 375 视口下 documentElement.scrollWidth 从 415 涨到 432（手机端验收线是「改后 ≤ 改前」）。
  // 做法：xs 下只留「日期/医院/指标/操作」四列，其余列交给详情抽屉；表格不设 min-width；
  //       操作列竖排、按钮文案压到最短。
  const screens = Grid.useBreakpoint()
  const isXs = !screens.sm

  const load = useCallback(async (which = tab) => {
    setLoading(true)
    try {
      const j = await jget(`/api/intake/reports${which === 'trash' ? '?trash=1' : ''}`)
      setReports(j.reports || []) // 排序交给表格（受控），这里不再预排
      setTrashCount(Number(j.trashCount || 0))
    } catch (e) {
      message.error(`报告清单读取失败：${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [message, tab])

  useEffect(() => { load(tab) }, [load, tab])

  // 软删除 → 可在回收站恢复；彻底删除只在回收站里提供（服务端也会拒活报告直接 purge）
  const doDelete = useCallback(async (id) => {
    setActing(id)
    try {
      const { body } = await rawJson(`/api/intake/reports/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!body.ok) throw new Error(body.error || '删除失败')
      message.success(`已移入回收站（共 ${body.trashCount} 份）—— 可在报告库顶部的「回收站」里恢复`)
      load(tab)
    } catch (e) { message.error(e.message) } finally { setActing('') }
  }, [load, tab, message])

  const doRestore = useCallback(async (id) => {
    setActing(id)
    try {
      const { body } = await jpost(`/api/intake/reports/${encodeURIComponent(id)}/restore`, {})
      if (!body.ok) throw new Error(body.error || '恢复失败')
      message.success('已恢复到报告库原位（字段未改动）')
      load(tab)
    } catch (e) { message.error(e.message) } finally { setActing('') }
  }, [load, tab, message])

  const doPurge = useCallback(async (id) => {
    setActing(id)
    try {
      const { body } = await rawJson(`/api/intake/reports/${encodeURIComponent(id)}?purge=1`, { method: 'DELETE' })
      if (!body.ok) throw new Error(body.error || '彻底删除失败')
      message.success(body.bytesKept
        ? '记录已彻底删除；原件字节被其他报告共用，已保留'
        : '记录与原件字节均已彻底删除')
      load(tab)
    } catch (e) { message.error(e.message) } finally { setActing('') }
  }, [load, tab, message])

  const openView = useCallback(async (id) => {
    setViewing({ id, loading: true, data: null, error: '' })
    try {
      const j = await jget(`/api/intake/reports/${encodeURIComponent(id)}`)
      if (!j.ok) throw new Error(j.error || '读取失败')
      setViewing({ id, loading: false, data: j, error: '' })
    } catch (e) {
      setViewing({ id, loading: false, data: null, error: e.message })
    }
  }, [])

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
      width: isXs ? 92 : 150,
      ...sortable('date'),
      ellipsis: isXs,
      render: (_, r) => (r.reportDate
        ? <Text>{isXs ? r.reportDate.slice(5) : r.reportDate}</Text>
        : (
          <Tooltip title={`报告日期未识别（入库 ${fmtWhen(r.createdAt)}）：按入库时间参与排序，不会写进 reportDate`}>
            <Text type="secondary" style={{ fontSize: 12 }}>{isXs ? '未提供' : `未提供 · 入库 ${fmtWhen(r.createdAt)}`}</Text>
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
      responsive: ['md'],   // xs/sm 交给详情抽屉，别撑表格
      ...sortable('type'),
      render: (_, r) => (
        <Space size={4}>
          <span>{kindLabel(r) || '—'}</span>
          {r.reportTypeInferred && (
            <Tooltip title={`按内容推断（${r.inferEvidence || '内容特征'}）。原始单据上没有「报告类型」这一行，可在「编辑」里改`}>
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>推断</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '单号',
      key: 'barcode',
      width: 150,
      responsive: ['md'],   // 单号在手机上看不清也用不上（详情抽屉里有）
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
      width: isXs ? 76 : 120,
      ...sortable('rows'),
      ellipsis: true,
      render: (_, r) => {
        const n = rowCountOf(r)
        if (n > 0) return `${n} 项`
        // 窄屏不放长 Tag：它比列宽还宽，会溢到「操作」列把按钮压在下面（375 实测截图抓到的）。
        // 但也不能显示成「—」—— 那会让「全文型（影像/病理/基因，本来就没有指标行）」和
        // 「解析出 0 项」在手机上看不出区别，家属/医生无从判断该不该点进去看原文。
        return isXs
          ? <Text type="secondary" style={{ fontSize: 12 }} title="全文型：影像/病理/基因这类报告本来就没有指标行，点「查看」看原文">全文</Text>
          : <Tag color="default">全文型（无指标行）</Tag>
      },
    },
    {
      title: '异常',
      key: 'abnormal',
      width: 96,
      responsive: ['sm'],
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
      responsive: ['sm'],   // 手机上「原件」进详情抽屉
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
      width: isXs ? 96 : (tab === 'trash' ? 210 : 170),   // 回收站多一个「彻底删除」，列宽跟着放宽
      render: (_, r) => (
        <Space size={isXs ? 0 : 2} direction={isXs ? 'vertical' : 'horizontal'} style={{ lineHeight: 1.2 }}>
          <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => openView(r.id)}>查看</Button>
          {tab === 'active' ? (
            <>
              {/* 窄屏把「编辑」收进详情抽屉（抽屉里已有编辑入口），操作列只留查看/删除 */}
              {!isXs && <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => openEdit(r.id)}>编辑</Button>}
              <Popconfirm
                title="删除这份报告？"
                description="该报告的指标与分类会一并从资料卡移除；删除后可在报告库顶部的『回收站』里恢复。"
                okText="移入回收站"
                cancelText="不删"
                okButtonProps={{ danger: true }}
                onConfirm={() => doDelete(r.id)}
              >
                <Button size="small" type="link" danger loading={acting === r.id} style={{ paddingInline: 4 }}>删除</Button>
              </Popconfirm>
            </>
          ) : (
            <>
              <Popconfirm
                title="恢复到报告库？"
                description="会回到原位，字段不变（删除时未改动任何字段）。"
                okText="恢复"
                cancelText="取消"
                onConfirm={() => doRestore(r.id)}
              >
                <Button size="small" type="link" loading={acting === r.id} style={{ paddingInline: 4 }}>恢复</Button>
              </Popconfirm>
              <Popconfirm
                title="彻底删除？原件字节也会一并删除，不可恢复。"
                description="只有当没有其他报告共用这份原件时才真的删字节；否则只删记录，字节保留。"
                okText="彻底删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => doPurge(r.id)}
              >
                <Button size="small" type="link" danger loading={acting === r.id} style={{ paddingInline: 4 }}>彻底删除</Button>
              </Popconfirm>
            </>
          )}
          {r.patchedAt && tab === 'active' && !isXs && <Tooltip title={`最近改动 ${r.patchedAt}`}><Tag color="success" style={{ marginInlineStart: 0 }}>已核对</Tag></Tooltip>}
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', maxWidth: '100%' }}>
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 15 }}>报告库</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {reports.length} 份 · 指标 {totalRows} 行 · 未结构化 {unstructured} 份（只存原件，不是解析失败）
            {noOriginal > 0 && ` · 无原件 ${noOriginal} 份`}
          </Text>
        </Space>
        <Space wrap size={6} style={{ maxWidth: '100%' }}>
          <Segmented
            size="small"
            value={tab}
            onChange={(v) => setTab(v)}
            options={[
              { label: '报告库', value: 'active' },
              { label: `回收站${trashCount ? `（${trashCount}）` : ''}`, value: 'trash' },
            ]}
          />
          <Input.Search
            allowClear
            size="small"
            placeholder="搜医院 / 日期 / 类型 / 报告号"
            style={{ width: isXs ? 150 : 240 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button size="small" onClick={load} loading={loading}>刷新</Button>
        </Space>
      </div>

      <Card size="small" styles={{ body: { padding: 0, maxWidth: '100%', overflowX: isXs ? 'hidden' : 'auto' } }}>
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
          scroll={isXs ? undefined : { x: 'max-content' }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={kw ? `没有匹配「${kw}」的报告` : (tab === 'trash' ? '回收站是空的' : '还没有入库的报告，先去「资料录入」上传')} /> }}
        />
      </Card>

      <Drawer
        open={!!viewing}
        onClose={() => setViewing(null)}
        width={760}
        destroyOnHidden
        title={viewing ? `报告内容 · ${viewing.id}` : '报告内容'}
        extra={(
          <Space wrap>
            {/* 窄屏操作列放不下「编辑」，入口收进抽屉（桌面端列表里仍有） */}
            {viewing?.data?.report && tab === 'active' && (
              <Button size="small" onClick={() => { const id = viewing.data.report.id; setViewing(null); openEdit(id) }}>编辑</Button>
            )}
            {viewing?.data?.originals?.length ? viewing.data.originals.map((o) => (
              <Button key={o.blobId} size="small" onClick={() => window.open(`/api/intake/blob/${encodeURIComponent(o.blobId)}`, '_blank')}>
                {o.type === 'application/pdf' ? 'PDF 原件' : '查看原件'}
              </Button>
            )) : <Text type="secondary" style={{ fontSize: 12 }}>无原件</Text>}
          </Space>
        )}
      >
        {viewing?.loading && <Spin />}
        {viewing?.error && <Alert type="error" showIcon message={`读取失败：${viewing.error}`} />}
        {viewing?.data && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={2} bordered items={[
              { key: 'date', label: '报告日期', children: viewing.data.report.reportDate || '未提供（只看入库时间）' },
              { key: 'created', label: '入库时间', children: fmtWhen(viewing.data.report.createdAt) },
              { key: 'hospital', label: '医院', children: viewing.data.report.hospital || '未填' },
              {
                key: 'type',
                label: '类型',
                children: (
                  <Space size={4}>
                    <span>{kindLabel(viewing.data.report) || '—'}</span>
                    {viewing.data.report.reportTypeInferred && <Tag color="orange">推断</Tag>}
                  </Space>
                ),
              },
              { key: 'barcode', label: '单号', children: viewing.data.report.barcode || '—' },
              { key: 'rows', label: '指标行', children: `${viewing.data.rows.length} 行（原始 ${viewing.data.rawRows.length} 行）` },
            ]} />
            <Tabs
              defaultActiveKey={viewing.data.rows.length ? 'rows' : 'text'}
              items={[
                {
                  key: 'rows',
                  label: `指标（${viewing.data.rows.length}）`,
                  children: viewing.data.rows.length ? (
                    <Table
                      size="small"
                      rowKey={(_, i) => i}
                      pagination={viewing.data.rows.length > 50 ? { pageSize: 50 } : false}
                      dataSource={viewing.data.rows}
                      scroll={{ y: 420 }}
                      columns={[
                        { title: '项目', dataIndex: 'name', render: (v, r) => <span>{v}{r.nameDirty && <Tag color="warning" style={{ marginInlineStart: 4 }}>名称待核</Tag>}{r.noteRow && <Tag>说明文本·已剔除</Tag>}</span> },
                        { title: '数值', dataIndex: 'value', width: 150, render: (v, r) => <span>{v}{r.unit ? ` ${r.unit}` : ''}</span> },
                        { title: '参考区间', dataIndex: 'refRange', width: 130, render: (v) => v || '—' },
                      ]}
                    />
                  ) : <Text type="secondary">这份报告没有指标行（全文型：结论/病理/影像），请看「原文」。</Text>,
                },
                {
                  key: 'text',
                  label: '原文（OCR 全文）',
                  children: (
                    <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 4, padding: 10, maxHeight: 460, overflow: 'auto', margin: 0 }}>
                      {viewing.data.report.text || '（这份报告没有保存全文）'}
                    </pre>
                  ),
                },
                {
                  key: 'log',
                  label: `改动记录（${(viewing.data.patchLog || []).length}）`,
                  children: (viewing.data.patchLog || []).length ? (
                    <Table
                      size="small"
                      rowKey={(_, i) => i}
                      pagination={false}
                      dataSource={viewing.data.patchLog}
                      columns={[
                        { title: '时间', dataIndex: 'at', width: 160, render: (v) => fmtWhen(v) },
                        { title: '字段', dataIndex: 'field', width: 140 },
                        { title: '原值', dataIndex: 'from', ellipsis: true },
                        { title: '新值', dataIndex: 'to', ellipsis: true },
                      ]}
                    />
                  ) : <Text type="secondary">没有人工改动记录。</Text>,
                },
              ]}
            />
          </Space>
        )}
      </Drawer>

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
