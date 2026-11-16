# ① 批量导入模块交互重构 · 独立审核 r1（plan-review §8.3）

> 审核者：代诊-报告（独立审核者，只读）。被审：`.agents/batch-import-1116-plan.md` **v0.1**；本轮输入 `.agents/batch-import-1116-review-input.md`（8 条必攻击点）。
> 我未改计划、未改代码、未提交、未动 `data/reports.json`、未碰 5174。所有结论指到 `文件:行` 或 §5 的可复跑命令。
> 本线**不并进**：`test:library` 覆盖率红（归报告识别一线）、`intake-dedupe-1116`（报告库删除线）——只在该交叉处点名。

---

## 0. 总判：**只准哪几条**

**准予开工（C-1 / C-2 / C-3 / C-4 / C-8 / C-13，纯前端、零后端）**
**准予但附 1 条必改（C-5 导入即查重、C-7 下方固定栏）**
**挂起（C-9 多张拼接）**
**同意砍（C-6 / C-10 / C-11）、同意延后（C-12）**

| 编号 | 判 | 一句话理由 |
|---|---|---|
| C-1 Checkbox 取代「选/已选」 | **准予** | 现状 `UploadPanel.jsx:104-110` 确认是文字按钮；纯呈现层 |
| C-2 删除改 Icon | **准予** | 但**不许用 danger 红**（见 P1-4：这里是"移除未入库条目"，不是删库） |
| C-3 撤掉每卡整行「识别」 | **准予** | `UploadPanel.jsx:119-121` 确认每卡一个 block 按钮；与顶部「一键识别全部」(`:29-33`) 确实两层 |
| C-4 只在 done/failed 出「重新识别/重试」 | **准予**（并订正事实） | **不是新增**：现在按钮文案已是 `item.status === 'done' ? '重新识别' : '识别'`（`:120`）⇒ 本题实际是"收紧为条件渲染 + failed 补「重试」" |
| C-5 导入即提示「同一文件已导入过」 | **准予 + P0-1 必改** | R4 的能力边界成立；但**只查库、不查本批**，恰好漏掉用户最可能的场景 |
| C-6 识别与导入合并 | **砍，同意** | 见 §3-3，理由成立且更硬：合并等于取消人工校对这一医疗门槛 |
| C-7 下方浮动固定栏 | **准予 + P0-3 必改** | 需要先清掉顶部两个冗余入口，否则入口从 2 个变 3 个，比现状更乱 |
| C-8 按钮随选中态渐进出现 | **准予** | 与 N6/N7 直接对应，纯条件渲染 |
| C-9 多张（>2）拼接 | **挂起** | 服务端**无数量/尺寸护栏**（P1-5），4 张手机图有 OOM/超时风险；需一条实测再放行 |
| C-10 dHash 预检 | **砍，同意** | `lib/reportIntake.mjs:113-120` 的实测反例成立；`docs/导入工作流.md:33` 也写明「不用 dHash 单独判重」 |
| C-11 三个 Tag 搬进固定栏 | **砍，同意** | 卡片上已有状态 Tag；栏内只放动作是对的 |
| C-12 卡片横向紧凑布局 | **延后，同意** | 触发条件（C-1~C-3 落地后 375 一屏 <2 张）可观测，写法合格 |
| C-13 「更多」收「清空勾选」 | **准予** | 只收 1 项，克制 |

**耦合判定（§8.3 三不同）**：准予项集中在 `UploadPanel.jsx` + `IntakePage.jsx`（+ 可能 `shared.js`），与在途的 `intake-dedupe-1116`（`server.mjs` + `ReportsPanel.jsx` + `ReportDayList.jsx`）**不同文件**；与 `grid-narrow-1116`（`meddata/**`）不同目录。C-5 若要"批内查重"也不需要新端点（纯前端），故不与 `server.mjs` 争用。**不必串行；但 C-7 的固定栏与 `intake-dedupe` 的报告库删除按钮无交集**（不同页面：`/`(intake) vs `/reports`）。

---

## 1. P0 —— 三条，任一不改都不能进下一轮

### P0-1 C-5 只查「库」不查「本批」，恰好漏掉用户最可能的重复

`addFiles()`（`IntakePage.jsx:153-183`）对每个文件**无条件** push 一个 item，没有任何去重；粘贴路径也走同一函数（`:198-206`）。所以：

- 同一次拖入里把**同一张图选两次**（或既拖入又 ⌘V 粘贴一次）⇒ 两条 item、两个 `uid()`、都进 `items`；
- D-1 第 5 条的预检是「与 `loadReports()` 已加载清单的 sha256 集合对表」——**此时库里还没有它**，所以**两条都判"不重复"**，两条都显示正常卡片；
- 直到入库时服务端才拦第二条（`server.mjs:1683`），且批量路径是 `silent:true` ⇒ 只得到一句汇总「N 张疑似重复已跳过」（`IntakePage.jsx:523`）。

**这正是用户说的"我在导入过程中误操作了、重复导入"**——同批内的重复，不是"隔天又导了一次"。

**必改**（写进 D-1 第 5 条）：
1. 预检**两路**：① 与库内 sha256 集合比（现有设计）；② **与本批已有 item 的 sha256 比**（`Map<sha256, itemId>`，随 `addFiles` 增量维护）。两路命中都要打 Tag，但文案要能区分「本批内重复（这份文件本批已选过一次）」与「库里已有（上次已导入）」。
2. 判定为"本批内重复"时**不新增第二张卡**（直接跳过并提示），或新增但立刻标红并要求用户二选一——两种都可，必须选一个并写死，别留给实现方自由发挥。
3. 降级（算不了 sha256 时，见 P0-2）**至少保留"文件名+大小"的批内粗筛**：同一批里 `name+size` 完全相同几乎一定是误选两次——这条**零成本且不依赖 crypto**，能在手机上兜住最常见场景（但它只能用于"批内"，绝不能用于"对库"，因为库不存文件名）。

### P0-2 R10 不是「待取证」，是**必然** —— 手机端一定算不了 sha256，而计划的降级路径会主动放弃唯一能兑现 N3 的场景

- `server.mjs:1808` `server.listen(PORT, '0.0.0.0')` ⇒ 手机**只能**通过 `http://<局域网IP>:5174` 访问，不可能用 `127.0.0.1`。
- `crypto.subtle` 只在**安全上下文**（`https:` / `localhost` / `127.0.0.1` / `file:`）存在 ⇒ 手机端 `window.isSecureContext === false`、`crypto.subtle` 为 `undefined`。这不是"可能"，是规范推出的必然，**不需要真机取证就能定案**。
- 于是 D-3 第 4 条的三选一里，(a)「接受这种环境下不预检」意味着**手机端 C-5 完全不可用**，而"批量导入"的主场恰恰是手机（用户原话就是移动端固定操作区）。

**必改**：
1. R10 从 `[未取证]` 改成**已定案**，并写明依据（`listen 0.0.0.0` + 安全上下文规范），别把"待测"留给实现方当借口。
2. 降级方案**增加第 (d) 条并推荐它**：内置一个 **~40 行纯 JS SHA-256**（无依赖），`crypto.subtle` 可用时用原生、不可用时用纯 JS；配一条对拍断言（`sha256Hex('abc')` 与 node `crypto` 结果相等）放进测试。这样**两端行为一致**，不再需要"这个端不查重"的降级文案。
3. 若仍选 (a)，则必须在该端 UI 上**显式显示「本端未做文件查重」**（不许静默），且 P0-1 的"文件名+大小批内粗筛"必须保留——否则手机端等于什么都没做。
4. 明确删掉 (c)「按文件名粗筛对库」：库内**没有文件名**（`sourceFile` 是归档路径、`imageRef` 是 `sha256:`），这条路不通。

### P0-3 新增固定栏之前，必须先拆掉顶部两个冗余入口，否则入口从 2 个变 3 个

现状顶部已有：`UploadPanel.jsx:29-33`「一键识别全部（N）」、`:56-63`「已勾选 N/2 + 拼接选中的两张 + 清空勾选」。D-1 第 3 条要在下方固定栏重现「一键识别/一键导入/拼接/移除」，但**没有一条说要删掉顶部这两处**——只有 C-13 把「清空勾选」收进「更多」。

结果会是：同一动作在**顶部一份、底部一份、每卡一份（若 C-3 没删净）**，与 N7「隐藏无关按钮」正好相反。

**必改**（写进 D-1）：
1. 固定栏落地时**同批删除** `UploadPanel.jsx:56-63` 整行（拼接/勾选文案/清空），以及 `:29-33` 的「一键识别全部」（改由固定栏承载）。若保留顶部按钮，必须给出"两处各自何时用"的书面理由，否则就是冗余。
2. 固定栏出现的条件写死：`items.length > 0`（没有文件时不出现空栏）。
3. 与 ② 的关系：`sec === 'review'` 时**隐藏固定栏**（复用现有 `IntersectionObserver`，`IntakePage.jsx:126-140`），而 **② 自己的「一键导入全部」保持不动**（`ReviewPanel.jsx:22-25`）——这样隐藏后入口不丢，也解决 F4 的遮挡。
4. 补一条：固定栏**只在 `sec === 'upload'` 段出现**，且 ① 段内容容器补 `padding-bottom = 栏高 + 安全区`，否则最后一张卡的按钮会被压住。

---

## 2. P1 —— 准予项开工前要补的 7 处

1. **`selected` 改造的 4 个消费点**（F1 说 3 处，实测 4 处）：`IntakePage.jsx:223`（`!== 2` 闸）、`:227`（解构前两张）、`UploadPanel.jsx:57`（`N/2` 文案）、`:58`（`disabled={selected.length !== 2}`）、`:61`（清空）、`:69`（`picked`）。改通用多选时这 6 个引用全要过一遍，**顺序语义**（F1 的"先选的在上面"）要保留并在卡片上标序号。
2. **拼接产物没有 `File`**：`doStitch` 生成的 merged item（`IntakePage.jsx:236-249`）**没有 `_file`、`size: null`** ⇒ C-5 的哈希要么对 `dataUrl` 现算（`fetch(dataUrl).arrayBuffer()`），要么明确"拼接图不做预检"并在卡片上标注。计划没写，会漏。
3. **`loadReports()` 的刷新时机是够的，但要写进计划**：`saveReport` 成功后调用 `loadReports()`（`IntakePage.jsx:441`）、另一处 `:556` ⇒ 库清单不会长期失真。**但**列表接口一次返回 77 份含 `rows` 的完整记录（`server.mjs:1005-1013`，`data/reports.json` 440 KB）⇒ 50 张批次会触发 50 次 ≈ 440KB 的刷新。C-5 若在 `addFiles` 里再拉一次，要写清"复用 state、不额外请求"，或接受这个成本并记一条实测。
4. **「移除」的语义与图标**（C-2 落地细节）：`F2` 的文案区分对，但图标选择要跟上——`DeleteOutlined` + `danger` 红会被读成"删库存"。建议 `DeleteOutlined` 但**非 danger**（或 `CloseOutlined`/`MinusCircleOutlined`），`aria-label="移除此文件（未入库）"`，且**① 面板内全页不出现"删除"二字**。
5. **C-9 挂起的依据（实测后再放行）**：`stitchVertically`（`lib/reportIntake.mjs:144-161`）**没有任何数量或尺寸护栏**——它直接 `createCanvas(max(width), sum(height))` 并把 PNG base64 进响应。4 张手机图（1200×4000 各）≈ 1200×16000 画布，PNG base64 可达 10–20 MB，再进 OCR。**要一条实测**：4 张 4000px 高的图拼接后的字节数与耗时（≤2s、≤8MB 可接受），否则 C-9 保持挂起。
6. **F5 的模板核对通过**：`tests/verify-reports-refresh.mjs` 存在，且确实是 `PORT=5193` + `MEDBRIEF_REPORTS_FILE`/`MEDBRIEF_DATA_DIR` 指副本（`:27-30`）✓。但注意端口占用：`5193` 已被它占，`5199` 被 `verify-report-delete.mjs` 占 ⇒ 本计划的验收脚本用 **5194/5195**，并在同一次 `npm test` 里避免同端口并发。
7. **N4「项目内无固定栏先例」的描述要改准**：`grep -rn "position.*fixed" web/src` 命中 3 处，但两处是 `web/src/meddata/embedded.css:402/405`（Tailwind 产物里的 `.fixed`/`\!fixed` 工具类），一处是 `CardPreview.jsx:8` 的注释 ⇒ **页面层确实没有先例**，结论不变，但"只有 tailwind 工具类定义"这句不准确（前两处是第三方产物、不是"定义在本项目"）。

---

## 3. 八条必攻击点逐条回答

**① R4 的能力边界你认不认？——认，并且能把它钉得更死；但你的表述漏了「批内」这一层。**
- 成立依据比我预想的更硬：`docs/导入工作流.md:33` 的四层判重是「① sha256 字节级 ② 原件已在 `data/intake/**/archive` ③ 库里已有同「单号+报告日期」④ **批内**同「单号+类型+日期」」。②③④ 都要服务端状态或 OCR 结果，**导入一刻确实只有 ①sha256**。
- dHash 不能前移也成立：`lib/reportIntake.mjs:113-120` 写着「同版式不同日期汉明距离 = 0，14 张不同影像报告会被聚成一簇」。C-10 砍得对。
- **但**：四层里的 ④「批内」提示了另一件事——**批内相同字节**是客户端**能**判的，而 v0.1 只写了"与库对表"。见 P0-1。补上这一点后，"导入即查重"才覆盖用户真实场景。

**② F3 的状态污染你认不认？——认，独立字段 `predup` 是对的；补两个消费点与一处文案雷。**
- 我复核了 `status==='dup'` 的消费点：`UploadPanel.jsx:21`（`dupCount` Tag）、`IntakePage.jsx:447-453`（`recognize` 分支 + `pushLog` + `return {duplicate:true}`）、`:506-523`（`classifyImportable` 的 `c.dup` 与"已跳过"文案）、`:573`（`dupCount` 汇总）。**四处**，比你列的 3 处多一处（`:573`）。复用 `status` 会一并污染 —— 独立字段正确。
- **新发现的一处**：`classifyImportable`（`:505-515`）的四态分类完全按 `status`/`saved` 判；`predup` 不进分类是对的（不阻断），但**卡片上会同时出现「疑似重复 N」（库内）：`dupCount`）与新的「同一文件已导入 N」两个 Tag**，用户分不清。要求：两处文案写死不同词——`疑似重复（入库时判定）` vs `已导入过此文件`，并在顶部只保留一个合并计数（点开可看明细）。

**③ C-6「不许合并识别与导入」你认不认？——同意，而且理由可以更强。**
- 强理由不在"用户体验"，在**数据责任**：`saveReport` 是唯一写库入口，它内部做了查重/空值过滤/`textOnly`/「更新原报告」四件事（`IntakePage.jsx:420-470`）；② 校对区是这些分支唯一的人工复核点。合并 = 识别完自动入库 = **用户从未看过系统填了什么就落库**，直接撞「认不出的不瞎填」。
- 另外技术上"合并"也不省钱：`importAll` 只对 `lab`/`textual` 两类动手（`:513-515`），识别失败的仍要人工处理 ⇒ 合并后还是要停一下。**故砍得对，并把理由换成"数据责任"，比"少点一次"更难被推翻。**

**④ F4 遮挡：够不够？要不要改 sticky 顶栏？——不够（见 P0-3），而且 sticky 顶栏是更差的备选。**
- 页面顶部已有吸顶分段条，`scrollMarginTop: 56`（`IntakePage.jsx:902`、`:118`）；375×812 的首屏只有 812px，再叠一条 sticky 顶栏会吃掉近 100px 可视区（约 1/8 屏），比底部固定更伤。
- ② 段落真正的底部按钮是**每项 Collapse 内部的「入库这份报告」**（`IntakePage.jsx:835`），不是一条独立的保存行 ⇒ "给内容补 padding-bottom"只解决最后一项，**Collapse 展开时仍会被盖**。
- 所以处置应是：① 段显示固定栏 + 内容补 `padding-bottom`；**`sec === 'review'` 时整条隐藏**（复用现有 observer），② 的入口留在 `ReviewPanel.jsx:22-25` 不动。**不要** sticky 顶栏。

**⑤ N4 怎么写成可复跑断言？——给 6 条，全部可在 375/414/768/1440 四档各跑一次。**
1. 栏存在且是 fixed：`getComputedStyle(bar).position === 'fixed'`；
2. 栏在视口内完整可见：`bar.getBoundingClientRect().bottom <= innerHeight + 1 && bar.top >= 0`；
3. **不遮内容**：`window.scrollTo(0, document.body.scrollHeight)` 后，① 段最后一个可交互元素 `el.bottom <= bar.top + 1`；
4. **不遮入库按钮**：在 ② 段展开最后一个 Collapse 项，`#btn-import-item`（给 `:835` 加 `data-testid`）的 `bottom <= innerHeight`；
5. **不新增横滚**：`document.documentElement.scrollWidth <= innerWidth + 1`（四档都跑，且必须**改前也跑一次**作为 must-be-0 基线）；
6. **安全区**：`getComputedStyle(bar).paddingBottom` 值 ≥ 8px 且 CSS 里出现 `env(safe-area-inset-bottom)`（桌面计算结果为 0，只断言声明存在，别断言数值）。
   另加一条**遮挡反证**（防空过）：把栏高硬编码成 `90vh` 跑一次 ⇒ 第 3、4 条必须变红。

**⑥ R10 的 `[未取证]` 必须先取证吗？——不必取证，它是可推导的必然（见 P0-2）。**
- 定案依据：`server.mjs:1808` 绑 `0.0.0.0` + 安全上下文规范（`localhost`/`127.0.0.1`/`https`/`file` 之外都不是）。
- 若你仍要一条实测（可选、不用碰真库/5174/浏览器也行）：
  ```bash
  # ① 证明手机只能走非回环地址
  grep -n "server.listen" server.mjs          # 0.0.0.0 ⇒ 局域网可达
  # ② 证明安卓/桌面 Chrome 的判定只看 URL（无需服务：用 data: 与 file: 对照即可看出 isSecureContext 的取值规则）
  node -e "console.log(new URL('http://192.168.1.2:5174').hostname)"   # 非 localhost
  ```
  真要浏览器级复核就交给实现方（Playwright 起一个临时静态服务在 `0.0.0.0:5194`，以局域网 IP 打开，读 `window.isSecureContext`）——**这条不必挡开工**，因为结论已定，只是确认。

**⑦ 范围外溢：两条"不改 server.mjs"我都核过，**成立**，但各带一个副作用。**
- **预检走既有 `GET /api/intake/reports`**：成立。`server.mjs:1005-1013` 是 `...r` 展开，只把 `text`/`images` 置 `undefined`，**`sha256` 在返回体里**；`IntakePage.jsx:139-150` 的 `loadReports()` 已把它放进 state，且每次入库成功后都会再调（`:441`）。副作用：**该响应 440KB 且含 `rows`**（77 份 / 423 行）⇒ 不要在 `addFiles` 里重复拉；用 state 即可。
- **多张拼接走既有 `/api/intake/stitch`**：成立。`server.mjs:1387-1392` 只校验 `images` 非空，`stitchVertically(imgs)` 吃数组。副作用：**服务端无数量/尺寸上限**（`lib/reportIntake.mjs:144-161`）⇒ 上限只能靠前端 + 必须实测（P1-5）。**这一条是把 C-9 从"准予"降为"挂起"的直接原因。**

**⑧ 与 `intake-dedupe-1116` 的混淆要不要更强区分？——"未入库"文案够用，但要再加三道锁。**
- 两个"删"在**不同页面**（本线在 `/`（录入页）① 段；那条在 `/reports`（报告库）），物理上不易混，所以我不同意"要更强的区分"到改交互的程度。
- 但加三道低成本锁：① ① 段全页**不出现"删除"二字**（用「移除」）；② 图标**不用 danger 红**（P1-4）；③ 固定栏的二次确认文案写「这 N 张还没入库，移出后需重新导入」——把"未入库"从形容词变成一句后果说明。
- 另建议（治理）：两条线若同批落地，把这两个"删"的区别写进 `.agents/MEMORY.md` 的口径段，否则下个会话一定会问"为什么录入页删了、报告库里还有"。

---

## 4. 逐条闭环核对表（plan 的 R/F/C/D 条目 → 我核到的落点）

| 条目 | 我的复核 | 判 |
|---|---|---|
| R1 拼接栏在列表之上 | `UploadPanel.jsx:56-63` 在 `:66` 的 `Row` 之前 ✓ | ✅ |
| R1b 每卡识别 + 顶部一键识别 = 两层 | `:29-33` + `:119-121` ✓ | ✅ |
| R2 删/选是文字按钮 | `:104-110`（`删` = `type="text" danger`；`选/已选` = 普通）✓ | ✅ |
| R3 查重只在入库 | `server.mjs:1683` 唯一判定点 + `IntakePage.jsx:447-453` 才置 `dup` ✓ | ✅ |
| R4 导入即查重只能 exact | ✓ 成立（见 §3-①）；`docs/导入工作流.md:33` 四层口径佐证 | ✅（表述需补"批内"） |
| R5 列表已返回 sha256，不必加端点 | `server.mjs:1005-1013` `...r` ✓ | ✅ |
| R6 前端无指纹 | `addFiles` 只建 `dataUrl:''` + `_file`（`:153-183`）✓ | ✅ |
| R7 2 张上限是纯前端 | `toggleSelect`(`:214-221`) + `doStitch`(`:222-231`)；服务端 `:1387-1392` 收 N 张 ✓ | ✅ |
| R8 识别/导入分在两个面板 | `UploadPanel.jsx:29-33` vs `ReviewPanel.jsx:22-25`（经 `IntakePage.jsx:905` 传入）✓ | ✅ |
| R9 卡片占屏 | `Col xs={24}`（`:71`）+ 120px 缩略图 + 信息行 + block 按钮 ⇒ 375 约 3.7 张/屏 ✓ | ✅ |
| R10 crypto.subtle | **`[未取证]` 应改为已定案**（见 P0-2） | ⚠️ |
| F1 selected 3 处 | 实测 **4 个文件内 6 个引用**（`:223/:227/:57/:58/:61/:69`） | ⚠️ 数量订正 |
| F2 removeItem 是内存删除 | `:208-212` ✓（无服务端调用） | ✅ |
| F3 不许复用 `status:'dup'` | 消费点 4 处（`:21`/`:447-453`/`:506-523`/`:573`）✓ | ✅（多一处 `:573`） |
| F4 固定栏遮挡 | ② 的底部按钮在每项 Collapse 内（`:835`），"补 padding"只挡住最后一项要求不成立 | ❌ 见 P0-3 |
| F5 测试模板 | `tests/verify-reports-refresh.mjs` 存在，`PORT=5193` + 副本库 ✓ | ✅（端口要避开 5193/5199） |
| F6 不改 server.mjs | 两条都成立 ✓，但 list 440KB、stitch 无护栏 | ⚠️ |
| F7 部署态 | `build:web` + 硬刷新 ✓（本会话已踩过"没上线"） | ✅ |
| F8 治理资产 | `docs/导入工作流.md:33` 判重四层要补「预检只判 exact 字节」✓ | ✅ |
| F9 并发写 | 计划已核 `git status`；本轮我核时 `UploadPanel/IntakePage/shared.js` 无在途改动 | ✅ |
| C-5 漏批内查重 | 见 P0-1 | ❌ |
| C-9 无服务端护栏 | 见 P1-5 | ⚠️ |
| D-1 第 2 条「撤每卡识别」 | 但 `done` 态今天已显示「重新识别」（`:120`）⇒ 本题比计划想的更小 | ⚠️ 事实订正 |
| D-3 三条前提问题 | 第 4 条的"降级"缺 (d) 方案 | ⚠️ |

---

## 5. 复跑命令清单（本判词每条结论可自证）

```bash
cd /Users/scallion/Documents/projects/MedBrief

# 现状取证（R1/R1b/R2/R6/R7）
sed -n '25,35p;55,72p;100,125p' web/src/pages/intake/UploadPanel.jsx
sed -n '153,183p;208,232p' web/src/pages/IntakePage.jsx

# P0-1：addFiles 无任何去重 + 粘贴同路径
grep -n "setItems((prev) => \[...prev, ...accepted\])" web/src/pages/IntakePage.jsx
grep -n "addFiles(files)" web/src/pages/IntakePage.jsx

# P0-2：手机端不可能用 127.0.0.1
grep -n "server.listen" server.mjs                     # 0.0.0.0

# P0-3：顶部两处冗余入口 + ② 的入口与底部按钮
sed -n '29,33p;56,63p' web/src/pages/intake/UploadPanel.jsx
sed -n '18,26p' web/src/pages/intake/ReviewPanel.jsx
sed -n '830,840p' web/src/pages/IntakePage.jsx         # 每项「入库这份报告」

# F1/F3 消费点全量
grep -n "selected" web/src/pages/IntakePage.jsx web/src/pages/intake/UploadPanel.jsx
grep -n "status: 'dup'\|dupCount\|body.duplicate" web/src/pages/IntakePage.jsx

# R5/F6：列表返回 sha256、体量、stitch 收 N 张且无护栏
sed -n '1003,1014p' server.mjs
ls -l data/reports.json
sed -n '1384,1396p' server.mjs
sed -n '141,162p' lib/reportIntake.mjs

# C-10：dHash 不能前移的反例
grep -n "凝血 07-26" lib/reportIntake.mjs
sed -n '33p' docs/导入工作流.md

# F5：模板端口
grep -n "PORT" tests/verify-reports-refresh.mjs tests/verify-report-delete.mjs

# N4 固定栏先例（3 处，其中 2 处是 tailwind 产物）
grep -rn "position.*fixed" web/src --include=*.jsx --include=*.css
```

**需实现方实测（我不能起服务/碰 5174 的项）**：375/414/768/1440 四档的固定栏 6 条断言（含 90vh 反证）；4 张 4000px 图拼接的字节数与耗时；手机端 `window.isSecureContext` 实测（可选，结论已定）。

---

## 6. 我做了什么、没做什么
- 只读：未改 `.agents/batch-import-1116-plan.md`、未改 `web/**` 与 `server.mjs`、未写测试、未提交、未读写 `data/reports.json`、未碰 5174。
- 只写了 `MedBrief/.agents/batch-import-1116-review-r1.md` 这一个文件。
