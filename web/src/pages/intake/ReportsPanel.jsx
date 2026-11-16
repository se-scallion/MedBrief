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
// D2（2026-11-15 用户拍板 + 代诊-Manager 审核放行）：报告库编辑态**直接复用 MedData 的指标行
// 组件 DataGrid**，不再手写 5 个裸 Input。它与「资料导入」tab 里用的是同一个组件、同一个 bundle
// （见 web/vite.config.js 的 meddataAdapter），所以代码列、审计色、一键修正、粘贴解析都在。
// 样式：embedded.css（Tailwind 产物）只在需要它的页面引入；这里跟着组件一起引。
import DataGrid from '../../../../meddata/src/components/DataGrid.jsx'
import { getOps, clearOps } from '../../../../meddata/src/utils/oplog.js'
import '../../meddata/embedded.css'

const { Text } = Typography

// 报告日期缺失时，用**入库时间**兜底排序（绝不把导入日期写进 reportDate ——
// 那是临床事实，会被资料卡的时效与趋势直接消费）。两种日期在列里也必须看得出区别。
const kindLabel = (r) => r.reportType || KIND_OPTIONS.find((k) => k.value === r.kind)?.label || r.kind || ''
const rowCountOf = (r) => (Array.isArray(r.rows) ? r.rows.length : 0)
// 我们的行长这样：{ name, value, unit, refRange, code, status }
// DataGrid 的 point 长这样：{ _row, _item_no, standard_code, original_name, value, unit, ref_range, arrow }
// 两个方向都要映射，而且**保存时只回吐 patch 认的 5 个字段**（否则 patch 段记不到，见方案 F6）。
// 报告内容抽屉 · ≤575px 窄屏样式（2026-11-16 用户实测：4 列固定宽 Table 在 375 下
// 把「项目」列压成一列竖排单字、并与「数值」重叠）。只在打开报告库页时注入、卸载即移除：
//   · 指标行改为「代码 + 值 + 参考」三行块卡片，名称整行两行截断，永不竖排；
//   · Descriptions 改一列（column={1} 由 isXs 控制，这里只兜住 antd 的 label/内容宽度）；
//   · Tabs 标签允许横向滚动，不把「改动记录」挤成「改动…」。
// 桌面 ≥576px 一条都不匹配，Table 与 Descriptions 保持原样。
const REPORT_DRAWER_MOBILE_CSS = `
@media (max-width: 575px) {
  .rb-detail .ant-descriptions-item-label { width: 84px !important; white-space: nowrap; }
  .rb-detail .ant-descriptions-item-content { word-break: break-all; }
  .rb-detail .ant-tabs-nav { margin-bottom: 8px; }
  .rb-detail .ant-tabs-nav-list { flex: 0 0 auto !important; }
  .rb-detail .ant-tabs-nav-wrap { overflow-x: auto !important; }
  .rb-detail .ant-tabs-tab { padding-inline: 10px !important; }
}
.rb-row-card { border-bottom: 1px solid #f0f0f0; padding: 10px 4px; }
.rb-row-card:last-child { border-bottom: 0; }
.rb-row-card .rb-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rb-row-card .rb-row-name { font-size: 13px; font-weight: 600; color: #1f2937; line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rb-row-card .rb-row-value { font-size: 13px; color: #111827; white-space: nowrap; flex: 0 0 auto; }
.rb-row-card .rb-row-sub { margin-top: 4px; font-size: 11px; color: #6b7280; display: flex; gap: 10px; flex-wrap: wrap; }
.rb-row-card .rb-row-sub code { font-size: 11px; }
`

const toPoints = (rows = []) => (rows || []).map((r, i) => ({
  _row: i,
  _item_no: i + 1,
  standard_code: r.code || '',
  original_name: r.name || '',
  value: r.value ?? '',
  unit: r.unit || '',
  ref_range: r.refRange || '',
  arrow: r.flag === 'high' ? '↑' : r.flag === 'low' ? '↓' : '',
}))
const fromPoints = (points = []) => (points || []).map((p) => ({
  name: p.original_name || p.name || '',
  value: p.value ?? '',
  unit: p.unit || '',
  refRange: p.ref_range || '',
  code: p.standard_code || '',
}))
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
  // ≤575px 注入报告抽屉窄屏样式；离开页面即移除（与 CardPage 同款，不污染其它页面）
  useEffect(() => {
    const style = document.createElement('style')
    style.id = 'mb-report-drawer-mobile'
    style.textContent = REPORT_DRAWER_MOBILE_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

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
      // 走详情接口：它同时给「清洗后视图」（编辑初值，带 code）与「原始行」（= 基线，
      // 供 DataGrid 算「哪些字段被改过」与「清空本次」用）。列表接口为省负载把 text 剥掉了。
      const j = await jget(`/api/intake/reports/${encodeURIComponent(id)}`)
      if (!j.ok) throw new Error(j.error || '报告不存在')
      const rep = j.report || {}
      clearOps() // 每次开编辑清空上一次的操作序列（会话级单例）
      setEditing({
        id,
        hospital: rep.hospital || '',
        reportDate: rep.reportDate || '',
        reportType: rep.reportType || '',
        text: j.report?.text || '',
        points: toPoints(j.rows || []),
        baselinePoints: toPoints(j.rawRows || []),
      })
    } catch (e) { message.error(`读取报告失败：${e.message}`) }
  }, [message])

  const saveEdit = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const rows = fromPoints(editing.points)
      const { body } = await jpost(`/api/intake/reports/${encodeURIComponent(editing.id)}/patch`, {
        hospital: editing.hospital,
        reportDate: editing.reportDate,
        reportType: editing.reportType,
        // 只回吐 patch 白名单认的 5 个字段（code 只用于显示，不进 patch —— 方案 F6）
        rows: rows.map((r, index) => ({ index, name: r.name, value: r.value, unit: r.unit, refRange: r.refRange })),
      })
      if (!body.ok) throw new Error(body.error || '保存失败')
      // 「用户怎么操作的」单独落 corrections 表（只追加、绝不回灌）。保存失败就不上报，
      // 否则会在库里留下「操作了但没生效」的假记录（方案 D1 / F2）。
      const ops = getOps()
      if (ops.length) {
        try {
          await jpost(`/api/intake/reports/${encodeURIComponent(editing.id)}/corrections`, {
            ops, sessionId: `${editing.id}-${Date.now().toString(36)}`,
          })
        } catch { /* 反馈失败不影响保存结果，但用户已在界面上得到保存成功提示 */ }
        clearOps()
      }
      message.success(`已保存 ${body.changed.length} 处修改（旧值已记入 patchLog，操作记录 ${ops.length} 条）`)
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
        width="min(760px, 96vw)"   // 375 下不再硬撑 760px（会把手势区/标题挤出屏）
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
          <div className="rb-detail">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={isXs ? 1 : 2} bordered items={[
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
                  children: viewing.data.rows.length ? (isXs ? (
                    // ≤575px：行块卡片。彻底避开「4 列固定宽 → 项目列被压成竖排单字 + 与数值重叠」。
                    // 名称整行两行截断、值右对齐不换行；代码/单位/参考区间放第二行，信息一个不丢。
                    <div style={{ maxHeight: '58vh', overflowY: 'auto' }}>
                      {viewing.data.rows.map((r, i) => (
                        <div className="rb-row-card" key={i}>
                          <div className="rb-row-head">
                            <span className="rb-row-name" title={r.name}>{r.name || '（没认出名字）'}
                              {r.nameDirty && <Tag color="warning" style={{ marginInlineStart: 4 }}>名称待核</Tag>}
                              {r.noteRow && <Tag>说明文本·已剔除</Tag>}
                            </span>
                            <span className="rb-row-value">{r.value}{r.unit ? ` ${r.unit}` : ''}</span>
                          </div>
                          <div className="rb-row-sub">
                            <span>代码 {r.code ? <code>{r.code}</code> : '—'}</span>
                            <span>参考 {r.refRange || '—'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Table
                      size="small"
                      rowKey={(_, i) => i}
                      pagination={viewing.data.rows.length > 50 ? { pageSize: 50 } : false}
                      dataSource={viewing.data.rows}
                      scroll={{ y: 420 }}
                      columns={[
                        // 指标代码（2026-11-15 用户要求「还得显示指标代码」）：code 是详情接口读出时
                        // 用 classifyAnalyte 现算的（不落库，避免与识别结果形成两份真相）。认不出就写「—」。
                        { title: '代码', dataIndex: 'code', width: 92, render: (v) => (v ? <code style={{ fontSize: 12 }}>{v}</code> : <Text type="secondary">—</Text>) },
                        { title: '项目', dataIndex: 'name', render: (v, r) => <span>{v}{r.nameDirty && <Tag color="warning" style={{ marginInlineStart: 4 }}>名称待核</Tag>}{r.noteRow && <Tag>说明文本·已剔除</Tag>}</span> },
                        { title: '数值', dataIndex: 'value', width: 150, render: (v, r) => <span>{v}{r.unit ? ` ${r.unit}` : ''}</span> },
                        { title: '参考区间', dataIndex: 'refRange', width: 130, render: (v) => v || '—' },
                      ]}
                    />
                  )) : <Text type="secondary">这份报告没有指标行（全文型：结论/病理/影像），请看「原文」。</Text>,
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
          </div>
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
            {/* 医院在 DataGrid 里没有对应输入（它只管日期/类型/指标行），所以留在这里；
                报告日期与报告类型已由下方 DataGrid 自带输入框接管（同一份 state，不会两处打架）。 */}
            <Space wrap>
              <span>医院：<Input size="small" style={{ width: 220 }} value={editing.hospital} onChange={(e) => setEditing({ ...editing, hospital: e.target.value })} /></span>
              <Button size="small" type="primary" loading={saving} onClick={saveEdit}>保存修改</Button>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              初值来自清洗后视图；保存只改白名单字段（医院 / 日期 / 类型 / 指标行的名称·数值·单位·参考区间），旧值会自动记入 patchLog。
              报告日期留空就是「未提供」——不要用它代替导入时间。
              这次的编辑动作（改了哪格、改了几次、有没有增删行）另存进操作记录表，只用于改进识别，不会改动报告本身。
            </Text>
            {/* 指标行：MedData DataGrid（代码列 / 审计色 / 一键修正 / 粘贴解析）。
                modal 900px 下它的响应式栅格会走 md 断点，横排区域自动折行。 */}
            <div style={{ maxHeight: '58vh', overflow: 'auto' }}>
              <DataGrid
                date=""
                time=""
                onDateChange={() => {}}
                onTimeChange={() => {}}
                reportedDate={editing.reportDate}
                reportedTime=""
                onReportedDateChange={(v) => setEditing((e) => ({ ...e, reportDate: v }))}
                onReportedTimeChange={() => {}}
                reportType={editing.reportType}
                onReportTypeChange={(v) => setEditing((e) => ({ ...e, reportType: v }))}
                points={editing.points}
                onPointsChange={(next) => setEditing((e) => ({ ...e, points: next }))}
                reportText={editing.text}
                onReportTextChange={(v) => setEditing((e) => ({ ...e, text: v }))}
                baselinePoints={editing.baselinePoints}
                traceId=""
                onSave={saveEdit}
                onReset={() => setEditing((e) => ({ ...e, points: (e.baselinePoints || []).map((p) => ({ ...p })) }))}
              />
            </div>
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
