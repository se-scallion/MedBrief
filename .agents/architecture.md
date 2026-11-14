# MedBrief 架构文档

> 只记录 MedBrief 自身的架构决策。
> **跨项目接口契约**（与 MedData 的关系、OCR 调用、.meddata 格式）见 [`INTERFACE.md`](../INTERFACE.md)。
> **禁止在此处复述 MedData 的内部架构**，只写 MedBrief 自己的。
> **但功能开工前必须先去 MedData 找现成实现**，见下方「### MedData 的位置 / 铁律」。

---

## 技术栈与运行环境

| 项目 | 技术 |
|---|---|
| 后端 | Node.js (ESM) · 纯 `node:http` · 无框架 |
| 前端（工作台） | `index.html` 单页 · 纯 Vanilla JS · 无构建工具（主界面，全部功能都在这） |
| 前端（React 整站，迁移中） | `web/` **React 19.3 + antd 6.6 + Vite 8 + dayjs**（实测解析版本，与 MedData 同一份 `node_modules`）。构建产物 `web/dist`（旧 114 页，托管 `/guahao`）与 `web/dist-next`（新版整站预览，托管 `/next/`），两者都已 gitignore |
| 浏览器自动化 | **ego-browser（ego lite）**，不可换 Playwright（见下方「关键判据」） |
| 依赖 | `node_modules` 软链接到 `MedData/node_modules`（省磁盘；`web/node_modules` 仅存 vite 临时目录） |
| 端口 | `5174`（固定，可用 `PORT` 覆盖） |
| 进程管理 | 5174 手动 `node server.mjs`（尚未接入 launchd）；8787 是**裸 node 进程**（不是 launchd，重启需手动）；8008 由 launchd `gui/501/com.user.meddata.api` 常驻 |

---

## 问诊资料卡（**主功能**，2026-11-12 用户定根本需求）

一句话需求：「导入病友的病例、报告单图片 → 识别 → 校对 → 生成给门诊医生一页看懂的资料卡」。
**数据只来自用户导入的图片，不读 MedData 任何库**（MedData 仅作本机 OCR 引擎，走 8008）。

```
图片（批量/粘贴/两张拼接）
  → lib/visionLayout.mjs      版式重建：Vision 的 boundingBox 按 y 聚类成行、行内按 x 排、序列表头还原
  → lib/reportIntake.mjs      解析与判重：parseLabRows（含双栏切分/续行归位/单位规范化）、sha256+dhash+内容指纹、
                              stitchVertically、groupForDoctorCard（医生阅读顺序分组）
  → lib/intakeCard.js         渲染：病友档案（不收身份证/手机号、姓名默认脱敏）+ 一页 A4 卡
  → server.mjs /api/intake/*  上传/识别/解析/拼接/入库/资料卡
  → web/src/pages/IntakePage.jsx（导入页，默认 tab）
```

### 报告导入固定流程（2026-11-12 定稿，样本：流式免疫分型报告单）

```
node tools/import-report.mjs <pdf|png|txt> [--apply]      # 默认 dry-run，只打印核对表
  1 取数    tools/pdf-extract.py（PDF 文本层，按 y 聚类重建行）/ /api/intake/ocr（图片）
  2 适配器  tools/report-adapters/*.mjs 由 pickAdapter 按版式特征认领（lab-panel 兜底）
  3 结构化  适配器 parse() → {meta, rows, warnings}（只照抄原文，不推断）
  4 查重    sha256 / dHash / 内容指纹（命中退出码 2，绝不静默覆盖）
  5 人核对  核对表逐行带 rawSnippet 原文片段
  6 入库+出卡 data/reports.json + data/intake/card.html / card.json
```

- **新增报告形式 = 新增一个适配器文件**（`tools/report-adapters/<form>.mjs`）+ 注册 + 一条只读断言；
  主流程、CLI、后端都不动。SOP 与踩过的坑：`docs/报告导入流程.md`。
- **字段口径**：存储仍是 `data/reports.json`（JSON 文件，不是数据库），但报告级/行级字段名与 code
  一律对齐 MedData 的 `records[] / data_points[] / diseaseMetrics[]`（`report_type`、`original_name`、
  `stream/analyte/qualifier`）。权威表 `docs/字段字典.md`；跨项目摘要见 `INTERFACE.md` 通道 1.5。
- **2026-11-12 新增字段**：报告级 `reportType/labName/barcode/sampledAt/receivedAt/clinicalDiagnosis/sourceFile`；
  行级 `originalName/stream/analyte/qualifier/rawSnippet`；code `FCM_CD34_PCT`（新标准码）+
  `custom:fcm-{gran,lymph,mono,nrbc}-pct`（自定义），并复用 `FCM_MRD_PCT`。
- **批量与并发（2026-11-12 同日加）**：`--dir <目录>` 一次跑整个文件夹，`--concurrency 1..8`（默认 4），
  `--review all|suspect|none`（默认单文件 all / 多文件 suspect）。实测 8 份图：串行 5788ms → 并发 4 的 2008ms；
  8008 单请求吞吐 594ms/份 → 并发 4 时 183ms/份（12 路 143ms/份，但单份延迟涨到 1.7s，故默认 4）。
  超高图切块在 `/api/intake/ocr` 里改为块间 `Promise.all`（h/w 3.06 两块：1.83s → 1.1s）。
  PDF 有文本层时 OCR 耗时为 0，所以「优先要 PDF 原件，其次截图」。
- **门禁**：`npm run test:import`（15 断言，零网络、dry-run 不写库；含批量、可疑行、防循环依赖）。

**实测能力（真实单据）**：单栏血常规 20/23（有值项 100% 正确、0 错值）；双栏血常规 26/26；
合成单 11/11。缺项是 OCR 未吐出结果值，靠人工补录。
**已知边界**：骨穿报告 / 出院小结 / 外院单据**未验证**（自由文本，解析路径不同）。
**超高图丢行已定性**：与段数/绝对像素高无关，只与拼图 **h/w** 有关 —— ≤2.8 稳定，≥2.9 中间带成片丢行
（h/w 3.21 掉 27%）；修法是超高先切块（块 h/w≈2.2–2.5、块间 30 逻辑px 重叠）再逐块 OCR 合并，
实测 35/48 → 48/48。详见 `docs/问诊资料卡.md` 与 `docs/brief-pipeline.md`。

**红线（改动前先看）**：
1. 卡片只陈述数值/日期/趋势/出处，**不写诊断结论与治疗建议**；
2. 缺项必须写「未提供」（没查 ≠ 没给我）；
3. 不编造：拿不到就留空；按标准序号插值补的名称必须打 `nameInferred`；
4. 隐私：病友是他人医疗数据 → 只落本机 `data/intake/`、`data/reports.json`（gitignore），不出网；
   fixture 必须过 `assertRedacted()`（token 黑名单 + 「含『地址』须有占位符」的结构不变量）。

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
| `index.html` | 完整 Web 工作台（单文件，含 CSS + JS）；合并后仅作 `/legacy` 回滚位 |
| `web/src/pages/IntakePage.jsx` | 资料导入页（默认 tab）：批量/粘贴上传、两张拼接、识别校对、入库 |
| `web/src/pages/CardPage.jsx` | 资料卡页 = **交互式问诊工作台**（v3.5）：顶部操作栏 + 体检条 + 三 Tab（指标总览/趋势/病程原件轴）+ 三大弹窗 |
| `web/src/pages/card/OverviewTab.jsx` | Tab1：基线四格 / 核心异常项 / 全部指标（搜索+胶囊筛选+分组折叠+两栏紧凑行） |
| `web/src/pages/card/TrendsTab.jsx` | Tab2：`trendAll` 自由勾选、网格并列（不做双轴/归一化）、点圆点溯源 |
| `web/src/pages/card/TimelineTab.jsx` | Tab3：全部报告按日期倒序，摘要「类型 · 单号 · 时分」 |
| `web/src/pages/card/SourceModal.jsx` | 弹窗1 原件溯源（92vw）：左原件预览（图片缩放/旋转；PDF 切页缩放）+ 右历史/同报告指标/修正入口 |
| `web/src/pages/intake/CardPreview.jsx` | 弹窗2 A4 打印预览（90vw 深灰底 + 3 页 iframe + `contentWindow.print()`；Cmd/Ctrl+P 转发） |
| `web/src/pages/intake/PatientForm.jsx` | 弹窗3 档案与三问编辑（`focusField` 支持点未录入项直接定位） |
| `lib/leukemiaChecklist.mjs` | 白血病核心资料体检（纯函数）：MICM 四项 + 近 30 天血常规，判不出即报缺；只看 `reportType`/正文/指标码，**不信 `kind`** |
| `mcp/intake-server.mjs` | 资料导入 MCP server（stdio、零依赖）：8 个工具全部转发本机后端，**不复制算法**；`intake_save_report` 在工具层拒绝 idCard/phone/address |

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

**微信对象（`WeixinJSBridge`）不是第三条必要条件（2026-11-14 实测）**：
不注入时 `typeof window.WeixinJSBridge === 'undefined'`，首页照常渲染「共 309 家医院」（**只测了未登录只读首页**，
登录后的查号/下单链路未实测，别把这条外推成「挂号不需要它」）。
驱动层因此把注入做成**显式开关**：`egoRun(script, { wxBridge: true })` 在 `prep()` 里用 CDP
`Page.addScriptToEvaluateOnNewDocument` 注册 `WX_BRIDGE_SRC`（早于 `page.goto`），默认关闭；
自检入口 `egoProbeWxBridge({ url })` 回「页面是否看见 bridge / 就绪事件命中几次 / 页面自己调了什么」。
用途只有一个：截微信侧调用参数（医保 `invokeMiniProgramAPI → openMedicalInsuranceService`）。
注意 CDP 注入与 UA 覆盖同一条纪律——**只对本次连接打开的文档生效**，每个动作要重新置位。

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
| 1 | **114 号源接口 461**：已确认与医院无关（朝阳、北大人民都 461）；`/order` 确认页可直连、`auth/patient/list` 200，但 `product/confirmV2` 缺 `product/calendar` 下发的 `uniqueProductKey/uniqueProductTimeKey` → 200 `8888`。**当前定位固定为半自动**（`waf_blocked` + 人工接管四步，见 playbook） | 只剩一条没测：放号时刻（每日 07:00）重打 calendar 是否解 461。测完即结案 |
| 2 | ~~MedData `GET /api/summary` 未落地~~ → **已完成并入库**（MedData `a148d3d`，含 aliases） | — |
| 3 | ~~工作台缺载入指标/导出交互~~ → **已完成**；但**用户已明确不做 MedData 取数**，该通道降为可选，主链路改为导入病友图片 | — |
| 4 | ~~回归分层~~ → **已完成**：`test:unit` / `test:live` / `test:intake`（含 card）/ `test:ui` 四档 | — |
| 6 | **新单据类型验证**：骨穿报告 / 出院小结 / 外院化验单均未验证（解析路径不同） | 每种类型给 1 张真实截图 → 一份脱敏 fixture + 一组断言（含 `assertRedacted()`） |
| 7 | **拼大图掉行**：两张真实报告 29 → 17 行，相同图 40 → 6 行，疑为 Vision 降采样 | 高度曲线取证；若成立则改为「分别识别再合并指标」（后端换算法、UI 多图分组） |
| 5 | 图形验证码识别率无样本支撑（AI 视觉仅 2/2 张），人工兜底不可撤 | 攒 ≥50 张样本给出通过率；未达标前保留人工弹窗 |

---

## 技术栈决策：React 而非 Vue（2026-11-12 用户拍板「用架构、方便后期升级」）

**结论：React。** 依据是仓库事实，不是偏好：

| 判据 | 事实 |
|---|---|
| 上游 MedData 的栈 | `meddata-ai` = **React 19.2 + antd 6.6 + Vite 8 + tailwind 3 + echarts 6 + react-router-dom 6**，`src/` 下 **69 个 `.jsx`、0 个 `.vue`** |
| 本项目已有代码 | 114 挂号页 `web/src/BookingPage.jsx` 707 行、迁移壳 `App.jsx` 均为 React；换 Vue 等于全部返工 |
| 组件库一致性 | 两项目共用同一份 `node_modules`（软链），`antd 6.6.6` 已就位；Vue 侧要另装 element-plus/naive，等于引入**第二套设计语言**（用户本来嫌页面丑，两套只会更丑） |
| 升级路径 | 两端同为 Vite，升版一次对齐；共享 UI 组件（图表/上传/OCR 预览）可整块复制，符合 `INTERFACE.md`「不建 monorepo、共享靠复制」的既有权衡 |
| 性能 | 实测 gzip 408KB，局域网场景可忽略 —— 用户已明确「不算重点」 |

**版本对齐规则**：MedBrief 不单独锁前端版本，跟随 MedData 已装版本（当前 `react 19.3.0 / antd 6.6.6 / vite 8.3.4`）。
要升就两边一起升，并在本文件更新这一行。

**暂不引入 react-router-dom**：整站目前用 tab 状态 + URL query（`?tab=`），够用；等真的出现多级页面再引，避免过度设计。

## 前端选型：React（2026-11-12 决策，不选 Vue）

**结论：React。** 不是性能之争（用户原话：这点损耗很少），是升级与管理的成本之争。

| 维度 | React（采用） | Vue（否决） |
|---|---|---|
| 与 MedData 同栈 | ✅ MedData 是 **React 19.2.7 + antd 6.6.6 + react-router-dom 6 + vite 8 + echarts 6 + tailwind**，59 个文件 import react | ❌ MedData 全仓 **零 Vue**（`grep vue` 无命中） |
| 依赖成本 | ✅ `node_modules` 软链到 MedData，react/antd/dayjs 现成，`vue` 未安装 → 选 Vue 要新装一套 | ❌ 需新增 vue/vue-router/pinia/element-plus |
| 组件与视觉 | ✅ antd 6 直接与 MedData 一致，主题 token 可对齐；echarts 可直接复用于指标趋势图 | ❌ 换 element-plus，两套视觉规范 |
| 知识可复用 | ✅ MedData 的 `.agents/testing-lessons.md` 里的 React/antd 坑能直接用 | ❌ 经验不可迁移 |
| 未来合并 | ✅ INTERFACE.md 已定「触发条件到了就并 monorepo」，同栈才是零摩擦 | ❌ 并库要重写一遍 |
| 上手直观性 | 中（JSX + hooks 心智） | ✅ 略优（模板语法更直白）—— 这是 Vue 唯一优势，但不足以抵消上面五条 |

**Vue 翻盘条件**（写清，别以后凭感觉反复）：MedData 迁到 Vue，或本项目要独立团队接手且他们只熟 Vue。二者都没有 → 保持 React。

**路由**：用 MedData 现成的 `react-router-dom@6`（不再自己写 Segmented 切 tab），因为「监控是挂号的子页」需要嵌套路由。

---

## 信息架构：5 个 tab → 3 个一级页（2026-11-12 用户要求「该合并合并」）

```
/guahao                     挂号（一级）
  ├─ /guahao                 选医生（医生库：最近 / 搜索 / 收藏）
  ├─ /guahao/:doctorId/monitor   该医生的排班监控（14 天出诊/停诊、07:00 倒计时、预警）  ← 原「排班监控」tab
  ├─ /guahao/:doctorId/flow      该医生的 114 流程（验证码/短信/waf_blocked 人工接管）  ← 原「114 挂号」页
  └─ /guahao/orders              我的预约与凭证（打印/取消）                            ← 原「预约凭证」tab
/records                    病历（一级）：录入、近期指标载入、一页速览、.meddata 导入导出  ← 原「病历整理」tab
/settings                   设置（一级）：114 账号登录态、轮询/预警偏好、开发者调试区（折叠） ← 原「登录凭据」tab
```

**合并规则**：
1. 一级页 ≤ 3；新增能力先问「挂在哪个一级页下」，回答不了才允许新开一级页。
2. 一切「按医生」的视图必须带 `:doctorId`，不允许再有「默认医生」的隐式行为。
3. 旧 `index.html` 的 5 个 tab 与上述 3 页一一折旧，不做一对一搬运。

## 前端合并（方案 C，2026-11-12 用户拍板：整站 React 化 + 视觉重构）

目标：**一套前端**。旧 `index.html`（手写 CSS + 表格，视觉不统一）已退到 `/legacy` 兜底，一个迭代后删。
技术选型：**React + antd**（理由见下「为什么不是 Vue」）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 壳：`web/src/App.jsx`（antd Layout/Header/Menu + 主题 token `#c8102e`）+ `api.js` 统一 fetch + `alarm.js` 蜂鸣 + 日志上下文 | ✅ 2026-11-12 |
| 1 | **出诊监控**：`tabs/MonitorTab.jsx`（antd Table/Tag/Statistic，真接口 `/api/guahao/monitor/*`） | ✅ |
| 2 | **挂号与预约**：`tabs/BookingTab.jsx` 包 `BookingPage.jsx`；医生改为下拉（`GET /api/guahao/doctors`，新增只读接口） | ✅ |
| 3 | **病历资料**：`tabs/BriefTab.jsx`（近期指标载入 + 一页速览三出口 + .meddata 导入/导出） | ✅ |
| 4 | **预约记录**：`tabs/OrdersTab.jsx`（订单列表 + 取消 + 凭证打印） | ✅ |
| 5 | **114 会话**：`tabs/SessionTab.jsx`（唤起登录 + 会话状态）。开发者排障区**故意未迁入**，符合「面向普通患者、禁止 F12」；需要时走 `/legacy` | ✅ |
| 6 | 收尾：`base=/`、`/` 即新壳、`/guahao` 与 `/next` 302 到 `/`、旧工作台 `/legacy`、`npm run test:ui` UI 冒烟 | ✅ |
| 7 | **遗留（未做）**：按「3 页 + `:doctorId`」引入 react-router、建医生库（官网页面 id/医院/科室/114 编码进数据）、App.jsx 由 5 tab 改为一级页 + 子路由，同步改 `test:ui` 断言 | ⏳ |

**URL 结构（定稿，与「信息架构 3 页」一致）**：引入 `react-router-dom@6`（MedData 已有此依赖），
`/guahao` 为一级页、`/guahao/:doctorId/monitor` 与 `/guahao/:doctorId/flow` 为子路由，`/records`、`/settings` 各为一级页。
理由：产品定位是「不能只服务一个医生」（见 MEMORY），排班监控必须按医生实例化，纯 `?tab=` 挂不住这层嵌套。
**当前代码状态**：`web/src/App.jsx` 仍是 5 tab + `?tab=` 的过渡形态，路由化改造未做（见下表「遗留」）。

**为什么不是 Vue**（2026-11-12 定稿）：
1. 已投入沉没成本：`BookingPage.jsx`（707 行）+ antd 组件 + 主题 token 已跑通，换 Vue = 全部重写；
2. 依赖形态：`node_modules` 软链到 MedData（React 项目），换 Vue 要新增 `vue`/`@vitejs/plugin-vue`/`element-plus`，
   等于污染上游项目的依赖树或另建一套安装目录，成本不是零；
3. 生态量级：React 的 npm 周下载量与中文后台组件（antd）成熟度都更大，招人/查资料更容易；
4. 性能：两者在本项目量级（一页表格 + 几个表单）都够，用户已明确「性能损耗不算重点」，不构成选择依据。

**护栏（阶段 0 确立，不许跳）**：
1. **API 一行不改**：迁移只动前端，`npm run test:live` 6/6 必须始终绿。
2. **UI 冒烟要有**：`verify-ui`（Playwright，依赖已在 MedData node_modules）断言 5 个 tab 可切、关键按钮存在、无 console error。
   否则「迁一个 tab 断一个按钮」不会红。
3. **定时器陷阱**：倒计时/轮询迁到 React 后必须 `useRef` 守卫 effect 双跑与 stale closure —— 抢号关键时刻静默失效最致命。
4. **迁移完成前不删旧版**：旧版 `index.html` 是回滚位，`/` 一直指向它。
5. 构建产物不入库（`web/dist/`、`web/dist-next/` 已 ignore），`npm start` 前记得 build。

**已修的真实 bug（迁移时发现）**：`getNextReleaseCountdown()` 用 `toISOString()` 打印位移后的 Date，
把 UTC 当北京时间显示（17:30 显示成 09:30）；且放号对应就诊日错用「今天 +14」，与院方「次日 07:00 放第 14 天」差一天。
现改为「epoch + 固定 +08:00，getUTC* 读墙上时间」，`targetDateForBooking` 以放号日 +14 计算：17:30 实测返回
`nowBeijing 2026-11-12 17:32:07` / `targetReleaseTime 2026-11-13 07:00:00` / `targetDateForBooking 2026-11-27`（与院方页面一致）。

## 合并触发条件（到时再动，当前维持分离）

满足任一条件时，考虑合并进 MedData monorepo：
1. 被引用的 MedData 纯函数 > 10 个且改动频繁；
2. MedData 启动服务端多用户模式。

## 前端导航与页面结构（2026-11-13 整合）

### 导航形态

`web/src/App.jsx` = `Layout.Header` + `Layout.Sider(Menu 两组)` + `Content`（原来是顶部 6 个 Tabs 平铺）。

```
资料   资料录入 · 报告库 · 病历交换包
出诊   出诊监控 · 挂号与预约 · 预约记录 · 114 会话
```

- **URL**：切页写回 `?tab=<key>`（`history.replaceState`，**未引入 react-router**）。
  `KEY_ALIAS` 兜住历史写法：`?merged=guahao` → `booking`、`/#session` → `session`、未知值回落 `intake`。
- **窄屏**：`Sider breakpoint="lg" collapsedWidth={56}`，`Content` 加 `minWidth: 0`（否则内容会把容器撑出横向滚动条）。
- **零新依赖**：只用 antd 自带 `Layout.Sider` / `Menu`。

### 页面文件（`pages/` 与 `tabs/` 的分工）

| 文件 | 职责 |
|---|---|
| `pages/IntakePage.jsx` | 资料录入：① 导入 ② 校对 ③ 资料卡，页内**吸顶分段条**（Segmented + scrollIntoView + IntersectionObserver） |
| `pages/intake/UploadPanel.jsx` | ① 批量导入 |
| `pages/intake/ReviewPanel.jsx` | ② 识别与校对 |
| `pages/intake/ProfilePanel.jsx` | ③ 病友信息 + 资料卡预览 + 打印/新窗口 |
| `pages/intake/ReportsPanel.jsx` | 报告库（自包含取数，按 reportDate 倒序） |
| `pages/intake/shared.js` | `ST / KIND_OPTIONS / FLAG_TEXT / uid / fmtSize / rawJson / postJson` |
| `tabs/*.jsx` | 出诊线五个页面组件（Booking / Brief / Monitor / Orders / Session） |

### 「同一功能唯一入口」（2026-11-13 验收表）

| 功能 | 唯一入口 |
|---|---|
| 上传 / 识别 / 校对 | 资料录入 |
| 报告清单 / 原件回看 | 报告库（卡片本身零跳转——印刷件上点不了，另存转发后 `/api/intake/blob` 是死链） |
| 资料卡预览 / 打印 | 资料录入 ③ |
| 病友档案 | 资料录入 ③ |

### MedData 的位置

- `web/src/meddata/` 是 **Vite `resolveId` 适配层**（不是重复实现，**不删**）：把 `meddata/src` 的
  `data/store.js`、`utils/docFileStore.js` 重定向到本地实现，保证「数据真相源只有 `data/reports.json`」。
- `meddata/src` 源码已入库（156 文件 / 2.23 MB）；`meddata/public/{tesseract,traineddata}` 49 MB 二进制
  不入库，见 `meddata/public/README.md`。
- **MedData 四引擎工作台不再是并行入口**：收进资料录入页右上「四引擎识别（实验）」的 Drawer（`React.lazy`），
  与主路径不并列、不占导航。

**铁律（2026-11-14 用户定）：任何功能开工前先去 MedData 找现成实现——先抄它的 bug 结论，再抄代码、组件、模块。**
自创规则前必须先回答一句「MedData 里做没做过、在哪个文件」。前端一律用 antd 现成组件（Table / Drawer / Modal / Space），
不手写列表容器——手写列表拿不到 sorter、展开、分页，报告库就是这么长出「没有排序、看不到内容」的。

已证实同坑三处（均在 MedData 侧实测过）：

| 需求 | 直接复用 | 禁止再做 |
|---|---|---|
| 报告类型识别 | `MedData/src/utils/parseDoc.js:148` 的 `detectDocType()`；类别单一事实源 `src/data/docKinds.js`；测试 `scripts/verify-doc-type.mjs`（25 条断言） | 自编关键字表。**尤其不许用 `EF/射血分数` 判心脏**——`parseDoc.js:190` 写明各彩超页脚都带 EF 注释，那是已踩的坑（实测本库 1 份心脏彩超被存成 `kind:lab`，MedData 判 `ultrasound / 超声心动图`） |
| 表格排序 | `src/components/DataGrid.jsx:277-400`：默认→升→降→默认 三态循环、多列互斥、**缺失值恒排末位**、字符串 `localeCompare(x,'zh-Hans-CN')` | 自创排序键（如 `reportDate \|\| createdAt` 两段键） |
| 原件存储 / 体检 | 写原件 `web/src/meddata/docFileStore.js:41-77`（`putBlob` 按 sha256 复用 + `takeBlobRefs()` → `sourceBlobs`）；体检口径 `MedData/scripts/check-blob-integrity.mjs`（「结构化引用里，有几份原件在库里根本不存在」），MedBrief 侧对应实现 `tools/check-blob-integrity.mjs`（`npm run check:blob`） | 各入口自己拼 payload —— `IntakePage.jsx:304-314` 没调 `/api/intake/blob`，实测漏 1 份原件（55 份里 54 有原件） |

复用方式：跨项目能 import 的就 import；不能的**逐条搬判据与注释理由，不复制第二份规则表**（两份规则迟早打架）。

### 前置依赖（已知约束）

前端依赖**借自 `../MedData/node_modules`**（根 `node_modules` 是软链），版本锁定在 `package.json` 的
`medbriefFrontendDeps`，详见 `docs/前端依赖.md`。换机器不装齐这棵树 → `vite build` 直接失败。

## 报告原件 Blob 存储（2026-11-13）

- `lib/blobStore.mjs`：SQLite（node:sqlite）`data/medbrief.db`，表 `blobs` + `blob_tombstones`，范式照 MedData `data-server.mjs:66`。零新增依赖。
- `server.mjs` 新增路由：`POST /api/intake/blob`、`GET /api/intake/blob/<id>`、`GET /api/intake/blobs`；`POST /api/intake/reports` 记录 `sourceBlobs`，并在写库后回填 `blobs.report_id`。
- `lib/reportIntake.mjs` 的 `findDuplicate()` 加护栏：dHash 近重复必须同单号或同报告日期才算（文本截图 dHash 会误判，实测 凝血 07-26 与 08-04 距离 0）。
- 工具链：`tools/ocr-table-rows.mjs`（保留定性行的表格解析）、`tools/import-inbox.mjs`（带原件批量入库）、`tools/repair-import.mjs`（回填 rows 与 blob 关联，幂等）。

## 导入工作流统一（2026-11-13）

- 唯一入口：`tools/workflow-screenshots.mjs`（截图 + PDF，七阶段：发现→取数→身份→**判重四层**→行抽取→跨屏配对→分类入库）+ `tools/import-inbox.mjs`（带原件入库）+ `tools/repair-import.mjs`（幂等回填）。
- 口径文档：`docs/导入工作流.md`（`docs/报告导入流程.md`、`docs/截图报告工作流.md` 已加指针，冲突以导入工作流为准）。
- 判重四层：sha256 / archive 同字节 / 库里同单号+报告日期 / 批内同单号+报告类型+报告日期；**dHash 只用「同单号或同日期」的近重复提示**。
- 门禁：`node tests/verify-import-workflow.mjs`（6 项断言）。

## 手机端导航形态与顶栏归属（2026-11-14，W10）

- **≤575px：隐藏左侧 Sider**（原来压成 56px、菜单文字竖排成单字，不可读不可点，还白占 56px），
  改由 Header 左上角「☰」（`.mb-nav-trigger`，`aria-label="打开导航菜单"`）打开 antd `Drawer`，
  复用同一份 `menuItems`（两组共 7 项），点条目走原 `go(key)` 并自动关闭抽屉。
- **≥992px 桌面完全不变**：Sider 168px 常驻、`KEY_ALIAS` 旧链兼容、`?tab=` 语义一律不动。
- **顶栏窄屏样式单一 owner = `App.jsx` 的 `APP_MOBILE_CSS`**：`CardPage` 的 `CARD_MOBILE_CSS`
  只留卡片专属规则（`.mb-compact-row`、`.mb-trends-grid`、`.mb-source-*`、`.ant-tabs-nav` 吸顶等），
  不再碰 `.ant-layout-header`。两处各写一份必然漂移。
- 判据（`tests/verify-ui.mjs` 常驻）：375 下 `header ≤80px` 且 `scrollWidth ≤375` **同时成立**、
  首屏内容起点 ≤96px、滚到中部仍 ≤80px、Sider 不可见、菜单 7 项可点切页、7 个菜单页「改后 ≤ 改前」。
- **改动陷阱（已踩过两次）**：给顶栏加/删元素会让 `nth-child` 序号整体位移；antd `Space` 会为
  `display:none` 的 item 仍保留 gap（桌面整体右移 12px）。所以：按文本/稳定 class 选元素，
  按钮放 Header 直接子元素而非 `Space` 内。
