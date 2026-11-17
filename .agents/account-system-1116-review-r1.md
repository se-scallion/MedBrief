# 账号系统 + 权限设计 · 独立审核 **r1**（plan-review §8.3）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/account-system-1116-plan.md` **v0.1**；输入 `.agents/account-system-1116-review-input.md`（8 条必攻击点）。
> 未改计划/代码、未提交、未动 `data/reports.json`、未调用 5174 的任何写接口（只发 GET 探活/取样，见 §4）。只写本文件。
> 判词里的每条结论都指到 `文件:行` 或 §4 的可复跑命令。

---

## 0. 总判：**不能直接进下一轮** —— 4 条 P0

方向我认（内置 `scrypt`+`node:sqlite` 自建、旁路归属表、服务端 session 可即时撤销、CLI 授权），四段排雷也基本齐。但**地基上有一个洞会让整件事白做**，另有 3 条决定成败的结构问题。**4 条 P0 全是"改文档/改设计表述"级别，不用重做方案**——改完直接进 r2。

| # | 级别 | 问题 | 一句话 |
|---|---|---|---|
| P0-1 | P0 | **静态托管把 `/data/**` 全公开** | 实测 `GET /data/reports.json` → **200 / 565794 B**、`GET /data/medbrief.db` → **200 / 83554304 B**。上鉴权后这两个 URL 仍然任何人可下 ⇒ 方案的核心价值被一行静态兜底抹掉 |
| P0-2 | P0 | **D1 矩阵漏了 12+ 条路由**（含写接口） | R8 自己说"真值 = 路由清单"，但矩阵只覆盖了 `grep` 出来的一小半；`POST /api/intake/blob`（写）、`GET /api/intake/blobs`（读全库 blob 清单）、`ocr/parse/stitch`、`reports/:id` 的 6 个方法、`/legacy`、`/meddata` 全没分组 |
| P0-3 | P0 | **鉴权钩子插入点会被绕过** | 计划写"`OPTIONS`(:216) 之后、`/api/health`(:243) 之前"，但 `/api/recognition-hits` 在 **:234**、OCR 观测 bump 在 **:229** —— 两者都在插入点之前。且非 `/api` 请求（静态）完全不经过钩子 |
| P0-4 | P0 | **登录可爆破 + 全局旁路无边界** | 无失败次数限制/锁定时长；`MEDBRIEF_AUTH=off` 是全局开关、无日志、不限定 loopback ⇒ 一次误设等于全裸 |

---

## 1. P0 逐条展开（改法都给到行）

### P0-1 静态兜底把 `data/` 整个目录公开了（比 API 裸奔更严重）

**实测**（只发 GET，未写）：

| URL | 状态 | 字节 |
|---|---|---|
| `/data/reports.json` | **200** | 565794（98 份报告全文 + 患者姓名 + patchLog） |
| `/data/medbrief.db` | **200** | 83554304（**83 MB 原件库**：所有报告原图/PDF 字节） |
| `/data/intake/patient.json` | **200** | 1636 |
| `/data/guahao-orders.json` | **200** | 3799 |

**成因**：`server.mjs:1782-1789`（9c「项目内其它真实静态文件」）对任意 `rel` 做 `path.join(__dirname, rel)` 并 `serveStatic` —— 既不鉴权、也没有目录黑名单。

**为什么这是 P0 而不是"顺手修"**：D1 的公开行写的是「静态资源/SPA 壳」，按字面实现，`/data/**` 依旧公开。用户要的是"普通用户只能看自己的报告"，而 `/data/reports.json` 一次就给 98 份，**权限矩阵再怎么设计都绕不过这个洞**。

**必改**（写进 D1 + D3 门禁）：
1. 静态托管加**显式黑名单**：`/data/`、`*.db`、`*.json`（除 SPA 需要的 assets）、`/docs/`（若含病案样例）一律 403；黑名单写在 9c 之前，不是"最后兜底"。
2. 门禁加两条**可复跑**断言（未登录必须 403/404）：
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5199/data/reports.json   # 期望 403/404
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5199/data/medbrief.db     # 期望 403/404
   ```
3. 明写：`/meddata`（`mountMedData`）与 `/legacy`（`:1775`）是**两套完整应用入口**，必须与 `/` 同级纳入门禁，不能算"静态壳"。

### P0-2 D1 矩阵漏的接口（真值清单，按 `grep -n "pathname ===" server.mjs` 实测）

| 路由 | 行 | 现状矩阵 | 风险 |
|---|---|---|---|
| `POST /api/intake/blob` | `:1398` | **缺** | **写**：任何人可往库塞 blob |
| `GET /api/intake/blobs` | `:1415` | **缺** | **读**：`listBlobs()` 返回**全库**原件清单（跨用户元数据泄露） |
| `POST /api/intake/ocr` | `:1458` | **缺** | 调外部识别引擎，可被打爆（成本/配额） |
| `POST /api/intake/parse` | `:1433` | **缺** | 同上（CPU） |
| `POST /api/intake/stitch` | `:1384` | **缺** | 同上（canvas 内存） |
| `GET /api/recognition-hits` | `:234` | **缺** | 观测统计外泄 + 位于钩子之前（见 P0-3） |
| `GET /api/intake/reports/:id` | `:1028` | **缺**（只写了列表） | 单份详情含全文；必须 owner 校验 |
| `DELETE /api/intake/reports/:id`（含 `?purge=1`） | `:1068` | **缺** | 同 PUT 一类写操作 |
| `POST /api/intake/reports/:id/restore` | `:1128` | **缺** | 从回收站恢复 |
| `POST /api/intake/reports/:id/patch` | `:1150` | **缺** | 改指标行 |
| `PUT /api/intake/reports/:id` | `:1227` | **缺** | 重导/更新原报告 |
| `POST`/`GET /api/intake/reports/:id/corrections` | `:1289`、`:1306` | **缺** | 反馈表写入/读取 |
| `/legacy`、`/next/` | `:1775`、`:979` | **缺** | 旧工作台/开发资源 |
| `/meddata/*`（`mountMedData`，`:1754` 前调用） | — | **缺** | 第二套完整应用 |

**必改**：D1 改成"按 `文件:行` 逐条列出"的**穷举表**（每条：方法 + 路径 + 所需权限 + 是否 owner 校验），并加一条自检：`grep -c "pathname ===" server.mjs` 的条数 ≤ 矩阵行数（对不上就说明又漏了）。动态路由用正则列出（上面 6 条已在 `:1028-1306`）。

### P0-3 钩子插入点：`OPTIONS` 之后不等于"所有业务路由之前"

`server.mjs:213-243` 的实际顺序：`setCors`(:214) → `OPTIONS`(:216) → `new URL`(:223) → `pathname`(:224) → **OBSERVED_ROUTES bump(:229)** → **`/api/recognition-hits`(:234)** → `/api/health`(:243)。

计划的插入点（"`:243` 之前"）会**把 :229 和 :234 留在鉴权之外**：未登录者仍可打 `/api/recognition-hits`，且每次未鉴权的 OCR 请求仍会先 bump 一次观测。

**必改**：钩子放在 `const pathname = ...`(`:224`) **之后、:226 的空行处**，且**必须区分路径类**：
- `/api/**` → 过鉴权（`/api/health`、`/api/auth/login` 在钩子内显式放行）；
- 静态/SPA 路径 → 过**白名单**（含 P0-1 的黑名单拒 `/data/**`）；
- `OPTIONS` 保持在钩子之前（预检不能要凭证），但其 `Access-Control-Allow-Origin: *`（`:164`）必须收窄成同源回显，否则带 cookie 时浏览器直接拒。

### P0-4 登录爆破与全局旁路（`MEDBRIEF_AUTH=off`）

- **爆破面**：用户名是 11 位手机号（空间小且可枚举），端点对 LAN 开放（`server.mjs:1808` 绑 `0.0.0.0`）。D0/D3 没有任何失败计数、退避或锁定 ⇒ scrypt 再慢也挡不住长时间慢速爆破。
  **必改**：`users` 加 `failed_count`/`locked_until`（或进程内 per-phone 指数退避）；第 5 次失败起 1s→2s→4s…；连续 10 次锁 15 分钟并写审计日志。全部可在 30 行内做完。
- **全局旁路**：`MEDBRIEF_AUTH=off` 无日志、不限定来源、默认出现在文档里 ⇒ 误设一次整站裸奔，且事后无法知道是否被用过。
  **必改**：① 打开时必须 `console.error` 一行醒目告警并在 `/api/health` 回 `auth:'off'`（可探活发现）；② 只允许 `127.0.0.1` 请求走旁路（`req.socket.remoteAddress`），LAN 来源一律仍鉴权；③ 写进 D3 门禁：`curl /api/health | grep '"auth":"on"'`。

---

## 2. 逐条闭环核对表

**上轮意见：无（首轮）**。本表按计划自身的 R/F/C/D 条目给出我的核查落点。

| 计划条目 | 我的复核 | 判 |
|---|---|---|
| Q1 "当前无账号概念" | `grep -rn -i "auth\|login\|session" server.mjs lib` 命中皆 114 平台票据（`:612-647`/`:757-768`/`:816-824`）；`setCors` `*`（`:163-167`）；98 份报告字段 **29 个**，`owner/account/user/tenant/userId` 全无 | ✅（字段数计划写 30，实测 29，轻微） |
| Q1 病友档案单份 | `data/intake/patient.json` 仅 `p1` | ✅ |
| R2 计数 98/3/3 | `node -e` 实测 `98 3 3` | ✅ |
| R5/F1 "writeStore 白名单会丢新增字段" | **表述不准**：`lib/reportStore.mjs:60-71` 只白名单**顶层四字段**；`reports[]` 数组是原样透传 ⇒ **写在单条报告里的 `owner` 不会被丢**。旁路表仍是对的选择（避免 565 KB 全量重写、避免双份真相、避免原子写压力），但理由要换成这三条，别再写"写进去会被丢字段" | ⚠️ 事实订正 |
| F2 钩子位置 + `/api/health` 公开 | health 公开 ✓；钩子位置 ❌（见 P0-3） | ⚠️ |
| F3 归属键用 `user_id` 不用 phone | 正确，且与"改账号=改 phone"自洽 | ✅ |
| F4 前端隐藏 tab 不是安全边界 | 正确；但 D1 前端只写"过滤 PAGES"，**页内按钮没分层**（见 P1-1） | ⚠️ |
| F5 测试隔离 | 方向对，但 `tests/verify-e2e.mjs:15` 硬编码 5174 的说法我核到的是 `localhost:5174`，正确；端口要给具体值（计划用 5199，与 `tests/verify-report-delete.mjs:29` **冲突**，见 P1-4） | ⚠️ |
| F6 MCP 直连无凭证 | `mcp/intake-server.mjs:23` `BASE = MEDBRIEF_URL || 127.0.0.1:5174` ✓ 无凭证；但 `web/src/api.js:2` 的 `jfetch` **本来就没有跨源问题**：同源 `fetch` 默认 `credentials:'same-origin'` ⇒ 计划里"需加 `credentials`"是 no-op（见 P1-3） | ⚠️ |
| F7 长驻/重启纪律 | `server.mjs:240-242` 注释、`/api/health` head/dirty 判据引用正确（实测 `head:afcae04, dirty:true`） | ✅ |
| F8 治理资产 | 方向对；`INTERFACE.md` 是否存在于仓库需确认（`ls INTERFACE.md`） | ⚠️ 待核 |
| F9 复用同一个 `medbrief.db` | `lib/blobStore.mjs:13` 用 `MEDBRIEF_DATA_DIR` ✓；注意它每次调用都 `new DatabaseSync` 开一次（`:15`），新表加在其中即可，**不要**另开 pragma | ✅ |
| R4 三义账号隔离 | `grep -rn '13228372097\|13200000000'` → 仅 `.agents/MEMORY.md:71,120` 有 `13228372097`；**`13200000000` 全库 0 命中**（说明它确实是新号，无历史数据可冲突） | ✅ |
| R8 真值=路由清单 | 声明正确，但矩阵没照做（P0-2） | ❌ |
| D2 开源取证 | 三条数字我**逐一复核通过**：better-auth ★30760 / pushed 2026-11-16 / 未归档；oslo ★1143 / pushed 2025-01-20 / **archived:true**；`node -v` = v22.22.1 | ✅（见 P1-5 的两处厚度不足） |
| D3 回退与门禁 | 覆盖"删文件/DROP TABLE/旁路/快照"，**不覆盖误授权与误指派的回滚**，且验收命令含 `...` 不可复跑（见 P1-2） | ❌ |
| D4 五个待定 | 三个真需要用户拍板、一个可自决、一个漏了（见 §3-6） | ⚠️ |

---

## 3. 八条必攻击点逐条回答

### 1. R4 三义账号是否隔离干净？——**当前干净，但方案只隔离了"两个"，第三个没落地**
- 交叉污染核查：`13228372097` 只出现在 `.agents/MEMORY.md:71`（挂号手机号/114 实名）与 `:120`；`server.mjs`/`lib`/`data` **零命中**；`13200000000` 全仓零命中。⇒ 不存在"本地账号与 114 号混用"的现存数据。
- 但方案的隔离只到"两表分离、互不改写"（D4-1），**没有一条机制防止将来混用**。建议加两条硬约束：① `users.phone` 与 114 号**允许相同也不许复用同一登录态**（114 走 `cmi-user-ticket` cookie，本地走 `mb_session`，两者不得互相认证）；② `.agents/MEMORY.md` 增一条"MedBrief 本地账号 ≠ 114 账号 ≠ 用户将来要改的号"（计划 F8 已提，落实即可）。
- **"报告归属 user_id、phone 可改"是否覆盖"后期改账号"的全部语义？——不覆盖**。它只覆盖"改登录名"。用户那句"后期会改账号"有两种读法：(a) 改登录手机号；(b) 把 98 份报告换给另一个人。方案把 (b) 明确排除（D4-5「本版不做 reassign」）——这是**替用户做了决定**，必须回到用户面前确认一次（见 §3-6 与 P1-1）。

### 2. F3/F1 归属键与 reports.json：**旁路表对，但你的证据链有一处错**
- `lib/reportStore.mjs:60-71` 实测：`out` 只含 `version/reports/trashed/audit` 四字段 ⇒ **顶层新增字段**会被 `JSON.stringify` 丢掉 ✓。
- 但 `reports: store.reports` 是**原样透传**（`:63`）⇒ **写在单条报告对象里的 `owner` 不会丢**。所以"改 reports.json 会丢字段"这句话只对"新增顶层数组"成立。旁路表仍赢，但请把理由换成：① 98+3 条 = 565 KB 全量重写一次（`data/reports.json` 实测 565794 B）；② 归属与报告内容混在一个文件 ⇒ 两个真相源、审计难；③ 每次改派都要走原子写，与"报告内容零变更"不符。
- **`audit` / `blobs` 是否漏**：`audit` 是日志流水，不指派 owner ✓（计划 R2 说对了）；`blobs` **必须**处理——单份报告的 `sourceBlobs[]` 里存的是 `blobId`，而 `GET /api/intake/blob/:id`（`:1424`）只按 id 取字节。若不做 owner 校验，"知道 id 就能下别人原件"；而 `GET /api/intake/blobs`（`:1415`）直接 `listBlobs()` 全库。⇒ 必须写进 D1：`blob/:id` 用 `report_owners` 反查 id 所属报告；`blobs` 列表按 owner 过滤或仅 admin。
- 初始指派 **98 + 3** ✓ 与实测一致（trashed 3 条也要指派，计划已写对）。

### 3. F6 MCP 断链：`MEDBRIEF_SERVICE_TOKEN` **必要但不充分**，且你的 `credentials` 那条是 no-op
- `mcp/intake-server.mjs:61` 是唯一出口 `fetch(BASE + path, …)`，`:23` 写死 127.0.0.1:5174、无任何 Authorization ⇒ 上鉴权后 MCP 全 401 ✓（计划这条对）。
- **不充分的三点**：
  1. **token 的权限范围没定义**。MCP 会写：`POST /api/intake/reports`(:173)、`POST /api/intake/patient`(:218)、`POST …/patch`(:231)；也会**读全库**：`GET /api/intake/reports`(:190)。⇒ 服务身份必须被定义为"**报告读写 + 卡片 + OCR + stitch/parse 的一个内部角色**"，且**不含** `/api/admin/*`、`/api/guahao/reset`。计划只说"同等服务身份"，实现方很可能直接给 admin。
  2. **服务身份看谁的报告？** owner 过滤上线后，MCP 的 `list_reports` 要么带 `user_id` 参数、要么服务身份拥有全局读。这是个必须写死的语义（我建议：token 显式绑定 `user_id`，MCP 侧不传就用绑定值 —— 这样"谁的 MCP"就有答案）。
  3. **token 存放与校验**：必须 `仅 loopback 接受` ✓（计划有）+ 从环境变量读、不进 git、不进 `data/`（否则 `/data/**` 一泄露就全丢，见 P0-1）。
- **CSRF：`credentials:'same-origin'` 是 `fetch` 的默认值**，`web/src/api.js:2` 现在不写也已经是同源带 cookie ⇒ 这一条改成"无需改，但显式写上作为意图声明"即可。真正要做的是：
  ① cookie 设 `SameSite=Lax`（计划已定）——它已阻止跨站 POST；
  ② **盘一遍"GET 有无副作用"**：扫完 `server.mjs` 的 GET 路由，副作用类都在 POST/PUT 块内（`:657` 起的 `if (req.method === 'POST' || 'PUT')`），**没有发现 GET 写库**；但 `/api/guahao/114/launch-login`（`:784`）会**启动真实 Chrome 窗口**，虽在 POST 块内、仍建议单独加"仅 loopback + 仅 admin"——它不是普通用户该能触发的动作。

### 4. F7 重启与长驻：head/dirty 引用正确，但**钩子会被静态托管和 OPTIONS 之间的路由绕过**
见 P0-3（`:229`/`:234` 在插入点之前）。另外两点：
- `curl /api/health` 的判据要写成 `head == git rev-parse --short HEAD` **且** `dirty:false`（实测现在是 `dirty:true`，说明工作区有未提交改动；上线验收要求 dirty 应为 false，否则"跑的是哪个版本"仍说不清）。计划 F7 只提了 head，没提 dirty。
- 新增的 `/api/auth/*` 必须出现在 `/api/health` 之外（health 保持公开）✓，但**别把 health 的 `dirtyCount` 去掉** —— 它是判"进程是否落后于代码"的唯一抓手。

### 5. D1 权限矩阵完整性：**不完整，漏 14 条**（清单见 P0-2）
按 `grep -n "pathname ===" server.mjs` 实测 30+ 条，矩阵只覆盖了其中约一半。最要紧的三条：`POST /api/intake/blob`（写）、`GET /api/intake/blobs`（读全库清单）、`GET /api/intake/reports/:id`（单份全文，动态路由整组漏）。**另加隐含一条**：`/api/intake/reports` 的 GET 要"只返回本人 owner 的报告"，这需要**改列表端点**（不是纯中间件能做的）——计划 D1 写了这句话，但 B 段 F1 说"不动 reports.json"，两者不冲突，**但实现方可能理解成"只加中间件"**，要明写"列表端点需按 owner 连接过滤"。

### 6. D4 哪些是作者无权替用户决定的？——**3 条必须问、1 条可自决、1 条漏了**
| D4 | 我的判定 |
|---|---|
| 1 管理员手机号用 `13200000000` | **用户已说过**（原话"先存在这个账号下"）⇒ 可执行，但仍需一句确认（因为 114 号是 `13228372097`，两个号容易被当成同一个） |
| 2 普通用户"只读" | **必须问**。"只能使用报告库"可读成"能看能改"。而且这条直接决定报告库页内**编辑/删除/回收站/彻底删除**四个按钮对普通用户是否可见——D1 的前端门禁只写了"过滤 PAGES"，**页内按钮分层一个字没提**（这会立刻出现"按钮在、点了 403"） |
| 3 「资料录入」「病历交换包」归 admin | **必须问**：这是授权决定，不是技术默认 |
| 4 管理员密码下发方式 | **可自决**（CLI stdin 是工程选择） |
| 5 改账号=改登录名 vs 转移报告 | **必须问**（用户原话歧义），且若答案为"转移"，本版要预留 `reassign`，否则要返工 |
| **漏掉的第 6 条** | **普通用户能否下载/查看原件（`/api/intake/blob/:id`）** —— 这等于"能否带走病历影像"，是数据导出级别的授权，必须显式问；计划把它塞进"登录即可"里（D1 第 2 行），属于替用户决定 |

### 7. 开源选型取证厚度：**数字全对，但两处厚度不足 + 一处"先下结论后取证"**
- **数字我全部复核通过**（`api.github.com` 实拉）：better-auth `stargazers_count:30760`、`pushed_at:2026-11-16`、未归档；oslo `stargazers_count:1143`、`pushed_at:2025-01-20`、`archived:true`；`node -v` v22.22.1。这一节没有虚报。
- **不足一：无版本锁**。两行都没有具体版本号（`npm view better-auth version engines` / `npm view oslo version` 可补），github-tool-scout §5 要求"版本/平台锁"，"README 未列 Node 原生 http 适配器"是**平台适配结论**，不是版本锁。
- **不足二：同类候选不足两个**。better-auth（全功能框架）与 oslo（已归档的工具集）都不属于"轻量密码+会话"这一类；真正的同类（lucia 已归档、`@node-rs/argon2`、`iron-session` 等）一个没取。因为最终选的是"自建"，这条不阻塞，但**不能写成"选了 2 个候选所以同类取证已达 §5"**。
- **一处"先下结论"**：D2 注里写"已派开源工具搜索 Bot 补做三路分流…其台账回来后并入本节，**本节结论不因台账细化而改变**"——这句话在台账未回时就是暴论。请改成"台账回来后如与本节冲突，以台账为准"。

### 8. G7/D3 回退与门禁：**不覆盖"误授权"和"误指派"，且验收命令跑不起来**
- **误授权回滚**：`users` 只有 `updated_at`，没有"谁在什么时候把谁的 `card_export` 打开"的记录 ⇒ 能撤销，但**无法发现**误授权。必加：`authz_log(id, actor_user_id, target_user_id, action, before, after, at)`，CLI 每次 grant/revoke 追加一行（与项目既有的"只追加、绝不回灌"口径一致）。
- **误指派回滚**：`report_owners(report_id PRIMARY KEY, user_id)` 是**覆盖式 UPSERT**（D0 明写"可重复运行（幂等 UPSERT）"）⇒ 一旦误指派并跑过一次，**原来的 owner 就永久没了**。必加：`report_owner_log` 或让 bootstrap 每次先写 `report_owners_bak_<ts>`（`lib/reportStore.mjs` 的备份先例可抄），否则"回滚"只是幻觉。
- **`DROP TABLE report_owners` 不等于回滚**：重跑 bootstrap 会把 98+3 条**全量重派给 `13200000000`**，期间任何人工改派都会被静默覆盖。要在 D3 写明"回退后重跑 = 回到初始态，不保留任何人工改派"。
- **验收命令不可复跑**：`curl -s -b /tmp/mb-normal.cookie .../api/intake/card` 里的 `...` 不是合法 URL（`:132-134`）。改成完整 `http://127.0.0.1:5199`。
- **门禁缺三条**：① 现有端到端 `node tests/verify-e2e.mjs`（防止鉴权把主流程打挂）；② `npm run check:blob`（83 MB 原件不能因重启/迁移丢失）；③ 上面 P0-1 的两条 `/data/**` 403 断言。

---

## 4. 复跑命令清单（本判词每条结论可自证）
```bash
cd /Users/scallion/Documents/projects/MedBrief

# P0-1：/data/** 现在是否公开（只读 GET，不写）
for u in /data/reports.json /data/medbrief.db /data/intake/patient.json /data/guahao-orders.json; do
  printf '%-30s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code} %{size_download}B' http://127.0.0.1:5174$u)"; done
sed -n '1782,1789p' server.mjs                      # 9c 静态兜底（无黑名单）

# P0-2：路由真值 vs 矩阵
grep -n "pathname ===" server.mjs | wc -l
grep -nE "req.method === '(PUT|DELETE)'|reports/\[\^/\]\+" server.mjs   # 动态路由 6 条：1028/1068/1128/1150/1227/1289/1306
grep -n "api/intake/blob\|api/intake/blobs" server.mjs                   # 1398 写 / 1415 读全库

# P0-3：钩子插入点之前已有的路由
sed -n '213,245p' server.mjs                        # :229 bump / :234 recognition-hits 都在 :243 之前

# P0-4：无失败限制 / 全局旁路的现状（计划里没有，故 grep 应为空）
grep -rn "failed_count\|locked_until\|rateLimit\|backoff" server.mjs lib | wc -l

# P1：writeStore 白名单只对顶层字段生效
sed -n '60,71p' lib/reportStore.mjs
node -e "const j=require('./data/reports.json');console.log(j.reports.length,j.trashed.length,j.audit.length)"

# 三义账号隔离
grep -rn "13228372097\|13200000000" .agents/MEMORY.md server.mjs lib data | head

# MCP 直连无凭证 + 它要写哪些接口
sed -n '23p;61p' mcp/intake-server.mjs
grep -n "call('/api" mcp/intake-server.mjs

# D2 取证复核（三条数字我已跑过，结论：全部相符）
curl -s https://api.github.com/repos/better-auth/better-auth | grep -E '"(stargazers_count|pushed_at|archived)"'
curl -s https://api.github.com/repos/pilcrowonpaper/oslo         | grep -E '"(stargazers_count|pushed_at|archived)"'
node -v
```

**需实现方实测（我不能起服务/写库的项）**：未登录 401 与越权 403 的六条 curl；`/data/**` 403；`auth:on` 探活；`verify-auth.mjs` 在 5199（避开 `verify-report-delete` 的 5199，见 P1-4）。

---

## 5. P1 清单（与 P0 同批改，不改方案结构）

| # | 问题 | 改法 |
|---|---|---|
| P1-1 | **页内按钮没分层**：D1 只过滤 PAGES，报告库里的「编辑 / 删除 / 移入回收站 / 恢复 / 彻底删除」、资料卡的「打印导出」按钮对普通用户仍可见 ⇒ 点了 403 | D1 增一列"页内按钮 → 权限"，前端按 `/api/auth/me` 的 `permissions` 隐藏；并把"隐藏≠安全，后端仍须 403"写进验收（两侧都测） |
| P1-2 | 误授权/误指派无审计、无历史（§3-8） | `authz_log` + `report_owner_log`（或 bootstrap 先备份表）；D3 回退段改写为"回到初始态，不保留人工改派" |
| P1-3 | F6 的 `credentials:'same-origin'` 是 `fetch` 默认值，写了是 no-op | 保留为意图声明但注一句"默认即如此"；真正要做的是 `setCors` 收窄 + 401 跳登录 + `launch-login` 限 admin/loopback |
| P1-4 | 端口冲突：计划用 **5199**，而 `tests/verify-report-delete.mjs:29` 已占 5199 | 改用 5196/5197（5193 被 `verify-reports-refresh` 占、5199 被 report-delete 占） |
| P1-5 | D2 缺版本锁与同类第二候选；"结论不因台账细化而改变"是先下结论 | 补 `npm view <pkg> version engines`；把注改成"台账与本节冲突时以台账为准" |
| P1-6 | D4 漏第 6 条（普通用户能否看原件）+ 3 条必须问 | 见 §3-6；`/api/intake/blob/:id` 的授权必须显式问用户 |
| P1-7 | F8 提到的 `INTERFACE.md` 是否存在于仓库未核 | `ls INTERFACE.md`；不存在就改指 `README`/`docs/` |
| P1-8 | 登录会话 7 天 + 无"记住我"、无并发会话上限 | 可留 7 天，但补"同账号最多 3 个活跃 session，超出踢最早"（防把 cookie 拷给多台设备共享病历） |

---

## 6. 我做了什么、没做什么
- 只读：未改计划/代码、未提交、未动 `data/reports.json`、未调用 5174 任何写接口（只发 GET：`/api/health` 未调，`/data/*` 四条取样、`api.github.com` 三条复核）。
- 只写了 `MedBrief/.agents/account-system-1116-review-r1.md`。

---

# 附录 A · v0.1a 补充判词（iron-session 并入后）

> 触发：`.agents/account-system-1116-plan.md` 由 v0.1 升 **v0.1a**（D2 并入「开源工具搜索」完整台账、会话改判 iron-session、better-auth 改判延后、新增 J6–J9）。
> **§0 的总判与 4 条 P0 全部不变**（它们与选型无关）；本附录只裁新增的 3 个问题 + 1 条新 P0。

## A-0 新增 1 条 P0 + 3 条裁定

| # | 结论 |
|---|---|
| **P0-5** | **D0 与 D2 是两套互斥的会话机制，现在同时存在** ⇒ 必须二选一，否则实现方挑一个、另一个变死文档 |
| **裁定 1** | **J7 与「服务端会话可即时撤销」不是二选一，而是在 iron-session 下必须二选一的代价**：无状态 ⇒ 只能整用户下线；要单会话踢出 ⇒ 必须留 `sessions` 表（此时 J7 冗余） |
| **裁定 2** | **小样 5 条断言不够**，至少补 5 条（见 A-3），且第⑤条要改写 |
| **裁定 3** | better-auth 改判「延后」我**同意**，但要补触发条件与插件取证（A-4） |

## A-1 P0-5：D0 与 D2 自相矛盾（必须是二选一，不能"都留着"）

**证据**（同一份 v0.1a）：
- `D0`（`:95`）：`sessions(token_hash TEXT PRIMARY KEY, user_id, created_at, expires_at, revoked_at)` + cookie `mb_session` + 「**令牌只存哈希**，登出即置 `revoked_at`」+ 「**因此用服务端 session，不用 JWT**」；
- `D2`（`:116`、`:121`）：会话改判 **iron-session**——「签名+加密的**无状态 cookie 会话**」「无状态⇒吊销需 `sessionVersion`」+ J7（`:133`）要求 `users.sessionVersion`。

这两句同时成立时：既"令牌只存哈希进表"，又"令牌不进表、加密在 cookie 里"。实现方必然只做一套，另一套成为误导后人的死文档。

**而且 D0 那句理由是选型前的**：「改后下一次请求立即生效（**因此用服务端 session，不用 JWT**）」——**iron-session 的 sealed cookie 在撤销语义上就是 JWT 那一类**（改动只影响新 cookie，旧 cookie 仍有效，除非全量作废）。所以这句话在 v0.1a 里已经把当初砍 JWT 的理由原样留给了 iron-session。

**必改（D0 重写为二选一，并把理由换成新机制的话）**：

| 方案 | 会话存哪 | 授权位即时生效 | 单会话踢出 | 一键全员下线 | 需要什么 |
|---|---|---|---|---|---|
| **A. iron-session（无状态）** | 加密 cookie | ✅（每请求读 `users` 行） | ❌ **做不到**（只能整用户作废） | ✅ `sessionVersion+1` | `SESSION_SECRET`（≥32 字符）+ J7 |
| **B. SQLite session（有状态）** | `sessions` 表 | ✅（同左） | ✅ `revoked_at` | ✅ 删该 user 全部行 | 一条 DB 查询（与 A 同样要读 users，成本几乎相同） |

**我的建议**：**选 A**，但必须接受"手机丢了只能把该用户全部会话作废"。理由：① 代码更少（不用 session 表、不用清过期行）；② `sessions` 表要自己处理过期清理与 token 哈希，正好是本项目最容易写歪的地方；③ 用户真实场景是"1 个管理员 + 少数普通用户"，"单会话踢出"没有实证需求（与 R7 的"低频人工动作"同一条口径）。
**但这条要用户或你拍一句**——它决定了"手机丢失时的处置动作"是什么，属产品语义。

## A-2 裁定 1：J7 与"即时撤销"不是并列，是代价交换

- J7 写「若最终选无状态 cookie（iron-session），`users.sessionVersion` 必须存在」——措辞对，但**如果按 D0 的 sessions 表实现，J7 就完全冗余**（直接查 `revoked_at`）。所以 J7 不是"两个都要"，而是"选了 A 就必须有 J7"。
- **必须写清一句话**（进 D0）：**iron-session 下"登出"只清客户端 cookie，不构成服务端撤销**；真正的撤销动作只有 `sessionVersion+1`（该用户全部设备下线）。这句不写，实现方会以为"登出=撤销"。
- J7 的触发点要列全：改密码、改手机号、停用（`disabled=1`）、管理员手动"踢下线"。**改手机号也要 +1**——否则旧 cookie 绑的还是旧号语义。

## A-3 裁定 2：小样 5 条断言不足，补 5 条 + 改写第⑤条

现有 5 条（`:145`）：① 无 cookie 401 ② 错密码 401 且时序差 <2× ③ `/me` 回 role ④ cookie 改 1 字节 401 ⑤ 重启后旧 cookie 仍有效。

**必须补**：
1. **`SESSION_SECRET` 管理**：从哪读（env/文件）、长度 ≥32、**不得落在 `/data/**` 或 `data/`**（与本判词 P0-1 的 `/data` 公开洞直接相关——secret 若进 `data/*.json` 就等于公开密钥）；轮换时旧 cookie 应 401（iron-session 支持多 secret 数组，要验"数组里第二个 = 旧 secret 时旧 cookie 仍可解"）。
2. **cookie 体积**：断言 `Set-Cookie` 值长度 < 4096（把 `role + card_export + guahao + sessionVersion` 塞进去后仍要留余量；将来加字段时这条会先红）。
3. **与本项目 `setCors` 的兼容**：`server.mjs:163-167` 是 `Access-Control-Allow-Origin: *`，带 cookie 时浏览器会拒。小样里要模拟一次"同源请求 + 一次跨源请求"，确认收窄后的行为（这条与 F2 同源）。
4. **原生 `node:http` 集成**：README 给的是 `nodeCookies(req,res)`，要验"在 `server.mjs` 的 `createServer` 回调里、`sendJson`/`setCors` 既有的写法下，能正确读写 `mb_session`"——这是本项目形态与框架文档的最大差异点，不验就等于赌。
5. **`sessionVersion` 实证**（替换现有第⑤条）：`重启后旧 cookie 有效` **且** `sessionVersion+1 后同一 cookie 401`。只有后半句才证明 J7 真的起作用；现在的第⑤条只证明了"无状态"，反而在说"泄漏的 cookie 重启后仍可用"。

另：小样放在 `/tmp/medbrief-auth-lab/` 且**只装 iron-session** ✓ 符合"不污染工程"，这条做法我认可。

## A-4 裁定 3：better-auth 改判「延后」——同意，补两处

- **同意改判**：它对应用户"后期接短信"（phone-number 插件），砍掉会丢掉将来省事的可能；延后不花成本。
- **补触发条件**（现在只写"延后"，没写何时重评）：`当短信登录排期时重评；或在自建方案出现"三方登录/2FA/多租户"任一需求时重评`。
- **补取证**：`phone-number 插件` 这条我只在计划里看到，**未在 README 核到**（Bot 台账若已取，请把 README 段落引一句进 D2；否则标"待核"）。计划已经承认 `toNodeHandler` 只见于 Express 文档 ✓，这条诚实，保留。

## A-5 顺带三条事实（供实现方少走弯路）
- **iron-session 的真实依赖是 2 个传递依赖**：`cookie@^2` + `iron-webcrypto@^2`（`npm view` 实测），纯 JS、无编译 ⇒ 与"不引入需编译的 native 包"（J9）不冲突，但 D2 表里"依赖"一栏应如实写这两个，别写成"零依赖"。
- **ESM-only** ✓ 与本项目 `server.mjs`（ESM）兼容；但 `tools/*.mjs` 与 `mcp/*.mjs` 也都是 ESM ✓，没有 CJS 障碍。
- **114 cookie 与 `mb_session` 不冲突**：114 用 `cmi-user-ticket`（`server.mjs:817`），名字不同、且 114 的登录在独立 Chrome 窗口里完成 ⇒ 计划标的"未取证项：是否冲突"可以用一条 `grep -n "cmi-user-ticket" server.mjs` 关掉，风险低。
- **J8 是对的，而且正好解决我 P0-2/P0-3 指出的问题**（40 个 `pathname ===` 之前做一处前缀匹配）。但要补两句：① **默认拒绝**——未匹配任何规则一律 403（不许"落到 else 就放行"）；② 加一条自检断言：`grep -c "pathname ===" server.mjs` 的条数必须 ≤ 权限规则的覆盖面（对不上即为漏配，这能把 P0-2 那类漏项变成可红判据）。
