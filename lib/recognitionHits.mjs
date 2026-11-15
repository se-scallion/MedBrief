// M3 观测件：legacy 命中按天计数（**只读观测，不改任何路由行为**）
//
// 背景（主理人 2026-11-15 批准）：物理删除旧识别代码前，必须先看到一段时间内
//   `MEDREC_BACKEND=legacy` 与旧五件套的调用 **0 命中**。
//   两侧响应/日志里已有 `source=legacy` / `recognitionSource`，缺的只是**按天汇总**。
//
// 设计（刻意选 append-only 而不是 read-modify-write）：
//   · 每次命中只 append 一行 NDJSON（O_APPEND，小行原子），**不做读改写** ——
//     否则 5174 并发 6 路 OCR 时计数会互相覆盖（F9 并发写冲突），门禁就不可信了。
//   · 只记 ts / side / route / backend / kind，**不记患者内容、URL query、body**。
//   · 汇总视图按需扫文件聚合（一天几千行也就几 KB，无需常驻内存 / 无需定时器）。
//
// 存储：data/recognition-hits.jsonl（data/ 已被 .gitignore 覆盖；不入版本库）
//   MedBrief 与 MedData 各自一份，互不干扰；也可用 MEDREC_HITS_FILE 指到同一份做合并看板。

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_FILE = path.resolve('data', 'recognition-hits.jsonl')
export const hitsFile = () => process.env.MEDREC_HITS_FILE || DEFAULT_FILE

/** 本机时区（UTC+8）下的 YYYY-MM-DD；传 t 便于断言固定日期 */
export function dayKey(t = new Date()) {
  return new Date(t.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 记一次命中。**不抛错**（观测件绝不能把业务请求带崩）。
 * @param {{side:'medbrief'|'meddata', route:string, backend:'legacy'|'8011', kind?:string}} evt
 */
export function bump(evt = {}, { file = hitsFile(), now = new Date() } = {}) {
  try {
    const rec = {
      ts: now.toISOString(),
      day: dayKey(now),
      side: String(evt.side || 'unknown'),
      route: String(evt.route || 'unknown'),
      backend: evt.backend === '8011' ? '8011' : 'legacy',
      kind: String(evt.kind || 'request'),
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
    return rec
  } catch {
    return null
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)] } catch { return [] }
    })
  } catch {
    return []
  }
}

/**
 * 只读汇总视图：最近 N 天 + 累计。M3 门禁看 `lastNDaysLegacy === 0`。
 * 只做聚合，不改文件、不清理历史（清理是 M3 之后的事）。
 */
export function summary({ file = hitsFile(), days = 7, now = new Date(), minSamples = 50 } = {}) {
  const lines = readLines(file)
  const byDay = new Map()
  let totalLegacy = 0
  let totalSvc = 0
  for (const r of lines) {
    const d = byDay.get(r.day) || { day: r.day, total: 0, legacy: 0, svc: 0, bySide: {}, byRoute: {}, legacyByRoute: {} }
    d.total++
    if (r.backend === 'legacy') {
      d.legacy++
      totalLegacy++
      const k = `${r.side}:${r.route}${r.kind && r.kind !== 'request' ? ':' + r.kind : ''}`
      d.legacyByRoute[k] = (d.legacyByRoute[k] || 0) + 1
    } else {
      d.svc++
      totalSvc++
    }
    d.bySide[r.side] = (d.bySide[r.side] || 0) + 1
    const rk = `${r.side}:${r.route}`
    d.byRoute[rk] = (d.byRoute[rk] || 0) + 1
    byDay.set(r.day, d)
  }
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(new Date(now.getTime() - i * 86400 * 1000))
    out.push(byDay.get(day) || { day, total: 0, legacy: 0, svc: 0, bySide: {}, byRoute: {}, legacyByRoute: {} })
  }
  const lastNDaysLegacy = out.reduce((s, x) => s + x.legacy, 0)
  const lastNDaysTotal = out.reduce((s, x) => s + x.total, 0)
  const observedDays = out.filter((x) => x.total > 0).length
  // M3 门禁（计划 §3）：不是「今天 0 命中」就算数 —— 必须
  //   ① 最近 N 天 legacy 全 0；② 最近 N 天**每天都有观测**（没数据的日子不算通过）；
  //   ③ 累计样本量 ≥ minSamples。否则一次请求就能把门禁刷绿，退役就没有意义。
  const reasons = []
  if (!lines.length) reasons.push('尚无观测数据（不是 0 命中，是没数据）')
  if (lastNDaysLegacy > 0) reasons.push(`最近 ${days} 天仍有 ${lastNDaysLegacy} 次 legacy`)
  if (observedDays < days) reasons.push(`最近 ${days} 天只有 ${observedDays} 天有观测数据`)
  if (lastNDaysTotal < minSamples) reasons.push(`最近 ${days} 天样本 ${lastNDaysTotal} < ${minSamples}`)
  return {
    generatedAt: now.toISOString(),
    file,
    lines: lines.length,
    days: out,
    lastNDaysLegacy,
    lastNDaysTotal,
    observedDays,
    minSamples,
    totalLegacy,
    totalSvc,
    retireGate: reasons.length === 0,
    retireNote: reasons.join('；') || undefined,
  }
}
