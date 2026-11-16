# ① 批量导入交互重构 · 独立审核 **r5**（§8.2b 续期复审）

> 审核者：代诊-报告（只读）。被审：`.agents/batch-import-1116-plan.md` **v0.8** + 规格 v1.3；输入 `.agents/batch-import-1116-review-input-r5.md`。
> 未改计划/规格/代码、未写测试、未提交、未碰 5174 与真库。只写本文件。

---

## 0. 总判：**可以开工**（附 3 条 P1 同批落 + spec v1.4 前置）

**无 P0。** r4 那条 P0（B4 两条规则打架）已按三分支裁到终态，切法正确：`span > 100` 承担证伪、`span ≤ 0` 只作护栏且明说"两者不可分辨"、只有 `0 < span ≤ 100` 灰区才 fail——这是本轮最实质的一处改正。三条攻击点（B7 对账、B8 允许集合、压视口只作重跑方式）也照办。

剩下 3 条 P1，全在同一个 B4/B7 代码块里，改起来各一行：

| # | 问题 | 一句话 |
|---|---|---|
| P1-1 | **短列表分支（②）的断言永远绿** | `bottom − innerHeight ≤ 1` 对"任何在视口内的栏"都成立 ⇒ `sticky → fixed` 这个真实回归在短列表档上抓不到；要改成相对 containing block 底边 |
| P1-2 | **`body` 的选择器不稳** | `document.querySelector('.ant-card-body')` 会命中**第一个**；页面里每张 item 卡也是 `.ant-card` ⇒ 卡片结构调整后会指错。containing block 就是栏的父节点，直接 `bar.parentElement` |
| P1-3 | **夹具陷阱**：补造卡必须用**不同字节** | 本批新加的批内去重会跳过同字节文件 ⇒ 拿同一张图刷 3 次只会得到 1 张卡 ⇒ 永远灰区/永远走 ②，B4 主体（唯一证伪）根本不跑 |

**编码前置**：spec v1.4 落盘（你说的 5 行：A1 锚点、A3 改 `=== null`、A2 单值、§4.5 缺节、§7.4 缺对账）+ 用户说"按以上计划执行"。我不建议把 spec v1.4 省掉——规格是实现方的直接输入，现在它正文仍是旧值，照规格做会与计划打架（这在 r3 的 (a)/(d) 上已经演过一次）。

---

## 1. r4 台账复核（P0 + 3 条攻击点，全部 ✅）

| r4 条目 | v0.8 落点 | 判 |
|---|---|---|
| **P0** B4 两条规则打架 | 三分支：主体 / A1b-else / 仅灰区 fail；`fail` 后 `return`，不再用无效 `span` 继续量 | ✅ |
| 攻击点① 用 `span > 100px` 不用屏数 | 已采纳 | ✅ |
| 攻击点② 顶部 M === 橙 Tag 数 | 新增 **B7** | ✅（口径见 §3-2） |
| 攻击点③ A2 改允许集合 + 灰字单行 | 新增 **B8**：`{49, 65, 61+safe, 77+safe}` + `nowrap` / `line-height:16px` / `scrollHeight ≤ clientHeight+1` | ✅ |
| 压视口只作允许的重跑方式 | 写进灰区分支 | ✅（写法有小误，见 P1-3 末） |
| 灰区不许 `na()` | 已写明 | ✅ |

---

## 2. 三条 P1（同批落，不改方案结构）

### P1-1 短列表分支的断言分不出 `sticky` 和 `fixed`（等于少了一半护栏）

v0.8 ② 分支：滚到底后断 `bar.bottom − innerHeight ≤ 1`。问题是它**只会**在"栏被推到视口下方"时红——而 `fixed` 恰恰会把栏钉在视口底（`bottom ≈ innerHeight`）⇒ **这条断言对你们最想防的那个回归（`sticky → fixed`）是绿的**。

改成相对 containing block 底边，一眼就能分辨：

```js
const gapFromBody = Math.abs(bar.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom)
gapFromBody <= 1 ? ok(`B4 ${w} 短列表：栏贴在内容末尾（sticky 正确；fixed 时会贴到视口底 = ${innerHeight}）`)
                 : fail(`B4 ${w} 短列表：栏不在内容末尾，偏 ${gapFromBody.toFixed(1)}px（疑似 fixed/absolute）`)
```

这样 ② 就从"永远绿的护栏"变成"能红但没有证伪义务"的护栏（与你写的口径一致）。

### P1-2 `body` 用 `bar.parentElement` 取，别用全局 `querySelector('.ant-card-body')`

v0.5 3.5 已经写死"栏必须是 `.ant-card-body` 直接子元素"，所以 containing block **就是** `bar.parentElement`——用它既准确又自锚定。用 `document.querySelector('.ant-card-body')` 的风险是实打实的：页面上每张 item 卡也是 `.ant-card`（各带 `.ant-card-body`），今天靠 DOM 顺序碰巧命中外层，将来有人给卡片加一层包裹就指错，而错的时候 `span` 会变成另一张卡的量，判据会以"夹具不合格"的形式误导人。

```js
const bar  = document.querySelector('.mb-batchbar')
const body = bar.parentElement          // = 3.5 要求的 .ant-card-body，自锚定
```

### P1-3 灰区重跑**不算放宽**，但必须补一条"夹具用不同字节"的前置

**判断**：改 `viewport.height` 改的是**夹具**，不是判据——判据（`|innerHeight − bar.bottom| ≤ 1`）一个字没动 ⇒ 不算放宽。允许，且你限定"只重跑一次"是对的。

但有一个本批自己埋的坑：**同一张图传 3 次，批内去重（5.3b）会跳过后面两张 ⇒ 只有 1 张卡**。若夹具是这么造的，`span` 永远落在 ≤ 0（走 ② 分支）或灰区 ⇒ **B4 主体（唯一承担 `sticky → static` 证伪的那条）永远不跑，而整套测试仍然"通过"**。这属于"跑了但没验到"，比失败更难发现。

**必改**（写进 D-4 的夹具要求 + 一条前置断言）：
```js
// 夹具前置：≥3 张**不同字节**的卡（否则批内去重会把它们并成 1 张）
const n = document.querySelectorAll('.mb-item-card').length
if (n < 3) fail(`B4 ${w} 夹具不合格：仅 ${n} 张卡（需 ≥3 张且字节互不相同）`)   // fail，不是 na
```
造法：`setInputFiles` 传 3 个**内容不同**的 payload（改一个字节/换一张真实小图），或从副本库已有的 blob 字节读出多份不同文件。**不许**用同一 payload 重复三次。
另：灰区重跑那段伪代码里 `height: Math.max(320, innerHeight - 200)` 把页面上下文变量写进了 node 上下文，实现时要用**该档视口高度**（如 `1440×900 → 1440×700`）。

---

## 3. 两条必攻击点

### 1. 灰区重跑是否变相放宽？——不是，但要给"仍灰区"一条出口，而不是让它永远 fail

- 判据没动、只动夹具 ⇒ 不是放宽。三条边界要写死：① **只允许两种手段**——按 `viewport.height − 200` 重跑一次；或补造卡（见 P1-3 的不同字节要求）。② **两手段用尽仍灰区 ⇒ 判不合格**（灰色本身就是布局异常信号：卡片高度恰好卡在视口边缘，通常意味着某个块的高度失控）。③ **不许 `na()`** ✓ 已有。
- 你问"要不要加前置 `items.length < 3` 就补造卡"——**要，但不能只判 `items` 长度**，还要判"它们字节不同"（否则就是 P1-3 那个坑）。写成上面的 `n >= 3` 前置即可，`items` 里是不是同字节由夹具保证。
- 顺带：375 下 1 张卡的 `span ≈ −13`（431 + 160 + 208 ≈ 799 < 812），2 张卡 `span ≈ 195` ⇒ 灰区只在"1.5 张卡"那条窄带上；所以"≥3 张"这个要求足以让 375/414 稳进主体分支。1440/768 走 ② 是预期（内容不满一屏）。

### 2. B7 从 DOM 数还是 state 数？——**现在两个都断，主判 DOM**

- 现状可核：`items.map` 全量渲染（`UploadPanel.jsx:71`），**无分页、无虚拟化、无折叠** ⇒ DOM 数与 state 数应当恒等，直接用 DOM 数**更不容易漏**——它能抓到"汇总写 M 但只渲染了 M−1 张卡"这类渲染漏（state 数抓不到）。
- 但为了不把将来（分页/虚拟化）的可能性变成今天的假红，**加一条辅断言**：给汇总节点挂 `data-testid="mb-predup-count" data-value={M}`（值取自 state），断 **`Number(dataset.value) === 橙 Tag 个数`**。两条一起断的好处是：主判抓"用户看到的一致性"，辅断言抓"state 与渲染的偏差"，谁红都能定位到不同层。
- 一条口径写进 D-4：**将来若列表改成分页/虚拟化，B7 降级为"当前页内一致"**，辅断言保持不变。今天不降级。

---

## 4. 复跑命令（本轮结论的证据）
```bash
cd /Users/scallion/Documents/projects/MedBrief

# P1-1：② 分支现写法（只会红在"被推到视口下方"）
sed -n '282,289p' .agents/batch-import-1116-plan.md

# P1-2：'.ant-card-body' 在页面上有几个（item 卡也是 .ant-card）
grep -n "<Card" web/src/pages/intake/UploadPanel.jsx          # 外层 + 每张 item 各一个
grep -n "mb-upload-body\|ant-card-body" .agents/batch-import-1116-plan.md

# P1-3：批内去重会不会把夹具并成 1 张（本批自己引入的坑）
sed -n '/5.3b/p' .agents/batch-import-1116-plan.md

# 三分支与灰区重跑
sed -n '268,300p' .agents/batch-import-1116-plan.md

# 规格 v1.4 的 5 行是否仍为旧值
grep -n "A1\b\|=== null\|61 + safe\|§7.4\|对账" .agents/batch-import-1116-spec.md | head
```

**需实现方实测**：四档各自的 `span` 与所走分支；夹具 ≥3 张不同字节；`sticky → static` 只在走主体分支的档上贴退出码 1；B7 主/辅两条；B8 四档栏高落在允许集合内。

---

## 5. 我做了什么、没做什么
- 只读：未改计划/规格/代码、未写测试、未提交、未碰 5174 与真库。
- 只写了 `MedBrief/.agents/batch-import-1116-review-r5.md`。
