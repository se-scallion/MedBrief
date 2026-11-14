// 动态趋势看板（Tab 2）
//
// 用户口径（2026-11-14）：
//   · 不限 8 张 —— 打印版只画核心 8 项，这里允许**自由勾选任意历史 ≥2 次的指标**（实测 32 条可画）；
//   · **只做「网格并列」，不做双轴 / 归一化对比** —— IL-6 75240 是上限的 1 万倍，
//     归一化会把 Hb/PLT 压成贴底直线，同样失真；双 Y 轴更容易造出假交叉；
//   · 悬浮看该点完整信息（日期/数值/参考/医院），**点圆点直接打开原件溯源**。
import React, { useMemo, useState } from 'react'
import { Badge, Button, Card, Checkbox, Empty, Segmented, Space, Tag, Typography } from 'antd'

const { Text } = Typography

function TrendChart({ series, onOpenSource, height = 150 }) {
  const pts = series.points.filter((p) => Number.isFinite(Number(p.num)))
  if (pts.length < 2) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="数值点不足 2 个" />
  const w = 460
  const pad = { l: 40, r: 12, t: 14, b: 20 }
  const nums = pts.map((p) => Number(p.num))
  let min = Math.min(...nums)
  let max = Math.max(...nums)
  if (max === min) { max += 1; min -= 1 }
  const x = (i) => pad.l + (i * (w - pad.l - pad.r)) / (pts.length - 1)
  const y = (v) => height - pad.b - ((v - min) / (max - min)) * (height - pad.t - pad.b)
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.num)).toFixed(1)}`).join(' ')
  const ticks = [min, (min + max) / 2, max]
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} style={{ display: 'block' }}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} y1={y(v)} x2={w - pad.r} y2={y(v)} stroke="#f0f0f0" strokeWidth="0.8" />
          <text x={pad.l - 5} y={y(v) + 3} fontSize="9.5" fill="#9ca3af" textAnchor="end">{Number(v.toFixed(2))}</text>
        </g>
      ))}
      <path d={path} fill="none" stroke="#2563eb" strokeWidth="1.6" />
      {pts.map((p, i) => {
        const abnormal = p.flag === 'high' || p.flag === 'low'
        return (
          <g key={i} style={{ cursor: 'pointer' }} onClick={() => onOpenSource({
            rowKey: p.rowKey, reportId: p.reportId, fileBlobId: p.fileBlobId,
            name: series.name, code: series.code, date: p.measuredAt, hospital: p.hospital,
          })}>
            <title>{`${p.measuredAt}　${p.value} ${p.unit || ''}　参考 ${p.refRange || '—'}　${p.hospital || ''}（点击看原件）`}</title>
            {p.critical
              ? <><circle cx={x(i)} cy={y(Number(p.num))} r="5" fill="none" stroke="#111827" strokeWidth="1" /><circle cx={x(i)} cy={y(Number(p.num))} r="2.2" fill="#111827" /></>
              : <circle cx={x(i)} cy={y(Number(p.num))} r="3.2" fill={abnormal ? '#111827' : '#fff'} stroke="#111827" strokeWidth="1" />}
            <text x={x(i)} y={y(Number(p.num)) - 7} fontSize="9" fill="#374151" textAnchor="middle">{p.value}</text>
          </g>
        )
      })}
      {pts.map((p, i) => (
        <text key={`d${i}`} x={x(i)} y={height - 5} fontSize="9" fill="#9ca3af" textAnchor="middle">{String(p.measuredAt || '').slice(5)}</text>
      ))}
    </svg>
  )
}

export default function TrendsTab({ card, onOpenSource }) {
  const all = card?.trendAll || []
  // 默认勾选：打印版那 8 条核心项（rank<99），用户可自行增减
  const defaults = useMemo(() => all.filter((t) => t.core).map((t) => t.key), [all])
  const [picked, setPicked] = useState(null)
  const [mode, setMode] = useState('网格')
  const selected = picked ?? defaults

  if (!all.length) return <Empty description="还没有 ≥2 次的指标可以画趋势" />

  const shown = all.filter((t) => selected.includes(t.key))
  // 「对比」= 同一张卡片里并列多张小图（不做双轴/归一化，见文件头）
  const cols = mode === '对比' ? 1 : 2

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card
        size="small"
        title={<Space>可选指标 <Text type="secondary" style={{ fontSize: 12 }}>（{all.length} 项有 ≥2 次记录 · 已选 {selected.length}）</Text></Space>}
        extra={
          <Space>
            <Segmented size="small" value={mode} onChange={setMode} options={['网格', '对比']} />
            <Button size="small" onClick={() => setPicked(defaults)}>恢复默认 8 项</Button>
            <Button size="small" onClick={() => setPicked(all.map((t) => t.key))}>全选</Button>
            <Button size="small" onClick={() => setPicked([])}>清空</Button>
          </Space>
        }
      >
        <Checkbox.Group
          value={selected}
          onChange={(v) => setPicked(v)}
          style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}
          options={all.map((t) => ({
            value: t.key,
            label: (
              <Space size={4}>
                <span>{t.name}</span>
                <Text type="secondary" style={{ fontSize: 11 }}>{t.points.length} 次</Text>
                {t.core ? <Tag color="blue" style={{ marginInlineEnd: 0, transform: 'scale(0.85)' }}>核心</Tag> : null}
              </Space>
            ),
          }))}
        />
      </Card>

      {!shown.length ? <Empty description="一个都没选" /> : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit,minmax(${cols === 1 ? 560 : 380}px,1fr))`, gap: 12 }}>
          {shown.map((t) => (
            <Card
              key={t.key}
              size="small"
              title={<Space>{t.name}<Text type="secondary" style={{ fontSize: 12 }}>{t.unit}</Text>
                {t.core ? null : <Tag style={{ marginInlineEnd: 0 }}>次要</Tag>}</Space>}
              extra={<Text type="secondary" style={{ fontSize: 12 }}>参考 {t.refRange || '—'}</Text>}
            >
              <TrendChart series={t} onOpenSource={onOpenSource} />
              <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280' }}>
                {t.points.map((p) => `${String(p.measuredAt).slice(5)} ${p.value}`).join(' · ')}
                <Badge status="processing" style={{ marginInlineStart: 8 }} />
                <Text type="secondary" style={{ fontSize: 11 }}>点圆点看原件</Text>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Space>
  )
}
