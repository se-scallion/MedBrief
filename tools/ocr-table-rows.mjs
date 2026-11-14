// OCR 表格 → 结构化行（保留定性结果，不丢行）
//
// 为什么不用 lib/reportIntake.mjs 的 parseLabRows：它只收带数字的值，
// ABO 血型（B型）、粪便常规（褐色稀便/未见/阴性）、抗体筛查（阴性）这类定性行会被整行丢弃。
// 本模块按「检验项目 / 结果 / 参考范围 / 单位」四列制表符布局逐行收，定性值原样留。
//
// 输入：8008 OCR 的 text（vision 输出，列间为 \t）
// 输出：{ rows:[{name,value,unit,refRange,status,rawSnippet}], warnings:[] }

const STOP = /^(检验免责声明|本结果仅供参考|分享报告|检验项目\s*结果|报告单号|患者信息|报告时间|采集时间|就诊医院|科室|项目名称|检查建议|检查描述|检查所见|诊断结果|开单医生|检查医生|报告医生)/
const ARROW = /^[个↑↓丄』J√↑↑]+$/
// 抬头字段被误当指标行（影像报告详情页常见）：姓名/年龄/门诊/临床诊断/医生…
const JUNK_ROW = /^(姓名|年龄|性别)|临床诊断|门诊号|类型[：:]|开单医生|检查医生|报告医生|患者信息|就诊医院|科室[：:]|项目名称|检查建议|检查描述|检查所见|诊断结果|住院号|床号|送检|采集时间|接收时间|样本|条码/

export function parseOcrTable(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))
  // 1) 找到表头行（同时含「检验项目」和「结果」）
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/检验项目/.test(lines[i]) && /结果/.test(lines[i])) { start = i + 1; break }
  }
  // 无表头（跨屏第 2 页常见）：从第一行起就按数据行收，靠 STOP 收口
  if (start < 0) start = 0
  // 2) 逐行收集（含续行合并）
  const raw = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (STOP.test(line.trim())) break
    // 状态栏/标题行（含时间、信号、检验报告字样）不是数据行
    if (/^\d{1,2}:\d{2}/.test(line.trim()) || /检验报告|报告详情|^<|^X\s/.test(line.trim())) continue
    const cells = line.split('\t').map((c) => c.trim())
    if (cells.length >= 2) raw.push({ cells, cont: [] })
    else if (raw.length) raw[raw.length - 1].cont.push(cells[0])
    // 首行就是「名称+值」挤在一格（如「粪便外观（WG）褐色稀便」）→ 也要收，不能因为前面没有行就丢掉
    else {
      const m1 = cells[0] && cells[0].match(/^(.+?[）)])([\u4e00-\u9fa5]{2,})$/)
      if (m1) raw.push({ cells: [m1[1], m1[2]], cont: [] })
    }
  }
  // 3) 续行归位：短箭头 → 拼到值；其余 → 拼到名称
  const rows = []
  const warnings = []
  for (const it of raw) {
    const [name0, value0 = '', ref0 = '', unit0 = ''] = it.cells
    let name = name0, value = value0
    for (const frag of it.cont) {
      if (!frag) continue
      if (ARROW.test(frag)) value += frag
      else name += frag
    }
    name = name.replace(/\s+/g, '').replace(/([（）()])$/, '$1')
    // a) 名称+数值挤在同一单元格（如「中性粒细胞计数16.98个」）→ 按首个数字切开
    {
      const m = name.match(/^([^0-9]*[^\s0-9])(\s*[-+]?\d.*)$/)
      if (m && !value) { name = m[1]; value = m[2] }
    }
    // b) 名称+定性值挤在一起（如「粪便外观（WG）褐色稀便」）→ 括号后切开
    if (!value) {
      const m = name.match(/^(.+?[）)])([\u4e00-\u9fa5]{2,})$/)
      if (m) { name = m[1]; value = m[2] }
    }
    // c) 参考区间散文被粘进名称（如「Rh（D）血型鉴定阳性均为正常…」）→ 截断
    name = name.replace(/(均为正常|提示有不规则抗体|为正常|请输注|阴\s*性为正常).*$/, '')
    // d) 名称末尾把「结果值」重复粘上（Rh（D）血型鉴定阳性）→ 去掉
    if (value && name.endsWith(value)) name = name.slice(0, -value.length)
    // e) OCR 噪声尾巴：分享报告 / ⑦ / 更多 / 状态图标
    name = name.replace(/(分享报告|查看更多|更多)/g, '').replace(/[⑦⑧◎••·]/g, '').replace(/[CTJ](?=$)/, '')
    value = String(value).replace(/[⑦◎]/g, '')
    // f) 「名称+值」挤在名称列、值列变成参考范围（如 中性粒细胞百分15.8=40-75）→ 把尾部数字挪回 value
    if (/^[-\d.<>≤≥]+$/.test(String(value)) && /\d/.test(name)) {
      const mm = name.match(/^(.*?[^\d.])(\d[\d.]*)$/)
      if (mm) { const moved = value; name = mm[1]; value = mm[2]; if (!ref0) { } else { /* ref 保持 */ void moved } }
    }
    if (!name || JUNK_ROW.test(name) || /刘梦圆|女士?\/\d+岁|男\/\d+岁/.test(name)) continue
    if (/^(检验项目|结果|参考范围|单位)$/.test(name)) continue
    const num = value.replace(/[，,]/g, '').match(/-?\d+(\.\d+)?/)
    const status = /↑|个|丄/.test(value) ? 'high' : /↓|』|J/.test(value) ? 'low' : 'unknown'
    rows.push({
      name,
      originalName: name0,
      value: value.replace(/[个↑↓丄』J]/g, '').trim(),
      unit: unit0,
      refRange: ref0,
      status,
      num: num ? Number(num[0]) : null,
      rawSnippet: [name0, value0, ref0, unit0].filter(Boolean).join(' | '),
    })
    if (!value) warnings.push('值缺失：' + name)
  }
  return { rows, warnings }
}


// ---------------- 两列定性表（分子/融合基因报告：检测项目 / 检测结果） ----------------
// 版式：表头「检测项目 检测结果」，每行「BCR::ABL1（P190型） 阳性」。
// 四列解析器在这种版式上只能抽出 0–1 行，必须单独一条通路。
// 注意：PDF 文本层的列间常常只有一个普通空格（甚至没有 tab），所以用正则拆「名称 + 结果」，不靠 split。
const QUAL = /^(阳性|阴性|弱阳性|可疑|不排除|未见|未检出|检出|阴性\(-\)|阳性\(\+\)|\d+(\.\d+)?)$/
export function parseTwoColumnTable(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/检测项目/.test(lines[i]) && /结果/.test(lines[i])) { start = i + 1; break }
  }
  if (start < 0) return { rows: [], warnings: ['未找到「检测项目 / 检测结果」表头'] }
  const rows = []
  const STOP = /^(检验免责声明|本结果仅供参考|报告解释|结果解释|检测意义解释|备注|说明|检验者|审核者|报告日期|分享报告)/
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (STOP.test(line)) break
    // 拆：末尾是定性结果或数值 → 前面就是项目名
    const m = line.match(/^(.+?)[\s\t]+([^\s\t]+)$/)
    if (!m) continue
    const nameRaw = m[1].replace(/\s+/g, '').replace(/^[刘]+/, '')
    const value = m[2].replace(/\s+/g, '')
    if (!QUAL.test(value)) continue
    if (!nameRaw || /^V\d{8,}$/.test(nameRaw) || /^\d+$/.test(nameRaw)) continue
    if (/^(检验者|审核者|报告人|备注|说明|标本|条码)/.test(nameRaw)) continue
    rows.push({
      name: nameRaw,
      originalName: m[1],
      value,
      unit: '',
      refRange: '',
      status: /阳性/.test(value) ? 'positive' : /阴性/.test(value) ? 'negative' : 'unknown',
      num: /^\d/.test(value) ? Number(value) : null,
      rawSnippet: line,
    })
  }
  return { rows, warnings: rows.length ? [] : ['两列表解析 0 行'] }
}
