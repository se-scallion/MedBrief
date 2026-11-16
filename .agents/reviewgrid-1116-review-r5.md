# 「② 识别与校对整份挂 DataGrid + 导入状态机修复」v0.5 · 独立 AI 审核（r4 复审 · 终判）

> 对象：`MedBrief/.agents/reviewgrid-1116-plan.md`（v0.5）｜输入：`-review-input-r5.md`｜前序：`-review-r1…r4.md`
> 只读取证：未改计划、未改生产代码。复跑命令见文末。

## 总判：**可以开工**（附 2 条 P1 必须同批落地 + 1 处 v0.5 自相矛盾要订正；都不改结构、不新增阶段）

r4 的 P0 方向已裁到终态（`text` 必须可更新），两条附带与两条复核全部闭环。剩下的都是「同一段代码里的写法细节」：patchLog **怎么记 text** 这一处 v0.5 自己前后不一致，必须钉死一种写法。

---

## 一、r4 逐条闭环核对

| r4 编号 | v0.5 落点 | 判 |
|---|---|---|
| **P0** patch 白名单没有 `text` | 白名单加 `text` + patchLog 记长度变化 + 断言「更新后 text 与待校对副本一致」；`rows` 与 `text` 一起更新、原地不 push | ✅ **方向闭环**（但记录写法自相矛盾 → 见 P1-1） |
| **附带①** rowsReplace 行数不同时 index 硬对齐 | 改为 `rows.added[] / rows.removed[]` 分条 + 被删行快照进 patchLog、不静默删 | ✅ 闭环（快照字段要限死 → 见 P1-2） |
| **附带②** D5「能加行」含糊 | 补「但该行 value 为空、不入库」 | ✅ 闭环 |
| **复核 A** `version` 不是锁 | `lib/reportStore.mjs` 文件头已改：「`version` **只是格式留痕，不是锁**（无条件写 2、读入不比对、无 CAS）——别把它当并发保护写进文档或计划」 | ✅ 闭环（代码注释与计划口径一致） |
| **复核 B** 空 value 过滤不误删定性 | 写进 D5 断言；我复跑确认：真实库 **298 行、空 value 0 条、定性行 30 且 value 全非空** | ✅ 闭环 |

**text 消费方核对（P0 立论成立）**：`conclusionExtract.mjs:52/65/74/106/149` 全部 `report?.text`；`leukemiaChecklist.mjs:30` `String(rep.text||rep.rawText||'').slice(0,400)`、`:215` 影像关键词也吃 text → 「只换 rows 不换 text」确实会造出「新指标行 + 旧结论/旧类型依据」。

## 二、v0.5 的自相矛盾与两条必钉死的写法

### P1-1（v0.5 内部矛盾，必须二选一）patchLog **怎么记 text**：`push('text', rep.text, v)` 与「只记长度变化」不能同时成立

- 现有 `push()` 是**原样存 from/to 字符串**：`server.mjs:1163-1165` `log.push({ at, field, from: from ?? '', to: to ?? '' })`。所以一旦 `push('text', rep.text, v)`，**整篇患者报告原文会进 patchLog**（每更新一次存两份全文，且 `patchLog` 存在 `reports.json` 里 → 同一份患者数据存两遍、历史累积）。
- v0.5 同时又写「patchLog 记 text **长度变化**」——两条互相打架，落地时谁写谁赢。
- **钉死成：专用 log 条目，不存原文**：
  ```js
  log.push({ at, field: 'text', fromLen: (rep.text||'').length, toLen: v.length,
             fromSha: sha256(rep.text||'').slice(0,12), toSha: sha256(v).slice(0,12) })
  ```
  好处：① 隐私面不扩大（不重复存原文）；② 仍可审计「换过没有、是不是同一份」（sha 前 12 位足够比对）；③ 与既有 `push()` 的 `{field,from,to}` 形状区分得开，前端渲染改动一行（`text` 条目显示「长度 A→B」）。

### P1-2（隐私面）`rows.added/removed` 快照字段必须限死

- 行快照只能存 **`{name, value, unit}`**（各截 40 字），**严禁带 `rawSnippet`**：`rawSnippet` 是**原文行切片**（`lib/reportIntake.mjs` 每行都写），把删掉的行的 rawSnippet 存进 patchLog = 把患者原文再复制一份进日志。同时 `rowsReplace` 的 from/to 也别把整行 JSON 直接塞进去。
- 另建议：`rows.removed` 快照总量上限（如 ≤50 条，超出只记条数），防一次替换把整表原文灌进日志。

### 关于「新增 `text` 白名单会不会让 patch 端点被误用改别的报告级字段」

- 风险真实但可控：`patch` 现在就能改 `hospital/reportDate/reportType/kind`（本地回环、无鉴权），加 `text` 后它也能**覆盖原件内容的唯一文字证据**。`text` 变了 → `buildChecklist` 的 haystack、类型判定、关键结论摘录全跟着变，而**查重指纹算的是 rows**（`buildReportFingerprint(rows, meta)`），所以「改 text 绕过查重」不成立 ✅。
- **建议加两条低成本的收口**（同批，2 行）：
  1. `text` 只接受 **`body.rowsReplace === true` 且带 `fromReportId`** 的请求（即只能来自「待校对副本 → 更新原报告」这条路），普通 patch 调用传 `text` 直接忽略；
  2. `text` 非空校验（`String(v).trim()` 为空则拒绝），避免把全文误清空——清空必须留标记，这是项目既有红线。

## 三、现在能否「可以开工」

**可以开工。** 依据：

1. r4 提出的唯一 P0（`text` 不可更新）方向已定，且缺的只是**记录写法**（P1-1）与**快照字段**（P1-2），不涉及方案结构、分批或数据迁移；
2. 全案**无破坏性动作**：不删库、不迁移患者数据、不新增后端依赖；`更新原报告` 是原地改写且全程进 `patchLog`，可回查；
3. 门禁与验收判据齐全（`build:web` + `test:ui`/`test:no-web-logic`/`test:card`/`test:library` + 新 `verify-intake-review.mjs` + 副本库 e2e + 真实库 sha256 前后一致）。

**开工时按顺序做（与计划一致）**：`points.js` + 状态机纯逻辑 → 挂 DataGrid（0 行也挂、删 Empty）→ `baselineRows`/`emitTrace`（layout-lines、`ocrLoop:null`）→ 最后接 `PUT/rowsReplace`（带上面 P1-1/P1-2 两条写法）。前两步做完即可独立验收，不必等 ④。

## 四、复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief
sed -n '1,16p' lib/reportStore.mjs          # version「只是留痕不是锁」注释已改 ✅
sed -n '1163,1166p' server.mjs              # push() 原样存 from/to → text 必须走专用 log（P1-1）
grep -n "rep.text\s*=" server.mjs           # 仍零命中 → 白名单要新增 text（计划已含）
grep -n "text" lib/conclusionExtract.mjs | head    # :52 :65 :74 :106 :149 吃 report.text
sed -n '28,33p;213,217p' lib/leukemiaChecklist.mjs # :30 haystack / :215 影像词都吃 text
node -e "…统计真实库行…"                     # 298 行 / 空 value 0 / 定性 30 且非空
grep -n "rawSnippet" lib/reportIntake.mjs | head   # 行内带原文切片 → 快照严禁带它（P1-2）
```
