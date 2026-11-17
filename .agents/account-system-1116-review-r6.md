# 账号系统 + 权限设计 · 独立审核 **r6**（plan-review §8.3 · 续期复审）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/account-system-1116-plan.md` **v0.6**（340 行）。
> 输入：`.agents/account-system-1116-review-input-r6.md`（r5 终判原文 + 1 P0 / 5 P1 关闭台账 + 5 条必攻击点）。
> 上轮判词：`.agents/account-system-1116-review-r5.md`（总判「不能直接进下一轮」，1 条 P0 + 5 条 P1）。
> 未改计划/代码、未提交、未动 `data/`。只做只读 `grep`、`node -e` 路径模拟、2 条只读 GET。**只写了本文件**。

---

## 0. 总判：**可以开工**

**r5 那条 P0 已闭合，且没有引入新 P0。** 这一轮我把 r5 提的每一条都逐字复跑了，结果与申报一致（G1 = 0、5199 = 0、G6 = **4**、D5 正则 = **10**、`/web/index.html` 金丝雀在案、`/index.html` <2 KB 肯定断言在案、全文无"`/index.html` 必 403"的残留）。这是本线（账号系统）**第一份可以开工的方案**。

**但必须写清一句，防止被误读：**

> **终判「可以开工」≠ 用户已授权编码。**
> ① **G6 的四个问题（Q2 普通用户只读? / Q3 资料录入·病历交换包归谁 / Q5 改账号=改号还是转报告 / Q6 普通用户能否看原件）是独立门槛**，用户正在选择，未答之前 **D1 `:166` 的 `[TBD Q6]` 格、`:206` 的 Q2/Q3 按钮行、§1.2 前端按钮分层、Q5 的 `reassign` 预留一律不得开工**；
> ② 反过来，**直接与 bootstrap 相关的两项已定**（Q1 管理员 = `13228372097`；位数 = 11 位 `13200000000`）⇒ **bootstrap 三步（① 建 admin ② 建 owner ③ `--apply` 指派 98+3）已解锁**，且因为 owner 默认零授权（`role='user'`, `card_export=0`, `guahao=0`，`:139`），**Q2/Q3/Q5/Q6 未答不影响 `--apply`** —— 那四问决定的是"授权给谁什么"，不是"数据归谁"；
> ③ 所以"可以开工"= **计划与判据层面无阻塞**；真正动手的时机仍是"用户确认 + G1–G8 除 G6 外全绿"，两者缺一不可（`:339` 原文口径正确）。

| 上轮 P0 | 本版 | 判 |
|---|---|---|
| `/index.html` = 403 恒红 | D3 403 组换 `/web/index.html`（338 B dev shim，9c 专用）；`/index.html` 改"必 200 且 <2 KB"肯定断言；G3 文本改"7 条 403 = 基线1+绕过4+金丝雀2"；§1.4 历史叙述同步订正 | ✅ **闭合** |

**附 3 条 P1（同批，不影响开工）**：`<2 KB` 断言缺下界（空响应会假绿）、`PUT /api/data/state` 的"非 403"弱断言（401 也会假绿）、G1 行的 ✅ 说明仍标 v0.5。

---

## 1. P0-1 复核：金丝雀换对了，恒红项已清除

### 1.1 D3 断言组逐条（`:283-296`）

| 断言 | 期望 | 我的复核 |
|---|---|---|
| `/data/reports.json`、`/%64ata/reports.json`、`/DATA/reports.json`、`/web/%2e%2e/data/reports.json`、`/.git/config` | 全 403 | ✅ 模拟 5/5 全 403（基线 1 + 绕过 4） |
| `/web/index.html`、`/web/src/App.jsx` | 必 403 | ✅ 模拟 2/2 全 403；`/web/index.html` 现网 338 B、**只有 9c 送得出去**，删 9c 后必 403 ⇒ 真金丝雀 |
| `/index.html` | 必 200 且 < 2 KB | ✅ 现网 200 / **675 B** = `web/dist-next/index.html`（9a 服务）；84 640 B 的旧工作台只在 `/legacy`、要 admin |
| `GET /`、`/assets/*.js`（非空守卫） | 必 200 | ✅ 现场 `/assets/index-Dhctrm9M.js` 真实存在 |

**"7 条 403 = 基线 1 + 绕过 4 + 金丝雀 2"与命令逐条对得上**，我数过：第一个 `for` 5 条（含基线）+ 第二个 `for` 2 条 = 7 ✓（r5 的漏数是漏了基线那条，本版补齐）。

### 1.2 全链路模拟（9a → 闸门 → 9d，v0.6 代码逐字求值）

```
''                          → 9d 200（首页）              ✅
index.html                  → 9a 200 / 675B（SPA 壳）     ✅ ← 不再是恒红项
web/index.html              → 403                         ✅ 金丝雀
web/src/App.jsx             → 403                         ✅
data/reports.json           → 403                         ✅
DATA/reports.json           → 403                         ✅
web/../data/reports.json    → 403                         ✅
.git/config                 → 403                         ✅
assets/index-Dhctrm9M.js    → 9a 200（正常资产）           ✅
```

### 1.3 残留断言清理：**干净**

`grep -n "index.html"` 全文 10 处，逐条看都不是"必 403"：`:8`/`:11`（修订说明，明写"把恒红的 403 断言换成 `/web/index.html`""对 `/index.html` 加 <2 KB 肯定断言"）、`:190`（静态资源公开行）、`:225`/`:227`（代码注释）、`:230`/`:232`（历史叙述**已订正**为"URL `/index.html` 现由 9a 服务的是 675 B SPA 壳、不是漏洞；84 640 B 旧工作台只在 `/legacy`、要 admin"）、`:291`/`:293`/`:294`（新断言）、`:333`（G3 文本）。

`:232` 那句尤其值得记一笔：它把 r4 我给的两条互相冲突的证据（同一 URL 一次 84640 B、一次 675 B）**解释成了正确的东西**——9c 洞是活的、内容随文件状态漂移，删 9c 后该 URL 恢复成 SPA 壳。**这是本线第一次把"审核者的历史证据"也订正进计划**，比单纯修一行更耐久。

---

## 2. 逐条闭环核对表

### 2.1 上轮 1 条 P0
见 §1，✅ 闭合。

### 2.2 r5 的 5 条 P1

| # | 落点 | 判 |
|---|---|---|
| P1-1 D5 7→10 | `:316`"39 字面量 + **10** 正则（7 reports + 3 guahao `:539/:557/:690`）+ 2 startsWith + 5 mount" | ✅ 与 `:56`/`:194`/`:331` 四处同数 |
| P1-2 `-n` 不可省略 | G1 `:331` 加"**`-n` 不可省略**——`grep -vE '^[0-9]+:\| G1 '` 依赖行号前缀，去掉 `-n` 会退化成恒绿" | ✅ 我反证过：去 `-n` 后同命令 = 1（判据行排不掉） |
| P1-3 位数同步 | D4 标题 `:305`"**4 条 `[TBD]`**"、`:313` 改 `[已确认] 11 位`、G6 `:336` 机械判 = **4** | ✅ 实跑 `grep -cE '^[0-9]+\. \*\*`[TBD'` = **4** |
| P1-4 purge 单分支 | `:244`"purge 分支内 `DELETE report_owners` **必须紧邻** `:1124` 的 `writeReports(store)`，两者之间**不得有 `await`**；`:1083` 是软删分支（不合并）" | ✅ 三个要件（紧邻 / 无 await / 不合并）齐 |
| P1-5 G3 计数对齐 | `:333`"**7 条 403** = 基线 1 + 绕过 4 + 金丝雀 2" | ✅ 与 D3 命令逐条对齐 |

### 2.3 Gate 现状

| Gate | 判 |
|---|---|
| G1 `:331` | ✅ 实跑 0（`-n` 依赖已标注；说明里的"v0.5"版本号建议改 v0.6，见 P1-3） |
| G2 `:332` | ⬜ 待实现（判据可执行：10 正则 + 归一化 + 脚本自输出 A/B/差集） |
| G3 `:333` | ⬜ 待实现（7 条 403 + 3 条 200，其中 1 条 200 需补下界，见 P1-1） |
| G4 `:334` | ✅ |
| G5 `:335` | ✅ |
| G6 `:336` | ⚠️ 正常阻塞（Q2/Q3/Q5/Q6，用户正在选择）；机械判 = 4 可复现 |
| G7 `:337` | ✅ |
| G8 `:338` | ⬜ 待实施（三条判据都可 grep） |

`:326` 的"✅ = 已闭合；⬜ = 未证（**不得计入通过**）；⚠️ = 正常阻塞（非 P0）"三档口径保持 ✓ —— 这条口径让"⬜ 待实现"和"✅"在同一张表里可以共存而不含混，是本线几轮里最有复用价值的一条。

---

## 3. 本轮 5 点逐条回答

### 3-1 P0-1 真伪：**✅ 闭合**

`/web/index.html` 删 9c 后必 403（现网 338 B、9a 里不存在、`denyExt` 也不含 `.html`，所以只能靠"`!inDist && 真实存在 ⇒ 403"这条边界拦住——**这条断言正好在验那条边界本身**，选得比 `/index.html` 好）；`/index.html` 200 / 675 B（9a 的 SPA 壳）✓；全文无"`/index.html` 必 403"残留（含历史叙述段）✓。

### 3-2 P1-1~5：**全部闭合**（见 §2.2，逐条实跑）

### 3-3 是否有新 P0：**无**

三处你点名要核的"新矛盾"，我逐条查过：

1. **`<2 KB` 与 dist-next 里 index.html 真实大小 675 B**：自洽，且余量足够（将来壳长大到 2 KB 也会红，届时应改成"与 `wc -c < web/dist-next/index.html` 相等"这类恒等式，而不是调大阈值——见 P1-1）。
2. **"7 条 403"文本 vs D3 命令**：逐条对齐 ✓（5 + 2 = 7）。
3. **§1.4 历史叙述 vs §1.4 代码**：自洽 ✓（`:230`/`:232` 已把两条冲突证据解释清；代码仍是锚 `__dirname` + `!inDist && exists` ⇒ 403 + 删 9c）。

### 3-4 §8.7 Gate：**口径保持 ✓，G6 现为 4 项正常阻塞**

位数与 Q1 已答 ⇒ `[TBD]` 只剩 Q2/Q3/Q5/Q6；机械判 = 4 可复现；`⬜ = 未证不得计入通过` 一句在案。

### 3-5 开工门槛：**已在 §0 写死，此处再钉一次**

**「可以开工」只描述"计划与判据层面无阻塞"，不描述"用户已授权编码"。** 四条授权决定（Q2/Q3/Q5/Q6）是**用户的门槛**，不是审核者的门槛——§8 审核者只能判"必须由用户拍板"（r1 §3-6 / r2 P0-F 同一裁定），不能替用户选推荐值。bootstrap 三步因 Q1 + 位数已定而解锁，owner 默认零授权使 `--apply` 与那四问无关。

---

## 4. P1 清单（同批修，不影响开工）

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | `<2 KB` 断言缺**下界**：`sz=$(curl -s … \| wc -c)`，服务未起 / 空响应时 `wc -c` = **0**，`[ 0 -lt 2000 ]` 为真 ⇒ **假绿**（R2「集合为空即通过」同族） | 改成区间 + 状态码双断：`c=$(curl -s -o /dev/null -w '%{http_code}' …); sz=$(curl -s … \| wc -c); [ "$c" = 200 ] && [ "$sz" -ge 100 ] && [ "$sz" -lt 2000 ] \|\| fail` |
| **P1-2** | `PUT /api/data/state` 断言写"**非 403**"⇒ **401 也会通过**（cookie 过期时守卫回 401，路线其实被拦了，断言仍绿） | 改成显式排除两种拒绝码：`case "$c" in 401\|403) echo FAIL;; esac`，并要求 `c` 为 200/400/500 之一 |
| **P1-3** | G1 行的 ✅ 说明仍写"v0.5 实跑 0"（本版已是 v0.6） | 改成 v0.6 复跑值，并在 G 表加一列"复跑版本"，避免下一次"这行是哪版验的"再对不上 |

---

## 5. 我做了什么 / 没做什么

- 只读：未改计划/代码、未提交、未动 `data/`、未碰写接口。本轮 2 条只读 GET（`/index.html`、`/web/index.html`）+ `grep` 与 9-rel 模拟。
- 只写了 `.agents/account-system-1116-review-r6.md`。
- **需实现方实测**：G3 的 7 条 403 + 3 条 200（含 `<2 KB` 区间）、`PUT /api/data/state` 非 401/403、`check-route-coverage.mjs` 双向差集、`verify-auth.mjs`（5196）、`login_attempts` 三组时序对拍。

---

## 6. 复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-1：金丝雀与 SPA 壳的区分（现网只读 GET）
curl -s http://127.0.0.1:5174/index.html | wc -c        # → 675（9a 的 SPA 壳；删 9c 后仍 675）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5174/web/index.html   # → 200（今天经 9c）；删 9c 后应 403
wc -c index.html web/dist-next/index.html web/index.html                        # 84640 / 675 / 338

# ② 9-rel 全链路模拟（9a → 闸门 → 9d）
node -e "
const fs=require('fs'),path=require('path'),dir='$PWD',dist=path.join(dir,'web','dist-next');
const sim=(rel)=>{ if(rel){const a=path.join(dist,rel); if(!rel.startsWith('..')&&a.startsWith(dist)&&fs.existsSync(a)&&fs.statSync(a).isFile()) return '9a→200';}
 if(rel){const res=path.resolve(dir,rel);let real=res;try{real=fs.realpathSync(res)}catch{} const inDist=real===dist||real.startsWith(dist+path.sep);
  if(!inDist&&fs.existsSync(real)&&fs.statSync(real).isFile()) return '403';} return '9d→200';};
for(const r of ['','index.html','web/index.html','web/src/App.jsx','data/reports.json','DATA/reports.json','web/../data/reports.json','.git/config','assets/index-Dhctrm9M.js']) console.log(r.padEnd(28), sim(r));
"

# ③ 三条机械判据（应为 0 / 0 / 4）
grep -n "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md | grep -vE '^[0-9]+:>' | grep -vE '^[0-9]+:\| G1 ' | wc -l
grep -n 5199 .agents/account-system-1116-plan.md | grep -vcE '^[0-9]+:>'
sed -n '/^### D4\./,/^### D5\./p' .agents/account-system-1116-plan.md | grep -cE '^[0-9]+\. \*\*`\[TBD'

# ④ 孪生行与计数
grep -n "7 正则\|10 正则" .agents/account-system-1116-plan.md
grep -n "7 条 403" .agents/account-system-1116-plan.md
grep -n "index.html" .agents/account-system-1116-plan.md      # 应无"必 403"

# ⑤ 空响应假绿反证（P1-1）
printf '' | wc -c                                             # → 0；[ 0 -lt 2000 ] 为真 ⇒ 现有断言会放过
```
