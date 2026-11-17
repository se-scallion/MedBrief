# 账号系统 + 权限设计 · 独立审核 **r5**（plan-review §8.3 · 续期复审）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/account-system-1116-plan.md` **v0.5**（339 行，精准编辑）。
> 输入：`.agents/account-system-1116-review-input-r5.md`（r4 终判原文 + 1 P0 / 6 P1 关闭台账 + 8 条必攻击点）与 `.agents/account-system-1116-review-input-r5-addendum.md`（用户确认位数 11 位 + Q2/Q3/Q5/Q6 仍未答，审核进行中到达，按 §8.2 并入本轮）。
> 上轮判词：`.agents/account-system-1116-review-r4.md`（总判「不能直接进下一轮」，1 条 P0 + 6 条 P1）。
> 未改计划/代码、未提交、未动 `data/`。只做只读 `grep`、`node -e` 路径模拟、3 条只读 GET。**只写了本文件**。

---

## 0. 总判：**不能直接进下一轮** —— 1 条 P0

**先说结论里的好消息：静态洞真的闭上了。** 9c 被写死删除、containment 锚回 `__dirname`、判定边界改成"`!inDist && 文件真实存在` ⇒ 403"，我逐字模拟 20 种 rel + 现网取证，**敏感路径全部 403**（`data/*`、`DATA/*`、`web/../data`、`.git/config`、`.agents/MEMORY.md`、`web/index.html`、`web/src/App.jsx`、`web/src/pages/IntakePage.jsx`、`SERVER.MJS`、`lib/*.mjs`、`package.json`），`assets/*` 由 9a 先行服务不受影响。**P0-A 的实质漏洞闭合。**

但 G3 里那条新加的 `/index.html` **必须 403** 的断言，**在删掉 9c 之后永远不可能成立**——`/index.html` 会被 9a 当作 dist-next 里真实存在的文件直接服务。我实测现在是 `200 / 675 B`（正是 `web/dist-next/index.html` 那个 SPA 壳），不是 r4 里那 84 KB 旧工作台。

| # | P0 | 一句话 | 证据 |
|---|---|---|---|
| **P0-1** | **G3 的 `/index.html` = 403 是一条永远红、不可能绿的断言** | `/index.html` 在 9a 就被 `path.join(distDir,'index.html')` 命中并 200 返回（今天实测 675 B = SPA 壳）；只有 9c 才会返回 84 KB 旧工作台。作者"自跑 8 类全 403"与这条不符——**申报的实测结论与真实代码路径相反** | §1，现网 GET + 9a 代码 + 20-rel 模拟 |

这条的性质与前几轮反着来但同源：前面是"洞开着而门禁全绿"，这次是"门禁红在一个根本没坏的地方"。**判据恒红的下场一定是被人放宽到恒绿**（本线已经走过一次 G1），所以当 P0 修；改起来只有一行：把 `/index.html` 换成 `/web/index.html`。

---

## 1. P0-1：`/index.html` 不可能 403 —— 而且这恰好说明 9c 洞是真的

### 1.1 为什么 `/index.html` 是 200

`server.mjs` 的两条静态分支顺序是固定的：

```js
// 9a（:1765-1772）—— 先执行，按 distDir 解析
if (rel && !rel.startsWith('..')) {
  const assetPath = path.join(distDir, rel)          // rel='index.html' ⇒ web/dist-next/index.html
  if (assetPath.startsWith(distDir) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
    serveStatic(req, res, assetPath); return          // ← 命中，200
  }
}
```

`web/dist-next/index.html` **真实存在（675 B）**，所以 `GET /index.html` 在 9a 就返回了，**根本走不到**计划新写的闸门（闸门在"9a/9b 之后"），更走不到 9c。

**现网实测（只读 GET，5174，刚才跑的）**：

| URL | 状态 | 字节 | 是什么 |
|---|---|---|---|
| `/` | 200 | 675 | dist-next SPA 壳 |
| `/index.html` | 200 | **675** | **同一份 SPA 壳（9a 服务）** |
| `/web/index.html` | 200 | 338 | 仓库里的 dev shim（**只有 9c 能送出去**） |
| `wc -c index.html`（仓库根） | — | **84640** | 旧工作台（`/legacy`，`:194` 定为 admin） |

对照 r4 我报的 `/index.html` = **200 / 84640 B**：那一次它确实是旧工作台——说明**当时 9c 抢先/独占服务了这个路径**（现在 9a 先命中）。两种读法都指向同一件事：**9c 那个洞是活的、可达的、内容随文件状态漂移**。删掉 9c 之后 `/index.html` 恢复成"只是 SPA 壳"，**这不是漏洞**（`/` 本来就公开给它）。

### 1.2 20-rel 模拟（9a → 闸门 → 9d 全链路，v0.5 代码逐字求值）

```
''                           → 9d  index.html 200（首页）        ✅
index.html                   → 9a  200 / 675B（SPA 壳）          ← G3 却要求 403 ✗
data/reports.json            → 403（!inDist && 真实存在）        ✅
%64ata（解码后 data/…）      → 403                               ✅（解码在 :1763，闸门用解码后的 rel）
DATA/reports.json            → 403                               ✅（realpath + existsSync 双保险）
web/../data/reports.json     → 403                               ✅（path.resolve 规范化）
.git/config                  → 403                               ✅
.agents/MEMORY.md            → 403                               ✅
web/index.html               → 403                               ✅（9c 专用金丝雀）
web/src/App.jsx              → 403                               ✅
web/src/pages/IntakePage.jsx → 403                               ✅
lib/blobStore.mjs            → 403                               ✅
package.json                 → 403                               ✅
SERVER.MJS                   → 403                               ✅（大小写变体也挡）
assets/index-Dhctrm9M.js     → 9a 200（正常资产，不受影响）       ✅
favicon.ico / reports / LICENSE / docs/images/x.png → 9d index.html 200   ✅（不存在 ⇒ 不误伤）
```

**"第三类路径"（你问的三角关系）我逐类过了一遍，没有误伤**：
- ① dist-next 里**存在**的文件 → 9a 先返回（闸门执行不到）；
- ② 仓库里**存在**但在 dist-next 之外 → 闸门 403（这就是要堵的那类）；
- ③ **不存在**的路径（含前端深链、`favicon.ico`、`/reports`）→ `existsSync` 为假 ⇒ 不拦 ⇒ 落 9d 拿 `index.html`。
三类互不重叠，**没有第四类**。唯一被"误伤"的是 `/index.html` 这条**断言**，不是路径本身。

`/docs/` 我也想确认删 9c 有没有功能损失：`grep -rn "'/docs/\|\"/docs/" web/src web/dist-next` → **0 命中**，`docs/` 下全是 `.md`（`denyExt` 本来就拒）。⇒ **删 9c 无消费者受影响**，计划 `:237` 那句"9c 原用途改由显式资源承接"在现状下甚至是多余的（没有 docs 图片被引用）。

### 1.3 改法（三行，不用改"6"这个数）

```bash
# ① 403 组：把 /index.html 换成 /web/index.html（同为 9c 专用、删 9c 后必 403）
for u in /web/index.html /web/src/App.jsx; do
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:5196$u"; done        # 必 403

# ② 把 /index.html 挪进"200 肯定断言"，但同时钉死"它必须是 SPA 壳、不是 84 KB 旧工作台"
sz=$(curl -s http://127.0.0.1:5196/index.html | wc -c)
[ "$sz" -lt 2000 ] || { echo "FAIL: /index.html 回了 $sz 字节（疑似旧工作台，9c 洞复发）"; exit 1; }
```

这样 G3 的"**共 6 条 403**"（基线 1 + 绕过 4 + `/web/src/App.jsx` 1）**一个数都不用改**，且每条都真能红、真能绿。**顺带把申报改准**：`/index.html` 在删 9c 后的正确行为是 **200 且 < 2 KB**，不是 403——G3 文本与 §1.4 里"r4 实测这四条必须全部 403（见 G3）"那句都要跟着改，否则下一个人会照它去改 9a（把 `index.html` 排除出 9a ⇒ 整站打不开，正是 r4 P0-1 的翻版）。

---

## 2. 逐条闭环核对表

### 2.1 上轮 1 条 P0

| 上轮 P0 | 本版落点 | 判 |
|---|---|---|
| **P0-1** 静态洞未闭（containment 恒真 + 9c 未删） | §1.4 `:215-232`：锚 `__dirname` + `inDist` + `!inDist && existsSync && isFile ⇒ 403` + 删 9c（写死"必须"）+ G3 补断言 + D3 同步 | ✅ **洞已闭合**（20-rel 模拟 + 现网取证：8 类敏感路径全 403）；⚠️ **但 G3 的 `/index.html`=403 恒红** → **新 P0-1** |

### 2.2 r4 的 6 条 P1

| # | 落点 | 判 |
|---|---|---|
| P1-1 孪生行 7→10、矩阵 PUT | `:157`（"恒为更新…无新建分支"）、`:56`（R8 = 10）、`:194`（自检 = 10） | ⚠️ **三处已改，第四处漏了**：D5 `:316` 仍写"39 字面量 + **7** 正则 + 2 startsWith + 5 mount" |
| P1-2 `grep -v G1` 过宽 | G1 `:330` 改 `grep -vE '^[0-9]+:\| G1 '` | ✅ 实跑 = 0；**且必须固定带 `-n`**（去 `-n` 时 = 1，见 §3-4） |
| P1-3 `Retry-After` 挂 401 | 四行表锁定期改 **429**（`:134`） | ✅ 与"达上限瞬时 429"同格，语义一致；admin 永不进该行（`:135`） |
| P1-4 assets URL 假绿 | D3 `:290` 加 `[ -n "$u" ] \|\| { echo FAIL; exit 1; }` | ✅ |
| P1-5 purge 事务行号 | §1.6 `:245` 点名 `:1070` purge 分支、`:1083`/`:1124` 两处 `writeReports(store)` | ✅ 行号我核过：`:1124` 在 purge 分支内、`:1083` 在软删分支内——**两句措辞需微调**，见 P1 清单 |
| P1-6 脚本先落地 | D3 `:301`"编码第 0 步…先红后绿" | ✅ |

### 2.3 addendum（位数已确认）

| 项 | 判 |
|---|---|
| 报告所有者 = `13200000000`（11 位），`[TBD 位数]` 关闭 | ✅ **不是 P0**；`users.phone` 的 `CHECK(length=11 AND GLOB '1[3-9]*')` 正好放行它、挡住 `1320000000`，机器护栏按预期工作 |
| G6 待答 5 → 4（Q2/Q3/Q5/Q6） | ✅ 记 **正常阻塞，非 P0**；但**计划 v0.5 还没同步**（`:304` 仍"5 条 `[TBD]`"、`:312` 仍是 `[TBD 位数]`、G6 `:335` 机械判仍会数出 5）——下一版三处一起改，改完机械判应 = **4** |
| Q2/Q3/Q5/Q6 未答 = 呈现问题、不是拒答 | 维持原判：这四条是**授权决定**（谁能导出病历/谁能挂号/谁能改归属），§8 审核者只能判"必须由用户拍板"，**不能替用户拍板**（r1 §3-6、r2 P0-F 同一裁定）。用户答完之前，D1 `:166`（Q6 的 `[TBD Q6]` 格）、`:206`（Q2/Q3 的按钮行）、§1.2 前端按钮分层、Q5 的 `reassign` 预留**不得开工** |
| 位数关闭后 bootstrap 是否解锁 | **三步骤解锁**（Q1 + 位数已定 ⇒ ① admin=`13228372097` ② owner=`13200000000` ③ `--apply` 指派 98+3），但**权限位仍全 0**（`:139`），所以 Q2/Q3/Q6/Q5 没答也不影响 bootstrap |

---

## 3. 本轮 8 条必攻击点逐条回答

### 3-1 P0-1 真伪：**洞闭了（8 类全 403），断言留了个恒红项**

见 §1。`''` 与 `assets/*` 不拦、`data`/`DATA`/`web/..`/`.git`/`.agents`/`web/index.html`/`web/src/*` 全 403、删 9c 在计划里是**强制表述**（§1.4 `:235` "② 必须删掉 9c"，不是"建议"）✓。

### 3-2 补强是否正确：**正确，且是这轮最有质量的一处自纠**

你自跑发现"r4 原改法（仅 deny 名单 403）会让 `index.html`/`.jsx` 落 9d 得 200 HTML"——**这个判断对**，我 r4 给的是"`if (!inDist) { if (denyExt||denyDir) 403; 否则落 9d }"这种两段式，确实放过了"不在名单里、但仓库里真实存在"的文件。改成"**`!inDist` && 文件真实存在 ⇒ 403**"把边界从"名单"换成"存在性"，这才是不变量（"仓库里的真实文件一律不可经静态通道外泄"），而不是一张迟早要补的清单——**和本项目一直在讲的"判据要写成不变量、不要写成黑名单"完全一致**。
副作用：无第三类路径误伤（§1.2 逐类验过）。`denyExt/denyDir` 降级为解释器/加速判断，位置正确。

### 3-3 G3 门禁是否够抓复发：**方向够，但计数与一条断言是错的**

- **你问的"6 还是 7"**：不是笔误，是**算错了对象**——D3 `:292-298` 实际执行 **7 条 403**（第一个循环 5 条：基线 `/data/reports.json` + 绕过 4 条；第二个循环 2 条），而 G3 文本写"4 条绕过 + 两条 = 共 6 条"，**漏掉了基线那条**（它也必须断言：它是 P0-A 的原始洞，不能只测变体）。
- 更要紧的是：这 7 条里有 **1 条恒红**（`/index.html`）⇒ 实际只有 6 条是有效断言。**把 `/index.html` 换成 `/web/index.html` 后，"共 6 条 403"这个数恰好正确**，所以数字不用动，改的是 URL。
- 抓复发的能力：够。若有人把 9c 加回来或把 containment 又锚回 `distDir`，`/web/index.html`（338 B，只有 9c 送得出去）与 `/web/src/App.jsx` 会立刻 200 ⇒ 红。这两条是真正的**金丝雀**，比 `/index.html` 强得多。

### 3-4 P1-2 判据收紧：**实跑 0/0/5，且必须固定带 `-n`**

```bash
# G1（v0.5 写法，原样执行）
grep -n "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md \
  | grep -vE '^[0-9]+:>' | grep -vE '^[0-9]+:\| G1 ' | wc -l
# → 0  ✅

# 去掉 -n 的反例（同一条命令、只是把第一段换成不带 -n）
grep "SQLite token\|服务端 session\|sessions(" … | grep -vE '^[0-9]+:>' | grep -vE '^[0-9]+:\| G1 ' | wc -l
# → 1  ← 判据行没被排掉（行前缀不是 "330:| G1" 而是 "| G1 |"）
```
**结论：`grep -vE '^[0-9]+:\| G1 '` 只在第一段 `grep` 带 `-n` 时成立**。计划 G1 `:330` 现在正是带 `-n` 的（`grep -n …`），所以可复现 = 0 ✓；但判据行里**必须把这个 `-n` 写进"不可省略"的注释**，否则将来有人为了"让输出好看"去掉 `-n`，判据就静默失效成恒绿（G1 本来就是要证明"文档里没有旧口径"，失效后它永远绿）。
- `5199`（排引用块）= **0** ✅
- `G6` = **5** ✅（位数那条还没删，见 §2.3：下一版删掉后应为 **4**）

### 3-5 状态表一致性：**✅ 成立**

锁定期改 429 + `Retry-After` 之后：三组（存在号错密码 / 不存在号 / 锁定期）在"**正文逐字节相同**"这一点上仍一致 ⇒ 不可分辨性靠的是**正文 + `:126` 显式前提（不存在的号同样计数、同样锁）**，不再依赖"锁定期必须是 401"。攻击者能分辨"我这个键被锁了"——这是他自己刚造成的公共信息，不构成存在性 oracle ✓。`role='admin'` 不设 `locked_until`（`:135`）⇒ 永不进"锁定期"行 ⇒ 两张表不冲突 ✓。

### 3-6 孪生行一致性：**3/4 已改，D5 `:316` 漏了**

- `grep -n "新建分支"` → `:12`（修订说明，历史叙述）、`:157`（已改"无新建分支"）、`:245`（§1.6"无『新建分支』"）⇒ **只剩否定表述** ✓
- `grep -n "7 条"` → 只剩 `:12` 修订说明里"7 reports + 3 guahao"的合法写法 ✓
- 但 `:316`（D5 硬约束）仍写"覆盖 A 集合（39 字面量 + **7** 正则 + 2 startsWith + 5 mount）"，与 `:56`/`:194`/`:331` 的 10 矛盾 ⇒ **同一份文档里 A 集合仍有两个版本**（第 4 次"改了三处漏一处"）。

### 3-7 新 P0 复核：**只有 1 条（就是 §1 那条），且不是代码逻辑问题**

三角关系（`!inDist && existsSync` × 9a 资产 × 9d 回退）我逐类验过无冲突（§1.2）。另外顺带核到两条**不构成 P0** 的历史遗留，供实现方注意（不新开战线，只记一句）：
- `server.mjs:1763` 的 `decodeURIComponent(pathname)` 对畸形百分号串会抛 `URIError`，在 async handler 里没人接 ⇒ 500。**这是既有行为，本方案不引入也不修**，但闸门既然要在同一处加逻辑，随手包一层 `try/catch` 更稳（否则 403 的黑名单可以用 `/%zz` 打穿成 500 噪音）。
- `serveStatic` 的 `HEAD` 分支与闸门同块，改动时别把 `HEAD` 落到 9d（HEAD 拿 index.html 无副作用，可不管）。

### 3-8 §8.7 Gate：**口径保持 ✓，G1/G2 可执行 ✓，G3 一条断言要改，G6 计数待同步**

| Gate | 判 |
|---|---|
| G1 `:330` | ✅ 实跑 0（**须把 `-n` 写成不可省略**，见 §3-4） |
| G2 `:331` | ✅ 判据可执行（10 正则 + 归一化 + 脚本自输出）；旁证 `:316` 待同步 |
| G3 `:332` | ❌ `/index.html`=403 恒红 → 换 `/web/index.html` + 加"`/index.html` 必须 <2 KB"；文本"共 6 条"改后即正确 |
| G4 `:333` | ✅ |
| G5 `:334` | ✅ |
| G6 `:335` | ⚠️ 正常阻塞；位数已答 ⇒ 同步后机械判应为 **4**（`:304`/`:312`/`:335` 三处） |
| G7 `:336` | ✅ |
| G8 `:337` | ⬜ 待实施，三条判据都可 grep |

`:326` 那句"⬜ = 未证（不得计入通过）"是本线最该保留的一句，v0.5 保住了 ✓。

---

## 4. P1 清单（与 P0 同批落地）

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | D5 `:316` 仍写"A 集合 = 39 + **7** 正则 + 2 + 5"，与 `:56`/`:194`/`:331` 的 **10** 矛盾 | 改成"39 字面量 + **10** 正则（7 reports + 3 guahao）+ 2 startsWith + 5 mount"；改完 `grep -c "7 正则"` 应为 0（除修订说明） |
| **P1-2** | G1 判据的 `-n` 是**功能性依赖**却没标注 | 在 G1 行加一句"**`-n` 不可省略**：`grep -vE '^[0-9]+:\| G1 '` 依赖行号前缀；去掉 `-n` 会退化成恒绿" |
| **P1-3** | 位数已确认，但计划 `:304`（"5 条 `[TBD]`"）、`:312`（`[TBD 位数]`）、G6 `:335`（机械判=5）三处仍未同步 | 三处一起改：标题"4 条"、删 `:312` 条目（改记"已拍板：11 位 `13200000000`"）、G6 机械判期望值 = **4** |
| **P1-4** | §1.6 说"`:1083` 非 purge 分支、`:1124` purge 分支各自调用 `writeReports(store)`"，但"同一事务"的落点是两句**跨分支**的话，读者会以为要合并两个分支 | 改成一句可执行表述："purge 分支内 `DELETE report_owners` 必须紧邻 `:1124` 的 `writeReports(store)`，两者之间不得有 `await`；任一失败则不写第二处" |
| **P1-5** | G3 的 403 组漏数（文本 6 vs 命令 7），且文本未提"基线那条也要断言" | 改后写成"**7 条 403**：基线 1（`/data/reports.json`）+ 绕过 4 + 金丝雀 2（`/web/index.html`、`/web/src/App.jsx`）"，与命令逐条对齐 |

---

## 5. 我做了什么 / 没做什么

- 只读：未改计划/代码、未提交、未动 `data/`、未碰写接口。本轮发 3 条只读 GET（`/`、`/index.html`、`/web/index.html`）+ 若干 `grep`/`node -e` 路径模拟。
- 只写了 `.agents/account-system-1116-review-r5.md`。
- **需实现方实测**：G3 的 7 条 403、3 条 200（含 `/index.html` < 2 KB 的内容校验）、`PUT /api/data/state` 非 403、`check-route-coverage.mjs` 双向差集、`verify-auth.mjs`（5196）。

---

## 6. 复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-1：/index.html 是 9a 服务的 SPA 壳，不可能 403（现网只读 GET）
curl -s http://127.0.0.1:5174/index.html | wc -c        # → 675（= web/dist-next/index.html）
wc -c index.html web/dist-next/index.html web/index.html # 84640 / 675 / 338
sed -n '1765,1772p' server.mjs                           # 9a：path.join(distDir, rel) 先行命中

# ② 全链路模拟（9a → 闸门 → 9d，20 种 rel）
node -e "
const fs=require('fs'),path=require('path'),dir='$PWD',dist=path.join(dir,'web','dist-next');
const sim=(rel)=>{
 if(rel){const a=path.join(dist,rel); if(!rel.startsWith('..')&&a.startsWith(dist)&&fs.existsSync(a)&&fs.statSync(a).isFile()) return '9a→200';}
 if(rel){const res=path.resolve(dir,rel);let real=res;try{real=fs.realpathSync(res)}catch{}
  const inDist=real===dist||real.startsWith(dist+path.sep);
  if(!inDist&&fs.existsSync(real)&&fs.statSync(real).isFile()) return '403';}
 return '9d→200';};
for(const r of ['','index.html','data/reports.json','DATA/reports.json','web/../data/reports.json','.git/config','.agents/MEMORY.md','web/index.html','web/src/App.jsx','web/src/pages/IntakePage.jsx','assets/index-Dhctrm9M.js','favicon.ico','reports','package.json','lib/blobStore.mjs','SERVER.MJS']) console.log(r.padEnd(32), sim(r));
"

# ③ G1 / 5199 / G6（应为 0 / 0 / 5，位数删除后 G6 应为 4）
grep -n "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md | grep -vE '^[0-9]+:>' | grep -vE '^[0-9]+:\| G1 ' | wc -l
grep -n 5199 .agents/account-system-1116-plan.md | grep -vcE '^[0-9]+:>'
sed -n '/^### D4\./,/^### D5\./p' .agents/account-system-1116-plan.md | grep -cE '^[0-9]+\. \*\*`\[TBD'

# ④ 孪生行（A 集合 7 vs 10）
grep -n "7 正则\|7 条正则\|10 条（7 reports" .agents/account-system-1116-plan.md
grep -n "新建分支" .agents/account-system-1116-plan.md

# ⑤ 删 9c 是否有消费者（应为 0）
grep -rn "'/docs/\|\"/docs/" web/src web/dist-next | wc -l
```
