# 报告库三处 UI（手机查看原件 / 删除与编辑显隐 / 眼睛按钮）—— **数值与交互规格** v1.2（UI 设计师，2026-11-17）

> 用户 2026-11-17 18:38 报三处；按硬约束「版面/图标找 UI 设计师」出规格，实现方不改版面。
> 现状锚点：`web/src/pages/intake/ReportsPanel.jsx`（PC `Table` + 手机 `ReportDayList`）、`web/src/pages/intake/ReportDayList.jsx`、`web/src/pages/intake/shared.js`（`ICONS`）。
> 判据落**仓库门禁** `tests/verify-reports-panel-ui.mjs`（`npm run test:reports-panel-ui`）——**门禁待创建**，见 §5「门禁落地前置」。

---

## 0. 先纠正两条与代码不符的前提（不改结论，只改做法）

| 用户/实现方说法 | 代码现状（实测） | 后果 |
|---|---|---|
| 「我点表格行也是一样的查看」 | **PC 的 `Table` 没有任何行点击**（`ReportsPanel.jsx` 里 `grep -n 'onRow'` = **0**）；只有**手机**的 `ReportDayList` 有行点击（`ReportDayList.jsx:126` `.rb-day-main onClick → onOpen`） | **PC 直接删眼睛按钮 = PC 端失去唯一查看入口**。⇒ 必须**先给 PC Table 加行点击**，再删按钮（§3） |
| 「删除按钮是齿轮」 | 齿轮是**顶部 manage 开关**（`:579` `icon={ICONS.manage}`）；删除按钮本身用的已经是 `ICONS.trash`（`:510`），但它只在 `manage` 打开时才出现 | 用户的真实痛点是「管理模式下才看得到删除、而开关是个齿轮看不懂」⇒ 解法是**去掉 manage 开关、删除常显**（§2），不是换图标 |

---

## 1. ① 手机「查看原件」—— **裁定：走 B（同页 Modal），并把 A 的两个响应头作为防御一并补上**

> **v1.1 依据（运维只读取证，2026-11-17，已核）**：白屏**与 nginx/WAF 无关** —— 站点配置只有 ACME/标准反代/HSTS 一条，无 proxy_cache/proxy_hide_header/blob 规则；WAF `state=off`、medbrief 不在站点列表、waf.lua 只做 access 阶段；`gzip_types` 不含 pdf。公网未登录打 `/api/intake/blob/*` → `HTTP/2 401, content-type: application/json`，**无 `Content-Disposition`、无 `X-Content-Type-Options`**；全仓这两个头 **0 命中**。
> 两条失效路径：**① 新标签没带 session cookie（iOS in-app / 隐私模式常见）→ 401 JSON**；**② 带 cookie 但无 `Content-Disposition: inline` → 部分手机浏览器当下载/不渲染 → 白屏**。

**为什么选 B 而不是只选 A**：**路径 ① 补头治不了** —— 401 是「没有身份」，不是「渲染方式」；只有**同页请求**才稳定带登录态。所以交互必须改成同页；两个响应头作为**防御层**一并补（成本 2 行，覆盖长按另存 / 将来别处直链的场景）。
**运维提议在 nginx 加 nosniff 临时兜底 —— 我不同意**：那是用生产网关盖住应用自身缺陷，根因要走应用层一次改对。

## 1. ① 手机「查看原件」：改**同页弹窗**，不再开新标签

| 项 | 规格 |
|---|---|
| 触发 | 手机 `ReportDayList` 的 `查看原件`（`ICONS.file`）与 PC「原件」列的同一动作**统一**走弹窗（PC 也不再 `window.open`） |
| 组件 | antd `Modal`（`footer={null}`、`destroyOnClose`），内容 = `<img>`（jpeg/png）或 `<iframe>`（pdf） |
| 宽度 | `≥576px`：**900px**（`maxWidth: 90vw`）；`≤575px`：`calc(100vw − 24px)`（左右各 12px） |
| 高度 | `max-height: 84vh`；图片 `max-height: calc(84vh − 96px)`、`object-fit: contain`；PDF `iframe` 高 `calc(84vh − 96px)` |
| 标题 | 报告名 + 日期，12px；右侧保留 antd 关闭按钮 |
| 加载态 | `Spin` 居中，高 **120px** |
| 失败态 | antd `Alert type="error"` + 文案 **`原件打不开：可能需要重新登录，或该原件已不存在`** + 按钮 **`重试`**；容器带 `data-blob-error` 属性（供判据取样） |
| 为什么同页就不 401 | 新标签 `window.open('/api/intake/blob/<id>')` 在部分手机浏览器里**不带同域 cookie / 被当第三方上下文** ⇒ 401 JSON 被当图片渲染 = 白屏。同页 `<img src>` 走本页登录态 ⇒ 不会掉 cookie |
| 复用优先 | 若 `SourceModal.jsx`（`web/src/pages/card/SourceModal.jsx`）里已有等价的图片/PDF 预览体，**抽出来复用**，不重写第二套；抽不出就按上表新建 `BlobModal`，**不许**在页面里塞内联 `<img>` 一段了事 |
| **PDF 渲染（B 的关键，不许用 iframe）** | 用 **pdf.js**（项目已装 `pdfjs-dist`，写法照 `meddata/src/utils/parseDoc.js:6-11` 的 `GlobalWorkerOptions.workerSrc`）逐页渲染成 `<canvas>`：页面宽 = 容器宽、`devicePixelRatio` 取 2、**首屏先渲染 3 页**、滚到底续 3 页（最多 12 页后给「继续加载」）；顶部显示 **`第 n / N 页`**（12px 灰）。**理由**：iOS Safari 对 iframe 内嵌 PDF 支持差（只显首屏或空白），`<img>` 也吃不了 PDF |
| **兜底（必须有）** | 弹窗底部一行文本按钮 **`下载 / 在浏览器打开`**，旁注 12px：`若上面看不全，可下载后用系统阅读器打开`；仍走同源 URL（是下载通道，**不是**新标签渲染的替代品） |
| **服务端两个头（A 的部分，防御层）** | `server.mjs:1661` 的 `writeHead(200, …)` 增加 `Content-Disposition: inline; filename*=UTF-8''<encodeURIComponent(原名)>` 与 `X-Content-Type-Options: nosniff`；`content-type` 仍按原类型。**改动归属 = 实现方（代码）**；规格只要求「必须有」，见 P14 |

---

## 2. ② 删除/编辑显隐（按用户口径）＋ 去掉齿轮开关

| 视口 | 操作列条目（左→右） | 图标 | 说明 |
|---|---|---|---|
| **PC（≥576）** | `编辑` + `删除` | `ICONS.edit` / `ICONS.trash`（danger，`Popconfirm` 二次确认） | **删除常显**（用户口径），不再依赖 manage 模式 |
| **手机（≤575）** | `编辑`（**只此一个**） | `ICONS.edit` | **删除从列表移除**（防误触）；删除入口移到**详情抽屉底部**（抽屉里保留 `删除` + `Popconfirm`，样式同 PC） |

- **顶部 manage 开关（齿轮 `ICONS.manage`）删除**：PC 删除已常显、手机不做列表删除 ⇒ 该开关**失去用途**；用户把齿轮误认成删除按钮，正是它该下线的证据。⇒ **工具栏按钮数 −1**。
- 若将来仍需"批量管理"，另立需求、另出规格，**不在本次偷偷保留**。
- 图标一律走项目内联 SVG（`ICONS.trash` 已存在；`@ant-design/icons` 未安装）。

---

## 3. ③ 眼睛按钮（查看）删掉——但**PC 必须先补行点击**

| 步骤 | 做法 | 数值/口径 |
|---|---|---|
| 1 | PC `Table` 加 `onRow={(r) => ({ onClick: () => openView(r.id), style: { cursor: 'pointer' } })}` | 行高不变（antd `size="small"` 既有 39px） |
| 2 | 行 hover 反馈 | 背景 `#fafafa`（antd 默认 hover 已有，勿自绘） |
| 3 | 可访问性 | 首个可见格（报告日期）内文本加 `role="button"`、`tabIndex={0}`、`onKeyDown`（Enter/Space → `openView`）、`cursor:pointer`；**这是删掉眼睛按钮后键盘用户唯一的入口** |
| 4 | 删按钮 | PC 操作列去掉 `ICONS.view` 那项；手机 `ReportDayList` 操作区去掉 `查看`（`.rb-day-main` 已可点，重复） |
| 5 | 手机整行可点（**实测更正**） | 现状 `.rb-day-main` 只有 **min-height 22px**（`ReportsPanel.jsx:81`），行容器 `.rb-day-row` 是 **52px**（`:77`）⇒「点行」实际只有 22px 高。**改法：把 onClick 挂到 `.rb-day-row` 整行**（`.rb-day-actions` 已有 `stopPropagation`，不会误触）——**不改布局**，click 目标直接变 52px ≥ 44 ✓ |
| 6 | 操作按钮热区 | `IconBtn` 视觉 **32×32**（`ReportDayList.jsx:46`）不足 44：加 `.rb-day-actions .ant-btn{position:relative}` + `::before{content:'';position:absolute;inset:-6px}` ⇒ 热区 **44×44**（32+12），**布局不变** |

---

## 4. 布局数值（现状复用，不新造）

| 项 | 值 |
|---|---|
| 操作列宽 | PC：`isXs ? — : (tab==='trash' ? 210 : **140**)`（去掉眼睛后 170 → **140**，留 `编辑`+`删除` 两个 44 热区 + 间距） |
| 手机操作区 | 竖排 `Space size={0}`、按钮 44×44（既有 `IconBtn` 口径） |
| 工具栏按钮 | 移除齿轮后剩：`Segmented` + `Input.Search` + `刷新`（+ 回收站 tab 时无管理按钮） |
| 搜索框宽 | `isXs ? 150 : 240`（不变） |

---

## 5. 判据（**门禁待创建**：`tests/verify-reports-panel-ui.mjs` / `npm run test:reports-panel-ui`）

> **门禁落地前置**（沿用上一份规格 §3.1 的硬条，不再重蹈"写了但没判"）：交付必须同时贴出
> `grep -n 'test:reports-panel-ui' package.json`（命中 1 行）、`ls -l tests/verify-reports-panel-ui.mjs`（存在且 >0 字节）、`npm run test:reports-panel-ui`（全绿 exit 0）、以及对每条证伪的 exit 1。

| # | 判据 | 量测式 | 期望 |
|---|---|---|---|
| **P1** | PC 点行能查看 | 1440 视口点「报告库」表格第 1 行正文（非按钮）→ 详情抽屉/弹窗可见（`.rb-detail` 或 `[role="dialog"]`） | 打开成功 |
| **P2** | 眼睛按钮已删 | `document.querySelectorAll('[aria-label="查看"]').length` = **0**（PC 与手机都查）；且 P1 仍成立 | 0 + P1 真 |
| **P3** | 键盘可达 | PC：首格 `role="button"` 存在、`tabIndex === 0`；按 `Enter` 后详情可见 | 全真 |
| **P4** | 删除显隐 | PC：`[aria-label="删除"]` 可见（`offsetParent !== null`）；375 视口列表里 `[aria-label="删除"]` 计数 = **0**，`[aria-label="编辑"]` ≥ 1 | 全真 |
| **P5** | 齿轮已下线 | 工具栏里 `title`/`aria-label` 含「管理」的按钮计数 = **0** | 0 |
| **P6** | 手机原件走弹窗 | 375 视口点 `查看原件`：**未产生新页面**（`page.on('popup')` 一次都没触发）且 `.blob-modal` 可见 | 全真 |
| **P7** | 原件能真加载 | `.blob-modal` 内 `<img>` 的 `naturalWidth > 0`；或 `<iframe>` 的 `contentDocument` 非空（PDF 允许 `contentDocument === null`，改为断言 `iframe.src` 同源且 `HTTP 200`） | 真 |
| **P8** | 401 不白屏 | 用未登录上下文（清 cookie）点原件 ⇒ 出现 `[data-blob-error]` 且模态框内有可见文字；**body 不得为空** | 全真 |
| **P9** | 同源不丢 cookie | 监听 `request`：blob 请求 `url` 以 `/api/intake/blob/` 开头且**同 origin**（无 `cross-origin` 302） | 真 |
| **P11** | 图片同页加载 | 375 与 1440 视口点 `查看原件`（jpeg/png 报告）：`page.on('popup')` 零触发；`.blob-modal img` 的 `naturalWidth > 0` 且 `currentSrc` 以 `/api/intake/blob/` 开头 | 全真 |
| **P12** | **PDF 用 canvas 不用 iframe** | 打开 pdf 原件后：`.blob-modal iframe` 计数 === **0**；`.blob-modal canvas` 计数 ≥ **1** 且首个 canvas `width > 0`；`第 n / N 页` 文本存在 | 全真 |
| **P13** | 401 不白屏且有指路 | 清 cookie 后点原件：`[data-blob-error]` 存在、文案含 **`登录`**、有 `重试` 按钮；模态框内 `innerText.length > 0` | 全真 |
| **P15** | **门禁自检：`--falsify` 真的会红** | 依次跑 `--falsify=P1 P2 P4 P6 P12 P14 headers 401`：每次必须 **exit 1** 且输出里点名对应判据；全部跑完再跑一次无参模式必须 **exit 0** | 全真（任何一条 exit 0 = 判据恒绿，判不合格） |
| **P14** | 服务端两个头 | `curl -sI <base>/api/intake/blob/<id>`（带登录 cookie）：`content-disposition` 匹配 `/^inline;/i` 且含 `filename*=UTF-8''`；`x-content-type-options` === `nosniff`；`content-type` ∈ {`image/jpeg`,`image/png`,`application/pdf`} | 全真 |
| **P10** | 整行可点 + 按钮热区 44 | ① 375 视口点 `.rb-day-row` 的**空白区**（不落在按钮上）→ 详情打开；② `.rb-day-row` 的 `rect.height ≥ 44`；③ `.rb-day-actions` 内每个按钮：视觉 32×32，但 `document.elementFromPoint(cx±20, cy)` 与 `(cx, cy±20)` **四点都返回该按钮**（`::before` 扩展归宿主） | 全真 |

**证伪（5 条，贴退出码 1）**：① 去掉 `onRow`（PC 退回只有按钮）⇒ **P1/P2 必红**；② 手机删除按钮放回列表 ⇒ **P4 必红**；③ 原件改回 `window.open` ⇒ **P6 必红**；④ PDF 改用 `<iframe>` ⇒ **P12 必红**；⑤ 去掉 `server.mjs` 的 `Content-Disposition` ⇒ **P14 必红**。

---

## 5.1 证伪口径（v1.2 新增，回答「5 条证伪怎么做成可持续跑的脚本」）

实现方如实说明：`--falsify` 的 sed 注入不稳、未命中，所以交付是「18/0 真跑」而**不是**「5 证伪真红」。**这条我接受如实标注**，但同时指出一个必须修的残留：**门禁文件头 `:8-10` 已经写了 5 个 `--falsify=` 开关，实际并不存在** —— 注释承诺不存在的功能，等于给下一任埋"看起来能跑"的假象。**二者必须一致：要么实现，要么删注释。**

**定稿口径：分两层，别用 sed 改产品源码。**

### Tier 1 判据灵敏度（**5 条全覆盖，稳定可复跑**）

把每条判据写成**纯函数**：`checkP6(m)` 只吃一个「实测对象」。

```
node tests/verify-reports-panel-ui.mjs --falsify=P6
# 内部：const m = {...真实实测}; m.popupCount = 1        // 模拟"改回 window.open"之后世界长什么样
#       assert.throws(() => checkP6(m), /P6/)           // 必须抛错 ⇒ 证明这条判据不是恒绿
```

- 覆盖清单：`P1|P2|P4|P6|P12|P14`（按判据编号，一格一条）。
- 判据通过 = **该 check 在"该红的世界"里确实红了**；未抛错 ⇒ 该判据**恒绿**，直接判不合格。
- 优点：不碰产品、不碰源码、不依赖 sed/正则，跑 100 次结果一致。

### Tier 2 真实回归（**只做能在网络层稳定模拟的**）

- `--falsify=headers`：`page.route('**/api/intake/blob/**')` 把响应头**剥掉** `Content-Disposition` / `X-Content-Type-Options` 再喂给页面 ⇒ **P14 真红**（纯网络层，稳定）。
- `--falsify=401`：`page.route` 强制回 401 JSON ⇒ **P8/P13 真红**（同上）。
这两个是"改产品输入"而非"改产品代码"，可长期跑。

### Tier 3 不做脚本化（写清理由）

「删 `onRow`」「PDF 改 iframe」「手机放回删除按钮」这类要**改产品源码**的证伪，**不脚本化**：为证伪给产品加 debug 开关，本身就会成为新缺陷源（而且这些改动只会出现在 diff 里，靠 code-review 一眼可见）。这些由 **Tier 1 灵敏度** + 人工 review 覆盖。

## 6. 待你确认的 1 处（不影响开工，但影响"删除入口在哪"）

手机端删除我从列表移到了**详情抽屉底部**（用户口径只说"手机隐藏删除、显示编辑"，没说删除去哪儿）。若你或用户希望手机**完全不提供删除**（只能到 PC 删），说一声我把 P4 的"抽屉里存在删除"那条删掉 —— **默认按"抽屉保留"**。

---

## 7. 条数统计（v1.0）

- 规格条目：**§1 手机原件 13 条（v1.1 +4）/ §2 删除与编辑 5 条 / §3 眼睛与行点击 6 条 / §4 布局数值 4 条 = 28 条**
- 判据：**P1–P15 共 15 条**（P15 = 门禁自检；证伪按 §5.1 分三层），门禁 `tests/verify-reports-panel-ui.mjs` **已存在**（`4197f5d`，我本机复跑 **18/0 exit 0**）
- 待确认：**1 条**（§6）
