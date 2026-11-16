# 「② 识别与校对整份挂 DataGrid + 导入状态机修复」v0.4 · 独立 AI 审核（r3 复审 · 终判）

> 对象：`MedBrief/.agents/reviewgrid-1116-plan.md`（v0.4，含 A/B 终态裁决）｜输入：`-review-input-r4.md`｜前序：`-review-r1/r2/r3.md`
> 只读取证：未改计划、未改生产代码。复跑命令见文末。

## 总判：**只准哪几条** —— ①②③⑤ + B 三条护栏 **准予开工**；**④「更新原报告」这条路线先补 1 个 P0（`text` 不可更新）** 才放行

A 的机制本身是对的（砍 `force`、原地更新、不产生第二份），B 也真闭环且我实测**不会误删定性结果**。卡点只剩一处：**「更新原报告」只更新 rows，会让同一份报告出现「新指标行 + 旧全文」**。

---

## 一、A / B 是否真闭环（含你点名的两处特别核查）

### A｜重导＝更新原报告（`PUT /reports/:id` + `rowsReplace`）

| 核查项 | 结论 | 证据 |
|---|---|---|
| **有没有绕开原子写四字段** | **没有**：`server.mjs` 的 `readReports/writeReports` 已委托 `lib/reportStore.mjs`（`:51` import、`:345` `readStore`、`:374-377` `writeStore`），`writeStore` 是 `tmp + fsyncSync + renameSync` 且固定写 `{version, reports, trashed, audit}` | `sed -n '60,80p' lib/reportStore.mjs`；`sed -n '374,378p' server.mjs` |
| **`version` 当乐观锁** | ⚠️ 只是**留痕不是锁**：`writeStore` 无条件写 `version: 2`，读入时不比对，没有 CAS | `grep -n "version" lib/reportStore.mjs`（`:47` 读、`:60` 写）→ 计划里别把 `version` 写成并发保护 |
| **破坏 patchLog 既有语义** | ⚠️ **两处会破**，见下 P0-1 / P1-1 | — |
| 不 push 第二条 / 不软删 / 无需 supersedes | ✅ 与 `server.mjs:1671` 的 `push` 路径彻底脱钩，r3 的「两份同源」风险消失 | 计划 D4 正文 |

- **P0-1（必须补）：`patch` 白名单里没有 `text`** → 「更新原报告」只换 rows，`report.text` 仍是旧识别的全文。
  `grep -n "rep.text\s*=" server.mjs` **无命中**；patch 只处理 `hospital/reportDate/reportType/kind` + `rows[i]`（`:1157-1210`）。
  后果可复跑：资料卡「关键结论摘录」读的是 `report.text`（`lib/conclusionExtract.mjs` 全篇基于 text），类型判定/`buildChecklist` 的 `haystack` 也吃 `text.slice(0,400)` → **更新后会出现「指标行是新的、结论摘录与类型依据是旧的」**，同一份报告内部自相矛盾。
  修法（1 行白名单 + 1 条日志）：`rowsReplace` 同批接受 `body.text`，写 `patchLog` 记 `{field:'text', from:旧长度+' chars', to:新长度+' chars'}`（**不记全文**，避免日志膨胀），并断言「更新原报告后 text 与重新识别结果一致」。
- **P1-1（必须写清）：`rowsReplace` 「按 index 对齐」在两份行数不同时会撒谎**
  重识别常改变行数（识别变好/变差）；index 对齐会把 A 行的旧值当成 B 行的 from，且**被删掉的行静默消失** —— 正好撞两条既有红线「合并不静默删」「清空必须留标记」。
  修法：行数相同 → 逐 index 出 from/to；行数不同 → 出 `rows.added[N]` / `rows.removed[N]` 分条，并在 patchLog 里保留被删行的 `{name,value}` 快照。
- **P2-1：不要新开 `PUT` 入口做成「第二份白名单」**。计划写「新增但薄、复用 patch 白名单」——落地时请让 `PUT` **调用 patch 的同一函数**（或干脆只扩 `POST /patch`），否则白名单/patchLog 两份必然漂移（本仓已吃过这个教训）。

### B｜智能补项 → 入库前过滤空 value

| 核查项 | 结论 | 证据 |
|---|---|---|
| **会不会误删「阴性/未检出/定性结果」** | **不会**：定性行的 `value` 是 `阴性/阳性/未检出` 等字符串，`String(value).trim()===''` 判不到它们 | 实测真实库 298 行：**空 value 行 0 条**、定性行 30 条（全部 value 非空） |
| 三条护栏是否够 | ✅ 够（`inferred` 标记 + 空值过滤 + 汇总报「N 行无值未入库」+ 断言「智能补项后入库仍 0 行」） | 计划 A/B 段 |
| 建议再收窄一档（P2） | 过滤条件写成 **`inferred && value===''`**，而**不是**「所有空 value 行」：识别出来但 OCR 漏值的行是「识别缺口」的证据，删掉会让用户看不到该补哪一格（正是用户报过的那类「识别数出错」）。保留但要标 `needsValue` 并在汇总里点名 | 现状 0 条 → 收窄不受数据影响，纯为将来 |

## 二、v0.4 是否新引入自相矛盾

- ✅ 旧 `forceReimport/force:true` 已全部标为「已被 r3 A 推翻/砍」，正文不再依赖（`:9 / :17 / :38 / :152 / :212` 五处口径一致）。
- ⚠️ **一处残留**：D5 的 0 点断言仍写「智能补项**可点且能加行**」（`:218`），与 B 的「智能补项后入库仍 0 行」（`:220`）并列时容易被读成矛盾。改成「可点、能加行、**但该行不入库**」一句话即可。
- 其余（D2/D3/D4/D5）互不打架。

## 三、现在能否给「可以开工」

**只准哪几条**（④ 除外的部分都可以立刻开工）：

| 准予开工 | 说明 |
|---|---|
| ① 挂 DataGrid（0 行也整份挂、删 Empty） | 与 ④ 无耦合 |
| ② `points.js` 抽 `toPoints/fromPoints`（+`inferred` 保留） | B 护栏的一半 |
| ③ 4 态状态机 + 文案/title 汇总 | 直接解用户第二问 |
| ⑤ `baselineRows` + `recognize()` 内 `emitTrace`（layout-lines / `ocrLoop:null` / `traceSource:'recognize'`） | r2 #1 已如实标注 |
| B 三条护栏（`inferred` 标记 / 空值过滤 / 「N 行无值未入库」+ 断言） | 已闭环 |

| 暂不准（补完下列 2 条即放行，随后无需再审） | 编号 |
|---|---|
| **④ 更新原报告（PUT + rowsReplace）** | **P0-1**：`text` 必须同批可更新 + patchLog 记长度变化 + 断言；**P1-1**：行数变化必须出 `added/removed` 分条并保留被删行快照 |

## 四、复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief
sed -n '45,80p' lib/reportStore.mjs            # 原子写 + 四字段；version 只留痕（无 CAS）
sed -n '345,352p;374,378p' server.mjs          # readReports/writeReports 已委托 reportStore
sed -n '1157,1212p' server.mjs                 # patch 白名单：hospital/reportDate/reportType/kind + rows[i]
grep -n "rep.text\s*=" server.mjs              # 无命中 → text 目前不可 patch（P0-1 依据）
sed -n '39,56p' web/src/pages/intake/ReportsPanel.jsx    # fromPoints 现状（丢 _source）
sed -n '543,590p' meddata/src/components/DataGrid.jsx    # addRow 带出推测名/单位/区间；addBlankRow 才是空行
node -e "…统计真实库空 value 行与定性行…"        # 298 行：空 value 0 条、定性 30 条
sed -n '77,81p' lib/reportIntake.mjs           # rowsForType 只兜 5 类图文型
```
