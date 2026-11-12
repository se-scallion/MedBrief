# 病历与指标 · 服务端能力清单（`/records` 页面的接口边界）

> 用途：3 页 IA 定稿时对齐「病历与指标」这一页能用什么、走哪条路、失败怎么办。
> 每个函数/端点都带 `文件:行`，可照着重放；文末「已知边界与触发条件」写的是**延后项 + 何时才动手**，不是 TODO 清单。
> 最后核对：2026-11-12（HEAD `ca2a483` 前后），全部条目对过源码，不是凭记忆。

---

## 一、纯函数层（无 I/O，Node / 浏览器 / 服务端同跑）

| 能力 | 位置 | 输入 | 输出 | 边界与失败 |
|---|---|---|---|---|
| `summarizeState(state, options)` | `lib/metricsSummary.js:62` | MedData state：`records` / `diseaseMetrics` / `docs` / `events`（缺失当空数组）；`options.labCodes`、`options.diseaseCodes` 可覆盖默认指标集 | `{ ok:true, latest:{ code → { code,label,value,unit,date,created_at,reportType,status,refRange,stream?,analyte?,qualifier?,numeric,num } }, aliases, counts:{records,docs,events,diseaseMetrics} }` | 不抛错。空值 / `null` 跳过；非数字值（`<0.01`）保留原串并置 `numeric:false` |
| `formatSummaryText(summary)` | `lib/metricsSummary.js:145` | `summarizeState` 的返回 | 多行纯文本，一行一指标：`日期 标签 值 单位` | 没值的指标不占行 |
| `LAB_CODES` / `DISEASE_CODES` / `LAB_CODE_ALIASES` | `lib/metricsSummary.js:11` / `:33` / `:24` | — | 化验 7 项 `WBC PLT Hb RBC NEUT_ABS LYM_ABS HS_CRP`；疾病 3 项 `BM_BLAST_PCT FCM_MRD_PCT BCR_ABL1_RATIO`；别名 `HGB|HB|HEMOGLOBIN→Hb`、`PLATELET→PLT`、`LEUKOCYTE→WBC` | 库内血红蛋白 code 是 **`Hb`**，不是 `HGB`；按 `HGB` 查库必空 |
| `buildVisitBrief({ state, patientMeta, limit, generatedAt, sourceLabel })` | `lib/visitBrief.js:149` | 同上 state；`limit` 默认 3 | `{ meta:{patientName,gender,age,diagnosis,generatedAt,sourceLabel,limit}, series, text, html }`；`html` 为自包含 A4 卡片（内联样式 + `@page`，无外部资源） | 不抛错。**红线**：只陈述数值/时间/趋势/参考区间，不含诊断结论与治疗建议 |
| `collectSeries(state, limit)` | `lib/visitBrief.js:44` | state + limit | `{ code → [{ date, value, num, unit, refRange, status, trend }] }`，时间倒序 | 趋势在**完整序列**上算完再截断（第 3 条也带箭头） |
| `trendSymbol(curr, prev)` | `lib/visitBrief.js:97` | 新旧两次数值 | `↑ / ↓ / → / —` | 变化幅度 ≤1% 记 `→`；无上次或非数字记 `—` |
| `isAbnormal(item)` / `shortFlag(item)` | `lib/visitBrief.js:107` / `:116` | 单条指标（含 `status`/`refRange`/`num`） | 布尔 / `低｜高｜异常｜''` | 先认报告自带 `status`，再按参考区间比较；骨髓/流式无参考区间 → 一律不判异常 |
| `parseRefRange(str)` | `lib/visitBrief.js:30` | 区间字符串，如 `125-350`、`126--350`、`125–350` | `{low,high}` 或 `null` | 先把 `– — ~ 〜` 归一、`-{2,}` 折叠（OCR 双连字符）；`high < low` 视为非法返回 `null` |

## 二、HTTP 层（`server.mjs`，端口 5174，同源）

| 端点 | 位置 | 输入 | 输出 | 降级 / 失败 |
|---|---|---|---|---|
| `GET /api/meddata/summary` | `server.mjs:167` | 无参 | 8787 `/api/summary` 透传 + `source:'live'`、`sourceUrl`、`text`(= `formatSummaryText`) | 8787 挂 / 超时 2.5s → **HTTP 200** `{ ok:false, unavailable:true, source:'unavailable', reason, fallback:'import', hint }`；前端据此转文件导入。token 只从 env `MEDDATA_SYNC_TOKEN` 注入 `x-sync-token`，不下发前端 |
| `GET /api/brief/visit-summary?source=auto\|live\|import&limit=N` | `server.mjs:195` | `source`（默认 `auto`）、`limit`（1–10，默认 3） | `{ ok:true, ...buildVisitBrief() }` = `{ meta, series, text, html }` | `auto`：先用本会话导入的 state → 否则读 8787 `/api/state`（只读，超时 3s）；`source=import` 但没导入过 → **409** `{ok:false,error,hint}`；8787 也挂 → **200** `{ok:false,unavailable:true,reason,hint}` |
| `POST /api/brief/import` | `server.mjs:852` | `{ content:"<.meddata 文本>" }` 或 `{ bundle:{…} }` | `{ ok:true, source:'bundle', sha256, schemaVersion, exportedAt, patient:{name,diagnosis,age,gender}, counts:{records,docs,events,courses,diseaseMetrics}, latest, aliases, text }` | 指纹/版本不符 → **400** `{ok:false,error:"交换包校验失败：…"}`。**副作用**：解析结果写进进程内 `lastImportedState`（`server.mjs:58`），供速览复用，服务重启即失效 |
| `POST /api/brief/bundle` | `server.mjs:781` | `{ patient:{name,idCard?,phone?,diagnosis,stage,hospital?,onset?,genes?}, chiefComplaint, presentIllness, records[], diseaseMetrics[], courses[], invoices[], docs[] }` | `{ ok:true, bundle, sha256, schemaVersion, format, typingSummary, filename }` | 生成后立刻 `parseMedDataBundle` 自检，失败 → **500** `{ok:false,error}`。身份/临床默认值已清空（缺就留空，由表单提供） |

### 被调用的上游（MedData 8787，只读）

| 端点 | 位置 | 用途 | 输出要点 |
|---|---|---|---|
| `GET 8787/api/summary` | MedData `data-server.mjs` 的 `summarizeLatest()` | MedBrief 代理的取数源 | `{ ok, version, generatedAt, patient:{age,gender,diagnosis}, latest, aliases, counts:{records,diseaseMetrics} }` |
| `GET 8787/api/state` | MedData `data-server.mjs` | 速览 live 路径取历史序列 | `{ version, state, blobs, deleted }`（全量；`/api/records` **不存在**） |
| `GET 8787/api/health` | MedData `data-server.mjs` | 探活 + 计数 + 原件体检 | `{ ok, version, counts, blobs, dup }` |

> MedBrief **永不放行任何写 8787 的调用**（MedData 是数据权威）。契约唯一权威：`INTERFACE.md` 通道 2 / 通道 3。

## 三、数据契约要点（改任何一端都要同步这三条）

| 项 | 口径 |
|---|---|
| 取值规则 | 化验指标：`records[].date` 倒序取最新**非空**值，同一天取 `created_at` 更晚者；疾病指标：`diseaseMetrics[]` 每个 `code` 取日期最新的有值记录 |
| 键名 / 别名 | `latest` 的键 = 库内 `standard_code`；血红蛋白是 `Hb`。别名表见 `lib/metricsSummary.js:24` |
| 唯一实现两处 | MedData `data-server.mjs` 的 `summarizeLatest()` 与 MedBrief `lib/metricsSummary.js` 的 `summarizeState()`：**改一处必须同步另一处** |

## 四、复跑方式（验收/回归都跑这几条）

```bash
# 纯函数门禁（零网络，CI 必跑）
npm run test:unit          # tests/verify-unit.mjs，现 23 断言

# 真实 HTTP 链路（需 5174 在跑）
npm run test:live          # tests/verify-e2e.mjs，6 断言

# 取数链路实跑
curl -s http://127.0.0.1:8787/api/summary | head -c 300
curl -s http://127.0.0.1:5174/api/meddata/summary | head -c 300
curl -s "http://127.0.0.1:5174/api/brief/visit-summary?source=live&limit=3"
curl -s -X POST http://127.0.0.1:5174/api/brief/bundle \
  -H 'Content-Type: application/json' \
  -d '{"patient":{"name":"某患者","diagnosis":"B-ALL","stage":"MRD 监测"},"chiefComplaint":"复查"}'
```

## 五、已知边界与触发条件（延后项，不是 TODO）

| # | 现状边界 | 现在的替代做法 | 触发条件（满足才动手） |
|---|---|---|---|
| 1 | 只有「最新值」（`/api/summary`）与「近 N 次」（`visit-summary`，上限 10），**没有按指标 + 时间区间的时序端点** | 拉 `8787/api/state` 全量在前端自行过滤（45 份化验 ≈ 数百 data_points，能跑但不轻） | **`/records` 页真的要做趋势图**（要画折线 / 要按区间筛选）时，再加只读端点 `GET /api/meddata/series?code=&from=&to=` |
| 2 | **病理 / 骨穿报告没有结构化字段**：骨髓形态描述、免疫组化、染色体核型都还是 `docs` 里的自由文本；`latest` 里只有 `BM_BLAST_PCT` / `FCM_MRD_PCT` / `BCR_ABL1_RATIO` 三个点 | 医生看 `docs` 原文 + 速览里的三个疾病指标数值 | **出现「医生要按字段筛选骨髓报告」（如按核型 / 按 IHC 标志物检索）的真实需求**时，再定结构化 schema 与入库链路 |
| 3 | `lastImportedState` 是**进程内单例**（`server.mjs:58`）：多标签页同时导入会互相覆盖，服务重启即失 | 一次会话只导一份包；要对比两份就重导 | **IA 定稿后做「一份病历对应一份包」**时，改为 `Map<id, state>` 并按 id 取用（或干脆不缓存、每次带包调 `visit-summary`） |
| 4 | **超高图会掉行**：Vision 对 h/w > 2.8 的长图内部降采样，中间带成片丢（实测 h/w 3.21 时 48 行只剩 35 行，掉 27%）；与绝对像素高无关（3000×7216 h/w 2.41 满分） | 已在 `server.mjs` 的 `/api/intake/ocr` 自动切块（`lib/imageChunker.mjs`：h/w ≤ 2.8 单块不切；> 2.8 按 `targetAspect` 切块、逐块 OCR 后合并）。响应带 `chunked` / `chunks` / `chunkHeights` / `rawRowCount` / `chunkMerged` / `chunkValueConflicts` | 若换 OCR 引擎后单次调用不再降采样，则阈值与切块可整体下线；**判据：用 `rawRowCount` 与期望行数比，不看「某项在不在」** |

## 六、两条硬判据（图像切块 / 拼接，2026-11-12 实测得出，改动前先读）

1. **重叠必须 ≥ 一行文字高，不是「给个 30px 就行」** —— 判据写作 `overlap ≥ max(30px, 一行字高 × 1.2)`。
   实测：同一张 2000×6424 图按 2 块切，重叠 60 图像px 时两块 24+23 = **47**（边界行在两块里各残一半）；重叠 90/120/160 时 24+24 = **48**。
   本批 2× 截图一行高约 86px，故取 96。**别用「某个项目在不在」当掉行指标**（血红蛋白在最上，四档一次没丢，会得出错误结论），用 `rawRowCount`。
2. **合并键要选「稳定标识」，不要选「观测值」** —— 判据：键里只放 `(标准码|名称, 日期)` 这类稳定字段；曾经用「值也相同才合并」，
   结果边界切残的行带错值（「血小板 45」被切成「血小板 10」），按值去重会把它当**新行留下**（12 项变 13 行）。
   现在的做法：同一 (码, 日期) 内**按值投票**（残值只出现一次，多数值胜），并标 `chunkMerged` / `dedupedFrom` / `valueConflict`，绝不静默删。

## 七、倾斜矫正（deskew，2026-11-12）

**为什么**：整页倾斜时 `groupBlocksIntoRows` 的「同一行 y 相近」聚类会崩 —— 实测旋转 2° 解析行数掉 27%，而缩分辨率（800px 宽）、灰度、低对比**全部无影响**。所以预处理只能做 deskew，不要回头优化清晰度。

**实现**：`lib/deskew.mjs`

| 导出 | 作用 | 关键约束 |
|---|---|---|
| `estimateSkew(input, opts)` | 缩到 300px 宽 → 灰度二值化 → 在 **−5°…+5°（步长 0.5°，共 21 个角度）** 上做行投影、取**方差最大**者 | 纯本地计算不调 OCR；稳态 **26–39ms（中位 27ms）**，预算 **≤ 150ms**（300px 宽 × 21 角度）；返回的就是**矫正角**（符号已反） |
| `deskewImage(input, angleDeg)` | 白底放大画布后旋转，输出 png dataUrl | 只在需要时调用，避免无谓重采样 |
| `autoDeskew(input)` | 估角 + 条件矫正 | **死区 0.5°**：`|angle| < 0.5°` 一律不动（二次插值本身会让小字发糊） |

**顺序约束（硬）**：deskew **必须在切块之前**（`server.mjs` 的 `/api/intake/ocr` 里先 `autoDeskew`、再 `planChunks`）。先切块等于把歪图切成歪块，后面的切块与行聚类全部白做。

**`/api/intake/ocr` 新增响应字段**：

| 字段 | 含义 |
|---|---|
| `deskewAngle` | 矫正角（度，1 位小数）；正负与 canvas `rotate` 一致；`0` 表示判为水平或落在死区内 |
| `deskewed` | 是否真的旋转过（`|angle| ≥ 0.5°` 才为 `true`） |
| `deskewMs` | 估角耗时（ms），用于盯 150ms 预算 |
| `deskewConfidence` | 估角置信度（0–1，与次优角度的方差比）；低置信度时可靠人工校对兜底 |

**残留边界**：回正后仍可能丢 1 行（0.5° 量化 + 插值）。实测：歪 1°/3°/5° → 11/11；**歪 2° → 10/11**。可接受，人工校对兜底；详见 `docs/问诊资料卡.md` 的「已知边界」。
