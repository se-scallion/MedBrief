# MedBrief 生产部署计划 —— 排雷与取舍 v0.2（未执行）

> 触发（用户原话，2026-11-17 10:34）：「完成以上任务之后，设计一个部署计划。服务器直接无密连接 ssh ubuntu@62.234.146.222」。
> 状态：**只做了 SSH 只读取证，未改服务器任何东西、未部署**。用户要的是"设计计划"，不是立即部署。
> 版本 v0.2：吸收独立审核 r1 的 4 P0 + 9 P1（`.agents/deploy-1117-review-r1.md`）中**我独立复算属实**的部分。
> **审核方式（用户 2026-11-17 口径：必须走 AI Studio 工具）**：已用 `ai_scheme_review.py --session-key MedBrief/deploy-1117` 实跑 → `MODEL_ERROR_TEXT / 权限遭拒`（exit 5、无判词、台账未回写）——**该路待用户修 AI Studio 账号权限后重跑，是正式审核门**。Bot 判词只作技术输入，不替代用户指定审核路。
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

**A9【v0.2 新增，审核 r1 P0】公网真实病历只靠 auth on 不够。** `data/` 221M、98 份 `patientName` 未脱敏（`mask=1` **只在打印渲染时**脱敏，**API 原始 JSON 不脱敏**）。生产至少：HTTPS（依赖 C7）+ 来源限制/VPN + 首登改密与口令策略 + 文档明确"API 原始数据不脱敏"。

**A10【v0.2 新增，审核 r1】资源/站点补证**：Swap 4.0G **已用 2.3G**（已在靠 swap 撑）；只读版本地 RSS ~130MB ⇒ 只读版可行、全功能不可行，systemd 加 `MemoryMax`；现存 3 站点（`admin.shanhailingjing.top`/`www.shanhailingjing.top`/`test`，新站点避开）；`sudo -n` 免密可用 ⇒ 部署脚本等于 root，权限面要收；4 核；openresty include 1Panel WAF、`client_max_body_size 50m` 已在 http 级设好（上传不会 413）。

---

## B. 正向排雷（方案 → 现有生产消费方）

**B1 破坏性动作。** rsync `data/` 到服务器可能覆盖同名文件；必须用 `--dry-run` 先演、目标目录空目录起步、`--checksum` 后核对。禁止 `rm -rf` 服务器上任何现有目录（1Panel/MySQL/ES 都在跑）。

**B2 端口冲突。** 5174/8011/8008/8045 服务器上当前空闲（已实测），但 3000/9007 等被占——**端口规划必须避开已占用表**，且 Node 只绑 127.0.0.1，不绑 0.0.0.0。

**B3 反代覆盖。** 1Panel 管理的 openresty 配置会被面板重建覆盖；**只在 1Panel 站点层建反代，不改 `/opt/1panel/apps/openresty/...` 裸配置**。

**B4 证书与域名。** 80/443 已有 openresty 在 termination，本站必须用独立域名/子域 + 证书，不能抢现有站点的 server_name；域名/DNS 由用户提供（当前未知）。

**B5 认证开后门风险 —— v0.2 更新：必修已闭环，剩的是部署侧配置。** 账号线 `!AUTH_ENABLED` 无鉴权后门、恒真式 `(AUTH_ENABLED||!AUTH_ENABLED)` 已被主理人两轮打回修复（`395156d`/`adbafc9`/`6c3e424`；实测 `grep -c 'AUTH_ENABLED || !AUTH_ENABLED'`=0、`MEDBRIEF_AUTH=off` 下 GET/POST admin/users 均 503、`verify-auth` 43/0）。代码侧 `MEDBRIEF_AUTH` 默认 on（`:263` `!== 'off'`）、缺 `MB_SESSION_SECRET` 或任段 <32 字符 `exit(1)`（`:88-92`）。**部署侧仍必须**：`MEDBRIEF_AUTH=on` + 强 SECRET（生成/存放/轮转有规程）+ 生产 `Secure` cookie + 反代传 `X-Forwarded-Proto`（否则 cookie 不走 HTTPS）+ 首登改密。

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
| C7 域名/DNS | 无域名就没有 HTTPS/证书，病历明文公网不可接受 | 低（用户提供） | B4/A9 | IP+自签不安全 | **前置（用户必答，不可延后）**：有域名→1Panel 站点+公信证书；无域名→**不上公网**（仅 SSH 隧道 / 来源白名单内网访问） |
| C8 监控/日志/告警 | 崩了不知道 | 中 | 可观测 | 1Panel 自带日志页 | **延后（触发：上线后观测到异常）** |
| C9 多机/负载均衡 | 单机够用 | 高 | 无 | 无 | **砍**（当前规模无意义） |
| C10 数据库从 data/reports.json 迁到 MySQL | 无此需求 | 高 | 与现有 MySQL 无关 | 保持文件库 | **砍**（数据形状/查重键全基于文件库，迁移是另一条线） |

---

## D. 简化后的方案（只列留下的项）+ 延后触发条件

**阶段 0 — 前置闭环（用户说"完成以上任务之后"，这是那批任务的清单）：**
- D0-1 ~~账号线 admin/users 三条必修闭环 + 四文件同批提交~~ **✅ 已闭环（v0.1a，2026-11-17）**：`395156d`(管理界面)+`2b32096`(审计时间)+`adbafc9`(堵 auth=off 后门)；实测恒真式消除、`git show HEAD:server.mjs|grep -c api/admin/users`=3、工作树干净、5174 head=`adbafc9` auth=on、`node tests/verify-auth.mjs` **43/0 exit 0**。归「代诊-账号」，已全部入库。
- D0-2 Bug12 `criticalOf` 假危急修（A-数据层，等用户「按以上计划执行」）。
- D0-3 模块① 6 格分层证据区（A-渲染层，等 UI v2 + 用户授权）。
- D0-4 打印附页 B 线（等用户授权）。
- **只有 D0-2~4 闭环（或用户显式写"本版裁剪"并同步收窄验收）+ 部署 commit 钉死，才进入阶段 1。** "若用户明确先上只读版可降 D0 优先级"这句话是给自己开后门（审核 r1 认定），已删除——正确形式是把"降级范围"作为带范围的选项写进下面"需用户拍板"清单：降级则验收清单同步收窄（不验 OCR 链路），否则必然红→被人放宽。

**阶段 1 — 环境与前提（只读验证 → 变更）：**
1. 装固定版本 Node（**必须 ≥22.5**：`lib/blobStore.mjs` 用 `node:sqlite` 的 `DatabaseSync`；`apt install nodejs` 在 Ubuntu 22.04 给旧版 ⇒ 走 **NodeSource/nvm**，记录版本）。审核 r1 更正我原写"Node 22 LTS 与本地一致"——本地版本需实测，但下限 22.5 是硬的。
2. 建部署目录（如 `/opt/medbrief` 或 `/home/ubuntu/medbrief`，用户定），权限 750，owner ubuntu。
3. **先在仓库生成并提交 `package-lock.json`**（当前无 lock，审核 r1 P0-3）；`npm ci` 装**全依赖含 playwright**（顶层 import，不能 `--omit=dev`）；`npm run build:web` 产物随代码上来。**先只读版则关上传/识别入口**（P1-6：入口可点会 500——纯前端隐藏或后端返回明确"未启用"，需 UI 规格）。
4. **代码改动（须单独 commit、单写者）**：`server.mjs:2050` 加 bind 开关 `MEDBRIEF_BIND`（A7 P0-2），否则"只绑 127.0.0.1"做不到。

**阶段 2 — 数据与配置：**
4. `data/` 221M 用 rsync + ssh 加密传（先 `--dry-run`、后 `--checksum` 核对），目标目录单独放、不覆盖现有业务数据；落盘权限 600。
5. 环境变量：`PORT=5174`、**`MEDBRIEF_BIND=127.0.0.1`**（配合阶段 1 的代码改动）、`MEDBRIEF_AUTH=on`、`MB_SESSION_SECRET=<强随机>`、`MEDREC_BACKEND=8011`（若 C2 落地）或 `legacy`（只读版）；**SECRET 不进代码库**（生成/存放/轮转有规程）；生产 cookie `Secure` + 反代传 `X-Forwarded-Proto`。
6. 备份：上传前对生产目标目录打 tar.gz 快照；记录回滚点。

**阶段 3 — 进程与反代：**
7. 进程守护：systemd unit（推荐，`Restart=on-failure`）或 1Panel 进程守护；**必须写 `WorkingDirectory=<部署目录>`**（项目内 `path.resolve('data',…)` 相对 CWD，不设会去 `/data` 找库——审核 r1 P1）；**加 `MemoryMax=`**（swap 已用 2.3G）；`Environment=MEDBRIEF_BIND=127.0.0.1`。
8. **C7 分支（前置，用户必答）**：有域名 → 1Panel 建站点 + 反代 `http://127.0.0.1:5174` + 公信证书（避开现存 3 站点 server_name）；**无域名 → 不上公网**，只开 SSH 隧道 / 来源白名单内网访问，禁止明文 HTTP 暴露病历。
9. 防火墙/暴露面：`ss -tlnp | grep 5174` 必须是 **`127.0.0.1:5174`**（验证 A7 bind 生效）；确认 8011/8008 不对公网开放；openresty WAF 已在 include 中、`client_max_body_size 50m` 已设（上传不 413）。
9b. 权限面：`sudo -n` 免密可用 ⇒ 部署脚本等于 root，脚本与 SECRET 文件权限 600、只许 ubuntu 读写，审计留痕。

**阶段 4 — 验收与回滚：**
10. 冒烟：`curl https://<域名>/api/health` → `ok:true, auth:on, head=<部署commit>`；登录 → 建报告 → 出卡 → 打印预览；**识别链路验 8008/8011/8045 各一条**（若 C2 落地）。
11. 门禁：服务器上 `node tests/verify-card.mjs`（62/0）、`verify-card-module1`（9/0）、`verify-auth`（43/0）——用副本库，不碰生产 data；**只读版降级时验收同步收窄**（不验 OCR 链路、隐藏上传/识别入口），不以全功能清单量只读版。
12. **暴露面/数据断言**：API 原始 JSON **不脱敏**（`mask=1` 只在打印渲染），确认生产经 HTTPS + auth；`ss` 断 5174 仅本地绑；首登改密与口令策略生效。
13. 回滚点：systemd stop + 恢复上一版目录/数据快照 + 1Panel 反代指回；**每步可独立回滚**。

**延后项的触发条件：**
- C2（三识别服务上云）：触发 = 用户明确"必须全功能上线"且给出这三个服务的部署方式/资源预算（内存/swap 已紧，详见 A10）；否则先上"报告库+卡面"只读版（无需 OCR，**但须关上传/识别入口**，见阶段 1.3）。
- C8（监控告警）：触发 = 上线后 7 天内出现 ≥1 次非计划停机。

**无法自解、需用户拍板：**
1. **部署范围**：全功能（含 OCR/识别三服务，重）还是只读版（报告库+卡面，轻）？——**若选只读版，验收清单同步收窄**（不验 OCR 链路、关上传/识别入口），不以全功能清单量只读版。
2. **域名/证书**：有域名吗？（无域名 = 不上公网，走 SSH 隧道/来源白名单；明文 HTTP 暴露病历不可接受）
3. **数据迁移**：221M 真库是否原样上生产？（含未脱敏姓名；**API 原始 JSON 不脱敏**，掩码只在打印渲染——公网是否接受 或 需脱敏上生产？）
4. **资源**：三识别服务若同机，1.0G 可用内存 + 已用 2.3G swap 明显不够——加内存、独立小机、还是砍 OCR（只读版）？
5. **重启纪律**：systemd 还是 1Panel 面板托管？主理人说"走面板"，需确认 1Panel 是否有进程守护能力。
6. **暴露面（审核 r1 新增）**：公网直连 + auth，还是叠加来源白名单/VPN？SECRET 的生成/存放/轮转由谁管？
7. **AI Studio 审核权限**：用户须修好 AI Studio 账号权限，用 `ai_scheme_review.py --session-key MedBrief/deploy-1117` 重跑 r1（当前 Bot 判词只作技术输入，不算用户指定的审核门）。

**回退与门禁（G7）**：每阶段独立回滚点；验收命令在上；生产库零写入直到阶段 2 的备份+rsync 完成；测试用副本库。

---

## 复跑命令清单（取证可复现）

```bash
ssh -o BatchMode=yes ubuntu@62.234.146.222 'node -v; ss -tlnp; free -h; df -h /; docker ps; sudo iptables -S YJ-FIREWALL-INPUT'
cd /Users/scallion/Documents/projects/MedBrief && node -e "const p=require('./package.json');console.log(p.scripts.start)"   # node server.mjs
grep -n "127.0.0.1:8008\|127.0.0.1:8045\|MEDREC_BACKEND\|VISION_ENDPOINT" server.mjs lib/*.mjs
```

> 下一步（两个独立的门）：①**用户指定审核门**：修好 AI Studio 权限后用 `--session-key MedBrief/deploy-1117` 重跑 r1（Bot 判词 `.agents/deploy-1117-review-r1.md` 的技术修正已吸收进 v0.2，但不替代该门）；②**用户拍板门**：上面 7 项（范围/域名/数据/资源/重启/暴露面/权限）。两门都过 + 用户一句"按以上计划执行"才动服务器。
