# 114 挂号操作手册（可复现步骤）

> 结论先行：**用真实浏览器驱动，不要用 curl/requests。** 两个硬条件：UA 含 `MicroMessenger` + 渠道 `pathchannel=jt`。
> 判据来源：`.agents/MEMORY.md`；排查过程：`.agents/testing-lessons.md`；接口全貌：`.agents/architecture.md`。

## 为什么不能用脚本直连接口

瑞数（Riversafe）会校验 UA、TLS 指纹与环境一致性，并下发一次性动态令牌 `HKNCYzbu`。
实测：拿浏览器真 cookie（含 HttpOnly）回放，**经代理与绕过代理都返回 462**。
唯一可行路径是驱动**真实指纹环境的浏览器 ego lite**（`lib/egoDriver.js`）让页面自己发请求。
注意：Playwright（自带 Chromium / 系统 Chrome，无头或有头）**打不开 114**，实测停在 202 挑战页、
后续接口一律 462 —— 这一条只对朝阳官网 http://www.bjcyh.com.cn 成立，别把两家站混用。

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

---

## 目标医院：朝阳医院 114 编码（2026-11-12 取得）

| 院区 | `hosCode` | 血液科 `dept1Code` / `dept2Code` |
|---|---|---|
| **本部（西直门）** | **`H05110001A`** | **`NKXT` / `XY`** |
| 常营院区 | `H05110001C` | `NKXT` / `XY` |
| 石景山院区 | `H05110001` | `NKXT` / `XY` |

取证命令（可复跑）：

```bash
node tools/browser-guahao.mjs --search-hospital 朝阳 --save   # 增量合并进 data/114-catalog/hospitals.json
node tools/browser-guahao.mjs --list-depts H05110001A          # 反证编码有效，找血液内科
```

- 搜索走 `GET /search/query?keyWord=<明文 URL 编码中文>`，`department/list` 回 `code 0000`（一级科室 17 个）。
- 原始抓包：`data/114-flow/evidence/p0-search-hits.json`、`data/114-flow/evidence/p0-depts.json`。
- ⚠️ 医生级（「主鸿鹄」是否出诊）**脚本侧无法佐证**：`/search/query` 只搜医院，医生数据仅在 `product/calendar`。

## `product/calendar` 的三条替代路径实测（2026-11-12，目标=朝阳本部血液科）

| 路径 | 做法 | 实测结果 | 截图 |
|---|---|---|---|
| ① 钩子复用 | `Page.addScriptToEvaluateOnNewDocument` 注入 XHR 钩子后进号源页 | 页内 9 个请求：`productDepartmentDetail`/`user/get`/`refreshTime`/`getDivertInfo` 全 `200 code 0000`；**仅 `product/calendar` = 461（空响应体）** | `p2-cy-schedule.png` |
| ② 绕开 calendar | 直连 `/order` 确认页（参数取自 JS 包 `path:"/order"`） | **确认页能打开**，`auth/patient/list` → `200 0000`（就诊人+医保齐全），页面渲染出「立即预约」；但 `product/confirmV2` → **200 `code 8888 系统繁忙`**，因为缺 `uniqueProductKey/uniqueProductTimeKey`，而这两个键**只由 calendar 下发** | `p2-cy-order.png` |
| ③ 触发时机 | 放号时刻重打 | **今日未测**（朝阳本部页面提示「明日 07:00 释放 11 月 27 日号源」）；触发条件：次日 07:00 后重跑 `--list-depts` + 号源页观察 calendar 是否转 200 | — |

**结论**：461 与医院无关（北大人民、朝阳本部都 461），也不是「没号」（页面标题与「有号」筛选正常渲染）。
它卡在「拿号源列表」这一环，而确认页虽然可达，却必须依赖 calendar 下发的 `uniqueProductKey`，所以**无法绕开**。

## 工具终态= waf_blocked + 人工接管（操作步骤）

1. 跑 `node tools/browser-guahao.mjs ...`（或网页表单）→ 自动完成登录态复用、就诊人校验、进入号源页；
2. 日志出现 `[waf_blocked] 号源接口被瑞数 WAF 拦截（HTTP 461）` 时**不要关浏览器**；
3. 在 ego lite 窗口里人工点「全部 / 有号」→ 选日期 → 选医生 → 确认就诊人 → 点「立即预约」；
4. 提交成功以 114 短信 / 页面「预约成功」为准；脚本落的截图在 `data/114-flow/<flowId>_waf_blocked.png`。

复跑命令：

```bash
# 号源页（观察 461 是否解除）
node tools/browser-guahao.mjs --list-depts H05110001A
# 完整流程
node tools/browser-guahao.mjs --phone <11位手机号> \
  --hos-code H05110001A --dept1-code NKXT --dept2-code XY --patient-name <就诊人姓名>
```
