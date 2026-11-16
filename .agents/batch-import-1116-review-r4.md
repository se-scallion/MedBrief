# ① 批量导入交互重构 · 独立审核 **r4**（§8.2b 续期复审）

> 审核者：代诊-报告（只读）。被审：`.agents/batch-import-1116-plan.md` **v0.6** + 规格 v1.1；输入 `.agents/batch-import-1116-review-input-r4.md`。
> 未改计划/规格/代码、未写测试、未提交、未碰 5174 与真库。只写本文件。

---

## 0. 总判：**只准哪几条**

r3 的 P0 与四条攻击点**全部落地**（§2 核过），锚点从"全文档"改成"① 卡片几何量"是对的、比一行笔误的修复更到位。但 v0.6 的 B4 实现块里**两条规则互相打架**，78 与 1440 两档会**必然红**（P0-1）；另 3 条 P1 是判定/层级的细节。

| 组 | 条目 | 判 |
|---|---|---|
| 准予 | C-1 / C-2 / C-3 / C-4 / C-5 / C-8 / C-13 | ✅ |
| 准予 | C-7 sticky 操作栏 | 机制与判据都到位；**B4 分支判定先修**（P0-1） |
| 挂起 | C-9 多张拼接 | 维持 |
| 砍/延后 | C-6 / C-10 / C-11 / C-12 | 同意 |

**编码前置（与你的 spec v1.2 并列，不另开轮）**：P0-1 的 B4 三分支写法；spec v1.2 的五条同步。

---

## 1. P0-1：B4 里「`span ≤ 0` 走 A1b else」与「`span ≤ 100 ⇒ fail`」同时存在 ⇒ 768/1440 必红

v0.6 两处原文：
- 表格行：**「短列表 `span ≤ 0` 不进 B4，走 A1b 的 else 分支」**；
- 代码块第 3 行：`if (!(span > 100)) fail('B4 夹具不合格…')` —— **`span ≤ 0` 也落进这个 `fail`**。

两条不可同时成立。按当前代码，**凡卡片不满一屏的档必然 fail**——而 1440 下 4 张卡是 `md={8}` 两行、① 卡片大概率比视口矮（`span ≤ 0`，属**正确行为**：内容不足一屏时本来就不该吸底），768 同理。结果是把"正确实现"判成"夹具不合格"。

另一个小坑：`fail()` 之后代码仍继续 `doc.scrollTop = span*0.5` 并断言——若 `fail` 不抛错，后续会用无效 `span` 量出无意义结果。

**必改（三分支，且只有灰区才 fail）**：

```js
const span = cardBottomDoc - innerHeight
if (span > 100) {
  doc.scrollTop = span * 0.5
  await new Promise((r) => requestAnimationFrame(r))
  const gap = Math.abs(innerHeight - bar.getBoundingClientRect().bottom)
  gap <= 1 ? ok(`B4 ${w} 中途贴底 gap=${gap}`)
           : fail(`B4 ${w} 中途未贴底 gap=${gap}（static 时 = span/2 = ${(span/2).toFixed(1)}）`)
  // ↑ 这一支承担「sticky vs static」的唯一证伪
} else if (span <= 0) {
  // A1b else：内容不足一屏 ⇒ 栏在内容末尾、不吸底。**只作护栏，不承担证伪**（此档 sticky/static 不可分辨）
  ok(`A1b-else ${w} 不吸底：bar.bottom=${Math.round(bar.getBoundingClientRect().bottom)} ≤ innerHeight（span=${span}）`)
} else {
  fail(`B4 ${w} 灰区：0 < span=${span} ≤ 100 —— 夹具既不足以判贴底、也不足以判不吸底`)
}
```

配套两条口径（写进 D-4）：
1. **哪档落在灰区就调夹具/调视口，不许 `na()`**：灰区（`0 < span ≤ 100`）先用 `viewport.height − 200` 重跑该档一次（B4 只验机制，不改四档验收视口）；仍灰区才 `fail`。
2. **哪些档承担证伪，写死**：375 / 414 必须落 `span > 100`（① 卡片 4 张必然远超一屏）；768 / 1440 若 `span ≤ 0` 走 else —— 这是**预期**，不是缺陷。`sticky → static` 的证伪只在落 B4 主体的档上跑，并贴退出码 1。

---

## 2. r3 台账复核（P0 + 4 条攻击点 + 顺带一条，全部 ✅）

| r3 条目 | v0.6 落点 | 判 |
|---|---|---|
| P0 B4 锚点错对象 | 改几何锚点 `cardBottomDoc/span` + `rAF` 等一帧 + 断言式给出 `static` 的期望值 | ✅（锚点对；分支判定见 P0-1） |
| ① 用 `span > 100px` 不用屏数 | 已采纳 | ✅ |
| ② 选 3–4 张拼接灰着要给可见解释 | 3.3b：仅 `2 < N ≤ 4` 出 12px 灰字「先拼前两张，再继续加」，**不常驻** | ✅（栏高影响见 P1-3） |
| ③ A12 高于 B5、不许稀释 | 已写"改前已超 ⇒ 只有本批修掉或 A12 降记录项 + 用户书面接受"；B5 要写数值对 | ✅ |
| ④ 两条 Tag 按粒度拆 | 橙留卡片、灰并进顶部汇总一行 | ✅（文案结构见 P1-2） |
| 顺带：删掉按滚动条件渲染 | 3.2 只留 `items.length > 0`；消失由 sticky 自然实现；A3 改几何判据 | ✅ |
| 附录 A-1/A-4 规格侧 | 已请 spec v1.2（五条） | ⚠️ 规格侧待落 |

---

## 3. 三条必攻击点

### 1. `span <= 100 ⇒ fail` 会不会变成"夹具永远不合格"？——**会，而且现在就已经会**（见 P0-1）

- 1440 下 4 张卡是 `md={8}` → 2 行；`Dragger` + 2 行卡 ≈ 600px，① 卡片顶部在 116 左右 ⇒ `cardBottomDoc ≈ 716 < 900 = innerHeight` ⇒ **`span ≈ −184 ≤ 0`**。768×1024 同理更小。
- 所以答案不是"改走 A1b 但记 `na`（会顶到退出码 2）"，也不是"临时压视口"作为常态，而是：**先按 `span` 三分支，把"该档本来不该贴底"当成合法结论**（`span ≤ 0 ⇒ A1b-else`），只有 **灰区 `0 < span ≤ 100`** 才需要动夹具。
- 灰区时"压低视口造 span"是**允许且推荐**的一次性手段（B4 验的是机制不是视口），但要写进 D-4 的"允许的重跑方式"，别让实现方自己发明。
- **不许 `na()`**：夹具不够是测试自己的问题，不是被测对象的状态——按你们认的 R2 口径，`na` 只留给"环境不支持"。

### 2. 顶部汇总「未做文件查重（本批 N 张）· 疑似重复（粗判）M」——**可以，但必须两数两名 + 一条对账断言**

- 这不违反 F3：F3 禁的是**同一类"重复"的两个来源揉成一个数**（预检重复 vs 入库重复）。这里 `N`（没做哈希的文件数）与 `M`（粗判疑似重复数）是**不同语义、不同名词、并排两个数**，读起来不会混。
- 但要加两条：
  1. **名词不能省**：`N` 只能叫「未做查重」，`M` 只能叫「疑似重复（粗判）」，不许出现"重复 M/N"这种看起来像比例/一体的写法；
  2. **加一条对账断言**：`M === document.querySelectorAll('.mb-item-card [data-predup="name-size-suspect"]').length`——即汇总数必须等于卡上橙 Tag 的数量。这条能同时抓"汇总加错"和"Tag 漏打"，也顺手满足 R1（有计数必有断言消费它）。

### 3. `2 < N ≤ 4` 的灰字把栏高从 61 顶到 77，A2 会红 —— **两件都要做**

- **A2 改成"允许集合"而不是单值**：`h ∈ {49, 65, 61 + safe, 77 + safe}`（大屏两档 49 / 65，窄屏两档 61 / 77 加安全区）；断言写成"必须等于其中一档"，而不是"必须等于 61"。否则以后任何文案微调都会红，久而久之就会有人把这条断言删掉。
- **灰字必须单行、行高固定**：`white-space: nowrap; line-height: 16px; overflow: hidden; text-overflow: ellipsis`，并加一条 `el.scrollHeight <= el.clientHeight + 1`。理由是 375 下 12px 中文一旦折行，栏高就不可控（61→93），A2 与"不遮内容"会同时失准；而 `line-height: 16px` 正好让 61 + 16 = 77 与你们写的数值对上。
- 顺带：灰字文案「先拼前两张，再继续加」在 375 的按钮行上要 `ellipsis`，`title` 给全句（触屏看不到 `title` 时，前半句已够用）。

---

## 4. 复跑命令（本轮结论的证据）
```bash
cd /Users/scallion/Documents/projects/MedBrief

# P0-1：两条规则打架（表格行 vs 代码块第 3 行）
grep -n "span ≤ 0\|span <= 100\|span <= 0\|A1b 的 else" .agents/batch-import-1116-plan.md
sed -n '233,250p' .agents/batch-import-1116-plan.md      # B4 可复制实现块

# ② 段高度远大于 ① 段（锚点必须只算①卡片的理由）
grep -n "sec-upload\|sec-review" web/src/pages/IntakePage.jsx
grep -n "mb-review-grid" web/src/pages/IntakePage.jsx | head -3

# 栏高两档与灰字行（A2 允许集合的取值来源）
grep -n "49\|61\|77\|灰字\|line-height" .agents/batch-import-1116-plan.md | head -12

# 顶部汇总文案与橙 Tag 的对账对象
grep -n "未做文件查重\|name-size-suspect\|疑似重复（粗判）" .agents/batch-import-1116-plan.md | head

# 规格侧 v1.2 五条是否已落
grep -n "continue\|中途贴底\|hash=js\|bar.bottom <= 0\|先拼前两张" .agents/batch-import-1116-spec.md | head
```

**需实现方实测**：四档各自的 `span`（决定走 B4 主体还是 A1b-else）；灰区档用 `viewport.height − 200` 重跑一次；`M` 与橙 Tag 数的对账；灰字单行（`scrollHeight <= clientHeight + 1`）。

---

## 5. 我做了什么、没做什么
- 只读：未改计划/规格/代码、未写测试、未提交、未碰 5174 与真库。
- 只写了 `MedBrief/.agents/batch-import-1116-review-r4.md`。
