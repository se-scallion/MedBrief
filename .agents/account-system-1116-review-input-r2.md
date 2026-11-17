# 账号系统方案 · 独立审核 r2 输入（plan-review §8.2）

- 被审计划：`/Users/scallion/Documents/projects/MedBrief/.agents/account-system-1116-plan.md` **v0.2**
- 上轮判词：`.agents/account-system-1116-review-r1.md`（总判「不能直接进下一轮」，5 条 P0 + 8 条 P1 + 附录 A 三裁定）
- 你的角色：**独立审核者，只读**。白名单只许写 `.agents/account-system-1116-review-r2.md`。不改计划/代码、不提交、不动 data/、不碰 5174 写接口。
- 本轮是**常规下一轮**（非续期）：v0.1→v0.2 按 r1 判词整份修订，全部 P0 申报关闭，请逐条对账。

## 上轮 P0 关闭台账（必审：逐条核对申报的落点是否真闭合）

| 上轮 P0 | 本版申报落点（`文件:行`） | 状态 |
|---|---|---|
| P0-1 `/data/**` 公开 | D1 静态黑名单段（`:183` 表格末行 + `:200` 实现说明）；D3 两条 curl 403 断言（V3 验收段） | ✅ |
| P0-2 权限矩阵漏 14 条 | D1 §1.1 改「按行号穷举」表（`:148-185`），含 blob/blobs/ocr/parse/stitch/recognition-hits/reports/:id 六方法/legacy/next/meddata；自检断言（`:185`） | ✅ |
| P0-3 钩子位置绕过 | D1 §1.3（`:199`）：钩子插 `:224` 后 `:229` bump 前；默认拒绝 + 非 /api 白名单 | ✅ |
| P0-4 爆破 + 旁路无边界 | D0 `failed_count/locked_until` 限流（`:89-95` 段）；D3 `MEDBRIEF_AUTH=off` 三约束 + `auth:'on'` 探活断言 | ✅ |
| P0-5 D0/D2 会话机制矛盾 | D0 整段重写为方案 A（iron-session），删 `sessions` 表；写明"登出仅清 cookie、`sessionVersion+1` 才是真撤销" | ✅ |
| 附录 A-1 J7/即时撤销 | D0 写明二选一代价 + 触发点列全（改密码/改号/停用/踢下线） | ✅ |
| 附录 A-2 小样断言不足 | D2 小样 5 条 → 10 条（secret/CORS/体积/原生 http/sessionVersion 实证/限流） | ✅ |
| 附录 A-3 better-auth 取证 | D2 补版本锁 `npm view`、phone-number 文档页存在标 `[待核]`、延后触发条件补第 4 条 | ✅ |

## 本轮必攻击点

1. **P0 关闭台账对账**：逐条 grep `account-system-1116-plan.md` 的申报行，确认 P0-1~5 不是"口头上 ✅、文档里没落"。特别注意 P0-1 的静态黑名单：协议里写的是"在 9c（`:1782`）**之前**插"，检查 D1 是否明确到可执行程度（具体拒绝路径清单 + 403 响应）。
2. **D0 方案 A 自洽**：删掉 `sessions` 表后，D1 表里还有没有残留"服务端 session"措辞？`sessionVersion+1` 与 `users` 表字段是否对齐？"授权改后下次请求生效"在 cookie 只放 `{uid,v}`、权限位每次读库的设计下是否真成立？
3. **D1 穷举表是否还漏**：自己跑 `grep -n "pathname ===\|pathname.startsWith\|req.url.startsWith" server.mjs`，对照 §1.1 表，找出仍未覆盖的路由（尤其 `/api/intake/reports/:id` 的 6 个动态方法、`/api/brief/*` 的 PUT 变体、静态资源路径前缀）。
4. **P0-4 限流的具体性**：`failed_count/locked_until` 写在 `users` 表里，但登录尝试发生在**认证前**——未登录用户没有 user 行，怎么记失败次数？计划有没有说明按 phone 查 users（不存在则进程内 map）？这是实现层必须有的语义，请判断是否漏。
5. **D4 待用户拍板项**：Q1/Q2/Q3/Q5/Q6 五条 `[待用户拍板]` 是否被正确标记为阻塞项（即：在用户回答前不得开工对应部分）？还是计划里仍有"推荐值先做"的危险措辞？
6. **回归风险**：新增 `/data/**` 403 会不会打挂现有测试（`tests/verify-e2e.mjs`、`npm run check:blob`、`mcp/intake-server.mjs`）？D3 验收命令覆盖了 `verify-e2e` 和 `check:blob`，但没覆盖 MCP——MCP 是否也需要回归断言？
7. **r1 P1 是否真的全落**：P1-1 页内按钮表、P1-2 两张审计表、P1-6 Q6、P1-8 3 台设备约定、事实订正（29 字段 / R5 理由）——逐条 grep 确认。
8. **§8.7 开工 Gate 自检**：G1–G7 逐条判断（G6 用户确认尚未发生属正常，可标 ⚠️；其余若 ✗ 必须指出）。

## 输出格式（§8.3）

1. 总判三档之一：`可以开工` / `不能直接进下一轮` / `只准哪几条`。
   - 若仍有 P0 → `不能直接进下一轮`，并给 P0 编号；本轮不许新增与 r1 无关的新战线，除非它是 P0。
   - 若只剩 P1/无 P0 → 可判 `可以开工`（P1 必须已在计划里有落点，不是只在聊天里）。
2. 逐条闭环核对表：r1 的 5 条 P0 + 8 条 P1 + 上轮 8 条必攻击点 → 本版落点 → ✅/⚠️/❌。
3. 8 条本轮必攻击点逐条回答 + 文末复跑命令清单。

结论必须指到编号与证据；无锚断论不算判词。写完只报判词文件路径 + 总判 + P0 列表给我。
