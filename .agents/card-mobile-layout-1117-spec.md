# 动态趋势看板 + 原件溯源弹窗 —— **移动端版面规格** v1.2（UI 设计师，2026-11-17）

> 用户真机反馈（截图 1220×2712 / DPR≈3 / 等效 CSS 宽 ≈400px）+ 我用 **本机 5197 实例（`MEDBRIEF_AUTH=off`，真库只读）** 在 **375×812** 与 **1440×900** 实测。
> 落地：**代诊-账号 单写者**。文件：`web/src/pages/CardPage.jsx`、`web/src/pages/card/TrendsTab.jsx`、`web/src/pages/card/SourceModal.jsx`。

---

## 0. **根因更正（重要，别照上一封的定位改）**

主理人上一封判「`TrendsTab.jsx:186` 的 `minmax(380px,1fr)` 是主因」——**实测不是**。375 下根本没走到 380：

| 实测（375×812） | 值 |
|---|---|
| `.mb-trends-grid` 容器宽 | **351px** |
| 计算后 `gridTemplateColumns` | **9 条 28.33px**（+ auto-fit 折叠的空轨） |
| 每张趋势卡 | **宽 28px / 高 1255px** |
| 卡内 `<svg>` | **宽 2px / 高 158px** |
| 点列表容器 | **宽 2px / 高 869px**（⇒ 一字符一行） |
| `documentElement.scrollWidth` | **375 = clientWidth**（**页面并没有横向溢出**） |

根因是 **`web/src/pages/CardPage.jsx:43`**（`@media (max-width:575px)` 内、带 `!important`）：
```css
.mb-trends-grid { grid-template-columns: repeat(auto-fit, minmax(0, 1fr)) !important; }
```
`auto-fit + minmax(0,1fr)` 在 351px 里会**按卡片数量均分**（9 张 ⇒ 每张 28px），于是把卡压成竖条；`TrendsTab.jsx:186` 的 `380px` 被这条 `!important` **完全盖掉**，所以改 186 不会有效果。

⚠️ 连带纠正一条验收口径：用户说的"溢出"在 375 下 **scrollWidth 本来就是 375**（不溢出），真正的病是**列数坍缩**。所以判据必须是「**列数 = 1 且 卡宽 = 容器宽 ±1px**」，不能只看 `scrollWidth <= innerWidth`（那条现在就是绿的，抓不到这个 bug）。

---

## 1. 趋势看板（改 2 个文件）

| # | 改什么 | 落点 | 值 |
|---|---|---|---|
| 1.1 | **删掉那条 `auto-fit` 覆盖，改单列** | `CardPage.jsx:43` | `.mb-trends-grid { grid-template-columns: minmax(0,1fr) !important; }`（**不是** `repeat(auto-fit,…)`） |
| 1.2 | 桌面/平板两列规则显式化（不再靠内联 380 猜） | `TrendsTab.jsx:186` | `gridTemplateColumns: window 宽 ≥ 769 ? 'repeat(2, minmax(0,1fr))' : 'minmax(0,1fr)'`；**或**内联改 `repeat(auto-fit, minmax(min(100%, 320px), 1fr))` 且删除 1.1 的 `!important`（二选一，别两处同时管） |
| 1.3 | **卡片最小宽 320px** | 同 1.2 | 容器 < 320 ⇒ 单列满宽；320 ≤ 容器 < 652（=320×2+12）⇒ 单列；≥652 ⇒ 双列 |
| 1.4 | 标题/extra 换行 | `TrendsTab.jsx:158`、`:191-193` | 两处 `<Space>` 加 **`wrap`**；`extra` 的「参考 xx」在窄屏允许换到第二行（**不要**缩成 `0` 号字） |
| 1.5 | **点列表：2 行截断** | `TrendsTab.jsx:196-200` | 容器加 `display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; line-height:17px`；**并在末尾补 `共 N 次`**（11px `#6b7280`，`title` 给全量文本）。375 下该块高 **34px**（2×17），卡片总高预算 **≤ 260px** |
| 1.6 | 图例/勾选组已 `flexWrap:'wrap'`（`:172`） | 不改 | — |
| 1.7 | **图表刻度字号下限** | `TrendsTab.jsx:115` | 右侧参考刻度 `fontSize="7"` → **`9`**（375 下单列后 SVG 缩放 327/300≈1.09 ⇒ 渲染 ≈9.8px；`7` 只有 7.6px，偏小） |
| 1.8 | 图表最小尺寸 | `TrendsTab.jsx:107` | `width="100%"` 保持；**最小 CSS 宽 = 卡内宽（≥300px）**、高度保持 **158px**（375 实测够读） |

---

## 2. 原件溯源弹窗（`SourceModal.jsx`）

**改前基线（代码链路，与你截图一致）**：`styles.body padding:12`（`:157`）+ 左栏 `padding:8`（`:168`）+ 内白容器圆角（`:186`）⇒ **图片左右各被吃掉 12+8 = 20px**，两层底色（灰 `#f5f6f8` + 白）套两层框。

| # | 改什么 | 落点 | 值（**唯一内距 = 12px**） |
|---|---|---|---|
| 2.1 | 弹窗贴边 | `SourceModal.jsx:151-156` | `≤575`：`width:'100vw'`、`top:0`、`style={{ maxWidth:'100vw', margin:0, paddingBottom:0 }}`；`≥576` 保持 `92vw / maxWidth 1120 / top 24` |
| 2.2 | **body 内距归零** | `:157` | `styles={{ body: { padding: 0 } }}`（手机/桌面同值） |
| 2.3 | **左栏承担唯一内距** | `:168` | `padding: 12`、**`background: transparent`**（去掉灰底）；`:186` 内白容器 `borderRadius: 0`、`background: transparent`（**去掉白底**）⇒ 只剩 12px 一层 |
| 2.4 | 头部同边距（对齐基准） | `Modal` 加 `styles={{ header: { paddingInline: 12 } }}` | 标题左缘 = 工具栏左缘 = 原件左缘 = `modal.x + 12`（**±1px**） |
| 2.5 | 工具栏单行不换行 | `:170` | `<Space size={4} wrap={false} style={{ overflowX:'auto', whiteSpace:'nowrap', height:32 }}>`；按钮保持 `size="small"`（高 24）、行高 **32px**；`≥576` 保持现有 `wrap` |
| 2.6 | 图片区高度按视口算 | `:186` | `≤575`：`minHeight:'calc(100vh - 220px)'`、`maxHeight:'calc(100vh - 220px)'`（220 = 头部 56 + 工具栏 32 + footer 56 + 上下各 12 + 余量 52）⇒ **375×812 下图片可视 ≈592px**；`≥576`：`minHeight:380`、`maxHeight:'calc(100vh - 240px)'` |
| 2.7 | 左右栏间距 | `:168` 外层 flex `gap` | **12px**（手机堆叠时改为 `gap: 8px`） |

---

## 2.1 弹窗「唯一内距」实测复核（v1.1，实现已落地）

我在**当前工作树**（`M web/src/pages/card/SourceModal.jsx`，未提交）实测：

| 量 | 375 | 1440 | 判定 |
|---|---|---|---|
| `body` padding | `0 8px` | `0 12px` | **唯一内距就这一层**（原 12+8=20 已消失） |
| 左栏 `.mb-source-left` padding / 背景 | `0` / `transparent` | `0` / `transparent` | 灰底已去掉 ✓ |
| 标题 x vs 左栏 x | **32 = 32** | **196 = 196** | 三缘同一条线 ✓ |
| 工具栏行数 | **1** | 1 | 单行 ✓ |

**「唯一内距」定稿：EDGE = 12px，两档同值**（2026-11-17 主理人裁定）。

- 实现写法固定三件：`styles.body = { padding: 0 }` + 左栏 `.mb-source-left { padding: 12 }`（背景 `transparent`）+ `styles.header = { paddingInline: 12 }`；
- 判据 L7 期望：**375 与 1440 都是 12±1**。
- **v1.1 的两档值（8/12）作废**：我上一版接受了实现取的窄屏 8，理由是"档内唯一"；主理人裁定的理由更硬 —— 手机上一旦取 0/过小内距，内容会贴屏幕边，而**标题本身自带缩进**，两点叠加会让"三缘同线"这条判据根本对不齐。⇒ **回到 12 单一值**。
- **当前工作树实测是 `0 8`（375）**，按本稿要统一到 **12**；我复查按 **12±1** 判，不按 8 判。

### 2.1b **U4（弹窗高度未受视口约束）—— 状态改为「待复测」，不重复改**（2026-11-17 主理人裁定）

实测 375：`[role=dialog]` 高 **1598px**（视口 812）；1440：930（视口 900）。⇒ 手机上一屏看不到弹窗内容，要长滚才能到底。

> **先复测再改**：U2 的内距/结构改造可能已经吃掉一部分高度，**剩多少补多少，不许按本节的写法定值重复改**。复测口径：在同一实例上量 `dialog.rect.h`；若已 ≤716 则本条关闭。

**改法（落到 `SourceModal.jsx`）**：
- `Modal` 的 body 容器：`≤575` 加 **`maxHeight:'calc(100vh - 96px)'` + `overflowY:'auto'`**（96 = 头部 56 + footer 56 − 余量 16）；
- 左栏图片区：`≤575` `minHeight/maxHeight: 'calc(100vh - 220px)'`（220 = 头部 56 + 工具栏 32 + footer 56 + EDGE×2 16 + 余量 60）⇒ **375×812 下原件可视 ≈592px**；`≥576` 保持 `minHeight:380 / maxHeight:'calc(100vh - 240px)'`。
- 判据 L10 期望：375 下媒体元素高 **≥560**；L4b（新增）：`dialog.h ≤ 716`（= 812 − 96）。

## 3. 判据（落仓库门禁 `tests/verify-card-mobile-layout.mjs`，**待创建**；`npm run test:card-mobile-layout`）

> 前置：与本次实测同法起**独立实例**（`PORT=519x`、`MEDBRIEF_AUTH=off`、真库只读），两视口 `375×812` / `1440×900`。

| # | 判据 | 量测式 | 期望（375） | 期望（1440） |
|---|---|---|---|---|
| **L1** | **趋势卡单列且满宽** | `grid` 的 `gridTemplateColumns` 拆出非零轨道数；`cards[0].rect.width` vs `grid.rect.width` | 轨道 **1** 条、卡宽差 **≤1px** | 轨道 **2** 条（`repeat(2,…)` 时恒 2） |
| **L2** | **不再坍缩**（抓本次 bug 的主判据） | `cards[0].rect.width >= 300` 且 `cards[0].rect.height <= 400` | 真（改前是 **28 / 1255**） | 真 |
| **L3** | 点列表 2 行 | 点列表元素 `rect.height <= 36` 且 `-webkit-line-clamp === '2'`；文本含 `共 N 次` | 真（改前 **869px**） | 真 |
| **L4** | 点列表不出竖排 | 同一行内字符不出现"每行 1 字"：`rect.width >= 200` | 真（改前 **2px**） | 真 |
| **L5** | 图表可读 | `<svg>` `rect.width >= 300`；所有 `text` 的 `rect.height >= 9`（含 `:115` 那条） | 真（改前 svg **2px**） | 真 |
| **L6** | 无横向溢出（**必要的次要条件，不是主判据**） | `documentElement.scrollWidth <= innerWidth` | 真 | 真 |
| **L7** | 弹窗唯一内距 | 图片左缘 − 左栏左缘 = **EDGE ±1px**，右侧同样 | **12 ±1**（改前 **20**） | **12 ±1** |
| **L8** | 三条竖线对齐 | `title.x`、工具栏 `rect.x`、原件 `rect.x` 三者极差 **≤1px** | 真 | 真 |
| **L9** | 工具栏单行 | 工具栏内子元素 `y` 去重数 = **1**；`scrollHeight <= 40` | 真（改前 **2 行**） | 允许 2 行 |
| **L10** | 图片可视高 | 媒体元素 `rect.height >= 560`（375×812，按 2.6 的 592 反推留余量） | 真 | `>=380` |
| **L11** | 弹窗贴边 | `≤575`：`modal.rect.width >= innerWidth - 1` 且 `modal.rect.y <= 1` | 真 | 不要求（保持 92vw/top24） |

| **L12** | 弹窗高度受视口约束 | `dialog.rect.h <= 716`（375×812）+ `body.overflowY === 'auto'` | 真（改前 **1598**） | 不要求 |

**证伪（3 条，贴退出码 1）**：① 把 `CardPage.jsx:43` 改回 `repeat(auto-fit,minmax(0,1fr))` ⇒ **L1/L2 必红**；② 把 body padding 改回 12 ⇒ **L7 必红**；③ 去掉 body 的 `maxHeight` ⇒ **L12 必红**。

---

## 4. 条数

规格 **15 条**（§1 八条 + §2 七条）+ 判据 **L1–L11（11 条，2 条带证伪）**。改前基线：**9 列 × 28.33px / 卡 28×1255 / svg 2px / 点列表 2px×869 / 弹窗内距 20px / 工具栏 2 行**。
