# 「② 识别与校对整份挂 DataGrid + 导入状态机修复」v0.2 · 独立 AI 审核（第 2 轮）

> 对象：`MedBrief/.agents/reviewgrid-1116-plan.md`（v0.2）｜上一轮：`-review-r1.md`｜输入：`-review-input-r2.md`
> 只读取证：未改计划、未改生产代码。复跑命令见文末。

## 总判：**不能直接进第 3 轮** —— 3 处未闭环（P0-2 改法不可实现 / F4 旧文案残留 / 批量 silent 无出口），但方向与拆分没问题，改法层面即可收

---

## 一、r1 逐条闭环核对

| r1 编号 | v0.2 落点 | 判 |
|---|---|---|
| **P0-1** 保存按钮恒灰 | 修订说明 + F10 + D2：`date=reportDate\|\|sampledAt`、`onSave` 只回写 rows、上方加说明行、不改 MedData 组件 | ⚠️ **半闭环**：按钮能点了，但把**报告日期当采集日期**用 → 见特别复核①（引入新语义污染） |
| **P0-2** 复制反馈无料 | 修订说明 + F11 + D2：「`recognize()` 成功后 `emitTrace(item.id,{rawGrid: body.blocks→grid, …})`」 | ❌ **不可实现**：`/api/intake/ocr` 响应**没有 `blocks`**（实测 28 个键无 `blocks`/`layoutLines`，只有 `lines` 25 条）→ 见特别复核② |
| **P0-3** 0 行批量回退解析 | C⑦ + D3 + 断言：targets 加 `status!=='failed' && text.trim()`；`saveReport` 带 `meta.textOnly=true` | ✅ 方向闭环（但**条件加/无条件加**要写死，见特别复核③） |
| **实质结论①** rows>0 才挂=半个组件 | 修订说明 + D2：0 行也整份挂、**删除 Empty 分支** | ⚠️ **自相矛盾残留**：**F4 段仍是旧文案**（`reviewgrid-1116-plan.md:86`「保留现有 `Empty` 分支…DataGrid 只在 `rows.length>0` 时挂」）——与 D2 正面冲突，删旧句 |
| **实质结论②** 重识别必然撞查重 | D3/D4：提前写明 + 沿用现有「仍要导入」出口 | ⚠️ **半闭环**：单张有出口，**批量 `silent:true` 没有出口**（见特别复核④） |
| **附问一** F7 不必重启 | 修订说明：显式 `MEDBRIEF_WEB_OUT=dist-next` + 浏览器硬刷新 | ✅ 闭环 |
| **附问二** e2e 副本库 | 修订说明 + D5：5175+副本库 ✅ 但 API 驱动，UI 断言另用 Playwright | ✅ 闭环 |

## 二、5 个特别复核点逐条回答

### ① `date=meta.reportDate||meta.sampledAt` 会不会污染别的 `date` 消费点？—— **会，而且违反「两个临床事实各归各位」**

`DataGrid` 里 `date` 除 `:1400` 的 `disabled` 外还有两个消费者：
- `:964` `buildFeedback({ baselinePoints, currentPoints, traceId, reportType, **date**, ops })` → `utils/feedback.js:24,98,121,187` 把 `date` **原样写进反馈 JSON 的 `date` 字段** → 反馈里"采集日期"变成报告日期（同一个字段两种事实，正是 R5 那类语义裂缝）。
- `:813` 是**可编辑的采集日期输入**（DateInput）→ 若 `onDateChange` 映射到 `item.meta.reportDate`，用户改「采集日期」会**静默改掉报告日期**；反之若映射到 `sampledAt`，则显示的是报告日期、改的却是采集日期，更乱。
- 另外 `pushOp('set-date')` 会把这次编辑记进 oplog（无害，但会出现在 corrections）。

**正解（也是真正满足 F3「单一 state」的写法）**：`date = item.meta.sampledAt`、`reportedDate = item.meta.reportDate`，两个事实各自镜像各自的字段、`onDateChange→sampledAt`、`onReportedDateChange→reportDate`。
副作用是：**没有采集日期的报告保存按钮仍会灰** —— 这恰好诚实（我们不该为了点亮按钮去编一个采集日期）。说明行改成：「保存按钮灰着不影响校对：改动已实时回写；入库请用下方『入库这份报告 / 一键导入全部』」。

### ② `emitTrace(item.id, {rawGrid: body.blocks→grid})` 可行吗？—— **不可行：响应里没有 `blocks`**

实测（真打一次 `/api/intake/ocr`）响应键为：
`chunkAspect, chunkHeights, chunkMerged, chunkValueConflicts, chunked, chunks, chunksPlanned, contentHeight, contentWidth, cropBox, cropped, deskewAngle, deskewConfidence, deskewMs, deskewed, engine, kind, layout, **lines**, meta, ok, rawRowCount, recognitionSource, rows, rowsDropped, source, stitchedDeduped, text`
—— **无 `blocks`、无 `layoutLines`**；`lines` 是版式行数组（25 条，形如 `'12:12' / '<\t检验报告\t◎'`），`rows` 是 11 行结构化结果。
（`blocks` 只在服务端内部用于 `blocksToLines()` 造 text，`:1425-1430`，从不外发。）

**改法（既不假造、也能让复制反馈真有用）**：snapshot 用服务端真实给的东西，并**显式标注来源**：
```js
emitTrace(item.id, {
  rawGrid: { kind: 'layout-lines', lines: body.lines },   // 真实版式行
  rows: body.rows,                                       // 结构化行
  rawGridSource: '/api/intake/ocr.lines',                // 让人一眼看出不是 MedData 的 blocks 网格
  ocrLoop: null,                                         // 我们没有多轮识别循环 → 如实 null，不编
  recognizedAt, durationMs, reportType: body.meta?.reportType || '',
})
```
另：`emitTrace` 先写 `localStorage['trace:'+id]` 再 POST `/api/log`（`:26-55`），而 `readTraceLocal` **只读 localStorage** → **即使后端不可用也能用**，计划别把这一步写成"需要后端通道"。

### ③ `meta.textOnly=true` 无条件加还是条件加？—— **必须条件加（只在 `rows.length===0` 时），两种副作用如下**

`server.mjs:1585`：`meta.textOnly===true ? body.rows : (rows.length ? rows : parseLabRows(text))`；且 **`rowsForType` 只在 OCR 端点被调用（`:1505`、`:1568`），import 路径上没有任何类型门控** → `textOnly` 是入库侧的唯一护栏。
- **无条件加**：所有报告都失去「rows 空时用 text 回退解析」的能力 —— 包括一个合法场景：用户在 DataGrid 里把行删空、想靠「粘贴解析」重新出行的路径会变成「入库 0 行」。风险面被放大到全部报告。
- **条件加（推荐）**：只在该 item `rows.length===0` 时置 `textOnly:true`。风险是漏加 → 出假行，用断言兜住：「0 行全文型（核型/FISH/PCR 文本页）批量入库后 `rows.length===0` 且全文保留」。
- 顺带写进计划一句防后人误解的话：**「`rowsForType` 不在 import 路径上，别以为有双保险」**（证据：`grep -n "rowsForType(" server.mjs` 只有 `:1505/:1568` 两处，均在 OCR 端点）。

### ④ 批量 `silent:true` 会静默跳过重导 —— **断点确实存在，必须补出口**

`IntakePage.jsx:357-366`：`silent` 时 `patchItem({status:'dup'})` + 一行日志 + `return {duplicate:true, of}`，**不弹确认**。所以 D4「确认后重置为待入库」在**批量路径**上会被静默吞掉，用户重导 N 张只有 1 张能单点。
**修法**：D4 确认弹窗里顺手给该 item 打标记 `forceReimport:true`；`importAll` → `runBatch` 里对带标记的项调 `saveReport(it,{ silent:true, force:true })`；汇总文案分开报「跳过重复 M 张（其中 K 张是你已确认要重导的）」，不能再混成一个数。断言：重识别→确认→一键导入→库里 +1 且该 item `saved:true`。

### ⑤ 0 点挂 DataGrid，按钮行为与要加的断言

| 控件 | 0 点现状（读码） | 判定 / 断言 |
|---|---|---|
| `新增行/智能补项`（`:930-939`） | `disabled={!nextSuggested}`；0 点时 `nextSuggested = reduce(...,0)+1 = 1` → **可点** | 正是全文型补行入口 ✅；断言「点一次只 +1 行空行、不写假值」 |
| `一键修正`（`:943-944`） | `disabled={!fixableCount}` → 0 点必灰 | 断言「0 点恒灰」 |
| `复制反馈`（`:977`） | `disabled={!baseline.length \|\| !traceId}` → baseline 空必灰 | 断言「0 点灰」 |
| `清空本次`（`:1397`） | 无 guard，直接 `onReset` | 断言「点了不抛错、不产生行」 |
| `保存`（`:1400`） | `!date \|\| 无值` → 灰 | 断言「0 点灰」 |
| 内部 `reduce`（`:546`/`:569`） | 均带初值 `0` | 无除零/空数组风险 ✅ |

**要加的断言（写进 D5 的 `verify-intake-review.mjs`）**：0 点渲染 → 逐个点击上述按钮 → 无 throw / 无 console error / 不产生假行 / 不发出任何 `/api/intake/reports` 请求。

## 三、新发现（v0.2 独有，r1 未提）

| # | 问题 | 级别 | 证据 |
|---|---|---|---|
| N1 | **F4 段与 D2 自相矛盾**（F4 仍写「只在 rows>0 时挂、保留 Empty」） | P1（一句话删） | `reviewgrid-1116-plan.md:86` vs D2 |
| N2 | **`date` 语义污染**（报告日期冒充采集日期，会写进 feedback JSON、且 DateInput 可编辑） | P1 | `DataGrid.jsx:813,964`、`utils/feedback.js:24,98,121,187` |
| N3 | **`body.blocks` 不存在**（P0-2 的实现基础不成立） | P0 | 实测响应 28 键无 blocks；有 `lines`(25) |
| N4 | **批量 silent 无重导出口** | P1 | `IntakePage.jsx:357-366` + `importAll` 的 `silent:true` |
| N5 | **执行顺序风险**：D2（挂组件）、③（状态机）、P0-2（trace）三者无强依赖，一次改完无法分段回滚 | P2 | 建议拆三步：`points.js`+状态机 → 挂 DataGrid → trace/onSave 接线 |
| N6 | 报告库 `date=""` 那份"小改单"若与本文口径不一致（一边 reportDate 一边 sampledAt）→ 两页行为不同 | P2 | `ReportsPanel.jsx:544` |

## 四、必改清单（按执行顺序）

### P0（不改不能进第 3 轮）

1. **[N3] P0-2 重写**：删掉「`body.blocks→grid`」，改成 `rawGrid:{kind:'layout-lines', lines: body.lines}` + `rawGridSource` + `ocrLoop:null`（如实），并写明「localStorage 兜底 ⇒ 不依赖后端」。
2. **[N4] D3/D4 补批量重导出口**：`forceReimport` 标记 + `saveReport(...,{silent:true,force:true})` + 汇总分开报（含断言）。
3. **[N1] 删 F4 旧文案**（「只在 rows>0 时挂 / 保留 Empty」），改成「0 行也挂，`Empty` 只给 `status==='failed'`」。

### P1（同轮补齐）

4. **[N2] 改 `date` 口径**：`date=meta.sampledAt`、`reportedDate=meta.reportDate`，`onDateChange→sampledAt`；说明行改为「保存按钮灰着不影响校对，改动已实时回写」。**不要**用报告日期冒充采集日期。
5. **[特别复核③] 写死 `textOnly` 是条件加**（`rows.length===0` 时），并补一句「`rowsForType` 不在 import 路径（只有 `:1505/:1568`）→ 这是唯一护栏」。
6. **[特别复核⑤] 把 0 点按钮断言写进 D5**（5 条：智能补项可点只 +1 空行、一键修正/复制反馈/保存恒灰、清空本次无副作用、不发 `/api/intake/reports`）。

### P2（顺手）

7. **[N5]** D 段补三步实施顺序（`points.js`+状态机 → 挂 DataGrid → trace/onSave），每步独立验收可回滚。
8. **[N6]** 报告库 `date=""` 小改单里写明与本文同一口径（`sampledAt` vs `reportDate`），别两页不同。

## 五、复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief
# ① date 消费点 & 语义污染
grep -n "\bdate\b" meddata/src/components/DataGrid.jsx | grep -v reportedDate | head
sed -n '810,818p;960,966p;1396,1404p' meddata/src/components/DataGrid.jsx
grep -n "date" meddata/src/utils/feedback.js | head        # :24 :98 :121 :187 原样写进 JSON
# ② blocks 到底在不在响应里
curl -s -X POST 127.0.0.1:5174/api/intake/ocr -H 'content-type: application/json' \
  -d "$(python3 -c "import json,base64;print(json.dumps({'image':'data:image/jpeg;base64,'+base64.b64encode(open('/tmp/r12/b1_第1页.jpg','rb').read()).decode()}))")" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(sorted(d.keys()));print('lines',len(d.get('lines') or []))"
grep -n "blocks" server.mjs | head                       # 只在 :1425-1430 内部使用，不外发
# ③ textOnly 与类型门控
sed -n '1583,1590p' server.mjs
grep -n "rowsForType(" server.mjs                        # 只有 :1505 / :1568（OCR 端点），import 路径无
# ④ 批量 silent 跳过
sed -n '356,366p' web/src/pages/IntakePage.jsx
grep -n "silent: true" web/src/pages/IntakePage.jsx
# ⑤ 0 点按钮状态
grep -n "disabled={!nextSuggested}\|disabled={!fixableCount}\|disabled={!baseline.length\|disabled={!date" meddata/src/components/DataGrid.jsx
grep -n "reduce(" meddata/src/components/DataGrid.jsx  # :546 :569 都带初值 0
# trace 写入/读取
sed -n '26,55p' meddata/src/utils/trace.js
```
