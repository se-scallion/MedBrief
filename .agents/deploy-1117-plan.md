# MedBrief 生产部署计划 —— 排雷与取舍 v0.4（未执行）

> 触发（用户原话，2026-11-17 10:34）：「完成以上任务之后，设计一个部署计划。服务器直接无密连接 ssh ubuntu@62.234.146.222」。
> 状态：**只做了 SSH 只读取证，未改服务器任何东西、未部署**。用户要的是"设计计划"，不是立即部署。
> 版本 v0.4：吸收 **AI Studio r2**（2 P0：A9/B5/阶段2 正文口径未同步 + `MEDBRIEF_DATA_DIR` 隔离未取证）。P0-A 三处正文已统一为"代码未实现→补代码或书面接受风险"；P0-B **实测排除**：`MEDBRIEF_DATA_DIR` 确被 `lib/accounts.mjs:18`/`blobStore.mjs:13`/`correctionsStore.mjs:23` 读取，测试已在用（见阶段 4.11）。v0.3 吸收 r1（4P0+6P1）；v0.2 吸收 Bot 判词。
> **审核方式（用户 2026-11-17 口径：必须走 AI Studio 工具）**：已用 `ai_scheme_review.py --session-key MedBrief/deploy-1117` 绑定 session 并拿到逻辑预审（因该端无本地/SSH 能力，经用户选"把取证材料嵌进 prompt"）。判词为**逻辑预审非独立实测**；可证伪条由实现方实测订正：openresty `NetworkMode=host`（实测）排除 P0-1 的 502 死锁；Secure cookie/XFP/首登改密代码 grep 零命中 ⇒ P0-4 成立。
> 作者：代诊-Manager。代码/测试 HEAD：本地 `4aae991`（部署文档）；账号线最终代码态 `6c3e424`（5174 实际加载，主理人结案；`adbafc9`/`c55234d` 均为中间快照）。
> 定制层：**无**（§7 反查，文件头声明 0 命中）。仅通用排雷。

## 0. 取证快照（全部只读，2026-11-17 10:35 CST）

| 项 | 实测 | 命令 |
|---|---|---|
| 连通 | 无密 SSH 成功，用户 ubuntu，主机 VM-0-15-ubuntu | `ssh -o BatchMode=yes ubuntu@62.234.146.222 whoami` |
| 系统 | Ubuntu 22.04.4 LTS，x86_64，up 135 天 | `/etc/os-release` / `uname -m` |
| 资源 | 磁盘 40G 用 79%（剩 8.2G）；内存 3.3G，**可用仅 1.0G** | `df -h /` / `free -h` |
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
80/443 由 `1Panel-openresty-p1ke` 容器占用；iptables INPUT 默认 DROP，只有白名单端口能进。**唯一安全形态**：Node 只监听 127.0.0.1:5174 → 1Panel 建站点 + 反向代理 `/` → `http://127.0.0.1:5174`，由 openresty  termination 443/证书；绝不 `node server.mjs -p 80`、绝不改 openresty 的全局 conf（1Panel 重启会覆盖）。

**A3 资源前提——内存是硬约束。**
可用内存 1.0G，而 MedBrief 要跑 Node + 三个识别服务（其中 OCR 视觉模型往往吃几百 MB~数 G）。**能否部署取决于 8008/8011/8045 的资源占用**：若它们与现有 MySQL/ES（已占大头）叠加超内存，OCR 会被 OOM kill。本次未测这三个服务的内存需求（它们在本地 Mac 上跑，服务器没有）⇒ `[未取证]`，是开工前必须补的一测。

**A4 真值来源（R8）——部署配置无权威来源。**
项目里没有 Dockerfile/compose/.env 样例/systemd unit，端口、数据路径、识别后端全是本地默认（5174/8011/legacy）。"生产该怎么配"没有合同；本计划给的是**候选默认**，任何端口/域名/数据路径都要用户拍板，不许从本地 `nohup node server.mjs` 直接外推成生产配置。

**A5 数据与隐私——真库不能裸传。**
`data/` 221M 含 98 份报告原件、病友档案（姓名未脱敏默认）、`medbrief.db`（blobs 82MB）。服务器上已有 MySQL/Redis/ES 是别的业务的，不能混用。传输必须走加密通道、落盘权限收紧；且档案是"给药师/医生看"的敏感数据，**公网暴露必须带认证**（项目账号线 `18726ae` 已落地 auth，但 `MEDBRIEF_AUTH` 开关默认? 需确认生产必须 on）。

**A6 外部依赖拓扑——本计划最大的不确定性。**
MedBrief 本地开发时 `MEDREC_BACKEND=8011` 由 launchd 守护 `com.user.medrecognition.api`，OCR 8008、视觉 8045 也是本机服务。**这三个是独立项目，不在本仓库**。服务器部署必须回答：它们分别怎么装/怎么起/是否同机/是否 GPU？本计划只能给出"三条集成路线 + 触发条件"，不能假装它们随 MedBrief 一起部署。

**A7【v0.2 新增，审核 r1 P0】Node 进程硬编码绑 `0.0.0.0`，配置改不了。** `server.mjs:2050` `server.listen(PORT, '0.0.0.0', ...)`，无 bind 开关 ⇒ 计划"只绑 127.0.0.1"靠配置做不到。iptables `INPUT DROP` 挡外部直连（实测），但同机 8 个 Docker 容器走 `172.18.0.0/16` 网桥**可绕过 INPUT 链**直达 5174。**改法（一行）**：`const HOST = process.env.MEDBRIEF_BIND || '0.0.0.0'`，`server.listen(PORT, HOST, ...)`；生产 `MEDBRIEF_BIND=127.0.0.1`；验收 `ss -tlnp | grep 5174` 必须是 `127.0.0.1:5174`。

**A8【v0.2 新增，审核 r1 P0】依赖与 lock 缺失，生产不可复现。** `server.mjs:39` 顶层 `import { chromium } from 'playwright'`（在 `dependencies`）⇒ 不装就 `ERR_MODULE_NOT_FOUND`；仓库**无 package-lock.json**（实测）⇒ `npm ci` 报错、`npm install` 把 `^1.50.0` 解到最新 ⇒ 不可复现。阶段 0 必须**生成并提交 lock**、`npm ci` 装全依赖（含 playwright，不能省）。

**A9【v0.2 新增，审核 r1 P0；v0.4 口径统一】公网真实病历只靠 auth on 不够。** `data/` 221M、98 份 `patientName` 未脱敏（`mask=1` **只在打印渲染时**脱敏，**API 原始 JSON 不脱敏**）。**已证实的底座**：HTTPS（依赖 C7）+ `MEDBRIEF_AUTH=on` + 强 SECRET + API 不脱敏的事实写进文档。**会话加固（Secure cookie/X-Forwarded-Proto/首登改密/口令策略）代码 grep 零命中 ⇒ 代码未实现**，不能当"部署侧配置"假装配好——走 D0-5④ 的"补代码 or 书面接受风险"二选一（拍板 #10）。**来源限制/VPN 是叠加选项（拍板 #6），不是"至少必须有"**（原"A9 至少来源限制/VPN+首登改密"口径已废，与拍板 #6 统一）。

**A10【v0.2 新增，审核 r1】资源/站点补证**：Swap 4.0G **已用 2.3G**（已在靠 swap 撑）；只读版本地 RSS ~130MB ⇒ 只读版可行、全功能不可行，systemd 加 `MemoryMax`；现存 3 站点（`admin.shanhailingjing.top`/`www.shanhailingjing.top`/`test`，新站点避开）；`sudo -n` 免密可用 ⇒ 部署脚本等于 root，权限面要收；4 核；openresty include 1Panel WAF、`client_max_body_size 50m` 已在 http 级设好（上传不会 413）。

---

## B. 正向排雷（方案 → 现有生产消费方）

**B1 破坏性动作。** rsync `data/` 到服务器可能覆盖同名文件；必须用 `--dry-run` 先演、目标目录空目录起步、`--checksum` 后核对。禁止 `rm -rf` 服务器上任何现有目录（1Panel/MySQL/ES 都在跑）。

**B2 端口冲突。** 5174/8011/8008/8045 服务器上当前空闲（已实测），但 3000/9007 等被占——**端口规划必须避开已占用表**，且 Node 只绑 127.0.0.1，不绑 0.0.0.0。

**B3 反代覆盖。** 1Panel 管理的 openresty 配置会被面板重建覆盖；**只在 1Panel 站点层建反代，不改 `/opt/1panel/apps/openresty/...` 裸配置**。

**B4 证书与域名。** 80/443 已有 openresty 在 termination，本站必须用独立域名/子域 + 证书，不能抢现有站点的 server_name；域名/DNS 由用户提供（当前未知）。

**B5 认证开后门风险 —— v0.2 更新：必修已闭环，剩的是部署侧配置。** 账号线 `!AUTH_ENABLED` 无鉴权后门、恒真式 `(AUTH_ENABLED||!AUTH_ENABLED)` 已被主理人两轮打回修复（`395156d`/`adbafc9`/`6c3e424`；实测 `grep -c 'AUTH_ENABLED || !AUTH_ENABLED'`=0、`MEDBRIEF_AUTH=off` 下 GET/POST admin/users 均 503、`verify-auth` 43/0）。代码侧 `MEDBRIEF_AUTH` 默认 on（`:263` `!== 'off'`）、缺 `MB_SESSION_SECRET` 或任段 <32 字符 `exit(1)`（`:88-92`）。**部署侧底座（已证实可做）**：`MEDBRIEF_AUTH=on` + 强 SECRET（生成/存放/轮转有规程）。**会话加固（生产 `Secure` cookie / `X-Forwarded-Proto` / 首登改密）代码 grep 零命中、未实现**——不能写成"部署侧必须配好"；按 D0-5④ 走"账号线补代码 or 书面接受仅 HTTPS+auth 风险"（拍板 #10）。反代层可免费补 HTTP 80→443 的 301 强制跳转（降低明文传输概率），但不冒充会话加固。

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
- D0-5 **部署前置代码改动（原误放阶段 1，现收回）**：① 生成并提交 `package-lock.json`（无 lock 不可复现）；② `server.mjs:2050` 加 `MEDBRIEF_BIND` 开关（否则绑不了 127.0.0.1）；③ 只读版若采用，关上传/识别入口（需 UI 规格，**归口到"待拍板"清单**）；④ 若代码侧要支持 `Secure cookie`/`X-Forwarded-Proto`/首登改密（AI 审核 P0-4，grep 零命中 ⇒ **代码未实现**），要么归账号线补代码，要么书面接受"仅 HTTPS 传输层+auth、不做会话加固"的风险；⑤ 全部 `verify-*` 在此复测（副本库）；⑥ **`/api/health.head` 版本回显**：当前 head 取进程启动时的 git HEAD（`server.mjs:100` 附近），若投递不带 `.git` 则取不到 ⇒ 加 `MEDBRIEF_COMMIT` 环境变量注入 + 回显（**改 server.mjs 属阶段 0 代码改动、归单写者，不许阶段 3 临时冒出**）。①③ 卡拍板(#1/#9/#10)，**①②⑥ 不卡拍板、G6 授权后即可做**。⑤ 复测范围随 #8 裁剪决定。**单写者、显式 pathspec commit，不 git add -A。**
- **只有 D0-1~5 闭环（或用户显式写"本版裁剪 D0-2~4"并同步收窄验收）+ 部署 commit 钉死，才进入阶段 1。** "可降 D0 优先级"的开后门句已删；降级范围作为带范围选项进"需用户拍板"，降级则验收同步收窄。

**阶段 1 — 环境与前提（纯环境/投递，不再改仓库代码）：**
1. 装固定版本 Node（**必须 ≥22.5**：`lib/blobStore.mjs` 用 `node:sqlite` 的 `DatabaseSync`；apt 旧版不行 ⇒ NodeSource/nvm，记录版本）。
2. 建部署目录（如 `/opt/medbrief`，用户定），权限 750，owner ubuntu。
3. `npm ci`（用阶段 0 生成的 lock）装**全依赖含 playwright**（顶层 import）；`npm run build:web` 产物随代码投递。**Chromium 调用链已实测确定**：`server.mjs:983` **确实调用** `chromium.launch()` ⇒ **不能跳过浏览器下载**，必须装 Chromium 二进制 + 系统依赖（如 libnss3/libatk 等），并重估 1.0G 可用内存与 8.2G 磁盘（r3 自检 P1-A 销号）。
4. rsync 投递阶段 0 钉死的 commit 产物（不含工作树在途项）。

**阶段 2 — 数据与配置：**
5. `data/` 221M 用 rsync + ssh 加密传（先 `--dry-run`、后 `--checksum` 核对），目标目录单独放、不覆盖现有业务数据；**目录 700 / 文件 600**（P1-1：目录若设 600 无 +x 会 EACCES）。
5. 环境变量：`PORT=5174`、**`MEDBRIEF_BIND=127.0.0.1`**（配合阶段 0 D0-5 的代码改动）、`MEDBRIEF_AUTH=on`、`MB_SESSION_SECRET=<强随机>`、`MEDREC_BACKEND=8011`（若 C2 落地）或 `legacy`（只读版）；**SECRET 不进代码库**（生成/存放/轮转有规程）。**不写 `Secure cookie`/`XFP`/首登改密为"已配"**——代码未实现，见 D0-5④/拍板 #10。
6. 备份：上传前对生产目标目录打 tar.gz 快照；记录回滚点。

**阶段 3 — 进程与反代：**
7. 进程守护：systemd unit 或 1Panel 进程守护（**二选一待拍板 #5**，主理人要求"走面板"）；**必须写 `WorkingDirectory=<部署目录>`**（`path.resolve('data',…)` 相对 CWD，不设会去 `/data` 找库）；**`MemoryMax=` 给具体值**（建议 512M，只读版 RSS~130M，swap 已用 2.3G——P1-2）；`Environment=MEDBRIEF_BIND=127.0.0.1`；1Panel 是否具备 Node 进程托管能力需先核实（未取证）。
7b. **反代连通性已实测（订正 AI 审核 P0-1）**：`1Panel-openresty-p1ke` 的 `NetworkMode=host`（`docker inspect` 实测）⇒ 容器内 `127.0.0.1` 即宿主机 loopback，反代 `http://127.0.0.1:5174` **不会 502**；无网桥死锁。仍以 `ss -tlnp` 断 bind 生效为准。
8. **C7 分支（用户已定）**：新子域名 **`medbrief.shanhailingjing.top`**——用户加 A 记录指向 `62.234.146.222` → 1Panel 建**独立站点** + 反代 `http://127.0.0.1:5174` + 公信证书（Let's Encrypt）。**绝不覆盖现存 `admin.shanhailingjing.top`**。补（P1-5）：核 `*.shanhailingjing.top` 是否有通配符/AAAA/CDN 代理；ACME HTTP-01 路径 `/.well-known/acme-challenge/` 须避开反代/不被 WAF 拦；**medbrief 证书独立于 admin 证书**；反代须转发 `X-Forwarded-Proto https`（配合 Secure cookie，代码侧若实现——见 D0-5④）。若解析/证书失败 → 不上公网。
9. 防火墙/暴露面：`ss -tlnp | grep 5174` 必须是 **`127.0.0.1:5174`**（验证 A7 bind 生效）；确认 8011/8008 不对公网开放；openresty WAF 已在 include 中、`client_max_body_size 50m` 已设（上传不 413）。
9b. 权限面：`sudo -n` 免密可用 ⇒ 部署脚本等于 root，脚本与 SECRET 文件权限 600、只许 ubuntu 读写，审计留痕。

**阶段 4 — 验收与回滚：**
10. **只读冒烟（不写生产库，订正 AI 审核 P0-3）**：`curl https://medbrief.shanhailingjing.top/api/health` → `ok:true, auth:on, head=<部署commit>`（head 取不到则须部署时带 `.git` 或注入版本环境变量——P1-4）；登录页可达、用**只读端点**（报告列表/资料卡）确认出卡与打印预览渲染；**不在生产域名建报告/导入**（那会写脏数据，违反 B6/G7）。写类操作只在阶段 4.11 的副本库环境验。识别链路 8008/8011/8045 的验证同样放副本库，不写生产。
10b. **只读版入口断言**（P1-6）：若本版裁剪为只读，验收须断"上传/识别入口不可点或返回明确'未启用'"，不以全功能清单量它。
11. 门禁：服务器上 `node tests/verify-card.mjs`（62/0）、`verify-card-module1`（9/0）、`verify-auth`（43/0）——**隔离已实测可用**：`MEDBRIEF_DATA_DIR` 被 `lib/accounts.mjs:18`/`blobStore.mjs:13`/`correctionsStore.mjs:23` 读取，且 verify-auth/card-inject 等测试已用它+独立端口跑通。要求：独立端口（避开 5174）+ `MEDBRIEF_DATA_DIR` 指向临时副本 + `MEDBRIEF_REPORTS_FILE` 指向副本库 + **CWD 切到 /tmp 沙盒**（r3 P1-C 防呆：`server.mjs:115/242` 有 `__dirname/data` 相对路径兜底，物理隔离 CWD 可百分百杜绝碰生产 data/）；只读版降级时验收同步收窄，不以全功能清单量只读版。
12. **暴露面/数据断言**：API 原始 JSON **不脱敏**（`mask=1` 只在打印渲染），确认生产经 HTTPS + auth；`ss` 断 5174 仅本地绑。**会话加固（Secure cookie/XFP/首登改密）代码未实现**（grep 零命中，AI 审核 P0-4）——部署侧配不出来；若拍板要加固，归阶段 0 D0-5④ 补代码；否则书面接受"仅 HTTPS 传输层+auth"风险，不在本计划假称已做。
13. 回滚点：systemd stop + 恢复上一版目录/数据快照 + 1Panel 反代指回；**每步可独立回滚**。

**延后项的触发条件：**
- C2（三识别服务上云）：触发 = 用户明确"必须全功能上线"且给出这三个服务的部署方式/资源预算（内存/swap 已紧，详见 A10）；否则先上"报告库+卡面"只读版（无需 OCR，**但须关上传/识别入口**，见阶段 1.3）。
- C8（监控告警）：触发 = 上线后 7 天内出现 ≥1 次非计划停机。

**无法自解、需用户拍板：**
1. **部署范围（#1 边界已澄清）**：全功能（含 OCR/识别三服务 + 挂号，重）还是**只读版**？——**只读版定义 = 报告库 + 卡面 + 打印预览，明确不含挂号/上传/识别**；`server.mjs:983` 的 `chromium.launch()` 是挂号流程（Mac Chrome 路径 + headless:false，服务器不可用），只读版不触发 ⇒ MemoryMax 可按只读版 768M 起（运维实测再调）；**全功能版若要挂号须先改这段为服务器可用 Chrome/headless，属业务代码、另派，不在部署阶段解决**。若选只读版，验收清单同步收窄（不验 OCR/挂号、关上传/识别入口），不以全功能清单量只读版。
2. **域名/证书（已定）**：新子域名 `medbrief.shanhailingjing.top`，用户加 A 记录 → 62.234.146.222；不碰现存 admin/www/test 三站点。
3. **数据迁移**：221M 真库是否原样上生产？（含未脱敏姓名；**API 原始 JSON 不脱敏**，掩码只在打印渲染——公网是否接受 或 需脱敏上生产？）
4. **资源**：三识别服务若同机，1.0G 可用内存 + 已用 2.3G swap 明显不够——加内存、独立小机、还是砍 OCR（只读版）？
5. **重启纪律**：systemd 还是 1Panel 面板托管？主理人说"走面板"，需确认 1Panel 是否有进程守护能力。
6. **暴露面（审核 r1 新增）**：公网直连 + auth，还是叠加来源白名单/VPN？SECRET 的生成/存放/轮转由谁管？
7. **AI Studio 审核进度**：已用 `--session-key MedBrief/deploy-1117` 跑完 r1（逻辑预审，4P0+6P1）与 r2（2P0）；r1/r2 判词在 `.agents/deploy-1117-review-r{1,2}.md`。待 r3 终判（P0 清零）。
8. **本版裁剪表态（AI 审核 P1-6）**：D0-2~4（Bug12/A-数据层、A-渲染层、B 线附页）本版是**全等闭环**还是**显式裁剪**？裁剪则验收同步收窄，不裁剪则等用户「按以上计划执行」全做。
9. **只读版入口关闭的实现与归属（AI 审核 P1-6）**：若选只读版，上传/识别入口是纯前端隐藏还是后端返回"未启用"？需 UI 规格，归口到 UI 设计师 + 哪个 commit 做。
10. **会话加固二选一（AI 审核 P0-4 / D0-5④）**：Secure cookie / X-Forwarded-Proto / 首登改密 / 口令策略代码**零命中未实现**——是归账号线补代码后再部署，还是**书面接受"仅 HTTPS 传输层 + auth、不做会话加固"**的风险？二选一必须落文字，不许在部署文档假称已做。

**回退与门禁（G7）**：每阶段独立回滚点；验收命令在上；生产库零写入直到阶段 2 的备份+rsync 完成；测试用副本库。

---

## 复跑命令清单（取证可复现）

```bash
ssh -o BatchMode=yes ubuntu@62.234.146.222 'node -v; ss -tlnp; free -h; df -h /; docker ps; sudo iptables -S YJ-FIREWALL-INPUT'
cd /Users/scallion/Documents/projects/MedBrief && node -e "const p=require('./package.json');console.log(p.scripts.start)"   # node server.mjs
grep -n "127.0.0.1:8008\|127.0.0.1:8045\|MEDREC_BACKEND\|VISION_ENDPOINT" server.mjs lib/*.mjs
```

> **审核闭环完成**：AI Studio 同 session r1→r2→r3（`--session-key MedBrief/deploy-1117`），**r3 终判「可以开工」**（逻辑预审视角 P0 清零；判词 `.agents/deploy-1117-review-r{1,2,3}.md`）。另有独立 Bot 实测判词 `.agents/deploy-1117-review-r1-bot.md`（分通道留痕）。**但「可以开工」≠ 授权部署**：仍受 G6 + 下面 10 项拍板约束。
> 下一步（两个独立的门）：①**审核门 ✅ 已过**（r3 可以开工）；②**用户拍板门（待）**：下面 10 项（范围/域名已定/数据/资源/重启/暴露面/审核进度/裁剪/只读入口/会话加固）全部落定 + 用户一句"按以上计划执行"，才动服务器。
