# MedBrief 部署计划 v0.4 · 独立实测审核 r4 判词

> **无项目定制层，仅通用排雷，未覆盖该项目特有的数据/部署雷点**（§7.4；`grep -rlF '**通用层**：~/.agents/skills/plan-review.md' .agents/*.md` 无任何文件在**文件头**声明，与计划自述"定制层：无"一致）。
> 审核者：代诊-挂号（独立会话，不在计划作者上下文；只读审核，唯一写入 = 本文件）。
> 被审物：`.agents/deploy-1117-plan.md` v0.4，HEAD `20caa65`，161 行。输入：`/tmp/medbrief-r4/deploy-1117-review-input-r4.md`（含 r3 终判原文与全文计划）。
> 性质：对 r3「可以开工」的**续期复审**（§8.2b），因 r3 自承未读全文 + 计划改动 `20caa65` + 服务器侧新增事实。

---

## 一、总判（§8.3 第一块）

**总判：`不能直接进下一轮`** —— 现版本存在 **5 条 P0**，需作者整改后**整份重送** r5；本轮**不得开工任何一条**。

| P0 | 一句话 | 可复跑判据 |
|---|---|---|
| **P0-1** | 前端产物在部署路径上**不可得**：`dist-next` 未入库且服务器无法构建 | `git ls-files web/dist-next \| wc -l` → `0`；`grep -n "dist" .gitignore` → `:10 web/dist-next/`；`node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies))"` → `['playwright']`（无 vite）；`package.json` 注释原文：「medbriefFrontendDeps…**不参与 npm install**」；`grep -n "dist-next" server.mjs` → `:1991`（只从 `__dirname/web/dist-next` 取静态） |
| **P0-2** | **暴露面断言口径错，且实测仍有非白名单端口对外开放** | `curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' http://62.234.146.222:8090/` → **`200`**（Content-Length 1410，标题「暂时无法访问」）；同法 9200/3000/3306/6379 → `000`（已关）。计划 `:122` 只断 `ss -tlnp \| grep 5174` |
| **P0-3** | `data/` 整目录投递会把**114 票据/临时件/备份**一起送上公网机 | `ls -la data/` 含 `114-auth.json`（77B）、`data/tmp` 48M、`data/backups` 46M、`data/114-flow` 2.1M、`data/meddata-mirror`；计划 `:114` 写「`data/` 221M 用 rsync…传」，无排除清单 |
| **P0-4** | `:128` 的「CWD 切 /tmp 可百分百杜绝碰生产 data/」是**事实错误**（r3 P1-C 未真闭环，反而被写成了保证） | `sed -n '115p;242p' server.mjs` → `DATA_DIR = path.join(__dirname,'data')`（**不可** env 覆盖）、`REPORTS_FILE = process.env.MEDBRIEF_REPORTS_FILE \|\| path.join(__dirname,'data','reports.json')`。CWD 只影响 `lib/intakeCard.js:28`、`lib/recognitionHits.mjs:19` |
| **P0-5** | 该机**有入侵史**（ES 曾被 Meow 擦库留 `recover_your_database`），计划对「主机是否仍被控」零处置，而 A9/B5 全部安全论证都建立在「这台机器可信」上 | `grep -n "入侵\|勒索\|recover_your_database\|持久化" .agents/deploy-1117-plan.md` → **0 命中**（`:68` 出现的"后门"是 B5 的**认证绕过**语境，不涉及主机被控）；本轮输入 §3-5 已给事实 |

这 5 条不是"风格问题"，每一条都能让上线结果与计划描述不一致：P0-1 → 空白页；P0-2 → 以为收紧了其实还开着；P0-3 → 凭据随数据外泄；P0-4 → 以为隔离了其实在写生产库；P0-5 → HTTPS+auth 在已被控的机器上是无效防线。

---

## 二、逐条闭环核对表（§8.3 第二块）

| 编号 | 意见/攻击点 | 本版落点（文件:行 / 命令） | 判定 |
|---|---|---|---|
| **r3 P1-A** | chromium 调用分支与只读版前提 | `deploy-1117-plan.md:137`（拍板#1 根因）+ `:110`（"必须装 Chromium"） | **⚠️** 根因与我实测一致（`server.mjs:983` 在 `/api/guahao/114/launch-login` 内，`:972-974` 有 503 守卫），但**漏了现成的开关** `GUAHO_BROWSER`（`:127-141`，另有 `data/guahao-browser.flag`）：只读版设 `GUAHO_BROWSER=off` 后**全仓无任何 chromium.launch 可达** ⇒ `:110`"不能跳过浏览器下载"对只读版不成立，两句话互相矛盾 |
| **r3 P1-B** | 1Panel 是否有 Node 进程托管 | `:119`「1Panel 是否具备 Node 进程托管能力需先核实（未取证）」 | **❌** 只写了"要核实"，**没有执行时点、没有失败分支**。补：阶段 3 第 0 步核实 → 失败即默认 systemd（附 unit 模板，含 `WorkingDirectory`/`MemoryMax`/`Environment`），并把 `systemctl status` 作为回滚点判据 |
| **r3 P1-C** | 阶段 4.11 裸 `data` 路径隔离 | `:128`「CWD 切到 /tmp 沙盒…物理隔离 CWD 可百分百杜绝碰生产 data/」 | **❌** 事实错误 → 已升 P0-4。真实隔离靠 `MEDBRIEF_REPORTS_FILE` + `MEDBRIEF_DATA_DIR` 两个环境变量；CWD 仅覆盖 `intakeCard.js:28`/`recognitionHits.mjs:19` |
| **攻击 1** | 只读三链是否还有别的 `chromium.launch()` / 浏览器启动 | `grep -rn "chromium\|playwright\|puppeteer" server.mjs lib/*.mjs lib/*.js meddata/*.mjs` | **✅（附条件）** 全仓仅两处：`server.mjs:39` import / `:983` launch（挂号登录）、`lib/bjcyhScraper.js:6/31`（朝阳官网抓取，经 `/api/guahao/monitor/realtime` → `server.mjs:570`，`:564` 有 `guahaoBrowserOn()` 守卫）。**报告库 `/api/intake/reports`(:1175) / 卡面 `:1571` / 档案 `:1514` / `/api/health` / 静态五条链零命中** ⇒ 「只读版不触发浏览器」成立，但**前提是设 `GUAHO_BROWSER=off`**，否则用户点「出诊监控」就会走到第二处 launch |
| **攻击 2** | `MemoryMax` 依据 | `:119`（**建议 512M**）vs 本轮输入口径 **768M** | **❌** 两处数字不一致；且证据是**本地 Mac** 的「RSS ~130MB」。我实测本机带 98 份真实库的 5174 进程 **RSS 35.2MB**（`ps -o rss= -p $(lsof -nP -iTCP:5174 -sTCP:LISTEN -t)`）⇒ 512M 有 14× 余量，`MemoryMax` 本身不危险；**危险的是一致性**：计划与审核材料对同一参数给了两个值 |
| **攻击 3** | `MEDBRIEF_COMMIT` 会不会让 head 变成可伪造 | `:104`（D0-5⑥）；`grep -rn MEDBRIEF_COMMIT server.mjs lib/*.mjs` → **0 命中**（未实现） | **⚠️** 会削弱审计价值。需三项一起做：① health 增 `commitSource: 'git'\|'env'`；② 部署时写 `.deploy-commit`（commit + 产物 tar 的 sha256），health 只回显不裁决；③ 验收以 `.deploy-commit` 与 `git rev-parse` 双向比对，env 仅作回退路径 |
| **攻击 4** | r3 三条 P1 是否都有"执行时点 + 失败处理" | 见上三行 | **❌** 三条都不完整：P1-A 缺开关、P1-B 缺时点与失败分支、P1-C 是事实错误 |
| **攻击 5a** | 阶段 3.9/3.9b 是否改为外网实测 | `:122`；本轮实测 8090 仍开 | **❌ 必须改**。`ss -tlnp` 只证明"绑在哪"，不能证明"外面能不能进"。改为三段断言：① `sudo ufw status numbered` + `sudo iptables-save` 全量留档，规则里除 22/80/443（及面板 IP 白名单）外**不得有 ACCEPT**；② **外网逐端口实测**（从非本机、无代理主机）；③ 任一非白名单端口可达 → 停线，不许继续阶段 4 |
| **攻击 5b** | 入侵史机器是否需要额外前置 | 计划零覆盖 | **❌ 新增 P0-5**：见第三块第 5 条 |
| **攻击 6** | 新资源数据（20G/1.9G）是否改变结论 | `:31`(A1)/`:54`(A10)/C2 | **⚠️** 改变的是"余量"，不改变"C2 三识别服务上云"的判断 → 明确**建议只读版**，见第三块第 6 条 |

---

## 三、本轮攻击点逐条回答（§8.3 第三块）

### 1. 拍板 #1 的「只读版不含挂号 ⇒ 不触发 chromium」是否自洽

**自洽，但计划少写了一步配置，导致结论过重。** 实测：

- `grep -rn "chromium\|playwright\|puppeteer" server.mjs lib/*.mjs lib/*.js meddata/*.mjs` → 只有 4 行：
  `server.mjs:39`（`import { chromium } from 'playwright'`）、`server.mjs:983`（`chromium.launch`，在 `/api/guahao/114/launch-login` 内，`:972-974` 已有 `guahaoBrowserOn()` → 503 前置）、`lib/bjcyhScraper.js:6`（import）、`:31`（`chromium.launch({headless:true})`，经 `/api/guahao/monitor/realtime` → `server.mjs:570`，`:564` 有同一守卫）。
- 只读三链（`/api/intake/reports` `:1175`、`/api/intake/card` `:1571`、`/api/intake/patient` `:1514`）与 `/api/health`、静态托管均**不触及**任何浏览器代码。
- 打印预览是**前端** `iframe.contentWindow.print()`（`web/src/pages/IntakePage.jsx`），服务端不参与。

⇒ 三条结论：
1. `:137` 的根因分析（`headless:false` + `--window-position` + `activeLoginBrowser` 常驻）与我读码一致，**P1-A 的技术判断成立**。
2. `:110` 的"**不能跳过浏览器下载**"对只读版**过重**：`GUAHO_BROWSER=off`（或 `data/guahao-browser.flag` 内容 `off`）一设，**全仓 chromium 路径全部短路**，`playwright` 包仍要装（顶层 import 会 `ERR_MODULE_NOT_FOUND`），但可 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 省掉 ~300MB 浏览器与 `libnss3/libatk` 依赖。
3. **但**：只读版仍会渲染「出诊监控」tab（`web/src/pages/MonitorPage.jsx:94` 拉 `/api/guahao/monitor/realtime`），用户一点就走到第二处 launch。所以**开关必须写进阶段 2.5 环境变量与阶段 4 验收**（`curl /api/guahao/monitor/realtime` → `disabled:true, code:BROWSER_DISABLED`），否则"只读版"只是"我们不去点"。

### 2. `MemoryMax=512M/768M` 的依据够不够

**数字不够（本地数不能当服务器基线），但 512M 本身不危险；问题是计划与审核材料给了两个值。**

- 计划 `:119` = **512M**；本轮输入攻击点 2 写 **768M** —— 同一参数两个值，必须先统一。
- 证据强度：计划所用「只读版 RSS ~130MB」是 Mac 本机；我实测同一代码 + 98 份真实库的进程 **RSS 35.2MB**（`ps -o rss=`）。两者都说明"远小于 512M"，但都**不是服务器数**（服务器多了 systemd 包装、可能多的 swap 压力、真实并发）。
- 可执行护栏（建议写进阶段 4）：
  1. `MemoryHigh=384M` + `MemoryMax=768M`（软限先触发回收、硬限留余量）；
  2. 验收基线：启动并走一轮只读冒烟后 `systemctl show medbrief -p MemoryCurrent` → **< 300MB 通过**；连续 24h 观测 `MemoryCurrent` 峰值 **< 600MB**；
  3. 失败判据：出现 `MemoryMax` 触发（`journalctl -u medbrief | grep -i 'Memory cgroup out of memory'`）或 `MemoryCurrent` 触及上限 → 停线上调或降范围（关 trends/缩小 data）。
- 结论：`768M 起步 + 实测再调`是**合理护栏**（比 512M 更稳），但前提是**先统一数值、且服务器实测代替 Mac 数**。

### 3. `MEDBRIEF_COMMIT` 会不会让 head 变成可伪造、失去审计价值

**会（若只做这一条）。** 现状：`server.mjs:100-113` 用 `execFileSync('git',['rev-parse','--short','HEAD'],{cwd:__dirname})`，异常回 `head:'unknown'`；`grep -rn MEDBRIEF_COMMIT` = **0 命中**（D0-5⑥ 未实现）。改成 env 注入后，任何能动进程环境的人都能写任意值。

**但审计价值不该由 health 承担**，补三项即闭环：
1. 部署时由部署脚本写 `.deploy-commit`（内容 = commit sha + **产物 tar 的 sha256** + 部署时间 + 执行者），文件 600；
2. health 回显加 `commitSource: 'git'|'env'`，让人一眼看出值从哪来；
3. 验收断言改为「`.deploy-commit` 的 commit == `git rev-parse` == health.head」，三者不一致即停。env 只做"无 `.git` 时的回退路径"，不作唯一真相。

### 4. r3 遗留三条 P1 是否被拍板项真正吸收

| P1 | 是否吸收 | 缺什么（点名） |
|---|---|---|
| P1-A chromium 分支 | **部分**（`:137` 根因写清） | 缺 `GUAHO_BROWSER=off` 这个**现成开关**与它的验收断言；`:110` 的"必须装 Chromium"未按只读版条件化 |
| P1-B 1Panel Node 托管 | **否** | 缺**执行时点**（应放阶段 3 第 0 步）与**失败分支**（无 Node 托管 → systemd unit 模板 + 回滚判据） |
| P1-C 4.11 裸 data 路径 | **否（且写错）** | 缺正确判据：`server.mjs:115` 的 `DATA_DIR` 不可 env 覆盖、`:242` `REPORTS_FILE` 默认 `__dirname`，CWD 管不到；必须 `MEDBRIEF_REPORTS_FILE` + `MEDBRIEF_DATA_DIR` 双设 + 断言实际路径 |

### 5. 新增服务器事实（ufw 曾放开 13 个端口 + ES 曾被擦库）该如何裁决

(a) **3.9/3.9b 必须加"外网实测探测"，且我已有反证**：

```
$ curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' http://62.234.146.222:8090/    # 2026-11-17 14:0x
200
$ curl -s --noproxy '*' -D- -o /dev/null http://62.234.146.222:8090/ | head -4
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Length: 1410                     # 页面标题「暂时无法访问」
```

9200/3000/3306/6379 等已返回不可达（`000`），但 **8090 仍对公网开放**，而部署方口径是"已收紧为只留 22/80/443 + 面板白名单"。⇒ 断言必须改成三段式（规则留档 + 外网逐端口实测 + 任一非白名单端口可达即停），且**"部署方口头说收紧了"不能作为验收证据**。

> 探测口径警告（写进计划，否则下一轮还会有人测错）：本机 DNS 处 fake-IP 模式（`dig +short admin.shanhailingjing.top` → `198.18.1.169`），一切"域名可达"结论都会被代理污染；端口探测必须 **IP 直连 + `--noproxy '*'`**，且最好从**第三方主机**复核（本机出口是否 NAT 到同一机房需确认）。

(b) **需要额外前置，且我建议列为 P0-5**。理由：A9/B5 把安全全押在「HTTPS + auth」上，这**假设主机可信**；而该机有真实入侵痕迹（ES 被擦、留勒索索引 `recover_your_database`）。在这种机器上放 221M 未脱敏病历，最少要做四件事，缺一件就不该上数据：
1. **规则与暴露面留档**：`sudo iptables-save > /root/ir/iptables-$(date +%F)`、`sudo ufw status numbered`、`docker ps -a`、`ss -tlnp` 全量存证；
2. **持久化排查**：`~/.ssh/authorized_keys`（非本人 key 一律清）、`crontab -l` 全体用户、`systemctl list-units --type=service --state=running` 里的陌生 unit、`docker images/ps -a` 里的异常镜像、`find / -perm -4000 -newer /etc/hostname`、以及 `/tmp /dev/shm /var/tmp` 的可执行文件；
3. **全机凭据轮转**（入侵者可能已拿到）：SSH key、1Panel 面板口令、MySQL root、Redis 口令、容器 env 内的 token（`docker inspect` 全扫）；**这也覆盖了此前"SECRET 由谁管"（拍板 #6）的一半**；
4. **数据侧最小化 + 加密**：按 P0-3 排除清单只投必要文件；若拍板 #3 决定原样上生产，则先 `tar czf - | gpg -c` 或 `gocryptfs` 落盘，运行期再解出到 700 目录（明文只在进程可见目录存在）。

如果你认为 (b) 超出"部署计划"范围，正确做法是**在计划里写一行"前置依赖：主机入侵排查（另单）+ 未完成则阶段 2 不开始"**，而不是不写——因为你已经知道这机器被入侵过。

### 6. 资源新数据（20G 磁盘 / 1.9G 可用内存）是否改变结论

**改变了余量，不改变性质；明确建议"只读版"。**

- 磁盘：20G 让"装 Chromium + node_modules + 221M 数据 + 备份快照"变得从容（原 8.2G 下 A8/阶段 0 生成 lock 后 `npm ci` 装 playwright 浏览器约 300–400MB，加上 tar 快照会紧张）；现在**磁盘不再是约束**。
- 内存：1.9G 可用 + swap 已用 2.3G ⇒
  - **只读版**：RSS 实测 35.2MB（Mac）/ 计划口径 130MB，`MemoryMax` 512–768M 有充足余量 → **可行，且建议**；
  - **全功能版**：还要叠 8008/8011/8045 三个识别服务（内存占用 `[未取证]`，OCR 视觉模型常在数百 MB~数 G）+ `headless:false` 常驻浏览器实例（`:137` 已证）→ 在 1.9G 可用 + swap 已紧张的前提下**仍不可行**，除非另给机器或加内存。
- ⇒ 判词口径：**建议只读版**（报告库 + 卡面 + 打印预览），并以 `GUAHO_BROWSER=off` 关掉两处 browser 路径、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 省磁盘与依赖；全功能版（OCR/挂号）另立计划、另要资源预算。

---

## 四、复跑命令清单（本轮全部实测，可复核）

```bash
cd /Users/scallion/Documents/projects/MedBrief

# 攻击点 1：浏览器调用面（应只有 4 行命中）
grep -rn "chromium\|playwright\|puppeteer" server.mjs lib/*.mjs lib/*.js meddata/*.mjs
sed -n '127,141p' server.mjs          # GUAHO_BROWSER 开关
sed -n '972,975p;983,987p' server.mjs # launch-login 守卫 + chromium.launch
sed -n '562,571p' server.mjs          # monitor/realtime 守卫 → bjcyhScraper

# P0-1：前端产物不可得
git ls-files web/dist-next | wc -l    # 0
grep -n "dist" .gitignore             # web/dist-next/ 被忽略
node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies), !!p.devDependencies)"
grep -n "dist-next" server.mjs        # :1991 只认 __dirname/web/dist-next
ls -ld node_modules                   # -> ../MedData/node_modules（软链）

# P0-2 / r3 P1-A 之外的暴露面：外网实测（务必 --noproxy，本机 DNS 是 fake-IP）
for p in 3000 8848 9002 9003 9004 9006 9007 9008 9009 9200 8090 3306 6379; do
  printf "%-6s %s\n" "$p" "$(curl -s --noproxy '*' -o /dev/null -m 4 -w '%{http_code}' http://62.234.146.222:$p/)"
done
curl -s --noproxy '*' -D- -o /dev/null http://62.234.146.222:8090/ | head -4

# P0-3：data/ 组成（凭据与临时件）
ls -la data/; du -sh data/* | sort -h | tail -6

# P0-4：CWD 沙盒是否真能隔离
sed -n '115p;242,246p' server.mjs
grep -rn "path.resolve('data'\|process.cwd()" server.mjs lib/*.mjs lib/*.js

# 攻击点 2：内存基线（本机参考值，服务器须复测）
ps -o rss= -p "$(lsof -nP -iTCP:5174 -sTCP:LISTEN -t | head -1)" | awk '{printf "RSS %.1f MB\n", $1/1024}'

# 攻击点 3：版本回显现状
grep -rn "MEDBRIEF_COMMIT" server.mjs lib/*.mjs || echo "0 命中（未实现）"
curl -s localhost:5174/api/health

# 环境口径：确认本机 DNS 是 fake-IP（否则"域名可达"结论不可信）
dig +short admin.shanhailingjing.top; dig +short example.com
```

---

## 五、给作者的整改清单（r5 输入应按此逐条给落点）

| 编号 | 必须改成什么 | 落点建议 |
|---|---|---|
| P0-1 | 新增"前端产物"步骤：构建机产出 `web/dist-next`（含 `index.html` 与 `assets/*`）→ 打 tar + sha256 → 与 commit 一起 rsync → 验收 `curl -s https://<域名>/ \| grep -o 'assets/index-[A-Za-z0-9_-]*\.js'` 且该 JS 返回 200；并在计划里写明"服务器不构建前端（`package.json` 无 vite，`medbriefFrontendDeps` 不参与 npm install）" | 阶段 1.3 改写 + 阶段 4 验收加一条 |
| P0-2 | 阶段 3.9 改为三段式（规则留档 / 外网逐端口实测 / 任一非白名单端口可达即停），并把"部署方口头收紧"排除在证据之外 | `:122` 重写 + 复跑命令入清单 |
| P0-3 | `data/` 投递改**白名单制**：仅 `medbrief.db`、`reports.json`、`intake/`、`recognition-hits.jsonl`、`guahao-orders.json`；显式排除 `data/tmp`、`data/backups`、`data/114-flow`、`data/meddata-mirror`、`logs`、**`114-auth.json`**、`guahao-browser.flag`；验收 `ls <部署目录>/data \| grep -c 114-auth` = 0 | `:114` 改写 |
| P0-4 | 删除"CWD 可百分百杜绝"表述，改为"CWD 仅覆盖 `intakeCard.js:28`/`recognitionHits.mjs:19`；`DATA_DIR(:115)`/`REPORTS_FILE(:242)` 是 `__dirname` 基准，必须用 `MEDBRIEF_REPORTS_FILE` + `MEDBRIEF_DATA_DIR` 双设并断言实际路径" | `:128` 重写 |
| P0-5 | 新增"前置：主机入侵排查与凭据轮转（另单）"，并写明"未完成则阶段 2 不开始"；同时把数据静态加密/最小化与拍板 #3 绑定 | 阶段 1 之前新增 0.5 节 |
| P1-A | `:110` 条件化：只读版 `GUAHO_BROWSER=off` + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`（不装 Chromium）；全功能版才装；验收 `curl /api/guahao/monitor/realtime` → `disabled:true` | `:110`、阶段 2.5、阶段 4.10b |
| P1-B | 阶段 3 第 0 步：核 1Panel Node 托管 → 失败即 systemd（附 unit 模板 + 回滚判据） | `:119` 扩写 |
| 攻击点 2 | 统一 `MemoryHigh/MemoryMax` 数值（建议 384M/768M），并把验收基线改成服务器实测（`systemctl show -p MemoryCurrent`） | `:119`、A10 `:54` |
| 攻击点 3 | `.deploy-commit` + `commitSource` + 三方比对 | D0-5⑥ `:104` |
| 攻击点 6 | 明确"建议只读版"及理由，作为拍板 #1 的依据 | 拍板 #1 `:137` |

---

**本判词「不能直接进下一轮」**：以上 5 条 P0 全部改完，作者整份重送 r5（§8.2b，含「上轮 P0 关闭台账」）。**即便 r5 判「可以开工」，也不等于授权动服务器** —— 仍受 G6（用户一句「按以上计划执行」）与 10 项拍板约束。
