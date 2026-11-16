# ① 批量导入模块 —— 交互与界面重构（需求整理 + 排雷）**v0.2**

> 触发（用户原话，2026-11-16 22:58，附截图 2186×1480）：
> 「批量导入模块需要重新设计交互和界面。」
> 一、简化界面：①「选择和删除按钮是文字按钮，删除按钮可以换成 Icon 按钮。选择可以变成一个多选框。」
> ②「这个识别按钮做一下简化和必要分析。每个报告下方的识别可以去掉吗。只保留一键识别，如果某个识别错误，可以出现一个重新识别。」
> ③「重复报告的提示设计，在刚导入时就可以检测和提示。在点击识别后，也可以进行提示。」
> ④「当报告比较多的时候，需要选中报告，再跑到页面上方点击拼接，这样很麻烦，所以移动端和大屏端都应该将拼接等一些操作按钮放在页面下方浮动固定。」
> 二、移动端交互优化：「在下方固定操作区，用定位 Fixed。应该有哪些固定按钮？比如一键识别导入，一键删除，或者拆开，一键识别、一键导入。」
> 「可以再点选资料后，再出现需要点选之后的按钮：删除和拼接。如果选择一份报告，那么就在固定操作区出现删除。选择 2 份以上，出现拼接按钮。」
> 「如果再进一步优化，是不是可以隐藏其他无关按钮？」
>
> 排雷：**无项目定制层**（`grep -rlF '**通用层**：~/.agents/skills/plan-review.md' .` 命中 4 个文件，全是正文引用，不是文件头标记），仅通用层。
> 状态：**v0.2 方案，未编码**。作者：代诊-Manager。实现方：待定。审核：代诊-报告 r1 已出（**总判「只准哪几条」**：C-1/C-2/C-3/C-4/C-8/C-13 准予；C-5、C-7 准予附 1 条必改；**C-9 挂起**）。UI设计师 数值规格待回（`.agents/batch-import-1116-spec.md`）。

## 修订说明（v0.1 → v0.2，逐条对 r1）

| r1 编号 | 本版落点 |
|---|---|
| **P0-1** C-5 只查库不查本批 | D-1 第 5 条改为**两路预检**（库 / 本批）+ 批内命中「不新增第二张卡」写死 + 降级期保留 `name+size` 批内粗筛；新增 R11 记批内重复的取证 |
| **P0-2** R10 是必然、降级路径会废掉手机端 | R10 从 `[未取证]` 改为**已定案**（`server.mjs:1808` 绑 `0.0.0.0` + 安全上下文规范）；D-3 第 4 条新增并**推荐 (d) 纯 JS SHA-256**（~40 行 + 与 node `crypto` 对拍）；删除 (c)"按文件名对库" |
| **P0-3** 加固定栏前须先拆顶部冗余入口 | D-1 第 3 条新增 3.4/3.5：**同批删除** `UploadPanel.jsx:29-33` 与 `:56-63`；固定栏出现条件写死 `items.length>0 && sec==='upload'`；② 段隐藏且 `ReviewPanel.jsx:22-25` 不动 |
| **P1-1** `selected` 6 个引用（我说 3 处） | B/F1 数字订正为「2 文件 6 引用：`:223`、`:227`、`:57`、`:58`、`:61`、`:69`」，并加顺序语义落地要求 |
| **P1-2** 拼接产物没有 `File`/`size` | D-1 第 5.6 条：拼接图（`IntakePage.jsx:236-249`，无 `_file`、`size:null`）**不做文件级预检**，卡片标「拼接图（不查重）」 |
| **P1-3** 不要在 `addFiles` 里再拉一次清单 | D-1 第 5.4 条写死「复用 `loadReports()` 已加载 state，零额外请求」；副作用（440KB / 含 rows）记入 F6 |
| **P1-4** 图标不许 danger 红、全页不出现"删除" | D-1 第 1 条 + D-3 第 3 条：`DeleteOutlined` 非 danger 或 `MinusCircleOutlined`，`aria-label="移除此文件（未入库）"`，① 段全页只用「移除」 |
| **P1-5** C-9 无服务端护栏 | C-9 改**挂起**，附放行实测（4 张 ×4000px 的字节数/耗时） |
| **P1-6** 端口 5193/5199 已被占 | D-5 验收脚本用 **5194/5195** |
| **P1-7** "无固定栏先例"表述不准 | R/N4 改为「页面层无先例；`web/src/meddata/embedded.css:402/405` 是第三方 Tailwind 产物里的 `.fixed`/`\!fixed`，`CardPreview.jsx:8` 是注释」 |
| 事实订正：`done` 态今天已有「重新识别」 | C-4 / D-1 第 2 条改为「**收紧成条件渲染** + failed 补「重试」」，不再是"新增" |
| 事实订正：`status:'dup'` 消费点 4 处 | F3 改为 4 处（`UploadPanel.jsx:21`、`IntakePage.jsx:447-453`、`:506-523`、`:573`），并新增两 Tag 文案区分要求 |
| 事实订正：C-6 的砍理由 | 改为**数据责任**：`saveReport` 是唯一写库入口（四分支：查重/空值过滤/`textOnly`/更新原报告，`IntakePage.jsx:420-470`），② 是唯一人工复核点 |
| r1 §3-⑤ 六条四档断言 | 收进 D-4（原文照抄，含 90vh 反证防空过） |

---

## 0. 需求整理（N1~N7，验收靠这张表）

| # | 用户要求 | 归类 | 读法 |
|---|---|---|---|
| N1 | 「选/删」文字按钮 → 删改 Icon、选改 Checkbox | 呈现层替换 | 卡片头 1 个 checkbox + 1 个**非 danger** 图标按钮（「移除」）；不新增第二个图标 |
| N2 | 去掉每卡「识别」，只留一键识别；错了才出「重新识别」 | 按钮收敛 + 条件渲染 | `pending` 无按钮；`done` 出「重新识别」（**现状已有**，`:120` 的文案三元）；`failed` 出「重试」 |
| N3 | 重复提示前移到「刚导入」 | 能力新增 | **两路**（批内 + 对库）× **exact sha256**；单据级必须 OCR 后（见 R4） |
| N4 | 拼接等操作放下方浮动固定（移动端 + 大屏） | 布局机制新增 | 页面层**无先例**（P1-7 表述订正），要 UI 出数值 |
| N5 | 固定区按钮：一键识别 / 一键导入 / 一键删除（拆或合） | 交互契约 | **不合并**识别与导入（C-6，数据责任） |
| N6 | 点选后才出按钮：1 份→删除、≥2 份→拼接 | 渐进暴露 | 选中态驱动按钮出现 |
| N7 | 「隐藏其他无关按钮」 | 扩展 | 未选中时只露 2 主操作 + 「更多」 |

## A. 反向排雷（现有现实 → 新方案的前提）

- **R1｜「要滚回顶部才能拼接」成立。** `UploadPanel.jsx:56-63` 的「已勾选 N/2 / 拼接选中的两张 / 清空勾选」整行排在 `:66` 的卡片 `Row` **之前** ⇒ 报告一多必滚回顶部。
- **R1b｜「每卡识别」与「顶部一键识别」是两层入口。** `UploadPanel.jsx:119-121`（每卡 `block` 按钮）+ `:29-33`（一键识别全部）。
- **R2｜删/选确是文字按钮。** `UploadPanel.jsx:104-110`：`删` = `type="text" danger` 两个汉字；`选/已选` = 普通 `size="small"`。
- **R3｜查重只在入库那一步。** `dupCount` 只统计 `status==='dup'`（`IntakePage.jsx:573`）；`status='dup'` 只由 `recognize()` 拿到 `body.duplicate` 时设置（`:447-453`）；后端唯一判定点 `server.mjs:1683`。⇒ 导入→无信息；识别→也不查重；**入库才拦**。
- **R4｜导入一刻只能判 exact sha256 —— 但**批内**那一层客户端能判，v0.1 漏了（P0-1）。**
  ① 现成口径：`docs/导入工作流.md:33` 四层判重 = 「① sha256 字节级 ② 原件已在 `data/intake/**/archive` ③ 库里同「单号+报告日期」④ **批内**同「单号+类型+日期」」，并写明**不用 dHash 单独判重**。②③④ 都要服务端状态或 OCR 结果 ⇒ 导入一刻只有 ①。
  ② dHash 不能前移：`lib/reportIntake.mjs:113-120` 实测「『凝血 07-26』与『凝血 08-04』汉明距离 = 0，14 张不同影像报告会被聚成一簇」⇒ C-10 砍。
- **R5｜不必加端点。** `GET /api/intake/reports` 是 `...r` 展开、只把 `text`/`images` 置 `undefined`（`server.mjs:1005-1013`）⇒ **`sha256` 在返回体里**；`loadReports()` 已放进 state（`IntakePage.jsx:139-150`），且每次入库成功后重调（`:441`、`:556`）。
- **R6｜前端没有文件指纹。** `addFiles()` 只建 `{dataUrl:'', _file}`（`IntakePage.jsx:153-183`）；`sha256` 一直由后端在入库时算（`server.mjs:1667`）。
- **R7｜2 张上限纯前端。** `toggleSelect` 超 2 挤掉最早的（`:214-221`）、`doStitch` 校验 `!== 2`（`:222-231`）；服务端 `/api/intake/stitch` 只校验 `images` 非空（`server.mjs:1387-1392`），`stitchVertically` 吃数组（`lib/reportIntake.mjs:141`）。
- **R8｜「一键识别」与「一键导入」分居两个面板。** `UploadPanel.jsx:29-33` vs `ReviewPanel.jsx:22-25`（经 `IntakePage.jsx:905` 传入）。
- **R9｜卡片占屏。** `Col xs={24}`（`UploadPanel.jsx:68`）+ 120px 缩略图 + 信息行 + `block` 按钮 ⇒ 375 下约 3.7 张/屏。
- **R10｜手机端必然算不了 `crypto.subtle`（已定案，不是待取证）。**
  `server.mjs:1808` `server.listen(PORT, '0.0.0.0')` ⇒ 手机只能走 `http://<局域网IP>:5174`，不可能是 `localhost`/`127.0.0.1`；`crypto.subtle` 只在安全上下文（`https:` / `localhost` / `127.0.0.1` / `file:`）存在 ⇒ **手机端 `window.isSecureContext === false`**。⇒ 若只做原生 WebCrypto，N3 在手机端（= 主场）等于没做。
- **R11｜同批内重复完全可以复现，且现在没有任何拦截。**
  `addFiles()` 对每个文件**无条件** `setItems(prev => [...prev, ...accepted])`（`IntakePage.jsx:180`）；整页粘贴走同一函数（`:198-206`）。同一张图"拖一次 + ⌘V 一次"⇒ 两条独立 `uid()` 都进列表；直到入库第二条才被服务端拦（`server.mjs:1683`），且批量路径是 `silent:true` ⇒ 用户只看到一句汇总「N 张疑似重复已跳过」（`IntakePage.jsx:523`）。**这就是用户说的"导入过程中误操作重复导入"。**

## B. 正向排雷（新方案 → 现有消费方）

- **F1｜`selected` 的消费面是 2 文件 6 引用，且带顺序语义。**
  `IntakePage.jsx:223`（`!== 2` 闸）、`:227`（解构前两张）、`UploadPanel.jsx:57`（`N/2` 文案）、`:58`（`disabled`）、`:61`（清空）、`:69`（`picked` 样式）。
  改通用多选要同时：① `toggleSelect` 不再截断（上限 4）；② `doStitch` 改 `>=2`；③ 文案去 `/2`；④ **顺序 = 勾选顺序**并显示 `①②③`（否则拼接上下顺序随机）。
- **F2｜`removeItem` 是内存删除。** `IntakePage.jsx:208-212` 只 `setItems(filter)`，无任何服务端调用 ⇒ 文案必须写「移除（未入库）」，且①段全页不出现"删除"二字（P1-4）。
- **F3｜`status:'dup'` 的消费面 4 处，不许复用。** `UploadPanel.jsx:21`（`疑似重复 N` Tag）、`IntakePage.jsx:447-453`（`recognize` 分支 + `pushLog` + `return {duplicate:true}`）、`:506-523`（`classifyImportable` 的 `c.dup` 与"已跳过"文案）、`:573`（`dupCount`）。
  ⇒ 预检结果用独立字段 `predup: {kind:'exact-file-batch'|'exact-file-lib', of}`，不阻断 `classifyImportable` 分类；两处 Tag 文案写死不同词：**「已在本次导入中」（批内）** / **「库内已有同一文件」**（对库）；入库时判定仍写「疑似重复（入库时判定）」。
- **F4｜遮挡不只最后一项。** ② 段真正的底部按钮在**每项 Collapse 内部**（`IntakePage.jsx:835` 的「入库这份报告」）⇒ 只补 `padding-bottom` 挡不住展开态。处置：`sec==='review'` 时**整条隐藏**固定栏（复用 `IntakePage.jsx:126-140` 的 observer），② 的入口留在 `ReviewPanel.jsx:22-25` 不动；**不做 sticky 顶栏**（顶部吸顶分段条已占 56px，`scrollMarginTop: 56`）。
- **F5｜测试污染。** 模板用 `tests/verify-reports-refresh.mjs`（`PORT=5193` + `MEDBRIEF_REPORTS_FILE`/`MEDBRIEF_DATA_DIR` 指副本，`:27-30`）；**本计划验收用 5194/5195**（5193/5199 已被 `verify-reports-refresh` / `verify-report-delete` 占），真库零写入。
- **F6｜不改 `server.mjs` 的两条都成立，但各带副作用。** 预检走既有 GET（副作用：响应 440KB 且含 `rows` ⇒ **不在 `addFiles` 里重复请求**，用 state）；多张拼接走既有 POST（副作用：服务端**无数量/尺寸护栏**，见 C-9）。
- **F7｜部署态。** `web/**` 改完必须 `MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web` + 硬刷新；因不动 `lib/**`/`server.mjs`，**不需要重启 5174**。
- **F8｜治理资产。** `docs/导入工作流.md:33` 的判重四层要补一句「客户端预检只做 exact 字节（批内 + 对库），dHash 永不预判」，否则下个会话会把预检当单据级查重。
- **F9｜并发写。** 只动 `web/src/pages/intake/UploadPanel.jsx`、`web/src/pages/IntakePage.jsx`、（可能）`shared.js`；r1 复核时这三个文件无在途改动。开工前再核一次。

## C. 逐项必要性（留 / 砍 / 延后 / 挂起）

| # | 候选改动 | 不做会怎样 | 代价 | 收益 | 更便宜的等价手段 | 结论 |
|---|---|---|---|---|---|---|
| C-1 | Checkbox 取代「选/已选」 | 每卡多占宽/高，375 更挤 | 小 | N1、R9 | 无 | **留（准予）** |
| C-2 | 删除改 Icon（**非 danger**） | 「删」两字被挤、误读成删库 | 小 | N1、F2 | 无 | **留（准予）** |
| C-3 | 撤掉每卡「识别」整行按钮 | 两层重复入口（R1b）；每卡多 32px 高 | 小 | N2、R9 | 收成角落小图标（仍有 N 入口） | **留（准予，同批删顶部一键识别）** |
| C-4 | `done`/`failed` 才出重新识别/重试 | 识别错了只能整批重跑 | 小 | N2 | 无 | **留（准予；实为"收紧为条件渲染"+补 failed）** |
| C-5 | 导入即提示（**批内 + 对库** exact sha256） | 误选两次要等入库才被静默跳过（R11） | 中（哈希 + UI 位 + 降级分支） | N3、R4、R11 | 只在识别后提示（现状，被用户点名要前移） | **留（准予 + P0-1 两路 + P0-2 (d) 纯 JS 哈希）** |
| C-6 | 识别与导入合并 | 用户要跨两个面板点两次（R8） | 中高 | — | 固定栏并排放 + "识别完要校对"提示 | **砍**（数据责任：`saveReport` 唯一写库入口，② 是唯一人工复核点） |
| C-7 | 下方浮动固定栏 | 报告多要滚回顶部（R1） | 中 | N4 | sticky 顶栏（更差，F4） | **留（准予 + P0-3 删顶部冗余）** |
| C-8 | 按钮随选中态渐进出现 | 栏内 4-5 个按钮挤成一排 | 小 | N6、N7 | 无 | **留（准予）** |
| C-9 | 多张（>2）拼接 | 一张单拍成 3 段要拼两次 | 小（前端放开）但**服务端无护栏** | 覆盖 3-4 段单据 | 拼两次（现状能用） | **挂起**：放行需一条实测（4 张 4000px 图 → 字节数 ≤8MB、耗时 ≤2s） |
| C-10 | dHash 预检 | — | 中且必误报（R4） | — | — | **砍** |
| C-11 | 三个 Tag 搬进固定栏 | — | 小 | 计数可见 | 卡片已有状态 Tag | **砍** |
| C-12 | 卡片横向紧凑布局 | 375 一屏 <2 张 | 中 | 一屏更多张 | C-1~C-3 先做 | **延后**（触发：C-1~C-3 后 375 实测可见卡 <2 张） |
| C-13 | 「更多」收「清空勾选」 | 低频按钮占位 | 小 | N7 | 无 | **留（准予）** |

## D. 简化后的方案 + 验收断言 + 前提问题

### D-1 留下的项（含 r1 必改）

1. **卡片头**：`Checkbox`（受控，`picked` 样式沿用 `UploadPanel.jsx:69` 的描边）+ 状态 Tag + 文件名（`ellipsis`，tooltip 保留）+ **非 danger** 图标按钮（`DeleteOutlined` 或 `MinusCircleOutlined`，`aria-label="移除此文件（未入库）"`，触摸区 ≥44px）。① 段全页只用「移除」，**不出现"删除"二字**。
2. **收紧每卡按钮**：`status==='pending'` 不出按钮；`done` 出「重新识别」（现状 `:120` 已有）；`failed` 出「重试」（新增）。整行 `block` 按钮改为角落小按钮或卡底小行（由 UI 规格定，需给理由）。
3. **下方浮动固定栏**（P0-3 必改落点）：
   - 3.1 位置 `fixed; bottom:0`，`z-index` 高于内容、低于 antd Modal；`padding-bottom: calc(12px + env(safe-area-inset-bottom))`（数值待 UI 定）。
   - 3.2 出现条件写死：`items.length > 0 && sec === 'upload'`（无文件不出现空栏；② 段隐藏）。
   - 3.3 三态：未选中 → `一键识别（N）` + `一键导入（M）` + 「更多」；选中 1 → `移除选中`（+ 主操作弱化）；选中 ≥2 → `拼接选中（N）` + `移除选中`；批量中 → `识别中 d/t` + `停止`（沿用 `batch`）。
   - 3.4 **同批删除顶部两处冗余**：`UploadPanel.jsx:29-33`（一键识别全部）与 `:56-63`（勾选文案 + 拼接 + 清空勾选）整行移除，改由固定栏承载；`清空勾选` 进「更多」（C-13）。顶部只保留计数 Tag（`共 N / 待识别 / 未识别 / 疑似重复`）。
   - 3.5 ② 段隐藏靠 `sec`（`IntakePage.jsx:126-140` 的 observer 现成）；① 段内容容器补 `padding-bottom = 栏高 + 安全区`。
4. **多选语义**：`selected` 改通用多选，上限 4；顺序 = 勾选顺序；卡片显示 `①②③`；`doStitch` 改 `>=2`（C-9 挂起前，前端仍按 2 张启用，多张开关一并挂）。
5. **导入即查重（P0-1/P0-2 必改）**：
   - 5.1 哈希：`crypto.subtle.digest('SHA-256', buf)`；不可用时（`!window.isSecureContext` 或 `!crypto.subtle`）走 **纯 JS SHA-256**（~40 行、零依赖，配 `sha256Hex('abc')` 与 node `crypto` 对拍断言）。
   - 5.2 两路比对：① 与 `loadReports()` state 的 `sha256` 集合（对库）；② 与本批 `Map<sha256, itemId>`（批内）。
   - 5.3 命中行为写死：**批内**命中 ⇒ 不新增第二张卡，`message.warning('这张图本次已选过，已跳过')` + `pushLog`；**对库**命中 ⇒ 正常建卡但打 `Tag`「库内已有同一文件」并记 `predup`。
   - 5.4 零额外请求：复用 `loadReports()` 已加载 state（F6 副作用记账）。
   - 5.5 降级粗筛：哈希完全不可用时，**批内**用 `name+size` 相同判"疑似误选两次"（零成本、不依赖 crypto）；**绝不**用于对库（库不存文件名）。
   - 5.6 拼接图（`IntakePage.jsx:236-249`，无 `_file`、`size:null`）**不做预检**，卡片标「拼接图（不查重）」。
   - 5.7 判定真相仍归服务端 `findDuplicate`（`server.mjs:1683`）；前端只做提示，不改入库结果。
6. **识别后提示**保持，但文案两口径分开：「库内已有同一文件」（exact）/「疑似重复（入库时判定）」（单据级，现状 `dup`）。
7. **顶部计数 Tag 保留**（仍是复核入口），「更多」只收「清空勾选」（C-13）。

### D-2 挂起 / 延后 / 砍（触发条件）

- **C-9 多张拼接（挂起）** —— 放行条件：一条实测 `POST /api/intake/stitch` 拼 4 张 4000px 高的图，返回 `dataUrl` 解码字节 ≤8MB 且耗时 ≤2s（`lib/reportIntake.mjs:144-161` 无护栏，靠前端兜不住 OOM）。未通过则保持两两拼接。
- **C-12 卡片横向紧凑（延后）** —— 触发：C-1~C-3 后 375 实测可见卡 <2 张。
- **C-10 dHash 预检（砍）** —— 因 `lib/reportIntake.mjs:115` 反例冲突。
- **C-11 Tag 进固定栏（砍）** —— 卡片已有状态 Tag。
- **C-6 合并识别与导入（砍）** —— 数据责任，见 C 表。

### D-3 需要用户拍板的 4 条前提（未答则按建议执行）

1. **固定栏是否在 ② 校对区常驻** → 建议**隐藏**（F4：会盖住每项 Collapse 内的「入库这份报告」，`:835`）。
2. **「一键导入」语义** → 建议**不合并**，按钮 tooltip 写死「只入库已识别的 N 张」（`classifyImportable` 只取 `lab`/`textual`，`:513-515`）。
3. **「移除」范围** → 只移除本次未入库条目；库内删除是 `intake-dedupe-1116`（另一条线）。**三道锁**：① 段不出现"删除"二字、图标非 danger、确认文案写「这 N 张还没入库，移出后需重新导入」。
4. **手机端哈希降级** → **推荐 (d) 纯 JS SHA-256**（r1 P0-2）：两端行为一致，不给"这个端不查重"的例外。备选 (a)：接受降级但 UI 明写「本端未做文件查重」（不许静默）。(c)（按文件名对库）已删 —— 库内无文件名（`sourceFile` 是归档路径、`imageRef` 是 `sha256:`）。

### D-4 验收断言（r1 §3-⑤ 原文照抄，四档各跑一次：375 / 414 / 768 / 1440）

1. 栏存在且是 fixed：`getComputedStyle(bar).position === 'fixed'`
2. 栏在视口内完整可见：`bar.getBoundingClientRect().bottom <= innerHeight + 1 && bar.top >= 0`
3. **不遮内容**：`window.scrollTo(0, document.body.scrollHeight)` 后，① 段最后一个可交互元素 `el.bottom <= bar.top + 1`
4. **不遮入库按钮**：② 段展开最后一个 Collapse 项，`#btn-import-item`（给 `IntakePage.jsx:835` 加 `data-testid`）的 `bottom <= innerHeight`
5. **不新增横滚**：`document.documentElement.scrollWidth <= innerWidth + 1`（四档 + **改前也跑一次**作 must-be-0 基线）
6. **安全区**：`getComputedStyle(bar).paddingBottom >= 8px`，且 CSS 里出现 `env(safe-area-inset-bottom)`（桌面计算值为 0，只断言声明存在）
7. **遮挡反证（防空过）**：把栏高硬编码成 `90vh` 跑一次 ⇒ 第 3、4 条必须变红

另需断言（本计划新增，C-5/C-7）：
8. 批内重复：同一 `File` 选两次 ⇒ `items.length` 只 +1，且出现「这张图本次已选过」提示
9. 对库重复：用副本库已有 `sha256` 的图 ⇒ 建卡且 `Tag`「库内已有同一文件」出现，`predup.kind === 'exact-file-lib'`
10. 顶部冗余入口已删：`grep -c "一键识别全部" UploadPanel.jsx === 0`、`grep -c "拼接选中的两张" === 0`
11. 纯 JS 哈希对拍：`sha256Hex('abc') === ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`（与 node `crypto` 同值，已用 `node -e` 取过基准）

### D-5 复跑命令清单（本版结论的证据）

```bash
cd /Users/scallion/Documents/projects/MedBrief
grep -n "已勾选\|拼接选中的两张\|清空勾选" web/src/pages/intake/UploadPanel.jsx   # R1 顶部冗余入口
sed -n '100,125p' web/src/pages/intake/UploadPanel.jsx                            # R2/R1b/C-4 现状按钮
sed -n '153,183p;208,232p' web/src/pages/IntakePage.jsx                           # R6/F1/R11 addFiles 无去重
grep -n "setItems((prev) => \[...prev, ...accepted\])" web/src/pages/IntakePage.jsx # R11 无条件 push
grep -n "server.listen" server.mjs                                                # R10 0.0.0.0 ⇒ 手机非安全上下文
sed -n '1003,1014p' server.mjs                                                    # R5/F6 列表含 sha256 + 体量
sed -n '1384,1396p' server.mjs; sed -n '141,162p' lib/reportIntake.mjs             # R7/C-9 无护栏
grep -n "凝血 07-26" lib/reportIntake.mjs; sed -n '33p' docs/导入工作流.md          # C-10 dHash 不预判
sed -n '18,26p' web/src/pages/intake/ReviewPanel.jsx                               # R8 ② 侧入口
grep -n "PORT" tests/verify-reports-refresh.mjs tests/verify-report-delete.mjs      # F5 端口占用
grep -rn "position.*fixed" web/src --include=*.jsx --include=*.css | wc -l          # N4 页面层无先例（3 处＝第三方产物 2 + 注释 1）
```

---

**下一步**：本文件（v0.2）已送 代诊-报告 r2（`.agents/batch-import-1116-review-input-r2.md`）。终判「可以开工」+ 用户说「按以上计划执行」后才编码；UI 数值规格回填后进 v0.3（若 r3 需要）。
