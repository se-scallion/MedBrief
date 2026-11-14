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
  // X 轴按**真实日期比例**（W13-A1，与打印版 lib/intakeCard.js svgTrend 同一套规则）：
  // 隔 9 天必须比隔 1 天宽 9 倍，否则会误导病情变化速度。
  // 退化路径一律回退等距（有效日期 <2 / 全同一天 / 该点无日期），绝不产生 NaN。
  const tsOf = (pt) => {
    const raw = String(pt.measuredAt || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null
    const t = Date.parse(`${raw.slice(0, 10)}T00:00:00Z`)
    return Number.isFinite(t) ? t : null
  }
  const times = pts.map(tsOf)
  const validTimes = times.filter((t) => t !== null)
  const t0 = validTimes.length ? Math.min(...validTimes) : null
  const t1 = validTimes.length ? Math.max(...validTimes) : null
  const useTime = validTimes.length >= 2 && t1 > t0
  const plotW = w - pad.l - pad.r
  const x = (i) => (useTime && times[i] !== null
    ? pad.l + ((times[i] - t0) / (t1 - t0)) * plotW
    : pad.l + (i * plotW) / (pts.length - 1))
  const y = (v) => height - pad.b - ((v - min) / (max - min)) * (height - pad.t - pad.b)
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.num)).toFixed(1)}`).join(' ')
  const ticks = [min, (min + max) / 2, max]
  // 日期标签两级避让（与打印版同规则）：相邻 <26px 奇偶两行错位、底部加高 8px 防 viewBox 裁切；
  // 仍 <13px 则抽稀（留首点、末点、每月首个点），点值标签与 hover tooltip 不受影响。
  const xs = pts.map((_, i) => x(i))
  let minGap = Infinity
  for (let i = 1; i < xs.length; i++) minGap = Math.min(minGap, xs[i] - xs[i - 1])
  const twoRows = xs.length > 1 && minGap < 26
  const H = height + (twoRows ? 8 : 0)
  const tooTight = xs.length > 1 && minGap < 13
  const keepLabel = (i) => {
    if (i === 0 || i === xs.length - 1) return true
    if (!tooTight) return true
    return String(pts[i].measuredAt || '').slice(0, 7) !== String(pts[i - 1].measuredAt || '').slice(0, 7)
  }
  return (
    <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} y1={y(v)} x2={w - pad.r} y2={y(v)} stroke="#f0f0f0" strokeWidth="0.8" />
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
      {pts.map((p, i) => (keepLabel(i) ? (
        <text key={`d${i}`} x={xs[i]} y={twoRows && i % 2 ? H - 10 : H - 2.5} fontSize="9" fill="#9ca3af" textAnchor="middle">{String(p.measuredAt || '').slice(5)}</text>
      ) : null))}
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
        <div className="mb-trends-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit,minmax(${cols === 1 ? 560 : 380}px,1fr))`, gap: 12 }}>
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
