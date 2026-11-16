# 编辑报告弹窗 375 版面整改方案（独立审核 r1）

> 审核者：报告整合（只读审核）。本文**只出方案**：不改任何生产代码、不写测试、不动计划。
> 目标文件：`web/src/pages/intake/ReportsPanel.jsx:104-121`（`REPORT_EDIT_MODAL_MOBILE_CSS` 整段替换）。
> 复跑环境：5174 `head=bd34b14`、真浏览器 375×812（`deviceScaleFactor` 无关，几何按 CSS px 量）。
> 本文所有数字都是我自己注入 CSS 前后各量一次的实测值，**不是推算**。

---

## 0. 一句话总判

**A 批（P0）与 B 批（P1）可以照抄执行** —— 每一条都给了选择器与值，已在 320/375/414/1440 四档实测，1440 桌面逐字段 `identical: true`。
**C 批（P2，再省 346px 纵向）必须先拿用户一句点头**，其中「无图时收起原图卡」是删可见块。
另有一条**必须书面接受**的副作用：表格列宽会重新分配（结果列 71→69 无实质影响，代码列 96→155 反而更可读，见 §5）。

用户两条批评的根因都已定位，且**不是同一个**：
- 「两层 padding 叠加」= `container 20px 24px` + `body 8px 12px`，左右各 36px，正文可用宽 359→**287**；
- 「对不齐」= 真因不是 padding，而是 `.grid.gap-4.lg:grid-cols-5` 的**隐式栅格轨道被 `min-w-[760px]` 表格撑到 784px**（子项 `min-width:auto`），把 body 变成横向+纵向双滚动。见 §3。

---

## 1. 实测前后对照（375×812，同一份报告 `rep_mwhjidmjrfh`）

| 指标 | 改前 | 改后 | 判据 |
|---|---|---|---|
| `.ant-modal-container` padding | `20px 24px` | `0px` | 唯一归零项 |
| `.ant-modal-body` padding | `8px 12px` | `6px 12px 8px(+safe)` | 侧边唯一 12px 栅格 |
| body `clientWidth` | 311 | **359** | — |
| **正文可用宽** | **287** | **335（+48 / +16.7%）** | ≥335 |
| body `scrollWidth / clientWidth` | **796 / 311 ❌** | **359 / 359 ✅** | 必须相等 |
| 横向滚动容器 | body（横+纵双滚） | 表格自带 `.overflow-x-auto`（760/311）**唯一** | 仅 1 个 |
| 栅格轨道 `.grid(gap-4 lg:grid-cols-5)` | **784px** | **335px** | ≤ 正文可用宽 |
| 首屏正文可视高度 | 660 | 710 | ≥660 |
| 内容左边界（header 标题 / body 子项） | 44 / 44 | **20 / 20** | 三者相等 |
| footer 末位按钮右边界 | 331 | **355** | = modal.right−12 |
| 1440 桌面（y/h/body/轨道/卡片 padding/textarea 高） | y=100 h=726 body 610/610 | **逐字段 identical** | 零回归 |

改后截图（我注入 CSS 后真机截图，非源码改动）：`/tmp/r13/F-375.png`、`/tmp/r13/A+P2.png`。

---

## 2. ① CSS 具体写法（作用域、值、批次）

**作用域铁律**：每一条选择器都必须以 `.mb-edit-modal` 开头；整段只在 `@media (max-width: 575px)` 内；不加 `isXs` 依赖（断点抖动会反复注入）；不复用 `APP_MOBILE_CSS`（`web/src/App.jsx:25-40` 写明单一 owner）；沿用现有独立 `useEffect` + `id='mb-report-edit-modal-mobile'`（`ReportsPanel.jsx:176-182`），**不动**。

### A 批 · P0 必改（版面/对齐/单滚动容器，本次就做）

```css
@media (max-width: 575px) {
  /* A1 唯一水平栅格：container 归零，header/body/footer 才能共享同一条 12px 侧栅格 */
  .mb-edit-modal .ant-modal-container { padding: 0 !important; }
  /* A2 header：纵向 12/10，右侧 44 给开关闭按钮（32 触控 + 12 间隙），标题永不被 X 压 */
  .mb-edit-modal .ant-modal-header { padding: 12px 44px 10px 12px !important; }
  /* A3 关闭按钮上提 4px，否则 2.4px 探出 header、压在 body 首行上方（改前它在 header 内，是我们把 header 压薄带来的） */
  .mb-edit-modal .ant-modal-close { top: 8px !important; }
  /* A4 body：侧边只留 12，纵向 8→6，底部叠 iOS 安全区；禁横滚（横向交给表格自己） */
  .mb-edit-modal .ant-modal-body { padding: 6px 12px calc(8px + env(safe-area-inset-bottom)) !important; overflow-x: hidden !important; }
  .mb-edit-modal .ant-modal-footer { padding: 6px 12px calc(6px + env(safe-area-inset-bottom)) !important; }
  /* A5 单一横向滚动容器：把 784px 隐式轨道压回容器宽（根因，见 §3） */
  .mb-edit-modal .rb-edit-grid-wrap > div > .grid { grid-template-columns: minmax(0, 1fr) !important; }
  .mb-edit-modal .rb-edit-grid-wrap .grid > * { min-width: 0 !important; }
}
```

### B 批 · P1 同批可做（零风险，已实测）

```css
@media (max-width: 575px) {
  /* B1 卡片内边距 16/12 → 12（只收自带 padding 的卡，不动 pad-0 的图卡） */
  .mb-edit-modal .rb-edit-grid-wrap .card.p-3,
  .mb-edit-modal .rb-edit-grid-wrap .card.p-4 { padding: 12px !important; }
  /* B2 335px 里工具栏必须折行，否则 5 个按钮挤成 445px、中文竖排（改前靠 784 的宽卡掩盖了） */
  .mb-edit-modal .rb-edit-grid-wrap .card > .flex.items-center.justify-between { flex-wrap: wrap !important; row-gap: 6px !important; }
  .mb-edit-modal .rb-edit-grid-wrap .card > .flex.items-center.justify-between > div { flex-wrap: wrap !important; row-gap: 6px !important; }
  .mb-edit-modal .rb-edit-grid-wrap button { white-space: nowrap !important; }
}
```

> B1 若写宽成 `.card { padding: 12px }` 会连 `.card.bg-slate-50`（原图卡，pad-0）一起改；用上面两个 `p-3/p-4` 精确选择器。
> B2 依赖 meddata 的 tailwind 类名（`flex items-center justify-between`）；**若 DataGrid 改类名，本段失效但不会变坏**（退化成改前的挤），断言 G6 会变红，属可发现失败。

### C 批 · P2 可选（**需用户点头**，逐项独立，可只取一条）

```css
@media (max-width: 575px) {
  /* C1 本弹窗从未传 croppedImage（ReportsPanel.jsx:700-719 无该 prop），原图卡永远是 192px 空占位 → 有图才显示 */
  .mb-edit-modal .rb-edit-grid-wrap .card:has(> .card > .h-48) { display: none !important; }
  /* C2 三个大块之间的 16px 间距收到 10px */
  .mb-edit-modal .rb-edit-grid-wrap > div > * + * { margin-top: 10px !important; }
  /* C3 「报告原文」textarea rows=6 的 138px 收到 96px（仍可滚、仍可编辑） */
  .mb-edit-modal .rb-edit-grid-wrap textarea.input { height: 96px !important; }
}
```

实测收益（375，A+B 基线 `body.scrollHeight=1580`）：**A+B+C → 1258（−322px，约 −0.4 屏）**，其中 C1 单项 −276、C2 −20、C3 −42。
C1 风险：`:has()` 需 Safari 15.4+ / Chrome 105+（2026 年移动端无问题）；若将来给本弹窗接上裁剪图，卡片会自动回来（选择器带 `> .card > .h-48` 守卫）。C2/C3 无信息损失，仅可视高度变小。

---

## 3. ③ 单一横向滚动容器怎么落（**审核输入点 2 的前提是错的，必须纠正**）

输入点 2 建议「给 `rb-edit-grid-wrap` 单独 `overflow-x:auto` + body 禁横滚」。**实测不成立**：
`rb-edit-grid-wrap` 里同时装着工具栏、状态 tag 行、原图卡和表格（`DataGrid.jsx:797/890`），wrap 一旦横滚，标题和「智能补项/一键保存」等按钮会跟着滚出屏幕——比现在更难用。

真正的根因（我量的）：`.grid.gap-4.lg:grid-cols-5`（`DataGrid.jsx:890`）在 375 下只有一条**隐式** `auto` 轨道；轨道最小值取子项的 `min-content`，而子项 `min-width:auto`、内含 `table.min-w-[760px]`（`DataGrid.jsx:1127`）→ **轨道被撑到 784px**，两张卡各 784，body 只能横滚 796。表格自带的 `div.overflow-x-auto`（同一行上方）那时宽 760、`scrollWidth==clientWidth`，压根没在滚。

所以正确落法是「**把容器压回可用宽，让表格自带的滚动器接管**」，不是再加一层滚动：

1. `A5` 两条：轨道 `minmax(0,1fr)` + 子项 `min-width:0`；
2. `A4` 给 body `overflow-x: hidden`（**只作护栏**，不是修法——只加它而不改轨道，等于把 784 裁掉、右侧列连滚都滚不到，那是更坏的结果）；
3. 结果（实测）：轨道 784→**335**、`.overflow-x-auto` 变成 760/**311** 的唯一横向滚动容器、`body.scrollWidth==clientWidth==359`。

**对齐怎么保证**：唯一栅格 = `modal.x + 12`。container 归零后 header/body/footer 都只用各自的 12px 侧边，于是 header 标题、body 每个一级子项、卡片外框、footer 末位按钮右边界全部落在 `20` / `355`（实测：`header.title.x = body.kids[0].x = 20`，`kids.right = 355 = footerLast.right`）。卡片内部的 12px 是卡自己的内边距（视觉层级，保留）。
**不要**为了「还原列宽」去写死 `table{width:760px}`——我试过，分布不变（见 §5）。

---

## 4. ② container/body/header/footer/说明行/医院行/DataGrid card 清单

| # | 层 | 现值 | 判定 | 方案 / 依据 |
|---|---|---|---|---|
| 1 | `.ant-modal` padding/margin | `0` / `0 8px` | **必须留** | 8px 视口边距 = 贴顶 y=8 的来源 |
| 2 | `.ant-modal-container` | `20px 24px` | **可删（→0）** | 左右 24 是最大一笔；删掉才有「共享栅格」，不删则 header/body/footer 永远各让 24 |
| 3 | `.ant-modal-header` | `10px 12px` | **可收 + 右侧加宽** | `12px 44px 10px 12px`：左侧 12 进栅格，右侧 44 = X 按钮 32 + 12 间隙 |
| 4 | `.ant-modal-close` | `top:12px` | **必须动** | header 压薄后 X 会探出 2.4px 压到 body 首行上方；`top:8px` 把它收回 header 内（实测 `close.bottom 48 ≤ header.bottom 49.6`） |
| 5 | `.ant-modal-body` | `8px 12px` | **可收（纵向）/ 必须留（横向 12）** | `6px 12px + safe-area`；横向 12 是唯一侧栅格，不许动 |
| 6 | `.ant-modal-footer` | `8px 12px` | **可收** | `6px 12px + safe-area`；按钮 32px 触控高不变 |
| 7 | 说明行（一行 + Tooltip） | 12px 文本 | **必须留** | 信息不丢；实测 375 一行 15px、320 两行 37px，不再压（`ReportsPanel.jsx:686-696`） |
| 8 | 医院行（`Input width:220`） | 220 | **必须留** | 不是 padding；335 下 44+220=264 不挤（`:682-685`）。真要填满改成 `flex:1` 是产品决定，不做 |
| 9 | DataGrid `card p-4` | `16px` | **可收（→12）** | 每卡省横向 8、纵向 8 |
| 10 | DataGrid `card p-3` | `12px` | **保持** | 已经是 12，B1 只是把它写死防回退 |
| 11 | DataGrid 工具栏（`flex justify-between`） | 不折行 | **必须改** | 不折行时按钮组 445px > 311，中文竖排（改前被 784 宽卡掩盖） |
| 12 | 「报告原文」textarea | 138px（rows=6） | **P2 可收** | →96px（C3），−42px |
| 13 | 「脱敏原图」卡 | 252px 卡 / 192px 空占位 | **P2 可删** | 本弹窗永远无图（未传 `croppedImage`），−276px（C1） |
| 14 | 表格 760px 网格 | `min-w-[760px]` | **必须留** | 它是唯一该横滚的内容；砍列/改列=改 meddata 组件（跨项目），延后 |
| 15 | `rb-edit-grid-wrap` inline `maxHeight:58vh; overflow:auto` | 桌面生效 | **必须留** | 移动端已被现有 `max-height:none/overflow:visible !important` 覆盖；不动 JSX，桌面零回归 |

---

## 5. 必须书面接受的一条副作用（实测，不是猜）

轨道收窄后表格仍是 760px 且横滚，但 `table.w-full`（`DataGrid.jsx:1127`）的 `100%` 现在指向 311，列宽按 311 分配后再被 `min-width` 拉到 760 —— 分布与改前不同：

| 列 | 改前 | 改后 |
|---|---|---|
| 序号 | 56 | 65 |
| 标准代码 | 96 | **155** |
| 原始项目 | 192 | 159 |
| **结果（数值输入）** | **71** | **69** |
| 单位 | 87 | 77 |
| 参考范围 | 103 | 91 |

结论：**关键列（结果/数值）几乎不变（71→69）**，代码列更可读，项目列窄 33px（是文本，横滚可见全文）。
我试过 `.rb-edit-grid-wrap table.min-w-\[760px\]{width:760px !important}`「还原列宽」——**实测无效**（分布不变），所以**不要**写死 760 制造与组件 min-width 的耦合。

---

## 6. ④ 验收断言清单（几何判据，不写死快照）

追加到 `tests/verify-edit-modal-375.mjs`（现有 10 条我已跑基线：**10 通过 / 0 失败**，改后仍应全绿，其中「body 内部滚动」只比 `sh>ch`，数值由 1536/668 变 1580/710 不影响）。

| ID | 断言 | 判据 |
|---|---|---|
| G1 | 贴顶 | `modal.y === 8`（±1） |
| G2 | **body 无横向溢出** | `body.scrollWidth <= body.clientWidth + 1` |
| G3 | **正文可用宽** | `body.clientWidth - paddingLeft - paddingRight >= 335` @375；`>= 280` @320（实测 280） |
| G4 | **左边界对齐** | `title.x == body.firstElementChild.x == modal.x + 12`（容差 0.5）；且每个一级子项 `right == modal.right - 12` |
| G5 | **右边界对齐** | footer 末位按钮 `right == modal.right - 12`（实测 355） |
| G6 | **单一横向滚动容器** | `[...body.querySelectorAll('*')].filter(e => getComputedStyle(e).overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1)` **恰好 1 个**，且类名含 `overflow-x-auto`、`scrollWidth >= 760` |
| G7 | 工具栏不竖排 | 工具栏内每个 `button` 高度 `<= 40`（竖排会 > 60），且工具栏 `scrollWidth <= clientWidth + 1` |
| G8 | 关闭按钮不压 body | `close.bottom <= header.bottom`（实测 48 ≤ 49.6） |
| G9 | footer 常驻 + 整页不下滑 | `footer.bottom <= viewportHeight`；`wrap.scrollHeight <= wrap.clientHeight + 1` |
| G10 | **三段 style 并存且 id 唯一** | `ids = [...head>style[id^="mb-report-"]].map(id)`，`ids.length === 3` 且 `new Set(ids).size === 3`，且含 `mb-report-edit-modal-mobile` |
| G11 | **桌面 1440 零回归** | `modal.y === 100 && modal.width === 900`；`.ant-modal-container` `padding === '20px 24px'`；`.ant-modal-body` `padding === '0px'` 且 `scrollHeight === clientHeight`；顶部 `.rb-edit-top-save` 仍可见 |
| G12 | 320 / 414 复跑 | G1–G10 在 320、414 同样成立（本轮已实测：320 → 正文 280、414 → 374） |

`tests/verify-report-lib-ui.mjs:26,102` 的「style id 唯一」断言**不用动**（我们没增删 style 段；G10 是它的窄屏补充）。**禁止**新增第 4 段 `<style>` 来“分开放”，那会让 G10 与 lib-ui 断言双红。

---

## 7. ⑥ 方案与编码的边界（本轮的边界）

- 本轮**只出方案**：我没有改 `ReportsPanel.jsx`、没有改 `lib/**`、没有动 `tests/**`、没有新增仓库内文件；所有验证都是浏览器运行时注入 CSS 量的（脚本在 `/tmp/r13/*.mjs`，一次性、不入库）。
- 作者拿到本判词后：**A 批 + B 批整段替换** `ReportsPanel.jsx:104-121`（注释同步更新为「container 归零 + 单一栅格 + 单一横向滚动容器」），同批把 G1–G12 追加进 `tests/verify-edit-modal-375.mjs`；C 批**等用户点头**再单独一段加。
- 提交纪律：`git add -- web/src/pages/intake/ReportsPanel.jsx tests/verify-edit-modal-375.mjs`（点名，不 `-A`），add 与 commit 连续。
- 卡口：`node tests/verify-edit-modal-375.mjs` 12 条全绿 + `node tests/verify-report-lib-ui.mjs` 仍绿 + `/api/health.head == git rev-parse --short HEAD`。

---

## 8. 逐条回答审核输入的 6 个必答点

1. **container 与 body 各留多少 / 谁归零 / 谁做唯一栅格** → container **归零**（`padding:0`）；唯一水平栅格交给 **body 的 `12px` 左右 padding**，header/footer 各自复制同一个 12（header 右 44 额外让 X）；正文可用宽 287→**335**，左边界 `44→20` 与右边界 `331→355` 三处对齐。作用域全部 `.mb-edit-modal` 且只在 ≤575px（`A1–A5`）。
2. **760px 网格怎么放** → 不是继续 body 横滚，**也不是**给 wrap 加 `overflow-x`（会把工具栏一起滚走）。正解是 `A5` 压回轨道 + `A4` body 禁横滚，让表格自带的 `.overflow-x-auto` 成为唯一横向滚动器；`body.scrollWidth (359) == clientWidth (359)`（G2/G6）。
3. **说明行/医院行/card padding 要不要收** → 见 §4 清单 15 行「可删/可收/必须留」；可删 1 处（container）、可收 6 处、必须留 8 处，其中 **工具栏不折行必须改**（否则只改两层 padding 会立刻暴露成中文竖排）。
4. **三段 style 会不会互覆盖 / 要不要改 lib-ui 断言** → 不会：`.rb-detail *`（drawer，`:47-55`）、`.rb-day-*`（day，`:69-96`）、`.mb-edit-modal *`（本次）三套前缀无交集，实测 head 内 `mb-report-*` 恰 3 段。**不改** `verify-report-lib-ui.mjs`，改为在窄屏测试里补 G10（id 恰 3 且唯一）。
5. **验收断言清单** → §6 G1–G12：几何判据，不写死记录数/份数；含贴顶、无横向溢出、正文宽 ≥335、三处对齐、footer 常驻、整页不下滑、单滚动容器、工具栏不竖排、X 不压 body、三段 style 唯一、1440 零回归（含 container/body padding 值）、320/414 复跑。
6. **方案与编码边界** → §7：本轮纯方案；作者照抄替换 + 补断言；C 批等用户点头；提交点名 + 门禁。

---

## 9. 复跑命令（任何人可重现上面每个数字）

```bash
# 1) 起服务（必须显式 PORT，否则继承 harness 的 3097 → EADDRINUSE）
kill $(lsof -ti :5174) 2>/dev/null; sleep 1.5
PORT=5174 nohup node server.mjs > /tmp/medbrief-server.log 2>&1 &
curl -s 127.0.0.1:5174/api/health | head -c 120; echo; git rev-parse --short HEAD   # head 必须一致

# 2) 现有窄屏断言基线（10 条，改后应仍全绿）
node tests/verify-edit-modal-375.mjs

# 3) 注入式几何复跑（不改源码）：/tmp/r13/F.mjs 以 FCSS=环境变量注入本判词 §2 的 CSS，
#    在 320/375/414/1440 各量一次 before/after（我这次的结果见 §1 表）
FCSS="$(sed -n '/^```css$/,/^```$/p' .agents/edit-modal-1116-review-r1.md | head -30)" node /tmp/r13/F.mjs
```

---

## 10. 顺带提醒（不阻塞，编码时照做）

- 现有注释 `ReportsPanel.jsx:98-103` 写的「修法：…」要跟着改成「container 归零 + 单一栅格 + 单一横向滚动容器」，否则下一轮会话会照着旧注释再解一遍。
- `.rb-edit-grid-wrap` 的 inline `maxHeight:'58vh'` 在移动端是被 `!important` 顶掉的死代码——**别删**（桌面靠它），但注释里写清「桌面专用」。
- 375 下 body 内部滚动是设计（`sh 1580 / ch 710`），不是缺陷；判据只写 `sh > ch`，**不要**改成「一屏放下」，那是 C 批之后也做不到的（C 批后仍 1258）。
