# ① 批量导入模块 —— **UI/交互数值规格** v1.0（UI 设计师，2026-11-16 23:2x）

> 输入：`.agents/batch-import-1116-plan.md` v0.1 的 **D-1 七条（MVP）** + D-3 的 4 个前提问题。
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

> **一致性硬要求**：本批不出现 7/14/18px 这类散值；新增文本一律 11/12/13。

---

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

### 2.4 删除图标按钮（D-1 第 1 条）

- 图标：antd `DeleteOutlined`，**`font-size: 14px`**（`line-height:1`）。
- 视觉盒 **24 × 24**，热区 **44 × 44**：

```css
.mb-icon-btn { position: relative; width: 24px; height: 24px; padding: 0; border: 0;
  background: transparent; border-radius: 8px; color: #8c8c8c; display: inline-flex;
  align-items: center; justify-content: center; cursor: pointer; }
.mb-icon-btn::before { content: ''; position: absolute; inset: -10px; }  /* 24+20 = 44 热区，命中归宿主 */
.mb-icon-btn:hover { color: #ff4d4f; background: #fff1f0; }
.mb-icon-btn:active { background: #ffe7e6; }
.mb-icon-btn:focus-visible { outline: 2px solid #c8102e; outline-offset: 2px; }
```
- `aria-label="移除此文件"`、`title="移除此文件"`（**文案不写"删除"**：只移除本次未入库条目，见计划 F2）。
- **危险色只在 hover/active 出现**，常态灰 `#8c8c8c` —— 理由是"移除未入库条目"可反悔（重新拖进来即可），不必常态红着脸制造焦虑。

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
> **但加一道保险**（1 行、可断言）：`sec !== 'upload'` 时不渲染该栏（`sec` 已是页面 state，`IntakePage.jsx:112`）。这样即便 ① 卡片在视口里还剩一截，② 高亮时栏也一定消失。

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
| **栏总高（含 1px 上边框）** | **49** | **61 + `safe-area-inset-bottom`** |
| 栏右缘到卡片右缘 | 0（贴内缘） | 0 |
| 内容区补 padding-bottom | **0（sticky 占位，不需要）** | **0** |

### 3.3 结构要求（**这点不做会整块失效**）

栏**必须是 `.ant-card-body` 的直接子元素**，且**不许**放进 antd `<Space>`（`Space` 会给每个孩子套 `.ant-space-item`，item 高度 = 栏高 ⇒ sticky **没有可移动空间**，表现为"栏跟着内容走"）。

```jsx
<Card size="small" title="① 批量导入" extra={…}>
  <div className="mb-upload-body">        {/* display:flex; flex-direction:column */}
    <Space direction="vertical" size={10} style={{ width: '100%' }}> …既有内容… </Space>
    {items.length > 0 && sec === 'upload' && <div className="mb-batchbar"> …按钮… </div>}
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

**「更多」菜单内容**：仅 1 项「清空勾选」（`selected` 非空时可点）。后续若要加低频项，只往这里加，**不许再加到栏面**。

---

## 5. 多选序号徽标（C-9 / 拼接顺序）

- 位置：**checkbox 右侧、与 checkbox 不重叠**，`gap: 4px`；顺序 = 勾选顺序（`selected` 数组下标）。
- 尺寸 **16 × 16**，圆形 `border-radius: 50%`，底色 `#c8102e`，字色 `#fff`，字号 **11px**，`line-height:16px`，`text-align:center`。
- 字符：`① ② ③ ④`（U+2460..U+2463）。
- 不重叠的理由：16px 圆压在 16px 方框上（`left:-4;top:-4`）会让勾标与序号互相遮挡，且两处都吃点击热区 ⇒ 误触；并排多占 20px（16+4），375 下预算仍够（§2.3 已算）。
- 上限 **4**：第 5 次勾选 `message.info('一次最多拼接 4 张；再拼请分批')`，且**不加入** `selected`。

---

## 6. 「重新识别 / 重试」（D-1 第 2 条）

| status | 呈现 | 位置 |
|---|---|---|
| `pending` | **无按钮**（用户 N2：只留一键识别） | — |
| `ocr` | `Spin size="small"` + `识别中…`（12px） | 卡底元信息行 |
| `done` | 按钮 `重新识别`（`size="small"`，`ReloadOutlined` 前置图标，`font-size:13`） | **卡底整行、右对齐** |
| `failed` | 按钮 `重试`（同上；`danger` 文字色） | 同上 |

**选"卡底整行右对齐"而不是"角落图标"，三条理由**：
1. **误触**：角落（右上）已有删除 24px + 44 热区，再塞一个 icon 按钮 ⇒ 两个 44 热区在 56px 宽内**必重叠**；
2. **条件呈现不占位**：只在 `done`/`failed` 出现，且与元信息行（大小 / 行数 / 标签）同一行右缘，**不新增行高**；
3. **语义分组**：删除 = 单条管理（头部右）；重识别 = 单条修复（底部右）。上下分离 20px 以上，指错一次不会毁数据。

- 尺寸：`height 24px`、`padding 0 8px`、`font-size 13px`、`border-radius 8px`；375 下若与元信息挤：**元信息先换行**（`flex-wrap: wrap`），按钮 `flex: 0 0 auto` 永远不折。

---

## 7. 重复提示两处（D-1 第 5/6 条，口径不许越界）

| 时机 | 判据（**只这一条**） | 呈现位置 | 文案（**定稿，不许改写成"疑似重复报告"**） |
|---|---|---|---|
| **导入时**（新） | `sha256(文件字节) === reports[].sha256`（`exact-file`） | **卡底元信息行**追加 `Tag color="orange"` | **`同一文件已导入过`**（`title="本文件的 sha256 与库内已有文件完全相同；入库时仍会再判一次"`） |
| **识别后**（既有） | 后端 `findDuplicate` 单据级（条码+日期+类型） | 卡头状态 Tag（`ST.dup`，既有） | **`疑似同一份报告`**（把 `shared.js:10` 的 label 从「疑似重复」改成这一句，只改 label 字面，不动 color/default） |

- **顶部 extra 计数分离**：新增 `Tag color="orange"`「已导入过 {M}」；既有「疑似重复 {dupCount}」**保留原名**，两者不合并（计划 F3）。
- **不落 `status`**：预检结果存独立字段 `predup: { kind: 'exact-file', of: <reportId> }`，`status` 仍是 `pending`；识别/入库不受影响（真相仍由后端裁定）。
- **算不了哈希时**（非安全上下文，`window.isSecureContext === false` 或缺 `crypto.subtle`）：卡片打灰色 `Tag`「**本次未做文件查重**」，且**顶部不出「已导入过」计数** —— 不假装查过（计划 R10 建议 a）。

---

## 8. 验收判据（**四档可复跑断言**，`/tmp/verify-batch-1116.mjs`，Playwright）

> 统一前置：`MEDBRIEF_BASE=http://127.0.0.1:5174`、副本库、四个视口 `1440×900 / 768×1024 / 414×896 / 375×812`。
> 每条断言都必须**能红**：期望值写死在断言里，`fail()` 计数，退出码 `failed?1:(na>0?2:0)`（沿用 `tests/verify-grid-narrow-D1.mjs` 的三档口径）。

| # | 判据 | 量测式（直接粘贴可用） | 期望 |
|---|---|---|---|
| **A1** | 栏贴底且不遮内容 | 滚到底后：`const bar=document.querySelector('.mb-batchbar'); const cards=[...document.querySelectorAll('.mb-item-card')]; Math.abs(innerHeight - bar.getBoundingClientRect().bottom) <= 1 && 最后一张卡.rect.bottom <= bar.rect.top + 0.5` | 两者皆真 |
| **A2** | 栏高与安全区 | `Math.round(bar.getBoundingClientRect().height)` | ≥576：**49**；≤575：**61 + safeArea**（无 safe-area 时 61） |
| **A3** | ② 段落隐藏 | 滚到 `#sec-review` 可见后：`document.querySelector('.mb-batchbar')` | **null** |
| **A4** | 375 不换行 | `bar.scrollWidth <= bar.clientWidth + 1`，且每个按钮 `getComputedStyle(b).whiteSpace === 'nowrap'`、`Math.round(b.rect.height)` = **44**（≤575）/ **32**（≥576） | 全真 |
| **A5** | 头部不挤爆 | 文件名元素：`el.scrollWidth > el.clientWidth`（确认发生截断）时 `Math.round(el.rect.width) >= 96`；且状态 Tag 仍可见（`tag.rect.width > 0`） | 全真 |
| **A6** | 触摸热区 44 | 删除按钮：`el.getBoundingClientRect()` 视觉 **24×24**；热区用命中判：以按钮中心为原点，`document.elementFromPoint(cx+20, cy)`、`(cx-20, cy)`、`(cx, cy+20)`、`(cx, cy-20)` **都返回该按钮**（`::before` 扩展归宿主） | 4 点全命中 |
| **A7** | 三态按钮 DOM 存在性 | 0 选：`bar.querySelectorAll('[data-bar-btn]').length === 2` 且无 `[data-act="stitch"]`；选 1：有 `[data-act="remove"]`、无 `stitch`；选 2：`[data-act="stitch"]` 文案 === `拼接（2）` | 全真 |
| **A8** | 序号徽标 | 选 2 张后：`[...document.querySelectorAll('.mb-pick-badge')].map(e=>e.textContent).join('')` === `'①②'`；每个徽标 rect = **16×16**；与 checkbox rect **不相交**（`a.right <= b.left + 0.5`） | 全真 |
| **A9** | 重复提示口径 | 预置一份库内已有的同一文件后导入：卡片内 `.mb-predup` 存在、文案 === **`同一文件已导入过`**、且组件树文本**不含** `疑似重复报告` | 全真 |
| **A10** | 栏内按钮不出卡 | 每个按钮 `rect.left >= bar.rect.left - 0.5 && rect.right <= bar.rect.right + 0.5` | 全真 |
| **A11** | 无回退：既有契约 | `document.querySelectorAll('.g-grid').length`、`.mb-review-grid` 高度、`.card` 上无新增 `mb-batchbar` 子孙（`document.querySelector('.card .mb-batchbar')` 只允许 1 个且父级是 `.mb-upload-body`） | 全真 |
| **A12** | 页面不横向滚 | 四档 `document.documentElement.scrollWidth <= clientWidth + 1` | 全真 |

**证伪要求（沿用上轮口径）**：至少做一次"改坏再修"：把 `.mb-batchbar` 的 `position: sticky` 改成 `static` ⇒ **A1 必红**（栏不再贴底）；把按钮宽 `flex:1 1 0` 去掉 ⇒ **A4 必红**（375 `scrollWidth > clientWidth`）。两次都要贴退出码 **1**。

---

## 9. 与既有契约的边界（实现方不许越线）

1. **不碰**：`.card`、`rb-edit-grid-wrap`、DataGrid 的 `.g-ctl` / `g-main` / `.mb-edit-modal`、`.mb-review-grid` 及其 375 注入 CSS。
2. **只允许改 3 个文件**：`web/src/pages/intake/UploadPanel.jsx`、`web/src/pages/IntakePage.jsx`（传 `sec` 与多选语义）、`web/src/pages/intake/shared.js`（**只改 `ST.dup.label` 一个字面**）。
3. **新增 DOM/CSS 一律带 `mb-` 前缀**：`mb-upload-body` / `mb-batchbar` / `mb-item-card` / `mb-file-name` / `mb-icon-btn` / `mb-hit44` / `mb-pick-badge` / `mb-predup` / `mb-bar-btn`。
4. **不引入**新色值：只用 §1 的颜色表。
5. `selected` 语义从"拼接专用 2 张"扩成通用多选后，`doStitch` 必须改 `>=2 && <=4`，顺序取 `selected` 数组顺序；`toggleSelect` 不再挤掉最早（`IntakePage.jsx:214-221`）。

---

## 10. 需 r2 / 主理人确认的三处（我的建议已写在括号里）

1. **「更多」在 0 选时是否渲染** —— 我按"隐藏无关按钮"**不渲染**（与计划 D-1 第 3 条列举略有出入）。
2. **栏文案用短文案**「识别（N）/导入（M）/拼接（N）」而非「一键识别（N）/一键导入（M）」—— 375 宽度算术不支持长文案（§4）。
3. **短列表（内容 < 一屏）时栏是否仍吸底** —— 我按**不吸底、贴在内容末尾**（sticky 的自然行为）。若产品要求"永远吸底"，需给 `.mb-upload-body` 加 `min-height: calc(100dvh - var(--mb-sec-top))`，`--mb-sec-top` 由 `ResizeObserver` 写（实测 375 下 `#sec-upload` 的 top = 431px，但该值随上方块高度变化，不能写死）。

---

## 11. 条数统计

- 规格条目：**§2 卡片头部 5 条 / §3 操作栏 6 条 / §4 三态 6 条 / §5 徽标 4 条 / §6 重识别 4 条 / §7 重复提示 5 条 = 30 条**
- 可复跑判据：**A1–A12 共 12 条**（其中 A1/A4 各带一条证伪要求）
- 需确认项：**3 条**（§10）
