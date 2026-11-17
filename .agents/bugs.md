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

## Bug 11 【护栏·2026-11-16】端到端类型判定 4 条错判（`test:library` 只量了「标题」这一段路）

- 症状：`npm run test:library` 11 通过 / 1 失败，失败文案是「标题覆盖太低（35/95），类型识别对真实数据不可用」。
  **这句文案把它自己说的范围说大了**：`:133-140` 用的是 `classifyByTitle(r.text)`，量的是**第一段路径**；
  真实机制是三段（标题 → 项目集反推 → 正文兜底，`lib/reportTypeDetect.mjs:200 detectReportType`）。
  ⇒ 之前两次把「标题覆盖 35/95」当成「60 份认不出类型」（`grid-narrow-1116-plan.md` §9.24/§9.25 已自纠）。
- **端到端实测（只读，`tools/type-coverage-report.mjs`，2026-11-16，真库 95 份）**：

  | 路径 | 覆盖 | 不符 | 未认出 |
  |---|---|---|---|
  | A 标题 `classifyByTitle` | 35/95 | 0 | 60 |
  | B 标题∪项目集（全 95 口径） | 82/95 | 0 | 13 |
  | B′ 标题∪项目集（仅 57 份有指标行 = `verify-library:147` 口径） | 50/57 | 0 | 7 |
  | **C 端到端（含正文兜底）** | **95/95** | **4** | **0** |

- **4 条错判明细**（`证据=body-keyword`，全部发生在正文兜底这一段）：

  | id | 库内标注 | 端到端判出 | 疑似成因（`文件:行`） |
  |---|---|---|---|
  | `rep_mwean71gtdu` | 戊肝抗体 | 化验其他 | 标题词表有 `[/戊型\|戊肝\|HEV/, '戊肝抗体']`（`reportTypeDetect.mjs:84`），正文兜底的 `LAB_PANELS`（`reportClassify.mjs:39-51`）**无此小类** ⇒ 该项目名不命中任何板块，落「化验其他」(`:145`)；该报告有 2 条指标行、标题路径 `null` |
  | `rep_mwean71oh37` | 甲肝 IgM | 化验其他 | 同上：`reportTypeDetect.mjs:83` 有 `甲肝 IgM`，`LAB_PANELS` 没有；该报告有 1 条指标行、标题路径 `null` |
  | `rep_mwean7qjqxu` | CT-血管增强 | CT-胸部 | `CT_PARTS`（`reportClassify.mjs:62-67`）**「CT-胸部」排在「CT-血管增强」之前**，CTA 正文里的「肺动脉干 / 胸主动脉」先命中「胸部\|肺」 |
  | `rep_mwefj3rjmjz` | 融合基因 | 流式免疫分型 | 正文兜底把「流式」排在「基因」之前（`reportClassify.mjs:94-102`，为防「结论模板引用融合基因」反咬而设计），该 31KB PDF 正文含流式关键词 ⇒ 需拿原件核「库标注侧」还是「序侧」 |

- **可复跑命令（只读，自带 sha256 自证）**：
  ```
  node tools/type-coverage-report.mjs                                   # C 有不符 exit 1；库读不到 exit 2；只读，末尾自证 sha256 前后一致
  MEDBRIEF_REPORTS_FILE=<副本库> node tools/type-coverage-report.mjs     # 拿副本库比对时用（真库零写入）
  ```
- **口径（2026-11-16 UI设计师 裁定，不许放宽）**：
  1. **不设「泛类降级豁免」** —— 允许「降级到化验其他不算错」等于把所有指标类降成化验其他就全绿（空过家族）。
  2. 端到端断言与标题断言**并存**：`bad === 0`（不豁免）+ `unknown <= BASELINE_UNKNOWN`（未认出不算不符但不许增长）+ 打印 `覆盖/不符/未认出` 三个数。
  3. **40% 阈值不许下调**；`unknown` 优先于硬猜（对应「绝不硬猜」铁律）。
  4. 另建议：`reportTypeDetect` 与 `reportClassify` 的 reportType 词表应引用**同一份导出常量**（或加差集断言），防两套词表漂移再次发生。
- 归属：**报告类型识别一线**（`lib/reportTypeDetect.mjs` / `lib/reportClassify.mjs`），不进 D-1 绿、不进 UI/交互范围；与 D-2 并行、由主理人分派。
- 再触发条件：主理人分派后开工；或 `node tools/type-coverage-report.mjs` 的 `C 不符` 数不再是 4。
- 防改崩：本台账**只立账，不动词表**（改 `LAB_PANELS` 顺序/补小类会影响入库 `reportType` 与历史 95 份的筛选口径，须先过计划流程）；`data/reports.json` 是 gitignore 的，改前备份到 `data/backups/`。

## Bug 12 【待修·2026-11-17】`criticalOf()` 把定性阴性数值化成假危急（粪便「白细胞 阴性」→ WBC 0 危急）

- **症状**：`criticalOf({code:'WBC', value:'阴性', num:0, status:'normal', flag:'negative'})` 返回 `{label:'WBC', range:'<1.0 或 >50', value:0}`。库里 **2026-08-03 / 08-04 两份粪便常规「白细胞 阴性」**正是这个形状（`code=WBC, num=0, flag=negative, status=normal`）。今天被「每项只看最近一次」的折叠掩盖（`p0rows` 无 WBC 行），模块①新增「当前危急值（单次事件）」若全库扫就会把「粪便白细胞阴性」渲染成「WBC 0 危急」——**呈现层误报（F4）的现成样本**。
- **根因**：`lib/cardPolicy.mjs` `criticalOf()` 直接 `Number(row.num ?? row.value)`，`num=0` 是 OCR 把定性「阴性」数值化的产物，却当真值进了 `<1.0` 阈值。
- **修法（A-数据层，未编码）**：`criticalOf` 取 num 之前加 `if (!/^[+-]?(\d|\.\d)/.test(String(row.value ?? '').trim())) return null`。
  - 不用 `Number.isFinite(Number(value))`：它把 `'0.5×10^9'` 带单位值判 NaN 也漏掉（r4）。
  - 不用 `/^-?\d/`：它漏 `'+0.5'`/`'.5'` 两个真值（r4，假阴性比误报更危险）。
  - 定稿正则五态实测：阴性→null ✅ / `0.71`→报 ✅ / 真 `0`→仍报 ✅ / ` 0.5`→报 ✅ / `1e-3`→报 ✅；`+0.5`/`.5`→报 ✅。
- **断言要求**：构造测试必须用**真实形状**（`flag:'negative', status:'normal', value:'阴性', num:0`），不能用 `status:'negative'`——后者是错的形状，按其写断言会「成功≠修好」（审核 r3 实测踩过）。补假阴性回归位 `+0.5`/`.5`/带空格。
- **归属**：模块①分层计划 A-数据层（`.agents/card-risk-appendix-1117-plan.md` v0.5 D-4b）；审核 r2 首报、r3 修正修法、r4 定稿正则。
- **再触发条件**：用户「按以上计划执行」授权后随 A-数据层落 `lib/cardPolicy.mjs` + `tests/verify-card-module1.mjs` 断言。

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
