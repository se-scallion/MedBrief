// 体温卡 → 管理页 的 FLIP 放大：缓存卡片起点 rect（DOMRect），
// 管理页挂载时用 motion 反向播放「从小卡放大到整页」的动画。取后即清，避免回退时拿到过期 rect。
const flips = new Map()

export function saveFlip(key, rect) {
  flips.set(key, rect)
}

export function takeFlip(key) {
  // 仅读取不删除：避免 React StrictMode 双调用 render 把 rect 清掉导致 FLIP 丢失。
  // 每次进入都会由 saveFlip 覆盖为最新卡片 rect，无需「取后即清」。
  const r = flips.get(key)
  return r || null
}
