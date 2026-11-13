// ===================== 条件渲染浮层里的 Esc 关闭（不渲染任何 DOM）=====================
// 小确认框（z-[60] 那层）是 `{confirming && <div>…</div>}` 这种条件渲染，
// 组件里没法在条件分支里调 hook（hooks 顺序会被破坏），所以把 hook 收进这个空组件：
//   {confirming && (<div …><EscClose onClose={() => setConfirming(false)} />…</div>)}
// 因为它在确认框打开时才挂载 → 注册顺序晚于外层浮层 → 栈顶判定天然只关确认框。
import { useEscClose } from '../utils/overlay.js'

export default function EscClose({ onClose, enabled = true }) {
  useEscClose(onClose, enabled)
  return null
}
