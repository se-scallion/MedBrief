// ===================== 发票 / 医保结算单：文本 → 票面字段（纯函数，无 DOM） =====================
// 输入是**文字**（PDF 文字层 或 OCR 输出），不是文件——文件解码（pdfjs / tesseract）由调用方负责。
// 这样本模块可纯内存单测（scripts/verify-invoice-parse.mjs 喂真实样本的文字）。
//
// 规则全部来自真实样本实测（docs/cost-invoice-module-plan.md §2.6 的 N1–N10），逐条都有血的代价：
//   N1 金额会被 OCR 拆开：`3205.29` → `3205. 29` —— 金额正则必须容忍数字内部空白，
//      否则**所有金额都抽成 null**（第一版原型就是这么挂的，6 条等式全红）。
//   N2 标签会被打散：`退费金额`→`3AM`/`SEAM`、`校验码`→`ba.`、`住院天数`→`ET 天数`。
//      所以金额优先按「分类名 + 同行金额」配对；预缴/补缴/退费按行内金额顺序取。
//   N3 校验码被打散时，psm11 里它**独立成行** → 取「独立成行的 6 位字母数字」兜底。
//   N4 支付构成字段（统筹/账户/现金/自付/自费）在不同医院票面上**可缺** → 全部可选。
//   N5 日期三格式并存：2026-10-20 / 20261016 20261020 / 2026年10月20日。
//   N7 分类口径与结算单不一致（护理费 124 vs 172）→ 只取总额，分类仅供参考，绝不逐项对账。
//   N8 单次 OCR 会丢「(小写) 3784.25」整行 → 两策略字段级融合。
//   N9 等式只在两侧都有值时判定（缺项跳过，不报失败）。
//   N10 住院天数由区间推导，票面天数只作校验。

// ---------- 基础归一 ----------

// 金额：去千分位/货币符/空白；容忍小数点后的空格（N1）。
export function moneyFromText(s) {
  if (s == null) return null
  const t = String(s).replace(/[,，¥￥\s]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null
  const v = Number(t)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}

// 抓第一个金额（已容忍内部空白）。集团里 $1 为捕获到的金额片段。
const MONEY_RE = '([\\d,]+\\s*\\.\\s*\\d{1,2})'
const grabMoney = (text, re) => {
  const m = String(text || '').match(re)
  return m ? moneyFromText(m[1]) : null
}
const grabText = (text, re) => {
  const m = String(text || '').match(re)
  return m ? String(m[1]).trim() : null
}

// 日期：三种格式统一成 YYYY-MM-DD（N5）
export function dateOf(s) {
  if (!s) return null
  const t = String(s)
  // 容忍日期内部空白：OCR 常把「2026 年 08月 25 日」拆出空格（实测明细页页眉）
  let m = t.match(/(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  m = t.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return null
}

// 票面 9 类收费项目（发票常见口径；缺哪类就不写，绝不补 0）
export const INVOICE_CATEGORIES = ['卫生材料费', '床位费', '化验费', '检查费', '诊察费', '手术费', '西药费', '治疗费', '护理费', '中成药费', '中草药费']

// ---------- 标签值抓取（分隔符容错，N11） ----------
// 实测坑（2026-10-28，用户 08-25 票据）：OCR 会把标签后的冒号读成 `;` `,` `.`，
// 于是「票据号码; 0019064595」在 `[:：]?` 硬匹配下**整段丢失**，票号抽不到 → 无法查重、
// 列表里是一片「无票号」。容错口径：标签与值之间允许 0–4 个非字母数字字符（不含汉字）。
const SEP = '[^0-9A-Za-z\\u4e00-\\u9fa5]{0,4}'
// 标签本身也会被打散：「票据」的「票」实测被读成「理」「景」——
// 上线 OCR 真文本里出现过「理据代码,11060226」「所属电子景据号码,0019064595」，
// 于是票号整段抽不到、分组键对不上、明细页认领不到自己的票据页。
// 容错口径：「X据代码 / X据号码」，X 为任意一个汉字（也可缺失）。
const LABEL_INVOICE_CODE = '[\\u4e00-\\u9fa5]?据代码'
const LABEL_INVOICE_NO = '[\\u4e00-\\u9fa5]?据号码'
const LABEL_OWNER_CODE = '所[\\u4e00-\\u9fa5]?电子[\\u4e00-\\u9fa5]?据代码'
const LABEL_OWNER_NO = '所[\\u4e00-\\u9fa5]?电子[\\u4e00-\\u9fa5]?据号码'
const grabAlnum = (text, label, min = 4, max = 24) => {
  const m = String(text || '').match(new RegExp(label + SEP + '([0-9A-Za-z]{' + min + ',' + max + '})'))
  return m ? m[1] : null
}

// ---------- 医院名（N12：票面不硬抽 → 改为「容忍印章噪字 + 对齐已知医院」） ----------
// 旧口径是「票面医院名不硬抽」（OCR 会把附属读成失重、朝阳读成彰阳），改由结算单 org 或手填。
// 代价实测：只有票据页、没有结算单的住院（用户 08-25 那次）医院名永远是空。
// 新口径：① 从「收款单位 / 定点医疗机构名称」行取值，OCR 常把标签本身读花（收坟单位）
//         → 标签用 `收.{0,2}单位` 这种宽匹配；② 印章压在字间会插进杂字
//         （让科大学附有SR 棚阳医院）→ 只留汉字再裁到「…医院」；③ 抽到的名字与
//         **已知医院名**（库内已有发票 / 体检报告里的医院）做相似度对齐，够近就替换成规范名。
//         这样「失重/彰阳/队吕/棚阳」都会被纠正回「首都医科大学附属北京朝阳医院」。
const HOSP_LABEL = /收.{0,2}单位|开票单位|定点医疗机构名称?|医疗机构名称/
const HOSP_TAIL_RE = /(医院|院区|卫生院|保健院|分院|附院|诊所)/
const HOSP_NOISE = /说明|单位或|查验|官网|法定|本报告|仅供|效力|依据|监制|财政部|财政局/

// 税务/OCR 常见错字对：只在「对齐已知医院」失败、且整串恰好命中时做一次替换。
const HOSP_FIXES = [
  [/失重/g, '附属'],
  [/队吕/g, '附属'],
  [/附有/g, '附属'],
  [/棚阳|彰阳|朝阴|朝阻/g, '朝阳'],
  [/医科大[学字]/g, '医科大学'],
]

// 一行里抠医院名：先去标签、再去印章噪字，最后裁到「…医院」结尾
function hospitalFromLine(line) {
  const src = String(line || '')
  const hit = src.match(HOSP_LABEL)
  if (!hit) return ''
  let rest = src.slice(src.indexOf(hit[0]) + hit[0].length)
  rest = rest
    .replace(/^[^）)】\]]{0,0}/, '')
    .replace(/^\s*[（(《【\[]+[^）)）》】\]]{0,6}[）)）》】\]]?/, '') // 括号里的「章」
    .replace(/^[:：;；,，.、\s"'“”]+/, '')
    .replace(/^(?:章|印章|专用章|签章)/, '')
    .replace(/^[^\u4e00-\u9fa5]+/, '')
  if (!rest) return ''
  const cjk = rest.replace(/[^\u4e00-\u9fa5]+/g, '')
  const m = cjk.match(new RegExp('^[\\u4e00-\\u9fa5]{2,30}?' + HOSP_TAIL_RE.source))
  if (m) return m[0]
  // 尾部可能还粘着「第1页共3页」之类：退一步取「末尾那一段以医院结尾的」
  const tail = cjk.match(new RegExp('[\\u4e00-\\u9fa5]{2,30}' + HOSP_TAIL_RE.source))
  return tail ? tail[0] : ''
}

// 无标签兜底：抓「看起来像医院名」的整行（页眉/页脚区更可能），排除说明类长句
function hospitalFromLines(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const scored = []
  lines.forEach((line, i) => {
    const cjk = line.replace(/[^\u4e00-\u9fa5]+/g, '')
    if (!cjk || cjk.length > 40) return
    const m = cjk.match(new RegExp('^[\\u4e00-\\u9fa5]{2,30}?' + HOSP_TAIL_RE.source))
    if (!m) return
    let score = 0
    if (i < 10) score += 2
    if (i >= lines.length - 6) score += 2
    if (/大学|医科|人民|中心|附属|省|市立/.test(m[0])) score += 1
    if (HOSP_NOISE.test(line)) score -= 3
    if (m[0].length < 4) score -= 1
    scored.push({ name: m[0], score, i })
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.length && scored[0].score > 0 ? scored[0].name : ''
}

// 医院名候选（按可信度排序）：先标签行，再兜底扫描
export function pickHospitalCandidates(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const v = hospitalFromLine(line)
    if (v && !out.includes(v)) out.push(v)
  }
  const fb = hospitalFromLines(text)
  if (fb && !out.includes(fb)) out.push(fb)
  return out
}

// 只留汉字并做已知错字替换
export function cleanHospitalName(s) {
  let t = String(s || '').replace(/[^\u4e00-\u9fa5]+/g, '')
  for (const [re, to] of HOSP_FIXES) t = t.replace(re, to)
  return t
}

// 名字相似度（汉字 LCS 的 Dice 系数）：0–1，用于「对齐到已知医院」
export function hospitalScore(a, b) {
  const A = cleanHospitalName(a)
  const B = cleanHospitalName(b)
  if (!A || !B) return 0
  const n = A.length
  const m = B.length
  const dp = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    let prev = 0
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j]
      dp[j] = A[i - 1] === B[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return (2 * dp[m]) / (n + m)
}

// 抽到的医院名 → 库内规范名。
// 返回 { hospital, raw, snapped, score }：snapped=true 表示「票面乱码被纠正成已知医院」，
// 展示层可以提示「医院名已按库内记录纠正」。不够近（< threshold）就原样保留并标存疑。
export function resolveHospital(raw, known = [], opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.6
  const name = cleanHospitalName(raw)
  if (!name) return { hospital: '', raw: '', snapped: false, score: 0 }
  const pool = [...new Set((known || []).map(cleanHospitalName).filter(Boolean))]
  let best = { name: '', score: 0 }
  for (const k of pool) {
    const s = hospitalScore(name, k)
    if (s > best.score) best = { name: k, score: s }
  }
  if (best.name && best.score >= threshold) return { hospital: best.name, raw: name, snapped: best.name !== name, score: best.score }
  return { hospital: name, raw: name, snapped: false, score: best.score, suspect: true }
}

// 从一段页文本里取最佳医院名（多页场景：票面页优先，靠相似度自然胜出）
export function bestHospitalFromTexts(texts = [], known = []) {
  let best = { hospital: '', raw: '', snapped: false, score: 0 }
  // 初值必须用 -Infinity：否则「已知医院库为空」时 score 都是 0，
  // 第一个候选的 rank 恰好等于空 best 的 rank（0.5），`>` 判不过 → 整批医院名全空。
  let bestRank = -Infinity
  for (const t of texts) {
    for (const cand of pickHospitalCandidates(t)) {
      const r = resolveHospital(cand, known)
      const rank = (r.snapped ? 1 : 0.5) + (r.score || 0)
      if (r.hospital && rank > bestRank) {
        best = r
        bestRank = rank
      }
    }
  }
  return best
}

// ---------- 发票（住院收费票据 / 门诊票据） ----------

export function parseInvoiceText(text) {
  const t = String(text || '')
  const out = {
    // N11：分隔符容错（OCR 把冒号读成 ; 时曾导致票号整段丢失、无法查重）
    invoice_code: grabAlnum(t, LABEL_INVOICE_CODE, 6, 20),
    invoice_no: grabAlnum(t, LABEL_INVOICE_NO, 6, 20),
    check_code: null,
    issued_at: dateOf(grabText(t, new RegExp('开.{0,2}日期' + SEP + '(\\d{4}\\s*[-年/.]\\s*\\d{1,2}\\s*[-月/.]\\s*\\d{1,2})'))),
    service_from: null,
    service_to: null,
    amount_total: null,
    amount_insurance: null,
    amount_account: null,
    amount_cash: null,
    amount_selfpay: null,
    amount_ownpay: null,
    prepaid: null,
    refund: null,
    supplement: null,
    hospital_days: null,
    admission_times: null,
    hospital: null,
    categories: {},
    amount_total_source: null,
  }

  // N3：校验码标签可能被打散（`ba. krpied`）→ 兜底取独立成行的 6 位 token
  out.check_code =
    grabAlnum(t, '校验码', 4, 20) || grabText(t, /^([0-9A-Za-z]{6})$/m) || null

  // N5：住院时间常用「两个 8 位日期连写」，中间可能有任意分隔
  const stay = t.match(/住院时间\s*[:：]?\s*(\d{8})\D{0,6}(\d{8})/) || t.match(/住院时间\s*[:：]?\s*(\d{4}-\d{2}-\d{2})\D{0,6}(\d{4}-\d{2}-\d{2})/)
  if (stay) {
    out.service_from = dateOf(stay[1])
    out.service_to = dateOf(stay[2])
  }

  // 分类金额：分类名 + 同行第一个金额（N2：不靠整行标签）
  for (const name of INVOICE_CATEGORIES) {
    const v = grabMoney(t, new RegExp(name + '\\s*[:：]?\\s*' + MONEY_RE))
    if (v != null) out.categories[name] = v
  }
  const catSum = Object.values(out.categories).reduce((a, b) => a + b, 0)

  // 票面总额：优先「(小写) 3784.25」；抽不到则用分类求和（N8：单次 OCR 会丢这一行）
  const totalFromSlip =
    grabMoney(t, new RegExp('[（(]\\s*小写\\s*[）)]\\s*[:：]?\\s*¥?\\s*' + MONEY_RE)) ??
    grabMoney(t, new RegExp('金额合计[^\\n]{0,30}?¥?\\s*' + MONEY_RE))
  if (totalFromSlip != null) {
    out.amount_total = totalFromSlip
    out.amount_total_source = 'slip'
  } else if (catSum > 0) {
    out.amount_total = Math.round(catSum * 100) / 100
    out.amount_total_source = 'sum-categories'
  }

  // 支付构成（N4：全部可选）
  out.amount_insurance = grabMoney(t, new RegExp('医保统筹基金支付\\s*[:：]?\\s*' + MONEY_RE))
  out.amount_account = grabMoney(t, new RegExp('个人账户支付\\s*[:：]?\\s*' + MONEY_RE))
  out.amount_cash = grabMoney(t, new RegExp('个人现金支付\\s*[:：]?\\s*' + MONEY_RE))
  out.amount_selfpay = grabMoney(t, new RegExp('个人自付\\s*[:：]?\\s*' + MONEY_RE))
  // 个人自费：OCR 常把 0.00 读成别的数字，只在能看到完整两位小数时采信（可疑值交由等式校验暴露）
  out.amount_ownpay = grabMoney(t, new RegExp('个人自费\\s*[:：]?\\s*' + MONEY_RE))

  out.prepaid = grabMoney(t, new RegExp('预缴金额\\s*[:：]?\\s*' + MONEY_RE))
  out.supplement = grabMoney(t, new RegExp('补缴金额\\s*[:：]?\\s*' + MONEY_RE))
  out.refund = grabMoney(t, new RegExp('退费金额\\s*[:：]?\\s*' + MONEY_RE))
  if (out.refund == null) {
    // N2：退费金额标签会被读成 3AM/SEAM → 按「含预缴金额那一行」内金额出现顺序取第 3 个
    const line = t.split('\n').find((l) => /预缴金额/.test(l)) || ''
    const toks = (line.match(/[\d,]+\s*\.\s*\d{1,2}/g) || []).map(moneyFromText)
    if (toks.length >= 3) out.refund = toks[toks.length - 1]
  }

  // N10：天数只要求「天数」关键字（`住院天数` 可能被读成 `ET 天数`）
  const days = grabText(t, /天数\s*[:：]?\s*(\d+)/)
  out.hospital_days = days ? Number(days) : null
  const times = grabText(t, /住院次数\s*[:：]?\s*(\d+)/)
  out.admission_times = times ? Number(times) : null

  // N12：医院名走「容忍标签/印章噪字 + 对齐已知医院」（known 由调用方从库内传入；
  // 不传就是原始串，交由展示层标存疑）。不再留空——那会让只有票据页的住院永远没有医院名。
  const hospCands = pickHospitalCandidates(t)
  out.hospital_raw = hospCands[0] || ''
  out.hospital = out.hospital_raw
  return out
}

// ---------- 医保结算单（住院类费用结算单） ----------

export function parseSettlementText(text) {
  const t = String(text || '')
  const out = {
    doc_kind: 'settlement',
    settle_no: grabText(t, /No\.?\s*([0-9A-Za-z]{6,})/),
    org: grabText(t, /定点医疗机构名称[:：]\s*([^\s\n]+)/),
    org_code: grabText(t, /定点医疗机构编号[:：]\s*(\d+)/),
    service_from: dateOf(grabText(t, /费用发生时段\s*(\d{4}-\d{2}-\d{2})/)),
    service_to: dateOf(grabText(t, /费用发生时段\s*\d{4}-\d{2}-\d{2}\s*至\s*(\d{4}-\d{2}-\d{2})/)),
    days: null,
    total: null,
    daily_avg: null,
    personal_due: null,
    calc_date: null,
    totals: {},
  }
  const days = grabText(t, /共计\s*[（(]?\s*天\s*[）)]?\s*(\d+)/)
  out.days = days ? Number(days) : null
  out.total = grabMoney(t, new RegExp('费用总额\\s*' + MONEY_RE))
  out.daily_avg = grabMoney(t, new RegExp('日均额\\s*' + MONEY_RE))
  out.personal_due = grabMoney(t, new RegExp('个人应付金额\\s*' + MONEY_RE))
  out.calc_date = dateOf(grabText(t, /操作日期[:：]\s*(\d{4}-\d{2}-\d{2})/))

  // 分类合计（结算单口径，仅作交叉参考——与发票口径不同，N7）
  const cats = {
    bed_total: '床位费总额',
    nursing_total: '护理费总额',
    treat_total: '治疗费总额',
    surgery_total: '手术费总额',
    material_total: '一次性材料总额',
    exam_total: '检查费总额',
    lab_total: '化验费总额',
    drug_total: '药费总额',
  }
  for (const [k, label] of Object.entries(cats)) {
    const v = grabMoney(t, new RegExp(label + '\\s*' + MONEY_RE))
    if (v != null) out.totals[k] = v
  }
  return out
}

// ---------- 页面分类：一张住院发票 = 1 票据页 + 若干「医疗收费明细」页（N13） ----------
// 用户 2026-08-25 那次住院只有票据页 → 医院名/票号一缺就是一整张票的窟窿；
// 2026-10-20 那次另配了 3 页明细。明细页此前会被当成「另一张票」解析（它同样有分类名+金额），
// 于是库里有票号缺失的幽灵票。分类必须先做，再决定「解析成票面」还是「只当附件」。
//
// 判据（都来自真实样本，两家的版式都覆盖）：
//   detail     ：标题「医疗收费明细（电子）」/「所（隶）属电子票据号码」/「第 N 页 共 M 页」
//   invoice    ：标题「医疗（住院）收费票据」/「票据号码」标签 + 分类金额
//   settlement ：医保结算单（费用总额 / 个人应付金额 / 费用发生时段）
export function classifyPageText(text) {
  const t = String(text || '')
  const nl = t.replace(/\s+/g, '')
  const detailTitle = /医疗收费明细|收费明细（?电子）?|费用明细清单/.test(nl)
  const detailOwner = /所属?电子票据号码|所[隶隶]属电子票据代码/.test(nl)
  const pageFooter = /第\d+页共\d+页/.test(nl)
  const invoiceTitle = /医疗(?:住院)?收费票据|财政电子票据|收费票据（电子）/.test(nl)
  const hasNo = /票据号码/.test(nl)
  const settle = /费用总额|个人应付金额|费用发生时段/.test(nl)

  // 明细页优先判：它也可能带「票据代码/号码」字样（是「所属」字样），不能反过来判成票据
  if (detailTitle || detailOwner) return 'detail'
  if (pageFooter && /项目名称/.test(nl) && !invoiceTitle) return 'detail'
  if (invoiceTitle || hasNo) return 'invoice'
  if (settle) return 'settlement'
  return 'unknown'
}

// 明细页只取「能拿来自证」的几个数：所属票号（分组用）、合计（与票面总额交叉校验）、页码。
// **不抽明细行**（约 200 项）：化验已进 records、检查已进 docs、住院用药已含在总额里，
// 再存一遍信息量更弱——这是 2026-10-21 的既有拍板，多页支持不改变它。
export function parseDetailPageText(text) {
  const t = String(text || '')
  const totals = [...t.matchAll(new RegExp('合\\s*计\\s*[:：]?\\s*' + MONEY_RE, 'g'))].map((m) => moneyFromText(m[1]))
  const subtotals = [...t.matchAll(new RegExp('小\\s*计\\s*[:：]?\\s*' + MONEY_RE, 'g'))].map((m) => moneyFromText(m[1]))
  const page = grabText(t, /第\s*(\d+)\s*页/)
  const pageCount = grabText(t, /共\s*(\d+)\s*页/)
  const issued = grabText(t, new RegExp('开.{0,2}日期' + SEP + '(\\d{4}\\s*[-年/.]\\s*\\d{1,2}\\s*[-月/.]\\s*\\d{1,2})')) ||
    grabText(t, /(\d{4}\s*[-年/.]\s*\d{1,2}\s*[-月/.]\s*\d{1,2})/)
  const cands = pickHospitalCandidates(t)
  return {
    doc_kind: 'detail',
    owner_invoice_code: grabAlnum(t, LABEL_OWNER_CODE, 6, 20) || grabAlnum(t, '电子' + LABEL_INVOICE_CODE, 6, 20),
    owner_invoice_no: grabAlnum(t, LABEL_OWNER_NO, 6, 20) || grabAlnum(t, '电子' + LABEL_INVOICE_NO, 6, 20),
    issued_at: dateOf(issued),
    // 「合计」/「小计」都取**最后一次出现**：分类行里也有「(小计:600.0000元)」，
    // 取最大值会把「化验费小计 5150.50」当成页小计（实测踩坑）；底部汇总行才是真值。
    total: lastMoney(totals),
    subtotal: lastMoney(subtotals),
    page_no: page ? Number(page) : null,
    page_count: pageCount ? Number(pageCount) : null,
    hospital_raw: cands[0] || '',
    hospital_candidates: cands,
  }
}

const lastMoney = (arr) => {
  const ok = (arr || []).filter((x) => x != null)
  return ok.length ? ok[ok.length - 1] : null
}

// 一段文字 → { role, fields }（导入流与单测共用的唯一入口）
export function parsePageText(text, opts = {}) {
  const t = String(text || '')
  const role = opts.role || classifyPageText(t)
  if (role === 'detail') return { role, fields: parseDetailPageText(t) }
  if (role === 'settlement') {
    const st = parseSettlementText(t)
    return { role, fields: st }
  }
  const inv = parseInvoiceText(t)
  if (opts.knownHospitals && opts.knownHospitals.length) {
    const r = resolveHospital(inv.hospital_raw, opts.knownHospitals)
    inv.hospital = r.hospital
    inv.hospital_snapped = r.snapped
    inv.hospital_suspect = !!r.suspect
  }
  return { role: role === 'unknown' ? 'unknown' : 'invoice', fields: inv }
}

// ---------- 两策略字段级融合（N8） ----------
// 规则：主策略抽到的用主；主缺失用副；两边都有但不等 → 取「更像样」的（金额取非 null 且 > 0 的），
// 并把冲突记进 conflicts 由 UI 提示（绝不静默挑一个当成对）。
export function mergeInvoiceFields(primary = {}, secondary = {}) {
  const out = { ...primary }
  const conflicts = []
  const keys = new Set([...Object.keys(primary || {}), ...Object.keys(secondary || {})])
  for (const k of keys) {
    if (k === 'categories') continue
    const a = primary ? primary[k] : undefined
    const b = secondary ? secondary[k] : undefined
    const emptyA = a == null || a === ''
    const emptyB = b == null || b === ''
    if (emptyA && !emptyB) out[k] = b
    else if (!emptyA && !emptyB && String(a) !== String(b)) {
      // 金额类冲突：保留非零一侧（0.00 常是 OCR 误读），两侧都非零则记冲突
      const na = Number(a)
      const nb = Number(b)
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        if (na === 0 && nb !== 0) out[k] = b
        else if (nb === 0 && na !== 0) out[k] = a
        else conflicts.push({ field: k, primary: a, secondary: b })
      } else {
        conflicts.push({ field: k, primary: a, secondary: b })
      }
    }
  }
  // 分类：并集，同名取有值者
  const cats = { ...(secondary.categories || {}), ...(primary.categories || {}) }
  out.categories = cats
  out.conflicts = conflicts
  return out
}

// ---------- 等式校验（N9：两侧都有值才判） ----------
// 返回 [{ name, ok, detail }]，ok 为 null 表示「缺项，跳过不判」。
export function identityChecks(invoice, settlement) {
  const inv = invoice || {}
  const st = settlement || {}
  const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.01
  const res = []
  const push = (name, a, b, formula) => {
    if (a == null || b == null) {
      res.push({ name, ok: null, detail: '缺项，跳过' })
      return
    }
    res.push({ name, ok: Math.abs(a - b) <= 0.01, detail: `${formula}：${a} vs ${b}` })
  }

  const catSum = Object.values(inv.categories || {}).reduce((x, y) => x + y, 0)
  push('分类求和 = 票面总额', catSum > 0 ? Math.round(catSum * 100) / 100 : null, inv.amount_total ?? null, 'Σ9类 vs 小写合计')

  const parts =
    inv.amount_insurance != null || inv.amount_account != null || inv.amount_cash != null
      ? (inv.amount_insurance || 0) + (inv.amount_account || 0) + (inv.amount_cash || 0)
      : null
  push('统筹+账户+现金 = 票面总额', parts == null ? null : Math.round(parts * 100) / 100, inv.amount_total ?? null, '支付构成')

  const netCash =
    inv.prepaid != null && inv.refund != null ? Math.round((inv.prepaid - inv.refund + (inv.supplement || 0)) * 100) / 100 : null
  push('预缴−退费+补缴 = 个人现金', netCash, inv.amount_cash ?? null, '预缴/退费')

  push('票面总额 = 结算单费用总额', inv.amount_total ?? null, st.total ?? null, '票面 vs 结算单')
  push('个人现金 = 结算单个人应付', inv.amount_cash ?? null, st.personal_due ?? null, '现金 vs 个人应付')

  const sameRange =
    inv.service_from && st.service_from ? inv.service_from === st.service_from && inv.service_to === st.service_to : null
  res.push({
    name: '票面住院区间 = 结算单区间',
    ok: sameRange,
    detail: sameRange == null ? '缺项，跳过' : `${inv.service_from}~${inv.service_to} vs ${st.service_from}~${st.service_to}`,
  })

  // 统筹推算（结算单口径）：总额 − 个人应付，应与票面「医保统筹基金支付」一致
  const dueFromSettle = st.total != null && st.personal_due != null ? Math.round((st.total - st.personal_due) * 100) / 100 : null
  push('结算单推算统筹 = 票面统筹', inv.amount_insurance ?? null, dueFromSettle, '总额−个人应付')

  return res
}

// 真值得分（L1 用：把解析结果与 expected.json 对比）
export function scoreAgainstExpected(parsed, expected, fields) {
  const list = fields || Object.keys(expected || {})
  let pass = 0
  const fails = []
  for (const k of list) {
    const e = expected ? expected[k] : undefined
    const a = parsed ? parsed[k] : undefined
    if (e == null) continue
    const ok =
      typeof e === 'number'
        ? typeof a === 'number' && Math.abs(a - e) <= 0.01
        : String(a ?? '') === String(e)
    if (ok) pass++
    else fails.push(`${k}: expected=${JSON.stringify(e)} actual=${JSON.stringify(a)}`)
  }
  return { pass, total: list.filter((k) => expected && expected[k] != null).length, fails }
}
