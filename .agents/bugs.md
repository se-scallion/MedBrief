# Bug 台账（MedBrief）

> 一条 Bug 一节，四列口径：症状 / 根因 / 修法 / 证据。状态标记：`【已修·日期】`、`【不改·日期】`。
> 判决必须能指到 `文件:行` 或一条可复跑命令；「收益未证」「优先级低」这类无锚断论不算原因。

## Bug 1 【已修·2026-11-14】单边参考区间判不出高低（`<125` / `<7` 一律不标）

- 症状：`前体NT-proBNP 3182.00 pg/ml（参考 <125）`、`白介素6 103.40（参考 <7）` 卡上**不标 ▲高**，
  医生看第 1 页以为正常。只给一侧界值的参考区间（`<x`、`>x`）被当成无法解析 → 返回 `flag=''`。
- 根因：区间解析器只认 `a-b` 双边界；单边区间落到「无法判定」分支，且 `Math.min/max` 对 `Infinity` 处理成 NaN。
- 修法：无界一侧返回 `null`（不返回 `±Infinity`）、`judgeFlag` 两侧独立比较、趋势参考线逐侧绘制。
- 证据：`tests/verify-card.mjs`（59 条，含单边区间断言）；真实库漏标项已能正确标高。

## Bug 2 【已修·2026-11-14】NT-proBNP 3182（危急）被折叠到第 2 页

- 症状：超标 25 倍的重度心衰指标不进第 1 页「核心异常项」，只在第 2 页明细里出现。
- 根因：`NT_PROBNP/BNP` 被列进 `P1_DEMOTED_CODES`；危急阈值也未覆盖该项。
- 修法（用户 2026-11-14 拍板）：移回 P0；危急阈值 `NT-proBNP ≥ 1800 pg/mL`（成人急性心衰最高年龄分层界值）。
- 证据：`lib/cardPolicy.mjs:26-28,61-63`；实测卡片 JSON 含 `critical:{range:'≥1800',value:3182}`。

## Bug 3 【已修·2026-11-14】左移行「只改数值」会把参考区间永久丢掉

- 症状：读侧还原过的列左移行，前端只提交 `value` 就保存 → 该行 `refRange` 被当成「未提供」写空，
  之后分不清偏高还是正常；更坏的是 `repaired` 留下假标记 `['unit-range-swap']` 让人以为是修好的。
- 根因：patch 接口按字段合并，没校验「这一行是读侧修复行，必须整行四元组一起提交」。
- 修法：修正一律走 `buildRowPatch()` 四元组；服务端护栏 `looksColumnShifted()` =
  `isRange(value) && isUnitLike(refRange)`，只给 value → `400` 并附 `field`/`hint`。
- 证据：`lib/labClean.mjs`（护栏判据）、`tools/patch-replay.mjs`（A0「路径已被封死」+ C1-C5 全 PASS）、
  `MB_REPLAY_REF=cf9e069` 可复现旧行为的丢区间证据。

## Bug 4 【已修·2026-11-14】手机端顶栏被「换行」撑到 468px，一屏被吃掉 58%

- 症状：375×812 下顶栏 468px、副标题压成竖排单字，内容要到半屏以下才开始。
- 根因：为消除横向溢出（435px）给顶栏加了 `flex-wrap:wrap` —— **把横向溢出换成了纵向吞噬**。
- 修法：≤575px 隐藏副标题 + `nowrap` + `padding-inline:12px !important` + `padding-block:6px` → **77px**。
- 证据：`web/src/App.jsx:34-42`；`tests/verify-ui.mjs` 断言 `header ≤80px` 且 `scrollWidth ≤375` 同时成立、
  首屏内容起点 ≤96px、滚到中部仍 ≤80px；反例自证伪（还原 wrap → 848px 判红）。
- 教训：**数字达标 ≠ 体验达标**，改完必须看成品截图。

## Bug 5 【已修·2026-11-14】汉堡按钮插入后 nth-child 整体后移 → 误隐藏标题，断言被骗绿

- 症状：手机端「MedBrief」标题消失、副标题反而露出；而 `verify-ui` 仍然**全绿**。
- 根因：隐藏规则和断言都按下标选元素（`.ant-space-item:nth-child(2|3)` / `children[1|2]`）；
  按钮插到左 Space 前面后序号整体 +1，规则打错对象，**断言也按同样错位的下标读数** → 骗绿。
- 修法：断言改成**按文本定位**（`byText('MedBrief')`）+ 新增「标题必须可见」；CSS 改成 `.mb-header-left` 精确命中。
- 证据：`tests/verify-ui.mjs`（Tag 必须不存在 / 副标题隐藏 / MedBrief 宽 87px 可见）。

## Bug 6 【已修·2026-11-14】桌面被 antd `Space` 的 12px gap 顶偏（不是抗锯齿）

- 症状：桌面 1440 截图与基线有 4760 像素差异，`bbox [21,22,478,43]` 正是顶栏 Tag 区域。
- 根因：汉堡按钮 `display:none` 但仍是 `Space` 的一个 item，**antd 仍为它保留 12px gap** →
  MedBrief 从 `x=20` 挪到 `x=32`，整条左侧右移。
- 修法：按钮移出 `Space` 作 Header 直接子元素 + 绝对定位；修后同会话连拍像素 diff `n=0`、`x=20` 复位。
- 证据：`web/src/App.jsx:56-58`；连拍两张与 `/tmp/w3-desktop.png` sha256 一致。

## Bug 7 【已修·2026-11-14】家属说明书两处文字错误（按钮行数 / 交叉引用错位）

- 症状：① 写「三个按钮排成两三行」——实测 375 下 y=248/252/288，是**两行**；
  ② 「打印前请按第四节第 4 条确认开关状态」——第四节第 4 条讲的是「打印固定三页」，**根本没讲脱敏开关**。
- 根因：① 凭印象写布局；② 往文档中间插小节导致后续编号顺延，只改了标题、没改正文引用。
- 修法：① 改为「换行排成两行，仍留在页面最上方同一条操作栏里」；② 改指向「第四节末尾『小提醒』」。
- 证据：`docs/资料卡使用说明.md:27,64`；提交 `84fec47`、`f2bdb75`。

## Bug 8 【已修·2026-11-14】顶栏硬编码「北京朝阳医院 · 血液内科 · 主鸿鹄」

- 症状：顶栏挂着一家医院 + 一个科室 + 一位医生的红色 Tag，把「面向多病人多医院」的产品定位写成「为某医生定制」。
- 根因：项目起源于一位患者/一位医生的场景，Tag 作为临时标记留在了壳里。
- 修法（用户 2026-11-14 口径）：删除该 Tag；出诊监控文案「抓取主鸿鹄主任排班」→「抓取目标医生排班」；
  输入框占位「北京朝阳医院」→「某某医院」。**注意**：删 Tag 后副标题从第 3 项变第 2 项，
  窄屏隐藏选择器必须同步改，否则会误隐藏标题。
- 证据：`web/src/App.jsx`（Tag 已删 + 选择器收成 `nth-child(2)`）、`tests/verify-ui.mjs`（断言「Tag 必须不存在」防止回潮）。

## Bug 9 【已修·2026-11-15】`rep_mwh9w5et3um` 报告日期空着：旧记录在日期修复之前入库

- 症状：FISH 报告（原文有 `报告日期：2026-9-30`）在报告库里 `reportDate=""`，用户报「图片上明明有，还是没识别出日期」。
- 根因：**不是识别逻辑坏**。该记录 `createdAt=2026-11-15T03:26Z`（本地 11:26），
  而日期标签优先的修复 `eca9de7` 落地在 12:15 —— 记录是在修复**之前**入库的。
  当前 `guessMeta(text)` 对同一段文本实测返回 `2026-09-30`（`source=label-reported`）。
- 修法：按「库内数据改动先快照」口径，先 `data/backups/reports-before-datefix-20261115-201007.json`
  （63 份全量、314831 字节、不入库），再用 `guessMeta` 从记录**自己存的 text** 回填 `reportDate/sampledAt/dateSource`。
  判据：全库「空日期但文本里有报告/送检/采集日期标签」= **0 条**。
- 证据：`git log --format='%h %ci %s' -- lib/reportMeta.mjs`；`node -e` 调 `guessMeta`；
  `npm run test:library` 12/0、`npm run test:meta` 9/0、`npm run test:card` 61/0。
- 教训：修了识别链路**不等于**修了历史记录；「用户说没识别」要先比 `createdAt` 与修复提交时间。

## Bug 10 【不改·2026-11-15】两处报告日期仍用裸 `<Input>`，不是 Ant Design 标准组件

- 症状：`IntakePage.jsx:653`（录入校对区）、`ReportsPanel.jsx:484`（报告库编辑弹窗）用
  `<Input placeholder="YYYY-MM-DD">`，用户点名「没有使用 Ant Design 的标准组件」。
- 根因：antd 6.6.6 + dayjs 1.11.23 早已声明（`package.json:52-53`），`BookingForm.jsx:552` 就是本项目自己的
  `DatePicker` 标准范本；识别线是后来边补边加，用最省事的 Input 顶上，没有回头统一。
- 决策：**不改（本会话收尾时）** —— 用户口径是「先给方案与改动清单，确认后执行」，方案
  `.agents/forms-component-plan.md` 已过 plan-review 四段排雷但**尚未获准执行**；收尾不得把待确认方案擅自落地。
- 边界（防止下个会话改崩）：后端/卡片/排序/趋势里 `reportDate` 全是 `YYYY-MM-DD` **字符串**
  （`lib/intakeCard.js:181,482,506,530`、`lib/conclusionExtract.mjs:147`、`lib/leukemiaChecklist.mjs:22,70`、
  `web/src/pages/intake/reportSort.js:13` 全部 `String(x).slice(0,10)`），而 DatePicker 给 dayjs 对象；
  必须走薄封装在边界 `format('YYYY-MM-DD')`，存储值域不变。
- 再触发条件：用户说「按 forms-component-plan 执行」（或等价确认）；届时按该文档 §5 三项改动 +
  `build:web` / `test:ui` / `tools/e2e-real-pdf.mjs` / `test:card` / `test:library` 全绿验收。

## 收尾终态（2026-11-15，session-wrap-up Step 3）

以下 6 项在本次收尾时逐项裁到终态，**不再挂账给用户**；每条都有证据与再触发条件，
状态标记沿用 `【不改·日期】` / `【护栏·日期】`。收尾结束时不留「要不要修」类问题。

| # | 事项 | 决策 | 证据（可复跑） | 再触发条件 |
|---|---|---|---|---|
| 1 | 表单组件替换（报告日期 DatePicker 等） | **不改·2026-11-15** | `.agents/forms-component-plan.md` 已过排雷但用户口径是「先方案、确认后执行」；`DateField` 不存在、`IntakePage.jsx:653` 与 `ReportsPanel.jsx:484` 仍是 `<Input>`（本文件 Bug 10 已记） | 用户说「按 forms-component-plan 执行」 |
| 2 | 3 张截图拼图 / N 张内容级合并 | **不改·2026-11-15** | `.agents/plan-stitch-2line-1115.md` 顶部补记：两行版式等已由 `a9c3c45` 落地；直接照做会重复施工 | 用户指出剩余 3 项（N 张合并 / 选 3+ 张 / 截断行取值）中任一仍需做 |
| 3 | M3 旧代码物理删除 | **护栏·2026-11-15** | `curl -s 127.0.0.1:5174/api/recognition-hits?days=7` → `retireGate=false, observedDays=1, 样本 1 < 50`；`tests/verify-recognition-hits.mjs` 4/0 | 连续 7 天 `retireGate=true`（每天有观测 + legacy 全 0 + 样本 ≥50） |
| 4 | 用户复验「AI 精读」findings/conclusion 回填 | **不改·2026-11-15** | 服务侧已真跑（8–10s done、measures 8/10、doc_type=血常规，`MedRecognition/docs/m1.md §7`、`MedData c408650`）；界面观感只能真人看，不是缺陷 | 用户明确回报「回填与老通道不一致」并给出字段 |
| 5 | 验收截图 01–13 缺失 | **不改·2026-11-15** | `ls MedBrief-验收截图/` 只剩 14/15/16；01–13 是旧 `/tmp` 图，已不可恢复，且当前代码下重截无意义（页面已多轮变化） | 用户要求重新生成全套终验截图 |
| 6 | `data/guahao-browser.flag`（挂号浏览器开关） | **不改·2026-11-15** | 文件 4 字节 `off`、11-15 00:09 创建，属挂号线的运行态开关且非本会话产出；已加 `.gitignore`，文件不动 | 挂号线的 owner 认领并在其会话里提交 |

自检：`grep -nE '【待修】|待决策|待拍板' .agents/{bugs,MEMORY,architecture,testing-lessons,forms-component-plan,plan-stitch-2line-1115}.md` → **本会话相关 0 条**。
