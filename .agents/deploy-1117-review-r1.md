# MedBrief 生产部署计划 · AI审核 r1（AI Studio 逻辑预审 + 实现方实测订正）

> 审核通道：`ai_scheme_review.py --session-key MedBrief/deploy-1117`，session url https://aistudio.google.com/prompts/1PwtT6Ong3123r8M7-tiZ3Fl_iZT_XDyn
> 用户口径：必须用 AI Studio 工具；因该端无本地文件/SSH 能力，经用户选「把取证材料嵌进 prompt」，以下为**基于所给文本的逻辑预审，非独立实测**（AI Studio 原声明）。判词由实现方据其意见人工落盘；另附实现方对可证伪条的 SSH/代码实测订正。
> 被审：`.agents/deploy-1117-plan.md` v0.2a；送审材料：计划全文 + 代码事实 + SSH 快照嵌入 prompt（24KB）。

---

## 一、AI Studio 原始判词（逻辑预审，原文照录）

声明：这是基于所给文本的逻辑预审，非独立实测（本端无本地仓库与 SSH 执行工具，所有代码行号、服务器快照及测试结果均直接引用你嵌入的取证文本，未独立复跑验证）。一、总判（§8.3 第一块）总判：不能直接进下一轮（存在 4 项 P0 阻断问题，需修订并补充 2 处只读取证后重送；同时有 6 项 P1 须一并落入计划）。P0 清单（必须清零才能进下一轮）P0-1｜1Panel-openresty-p1ke 容器网络模式未取证，与 MEDBRIEF_BIND=127.0.0.1 存在 502 死锁风险（锚点：A7、C3、阶段 3.8）计划 A7 自己指出「同机 8 个 Docker 容器走 172.18.0.0/16 网桥」，同时强制 Node 只绑 127.0.0.1:5174，而 C3/阶段 3.8 让 1Panel-openresty-p1ke 反代 http://127.0.0.1:5174。逻辑致命点：若 1Panel-openresty-p1ke 运行在 bridge（172.18.0.0/16）而非 host 网络模式下，容器内的 127.0.0.1 是容器自身而非宿主机，反代必出 502 Connection refused；而 1Panel-openresty-p1ke 的 NetworkMode 当前 [未取证]。P0-2｜阶段 0 与阶段 1 的代码变更顺序自相矛盾（锚点：阶段 0 D 段 vs 阶段 1.3 / 1.4）阶段 0 规定「只有 D0-2~4 闭环……+ 部署 commit 钉死，才进入阶段 1」，但阶段 1.3（生成并提交 package-lock.json、只读版关上传/识别入口「需 UI 规格」）和阶段 1.4（改 server.mjs:2050 加 MEDBRIEF_BIND 单独 commit）全是在改变仓库代码。既然阶段 1 还在改代码、等 UI 规格，阶段 0 就不可能先钉死部署 commit。所有代码/lock/只读开关改动与 verify-* 复测必须收口进阶段 0。P0-3｜阶段 4.10 冒烟步骤直接违反 B6/G7「生产库零写入」，且与只读版冲突（锚点：B6、G7、阶段 4.10 vs 4.11）阶段 4.10 无条件要求在生产域名执行 登录 → 建报告 → 出卡 → 打印预览（仅给「识别链路 8008/8011/8045」加了 (若 C2 落地)）。这导致双重矛盾：① 在生产库上执行「建报告」会直接写入测试脏数据，违反 B6「绝不拿生产库跑测试 / 健康检查不写库」；② 在只读版（阶段 1.3 已关上传/识别入口）下，该动作大概率报错或无定义。P0-4｜把未证实的代码能力当作「部署侧配置」，且 A9 与拍板 #6 自相矛盾（锚点：A9、B5、阶段 3.8、阶段 4.12、拍板 #6）B5 和阶段 4.12 要求部署侧做到「生产 Secure cookie + 反代传 X-Forwarded-Proto + 首登改密与口令策略生效」。但嵌入的代码事实只证实了 MEDBRIEF_AUTH、MB_SESSION_SECRET 与 admin/users 闭环，完全未取证 server.mjs 是否实现了 Secure cookie 开关、X-Forwarded-Proto 信任及「首登改密/口令策略」（正如同上轮 A7 假定能通过配置绑 127.0.0.1 一样，若代码没写，部署配置配不出来）。同时，阶段 3.8 实操里漏写了 B5 要求的 X-Forwarded-Proto 反代头配置；A9 写「生产至少：HTTPS + 来源限制/VPN」，拍板 #6 又改成二选一「公网直连 + auth 还是叠加白名单/VPN」，口径冲突。P1 摘要（须同步补全进计划）P1-1（阶段 2.4）：data/「落盘权限 600」未区分目录与文件——若目录被设 600（无 +x 执行位），服务将 EACCES 无法访问库，须明写「目录 700、文件 600」。P1-2（阶段 3.7 vs B7）：MemoryMax= 缺具体数值；B7 坚持「重启走 1Panel 面板」，但阶段 3.7 仍默认推 systemd（且服务器 1Panel 是否具备 Node 进程托管功能 [未取证]）。P1-3（阶段 1.3 vs 资源）：server.mjs:39 顶层 import playwright，计划未核实只读版出卡/打印预览/门禁测试是否真会调用 chromium.launch()。若不调用，应显式配 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 省磁盘与依赖；若调用，需补充安装系统依赖与浏览器二进制，并重估 1.0G 内存与 8.2G 磁盘余量。P1-4（阶段 4.10 / 4.11 & D0-1）：① 阶段 4.11「用副本库跑 verify-*」未写明如何隔离端口（避开 5174）与隔离 DATA_DIR（防误写生产 data/），且文本未见 verify-card-module1 (9/0) 的前置取证依据；② 阶段 4.10 /api/health 依赖 head=<部署commit>，若部署未带 .git 或未注入版本环境变量会取不到；③ D0-1 仍写 5174 head=adbafc9，与页眉/B8 的 6c3e424 冲突。P1-5（阶段 3.8 / C7 细节）：未核查 *.shanhailingjing.top 通配符解析/AAAA/CDN 代理、未明确 ACME HTTP-01 验证路径 /.well-known/acme-challenge/ 避开反代 / 与 1Panel WAF、未要求确认 medbrief 证书独立于 admin 证书。P1-6（拍板清单漏项）：7 项待拍板漏了「D0-2~4 在本版是全等还是显式裁剪」以及「只读版关上传/识别入口的具体实现与归属（需 UI 规格）」。二、逐条闭环核对表（§8.3 第二块）上轮意见（r1 / 复核要点）本版（v0.2a）落点状态核对说明A7：server.mjs:2050 硬编码 0.0.0.0，无 bind 开关A7 + 阶段 1.4 + 阶段 2.5 + 阶段 3.7/3.9⚠️开关方案对，但改动放错了阶段（阶段 0 钉死 commit 后才在阶段 1.4 改代码）；且未取证 OpenResty 容器是否同在 bridge 网桥（见 P0-1）。A8：无 package-lock.json 导致不可复现A8 + 阶段 1.3⚠️已补必须生成并提交 lock + npm ci，但同样错放在阶段 1 而非阶段 0。A8：playwright 顶层 import，不可 --omit=devA8 + 阶段 1.3⚠️已禁止 --omit=dev；但漏了「是否需要下载 Chromium 浏览器二进制及系统库 / 是否加 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1」。A9：API 原始 JSON 不脱敏，公网不能只靠 auth onA9 + B5 + 阶段 4.12 + 拍板 #6⚠️风险点写明；但 A9「至少来源限制/VPN」与拍板 #6 矛盾，且 Secure cookie / 首登改密 代码支撑 [未取证]。A10：Swap 已用 2.3G、3 站点避让、sudo -n 免密、WAF/50mA10 + 阶段 3.7 / 3.9 / 3.9b⚠️事实已补齐；但 MemoryMax= 无数值，且 sudo -n 等于 root 的限制与「阶段 1/3 具体谁用 root 跑」未细化到单步。Node 版本：node:sqlite 需要 ≥22.5，apt 旧版不可阶段 1.1✅已修正为 NodeSource/nvm 装固定版本且明示 ≥22.5 硬下限。WorkingDirectory 未设会去找 /data阶段 3.7✅已写入 systemd 必填项（若拍板选 1Panel 托管，须在对应面板字段同步落位）。阶段 0「若上只读版可降 D0 优先级」给自己开后门阶段 0 D 段 + 拍板 #1⚠️已删除原开后门句；但把只读版入口关闭留成了未归口的「需 UI 规格」，且 7 项拍板漏了 D0-2~4 裁剪表态。只读版需关上传/识别入口并收窄验收阶段 1.3 + 阶段 4.11⚠️收窄原则已写，但阶段 4.10 冒烟仍无条件要求「建报告」，且未定义「入口已关闭」的验收断言。C7 域名/证书被判延后导致依赖倒置C7 + 阶段 3.8 + 拍板 #2✅已改为前置并确定新子域名 medbrief.shanhailingjing.top，明确不


## 二、实现方实测订正（对可证伪条逐条复跑，不盲信逻辑预审）

| 判词条 | AI Studio 结论 | 我实测 | 裁定 |
|---|---|---|---|
| P0-1 openresty 网桥 502 死锁 | NetworkMode 未取证，若在 bridge 则 127.0.0.1 反代必 502 | `sudo docker inspect 1Panel-openresty-p1ke --format '{{.HostConfig.NetworkMode}}'` → **host**；容器内 127.0.0.1 即宿主机 loopback | **不成立（实测排除）**，但把"host 模式已实测"补进计划消除隐患 |
| P0-4 Secure cookie/XFP/首登改密代码支撑 | 未取证，可能配不出来 | `grep -niE 'secure:|x-forwarded-proto|firstLogin|mustChange|password.*policy' server.mjs lib/*.mjs` → **零命中** | **成立**：代码没实现，部署配置配不出来 ⇒ 列为代码前置（归账号线）或降为"仅 HTTPS 传输层 + auth"并书面接受风险 |
| P0-2 阶段 0/1 代码顺序矛盾 | 阶段 1 还在改代码却要求阶段 0 钉死 commit | 纯逻辑核对，计划阶段 1.3/1.4 确在改仓库代码 | **成立** |
| P0-3 冒烟写生产库 | 阶段 4.10 建报告违反 B6/G7 | 计划阶段 4.10 确无条件写"登录→建报告" | **成立** |

## 三、复跑命令清单
```bash
ssh -o BatchMode=yes ubuntu@62.234.146.222 "sudo -n docker inspect 1Panel-openresty-p1ke --format '{{.HostConfig.NetworkMode}}'"   # → host
cd /Users/scallion/Documents/projects/MedBrief && grep -niE "secure:|x-forwarded-proto|firstLogin|mustChange" server.mjs lib/*.mjs   # → 空
```
