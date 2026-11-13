// ===================== 弹层通用交互 hooks（Esc 关闭 / 背景滚动锁）=====================
// 与 src/utils/escStack.js（纯逻辑）配套：这里只做 React 侧挂载/卸载。
import { useEffect, useRef } from 'react'
import { pushEscHandler, removeEscHandler } from './escStack.js'

// Esc 关闭当前浮层。多层叠加时只有最上层响应（见 escStack.js 的口径）。
// onClose 用 ref 持有：调用方传闭包/内联函数也不会重复注册（不用加 deps）。
export function useEscClose(onClose, enabled = true) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (!enabled) return
    const id = pushEscHandler((e) => ref.current && ref.current(e))
    return () => removeEscHandler(id)
  }, [enabled])
}

// 背景滚动锁：浮层打开期间锁住 body 滚动（否则滚轮在遮罩上会滚到底下页面，弹层看着「跟着动」）。
// 引用计数：叠多层时只在最后一层关闭后才解锁。
let lockCount = 0
let prevOverflow = ''

export function useBodyScrollLock(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    if (lockCount === 0) {
      prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    lockCount++
    return () => {
      lockCount = Math.max(0, lockCount - 1)
      if (lockCount === 0) document.body.style.overflow = prevOverflow
    }
  }, [enabled])
}
