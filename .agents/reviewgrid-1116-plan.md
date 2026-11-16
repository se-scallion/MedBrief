# ② 识别与校对整份挂 DataGrid + 导入状态机修复 —— 排雷与取舍（v0.6 · 终审通过版）

> **AI 审核 5 轮闭环**：r1（3 P0）→ r2（3 未闭环）→ r3（只准哪几条，A/B 两翻车点）→
> r4（仍只准几条，④ 的 text P0）→ **r5 总判「可以开工」**。
> 判词：`reviewgrid-1116-review-r1/r2/r3/r4/r5.md`；输入：`reviewgrid-1116-review-input*.md`。
>
> **v0.6 = v0.5 + r5 两处 P1 写法（判词要求「开工前确定」）**：
> - **P1-1**：`push('text', rep.text, v)` 与「只记长度变化」不能同时成立——
>   `server.mjs:1163-1165` 的 `push()` 原样存 from/to 会把**整篇患者原文**复制进 patchLog
>   （patchLog 也在 `reports.json` 里）。改专用条目
>   `{field:'text', fromLen, toLen, fromSha, toSha}`（长度 + sha 前 12 位，可审计、不重复存原文）。
> - **P1-2**：`rows.added/removed` 快照只存 `{name,value,unit}` 各截 40 字，
>   **严禁带 `rawSnippet`**（原文行切片），removed 快照设总量上限（50 行）。
> - **text 白名单防误用**：只有 `rowsReplace===true` 且带 `fromReportId` 时才接受 `text`，
>   且空值拒绝（清空必须留标记）；本地回环、改 text 不影响查重（指纹算 rows）。
> - 实施顺序（r5 确认不变）：① `points.js`+状态机 → ② 挂 DataGrid → ③ baseline/emitTrace →
>   ④ 最后接 `PUT/rowsReplace`；前两步可独立验收。
>
> 按 §8.5：**终判已给「可以开工」，但仍须用户说「按以上计划执行」才编码**。

> **v0.5 修订说明（逐条对应 `reviewgrid-1116-review-r4.md`）**
> r4 总判「只准哪几条」：①②③⑤ + B 三条护栏准予；④「更新原报告」需补 1 个 P0。
> 按 §8.5 **不抢跑、不挂起**，把 ④ 裁到终态后整份送复审。
>
> - **P0｜patch 白名单没有 `text`**：实证 `grep "rep.text =" server.mjs` 零命中；
>   而 `conclusionExtract.mjs:52/65/74/106/149/157/166`、`leukemiaChecklist.mjs:30/215`
>   都吃 `report.text` → 「更新原报告」只换 rows 会留下「新指标行 + 旧结论/旧类型 haystack」。
>   **修法**：patch 白名单加 `text`（`push('text', rep.text, v); rep.text = v`）+ patchLog 记
>   `text` 长度变化 + 断言「更新后 text 与待校对副本一致」。
> - **r4 另两条**：① `rowsReplace` 两份行数不同时按 index 对齐会把 A 行旧值配给 B 行、
>   删掉的行静默消失 → 改为 `rows.added[] / rows.removed[]` 分条 + 被删行快照进 patchLog，
>   不静默删；② D5「智能补项可点且能加行」补「**但该行 value 为空、不入库**」。
> - **r4 复核 A/B**：原子写四字段 ✅；但 `version` **只是留痕不是锁**（`writeStore` 无条件写 2、
>   无 CAS）→ 已同步修正 `lib/reportStore.mjs` 文件头的错误注释，计划不再把它写成并发保护；
>   真实库 298 行空 value 0、定性行 30 且 value 全非空 → `String(value).trim()===''` 过滤
>   **不会误删阴性/未检出**（已复跑）。

> **v0.4 修订说明（逐条对应 `reviewgrid-1116-review-r3.md`）**
> r3 终判为「**只准哪几条**」：①②③⑤ 准予、④⑦ 需先定两条口径。按 §8.5，
> **不把 ④⑦ 挂起、也不分批抢跑**，而是把两条口径裁到终态后整份送复审。
>
> - **A｜重导口径（采纳 A1「重导 = 更新原报告」）**：r3 实证 `force` 只是跳查重后
>   `store.reports.push(rec)`（`server.mjs:1671`），**没有替换语义** → 库里长期两份同源、
>   资料卡材料清单 +1、同日同码两值 `valueConflict`。**本版砍掉 `forceReimport` 强导路线**：
>   已入库条目点「重新识别」确认后，**新建一份待校对副本**（新 id、不自动入库、不写库）供改内容，
>   用户明确点「更新原报告」时才走**扩后的 patch**（见下），绝不是再 push 一条。
>   - patch 扩 `body.rowsReplace`（整行替换，按 index 对齐 + 保留 `patchLog` from/to），
>     `saveReport` 对「更新原报告」走 `PUT /api/intake/reports/:id`（**新增但薄**，
>     复用现有 patch 白名单与原子写），旧记录**原地更新**，不新增、不软删、不需要 `supersedes`。
>   - 若用户只想再存一份（真·重导），保留现有单张「仍要导入」确认框，
>     但**文案必须写明「库里会有两份同源报告」**，由用户知情选择；批量路径**不自动强导**。
>   - 这样 ④ 不再依赖 `force:true`，r3 的 A 风险消失。
> - **B｜智能补项口径**：r3 实证 `addRow` 带出「推测项目名+单位+参考区间」但 `value=''`
>   （`DataGrid.jsx:543-568`），`fromPoints` 丢 `_source:'inferred'`，`saveReport`/服务端都不过滤空值
>   → 「有区间没数值」入库，踩「认不出的不瞎填」红线。**护栏三条全部落进 B/D5**：
>   ① `fromPoints` 保留 `inferred`（`p._source==='inferred'` → `row.inferred=true`）；
>   ② `saveReport` 入库前过滤 `String(value).trim()===''` 的行，并把「N 行无值未入库」写进日志/提示；
>   ③ 断言「智能补项后入库仍 0 行」「0 行全文型入库 rows=[]」。
> - **r3 P1/P2 六条**：① 实施拆三段（先 `points.js`+状态机纯逻辑 → 再挂 DataGrid → 最后 trace/0点断言）；
>   ② 报告库 `ReportsPanel.jsx` 的 `date=""` 死按钮一并对齐 `date=sampledAt`；
>   ③ D2 里 `reportedDate/reportType` 写重复的合并；④ F7 显式 WEB_OUT+硬刷新；
>   ⑤ `emitTrace` 的 localStorage 写入失败要可见（不静默）；⑥ 全部断言用副本库 + Playwright。
> - 用户 22:38 的「无版本差异/安全」仍按 v0.6 架构 v2 走；本计划只管录入面，不动 8011/B2–B5。

> **v0.3 修订说明（逐条对应 `reviewgrid-1116-review-r2.md`）**
> - **r2 #1（P0-2 基础不存在）**：`/api/intake/ocr` 响应**没有 `blocks`**（审核者实测 28 键、
>   只有 `lines` 版式行）。删掉「`rawGrid: body.blocks→grid`」；改为
>   `rawGrid:{kind:'layout-lines', lines: body.lines || body.layoutLines || []}`、
>   `rawGridSource:'layout-lines'`、`ocrLoop:null` **如实标注、不假造网格**。
>   `emitTrace` 先写 localStorage 再 POST `/api/log`，`readTraceLocal` 只读 localStorage
>   → **不依赖后端**；snapshot 里显式写 `traceSource:'recognize'`。
> - **r2 #2（silent 批量无重导出口）**：`IntakePage.jsx:357-366` 对 dup 只写日志不弹框，
>   D4「重新识别确认后重置」在批量路径会被静默吞掉。v0.2 曾提议 `forceReimport+force:true`，
>   **该路线已被 r3 A 推翻**（force 会 push 第二条同源报告）→ 见 v0.4 修订说明 A：改为
>   「待校对副本 + 更新原报告 / 另存」两动作，批量不自动强导。
> - **r2 #3（F4 旧文案）**：删掉「保留 Empty、只在 rows>0 时挂」，与 D2「0 行也整份挂」统一。
> - **r2 复核点①（date 污染）**：`DataGrid.jsx:964` 把 `date` 写进 feedback JSON、`:813` 是可编辑采集日期
>   → **撤回 v0.2 的 `date=reportDate||sampledAt`**。正解 `date=item.meta.sampledAt`（真·采集日）、
>   `reportedDate=item.meta.reportDate`；没有采样日时 DataGrid 自带保存按钮**该灰就灰**，
>   由下方「入库这份报告」唯一写库，按钮文案用上方说明行澄清，不改 MedData 组件。
> - **r2 复核点③（textOnly 条件加）**：`meta.textOnly=true` **只在 0 行且 text 非空的分支加**，
>   绝不放进公共 `item.meta`（否则关掉所有报告的文本回退解析）；写明 `rowsForType` 只挂在
>   OCR 端点 `server.mjs:1505/1568`，**import 路径没有门控** → 这正是 `textOnly` 必须条件加的理由。
> - **r2 复核点⑤（0 点安全）**：审核者实测 `reduce` 全带初值 0、一键修正/复制反馈/保存恒灰、
>   仅「智能补项」可点且正是补行入口 → D5 补 5 条 0 点断言（不崩/不除零/按钮态/补行/空 baseline）。

> **v0.2 修订说明（逐条对应 `reviewgrid-1116-review-r1.md`）**
> - **P0-1**：DataGrid 自带保存按钮 `disabled={!date || 无值}`（`DataGrid.jsx:1401`），
>   `date` 是**采集日期**、不是 `reportedDate`；v0.1 D2 只传 `reportedDate` → 恒灰，
>   且按钮文案「保存到本地数据库 →」硬编码在 MedData 组件里。**改法**：不接 `onSave` 写库，
>   改为 `date=item.meta.reportDate || item.meta.sampledAt`（镜像单一 state，F3），
>   `onSave` 只 `patchItem` 回写 rows 并弹「已应用到待入库内容，请点『入库这份报告』」；
>   按钮文案不改 MedData 组件（避免跨项目改单），在 DataGrid 上方加一行说明澄清语义。
>   报告库 `ReportsPanel.jsx:544` 的 `date=""` 死按钮另立小改单（不在本方案范围）。
> - **P0-2**：`readTraceLocal` 只读 localStorage，唯一写入是 `ImportFlow.jsx:424 emitTrace`，
>   ② 校对区 `recognize()` 从不 emitTrace → `traceId=item.id` 会让按钮变亮但 `rawGrid/ocrLoop` 全 null。
>   **改法**：`recognize()` 成功后自行 `emitTrace(item.id, { rawGrid: body.blocks→grid, ocrLoop, recognizedAt, … })`
>   （数据就在 `body` 里，不需新后端）；`traceId` 仍用 item.id。
> - **P0-3**：`server.mjs:1585` 对 0 行且 `meta.textOnly!==true` 会 `parseLabRows(text)` 回退解析，
>   `rowsForType` 只兜 5 类 → 核型/FISH/PCR 文本页会出假指标行；`status==='failed'` 的 text 未清会被误纳入。
>   **改法**：⑦ 的 targets 增加硬条件 `status!=='failed' && String(text||'').trim()`，
>   且 `saveReport` 对「0 行全文型」在 payload 里带 `meta.textOnly=true`（服务端已有该护栏，
>   不新改后端）；断言核型真 PDF 批量入库后 rows=[]。
> - **r1 实质结论①**：`rows.length>0 才挂` = 半个组件（DataGrid 对 0 点有空态与补行设计），
>   且删掉全文型报告唯一的补行手段 → **改为 0 行也挂整份 DataGrid**，删除 Empty 分支。
> - **r1 实质结论②**：已入库后「重新识别」同图 sha256 不变 → 必然撞 `dup`，
>   用户只是从「没有可入库的条目」换成「疑似重复已跳过」→ D3/D4 提前写明并给「仍要导入」出口。
> - **r1 附问**：F7 成立但需显式 `MEDBRIEF_WEB_OUT=dist-next` + 浏览器硬刷新；
>   `tools/e2e-real-pdf.mjs` 是 5175+副本库 ✅ 但**API 驱动**，UI 断言另用 Playwright 起副本服务。

> 无项目定制层（反查 3 个命中都只是**正文引用** `**通用层**` 标记，不是文件头标记；
> 按 plan-review §7.4 声明「无项目定制层，仅通用排雷」）。
> 与计划同目录的审核材料按 §8.2 命名：`reviewgrid-1116-review-{input,r1,r2,r3}.md`。
>
> 触发（用户 2026-11-16 原话）：
> ①「我早就让你整个组件搬过来，你又反对，又不知道做好计划」——指 MedData `DataGrid` 应**整体**用在
>    「资料录入 → ② 识别与校对」，不是只挂报告库编辑弹窗。
> ②「当我识别成功并导入。然后我再次点一键导入。该提示什么？当前提示的是没有可入库的条目。
>    我又尝试勾选条目，和点过重新识别。还是一样的提示。」
> ③ 用户随后追问「你过计划流程了吗？」——本方案必须走 §5 四段 + §8 独立 AI 审核 3 轮，
>   **终判「可以开工」且用户确认后才编码**。写本文件之前生产代码零改动（已复跑核过）。
>
> 状态：**方案，未编码**。

---

## 0. 现状取证（全部只读复跑过）

| 能力 | 现在在哪 | 证据 |
|---|---|---|
| DataGrid 已挂 | **仅报告库编辑弹窗** | `web/src/pages/intake/ReportsPanel.jsx:26` import、`:544-562` `<DataGrid>`；提交 `89ecea4` |
| DataGrid 按钮本体 | MedData | `meddata/src/components/DataGrid.jsx:872` 重新匹配、`:943-951` 一键修正、`:965-978` 复制反馈、`:1397` 清空本次、`:1401` 保存 |
| ② 识别与校对 | **仍是手写 antd `Table`** | `web/src/pages/IntakePage.jsx:602` `<Table>`、`:435+` `rowColumns`；`ReviewPanel.jsx:15` 标题「② 识别与校对」；`IntakePage.jsx` 全文件 `DataGrid` 0 命中 |
| 一键导入过滤 | `!saved && rows.length>0` | `IntakePage.jsx:413`；为空时 `:414` 固定文案「没有可入库的条目（先识别，或识别后补上指标行）」；按钮 title 同调 `ReviewPanel.jsx:23` |
| 已入库状态 | `saveReport` 成功后 `saved:true` | `IntakePage.jsx:351`；标签 `:684`「已入库 {reportId}」 |
| 重新识别 | **不清 `saved`** | `recognize()` `:251` 只设 `status:'ocr'`，`:272` 成功后 `status:'done'` + `rows/text`，`saved` 原样保留 |
| 勾选 | **只用于「两张拼接」** | `:53` 注释「勾选做拼接的图片 id」、`:172-177` 最多 2 张、`:181` `doStitch` 要求恰好 2 张；与导入状态完全无关 |
| 疑似重复 | 批量跳过、置 `status:'dup'` | `:357-362`；`dup` 条目 `saved` 仍 false 但 `status` 已非 `done` |
| 全文型报告 | 单张可入库（`text` 非空即可），**批量不可** | `:681` `disabled={!item.rows.length && !item.text}` 允许；`:413` 要求 `rows.length>0` 把 0 行全文型排除 |
| 保存按钮依赖 | DataGrid 自带保存要求 `date` | `DataGrid.jsx:1401` `disabled={!date || points 无值}`；`date` 由 `:845` 的 `reportedDate` 输入框给 |

**用户现象的代码级复现**：识别成功 → 入库 → `saved:true` → 再点「一键导入全部」→ `targets=[]` →
固定提示「没有可入库的条目」。勾选条目只改 `selected`（拼接用），点「重新识别」不清 `saved`，
所以两个动作都**不可能**改变 `targets` 的长度 → 提示永远一样。这不是偶发，是状态机设计如此。

---

## A. 反向排雷（R1…Rn，带证据）

| 编号 | 结论 | 证据 |
|---|---|---|
| R1 | **用户两个现象都成立**，且是同一处范围/状态机缺口 | 上表 0 段逐行 |
| R2 | **「整个组件搬过来」此前被我窄化成「报告库编辑面」** | `.agents/plan-reportgrid-1115.md:5` 拍板原话「报告库编辑面走 DataGrid 原样挂」、R1 `:22` 只写 `ReportsPanel.jsx:483-501`、D2 `:75` 只改 `ReportsPanel`；R1b `:23` 说的「导入面已在用 DataGrid」指 **MedData 的 ImportFlow**（`meddata/src/components/ImportFlow.jsx:1314`），不是 MedBrief 的 ② 校对区 |
| R3 | **「复制反馈」在报告库现在也是灰的**：`baseline.length && traceId` 才启用，而报告库传 `traceId=""` | `DataGrid.jsx:977`；`ReportsPanel.jsx:557` `traceId=""`。用户点名的「操作反馈」若只搬 UI 不给 traceId，会继续点不了 |
| R4 | **语义裂缝：4 种「不可入库」被同一句文案吞掉** | ①已入库(saved) ②疑似重复跳过(dup) ③未识别/识别失败(failed) ④0 行全文型报告(有 text 无 rows) —— `:413` 一律 `targets=[]` → 同一句「没有可入库的条目」 |
| R5 | **地基不一致：DataGrid 的 `points` 与 MedBrief `rows` 是两套形状** | `ReportsPanel.jsx:39-55` `toPoints/fromPoints`（`standard_code/original_name/ref_range/arrow` ↔ `code/name/refRange/flag`）；`IntakePage` 的 `rows` 是后者 |
| R6 | **已有等价基建，不必新写组件** | `toPoints/fromPoints` 在 `ReportsPanel.jsx` 已实现（只是未 export）；`oplog.js` 的 `getOps/clearOps` 已在报告库用（`:27`,`:181-190`）；`embedded.css` 已引（`:28`） |
| R7 | 频次：用户**两次**明确点名（整个组件 + 死提示），是已发生问题不是想象 | 本文件触发原话 |
| R8 | 真值来源：DataGrid 的「一键修正」只补单位/参考区间、**不改数值**，是 MedData 既有医疗红线，必须原样保留，不得自行放宽 | `DataGrid.jsx:943` title 原文「数值永不自动改写」 |
| R9 | **DataGrid 自带「保存到本地数据库 →」按钮**若原样挂进 ② 校对区，会与 MedBrief 的「入库这份报告」形成两个写库入口 | `DataGrid.jsx:1401` `onSave`；`IntakePage.jsx:681` 单张入库按钮 |
| R10 | 项目定制层缺失（按 §7.4 声明，不阻塞） | 本文件开头反查结果 |

## B. 正向排雷（F1…Fn）

| 编号 | 雷 | 处置 |
|---|---|---|
| F1 | 破坏性：改导入状态机/写库入口 | 只改前端判定与文案；**不动** `saveReport` 的入库载荷、`/api/intake/reports`、查重逻辑 |
| F2 | 连带：`onPointsChange` 若把 `standard_code` 等带进 `rows`，`saveReport` 会把它送进入库载荷，patch 白名单不认 | `fromPoints()` 只回吐 `{name,value,unit,refRange,code}`，与报告库同一函数；断言「多带字段不进 payload」 |
| F3 | 键一致性：`reportDate/barcode/fingerprint` 参与查重 | 日期/类型仍由 ② 校对区现有表单与 `item.meta` 管，DataGrid 的 `reportedDate/reportType` **只读镜像**同一 state，不另存一份 |
| F4 | 呈现误报：全文型报告 0 行时整份 DataGrid 会显示空网格，不能让用户以为「识别失败」 | **0 行也整份挂**（r1/r2：DataGrid 自带 0 点空态与智能补项，删掉 Empty）；空态文案由 DataGrid 自带，上方加一行「这是全文型报告，可在此补指标行」说明 |
| F5 | 测试污染现场 | 用现有 `tools/e2e-real-pdf.mjs` + Playwright；入库走副本库（`MEDBRIEF_REPORTS_FILE` 机制已有），收尾断言真实库 sha256 不变 |
| F6 | 调用面：② 校对区被 `renderItemBody` 复用，`ReviewPanel` 只管折叠 | 只改 `IntakePage.jsx`（renderItemBody + importAll + recognize）与 `ReviewPanel.jsx`（按钮文案/状态汇总）；**新建** `web/src/pages/intake/points.js` 抽出 `toPoints/fromPoints` 供两页共用（报告库改为 import，行为不变） |
| F7 | 部署态 | 改 `web/**` 必须 `MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web   # 显式 WEB_OUT；验收时浏览器硬刷新开页面`；**不改 lib/server**，5174 无需重启，但要自验 bundle 与 UI |
| F8 | 治理资产 | `.agents/plan-reportgrid-1115.md` 是「只做报告库」的旧口径 → 本方案落一份新计划并在旧文件顶部加交叉引用；`tests/verify-ui.mjs` 加断言防回潮 |
| F9 | 并发写冲突 | 派单按文件白名单：`IntakePage.jsx`、`ReviewPanel.jsx`、新 `points.js` 各一 owner；不合批改别人在途的 `outsourcing-log.md` |
| F10 | **R9 的双写入口 + r1 P0-1 + r2 ①** | DataGrid 的 `onSave` 不接 MedBrief 写库，只回写 `item.rows`；`date` 只能是 `meta.sampledAt`（**不许拿 reportDate 冒充**，会污染 feedback 与采集日输入），无采样日时自带保存按钮**该灰就灰**；由「入库这份报告 / 一键导入全部」唯一写库 |
| F11 | **R3 的反馈按钮 + r1 P0-2** | 录入面 `traceId=item.id`、`baselinePoints=toPoints(item.baselineRows)`；`baselineRows` 在 `recognize()` 成功时深拷贝；**并自行 `emitTrace(item.id, snapshot)`**，否则 `readTraceLocal` 无料、按钮亮但复制内容全 null |
| F12 | 已入库后再识别 | `recognize()` 对 `saved` 条目：不静默清标记；给出「这份已入库，重新识别会生成一份新的待入库内容」提示，确认后**新建/重置为未入库副本**，避免把已入库记录悄悄改没 |

## C. 逐项必要性（留 / 砍 / 延后+触发条件）

| 候选 | 不做会怎样 | 代价 | 收益 | 更便宜手段 | 判定 |
|---|---|---|---|---|---|
| ① ② 校对区整份挂 DataGrid（含代码列/审计色/一键修正/智能补项/粘贴解析/重新匹配/清空本次/复制反馈） | 用户点名的「整个组件搬过来」仍落空 | `IntakePage.jsx` 表格段替换 + `points.js` 抽取 + baseline/traceId | 兑现 R1/R2/R6 | 只加几个按钮（等于再写一套，漂移） | **留（MVP）** |
| ② `toPoints/fromPoints` 抽成共用模块，报告库改 import | 两页各写一份映射，改一处漏一处 | 新 1 文件 ~20 行 + 报告库 1 行 import | R5/F2/F6 | 复制粘贴（会漂移，砍） | **留** |
| ③ 一键导入状态机：按 4 态给**可操作**提示 + 按钮 disabled 语义 | 用户继续看到死提示、勾选/重新识别都无效 | `importAll` 分类汇总 ~25 行 + `ReviewPanel` title | 直接解决 R4 与用户第二问 | 改一句文案（不解决勾选/重识别无效，砍） | **留（MVP）** |
| ④ 已入库条目「重新识别」→ 待校对副本 + 明确「更新/另存」 | 「重新识别」永远无法改变可入库状态 | 新 `PUT /reports/:id` + `rowsReplace` 薄扩 + 一次确认 | F12 + r3 A（不产生两份同源） | `force:true` 重导（r3 实证会 push 第二条，砍） | **留（按 r3 A1 重写）** |
| ⑤ `baselineRows` + `traceId=item.id` 让复制反馈可用 | 按钮看得见点不了（R3） | 识别成功时深拷贝 1 次 | R3/F11 | 无 | **留** |
| ⑥ DataGrid 自带 `onSave` 不写库，只回写 item.rows | 两个写库入口（R9/F10） | props 接线 | 单一写库入口 | —— | **留** |
| ⑦ 批量导入纳入「0 行但有 text 的全文型报告」 | 全文型报告单张可入库、批量永远漏 | `targets` 加 `status!=='failed' && text.trim()` + `meta.textOnly=true` + 断言 | R4 第 ④ 态 | 维持现状（用户已抱怨流程不一致，砍） | **留（按 r1 P0-3 加护栏）** |
| ⑧ 把 corrections 表也用到**录入面**（未入库前就记操作） | 录入阶段的操作序列丢失 | 新端点/表写入时机 | 未被点名，且 R8 真值只认「已保存的手改」 | 入库后用报告库编辑面记（已有） | **砍**（收益未证且与 F1 冲突） |
| ⑨ 把勾选 `selected` 改成「勾选后批量导入」 | 用户试过勾选但没用 | 中 | 与 ③ 的「一键导入全部」语义重复 | ③ 的可操作提示 + 单张重识别已够 | **砍**（更便宜等价手段已有） |
| ⑩ 自动判断截图顺序 / N 张合并 | —— | 大 | 另一个已并入 v0.6 B2 的需求 | —— | **延后**：触发条件 = v0.6 B2 开工 |
| ⑪ 把 DataGrid 的 `date` 改成 DatePicker | —— | 中 | 表单组件替换是另一份已拍板方案（`.agents/forms-component-plan.md`） | —— | **延后**：触发条件 = 用户说「按 forms-component-plan 执行」 |

## D. 简化后的方案（只列留下的 ①–⑦）+ 触发条件 + 复跑命令

**实施三段（r3 P1）**：① `points.js` 抽取 + `importAll` 4 态分类（纯逻辑，先跑单测）→
② 挂 DataGrid + `date/sampledAt` + `onSave` 不写库（UI 层）→ ③ `emitTrace` / 0 点断言 / e2e。
每段独立门禁绿才下一段，不合批。

**D1 共用映射**：新建 `web/src/pages/intake/points.js` 导出 `toPoints/fromPoints`（从 `ReportsPanel.jsx:39-55` 原样搬）；
`ReportsPanel` 删本地定义改 import；`IntakePage` import 同一份。断言两页输出一致。

**D2 ② 校对区挂 DataGrid**（`IntakePage.jsx:590-620` 的 `<Table>` 段）：
- **整份挂、不再按 `rows.length>0` 条件**：0 行也渲染 `<DataGrid>`（r1：DataGrid 自带 0 点空态与
  智能补项/空白行，恰好是全文型报告补行的唯一手段；条件渲染＝半个组件）。删除原 `Empty` 分支；
- 受控 `points=toPoints(item.rows || [])`、
  `onPointsChange={(p)=>patchItem(item.id,{rows:fromPoints(p)})}`；
- `date = item.meta.sampledAt || ''`（**真·采集日**，`onDateChange` 写回 `meta.sampledAt`）、
  `reportedDate = item.meta.reportDate`（`onReportedDateChange` 写回 `meta.reportDate`）——
  r2 ①：不许把 reportDate 当 date，否则 `DataGrid.jsx:964` 的 feedback JSON 与 `:813` 采集日输入被污染。
  无采样日时 DataGrid 自带保存按钮保持禁用（该灰就灰），由下方「入库这份报告」唯一写库；
- `baselinePoints=toPoints(item.baselineRows||[])`、`traceId=item.id`，且 **`recognize()` 成功后
  自行 `emitTrace(item.id, snapshot)`**（P0-2：否则 `readTraceLocal` 读不到，按钮亮但内容全 null）。
  **r2 #1 修正**：OCR 响应无 `blocks`，snapshot 写
  `rawGrid:{kind:'layout-lines', lines: body.lines || body.layoutLines || []}`、
  `rawGridSource:'layout-lines'`、`ocrLoop:null`（如实标注不假造）、
  `traceSource:'recognize'`、`recognizedAt`、`durationMs`、`reportType`、`source: body.engine`。
  `emitTrace` 先写 localStorage 再 POST `/api/log`；`readTraceLocal` 只读 localStorage，
  **不依赖后端可用**，不新增端点；
- `reportedDate=item.meta.reportDate`、`reportType=item.meta.reportType`，`onReportedDateChange/onReportTypeChange`
  写回 `item.meta`（F3 单一 state）；
- `onSave` **不写库**，只 `patchItem({rows:fromPoints(editingPoints)})` 并提示
  「已应用到待入库内容，请点『入库这份报告』写库」；DataGrid 上方加一行说明：
  「本页『保存到本地数据库』＝应用到待入库内容，真正写库请用下方按钮」（按钮文案硬编码在 MedData 组件，
  不改跨项目文件）。写库仍由 `:681` 与「一键导入全部」唯一负责（F10/P0-1）；
- `embedded.css` 随组件引入；
- 「一键修正/智能补项/重新匹配/粘贴解析/清空本次/复制反馈」全部是 DataGrid 自带，不重写、不改红线（R8）。

**D3 一键导入状态机**（`IntakePage.jsx:412-424` + `ReviewPanel.jsx:19-25`）：把 `targets=[]` 的单一提示改成 4 态分类：
| 状态 | 提示（可操作） |
|---|---|
| 全部 `saved` | 「这 N 张已入库（报告号 …）。要改内容，请点该张『重新识别』生成待校对副本，再选『更新原报告』（**原地更新，不产生第二份**）或『另存为新报告』（**库里会有两份同源报告**）」 |
| 有 `dup` | 「N 张疑似重复已跳过；要强导请单独点该张的『入库』并确认仍要导入」 |
| 有 `failed`/未识别 | 「N 张未识别成功，请先『一键识别全部』或粘贴文本重新解析」 |
| 0 行但有 `text` | **纳入 targets**（⑦），硬条件 `status!=='failed' && text.trim()`；`saveReport` **仅该分支**在 payload 里临时带 `meta.textOnly=true`（r2 ③：条件加，不进公共 item.meta），走 `server.mjs:1585` 既有护栏；`rowsForType` 只在 OCR 端点 `:1505/:1568`，import 路径无门控 → 必须这样挡住假指标行（P0-3） |
| 真的 0 张 | 「还没有图片，先在 ① 导入」 |
按钮 title 同步显示分类汇总，不再一律「还没有可入库的条目」。

**D4 已入库后重新识别**（`recognize()`）：`item.saved` 时弹一次确认，确认后把该 item 重置为
**v0.4 按 r3 A 重写**：已入库条目点「重新识别」→ 确认后**生成一份新的待校对副本**
（新 id、`saved:false`、不写库、保留 `sourceReportId=原报告 id`），让用户改内容；
改完给两个明确动作：**「更新原报告」**（走扩后的 `PUT /reports/:id` + `rowsReplace` + **text 白名单**，
旧记录 `rows` 与 `text` 一起更新、原地不 push 第二条，patchLog 记 text 长度变化与
rows.added/removed 快照）/ **「另存为新报告」**（沿用现有单张「仍要导入」确认，文案写明「库里会有两份同源报告」）。
**批量路径没有任何自动强导**；`importAll` 汇总把「更新原报告 / 疑似重复跳过」分开报。
这样彻底不依赖 `force:true`，`server.mjs:1671` 的「长期两份同源」风险不再出现。
这样「勾选/重新识别」不再对可入库状态毫无影响，也不会把用户从一句死提示换成另一句死提示。

**D5 测试**：
- 新增 `tests/verify-intake-review.mjs`（纯函数 + DOM 层）：4 态分类各给对文案、`toPoints/fromPoints` 往返不丢字段、
  「一键修正」不改数值、`onSave` 不触发 `/api/intake/reports`；
  **0 点 5 条断言（r2 ⑤）**：0 行不崩/不除零、一键修正·复制反馈·保存恒灰、智能补项可点且能加行、
  空 baseline 不报错、`textOnly` 只在 0 行分支加（跑一次有行报告断言 payload 无该键）；
  **智能补项「可点且能加行，但该行 value 为空、不入库」**（r4）；
  **r3 B 三条断言**：`fromPoints` 保留 `inferred` 标记、`saveReport` 过滤空 value 行并报「N 行无值未入库」、
  **「智能补项后入库仍 0 行」**；**r3 A 两条断言**：「更新原报告」后 `reports.length` 不变、
  `rowsReplace` 的 from/to 全进 patchLog；
- 扩 `tools/e2e-real-pdf.mjs`（API 驱动，5175+副本库 ✅）：真 PDF 识别→入库→再点一键导入
  应显示「已入库」提示且真实库条数不变；点「重新识别」确认后应重新变为可入库；
  **UI 断言另用 Playwright 起同一副本服务**（r1 附问：e2e 脚本本身不驱动浏览器状态）；
- 现有门禁：`build:web`、`test:ui`、`test:no-web-logic`、`test:card`、`test:library`、`test:live`。

**验收判据（可复跑）**：
```
MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web   # 显式 WEB_OUT；验收时浏览器硬刷新开页面
npm run test:ui && npm run test:no-web-logic && npm run test:card && npm run test:library
node tests/verify-intake-review.mjs
node tools/e2e-real-pdf.mjs            # 副本库，真实库 sha256 前后一致
git status --porcelain                  # 真实库 data/reports.json 未被改动
```

**我无法自解的前提问题**：无。用户已明确「整个组件搬过来」+ 4 态死提示；本方案不新增依赖、不改后端、
不动 v2 的 B2–B5。

**复跑命令（取证用）**：
```bash
grep -n "没有可入库的条目\|!it.saved\|saved: true\|status: 'dup'" web/src/pages/IntakePage.jsx
grep -n "DataGrid\|toPoints\|fromPoints\|traceId" web/src/pages/intake/ReportsPanel.jsx
grep -n "disabled={!baseline.length || !traceId}\|一键修正\|数值永不自动改写\|onSave" meddata/src/components/DataGrid.jsx
grep -n "勾选做拼接\|selected.length" web/src/pages/IntakePage.jsx
```
