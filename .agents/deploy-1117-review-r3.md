# MedBrief 生产部署计划 · AI审核 r3 终判（同 session 续聊，逻辑预审 + 实现方自检）

> 通道：`ai_scheme_review.py --session-key MedBrief/deploy-1117` r3；判词为**逻辑预审非独立实测**（AI Studio 原声明）；实现方另跑了 r3 给的三条自检命令核实落盘完整性与 P1。
> 被审：`.agents/deploy-1117-plan.md` v0.4。

---

## 一、AI Studio r3 原始判词（原文照录）

声明：这是基于所给文本的逻辑预审，非独立实测（本端无本地仓库与 SSH 执行工具；且因输入长度限制，本轮基于你嵌入的 v0.4 修订台账与实测证据做逻辑核对，未独立读取完整 .agents/deploy-1117-plan.md 原文）。一、总判（§8.3 第一块）总判：可以开工（逻辑预审视角下，上轮遗留的 P0-A、P0-B 均已闭环销号，无新增 P0；剩 3 项可纳入开工前置核验的 P1，且计划本身已为之预留分支）。强制约束声明（G6 + 10 项拍板门）：本判词「可以开工」仅代表部署计划文档在逻辑上通过预审，不等于授权动服务器（G6：须待用户明确回复**「按以上计划执行」**，且 10 项拍板全部落定后，才可按「阶段 0 → 阶段 1~4」推进）。二、逐条闭环核对表（§8.3 第二块）上轮（r2）遗留 P0 / P1本版（v0.4）落点 + 实测证据状态复核结论P0-A：v0.3 的 A9/B5/阶段 2 正文未同步 D0-5④（仍强制写 Secure cookie/首登改密/至少 VPN）；拍板清单漏 #10；文末仍写 7 项/r1① A9 改为 HTTPS+auth 底座、会话加固走 D0-5④、VPN 归拍板 #6；② B5 改写「代码零命中、反代仅 80→443 301 不冒充加固」；③ 阶段 2 删除已配 Secure cookie/XFP 假述；④ 拍板清单增 #10；⑤ 文末改为 10 项/r3✅五处逻辑口径完全一致，销号（因本轮未贴 v0.4 全文，需你在本地按文末命令跑一次关键字自检，确保文档再无其他段落残留旧词）。P0-B：阶段 4.11 依赖 MEDBRIEF_DATA_DIR 未取证，有误写生产 data/ 风险grep -rn MEDBRIEF_DATA_DIR lib/ 实证 accounts.mjs:18、blobStore.mjs:13、correctionsStore.mjs:23 均支持；verify-auth（43/0）与 verify-card-inject（12/0）已用该变量+独立端口跑通；4.11 写入 MEDBRIEF_REPORTS_FILE 副本库✅实测证据充分，销号（建议顺手按 P1-C 确认 server.mjs 与 verify-card.mjs 无绕过该变量的裸 'data' 写路径，或直接切 /tmp 沙盒 CWD 跑 4.11）。P1-A（原 P1-3）：chromium.launch() 在只读版是否触发仍未核实阶段 1.3 已保留双分支（不调则跳过下载，调则补依赖并重估资源）⚠️计划分支完备，不阻断定稿；进入阶段 1 前须跑 1 次 grep chromium 确定分支。P1-B（原 P1-2/4.13）：1Panel Node 托管能力未核实；4.13 回滚仅写 systemd stop列入拍板 #5 前置待核⚠️计划已标注待核，不阻断定稿；执行拍板 #5 前须 SSH 只读确认 1Panel 是否支持 Node 托管与 env 注入。P1-C（原 P1-4/攻击点4）：D0-3 裁剪时 verify-card-module1 须同步跳过阶段 4.11 收窄原则已存在⚠️建议拍板 #8 若选裁剪 D0-3，执行时显式标记 4.11 跳过 verify-card-module1。三、本轮攻击点逐条回答 + 复跑命令清单（§8.3 第三块）攻击点逐条回答1. P0-A 五处口径是否真一致、有无第 N 次「台账认了正文没改」？基于你嵌入的 v0.4 五处修改原文，口径已全部对齐、无逻辑打架：A9（底座+选项）↔ 拍板 #6（白名单/VPN 二选一）对齐；B5（反代只做 80→443 的 301，不冒充会话加固）↔ 阶段 2（删掉 Secure cookie/XFP 假已配）↔ D0-5④ ↔ 阶段 4.12（如实记账代码未实现）对齐；（附注核对）你提到的「其余关键事实：域名段已写 XFP 转发」与 B5 并不矛盾——OpenResty 层转发 X-Forwarded-Proto 属标准代理头，只要 B5 明确「不冒充会话加固」即可，若未来 D0-5④ 补码还可直接复用；拍板 #10 补齐了 D0-5④ 的决策出口，文末同步更新为 10 项 / r3。边界提示：因本轮未粘贴 v0.4 全文，本结论前提是「.agents/deploy-1117-plan.md 全文已完整合入这 5 处修改且无其他未贴段落残留旧词」（下方命令 #1 可 3 秒自检）。2. P0-B 实测证据是否足以销号？足以销号。 三个核心存储模块（lib/accounts.mjs:18、lib/blobStore.mjs:13、lib/correctionsStore.mjs:23）均已被 grep 实证优先读取 process.env.MEDBRIEF_DATA_DIR，加上 MEDBRIEF_REPORTS_FILE 覆盖报告文件库，且 verify-auth.mjs（43/0）与 verify-card-inject.mjs（12/0）已在独立端口实跑通过，说明隔离机制是真实可用而非假设。执行期防呆建议（P1-C）：生产环境实施阶段 4.11 时，除配置 MEDBRIEF_DATA_DIR、MEDBRIEF_REPORTS_FILE 与独立端口外，建议把工作目录也切到 /tmp/medbrief-verify/（与 /opt/medbrief 物理隔离），可百分之百杜绝 verify-card.mjs 或 server.mjs 内任何潜在相对路径碰触生产 data/。3. 两审核通道记账是否清楚可追溯？清楚、可追溯。独立 Bot 实测判词已改名为 .agents/deploy-1117-review-r1-bot.md，彻底解除了与 AI Studio 审核文件名的冲突；AI Studio 逻辑预审（r1→r2→r3，同 --session-key MedBrief/deploy-1117）与 Bot 实测判词的各自边界（逻辑预审 vs 实测订正）在计划与台账中均记账明确。4. 「可以开工」仍受 G6 与 10 项拍板约束——哪些是拍板后才能执行的硬前置？必须先等用户给出「按以上计划执行」+ 10 项拍板全部落字，再按以下硬前置链依次解锁（严禁跳步）：拍板决定阶段 0 代码范围（硬前置，未闭环不进阶段 1）：拍板 #1 + #8 + #9（全功能 vs 只读版、D0-2~4 等做完还是裁剪、只读版入口关闭 UI/后端实现与归属）→ 决定阶段 0 要完成哪些业务代码与入口关闭 commit；拍板 #10（D0-5④ 会话加固「补代码」还是「书面文字接受仅 HTTPS+auth 风险」）→ 若选补代码，须等账号线补齐 Secure cookie / XFP / 口令策略 并复测；若选不补，须先取得书面风险确认；以上定案后，在 阶段 0 D0-5 完成 package-lock.json、MEDBRIEF_BIND 及全量 verify-* 副本库复测，钉死唯一部署 commit。拍板决定阶段 1~3 运行与数据形态（硬前置，未定案不动服务器）：拍板 #3 + #4（221M 真库是否原样迁还是脱敏、资源超限应对）→ 决定阶段 2 数据传前是否脱敏及阶段 1 是否要加内存/走只读版；拍板 #5（systemd vs 1Panel 托管，配合下方 1Panel 只读核实）→ 决定阶段 3.7 进程守护与 4.13 回滚操作；拍板 #6（是否叠加白名单/VPN、SECRET 托管轮转人）→ 决定阶段 2/3 访问控制配置；拍板 #2（用户完成 medbrief.shanhailingjing.top DNS A 记录解析至 62.234.146.222）→ 阶段 3.8 建站与申请独立证书的硬前置；拍板 #7（本轮 r3 即为 AI Studio 审核门，审结后归档留痕）。5. 还有无新 P0/P1？无新 P0。仅余上表 3 项可随执行前置一并消化的小 P1（不构成重送下一轮审核的障碍）：P1-A：阶段 1 前 grep 确认 chromium.launch() 是否被只读版/打印调用（决定是否加 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1）；P1-B：拍板 #5 前 SSH 只读核实 1Panel 进程托管能力，并使阶段 4.13 回滚步骤与最终托管方式一致；P1-C：确认 verify-card*.mjs 在阶段 4.11 无裸 'data' 写路径，且若 D0-3 裁剪则跳过 verify-card-module1。复跑命令清单（仅用于自检 v0.4 落盘完整性 + 执行前 2 项 P1 只读核验） code Bashdownloadcontent_copyexpand_less# 1. 本地自检 v0.4 计划文件无 P0-A 旧词残留（防文件内遗漏段落）
cd /Users/scallion/Documents/projects/MedBrief
grep -nE "首登改密|cookie Secure|生产 cookie Secure|至少：HTTPS.*VPN|上面 7 项|重跑 r1" .agents/deploy-1117-plan.md

# 2. 本地只读补证 P1-A / P1-C（确认 chromium 调用链、server.mjs 无裸 data/ 写路径）
grep -rn "chromium\|playwright" server.mjs lib/*.mjs tests/*.mjs
grep -rn "path\.resolve.*data\|path\.join.*data" server.mjs tests/verify-card*.mjs

# 3. 服务器只读补证 P1-B（配合拍板 #5：确认 1Panel 是否具备 Node 进程守护能力）
ssh -o BatchMode=yes -o ConnectTimeout=8 ubuntu@62.234.146.222 '
  1pctl version 2>/dev/null || true
  ls -la /opt/1panel/runtime/ /opt/1panel/apps/ 2>/dev/null || true
'结论收口：逻辑预审 P0 清零，准予按 G6 + 10 项拍板定案 + 阶段 0~4 门禁顺序 推进。未获用户「按以上计划执行」及 10 项拍板定案前，仍保持服务器零变更。


## 二、实现方自检结果（落实 r3 的三条 P1 与核对要求）

| r3 要求 | 我实测 | 结论 |
|---|---|---|
| 自检1：P0-A 旧词残留 | `grep -nE '首登改密|cookie Secure|...'` 命中 7 行**全是"代码未实现/不写为已配/二选一"的正确描述**，无"必须配好"旧口径 | ✅ P0-A 五处口径真一致 |
| P1-A：`chromium.launch()` 是否被调用 | `server.mjs:983` **确实调用** `chromium.launch()` | **分支确定=调了** ⇒ 阶段 1.3 不能设 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，必须装 Chromium 二进制 + 系统依赖，并重估 1.0G 内存/8.2G 磁盘 |
| P1-C：裸 data/ 写路径 | `server.mjs:115` `DATA_DIR=__dirname/data`、`server.mjs:242` `REPORTS_FILE=env \|\| __dirname/data/reports.json` | 阶段 4.11 副本库测试须**同时**设 `MEDBRIEF_DATA_DIR`+`MEDBRIEF_REPORTS_FILE`+独立端口+**CWD 切 /tmp 沙盒**（采纳 r3 防呆建议） |
| P1-B：1Panel Node 托管 | 未在此轮核（属拍板 #5 前置，执行前 SSH 只读确认） | ⚠️ 留作拍板 #5 前置 |
| G6 | r3 判词明确"可开工"仅逻辑预审通过，须用户「按以上计划执行」+10 项拍板定案 | ✅ 已写进计划文末 |
