# 账号系统方案 · 独立审核 r5 输入（plan-review §8.2b 续期复审）

- 被审计划：`/Users/scallion/Documents/projects/MedBrief/.agents/account-system-1116-plan.md` **v0.5**
- 上轮判词：`.agents/account-system-1116-review-r4.md`（总判「不能直接进下一轮」，1 条 P0 + 6 条 P1）
- 你的角色：**独立审核者，只读**。白名单只许写 `.agents/account-system-1116-review-r5.md`。

## 上轮终判原文（§8.2b 强制：首行粘贴原文）

> **总判：不能直接进下一轮 —— 1 条 P0。**
>
> r3 的 3 条 P0 里 **2 条真闭合**（P0-2 方法列、P0-3 三条机械判据 —— 我逐条实跑 = 0/0/5），**P0-1 只闭合了一半**：`GET /` 不再 403（首页救回来了 ✓），但同一个代码块把"唯一静态根"变成了**恒真的空断言**，静态洞没有真正闭上。
>
> **P0-1｜§1.4 的 containment 锚错了根 ⇒ 白名单退化成黑名单，9c 仍在服务仓库内文件**：`path.join(distDir, rel)` 与 `distDir` 比较**恒真**，于是所有判定落到 `denyExt/denyDir`（黑名单）；`9c` 没删 ⇒ `/web/src/App.jsx`、`/web/src/pages/IntakePage.jsx`、`/index.html` 匿名 200。其中 `/index.html` 正是 `:194` 定为 **admin** 的那份旧工作台的仓库根副本。
> 要命的是**判据抓不到**：G3 的 6 条断言（4 条绕过 403 + 2 条肯定 200）在这个洞还开着时**全部通过**。
> 改法两件事必须同时做：① containment 锚回 `__dirname`；② **删掉 9c**；③ 补 `/index.html` 与 `/web/src/*` 两条 403 断言。
>
> 另记 6 条 P1：矩阵 `:162` 还写着「PUT 新建分支」与 §1.6 矛盾；A 集合正则数 `:199`/`:316` 写 7、G2 写 10；`grep -v 'G1'` 排除面过宽；`Retry-After` 挂 401 非标准；D3 `/assets/*.js` 断言取不到 URL 会假绿；purge 事务要落具体行号；G2/G3 脚本应列为编码第 0 步。

这是对 r4 终判的复审。

## 上轮 P0 关闭台账

| 上轮 P0 | 本版申报落点 | 状态 |
|---|---|---|
| P0-1 静态洞未闭 | §1.4 代码：`path.resolve(__dirname, rel)` 锚仓库根 + `inDist` 判定 + **`!inDist && fs.existsSync(real) && isFile()` ⇒ 403**（作者自跑发现 r4 原改法会让 `index.html`/`.jsx` 落 9d 得 200 HTML，主动补强）+ 明确**删掉 9c** + G3 补 `/index.html`、`/web/src/App.jsx` 两条 403 断言 + D3 门禁同步 | ✅ |

作者自跑模拟（你的 12-rel 脚本逻辑，改为 existsSync 边界）结果：`''→9d`、`data/*` / `DATA/*` / `web/../data` / `.git` / `.agents` / `index.html` / `web/index.html` / `web/src/App.jsx` / `web/src/pages/IntakePage.jsx` 全 **403**；`assets/index-Dhctrm9M.js` **不被闸门拦截**（由 9a 用 distDir 先服务，实测文件真实存在 `web/dist-next/assets/index-Dhctrm9M.js`）。G1/5199/G6 收紧后实跑 = **0/0/5**。

## r4 的 6 条 P1 关闭台账

| P1 | 本版落点 | 状态 |
|---|---|---|
| P1-1 孪生行 7→10、矩阵 PUT | 矩阵 `:162` 改"恒为更新，无新建分支"；R8 `:61`、自检 `:199` 改"10 条（7 reports+3 guahao）" | ✅ |
| P1-2 grep -v G1 过宽 | 实跑发现 r4 建议的 `grep -vE '^\| G1 '` 对带 `-n` 输出失效（G1 行前缀是 `330:\| G1`）；v0.5 改用 `grep -vE '^[0-9]+:\| G1 '` + 排引用块，实跑 = 0 | ✅ |
| P1-3 Retry-After 挂 401 非标准 | 锁定期状态 401 → **429**（四行表同步）；存在性 oracle 已由"无此号同样计数"排除 | ✅ |
| P1-4 assets URL 假绿 | D3 加 `u=$(...); [ -n "$u" ] \|\| { echo FAIL; exit 1; }` 非空守卫 | ✅ |
| P1-5 purge 事务行号 | §1.6 点名 `server.mjs:1070` purge 分支、`:1083`/`:1124` 两处 `writeReports(store)` | ✅ |
| P1-6 G2/G3 脚本先落地 | D3 加"编码第 0 步 = `check-route-coverage.mjs` + `verify-auth.mjs` 骨架，先红后绿" | ✅ |

## 本轮必攻击点

1. **P0-1 真伪**：按 v0.5 §1.4 代码逐字实跑（`node -e` 路径模拟 + 只读 GET），确认 `''`/assets 不拦、`data/*`/`DATA/*`/`web/../data`/`.git`/`.agents`/`index.html`/`web/src/*` 全 403；确认"删 9c"在计划里写死（不是可选）。
2. **作者自跑发现的补强是否正确**：r4 给你的原改法（非 inDist 且不在 deny 名单 → 落 9d）会让 `index.html`/`.jsx` 得 200；v0.5 改成"非 inDist 且文件真实存在 ⇒ 403"。请判这个补强有没有引入副作用（如：dist-next 里存在的资产在 9a 已返回，闸门执行不到；不存在的深链落 9d——是否还有第三类路径被误伤）。
3. **G3 门禁**：7 条 403（4 绕过 + `/index.html` + `/web/src/App.jsx`，作者计划文本里写"6 条 403"是笔误还是数错？请数清）+ 2 条 200 肯定断言 + assets 非空守卫，是否足以抓住 P0-1 的洞不再复发。
4. **P1-2 判据收紧**：实跑 G1/5199/G6，确认 0/0/5；确认 `grep -vE '^[0-9]+:\| G1 '` 在带 `-n` 与不带 `-n` 两种写法下都成立（或指出必须固定带 `-n`）。
5. **P1-3 状态表一致性**：锁定期 429 + `Retry-After` 与"无此号同样计数/同样锁定"是否仍不可分辨；admin 不硬锁是否使其永不进该行。
6. **孪生行一致性**：全文 `grep -n "新建分支"` 是否只剩否定表述；`grep -n "7 条"` 是否只剩"7 reports + 3 guahao"的合法写法。
7. **新 P0**：v0.5 精准编辑是否引入新矛盾（尤其 `!inDist && existsSync` 与 9a 资产路径、9d SPA 回退、D3 断言之间的三角关系）。
8. **§8.7 Gate**：G1–G8 判据机械可执行，"⬜=未证不计通过"口径保持。

## 输出格式（§8.3）

1. 总判三档之一。若 1 条 P0 闭合且无新 P0 → `可以开工`（G6 用户未答属正常阻塞；用户确认独立门槛）。
2. 逐条闭环核对表：上轮 1 P0 + 6 P1 + 本轮 8 必攻击点 → 落点 → ✅/⚠️/❌。
3. 本轮 8 点逐条回答 + 文末复跑命令清单。

写完只报文件路径 + 总判 + P0 列表给我。
