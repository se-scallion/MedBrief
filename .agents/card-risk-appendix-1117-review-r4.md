# 问诊卡①危险分层 + 打印自定义附页 · 独立审核 **r4**（续期复审 · 终轮）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/card-risk-appendix-1117-plan.md` **v0.4**。
> 输入：`.agents/card-risk-appendix-1117-review-input-r4.md`（r3 终判原文 + 5 个必攻击点）。
> 上轮：`.agents/card-risk-appendix-1117-review-r3.md`（B 维持准予、A 线 2 P0）。
> 未改计划/代码、未提交、真库零写入（`buildCard()` 只在内存跑，未起服务、未写任何文件到仓库）。**只写了本文件**。

---

## 0. 总判：**只准哪几条** —— **B 线维持准予；A-数据层带条件准予；A-渲染层仍挂起**（新增 1 条 P0，不在本线计划里，但卡在 A 线数据正确性上）

上轮 2 条 P0 **都真闭合了**，这次是逐条实测确认的（§2.1）：判据已锚 `buildCard().html`，且我把 6 种 viewer 变体都跑了一遍，计数稳定（§3-1）；`criticalOf` 的修法也换成了按值判（§3-2 我再收紧了它的边界写法）。

但我在**验证"注入不同患者的档案会不会让计数变化"**时撞到一个**已在生产代码里的活 bug**：`server.mjs:1551` 传给 `buildCard` 的键名是 `injectPatient`，而 `buildCard` 解构的是 `patient:` ⇒ **注入静默失效，所有用户的资料卡渲染的都是默认档案**（实测 html 里出现的是 `刘梦圆`，不是注入的名字）。这直接推翻账号系统线 P0-2「按 uid 分桶」的落地效果：**多账号下 A 用户会看到 B 的档案**。它不是本线计划造成的，但它是 A-渲染层 ①"同格显示 `patient.source`"的**数据前置**——不修，那格显示的出处就是别人的。

| # | P0 | 一句话 | 证据 |
|---|---|---|---|
| **P0-3**（新，非本线引入） | **`buildCard` 形参名与调用点不匹配 ⇒ 档案注入失效、多用户串号** | `lib/intakeCard.js:305` `buildCard({…, **patient**: injectPatient = null, …})` vs `server.mjs:1551` `buildCard({ reports, mask, embed, **injectPatient** })` ⇒ 注入被忽略、回落 `loadPatient()`（默认 `p1`） | 实测：传 `injectPatient` → 注入名**不出现**（false）；传 `patient` → 出现（true）；默认卡出现 `刘梦圆` |

**三线放行结论**：

| 线 | 结论 | 前置 / 解除条件 |
|---|---|---|
| **B 线（打印附页）** | ✅ **维持准予** | 无新增：v0.4 对 B 只增不改，5 条判据都可复跑。**唯一提醒**：见 §3-3「sha256 零变化基线要钉 commit」 |
| **A-数据层**（`criticalOf` 真修 + `profileTriState` + `verify-card-module1.mjs` 骨架） | ✅ **带条件准予** | ① 修法按 §3-2 的收紧写法（`/^[+-]?(\d\|\.\d)/`，不是 `/^-?\d/`）；② `profileTriState` 放 `lib/cardPolicy.mjs` 或新建 `lib/riskTriState.mjs`，**不放 `intakeCard.js`**；③ **与 B 的 `package.json` 脚本改动串行**（见 §3-3） |
| **A-渲染层** | 🟡 **仍挂起** | ① 判据改法已落盘 ✅；② **UI 规格 v2 填 §4 七行显示项** ❌（仍未到位）；③ **P0-3 修掉**（否则 ① 那格显示的是默认档案的出处）；④ 用户授权 |

> **G6 照旧：审核通过 ≠ 授权编码。** 即便某天判到「可以开工」，仍需用户一句「**按以上计划执行**」才能动手；本轮 B 线维持准予 + A-数据层带条件准予，**同样受 G6 约束**。

---

## 1. P0-3 展开（新发现，直接阻塞 A-渲染层）

```js
// lib/intakeCard.js:305
export function buildCard({ reports = [], mask = false, today = null, patient: injectPatient = null, embed = false } = {}) {
  const patient = injectPatient || loadPatient()        // :306  ← 期望从 opts.patient 拿

// server.mjs:1551（/api/intake/card 内，账号系统 r6-addendum P0-2 的落点）
const card = buildCard({ reports: attachBlobIds(reports), mask, embed, injectPatient })   // ← 传的键名是 injectPatient
```

**实测（只读，内存渲染）**：

```
传 injectPatient 后出现注入名?  false      ← 注入被丢弃
传 patient       后出现注入名?  true
默认卡里出现真实患者名刘梦圆?   true       ← 回落 loadPatient()，即 data/intake/patient.json 的 p1
```

**后果（按影响排序）**：
1. **多账号串号**：`/api/intake/card` 里 `injectPatient = loadPatientFor(viewer.id)` 算了、但没用上 ⇒ 任何登录用户看到的都是**同一份默认档案**（姓名/诊断/分期/主观问题三问）。当前只有 owner 一个账号时不显形，**加第二个账号当天就串**。
2. **本线 A-渲染层 ① 直接受影响**：D-1 ① 要求"诊断/分型/阶段三态 + 同格显示 `patient.source`"——现在这格会显示 p1 的 `source="病友家属提供（未经本院核实）"`，而它属于另一个档案，等于把出处标错。
3. **审计口径也失真**：`read_report_as_admin` 记的是"admin 读了谁的报告"，但卡上档案是谁的，代码层面根本没有生效路径。

**改法（一行，改调用点；不建议改形参名，避免其它调用方连带）**：

```js
// server.mjs:1551
const card = buildCard({ reports: attachBlobIds(reports), mask, embed, patient: injectPatient })
```

**断言（进 `tests/verify-card.mjs` 或 `verify-auth.mjs`）**：
```js
const a = buildCard({ reports: [], patient: { name: '注入名XYZ' }}).html
assert.ok(a.includes('注入名XYZ'))                       // 形参 path 必须生效
// 端到端：两个账号各建一份档案 ⇒ GET /api/intake/card 的 html 里只出现自己那份的姓名
```
②更重要的是**端到端那条**：形参断言只能证明 `buildCard` 会用它，证明不了 `server.mjs` 真的传对了——**这个 bug 恰好只会在端到端才红**。

**归属**：这条不属本线计划（本线只是撞上），应记在**账号系统线 r6-addendum P0-2 的关闭台账**上（"按 uid 分桶"当时只验了 `patientFileFor` 存在与写入，没验"读端是否真用上了注入的档案"）。建议由主理人分派给该线补一笔，**不必重开本线审核轮次**——只要 P0-3 修掉并给端到端断言，A-渲染层的前置③即解除。

---

## 2. 逐条闭环核对表

### 2.1 上轮 2 条 P0

| r3 P0 | v0.4 落点 | 我的实测 | 判 |
|---|---|---|---|
| **P0-1** 判据锚源文件恒红 | D-2 改锚 `buildCard().html`，两条都改成 `= 0` | 源文件仍 2 / 1（不改也无妨，已不作判据）；**html 实测**：`高危类`=1（仅格名）、`危险度`=0 ⇒ 改格名后两条均可达 0 ✅ | ✅ |
| **P0-2** P1-8 修法对真实形状无效 | D-4b 改为按值判 `!/^-?\d/.test(...)` + 真实形状断言 | 三态实测：定性阴性→null ✅ / `0.71`→报 ✅ / 真 `0`→仍报 ✅ | ✅（边界写法见 §3-2 需收紧） |

### 2.2 r3 的分段三线

| 线 | v0.4 | 判 |
|---|---|---|
| B 准予不排队 | `:156` 提交顺序拆三条线 | ✅ |
| A-数据层只碰 cardPolicy + 新测试、`profileTriState` 不放 `intakeCard.js` | `:17` 台账 + D 段 | ⚠️ **方向对，但零交集还差一条**：`package.json` 是第二个交集（见 §3-3） |
| A-渲染层挂起排 B 后 | 同 `:156` | ✅ |

### 2.3 跨轮复现（第 4 次检查）

| 项 | 正文是否真改 | 判 |
|---|---|---|
| F8 脚本名 | v0.3 已改（`:111`），v0.4 未回退；`test:card-layout` 残留仅 `:41`（历史台账）与 `:111`（更正说明引用旧名），**无指令残留** | ✅ |
| 禁忌词判据 | D-2 正文已是锚 html 版（源文件写法只剩在"为什么改"的说明里） | ✅ |
| P1-8 修法 | D-4b 正文已换成按值判 + 真实形状断言 + 明确"不许用 status='negative' 那种错形状" | ✅ |
| 提交顺序三线 | `:156` 有独立小节 | ✅ |

⇒ **本轮没有第 4 次"台账认了文件没改"**。（顺带记一句：D-2 里作者主动写"本线第 3 次判据锚错对象，教训应记在审核侧"——这个自我归因我认，其中两次确实是我给的改法埋的坑。）

---

## 3. 五个必攻击点逐条回答

### 3-1 锚 html 后不同 viewer 会不会让计数 ≠0：**实测不会，但"锚真库"本身是个新隐患**

我把 6 种情形都跑了 `buildCard().html`：

| 情形 | `高危\|中危\|低危` | `危险度` | html 长度 |
|---|---|---|---|
| 全库（admin-like） | **1** | 0 | 88 448 |
| 只给 12 份（user-like） | **1** | 0 | 26 366 |
| **空库** `reports: []` | **1** | 0 | 12 823 |
| `mask: true` | **1** | 0 | 88 491 |
| `embed: true` | **1** | 0 | 88 390 |
| 注入不同患者档案 | **1** | 0 | 88 448 |

⇒ **计数只来自静态格名，与 viewer / mask / embed / 数据量无关**，判据稳定 ✅。**空库也是 1** 这一点尤其有用：它证明"1"不来自任何数据行。

**但「锚真库」有三个隐患，建议写进判据**：

1. **数据里已经有"高危"字样了**：2026-08-03 病原mNGS 的 `text` 含「HIV 病人等是携带的**高危**人群」。它今天没进 html（卡面不渲染 `text`），**但只要哪天把报告原文/摘要块渲染上去，判据立刻红，且红得莫名其妙**。
2. **患者档案也是数据**：`patient.diagnosis / stage / subtypeNote` 都可能含"高危"（现 p1 是"急性B淋巴细胞白血病（Common-B-ALL可能）"，没有；但用户补录分期时完全可能写"高危组"）。
3. 所以**判据应锚"固定 fixture + 冒烟"两段**：

```bash
# A. 判定用（固定夹具，不含任何含该词的数据）—— 断 0
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const h=buildCard({reports:[], patient:{name:'夹具', diagnosis:'夹具诊断'}}).html;
  const n=(h.match(/高危|中危|低危/g)||[]).length; const d=(h.match(/危险度/g)||[]).length;
  console.log(n,d); process.exit(n===0&&d===0?0:1)"     # 格名改后必须 0 0

# B. 冒烟用（真库，不算判据，只打数供人看）—— 只记录不断言
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const j=JSON.parse((await import('node:fs')).readFileSync('data/reports.json','utf8'));
  const h=buildCard({reports:j.reports}).html;
  console.log('真库计数(仅观测):', (h.match(/高危|中危|低危/g)||[]).length)"
```
**理由**：真库是活的，判据锚它 = 把"数据里出现某个词"误判成"代码写了结论"。这与本项目 R1/R2 一路的教训同源：**判据要锚被测对象的稳定形态，不锚会漂的输入**。

### 3-2 `!/^-?\d/` 的边界：**`+0.5`、`.5` 会漏报**（假阴性），给更稳写法

对 `String(row.value ?? '').trim()` 逐例判：

| value | `/^-?\d/` | 应得结论 | 判定 |
|---|---|---|---|
| `'阴性'` | 不匹配 → null | 不报 ✅ | 对 |
| `'0.71'` | 匹配 | 报 | 对 |
| `'0'` | 匹配 | **仍要报** | 对 |
| `' 0.5'`（前导空格） | 先 `trim()` → `'0.5'` 匹配 | 报 | 对 |
| `'1e-3'` | `'1'` 匹配 | 报 | 对 |
| **`'+0.5'`** | **不匹配 → null** | 报 | ❌ **漏报** |
| **`'.5'`** | **不匹配 → null** | 报 | ❌ **漏报** |
| **`'0.5×10^9'`**（值里带单位没拆） | 匹配 | 报 | 对（正则比 `Number()` 稳） |

库里今天**没有** `+`/前导点/科学计数法样本（我扫了全部危急 code 的 `value`：不以数字开头的只有那 2 条「阴性」），所以是**潜在**漏报，不是现状 bug。但"漏报比误报更危险"，不能留。

**更稳写法（正则放宽 + 保留 num 兜底）**：

```js
// cardPolicy.mjs · criticalOf 开头
if (row.qualitative === true) return null
const raw = String(row.value ?? '').trim()
if (!/^[+-]?(\d|\.\d)/.test(raw)) return null     // '阴性'⇒null；'+0.5'/'.5'/'1e-3'/'0.5×10^9' 全部通过
```

断言补 6 条（都要有）：`'阴性'`→null、`'0.71'`→报、`'0'`→**报**、`'+0.5'`→**报**、`'.5'`→**报**、`'1e-3'`→**报**。其中后三条是本轮新增的**假阴性回归位**。

### 3-3 三线零交集：**本体成立，但有两处要补**

1. **`profileTriState` 的消费者是谁、会不会逼改 `intakeCard.js`**：消费者是 A-**渲染**层（模块① 6 格 + 底部缺口行），而渲染层本来就挂起、排 B 之后 ⇒ **只要 `profileTriState` 的"定义"放 `cardPolicy.mjs`（或新建 `lib/riskTriState.mjs`），A-数据层就不碰 `intakeCard.js`** ✅。注意别在 A-数据层阶段顺手把它 `import` 进 `intakeCard.js` 并挂到返回对象上——**那一步就是渲染层，属挂起范围**。
2. **第二个交集：`package.json`**。A-数据层要加 `test:card-module1`（或复用 `test:card`），B 要加/改 `test:card-risk-ui` 与页数断言相关脚本；两线都改同一个 `package.json` ⇒ **不是文件级零交集**。判据：**两线的 `package.json` 改动必须串行（谁先谁落，后落者 rebase 一次）**，冲突面只有 scripts 那几行，成本可忽略，但必须写明。
3. **B 的 sha256 零变化基线会被 A-数据层搅浑**：`criticalOf` 一改，卡面 `critical` 标记的产出口径就变了 ⇒ 如果 A-数据层先落，B 的"改前/改后 sha256 相等"基线就没有锚了。实测今天这条修**不改变任何渲染输出**（唯二受影响的正是那两条粪便行，而它们当前没进 `p0rows`；`critical=true` 只有 `NT_PROBNP=3182.00@2026-08-02`，值 `3182.00` 以数字开头不受影响）——但**基线要钉住 commit**：
   ```bash
   BASE=$(git rev-parse HEAD)          # B 开工时锁定
   node --input-type=module -e "…buildCard({reports,mask:false}).html" | shasum -a 256   # 记录基线
   ```
   与 **`mask=0`/`embed=1` 各一份 + 固定 viewer** 三份基线一起记在交付说明里，否则"改前改后相等"会变成"和另一个 commit 的产物比"。

### 3-4 跨轮复现第 4 次：**没有**（见 §2.3，四项正文全部真改）

### 3-5 G6：已在 §0 写死——**用户一句「按以上计划执行」仍是编码前置**，且 B 线与 A-数据层的"带条件准予"都不构成授权。

---

## 4. P1 清单

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | 判据锚真库 html（数据含"高危"字样：mNGS text 一处；患者档案将来也可能含） | 改成"A. 固定 fixture 断 0 0（判据）+ B. 真库冒烟只记录不断言"（§3-1 两段式） |
| **P1-2** | 修法正则 `!/^-?\d/` 漏 `'+0.5'`/`'.5'` | 换 `/^[+-]?(\d\|\.\d)/`，断言补 3 条假阴性回归位（§3-2） |
| **P1-3** | 三线零交集没算 `package.json` | 写明"两线 `package.json` 改动串行"；并明确"`profileTriState` 的定义放 cardPolicy/新文件，**不 import 进 intakeCard**" |
| **P1-4** | B 的 sha256 零变化基线未钉 commit | 交付说明里记 `BASE=$(git rev-parse HEAD)` + 三份基线（mask=0 / embed=1 / 固定 viewer） |
| **P1-5** | **P0-3 的归属未落账** | 建议在账号系统线 r6-addendum P0-2 的台账补一行"读端注入未生效，已由 card 线 r4 P0-3 报出" |

---

## 5. 我做了什么 / 没做什么

- 只读：未改计划/代码/文档、未提交、真库零写入、未起服务。本轮跑了：`grep`、`buildCard()` 内存渲染 6 种 viewer 变体、注入参数两种键名的 A/B、`criticalOf` 修法的边界向量表、全库 value 形态扫描。
- 只写了 `.agents/card-risk-appendix-1117-review-r4.md`。
- **需实现方实测**：§3-1 两段式判据、§3-2 六条边界断言、B 线 5 条（sha256 三基线 / 越权 403 / 体积 / 不回退 text / 两路径分页）、P0-3 的端到端（两账号各一份档案 ⇒ 各看各的）。

---

## 6. 复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-3：档案注入失效（本线撞到的活 bug）
grep -n "patient: injectPatient" lib/intakeCard.js          # :305 形参名 = patient
grep -n "buildCard({" server.mjs                            # :1551 实参名 = injectPatient（不匹配）
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const j=JSON.parse((await import('node:fs')).readFileSync('data/reports.json','utf8'));
  console.log('injectPatient 生效?', buildCard({reports:j.reports,injectPatient:{name:'XYZ'}}).html.includes('XYZ'));
  console.log('patient       生效?', buildCard({reports:j.reports,patient:{name:'XYZ'}}).html.includes('XYZ'));
  console.log('默认卡含真实患者名?', buildCard({reports:j.reports}).html.includes('刘梦圆'));"

# ② P0-1：判据跨 viewer 稳定性（6 情形，应恒为 1 / 0）
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const j=JSON.parse((await import('node:fs')).readFileSync('data/reports.json','utf8'));
  const c=(h,w)=>(h.match(new RegExp(w,'g'))||[]).length;
  for(const [l,o] of [['全库',{reports:j.reports}],['12份',{reports:j.reports.slice(0,12)}],['空库',{reports:[]}],['mask',{reports:j.reports,mask:true}],['embed',{reports:j.reports,embed:true}]])
    console.log(l, c(buildCard(o).html,'高危|中危|低危'), c(buildCard(o).html,'危险度'));"

# ③ 真库里已存在的"高危"字样（说明判据不能锚真库）
node -e "const j=require('./data/reports.json');
 j.reports.forEach(r=>{const m=String(r.text||'').match(/.{0,14}高危.{0,14}/); if(m)console.log(r.reportDate,r.reportType,'|',m[0])})"

# ④ P0-2：修法边界（现有 /^-?\d/ 会漏 +0.5 与 .5）
node -e "
const reOld=/^-?\d/, reNew=/^[+-]?(\d|\.\d)/;
for(const v of ['阴性','0.71','0',' 0.5','1e-3','+0.5','.5','0.5×10^9'])
  console.log(v.padEnd(10),'旧',reOld.test(v),'新',reNew.test(v));"

# ⑤ 现状 critical 只有一条（证明那条修不改变今日渲染输出）
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const j=JSON.parse((await import('node:fs')).readFileSync('data/reports.json','utf8'));
  const c=buildCard({reports:j.reports});
  console.log('critical:',c.p0rows.filter(r=>r.critical).map(r=>r.code+'='+r.value+'@'+r.reportDate).join(','));"

# ⑥ 跨轮复现第 4 次：四项正文
grep -n "test:card-layout" .agents/card-risk-appendix-1117-plan.md      # 仅 :41 台账 / :111 更正说明
sed -n '/^2\. \*\*只摆原始值与出处/,/^3\./p' .agents/card-risk-appendix-1117-plan.md   # D-2 已锚 html
sed -n '156,162p' .agents/card-risk-appendix-1117-plan.md              # 提交顺序三线
```
