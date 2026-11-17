# 问诊卡①危险分层 + 打印自定义附页 · 独立审核 **r3**（续期复审）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/card-risk-appendix-1117-plan.md` **v0.3**；旁证：`docs/问诊卡危险分层标线候选.md`、`.agents/card-risk-appendix-1117-ui-spec.md`（现为 **v1.2**，标题已更正、容器③标题已改）。
> 输入：`.agents/card-risk-appendix-1117-review-input-r3.md`（r2 终判原文 + 5 个必攻击点）。
> 上轮：`.agents/card-risk-appendix-1117-review-r2.md`（只准哪几条：B 准予、A 挂起，1 P0 + 9 P1）。
> 未改计划/代码、未提交、真库零写入（`buildCard()` 只在内存跑，未起服务）。**只写了本文件**。

---

## 0. 总判：**只准哪几条** —— **B 线维持准予；A 线仍挂起**（2 条 P0，都在 A 线）

r2 的 9 条 P1 **确实裁到位了**（含那条跨轮复现的 F8，这次是真改正文，见 §2.2）。但 **P0-1 没真闭合**：拆成两条之后**两条各自仍然恒红**，只是红的原因从"文案对撞"换成了"锚错了对象 + 两处自相矛盾"（§1-A）。

而且我在复核 P1-8 时发现**那条修法对自己引用的数据无效**——库里那两条记录的 `status` 是 `'normal'`（不是 `'negative'`），`qualitative` 也没设 ⇒ `if (row.qualitative || row.status === 'negative') return null` **根本不触发**，假危急照旧（§1-B）。这是本轮新增的 P0。

| # | P0 | 一句话 | 证据 |
|---|---|---|---|
| **P0-1** | **拆开的两条判据仍然都恒红**（上轮 P0 未真闭合） | ①结论判据 `grep -c '高危\|中危\|低危' lib/intakeCard.js = 0`：实测 **2**（`:213` 注释 + `:1402` 格名），**改格名后 = 1**（注释残留）⇒ 到不了 0；②允许清单 `grep -c '危险度' = 2`：实测 **1**（`:46` 注释），而 D-1 已把提示语的"危险度"换成"危险分组"、UI 容器③也已改成"分期/分组"⇒ 无论怎么改都到不了 2。**D-2 的假设与 D-1 的改法互相矛盾** | §1-A |
| **P0-2** | **`criticalOf` 的一行修对真实数据不生效**（新） | 库里 2026-08-03/04 两份粪便常规「白细胞 阴性」的实际形状是 `code:'WBC', num:0, status:'normal', flag:'negative', qualitative:undefined`；v0.3 的守卫条件（`qualitative` / `status==='negative'`）**两者都不命中** ⇒ 我模拟打过补丁的函数，仍返回 `{label:'WBC',value:0}` ⇒ "WBC 0 危急"照旧 | §1-B |

**分段放行结论（你问的"仍挂起还是带条件准予"）**：

- **B 线**：✅ **维持准予开工**，v0.3 对 B 只增不减（补了体积优先、不二次取 blob、两路径分页、提交顺序），**未引入新耦合或新雷**（§3-4）。
- **A 线**：🟡 **仍挂起**（两条 P0 都在 A 线，判据层与修复层都没真到位）。但拆出一个**可带条件准予的子集**：

| A 线子集 | 结论 | 理由 |
|---|---|---|
| **A-数据层**：`criticalOf` 真修 + `profileTriState` + `tests/verify-card-module1.mjs` 骨架（**只碰 `lib/cardPolicy.mjs` 与新建测试文件**） | ✅ **带条件准予**，可与 B 并行 | 与 `lib/intakeCard.js` 零交集 ⇒ 不与 B 抢文件；不含任何版面 |
| **A-渲染/版面层**：模块①区块渲染、格名改名、6 格内容 | 🟡 **挂起** | 三条硬前提：① P0-1 判据改法落盘 ② P0-2 修法改正 ③ **UI 规格 v2 把 §4 七行显示项填成数值规格**（现在 §4 仍是"待审核确认"的问句形态） |

> **「AI 审核通过 ≠ 授权编码」（G6）**：即便有一天判到「可以开工」，仍需用户一句"按以上计划执行"才动手；本轮 B 线虽然维持准予，**同样受 G6 约束**。

---

## 1. 两条 P0 展开（都附实测）

### P0-1 判据拆成两条之后，两条**各自**还是红的

v0.3 `§D-2`：

> - **结论判据**：`grep -c '高危\|中危\|低危' lib/intakeCard.js = 0`（格名"分子与高危基因"改为"分子与遗传学标签"后应为 0）
> - **允许清单判据**：`grep -c '危险度' lib/intakeCard.js = 2`（…"危险度"只应出现在块首提示语与容器③外的固定说明两处…）

**实测（源文件）**：

```bash
grep -c '高危\|中危\|低危' lib/intakeCard.js     # → 2
#   213:  // ① 分子与高危基因标签：阳性优先（真实数据里 BCR::ABL1 的阳性写在 status，不在 value）
#   1402: <div class="sb-cell"><div class="sb-t">分子与高危基因</div>…

grep -c '危险度' lib/intakeCard.js               # → 1
#   46:   // …这段长串不再塞进「分型/危险度」输入框，改为只读注释…
```

⇒ **结论判据**：改掉 `:1402` 的格名后还剩 `:213` 那行**注释** ⇒ **= 1，不是 0**。计划括号里"改后应为 0"这句不成立。
⇒ **允许清单判据**：D-1 已经把提示语改成"不等同于**危险分组**结论"、UI `:57` 容器③也已改成"分期/**分组**（原文）"——**"危险度"在渲染文案里已经是 0 处**，只剩 `:46` 一行与本次改动无关的历史注释 ⇒ **永远到不了 2**。**D-2 的假设（提示语还含"危险度"）与 D-1 的改法直接打架。**

**这已经是本线第三次"判据锚错对象"**：r3 账号线是 containment 锚 `distDir`（恒真）、r5 是 `/index.html` 必须 403（恒红）、这次是**把"医生看得到的渲染文本"换成"源文件字节"**——源文件里有注释、有历史说明，本来就不该拿来当"卡面文案"的判据。

**正解：判据锚到渲染产物**（我实测过，两条都能绿也能红）：

```bash
# 用 buildCard() 产出真实 html，再判（不起服务、不写库）
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const j=JSON.parse((await import('node:fs')).readFileSync('data/reports.json','utf8'));
  process.stdout.write(buildCard({reports:j.reports}).html)
" > /tmp/card.html

grep -c '高危\|中危\|低危' /tmp/card.html   # 当前 = 1（就是那个格名）；改格名后 = 0  ✅ 可绿
grep -c '危险度'        /tmp/card.html   # 当前 = 0；**允许清单应为 0**，不是 2     ✅ 可绿
```

实测当前 html 里：`高危` **1 次**（仅格名）、`中危` 0、`低危` 0、`危险度` **0**、`危险分组` 0。
⇒ 判据应为 **`高危/中危/低危` = 0（改格名后）+ `危险度` = 0（保持）**；如果坚持要保留"允许清单"这个概念，就用"**逐行列出命中的行号并注明用途**"这种形式，不要写死一个数（写死数字 = 下一次必定又漂）。

**另注**：若仍想锚源文件，那就必须把 `:213` 注释与 `:1402` 格名**成对改名**，并把 `:46` 那句改成不含"危险度"的说法（如"分型/分期输入框"）——三处一起改，才能让 `= 0` 成立。**但我不推荐这条**：注释随代码演化一定会再引入该词。

### P0-2 `criticalOf` 的一行修**不生效**（对它自己引用的那两条数据）

v0.3 `§D-4b` 写：

> 库里 2026-08-03/04 两份粪便常规「白细胞 阴性」正是 `code=WBC,num=0,**status=normal**`
> **一行修**：`criticalOf` 加 `if (row.qualitative || row.status === 'negative') return null`

**这段自己就露了——引用的证据写着 `status=normal`，修法却去判 `status === 'negative'`。** 我实测了那两条记录的真实形状：

```
{"code":"WBC","value":"阴性","num":0,"status":"normal","flag":"negative","qualitative":undefined}   ×2
```
- `qualitative` = **undefined**
- `status` = **'normal'**（不是 'negative'）
- 只有 `flag` = `'negative'`

⇒ 两个条件**都不命中**。我把补丁打上跑了一遍：

```
库里真实的粪便白细胞行 → {"label":"WBC","value":0}      ← 假危急照旧
```

**你问的"会不会误伤真危急（status='negative' 但 num 非 0）"—— 方向上几乎不会，但那不是本轮的风险所在**：
- 全库 `status==='negative'` 的行只有 **2 条**，都是这两条粪便、`num` 都是 0 ⇒ 现状没有"真数值却被 status 误杀"的样本；
- 真正的风险是**修了个不生効的东西**：写在计划里像已解决，实现方照着打补丁、写断言（"构造 `status='negative'` 的行 ⇒ 不返回 critical"）**也会绿**——因为它构造的是错的形状。**这是"判据永远绿"的又一个变体：用一个成功≠修好的断言把自己骗过去。**

**正解：按"值是不是数值"判**（不是按 status 判），并给三条断言把边界钉住：

```js
// cardPolicy.mjs · criticalOf 开头
if (row.qualitative === true) return null
if (!/^-?\d/.test(String(row.value ?? '').trim())) return null   // 定性词（阴性/阳性/未见/±）一律不进数值危急
```
我实测这三种情况的输出：

| 输入 | 结果 | 是否符合要求 |
|---|---|---|
| 库里的粪便行 `{code:'WBC',value:'阴性',num:0}` | `null` | ✅ 假危急消失 |
| 真 `{code:'WBC',value:'0.71',num:0.71}` | `{label:'WBC',value:0.71}` | ✅ 真危急照报 |
| 真 `{code:'WBC',value:'0',num:0}` | `{label:'WBC',value:0}` | ✅ **"真数值 0 仍要报"**（正是你问的边界） |

配套断言（进 `verify-card-module1.mjs`）：①构造 `{code:'WBC',value:'阴性',num:0,status:'normal',flag:'negative'}` ⇒ **null**；②构造 `{code:'WBC',value:'0',num:0}` ⇒ **非 null**；③跑一遍真库全量 `criticalOf`，把命中项打出来人工过目（应只有 `NT_PROBNP 3182.00@2026-08-02` 一条量级正常）。

---

## 2. 逐条闭环核对表

### 2.1 r2 的 1 条 P0

| r2 P0 | v0.3 落点 | 判 |
|---|---|---|
| 禁忌词判据恒红 | D-1 提示语改词 + D-2 拆两条 + UI 容器③改名 | ❌ **两条各自仍恒红**（§1-A）→ **P0-1** |

### 2.2 r2 的 9 条 P1

| # | 落点 | 判 |
|---|---|---|
| P1-1 7 项 vs 6 格 | D-1：⑦ 缺口清单改底部一行 12px 文案，6 格摆①–⑥ | ✅（符合"7 项不进格"的最小改法；UI 预算 ≤96px 不变） |
| P1-2 体积 vs 10 份 | D-6：体积优先，累计 >8MB 拒绝该份并给"已选 X 份/合计 Y MB" | ✅ |
| P1-3 F8 第 3 次复发 | F8 `:111` **正文真改**为 `verify-card-module1.mjs` / `verify-card-risk-ui.mjs`，并自带"第 3 次同类复发"更正说明。全文 `test:card-layout` 残留 2 处均为**元叙述**（`:41` 台账、`:111` 更正引用），不是指令 | ✅（这次是真改） |
| P1-4 二次取 blob | D-5 补"只从本函数内已过滤的 `reports` 取 `blobId`，不得再查库/再 `getBlob()`" | ✅ |
| P1-5 诊断 provenance | D-1 ① 同格显示 `patient.source`「未经本院核实」 | ✅ |
| P1-6 ②③ 重复 0% | D-1 ③ 写"见②·2026-09-29 RQ-PCR" | ✅ |
| P1-7 t(9;22) 可核对象 | D-1 ⑤ 抽取值 + 原文片段 + report id 三者同格 | ✅ |
| P1-8 criticalOf 假危急 | D-4b 一行修 + 断言 | ❌ **修法对真实数据不生效**（§1-B）→ **P0-2**；台账"✅ 我已独立复算属实"——复算的是**命中**属实（那部分对），但没复算**修补后是否命中消失** |
| P1-9 UI 版本号矛盾 | UI 已升 **v1.2**、标题已改、容器③已改"分期/分组" | ⚠️ 基本解决，仅 `§5` 小节标题仍写"（v1.0）"（P1-1 级小残留） |

### 2.3 旁证文件

| 文件 | 判 |
|---|---|
| `docs/问诊卡危险分层标线候选.md` | ✅ r2 §3-2 的两处收紧**都已落**：`:17` 加"规则层成立；当前卡面并未渲染该危急项（实测 p0rows 无 WBC 行、critical 仅 NT_PROBNP）"、`:24` 加"本行数字只用于说明'方法决定阈值'，不得作为默认值写进配置" |
| UI 规格 **v1.2** | ✅ 容器③ `:57` = `③ 分期/分组（原文）`；`:11` 记录了"去掉危险度"的更正；`:7` 有 v1.1 更正记录（判据写 `/tmp`/写成已完成态的自我更正）。⚠️ `§4`（七行显示项）**仍未填**，仍是问句形态 ⇒ A 线版面门未开 |

---

## 3. 五个必攻击点逐条回答

### 3-1 P0-1 拆两条是否真消除恒红：**没有，两条各自仍红**（你点名的第①件）

- `高危/中危/低危 = 0`：源文件实测 **2**，改格名后 **1**（`:213` 注释残留）⇒ 到不了 0。
- `危险度 = 2`：源文件实测 **1**，且 D-1 已把文案里的"危险度"删净（UI 侧也改成"分组"）⇒ 只能更小，到不了 2。
- **两条判据的锚都错了**：判据要守的是"**医生看到的卡面上不能有结论性字样**"，锚应该是 `buildCard().html`，不是源文件（源文件含注释/历史说明）。实测 html 里 `高危` = 1（仅格名）、`危险度` = 0 ⇒ 改成 **`高危/中危/低危` = 0（改格名后）+ `危险度` = 0（保持）** 就能同时"能红能绿"。
- 你问的"改格名后 `高危`=0 是否成立，注意 cardPolicy 注释里也有'高危'但判据锚 intakeCard"——**`cardPolicy.mjs` 的注释不影响（判据只锚 intakeCard）✓，但 intakeCard 自己 `:213` 那条注释会**，这就是漏掉的那一处。

### 3-2 P1-8 一行修的正确性与边界：**修法不生效；"误伤"方向反而不是问题**（你点名的第②件）

见 §1-B。三点结论：
1. **不生效**：真实行是 `status:'normal' / flag:'negative' / qualitative:undefined`，守卫不触发，模拟打过补丁仍返回 `{WBC,0}`。
2. **误伤不是当前风险**：全库 `status==='negative'` 仅 2 行且 `num=0`；但这不代表可以按 status 判——将来一条"定量阴性但数值高"的行会被误杀。
3. **判据化的正确边界**：按**值是否是数值串**判（`/^-?\d/`），三条断言钉住：定性阴性 ⇒ 不报；真 `0.71` ⇒ 报；真 `0` ⇒ **仍报**（你点的那条边界，实测满足）。

### 3-3 A 线现在仍应挂起还是带条件准予：**A 线整体仍挂起；但 A-数据层可带条件准予**（你点名的第③件）

三前提的现状：
1. **P0 判据改法落盘** → ❌ 本版没到位（拆了两条，两条都还红）；
2. **UI v2 填 §4 七行** → ❌ 仍未到位（§4 还是"需要审核给出的东西"的问句形态；不过**审核侧该给的 7 项 r1 §5.1 / D-1 早已给出**，所以下一步纯属 UI 落规格）；
3. **7 项 vs 6 格** → ✅ 已裁（⑦ 移出格、改底部一行）。

⇒ **A 线整体挂起**。但允许拆出 **A-数据层** 并行推进（`criticalOf` 真修 + `profileTriState` + `verify-card-module1.mjs` 骨架），因为它**只碰 `lib/cardPolicy.mjs` 与新建测试文件**，与 B 线的 `server.mjs`/`intakeCard.js` 零交集——这也是对你 v0.3"提交顺序：B 先落、A 后落"的一个细化：**A-数据层不需要排队，可与 B 并行；只有 A-渲染层需要排在 B 之后**。

### 3-4 B 线准予是否仍成立：**成立，且 v0.3 未引入新雷**

- v0.3 对 B 的三处增量都是**收紧**（体积优先于 ≤10 份、不二次取 blob、两条路径分页），没有放松任何一条；
- 新增的"提交顺序"写死 ✓，但建议按 §3-3 细化成"A-数据层可并行 / A-渲染层排 B 之后"；
- 我复核的 B 侧事实未变：`/api/intake/card` 的 viewer 过滤在 `server.mjs:1514-1545` 已生效、`blob/:id` 有 `authn.ownsBlob`、`embed=1` 下 `intakeCard.js:1378` 会把分页改成 margin（附页必须自带 `page-break-before`）、blob 体积 118 份/82 MB/最大 5.5 MB/中位 378 KB（决定 ≤3MB/≤8MB 这两条上限是合理量级）。
- **唯一提醒**：B 线开工时 `lib/intakeCard.js` 只有它一个 owner；A-数据层若把 `profileTriState` 放进 `intakeCard.js` 就会破零交集 ⇒ **`profileTriState` 应放 `lib/cardPolicy.mjs`（或新文件 `lib/riskTriState.mjs`），不要放 intakeCard.js**。这条请写进计划。

### 3-5 跨轮复现第 3 次与处置：**F8 这次真改了；你的处置正确**

- `grep -n 'test:card-layout'` → 仅 `:41`（v0.3 台账，说明改名历史）与 `:111`（F8 正文里的**更正说明**，引用旧名以说明为何改），**没有一处仍在下指令**。✅
- `testing-lessons.md` 是他人在途、不认领 + 回报主理人 —— **处置正确**，符合 F9"不认领他人正在改的文件"。补充一句：这条教训的归属应记在**审核侧**（我连续三轮各记一次"判据锚错对象"），建议由主理人合并成一条方法论写进 testing-lessons，而不是记成"计划方复发 3 次"——三次里有两次是我给的改法本身埋的坑（r2 P0-1 的 `grep -c` 合并写法、本次 D-1 删词与 D-2 保留数字的矛盾）。

---

## 4. P1 清单（A 线渲染层开工前须清前两条）

| # | 问题 | 改法 |
|---|---|---|
| **P1-1** | D-2 的"允许清单 `危险度 = 2`"与 D-1 的改法矛盾，且这个数在改完后**必然为 0/1** | 删掉"= 2"，改成"`危险度` 在 **html** 里 = 0；若将来必须出现，逐行列出并注明用途**（不写死数字） |
| **P1-2** | 判据锚在源文件（含注释）而非渲染产物 | 改成 §1-A 的 `buildCard().html > /tmp/card.html` 再 grep 的两条判据；并写进 `verify-card-module1.mjs` |
| **P1-3** | `profileTriState` 的落点未定，若落在 `intakeCard.js` 会破 A/B 零交集 | 明确放 `lib/cardPolicy.mjs` 或新建 `lib/riskTriState.mjs` |
| **P1-4** | 提交顺序需细化 | "A-数据层（cardPolicy + 新测试）可与 B 并行；**A-渲染层**（intakeCard.js ① 段）排 B 之后，单独 commit + 单独重启自验 head" |
| **P1-5** | UI `§5` 小节标题仍写"（v1.0）"，而文件已是 v1.2 | 交 UI 一并改（属规格方） |

---

## 5. 我做了什么 / 没做什么

- 只读：未改计划/代码/文档、未提交、真库零写入。本轮跑了：`grep` 计数、`buildCard()` 内存渲染（拿 html 做禁忌词实测）、把 v0.3 的补丁**模拟打进一份内存函数**验证它对真实数据是否生效。
- 只写了 `.agents/card-risk-appendix-1117-review-r3.md`。
- **需实现方实测**：改后的两条 html 判据、`criticalOf` 三条断言（定性阴性/真 0.71/真 0）、B 线 5 条（sha256 零变化、越权 403、体积上限、不回退 text、两路径分页）。

---

## 6. 复跑命令清单

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① P0-1：源文件 vs 渲染产物，两条判据到底能不能绿
grep -c '高危\|中危\|低危' lib/intakeCard.js          # → 2（:213 注释 + :1402 格名）
grep -n '高危' lib/intakeCard.js                      # 看清两处分别是什么
grep -c '危险度' lib/intakeCard.js                    # → 1（:46 注释）；判据要求 2 ⇒ 恒红
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const j=JSON.parse((await import('node:fs')).readFileSync('data/reports.json','utf8'));
  const h=buildCard({reports:j.reports}).html;
  for(const w of ['高危','中危','低危','危险度','危险分组']) console.log(w,'→',(h.match(new RegExp(w,'g'))||[]).length);
"                                                     # 高危 1（格名）/危险度 0 ⇒ 锚 html 才可绿

# ② P0-2：那条修法对真实数据是否生效
node -e "const j=require('./data/reports.json');
 j.reports.forEach(r=>(r.rows||[]).forEach(x=>{if((x.code||'')==='WBC'&&String(x.value).includes('阴性'))
  console.log(JSON.stringify({code:x.code,value:x.value,num:x.num,status:x.status,flag:x.flag,qualitative:x.qualitative}))}))"
#   期望看到 status:'normal' / flag:'negative' / qualitative:undefined ⇒ v0.3 的守卫不触发
node -e "
function patched(row={}){ if(row.qualitative||row.status==='negative')return null;
  const n=Number(row.num??row.value); return (row.code==='WBC'&&Number.isFinite(n)&&(n<1||n>50))?{label:'WBC',value:n}:null; }
console.log('v0.3 修法 →', JSON.stringify(patched({code:'WBC',value:'阴性',num:0,status:'normal',flag:'negative'})));"
node -e "
function fixed(row={}){ if(row.qualitative===true)return null;
  if(!/^-?\d/.test(String(row.value??'').trim()))return null;
  const n=Number(row.num??row.value); return (row.code==='WBC'&&Number.isFinite(n)&&(n<1||n>50))?{label:'WBC',value:n}:null; }
console.log('按值判定·定性阴性 →', JSON.stringify(fixed({code:'WBC',value:'阴性',num:0,status:'normal',flag:'negative'})));
console.log('按值判定·真 0.71    →', JSON.stringify(fixed({code:'WBC',value:'0.71',num:0.71})));
console.log('按值判定·真 0       →', JSON.stringify(fixed({code:'WBC',value:'0',num:0})));"

# ③ 现状卡面：critical 只有一条（说明今天被折叠掩盖，不是已修）
node --input-type=module -e "
  const {buildCard}=await import('./lib/intakeCard.js');
  const j=JSON.parse((await import('node:fs')).readFileSync('data/reports.json','utf8'));
  const c=buildCard({reports:j.reports});
  console.log('p0rows',c.p0rows.length,'| critical:',c.p0rows.filter(r=>r.critical).map(r=>r.code+'='+r.value+'@'+r.reportDate).join(','));"

# ④ P1-3 跨轮复现：F8 是否真改
grep -n 'test:card-layout' .agents/card-risk-appendix-1117-plan.md      # 仅 :41 台账 / :111 更正说明
sed -n '111p' .agents/card-risk-appendix-1117-plan.md

# ⑤ 旁证：候选清单两处收紧 / UI 容器③已改
grep -n '规则层成立\|不得作为默认值' docs/问诊卡危险分层标线候选.md
grep -n '分期/分组\|分期/危险度' .agents/card-risk-appendix-1117-ui-spec.md
sed -n '155,168p' .agents/card-risk-appendix-1117-ui-spec.md            # §4 七行仍待填 = A 线版面门
```
