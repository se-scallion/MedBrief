// ===================== 概览（首页仪表盘） =====================
// 只放「状态总览」：分型资料卡（左上）+ 数据统计卡 + 待核对错配 + 趋势图。
// 检验记录 / 日程 / 归档已分类进独立页面（顶栏导航）；低频工具（导出 / 清洗）收在页脚。
// 体温卡已迁到指标页（/cbc）——首页只留「病人↔医生共读」的分型卡与统计，体温属日常监测。

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Empty, Tag } from 'antd'
import TrendChart from './TrendChart.jsx'
import TypingCard from './TypingCard.jsx'

export default function Dashboard({ records, events, onViewDetail, onExpandCBC, onClean, onExport, onImport }) {
  const navigate = useNavigate()
  const stats = useMemo(() => {
    // data_points 兜底：老记录/测试记录可能缺该字段（undefined），flatMap 会把 undefined
    // 展平成数组元素，下游 .map(p => p.standard_code) 即炸 TypeError（2026-10-12 实测）
    const all = records.flatMap((r) => r.data_points || [])
    // 危急 / 偏离按「指标种类 × 最近一次记录状态」统计（日期升序遍历、后者覆盖 = 取最后一次）：
    // 同一指标（如血小板）多个日期反复危急只计最后一个状态，避免计数随时间越堆越大、误导严重程度
    const lastStatus = new Map()
    const byDate = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    for (const r of byDate) {
      for (const p of r.data_points || []) {
        if (p.standard_code && p.status) lastStatus.set(p.standard_code, p.status)
      }
    }
    const statuses = [...lastStatus.values()]
    const critical = statuses.filter((s) => s.startsWith('CRITICAL')).length
    const abnormal = statuses.filter((s) => s === 'LOW' || s === 'HIGH').length
    const dates = [...new Set(records.map((r) => r.date))].sort()
    const fields = new Set(all.map((p) => p.standard_code).filter(Boolean))
    return {
      count: records.length,
      days: dates.length,
      fields: fields.size,
      critical,
      abnormal,
      latest: dates.length ? dates[dates.length - 1] : null,
      markers: events.length,
    }
  }, [records, events])

  // 待核对错配：单位与参考范围「同时」与标准档案不符。
  // 单独一项不符多为仪器标准差异（属正常），两项同时不符基本可判定该行有问题——
  // 典型是整行 value/unit/ref 来自另一个指标行（跨行错配），需对照原图核对。
  const mismatchItems = useMemo(() => {
    const out = []
    for (const r of records) {
      for (const p of r.data_points || []) {
        const a = p._audit
        if (a && a.unit === 'mismatch' && a.ref === 'mismatch') out.push({ record: r, p })
      }
    }
    return out
  }, [records])

  const empty = records.length === 0

  return (
    <div className="space-y-6">
      {empty ? (
        /* ---------- 空状态引导 ---------- */
        <Card className="bg-gradient-to-br from-brand-50 via-white to-white border-brand-200">
          <div className="text-center py-10">
            <div className="mx-auto w-20 h-20 rounded-2xl bg-brand-500 flex items-center justify-center text-4xl shadow-lg shadow-brand-500/30 mb-5">
              🧪
            </div>
            <h2 className="text-xl font-bold text-slate-800">开始建立你的检测数据档案</h2>
            <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto leading-relaxed">
              上传化验单照片或 PDF，系统自动完成 OCR 识别与标准化，核对后一键入库，并自动生成趋势分析大屏。
            </p>
            {/* 只用**一个**入口：走顶栏同一套三选（检验 / 检查 / 文书），
                避免空态按钮与顶栏入口各说各话、且旧的两个按钮覆盖不到文书 */}
            <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
              <Button type="primary" size="large" onClick={() => (onImport ? onImport() : navigate('/reports/add?flow=lab'))}>
                ＋ 导入资料
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          {/* ---------- 北区两卡：左＝分型资料卡（病人↔医生共读），右＝数据总览（化验记录 + 治疗事件） ---------- */}
          <section className="grid gap-3 md:grid-cols-2">
            {/* 分型资料卡：就诊医院 / 患病时间 / 分型 / 基因特点 / 当前疗程 / 当前阶段，各行可点跳转 */}
            <TypingCard />
            {/* 化验记录 + 治疗事件（合并卡） */}
            <Card
              hoverable
              title={null}
              styles={{ body: { padding: 16 } }}
              className="!h-full"
            >
              <div className="grid grid-cols-2 divide-x divide-slate-100">
                {/* 化验记录（跳检验页） */}
                <div
                  className="group pr-4 text-left w-full rounded-xl cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
                  onClick={() => navigate('/reports?tab=lab')}
                  title="查看全部已归档化验记录 → 报告页·检验"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex items-center gap-1 text-[11px] font-medium text-slate-400">
                      <span aria-hidden className="text-xs">📋</span>
                      化验记录
                    </p>
                    <span
                      aria-hidden
                      className="mt-0.5 shrink-0 text-slate-300 transition-all group-hover:text-brand-500 group-hover:translate-x-0.5"
                    >
                      ›
                    </span>
                  </div>
                  <div className="mt-2 flex items-end justify-start gap-6">
                    <div>
                      <p className="text-3xl font-bold tracking-tight leading-none text-slate-800">{stats.count}</p>
                      <p className="mt-1 text-[11px] text-slate-400">已归档记录</p>
                    </div>
                    <div>
                      <p className="text-3xl font-bold tracking-tight leading-none text-slate-800">{stats.days}</p>
                      <p className="mt-1 text-[11px] text-slate-400">覆盖天数</p>
                    </div>
                  </div>
                  {stats.latest && <p className="mt-2 text-[11px] text-slate-400 truncate">最新记录 {stats.latest}</p>}
                </div>

                {/* 治疗事件（跳日程页） */}
                <div
                  className="group pl-4 text-left w-full rounded-xl cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
                  onClick={() => navigate('/schedule')}
                  title="查看 / 增删治疗事件 → 日程页"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex items-center gap-1 text-[11px] font-medium text-slate-400">
                      <span aria-hidden className="text-xs">📍</span>
                      治疗事件
                    </p>
                    <span
                      aria-hidden
                      className="mt-0.5 shrink-0 text-slate-300 transition-all group-hover:text-brand-500 group-hover:translate-x-0.5"
                    >
                      ›
                    </span>
                  </div>
                  <div className="mt-2">
                    <p className="text-3xl font-bold tracking-tight leading-none text-slate-800">{stats.markers}</p>
                    <p className="mt-1 text-[11px] text-slate-400">输血 / 用药记录</p>
                  </div>
                </div>
              </div>
            </Card>
          </section>

          {/* ---------- 待核对错配（整行串行嫌疑，需对照原图）---------- */}
          {mismatchItems.length > 0 && (
            <Card title={<span className="text-sm font-semibold text-slate-700">待核对错配（{mismatchItems.length}）</span>}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[11px] text-slate-400">
                  单位与参考范围同时不符 → 多为整行串行；点「查看」对照原图，可一键改判
                </span>
              </div>
              <ul className="divide-y divide-slate-100">
                {mismatchItems.slice(0, 8).map((it, i) => (
                  <li key={i} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="font-mono text-slate-500 shrink-0">{it.record.date}</span>
                    <span className="text-slate-700 shrink-0">{it.p.original_name || it.p.standard_code || '—'}</span>
                    <span className="font-mono text-[11px] text-slate-400 shrink-0">{it.p.standard_code}</span>
                    <span className="text-slate-500 truncate">
                      {it.p.value} {it.p.unit} · 参考 {it.p.ref_range}
                    </span>
                    {it.p._audit && it.p._audit.suggestCode && (
                      <Tag color="blue" className="shrink-0">
                        反推指向 {it.p._audit.suggestName || it.p._audit.suggestCode}
                      </Tag>
                    )}
                    <Button
                      type="link"
                      size="small"
                      className="!ml-auto !px-0 !text-brand-600"
                      onClick={() => onViewDetail(it.record)}
                    >
                      查看
                    </Button>
                  </li>
                ))}
              </ul>
              {mismatchItems.length > 8 && (
                <p className="pt-2 text-[11px] text-slate-400 border-t border-slate-100">
                  仅显示前 8 条，共 {mismatchItems.length} 条
                </p>
              )}
            </Card>
          )}

          {/* ---------- 趋势图（全血细胞分析主视图） ---------- */}
          <section id="trend-chart" className="scroll-mt-20">
            <TrendChart
              records={records}
              events={events}
              onExpandCBC={onExpandCBC}
              badges={{ critical: stats.critical, abnormal: stats.abnormal }}
            />
          </section>

          {/* ---------- 低频数据工具（不占顶栏：导出 / 清洗从页脚进入） ---------- */}
          <Card className="!py-2.5">
            <div className="flex items-center justify-between gap-3 px-2">
              <p className="text-[11px] text-slate-400">检验记录、日程、归档请在顶部导航进入对应页面</p>
              <div className="flex items-center gap-4 shrink-0">
                <Button type="link" size="small" className="!px-0" onClick={onExport} title="导出全部数据备份（Markdown / JSON / Prompt）">
                  导出数据
                </Button>
                <Button type="link" size="small" className="!px-0" onClick={onClean} title="按最新识别规则清洗历史数据：重映射指标 / 修正标题 / 合并重复">
                  清洗历史数据
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
