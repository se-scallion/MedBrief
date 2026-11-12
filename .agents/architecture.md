# 114 挂号平台架构与接口地图（2026-11-12 实抓）

## 三层结构

```
浏览器(Vue SPA)  →  瑞数 WAF（Riversafe，$_ts 混淆 JS，动态令牌 HKNCYzbu）
                 →  业务 API（/jtjk/mobile-service/**，JSON，code 0000 成功）
```

- 静态资源与页面：`https://www.114yygh.com/newhlwyl/mobile/**`（Vue 3 + vant，分包 220 个，主包 `index.<hash>.js`）
- 接口前缀：`https://www.114yygh.com/jtjk/mobile-service`
- CNAME 指向 `cf192c87b3.uniwaf.com`（云 WAF），解析到 `220.250.70.x` / `220.250.77.x`，`Server: unicom`
- 每个 XHR 都自动带 `request-source`（渠道英文名）与 `HKNCYzbu`（瑞数动态令牌）两个头

## 渠道表（`common.js` 原文，value/key）

| value | 标签 | key |
|---|---|---|
| 15 | 北京通 | `BJT` |
| **16** | **京通** | **`JT`** ← 当前可用渠道 |
| 17/18/19 | 支付宝京通 / 微信京通 / 百度京通 | `JT_ALIPAY` / `JT_WECHAT` / `JT_BAIDU` |
| 20 | 京医通 | `JYT` |
| 21 | 北京联通114综合服务 | `UNICOM_SERVICE` |
| 22 | 健康北京 | `HEALTH_BJ` |
| **31** | **美团** | **`MEITUAN`** |
| **32** | **点评（大众点评）** | **`DIANPING`** ← 需点评侧授权，会返 8888 |

URL 参数 → 渠道的映射在页面内联脚本里，键即 `pathchannel` 的取值（如 `jt`→`JT`、`dp`→`DIANPING`、`bjapp`/`miniprogram`→`UNICOM_SERVICE`）。

## 接口地图（实测返回均 `code 0000`）

| 用途 | 接口 | 备注 |
|---|---|---|
| 医院列表 | `POST /hospital/list` | 返回 `branchCount`/`count`（实测 309/286） |
| 医院详情 | `GET /hospital/detail/{hosCode}` | 含院区、地址、公告 |
| 科室列表 | `GET /department/list/{hosCode}` | 含 `advanceDay`（可提前天数） |
| 用户登录态 | `POST /user/get` | 未登录返回 `login:false` |
| 图形验证码 | `GET /captcha` | 4 位数字，返回图片流 |
| 发送短信 | `POST /phoneCode` | body `{contactPhoneNo:<加密串>}`，回 `data.time=60` 冷却 |
| 收藏/画像 | `GET /user/collect/hospital/pic/list`、`/user/collect/newHospital/{hosCode}` | 非关键 |
| 功能开关 | `GET /mobile/funCheck/functionSwitchCheck` | 埋点/体检等开关 |
| 平台公告 | `GET /platform_anno/get_anno_content` | 停诊/公告 |
| 行为埋点 | `POST /behavior/operate/records` | 每次操作都上报，注意频率 |

> 注意：手机号在请求体里是**加密串**（`contactPhoneNo` 为长 hex），不是明文；前端由 JS 加密后再发。
> 因此不要试图手工构造该字段，必须让页面自己发。

## 登录状态机

```
打开 /newhlwyl/mobile/login?pathchannel=jt
  → 输入手机号（真实键盘输入）
  → 勾选《预约挂号服务协议》
  → 点「获取验证码」→ GET /captcha（弹窗：图形验证码 + 图片）
  → 填图形码 → POST /phoneCode（短信发出，60s 冷却）
  → 填短信码 → 登录成功，cookie 保持会话
  → 后续 /user/get 返回登录态
```

## 抓包方法（ego-browser）

```js
await page.cdp("Network.enable", {});
await page.cdp("Network.setUserAgentOverride", { userAgent: WX, platform: "iPhone" });
await page.evaluate(() => { /* 挂钩 XMLHttpRequest.open/send 记录 url/status/req/res */ });
// 注意：UA 覆盖与注入脚本只对当前进程有效，多步流程须一次跑完
```

已存证截图（ds-bot workspace）：
`114_jt_ok.png`（309 家医院正常）、`114_login.png`、`114_captcha.png`、`captcha_2.png`（图形码 `7507`）。
