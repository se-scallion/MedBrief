# MedBrief 部署计划 v0.5c · 独立实测审核 r6 判词

> **无项目定制层，仅通用排雷**（§7.4；`.agents/` 无文件在文件头声明通用层）。
> 审核者：代诊-挂号（独立会话；只读，唯一写入 = 本文件）。被审：`.agents/deploy-1117-plan.md` **v0.5c**（HEAD `8488494`，交付态 `83d1b99`）。输入：`/tmp/medbrief-r6/deploy-1117-review-input-r6.md`（66 行，含 r5 终判照录 + 7 条新事实 + 5 个攻击点）。
> 服务器侧事实一律采信运维提供的 `ufw status` / `ss -lntp` / 实测输出，**不拿本机出口 IP 推断公网可达性**（r4 已踩过：本机 `27.189.119.49` 在 1Panel/面板白名单内）。

---

## 一、总判（§8.3 第一块）

**总判：`可以开工`（维持 r5），但 3 条 P1 必须在进入阶段 2 前折进计划正文**——它们不推翻"计划可开工"，但会让"骨架上线"这个当前唯一可执行的动作**缺护栏**。

| P1 | 一句话 | 判据 |
|---|---|---|
| **P1-①** | 「骨架上线 + 数据上线」**只存在于运维消息里，计划正文零字**（`grep -n "骨架\|数据上线\|空库" .agents/deploy-1117-plan.md` → 0 命中），而它是"用户选择暂不轮换"下唯一能推进的路径 | 见第三块第 5 条 |
| **P1-②** | 计划四处仍写「**Secure cookie 代码 grep 零命中 ⇒ 未实现**」，但代码**已支持**：`lib/auth.mjs:57` `if (process.env.MB_COOKIE_SECURE === '1') parts.push('Secure')` | `grep -rn MB_COOKIE_SECURE lib/` → 1 命中；`grep -n "Secure cookie" .agents/deploy-1117-plan.md` → `:7/:53/:73/:109/:124` 仍是旧口径 |
| **P1-③** | 部署凭证审计链**只钉了 commit id，没钉文件内容**；服务器侧 `commitSource=env` 时 `dirty=null`（`server.mjs:105-121`），"部署的就是这个 commit"仍不可机械核验 | 见第三块第 2 条（补 `fileHashes` 方案） |

> `可以开工` ≠ 授权：仍受 G6（已给）+ 拍板 A 约束；**6b 硬闸（凭据轮换）仍是阶段 2 的闸**，骨架上线不得带任何真实病历数据。

---

## 二、逐条闭环核对表（§8.3 第二块）

| 编号 | 内容 | 落点 / 可复跑命令 | 判定 |
|---|---|---|---|
| r5 **P1-1** 三方比对第三腿 | 第三腿改到构建机 | 计划 `:109`(D0-5⑥)、`:120`（`.deploy-commit` 的 commit==部署 commit，服务器只两方比对 + commitSource） | **✅** |
| r5 **P1-2** 资源数字陈旧 | 20G/1.9G | 计划 `:17`（表内已标「v0.5a 更新…剩 20G / 可用 1.9G，原快照已过期」）、`:38`、`:150` | **✅** |
| r5 **P2-1** 编号重号 | 阶段 2「7.备份」与阶段 3「7.进程守护」撞号 | 已改 `:126`「6c. 备份」；`grep -n "^7\. "` 只剩进程守护 | **✅** |
| r5 **P2-2** `data/gt**` 不存在 | 白名单笔误 | 计划 `:123`「（`data/gt**` 实测不存在，已从白名单删）」 | **✅** |
| r5 **P2-3** 守卫清点不全 | 6 处 | 计划 `:119`、`:137`（`:564/:596/:612/:633/:862/:972` + flow/start 503 反向断言） | **✅** |
| r5 **P2-4** A2 把"只有白名单端口能进"写成事实 | 降级为假设 | 计划 `:35` 已改「（**当前规则是否仍如此须按阶段 3.9 复测，不从本条快照下结论**）」 | **✅** |
| **攻击1** 缺口①②③ 是否让「可以开工」失效 | — | 见第三块第 1 条 | **✅ 维持开工**（①②③ 已成硬断言） |
| **攻击2** 审计链够不够硬 | — | 见第三块第 2 条 | **⚠️ → P1-③** |
| **攻击3** 零 chromium 机械化判据 | — | 见第三块第 3 条 | **✅ 给命令**（原依据只有"守卫存在"，缺上线后观测判据） |
| **攻击4** 5174 只绑回环是否足够 | — | 见第三块第 4 条 | **⚠️ 不够，需补 systemd 硬化 + `MB_COOKIE_SECURE=1`** |
| **攻击5** 骨架/数据拆分是否正解 | — | 见第三块第 5 条 | **✅ 方向对，但顺序要改 + 必须入计划**（P1-①） |
| 缺口① lock 可移植 | — | `grep -c '"link": true' package-lock.json` → **0**；`:116` 已把该判据写进阶段 1 | **✅** |
| 缺口② vendor 需 `npm ci` | — | `git ls-files vendor` → 仅 `package.json`+lock；`vendor/node_modules` 被 `.gitignore:1` 忽略；`:117` 已补「`cd vendor && npm ci`，否则 `ERR_MODULE_NOT_FOUND`」 | **✅** |
| 缺口③ `.deploy-commit` 钉错 commit | — | `.deploy-commit` 现 `commit=83d1b99`、`distSha256=757631a7…`；`:120` 已补判据（commit==部署 commit；`web/`+`server.mjs` 必须干净） | **✅（内容级见 P1-③）** |

---

## 三、本轮攻击点逐条回答（§8.3 第三块）

### 1. 缺口①②③ 是否让 r5 的「可以开工」失效？

**不失效，维持 `可以开工`。** 理由与判据：

- 三条都属于**执行期实证缺口**（计划漏写运维事实），不是设计缺陷：①lock 软链污染、②vendor 独立依赖树、③凭证钉错提交。三者都已在 v0.5c 变成**可复跑的阶段 1 断言**：`:116`（`grep -c '"link": true'` = 0 且 resolved 全为 registry URL）、`:117`（`cd vendor && npm ci`，并写明不做的后果是 `ERR_MODULE_NOT_FOUND`）、`:120`（`.deploy-commit.commit` == 部署 commit + `web/`/`server.mjs` 必须干净）。
- 我复核了落地事实：`package-lock.json` 现 `"link": true` 计数 **0**、playwright 解析到 `https://registry.npmjs.org/playwright/-/playwright-1.62.1.tgz`；`git ls-files vendor` 只有 `vendor/package.json`、`vendor/package-lock.json`，`vendor/node_modules` 确在 `.gitignore` 覆盖内。
- **唯一要求**：把这三条从"计划里的说明"变成"阶段 1 的**失败即停**断言"——`:116/:117/:120` 已写成判据，但没写"失败处理"（停在哪一步、回滚到哪）。补一句「任一断言失败 → 停阶段 1，不进入阶段 2；已投递包作废重打」即可，属 §8.7 G3 的落点补全，不需再开一轮。

### 2. 部署凭证审计链够不够硬？`dirty:true` 会不会让结论失真？

**够"知道部署了哪个 commit"，不够"知道部署了什么内容"。`dirty:true` 不是致命，但当前记录方式不可核验，需要补 fileHashes。**

事实核对：

- `.deploy-commit` 现在的内容是 `{commit:"83d1b99", commitFull:"83d1b99…", dirty:true, distFileCount:9, distSha256:"757631a7…", builtAt, builtBy, nodeVersion}`。
- 服务器侧：`server.mjs:105-121` 无 `.git` 时走 env 分支，返回 `{head: MEDBRIEF_COMMIT, source:'env', dirty:null, dirtyCount:null}` ⇒ **health 的 `dirty` 在服务器上恒为 `null`**，即"是否有别线改动"这件事在运行时**不可见**；`:120` 的「`web/`+`server.mjs` 必须干净」只有构建机口径，服务器无法自证。
- `dirty:true` 的实际含义：`git status` 里还有别线改动（本次只剩 `lib/reportStore.mjs`，我读过 diff——**只改注释**，不改行为）。所以"内容偏差"这次是安全的；但**结论依赖我去读 diff**，而不是依赖凭证本身 ⇒ 这就是不可核验的地方。

**补法（三行，机械可验，不依赖 git 也不依赖 env）**：`.deploy-commit` 增两字段，服务器侧用 `sha256sum -c` 验：

```json
"fileHashes": { "server.mjs": "<sha256>", "lib/auth.mjs": "<sha256>", "web/dist-next/index.html": "<sha256>", "vendor/package.json": "<sha256>" },
"dirtyFiles": [ { "path": "lib/reportStore.mjs", "sha256": "<sha256>" } ]
```

验收：`cd /opt/medbrief && sha256sum -c <(python3 tools/emit-hashcheck.py .deploy-commit)` → 全 OK；并把 `dirtyFiles` 里每个文件在**服务器上不存在**（因为投递的是 commit 产物，不该含 dirty 文件）作为附加断言——这一条能直接证明"别线改动没被带上线"。
另建议：`dirty:true` 时在 `.deploy-commit` 里同时存 `git status --porcelain` 原文，供事后审计。

### 3. 「零 chromium」上线后的机械化判据

原依据只有"代码里有守卫"，那是**静态**证据；上线后要能一条命令判定。给四层，前两层必须全绿：

```bash
# ① 运行时环境真的注入了开关（systemd → 进程 environ）
pid=$(systemctl show medbrief -p MainPID --value)
tr '\0' '\n' < /proc/$pid/environ | grep -E '^(GUAHO_BROWSER|PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD|MEDBRIEF_BIND)=' 
#   期望：GUAHO_BROWSER=off / PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 / MEDBRIEF_BIND=127.0.0.1

# ② 进程树里没有任何浏览器进程（含 playwright 的 headless_shell / chrome-linux）
pgrep -fa 'ms-playwright|headless_shell|chrome-linux|chromium' | wc -l     # 期望 0
ls -d /root/.cache/ms-playwright /opt/medbrief/.cache/ms-playwright 2>/dev/null  # 期望都不存在

# ③ 进程内存映射里不出现浏览器二进制（② 的补充，防 pgrep 名不匹配）
grep -c -E 'ms-playwright|headless_shell|chrome-linux' /proc/$pid/maps     # 期望 0

# ④ 行为断言（最强，防止"守卫写了但路由没走守卫"）
for u in /api/guahao/monitor/realtime /api/guahao/114/session; do curl -s localhost:5174$u | head -c 200; echo; done
curl -s -XPOST localhost:5174/api/guahao/114/flow/start | head -c 200; echo
#   期望：monitor → "disabled":true,"code":"BROWSER_DISABLED"；session → "disabled":true；flow/start → 503 BROWSER_DISABLED
```

补充一条**请求期采样**（防"平时不用、一调用就拉"）：`for i in 1 2 3 4 5; do pgrep -fc 'headless_shell|chrome-linux'; sleep 1; done` 在跑 ④ 的同时执行，全程为 0。
启动日志辅助判据：`journalctl -u medbrief --since today | grep -iE 'chromium|playwright|browser' ` → 除 `GUAHO_BROWSER` 相关提示外**不应有 launch 记录**。

### 4. `5174` 只绑 `127.0.0.1` 是否足够？要不要 `PrivateNetwork=` / XFP？

**不够；而且 `PrivateNetwork=` 建议明确否决，`X-Forwarded-Proto` 在当前代码上无意义。**

- **只绑回环是必要不充分**：它挡住了跨机直连，但挡不住**同机其它容器**（r4 已实测该机有 8 个容器；openresty 是 `host` 网络，容器内 `127.0.0.1` 即宿主 loopback ⇒ 任何 host-net 容器或未来新增容器都能直连 5174 绕过 TLS 与反代）。因此要再加进程级网络收口。
- **`PrivateNetwork=yes` 不要设**：它会给 unit 单独的网络命名空间，`1Panel-openresty`（host 网络）**就连不上 127.0.0.1:5174**，属自断反代。用这条替代：
  ```ini
  NoNewPrivileges=yes
  ProtectSystem=strict
  ProtectHome=yes
  PrivateTmp=yes
  ReadWritePaths=/opt/medbrief/data /etc/medbrief
  RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
  IPAddressDeny=any
  IPAddressAllow=localhost          # 只允许回环，连内网也不通
  ```
- **XFP 现在没用**：`grep -rn "X-Forwarded-Proto" server.mjs lib/*.mjs` → **0 命中**，服务端根本不读它 ⇒ 计划 `:131` 里「反代须转发 XFP（配合 Secure cookie）」这句在代码侧无对应实现，应改成「**用 `MB_COOKIE_SECURE=1` 直接给 cookie 加 Secure**」（见 P1-②）。
- 反代侧仍要做：80→443 301、HSTS、`client_max_body_size 50m`（已有）、证书独立（已有）。

### 5. 「骨架上线 + 数据上线」拆分是否为正确处置？要防哪些动作？

**方向正确且是当前唯一可推进的路径**（用户已选"先不轮换"，6b 仍是阶段 2 硬闸），但**两处必须改：顺序调整 + 写进计划正文**。

**(a) 顺序要改**：6b 的 ①②（规则留档 + 持久化排查）是**只读、便宜、无损**的，应当在**骨架上线之前**做完；③（凭据轮换）才等到数据上线前。现在把 6b 整体当"阶段 2 硬闸"，会让骨架期在"未排查过的机器"上开一个新的公网 HTTPS 入口——没必要冒这个险。
建议改成：**6b① ② → 骨架上线 → 6b③ ④ + 数据上线**。

**(b) 骨架上线必须点名的六个防动作**（都是"空库也会发生"的事，逐条可验）：

| # | 动作 | 判据 / 命令 |
|---|---|---|
| 1 | **空库首启会写盘**：`server.mjs:123` `fs.mkdirSync(DATA_DIR)`、`lib/accounts.mjs:22` `CREATE TABLE IF NOT EXISTS users …`（首次触碰 sqlite 即建表）⇒ 骨架期一定产生 `data/` 与 `data/medbrief.db` | `ls -la /opt/medbrief/data/` → 有 `medbrief.db`（0 行数据也可）；**记录其 sha256 与大小**，数据上线时要么覆盖要么先删，避免旧库残留 |
| 2 | **零用户 = 站点可访问但无人可登录**：`grep -n "accounts.createUser" server.mjs` → 仅 `:845`（`/api/admin/users`，要求 `role==='admin'`，`MEDBRIEF_AUTH=off` 时 503）⇒ **不存在开放注册**，不会被人抢注 | `curl -s -o /dev/null -w '%{http_code}' -XPOST localhost:5174/api/admin/users -d '{}'` → `401/503`（非 200） |
| 3 | **骨架期禁止任何真实数据**：包括"拿真实报告试导入" | `curl -s localhost:5174/api/intake/reports \| head -c 120` → `total:0`；`ls /opt/medbrief/data/reports.json 2>/dev/null` → 不存在 |
| 4 | **cookie 必须 Secure**，否则骨架期一旦 https→http 回退（如反代配置错），会话票据明文 | 设 `MB_COOKIE_SECURE=1`（代码已支持），验收 `curl -sI https://medbrief…/api/auth/login -XPOST` 的 `Set-Cookie` 含 `Secure` |
| 5 | **会话密钥与数据期密钥分离**：骨架期就把 `MB_SESSION_SECRET` 写进 `/etc/medbrief/medbrief.env`（600），但**数据上线前必须轮换一次**（6b③ 的凭据轮换要覆盖它，不能漏） | 数据上线检查单里加一行「轮换 MB_SESSION_SECRET 并重启」 |
| 6 | **DNS/证书可以在骨架期建，但公网入口与数据上线解耦**：骨架期若 `medbrief.shanhailingjing.top` 已解析且证书就绪，站点就是公网可见的空壳——**可以接受**，前提是 ①② 已做 + 上表 1–5 全绿 | `curl -s https://medbrief…/api/health` → `auth:on`、`ok:true`、`head` 与 `.deploy-commit` 一致 |

**(c) 明确不放行的**：骨架期**不得**借"空库"名义带上任何 `data/reports.json`、`data/medbrief.db`（真实库）、`data/intake/`；也不得先在服务器上跑 `tools/bootstrap-accounts.mjs --apply`（那需要真实管理员手机号，属于数据期动作；骨架期用无用户的锁死状态即可）。

---

## 四、复跑命令清单（本轮实测，可复核）

```bash
cd /Users/scallion/Documents/projects/MedBrief

# 缺口① 可移植 lock（期望 0）
grep -c '"link": true' package-lock.json
grep -n 'playwright' package-lock.json | grep resolved

# 缺口② vendor 依赖树是否在库（期望只有 package.json / package-lock.json）
git ls-files vendor
sed -n '1,3p' .gitignore            # node_modules（覆盖 vendor/node_modules）
sed -n '3,5p' lib/auth.mjs          # iron-session 9.1.0 来自 vendor/

# 缺口③ 凭证现状
cat .deploy-commit
git log --oneline -3
grep -n "SERVER_GIT\|commitSource\|dirtyCount" server.mjs | head -8

# P1-② Secure cookie 已支持 vs 计划口径
grep -rn "MB_COOKIE_SECURE" lib/*.mjs
grep -n "Secure cookie\|会话加固" .agents/deploy-1117-plan.md
grep -rn "X-Forwarded-Proto" server.mjs lib/*.mjs | wc -l   # 期望 0

# P1-① 骨架/数据拆分是否入计划（期望 0 命中 ⇒ 只在聊天里）
grep -n "骨架\|数据上线\|空库" .agents/deploy-1117-plan.md

# 攻击5(b) 开放注册是否存在（期望仅 admin 守卫路由）
grep -n "accounts.createUser" server.mjs lib/*.mjs tools/*.mjs

# 攻击3 上线后（在服务器执行，需 systemd 已起）
pid=$(systemctl show medbrief -p MainPID --value)
tr '\0' '\n' < /proc/$pid/environ | grep -E '^(GUAHO_BROWSER|PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD|MEDBRIEF_BIND)='
pgrep -fa 'ms-playwright|headless_shell|chrome-linux' | wc -l
grep -c -E 'ms-playwright|headless_shell|chrome-linux' /proc/$pid/maps
curl -s localhost:5174/api/guahao/monitor/realtime | head -c 200
curl -s -XPOST localhost:5174/api/guahao/114/flow/start | head -c 200
```

---

## 五、给作者的整改清单（进阶段 2 前折进计划正文）

| 级别 | 项 | 落点 | 修法 |
|---|---|---|---|
| **P1-①** | 骨架/数据上线拆分未入计划 | 新增「阶段 2 前置：骨架上线」小节 | 写清两阶段、各自验收、上表六个防动作、以及顺序改为「6b①② → 骨架 → 6b③④ + 数据」 |
| **P1-②** | 计划把已实现的 Secure cookie 写成"未实现" | `:7`、`:53`(A9)、`:73`(B5)、`:109`(D0-5④)、`:124` | 改为「Secure cookie 已由 `MB_COOKIE_SECURE=1` 支持（`lib/auth.mjs:57`）；XFP 与首登改密仍零命中未实现」；阶段 2 环境变量加 `MB_COOKIE_SECURE=1`；`:131` 删「反代须转发 XFP 配合 Secure cookie」 |
| **P1-③** | 审计链只钉 commit id | `.deploy-commit` + 阶段 1.4/4.10 | 增 `fileHashes`（server.mjs / lib/auth.mjs / dist-next/index.html / vendor/package.json）与 `dirtyFiles`；服务器 `sha256sum -c` 验；附加断言「dirtyFiles 里的文件不得出现在部署包内」 |
| P2-① | 阶段 1 的三条断言缺"失败处理" | `:116`/`:117`/`:120` | 补「任一失败 → 停阶段 1，包作废重打，不进阶段 2」 |
| P2-② | systemd 硬化缺项 | `:129` | 补 `NoNewPrivileges/ProtectSystem=strict/ProtectHome/PrivateTmp/ReadWritePaths/RestrictAddressFamilies/IPAddressDeny=any/IPAddressAllow=localhost`；**明确不设 `PrivateNetwork=`**（会断反代） |

---

**结论重申**：缺口①②③ **不推翻** r5 的 `可以开工`（已成可复跑断言）；本轮**无新 P0**。三条 P1 属"计划正文未跟上执行期事实"，折进正文即可，不需再开一轮；但**在它们落地前，不要开始阶段 2**——尤其 P1-① （骨架上线的六个防动作）与 P1-② （Secure cookie 漏配 = 骨架期就可能明文票据）。
