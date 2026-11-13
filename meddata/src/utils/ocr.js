// ===================== 识别通道（PDF 文本提取 + 本地 Tesseract） =====================
//
// 两通道策略：
//   · PDF（带文字层）→ pdfjs-dist 直接提取文本层（毫秒级、100% 准确，无需 OCR）
//   · JPG/PNG → 本地 Tesseract.js（离线、免费、数据不出境；预处理增强箭头 ↓↑ 与低对比度识别）
//
// 识别时间标准：整个识别流程（引擎加载 + PDF 提取 / 图片 OCR）不超过 90 秒，
// 超时即中止并抛出明确提示，避免 CPU 离线识别无限等待。
//
// 离线资源（由 scripts/setup-tesseract.mjs 准备）：
//   /tesseract/worker.min.js  /tesseract/tesseract-core*.wasm.js
//   /traineddata/chi_sim.traineddata  /traineddata/eng.traineddata
//
// 返回：{ grid, provider, mock, message }
//   provider = 'pdf' | 'tesseract-local'；mock=true 仅用于「载入演示数据」

import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { mapAlias, FIELD_BY_CODE, repairFusionName } from '../data/dictionary.js'
import { normalizeGridToPoints, summarizeAudit, matchFieldByValueRef, parseRefRange, normalizeUnit } from './normalize.js'
import { parseLegacyGrid } from './legacyGridParser.js'
import { PATCHES } from '../data/patches.js'
import { applyPatches } from '../data/applyPatches.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

let workerPromise = null
let workerPromiseZh = null // 中文专用 worker（扫描件报告 OCR 用，纯 chi_sim 避免英文模型污染中文行）
let tesseractModule = null

// ---- 本地引擎就绪状态（供引擎下拉提示「启动中 / 未就绪」）----
// 本地离线识别的「服务」就是浏览器里的 tesseract worker：wasm 编译 + 语言包加载全在首次创建时做，
// 这段时间（冷启动十几秒）点识别会像「卡住」，甚至撞 90s 超时。故把状态暴露给 UI：
//   idle     尚未预热（页面刚开，warmupOcr 还没跑到）
//   starting worker 创建中（编译 wasm / 加载 traineddata）
//   ready    可用
//   failed   初始化失败（/tesseract、/traineddata 资源缺失等），下次识别会自动重建
let localEngineState = 'idle'
const localEngineStateSubs = new Set()
export function getLocalEngineState() {
  return localEngineState
}
// 订阅本地引擎状态（返回取消订阅函数）：引擎下拉据此实时刷新「启动中…」提示
export function subscribeLocalEngineState(fn) {
  if (typeof fn !== 'function') return () => {}
  localEngineStateSubs.add(fn)
  return () => localEngineStateSubs.delete(fn)
}
function setLocalEngineState(next) {
  if (localEngineState === next) return
  localEngineState = next
  for (const fn of localEngineStateSubs) {
    try {
      fn(next)
    } catch {
      /* 监听器异常不得影响识别链路 */
    }
  }
}

// 识别时间标准：不超过 90 秒（与 UI 文案一致）。经修复（Sauvola/Deskew 预处理 bug 修复、
// 超时不 terminate worker 保留编译成果、闭环改「grid 有效即止」砍掉无效重识别、
// 冷启动编译从超时计时剥离）后，4 策略图片 OCR 通常 30s 内完成，90s 留足余量。
// 超时仅中止本次、不再 terminate worker，避免偶发超时后二次失败。
const OCR_TIMEOUT_MS = 90_000
// 识别进度回调：供 UI 显示真实 OCR 进度（多策略轮次聚合，单调增）。不阻塞、不动识别质量。
let ocrProgressCb = null
let ocrPhaseLabel = ''
let ocrStrategyIdx = 0
let ocrStrategyTotal = 1
export function setOcrProgress(cb) {
  ocrProgressCb = cb
}
const OCR_TIMEOUT_MSG =
  '识别超过 90 秒未完成，已自动中止。本机离线识别首次约 20 秒以上；扫描件或大图较慢，建议压缩后重试；带文字层 PDF 秒级完成'

// 回收识别 worker（超时 / 失败后调用，避免后台任务继续占用 CPU）
async function resetWorker() {
  const targets = []
  if (workerPromise) {
    targets.push(workerPromise)
    workerPromise = null // 先置空引用，保证后续重试可立即重建
  }
  if (workerPromiseZh) {
    targets.push(workerPromiseZh)
    workerPromiseZh = null
  }
  for (const p of targets) {
    try {
      // 最多等 2s（防 createWorker 卡死时永久等待）；terminate 失败可忽略
      const w = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 2000))])
      if (w && typeof w.terminate === 'function') await w.terminate()
    } catch {
      /* ignore */
    }
  }
  if (targets.length) setLocalEngineState('idle') // worker 已回收：下次识别要重新冷启动
}

// 给 promise 加超时：超时仅 reject，不直接 terminate worker。
// 说明：Tesseract 的 wasm 编译产物与已加载的 traineddata 都存活在 worker 线程内，
// 一旦 terminate，下次识别必须冷启动重新编译（十几秒），这正是「第一次超时→第二次才成功」的根因。
// 故超时不强制回收，保留 worker 供后续重试直接复用；仅在显式失败路径（runOcrImage catch）按需回收。
function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      console.log('[OCR][DBG] withTimeout 触发超时', ms, 'ms ->', message)
      reject(new Error(message))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// 诊断/调优用：创建独立 Tesseract worker（不进入共享 workerPromise 缓存，用完需自行 terminate）
export async function createOcrWorker(lang = 'chi_sim+eng') {
  const { createWorker } = await import('tesseract.js')
  return createWorker(lang, 1, {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/',
    langPath: '/traineddata',
    gzip: false,
    logger: () => {},
  })
}

// 切片并行 worker 池：常驻缓存、跨 OCR 复用，避免每次高图都冷启动 4 个 worker。
// 主路径 getTesseract 是预热单例；切片若每次新建会抵消并行收益，实测反而比整图慢（>90s 超时）。
let sliceWorkerPool = []
// 切片池寿命：tesseract worker 长时间运行会累积退化（实测浏览器连续跑数小时 OCR 后
// 单图识别从 ~10s 退化到 90s+，刷新页面无法恢复，因为请求仍在持续注入）。
// 按使用次数回收重建，避免「越用越慢」。阈值取较大值，使单次会话内不会频繁冷启动。
let slicePoolUsage = 0
let slicePoolRecycle = false
const SLICE_POOL_RECYCLE = 30 // 每 30 次识别回收一次（terminate 全部切片 worker 重建，冷启动约十几秒）
async function recycleSlicePoolIfNeeded() {
  if (!slicePoolRecycle || sliceWorkerPool.length === 0) return
  const old = sliceWorkerPool
  sliceWorkerPool = []
  slicePoolRecycle = false
  await Promise.all(
    old.map(async (w) => {
      try {
        await Promise.race([w.terminate(), new Promise((r) => setTimeout(() => r(null), 2000))])
      } catch {
        /* ignore */
      }
    })
  )
}
export async function ensureSliceWorkers(n) {
  await recycleSlicePoolIfNeeded()
  while (sliceWorkerPool.length < n) {
    sliceWorkerPool.push(await createOcrWorker('chi_sim+eng'))
  }
  return sliceWorkerPool.slice(0, n)
}
export function warmupSliceWorkers() {
  ensureSliceWorkers(SLICE_POLICY.MAX_WORKERS).catch(() => {})
}

// 惰性加载 Tesseract（仅图片需要，PDF 不触发）
async function getTesseract() {
  if (!tesseractModule) tesseractModule = await import('tesseract.js')
  if (!workerPromise) {
    const { createWorker } = tesseractModule
    setLocalEngineState('starting') // 引擎下拉显示「启动中…」：冷启动十几秒，先告诉用户
    const p = createWorker('chi_sim+eng', 1, {
      workerPath: '/tesseract/worker.min.js',
      // corePath 必须是「目录」（worker 按浏览器 SIMD 能力自动选择 tesseract-core-*.wasm.js 变体）
      corePath: '/tesseract/',
      langPath: '/traineddata',
      // 语言包为未压缩的 .traineddata（tessdata_fast 源）。默认 gzip:true 会请求
      // .traineddata.gz → 本地无此文件返回 404 → worker 初始化失败挂起直至超时
      gzip: false,
      logger: (m) => {
        if (m.status === 'recognizing text' && ocrProgressCb) {
          ocrProgressCb({ phase: ocrPhaseLabel, progress: (ocrStrategyIdx + (m.progress || 0)) / ocrStrategyTotal })
        }
      },
    })
    // 初始化失败时仅在引用未变时清空，避免误清后续新建的 worker
    p.then(() => setLocalEngineState('ready')).catch(() => {
      if (workerPromise === p) workerPromise = null
      setLocalEngineState('failed')
    })
    workerPromise = p
  }
  return workerPromise
}

// 中文专用 worker（扫描件报告 OCR：纯 chi_sim + psm6 整块文本）。
// 实验对比（2215726 系列扫描件）：chi_sim+eng 会污染中文行（如诊断条目标成拉丁乱码），
// 纯 chi_sim + psm6 可将中文报告识别质量从「大量乱码」提升到「仅少量形近错字」。
async function getTesseractZh() {
  if (!tesseractModule) tesseractModule = await import('tesseract.js')
  if (!workerPromiseZh) {
    const { createWorker } = tesseractModule
    if (!workerPromise) setLocalEngineState('starting') // 扫描件中文 worker 同样属于本地引擎启动
    const p = createWorker('chi_sim', 1, {
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/',
      langPath: '/traineddata',
      gzip: false,
      logger: (m) => {
        if (m.status === 'recognizing text' && ocrProgressCb) {
          ocrProgressCb({ phase: ocrPhaseLabel, progress: (ocrStrategyIdx + (m.progress || 0)) / ocrStrategyTotal })
        }
      },
    })
    p.then(() => setLocalEngineState('ready')).catch(() => {
      if (workerPromiseZh === p) workerPromiseZh = null
      setLocalEngineState('failed')
    })
    workerPromiseZh = p
  }
  return workerPromiseZh
}

// 预热 OCR worker：在应用启动后的空闲时间提前创建 worker、编译 wasm、加载 traineddata，
// 把首次识别的「冷启动十几秒」从识别路径挪到启动后空闲时间，避免「第一次点识别撞 90s 超时失败」。
// 幂等：与识别路径共用同一个 workerPromise，预热未完成时识别会 await 同一个 promise，不冲突。
// 失败静默（网络/wasm 加载失败时仅清空缓存，不影响后续识别路径自动重建）。
export function warmupOcr() {
  // 同时预热 eng（图片/PDF 主识别路径 getTesseract）与 zh（扫描件路径 getTesseractZh），
  // 避免任一 worker 首次冷启动；与识别路径共用同一 workerPromise，幂等、仅首次真正创建。
  getTesseract().catch(() => {})
  getTesseractZh().catch(() => {})
  // 预热切片并行 worker 池，使高图首次切片也走热路径（否则每次冷启动 4 worker 会抵消并行收益）
  warmupSliceWorkers()
}

/* ---------------- 文本启发式解析（与 scripts/test-flow.mjs 同源，保证结果可复现） ---------------- */

// 数值识别：允许尾部孤立小数点（OCR 常把 "30" 识别成 "30."，小数部分可缺省）
// 如 "30"、"30."、"30.5" 均视为数值；单个 "." 因 \d+ 必现而不会误判。
// 支持「高于/低于检测限」写法：报告常把超限值印成 >1500.0 / <0.05（含 ≥/≤），
// 此前正则只认纯数字，导致这类值的整行无数值被丢弃（如促红细胞生成素(EPO) 结果 >1500.0）。
// 仅放宽「可选比较运算符前缀」，核心数字部分不变，不与箭头 ↓/↑（单字符）混淆。
const isNum = (s) => /^\d+(\.\d*)?$/.test(s) || /^[<>≥≤]\s*\d+(\.\d*)?$/.test(s)
// 参考范围分隔符兼容：半角 ~、全角 ～（PDF 文本层常用 U+FF5E）、— – -（与 scripts/test-flow.mjs 同源）
const isRef = (s) => /^\d+(\.\d*)?\s*[~～—\-–]{1,2}\s*\d+(\.\d*)?$/.test(s)
// 汉字参考范围（定性检验）：如「阴性～阳性」「阴性-阳性」
const isRefCn = (s) => /^[一-龥]{1,5}(～|~|—|–|-)[一-龥]{1,5}$/.test(s)
// 字段代码（WBC / LY# / NE% / hs-CRP），不应被当作单位
const isFieldCode = (s) => /^[A-Z#][A-Za-z#%]*$/.test(s)
const isUnitToken = (s) => {
  if (isFieldCode(s)) return false
  // 含中文的不是单位（单位均为纯字母/符号，如 mmol/L、g/L、%）
  // 否则 LEU白细胞 / GLU葡萄糖 / URO尿胆原 等含字母 U 的项目名会被 /U/ 误判成单位
  if (/[\u4e00-\u9fa5]/.test(s)) return false
  // 兼容 PDF 文本层拆碎后的常见单字符/短单位
  if (/^(s|%|L|U|g|dL|mL|uL|fL|IU|mol|mmol|ng|ug|mg|pg|dl|cl|fl)$/i.test(s)) return true
  return /\/|%|g|fL|pg|U|mmol|mol|IU/.test(s)
}

// OCR 单位噪声归一：Tesseract 常把 fL 识别成 £L/tL/LL、g/L 识别成 a/L 等
// 生化报告常见噪声：umol/L → unol/L（m→u）、mOsm/L → EmOSM/EOSM/L、ml/min → mg"2/止个
const UNIT_NOISE_FIX = [
  [/^£L$/i, 'fL'],
  [/^tL$/i, 'fL'],
  [/^LL$/i, 'fL'],
  [/^lL$/i, 'fL'],
  [/^a\/L$/, 'g/L'],
  // 生化报告：umol/L 的 m 被读成 n 或 u
  [/^unol\/L$/i, 'umol/L'],
  [/^unol\/ L$/i, 'umol/L'],
  // mOsm/L 的 m 被读成 E 或省略
  [/^[Ee][mM][oO][sS][mM]\/[lL]$/i, 'mOsm/L'],
  [/^[Ee][oO][sS][mM]\/[lL]$/i, 'mOsm/L'],
  // ml/min 的严重乱码（肌酐清除率单位）
  [/^mg["']?2\/.+$/, 'ml/min'],
]
function fixUnitNoise(s) {
  // Tesseract 常把 10^9/L 读成 10°9/L、10`9/L、10*9/L；额外前缀 1（如 110°9/L）一并剥离
  const m = s.match(/^1?10[°`*](\d+)\/L$/i)
  if (m) return '10^' + m[1] + '/L'
  // 血红蛋白单位 g/L 被读成 IgXL / det 等
  if (/^IgXL$/i.test(s)) return 'g/L'
  if (/^det$/i.test(s)) return 'g/L'
  for (const [re, to] of UNIT_NOISE_FIX) if (re.test(s)) return to
  return s
}

// 定性检验结果值：<40.0000（低于检测下限）、阴性/阳性/弱阳性/O型/A型/B型/AB型/Rh(D)+ 等。
// 还包含尿常规的「-」（阴性符号）与英文 Normal（阴性）。
// PDF 文本层里这些是精确字符，不会与数字箭头（↓↑）混淆。
// 注意 Rh(D) 后缀必须出现（Rh(D)+/-），避免把项目名前缀「Rh(D)」误当结果值。
const QUAL_VALUE =
  /^(<|>|≤|≥)?\d+(\.\d*)?%?$|^(阴性|阳性|弱阳性|可疑|正常|异常|未检出|[OAB]{1,2}型|Rh\(D\)[+-−])$|^-$|^[Nn]ormal$/


// 拆分「代码 数值 单位」合并 token（Tesseract 常把 "MCV 87.5 fL" 识别成单个 word）
// 如 "MCV 87.5 £L" → ['MCV', '87.5', '£L']；不匹配则原样保留
function expandCompoundToken(t) {
  const m = t.match(/^([A-Za-z#%]+)\s+(\d+(?:\.\d*)?)\s*([^\s]*)$/)
  if (m) return [m[1], m[2], m[3]].filter(Boolean)
  return [t]
}

// 清理项目名中的 OCR 噪声：
//   - 报告常给重点项目加星标（★），Tesseract 会把它误识别成「玄/妇/广/米/术」等汉字，
//     如「★白细胞」→「玄 白 细胞 |」（竖线是表格线/分隔符噪声）；
//   - 剥离后剩余部分应能匹配标准别名（「白细胞」→ WBC）。
function cleanProjectName(name) {
  let s = String(name || '').trim()
  // 竖线、星形与装饰符号、箭头误识别符（任意位置）
  // 「+」常是 ↑ 的误识别（如 "PDW +" → "PDW"）；「$」常是 ↓ 的误识别（如 "EO# $" → "EO#"）
  s = s.replace(/[|丨｜★☆＊※●○■□◆◇△▲*+$]/g, '')
  const kept = s
  // 星标误识别前缀：仅当后面还有内容时剥离（「玄白细胞」→「白细胞」；单独一个「玄」不剥）
  // 变体：玄/妇/广/米/术/去/紊/畜/廊/康/妈/宽/型/丸/廊（Tesseract 对 ★ 的常见形近误读）。
  // 注意：不含「红」——「红细胞压积」「红细胞分布宽度」以「红」开头，剥离会误伤；而
  // 「红白细胞」（★ 误读）不剥离也可靠「白细胞」子串匹配到 WBC，故「红」无需在此剥离。
  while (s.length > 1 && /^[玄妇广米术去紊畜廊康妈宽型丸]/.test(s)) s = s.slice(1).trim()
  if (!s) s = kept
  // 中文词间空格粘连：白 细胞 → 白细胞
  s = s.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
  // 生化报告形近字修正（Tesseract 对低分辨率/扫描件的高频误读）：
  //   肌酐相关：香→酐（「肌香」→「肌酐」）
  //   胆红素相关：肥→胆（「肥红素」→「胆红素」）
  //   转氨酶相关：合→谷（「合丙」→「谷丙」）、接気→转氨酶
  //   钙磷相关：忄→钙（单字偏旁丢失）、文磷→磷
  //   其他：破性→碱性、破酸→磷酸、繭→酶、-合氨酰→谷氨酰
  const BIO_NEAR_MISS = [
    [/肌香/g, '肌酐'],
    [/肥红素/g, '胆红素'],
    [/合丙转氨酶/g, '谷丙转氨酶'],
    [/谷草接気/g, '谷草转氨酶'],
    [/破性磷酸?酶/g, '碱性磷酸酶'],
    [/-?合氨酰转肽繭/g, 'γ-谷氨酰转肽酶'],
    [/^忄$/, '钙'],
    [/文磷/g, '无机磷'],
    [/大血糖/g, '血糖'],  // 多余前缀字
    [/単位/g, ''],         // 日文汉字混入（不应出现在项目名中）
    [/甘油三酢/g, '甘油三酯'],
    [/前白蛋(?:白)?/g, '前白蛋白'],
    [/球蛋白(?:白)?/g, '球蛋白'],
    [/白蛋白(?:白)?/g, '白蛋白'],
    [/总蛋白(?:白)?/g, '总蛋白'],
  ]
  for (const [re, to] of BIO_NEAR_MISS) s = s.replace(re, to)
  // 剥离行号：开头/结尾的 1-2 位整数（如 "1 白细胞" → "白细胞"、"白细胞 3" → "白细胞"）。
  // 不误伤值（值不在 name 中）、不误伤小数（"1.96" 含点不匹配）。
  s = s.replace(/^\d{1,2}\s+/, '').replace(/\s+\d{1,2}$/, '')
  // 剥离 OCR 字母/符号乱码 token：如 "平均血红蛋白量" 被识别成 "%°F i920 As MCH"，
  // 其中 "%°F i920 As" 无法映射到任何字段别名、也不含中文，是纯乱码；"MCH" 能映射 → 保留。
  // 含中文的 token 恒保留（中文名称是可靠信号）；纯英文/符号 token 需能被 mapAlias 匹配，
  // 或本身是纯字母缩写（如 NEU、LYMPH、MONO#），或含括号/逗号的英文缩写（如 (Ts)、(COL)、(ALS,），
  // 否则视为乱码丢弃。
  s = s
    .split(/\s+/)
    .filter(
      (t) =>
        /[\u4e00-\u9fa5]/.test(t) ||
        Boolean(mapAlias(t)) ||
        /^[A-Za-z][A-Za-z#]*$/.test(t) ||
        /^[A-Za-z0-9#()/.,\-\s]*[A-Za-z0-9#()]$/.test(t)
    )
    .join(' ')
  return s.trim()
}

// 把一组按 x 排序的 token 解析为 { name, value, ref, unit, arrow }
// token 可为 string 或 { t, w }（带 OCR bbox 宽度，用于区分箭头误识别的窄数字）
// 解析一行 token 为指标数组。支持「一行多指标」：紧凑血常规表常把两个指标左右并排
// 排在同一物理行（左栏 WBC，右栏 RDW-CV）。当行内第二个项目名与第一个项目名的 x 间隔
// 超过行宽阈值（COL_GAP_RATIO）时，判定为两个独立指标，各自独立解析。
// 普通单指标行（名称词 x 间隔很小，或仅一个名称词）返回长度 1 的数组，行为同旧版。
function parseCellTokens(tokens) {
  const T = (tok) => (typeof tok === 'string' ? tok : tok.t)
  const W = (tok) => (typeof tok === 'string' ? 0 : tok.w || 0)
  const X = (tok) => (typeof tok === 'string' ? 0 : tok.x || 0)
  // 纯英文/括号缩写判定（与 buildGridFromItems 中保持一致）：用于识别无数值孤儿行，
  // 如 "(Ts)"、"(Pa)"、"(BIL)" 等 OCR 单独切出的项目名缩写。
  const isAbbrName = (n) => !!n && /^[A-Za-z0-9#()\s/.\-]+$/.test(n) && !/[一-龥]{2,}/.test(n || '')
  // 展开后的完整序列（先展开，用于行号判断），携带 x 用于列间隔分段
  const expanded = []
  for (const raw of tokens) {
    for (const t of expandCompoundToken(fixUnitNoise(T(raw)))) {
      expanded.push({ t, w: W(raw), x: X(raw) })
    }
  }
  const isNameWord = (clean) => !isNum(clean) && !isRef(clean) && !isUnitToken(clean)
  const cleanName = (t) => t.replace(/^[”"'‘’*#…~·・.、]+/, '')
  // 行宽：用于判断两个名称词是否分属左右两栏（列间隔）
  const xsAll = expanded.map((e) => e.x)
  const lineW = Math.max(1, Math.max(...xsAll) - Math.min(...xsAll))
  const COL_GAP_RATIO = 0.25 // 同指标内名称词 x 间隔不超过行宽 25% 视为同一指标
  const cells = [] // 每个 cell = { arrow, ref, nums:[], rest:[{t,w}] }
  let cur = { arrow: '', ref: null, nums: [], rest: [] }
  let curStartX = null // 当前指标首个名称词的 x
  for (const { t, w, x } of expanded) {
    // OCR 常在数值前粘连引号/星号/句点（如 "”43.6"、"*2.5"、"·0.9"），剥离杂质后再判断，
    // 否则 "”43.6" 会被当成名称词，value 错误选到参考范围碎片（如 "40."）。
    const clean = cleanName(t)
    if (/[↑↓]/.test(clean) && clean.length <= 2) {
      cur.arrow = /↓/.test(clean) ? '↓' : '↑'
    } else if (isRef(clean)) {
      cur.ref = clean
    } else if (isNum(clean)) {
      // 项目数字识别：1-2 位小整数、x 远离当前指标起点、且当前格已完成参考范围（cur.ref 已置）时，
      // 视为「下一指标的序号列」（如左右并排双栏表，右栏序号在行中段），据此切新格并把序号归入新格，
      // 再由下方每格序号判定提取。要求 ref 已置可避免把「同一指标的值」误当序号切错格：
      // 值是排在参考范围之前的（如 肌酐 94 59～104，94 在 ref 前 → 不切），
      // 而序号排在上一个指标完整结束（ref 之后）→ 才切。
      if (
        curStartX !== null &&
        cur.ref != null &&
        /^\d{1,2}$/.test(clean) &&
        Math.abs(x - curStartX) > lineW * COL_GAP_RATIO &&
        (cur.rest.length > 0 || cur.nums.length > 0)
      ) {
        cells.push(cur)
        cur = { arrow: '', ref: null, nums: [], rest: [] }
        curStartX = null
      }
      cur.nums.push({ t: clean, w, x })
    } else {
      // OCR 常在数值后粘连杂质字母/符号（如 "14.1%" 被识别成 "14.1T"、"1.61+"）。
      // 仅当 token 形如「小数+字母/符号后缀」时剥离：名称词几乎不会出现该结构，安全。
      const m = t.match(/^(\d+\.\d*)[A-Za-z°%＋↑↓]+$/)
      if (m) cur.nums.push({ t: m[1], w, x })
      else if (isNameWord(clean)) {
        // 提示列箭头噪声：单字符符号（"+" 是 ↓ 的误读）或「数字+符号」（"4+"）且当前格已有
        // 数值时，是提示列箭头而非新指标名——归入 rest 不切格，否则会把右侧序号/值误切到新格
        // （如 LYMPH 行 "74.7 + % 20-50 | 18 ..." 的 "+" 切格后 18 变成孤儿 value）。
        const isArrowNoise =
          /^[\d+\-$|=·.,;:!?]{1,3}$/.test(clean) && /[+\-$|=·.,;:!?]/.test(clean) && cur.nums.length > 0
        if (isArrowNoise) {
          cur.rest.push({ t, w, x })
        } else if (curStartX !== null && Math.abs(x - curStartX) > lineW * COL_GAP_RATIO) {
          cells.push(cur)
          cur = { arrow: '', ref: null, nums: [], rest: [] }
          curStartX = null
        }
        if (curStartX === null) curStartX = x
        cur.rest.push({ t, w, x })
      } else {
        // 非名称非数值非参考（如单位、零散符号）：归入当前指标
        cur.rest.push({ t, w, x })
      }
    }
  }
  cells.push(cur)
  // ===== 栏位标记（_col_idx）=====
  // 单条 OCR 行内可能左右并排多个指标（左栏 x 小、右栏 x 大，如「WBC + RDW-CV」）。
  // 此处把 cells 按「首个 token 的 x」排序，再用「行内 x 中位」二分类打 _col_idx：
  //   0 = 左栏（x 较小），1 = 右栏（x 较大）。
  // 供 normalize 的 autoFillItemNo 做「栏感知插值」：左右栏是各自独立的连续序号序列
  // （如左栏 1-15、右栏 16-27），必须在同栏内插值，否则 Z 字形 `_row` 会跨栏误插。
  // 用 x 中位而非 index，可避免某行只有 1 个 cell 时把它硬算成右栏（0 栏兜底兼容单栏报告）。
  const colSortX = (c) => {
    if (c.rest.length > 0) return c.rest[0].x ?? Infinity
    if (c.nums.length > 0) return c.nums[0].x ?? Infinity
    return Infinity
  }
  cells.sort((a, b) => colSortX(a) - colSortX(b))
  const colXs = cells.map(colSortX).filter((x) => Number.isFinite(x))
  const colMedian = colXs.length > 0 ? colXs[Math.floor(colXs.length / 2)] : -Infinity
  for (const c of cells) {
    // 单 cell 行（该 OCR 行只有一个指标）：无法区分左右栏，统一归 0 栏兜底，
    // 避免被中位 x 二分类误判成右栏（右栏插值会按 16+ 外推导致序号膨胀）。
    if (cells.length <= 1) { c._col_idx = 0; continue }
    const x0 = colSortX(c)
    c._col_idx = Number.isFinite(x0) ? (x0 >= colMedian ? 1 : 0) : 0
  }
  const out = []
  for (const c of cells) {
    // 项目数字识别（每格独立）：项目序号列在该格最左侧（x 最小），且先于名称词出现；
    // 若存在「1-2 位整数 + x 小于首个名称词 x」，则它是序号而非结果值 → 移出 nums（避免
    // 抢占 value）、并 prepend 到 name，供 normalizeGridToPoints 的 extractItemNo 提取 _item_no。
    // 覆盖「单栏判定但实为左右并排双栏表」场景（如本页左栏序号 1-15、右栏序号 16-27）。
    let cellItemNo = null
    if (c.rest.length > 0) {
      const firstNameX = c.rest[0].x
      const keep = []
      for (const n of c.nums) {
        if (cellItemNo == null && n.x != null && n.x < firstNameX && /^\d{1,2}$/.test(n.t)) {
          cellItemNo = Number(n.t)
        } else {
          keep.push(n)
        }
      }
      c.nums = keep
    }
    // 无数值 cell：仅当含纯英文/括号缩写（如 "(Ts)"、"(Pa)"、"(BIL)"）时才保留为孤儿项，
    // 供上层按 y 并入同物理行最近的数值行（否则这些缩写随项目名丢失后无法参与 mapAlias）。
    // 普通无数值噪声行（表头、单位、纯中文乱码）不保留，避免污染。
    if (c.nums.length === 0) {
      const name = cleanProjectName(c.rest.map((r) => r.t).join(' '))
      if (name && isAbbrName(name)) {
        out.push({ name, value: null, ref: c.ref || '', unit: '', arrow: c.arrow, _col_idx: c._col_idx, _orphan: true })
      }
      continue
    }
    // 单位取最后一个匹配单位模式的 token
    let unit = ''
    const last = c.rest[c.rest.length - 1]
    if (last && isUnitToken(last.t)) unit = c.rest.pop().t
    // value 选择：取宽度最大的数字。箭头 ↓/↑ 被 OCR 误识别成 4/1 时，
    // 该数字通常为单字符、宽度显著小于真实数值（如 14.1），可据此排除箭头噪声；
    // 参考范围残留数字（如 "0-50" 拆散的 "0"）同理更窄，不会抢占 value。
    let valueTok = c.nums[0]
    for (const n of c.nums) {
      if (n.w && (!valueTok.w || n.w > valueTok.w)) valueTok = n
    }
    // name 保留「项目名称+缩写」完整文本，供 normalize 用 mapAlias 做鲁棒匹配；
    // 显示层是否剥离缩写/乱码由 normalize 决定（original_name 干净，匹配用完整 name）。
    let name = cleanProjectName(c.rest.map((r) => r.t).join(' '))
    if (cellItemNo != null && name) name = `${cellItemNo} ${name}`
    out.push({ name, value: valueTok.t, ref: c.ref || '', unit, arrow: c.arrow, _col_idx: c._col_idx })
  }
  return out
}

// 归一化 OCR 行文本：全角转半角、中文粘连、数字-连字符归一化
function normalizeLine(text) {
  let s = text
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/[～—–]/g, '-')
  // OCR 常把中文词拆开：白细胞 计数 → 白细胞计数
  s = s.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
  // 数字与连字符间的空格去掉：3.5 - 9.5 → 3.5-9.5
  s = s.replace(/(\d)\s*-\s*(\d)/g, '$1-$2')
  return s.trim()
}

/* ---------------- 网格重建：坐标行 → 双栏数据网格 ---------------- */

// 合并相邻的数字/小数/参考范围碎片（Tesseract 常把 "14.1" 拆成 1、4、.、1，
// 把 "0-50" 拆成 0、-、5、0）。只合并拼接后仍是合法数字/范围的序列，否则按原样保留。
// 数字末尾易混字母纠错（极窄范围，仅 K→8）：低分辨率图上 "88." 常被读成 "8K."
// （K 与 8 形近），如血常规 MCV "88.2" 在 900px 脱敏图上被读成 "8K. 2"
// （K→8 误认 + 小数点被空格拆开），纠错后 "8K."→"88." 再与 "2" 合并为 "88.2"。
// 仅对「数字 + K（可选 . 与尾随数字）」形态的 token 生效，绝不触碰纯字母词（如钾 K、BASO 缩写），
// 避免宽字母映射（O→0/S→5/B→8…）在其它报告里误伤真实数值/缩写。
const DIGIT_K_RE = /^\d+K\.?\d*$/
function cleanDigitConfusion(t) {
  if (DIGIT_K_RE.test(t)) return t.replace('K', '8')
  return t
}
const NUM_FRAG = /^\d+$|^\d+\.$|^\d*\.\d*$|^\.$|^[-–—~]$/
const VALID_NUM_OR_REF = /^\d+(\.\d*)?([-–—~]\d+(\.\d*)?)?$/
// 同一数字内碎片的 x 间隔约 14px，跨列间隔约 90px → 40px 为同列/跨列分界
const FRAG_GAP_PX = 40
// 参考区间整段（已被 tesseract 作为一个 word 读出，如 "4--8" / "5--9.5"）
const REF_FRAG_RE = /^\d+(\.\d*)?\s*[-–—~]{1,2}\s*\d+(\.\d*)?$/
function mergeNumericFragments(sorted) {
  const out = []
  let buf = null // { parts: [], x, textW, lastX, lastW }
  const flush = () => {
    if (!buf) return
    const joined = buf.parts.join('')
    if (VALID_NUM_OR_REF.test(joined)) {
      out.push({ text: joined, x: buf.x, w: buf.textW })
    } else {
      // 非法拼接（如孤立的 '.' 或 '-'）→ 逐字保留，避免误合并吞掉其他列的值
      for (let i = 0; i < buf.parts.length; i++) {
        out.push({ text: buf.parts[i], x: buf.x, w: buf.textW / buf.parts.length })
      }
    }
    buf = null
  }
  // 预计算：每个位置之后的「下一个数字片段」索引（-1 表示其后不再有数字片段）
  const nextNum = new Array(sorted.length).fill(-1)
  for (let i = sorted.length - 2; i >= 0; i--) {
    nextNum[i] = NUM_FRAG.test(cleanDigitConfusion(sorted[i + 1].text.trim())) ? i + 1 : nextNum[i + 1]
  }
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i]
    const t = it.text.trim()
    const ct = cleanDigitConfusion(t)
    if (NUM_FRAG.test(ct)) {
      // 指数单位残段保护（水印/低清报告 10^9/L 列 OCR 残化案例，如 WBC/NEUT/LYM=109.1）：
      // OCR 把上标 10⁹ 拆成 '10' + '9.1' 两个 token（无小数点分隔），逐段拼合会得到
      // 假值 109.1，且字符更宽抢走真实值列（3.34）。仅当 buf 恰为单段 '1?10' 且当前段
      // 形如 9.x（上标 9 的读法，无小数点即非真实小数）时拆开，各自独立保留；
      // 真实数值（如 10.9 拆成 '10','.','9'）因含小数点段不触发，不会误伤。
      const expUnitGhost =
        buf && buf.parts.length === 1 && /^1?10$/.test(buf.parts[0]) && /^9\d*(\.\d*)?$/.test(ct)
      if (expUnitGhost) {
        flush() // '10' 独立输出（可能是真实值，保守保留）
        buf = { parts: [ct], x: it.x, textW: it.w || 0, lastX: it.x, lastW: it.w || 0 } // '9.1' 独立成段
        continue
      }
      // 关键保护 1：单字符数字后紧跟单位（% / fL / g/L…）→ 很可能是箭头 ↓/↑ 被 OCR
      // 误识别成 4/1。此时不并入前面的数值 buf，独立保留，避免把 "14.1 ↓" 合并成 "14.14"。
      const next = sorted[i + 1]
      const nextIsUnit = next && isUnitToken(fixUnitNoise(next.text.trim()))
      // 关键保护 2：行尾孤立的单字符数字（其后不再有数字片段）且前面已有数值 →
      // 极可能是箭头 ↓/↑ 误识别（如 "血红蛋白 48 ↓" → "48" + "4"），拆开独立保留，
      // 后续 parseCellTokens 按宽度取最大数字即得 48。
      const isTrailingLone = nextNum[i] === -1
      if (buf && /^\d$/.test(ct) && (nextIsUnit || isTrailingLone)) {
        flush()
        buf = { parts: [ct], x: it.x, textW: it.w || 0, lastX: it.x, lastW: it.w || 0 }
        continue
      }
      // 关键保护 3：跨列间隔保护。两个数字碎片若 x 间距过大（> FRAG_GAP_PX），说明来自不同列
      // （如「0.182」与参考值列「10」、行号「23」与值「11.3」），不得合并拼接。
      if (buf) {
        const gap = it.x - (buf.lastX + buf.lastW)
        if (gap > FRAG_GAP_PX) {
          flush()
          buf = { parts: [ct], x: it.x, textW: it.w || 0, lastX: it.x, lastW: it.w || 0 }
          continue
        }
      }
      if (!buf) buf = { parts: [], x: it.x, textW: 0, lastX: it.x, lastW: it.w || 0 }
      buf.parts.push(ct)
      buf.textW += it.w || 0
      buf.lastX = it.x
      buf.lastW = it.w || 0
      continue
    }
    // 参考区间列的「小数空格净化」：OCR 常把 "0.4--8" 在小数点后断开，word 层给出
    // "0." + "4--8"，参考区间只剩后半段（0.4-8 → 4--8），value+ref 反推随即错配
    // （EO% 值 0.0/参考 0.4-8 被反推成凝血酶时间 4-8，真 EO_PCT 空出后又被散值填成 8）。
    // 仅当 buf 整体形如「数字.」且与该参考段属同列（x 间隔 ≤ FRAG_GAP_PX）时接回整数位，
    // 避免把值列的 "42." 与参考列的 "125--350" 误接成 "42.125--350"。
    if (buf && REF_FRAG_RE.test(ct) && /^\d+\.$/.test(buf.parts.join(''))) {
      const gap = it.x - (buf.lastX + buf.lastW)
      if (gap <= FRAG_GAP_PX) {
        out.push({ text: buf.parts.join('') + ct, x: buf.x, w: buf.textW + (it.w || 0) })
        buf = null
        continue
      }
    }
    flush()
    out.push(it)
  }
  flush()
  return out
}

// Graph-based Double-Column Grid（双栏根治通道，取代硬分栏 parseCellTokens 双栏路径）
// 思路：不按「左栏/右栏」硬性独立聚类，而是全页 items 按 y 聚类成「物理逻辑行」，
// 每行内以 value 锚点（数值 token）为界，每个 value 独占其左侧 name 区、取右侧 ref/unit。
// 这样双栏行不对齐时（左栏 name 与右栏 value 落在不同 y），仍能按物理行正确配对，
// 消除 name/value/ref 跨栏串行。原型见 scripts/proto-layout-graph.mjs。
const GRAPH_Y_TOL = 10
const GRAPH_NUM_RE = /^-?\d+(\.\d*)?\.?$/
const GRAPH_REF_RE = /^\d+(\.\d+)?\s*[-~—～]\s*\d+(\.\d+)?$|^[><]\s*\d+(\.\d+)?$/
const GRAPH_HEADER_LINE = /(检验项目|结果|参考范围|单位|提示|项目|英文缩写|医院|院|报告|姓名|性别|年龄|门诊|住院|科室|标本|采样|接收|诊断|备注|地址|电话|条码|编号|号：|第\s*\d+\s*页)/
function clusterByYGraph(items, EPS) {
  const sorted = items.filter((it) => it.y != null).slice().sort((a, b) => a.y - b.y)
  const clusters = []
  for (const it of sorted) {
    let placed = false
    for (const c of clusters) {
      if (Math.abs(c.y - it.y) <= EPS) {
        c.items.push(it)
        c.y = (c.y * c.items.length + it.y) / (c.items.length + 1)
        placed = true
        break
      }
    }
    if (!placed) clusters.push({ y: it.y, items: [it] })
  }
  return clusters
}
export function buildDoubleColumnGraph(items, midX) {
  const rawLines = clusterByYGraph(items, GRAPH_Y_TOL)
  const rows = []
  for (const line of rawLines) {
    const toks = line.items.slice().sort((a, b) => a.x - b.x)
    const merged = mergeNumericFragments(toks) // 合并 142 . 2 → 142.2
    const text = merged.map((m) => m.text).join(' ')
    const norm = normalizeLine(text)
    if (GRAPH_HEADER_LINE.test(norm)) continue // 跳过页眉/页脚/表头
    // value 锚点：数值 token（非 ref 格式）
    const valueToks = merged
      .filter((m) => m.text && GRAPH_NUM_RE.test(m.text.trim()) && !GRAPH_REF_RE.test(m.text.trim()))
      .sort((a, b) => b.x - a.x) // 从右到左处理，便于 leftBound
    if (valueToks.length === 0) continue
    const seen = new Set()
    for (const vt of valueToks) {
      const vx = vt.x
      const value = vt.text.trim()
      const key = `${value}|${line.y}`
      if (seen.has(key)) continue
      seen.add(key)
      // 左侧 name 区：value 左侧、且不被更左的 value 锚点隔断（独占左侧区，避免跨指标 name 残片并入）
      const leftBound = valueToks.find((o) => o.x < vx)
      const nameToks = merged.filter(
        (m) => m.x < vx && (!leftBound || m.x >= leftBound.x) && !GRAPH_NUM_RE.test(m.text.trim()) && !GRAPH_REF_RE.test(m.text.trim()) && !isUnitToken(m.text.trim())
      )
      // 去重相邻重复（OCR 常把同一词识别两遍）
      const dedup = []
      for (const nt of nameToks) {
        const t = nt.text.trim()
        if (!t) continue
        if (dedup.length && dedup[dedup.length - 1] === t) continue
        dedup.push(t)
      }
      const name = dedup.join(' ')
      // 右侧 ref / unit
      const rightToks = merged.filter((m) => m.x > vx)
      const refTok = rightToks.find((m) => GRAPH_REF_RE.test(m.text.trim()))
      const unitTok = rightToks.find((m) => isUnitToken(m.text.trim()) && (!refTok || m.text.trim() !== refTok.text.trim()))
      if (!name && !refTok && !unitTok) continue // 纯孤立数字（序号/条码）→ 跳过
      rows.push({
        name,
        value,
        ref: refTok ? refTok.text.trim() : '',
        unit: unitTok ? unitTok.text.trim() : '',
        arrow: '',
        // 物理行 y（全页聚类平均 y），供 y 融合按物理行匹配旧路径 row
        y: line.y,
        _col_idx: midX != null && vx < midX ? 0 : 1,
      })
    }
  }
  return rows
}

// Graph-based Spatial Re-association（双栏专用后处理通道）
// 双栏报告左右栏常不对齐（如 CK 的 name 在 y361 左栏、value 57.1 在 y289 右栏），
// parseCellTokens 按栏独立聚类会把左栏 name 与右栏 value 跨栏失配、ref 也被串行。
// 此函数用原始 items 坐标重建每个 value 锚点的「独占左侧 name 区 + 右侧 ref/unit」，
// 再把重建结果与 parseCellTokens 产出做置信度择优，消除跨栏串行。
// 仅当 isDoubleCol 时调用；不改动单栏路径与函数签名。
const REASSOC_Y_TOL = 9 // 同物理行 y 容差（收紧以避免相邻行 name 残片串入）
const NUM_RE = /^-?\d+(\.\d+)?$/
const REASSOC_REF_RE = /^\d+(\.\d+)?\s*[-~—～]\s*\d+(\.\d+)?$|^>\s*\d+(\.\d+)?$|^<\s*\d+(\.\d+)?$/
const REASSOC_UNIT_RE = /^(g\/L|mmol\/L|umol\/L|μmol\/L|U\/L|IU\/L|mmol|mol\/L|10\^?9?\/L|10\^\d+\/L|fL|pg|mg\/L|g\/dl|mmol\/l)$/i
function isReassocNameTok(it) {
  const t = it.text.trim()
  return t && !NUM_RE.test(t) && !REASSOC_REF_RE.test(t) && !REASSOC_UNIT_RE.test(t) && !/^[\d\s.]+$/.test(t)
}
function reassociateDoubleColumn(parsed, items, lineObjs) {
  if (!parsed || parsed.length === 0) return parsed
  // 1) 重建每个数值 token 的三元组：value 锚点 + 独占左侧 name + 右侧 ref/unit
  //    候选 value 集合：所有「像数值」的 token（来自整页 items，不受栏限制）
  const valueToks = items
    .filter((it) => it.text && NUM_RE.test(it.text.trim()) && !REASSOC_REF_RE.test(it.text.trim()))
  const rebuilt = []
  const usedValues = new Set()
  for (const vt of valueToks) {
    const vx = vt.x
    const vy = vt.y
    // 同物理行 |Δy| <= Y_TOL 的 token
    const rowToks = items.filter((it) => it.y != null && Math.abs(it.y - vy) <= REASSOC_Y_TOL)
    // name 区：value 左侧、且不被其他 value 锚点隔开（独占左侧区，避免跨指标 name 残片并入）
    const leftVals = rowToks
      .filter((it) => it.x < vx && NUM_RE.test(it.text.trim()))
      .sort((a, b) => b.x - a.x)
    const leftBound = leftVals.length ? leftVals[0].x : -Infinity
    const nameToks = rowToks
      .filter((it) => it.x < vx && it.x >= leftBound && isReassocNameTok(it))
      .sort((a, b) => a.x - b.x)
    const nameStr = nameToks.map((t) => t.text.trim()).join(' ')
    const refTok = rowToks.find((it) => it.x > vx && REASSOC_REF_RE.test(it.text.trim()))
    const unitTok = rowToks.find(
      (it) => it.x > vx && REASSOC_UNIT_RE.test(it.text.trim()) && (!refTok || it.text.trim() !== refTok.text.trim())
    )
    const value = vt.text.trim()
    // 跳过纯序号（行尾孤立短数字且无右侧 ref/unit 且左侧 name 过短）
    if (!nameStr && !refTok && !unitTok) continue
    const key = `${nameStr}|${value}|${refTok ? refTok.text.trim() : ''}`
    if (usedValues.has(key)) continue
    usedValues.add(key)
    rebuilt.push({
      name: nameStr,
      value,
      ref: refTok ? refTok.text.trim() : '',
      unit: unitTok ? unitTok.text.trim() : '',
      y: vy,
      // 栏位：以其 x 落在哪个栏宽区间粗略标记，供 normalize 栏感知插值兼容
      _col_idx: vx < (lineObjs._midX ?? Infinity) ? 0 : 1,
    })
  }
  // 2) 跨栏修正：对每个 parseCellTokens 产出的 (name,value)，若 rebuilt 中存在同 value 的三元组，
  //    用 rebuilt 的 name/ref/unit 覆盖——graph 的「独占左侧 name 区」比硬分栏更不易跨栏串行。
  //    保护网：若原行 name 已能 mapAlias 命中标准 code、而 rebuilt 的 name 不能，则保留原行 name
  //    （避免把已正确行改坏）；其余情况以 rebuilt 为准（rebuilt 的 ref 也一并补入）。
  const byValue = new Map()
  for (const r of rebuilt) {
    if (!byValue.has(r.value)) byValue.set(r.value, [])
    byValue.get(r.value).push(r)
  }
  const semScore = (n) => {
    if (!n) return 0
    const cn = (n.match(/[一-龥]/g) || []).length
    const en = (n.match(/[A-Za-z]/g) || []).length
    return cn * 2 + en
  }
  for (const p of parsed) {
    if (p.value == null) continue
    const cands = byValue.get(String(p.value))
    if (!cands || cands.length === 0) continue
    const best = cands
      .slice()
      .sort((a, b) => {
        const sA = semScore(a.name) + (a.ref ? 5 : 0)
        const sB = semScore(b.name) + (b.ref ? 5 : 0)
        return sB - sA
      })[0]
    if (!best || !best.name) continue
    const origHit = p.name ? mapAlias(p.name) : null
    const rebuiltHit = mapAlias(best.name)
    // 原行 name 已命中 code → 保护（mergeGraphValueByCode 会用 graph value 修正串行 value，
    // 这里不再用 rebuilt name 覆盖，避免「同 value 匹配」把 LDH(value=8.4 串行) 错改成阴离子间隙 name）
    if (origHit) continue
    p.name = best.name
    if (best.ref) p.ref = best.ref
    if (best.unit) p.unit = best.unit
  }
  // 3) rebuilt 中有、但 parseCellTokens 完全没产出的 (value) → 直接补回（消除整项丢失）。
  //    排除纯噪声（无 name 或 name 无语义字符）、以及患者信息数字（年龄/条码号等）。
  const existVals = new Set(parsed.filter((p) => p.value != null).map((p) => String(p.value)))
  for (const r of rebuilt) {
    if (existVals.has(r.value)) continue
    if (!r.name || semScore(r.name) < 2) continue
    if (!mapAlias(r.name)) continue // 仅补回能映射到标准 code 的行，避免噪声
    parsed.push({ name: r.name, value: r.value, ref: r.ref, unit: r.unit, arrow: '', _col_idx: r._col_idx })
    existVals.add(r.value)
  }
  return parsed
}

// Graph value 融合（双栏根治通道，bugs.md Bug 015/016）：
// 双栏物理行不对齐导致旧路径 value 串行（name 对、value 错）与 missing（name 乱码行被丢弃）。
// buildDoubleColumnGraph 重建的物理行三元组 value 正确（但 name 弱）。此函数：
//   ① 覆盖：旧路径某行 name 命中 code、且该行 value 越出字典 ref（!curInStd，典型串行）→ 用 graph
//      value 覆盖（保留旧路径 name/code）。仅越界才覆盖，避免 graph 自身串行误覆盖（如 graph y210
//      AG-name+Cr-ref 串行反推 Cr=22，但旧 Cr 93.4 在字典 ref 57-97 → curInStd → 不覆盖，保留 93.4）。
//   ② 补回：graph 反推 code 但 parsed 没有该 code（missing）→ 补回。跳过 detectReportType 固定体系
//      字段（TSH/FT3/FT4/PT 等），避免 graph 噪声误补改变报告类型（曾误补 TSH → 报告类型变 THYROID）。
// 红线（bugs.md Bug 016）：严禁用 graph name 作主路径（乱码+mapAlias 误匹配）；codeToGraph 仅用
// value+ref 反推（matchFieldByValueRef 强吻合）确定 code。仅双栏分支调用；不改动单栏路径与导出签名。
// detectReportType 固定体系①字段：误补这些会改变报告类型（如 TSH→THYROID），补回时跳过。
const REPORT_TYPE_DEFINING_CODES = new Set([
  'CTNI', 'NT_PROBNP', 'BNP', 'CK_MB', 'TSH', 'FT3', 'FT4', 'PT', 'APTT', 'FIB', 'D_DIMER',
  'G_TEST', 'GM_TEST', 'ABO', 'RH_D', 'UPH', 'USG', 'UNIT', 'UPRO', 'UBLD', 'URO', 'UBIL', 'UKET', 'ULEU', 'UVC',
])
// ORC 优化运行时补丁（数据层 · A 半）：新增"定义报告类型"的标志物（防双栏 graph 反推误改类型）。
// 铁律：失败只警告、不抛出。
try {
  const _patchRes = applyPatches(PATCHES, { definingCodes: REPORT_TYPE_DEFINING_CODES })
  if (_patchRes.errors.length) console.warn('[patches] ocr 定义码补丁有错误：', _patchRes.errors)
} catch (e) {
  console.warn('[patches] ocr 补丁应用失败，已忽略：', e && e.message)
}
// ===== ② 补回的两道安全闸（防「无中生有」多出一项，如血常规 RDW_CV 混进肝功报告）=====
// 病因（TR-20261104-7K4LBH / TR-20261104-PLK5PB：肝功+肾功+离子双栏报告各凭空空出 1 项）：
// ② 只按 code 查重，"有没有这一行"完全不看，而 codeToGraph 仅凭「值 + 参考范围」反推，
// 档案撞车时会命中**别的报告类型**的字段。实测该报告 IBIL 行 7.4 / 0～13.68 与字典 RDW_CV 档案
// （0-15 / %）中心只差 4.4%，比 IBIL 自己的档案（1.7-13.7）还接近 → 反推成 RDW_CV；又因 ② 在
// **每行循环里**被调用（每次 parsed 只有当前行），同一 graph 节点被反复消费，rawGrid 出现 17 条
// 「红细胞体积分布宽度-CV <孤儿 token>」假行，最后被 normalize「同 code 多行择优」收敛成 1 项。
// 闸 1（组一致性）：全页连一个该组项目都没认出来时，禁止补该组字段——同一份报告不会跨组长项。
// 闸 2（单位量纲）：graph 节点自带单位时必须与字段档案单位**归一后逐字相等**（umol/L ≠ %）。
//   不能复用 normalize 的 sameUnitClass：它对 other-vs-% 故意放宽返 true（为免推翻中文名映射），
//   而补回是低置信操作，宁可漏补不可错补。
const BACKFILL_MIN_MAPPED = 8 // 全页可映射 token < 8（小报告/乱码页）→ 证据不足，不启用组闸（保持旧行为）

/** 单位归一成可比 key：小写 + 去非字母数字（容忍 OCR 尾点/逗号/全角） */
function unitKey(u) {
  return normalizeUnit(u || '').toLowerCase().replace(/[^a-z0-9%^]/g, '')
}

/** 本页「已确立的指标组」：全页 token 逐个 mapAlias → group 计数。证据不足返回 null（不设闸）。 */
export function pageGroupEvidence(items) {
  const hist = new Map()
  let mapped = 0
  for (const it of items || []) {
    const t = String((it && it.text) || '').trim()
    if (!t) continue
    const f = FIELD_BY_CODE[mapAlias(t) || '']
    if (!f || !f.group) continue
    mapped++
    hist.set(f.group, (hist.get(f.group) || 0) + 1)
  }
  if (mapped < BACKFILL_MIN_MAPPED) return null
  return { hist, mapped }
}

// ② 在每行循环里被调用（同一份 items 会算 N 次），全页组证据按 items 引用缓存一次即可。
const _groupEvidenceCache = new WeakMap()
function pageGroupEvidenceCached(items) {
  if (!items || typeof items !== 'object') return pageGroupEvidence(items)
  if (_groupEvidenceCache.has(items)) return _groupEvidenceCache.get(items)
  const ev = pageGroupEvidence(items)
  _groupEvidenceCache.set(items, ev)
  return ev
}

/**
 * ② 补回前的准入判定（纯函数，单测直接断言）。
 * @param {string} code 反推命中的字段 code
 * @param {string} nodeUnit graph 节点（物理行）自带的报告单位，可为空
 * @param {{hist:Map<string,number>, mapped:number}|null} evidence pageGroupEvidence 结果（null = 证据不足，不设组闸）
 * @returns {boolean} 是否允许补回
 */
export function backfillAllowed(code, nodeUnit, evidence) {
  const field = FIELD_BY_CODE[code]
  if (!field) return false
  // 闸 1：组一致性——该组在全页零证据 → 判为跨报告类型误补
  if (evidence && field.group && !(evidence.hist.get(field.group) > 0)) return false
  // 闸 2：单位量纲——节点有单位且与档案单位写法不同 → 判为串行/跨项误补
  const nu = unitKey(nodeUnit)
  const fu = unitKey(field.unit)
  if (nu && fu && nu !== fu) return false
  return true
}

export function mergeGraphValueByCode(parsed, items, midX) {
  if (!parsed || parsed.length === 0 || !items || !items.length) return parsed
  const graph = buildDoubleColumnGraph(items, midX)
  if (!graph || graph.length === 0) return parsed
  // codeToGraph：仅用 value+ref 反推确定 code（不用 mapAlias(graph.name)——graph name 乱码易误匹配）
  const codeToGraph = new Map()
  for (const g of graph) {
    if (g.value == null || !g.ref) continue
    let rev = matchFieldByValueRef(g.value, g.ref, g.unit)
    // graph unit 空并列时，用各候选字段 unit 重测；并列则优先 ref 与报告完全相同（maxRelDiff=0）的候选，
    // 按 code 去重后唯一才采纳（如 HBDH 72-182=报告 ref 完全相同 vs TT4 66-181 略不同）
    if (!rev && !g.unit) {
      const cands = []
      for (const f of Object.values(FIELD_BY_CODE)) {
        const r2 = matchFieldByValueRef(g.value, g.ref, f.unit)
        if (r2) cands.push(r2)
      }
      if (cands.length === 1) {
        rev = cands[0]
      } else if (cands.length > 1) {
        const exact = cands.filter((c) => (c.maxRelDiff ?? 1) === 0)
        const exactCodes = new Set(exact.map((c) => c.code))
        if (exactCodes.size === 1) rev = exact[0]
      }
    }
    if (!rev) continue
    if (!codeToGraph.has(rev.code)) codeToGraph.set(rev.code, { value: g.value, ref: g.ref, y: g.y })
  }
  // ① 覆盖：旧路径 name 命中 code 的行，value 越字典 ref（!curInStd）→ 用 graph value 覆盖（保留 name/code）
  const existCodes = new Set()
  for (const p of parsed) {
    if (p.value == null) continue
    const code = p.name ? mapAlias(p.name) || '' : ''
    if (!code) continue
    existCodes.add(code)
    const g = codeToGraph.get(code)
    if (!g) continue
    if (String(p.value) === String(g.value)) continue
    const field = FIELD_BY_CODE[code]
    const stdRef = field ? parseRefRange(field.ref) : null
    const curV = parseFloat(p.value)
    // 仅当旧 value 越出字典 ref（串行嫌疑）才覆盖；在 ref 内（curInStd）保留，避免 graph 自身串行误覆盖
    const curInStd = !stdRef || isNaN(curV) || ((stdRef.low == null || curV >= stdRef.low) && (stdRef.high == null || curV <= stdRef.high))
    if (!curInStd) {
      p.value = g.value
      if (g.ref) p.ref = g.ref
    }
  }
  // ② 补回：graph 反推 code 但 parsed 没有（missing）→ 补回。跳过 detectReportType 固定体系字段，
  // 避免 graph 噪声误补改变报告类型（如误补 TSH → THYROID）；
  // 另过两道安全闸（组一致性 / 单位量纲，见 backfillAllowed），防跨报告类型「无中生有」。
  const evidence = pageGroupEvidenceCached(items)
  for (const [code, g] of codeToGraph) {
    if (existCodes.has(code)) continue
    if (REPORT_TYPE_DEFINING_CODES.has(code)) continue
    const field = FIELD_BY_CODE[code]
    if (!field) continue
    if (!backfillAllowed(code, g.unit, evidence)) continue
    parsed.push({
      name: field.name,
      value: g.value,
      ref: g.ref || field.ref,
      unit: field.unit || '',
      arrow: '',
      _col_idx: g.y != null && midX != null && g.y < midX ? 0 : 1,
    })
    existCodes.add(code)
  }
  return parsed
}

// items → 行文本重建（按 y 聚类成行、行内按 x 拼接）。
// 为什么不能直接 items.join(' ')：join 保留了 token 的**数组顺序**，而几何 token 常按 blocks 顺序
// 而非坐标顺序返回，导致「0.2」与「%」被排到很远、「印象」段也被打散 → 流式正文/取值全落空
// （2026-10-28 浏览器实测：正文抽到了，值却空）。按坐标重建行才与真实阅读顺序一致。
export function itemsToLineText(items) {
  const rows = []
  const sorted = (items || [])
    .filter((it) => it && String(it.text || '').trim())
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
  for (const it of sorted) {
    const y = it.y ?? 0
    const row = rows.find((r) => Math.abs(r.y - y) <= 8)
    if (row) row.items.push(it)
    else rows.push({ y, items: [it] })
  }
  return rows
    .sort((a, b) => a.y - b.y)
    .map((r) => r.items.sort((a, b) => (a.x ?? 0) - (b.x ?? 0)).map((i) => String(i.text || '').trim()).join(' '))
    .join('\n')
}

// 统一入口：给定坐标词项，重建为双栏网格
// items: [{ text, x, y, w }]
// 导出供 scripts/verify-report-types.mjs 等回归测试直接复用（纯函数，无 pdfjs 依赖）
export function buildGridFromItems(items, EPS = 14) {
  // 图文型检验报告（流式免疫分型 / FCM-MRD）短路：这类报告没有指标表格，
  // 几何通道只会把散点图轴标（10³/10⁴）、CD 分子名、门内百分比收成几十行噪声
  // （实测 1007 报告：GRID 28 行、POINTS 出 FOLATE/GGT/NEUT_PCT 等 10 项无中生有的指标），
  // 故沿用检查报告通道的同一条思路——读正文、不读表格，只抽一行「流式MRD残留」。
  const flowGrid = buildFlowGridFromText(itemsToLineText(items))
  if (flowGrid) return flowGrid
  // ---------- 方向 A：Y 轴包围盒重叠聚类（替代旧版 autoEps + 距离式 clusterByY）----------
  // 旧版仅靠 |avgY - y| <= EPS 距离阈值聚类，微信 OCR 的 y 极度碎片化
  // （中位行距 ~2px → autoEps=2 → 真实指标行被切碎成 ~115 碎片行），导致漏项。
  // 改为：① 用「真实行距」(过滤碎片差后的 y 相邻差中位数) 估计行高 rowGap；
  //       ② 每个词项包围盒 [y, y+rowGap]，两盒 Y 轴重叠度 >= OVERLAP_MIN 即归同一行。
  // 碎片在行内仅差 2px（重叠 ~100%），必合并；行间差 ~rowGap（重叠 0），必不合并。
  const estimateRowGap = (arr) => {
    const ys = [...new Set(arr.map((i) => i.y))].sort((a, b) => a - b)
    if (ys.length < 2) return EPS
    const diffs = []
    for (let i = 1; i < ys.length; i++) {
      const d = ys[i] - ys[i - 1]
      if (d > 0) diffs.push(d)
    }
    if (!diffs.length) return EPS
    // 过滤行内抖动（<12px 视为同行碎片），用剩余间隔（行间距）的中位数估计真实行距。
    // 微信图 y 碎片密集（中位差 ~2px），但真实行与行之间 y 差较大（~15-20px）；
    // 用 >=12px 间隔的中位数可避开碎片峰，使行内抖动合并、相邻真实行（~行距）不合并。
    // PDF 文本层行距小（~11px）时 >=12 可能为空，回退到全 diffs 中位数。
    const realGaps = diffs.filter((d) => d >= 12)
    const pool = realGaps.length ? realGaps : diffs
    pool.sort((a, b) => a - b)
    return Math.max(8, pool[Math.floor(pool.length / 2)])
  }
  const rowGap = estimateRowGap(items)
  const OVERLAP_MIN = 0.4 // 重叠度阈值（交集高度 / 较小包围盒高度），0.4 = 合并阈值 ~rowGap*0.6

  // 自适应 EPS 距离聚类：根据真实行距推算合并阈值，既能处理 Tesseract（行距大），
  // 也能兼容微信 OCR（行内碎片 y 极碎、相邻行间距仍明显）的场景。
  const clusterByY = (arr) => {
    // 行内 token 基线抖动：高分辨率渲染图可达 ~0.55×行距（如 1788095314581 的 WBC 行
    // token y 跨度 27px 而行距 51px），13px 硬上限会把同一物理行拆散（序号/值/名称错位）。
    // 上限放宽到 0.75×行距（下限 13）：行距小（微信截图 ~15px → 0.6×15=9<13）不受影响，
    // 行距大（渲染 PDF ~50px）时容差按比例放大；eps 恒 < 行距，不会误并相邻数据行。
    const eps = Math.min(Math.max(10, Math.round(rowGap * 0.6)), Math.max(13, Math.round(rowGap * 0.75)))
    const sorted = [...arr].sort((a, b) => b.y - a.y)
    const lines = []
    for (const it of sorted) {
      const line = lines.find((l) => Math.abs(l.y - it.y) <= eps)
      if (line) line.items.push(it)
      else lines.push({ y: it.y, items: [it] })
    }
    return lines
      .sort((a, b) => a.y - b.y)
      .map((l) => ({
        y: l.y,
        x0: Math.min(...l.items.map((i) => i.x)),
        x1: Math.max(...l.items.map((i) => i.x + (i.w || 0))),
        // 行包围盒 y 范围（y1 用行距近似 token 高度下沿）——供源图定位 point._bbox 使用
        y1: l.y + rowGap,
        items: l.items.sort((a, b) => a.x - b.x),
      }))
      .filter((l) => l.items.some((i) => i.text.trim()))
  }

  // 1) 检测是否为双栏布局（已回退至稳定的旧版 12% 最大 X 间隙法，完全基于 x，与上方聚类无关）
  const xs = items.map((i) => i.x)
  let minX = Math.min(...xs)
  let maxX = Math.max(...xs)
  let lineWidth = Math.max(1, maxX - minX)
  let globalMidX = (minX + maxX) / 2

  const sortedX = [...xs].sort((a, b) => a - b)
  let maxGap = 0
  let splitAt = globalMidX

  for (let i = 1; i < sortedX.length; i++) {
    const g = sortedX[i] - sortedX[i - 1]
    if (g > maxGap) {
      maxGap = g
      splitAt = (sortedX[i] + sortedX[i - 1]) / 2
    }
  }

  // 双栏判定：满足「整页最大相邻 x 间隙 > 12% 宽度」，或「左右半页各自都有足够词项」即视为双栏。
  // 后者覆盖了「左右两栏贴合、无明显中间空白」的血液报告（如本例），避免被误判为单栏后整行混叠。
  const leftCount = xs.filter((x) => x < globalMidX).length
  const rightCount = xs.length - leftCount
  // 双栏判定改进：单栏多列表（项目名在左、值/单位/参考在右）易被旧的
  // `leftCount>=4 && rightCount>=4` 误判为双栏，触发双栏解析通道导致严重错位（详见本报告）。
  // 改为：仅当「数据区左右两栏各自都有足够中文项目名」才判双栏（真双栏左右各一列指标名）；
  // 单栏报告右栏只有值/单位/参考（无中文项目名）→ 单栏。排除页眉/页脚/患者信息/表头行。
  const ysAll = items.map((i) => i.y)
  const yMin = Math.min(...ysAll)
  const yMax = Math.max(...ysAll)
  const dataTop = yMin + (yMax - yMin) * 0.12
  const dataBot = yMax - (yMax - yMin) * 0.08
  const isNameTok = (t) => {
    const s = (t.text || '').trim()
    if (!s) return false
    if (/范围|单位|结果|项目|参考|提示|申请|医院|科室|姓名|性别|年龄|标本|条码|编号|诊断|备注|患者|病历|床号|状态|院|区|组|部|检验/.test(s)) return false
    // 真指标名必含中文且常带英文缩写（如 白细胞(WBC)、中性粒细胞%(NE%)）；
    // 右栏噪声（纯中文「本和 一」、纯英文「HRSA」、单位「g/L」）缺一即排除，避免单栏多列表误判双栏
    if (!/[一-龥]/.test(s)) return false
    if (!/[A-Za-z]/.test(s)) return false
    return true
  }
  let leftName = 0
  let rightName = 0
  for (const it of items) {
    if (it.y < dataTop || it.y > dataBot) continue
    if (!isNameTok(it)) continue
    if (it.x < globalMidX) leftName++
    else rightName++
  }
  const isDoubleCol = maxGap > lineWidth * 0.12 || (leftName >= 3 && rightName >= 3)

  const colSplitX = isDoubleCol ? splitAt : globalMidX
  const leftItems = items.filter((i) => i.x < colSplitX)
  const rightItems = items.filter((i) => i.x >= colSplitX)

  let lineObjs = []
  if (isDoubleCol) {
    // 双栏路径：先分栏 → 左右各自 Y 距离聚类 → 各自独立成行（不按 y 配对）。
    const leftLines = clusterByY(leftItems)
    const rightLines = clusterByY(rightItems)
    lineObjs = [...leftLines, ...rightLines].sort((a, b) => a.y - b.y)
    lineObjs._midX = globalMidX // 供 reassociateDoubleColumn 栏位标记
  } else {
    // 单栏路径：整页 Y 距离聚类
    lineObjs = clusterByY(items)
  }

  // 2) 分栏参考线：默认全局中位线；若某行内存在显著空白间隙（双峰），则改用该行自适应分栏。
  //    扫描件 OCR 常把左右两栏同一水平线的词合并进一行（且左右栏宽不对称），
  //    全局 (minX+maxX)/2 会把整行划到一侧导致 value 取错，需按行内最大间隙切分。
  minX = Math.min(...lineObjs.map((l) => l.x0))
  maxX = Math.max(...lineObjs.map((l) => l.x1))
  globalMidX = (minX + maxX) / 2
  lineWidth = Math.max(1, maxX - minX)

  // 3) 每行解析。单栏整行交给 parseCellTokens（内部按名称词 x 间隔做左右双指标拆分，
  //    不丢 value/ref）；双栏先按全局中线分左右，各自解析后合并。
  // 参考区间常因 OCR 基线错位被识别到「上一行」高度，先汇总全页参考区间候选，事后向下归并
  const refBank = []
  for (const it of items) {
    const t = normalizeLine(it.text.trim())
    if (isRef(t)) refBank.push({ ref: t, y: it.y, col: it.x < colSplitX ? 0 : 1 })
  }

  let rows = []
  // 孤儿缩写暂存：无数值的纯英文/括号行（如 "(Ts)"、"(COL)"）常被 Tesseract 识别到独立
  // baseline 行。按 y 累积，并入同物理行（dy<30）最近的数值行，使其英文缩写能参与 mapAlias 匹配。
  let orphanBank = []
  const isAbbrName = (n) => !!n && /^[A-Za-z0-9#()\s/.\-]+$/.test(n) && !/[一-龥]{2,}/.test(n || '')
  for (const line of lineObjs) {
    const sorted = mergeNumericFragments(line.items) // 已按 x 排序；先合并数字/范围碎片
    if (sorted.length === 0) continue

    // 申请项目行（如「申请项目: 生化全项」）：提取为标题行保留在网格中，
    // 供 detectReportType 标题特征词识别报告类型（避免被下方页眉/表头过滤整行丢弃，
    // 导致「申请项目」文字缺失、报告类型判定失真）。value 用 '' 哨兵：
    // ① 不被 rows 末尾 filter(r => r.value != null) 丢弃；② 在表头行之前，
    //    会被 normalizeGridToPoints 的表头检测跳过，不产生数据点。
    const lineRaw = normalizeLine(sorted.map((x) => x.text).join(' '))
    const applyM = lineRaw.match(/申请项目\s*[:：]?\s*(\S+)/)
    if (applyM) {
      // OCR 行粘连：申请项目名后常紧跟医院/科室名（如「生化全项首都医科大学」），
      // 用机构相关词截断，只保留项目名（如「生化全项」）。
      const applyName = applyM[1].split(/(医科大学|医学院|医学|大学|医院|医|诊疗|医疗|门诊|住院|中心|检验|科)/)[0] || applyM[1]
      rows.push({ name: `申请项目: ${applyName}`, value: '', ref: '', unit: '', arrow: '', col: 0, y: line.y, _title: true })
      continue
    }

    const left = []
    const right = []
    for (const it of sorted) {
      const text = it.text.trim()
      if (!text) continue
      const tok = { t: text, w: it.w || 0, x: it.x }
      if (it.x >= globalMidX) right.push(tok)
      else left.push(tok)
    }
    let parsed
    if (isDoubleCol) {
      // 双栏：左右分别解析（各自可能含多指标）；若名称都被切到两栏导致都无名称，整行合并解析
      const lp = parseCellTokens(left)
      const rp = parseCellTokens(right)
      lp.forEach((p) => (p._col_idx = 0))
      rp.forEach((p) => (p._col_idx = 1))
      parsed = [...lp, ...rp].filter((p) => p && p.name)
      // Graph-based 双栏 re-association：用原始坐标重建 value↔name↔ref 关联，
      // 修正左右栏不对齐导致的 name/value 跨栏失配与 ref 串行。
      parsed = reassociateDoubleColumn(parsed, items, lineObjs)
      // Graph value 融合（bugs.md Bug 015/016）：用 buildDoubleColumnGraph 重建的物理行
      // value 覆盖旧路径串行 value、反推补回 missing，保留旧路径更准的 name/code。
      parsed = mergeGraphValueByCode(parsed, items, globalMidX)
      if (!parsed.some((p) => p.name)) {
        const whole = parseCellTokens([...left, ...right])
        whole.forEach((p) => (p._col_idx = 0))
        if (whole && whole.length) parsed = whole
      }
    } else {
      // 单栏：整行直接解析（parseCellTokens 内部已支持一行内左右并排多指标拆分，且不丢 ref）
      parsed = parseCellTokens([...left, ...right]).filter((p) => p && p.name)
    }
    let valued = parsed.filter((p) => p.value != null)
    // 定性结果行（阴性 / 阳性 / 未检出 / 弱阳性 / ± …）：融合基因检测、传染病筛查、免疫组化等
    // 报告的「测试结果」列写的是文字结论而不是数值，原逻辑只认数值 → 整行被丢弃。
    // 实测（2026-10-22）「白血病融合基因检测」两行全丢，POINTS=0。
    // 保守条件：名称（序号右侧、结果左侧的 token 拼接）必须能在字典别名里命中，避免把噪声行收进来。
    if (valued.length === 0) {
      const QUAL_RE = /^(阴性|阳性|弱阳性|弱阴性|未检出|未见异常|未见|正常|异常|可疑|不确定|±|[+＋]{1,3}|[-－]{1,2}|\(\+\)|\(-\))$/
      const qualTok = sorted.find((it) => QUAL_RE.test(it.text.trim()))
      if (qualTok) {
        const nameParts = sorted
          .filter((it) => it.x < qualTok.x)
          .map((it) => it.text.trim())
          .filter((t) => t && !/^[\d.、]+$/.test(t)) // 去掉序号
          .filter((t) => !/^(PCR|荧光|方法|序号)$/i.test(t))
        const nameText = normalizeLine(nameParts.join(' '))
        if (nameText && mapAlias(nameText)) {
          valued = [{ name: nameText, value: qualTok.text.trim(), ref: '', unit: '', arrow: '', _qualitative: true }]
        }
      }
      // ② 融合基因**定量**行：值是「0/793000=0%」这类复合写法（OCR 常读成「0779300F 0」），
      // 名字纯 ASCII 且被读花（Pl907aBL1x100%）。逐个切点试：前半段能被 repairFusionName 修形成
      // 融合基因标准名、后半段含数字 → 就承认这一行（具体取值/单位在 normalize 里做容错解析）。
      if (valued.length === 0) {
        const toks = sorted.map((it) => it.text.trim()).filter(Boolean)
        for (let cut = 1; cut < toks.length; cut++) {
          const head = normalizeLine(toks.slice(0, cut).filter((t) => !/^\d{1,2}$/.test(t)).join(' '))
          if (!head || !repairFusionName(head)) continue
          const rest = toks.slice(cut).filter((t) => !/(PCR|荧光|方法)/i.test(t)).join(' ')
          if (!/\d/.test(rest)) continue
          valued = [{ name: head, value: rest, ref: '', unit: '', arrow: '', _qualitative: true, _fusion: true }]
          break
        }
      }
    }
    const orphans = parsed.filter((p) => p.value == null && p.name && isAbbrName(p.name))
    // 整行无数值：把纯英文/括号孤儿累积到 orphanBank（按 y），不丢弃
    if (valued.length === 0) {
      for (const o of orphans) orphanBank.push({ name: o.name, y: line.y })
      continue
    }
    // 到这里 valued 至少有一行（数值行或上面的定性行）；parsed 可能为空（定性行就是这种情况）
    const firstName = (parsed[0] && parsed[0].name) || (valued[0] && valued[0].name) || ''
    // 跳过表头行
    const lineText = normalizeLine(sorted.map((x) => x.text).join(' '))
    if (/范围|单位|结果|项目|参考/.test(lineText) && !/^[A-Za-z#]/.test(firstName) && !valued.some((p) => p._qualitative)) continue
    if (/报告单|报告|姓名|性别|年龄|住院|病案|送检|检验者|采集|接收|报告时间|地址|电话|※|此报告|仅对|【|】|条码|标本|流水|仪器|病历|床号|科室|编号|诊断/.test(lineText) && !/^[A-Za-z#]/.test(firstName) && !valued.some((p) => p._qualitative)) continue
    if (!firstName && !(parsed[1] && parsed[1].name)) continue
    // 多指标行：每个指标展平为一行，并把 y 最近的孤儿缩写并入 name（处理 value 之前/同行的孤儿）
    for (const p of valued) {
      const near = orphanBank.filter((o) => Math.abs((o.y || 0) - (line.y || 0)) < 60)
      if (near.length) p.name = (p.name + ' ' + near.map((o) => o.name).join(' ')).trim()
      rows.push({
        name: p.name,
        value: p.value,
        ref: p.ref || '',
        unit: p.unit,
        arrow: p.arrow,
        col: p._col_idx,
        y: line.y,
        // 源图定位：行包围盒（像素系，由 ocrEngines 归一化成 0-1 比例后进 point._bbox）
        _bbox: line.x0 != null ? { x0: line.x0, x1: line.x1, y0: line.y, y1: line.y1 ?? line.y + rowGap } : undefined,
      })
    }
    orphanBank = orphanBank.filter((o) => Math.abs((o.y || 0) - (line.y || 0)) >= 30)
    // 本行孤儿（在 value 之后、同物理行）：附加到刚推入的最后一个数值行
    for (const o of orphans) {
      const last = [...rows].reverse().find((r) => r.value != null)
      if (last) last.name = (last.name + ' ' + o.name).trim()
    }
  }

  // 循环结束后兜底：残留孤儿（在其数值行之后、y 略大）按 y 最近并入已推入的数值行
  for (const o of orphanBank) {
    let best = null
    let bestDy = 1e9
    for (const v of rows) {
      if (v.value == null) continue
      const dy = Math.abs((v.y || 0) - (o.y || 0))
      if (dy < bestDy) { bestDy = dy; best = v }
    }
    if (best && bestDy < 60) best.name = (best.name + ' ' + o.name).trim()
  }

  // 参考区间归并：把「上一行高度」的参考区间补回同栏最近的结果行（OCR 基线错位补偿）
  for (const r of rows) {
    if (r.ref) continue
    let best = null
    let bestDy = 1e9
    for (const rb of refBank) {
      if (rb.col !== r.col) continue
      const dy = rb.y - r.y // 参考区间通常略高于结果（dy 为负）
      if (dy >= -22 && dy <= 6 && Math.abs(dy) < Math.abs(bestDy)) {
        best = rb
        bestDy = dy
      }
    }
    if (best) r.ref = best.ref
  }

  // name/value 跨 cell 合并：同一指标的项目名与数值常被 OCR 切到不同列/行（尤其双栏密集表），
  // 此处把「无 value 的名称行」并入 y 最近（<40px）的「有 value 结果行」，使其英文缩写能参与 mapAlias 匹配。
  {
    const valued = rows.filter((r) => r.value != null)
    const nameOnly = rows.filter(
      (r) =>
        r.value == null &&
        r.name &&
        !/范围|单位|结果|项目|参考|报告|姓名|性别|年龄|住院|病案|送检|检验者/.test(r.name)
    )
    for (const n of nameOnly) {
      let best = null
      let bestDy = 1e9
      for (const v of valued) {
        const dy = Math.abs((v.y || 0) - (n.y || 0))
        if (dy < bestDy) { bestDy = dy; best = v }
      }
      if (best && bestDy < 40) best.name = (best.name + ' ' + n.name).trim()
    }
    rows = rows.filter((r) => r.value != null)
  }

  // 5) 去重（标题行单独提取，不进入数据行）
  const seen = new Set()
  const unique = []
  let titleRow = null
  for (const r of rows) {
    if (r._title) {
      titleRow = r
      continue
    }
    const key = [r.name, r.value, r.ref, r.unit, r.arrow, r.col].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    // 第 7 列 = 行包围盒（像素系 {x0,y0,x1,y1}），normalize.js 读 row[6] 透传为 point._bbox；
    // 无 _bbox 的行（策略融合补行/单栏回退）推 null 占位，保证列位对齐。
    unique.push([r.name, r.value, r.ref, r.unit, r.arrow, r.col, r._bbox || null])
  }

  // 5) 双栏解析未得到数据行时，尝试单栏 5 列表格解析。
  //    很多医院 PDF 是「项目名称 | 结果 | 提示 | 参考范围 | 单位」单栏布局，
  //    整行就是一个完整数据行，直接 parseCellTokens 即可。
  //    另需兼容定性报告（感染筛查/血型/真菌 G+GM 等）：结果可能是文本值
  //    （阴性/阳性/O型）、低于检测下限（<40.0000）、参考范围为汉字（阴性～阳性），
  //    且结果值常独立成一行（需与下一行项目名跨行合并）。
  if (unique.length <= 1) {
    const singleRows = []
    // 结果值独立一行的判定：行内全是值 token（<40.0000 / O型 / 阳性），无参考范围
    const isValueLine = (toks) =>
      toks.length <= 2 && !toks.some((x) => isRef(x.t) || isRefCn(x.t)) && toks.every((x) => QUAL_VALUE.test(x.t))
    // 宽松解析：value 支持文本值/<数字，ref 支持汉字范围（阴性～阳性）
    const parseQual = (tokens) => {
      let arrow = ''
      let ref = ''
      let unit = ''
      const name = []
      const vals = []
      // 项目数字识别：行首 1-2 位整数且其后紧跟项目名（非值/非参考/非单位）→ 序号
      let itemNo = null
      if (tokens.length >= 2 && /^\d{1,2}$/.test(String(tokens[0].t ?? tokens[0]).trim())) {
        const second = String(tokens[1].t ?? tokens[1]).trim()
        if (!isNum(second) && !isRef(second) && !isRefCn(second) && !isUnitToken(second)) {
          itemNo = Number(String(tokens[0].t ?? tokens[0]).trim())
          tokens = tokens.slice(1)
        }
      }
      for (const tok of tokens) {
        const t = String(tok.t ?? tok).trim()
        if (!t || /^[*#]$/.test(t)) continue
        if (/[↑↓]/.test(t) && t.length <= 2) {
          arrow = /↓/.test(t) ? '↓' : '↑'
          continue
        }
        if (isRef(t) || isRefCn(t)) {
          if (!ref) ref = t
          continue
        }
        if (isNum(t) || QUAL_VALUE.test(t)) {
          vals.push(t)
          continue
        }
        if (isUnitToken(t)) {
          if (!unit) unit = t
          continue
        }
        name.push(t)
      }
      if (name.length === 0 && vals.length === 0) return null
      // 值：优先数字（<40.0000 / 0.07），否则取第一个文本值（阴性/阳性/O型）
      const numV = vals.find((v) => isNum(v))
      const value = numV != null ? numV : vals[0] || ''
      // 定性检验参考范围常为文本（如 HCV 参考「阴性」）：多个文本值时最后一个视为参考范围
      if (!ref && vals.length > 1 && !isNum(vals[0])) ref = vals[vals.length - 1]
      // 未测量项（如血小板分布宽度 PDW 显示「一一」）：把「一一/——/—」从项目名中剔除，
      // 标记为「存在但值空」，供 buildGrid 保留该行而不当普通元信息丢弃。
      if (name.length && /^(一一|——|—+|--+)$/.test(name[name.length - 1])) {
        name.pop()
      }
      const baseName = cleanProjectName(name.join(' '))
      // 项目数字识别：把行首捕获到的序号 prepend 到项目名前，供 normalize 提取为 _item_no
      return { name: itemNo != null && baseName ? `${itemNo} ${baseName}` : baseName, value, ref, unit, arrow }
    }
    let pendingVals = []
    for (const line of lineObjs) {
      const sorted = mergeNumericFragments(line.items)
      const toks = sorted.map((it) => ({ t: it.text.trim(), w: it.w || 0 })).filter((x) => x.t)
      if (isValueLine(toks)) {
        pendingVals.push(toks.map((x) => x.t).join(''))
        continue
      }
      let ptoks = toks
      if (pendingVals.length > 0) {
        // 把独立结果值合并到本行：插到参考范围之前（项目名之后）
        const ri = ptoks.findIndex((x) => isRef(x.t) || isRefCn(x.t))
        const merged = pendingVals.join(' ')
        ptoks = ri >= 0 ? [...ptoks.slice(0, ri), { t: merged }, ...ptoks.slice(ri)] : [{ t: merged }, ...ptoks]
        pendingVals = []
      }
      const parsed = parseQual(ptoks)
      if (!parsed) continue
      // 值可空（未测量项如 PDW/MPV 显示「一一」），但必须有项目名且带单位或参考范围才保留，
      // 避免把无名的零散文本当数据行。
      if (!parsed.value && !(parsed.name && (parsed.unit || parsed.ref))) continue
      const lineText = normalizeLine(toks.map((x) => x.t).join(' '))
      // 过滤表头、报告说明、患者信息等非数据行
      if (/报告单|姓名|性别|年龄|住院|病案|送检|检验者|采集|接收|报告时间|地址|电话|※|此报告|仅对|【|】|条码|标本|流水|仪器|病历|床号|科室|编号|诊断/.test(lineText)) continue
      if (/范围.*单位|项目.*名称.*结果|参考范围|单位.*结果/.test(lineText) && !/^[A-Za-z#]/.test(parsed.name)) continue
      singleRows.push([parsed.name, parsed.value, parsed.ref || '', parsed.unit || '', parsed.arrow || ''])
    }
    if (singleRows.length > 1) {
      return [['检验项目', '结果', '参考范围', '单位', '提示'], ...singleRows]
    }
  }

  if (unique.length === 0 && !titleRow) return []
  const header5 = ['检验项目', '结果', '参考范围', '单位', '提示']
  // 标题行（如「申请项目: 生化全项」）置于表头之前：
  // ① 文本进入 grid.flat() 供 detectReportType 标题特征词识别报告类型；
  // ② 位于表头之前，normalizeGridToPoints 的表头检测会从表头行后开始遍历，不产生数据点。
  const first = titleRow ? [titleRow.name, '', '', '', '', titleRow.col || 0] : null
  return [first, header5, ...unique].filter(Boolean)
}

// PDF dataUrl → pdfjs document（多页改造后三处 getPage 共用，避免重复 base64 解码）
async function loadPdfDoc(dataUrl) {
  // 与 scripts/pdf-to-text.mjs 同源：base64 → Uint8Array → getDocument
  const b64 = dataUrl.split(',')[1] || ''
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return pdfjsLib.getDocument({ data: buf }).promise
}

// 单页 → 文本层坐标词项（毫秒级，完全本地）
async function extractPdfPageItems(pdf, pageNo) {
  const page = await pdf.getPage(pageNo)
  const tc = await page.getTextContent()
  return tc.items
    .filter((it) => 'transform' in it && typeof it.str === 'string')
    .map((it) => ({
      text: it.str.trim(),
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
    }))
    .filter((it) => it.text)
}

// PDF dataUrl → 第 1 页文本层坐标词项（保留第一页语义，供单页调用方复用）
async function extractPdfItems(dataUrl) {
  const pdf = await loadPdfDoc(dataUrl)
  const items = await extractPdfPageItems(pdf, 1)
  if (items.length === 0) {
    throw new Error('PDF 文本层为空（可能是扫描件），请导出为图片上传')
  }
  return items
}

// 续页表头 / 标题行判定：
// 多页化验单从第 2 页起通常重复输出「申请项目 / 检验项目 / 结果 / 参考范围 / 单位 / 提示」，
// 若整行并入数据行会被 normalize 当成指标行解析（污染数据），合并网格时必须剔除。
// 判据刻意收紧：行内出现任何数字即判为数据行，绝不误删真指标。
const HEADER_CELL_RE = /^(检验项目|检测项目|项目|名称|结果|参考范围|参考区间|单位|提示|标志|范围)$/
export function isHeaderLikeRow(row) {
  if (!Array.isArray(row) || row.length === 0) return false
  const cells = row.filter((c) => typeof c === 'string' && c.trim())
  if (cells.length === 0) return false
  if (cells.some((c) => /\d/.test(c))) return false // 有数字 = 数据行，绝不删
  const joined = cells.join('')
  if (/申请项目|检验项目|检测项目/.test(joined)) return true
  return cells.filter((c) => HEADER_CELL_RE.test(c.trim())).length >= 2
}

// 逐页网格 → 一条记录的行序列（多页合并为一份报告）
// 关键：绝不能把多页 items 直接拼给 buildGridFromItems —— 不同页的 y 坐标会互相重叠，
// 跨页混行会产出「看着合理但错」的错值（比丢数据更危险）。故每页独立建网格，再按页序拼行。
export function mergePageGrids(grids) {
  const out = []
  grids.forEach((g, i) => {
    if (!Array.isArray(g)) return
    for (const row of g) {
      if (i > 0 && isHeaderLikeRow(row)) continue // 仅首页保留表头，续页表头剔除
      out.push(row)
    }
  })
  return out
}

// PDF dataUrl → 全部页文本层 → 合并网格（修复「多页化验单只认第 1 页」的丢数据缺陷）
export async function buildGridFromPdf(dataUrl) {
  const pdf = await loadPdfDoc(dataUrl)
  const pageCount = pdf.numPages || 1
  const grids = []
  let allItems = []
  for (let p = 1; p <= pageCount; p++) {
    const items = await extractPdfPageItems(pdf, p)
    if (items.length === 0) continue // 空页（纯图页）跳过，不影响其它页
    allItems = allItems.concat(items)
    grids.push(buildGridFromItems(items))
  }
  if (allItems.length === 0) {
    throw new Error('PDF 文本层为空（可能是扫描件），请导出为图片上传')
  }
  return { grid: mergePageGrids(grids), items: allItems, pageCount }
}

// PDF dataUrl → 第一页渲染为 JPEG dataUrl
// 用途：① 「脱敏原图」预览与存档缩略图（原件始终存整份 PDF，预览取首页即可）；
//       ② 无内嵌图 PDF 的 OCR 兜底。多页识别走 renderPdfAllPages，不在此处。
export async function pdfFirstPageToDataUrl(dataUrl, maxWidth = 1600) {
  const pdf = await loadPdfDoc(dataUrl)
  return renderPdfPageToDataUrl(pdf, 1, maxWidth)
}

// 单页 → 渲染为 JPEG dataUrl
async function renderPdfPageToDataUrl(pdf, pageNo, maxWidth) {
  const page = await pdf.getPage(pageNo)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(maxWidth / base.width, 3)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas.toDataURL('image/jpeg', 0.92)
}

// 多页：逐页渲染（无内嵌图 PDF 的 OCR 兜底，修复「只认第 1 页」）
export async function renderPdfAllPages(dataUrl, maxWidth = 2400) {
  const pdf = await loadPdfDoc(dataUrl)
  const out = []
  for (let p = 1; p <= (pdf.numPages || 1); p++) {
    try {
      out.push(await renderPdfPageToDataUrl(pdf, p, maxWidth))
    } catch (e) {
      console.warn(`多页 PDF 第 ${p} 页渲染失败，跳过：`, e && e.message)
    }
  }
  return out
}

// 判断 pdfjs 内嵌图像是否为 JPEG 原始数据（没有 kind 枚举，但 data 长度远小于像素数）
function looksLikeJpeg(img) {
  if (!img.data || !img.data.length) return false
  const pxCount = img.width * img.height
  // RGB/RGBA/灰度等解码后的数据量约为像素数 * 1~4；JPEG 原始字节通常远小于像素数
  if (pxCount && img.data.length > pxCount * 4) return false
  // 简单魔数校验
  return img.data[0] === 0xff && img.data[1] === 0xd8 && img.data[img.data.length - 2] === 0xff && img.data[img.data.length - 1] === 0xd9
}

// 将 Uint8Array（JPEG/PNG 原始字节）解码为可 drawImage 的 ImageBitmap / HTMLImageElement
async function decodeBinaryImage(uint8) {
  const blob = new Blob([uint8], { type: 'image/jpeg' })
  if (typeof createImageBitmap !== 'undefined') {
    return createImageBitmap(blob)
  }
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

// 解码 pdfjs 内嵌图像像素为 RGBA Uint8ClampedArray
function decodePdfImagePixels(img) {
  const { ImageKind } = pdfjsLib
  if (!img.data || !img.width || !img.height) {
    throw new Error('PDF 内嵌图像像素未加载')
  }
  const pxCount = img.width * img.height
  if (img.kind === ImageKind.GRAYSCALE_1BPP) {
    const rgba = new Uint8ClampedArray(pxCount * 4)
    for (let i = 0; i < img.data.length; i++) {
      for (let b = 0; b < 8; b++) {
        const px = i * 8 + b
        if (px >= pxCount) break
        const v = (img.data[i] >> (7 - b)) & 1 ? 0 : 255
        rgba.set([v, v, v, 255], px * 4)
      }
    }
    return rgba
  }
  if (img.kind === ImageKind.GRAYSCALE_8BPP) {
    const rgba = new Uint8ClampedArray(pxCount * 4)
    for (let i = 0; i < img.data.length; i++) rgba.set([img.data[i], img.data[i], img.data[i], 255], i * 4)
    return rgba
  }
  if (img.kind === ImageKind.RGB_24BPP) {
    const rgba = new Uint8ClampedArray(pxCount * 4)
    for (let i = 0; i < pxCount; i++) rgba.set([img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2], 255], i * 4)
    return rgba
  }
  if (img.kind === ImageKind.RGBA_32BPP) {
    return new Uint8ClampedArray(img.data)
  }
  throw new Error(`不支持的 PDF 内嵌图片格式 kind=${img.kind}`)
}

// PDF dataUrl → 提取第 i 页最大内嵌原图 → 自动旋转 → JPEG dataUrl。
// 扫描件 PDF 若直接把页面渲染喂给 Tesseract，会受页面裁剪/缩放/方向影响；
// 直接取内嵌原图（通常分辨率最高）并旋转到文字水平，识别质量更好。
export async function extractPdfImageDataUrl(dataUrl, maxWidth = 3000) {
  const pdf = await loadPdfDoc(dataUrl)
  return extractPageImageDataUrl(pdf, 1, maxWidth)
}

// 多页：逐页提取内嵌原图（扫描件多页不再只认第 1 页）；取不到内嵌图的页跳过。
export async function extractPdfAllPageImages(dataUrl, maxWidth = 3000) {
  const pdf = await loadPdfDoc(dataUrl)
  const out = []
  for (let p = 1; p <= (pdf.numPages || 1); p++) {
    try {
      out.push(await extractPageImageDataUrl(pdf, p, maxWidth))
    } catch (e) {
      console.warn(`多页 PDF 第 ${p} 页内嵌图提取失败，跳过：`, e && e.message)
    }
  }
  return out
}

async function extractPageImageDataUrl(pdf, pageNo, maxWidth) {
  const page = await pdf.getPage(pageNo)
  const ops = await page.getOperatorList()

  // 收集所有 paintImageXObject，优先用面积最大且像素已解码的图（页面扫描图通常最大）
  const imgNames = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject) {
      imgNames.push(ops.argsArray[i][0])
    }
  }
  if (imgNames.length === 0) throw new Error(`PDF 第 ${pageNo} 页未找到内嵌图片`)

  let best = null
  for (const name of imgNames) {
    try {
      const img = await new Promise((res, rej) => page.objs.get(name, res, rej))
      // pdfjs 对 JPEG 扫描件通常直接提供解码后的 ImageBitmap（img.data 可能为 null）
      if (!img || (!img.data && !img.bitmap) || !img.width || !img.height) continue
      const area = img.width * img.height
      if (!best || area > best.area) best = { img, name, area }
    } catch {
      // 忽略单个图片读取失败
    }
  }
  if (!best) throw new Error('PDF 内嵌图片像素未加载')

  const img = best.img
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = img.width
  srcCanvas.height = img.height
  const srcCtx = srcCanvas.getContext('2d')

  if (img.bitmap) {
    // pdfjs 已解码为 ImageBitmap（常见 JPEG/PNG 扫描件），直接绘制
    srcCtx.drawImage(img.bitmap, 0, 0)
  } else if (looksLikeJpeg(img)) {
    // JPEG 原始字节：解码成图片后绘制
    const bitmap = await decodeBinaryImage(new Uint8Array(img.data))
    srcCtx.drawImage(bitmap, 0, 0)
  } else {
    srcCtx.putImageData(new ImageData(decodePdfImagePixels(img), img.width, img.height), 0, 0)
  }

  // 扫描件常见情况：竖版 A4 被旋转进横向页面，导致内嵌图高>宽但页面却是横版。
  // 此时顺时针旋转 90° 可让文字回到水平阅读方向（已在 1786691394874.pdf 验证）。
  // 若内嵌图方向与 PDF 页面方向一致（如 2216533.pdf，同为竖版），则不应旋转。
  // 注意：必须用 getViewport（已含 page.rotate）判断“显示方向”，而非 page.view 原始坐标。
  // page.view 返回未旋转坐标，遇到 rotate=90 的页面会误判为竖版，导致该旋转却不旋转
  // （1787143061158.pdf：raw 竖版 + rotate=90 → 显示横向，内嵌图内容横置，必须旋转）。
  const vp = page.getViewport({ scale: 1 })
  const imgPortrait = img.height > img.width
  const dispPortrait = vp.height > vp.width
  let outCanvas = srcCanvas
  if (imgPortrait !== dispPortrait) {
    outCanvas = document.createElement('canvas')
    outCanvas.width = img.height
    outCanvas.height = img.width
    const ctx = outCanvas.getContext('2d')
    ctx.translate(outCanvas.width, 0)
    ctx.rotate(Math.PI / 2)
    ctx.drawImage(srcCanvas, 0, 0)
  }

  // 限制最大宽度，避免超大扫描图拖慢 OCR
  if (outCanvas.width > maxWidth) {
    const scale = maxWidth / outCanvas.width
    const scaled = document.createElement('canvas')
    scaled.width = maxWidth
    scaled.height = Math.round(outCanvas.height * scale)
    const sctx = scaled.getContext('2d')
    sctx.imageSmoothingEnabled = true
    sctx.drawImage(outCanvas, 0, 0, scaled.width, scaled.height)
    outCanvas = scaled
  }
  return outCanvas.toDataURL('image/jpeg', 0.92)
}

// Tesseract 图片 OCR → blocks(带 bbox) → 坐标词项
export function ocrBlocksToItems(data) {
  const items = []
  const blocks = data.blocks || []
  for (const b of blocks) {
    for (const p of b.paragraphs || []) {
      for (const line of p.lines || []) {
        const words = (line.words || []).filter((w) => w.text && w.text.trim() && w.bbox)
        if (words.length === 0) continue
        for (const w of words) {
          items.push({ text: w.text.trim(), x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0 })
        }
      }
    }
  }
  return items
}

/* ---------------- 检查日期识别 ---------------- */

// 从坐标词项中提取化验单「检查日期」与精确时间。
// 优先级：采集/采样类标签 → 报告/检验类标签 → 全文首个日期；月份/日期/年份范围双重校验。
// 返回 { date: 'YYYY-MM-DD'|null, time: 'HH:mm'|'' }——日期后紧跟的时分一并识别（记录更精确，图表仍按日期聚合）。
// 提取化验单的采集时间与报告时间（两者可能不同，均记录）。
// 返回 { date, time, collectedAt, reportedAt }：
//   - date: 优先采集日期，其次报告日期（图表按天聚合的主键）
//   - time: 与 date 对应的时分（采集/报告任一）
//   - collectedAt: 'YYYY-MM-DD HH:mm' 或 'YYYY-MM-DD' 或 ''
//   - reportedAt: 同上
export function extractReportDate(items) {
  const NO_DATE_EVT = { code: 'no_date', message: '未识别到报告日期，请手动选择' }
  const EMPTY = { date: null, time: '', collectedAt: '', reportedAt: '', dateSource: 'none', dateEvents: [NO_DATE_EVT] }
  if (!items || items.length === 0) return EMPTY

  // 行重组（同 y 归一行，x 排序）→ 从上到下拼接全文
  const EPS = 3
  const lines = []
  for (const it of [...items].sort((a, b) => b.y - a.y)) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= EPS)
    if (line) line.items.push(it)
    else lines.push({ y: it.y, items: [it] })
  }
  const text = lines
    .sort((a, b) => b.y - a.y)
    .map((l) => l.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(' '))
    .join('\n')
  // 去空白：pdfjs/Tesseract 可能把「2026 - 08 - 09」拆成多个 token，先压平再匹配
  const compact = text.replace(/\s+/g, '')

  // YYYY-MM-DD / YY-MM-DD / YYYY/MM/DD / YYYY年M月D日 / YYYY.MM.DD
  // OCR 常把 2026 读成 26（漏前两位），故年份允许 2~4 位，normalize 内补全
  // 压平后「2026-08-09 09:18」形如 2026-08-0909:18，日期后紧跟的时分一并捕获
  // 时分分隔符兼容 OCR 噪声：冒号「:」是标准写法，但扫描件常把「:」误读为点「.」、连字符「-」或度「°」
  // （实测样本：采样时间 04.36 / 报告时间 08-01 / 11.53 / 830 采样时间 04°36 把 : 读成 °），
  // 故时分分隔放宽为 [:.-°]，否则点/连字符/度分隔的时分会被整段丢弃（只拿到日期、丢失具体时刻）——即「时间识别不出来」的根因。
  // 安全：月分隔用 [-./年]、时分分隔用 [:.-°]，二者位置不重叠（日期已消费到「日」才进可选时分组），
  // 不会把「月-日」误判为「时-分」；° 入时分组也安全（温度 37°C 的 ° 后非两位数字，不会误匹配）。
  const DATE_RE = /(\d{2,4})[-./年](\d{1,2})[-./月](\d{1,2})日?(?:(\d{1,2})[:：时.\-°](\d{1,2})分?)?/g
  // 无年份写法（微信/支付宝报告常见「08-04」「8月4日」「08/04」）：年份只能借同报告内的显式年份，
  // 绝不臆造——全文没有任何带年日期时一律不采用（宁可留空提示，也不静默填错年）。
  const NOYEAR_RE = /(\d{1,2})[-./月](\d{1,2})日?(?:(\d{1,2})[:：时.\-°](\d{1,2})分?)?/g
  // 只有时刻、日期在别处（如「报告时间: 11:09」）：需借同报告已确定的日期拼回完整时间
  const TIME_ONLY_RE = /(\d{1,2})[:：时](\d{1,2})分?/g

  const normalize = (y, m, d, hh, mm) => {
    let Y = +y
    const M = +m
    const D = +d
    // 2 位年份自动补全 20xx（OCR 常把 2026 读成 26）
    if (Y < 100) Y = 2000 + Y
    if (Y < 2000 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31) return null
    const dt = new Date(Y, M - 1, D)
    if (dt.getFullYear() !== Y || dt.getMonth() !== M - 1 || dt.getDate() !== D) return null
    const pad = (n) => String(n).padStart(2, '0')
    const date = `${Y}-${pad(M)}-${pad(D)}`
    let time = ''
    if (hh != null && mm != null) {
      const H = +hh
      const Mi = +mm
      if (H >= 0 && H <= 23 && Mi >= 0 && Mi <= 59) time = `${pad(H)}:${pad(Mi)}`
    }
    return { date, time }
  }

  // 从 compact 的 from 位置起找第一个合理日期（可带紧跟时分）
  // 修复：遇到 normalize 为 null 的非法串（如 OCR 把电话号码读成「3010-52-01」、年份越界）时，
  // 跳过它继续往后找，而非整段放弃——否则报告真正日期（在非法串之后）永远轮不到，兜底退化为 no_date。
  const firstMatch = (from) => {
    DATE_RE.lastIndex = from || 0
    let m
    while ((m = DATE_RE.exec(compact))) {
      const n = normalize(m[1], m[2], m[3], m[4], m[5])
      if (n) return n
    }
    return null
  }

  // 在 compact 的 [from, to) 窗口内找最近合理日期（不跨过窗口）
  // 用于：标签后取最近日期，避免被同行下一个标签的日期污染（如页脚 申请/采样/接收/报告 四段连排）
  const firstMatchInWindow = (str, from, to) => {
    DATE_RE.lastIndex = from
    const m = DATE_RE.exec(str)
    if (!m) return null
    if (m.index >= to) return null
    return normalize(m[1], m[2], m[3], m[4], m[5])
  }

  // 无年份日期（「08-04」「8月4日」）：year 来自同报告内已出现的显式年份；year 为空则不采用。
  // 逐个候选试到第一个「真实存在」的日期为止——首个候选非法（如把 2026 的 26 当月）时不能被卡死。
  const pickNoYear = (str, from, to, year) => {
    if (year == null) return null
    NOYEAR_RE.lastIndex = from
    let m
    while ((m = NOYEAR_RE.exec(str))) {
      if (m.index >= to) return null
      const M = +m[1]
      const D = +m[2]
      if (M < 1 || M > 12 || D < 1 || D > 31) continue
      const dt = new Date(year, M - 1, D)
      if (dt.getFullYear() !== year || dt.getMonth() !== M - 1 || dt.getDate() !== D) continue
      const pad = (n) => String(n).padStart(2, '0')
      let time = ''
      if (m[3] != null && m[4] != null) {
        const H = +m[3]
        const Mi = +m[4]
        if (H >= 0 && H <= 23 && Mi >= 0 && Mi <= 59) time = `${pad(H)}:${pad(Mi)}`
      }
      return { d: { date: `${year}-${pad(M)}-${pad(D)}`, time }, at: m.index }
    }
    return null
  }

  // 只有时刻（「11:09」「11时09分」）：返回 'HH:mm'，日期由调用方用同报告已确定的日期补
  const pickTimeOnly = (str, from, to) => {
    TIME_ONLY_RE.lastIndex = from
    let m
    while ((m = TIME_ONLY_RE.exec(str))) {
      if (m.index >= to) return ''
      const H = +m[1]
      const Mi = +m[2]
      if (H >= 0 && H <= 23 && Mi >= 0 && Mi <= 59) {
        return `${String(H).padStart(2, '0')}:${String(Mi).padStart(2, '0')}`
      }
    }
    return ''
  }

  const fmt = (d) => (d && d.time ? `${d.date} ${d.time}` : d ? d.date : '')

  // 报告内所有「带年份」的合理日期：① 给无年份写法补年份 ② 无标签时的兜底
  DATE_RE.lastIndex = 0
  const allDated = []
  for (const m of compact.matchAll(DATE_RE)) {
    const n = normalize(m[1], m[2], m[3], m[4], m[5])
    if (n) allDated.push(n)
  }
  const contextYear = allDated.length ? +allDated[0].date.slice(0, 4) : null

  // 标签后取日期：完整日期 与 无年份日期「谁离标签更近谁优先」→ 只有时刻（借 baseDate 拼日期）
  // 关键：不能无条件先取完整日期——「采样时间: 08-04 10:44 报告时间: 2026-08-04 11:09」里
  // 08-04 只占 10 字符，18 字符窗口会越过后一个标签，把报告的 11:09 误当成采样时间。
  const pickAt = (from, to, baseDate = '') => {
    DATE_RE.lastIndex = from
    const mf = DATE_RE.exec(compact)
    let full = null
    let fullAt = Infinity
    if (mf && mf.index < to) {
      const n = normalize(mf[1], mf[2], mf[3], mf[4], mf[5])
      if (n) {
        full = n
        fullAt = mf.index
      }
    }
    const no = pickNoYear(compact, from, to, contextYear)
    if (full && no) return fmt(no.at < fullAt ? no.d : full)
    if (full) return fmt(full)
    if (no) return fmt(no.d)
    if (baseDate) {
      const t = pickTimeOnly(compact, from, to)
      if (t) return `${baseDate} ${t}`
    }
    return ''
  }
  const pickFromLabel = (keys, baseDate = '') => {
    for (const k of keys) {
      const idx = compact.indexOf(k)
      if (idx < 0) continue
      const r = pickAt(idx + k.length, idx + k.length + 18, baseDate)
      if (r) return r
    }
    return ''
  }

  // 1) 采集/采样类 → collectedAt
  //   容错点：① 标签后"时间/日期"二字易被 OCR 漏（→「采样」「抽血」单独列）;
  //          ② 同 y 行多个时间串连时，精确标签后可能被同行的"申请时间"日期污染
  //              → 在该位置起 18 字符窗口内找最近日期（够短，避免跨过同行下一个标签）
  //   无采集标签时退到「接收」类：标本入实验室，日期最接近采样日（如 794 报告只有「接收日期」）。
  const COLLECT_KEYS = ['采集时间', '采集日期', '采样时间', '抽血时间', '抽血日期', '标本采集', '采血时间',
                        '采样', '抽血', '采血', '标本']
  const RECEIVE_KEYS = ['接收时间', '接收日期', '标本接收', '收到时间']
  let collectedAt = pickFromLabel(COLLECT_KEYS) || pickFromLabel(RECEIVE_KEYS)

  // 2) 报告/检验类 → reportedAt
  //   同样容错"时间/日期"二字被 OCR 漏（→「报告」「检验」单列），
  //   但「报告」单字易撞"报告单/本报告"等，需先排除
  const REPORT_KEYS = ['报告时间', '报告日期', '出报告时间', '检验时间', '检验日期',
                       '打印时间', '审核时间', '签发时间', '送检时间']
  const baseDate = collectedAt ? collectedAt.slice(0, 10) : allDated[0] ? allDated[0].date : ''
  let reportedAt = pickFromLabel(REPORT_KEYS, baseDate)
  if (!reportedAt) {
    // 兜底：寻找「报告」+ 18 字符内的日期（跳过"本报告/此报告/报告单"等词头与句子中的"报告"）
    // 注意：正则的前导排除符可能吃掉 1 个字符，必须用 rm.index + rm[0].length 精确定位「报告」之后，
    // 不能用固定 +3（行首 ^ 匹配时会错位一位，把日期首位数字吞掉）。
    const rm = /(?:^|[^本此仅该])报告(?![单纸版章章章是对负])/.exec(compact)
    if (rm) {
      const from = rm.index + rm[0].length
      reportedAt = pickAt(from, from + 18, baseDate)
    }
  }
  // 3) 兜底：全文首个合理日期（带时分）
  const fallback = firstMatch(0)

  // 汇总：date 优先采集、其次报告、再兜底；time 与 date 同源
  const primary = collectedAt || reportedAt || (fallback ? fmt(fallback) : '')

  // ---- 可检出的日期事件：只暴露，绝不自动改写日期（Bug 031 红线）----
  const events = []
  const toDay = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`) : null)
  const today0 = new Date()
  today0.setHours(0, 0, 0, 0)
  const dc = toDay(collectedAt)
  const dr = toDay(reportedAt)
  if (dc && dr) {
    const gap = Math.round((dr - dc) / 86400000)
    if (gap < 0) {
      events.push({ code: 'report_before_collect', gap, message: `报告日期早于采样日期 ${Math.abs(gap)} 天，请核对` })
    } else if (gap > 30) {
      // 同报告内 采样→报告 跨度 >30 天基本不成立（病理/基因最长约 4 周）；
      // 实测 794 报告「接收 08-05 / 报告 09-11」= 37 天，实为 OCR 把 08 读成 09。
      events.push({ code: 'gap_too_large', gap, message: `报告日期与采样日期相差 ${gap} 天，疑似识别有误，请核对` })
    }
  }
  // 未来日期一律无效：兜底引擎会从参考区间数字里拼出假日期（实测「WBC 3.4 3.5-9.5」→ 2043-05-09），
  // 这种臆造日期绝不能落库 → 直接作废留空 + 提示，由用户手选。
  const pDay = toDay(primary)
  let validPrimary = primary
  if (pDay && pDay > today0) {
    events.push({ code: 'future_date', message: `识别到的日期 ${primary.slice(0, 10)} 晚于今天，请手动选择` })
    validPrimary = ''
  }
  if (!validPrimary) events.push(NO_DATE_EVT)
  const sep = validPrimary.indexOf(' ')

  return {
    date: sep > 0 ? validPrimary.slice(0, sep) : validPrimary || null,
    time: sep > 0 ? validPrimary.slice(sep + 1) : '',
    collectedAt,
    reportedAt,
    dateSource: collectedAt ? 'collect' : reportedAt ? 'report' : fallback ? 'first_date' : 'none',
    dateEvents: events,
    // 统一识别诊断契约：把日期事件收敛成标准 issues[]（{code,level,message}），
    // 供 ImportFlow 与 grid 诊断合并后统一渲染（替换原 dateEvents 黄条）。绝不自动改写日期（Bug 031 红线）。
    issues: events.map((e) => ({
      code: e.code,
      level: e.code === 'no_date' ? 'error' : 'warn',
      message: e.message,
    })),
  }
}

/* ---------------- 对外接口 ---------------- */

// dataUrl：PDF 或图片的 dataURL（ImageUploader 已渲染）
export async function runOCR(dataUrl) {
  // 关键：worker 一次性冷启动（wasm 编译 + 加载 chi_sim/eng traineddata）较大，
  // 先 await 就绪且【不计入】90s 识别超时。否则「编译十几秒 + 4 策略 20s」会叠加超 90s，
  // 导致首次必超时（即「第一次失败、第二次才成功」）。预热（warmupOcr）已提前触发，
  // 此处多数情况直接复用已编译 worker，几乎零等待；若仍冷启动则在此等待但不计超时。
  console.log('[OCR][DBG] runOCR: 等待 worker 就绪（冷启动不计入 90s）')
  try {
    await Promise.all([getTesseract(), getTesseractZh()])
  } catch (_) {
    // worker 初始化失败将在真正 recognize 时暴露，这里不阻断
  }
  console.log('[OCR][DBG] runOCR: worker 就绪，开始识别计算（90s 计时开始）')
  const t = Date.now()
  try {
    const r = await withTimeout(ocrInternal(dataUrl), OCR_TIMEOUT_MS, OCR_TIMEOUT_MSG)
    console.log('[OCR][DBG] runOCR: 识别计算完成，耗时=', ((Date.now() - t) / 1000).toFixed(1), 's')
    return r
  } catch (e) {
    console.log('[OCR][DBG] runOCR: 失败/超时，耗时=', ((Date.now() - t) / 1000).toFixed(1), 's，错误=', e && e.message)
    throw e
  }
}

// 「识别-审计-重识别」闭环入口：在 runOCR 基础上，若审计质量不达标（多维不服），
// 自动触发本地多策略重识别（换 PSM + 预处理变体），选最优返回。对用户透明。
//   maxAttempts：最多重识别轮数（每轮内部已多策略选优，故实际 OCR 次数 = 1 + maxAttempts×策略数）
//   minScore：达标阈值，达到即止（默认 0.9）
// 注意：闭环只改善「识别质量」，绝不自动改写数值 / 参考范围（保持原红线）。
export async function runOCRWithRetry(dataUrl, { maxAttempts = 1, minScore = 0.3 } = {}) {
  // 第一轮：常规流程（本地多策略）。本地 Tesseract 本身有噪声，审计分通常 0.2~0.4，
  // 故「识别成功」的判据是「网格有效」（行数足够、关键字段可命中），而非审计分达标；
  // 审计分仅用于「多轮选优」与 UI 置信度提示，不阻塞成功（避免无意义的反复重识别）。
  console.log('[OCR][DBG] runOCRWithRetry: 第一轮常规识别开始')
  const first = await runOCR(dataUrl)
  console.log('[OCR][DBG] runOCRWithRetry: 第一轮完成，grid 行数=', (first.grid && first.grid.length) || 0)
  const firstPoints = normalizeGridToPoints(first.grid)
  const firstSummary = summarizeAudit(firstPoints)
  // 闭环判定：以「网格有效」为成功判据，而非 qualityScore 软阈值。
  // 背景：nameMiss 权重×3，9/25 命中下 qualityScore 恒为 0，永远 < minScore(0.3)，
  // 旧逻辑会触发 maxAttempts 第二轮 4 策略重识别，纯属浪费（OCR 噪声导致的 nameMiss 重识别救不回），
  // 且多出来的 4 次 recognize 会显著拉长首次耗时、更易撞 90s 超时。
  // 故：第一轮网格有效（行数>1）即返回；审计分仅用于 UI 置信度提示与多轮选优。
  if (first.grid && first.grid.length > 1) {
    return { ...first, auditSummary: firstSummary, retried: false }
  }
  // 网格无效（极少）：本地多策略重识别（最多 maxAttempts 轮）；首轮已多策略选优，此处仅兜底。
  let best = first
  let bestSummary = firstSummary
  const allAttempts = [...(first.ocrAttempts || [])]
  for (let i = 0; i < maxAttempts; i++) {
    const local = await runLocalBest(dataUrl)
    if (!local || !local.grid || local.grid.length <= 1) break
    allAttempts.push(...(local.ocrAttempts || []))
    const pts = normalizeGridToPoints(local.grid)
    const sum = summarizeAudit(pts)
    if (sum.qualityScore > bestSummary.qualityScore) {
      best = { ...local, provider: 'tesseract-local-retry' }
      bestSummary = sum
    }
  }
  return { ...best, ocrAttempts: allAttempts, auditSummary: bestSummary, retried: best !== first }
}

async function ocrInternal(dataUrl) {
  // 优先 PDF：直接提取文本层（快且准，无需 OCR）
  if (/^data:application\/pdf/.test(dataUrl) || /^data:application\/octet-stream/.test(dataUrl)) {
    try {
      // 全部页都进识别 → 合并为一份报告（多页化验单此前只认第 1 页，第 2 页起指标静默丢失）
      const { grid, items, pageCount } = await buildGridFromPdf(dataUrl)
      if (!grid || grid.length <= 1) {
        throw new Error('PDF 未含可解析的表格文本层，请尝试导出为图片后上传')
      }
      if (pageCount > 1) console.log(`[OCR] 多页 PDF：共 ${pageCount} 页，已合并为一份报告识别`)
      // 文本层 PDF 的正文（流式报告）直接从文字层切段，比图片 OCR 干净
      const narrative = extractFlowReport(items.map((it) => it.text || '').join('\n'))
      return { grid, provider: 'pdf', mock: false, message: '', pageCount, narrative, ...extractReportDate(items) }
    } catch (e) {
      // 文本层失败（如扫描件 PDF，纯图片无文字）→ 优先提取内嵌原图并自动旋转后降级图片 OCR。
      // 直接渲染页面视图会受页面裁剪/缩放影响，且扫描件方向常错误，导致时间/MCV 等字段识别错。
      console.warn('PDF 文本提取失败，逐页提取内嵌原图后降级图片 OCR：', e.message)
      try {
        const jpegs = await extractPdfAllPageImages(dataUrl, 3000)
        if (jpegs.length === 0) throw new Error('PDF 未找到内嵌图片')
        return await ocrPdfPages(jpegs)
      } catch (inner) {
        // 内嵌图提取失败（如无内嵌图）→ 兜底逐页渲染页面视图
        console.warn('内嵌图提取失败，逐页兜底页面渲染：', inner.message)
        const jpegs = await renderPdfAllPages(dataUrl, 2400)
        if (jpegs.length === 0) throw inner
        return await ocrPdfPages(jpegs)
      }
    }
  }
  // 图片：Tesseract 本地 OCR
  return runOcrImage(dataUrl)
}

// 多页 PDF 的图片通道：逐页 OCR（每页独立识别，绝不做多页拼长图 —— 拼图会改变像素分布、
// 行高失真，直接伤识别质量），再合并成一份网格。单页时等价原逻辑。
async function ocrPdfPages(jpegs) {
  const grids = []
  const narrs = []
  for (let i = 0; i < jpegs.length; i++) {
    try {
      const r = await runOcrImage(jpegs[i])
      if (r && r.grid && r.grid.length > 1) grids.push(r.grid)
      if (r && r.narrative) narrs.push(r.narrative)
    } catch (e) {
      console.warn(`多页 PDF 第 ${i + 1} 页 OCR 失败，跳过：`, e && e.message)
    }
  }
  if (grids.length === 0) throw new Error('未识别到表格行，请确认 PDF 清晰或换一份')
  if (jpegs.length > 1) console.log(`[OCR] 多页 PDF：${jpegs.length} 页逐页 OCR 完成，已合并为一份报告`)
  // 正文合并：各段取首个非空（同一份报告的各段不该因多页而重复）
  const narrative = narrs.length
    ? ['antigens', 'impression', 'conclusion', 'footnote'].reduce((acc, k) => {
        acc[k] = narrs.map((n) => n[k]).find(Boolean) || ''
        return acc
      }, {})
    : null
  return {
    grid: mergePageGrids(grids),
    provider: 'tesseract-local',
    mock: false,
    message: '',
    pageCount: jpegs.length,
    narrative,
  }
}

// 图片预处理：灰度 + 对比度增强 + 低分图放大，改善低对比度打印 / 浅色箭头（↓↑）的识别。
// 实验发现：Tesseract 在宽度 1600px 时易把「48 ↓」粘连成「484」；放大到 2400px+ 可恢复正确。
// 扫描件报告（862px 内嵌图 / 2400px 渲染图）对比实验：3000px + psm6 + 纯中文效果最佳。
const MIN_OCR_WIDTH = 3000

// 灰度化（返回 Uint8 灰度数组，0~255）。复用 ImageData 的 R/G/B 亮度公式。
function toGray(imgData) {
  const d = imgData.data
  const out = new Uint8ClampedArray(d.length / 4)
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    out[j] = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114)
  }
  return out
}

// Sauvola 局部自适应二值化：解决固定阈值（140）在光照不均/截图上的失效。
// 窗口内按局部均值与标准差动态阈值，文字笔画（暗）被分离，背景（亮/渐变）不被误判为字。
// 用积分图把窗口统计降到 O(1)/像素，half 为窗口半径。返回 0/255 二值化后的 ImageData。
function sauvolaBinarize(imgData, w, h, half = 8, k = 0.2, R = 128) {
  const gray = toGray(imgData)
  // 积分图（sum 与 sum²）
  const sum = new Float64Array((w + 1) * (h + 1))
  const sumsq = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let rs = 0
    let rsq = 0
    const row = y * w
    for (let x = 0; x < w; x++) {
      const v = gray[row + x]
      rs += v
      rsq += v * v
      const idx = (y + 1) * (w + 1) + (x + 1)
      sum[idx] = sum[y * (w + 1) + (x + 1)] + rs
      sumsq[idx] = sumsq[y * (w + 1) + (x + 1)] + rsq
    }
  }
  const area = (x0, y0, x1, y1) => {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1)
    const A = (x1 - x0 + 1) * (y1 - y0 + 1)
    const s = sum[(y1 + 1) * (w + 1) + (x1 + 1)] - sum[(y0) * (w + 1) + (x1 + 1)] - sum[(y1 + 1) * (w + 1) + (x0)] + sum[(y0) * (w + 1) + (x0)]
    const sq = sumsq[(y1 + 1) * (w + 1) + (x1 + 1)] - sumsq[(y0) * (w + 1) + (x1 + 1)] - sumsq[(y1 + 1) * (w + 1) + (x0)] + sumsq[(y0) * (w + 1) + (x0)]
    const mean = s / A
    const variance = Math.max(0, sq / A - mean * mean)
    return { mean, std: Math.sqrt(variance) }
  }
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const { mean, std } = area(x - half, y - half, x + half, y + half)
      const T = mean * (1 + k * (std / R - 1))
      const v = gray[y * w + x] < T ? 0 : 255
      const i = (y * w + x) * 4
      out[i] = out[i + 1] = out[i + 2] = v
      out[i + 3] = 255
    }
  }
  return new ImageData(out, w, h)
}

// 投影法倾斜检测：在缩小灰度图上扫描角度，行像素投影方差最大者即文本水平方向。
// 返回最佳倾斜角（度，范围 ±maxDeg，步长 stepDeg）。
function detectSkew(gray, w, h, maxDeg = 8, stepDeg = 1) {
  const rad = (d) => (d * Math.PI) / 180
  let bestAngle = 0
  let bestVar = -1
  for (let deg = -maxDeg; deg <= maxDeg; deg += stepDeg) {
    const a = rad(deg)
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    // 旋转后包围盒
    const W = Math.abs(w * ca) + Math.abs(h * sa)
    const H = Math.abs(w * sa) + Math.abs(h * ca)
    const rowSum = new Float64Array(Math.ceil(H))
    const cx = w / 2
    const cy = h / 2
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = (x - cx) * ca + (y - cy) * sa + W / 2
        const ny = -(x - cx) * sa + (y - cy) * ca + H / 2
        const ix = nx | 0
        const iy = ny | 0
        if (ix >= 0 && ix < W && iy >= 0 && iy < H) rowSum[iy] += 255 - gray[y * w + x]
      }
    }
    // 行投影方差（文字行对齐时方差最大）
    let mean = 0
    for (let i = 0; i < rowSum.length; i++) mean += rowSum[i]
    mean /= rowSum.length || 1
    let varSum = 0
    for (let i = 0; i < rowSum.length; i++) {
      const d = rowSum[i] - mean
      varSum += d * d
    }
    const v = varSum / (rowSum.length || 1)
    if (v > bestVar) {
      bestVar = v
      bestAngle = deg
    }
  }
  return bestAngle
}

// 将灰度图按角度旋转（最近邻），返回旋转后的 { gray, w, h }。
function rotateGray(gray, w, h, deg) {
  const a = (deg * Math.PI) / 180
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const W = Math.abs(w * ca) + Math.abs(h * sa)
  const H = Math.abs(w * sa) + Math.abs(h * ca)
  const nw = Math.round(W)
  const nh = Math.round(H)
  const out = new Uint8ClampedArray(nw * nh)
  const cx = w / 2
  const cy = h / 2
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const nx = (x - W / 2) * ca - (y - H / 2) * sa + cx
      const ny = (x - W / 2) * sa + (y - H / 2) * ca + cy
      const ix = nx | 0
      const iy = ny | 0
      if (ix >= 0 && ix < w && iy >= 0 && iy < h) out[y * nw + x] = gray[iy * w + ix]
      else out[y * nw + x] = 255
    }
  }
  return { gray: out, w: nw, h: nh }
}

async function preprocessImage(dataUrl, variant = 'default') {
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image load failed'))
      el.src = dataUrl
    })
    let w = img.naturalWidth
    let h = img.naturalHeight
    let scale = 1
    // 低分辨率图（截图 / 压缩上传 / 页面渲染兜底）智能放大，减少箭头与数字粘连
    if (w < MIN_OCR_WIDTH) {
      scale = MIN_OCR_WIDTH / w
      w = Math.round(w * scale)
      h = Math.round(h * scale)
    }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    // variant：识别重试时切换的预处理风格，针对不同类型识别错误
    //   default  原图 + 灰度高对比（常规报告）
    //   contrast 强化对比（低对比度 / 浅色打印）
    //   binary   固定阈值二值化（数字粘连 / 43.6↔40、40.0↔0 这类边界不清）
    //   sharpen  锐化（模糊小字 / 拍照抖动）
    //   sauvola  Sauvola 局部自适应二值化（光照不均 / 截图渐变背景，固定阈值失效时）
    //   deskew   倾斜校正（微角度旋转对齐文本行）+ Sauvola 二值化（拍照抖动斜拍）
    if (variant === 'sauvola' || variant === 'deskew') {
      // 自适应二值化/倾斜校正：原 cap 到 1600 宽（不放大）以控积分图内存，
      // 但实测 1600 会丢失「数字尾笔粘连」（如 RBC 1.85 的 8 被固定阈值吞成 9→1.95）。
      // 改为与放大分辨率一致（MIN_OCR_WIDTH=3000），让 sauvola 在放大图上跑才能救此类粘连；
      // 高分辨率原图（>3000）仍 cap 到 3000 防积分图爆内存（3000×~4000 积分图 ≈ 192MB，可控）。
      const cap = MIN_OCR_WIDTH
      let dw = w
      let dh = h
      if (dw > cap) {
        const s = cap / dw
        dw = cap
        dh = Math.round(dh * s)
      }
      ctx.filter = 'grayscale(1)'
      ctx.drawImage(img, 0, 0, dw, dh)
      let imgData = ctx.getImageData(0, 0, dw, dh)
      let gray = toGray(imgData)
      if (variant === 'deskew') {
        // 先用缩小图（宽 600）做倾斜检测，再按最优角度旋转原处理分辨率图
        const sw = 600
        const sscale = sw / dw
        const sh = Math.max(1, Math.round(dh * sscale))
        const smallGray = new Uint8ClampedArray(sw * sh)
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const sx = Math.min(dw - 1, (x / sscale) | 0)
            const sy = Math.min(dh - 1, (y / sscale) | 0)
            smallGray[y * sw + x] = gray[sy * dw + sx]
          }
        }
        const angle = detectSkew(smallGray, sw, sh)
        if (Math.abs(angle) >= 0.5) {
          const rotated = rotateGray(gray, dw, dh, angle)
          gray = rotated.gray
          dw = rotated.w
          dh = rotated.h
          imgData = new ImageData(gray, dw, dh)
        }
      }
      const bin = sauvolaBinarize(imgData, dw, dh)
      canvas.width = dw
      canvas.height = dh
      ctx.putImageData(bin, 0, 0)
      return canvas.toDataURL('image/png')
    }
    let filter = 'grayscale(1) contrast(1.4) brightness(1.05)'
    // default16：在 default(1.4) 基础上提高对比到 1.6，专救「清晰小字中文名」类报告
    // （如单测 EPO 报告「促红细胞生成素」，1.4 下笔画不够黑被误读成 WBC/EO_ABS，
    // 1.6 才能读对名字）。CU7TT0 带水印报告 1.6 会压坏数值，故另保留 default(1.4)
    // 供其命中——runLocalBest 多策略选优+融合会自然取舍（详见 OCR_LOCAL_STRATEGIES）。
    if (variant === 'default16') filter = 'grayscale(1) contrast(1.6) brightness(1.05)'
    else if (variant === 'contrast') filter = 'grayscale(1) contrast(2.2) brightness(1.1)'
    else if (variant === 'binary') {
      // 先高对比再手动阈值化（>140 白，否则黑），强化数字笔画分离
      ctx.filter = 'grayscale(1) contrast(3) brightness(1.2)'
      ctx.drawImage(img, 0, 0, w, h)
      const imgData = ctx.getImageData(0, 0, w, h)
      const d = imgData.data
      for (let i = 0; i < d.length; i += 4) {
        const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
        const v = lum > 140 ? 255 : 0
        d[i] = d[i + 1] = d[i + 2] = v
      }
      ctx.putImageData(imgData, 0, 0)
      return canvas.toDataURL('image/png')
    } else if (variant === 'sharpen') filter = 'grayscale(1) contrast(1.6) brightness(1.05)'
    ctx.filter = filter
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  } catch (e) {
    console.warn('图片预处理失败，使用原图：', e.message)
    return dataUrl
  }
}

// 图片识别：本地 Tesseract 多策略闭环
// 切换 PSM + 预处理变体识别多次，按审计质量评分选最优（详见 runLocalBest）。
// ---- 纯 chi_sim 文本行→grid 通道（水印/低清表兜底候选，mode:'text'） ----
// 几何通道依赖 items 的 word 碎片，灰水印+低清图上小数会被拆成 '3.'+'34' 无法归位、
// 单位列残段 10⁹ 拼成假值——word 几何不可靠。但 psm6 行文本总是直读数值（行内数字几乎读全），
// 用正则把每行按 [ref 区间] 切段解析出 [name, value, ref]（先做小数空格净化 "0. 49"→"0.49"），
// 绕开 word 碎片问题。作为 chi_sim+eng 多策略之外的第 6 个候选（纯 chi_sim 语言，见
// recognizeLocalOnce mode:'text'）；实测在 chi_sim+eng 几何崩坏的图上可全救（case-feedback-CU7TT0）。
export function buildGridFromText(text) {
  // 同上：图文型检验报告（流式）短路——正文按 [name|值|参考] 切段会把印象句切成假指标。
  const flowGrid = buildFlowGridFromText(text)
  if (flowGrid) return flowGrid
  const HEADER_WORDS = /姓名|性别|牛龄|年龄|页|时间|标本|床号|科室|诊断|病案|流水|编号|号|申请|执行|日期|收取|报告|时\d|液号/
  const cleanNumSpaces = (s) => s.replace(/(\d)\.\s+(\d)/g, '$1.$2').replace(/(\d)\s+\.(\d)/g, '$1.$2')
  const isUnit10n = (t) => /^1?10(\.0+)?$/.test(String(t).trim())
  const isExp9 = (t) => /^9\d*(\.\d+)?$/.test(String(t).trim())
  const segToValue = (seg) => {
    // 值=从右往左第一个数字，跳过"指数单位残段"数字对（10⁹ 被拆成 '10 9.1'/'10 9'）
    const nums = [...seg.matchAll(/(\d+(?:\.\d+)?)/g)]
    if (!nums.length) return null
    for (let j = nums.length - 1; j >= 0; j--) {
      if (j > 0 && isUnit10n(nums[j - 1][0]) && isExp9(nums[j][0]) && nums[j].index - (nums[j - 1].index + nums[j - 1][0].length) <= 4) {
        j--
        continue
      }
      return nums[j][0]
    }
    return nums[nums.length - 1][0]
  }
  const out = []
  const parseSeg = (seg) => {
    seg = seg.replace(/[|丨]/g, ' ').trim()
    if (!seg) return
    const refs = [...seg.matchAll(/(\d+(?:\.\d+)?)\s*[-–—~]\s*(\d+(?:\.\d+)?)/g)]
    if (refs.length) {
      let segStart = 0
      for (const rm of refs) {
        const left = seg.slice(segStart, rm.index)
        const ref = `${rm[1]}-${rm[2]}`
        const value = segToValue(left)
        segStart = rm.index + rm[0].length
        if (value == null) continue
        if (HEADER_WORDS.test(left) && left.length > 12 && !/[\u4e00-\u9fff]/.test(left.slice(0, 3))) continue
        const name = left.slice(0, Math.max(0, left.lastIndexOf(value)))
        if (name.length < 2) continue
        out.push([name.trim(), value, ref, '', ''])
      }
    } else {
      // 无 '-' ref（OCR 把 ref 连字符吞了，如超敏 CRP 的 0-5 读成 "0 10"）：值唯一反推兜底
      const nums = [...seg.matchAll(/(\d+(?:\.\d+)?)/g)]
      if (!nums.length) return
      let i = nums.length - 1
      while (i >= 1) {
        const a = nums[i - 1]
        const b = nums[i]
        const pa = parseFloat(a[0])
        const pb = parseFloat(b[0])
        // 末尾"ref 残对"整体剔除：(a,b) 相邻且 b 远大于 a（0 10 / 1 350 下限-上限断连），循环剥到 value
        if (b.index - (a.index + a[0].length) <= 3 && pa < pb && pb > pa * 2) i -= 2
        else break
      }
      if (i < 0) return
      const value = nums[i][0]
      const name = seg.slice(0, Math.max(0, seg.lastIndexOf(value)))
      if (name.length < 2 || !/[\u4e00-\u9fff]/.test(name)) return
      out.push([name.trim(), value, '', '', ''])
    }
  }
  for (let line of String(text || '').split('\n')) {
    line = cleanNumSpaces(line.trim())
    if (!line) continue
    for (const part of line.split('|')) parseSeg(part)
  }
  if (!out.length) return null
  // 表头行让 normalize 建 [name,result,ref,unit] 列映射（布局与几何 supplement 行 [name,value,ref,unit,0] 一致）
  return [['检验项目', '结果', '参考范围', '单位', ''], ...out]
}

// ===== 图文型检验报告（流式免疫分型 / FCM-MRD）：正文单值抽取 =====
// 为什么需要（2026-10-28 用户报障）：检验报告也有「含图、无表格」的形态——流式免疫分型报告
// 主体是 19 张散点图 + 「印象 / 结论」正文，一个指标表格都没有。既有两条本地通道都会崩：
//   · 几何通道（buildGridFromItems）：散点图轴标（10³/10⁴）、CD 分子名、门内百分比被当成
//     「项目名 | 结果」，实测 1007 报告 GRID 28 行、POINTS 出 FOLATE=2 / GGT=4 / Cr=108 /
//     NEUT_PCT=56.3 / EPO=57.4 等 10 项无中生有的指标（真值只有 MRD 0.2%）；
//   · 文本通道（buildGridFromText）：正文读得不错，但按 [name|值|参考] 切段会把印象句
//     切成假指标行。
// 检查报告通道（parseDoc）的做法是「读正文、不读表格」；本函数把同一条逻辑前移到化验
// 本地通道：认出流式报告 → 丢掉网格噪声 → 只从正文抽一行「流式MRD残留」，
// 与 AI 通道 C 类口径（buildDocReadLabPrompt）同源同形，切换引擎不改变结果形状。
const FLOW_ANCHOR_RE = /(?:所)?检测?抗原|设门|CD\s*45\s*[\/\\\-、]\s*SSC/i

// 报告是否属于流式免疫分型（FCM-MRD）：硬条件 = 正文并列 ≥5 个 CD 分子（流式报告必列的
// 「所检测抗原」清单 / 散点图轴标；普通化验单、骨髓形态学、融合基因报告都不会），
// 软锚点 = 抗原清单 / 设门 / CD45-SSC 说法（三选一，任一被读花仍能命中）。
// 双条件可保证不误伤其它报告——它们的正文最多引一句「请结合流式细胞术」，没有 CD 清单。
export function detectFlowReportText(text) {
  const t = String(text || '')
  if (!t.trim()) return false
  const cdCount = (t.match(/CD\s*\d+/gi) || []).length
  if (cdCount < 5) return false
  return FLOW_ANCHOR_RE.test(t)
}

// 从正文抽 MRD 残留比例。只认「明确指向幼稚/原始/异常细胞群体」的百分比，
// 绝不把「粒细胞占有核细胞的 81%」「T 细胞占淋巴细胞的 64.8%」当残留量——
// 报告里同段并列着十几个百分比，锚错一个就是危险错值（不得自动改写，只能读对）。
const FLOW_PCT = '([<>≤≥]?\\s*\\d+(?:\\.\\d+)?)'
const FLOW_VALUE_PATTERNS = [
  // ① 印象主句：「CD34+CD19+…幼稚B淋巴细胞约占有核细胞的 0.2%」（占[有核细胞]…间允许少量文字）
  new RegExp(`(?:幼稚|原始)[^。；;%]{0,20}?占[^0-9%]{0,10}${FLOW_PCT}\\s*%`),
  // ② 「异常细胞群体，约占有核细胞的 1.2%」（必须带「细胞（群体）」，避免「未见明显异常」误命中）
  new RegExp(`(?:异常|残留)(?:白血病)?\\s*细胞(?:群体|群|克隆)?[^。；;%]{0,20}?占[^0-9%]{0,10}${FLOW_PCT}\\s*%`),
  // ③ 结论简写：「见 0.2% 幼稚 B 淋巴细胞」「检出 1.2% 原始细胞」
  new RegExp(`(?:见|检出|发现|提示|可见)\\s*${FLOW_PCT}\\s*%\\s*(?:的)?\\s*(?:幼稚|原始|异常|残留)`),
  // ④ 直接给 MRD 值：「MRD <0.01%」「微小残留病 1.2%」
  new RegExp(`(?:MRD|微小残留(?:病|病灶)?|残留白血病细胞)\\s*(?:值|结果|比例)?\\s*[:：=]?\\s*${FLOW_PCT}\\s*%`, 'i'),
]
// 定性阴性：仅在报告明确写「未见异常细胞群体 / 未检出 / MRD 阴性」时采用，绝不用它冒充数值。
const FLOW_NEGATIVE_RE =
  /未见(?:明显)?异常(?:细胞|幼稚|原始)|未检出|MRD\s*(?:阴性|未检出)|未见(?:幼稚|原始)|未见残留/i

// 句子级取值（主力规则）：报告里同段并列十几个百分比，只看「这一句」是否在描述残留细胞，
// 命中条件三选一：
//   ① 句中有幼稚/原始（或「异常细胞（群体）」/「残留细胞」）**且**有占比语义（占/点/有核细胞）
//   ② 「见/检出/发现/提示 + X% + 幼稚/原始/异常」这种结论简写
//   ③ 句中直接写了 MRD / 微小残留
// 为什么不能只靠整页正则：真实 OCR 把「约占」读成「约点」、「幼稚B」读成「幼稚了/幼稚孔」，
// 且几何 items 拼接后会掺入分词空格——按句评估比按整页模式匹配稳得多
// （2026-10-28 浏览器实测：整页正则抽到的值是空的，正文却明明写着 0.2%）。
const FLOW_PCT_ONE = /([<>≤≥]?\s*\d+(?:\.\d+)?)\s*%/
function pickFlowPctFromSentence(sentence) {
  const s = String(sentence || '')
  const m = s.match(FLOW_PCT_ONE)
  if (!m) return ''
  const blast = /(幼稚|原始)/.test(s)
  const cluster = /异常细胞(?:群体|群|克隆)?/.test(s) || /残留(?:白血病)?细胞/.test(s)
  const ratioCtx = /(占|点|有核细胞)/.test(s)
  const reportPhrase = /(见|检出|发现|提示|可见)\s*[<>≤≥]?\s*\d/.test(s)
  const mrdWord = /(MRD|微小残留)/i.test(s)
  if (((blast || cluster) && ratioCtx) || (reportPhrase && (blast || cluster)) || mrdWord) return m[1].replace(/\s+/g, '')
  return ''
}

export function extractFlowMrdRow(text) {
  // 换行/多空格折成一格，让跨行的印象句可被同一正则命中
  const t = String(text || '').replace(/\s+/g, ' ')
  if (!t.trim()) return null
  // 参考列 = 报告给出的灵敏度 / 最低检出限；没写就留空（normalize 会用 FCM_MRD 档案的 <0.01 补）
  const refM = t.match(/(?:灵敏度|最低检出限|检测下限|检测灵敏度)[^0-9<≤]{0,8}([<>≤≥]?\s*\d+(?:\.\d+)?)\s*%/)
  const ref = refM ? refM[1].replace(/\s+/g, '') : ''
  const name = /标本类型\s*[:：]?\s*外周血|标本\s*[:：]\s*外周血/.test(t) ? '流式MRD残留-外周血' : '流式MRD残留'
  // 先句子级（正文段优先：正文已去噪，百分比候选最少），再退回整页正则兜底
  const nar = extractFlowNarrative(String(text || ''))
  const sectionText = nar ? [nar.impression, nar.conclusion].filter(Boolean).join('；') : ''
  for (const source of [sectionText, t]) {
    if (!source) continue
    for (const sentence of String(source).split(/[。;；\n]+/)) {
      const value = pickFlowPctFromSentence(sentence)
      if (value) return { name, value, ref, unit: '%', evidence: sentence.trim().slice(0, 60) }
    }
  }
  for (const re of FLOW_VALUE_PATTERNS) {
    const m = t.match(re)
    if (!m) continue
    const value = String(m[1] || '').replace(/\s+/g, '')
    if (!/\d/.test(value)) continue
    return { name, value, ref, unit: '%', evidence: m[0] }
  }
  if (FLOW_NEGATIVE_RE.test(t)) return { name, value: '未检出', ref, unit: '%', evidence: '定性阴性' }
  // 认得是流式报告但正文没读出残留比例：给一行空值，让用户手填，
  // 绝不编数字、也绝不回落到散点图噪声（那会产出 FOLATE/GGT/NEUT_PCT 这类假指标）。
  return { name, value: '', ref, unit: '%', evidence: '正文未取到残留比例' }
}

// 流式报告 → 单行网格（与几何/文本通道同形状，供 normalize 走既有的 FCM_MRD 映射链路）。
export function buildFlowGridFromText(text) {
  if (!detectFlowReportText(text)) return null
  const row = extractFlowMrdRow(text)
  return [
    ['检验项目', '结果', '参考范围', '单位', '提示'],
    [row.name, row.value, row.ref, row.unit, ''],
  ]
}

// 候选优选用的流式排名：2 = 流式单行且取到值，1 = 流式单行但值待填，0 = 非流式候选。
// 为什么需要：流式报告只有一个指标，散点图噪声候选按「mapped 数」评分反而更高
// （实测该图 binary 变体 mapped=5 的假指标 vs 正确候选 mapped=1），常规选优会把噪声选成最优。
export function flowCandidateRank(grid) {
  if (!Array.isArray(grid) || grid.length !== 2) return 0
  if (!/^流式MRD残留/.test(String(grid[1] && grid[1][0] ? grid[1][0] : ''))) return 0
  return String((grid[1] && grid[1][1]) || '').trim() ? 2 : 1
}

// 在多策略候选里挑「流式候选」：取排名最高者（取到值 > 值待填），同排名取靠前策略
// （策略组已按质量优先级排序，靠前即 default 系）。无流式候选返回 null → 走常规选优。
function pickFlowCandidate(scored) {
  let pick = null
  let rank = 0
  for (const s of scored) {
    if (!s || s.error || !s.grid) continue
    const r = flowCandidateRank(s.grid)
    if (r > rank) { rank = r; pick = s }
  }
  return pick
}

// ===== 流式报告正文（印象 / 结论）转录 =====
// 为什么需要（2026-10-28 用户拍板）：这类报告的可入库指标只有一行 MRD，但**正文**（印象里的表型、
// 各系细胞占比、结论里的判断）是用户真正要看的——历史上它是被人手工抄进 record.notes 的
// （库里 r_1792589699080_bew1c 的 notes 就是整段正文）。现按「本地照抄 + 标注机器误识未校」
// 自动转录，落到化验记录的备注字段（不新增字段，见 .agents/bugs.md Bug 204 的既有口径）。
//
// 与检查报告通道（parseDoc）的区别：parseDoc 认「检查所见/镜下所见」等小标题，流式报告的
// 段名是「印象 (Impression)」/「结论 (Conclusion)」，且页面上半页全是散点图轴标——实测直接喂
// parseDocText 会把整页（含患者信息、CD 分子清单、[A]/events 轴标）塞进 findings。故这里专门切段。
const FLOW_IMPRESSION_RE = /^\s*印象|Impression/i
const FLOW_CONCLUSION_RE = /^\s*结论|Conclusion/i
// 段末哨兵：页脚/落款/元信息，遇到即结束当前段
const FLOW_SECTION_END_RE =
  /^\s*(注|备注|说明)\s*[:：]|^\s*(地址|采样时间|接收时间|报告时间|检验者|审核者|申请医生|打印时间)\s*[:：]|^\s*北京市|^\s*$/
// 散点图/轴标噪声行：整行几乎没有中文、却堆着分选门/刻度/事件数（[A]、{A}、10^4、events、%）
function isFlowNoiseLine(line) {
  const s = String(line || '').trim()
  if (!s) return true
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length
  if (cjk >= 3) return false
  return /\[A\]|\{A\}|^\W*\d+[.,]?\d*\s*%?$|events|Events|FSC|SSC|10\^|10[³⁴⁵]/.test(s) || cjk === 0
}

// 患者身份 / 重复信息行：一律不进报告原文（2026-10-28 用户拍板「不收这些信息，都是重复的，也敏感」）。
// 判据：姓名/性别/年龄/条码/住院号/床号/病历号/病案号/门诊号/标本类型/科室 —— 这些要么已在结构化字段里
// （date/time/specimen/report_type），要么属可识别身份（项目既有脱敏口径：typingCard.js「不输出住院号/证件号」）。
const FLOW_IDENTITY_RE = /姓名|性别|年龄|条码|住院号|床号|病历号|病案号|门诊号|病人\s*ID|患者\s*ID|标本类型|科\s*室|病区|床\s*\d/

// 所检测抗原清单（流式特有版式）
const FLOW_ANTIGEN_RE = /^\s*所?检测?抗原/
// 「注：此结果仅针对本次检验样本…」这类报告免责/提示行（属报告本体文字，不含身份）
const FLOW_FOOTNOTE_RE = /^\s*注\s*[:：]/
// 抗原清单的续行特征：一行里并列 ≥3 个 CD 分子 / cKappa / cLambda / FMC7
const isAntigenContinuation = (line) => (String(line || '').match(/CD\s*\d+|cKappa|cLambda|FMC7/gi) || []).length >= 3

function joinDetailLines(buf) {
  // 报告正文是折行排版的：行与行直接拼接（中文折行无需空格），保留原有标点
  return buf
    .join('')
    .replace(/\s+([，。；：、）])/g, '$1')
    .replace(/([（])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 从流式报告 OCR 文本抽「报告原文」各段（本地通道用；AI 通道由 agent 直接给同构字段）。
 * 只收报告本体：所检测抗原清单 / 印象 / 结论 / 注（抬头标题按用户要求不收）。患者身份、科室床号、标本类型、
 * 散点图轴标、时间戳与人名签名**一律不收**（重复 + 敏感）。
 * 查不到任何段 → 返回 null（宁缺勿脏，绝不猜内容、也绝不写占位文本）。
 * @returns {{antigens?:string, impression?:string, conclusion?:string, footnote?:string}|null}
 */
export function extractFlowReport(text) {
  const lines = String(text || '').split('\n')
  if (!lines.some((l) => FLOW_IMPRESSION_RE.test(l) || FLOW_CONCLUSION_RE.test(l))) return null
  const clean = (l) => String(l || '').trim()
  const usable = (l) => {
    const s = clean(l)
    return !!s && !isFlowNoiseLine(s) && !FLOW_IDENTITY_RE.test(s)
  }
  // ① 抬头标题：**不收**（2026-10-28 用户要求「报告原文去掉标题」——它不承载任何信息，
  //    页面上原件图就在旁边，标题行只会占版面）。
  // ② 所检测抗原清单：段首行去掉标签前缀，续接「并列 ≥3 个 CD」的行
  let antigens = ''
  {
    const i = lines.findIndex((l) => FLOW_ANTIGEN_RE.test(l))
    if (i >= 0) {
      const parts = [clean(lines[i]).replace(/^[^:：]*[:：]\s*/, '')]
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (FLOW_IMPRESSION_RE.test(l) || FLOW_CONCLUSION_RE.test(l)) break
        if (FLOW_IDENTITY_RE.test(l)) break
        // 纯 CD 清单行没有中文，会被 isFlowNoiseLine 判成噪声 → 这里按「并列 ≥3 个 CD」直接续接
        if (!isAntigenContinuation(l)) break
        parts.push(clean(l))
      }
      // 折行拼接处（「…CD14,」+「CD15…」）补一个空格，避免粘成 CD14,CD15
      antigens = joinDetailLines(parts).replace(/,([A-Za-z0-9])/g, ', $1').replace(/[.,，、]\s*$/, '')
    }
  }
  // ③ 印象 / 结论 段
  const collect = (startRe) => {
    let i = lines.findIndex((l) => startRe.test(l))
    if (i < 0) return ''
    const buf = []
    const first = clean(lines[i]).replace(/^[^:：]*[:：]\s*/, '')
    if (first) buf.push(first)
    for (i += 1; i < lines.length; i++) {
      const line = lines[i]
      if (FLOW_SECTION_END_RE.test(line)) break
      if (FLOW_IMPRESSION_RE.test(line) || FLOW_CONCLUSION_RE.test(line)) break
      if (!usable(line)) continue
      buf.push(clean(line))
    }
    return joinDetailLines(buf)
  }
  const impression = collect(FLOW_IMPRESSION_RE)
  const conclusion = collect(FLOW_CONCLUSION_RE)
  // ④ 「注：…」报告提示行（只取第一条，通常是免责/送检说明）
  const footnote = lines.map(clean).find((l) => FLOW_FOOTNOTE_RE.test(l) && !FLOW_IDENTITY_RE.test(l)) || ''
  if (!antigens && !impression && !conclusion && !footnote) return null
  return { antigens, impression, conclusion, footnote }
}

// 兼容旧调用面：只要印象/结论两段时用这个薄包装（内容与 extractFlowReport 完全一致）。
export function extractFlowNarrative(text) {
  const r = extractFlowReport(text)
  if (!r || (!r.impression && !r.conclusion)) return null
  return { impression: r.impression, conclusion: r.conclusion }
}

async function runOcrImage(dataUrl) {
  try {
    const best = await runLocalBestSliced(dataUrl)
    if (best && best.grid && best.grid.length > 1) {
      return { ...best, provider: 'tesseract-local', mock: false, message: '' }
    }
    throw new Error('未识别到表格行，请确认图片清晰或换一张')
  } catch (e) {
    // 识别失败 / 超时中止：不再 resetWorker——worker 编译成果存活在 worker 线程内，
    // 保留供重试直接复用，避免「首次超时→清空→二次冷启动」恶性循环（即「第一次失败、第二次才成功」根因）。
    throw e
  }
}

// 单次本地识别（指定 PSM + 预处理变体）。返回 { grid, date, ... } 或抛错。
// psm：tesseract 页面分割模式（6=统一块表格，7=单行，11=稀疏文本，12=稀疏→单词）
// variant：preprocessImage 风格（default/contrast/binary/sharpen）
export async function recognizeLocalOnce(dataUrl, { psm = 6, variant = 'default', mode } = {}) {
  // mode:'text' = 纯 chi_sim 文本行通道：用 chi_sim 单语 worker（getTesseractZh）psm6 识别，
  // 结果走 buildGridFromText（data.text 行解析），不用 items 几何。default 预处理（contrast 1.4，
  // 文本直读的关键参数，1.6 会破坏水印图的数值）。语言对比见 case-feedback-CU7TT0：chi_sim+eng
  // 名称/数值全面乱码，chi_sim 名称形近可辨、数值直读正确。
  const processed = await preprocessImage(dataUrl, mode === 'text' ? 'default' : variant)
  const worker = mode === 'text' ? await getTesseractZh() : await getTesseract()
  const opts = mode === 'text' ? { tessedit_pageseg_mode: 6 } : psm ? { tessedit_pageseg_mode: psm } : {}
  const { data } = await worker.recognize(processed, opts, { text: true, blocks: true })
  // 流式图文报告的正文（印象/结论）随结果带上，供前端落 record.notes。
  // 非流式报告时 extractFlowNarrative 返回 null（无段名即不猜），不影响任何既有字段。
  const narrative = extractFlowReport(data.text)
  // 流式图文报告优先用 data.text（tesseract 的行文本，行结构与阅读顺序最准）走短路，
  // 避免几何 items 拼接顺序错乱导致「正文读到了、值却空」（见 itemsToLineText 注释）。
  const flowFromText = buildFlowGridFromText(data.text)
  if (flowFromText) {
    const flowItems = ocrBlocksToItems(data)
    // flowText：流式报告的行文本（只在这类报告上带出，用于「值抽不到」时的现场复现与诊断）
    return { grid: flowFromText, items: flowItems, narrative, flowText: data.text, ...extractReportDate(flowItems) }
  }
  if (mode === 'text') {
    const grid = buildGridFromText(data.text)
    if (!grid || grid.length <= 1) throw new Error('未识别到表格行')
    const items = ocrBlocksToItems(data)
    return { grid, items, narrative, ...extractReportDate(items) }
  }
  const items = ocrBlocksToItems(data)
  const grid = buildGridFromItems(items)
  if (!grid || grid.length <= 1) throw new Error('未识别到表格行')
  return { grid, items, narrative, ...extractReportDate(items) }
}

// 本地多策略识别：遍历策略组，每轮算审计质量分，返回最优 + 各轮评分（供 trace 日志）
// 策略选择依据：血常规双栏表常用 psm6；数字粘连（43.6↔40）用 binary 二值化；
// 行合并错位（NE#/RDW-SD 同 y）用 psm11 稀疏或 psm7 单行改善切分。
// sauvola（自适应二值化）已纳入默认策略组（置于末尾作补充候选）：实测其对「数字尾笔粘连」
// （RBC 1.85 的 8 被固定阈值吞成 9→1.95）与光照不均报告显著优于固定阈值；配合 MIN_OCR_WIDTH
// cap（见 preprocessImage sauvola 分支），在放大图上跑、内存可控。deskew（倾斜校正）仍保留
// 可选（更重），未纳入。
const OCR_LOCAL_STRATEGIES = [
  // default16 放最前：1.6 对比救清晰小字中文名（EPO 等单测报告）；CU7TT0 类水印报告
  // 1.6 压坏数值→低分，runLocalBest 会继续跑后续策略，default(1.4) 命中，不回归。
  { psm: 6, variant: 'default16' },
  { psm: 6, variant: 'default' },
  { psm: 6, variant: 'binary' },
  { psm: 11, variant: 'default' },
  { psm: 7, variant: 'sharpen' },
  { psm: 6, variant: 'sauvola' },
  // 纯 chi_sim 文本行通道兜底：几何策略全败（低分）时按 mapped 胜出。
  // 放最后：高分图在前 5 策略 qualityScore>=0.95 即 break，不会多耗一次识别；
  // 疑难图（几何 mapped 低）才跑到它，纯 chi_sim 对中文表直读质量更高（见 buildGridFromText 注释）。
  { psm: 6, variant: 'default', mode: 'text' },
]
export async function runLocalBest(dataUrl, strategies = OCR_LOCAL_STRATEGIES) {
  const scored = []
  for (const st of strategies) {
    ocrPhaseLabel = `策略 ${scored.length + 1}/${strategies.length}`
    ocrStrategyIdx = scored.length
    ocrStrategyTotal = strategies.length
    try {
      const r = await recognizeLocalOnce(dataUrl, st)
      const points = normalizeGridToPoints(r.grid)
      const summary = summarizeAudit(points)
      const mappedCount = points.filter((p) => p.standard_code).length
      scored.push({ strategy: st, grid: r.grid, items: r.items, narrative: r.narrative || null, flowText: r.flowText || '', date: r.date, time: r.time, collectedAt: r.collectedAt, reportedAt: r.reportedAt, summary, score: summary.qualityScore, mappedCount })
      // 提前退出：若某轮审计质量已很高（多维全部吻合），无需继续重识别
      if (summary.qualityScore >= 0.95) break
    } catch (e) {
      scored.push({ strategy: st, error: e.message, score: -1, mappedCount: 0 })
    }
  }
  // 选最优：score 最高；score 平局（如异常值多的报告各策略都极低）时，
  // 用「成功映射字段数」破平，使识别更完整（如 sauvola 多命中 EO_ABS）的候选胜出。
  // 选最优：score>=0.5 的高可信候选按 score 优先（高分策略保命）；score<0.5 的疑难候选
  // （各策略分都极低，如异常值多的报告）改按成功映射数排序，避免「binary 仅 4 行的虚高 0.4」
  // 抢占「default/文本通道 15+ 行」的候选；文本行通道在几何全败时凭 mapped 胜出（chi_sim 直读更准）。
  const scoreKey = (s) => {
    const sc = s.score ?? -1
    return sc >= 0.5 ? sc : 0.5 - 1 / ((s.mappedCount ?? 0) + 2)
  }
  scored.sort((a, b) => scoreKey(b) - scoreKey(a))
  // 流式（图文型）报告优先：只要有一个候选认出流式形态（单行「流式MRD残留」），就以它为准。
  // 理由：这类报告全文只有一个指标，散点图噪声候选的 mapped 数反而虚高（实测 1007 报告
  // binary 变体 mapped=5 的假指标 vs 正确候选 mapped=1），常规 score/mapped 选优必选到噪声。
  const flowPick = pickFlowCandidate(scored)
  const best = flowPick || scored[0]
  if (!best || best.error) return null
  // 字段级补充融合：以主选(best)为基准，按「default → sauvola → binary → sharpen」优先级
  // 补充 best 未映射的指标（仅补充不覆盖）。default 是质量基线（与旧路径预处理一致），
  // 优先用它的识别结果；sauvola 救「数字尾笔粘连」（RBC 1.85 的 8 被固定阈值吞成 9）。
  // 解决 best 偶发切换策略时（score 同为 0、mapped 略高选到 binary），default 已正确识别的
  // 指标（如 MCHC=340）不随 best 切换而丢失。
  // 流式候选不做补充融合：其它候选的 code 全是散点图噪声，补进来就是假指标。
  const SUPPLEMENT_ORDER = flowPick ? [] : ['default', 'sauvola', 'binary', 'sharpen']
  const bestPts = normalizeGridToPoints(best.grid)
  const codes = new Set(bestPts.filter((p) => p.standard_code).map((p) => p.standard_code))
  for (const v of SUPPLEMENT_ORDER) {
    const cand = scored.find((s) => s.strategy && s.strategy.variant === v && !s.strategy.mode && s.grid)
    if (!cand) continue
    const pts = normalizeGridToPoints(cand.grid)
    for (const sp of pts) {
      if (sp.standard_code && !codes.has(sp.standard_code)) {
        best.grid.push([sp.original_name || '', sp.value || '', sp.ref_range || '', sp.unit || '', 0])
        codes.add(sp.standard_code)
      }
    }
  }
  // 文本行通道补充：几何 best 缺项时纯 chi_sim 文本直读可补漏（best 本身为文本时其 codes 已全含，空转无害）
  const textCand = flowPick ? null : scored.find((s) => s.strategy && s.strategy.mode === 'text' && s.grid)
  if (textCand && textCand !== best) {
    const tpts = normalizeGridToPoints(textCand.grid)
    for (const sp of tpts) {
      if (sp.standard_code && !codes.has(sp.standard_code)) {
        best.grid.push([sp.original_name || '', sp.value || '', sp.ref_range || '', sp.unit || '', 0])
        codes.add(sp.standard_code)
      }
    }
  }
  return {
    grid: best.grid,
    items: best.items,
    // 正文与日期同口径做「best 优先 + 回退」：换策略不该让印象/结论整段消失
    narrative: best.narrative || scored.find((s) => s && s.narrative)?.narrative || null,
    // 流式报告的行文本（诊断用：值抽不到时可拿它复现，不写入任何持久化字段）
    flowText: best.flowText || scored.find((s) => s && s.flowText)?.flowText || '',
    // 文本通道 best 的日期可能缺失（chi_sim 文本日期非目标）→ 回退其它策略识别到的日期。
    // 采集/报告时间同理逐项回退：低分辨率图（900px 存档图）页脚小字在某个变体里能读出来、
    // 在 best 变体里读不出——逐项回退能减少「日期/时间全空」（实测 40 条记录 18 条无报告时间）。
    date: best.date || scored.find((s) => s && s.date && !s.error)?.date || null,
    time: best.time || scored.find((s) => s && s.time)?.time || '',
    collectedAt: best.collectedAt || scored.find((s) => s && s.collectedAt)?.collectedAt || '',
    reportedAt: best.reportedAt || scored.find((s) => s && s.reportedAt)?.reportedAt || '',
    ocrAttempts: scored.map((s) => ({ ...s.strategy, score: s.score, mappedCount: s.mappedCount, error: s.error || null })),
  }
}

// 策略级并行：用切片 worker 池并发跑 OCR_LOCAL_STRATEGIES，墙钟=最慢单策略而非累加。
// 覆盖「矮但慢」的图——矮图不触发切片（切片会切碎），原 runLocalBest 串行 5 策略要 27~52s；
// 改为多 worker 同时跑各策略即可砍到「单策略耗时」量级。算法与 runLocalBest 完全一致
// （同 5 策略、同评分选优、同 sauvola 补充融合），仅并发执行，识别质量不变。
export async function runLocalBestParallel(dataUrl, strategies = OCR_LOCAL_STRATEGIES) {
  // 每个策略必须独占一个 worker：tesseract.js 单 worker 不支持并发 recognize，
  // 复用同一 worker 跑多个策略会在 Promise.all 下互相污染（实测把 EPO 读成 WBC）。
  // 故 worker 数 = 策略数，不做 Math.min 压缩（否则复用导致并发污染）。
  const n = strategies.length
  const workers = await ensureSliceWorkers(n)
  // 切片池寿命计数：发起一次并行识别即计一次，到阈值后下次 ensureSliceWorkers 回收重建
  slicePoolUsage++
  if (slicePoolUsage >= SLICE_POOL_RECYCLE) slicePoolRecycle = true
  // 串行执行所有策略：tesseract.js 在多 worker 并发处理「不同预处理变体的图」时会因共享
  // wasm 图像解码状态互相污染，把 EPO 这类边缘报告读成 WBC（同图并发不受影响，异图并发才炸）。
  // 故改为一次只跑一个策略（顺序识别），牺牲并行墙钟换取识别正确性。串行耗时≈串行 runLocalBest。
  const scored = []
  for (let i = 0; i < strategies.length; i++) {
    const st = strategies[i]
    // 文本行通道：池内 worker 全是 chi_sim+eng（几何），文本通道须用 chi_sim 单语 worker
    // （getTesseractZh，预热时已加载）——直接走 recognizeLocalOnce 的 mode:'text' 分支
    if (st.mode === 'text') {
      try {
        const r = await recognizeLocalOnce(dataUrl, st)
        const points = normalizeGridToPoints(r.grid)
        const summary = summarizeAudit(points)
        const mappedCount = points.filter((p) => p.standard_code).length
        scored.push({ strategy: st, grid: r.grid, items: r.items, narrative: r.narrative || null, flowText: r.flowText || '', date: r.date, time: r.time, collectedAt: r.collectedAt, reportedAt: r.reportedAt, summary, score: summary.qualityScore, mappedCount })
      } catch (e) {
        scored.push({ strategy: st, error: e.message, score: -1, mappedCount: 0 })
      }
      continue
    }
    const w = workers[i % workers.length]
    try {
      ocrPhaseLabel = `策略 ${i + 1}/${strategies.length}`
      ocrStrategyIdx = i
      ocrStrategyTotal = strategies.length
      const processed = await preprocessImage(dataUrl, st.variant)
      const opts = st.psm ? { tessedit_pageseg_mode: st.psm } : {}
      const { data } = await w.recognize(processed, opts, { text: true, blocks: true })
      const items = ocrBlocksToItems(data)
      const grid = buildGridFromItems(items)
      if (!grid || grid.length <= 1) throw new Error('未识别到表格行')
      const points = normalizeGridToPoints(grid)
      const summary = summarizeAudit(points)
      const mappedCount = points.filter((p) => p.standard_code).length
      scored.push({ strategy: st, grid, items, narrative: extractFlowReport(data.text), ...extractReportDate(items), summary, score: summary.qualityScore, mappedCount })
    } catch (e) {
      scored.push({ strategy: st, error: e.message, score: -1, mappedCount: 0 })
    }
  }
  // 选最优 + sauvola 补充融合（与 runLocalBest 同逻辑）
  // 选最优：score>=0.5 的高可信候选按 score 优先（高分策略保命）；score<0.5 的疑难候选
  // （各策略分都极低，如异常值多的报告）改按成功映射数排序，避免「binary 仅 4 行的虚高 0.4」
  // 抢占「default/文本通道 15+ 行」的候选；文本行通道在几何全败时凭 mapped 胜出（chi_sim 直读更准）。
  const scoreKey = (s) => {
    const sc = s.score ?? -1
    return sc >= 0.5 ? sc : 0.5 - 1 / ((s.mappedCount ?? 0) + 2)
  }
  scored.sort((a, b) => scoreKey(b) - scoreKey(a))
  // 流式（图文型）报告优先（同 runLocalBest）：认出流式形态的候选一律优先于噪声候选。
  const flowPick = pickFlowCandidate(scored)
  const best = flowPick || scored[0]
  if (!best || best.error) return null
  // 字段级补充融合：default 优先的全策略补充（同 runLocalBest），避免 best 切换时丢指标。
  const SUPPLEMENT_ORDER = flowPick ? [] : ['default', 'sauvola', 'binary', 'sharpen']
  const bestPts = normalizeGridToPoints(best.grid)
  const codes = new Set(bestPts.filter((p) => p.standard_code).map((p) => p.standard_code))
  for (const v of SUPPLEMENT_ORDER) {
    const cand = scored.find((s) => s.strategy && s.strategy.variant === v && !s.strategy.mode && s.grid)
    if (!cand) continue
    const pts = normalizeGridToPoints(cand.grid)
    for (const sp of pts) {
      if (sp.standard_code && !codes.has(sp.standard_code)) {
        best.grid.push([sp.original_name || '', sp.value || '', sp.ref_range || '', sp.unit || '', 0])
        codes.add(sp.standard_code)
      }
    }
  }
  // 文本行通道补充：几何 best 缺项时纯 chi_sim 文本直读可补漏（best 本身为文本时其 codes 已全含，空转无害）
  const textCand = flowPick ? null : scored.find((s) => s.strategy && s.strategy.mode === 'text' && s.grid)
  if (textCand && textCand !== best) {
    const tpts = normalizeGridToPoints(textCand.grid)
    for (const sp of tpts) {
      if (sp.standard_code && !codes.has(sp.standard_code)) {
        best.grid.push([sp.original_name || '', sp.value || '', sp.ref_range || '', sp.unit || '', 0])
        codes.add(sp.standard_code)
      }
    }
  }
  return {
    grid: best.grid,
    items: best.items,
    // 正文与日期同口径做「best 优先 + 回退」：换策略不该让印象/结论整段消失
    narrative: best.narrative || scored.find((s) => s && s.narrative)?.narrative || null,
    // 流式报告的行文本（诊断用：值抽不到时可拿它复现，不写入任何持久化字段）
    flowText: best.flowText || scored.find((s) => s && s.flowText)?.flowText || '',
    // 文本通道 best 的日期可能缺失（chi_sim 文本日期非目标）→ 回退其它策略识别到的日期。
    // 采集/报告时间同理逐项回退：低分辨率图（900px 存档图）页脚小字在某个变体里能读出来、
    // 在 best 变体里读不出——逐项回退能减少「日期/时间全空」（实测 40 条记录 18 条无报告时间）。
    date: best.date || scored.find((s) => s && s.date && !s.error)?.date || null,
    time: best.time || scored.find((s) => s && s.time)?.time || '',
    collectedAt: best.collectedAt || scored.find((s) => s && s.collectedAt)?.collectedAt || '',
    reportedAt: best.reportedAt || scored.find((s) => s && s.reportedAt)?.reportedAt || '',
    ocrAttempts: scored.map((s) => ({ ...s.strategy, score: s.score, mappedCount: s.mappedCount, error: s.error || null })),
  }
}

// ---- 自适应切片并行 OCR（降窄长/大图耗时） ----
// 背景：单 worker 串行 5 策略对窄长/大图耗时 30~44s（用户实测「随便放一张图就 40 多秒」）。
// 切片 + 多 worker 并行把墙钟砍到「单片 5 策略耗时」量级（窄长图实测 44s→18s）。
// 矮图（h<=MIN_SLICE_HEIGHT）切了不省（面积守恒×策略数守恒），直接走原整图逻辑。
// 质量：21 张真实报告全量验证，mapped 波动 ±2 内（OCR 噪声级），无重复行爆炸、无崩坏。
export const SLICE_POLICY = {
  MIN_SLICE_HEIGHT: 2400, // 触发切片的最小图高(px)；低于此不切
  SLICE_H: 1500,          // 切片高度（细切以最大化并行片数）
  OVERLAP: 160,           // 切片重叠(px)：防切断跨片行（过小偶丢行）
  MAX_WORKERS: 4,         // 并行 worker 上限（平衡加速与内存/CPU）
  // 启用「策略并行」的最小图高(px)。低于此值的图本身识别就快，多 worker 分发/调度的固定开销
  // 大于并行收益，反而变慢（实测 H=285/460 的图并行是负加速 0.12~0.61x），故走串行。
  // 阈值取自全量回归：H<=460 全为负加速，H>=756 全为正加速（1.49~3.25x），600 为两者之间的保守分界。
  PARALLEL_MIN_HEIGHT: 600,
}

// 加载并切片：统一返回 { slices, height }。
//   slices 为 null 表示不切片（矮图或切后不足 2 片）；height 是原图高，供三段式路由判断。
//   高图 slices = [{ dataUrl, absTop, h }]
async function loadAndSlice(dataUrl, policy) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('image load failed'))
    el.src = dataUrl
  })
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (h <= policy.MIN_SLICE_HEIGHT) return { slices: null, height: h }
  // 先放大到 MIN_OCR_WIDTH 宽（与 preprocessImage 一致），再在放大图上切片
  const scale = w < MIN_OCR_WIDTH ? MIN_OCR_WIDTH / w : 1
  const W = Math.round(w * scale)
  const H = Math.round(h * scale)
  const full = document.createElement('canvas')
  full.width = W
  full.height = H
  const fctx = full.getContext('2d')
  fctx.imageSmoothingEnabled = true
  fctx.imageSmoothingQuality = 'high'
  fctx.drawImage(img, 0, 0, W, H)
  const slices = []
  let top = 0
  let idx = 0
  while (top < H) {
    const bottom = Math.min(H, top + policy.SLICE_H)
    const sTop = Math.max(0, idx === 0 ? 0 : top - ((policy.OVERLAP / 2) | 0))
    const sBot = Math.min(H, bottom + ((policy.OVERLAP / 2) | 0))
    const sh = sBot - sTop
    const c = document.createElement('canvas')
    c.width = W
    c.height = sh
    c.getContext('2d').drawImage(full, 0, sTop, W, sh, 0, 0, W, sh)
    slices.push({ dataUrl: c.toDataURL('image/png'), absTop: sTop, h: sh })
    top = bottom
    idx++
  }
  return { slices: slices.length > 1 ? slices : null, height: h }
}

// 单切片在指定 worker 上跑 5 策略选优，返回该片的原始 items（含 sauvola 补充融合）
async function recognizeSliceBest(worker, sliceDataUrl) {
  const scored = []
  for (const st of OCR_LOCAL_STRATEGIES) {
    if (st.mode === 'text') continue // 文本行通道仅整图可用（切片按片跑会断行），跳过
    try {
      const processed = await preprocessImage(sliceDataUrl, st.variant)
      const { data } = await worker.recognize(processed, { tessedit_pageseg_mode: st.psm }, { text: true, blocks: true })
      const items = ocrBlocksToItems(data)
      if (!items || items.length <= 1) throw new Error('行太少')
      const points = normalizeGridToPoints(buildGridFromItems(items))
      const summary = summarizeAudit(points)
      const mappedCount = points.filter((p) => p.standard_code).length
      scored.push({ variant: st.variant, items, score: summary.qualityScore, mappedCount })
      if (summary.qualityScore >= 0.95) break
    } catch (e) {
      scored.push({ variant: st.variant, error: e.message, score: -1, mappedCount: 0 })
    }
  }
  // 选最优：score>=0.5 的高可信候选按 score 优先（高分策略保命）；score<0.5 的疑难候选
  // （各策略分都极低，如异常值多的报告）改按成功映射数排序，避免「binary 仅 4 行的虚高 0.4」
  // 抢占「default/文本通道 15+ 行」的候选；文本行通道在几何全败时凭 mapped 胜出（chi_sim 直读更准）。
  const scoreKey = (s) => {
    const sc = s.score ?? -1
    return sc >= 0.5 ? sc : 0.5 - 1 / ((s.mappedCount ?? 0) + 2)
  }
  scored.sort((a, b) => scoreKey(b) - scoreKey(a))
  const best = scored[0]
  if (!best || best.error) return []
  // 补充融合（items 层）：default 优先的全策略补充（同 runLocalBest），避免 best 切换时丢指标。
  const SUPPLEMENT_ORDER = ['default', 'sauvola', 'binary', 'sharpen']
  const bestCodes = new Set(normalizeGridToPoints(buildGridFromItems(best.items)).filter((p) => p.standard_code).map((p) => p.standard_code))
  for (const v of SUPPLEMENT_ORDER) {
    const cand = scored.find((s) => s.variant === v && s.items && s !== best)
    if (!cand) continue
    const pts = normalizeGridToPoints(buildGridFromItems(cand.items))
    for (const sp of pts) {
      if (sp.standard_code && !bestCodes.has(sp.standard_code)) {
        const it = cand.items.find((it) => it.y != null && Math.abs(it.y - (sp.y ?? -999)) < 12)
        if (it) { best.items.push(it); bestCodes.add(sp.standard_code) }
      }
    }
  }
  return best.items || []
}

// 合并多片 items：按 y 排序，去重重叠区重复行
function mergeSliceItems(allItems) {
  allItems.sort((a, b) => (a.y ?? 0) - (b.y ?? 0))
  const out = []
  let last = null
  for (const it of allItems) {
    if (last && Math.abs((it.y ?? 0) - (last.y ?? 0)) < 12 && it.text === last.text) continue
    out.push(it)
    last = it
  }
  return out
}

// 验证用：记录本次 OCR 实际走的路由（serial / parallel / slice），供 devBridge ocrBench 回传。
// 仅用于开发期确认三段式路由是否按预期生效，不参与识别逻辑，生产读取无副作用。
let lastOcrRoute = 'unknown'
export function getLastOcrRoute() {
  return lastOcrRoute
}

// 自适应切片并行主入口：返回与 runLocalBest 同构的 { grid, items, ... }
// 矮图（或切片失败）自动回退 runLocalBest（原整图逻辑不变）。
export async function runLocalBestSliced(dataUrl, policy = SLICE_POLICY) {
  let loaded = null
  try {
    loaded = await loadAndSlice(dataUrl, policy)
  } catch {
    loaded = null
  }
  const slices = loaded && loaded.slices
  // 不切片时（矮图 / 切片不足 2 片 / 加载失败）按图高三段式路由：
  //   H <  PARALLEL_MIN_HEIGHT       → 串行 5 策略：小图本身识别就快，多 worker 分发开销大于收益
  //                                    （实测 H=285/460 并行是负加速 0.12~0.61x）
  //   PARALLEL_MIN_HEIGHT ≤ H ≤ 2400 → 多 worker 策略并行：墙钟=最慢单策略而非累加
  //                                    （实测 H=756~2116 加速 1.49~3.25x，如 33.5s→10.3s）
  //   H >  MIN_SLICE_HEIGHT(2400)    → 切片并行（走本函数下方的切片路径）
  if (!slices) {
    const h = (loaded && loaded.height) || 0
    if (h && h < policy.PARALLEL_MIN_HEIGHT) {
      lastOcrRoute = 'serial'
      return runLocalBest(dataUrl)
    }
    // 并行策略路径（runLocalBestParallel 用切片 worker 池）在多 worker 并发处理不同预处理
    // 变体图时，tesseract.js 共享 wasm 图像解码状态会互相污染，把 EPO 这类边缘报告读成 WBC
    // （主 worker 串行路径 runLocalBest 稳定正确）。为保识别正确性，并行分支统一回退串行主
    // worker 路径；并行 worker 池的速度优化存在上述 tesseract.js 并发缺陷，需另立专项修复。
    lastOcrRoute = 'serial'
    return runLocalBest(dataUrl)
  }
  lastOcrRoute = 'slice'

  // 并行度 = min(片数, MAX_WORKERS)，复用常驻切片 worker 池（预热后无冷启动）
  const nWorkers = Math.min(slices.length, policy.MAX_WORKERS)
  const workers = await ensureSliceWorkers(nWorkers)
  const merged = []
  let idx = 0
  const workerLoop = async (worker) => {
    while (idx < slices.length) {
      const sl = slices[idx++]
      const items = await recognizeSliceBest(worker, sl.dataUrl)
      for (const it of items) if (it.y != null) it.y += sl.absTop
      merged.push(...items)
    }
  }
  await Promise.all(workers.map((w) => workerLoop(w)))
  const allItems = mergeSliceItems(merged)
  const grid = buildGridFromItems(allItems)
  if (!grid || grid.length <= 1) throw new Error('切片合并后未识别到表格行')
  // 切片池寿命计数（高图切片路径）：到阈值后下次回收重建
  slicePoolUsage++
  if (slicePoolUsage >= SLICE_POOL_RECYCLE) slicePoolRecycle = true
  // 切片路径的正文：用合并后的 items 文本（已按 y 排序，跨片重复行已去重）抽印象/结论
  const narrative = extractFlowReport(allItems.map((it) => it.text || '').join('\n'))
  return { grid, items: allItems, narrative, ...extractReportDate(allItems) }
}

/* ---------------- 扫描件报告 OCR（报告归档用） ---------------- */

// OCR 错字 → 正确字映射（形近/同音，低分辨率扫描件的固有误差，词条为实测高频错误）
const OCR_CHAR_FIXES = [
  // 胸廓 / 支气管 / 血管束
  ['胸亡对称', '胸廓对称'],
  ['胸廊对称', '胸廓对称'],
  ['胸扩对称', '胸廓对称'],
  ['鸡侧胸亡', '双侧胸廓'],
  ['叉侧胸亡', '双侧胸廓'],
  ['广气香', '支气管'],
  ['广气客', '支气管'],
  ['冯气车', '支气管'],
  ['入气管', '支气管'],
  ['支气营', '支气管'],
  ['气香', '气管'],
  ['气营', '气管'],
  // 结节 / 淋巴结
  ['微小菏节', '微小结节'],
  ['微小毕节', '微小结节'],
  ['微小系他', '微小结节'],
  ['微小项节', '微小结节'],
  ['微小结站', '微小结节'],
  ['微小结出', '微小结节'],
  ['微小廾节', '微小结节'],
  ['诽巴结', '淋巴结'],
  ['阐巴结', '淋巴结'],
  ['琳巴结', '淋巴结'],
  ['淋巳结', '淋巴结'],
  ['肺|', '肺门'],
  // 清楚 / 积液 / 血管 / 密度
  ['清茎', '清楚'],
  ['积诬', '积液'],
  ['积滚', '积液'],
  ['太血管', '大血管'],
  ['人血管', '大血管'],
  ['诚低', '减低'],
  ['诚民', '减低'],
  ['诚恬', '减低'],
  ['诚心', '减低'],
  ['诚长', '减低'],
  ['诚必', '减低'],
  // 钙化 / 贫血 / 心腔 / 范围
  ['后化点', '钙化点'],
  ['逢化', '钙化'],
  ['人贡血', '贫血'],
  ['心腑', '心腔'],
  ['左石', '左右'],
  ['严右', '左右'],
  ['范围肝', '范围内肝'],
  ['苑围', '范围'],
  // CT 相关
  ['胸部cT', '胸部CT'],
  ['胸部5T', '胸部CT'],
  ['胸部6T', '胸部CT'],
  ['无脱片', '无胶片'],
  // 标点规整
  ['检查日期，', '检查日期：'],
  ['检查日期:', '检查日期：'],
  ['报告时间:', '报告时间：'],
  // 超声心动图（实测高频 OCR 误读，仅作用于心超文本，不影响化验/CT）
  ['大准', '三尖瓣'], // 三尖瓣  sectional label
  ['尖测', '二尖瓣'], // 二尖瓣  sectional label
  ['尖风血流', '二尖瓣血流'],
  ['二尖准环', '二尖瓣环'],
  ['主动脉鸭', '主动脉瓣'],
  ['肺动脉捧', '肺动脉瓣'],
  ['各狼膜', '各瓣膜'], // 各瓣膜形态
  ['二尖瘀', '二尖瓣'], // 二尖瓣探及…
  ['尖瓣反流', '二尖瓣反流'],
  ['主动脉袜', '主动脉窦'], // 主动脉窦
  ['E/ey', 'E/e’'], // 二尖瓣环 E/e' 比值：撇号误读为 y（值 6.1 干净，可回收费）
]

export function correctOcrText(text) {
  let t = text
  // 先长词条后短词条，保证最长匹配优先
  const sorted = [...OCR_CHAR_FIXES].sort((a, b) => b[0].length - a[0].length)
  for (const [bad, good] of sorted) {
    if (bad === good) continue
    t = t.split(bad).join(good)
  }
  // 标点规整：OCR 常把全角冒号/逗号错成半角，统一为全角中文标点
  t = t
    .replace(/影像所见[:：]\s*/g, '影像所见：')
    .replace(/影像诊断[:：]\s*/g, '影像诊断：')
    .replace(/检查日期[:：]\s*/g, '检查日期：')
    .replace(/报告时间[:：]\s*/g, '报告时间：')
  return t
}

// ===================== 整页文本路径（doc）的放大策略 =====================
// 2026-09-13 定稿：主判据 = 「字形像素高度」（词框高度中位数），原图宽度只作可关闭的辅助判据。
// 背景：宽度只是分辨率的代理，同宽的两张图字号可能差 2~3 倍（实测 826px 整页小图 H=13px
// vs 同宽局部放大图 H=24px），故宽度阈值不足以单独决定放大与否，这里保留开关供按像素辅助时用。
// 曲线依据（scripts/diag-doc-scale-curve.mjs，5 张检查报告 × 5 档放大）：
//   骨髓活检 1071px（H=19）: ×1 汉字 283 且「报告时间」误读成 09-11；×1.5(H=28) 起读对 08-11，
//     ×2.5(H=47) 汉字 339 饱和 → 质量拐点在 H≈28~38，故 targetGlyph 取 32。
//   流式 826px（H=13）: 汉字 346→373（×2.5）后饱和；CT/超声 826px（H=14）各档持平，未降级。
// 关键：只做「纯等比放大」，不加灰度/对比度滤镜——历史上 1652px CT 图放大的降级来自
//   MIN_OCR_WIDTH 预处理的 grayscale + contrast(1.6)，而非放大本身（纯 resize 复测 0 降级）。
export const DOC_UPSCALE = {
  enabled: true, // 总开关；关掉即退化为 1.8.8 之前的「一律不放大」
  // 宽度在 doc 路径仅作「放大后上限护栏」（maxWidth），不参与放大判定——
  // 实测宽度与字高不共线（宽图可能很密 / 很疏，宽≠够清晰）：ecg 1649px/H19 属「宽而密」，
  // 若按宽度阈值跳过放大会丢 196 汉字。判定主依据始终是中位字高（minGlyph/targetGlyph）。
  minGlyph: 22, // 字高中位低于该值才放大（手机实拍高清报告通常 30~60px，不动）
  targetGlyph: 32, // 放大目标字高（曲线饱和区起点）
  maxScale: 3, // 放大倍率上限
  maxWidth: 3000, // 放大后宽度上限（内存 / 时长护栏，与 MIN_OCR_WIDTH 同量级）
  fallbackScale: 2.5, // 首遍量不出字高（词数过少 / 图太糊）时的默认放大
  minWords: 20, // 低于该词数视为「没量出字高」，走 fallback
}

// 词框高度中位数（cap height 近似）：只收含中文/字母数字的词框，过滤装饰噪声的极端框
function medianGlyphHeight(data) {
  const words =
    Array.isArray(data && data.words) && data.words.length
      ? data.words
      : ((data && data.blocks) || []).flatMap((b) =>
          (b.paragraphs || []).flatMap((p) => (p.lines || []).flatMap((l) => l.words || []))
        )
  const hs = words
    .filter((w) => w && w.bbox && /[\u4e00-\u9fa5A-Za-z0-9]/.test(w.text || ''))
    .map((w) => w.bbox.y1 - w.bbox.y0)
    .filter((h) => h > 4)
    .sort((a, b) => a - b)
  return hs.length ? hs[Math.floor(hs.length / 2)] : 0
}

function countWords(data) {
  let n = 0
  for (const b of (data && data.blocks) || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) n += (l.words || []).length
  return n
}

// 放大倍率的纯计算（无 DOM，可单测）：1 表示不放大（用首遍结果，零额外成本）
export function computeDocUpscaleScale({ width = 0, glyph = 0, words = 0 } = {}) {
  if (!DOC_UPSCALE.enabled) return 1
  let scale
  if (glyph <= 0 || words < DOC_UPSCALE.minWords) scale = DOC_UPSCALE.fallbackScale
  else if (glyph >= DOC_UPSCALE.minGlyph) return 1
  else scale = DOC_UPSCALE.targetGlyph / glyph
  scale = Math.min(scale, DOC_UPSCALE.maxScale)
  if (width && width * scale > DOC_UPSCALE.maxWidth) scale = DOC_UPSCALE.maxWidth / width
  if (!(scale > 1.05)) return 1
  return Math.round(scale * 100) / 100
}

// 决策放大倍率：取原图宽度（DOM）后走纯计算
async function planDocUpscale(dataUrl, first) {
  let w = 0
  try {
    const img = await loadImageElement(dataUrl)
    w = img.naturalWidth || img.width || 0
  } catch (_) {
    w = 0
  }
  const h = medianGlyphHeight(first.data)
  const wordCount = (first.data && Array.isArray(first.data.words) ? first.data.words.length : 0) || countWords(first.data)
  return computeDocUpscaleScale({ width: w, glyph: h, words: wordCount })
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('image load failed'))
    el.src = dataUrl
  })
}

// 纯等比放大（不加任何滤镜），返回 dataURL
async function upscalePlain(dataUrl, scale) {
  const img = await loadImageElement(dataUrl)
  const w = Math.round((img.naturalWidth || img.width) * scale)
  const h = Math.round((img.naturalHeight || img.height) * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.95)
}

// ===================== 判型探针：快速全文（只为「这是什么报告」，不求表格精度）=====================
// 与 ocrImageToText 的分工：那条是「读全文本 + 小字放大重识别 + 核型加固」，适合导入页；
// 判型只需要文字证据（模态词 / 段落词 / 表头），所以这里刻意砍成本：
//   ① 先等比缩到 KIND_PROBE_MAX_WIDTH（小图 tesseract 显著更快）；
//   ② **只跑一遍** chi_sim/psm6，不做放大重识别、不做核型加固（那两条最费时）；
//   ③ 独立的短超时，超了就返回空串由调用方回落「手动选类型」，绝不把用户卡在弹层里。
// 判型的准确性仍有保障：detectReportKind 用的是模态词/段落词/表头这类**结构性特征**，
// 不依赖小字精度（小字只在数值/日期上才要紧）。
const KIND_PROBE_MAX_WIDTH = 1400
const KIND_PROBE_TIMEOUT_MS = 20000

// 等比缩到指定宽度（小于目标宽度则原样返回，避免无意义重编码）
async function shrinkToWidth(dataUrl, maxWidth) {
  let img
  try {
    img = await loadImageElement(dataUrl)
  } catch {
    return dataUrl
  }
  const w0 = img.naturalWidth || img.width || 0
  if (!w0 || w0 <= maxWidth) return dataUrl
  const scale = maxWidth / w0
  const w = Math.round(w0 * scale)
  const h = Math.round((img.naturalHeight || img.height) * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.9)
}

/** 图片 dataUrl → 快速全文（判型用）。失败/超时抛错，由调用方降级为手动选择。 */
export async function ocrTextFast(dataUrl) {
  const small = await shrinkToWidth(dataUrl, KIND_PROBE_MAX_WIDTH)
  const p = (async () => {
    const { text } = await recognizePageText(small)
    return correctOcrText(text || '')
  })()
  return withTimeout(p, KIND_PROBE_TIMEOUT_MS, '判型识别超时')
}

/**
 * PDF dataUrl → 文字层全文（毫秒级）。扫描件（无文字层）返回 ''，调用方回落到 ocrTextFast。
 * 只读前 maxPages 页：判型看抬头/模态词/表头即可，翻全本纯属浪费。
 */
export async function pdfTextLayer(dataUrl, maxPages = 3) {
  const pdf = await loadPdfDoc(dataUrl)
  const n = Math.min(pdf.numPages || 1, maxPages)
  const out = []
  for (let i = 1; i <= n; i++) {
    try {
      const items = await extractPdfPageItems(pdf, i)
      const line = items.map((it) => it.text).join(' ').trim()
      if (line) out.push(line)
    } catch {
      /* 单页失败不影响判型：继续下一页 */
    }
  }
  return out.join('\n')
}

// 图片 → 自由文本（报告/影像扫描件用）：Tesseract 识别整页，按行重组返回全文
export async function ocrImageToText(dataUrl) {
  return withTimeout(ocrImageToTextInternal(dataUrl), OCR_TIMEOUT_MS, OCR_TIMEOUT_MSG)
}

// 单次识别（纯中文 worker + psm6）：返回规整后的文本与原始 data（供量字高）
async function recognizePageText(processed) {
  // 纯中文 worker + psm6（整块文本）：实验对比 chi_sim+eng/psm3 在中文报告上大量乱码。
  // 注意：psm6 下 Tesseract 自身行结构可靠，直接用 data.text；
  // 手工按 y 聚合（EPS 阈值）在 psm6 下会把整行拆成单字竖排，不可再用。
  const worker = await getTesseractZh()
  const { data } = await worker.recognize(processed, { tessedit_pageseg_mode: '6' }, { text: true, blocks: true })
  let text = (data.text || '').trim()
  if (!text) {
    // 兜底：从 blocks 结构重建行
    const lines = []
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const t = (line.words || []).map((w) => w.text).join(' ').trim()
          if (t) lines.push(t)
        }
      }
    }
    text = lines.join('\n')
  }
  // 规整：去掉 OCR 在汉字间插入的空格（中文间不留空格），保留数字/英文上下文空格
  text = text
    .split('\n')
    .map((l) => l.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2').trim())
    .filter(Boolean)
    .join('\n')
  return { text, data }
}

async function ocrImageToTextInternal(dataUrl) {
  // 首遍：原图（不放大、不灰度）。字高达标时这一遍就是最终结果，零额外成本；
  // 字高过小（小字 / 低清截图）才按 DOC_UPSCALE 纯等比放大后重跑一遍。
  let out
  try {
    out = await recognizePageText(dataUrl)
  } catch (e) {
    // 失败不再 resetWorker（同主识别路径）：保留已编译 worker 供重试复用
    throw e
  }
  let scale = 1
  try {
    scale = await planDocUpscale(dataUrl, out)
  } catch (e) {
    console.warn('[OCR] doc 放大策略计算失败，沿用原图结果：', e && e.message)
  }
  let finalText
  if (scale > 1) {
    try {
      const bigger = await upscalePlain(dataUrl, scale)
      const second = await recognizePageText(bigger)
      // 只在重跑结果非空时采用（放大失败 / 识别崩了不能把已有结果丢掉）
      if (second.text) finalText = correctOcrText(second.text)
    } catch (e) {
      console.warn('[OCR] doc 放大重识别失败，沿用原图结果：', e && e.message)
    }
  }
  if (!finalText) {
    if (!out.text.trim()) throw new Error('未识别到文字，请确认扫描清晰')
    finalText = correctOcrText(out.text)
  }
  // 核型加固：仅当检测到核型且标点不全时追加 eng/chi 重读（非核型图零额外开销）
  return repairKaryotypeInText(dataUrl, finalText)
}

// ---- 核型（细胞遗传学）OCR 加固 ----
// 背景：纯 chi_sim + psm6 对核型代码串（含 , ; ( ) 等拉丁标点）易吞掉标点，
// 例如把 47,XY,t(9;22)(q34;q11),+?18 读成 47XYt922q34q11+?18（命中工作流 §5.2：
// 跨 variant 标点丢失）。修复遵循 §5.2 护栏 = 「改怎么读，绝不自动改写值」：
//   ① 纯函数 bestKaryotypeFromCandidates：在多个 OCR 候选文本里挑出 ISCN 标点/结构
//      保真度最高的核型行（只择优、不臆造标点），可在 node 单测、不依赖 tesseract/浏览器；
//   ② recognizeKaryotype：对核型报告追加 eng 单语 + chi_sim 的 psm7 重读，并入候选后由 ① 择优。
//      eng 模型对拉丁标点保真度远高于 chi_sim，故标点可被真实读回而非补写；
//   ③ ocrImageToTextInternal 在终稿文本上做核型修复（仅当检测到核型且标点不全时触发，
//      非细胞遗传学图片零额外开销）。

// 行是否像核型：含性染色体(XX/XY) + 数字 + 结构 token（易位 t( / 带 q p / 增减 +/- / 标点）
function looksLikeKaryotype(s) {
  if (!s) return false
  const t = String(s).replace(/\s+/g, '')
  if (!/(XX|XY)/i.test(t)) return false
  if (!/\d/.test(t)) return false
  return /(t\s*\(|q\d|p\d|;\+|\+|\-|[;,()])/i.test(t)
}

// 核型行 ISCN 保真度评分：标点与结构越全分越高（仅用于择优，不用于改写）
function karyoScore(s) {
  const t = String(s).replace(/\s+/g, '')
  let sc = 0
  for (const c of ',;()') if (t.includes(c)) sc += 2
  if (/(XX|XY)/i.test(t)) sc += 1
  if (/t\s*[\(（]/.test(t)) sc += 3
  if (/q\d|p\d/i.test(t)) sc += 2
  if (/\+\??\d/.test(t)) sc += 1
  if (/\-\??\d/.test(t)) sc += 1
  return sc
}

// 从整页 OCR 文本里挑出核型行（行级，取评分最高者）
export function extractKaryotype(text) {
  if (!text) return null
  const lines = String(text).split(/\r?\n/)
  let best = null
  let bestSc = -1
  for (const raw of lines) {
    const line = raw.trim()
    if (!looksLikeKaryotype(line)) continue
    const sc = karyoScore(line)
    if (sc > bestSc) {
      bestSc = sc
      best = line
    }
  }
  return best
}

// 纯函数：在多个 OCR 候选文本里挑出最优核型行。可在 node 单测，不依赖 tesseract/浏览器。
export function bestKaryotypeFromCandidates(candidates) {
  const lines = (candidates || [])
    .filter(Boolean)
    .map((c) => (typeof c === 'string' ? c : c && c.text))
    .filter(Boolean)
    .map(extractKaryotype)
    .filter(Boolean)
  if (!lines.length) return null
  return lines.sort((a, b) => karyoScore(b) - karyoScore(a))[0]
}

// 是否已是规范核型（标点齐全），无需修复
function isCanonicalKaryotype(s) {
  const t = String(s).replace(/\s+/g, '')
  return looksLikeKaryotype(s) && t.includes('(') && t.includes(';') && t.includes(',')
}

// ISCN 核型格式校验（供 UI/下游标注低置信，绝不用于改写值）。
// 返回 { valid, reason }。valid=false 表示疑似 OCR 滑读，需人工复核。
// 关键判据：性染色体(XX/XY)后必须紧跟分隔符（, ; ( 或空格），否则像 XYit 这种
// 「吞掉逗号」的滑读应被标出（XYit 不是合法 ISCN，正确为 XY,t）。
export function validateKaryotype(s) {
  const t = String(s || '').replace(/\s+/g, '')
  if (!/(XX|XY)/i.test(t)) return { valid: false, reason: '缺性染色体' }
  if (!/\d/.test(t)) return { valid: false, reason: '缺染色体计数' }
  if (!/([Xx][Xx]|[Xx][Yy])\s*[,;(]/i.test(t)) return { valid: false, reason: '性染色体后缺分隔符(OCR可能吞掉逗号)' }
  if (!/t\s*\(|del|dup|inv|i\(|r\(|\+|\-/.test(t)) return { valid: false, reason: '缺结构描述(易位/缺失/重复/增减)' }
  return { valid: true, reason: '' }
}

// 核型报告追加重读：eng 单语 psm6（拉丁标点保真）+ chi_sim psm7，并入候选后择优
export async function recognizeKaryotype(dataUrl, baseText) {
  const candidates = [baseText].filter(Boolean)
  try {
    const processed = await preprocessImage(dataUrl, 'default')
    let eng
    try {
      eng = await createOcrWorker('eng')
      const r = await eng.recognize(processed, { tessedit_pageseg_mode: '6' }, { text: true })
      if (r && r.data && r.data.text) candidates.push(r.data.text)
    } catch (e) {
      console.warn('[OCR] eng 核型重读失败：', e && e.message)
    } finally {
      try { if (eng) await eng.terminate() } catch { /* ignore */ }
    }
    try {
      const zh = await getTesseractZh()
      const r = await zh.recognize(processed, { tessedit_pageseg_mode: '7' }, { text: true })
      if (r && r.data && r.data.text) candidates.push(r.data.text)
    } catch (e) {
      console.warn('[OCR] chi_sim 核型重读失败：', e && e.message)
    }
  } catch (e) {
    console.warn('[OCR] 核型重读预处理失败：', e && e.message)
  }
  return bestKaryotypeFromCandidates(candidates)
}

// 在终稿文本上做核型修复：仅当检测到核型且标点不全时触发额外重读（零额外开销于非核型图）
async function repairKaryotypeInText(dataUrl, text) {
  const line = extractKaryotype(text)
  if (!line) return text
  if (!isCanonicalKaryotype(line)) {
    try {
      const better = await recognizeKaryotype(dataUrl, text)
      if (better) {
        const a = better.replace(/\s+/g, '')
        const b = line.replace(/\s+/g, '')
        if (a && a !== b) text = text.split(line).join(better)
      }
    } catch (e) {
      console.warn('[OCR] 核型修复失败，沿用原文本：', e && e.message)
    }
  }
  // QA：核型做完「改怎么读」后做 ISCN 格式校验，畸形（如 XYit 吞掉逗号）标注低置信供人工复核，
  // 绝不在此自动改写值（工作流 §5.2）。
  const finalLine = extractKaryotype(text)
  if (finalLine) {
    const v = validateKaryotype(finalLine)
    if (!v.valid) console.warn(`[OCR] 核型低置信（${v.reason}）：${finalLine} — 建议人工复核`)
  }
  return text
}

// 扫描件 PDF（无文字层）→ OCR 全文：
// 逐页提取内嵌原图（分辨率最高、自动旋转），失败兜底渲染页面视图。
// 供 DocImportFlow 使用：扫描件也能自动识别出报告类型/日期/所见/结论。
// 多页：所有页都 OCR 后按页序拼接全文（此前只认第 1 页，续页内容整段丢失）。
export async function ocrScannedPdfToText(fileOrDataUrl) {
  const dataUrl =
    typeof fileOrDataUrl === 'string'
      ? fileOrDataUrl
      : await new Promise((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(fr.result)
          fr.onerror = () => reject(fr.error)
          fr.readAsDataURL(fileOrDataUrl)
        })
  // 先探页数：页数越多耗时越长，超时上限按页数放宽（单页 = OCR_TIMEOUT_MS，与现状完全一致）
  let pageCount = 1
  try {
    const pdf = await loadPdfDoc(dataUrl)
    pageCount = Math.max(1, pdf.numPages || 1)
  } catch {
    /* 页数探测失败按单页处理 */
  }
  return withTimeout(
    (async () => {
      // 扫描件 OCR 双路尝试：
      // 1) 逐页提取内嵌原图（无缩放、无裁剪，可能更清晰）；
      // 2) 逐页渲染页面视图（高分辨率，对低像素内嵌图是有效增强）。
      // 取文字更长的结果，通常识别更充分。
      const candidates = []
      const ocrPages = async (jpegs) => {
        const texts = []
        for (let i = 0; i < jpegs.length; i++) {
          try {
            texts.push(await ocrImageToTextInternal(jpegs[i]))
          } catch (e) {
            console.warn(`扫描件第 ${i + 1} 页 OCR 未成功：`, e && e.message)
          }
        }
        return texts.filter((t) => t && t.trim()).join('\n')
      }
      try {
        const jpegs = await extractPdfAllPageImages(dataUrl, 3000)
        if (jpegs.length) {
          const text = await ocrPages(jpegs)
          if (text.trim()) candidates.push(text)
        }
      } catch (e) {
        console.warn('扫描件内嵌图提取/识别未成功：', e.message)
      }
      try {
        const jpegs = await renderPdfAllPages(dataUrl, 3000)
        if (jpegs.length) {
          const text = await ocrPages(jpegs)
          if (text.trim()) candidates.push(text)
        }
      } catch (e) {
        console.warn('扫描件页面渲染识别未成功：', e.message)
      }

      if (candidates.length === 0) {
        throw new Error('扫描件 OCR 识别失败，请确认扫描清晰')
      }
      candidates.sort((a, b) => b.length - a.length)
      return candidates[0]
    })(),
    OCR_TIMEOUT_MS * pageCount,
    '扫描件 OCR 识别超时未完成，已自动中止，可保存原件后手动补充内容'
  )
}

// 释放识别进程（内存优化，可选）
export async function disposeOCR() {
  await resetWorker()
}
