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

### W2 ·【写】趋势图 Y 轴刻度与点值标签重复（派：外包仔·混元四）

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

### W3 ·【写】工作台 375px 移动端可用性（派：外包仔·混元四，**排在 W2 之后**）

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

### W5 ·【写】给家属看的《资料卡使用说明》（派：外包仔·混元四，可与 W3 并列排）

- `request_id`: `medbrief-w5-guide-1114`
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

---

## 3. 验收命令（每张卡通用）

```bash
cd /Users/scallion/Documents/projects/MedBrief
node tests/verify-unit.mjs        # 23
node tests/verify-intake.mjs      # 23
node tests/verify-card.mjs        # 58
node tests/verify-labclean.mjs    # 23
node tests/verify-checklist.mjs   # 8
node tests/verify-codealias.mjs   # 5
node tests/verify-rowpatch.mjs    # 4
node tests/verify-workbench.mjs   # 10
node tests/verify-pdf.mjs         # 6
node tests/verify-ui.mjs          # 全部通过（需先 build:web + 服务在 5174）
node tests/verify-e2e.mjs         # 8（2026-11-14 代诊-报告 在 740acb1 加了 2 条 live 断言）
node tools/card-pdf.mjs           # 第 1 页 ≤1054px、总页数 ≤3、重叠/裁切 0 处
```

---

## 4. 派单顺序

```
W1（读工，随时，零风险）
W2（写工）→ W3（写工）→ W5（写工）      ← 写工串行，按此顺序发 queue
W4（写工）← 等代诊-报告 提交完 server.mjs 后我再发
```

## 5. 我不外包的部分（保留在我手上）

- **真实病历数据的写入验证**（`data/reports.json`）—— 需要先备份、用副本报告，且要用户授权。
- **对外契约变更**（`/api/intake/card` 增删字段、`?html=0`）—— 需我先评估影响面。
- **打印件版式改动**（`renderHtml()`）—— 唯一真凭据是 PDF 门禁，必须我签字。
- **架构决策**（组件拆分、状态提升、是否引 router/图表库）。
