# ① 批量导入模块 —— 交互与界面重构（需求整理 + 排雷）**v0.9**

> 触发（用户原话，2026-11-16 22:58，附截图 2186×1480）：
> 「批量导入模块需要重新设计交互和界面。」
> 一、简化界面：①「选择和删除按钮是文字按钮，删除按钮可以换成 Icon 按钮。选择可以变成一个多选框。」
> ②「这个识别按钮做一下简化和必要分析。每个报告下方的识别可以去掉吗。只保留一键识别，如果某个识别错误，可以出现一个重新识别。」
> ③「重复报告的提示设计，在刚导入时就可以检测和提示。在点击识别后，也可以进行提示。」
> ④「当报告比较多的时候，需要选中报告，再跑到页面上方点击拼接，这样很麻烦，所以移动端和大屏端都应该将拼接等一些操作按钮放在页面下方浮动固定。」
> 二、移动端交互优化：「在下方固定操作区，用定位 Fixed。应该有哪些固定按钮？比如一键识别导入，一键删除，或者拆开，一键识别、一键导入。」
> 「可以再点选资料后，再出现需要点选之后的按钮：删除和拼接。如果选择一份报告，那么就在固定操作区出现删除。选择 2 份以上，出现拼接按钮。」
> 「如果再进一步优化，是不是可以隐藏其他无关按钮？」
>
> 排雷：**无项目定制层**（`grep -rlF '**通用层**：~/.agents/skills/plan-review.md' .` 命中 4 个文件，全是正文引用，不是文件头标记），仅通用层。
> 状态：**v0.3 方案，未编码**。作者：代诊-Manager。实现方：待定。
> 审核：代诊-报告 **r1**（只准哪几条）+ **r2**（只准哪几条，另有附录 A 的规格 delta 判词）＋ **r3**（只准哪几条，1 条 P0 = B4 锚点错对象）已出；v0.6 已裁到终态并送 r4；**r4**（只准哪几条，1 条 P0 = B4 两条规则自相打架）已出，v0.8 裁到终态已送 r5。
> 规格现为 **v1.3a**（`a743ba4` + `32687e1`）：A1 已改 span 锚点、A3 已几何化、A2 三态 + 差=16、§4.5 灰字、Tag 粒度上移、375 extra 折叠成 `+N` —— v0.9 已全部吸收；**唯 A1 的 `span ≤ 100 ⇒ fail` 与 r4 P0 同构（负 span 也 fail），仍欠 v1.4 一行**。
> 规格现为 **v1.3**（`1d2d609` 的 v1.2 + r3 的 5 条，工作树未提交）；v0.7 采纳其 P1′ 口径更正（`sha` 非空即可不建卡，含纯 JS），并记录其正文 4 处未落地。
> UI 规格：`.agents/batch-import-1116-spec.md` **v1.1 已出**（39 条数值 + A1–A12/A1b/A9b 共 14 条判据，提交 `6b16606`；v1.0 `35761dc` 已被其取代），v0.4 已并入。

## 修订说明 ⓪⁵（v0.8 → v0.9，逐条对 **规格 v1.3 / v1.3a**）

| 规格 | 本版落点 |
|---|---|
| §8 **A1** 改 span 锚点（`.ant-card-body.bottom + scrollTop − innerHeight`）+ `await rAF` + 父链 `overflow` 守卫 | 与 D-4 的 **B4 三分支**同源；**但规格这一行仍是 `if (!(span > 100)) fail(...)`，`span ≤ 0` 也 fail** ⇒ 与 r4 P0 同构（1440 下 `md={8}` 两行 ⇒ `span ≈ −184`，正确行为被判红）。**以 D-4 的三分支为准**，已请规格 v1.4 改这一行 |
| §8 **A2** 改三态（常态 49 / 61+safe；灰字态 65 / 77+safe）+ **两态相减恰好 = 16** + 灰字 `≤16px` 且不换行 | 直接采用；**本计划的 B8 已被它吸收，删除**（避免两份判据漂移），差异只剩"灰字 `nowrap`"这条已含在规格里 |
| §8 **A3** 改几何（`bar.bottom ≤ 0` / 与视口不相交） | 采用；D-1 3.2 同步（渲染条件只有 `items.length > 0`） |
| §3.1/§3.3 删 `sec` 条件渲染 | 已一致（D-1 3.2） |
| **§4.5** 灰字 `2 < N ≤ 4`：12px `#8c8c8c`、行高 16、单行、**进 DOM 而非 `visibility:hidden`**（否则栏高跳动）+ 栏高表加灰字态列 | D-1 **3.3b** 采用（含"进 DOM 而非 visibility"这条实现要点） |
| §7.4 Tag 粒度：卡片只放"这一张的判定"、灰 Tag 上移顶部 | D-1 5.5/5.7 已一致；**A9c 同步改成"卡片上不得出现「本次未做文件查重」"** |
| §7.4 **v1.3a：≤575 时 extra 最多 2 个 Tag，其余折叠 `+N`（Popover）**，优先级 `本批未做文件查重 > 疑似重复（粗判）> 已导入过 > 疑似重复`，断言并入 A12 | D-1 **5.7b** 新增（防四个 Tag 换行把标题栏顶高） |

## 修订说明 ⓪⁗（v0.7 → v0.8，逐条对 **r4 判词**）

| r4 条目 | 本版落点 |
|---|---|
| **P0（唯一）B4 两条规则自相打架**：表格写"`span ≤ 0` 不进 B4，走 A1b-else"，代码块却 `if (!(span > 100)) fail('夹具不合格')` —— `span ≤ 0` 也落进 fail；而 1440 下 4 张卡是 `md={8}` 两行、`cardBottomDoc ≈ 716 < 900` ⇒ `span ≈ −184`（**这是正确行为**：内容不足一屏本就不该吸底）⇒ 正确实现被判"夹具不合格"；且 `fail()` 不抛错时后面继续量无意义值 | D-4 B4 改**三分支**：`span > 100` → 跑 B4 主体（**唯一承担 sticky/static 证伪**）；`span ≤ 0` → **A1b-else（只作护栏，不承担证伪）**；**仅 `0 < span ≤ 100` 的灰区才 fail**，且灰区**先允许用 `viewport.height − 200` 重跑一次**，仍灰区才判不合格。**不许用 `na()`**（夹具不够是测试自己的问题，不是被测对象状态） |
| 攻击点① 1440/768 的 `span` 大概率 ≤ 0；"临时压视口"可以但必须是**允许的重跑方式** | 已写进灰区分支（重跑一次），不作为常态 |
| 攻击点② 顶部「N 张未做查重 · 疑似重复 M」**不违反 F3**，但要加对账断言 | D-4 新增 **B7**：顶部汇总的 `M` === 页面橙 Tag（`predup` 类）个数 |
| 攻击点③ 灰字顶高 61→77：A2 要改**允许集合**（单值断言迟早被删）+ 灰字 `nowrap`/`line-height:16px` + `scrollHeight <= clientHeight + 1` | D-4 曾加 **B8**（允许集合 `{49,65,61+safe,77+safe}`）；**v0.9 起撤销** —— 规格 v1.3 的 A2 三态判 + "两态相差恰好 = 16" 已覆盖且更严（防用 padding 凑高度） |

## 修订说明 ⓪‴（v0.6 → v0.7，逐条对 **规格 v1.3**）

| 规格 v1.3 内容 | 本版落点 |
|---|---|
| **P1′ 前置条件更正**：不建卡的条件是 **`sha` 非空**（原生或自写纯 JS 都是精确值），**不是"仅 `crypto` 可用"** —— 否则同一张图在手机拖两次出两张卡、桌面却不会，P1 要消灭的现象在主场复发 | D-1 5.3b 已改：**`sha` 非空即走强比对，命中不建卡**；只有 `sha === null` ⇒ 一律建卡（P1′ 只打标）。这是 UI 的反向订正，我采纳（比我的原写法更准） |
| 圆角定稿：**不加 `overflow:hidden`**（栏是实色块无溢出内容，加了会裁掉按钮 `focus-visible` 外环 4px）；不出角（栏宽 = 卡宽−2，圆角同 8，曲线落在卡圆角内侧） | 记入 D-1 3.1；**明确禁止**给 `.ant-card` / `.mb-upload-body` 加 `overflow:hidden` |
| 父链 `overflow` 检查从"文档警告"升级为**断言**（A1 内附 `while` 逐级查 `overflow !== 'visible'` ⇒ fail） | 与 B6 同义，直接沿用规格 A1 的写法（B6 保留作独立可跑项，二者不冲突） |
| 判据 14 → **15 条**（新增 A9c 降级绝不丢卡）、证伪 3 → **4 条**（A1 / A4 / A9b / **A9c**） | D-4 已改引用 |
| **⚠️ 正文 4 处未落地** | 见下「规格欠账」，已单独提给 UI 出 v1.4 |

### 规格欠账（v1.3a 只剩 1 行）

| # | 规格位置 | 现状 | 应为 |
|---|---|---|---|
| 1 | §8 **A1** 的夹具判据 | `if (!(span > 100)) fail('A1 夹具不合格')` —— `span ≤ 0`（1440/768 短列表，`md={8}` 两行 ⇒ `span ≈ −184`）也会 fail，**与 r4 的 P0 同构** | 三分支：`span > 100` → 主体（唯一承担证伪）；`span ≤ 0` → **A1b-else 护栏**（不承担证伪）；**仅 `0 < span ≤ 100` 灰区才 fail**，且灰区允许 `viewport.height − 200` 重跑一次；**不用 `na()`** |

其余 4 条（A3 几何化、A2 三态+差 16、§4.5 灰字、§7.4 Tag 粒度 / 375 extra 折叠）**已在 `a743ba4`、`32687e1` 落地**，我逐行核过。

## 修订说明 ⓪‴（v0.6 → v0.7，逐条对 **规格 v1.3**）

| 规格 v1.3 内容 | 本版落点 |
|---|---|
| **P1′ 前置条件更正**：不建卡的条件是 **`sha` 非空**（原生或自写纯 JS 都是精确值），**不是"仅 `crypto` 可用"** —— 否则同一张图在手机拖两次出两张卡、桌面却不会，P1 要消灭的现象在主场复发 | D-1 5.3b 已改：**`sha` 非空即走强比对，命中不建卡**；只有 `sha === null` ⇒ 一律建卡（P1′ 只打标）。这是 UI 的反向订正，我采纳（比我的原写法更准） |
| 圆角定稿：**不加 `overflow:hidden`**（栏是实色块无溢出内容，加了会裁掉按钮 `focus-visible` 外环 4px）；不出角（栏宽 = 卡宽−2，圆角同 8，曲线落在卡圆角内侧） | 记入 D-1 3.1；**明确禁止**给 `.ant-card` / `.mb-upload-body` 加 `overflow:hidden` |
| 父链 `overflow` 检查从"文档警告"升级为**断言**（A1 内附 `while` 逐级查 `overflow !== 'visible'` ⇒ fail） | 与 B6 同义，直接沿用规格 A1 的写法（B6 保留作独立可跑项，二者不冲突） |
| 判据 14 → **15 条**（新增 A9c 降级绝不丢卡）、证伪 3 → **4 条**（A1 / A4 / A9b / **A9c**） | D-4 已改引用 |
| **⚠️ 正文 4 处未落地** | 见下「规格欠账」，已单独提给 UI 出 v1.4 |

### 规格欠账（v1.3 header 声称已改、但正文表格仍是旧值 —— 提给 UI 出 v1.4）

| # | 规格位置 | 现状 | 应为 |
|---|---|---|---|
| 1 | §8 **A1** 量测式 | 仍写 `documentElement.scrollTop = (scrollHeight - clientHeight) * 0.5` | 改 **span 锚点**：`cardBottomDoc = .ant-card-body.bottom + scrollTop`、`span = cardBottomDoc − innerHeight`、`span <= 100 ⇒ fail`、`scrollTop = span*0.5`、`await rAF` |
| 2 | §8 **A3** | 仍断言 `document.querySelector('.mb-batchbar') === null` | 改几何：`bar.getBoundingClientRect().bottom <= 0` |
| 3 | §8 **A2** | 仍单一 "49 / 61+safeArea" | 改**允许集合** `{49, 65, 61+safe, 77+safe}`（r4：单值断言迟早被删）+ 灰字 `nowrap`/`line-height:16px`/`scrollHeight ≤ clientHeight+1` |
| 4 | **§4.5（3.3b）** | 正文无此小节（只在 header 提） | 补 12px 灰字「先拼前两张，再继续加」，仅 `2 < N ≤ 4` 出现 |
| 5 | §7.4 顶部汇总 | 只有"三个数不合并" | 补一条对账：顶部「疑似重复（粗判）M」=== 卡片橙 Tag 个数（对应 B7） |

## 修订说明 ⓪″（v0.5 → v0.6，逐条对 **r3 判词**）

| r3 条目 | 本版落点 |
|---|---|
| **P0（唯一）B4 锚点错对象**：`documentElement.scrollHeight` 把 ② 校对区也算进去，而 sticky 的 containing block 是 `.ant-card-body` ⇒ `0.5 × 全文档 maxScroll` 很可能已滚过 ① 卡片 ⇒ 正确实现被判红 | D-4 的 **B4 改为几何锚点**：`cardBottomDoc = body.getBoundingClientRect().bottom + scrollTop`；`span = cardBottomDoc - innerHeight`；**`span <= 100` ⇒ `fail`（夹具不合格，不是 N/A）**；`scrollTop = span * 0.5`；`await requestAnimationFrame` 等一帧；断言 `|innerHeight − bar.bottom| <= 1`（static ⇒ `innerHeight + span/2`，恒红）。短列表（`span ≤ 0`）不进 B4，走 A1b 的 else 分支 |
| 攻击点① 用 `span > 100px` 而不是"几屏" | 已采纳（不同视口/字体下"屏数"不等价） |
| 攻击点② 选 3–4 张时「拼接」灰着**需要可见解释**（触屏无 hover） | D-1 3.3 新增：**仅 `2 < N ≤ 4` 时**栏上方出一行 12px 灰字「先拼前两张，再继续加」，**不常驻** |
| 攻击点③ **A12 与 B5 会打架**（A12 绝对判据必红 vs B5 相对判据绿） | D-4 写明**优先级：A12 是用户可感知硬判据，不许被 B5 稀释**；改前已超 ⇒ 只有两条路：本批修掉，或 **A12 降为记录项 + 用户书面接受**；B5 交付必须写"改前/改后"数值对 |
| 攻击点④ 降级态两个 Tag 是**粒度混淆**不是逻辑矛盾 | D-1 5.5 改：橙 Tag（这一张的判定）留卡片；**灰 Tag（本批能力状态）并进顶部汇总一行，不逐卡刷 N 遍** |
| 顺带：3.2 的条件渲染多余（sticky 随卡片滚出自然消失）；若保留须用 `IntersectionObserver`，**不许在 scroll 回调里 setState** | D-1 3.2 改：**渲染条件只有 `items.length > 0`**，删掉按滚动设状态的条件渲染；② 段落的"消失"由 sticky 布局自然实现；**A3 判据同步改为几何**（`bar.getBoundingClientRect().bottom <= 0`，DOM 仍在），已请规格 v1.2 同步 |

## 修订说明 ⓪′（v0.4 → v0.5，逐条对 **r2 判词 + 附录 A**）

| r2 条目 | 本版落点 |
|---|---|
| **P0-1** 降级 `name+size` 命中会**静默丢卡**（手机端同名同大小不同截图很常见） | D-1 5.5 改：降级命中**只打标不跳过** —— `predup:{kind:'name-size-suspect'}` + 卡底 `Tag`「可能重复（按文件名+大小粗判，请核对）」；**不建卡的前置条件 = `sha` 非空（原生与纯 JS 同为精确值；仅 `sha === null` 才一律建卡）**；降级态顶部给可见计数「疑似重复（粗判）N」 |
| **P0-2** `doStitch >= 2` 是**事实放行**挂起的 C-9 | D-1 #4 改两个常量：`MAX_SELECT = 4`（批量移除用）/ **`MAX_STITCH = 2`**（C-9 未放行）；`doStitch` 判 **`selected.length === MAX_STITCH`**；第 5 次选中提示改「一次最多选 4 张」；`拼接` 在 N>2 时 `disabled + aria-disabled` 双保险 |
| **P1-1** 纯 JS 哈希分支**永不被跑到** = 写了永远绿 | D-1 5.9 新增：`?hash=js` 强制入口；**三条向量**在原生与纯 JS **两条腿各跑一遍**；纯 JS 分块 + 每 1MB `await` 让出；**单文件 >8MB 标「文件过大，未预检」**。D-4 的 B2 扩为 B2/B2b |
| **P1-2** 「前 1MB + size」折中 | **否决**，理由抄进 5.9⑥ |
| **P1-3** 375 的 ① 段基线**无现成测量**（`verify-ui.mjs:140-151` 只覆盖 `?tab=card`） | D-4 新增 **B5**：改前先量 `?tab=intake` 的 `scrollWidth/innerWidth`（5194 + 副本库）；**改前已超 ⇒ 判据降级为"不得变差"**，不许当收益 |
| **P1-4** `sec` 由 `intersectionRatio` 决定 ⇒ 交界抖动 ⇒ 栏闪 | D-1 3.2 改判定：**不用 `sec`**，用几何单调量 `#sec-upload.getBoundingClientRect().bottom > 0` |
| **P1-5** 逻辑/视觉切分 | D-1 把 C-5（5.x）与视觉项（1/2/3/4）分段表述，便于分段放行 |
| **A-1** 规格 §7 只写对库 | 规格 v1.1 已补三路；**但其 §7.2 代码片段仍"`name+size` 命中 → continue"**，与 P0-1 冲突 ⇒ 已请规格 **v1.2**；本计划以 P0-1 为准 |
| **A-2** 闸门关在 `disabled` 不在函数里 | 见 P0-2 |
| **A-3** **A1/A1b 对 sticky vs static 无分辨力**（滚到底两者都绿，证伪会失败） | D-4 新增 **B4**：量测点移到**中途滚动位置** `scrollTop = maxScroll*0.5`，断言 `|innerHeight − bar.bottom| ≤ 1`；规格 A1 拆"中途贴底（可分辨）+ 到底不遮内容"两条，已请规格 v1.2 同步 |
| **A-4** 规格 §7 末段仍写 (a) | 规格 v1.1 §7.3 已改 (d) ✓；补充的强制入口/>8MB/否决前 1MB 已采纳 |
| **A-5** A7 防漏已够 | ✅ 不再加 |
| **A-6** sticky 前提要可断言 | D-4 新增 **B6**：逐级 `getComputedStyle` 查 `#sec-upload`→`body` 的 `overflow !== 'hidden'` |
| C-9 放行条件 | D-2 补：放行时**必须同时给 `stitchVertically` 加数量上限（建议 ≤4）** |

## 修订说明 ⓪（v0.3 → v0.4，逐条对规格 **v1.1 `6b16606`**）

| 规格 v1.1 改动 | 本版落点 |
|---|---|
| §7 重写为**三路判定**（P1 批内 / P2 对库 / P3 识别后），**顺序固定：先批内、后对库** | D-1 第 5 条整条重写为三路；P1 命中**不建卡**、P2 命中**仍建卡打 Tag**，分野理由照抄（P2 吞卡会断"覆盖原报告"的路） |
| §7.2 实现契约：两个 `useRef(Map)`（`batchIdx` sha256 / `batchIdxLoose` `name|size`）**跨多次 `addFiles` 累计** | D-1 5.2 照抄；并写死"**先 `Promise.all` 算完哈希再一次性建卡**（不闪烁、不加骨架）" |
| §7.2 **`removeItem` 必须同键删两个 Map**（否则"移除后再拖回"被判成批内重复） | D-1 5.2c 新增（**这是 v0.3 没抓到的漏**：`removeItem`（`IntakePage.jsx:208-212`）现在只动 `items`/`selected`） |
| §7.2 `item.sha256` 落进 item（入库省一次重算） | D-1 5.6 新增 |
| §7.3 哈希 **(d) 定案**：`crypto.subtle` 仅作快路径，主路径自写纯 JS；抛异常才 `null`；**哈希失败不丢文件**；降级时 `name+size` **只批内**、对库绝不判 | D-1 5.1/5.5 改写；D-3 第 4 条同步为"已定案 (d)" |
| §7.4 **批内跳过不进任何 Tag**（它连卡都没有），只走 `message` + 日志 | D-1 5.3b/5.7 写死 |
| §8 **A1 拆 A1 + A1b**（不遮内容 / 位置按"是否超一屏"两分支，**恒可判不留 N/A**） | D-4 判据表改为引用 `A1/A1b`；D-3 第 5 条注明"改判永远吸底只动 A1b 的 else 分支 + `min-height`，A1 不动" |
| §8 **A7 补「更多」防漏**（0 选断言不存在、1/≥2 必须存在） | D-4 引用；本计划不再重复写（避免两份判据漂移） |
| §8 新增 **A9b 批内去重**、证伪从 2 条 → **3 条**（A1b / A4 / A9b 各一条，必真红并贴退出码 1） | D-4 证伪清单照抄 3 条；我原补的 B1（批内）与 B2（对库）与 A9b/A9 **重复，已删**，只留 B1/B2/B3（见 D-4） |
| §1 token 表新增「第三方依赖 0 个」 | D-5 第 4 条已含"不引入第三方依赖（含 SHA-256 自写）" |
| §11 计数：**39 条规格 + 14 条判据** | 全文引用改为 39/14 |

**仍未解决、等 r2 判词裁的两处**（v0.3 已列，v0.4 未擅自改）：① 批内跳过 vs 对库建卡的不对称是否成立；② `A1b` 的 else 分支（短列表不吸底）是否需用户拍板。规格 v1.1 已按我的建议实现，故**只剩用户侧一句话**（D-3 第 5 条）。

## 修订说明 ①（v0.2 → v0.3，逐条对 UI 规格 `35761dc`）

| 规格条目 | 本版落点 |
|---|---|
| §3.1 机制定案 **`position: sticky; bottom: 0`**（不用 `fixed` + observer） | D-1 3.1/3.5 改：sticky 在文档流占位 ⇒ **不遮内容、内容区不补 `padding-bottom`**；`sec !== 'upload'` 不渲染作保险（自动消失为主、条件渲染为辅）；**D-4 的全部 fixed 类断言作废，改用规格 A1–A12** |
| §4 短文案 `识别（N）/导入（M）/拼接（N）/移除选中` | D-1 3.3 照抄（375 单按钮可用 95.7px，`一键识别（3）`≈104px 会溢出）；长语义进 `title` |
| §4「更多」0 选不渲染 | D-1 3.3 + C-13 改（唯一项"清空勾选"0 选时无意义，命中 N7） |
| §10-3 短列表不吸底（sticky 自然行为） | D-3 新增第 5 条（产品口径，需用户点头；备选 `min-height: calc(100dvh - var(--mb-sec-top))` + `ResizeObserver` 写变量，`--mb-sec-top` 不许写死，375 实测 `#sec-upload` top=431） |
| §2/§5/§6 卡头、徽标、重识别数值 | D-1 第 1/2/4 条已抄进数值（checkbox 16 左上、行高 32、删除视觉 24/热区 44、选中 `#c8102e` + inset、徽标 16 圆 `①②③④` 与 checkbox 不重叠、重识别**卡底整行右对齐**） |
| §7 重复提示 | D-1 第 5/6 条并入；**规格 §7 只写了"对库"一路，缺 P0-1 要求的"批内"一路** ⇒ 本版补 5.2b/5.3b，并作为 addendum 交审 |
| §7 末段「算不了哈希 → 灰 Tag 本次未做文件查重（取建议 a）」 | **与 r1 P0-2 冲突**：定为 **(d) 纯 JS SHA-256 为主**（两端一致），(a) 的灰 Tag 降级为"哈希抛异常时"的兜底（不许静默） |
| §8 A1–A12 | D-4 改为「验收 = 规格 A1–A12 + 本计划补充 6 条（B1–B6）」，fixed 类断言全部删除 |
| §9 边界（只改 3 文件、`mb-` 前缀、不碰既有契约） | F9 与 D-5 照抄为硬约束 |

## 修订说明（v0.1 → v0.2，逐条对 r1）

| r1 编号 | 本版落点 |
|---|---|
| **P0-1** C-5 只查库不查本批 | D-1 第 5 条改为**两路预检**（库 / 本批）+ 批内命中「不新增第二张卡」写死 + 降级期保留 `name+size` 批内粗筛；新增 R11 记批内重复的取证 |
| **P0-2** R10 是必然、降级路径会废掉手机端 | R10 从 `[未取证]` 改为**已定案**（`server.mjs:1808` 绑 `0.0.0.0` + 安全上下文规范）；D-3 第 4 条新增并**推荐 (d) 纯 JS SHA-256**（~40 行 + 与 node `crypto` 对拍）；删除 (c)"按文件名对库" |
| **P0-3** 加固定栏前须先拆顶部冗余入口 | D-1 第 3 条新增 3.4/3.5：**同批删除** `UploadPanel.jsx:29-33` 与 `:56-63`；固定栏出现条件写死 `items.length>0 && sec==='upload'`；② 段隐藏且 `ReviewPanel.jsx:22-25` 不动 |
| **P1-1** `selected` 6 个引用（我说 3 处） | B/F1 数字订正为「2 文件 6 引用：`:223`、`:227`、`:57`、`:58`、`:61`、`:69`」，并加顺序语义落地要求 |
| **P1-2** 拼接产物没有 `File`/`size` | D-1 第 5.6 条：拼接图（`IntakePage.jsx:236-249`，无 `_file`、`size:null`）**不做文件级预检**，卡片标「拼接图（不查重）」 |
| **P1-3** 不要在 `addFiles` 里再拉一次清单 | D-1 第 5.4 条写死「复用 `loadReports()` 已加载 state，零额外请求」；副作用（440KB / 含 rows）记入 F6 |
| **P1-4** 图标不许 danger 红、全页不出现"删除" | D-1 第 1 条 + D-3 第 3 条：`DeleteOutlined` 非 danger 或 `MinusCircleOutlined`，`aria-label="移除此文件（未入库）"`，① 段全页只用「移除」 |
| **P1-5** C-9 无服务端护栏 | C-9 改**挂起**，附放行实测（4 张 ×4000px 的字节数/耗时） |
| **P1-6** 端口 5193/5199 已被占 | D-4 验收脚本用 **5194/5195** |
| **P1-7** "无固定栏先例"表述不准 | R/N4 改为「页面层无先例；`web/src/meddata/embedded.css:402/405` 是第三方 Tailwind 产物里的 `.fixed`/`\!fixed`，`CardPreview.jsx:8` 是注释」 |
| 事实订正：`done` 态今天已有「重新识别」 | C-4 / D-1 第 2 条改为「**收紧成条件渲染** + failed 补「重试」」，不再是"新增" |
| 事实订正：`status:'dup'` 消费点 4 处 | F3 改为 4 处（`UploadPanel.jsx:21`、`IntakePage.jsx:447-453`、`:506-523`、`:573`），并新增两 Tag 文案区分要求 |
| 事实订正：C-6 的砍理由 | 改为**数据责任**：`saveReport` 是唯一写库入口（四分支：查重/空值过滤/`textOnly`/更新原报告，`IntakePage.jsx:420-470`），② 是唯一人工复核点 |
| r1 §3-⑤ 六条四档断言 | 收进 D-4（原文照抄，含 90vh 反证防空过） |

---

## 0. 需求整理（N1~N7，验收靠这张表）

| # | 用户要求 | 归类 | 读法 |
|---|---|---|---|
| N1 | 「选/删」文字按钮 → 删改 Icon、选改 Checkbox | 呈现层替换 | 卡片头 1 个 checkbox + 1 个**非 danger** 图标按钮（「移除」）；不新增第二个图标 |
| N2 | 去掉每卡「识别」，只留一键识别；错了才出「重新识别」 | 按钮收敛 + 条件渲染 | `pending` 无按钮；`done` 出「重新识别」（**现状已有**，`:120` 的文案三元）；`failed` 出「重试」 |
| N3 | 重复提示前移到「刚导入」 | 能力新增 | **两路**（批内 + 对库）× **exact sha256**；单据级必须 OCR 后（见 R4） |
| N4 | 拼接等操作放下方浮动固定（移动端 + 大屏） | 布局机制新增 | 页面层**无先例**（P1-7 表述订正），要 UI 出数值 |
| N5 | 固定区按钮：一键识别 / 一键导入 / 一键删除（拆或合） | 交互契约 | **不合并**识别与导入（C-6，数据责任） |
| N6 | 点选后才出按钮：1 份→删除、≥2 份→拼接 | 渐进暴露 | 选中态驱动按钮出现 |
| N7 | 「隐藏其他无关按钮」 | 扩展 | 未选中时只露 2 主操作 + 「更多」 |

## A. 反向排雷（现有现实 → 新方案的前提）

- **R1｜「要滚回顶部才能拼接」成立。** `UploadPanel.jsx:56-63` 的「已勾选 N/2 / 拼接选中的两张 / 清空勾选」整行排在 `:66` 的卡片 `Row` **之前** ⇒ 报告一多必滚回顶部。
- **R1b｜「每卡识别」与「顶部一键识别」是两层入口。** `UploadPanel.jsx:119-121`（每卡 `block` 按钮）+ `:29-33`（一键识别全部）。
- **R2｜删/选确是文字按钮。** `UploadPanel.jsx:104-110`：`删` = `type="text" danger` 两个汉字；`选/已选` = 普通 `size="small"`。
- **R3｜查重只在入库那一步。** `dupCount` 只统计 `status==='dup'`（`IntakePage.jsx:573`）；`status='dup'` 只由 `recognize()` 拿到 `body.duplicate` 时设置（`:447-453`）；后端唯一判定点 `server.mjs:1683`。⇒ 导入→无信息；识别→也不查重；**入库才拦**。
- **R4｜导入一刻只能判 exact sha256 —— 但**批内**那一层客户端能判，v0.1 漏了（P0-1）。**
  ① 现成口径：`docs/导入工作流.md:33` 四层判重 = 「① sha256 字节级 ② 原件已在 `data/intake/**/archive` ③ 库里同「单号+报告日期」④ **批内**同「单号+类型+日期」」，并写明**不用 dHash 单独判重**。②③④ 都要服务端状态或 OCR 结果 ⇒ 导入一刻只有 ①。
  ② dHash 不能前移：`lib/reportIntake.mjs:113-120` 实测「『凝血 07-26』与『凝血 08-04』汉明距离 = 0，14 张不同影像报告会被聚成一簇」⇒ C-10 砍。
- **R5｜不必加端点。** `GET /api/intake/reports` 是 `...r` 展开、只把 `text`/`images` 置 `undefined`（`server.mjs:1005-1013`）⇒ **`sha256` 在返回体里**；`loadReports()` 已放进 state（`IntakePage.jsx:139-150`），且每次入库成功后重调（`:441`、`:556`）。
- **R6｜前端没有文件指纹。** `addFiles()` 只建 `{dataUrl:'', _file}`（`IntakePage.jsx:153-183`）；`sha256` 一直由后端在入库时算（`server.mjs:1667`）。
- **R7｜2 张上限纯前端。** `toggleSelect` 超 2 挤掉最早的（`:214-221`）、`doStitch` 校验 `!== 2`（`:222-231`）；服务端 `/api/intake/stitch` 只校验 `images` 非空（`server.mjs:1387-1392`），`stitchVertically` 吃数组（`lib/reportIntake.mjs:141`）。
- **R8｜「一键识别」与「一键导入」分居两个面板。** `UploadPanel.jsx:29-33` vs `ReviewPanel.jsx:22-25`（经 `IntakePage.jsx:905` 传入）。
- **R9｜卡片占屏。** `Col xs={24}`（`UploadPanel.jsx:68`）+ 120px 缩略图 + 信息行 + `block` 按钮 ⇒ 375 下约 3.7 张/屏。
- **R10｜手机端必然算不了 `crypto.subtle`（已定案，不是待取证）。**
  `server.mjs:1808` `server.listen(PORT, '0.0.0.0')` ⇒ 手机只能走 `http://<局域网IP>:5174`，不可能是 `localhost`/`127.0.0.1`；`crypto.subtle` 只在安全上下文（`https:` / `localhost` / `127.0.0.1` / `file:`）存在 ⇒ **手机端 `window.isSecureContext === false`**。⇒ 若只做原生 WebCrypto，N3 在手机端（= 主场）等于没做。**v0.3 定案：以 (d) 纯 JS SHA-256 为主**，WebCrypto 仅作加速；灰 Tag「本次未做文件查重」只作异常兜底。
- **R11｜同批内重复完全可以复现，且现在没有任何拦截。**
  `addFiles()` 对每个文件**无条件** `setItems(prev => [...prev, ...accepted])`（`IntakePage.jsx:180`）；整页粘贴走同一函数（`:198-206`）。同一张图"拖一次 + ⌘V 一次"⇒ 两条独立 `uid()` 都进列表；直到入库第二条才被服务端拦（`server.mjs:1683`），且批量路径是 `silent:true` ⇒ 用户只看到一句汇总「N 张疑似重复已跳过」（`IntakePage.jsx:523`）。**这就是用户说的"导入过程中误操作重复导入"。**

## B. 正向排雷（新方案 → 现有消费方）

- **F1｜`selected` 的消费面是 2 文件 6 引用，且带顺序语义。**
  `IntakePage.jsx:223`（`!== 2` 闸）、`:227`（解构前两张）、`UploadPanel.jsx:57`（`N/2` 文案）、`:58`（`disabled`）、`:61`（清空）、`:69`（`picked` 样式）。
  改通用多选要同时：① `toggleSelect` 不再截断（上限 4）；② `doStitch` 改 `>=2`；③ 文案去 `/2`；④ **顺序 = 勾选顺序**并显示 `①②③`（否则拼接上下顺序随机）。
- **F2｜`removeItem` 是内存删除。** `IntakePage.jsx:208-212` 只 `setItems(filter)`，无任何服务端调用 ⇒ 文案必须写「移除（未入库）」，且①段全页不出现"删除"二字（P1-4）。
- **F3｜`status:'dup'` 的消费面 4 处，不许复用。** `UploadPanel.jsx:21`（`疑似重复 N` Tag）、`IntakePage.jsx:447-453`（`recognize` 分支 + `pushLog` + `return {duplicate:true}`）、`:506-523`（`classifyImportable` 的 `c.dup` 与"已跳过"文案）、`:573`（`dupCount`）。
  ⇒ 预检结果用独立字段 `predup: {kind:'exact-file-batch'|'exact-file-lib', of}`，不阻断 `classifyImportable` 分类；两处 Tag 文案写死不同词：**「已在本次导入中」（批内）** / **「库内已有同一文件」**（对库）；入库时判定仍写「疑似重复（入库时判定）」。
- **F4｜遮挡不只最后一项。** ② 段真正的底部按钮在**每项 Collapse 内部**（`IntakePage.jsx:835` 的「入库这份报告」）⇒ 只补 `padding-bottom` 挡不住展开态。处置：`sec==='review'` 时**整条隐藏**固定栏（复用 `IntakePage.jsx:126-140` 的 observer），② 的入口留在 `ReviewPanel.jsx:22-25` 不动；**不做 sticky 顶栏**（顶部吸顶分段条已占 56px，`scrollMarginTop: 56`）。
- **F5｜测试污染。** 模板用 `tests/verify-reports-refresh.mjs`（`PORT=5193` + `MEDBRIEF_REPORTS_FILE`/`MEDBRIEF_DATA_DIR` 指副本，`:27-30`）；**本计划验收用 5194/5195**（5193/5199 已被 `verify-reports-refresh` / `verify-report-delete` 占），真库零写入。
- **F6｜不改 `server.mjs` 的两条都成立，但各带副作用。** 预检走既有 GET（副作用：响应 440KB 且含 `rows` ⇒ **不在 `addFiles` 里重复请求**，用 state）；多张拼接走既有 POST（副作用：服务端**无数量/尺寸护栏**，见 C-9）。
- **F7｜部署态。** `web/**` 改完必须 `MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web` + 硬刷新；因不动 `lib/**`/`server.mjs`，**不需要重启 5174**。
- **F8｜治理资产。** `docs/导入工作流.md:33` 的判重四层要补一句「客户端预检只做 exact 字节（批内 + 对库），dHash 永不预判」，否则下个会话会把预检当单据级查重。
- **F9｜并发写。** 只动 `web/src/pages/intake/UploadPanel.jsx`、`web/src/pages/IntakePage.jsx`、（可能）`shared.js`；r1 复核时这三个文件无在途改动。开工前再核一次。

## C. 逐项必要性（留 / 砍 / 延后 / 挂起）

| # | 候选改动 | 不做会怎样 | 代价 | 收益 | 更便宜的等价手段 | 结论 |
|---|---|---|---|---|---|---|
| C-1 | Checkbox 取代「选/已选」 | 每卡多占宽/高，375 更挤 | 小 | N1、R9 | 无 | **留（准予）** |
| C-2 | 删除改 Icon（**非 danger**） | 「删」两字被挤、误读成删库 | 小 | N1、F2 | 无 | **留（准予）** |
| C-3 | 撤掉每卡「识别」整行按钮 | 两层重复入口（R1b）；每卡多 32px 高 | 小 | N2、R9 | 收成角落小图标（仍有 N 入口） | **留（准予，同批删顶部一键识别）** |
| C-4 | `done`/`failed` 才出重新识别/重试 | 识别错了只能整批重跑 | 小 | N2 | 无 | **留（准予；实为"收紧为条件渲染"+补 failed）** |
| C-5 | 导入即提示（**三路**：批内跳过 / 对库打标 / 识别后单据级） | 误选两次要等入库才被静默跳过（R11） | 中（哈希 + UI 位 + 降级分支） | N3、R4、R11 | 只在识别后提示（现状，被用户点名要前移） | **留（准予 + P0-1 三路 + P0-2 (d) 纯 JS 哈希）** |
| C-6 | 识别与导入合并 | 用户要跨两个面板点两次（R8） | 中高 | — | 固定栏并排放 + "识别完要校对"提示 | **砍**（数据责任：`saveReport` 唯一写库入口，② 是唯一人工复核点） |
| C-7 | 下方浮动固定栏 | 报告多要滚回顶部（R1） | 中 | N4 | sticky 顶栏（更差，F4） | **留（准予 + P0-3 删顶部冗余）** |
| C-8 | 按钮随选中态渐进出现 | 栏内 4-5 个按钮挤成一排 | 小 | N6、N7 | 无 | **留（准予）** |
| C-9 | 多张（>2）拼接 | 一张单拍成 3 段要拼两次 | 小（前端放开）但**服务端无护栏** | 覆盖 3-4 段单据 | 拼两次（现状能用） | **挂起**：放行需一条实测（4 张 4000px 图 → 字节数 ≤8MB、耗时 ≤2s） |
| C-10 | dHash 预检 | — | 中且必误报（R4） | — | — | **砍** |
| C-11 | 三个 Tag 搬进固定栏 | — | 小 | 计数可见 | 卡片已有状态 Tag | **砍** |
| C-12 | 卡片横向紧凑布局 | 375 一屏 <2 张 | 中 | 一屏更多张 | C-1~C-3 先做 | **延后**（触发：C-1~C-3 后 375 实测可见卡 <2 张） |
| C-13 | 「更多」收「清空勾选」 | 低频按钮占位 | 小 | N7 | 无 | **留（准予）** |

## D. 简化后的方案 + 验收断言 + 前提问题

### D-1 留下的项（含 r1 必改 + 规格数值）

1. **卡片头**（规格 §2）：顺序 `[checkbox 16] 4 [序号徽标 16（仅选中时）] 8 [状态 Tag] 6 [文件名 flex:1 min-width:96 nowrap ellipsis] 8 [删除 24（热区 44）]`；行高 **32**；checkbox **放左上**（右上已被删除占用，44+44>56 会重叠）；删除图标 `DeleteOutlined` 视觉 24 / 热区 `::before{inset:-10px}`，常态灰 `#8c8c8c`、hover `#ff4d4f`+`#fff1f0`、**非 danger 常驻**；`aria-label/title="移除此文件"`（① 段全页**不出现"删除"二字**）。选中态 `border-color:#c8102e` + `box-shadow:0 0 0 1px #c8102e inset`，只加 `className="mb-item-card"`，**不动 `.card`**。
2. **收紧每卡按钮**（规格 §6）：`pending` 无按钮、`ocr` 出 `Spin`+「识别中…」、`done` 出「重新识别」（现状 `:120` 已有）、`failed` 出「重试」（新增）。位置 = **卡底整行右对齐**（角落图标会与删除的 44 热区在 56px 内重叠；与元信息同排不新增行高）；375 下元信息先 `flex-wrap`，按钮 `flex:0 0 auto`。
3. **下方操作栏**（P0-3 + 规格 §3；机制由 `fixed` 改 **`sticky`**）：
   - 3.1 `position: sticky; bottom: 0; z-index: 6;`，`margin: 0 -12px -12px`（抵消 `.ant-card-body` 12px padding）、`padding: 8px 12px calc(8px + env(safe-area-inset-bottom,0px))`、`background:#fff; border-top:1px solid #f0f0f0; box-shadow:0 -2px 8px rgba(0,0,0,.06); border-radius:0 0 8px 8px`。栏总高：≥576 **49**（32 按钮+8+8+1）/ ≤575 **61 + safe-area**（44+8+8+1）；`2 < N ≤ 4` 出 3.3b 灰字时 **+16**（375 下 77）。**圆角不出角**（栏宽 = 卡宽 −2、圆角同 8，曲线落在卡圆角内侧）；**禁止**给 `.ant-card`/`.mb-upload-body` 加 `overflow:hidden`（栏无溢出内容，加了会裁按钮 `focus-visible` 外环 4px，且会让 sticky 静默失效）。
   - 3.2 渲染条件只有 `items.length > 0`：**不做按滚动位置的条件渲染**（r3：多余，且 `IntersectionObserver`/scroll 回调里 setState 会引入抖动）。② 段落的"消失"由 sticky 布局自然实现（栏随 ① 卡片滚出视口）。**因此 A3 的判据要同步改成几何**（`bar.getBoundingClientRect().bottom <= 0` / 不相交），不能断言 DOM 为 null（已请规格 v1.2 同步）。sticky 占位 ⇒ **内容区不补 `padding-bottom`**。
- 3.3 三态（规格 §4，**短文案定稿**）：0 选 → `识别（N）`(primary) + `导入（M）`，**「更多」不渲染**；选 1 → `移除选中`(default+danger 文字) + `更多`(icon-only 44 热区)，主操作**不渲染**；选 ≥2 → `拼接（N）`(primary) + `移除选中` + `更多`；批量中 → `识别中 d/t` + `停止`(danger)。长语义进 `title`（`识别` →「一键识别全部 N 张（串行，可停止）」；`导入` →「只入库已识别且未入库的 M 张；疑似重复会自动跳过」）。
   
   - 3.3b **`2 < N ≤ 4` 时**（C-9 未放行、拼接被禁用）栏内上方出一行 **12px 灰字「先拼前两张，再继续加」**；仅该区间出现，**不常驻**。实现要点：该行**进 DOM 而非 `visibility:hidden`**（否则栏高在那两个状态间跳动）；样式 12px `#8c8c8c`、`line-height:16px`、`nowrap`；栏高随之 49→**65**、61→**77**（+safe-area）。
- 3.4 **同批删除顶部两处冗余**：`UploadPanel.jsx:29-33`（一键识别全部）与 `:56-63`（勾选文案 + 拼接 + 清空勾选）整行移除；顶部只保留计数 Tag（`共 N / 待识别 / 未识别 / 疑似重复 / 已导入过 M`）。
   - 3.5 栏**必须是 `.ant-card-body` 直接子元素**且**不许放进 antd `<Space>`**（`.ant-space-item` 高度=栏高 ⇒ sticky 退化成"跟内容走"，整块失效）；结构照规格 §3.3 的 `mb-upload-body` 包一层。
   - 3.6 窄屏（≤767）栏内按钮 `flex:1 1 0; min-width:0` 均分（375 三按钮各 ≈95.7px），`white-space:nowrap`；大屏左对齐、右侧 `已选 N` 用 `margin-left:auto`。
4. **多选语义 + 两个上限常量**（规格 §5/§9-5 + r2 P0-2）：`selected` 改通用多选，**`MAX_SELECT = 4`**（第 5 次选中 `message.info('一次最多选 4 张；再拼请分批')` 且不加入）；顺序 = 勾选顺序；徽标 **16 圆 `#c8102e` + `①②③④`**，与 checkbox **并排不重叠**（`gap:4`）；`toggleSelect` 不再挤掉最早，按 `MAX_SELECT` 截断。
   **闸门必须在函数里**：`const MAX_STITCH = 2`（C-9 未放行），`doStitch` 判 **`selected.length === MAX_STITCH`**（不是 `>=2`，也不靠按钮 `disabled`）；`拼接` 在 `selected.length > MAX_STITCH` 时 `disabled + aria-disabled="true"` + `title="本次最多拼 2 张（多张拼接待实测放行）"`。**C-9 放行 = 只改 `MAX_STITCH` 常量 + 打开序号显示**（结构按 1..N 通用设计，本轮常量锁 2）。
5. **导入即查重 —— 三路判定，顺序固定「先批内、后对库」**（P0-1/P0-2 + 规格 v1.1 §7）：
   - 5.1 哈希 `sha256FileSafe(file)`（规格 §7.3 定案）：① `crypto.subtle` 存在（`https`/`localhost`）走原生 `digest`（快路径）；② 否则走 **自写纯 JS SHA-256**（~40 行、**零第三方依赖**）；③ **只有抛异常才返回 `null`**。手机端必然是 ②（`server.mjs:1808` 绑 `0.0.0.0` ⇒ 非安全上下文 ⇒ `crypto.subtle === undefined`）。
   - 5.2 两个 `useRef(Map)` **跨多次 `addFiles` 累计**（"拖一次 + 粘贴一次"是两次调用）：`batchIdx` = `sha256 → itemId`；`batchIdxLoose` = `` `${name}|${size}` → itemId ``（仅哈希失败时兜底）。
     - 5.2a **先 `Promise.all` 把哈希全部算完，再一次性建卡**（不闪烁；**不加骨架/loading**，通常 <50ms）。
     - 5.2b **P1 批内**命中（`sha` 非空即可，**原生与自写纯 JS 都算精确值**）⇒ `continue` 掉该文件（**不建第二张卡**）+ `message.warning('这张图本次已选过，已跳过')` + `pushLog('批内重复：<name> 已选过，已跳过','warn')`。
     - 5.2c **`removeItem` 必须同键删两个 Map 里的条目**（`IntakePage.jsx:208-212` 现在只动 `items`/`selected`）——否则"移除后再拖回来"会被误判成批内重复（D-4 的 B3 守这条）。
   - 5.3 **P2 对库**：`sha256 ∈ loadReports() 里的 sha256 集合` ⇒ **仍建卡**，卡底元信息行打 `Tag color="orange"`「同一文件已导入过」（`title="本文件的 sha256 与库内已有文件完全相同；入库时仍会再判一次"`），落 `predup:{kind:'exact-file', of}`（`libSha` = `Map(sha256→reportId)`，由既有 state 派生，零额外请求）。
   - 5.4 分野理由写死（不许实现方自由发挥）：**P1 不建卡** —— 同一张图拖一次+粘贴一次时库里还没有它，只查库必然"不重复"，两张同卡正是 r1 P0-1；**P2 建卡** —— 用户可能想覆盖/更新原报告，吞卡等于断他的路。
   - 5.5 降级（哈希为 `null`，r2 P0-1 + r3 攻击点④）：**批内**用 `name+size` 粗筛，命中**只打标不跳过** —— 卡片上只留**橙 Tag**「可能重复（按文件名+大小粗判，请核对）」（这是"这一张的判定"）；**"本次未做文件查重"属于"本批的能力状态"，并进顶部汇总一行**（不要逐卡刷 N 遍）；**对库不做任何判断**；**不建卡只适用于 `crypto` 可用时的 exact sha256 命中**；**哈希失败不许丢文件**：照常建卡、照常可识别。
   - 5.6 `item.sha256` 落进 item（入库复用，省一次重算）；拼接图（`IntakePage.jsx:236-249`，无 `_file`/`size:null`）**不做预检**，卡标「拼接图（不查重）」。
   - 5.7 **批内跳过不进任何 Tag**（它连卡都没有），只走 `message` + 日志；顶部计数只有「已导入过 M」（P2）与「疑似重复 dupCount」（P3）两个，不合并。
   - 5.8 判定真相仍归服务端 `findDuplicate`（`server.mjs:1683`）；前端只提示，不改入库结果。
   - 5.9 纯 JS 哈希的**可执行性**（r2 P1-1/P1-2）：① **强制入口** `?hash=js` 或 `localStorage.mb_force_js_hash=1`（否则正常路径只跑原生，纯 JS 分支永不执行 = 永远绿）；② 对拍向量至少三条 —— `'abc'`（单块）、`'a'.repeat(1000)`（多块）、`new Uint8Array([0,255,128,…])`（非文本）；③ **原生与纯 JS 两条腿各跑同一组向量**；④ 纯 JS **分块 + 每 1MB `await` 让出主线程**（否则 10 张 5MB 图卡死 UI）；⑤ **单文件 >8MB ⇒ 标「文件过大，未预检」**（与"本端不支持"文案分开）；⑥ **否决"只算前 1MB + size"** —— 会把 exact 降级成前缀比对，与 5.3 用 exact 命中决定建卡冲突，也撞 F4「前端不得自成第二份判定」。
6. **识别后提示**（规格 §7）：单据级 Tag 文案改「**疑似同一份报告**」（`shared.js:10` 的 `ST.dup.label` 只改这一个字面，`color`/`default` 不动）；顶部计数分离为「已导入过 M」（新）与「疑似重复 dupCount」（保留原名），两者不合并。
7. **顶部计数 Tag 保留**（复核入口）；「更多」只收「清空勾选」（C-13，且 0 选不渲染）。
   - 5.7b **375 下 extra 不许挤爆**（规格 v1.3a）：`≤575px` 时 extra 区**最多 2 个 Tag**，其余折叠成 `+N`（`Popover` 列出全名）；显示优先级固定 `本批未做文件查重 > 疑似重复（粗判）> 已导入过 > 疑似重复`；断言并入 A12（`extra` 区 `scrollWidth <= clientWidth + 1`），不新增判据编号。

### D-2 挂起 / 延后 / 砍（触发条件）

- **C-9 多张拼接（挂起）** —— 放行条件：一条实测 `POST /api/intake/stitch` 拼 4 张 4000px 高的图，返回 `dataUrl` 解码字节 ≤8MB 且耗时 ≤2s（`lib/reportIntake.mjs:144-161` 无护栏）。**放行时必须同时给 `stitchVertically` 加数量上限（建议 ≤4）** —— `server.mjs:1387-1392` 只校验非空，前端兜不住 OOM。未放行前 `MAX_STITCH = 2` 写死在 `doStitch` 里（D-1 #4）。
- **C-12 卡片横向紧凑（延后）** —— 触发：C-1~C-3 后 375 实测可见卡 <2 张。
- **C-10 dHash 预检（砍）** / **C-11 Tag 进栏（砍）** / **C-6 合并识别与导入（砍：数据责任）**。

### D-3 需要用户拍板的 5 条前提（未答则按建议执行）

1. **固定栏是否在 ② 校对区常驻** → 建议**不常驻**（sticky 布局上自然消失 + `sec` 保险）。
2. **「一键导入」语义** → 建议**不合并**；`title` 写死「只入库已识别且未入库的 M 张」。
3. **「移除」范围** → 只移除本次未入库条目；库内删除属 `intake-dedupe-1116`。三道锁：不出现"删除"二字、图标非 danger 常驻、确认文案「这 N 张还没入库，移出后需重新导入」。
4. **手机端哈希** → 规格 v1.1 §7.3 **已定案 (d)**：`crypto.subtle` 仅作快路径，主路径自写纯 JS SHA-256（零依赖）；灰 Tag 只留给「哈希抛异常」。**此项已无需用户拍板**（原 (a)/(d) 分歧已裁）。
5. **短列表（内容不足一屏）时栏是否仍吸底** → 建议**不吸底**（sticky 自然贴在内容末尾；规格 §10-3）。规格 v1.1 已把这条写成 **A1b 的两分支**（`scrollable ? 贴底 : 排在内容末尾`），**恒可判、不留 N/A**；若改判「永远吸底」，只动 A1b 的 else 分支期望 + 给 `.mb-upload-body` 加 `min-height: calc(100dvh - var(--mb-sec-top))`（`--mb-sec-top` 由 `ResizeObserver` 写，375 实测 `#sec-upload` top=431，**不许写死**），**A1 不动**。

### D-4 验收判据（= 规格 v1.1/v1.2 §8 的 14 条 + 本计划补充 6 条）

**判据主体 = `.agents/batch-import-1116-spec.md` §8**（`A1 / A1b / A2–A8 / A9 / A9b / A10–A12`，共 **14 条**）—— 原文照抄，本文不复述，避免两份判据漂移。
四档视口 `1440×900 / 768×1024 / 414×896 / 375×812`；端口 **5194/5195** + 副本库；退出码沿用 `failed?1:(na>0?2:0)`。

**规格 A1 必须按 r2 A-3 改写后才可用**（规格 v1.2 待同步）：滚到**最大滚动位置**时 sticky 与 static 都满足 `last.bottom <= bar.top` 与 `bar.bottom ≈ innerHeight` ⇒ **A1/A1b 对两者无分辨力，原证伪会失败**。改为两条：① **中途贴底**（`scrollTop = maxScroll*0.5` 时 `|innerHeight − bar.bottom| <= 1`，static 时栏在视口外 ⇒ 必红）；② 到底不遮内容（原 A1 保留作第二段）。

**证伪 3 条（每条必须真红并贴退出码 1）**：① `sticky → static` ⇒ **B4（中途贴底）必红**；② 去掉按钮 `flex:1 1 0` ⇒ **A4 必红**；③ 注掉 §7.2 的 `batchIdx` 批内比对 ⇒ 同一张图导两次出现 2 张卡 ⇒ **A9b 必红**。

**本计划补充 7 条（B1–B7）**（规格未覆盖，落地必须量；原 B8「A2 允许集合」已被规格 v1.3 的三态判 + 差=16 吸收，故撤销）：

| # | 判据 | 量测式 | 期望 |
|---|---|---|---|
| **B1** | 顶部冗余入口已删 | `grep -c "一键识别全部"` / `grep -c "拼接选中的两张"` / `grep -c "已勾选"`（均对 `web/src/pages/intake/UploadPanel.jsx`） | 均 === **0** |
| **B2** | 纯 JS 哈希对拍（原生腿） | `sha256Hex('abc')`（原生路径） | === `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` |
| **B2b** | 纯 JS 哈希对拍（**强制 js 腿**，防空过） | `?hash=js` 下三条向量：`'abc'` / `'a'.repeat(1000)` / `Uint8Array([0,255,128,…])`，逐条与 node `crypto` 比 | 全部相等（**两条腿都要跑**；只跑原生 = r2 P1-1 的"写了永不执行"） |
| **B3** | `removeItem` 同键删两个 Map | 导入 1 张 → 点「移除」→ **再次导入同一文件** | 建卡成功且**不出现**「这次已选过」提示（误判为批内重复即红） |
| **B4** | **中途贴底**（分辨 sticky vs static 的唯一判据；**锚点必须是 ① 卡片，不是全文档** —— r3 P0） | 见下表后的代码块（几何锚点 `span`，`span <= 100` ⇒ `fail` 夹具不合格） | `\|innerHeight − bar.bottom\| ≤ 1`（`static` ⇒ `innerHeight + span/2`，恒红）；短列表 `span ≤ 0` 不进 B4，走 A1b 的 else 分支 |
| **B5** | 375 横滚**改前基线**（不许冒领） | 5194 + 副本库 + `?tab=intake`，改前先量 `documentElement.scrollWidth / clientWidth` | 改后 **≤ 改前**，且交付必须写**改前/改后数值对**。**优先级：A12（绝对判据）高于 B5（相对判据），不许被 B5 稀释** —— 改前已超时只有两条路：本批修掉，或 **A12 降为记录项 + 用户书面接受** |
| **B6** | sticky 前提：`overflow` 链无 hidden | 从 `#sec-upload` 逐级向上到 `body`，`getComputedStyle(el).overflow` 与 `overflowY` | 均 **!== 'hidden'**（将来给卡片加 `overflow:hidden` 会静默破坏贴底） |
| **B7** | 顶部汇总与卡片 Tag **对账**（r4 攻击点②） | 页面统计：顶部「疑似重复（粗判）M」的 M；卡片上橙 Tag（`predup.kind === 'name-size-suspect'`）个数 | **M === 橙 Tag 个数**（有计数必有断言；两者语义不同不合并，但必须对得上） |

**B4 的可复制实现（三分支；四档各跑一次）**：

```js
const bar  = document.querySelector('.mb-batchbar')
const body = document.querySelector('.ant-card-body')            // sticky 的 containing block
const doc  = document.documentElement
const measure = async (w) => {
  const cardBottomDoc = body.getBoundingClientRect().bottom + doc.scrollTop
  const span = cardBottomDoc - innerHeight                       // 卡片底 → 视口底 的跨度
  if (span > 100) {                                              // ① 主体：唯一承担 sticky/static 证伪
    doc.scrollTop = span * 0.5
    await new Promise((r) => requestAnimationFrame(r))            // sticky 要等一帧
    const gap = Math.abs(innerHeight - bar.getBoundingClientRect().bottom)
    if (gap <= 1) ok(`B4 ${w} 中途贴底：gap=${gap} ≤ 1（span=${span}）`)
    else fail(`B4 ${w} 中途未贴底：gap=${gap}（static 时应为 span/2 = ${(span / 2).toFixed(1)}）`)
    return
  }
  if (span <= 0) {                                               // ② 短列表：只作护栏，本档两者不可分辨
    doc.scrollTop = doc.scrollHeight
    await new Promise((r) => requestAnimationFrame(r))
    const gap = bar.getBoundingClientRect().bottom - innerHeight
    if (gap <= 1) ok(`B4 ${w} 短列表：栏排在内容末尾（bottom − 视口底 = ${gap.toFixed(1)} ≤ 1），A1b-else 通过`)
    else fail(`B4 ${w} 短列表：栏跑到视口下方 ${gap.toFixed(1)}px`)
    return
  }
  fail(`B4 ${w} 夹具灰区：span=${span}px ∈ (0,100]，建议以 viewport.height − 200 重跑一次`)  // ③ 灰区才 fail
}
// 灰区重跑（只允许这一种）：
//   const p2 = await browser.newPage({ viewport: { width: w, height: Math.max(320, innerHeight - 200) } })
//   仍灰区 ⇒ 判不合格；不许用 na()（夹具不够是测试的问题，不是被测对象的状态）
```
### D-5 实现边界（规格 §9 照抄为硬约束）

1. **只允许改 3 个文件**：`web/src/pages/intake/UploadPanel.jsx`、`web/src/pages/IntakePage.jsx`（传 `sec` + 多选语义）、`web/src/pages/intake/shared.js`（**只改 `ST.dup.label` 一个字面**）。
2. **不碰**：`.card`、`rb-edit-grid-wrap`、DataGrid 的 `.g-ctl`/`g-main`/`.mb-edit-modal`、`.mb-review-grid` 及其 375 注入 CSS。
3. **新增 DOM/CSS 一律 `mb-` 前缀**：`mb-upload-body`/`mb-batchbar`/`mb-item-card`/`mb-file-name`/`mb-icon-btn`/`mb-hit44`/`mb-pick-badge`/`mb-predup`/`mb-bar-btn`。
4. **不引入新色值**（只用规格 §1 颜色表）；不引入第三方依赖（含 SHA-256 实现必须自写）。
5. 改完 `MEDBRIEF_WEB_BASE=/ MEDBRIEF_WEB_OUT=dist-next npm run build:web` + 硬刷新；不动 `lib/**`/`server.mjs` ⇒ **不需要重启 5174**。


### D-6 复跑命令清单（本版结论的证据）

```bash
cd /Users/scallion/Documents/projects/MedBrief
grep -n "已勾选\|拼接选中的两张\|清空勾选" web/src/pages/intake/UploadPanel.jsx   # R1 顶部冗余入口
sed -n '100,125p' web/src/pages/intake/UploadPanel.jsx                            # R2/R1b/C-4 现状按钮
sed -n '153,183p;208,232p' web/src/pages/IntakePage.jsx                           # R6/F1/R11 addFiles 无去重
grep -n "setItems((prev) => \[...prev, ...accepted\])" web/src/pages/IntakePage.jsx # R11 无条件 push
grep -n "server.listen" server.mjs                                                # R10 0.0.0.0 ⇒ 手机非安全上下文
sed -n '1003,1014p' server.mjs                                                    # R5/F6 列表含 sha256 + 体量
sed -n '1384,1396p' server.mjs; sed -n '141,162p' lib/reportIntake.mjs             # R7/C-9 无护栏
grep -n "凝血 07-26" lib/reportIntake.mjs; sed -n '33p' docs/导入工作流.md          # C-10 dHash 不预判
sed -n '18,26p' web/src/pages/intake/ReviewPanel.jsx                               # R8 ② 侧入口
grep -n "PORT" tests/verify-reports-refresh.mjs tests/verify-report-delete.mjs      # F5 端口占用
grep -rn "position.*fixed" web/src --include=*.jsx --include=*.css | wc -l          # N4 页面层无先例（3 处＝第三方产物 2 + 注释 1）
```

---

**下一步**：r2 已送（`.agents/batch-import-1116-review-input-r2.md`）；v0.3 吸收规格 v1.0（`35761dc`）、v0.4 吸收规格 v1.1（`6b16606`），两轮规格 delta 见「修订说明 ①/⓪」与 `.agents/batch-import-1116-review-input-r2-addendum.md`。终判「可以开工」+ 用户说「按以上计划执行」后才编码。**用户侧仍欠一句：D-3 第 5 条（短列表是否永远吸底）**；D-3 第 4 条已由规格 v1.1 定案，无需拍板。
