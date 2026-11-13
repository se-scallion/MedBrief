// 识别诊断统一出口：渲染 ocr.js / normalize.js 收敛出的 issues[]。
// level: error（红，阻断保存） / warn（黄，提示核对） / info（灰，已自动处理告知）。
// 来源：ocr.js extractReportDate 的 issues（日期）+ normalize.js collectRecognizeIssues（grid 静默失败信号）。
export default function RecognizeIssues({ issues = [] }) {
  if (!issues || !issues.length) return null
  const order = { error: 0, warn: 1, info: 2 }
  const sorted = [...issues].sort((a, b) => (order[a.level] ?? 1) - (order[b.level] ?? 1))
  const hasError = sorted.some((i) => i.level === 'error')
  const wrap = hasError ? 'card p-4 bg-red-50 border-red-300' : 'card p-4 bg-amber-50 border-amber-300'
  return (
    <div className={wrap}>
      <p className="text-sm font-medium text-amber-900">
        {hasError ? '⛔ 识别有问题，请处理后再保存' : '⚠️ 识别结果需要你确认'}
      </p>
      <ul className="mt-2 space-y-1">
        {sorted.map((e, i) => (
          <li key={i} className="text-xs text-amber-800">
            {e.level === 'error' ? '⛔' : e.level === 'info' ? 'ℹ️' : '·'} {e.message}
          </li>
        ))}
      </ul>
    </div>
  )
}
