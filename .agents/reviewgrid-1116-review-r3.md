# 「② 识别与校对整份挂 DataGrid + 导入状态机修复」v0.3 · 独立 AI 审核（第 3 轮 · 终轮）

> 对象：`MedBrief/.agents/reviewgrid-1116-plan.md`（v0.3）｜前两轮：`-review-r1.md` / `-r2.md`｜输入：`-review-input-r3.md`
> 只读取证：未改计划、未改生产代码。复跑命令见文末。

## 总判：**只准哪几条** —— ① 挂 DataGrid、② `points.js`、③ 状态机、⑤ baseline/emitTrace 准予开工；**④ 重识别重置与 ⑥/⑦ 的入库链路必须先定两条口径**（重导语义、补行入库护栏），否则医疗红线会被踩

r2 三处未闭环已全部补齐、5 个复核点已全部吸收；但「force 跳查重」与「0 行智能补项」两条新链路各带一个会**把脏数据写进患者库**的缺口（见二·A / 二·B）。

---

## 一、r2 逐条闭环核对

| r2 编号 | v0.3 落点 | 判 |
|---|---|---|
| #1 OCR 无 `blocks` → snapshot 假造 | D2：`rawGrid:{kind:'layout-lines', lines: body.lines\|\|body.layoutLines\|\|[]}` + `rawGridSource:'layout-lines'` + `ocrLoop:null` + `traceSource:'recognize'`；并写明 localStorage 兜底 | ✅ 闭环（措辞准确，不假造） |
| #2 silent 批量无重导出口 | D4：`forceReimport` 标记 + `saveReport(...,{silent:true,force:true})` + 汇总分开报 + 成功后清标记 | ⚠️ **机制闭环，语义有缺口** → 见二·A |
| #3 F4 旧文案残留 | F4 改为「0 行也整份挂…删掉 Empty」；`plan.md` 内已无「保留 Empty/只在 rows>0 挂」 | ✅ 闭环 |
| 复核点① `date` 污染 | D2：`date=item.meta.sampledAt`、`reportedDate=item.meta.reportDate`，无采样日按钮该灰就灰 | ✅ 闭环（与 `DataGrid.jsx:813/964` 事实一致） |
| 复核点③ `textOnly` 条件加 | D3：**仅 0 行分支**临时带 `meta.textOnly=true`，不进公共 `item.meta`；并写明 `rowsForType` 只在 OCR 端点 `:1505/:1568`、import 无门控 | ✅ 闭环 |
| 复核点⑤ 0 点断言 | D5：5 条（不崩/不除零/按钮态/补行/空 baseline/有行报告 payload 无 textOnly） | ✅ 闭环（但「补行」断言的期望值要改，见二·B） |

**v0.3 有没有新引入的自相矛盾？** 只有一处**重复**（非冲突）：D2 里 `reportedDate/reportType` 写了两遍（date 那条 + 单独一条），合并即可。

## 二、两条会翻车的链路（本轮核心）

### A「forceReimport + force:true」—— 不是「静默」问题，是**库里会长期存在两份同源报告**

- `force` 在服务端的语义是**跳过查重后照常 push 一条新记录**（`server.mjs:1589` 一带 `if (!force) {…findDuplicate…}`，失败才跳过 → 否则新 `rec` 进 `store.reports`）。**没有任何「替换/覆盖」语义**。
- 于是 D4 的路径会得到：同一张图 → 库里两条（旧 `saved` 那条 + 重导那条），**barcode/日期/类型/内容全同**。
  下游后果可复跑验证：资料卡按 `reportDate` 聚合（材料清单 +1 份）、趋势段同一 `measuredAt` 出现同码两值（`valueConflict` 计数）、「白血病核心项」按份数统计（`detail: N 份` 会虚高）。
- 说它「用户已被告知」也不够：D4 弹窗告诉的是「生成新的待入库内容」，**没告诉「库里会有两份、旧的那份不会消失」**；批量里更是没有任何二次确认。
- **必须在 D4 定口径（二选一，不能留空）**：
  - **(A1) 推荐：重导＝更新原报告**。`saved` 条目重新识别后入库，走 `POST /reports/:id/patch` 更新 rows/日期（必要时先软删旧记录再新建，走已上线的 `trashed` + `store.audit` 留痕），用户在库视角始终只有一份。代价：patch 目前**只按 index 改已存在的行**（`server.mjs:1195-1208`，不追加/不删行），要整表替换需扩一个"replace rows"语义（本方案范围内可接受，属新增能力）。
  - **(A2) 保留 force 新增**，则必须同批加：新记录写 `supersedes: oldId`、旧记录软删除（进 `trashed`，可恢复）、资料卡按 `supersedes` 去重、`store.audit` 留一条——**否则不许开这个开关**。
- 另：`force:true` 会连 `fingerprint/sha256` 一起照存 → 之后每次「一键导入」这张图仍会被判 dup，只是被 `forceReimport` 绕过。清标记的时机必须在**入库成功之后**（D4 已写 ✅），失败要保留，否则用户重试仍被跳过。

### B「0 行也整份挂 + 智能补项」—— 补出来的**不是空行**，是带推测名/单位/区间的行

- `DataGrid.addRow`（`DataGrid.jsx:543-568`）不是加空行：它用 `nextSuggested = reportTypeKeyFieldsMatched(reportType, 已有 standard_code)` 补出 **`standard_code` + `original_name` + `unit` + `ref_range`**，只有 `value:''`。真正的空行是 `addBlankRow`（`:570-590`）。
- 对全文型报告（0 行、`reportType` 为病理/流式/核型）点「智能补项」：`existing` 为空集合 → `keyFields` 里第一个未被占用的键字段就会被补进来（若是化验类 keyFields，就会出现「中性粒细胞百分比 / % / 40-75 / 值空」这种行）。
- 而这行会被写进 `item.rows` → `saveReport` 原样 `rows: item.rows`（`IntakePage.jsx:345`，**无空值过滤**）→ 服务端 `parsedRows` 也**不过滤**（`server.mjs:1585-1588` 只做 `map` 打日期）→ **入库**。资料卡会把「有单位有区间、没有数值」的行渲染成指标行（`p1` 表里 `—` 值），这正是项目写死的红线「认不出的不瞎填 / 宁可没有指标行，也不要有错值的指标行」。
- 另外 `fromPoints()` 只回吐 `{name,value,unit,refRange,code}`（`ReportsPanel.jsx:49-55` 那套）→ DataGrid 打的 `_source:'inferred'` 与 `_item_no_src` **在写回 `item.rows` 时就丢了**，入库侧再也分不清「识别出来的」和「补出来的」。
- **必须写进 D2/D3 的两条护栏（各 2–3 行，不改架构）**：
  1. `fromPoints` 保留 `inferred: !!(p._source === 'inferred')`（或 `source:'inferred'`）→ 入库前可辨；
  2. 入库前统一过滤 **`value` 为空** 的行（`rows.filter(r => String(r.value ?? '').trim() !== '')`），并在 UI 汇总里如实报「N 行无值未入库（可核对后补值再入库）」。断言：0 行全文型报告点「智能补项」→ 入库后 `rows.length === 0`，且 `patchLog`/日志有「未入库 N 行」。
  - 顺带把 D5 那条「智能补项可点且能加行」的断言改成「**可点、能加行、但该行不入库**」，否则断言本身在鼓励写入脏数据。

## 三、必改清单（按执行顺序）

### 开工前必须先落进计划的（P0，两条口径）

1. **[二·A] D4 定「重导语义」**：A1 更新原报告（推荐，需扩一个 replace-rows 语义）或 A2 新增+`supersedes`+软删旧条+卡片按 supersedes 去重；二者都写清并各配 1 条断言。
2. **[二·B] D2/D3 加入库前护栏**：`fromPoints` 保留 `inferred` 标记 + 入库前过滤空 `value` 行 + 汇总如实报「未入库 N 行」+ 断言「智能补项后入库仍 0 行」。

### 可以先行（P1，与上面两条无耦合）

3. ① 挂 DataGrid（0 行也挂、删 Empty）+ ② `points.js` 抽取（两页共用、断言往返不丢字段）。
4. ③ 4 态状态机（文案 + title 汇总）+ ⑤ `baselineRows` + `recognize()` 内 `emitTrace`（layout-lines / `ocrLoop:null` / `traceSource:'recognize'`）。
5. `date=sampledAt` / `reportedDate=reportDate` 已定稿，照 D2 写（**不要**回退成 reportDate 冒充采集日）。

### P2（顺手）

6. D2 里 `reportedDate/reportType` 两条重复段落合并。
7. 报告库 `ReportsPanel.jsx:544` 的 `date=""` 小改单写明与本文同一口径（sampledAt vs reportDate），避免两页行为不同。
8. 实施顺序按三段走：`points.js`+状态机 → 挂 DataGrid → trace/onSave 接线，每段独立验收可回滚。

## 四、复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief
# force 语义 = 跳查重后照常新增（没有替换）
sed -n '1583,1600p' server.mjs
grep -n "store.reports.push(rec)" server.mjs
# patch 只能按 index 改已存在的行（不追加/不删除）
sed -n '1190,1210p' server.mjs
# 「智能补项」补的是带推测名/单位/区间的行，不是空行
sed -n '543,590p' meddata/src/components/DataGrid.jsx
# 入库侧无空值过滤
sed -n '338,348p' web/src/pages/IntakePage.jsx; sed -n '1585,1592p' server.mjs
# fromPoints 丢 inferred 标记
sed -n '39,56p' web/src/pages/intake/ReportsPanel.jsx
# rowsForType 只在 OCR 端点
grep -n "rowsForType(" server.mjs
```
