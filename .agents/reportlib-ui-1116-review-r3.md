# 《报告库列表 UI 整改》v0.3 · 独立 AI 审核（第 3 轮 · 终轮）

> 对象：`MedBrief/.agents/reportlib-ui-1116-plan.md`（v0.3）｜上轮：`-review-r2.md`｜输入：`-review-input-r3.md`
> 只读取证：未改计划、未改生产代码。复跑命令见文末。

## 总判：**可以开工**（附 4 条执行层处方 + 2 处断言残留必须同批订正）

r2 的 2 条 P0 / 5 个复核 / 2 条 P1 全部闭环；剩下的都是「编码时照这个写法」级别的细节，没有数据或回退风险。

---

## 一、r2 逐条闭环核对

| r2 编号 | v0.3 落点 | 判 |
|---|---|---|
| **P0-1 分页三规则互斥** | D2：改按**日期组**分页（N=7 组/页、组永不跨页、组头每页一次）；断言 `⌈组数/N⌉` + `Σ页内记录=总数` | ✅ 闭环（执行层写法见二·①） |
| **P0-2 「全文」被挤掉** | D2：分层 —— `推断`→类型小上标、`无原件`→图标位、`全文型` **恒保留 Tag** | ✅ 闭环（语义细节见二·③） |
| 复核① 删除冒泡/嵌套交互 | 行点击只挂主行真实 `<button>` + 操作区 `stopPropagation` + 4 条断言 | ✅ 闭环 |
| 复核② 搜医院命中不可见 | 全字段匹配不变、谓词行号订正 `:215-218`、命中非显示字段时次行加「命中：医院 = X」 | ✅ 闭环 |
| 复核③ 管理态 | `manageOn = manage && tab==='active'`，回收站不渲染 | ✅ 闭环（断言里还有旧说法，见坑 5） |
| P1 断言不写快照 | 分页断言已改算式 | ⚠️ **半闭环**：D4 仍有「27 真实日期组 + 1 未识别组 = 28 组」快照（坑 4） |
| P1 同次提交/错峰 | D4：`ReportDayList.jsx` 与列表段替换同一次提交；与 v0.6 第 1 段错峰 | ✅ 闭环 |

**v0.3 新自相矛盾**：无结构性矛盾；只有上述两处**断言与正文不同步**（D4 `:181` 的「切回收站自动退出管理态」 vs 正文「不渲染」；D4 `:178` 的组数快照 vs r2 P1）。

## 二、4 个特别复核点

### ① 按组分页怎么接 antd —— 这里有个**必踩的坑：`showTotal` 的入参是「组数」**

换成 `List` 后没有 Table 自带分页，必须**受控 `Pagination` + 自己 slice 组**，且注意 antd 的 `total` 决定页数、`showTotal(total)` 直接拿到的是那个 `total`（= 组数 28），默认渲染出来是「共 28 条」，与「共 N 份」不符。
**写死这个执行层（不写清就会「文档说按组、代码按记录」）**：
```jsx
const groups = useMemo(() => groupByReportDate(hit), [hit])         // 键：String(r.reportDate||'').slice(0,10)，空→未识别组
const N = 7
const [page, setPage] = useState(1)
const pageCount = Math.ceil(groups.length / N)                       // 28 组 → 4 页
useEffect(() => { setPage(1) }, [q, sort])                           // ← 关键：搜索/排序变化必须回第 1 页
const shown = groups.slice((page - 1) * N, page * N)                 // 按组切，组永不跨页
<List split={false} dataSource={shown} renderItem={renderDaySection} />
<Pagination current={page} pageSize={N} total={groups.length} showSizeChanger={false}
            onChange={setPage} showTotal={() => `共 ${reports.length} 份 · ${groups.length} 天`} />
```
**为什么必须 `useEffect(setPage(1))`**：`Table` 之前分页是内部状态、搜索后自动回到合理页；改成受控后若停在「共 4 页」的第 4 页再搜出 2 条 → **空白页**（用户会以为没结果）。
断言：页数 == `Math.ceil(组数/N)`；每页组数 ≤ N；`Σ 各页记录 = 总数`；**翻页后不出现同一天两个组头**；**改搜索词/改排序后 current=1 且不是空页**。

### ② 375 行密度：会不会因为「主行+次行+上标/图标」把一天 8 份撑太长？—— 给可测阈值

按现有首屏预算算（实测口径：812 高 − 顶栏 77 − tab/toolbar ≈72 − 搜索行 ≈40 = **约 623px 可用**）：
- 行高 **52px** 时：一天 8 份 = `8×52 + 组头 32 = 448px` → 一首屏能完整看完**一整天**（448 ≤ 623）✅
- 行高 64px 时：`8×64+32 = 544px` → 仍能看到整天，但第二天的组头就挤到屏外；
→ **判据（写进 verify-report-lib-ui.mjs）**：
  1. 每行 `getBoundingClientRect().height ≤ 52`（375 下逐行量，超了说明分层没落地）；
  2. 「一天 8 份」的 section 总高 **≤ 480px**；
  3. 首屏必须完整可见「≥1 个组头 + 该组前 3 行」（滚动前）；
  4. 行内文本 `scrollHeight ≤ clientHeight`（**不允许任何行被压成 2 行**）；
  5. 例外：`kw` 命中非显示字段时那行允许 +16px（「命中：医院 = X」是临时态，不是常驻）。

### ③ `<button>` 里再放 Tag 算不算嵌套交互？—— 会，按这条拆

- HTML 层面 `<button>` 只能放 phrasing content，antd `<Tag>` 渲染成 `<span>` **本身合法**；但 `Tag` 一旦 `closable`（内部有 `<button>`）或外面包 `Tooltip`（会加 `tabindex`/`aria-describedby`），就变成**嵌套交互元素**，且会把「全文型/无原件」这些次行文案混进主行按钮的**可访问名**——屏幕阅读器会把它读成「骨髓形态学（骨穿）全文型无原件 按钮」。
- **处方**：主行 `<button>` 内**只放纯文本 + `<sup aria-hidden="true">?</sup>`**（推断标记）；`全文型` Tag 与 `无原件` 图标放**次行**，不进 button；`aria-label` 只写「检查类型 + 是否已入库」。
- **断言要写成能红的（别空转）**：
  1. `await page.locator('button button').count() === 0`（无嵌套按钮）；
  2. 主行 button 的 `accessible name` **包含**完整 `reportType`、**不包含**「全文型」「无原件」「推断」；
  3. 主行内不存在 `[role="button"]` 后代；`sup` 上有 `aria-hidden="true"`；
  4. 键盘 Tab 到主行 → `Enter` 打开抽屉；Tab 到删除 → `Enter` 弹 Popconfirm 而**不**开抽屉。

### ④ 两段页面级 style 并存 —— 现在这个写法是对的，别改坏

现有 `ReportsPanel.jsx:99-104` 已经是安全范式：`useEffect(()=>{ create → `style.id='mb-report-drawer-mobile'` → appendChild; return () => style.remove() },[])` —— **按捕获引用清理**，不会误删别人的节点；且 CSS 内部自带 `@media (max-width: 575px)`（`:46-47`），所以桌面注入也无害。
**落地写法（照抄这套，别合并、别用选择器清理）**：
```jsx
useEffect(() => {                                  // 抽屉样式（已有，不动）
  const s = document.createElement('style'); s.id = 'mb-report-drawer-mobile'
  s.textContent = REPORT_DRAWER_MOBILE_CSS; document.head.appendChild(s)
  return () => { s.remove() }
}, [])
useEffect(() => {                                  // 新：按天列表样式（独立 effect、独立 id）
  const s = document.createElement('style'); s.id = 'mb-report-day-mobile'
  s.textContent = REPORT_DAY_MOBILE_CSS; document.head.appendChild(s)
  return () => { s.remove() }
}, [])
```
**三条禁令**：① 不许把两段 CSS 拼进同一个 `<style>`（改一处会动到另一处）；② 不许用 `querySelectorAll('style[id^="mb-report-"]').forEach(remove)` 清理（互删）；③ **不要**给 effect 加 `isXs` 依赖（断点抖动会反复注入/移除；两段 CSS 都靠内部媒体查询自限）。
断言：375 下 `document.querySelectorAll('style[id^="mb-report-"]').length === 2` 且 id 恰为那两个；离开页面后 **0**；**进出 3 次仍为 2**（不累加）。

## 三、编码阶段顺手避开的坑（含 2 处必须同批订正的残留）

1. **`showTotal` 覆盖**：`Pagination` 的 `total` 传组数、`showTotal` 忽略入参印「共 X 份 · Y 天」，否则文案会印组数（见二·①）。
2. **搜索/排序变化 `setPage(1)`**：否则会出现空白页（Table 时代由组件内部兜住的，换受控后要自己兜）。
3. **行高预算**：把「行高 ≤52px / 8 份 section ≤480px / 无 2 行文本」写进断言（见二·②），否则分层标记会让 375 悄悄变长。
4. **断言去快照（r2 P1 的残留）**：D4 现仍写「27 真实日期组 + 1 未识别组 = 28 组」→ 改成算式：`组数 == new Set(非空 reportDate).size + (存在空日期 ? 1 : 0)`，未识别组条数 == 库内 `reportDate` 为空的条数。
5. **管理态断言与正文对齐**：D4 `:181` 仍写「切回收站自动退出管理态」→ 改成「回收站 tab 下管理控件数 == 0、恢复/彻底删除恒可见」（正文已是不渲染方案，断言要跟上）。
6. **`List` 的 `split={false}` + 自绘 section**、`Divider` 只在组间用一次（否则又是横条表）。
7. **桌面图标化后同步 `verify-ui.mjs` 的定位**：现有断言若按文字（`getByText('编辑')`）会红 → 改用 `aria-label`/`data-testid`。
8. **提交纪律**：`ReportDayList.jsx` 与列表段替换**同一次提交**，不留「新组件在、旧 Table 也在」的中间态；与 v0.6 第 1 段错峰（v0.6 只改 import，本计划一次改完列表段）。

## 四、复跑命令

```bash
cd /Users/scallion/Documents/projects/MedBrief
sed -n '96,104p' web/src/pages/intake/ReportsPanel.jsx      # 页面级 style 范式（按引用 cleanup）+ CSS 自带媒体查询
grep -n "const kw = q.trim()" -A 3 web/src/pages/intake/ReportsPanel.jsx   # 搜索谓词 :215-218
sed -n '296,305p' web/src/pages/intake/ReportsPanel.jsx     # 「全文」vs「0 项」教训原文
sed -n '178,182p' .agents/reportlib-ui-1116-plan.md         # 两处断言残留（组数快照 / 切 tab 退出管理态）
node -e "const j=require('./data/reports.json');const s=new Set();let e=0;for(const r of j.reports){const d=String(r.reportDate||'').slice(0,10);if(!d){e++;continue}s.add(d)}const g=s.size+(e?1:0);console.log('记录',j.reports.length,'日期组',s.size,'空',e,'组数',g,'N=7→页数',Math.ceil(g/7),'首屏可用',812-77-72-40,'8份@52行高',8*52+32)"
grep -n "getByText\|getByRole" tests/verify-ui.mjs | head      # 桌面文字按钮断言（坑 7）
```
