# 账号系统 + 权限设计 · 独立审核 **r4**（plan-review §8.3 · 续期复审）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/account-system-1116-plan.md` **v0.4**（339 行，精准编辑）。
> 输入：`.agents/account-system-1116-review-input-r4.md`（首行已贴 r3 终判原文 + 3 P0 / 9 P1 关闭台账 + 8 条必攻击点）。
> 上轮判词：`.agents/account-system-1116-review-r3.md`（总判「不能直接进下一轮」，3 条 P0 + 9 条 P1）。
> 未改计划/代码、未提交、未动 `data/`。只做只读 `grep`、`node -e` 路径求值模拟、以及 4 条只读 GET（确认现网行为，未写）。**只写了本文件**。

---

## 0. 总判：**不能直接进下一轮** —— 1 条 P0

r3 的 3 条 P0 里 **2 条真闭合**（P0-2 方法列、P0-3 三条机械判据 —— 我逐条实跑 = 0/0/5），**P0-1 只闭合了一半**：`GET /` 不再 403（首页救回来了 ✓），但同一个代码块把"唯一静态根"变成了**恒真的空断言**，静态洞没有真正闭上。

| # | P0 | 一句话 | 证据 |
|---|---|---|---|
| **P0-1** | §1.4 的 containment 锚错了根 ⇒ 白名单退化成黑名单，**9c 仍在服务仓库内文件** | `path.join(distDir, rel)` 与 `distDir` 比较**恒真**，于是所有判定落到 `denyExt/denyDir`（黑名单）；`9c` 没删 ⇒ `/web/src/App.jsx`、`/web/src/pages/IntakePage.jsx`、`/index.html` 匿名 200。其中 `/index.html` 正是 `:194` 定为 **admin** 的那份旧工作台的仓库根副本 | §1，模拟 + 现网 GET |

**这一条的性质与 r2/r3 前几轮一致**：修复动作是真的（`if (rel)` 守卫、根、`denyExt/denyDir`、两条 200 肯定断言都写进去了），但**判据抓不到残留**——G3 的 6 条断言（4 绕过 403 + 2 肯定 200）在洞还开着的情况下**全绿**。

---

## 1. P0-1：containment 恒真，9c 仍在服务仓库内文件

### 1.1 代码为什么退化

§1.4 `:219-233`：

```js
if (rel) {
  const resolved = path.join(distDir, rel)                 // ← 锚在 distDir
  let real = resolved
  try { real = fs.realpathSync(resolved) } catch {}
  const denyExt = /\.(db|json|mjs|cjs|ts|tsx|md|log)$/i.test(real)
  const denyDir = /(^|\/)(data|docs|tests|lib|mcp|tools|\.git|\.agents|node_modules)\//.test(real)
  if (real !== distDir && !real.startsWith(distDir + path.sep)) {   // ← 恒假
    return sendJson(res, 403, …)
  }
  if (denyExt || denyDir) return sendJson(res, 403, …)
}
```

`resolved = path.join(distDir, rel)` 之后，只有当 `rel` 以 `..` 开头时它才会跑出 `distDir`。所以**第一道 `if` 对一切正常 rel 恒假**，真正的拦截全部由 `denyExt`/`denyDir` 完成——**这正是 r2 判词里被推翻的那个"URL 前缀黑名单"换了个皮**：从"名单里的一律拒"变成"名单外的全放行"。

而 `9c`（`server.mjs:1782-1789`）**没删**，它按 `path.join(__dirname, rel)` 服务仓库内任何真实文件。于是"通过闸门但没有落在 dist-next"的路径，全部落进 9c。

**把 §1.4 的代码逐字对着真实仓库求值（`node -e`，只算路径不写文件）**：

```
rel                       最终结果
''                        PASS → 落 9d（首页/未知路径）   ✅
data/reports.json         403(denyExt/denyDir)            ✅
DATA/reports.json         403(denyExt/denyDir)            ✅
web/../data/reports.json  403(denyExt/denyDir)            ✅
.git/config               403(denyExt/denyDir)            ✅
.agents/MEMORY.md         403(denyExt/denyDir)            ✅
--- 以下为残留 ---
web/src/App.jsx           **落 9c → 200**
web/src/pages/IntakePage.jsx **落 9c → 200**
index.html                **落 9c → 200**
web/index.html            **落 9c → 200**
```

**现网实测（4 条只读 GET，5174）**：

| URL | 现状 |
|---|---|
| `/web/src/App.jsx` | **200 / 11362 B** |
| `/web/src/pages/IntakePage.jsx` | **200 / 48968 B** |
| `/web/index.html` | **200 / 338 B** |
| `/index.html` | **200 / 84640 B** ← 是 `MedBrief · 挂号与问诊资料整理工作台`（`:194` 定为 **admin** 的旧工作台），仓库根副本 |

⇒ **`/legacy` 要 admin，`/index.html` 匿名就能下同一份 84 KB 旧工作台**。这不是"源码可下"那一档的无害项，而是绕开了自己在 `:194` 写下的门。

### 1.2 改法（两件事必须同时做，缺一仍漏）

```js
// 位置：9a/9b 之后、**并删掉 9c**
if (rel) {
  const resolved = path.resolve(__dirname, rel)      // ① 归属判定锚在仓库根，不是 distDir
  let real = resolved
  try { real = fs.realpathSync(resolved) } catch {}
  const inDist = real === distDir || real.startsWith(distDir + path.sep)
  if (!inDist) {
    if (denyExt || denyDir) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    // 其余（无扩展名的前端路径）→ 交给 9d 返回 index.html，不要 403
  }
}
```
- **① 锚回 `__dirname`**：这一步是 r3 我那句"根统一成 distDir"被误用到**归属判定**上的结果——我当时说的是"9a 的**资产解析**用 distDir，别把检查挪到 9a 之前"，没写清"归属判定的基准必须是仓库根"。这半个锅我背，但结论不变：现在这写法不构成白名单。
- **② 必须删 9c**：只要 9c 还在，任何"通过闸门但不在 dist-next"的路径都还能把仓库文件送出去。删掉后 9c 的用途（"docs 里的图片"）改由显式资源搬进 `web/dist-next/` 承接——计划 `:237` 已经把这个选项写出来了，只差选它。
- **③ 补两条否定断言**：`/index.html` 与 `/web/src/App.jsx` 必须 403（现在 G3 只测 4 条绕过，抓不到这两类）。**没有这两条，这个洞可以带着全绿的 G3 上线。**
- `denyExt/denyDir` 保留，但定位改成"给门禁一个明确的 403，而不是依赖 9d 的 200 HTML"——它是解释器，不是边界。

### 1.3 顺带确认（我给 r3 的三条建议里，另外两条确实落地了）

- `if (rel)` 守卫在案（`:221`），`GET /` 走 9d ✓；`D3:290` 的 `GET /` 必 200 断言在案 ✓；
- D3 `:291` 的 `/assets/*.js` 必 200 断言在案，且我核过 `web/dist-next/index.html` 里确实有 `/assets/index-Dhctrm9M.js` ⇒ 这条断言不会因"取不到 URL"而空转 ✓（但请看 P1-4）。

---

## 2. 逐条闭环核对表

### 2.1 上轮 3 条 P0

| 上轮 P0 | 本版落点 | 判 |
|---|---|---|
| **P0-1** 静态闸打挂首页 | §1.4 `:219-237`（`if (rel)` + 根 + `denyExt/denyDir` + 位置；`:236` 9d 边界）；D3 `:290-291` 两条 200 肯定断言 | ⚠️ **首页救回 ✓、位置写死 ✓、肯定断言 ✓，但 containment 恒真 + 9c 未删 ⇒ 洞仍在** → **P0-1** |
| **P0-2** `data/*` 漏方法 | `:189` 方法列改"任意（GET/POST/PUT/DELETE）"并点名 `:181/:224/:234`；D3 `:295` 加 `PUT /api/data/state` 非 403 | ✅ 与 `meddata/mount.mjs:181,224,234` 实测一致 |
| **P0-3** G1 grep 不可执行 | G1 `:330` 排除写法；`:339` 5199 同口径；G6 `:335` 机械判 | ✅ **三条我都实跑：G1 = 0、5199（排引用块）= 0、G6 = 5**（见 §3-3） |

### 2.2 r3 的 9 条 P1

| # | 落点 | 判 |
|---|---|---|
| P1-1 A 集合 10 正则 + 归一化 | G2 `:331`（10 = 7 reports + 3 guahao `:539/:557/:690`；归一化规则；脚本自输出不写死常量） | ⚠️ G2 对，但 `:199` 与 `:316` 仍写"7 条正则"（三处不一致，见 P1-1） |
| P1-2 `[TBD]` 计数 | D4 标题 `:304`"5 条"；`:306` 改 `[已拍板 Q1]`；G6 `:335` = 5 | ✅ 三处一致，机械判实跑 = 5 |
| P1-3 5199 口径 | `:283` 标题去掉字面 5199；`:339` 共用排除口径 | ✅ 排引用块 = 0 |
| P1-4 429/401 状态表 | D0 `:127-134` 四行表 | ✅ 语义与 `:123`/`:124` 一致（表头编码的规范性见 P1-3） |
| P1-5 措辞按代码校准 | §1.6 `:249`（POST 恒新 id `:1710`、`INSERT` 只在 `ok:true` 后、`无『新建分支』`、purge 同事务） | ⚠️ **§1.6 改了，矩阵 `:162` 没改**（见 P1-1） |
| P1-6 守卫优先级 | §1.3 `:213`（精确 > 最长前缀 > 默认拒绝 + 两条反例断言） | ✅ |
| P1-7 `login_attempts` 清理 | `:136`（7 天，启动 + 每日） | ✅ |
| P1-8 admin 不硬锁 | `:135`（只退避 + `authz_log(admin_login_throttle)` + loopback 单次旁路） | ✅ 与四行表不冲突（admin 永不进"锁定期"行） |
| P1-9 D2 取证退步 | `:258-262` 五个候选各自 ★/日期/停更证据恢复 | ✅ |

---

## 3. 本轮 8 条必攻击点逐条回答

### 3-1 P0-1 真伪：**首页 200 ✓、4 条绕过 403 ✓，但另有 4 类路径仍 200**

见 §1。补一句定位：这不是"代码写错了"的笔误，而是**把 r3 我给的"根统一"建议用错了位置**；真正的判据应该是"**路径最终落在哪个根下**"，而不是"拿 distDir 拼一下再比较"。

### 3-2 P0-2 真伪：**✅ 闭合**

`:189` 方法列"任意（GET/POST/PUT/DELETE）"并点名 `mount.mjs:181`(`PUT /state`)、`:224`(PUT)、`:234`(DELETE)——与我实测的三处逐条对上；D3 `:295` 的 `PUT /api/data/state` 非 403 断言在案。**这一条没有残留。**

### 3-3 P0-3 真伪：**✅ 三条判据实跑全部符合声明**（你点名的两条我都跑了）

```bash
# G1（计划写法，原样执行）
grep -n "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md | grep -vE '^[0-9]+:>' | grep -v 'G1' | wc -l
# → 0        ✅（去掉 -v G1 则 = 1，即判据行自己，说明排除是必要且够用的）

# 5199
grep -c 5199 .agents/account-system-1116-plan.md                      # → 3（全文，均在引用块/说明里）
grep -n 5199 .agents/account-system-1116-plan.md | grep -vcE '^[0-9]+:>'   # → 0  ✅

# G6（注意：反引号在单引号内是字面量，grep -E 里 \*\* 是字面星号）
sed -n '/^### D4\./,/^### D5\./p' .agents/account-system-1116-plan.md | grep -cE '^[0-9]+\. \*\*`\[TBD'
# → 5        ✅  命中 2./3./5./6./7. 五条；1. 是 [已拍板 Q1]、4. 是密码下发，正确排除
```

**结论：你担心的"反引号在单引号内被 shell 吃掉"不会发生**（单引号内 backtick 不参与命令替换），G6 = 5 可复现。G1 判据行自身含 "SQLite token" 也确实被 `grep -v 'G1'` 排掉了（这是它存在的唯一理由）。**三条判据现在是"能红也能绿"的，不再是恒红或恒绿。**

唯一的写法瑕疵（P1-2）：`grep -v 'G1'` 比"排除判据行自身"更宽——它会删掉**任何**含 `G1` 字样的行（现命中 `:13/:16/:24/:330/:339`，全是引用块或表格行，无害；但将来正文里出现"G1 判定"就会被无声吞掉）。建议收紧成 `grep -vE '^\| G1 '`。

### 3-4 P1-2 计数：**✅ 三处一致 = 5，且机械判可复现**

D4 标题 `:304`"5 条 `[TBD]`"、编号条目（2/3/5/6/7）、G6 `:335`"= 5"三处同数；`[已拍板 Q1]` 已移出计数（`:306` 自己写了"不计入"，这条比数字本身更重要——**把已答项和未答项在字形上分开**，比"标题写 5"更耐久）。

### 3-5 P1-4 状态表：**✅ 与 D0 上文一致，admin 不硬锁不冲突**

四行表（`:129-134`）与 `:123`（封顶 8s → 429 不挂连接）、`:124`（锁定期 401 + `Retry-After`）逐格对上；`role='admin'` 不设 `locked_until`（`:135`）⇒ admin 永不进第四行，两张表之间无冲突 ✓。
唯一规范性瑕疵（P1-3）：`Retry-After` 是 RFC 9110 只给 429/503/3xx 的头，挂在 401 上属非标准——浏览器/代理可能忽略它。**建议锁定期也用 429**：存在性 oracle 已由 `:126` 的"不存在的号同样计数"排除，不需要靠"锁定期保持 401"来维持不可分辨性；这样"锁定 vs 密码错"仍然可分（这是允许的，攻击者自己造成的），而状态码语义干净。

### 3-6 P1-5 代码校准：**§1.6 对了，矩阵行没跟上**

按 `server.mjs:1710`（`id: rep_${Date.now()}…` 恒新 id）、`:1684-1686`（`{ok:false,duplicate}` 无副作用）、`:1227` 起（`if (!rep) return 404`，PUT 恒更新）核过——**§1.6 `:249` 的三句措辞全部与代码相符** ✓。
但矩阵 `:162` 仍写「PUT … **新建分支按 ingest 写 owner**；更新不覆盖」——与 `:249` 的**"无『新建分支』"直接矛盾**。矩阵是会被照抄进实现的那张表，这一行必须改成"PUT 恒为更新，命中已有报告不覆盖 owner（无新建分支）"。（同一类"改了一处忘了孪生处"的问题，本轮出现 2 次：另一次是 A 集合 7 vs 10。）

### 3-7 新 P0 复核（你点名的三处）

1. **G1 判据行自引用**：实测已被正确排除（§3-3）✓ 不是问题。
2. **`denyDir` 是否误伤 `assets/`**：**不会**。`dist-next/assets/index-Dhctrm9M.js` 的路径段是 `web / dist-next / assets`，不在 `(data|docs|tests|lib|mcp|tools|.git|.agents|node_modules)` 里；`denyExt` 也不含 `.js`。我把 18 种 rel 都跑了，`assets/*` 没有一次误伤 ✓。**但请注意反面**：正因为 `denyDir` 是**黑名单**，`web/src/...` 这种"既不是 assets、也不在名单里"的路径就漏过去了（P0-1 的成因）。
3. **D3 首页 200 断言与"静态只允许 dist-next"是否自洽**：自洽——`/` 的 `rel=''` 不进闸、由 9d 出 `index.html`，而 `index.html` 本身就在 dist-next 里，没有把仓库根文件放出来 ✓。**真正的自洽缺口不在这条断言，而在 §1.4 的 containment**（P0-1）。

### 3-8 §8.7 Gate：**口径写定了（`:326` "⬜ = 未证，不得计入通过"），这是本轮最该保留的一句**

| Gate | 判 |
|---|---|
| G1 `:330` | ✅ 实跑 0（写法收紧见 P1-2） |
| G2 `:331` | ⚠️ 判据本身对（10 正则 + 归一化 + 不写死常量），但 `:199`/`:316` 两处旁证仍写 7（P1-1） |
| G3 `:332` | ⚠️ 6 条断言全绿而洞仍在（P0-1）——**需补 `/index.html`、`/web/src/*` 两条 403** |
| G4 `:333` | ✅ |
| G5 `:334` | ✅（purge 事务落点建议点名行号，见 P1-5） |
| G6 `:335` | ⚠️ 正常阻塞（用户未答），判据可复现 |
| G7 `:336` | ✅ |
| G8 `:337` | ⬜ 待实施，判据已可 grep（三条都写了具体字样） |

一句流程建议：**G2 的脚本应在编码第 0 步先落地**，否则"码写完了才发现差集非空"会把返工摊进实现阶段；同理 G3 的 6+2 条断言建议直接进 `verify-auth.mjs`，别留在计划里靠人肉 curl。

---

## 4. P1 清单（与 P0 同批）

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | 矩阵 `:162` 仍写「PUT 新建分支按 ingest 写 owner」，与 §1.6 `:249`「无『新建分支』」矛盾；`A` 集合正则数 `:199`/`:316` 写 **7**，G2 `:331` 写 **10** | 两处孪生行一起改：`:162` → "PUT 恒为更新，命中不覆盖 owner（无新建分支）"；`:199`/`:316` → "10 条正则（7 reports + 3 guahao）" |
| **P1-2** | G1 的 `grep -v 'G1'` 排除面过宽（删掉任何含 `G1` 的行，现命中 `:13/:16/:24/:330/:339`） | 收紧成 `grep -vE '^\| G1 '`（只排表格里的判据行），并保留 `grep -vE '^[0-9]+:>'` 排引用块 |
| **P1-3** | `Retry-After` 挂在 401 上非标准（RFC 9110 只定义给 429/503/3xx） | 锁定期改 429（存在性 oracle 已由 `:126` 排除）；或改自定义头 `X-Retry-After` |
| **P1-4** | D3 `:291` 的 `/assets/*.js` 断言靠 `grep -o … \| head -1` 取 URL，**取不到就是空串 → curl 打到首页 → 200 → 假绿**（R2「集合为空即通过」同族） | 加守卫：`u=$(…); [ -n "$u" ] \|\| { echo FAIL 取不到资产 URL; exit 1; }`，再断言 200 |
| **P1-5** | §1.6 的"purge 与 `writeReports` 同一事务"只有一句原则，没落到代码位置 | 点名 `server.mjs:1068` 起的 purge 分支与该文件里 `writeReports(store)` 的调用点，写死"两次写在同一个成功分支、任一失败回滚" |
| **P1-6** | G2/G3 仍是 ⬜，但它们依赖的脚本/断言本身要先写出来 | 写进 D3："编码第 0 步 = `tools/check-route-coverage.mjs` + `verify-auth.mjs` 骨架"，先红后绿 |

---

## 5. 我做了什么 / 没做什么

- 只读：未改计划/代码、未提交、未动 `data/`、未碰任何写接口。本轮发了 4 条只读 GET（`/web/src/App.jsx`、`/web/src/pages/IntakePage.jsx`、`/web/index.html`、`/index.html`）+ 若干 `grep`/`node -e` 路径模拟。
- 只写了 `.agents/account-system-1116-review-r4.md`。
- **需实现方实测**：`GET /` 与 `/assets/*.js` 的 200、4 条绕过 + `/index.html` + `/web/src/App.jsx` 的 403、`PUT /api/data/state` 非 403、`check-route-coverage.mjs` 双向差集、`verify-auth.mjs`（5196）。

---

## 6. 复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-1：§1.4 代码对 12 种 rel 的真实判定（模拟，不写文件）
node -e "
const fs=require('fs'),path=require('path'),dir='$PWD',dist=path.join(dir,'web','dist-next');
const gate=(rel)=>{ if(!rel) return 'PASS→9d';
  const res=path.join(dist,rel); let real=res; try{real=fs.realpathSync(res)}catch{}
  const denyExt=/\.(db|json|mjs|cjs|ts|tsx|md|log)\$/i.test(real);
  const denyDir=/(^|\/)(data|docs|tests|lib|mcp|tools|\.git|\.agents|node_modules)\//.test(real);
  if(real!==dist&&!real.startsWith(dist+path.sep)) return '403(containment)';
  if(denyExt||denyDir) return '403(deny)';
  const p=path.join(dir,rel); return (fs.existsSync(p)&&fs.statSync(p).isFile())?'**落9c→200**':'→9d'; };
for(const r of ['','data/reports.json','DATA/reports.json','web/../data/reports.json','.git/config','.agents/MEMORY.md','assets/index-Dhctrm9M.js','index.html','web/index.html','web/src/App.jsx','web/src/pages/IntakePage.jsx','dist-next']) console.log(r.padEnd(30), gate(r));
"

# ② P0-1 现网取证（只读 GET，证明洞是活的）
for u in /index.html /web/src/App.jsx /web/src/pages/IntakePage.jsx /web/index.html; do
  printf '%-32s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code} %{size_download}B' http://127.0.0.1:5174$u)"; done
sed -n '1763,1795p' server.mjs        # 9a(distDir) / 9c(__dirname) 两套根；9c 未删

# ③ P0-2：/api/data/* 的方法
grep -n "req.method === 'PUT'\|req.method === 'DELETE'" meddata/mount.mjs

# ④ P0-3：三条机械判据（应为 0 / 0 / 5）
grep -n "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md | grep -vE '^[0-9]+:>' | grep -v 'G1' | wc -l
grep -n 5199 .agents/account-system-1116-plan.md | grep -vcE '^[0-9]+:>'
sed -n '/^### D4\./,/^### D5\./p' .agents/account-system-1116-plan.md | grep -cE '^[0-9]+\. \*\*`\[TBD'

# ⑤ 孪生行一致性（P1-1）
grep -n "新建分支" .agents/account-system-1116-plan.md
grep -n "7 条 \`reports\` 正则\|10 正则\|39 字面量" .agents/account-system-1116-plan.md

# ⑥ 代码事实（P1-5 校准）
grep -n "id: \`rep_\|if (!rep) return sendJson(res, 404" server.mjs | head -5
grep -n "writeReports(store)" server.mjs | sed -n '1,12p'
```
