import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
} from 'antd'
import { jget } from '../api.js'
import { playChime } from '../alarm.js'
import { useLog } from '../App.jsx'

const { Title, Text } = Typography

const MILESTONE_LABEL = {
  300: '⚠️ 距离 07:00 放号还有 5 分钟，准备好官方小程序',
  60: '⚠️ 距离放号还有 1 分钟，进入血液内科挂号页等待刷新',
  10: '🚨 还有 10 秒开始放号',
}

export default function MonitorTab() {
  const { pushLog } = useLog()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [autoPoll, setAutoPoll] = useState(true)
  const [intervalSec, setIntervalSec] = useState(30)
  const [alarmEnabled, setAlarmEnabled] = useState(true)
  const lastKnown = useRef({})

  // 倒计时唯一真相来源 = 服务端 /api/guahao/monitor/countdown
  // （旧版曾在前端自己算 +14 天，与院方「次日 07:00 放第 14 天」差一天，这里不再复制一份日期算法）
  const [serverCd, setServerCd] = useState(null)
  const [remainSec, setRemainSec] = useState(0)
  const milestoneRef = useRef(new Set())

  useEffect(() => {
    let alive = true
    const loadCd = async () => {
      try {
        const j = await jget('/api/guahao/monitor/countdown')
        if (alive) setServerCd({ ...j, at: Date.now() })
      } catch {
        /* 忽略：下一轮再试 */
      }
    }
    loadCd()
    const t = setInterval(loadCd, 15000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    if (!serverCd) return
    const tick = () => {
      const elapsed = Date.now() - serverCd.at
      const left = Math.max(0, Math.round((serverCd.diffMs - elapsed) / 1000))
      setRemainSec(left)
      if (!alarmEnabled) return
      if (MILESTONE_LABEL[left] && !milestoneRef.current.has(left)) {
        milestoneRef.current.add(left)
        playChime()
        pushLog(MILESTONE_LABEL[left], left === 10 ? 'err' : 'warn')
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [serverCd, alarmEnabled, pushLog])

  const pad = (n) => String(n).padStart(2, '0')
  const countdown = {
    clock: `${pad(Math.floor(remainSec / 3600))}:${pad(Math.floor((remainSec % 3600) / 60))}:${pad(remainSec % 60)}`,
    targetText: serverCd?.targetReleaseTime || '—',
    releaseDate: serverCd?.targetDateForBooking || '—',
    nowBeijing: serverCd?.nowBeijing || '',
  }

  const load = useCallback(
    async (force = false) => {
      setLoading(true)
      setError('')
      try {
        const j = await jget(`/api/guahao/monitor/realtime${force ? '?force=true' : ''}`)
        setData(j)
        const slots = j.slots || []
        let changes = 0
        for (const s of slots) {
          const key = `${s.department}_${s.dateHeader}_${s.period}`
          const prev = lastKnown.current[key]
          if (prev && prev !== s.status) {
            changes += 1
            pushLog(
              `🔔 排班变动：${s.department} ${s.dateHeader} ${s.period} → ${s.statusText}`,
              'ok',
            )
            if (alarmEnabled) playChime()
          }
          lastKnown.current[key] = s.status
        }
        if (force && changes === 0) {
          pushLog(
            `官网探测完成：${j.slotCount} 场（出诊 ${j.activeCount} / 停诊 ${j.suspendedCount}），无变动`,
            'ok',
          )
        }
      } catch (e) {
        setError(e.message || '抓取失败')
        pushLog(`官网探测失败：${e.message}`, 'err')
      } finally {
        setLoading(false)
      }
    },
    [alarmEnabled, pushLog],
  )

  useEffect(() => {
    load(false)
  }, [load])

  useEffect(() => {
    if (!autoPoll) return
    const t = setInterval(() => load(false), Math.max(15, intervalSec) * 1000)
    return () => clearInterval(t)
  }, [autoPoll, intervalSec, load])

  const slots = data?.slots || []

  return (
    <div>
      <Row gutter={16}>
        <Col xs={24} lg={9}>
          <Card
            style={{ background: 'linear-gradient(135deg,#0f172a,#1e293b)', border: 'none' }}
            styles={{ body: { color: '#e2e8f0' } }}
          >
            <Text style={{ color: '#94a3b8', fontSize: 12 }}>距离下一次放号（每日 07:00 · 放第 14 天号源）</Text>
            <div
              style={{
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: 44,
                fontWeight: 700,
                color: '#38bdf8',
                lineHeight: 1.15,
                margin: '6px 0',
              }}
            >
              {countdown.clock}
            </div>
            <Space wrap size={8}>
              <Tag color="blue">下次放号 {countdown.targetText}</Tag>
              <Tag color="geekblue">开放就诊日 {countdown.releaseDate}</Tag>
              {countdown.nowBeijing && <Tag>院内口径 {countdown.nowBeijing} (UTC+8)</Tag>}
            </Space>
            <Space style={{ marginTop: 14 }} wrap>
              <Button size="small" onClick={() => { setAlarmEnabled(true); playChime() }}>
                试听警报音
              </Button>
              <Switch
                size="small"
                checked={alarmEnabled}
                onChange={(v) => {
                  setAlarmEnabled(v)
                  pushLog(`声音预警已${v ? '开启' : '关闭'}`, 'info')
                  if (v) playChime()
                }}
              />
              <Text style={{ color: '#cbd5e1', fontSize: 12 }}>
                {alarmEnabled ? '预警已开启' : '预警已静音'}
              </Text>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <Card
            size="small"
            title={
              <Space wrap>
                <Text strong>朝阳医院官网实时排班</Text>
                <Tag color="blue">Index_1220.html</Tag>
                {data?.fromCache && <Tag color="orange">缓存</Tag>}
              </Space>
            }
            extra={
              <Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {data?.lastFetchedAt
                    ? `最近同步 ${new Date(data.lastFetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
                    : '未同步'}
                </Text>
                <Button size="small" type="primary" loading={loading} onClick={() => load(true)}>
                  立即穿透探测
                </Button>
              </Space>
            }
          >
            <Row gutter={12} style={{ marginBottom: 12 }}>
              <Col span={8}>
                <Statistic title="出诊中" value={data?.activeCount ?? '-'} valueStyle={{ color: '#15803d' }} suffix="场" />
              </Col>
              <Col span={8}>
                <Statistic title="停诊" value={data?.suspendedCount ?? '-'} valueStyle={{ color: '#b91c1c' }} suffix="场" />
              </Col>
              <Col span={8}>
                <Statistic title="两周总排班" value={data?.slotCount ?? '-'} suffix="场" />
              </Col>
            </Row>
            <Space wrap style={{ marginBottom: 8 }}>
              <Switch size="small" checked={autoPoll} onChange={setAutoPoll} />
              <Text style={{ fontSize: 12 }}>自动巡检</Text>
              <Select
                size="small"
                value={intervalSec}
                style={{ width: 110 }}
                onChange={setIntervalSec}
                options={[
                  { value: 15, label: '每 15 秒' },
                  { value: 30, label: '每 30 秒' },
                  { value: 60, label: '每 60 秒' },
                ]}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                低频轮询（≥30s 更安全），放号时刻才提速
              </Text>
            </Space>
            {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
          </Card>
        </Col>
      </Row>

      <Card size="small" style={{ marginTop: 16 }} title="两周排班明细">
        {loading && !slots.length ? (
          <div style={{ textAlign: 'center', padding: 30 }}>
            <Spin /> <Text type="secondary">正在穿透官网抓取主鸿鹄主任排班…</Text>
          </div>
        ) : slots.length === 0 ? (
          <Empty description="暂无排班数据，点「立即穿透探测」" />
        ) : (
          <Row gutter={[12, 12]}>
            {slots.map((s, i) => {
              const suspended = s.status === 'suspended'
              return (
                <Col xs={24} sm={12} lg={8} xl={6} key={`${s.department}-${s.dateHeader}-${s.period}-${i}`}>
                  <Card
                    size="small"
                    style={{
                      borderLeft: `3px solid ${suspended ? '#dc2626' : '#16a34a'}`,
                      height: '100%',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <Text strong style={{ fontSize: 13 }}>{s.department}</Text>
                      <Tag color={suspended ? 'red' : 'green'}>{s.statusText}</Tag>
                    </div>
                    <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                      <strong>{s.dateHeader}</strong> · {s.period}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', marginTop: 4 }}>
                      <span>
                        {s.doctor}（{s.level}）
                      </span>
                      <span>¥{s.fee}</span>
                    </div>
                    <div style={{ fontSize: 11, marginTop: 6, color: suspended ? '#b91c1c' : '#15803d' }}>
                      {suspended ? '官网已发布停诊公告，勿前往该时段' : '正常出诊，每日 07:00 放号'}
                    </div>
                  </Card>
                </Col>
              )
            })}
          </Row>
        )}
      </Card>
    </div>
  )
}
