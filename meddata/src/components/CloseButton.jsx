// ===================== 统一「关闭」按钮（右上角 × 图标）=====================
// 与 BackButton（← 返回）镜像成对：纯图标方形按钮，无文字，title 兼作 hover tooltip 与 aria-label。
// 为什么不用文字「关闭」：浮层头部右上角是肌肉记忆位置，× 比两个汉字省版面且不抢标题；
// 弹层头部往往还要放「重新识别 / 删除」等操作，文字按钮会把这一排挤满。
//
// tone：'light' 浅色页头（白/灰底，默认）｜'dark' 深色页头（深色工具条）
// size：'md' 36px（与 BackButton 等高，独立页头用）｜'sm' 28px（弹层紧凑头部，与 text-xs 按钮同高）
// Esc 关闭不在这里做 —— 统一走 useEscClose（栈式，只关最上层，见 utils/escStack.js）。
export default function CloseButton({
  onClick,
  tone = 'light',
  size = 'sm',
  title = '关闭',
  className = '',
  testId,
}) {
  const toneCls =
    tone === 'dark'
      ? 'bg-slate-800/60 border-slate-600 text-slate-200 hover:bg-slate-700 hover:text-white hover:border-slate-500'
      : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900 hover:border-slate-300'
  const sizeCls = size === 'md' ? 'h-9 w-9' : 'h-7 w-7'
  const icon = size === 'md' ? 18 : 16

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      title={title}
      data-testid={testId}
      className={`inline-flex items-center justify-center rounded-lg border transition-colors cursor-pointer shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70 ${sizeCls} ${toneCls} ${className}`}
    >
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  )
}
