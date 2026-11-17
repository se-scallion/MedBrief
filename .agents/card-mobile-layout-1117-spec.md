# 动态趋势看板 + 原件溯源弹窗 —— **移动端版面规格 v0.2**（UI 设计师，2026-11-17）

> **本版依据**：`.agents/ui-audit-1117-review-r1.md`（AI 审核 r1 带图审，总判`不能直接进下一轮`，5 条 P0）+ `.agents/ui-audit-1117-r1-ruling.md`（主理人裁定，`148d820`）。
> **实测快照**：实现提交 **`09e16c9`**（+ 门禁 `760783c`），文件 md5 `SourceModal=907a0bc3` / `TrendsTab=d255f33c` / `CardPage=653b9050` / `AccountAdminPage=f165b037`（2026-11-17 20:19–20:21，独立实例 `PORT=5194/5195`、`MEDBRIEF_AUTH=on`+自建 admin、`MEDBRIEF_REPORTS_FILE` 指向**复制到 tmp 的 reports.json**、真库零写入）。
> ⚠️ 本文所有"现测"绑定这组 md5 与 `09e16c9`；再有人改这几个文件，md5 变即须重测，不许沿用。
> 落地：**代诊-账号 单写者**。文件：`web/src/pages/CardPage.jsx`、`web/src/pages/card/TrendsTab.jsx`、`web/src/pages/card/SourceModal.jsx`。

---

## 0. v1.2 → v0.2 改了哪 6 处（对应裁定 R1–R7）

| # | 裁定 | v0.2 的写法 |
|---|---|---|
| 1 | **L7 改「累计内距」** | 判据从"某层 padding=12"改成"`[role=dialog]` 可视左缘 → 内容左缘 = 12±1"；并点名把 `.ant-modal-container` / `styles.content` 的默认 padding 显式归零（§2.1） |
| 2 | `100vh` → `100dvh` | §2.2 全部表达式换 `100dvh`，补 `env(safe-area-inset-bottom)`；**v1.2 里 `calc(100vh - 96px/220px)` 的写法作废** |
| 3 | 工具栏不得裁切 + 无原件隐藏缩放/旋转 + 占位 ≤120 | §2.3 / §2.4（新增，v1.2 只写"单行"，没写"不得裁"与"隐藏"）；另补 §2.5 旋转 90° 不裁（r1 未提、本轮实测新发现） |
| 4 | `Card.extra` 与标题零遮挡 + 「生成中」不裁 | §1.2 / §1.3（新增，v1.2 漏报 Card.extra） |
| 5 | A5 七项进清单 | 规格侧给判据（§4），清单侧落 U16–U22（计划 v0.2） |
| 6 | **断点口径** | §1.1 按裁定：**维持 `minmax(min(380px,100%),1fr)`，删「320 最小宽 / 768 两列」** |

**作废留痕（D10）**：v1.1 的「EDGE 8/12 两档」、v1.2 §2.1b 的「`calc(100vh - 96px)`」、v1.2 §1.3 的「卡最小宽 320 / 容器 <652 单列 / ≥652 双列」**全部作废**；作废原因见各自条目，原文不删。

---

## 0.1 根因更正（保留，别照主理人第一封信的定位改）

375 下 `CardPage.jsx` 的 `@media (max-width:575px)` 里曾写
`.mb-trends-grid { grid-template-columns: repeat(auto-fit, minmax(0,1fr)) !important }` —— `auto-fit + minmax(0,1fr)` 在 351px 容器里**按卡片数量均分**（9 张 ⇒ 每张 28.33px），把卡压成竖条，`TrendsTab.jsx` 的内联 `minmax(380px,1fr)` 被 `!important` 完全盖掉。
**改前基线**：轨道 **9 条 × 28.33px**、卡 **28×1255**、`svg` **2px**、点列表 **2px×869**，而 `scrollWidth = 375 = innerWidth`（**页面并不横向溢出**）⇒ 拿 `scrollWidth` 当主判据抓不到它。**现测（v0.2 快照）**：轨道 **1**、卡 **351×272**、`svg` **325×158**。

---

## 1. 趋势看板

### 1.1 断点与列数（按裁定 R3 重写）

**唯一口径**：`minmax(min(380px,100%),1fr)`。**「卡最小宽 320」与「768 切两列」两套写法删除**（按 380 算 768 切不出两列；1440 自然是 3 列 403px，已由 `05-card-trends-1440-cards` 类图核实）。

| 项 | 落点 | 值 |
|---|---|---|
| 1.1a 窄屏单列真源 | `CardPage.jsx:54`（`@media (max-width:575px)` 内，注释在 `:50-53`） | `.mb-trends-grid { grid-template-columns: minmax(min(380px, 100%), 1fr) !important; }` —— **把现测的 `min(320px,100%)` 改成 `min(380px,100%)`**：两处口径必须同一个数，否则 576–767 会与桌面档打架 |
| 1.1b 桌面/平板 | `TrendsTab.jsx:205` | `repeat(auto-fit, minmax(min(380px,100%),1fr))`；`cols===1` 的 560 分支保留只给显式单列模式 |
| 1.1c 列数结论（实测支撑） | — | 容器 **351**（375 视口）⇒ 1 列；容器 **1232**（1440 视口）⇒ **3 列 × 403**；两列最低需 `2×380+12 = 772`，故 576–767 一律单列 |
| 1.1d 防过高 | `TrendsTab.jsx` SVG 容器 | 576–767 单列时 SVG `max-height: 180px`（单列卡宽≥380、高 158 已被实测够读，这条只防外层拉伸） |

### 1.2 `Card.extra` 与标题零遮挡（r1 P0-1）

现状（现测 375）：`.ant-card-head` 高 **51px**，标题独行、`参考 3.5-9.5` 换到第二行，`title × extra` 交集面积 **0**；「可选指标」卡头高 **53px**、标题 `x=25 w=325` 与工具组 `x=25 y=+28` **不重叠**，`head.scrollWidth = clientWidth = 349`。

| 项 | 落点 | 值 |
|---|---|---|
| 1.2a 卡头换行 | `CardPage.jsx:30/34-37`（现有 P0-1 段） | `.ant-card-head { flex-wrap: wrap; height:auto }`、`.ant-card-head-wrapper { flex-wrap: wrap; row-gap:6px }`、`.ant-card-head-title { flex:1 1 100%; white-space: normal; overflow: visible }`、`.ant-card-head .ant-card-extra { flex:1 1 100%; max-width:100%; margin-inline-start:0 }` |
| 1.2b 工具组不得溢出 | `TrendsTab.jsx:172-186`（可选指标 Card `extra`） | 工具组外层 `Space` 加 `wrap`；**禁用**把 5 个按钮强排一行后靠 `overflow:hidden` 遮住（r1 图上「可选指标」只剩一个「可」字就是这么来的） |
| 判据 | L15a | 同卡头内 `title.rect ∩ extra.rect` 面积 = **0**，且 `head.scrollWidth ≤ head.clientWidth + 1` |

### 1.3 「生成中」标签不得被垂直裁切（r1 P0-5）

成因：卡头/`extra` 上的 `overflow:hidden` 把偏高的状态行（`Spin tip="生成中…"`，见 `CardPage.jsx:298`）裁掉下半截；04/05 两页同源。

| 项 | 落点 | 值 |
|---|---|---|
| 1.3a | `CardPage.jsx:31-33/38`（现有 P0-5 段） | `.ant-card-head .ant-card-extra { overflow: visible }`；`.ant-spin .ant-spin-text { line-height:1.5; padding-top:6px; white-space:nowrap }`；父链不得再写 `overflow:hidden` |
| 判据 | L15b | 找 `生成中` 文本节点，其 `rect` 必须完整落在最近 `overflowY∈{hidden,auto,scroll}` 祖先内：`lost = max(0,pTop−tTop) + max(0,tBottom−pBottom) = 0` |

> **实测诚实标注**：该状态只在资料卡加载瞬间出现，v0.2 采集中**未复现**（`gen: []`）。本判据为**代码级兜底 + 下一次真机复核**，不声称"已实测通过"。

### 1.4 刻度字号（渲染实测口径）

`TrendsTab.jsx:129/143/148` 已改 `fontSize="13"`（viewBox 单位）。实测缩放 **0.707**（375，svg 325/460）⇒ 渲染 **9.18px**；1440 缩放 0.819 ⇒ **10.64px**。**判据按渲染实测 ≥9px**（v1.2 的 `fontSize="9"` 反而只渲染 6.4px，已作废）。

### 1.5 标签不叠字（r1 A1-③，**新增，v1.2 完全没写**）

现测 375/1440：`svg text` 相交 **11 对**，样本 `79.67×71.90`、`18.18×8.78`、`8.78×3.27`、`3.27×0.04`（1440 上参考刻度 `3.5-9.5` 与末点值 `4.66` 也叠）。这不是"字号太小"，是**密度过高**。

| 项 | 落点 | 值 |
|---|---|---|
| 1.5a 数值标签抽稀 | `TrendsTab.jsx:143` | 点数 >6 时只标 **首点 + 末点 + 极值（max/min）**；其余点的数值只在点列表里给（点**仍然全画**，只抽标签） |
| 1.5b 参考刻度避让 | `TrendsTab.jsx:129` | 参考带标签与该带内曲线点的最小间距 ≥ **12px**（渲染坐标）；不足则隐去参考标签，只留右侧刻度 |
| 1.5c 日期标签 | `TrendsTab.jsx:148` | 已有两行错位（`twoRows`）；阈值 `ceil(n/24)` 抽稀，任意两日期标签 bbox 不相交 |
| 判据 | L13 | 所有 `svg text` **两两 bbox 相交对数 = 0** 且 `min(渲染字号) ≥ 9` |

### 1.6 点列表（2 行截断，已实测达标）

`TrendsTab.jsx:221-229`（clamp 在 `:223`）：`-webkit-line-clamp:2` 实测计算值 = **'2'**（v1.1 时是 `none`，U11 已修），块高 **34px**、`scrollWidth=clientWidth`、`scrollHeight 34 = clientHeight 34`。
**判据 L3**：`clamp === '2'` **且** `scrollHeight ≤ clientHeight + 1`（r1 A1-②：只测高度 34 不稳）。

### 1.7 可选指标选择器（**U24**，用户 2026-11-17 原话「这个图片是指标多选，**用一个组件收起来**」）

**改前实测**（我在 `09e16c9` 的独立 worktree 重构建后量，非估算）：

| 视口 | 选择器卡高 | body 高 | 74 项铺成 | 首张趋势卡绝对位置 | 首屏可见 |
|---|---|---|---|---|---|
| 375×812 | **1539px** | 1485px | **56 行** | **1911px** | ❌ |
| 1440×900 | **373px** | 334px | 12 行 | 624px | ✅（但已吃掉 2/3 屏） |

| 项 | 落点 | 值（**不是"折叠"，是换组件**） |
|---|---|---|
| 1.7a 组件选型 | `TrendsTab.jsx:170-200`（现 `Card` + `Checkbox.Group` 段） | antd **`Select mode="multiple"`**（优先已有框架组件，不新造）：`showSearch` + `filterOption` 按中文名子串匹配、`maxTagCount={1}` + `maxTagPlaceholder`（`+N`）、`allowClear` |
| 1.7b 收起态摘要 | 同上 | 一行「**已选 9 / 共 74**」（12px `#6b7280`）；选择器控件高 **≤40px**，含容器外距的整块 **≤60px** |
| 1.7c 批量操作 | 下拉底部 `popupRender`（或 header `Dropdown`） | 「恢复默认 8 项 / 全选 / 清空」三项收进**下拉内一行**，不再各占一行（改前它们占 2 行、把标题挤到只剩「可」字） |
| 1.7d 桌面同样收起 | 同上（两档同组件） | ≥576 也不许再铺 74 项（改前 1440 铺 12 行 / 373px） |
| 判据 **L17a** | — | 收起态首卡 `rect.top < 视口高 × 0.55`（375 ⇒ < **447px**；改前 **1911**） |
| 判据 **L17b** | — | 选择器容器高 **≤60px**（改前 **1539** / 1440 **373**） |
| 判据 **L17c** | — | `showSearch` 输入「血红」后下拉可见选项数 **< 74**（且 ≥1），清空输入恢复 74 |

> **作废留痕（D10）**：主理人先给的口径是「折叠 + `maxHeight:40vh + overflowY:auto`」，随后按用户原话改成「用一个组件收起来」。40vh 在 812 视口 = **325px**，与 L17b 的 ≤60px **互斥** ⇒ 以 Select 组件口径为准，40vh 写法**作废**。

### 1.8 页签不截断（**U25**）

**改前实测 375**：`.ant-tabs-nav-list` `scrollWidth **405** > nav-wrap clientWidth **305**` ⇒ 第三页签被右缘切成「全病…」（单条 tab 文本本身 `scrollWidth = clientWidth`，是被容器裁的，不是文字溢出）。

| 项 | 落点 | 值 |
|---|---|---|
| 1.8a 短标签（窄屏） | `CardPage.jsx:303-306` `Tabs items` | 375 下用短标签：**总览 / 趋势（74）/ 全病程**（≥576 保留全称）；计数用 `(N)` 括号，不写「临床指标总览（74 项）」这类长串 |
| 1.8b 可滚 + 指示 | `CardPage.jsx` 窄屏 CSS | 容器 `overflow-x:auto`、当前页签 `scrollIntoView({inline:'center'})`；末项必须能滚到（不得有不可达像素） |
| 判据 **L18** | — | 每个 tab 文本 `scrollWidth ≤ clientWidth + 1`；且 `navScrollWidth ≤ navClientWidth + 1` **或** 滚到末项时 `lastTab.rect.right ≤ wrap.rect.right + 1`（改前溢出 **100px**） |

---

## 2. 原件溯源弹窗（`SourceModal.jsx`）

### 2.1 **累计内距 = 12±1（判据重定义，r1 P0-2 / 裁定 R1）**

**定义**：从 `[role=dialog]` 可视左缘（375 下 = 屏幕边）量到**内容左缘**（`.mb-source-left` 内第一个内容元素 = 图片/工具栏/标题所在的基准线）的**累计距离**；不许再报"某一层 padding 的值"。

**现测拆解（这张表就是判据的来源）**：

| 视口 | dlg.x / w | `.ant-modal-container` padding | body padding | 左栏 padding | 到左栏 = | 到标题 = | 判定 |
|---|---|---|---|---|---|---|---|
| 375 | 0 / 375 | **0px** | 0px | 12px | **12** | **12** | ✅ |
| 1440 | 160 / 1120 | **20px 24px** ← 罪魁 | 0px | 12px | **24** | **36** | ❌ 超 12 |

| 项 | 落点 | 值 |
|---|---|---|
| 2.1a 外壳贴边 | `SourceModal.jsx:169-171` | 375：`width:'100vw'`、`top:0`、`maxWidth:'100vw'`、`margin:0`（现测 dlg.x=0、w=375 ✅） |
| 2.1b **外壳内距归零** | `SourceModal.jsx:172-178` `styles` | 加 `content: { padding: 0 }`（antd 6 的 `.ant-modal-container` 默认 `20px 24px`）⇒ **1440 累计 36 → 12**；只压 body/左栏无效，r1 的 32px 就是这么叠出来的 |
| 2.1c 唯一内距 | 左栏 `.mb-source-left` + `styles.header` | `padding: 12`（背景 transparent）+ `header paddingInline: 12`；**除这 12 外不允许任何一层横向内距** |
| 判据 | **L7** | 375 与 1440 都 **12±1**（`content.left − dlg.left` 与 `title.left − dlg.left` 两条都量） |

### 2.2 高度：`100dvh` 取代 `100vh`（裁定 R1，v1.2 写法作废）

**现测**：375 `dlg.h = 748`（视口 812；body `maxHeight: calc(100vh - 140px)` = 672）；1440 `dlg.h = 930`（视口 900，**超出视口 30px**）。
r1 明确否决 `100vh`：iOS Safari 把地址栏算进 `100vh`，会遮底部。

| 项 | 落点 | 值 |
|---|---|---|
| 2.2a body 高度 | `SourceModal.jsx:177` | 375：`{ padding:0, maxHeight:'calc(100dvh - 96px)', overflowY:'auto', paddingBottom:'env(safe-area-inset-bottom, 0px)' }` ⇒ dlg.h ≤ **716** |
| 2.2b 桌面也限高 | 同处 `≥576` 分支 | `{ padding: 0, maxHeight:'calc(100dvh - 96px)', overflowY:'auto' }`（现测 930 > 900，必须收） |
| 2.2c 图片区 | `SourceModal.jsx:162/219` | 手机 `min=max=calc(100dvh - 220px)`（现测 375 可视 **592px** ✅）；桌面 `min 380 / max calc(100dvh - 240px)` |
| 2.2d 底部安全区 | footer / body | `env(safe-area-inset-bottom, 0px)` 计入（Home Indicator 不遮「关闭」） |
| 判据 | **L12** | `dlg.h ≤ 716`（375×812）**且** `dlg.h ≤ innerHeight - 8`（1440）**且** `body.overflowY === 'auto'` |

### 2.3 工具栏：不得裁切（r1 P0-2 前半）

**现测 375**：5 个按钮文案已精简为 `− / ＋ / 适宽 / 适高 / 旋转`，`scrollWidth = clientWidth = 351`、最后一个按钮右缘 226.1 < 容器右缘 363、**clippedPx = 0** ✅（r1 图上「旋转 90°」被裁断的是 12px 文案版本）。

| 项 | 落点 | 值 |
|---|---|---|
| 2.3a 单行横滑 | `SourceModal.jsx:199` | `wrap={!isNarrow}` + 窄屏 `overflowX:'auto'`、`whiteSpace:'nowrap'`、`flexWrap:'nowrap'`、行高 **32**、按钮高 **24** |
| 2.3b 文案精简可接受 | 同处 | 窄屏允许「适宽/适高/旋转」，但必须带 `aria-label` 全称（`适应宽度`/`适应高度`/`旋转 90°`），否则 tooltip 与读屏丢失语义 |
| 判据 | **L14a** | 每个按钮 `rect.right ≤ toolbar.rect.right + 1` 且 `rect.left ≥ toolbar.rect.left - 1`；`scrollWidth ≤ clientWidth + 1`（横滑时允许 scrollWidth 更大，但**首个按钮不得为负溢出**） |

### 2.4 无原件：隐藏缩放/旋转 + 占位 ≤120px（r1 P0-2 Ⅱ / P0-4）

**现测（无原件夹具）**：预览框高 **96**（375）/ **120**（1440），`Empty` 高 **70**，不再吃 500–600px。

| 项 | 落点 | 值 |
|---|---|---|
| 2.4a 隐藏整组 | `SourceModal.jsx:199-215` | `blobKind !== 'image'` 时**不渲染**（不是 `disabled`）缩小/放大/旋转；PDF 只留页码组 |
| 2.4b 紧凑占位 | `SourceModal.jsx:219-222` | `blobKind === 'none'`：`minHeight:96 / maxHeight:120` + 一行 12px 提示「该报告没有存原件（仅结构化数据）」 |
| 判据 | **L14b** | 无原件时「缩放/旋转」按钮数 = **0**；`preview.h ≤ 120`；`empty.h ≤ 96` |

### 2.5 旋转 90° 后不得裁切（**新增实测缺陷**）

**现测**：点击「旋转」后 `img` 的布局盒变为 **494×349**（原 349×494），但预览容器 `scrollWidth = 421`、`clientWidth = 349` ⇒ **左侧约 73px 落在负溢出区，滚不到也裁掉**（`transform` 不改布局，容器 `justify-content:center` 把溢出平分为左右，左边那份不可滚）。

| 项 | 落点 | 值 |
|---|---|---|
| 2.5a | `SourceModal.jsx:219` 预览容器 | `rotate !== 0` 时 `justifyContent: 'flex-start'`（把溢出全部推到右侧可滚区）+ `alignItems:'flex-start'`；容器保留 `overflow:auto` |
| 2.5b | `imgStyle`（`rotate` 分支） | 旋转后按"宽高互换"给尺寸：`fit==='width'` 且 `rotate%180!==0` ⇒ `style={{ width: 'auto', height: '100%' }}`，避免视觉宽超过容器宽而不自知 |
| 判据 | **L16** | `rotate=90` 后 `preview.scrollWidth ≥ 旋转后视觉宽 − 1`（视觉宽 = 原 `img.height`）且 `img.getBoundingClientRect().left ≥ preview.left - 1` |

### 2.6 左右栏

`gap: 12`（≥576）/ 窄屏堆叠 `gap: 8`；`threeSpread`（标题 x / 工具栏 x / 原件 x 极差）现测 **0**（375 与 1440）—— 判据 L8 保留 ≤1px。

---

## 2.7 v0.2 实测复核表（快照 md5 见文首；`改前` 来自 v1.1/v1.2 与 r1 图）

| 量 | 改前 | 现测 375 | 现测 1440 | 目标 |
|---|---|---|---|---|
| 趋势轨道数 / 卡宽 | **9 轨 × 28.33** | **1 / 351×272** | **3 / 403×259** | 1 列 / 3 列 |
| `svg` | 2px | **325×158**（缩放 0.707） | 377×158（0.819） | ≥296 宽 |
| 刻度渲染字号 | 8px（v1.1） | **9.18px** | **10.64px** | ≥9 |
| `svg text` 相交对数 | —（r1 图叠字） | **11** | **11** | **0** |
| 点列表 | 2px×869 | **325×34，clamp='2'，34=34** | 377×34 | ≤36 / clamp 2 |
| 卡头标题×extra 交集 | r1 图被盖 | **0**（head 51–53px） | 0（head 38） | 0 |
| 弹窗累计内距 | **32**（r1 图，12+20） | **12** | **24**（标题 36） | 12±1 |
| 工具栏裁切 | 旋转 90° 被裁断 | **clippedPx 0**（351=351） | 0 | 0 |
| 弹窗高 `dlg.h` | **1598** | **748** | **930**（> 视口 900） | ≤716 / ≤vh−8 |
| 无原件占位 | 500–600 → dlg 1598 | **preview 96 / empty 70** | 120 / 70 | ≤120 |
| 旋转 90° 横向 | 未测 | **scrollW 421 < 494（左裁 73）** | 同构 | scrollW ≥ 视觉宽 |
| 三缘极差 | 参差 | **0** | **0** | ≤1 |
| 可选指标选择器高 | **1539**（375）/ **373**（1440） | 在途（Select） | 在途 | **≤60** |
| 首卡绝对位置 | **1911**（375）/ 624（1440） | 在途 | 在途 | **< 视口×0.55** |
| 页签溢出 | **100px**（405 vs 305） | 在途 | 0 | 0 |

---

## 3. 判据（落仓库门禁 `tests/verify-card-mobile-layout.mjs` + `npm run test:card-mobile-layout`）

> 前置（**不许跳过**）：`grep -n 'test:card-mobile-layout' package.json` 必须命中；未命中 ⇒ 不得声称绿。
> 夹具（r1 A8 要求）：**必须含真实图片原件 blob**（本次用 `data/intake/p1/archive/page-1.png` 拷进临时库），并**另跑一档无原件**做空态对照。

| # | 判据 | 量测式 | 期望 |
|---|---|---|---|
| **L1** | 趋势卡满宽单列 | 非零轨道数 + `cards[0].width` vs `grid.width` | 375：轨道 **1**、差 ≤1px；1440：**3** |
| **L2** | 不再坍缩 | `card.width ≥ 300` 且 `card.height ≤ 400` | 真（改前 28 / 1255） |
| **L3** | 点列表 2 行 | `clamp === '2'` **且** `scrollHeight ≤ clientHeight + 1` | 真 |
| **L4** | 点列表不出竖排 | `pointList.width ≥ 200` | 真（改前 2px） |
| **L5** | 图表尺寸 | `svg.width ≥ 296`、`svg.height ≥ 150` | 真 |
| **L6** | 无横向溢出（**次要**，不是主判据） | `documentElement.scrollWidth ≤ innerWidth` | 真 |
| **L7** | **累计内距** | `content.left − dlg.left` 与 `title.left − dlg.left` | 375 与 1440 都 **12±1** |
| **L8** | 三条竖线 | `title.x / toolbar.x / preview.x` 极差 | **≤1** |
| **L9** | 工具栏单行 | 子元素 `y` 去重数 = 1，工具栏高 ≤40 | 375 真；1440 允许 2 行 |
| **L10** | 图片可视高 | 媒体元素 `height` | 375 **≥560**；1440 ≥380 |
| **L11** | 弹窗贴边 | 375：`dlg.width ≥ innerWidth−1` 且 `dlg.y ≤ 1` | 真 |
| **L12** | 弹窗高度受视口约束 | `dlg.h ≤ 716`（375）/ `≤ innerHeight−8`（1440）+ `body.overflowY==='auto'` | 真（改前 1598） |
| **L13** | 图表文字不叠 | `svg text` 两两 bbox 相交对数 = 0，且 `min(渲染字号) ≥ 9` | 真（现测 11） |
| **L14** | 工具栏不裁 + 空态精简 | `L14a` 每按钮 rect ⊂ 工具栏 rect（±1）；`L14b` 无原件时缩放/旋转按钮数 = 0、`preview.h ≤ 120` | 真 |
| **L15** | 卡头零遮挡 + 状态行不裁 | `L15a` `title∩extra` 面积 = 0 且 `head.scrollWidth ≤ clientWidth+1`；`L15b`「生成中」`lost = 0` | 真 |
| **L16** | 旋转不裁 | `preview.scrollWidth ≥ 视觉宽−1` 且 `img.left ≥ preview.left−1` | 真（现测 421 < 494） |
| **L17a** | 首卡进首屏（U24） | 收起态 `firstCard.rect.top < innerHeight × 0.55` | 375 ⇒ < **447**（改前 **1911**） |
| **L17b** | 选择器高度（U24） | 选择器容器 `rect.height ≤ 60` | 改前 **1539**（375）/ **373**（1440） |
| **L17c** | 搜索可用（U24） | `showSearch` 输入「血红」后下拉可见选项数 `0 < n < 74`；清空恢复 74 | 新增 |
| **L18** | 页签不截断（U25） | 每个 tab 文本 `scrollWidth ≤ clientWidth+1`；且 `navScrollWidth ≤ navClientWidth+1` 或滚到末项时 `lastTab.right ≤ wrap.right+1` | 改前溢出 **100px** |

### 3.1 实现方门禁（`tests/verify-card-mobile-layout.mjs`，`760783c`）复跑核对

> 该门禁只到 L1–L13 + A1–A4，**没有** L14/L15/L16/L17a–c/L18；U24/U25 的判据要新增（见计划 §4 门禁段）。

我复跑：**25 通过 / 0 失败，exit 0**。但**这 25 条里有 3 处判据口径比 r1 弱**，绿了不等于达标 —— 判据仍以本表为准：

| 门禁条目 | 它的写法 | r1/裁定的要求 | 后果（用本快照实测证明） |
|---|---|---|---|
| `L6b 1440 每侧内距 12±1` | `insetPerSide = bodyPad + leftPad`（`tests/verify-card-mobile-layout.mjs:163`）—— 正是 r1 **明确否决**的"某一层 padding 的值"口径 | 从 `[role=dialog]` 可视左缘量到内容左缘 | 1440 真值 **24**（标题 **36**，`.ant-modal-container` padding `20px 24px`），门禁仍 PASS |
| `L11 弹窗总高` | `modalH <= vh + 1`（且只测 375） | `≤716`（= 812−96），1440 也要约束 | 375 现测 748 > **716** 但 ≤ 812 ⇒ PASS；1440 现测 **930 > 900** 完全没测 |
| `A3 零叠字` | 只比 `refVsValOverlaps`（参考刻度 ∩ 点值标签） | 所有 `svg text` 两两不相交 | 点值 × 点值 **11 对**相交（`79.67×71.90` 等）不在其统计内 ⇒ PASS |

**结论**：`09e16c9` 的实现对"口径未改"的部分是达标的（工具栏不裁、卡头零遮挡、账号页 0 溢出、点列表 clamp、刻度 ≥9、375 内距 12），但**累计内距 1440、弹窗高、点值叠字**三项仍须按本表重做/重判 —— 门禁要同步改这三条判据，否则下一轮 r2 会被同样的问题再打回。

**证伪（每条必须真红 exit 1，贴退出码）**
1. `CardPage.jsx:54` 改回 `repeat(auto-fit,minmax(0,1fr))` ⇒ **L1/L2 红**；
2. 左栏 padding 回 0（或把 `.ant-modal-container` padding 恢复 20/24）⇒ **L7 红**（1440 36→ 更红）；
3. 去掉 body `maxHeight` ⇒ **L12 红**；
4. 数值标签去掉抽稀 ⇒ **L13 红**；
5. 无原件时把缩放/旋转按钮改回"禁用但渲染" ⇒ **L14b 红**；
6. 预览容器 `justifyContent` 回 `center` ⇒ **L16 红**；
7. 把选择器改回铺 74 个 `Checkbox` ⇒ **L17a/L17b 红**；
8. 页签换回全称长标签（不滚） ⇒ **L18 红**。

---

## 4. A5 七项（r1 漏测项）—— 规格只给"可量判据"，清单与优先级在计划 v0.2（U16–U22）

| 项 | 判据（可复跑） | 现测（375） |
|---|---|---|
`100dvh` | 源码 `web/src/pages/card/SourceModal.jsx`、`web/src/pages/intake/CardPreview.jsx` 的 `calc(100vh` 命中数 = **0**（弹窗相关）；`grep -rn "calc(100vh" web/src/pages` 只剩非弹窗用途 | 仍有 `SourceModal.jsx:177` 与 `CardPreview.jsx:106` 各 1 处 |
safe-area | 弹窗 footer / 吸底条 `paddingBottom` 含 `env(safe-area-inset-bottom` | 4 处已有（`CardPreview.jsx:80` 等），SourceModal footer `0` 处 |
软键盘 | `visualViewport` 高被压到 ~400 时，登录/搜索/新建账号的输入框与提交按钮 `rect.bottom ≤ visualViewport.height` | **未测**（本轮不含，列入 U18） |
圆点热区 | 趋势 SVG `circle` 的命中区 ≥ **44×44**（透明命中层），点数不变 | `r=5` ⇒ **7px**；`r=2.2` ⇒ **3px**，73 个圆点 |
表格 nowrap | 375 下 `scrollWidth == innerWidth` **且** 手机号/操作列 `white-space: nowrap` + `min-width`，列不竖排（最高单元格 < 60px） | 账号页：`scrollW 375 = innerW`、最高单元格 **41px**、被裁单元格 **0**；注入 nowrap+min-width 后表内横滑 **801 / 319**（页面仍 375） |
viewport-fit | `index.html` viewport `content` 含 `viewport-fit=cover`；输入框 `font-size ≥ 16px`（iOS 不自动放大） | viewport **缺** `viewport-fit`；输入框 **81 个**，最小 **14px** |
横向 Tab | 页签 `nav-list.scrollWidth ≤ nav-wrap.clientWidth + 1`，或明确可横滑且当前页签完整可见 | `scrollW 405` vs `clientW 305` ⇒ 溢出 **100px**（「全病…」截断） |

---

## 5. 条数

规格 **36 条**（§1 二十二条：1.1a–d / 1.2a–b / 1.3a / 1.4 / 1.5a–c / 1.6 / **1.7a–d** / **1.8a–b**；§2 十四条：2.1a–c / 2.2a–d / 2.3a–b / 2.4a–b / 2.5a–b / 2.6）+ 判据 **L1–L18（18 条，8 条带证伪）**。
**改前基线**：9 轨 × 28.33px / 卡 28×1255 / svg 2px / 点列表 2px×869 / 弹窗累计内距 32（r1 图）/ 弹窗高 1598 / 工具栏「旋转 90°」被裁断 / 选择器 1539px(375)·373px(1440) / 首卡 1911px / 页签溢出 100px。
