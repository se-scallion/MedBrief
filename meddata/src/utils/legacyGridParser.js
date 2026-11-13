// legacyGridParser.js
// 旧版（dist/assets/index-BaLXD7fr.js，2026-08-21 15:51 可识别 26 项）行内还原逻辑移植。
// 核心：gp（行聚类 + 双栏分栏 + 行对象生成）、cd（按 x 间距>40 重拆 token）、
// Xa（左右分别解析并 pp 拼接 NEUT%+% 还原）、pp/id/o$/hp/Ro/gs/ps 等解析链路。
// 该模块只负责「解析/分栏/过滤/去重」，双栏检测由调用方（ocr.js 的 12% 法）注入 splitX，
// 以严格遵守「保留 12% 双栏检测」的红线。
//
// 返回格式与 buildGridFromItems 一致：二维数组 [[name,value,ref,unit,arrow], ...]（不含表头）。

// ---------- 基础判断 ----------
const gs = (e) =>
  /^(<|>|≤|≥|约|阴性|阳性|弱阳性|可疑|正常|异常|未检出|[OAB]{1,2}型|Rh\(D\)[+-−]|\d+\.\d*\s*-\s*\d+\.\d*|\d+\s*-\s*\d+|\d+(\.\d*)?([-–—~]\d+(\.\d*)?))$/.test(
    e
  )
const ps = (e) =>
  /^(\d+(\.\d*)?|\d+\.\d*\s*-\s*\d+\.\d*|\d+\s*-\s*\d+)$/.test(e)
const Ro = (e) =>
  /[一-龥]/.test(e)
    ? false
    : /^(s|%|L|U|g|dL|mL|uL|fL|IU|mol|mmol|ng|ug|mg|pg|dl|cl|fl)$/i.test(e)
const ld = /^\d+$|^\d*\.\d*$|^\.$|^[-–—~]$/
const a$ = /^\d+(\.\d*)?([-–—~]\d+(\.\d*)?)?$/
const ad = /^(<|>|≤|≥)?\d+(\.\d*)?%?$|^(阴性|阳性|弱阳性|可疑|正常|异常|未检出|[OAB]{1,2}型|Rh\(D\)[+-−])$|^-$|^[Nn]ormal$/
const s$ = [
  [/^£L$/i, 'fL'],
  [/^tL$/i, 'fL'],
  [/^LL$/i, 'fL'],
]
function hp(e) {
  for (const [t, n] of s$) if (t.test(e)) return n
  return e
}

// 把「名称 数值 单位」粘连 token 拆开，如 "NEUT%0.49" → ["NEUT%","0.49"]
function o$(e) {
  const t = e.match(/^([A-Za-z#%]+)\s+(\d+(?:\.\d*)?)\s*([^\s]*)$/)
  return t ? [t[1], t[2], t[3]].filter(Boolean) : [e]
}

// 清洗项目名称：去掉前导序号、竖线/星号杂质、中文粘连
function pp(e) {
  let t = String(e || '').trim()
  t = t.replace(/[|丨｜★☆＊※●○■□◆◇△▲*+$]/g, '')
  const n = t
  for (; t.length > 1 && /^[玄妇广米术去紊畜廊康妈宽型丸]/.test(t); ) t = t.slice(1).trim()
  if (!t) t = n
  t = t.replace(/([一-龥])\s+(?=[一-龥])/g, '$1')
  t = t.replace(/^\d{1,2}\s+/, '')
  return t
}

// 归一行文本（全角转半角、中文粘连、数字-连字符）
function id(e) {
  let t = e
  t = t.replace(/[０-９]/g, (n) => String.fromCharCode(n.charCodeAt(0) - 65248))
  t = t.replace(/[～—–]/g, '-')
  t = t.replace(/([一-龥])\s+(?=[一-龥])/g, '$1')
  t = t.replace(/(\d)\s*-\s*(\d)/g, '$1-$2')
  return t.trim()
}

// 行内 token 重拆：按相邻 token 的 x 间距 > 40 重新合并/拆分，把 OCR 切碎的同一数据项还原。
// 例如 "N" "E" "U" "T" "%" "0" "." "4" "9" 在 x 连续时会拼回数字碎片，名称碎片保持独立。
function cd(e) {
  const t = []
  let n = null
  const r = () => {
    if (!n) return
    const o = n.parts.join('')
    if (a$.test(o)) t.push({ text: o, x: n.x, w: n.textW })
    else
      for (let a = 0; a < n.parts.length; a++)
        t.push({ text: n.parts[a], x: n.x, w: n.textW / n.parts.length })
    n = null
  }
  const s = new Array(e.length).fill(-1)
  for (let o = e.length - 2; o >= 0; o--) s[o] = ld.test(e[o + 1].text.trim()) ? o + 1 : s[o + 1]
  for (let o = 0; o < e.length; o++) {
    const a = e[o]
    const i = a.text.trim()
    if (ld.test(i)) {
      const l = e[o + 1]
      const u = l && Ro(hp(l.text.trim()))
      const m = s[o] === -1
      if (n && /^\d$/.test(i) && (u || m)) {
        r()
        n = { parts: [i], x: a.x, textW: a.w || 0, lastX: a.x, lastW: a.w || 0 }
        continue
      }
      if (n && a.x - (n.lastX + n.lastW) > 40) {
        r()
        n = { parts: [i], x: a.x, textW: a.w || 0, lastX: a.x, lastW: a.w || 0 }
        continue
      }
      n || (n = { parts: [], x: a.x, textW: 0, lastX: a.x, lastW: a.w || 0 })
      n.parts.push(i)
      n.textW += a.w || 0
      n.lastX = a.x
      n.lastW = a.w || 0
      continue
    }
    r()
    t.push(a)
  }
  r()
  return t
}

// 单侧（左栏或右栏）行解析：先 o$ 拆粘连 token，行号过滤，再分 value/ref/name/unit。
// pp(join(' ')) 负责把 "NEUT" + "%" 这类被 OCR 切开的名称碎片拼回 "NEUT%"。
function Xa(e) {
  const t = (f) => (typeof f === 'string' ? f : f.t)
  const n = (f) => (typeof f === 'string' ? 0 : f.w || 0)
  const r = []
  for (const f of e) for (const h of o$(hp(t(f)))) r.push({ t: h, w: n(f) })
  // 行号过滤：首 token 为 1-2 位整数，且其后跟的是名称（非数字/参考范围/单位）→ 视为报告行号跳过
  if (r.length > 1 && /^\d{1,2}\.?$/.test(r[0].t)) {
    const f = r[1]
    !ps(f.t) && !gs(f.t) && !Ro(f.t) && r.shift()
  }
  let s = ''
  let o = null
  const a = []
  const i = []
  for (const { t: f, w: h } of r) {
    const p = f.replace(/^[”"'‘’*#…~·・.、]+/, '')
    if (/[↑↓]/.test(p) && p.length <= 2) s = /↓/.test(p) ? '↓' : '↑'
    else if (gs(p)) o = p
    else if (ps(p)) a.push({ t: p, w: h })
    else {
      const x = f.match(/^(\d+\.\d*)[A-Za-z°%＋↑↓]+$/)
      x ? a.push({ t: x[1], w: h }) : i.push({ t: f, w: h })
    }
  }
  if (a.length === 0) return null
  let l = ''
  const u = i[i.length - 1]
  u && Ro(u.t) && (l = i.pop().t)
  let m = a[0]
  for (const f of a) f.w && (!m.w || f.w > m.w) && (m = f)
  return { name: pp(i.map((f) => f.t).join(' ')), value: m.t, ref: o || '', unit: l, arrow: s }
}

// 按 y 聚类为行对象（与 ocr.js 的 clusterByY 同义，独立副本避免跨模块依赖）
function clusterByY(arr, EPS) {
  const lines = []
  for (const it of [...arr].sort((a, b) => a.y - b.y)) {
    const line = lines.find((l) => Math.abs(l.sumY / l.items.length - it.y) <= EPS)
    if (line) {
      line.items.push(it)
      line.sumY += it.y
    } else {
      lines.push({ y: it.y, sumY: it.y, items: [it] })
    }
  }
  return lines
    .sort((a, b) => a.y - b.y)
    .map((l) => ({
      y: l.sumY / l.items.length,
      x0: Math.min(...l.items.map((i) => i.x)),
      x1: Math.max(...l.items.map((i) => i.x + (i.w || 0))),
      items: l.items.sort((a, b) => a.x - b.x),
    }))
    .filter((l) => l.items.some((i) => i.text.trim()))
}

// 自适应行容差：与 ocr.js 的 autoEps 同义（微信 OCR 行距 2px → EPS=2，避免跨行拼接/碎片行）
function autoEps(arr, fallback = 14) {
  const ys = [...new Set(arr.map((i) => i.y))].sort((a, b) => a - b)
  if (ys.length < 2) return fallback
  const diffs = []
  for (let i = 1; i < ys.length; i++) {
    const d = ys[i] - ys[i - 1]
    if (d > 0) diffs.push(d)
  }
  if (!diffs.length) return fallback
  diffs.sort((a, b) => a - b)
  const median = diffs[Math.floor(diffs.length / 2)]
  if (median < fallback * 2) return Math.max(2, Math.floor(median * 0.4))
  return fallback
}

// 主入口：复用旧版 gp 的完整「行聚类 + cd 重拆 + 解析 + 过滤 + 去重」链路。
// 双栏检测红线：splitX / isDoubleCol 必须由调用方（ocr.js 的 12% 法）注入，
// 本模块不再自行判定双栏，只按传入的分栏线切分左右栏并各自解析。
// opts: { isDoubleCol, splitX, EPS, parseSingle, parseDouble }
//   - isDoubleCol: 调用方 12% 法算出的布尔值
//   - splitX:      调用方 12% 法算出的分栏中线 x；单栏图可传 null（用全局中线）
//   - EPS:         可选固定行容差，默认走 autoEps
//   - parseSingle: 单栏行解析器（默认 Xa），建议注入 ocr.js 的 parseCellTokens 以获得更准识别
//   - parseDouble: 双栏行解析器（默认 Xa，适配旧版双栏粘连场景）
export function parseLegacyGrid(items, opts = {}) {
  const { isDoubleCol = false, splitX = null, EPS: fixedEps, parseSingle = Xa, parseDouble = Xa } = opts
  const EPS = fixedEps != null ? fixedEps : autoEps(items)

  // —— 分栏：严格使用调用方注入的 splitX（12% 法结果）；未注入时退回全局中线（单栏） ——
  const allX = items.map((i) => i.x)
  const minX0 = Math.min(...allX)
  const maxX0 = Math.max(...allX)
  const globalMid = (minX0 + maxX0) / 2
  const colSplitX = splitX != null ? splitX : globalMid

  const leftItems = items.filter((i) => i.x < colSplitX)
  const rightItems = items.filter((i) => i.x >= colSplitX)

  // —— 行聚类（双栏各自聚类后按 y 最近匹配合并；单栏直接聚类） ——
  let lineObjs = []
  if (isDoubleCol) {
    const leftLines = clusterByY(leftItems, EPS)
    const rightLines = clusterByY(rightItems, EPS)
    let li = 0
    let ri = 0
    while (li < leftLines.length || ri < rightLines.length) {
      const l = leftLines[li]
      const r = rightLines[ri]
      if (!l) {
        lineObjs.push(r)
        ri++
        continue
      }
      if (!r) {
        lineObjs.push(l)
        li++
        continue
      }
      if (Math.abs(l.y - r.y) <= EPS * 2.5) {
        lineObjs.push({
          y: (l.y + r.y) / 2,
          x0: Math.min(l.x0, r.x0),
          x1: Math.max(l.x1, r.x1),
          items: [...l.items, ...r.items].sort((a, b) => a.x - b.x),
        })
        li++
        ri++
      } else if (l.y < r.y) {
        lineObjs.push(l)
        li++
      } else {
        lineObjs.push(r)
        ri++
      }
    }
  } else {
    lineObjs = clusterByY(items, EPS)
  }

  if (lineObjs.length === 0) return []

  const y = []
  // 图宽（用于行内自适应分栏阈值），基于全部 items 的 x 范围
  const lineWidth = Math.max(1, maxX0 - minX0)
  for (const C of lineObjs) {
    // 行内自适应分栏（复现修改1 验证过的 parseCellTokens 双栏逻辑）：
    // 双栏时找行内最大相邻空白间隙（前一词右缘→后一词左缘），若显著大于图宽 4% 且
    // 明显大于第二间隙（双峰），则在中点分栏；否则用调用方注入的 colSplitX。
    // 单栏时 midX=Infinity，所有 token 整行解析，绝不按中点切分。
    let midX = isDoubleCol ? colSplitX : Infinity
    const toks = C.items
    let maxGap = 0
    let secondGap = 0
    let gapIdx = -1
    for (let i = 1; i < toks.length; i++) {
      const gap = toks[i].x - (toks[i - 1].x + (toks[i - 1].w || 0))
      if (gap > maxGap) {
        secondGap = maxGap
        maxGap = gap
        gapIdx = i
      } else if (gap > secondGap) {
        secondGap = gap
      }
    }
    if (isDoubleCol && gapIdx > 0 && maxGap > lineWidth * 0.04 && maxGap > secondGap * 2) {
      const a = toks[gapIdx - 1]
      const b = toks[gapIdx]
      midX = (a.x + (a.w || 0) + b.x) / 2
    }
    const H = []
    const P = []
    for (const T of toks) {
      const A = T.text.trim()
      if (!A) continue
      const F = { t: A, w: T.w || 0 }
      T.x < midX ? H.push(F) : P.push(F)
    }
    // 单栏：整行解析；双栏：左右分别解析后合并（若名称被切到两栏则整行解析兜底）
    let I
    if (isDoubleCol) {
      I = [parseDouble(H), parseDouble(P)].filter(Boolean)
      if (!I.some((T) => T.name)) {
        const T = parseDouble([...H, ...P])
        T && (I = [T])
      }
    } else {
      const T = parseSingle([...H, ...P])
      I = T ? [T] : []
    }
    if (I.length === 0 || !I.some((T) => T.value != null)) continue
    // 单栏碎片行质量过滤：清除 EPS=2 下被误当数据行的页眉/条码/患者信息噪声
    if (!isDoubleCol) {
      const vals = I.map((T) => String(T.value || ''))
      // 值为超长纯数字（条码/页码，如 426080405944）或含非数值字符（字母/中文混在数字里）→ 丢弃
      const badValue = vals.some((v) => /^\d{9,}$/.test(v) || /[A-Za-z一-龥]/.test(v.replace(/[<>≤≥%]/g, '')))
      if (badValue) continue
    }
    const O = id([...H, ...P].map((T) => T.t).join(' '))
    if (
      (/范围|单位|结果|项目|参考/.test(O) && !/^[A-Za-z#]/.test(I[0].name)) ||
      (/报告单|报告|姓名|性别|年龄|住院|病案|送检|检验者|采集|接收|报告时间|地址|电话|※|此报告|仅对|【|】|条码|标本|流水|仪器|病历|床号|科室|编号|诊断/.test(O) &&
        !/^[A-Za-z#]/.test(I[0].name)) ||
      (!I[0].name && !(I[1] && I[1].name)) ||
      (!I[1] && !I[0].ref)
    )
      continue
    const M = []
    for (const T of I) M.push(T.name, T.value, T.ref, T.unit, T.arrow)
    y.push(M)
  }

  // 去重
  const $ = new Set()
  const S = []
  for (const C of y) {
    const N = C.join('|')
    if (!$.has(N)) {
      $.add(N)
      S.push(C)
    }
  }
  return S
}
