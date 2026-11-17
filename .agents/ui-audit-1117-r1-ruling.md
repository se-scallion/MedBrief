# UI 巡检 r1 判词 → 主理人裁定（规格 v0.2 必含的 6 条）

> 依据：`.agents/ui-audit-1117-review-r1.md`（AI Studio 带图审，总判 `不能直接进下一轮`，5 条 P0）。
> 本文件是**主理人裁定**，不是规格本身；UI设计师 把 6 条折进规格 v0.2 与巡检计划 v0.2，代诊-账号 按规格实现。
> 时间：2026-11-17。

## R1 判据定义修正（最重要，先改这个）
**L7 改为「累计内距」**：从 `[role=dialog]` 可视左缘（375 下即屏幕边）量到**内容左缘**，**期望 12±1**；
不许再以「某一层 padding 的值 = 12」作判据。当前实测累计 **32px** ⇒ 不合格。
配套：外壳 `width:100vw; max-width:100vw; margin:0; top:0`、头部 `paddingInline:12`、**`.ant-modal-content` / `styles.content` 默认 padding 必须显式归零**，否则改内层无效。三缘极差 ≤1 保留。

## 1. 弹窗（SourceModal）
- 375 贴边全屏；`100dvh` **取代 `100vh`**（r1 明确否决 `100vh`：iOS 地址栏会遮底部）；补 `env(safe-area-inset-bottom)`。
- 工具栏**不得裁切**（窄屏横滑 `wrap:false + overflowX:auto` 或精简文案）；**无原件时隐藏缩放/旋转整组**。
- **无原件占位压到 ≤120px** 紧凑提示（现在占 500–600px，把 `dialog.h` 顶到 1598px）。
- 判据 L12：`dialog.h ≤ 716`（812−96）且 body `overflowY:auto`；用 `100dvh` 计算。

## 2. 趋势卡（TrendsTab）
- `Card.extra` 与标题 **`flexWrap:'wrap'` + 零遮挡**：同容器内工具栏控件与标题 rect **交集面积 = 0**，且工具栏 `scrollWidth <= clientWidth`（r1 P0-1：图上「可选指标」被 `[网格|对比]` 盖住只剩「可」字）。
- 「生成中」标签**不得被垂直裁切**（含 04 总览页，P0-5）——给出裁切成因与改法。
- 刻度：viewBox `fontSize` 调到**渲染实测 ≥9px**（当前 375 实测 8px）；且**参考刻度 bbox 与末点标签 bbox 不相交**（1440 图已叠字）。
- 点列表：`-webkit-line-clamp:2` 真加（r1 指出实测计算值为 `none`），判据用 `scrollHeight <= clientHeight + 1`，不只测高度 34。

## 3. 断点口径（r1 否决原写法）
**维持 `minmax(min(380px,100%),1fr)`**；**删除「卡最小宽 320 / 768 切两列」表述**（按 380 算 768 切不出两列，1440 自然是 3 列 403px，已在 1440 图核实）。576–767 维持单列，给 SVG `max-height:180px` 防过高。

## 4. MVP 范围调整
**U6（打印弹窗 36px/侧，`CardPreview.jsx` `styles.body padding:0` + 窄屏 `100vw/top:0`）与 U13（登录页 2 个按钮 <44px）拉回 MVP**；U8/U9/U10/U12/U14 延后成立。

## 5. 账号页 U3（P0）
只加 `overflow-x:auto` **不够**：表格与列必须 `white-space:nowrap` + 列 `min-width`（否则手机号被压成 11 行竖排）。判据：375 下 `scrollWidth == innerWidth` 且手机号/操作/审计表不被右缘截断。

## 6. 补采与夹具（r1 A8）
- `12-modal-source-375/1440` **换成含真实图片 blob 的报告**（空态夹具天然对齐，掩盖缩放/旋转/真实高度问题）。
- 补一张 `scrollIntoView` 到趋势卡区的 375 截图（现图首屏全是复选框，拍不到卡）。
- 其余 24 张不重拍。

## 7. 移动端漏测七项（r1 A5，进清单并给测法）
`100dvh`、`env(safe-area-inset-*)`、软键盘 `visualViewport` 缩至 ~400px 时输入框/按钮可达、触摸端趋势圆点热区、表格 `nowrap+min-width`、`viewport-fit=cover` 与 <16px 输入框自动放大、横向 Tab 与局部裁切。
