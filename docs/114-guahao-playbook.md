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

---

## 自动化执行（已固化，推荐优先用它）

手工步骤以上各节仍然有效，但日常操作请直接用脚本，不要重复手工：

```bash
# 1) 拉科室树（免登录，可用来验证医院编码）
node tools/browser-guahao.mjs --list-depts H02110002

# 2) 验证码识别自检（给一张图，看三级识别各自结果）
node tools/browser-guahao.mjs --solver-check path/to/captcha.png

# 3) 跑完整挂号（会真实发短信、真实下单）
node tools/browser-guahao.mjs \
  --phone <11位手机号> \
  --hos-code H02110002 \
  --dept1-code yygh_NK_4d2b43fd_vir \
  --dept2-code 4011301 \
  --patient-name 代聪 --doctor 张三 --date 2026-11-20
```

网页表单等价入口：`http://127.0.0.1:5174` → 「就诊人与预约」→「114 真实挂号（浏览器自动流程）」。

### 行为约定

| 场景 | 行为 |
|---|---|
| 指定了医生 | **直接提交**（114 预约不扣费；加 `--no-auto-submit` 可改为停下确认） |
| 未指定医生 | 停在确认环节，等人点头 |
| 图形验证码 | 逐色 OCR → 整图 OCR → AI 视觉 → 表单/终端手动填 |
| 短信验证码 | 必须人工抄录填入（脚本无法代收） |
| 号源接口被 WAF 拦（461） | 报 `waf_blocked`，页面保持登录态，转人工或等 30–60 分钟 |
| 未绑定就诊人 | 报 `need_patient`，需本人身份证完成实名认证 |

### 退出码（命令行）

`0` 成功 · `1` 失败 · `2` 被 WAF 拦截 · `3` 需人工处理（就诊人/确认/验证码）
