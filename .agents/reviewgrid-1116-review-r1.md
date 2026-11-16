# 「② 识别与校对整份挂 DataGrid + 导入状态机修复」v0.1 · 独立 AI 审核（第 1 轮）

> 对象：`MedBrief/.agents/reviewgrid-1116-plan.md`（v0.1）｜输入：`reviewgrid-1116-review-input.md`
> 只读取证：未改计划、未改任何生产代码、未提交。复跑命令见文末。

## 总判：**不能直接进下一轮** —— 3 条 P0（onSave 路线未定 / 复制反馈无料 / 批量 0 行会踩服务端回退解析）+ 5 条 P1

方向本身对（② 改用 DataGrid + 4 态状态机 + 重识别可复位），A/B/C/D 结构也齐；卡在**三处「计划说要做到、但按现状做不到」**。

---

## 一、计划自述 vs 我实测（逐条核对）

| 计划编号 | 计划断言 | 我的实测 | 判 |
|---|---|---|---|
| 0 表「一键导入过滤」 | `!saved && rows.length>0`，`IntakePage.jsx:413` | `IntakePage.jsx:347` `items.filter((it)=>!it.saved && it.rows?.length>0)`；空时固定文案 | ✅ |
| 0 表「重新识别不清 saved」 | `recognize()` 只设 status/rows/text | `:246-300` 确认：`patchItem({status:'done', text, rows, ...})`，**未触碰 saved** | ✅ |
| 0 表「勾选只用于拼接」 | 最多 2 张、`doStitch` 要求恰好 2 张 | `grep 勾选做拼接/selected.length` 与 `:172-181` 一致 | ✅ |
| R3「复制反馈在报告库也是灰的」 | `baseline.length && traceId` | `DataGrid.jsx:977` `disabled={!baseline.length \|\| !traceId}`；`ReportsPanel.jsx:557` `traceId=""` | ✅ |
| R5「points 与 rows 两套形状」 | 已有 `toPoints/fromPoints` | `ReportsPanel.jsx:39-55` 存在且未 export | ✅ |
| F7「改 web/** 不必重启 5174」 | 静态产物 | 成立，但有前提（见攻击点·补问一） | ⚠️ |
| F10「onSave 只回写 item.rows」 | 单一写库入口 | **方向对，但按现状这个按钮根本点不动**（P0-1） | ❌ |
| F11「`traceId=item.id` 让复制反馈可用」 | 成立 | **不成立**：录入面从不 `emitTrace`（P0-2） | ❌ |
| ⑦「0 行有 text 纳入批量」 | 只放宽 targets | **同时会让服务端回退解析出假行**（P0-3） | ❌ |
| D5「e2e 用副本库」 | 复用 `tools/e2e-real-pdf.mjs` | 机制成立（`PORT=5175` + `mkdtemp` 副本 + 独立 `MEDBRIEF_DATA_DIR`），但它**不是 UI 驱动** | ⚠️ |

## 二、6 个攻击点逐条回答

### ① onSave 会不会与现有 meta 表单双写？F10「只回写 item.rows」够不够？—— **不够；而且这个按钮今天连点都点不动**

- `DataGrid.jsx:1401`：`disabled={!date || points.filter(p=>p.value!=='').length===0}` —— `date` 是**采集日期**（`:845` 那一排输入框），**不是** `reportedDate`。
- 计划 D2 只接线 `reportedDate=item.meta.reportDate`，**不传 `date`** → `onSave` 永久 disabled。报告库现状同病：`ReportsPanel.jsx:544-546` 传 `date=""`，所以 `89ecea4` 挂上去的「保存到本地数据库 →」按钮是**死的**（这也是为什么至今没出现双写）。
- 因此 F10 少了两步：**(a) 让不让它可点**；**(b) 可点之后按钮文案仍写着「保存到本地数据库 →」**（文案硬编码在组件里，无 props 可改，`DataGrid.jsx:1397-1404`）。
- 结论：**必须二选一并写进 D2**：
  - 方案 A（不动组件，推荐先做）：**不接 `onSave`**，`date` 继续留空 → 保存按钮恒灰；在 DataGrid 上方加一行说明「这里只做校对，入库请用下方『入库这份报告 / 一键导入全部』」。代价：用户会看到一个灰按钮，需文案解释。
  - 方案 B（要一次跨项目小改）：给 `DataGrid.jsx` 加 `saveLabel` / `hideSaveBar` props，再把 `onSave` 映射成 `patchItem({rows})`。**这属于改 MedData 工程**，计划 F9 的文件白名单里没有它 → 必须单独立项 + MedData 侧 owner（见 P1-5）。
- 另外：即使走 B，`date` 一旦接上，**采集日期/报告日期就会有两个入口**（② 校对区现有表单 + DataGrid 内部两个 date input）；F3 说「只读镜像同一 state」是对的，但必须断言「DataGrid 改日期 → 只写 `item.meta`，绝不触发 saveReport」。

### ② `traceId=item.id` 让「复制反馈」可用，成立吗？—— **不成立：按钮会从「灰」变「可点」，但复制出来的东西是半空的**

- `readTraceLocal` 读的是 `localStorage['trace:'+traceId]`（`meddata/src/utils/trace.js`），**唯一写入点**是 `emitTrace()`，而 `emitTrace` 只被 **`meddata/src/components/ImportFlow.jsx:424`** 调用。
- MedBrief 的 ② 校对区走的是自己的 `IntakePage.recognize()` → `/api/intake/ocr`，**从不 emitTrace**（`grep emitTrace web/src` 为 0 命中）。
- 后果比现在更糟：`DataGrid.jsx:977` 只判 `baseline.length && traceId` → 按钮变亮；`:966-975` 复制出去的 JSON 里 `rawGrid / ocrLoop / recognizedAt / durationMs` **全是 null**，用户以为拿到了识别诊断，实际只有 diff 半份。
- 修法（写进 D2/F11，二选一）：
  - **(a) 推荐**：`recognize()` 成功后自己 `emitTrace(item.id, snapshot)` —— 数据都在手边（`body.rows/text/meta/chunked/deskewed`），纯前端 + 已有 `/api/log` 通道，不需要新后端；
  - (b) 不 emit，则把按钮 title 改成如实说明「仅复制修改 diff（本页没有识别诊断）」，并把 `readTraceLocal` 的 null 分支显式挡住。

### ③ D3 的 4 态是否覆盖用户实测路径（已入库 → 一键导入 → 勾选 → 重新识别）？—— **覆盖到第二步，漏了第三步的「再入库会判重复」**

- 用户的四步：入库 → 再点一键导入（`targets=[]` → 死提示）→ 勾选（只改 `selected`，与 targets 无关）→ 重新识别（不清 `saved`，targets 仍空）。D3+D4 把 1→2 和 4 都治了 ✅。
- **但第三步之后必然发生**：重新识别成功后 `saved:false` → 再点「入库」，同一张图 `sha256` 不变 → `findDuplicate` 的 `exact` 命中（`lib/reportIntake.mjs:85`）→ `saveReport` 走 `:358-366` 置 `status:'dup'` → 用户从「没有可入库的条目」换成「疑似重复已跳过」，**体感仍是"导不进去"**。
- 修法：D3 的「有 dup」态文案要**提前**写进 D4 确认框（「重新识别后入库仍会命中查重，需在弹窗里选『仍要导入』」），并在 D3 表里补一行「重新识别后再导入 → 走查重确认」的预期路径；`tests/verify-intake-review.mjs` 加一条断言。
- 另外 D4 的重置字段漏了 `status/ocrNote/engine/rawRowCount/dup 相关标记`，只清 `saved/reportId/rows/baselineRows/text` 会让上一轮的 `status:'dup'` 残留，4 态判定会误判。

### ④ ⑦「0 行但有 text 的全文型报告纳入批量」会不会把未识别成功项也放进来？—— **会，而且更糟：会让服务端重新解析出假行**

- 判据只看 `text` 非空：`recognize()` 失败分支（`:262-271`）设 `status:'failed'` **且 `rows:[]`**，但 `text` 在**上一次成功**时留下的值不会被清（`patchItem` 只写 `status/ocrNote/rows/parsed`）→ 一次「识别成功→再识别失败」的条目，`status=failed` 却有 `text` → 会被 ⑦ 当成全文型纳入批量。
- 更硬的问题：`saveReport` 载荷是 `{image,pdf,force,text,rows,meta}`，**`meta` 里没有 `textOnly`**（`IntakePage.jsx:339-347`）；服务端 `server.mjs:1585` 的判据是 `meta.textOnly===true ? body.rows : (rows.length ? rows : parseLabRows(text))` → **0 行 + 非 textOnly ⇒ 服务端拿 text 重新解析**。`rowsForType`（`lib/reportIntake.mjs:79`）只兜 `骨髓形态学|病理|流式免疫分型|出院|诊断证明` 五类，**其它类型（核型 / FISH / PCR 文本页 / 化验单识别失败）会漏过门控，产出假指标行**。
- 修法：⑦ 放宽 targets 必须**同批**做三件事：① 纳入条件加 `status!=='failed'`；② 批量路径给 `meta.textOnly = true`（rows 为空时）；③ 新断言「0 行全文型入库后 `rows.length` 仍为 0，且卡片不出现该报告的假指标」。

### ⑤ C 段 ⑧「录入面不写 corrections」砍得对不对？—— **砍得对，但理由写窄了**

- 用户「记录操作用于优化反馈」已在 `22:19` 落地到**报告库编辑面**（`lib/correctionsStore.mjs` + `89ecea4`，端点 `POST /api/intake/reports/:id/corrections`）。
- `corrections` 表的主键/外键就是 `report_id`（`6db41cd` schema），**录入面未入库的条目没有 report_id** → 复用就得改 schema 或造假 id，代价大于收益。
- 建议把理由从「收益未证」改为「**键不存在（未入库无 report_id）+ 已由报告库侧记录**」，并补延后触发条件：用户明确要求"入库前也要留操作序列"时，**另立 `intake_ops` 表**（session 级），不塞进 corrections。

### ⑥ D2「rows.length>0 才挂 DataGrid」是不是又变成半个组件？—— **是，而且砍掉了全文型报告唯一的补行手段**

- DataGrid 对 0 点**是有设计的**：`DataGrid.jsx:915` `共 {points.length} 项`、`:1209` `points.length===0` 分支，且「新增行 / 粘贴解析 / 智能补项」不依赖已有行（`pushOp('add-row')`、`'parse-run'`、`'parse-confirm'`）。
- 0 行时用 Empty 替掉 → 用户**无法**用粘贴解析把全文型报告拆成指标行 → 与 C①「整份搬（含粘贴解析）」自相矛盾，也放大了 ④/⑦ 的痛点。
- 修法：**始终挂 DataGrid**；0 行时在它上方加一条提示（「识别没出指标行：可粘贴原文解析或手工新增行」）；`Empty` 只留给 `status==='failed'`（未识别）。

### 补问一：F7「改 web/** 不必重启 5174」成立吗？—— **成立，但有两个前提**

1. `MEDBRIEF_WEB_OUT=dist-next` 必须显式（`npm run build:web` 已内置，别手敲 `npx vite build`）；
2. **浏览器必须硬刷/新开页面**：`web/dist-next/index.html` 引用的是带 hash 的 bundle（如 `index-CVx6wlbE.js`），旧标签页不会自动换 → 自验截图必须新开，否则会截到旧 bundle 误判"没生效"。
（5174 侧：静态文件按请求读盘，确认**不用重启进程** ✅。）

### 补问二：D5 用副本库能不能真不碰真实库？—— **机制成立，但复用方式要改**

`grep -n "5175\|MEDBRIEF_REPORTS_FILE\|MEDBRIEF_DATA_DIR\|mkdtemp" tools/e2e-real-pdf.mjs` → `PORT=5175`（`:13`）、`mkdtemp`（`:37`）、复制 `reports.json`（`:41`）、`env` 覆盖双变量（`:45`）✅ 真实库不碰。
但该脚本是**API 驱动**（直接打端点），不是 UI 驱动 → 要验「已入库→再点一键导入→重识别」必须**Playwright 起副本服务**；`e2e-real-pdf.mjs` 只适合加 API 级断言。计划 D5 把两者混在一句里，实施时会做成"改不动"的状态。

## 三、必改清单（按执行顺序）

### P0（不改不能进下一轮）

| # | 必改 | 指向 | 证据 |
|---|---|---|---|
| P0-1 | **明确 onSave 路线**（A 不接、灰按钮+说明 / B 加 props 并单独立项改 MedData 组件），并补「日期只写 `item.meta`、不触发入库」的断言 | D2 / F10 | `DataGrid.jsx:1401`（`disabled={!date …}`）、`:1397-1404`（文案硬编码）、`ReportsPanel.jsx:544`（现传 `date=""`） |
| P0-2 | **让 trace 真的有料**：`recognize()` 成功后 `emitTrace(item.id, snapshot)`；否则按钮 title 如实说"只有 diff" | F11 / D2 | `meddata/src/utils/trace.js`（`readTraceLocal` 读 localStorage）、`ImportFlow.jsx:424`（唯一 emitTrace）、`DataGrid.jsx:966-977` |
| P0-3 | ⑦ 放宽批量时必须同时：① 排除 `status==='failed'`；② 0 行时传 `meta.textOnly=true`；③ 断言「入库后 rows 仍 0、无假行」 | C⑦ / D3 / F1 | `server.mjs:1585`（textOnly 门控）、`lib/reportIntake.mjs:79`（rowsForType 只 5 类）、`IntakePage.jsx:262-271`（failed 不清 text） |

### P1（同轮补写，否则实施必返工）

| # | 必改 | 指向 |
|---|---|---|
| P1-1 | D3/D4 补「重新识别→再入库会命中查重→需选『仍要导入』」这条预期路径 + 确认框提前说明；D4 重置字段补 `status/ocrNote/engine/rawRowCount` | D3 / D4 / F12 |
| P1-2 | 取消 `rows>0` 才挂的闸门：**始终挂 DataGrid**，0 行加提示条，`Empty` 只给 failed | D2 / F4 / C① |
| P1-3 | ⑧ 的砍理由改成「未入库无 report_id（corrections 键不存在）+ 已有报告库侧记录」，并给延后触发条件（另立 `intake_ops`） | C⑧ |
| P1-4 | F7 补两条自验前提（显式 `WEB_OUT`、浏览器硬刷新开页面）；D5 把 UI 断言与 API 断言分开写 | F7 / D5 |
| P1-5 | 若走 P0-1 的 B 方案：把「给 DataGrid 加 `saveLabel/hideSaveBar`」列为**跨项目小改**（MedData 工程 + owner + 回写约定），并入 F9 文件白名单 | F9 / D2 |

### P2（顺手改）

| # | 必改 | 证据 |
|---|---|---|
| P2-1 | D2 的替换范围写准：表格 `<Table>` 在 `IntakePage.jsx:602`、`rowColumns` 在 `:435+`、渲染函数跨 `:590-690`（**含 `:681` 单个入库按钮**，别一起删掉） | 实测行号 |
| P2-2 | 报告库顺手补一行注释：`date=""` 是**故意**留空（保存按钮因此恒灰），别让下个会话当 bug 修 | `ReportsPanel.jsx:544` |
| P2-3 | D5 明确：`tests/verify-intake-review.mjs` 用 Playwright 起副本服务做 UI 断言；`e2e-real-pdf.mjs` 只加 API 断言 | `tools/e2e-real-pdf.mjs:13,37,41,45` |

## 四、复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief
# 状态机现状（计划 0 表逐行）
grep -n "const targets\|没有可入库的条目" web/src/pages/IntakePage.jsx
sed -n '246,275p' web/src/pages/IntakePage.jsx          # recognize 不清 saved、failed 不清 text
sed -n '338,366p' web/src/pages/IntakePage.jsx          # saveReport 载荷无 textOnly；dup 分支
# DataGrid 的 onSave / 复制反馈真实条件
grep -n "disabled={!date\|保存到本地数据库\|disabled={!baseline.length" meddata/src/components/DataGrid.jsx
sed -n '966,978p' meddata/src/components/DataGrid.jsx
# trace 从哪来
grep -rn "emitTrace\|readTraceLocal" web/src meddata/src --include=*.jsx --include=*.js | grep -v "utils/trace.js"
# 服务端 0 行回退解析 + 类型门控
grep -n "textOnly" server.mjs; grep -n "export function rowsForType" -A 4 lib/reportIntake.mjs
# 0 点也能挂 DataGrid
grep -n "共 {points.length}\|points.length === 0" meddata/src/components/DataGrid.jsx
# e2e 副本库机制
grep -n "5175\|mkdtemp\|MEDBRIEF_REPORTS_FILE\|MEDBRIEF_DATA_DIR" tools/e2e-real-pdf.mjs
```
