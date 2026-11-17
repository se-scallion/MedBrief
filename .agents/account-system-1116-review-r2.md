# 账号系统 + 权限设计 · 独立审核 **r2**（plan-review §8.3）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/account-system-1116-plan.md` **v0.2**（292 行）。
> 输入：`.agents/account-system-1116-review-input-r2.md`（双份：8 条必攻击点 + 5 条 P0 关闭台账）与 `.agents/account-system-1116-review-input-r2-addendum.md`（用户拍板 Q1，审核进行中到达，按 §8.2 并入本轮）。
> 上轮判词：`.agents/account-system-1116-review-r1.md`（总判「不能直接进下一轮」，4 条 P0 + 附录 A 的 P0-5）。
> 未改计划/代码、未提交、未动 `data/reports.json`、未调用 5174 任何写接口；只发 **GET** 探针（§7 全部可复跑）。**只写了本文件**。

---

## 0. 总判：**不能直接进下一轮** —— 6 条 P0

v0.2 的修订**规模是实的**：D0 整段重写成方案 A、D1 改穷举表、钩子前移到 `:224`、审计两张表、端口改 5196——这些我都逐条核到了落点，不是只有口头 ✅。但 P0 台账里 **4 条申报关闭的，只有 2 条真闭合**：

| # | 上轮 P0 | 我的复核 | 判定 |
|---|---|---|---|
| P0-1 | `/data/**` 公开 | 文档写了黑名单，但**"URL 前缀黑名单"这个写法本身挡不住**：实测三种绕过全部 200 | ❌ 未闭合 → 本轮 **P0-A** |
| P0-2 | 矩阵漏 14 条 | 14 条已补全 ✓，但**仍漏 5 类入口**，且自检断言用了错基数（39 写成 40） | ⚠️ 部分闭合 → 本轮 **P0-B** |
| P0-3 | 钩子位置 | ✅ 真闭合：`:224` 之后、`:229` 之前，默认拒绝 + 非 `/api` 白名单 | ✅ |
| P0-4 | 爆破 + 旁路 | 旁路 ✓ 三条约束到位；**限流只写了策略、没写"认证前失败记在哪"** | ⚠️ 半闭合 → 本轮 **P0-C** |
| P0-5 | D0/D2 会话矛盾 | D0 重写 ✓，但 **C 表 `:87`/`:97` 仍写"服务端会话 + SQLite token"**，且把"服务端 session 可即时撤销"当作砍 JWT 的理由留着 | ❌ 未闭合 → 本轮 **P0-D** |

**本轮 6 条 P0**（前 4 条是上轮申报关闭但没关干净的，后 2 条是本轮新增）：

| # | P0 | 一句话 | 证据 |
|---|---|---|---|
| **P0-A** | 静态黑名单**不可执行** | 黑名单建在 URL 前缀上，`%64ata` / `DATA` / `web/../data` 三种写法全部绕过；`.git/`、`.agents/` 这类**点开头目录**也没被"隐藏文件"那一条覆盖 | §1-A，实测 9 条 GET |
| **P0-B** | D1 仍漏 **5 类入口** + 自检断言无效 | `/api/data/*`、`/api/{ai-,ocr-,log,feedback,…}` 网关代理、`/tesseract/*`、`/traineddata/*`、`/guahao` 壳全未列；默认拒绝下这些一律 403 ⇒ **MedData 页与挂号页壳被打挂** | §1-B，`meddata/mount.mjs:154,278,286,303` |
| **P0-C** | 限流**语义缺失**（你点名必答） | `failed_count/locked_until` 挂在 `users` 行上，而登录失败发生在**认证前、无 users 行**；计划通篇没写按 phone 查/不存在用进程内 map ⇒ 不存在号无计数、无退避 ⇒ 既是**枚举 oracle**（时序 + 是否锁定可分辨），又是**远程锁死真人**的 DoS 面 | §1-C，`plan:114,118` |
| **P0-D** | 入库/删除/恢复**不写 `report_owners`** | bootstrap 只覆盖已有 98+3 条；`POST /api/intake/reports`(:1641)、PUT(:1227)、purge(:1068) 全篇无一字说归属 ⇒ 上线后**每次导入都是无主报告**，owner 自己看不到 | §1-D，`plan:121,147,202` |
| **P0-E** | 会话机制残留（P0-5 未清） | C 表 `:87` 仍"服务端会话（HttpOnly cookie + **SQLite token**）… **留（MVP）**"；`:97` 仍"服务端 session 可即时撤销"；`:110` 还有错字"人权机制" | §1-E |
| **P0-F** | **admin ≠ owner 后管理员看不到任何报告**（addendum） | D1 `:146`/`:159` 写"只返回本人 owner 的报告"，无 admin 例外；用户已拍板管理员是 `13228372097`、报告归另一个号 | §4-2 |

**一句话**：方向、结构、台账都对了，但**三条"关掉等于没关"的 P0（A/B/E）是同一类病**——把"要不要做"写清楚了，"做到什么程度才算做对"没写，于是按文档实现出来仍然是洞。

---

## 1. P0 逐条展开（每条给到可执行改法）

### P0-A 静态黑名单：写法不可执行，三种绕过实测全通

计划 `:131`（`必改（静态路径）`）与 `:183`（表末行）、`:290`（D5）写的是**URL 前缀黑名单**：`/data/`、`*.db`、`*.json`、`/docs/`、点开头的隐藏文件一律 403。

**我对现网 5174 发 9 条只读 GET（未写任何东西）**：

| 探针 | 结果 | 说明 |
|---|---|---|
| `/data/reports.json` | **200 / 565794 B** | 基线（r1 已报） |
| `/%64ata/reports.json` | **200 / 565794 B** | **百分号编码绕过**：`:1763` 的 `rel` 是 `decodeURIComponent(pathname)`，黑名单若看 `pathname` 就判不到 |
| `/DATA/reports.json` | **200 / 565794 B** | **大小写绕过**：APFS 默认大小写不敏感，`fs.existsSync` 认 `DATA` |
| `/web/%2e%2e/data/reports.json` | **200 / 565794 B** | **中段 `..` 绕过**：`rel` 不以 `..` 开头（以 `web/` 开头），`path.join` 规范化后落回 `data/` |
| `/.git/config` | **200 / 137 B** | 点开头**目录**未覆盖（"隐藏文件"≠"隐藏目录"） |
| `/.agents/MEMORY.md` | **200 / 17657 B** | 同上，且该文件含账号与病人姓名 |
| `/server.mjs` | **200 / 89493 B** | 源码可下（不致命，但说明 9c 对任意真实文件开放） |
| `/lib/blobStore.mjs` | **200 / 3770 B** | 同上 |
| `/data/medbrief.db` | **200 / 83554304 B** | 83 MB 原件库 |

（对照：`/.env` 返回 200/675 B，但 `ls .env` → `No such file or directory`，那是 **9d SPA 回退**吐的 `index.html`，不是泄漏。这条恰好说明**下一个坑**：)

**坑 2：403 必须 `return`，不许落穿**。`:1790` 的 9d 对任何未被前序分支处理、文件不存在的 GET 都回 `index.html` 并 **200**。黑名单若写成"不匹配就往下走"，被拒路径会变成 `200 text/html`，门禁拿状态码判断就永远绿。

**改法（写进 D1 `:131` 段，替掉"URL 前缀黑名单"）**——判在**解析后的真实路径**上，而不是 URL 上：

```js
// 9c 之前；rel 已 decodeURIComponent（:1763）
const allowRoot = path.join(__dirname, 'web', 'dist-next')   // 唯一允许的静态根
const resolved = path.resolve(__dirname, rel)
let real = resolved
try { real = fs.realpathSync(resolved) } catch {}            // 解掉 DATA→data、xxx/../yyy
if (!(real === allowRoot || real.startsWith(allowRoot + path.sep))) {
  return sendJson(res, 403, { ok: false, error: 'forbidden' })  // return，不是 fall through
}
```
- 用 `realpathSync` 一次解决**大小写**（`DATA`→`data`）与**中段 `..`**；用解码后的 `rel` 解决 `%64ata`；
- 更省事的等价方案：**直接删掉 9c**（它的用途只是"`docs` 里的图片"，`:1782` 注释原话），把需要的静态资源挪进 `web/dist-next/`，白名单只剩 `assets/**` + `index.html`。二选一，但**必须写死**，不能留"加个黑名单"这种实现方各自发挥的表述。
- 门禁断言改成**单值 403**（不是 `403/404`——404 会让人以为"文件不存在所以安全"），并**追加 4 条绕过回归**：`%64ata`、`DATA`、`web/../data`、`.git/config` 都必须 403。

### P0-B D1 穷举表：14 条已补齐，但仍漏 5 类入口；自检断言用错基数

**先说对的**：我用 `grep -n "pathname ===\|pathname.startsWith\|req.url.startsWith" server.mjs` 实测，再逐条对 `:135-183` 的表，**表里 40 行覆盖的点位一条不缺**，`reports/:id` 的 6 个动态方法（`:1028/:1068/:1128/:1150/:1227/:1289/:1306`）确实已在 `:148-153`。**P0-2 的主体是闭合的。**

**但漏的是"不在 `pathname ===` 里的入口"**——它们在 `meddata/mount.mjs` 内部派发（`:1754` 的 `mountMedData` 早于 9c，晚于钩子）：

| 未列入表的入口 | 位置 | 现状后果（默认拒绝） |
|---|---|---|
| `/api/data/*`（MedData 镜像读写 `data/meddata-mirror/`） | `meddata/mount.mjs:154-155`（调用点 `:298`） | **403** ⇒ MedData 页的存取全挂 |
| `/api/{agent-mode,log,feedback,patches,gaps,engine-status,review-status,ai-*,ocr-*}`（转发 8008 网关） | `meddata/mount.mjs:303` + `PROXY_PREFIXES`(`:23-33`) | **403** ⇒ MedData 的识别/反馈/引擎状态全挂 |
| `/tesseract/*`、`/traineddata/*`（源码里硬编码的绝对路径） | `meddata/mount.mjs:278` | **403** ⇒ 本地 OCR 资源加载失败 |
| `/guahao`、`/guahao/`（302 → `/?merged=guahao`） | `server.mjs:979`（表里只写了 `/next/`） | **403** ⇒ 旧书签/旧链接失效（页壳不是业务接口） |
| `/meddata`（无尾斜杠） | `meddata/mount.mjs:286` | 表里写 `/meddata/*`，`/meddata` 本身未覆盖 |

**坑 2：自检断言不可用**。`:185` 与 `:289` 写 `grep -c "pathname ===" server.mjs`「**实测 40**」——**实测是 39**：

```
grep -c "pathname ===" server.mjs                      → 39   （计划写 40，错）
grep -c "pathname ===\|pathname.startsWith" server.mjs → 40   （这个 40 把 2 处 startsWith 的"行"也算进来了）
grep -cE "\^\\/api\\/intake\\/reports" server.mjs       → 7    （7 条正则路由，压根不在 39/40 里）
```
两个口径被混用；而且 `:229` 那行是**观测用的三目**（`kind = parse ? … : docread ? … : ocr`），**根本不是路由**，却贡献了计数。所以"条数 ≤ 表行数"这条断言：① 基数错；② 表里有 10 行不是路由（health/auth/静态/黑名单），**漏 5 条真实路由照样绿**。这正是它当初要防的那类漏项，却防不住。

**改法**：写 `tools/check-route-coverage.mjs`，**双向**比对——A = 代码里抽出的 `(method, 字面量)`（39 行里的字符串）+ 7 条正则 + `:1424`/`:1775` 两处 `startsWith`；B = D1 表；`A − B` 与 `B − A` **两个方向都必须为空**，任一非空即红。并把表里 5 类 mount 入口补齐（权限建议：全部 `admin`，因为它们都属于 `/meddata` 第二套应用；`/guahao` 走 302，公开或 admin 均可，但必须显式写）。

### P0-C 登录限流的语义（你点名的必答题）：计划没写，且现写法在实现层**做不到**

计划 `:114` 把 `failed_count` / `locked_until` 放进了 `users` 行；`:118` 写"第 5 次失败起指数退避 1s→2s→4s；连续 10 次 `locked_until = now+15min`"。**全篇没有一句说失败次数记在哪、按什么键记、phone 不存在怎么办。** 而登录失败恰恰发生在**认证之前**：

1. **未注册手机号根本没有 `users` 行** ⇒ 无处累加失败数 ⇒ 无退避、无锁定。攻击者可以**无限次**试任意号码；
2. 更要紧的是**枚举 oracle**：存在的号第 5 次起变慢/被锁，不存在的号永远快 ⇒ 两者可分辨。11 位手机号空间本来就小，加上 `:118` 自己承认服务绑 `0.0.0.0`（`server.mjs:1808`），这条比慢速爆破更现实；
3. 反过来，**按 phone 锁 = 远程锁死真人**：任何 LAN 内的人对 `13228372097` 连发 10 次错密码，管理员 15 分钟进不去（addedum 之后管理员号还是公开可猜的那个 114 号）；
4. `failed_count` 写 `users` 行还有个副作用：它会改 `updated_at`，与"改手机号/改密码才 `sessionVersion+1`"的审计口径混在一起；
5. 退避无上限、无并发保护：`1s→2s→4s` 之后呢？每个失败请求被挂 4 秒，攻击者开几百个连接就是一次**连接池耗尽**。

**改法（写进 D0 `:118`，替换现有那 3 行）**：

```sql
login_attempts(key TEXT PRIMARY KEY,       -- 'phone:13228372097' / 'ip:192.168.9.20'
               kind TEXT NOT NULL,          -- 'phone' | 'ip'
               failed_count INTEGER NOT NULL DEFAULT 0,
               first_failed_at TEXT, last_failed_at TEXT, locked_until TEXT)
```
- **与 `users` 解耦**（放同一个 `medbrief.db`，F9 不动）；phone 键**不管 users 行存不存在都写**；
- **双键**：`phone:` 与 `ip:` 各一行，任一命中 `locked_until` 即拒 ⇒ 既挡单号爆破，也挡"换着号横向喷洒"；
- **退避有上限**：`min(2^(n-5), 8)` 秒；超过上限改回 **429 + `Retry-After`**，不再挂连接；
- **锁定期满 `failed_count` 归零**（写死，否则一次锁定 = 永久锁死）；
- **响应不可分辨**：无此号 / 密码错 / 已锁定 **一律 401 同正文**（锁定时多一个 `Retry-After` 头），且**无此号时也跑一次固定 dummy scrypt**（`:209` 已实测 39ms），让三组时长同分布；
- 成功登录只清 `phone:` 键，`ip:` 键走滑动窗口，不被"我登录成功"重置；
- **小样第 2 条扩成三组对拍**：存在号错密码 / 不存在号 / 锁定期，两两时长差 `< 2×` 且正文逐字节相同（现在 `:241` 只对比"错密码 vs 对密码"）。

### P0-D 归属只在 bootstrap 写，**写路径全空**

`:121` 定义了 `report_owners`，`:125` 只写了 bootstrap 一次性指派 98+3 条（`source='bootstrap'`），`:202` 只说列表端点要按 owner 过滤。**`POST /api/intake/reports`(:1641) / PUT(:1227) / DELETE(:1068) / restore(:1128) 四处的归属语义一个字没有。**

后果是确定的，不是理论风险：上线后每一次导入（含 MCP `intake_save_report`）产生的新报告 `report_owners` 里没有行 ⇒ 列表端点按 owner 过滤 ⇒ **owner 用户看不到自己刚导的报告**，而 admin 若不做例外（P0-F）也看不到。R2 (`:56`) 特意写了"trashed 里 3 条也要指派，否则恢复后出现无主报告"——**恰恰漏了"将来产生的报告"才是主要部分**。

**改法（写进 D1 `:147`、`:149`、`:150`、`:152` 的 owner 校验列 + D0 `:121`）**：
- `POST /api/intake/reports` 成功返回前 `INSERT INTO report_owners(report_id,user_id,assigned_at,source) VALUES(?,?,'…','ingest')`，`user_id` = 认证主体（MCP 走 token 绑定的 `user_id`，见 D5 `:291`）；
- `PUT /api/intake/reports/:id`「更新原报告」四个分支（`:1227` 起）里，**命中已有报告时 owner 不覆盖**，新建分支按上一条；
- `DELETE ?purge=1`(:1068) 成功时 `DELETE FROM report_owners WHERE report_id=?`；**软删 / restore 不动**（回收站恢复后归属必须原样回来）；
- **对账断言**（进 `verify-auth.mjs`）：`n(reports) + n(trashed) === n(report_owners)`，且两者差集为空 ⇒ 无主报告变成可红判据，而不是上线后靠人肉发现。

### P0-E D0 已重写，C 表还是旧机制（P0-5 的原文病灶没清）

`:110` 明确"删掉初版的 `sessions` 表——它与人权机制互斥"（**错字：人权机制 → 会话机制**）。但**同一份文档的 C 表**：

- `:87`：`服务端会话（HttpOnly cookie + SQLite token）` …… **留（MVP）**；
- `:97`：`JWT 无状态令牌 | … | 服务端 session 可即时撤销 | **砍（因撤销语义冲突）**`。

这两行的字面意思与 D0 直接冲突：C 表说会话是"SQLite token 服务端可即时撤销"，D0 说是"sealed cookie、登出≠撤销、只能整用户下线"。实现方按 C 表（选型结论表通常是被优先读的那张）就会把 r1 的 P0-5 原样做回来。

更要注意的是 `:97`：**"服务端 session 可即时撤销"这个削减 JWT 的理由，在方案 A 下已经不成立了**——无状态 sealed cookie 的撤销语义与 JWT 同类。这句话必须改，否则文档自己在替 JWT 平反。

**改法**：`:87` 改成"无状态加密 cookie 会话（iron-session，无 `sessions` 表）"；`:97` 的理由改成"JWT 需自建 secret/加密层且无法整用户作废；iron-session 已封装 cookie，撤销代价与 JWT 同级（本方案接受）"；`:110` 改错字。

### P0-F（addendum 引入）admin ≠ owner ⇒ 管理员建好后**看不到任何报告**

用户原话：「管理员账号是我13228372097。这些报告归属另外一个1320000000。」

D1 `:146` 写的是 `GET /api/intake/reports | 登录 | **只返回本人 owner 的报告**`，`:159` 的 `/api/intake/card` 同口径，`:154` 的 `/api/intake/blobs` 写成"**admin** 或按 owner 过滤"（"或"在默认拒绝的守卫里等于没定）。**管理员不是报告所有者 ⇒ 照字面实现，admin 登录后报告库是空的**，既验证不了授权结果，也导不了卡。这不是体验问题，是"系统建好即不可用"。

**改法**：D1 增一节"admin 的 owner 例外"，三处都写死：
- `role='admin'` 时**豁免 owner 过滤**（返回全库），`role='user'` 时按 `report_owners` 只返回本人；
- `/api/intake/blob/:id` 的 admin 同样豁免（否则 admin 校验报告时看不了原件）；
- 建议给"admin 读他人报告"也落一条 `authz_log`（`action='read_report_as_admin'`），这是唯一能事后回答"管理员看过谁的病历"的地方——可选，但**没成本**。

---

## 2. 逐条闭环核对表

### 2.1 上轮 5 条 P0

| 上轮 | 本版落点 | 判 |
|---|---|---|
| P0-1 `/data/**` 公开 | `:131` + `:183` + `:290` + D3 两条 curl | ❌ 写了但不可执行（P0-A：3 种绕过） |
| P0-2 漏 14 条路由 | `:148-185` 穷举表 | ⚠️ 14 条已补 ✓，仍漏 5 类 mount 入口 + 自检断言无效（P0-B） |
| P0-3 钩子绕过 | `:199`（`server.mjs:224` 后 `:229` 前） | ✅ 与实测一致（`:224` pathname / `:227-231` OBSERVED+bump / `:234` hits / `:243` health） |
| P0-4 爆破 + 旁路 | D0 `:118`（限流）/ D3 `:255`（off 三约束） | ⚠️ 旁路 ✅；限流语义缺失（P0-C） |
| P0-5 D0/D2 矛盾 | `:110-112` 整段重写为 A | ⚠️ D0 ✅，C 表 `:87`/`:97` 残留（P0-E） |

### 2.2 上轮 8 条 P1

| # | 落点 | 判 |
|---|---|---|
| P1-1 页内按钮表 | `:187-195`（报告库/资料卡/交换包/出诊/挂号/114 六行） | ✅ |
| P1-2 两张审计表 + 回退改写 | `:122-124`（`authz_log`/`report_owner_log`）+ `:254`（"DROP≠回滚"写死） | ✅ |
| P1-3 credentials/setCors/launch-login | `:200`（收窄同源）`:201`（默认值声明）`:175`（admin+loopback） | ✅ |
| P1-4 端口 5199→5196 | D3 `:257` 已改 | ⚠️ **F5 `:74` 仍写"独立端口（如 5199）"**，同一份文档两个端口 |
| P1-5 版本锁 + 台账优先 | `:211`（`npm view` 版本、依赖 2 个、"冲突时以台账为准"） | ✅ |
| P1-6 D4 第 6 条 | `:283`（Q6 原件下载） | ✅（但 `:274` 章节标题仍写"3 条标 `[待用户拍板]`"，实际 **5 条**：`:278,279,280,282,283`） |
| P1-7 `INTERFACE.md` | `:20` 申报"已复核存在（15055 B）" | ✅ 实测 `ls -l INTERFACE.md` → 15055 B |
| P1-8 3 台设备约定 | `:119` | ⚠️ 写成"管理约定"，**无状态下确实无法计数**——但因此这句在系统里不存在，建议直接删或改成"检测同一 uid 的 `iat` 跨越 >3 个不同 `ua` 指纹时记审计"（后者只是观测，别写成限制） |
| 事实订正：29 字段 | `:39` | ✅ 实测并集 29 |
| 事实订正：R5 理由 | `:59` + `:126`（三条理由：565 KB 全量重写/双真相/原子写） | ✅ 与 `lib/reportStore.mjs:60-71` 一致 |

### 2.3 上轮 8 条必攻击点的归档

| 上轮攻击点 | 本版 | 判 |
|---|---|---|
| 1 R4 三义账号隔离 | `:278`（Q1）；addendum 让 admin 号**与 114 同号** | ⚠️ 见 §4-1，隔离从"建议"升级为必须，且要写成一句硬约束 |
| 2 F3 归属键 / writeStore | `:59`/`:126` | ✅ |
| 3 F6 MCP 断链 | D5 `:291`（token 绑 `user_id`、仅 loopback、不含 admin/reset/launch-login） | ⚠️ 角色清单**漏 patient 与 patch**，见 §5-P1-2 |
| 4 F7 重启/head+dirty | `:272`（补 `dirty:false`、保留 `dirtyCount`） | ✅ |
| 5 D1 完整性 | 见 P0-B | ⚠️ |
| 6 D4 谁有权决定 | `:276`（Q1/Q2/Q3/Q5/Q6 必须用户输入） | ✅ 但标题计数错（见上表 P1-6） |
| 7 选型取证厚度 | `:211`/`:213-223`（版本锁、同类 3 个、依赖如实） | ✅ |
| 8 回退与门禁 | `:254`（回退）/`:257-271`（无 `...`、完整 URL） | ⚠️ 门禁里 `node tests/verify-e2e.mjs` **当前跑不过是必然的**，见 §5-P1-1 |

---

## 3. 本轮 8 条必攻击点逐条回答

### 3-1 P0 关闭台账对账：**2 条真闭合（P0-2 主体 / P0-3），3 条没关干净（P0-1 / P0-4 / P0-5）**

- **P0-1 的"可执行程度"——不够，见 §1-A**。具体到你问的那一条：D1 `:131` 的协议是"在 9c（`:1782`）之前插显式黑名单 + 具体拒绝路径清单 + 403 响应"。**清单有、403 有、位置有，但判定对象错了**（URL 前缀 vs 解析后真实路径），所以三种绕过测试全 200。改成 `realpath` 白名单根即可执行（代码在 §1-A）。
- **P0-5 见 §1-E**：D0 真重写了（`:110-112`），但 C 表两行没跟着改——这正是你说的"口头 ✅、文档里没落"的一个实例，而且落在**选型结论表**上，比正文更容易被实现方照抄。

### 3-2 D0 方案 A 自洽性：**D0 内部自洽，跨节不自洽**

- 删 `sessions` 表的残留：**D0 内零残留**（`grep -n "sessions" plan` 只命中 `:6`/`:13`/`:110` 三处修订说明），但 **C 表 `:87` 还有 `SQLite token`**（P0-E）。
- `sessionVersion` 与 `users` 字段对齐 ✓（`:114` 有 `sessionVersion INTEGER NOT NULL DEFAULT 0`，`:112` 四个触发点列全：改密码/改手机号/停用/踢下线）。
- **"授权改后下次请求生效"在 cookie 只放 `{uid,v}` 的设计下真成立** ✓：`:116` 明写"每次请求从库里读 users 行（cookie 里只放 id + version，不放权限位）"。这条我认，是实现选择正确的一处。
- 但补一句成本提醒：`:116` 的设计意味着**每个请求一次 `users` 查询**（另有 `report_owners` 一次、`sessionVersion` 比对一次）。`node:sqlite` 同步 API 在单进程下没问题，但 `verify-auth.mjs` 应该加一条 500 次鉴权路径的吞吐基线，避免将来有人为了"快"把权限位塞回 cookie（那时撤销就不即时了）——这是把 D0 的**正确设计变成可回归的判据**。

### 3-3 D1 穷举表是否还漏：**漏 5 类（P0-B）**，其余我逐条核对通过

`grep -n "pathname ===\|pathname.startsWith\|req.url.startsWith" server.mjs` 结果我按行核完：`:229`(三目观测行，非路由)、`:234`、`:243`、`:264`、`:292`、`:420`、`:440`、`:452`、`:468`、`:489`、`:521`、`:531`、`:570`、`:585`、`:594`、`:607`、`:641`、`:674`、`:715`、`:732`、`:743`、`:757`、`:784`、`:857`、`:871`、`:942`、`:979`(含 `/guahao` 壳，表未列)、`:988`、`:1318`、`:1323`、`:1368`、`:1384`、`:1398`、`:1415`、`:1424`、`:1433`、`:1458`、`:1641`、`:1763`(静态)、`:1775`(legacy)——**表里都覆盖了**；7 条正则路由 `:1028/:1068/:1128/:1150/:1227/:1289/:1306` 也都在 `:148-153`。
你问的 `/api/brief/*` 的 PUT 变体：**实测只有 `POST /api/brief/bundle`(:871) 与 `POST /api/brief/import`(:942)**，无 PUT（`grep -n "req.method === 'PUT'"` 只命中 `:657` 与 `:1227`），这条担心可以撤。
**漏的全在 `meddata/mount.mjs` 内**（`/api/data/*`、网关代理前缀、`/tesseract`、`/traineddata`、`/meddata` 无尾斜杠），见 §1-B 表。

### 3-4 P0-4 限流的具体性：**漏，这是实现层必答题，见 §1-C**

直接回答你的问法："计划有没有写清按 phone 查/不存在用进程内 map？"——**没有**。全文只有 `:114`（字段）与 `:118`（策略），没有一处写"失败次数记在哪、用什么键、phone 不存在怎么办"。而且我不建议"进程内 map"：单进程重启丢计数、多进程不共享（`server.mjs:1808` 单进程今天没问题，但正是会被"加个 worker"打穿的地方）。用同一 `medbrief.db` 的 `login_attempts` 旁路表，与 F9 一致、可审计、重启不丢。

### 3-5 D4 `[待用户拍板]` 是否被正确标为阻塞项：**语义上标了，形式上两处漏**

- ✅ `:276` 明写"Q1/Q2/Q3/Q5/Q6 属于授权/语义决定，计划作者无权替用户定，**编码前必须拿到用户输入**"；
- ❌ **计数错**：`:274` 标题"6 条，**3 条**标 `[待用户拍板]`"，实际 **5 条**（`:278/279/280/282/283`）——这种计数错误会让下一个人以为只剩 3 个口子；
- ⚠️ **"推荐值先做"的危险措辞**：D1 表在 `:156`（`card_export [待用户拍板 Q6]`）、`:192`（`admin [待用户拍板 Q2/Q3]`）已经把权限值**写进表里**再打标。这不算擅自开工，但**实现方完全可以照表实现、忽略方括号**。建议表格该格改成 `TBD(Q6)`，并在 Gate 里加一条"任何 `TBD` 格非空即不许开工"。

### 3-6 回归风险：**比你问的更大——不止 `/data/**`，`鉴权本身`就打挂 9 个测试文件**

- `/data/**` 403 打挂谁：**没有**。`npm run check:blob` = `tools/check-blob-integrity.mjs`，走 `fs` 直读 DB，不走 HTTP；`web/src` 里 `/data/...` 全在**注释**里（`web/src/meddata/store.js:3` 等），没有运行时 fetch；`tests/*` 里 `data/reports.json` 也是 `fs.readFileSync`。**这条你不用担心**。
- **MCP 必须回归，而且当前 D5 的角色清单不够**（详见 §5-P1-2）：MCP 会打 `/api/intake/patient`(GET `:207` / POST `:218`)、`/api/intake/reports/:id/patch`(`:231`)、`/api/intake/card`(`:238`)，而 D5 `:291` 的服务角色写的是"报告读写+卡片+OCR+stitch/parse 的**内部角色**"——**patient 与 patch 没在里面**，照这句实现，MCP 的 `intake_get_patient`/`intake_update_patient`/`intake_update_report` 三个工具会 403。
- **真正的地雷**：`grep -rln "localhost:5174\|127.0.0.1:5174" tests/` → **9 个文件**（`verify-e2e`、`verify-ui`、`verify-edit-modal-375`、`verify-grid-narrow-D1`、`verify-deskew`、`verify-report-lib-ui`、`verify-chunker`、`verify-pdf`、`verify-report-drawer-375`）。上鉴权后**它们全部 401**，而 D3 `:268` 把 `node tests/verify-e2e.mjs` 写成门禁 ⇒ **这条门禁上线当天必红**。计划没有"测试怎么认证"的故事，只有 `MEDBRIEF_AUTH=off`（`:255`），而它①只对 loopback 生效、②用它跑测试等于"门禁证明的是未鉴权路径"——**自证为空**。必须写死：`MEDBRIEF_TEST_USER=<phone>`（仅 loopback + 仅当 `NODE_ENV!=='production'` 时生效，注入固定主体），或给测试一个 `POST /api/auth/login` 的引导助手 + 临时库内种子用户；且**门禁里必须同时跑一遍"auth=on 且无凭证 ⇒ 401"**，否则永远证明不了鉴权在生效。

### 3-7 r1 P1 是否真落：**7 条 ✅，2 条 ⚠️**（P1-4 端口残留 `:74`；P1-8 "3 台设备"是不可执行的约定）

详见 §2.2。补充一处你没在台账里列的：`:19` 的修订说明自己写"3 条必问项标 `[待用户拍板]`"，与 `:274`/实际 5 条互相矛盾——**修订说明、章节标题、正文三处计数两两不一致**，这类"文档自证"错误请在同一批里一次改净。

### 3-8 §8.7 开工 Gate 自检：**计划里没有 §8.7，也没有 G1–G7**

我把 292 行全读了：结构是 `0 / A / B / C / D0–D5`，**没有任何"开工 Gate"章节**（`grep -n "G1\|Gate\|闸门"` 只命中无关行）。所以"G1–G7 逐条判"这一问在本版**无法执行**——这本身要记一笔：上一轮 L 类收尾（`grid-narrow`、`batch-import`）都把 Gate 写进了计划，这条线反而没有。建议补一节，我给一版可直接抄的（判据都可复跑）：

| Gate | 判据 | 当前 |
|---|---|---|
| G1 | D0/C/D1 三处对会话机制表述**同口径**（`grep -c "SQLite token\|服务端 session" plan` = 0） | ✗（P0-E） |
| G2 | `tools/check-route-coverage.mjs` 双向差集为空 | ✗（P0-B） |
| G3 | 静态只允许 `web/dist-next`，4 条绕过回归（`%64ata`/`DATA`/`web/../`/`.git/config`）全 403 | ✗（P0-A） |
| G4 | `login_attempts` 设计与 3 组时序对拍写进 D0/小样 | ✗（P0-C） |
| G5 | `report_owners` 写入/删除/恢复全链路 + `reports+trashed == owners` 对账 | ✗（P0-D） |
| G6 | **用户答完 Q2/Q3/Q5/Q6 + 号码位数**（`[待用户拍板]` 计数 = 实际条数） | ⚠️ 未发生，属正常 |
| G7 | 9 个测试文件 + MCP 的登录/权限故事写死，且门禁含"auth=on 无凭证 401" | ✗（§3-6） |
| G8 | `README`/`INTERFACE.md`/`.agents/MEMORY.md` 同步项列成清单（F8 `:77`） | ⚠️ 只有一句话，无清单 |

---

## 4. addendum 三条（用户拍板 Q1）

### 4-1 建号顺序与授权语义：**是 P0（并入 P0-F），且顺序要写死**

- 用户拍板推翻 v0.2 `:278` 的推荐值：**admin = `13228372097`**（与 114 实名号同号），**报告 owner = 另一个号**。bootstrap 现在只写"`13200000000` 对应 user_id 全量指派"（`:121`/`:125`）⇒ **少一个账号，且指派对象还没确定**。
- **顺序必须写死**：① `--bootstrap` 交互建 admin（stdin 设密码，`:281` 已定）→ ② `--create-user --phone=<owner>` 建 owner → ③ `--apply` 把 98+3 条指派给 owner。**中间任何一步失败不得留下半套状态**（`:125` 已有 `report_owners_bak_<ts>`，建号这一步要加 `users` 的同等备份或事务）。
- **owner 是否自动获授权**：用户原话「普通用户进来是**只能使用报告库**」⇒ **默认全 0**（`card_export=0`、`guahao=0`、`role='user'`），由 admin 事后 `grant`。**不要**因为"反正只有他一个用户"就预置授权——这正是 Q2/Q3 还没答的地方。
- **114 同号的新风险（从建议升为必须）**：admin 号与 114 实名号同号后，`users.phone` 与 `cmi-user-ticket`(`server.mjs:817`) 属于**两套互不认证的体系**。r1 §3-1 的"允许相同也不得复用登录态"必须写成硬约束，并同步 `.agents/MEMORY.md`（F8 `:77` 已列）。否则半年后一定有人拿 114 的登录态当 MedBrief 登录态用。

### 4-2 admin 的 owner 过滤例外：**是必须修的 P0**（见 §1-F）

理由就按你说的那句：**照字面实现，管理员建好后看不到任何报告**。补一条判据：`verify-auth.mjs` 里加"admin → `GET /api/intake/reports` 返回 N>0；user(owner) → 返回 N>0；user(未授权第三方) → 返回 0 条**且** 对 owner 的某份 `GET /api/intake/reports/:id` 返回 403**" —— 三个主体 × 两个端点，才能同时证明"过滤生效"和"例外生效"。

### 4-3 号码位数歧义（`1320000000` 10 位 vs `13200000000` 11 位）：**阻塞 `--apply`，不阻塞编码**

我的裁定，理由分三层：
1. **不阻塞编码**：`users.phone` 的写入点只有 bootstrap 与"改号"两处，实现不依赖具体号码值；
2. **阻塞 `--apply`（写库）**：把 98+3 条指派给一个**打不进/登不上的号**，等于让全库变成"只有 admin 例外能看"的状态（叠加 P0-F，就是"谁都看不到"）；
3. **必须有机器护栏，不能只靠方括号**：`phone` 加 `CHECK (length(phone)=11 AND phone GLOB '1[3-9]*')`，CLI 同校；用户的 10 位号会**当场报错**而不是静默补 0。同时保留 `[待用户确认位数]` 标记进 G6。
4. 顺带：`1320000000` 若真是用户的笔误（少打一位），那么"报告 owner 是哪个号"这件事在 `--apply` 前必须有**一条用户原话**，不能由计划方补位。

---

## 5. P1 清单（与 P0 同批落地，不改方案结构）

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | **9 个测试文件 + MCP 无认证故事**；D3 `:268` 的 `verify-e2e` 门禁上线当天必红（§3-6） | 定一种：`MEDBRIEF_TEST_USER`（仅 loopback + 非 production）或 `tests/auth-helpers.mjs` 登录引导 + 临时库种子用户；门禁里**同时**跑"auth=on 无凭证 ⇒ 401"，否则门禁自证为空 |
| **P1-2** | D5 `:291` 的服务角色**漏 `patient` 读写、漏 `reports/:id/patch`、漏 `blobs`** ⇒ MCP 三个工具 403（`mcp/intake-server.mjs:207,218,231`） | 角色清单写成**逐路由白名单**（`stitch/ocr/parse`、`reports` GET/POST、`reports/:id/patch`、`patient` GET/POST、`card` GET、`blobs` GET），并附 `mcp/smoke-test.mjs` 回归 |
| **P1-3** | F5 `:74` 仍写"独立端口（如 5199）"，与 D3 `:257` 的 5196 冲突（P1-4 残留） | 全文统一 5196/5197，`grep -c 5199 plan` 应为 0 |
| **P1-4** | **共享 blob 的 owner 反查语义未定**：`blobId` 按 sha256 全库复用，一份 blob 可能属于多份（不同 owner 的）报告（`:156` 只说"反查 id 所属报告"） | 写死为"**该 blob 被任一属于我的报告引用 ⇒ 允许**"（EXISTS 子查询），并加一条"他人报告的同一 sha 不可推断存在性"的注释（否则响应差异会泄漏"库里有没有这张图"） |
| **P1-5** | `:119` "同账号最多 3 台设备"**无状态下不可执行**，等于一句空约束 | 删掉，或改成观测项（同一 uid 的 `iat` 出现 >3 个不同 `ua` 指纹时写 `authz_log`），并明写"这不是限制" |
| **P1-6** | `/api/brief/visit-summary`(:292)、`/api/brief/bundle`(:871)、`/api/meddata/summary`(:264)、`/api/intake/card`(:1368) 全部给了权限，但**没说"给谁出卡/出摘要"**——admin 给别人出卡时取谁的报告？ | 写死 `?owner=<user_id>` 语义：默认取"当前主体"，admin 可显式指定；未指定且主体无数据 ⇒ 明确 403/404 文案（不能返回空卡） |
| **P1-7** | `:274` 标题"3 条 `[待用户拍板]`"与实际 5 条不符；`:19` 修订说明同样写"3 条" | 三处计数一次改净（`.agents/testing-lessons.md` R1 的"算了但没判"同源：写了计数就得有人对账） |
| **P1-8** | `:110` 错字"人权机制"、"cookie 拷给"前多空格（`:119`） | 顺手改 |

---

## 6. 我做了什么 / 没做什么

- **只读**：未改计划、未改代码、未提交、未动 `data/reports.json`、未碰 5174 任何写接口；只发 **9 条 GET 探针**（§7 第 1 组）与本地文件 `ls`/`grep`/`node -e`。
- 只写了 `.agents/account-system-1116-review-r2.md` 这一个文件。
- **不能自证的项**（需实现方实测）：未登录 401 / 越权 403 六条 curl、`/data/**` 403（含 4 条绕过回归）、`auth:"on"` 探活、`login_attempts` 三组时序对拍、`verify-auth.mjs` 在 5196。

---

## 7. 复跑命令清单（本判词每条结论可自证）

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-A：静态黑名单的三种绕过（全部只读 GET）
for u in /data/reports.json /%64ata/reports.json /DATA/reports.json \
         /web/%2e%2e/data/reports.json /.git/config /.agents/MEMORY.md \
         /server.mjs /data/medbrief.db; do
  printf '%-30s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code} %{size_download}B' http://127.0.0.1:5174$u)"; done
sed -n '1763p;1782,1790p' server.mjs        # rel 已 decodeURIComponent；9c 无黑名单；9d 回退 200

# ② P0-B：路由真值与表对账口径
grep -c "pathname ===" server.mjs                       # 39（计划写 40）
grep -c "pathname ===\|pathname.startsWith" server.mjs   # 40（口径混用）
grep -cE "\^\\/api\\/intake\\/reports" server.mjs         # 7（正则路由，不在上面两个数里）
grep -n "pathname" meddata/mount.mjs                     # 154/278/286/298/303 五类 mount 入口

# ③ P0-C：限流现状（计划里有的只是字段名，没有语义）
grep -n "failed_count\|locked_until\|login_attempts\|进程内" .agents/account-system-1116-plan.md

# ④ P0-D：归属写路径是否为空
grep -n "report_owners" .agents/account-system-1116-plan.md    # 7 处，全是 bootstrap/过滤/回退，无写入路径
grep -n "pathname === '/api/intake/reports'\|reports/\[^/\]" server.mjs | head   # :1641 :1028 :1068 :1128 :1150 :1227

# ⑤ P0-E：C 表残留
grep -n "SQLite token\|服务端会话\|服务端 session" .agents/account-system-1116-plan.md   # :87 :97

# ⑥ P1：测试回归面与 MCP 调用面
grep -rln "localhost:5174\|127.0.0.1:5174" tests/ | wc -l        # 9
grep -n "call('/api\|call(\`/api" mcp/intake-server.mjs          # patient / patch / card 均在
sed -n '291p' .agents/account-system-1116-plan.md                # 服务角色清单

# ⑦ 事实复核（29 字段 / 98·3·3 / INTERFACE.md）
node -e "const j=require('./data/reports.json');const s=new Set();j.reports.forEach(r=>Object.keys(r).forEach(k=>s.add(k)));console.log(j.reports.length,j.trashed.length,j.audit.length,s.size)"
ls -l INTERFACE.md
```
