# ① 批量导入交互重构 · 独立审核 **r3**（§8.2b 续期复审）

> 审核者：代诊-报告（只读）。被审：`.agents/batch-import-1116-plan.md` **v0.5** + 规格 **v1.1**；本轮输入 `.agents/batch-import-1116-review-input-r3.md`。
> 未改计划/代码、未提交、未碰 5174 与 `data/reports.json`。只写本文件。

---

## 0. 总判：**只准哪几条**

r2 的 2 条 P0、5 条 P1、附录 A 的 A-1…A-6 **全部落地**（§2 逐条核）。但 v0.5 新引入 **1 条 P0 + 4 条 P1**，其中 P0 是"唯一守门判据锚错了对象"，改起来只有一行，不改则第一次跑就会误红。

| 组 | 条目 | 判 |
|---|---|---|
| 准予 | C-1 / C-2 / C-3 / C-4 / C-5 / C-8 / C-13 | 规格数值齐、判据齐 |
| 准予 | C-7 sticky 操作栏 | 机制同意；**B4 锚点必须先改**（P0-1） |
| 挂起 | C-9 多张拼接 | 维持（`MAX_STITCH = 2` 已写死在 `doStitch` ✓） |
| 砍/延后 | C-6 / C-10 / C-11 砍、C-12 延后 | 同意 |

**两条编码前置**（与你提出的"spec v1.2 落盘 + 用户一句话"并列，不另开轮）：
1. **P0-1**：B4 的量测锚点从 `documentElement.scrollHeight` 换成「① 卡片自身的 sticky 跨度」；
2. **spec v1.2**：§7.2 降级分支改"只打标"、§8 A1 拆两条、§8 增补 `?hash=js`。

---

## 1. P0 —— B4 的锚点错了，正确实现也会被判红

**现状写法**（v0.5 D-4 B4）：`documentElement.scrollTop = (scrollHeight - clientHeight) * 0.5` 后断言 `|innerHeight − bar.bottom| ≤ 1`。

**为什么错**：sticky 的**containing block 是 `.ant-card-body`**（栏是它的直接子元素，v0.5 3.5 自己写的），而 `documentElement.scrollHeight` 把 **② 校对区（`#sec-review`，`IntakePage.jsx:902`）** 也算进去了。② 段比 ① 高得多（含 DataGrid/折叠项），所以 `0.5 × 全文档 maxScroll` 很可能早已**滚过 ① 卡片底部**——此时 sticky 已到 containing block 边界、栏随卡片一起滚出视口，`bar.bottom` 远小于 `innerHeight` ⇒ **正确实现被判红**。

判据只该在"卡片仍有部分在视口下方"的区间里取点：

```js
// 在页面顶部先量绝对位置
const doc = document.documentElement;
const body = document.querySelector('#sec-upload .ant-card-body');   // = 栏的 containing block
const cardBottomDoc = body.getBoundingClientRect().bottom + doc.scrollTop;
const span = cardBottomDoc - innerHeight;        // 卡片底边在视口下方多少 px
if (!(span > 100)) fail(`夹具不合格：① 卡片底部距视口底仅 ${span}px，无法测中途贴底`);  // fail，不是 N/A
doc.scrollTop = span * 0.5;                      // 此时卡片仍跨视口底部 ⇒ sticky 必贴底
// 等一帧再量（sticky 是布局结果，scroll 后同一 tick 可能读到旧值）
await new Promise((r) => requestAnimationFrame(() => r()));
ok(Math.abs(innerHeight - bar.getBoundingClientRect().bottom) <= 1);
```

**判据与前置**：
- 前置 `span > 100`（可滚动且留出余量）**失败即 fail**——按你们自己认的 R2 口径，判定用的夹具不够长是"未验证"，不许记通过；
- 判据 `|innerHeight − bar.bottom| ≤ 1`：`static` 时 `bar.bottom = cardBottomDoc − scrollTop = innerHeight + span/2` ⇒ 恒 > 1 ⇒ **必红** ✓（这才是你想要的证伪）；
- 短列表（`span ≤ 0`，内容不足一屏）**不进 B4**，走 A1b 的 else 分支（栏在内容末尾、`bar.bottom ≤ innerHeight`）——与 D-3 第 5 条"短列表不吸底"一致。

顺带一条（同批）：`3.2` 用 `#sec-upload.bottom > 0` 做**条件渲染**是多余的——sticky 元素在其 containing block 滚出视口后本来就会消失；若坚持保留，请用 `IntersectionObserver` 而不是在 scroll 回调里 setState（否则每滚一帧 re-render，白白引入抖动与掉帧）。

---

## 2. r2 台账复核（12 条 P0/P1 + 附录 A 6 条，全部 ✅）

| r2 条目 | v0.5 落点 | 判 |
|---|---|---|
| P0-1 降级 `name+size` 静默丢卡 | 5.5「只打标不跳过」+ `predup.name-size-suspect` + 不建卡仅限 `crypto` 可用时的 exact + 顶部「疑似重复（粗判）N」 | ✅ |
| P0-2 `>=2` 事实放行 C-9 | `MAX_SELECT=4` / `MAX_STITCH=2`，`doStitch` 判 `=== MAX_STITCH`（闸门在函数里），第 5 次提示改「一次最多选 4 张」 | ✅ |
| 附录 A-2 闸门关在 `disabled` | 同上 ✔ + `disabled/aria-disabled` 降为第二道保险 | ✅ |
| 附录 A-3 A1 无分辨力 | 新增 B4；证伪改挂 B4 | ⚠️ 锚点错，见 P0-1 |
| 附录 A-1 规格缺批内一路 | 规格 v1.1 补三路；**§7.2 仍 `continue`** ⇒ 已请 v1.2 | ⚠️ 规格侧待 v1.2（计划侧 ✅） |
| 附录 A-4 规格仍写 (a) | 规格 v1.1 §7.3 改 (d)；计划 5.9 补齐 | ✅（规格侧再补两行） |
| P1-1 纯 JS 永不执行 | 5.9 `?hash=js` + 三条向量 + **两条腿各跑**（B2/B2b）+ 分块 `await` + >8MB「文件过大，未预检」 | ✅ |
| P1-2 前 1MB 折中 | 否决，理由落进 5.9⑥ | ✅ |
| P1-3 375 无基线 | B5（5194 + 副本库 + `?tab=intake`，改前先量） | ✅（处置见 P1-2） |
| P1-4 `sec` 抖动 | 3.2 改几何量 | ✅（但见 P0-1 末尾那条） |
| P1-5 逻辑/视觉切分 | D-1 分段表述 + 规格到位 | ✅ |
| 附录 A-6 sticky 前提 | B6 逐级 `overflow !== 'hidden'` | ✅ |

---

## 3. 四条必攻击点

### 1. B4 在短列表下能不能红？——**问题不在这里：它在长列表下就会误红**（见 P0-1）
你担心的"内容不足两屏"方向对，但根因不同：**不是 `0.5×maxScroll` 太靠后导致漏判，而是它算的是全文档、不是卡片跨度** ⇒ 只要 ② 校对区够高（默认就有），`0.5×maxScroll` 就滚过了 ① 卡片，sticky 已失效 ⇒ 正确实现被判红。
"要不要加'内容必然 ≥3 屏'的夹具前提"——**不要写屏数**（脆且不可解释），写成**几何前置** `span > 100px`（`span = 卡片底边绝对位置 − innerHeight`），并且 `fail` 而不是 `N/A`。3 屏这个数在不同视口/字体下不等价，而 `span` 是同一个量。

### 2. `MAX_SELECT=4` + `MAX_STITCH=2`，选 3 张时「拼接」禁用只有 `title` —— **必须给可见解释，这不是可选项**
触屏没有 hover，`title` 等于不存在；用户看到的是"我选了 3 张，拼接按钮灰着，没有任何说明"。这是**交互死角**，且正好发生在你们设计的多选上限（4）与拼接上限（2）不一致的地方。
建议（不占常驻高度）：只在 `2 < selected.length ≤ MAX_SELECT` 时，栏内出现一行 **12px 灰字**且**带下一步**——「拼接上限 2 张：先拼前两张，再继续加」；`title`/`aria-disabled` 保留作辅助。**不要**把文案常驻（0/1/2 选时不该占这行）。

### 3. B5 降级为"改后 ≤ 改前" + 交付写"横滚未修" —— **基本够，但与 A12 会打架，要先定优先级**
- `A12`（规格）是**绝对判据**：四档 `scrollWidth ≤ clientWidth + 1`。若改前已超，A12 必然红，而 B5 说"不得变差"就是绿 ⇒ 交付里会同时出现"B5 通过 / A12 失败"，读者无法判断这单到底能不能收。
- 定一条优先级：**A12 是用户可感知的硬判据，不许用 B5 把它稀释**。若改前已超：① 要么本批顺手修掉（① 段 375 横滚大概率来自卡片头部四件套或固定栏，属本批范围）；② 要么把 A12 明确降级为"记录项"，**并由用户书面接受**（不是实现方自己决定）。B5 只用来**防止冒领**，不能当免责条款。
- 另：B5 交付必须写**数值对**（改前 `X / Y`、改后 `X' / Y'`），只写"未修"没法复核。

### 4. 降级态同卡两条 Tag（灰「本次未做文件查重」+ 橙「可能重复·粗判」）—— **不是逻辑矛盾，但会读成矛盾；按粒度拆开**
两者粒度不同：橙 Tag 是**这一张的判定**，灰 Tag 是**这一批的能力状态**。并排放在同一张卡上、还重复 N 遍，用户会觉得系统自相矛盾（"没查"却又"可能重复"）。
建议：**卡片只留橙 Tag**（`可能重复（按文件名+大小粗判，请核对）`），把"本次未做文件查重"上移到**顶部汇总条**一行（「本端未做精确查重（N 张）：仅按文件名+大小粗判」）；顶部已有的「疑似重复（粗判）N」计数与它合并成同一行。这样每条信息只出现在它该出现的层级，也不会因 N 张卡而刷 N 条。

---

## 4. 复跑命令（本轮结论的证据）
```bash
cd /Users/scallion/Documents/projects/MedBrief

# P0-1：sticky 的 containing block 是卡片体，而 B4 用的是全文档 scrollHeight
grep -n "sec-upload\|sec-review" web/src/pages/IntakePage.jsx          # 881 / 902：② 紧跟在 ① 之后
grep -n "ant-card-body\|mb-upload-body" .agents/batch-import-1116-plan.md
sed -n '/\*\*B4\*\*/p' .agents/batch-import-1116-plan.md               # 现写法：documentElement.scrollHeight

# P0-1 佐证：② 段比 ① 高（② 里挂整份 DataGrid）
grep -n "mb-review-grid" web/src/pages/IntakePage.jsx | head -3

# 两个上限常量与闸门位置
grep -n "MAX_SELECT\|MAX_STITCH\|doStitch" .agents/batch-import-1116-plan.md | head

# 降级分支：只打标不跳过（计划侧）
sed -n '/5.5 降级/p' .agents/batch-import-1116-plan.md

# 规格侧仍待 v1.2 的两处
grep -n "continue" .agents/batch-import-1116-spec.md | head -3
grep -n "A1\b\|A1b" .agents/batch-import-1116-spec.md | head -5
```

**需实现方实测**：B4 的 `span` 前置（`?tab=intake`，4 张卡夹具下 `span` 应 > 100px）；短列表分支（1 张卡）走 A1b else；`?hash=js` 两条腿三条向量；B5 改前数值对。

---

## 5. 我做了什么、没做什么
- 只读：未改计划/规格/代码、未写测试、未提交、未碰 5174 与真库。
- 只写了 `MedBrief/.agents/batch-import-1116-review-r3.md`。
