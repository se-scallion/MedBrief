// ===================== 统一「路由返回」按钮 =====================
// 纯图标方形按钮：内嵌 SVG 左箭头，无文字。所有下钻子页共用，保证四页视觉/交互一致
// （此前 CBC 深色描边、体温页 antd 小按钮、导入流程带文字 BackButton 三种实现并存）。
// tone：'light' 浅色页面（默认，白/灰底） / 'dark' 深色页头（CBC 顶栏、导入流程深色工具条）。
// title：兼作 hover tooltip 与 aria-label；导入流批量时传「退出批量」。
import { useEscClose } from '../utils/overlay.js'

export default function BackButton({
  onClick,
  tone = 'light',
  title = '返回',
  testId,
  className = '',
  enableEsc = false,
}) {
  const toneCls =
    tone === 'dark'
      ? 'bg-slate-800/60 border-slate-600 text-slate-200 hover:bg-slate-700 hover:text-white'
      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900 hover:border-slate-300'

  // 可选 Esc 返回：注册进统一栈（utils/escStack.js）——页内浮层打开时它是「后来的那层」，
  // 会先吃掉 Esc，不会出现「一次 Esc 连浮层带页面一起退」。
  useEscClose(() => onClick?.(), enableEsc)

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      title={title}
      data-testid={testId}
      className={`inline-flex items-center justify-center h-9 w-9 rounded-lg border transition-colors cursor-pointer shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70 ${toneCls} ${className}`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
    </button>
  )
}
