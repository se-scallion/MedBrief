// 临床指标总览（Tab 1）
//
// 把打印版第 1、2 页的内容做成**可搜索 / 可筛选 / 可折叠 / 可点击溯源**的表格：
//   · ① 疾病标签与安全基线：没填的项点一下就打开档案编辑（聚焦对应字段）
//   · ② 核心异常项：危急值同样可点 → 原件溯源
//   · ③ 全部指标：搜索 + 胶囊筛选 + 分组折叠（阴性常规筛查默认折叠，与打印版口径一致）
// 数据全部来自 `buildCard()` 的 JSON（card.html 只在打印弹窗里用），主页面不再平铺长 iframe。
import React, { useMemo, useState } from 'react'
import { Alert, Badge, Button, Card, Empty, Input, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd'

const { Text } = Typography

const FLAG_TAG = {
  high: <Tag color="red" style={{ marginInlineEnd: 0 }}>▲ 高</Tag>,
  low: <Tag color="green" style={{ marginInlineEnd: 0 }}>▽ 低</Tag>,
  normal: <Text type="secondary">正常</Text>,
}
const isNeg = (r) => /^(阴性|未见|未检出|正常|neg)/i.test(String(r.value ?? '').trim())
const isAbnormal = (r) => r.flag === 'high' || r.flag === 'low' || r.status === 'positive'
const isPending = (r) => !!r.nameDirty || !!r.valueConflict

function BaselineCell({ title, children, onEdit, hint }) {
  return (
    <div style={{
      border: '1px solid #d1d5db', borderLeft: '3px solid #111', borderRadius: 2,
      padding: '4px 8px', minHeight: 56, background: '#fff',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>
        {children}
        {onEdit && (
          <Button type="link" size="small" style={{ padding: '0 4px', fontSize: 12 }} onClick={onEdit}>
            {hint || '补填'}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * 两栏紧凑指标行（替代 antd Table）：屏幕上一行 ~22px，115 项排成两栏后高度减半，
 * 与打印版第 2 页的「分组 + 双栏」口径一致，避免「网页版比纸还长」。
 * 窄屏（≤575px）由 CardPage.jsx 注入的 .mb-compact-grid/.mb-compact-row 改成单栏并隐藏「参考」，
 * 避免固定 96px 列把 375px 屏幕撑出横向滚动。
 */
function CompactRows({ items = [], onOpen }) {
  const half = Math.ceil(items.length / 2)
  const cols = [items.slice(0, half), items.slice(half)]
  return (
    <div className="mb-compact-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px', marginTop: 2 }}>
      {cols.map((part, ci) => (
        <div key={ci}>
          {part.map((r) => (
            <div
              key={r.rowKey || r.name}
              className="mb-compact-row"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(r)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r) }}
              style={{
                display: 'grid', gridTemplateColumns: '1fr auto 96px 46px', gap: 6,
                alignItems: 'baseline', padding: '1px 4px', fontSize: 12, cursor: 'pointer',
                borderBottom: '1px dotted #eee',
                background: r.critical ? '#fef2f2' : undefined,
                borderLeft: r.critical ? '3px solid #111' : '3px solid transparent',
              }}
              title={`${r.name}　${r.value ?? ''} ${r.unit || ''}　参考 ${r.refRange || '—'}　${String(r.measuredAt || '').slice(0, 10)}（点击看原件）`}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name}{r.critical ? ' [危急]' : ''}{r.nameDirty ? ' ?' : ''}
              </span>
              <span style={{ fontWeight: 600, color: r.flag === 'high' ? '#b91c1c' : r.flag === 'low' ? '#15803d' : '#111' }}>
                {r.value ?? ''}{r.unit ? ` ${r.unit}` : ''}
              </span>
              <span style={{ color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.refRange || '—'}</span>
              <span style={{ color: r.flag === 'high' ? '#b91c1c' : r.flag === 'low' ? '#15803d' : '#9ca3af', fontWeight: 700, textAlign: 'right' }}>
                {r.flag === 'high' ? '▲ 高' : r.flag === 'low' ? '▽ 低' : ''}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export default function OverviewTab({ card, onOpenSource, onEditProfile }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('全部')
  const [openGroups, setOpenGroups] = useState({})
  const [allOpen, setAllOpen] = useState(false)   // ③ 默认收起；搜索/筛选时自动展开更符合直觉

  const sb = card?.safetyBaseline || {}
  const safety = sb.safety || {}
  const treatment = sb.treatment || {}

  const rhMark = /^阳性|^\+/i.test(safety.rh || '') ? '(+)' : /^阴性|^-/i.test(safety.rh || '') ? '(−)' : safety.rh ? ` ${safety.rh}` : ''
  const infList = safety.infections || []
  const infChecked = infList.filter((i) => i.value)
  const infAllNeg = infChecked.length === infList.length && infChecked.length > 0 && infChecked.every((i) => /^阴性|^neg/i.test(i.value))

  const rows = card?.latestRows || []
  const p0 = card?.p0rows || []

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (kw && !`${r.name} ${r.code || ''}`.toLowerCase().includes(kw)) return false
      if (filter === '仅异常') return isAbnormal(r)
      if (filter === '仅危急') return !!r.critical
      if (filter === '待核对') return isPending(r)
      return true
    })
  }, [rows, q, filter])

  const groups = useMemo(() => {
    const map = new Map()
    for (const r of filtered) {
      const k = r.cat || '其他项'
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(r)
    }
    return [...map.entries()].map(([label, items]) => ({
      label,
      items,
      // 阴性常规筛查（整组都是「阴性/未见/正常」且无异常标记）默认折叠 —— 与打印版口径一致
      quiet: items.every((r) => (isNeg(r) || r.flag === 'normal') && !isAbnormal(r) && !r.critical),
    }))
  }, [filtered])

  const p0Columns = [
    {
      title: '项目',
      dataIndex: 'name',
      render: (v, r) => (
        <Space size={4}>
          <span>{v}</span>
          {r.critical ? <Tag color="black" style={{ marginInlineEnd: 0 }}>[危急]</Tag> : null}
          {r.nameDirty ? <Tooltip title="名称含异常字符，需人工核对原件"><Tag color="orange" style={{ marginInlineEnd: 0 }}>?</Tag></Tooltip> : null}
        </Space>
      ),
    },
    { title: '数值', width: 190, render: (_, r) => `${r.value ?? ''}${r.unit ? ' ' + r.unit : ''}` },
    // 窄屏隐藏次要列，只留「项目 / 数值 / 判定」；antd 原生 responsive 会自动过滤 col/th/td
    { title: '参考', width: 120, dataIndex: 'refRange', responsive: ['md'], render: (v) => v || '—' },
    { title: '判定', width: 84, dataIndex: 'flag', render: (v) => FLAG_TAG[v] || <Text type="secondary">—</Text> },
    { title: '日期 · 医院', width: 170, responsive: ['md'], render: (_, r) => `${String(r.measuredAt || '').slice(5)}${r.hospital ? ' · ' + r.hospital : ''}` },
  ]

  const openRow = (r) => onOpenSource({
    rowKey: r.rowKey, reportId: r.reportId, fileBlobId: r.fileBlobId, rowIndex: r.rowIndex,
    name: r.name, code: r.code, date: r.reportDate || r.measuredAt, hospital: r.hospital,
  })

  if (!card) return <Empty description="还没有生成资料卡" />

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* ---------- ① 疾病标签与安全基线 ---------- */}
      <Card size="small" title="① 疾病标签与安全基线" style={{ borderLeft: '3px solid #111' }}>
        <div className="mb-baseline-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 8 }}>
          <BaselineCell title="分子与高危基因">
            {(sb.geneTags || []).length
              ? sb.geneTags.map((g, i) => (
                <span key={i} style={{ marginInlineEnd: 8 }}>
                  {g.positive
                    ? <Tag color="black" style={{ marginInlineEnd: 2 }}>{g.label} 阳性</Tag>
                    : <span><b>{g.label}</b> {g.value}{g.unit === '%' ? '%' : g.unit ? ` ${g.unit}` : ''}</span>}
                </span>
              ))
              : <Text type="secondary">待核（报告里未检出基因/残留病项目）</Text>}
          </BaselineCell>

          <BaselineCell title="初诊基线（对比最新）">
            {(sb.baseline || []).length
              ? sb.baseline.map((b, i) => (
                <div key={i}>
                  <b>{b.label}</b> 初诊 {b.first.value}（{String(b.first.date).slice(5)}）
                  {b.peak.value !== b.first.value ? ` · 峰值 ${b.peak.value}（${String(b.peak.date).slice(5)}）` : ''}
                  {b.first.value === b.latest.value
                    ? <Text type="secondary"> · 仅一次</Text>
                    : ` · 最新 ${b.latest.value}（${String(b.latest.date).slice(5)}）`}
                </div>
              ))
              : <Text type="secondary">未录入（缺 WBC / LDH 数值）</Text>}
          </BaselineCell>

          <BaselineCell title="治疗安全基线">
            <div>
              血型 <b>{safety.bloodType || '未录入'}</b>{rhMark ? ` · Rh${rhMark}` : ' · Rh 待核'}
            </div>
            <div>
              {infAllNeg
                ? <>传染病四项 <b>均阴性</b>{infChecked[0]?.date ? <Text type="secondary">（{String(infChecked[0].date).slice(5)}）</Text> : null}</>
                : infList.map((i, k) => (
                  <span key={k} style={{ marginInlineEnd: 8 }}>
                    {i.label} {i.value ? <b>{i.value}</b> : <Text type="secondary">未录入</Text>}
                  </span>
                ))}
            </div>
            {(safety.comorbidities || safety.allergies || safety.medications) ? (
              <div>
                {safety.comorbidities ? <span style={{ marginInlineEnd: 8 }}>基础病 <b>{safety.comorbidities}</b></span> : null}
                {safety.allergies ? <span style={{ marginInlineEnd: 8 }}>过敏 <b>{safety.allergies}</b></span> : null}
                {safety.medications ? <span>在用药 <b>{safety.medications}</b></span> : null}
              </div>
            ) : null}
          </BaselineCell>

          <BaselineCell
            title="近期治疗节点"
            onEdit={(treatment.lastChemo || treatment.recentTxOrGcsf || treatment.marrowSummary) ? undefined : () => onEditProfile('lastChemo')}
            hint="补填治疗节点"
          >
            {(treatment.lastChemo || treatment.recentTxOrGcsf || treatment.marrowSummary) ? (
              <>
                <div>治疗节点 <b>{treatment.lastChemo || '未录入'}</b></div>
                <div>输血/升白 <b>{treatment.recentTxOrGcsf || '未录入'}</b></div>
                <div>骨穿/MRD <b>{treatment.marrowSummary || '未录入'}</b></div>
              </>
            ) : <Text type="secondary">未录入</Text>}
          </BaselineCell>
        </div>
      </Card>

      {/* ---------- ①-b 关键结论摘录（2026-11-15 用户口径） ---------- */}
      {(card.keyConclusions || []).length > 0 && (
        <Card size="small" title={<Space>①-b 关键结论摘录 <Text type="secondary" style={{ fontSize: 12 }}>（原句照录，点开看原件）</Text></Space>}
          style={{ borderLeft: '3px solid #6b7280' }}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {card.keyConclusions.map((k) => {
              const tl = (card.timeline || []).find((r) => r.id === k.reportId)
              const clickable = !!(k.reportId && tl)
              return (
                <div
                  key={k.key}
                  onClick={clickable ? () => onOpenSource({
                    reportId: k.reportId,
                    fileBlobId: tl?.fileBlobId,
                    name: `${k.label}${k.date ? `（${String(k.date).slice(5)}）` : ''}`,
                    date: k.date || tl?.date,
                    hospital: tl?.hospital,
                  }) : undefined}
                  style={{ cursor: clickable ? 'pointer' : 'default' }}
                >
                  <Space size={6} wrap>
                    <Tag color={k.source === 'manual' ? 'purple' : 'default'} style={{ marginInlineEnd: 0 }}>
                      {k.source === 'manual' ? '人工摘录' : '原文摘录'}
                    </Tag>
                    <Text strong style={{ fontSize: 12 }}>{k.label}{k.date ? `（${String(k.date).slice(5)}）` : ''}</Text>
                    {clickable && <Text type="secondary" style={{ fontSize: 11 }}>点击看原件 ›</Text>}
                  </Space>
                  <div style={{ fontSize: 12, color: '#1f2937', marginTop: 2 }}>{k.text}</div>
                </div>
              )
            })}
          </Space>
        </Card>
      )}

      {/* ---------- 中枢神经系统资料提示（只做资料核对，不含医疗建议） ---------- */}
      {(card.checklist?.hints || []).map((h) => (
        <Alert key={h.key} type="warning" showIcon style={{ padding: '4px 10px' }}
          message={<span style={{ fontSize: 12 }}>{h.detail}</span>} />
      ))}

      {/* ---------- ② 核心异常项 ---------- */}
      <Card
        size="small"
        title={<Space>② 核心异常项 <Text type="secondary" style={{ fontSize: 12 }}>（每项只看最近一次 · 共 {p0.length} 项）</Text></Space>}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>点任意行查看原件</Text>}
        style={{ borderLeft: '3px solid #111' }}
      >
        <Table
          size="small"
          rowKey={(r) => r.rowKey || r.name}
          dataSource={p0}
          columns={p0Columns}
          pagination={false}
          onRow={(r) => ({
            onClick: () => openRow(r),
            style: { cursor: 'pointer', background: r.critical ? '#fef2f2' : undefined },
          })}
          locale={{ emptyText: '本次资料里 P0 核心项没有越出参考区间的记录' }}
        />
      </Card>

      {/* ---------- ③ 全部指标（两栏紧凑排版；默认收起，避免页面被 115 行拉长） ---------- */}
      <Card
        size="small"
        collapsible
        defaultActiveKey={['all']}
        activeKey={(allOpen || q.trim() || filter !== '全部') ? ['all'] : []}
        onChange={(keys) => setAllOpen(keys.includes('all'))}
        title={<Space>③ 全部指标 <Text type="secondary" style={{ fontSize: 12 }}>（{rows.length} 项 · 异常 {rows.filter(isAbnormal).length} · 按临床大类分组，点标题展开）</Text></Space>}
        style={{ borderLeft: '3px solid #111' }}
        extra={
          <Space wrap onClick={(e) => e.stopPropagation()}>
            <Input.Search allowClear size="small" placeholder="搜项目名 / 缩写，如 WBC、钾" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
            <Segmented
              size="small"
              value={filter}
              onChange={setFilter}
              options={[
                { label: '全部', value: '全部' },
                { label: `仅异常 ${rows.filter(isAbnormal).length}`, value: '仅异常' },
                { label: `仅危急 ${rows.filter((r) => r.critical).length}`, value: '仅危急' },
                { label: `待核对 ${rows.filter(isPending).length}`, value: '待核对' },
              ]}
            />
          </Space>
        }
      >
        {!groups.length ? <Empty description="没有匹配的指标" /> : (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {groups.map((g) => {
              const open = openGroups[g.label] ?? !g.quiet
              const bad = g.items.filter(isAbnormal).length
              return (
                <div key={g.label}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenGroups((s) => ({ ...s, [g.label]: !open }))}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpenGroups((s) => ({ ...s, [g.label]: !open })) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                      borderLeft: '3px solid #94a3b8', padding: '2px 6px', background: '#fafafa',
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{open ? '▾' : '▸'} {g.label}</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>{g.items.length} 项</Text>
                    {bad ? <Badge count={bad} size="small" color="red" /> : null}
                    {g.quiet ? <Tag style={{ marginInlineStart: 4 }}>阴性常规（默认折叠）</Tag> : null}
                  </div>
                  {open && <CompactRows items={g.items} onOpen={openRow} />}
                </div>
              )
            })}
          </Space>
        )}
      </Card>
    </Space>
  )
}
