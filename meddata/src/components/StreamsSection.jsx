// ===================== 病情三维度 · 残留病监测区（内嵌在「指标」页）=====================
// 三条流分别成图，**不合并、不平均**。指标由报告自动生成（检查报告里的骨穿/流式/基因报告、
// 检验报告里的「白血病融合基因检测(骨髓)」），不提供手工新增；识别有误时删掉该点即可。
// 阈值是医学标准（只读）：CR ≤5% · FCM-MRD <0.01% · BCR-ABL1 ≤0.1%（MMR）· 未检出（CMR）。

import { useMemo } from 'react'
import { Button, Card, Popconfirm, Table, Tag, Tooltip } from 'antd'
import StreamChart from './StreamChart.jsx'
import { useStore, deleteDiseaseMetric } from '../data/store.js'
import { recordLooksLikeMarrow, recordLooksLikeFlow } from '../utils/diseaseIngest.js'
import { STREAMS, STREAM_ORDER, THRESHOLDS_VERSION, TARGETS, SPECIMENS, CMR_STREAK } from '../data/diseaseThresholds.js'
import {
  streamState,
  gradePoint,
  isJudgedSpecimen,
  pickPrimaryAnalyte,
  pcrChannels,
  formatPct,
  todayStr,
  ladderOf,
  cmrStreak,
  cmrProgress,
} from '../utils/diseaseGrade.js'

const STATUS_TAG = {
  pass: { color: 'green', text: '达标' },
  fail: { color: 'red', text: '未达标' },
  nd: { color: 'gold', text: '未检出' },
  invalid: { color: 'orange', text: '数据不一致' },
  missing: { color: 'default', text: '无数据' },
}

// 阶梯只展示「可争取的四级」；未达 CR 用状态标签表达（不是一级台阶）
const RUNGS = [
  { tier: 1, label: '形态学缓解', desc: '骨髓原始/幼稚 ≤5%（CR 的骨髓部分）' },
  { tier: 2, label: 'MMR', desc: 'BCR-ABL1 ≤0.1%' },
  { tier: 3, label: '深度缓解', desc: 'MMR + FCM-MRD <0.01%' },
  { tier: 4, label: 'CMR', desc: 'qPCR 未检出（FCM 阴性为双证）' },
]

const STREAM_LABEL = { morph: '形态学', fcm: '流式', pcr: '分子' }

const STREAM_NOTE = {
  morph: '≤5% 为形态学 CR（及格线）；判定只认骨髓片，血片比例另作对照；取材稀释的点标「稀释」，不参与认证。',
  fcm: '对数轴；底部「未检出」是保留泳道（log 轴画不出 0），不代表数值为 0。',
  pcr: '0.1% = MMR；点线为「较初诊基线下降 3-log」。报告未标化到 IS 时，以 3-log 为准。',
}

function valueText(p) {
  // 报告写了数字就以数字为准（0% 就是 0%）；只有「阴性 / 未检出」这类无数字的定性结论才显示「未检出」
  const hasNum = p.value != null && Number.isFinite(Number(p.value))
  if (!hasNum) return p.qualifier === 'nd' ? '未检出' : '—'
  const v = p.qualifier === 'lt' ? `<${formatPct(p.value)}` : formatPct(p.value)
  return `${v}%`
}

export default function StreamsSection({ onOpenDoc }) {
  const store = useStore()
  const all = store.diseaseMetrics || []
  const courses = store.courses || []
  const docs = store.docs || []
  const records = store.records || []
  const today = todayStr()

  const docsById = useMemo(() => {
    const m = new Map()
    for (const d of docs) if (d && d.id) m.set(d.id, d)
    return m
  }, [docs])

  const view = useMemo(() => {
    const morphPoints = all.filter((p) => p.stream === 'morph')
    const fcmPoints = all.filter((p) => p.stream === 'fcm')
    const pcrPoints = all.filter((p) => p.stream === 'pcr')
    const primary = pickPrimaryAnalyte(pcrPoints)
    const states = {
      morph: streamState(morphPoints, 'morph', today),
      fcm: streamState(fcmPoints, 'fcm', today),
      pcr: streamState(pcrPoints, 'pcr', today, { primaryAnalyte: primary }),
    }
    // 分子只展示检出的转录本通道（未检出的旁路通道折叠，不占三行）
    const channels = pcrChannels(pcrPoints, primary)
    const streak = cmrStreak(pcrPoints, primary)
    return {
      primary,
      channels,
      pointsByStream: { morph: morphPoints, fcm: fcmPoints, pcr: pcrPoints },
      states,
      ladder: ladderOf(states, today),
      streak,
      progress: cmrProgress(streak, today),
      // 已入库的骨穿报告（用于「为什么形态学没点」的解释：报告在、但没写原始/幼稚比例）。
      // 新口径骨穿走化验（records.report_type=BONE_MARROW_MORPHOLOGY），老口径是检查报告 kind=bonemarrow。
      marrowSources: [
        ...docs.filter((d) => d && d.kind === 'bonemarrow').map((d) => ({ date: d.date })),
        ...records
          .filter((r) => r && recordLooksLikeMarrow(r))
          .map((r) => ({ date: r.date })),
      ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
      // 已入库的流式报告（记录口径 FLOW_CYTOMETRY + 老口径检查报告 kind=flow）
      flowSources: [
        ...docs.filter((d) => d && d.kind === 'flow').map((d) => ({ date: d.date })),
        ...records.filter((r) => r && recordLooksLikeFlow(r)).map((r) => ({ date: r.date })),
      ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
    }
  }, [all, docs, records, today])

  const columnsOf = (streamKey) => {
    const cols = [
      {
        title: '日期',
        dataIndex: 'date',
        width: 104,
        render: (d, p) => (
          <span className="font-mono text-xs text-slate-700" title={p.sampled_at ? `采样 ${p.sampled_at}` : ''}>
            {String(d).slice(0, 10)}
          </span>
        ),
      },
      {
        title: '值',
        key: 'value',
        width: 116,
        render: (_, p) => (
          <span className="font-mono text-xs text-slate-800">
            {valueText(p)}
            {(p.flags || []).includes('ratio_inconsistent') && (
              <Tag color="orange" className="ml-1 !px-1 !text-[10px]">
                不一致
              </Tag>
            )}
          </span>
        ),
      },
    ]
    if (streamKey === 'pcr' && view.channels.shown.length > 1) {
      cols.push({
        title: '通道',
        dataIndex: 'analyte',
        width: 66,
        render: (a) => <span className="font-mono text-[11px] text-slate-600">{a || '—'}</span>,
      })
    }
    cols.push(
      {
        title: '标本',
        dataIndex: 'specimen',
        width: 66,
        render: (s) => <span className="text-xs text-slate-600">{SPECIMENS[s] || '—'}</span>,
      },
      {
        title: '判定',
        key: 'status',
        width: 88,
        render: (_, p) => {
          // 非判定标本（形态学里的血片点）：照常展示数值，但不参与 CR 判定/阶梯
          if (!isJudgedSpecimen(streamKey, p))
            return (
              <Tooltip title="血片原始/幼稚比例另作对照，不参与 CR 判定与阶梯认证（取材料以骨髓为准）">
                <Tag>不参与判定</Tag>
              </Tooltip>
            )
          const st = p.verified === false ? 'pending' : gradePoint(streamKey, p)
          const meta = STATUS_TAG[st] || STATUS_TAG.missing
          return <Tag color={meta.color}>{meta.text}</Tag>
        },
      },
      {
        title: '来源',
        key: 'source',
        width: 96,
        render: (_, p) => {
          const src = p.source || {}
          if (src.type === 'record') return <span className="text-[11px] text-slate-500">检验</span>
          const doc = src.doc_id ? docsById.get(src.doc_id) : null
          if (!doc) return <span className="text-[11px] text-slate-400">报告</span>
          return (
            <button
              type="button"
              onClick={() => onOpenDoc && onOpenDoc(doc)}
              className="text-left text-[11px] text-brand-600 hover:underline"
              title="打开来源报告"
            >
              {doc.doc_type || '报告'}
              <span className="block text-[10px] text-slate-400">{String(doc.date || '').slice(5, 10)}</span>
            </button>
          )
        },
      },
      {
        title: '',
        key: 'op',
        width: 52,
        render: (_, p) => (
          <Popconfirm
            title="删除这个指标点？"
            okText="删除"
            cancelText="取消"
            onConfirm={() => deleteDiseaseMetric(p.id)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        ),
      }
    )
    return cols
  }

  const renderCard = (key) => {
    const def = STREAMS[key]
    const state = view.states[key]
    // 分子：默认只留检出过的转录本，旁路「未检出」通道不进表格/图例
    const raw = view.pointsByStream[key]
    const list = [...(key === 'pcr' ? raw.filter((p) => view.channels.shown.includes(p.analyte || 'other')) : raw)].sort((a, b) => {
      const d = String(b.date).localeCompare(String(a.date))
      if (d !== 0) return d
      return String(b.created_at || '').localeCompare(String(a.created_at || ''))
    })
    const status = state.missing ? 'missing' : state.level
    const meta = STATUS_TAG[status] || STATUS_TAG.missing
    const verifiedCount = list.filter((p) => p.verified !== false).length

    return (
      <Card key={key} className="!rounded-xl scroll-mt-[180px]" data-testid={`stream-card-${key}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-700">
              {def.label}
              <span className="ml-1.5 font-normal text-slate-400">· {def.sub}</span>
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {def.name} · 目标 {def.target.label}
              {key === 'pcr' && <span className="ml-1 text-slate-400">（主标志物 {view.primary}）</span>}
            </p>
          </div>
          <Tag color={meta.color}>
            {state.missing
              ? '无数据'
              : state.stale
                ? `${meta.text} · 数据 ${state.daysSince} 天前`
                : meta.text}
          </Tag>
        </div>

        <div className="mt-2">
          {verifiedCount > 0 ? (
            <StreamChart
              streamKey={key}
              points={list.filter((p) => p.verified !== false)}
              courses={courses}
              primaryAnalyte={key === 'pcr' ? view.primary : undefined}
              height={220}
            />
          ) : (
            <div className="flex h-[150px] flex-col items-center justify-center text-sm text-slate-400">
              <p>暂无{def.label}数据</p>
              <p className="mt-1 text-[11px]">
                {key === 'morph'
                  ? '导入含原始/幼稚细胞比例的骨穿（骨髓形态学检验）后自动生成'
                  : key === 'fcm'
                    ? '导入流式免疫分型（FCM-MRD）检验报告后自动生成'
                    : '导入融合基因（BCR-ABL1 定量）检验报告后自动生成'}
              </p>
              {/* 已归档骨穿报告却没有形态学点：把原因说清楚，别让用户以为是没导进去 */}
              {key === 'fcm' && view.flowSources.length > 0 && (
                <p className="mt-1 px-6 text-center text-[11px] text-slate-400">
                  已入库流式报告 {view.flowSources.length} 份（最近 {String(view.flowSources[0].date || '').slice(0, 10)}），
                  但未给出可解析的 MRD 比例 —— 请核对报告结论里是否写明残留百分比
                </p>
              )}
              {key === 'morph' && view.marrowSources.length > 0 && (
                <p className="mt-1 px-6 text-center text-[11px] text-slate-400">
                  已入库骨穿报告 {view.marrowSources.length} 份（最近 {String(view.marrowSources[0].date || '').slice(0, 10)}），
                  但均未写明原始 / 幼稚细胞比例 —— 这类报告不参与 CR 判定，需另导含原始细胞比例的骨穿报告
                </p>
              )}
            </div>
          )}
        </div>

        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{STREAM_NOTE[key]}</p>

        {list.length > 0 && (
          <Table
            className="mt-1.5"
            data-testid={`stream-table-${key}`}
            size="small"
            rowKey="id"
            dataSource={list}
            columns={columnsOf(key)}
            pagination={list.length > 6 ? { pageSize: 6, size: 'small' } : false}
          />
        )}

        {key === 'pcr' && view.channels.hidden.length > 0 && (
          <p className="mt-1.5 text-[11px] text-slate-400" data-testid="pcr-hidden-channels">
            另检 {view.channels.hidden.join(' / ')} 全程未检出，不单独列出（按检出的分型监测）
          </p>
        )}
      </Card>
    )
  }

  return (
    <section id="streams" className="space-y-3 scroll-mt-[180px]" data-testid="streams-section">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">残留病监测</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              形态学（骨髓象）／流式（FCM-MRD）／分子（qPCR BCR-ABL1）三条检测维度分别记录、分别判定。
              三类「%」不是同一把尺，<span className="text-slate-600">不合并、不平均</span>。
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              指标由骨髓检查（骨髓形态学、流式免疫分型、融合基因定量）的检验报告自动生成；识别有误可删除该点后重新导入报告。
            </p>
          </div>
          <Tooltip
            title={
              <span>
                CR 原始/幼稚 ≤{TARGETS.morph}% · FCM-MRD &lt;{TARGETS.fcm}% · MMR ≤{TARGETS.pcr}% · CMR 未检出
                <br />
                医学标准 v{THRESHOLDS_VERSION}，页面不可编辑
              </span>
            }
          >
            <Tag color="blue">医学标准 v{THRESHOLDS_VERSION}</Tag>
          </Tooltip>
        </div>
      </div>

      {/* 缓解阶梯：CR 是及格线，CMR 是金牌准入证 */}
      <Card data-testid="ladder">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">缓解阶梯</h3>
            <p className="mt-0.5 text-[11px] text-slate-400">
              CR 是及格线，CMR 是金牌准入证；缺数据/陈旧不越级认证。CMR 以分子学（qPCR 未检出）为准，FCM
              阴性只决定是否标「双证」。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {view.ladder.tier === 4 && view.ladder.certify === 'molecular' && (
              <Tooltip title="qPCR（分子学）未检出即可判 CMR；本次没有有效期内阴性的 FCM 佐证，故未标双证">
                <Tag color="cyan">仅分子学</Tag>
              </Tooltip>
            )}
            <Tag color={view.ladder.tier >= 4 ? 'gold' : view.ladder.tier >= 2 ? 'blue' : view.ladder.tier >= 1 ? 'green' : 'default'}>
              {view.ladder.label}
            </Tag>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {RUNGS.map((r) => {
            const reached = view.ladder.tier >= r.tier
            const current = view.ladder.tier === r.tier
            return (
              <div
                key={r.tier}
                className={[
                  'rounded-lg border px-3 py-2 transition-colors',
                  reached
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-dashed border-slate-300 bg-slate-50 text-slate-400',
                  current ? 'ring-2 ring-brand-300 ring-offset-1' : '',
                ].join(' ')}
                title={r.desc}
              >
                <div className={`text-[10px] ${reached ? 'text-white/70' : 'text-slate-400'}`}>第 {r.tier} 级</div>
                <div className="text-sm font-semibold">{r.label}</div>
                <div className={`mt-0.5 text-[10px] leading-tight ${reached ? 'text-white/80' : 'text-slate-400'}`}>
                  {r.desc}
                </div>
              </div>
            )
          })}
        </div>

        {view.states.pcr && !view.states.pcr.missing && view.states.pcr.stale && (
          <div className="mt-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
            <span className="font-medium">qPCR 已 {view.states.pcr.daysSince} 天未复查</span>
            （有效期 {STREAMS.pcr.staleDays} 天）：分子学档位无法认证，CMR 不能挂着不复查，请尽快补一次
            BCR-ABL1 定量。
          </div>
        )}

        {view.ladder.gaps.length > 0 && (
          <ul className="mt-2 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            {view.ladder.gaps.map((g, i) => (
              <li key={i}>· {g}</li>
            ))}
          </ul>
        )}
        {view.ladder.conflicts.length > 0 && (
          <ul className="mt-2 space-y-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
            {view.ladder.conflicts.map((c, i) => (
              <li key={i}>· {c}</li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
          <span>
            认证维度：{view.ladder.certifiers.length ? view.ladder.certifiers.map((k) => STREAM_LABEL[k]).join(' + ') : '无'}
          </span>
          <span>
            最近检测：
            {STREAM_ORDER.map((k) => `${STREAM_LABEL[k]} ${view.states[k].latest ? String(view.states[k].latest.date).slice(5) : '—'}`).join(' · ')}
          </span>
        </div>

        {/* 持续 CMR 进度条：只做展示，不升档位（终点按日历年算，间隔超上限即归零） */}
        {(view.streak.count > 0 || view.streak.broken) && (
          <div className="mt-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            {view.streak.count > 0 ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-[11px] font-medium text-slate-700">
                    持续分子学缓解 · 至 {view.progress.years} 年里程碑
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">
                    {view.progress.elapsedDays} / {view.progress.totalDays} 天 · {view.progress.pct}%
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={`h-full rounded-full transition-all ${view.progress.state === 'due' ? 'bg-amber-500' : 'bg-teal-600'}`}
                    style={{ width: `${Math.max(view.progress.pct, 1)}%` }}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                  <span>
                    起算 {view.streak.from}（首次未检出）· 终点 {view.progress.targetDate}
                  </span>
                  <span>
                    连续 {view.streak.count} 次 · 段内最长间隔 {view.streak.maxGapDays} 天（上限{' '}
                    {CMR_STREAK.maxGapDays}）
                  </span>
                  {view.progress.state === 'due' ? (
                    <span className="text-amber-700">
                      最近一次已 {view.progress.sinceLast} 天（有效期 {view.progress.staleDays} 天）：待复查，档位已按陈旧降级
                    </span>
                  ) : (
                    view.progress.sinceLast != null && (
                      <span>
                        距下次复查 {Math.max(0, view.progress.staleDays - view.progress.sinceLast)} 天内完成
                      </span>
                    )
                  )}
                </div>
              </>
            ) : (
              <div className="text-[11px] text-slate-500">连续段已中断：当前没有可信的连续未检出记录</div>
            )}
            {view.streak.broken && (
              <div className="mt-1 text-[11px] text-slate-400">
                上一段曾连续 {view.streak.broken.count} 次 / {view.streak.broken.days} 天（{view.streak.broken.from} ~{' '}
                {view.streak.broken.to}），因间隔 {view.streak.broken.gapDays} 天超过上限已中断，不计入持续缓解。
              </div>
            )}
          </div>
        )}
      </Card>

      {STREAM_ORDER.map((key) => renderCard(key))}
    </section>
  )
}
