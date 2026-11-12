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
