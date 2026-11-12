# MEMORY — MedBrief 挂号口径

只放跨会话可复用的判据与用户拍板的口径；排查细节见 testing-lessons.md，接口全貌见 architecture.md。

## 访问 114yygh.com 的两个硬条件（2026-11-12 实测，缺一不可）

- **UA 必须含 `MicroMessenger`**。缺它 → 瑞数 WAF 直接返回 **462**（`content-length: 0`、`server: unicom`、`x-cache: BYPASS`），
  业务代码根本没被执行。实测：Chrome UA 下 9/10 请求 462；换微信 UA 后全 200。
- **渠道必须走 `pathchannel=jt`（京通，渠道 value 16）**。用 `pathchannel=dp`（点评/大众点评，value 32）
  → 业务层返回 `{"code":"8888","message":"点评用户授权失败，请退出北京114预约挂号页面重新进入"}`。
  两条件齐备时：14 个请求全 `code 0000`，首页「共 309 家医院」正常渲染。`wechat` 渠道会跳授权页，不可直连。

## 不要用 curl / requests 直连接口

瑞数的 `HKNCYzbu` 令牌由页面 JS 动态生成，且与 TLS/UA 环境绑定。实测拿浏览器真 cookie（含 HttpOnly）回放，
经 Clash 与绕过 Clash **都仍是 462** —— 这条路走不通，必须用真实浏览器内核（ego lite / Playwright 实体 Chromium）。

## 登录链路（已跑通到短信发出）

手机号 → **图形验证码**（`GET /captcha`，先过这步才发短信）→ 短信（`POST /phoneCode`，返回 `data.time=60` 冷却）
→ 提交验证码完成登录。图形码是 4 位数字，可从页面 `<img>` 的 blob 取出识别。

## 账号与对象

- 挂号手机号：`15600570051`（用户本人）。
- 用户口径：**只给自己挂号**，不做代挂/黄牛。
- 站点《预约挂号服务协议》通常禁止程序化抢号；轮询须低频（≥30s），放号时刻才提速。

## 放号规则（项目既有口径，2026-11-12 复核仍在用）

北京朝阳医院 血液科：**每日 07:00 放第 14 天号源**；监控脚本沿用 README 中的毫秒级倒计时 + 蜂鸣预警设计。
