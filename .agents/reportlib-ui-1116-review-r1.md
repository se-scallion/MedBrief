# 《报告库列表 UI 整改》v0.1 · 独立 AI 审核（第 1 轮）

> 对象：`MedBrief/.agents/reportlib-ui-1116-plan.md`（v0.1）｜输入：`reportlib-ui-1116-review-input.md`
> 只读取证：未改计划、未改生产代码。复跑命令见文末。

## 总判：**不能直接进下一轮** —— 2 条 P0（触屏无入口「超长处理」落空 / 分组日期真值没写死）+ 4 条 P1

方向与选型基本对（`List`+`Badge`+`dayjs`，砍 `Calendar/Timeline` 有依据；一天最多 8 份的取证准确）。卡在两处：**用户第一条需求（文字超长）在手机上实际没有可读入口**，以及**「按天分组」的日期键没写死真值口径**（`dayjs(undefined)` 实测 = **今天**）。

---

## 一、6 个攻击点逐条回答

### ① `List` 做「按天 section」会不会又变一张表？Collapse 砍得够不够？

**能做，但必须显式关掉 List 的「扁平行」默认形态**：`List` 默认会给每个 item 加边框/内边距 + `split` 分隔线，`dataSource` 若是「天数组」，渲染出来就是**一堆等高横条**（= 又一张表）。
改法（写进 D1/D2）：`dataSource = [{day, items}]` + `renderItem` 自绘 section 容器 + `split={false}` + `bordered={false}`；section 头用 `Badge count={n}` + 自定义 `<div className="rb-day-h">`，`Divider` 只在 section 之间用一次。
**「Collapse 砍掉」理由不够硬**（现理由「多一次点击且默认态难控」——默认 `activeKey` 全开会话可控）。换成能站住的三条：① 用户要的是「**每天一个小模块**」= 平铺可见，折叠与语义相反；② Collapse 的展开动画在 ≤575 会撑高首屏、且 `motion` 与 375 断言（de=375）互相干扰；③ 折叠后「一天 8 份」的信息密度反而不如平铺。→ 砍可以，**理由要换成这三条**（P2）。

### ② 「日期未识别」组会不会变成 `Invalid Date` / 1970 / **今天**？

**会，而且有一个比 Invalid 更危险的坑**。我实测 `dayjs`：
```
dayjs('')        => INVALID
dayjs(null)      => INVALID
dayjs(undefined) => 2026-11-16   ← 今天！
```
即：只要代码写成 `dayjs(r.reportDate)` 且字段是 `undefined`，这条报告会被**静默归到「今天」**——伪造临床日期，比 1970 更糟。
再叠加 `reportSort.js:13` 的 `dateKeyOf = reportDate || createdAt`：**分组若复用 `dateKeyOf`，那条 1 份空日期的报告会被折进它的入库日**，R3/F4 就白写了。
**必须写死**（D1/D2）：分组键用 `String(r.reportDate||'').slice(0,10)`（**不许用 `dateKeyOf`**），空串单独一组；头部文案「日期未识别 · 按入库时间」。
**可复跑断言**：`当前库 66 份 → 27 个真实日期组 + 1 个「未识别」组 = 28 组`，未识别组**恰好 1 条**；所有组头 `!/(Invalid|1970|NaN)/`；且**没有任何组头的日期等于「今天」**（除非库里有该日期的报告）。附：计划 0 段写「28 个不同日期」不准 —— 实际是 **27 个真实日期 + 1 个未识别组**（P2 订正）。

### ③ 桌面图标按钮是否超出用户范围 / 与「⑥ 桌面一行不动」矛盾？

**与 ⑥ 自相矛盾，必须改措辞**：C⑥ 写「桌面 ≥576 保持现有 Table 八列与列头排序 / **一行不动**」，D3 又写「只把操作列文字按钮换成同款图标按钮 + 删除受管理开关」——两句直接冲突（P1-1）。
判定：用户原话「操作按钮最好有大小显示，不要用文字按钮」**没有限定移动端**，桌面同步换是合理延伸；真正要守的是「**列结构 + 三态排序**不动」。→ 把 ⑥ 改成「桌面**列与排序**不动，仅操作列按钮形态与删除显隐变化」，并在 F8 的验收里加一条「1440 下 8 列表头与排序箭头仍在」。

### ④ 管理态 + `Popconfirm`；回收站入口会不会找不到？

- **管理态下删除仍要二次确认**（软删也会让卡片少一份数据）→ 保留 `Popconfirm` 包图标（D1 已写 ✅）。建议再加两条：删除图标置**最右**、`danger` 色，避免与「查看」相邻误触；`aria-label="删除"`。
- **回收站 tab 的「恢复/彻底删除」不受管理开关影响**（R5/D1 ✅）——这是对的（回收站本身就是管理场景），但**要补状态机规则**：**切到回收站 tab 时自动退出管理态**，否则会出现「在回收站里还能看到『管理』字样」的误导；且回收站里「彻底删除」是**不可恢复**动作，**始终要 Popconfirm**（现有实现已有 ✅，别在改造中丢）。
- 断言：`tab=trash` 时「恢复/彻底删除」恒可见（0/1 与开关无关）；；切 tab 后 `manage=false`。

### ⑤ 次行 Tag 会不会挤成一团？长 `reportType` 的 Tooltip 手机能点吗？

**会挤；而且 Tooltip 在触屏是死路（这才是 P0）**。现有窄屏已有 3 类标记：`推断`（`:269`）、`全文`（`:303`）、`无原件`（`:329`），再加「单号尾号」= 次行 4 个元素，375 下必然换行/溢出。
- 次行**最多 2 个标记**，优先级：`推断` > `无原件` > `全文`；单号只在有值时显示「尾号 4 位」；Tag 统一 `bordered={false}` + `fontSize:11`。
- **`ellipsis + Tooltip` 不能作为超长类型的唯一手段**：`Tooltip` 靠 hover，手机上无法触发 → 用户第一条「文字超长处理」在手机上是**没有出口**的。必须补一条真入口：**整行可点打开详情抽屉**（抽屉里 `Descriptions` 有完整 `reportType`），或长按/点击类型文本弹出全称。
- 断言：375 下每行次行 ≤ 2 个标记；`scrollWidth === clientWidth`；**长类型（用真实「骨髓形态学（骨穿）」作样本）点一下能看到全称**（不依赖 hover）。

### ⑥ `Segmented` 替代列头排序，等价吗？搜索口径要改吗？

**不等价，必须写明降级 + 用同一套比较函数**。`nextSort`（`reportSort.js:55`）是三态（升→降→取消回默认日期降），`Segmented` 只能表达「按哪一列」；`sortReports` 的「缺值恒末位」（`:47`）与 `localeCompare(...,'zh-Hans-CN')`（`:50`）必须**继续走同一个函数**，不许在 List 里另写比较器。
- 建议：xs 用 `Segmented`（日期 / 类型 / 单号）+ **再点同一项切升降**（两态），并在默认态 = 日期降序（与现在一致）。
- 断言（golden 对比）：xs 上「按类型升/降」两次点击后的 id 序列，与桌面点「类型」列头两次的结果**逐 id 相同**；空日期那条在两处都恒在末位。
- 搜索口径：现有 `kw` 匹配含 `hospital`（`:232`），列表不再显示医院后仍匹配医院名 → 「搜得到但看不出来为什么命中」。**建议保留匹配**（用户可能按医院找），但在占位符/无结果文案里写明可搜字段（医院/日期/类型/单号），别悄悄改口径。

## 二、CSS 注入（附问）

**不要塞进 `APP_MOBILE_CSS`**。`web/src/App.jsx:25-40` 注释写明它是「**单一 owner**、App 挂载期注入、卸载移除」；往里加报告库样式 = 把页面样式耦合进全局，且全局样式无法随页面卸载撤销。
**正确做法**：沿用 `ReportsPanel.jsx:99-102` 已有的页面级模式（`useEffect` + `document.createElement('style')` + **新 id `#mb-report-day-mobile`** + cleanup `style.remove()`），选择器一律加前缀 `.rb-day-*`；媒体查询仍限 `≤575px`。
**与 `577c07a` 的 `#mb-report-drawer-mobile` 不冲突**（不同 id、不同选择器前缀、都在页面级 useEffect）。
断言：375 下 head 里同时存在 2 段页面级 style（drawer + day）且无重复 id；卸载页面后两段都被移除；**不许出现第三份全局注入**。

## 三、必改清单（按执行顺序）

### P0（不改不能进下一轮）

| # | 必改 | 指向 | 证据 |
|---|---|---|---|
| P0-1 | **超长类型在触屏必须有真入口**：不得只靠 `ellipsis+Tooltip`；整行可点开抽屉（内含完整 `reportType`）或点击弹全称；次行标记压到 ≤2 个并定优先级 | D2 / ⑤ / C⑧ | `Tooltip` 仅 hover；现有 3 类标记 `:269/:303/:329`；`ReportsPanel.jsx:444-458` 抽屉已有完整字段 |
| P0-2 | **分组日期键写死真值口径**：用 `String(r.reportDate\|\|'').slice(0,10)`，**禁用 `dateKeyOf`**（它会退回 createdAt）；空 → 独立「未识别」组；配断言（28 组 / 未识别组恰 1 条 / 无 Invalid·1970·今天） | D1/D2 / R3·F4 / ② | 实测 `dayjs(undefined)=今天`；`reportSort.js:13`；真实库 66 份 / 27 个真实日期 / 1 条空日期（有 createdAt） |

### P1（同轮补齐）

| # | 必改 | 指向 |
|---|---|---|
| P1-1 | 改掉 C⑥ 与 D3 的**自相矛盾**：⑥ 从「桌面一行不动」改为「桌面列与排序不动，仅操作列按钮形态 + 删除显隐变化」，并加 1440 断言 | ③ / C⑥ vs D3 |
| P1-2 | **分页/计数回退要交代**：现有 `Table` 有 `pagination pageSize 20 + 共 N 份`（`:430`），换 `List` 后未提 → 需写明「是否保留分页 / 首屏条数 / 总数显示」，否则 66 份一次渲染且丢掉计数 | D2 |
| P1-3 | **排序降级写明**：xs `Segmented` 两态（同项切换升降），比较仍走 `sortReports`；补 golden 断言（xs 两次点击 == 桌面两次列头，逐 id 相同） | ⑥ / R4 |
| P1-4 | **管理态状态机**：切到 `trash` tab 自动退出管理态；回收站两按钮恒可见且「彻底删除」保留 `Popconfirm`；断言 `tab=trash` 与开关无关 | ④ / R5 |

### P2（顺手）

| # | 必改 | 证据 |
|---|---|---|
| P2-1 | 「28 个不同日期」改成「27 个真实日期 + 1 个未识别组」 | `node -e` 统计 |
| P2-2 | `Collapse` 砍掉的**理由**换成「语义相反 + 动画干扰 375 断言 + 信息密度」三条 | ① |
| P2-3 | 搜索占位符/无结果文案写明可搜字段（含医院），保留现有匹配口径不要偷偷缩减 | `:232`、`:408` |
| P2-4 | 删除图标置最右 + `danger` + `aria-label`，不与「查看」相邻 | ④ |

## 四、复跑命令

```bash
cd /Users/scallion/Documents/projects/MedBrief
sed -n '225,370p' web/src/pages/intake/ReportsPanel.jsx   # 列 + 文字按钮 + 次行标记位置
sed -n '400,432p' web/src/pages/intake/ReportsPanel.jsx   # Table + pageSize 20 + 搜索框
sed -n '96,104p'  web/src/pages/intake/ReportsPanel.jsx   # 页面级 style 注入范式（#mb-report-drawer-mobile）
sed -n '25,40p;112,120p' web/src/App.jsx                  # APP_MOBILE_CSS 是全局单一 owner + 卸载移除
grep -n "dateKeyOf\|localeCompare\|缺值恒末位\|nextSort" web/src/pages/intake/reportSort.js
node -e "const d=require('dayjs');for(const v of ['',null,undefined]){const x=d(v);console.log(JSON.stringify(v),x.isValid()?x.format('YYYY-MM-DD'):'INVALID')}"
node -e "const j=require('./data/reports.json');const by={};let e=0;for(const r of j.reports){const k=String(r.reportDate||'').slice(0,10);if(!k){e++;continue}by[k]=(by[k]||0)+1};console.log('总',j.reports.length,'真实日期组',Object.keys(by).length,'空日期',e)"
node -e "const a=require('antd');console.log(a.version,!!a.List,!!a.Badge,!!a.Segmented,!!a.Calendar,!!a.Timeline)"
```
