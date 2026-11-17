# 账号系统 + 权限设计 · 独立审核 **r3**（plan-review §8.3 · 续期复审）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/account-system-1116-plan.md` **v0.3**（308 行，整份重写）。
> 输入：`.agents/account-system-1116-review-input-r3.md`（首行已按 §8.2b 贴 r2 终判原文 + 6 P0 / 8 P1 关闭台账 + 8 条必攻击点）。
> 上轮判词：`.agents/account-system-1116-review-r2.md`（总判「不能直接进下一轮」，6 条 P0）。
> 未改计划/代码、未提交、未动 `data/`、未碰 5174 写接口；只做 **只读 grep / `node -e` 模拟 / `fs.realpathSync` 试跑（在 `/tmp` 上下文中，未写仓库）**。**只写了本文件**。

---

## 0. 总判：**不能直接进下一轮** —— 3 条 P0

v0.3 是这几轮里质量最高的一版：**6 条 P0 里 5 条的"内容"确实闭合了**，而且不是纸面 ✅——C 表已改写、`users` 上的 `failed_count` 已删、`login_attempts`/`report_owners`/admin 豁免/Gate 都真落进了正文。整份重写这个决定是对的。

但有一条 **P0-A 的修复代码块本身会把站点打挂**（我实跑模拟证实），另有一条 **P0-B 的残余**（方法维度漏写）会让 MedData 页保存/删除 403，还有一条**判据层 P0**（你点名的 G1 grep 自引用，实跑 = 2 行 ≠ 0）。

| # | P0 | 一句话 | 证据 |
|---|---|---|---|
| **P0-1** | **§1.4 的修复代码把 `GET /` 判成 403 ⇒ 整站打不开** | 代码块没有 `rel` 守卫：`path.resolve(__dirname, '')` = 仓库根，不在 `web/dist-next` 下 ⇒ 403；而 `'/'(rel='')` 恰恰是 9a 唯一跳过、只能靠 9d 回退的路径 | §1-A，模拟实跑 |
| **P0-2** | `/api/data/*` 只写了 GET，实际有 **PUT/DELETE** | `meddata/mount.mjs:181,224,234` 有写方法；默认拒绝 + 方法维度匹配 ⇒ MedData 的保存/删除全 403 | §1-B |
| **P0-3** | **G1 的 grep 判据不可机械执行**（实跑 = 2 行，声明是 0） | 命中 `:8`、`:15` 两行**修订说明**里的旧口径；`grep -v 'G1'` 只排掉判据行自己，排不掉修订说明 | §1-C，实跑输出 |

**P0-1 与 P0-3 是同一类病、且都出现在"修复件"上**：P0-1 是"修复代码没考虑空 rel"，P0-3 是"修复判据没考虑文档自引用"。两者的共同点与前几轮一致——**只验了想验的一半**。

---

## 1. P0 逐条展开

### P0-1 §1.4 的真实路径白名单：4 类绕过确实挡住了，但 `GET /` 会 403

**先说对的部分**（你点名要我实跑，我跑了）。用计划 `:204-213` 的代码逻辑对真实仓库路径求值：

```
data/reports.json            → <REPO>/data/reports.json      → 403  ✅
DATA/reports.json            → <REPO>/DATA/reports.json      → 403  ✅
web/../data/reports.json     → <REPO>/data/reports.json      → 403  ✅
.git/config                  → <REPO>/.git/config            → 403  ✅
.agents/MEMORY.md            → <REPO>/.agents/MEMORY.md      → 403  ✅
```

**关键判断**：这套方案挡得住编码/大小写/中段 `..`，不是因为 `realpathSync` 会规范化大小写（我实测**它不会**——macOS 上 `realpathSync('<REPO>/DATA/reports.json')` 原样返回 `DATA/`），而是因为它是**白名单 / 默认拒绝**：凡不落在 `web/dist-next` 下的路径一律拒。**方向选对了，这是 P0-A 的实质修复。**

**没对的部分**（一条就能让整站打不开）：

```
rel = '' （即 GET /）  → path.resolve(__dirname, '') = <REPO>  → 不在 allowRoot 下 → 403  ❌
```

现场代码 `server.mjs:1763` 是 `const rel = pathname === '/' ? '' : decodeURIComponent(pathname).replace(/^\//,'')`；而 **9a（`:1765-1772`）有 `if (rel && …)` 守卫 ⇒ 首页根本不进 9a**，只能落到 9d 返回 `index.html`。计划把检查插在"9c 之前"且**代码块没有 `rel` 守卫** ⇒ `GET /` 直接 403。这不是边角：**它是唯一的应用入口**。

**第二个缺口：403 与 SPA 回退的边界没写。** 今天 9d（`:1790-1795`）对"任何未命中前序分支、且文件不存在的 GET"返回 `index.html` 200。§1.4 若"一切非 dist-next 路径 403"，则**9d 等于被废掉**。我核了前端形态：`web/src/App.jsx:62,121` 明确"不引 react-router，切页写回 URL（`?tab=`）"，`MedDataWorkbench.jsx:9` 用的是 `MemoryRouter`（内存路由，不写 URL）⇒ **目前没有 path 深链需求，影响可控**；但这句话必须写进计划，否则半年后加 path 路由就是一片白屏 403。

**改法（替掉 `:204-213` 的代码块）**：

```js
// 位置：9a/9b 之后、9c 之前；**只处理非空 rel**
if (rel) {
  const resolved = path.join(distDir, rel)        // 与 9a 同根（distDir），不是 __dirname
  let real = resolved
  try { real = fs.realpathSync(resolved) } catch {}
  const denyExt = /\.(db|json|mjs|cjs|ts|tsx|md|log)$/i.test(real)
  const denyDir = /(^|\/)(data|docs|tests|lib|mcp|tools|\.git|\.agents|node_modules)\//.test(real)
  if (real !== allowRoot && !real.startsWith(allowRoot + path.sep)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' })   // return，不落穿
  }
  if (denyExt || denyDir) return sendJson(res, 403, { ok: false, error: 'forbidden' })
}
// rel === ''（首页）与"dist-next 里不存在的路径" → 落到 9d 返回 index.html
```
- **必须保留 `if (rel)`**：空 rel 就是首页，绝不能被这道闸判死；
- **根要统一成 `distDir`**：现场 9a 用 `path.join(distDir, rel)`（`:1766`），9c 用 `path.join(__dirname, rel)`（`:1784`）——两套根。若把这检查挪到 9a 之前，`/assets/*.js` 会按 `__dirname` 解析成 `<REPO>/assets/...` ⇒ 403（我模拟过），**整站白屏**。计划必须写死"本检查仅在 9a/9b 之后执行"；
- 或者走计划自己给的等价方案（删 9c，静态资源全进 `dist-next`）——那样就得靠上面 `denyExt/denyDir` 两条给出 403，否则 `/data/reports.json` 会落到 9d 拿回 `200 text/html`（不泄数据，但门禁的"403"断言过不了）。

**门禁必须补肯定断言（这条比 403 更要紧）**：D3 `:264-266` 的 5 条全是**否定**断言（都期望 403）。全 403 的门禁**分不出"挡住了"和"站点挂了"**——这正是 R2「集合为空即通过」的同族。至少加两条肯定断言：

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5196/                    # 必 200
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:5196$(curl -s http://127.0.0.1:5196/ | grep -o '/assets/[^"]*\.js' | head -1)"   # 必 200
```

### P0-2 `/api/data/*` 只写了 GET 一种方法（P0-B 残余）

计划 `:174`：`| GET | /api/data/*（MedData 镜像读写 …） | admin |`。但实际：

```
meddata/mount.mjs:181  if (req.method === 'PUT' && sub === '/state')      ← 保存整份 state
meddata/mount.mjs:224  if (req.method === 'PUT')                          ← 改记录
meddata/mount.mjs:234  if (req.method === 'DELETE')                       ← 删记录
```

**默认拒绝 + (method, path) 匹配**下，`PUT/DELETE /api/data/*` 不匹配任何规则 ⇒ 403 ⇒ **MedData 页的保存/删除整片挂掉**，而这正是 P0-B 当初要防的"漏一类入口"。表里"读写"二字写了，但权限列的方法只有 GET。

**改法**：`:174` 方法列改成 **任意（GET/POST/PUT/DELETE）**，权限保持 admin；并把这一条写进 `verify-auth.mjs` 的一条断言（admin `PUT /api/data/state` 非 403）。

### P0-3 G1 的 grep 判据不可机械执行（你点名的必答题）

**实跑（按计划 `:299` 的写法）**：

```bash
grep "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md | grep -v 'G1' | wc -l
# → 2      ← 计划声明"= 0"
```

命中两行都不是 C 表/D0，而是**修订说明**：

```
:8  > 版本：**v0.3** — …所有旧口径（服务端 session 表、URL 前缀黑名单、users 上的 failed_count、5199、"3 条待拍板"）已从全文删除…
:15 > - **P0-E（C 表残留服务端 session）** → C 表改写为 iron-session…
```

**结论：`grep -v 'G1'` 只排掉判据行自己，排不掉修订说明里的"旧口径名单"。这个写法不可机械执行**——它会在文档完全正确的情况下恒红。而恒红的判据下一步一定是被人"放宽"（把 `grep -v` 改成 `grep -v -E 'G1|版本|P0-'`），然后它就变成恒绿。这是 R1「算了但没判」的镜像：**判据自己要能红、也要能绿**。

**可机械执行的写法（我实跑验证过，返回空）**：

```bash
grep -n "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md \
  | grep -vE '^[0-9]+:>'      `# 排除所有引用块（修订说明/触发原话）` \
  | grep -v '^[0-9]*:| G1'    `# 排除判据行自身`
# → 0 行（PASS）
```
（实测输出为空 ⇒ 文档内容确实干净：C 表 `:82` 已是 iron-session、`:94` 砍 JWT 的理由已改写、D0 `:103-106` 唯一口径。）

**顺带同一批**：`:257` 也写"全文统一无 5199"，`grep -c 5199` 实测 **2**（`:8`、`:257`，都是元叙述）。两处判据用同一套排除口径，别一个用 `grep -v G1`、一个用"除修订说明"。

---

## 2. 逐条闭环核对表

### 2.1 上轮 6 条 P0

| 上轮 P0 | 本版落点 | 判 |
|---|---|---|
| **P0-A** 静态黑名单可绕过 | §1.4 `:200-215`（realpath + 唯一根 + 403 `return`）；D3 `:264-266` 4 条回归 | ⚠️ **绕过真挡住（模拟 5/5 全 403）**，但代码块无 `rel` 守卫 ⇒ `GET /` 403、9d 回退被废、门禁无肯定断言 → **P0-1** |
| **P0-B** 漏 5 类入口 + 自检无效 | `:174-178` 5 类已列；`:184` 双向差集；`:57`/`:244` 基数订正 39 | ⚠️ 5 类已补 ✓、基数 39 ✓（实测 `grep -c "pathname ==="` = 39），但 `/api/data/*` 方法维度漏 PUT/DELETE → **P0-2**；A 集合正则应写 **10** 条不是 7（见 P1-1） |
| **P0-C** 限流语义缺失 | `:111-121` `login_attempts`（双键/无此号也写/dummy scrypt/封顶 8s/锁满归零/429）；D2 `:250` 第 2、10 条 | ✅ 语义写全（你担心的"Retry-After 是否把 oracle 又招回来"见 §3-3：**不构成**，因为 phone 键对不存在的号同样计数、同样会锁） |
| **P0-D** 写路径无归属 | `:142`/`:144`/`:145`/`:146`/`:147` 五处 + §1.6 `:225-227` + 对账断言 | ✅ 五处齐，且我核过 `POST` 永远生成新 id（`server.mjs:1710`）、`PUT` 永不新建（`:1227` 起 `if (!rep) 404`）⇒ 无主键冲突；对账恒等式在软删/恢复/彻底删除下成立 |
| **P0-E** 会话机制残留 | C 表 `:82`/`:94`、D0 `:103-106`、错字已删 | ✅ **内容全对**（判据写法见 **P0-3**） |
| **P0-F** admin 看不到报告 | §1.5 `:217-223`（四处豁免 + 三主体×两端点 + `read_report_as_admin`）；D0 `:124` 两账号建号顺序 + owner 零授权 | ✅ 四处都点了名（`:141`/`:143`/`:149`/`:151`），判据能同时证"过滤"与"例外" |

### 2.2 上轮 8 条 P1

| # | 落点 | 判 |
|---|---|---|
| P1-1 测试认证故事 | D3 `:256`（`MEDBRIEF_TEST_USER` 或 `auth-helpers` + "auth=on 无凭证 401"门禁，且明写 `MEDBRIEF_AUTH=off` 不得作唯一手段） | ✅ |
| P1-2 MCP 逐路由白名单 | D5 `:289`（含 patient GET/POST、patch、blobs；排除 admin/reset/launch-login）+ smoke-test | ✅ 与我实测调用面（`mcp/intake-server.mjs:95,103,146,173,190,207,218,231,238`）逐条对上 |
| P1-3 端口统一 | F5 `:69` 已改 5196 | ⚠️ `:257` 自称"全文无 5199"，实测 `grep -c 5199` = 2（均元叙述）；与 P0-3 同一口径问题 |
| P1-4 blob EXISTS 语义 | `:151` | ✅（补一句"他人报告的同一 sha 不泄漏存在性"已在同一格写了） |
| P1-5 "3 台设备" | `:110` 改 UA 指纹观测 + 明写"不是硬限制" | ✅ |
| P1-6 `?owner=` 语义 | `:154-158` + §1.5 `:221` | ✅（"未指定且主体无数据 ⇒ 明确 403/404，不能返回空卡"这句写得好） |
| P1-7 三处"3 条"计数 | 全文改"5 条" | ⚠️ **第三次漂移**：D4 标题 `:275` 写"**5 条 `[TBD]`**"，而 D4 内实际有 **6 个** `[TBD]`（含 `:277` 的"已拍板 Q1"），G6 `:304` 又写"计数=实际条数=**6**" ⇒ 标题与 Gate 两个数打架。见 P1-2 |
| P1-8 错字 | "人权机制"已删 | ✅ |

### 2.3 本轮 8 条必攻击点 → 结论一览

| # | 结论 |
|---|---|
| 1 P0-A 真伪 | ⚠️ 4/5 类绕过全 403（实跑），但 `GET /` 403 + 9d 回退被废 → P0-1 |
| 2 P0-B 真伪 | ⚠️ 5 类入口已列、双向差集方向对；`/api/data/*` 方法漏 → P0-2；A 集合正则数错 → P1-1 |
| 3 P0-C 真伪 | ✅ 且"锁定时多一个 Retry-After"**不构成枚举 oracle**（理由见 §3-3）；缺状态表 → P1-4 |
| 4 P0-D 真伪 | ✅ 五处语义 + 对账恒等式成立；两处措辞要按代码校准（P1-5） |
| 5 P0-E 真伪 | ✅ 内容 0 残留（实跑排除写法）；**判据写法不可执行 → P0-3** |
| 6 P0-F 真伪 | ✅ 四处豁免 + 三主体×两端点 + owner 零授权自洽 |
| 7 §8.7 Gate | ⚠️ G1 判据坏（P0-3）；G2 的 A 集合数错 + 归一化规则未定义（P1-1）；其余 6 条成立 |
| 8 新 P0 | ✅ 无（重写未引入 admin 同号/`phone UNIQUE`/`phoneVerifiedAt` 的矛盾；`13228372097` 11 位过 `CHECK` ✓）。仅 P1 若干 |

---

## 3. 本轮 8 点逐条回答

### 3-1 P0-A 真伪：**挡住四类 ✓，但会顺手把首页打挂**

见 §1-A。补两条实测事实，供实现方少走弯路：
- `fs.realpathSync` 在 macOS 上**不做大小写规范化**（`DATA/…` 原样返回）——所以这套方案能挡住 `DATA` 不是靠 realpath，而是靠"白名单 + 默认拒绝"。写文档时别把功劳记错，否则将来有人"优化"成黑名单就全塌。
- 9a 与 9c 用的是**两套根**（`:1766` `distDir` vs `:1784` `__dirname`）。这是同一个文件里已经存在的隐患，本方案正好踩上。

### 3-2 P0-B 真伪：**入口补齐 ✓，方法维度没补**

`meddata/mount.mjs` 5 类入口我逐行核过：`:154`（`handleMirror`）、`:278`（tesseract/traineddata）、`:286`（`/meddata`）、`:298`（`/api/data` 分派）、`:303`（`PROXY_PREFIXES`）——计划 `:174-178` 四行都覆盖到了。**差的是方法**：`:181`(`PUT /state`)、`:224`(`PUT`)、`:234`(`DELETE`) 不在表里。另 `/api/data/*` 的行方法列写"GET"，与"读写"二字自相矛盾。

**双向差集能否机械执行 —— 现在还不能**（P1-1）：A 集合写的是"39 + **7** 条 `reports` 正则 + 2 startsWith + 5 mount"，而代码里正则路由有 **10 条**（7 条 reports + 3 条 guahao：`:539` captcha.png、`:557` flow/:id、`:690` flow/:id/{sms,captcha,confirm,abort}）。且两侧用的是**不同语言**（左侧 `/^\/api\/intake\/reports\/[^/]+$/`、右侧表里 `/api/intake/reports/:id`），**归一化规则（正则→`/路径/:参数`）必须写出来**，否则脚本写不成。

### 3-3 P0-C 真伪：**"锁定多一个 Retry-After"不构成自相矛盾**，理由与你猜的相反

你问的是"锁定的响应因此可分辨 ⇒ 枚举 oracle 又回来了？"——**没有回来**，原因在 `:118` 那一句：`phone 键不管 users 行存不存在都写`。于是：

- 不存在号连试 10 次 → 同样 `locked_until` → 同样 401 + `Retry-After`；
- 能分辨的是"**这个键是否被锁**"，不是"**这个号是否存在**"；而"被锁"是攻击者**自己刚造成**的公共信息，不携带账号存在性。

这条成立的前提有三条，建议在 `:120` 后**加一句显式前提**（否则将来有人"优化"成只对存在的号计数，oracle 立刻回来）：
> 前置：`phone:` 键对不存在的号**同样计数、同样触发锁定**；否则 `Retry-After` 存在与否就成了存在性 oracle。

其余写全了 ✓：双键（`:118`）、退避封顶 8s（`:119`）、锁满归零（`:119`）、dummy scrypt（`:120`）、成功只清 phone 键（`:121`）、小样第 2/10 条（`:250`）。

### 3-4 P0-D 真伪：**五处齐，对账恒等式成立**

- 五处：POST `:142`、DELETEpurge `:144`、restore `:145`、patch `:146`、PUT `:147`，§1.6 `:225-227` 复述一致 ✓。
- **对账 `n(reports)+n(trashed) === n(report_owners)`** 在软删/恢复下成立：软删是同一行在 `reports`↔`trashed` 之间搬移，和不变；恢复是搬回；彻底删除（`?purge=1`）两侧同时减一 ✓。**唯一要求写清**：purge 的 `DELETE report_owners` 必须与 `writeReports` 在**同一个事务/同一个成功分支**里，否则中途失败会破恒等式（建议这条直接写成 `verify-auth.mjs` 的一条断言：purge 后 `Δ(reports+trashed) === Δ(owners)`）。
- **两处措辞请按代码校准**（P1-5）：`POST /api/intake/reports` 永远生成新 id（`server.mjs:1710`），失败分支是 `{ok:false, duplicate}`（`:1684-1686`）——`owner` 的 `INSERT` 只能放在 `ok:true` 之后；`PUT /api/intake/reports/:id` 的"新建分支"**不存在**（`:1227` 起 `if (!rep) return 404`）。计划 `:147` 的"新建分支按 ingest 写 owner"是幻影分支，会让实现方为一个不存在的路径写逻辑。

### 3-5 P0-E 真伪：**内容真干净，判据不可执行**

见 §1-C。实跑可执行版 = 0 行（通过）。文档内容我另做了人工核对：C 表 `:82`（iron-session 无 sessions 表）、`:94`（JWT 砍的理由已改成"需自建加密层、撤销代价同级"）、D0 `:103-106` 单一口径 ✓。`users` 表 `:107` 已无 `failed_count/locked_until` ✓。

### 3-6 P0-F 真伪：**四处齐，判据能同时证两件事**

`:141`（列表）、`:143`（`:id`）、`:149`（blobs）、`:151`（blob/:id）都写了 admin 豁免，§1.5 `:219` 再复述一遍 ✓。判据 `:222` 是"三主体 × 两端点"（admin→N>0；owner→N>0；第三方→0 条 **且** 对 owner 某份 `:id` 403）——**这组能同时证过滤与例外**，写法我认可（比"admin 能看就完事"强得多）。
**自洽性**：owner 默认 `card_export=0/guahao=0`（`:124`）+ "报告归 owner 但 owner 只看到报告库" ✓ 不冲突（`card_export` 管的是**出卡/打印**，不是**看报告库**）。建议再加一条断言把这两件事钉开：owner 调 `/api/intake/card` 必须 403，而 `/api/intake/reports` 必须 200——否则"默认零授权"和"能看报告库"这两句在实现上很容易被混成一件事。

### 3-7 §8.7 Gate：**已落进计划（G1–G8），但两个判据要修**

| Gate | 我的判 |
|---|---|
| G1 `:299` | ❌ 判据实跑 = 2 行（P0-3），可执行版已给 |
| G2 `:300` | ⚠️ 方向对；A 集合正则数应为 10 不是 7，且正则↔表路径归一化规则未定义（P1-1） |
| G3 `:301` | ⚠️ 缺肯定断言（`/` 与 `/assets/*.js` 必 200），否则全 403 分不出"安全"与"挂站"（P0-1 同条） |
| G4 `:302` | ✅ D0 `:111-121` + 小样 `:250` 第 2、10 条 |
| G5 `:303` | ✅ §1.6 |
| G6 `:304` | ⚠️ 正常阻塞（用户未答 Q2/Q3/Q5/Q6 + 位数）；但"计数=6"与 D4 标题"5 条"打架（P1-2） |
| G7 `:305` | ✅ D3 `:256`（须注意：`MEDBRIEF_TEST_USER` 是**生产可用开关**，`NODE_ENV!=='production'` + loopback 两个条件要一并写成断言，不能只写注释） |
| G8 `:306` | ⚠️ 只有"同步清单落地"一句；建议把 G8 变成三条可 grep 的项（README 含 `/api/auth/`、INTERFACE.md 含 `mb_session`、MEMORY.md 含"本地账号≠114 账号≠报告所有者"） |

另外一句方法论（与前几轮同源）：**G2/G3/G8 现在标 ⬜，不是"通过"，也不是"失败"**——计划里要写死"⬜ = 未证，不得计入通过"（R1/R2 的"没验证 ≠ 通过"）。

### 3-8 是否引入新 P0：**没有**

逐项核过你举的三个：
- **admin 与 114 同号 + `phone UNIQUE`**：两套体系不共用登录态，`users.phone` 只约束本地账号，同号不违反 `UNIQUE` ✓；`13228372097` 是 11 位、过 `CHECK` ✓。
- **两账号建号顺序**：`:124` 三步顺序 ✓，且"中间失败不留半套状态"写了 ✓。
- **`phoneVerifiedAt` 恒 null**：与 J6"预留短信"一致 ✓。
- 另核：`SESSION_SECRET` 不落 `data/` ✓（`:106`）；`MEDBRIEF_AUTH=off` 三约束保留 ✓（`:255`）；`/guahao` 壳显式公开、不被默认拒绝误伤 ✓（`:178`）。

---

## 4. P1 清单（与 P0 同批落地）

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | `check-route-coverage.mjs` 的 A 集合：正则写"7 条"实为 **10 条**（漏 3 条 guahao：`server.mjs:539,557,690`）；且"正则 → 表路径"的归一化规则未写，脚本无法成型 | A = 39 字面量 + **10** 正则 + 2 startsWith + 5 mount；写死归一化规则（`/^\/api\/x\/([^/]+)$/` ⇒ `/api/x/:id`；`(sms\|captcha\|…)` 展开成 4 行或按"同族"一行 + 白名单豁免表）。**别再把 39/7/2/5 当手写常量**——让脚本自己输出 A、B 与差集，手写数字就是下一个"40 vs 39" |
| **P1-2** | `[TBD]` 计数第三次漂移：D4 标题 `:275`"5 条" vs D4 内实际 6 个 `[TBD]` vs G6 `:304`"=6" | 定口径：**已拍板项移出 `[TBD]` 标记**（`:277` 改 `[已拍板 Q1]`），则 D4 内 = 5 条 = 标题 = G6；并让 G6 用 `sed -n '/^### D4\./,/^### D5\./p' … \| grep -c '\[TBD'` 机械判 |
| **P1-3** | `:257` 声称"全文无 5199"实为 2 处（`:8`、`:257` 元叙述） | 与 G1 共用同一套排除口径（排除 `>` 引用块） |
| **P1-4** | 429 与 401 的边界未定：`:119` 退避封顶→429，`:120` 已锁定→401+`Retry-After` | 补一张「状态 → (状态码, 头, 正文, 延迟)」四行小表（正常失败 / 退避中 / 达上限瞬时 / 锁定期），否则"响应不可分辨"这条自己先不可分辨 |
| **P1-5** | 两处措辞与代码不符：POST 不会新建"更新"分支却写"新建分支"；PUT 的"新建分支"不存在（`:1227` 起 `if(!rep) 404`） | 按 `server.mjs:1710`（POST 恒生新 id）与 `:1227`（PUT 恒更新）校准；`INSERT` 只放在 `ok:true` 之后 |
| **P1-6** | 守卫匹配优先级未写，且表内**存在会被短前缀吃掉的实例**：`/api/guahao/reset`(admin) 在 `/api/guahao/*`(guahao) 之下；`/api/intake/blob`(POST/admin) 与 `/api/intake/blob/:id`(GET/card_export)；`/api/intake/reports` 与 `.../:id` | 写死「**精确 > 最长前缀 > 默认拒绝**」，并在 `verify-auth.mjs` 加两条反例（普通用户打 `/api/guahao/reset` 必须 403；`GET /api/intake/blob/<id>` 只按 card_export 判） |
| **P1-7** | `login_attempts` 无过期清理：每次尝试都写一行（含不存在的号）⇒ 可被刷到几十万行 | 加一条"`last_failed_at` 早于 7 天的行在启动时/每日清理"（与 `sessions` 表被砍的理由同源：别把无界增长的表留在基础设施里） |
| **P1-8** | 远程锁死**残余**：任何 LAN 内的人对 admin 号连发 10 次错密即可锁 15 分钟（`role='admin'` 无例外） | **不记 P0**——这是 r2 P0-C 修复方案的残余，我上轮只写了"双键"没写 DoS 处置，不算你跑偏。但请同批写死一句：`role='admin'` **不硬锁**（只退避 + 写 `authz_log` 告警），或允许 loopback 单次旁路 |
| **P1-9** | D2 表把 5 个候选压成一行"casbin/lucia/express-session/kratos/supertokens"，星数/日期全写 `—` | 取证厚度比 v0.2 退步（v0.2 有具体数字）。结论未变，但 github-tool-scout §5 要求"版本/平台锁"，至少把 lucia(deprecated)/kratos/supertokens 的版本或停更证据各留一格 |

---

## 5. 我做了什么 / 没做什么

- 只读：未改计划/代码，未提交，未动 `data/`，未碰 5174 写接口（本轮**一个 HTTP 请求都没发**——所有结论来自 `grep`、`node -e` 的 `fs.realpathSync` 模拟、以及既有代码行号）。
- 只写了 `.agents/account-system-1116-review-r3.md`。
- **需实现方实测**：`GET /` 与 `/assets/*.js` 的 200、4 条绕过 403、`PUT /api/data/state`（admin 非 403）、`check-route-coverage.mjs` 双向差集、`verify-auth.mjs`（5196）、`login_attempts` 三组时序对拍。

---

## 6. 复跑命令清单（本判词每条结论可自证）

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-1：§1.4 的代码对 GET / 的判定（模拟，不写仓库）
node -e "
const fs=require('fs'),path=require('path'),dir='$PWD';
const allowRoot=path.join(dir,'web','dist-next');
const chk=(rel)=>{const res=path.resolve(dir,rel);let real=res;try{real=fs.realpathSync(res)}catch{}
 return (real===allowRoot||real.startsWith(allowRoot+path.sep))?'ALLOW':'403'};
for (const rel of ['', 'data/reports.json','DATA/reports.json','web/../data/reports.json','.git/config','assets/index.js']) console.log(JSON.stringify(rel), '→', chk(rel));
"
sed -n '1763,1795p' server.mjs      # rel='' 时 9a 跳过（if (rel && …)），只有 9d 能接住首页

# ② P0-2：/api/data/* 的真实方法集合
grep -n "req.method === 'PUT'\|req.method === 'DELETE'\|req.method === 'POST'" meddata/mount.mjs
sed -n '174p' .agents/account-system-1116-plan.md       # 表里只写了 GET

# ③ P0-3：G1 判据实跑（计划写法 → 2；可执行写法 → 0）
grep "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md | grep -v 'G1' | wc -l
grep -n "SQLite token\|服务端 session\|sessions(" .agents/account-system-1116-plan.md | grep -vE '^[0-9]+:>' | grep -v '^[0-9]*:| G1' | wc -l

# ④ 基数与集合口径
grep -c "pathname ===" server.mjs                                    # 39（计划已订正）
grep -nE "\.match\(/\^|\.test\(pathname\)" server.mjs                # 10 条正则（7 reports + 3 guahao）
grep -n "pathname === '/guahao'\|/legacy" server.mjs                 # 979 / 1775 壳入口

# ⑤ P0-D：写路径与 id 语义
grep -n "^        id: \`rep_\|if (!rep) return sendJson(res, 404" server.mjs | head
grep -n "report_owners" .agents/account-system-1116-plan.md

# ⑥ P0-F：admin 豁免四处
sed -n '141p;143p;149p;151p;217,223p' .agents/account-system-1116-plan.md

# ⑦ 计数一致性
grep -c "5199" .agents/account-system-1116-plan.md                   # 2（均为元叙述）
sed -n '/^### D4\./,/^### D5\./p' .agents/account-system-1116-plan.md | grep -c '\[TBD'   # 6 vs 标题"5 条"
sed -n '295,308p' .agents/account-system-1116-plan.md                # G1–G8
```
