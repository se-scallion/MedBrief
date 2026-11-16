# ① 批量导入模块 —— **UI/交互数值规格** v1.5（UI 设计师，2026-11-17 0:5x）

> **v1.5 新增 §1.1「组件选型：antd 优先」**（主理人口径 2026-11-17：「设计要优先使用已有的 antd 框架组件」）。
> 逐件把本批 UI 映射到 antd 组件（`antd@6.6.6`，`Flex/Dropdown/Badge/Tooltip/Popover/Space/Typography/Checkbox/Tag/Button/Card` 均已确认存在），
> 并把 v1.4 里**手写实现的地方改回 antd 组件**：删除按钮 → `Button`、更多 → `Dropdown`、灰字 → `Typography.Text`、序号徽标 → `Badge`、栏布局 → `Flex`。
> 同时新增**红线：禁止用原生标签重画 antd 已有控件**（详见 §1.1 末）。

> **v1.4 只改 §8 A1 的一行判据**（r4 的 P0 原样复发在我这边 → 已认）：
> 原写法 `if (!(span > 100)) fail('夹具不合格…')` 把 **`span ≤ 0`（内容本就不足一屏）也判红** —— 而那是**正确行为**（本就不该吸底），等于把正确实现判红。
> 改为**三分支**：`span > 100` ⇒ 主体（唯一承担 sticky/static 证伪，滚到 `span*0.5` 后 `|innerHeight − bar.bottom| ≤ 1`）；`span ≤ 0` ⇒ 短列表护栏（滚到底，只断 `bar.bottom ≤ innerHeight + 1`）；**只有 `0 < span ≤ 100` 的灰区才 `fail`**（可用 `viewport.height − 200` 重跑一次）。
> **不许用 `na()`**：夹具不够是测试自己的问题，不是被测对象的状态。其余一字未动。

> **v1.3 = v1.2（已提交 `1d2d609`）+ r3 的 5 条。改这 5 处，其余一字未动：**
> 1. **§8 A1 锚点改成 ① 卡片**（r3 的 P0）：不能用 `documentElement.scrollHeight` —— 它把 ② 校对区也算进去，`0.5×全文档maxScroll` 早已滚过 ① 卡片，**正确实现会被判红**。改用 `.ant-card-body` 的 `bottom + scrollTop` 算 span，`span≤100` 直接 `fail('夹具不合格')`（**不是 N/A**），并 `await requestAnimationFrame` 等一帧再量。
> 2. **§8 A3 改几何判据**：条件渲染删掉后栏**仍在 DOM 里**，不能再断言 `=== null` ⇒ 改判 `bar.getBoundingClientRect().bottom <= 0`（或与视口不相交）。
> 3. **§3.1/§3.3 删掉按 `sec` 的条件渲染**：渲染条件**只有 `items.length > 0`**（sticky 已让栏随卡片滚出视口；在 scroll 回调里 `setState` 会抖）。
> 4. **§4.5（= r3 的 3.3b）新增**：`2 < N ≤ 4` 且拼接未放行时，栏内**上方**出一行 12px 灰字「先拼前两张，再继续加」，**仅该区间出现**；连带 **A2 改成三态高度**（见 §8）。
> 5. **§7.4 Tag 粒度**：橙 Tag 留卡片（"这一张"）；灰 Tag「本次未做文件查重」属"这一批的能力状态" ⇒ **并进顶部汇总一行**，不逐卡刷 N 遍。
>
> **v1.2 改动（相对 v1.1，只改这 3 处 + 2 行补充，其余一字未动）**
> 1. **§7.2 降级分支改为"只打标不丢卡"**（r2：手机端降级态下两张同名同大小的不同截图会让第二张被静默丢弃，撞「不静默丢数据」红线）。**"不建卡"的前置条件收紧为：只有 `crypto` 可用、且 exact sha256 命中时才不建卡。**
> 2. **§8 A1 改成可分辨 sticky/static 的量测点**（滚到**中途 50%** 而不是到底 —— 到底时 sticky 与 static 位置重合，原断言无分辨力，证伪做不出来）；A1 → 两条：**A1 中途贴底（证伪挂这条）** + **A1b 到底不遮内容**。
> 3. **§3.2 定掉栏与卡片圆角的关系**，并把"将来有人给卡片加 `overflow:hidden` 会静默破坏 sticky"变成**断言**（A1 内附父链 `overflow` 检查），不再只靠文档警告。
>
> **2 行补充（r2 P1-1/A-4）**：§7.3 加「纯 JS 分支必须测试可达（`?hash=js` 或 `localStorage.mb_force_js_hash`）+ 两条腿各跑同一组 3 条向量 + 分块让出主线程 + >8MB 标『文件过大，未预检』」；§8 A7 的「更多」防漏**不动**。
>
> **v1.1 改动（相对 v1.0）**：
> 1. **§7 补「批内」去重一路**（r1 P0-1）：批内用 `Map<sha256, itemId>` 增量比对，**命中不建第二张卡**；对库命中仍建卡打 Tag；两者可区分。
> 2. **§7 末段降级口径改判 (d)**（r1 P0-2，`server.mjs:1808` 绑 `0.0.0.0` ⇒ 手机必是非安全上下文 ⇒ `crypto.subtle` 必然 undefined）：以**自写纯 JS SHA-256 为主**，灰 Tag「本次未做文件查重」只保留给**哈希抛异常**。
> 3. **§8 A1 拆成 A1 + A1b**（不遮内容 / 位置只取决于内容是否超一屏），两分支都**恒可判**（不留 N/A，符合 R3）。
> 4. **§8 A7 补「更多」防漏**（0 选不渲染 ⇒ 选 1 / ≥2 时必须存在）。
>
> 输入：`.agents/batch-import-1116-plan.md` v0.1 的 **D-1 七条（MVP）** + D-3 的 4 个前提问题（计划侧已升 v0.3 采纳本规格）。
> 本文件只给**数值与实现写法**，不改计划文件、不写业务代码。
> 所有 px 都是**可直接写进 CSS 的值**；所有判据都附**可复跑量测式**（§8）。
> 既有契约（**本批一个都不动**）：`.card`、`rb-edit-grid-wrap`、DataGrid 的 `.g-ctl` 全套、`g-main`、`.mb-review-grid`。

---

## 0. 现状基线（实测，2026-11-16 23:1x，`5174/?tab=intake`，非推测）

| 项 | 1440 | 992 | 768 | 414 | 375 |
|---|---|---|---|---|---|
| `.ant-layout-content` 宽 | 1272 | 824 | 712 | 414 | 375 |
| ① 卡片（`UploadPanel` 外层 Card）宽 | **1232** | 784 | 672 | 390 | **351** |
| `.ant-card-body` padding | 12px | 12 | 12 | 12 | 12 |
| 顶栏高 | 64 | 64 | 64 | 77 | **77** |
| 分段条（已有 `position:sticky; top:0; z-index:5`）高 | 36 | 36 | 36 | 36 | 36 |
| 内容区 padding | `16px 20px 32px` | 同 | 同 | `12px`（≤575） | `12px` |
| 卡片栅格 | `md={8}` 3/行 | 2/行 | `sm={12}` 2/行 | `xs={24}` 1/行 | 1/行 |
| 页内 `overflow` 链 | **全 visible**（`ant-card / DIV / ant-space-item / ant-space / content / layout`）⇒ **sticky 可用，无 `overflow:hidden` 阻断** | | | | |

**结论**：固定栏用 `position: sticky; bottom: 0` 可行（不需要 `fixed` + JS 定位），见 §3。

---

## 1. token 取值（**本批全部用下列既有值，不新造**）

| 类别 | 允许值 | 来源 |
|---|---|---|
| 字号 | **11**（徽标）/ **12**（辅助：元信息、计数）/ **13**（正文、按钮文字）/ **15**（区块标题） | 页面既有（`UploadPanel.jsx:48/49/78/112`、`IntakePage.jsx:846`）；antd `fontSize:14` 不用于本批新增文本 |
| 圆角 | **8**（卡片、按钮、提示条）/ **50%（圆形）**（序号徽标） | `main.jsx:18 borderRadius:8` |
| 间距 | **4 / 8 / 12 / 16**（新增只用这四档）；既有 `10`（`Row gutter`、`Space size={10}`）**不改** | 4px 半格 |
| 控件高 | 大屏按钮 **32**（antd default）/ 窄屏（≤575）按钮 **44** | 触摸区要求 ≥44 |
| 触摸热区 | **44 × 44**（用 `::before` 或负 margin 扩，**不撑高行**，见 §2.4） | 主理人硬要求 |
| 颜色 | 白 `#fff`；分隔线 `#f0f0f0`；阴影 `rgba(0,0,0,.06)`；次文字 `#8c8c8c`；危险 `#ff4d4f` / 危险底 `#fff1f0`；主色 `#c8102e`（`colorPrimary`）；选中描边 `#c8102e` | 项目既有 + antd 官方值 |
| 阴影 | 固定栏 `0 -2px 8px rgba(0,0,0,.06)` | 新增（唯一新增视觉元素） |
| z-index | 固定栏 **6**（高于分段条 5、低于 antd Modal/Drawer 1000） | 推导 |
| 依赖 | **新增第三方依赖 0 个**：SHA-256 用**自写纯 JS**（~40 行），`crypto.subtle` 可用时仍走原生加速 | 见 §7.3 |

> **一致性硬要求**：本批不出现 7/14/18px 这类散值；新增文本一律 11/12/13。

---

### 1.1 组件选型：**antd 优先**（本批逐件映射，别手搓）

| 界面件 | **用哪个 antd 组件** | 关键 props / 写法 | 为什么不用"看起来更对"的另一个 |
|---|---|---|---|
| 卡片选中 checkbox | `Checkbox` | 受控 `checked` + `onChange`；热区用外层 `span.mb-hit44`（antd 无 hit-area prop） | — |
| 拼接顺序徽标 `①②③④` | `Badge` | `count={<span className="mb-badge-txt">①</span>}`，`showZero={false}`，尺寸用 CSS 覆盖 `.ant-badge-count{width:16px;height:16px;min-width:16px;line-height:16px;padding:0;font-size:11px}` | 不用 `Avatar`（有背景圈过大）、不用 `Tag`（自带边框与内边距） |
| 删除（移除未入库条目） | `Button` | `type="text"` `shape="circle"` `icon={<DeleteOutlined />}` `danger` + `aria-label="移除此文件"` `title` 同文；热区靠 `.mb-icon-btn::before{inset:-10px}`（antd 无此 prop） | 不用裸 `<button>`（v1.4 的写法，违反"antd 优先"） |
| 状态 Tag / 重复 Tag | `Tag` | `color` 语义值（`default/green/red/orange`） | — |
| 重新识别 / 重试 | `Button` | `size="small"` `icon={<ReloadOutlined />}`（失败态加 `danger`） | — |
| 「识别中…」文字 | `Typography.Text` | `type="secondary"` `style={{fontSize:12}}` + `Spin size="small"` | 不用裸 `<span>` |
| 栏按钮组 | `Flex` | `align="center"` `gap={8}` `wrap={false}`；每个按钮 `className="mb-bar-btn"` | 不用 `Space`（`Space` 会给每个孩子包一层 `.ant-space-item`，**栏内也用 Space 会把按钮宽度锁死、窄屏无法均分**） |
| 「更多」 | `Dropdown` | `menu={{ items: [{ key: 'clear', label: '清空勾选', disabled: !selected.length }] }}` `trigger={['click']}` + `Button type="text" icon={<EllipsisOutlined />}` | 不用 `Popover` 自绘列表、不用 `Menu` 平铺（占宽） |
| 顶部计数与 `+N` 折叠 | `Tag` + `Popover` | `Popover content={<全量 Tag 列表>}` 包住 `+N` | — |
| 3.3b 灰字提示 | `Typography.Text` | `type="secondary"` + `.mb-bar-hint`（`fontSize:12; lineHeight:16px; whiteSpace:nowrap`） | — |
| 卡片 | `Card` | `size="small"`，`styles={{ body: … }}`（antd 6 用 `styles`，不用已废弃的 `bodyStyle`） | — |
| 批量进度/停止 | `Tag color="processing"` + `Button size="small" danger` | 沿用现状 `UploadPanel.jsx:22-26` | — |
| 页面级提示 | `App.useApp().message` | 既有用法，不引入 `notification` | — |
| **底部操作栏容器** | **CSS `position: sticky`（唯一例外，必须手写）** | 见 §3.1 | **antd `Affix` 看着最像，但它是 `position:fixed` + 占位元素 ⇒ 会遮内容、必须给内容补 `padding-bottom`**，正是本批花两轮论证要避开的；故容器走原生 CSS，**内部一律用 antd**（`Flex`/`Button`/`Dropdown`/`Typography`/`Tooltip`） |

**红线（写进实现要求）**：
1. **禁止用原生 `<button>` / `<input>` / `<select>` / `<span>` 重画 antd 已有的控件**；本批只允许两类 CSS 覆盖 —— ① **尺寸/热区**（44px 触摸区、16px 徽标、栏高）；② **布局作用域**（`.mb-*` 容器内的 flex/gap/padding）。**不许重画外观**（边框、背景、圆角、阴影一律用 antd 默认或 §1 token）。
2. 所有图标走 `@ant-design/icons`（本项目已装），**不引第三方图标**。
3. 若实现时发现某个 antd 组件表达不了，**回来找我改规格**，不要在页面里堆裸标签（否则下一个人不知道哪些是"故意的例外"）。

## 2. 卡片头部（D-1 第 1 条）

### 2.1 结构与顺序（左 → 右）

```
[ checkbox 16 ] 4px [ 序号徽标 16（仅选中时） ] 8px [ 状态 Tag ] 6px [ 文件名 flex:1 min-width:96 ] 8px [ 删除 24(热区44) ]
```

- **checkbox 放左上（不放右上）**。理由两条，都可验：① 右上已被删除按钮占用，两者都放右上会并排两个 24px 图标，热区 44 会**互相重叠 20px**（44+44 > 可用 56）；② 列表多选的最左位是系统惯例（iOS/Android/antd Table `rowSelection` 均在最左），右上是"单条操作"位，语义不冲突。
- **行高 32px**（大屏）/ **32px**（窄屏同值，热区用负 margin 外扩，不撑高）。

### 2.2 checkbox

- 组件：antd `Checkbox`（视觉 16×16，由 antd 控制，不写死）。
- 热区：外层 `<span className="mb-hit44">` ⇒ `width:44px; height:44px; margin:-14px -14px -14px -14px; display:inline-flex; align-items:center; justify-content:center;`（44 − 16 = 28 ⇒ 上下各 14 负 margin ⇒ **布局仍按 16 占位，行高不变**）。
- `aria-label="选择此文件（用于拼接/批量操作）"`。

### 2.3 文件名截断

```css
.mb-file-name { flex: 1 1 auto; min-width: 96px; font-size: 13px; line-height: 20px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```
- **先截断文件名，永不换行**；`title` 与 antd `Tooltip` 双保险（`ellipsis={{ tooltip: item.name }}` 保留）。
- 375 预算实测：卡内宽 `351−24=327`；固定占用 `16+4+16+8+Tag(≈52)+6+8+24 = 134`（未选中时 `−16`=118）⇒ 文件名 **193px**（选中时 177px），远高于 `min-width:96`，**375 下不会把 Tag 挤掉**（§8 A5 断言守）。

### 2.4 删除图标按钮（D-1 第 1 条）—— **用 antd `Button`，只覆盖尺寸与热区**

```jsx
<Button
  type="text" shape="circle" danger size="small"
  icon={<DeleteOutlined />}                 // 图标 font-size 14（antd 默认）
  className="mb-icon-btn"
  aria-label="移除此文件" title="移除此文件"
/>
```

```css
/* 只允许这两件事：① 视觉盒收到 24；② 热区扩到 44（antd 无 hit-area prop）。
   边框/背景/圆角/危险色一律走 antd（type="text" + danger），这里不重画外观。 */
.mb-icon-btn.ant-btn { width: 24px; min-width: 24px; height: 24px; padding: 0; position: relative; }
.mb-icon-btn.ant-btn::before { content: ''; position: absolute; inset: -10px; }  /* 24 + 20 = 44 热区，命中归宿主 */
```

- **常态灰、hover 变红**：`type="text"` 已保证常态无底色；`danger` 让 hover/active 走 antd 危险色（`#ff4d4f` / `#fff1f0`），**不写自定义 hover 色值**。
- `aria-label="移除此文件"`、`title="移除此文件"`（**文案不写"删除"**：只移除本次未入库条目，见计划 F2）。
- 危险色**只在 hover/active 出现**：移除未入库条目可反悔（重新拖进来即可），不必常态红脸。

### 2.5 卡片选中态

- 选中：`border-color: #c8102e`（**1px，不加粗**）、`box-shadow: 0 0 0 1px #c8102e inset`（保证 1px 边框在浅底上可见）；未选中：不写（沿用 antd 默认）。
- **不动** `.card` 类本身（既有契约），只给这张卡片加 `className="mb-item-card"` + 内联 `style.borderColor`。

---

## 3. 下方操作栏（D-1 第 3 条 / 用户 N4）

### 3.1 机制：**`position: sticky; bottom: 0`**，不用 `fixed` + observer

| 方案 | 遮挡内容 | ② 段落自动隐藏 | JS 依赖 |
|---|---|---|---|
| **sticky（选它）** | **不遮挡**：sticky 元素**在文档流里占位**，列表滚到底时它就在最后一张卡下方 | **自动**：它的容器是 ① 卡片，卡片滚出视口栏随之离开 | 0 行 |
| `fixed` + `bottom:0` | 会盖住最后一张卡 ⇒ 必须给内容补 `padding-bottom: 栏高+safe-area` | 需要 IntersectionObserver | ≥20 行 |

> **回答计划 D-3 问题 1**：不需要复用 `IntakePage.jsx:104-140` 的 observer —— sticky 让"只在 ① 段落可见"成为布局的自然结果。
> **v1.3 更正（r3）**：**不要**再加「`sec !== 'upload'` 时不渲染」这道保险 —— ① sticky 已让栏随卡片滚出视口，条件渲染多余；② 若真要按 `sec` 隐藏，就必须在 scroll 回调里 `setState`，那会引入**滚动抖动**（要留也只能用 `IntersectionObserver`）。
> ⇒ **渲染条件只有 `items.length > 0` 一条**；隐藏由几何自然完成，**判据用几何**（A3：`bar.bottom <= 0`），不用 DOM 存在性。

### 3.2 尺寸与外观

```css
.mb-batchbar {
  position: sticky; bottom: 0; z-index: 6;
  margin: 0 -12px -12px;            /* 抵消 .ant-card-body 的 12px padding，左右贴到卡片内缘 */
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
  background: #fff; border-top: 1px solid #f0f0f0;
  box-shadow: 0 -2px 8px rgba(0,0,0,.06);
  border-radius: 0 0 8px 8px;       /* 只圆下面两角，与卡片同形 */
  display: flex; align-items: center; gap: 8px;
}
@media (max-width: 575px) { .mb-batchbar { padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px)); } }
```

| 量 | 大屏（≥576） | 窄屏（≤575） |
|---|---|---|
| 按钮高 | 32 | **44** |
| 栏内上下 padding | 8 / 8 | 8 / 8 |
| **栏总高（含 1px 上边框，常态）** | **49** | **61 + `safe-area-inset-bottom`** |
| **栏总高（`2 < N ≤ 4` 灰字态，见 §4.5）** | **65** | **77 + `safe-area-inset-bottom`** |
| 栏右缘到卡片右缘 | 0（贴内缘） | 0 |
| 内容区补 padding-bottom | **0（sticky 占位，不需要）** | **0** |

**圆角与 `overflow` 定稿（v1.2 新增，回答 r2 的"会不会出角 + 将来加 `overflow:hidden` 怎么办"）**：

1. **不出角**：栏宽 = 卡片宽 − 2（两侧各 1px 边框）、底边与卡片底边重合、`border-radius` 同为 **8px** ⇒ 栏的圆角曲线落在卡片圆角**内侧**（严格同心应是 7px，差 1px；白栏压白底 ⇒ 肉眼不可见）。
2. **不给栏加 `overflow:hidden`**：栏是实色块、没有溢出内容，加了不解决问题，反而会**裁掉按钮的 `focus-visible` 外环**（`outline 2px + offset 2px` = 4px，超出栏内边）。
3. **`.ant-card` / `.mb-upload-body` 一律不许加 `overflow:hidden`**（会让 sticky 静默失效）。这条**不靠文档提醒，靠断言**：A1 内附父链检查 —— `let n=bar.parentElement; while(n && n!==document.body){ if(getComputedStyle(n).overflow !== 'visible') fail(...); n=n.parentElement }`。
4. 兜底方案（仅当将来卡片底色**不是**白色时才需要）：把栏移出 `.ant-card-body`、成为卡片的**兄弟元素**并去掉圆角，而不是给卡片加 `overflow:hidden`。

### 3.3 结构要求（**这点不做会整块失效**）

栏**必须是 `.ant-card-body` 的直接子元素**，且**不许**放进 antd `<Space>`（`Space` 会给每个孩子套 `.ant-space-item`，item 高度 = 栏高 ⇒ sticky **没有可移动空间**，表现为"栏跟着内容走"）。

```jsx
<Card size="small" title="① 批量导入" extra={…}>
  <div className="mb-upload-body">        {/* display:flex; flex-direction:column */}
    <Space direction="vertical" size={10} style={{ width: '100%' }}> …既有内容… </Space>
    {items.length > 0 && (
      <Flex className="mb-batchbar" align="center" gap={8} wrap={false}>
        {/* 内部一律 antd：Typography.Text(灰字) / Button / Dropdown，见 §1.1 */}
      </Flex>
    )}
    {/* 渲染条件只有 items.length > 0，不要加 sec（v1.3/r3）；容器必须 sticky（antd Affix 会遮内容，见 §1.1 末行） */}
  </div>
</Card>
```

### 3.4 四档排布（实测卡宽见 §0）

| 视口 | 卡片内可用宽（= 卡宽 − 24） | 栏按钮区宽（− 24 padding） | 未选中：按钮数 | 布局规则 |
|---|---|---|---|---|
| 1440 | 1208 | 1184 | 2 | 左对齐 `flex: 0 0 auto`；右侧 `已选 N` 用 `margin-left:auto`（12px `#8c8c8c`） |
| 992 | 760 | 736 | 2 | 同上 |
| 768 | 648 | 624 | 2 | 同上 |
| 414 | 366 | 342 | 2 | **`flex: 1 1 0; min-width: 0`** 均分（各 163px） |
| 375 | 327 | 303 | 2 | 均分（各 143px）；选中 ≥2 时 3 个按钮各 ≈ 95.7px |

- **窄屏均分、大屏自适应**：`@media (max-width: 767px) { .mb-batchbar > .mb-bar-btn { flex: 1 1 0; min-width: 0; } }`
- 按钮 `white-space: nowrap`；文字超宽时**缩文案不换行**（见 §4 文案）。

---

## 4. 三态按钮集合（D-1 第 3 条 / 用户 N5+N6）

| 状态 | 按钮（左→右） | 主次 | 375 单按钮宽（≈） | 说明 |
|---|---|---|---|---|
| **0 选** | `识别（N）` + `导入（M）` | 前者 `type="primary"`，后者 `default`；**「更多」不出现** | 143 / 143 | 「更多」里唯一项是「清空勾选」，0 选时无意义 ⇒ 按用户 N7「隐藏无关按钮」直接不渲染（**与计划 D-1 第 3 条文字略有出入，理由写在此，请 r2 裁**） |
| **选 1** | `移除选中` + `更多` | `移除选中`：`default` + `danger` 文字色；`更多`：`text` + `EllipsisOutlined`（**icon-only，44×44 热区**） | 143 / 44（图标） | 主操作（识别/导入）此时**降级为不渲染**（用户已进入"挑东西"状态，避免误触批量识别） |
| **选 ≥2** | `拼接（N）` + `移除选中` + `更多` | `拼接`：`primary`；`移除选中`：`default`；`更多`：icon-only | 95.7 / 95.7 / 44 | `N` = 选中数，上限 **4**；`拼接` 顺序 = 勾选顺序（§5） |
| **批量进行中** | `识别中 3/7`（12px 文本）+ `停止`（`danger`） | 替换整组 | 文本 flex:1 + 按钮 88 | 沿用既有 `batch` 状态（`UploadPanel.jsx:22-26`） |
| **items.length === 0** | **整栏不渲染** | — | — | 无动作可做 |

**文案定稿（短文案，非「一键识别（N）」）**：`识别（N）` / `导入（M）` / `拼接（N）` / `移除选中` / `更多`。
算术依据：`一键识别（3）` 13px ≈ 104px > 375 下单按钮可用 95.7px ⇒ 会换行或溢出；`识别（3）` ≈ 78px < 95.7 ✓。
长语义靠 `title` 补齐：`识别（N）` → `title="一键识别全部 N 张（串行，可停止）"`、`导入（M）` → `title="只入库已识别且未入库的 M 张；疑似重复会自动跳过"`。

**「更多」= antd `Dropdown`**（`trigger={['click']}` + `Button type="text" icon={<EllipsisOutlined />}`）：
```jsx
<Dropdown trigger={['click']} menu={{ items: [{ key: 'clear', label: '清空勾选', disabled: !selected.length }] }}>
  <Button type="text" className="mb-icon-btn" icon={<EllipsisOutlined />} aria-label="更多操作" />
</Dropdown>
```
仅 1 项「清空勾选」（`selected` 非空时可点）。后续若要加低频项，**只往这个 `menu.items` 里加**，不许再加到栏面。

### 4.5（= r3 的 3.3b）`2 < N ≤ 4` 的死角提示 —— 仅该区间出现

C-9（>2 张拼接）**本批未放行** ⇒ `拼接` 按钮只在 **N === 2** 时可用。于是 `N = 3 / 4` 会出现「选了 3 张、拼接灰着」的死角，而**手机没有 hover，`title` 等于不存在** ⇒ 必须给一行看得见的说明：

| 条件 | 呈现 |
|---|---|
| `2 < N ≤ 4` | 栏内**上方**多一行：**12px `#8c8c8c`**、单行不换行、文案 **`先拼前两张，再继续加`**；`拼接（N）` 按钮 `disabled` |
| 其它任何 N（0 / 1 / 2） | **该行不渲染**（不是 `visibility:hidden`，是不进 DOM —— 否则栏高会跳动） |

- 行高 **16px**（`font-size:12px; line-height:16px`），与按钮组间距 **6px**，左右与按钮组同缩进（0）。
- 栏高因此变 **49 → 65**（≥576）/ **61 → 77**（≤575），见 §3.2 表第二行；**A2 按三态判**（§8）。
- 徽标上限仍是 4（§5）：第 5 次勾选给 `message.info('一次最多拼接 4 张；再拼请分批')` ⇒ `N` 不可能 >4，所以没有 `>4` 分支。

---

## 5. 多选序号徽标（C-9 / 拼接顺序）—— **用 antd `Badge` 的 `count` 渲染 ①②③④**

```jsx
<Badge count={<span className="mb-badge-txt">{'①②③④'[selected.indexOf(item.id)]}</span>} />
```

- 位置：**checkbox 右侧、与 checkbox 不重叠**，`gap: 4px`；顺序 = 勾选顺序（`selected` 数组下标）。
- 尺寸 **16 × 16** 圆形，底色 **`#c8102e`**（`colorPrimary`），字色 `#fff`，字号 **11px**：
```css
.mb-pick-badge .ant-badge-count { width: 16px; min-width: 16px; height: 16px; line-height: 16px;
  padding: 0; border-radius: 50%; background: #c8102e; font-size: 11px; box-shadow: none; }
```
- 字符：`① ② ③ ④`（U+2460..U+2463）；**未选中时不渲染 `Badge`**（不是 `count={0}` —— `showZero` 会画个 0）。
- 不重叠的理由：16px 圆压在 16px 方框上（`left:-4;top:-4`）会让勾标与序号互相遮挡，两处都吃点击热区 ⇒ 误触；并排多占 20px（16+4），375 下预算仍够（§2.3 已算）。
- 上限 **4**：第 5 次勾选 `message.info('一次最多拼接 4 张；再拼请分批')`，且**不加入** `selected`。

---

## 6. 「重新识别 / 重试」（D-1 第 2 条）

| status | 呈现 | 位置 |
|---|---|---|
| `pending` | **无按钮**（用户 N2：只留一键识别） | — |
| `ocr` | `Spin size="small"` + `Typography.Text type="secondary"` 文案`识别中…`（12px） | 卡底元信息行 |
| `done` | 按钮 `重新识别`（`size="small"`，`ReloadOutlined` 前置图标，`font-size:13`） | **卡底整行、右对齐** |
| `failed` | 按钮 `重试`（同上；`danger` 文字色） | 同上 |

**选"卡底整行右对齐"而不是"角落图标"，三条理由**：
1. **误触**：角落（右上）已有删除 24px + 44 热区，再塞一个 icon 按钮 ⇒ 两个 44 热区在 56px 宽内**必重叠**；
2. **条件呈现不占位**：只在 `done`/`failed` 出现，且与元信息行（大小 / 行数 / 标签）同一行右缘，**不新增行高**；
3. **语义分组**：删除 = 单条管理（头部右）；重识别 = 单条修复（底部右）。上下分离 20px 以上，指错一次不会毁数据。

- 尺寸：`height 24px`、`padding 0 8px`、`font-size 13px`、`border-radius 8px`；375 下若与元信息挤：**元信息先换行**（`flex-wrap: wrap`），按钮 `flex: 0 0 auto` 永远不折。

---

## 7. 重复提示：**三路判定**（批内 / 对库 / 识别后），口径不许越界

### 7.1 四路分工（顺序固定：**先批内、后对库**）

| 路 | 时机 | 判据 | 命中后动作 | 呈现（定稿文案） |
|---|---|---|---|---|
| **P1 批内 · 强比对**（r1 P0-1） | `addFiles()` 内、**建卡之前** | `Map<sha256, itemId>` 增量比对，**且哈希来自 `crypto.subtle`（原生可用）** | **不建第二张卡**（`continue`）—— **全流程只有这一种情形允许"不建卡"** | `message.warning('这张图本次已选过，已跳过')` + `pushLog('批内重复：<name> 已选过，已跳过', 'warn')` |
| **P1′ 批内 · 粗判**（降级态，v1.2 新增） | 同上，但**哈希不可用**（`sha256FileSafe` 返回 `null`） | `Map<`${name}|${size}`, itemId>` 粗比对 | **仍建卡**，只打标 —— **绝不丢卡**（r2：同名同大小的不同截图在手机相册/聊天软件里很常见） | 卡底橙 `Tag` → **`可能重复（按文件名+大小粗判，请核对）`**（**卡上只此一个**）；顶部汇总 → **`疑似重复（粗判）N`** + **`本批未做文件查重`**（批级状态，不逐卡） |
| **P2 对库 · exact** | P1/P1′ 之后 | `sha256(文件字节) ∈ reports[].sha256`（`exact-file`） | **仍建卡**（真相仍由入库时后端裁） | 卡底 `Tag color="orange"` → **`同一文件已导入过`**（`title="本文件的 sha256 与库内已有文件完全相同；入库时仍会再判一次"`） |
| **P3 识别后**（既有） | 识别完成、入库前 | 后端 `findDuplicate` 单据级（条码+日期+类型） | `status='dup'`（既有） | 卡头状态 Tag → **`疑似同一份报告`**（`shared.js:10` 只改 label 字面，`color` 仍 `orange`） |

**为什么只有 P1 能"不建卡"，其余一律"建卡 + 打标"** —— 三条都可验，别混：
- 同一张图"拖一次 + 粘贴一次"时**库里还没有它** ⇒ 只对库比对必然判"不重复" ⇒ 两张一模一样的卡并排，用户到入库才被静默跳过。**这就是 r1 P0-1。** 这里"不建卡"是**确定事实**（字节完全相同），不会误杀。
- 对库命中时用户可能想**覆盖/更新原报告**；把卡吞掉等于断了他的路 ⇒ 建卡、只打提示。
- **降级粗判（P1′）只是猜测**（名字和大小都相同 ≠ 同一张图）⇒ 猜错就丢掉用户的图，撞「不静默丢数据」红线 ⇒ 只能打标、让用户自己核对。

### 7.2 实现契约（照抄级，别自己改形）

```js
// 两个 Map 挂在组件 ref 上：必须跨多次 addFiles 累计（"拖一次+粘贴一次"是两次调用）
const batchIdx      = useRef(new Map())   // sha256 -> itemId（强比对索引）
const batchIdxLoose = useRef(new Map())   // `${name}|${size}` -> itemId（只用于粗判提示，永不丢卡）

const addFiles = useCallback(async (fileList) => {
  // ① 先把哈希全部算完，再一次性建卡（避免"先建卡再补 Tag"的闪烁）；sha256FileSafe 不抛，失败给 null
  const hashed = await Promise.all(fileList.map(async (f) => ({ f, sha: await sha256FileSafe(f) })))
  const accepted = []
  for (const { f, sha } of hashed) {
    // 【硬前置，别改】"不建卡"只在 sha 是**可靠精确值**时允许（原生 crypto 或自写纯 JS 都算精确）。
    //    全流程只有这一处允许丢弃文件；sha === null（哈希抛异常）时**一律建卡**，绝不丢。
    if (sha && batchIdx.current.has(sha)) {
      message.warning('这张图本次已选过，已跳过'); pushLog(`批内重复：${f.name} 已选过，已跳过`, 'warn'); continue
    }
    const k = `${f.name}|${f.size}`
    const looseHit = !sha && batchIdxLoose.current.has(k)   // P1′：只在降级态判断，且**只打标不 continue**
    // P2 对库 exact 命中；P1′ 粗判命中（两种 tag 要能区分）
    const predup = sha && libSha.has(sha) ? { kind: 'exact-file', of: libSha.get(sha) }
                 : looseHit              ? { kind: 'name-size-suspect' }
                 : null
    const item = { /* …既有字段… */ sha256: sha || '', predup, hashSkipped: !sha }
    if (sha) batchIdx.current.set(sha, item.id)
    batchIdxLoose.current.set(k, item.id)   // 粗判索引始终维护（供后续 hit 打标用）
    accepted.push(item)
  }
  if (accepted.length) setItems((prev) => [...prev, ...accepted])
  // …后续 FileReader 转 dataUrl 逻辑不变（按 accepted 逐个走）
}, […])
```

- `libSha` = `new Map(reports.filter(r => r.sha256).map(r => [r.sha256, r.id]))`，由既有 `loadReports()` 的 state 派生（`GET /api/intake/reports` 已返回 `sha256`，计划 R5 ⇒ 零后端改动）。
- **`removeItem` 必须同键删除两个 Map 里的条目**，否则"移除了再拖回来"会被误判成批内重复。
- `item.sha256` 落进 item（入库可复用，省一次重算）；`item.hashSkipped` 驱动灰 Tag「本次未做文件查重」。
- 哈希在**建卡之前**算完；期间**不显示骨架/loading**（通常 <50 ms，加了反而闪）。
- **`predup.kind` 只允许两个值**（供 UI 与断言分流）：`exact-file`（→ 橙 Tag `同一文件已导入过`）、`name-size-suspect`（→ 橙 Tag `可能重复（按文件名+大小粗判，请核对）`）。**任何情况下都不新增第三个 kind。**

> **对 v1.2 指令的一处收紧说明（请 r2 注意）**：「不建卡」的前置我写成 **`sha` 非空**，而不是"仅 `crypto` 可用"。
> 理由：自写纯 JS 的 SHA-256 同样是**精确值**，手机端（非安全上下文）拿到的也是真值；若限定"只有原生才可不建卡"，则**同一张图在手机上拖两次会出两张卡**、在桌面上却不会 —— 那正是 P1 要消灭的现象在主场复发。
> r2 真正要防的是**降级（哈希抛异常）时不丢卡**，这条已由 `sha === null ⇒ 一律建卡` 兜住。

### 7.3 哈希实现：**自写纯 JS SHA-256 为主**（r1 P0-2 定案，取代 v1.0 的 (a)）

- **为什么不能用 `crypto.subtle` 当主路径**：`server.mjs:1808` 绑 `0.0.0.0` ⇒ 手机走局域网 `http://192.168.x.x:5174` ⇒ **非安全上下文** ⇒ `crypto.subtle === undefined`。以它为主等于"手机端这个主场不做查重"，不可接受。
- **口径**：`sha256FileSafe(file)` = ① `crypto.subtle` 存在（`https` / `localhost`）⇒ 走原生 `digest`（快路径）；② 否则 ⇒ **自写纯 JS SHA-256**（~40 行、**零第三方依赖**）；③ **只在抛异常时**返回 `null`。
- **降级（`null`）时的行为**：批内用 `name+size` 粗筛兜一层（**只对批内**）；**对库不做任何判断**（库内不存文件名、`sourceName` 不存在 ⇒ 用它判必误报），卡片打灰 `Tag`「**本次未做文件查重**」，且顶部**不出**「已导入过」计数 —— 不假装查过。
- **不许**因为哈希失败丢文件：照常建卡、照常可识别（`predup.kind = 'name-size-suspect'` + 灰 Tag）。
- **纯 JS 分支必须"测试可达"**（r2 P1-1/A-4：否则正常路径只跑原生，纯 JS 写了永不执行 = 永远绿）：
  - 强制入口：URL 加 `?hash=js`，或 `localStorage.mb_force_js_hash = '1'` ⇒ `sha256FileSafe` 走纯 JS 分支；
  - **两条腿各跑同一组 3 条向量**，结果必须与 Node `crypto.createHash('sha256')` 逐字节相等：
    `'abc'`（宽 3 字节）、`'a'.repeat(1000)`（跨块边界）、含非 ASCII 文本（`'血常规检验报告'` 的 UTF-8 字节）。
  - 分块：**每 1 MB `await` 让出主线程**（`await new Promise(r => setTimeout(r, 0))`），保证 8 MB 文件不冻结输入。
  - **单文件 > 8 MB** 时跳过预检，卡片标 **`文件过大，未预检`** —— 文案**必须与降级态的** `本次未做文件查重` **区分**（一个是"文件太大"，一个是"本端算不了"）。

### 7.4 呈现与计数

- **Tag 粒度（v1.3 按 r3 改）**：**卡片上只放"这一张的判定"**——橙 `Tag`「同一文件已导入过」/「可能重复（按文件名+大小粗判，请核对）」；**「这一批的能力状态」并进顶部汇总**——灰 `Tag`「本批未做文件查重」，**不逐卡刷 N 遍**。
- **顶部汇总一行（三计数 + 一状态）**：`已导入过 {M}`（exact 对库）／`疑似重复（粗判）{N}`（降级态命中）／`疑似重复 {dupCount}`（识别后，既有）／`本批未做文件查重`（仅当有卡 `hashSkipped` 时出现）。四者不合并（计划 F3）；**只有 P1 强比对跳过不进任何 Tag**（它连卡都没有），只走 message + 日志。
- **不落 `status`**：`predup` 是独立字段，`status` 仍是 `pending`；识别/入库不受影响。
- **375 下 extra 不许挤爆（v1.3a 追加，防四个 Tag 换行把标题栏顶高）**：`≤575px` 时 extra 区**最多显示 2 个 Tag**，其余折叠成 `+N`（点击展开 `Popover` 列出全名）；显示优先级固定为
  `本批未做文件查重` > `疑似重复（粗判）` > `已导入过` > `疑似重复`（越靠左越"需要立刻知道"）。
  断言并入 **A12**（页面/`extra` 区 `scrollWidth <= clientWidth + 1`）与 B5 同批执行 —— **不新增判据编号**。

---

## 8. 验收判据（**四档可复跑断言**，`/tmp/verify-batch-1116.mjs`，Playwright）

> 统一前置：`MEDBRIEF_BASE=http://127.0.0.1:5174`、副本库、四个视口 `1440×900 / 768×1024 / 414×896 / 375×812`。
> 每条断言都必须**能红**：期望值写死在断言里，`fail()` 计数，退出码 `failed?1:(na>0?2:0)`（沿用 `tests/verify-grid-narrow-D1.mjs` 的三档口径）。

| # | 判据 | 量测式（直接粘贴可用） | 期望 |
|---|---|---|---|
| **A1** | **中途贴底（可分辨 sticky / static，证伪挂这条）** + 父链 `overflow` 守卫 —— **三分支，不许把短列表判红** | **锚点必须是 ① 卡片**（`documentElement.scrollHeight` 会把 ② 校对区算进去 ⇒ 正确实现被判红）：<br>`const cb = document.querySelector('.ant-card-body')`<br>`const span = cb.getBoundingClientRect().bottom + document.documentElement.scrollTop - innerHeight`<br>`if (span > 100) {`　// ① **主体：唯一承担 sticky/static 证伪**<br>`  document.documentElement.scrollTop = span * 0.5; await new Promise(r => requestAnimationFrame(r))`<br>`  assert(Math.abs(innerHeight - bar.getBoundingClientRect().bottom) <= 1)`<br>`} else if (span <= 0) {`　// ② **短列表（内容不足一屏）：本就该不吸底，属正确行为**<br>`  document.documentElement.scrollTop = document.documentElement.scrollHeight; await new Promise(r => requestAnimationFrame(r))`<br>`  assert(bar.getBoundingClientRect().bottom <= innerHeight + 1)`<br>`} else {`　// ③ **只有灰区 0 < span ≤ 100 才算夹具不合格**（允许以 viewport.height − 200 重跑一次）<br>`  fail('A1 夹具灰区：span=' + span + 'px ∈ (0,100]，改用 viewport.height−200 重跑')`<br>`}`<br>附：`let n = bar.parentElement; while (n && n !== document.body) { if (getComputedStyle(n).overflow !== 'visible') fail('父链 ' + n.className + ' overflow≠visible，sticky 会被静默破坏'); n = n.parentElement }`<br>**禁止用 `na()`**：夹具不够是测试自己的问题，不是被测对象的状态 | ①② 对应分支为真；③ 只有灰区 fail |
| **A1b** | **到底不遮内容**（长短列表都成立；与 A1-② 同判据、幂等，**保留不删**以免判据漂移） | 滚到 `scrollTop = scrollHeight` 后：`const last=[...document.querySelectorAll('.mb-item-card')].pop(); last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 0.5`<br>并且（短列表时）`bar.getBoundingClientRect().bottom <= innerHeight + 0.5`（不吸底、排在内容末尾） | 真 |
| **A2** | 栏高与安全区 —— **按三态判**（v1.3，与 §4.5 对齐，不许与灰字打架） | `const H = Math.round(bar.getBoundingClientRect().height)`<br>`const hint = document.querySelector('.mb-bar-hint')`<br>① 常态（`N≤2`）：断言 `hint === null` 且 `H` === **49**（≥576）/ **61 + safeArea**（≤575）<br>② 灰字态（`2<N≤4`）：断言 `hint` 存在、`Math.round(hint.getBoundingClientRect().height) <= 16`、`hint.scrollWidth <= hint.clientWidth + 1`（不换行）、且 `H` === **65**（≥576）/ **77 + safeArea**（≤575）<br>③ 把①的 `H` 与②的 `H` 相减，**必须恰好 = 16**（灰字行高；防止有人用 padding 凑 77） | 三态各自成立 |
| **A3** | ② 段落隐藏 —— **几何判据**（v1.3 按 r3 改：条件渲染删掉后栏仍在 DOM 里） | 滚到 `#sec-review` 顶部可见后：`const r = document.querySelector('.mb-batchbar').getBoundingClientRect()`，断言 `r.bottom <= 0`（整条在视口上方之外）或 `r.bottom <= 0.5 || r.top >= innerHeight`（与视口不相交） | 真（**不再断言 DOM 是 null**） |
| **A4** | 375 不换行 | `bar.scrollWidth <= bar.clientWidth + 1`，且每个按钮 `getComputedStyle(b).whiteSpace === 'nowrap'`、`Math.round(b.rect.height)` = **44**（≤575）/ **32**（≥576） | 全真 |
| **A5** | 头部不挤爆 | 文件名元素：`el.scrollWidth > el.clientWidth`（确认发生截断）时 `Math.round(el.rect.width) >= 96`；且状态 Tag 仍可见（`tag.rect.width > 0`） | 全真 |
| **A6** | 触摸热区 44 | 删除按钮：`el.getBoundingClientRect()` 视觉 **24×24**；热区用命中判：以按钮中心为原点，`document.elementFromPoint(cx+20, cy)`、`(cx-20, cy)`、`(cx, cy+20)`、`(cx, cy-20)` **都返回该按钮**（`::before` 扩展归宿主） | 4 点全命中 |
| **A7** | 三态按钮 DOM + **「更多」防漏**（v1.1 补） | **0 选**：`bar.querySelectorAll('[data-bar-btn]').length === 2`、无 `[data-act="stitch"]`、**无 `[data-act="more"]`**（不渲染是预期，不是漏）<br>**选 1**：有 `[data-act="remove"]`、**必有 `[data-act="more"]`**、无 `stitch`、`[data-bar-btn]` 计数 === **2**<br>**选 2**：有 `[data-act="stitch"]` 且文案 === `拼接（2）`、有 `remove`、**必有 `more`** | 全真 |
| **A8** | 序号徽标 | 选 2 张后：`[...document.querySelectorAll('.mb-pick-badge')].map(e=>e.textContent).join('')` === `'①②'`；每个徽标 rect = **16×16**；与 checkbox rect **不相交**（`a.right <= b.left + 0.5`） | 全真 |
| **A9** | 重复提示口径（对库） | 预置一份库内已有的同一文件后导入：卡片内 `.mb-predup` 存在、文案 === **`同一文件已导入过`**、且组件树文本**不含** `疑似重复报告` | 全真 |
| **A9b** | **批内强比对去重**（r1 P0-1 的落地判据） | 同一张图**连续导入两次**（第二次走粘贴路径，不刷新页面）：<br>`document.querySelectorAll('.mb-item-card').length` === **1**；<br>且出现 `message.warning` 文案 `这张图本次已选过，已跳过`（用 `page.on('console')` 或 antd message 的 DOM `.ant-message-notice` 取文判）；<br>且**第一张卡上不得**同时出现 `.mb-predup`（库里本来没有它，对库不该命中） | 三条全真 |
| **A9c** | **降级态绝不丢卡**（r2 的发现；v1.3 按 Tag 粒度改） | 强制 `?hash=js` **且**注入一个会抛异常的哈希桩（或直接把 `sha256FileSafe` 打成始终 `null`），连续导入**两张同名同大小但内容不同**的图：<br>`document.querySelectorAll('.mb-item-card').length` === **2**（**不许是 1**）；<br>第二张出现橙 Tag `可能重复（按文件名+大小粗判，请核对）`、**第一张不得有该橙 Tag**；顶部汇总出现 `疑似重复（粗判）1` **且** `本批未做文件查重`；并且**卡片上不得出现** `本次未做文件查重`（批级状态不逐卡，v1.3 粒度） | 四条全真 |
| **A10** | 栏内按钮不出卡 | 每个按钮 `rect.left >= bar.rect.left - 0.5 && rect.right <= bar.rect.right + 0.5` | 全真 |
| **A11** | 无回退：既有契约 | `document.querySelectorAll('.g-grid').length`、`.mb-review-grid` 高度、`.card` 上无新增 `mb-batchbar` 子孙（`document.querySelector('.card .mb-batchbar')` 只允许 1 个且父级是 `.mb-upload-body`） | 全真 |
| **A12** | 页面不横向滚 | 四档 `document.documentElement.scrollWidth <= clientWidth + 1` | 全真 |

**证伪要求（共 4 条，每条都要贴退出码 1）**：
1. `.mb-batchbar` 的 `position: sticky` → `static` ⇒ **A1 必红**（中途滚动时不再贴底。**注意：必须用 A1 的中途量测点**，滚到底时 sticky 与 static 位置重合，量不出来）；
2. 按钮去掉 `flex:1 1 0` ⇒ **A4 必红**（375 `scrollWidth > clientWidth`）；
3. **把 §7.2 的 `batchIdx` 批内比对注掉** ⇒ 同一张图导入两次出现 **2 张卡** ⇒ **A9b 必红**（r1 P0-1 的回归守门人）；
4. **把 P1′ 的粗判分支改回 v1.1 的 `continue`（跳过）** ⇒ 降级态第二张同名同大小图消失、只剩 1 张卡 ⇒ **A9c 必红**（r2 那条"静默丢卡"必须真红过一次）。

---

## 9. 与既有契约的边界（实现方不许越线）

1. **不碰**：`.card`、`rb-edit-grid-wrap`、DataGrid 的 `.g-ctl` / `g-main` / `.mb-edit-modal`、`.mb-review-grid` 及其 375 注入 CSS。
2. **只允许改 3 个文件**：`web/src/pages/intake/UploadPanel.jsx`、`web/src/pages/IntakePage.jsx`（传 `sec` 与多选语义）、`web/src/pages/intake/shared.js`（**只改 `ST.dup.label` 一个字面**）。
3. **新增 DOM/CSS 一律带 `mb-` 前缀**：`mb-upload-body` / `mb-batchbar` / `mb-item-card` / `mb-file-name` / `mb-icon-btn` / `mb-hit44` / `mb-pick-badge` / `mb-predup` / `mb-bar-btn`。
4. **不引入**新色值：只用 §1 的颜色表。
4bis. **控件一律用 antd**（见 §1.1）：禁止原生标签重画已有控件；CSS 只许改尺寸/热区/布局作用域，**不许改外观**。
5. `selected` 语义从"拼接专用 2 张"扩成通用多选后，`doStitch` 必须改 `>=2 && <=4`，顺序取 `selected` 数组顺序；`toggleSelect` 不再挤掉最早（`IntakePage.jsx:214-221`）。

---

## 10. 需 r2 / 主理人确认的三处（我的建议已写在括号里）

1. **「更多」在 0 选时是否渲染** —— 我按"隐藏无关按钮"**不渲染**（与计划 D-1 第 3 条列举略有出入）。
2. **栏文案用短文案**「识别（N）/导入（M）/拼接（N）」而非「一键识别（N）/一键导入（M）」—— 375 宽度算术不支持长文案（§4）。
3. **短列表（内容 < 一屏）时栏是否仍吸底** —— 我按**不吸底、贴在内容末尾**（sticky 的自然行为）。若产品要求"永远吸底"，需给 `.mb-upload-body` 加 `min-height: calc(100dvh - var(--mb-sec-top))`，`--mb-sec-top` 由 `ResizeObserver` 写（实测 375 下 `#sec-upload` 的 top = 431px，但该值随上方块高度变化，不能写死）。

---

## 11. 条数统计（v1.1）

- 规格条目：**§1.1 组件选型 15（v1.5 新增：逐件 antd 映射 + 3 条红线）/ §2 卡片头部 5 / §3 操作栏 7 / §4 三态 8 / §5 徽标 4 / §6 重识别 4 / §7 重复提示 17 = 60 条**
- 可复跑判据：**A1 / A1b / A2 / A3 / A4 / A5 / A6 / A7 / A8 / A9 / A9b / A9c / A10 / A11 / A12 = 15 条**（A1 锚点已改 ① 卡片、A2 改三态、A3 改几何判据、A9c 改 Tag 粒度 —— v1.3），其中 **A1 / A4 / A9b / A9c 各带一条证伪要求**（4 次改坏必须真红并贴退出码 1）
- 需确认项：**3 条**（§10，计划 v0.3 已按我的建议全采纳，其中第 3 条标"待用户点头"）
- **无 N/A 出口**：A1b 用"两分支恒可判"消灭了 v1.0 里唯一的条件判据；其余判据全部有确定期望值（符合 R3：若某条不该计入就得改判据，不是改计数口径）
