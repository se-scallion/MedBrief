# 校对网格（DataGrid）窄屏适配 + 控件规格统一 —— 设计规格与排雷 **v0.4**

> 触发（用户原话）：「校对网格这个模块。要做窄屏的适配。或者换成响应式组件：重新设计窄屏的样式，尽量实现原有的功能。
> 样式特别丑，描边也不均匀，估计是样式 bug，间距也宽。你重新设计后，走计划流程，交给 @代诊-Manager 实现」
> 版本：**v0.4（2026-11-16 晚；在 v0.3 吸收 r1 之后，再吸收 r2 的 1 条 P0 + 3 条 P1：撤掉会压桌面栅格的轨道规则、主表 `g-main`、状态色改 `:where()`、V3 断言限定 `.g-ctl`，并新增 V9 轨道判据）**。
> 状态：**D-1 准予开工（r1 判「只准哪几条」）；D-2 挂起**。作者：UI 设计师。实现方：代诊-Manager。审核：代诊-报告 r1。
> 排雷：**无项目定制层**（`grep -rlF '**通用层**：~/.agents/skills/plan-review.md' .` 的 3 个命中都只是正文引用，前两份计划已记同一结论），仅通用层。

## 修订说明 v0.4（逐条对应 r2 的 1 条 P0 + 3 条 P1；**这轮 P0 是我规格写错导致的**）

| r2 编号 | r2 结论 | v0.4 落点 |
|---|---|---|
| **P0-1** | `.g-grid > .grid { grid-template-columns: minmax(0,1fr) }` **已把桌面栅格打断**：特异性 (0,2,0)、无 media，压掉 `lg:grid-cols-4`/`md:grid-cols-2` ⇒ 1440 下记录信息卡（`:799`）从 4 列塌成 1 列 | **§3.2 / §D-1 第 5 条改写**：只写 `.g-grid > .grid > * { min-width: 0 }`（**不碰轨道**）；轨道修正只允许落在 `:890` 双栏卡的 `g-split` 标记上、且必须包在 `@media (max-width:1023px)` 里。**新增 V9 轨道判据**（1440→4 列/2 列、375→1 列）并写进实现方新脚本 `tests/verify-grid-narrow-D1.mjs` |
| **P1-1** | `.g-grid table td/tr` 会命中「粘贴解析预览表」（`:1084` `min-w-[520px]`），把只读预览锁 40px 行高并截断 | 主表加 `g-main`，规则写 `.g-grid table.g-main td/tr`；§D-1 第 2 条同步 |
| **P1-2** | 状态色 5 条 `border-color` 还原规则是**色板快照**（新增状态色会静默变灰） | 改成一条 `:where(.g-grid .g-ctl)`，5 条全删；§3.1 记明 |
| **P1-3** | V3 的 `borderStyle` 断言不限定 `.g-ctl` 会永远红（网格内另有 4 处 `.border`：`:169` 下拉、`:1030` 粘贴面板、`:905`/`:1081-1083` 的 `.card`（后者即「解析预览」`table.min-w-[520px]`）） | V3 断言限定 `.g-ctl`；§4 例外清单补全 |
| **N2** | 例外清单不完整（同上 4 处 + 两张表） | §4 V3 例外清单 + V9 范围声明 |
| **N3** | 六条契约④⑤**已是既有断言**（`verify-edit-modal-375.mjs:46`、`:116`）；其余需可粘片段 | §4.2 标注哪两条已有断言、哪四条要新写 |
| **N4** | §6 第 2 步不多余（`index.css` +69 行、3 个新类），但要写成条件式；**且漏了重建 `web/dist-meddata`** | §6 改条件式 + 补第四条重建 |
| **N5** | 三批不会互红；归属：改 DataGrid 那批自己跑三条并贴输出，只许改结构判据 | §7 加「断言归属」一条 |

## 修订说明（逐条对应 r1，作者不许只读摘要）

| r1 编号 | r1 结论 | v0.3 落点 |
|---|---|---|
| **A2**（推翻我的归因） | 「描边不均匀」主因**不是** `px-1.5 vs px-2`，而是 **`/` 侧 CSS 没有 `border-style`**；另有三处我没提 | 全部采纳，见 §2 的 **G1'** 与 **G2'/G3'/G4'**；原 G1/G2 降级为"次要 +2px 错位" |
| **A3**（E15 只对一半） | 3 个 JSX 消费方 → **2 条构建管线 + 2 套 reset**；`border-separate/border-spacing` 当前 0 命中；`meddata/dist` 不存在、别去建；**§7.4 归口写反了** | 见 **E15'/E16'/E17'**、**F10'/F11'**、**§7.4 反转**（G6 归本批） |
| **A5**（软判据） | V1 两句自相矛盾（页面级永远绿 / 容器级挂起后必红）、V6 永远绿、V5 前提错（`h-1 w-1`+border 在 content-box 下外框也是 6×6） | 见 **§4 全面重写**：V1 拆成容器级 + 页面级两条独立判据；V5 删除（E10 降级为"待实测"）；V6 改成可红的形态 |
| **A1** | 自标 `[未取证]` 合规，但 V2「恰 40px」必须加容差 | V2 改 **40±1px**（两套 reset + collapse 行边框导致 40/41 交替） |
| **A6** | `git revert` 不够，`dist*` 全 gitignore | 见 **§6 四步回退 + 3 条既有测试当门禁** |
| **R8**（我写错了） | 两批**都没碰** `DataGrid.jsx`（edit-modal 批改 `ReportsPanel.jsx`、reviewgrid 批改 `IntakePage.jsx`）⇒ **串行是伪需求**；真需求是**结构契约 + 同批跑两条测试**；且**本批应先做** | 见 **§4.2 六条结构契约**；R8 重写；§7.1 改为"本批先做" |

---

## 0. 结论先行

1. **「描边不均匀」是端到端可复现的样式 bug，根因在构建配置而不是类名**：`/` 路径的 CSS 由 `web/scripts/build-meddata-css.mjs` 生成，`corePlugins: { preflight: false }`（`:46`，理由见 `:2`）⇒ 没有 `*{border:0 solid}` 全局重置；而 `web/src/meddata/embedded.css` 里 `.border` 只输出 `border-width: 1px`（`:1283-1285`，全文 `border-style` 仅 1 处）。
   于是**同一张表里**：`<input>` 落回 UA 的 `inset`、`<button>` 是 `outset`、`<select>` 是 UA 默认、只写 `border` 类的 div 根本不画线。**用户说"估计是样式 bug"是对的，我 v0.2 的归因（`px-1.5 vs px-2`）只是次要项。**
2. **「间距宽」的真因仍是代码列装不下文案而折行**（`未识别（点此搜索选择）` 11 个全角字 ≈132px 塞进 96−12−2=82px），行高在 ≈44/62px 之间跳；v0.3 按 r1 准予的写法把文案拆成 `未识别` Tag、行高锁 **40±1px**。
3. **窄屏整页横滚的真因**是 `grid lg:grid-cols-5` 子项 `min-width:auto` + `table.min-w-[760px]` ⇒ 隐式轨道被撑到 784px（`edit-modal-1116-review-r1.md:105` 实测）。**按 r1 的 A3 更正：这条修法归本批**（edit-modal 只作用 `.mb-edit-modal`，覆盖不到 `/meddata` 与 `IntakePage`），落点是新根类 `.g-grid`。**卡片态（D-2）仍挂起**，需用户点头。

---

## 1. 取证（v0.3 修正后，全部可复跑）

| # | 事实 | 位置 / 命令 |
|---|---|---|
| E1 | 表格容器 `overflow-x-auto` + `maxHeight: 420` 写死；表 `min-w-[760px]` | `DataGrid.jsx:1126-1127` |
| E2 | 列宽同上；**r1 补两处**：① 项目名格有 `min-w-[150px]` 地板（`:1279`）；② 序号列 56px 装不下现有内容：`w-10`(40)+点(6)+`gap-1`(4)+td 左右内边距(16)=**66px** ⇒ 锁 40px 行高前必须复算每列 | `:1130,1148,1166,1184,1202-1205`、`:1279` |
| E3 | `th`/`td` 只有 `pr-2`、**无左内边距** | `:1130…` `:1225…` |
| E4 | 输入框 `rounded-md border px-2 py-1.5 text-xs`；**r1 校正行号**：单位 `:1335`、参考范围 `:1347` | `:1281,1310,1335,1347` |
| E5 | `px-1.5` 共三处：代码选择器 `:128`、搜索输入 `:165`、箭头 select `:1364`（**r1 校正：select 在 `:1362-1372`**，v0.2 引的 `:1332-1335` 是单位 input） | `:128`、`:165`、`:1362-1372` |
| E6 | 未识别文案 11 全角字 ≈132px，可用宽 = 96 − td 右内边距 8 − `px-1.5`×2 = **76px**（r1 校正，v0.2 写 82）⇒ 必折两行 | `:138` + `:1130` |
| E7 | 行高 ≈44/62px 交替（计算值，**待实测**） | 由 E4/E6 推 |
| E8 | 状态边框色 6 套 + 每格 `focus:ring-2` | `:129,165,1282,1311,1332,1340` |
| E9 | `EditedMark` 蓝线 `left-1 right-1 -bottom-[3px] h-[2px]`，距行分隔线 3px | `:30-32` + `:1224` |
| E10 | 序号来源点 `h-1.5 w-1.5` vs `h-1 w-1`+`border`。**r1 指出：content-box 下后者外框也是 6×6，我 v0.2 写"4px"是错的** ⇒ 降级为"待实测，不列入本轮判据" | `:1229-1234` |
| E11 | `.card` `border-color` 过渡 + `::after` 3px 光晕 | `index.css:20-39` |
| E12 | 工具栏 `flex items-center justify-between`、`gap-2`、无 `flex-wrap`；**r1 校正：不是 6 个按钮，是 5 个 `<button>` + 2 个条件文本节点**（项待修正、unitFixMsg）⇒ 只按按钮加 wrap 会漏文本 | `:926-1000` |
| E13 | 响应式只有 `grid gap-4 lg:grid-cols-5`；<1024 单列但表仍 760 | `:889-895,1126` |
| E14 | 左图卡 `maxHeight: 420` | `:905` |
| **E15'** | **2 条构建管线 + 2 套 reset**：`/meddata` = `build:meddata` → `web/dist-meddata`（带 preflight，产物里有 `border:0 solid`×1）；`/` = `build:web` → `web/dist-next`（**0 命中** `border:0 solid`），其 meddata 样式来自**入库产物** `web/src/meddata/embedded.css`（`border-style` 仅 1 处、**无 `box-sizing` 全局重置**） | `tools/build-meddata-css.mjs:2,46,64`；`embedded.css:1283-1285`；见下方复跑命令 |
| **E16'**（r1 更正我 v0.2 的事实错） | `/meddata` 是**活路由**：`meddata/mount.mjs:15` `DIST = ../web/dist-meddata`、`:286-292` 服务 ⇒ 改完必须重建；但**当前不存在「源已改、产物未更」**（`git log --since=2026-11-13 --oneline -- meddata/src` 只有入库提交 `31627a1`）。`meddata/dist` **不存在**，别去建 | `sed -n 15p meddata/mount.mjs`；`git log --since=2026-11-13 --oneline -- meddata/src` |
| **E17'** | `border-separate` / `border-spacing` 在两处 CSS 与产物里**当前 0 命中** ⇒ v0.2 想用 `border-collapse: separate` 修双线属**新增机制**，须单独立项验证（本轮挂起） | `grep -c "border-separate\|border-spacing" web/src/meddata/embedded.css web/dist-*/assets/*.css` |
| **E18'** | 我 v0.2 漏的三处：① 项目名格的 ↺ 按钮 `absolute right-1 top-1/2 … border border-brand-200` 在输入框内**再画一个框**；② `!` 角标 `hidden … group-hover:inline-flex h-4 w-4` **hover 时才出现并挤窄该格**；③ 序号是 `<input w-10 bg-transparent outline-none>` —— **本来就没有边框**（不是"描边不均"） | `:1296`、`:1320`、`:1257` |

复跑命令：
```bash
cd /Users/scallion/Documents/projects/MedBrief
sed -n '2p;46p;64p' tools/build-meddata-css.mjs
grep -c "border-style" web/src/meddata/embedded.css            # → 1
sed -n '1283,1285p' web/src/meddata/embedded.css               # .border { border-width: 1px }（无 style）
for f in web/dist-meddata/assets/*.css web/dist-next/assets/*.css; do
  echo "$f  border0solid=$(grep -o 'border:0 solid' "$f" | wc -l)  border-style=$(grep -o 'border-style' "$f" | wc -l)"
done
grep -c "box-sizing" web/src/meddata/embedded.css              # → 0（无全局重置）
ls meddata/dist 2>&1 | head -1                                  # → No such file
sed -n '1257p;1296p;1320p' meddata/src/components/DataGrid.jsx
```

---

## 2. 根因（v0.3 重写）

| 编号 | 症状 | 根因 | 处置（本批/D-1） |
|---|---|---|---|
| **G1'**（原 G1 降级） | **描边完全不同款**：同排有的 inset 凹、有的 outset 凸、有的一根线都没有 | **`/` 侧 CSS 缺 `border-style`**（E15'）：`.border` 只给 `border-width`，无 preflight 全局 `border:0 solid` ⇒ 各标签回落到 UA 默认样式 | **所有带边框的元素一律写简写** `border: 1px solid #cbd5e1`（不用 `border`+`border-slate-300` 两段式）；这是 r1 明确点名的施工要求 |
| G1b | 同排文字起点差 2px | `px-1.5` vs `px-2`（E5） | 统一 `padding-inline: 8px`（控件 token） |
| **G2'** | 输入框里"多一个框"、红色 `!` 一出现那格就变窄 | ① ↺ 按钮绝对定位在输入框内再画边框（`:1296`）；② `!` 角标 `group-hover:inline-flex` 参与行内布局（`:1320`） | ① ↺ 改成**输入框右侧内嵌图标位**（`padding-right: 28px` + 图标 `position:absolute`，图标本身**不画边框**）；② `!` 改**绝对定位**在单元格右上角，不参与流内布局（宽度恒等于控件宽） |
| G3' | 行高参差、间距宽 | E6 + E7（折行） | 文案拆 `未识别` Tag（3 字）+ 全称进 `title`；表格态行高锁 **40±1px**、`white-space: nowrap` + 省略号 |
| G4' | 编辑过的行"下沿多一条线" | E9 蓝线落在 td 下内边距里，距行分隔线 3px | 蓝线改贴在**输入框内底边**（`left/right: 0; bottom: 0; height: 2px`），不进入 td 内边距 |
| G5 | 鼠标扫过整片发亮 | E11 `.card:hover` 3px 光晕 + 边框变色 | **本轮不做**（r1 未列入准予项；改法见 §5-C 挂起项） |
| **G6** | 手机上整页左右晃 | `grid lg:grid-cols-5` 子项 `min-width:auto` + `table.min-w-[760px]` ⇒ 轨道 784px | **本批落地**（r1 A3 反转归口），但**只写** `.g-grid > .grid > * { min-width: 0 }`（**r2 P0-1：不许对 `.g-grid > .grid` 写 `grid-template-columns`**，那会把 `md:grid-cols-2`/`lg:grid-cols-4` 一起压掉）；若确需改轨道，只能给 `:890` 双栏卡加 `g-split` 并在 `@media (max-width:1023px)` 内写；表格自带 `overflow-x-auto` 为**唯一**横向滚动器 |
| G7 | 状态色在跳 | E8 六套边框色 + focus 1px+2px | 状态色**不再画在边框上**：边框恒 `1px solid #cbd5e1`，状态改**左侧 3px 竖条 + 底色**（r1 未禁止，属 D-1 的 token 部分；若实现方认为超范围可挂起，见 §5-C） |

---

## 3. 设计规格（数值制）

### 3.1 控件级 token（三形态共用）

| token | 值 | 备注 |
|---|---|---|
| `--g-ctl-h` | `32px` | 输入框/选择器/按钮统一高 |
| `--g-ctl-pad-x` | `8px` | 含代码选择器与 select（修 G1b） |
| `--g-ctl-radius` | `6px` | 卡 8px / 卡内小圆片 4px |
| `--g-ctl-font` | `12px` / 行高 `18px` | 表头 11px |
| `--g-line` | **`1px solid #cbd5e1`（简写）** | 修 G1'；聚焦**不改边框** |
| `--g-divider` | `1px solid #f1f5f9` | 行分隔 |
| `--g-gap` | `8px` | 卡内栅格与按钮间距（只用 4/8/12/16/24） |
| `--g-state-bar` | `3px` | 状态竖条（红/琥珀/青/无） |
| 聚焦 | `box-shadow: 0 0 0 2px rgba(20,184,166,.35)`，`outline: none`，**`border-color` 不变** | 消除 1px+2px 双层感 |

### 3.2 表格态（≥1024px，本批范围）

- `td { padding: 4px 8px; height: 40px }`、`th { padding: 8px }`（**修 E3**）。
- **表总宽保持 760px**（v0.2 的 672px 已撤回，见 F10'）；可以改 `table-layout: fixed` 只动列分配。
- 单行不折行：`white-space: nowrap; text-overflow: ellipsis`，全文进 `title`。
- 竖滚：`max-height: clamp(320px, calc(100vh - 320px), 560px)`（替换写死 420）。
- `.g-grid` 根类承载 G6 修法，**只允许一条**：`.g-grid > .grid > * { min-width: 0 }`。
  **禁止**写 `.g-grid > .grid { grid-template-columns: ... }`（r2 P0-1：它特异性 (0,2,0)、无 media，会压掉 `:799` 记录信息卡的 `md:grid-cols-2`/`lg:grid-cols-4` ⇒ 1440 下 4 列塌成 1 列）。
  **机制（r2 提供，已复核）**：两套产物里 `grep -o '@layer' | wc -l` **都是 0** ⇒ 构建把 `@layer` 拍平了，**只剩特异性竞争**；新增的 `.g-grid` 块若写在 `@layer` 外于 `meddata/src/index.css`，它与工具类抢的就是纯 (a,b,c)。
  若确需约束双栏轨道，唯一允许的形式是：给 `:890` 双栏卡加 `g-split`，并写在 `@media (max-width: 1023px)` 内。
- **主表标记**：表格加 `g-main`（`table.g-main`），所有「行高/不折行」规则只写 `.g-grid table.g-main td`（r2 P1-1：否则会命中 `:1084` 的「粘贴解析预览表」把只读预览锁 40px 并截断）。
- **行分隔线（2026-11-16 20:30 补，UI 设计师登记）**：`.g-grid table.g-main tbody tr { height: 40px; border-bottom: 1px solid #f1f5f9 }` ——
  线必须写成**显式简写**（带 `style`），因为 `/` 侧 `embedded.css` 无 preflight，只给 `border-bottom-width` 的工具类**画不出来**（A2 同一机制）。
  **行距口径 = 内容高 40 + 线 1 = 外框 41**，V2 判据按**内容高**判（`rect.height − borderBottomWidth`），分隔线不算行距预算。
  **登记为「用户可见新增」**：`/` 侧主校对表改前**没有**行分隔线（`/meddata` 侧有），本批把两侧统一成"有线"。改前/改后截图见 §9.16；若主理人不要划线，回退只删 `border-bottom` 半句。

### 3.3 窄屏（**D-2，挂起**，需用户点头后开工）

<768px 卡片态（每项一张卡：序号+代码 / 项目名 / 结果·单位·参考范围·箭头 2×2 / 左缘 3px 状态条 / 右上 32×32 命中区删除）、
768–1023px 两行栅格态（列序同表格、标签进 sticky 表头）。**本版只登记，不开工。**

---

## 4. 验收判据（v0.3 重写：删掉 2 条永远绿的、拆开 1 条自相矛盾的）

> r1 指出：v0.2 的 V1 两句互相矛盾、V6/V5 永远绿。下面每条都写了「怎么让它变红」。

| # | 判据 | 期望 | 量法（含**证伪**方式） |
|---|---|---|---|
| **V1a 容器级**（本批必过，**但只在全页 grid 上判**） | 表格自带 `div.overflow-x-auto` 在**全页**（`/meddata` 与本页 Intake，视口 ≥1024）**不横向滚动** | `el.scrollWidth <= el.clientWidth + 1` | 量 `div.overflow-x-auto` 本身。**范围澄清（实测补）**：在**编辑弹窗**里量到 760/481 属**正常**（弹窗自身只有 ~481px 宽，表格 760 必然滚），**modal 内不作判据**，标 N/A；只在全页网格上判。**证伪**：全页 1440 下把 `td` padding 加到 24px 或塞 200 字长项目名 → 红 |
| **V1b 页面级**（本批必过） | 在 375 / 414 / 767 三宽下**整页不横滚** | `document.documentElement.scrollWidth <= clientWidth + 1` | 量根元素。**证伪**：删掉 `.g-grid` 的 `min-width:0` → 必须变红（r1 实测这时内层 796、根 375） |
| **V2** | 表格态所有 `tbody tr` 等高 | 极差 **≤1px**，且落在 **40±1px** | `getBoundingClientRect().height`。容差来自两套 reset + collapse 行边框（r1/A1）。**证伪**：恢复 11 字未识别文案 → 极差 ≥15px |
| **V3**（r2/P1-3 收窄） | 边框同款（主判据）+ 内缩一致 | ① `border-top-style`/`border-top-width` 在 **`.g-ctl` 这一组元素**上全为 solid / 1px（**必须限定 `.g-ctl`**：网格内另有 4 处 `.border` 在 `/` 侧本无 style —— `:169` 下拉面板、`:1030` 粘贴面板、`:905`/`:1081-1083` 的 `.card`（后者即「解析预览」`table.min-w-[520px]`），不限定就永远红）；② `padding-left === 8px`；**声明例外**：序号 input（`:1257`，无边框无 padding，断言 0px）、`!` 角标（`absolute -right-1`，无边框）、`↺` 内嵌图标（改后 `borderWidth=0`，20×20）、`select` 的 UA 箭头（background 而非 border） | `getComputedStyle`。**证伪**：任一处改回两段式 → `/` 路径 `.g-ctl` 变 inset/none，① 红。**必须两个入口都跑**（`/meddata` 5288 有 preflight、`/` 5174 无 preflight），同一脚本两遍，否则只证明了一半 |
| **V9 轨道数**（r2/P0-1 新增，**P0 的唯一护栏**） | 修窄屏不许破桌面栅格 | **三档都要测（r2 补 1023 档）**：1440 → 记录信息卡（`:799`，`card p-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4`）**4** / 双栏卡（`:890`，`grid gap-4 lg:grid-cols-5`）**5**；**1023 → 2 / 1**（`md:grid-cols-2` 正是被 P0 连带压掉的那条断点，只测 1440/375 等于漏掉它）；375/414/767 → **1 / 1**。（**更正**：我与 r2 判词原都把双栏卡写成 2，实测 5；`lg:grid-cols-5` = 左图跨2 + 右表跨3） | `getComputedStyle(el).gridTemplateColumns.split(' ').length`。**证伪**：加回 `.g-grid > .grid { grid-template-columns: minmax(0,1fr) }` → 1440 两条都变 1，红。**必须加进 `tests/verify-grid-narrow-D1.mjs`**（该脚本当前 `grep -c "grid-template-columns"` = 0，P0 会在全绿报告里通过） |
| **V4** | 聚焦不改变边框 | focus 前后 `border-*-width/style` 不变，且 `border-top-color === rgb(203, 213, 225)`（**r1：getComputedStyle 返回 rgb 不是 hex**） | 同上（先 focus 再取）。**证伪**：加回 `focus:border-brand-500` → color 变 rgb(20,184,166)，红 |
| **V5'** | 三处 G2' 修正生效 | ① ↺ 图标 `getComputedStyle().borderWidth === '0px'`；② `!` 角标 `position === 'absolute'` 且**未 hover 与 hover 时该格 `clientWidth` 相等** | 取 rect + computedStyle。**证伪**：把 `!` 改回 `hidden group-hover:inline-flex` → hover 前后宽度差 >0，红 |
| **V6'** | 表格态不折行 | ① `getComputedStyle(td).whiteSpace === nowrap`；② 代码选择器控件 `height <= 32`（**r1 指出 v0.2 的 td scrollHeight<=clientHeight 永远绿**：input/select 不换行、button 折行后自身也相等） | computedStyle。**证伪**：去掉 nowrap → ① 红 |
| V7/V8（**挂起**） | 状态可辨不靠颜色 / 三态齐全 | — | 依赖 D-2 与状态色改造，本批不验 |

**双基线**：改前必须在 375 宽量出 `documentElement.scrollWidth > clientWidth`（窄屏坏复现）+ 在 `/` 路径量出四类控件 `border-style` 不一致（描边 bug 复现）；改后同一命令全绿。**只给改后数字的交付一律不算。**

---

## 4.2 六条结构契约（r1 给的，本批与两个在途批次共用的护栏）

两批（`edit-modal`、`reviewgrid`）都已实现未提交、且**都没碰 `DataGrid.jsx`**（r1 核过工作区），所以串行是伪需求；真正的护栏是这 6 条 + 同批跑它们的测试：

1. 根结构深度**不许插层**（`DataGrid` 根 → 工具栏行 → 卡片行 → 表格容器 的层级保持现状）。
2. `div.overflow-x-auto` 保持**唯一**横向滚动器（不许再加第二层滚动）。
3. `card p-3` / `card p-4` 的内边距**保留**（edit-modal 的 B1 依赖）。
4. 工具栏的 `flex items-center justify-between` **仍是直接子元素关系**（edit-modal 的 B2 依赖）。
5. 表宽 **≥760px**（不许缩）。
6. 保存行结构不变（`flex items-center justify-end gap-3` + 提示文案 + 两个按钮）。
   **§4.2 六条的机器校验现状（r2/N3）**：④⑤**已是既有断言** —— `tests/verify-edit-modal-375.mjs:46` 断言 `.card > .flex.items-center.justify-between`、`:116` 断言「恰 1 个 `overflow-x-auto` 且 `sw>=760`」；①②③⑥**需新写**（六条全部落进 `tests/verify-grid-narrow-D1.mjs`，不许只写在文档里）。
   **同批必跑（r1 给的真实文件名，三个都在工作区、已 `ls` 核过）**：
   `node tests/verify-edit-modal-375.mjs`（依赖 `card p-3/p-4`、`justify-between` 直接子元素、`scrollWidth>=760`）、
   `node tests/verify-report-lib-ui.mjs`（第 6 条：保存行 `flex items-center justify-end gap-3 > .btn-primary`，**两批同时依赖**）、
   `node tests/verify-reviewgrid-v06.mjs`。
   **自查更正**：我曾误判 `verify-reviewgrid-v06.mjs` 不存在 —— 那是我 `ls tests/*.mjs | head -20` 被截断读错，文件其实在。

---

## 5. 排雷

### A. 反向排雷

| 编号 | 结论 |
|---|---|
| R1 | 窄屏坏**成立**（E1/E13）。**描边坏也成立，但真因是缺 `border-style`（E15'），不是类名差 2px** —— v0.2 归因已被 r1 推翻，此处更正。 |
| R2 | E7（44/62px）仍是计算值 → 已标"待实测"，且 V2 已加容差；**它不再是判据依据**（只用于解释"为什么看起来间距宽"）。 |
| R3 | 双基线已写入 §4（改前 must-be-red、改后 must-be-green）。 |
| R4 | 语义裂缝：`未识别（点此搜索选择）` 一控件两义 → 拆 Tag + 整行点击。 |
| R5 | 地基不一致升级：不只是文案，而是**两套 CSS 地基**（preflight 开/关）—— 同一组件在两个入口长得不一样（E15'）。 |
| R6 | 砍：不引组件库、不引虚拟滚动（9–30 行）。 |
| R7 | 窄屏是真实主路径（手机截图入口，`plan-stitch-2line-1115.md:3`）。 |
| **R8（重写）** | ~~两批并发改同一文件须串行~~ **错，r1 已核：两批都没碰 `DataGrid.jsx`**。真风险是**结构契约被无意破坏**（插层/多一层滚动/改掉 `justify-between`）⇒ 处置见 §4.2 六条 + 同批跑两条测试。**另按 r1：本批应先做**，它会把 edit-modal r1 的 B1/B2 接管过去，之后两批零交集。 |
| **R9（新增）** | **两条构建管线**意味着"改一处、两处生效、但要分别重建"：`/meddata` 走 `build:meddata`（含 preflight），`/` 走 `build:web` + 入库的 `embedded.css`。**`embedded.css` 是入库产物，改 Tailwind 类名不会自动反映进去** —— 若本轮只改 JSX 类名而不重建 `embedded.css`，`/` 路径观感不变（假绿）。 |

### B. 正向排雷

| 编号 | 结论 |
|---|---|
| F1 | **r1 修正**：不是「只改样式」——会改渲染结构（根类、↺ 图标位、`!` 定位）、1 处可见文案（`:138`）、状态色表达方式。**明确承诺**：不动保存 / 反馈 / 解析 / 写库链路。 |
| F2 | **r1 修正**：JS 同源、**CSS 不同源** ⇒ 改为「JS 一次改到位 + CSS 产物按两条管线各重建一次」，**且必须含入库产物 `web/src/meddata/embedded.css`**（v0.2 漏了它）。 |
| F3 | 无键一致性影响。 |
| F4 | **r1 收敛承诺**：本轮只保证「表格态不靠单一颜色」＝保留现有 `rowBg` + `!` 角标；逐行「危急」文字属新增能力，不在本批（V7 挂起）。 |
| F5 | 验证用独立端口（`npx vite --port 5288 --strictPort`），不占 `server.mjs` / `web:5173`，不动 `data/`。 |
| F6 | 一份单元格组件，三形态用 CSS 切；禁止两套 JSX。 |
| F7 | 长驻进程不热更新：重建两条产物并自验（探活 + 页面里 grep 新类名 `g-cell`）。 |
| F8 | 治理：本文件 + r1/r2 判词落盘；实测数字回填本文件附录。 |
| F9 | 只 `git add` 本次实际改动文件；`.agents/` 有他人计划在写，不整篇改共享文档。 |
| **F10'**（改写） | 不串行；改为 §4.2 六条结构契约 + 同批跑 `verify-edit-modal-375.mjs` / `verify-reviewgrid-v06.mjs`。 |
| **F11'**（改写） | 撤回 672px（原因为会破 `edit-modal` G6 的 `scrollWidth >= 760`）；**且 G6 修法归本批**（edit-modal 只作用 `.mb-edit-modal`，覆盖不到 `/meddata` 与 `IntakePage`）。 |

### C. 逐项必要性（留 / 砍 / 延后）

| 候选 | 不做会怎样 | 代价 | 结论 |
|---|---|---|---|
| **D-1：border 简写 + token 化** | `/` 路径描边永不一致（UA inset/outset/none 混排） | 小：6 处类名 + 1 组变量 | **留（首选，r1 已准予）** |
| **D-1：行高锁 40±1 + 未识别拆 Tag** | 行高 44/62 跳、看着"间距宽" | 小 | **留** |
| **D-1：↺ 内嵌图标位 + `!` 绝对定位** | 输入框里"多一个框"、hover 挤格 | 小 | **留** |
| **D-1：工具栏 flex-wrap + 竖滚 clamp** | 窄屏按钮溢出、420 写死 | 极小 | **留** |
| **D-1：`.g-grid` 承载 G6（min-width:0 + minmax(0,1fr)）** | 375/414 整页横滚（r1 实测 796） | 小 | **留（r1 反转归口到本批）** |
| D-1：状态色改左竖条 + 底色（G7） | 一列 6 色边框跳 | 中 | **留**（若实现方判断超范围，可与 V7 一起挂起，但必须显式说明） |
| **D-2：窄屏卡片态 / 两行栅格** | 手机上仍要横滚看"参考范围" | 中 | **挂起**（需用户点头；触发条件＝用户确认接受"卡片态替换表格"） |
| `border-collapse: separate` 修双线 | 双线仍在 | 小但**新增机制**（E17' 0 命中） | **延后**（触发条件＝G4' 的蓝线改位后仍见双线；届时单独实测） |
| `.vw-grid` 锚点类名 | 无 | — | **砍**（改统一用 `.g-grid`，避免两套命名） |
| 列宽 672px | 无（672/760 都横滚） | 会破 `edit-modal` G6 断言的 `scrollWidth>=760` | **砍**（v0.2 撤回） |
| 引组件库 / 虚拟滚动 / 深色模式 | 无 | 中-大 | **砍** |

### D. 简化后的方案（= r1 准予的 D-1 五条 + 一条归本批的 G6）

1. **边框一律简写**：`border: 1px solid #cbd5e1`（禁用 `border` + `border-slate-300` 两段式）；全表 `focus` 不改边框、只加 2px 外环。
2. **行高锁 40±1px + 不折行**：`td { padding: 4px 8px; height: 40px }`，`th { padding: 8px }`（补 8px 左内边距），`nowrap` + 省略号 + `title`。
3. **`未识别（点此搜索选择）` 拆开**：值区只放 `未识别` Tag（≤4 字，不再折行），点击仍打开同一搜索面板，全称进 `title`。
4. **蓝线移进输入框**：`left/right: 0; bottom: 0; height: 2px`（不进 td 内边距）；↺ 改内嵌图标位（`padding-right: 28px`，图标不画边框）；`!` 改绝对定位不占流。
5. **工具栏 `flex-wrap` + 竖滚 `clamp(320px, calc(100vh−320px), 560px)` + 根类 `g-grid`**：G6 只写 `.g-grid > .grid > * { min-width: 0 }`（**不写轨道**，见 §3.2 禁则）；表格加 `g-main`；状态色 5 条还原规则合并为一条 `:where(.g-grid .g-ctl)`（P1-2）。
6. **两套产物分别重建与验证**：`/meddata` 重建 `web/dist-meddata`（preflight 开）；`/` 重建 `web/src/meddata/embedded.css` **再** build `web`（E15'/R9）。

**挂起项触发条件**：窄屏卡片态＝用户确认接受；双线修法（`border-collapse: separate`）＝蓝线改位后仍见；V7/V8＝D-2 开工时一并验。

**我无法自解、需拍板的 3 条**（与 v0.2 相同，仍待用户/主理人）：① `.card` hover 光晕全站收敛 or 局部；② 窄屏卡片态替换表格能不能接受；③ 两套 reset 是否要统一（把 `embedded.css` 的构建改成带 `border-style: solid` 全局重置 —— 这属**构建配置变更**，影响 `/` 下所有 meddata 组件，比本批大）。

---

## 6. 回退与门禁（v0.3，采纳 r1/A6）

`dist*` 三项全在 `.gitignore`、`git ls-files` 0 文件 ⇒ **`git revert` 只回源码，线上仍跑新构建**。回退必须四步：

1. `git revert <commit>`（源码）；
2. **条件重建入库 CSS**（r2/N4：**不是多余步骤** —— 本轮 `meddata/src/index.css` 有 +69 行 `.g-grid` 整块，不重建则 `/` 侧连简写边框、行高、轨道修复全都没有）：
   `git diff --name-only HEAD~1 | grep -qE '^meddata/src/' && node web/scripts/build-meddata-css.mjs`
3. 两条构建：`npm run build:meddata`（→ `web/dist-meddata`，`/meddata` 活路由用）与 `npm run build:web`（→ `web/dist-next`）；**两条都要建**（r2/N4 指出我漏了前者）。
   **重建后自检（r2 给的判据）**：`web/src/meddata/embedded.css` 里 `.g-grid` 块应含 +69 行规模；三个新类 `flex-wrap` / `truncate` / 任意值 `w-[68px]` 重建后各 **≥1 命中**（`grep -c` 逐一核，0 命中＝没重建）。
4. 验证：`curl` 两个入口的 `index.html` asset hash 与本地对应产物一致（防"改了没上线"）。
   **门禁（同批必跑三条，均已核存在）**：`node tests/verify-edit-modal-375.mjs`、`node tests/verify-report-lib-ui.mjs`、`node tests/verify-reviewgrid-v06.mjs`。

---

## 7. 与两个在途批次的边界（v0.3，§7.4 已反转）

1. **本批先做**（r1：两批都没碰 `DataGrid.jsx`；本批会把 edit-modal r1 的 B1/B2 接管过去，之后零交集）。
2. **加不改删**：保留 `rb-edit-grid-wrap`、`flex items-center justify-between`（直接子元素关系）、`div.overflow-x-auto`（唯一滚动器）、`card p-3/p-4` 内边距。
3. **表宽 ≥760px**。
4. **G6（栅格 `min-width:0`）归本批在 `.g-grid` 上落地**，不归 edit-modal（它只在 `.mb-edit-modal` 作用域内改）。
5. 动结构前先 `git status` / `git log -1 --stat`，确认没人正在改同一文件。

---

## 8. 断言归属与顺序（r2/N5）

- 三批**不会互红**（r2 逐条核过判据形式：`bodySH` 只比大小、`c2Margins` 只看根子项 `marginTop` 且本批没动 `space-y-4`、保存行与工具栏按钮都没删、`de===375` 只会更小、reviewgrid 那条纯 Node）。
- **归属一句话**：改 `DataGrid` 的那批（＝本批）在自己提交里跑三条验证并贴输出；断言若因结构变化失效，**由本批同提交改**，但**只许改"结构判据"，不许改"用户可见行为判据"**。
- **环境事实**（r2 提供）：`5174` 已 `head=d0792f4`，两产物 19:38 重建且都含 `g-grid` ⇒ 现在量的是工作区代码；**"跑绿 ≠ 已提交"，提交前必须再跑一次**。
- **P0-1 已在产物里发生**：`dist-next` 里 `.g-grid>.grid{grid-template-columns:minmax(0,1fr)}` 现存量在，桌面 1440 的记录信息卡已塌成 1 列 —— 提交前必须按 §3.2 禁则改掉并重建，否则提交的是"修窄屏破桌面"的版本。

---

## 9. 落地复查实测记录（UI 设计师，2026-11-16 19:46，`/` 路径 @5174，工作区代码）

**代码侧四条 P0/P1 已落（我逐条 grep 核过，不是转述）**
```
grep -c 'g-grid > .grid {' meddata/src/index.css            → 0   （禁则已删，只剩 :220 `> * { min-width: 0 }`）
grep -c ':where(.g-grid .g-ctl)' meddata/src/index.css      → 1   （不是 5 条色板快照）
grep -c 'g-main' meddata/src/components/DataGrid.jsx        → 1
grep -o '\.g-grid>\.grid{' web/dist-next/**/*.css web/dist-meddata/**/*.css → 0 命中
grep -c 'gridTemplateColumns' tests/verify-grid-narrow-D1.mjs → 1（V9 已进脚本）
```

**`MEDBRIEF_BASE=http://127.0.0.1:5174 node tests/verify-grid-narrow-D1.mjs` → 「17 通过 / 0 失败」**，关键数字：
- `V2 行高恰好 40px（23 行，极差 0）`
- `V3 控件边框恒 solid 1px`（button/input/select 全 solid+1px；`padding-left` 全 8px）；`V3例外 序号 input 无边框（none/0px）`
- `P0 记录信息卡轨道数 4`、`P0 双栏卡轨道数 5`（桌面栅格未被压掉）
- `V1b 375/414/767 页面无横向滚（375/375、414/414、767/767）` + 三宽下两张卡轨道数均 1
- `V5' ↺ borderWidth=0px`；`V6' td nowrap` + 代码选择器高 32
- `未识别文案已拆`（DOM 中无 11 字长串）

**我复查中发现、实现方也没报的两处缺口（不掩盖）**
1. **V1a 在弹窗内不可判**：脚本量到 1440 下容器 `760/481` 并只给 INFO —— 这是**正确处置**（弹窗只有 ~481px 宽），但意味着「≥1024 不横滚」这条**尚未在全页 grid 上被验证过**。下一步需在全页 Intake/`/meddata` 1440 各量一次，或把该条正式标 N/A。
2. **`!` 角标未被覆盖**：`bangPos=null`（本次夹具没有"疑似错位"行），V5' 的第二半（hover 前后该格宽度不变）**没被测到**。需要一条带 `_suspicious` 的夹具，否则这条断言等于没写。

### 9.1 复查追加（19:50）：**验收脚本本身是"假绿机器"**（比 P0 更该先修）

我读 `tests/verify-grid-narrow-D1.mjs` 全文后发现：它**没有 `fail()`**，只有 `ok()`（`pass++`）与 `info()`：
```
:15  let pass = 0
:16  const ok = (n,e) => { pass++; console.log(`PASS …`) }
:17  const info = (n,e) => console.log(`INFO …`)
:189 console.log(`… ${pass} 通过 / 0 失败`)   ← "0 失败" 是硬编码，没有失败计数器
:20/:112/:117  SKIP → process.exit(0)        ← 服务没起 / 没数据 也返回"绿"
```
后果：**任何期望不符都只打印 INFO，脚本永远输出「N 通过 / 0 失败」**。也就是说我上面第 9 节贴的「17 通过 / 0 失败」里，**数字是真的、闸门是假的** ——
V9 的 else 分支（`:161`/`:163`/`:183`）写成 `info(...)`，`trackInfo` 塌成 1 列时脚本照样"全绿"。**这违反我们自己的 A5 标准（写了也永远绿 ≠ 判据）。**

**必须修（本轮交付前置条件）**
1. 加 `let failed = 0; const fail = (n,e='') => { failed++; console.log(...) }`，把所有"期望 X 但得到 Y"的 `else info(...)` 改成 `else fail(...)`（V2/V3/V4/V5'/V6'/V9 逐条查，`INFO` 只留纯量测值）；
2. 汇总行改 `${pass} 通过 / ${failed} 失败 / ${na} 未证`，并 `process.exitCode = failed ? 1 : (na > 0 ? 2 : 0)`（见 §9.8 闭环）；
3. `SKIP` 默认**非 0 退出**（服务未起/无数据＝未验证，不等于通过）；确需跳过时用显式开关（如 `ALLOW_SKIP=1`）；
4. 断言 label 用显式 `V9 …` 前缀（r2 要求"PASS 原文里能看到 V9 四条"，现在标签是 `P0 …`、`V9` 字符串 0 命中，grep 会误判为缺失）；
5. **证伪一次**：把 `.g-grid > .grid { grid-template-columns: minmax(0,1fr) }` 加回去 → 必须 `FAIL` + 退出码 1（1440 两条轨道数变 1）→ 删掉 → 恢复 PASS + 退出码 0；两次输出都贴；
6. 交回时附 `curl -s 127.0.0.1:5174/api/health`（head）与 `ls -l web/dist-next/assets/*.css web/dist-meddata/assets/*.css`，证明量的是**重建后**产物。

### 9.2 复查追加（19:55，r2 同意上述判断并收紧）

1. **失败分支必须是 `throw`，不是 `fail()` 也不是 `info()`**：`fail()` 若只打日志、最后靠 `exitCode` 也够，但 r2 的硬要求是 V9 三处 `else info(...)` → **`throw new Error(...)`**（`:161`/`:163`/`:183`），并 `:189` 改 `${fail} 失败` + `process.exitCode = 1`。**"数字保证出现、永不报警"的判据不算判据。**
2. **V9 覆盖补 `1023` 档**：1440 → 4 / 5；**1023 → 2 / 1**（`md:grid-cols-2` 就是 P0 的连带受害者）；375/414/767 → 1 / 1。
3. **`!` 角标不造夹具，用结构 grep 代理即可**（r2 已验，两条各命中 1）：
   ```bash
   grep -c 'hidden absolute -right-1' meddata/src/components/DataGrid.jsx            # 1 → 已脱离 flex 排布
   grep -c 'relative flex items-center gap-1.5' meddata/src/components/DataGrid.jsx  # 1 → 角标的包含块
   ```
   两条同时成立＝"角标不再改变该格宽度"的充要条件；真量宽度需 `_suspicious` 夹具，列为可选。
4. **V1a 补一次全页量测**：在 `/meddata`（ImportFlow 主流程）或 IntakePage 的 `.mb-review-grid` 上，1440 视口断言 `div.overflow-x-auto` 的 `scrollWidth <= clientWidth + 1` 且 `documentElement.scrollWidth === innerWidth`；modal 内标 N/A。
5. **放行四样（r2 的最终口径）**：① V9 **四行**轨数（含 1023 档）来自**重建后产物**（附 `curl /api/health` head + 两产物 `ls -l`）；② 证伪一次变红（禁则加回→`throw`/退出码 1→删掉恢复绿）；③ 禁则 `grep` 在源码与**两个产物**里 0 命中；④ `verify-edit-modal-375.mjs:46/:116` 两条契约仍绿。

### 9.3 复查追加（20:00，实测 `verify-grid-narrow-D1.mjs`：退出码 **1**、29 通过 / **5 失败**）

**闸门现在真的能红了**（Manager 19:49 版脚本：`fail()` 计数、`:189` `${pass} 通过 / ${failed} 失败`、`exitCode`、`SKIP` 默认非 0 且要 `ALLOW_SKIP=1`、`V9` label 15 处、1023 档已加）。5 条红如下，**其中 2 条是我规格的错**：

| # | 失败原文 | 归属 | 处置 |
|---|---|---|---|
| 1 | `FAIL V3 有 5/138 个 .g-ctl 边框不是 solid 1px` | **我的规格错**（采纳 r2 的 `:where()` 时用错了层） | 见下「修复 A」 |
| 2 | `FAIL V3 padding-left 不一致：8px/2px/8px` | 实现侧（有一个控件没吃 `.g-ctl` 的 `padding: 0 8px`，量到 `pl=2px h=18`，且 `bs:none/bw:0px` —— 与第 1 条同源） | 见下「修复 A」+ 定位该元素（很可能就是「数值」input） |
| 3 | `FAIL V4 取不到 .g-ctl 做聚焦取样` / 4. `边框色=null` | 同 1/2（取样元素本身就是没吃到规则的那个） | 修好 A 后自然绿 |
| 5 | `FAIL V1a 1440 全页表格容器横滚 760/673（期望 ≤ clientWidth+1）` | **我的规格错**：表宽 ≥760 是契约（§4.2 ⑤），而 1440 全页的表格容器只有 **673px** ⇒ 必然滚。原判据不可满足 | 见下「修复 B」 |

**修复 A（`:where()` 只能包 color，不能包 style/width）** —— 这一条同时解释第 1–4 条：
`:where()` 把特异性归零 (0,0,0)，于是 `.border-red-300` 这类 (0,1,0) 工具类把它整条 shorhand 都盖掉；而 `/` 侧 `.border` 只给 `border-width`、**没有 style** ⇒ 被盖的那 5 个控件变成 `bs:none`。正确写法是**拆两层**：
```css
/* ① 有边框：style + width 走高特异性，谁都盖不掉 */
.g-grid .g-ctl { border-style: solid; border-width: 1px; }
/* ② 颜色：走 :where()（0,0,0），状态色工具类 (0,1,0) 可覆盖，无需色板快照 */
:where(.g-grid .g-ctl) { border-color: #cbd5e1; }
```
这样既保住「加新状态色自动生效」（P1-2 的初衷），又不会把边框本身让出去。

**修复 B（V1a 重定义，可证伪且可满足）**：
- 容器 `clientWidth >= 761` 时：要求 `scrollWidth <= clientWidth + 1`（不横滚）；
- 容器 `clientWidth < 761` 时：**标 N/A 并记录数值**（表宽 760 是契约，容器更窄时滚动属预期，不是缺陷）；
- 页面级仍由 V1b 守（`documentElement.scrollWidth <= clientWidth + 1`，本次 1440/1023/767/414/375 全 PASS）。
**证伪方式**：把表宽从 760 改成 900 而容器仍 673 → 若断言写成 N/A 逻辑仍绿，则改成「记录但不判」；把 `td` padding 加到 24px 使全页 1440 容器超 761 → 必须红。

### 9.4 复查追加（20:05）：`/meddata` 入口**不是"没跑"，是"跑不了"**（r2 指出，我已核）

1. **入口 URL 我打错了**：`meddata/vite.config.js:13` 是 `base: '/meddata/'` ⇒ dev server 入口是 **`http://127.0.0.1:5288/meddata/`**，不是 `/`。判活要用
   `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5288/meddata/`。
   **实测两个 URL 现在都是 `000`** ⇒ 服务确实没起；但判据本身之前用错了 URL，记在这里防止重复。
2. **脚本结构上就走不到 `/meddata`**（这是硬限制，不是执行意愿问题）：`tests/verify-grid-narrow-D1.mjs` 的 `openModalGrid()` 写死三步 ——
   `p.goto(\`${BASE}/?tab=reports\`)`（只认 `/` 壳的报告库）、点 `button[aria-label="编辑"]`（`/meddata` 没这个入口）、
   `root = '.mb-edit-modal .g-grid' || '.mb-edit-modal .rb-edit-grid-wrap > div'`（`/meddata` 没有 `.mb-edit-modal`）。
   ⇒ 在 `/meddata` 侧 `root === null`、返回 null、上层 `SKIP`。`grep -c ENTRY` = **0**（没有入口分支）。
   **必须加 `ENTRY` 分支**（`ENTRY=meddata` 时走 `goto('http://127.0.0.1:5288/meddata/')`），且**必须真渲染出 ≥1 行**（`tbody tr`）——
   空态量出来的数字比不跑更糟，**无行时 `fail` 不 `skip`**。
3. ~~退路（半证）必须书面标注~~ **【已撤销，见 §9.11】**：曾允许「任一 `.border` 元素 `borderTopStyle==='solid'`」作为半证；但它只证明该环境有 preflight、`/` 没有，**不等于 `.g-ctl` 生效**，且 `未证 ⇒ na>0 ⇒ exit 2` 与 ② 冲突 ⇒ 现要求**必须真证**。
4. **放行口径第 5 项**：`/meddata` 入口**必须真证**（起 5288 + 渲染 ≥1 行 + 量到四类 `.g-ctl`）；「半证」已撤销。

### 9.5 复查追加（20:10）：**我拆 `:where()` 时引入了一条用户可见回归**（r2 发现，我已核）

**回归：虚线被压平 ⇒「未识别」与「已识别」同形。**
我为修「5/138 没边框」把 `border-style: solid; border-width: 1px` 提到 `.g-grid .g-ctl`(0,2,0)，但**忘了 style 也会被工具类覆盖**：`DataGrid.jsx:129` 的未识别态正是靠 `border-dashed`(0,1,0) 表达
（`cur ? 'border-slate-300 bg-white' : 'border-dashed border-slate-300 text-slate-400'`），(0,1,0) 打不过 (0,2,0) ⇒ **虚线变实线，两态只剩灰字可区分**。`grep -c dashed meddata/src/index.css` = **0**，没加例外。
> 这条比 `padding-left` 差 6px 严重得多：它是用户能直接看见的语义丢失。**归因在我**（只想着"颜色要可覆盖"，漏了"style 也要可覆盖"）。

**修法（1 行 CSS + 1 条断言）**
```css
.g-grid .g-ctl.border-dashed { border-style: dashed; }
```
```js
const dz = [...root.querySelectorAll('.g-ctl.border-dashed')]
if (dz.length) dz.forEach((e) => { const st = getComputedStyle(e).borderTopStyle
  st === 'dashed' ? ok('V3 虚线例外保持 dashed') : fail(`V3 虚线被压成 ${st}`) })
```
**并注意**：脚本 `:77` 已经算了 `gctlDashed` 计数，**却没有任何断言使用它** —— 这正是我们这轮一直在打的「有计数器没断言」，这条回归本来会在一份"全绿"里通过。

**另一处：`V3 padding 8px/2px/8px` 是取样选择器问题，不是实现缺陷（已自行消失）**
`DataGrid.jsx:1257` 的序号 input 类名里带 `font-mono`，旧选择器 `input[class*="font-mono"]` 会先命中它（它是 tbody 第一个 input），而它带 `g-bare`（无 padding）⇒ 量到 UA 的 `padding-left: 2px`。脚本 `:60` 现已改成 `tbody input.g-ctl[class*="font-mono"]`，序号框被排除 ⇒ **该 2px 不可能再出现**。
⇒ **若重跑仍红，不许给序号框加 padding**（会破坏居中+无框设计），按实际取值重新定位：
```js
[...root.querySelectorAll('tbody td')].slice(0,8).map((td) => { const e = td.querySelector('input,select,button')
  return e && { tag: e.tagName, cls: String(e.className).slice(0,40), pl: getComputedStyle(e).paddingLeft } })
```

**放行口径增第 ⑥ 项**：`.g-ctl.border-dashed` 例外落地 **且** dashed 断言进脚本（否则「未识别」与「已识别」在网格里长得一样，这是用户可见回归，比 6px 更该拦）。
**V1a 的 N/A 仍要留证据**：标 N/A 时必须把 `760/673` 这组数字记进报告，并确认 V1b 在 1440/1023/767/414/375 全绿（页面级才是用户视角）。

### 9.6 放行清单定稿（20:15）：**7 项，缺一不签**

> r2 把 ⑥⑦ 正式并入清单（我上一轮已接受并落了规格，这里只做"入清单"登记，避免"口头接受但没进验收清单"）。

| # | 项 | 判据 |
|---|---|---|
| ① | V9 四行轨数来自**重建后产物** | 1440 → 4 / 5；1023 → 2 / 1；375 / 414 / 767 → 1 / 1，且附 `curl /api/health` 的 head 与两产物 `ls -l` |
| ② | 脚本真能红 | 汇总行 `0 失败` 且 `exitCode 0`（当前为 `29 通过 / 5 失败`、退出码 1） |
| ③ | 证伪两次**且证伪时重建产物** | 加回禁则 → `build-meddata-css && build:web && build:meddata` → FAIL/exit 1 → 删掉 → 重复三步 → PASS/exit 0 |
| ④ | 禁则 0 命中 + 契约不破 | 源码与**两个**产物 `.g-grid>.grid{` 均 0；`verify-edit-modal-375.mjs:46/:116` 仍绿（表宽 ≥760、唯一横滚容器） |
| ⑤ | `/meddata` 入口（**必须真证；入口已按 §9.14 改判为产物级 `5174/meddata/`，5288 dev 不再是放行判据**） | `ENTRY=meddata MEDDATA_BASE=http://127.0.0.1:5174/meddata/` → 上传真化验单夹具并**走完「选择引擎 → 识别 → 出表」** → 渲染 **≥1 行**（`tbody tr`）且量到 `.g-ctl` 四类的 `borderTopStyle/Width` + `padding-left`；PASS 文案必须印集合大小 `rows=N gctl=M`（**M ≥ 1**）。仍**未证 ⇒ 判不合格**（`未证 ⇒ na>0 ⇒ exit 2` 与 ② 的 `exitCode 0` 冲突，与 ⑥ 同构） |
| **⑥** | **虚线例外**（用户可见回归，必做） | 三个条件同时满足：① CSS 例外落地 `.g-grid .g-ctl.border-dashed { border-style: dashed }`；② 断言用**非空**形式 —— `dz.length >= 1 && dz.every(e => getComputedStyle(e).borderTopStyle === 'dashed')`（**`=== 0` 即通过是空过写法，已作废**）；③ **至少一次 `dz.length ≥ 1` 的实测**，1440 与 375 **各一次**。**⑥ 不许走 N/A**：`dz.length === 0` ⇒ **直接判不合格**（造 `dz ≥ 1` 的成本只是把某行 `standard_code` 置空，没有"拿不到"的正当理由）。`N/A` 机制只留给**环境不支持**的判据（如 V1a 容器 673 < 761）。另：`:77` 的 `gctlDashed` 计数器必须被断言使用（否则违反 R1） |
| **⑦** | V3 padding 若仍红**按实际取值重定位** | **禁止**给序号框（`:1257`，`g-bare`）加 padding；用 `tbody td` 探针重新定位到具体元素后再改 |

**优先级**：⑥ 是必须项 —— 颜色/内边距差几像素用户未必察觉，**「未识别」与「已识别」长得一样一定会被察觉**。
**V1a 的 N/A**：673 < 760 判据不可满足，标 N/A 时把 `760/673` 写进交付说明当证据；页面级由 V1b 守（1440/1023/767/414/375 全绿）。

### 9.7 放行清单收敛为 **6 项**（20:20，r2 定稿）+ 两条规则

**⑦ 不是新闸门，是 ⑥/② 的约束**：它只限定「若重跑后 padding 仍红，不许靠改代码去凑」，并附 `tbody td` 探针。故最终清单＝**6 项**（原 ①–⑥），⑦ 写在 ③/② 的执行约束里。

**规则 R1（本项目验收通用，不限于本次）**：**凡"算了但没判"的字段，一律打回。** 同类问题这轮已出现三次 ——
`:189` `0 失败` 硬编码、V9 的 `else info(...)`、`:77` `gctlDashed` 只算不判。只修当次没有用，所以升为规则：**有计数器/量测值而没有任何 `ok/fail` 消费它 ⇒ 交付不合格**。

**规则 R2（防"空过"，与 SKIP 同一道理：没验证 ≠ 通过）**；**N/A 的适用范围**：只给"环境不支持/判据不可满足"（如 V1a 容器 673 < 761），**不给"数据没造出来"**（如 ⑥）—— 后者一律判不合格，否则与 ② 的 `exitCode 0` 直接冲突（N/A⇒na>0⇒exit 2）。：⑥ 的 dashed 断言现在**永远会通过** ——
dashed 只在**存在未识别行**（`standard_code` 为空）时出现，而夹具挑的是"血常规 + 有指标行"的报告，代码通常全匹配 ⇒ `dz.length === 0` ⇒ 第一条判断直接放行。
**追加口径**：
- 必须选一份**含未识别行**的报告，或手动清掉某行的 `standard_code` 造出来，使 `dz.length ≥ 1`；**1440 与 375 两个宽度都至少要看到一次 `dz.length ≥ 1` 的实测**；
- 拿不到这种数据时，输出必须写成 **`N/A（无未识别行，⑥ 未证）` 并从「已证」清单剔除**，**不许记 PASS**。

### 9.8 ⑥ 判据定稿（20:25，r2 最后一处修改）

**错写法（已作废）**：`dz.length === 0 || dz.every(…)` —— 没有 dashed 元素时也成立，**必空过**。
**正写法**：
```js
// 汇总行三个计数都要出现在同一行：`${pass} 通过 / ${failed} 失败 / ${na} 未证`
const na = (n) => { nas++; console.log(`N/A ${n}`) }        // 未证 ≠ 通过（R2）
const dz = [...root.querySelectorAll('.g-ctl.border-dashed')]
if (dz.length === 0) na('V3 虚线例外（无未识别行，⑥ 未证）')   // 必须在汇总行可见
else {
  ok(`V3 虚线例外保持 dashed（${dz.length} 个）`)              // 聚合成 1 条，别逐元素刷 PASS 虚增计数
  dz.forEach((e) => { const st = getComputedStyle(e).borderTopStyle
    if (st !== 'dashed') fail(`V3 虚线被压成 ${st}（${e.className.slice(0, 40)}）`) })  // 失败才逐元素定位
}
```
**退出码必须跟着 `na` 走（r2 补的闭环）**：
```js
process.exitCode = failed ? 1 : (na > 0 ? 2 : 0)   // 0 全证通过 / 2 有未证(要人看) / 1 有失败
```
否则「未证」只活在日志与汇总行里，下一层自动化（谁 `&&` 了这个脚本）依旧绿灯放行 —— 与 `SKIP` 同类错误。

**两条写法要求（r2 补，省事且防虚增）**：① 绿色输出**聚合为单行**（`${dz.length} 个`），失败才逐元素 `fail`（便于定位到具体行）；
② `dz.length === 0` 走 `na()`（进汇总行 `N 通过 / M 失败 / K 未证`），**不用裸 `console.log`** —— 否则"⑥ 未证"只存在于滚动日志里，事后看 `N 通过 / 0 失败` 根本看不出这一项被跳过。
**造数据**：选含未识别行的报告，或手动清掉某行 `standard_code`，使 `dz.length ≥ 1`；**1440 与 375 各至少一次**。

**编号对齐说明**：闸门是 **6 项**（①–⑥）；r2 口中的「7 项」= 6 项 + ⑦「padding 若仍红按实际值重定位」这条**约束**（不是新闸门）。两者指同一集合。

**硬性退回标准（三条任一即判不合格）**：⑥ 只改 CSS 未加断言；用 `info` 冒充 `fail`；`dz.length === 0` 却记成 PASS。

### 9.9 待批：把 R1/R2 升到通用层 `~/.agents/skills/plan-review.md` §8.8（**提案，未执行**）

> r2 提议、我同意，但这是**跨项目治理文件**，需主理人/用户点头才动。**位置不选** `~/.agents/ui-design-standard.md` ——
> R1/R2 不是视觉规范，读者是**审核者**不是设计师；放进设计标准等于稀释 + 会长出并行 SOP（违反 plan-review §6.7「两份必然漂移」）。

**拟新增 §8.8「判据可证伪性自检（审核者必过）」五条**（前四条＝R1/R2 的规则化，第 5 条为本轮真踩到的机械化判据）：
1. 每条断言先问「它在什么情况下会**红**」，答不出即判据不合格；
2. 有计数器/量测值，必须有 `ok/fail` 消费它（R1：算了但没判＝打回）；
3. 集合类断言必须证明集合**非空过**，拿不到数据标 `N/A` 且不计通过；`SKIP` 不许走退出码 0（R2）；
4. 退出码三分：**FAIL=1 / SKIP=2 / PASS=0**；
5. **集合类断言的 PASS 文案必须印出集合大小**（`…（${len} 个）`）—— 本项目至少四处要带：`dz`（dashed 个数）、`gctls`（V3 的 `.g-ctl` 数量，现为 138）、`pads`（padding 取样数）、V9 的轨数（已带数字）—— 事后 `grep "0 个"` 即可发现空过，不需要回看代码；
   本轮实例：`input[class*="font-mono"]` 先命中序号框（选择器选错元素，断言照样绿）与 `dz.length === 0 || every()` 同属"空过家族"。

**落地流程（plan-review §6.8）**：备份 → diff 自检 → 显式路径提交（禁 `-A`）；这是给审核者的规则、不是给作者加流程 ⇒ 送审用**一次性有界审核**，文件 `plan-review-gate-audit.md`（**禁** `-r1.md`，避免与轮次命名撞车）。
**项目侧**：`.agents/testing-lessons.md` 已保留三个实例（2026-11-16 那节），通用层只留规则，两边不重复。

### 9.10 口径钉死（20:35，r2 指出 ②/⑥ 自相矛盾，我认）

**矛盾**：我在 §9.6 同时写了「⑥ 允许 `N/A`」与「② 要求 `exitCode 0`」。而 `N/A ⇒ na>0 ⇒ exit 2` ⇒ 只要 ⑥ 走 N/A，② 就永远不满足；再叠加 ⑤ 允许「书面半证」，两条直接打架。
**resolution（按 r2 的**第一条（推荐项）**执行；他给的第二个选项「放宽成 `exitCode ∈ {0,2}`」已否决 —— 别把序号记反）**：
1. **⑥ 不许 N/A，必须真证**（造 `dz ≥ 1` 只需把某行 `standard_code` 置空）；**⑥ 出现 N/A 即判不合格**。
2. **N/A 机制收窄**：只给"环境不支持 / 判据不可满足"（如 V1a 容器 673 < 761），**不给"数据没造出来"**。
3. **PASS 文案带集合大小**扩到四处：`dz`（dashed 个数）、`gctls`（`.g-ctl` 数量，现 138）、`pads`（padding 取样数）、V9 轨数 —— 选择器写错时"0 个"一眼可见。

**修复前须自查（作者责任，**全表逐条过，不只扫新加的那条**）**：放行清单里每一条，先算「走它允许的分支时 `na` 会不会 >0」⇒ 若会则 `exit 2`，与「② 要求 `exitCode 0`」冲突 ⇒ 该条必须改成真证、或明确不放行。本轮两个矛盾（⑥ 与 ⑤）都是「局部加规则、没回头验全局」，所以自查写成逐条过表。

### 9.11 第二处同构矛盾（20:45，r2 抓到 ⑤，我认）

**矛盾**：⑤ 允许「`/meddata` 书面半证」 ⇒ 该侧 V3/V4 未证 ⇒ `na>0` ⇒ `exit 2` ⇒ ② 的 `exitCode 0` 不满足。**与 ⑥ 完全同构，只低一层。**
**裁定（与 ⑥ 一致）**：
1. **⑤ 必须真证**：`npx vite --port 5288 --strictPort` → `ENTRY=meddata` → 渲染 **≥1 行** → 量 `.g-ctl` 四类。成本比造 dashed 数据更低（一条命令），没有「拿不到」的正当理由。
2. **「书面半证」选项撤销** —— 它等于「未证也可放行」，与退出码编码自相矛盾。
3. 作者自查**扩成逐条过表**：每条都算「走允许分支时 `na` 是否 >0」，>0 即必须真证或明确不放行。
**台账更正**：§9.10 里「按 r2 推荐那条」指 r2 的**第一条（⑥ 不许 N/A）**；他的第二条（放宽 `exitCode ∈ {0,2}`）已否决。

### 9.12 两个入口证明的不是同一件事（20:50，r2 补，交付说明必须分清）

| 入口 | 吃的是什么 | 证明了什么 | 不能证明什么 |
|---|---|---|---|
| **5288 `/meddata/`** | **vite dev**，直接吃 `meddata/src/index.css` + `DataGrid.jsx`（HMR），**无需 build** | 「**规则本身**对」 | 产物是否带上（`embedded.css` 需单独生成） |
| **5174 `/`** | `web/dist-next` + **入库产物** `web/src/meddata/embedded.css` | 「**构建管线把规则带过去了**」 | 源码侧是否改过（产物可能来自旧构建） |

**⇒ 5288 全绿 ≠ 产物也绿；`/` 绿也不证明源码侧。两个入口都要，缺一个就只证了一半。**

> **本节第 1 行已被 §9.14 取代**（20:0x 裁定）：`5288` dev 的结构性缺件使其**不可能**出数据行，故「源码侧」不再由 dev server 承担，改为由**两条构建管线各自的产物**承担 —— `5174/`（`dist-next` + `embedded.css`）与 `5174/meddata/`（`dist-meddata`）。**这张表最要紧的结论没有变**：A2 的病灶是"两条管线对同一份源码生成不同 CSS"，所以要证的就是**两条管线各测一遍**；变的是"谁来代表源码侧"（dev 服务器 → 另一条产物）。下表其余口径（不许合并成"双入口都绿"）照旧有效。
**交付说明必须分别写**：「`/meddata`（dev，源码）: …」「`/`（构建产物）: …」，**不许写成「双入口都绿所以没问题」**（A2 的病灶就是 `embedded.css` 不含 preflight 却要单独生成）。

**实现方最小路径（r2 给的顺序）**：
1. 写 `ENTRY=meddata` 分支（`goto 5288/meddata/`、`root='.g-grid'`、无行 `fail` 不 `skip`）；
2. 加 `.g-ctl.border-dashed` 例外 + 非空 dashed 断言 + 造 `dz≥1` 数据；
3. 四处 PASS 带集合大小、`na()` 接汇总行、三档退出码；
4. 起 `npx vite --port 5288 --strictPort`，并确认 5174 吃的是**重建后**产物（health head + `ls -l`）；
5. 重跑 → 6 项 + 两入口数字 + 证伪两次。

### 9.13 卡点报告的格式要求（20:55，r2 补）

报卡点（5288 起不来 / `/meddata` 渲染不出行 / 证伪时产物没更新等）**必须三段**，缺一段视为没报：
1. **执行的完整命令**（含端口、`ENTRY=…`、工作目录）；
2. **完整输出**（不是"起不来"，是终端原文：vite 报错 / 浏览器控制台 / `curl -w "%{http_code}"` 结果）；
3. **自判**是**环境问题**还是**判据问题**：
   - **环境问题**（端口占用、依赖缺失、机器无 GUI）⇒ 审核方可放行/改跑法；
   - **判据问题**（如 `/meddata` 无数据 ⇒ `dz=0`）⇒ **说明规格还缺"造数据"步骤，退回改规格**，不许在实现侧硬凑。

一句话原则：**"跑不了"和"不达标"必须能区分** —— 这与 R1/R2 同源（「没验证 ≠ 通过」）。

### 9.14 裁定（20:05，实现方报 ⑤ 卡点后）：入口改判为**产物级** `5174/meddata/`，撤销 A（改 vite.config）与「5288 dev 是判据」

**问题**：实现方按 §9.6 ⑤ 起 5288 dev，`/api/*` 全 404、tesseract worker 404 ⇒ 网格只有 1 行空态占位、`gctl:0`。它给了两个选项让我裁：**A** 给 `meddata/vite.config.js` 加 proxy；**B** ⑤ 改用 `5174` 活路由 + 真化验单图。

**裁定：选 B，但 ⑤ 的落点从 `5174/meddata/`（不是 `5174/`）取真证；A 撤销。**

#### 证据（我实测，2026-11-16 20:03–20:06，服务均为实现方已起的实例）

| 探针 | 5288（dev，base=`/meddata/`） | 5174（mount.mjs 挂载层） |
|---|---|---|
| `/meddata/` | `200` | `200` |
| `/api/*` | 无 proxy（`grep -c proxy meddata/vite.config.js` = **0**）⇒ 全 404 | 由 mount 代理 + 本地镜像，`/api/data/health` = `{"ok":true,"version":5,...,"records":0}` |
| tesseract worker（源码硬编码的**绝对路径** `/tesseract/worker.min.js`） | **404** | **200** |
| `/traineddata` | **404** | **200** |
| 同一份静态文件在**带 base 前缀**的位置 | `/meddata/tesseract/worker.min.js` = **200**、`/meddata/traineddata` = **200** | — |

⇒ 5288 的失败有**两个**独立成因，都是"dev 在子路径 base 下跑"的产物，不是判据问题：
1. 无 `server.proxy` ⇒ `/api/*` 出不去；
2. `publicDir` 随 `base` 前缀发布 ⇒ `meddata/src/utils/ocr.js` 硬编码的 `/tesseract/...`、`/traineddata/...`（绝对路径）在 dev 下必然 404，而**文件本身是有的**，只是挂在 `/meddata/tesseract/...`。

**所以 A 是错的修法**：它要改两处（加 proxy + 给 tesseract 做绝对路径 alias），而改的对象是**构建配置**（§7 边界外的文件），目的是让一个**不是交付物**的 dev server 去模仿生产；生产真相是 `meddata/mount.mjs`（同一份源码、按部署姿势挂载），它已经把这两件事都做对了。

#### 不丢的结论（D10：被撤销的判据要留痕，不许"挤掉"）

- **§9.12 原第 1 行「5288 dev 证明规则本身对」不再是放行判据**，理由是环境结构性缺件（上表两条），**不是"这条不重要"**。
- "规则本身对"这个claim **没有被丢掉**，改由更强的证据承担：**两条构建管线各自都用同一份 `meddata/src` 建产物、且各自测一遍** —— `5174/`（`dist-next` + `embedded.css`，已由现有 37 项绿覆盖）与 `5174/meddata/`（`dist-meddata`，由 ⑤ 覆盖）。产物级证据比 dev 级证据强：dev 只能说明源码规则存在，产物能说明**规则真的被构建带过去了**，而 A2 的病灶恰恰在构建管线。
- 因此 **⑤ 不产生 `na`**：`na` 只留给"环境不支持且判据不可满足"（如 V1a 的 `673 < 761`）；本次是**判据换了落点**，不是"没验证"。

#### ⑤ 的执行判据（实现方照此改，不再问）

1. 入口：`ENTRY=meddata MEDDATA_BASE=http://127.0.0.1:5174/meddata/`（脚本保留 `MEDDATA_BASE` 可切回 5288，作**可选诊断**，不进放行判据）。
2. 夹具：复用既有的那份真化验单（`tests/verify-grid-narrow-D1.mjs:125` 的 `FIXTURE_PDF` 默认值，实测存在：1,285,011 B）。**必须走完「选择引擎 → 识别」到出表**，停在引擎选择页不算跑。
3. 判据：`tbody tr` ≥ 1 **且** `.g-ctl` ≥ 1，再量四类控件的 `borderTopStyle/Width` + `padding-left`；PASS 文案必须印集合大小 `rows=N gctl=M`（R2/§8.8 第 5 条），`M = 0` 即 `fail` 不 `PASS`。
4. 若上传后被判到 `gctl = 0`：按 §9.13 三段式报，并**自判为判据/规格问题**（夹具不适配或漏了引擎步骤），**不许写成环境问题、不许转 `na`**。
5. 实现方上次在 5174 侧看到的 `/api/data/blob/... 400`：**照实写进交付说明**（它是 mount 镜像的 blob 落盘问题，另属一条待查），但**不许拿它当"跑不了"的挡箭牌** —— 先走完引擎步骤，看它是否真的挡住出表；挡住则按第 4 条报。

### 9.15 ⑤ **已由我实测通过**（20:08，Playwright 直驱 `5174/meddata/`，不是推测）+ 新发现 P2（行高 41 ≠ 40，已归因）

裁定 §9.14 之后我**没有把"5174 能出数据行"当作假设交下去**，而是自己跑了一遍。**⑤ 判据在 `/meddata` 侧成立**：

| 宽度 | rows | `.g-ctl` | 边框不合格数 | val / code / arrow | padding-left | 未识别虚线 | infoTracks / splitTracks | 页面横滚 |
|---|---|---|---|---|---|---|---|---|
| 1440 | **1** | **6** | **0** | `solid 1px` / `dashed 1px` / `solid 1px` | **8 / 8 / 8 px** | **1** | **4 / 5** | `1440/1440` 无滚 |
| 375 | **1** | **6** | **0** | 同上 | **8 / 8 / 8 px** | **1** | **1 / 1** | `375/375` 无滚 |

`pageErrors: []`。可复跑配方（**实现方照此写进脚本，闸门必须由脚本复跑，不能靠我这次人工探针**）：
1. `goto http://127.0.0.1:5174/meddata/`；
2. 点 `button:has-text("导入资料")` → 点 `button:has-text("检验报告")`（跳到 `#/reports/add?flow=lab`）；
3. `setInputFiles('input[type=file]', FIXTURE_PDF)` —— 源码「拖文件到下方区域固定走本地识别」，**上传即自动识别，不需要点"选择引擎"**（实现方上次停在「2 选择引擎识别」是漏了下拉/上传之后的等待，不是环境挡路）；
4. 等 ~6s → `.g-grid` 出现、`tbody tr`=1、`.g-ctl`=6；
5. 夹具用既有的那份真化验单（1,285,011 B）。**注意它是骨髓核型报告（正文型），只出 1 行**；1 行足够过 ⑤，但若手边有血常规夹具，补一次多行实测更好（不阻塞）。

#### 新发现 P2（**归属：不是 D-1 引入，是 A2 同一机制的反向表现**）—— V2 行高在 `/meddata` 侧是 **41px**，`/` 侧是 40px

同探针同时量两侧（同一份选择器、同一份 CSS 规则）：

```
A /meddata/ : trH=41  trCssH=41px  trBorderB=1px  tableCollapse=collapse  tdPad=4/4  ctlH=32  rows=1
B / (弹窗)  : trH=40  trCssH=40px  trBorderB=0px  tableCollapse=collapse  tdPad=4/4  ctlH=32  rows=23
```

**归因**：`.g-grid table.g-main tbody tr { height: var(--g-row-h) /* 40px */ }` 是 `tr` 的最小高度，`tr` 上一旦真有 1px 下边框，外框就是 **41**。
而"tr 上到底有没有那 1px"由 **border-style 决定**：`/meddata`（`dist-meddata`，**有 preflight**）里 `border-style` 已重置为 `solid` ⇒ 只给 `border-bottom-width` 的工具类**真画出来**；
`/`（`dist-next` + `embedded.css`，**没有 preflight**）里没有 `border-style` ⇒ 同一工具类**画不出来**。
⇒ **同一条 tr，两侧行高差 1px** —— 这就是 A2（`border-style` 缺失导致两管线不一致）的反向表现，只是这次是 `/meddata` 侧"多"了 1px。

**处置（不判红、但不许埋在结论里）**：
1. ⑤ 的判据**不含行高**，故 P2 不阻塞放行；但**必须写进交付说明**，并登记为 D-2 之前要结的一条。
2. 实现方补两件事：① 在 `/meddata` 侧取**改前基线**行高（它已有 stash 复现手法），确认 41 不是 D-1 引入（预期改前更大）；② **把 V2 的判据定义清楚：测的是"含分隔线"还是"不含"** —— 只能二选一，不许留"恰好 40"这种在一条管线上必然红、另一条必然绿的判据（那是判据问题，不是代码问题）。
3. 修法不由我拍：要么把分隔线从 `tr` 移到不占行高的层（如 `td` 的内阴影 / `border-spacing` 方案），要么把行距预算改成"40 内容 + 1 分隔线"并在两条管线上都成立。**判据改法与实现改法必须同时给，否则下一个人只会看到一条永远红的断言。**

### 9.16 D-1 签收记录（20:30，**我自己复跑**，不采信实现方的转述数字）

**结论：6 项闸门达标，D-1 签收。** 下列每一项都是我在本机重跑/重读得到的，不是引用对方输出。

| 我核的 | 方法 | 我拿到的 |
|---|---|---|
| 提交内容真的在 HEAD 里 | `git show HEAD:…DataGrid.jsx \| grep -c`（**不信工作树**，因为对方刚发生过 `974ded8` 误退） | `g-grid`=**1**、`g-ctl`=**6**、`border-dashed`=**1**、`g-main`=**1**、`g-bare`=**2** |
| CSS 规则 | `git show HEAD:…index.css` | `:187 :where(.g-grid .g-ctl){border-color}`、`:192 .g-ctl.border-dashed{border-style:dashed}`、`:167 --g-row-h:40px`、`:214 …tbody tr{height:var(--g-row-h); border-bottom:1px solid #f1f5f9}` |
| 禁则三处 | `grep -c 'g-grid > .grid {'` + 两产物 `g-grid>.grid{…grid-template-columns` | 源码 `index.css`=0、`DataGrid.jsx`=0；`index-XF0T-UY4.css`=**0**、`index-BtJj3zRr.css`=**0**（均 20:23 重建） |
| `/` 入口 | 我跑 `verify-grid-narrow-D1.mjs` | **37 通过 / 0 失败 / 0 未证，exit 0**（含 V9 四档 4/5、2/1、各 1；V1b 五档全无滚；V2 40/40；V3 138 个 `.g-ctl` 合规；虚线 5 个 dashed） |
| `/meddata` 入口 | 我跑 `ENTRY=meddata MEDDATA_BASE=…/meddata/` | **14 通过 / 0 失败 / 0 未证，exit 0**；`rows=1 gctl=6`、边框 0 不合格、padding 8/8/8、内容高 40、虚线 1、轨数 4/5 与 1/1、无页面横滚 |
| 既有契约 | 我跑 `verify-edit-modal-375.mjs` | **30 通过 / 0 失败，exit 0**（G6 `760/311`、`min-w-[760px]` 未破） |

**复跑锚点**：上表数字在两入口上各跑了两次 —— 一次在 `cdd7a91`，一次在 `c016239`（实现方按 R1 删掉"只算不判"的 `gctlDashed` 死字段）之后的 HEAD，**两次都是 37/0/0 与 14/0/0、exit 0**。删掉死计数器不影响判据，因为真实虚线判据由 `dashedReal`（`querySelectorAll('.g-ctl.border-dashed')` 的 computed style）承担，仍在 `:255/:360` 消费。

#### 签收时**新登记的对照点**（D10：不许因为我签收了就把它从结论里挤掉）

1. **`/` 侧主校对表此前根本没有行分隔线，现在有了** —— 这是 `974ded8` 给 `tr` 补 `border-bottom: 1px solid #f1f5f9` 带来的**用户可见新增**，不在 r1 准予的 5 条之内。我看了实测截图（`/tmp/s-table-shell.png`，761×981）后**接受**，理由三条：① 它与"描边不均匀"同源（`/` 侧无 `border-style` ⇒ 只给 width 的线画不出来），补显式简写是修根因不是加装饰；② 两条管线从此同形（改前 `/meddata` 有线、`/` 没有，用户换入口看到两套观感）；③ `#f1f5f9` 是既有 `--g-divider` 值，没引入新色。**但它属于"我替用户拍的视觉决定"，已写进 §3.2 表格态；若主理人看过实物不要划线，回退只需删 `index.css:214` 那半句。**
2. **V2 判据已从"外框高"改成"内容高"**（`contentH = rect.height − borderBottomWidth`）。方向正确（分隔线不该算进行距预算），但留了一个口子：**边框涨到 3px 时内容仍是 40、断言照样绿**。要求补一句（不阻塞 D-1，随下一批做）：V2 的 INFO 行同时打印 `outer / borderB`，例如 `contentH=40 borderB=1 outer=41`，让"边框偷偷变粗"在日志里可见 —— 与 R1「算了但没判」同源。
3. **V1a 的 N/A 数字**：`/` 1440 容器 `760/673`（表宽 ≥760 契约下必然滚）。这条已在交付说明里，不允许只写 `N/A` 不写数字。

### 9.17 产物核验 + 两处台账更正（20:35，我自己的错误也记在此）

**① 「三个新类进产物」我自己数了一遍 —— 实现方的数字是对的，错的是我第一次的 grep**

| 产物 | `flex-wrap` | `truncate` | `w-\[68px\]` |
|---|---|---|---|
| `web/src/meddata/embedded.css` | 2 | 1 | **1** |
| `dist-next/index-XF0T-UY4.css` | 2 | 1 | **1** |
| `dist-meddata/index-BtJj3zRr.css` | 2 | 1 | **1** |

我第一次用 `grep -o 'w-\[68px\]'` 数出 **0**，并差点据此判它虚报 —— **那是我 grep 写错**：CSS 里工具类被转义成 `w-\[68px\]`（带反斜杠），不带转义的写法根本不存在。
**教训（与 §9.8 同源）**："数出 0" 必须先排除"我的选择器写错"，否则我会用一条错判据去否定一个真交付（这正是 R2 要防的空过家族，只是方向反过来成了"空红"）。

**② `5174` 服务的确实是这两个产物**（不是旧构建，也不是 dev）：`curl 5174/meddata/` 引用 `assets/index-BtJj3zRr.css`、`curl 5174/` 引用 `assets/index-XF0T-UY4.css`，与磁盘 20:23 的两份逐一对应 ⇒ 我那两次 37/0/0 与 14/0/0 量的是当前产物。

**③ 台账更正：`head` 不是 `cdd7a91`**。实现方交付说明写「`head = cdd7a91 = git HEAD`」，实测**已过期**：
`git log --oneline -1` = **`db0a751`**（我的两笔文档提交 `b6e1561`、`db0a751`），最后一笔**代码/测试**提交是 **`c016239`**（它自己删 `gctlDashed` 死字段那笔）。
判据口径：交付说明里的 `head` 必须写**当前 HEAD + 最后一笔代码提交**两个值，否则复核的人会以为产物对应的是 `cdd7a91`。

**④ SKIP 非 0 我自己验过（这是"假绿"最后一个已知出口）**：`MEDBRIEF_BASE=http://127.0.0.1:59999 node tests/verify-grid-narrow-D1.mjs`
→ 打印 `SKIP 服务未就绪` + `SKIP 不算通过（要显式跳过请设 ALLOW_SKIP=1）`，**`EXIT=1`**。
全脚本唯一的 `exit 0` 在 `:20` 的 `ALLOW_SKIP === '1'` 分支内 ⇒ **默认路径不会把"没跑"报成"通过"**。
配套口径：任何交付若声称绿，必须同时说明**没有**用 `ALLOW_SKIP=1` 跑过同一命令。

### 9.18 裁定：V1a 的矛盾**不是"na 该不该计"，是判据本身写错了** —— 改成可满足的 V1a′（并立规则 R3）

实现方报出一处真矛盾，问我选哪条：
- 若 V1a 走 `na()` ⇒ `nas=1` ⇒ `exit 2` ⇒ ② 的 `exitCode 0` 不成立；
- 若 V1a 不进 `nas`（现在用 `measure()` 打印 "N/A"）⇒ 汇总行"0 未证"成立，但**"不适用"变成了一个不进计数、不进退出码的隐形出口**。

**两条我都不接受。** 矛盾只在"判据写成不可满足"时才存在 ⇒ **改判据，不改计数口径**。

#### 为什么 A（measure 打 N/A、不计 na）不成立

这就是这几轮一直在堵的同一个洞：`R2` 要求"没验证 ≠ 通过"，而"我自己宣布这条不适用"如果**不进 `nas`、不进退出码**，那么任何人只要把一条红判据改写成 `measure('N/A…')`，就能让整份交付回到 `0 未证 / exit 0` —— 等于 R2 从汇总行与退出码两侧同时被绕过。**"N/A 不进计数"这件事本身不可接受。**

#### 为什么 B（放宽 ② 到 `{0,2}`）不成立

§9.10 已否决：一旦允许 2，"有未证也能放行"就重新成立，⑥/⑤ 两轮撤掉的出口会全部复活。

#### 定稿：V1a → **V1a′（容器内横滚量 = 表宽超额）**

原判据"容器不横滚"在 `表宽 ≥760` 契约下**不可满足**（1440 下容器只有 673）。改成一条**有确定数字**、可满足也可证伪的判据：

```js
// V1a′：容器内横滚量必须恰好等于「表宽 760 − 容器宽」，多滚 1px 以上即回归
// （原判据「容器不横滚」在表宽≥760 契约下不可满足 ⇒ 是判据错，不是缺陷）
const expectOver = Math.max(0, 760 - n.scrollerCW)
const actualOver = n.scrollerSW - n.scrollerCW
if (Math.abs(actualOver - expectOver) <= 1)
  ok(`V1a′ ${w} 容器横滚量 ${actualOver} === 表宽超额 ${expectOver}（容器 ${n.scrollerCW}、表 760）`)
else
  fail(`V1a′ ${w} 容器横滚量 ${actualOver} ≠ 表宽超额 ${expectOver}（容器 ${n.scrollerCW}、表 760）`)
```

**用已实测的六组数字代入，当场就能全绿**（这些是我历轮量到的原值，不是新跑的）：

| 视口 | 容器 `scrollWidth/clientWidth` | 实际超额 | 期望超额 `760−CW` | 结果 |
|---|---|---|---|---|
| 全页 1440 | 760 / 673 | 87 | 87 | 一致 |
| 全页 1023 | 760 / 731 | 29 | 29 | 一致 |
| 全页 767 | 760 / 587 | 173 | 173 | 一致 |
| 全页 414 | 760 / 314 | 446 | 446 | 一致 |
| 全页 375 | 760 / 275 | 485 | 485 | 一致 |
| 弹窗内 1440 | 760 / 481 | 279 | 279 | 一致 |

**这条判据真的能红**：若将来某个控件把表撑到 900，则 `actualOver=227 ≠ 87` ⇒ FAIL；若有人把 `min-w-[760px]` 改小到 700，则 `actualOver=27 ≠ 87` ⇒ FAIL（顺带守住 760 契约）。
**因此 ⑥ 与 ⑤ 之外不再需要任何 `N/A` 出口**：`nas` 天然为 0，`exit 0` 的语义不再被污染。弹窗内那条同构的 `measure('N/A…')` 一并按 V1a′ 判（279 一致），删掉 `measure` 的 N/A 写法。

#### 规则 **R3（并入 R1/R2，同样要进通用层 §8.8）**

> **凡是被判"不适用/N/A"的判据，必须进 `nas` 计数并影响退出码。**
> 如果某条 N/A 不该进计数，那就说明**判据写错了**（不可满足）—— 要改判据（改成有确定数字、可满足也可证伪的形式），**不许改计数口径**。
> 推论：`measure()` 只许打印量测值，**不许用它打印结论性的 N/A**。

#### 顺带记一条观察（D-2 用，不阻塞本批）

`1440` 下容器只有 **673px**、表要 760 ⇒ 每屏白横滚 87px。这是"表宽 ≥760 + 左图右表双栏"的结构性代价，D-2 若要收掉它，得动 §3.3 的窄屏/双栏方案，不在 D-1 范围。

### 9.19 V1a′ + R3 落地后我复验（`95d7d64`，两入口我自己跑）

| 我核的 | 结果 |
|---|---|
| 实现形态 | `:38 const TABLE_MIN_W = 760`、`:41 expectOver = Math.max(0, TABLE_MIN_W − scrollerCW)`、`:43` 容差 ≤1 判 PASS、`:46` 否则 `fail`；量不到容器时 `:40 fail`（不会退成 `na`） |
| `/` 入口 | **46 通过 / 0 失败 / 0 未证，exit 0**；V1a′ **九处全判**（全页 1440 `760/673`→87=87、1023→29、767→173、414→446、375→485；弹窗 1440 `760/481`→279、375 `760/311`→449、414 `760/350`→410、767 `760/679`→81） |
| `/meddata` 入口 | **16 通过 / 0 失败 / 0 未证，exit 0**；`V1a′ 1440 横滚量 0 === 0（797/797）`、`375 469 === 469（760/291）` |
| `measure()` 打结论性 N/A 的残留 | `grep -nE "measure\([^)]*N/A"` = **0** |
| `na()` 还剩哪些（R3 审计） | 仅 3 处，全是「无未识别行 ⇒ ⑥ 未证」（`:240 :288 :385`），且都进 `nas`、会把退出码推成 **2** ⇒ 符合 R3，没有"隐形 N/A" |
| 证伪（它报的数）算术自洽 | `min-w 760→900` 时容器 `900/673` ⇒ 实际超额 227、期望 `760−673=87` ⇒ `227≠87` 与它贴的 FAIL 行一致；还原后回 46/0/0 |

**结论**：R3 的意图落地了 —— 现在这个 `0 未证` 是**真 0**（`nas` 只有"无未识别行"这一种正当来源，且会污染退出码），不是"把红判据改 `measure`"造出来的。
**遗留观察（不阻塞）**：全页 1440 容器 `673` vs 表 `760` ⇒ 每屏白横滚 87px；`/meddata` 1440 容器 `797` 反而够宽。这是 D-2 的结构代价。

### 9.20 D-1 交付说明验收（分两行写，第三行必须说清 dev 未证）

实现方按 §9.12 的要求分两行写，我复核无误：

| 入口 | 证明什么 | 我复核到的 |
|---|---|---|
| `/`（`dist-next` + `embedded.css`，**preflight:false**，A2 病灶侧） | 构建管线把规则带过去了 | **46 / 0 / 0，exit 0**；`curl 5174/` → `assets/index-XF0T-UY4.css`（磁盘 22:29 重建，**hash 未变 ⇒ 证伪还原后重建字节一致**）；禁则 0 |
| `/meddata`（`dist-meddata`，**preflight:true**，A2 对照侧） | 另一份产物同样带上了规则 | **16 / 0 / 0，exit 0**；`curl 5174/meddata/` → `assets/index-BtJj3zRr.css`（20:23，未再变）；禁则 0 |

**第三行（它是自己写出来的，我没逼）**：「**dev/源码侧（5288）未证** —— 这是裁定撤销 A 的直接结果，不是我漏做」，并给了两条环境事实（`grep -c proxy`=0、`/tesseract/worker.min.js` 在 dev 下 404 而实际挂在 `/meddata/tesseract/…`），且明确**不把"两产物由同一份源码构建"写成"dev 已证"**。这与 §9.14 的裁定一致，**不产生 `na`**（是判据换了落点，不是没验证）。

**台账口径（最后一次）**：`当前 HEAD = 7f7f765`（我的文档提交）、`最后一笔代码/测试提交 = 95d7d64`。交付说明写「`head = 95d7d64 = git HEAD`」时须注明它是**代码 HEAD**，否则复核者会对不上 `git log -1`。

**结论：D-1 收口完成，可交付。** 剩余未动的只有 D-2（需用户拍板三前提）与本 doc 里的两处小决定（行分隔线去留、R1/R2/R3 升通用层 §8.8）。

### 9.21 接受这份 dev 侧卡点报告（三段式合规），并给探活放宽定一条硬边界

这份报告**三段齐全**（命令 / 原文 / 自判），且自判分类正确：环境两条独立成因（`grep -c proxy`=0；`publicDir` 随 `base` 发布而源码硬编码 `/tesseract/…`）＋**它自己脚本的一处探活限制**（就绪探针打 `${BASE}/api/health`，dev 侧 404 ⇒ `SKIP` 并 `exit 1`）。**`SKIP` 走非 0 = 符合 R2**，这点对。

给"放宽探活"定三条硬边界（它说这条归它改，我同意，但口径要写死）：

1. **探活失败仍必须非 0**。把 `api/health` 换成"页面 200"是放宽，不是取消 —— 打不通时依旧 `SKIP` + `exit 非 0`，不许静默 0。
2. **放宽后不许把"无行"变成 `skip`**。页面 200 但网格空 ⇒ 仍走 `fail`（§9.4 第 2 条 / ⑤ 判据已写死），因为"空态量出来的数字比不跑更糟"。
3. **dev 入口是诊断，不进放行汇总**。跑它得出红，不许拿它否定两产物的结论；反之两产物绿也**不许**被写成"dev/源码侧已证"。两句话都要在交付说明里分开写（§9.12 两行 + 第三行"dev 未证"）。

**台账（第五次）**：真实是 `当前 HEAD = 8e4ac7c`（我的文档提交）、`代码/测试 HEAD = 95d7d64`。它继续写「`head = 95d7d64 = git HEAD`」，请统一改成两个显式值，别再写 "= git HEAD"。这条不阻塞交付，但会让复核者与 `git log -1` 对不上。

### 9.22 **更正我在 §9.14 的过度断言：dev 5288 能出数据行** —— 我错了，错在把"图片识别路径"当成唯一路径

**我原话（§9.14）**：「`5288` 的失败有两个独立成因…**dev 结构性做不到**（所以它不可能出数据行）」。
**事实（我自己跑出来的）**：`MEDBRIEF_BASE=http://127.0.0.1:5288 ENTRY=meddata node tests/verify-grid-narrow-D1.mjs`
→ `NOTE 探活经页面 200 放宽：…（该入口为诊断，不进放行汇总）`、`⑤ /meddata 1440 原始 {"rows":1,…, "gctl":6,"gctlBad":0,val solid/1px/8px, code dashed/1px/8px, arrow solid/1px/8px, tracks 4/5}`、`V1a′ 1440 0===0（797/797）`、`V1a′ 375 469===469（760/291）`、**`16 通过 / 0 失败 / 0 未证，exit 0`**。

**为什么会这样（机制，已核代码）**：`meddata/src/utils/ocr.js:1460-1521` 的 `extractPdfPageItems/extractPdfItems` 走 **pdfjs `page.getTextContent()` 文字层**，**完全不需要 tesseract worker**。
⇒ 我核到的那两条环境缺件（`/api` 无 proxy、`/tesseract/worker.min.js` 在 dev 404）**只挡"图片/扫描件"识别路径，不挡"PDF 文字层"路径**。实现方早前那次失败是拿**界面截图 PNG**当夹具，才撞上 tesseract。

**我的错误在哪（写清，不许含糊）**：我把"两次失败"直接推成"结构性不可能"，**没有先问"这个夹具走的是哪条识别路径"** —— 这与我一直要求别人的 R2/R3 是同一类病：**用一个不完整的观察范围去下全称结论**。结论里"dev 结构性做不到"这半句作废。

**这不改变放行判据，但改变了措辞**：
1. 放行仍以**两份产物**为准（`/` 46/0/0、`/meddata` 16/0/0），因为 dev 是 HMR 源码、不是交付物；且探活放宽后该入口按 §9.21 定性为**诊断**。
2. §9.12 原表里"源码侧"这一栏**可以恢复为"有证据（诊断级）"** —— 三个入口现在都诊断性通过（`/` 46、`/meddata` 16、dev 5288 16）。交付说明仍要**分开写三行**，且 dev 一行必须带 `NOTE 探活经页面 200 放宽` 的留痕。
3. **A（给 vite 加 proxy）仍不需要**：它解决的是图片路径与 `/api`，PDF 文字层路径不需要；但"dev 图片路径不可用"这条**作为环境事实保留**，不要写成"dev 全通"。

**顺带认可一个新机制**：探活放宽时打 `NOTE 探活经页面 200 放宽：<url>` —— 放宽动作**留痕可审计**，这比"悄悄放宽"好，符合 R1 的精神（任何口径变化都要在日志里留字）。

**台账（第六次）**：`当前 HEAD` 与 `代码/测试 HEAD` 都由 `f2b63e4` 之后我的文档提交推后，交付说明请继续写两个显式值，别写 "= git HEAD"。

### 9.23 V2 三件的残留：`borderB` / `outer` **只印没判** —— 按 R1 仍要补一条断言

我上一轮要求的是「V2 的 INFO 行同时打印 `outer / borderB`，让'边框偷偷变粗'在日志里可见」。实现方做到了（`:96-98` 采集、`:280 measure('V2 三件', contentH/borderB/outer)`）——**但只做到"可见"，没做到"可判"**：

- 断言只有 `hMin === 40 && hMax === 40`（判的是 **contentH**）；
- `borderB` 与 `outer` **没有任何 `ok/fail` 消费** ⇒ 分隔线从 1px 涨到 3px，日志里会写出 `borderB=3`，**但整份交付仍然全绿**。

这正是我从 r1 起一直打回的 **R1「算了但没判」**，只不过这次踩的人是我自己：我只要了"可见"，没要"可判"，等于给了同一条捷径一个更体面的门面。

**补法（下一批，1 行）**：
```js
if (d.v2Triple && d.v2Triple.borderB === 1) ok(`V2 分隔线 borderB=1px（outer=${d.v2Triple.outer} = content ${d.v2Triple.contentH} + 1）`)
else fail(`V2 分隔线 borderB=${d.v2Triple ? d.v2Triple.borderB : 'null'}（期望恰好 1px；行距口径 = 内容 40 + 线 1 = 外框 41）`)
```
判 `borderB === 1` 而不是 `<=1`：§3.2 已把「行分隔线 1px」写成规格值，**规格值就该被断言**，而不是被"允许 ≤1"兜住。

**归类**：不阻塞 D-1 收口（改前改后都是 1px，用户可见行为没变），但**在下一批开工前必须补**，否则 §3.2 的规格值等于没有判据守着。

### 9.24 `afcae04` 复验：V2 分隔线断言已补；`test:library` 的 1 条红我复现了，处置口径如下

**① V2 的 R1 口子堵上了（我自己跑）**
`:282-285` 判 `borderB === 1`（不是 `<=1`）；`/` 入口 **47 通过 / 0 失败 / 0 未证，exit 0**（比签收时 +1），实际输出：
`PASS V2 分隔线 borderB=1px（outer=41 = 内容 40 + 1）`、`PASS V2 行内容高恰好 40px（23 行，极差 0；分隔线另计）`。

**② `test:library` 的 11/1 —— 我跑出来了，与它报的一致**

```
标题判定覆盖 35/95 份，不符 0
✗ 类型不变量①：标题判出来的类型必须与库里已标注的一致（0 条不符）
    标题覆盖太低（35/95），类型识别对真实数据不可用
真实库回归：11 通过 / 1 失败
```

**性质判定**：这不是"测试坏了"，而是**一条真的在说事的红** —— 98 份真实报告里只有 35 份能从标题判出类型（`不符 0` 说明判出来的都对，问题是**判不出来**）。它与 D-1 无关（本批 diff 未碰 `lib/**`、`server.mjs`；覆盖率是被真实库从 77 份长到 95 份拉低的 —— 数据变了，不是代码变了）。

**处置四条（我定，实现方照办）**：
1. **阈值不许下调**。30%→ 绿是拿判据换绿灯，是这几轮反复打回的那类操作；它这次没有下调，判断正确。
2. **不许跳过、不许 `--force`、不许把它从交付清单里删掉**。它必须在交付说明里**单列**为「已知红 + 原因 + 归属 + 再触发条件」。
3. **不能记进 D-1 的绿**。D-1 的绿只覆盖校对网格六项 + 三入口；这条红的归属是**报告类型识别（`lib/reportIntake` 一线）**，不是 UI/交互。
4. **治本方向（我建议，且要主理人分派而非我拍）**：`组合判定覆盖 50 份、不符 0` ⇒ 说明"标题 → 项目集"这条路能覆盖更多；优先把**标题关键字/组合回退**扩起来把覆盖提上去。**改分母口径（例如按"标题 ∪ 组合"算覆盖）不作为放宽手段**，若要用，必须单独书面说明"两种口径测的是不同东西"，并在同一份交付里同时给两个数。

**归类**：这条红**不阻塞 D-1 收口**（同批修改未触及其代码路径），但**我把它记成 D-2 之前要结的一条**，理由是"类型识别对真实数据不可用"是用户可感知的（60 份报告认不出类型），比任何 1px 都严重。

### 9.25 **又一处我的过度断言（同日第二次）：`35/95` 是"标题路径"覆盖，不是"认不出类型"**

我在 §9.24 对主理人写过「60 份报告认不出类型」「这条比任何 1px 都严重」。**这两句都要收回限定条件**：

核 `tests/verify-library.mjs` 的实际测量口径：
- `:133-140` 失败那条断言用的是 **`classifyByTitle(r.text)`** ⇒ 它量的是**标题路径**的覆盖（35/95），`不符 0` 说明标题判出来的都对；
- `:149` 组合判定用的是 **`classifyByTitle(...) || classifyByRows(r.rows, idx)`** ⇒ 覆盖 **50 份、不符 0**；
- `lib/reportTypeDetect.mjs` 在 `853cc84` 里已是「标题优先 → 项目集反推 → 正文兜底」三步机制 ⇒ **端到端**（含正文兜底）的真实覆盖**测试里没有一条断言在量**。

⇒ 正确的说法是：**标题路径覆盖 35/95，标题∪项目集覆盖 50/95；剩下 45 份有没有被正文兜底认出来，现有用例没有断言，我不能据此说"认不出类型"**。我把"标题覆盖率"当成了"类型识别可用性"，这是同一天第二次犯 §9.22 那个错（用不完整观察范围下全称结论）。

**规格侧的真正缺口（这条是新增判据，不是修正措辞）**：应该补一条**端到端类型覆盖**断言，与实现的三步机制对齐 ——

```js
// 端到端覆盖：标题 → 项目集反推 → 正文兜底，三者都认不出才算"认不出"
const got = classifyByTitle(t) || classifyByRows(r.rows, idx) || classifyByBody(t)   // 以实际导出名为准
// 断言：① 认出来的必须与库内标注一致（不符 0，已有精神不变）；② 认不出的份数不得增长（基线锁定，不许放宽）
assert.deepEqual(bad.slice(0,5), [], …)
assert.ok(unknown <= BASELINE_UNKNOWN, `认不出的份数 ${unknown} > 基线 ${BASELINE_UNKNOWN}`)
```

**红线不变**：**不许把 40% 下调**，也不许把标题断言删掉换成端到端 —— 两条**同时保留**（标题路径是用户最先看到的信号，端到端是真实可用性）。
**严重度修正**：这条红**仍应排进 D-2 之前**，但理由是"判据覆盖不全、真实可用性未被量过"，**不是**"60 份已确认认不出"。

### 9.26 端到端类型覆盖：我独立复算一致；**4 条不符是真缺陷，不设"泛类豁免"**（附我自己的分母口径错误）

实现方用只读方式把端到端覆盖量了一遍（不写库、不加断言、不进判据）。**我用自己写的只读脚本复算，四组数字与它逐一吻合**，且 `data/reports.json` 的 sha256 前后一致（`true`）：

| 路径 | 覆盖 | 不符 | 未认出 |
|---|---|---|---|
| A `classifyByTitle` | **35/95** | 0 | 60 |
| B `classifyByTitle \|\| classifyByRows`（全 95 口径） | **82/95** | 0 | 13 |
| B′ `verify-library:149` 口径（**仅 57 份有指标行**，`:147` 有 `continue`） | **50/57** | 0 | 7 |
| C **端到端** `detectReportType(text, rows, {rowIndex, bodyClassify: classifyReport})` | **95/95** | **4** | 0 |

4 条不符（我复算得到同样 4 个 id）：`rep_mwean71gtdu` 戊肝抗体→化验其他、`rep_mwean71oh37` 甲肝 IgM→化验其他、`rep_mwean7qjqxu` CT-血管增强→CT-胸部、`rep_mwefj3rjmjz` 融合基因→流式免疫分型，四条证据都是 `body-keyword`。

#### 我自己的口径错误（第三次自纠，照实记）

我上一轮写「组合判定覆盖 **50/95**」—— **分母错了**：测试 `:147` 对无指标行 `continue`，那个 50 的分母是 **57**；全 95 口径下是 **82/95**。两个数都在上表，**不许混用**。实现方指出得对。

#### 诊断（这是裁定"要不要给泛类豁免"的关键证据）

`lib/reportTypeDetect.mjs:83-84` **已有** `甲肝 IgM` / `戊肝抗体` 两个小类的关键词：
```
[/甲肝|甲型|HAV/i, '甲肝 IgM', 'lab'],
[/戊型|戊肝|HEV/i, '戊肝抗体', 'lab'],
```
但**正文兜底**用的 `lib/reportClassify.mjs` 走的是自己那份 `LAB_PANELS` 词表，**不含这两类** ⇒ 无指标行、标题也不命中的报告只能落到「化验其他」。
另两条是正文关键词打架，`reportClassify.mjs` 头部注释里就写着同类坑（流式要排在基因/骨髓之前、基因要排在 CT 之前、裸 CT 要排除 HCT/ACTB/CTCF）。

⇒ **这 4 条不是"天生不可再分"，是"两套词表不一致 + 正文关键词排序打架"，可修。**

#### 裁定：**不设"泛类降级"豁免**，把 4 条单独立账

理由两条：
1. **豁免边界由被测方自己定义**（谁说哪个是"泛类"？），一旦允许"降级到化验其他不算错"，**把所有指标类都降成化验其他就全绿** —— 这是空过家族最典型的形态。
2. 上节已证明这 4 条**有明确的修法**（统一词表 / 调正文关键词顺序），不是判据不可满足。

**端到端判据定稿**（`tests/verify-library.mjs` 新增一条，**与标题断言并存、两条都保留**）：
```js
// 端到端：标题 → 项目集反推 → 正文兜底；unknown 不算不符（铁律：判不出不硬猜），但不许增长
assert.deepEqual(bad.slice(0, 5), [], `端到端与库内标注不符：…`)
assert.ok(unknown <= BASELINE_UNKNOWN, `未认出 ${unknown} > 基线 ${BASELINE_UNKNOWN}`)
console.log(`       端到端覆盖 ${covered}/${reports.length}、不符 ${bad.length}、未认出 ${unknown}`)
```
**另加一条根因判据（防词表漂移）**：`reportTypeDetect` 与 `reportClassify` 的 reportType 词表必须**同一份导出常量**，两边引用；否则加断言比对两个集合的差集。
**红线不变**：40% 不下调；标题断言不许删。

**严重度**：这 4 条**是用户可感知的错判**（4 份报告在库里被标错类型），比"覆盖率低"更实 —— 建议与 D-2 并行、由主理人分派到报告识别一线，不进 D-1 绿、不进 UI 范围。

### 9.27 只读探针 `cb95641` 我跑过；给 4 条台账钉一条「真相源优先级」，防止靠猜结案

**我复核**：`git show --stat cb95641` = `2 files changed, 147 insertions(+)`（`.agents/bugs.md` + `tools/type-coverage-report.mjs`），**未碰 `lib/**`、`server.mjs`**；我本机跑 `node tools/type-coverage-report.mjs` → A `35/95`、B `82/95`、B′ `50/57`、C `95/95 不符 4`，末行 `只读自证：报告库 sha256 前后一致 ✓`，**`EXIT=1`**（C 有不符就非 0，不假绿）；跑完 `git status` 无新增文件 ⇒ 只读属实。

**我加一条裁定（台账口径，防止用猜的把它结掉）**：判断"库标注错"还是"词表/序错"，**真相源优先级固定为**：
1. **原件抬头/送检项目**（报告 PDF 上写的那一行）；
2. 库内标注 `reportType`（是人工/历史口径，但**不是真源**）；
3. 正文关键词（`reportClassify` 的排序，是最弱的一环）。

⇒ 例如 `rep_mwefj3rjmjz`（融合基因 vs 流式免疫分型）：**拿原件抬头核**。抬头写"融合基因检测/基因突变" ⇒ 库标注对、要调 `reportClassify:94-102` 的**序**（流式不该抢在基因前）；抬头是流式报告 ⇒ **库标注错**，改标注而不是改代码。
**禁止**用"哪个先命中就算哪个"来结案 —— 那是把实现当真相源。

**退出码契约（写进台账，别让人"修绿"）**：`C 有不符 = 1`、库读不到 = 2、全绿 = 0。**禁止**为了让它变绿去放宽 C 的判据或改 `unknown` 基线。

### 9.28 D-2 四前提**已定**（2026-11-17，主理人授权「按设计规范由你选」——不再挂"待拍板"）

四条我都按团队 `~/.agents/ui-design-standard.md` 的既有铁律裁了，不是按个人偏好，每条都写清「依据哪条规范 + 可复跑证据 + 回退成本」。

| # | 问题（用户视角） | **裁定** | 依据 | 回退成本 |
|---|---|---|---|---|
| ① | 鼠标划过卡片时那圈**淡青光晕**（3px `rgba(13,148,136,.1)`）要不要留 | **关掉——但只关 MedBrief 自己页面里的 `.card`**，改法是一条作用域 CSS（`.mb-review-grid .card::after { display:none }` 已存在，扩到本批新容器）；**h**over 反馈保留"边框变色"这一层 | 规范 §3「语义色/装饰」与三态要求：装饰性动效不得干扰阅读；数据密集页里整块卡片被照亮会让人误判"选中了"。**不碰跨项目真源 `meddata/src/index.css:16-39`**（那是 MedData 的定义，`/meddata` 是独立工具页，不属本项目界面语言） | 删一条 CSS |
| ② | 手机上表格要横着拉才能看，**要不要改成一张一张的卡片** | **要**：`<768px` 卡片态；`768–1023px` 两行栅格（列序同表格、标签进 sticky 表头） | 用户原话「要做窄屏适配…重新设计窄屏样式，尽量实现原有功能」；实测 375 下容器 `760/275` ⇒ 必须横拉 485px 才看得到"结果"列，属功能不可用而非不好看 | 保留旧 CSS 注入即回退 |
| ③ | 两个入口用的是**两套底层样式**（一套有全局重置、一套没有），要不要统一 | **只补两条最小规则**：`*,::before,::after { box-sizing: border-box }` + 控件 `border-style: solid`（等效 preflight 的这两条），**不整份引入 preflight** | A2 实测病灶正是这两条缺失（`embedded.css` `border-style` 仅 1 处、`box-sizing` 0 处 ⇒ input `inset`/button `outset` 的"描边不均匀"）。整份 preflight 会改全局 margin/字号，影响面不可控 | 两条规则，删掉即回退 |
| ④ | 表格每行之间那条**淡灰细线**（1px `#f1f5f9`）留不留 | **留** | 两管线同形（改前 `/meddata` 有线、`/` 没有）；`#f1f5f9` 是既有 `--g-divider` 值，未引入新色；行距口径已定「内容 40 + 线 1 = 外框 41」并已进 V2 断言 | 删 `index.css:214` 的 `border-bottom` 半句 |

**执行顺序**：① 先做（1 条 CSS、零风险）→ ③（编译产物层面，影响全部控件）→ ②（最大件，出 D-2 数值规格后再动）→ ④ 已完成（D-1 内）。

**D-2 开工前提已全部满足**：本表 ①②③ 均已定，④ 已完成；剩下只等数值规格（UI 出）与实现方排期。**不允许再出现"等用户拍板"** —— 主理人已把选择权交给我。
