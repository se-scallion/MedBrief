# MedBrief 生产部署计划 · 独立审核 **r1**（plan-review §8.3）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/deploy-1117-plan.md` **v0.1a**（140 行）。
> 输入：`.agents/deploy-1117-review-input.md`（用户原文 + 7 个必攻击点 + 硬约束）。
> 我做了什么：本地只读 `grep`/`node -e`；**SSH 只读**跑了 4 组命令（`whoami/os-release/free/df/ss/docker ps/iptables -S/systemctl/站点目录/openresty 主配置`），**未改服务器任何东西、未装任何包、未启停任何服务、未写服务器文件**。
> 代码/测试 HEAD = `adbafc9`（工作树状态见 §5）。**只写了本文件。**

---

## 0. 总判：**不能直接进下一轮** —— 4 条 P0

计划的骨架是对的（先补前提再 rsync、1Panel 站点反代而不是裸启 80、数据加密传、C6 认证硬门、**C2 判"延后 + 触发条件"我认定正确**），四段结构也齐全。但有四处**会让计划执行不下去或执行完不安全**：

| # | P0 | 一句话 | 证据 |
|---|---|---|---|
| **P0-1** | **阶段 3 依赖一个被判"延后"的项（域名 C7）⇒ 没有域名就完不成部署** | `C7 域名/DNS` 判"**延后**：用户提供域名再建站"（`:80`），但阶段 3 第 8 步写的是"1Panel 建站点 + 反向代理 + **证书**（域名由用户提供，C7）"（`:108`）。C7 延后 ⇒ 建站点与证书都做不了 ⇒ 整条部署链断在这里 | `:80` vs `:108` |
| **P0-2** | **代码硬编码 `listen(PORT, '0.0.0.0')`，没有任何 bind 环境变量** | 计划三处要求"只绑 `127.0.0.1:5174`"（`:32`/`:107`/`:109`），且硬约束写"禁止把 5174 暴露 0.0.0.0"。实测 `server.mjs:2050` = `server.listen(PORT, '0.0.0.0', …)`，**无 `MEDBRIEF_BIND` 之类的开关** ⇒ 靠配置做不到，必须改代码或明确接受偏差 | `server.mjs:2050` |
| **P0-3** | **"playwright 是 dev 用，可不装"会直接让服务起不来** | `server.mjs:39` 是**顶层** `import { chromium } from 'playwright'`，且 `package.json.dependencies = {"playwright": "^1.50.0"}`（不是 devDependencies）。不装包 ⇒ 进程启动即 `ERR_MODULE_NOT_FOUND` | `server.mjs:39` + `package.json` |
| **P0-4** | **公网暴露真实病历：只靠 `MEDBRIEF_AUTH=on` 不够** | `data/` 221M 含 98 份**未脱敏姓名**报告 + 80M 原件库（我实测 `du -sh`）。计划 A5 只写"公网暴露必须带认证"，没有写"必须 HTTPS + 来源限制"；而 HTTPS 又依赖 P0-1 的域名 | `du -sh data` = 221M |

**阶段路径结论（你问的"先阶段 0 还是直接进阶段 1"）：**

> **先做阶段 0，且阶段 0 必须再加两条（P0-2 的 bind 支持、P0-1 的域名拍板）**，然后才允许进阶段 1。
> **不允许"直接进阶段 1"**：阶段 1 的第一步（装 Node）本身无害，但阶段 2 的 `data/` 上传一旦开始，没有域名/证书就意味着**真实病历已经在公网上以明文 HTTP 可达**（如果此时也把站点建起来），或者传了数据却访问不了（如果没建站点）——两头都不成立。

---

## 1. P0 逐条展开

### P0-1 C7（域名）不该判"延后"，它是**开工前置**

```
:80  | C7 域名/DNS | 用户只能 IP 访问、无证书 | 低（用户提供） | B4 | 用 IP + 自签？不安全 | **延后**：用户提供域名再建站 |
:108 | 8. 1Panel 建站点 + 反向代理到 127.0.0.1:5174 + 证书（域名由用户提供，C7）；不改 openresty 裸配置。
```

"延后"的定义是"不做也能交付 MVP"。但这里**不做就等于交付不了**：没有站点就没有反代，没有反代 5174 就出不了公网（5174 又禁止直接暴露），没有证书就违反"病历数据必须加密传输"。⇒ C7 的两条出路都要求用户当场决定，属于**「无法自解、需用户拍板」**（计划 `:123` 已经列了"域名/证书：有域名吗？"），那就**不该同时把它标成"延后"**——两个标签并存，实现方会照"延后"跳过，然后在阶段 3 卡住。

**改法**：
- C7 的结论改成 **「前置（用户必答）」**，并写死两条分支：
  - **(a) 有域名**：DNS A 记录 → 1Panel 建站点（`server_name <域名>`）+ Let's Encrypt 证书 + 反代 `127.0.0.1:5174`；
  - **(b) 无域名**：**不上公网**。走 SSH 隧道/内网访问（`ssh -L 5174:127.0.0.1:5174 ubuntu@<host>`）或只放行固定来源 IP（见 P0-4）；**明确禁止 `http://62.234.146.222/` 明文访问病历**。
- 并把"阶段 3 第 8 步"的前提写成 **"C7 分支已定"**，否则该步标 `BLOCKED`。

### P0-2 "只绑 127.0.0.1" 目前做不到（代码硬编码）

```js
// server.mjs:2050
server.listen(PORT, '0.0.0.0', () => { … })
```
`grep -n "MEDBRIEF_BIND\|0\.0\.0\.0" server.mjs` 只有这一处、无环境变量。而计划在 `:32`/`:107`/`:109` 三次要求只绑回环，硬约束也写了"**禁止把 5174 暴露 0.0.0.0**"。

现实风险不是"立刻裸奔"——iptables `INPUT DROP`（**我实测 `-P INPUT DROP`**）会挡住外部直连 5174；但：
1. **它与计划自己写的口径不符**，实现方只能"二选一：改代码 or 认偏差"，而计划没给第三条；
2. 服务器上同机的其他容器/进程（8 个容器共享 `172.18.0.0/16` 网桥）可以直连 `0.0.0.0:5174`——**旁路 iptables 的 INPUT 规则**（DOCKER 链对容器流量放行）。这在"服务器上跑着别人业务"的场景里不是理论问题。

**改法（一行代码，进阶段 0）**：
```js
const HOST = process.env.MEDBRIEF_BIND || '0.0.0.0'     // 本地开发默认不变
server.listen(PORT, HOST, …)
```
配 `Environment=MEDBRIEF_BIND=127.0.0.1`，验收断言：`ss -tlnp | grep 5174` 必须是 **`127.0.0.1:5174`**，不是 `0.0.0.0:5174`。若用户不同意在阶段 0 改代码，就写死"已知偏差 + 仅靠 iptables 与网桥隔离，并加一条 `ss` 断言"——但**不能像现在这样两边都不写**。

### P0-3 playwright 必须装（且浏览器二进制是另一回事）

```
server.mjs:39:  import { chromium } from 'playwright'
package.json:  "dependencies": { "playwright": "^1.50.0" }
```
计划阶段 1 第 3 步写「`npm ci`（若有 lock）或 `npm install --omit=dev`（生产只需运行时；**playwright 是 dev 用，可不装**）」。这句话有两处错：

1. **它不是 dev 依赖**，在 `dependencies` 里 ⇒ 若实现方照"可不装"手动跳过/裁剪，**`node server.mjs` 启动即崩**（顶层 import）；
2. **`npm ci` 不可用**：仓库里**没有 `package-lock.json`**（我实测 `ls package-lock.json` → No such file），`npm ci` 会直接报错退出。而 `npm install` 会把 `^1.50.0` 解析到最新 1.x ⇒ **生产不可复现**（今天装的和明天装的不是同一个版本）。

**改法**：
- 阶段 1 写死：**必须 `npm install`（含 playwright 包，不许省）**；并在阶段 0 补一条"**生成并提交 `package-lock.json`**（锁版本）"，否则部署 commit + 依赖版本两个自由度，出问题无法复现；
- **浏览器二进制**单独说清：只有"114 挂号 / `tools/card-pdf.mjs` 出 PDF"需要 `npx playwright install chromium`（+ Ubuntu 22.04 需要的系统库，约 170MB，磁盘 8.2G 够）。**只读版可以只装包不装浏览器**——但必须写"调用这两个功能会失败"，不能假装能跑。

### P0-4 公网暴露真实病历的最小面：auth on 不够

`du -sh data` = **221M**；`data/reports.json` 98 份、`patientName` 未脱敏为默认（`mask=1` 只在**打印渲染**时脱敏，**API 原始 JSON 不脱敏**）。而计划 A5 的结论只有"必须带认证"。

登录取到 cookie 之后，`GET /api/intake/reports` 就是 98 份带姓名+诊断+指标的完整病历 JSON。就"医疗数据上公网"这件事，至少要有三件：

1. **传输加密**（HTTPS，硬性；依赖 P0-1 的域名决策）；
2. **来源限制**：这台机器 iptables 已 `INPUT DROP`（我实测 `-P INPUT DROP`，且有 SSH 黑名单链），**把 443 的来源收窄到用户实际会用的网段**是零成本动作（医生/家属的手机 4G 除外——那这条就不成立，改为 VPN/白名单账号）；
3. **口令强度与首登改密**：`users` 侧 `scrypt` 已就位，但计划没写"生产首个管理员密码如何下发、是否强制首登改密"（本地线是 CLI stdin，生产要写清）。

**改法**：在阶段 2/3 之间加一节"**暴露面**"，逐条给结论：① HTTPS 必须（否则不做公网）② 来源白名单或 VPN（若用户要在手机 4G 上看，此条改为"仅账号+HTTPS+强口令+登录限流"——限流已有 `login_attempts`）③ 首登改密与口令策略 ④ **明确"API 原始数据不脱敏"这件事**，别让人以为卡面脱敏就等于数据脱敏。

---

## 2. 逐条闭环核对表

| 段 | 我的复核 | 判 |
|---|---|---|
| **A1** 能不能直接部署 | 实测：无 node/npm/nvm ✓；5174/8011/8008/8045 全空闲 ✓；8008 硬编码 `127.0.0.1:8008/api/ocr-vision`（`:1708`，**不可配**）、8045 可配 `MEDBRIEF_VISION_ENDPOINT`（`lib/captchaSolver.mjs:14`）、8011 只以 `MEDREC_BACKEND=8011` 出现（`:64`/`:1661` 是注释，**base URL 我未定位到常量**）。结论"有硬缺口"成立 | ✅（锚点有一处不实，见 P1-5） |
| **A2** 部署形态 | 80/443 由 `1Panel-openresty-p1ke` 占 ✓；`INPUT DROP` ✓；形态选择正确 | ✅ |
| **A3** 资源前提 | 计划写"可用 1.0G" ✓ 我实测一致，但**漏了 swap**：`Swap: 4.0Gi used 2.3Gi` —— 这台机已经在靠 swap 撑，再加服务是往临界点推 | ⚠️ 缺关键数据（P1-1） |
| **A4** 配置无权威来源 | 实测无 `package-lock.json`、无 Dockerfile/compose/.env 样例（计划说对了） | ✅（但漏 lock 缺失对可复现的影响，P1-2） |
| **A5** 数据/隐私 | 见 P0-4；另计划写"`MEDBRIEF_AUTH` 开关默认? 需确认"——**实测默认 on**（`server.mjs:263` `AUTH_ENABLED = process.env.MEDBRIEF_AUTH !== 'off'`），且缺 `MB_SESSION_SECRET` 时进程 `exit(1)`（`:88-92`，fail-closed）⇒ 这个问号可以关掉 | ⚠️ 部分（P0-4） |
| **A6** 外部依赖拓扑 | 方向对；建议补"三条链路各自的可配性"（见 P1-5） | ⚠️ |
| **B1** 破坏性动作 | 正确（dry-run + 空目录 + checksum + 禁 rm -rf） | ✅ |
| **B2** 端口冲突 | 正确，且我实测空闲 ✓ | ✅ |
| **B3/B4** 反代/证书 | 正确（只走站点层、不抢 server_name）。现存站点 3 个：`admin.shanhailingjing.top`、`www.shanhailingjing.top`、`test` ⇒ **新站点必须用新 server_name** ✓ 计划已写 | ✅ |
| **B5** 认证后门 | **计划正文过期**：`:58` 仍写"b5 必修尚未闭环"，而 v0.1a `:90` 已写 D0-1 闭环（`adbafc9`）。我在代码层复核：`MEDBRIEF_AUTH` 默认 on、secret 缺失 exit(1)、`:310` 的 `!AUTH_ENABLED` 分支现在只对回环放行 | ⚠️ 台账认了正文没改（P1-3） |
| **B6** 测试污染 | 正确 | ✅ |
| **B7** 重启纪律 | 正确（走面板/不裸杀） | ✅ |
| **B8** 治理资产 | **正文过期**：`:64` 仍写"当前 HEAD `c55234d`；账号线 44 行未提交"，而现 HEAD = `adbafc9` 且已闭环 | ⚠️ 同 P1-3 |
| **B9** SSH 暴露面 | 正确；SSH 黑名单链已实测（多条 `REJECT`） | ✅ |
| **C2** 三识别服务 | **判"延后 + 触发条件"正确**（理由见 §3-1，我给正面证据） | ✅ |
| **C6** 认证硬门 | **成立，且现状已满足代码侧**（默认 on + fail-closed） | ✅ |
| **C7** 域名 | **判"延后"错误**——它是阶段 3 的前置 | ❌（P0-1） |
| **C5** 进程守护形态待定 | 合理；但我实测 `systemd` 可用、`sudo -n` 免密（说明可非交互装 unit），建议**直接选 systemd** 并在 unit 里写 `MemoryMax`（见 P1-1） | ⚠️ |
| **C9/C10 砍** | 砍得对（单机够用；文件库不迁 MySQL） | ✅ |
| **D 段** 阶段 0~4 | 顺序合理；但**缺 4 步**：bind 支持（P0-2）、lock 生成（P1-2）、`WorkingDirectory`（P1-4）、只读版关入口（P1-6） | ⚠️ |

---

## 3. 七个必攻击点逐条回答

### 3-1 「C2 判延后对不对？只读版是不是其实也不可用？」

**C2 判"延后"正确。只读版可用——而且我有实测证据。**

- **只读版不依赖任何外部服务**：我本地跑了 `buildCard({reports})` 生成整张卡（88 KB html），**全程零网络**；报告库列表/详情/blob 都是本地 fs + sqlite；`/api/meddata/summary`（8787）在不可用时**优雅降级**（`server.mjs:404-405` 注释：`ok:false, unavailable:true`，不报错）。⇒ 卡面、报告库、原件、打印（浏览器 `window.print`）**都能用**。
- **不可用的是三块**：① 上传识别（8008，硬编码 `127.0.0.1:8008`，服务器没有）② MedRecognition 解析（`MEDREC_BACKEND=8011`）③ 114 挂号/验证码（8045 视觉 + playwright 浏览器）。**PDF 导出**（`tools/card-pdf.mjs`）也依赖 chromium。
- **但计划漏了一句关键的**：只读版上线后，前端**上传/识别入口仍在**，用户点下去会转圈然后 500/超时。⇒ **必须显式关入口**（见 P1-6），否则"只读版可用"只在"用户不去点"的前提下成立。

### 3-2 「1Panel 站点 + 反代 127.0.0.1:5174 + systemd 有没有漏雷？1.0G 够不够？能不能纯 IP 建站？」

**内存结论：只读版够（且要设限额），全功能不够。**

| 项 | 实测/本地实测 | 结论 |
|---|---|---|
| 服务器可用内存 | **1.0Gi**（total 3.3Gi，used 2.1Gi） | 原样 |
| **swap（计划漏了）** | **4.0Gi 已用 2.3Gi** | 机器已在靠 swap 撑，加负载易抖动 |
| MedBrief 自身 RSS | **本地实测 130MB**（`node server.mjs`） | 只读版占用很小 ✓ |
| Node 22 基础 | ~40-60MB | ✓ |
| 三识别服务 + chromium | 未取证（`[未取证]` 计划已标） | **1.0G 内不可能与 MySQL/ES/Redis 共存**，全功能必须加内存/换机 |

⇒ **写法建议**：只读版放行，但 systemd unit 必须带 `MemoryMax=384M`（给 Node 留余量、防 OOM 拖累同机业务）、`Restart=on-failure`、并加一条监控 `journalctl -k | grep -i "killed process"` 的验收步骤（OOM 会留痕）。

**纯 IP 建站**：nginx 层允许 `server_name 62.234.146.222`，但**纯 IP 无法申请公信证书**（Let's Encrypt 不发 IP 证书）⇒ 只能 HTTP 明文 ⇒ **对病历数据不可接受**（P0-4）。所以"纯 IP"只在"不公网 + SSH 隧道/白名单"的前提下成立。

**还漏的雷（我实测到的）**：
1. **openresty 的 `client_max_body_size 50m`** 在 http 级已设好 ✓（我读到主配置 `:30`）——**这是好消息**，MedBrief 上传 5.5MB 原件不会 413。但要在验收里实测一条（站点若覆盖该指令会变 1m → 413）。
2. **1Panel WAF 是开着的**：主配置 include 了 `/usr/local/openresty/1pwaf/data/conf/waf.conf` ⇒ 可能拦截含 base64 大 JSON 或特殊字符的 `POST /api/intake/reports`。验收必须实测一条"5MB 图片上传 + 一条含 `'` `;` `<` 的文本字段"，并准备"站点加白/关 WAF"的回滚动作。
3. **`WorkingDirectory` 必须设**（见 P1-4）——这是最容易踩的：项目里 `path.resolve('data','reports.json')`、`path.resolve('data','intake')` 都是**相对 CWD**，systemd 不设工作目录就会去 `/data/...` 找库。

### 3-3 「C6 硬门成不成立？还漏什么 auth 雷？」

**硬门成立，而且现状比我预期更干净**（我复核了代码，不是只看台账）：

- `server.mjs:263` `AUTH_ENABLED = process.env.MEDBRIEF_AUTH !== 'off'` ⇒ **默认 on**（计划 A5 的"默认? 需确认"可以关掉）；
- `:88-92` 缺 `MB_SESSION_SECRET`（或任一段 <32 字符）⇒ `process.exit(1)`，**fail-closed**；
- `:77-87` 支持从 `<repo>/.mb-secret`（600、gitignore）读，未来可作 systemd `EnvironmentFile` 的替代；
- `:2051` `MEDBRIEF_AUTH=off` 时会打醒目告警。

**还漏的 auth 雷（三条）**：
1. **SECRET 的生成与保管**：计划只写 `MB_SESSION_SECRET=<强随机>`，没写"怎么生成（`openssl rand -base64 48`）、放哪（`/etc/medbrief/env` 600 root 或 unit 的 `EnvironmentFile=`）、轮转方式（数组 `[new, old]`，代码已支持）"；
2. **cookie 作用域**：走 1Panel 反代后，`Secure` 标志必须开（当前代码"不启用 HTTPS 时关"，`:2051` 附近），否则 HTTPS 站点上 cookie 会带 `Secure=?` 不一致；且 `SameSite=Lax` 与反代前缀无冲突（路径就是 `/`）✓——但**必须写"生产 `Secure` 开"**，否则计划漏这条；
3. **CSRF/来源**：cookie 是 `SameSite=Lax`，跨站 POST 已被挡 ✓；但反代若改写 `Host`/未传 `X-Forwarded-Proto`，登录跳转可能回环到 http。验收要断言"`https://域名/api/auth/me` 返 200 且响应头 `Set-Cookie` 含 `Secure`"。

### 3-4 「配置候选默认有没有凭空发明？公网 + auth on 够不够？」

**只有一处是凭空发明：`Node 22`。** 其余都有据：
- `PORT=5174` ✓（`server.mjs` 默认 `PORT || 5174`）；
- `MEDBRIEF_AUTH=on` ✓（真名就是 `MEDBRIEF_AUTH`）；
- `MB_SESSION_SECRET` ✓（**真名就是这个**，计划写对了，还凑巧与代码 `:77` 一致）；
- `MEDREC_BACKEND=8011` ✓（真名）；
- `payload /opt/medbrief` — 计划已标"用户定" ✓ 未发明；
- **`Node 22 LTS`**：本地是 `node -v` = 22.x（计划说"与本地一致"），但服务器 Ubuntu 22.04 的 `apt nodejs` 是 12.x/18.x 旧版 ⇒ **必须走 NodeSource/nvm，不能 `apt install nodejs`**。这条要写死，否则实现方 `apt install nodejs` 装个 12.22 上来，ESM + `node:sqlite` 全崩（`lib/blobStore.mjs` 用 `DatabaseSync`，需要 ≥22.5）。

**公网 + auth on 够不够：不够**（P0-4 三条）。

### 3-5 「'若用户明确先上只读版可降 D0 优先级'是不是给自己开后门？」

**是，而且是自相矛盾。** 原文：

> `:94` **只有 D0 全部闭环 + 部署 commit 钉死，才进入阶段 1。**（注：若用户明确"先上当前 HEAD 的只读版"，可降 D0 优先级——但需用户拍板，我不自行砍。）

矛盾在于：**前半句"只有…才"是硬门，括号里的"可降"是软出口**，而软出口的触发条件（"用户明确"）没有形式要求（口头？哪一句话？）。这等于把硬门变成"用户随口一句就能绕"。

**正确处置**（不是删掉，而是搬位置）：
- 把这条从"计划的执行细则"搬到 **「无法自解、需用户拍板」清单**（`:121-126` 已经有该清单），写成一条**带范围的选项**：
  > **选项 R**：仅部署"只读版"（报告库+卡面+原件，不含识别/入库/114）。**触发**：用户书面说"先只上只读版"。**范围随之收窄**：D0-2/D0-3/D0-4 可延后；**但 D0-1（认证闭环）与 P0-2（bind）不可延后**。验收相应改为：不再验"识别链路"，改验"上传入口已关闭"。
- 关键：**降级必须同时改验收清单**，而不是只降优先级。你现在的写法只降了"做什么"，没降"怎么验"⇒ 会出现"只读版上线了，验收还要求验 OCR 链路 → 必然红 → 被人放宽"。

### 3-6 「四段结构 + 留砍延后是否合规？」

**结构合规，留砍延后大体合理**，四处要修：

| 项 | 判 |
|---|---|
| A/B/C/D 顺序与证据锚点 | ✅ 顺序对；锚点**一处不实**（见 P1-5） |
| 留：C1/C3/C4/C5/C6 | ✅（C5 形态待定可接受，但建议直接定 systemd） |
| 延后：C2/C7/C8 | ❌ **C7 不该延后**（P0-1）；C2/C8 合理 ✓ |
| 砍：C9/C10 | ✅ |
| 延后项触发条件 | C2 ✓ 有触发（"用户明确必须全功能 + 给部署方式/资源预算"）、C8 ✓（7 天内 ≥1 次非计划停机）；**C7 无触发**（"用户提供域名"不是触发条件，是前置） |
| 「无法自解」5 条 | ✅ 齐全（部署范围/域名/数据迁移/资源/重启纪律），但**缺"暴露面"与"只读版降级"两条**（P0-4、§3-5） |

### 3-7 「你自己 SSH 只读核一遍」—— 我的实测 vs 计划快照

| 项 | 计划快照 | **我实测** | 差异 |
|---|---|---|---|
| OS/架构 | Ubuntu 22.04.4 x86_64 | 一致；**4 核**（计划未记） | 补充 |
| 内存 | 3.3G / 可用 1.0G | 一致 | — |
| **swap** | **未记** | **4.0G，已用 2.3G** | **计划漏项**（P1-1） |
| 磁盘 | 40G 用 79%、剩 8.2G | 一致 | — |
| Node | 无 node/npm/nvm | 一致 | — |
| 端口 | 5174/8011/8008/8045 空闲；80/443 被占 | **一致** | — |
| 容器 | 8 个（openresty/mysql8.4/redis8.6/es9.4/new-api/xxl-job/shanhai×2） | 一致 | — |
| 防火墙 | INPUT 默认 DROP + SSH 黑名单链 | 一致（`-P INPUT DROP`、多条 `REJECT --dport 22`） | — |
| 1Panel 站点 | "当前无本站站点" | 一致；现存 3 站点：`admin.shanhailingjing.top`、`www.shanhailingjing.top`、`test` | 补充（新站点须避开） |
| openresty 主配置 | 未记 | `client_max_body_size 50m` ✓、**include 1pwaf WAF** | **计划漏项**（P1-7） |
| sudo | 未记 | **`sudo -n` 免密可用** | 补充：部署脚本可非交互 root ⇒ 权限面要收（P1-8） |
| data 体积 | 221M（medbrief.db 82MB） | `du -sh data` = **221M**；`medbrief.db` = **80M** | 小差，不影响 |

**结论：计划快照基本可信**，两处漏项（swap、WAF/body size）已在上文补；无"与实测矛盾"的断言。

---

## 4. P1 清单

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | 资源只写"可用 1.0G"，**漏了 swap 已用 2.3G/4G**；也没给 MedBrief 自身的 RSS 量级 | 补实测（swap 2.3G 已用；本地 RSS 130MB）；systemd unit 加 `MemoryMax=384M` + `Restart=on-failure`；验收加"`journalctl -k \| grep -i 'killed process'` 无记录" |
| **P1-2** | `npm ci（若有 lock）` + "playwright 可不装" ⇒ 实际**没有 lock**，且 playwright 必须装 | 阶段 0 加"生成并提交 `package-lock.json`"；阶段 1 写死 `npm install`（不许省 playwright）；浏览器二进制单列（只在需要 114/PDF 时装） |
| **P1-3** | **B5/B8 正文过期**（仍写"账号线未闭环"、"HEAD c55234d"），与 v0.1a `:90` 台账矛盾 | 正文改成 `adbafc9` 已闭环；这是本线第 N 次"台账认了、正文没改"，建议统一做一遍全文旧值 grep（`c55234d`、`44 行`、`18726ae`） |
| **P1-4** | 阶段 3 的 systemd 步骤没写 `WorkingDirectory` | 写死 `WorkingDirectory=/opt/medbrief`（否则 `path.resolve('data',…)` 会去 `/data` 找库）；验收：`curl /api/health` 后 `ls /opt/medbrief/data/reports.json` |
| **P1-5** | A6 的端点锚点不实：`server.mjs:1661` 是**注释**；实测 **8008 硬编码不可配**、8045 可配 `MEDBRIEF_VISION_ENDPOINT`、8011 的 base URL 未定位 | A6 改成三条链路逐条列"是否可配 + 环境变量名"；8008 若必须远程，需先改代码（进阶段 0 或明确"只读版不接 OCR"） |
| **P1-6** | 只读版上线后**上传/识别入口仍可点**（点了 500） | 加 `MEDBRIEF_READONLY=1`（服务端对识别/入库端点回 501 带明确文案）**或**前端隐藏入口；两条择一写死，进验收（"点识别 → 明确提示，不是超时"） |
| **P1-7** | 漏了 openresty 的 `client_max_body_size`（http 级 50m ✓）与 **1Panel WAF 已启用** | 验收加两条实测：① 5MB 图片 `POST /api/intake/reports` 不 413 ② 含 `'`/`;`/`<` 的文本字段不被 WAF 拦；备好"站点加白"回滚动作 |
| **P1-8** | `sudo -n` 免密可用（我实测）⇒ 部署脚本等于 root | 部署脚本用一次性执行、不落盘（或落 `/root` 600 后即删）；不在仓库里放带 sudo 的脚本 |
| **P1-9** | SECRET 生成/存放/轮转未写；`Secure` cookie 生产未写 | 补 `openssl rand -base64 48` → `/etc/medbrief/env`(600)；明文写"生产 `Secure` 开"；验收断 `Set-Cookie` 含 `Secure` |

---

## 5. 我做了什么 / 没做什么

- **SSH 只读**（4 组，全部 `BatchMode=yes`）：`whoami/hostname/uptime/os-release/nproc/free/swapon/df/node -v/npm -v/ls ~/.nvm/ss -tlnp/docker ps/sudo -n iptables -S/ls /opt/1panel/www/sites/cat openresty 主配置`。**未启动/停止任何服务、未安装任何包、未写服务器任何文件、未改防火墙、未动容器**。
- 本地只读：`grep`/`node -e`/`du`/`ls`（含 `buildCard()` 内存渲染验证"只读版不依赖外部服务"）。
- 只写了 `.agents/deploy-1117-review-r1.md`。
- **需实现方/主理人实测**：`verify-auth.mjs 43/0`（我只读了测试文件存在，未跑——跑它会起服务/建端口，超出"只读"边界）；`npm install` 后 `node server.mjs` 在 Node 22 上的启动自检；`ss -tlnp` 绑定地址断言；WAF/413 两条；OOM 观测。

---

## 6. 复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-2：绑定地址不可配（代码事实）
grep -n "listen(\|MEDBRIEF_BIND\|0\.0\.0\.0" server.mjs            # 仅 :2050 一处 0.0.0.0，无 BIND env

# ② P0-3：playwright 是运行时依赖、且无 lock
grep -n "from 'playwright'" server.mjs lib/*.js | head
node -e "const p=require('./package.json');console.log('deps',p.dependencies,'| lock?',require('fs').existsSync('package-lock.json'))"

# ③ P0-4：数据体积与未脱敏
du -sh data; node -e "const j=require('./data/reports.json');const n=j.reports.filter(r=>String(r.patientName||'').trim()).length;console.log('带 patientName 的报告',n,'/',j.reports.length)"

# ④ 只读版不依赖外部服务（本地内存渲染，零网络）
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const j=JSON.parse((await import('node:fs')).readFileSync('data/reports.json','utf8'));
  console.log('html 长度',buildCard({reports:j.reports}).html.length)"

# ⑤ 外部端点与可配性
grep -n "127.0.0.1:8008\|MEDBRIEF_VISION_ENDPOINT\|MEDREC_BACKEND" server.mjs lib/captchaSolver.mjs

# ⑥ 认证默认值与 fail-closed（B5/C6 现状）
sed -n '77,95p;263p' server.mjs

# ⑦ 数据路径相对 CWD（P1-4 的证据）
grep -n "path.resolve('data'" lib/intakeCard.js server.mjs

# ⑧ SSH 只读复核（服务器侧，勿改）
ssh -o BatchMode=yes -o ConnectTimeout=8 ubuntu@62.234.146.222 \
  'free -h; swapon --show; df -h /; node -v; ss -tlnp | grep -E ":(5174|8011|8008|8045|80|443)\b"; docker ps --format "{{.Names}}"; sudo -n iptables -S | head -4; ls /opt/1panel/www/sites; sudo -n grep -nE "client_max_body_size|include" /opt/1panel/apps/openresty/openresty/conf/nginx.conf | head'
```
