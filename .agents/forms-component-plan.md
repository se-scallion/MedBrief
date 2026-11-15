# 全项目表单组件替换计划（2026-11-15，待确认后执行）

> 触发（用户原话）：「你的编辑表单项 报告日期，没有使用 Ant Design 的标准组件。请你反省所有表单，以及反省整个项目应该用哪个组件做一个替换计划吧。」
> 状态：**方案，未编码**。按口径「先给方案与改动清单，确认后执行」。
> 排雷：plan-review 通用层（无项目定制层 —— 反查 `> **通用层**：~/.agents/skills/plan-review.md` 为 0 命中；
> `.agents/plan-stitch-2line-1115.md` 里那句是"无定制层"的**引用文字**，不是文件头标记，不算定制层）。

---

## 0. 先认账：这不是「没有组件」，是「有标准组件但我没用」

| 事实 | 证据 |
|---|---|
| antd **6.6.6** + dayjs **1.11.23** 已声明 | `package.json:52-53` |
| 全局已 `dayjs.locale('zh-cn')` | `web/src/main.jsx:6-10` |
| 项目里**已经有正确范本**：`DatePicker` + `format="YYYY-MM-DD"` + `disabledDate` | `web/src/pages/BookingForm.jsx:3,7,272,552-562` |
| 出问题的两处仍用裸 `<Input placeholder="YYYY-MM-DD">` | `web/src/pages/IntakePage.jsx:653-659`、`web/src/pages/intake/ReportsPanel.jsx:484` |
| 全项目 **9 个页面**含表单控件，共 ~93 处；`<Input>` 占绝大多数 | `grep -rE "<(Input|InputNumber|DatePicker|Select|Switch|Radio|Checkbox|Segmented|Form.Item)" web/src/pages` |

**结论**：`BookingForm` 是我自己写的、用对了；识别/报告库这条线是后来边补边加的，一路用最省事的 `<Input>` 顶上去，没有回过头统一。这是贯彻问题，不是框架能力问题。

## 1. 全量控件盘点（逐文件，可复跑）

| 文件 | 控件数 | 现状 | 语义错配 |
|---|---:|---|---|
| `pages/intake/PatientForm.jsx` | 37 | `<Form>` + `Form.Item`，以 `Input`/`Input.TextArea` 为主，`Select`(性别) + `Radio.Group`(有无) | **年龄** `name="age"` 用 `<Input placeholder="如 34">`（`:117`）→ 该 `InputNumber` |
| `pages/BookingForm.jsx` | 16 | `<Form>` + `DatePicker` + `AutoComplete` + `Select` 等 | 无（这是正确范本） |
| `pages/BriefPage.jsx` | 10 | `<Form>` + `Input` / `Input.TextArea` | 身份证号 `maxLength={18}` 用 Input（`:292`）——字符串而非数字，保留 Input 合理，仅补 `inputMode` |
| `pages/IntakePage.jsx` | 9 | **无 Form**，用 `<Space>` + `<span>` 手包 `<Input>`/`<Select>` | **报告日期** `:653` 用 `<Input placeholder="2026-11-01">` → 该 `DatePicker`；项目名/值/单位/参考（`:480,496,505`）是表格内联编辑，保留 Input |
| `pages/intake/ReportsPanel.jsx` | 9 | **无 Form**，`<span>` 手包 `<Input>` | **报告日期** `:484` 用 `<Input placeholder="YYYY-MM-DD">` → 该 `DatePicker`；指标行表格内联编辑保留 Input |
| `pages/card/SourceModal.jsx` | 5 | 无 Form，`<Input addonBefore>` | **页码** `:180` 用 `<Input width=48>` 配 `Math.max(1,Number(...))` → 该 `InputNumber min=1`；数值 `:262` 是化验结果字符串（可含 `<0.01`、`阴性`），**不能换 InputNumber** |
| `pages/MonitorPage.jsx` | 3 | Switch + Select | 无 |
| `pages/card/TimelineTab.jsx` / `OverviewTab.jsx` | 各 2 | `Input.Search` + `Segmented` / `Checkbox.Group` | 无（筛选器，非录入） |
| `pages/card/CardPreview.jsx` | 1 | Switch（脱敏） | 无 |

**日期字段在前端共 2 处录入**，都是裸 Input；另有 1 处「采样时间」是只读灰字（`IntakePage.jsx` 的 `Tooltip`），不用动。

## 2. 反向排雷（R，现象 → 前提）

| 编号 | 结论 | 证据 |
|---|---|---|
| R1 | **用户说的「报告日期没识别」是另一件事，且已修**：`rep_mwh9w5et3um` 的 `createdAt=2026-11-15T03:26Z`（本地 11:26），而日期修复 `eca9de7` 落地 12:15 —— 记录是在修复**之前**入库的，文本里明明有 `报告日期：2026-9-30`。当前 `guessMeta(text)` 实测返回 `2026-09-30`；原件重跑 5174 也返回该值 | `git log --format=%ci -- lib/reportMeta.mjs`；`node -e` 调 `guessMeta`；`/api/intake/ocr` 实测 |
| R2 | **但用户观察到的「表单项不标准」完全成立**，且我此前没发现 | `IntakePage.jsx:653`、`ReportsPanel.jsx:484`；对照 `BookingForm.jsx:552` |
| R3 | **不是「全项目都该重写」**：4 个页面已用 `<Form>`，其中 BookingForm 是标准写法；真正错配只有 **3 类 / 5 个控件** | 上表 |
| R4 | **日期在后端/卡片/排序/趋势里一律是 `YYYY-MM-DD` 字符串**，不是 Date 对象；`DatePicker` 给的是 dayjs 对象 → 边界不转会全链路崩 | `lib/intakeCard.js:181,482,506,530`、`lib/conclusionExtract.mjs:147`、`lib/leukemiaChecklist.mjs:22,70`、`pages/intake/reportSort.js:13`、`web/src/meddata/store.js:74,80,152,174` 全是 `String(x).slice(0,10)` |
| R5 | 化验值是**字符串**（`<125`、`阴性`、`0/793000=0.0004%`），换 `InputNumber` 会丢临床事实 | `lib/normalize.js` 实测样本；`pages/card/SourceModal.jsx:262` |
| R6 | 现有 e2e 用 placeholder 定位日期输入框，换 DatePicker 后选择器会失效 | `tools/e2e-real-pdf.mjs:101` `input[placeholder="2026-11-01"]` |
| R7 | 频次：识别线 2 处日期、1 处年龄、1 处页码 = **已发生且用户点名**，不是想象需求 | 用户消息 + 上表 |
| R8 | 真值来源：以 `BookingForm.jsx:552`（项目自己跑通的标准写法）作基线，不引入新范式 | 同上 |

## 3. 正向排雷（F，新方案 → 消费方）

| 编号 | 雷 | 处置 |
|---|---|---|
| F1 | 破坏性 | 只改 5 个控件的渲染与 onChange，**不写库、不批量改数据**（那份日期回填已单独做完并留快照） |
| F2 | **级联**：DatePicker 的 value 是 dayjs 对象 | 统一薄封装 `DateField`：入参 `string\|''` → `dayjs(v\|\|undefined)`；`onChange` 只 `format('YYYY-MM-DD')` 回写字符串。**存储和后端永远字符串**，一处转换，全链路不动 |
| F3 | 键一致性 | `reportDate` 参与查重指纹/排序键 → 值域不变（仍是 `YYYY-MM-DD`），只换输入方式 |
| F4 | 呈现误报 | 空值必须显示"未提供"，DatePicker 空值给 `undefined`（不能给 `null`/`Invalid Date`） |
| F5 | 测试污染 | 改前端后必跑 `build:web` + `verify-ui` + `tools/e2e-real-pdf.mjs`；e2e 选择器同步改成 `data-testid` |
| F6 | 调用面 | `DateField` 放 `web/src/pages/intake/dateField.jsx`，两处（IntakePage / ReportsPanel）共用，**不新增端点、不改 API 形状** |
| F7 | 部署态 | 改 `web/**` 必须 `MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web`；改 `lib/**` 必须重启 5174 自验，不丢给用户 |
| F8 | 治理 | 替换后 `tests/verify-ui.mjs` 加断言「日期输入框是 DatePicker 且值为 YYYY-MM-DD」；文档同步 D7 |
| F9 | 并发写 | `IntakePage.jsx` / `ReportsPanel.jsx` 若别人同时在改，按文件白名单逐个提交，不合批 |

## 4. 逐项必要性（先砍再排期）

| 项 | 不做会怎样 | 代价 | 收益 | 更便宜手段 | 判定 |
|---|---|---|---|---|---|
| ① `DateField` 薄封装 + 两处报告日期换 `DatePicker` | 用户继续手敲 `2026-9-30`，格式不统一、易写错、无日历 | 新 1 文件 ~35 行 + 改 2 行 + e2e 改 1 行 | 解决 R2/R4/R7；与 BookingForm 同款 | 无（这就是标准件） | **留（MVP）** |
| ② 年龄 `Form.Item name="age"` → `InputNumber min=0 max=120` | 可输入「三十四」，卡片显示脏值 | 改 1 行 | R3 | `Input` + 正则校验（更便宜但体验差） | **留** |
| ③ 页码 `Input` → `InputNumber min=1` | 现在靠 `Math.max(1,Number())` 兜，输入 `abc` 静默变 1 | 改 1 行 | R3 | 现状可跑 | **留（顺手，1 行）** |
| ④ 化验「数值」列换 `InputNumber` | —— | —— | **会丢** `<125`/`阴性`/`0/793000=0%`（R5） | —— | **砍（红线冲突）** |
| ⑤ 把 `IntakePage` / `ReportsPanel` 整体包进 `<Form>` | 现在 `<Space>` 手包能用 | 大改、影响 375 布局（今天刚修过） | 无已证实痛点 | 两处只换控件本身 | **砍** |
| ⑥ 把 `BriefPage` / `PatientForm` 的 `Input` 全量换成别的 | —— | 大 | 无 | —— | **砍** |
| ⑦ 日期带时分（`DatePicker showTime`） | —— | —— | 报告日期是「日」不是「时刻」，采样时间已单独只读展示 | —— | **砍** |
| ⑧ 统一全部单选/多选控件风格 | 视觉不一律 | 中 | 想象需求（R7） | —— | **延后**：触发条件 = 用户指出具体页面「选项控件不好用」 |
| ⑨ 表单级校验（必填/格式红字） | 现在靠占位符提示 | 中 | 未被点名 | antd `Form rules` 现成，但只 4 页用 Form | **延后**：触发条件 = 出现「保存了空/错日期」实测案例 |

## 5. 简化后的方案（只列留下的 3 项）

1. **新建 `web/src/pages/intake/dateField.jsx`**：`<DateField value={string} onChange={(string)=>} />`，内部 `DatePicker` + `format="YYYY-MM-DD"` + `dayjs`；空值 ↔ `undefined`；`allowClear`；`style={{width:130}}` 保持现有宽度；带 `data-testid="report-date"`。
2. **换 2 处报告日期**：`IntakePage.jsx:653`（录入校对区）、`ReportsPanel.jsx:484`（报告库编辑弹窗）→ `<DateField>`。值域不变，`meta.reportDate` / `editing.reportDate` 仍是字符串。
3. **换 2 处数字**：`PatientForm.jsx:117` 年龄 → `InputNumber`；`card/SourceModal.jsx:180` 页码 → `InputNumber`。

**验收判据**（可复跑）：
- `MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web` 0 错；
- `npm run test:ui` 全绿（375/1440 无横溢）；
- `node tools/e2e-real-pdf.mjs` 17/0（选择器改 `data-testid`）；
- 真 PDF 走一遍：日期框显示 `2026-07-17`，点开是日历，清空后入库 `reportDate=""` 不报错；
- `node tests/verify-card.mjs` 61/0、`npm run test:library` 12/0（证明字符串契约没被破）。

**延后项触发条件**：⑧ 用户点名某页选项控件；⑨ 出现「保存了空/错日期」实测案例。

**我无法自解的前提**：无。方案不新增依赖、不改 API、不动数据。

## 6. 复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief
# 盘点
grep -rEn "<(Input|InputNumber|DatePicker|Select|Switch|Radio|Checkbox|Segmented|Form\.Item)\b" web/src/pages --include=*.jsx
grep -n "DatePicker\|dayjs" web/src/pages/BookingForm.jsx web/src/main.jsx package.json
# 契约（字符串，不是 Date）
grep -rn "reportDate\|measuredAt" lib/intakeCard.js lib/conclusionExtract.mjs lib/leukemiaChecklist.mjs web/src/pages/intake/reportSort.js | grep slice
# 门禁（确认后执行时跑）
MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web
npm run test:ui && npm run test:card && npm run test:library
node tools/e2e-real-pdf.mjs
```
