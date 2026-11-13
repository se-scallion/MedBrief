// ===================== 检查报告 · 字段轨切换器（AI / OCR / 手改）=====================
// 三轨模型的唯一交互入口（见 .agents/proposals/ai-first-doc-recognition.md §3.3）：
//   [AI 精读][本地识别] 两枚 chip 表示该字段的两条轨道，高亮的那枚 = 当前生效；
//   点另一枚 = 把该字段切到那条轨的值（不弹窗、不丢另一轨的值，可来回切）。
//   用户手打后该字段锁定为「已手改」轨：此时不再显示两枚 chip，改显示「已手改」+「采用 AI 结果」。
//
// UI 约束：不用装饰性符号（●/○ 等），靠描边与配色表达选中态；本组件不承载任何 hover 浮层。
import { trackOf } from '../utils/docAi.js'

const has = (bag, field) => bag && bag[field] !== undefined

export default function DocTrackSwitcher({ form, field, onSwitch, size = 'sm' }) {
  const tracks = (form && form._tracks) || {}
  const aiHas = has(tracks.ai, field)
  const ocrHas = has(tracks.ocr, field)
  if (!aiHas && !ocrHas) return null
  const cur = trackOf(form, field)
  const cls = [
    'inline-flex items-center rounded border px-1.5 leading-5 transition-colors',
    size === 'xs' ? 'text-[10px]' : 'text-[11px]',
  ].join(' ')
  const chip = (key, label, available) => {
    const active = cur === key
    const tone = key === 'ai' ? 'ai' : 'ocr'
    const activeCls =
      tone === 'ai'
        ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
        : 'border-slate-300 bg-slate-100 text-slate-600 font-medium'
    return (
      <button
        type="button"
        data-testid={`doc-track-${field}-${key}`}
        disabled={!available}
        title={
          available
            ? `切到${label}的结果${active ? '（当前生效）' : ''}`
            : `${label}没有该字段的值`
        }
        onClick={() => available && !active && onSwitch && onSwitch(field, key)}
        className={`${cls} ${active ? activeCls : 'border-transparent text-slate-400 hover:text-slate-600'} ${
          available ? '' : 'opacity-40 cursor-not-allowed'
        }`}
      >
        {label}
      </button>
    )
  }

  if (cur === 'user') {
    return (
      <span className="inline-flex items-center gap-1" data-testid={`doc-track-${field}-locked`}>
        <span className={`${cls} border-amber-300 bg-amber-50 text-amber-700 font-medium`} title="你手改过该字段，机器结果不会覆盖它">
          已手改
        </span>
        {aiHas && (
          <button
            type="button"
            data-testid={`doc-track-${field}-adopt-ai`}
            className={`${cls} border-transparent text-brand-600 hover:bg-brand-50`}
            title="用手改前的 AI 精读结果替换当前值"
            onClick={() => onSwitch && onSwitch(field, 'ai')}
          >
            采用 AI 结果
          </button>
        )}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1" data-testid={`doc-track-${field}`}>
      {chip('ai', 'AI 精读', aiHas)}
      {chip('ocr', '本地识别', ocrHas)}
    </span>
  )
}
