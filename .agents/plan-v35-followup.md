# 实施计划 · 问诊卡工作台收尾（v3.5 之后）

> 制定人：代诊-Manager（MedBrief 项目负责人）｜2026-11-14
> 基线：`HEAD a801943`（工作台三批 + 前置修复已入库）｜服务 `PORT=5174 node server.mjs`
> 用途：把剩余活拆成**可独立派单的任务卡**，交给外包池（读工/写工）或空闲下属 Bot 执行。
> 每条卡都自带：`request_id`、项目绝对路径、可写白名单、完成标准、禁止事项、验收命令。

---

## 0. 铁律（派单前必读，写工尤其）

> **0.0 只读工的执行边界（2026-11-14 裁决）**：只读 = **不改项目文件、不做 git 写、不启/重启服务**。
> 允许写 **`/tmp/<request_id>/` 下的一次性取证产物**（PDF/截图）。
> 「不许读 `data/reports.json`」的本义是**不许把患者内容写进报告**，不是禁止工具读取它 ——
> 页高/页数这类门禁数字必须在**真实库**上跑才有意义（快照 54 份 ≠ 真实 55 份）。


1. **一个文件只有一个 owner。** 见 §1 所有权矩阵；跨出白名单即视为违约，我直接回退。
2. **禁 `git add -A`**；只 `git add` 白名单内的文件。提交前 `git status --short` 逐行核对，
   白名单外的 `M`/`??` 一个都不许进本次提交。
3. **禁碰真实病历数据**：`data/reports.json`、`data/intake/` 一律只读。要验证写入路径 → 用合成数据或副本。
4. **禁改打印件**：`lib/intakeCard.js` 的 `renderHtml()` 输出（3 页 A4 HTML）任何改动都必须经我批准；
   门禁 `node tools/card-pdf.mjs` 是唯一真凭据（第 1 页 ≤1054px、总页数 ≤3、重叠/裁切 0 处）。
5. **别人未提交的脏文件不许碰**（当前：`lib/reportIntake.mjs`、`lib/blobStore.mjs`、`server.mjs`、
   `web/src/pages/intake/ReportsPanel.jsx`、`mcp/intake-server.mjs`、`INTERFACE.md`、`.gitignore`、`package.json`）。
   若必须改其中文件 → 停下问我，用单 hunk 暂存（`git apply --cached --recount`）由我操作。
6. **改前端必须重建**：`MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web`，
   否则你改的 JSX 不会出现在 5174 页面上（`web/dist-next` 才是被托管的那份）。
7. **服务重启纪律**：改了 `lib/**` 后必须重启服务才生效 ——
   `pkill -f "node server.mjs"; sleep 1; PORT=5174 nohup node server.mjs > /tmp/medbrief-server.log 2>&1 &`
   （环境里 `PORT` 可能残留 3097，会和 DSH GUI 撞端口）。

---

## 1. 文件所有权矩阵（当前）

| 范围 | 文件 | Owner | 状态 |
|---|---|---|---|
| **卡片线（本计划的主战场）** | `lib/intakeCard.js`、`lib/cardPolicy.mjs`、`lib/labClean.mjs`、`lib/leukemiaChecklist.mjs`、`web/src/pages/CardPage.jsx`、`web/src/pages/card/*`、`web/src/pages/intake/{CardPreview,PatientForm,shared}.js(x)`、`tests/verify-{card,labclean,workbench,rowpatch,checklist}.mjs`、`tools/card-pdf.mjs`、`docs/问诊卡逻辑.md` | **代诊-Manager（我）** | 干净，可派工 |
| 报告整合线 | `server.mjs`、`lib/reportIntake.mjs`、`lib/blobStore.mjs`、`lib/reportClassify.mjs`、`web/src/pages/intake/ReportsPanel.jsx`、`mcp/intake-server.mjs` | 代诊-报告 | **在动**（脏） |
| 114 挂号线 | `lib/egoDriver.js`、`lib/catalogStore.js`、`docs/114-guahao-playbook.md` 等 | 代诊-挂号 | 空闲 |
| 跨线公共 | `package.json`、`INTERFACE.md`、`.agents/*` | 共享，改动需我确认 | 脏 |

---

## 2. 任务卡

### W1 ·【只读】工作台与卡片口径体检（派：外包仔·混元三）

- `request_id`: `medbrief-w1-card-audit-1114`
- 路径：`/Users/scallion/Documents/projects/MedBrief`
- 可写白名单：**无**（纯只读；只回文字报告）
- 做什么：
  1. 跑全部门禁并逐条记录数字：`unit 23 / intake 23 / card 58 / labclean 23 / checklist 8 / codealias 5 / rowpatch 4 / workbench 10 / pdf 6 / ui / e2e 6`（命令见 §3）。
  2. 跑 `node tools/card-pdf.mjs`，记录第 1/2/3 页高度、总页数、重叠裁切数。
  3. 逐条比对 `docs/问诊卡逻辑.md` §2.5–§2.11 的口径与**实现**，找不一致（每条给 `文件:行`）。
     重点查：① 危急阈值是否与 `lib/cardPolicy.mjs:CRITICAL_RULES` 一致；② 第 2 页折叠规则
     （`lib/intakeCard.js` 的 `foldMicro`）是否与文档「项数守恒」口径一致；③ 体检条 5 项判定
     （`lib/leukemiaChecklist.mjs`）是否与文档 §2.10 表格一一对应。
  4. 列出「文档有、实现没有」和「实现有、文档没写」两类条目。
- 完成标准：回一份 Markdown，含 **① 门禁数字表 ② PDF 数字 ③ 偏差清单（每条带 文件:行 + 一句话）**；
  条数为 0 也要明确写「0 条」。
- 禁止：改任何文件、跑 `git` 写操作、启动/重启服务。

### W2 ·【已完成 2026-11-14，`1e43b65`】趋势图 Y 轴刻度与点值标签重复

- 交付：`TrendsTab.jsx −1`、`SourceModal.jsx −3`（删两处 Y 轴刻度 `<text>`，3 条网格线 + 点值标签保留）；
  `verify-workbench +26`（源码断言：`ticks.map` 块里必须有 `<line>`、不得有 `<text>`，且**找不到块要报错**防空过）。
- 验收：恰 3 文件无夹带；workbench 12/12；card-pdf 3 页零重叠；
  **我做了反例验证**（把刻度 `<text>` 塞回去 → 11 通过/1 失败），证明断言非空转。
- 排面偏差：派单时基线 10 条，并发已到 11 条 → 交付 12 条（未改别人的断言）。

### W2-原卡（历史留档）

- `request_id`: `medbrief-w2-trend-ticks-1114`
- 路径：`/Users/scallion/Documents/projects/MedBrief`
- 可写白名单：`web/src/pages/card/TrendsTab.jsx`、`web/src/pages/card/SourceModal.jsx`
- 问题（实测）：`TrendsTab.jsx:28` 的 `ticks.map` 会画 Y 轴刻度文字，`:46` 又给每个点写了值，
  最大值/最小值时同一数字在图里出现两次（如 `79.67`、`3.27` 各两次），1440px 截图可见。
- 修法（按此执行，别自创）：**Y 轴只保留网格线，去掉刻度文字**；点值标签保留（每点都有值，量级已可读）。
  网格线保持 3 条（min/中/max），颜色 `#f0f0f0`、`strokeWidth 0.8` 不变。
- 完成后必须：
  1. `MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web`
  2. 截图（1440×950）存 `/tmp/w2-trends.png`，用 `read_image` 自检：「同一张图里不存在两个完全相同的数值文本」。
  3. 新增断言到 `tests/verify-workbench.mjs`：**解析 `TrendsTab.jsx` 源码，不得出现把 `ticks` 渲染成 `<text>` 的写法**
     （即 `<text` 与 `ticks` 不得出现在同一 map 里）；跑 `node tests/verify-workbench.mjs` 绿。
- 完成标准：三条命令全绿 + 截图自检结论 + 提交（只 add 白名单两个文件 + 断言文件）。
  提交信息格式：`fix(card): 趋势图去掉重复的 Y 轴刻度文字`。
- 禁止：改 `lib/**`、改 `CardPage.jsx`、改打印件、改 `data/**`。

### W3 ·【已完成 2026-11-14，`580e3c9`】工作台 375px 移动端

- 交付：`CompactRows` 窄屏单栏 + 隐藏「参考」、p0/病程表次要列 `responsive:['md']`、趋势网格 `minmax(380px)→minmax(0,1fr)`、
  `SourceModal` 两栏 `minWidth:0` + 窄屏堆叠、`CardPage` 注入 ≤575px 样式（挂载生效、卸载 `style.remove()`）。
- **没碰 `App.jsx`**：顶栏「事件日志」在 375 撑到 435 的问题，用 CardPage 内的窄屏样式解（比改共享壳安全）。
- 验收（我复跑）：375 三 Tab + 打印弹窗全 `scrollWidth=375`；1440 `scrollWidth=1440` 布局不变；`card-pdf` 3 页零重叠；恰好 6 文件。
- **遗留 UX（W3b / W10）**：① Tab 栏在 375 下位于 y≈1008px → W3b 吸顶；
  ② 左侧 Sider 压成 56px 且竖排文字 → W10，属 `App.jsx` 全局壳，需先定手机端导航形态。
  ③ **W3 的顶栏修法有副作用**：`flex-wrap: wrap` 让 header 在 375 下高度 **468px**（414 下 276px），
  一屏 812px 被吃掉 58%（截图 `/tmp/h375.png`：副标题竖排成单字）→ 拆成 **W3c** 单独派单处理，
  硬断言 **header 高度 ≤ 80px 且 scrollWidth ≤ 375 同时成立**（详见下方 W3c）。

**教训（写死）**：修「横向溢出」不能靠让容器换行 —— 会把问题变成「纵向吞噬」。**数字达标 ≠ 体验达标，
改完必须看一眼成品截图**（这只写工自己都量到了 468px 却没把它当问题）。

### W3b ·【已完成 2026-11-14，`5d907aa`】375 下 Tab 栏吸顶

- 改动：`CardPage.jsx` 的 `CARD_MOBILE_CSS` 加 `.ant-tabs-nav{position:sticky!important;top:0!important;z-index:2;background:#fff}`；
  `verify-ui.mjs` 加「滚到中部 Tab 栏仍可见可点」断言（量视口 y 坐标 + `position` + **真点击切换**，不只查 computed）。
- **`!important` 不是随手加的**：探针证明 antd CSS-in-JS 的 `.ant-tabs-nav{position:relative}` 层叠更高，
  不加时 computed 仍 `relative`、`navTop=-1692`。这条已写进代码注释。
- 我复跑验收：`verify-ui` 全绿；自测 375 中部 `position=sticky / top=0 / bottom=46 / de=375`；
  `/tmp/mgr-w3b-sticky.png` 目视 Tab 白底吸顶；`git show --stat` 恰好 2 文件、白名单外零夹带。
- **一次口径漏发（我的错）**：22:20 正式卡只含吸顶，22:21 我才量出 header 468px 并把升级口径写进本文档，
  但**没把升级版任务卡发出去**，导致写工按正式卡收口后回头质疑「plan 比派单新」。→ 派单口径变更必须同步发卡，不能只写 plan。

### W3c ·【已完成 2026-11-14，`eb3d9a1`】顶栏瘦身（替换 `flex-wrap: wrap`）

- 落地：W3 那条 `flex-wrap: wrap` 换成「隐藏院区 Tag + 副标题 + `nowrap` + `padding-inline:12px !important` + `padding-block:6px`」，
  吸顶规则原样保留。单号 `medbrief-w3c-header-slim-1114` 实际并入 W3b 卡执行（写工先交吸顶 `5d907aa`、再交瘦身 `eb3d9a1`，
  两个提交即最终形态，**不改写历史**）。
- 我复跑验收：375 → `headerH=77 / de=375 / nowrap / Tag·副标题 none / 内容起点 y=77`；414 → 同 77px；
  1440 → `headerH=64 / de=1440 / Tag·副标题 block`；滚中部 `navTop=0 / sticky / headerH=77`；
  `verify-ui` 全绿（含反例自证伪 336px 判红）；`/tmp/mgr-w3c-375.png` 目视首屏直接见病友抬头。
- **写工自己挖到的 1px 陷阱（写死）**：`padding-block:8px` → header **81px**，差 1px 不达标；8/6/4/0 → `81/77/73/65`，取 6px。
  **断言写「≤80」就必须实测到 1px，否则 81px 会被当「差不多」放过。**
- **选择器纠偏**：Tag/副标题**不是** header 的直接子元素，而是左侧 `ant-space` 的第 2、3 个 `.ant-space-item`（`App.jsx:110-114`）；
  `padding-inline` 必须 `!important`（`App.jsx:107` 内联 `paddingInline:20` 层叠最高），其余声明无需 `!important`（逐个探针验证）。
- 桌面差异取证法：同会话稳定等待（2500ms）连拍三张全与基线字节级一致；1800ms 那张有 737 像素 × 每通道 1/255 的抗锯齿波动
  → **截图比对先排除动态/抗锯齿噪声，不能只报「不一致」也不能只报「一致」**。

原卡（口径留档）：

- `request_id`: `medbrief-w3c-header-slim-1114`（`when:"queue"`，`reply_to:"me"`；实际由 W3b 卡继续执行）
- 可写白名单（**只有两个**）：`web/src/pages/CardPage.jsx`（延续 `CARD_MOBILE_CSS` 的 ≤575px 段）、`tests/verify-ui.mjs`
- 目标：375×812 下 `header` 高度 **≤ 80px** 且 `scrollWidth ≤ 375`（两个数同时成立，禁拿一个换一个）；414×896 高度也 ≤80
- 基线（我实测）：`headerH=468 / flexWrap=wrap / de=375 / navTopInit=1008`
- 允许：≤575px 隐藏院区 Tag + 副标题、`flex-wrap:nowrap`、收窄 padding；header 内容仍 >375 时按钮可图标化
- 禁止：改 `web/src/App.jsx`、`lib/**`、`data/**`、`intake/*`、`verify-workbench.mjs`、别人脏文件；**禁止再用 `flex-wrap: wrap`**
- 断言：header 高度 ≤80 + 同状态 `scrollWidth ≤375` + 吸顶仍 `top=0`（不得被换掉）+ **反例自证伪**（对 `5d907aa` 跑必须红，当前 468）
- 完成标准：`verify-ui` 全绿 / 1440 桌面与 `/tmp/w3-desktop.png` 一致 / `card-pdf` 3 页 680px 零重叠 /
  `/tmp/w3c-header-375.png` 目视（深色条 ≤80px、Tag 与副标题消失、标题不竖排、首屏见内容）/ 提交只含两文件 / 不重启服务

### W3-原卡（历史留档）

- `request_id`: `medbrief-w3-mobile-1114`
- 路径：`/Users/scallion/Documents/projects/MedBrief`
- 可写白名单：`web/src/pages/card/OverviewTab.jsx`、`web/src/pages/card/TrendsTab.jsx`、
  `web/src/pages/card/TimelineTab.jsx`、`web/src/pages/card/SourceModal.jsx`、`web/src/pages/CardPage.jsx`
- 目标：iPhone 375×812 下三 Tab + 三弹窗**无横向滚动**、内容可读。
- 允许的改法（三选一或组合，按影响小到大）：
  1. 表格列在窄屏隐藏次要列（如「参考」「日期」），只留「项目 / 数值 / 判定」；
  2. `CompactRows` 在窄屏从两栏改单栏（`gridTemplateColumns: '1fr 1fr'` → 媒体查询或 `useMediaQuery`）；
  3. 弹窗左右栏在窄屏改为上下堆叠（`SourceModal` 的两个 `flex` 子项已 `minWidth: 300/320`，
     只需保证外层 `flexWrap: 'wrap'` 生效 + 高度自适应）。
- 完成标准：
  1. 在 `tests/verify-ui.mjs` 增加一条 375×812 冒烟：三 Tab 各截一张图到 `/tmp/w3-<tab>.png`，
     并断言 `document.documentElement.scrollWidth <= 375`（三 Tab 都要过）。
  2. `node tests/verify-ui.mjs` 绿；`node tools/card-pdf.mjs` 绿（证明没波及打印件）。
  3. 提交：`feat(card): 工作台移动端适配（375px 无横向滚动）`。
- 禁止：改 `lib/**`、改打印件、破坏 1440px 现有布局（改完必须同时出一张 1440 截图对比）。

### W4 ·【已由我完成 2026-11-14】服务端「半写」护栏

- 状态：**已完成**（`server.mjs` 变干净后我立刻做了，未外派 —— 共享文件 + 风险点）。
- 判据落在 `lib/labClean.mjs:looksColumnShifted()`（`isRange(value) && isUnitLike(refRange)`，宁可漏判不误拦）。
- 实测：只提交 `value` → `400`（附 `field`/`hint`）；四元组 → `200`；两种调用后真实库 sha256 均未变。
- 遗留：`ReportsPanel.jsx` 的前端护栏**不归我**（那是代诊-报告的文件）—— 服务端已兜住，工作台已用 `buildRowPatch()`。

### W4-原卡（历史留档）

- `request_id`: `medbrief-w4-patch-guard-1114`（**触发条件：`git status --short server.mjs` 输出为空**）
- 可写白名单：`server.mjs`（单 hunk）、`tests/verify-rowpatch.mjs`（或新增 `tests/verify-patch-guard.mjs`）
- 要做的：在 `POST /api/intake/reports/:id/patch` 里加一道护栏 ——
  若目标行「读侧会做列左移还原」（判据：`isRange(row.value) && isUnitLike(row.refRange)`，两个函数已在 `lib/labClean.mjs` 导出），
  而本次 patch **只给了 `value` 没给 `refRange`/`unit`** → 返回 `400`，错误信息写
  「该行是读侧修复的左移行，必须同时提交 name/unit/refRange（只写 value 会永久丢掉参考区间）」。
- 完成标准：新断言覆盖「只提交 value → 400」与「四元组 → 200」两条；全套门禁绿。
- 为什么阻塞：`server.mjs` 现在混着代诊-报告未提交的改动，替别人暂存会重演 11-14 的「改动被扫进别人提交」事故。

### W5 ·【已完成 2026-11-14】给家属看的《资料卡使用说明》

- 最终形态：`9e1c450`（补手机端菜单入口 + 编号顺延）+ `fe770cb`/`f2bdb75`/`84fec47`（按钮位置与数量、折行措辞、脱敏开关交叉引用三处订正）+ `b1b890e`（同步报告软删除）。
- 分工：写工写了初版，我接手做了「手机端小节 + 逐项订正」，写工再做只读复核（挑出 2 处文字错，已修）。
- 教训：**插小节会让后面所有「第 X 节」错位**，标题改了正文引用也要改；位置类描述必须按实测坐标写，不凭印象。

原卡（留档）：


- `request_id`: `medbrief-w5-guide-1114-r2`（先前同名排队投递作废；22:47 正式开卡）
- 可写白名单：**新建** `docs/资料卡使用说明.md`（不许改任何已有文件）
- 内容要求（面向家属，不是开发者）：
  1. 资料卡是什么、打印出来给谁看（一页 A4 = 第 1 页速览）；
  2. 三个视图怎么用：临床指标总览（点一行看原件）/ 动态趋势 / 全病程原件轴；
  3. 怎么打印：右上「打印预览 / 存 PDF」→「立即打印」；手机上点「新窗口打开」；
  4. 「修正数值」怎么用、为什么它会把**名称/数值/单位/参考区间一起写回**（一句话 + 反例：只改数值会丢参考区间）；
  5. 隐私：不存身份证 / 手机号 / 住址；脱敏开关只打码姓名；
  6. 三条明确「不做」：不写诊断结论、不给治疗建议、不提供删除。
- 完成标准：文件存在、字数 ≥600、无开发者术语堆砌（每个术语首次出现给一句白话解释）；
  文中所有按钮名称必须与页面实际文案一致（自查方式：对照 `web/src/pages/CardPage.jsx` 的按钮文本）。
- 禁止：改代码、改已有文档。

### W6 ·【已完成 2026-11-14】patch 端到端回放沙箱（代诊-挂号 `cf9e069` + `c7eb665`）

- 用法：`node tools/patch-replay.mjs`（在 **HEAD** 上跑，验「护栏有效」）；
  `MB_REPLAY_REF=cf9e069 node tools/patch-replay.mjs`（回放**加护栏之前**的提交，复现「丢区间」证据）。
- 我两种模式都实测过：默认档 C1–C5（半写→400、`changed=[]`、库 sha256 不变）+ A0（路径已封死）+ B1–B5 全 PASS；
  历史档 C1–C5 显示 200 并写入、A1–A3 复现「参考区间读成空串」。
- 不挂进 `test:intake` 链（它要起第二个服务，5199），属于**手动回归**工具。
- 产物：`tools/patch-replay.mjs`；真实库全程只读（sha256 前后比对）。

### W6-原卡（历史留档）

- `request_id`: `medbrief-w6-patch-replay-1114`
- 路径：`/Users/scallion/Documents/projects/MedBrief`
- 可写白名单：**新建** `tools/patch-replay.mjs`（+ 如需说明可新建 `.agents/patch-sandbox.md`）
- 为什么：我在「修正数值」上只验证到「表单能打开、四字段齐全」，**从没在数据上真跑过保存**
  （真实病历库不能拿来试）。要一个可复现的沙箱，把行为钉死，也是 W4 护栏的回归载体。
- 做法（**全程不碰真实库**）：
  1. `git worktree add /tmp/mb-replay HEAD` 建临时工作树；
  2. 把 `data/reports.json` **复制**到 `/tmp/mb-replay/data/`（只读复制，源文件一字不改）；
  3. 在 worktree 里起独立端口：`PORT=5199 node server.mjs`；
  4. 用例 A（**当前风险**）：找一行「三列左移」的存储行
     （判据：`value` 长得像区间且 `refRange` 是单位，可直接 `import` `lib/labClean.mjs` 的 `isRange`/`isUnitLike` 筛），
     `POST /api/intake/reports/<id>/patch` **只给 value** → 读回 → 断言「参考区间丢失」；
  5. 用例 B（**正确用法**）：同一行改用四元组（name/value/unit/refRange）→ 断言参考区间保住、
     `repaired` 清空、`patchLog` 留有 `{from,to}` 记录；
  6. 收尾：kill 5199、`git worktree remove --force /tmp/mb-replay`，清理临时目录。
- 完成标准：`node tools/patch-replay.mjs` 一条命令跑完，输出 A/B 两段 `PASS/FAIL` 与逐字段前后对比；
  跑完 `git status` 里**不出现** `data/reports.json` 的改动。
- 禁止：写真实 `data/reports.json`；重启 5174；碰白名单以外的文件；把沙箱脚本挂进 `test:intake` 链
  （它会起第二个服务，不适合放进常规门禁）。
- 优先级：**低于 114 线**。114 有活就先做 114，这张卡随时可打断。

### W7 ·【已完成】测试有效性审计（代诊-Manager 自做复核，读工交付）

- 读工（混元三）交付 17 文件 A≈71/B≈202/C≈4、空转候选 5 条、事故盲区补 3 处、建议 10 条。
- **我复核后纠正 1 条误判**：`verify-chunker.mjs:38 assert.equal(MAX_ASPECT, 2.8)` 被判「常量自证、永远绿」，
  实测把 lib 的 `MAX_ASPECT` 改 3.0 该断言立刻红 → 它是**合法的阈值钉死**，不是空转。
- 已回答他的「无法判定」（快照代表性）：快照 `generatedAt = 2026-11-13T07:14Z`，**早于**事故提交 `caa4d15`
  （2026-11-14 00:07 +0800），且**恰好含那 31 行定性值**（阴性 22 / 阳性 4 / 未见 4 / 褐色稀便 1）
  → 全量 `silently` 扫描**确实覆盖**真实丢失样本，不是盲区。
- 已落地 2 条建议（`db35e7e`）：workbench 弱断言 → rowKey 端到端恒等；card 的 `counts` 数字钉死。

### W8 ·【待派 · 非我线】审计建议的剩余条目（归各线 owner，未派）

| 建议 | 文件 | owner | 备注 |
|---|---|---|---|
| 弱断言补强 | `verify-import-report.mjs:37`（`picked` 只证命中） | 代诊-报告 | 需断言命中的适配器类型正确 |
| 弱断言补强 | `verify-chunker.mjs:32`（只证切成 ≥2 块） | 切块线 | 建议断言「相邻块 y 区间相接、总覆盖 == 原高」 |
| 去掉「或 122」兜底 | `verify-checklist.mjs` 的 `RECENT_MRD_DAYS\|122` | 我（下次动 checklist 时） | 改为精确断言当天数 |
| 不依赖长驻服务 | `verify-e2e` / `verify-ui` | 各自 owner | 加 `--offline` 夹具路径，防「服务没起→整片跳过」 |
| 快照漂移守护 | 全局 | 我 | 插一条「快照日期不得早于最近一次清洗规则变更」的守卫 |
| 串码防护补样例 | `verify-labclean` | 我 | 补 血钙 vs 尿钙、血糖 vs 脑脊液糖 |

### W10 ·【已完成 2026-11-14，`651846e`】手机端导航：窄屏隐藏 Sider + 顶部菜单入口

- 落地：`App.jsx` 全局窄屏 CSS（≤575px 隐藏 Sider + 顶栏瘦身 + 内容区收敛）+ 汉堡按钮（Header 直接子元素、绝对定位）
  + antd `Drawer` 复用同一份 `menuItems`；顶栏规则**单一 owner** 搬到 `App.jsx`，`CardPage.jsx` 只删那 3 条；
  `verify-ui.mjs` 加 W10 六组断言 + 内容起点 ≤96 + 7 页「改后 ≤ 改前」逐页前后值 + 按文本定位标题/Tag/副标题。
- 我复跑验收：375 `header 77 / headerScrollW 375 / Sider 0 / 正文 375 / 内容起点 77 / de 375`；414 同 77；
  1440 `header 64 / Sider 168 / de 1440 / MedBrief x=20（与基线一致）/ 汉堡隐藏`；抽屉 7 项可点、点「资料卡」→ `?tab=card` 且自动关闭；
  7 个菜单页 `de` 全部 375（415/435 → 375）；`verify-ui` 全绿；`card-pdf` 3 页 680px 零重叠。
- **三个真 bug（写死，都是「全绿却实际错」）**：
  1. 汉堡按钮放进左 `Space` 后 `nth-child` 整体后移 → 375 下**误隐藏 MedBrief、漏隐藏副标题**，旧断言查固定 `children[1|2]` 被同样偏移骗绿
     → 改**按文本定位** + 加「MedBrief 仍可见」断言。**教训：断言用固定下标选元素，会被「前面多插一个元素」骗过。**
  2. 桌面 `display:none` 的按钮，antd `Space` 仍为它留 12px gap → 桌面 Tag/副标题整体右移 12px（4760 像素真实差异，**不是抗锯齿**）
     → 按钮移出 `Space`；修后同会话连拍像素 diff `n=0`、Tag `x=119`、MedBrief `x=20`。**教训：桌面「字节级一致」必须查，不能只看 computed。**
  3. 按钮移出后 `> .ant-space:first-child` 选择器失效 → 门禁红 10 项（header 780px、`de 407/427`）→ 改 `.mb-header-left` 精确命中。
- 用户认可的口径顺序：**先改界面（W10）→ 再终审 W5 说明书 → 最后提交报告线 + 重启**。

原卡（留档）：

- 现象：375×812 下左侧 Sider 压成 56px、菜单文字竖排成单字列，不可读不可点，还白占 56px（正文只剩 319px）。
- 用户拍板（2026-11-14 23:00 前后）：**选 ②** —— 窄屏隐藏 Sider、顶部换成菜单下拉；同时要求**不得把已压到 77px 的顶栏重新撑高**。
- 范围：`web/src/App.jsx`（全局壳，7 个菜单页共用）+ `tests/verify-ui.mjs`；不改 `?tab=` 语义与 `KEY_ALIAS` 旧链兼容。
- 硬约束（两个数必须同时成立）：375 下 `header ≤80px` 且 `scrollWidth ≤375`；`.ant-tabs-nav` 吸顶仍 `top=0`；
  7 个菜单页在 375 下逐个 `scrollWidth ≤375`；992/1440 桌面 Sider 与菜单结构不变。
- 开口径顺序（用户指出）：**先改界面（W10）→ 再终审 W5 说明书 → 最后提交**。W5 草稿（8.3KB，未提交）保留不动。

原口径（留档）：
- 【已决策·2026-11-14 用户批准 ②】改 `App.jsx` 等于给全部 7 个菜单页定手机端导航形态，属用户可见变更 —— 用户已拍板做，见本节开头。

---

## 2.9 事故记录：暂存区共享导致的「提交合并」（2026-11-14 23:16）

**现象**：`fe770cb fix(docs): 资料卡使用说明订正按钮位置与数量` 里实际含 **22 个文件 / 2157 行**，
其中 21 个是报告导入线的代码/工具/夹具，只有 1 个是提交信息所说的文档。

**时间线（秒级）**：
```
23:16:08  5874ee3  docs(import): 报告导入七阶段工作流 + 字段字典   ← 代诊-报告 的第 ① 条（4 份 docs）
23:16:14  fe770cb  fix(docs): 资料卡使用说明订正按钮位置与数量      ← 我提交的，卷走了对方已 add 的 21 文件
```

**根因（是我，不是对方）**：多会话共用一个 index。对方 `git add` 25 个文件、提交 ① 后，**剩余 21 个仍留在暂存区**；
我随后执行 `git add -- docs/资料卡使用说明.md && git commit -m ...`，**`git commit` 不带 pathspec 时会提交整个 index**，
于是那 21 个文件被一起写进我这条「订正说明书」的提交。

**内容完整性**：无丢失、无覆盖。25 份内容逐字都在 HEAD（4 份 docs 在 `5874ee3`，21 份在 `fe770cb`），工作树干净。
**真正的损害是记录**：原定 ②③ 的语义拆分与门禁证据没有承载者。

**处理**：不改写历史（本仓无 remote 也不改写，避免二次撞车），改为在本节留下原定提交信息与门禁证据（见下）。

**两条判据（写死）**：
1. **add 与 commit 必须连续**：同一条命令串里 `git add -- <文件…> && git commit -m …`，绝不跨会话把东西留在暂存区；
   只提交单个文件时用 `git commit -m … -- <路径>`（带 pathspec），不要裸 `git commit`。
2. **commit 前先 `git diff --cached --name-only`**：看一眼「这些是不是我要的」，多出来的当场就露。

**原定 ② 的提交信息（chore/scaffold）**：
```
chore(scaffold): 忽略真实库与构建产物；补回 build:web 依赖的 CSS 构建脚本
- .gitignore +9：web/dist-meddata/、meddata/.vite/、data/meddata-mirror/、data/medbrief.db(-journal)、
  data/reports.json.bak-*、data/tmp/inbox/manifest.json —— 不忽略会把 36 MB 真实库扫进 git
- 补 web/scripts/build-meddata-css.mjs：package.json:13 的 build:web 第一段就是它，缺它新克隆 build 直接失败
```

**原定 ③ 的提交信息（feat/import）**：
```
feat(import): 尿三项别名 + MCP 报告纠错工具 + 导入 CLI/版式适配器 + 门禁
- lib/reportIntake.mjs：补尿三项别名（尿潜血/BLD、尿红细胞/U-RBC、尿白细胞/U-LEU）—— 这三项永远 P0，漏映射会折叠进 P1
- mcp/intake-server.mjs：新增 intake_update_report（走 /api/intake/reports/:id/patch，落 patchLog，无删除能力）
- INTERFACE.md：通道 1.5 报告导入字段口径 + MedData 页面独立挂载说明
- tools/：import-inbox / import-report / ocr-table-rows / repair-import / workflow-screenshots / pdf-extract.py / dhash.py
  + report-adapters/（5 个版式适配器）；写库一律 --apply 门控，无硬编码绝对路径
- tests/：verify-import-report（24 断言，含「dry-run 不动 data/reports.json」）、verify-import-workflow（6 断言）
- fixtures：flow-immunophenotype-page1.txt / lab-panel-simple.txt（已脱敏：张某 / 某军区总医院 / V00000000000 / 床号 0）

门禁实测：import-report 24/0 · import-workflow 6/6 · intake 23/0 · live 8/0；
data/reports.json sha256 f34de483… 前后一致（mtime/size 不变），medbrief.db 未被写。
```

---

## 3. 验收命令（每张卡通用）

```bash
cd /Users/scallion/Documents/projects/MedBrief
node tests/verify-unit.mjs        # 23
node tests/verify-intake.mjs      # 23
node tests/verify-card.mjs        # 59
node tests/verify-labclean.mjs    # 23
node tests/verify-checklist.mjs   # 8
node tests/verify-codealias.mjs   # 5
node tests/verify-rowpatch.mjs    # 6
node tests/verify-workbench.mjs   # 12
node tests/verify-pdf.mjs         # 6
node tests/verify-ui.mjs          # 全部通过（需先 build:web + 服务在 5174）
node tests/verify-e2e.mjs         # 8（2026-11-14 代诊-报告 在 740acb1 加了 2 条 live 断言）
node tools/card-pdf.mjs           # 第 1 页 ≤1054px、总页数 ≤3、重叠/裁切 0 处
```

---

## 4. 派单顺序

```
W1（读工，随时，零风险）
W2（写工）→ W3（写工）→ W3b（写工）→ W3c（写工）→ W5（写工）   ← 写工串行，按此顺序发 queue
W10（用户已批 ②，`651846e` 已完成）        ← 手机端隐藏 Sider + 顶部菜单入口
W4（写工）← 等代诊-报告 提交完 server.mjs 后我再发
```

## 5. 我不外包的部分（保留在我手上）

- **真实病历数据的写入验证**（`data/reports.json`）—— 需要先备份、用副本报告，且要用户授权。
- **对外契约变更**（`/api/intake/card` 增删字段、`?html=0`）—— 需我先评估影响面。
- **打印件版式改动**（`renderHtml()`）—— 唯一真凭据是 PDF 门禁，必须我签字。
- **架构决策**（组件拆分、状态提升、是否引 router/图表库）。


## 5. 本轮收口状态（2026-11-14 23:4x）

| 卡 | 结果 |
|---|---|
| W1 / W7 / W9（读工审计） | ✅ 收口，挂账 0 |
| W2 / W3 / W3b / W3c / W10（写工前端） | ✅ `1e43b65` / `580e3c9` / `5d907aa` / `eb3d9a1` / `651846e` |
| W5（家属说明书） | ✅ `9e1c450` + 三处订正 + 删除同步 `b1b890e` |
| W4 / W6（护栏 / 沙箱） | ✅ 收口 |
| W12（报告软删除 + 回收站） | ✅ `3a299d9`（10 条断言，副本库，真实库 sha256 未变） |
| 品牌口径（去定制 Tag） | ✅ `c515a11` |
| 蒸馏与台账 | ✅ `a821095`（bugs.md 8 条）/ `867ebcd`（index 教训）/ 台账入库 |

**挂账 0**：本会话派出的 15 张卡全部交付并验收；未决项只有「范围外的历史建议」（W8 剩余四条归各线 owner），不在本会话账上。
