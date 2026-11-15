# 报告库复用 MedData 指标行（DataGrid）+ 编辑反馈落库 —— 排雷与取舍（2026-11-15）

> 触发（用户原话）：「指标行 功能上 应该直接复用 medData 组件，我需要记录操作用于优化反馈。还需要显示指标代码，
> 还有推导填充功能。总之你评估能否完整迁移到此项目，哪些不能，说明理由。」
> 用户随后拍板：① 先修解析 ② 报告库编辑面走「DataGrid 原样挂」 ③ 反馈写到数据库表里。
> 排雷：plan-review 通用层（无项目定制层 —— 反查 `> **通用层**：~/.agents/skills/plan-review.md` 为 0 命中，
> 仅两处正文引用这句话，不是文件头标记）。状态：**方案，未编码**（等用户放行）。

**AI 审核（2026-11-15，代诊-Manager）**：判词「**准，按编号放行；3 处表述需修正，不改结论**」。
逐条核过 `meddata/mount.mjs:24-34`、`server.mjs:1165,1205`、`utils/feedback.js:203`、`ImportFlow.jsx:866`、`utils/oplog.js`。
- 修正①：F 段红线理由（DataGrid 本身不调 `postFeedback`，见 B 段）——结论不变。
- 修正②：C-⑧ 触发条件不得拿「6/229 行存码」当闸门，改「读出态 code 命中率 ≥90%」——否则会误导成先批量回写存码（破 F1/F2）。
- 修正③：D 段两个前提由审核方**直接裁到终态**（不加基线快照列；`source` 可只留 manual，但 `op` 序列不许砍）。
> 三条修正已按判词落进正文；`R6/R5/R4/R2/R3` 与 F 段各条均获准。

---

## A. 反向排雷（现有现实 → 方案前提）

| 编号 | 必查 | 证据（文件:行 / 可复跑） | 结论 |
|---|---|---|---|
| R1 | 需求前提：报告库编辑面确实是另一套 UI | `web/src/pages/intake/ReportsPanel.jsx:483-501`：编辑弹窗是 5 个手写 `Input`（项目/数值/单位/区间/无代码列），没有审计色、没有反馈、没有操作记录 | 需求成立：缺的正是「代码列 + 审计 + 反馈」三样 |
| R1b | 「DataGrid 已在 bundle 里」是不是我的推断 | `web/vite.config.js:6-8` `meddataAdapter()` 把 `meddata/src/data/store.js`、`utils/docFileStore.js` 换成本项目 shim；`web/src/meddata/MedDataWorkbench.jsx:10-11` 已 `import ImportFlow/DocImportFlow`，`meddata/src/components/ImportFlow.jsx:1314` 渲染 `DataGrid` | 属实：**导入面已在用 DataGrid**，报告库编辑面没用 |
| R2 | 它能不能脱离导入流程单独挂（这是本方案的地基） | `meddata/src/components/DataGrid.jsx:208-231` props 是**受控**的：`points / onPointsChange / date / baselinePoints / onSave / onReset / traceId`；`useStore()` 只用来取 `typeCatalog`（`:236-237`，报告类型下拉） | **能**：不需要 MedData 数据层；shim 已导出 `useStore`（`web/src/meddata/store.js:46`） |
| R3 | 「门禁全绿 = 识别对」这个前提成立吗 | 本轮实测反证：解析修之前 14 个门禁全绿，用户两张真图仍漏 1 行、多 1 假行。门禁绿 ≠ 识别对 | **不成立** → 本方案验收不能只看门禁，必须挂真截图断言（已在 `6431396` 落地 6 条） |
| R4 | 语义裂缝：「反馈」被两种完全不同的现实共用 | ①OCR 认错（真值信号，应回流算法）②用户手滑改错（不是信号）。`meddata/src/utils/oplog.js:2-6` 原话：「同为『代码被清空』，可能是算法漏识别，也可能是用户手滑清掉，只有操作记录能区分」 | 只存 diff 会把「手滑」当「认错」学进去 → **必须同时存操作序列** |
| R5 | 地基不一致：两套 code 语义 | 实测（162 个真实指标名）：本项目 `classifyAnalyte` 映射 **143**，MedData `mapAlias` 映射 **124**；本项目 229 行里只有 **6 行**存了 `code`（其余读出时现算） | **不许替换映射**，只借 MedData 的字段元数据（`FIELD_BY_CODE` 158 项：133 有标准单位、147 有参考区间） |
| R6 | 过度设计：反馈是否要新建一套 diff | `server.mjs:1165` 的 `push(field, from, to)` 与 `:1205` 的 `push(\`rows[${i}].${f}\`, row[f], next)` 已把每次改动的 **字段级 前值/后值/时间** 写进 `patchLog` | **不需要新建 diff**：`corrections` 表只补「怎么操作的」序列（oplog），值的前后变化直接引用 patchLog |
| R7 | 需求频次 | 报告库编辑的调用量、DataGrid 的历史使用：**无访问日志，不可证** | `[未取证]`，不写进理由 |
| R8 | 真值来源分级 | 反馈的「真值」只能是**用户亲手改的值**；MedData 旧网格的产出、旧模型结果都不能当基线（一致性 ≠ 正确性） | 基线定义写死为「用户编辑」 |

## B. 正向排雷（新方案 → 现有消费方）

| 编号 | 雷 | 证据 | 处置 |
|---|---|---|---|
| F1 | 破坏性动作 | 反馈只追加，不改 `reports.json` | **严禁**把反馈回灌报告（回灌=用推断改事实） |
| F2 | 连带副作用 / 重复计数 | 保存仍走 `POST /reports/:id/patch`（写 `patchLog`）；若反馈表再存一份 from→to，会出现两套「真相」 | 反馈表**只存操作序列**，值变化引用 patchLog（`rowKey` 关联） |
| F3 | 键一致性 | patch 的字段形态是 `rows[i].name / value / unit / refRange`；资料卡已在用 `rep_x:11` 这种 `rowKey` | 反馈表行键必须与 patch/patchLog 同一口径 `reportId:rowIndex` |
| F4 | 呈现层误报 | DataGrid 自带疑错红框 / 单位橙框 / 审计色（`DataGrid.jsx:37-50`） | 只许在**编辑态**出现；保存后回列表不得带任何徽标，否则「库里的数据坏了」被误读 |
| F5 | 测试污染 | 副本库 + 5199 端口的机制已存在（W12 的 `MEDBRIEF_REPORTS_FILE` + `MEDBRIEF_DATA_DIR`） | 编辑/反馈测试一律副本库；收尾断言真实库 sha256 不变 |
| F6 | 调用面 | 编辑入口有两处：列表操作列 + 详情抽屉「编辑」（`ReportsPanel.jsx:386-390`）；保存载荷必须仍是 patch 认的 5 字段 | DataGrid 的 `onPointsChange` 要映射回 `{index,name,value,unit,refRange}`，**多带的字段（standard_code 等）不能进 patch**，否则 patch 段记不到 |
| F7 | 部署态 | 改 `server.mjs`（新端点）+ 前端（`npm run build:web` 出 `dist-next`），两者都要重启/重建才生效 | 我自己重启 + 自验（`/api/health.head == git HEAD`），不丢给用户 |
| F8 | 治理资产 | `.agents/MEMORY.md` 版面段目前写的是「报告库编辑=antd 弹窗」 | 落地时同步一行，否则下个会话会按旧口径再写一套 |
| F9 | 并发写冲突 | 多会话共用 index（`867ebcd` 事故） | 只改 `ReportsPanel.jsx` / `server.mjs` intake 段 / 新建 `lib/correctionsStore.mjs`；add+commit 连续 + pathspec |

**额外红线（审核后修正表述，结论不变）**：`/api/feedback` 在 `meddata/mount.mjs:27` 的白名单里**转发给 8008 网关**，
`utils/feedback.js:9,203` 会 POST 它。但**只挂 `DataGrid` 不会触发**——`DataGrid.jsx` 只用 `buildFeedback`
（`:312` 摘要、`:964` 「复制反馈」按钮），真正的 `postFeedback` 调用点在 `ImportFlow.jsx:866`，且带条件
`traceId && originalPoints.length`（报告库场景没有 traceId，不可达）。
所以红线写成：**「一旦把反馈链路接进报告库，就禁止复用 `postFeedback`，必须自建端点」**——
不是「DataGrid 原样挂就会写进 MedData」。

## C. 逐项必要性（留 / 砍 / 延后）

| 候选 | 不做会怎样 | 代价 | 收益 | 更便宜的等价手段 | 结论 |
|---|---|---|---|---|---|
| ① DataGrid 挂进报告库编辑 | 报告库只能手改 5 个裸输入框，看不到代码、看不到审计色、「疑错」无从发现（R1） | 1 个组件接线 + 载荷映射 + 样式（`embedded.css` 已在） | 统一两套指标行 UI（R1b 已证明组件与 shim 都在） | 无 | **留** |
| ② 反馈写 SQLite `corrections` 表 | 「为什么改、怎么改的」丢失，识别优化没有素材（R4） | 1 表 + 1 端点 + oplog 40 行 | 真值信号可回流 | 文件 jsonl（用户已否） | **留**（值变化引用 patchLog，不重复存 diff —— R6） |
| ③ 迁 `FIELD_BY_CODE` 158 项元数据（unit/ref） | 推导填充无米下锅；单位缺失只能一直空 | 纯数据文件 `lib/fieldDict.mjs` | 推导填充的前提 | 无 | **留** |
| ④ 用 MedData 映射替换 `classifyAnalyte` | 覆盖 143 → 124（R5） | — | — | — | **砍**（因 R5 冲突） |
| ⑤ 走现成 `/api/feedback` 代理 | 反馈写进 MedData 侧（破铁律） | — | — | 自建端点（②） | **砍** |
| ⑥ DataGrid 全套（AiTaskCenter / 粘贴解析 / 分类 tab） | 无损失 | 越挂越多 MedData 运行时依赖 | 用不上 | 只取编辑网格 | **砍** |
| ⑦ `oplog.js` 迁入（同字段连打字合并） | 一次改名被拆成十几条，反馈表被撑爆 | 40 行零依赖 | 操作序列可用 | 无 | **留** |
| ⑧ 推导填充（`buildFixSuggestion` 三档 auto/manual） | 单位/区间空着的行一直空 | 依赖 ③ | 少手改 | 手工改 | **延后** → 触发条件：③ 上线且**读出态 code 命中率 ≥90%**（`classifyAnalyte` 现算，不依赖存码；不得拿「229 行只有 6 行存码」当闸门，否则会误导成先批量回写存码 → 破 F1/F2） |

## D. 简化后的方案（只列留下的项）+ 无法自解的前提 + 复跑命令

**D1 反馈落库（先做，独立可上）**
- `lib/correctionsStore.mjs`：同一 SQLite（`data/medbrief.db`，复用 `lib/blobStore.mjs` 的 `open()` 口径，`CREATE TABLE IF NOT EXISTS`）：
  `corrections(id INTEGER PK, report_id TEXT, row_index INTEGER, field TEXT, op TEXT, from_value TEXT, to_value TEXT, source TEXT, session_id TEXT, created_at TEXT)`。
- 端点：`POST /api/intake/reports/:id/corrections`（只追加）、`GET .../corrections`（按报告/会话读）。
- 写入时机：DataGrid 的 oplog 在保存时一次性提交；`field/from/to` 与 `patchLog` 同口径（F3）。
- 只追加，永不回灌（F1/F2）。

**D2 DataGrid 接线（后做）**
- `ReportsPanel` 编辑态改为渲染 `DataGrid`（受控：`points`↔`editing.rows`），保存仍走原 `/patch`（F6 载荷映射）。
- 审计色/疑错框只在编辑态（F4）；`baselinePoints` = 详情接口给的原始 `rawRows`。
- 反馈端点改指本项目（B 段红线）。

**D3 指标代码显示 + 元数据（与 D2 同批）**
- 详情接口读出时补 `code`（已有 `classifyAnalyte`），列表/编辑态显示代码列；
- `lib/fieldDict.mjs` 只放 MedData `FIELD_BY_CODE` 的 `unit/ref` 元数据（158 项），供后续推导填充使用（⑧ 延后）。

**原前提问题 → 审核方已裁到终态（不留挂账）**

1. **不加「导入时 rows 快照」列**。理由：R8（真值只认用户亲手改的值）、F2（禁止第二份真相）、D2 已定
   `baselinePoints` 取详情接口的 `rawRows`；patchLog 的 `from` 足以反推。
   再触发条件：出现「报告在 patchLog 之前被脚本直改、且确需反馈基线」的**具体实例**。
2. **`source` 只保留 `manual` 可以，但 `op` 序列不许砍**。报告库编辑态确实没有 `autoFix/reMatch`，
   而 `oplog.js` 里的 `save / parse-panel / copy-feedback` 等 `op` 正是 R4 用来区分「怎么操作」的唯一依据。
   → `source` 单一 ≠ 可以退回到只存 diff。

**复跑命令**
```bash
grep -n "export default function DataGrid" -A 24 meddata/src/components/DataGrid.jsx   # 受控 props
grep -n "^export" web/src/meddata/store.js | sed -n '1,12p'                            # shim 已导 useStore
grep -n "PROXY_PREFIXES" -A 12 meddata/mount.mjs                                       # /api/feedback 转发 8008（红线）
node -e "…162 个指标名 → classifyAnalyte 143 / mapAlias 124…"
grep -n "upsert\|patchLog" server.mjs | head                                            # patchLog 已记字段级前后值
```
