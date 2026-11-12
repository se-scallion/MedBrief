// ===================== ego-browser 驱动层 =====================
// 为什么不直接用 Playwright：
//   2026-11-12 实测 —— Playwright 自带的 Chromium 与 Googht Chrome（无头/有头都试过）
//   打开 114 首页时文档层直接返回 202（瑞数挑战页）且不完成挑战，页面空白，
//   后续业务接口全部 462。ego lite 的 Chromium（真实指纹 + 独立 profile）可正常通过。
//   因此浏览器动作统一交给 ego-browser 执行。
//
// 通信方式：每次动作 = 一次 `ego-browser nodejs` 子进程，脚本经 stdin 传入（避免 shell 引号问题）。
// 页面与 task space 跨进程持久，因此多步流程可以分多次调用完成；
// 但 CDP 的 UA 覆盖只在单次调用内有效，每个动作都必须重新注入（见 .agents/testing-lessons.md）。

import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const EGO_BIN =
  process.env.MEDBRIEF_EGO_BIN || path.join(os.homedir(), '.local', 'bin', 'ego-browser')

export const WX_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.54(0x18003632) NetType/WIFI Language/zh_CN'

const RESULT_TAG = '__RESULT__'
const ERR_TAG = '__ERROR__'

function preamble(spaceName) {
  return `
const SPACE = ${JSON.stringify(spaceName)};
const WX = ${JSON.stringify(WX_UA)};
const OUT = (v) => { console.log(${JSON.stringify(RESULT_TAG)} + JSON.stringify(v)); };
const FAIL = (m) => { console.log(${JSON.stringify(ERR_TAG)} + JSON.stringify(String(m))); };
async function prep() {
  const task = await taskSpace(SPACE);
  const page = task.page("p1");
  await page.cdp("Network.enable", {});
  await page.cdp("Network.setUserAgentOverride", {
    userAgent: WX,
    platform: "iPhone",
    acceptLanguage: "zh-CN,zh;q=0.9",
  });
  return { task, page };
}
`
}

/** 执行一段 ego-browser 脚本，返回 { ok, result, error, stdout, stderr } */
export function egoRun(bodyScript, { spaceName = 'medbrief-114', timeoutMs = 180000 } = {}) {
  const script = preamble(spaceName) + bodyScript
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(EGO_BIN, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: `无法启动 ego-browser：${e.message}` })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      resolve({ ok: false, error: `ego-browser 超时（${timeoutMs}ms）`, stdout: out, stderr: err })
    }, timeoutMs)

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: `ego-browser 执行失败：${e.message}`, stdout: out, stderr: err })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = out + '\n' + err
      const errLine = text.split('\n').find((l) => l.startsWith(ERR_TAG))
      const resLine = [...text.split('\n')].reverse().find((l) => l.startsWith(RESULT_TAG))
      if (errLine) {
        let msg = errLine.slice(ERR_TAG.length)
        try { msg = JSON.parse(msg) } catch {}
        resolve({ ok: false, error: msg, stdout: out, stderr: err })
        return
      }
      if (resLine) {
        let data = null
        try { data = JSON.parse(resLine.slice(RESULT_TAG.length)) } catch (e) {
          resolve({ ok: false, error: '结果解析失败: ' + e.message, stdout: out, stderr: err })
          return
        }
        resolve({ ok: true, result: data, stdout: out, stderr: err })
        return
      }
      resolve({ ok: false, error: '未取得执行结果', stdout: out, stderr: err })
    })

    child.stdin.end(script)
  })
}

// ---------- 具体动作 ----------

/** 打开登录页 → 真实键盘输手机号 → 勾协议 → 点获取验证码 → 取图形码图 */
export function egoLoginRequestSms({ spaceName, phone, captchaPath }) {
  return egoRun(
    `
const { page } = await prep();
const LOGIN = "https://www.114yygh.com/newhlwyl/mobile/login?pathchannel=jt";
await page.goto(LOGIN);
await page.waitForLoadState("load");
await page.waitForSelector('input[placeholder="请输入您的手机号"]', { timeout: 15000 });

// 手机号必须真实键盘输入：fill() 不更新 Vue model
await page.click('input[placeholder="请输入您的手机号"]');
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type(${JSON.stringify(phone)});
const typed = await page.evaluate(() => document.querySelector('input[placeholder="请输入您的手机号"]').value);
if (typed !== ${JSON.stringify(phone)}) FAIL("手机号输入校验失败: " + typed);

// 协议勾选：先滚到视口中央再点
await page.evaluate(() => { const el = document.querySelector(".van-checkbox__icon"); if (el) el.scrollIntoView({ block: "center" }); });
await page.waitForTimeout(300);
if (!(await page.evaluate(() => !!document.querySelector(".van-checkbox__icon--checked")))) {
  await page.click(".van-checkbox__icon");
  await page.waitForTimeout(400);
}
const checked = await page.evaluate(() => !!document.querySelector(".van-checkbox__icon--checked"));
if (!checked) FAIL("协议勾选失败");

const disabled = await page.evaluate(() => { const b = document.querySelector("div.again-button"); return !b || b.className.includes("disabled"); });
if (disabled) FAIL("「获取验证码」仍为 disabled");

await page.evaluate(() => { const b = [...document.querySelectorAll("div")].find(e => /获取验证码/.test(e.textContent || "") && e.children.length === 0); if (b) b.scrollIntoView({ block: "center" }); });
await page.waitForTimeout(300);
await page.click("loc=css:div.again-button");
await page.waitForTimeout(2200);

const hasPopup = await page.evaluate(() => !!document.querySelector(".van-popup--center.popup"));
if (!hasPopup) { OUT({ needCaptcha: false, smsPage: true }); } else {
  const dataUrl = await page.evaluate(() => {
    const im = [...document.querySelectorAll("img")].find(x => (x.src || "").startsWith("blob:"));
    if (!im) return null;
    return new Promise((resolve, reject) => {
      fetch(im.src).then(r => r.blob()).then(b => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(b);
      }).catch(reject);
    });
  });
  if (!dataUrl) FAIL("图形验证码图片获取失败");
  OUT({ needCaptcha: true, dataUrl });
}
`,
    { spaceName },
  )
}

/** 填图形验证码并提交，等待短信发出 */
export function egoSubmitCaptcha({ spaceName, code }) {
  return egoRun(
    `
const { page } = await prep();
const popupSel = ".van-popup--center.popup";
if (!(await page.evaluate((s) => !!document.querySelector(s), popupSel))) { OUT({ smsRequested: false, reason: "no-popup" }); } else {
  await page.click("loc=css:" + popupSel + " input");
  await page.keyboard.type(${JSON.stringify(code)});
  await page.waitForTimeout(500);
  if (await page.evaluate((s) => !!document.querySelector(s), popupSel)) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
  }
  const stillOpen = await page.evaluate((s) => !!document.querySelector(s), popupSel);
  OUT({ smsRequested: !stillOpen, popupStillOpen: stillOpen, url: await page.url() });
}
`,
    { spaceName },
  )
}

/** 填 6 位短信验证码，校验登录态 */
export function egoSubmitSms({ spaceName, code }) {
  return egoRun(
    `
const { page } = await prep();
const sel = 'input[maxlength="6"], input[type="tel"]';
await page.waitForSelector(sel, { timeout: 15000 });
await page.click("loc=css:" + sel);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type(${JSON.stringify(code)});
await page.waitForTimeout(3500);

const r = await page.fetch("https://www.114yygh.com/jtjk/mobile-service/user/get", {
  method: "POST",
  headers: { "content-type": "application/json;charset=UTF-8", "Request-Source": "JT" },
  body: "{}",
  timeout: 10000,
});
let data = null;
try { data = JSON.parse(r.body); } catch (e) {}
OUT({ status: r.status, url: await page.url(), user: data });
`,
    { spaceName },
  )
}

/** 打开就诊人列表，返回页面文本 */
export function egoCheckPatient({ spaceName }) {
  return egoRun(
    `
const { page } = await prep();
await page.goto("https://www.114yygh.com/newhlwyl/mobile/patient/list?pathchannel=jt");
await page.waitForLoadState("load");
await page.waitForTimeout(1800);
const text = await page.evaluate(() => document.body.innerText || "");
OUT({ url: await page.url(), text });
`,
    { spaceName },
  )
}

/** 打开预约页并等号源接口；捕获 calendar 响应与状态 */
export function egoLoadSchedule({ spaceName, hosCode, dept1Code, dept2Code }) {
  const url =
    `https://www.114yygh.com/newhlwyl/mobile/appointmentRegister?hosCode=${hosCode}` +
    `&dept2Code=${dept2Code}&type=2&dept1Code=${dept1Code}&pathchannel=jt`
  return egoRun(
    `
const { page } = await prep();
// 钩子必须用 addScriptToEvaluateOnNewDocument 才能在导航后存活（page.evaluate 装的钩子会随文档销毁）
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: \`
  window.__cal = null;
  window.__calStatus = null;
  window.__calBody = null;
  (function(){
    const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u, ...r) { this.__m = { m, u }; return oo.call(this, m, u, ...r); };
    XMLHttpRequest.prototype.send = function(b) {
      this.addEventListener("loadend", function() {
        try {
          if (/\\\\/product\\\\/calendar/.test(this.__m.u)) {
            window.__calStatus = this.status;
            window.__calBody = (this.responseText || "").slice(0, 500000);
            if (this.status === 200) { try { window.__cal = JSON.parse(this.responseText); } catch(e) {} }
          }
        } catch (e) {}
      });
      return os.call(this, b);
    };
  })();
\` });
await page.goto(${JSON.stringify(url)});
await page.waitForLoadState("load");
await page.waitForTimeout(1800);
for (const t of ["确认", "我知道了"]) {
  try { await page.click("text=" + t, { timeout: 2000 }); await page.waitForTimeout(1000); break; } catch (e) {}
}
await page.waitForTimeout(5000);
const st = await page.evaluate(() => window.__calStatus);
const cal = await page.evaluate(() => window.__cal || null);
const bodyLen = await page.evaluate(() => (window.__calBody || "").length);
const text = await page.evaluate(() => (document.body.innerText || "").slice(0, 1500));
OUT({ url: await page.url(), calendarStatus: st, calendar: cal, bodyLen, text });
`,
    { spaceName, timeoutMs: 240000 },
  )
}

/** 在预约页点击目标号源并尝试提交，返回提交后页面文本 */
export function egoSubmitSlot({ spaceName, labels }) {
  const labelList = JSON.stringify(labels || [])
  return egoRun(
    `
const { page } = await prep();
const labels = ${labelList};
let clicked = null;
for (const t of labels) {
  try {
    const n = await page.evaluate((x) => {
      const nodes = [...document.querySelectorAll("div,span,li,button,a,p")];
      return nodes.filter(e => e.children.length === 0 && (e.textContent || "").includes(x)).length;
    }, t);
    if (n > 0) { await page.click("text=" + t, { timeout: 4000 }); clicked = t; break; }
  } catch (e) {}
}
if (!clicked) {
  clicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("div,span,li,button,a")];
    const hit = nodes.find(n => n.children.length === 0 && /有号|剩余\\s*\\d+|可预约|立即预约/.test(n.textContent || ""));
    if (!hit) return null;
    hit.scrollIntoView({ block: "center" });
    hit.click();
    return hit.textContent.trim().slice(0, 40);
  });
}
await page.waitForTimeout(3000);
for (const t of ["确认", "我知道了"]) { try { await page.click("text=" + t, { timeout: 1500 }); await page.waitForTimeout(800); break; } catch (e) {} }

const beforeText = await page.evaluate(() => (document.body.innerText || "").slice(0, 1500));
const needPay = /需支付|去支付|立即支付|微信支付|支付宝支付/.test(beforeText);

let submitted = null;
if (!needPay) {
  for (const t of ["确认预约", "确认挂号", "提交预约", "立即预约", "确认订单", "提交订单", "确定", "提交"]) {
    try {
      const n = await page.evaluate((x) => {
        const nodes = [...document.querySelectorAll("div,span,button,a")];
        return nodes.filter(e => e.children.length === 0 && (e.textContent || "").trim() === x).length;
      }, t);
      if (n > 0) { await page.click("text=" + t, { timeout: 4000 }); submitted = t; break; }
    } catch (e) {}
  }
}
await page.waitForTimeout(4500);
const afterText = await page.evaluate(() => (document.body.innerText || "").slice(0, 2000));
OUT({ clicked, submitted, needPay, url: await page.url(), beforeText, afterText });
`,
    { spaceName, timeoutMs: 240000 },
  )
}

/** 截图存档 */
export function egoScreenshot({ spaceName, outPath }) {
  return egoRun(
    `
const { page } = await prep();
const p = await page.screenshot({ path: ${JSON.stringify(outPath)} });
OUT({ path: p, url: await page.url() });
`,
    { spaceName },
  )
}

/** 结束 task space（关闭其管理的页面） */
export function egoFinish({ spaceName }) {
  return egoRun(
    `
const task = await taskSpace(SPACE);
try { await task.finish({ keep: [] }); OUT({ closed: true }); } catch (e) { OUT({ closed: false, error: String(e).slice(0, 120) }); }
`,
    { spaceName, timeoutMs: 60000 },
  )
}

// ---------- 目录类接口（免登录，经 ego 页面内 fetch 通过瑞数 WAF） ----------
// 实测（2026-11-12）：department/list 稳定返回 code 0000；
// hospital/list 虽能过 WAF（HTTP 200），业务层却固定返回 8888「系统繁忙」，
// 说明该接口需要站点自身注入的瑞数令牌参数，直接 fetch 无法复现 → 医院列表列为「尽力而为」，
// 医院编码改为由用户填写（科室树仍可自动加载）。
export function egoFetchHospitals({ spaceName = 'medbrief-114-catalog' } = {}) {
  return egoRun(
    `
const { page } = await prep();
await page.goto("https://www.114yygh.com/newhlwyl/mobile/appointmentRegisterHome?pathchannel=jt");
await page.waitForLoadState("load");
await page.waitForTimeout(2000);
const r = await page.fetch("https://www.114yygh.com/jtjk/mobile-service/hospital/list", {
  method: "POST",
  headers: { "content-type": "application/json;charset=UTF-8", "Request-Source": "JT" },
  body: "{}",
  timeout: 20000,
});
let j = null;
try { j = JSON.parse(r.body); } catch (e) {}
OUT({ httpStatus: r.status, payload: j, rawLen: r.body.length });
`,
    { spaceName, timeoutMs: 120000 },
  )
}

export function egoFetchDepts({ spaceName = 'medbrief-114-catalog', hosCode }) {
  return egoRun(
    `
const { page } = await prep();
await page.goto("https://www.114yygh.com/newhlwyl/mobile/appointmentRegisterHome?pathchannel=jt");
await page.waitForLoadState("load");
await page.waitForTimeout(1500);
const r = await page.fetch("https://www.114yygh.com/jtjk/mobile-service/department/list/" + ${JSON.stringify(hosCode)}, {
  method: "GET",
  headers: { "Request-Source": "JT" },
  timeout: 20000,
});
let j = null;
try { j = JSON.parse(r.body); } catch (e) {}
OUT({ httpStatus: r.status, payload: j });
`,
    { spaceName, timeoutMs: 120000 },
  )
}

/** 复用已有登录态：直接查 /user/get，不碰登录页 */
export function egoCheckLogin({ spaceName = 'medbrief-114-session' } = {}) {
  return egoRun(
    `
const { page } = await prep();
await page.goto("https://www.114yygh.com/newhlwyl/mobile/appointmentRegisterHome?pathchannel=jt");
await page.waitForLoadState("load");
await page.waitForTimeout(2500);
const r = await page.fetch("https://www.114yygh.com/jtjk/mobile-service/user/get", {
  method: "POST",
  headers: { "content-type": "application/json;charset=UTF-8", "Request-Source": "JT" },
  body: "{}",
  timeout: 10000,
});
let j = null;
try { j = JSON.parse(r.body); } catch (e) {}
const loggedIn = !!(j && j.code === "0000" && j.data && (j.data.mobileConfound || j.data.userId));
OUT({ httpStatus: r.status, loggedIn, user: j && j.data ? j.data : null });
`,
    { spaceName, timeoutMs: 120000 },
  )
}
