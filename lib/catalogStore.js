// ===================== 114 目录本地存储（医院 / 科室） =====================
// 为什么要落盘：
//   1. hospital/list 只有让站点自己的 XHR 发出才返回 code 0000（我们直接 fetch 会被业务层拒成 8888）。
//      抓一次很贵（要起浏览器、挂钩子、等页面加载），不能每次开表单都抓。
//   2. department/list 可以直接 fetch，但每次也都要起浏览器。
//
// 策略：
//   · 医院全量 + 科室树都落盘到 data/114-catalog/*.json；
//   · 医院全量 TTL 7 天，单个医院科室树 TTL 30 天（科室变动很慢）；
//   · 过期不阻塞：先用旧数据返回并在响应里标 stale，后台再刷新；
//   · 每次真实抓取后更新 meta.json（抓取时间、数量、来源），便于排查目录是否过期。

import fs from 'node:fs'
import path from 'node:path'
import { egoRun } from './egoDriver.js'

const HOME_URL = 'https://www.114yygh.com/newhlwyl/mobile/appointmentRegisterHome?pathchannel=jt'

export const HOSPITALS_TTL_MS = 7 * 24 * 3600 * 1000
export const DEPTS_TTL_MS = 30 * 24 * 3600 * 1000

export function createCatalogStore({ dir } = {}) {
  const baseDir = dir || path.resolve('data/114-catalog')
  const hospitalsFile = path.join(baseDir, 'hospitals.json')
  const metaFile = path.join(baseDir, 'meta.json')

  function ensureDir() {
    fs.mkdirSync(baseDir, { recursive: true })
    fs.mkdirSync(path.join(baseDir, 'depts'), { recursive: true })
  }

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  function writeJson(file, data) {
    ensureDir()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  function deptFile(hosCode) {
    return path.join(baseDir, 'depts', `${String(hosCode).replace(/[^\w-]/g, '_')}.json`)
  }

  function bumpMeta(kind, payload) {
    const meta = readJson(metaFile) || {}
    meta[kind] = { ...payload, at: new Date().toISOString() }
    writeJson(metaFile, meta)
  }

  // ---------- 医院全量：必须让站点自己的 XHR 发请求 ----------
  async function captureHospitals() {
    const r = await egoRun(
      `
const { page } = await prep();
// 钩子必须用 addScriptToEvaluateOnNewDocument 才能在导航后存活
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: \`
  window.__cap = {};
  (function(){
    const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m,u,...a){ this.__m={m,u}; return oo.call(this,m,u,...a) };
    XMLHttpRequest.prototype.send = function(b){
      this.addEventListener('loadend', function(){
        try {
          const k = (this.__m.u||'').split('?')[0];
          if (/hospital\\\\/list/.test(k)) window.__cap[k] = { s:this.status, t:(this.responseText||'') };
        } catch(e){}
      });
      return os.call(this,b);
    };
  })();
\` });
await page.goto(${JSON.stringify(HOME_URL)});
await page.waitForLoadState("load");
await page.waitForTimeout(7000);
const cap = await page.evaluate(() => {
  const k = Object.keys(window.__cap||{})[0];
  return k ? window.__cap[k] : null;
});
OUT({ captured: !!cap, status: cap && cap.s, body: cap && cap.t });
`,
      { spaceName: 'medbrief-114-catalog-hospitals', timeoutMs: 240000 },
    )
    if (!r.ok) throw new Error(`医院目录抓取失败：${r.error}`)
    const { captured, status, body } = r.result
    if (!captured) throw new Error('未能捕获 hospital/list 响应（钩子未命中）')
    if (status !== 200) throw new Error(`hospital/list 返回 HTTP ${status}`)
    let json
    try {
      json = JSON.parse(body)
    } catch {
      throw new Error('hospital/list 响应不是合法 JSON')
    }
    if (!json || json.code !== '0000') {
      throw new Error(`hospital/list 业务拒绝：code=${json && json.code} ${(json && json.message) || ''}`)
    }
    return json.data
  }

  function flattenHospital(h) {
    return {
      code: h.code,
      name: h.name,
      shortName: h.hosShortName || null,
      level: h.levelText || null,
      type: h.hospitalTypeText || null,
      area: h.areaName || null,
      address: h.address || null,
      openTime: h.openTimeText || null,
      onlinePayable: !!h.onlinePayable,
      showRegister: !!h.showRegister,
      waitQueue: !!h.waitQueue,
      affiliate: h.affiliationTypeView || null,
      branch: Array.isArray(h.branchHospitalList) && h.branchHospitalList.length
        ? h.branchHospitalList.map((b) => ({
            code: b.code,
            name: b.name,
            shortName: b.hosShortName || null,
            area: b.areaName || null,
            address: b.address || null,
            openTime: b.openTimeText || null,
            onlinePayable: !!b.onlinePayable,
          }))
        : [],
    }
  }

  /** 返回 { list, fetchedAt, stale, count } */
  async function getHospitals({ force = false } = {}) {
    const cached = readJson(hospitalsFile)
    const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < HOSPITALS_TTL_MS
    if (cached && fresh && !force) {
      return { list: cached.list, fetchedAt: cached.fetchedAt, stale: false, count: cached.list.length }
    }
    if (cached && !force) {
      // 过期先用旧的，后台刷新
      refreshHospitals().catch(() => {})
      return { list: cached.list, fetchedAt: cached.fetchedAt, stale: true, count: cached.list.length }
    }
    return await refreshHospitals()
  }

  let hospitalsInflight = null
  async function refreshHospitals() {
    if (hospitalsInflight) return hospitalsInflight
    hospitalsInflight = (async () => {
      const data = await captureHospitals()
      const raw = Array.isArray(data.list) ? data.list : []
      const flat = []
      for (const h of raw) {
        flat.push(flattenHospital(h))
        for (const b of flattenHospital(h).branch) {
          flat.push({ ...b, isBranch: true, parentCode: h.code })
        }
      }
      const payload = {
        fetchedAt: new Date().toISOString(),
        branchCount: data.branchCount ?? null,
        count: data.count ?? null,
        list: flat,
      }
      writeJson(hospitalsFile, payload)
      bumpMeta('hospitals', { count: flat.length, branchCount: data.branchCount ?? null })
      return { list: flat, fetchedAt: payload.fetchedAt, stale: false, count: flat.length }
    })().finally(() => { hospitalsInflight = null })
    return hospitalsInflight
  }

  // ---------- 科室树：可直接 fetch ----------
  async function captureDepts(hosCode) {
    const r = await egoRun(
      `
const { page } = await prep();
await page.goto(${JSON.stringify(HOME_URL)});
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
      { spaceName: 'medbrief-114-catalog-depts', timeoutMs: 180000 },
    )
    if (!r.ok) throw new Error(`科室抓取失败：${r.error}`)
    const { httpStatus, payload } = r.result
    if (httpStatus !== 200 || !payload || payload.code !== '0000') {
      throw new Error(`科室抓取失败：HTTP ${httpStatus} code=${payload && payload.code} ${(payload && payload.message) || ''}`)
    }
    return (payload.data || []).map((d1) => ({
      code: d1.code,
      name: d1.name,
      advanceDay: d1.advanceDay ?? null,
      nationalKeyDept: !!d1.nationalKeyDept,
      subs: (d1.subList || []).map((d2) => ({
        code: d2.code,
        name: d2.name,
        advanceDay: d2.advanceDay ?? null,
        nationalKeyDept: !!d2.nationalKeyDept,
      })),
    }))
  }

  async function getDepts(hosCode, { force = false } = {}) {
    const file = deptFile(hosCode)
    const cached = readJson(file)
    const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < DEPTS_TTL_MS
    if (cached && fresh && !force) {
      return { hosCode, list: cached.list, fetchedAt: cached.fetchedAt, stale: false }
    }
    if (cached && !force) {
      refreshDepts(hosCode).catch(() => {})
      return { hosCode, list: cached.list, fetchedAt: cached.fetchedAt, stale: true }
    }
    return await refreshDepts(hosCode)
  }

  const deptInflight = new Map()
  async function refreshDepts(hosCode) {
    if (deptInflight.has(hosCode)) return deptInflight.get(hosCode)
    const p = (async () => {
      const list = await captureDepts(hosCode)
      const payload = { hosCode, fetchedAt: new Date().toISOString(), list }
      writeJson(deptFile(hosCode), payload)
      bumpMeta(`depts:${hosCode}`, { count: list.length })
      return { hosCode, list, fetchedAt: payload.fetchedAt, stale: false }
    })().finally(() => deptInflight.delete(hosCode))
    deptInflight.set(hosCode, p)
    return p
  }

  function stats() {
    const hosp = readJson(hospitalsFile)
    const meta = readJson(metaFile) || {}
    let deptFiles = []
    try {
      deptFiles = fs.readdirSync(path.join(baseDir, 'depts')).filter((f) => f.endsWith('.json'))
    } catch {}
    return {
      hospitals: hosp ? { count: hosp.list.length, fetchedAt: hosp.fetchedAt, branchCount: hosp.branchCount } : null,
      deptCaches: deptFiles.map((f) => {
        const d = readJson(path.join(baseDir, 'depts', f))
        return { hosCode: d?.hosCode, count: d?.list?.length ?? 0, fetchedAt: d?.fetchedAt }
      }),
      meta,
    }
  }

  return { getHospitals, getDepts, refreshHospitals, refreshDepts, stats, baseDir }
}
