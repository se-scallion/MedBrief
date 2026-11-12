# 114 挂号操作手册（可复现步骤）

> 结论先行：**用真实浏览器驱动，不要用 curl/requests。** 两个硬条件：UA 含 `MicroMessenger` + 渠道 `pathchannel=jt`。
> 判据来源：`.agents/MEMORY.md`；排查过程：`.agents/testing-lessons.md`；接口全貌：`.agents/architecture.md`。

## 为什么不能用脚本直连接口

瑞数（Riversafe）会校验 UA、TLS 指纹与环境一致性，并下发一次性动态令牌 `HKNCYzbu`。
实测：拿浏览器真 cookie（含 HttpOnly）回放，**经代理与绕过代理都返回 462**。
唯一可行路径是驱动真实 Chromium（ego lite / Playwright 实体浏览器）让页面自己发请求。

## Step 0 · 环境准备（每次会话都要做）

```js
const WX = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 "
         + "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.54(0x18003632) NetType/WIFI Language/zh_CN";
await page.cdp("Network.enable", {});
await page.cdp("Network.setUserAgentOverride", { userAgent: WX, platform: "iPhone", acceptLanguage: "zh-CN,zh;q=0.9" });
```

```bash
# 可直接访问的 URL（注意 pathchannel=jt）
https://www.114yygh.com/newhlwyl/mobile/appointmentRegisterHome?pathchannel=jt
```

**验收**：页面出现「共 309 家医院」。若显示「数据加载失败」→ 检查 UA 是否生效（ego-browser 的 UA 覆盖不跨进程）。

## Step 1 · 登录

1. 打开 `…/mobile/login?pathchannel=jt`。
2. 手机号：**必须真实键盘输入**（`mouse.click` 聚焦 + `keyboard.type`），`page.fill` 不会更新 Vue model。
3. 勾选《预约挂号服务协议》：点 `.van-checkbox__icon`。
4. 点「获取验证码」：**先 `scrollIntoView({block:'center'})` 再取坐标点击**（按钮常在视口下方，直接点会落空）。
5. 弹出图形验证码：取页面 `<img>`（`blob:` 需在页面内 `fetch` 转 base64 落盘）→ 识别 4 位数字 → 填入 → 提交。
6. 短信到达后填入 6 位验证码完成登录。冷却 60s（`/phoneCode` 返回 `data.time=60`）。

**验收**：`POST /user/get` 返回登录态；页面「去登录」变为用户名。

## Step 2 · 就诊人

首次登录需建就诊人档案（姓名 / 身份证 / 手机）。部分医院要求实名核验或人脸，**这步必须本人操作**。

## Step 3 · 选号（游客即可浏览）

| 步骤 | 接口 |
|---|---|
| 医院列表 | `POST /hospital/list` |
| 医院详情/院区 | `GET /hospital/detail/{hosCode}` |
| 科室列表 | `GET /department/list/{hosCode}` |
| 排班/号源 | 进入科室后由页面加载（`advanceDay` 指示可提前天数） |

监控策略：**低频轮询**（≥30s）保活 + 放号时刻（北京朝阳医院血液科为每日 07:00 放第 14 天号源）提速。
不要在非放号时段高频刷，会触发风控。

## Step 4 · 提交订单

选中号源 → 确认就诊人 → 提交。部分医院需在线支付。
**建议停在此步由人确认**，避免自动误下单/误扣款。

## 验收清单

- [ ] 医院列表出现「共 309 家医院」
- [ ] `/user/get` 返回登录态
- [ ] 目标科室能列出医生与日期
- [ ] 目标日期号源 `remaining > 0` 时能进入确认页

## 已知限制与风险

- 自动化操作可能违反《预约挂号服务协议》；**仅为自己挂号，不代挂、不并发抢号**。
- 短信与图形验证码有频率限制，重试要留间隔。
- 站点结构随时可能调整（渠道表、接口前缀、验证流程），改动后按 `architecture.md` 的抓包方法重新取证，不要沿用旧结论。
