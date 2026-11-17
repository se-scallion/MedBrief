# MedBrief 生产部署计划 —— 排雷与取舍 v0.1（未执行）

> 触发（用户原话，2026-11-17 10:34）：「完成以上任务之后，设计一个部署计划。服务器直接无密连接 ssh ubuntu@62.234.146.222」。
> 状态：**只做了 SSH 只读取证，未改服务器任何东西、未部署**。用户要的是"设计计划"，不是立即部署。
> 作者：代诊-Manager。审核：待独立 AI 审核闭环。代码/测试 HEAD = `c55234d`。
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

---

## B. 正向排雷（方案 → 现有生产消费方）

**B1 破坏性动作。** rsync `data/` 到服务器可能覆盖同名文件；必须用 `--dry-run` 先演、目标目录空目录起步、`--checksum` 后核对。禁止 `rm -rf` 服务器上任何现有目录（1Panel/MySQL/ES 都在跑）。

**B2 端口冲突。** 5174/8011/8008/8045 服务器上当前空闲（已实测），但 3000/9007 等被占——**端口规划必须避开已占用表**，且 Node 只绑 127.0.0.1，不绑 0.0.0.0。

**B3 反代覆盖。** 1Panel 管理的 openresty 配置会被面板重建覆盖；**只在 1Panel 站点层建反代，不改 `/opt/1panel/apps/openresty/...` 裸配置**。

**B4 证书与域名。** 80/443 已有 openresty 在 termination，本站必须用独立域名/子域 + 证书，不能抢现有站点的 server_name；域名/DNS 由用户提供（当前未知）。

**B5 认证开后门风险。** 账号线刚报 `server.mjs` 有 `!AUTH_ENABLED` 分支在认证关闭时无鉴权返回全部手机号+审计（主理人 r 裁决三条必修之一，归「代诊-账号」修，尚未闭环）。**生产必须 `MEDBRIEF_AUTH=on` + SECRET 环境变量**，且在该必修闭环前**不许部署**。

**B6 测试污染。** 部署验收用副本库 + 非生产端口；**绝不拿生产库跑测试**；健康检查用 `/api/health`，不写库。

**B7 部署态/重启纪律。** 主理人明确：服务器 5174 现在对 Project-Console 是 external，**下次重启走面板**，不裸杀进程（他刚误杀过一次生产实例）。本计划所有"重启/切流"步骤必须写成"在 1Panel 面板停/启"或 systemd（若采用），操作的原子性和回滚点要写清。

**B8 治理资产。** 当前代码 HEAD `c55234d`；账号线 44 行 admin/users 未提交（归代诊-账号）、Bug12 待修（A-数据层）。**部署清单必须钉"部署的是哪个 commit"**，不能部署工作树（含别人的在途）。用户说的"完成以上任务之后"正是要求这些先闭环再部署。

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
| C7 域名/DNS | 用户只能 IP 访问、无证书 | 低（用户提供） | B4 | 用 IP + 自签？不安全 | **延后**：用户提供域名再建站 |
| C8 监控/日志/告警 | 崩了不知道 | 中 | 可观测 | 1Panel 自带日志页 | **延后（触发：上线后观测到异常）** |
| C9 多机/负载均衡 | 单机够用 | 高 | 无 | 无 | **砍**（当前规模无意义） |
| C10 数据库从 data/reports.json 迁到 MySQL | 无此需求 | 高 | 与现有 MySQL 无关 | 保持文件库 | **砍**（数据形状/查重键全基于文件库，迁移是另一条线） |

---

## D. 简化后的方案（只列留下的项）+ 延后触发条件

**阶段 0 — 前置闭环（用户说"完成以上任务之后"，这是那批任务的清单）：**
- D0-1 账号线 admin/users 三条必修闭环 + 四文件同批提交（归「代诊-账号」，主理人已下）。
- D0-2 Bug12 `criticalOf` 假危急修（A-数据层，等用户「按以上计划执行」）。
- D0-3 模块① 6 格分层证据区（A-渲染层，等 UI v2 + 用户授权）。
- D0-4 打印附页 B 线（等用户授权）。
- **只有 D0 全部闭环 + 部署 commit 钉死，才进入阶段 1。**（注：若用户明确"先上当前 HEAD 的只读版"，可降 D0 优先级——但需用户拍板，我不自行砍。）

**阶段 1 — 环境与前提（只读验证 → 变更）：**
1. 装固定版本 Node（建议 Node 22 LTS，与本地 `node -v` 一致），走 nvm 或 apt nodeenv，记录版本。
2. 建部署目录（如 `/opt/medbrief` 或 `/home/ubuntu/medbrief`，用户定），权限 750，owner ubuntu。
3. `npm ci`（若有 lock）或 `npm install --omit=dev`（生产只需运行时；playwright 是 dev 用，可不装）；**先 `npm run build:web` 产物随代码上来**（本地已构建 `web/dist-next`）。

**阶段 2 — 数据与配置：**
4. `data/` 221M 用 rsync + ssh 加密传（先 `--dry-run`、后 `--checksum` 核对），目标目录单独放、不覆盖现有业务数据；落盘权限 600。
5. 环境变量：`PORT=5174`、绑 `127.0.0.1`、`MEDBRIEF_AUTH=on`、`MB_SESSION_SECRET=<强随机>`、`MEDREC_BACKEND=8011`（若 C2 落地）或 `legacy`（只读版）；**SECRET 不进代码库**。
6. 备份：上传前对生产目标目录打 tar.gz 快照；记录回滚点。

**阶段 3 — 进程与反代：**
7. 进程守护：systemd unit（推荐，`Restart=on-failure`）或 1Panel 进程守护；**只绑 127.0.0.1:5174**。
8. 1Panel 建站点 + 反向代理到 127.0.0.1:5174 + 证书（域名由用户提供，C7）；不改 openresty 裸配置。
9. 防火墙：确认 5174/8011/8008 不对公网开放（iptables 默认 DROP 已满足，站点只经 443）。

**阶段 4 — 验收与回滚：**
10. 冒烟：`curl https://<域名>/api/health` → `ok:true, auth:on, head=<部署commit>`；登录 → 建报告 → 出卡 → 打印预览；**识别链路验 8008/8011/8045 各一条**（若 C2 落地）。
11. 门禁：服务器上 `node tests/verify-card.mjs`（62/0）、`verify-card-module1`（9/0）、`verify-auth`（账号线提交后 39/0）——用副本库，不碰生产 data。
12. 回滚点：systemd stop + 恢复上一版目录/数据快照 + 1Panel 反代指回；**每步可独立回滚**。

**延后项的触发条件：**
- C2（三识别服务上云）：触发 = 用户明确"必须全功能上线"且给出这三个服务的部署方式/资源预算；否则先上"报告库+卡面只读"版（自带成果，无需 OCR）。
- C7（域名）：触发 = 用户提供域名 + DNS 指向该机。
- C8（监控告警）：触发 = 上线后 7 天内出现 ≥1 次非计划停机。

**无法自解、需用户拍板：**
1. **部署范围**：全功能（含 OCR/识别三服务，重）还是只读版（报告库+卡面，轻）？
2. **域名/证书**：有域名吗？还是先 IP + 自签/1Panel 默认证书？
3. **数据迁移**：221M 真库是否原样上生产？（含未脱敏姓名；公网+auth on 是否接受）
4. **资源**：三识别服务若同机，1.0G 可用内存明显不够——加内存、独立小机、还是砍 OCR？
5. **重启纪律**：systemd 还是 1Panel 面板托管？主理人说"走面板"，需确认 1Panel 是否有进程守护能力。

**回退与门禁（G7）**：每阶段独立回滚点；验收命令在上；生产库零写入直到阶段 2 的备份+rsync 完成；测试用副本库。

---

## 复跑命令清单（取证可复现）

```bash
ssh -o BatchMode=yes ubuntu@62.234.146.222 'node -v; ss -tlnp; free -h; df -h /; docker ps; sudo iptables -S YJ-FIREWALL-INPUT'
cd /Users/scallion/Documents/projects/MedBrief && node -e "const p=require('./package.json');console.log(p.scripts.start)"   # node server.mjs
grep -n "127.0.0.1:8008\|127.0.0.1:8045\|MEDREC_BACKEND\|VISION_ENDPOINT" server.mjs lib/*.mjs
```

> 下一步：写 review-input，派独立 AI 审核（重点攻击 C2 资源/依赖、B5 认证必修、A4 配置无来源），终判后交用户确认；用户说"按以上计划执行"才动服务器。
