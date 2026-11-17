# 账号系统方案 · 独立审核 r3 输入（plan-review §8.2b 续期复审）

- 被审计划：`/Users/scallion/Documents/projects/MedBrief/.agents/account-system-1116-plan.md` **v0.3**（整份重写，非打补丁）
- 上轮判词：`.agents/account-system-1116-review-r2.md`（总判「不能直接进下一轮」，6 条 P0 + 8 条 P1）
- 你的角色：**独立审核者，只读**。白名单只许写 `.agents/account-system-1116-review-r3.md`。不改计划/代码、不提交、不动 data/、不碰 5174 写接口。
- 本轮是**续期复审**：v0.2 → v0.3 按 r2 判词整份重送，6 条 P0 全部申报关闭。

## 上轮终判原文（§8.2b 强制：首行必须粘贴原文）

> **总判：不能直接进下一轮 —— 6 条 P0。**
>
> 针对你指定的四项检查，先给结论：**P0 关闭清单中 5 条只有 2 条真正关闭**（P0-2 主体 ✓、P0-3 ✓），其余三条只是"写了但没写到位"：
> 1. **P0-A｜静态黑名单不可执行**：判断对象选错，三种写入方式全部 200（`/%64ata`、`/DATA`、`/web/%2e%2e/data`），还有 `/.git/config`、`.agents/MEMORY.md` 200。
> 2. **P0-B｜D1 仍漏 5 类入口 + 自检断言无效**：`meddata/mount.mjs` 内 5 类入口未列；自检基数 39 写成 40，"≤"断言漏 5 条也绿。
> 3. **P0-C｜限流语义缺失**：`users.failed_count` 在认证前无行可写，枚举 oracle + 远程锁死。
> 4. **P0-D｜入库/删除/恢复全不写 report_owners**。
> 5. **P0-E｜P0-5 没关干净**：C 表 `:87`/`:97` 仍写服务端会话。
> 6. **P0-F｜admin ≠ owner 后管理员看不到任何报告**。
>
> 另外：§8.7 开工 Gate 不存在；9 个测试文件硬编码 5174 且无认证故事；号码歧义只阻塞 `--apply`，不阻塞编码，且必须加 `CHECK(length=11)` 机器护栏。

这是对 r2 终判的复审。

## 上轮 P0 关闭台账（强制：逐条对账编号集合）

| 上轮 P0 | 本版落点（`文件:行`） | 状态 |
|---|---|---|
| P0-A 静态黑名单绕过 | D1 §1.4（`:200-216`）改为 `fs.realpathSync` + 唯一根 `web/dist-next`，403 `return`；D3 4 条绕过回归断言 | ✅ |
| P0-B 漏 5 类入口 + 自检无效 | D1 §1.1 补 5 类 mount 入口（`/api/data/*`、网关前缀、`/tesseract`、`/traineddata`、`/meddata` 无尾斜杠、`/guahao` 壳）；§1.1 尾 `tools/check-route-coverage.mjs` 双向差集（A=39 字面量+7 正则+2 startsWith+5 mount，B=表）；基数订正 40→39 | ✅ |
| P0-C 限流语义缺失 | D0 `login_attempts` 旁路表（phone/ip 双键、退避封顶 8s、锁满归零、三组同分布响应 + dummy scrypt）；D2 小样第 2/10 条 | ✅ |
| P0-D 写路径无归属 | D1 §1.1 owner 校验列写死 POST/PUT/purge/restore 四处 + §1.6 全链路 + `reports+trashed==owners` 对账；D0 `source='ingest'` | ✅ |
| P0-E 会话机制残留 | C 表会话行改 iron-session；JWT 砍的理由改写；全文旧口径除 G1 判据行外 0 命中（`grep` 可验） | ✅ |
| P0-F admin 看不到报告 | D1 §1.5 admin owner 豁免三处写死 + `read_report_as_admin` 审计 + 三主体×两端点判据；D0 两账号建号顺序 + owner 默认零授权 | ✅ |
| r2-P1-1 测试认证故事 | D3 认证注入方案 + "auth=on 无凭证 401"门禁 | ✅ |
| r2-P1-2 MCP 逐路由白名单 | D5 显式逐路由（含 patient/patch/blobs，排除 admin/reset/launch-login）+ smoke-test | ✅ |
| r2-P1-3 端口统一 | F5 5199→5196；全文 `grep -c 5199` = 0（除修订说明的"已删除 5199"字样） | ✅ |
| r2-P1-4 blob EXISTS 语义 | D1 §1.1 blob/:id 行 EXISTS 子查询 + 不泄漏存在性 | ✅ |
| r2-P1-5 3 台设备 | D0 删硬限制，改 UA 指纹观测项并明写"不是限制" | ✅ |
| r2-P1-6 `?owner=` 语义 | D1 §1.5 | ✅ |
| r2-P1-7 三处"3 条"计数 | 全文改"5 条"+位数第 6 项（D4/G6 计数 6） | ✅ |
| r2-P1-8 错字 | "人权机制"已删；F4 表格闭合 | ✅ |

## 本轮必攻击点（只审上轮 P0 是否闭合 + 是否引入新 P0，不新开战线）

1. **P0-A 真伪**：`realpathSync` + 唯一根方案是否真能挡住 `%64ata`/`DATA`/`web/../`/`.git/config` 四类？403 `return` 是否在 9d 之前？请按 D1 §1.4 的代码在脑内或临时目录实跑一次（只读，可写 `/tmp`）。
2. **P0-B 真伪**：`check-route-coverage.mjs` 的 A 集合是否真的覆盖 5 类 mount 入口（去读 `meddata/mount.mjs:154,278,286,298,303`）？双向差集是否可机械执行？权限表是否把 `/api/data/*` 等全列了？
3. **P0-C 真伪**：`login_attempts` 双键、无此号也跑 dummy scrypt、锁满归零、429+Retry-After 是否写全？"响应不可分辨"与"锁定时多一个 Retry-After 头"自相矛盾吗（锁定的响应是否因此可分辨）？
4. **P0-D 真伪**：POST/PUT/purge/restore/patch 五处语义是否写全？`n(reports)+n(trashed)==n(report_owners)` 对账断言在软删+恢复场景下是否成立？
5. **P0-E 真伪**：实际跑 G1 判据的 grep（排除判据行自身），确认旧口径 0 命中。
6. **P0-F 真伪**：admin 豁免是否覆盖 reports 列表/详情/blob/blobs 四处？三主体×两端点判据是否同时证明过滤与例外？owner 默认零授权与"报告归 owner 但 owner 只看报告库"是否自洽？
7. **§8.7 Gate**：G1–G8 是否落进计划且判据可复跑（G6 用户未答标 ⚠️ 属正常）？G1 的 grep 自引用陷阱是否已排除？
8. **是否有新 P0**：v0.3 整份重写是否引入与 r2 无关的新矛盾（例如 admin 与 114 同号但 D0 的 `phone UNIQUE` 约束、两账号建号顺序、`phoneVerifiedAt` 恒 null 等）？有则列出，无则明说。

## 输出格式（§8.3）

1. 总判三档之一。若 6 条 P0 全闭合且无新 P0 → `可以开工`（P1 须有落点；G6 用户未答属正常阻塞，不记为 P0）。
2. 逐条闭环核对表：上轮 6 P0 + 8 P1 + 本轮 8 必攻击点 → 本版落点 → ✅/⚠️/❌。
3. 本轮 8 点逐条回答 + 文末复跑命令清单。

结论必须指到编号与证据；无锚断论不算判词。写完只报文件路径 + 总判 + P0 列表给我。
