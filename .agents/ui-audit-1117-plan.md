# 全站 UI 巡检 —— 优化点清单 + MVP 计划 **v0.2**（UI 设计师，2026-11-17）

> 触发：用户「你让 UI 设计师查看每个页面，整理优化点。然后将图和计划一起，走 AI 审核流程」。
> **v0.2 依据**：`.agents/ui-audit-1117-review-r1.md`（AI 审核 r1，总判`不能直接进下一轮`，5 条 P0）+ `.agents/ui-audit-1117-r1-ruling.md`（主理人裁定 `148d820`）。
> **本版改了什么**：① 补 8 张图（含**真实图片 blob** 的弹窗 + 滚到卡区的趋势截图 + 旋转态 + 无原件对照）；② 按裁定把 A5 七项与 4 条图面回归补进清单（U15–U23）；③ MVP 拉回 **U6、U13**；④ 新增 **§5 P0-1…P0-5 关闭台账**。
> 性质：**只出图 + 清单 + 计划**；未改任何代码、未改设计文档。
> **实测快照**：实现提交 **`09e16c9`** + 门禁 **`760783c`**，文件 md5 `SourceModal=907a0bc3` / `TrendsTab=d255f33c` / `CardPage=653b9050` / `AccountAdminPage=f165b037`（2026-11-17 20:19–20:21，独立实例 + 真实图片 blob 夹具）。
> ⚠️ 清单里的"现测"绑定 `09e16c9` 与这组 md5；文件再被改即须重测，不许沿用。

---

## 1. 页面与截图索引（34 张，`.agents/ui-audit-1117/shots/`）

| 编号 | 页面 / 弹窗 | 375×812 | 1440×900 | 备注 |
|---|---|---|---|---|
| 01 | 登录页（未登录态） | `01-login-375.png` | `01-login-1440.png` | 无 cookie 现场 |
| 02 | 资料录入 `IntakePage` | `02-intake-375.png` | `02-intake-1440.png` | 空态 + 提示条 |
| 03 | 报告库 `ReportsPanel` | `03-reports-375.png` | `03-reports-1440.png` | 23 行真实报告 |
| 04 | 资料卡 · 临床指标总览 | `04-card-overview-375.png` | `04-card-overview-1440.png` | P0-5 现场（「生成中」裁切） |
| 05 | 资料卡 · 动态趋势看板 | `05-card-trends-375.png` | `05-card-trends-1440.png` | 首屏（可选指标区），r1 指出**拍不到卡** |
| **05b** | 同上 · **滚到卡区**（v0.2 新增） | **`05-card-trends-375-cards.png`** | **`05-card-trends-1440-cards.png`** | 复核 U1/U15 用；375 图可见标签叠字 |
| 06 | 资料卡 · 全病程原件轴 | `06-card-timeline-375.png` | `06-card-timeline-1440.png` | 23 条 |
| 07 | 病历交换包 `BriefPage` | `07-brief-375.png` | `07-brief-1440.png` | 空态 |
| 08 | 出诊监控 `MonitorPage` | `08-monitor-375.png` | `08-monitor-1440.png` | 空态 |
| 09 | 挂号与预约 `BookingPage` | `09-booking-375.png` | `09-booking-1440.png` | 3 条 alert |
| 10 | 114 会话 `SessionPage` | `10-session-375.png` | `10-session-1440.png` | — |
| 11 | 账号管理 `AccountAdminPage` | `11-accounts-375.png` | `11-accounts-1440.png` | P0-3 现场（改前 103px 溢出） |
| 12 | 原件溯源弹窗 · **空态**（原 26 张里的那张） | `12-modal-source-375.png` | `12-modal-source-1440.png` | r1 A8：空态天然对齐，**不足以验 U2/U4** |
| **12b** | 同上 · **含真实图片原件 blob**（v0.2 新增） | **`12-modal-source-375-with-blob.png`** | **`12-modal-source-1440-with-blob.png`** | 夹具：真原件 `data/intake/p1/archive/page-1.png`（662KB）拷进临时库 |
| **12c** | 同上 · **无原件紧凑占位**（v0.2 新增，对照） | **`12-modal-source-375-noblob.png`** | **`12-modal-source-1440-noblob.png`** | 验"无原件隐藏缩放/旋转 + 占位 ≤120px" |
| **12d** | 同上 · **旋转 90° 态**（v0.2 新增） | **`12-modal-source-375-rotated.png`** | **`12-modal-source-1440-rotated.png`** | 验 U23：图上左右被裁 |
| 13 | 打印预览弹窗 | `13-modal-print-375.png` | `13-modal-print-1440.png` | P1（原）→ 已拉回 MVP |

> 采集口径（可复跑）：独立实例 `PORT=5194/5195/5196/5198`、`MEDBRIEF_AUTH=on` + 自建 admin `13200000009`、`MEDBRIEF_REPORTS_FILE` 指向 **复制到 `$TMP` 的 `reports.json`**（真库零写入）、`MEDBRIEF_DATA_DIR=$TMP/data`（内含 `intake/patient.json` 副本 + 注入的图片 blob）。其余 26 张沿用 v0.1 采集（r1 已成功读图，**不重拍**）。

---

## 2. 优化点清单（每条带实测数；`改前` → `现测`→`目标`）

### 2.1 P0 与已修项

| 编号 | 页面:元素 | 现象 | 实测数 | 严重度 | 改法（文件:行） |
|---|---|---|---|---|---|
| **U1** | 趋势看板 · 卡网格 | 375 卡被压成竖条 | **改前** 9 轨×28.33 / 卡 28×1255 / svg 2px / 点列表 2px×869 → **现测** 1 轨 / 卡 351×272 / svg 325×158 / 点列表 325×34(clamp='2') → 1440 3 列 403×259 | **P0** | `CardPage.jsx:54` 把 `min(320px,100%)` **统一成 `min(380px,100%)`**；`TrendsTab.jsx:205` 已同口径（规格 §1.1） |
| **U2** | 原件溯源弹窗 · 内距 | 每侧两级内距叠加、三缘不齐 | **改前** 12+8=20（r1 图累计 32）→ **现测** 375 累计 **12**、三缘极差 **0**；**1440 累计 24（标题 36）** ← 未达标 | **P0** | `SourceModal.jsx:172-178` 加 `content:{padding:0}`（antd `.ant-modal-container` 默认 `20px 24px`）⇒ 1440 也到 12 |
| **U3** | 账号管理（375） | 页面横向溢出 | **改前** scrollW 478−375 = **103px**、手机号压成 11 行竖排 → **现测** scrollW **375 = innerW**、最高单元格 **41px**、被裁单元格 **0** | **P0** | 已按 `AccountAdminPage.jsx:78-79/92` 落 `white-space:nowrap`+`overflow-x:auto`+`scroll={{x:'max-content'}}`；**验收口径见 U20** |
| **U4** | 原件溯源弹窗（375/1440） | 弹窗高超出视口 | **改前** dlg.h **1598**（视口 812）→ **现测 748**（375，仍 >716）/ **930**（1440，> 视口 900） | **P0** | `SourceModal.jsx:177` body `maxHeight` 改 `calc(100dvh - 96px)` 且 `≥576` 也加限高（规格 §2.2） |
| **U5** | 全局顶栏 | 触控热区 <44 | 「打开导航菜单」**28×24**、「退 出」**41×24**、「日志」**46×24** | **P1** | `App.jsx` 顶栏按钮 `::before` 外扩到 44（视觉不变） |
| **U6** | 打印预览弹窗 | 左右各 36px（24 antd + 12 body），修前双侧浪费 72px = 375 的 19.2% | 375：`iframe` 左缘 54.8 / modal 左缘 18.75 ⇒ **36px/侧** | **P1 → 拉回 MVP** | `CardPreview.jsx:67-80` 窄屏 `100vw` + `padding:0`（工作树已在改，需复测 36→0） |
| **U7** | 趋势刻度 | 渲染高 8px（<10 可读口径） | 改前 375 **8px** / 1440 10px → **现测 375 9.18px / 1440 10.64px** | **P1** | `TrendsTab.jsx:129/143/148` 已 `fontSize="13"`；判据按**渲染实测 ≥9** |
| **U13** | 登录页（375） | 2 个按钮 <44 | 改前 `<44px` **2 个** → 现测 `LoginPage.jsx:38` `height:44` | **P2 → 拉回 MVP** | 已落，待门禁断言 |

### 2.2 v0.2 新增（r1 图面回归 + A5 七项）

| 编号 | 页面:元素 | 现象 | 实测数 | 严重度 | 改法（文件:行） |
|---|---|---|---|---|---|
| **U15** | 趋势 SVG · 文字叠字 | 数据点标签与参考刻度互相压字（r1 A1-③；1440 上 `3.5-9.5` 压 `4.66`） | 375：相交 **11 对**（样本 `79.67×71.90`、`8.78×3.27`、`3.27×0.04`）；1440 同样 **11 对**；字号本身达标（9.18/10.64） | **P1** | `TrendsTab.jsx:143` 点数 >6 只标首/末/极值；`:129` 参考标签与曲线点最小间距 12px，不足则隐去（规格 §1.5）。门禁 `A3` 只比参考刻度×点值，**漏点值×点值** ⇒ 现测 11 对仍 PASS，见 §5.1 |
| **U16** | 弹窗高度写法 | `100vh` 在 iOS 把地址栏算进去，底部按钮被遮 | `SourceModal.jsx:177`、`CardPreview.jsx:106` 各 1 处 `calc(100vh…`；`SourceModal.jsx:162/219` 已是 `100dvh` | **P1（随 U4 同批）** | 全部换 `100dvh`（规格 §2.2） |
| **U17** | 刘海屏安全区 | 吸底操作条未避让 Home Indicator | 全站 `env(safe-area-inset-bottom)` **4 处**（`CardPreview.jsx:80`、`ReportsPanel.jsx:139/141`、`UploadPanel.jsx:58`）；**SourceModal footer 0 处** | **P1（随 U4 同批）** | 弹窗 body/footer 加 `paddingBottom:'env(safe-area-inset-bottom, 0px)'` |
| **U18** | 软键盘遮挡 | 只测了静态 812px 高 | **未测**（本轮无覆盖）：登录 / 报告库搜索 / 新建账号弹窗在 `visualViewport.height ≈ 400` 时输入框与提交按钮可达性 | **P1** | 判据：`rect.bottom ≤ visualViewport.height`；测法 `page.setViewportSize({height:400})` + `visualViewport` 监听 |
| **U19** | 趋势圆点热区 | 触摸端圆点半径过小，手指点不中 | `circle r=5` ⇒ 命中 **7px**；`r=2.2` ⇒ **3px**；全页 **73 个**圆点 | **P1** | 加透明命中层 `circle r=22`（44 直径）覆盖，视觉 `r` 不变（规格 §4） |
| **U20** | 表格 nowrap + min-width | 只加 `overflow-x:auto` 不够，列会被压成竖排（U3 的实质口径） | 账号页现测：页面 `scrollW 375 = innerW`、最高单元格 **41px**；注入 `nowrap + min-width` 后**表内**横滑 `801 / 319`（页面仍 375） | **P1（U3 验收口径）** | `AccountAdminPage.jsx:78-79`（已落）；同法排查 `SourceModal` 右栏表、08/09/10 有数据态表 |
| **U21** | viewport 与输入框放大 | iOS 点 <16px 输入框会整页放大 | `index.html:5` / `web/index.html:5` viewport **缺 `viewport-fit=cover`**；375 下输入框 **81 个**，最小字号 **14px** | **P2** | viewport 补 `viewport-fit=cover`；移动档输入框 `font-size ≥16px` |
| **U22** | 横向 Tab 与局部裁切 | 页签放不下时「全病…」截断 + 紧贴「…」按钮 | 页签 `nav-list.scrollWidth **405**` vs `nav-wrap.clientWidth **305**` ⇒ 溢出 **100px** | **P2** | 允许横滑（已有）但要显式指示 + 当前页签 `scrollIntoView({inline:'center'})`；或窄屏把三个页签改成 `Segmented` 图标档 |
| **U23** | 原件弹窗 · 旋转 90° | 旋转后图片**左右被裁**且滚不到（`transform` 不改布局盒；容器 `justify-content:center` 把溢出平分，左侧进负溢出区） | 旋转后 img 布局盒 **494×349**（原 349×494），预览容器 `scrollWidth **421** < 视觉宽 494` ⇒ 左侧约 **73px** 不可达（见 `12-modal-source-375-rotated.png`） | **P1** | 旋转时容器 `justifyContent:'flex-start'` + `img` 按宽高互换给尺寸（规格 §2.5） |

### 2.3 原清单保留项（未变）

| 编号 | 项 | 实测数 | 严重度 | 现状 |
|---|---|---|---|---|
| U8 | 圆角混用 | 05 页 `6px×17 / 10px×11 / 8px×2` | P1 | 延后（触发：MVP 落地后做一次 token 盘点） |
| U9 | 报告库小字/小热区 | 26 处 <12px 正文、51 处 <44 热区 | P2 | 延后（触发：真机点不中被点名） |
| U10 | 总览小热区 | 198（375）/197（1440） | P2 | 延后（同 U9） |
| U11 | 点列表 clamp 口径 | 改前 `webkitLineClamp='none'` → 现测 **'2'**，`scrollHeight 34 = clientHeight 34` | P2 | **已对齐**（规格 §1.6 判据已按 clamp + scrollHeight 双条写） |
| U12 | 空态引导 | 07/08/09 各 1 个 `ant-empty` 无下一步 | P2 | 延后（触发：新用户反馈） |
| U14 | 页面级 alert 数量 | 09 页 `ant-alert` = 3 | P2 | 延后（触发：下一轮巡检） |

---

## 3. 三档裁定（留 / 砍 / 延后+触发条件）

| 裁定 | 项 | 理由 |
|---|---|---|
| **留（MVP）** | **U1 · U2 · U3 · U4 · U5 · U6 · U7 · U13 · U15 · U23**（+ U16/U17/U20 随各自条目同批落地） | U1/U2/U3/U4 是 r1 的 P0；**U6/U13 按裁定拉回**（U13：拿 44 硬线收顶栏却放过唯一入口页＝标准自相矛盾；U6：双侧浪费 72px = 375 的 19.2%，且直接对应用户约束 1）；U15/U23 是本轮图上明确可见的破版（叠字、旋转裁切） |
| **砍** | 「统一设计系统 / 重构卡片体系 / 换图库」类 | 用户明确不要越界项，与本轮缺陷无因果 |
| **延后（+触发条件）** | U8（触发：MVP 后 token 盘点）· U9/U10（触发：真机点不中被点名）· U12（触发：新用户首次进入这三页的反馈）· U14（触发：下一轮巡检）· U18（触发：真机软键盘遮挡被报，或 iOS 专项）· U19（触发：真机点圆点选中失败）· U21/U22（触发：iOS 输入框自动放大 / 页签点不中被报） | 都是"改善"而非"不可用"；U9/U10 涉及 51–198 个存量节点，一次铺开风险大于收益；U18 需要 iOS/真机环境，当前 headless 无法等价 |

---

## 4. MVP 范围与验收数（交单写者一次做完）

1. **U1**：`CardPage.jsx:54` 口径统一 `min(380px,100%)` + 卡头零遮挡 + 「生成中」不裁。
2. **U2**：弹窗**累计内距 12±1**（含 `.ant-modal-container` padding 归零）、三缘极差 ≤1。
3. **U3**：账号页 375 溢出 **103 → 0**（+ nowrap/min-width 口径 U20）。
4. **U4**：`dlg.h` **1598 → ≤716**（375）/ **930 → ≤ innerHeight−8**（1440），`100dvh`。
5. **U5**：顶栏三按钮热区 **24 → 44**。
6. **U6**：打印弹窗每侧 **36 → ≤12**（`100vw` + `padding:0`）。
7. **U7**：趋势刻度渲染 **8 → ≥9**（现测 9.18 ✅）。
8. **U13**：登录页按钮 **<44 → 44**（已落 ✅）。
9. **U15**：SVG 文字相交对 **11 → 0**。
10. **U23**：旋转后 `preview.scrollWidth` **421 → ≥ 视觉宽−1**。

**门禁**：`tests/verify-card-mobile-layout.mjs` 已存在并注册（`package.json:23-24`，`test:ui-audit` 与 `test:card-mobile-layout` 同一条命令），我复跑 **25/0 exit 0**；但其中 3 条判据口径弱于 r1、另缺 3 条（无原件隐藏 / 「生成中」不裁 / 旋转不裁），**必须先按规格 §3 改写再算绿**（明细 §5.1）。**未被现有门禁覆盖的四项**：**U6 打印弹窗**（`grep -n '打印\|CardPreview' tests/verify-card-mobile-layout.mjs` = 0 命中）、**U13 登录页按钮**（`M_TOUCH` 只查 `.mb-nav-trigger/.mb-logout/.mb-log-btn` 三个顶栏元素，未开未登录上下文）、**U23 旋转不裁**、**无原件隐藏 / 「生成中」不裁**。这四项需落到 `tests/verify-ui-audit-1117.mjs`（**尚未存在**）；落地前置：`grep -n 'test:card-mobile-layout' package.json`、`grep -n 'test:ui-audit' package.json` 必须命中，且 `ls tests/verify-ui-audit-1117.mjs` 命中。

---

## 5. **上轮 P0 关闭台账**（r1 → v0.2；快照 md5 见文首）

> 口径：`✅`= 本快照实测达标（附数与可复跑命令）；`❌`= 本快照仍不达标；`⏳`= 代码已改但本轮**未能实测复现**（不冒充通过）。

| r1 判词 | 落点（规格 / 代码） | 本快照实测 | 判定 |
|---|---|---|---|
| **P0-1** 趋势页 `Card.extra` 遮挡「可选指标」标题（只剩「可」字） | 规格 **§1.2**；代码 `CardPage.jsx:30/34-37`（head/wrapper 换行）+ `TrendsTab.jsx:170-186`（工具组 `wrap`） | 「可选指标」卡头高 **53px**、标题 `x=25 w=325`、工具组 `x=25 y=+28`、**交集 0**、`head.scrollWidth=clientWidth=349`；趋势卡 `title∩extra` **0**（head 51px）。图：`05-card-trends-375.png`（首屏）/`05-card-trends-375-cards.png`（卡区） | **✅** |
| **P0-1b** `05-card-trends-375` 拍不到趋势卡、无法证实 U1 | 本版补 `scrollIntoView` 截图 | `05-card-trends-375-cards.png`：单列、卡 351 宽、点列表 2 行 + `共 N 次` | **✅（图已补）** |
| **P0-2** 工具栏强排一行把「旋转 90°」裁断 | 规格 **§2.3**；代码 `SourceModal.jsx:199` | 375：5 按钮 `−/＋/适宽/适高/旋转`，`scrollWidth=clientWidth=351`、`clippedPx = 0` | **✅** |
| **P0-2b** 内容左缘距屏 32px ≠ 12px | 规格 **§2.1**（判据重定义为**累计内距**）；代码 `SourceModal.jsx:172-178` | 375：`dlg.x=0`、`leftCol.x=0`、`leftPad=12` ⇒ **累计 12**；**1440：容器 padding `20px 24px` ⇒ 累计 24 / 标题 36** | **⚠️ 375 ✅ / 1440 ❌**（`.ant-modal-container` 仍 `20px 24px`）；**实现方门禁 `L6b` 却 PASS** —— 它用 `bodyPad+leftPad` 口径（r1 已否决），见 §5.1 |
| **P0-2c** 无原件夹具掩盖缩放/旋转 | 本版补真实 blob 夹具（真原件 662KB） | `12-modal-source-375-with-blob.png` / `-1440-with-blob.png` / `-rotated.png`；实测 img **349×494**（natural 1654）、预览 **351×592** | **✅（夹具已补）** |
| **P0-3** 账号页 375 溢出 103px、手机号 11 行竖排 | 规格 **U20**；代码 `AccountAdminPage.jsx:78-79/92` | 现测 `scrollWidth 375 = innerWidth`、最高单元格 **41px**、`clippedCells 0`；注入 `nowrap+min-width` 后表内横滑 `801/319` | **✅** |
| **P0-4** 弹窗 1598px（视口 812）、空态占位吃 500–600px | 规格 **§2.2 / §2.4**；代码 `SourceModal.jsx:177/219` | 有原件：**748**（375）/ **930**（1440）；无原件：`preview` **96/120**、`Empty` **70** | **⚠️ 高度仍超**（748 > 716；930 > 视口 900）；**空态已压到 ≤120**；门禁 `L11` 只判 `≤vh` 且不测 1440 ⇒ 掩盖，见 §5.1 |
| **P0-5** 04/05 页「生成中」被垂直裁半 | 规格 **§1.3**；代码 `CardPage.jsx:31-33/38` | 代码已改 `extra{overflow:visible}` + `.ant-spin-text{line-height:1.5}`；**本快照未复现「生成中」状态**（`gen: []`，只在加载瞬间出现） | **⏳ 未实测复现**（不声称通过；判据 L15b 已落规格，下一轮真机/加载态复核） |
| 边界① 工作树带回归不能提交 | — | 本快照实测：遮挡 **0**、工具栏裁切 **0**、账号页溢出 **0**；仍存 1440 累计内距 24、弹窗高 748/930、标签叠字 11 对、旋转裁 73px | **部分解除**（上述 4 项修完才可提交） |
| 边界② 无原件夹具不可接受 | — | 已补 blob 夹具（见 P0-2c） | **✅ 已解除** |
| 边界③ 1440 为 3 列 | 规格 **§1.1** | 1440：容器 1232 ⇒ **3 列 × 403**；`320/768` 两套数字已从规格删除 | **✅ 已统一口径** |
| **A5 七项漏测** | 规格 **§4**；清单 **U16–U22** | 已补判据与现测：`100vh` 残留 2 处、safe-area 4 处（弹窗 0）、圆点热区 7/3px、表 nowrap 已落、viewport 缺 `viewport-fit`、输入框最小 14px、页签溢出 100px、软键盘**未测** | **✅ 已进清单**（U18 明确标未测） |

### 5.1 实现方门禁复跑：**25/0 绿，但 3 条判据口径弱于 r1 ⇒ 判不合格**

`npm run test:card-mobile-layout` → **25 通过 / 0 失败，exit 0**（我复跑，非转述）。绿得对的部分：工具栏不裁、卡头零遮挡、账号页 0 溢出、点列表 `clamp='2'`、刻度渲染 ≥9、375 累计内距 12、触控 44。但三条判据被写弱了（`tests/verify-card-mobile-layout.mjs`）：

| 门禁 | 它的实现 | r1/裁定要求 | 本快照实测 |
|---|---|---|---|
| `L6b 1440 每侧内距 12±1`（`:320`，口径来自 `:163` `insetPerSide=bodyPad+leftPad`） | 只加 body+左栏，**不含** `.ant-modal-container` | 从 `[role=dialog]` 可视左缘量到内容左缘 | 1440 真值 **24**（标题 **36**）⇒ 门禁 PASS 是假绿 |
| `L11 弹窗总高`（`:260`，`modalH <= vh+1`，只测 375） | 阈值是视口而不是 `716`，且 1440 无此断言 | `≤716`（812−96）+ 1440 `≤vh−8` | 375 现测 **748**（>716 但 <812）PASS；1440 **930 > 900** 未测 |
| `A3/A3b 零叠字`（`:235/:307`，只统计 `refVsValOverlaps`） | 只比"参考刻度 ∩ 点值标签" | 所有 `svg text` 两两 bbox 不相交 | 点值×点值 **11 对**相交（`79.67×71.90`、`8.78×3.27`…）⇒ 漏判 |

**要求（给单写者）**：把这三条判据按规格 §3 的 L7 / L12 / L13 改写（累计内距、`100dvh` 阈值、全量 text 两两相交），并补三条缺失判据：`L14b`（无原件时缩放/旋转按钮数 = 0、`preview.h ≤120`）、`L15b`（「生成中」不被裁）、`L16`（旋转 90° 横向不裁，现测 421 < 494）。补完才算真绿。

**复跑命令（审核者核对用）**
```bash
cd /Users/scallion/Documents/projects/MedBrief
git status -sb && md5 -q web/src/pages/card/{SourceModal,TrendsTab}.jsx web/src/pages/CardPage.jsx
ls -lh .agents/ui-audit-1117/shots/ | grep -E 'cards|blob|rotated'
grep -n "min(320px" web/src/pages/CardPage.jsx          # 期望：无命中（口径已统一 380）
grep -n "calc(100vh" web/src/pages/card/SourceModal.jsx  # 期望：无命中（全部 100dvh）
grep -c "padding: 0" web/src/pages/card/SourceModal.jsx
```

---

## 6. 审核者按图核的指引（v0.2 更新）

- **`05-card-trends-375-cards.png`**（新增）：应是**单列满宽卡**；卡内数值标签**不得互相压字**（r1 指出的 U15 现测 11 对，请看这条是否仍复现）。
- **`05-card-trends-375.png`**（首屏）：`可选指标` 四个字完整可见、下方工具组独行不遮标题。
- **`12-modal-source-375-with-blob.png`**：真实 A4 原件；标题 / 工具栏 / 原件**左缘同一条线**；左右**只剩 12px**（改前累计 32）；工具栏 5 个按钮完整。
- **`12-modal-source-375-rotated.png`**（新增）：旋转 90° 后**左右被裁**（U23 现场）。
- **`12-modal-source-375-noblob.png`**（新增）：无原件时占位压成**一条 ≤120px** 提示，且**不出现**缩放/旋转按钮。
- **`11-accounts-375.png`**：现测已无横向溢出（改前 103px）；若右缘仍截断即为回归。
- **`13-modal-print-375.png`**：左右留白各 36px（U6，本轮进 MVP）。

---

## 7. 已知边界（v0.2 更新）

1. **快照已固定**：实现 `09e16c9`、门禁 `760783c`，md5 `907a0bc3/d255f33c/653b9050/f165b037`；文件再被改即须重测，不得沿用本版数字。
1b. **门禁假绿**：见 §5.1 —— 25/0 里有 3 条判据口径被写弱（累计内距、弹窗高、全量叠字），**不许拿这 25/0 当验收结论**。
2. **「生成中」状态未复现**：该标签只在资料卡加载瞬间出现，本轮采集（等待 1.5–2.5s 后取图）已加载完，`gen: []`。P0-5 以代码级改法 + 判据 L15b 兜底，**不声称实测通过**。
3. **P0-2 在 1440 未达标**：`.ant-modal-container` 默认 `padding:20px 24px` 使累计内距 24（标题 36）；375 达标是官方 CSS 在窄屏把该 padding 归零的结果，**不等于规格已满足**。
4. **软键盘项（U18）未测**：headless 无 iOS 软键盘等价物，只能给可复跑判据，不能声称验证。
5. **A5 的 `100dvh` 只解决"高度算错"，不解决地址栏动画中间态**；真机仍需一次人工确认。
