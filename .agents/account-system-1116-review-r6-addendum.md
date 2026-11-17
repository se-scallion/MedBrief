# 账号系统 · r6 addendum 审核（Q2/Q3/Q5/Q6 拍板后的权限语义变更）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/account-system-1116-plan.md`（**文首仍写 v0.7（终稿），内容已含 Q2/Q3/Q5/Q6 的语义变更**——版本号问题见 P1-1）。
> 输入：`.agents/account-system-1116-review-r6-addendum.md`（用户 2026-11-17 原话 + 4 点待审）。
> 上轮：`.agents/account-system-1116-review-r6.md`（总判「可以开工」，P0 = 0）。本轮只审本次变更，不重开已过审战线。
> 未改计划/代码、未提交、未动 `data/`。只读 `grep` / `sed`（无 HTTP 请求）。**只写了本文件**。

---

## 0. 总判：**不能直接进下一轮** —— 2 条 P0

用户在 r6「可以开工」**之后**把权限模型从"报告写路径 admin-only"改成了"登录用户可增删改查自己的报告"。D1 表、§1.2、§1.5、D4 **大部分都跟着改对了**（`reports` 写路径五处 owner 校验写得很齐），但**有两格没跟上，且两格都是"改了一半"**：

| # | P0 | 一句话 | 证据 |
|---|---|---|---|
| **P0-1** | `POST /api/intake/blob` 仍是 **admin**，而 Q3 已把「资料录入」页对登录用户开放 | 该页里懒加载的 MedData 工作台正是靠这条接口上传原件（`IntakePage.jsx:46,1004` → `web/src/meddata/docFileStore.js:58`）⇒ 普通用户上传原件 **403**；且 `GET blob/:id` 的 EXISTS 语义（"被我的报告引用"）让**刚上传、尚未被引用的 blob 连上传者自己都读不回来** | `:166` 仍"admin（写）" |
| **P0-2** | `POST /api/intake/patient` 改"登录用户改自己档案"，但档案**根本没有 uid 维度** | `data/intake/patient.json` 是单份 `{id:'p1'}`；`lib/intakeCard.js:80` `loadPatient()` 只读这一份、`:92-109` `savePatient()` 还**硬编码 `id:'p1'`** ⇒ 任何登录用户改的都是同一份全局抬头，而这份抬头正是 **owner 出卡时读的那份** ⇒ 未获 `card_export` 的人可以篡改有授权的人的出卡抬头，直接违反用户刚拍板的"管理不了别人的" | `:169` 只写了"按 uid 存（后期多病人时拆）" |

两条都不是架构问题，各一段话可改完（改法见 §1）。**其余 Q2 变更我已核准，不必再送审**：`reports` 的 POST/PUT/patch/DELETE/restore/corrections 五处 owner 校验（`:156-163`）、`blob/:id` 去 `[TBD]` 归 `card_export`（`:166`）、§1.2 按钮表（`:196-204`）、§1.5 "写路径同理（Q2）"（`:213`）、D4 四条 `[已拍板]`（`:317-322`）——措辞与用户原话逐句对得上。

---

## 1. 两条 P0 展开

### P0-1 `POST /api/intake/blob`(:1398) 仍 admin ⇒ 刚对普通用户开放的那一页半坏

**用户原话**：「普通用户可以管理（增删改查）自己的报告」。导入报告要落原件，而原件的落库通道有两条：

| 通道 | 谁在用 | 现状权限 |
|---|---|---|
| `POST /api/intake/reports`(:1641) 体内的 `image`/`pdf` → 服务端 `saveBlobIfAbsent()`（`:1717` 附近） | **主路径**（资料录入 → 上传 → 识别 → 入库） | 已改"登录用户" ✓ **不需要** blob POST |
| `POST /api/intake/blob`(:1398) | **嵌入的 MedData 工作台**（`IntakePage.jsx:46` `React.lazy(() => import('../meddata/MedDataWorkbench.jsx'))`，`:1004` 渲染在「资料录入」页内） | 仍 **admin** ✗ |

Q3 把「资料录入」对登录用户开放 → 普通用户进这一页就会看到 MedData 工作台 tab → 选文件上传原件 → **403**。这与我 r3 判过的 P0-2（`/api/data/*` 漏写 PUT/DELETE ⇒ MedData 保存/删除 403）**同一类**：口径改了、矩阵没跟、默认拒绝把页面打成半坏。同一标准 ⇒ 同一级别。

**还有一条更隐蔽的**：`GET /api/intake/blob/:id`(:1424) 的判定是"**该 blob 被任一属于我的报告引用 ⇒ 允许**"（`:166`）。普通用户刚上传的 blob 还没被任何报告引用 ⇒ **连上传者自己都取不回来**，往返断裂（前端预览会 403）。

**改法（必须二选一并写死）**：
- **(a) 开给登录用户**：`POST /api/intake/blob` → "登录"，并**落一条归属**（`blob_owners(blob_id, user_id, at)`，或直接写 `report_owners` 之外的新旁路表）；`GET blob/:id` 的判定扩成"**被我的报告引用 _或_ 是我上传的**"。同时 `GET /api/intake/blobs`(:1415) 的"user 按 owner 过滤"要能按这张表过滤（否则用户看不到自己刚传的）。
- **(b) 保持 admin**：那就必须把「资料录入」页里的 MedData 工作台**对非 admin 隐藏**（§1.2 增一行），并明写"普通用户的原件只经 `POST reports` 体内的 `image` 字段落库"。**不能什么都不写**——今天这一格是"矩阵说 admin、页面说对所有人开放"，实现方必然踩。

我倾向 (a)：用户说的是"管理自己的报告"，上传原件是导入的组成部分，且 `saveBlobIfAbsent` 已经证明"有图必有原件"是本项目的既有保证（`server.mjs` 注释原话）。选 (b) 会让普通用户走进一个"能识别、存不进去"的半成品 tab。

### P0-2 `patient` 档案的多用户隔离没有落地形态（且读写权限不对称）

`data/intake/patient.json` 实测结构：`{"id":"p1","name":"刘梦圆","sex":"女","age":"30","diagnosis":…}` —— **单个对象，无 uid 字段**。读写都在 `lib/intakeCard.js`：

```js
export function loadPatient() {                       // :80
  const p = splitSubtype(readJson(PATIENT_FILE, null))   // 单文件
  …
}
export function savePatient(patch = {}) {             // :92
  … writeJson(PATIENT_FILE, next)                    // 覆盖整份
  id: 'p1',                                          // ← 硬编码
}
```

计划 `:169` 写的"**按 uid 存（后期多病人时拆）**"缺三件东西：**格式**（文件怎么组织）、**迁移**（现有 `p1` 归谁——应归 owner）、**改造点**（`loadPatient`/`savePatient` 签名要不要带 uid，`/api/intake/card` 在渲染谁的抬头时按什么取）。同时 `:168` 的 GET 写"登录（本人档案）；admin 可改"——但"本人档案"在单文件下不存在。

**后果链**（按拍板后的矩阵推一遍）：
1. 普通用户（无 `card_export`）→ `POST /api/intake/patient` 变成"登录即可" ⇒ **能改**；
2. `owner`（真正有出卡需求的人，`card_export` 待授权）→ `GET /api/intake/card` 读的是 `loadPatient()` 这一份 ⇒ **改的人不是出卡的人**；
3. ⇒ "没有授权的人能篡改有授权人的病历抬头"——这正是用户那句"管理不了别人的"要禁的事，而它是**结构性**的，不是配置错。

**改法（三选一，但必须写死格式 + 迁移 + 读写签名）**：
- **(a) 一 uid 一文件**：`data/intake/patient/<uid>.json`，`loadPatient(uid)` / `savePatient(uid, patch)`，bootstrap 把现有 `p1` 迁到 owner 名下，`/api/intake/card?owner=` 取对应 uid 那份；
- **(b) 单文件内分桶**：`patient.json = {byUid: {"<uid>": {...}}}`，保留 `p1` 作为 owner 的兼容键（一次性 migration 脚本）；
- **(c) 收紧而不用拆**：`POST /api/intake/patient` 保持 **admin**，普通用户只读自己那份（但单文件下"自己那份"仍不成立 ⇒ 只能配 (a)/(b)）。
并补一条判据进 `verify-auth.mjs`：**用户 A 改档案后，用户 B 读到的抬头必须不变**（现状会变）。**这条判据比"能不能改"重要**：它把"隔离"变成可红的东西。

---

## 2. 4 点待审逐条回答

### 2-1 写路径 owner 校验是否漏：**`reports` 五处齐 ✓；`blob` POST 漏（P0-1）；`patient` 隔离无形态（P0-2）；另有一处表格事实错**

- `POST /api/intake/reports`：新建无 owner 校验对象 ✓，`INSERT ... uid=当前主体` ✓（`:156`）。
- `PUT`/`patch`/`DELETE`/`restore`/`corrections` 五处"登录 + owner 校验；admin 豁免" ✓（`:157-163`），与 §1.5 `:213` 一致 ✓。
- `GET reports` / `:id` 的 user 过滤 + admin 豁免 ✓（`:155`/`:157`）。
- **`POST /api/intake/blob` 漏**（P0-1）；**`patient` 隔离缺形态**（P0-2）。
- **表格事实错（P1-2）**：`:167` 的 `POST /api/brief/import` 写"登录用户（导入自己的交换包）｜按 `?owner=` 或当前主体归属"——**该 handler 根本不落库**：`server.mjs:942-970` 只是 `parseMedDataBundle()` → 存进模块级变量 `lastImportedState` → 回摘要，一行都不写 reports。所以"归属"这一栏是空的，写"按 ?owner= 归属"会让实现方去找一个不存在的写入点。
  但它顺带暴露一个**真实的跨用户串号**：`lastImportedState` 是**模块级全局**，`GET /api/brief/visit-summary?source=import`（`:292`，`card_export` 门）读的就是它 ⇒ **A 导入的交换包，B（有 card_export 的另一个人）能读到**。请写死"`lastImportedState` 按 uid 隔离（`Map<uid, state>`）"，或明写"单用户语义，多用户下会串"。

### 2-2 G6 转绿后是否还有阻塞开工的项：**有，就是这 2 条 P0；其余不算计划层阻塞**

- G2（`check-route-coverage.mjs`）、G3（静态闸 7×403 + 3×200）、G8（README/INTERFACE/MEMORY 同步）都是**编码第 0 步与实施项**，⬜ 不代表计划有问题 ✓（`:341` 的"⬜ = 未证不得计入通过"口径正确，保持）。
- 但 `:351` 的收尾句仍写"**进入编码仍需 用户确认（Q2/Q3/Q5/Q6）… G6 待用户回答后才转绿**"——与 Gate 表 G6 `✅ 四问已答`（`:346`）**直接矛盾**（P1-3）。
- 用户已全部拍板 ⇒ **唯一的计划层阻塞就是 §1 那两条**；改完即可判「可以开工」。

### 2-3 `[TBD]`=0 机械判是否可复跑、三处是否同数：**可复跑 ✓、同数 ✓，但版本号没升（P1-1）**

```bash
sed -n '/^### D4\./,/^### D5\./p' .agents/account-system-1116-plan.md | grep -cE '^[0-9]+\. \*\*`\[TBD'
# → 0  ✅
```
- D4 标题 `:316`"**0 条 `[TBD]`**"、G6 `:346` 期望"= **0**"、条目 `:317-323` 全 `[已拍板]`/`[已确认]` ⇒ **三处同数** ✓。
- **但文件头 `:1` 与 `:8` 仍写"v0.7（终稿）… r6 终判「可以开工」，P0 = 0（本线第一份过审方案）"**，而正文已经装进了**r6 之后才拍板、当时未审**的权限语义变更。这不是笔误：`v0.7（终稿）`+"P0=0 已过审"这两个标签会让人把**未审内容**当成已审版本引用（我这次审的正是那批内容，且查出 2 条 P0）。**必须升 v0.8 + 写一段"Q2/Q3/Q5/Q6 语义变更"修订说明**（谁拍的、改了哪几格、影响哪些判据），并把"过审"措辞收窄为"r6 审的是 v0.7 的 admin-only 口径"。

### 2-4 是否有新 P0（含表结构/自相矛盾）：**2 条（P0-1、P0-2）；表结构本身没问题**

- D1 表五列（方法 / 路径·行 / 权限 / owner 校验·归属写入）齐 ✓，没有 r6 那次的列错位；`:156-163` 与 §1.5 `:213` 口径一致 ✓；`:166` 的 `[TBD Q6]` 已去掉、改 `card_export`（Q6 已拍板）✓。
- `?owner=` 的适用范围有一处**口径不齐**（P1-4）：§1.5 `:218` 列的是"出卡/摘要端点（card / visit-summary / bundle / meddata-summary）"，但 `:167` 的 `brief/import` 也写了"按 `?owner=`"。若实现方照表照做，普通用户传 `?owner=<别人的uid>` 就把导入结果归到别人名下——违反"管理不了别人的"。请写死"**`?owner=` 仅 admin 可用，其余一律当前主体**"，并把它放进 `verify-auth.mjs`（普通用户 `?owner=other` ⇒ 403 或忽略并归自己，二者选一写死）。

---

## 3. P1 清单（同批修）

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | 文首仍"v0.7（终稿）· P0=0 · 本线第一份过审方案"，而正文已含 r6 之后未审的权限变更 | 升 **v0.8** + 加"Q2/Q3/Q5/Q6 语义变更"修订说明（原话、改了哪几格、影响哪些断言）；"过审"措辞限定在 v0.7 的 admin-only 口径 |
| **P1-2** | `:167` `brief/import` 写"按 `?owner=` 或当前主体归属"，但该接口**不落库**（`server.mjs:942-970` 只回摘要）；同时 `lastImportedState` 是模块级全局，**A 导入的交换包 B 能读到** | 归属列改"—（不落库，仅内存缓存 + 摘要）"；并把 `lastImportedState` 写成 `Map<uid,state>`（或明写单用户语义 + 多用户会串的告警） |
| **P1-3** | `:351` 收尾句仍写"进入编码仍需 用户确认（Q2/Q3/Q5/Q6）… G6 待用户回答后才转绿"，与 G6 ✅ 矛盾 | 改成"G6 已转绿（四问已答）；进入编码 = 用户确认 + G1–G8 除 G6 外全绿" |
| **P1-4** | `?owner=` 的适用面两处不齐（§1.5 只列 4 个读端点，`:167` 却让 `brief/import` 也吃 `?owner=`） | 写死"`?owner=` **仅 admin**；非 admin 一律取当前主体，传了他人 uid ⇒ 403 或忽略（选一并写明）"，进 `verify-auth.mjs` |
| **P1-5** | `:168` GET patient 的权限列混入"admin 可改"（方法列是 GET） | 拆清：GET = 登录（读本人，admin 读全部）；POST = 见 P0-2 的隔离方案 |

---

## 4. 复跑命令

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-1：谁要 blob POST、页面是否对普通用户开放
grep -n "MedDataWorkbench" web/src/pages/IntakePage.jsx          # :46 lazy import / :1004 渲染
grep -rn "api/intake/blob'\|api/intake/blobs'" web/src/meddata/docFileStore.js   # :58 POST / :46 GET 列表
sed -n '166p' .agents/account-system-1116-plan.md                # 仍写 admin（写）

# ② P0-2：patient 无 uid 维度
head -c 120 data/intake/patient.json                             # {"id":"p1",...}
sed -n '80,110p' lib/intakeCard.js                               # loadPatient 单文件 / savePatient 硬编码 id:'p1'
sed -n '167p;168p' .agents/account-system-1116-plan.md

# ③ [TBD]=0 机械判（三处同数）
sed -n '/^### D4\./,/^### D5\./p' .agents/account-system-1116-plan.md | grep -cE '^[0-9]+\. \*\*`\[TBD'
grep -n "0 条 \`\[TBD\]\`\|\`\[TBD' = \*\*0" .agents/account-system-1116-plan.md

# ④ brief/import 不落库 + 全局缓存
sed -n '942,974p' server.mjs | grep -n "lastImportedState\|sendJson\|writeReports"   # 只有缓存与回包

# ⑤ 版本号与收尾句
sed -n '1p;8p;351p' .agents/account-system-1116-plan.md
```
