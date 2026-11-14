# MedBrief ↔ MedData 接口契约

> **权威位置**：本文件是两个项目之间接口关系的**唯一真相来源**。
> MedData `.agents/architecture.md` 只保留一行摘要并指向本文件路径。
> **禁止在两边各维护一份**。

---

## 一、为什么不合并（决策已定，2026-11-12 用户拍板）

| 维度 | 判断 |
|---|---|
| 共享代码量 | 极少。OCR 通过 HTTP 调用，`typingCard.js` 仅 50 行纯函数 |
| 数据模型 | MedData 本地优先 / MedBrief 将来可能服务端托管，根本分歧还在 |
| 合并成本 | 重组 git 历史、调整门禁 |
| 现阶段收益 | 低，用本文件可覆盖跨项目协作需求 |

**再触发合并的条件**（满足任一才改 monorepo）：
1. 被引用的纯函数 > 10 个且改动频繁；
2. MedData 启动服务端多用户模式。

---

## 二、能力边界

```
┌─────────────────────────────────────────────────────┐
│  MedData（5173）           MedBrief（5174）           │
│  个人终身病历数据库          挂号监控 + 问诊资料整理    │
│  本地优先 · 单用户           可扩展服务端托管           │
│  · 化验/检查单管理           · 朝阳医院出诊监控         │
│  · OCR 识别引擎              · 放号倒计时预警           │
│  · 疗程/费用追踪             · 病历快照导出             │
│  · AI 精读（via 8008）       · 就诊凭证生成             │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
               └──────────┬───────────┘
                          │
              ┌───────────▼───────────┐
              │    8008 AI/OCR 网关    │
              │  (launchd 常驻托管)    │
              │  MinerU · Vision OCR   │
              │  AI 精读 · 验证码识别   │
              └───────────────────────┘
```

---

## 三、MedBrief 调用 MedData 能力的三条通道

### 通道 1：共享 AI/OCR 网关（8008）

MedBrief 直接调用本机常驻的 8008 网关，不需要自己部署 OCR。
网关由 launchd 常驻：`gui/$(id -u)/com.user.meddata.api`（状态 running，plist 在 `~/Library/LaunchAgents/`）。

```
# 探活
GET  http://127.0.0.1:8008/api/agent-mode
→ { "ok": true, "mode": "oneshot" }

# 化验单（表格行）识别 —— 多引擎
POST http://127.0.0.1:8008/api/ocr-vision
Content-Type: application/json
{ "id": "<请求幂等 id>", "image": "data:image/png;base64,..." }
→ macOS Vision 文本块（阻塞约 10s，60s 兜底超时）

POST http://127.0.0.1:8008/api/ocr-mineru
{ "id": "<请求幂等 id>", "image": "data:image/jpeg;base64,..." }
→ { "ok": true, "jobId": "..." }（异步作业，用 GET /api/ocr-mineru-status 查进度）

# 检查报告精读（doc 模式）
POST http://127.0.0.1:8008/api/ai-docread
{ "image": "data:image/...;base64,..." }
→ 精读任务（作业进度 GET /api/ai-docread-status）
```

> **2026-11-12 核实**：早期本文档写的 `POST /api/agent-recognize`（`mode: lab|doc`）在 MedData
> `server.mjs` 里**并不存在**，已按实际路由改为上表。改动 MedData 网关后必须回来同步此表。

**MedBrief 侧使用原则**：
- 8008 不可用时（502），降级提示用户手动输入，不阻断流程；
- 诊断命令：`curl -s http://127.0.0.1:8008/api/agent-mode`（无响应 = 8008 不在）；
  `127.0.0.1:5173` 侧经代理也能通（实测 200），但只作为旁证，不作为判据；
- 重启 8008：`launchctl kickstart -k gui/$(id -u)/com.user.meddata.api`。

---

### 通道 1.5：报告导入的字段口径（MedBrief 写自己的库，不写 MedData）

报告导入（图片/PDF → 结构化 → 资料卡）**只落 MedBrief 自己的 `data/reports.json`**，从不写 8787。
但字段名与 code 一律按 MedData 的 `records[] / data_points[] / diseaseMetrics[]` 口径命名，
目的是将来导出时不用二次翻译。**权威表**：[`docs/字段字典.md`](docs/字段字典.md)。

| code | 归属 | MedData 侧需要做什么 |
|---|---|---|
| `FCM_MRD_PCT` | 复用（`STREAMS.fcm.code`，定义=异常表型细胞/有核细胞 %） | 无 |
| `FCM_CD34_PCT` | **本仓新建标准 code** | 要进 MedData 字典/`SUMMARY_DISEASE_CODES` 才能出现在 `/api/summary`（改动在 MedData 仓） |
| `custom:fcm-gran-pct` / `-lymph-` / `-mono-` / `-nrbc-` | 本仓新建自定义字段（MedData 字典外项目命名空间） | 按既有约定落进 `store.customFields` |

> 2026-11-12 第一批样本（流式免疫分型报告单）落地时新增：报告级 7 字段、行级 5 字段，
> 列表与语义见 `docs/字段字典.md` §二/§三/§四。改这里必须同步那份文件。
>
> 同日第二批（染色体核型分析报告单）：新增报告类型 `KARYOTYPE` 的**全文型报告**——`rows: []` 是合法形态
> （核型公式/结论属自由文本，不字段化），全文存 `report.text`，原件存 `sourceFile`，卡片只体现为「报告数 +1」。
> 请求体 `meta.textOnly=true` 只用于让服务端跳过「空 rows 回退解析」，**不落库**；这批没有新增存储字段。

---

### 通道 2：本地数据直通（8787，本人电脑就诊前快速同步）

**适用场景**：用户本人在电脑前操作，准备去门诊前快速载入最新指标。

```
# MedData 数据服务探活（实跑返回，2026-11-12）
GET http://localhost:8787/api/health
→ { "ok": true, "version": 3780, "counts": { "records": 45, "docs": 28, "events": 51, ... },
    "blobs": { "total": 107, "referenced": 72, "missing": 0 } }

# 8787 现有路由（已核实 data-server.mjs）
GET  /api/health        探活 + 计数 + 原件体检
GET  /api/summary       近期指标摘要（只读，2026-11-12 落地；口径见下表）
GET  /api/state         全量状态
GET  /api/blobs         附件清单
PUT  /api/state         写入（MedBrief 禁止调用）
```

**`GET /api/summary` 契约（2026-11-12 落地，实跑验证）**

```
GET http://localhost:8787/api/summary
→ { "ok": true, "version": 3780, "generatedAt": "2026-11-12T09:14:21.905Z",
    "patient": { "age": 30, "gender": "Male", "diagnosis": "B-cell ALL" },
    "latest": { "WBC": { "code":"WBC", "label":"白细胞", "value":"6.83", "unit":"10^9/L",
                          "date":"2026-09-20", "reportType":"CBC", "status":"NORMAL",
                          "refRange":"3.5-9.5", "numeric":true, "num":6.83 }, ... },
    "aliases": { "HGB": "Hb", ... },
    "counts": { "records": 45, "diseaseMetrics": 8 } }
```

取值口径（**唯一实现两处各一份**：MedData `data-server.mjs` 的 `summarizeLatest()` 与 MedBrief `lib/metricsSummary.js` 的 `summarizeState()`，改一处必须同步另一处）：

| 规则 | 说明 |
|---|---|
| 化验指标 | 遍历 `records[].data_points`，取 `records[].date` 最新的**非空**值；同一天取 `created_at` 更晚者 |
| 疾病指标 | 取 `diseaseMetrics[]` 每个 `code` 日期最新的有值记录；`value: null` 视为未测，跳过 |
| 键名 | `WBC / PLT / **Hb** / RBC / NEUT_ABS / LYM_ABS / HS_CRP / BM_BLAST_PCT / FCM_MRD_PCT / BCR_ABL1_RATIO` |
| ⚠️ 别名 | 库内血红蛋白 code 是 **`Hb`**，不是 `HGB`；`HGB`/`HB`/`HEMOGLOBIN` → `Hb`（见 `aliases`），不要按 `HGB` 去查库 |
| 身份字段 | 摘要**不含**姓名/身份证/手机号；身份只随 `.meddata` 包走 |

**MedBrief 侧使用原则**：
- 走**服务端代理** `GET http://127.0.0.1:5174/api/meddata/summary`（`server.mjs`），token 由 env `MEDDATA_SYNC_TOKEN` 注入 `x-sync-token`，**永不下发前端**；
- 8787 不可用时该端点返回 `{ ok:false, unavailable:true, reason, fallback:"import" }`（HTTP 200，不抛错），前端据此自动降级为「导入 .meddata 文件」；
- 读取是只读操作，MedBrief **永远不向 8787 写数据**（MedData 是数据权威）。

> `GET /api/records` **仍不存在**（早期本文档写过，从未落地）；要取历史明细请用 `/api/state` 或 .meddata 包。

---

### 通道 3：离线 .meddata 交换包（委托代诊 / 异地 / 不在同一台电脑）

**正向（问诊前，MedData → MedBrief）**：
1. MedData 点击「导出就诊交换包」→ 生成 `MedData-姓名-日期.meddata`；
2. MedBrief 页面「导入 .meddata 文件」→ `POST http://127.0.0.1:5174/api/brief/import`（body `{ content: "<包文本>" }`）
   → 返回 `{ ok, sha256, patient, counts, latest, text }`，前端把 `text` 填进「近期指标」文本框（追加，不覆盖用户输入）。

**逆向（问诊后，MedBrief → MedData）**：
1. 代诊/家属在 MedBrief 录入/拍摄新报告 → 点「就诊后导出 .meddata」（`POST /api/brief/bundle` 后下载）；
2. MedData 侧按增量协议 `PUT http://localhost:8787/api/state`，body `{ changes: { upserts: <包 payload> }, baseVersion }`，由 `src/utils/mergeState.js` 按实体 `id` 合并 —— 同 id 取更新者、不同 id 追加、原有实体一个不丢。

> ⚠️ **现状（2026-11-12 核实）**：MedData **没有** `.meddata` 导入 UI/解析器（`src/utils/` 下无 `meddataBundle.js`），只有 `PUT /api/state` 增量协议。所以「导入」= 把包里的 `payload` 各实体数组作为 `upserts` 提交。
> **包结构以 `lib/meddataBundle.js` 实际产出为准**（早期本节画的 `{version, patient, records, sha256}` 是错的，已按实测改写）：`{ manifest: { format:"meddata-bundle", version:"1.0.0", schemaVersion, fingerprint, exportedAt, typingSummary }, payload: { patient_meta, records, docs, diseaseMetrics, events, courses, invoices, stays, drugPrices, customFields, typeCatalog, feverThresholds } }`，`fingerprint` 是 payload 的 SHA-256。

**「增量无损」的可复跑验收**（2026-11-12 实跑通过：原有 45/28/8/51/3/3 条 → 合并后 46/29/8/51/3/3，丢失 0，二次合并增长 0）：

```bash
cd /Users/scallion/Documents/projects/MedData && node -e "
const fs=require('node:fs');
(async()=>{
  const { mergeState } = await import('./src/utils/mergeState.js');
  const base=(await (await fetch('http://127.0.0.1:8787/api/state')).json()).state;
  const bundle=JSON.parse(fs.readFileSync('/path/to/x.meddata','utf8'));
  const merged=mergeState(base, bundle.payload);
  const ids=k=>(merged[k]||[]).map(x=>x.id);
  const lost=['records','docs','diseaseMetrics','events','courses','invoices']
    .reduce((n,k)=>n+(base[k]||[]).filter(x=>!ids(k).includes(x.id)).length,0);
  console.log({ lost, idempotent: mergeState(merged,bundle.payload).records.length===merged.records.length });
})()"
```

---

## 四、共享「口径」，不共享代码（2026-11-12 按实测更正）

| 文件 | MedData | MedBrief | 关系 |
|---|---|---|---|
| `typingCard.js` | `src/utils/typingCard.js`，**333 行**，`buildTypingCard()` 返回 `identity/hospital/onset/typing/genes/course/stage` 七段完整卡 | `lib/typingCard.js`，**45 行**，同签名但只产出 manifest 用的 `typingSummary` | **两套实现，形状不同，不存在「同步」这个动作**（旧表述「各自维护同名文件、改动后手动同步」与实际不符，已删） |

**共享的是口径，不是代码**（两套实现都必须守，改动任一侧都要人工核对另一侧是否仍在同一口径）：

1. 数值、病名、分期、基因型**只照抄来源**（表单/报告/库内记录），**拿不到就留空**；
2. 不推测、不兜底、不编造——`''` 优于一个看起来合理的默认值；
3. UI 侧对空值显示「未记录」，不得渲染成正常或占位结论；
4. 红线：只陈述数值与时间，不写诊断结论与治疗建议（`.agents/testing-lessons.md`）。

**2026-11-12 实例（两侧对账结果）**：MedData 侧**本来就合规**（`typingCard.js:314` 无诊断即空串、`pickOnset` 无依据返回空、`buildGenes` 只列检出通道），全仓 grep `2024-03|IKZF1缺失|CD19+|CD22+` 在生产代码 0 命中；**不合规的全在 MedBrief 侧**，`lib/typingCard.js` 原有 5 处兜底（诊断/分期/治疗描述/标志物/院名）已全部清空。

## 五、不共享的部分（各管各的，不要相互侵入）

| 属于 MedData | 属于 MedBrief |
|---|---|
| SQLite 病历数据库（data/meddata.db） | 挂号订单（data/guahao-orders.json） |
| 化验单 OCR 核心算法（dictionary.js / normalize.js） | 朝阳医院 CloudWAF 探针（lib/bjcyhScraper.js） |
| 疗程/费用/发票追踪 | 放号倒计时与声光预警 |
| 体温/输液/输血记录 | 114 登录链路与 WAF 绕过 |
| AI 精读任务队列 | .meddata 导入/导出 UI |

---

## 六、MedData 页面在 MedBrief 的独立挂载（2026-11-13 落地）

用户拍板「搬页面代码，逻辑代码尽量保持，识别引擎一起搬」，实现方式是**源码副本 + 隔离运行时**，不合并仓库、不改 MedData 主仓。

| 项 | 事实 |
|---|---|
| 入口 | `http://127.0.0.1:5174/meddata`（HashRouter：`#/reports/add?flow=lab\|doc`），与 MedBrief 主壳同一端口、互不侵入 |
| 源码 | `meddata/src/` 逐字节复制自 MedData（含 `ocr.js` / `normalize.js` / `ocrEngines.js` / 组件与字典），`meddata/public/` 含 tesseract wasm 与 traineddata；**未改任何一行逻辑代码** |
| 构建 | `npm run build:meddata` → `web/dist-meddata/`（`meddata/vite.config.js`，base `/meddata/`） |
| 运行时 | `meddata/mount.mjs`：托管 `/meddata`、`/tesseract`、`/traineddata`；MedBrief `server.mjs` 只在静态段前加一次调用（自有端点全部优先） |
| 数据红线 | `/api/data/*` 落 `data/meddata-mirror/`（state 增量 + blob 原件），**绝不连 8787、绝不写 MedData 任何库**；空库起步，不读 MedData 现有记录 |
| 网关 | 仅白名单端点（`/api/agent-mode`、`/api/ai-*`、`/api/ocr-*`、`/api/log`、`/api/feedback*`、`/api/patches`、`/api/gaps`、`/api/engine-status`、`/api/review-status`）转发 8008；AI 任务列表是 8008 logs 的真相源，**含 MedData 侧发起的任务**，不是 MedBrief 独立队列 |
| 实测 | 三个路由渲染 + AI 任务抽屉 + 上传后本地 OCR 36s 出 11 项核对网格，console 零错误；686KB 图片 POST 经代理到 Vision OCR 返回 31 blocks；MedBrief 既有 UI 9 项 / 单元 23 项门禁全绿 |

**已知边界（沿用 MedData 原逻辑，未改）**：化验单原图走 `saveRecordImage()`，每次上传按 `r_<ts>_<rand>` 新 id 存一份，不按 sha256 去重（`saveDocFile()` 才有内容寻址）。同一张图重复上传会产生多份原件；如需去重须单独评审，不要顺手改副本里的逻辑。
