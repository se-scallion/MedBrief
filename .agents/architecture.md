# MedBrief 架构文档

> 只记录 MedBrief 自身的架构决策。
> **跨项目接口契约**（与 MedData 的关系、OCR 调用、.meddata 格式）见 [`INTERFACE.md`](../INTERFACE.md)。
> **禁止在此处复述 MedData 的内部架构**，只写 MedBrief 自己的。

---

## 技术栈与运行环境

| 项目 | 技术 |
|---|---|
| 后端 | Node.js (ESM) · 纯 `node:http` · 无框架 |
| 前端（工作台） | `index.html` 单页 · 纯 Vanilla JS · 无构建工具（主界面，全部功能都在这） |
| 前端（114 挂号页） | `web/` React 18 + antd + Vite，构建产物 `web/dist`，由 server 托管在 `/guahao`；未构建时该路径返回 503 并提示 `npx vite build --config web/vite.config.js` |
| 浏览器自动化 | **ego-browser（ego lite）**，不可换 Playwright（见下方「关键判据」） |
| 依赖 | `node_modules` 软链接到 `MedData/node_modules`（省磁盘；`web/node_modules` 仅存 vite 临时目录） |
| 端口 | `5174`（固定，可用 `PORT` 覆盖） |
| 进程管理 | 手动启动 `node server.mjs`（尚未接入 launchd） |

---

## 模块职责

| 文件 | 职责 |
|---|---|
| `server.mjs` | HTTP 路由分发、API 实现、静态文件托管 |
| `lib/bjcyhScraper.js` | Playwright 探针穿透朝阳医院 CloudWAF，抓取主鸿鹄 14 天真实排班 |
| `lib/guahaoCore.js` | 本地挂号业务：排班种子数据、预约校验、订单管理、身份证合法性 |
| `lib/meddataBundle.js` | .meddata 交换包打包与解析，SHA-256 完整性校验 |
| `lib/typingCard.js` | 急淋 B 分型卡纯函数（同步自 MedData，MedData 是上游） |
| `lib/egoDriver.js` | 用 ego-browser 执行浏览器动作（每次动作一个子进程，脚本经 stdin 传入） |
| `lib/captchaSolver.mjs` | 图形验证码三级识别：逐色 OCR → 整图 OCR → AI 视觉 → null（转人工） |
| `lib/guahao114Flow.js` | 114 挂号流程状态机（19 个 stage）+ 号源容错解析 |
| `lib/guahao114Service.js` | 流程注册表 + 互斥队列 + 目录缓存 + 下单落库 |
| `lib/catalogStore.js` | 114 医院/科室目录缓存（`data/114-catalog/`） |
| `tools/browser-guahao.mjs` | 命令行驱动 114 全流程（`--list-depts` / `--solver-check` / 完整挂号），与网页入口共用同一套 lib |
| `tools/*.py` | **历史参考实现（Deprecated）**：2021–2022 年 PC 端 requests 脚本，114 PC 端已关停，仅作取证留档，不得用于当前链路 |
| `web/` | React + antd 的 114 挂号页（构建 → `web/dist`，server 托管 `/guahao`） |
| `index.html` | 完整 Web 工作台（单文件，含 CSS + JS） |

---

## API 路由表

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/health` | 服务探活 |
| GET | `/api/guahao/monitor/realtime` | 朝阳医院官网实时排班（Playwright 穿透） |
| GET | `/api/guahao/monitor/countdown` | 距下次 07:00 放号倒计时 |
| GET | `/api/guahao/schedule` | 本地种子排班查询 |
| POST | `/api/guahao/book` | 本地预约下单 |
| GET | `/api/guahao/orders` | 历史预约记录 |
| POST | `/api/guahao/cancel` | 取消预约 |
| POST | `/api/brief/bundle` | 录入病历并导出 .meddata 包 |
| GET | `/api/guahao/sniper/status` | 114 会话状态 |
| POST | `/api/guahao/114/launch-login` | 唤起 114 官方登录窗口 |
| POST | `/api/guahao/114/close-login` | 关闭登录窗口 |
| GET/POST | `/api/guahao/114/flow/*` | 网页驱动的完整 114 挂号流程 |

---

## 朝阳医院 CloudWAF 探针（lib/bjcyhScraper.js）

```
server.mjs
  → GET /api/guahao/monitor/realtime
      → lib/bjcyhScraper.js :: fetchLiveDoctorSchedule()
          → Playwright chromium.launch({ headless: true })
          → page.goto("https://www.bjcyh.com.cn/Html/Doctors/Main/Index_1220.html")
              ※ 直接 curl/fetch = 418（CloudWAF 拦截）
              ※ Playwright 无头浏览器 = 200 OK
          → page.evaluate() 解析排班表格
              - 识别 SchedulingState_icon14 title="停诊" → status: 'suspended'
              - 解析科室/时段/日期/出诊等级/费用
          → 返回 slots[] + activeCount + suspendedCount
          → 1 分钟内缓存复用（CACHE_TTL_MS = 60000）
```

**关键限制**：一次探测约 2–4 秒，UI 要有加载状态；探测完立即关闭浏览器实例。

---

## 114 平台架构（三层结构）

```
浏览器(Vue SPA) → 瑞数 WAF（Riversafe，$_ts 混淆 JS，动态令牌 HKNCYzbu）
                → 业务 API（/jtjk/mobile-service/**，JSON，code 0000 成功）
```

- 接口前缀：`https://www.114yygh.com/jtjk/mobile-service`
- 每个 XHR 自动带 `request-source`（渠道名）与 `HKNCYzbu`（瑞数动态令牌）两个头
- 手机号在请求体里是**加密串**（`contactPhoneNo` 为长 hex），必须由页面 JS 加密，不能手工构造

**关键判据——浏览器只能用 ego lite，不可换 Playwright**：
Playwright 自带 Chromium 与系统 Chrome（headless/headed）打开 114 首页时，直接返回 **202（瑞数挑战页）且挑战不完成**，随后业务接口全部 462。
ego lite 的 Chromium（真实指纹 + 独立 profile）可通过。故 `lib/egoDriver.js` 是唯一可行驱动。

**两条必要条件（缺一不可）**：
1. UA 必须含 `MicroMessenger`；缺它→瑞数 WAF 返回 462
2. 渠道用 `pathchannel=jt`（京通，value 16）；用 `dp`（点评）→ 业务层返回 `code 8888`

**渠道表（关键几条）**：

| value | 标签 | key | 可用 |
|---|---|---|---|
| 16 | 京通 | `JT` | ✅ |
| 32 | 大众点评 | `DIANPING` | ❌（需点评授权） |
| 15 | 北京通 | `BJT` | 未测 |

**接口可达性**：

| 接口 | 状态 |
|---|---|
| `/department/list/{hosCode}` | ✅ 可用，可据此验证医院编码 |
| `/hospital/list` | ❌ code 8888（需站点令牌），医院编码手填 |
| `/product/calendar` | 视风控（461=自动化会话，须能交接人工） |
| `/user/get`、`/phoneCode` | ✅ 可用 |

**登录状态机**：
```
打开 /newhlwyl/mobile/login?pathchannel=jt
  → 输入手机号（真实键盘输入）
  → 勾选《预约挂号服务协议》
  → 点「获取验证码」→ GET /captcha（图形验证码）
  → 填图形码 → POST /phoneCode（短信发出，60s 冷却）
  → 填短信码 → 登录成功，cookie 保持会话
```

---

## 放号时钟与声光预警

```
前端 JS（index.html）
  → setInterval(updateCountdownClock, 1000)
      → 计算北京时间（UTC+8）到明日 07:00:00 的毫秒差
      → 更新 #monitor-clock 显示
      → 关键节点触发 Web Audio API 蜂鸣：
          totalSec === 300 → 5 分钟预警
          totalSec === 60  → 1 分钟紧急
          totalSec === 10  → 10 秒倒计时
  → setInterval(loadLiveMonitor, pollInterval)  ← 自动巡检（15s/30s/60s）
      → 检测 slots 状态变化（suspended ↔ active）→ 触发蜂鸣
```

**放号规则**（院方确认）：北京朝阳医院每日 **07:00:00** 准时放第 **14 天**号源。

---

## 数据持久化

| 文件 | 内容 | gitignore |
|---|---|---|
| `data/guahao-orders.json` | 本地预约订单 | ✅ 已忽略 |
| `data/114-auth.json` | 114 登录凭据（实测 ticket/cookie 均为空，登录态实际存在 ego 浏览器 profile 里） | ✅ 已忽略 |
| `data/114-catalog/` | 医院/科室目录缓存（`hospitals.json` 309 家 + `depts/*.json`） | ❌ 入库（重新生成需要真实浏览器，故当 fixture 保存） |
| `data/114-flow/` | 每个流程 id 的截图与状态（`*_waf_blocked.png`、`*_captcha.png` 等 588K） | ✅ 已忽略 |
| `web/dist/` | 前端构建产物（1MB） | ✅ 已忽略（按需 `npx vite build --config web/vite.config.js`） |

---

## 未完成项（2026-11-12 盘点，按优先级）

| # | 事项 | 验收标准 |
|---|---|---|
| 1 | **114 号源接口 461 的解法未找到** —— 登录可自动化，`product/calendar` 稳定 461，当前终态是 `waf_blocked` + 人工选号 | 能跑出一次自动化「选号 → 提交」并在 114 端查到订单；做不到则必须在文档里固定「半自动」定位 |
| 2 | MedData `GET /api/summary` 只读接口未落地（现只有 `/api/health`、`/api/state`、`/api/blobs`） | 8787 返回 `{latest:{WBC,PLT,HGB,...}}`，MedBrief 前端能一键回填 |
| 3 | 工作台缺「从本地 MedData 载入近期指标」按钮与「就诊后一键导出 .meddata」完整交互 | `index.html` 两个按钮可用，走 8787 或 .meddata 文件降级 |
| 4 | 回归分层：`tests/verify-e2e.mjs` 打的是 `guahaoCore.js` 静态种子 + 本地订单，实测 0.14s，**不覆盖 114 真链路** | 拆成 `unit`（种子/校验）与 `live`（真浏览器，需人工短信）两档，CI 只跑 unit |
| 5 | 图形验证码识别率无样本支撑（AI 视觉仅 2/2 张），人工兜底不可撤 | 攒 ≥50 张样本给出通过率；未达标前保留人工弹窗 |

---

## 合并触发条件（到时再动，当前维持分离）

满足任一条件时，考虑合并进 MedData monorepo：
1. 被引用的 MedData 纯函数 > 10 个且改动频繁；
2. MedData 启动服务端多用户模式。
