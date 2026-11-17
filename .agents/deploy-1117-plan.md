# MedBrief 生产部署计划 —— 排雷与取舍 v0.5e（阶段 1 已验证通过）

> 触发（用户原话，2026-11-17 10:34）：「完成以上任务之后，设计一个部署计划。服务器直接无密连接 ssh ubuntu@62.234.146.222」。
> 状态：**阶段 1 已在服务器实测通过**（Node v22.20.0/`node:sqlite`/`npm ci`+`cd vendor && npm ci`/投递 sha256 双端一致/`GET /` 与 assets 200/`bind=127.0.0.1`/`commitSource=env`）。**审核门 ✅／G6 ✅／拍板 ✅** 三门齐。阶段 2 硬闸（凭据轮换三选）与阶段 3 建站（DNS A 记录）待用户。
> 版本 v0.5e：落 r6 两条 P1——**事实订正：Secure cookie 已实现**（`auth.mjs:57` `MB_COOKIE_SECURE=1`，运维已启用），零命中只剩 XFP/首登改密/口令策略；拍板 #10 措辞相应更正；6b 改"骨架/数据拆分"（①② 运维已完成→骨架上线→③ 轮换留数据前→数据上线）+ 六防点；阶段 4 加 `/opt/ops/verify-medbrief.sh` 8 项验收唯一入口。
> 版本 v0.5d：按运维新事实订正——可移植 lock **已真提交 `c28a2aa`**（HEAD `8488494`，`link:true`=0、`../MedData`=0、工作树 clean；我先前报"没提交"是过期快照，认错）；`.deploy-commit` 现钉实际部署 HEAD `8488494`（distSha256 `757631a7…` 自 `83d1b99` 未变）；阶段 1 已验证项标绿。**教训：凡断言 HEAD/lock 状态，以 `git log -1`/`git show HEAD:<file>` 即时输出为准，不用几分钟前快照（本轮我自己栽过）。**
> 版本 v0.5c：补运维阶段 1 实测 3 缺口（vendor/ npm ci、可移植 lock 判据、.deploy-commit 一致+dirty 口径）。v0.5b 归档 10 拍板；v0.5a 折进 r5 的 2 P1+4 P2。
> 版本 v0.5：吸收 **r4 实测型审核（代诊-挂号）5 P0**（`.agents/deploy-1117-review-r4.md`，186 行）：P0-1 前端产物构建机投递、P0-3 data/ 白名单、P0-4 CWD 隔离订正、P0-5 入侵史主机前置、P0-2 运维误报纠正（8090 白名单效应，非漏洞）；+ 3 修正（GUAHO_BROWSER 可跳过 Chromium、MemoryMax 统一 768M、MEDBRIEF_COMMIT 三方比对）。v0.4 吸收 r1~r3；v0.3 及以前见历史。
> **审核方式（用户 2026-11-17 口径：必须走 AI Studio 工具）**：已用 `ai_scheme_review.py --session-key MedBrief/deploy-1117` 绑定 session 并拿到逻辑预审（因该端无本地/SSH 能力，经用户选"把取证材料嵌进 prompt"）。判词为**逻辑预审非独立实测**；可证伪条由实现方实测订正：openresty `NetworkMode=host`（实测）排除 P0-1 的 502 死锁；会话加固经 r6 实测订正：**Secure cookie 已实现（`lib/auth.mjs:57` `MB_COOKIE_SECURE=1` 可开、运维已在 systemd 启用）；零命中的只有 XFP/首登改密/口令策略** ⇒ P0-4 部分成立（见 A9/B5/v0.5e）。
> 作者：代诊-Manager。代码/测试 HEAD：本地 `4aae991`（部署文档）；账号线最终代码态 `6c3e424`（5174 实际加载，主理人结案；`adbafc9`/`c55234d` 均为中间快照）。
> 定制层：**无**（§7 反查，文件头声明 0 命中）。仅通用排雷。

## 0. 取证快照（全部只读，2026-11-17 10:35 CST）

| 项 | 实测 | 命令 |
|---|---|---|
| 连通 | 无密 SSH 成功，用户 ubuntu，主机 VM-0-15-ubuntu | `ssh -o BatchMode=yes ubuntu@62.234.146.222 whoami` |
| 系统 | Ubuntu 22.04.4 LTS，x86_64，up 135 天 | `/etc/os-release` / `uname -m` |
| 资源 | **v0.5a 更新（运维回收后实测）**：磁盘 40G 用 49%（**剩 20G**）；内存 3.3G、**可用 1.9G**。原快照（剩 8.2G/可用 1.0G）已过期 | `df -h /` / `free -h`（2026-11-17 14:0x 复核） |
| **Node** | **`node: command not found`、`npm: command not found`、无 nvm、无 /usr/local/bin/node** | `node -v` / `ls ~/.nvm` |
| 端口 | 80/443（openresty 容器占用）、3306/6379/9200、3000/9002/9004/9007/9008/9009/8090 均在听；**5174/8011/8008/8045 全空闲** | `ss -tlnp` |
| 容器 | 1Panel-openresty-p1ke、mysql8.4、redis8.6、elasticsearch9.4、new-api、xxl-job、shanhai 等 8 个容器在跑 | `docker ps` |
| 反代 | 1Panel 管理 openresty，`/opt/1panel/www/sites` 是站点目录；当前无本站站点 | `find /opt/1panel` |
| 防火墙 | iptables INPUT 默认 DROP；YJ-FIREWALL-INPUT 有 SSH 黑名单链（多条 REJECT）；80/443/22 已放行 | `iptables -S` |
| 其他服务 | systemd 只有 ssh 活跃；**无 nginx/systemd node 服务** | `systemctl list-units` |
| 项目形态 | `npm start` = `node server.mjs`；依赖仅 playwright；**无 Dockerfile / docker-compose / .env 样例**；数据目录 221M | `package.json` / `du -sh data` |
| **外部依赖（最大雷）** | 运行强依赖**本机** 8008（OCR `/api/ocr-vision`）、8011（MedRecognition `/v1/extract`）、8045（视觉 `/v1/messages`）；服务器一个都没有 | `server.mjs:1708/1661`、`lib/captchaSolver.mjs:14` |

---

## A. 反向排雷（现状 → 方案前提）

**A1 需求前提（"能不能直接部署"）——不成立，有硬缺口。**
用户给的是"无密 SSH + 设计部署计划"，但服务器**无 Node**、**无 MedBrief 依赖的三个本地识别服务（8008/8011/8045）**、数据目录要迁 221M。照"把本地 node server.mjs 搬上去"实现，服务起不来或起来了识别全废。⇒ 部署计划的第一件事是**补齐前提**，不是 rsync。

**A2 部署形态（80/443 被占 + 1Panel 管理）——不能裸启。**
80/443 由 `1Panel-openresty-p1ke` 容器占用；iptables INPUT 默认 DROP（**当前规则是否仍如此须按阶段 3.9 复测，不从本条快照下结论**）。**唯一安全形态**：Node 只监听 127.0.0.1:5174 → 1Panel 建站点 + 反向代理 `/` → `http://127.0.0.1:5174`，由 openresty termination 443/证书；绝不 `node server.mjs -p 80`、绝不改 openresty 的全局 conf（1Panel 重启会覆盖）。

**A3 资源前提——内存是硬约束。**
**v0.5a 更新**：可用内存现为 **1.9G**（运维回收后实测，原 1.0G 过期），磁盘剩 20G。MedBrief 要跑 Node + 三个识别服务（OCR 视觉模型往往几百 MB~数 G）。**只读版在 1.9G 下明显更安全**（进程 RSS 实测 35.2MB）；全功能版叠加三识别服务仍可能 OOM——能否部署取决于 8008/8011/8045 占用 `[未取证]`，是 #1 拍板前要补的一测。

**A4 真值来源（R8）——部署配置无权威来源。**
项目里没有 Dockerfile/compose/.env 样例/systemd unit，端口、数据路径、识别后端全是本地默认（5174/8011/legacy）。"生产该怎么配"没有合同；本计划给的是**候选默认**，任何端口/域名/数据路径都要用户拍板，不许从本地 `nohup node server.mjs` 直接外推成生产配置。

**A5 数据与隐私——真库不能裸传。**
`data/` 221M 含 98 份报告原件、病友档案（姓名未脱敏默认）、`medbrief.db`（blobs 82MB）。服务器上已有 MySQL/Redis/ES 是别的业务的，不能混用。传输必须走加密通道、落盘权限收紧；且档案是"给药师/医生看"的敏感数据，**公网暴露必须带认证**（项目账号线 `18726ae` 已落地 auth，但 `MEDBRIEF_AUTH` 开关默认? 需确认生产必须 on）。

**A6 外部依赖拓扑——本计划最大的不确定性。**
MedBrief 本地开发时 `MEDREC_BACKEND=8011` 由 launchd 守护 `com.user.medrecognition.api`，OCR 8008、视觉 8045 也是本机服务。**这三个是独立项目，不在本仓库**。服务器部署必须回答：它们分别怎么装/怎么起/是否同机/是否 GPU？本计划只能给出"三条集成路线 + 触发条件"，不能假装它们随 MedBrief 一起部署。

**A7【v0.2 新增，审核 r1 P0】Node 进程硬编码绑 `0.0.0.0`，配置改不了。** `server.mjs:2050` `server.listen(PORT, '0.0.0.0', ...)`，无 bind 开关 ⇒ 计划"只绑 127.0.0.1"靠配置做不到。iptables `INPUT DROP` 挡外部直连（实测），但同机 8 个 Docker 容器走 `172.18.0.0/16` 网桥**可绕过 INPUT 链**直达 5174。**改法（一行）**：`const HOST = process.env.MEDBRIEF_BIND || '0.0.0.0'`，`server.listen(PORT, HOST, ...)`；生产 `MEDBRIEF_BIND=127.0.0.1`；验收 `ss -tlnp | grep 5174` 必须是 `127.0.0.1:5174`。

**A8【v0.2 新增，审核 r1 P0】依赖与 lock 缺失，生产不可复现。** `server.mjs:39` 顶层 `import { chromium } from 'playwright'`（在 `dependencies`）⇒ 不装就 `ERR_MODULE_NOT_FOUND`；仓库**无 package-lock.json**（实测）⇒ `npm ci` 报错、`npm install` 把 `^1.50.0` 解到最新 ⇒ 不可复现。阶段 0 必须**生成并提交 lock**、`npm ci` 装全依赖（含 playwright，不能省）。

**A9【v0.2 新增，审核 r1 P0；v0.4 口径统一】公网真实病历只靠 auth on 不够。** `data/` 221M、98 份 `patientName` 未脱敏（`mask=1` **只在打印渲染时**脱敏，**API 原始 JSON 不脱敏**）。**已证实的底座**：HTTPS（依赖 C7）+ `MEDBRIEF_AUTH=on` + 强 SECRET + API 不脱敏的事实写进文档。**会话加固现状（r6 实测订正）**：① **Secure cookie 已实现且已启用**——`lib/auth.mjs:57` `MB_COOKIE_SECURE=1` 即在 Set-Cookie 加 `Secure`（运维已在 systemd 设 1）；② **X-Forwarded-Proto / 首登改密 / 口令策略仍零命中未实现**；③ 拍板 #10 相应改为"已启用 Secure cookie；剩余三项书面接受或归账号线补"（见归档 #10）。**来源限制/VPN 是叠加选项（拍板 #6），不是"至少必须有"**（原"A9 至少来源限制/VPN+首登改密"口径已废，与拍板 #6 统一）。

**A10【v0.2，审核 r1】资源/站点补证**：Swap 4.0G **已用 2.3G**；只读版 RSS 实测 35.2MB（r4）⇒ 可行，systemd 加 `MemoryHigh=384M`/`MemoryMax=768M`；现存 3 站点避开；`sudo -n` 免密 ⇒ 脚本等于 root；4 核；openresty WAF + `client_max_body_size 50m` 已设。运维另盘出约 8G 可回收资源（nacos 死数据 5.1G/Docker 缓存 2G/ES+xxl-job），若用户点头 #4 可就地满足——**独立审批，不并入 MedBrief**。

**A11【v0.5，r4 P0】前端产物在部署路径上不可得。** `git ls-files web/dist-next`=0、`.gitignore:10` 忽略；`package.json.dependencies` 只有 playwright，vite/react/antd 在 `medbriefFrontendDeps`（注释"不参与 npm install"）、根 `node_modules` 软链 ⇒ 服务器 `npm ci` 后无 vite、无产物，`server.mjs:1991` 只从 `__dirname/web/dist-next` 取静态 ⇒ **上线空白页**。正解：构建机产出 dist-next + sha256 随投递（阶段 1.3/1.4、D0-5⑦）。

**A12【v0.5，r4 P0】主机有入侵史，安全论证的"可信主机"前提不成立。** ES 曾被 Meow 擦库留勒索索引 `recover_your_database`；运维已完成 ufw 13 条删除、new-api/bot 清库、ES 下线留证、备份 cron 等；**全机凭据轮转 + 持久化排查未完成前，不得把 221M 未脱敏病历投上去**（P0-5，阶段 2 硬闸 6b）。

---

## B. 正向排雷（方案 → 现有生产消费方）

**B1 破坏性动作。** rsync `data/` 到服务器可能覆盖同名文件；必须用 `--dry-run` 先演、目标目录空目录起步、`--checksum` 后核对。禁止 `rm -rf` 服务器上任何现有目录（1Panel/MySQL/ES 都在跑）。

**B2 端口冲突。** 5174/8011/8008/8045 服务器上当前空闲（已实测），但 3000/9007 等被占——**端口规划必须避开已占用表**，且 Node 只绑 127.0.0.1，不绑 0.0.0.0。

**B3 反代覆盖。** 1Panel 管理的 openresty 配置会被面板重建覆盖；**只在 1Panel 站点层建反代，不改 `/opt/1panel/apps/openresty/...` 裸配置**。

**B4 证书与域名。** 80/443 已有 openresty 在 termination，本站必须用独立域名/子域 + 证书，不能抢现有站点的 server_name；域名/DNS 由用户提供（当前未知）。

**B5 认证开后门风险 —— v0.2 更新：必修已闭环，剩的是部署侧配置。** 账号线 `!AUTH_ENABLED` 无鉴权后门、恒真式 `(AUTH_ENABLED||!AUTH_ENABLED)` 已被主理人两轮打回修复（`395156d`/`adbafc9`/`6c3e424`；实测 `grep -c 'AUTH_ENABLED || !AUTH_ENABLED'`=0、`MEDBRIEF_AUTH=off` 下 GET/POST admin/users 均 503、`verify-auth` 43/0）。代码侧 `MEDBRIEF_AUTH` 默认 on（`:263` `!== 'off'`）、缺 `MB_SESSION_SECRET` 或任段 <32 字符 `exit(1)`（`:88-92`）。**部署侧底座（已证实可做）**：`MEDBRIEF_AUTH=on` + 强 SECRET（生成/存放/轮转有规程）。**会话加固（r6 订正）**：`Secure` cookie **已实现且已启用**（`MB_COOKIE_SECURE=1`，`auth.mjs:57`）；`X-Forwarded-Proto`/首登改密仍零命中未实现。拍板 #10 按新事实归档（Secure 已开、余项书面接受）。反代层可免费补 HTTP 80→443 的 301 强制跳转（降低明文传输概率），但不冒充会话加固。

**B6 测试污染。** 部署验收用副本库 + 非生产端口；**绝不拿生产库跑测试**；健康检查用 `/api/health`，不写库。

**B7 部署态/重启纪律。** 主理人明确：服务器 5174 现在对 Project-Console 是 external，**下次重启走面板**，不裸杀进程（他刚误杀过一次生产实例）。本计划所有"重启/切流"步骤必须写成"在 1Panel 面板停/启"或 systemd（若采用），操作的原子性和回滚点要写清。

**B8 治理资产 —— v0.2 更新。** 部署清单必须钉"部署的是哪个 commit"，不能部署工作树。账号线最终代码态 `6c3e424`（主理人结案、5174 实际加载），本地部署文档 HEAD `4aae991`；两份都已提交，**没有别人的在途混进**（账号线 4 路径 status 空已实测）。剩余 dirty 属其他线（资料卡分层、grid-narrow、录入去重），**部署前逐一点名归属、不替它们背书**。用户说的"完成以上任务之后"=阶段 0 D0-2~4（Bug12/A-数据层、A-渲染层、B 线附页）也须闭环或显式裁剪（见 D 段）。

**B9 SSH 暴露面。** SSH 有 YJ-FIREWALL 黑名单链（多条 IP REJECT），说明有暴力破解防护；部署脚本不得放宽 22 端口，不得把 5174/8011 暴露到 0.0.0.0。

---

## C. 逐项必要性（先砍再排期）

| 候选 | 不做会怎样 | 代价 | 收益 | 更便宜等价 | 结论 |
|---|---|---|---|---|---|
| C1 服务器装 Node（nodeenv/nvm，固定版本） | `npm start` 无法运行 | 低 | 解 A2 前提 | 无 | **留（MVP 必做）** |
| C2 三识别服务（8008/8011/8045）上云 | 上传/识别全废，卡死在 OCR | **高**（资源+部署+GPU未知） | 核心功能 | 若只部署"卡面查看/报告库只读"可暂不接 OCR？——需用户定 | **延后+触发条件**：用户确认是否必须先全功能；若否，先上只读版 |
| C3 1Panel 站点 + 反代 127.0.0.1:5174 + 证书 | 公网无法安全访问 | 中 | 解 A2/B3/B4 | 无 | **留（MVP）** |
| C4 data/ 221M 加密传输 + 权限收紧 + 备份 | 数据丢失/泄露 | 中 | 解 A5 | 无 | **留（MVP）** |
| C5 systemd unit（或 1Panel 托管）管 node 进程 | 进程崩了没人拉起 | 低 | 可运维 | 用 1Panel 的"进程守护"若可用 | **留（形态待定）** |
| C6 认证强制 on + SECRET + B5 必修闭环 | 公网裸奔/好友情提示 | 低（配置+等账号线修） | 解 B5 | 无 | **留（MVP，硬门）** |
| C7 域名/DNS | 无域名就没有 HTTPS/证书，病历明文公网不可接受 | 低（需用户加解析） | B4/A9 | IP+自签不安全 | **前置（用户已定 2026-11-17）**：用**新子域名 `medbrief.shanhailingjing.top`**（不碰现存生产站点 `admin.shanhailingjing.top`，实测它是活着的另一系统后台：HTTPS 200/独立证书/有外部访问）。用户加 A 记录指向 62.234.146.222 → 1Panel 建独立站点+公信证书。 |
| C8 监控/日志/告警 | 崩了不知道 | 中 | 可观测 | 1Panel 自带日志页 | **延后（触发：上线后观测到异常）** |
| C9 多机/负载均衡 | 单机够用 | 高 | 无 | 无 | **砍**（当前规模无意义） |
| C10 数据库从 data/reports.json 迁到 MySQL | 无此需求 | 高 | 与现有 MySQL 无关 | 保持文件库 | **砍**（数据形状/查重键全基于文件库，迁移是另一条线） |

---

## D. 简化后的方案（只列留下的项）+ 延后触发条件

**阶段 0 — 前置闭环（全部"改代码"的动作都收口在此，commit 在此钉死——AI 审核 P0-2）：**
- D0-1 ~~账号线 admin/users 三条必修闭环 + 四文件同批提交~~ **✅ 已闭环（v0.1a）**：`395156d`/`2b32096`/`adbafc9`/`6c3e424`（账号线最终态）；实测恒真式消除、auth=off 下 admin 接口 503、verify-auth 43/0、verify-card-inject 12/0、verify-card 62/0，5174 加载 `6c3e424` auth=on。归「代诊-账号」，已入库。
- D0-2 Bug12 `criticalOf` 假危急修（A-数据层，等用户「按以上计划执行」）。
- D0-3 模块① 6 格分层证据区（A-渲染层，等 UI v2 + 用户授权）。
- D0-4 打印附页 B 线（等用户授权）。
- D0-5 **部署前置代码改动（原误放阶段 1，现收回）**：① 生成并提交 `package-lock.json`（无 lock 不可复现）；② `server.mjs:2050` 加 `MEDBRIEF_BIND` 开关（否则绑不了 127.0.0.1）；③ 只读版若采用，关上传/识别入口（需 UI 规格，**归口到"待拍板"清单**）；④ **会话加固（r6 订正）**：`Secure cookie` **已实现**（`MB_COOKIE_SECURE=1`，`auth.mjs:57`，运维已启用），无需补；仅 `X-Forwarded-Proto`/首登改密/口令策略零命中未实现——归账号线补或书面接受（拍板 #10 已按新事实归档）；⑤ 全部 `verify-*` 在此复测（副本库）；⑥ **`/api/health.head` 版本回显 + 比对（r4 攻击3 / r5 P1-1 修正）**：当前 head 取 git HEAD，**服务器不带 `.git`（投递不含）⇒ 第三腿 `git rev-parse` 在服务器上取不到**。正确分工：① **构建机**（有 .git）在打包时写 `.deploy-commit`（commit+产物tar sha256+时间+执行者，600）；② health 增 `commitSource:'git'|'env'`，`MEDBRIEF_COMMIT` env 仅无 .git 时回退、不作唯一真相；③ **验收 = 在构建机核 `.deploy-commit` 的 commit == 构建机 `git rev-parse`**（第三腿在构建机做），**服务器上只做 health.head == `.deploy-commit` 两方比对 + 看 commitSource**，不再要求在服务器跑 git rev-parse。⑦ **构建机产出 dist-next**（P0-1）：本地 `npm run build:web` + 算 sha256 随投递，服务器不构建。①③ 卡拍板(#1/#9/#10)，**①②⑥⑦ 不卡拍板、G6 授权后即可做**（②⑥改 server.mjs、⑦本地构建，均单写者）。⑤ 复测范围随 #8 裁剪决定。**单写者、显式 pathspec commit，不 git add -A。**
- **只有 D0-1~5 闭环（或用户显式写"本版裁剪 D0-2~4"并同步收窄验收）+ 部署 commit 钉死，才进入阶段 1。** "可降 D0 优先级"的开后门句已删；降级范围作为带范围选项进"需用户拍板"，降级则验收同步收窄。

**阶段 1 — 环境与前提（纯环境/投递，不再改仓库代码）：**
1. 装固定版本 Node（**必须 ≥22.5**：`lib/blobStore.mjs` 用 `node:sqlite` 的 `DatabaseSync`；apt 旧版不行 ⇒ NodeSource/nvm，记录版本）。
2. 建部署目录（如 `/opt/medbrief`，用户定），权限 750，owner ubuntu。
3. 依赖安装（**v0.5c 运维阶段 1 实测修正，三件缺一即上线失败**）：
   - **根 `npm ci`**：用阶段 0 的可移植 lock。判据：`grep -c '"link": true' package-lock.json` = **0**，且 `resolved` 全为 `https://...`（旧 lock 含 `"../MedData/.../playwright", "link":true` 软链 → 服务器 `npm ci` 断链、`Cannot find package 'playwright'`）。装 playwright 包本体、只读版 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 不装 Chromium。
   - **`cd vendor && npm ci`（缺口1，P0）**：`lib/auth.mjs:3` 依赖 vendored `iron-session 9.1.0`，`vendor/node_modules` 被 `.gitignore:1` 忽略、仓库只有 `vendor/package.json`+lock ⇒ 不执行即启动 `ERR_MODULE_NOT_FOUND`。
   - **前端产物（r4 P0-1）**：`web/dist-next/` 被 gitignore、`package.json.dependencies` 只有 playwright、vite/react/antd 在 `medbriefFrontendDeps`（不参与 npm install）⇒ 服务器装不出前端。**构建机（本地）跑 `npm run build:web` 产出 dist-next + 整目录 sha256 随投递**，服务器只接收不构建。
   - **chromium（r4 修正）**：只读版设 **`GUAHO_BROWSER=off`**（开关 `server.mjs:127-141`，守卫实为 6 处 `:564/:596/:612/:633/:862/:972`），两处 `chromium.launch`（`:983` 挂号 / `lib/bjcyhScraper.js:31` 出诊监控）全短路 ⇒ `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 完全不装 Chromium。
4. rsync 投递阶段 0 钉死的 commit 产物 + **构建机的 `web/dist-next`（含 sha256）**，不含工作树在途项。**版本凭证（缺口3）**：`.deploy-commit` 的 `commit` 必须 == **实际部署的 commit**（判据 `python3 -c "import json;print(json.load(open('.deploy-commit'))['commit'])"`）；`dirty` 口径写清——只允许别线在 `lib/`/`.agents/` 的改动，**`web/` 与 `server.mjs` 必须干净**；构建机写 `.deploy-commit`（有 .git），服务器只两方比对 + commitSource（见 D0-5⑥）。**运维阶段 1 实测已过**：Node v22.20.0、`node:sqlite` OK、`/opt/medbrief` 750、包 sha256 双端一致、`GET /` 与 `/assets/index-CXQ0PPDQ.js` 均 200、`ss` 见 `127.0.0.1:5199`（bind 生效）、health 初次冒烟 `head=83d1b99 commitSource=env`（无 .git），**后续 .deploy-commit 已对齐当前部署 HEAD `8488494`**（distSha256 `757631a7…` 自 `83d1b99` 未变）——即 `.deploy-commit` 钉的是**部署时的实际 HEAD**，不是固定某个号。

**阶段 2 — 数据与配置：**
5. **data/ 白名单投递（P0-3，禁止整目录 rsync）**：只传必要文件——`data/reports.json` + `data/medbrief.db`(blobs) + `data/intake/**`(病友档案)（`data/gt**` 实测不存在，已从白名单删）；**明确排除** `114-auth.json`(114票据/cookie)、`data/tmp`(48M)、`data/backups`(46M)、`data/114-flow`(2.1M)、`data/meddata-mirror`、`*.log`。先 `--dry-run` + `--checksum`，目标目录 700 / 文件 600。
6. 环境变量：`PORT=5174`、**`MEDBRIEF_BIND=127.0.0.1`**、**`GUAHO_BROWSER=off`**(只读版必设，否则出诊监控 tab 会触发第二处 chromium)、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`(只读版)、`MEDBRIEF_AUTH=on`、`MB_SESSION_SECRET=<强随机>`、**`MB_COOKIE_SECURE=1`**（Secure cookie 已实现启用）、`MEDREC_BACKEND=legacy`(只读版)；**SECRET 不进代码库**。**不写会话加固为"已配"**——代码未实现，见 D0-5④/拍板 #10。
6b. **P0-5 入侵史主机前置 + r6 骨架/数据拆分（新顺序：①②→骨架上线→③→数据上线）**：该机 ES 曾被 Meow 擦库留勒索信 `recover_your_database`。
   - **骨架上线前（①②，运维已完成，2026-11-17）**：规则/暴露面全量留档(`/root/ir/`：ufw status numbered、iptables-save、docker ps -a、ss -tlnp、ip a)；持久化排查(全体 authorized_keys/crontab/陌生 unit/异常镜像/SUID/**`/tmp` 可执行文件已清零**，`app-server` 已 systemd 托管于 `/opt/shanhai/bin`，`app-search` 收编留回滚源后删除，9007 仍 200)；**⇒ 骨架上线前置已满足**。
   - **骨架上线（空库）**：可先起服务/反代验链路，**骨架期禁一切真实数据**。`lib/intakeCard.js:28` 首启仍会建 `data/`+`medbrief.db` ⇒ 记下其 sha256，数据期用白名单版覆盖或先删空壳。无开放注册 ⇒ 不会被抢注。`MB_COOKIE_SECURE=1`（Secure cookie 已启用，见拍板 #10）。
   - **数据上线前（③）**：**全机凭据轮转**(MySQL root 923229904 兼 Redis 口令、明文在 4 处；SSH/1Panel/容器 env tokens) + **轮转 `MB_SESSION_SECRET`**；待用户对"凭据轮换三选"落字。④ 数据最小化白名单(见 5)+ 若 #3 原样上生产则传输加密(gpg/gocryptfs)。
   - **唯一待用户定**：`/root/.ssh/authorized_keys` 里 `root@VM-66-189-ubuntu`(2026-06-05 建、从未登录)是否自己的机器，非则删。**①② 已完成、③ 未落字前只上骨架不投数据。**
6c. 备份：上传前对生产目标目录打 tar.gz 快照；记录回滚点。

**阶段 3 — 进程与反代：**
7. **进程守护（阶段 3 第 0 步先核实，P1-B）**：SSH 只读核 1Panel 是否具备 Node 进程托管+env 注入能力 → 能则用面板；**不能则默认 systemd unit**（附模板：`WorkingDirectory=<部署目录>`、`MemoryHigh=384M`+**`MemoryMax=768M`**、`Environment=MEDBRIEF_BIND=127.0.0.1`/`GUAHO_BROWSER=off`/`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`、`Restart=on-failure`），并把 `systemctl status medbrief` 作为回滚判据。**MemoryMax 统一 768M**（r4：删掉计划各处的 512M，与审核入口径一致；只读版进程 RSS 实测 35.2MB，余量充足；阶段 4 用服务器 `MemoryCurrent` 实测再调）。
7b. **反代连通性已实测（订正 AI 审核 P0-1）**：`1Panel-openresty-p1ke` 的 `NetworkMode=host`（`docker inspect` 实测）⇒ 容器内 `127.0.0.1` 即宿主机 loopback，反代 `http://127.0.0.1:5174` **不会 502**；无网桥死锁。仍以 `ss -tlnp` 断 bind 生效为准。
8. **C7 分支（用户已定）**：新子域名 **`medbrief.shanhailingjing.top`**——用户加 A 记录指向 `62.234.146.222` → 1Panel 建**独立站点** + 反代 `http://127.0.0.1:5174` + 公信证书（Let's Encrypt）。**绝不覆盖现存 `admin.shanhailingjing.top`**。补（P1-5）：核 `*.shanhailingjing.top` 是否有通配符/AAAA/CDN 代理；ACME HTTP-01 路径 `/.well-known/acme-challenge/` 须避开反代/不被 WAF 拦；**medbrief 证书独立于 admin 证书**；反代须转发 `X-Forwarded-Proto https`（配合 Secure cookie，代码侧若实现——见 D0-5④）。若解析/证书失败 → 不上公网。
9. **暴露面三段式断言（P0-2，替换原 `ss` 单点检查）**：① `sudo ufw status numbered` + `sudo iptables-save` + `ss -tlnp` 全量留档，规则除 22/80/443 与面板 IP 白名单外**不得有对公 ACCEPT**；② **从非白名单来源逐端口实测**（IP 直连 + `curl --noproxy '*'`，最好第三方主机；本机 DNS 是 fake-IP，`dig admin...`→198.18.x.x 会污染域名探测，一律 IP 直连）；③ **任一非白名单端口可达即停线**，不进阶段 4。**P0-2 判词纠错**：审核者测 `http://62.234.146.222:8090/`→200 判"未收紧"，实为白名单效应——ufw 8090 只 ALLOW 两个运营 IP（含审核者出口），我从非白名单实测该端口 `000` 连不上；判定以"非白名单来源"复测为准。5174 bind 仍以 `ss -tlnp` 验 `127.0.0.1`。
9b. 权限面：`sudo -n` 免密可用 ⇒ 部署脚本等于 root，脚本与 SECRET 文件权限 600、只许 ubuntu 读写，审计留痕。

**阶段 4 — 验收与回滚：**
10. **只读冒烟（不写生产库）**：`curl https://medbrief.shanhailingjing.top/api/health` → `ok:true, auth:on`；**版本比对（r5 P1-1 修正）**：服务器不带 `.git`，**构建机**核 `.deploy-commit`.commit == `git rev-parse`（第三腿在构建机）；**服务器**只核 health.head == `.deploy-commit`.commit（两方）+ `commitSource`（`git|env`），env 仅回退不作唯一真相；任一不符即停。登录页可达、只读端点（报告列表/资料卡）确认出卡与打印预览；**assets 200 验收（P0-1）**：`curl -I https://.../assets/index-*.js` → 200（验证构建机 dist-next 已投递，非空白页）。**不在生产建报告/导入**；写类操作只在 11 的副本库验。
10b. **只读版入口断言（含 GUAHO_BROWSER）**：若只读版，断 ① 上传/识别入口不可点或返回"未启用"；② `curl /api/guahao/monitor/realtime` → `disabled:true, code:BROWSER_DISABLED`；③ **反向断言** `POST /api/guahao/114/flow/start` → **503 `BROWSER_DISABLED`**（r5：守卫实际 **6 处** `:564/:596/:612/:633/:862/:972`，计划原只写 3 处，补反向断言覆盖写路径）；不以全功能清单量它。
11. 门禁：服务器上 `node tests/verify-card.mjs`(62/0)、`verify-card-module1`(9/0)、`verify-auth`(43/0)——**隔离事实订正（P0-4，删"CWD切/tmp可百分百杜绝"的错误说法）**：`server.mjs:115` `DATA_DIR=path.join(__dirname,'data')` **不可 env 覆盖**、`:242` `REPORTS_FILE` 默认 `__dirname`；CWD 只影响 `lib/intakeCard.js:28`/`recognitionHits.mjs:19`。**真实隔离 = `MEDBRIEF_REPORTS_FILE` 指副本库 + `MEDBRIEF_DATA_DIR` 指临时副本 + 独立端口**，并**断言实际路径**（health 或日志确认读取的是副本而非生产 data/）；CWD 切 /tmp 仅作附加、不作保证。只读版降级时验收同步收窄。
12. **暴露面/数据断言**：API 原始 JSON **不脱敏**（`mask=1` 只在打印渲染），确认生产经 HTTPS + auth；`ss` 断 5174 仅本地绑。**会话加固（r6 订正）**：`Secure cookie` **已启用**（`MB_COOKIE_SECURE=1`）；XFP/首登改密未实现——按归档拍板 #10 书面接受或归账号线补，不假称已做。
13. **只读版验收唯一入口（r6 攻击3/4，运维已写）**：`/opt/ops/verify-medbrief.sh`（8 项判定：environ 四开关 / 无子浏览器进程 / `/proc/<pid>/maps` 无浏览器 / `flow/start` 回 `BROWSER_DISABLED` / `data/guahao-browser.flag` 不得为 on / bind 只回环 / `health.head`==`.deploy-commit.commit` / `fileHashes` 自证），任一失败退出 1。运维临时实例实测 **7 绿 + 第 7 项按预期红**（故意塞不符 commit 被抓出，证明断言有效）；第 8 项待写工补 `.deploy-commit.fileHashes` 后启用。**以该脚本为阶段 4 只读版验收的唯一判据入口**，不再靠零散 curl。
14. 回滚点：systemd stop + 恢复上一版目录/数据快照 + 1Panel 反代指回；**每步可独立回滚**。

**延后项的触发条件：**
- C2（三识别服务上云）：触发 = 用户明确"必须全功能上线"且给出这三个服务的部署方式/资源预算（内存/swap 已紧，详见 A10）；否则先上"报告库+卡面"只读版（无需 OCR，**但须关上传/识别入口**，见阶段 1.3）。
- C8（监控告警）：触发 = 上线后 7 天内出现 ≥1 次非计划停机。

**10 项拍板已落定（2026-11-17 16:2x，用户选 A＝按运维推荐全采纳 +「按以上计划执行」；由部署执行方「运维」第一手转述，用户可随时纠正）：**
1. **范围＝只读版**（报告库+卡面+打印预览，**不含挂号/上传/识别**）；`GUAHO_BROWSER=off`，chromium 坑自动规避，验收收窄。
2. **域名＝新子域 `medbrief.shanhailingjing.top`**；⚠️ **A 记录用户尚未加**（服务器实测无解析、无通配符），卡阶段 3 建站/证书，阶段 1 不依赖 DNS 可先铺。
3. **数据＝221M 原样迁**（白名单投递，排除 114 凭据/tmp/backups）。
4. **资源＝不加内存不加机器**（已回收 20G/1.9G）；只读版安全余量充足。
5. **托管＝systemd**（1Panel 只管站点与反代）；阶段 3 直接 systemd unit，无需再核 1Panel Node 托管。
6. **暴露面＝nginx 反代 + auth on，不叠 VPN**；SECRET 用户保管；ACME 只开 80/443。
7. **审核＝归档**（AI Studio r1–r3 + 独立实测 r4–r5，r5 终判可以开工）。
8. **裁剪 D0-2~4**（Bug12/A-数据层、A-渲染层、B 线附页本批不做），验收同步收窄。
9. **只读入口＝后端返回"未启用"**（非纯前端隐藏）；UI 规格待定、本批不做。
10. **会话加固（r6 订正）**：**Secure cookie 已启用**（`MB_COOKIE_SECURE=1`）；**XFP/首登改密/口令策略零命中未实现** ⇒ 书面接受剩余三项风险或归账号线后续补，不在部署文档假称已做。原"仅 HTTPS+auth、不做会话加固"措辞因 Secure 已实现而作废。

**三门状态：审核门 ✅（r5 可以开工）／G6 ✅（用户"按以上计划执行"，运维转述 2026-11-17 16:2x）／拍板 ✅（10 项全落定，同上）。** 阶段 0 已派单外包仔落地 D0-5①②⑥⑦。

**回退与门禁（G7）**：每阶段独立回滚点；验收命令在上；生产库零写入直到阶段 2 的备份+rsync 完成；测试用副本库。

---

## 复跑命令清单（取证可复现）

```bash
ssh -o BatchMode=yes ubuntu@62.234.146.222 'node -v; ss -tlnp; free -h; df -h /; docker ps; sudo iptables -S YJ-FIREWALL-INPUT'
cd /Users/scallion/Documents/projects/MedBrief && node -e "const p=require('./package.json');console.log(p.scripts.start)"   # node server.mjs
grep -n "127.0.0.1:8008\|127.0.0.1:8045\|MEDREC_BACKEND\|VISION_ENDPOINT" server.mjs lib/*.mjs
```

> **审核状态（终）**：AI Studio r1→r2→r3 逻辑预审 + 独立实测「代诊-挂号」r4→r5；**r5 终判「可以开工」**（P0 全清零，判词 `.agents/deploy-1117-review-r5.md`）。r4 曾推翻 r3 的旧"可以开工"，r5 重新给绿灯。判词分通道留痕：AI Studio `review-r{1,2,3}.md`、Bot 实测 `review-r1-bot.md`、独立实测 `review-r{4,5}.md`。
> 执行状态：**三门齐**（审核 ✅／G6 ✅／拍板 ✅，2026-11-17 16:2x）——**阶段 0 已开工**：外包仔落地 D0-5①②⑥⑦，运维复核后进阶段 1。阶段 3 建站仍卡用户加 `medbrief.shanhailingjing.top` 的 A 记录（阶段 1 环境可先铺，不依赖 DNS）。运维零写入纪律保持到阶段 2 备份完成。
