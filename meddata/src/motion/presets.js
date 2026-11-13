// 全站动效统一规范：时长 / 缓动 / 变体（纯声明，供 motion 组件消费）
// 约束（见 .agents/testing-lessons.md「动效红线」）：只动 transform/opacity；
// 时长 150/180/260ms；缓动统一 [0.2,0.8,0.2,1]；读数区不加花哨动画。
import { DUR, EASE } from './anim.js'

// 页面路由转场：淡入 + 轻微上移（mode="wait"，旧页退场完才挂新页）
export const pageVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
  exit: { opacity: 0, y: -8, transition: { duration: DUR.fast, ease: EASE } },
}

// 列表 stagger 入场（容器驱动子项依次进入）
export const listContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
}
export const listItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DUR.fast, ease: EASE } },
}

// 浮层 / 弹层弹出（导出、清洗、明细等 fixed 弹层可复用）
export const popVariants = {
  initial: { opacity: 0, scale: 0.96, y: 6 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: DUR.fast, ease: EASE } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: DUR.fast, ease: EASE } },
}
