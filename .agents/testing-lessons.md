# 测试与排查教训 — MedBrief / 114 挂号

## 2026-11-12 · 462 与 8888 是两层，混为一谈就查不出根因

- **462 = 瑞数 WAF 在传输/UA 层拒了**，业务代码没执行。判据：`content-length: 0` + `server: unicom` + 响应体为空。
- **8888 = 业务层鉴权不足**，HTTP 是 200、回包是真 JSON：`{"code":"8888","message":"点评用户授权失败…"}`。
- **正确顺序**：先看 HTTP 状态（462 ⇒ UA/环境问题）→ 再看 body 的 `code`（8888 ⇒ 渠道/授权问题）→ 最后才疑接口参数。
- 代价：早期把 462 当成「接口参数不对」，反复改 header 无效，浪费多轮。

## 2026-11-12 · 「绕开代理就好了」的误判：对比必须控制变量

- **错误姿势**：用无 cookie 的裸 curl 绕开 Clash 得到 `202`，就判定「Clash 的 TUN 栈导致 462」，并提出改 `tun.stack`。
- **反例**：用浏览器真 cookie（含 HttpOnly）分别经 Clash / 绕 Clash 打同一请求，**四种组合全 462**。
  202 只是「新客户端应得的挑战页」，与代理无关。
- **判据**：任何 A/B 对比必须锁死除被测变量外的全部条件（同一 cookie、同一 body、同一 UA）。
  条件不对等的对比，结论必须显式标注不可用。

## 2026-11-12 · 自动化点击的三个坑（都真踩过）

1. **`page.fill()` 不触发 Vue 更新**：input 的 DOM `value` 变了、页面显示也对，但 Vue model 仍为空 →
   按钮一直是 `again-button-disabled`，点了也不发请求。**必须** `mouse.click` 聚焦后用 `keyboard.type()` 真实输入。
2. **坐标落在视口外**：按钮 `getBoundingClientRect().y = 1120`，而视口高 1087 → 点击等于点空白，
   表现为「点了没反应、无请求、无报错」。**必须先 `scrollIntoView({block:'center'})` 再取坐标**。
3. **移动端可能绑 touch 而非 click**：页面 UA 是 iPhone 时，`click` 未必触发；用
   `CDP Input.dispatchTouchEvent`（touchStart → touchEnd）更可靠。

## 2026-11-12 · ego-browser 的 UA 覆盖不跨进程

`Network.setUserAgentOverride` 只对当前 CDP 会话有效，进程退出即失效。
**多步流程（填号→识别图形码→提交）必须在同一次 `ego-browser nodejs` 调用内完成**，
否则下一次调用页面已掉回默认 UA，请求重新 462。同理 `Page.addScriptToEvaluateOnNewDocument`
注入的钩子也可能丢失，关键动作前重新注入。

## 2026-11-12 · 图形验证码的处理姿势

点「获取验证码」不是直接发短信，而是先 `GET /captcha` 下发 4 位图形码。
取图要从页面里的 `<img>`：`data:` URL 直接取 base64；`blob:` URL 需在页面内 `fetch` 后转 base64 落盘再识别。
识别结果是**一次性**的，须在同一会话内立即填入提交，超时需重新拉取。

## 2026-11-12 · 判断「服务不可用」前，先看轻量接口

排查 114 时曾把「请求挂死 40–150s」误判为站点故障/配额。
**正确做法**：先用不消耗资源的接口（`GET /v2/models`、`countTokens`、静态资源）验证 key/网络是否正常，
再判断重接口失败是配额、限流还是环境问题。轻量通 + 重接口挂 = 额度或环境，不是 key 失效。

## 2026-11-12 · 浏览器选型：Playwright 过不了瑞数，ego lite 可以

- **实测矩阵**（同一 UA `MicroMessenger`、同一 URL）：
  Playwright 自带 Chromium（headless / headed）、系统 Chrome（headless / headed）
  → 文档层 **202 挑战页**，7 秒后 body 仍为空，后续接口一律 **462**。
  ego lite（ego-browser CLI）→ 首页正常渲染，`/user/get`、`/department/list` 均 200。
- **判据**：202 是挑战页、462 是挑战未通过的拒绝；两者都指向「浏览器环境被识别」，
  不是 UA 或参数问题。此时不要再换 header 试，直接换驱动。
- **代价**：先按「有 Playwright 依赖就复用它」的直觉写了整套实现，实测全灭后重写为 ego-browser 驱动。

## 2026-11-12 · 同一 WAF 下不同接口的可达性并不一致

- `department/list/{hosCode}` 经页面内 fetch 直接 200 `code 0000`；
  同一上下文里 `hospital/list` 也是 HTTP 200，但业务层固定回 `code 8888 系统繁忙`。
- **判据**：**HTTP 200 ≠ 业务可用**。8888 属于业务层拒绝（该接口需要站点自身注入的瑞数令牌参数），
  与 462/461 是不同层的问题，解法也不同：前者只能让站点自己发，后者要换浏览器环境。
- **处理**：医院列表改为手填医院编码；科室树仍自动加载，并可用它验证编码有效性。

## 2026-11-12 · 图形验证码：两条 OCR 路径都可能命中，别只留一条

- 同一批样本里，「逐色分离 + 单字识别」与「整图放大 + psm8」交替命中（`2051`/`4630` 逐色命中、
  `9976` 仅整图命中）。只保留一种会在换一批验证码时全灭。
- **AI 视觉兜底已验证可用**：本地 DSH 模型网关 `127.0.0.1:8045/v1/messages`
  （Anthropic Messages 协议，模型 `gemini-3.5-flash-lite`）对 2/2 张已知样本返回正确 4 位数字。
  注意该网关 **不支持** `/v1/chat/completions`（404），必须走 `/v1/messages` + `image` content block。
- **顺序**：逐色 OCR → 整图 OCR → AI 视觉 → 人工兜底（保留，因为样本量不足以宣称识别率）。

## 2026-11-12 · 想在页面里挂 XHR 钩子：必须用 addScriptToEvaluateOnNewDocument

- **踩了两次同一个坑**：用 `page.evaluate(() => { 替换 XMLHttpRequest.prototype })` 装钩子，
  然后 `page.goto(...)` —— 钩子随旧文档一起销毁，新页面里一行都抓不到（表现为 `keys: []`、`calendarStatus: null`）。
- **正解**：`page.cdp("Page.addScriptToEvaluateOnNewDocument", { source })`，钩子在每次新文档创建前注入，跨导航存活。
- **判据**：抓到「什么都没拦截」时，先怀疑钩子装晚了/装错层，再怀疑接口没被调用。
  同一个 URL，换注入方式后立刻抓到 21KB 的 `hospital/list`（309 家）。

## 2026-11-12 · `product/calendar` 的 461 已确认是稳定复现，不是偶发

在 ego lite 真实浏览器里做三组对照（同一账号、同一科室 H02110002/4011301）：

| 条件 | 结果 |
|---|---|
| 微信 UA 覆盖 + 深链进预约页 | `calendar` **461**，页面标题与「有号」筛选正常渲染 |
| 不做 UA 覆盖（原生 Mac UA） | 页面只渲染「关注/全部/有号」，`calendar` **根本没发出** |
| 先逛首页养 cookie 再进预约页 | 同上，461 |

→ 结论：**登录链路可自动化，号源接口不可**。工具的正确终态是 `waf_blocked` + 把已登录页面交接给人，
让人在窗口里手动选号（用户 14:31 的真实预约成功就是这样完成的）。

## 2026-11-12 · 「6 项 e2e 全绿」不等于链路打通：先看它到底打谁

- `tests/verify-e2e.mjs` 6/6 通过，但实测耗时 **0.14s**，且排班/下单来自 `lib/guahaoCore.js`
  里写死的 `doctorsState` 种子数据 + 本地 `data/guahao-orders.json`，**完全不触 114，也不起 Playwright**。
  它守护的是「本地业务逻辑 + 接口形状」，不是「真实挂号能成」。
- 同理，`GET /api/guahao/monitor/realtime` 才是真爬朝阳官网（本次实测返回 11 个槽位，含 7 出诊 / 4 停诊、
  血液科本部 + 常营院区 + 国际医疗部）。**「真实」与「模拟」要在测试名里写清，别让绿灯背书没测的东西。**
- 判据：声称端到端通过前，必须能说出「断言里是否发生了真实网络请求」。说不出来就是单元测试。

## 2026-11-12 · 跨项目跑测试会被文件沙箱打穿：EPERM 不是回归

在 MedBrief 会话（workspace-write，只允许 `projects/MedBrief`）里跑 MedData `npm test`：
**44 通过 / 33 失败**，失败清一色形如
`EPERM: operation not permitted, open '.../MedData/node_modules/.vite-temp/...'`。

- **判据**：报错里出现 `EPERM` + 路径在会话工作区外 → 是沙箱权限，不是代码坏了。
  这类失败必须标注「未核实」，不能写成「MedData 门禁红了」。
- 要真跑 MedData 门禁，到 MedData 自己的会话里跑（77 个脚本，`node scripts/run-unit.mjs`）。

