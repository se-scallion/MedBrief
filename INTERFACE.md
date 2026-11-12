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

### 通道 2：本地数据直通（8787，本人电脑就诊前快速同步）

**适用场景**：用户本人在电脑前操作，准备去门诊前快速载入最新指标。

```
# MedData 数据服务探活（实跑返回，2026-11-12）
GET http://localhost:8787/api/health
→ { "ok": true, "version": 3780, "counts": { "records": 45, "docs": 28, "events": 51, ... },
    "blobs": { "total": 107, "referenced": 72, "missing": 0 } }

# 当前 8787 **只有**这三个路由（已核实 data-server.mjs）：
GET  /api/health        探活 + 计数 + 原件体检
GET  /api/state         全量状态
GET  /api/blobs         附件清单
PUT  /api/state         写入（MedBrief 禁止调用）
```

**MedBrief 侧使用原则**：
- 8787 不可用时，自动切换到「导入 .meddata 文件」方式，不报错；
- 读取是只读操作，MedBrief **永远不向 8787 写数据**（MedData 是数据权威）。

> ⚠️ **未落地**：`/api/records`、`/api/summary` **都不存在**（早期本文档写的前者也不存在）。
> 当前阶段只能用通道 3（.meddata 文件）。落地后再回来补本节。

---

### 通道 3：离线 .meddata 交换包（委托代诊 / 异地 / 不在同一台电脑）

**正向（问诊前，MedData → MedBrief）**：
1. MedData 点击「导出就诊交换包」→ 生成 `MedData-姓名-日期.meddata`；
2. MedBrief 页面导入该文件，自动解包展示病史时间线与最新指标。

**逆向（问诊后，MedBrief → MedData）**：
1. 代诊/家属在 MedBrief 拍摄新报告 → 点击「导出为 MedData 归档」；
2. MedData 页面导入，增量无损合并（同 SHA-256 的原件不重复导入）。

**.meddata 包结构（已实现，`lib/meddataBundle.js`）**：
```json
{
  "version": 1,
  "patient": { "name": "代聪", "idCard": "511025...", "exportedAt": "..." },
  "records": [...],
  "docs": [...],
  "sha256": "<包体内容的 SHA-256 指纹>"
}
```

---

## 四、共享纯函数（直接复制，不建 npm 包）

当前共享量少，直接在各自 `lib/` 下维护同名文件即可。**MedData 是上游**，算法改动以 MedData 的 `pnpm test` 门禁为准；改动后手动同步到 MedBrief。

| 文件 | 功能 | 同步触发条件 |
|---|---|---|
| `lib/typingCard.js` | 急淋 B 分型计算卡（纯函数） | MedData 侧有实质逻辑改动时 |

**合并触发条件**（达到时建 `packages/core` npm 包）：被引用纯函数 > 10 个或改动超过 3 次/月。

---

## 五、不共享的部分（各管各的，不要相互侵入）

| 属于 MedData | 属于 MedBrief |
|---|---|
| SQLite 病历数据库（data/meddata.db） | 挂号订单（data/guahao-orders.json） |
| 化验单 OCR 核心算法（dictionary.js / normalize.js） | 朝阳医院 CloudWAF 探针（lib/bjcyhScraper.js） |
| 疗程/费用/发票追踪 | 放号倒计时与声光预警 |
| 体温/输液/输血记录 | 114 登录链路与 WAF 绕过 |
| AI 精读任务队列 | .meddata 导入/导出 UI |
