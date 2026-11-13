// ===================== Esc 关闭浮层 · 栈式调度（纯逻辑，零 React 依赖，可单测）=====================
// 症状（改前）：多个弹层各自 addEventListener('keydown')，一次 Esc 会把「上面那层 + 下面那层」
// 一起关掉 —— 例：报告详情里再开「重新识别」，按 Esc 连报告详情一起没了；报告详情里弹
// CloudConsentModal 确认框，Esc 会把确认框和详情同时关掉。
//
// 口径：同一时刻只有「最后注册（视觉上最上层）」的那层响应 Esc，关完再按一次才轮到下一层。
// 守卫（避免抢按键）：
//   ① e.key 必须是 Escape，且非输入法组字中（isComposing）、未被更早的处理器消费（defaultPrevented）；
//   ② 焦点在 input / textarea / select / contenteditable 里时**不关浮层** —— 那种场合 Esc 属于
//      「取消当前这格编辑」（如 DataGrid 的代码搜索框自己处理 Esc），关窗口会把用户正在做的事一起吞掉。
//
// 用法（React 侧）：src/utils/overlay.js 的 useEscClose(onClose, enabled)；
// 条件渲染的小确认框（z-[60]）用 <EscClose onClose={...} />（src/components/EscClose.jsx）。

const handlers = [] // [{ id, close }]，末尾 = 最上层
let seq = 0
let listening = false

function onKeyDown(e) {
  dispatchEsc(e)
}

function ensureListening(on) {
  if (typeof window === 'undefined') return
  if (on && !listening) {
    window.addEventListener('keydown', onKeyDown)
    listening = true
  } else if (!on && listening) {
    window.removeEventListener('keydown', onKeyDown)
    listening = false
  }
}

// 焦点是否落在可编辑元素里（此类 Esc 让给元素自己处理）
export function isEditableTarget(t) {
  if (!t || typeof t !== 'object') return false
  const tag = String(t.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return !!t.isContentEditable
}

// 注册一层浮层，返回 id（用于卸载时摘除）。后注册 = 更上层。
export function pushEscHandler(close) {
  const entry = { id: ++seq, close }
  handlers.push(entry)
  ensureListening(true)
  return entry.id
}

export function removeEscHandler(id) {
  const i = handlers.findIndex((h) => h.id === id)
  if (i >= 0) handlers.splice(i, 1)
  if (!handlers.length) ensureListening(false)
}

// 派发一次按键：返回 true = 已交给最上层关闭；false = 本次忽略（不关任何层）
export function dispatchEsc(e) {
  if (!e || e.key !== 'Escape') return false
  if (e.defaultPrevented || e.isComposing) return false
  if (isEditableTarget(e.target)) return false
  const top = handlers[handlers.length - 1]
  if (!top || typeof top.close !== 'function') return false
  top.close(e)
  return true
}

// 当前叠了几层（诊断/单测用）
export function escStackDepth() {
  return handlers.length
}

// 单测复位（生产代码不要调用）
export function __resetEscStack() {
  handlers.length = 0
  seq = 0
  ensureListening(false)
}
