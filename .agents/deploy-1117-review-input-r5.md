# 送审输入 —— MedBrief 生产部署计划 · r5（续期复审，整份重送）

> **上轮终判原文（§8.2b 强制首行，逐字粘贴 r4「一、总判」）**：
> 「**总判：`不能直接进下一轮`** —— 现版本存在 **5 条 P0**，需作者整改后**整份重送** r5；本轮**不得开工任何一条**。」
>
> 这是对 r4 终判的复审。上轮判词：`.agents/deploy-1117-review-r4.md`（独立实测审核「代诊-挂号」，186 行）。本版计划：`.agents/deploy-1117-plan.md` **v0.5**（161→约 175 行）。审核者：同一独立 Bot「代诊-挂号」（续期复审，同审核线）；只读、只写 `.agents/deploy-1117-review-r5.md`。

## 一、上轮 P0 关闭台账（§8.2b 强制件，逐条）

| 上轮 P0 | 本版落点（v0.5） | 状态 |
|---|---|---|
| **P0-1** 前端产物不可得（dist-next 未入库、服务器无 vite → 空白页） | A11 + D0-5⑦ + 阶段 1.3/1.4 + 阶段 4.10：构建机产出 dist-next + sha256 随投递、服务器不构建；assets JS 200 验收 | ✅ |
| **P0-2** 暴露面口径错（审核者测 8090→200 判未收紧） | **运维误报纠正（我复核属实）**：ufw 8090 只 ALLOW 两个运营 IP（含审核者出口），我从非白名单测 `000` 连不上。但采纳其方法论：阶段 3.9 改三段式（规则全量留档 + 非白名单来源逐端口 IP 直连 `--noproxy '*'` 实测 + 任一可达即停），并写 fake-IP 探测口径警告（本机 `dig admin...`→198.18.x.x 污染域名探测）。 | ✅ 纠正+收紧 |
| **P0-3** data/ 整目录投递带 114 票据/tmp48M/backups46M | 阶段 2.5 改**白名单制**：只投 reports.json/medbrief.db/intake/**，明确排除 114-auth.json、data/tmp、data/backups、114-flow、meddata-mirror、*.log | ✅ |
| **P0-4** "CWD 切 /tmp 百分百杜绝碰生产 data/"是事实错误 | 阶段 4.11 订正：`server.mjs:115` DATA_DIR 不可 env 覆盖、`:242` REPORTS_FILE 默认 `__dirname`，CWD 只影响 intakeCard/recognitionHits；真实隔离 = `MEDBRIEF_REPORTS_FILE`+`MEDBRIEF_DATA_DIR` 双设 + 断言实际路径；删"CWD 百分百杜绝"错误表述 | ✅ |
| **P0-5** 入侵史主机缺前置（ES 被 Meow 擦库留勒索信） | A12 + 阶段 2.6b：列为阶段 2 硬闸（未完成不投数据）——规则留档/持久化排查/全机凭据轮转/数据最小化+传输加密；运维已完成 ufw 13 条删除、bot 清库、ES 下线留证、备份 cron 等；唯一待用户定 `root@VM-66-189-ubuntu` key 是否删除 | ✅ 列为前置依赖 |

## 二、上轮 3 条高价值修正关闭台账

| 修正 | 落点 | 状态 |
|---|---|---|
| GUAHO_BROWSER 现成开关（只读版设 off → 全仓无 chromium 可达，可跳过浏览器下载） | 阶段 1.3/2.6/4.10b：`GUAHO_BROWSER=off` + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` + 验收 `curl /api/guahao/monitor/realtime`→`disabled:true,BROWSER_DISABLED`；删原"必须装 Chromium" | ✅ |
| MemoryMax 口径不一致（512M vs 768M） | 阶段 3.7 统一 **MemoryHigh=384M + MemoryMax=768M**，全文删 512M；阶段 4 用服务器 MemoryCurrent 实测再调 | ✅ |
| MEDBRIEF_COMMIT 可伪造 | D0-5⑥ + 阶段 4.10：health 加 `commitSource`、部署脚本写 `.deploy-commit`(commit+产物sha256+时间+执行者,600)、三方比对，env 仅回退不作唯一真相 | ✅ |

## 三、本轮必攻击点

1. 5 条 P0 关闭是否真到位（逐条 grep v0.5 正文，尤其 P0-2 纠正是否有证据、P0-4 错误表述是否真删干净）？
2. P0-5 主机前置列成"阶段 2 硬闸 + 另单"是否正确——它现在是卡在用户拍板还是运维执行？记账是否清楚（哪些运维已做、哪些待用户定）？
3. GUAHO_BROWSER + PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 是否真能让只读版完全不装 Chromium（含出诊监控第二处 launch）？
4. v0.5 有没有新的自相矛盾（如 D0-5⑦ 构建机产物 vs 阶段 1 服务器不构建、MemoryMax 统一后是否还有旧值残留）？
5. r3 的"可以开工"被 r4 推翻、r5 整份重送的轮次与首行判词原文是否合规？

## 四、硬约束（不变）
G6（用户"按以上计划执行"后才部署）、真库零写入、禁 rm -rf/放宽SSH/暴露5174、重启走面板、不动 admin/www/test 三生产站点、10 项拍板（#1/#8/#10 卡阶段 0）。

## 五、判词要求
只写 `.agents/deploy-1117-review-r5.md`，三块齐全（总判三档之一 + 逐条闭环核对表 + 攻击点逐条回答+复跑命令）。若 P0 清零给"可以开工"并注明仍受 G6+拍板约束；若有新 P0 列落点。
