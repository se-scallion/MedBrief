# MedBrief 账号系统 + 权限设计 —— 排雷与取舍 **v0.8**（2026-11-17 凌晨）

> 触发（用户原话）：「设计账号系统。先搜索有没有合适的开源项目，后期会接入短信，现在的话只用账号和密码。需要有一定的权限设计。普通用户进来是只能使用报告库。需要我授权之后才能使用问诊单导出（打印）功能，还有挂号功能。你设计完过计划流程。对了，确认一下当前是多账号设计吗？当前库里边所有的报告都归属账号13200000000（先存在这个账号下，后期会改账号）」
>
> **用户后续拍板（Q1，2026-11-16）**：「管理员账号是我13228372097。这些报告归属另外一个1320000000。」——**管理员与报告所有者是两个不同账号**；报告所有者号码位数**用户已确认 = 11 位 `13200000000`**（2026-11-16 用户原话「当然是11位」）。
>
> 排雷：**无项目定制层**（`grep -rn '^> \*\*通用层\*\*：~/.agents/skills/plan-review.md' .` 为 0 命中；宽松命中的 6 个文件全是正文引用，不是文件头标记），仅通用层。
> 版本：**v0.7（终稿）** — **r6 终判「可以开工」，P0 = 0**（本线第一份过审方案）。吸收 r6 附的 3 条 P1：`<2 KB` 断言补下界 + 状态码双断、 `PUT /api/data/state` 显式排除 401/403、G1 说明改 v0.7 并给 G 表加"复跑版本"列。
>
> **版本说明**：**r6 终判「可以开工」（P0=0）审的是 v0.7 的 admin-only 口径**。v0.8 装入了 r6 之后用户拍板的 Q2/Q3/Q5/Q6 权限语义变更（普通用户可增删改查自己的报告），该变更经 r6-addendum 审核查出 **2 条 P0**（blob 上传、patient 档案多用户隔离），本版按判词修完；"已过审"措辞仅指 v0.7 那部分。
> **r6-addendum 修订说明**：P0-1 → `POST /api/intake/blob` 开给登录用户 + `blob_owners` 表 + `GET blob/:id` 扩成"我的报告引用 或 我上传"；P0-2 → patient 档案按 uid 分桶 + 迁移 p1 给 owner + 隔离判据；P1-1 版本号；P1-2 `brief/import` 不落库 + `lastImportedState` 按 uid 隔离；P1-3 收尾句；P1-4 `?owner=` 仅 admin；P1-5 GET/POST patient 拆列。

> **用户最终拍板（2026-11-17，Q2/Q3/Q5/Q6 全部回答）**：「普通用户可以管理（增删改查）自己的报告。管理不了别人的。没有授权也无法导出、打印资料卡，还有使用挂号功能。管理员能管理所有人的报告。所有功能。」
> - **Q2** → 普通用户**可增删改查自己 owner 的报告**，**不能碰别人的**（写路径也要 owner 校验，不只是读）。
> - **Q3** → 「资料录入」「病历交换包」**普通用户也可用**（属于"管理自己报告"的一部分），但**导出/打印资料卡仍需 `card_export` 授权**。
> - **Q5** → 用户未明确说改号语义，维持"改登录名不改归属"推荐（保持 `reassign` 延后）。
> - **Q6** → 原件查看/下载归 `card_export`（"没有授权无法导出/打印资料卡"，原件是打印的前置）。
> - **管理员** = 全库报告管理 + 所有功能（天然全权限，owner 过滤豁免）。
> - **G6 四问已全部回答 ⇒ G6 转绿**（4 个 `[TBD]` 项清空）；`[TBD]` 期望值 4 → **0**。

> **开工门槛（r6 §0；Q2/Q3/Q5/Q6 已于 2026-11-17 拍板，此处仅留历史口径）**：**终判「可以开工」≠ 用户已授权编码**。① Q2/Q3/Q5/Q6 原是用户独立门槛，**现已全部回答**（见上），对应权限已落 D1/D4；② bootstrap 三步（admin=`13228372097` → owner=`13200000000` → `--apply` 指派 98+3）因 Q1+位数已定而解锁，owner 默认零授权（导出/打印/挂号仍须你另行授权）⇒ 四问不影响 `--apply`；③ 真正动手 = **用户确认 + G1–G8 除 G6 外全绿**，缺一不可。
>
> **修订说明（逐条对应 r6 附的 3 条 P1）**：
> - **P1-1** → D3 `/index.html` 断言改成状态码 + 区间双断（`=200` 且 `100 ≤ sz < 2000`），防空响应 `wc -c=0` 假绿。
> - **P1-2** → D3 `PUT /api/data/state` 断言改显式排除 `401|403`（cookie 过期回 401 也算被拦），要求 200/400/500 之一。
> - **P1-3** → G1 说明版本号订正，G 表加"复跑版本"列。
>
> 状态：**方案，未编码**。§8.7 开工 Gate 在本文末尾（G1–G8）。终判「可以开工」且用户确认后才编码。
> 工作目录：`/Users/scallion/Documents/projects/MedBrief`。

---

## 0. 先回答用户的两个确认问题（先摆证据）

**Q1：当前是多账号设计吗？——不是，当前根本没有账号概念。**

| 取证 | 命令 / 位置 | 结果 |
|---|---|---|
| 服务端无认证代码 | `grep -rn -i "auth\|login\|session\|token\|password" server.mjs lib` | 命中全是 **114 平台**的 `cmi-user-ticket`/cookie（server.mjs:612-647, 757-768, 816-824），没有一条是 MedBrief 自己的账号 |
| 所有 API 裸奔 | `server.mjs:163-167` | `Access-Control-Allow-Origin: *`，且全站没有鉴权中间件 |
| 报告无归属字段 | `node -e "const r=require('./data/reports.json'); ..."` | 98 条报告的 key 中 `owner/account/user/tenant` **一个都没有**；报告字段共 **29** 个（r1 实测订正，初版写 30） |
| 病友档案单份 | `data/intake/patient.json` | 只有 `id: "p1"`（刘梦圆）一份，无账号维度 |
| 报告原件库单库 | `lib/blobStore.mjs:13` | 单个 `data/medbrief.db`，`blobs` 表无 owner 概念 |

结论：现状是**单机单用户工作台**。「多账号 + 归属」是本次要新增的地基，不是已有设计的延续。

**Q2：报告现在归谁？——数据里没有归属记录；按用户拍板做一次性全量指派给"报告所有者账号"。**
用户拍板：**管理员 = `13228372097`（用户本人，与 114 实名号同号）；报告所有者 = 另一个号**（首次口述 `13200000000`，本次写 `1320000000`）——两者**分开建号**。由于报告本身没有 owner 字段，这句话在当前库里**不可验证、也不可回溯**（R1b/R4），只能当"从今往后的初始指派声明"。
因此账号分两层：**稳定 `user_id`（内部主键，永不变）+ 可变 `phone`（登录名，可改）**，报告归属存 `user_id`。报告所有者号码 **暂按 11 位 `13200000000` 处理，标 `[待用户确认位数]`，`--apply` 前必须拿到用户确认**（见 D4 / Gate G6）。

---

## A. 反向排雷（现有现实 → 新方案前提）

| # | 必查 | 证据 / 结论 |
|---|---|---|
| **R1** | 需求前提有没有实证 | 有实证。`grep -rn -i "login\|password\|session" server.mjs lib`：0 条本地账号逻辑；`server.mjs:163-167` CORS `*`。前端 `web/src/App.jsx:93-101` 七个页面全部无门槛直达。需求成立。 |
| **R1b** | 历史活跃度前提 | 「报告都归某号」**没有历史证据**：报告无 owner 字段，无法查"过去谁在用"。只能当**从今往后的初始指派声明**，不能写成"已核实的历史归属"。 |
| **R2** | 我上一条断言有没有证据 | 98 / 3 / 3 是实测。注意：**trashed 里 3 条也要指派 owner**（否则回收站恢复后出现无主报告）；`audit` 是日志流水，不指派归属（只记操作者）。**r2 补充：将来新导入的报告才是主要部分，写路径也必须指派（P0-D）**。 |
| **R3** | 数据基线是不是 must-be-0 | 新鉴权不能用真库试。`lib/blobStore.mjs:13` 的 DB 路径吃 `MEDBRIEF_DATA_DIR`；`server.mjs:206-211` 的 `REPORTS_FILE` 吃 `MEDBRIEF_REPORTS_FILE`（不存在即退出）。测试必须同时覆盖两个环境变量 + 独立端口 5196，先跑"健康样本不被拒"的 0 基线。 |
| **R4** | 语义裂缝 | **「账号」在本项目有三个互不相干的含义，混用必错**：① MedBrief 本地管理员账号 `13228372097`；② 114 平台挂号实名号**也是** `13228372097`（用户拍板同号，但体系不同）；③ 报告所有者账号 `13200000000`。**同号 ≠ 同一登录态**：114 用 `cmi-user-ticket`（`server.mjs:817`），本地用 `mb_session`，互不认证——从"建议"升级为**硬约束**，并写进 `.agents/MEMORY.md`。 |
| **R5** | 地基不一致 | `lib/reportStore.mjs:7-13` 明确 `version` **只是格式留痕，不是锁**。`writeStore`（:60-71）只白名单**顶层四字段**——顶层新增字段会被丢，但 `reports[]` 原样透传（单条报告里加 `owner` 不会丢，r1 事实订正）。旁路表仍是对的选择，理由是避免 565 KB 全量重写 + 双真相源 + 每次改派走原子写，**不是**"写进去会被丢字段"。 |
| **R6** | 过度设计 | 已有自建等价物：`node:sqlite`（`lib/blobStore.mjs:4` 已用 `DatabaseSync`）+ `node:crypto`。手机号+密码+scrypt+会话用内置/轻依赖即可；全功能框架要接自己的 ORM/路由，与原生 `http.createServer`（`server.mjs:213`）不匹配。 |
| **R7** | 需求频次 | 「授权/撤销」是管理员低频人工动作，不是每请求路径。MVP 只需 CLI + 用户表；完整 RBAC 后台 UI 属想象中的需求。 |
| **R8** | 真值来源分级 | 权限边界的**真值 = 全量路由清单**，不是页面名。`grep -n "pathname ===" server.mjs` 实测 **39** 条（不是 40）+ **10** 条正则路由（7 reports + 3 guahao `:539/:557/:690`） + 2 处 startsWith + `meddata/mount.mjs` 内 5 类入口（r2 P0-B）。前端页面名 ≠ 接口分组，漏一个入口就是洞。 |

---

## B. 正向排雷（新方案 → 现有消费方）

| # | 必查 | 证据 / 结论 |
|---|---|---|
| **F1** | 破坏性动作 | 若把 owner 写进 `data/reports.json`：98 条 + 565 KB 全量重写 + 双真相源。**改旁路表 `report_owners` 存 SQLite，不动 reports.json 一个字节**；真要动先 `cp` 到 `data/backups/`。 |
| **F2** | 连带副作用 | 鉴权钩子在 `createServer` 回调里、`OPTIONS` 之后、`pathname` 解析（:224）之后、`:229` bump 之前；`/api/health`（:243）公开。`setCors`（:163-167）从 `*` 收窄为同源回显（带 cookie 时 `*` 会被浏览器拒）。 |
| **F3** | 键一致性 | 归属键必须是稳定 `user_id`，**不能是 phone**（用户明说"后期改账号"）。按 phone 存 owner，改号当天全变无主。 |
| **F4** | 呈现层误报 | 隐藏前端 tab 只是体验；未授权 `curl` 仍须 403。403 文案"需要授权"，不能显示成"数据坏了/报告为空"。 |
| **F5** | 测试污染现场 | `tests/verify-e2e.mjs:15` 等 **9 个测试文件**硬编码 5174；上鉴权后全 401。新增 `tests/verify-auth.mjs` 用独立端口 **5196**（5193/94/95/98/99 已占）+ `MEDBRIEF_DATA_DIR` 临时目录 + `MEDBRIEF_REPORTS_FILE` 真库副本；测试认证故事见 D3（P1-1）。 |
| **F6** | 调用面 | `mcp/intake-server.mjs:23` 直连 5174 无凭证；上鉴权后全 401。给 MCP 一个 `MEDBRIEF_SERVICE_TOKEN`（仅 loopback），权限按**逐路由白名单**（D5，P1-2）；不含 `/api/admin/*`、`/api/guahao/reset`、`launch-login`。前端 `credentials:'same-origin'` 是 fetch 默认值，仅作意图声明。 |
| **F7** | 部署态/长驻进程 | 5174 长驻不热更新（`server.mjs:240-242` 注释）。改完由执行者重启 + 探活 + 对比 `head` == `git rev-parse --short HEAD` 且 `dirty:false`；不丢给用户。`data/medbrief.db` 83 MB 原件不能丢。 |
| **F8** | 治理资产对齐 | 同步清单（Gate G8）：`README` 接口段、`INTERFACE.md`（已确认存在，15055 B）、`.agents/MEMORY.md`（"本地账号 ≠ 114 账号 ≠ 报告所有者"）；`package.json` 版本 bump 由实施阶段定。 |
| **F9** | 并发写冲突 | 新表复用 `data/medbrief.db` 与同一套 `MEDBRIEF_DATA_DIR` 解析（`lib/blobStore.mjs:13`），不另开 pragma。多 Bot 工作树已有 dirty，新文件一律新建，不改他人在改的 `IntakePage.jsx`/`UploadPanel.jsx`/`reportStore.mjs`。 |

---

## C. 逐项必要性（先砍再排期）

| 候选 | 不做会怎样 | 代价 | 收益 | 更便宜等价 | 结论 |
|---|---|---|---|---|---|
| 手机号+密码（scrypt 盐值哈希）自建 | 任何人都可调用全部接口 | ~60 行 + 1 表 | R1 证实裸奔 | `node:crypto.scrypt` 已有 | **留（MVP）** |
| 无状态加密 cookie 会话（iron-session + `sessionVersion`） | 无法记住登录/授权 | ~30 行 + 1 依赖 | R4 三义账号必须隔离 | JWT 需自建加密层，撤销代价同级 | **留（MVP）**；登出≠撤销，真撤销=`sessionVersion+1` |
| 权限位：`role` + `card_export`/`guahao` 两个布尔 | 无法表达"授权后才能用 X" | ~20 行 | R8 路由清单已列全 | 无 | **留（MVP）** |
| 报告归属旁路表 + 全链路指派 + 初始指派 | 多账号互相看到全部病历 | 1 表 + 1 迁移脚本 | R1b/R2/R5 + r2 P0-D | 写进 reports.json 会全量重写 | **留（MVP）** |
| `login_attempts` 限流旁路表（phone/ip 双键） | 爆破 + 枚举 oracle + 远程锁死 | 1 表 ~40 行 | r2 P0-C | 进程内 map 重启丢、多进程不共享 | **留（MVP）** |
| 路由守卫（一处前缀匹配，默认拒绝） | 藏了 tab 但 curl 可越权 | 1 中间件 | F4 / r2 P0-B | 逐个 handler 加必漏 | **留（MVP）** |
| 静态真实路径白名单（realpathSync） | `/data/**`、`.git/**` 全可下载 | ~15 行 | r2 P0-A 三种绕过实测 | URL 前缀黑名单挡不住编码/大小写/中段 `..` | **留（MVP）** |
| 首个管理员/授权/撤销 CLI + 审计表 | 没有建号入口/误授权无法发现 | 1 个 `tools/*.mjs` + 2 表 | R7 / r1 P1-2 | 管理 UI 更贵 | **留（MVP）** |
| MCP 服务令牌（逐路由白名单） | MCP 全部工具 401 | ~15 行 | F6 / r2 P1-2 | 无 | **留（MVP）** |
| 测试认证故事 + 双向路由覆盖自检 + 开工 Gate | 门禁上线必红/漏配不自知 | `verify-auth.mjs` + `check-route-coverage.mjs` | r2 P1-1 / P0-B / §3-8 | 无 | **留（MVP）** |
| better-auth 全框架 | — | 需 SQL DB（4 表+迁移）+ 17 deps | R6 有内置等价物 | scrypt+iron-session 更轻 | **砍（本版）**；if 短信/2FA/OAuth 任一 → 延后转留 |
| oslo / lucia | — | — | 分别 archived/deprecated | — | **砍（因停更/废弃）** |
| bcrypt / argon2 原生包 | — | 需编译 | `node:crypto.scrypt` 内置（39ms 实测） | — | **砍** |
| JWT 无状态令牌 | — | — | 需自建 secret/加密层，撤销代价与 iron-session 同级，后者已封装 cookie | iron-session | **砍** |
| 开放注册 / 短信登录 / 管理后台 UI / 按 patientName 拆归属 | — | — | 用户要求管理员授权；短信"后期" | — | **砍（本版）**；短信=**延后**，触发条件：用户提供短信服务商凭证且密码登录稳定 ≥2 周 |

---

## D. 简化后的方案（只列留下的项）

### D0. 身份模型（选定：iron-session 无状态 cookie + `sessionVersion`）

- **会话机制二选一已定案**：iron-session 无状态加密 cookie + `users.sessionVersion`；**无 `sessions` 表**。
  - **撤销语义写死**：**「登出」只清客户端 cookie，不构成服务端撤销**；真正的撤销只有 `sessionVersion+1`（该用户**全部设备**同时下线，做不到单会话踢出）。触发点列全：**改密码 / 改手机号 / 停用(`disabled=1`) / 管理员手动踢下线**。
  - cookie `mb_session` 内容 = `{uid, v}`，**权限位不进 cookie**：每请求从库读 `users` 行 ⇒ 授权改后下一次请求生效、撤销即时（r2 §3-2 认这条）。
  - `SESSION_SECRET`（env 读，≥32 字符，**绝不落 `data/`**）；114 用 `cmi-user-ticket`（`server.mjs:817`），与 `mb_session` **不同体系、互不认证**（硬约束）。
- `users(id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL CHECK(length(phone)=11 AND phone GLOB '1[3-9]*'), phoneVerifiedAt TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, sessionVersion INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'user', card_export INTEGER NOT NULL DEFAULT 0, guahao INTEGER NOT NULL DEFAULT 0, created_at, updated_at, disabled INTEGER NOT NULL DEFAULT 0)`
  - `role`: `admin`|`user`；admin 天然全权限 + 用户管理 + **owner 过滤豁免**（D1 §1.5）。
  - `phone` 可改同步 `sessionVersion+1`；`id` 永不变；`phoneVerifiedAt` 预留短信（J6，恒 null）。
  - **删掉 v0.2 的"同账号最多 3 台设备"**（无状态下不可执行）：改为**观测项**——同一 uid 的 cookie `iat` 出现 >3 个不同 UA 指纹时写 `authz_log`，**明确这不是硬限制**。
- **`login_attempts` 限流旁路表（r2 P0-C，替换 users 上的 failed_count/locked_until）**：
  ```sql
  login_attempts(key TEXT PRIMARY KEY,        -- 'phone:<phone>' / 'ip:<ip>'
                 kind TEXT NOT NULL,          -- 'phone' | 'ip'
                 failed_count INTEGER NOT NULL DEFAULT 0,
                 first_failed_at TEXT, last_failed_at TEXT, locked_until TEXT)
  ```
  - 与 `users` 解耦、phone 键**不管 users 行存不存在都写**；phone/ip 双键任一 `locked_until` 命中即拒（挡单号爆破 + 换号横喷）。
  - 退避 `min(2^(n-5), 8)` 秒封顶；到上限改 **429 + `Retry-After`**，不挂连接；锁定期满 `failed_count` 归零（否则一次锁=永久锁）。
  - **响应不可分辨**："无此号 / 密码错" 一律 **401 同正文**；"已锁定"为 **429 + `Retry-After`**（状态码不同但都不泄漏号是否存在——不存在的号同样会锁），无此号也跑一次 dummy scrypt（39ms 实测）让三组时长同分布——防止枚举 oracle。
  - 成功登录只清 `phone:` 键，`ip:` 键走滑动窗口不被重置。
  - **显式前提（r3 §3-3）**：`phone:` 键对**不存在的号同样计数、同样触发锁定**；否则 `Retry-After` 的存在与否就成了"号是否存在"的 oracle。
  - **状态 → 响应四行表（r3 P1-4）**：

    | 状态 | 状态码 | 头 | 正文 | 延迟 |
    |---|---|---|---|---|
    | 正常失败（未到退避） | 401 | 无 Retry-After | 固定同正文 | scrypt 39ms |
    | 退避中（未到 8s 上限） | 401 | 无 Retry-After | 固定同正文 | `min(2^(n-5),8)`s |
    | 达上限瞬时 | 429 | `Retry-After` | 固定同正文 | 不挂连接 |
    | 锁定期（`locked_until` 命中） | **429** | `Retry-After` | 固定同正文 | 立即拒绝 |（r4 P1-3：401 挂 Retry-After 非 RFC 9110 标准；存在性 oracle 已由"无此号同样计数"排除）
  - **`role='admin'` 不硬锁（r3 P1-8）**：只对 admin 号退避 + 写 `authz_log(action='admin_login_throttle')` 告警，不设 `locked_until`（防 LAN 内任何人远程锁死管理员 15 分钟）；loopback 可加单次旁路。
  - **过期清理（r3 P1-7）**：`last_failed_at` 早于 7 天的 `login_attempts` 行在服务启动时与每日定时清理（与砍掉 sessions 表同源：不留无界增长表）。
- `report_owners(report_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, assigned_at, source TEXT NOT NULL DEFAULT 'bootstrap')`；初始把 98+3 条全量指派给**报告所有者**（两账号中的非管理员），`source='bootstrap'`；`source` 另取值 `ingest`（新导入，见 D1 §1.1）。
- **审计表（只追加、不回灌）**：`authz_log(id, actor_user_id, target_user_id, action, before, after, at)`（grant/revoke/改号/停用/`read_report_as_admin`）；`report_owner_log(id, report_id, from_user_id, to_user_id, at, reason)`。
- 迁移脚本 `tools/bootstrap-accounts.mjs`：① `--bootstrap` 交互建 **admin=`13228372097`**（stdin 设密码）→ ② `--create-user --phone=<owner>` 建报告所有者（**位数校验 11 位，10 位当场报错**）→ ③ `--apply` 指派 98+3 条。默认 `--dry-run`；每步前备份（`report_owners_bak_<ts>` + users 同等备份/事务），中间失败不留半套状态。owner **默认零授权**（`role='user'`, `card_export=0`, `guahao=0`），由 admin 事后 `grant`。

### D1. 权限矩阵（真值 = 全量路由；r2 P0-A/B/D/F 已修）

#### 1.1 路由 → 权限穷举表

| 方法 | 路径 / 匹配 | 行 | 权限 | owner 校验 / 归属写入 |
|---|---|---|---|---|
| GET | `/api/health` | :243 | **公开**（回 `auth:'on/off'`） | — |
| POST | `/api/auth/login` | 新增 | **公开**（走 `login_attempts`） | — |
| POST | `/api/auth/logout` | 新增 | 登录 | 仅清客户端 cookie |
| GET | `/api/auth/me` | 新增 | 登录 | 返回 `{uid, role, permissions}` |
| GET | `/api/recognition-hits` | :234 | admin | — |
| POST | `/api/intake/parse` | :1433 | admin（调 OCR，防打爆） | — |
| POST | `/api/intake/ocr` | :1458 | admin | — |
| POST | `/api/ai-docread` | 同族 | admin | — |
| POST | `/api/intake/stitch` | :1384 | admin | — |
| GET | `/api/intake/reports` | :988 | 登录 | **user 只返回本人 owner；admin 豁免全库**（§1.5） |
| POST | `/api/intake/reports` | :1641 | **登录用户**（自己导入） | **成功后 `INSERT report_owners(..., uid=当前主体, source='ingest')`**（P0-D + Q2） |
| GET | `/api/intake/reports/:id` | :1028 | 登录 | user 必须 owner 校验；admin 豁免 |
| DELETE | `/api/intake/reports/:id`（含 `?purge=1`） | :1068 | **登录 + owner 校验**；admin 豁免 | 仅本人报告可删；`?purge=1` 时 `DELETE report_owners`；软删不动 |
| POST | `/api/intake/reports/:id/restore` | :1128 | **登录 + owner 校验**；admin 豁免 | 仅本人报告可恢复；软删/restore **不动归属** |
| POST | `/api/intake/reports/:id/patch` | :1150 | **登录 + owner 校验**；admin 豁免 | 仅本人报告可校正；**不覆盖 owner** |
| PUT | `/api/intake/reports/:id` | :1227 | **登录 + owner 校验**；admin 豁免 | 仅本人报告可更新；**恒为更新、不覆盖 owner（无新建分支）** |
| GET/POST | `/api/intake/reports/:id/corrections` | :1306/:1289 | **登录 + owner 校验**；admin 豁免 | 仅本人报告的反馈 |
| GET | `/api/intake/blobs` | :1415 | admin（全库）/ user 按 owner + `blob_owners` 过滤（能看到自己刚传的） | 见下 blob 反查 |
| POST | `/api/intake/blob` | :1398 | **登录用户**（上传自己的原件） | **落 `blob_owners(blob_id, uid, at)`**；`GET blob/:id` 判定扩成"被我的报告引用 **或** 我上传的"（r6-add P0-1） |
| GET | `/api/intake/blob/:id` | :1424 | `card_export`（Q6 已拍板）；admin 豁免 | **EXISTS：被我的报告引用 或 我上传的（blob_owners）⇒允许**（r6-add P0-1 / r2 P1-4）；不得泄漏他人是否有同 sha |
| GET | `/api/intake/patient` | :1318 | 登录（读本人档案）；admin 读全部 | **按 uid 分桶**：`data/intake/patient/<uid>.json`，`loadPatient(uid)`；p1 迁给 owner（r6-add P0-2） |
| POST | `/api/intake/patient` | :1323 | **登录用户改自己档案**；admin 改全部 | `savePatient(uid, patch)` 只写自己那份；**隔离判据：A 改后 B 读到的抬头必须不变**（r6-add P0-2） |
| GET | `/api/intake/card` | :1368 | `card_export` | 取 `?owner=` 指定对象（§1.5 / r2 P1-6） |
| GET | `/api/brief/visit-summary` | :292 | `card_export` | 取 `?owner=` |
| POST | `/api/brief/bundle` | :871 | `card_export` | 取 `?owner=` |
| POST | `/api/brief/import` | :942 | 登录用户（导入自己的交换包） | **不落库**（`server.mjs:942-970` 仅 `parseMedDataBundle`→内存缓存+摘要）；**`lastImportedState` 改 `Map<uid,state>`** 防跨用户串号（r6-add P1-2） |
| GET | `/api/meddata/summary` | :264 | `card_export` | 取 `?owner=` |
| GET | `/api/guahao/monitor/*` | :420/:440 | `guahao` | — |
| GET | `/api/guahao/114/catalog/*` | :452/:468/:521 | `guahao` | — |
| GET | `/api/guahao/114/session` | :489 | `guahao` | — |
| GET | `/api/guahao/114/flow/*` | :531 等 | `guahao` | — |
| GET | `/api/guahao/schedule/doctors/orders/sniper-status` | :570/:585/:594/:607 | `guahao` | — |
| GET | `/api/guahao/114/auth` | :641 | `guahao` | — |
| POST | `/api/guahao/114/flow/start` | :674 | `guahao` | — |
| POST | `/api/guahao/book` | :715 | `guahao` | — |
| POST | `/api/guahao/cancel` | :732 | `guahao` | — |
| POST | `/api/guahao/reset` | :743 | admin（测试隔离） | — |
| POST | `/api/guahao/114/auth` | :757 | admin（排障） | — |
| POST | `/api/guahao/114/launch-login` | :784 | **admin + 仅 loopback**（启动真实 Chrome） | — |
| POST | `/api/guahao/114/close-login` | :857 | admin | — |
| POST | `/api/guahao/114/flow/:id/{sms,captcha,confirm,abort}` | 同族 | `guahao` | — |
| GET/POST | `/api/admin/users*` | 新增 | admin | — |
| 任意（GET/POST/PUT/DELETE） | `/api/data/*`（MedData 镜像读写 `data/meddata-mirror/`；`mount.mjs:181` PUT /state、:224 PUT、:234 DELETE） | `meddata/mount.mjs:154,181,224,234,298` | **admin** | 第二套应用；`verify-auth.mjs` 加 admin `PUT /api/data/state` 非 403 断言（r3 P0-2） |
| 任意 | 网关代理前缀 `/api/{agent-mode,log,feedback,patches,gaps,engine-status,review-status,ai-*,ocr-*}` | `meddata/mount.mjs:303`, `PROXY_PREFIXES:23-33` | **admin** | 转发 8008 |
| GET | `/tesseract/*`、`/traineddata/*` | `meddata/mount.mjs:278` | **admin** | 本地 OCR 资源 |
| GET | `/meddata`（无尾斜杠）及 `/meddata/*` | `meddata/mount.mjs:286` | **admin** | 第二套应用 |
| GET | `/guahao`、`/guahao/`（302→`/?merged=guahao`） | `server.mjs:979` | 公开（页面壳，非业务接口） | 显式写，不许默认拒绝误伤 |
| GET | `/legacy` | :1775 | admin（旧工作台=完整应用） | — |
| GET | `/next/` | :979 | admin | — |
| GET | 静态资源 `/assets/*`、SPA `index.html` | :1763-1775 | **公开**（白名单根内，见 §1.4） | — |
| 任意 | 其它一切（含 `/data/**`、`*.db`、`*.json`非assets、`/docs/*`、`.git/**`、`.agents/**`） | — | **403 默认拒绝** | — |

**自检（r2 P0-B）**：`tools/check-route-coverage.mjs` 做**双向差集**。A = 代码抽取（39 条 `pathname ===` + **10** 条正则（7 reports + 3 guahao）+ 2 处 `startsWith` + 5 类 mount 入口）；B = 本表。**A−B 与 B−A 都必须为空**，任一非空即红。禁止再用"条数 ≤ 表行数"（会漏配也绿）。

#### 1.2 页内按钮 → 权限（前端按 `/api/auth/me` 的 `permissions` 隐藏；隐藏≠安全，后端仍 403，两侧都测）

| 页 (`App.jsx`) | 按钮 | 权限 |
|---|---|---|
| 报告库 (:95) | 查看列表/详情 | 登录 + owner（admin 豁免） |
| 报告库 | 编辑/删除/回收站/恢复/彻底删除/导入 | **登录 + owner 校验**（admin 豁免；Q2 已拍板） |
| 资料卡 (:96) | 查看 | 登录（owner） |
| 资料卡 (:96) | 打印预览/存 PDF (`CardPage.jsx:230`) | `card_export`（Q6 已拍板） |
| 病历交换包 (:97) | 导入/查看自己的 | 登录（owner）；导出仍需 `card_export` |
| 出诊监控 (:98)/挂号 (:100)/114 会话 (:101) | 全部 | `guahao` |

#### 1.3 实现位置

钩子插在 `const pathname`（`server.mjs:224`）**之后、:229 bump 之前**；**默认拒绝**（未匹配规则一律 403，不许落 else 放行）。`/api/**` 过鉴权，非 `/api` 走白名单 + §1.4；`OPTIONS` 保持钩前但 `setCors` 收窄为同源回显。owner 过滤**改列表端点**（:988）连接 `report_owners`，不是只加中间件。**匹配优先级写死：精确 > 最长前缀 > 默认拒绝**（否则 `/api/guahao/reset` 会被 `/api/guahao/*` 的 guahao 权限吃掉；`blob` 与 `blob/:id`、`reports` 与 `reports/:id` 同理）。`verify-auth.mjs` 加两条反例：普通用户打 `/api/guahao/reset` 必须 403；`GET /api/intake/blob/<id>` 只按 card_export 判。

#### 1.4 静态文件：解析后真实路径白名单（r2 P0-A，替掉 URL 前缀黑名单）

`server.mjs:1763` 的 `rel` 是 `decodeURIComponent(pathname)`；`:1782-1789` 的 9c 对任意真实文件开放。**URL 前缀黑名单挡不住** `%64ata`（解码后才是 data）、`DATA`（APFS 大小写不敏感）、`web/../data`（中段 `..`）。**必须判在真实路径上**：

```js
// 位置：9a/9b 之后；**并删掉 9c**（server.mjs:1782-1789）
if (rel) {
  const resolved = path.resolve(__dirname, rel)     // ① 归属判定锚在仓库根（不是 distDir）
  let real = resolved
  try { real = fs.realpathSync(resolved) } catch {}
  const inDist = real === distDir || real.startsWith(distDir + path.sep)
  const denyExt = /\.(db|json|mjs|cjs|ts|tsx|md|log)$/i.test(real)
  const denyDir = /(^|\/)(data|docs|tests|lib|mcp|tools|\.git|\.agents|node_modules)\//.test(real)
  if (!inDist && fs.existsSync(real) && fs.statSync(real).isFile()) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' })  // 仓库里任何真实文件，一律 403
  }
  // 不存在的路径（含前端深链）→ 落 9d 返回 index.html；denyExt/denyDir 是解释器/加速判断，不是边界
}
// rel === ''（首页）不进闸 → 9d 返回 index.html
```

**r4 P0-1 三个必须同时做的点**：① containment **锚回 `__dirname`**——r3 那句"根统一 distDir"只适用于 9a 的**资产解析**，归属判定必须锚仓库根；锚 distDir 会让 `path.join(distDir, rel)` 与 distDir 比较恒真，白名单退化成黑名单。② **必须删掉 9c**（`server.mjs:1782-1789`）——它按 `__dirname` 服务仓库内任何真实文件；不删则 `web/src/**`、`web/index.html`、仓库根 `index.html`（84640 B 旧工作台）这类"不在 deny 名单里"的真实文件继续 200（r5 订正：URL `/index.html` 现由 9a 服务的是 675 B SPA 壳、不是漏洞；84640 B 旧工作台只在 `/legacy`、要 admin）。9c 原用途"docs 图片"改由显式资源搬进 `web/dist-next/` 承接。③ 判定边界是 **`!inDist && 文件真实存在` ⇒ 403**（r5 自跑发现：r4 的"仅 deny 名单 403"会让 `index.html`/`web/src/*.jsx`（扩展名不在 deny 名单）落 9d 得 200 HTML，门禁仍抓不到）；`denyExt/denyDir` 保留为解释器/加速判断，不是唯一边界。
**9d 回退边界**：`web/src/App.jsx:62,121` 不引 react-router（切页写 `?tab=`），`MedDataWorkbench.jsx:9` 用 `MemoryRouter`（不写 URL），当前无 path 深链需求 ⇒ 废掉 9d 影响可控；将来加 path 路由必须先改这道闸。
**r5 实测订正**：`/index.html`=200/**675 B**（9a 服务的 SPA 壳，**删 9c 后依然公开、不是漏洞**）；只有 `/web/index.html`=338 B、`/web/src/App.jsx`=11362 B、`/web/src/pages/IntakePage.jsx`=48968 B、`/index.html`=84640 B（仓库根旧工作台，仅 `/legacy` 要 admin）这些 9c 专用路径会在删 9c 后 403（见 G3；`/index.html`=200 且 <2 KB 是肯定断言）。

#### 1.5 admin 的 owner 例外 + `?owner=` 语义（r2 P0-F / P1-6）

- `role='admin'` 时**豁免 owner 过滤**（`/api/intake/reports`、`/api/intake/reports/:id`、`/api/intake/blob/:id`、`/api/intake/blobs` 均返回全库），`role='user'` 按 `report_owners` 只返回本人。**否则管理员建好后看不到任何报告，系统建好即不可用。**
- **写路径同理（Q2）**：user 的 POST/PUT/patch/DELETE/restore 必须校验目标报告 owner == 当前 uid（非本人 403）；admin 豁免。
- admin 读他人报告落一条 `authz_log(action='read_report_as_admin')`（无成本，能事后回答"管理员看过谁的病历"）。
- **`?owner=` 仅 admin 可用**（r6-add P1-4）：非 admin 一律取当前主体；传他人 uid ⇒ 403 或忽略并归自己（二选一写死为 **403**），进 `verify-auth.mjs`。
- `?owner=<user_id>`：出卡/摘要端点（card / visit-summary / bundle / meddata-summary）默认取当前主体，admin 可显式指定；未指定且主体无数据 ⇒ 明确 403/404 文案，**不能返回空卡**。
- **判据**（进 `verify-auth.mjs`）：admin → `GET /api/intake/reports` 返回 N>0；user(owner) → N>0；user(第三方) → 0 条**且** 对 owner 某报告 `GET /api/intake/reports/:id` 返回 403（三主体 × 两端点，同时证明过滤与例外生效）。
- `MEDBRIEF_SERVICE_TOKEN` 服务身份按 D5 逐路由白名单，绑单 `user_id`，不含 admin 端点。

#### 1.6 归属写路径（r2 P0-D）

`POST reports` 永远生成新 id（`server.mjs:1710`），**仅在 `ok:true` 之后** `INSERT report_owners(source='ingest')`（失败分支是 `{ok:false,duplicate}`，:1684-1686，不写归属）；`PUT reports/:id` 恒为更新（`server.mjs:1227` 起 `if(!rep) 404`，**无『新建分支』**），命中已有报告**不覆盖 owner**；`DELETE ?purge=1` 删 `report_owners`，软删/restore 不动；patch 不动 owner。**purge 分支（`server.mjs:1070` 起）内 `DELETE report_owners` 必须紧邻 `:1124` 的 `writeReports(store)`，两者之间不得有 `await`，任一失败则不写第二处**（`:1083` 是软删分支，不与之合并——r5 P1-4），否则中途失败破恒等式（`verify-auth.mjs` 断言：purge 后 `Δ(reports+trashed) === Δ(owners)`）。MCP 的 `intake_save_report` 走 token 绑定的 `user_id`。**对账断言**：`n(reports)+n(trashed) === n(report_owners)` 且差集为空 ⇒ 无主报告变成可红判据。

### D2. 开源选型结论（github-tool-scout S1–S6，台账已并入）

| 名称 | ★ | 最近提交 | 平台 / 版本锁 | 能干什么 | 已知限制 | 判定 | 触发条件 |
|---|---|---|---|---|---|---|---|
| vvo/iron-session | 4155 | 2026-11-12 | Node ≥22.13、ESM-only；本机 22.22.1 ✓；**9.1.0**（`npm view`）；传递依赖 `cookie@^2`+`iron-webcrypto@^2`（纯 JS 无编译） | 签名+加密无状态 cookie；README 列 `nodeCookies(req,res)` 供 Node `http` | 只管会话；无状态⇒吊销需 `sessionVersion`；cookie 4KB 上限 | **留（首选会话）** | 部署机 Node<22.13 → 改 v8（读 MIGRATION.md） |
| onury/accesscontrol | 2331 | 2026-11-15 | Node ≥20、ESM；3.1.2 | 声明式 RBAC，纯内存无 DB | 3 角色×3 资源手写表等效，可选 | **留（可选）** | 资源≥10×角色≥5 再用 |
| better-auth | 30760 | 2026-11-16 | TS-first、ESM；**1.7.25**；17 deps | 四类需求全覆盖；phone-number 插件支持手机号+密码/OTP（文档页存在，参数 `[待核]`）；`toNodeHandler` 挂 Node `(req,res)` `[仅 Express 文档，未取证]` | 必须先有 SQL DB（4 表+迁移） | **延后** | ①账号>5 或需短信/2FA/OAuth 任一；②已因别因引入 SQL；③需找回密码；④**短信登录排期时重评** |
| casbin-node-casbin | 2921 | 2026-11-15 | 5.51.1、Apache-2.0、框架无关 | 多模型策略引擎 | 3 角色用 DSL 过重 | **砍** | 资源≥10×角色≥5 或需行级策略再评 |
| lucia-auth/lucia | 10442 | 2026-08-08（README 原文「deprecated on March 2025」） | MIT、框架无关 | 曾是会话库标杆 | **已废弃**，不可引入 | **砍（因废弃）** | — |
| expressjs/session | 6359 | 2026-10-08 | Express 专用 | Express 会话中间件 | 本项目原生 `node:http`，无中间件链 | **砍（因框架冲突）** | 整体迁 Express 再评 |
| ory/kratos | 13958 | 2026-07-29 | Go 独立服务 + DB、Apache-2.0 | 工业级身份服务 | 独立常驻服务，与本地单进程冲突 | **砍（因形态）** | 多机多端共享登录再评 |
| supertokens-core | 15345 | 2026-11-06 | Java/Docker 服务；license **NOASSERTION** | Auth0 开源替代 | 需 core 服务 + 许可未核 | **砍（因形态+许可）** | 许可核清且多端需求时再评 |
| Node 内置 `crypto.scrypt` + `node:sqlite` | — | Node v22.22.1 实测 | 跨平台 | 盐值哈希（N=16384,r=8,p=1 实测 39ms）+ 存储 | 无第三方功能，需自写约 150 行 | **留（密码/存储）** | — |

**判据 J6–J9**（纳入 D5）：J6 手机号进 `phone` 唯一键 + `phoneVerifiedAt` 预留短信，不塞 email；J7 无状态 cookie 必带 `sessionVersion`；J8 权限判定只写一处（40→39 条前做前缀匹配，默认拒绝）；J9 密码用内置 scrypt，不引 native 包。

**可复跑取证**：
```bash
grep -cE "401|403|unauthorized" server.mjs                          # → 0（现状裸奔）
grep -c "pathname ===" server.mjs                                    # → 39
npm view iron-session version engines dependencies type
node -e "const c=require('node:crypto');const t=Date.now();c.scryptSync('pw','salt',64,{N:16384,r=8,p=1});console.log('scrypt ms',Date.now()-t,typeof c.timingSafeEqual)"
```

**「留」的小样验证（`/tmp/medbrief-auth-lab/`，只装 iron-session，不碰生产工程/数据；10 条断言）**：
1. 无 cookie `/admin-only` → 401；2. **三组时序对拍**：存在号错密码 / 不存在号 / 锁定期，两两时长差 <2× 且 401 正文逐字节相同（r2 P0-C）；3. `/me` 回 role；4. cookie 改 1 字节 → 401；5. `SESSION_SECRET` env 读≥32 字符、不落 `data/`、轮换数组兼容；6. cookie <4096 B；7. CORS 同源通过 / `*`+credentials 被拒；8. 原生 `node:http` 下 `nodeCookies(req,res)` 能读写 `mb_session`；9. 重启后旧 cookie 有效**且** `sessionVersion+1` 后同一 cookie 401；10. 限流退避封顶 8s、第 10 次锁 15 分钟、锁满归零。全绿才并入实现。

### D3. 回退与门禁

- **回退口径**：`DROP TABLE report_owners` ≠ 回滚（重跑 bootstrap 回到初始态、不保留人工改派）；真回滚靠 `report_owners_bak_<ts>` + `report_owner_log`，误授权靠 `authz_log`；`reports.json`/`medbrief.db` 一个字节未动。
- **`MEDBRIEF_AUTH=off`**：① `console.error` 醒目告警 + `/api/health` 回 `auth:'off'`；② 仅 `127.0.0.1`（`req.socket.remoteAddress`）允许旁路；③ 默认 `on`；门禁 `grep '"auth":"on"'`。
- **测试认证故事（r2 P1-1，9 个测试文件 + MCP）**：定 `MEDBRIEF_TEST_USER=<phone>`（仅 loopback + `NODE_ENV!=='production'`，注入固定主体）或 `tests/auth-helpers.mjs` 登录引导 + 临时库种子用户；**门禁必须同时跑"auth=on 且无凭证 ⇒ 401"**，否则自证为空。`MEDBRIEF_AUTH=off` 不得作为唯一测试手段。
- **验收命令（完整 URL、端口 5196；旧端口已全文清除）**：
  ```bash
  curl -s http://127.0.0.1:5196/api/health | grep '"auth":"on"'
  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5196/api/intake/reports              # 401
  curl -s -b /tmp/mb-normal.cookie http://127.0.0.1:5196/api/intake/card                     # 403
  curl -s -b /tmp/mb-auth.cookie   http://127.0.0.1:5196/api/intake/card                     # 200
  curl -s -X POST -b /tmp/mb-normal.cookie http://127.0.0.1:5196/api/guahao/book             # 403
  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5196/                              # 必 200（肯定断言）
  u=$(curl -s http://127.0.0.1:5196/ | grep -o '/assets/[^"]*\.js' | head -1); [ -n "$u" ] || { echo 'FAIL: 取不到资产 URL'; exit 1; }
  curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:5196$u"  # 必 200
  for u in /data/reports.json /%64ata/reports.json /DATA/reports.json \
           /web/%2e%2e/data/reports.json /.git/config; do
    curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:5196$u"; done                # 全 403
  for u in /web/index.html /web/src/App.jsx; do
    curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:5196$u"; done                # 必 403（r5 P0-1 金丝雀）
  c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5196/index.html)
  sz=$(curl -s http://127.0.0.1:5196/index.html | wc -c)
  { [ "$c" = 200 ] && [ "$sz" -ge 100 ] && [ "$sz" -lt 2000 ]; } || { echo "FAIL: /index.html 状态=$c 大小=$sz（空响应/旧工作台/9c 洞复发）"; exit 1; }  # 必 200 且 100≤sz<2000（r6 P1-1）
  c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -b /tmp/mb-admin.cookie http://127.0.0.1:5196/api/data/state -H 'content-type: application/json' -d '{}')
  case "$c" in 401|403) echo "FAIL: admin PUT /api/data/state 被守卫拦($c)"; exit 1;; esac  # 显式排除 401/403（r6 P1-2）
  node tools/check-route-coverage.mjs       # 双向差集为空
  node tests/verify-auth.mjs                # 独立端口 5196 / 临时库
  node tests/verify-e2e.mjs                 # 9 个测试文件的认证故事生效后
  npm run check:blob                        # 83 MB 原件不丢
  curl -s http://127.0.0.1:5174/api/health | grep '"ok":true'   # 上线后探活，head==git HEAD 且 dirty:false
  ```
- **编码第 0 步（r4 P1-6）**：先写 `tools/check-route-coverage.mjs` + `verify-auth.mjs` 骨架并跑成**红**（双向差集非空 / 断言失败），再写业务代码——否则"码写完才发现漏配"会把返工摊进实现阶段。G2/G3 的脚本和断言不留在计划里靠人肉 curl。
- **重启纪律**：执行者自己重启 5174 + 自验 head/dirty；不丢给用户。

### D4. 用户拍板结果（**0 条 `[TBD]`**：全部已答；G6 转绿）

1. **`[已拍板 Q1]` 管理员 = `13228372097`（用户本人）；报告所有者 = 另一个号**（不计入 `[TBD]`）。建号顺序见 D0；114 同号但不同体系（硬约束）。
2. **`[已拍板 Q2]` 普通用户可增删改查自己 owner 的报告，不能碰别人的。** 写路径（POST/PUT/patch/DELETE/restore）全部加 owner 校验；越权改他人报告返回 403。
3. **`[已拍板 Q3]` 「资料录入」「病历交换包」普通用户也可用**（管理自己报告的一部分）；**导出/打印资料卡仍需 `card_export` 授权**。
4. **管理员密码下发**（工程选择，可自决）：CLI stdin。
5. **`[已拍板 Q5]` 维持"改登录名不改归属"**（用户本次未提转报告，`reassign` 继续延后；若以后要转，单独做管理命令）。
6. **`[已拍板 Q6]` 原件查看/下载归 `card_export`**（无授权不能导出/打印资料卡，原件是前置）；未授权用户只能看结构化指标。
7. **`[已确认] 报告所有者号 = `13200000000`（11 位）`**（用户原话「当然是11位」；不计入 `[TBD]`）。`users.phone` 的 `CHECK(length=11)` 机器护栏保留。

### D5. 运行期硬约束

- 默认拒绝：未匹配任何权限规则一律 403；权限规则覆盖 A 集合（39 字面量 + **10** 正则（7 reports + 3 guahao：`:539/:557/:690`）+ 2 startsWith + 5 mount），双向差集为空。
- 静态白名单根唯一 `web/dist-next`，`realpathSync` 判真实路径，403 `return` 不落穿。
- **MCP 服务令牌逐路由白名单（r2 P1-2）**：`MEDBRIEF_SERVICE_TOKEN` 仅 loopback、env 读、不进 `data/`、绑单 `user_id`；允许 `stitch/ocr/parse`、`reports` GET/POST、`reports/:id/patch`、`patient` GET/POST、`card` GET、`blobs` GET；**不含** `/api/admin/*`、`/api/guahao/reset`、`launch-login`。附 `mcp/smoke-test.mjs` 回归。
- 审计表只追加不回灌；`SESSION_SECRET` 不落 `data/`；权限位不进 cookie。
- 不启用 HTTPS 前 `Secure` 标志关（当前 `http://127.0.0.1:5174`）。

---

## §8.7 开工 Gate 自检（编码前逐条打勾，任一 ✗ 不许动手）

> **口径**：✅ = 已闭合；⬜ = 未证（**不得计入通过**）；⚠️ = 正常阻塞（非 P0）。

| Gate | 判据（可复跑） | 复跑版本 | 当前 |
|---|---|---|---|
| G1 | 会话口径统一（**排除引用块与判据行自身**；**`-n` 不可省略**——`grep -vE '^[0-9]+:\| G1 '` 依赖行号前缀，去掉 `-n` 会退化成恒绿）：`grep -n "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md \| grep -vE '^[0-9]+:>' \| grep -vE '^[0-9]+:\| G1 ' \| wc -l` = 0 | v0.7 | ✅（复跑 = 0） |
| G2 | `node tools/check-route-coverage.mjs` 双向差集为空。**A 集合不写死常量**：脚本从代码抽 39 字面量 + **10** 正则（7 reports + 3 guahao：`:539/:557/:690`）+ 2 startsWith + 5 mount 入口；归一化规则：正则 `/^\/api\/x\/([^/]+)$/` ⇒ 表路径 `/api/x/:id`，`(sms\|captcha\|confirm\|abort)` 展开为同族一行 + 白名单豁免；脚本自输出 A/B/双向差集 | v0.7 | ⬜ 待实现 |
| G3 | 静态闸：containment 锚 `__dirname` + **删 9c** + `if (rel)` 守卫 + 仅 9a/9b 后执行；**7 条 403** = 基线 1（`/data/reports.json`）+ 绕过 4 + 金丝雀 2（`/web/index.html`、`/web/src/App.jsx`）**且** 200 肯定断言：`GET /`、`/assets/*.js`（非空守卫）、`/index.html` 存在且 <2 KB（钉住 SPA 壳非旧工作台） | v0.7 | ⬜ 待实现 |
| G4 | `login_attempts` 三组时序对拍进 D0/小样 + 四行状态表 + admin 不硬锁 | v0.7 | ✅ |
| G5 | `report_owners` 全链路 + `reports+trashed==owners` 对账 + purge 同事务 | v0.7 | ✅（§1.6） |
| G6 | **用户答完 Q2/Q3/Q5/Q6**（位数已确认 11 位）；机械判：`sed -n '/^### D4\./,/^### D5\./p' .agents/account-system-1116-plan.md \| grep -cE '^[0-9]+\. \*\*`\[TBD' = **0**（用户已全部拍板，条目均改 `[已拍板]`） | v0.7 | ✅ 四问已答 |
| G7 | 9 测试文件 + MCP 认证故事写死，门禁含"auth=on 无凭证 401"；`MEDBRIEF_TEST_USER` 的 loopback + `NODE_ENV!=='production'` 两条件写成断言（不只注释） | v0.7 | ✅（D3） |
| G8 | 同步清单可 grep：README 含 `/api/auth/`；INTERFACE.md 含 `mb_session`；`.agents/MEMORY.md` 含"本地账号≠114 账号≠报告所有者" | v0.7 | ⬜ 待实施 |

> **r6 已终判「可以开工」（P0=0，审的是 v0.7）；r6-addendum 对 v0.8 语义变更的新 P0 已在本版修完。** G6 已转绿（四问已答）；进入编码 = 用户确认 + G1–G8 除 G6 外全绿。5199 判据同 G1 排除口径（`grep -vE '^[0-9]+:>'` + 带 `-n`，实跑 = 0）。
