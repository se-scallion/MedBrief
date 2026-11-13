// ===================== 检查报告 · 识别状态条（核对态顶部）=====================
// 双轨的「仪表盘」：本地识别（先行）+ AI 精读（常驻主按钮）。
// 关键交互约束（.agents/proposals/ai-first-doc-recognition.md §4.1(b)）：
//   · 「AI 识别」是**常驻主按钮**，不是识别失败后才出现的救援按钮（现状最大问题）；
//   · 本地识别还在跑时也能点 → 两条轨并行推进；
//   · 提交后明示「可以离开」，结果会进 AI 任务，不把用户绑在页面上；
//   · 不用装饰性符号（emoji/●○），状态靠文字 + 配色表达。
import { useEffect, useState } from 'react'
import { Button } from 'antd'

const fmtSec = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`

export default function DocAiStatusBar({
  ocrState,
  ocrElapsedMs,
  ocrFieldCount,
  ocrLabel = '本地识别',
  aiState,
  aiElapsedMs,
  aiResult,
  aiError,
  aiBlockedReason,
  readModeNote,
  onRun,
  onCancel,
  onReRecognize,
  recoLoading,
}) {
  // 运行中自走计时（agent 不回报进度，只能给「已用时长」，绝不假装百分比）
  const [now, setNow] = useState(Date.now())
  const running = aiState === 'running' || ocrState === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  const aiTicking = aiState === 'running'
  const conf = aiResult && aiResult.confidence && aiResult.confidence.overall
  const CONF_CN = { high: '高', medium: '中', low: '低' }
  const slow = aiTicking && aiElapsedMs > 90_000
  // 超过 2 分钟基本可以确定出事了（正常 30–70 秒）。给可执行的一句话，
  // 而不是让用户对着转圈干等——真正原因只在 logs/agent-<id>.log 里（见 diagnose-ai-task.mjs）。
  const suspicious = aiTicking && aiElapsedMs > 120_000

  return (
    <div
      className="card p-3 space-y-2"
      data-testid="doc-ai-status-bar"
      data-ai-state={aiState}
      data-ocr-state={ocrState}
    >
      {/* 本地识别轨 */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        <span className="font-medium text-slate-600 shrink-0">{ocrLabel}</span>
        {ocrState === 'running' && <span className="text-slate-500">识别中… {fmtSec(ocrElapsedMs)}</span>}
        {ocrState === 'done' && (
          <span className="text-emerald-700">
            已完成 · 解析出 {ocrFieldCount} 个字段
            {ocrElapsedMs ? ` · ${fmtSec(ocrElapsedMs)}` : ''}
          </span>
        )}
        {ocrState === 'failed' && <span className="text-amber-700">未成功（原件仍会完整保存，可手动填写）</span>}
        <span className="ml-auto flex items-center gap-2">
          {onReRecognize && (
            <Button size="small" loading={recoLoading} onClick={onReRecognize} title="对同一份原件重跑本地识别（不调用 AI）">
              重新识别
            </Button>
          )}
        </span>
      </div>

      <div className="border-t border-slate-100" />

      {/* AI 精读轨 */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        <span className="font-medium text-slate-600 shrink-0">AI 精读</span>

        {aiState === 'idle' && (
          <>
            <span className="text-slate-500">读原件转录所见 / 结论 / 测量值，质量优于本地识别{readModeNote ? ` · ${readModeNote}` : ''}</span>
            {aiBlockedReason && <span className="text-amber-700">{aiBlockedReason}</span>}
            <span className="ml-auto">
              <Button
                type="primary"
                size="small"
                data-testid="doc-ai-run"
                onClick={onRun}
                disabled={!!aiBlockedReason}
                title={aiBlockedReason || '把原件交给 AI 精读（可以离开页面，结果进 AI 任务）'}
              >
                AI 识别
              </Button>
            </span>
          </>
        )}

        {aiTicking && (
          <>
            <span className="inline-block w-3 h-3 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-brand-700">
              处理中 · {fmtSec(aiElapsedMs)}
              {slow && <span className="text-amber-600"> · 比平时慢，agent 可能在排队</span>}
            </span>
            {suspicious ? (
              <span className="text-amber-700">
                超过 2 分钟没有结果，常见原因：额度不足 / 限流 / agent 中断 · 排查：
                <code className="mx-1 rounded bg-slate-100 px-1">node scripts/diagnose-ai-task.mjs</code>
              </span>
            ) : (
              <span className="text-slate-400">可以离开页面，完成后结果会进「AI 任务」</span>
            )}
            <span className="ml-auto">
              <Button size="small" onClick={onCancel} title="停止等待（agent 可能仍在后台跑完，结果会进 AI 任务）">
                取消
              </Button>
            </span>
          </>
        )}

        {aiState === 'done' && (
          <>
            <span className="text-emerald-700">
              完成 · {fmtSec(aiElapsedMs)}
              {conf ? ` · 置信度 ${CONF_CN[conf] || conf}` : ''}
              {' · 已作为当前生效结果'}
            </span>
            <span className="ml-auto flex gap-2">
              <Button size="small" data-testid="doc-ai-rerun" onClick={onRun} title="再跑一次 AI 精读（覆盖 AI 轨，不影响你的手改）">
                重新 AI 识别
              </Button>
            </span>
          </>
        )}

        {aiState === 'failed' && (
          <>
            <span className="text-amber-700">{aiError || 'AI 精读未成功'}</span>
            <span className="text-slate-400">本地识别结果照常可用</span>
            <span className="ml-auto">
              <Button size="small" data-testid="doc-ai-retry" onClick={onRun}>
                重试
              </Button>
            </span>
          </>
        )}

        {aiState === 'rate_limited' && (
          <>
            <span className="text-amber-700">{aiError || 'AI 接口限流中'}</span>
            <span className="text-slate-400">稍后自动重试；也可先用本地识别结果核对</span>
            <span className="ml-auto">
              <Button size="small" data-testid="doc-ai-retry" onClick={onRun}>
                立即重试
              </Button>
            </span>
          </>
        )}

        {aiState === 'background' && (
          <>
            <span className="text-amber-700">2 分钟没出结果，已转后台继续精读 · 已用 {fmtSec(aiElapsedMs)}</span>
            <span className="text-slate-400">
              {aiError || '可先核对 / 保存本地识别结果；AI 出结果会自动并入，关掉页面也能在「AI 任务」里找回'}
            </span>
            <span className="ml-auto">
              <Button size="small" data-testid="doc-ai-retry" onClick={onRun}>
                重新提交
              </Button>
            </span>
          </>
        )}

        {aiState === 'skipped' && (
          <>
            <span className="text-slate-500">{aiBlockedReason || 'AI 精读当前不可用'}</span>
            <span className="ml-auto">
              <Button size="small" data-testid="doc-ai-retry" onClick={onRun}>
                重试
              </Button>
            </span>
          </>
        )}
      </div>
    </div>
  )
}
