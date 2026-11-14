// 报告类型识别（纯函数，零依赖）—— 从**内容**判 kind + reportType
//
// 为什么要有：2026-11-14 用户实测 —— 手机截图导入的报告，抬头上没有「报告类型」这一行，
// 入库后 `kind` 走了默认值 `lab`、`reportType` 空，结果一份心脏彩超被存成「化验单」，
// 在报告库里只能显示「全文型」，也没法按类型筛。
//
// **口径不自己编**：分支顺序与判据照抄 MedData `src/utils/parseDoc.js:148 detectDocType()`
// （那边 25 条断言 + 多次真机踩坑注释）。凡是它踩过的坑，这里照抄理由，不重新发明：
//   · 流式免疫分型要排在基因/骨髓之前 —— 流式结论模板里写着「请结合融合基因、染色体、骨髓形态」，
//     那些引用性文字会把流式报告误判成基因检测/骨穿；
//   · 基因要排在 CT 之前 —— 附录基因列表里的 ACTB/CTCF 会触发裸 CT；
//   · 裸 CT 必须排除前后紧跟字母（HCT/ACTB/CTCF 不是 CT 检查）；
//   · **不能用 EF/射血分数判「心脏」** —— 各彩超页脚都带「EF:左心室射血分数」注释，
//     这么判会把腹部/血管超声全判成心脏彩超；
//   · 病理活检排在骨髓之前、内镜/超声之后 —— 「胃镜取活检」仍属内镜。
//
// 输出口径：kind 用本项目的六分类（lab/pathology/imaging/discharge/drug/unknown，见
// `web/src/pages/intake/shared.js` 的 KIND_OPTIONS）；reportType 用库里已有的中文短名
// （血常规 / 凝血四项 / 生化 / 尿常规 / 超声-心脏 / CT-胸部 …），与历史 54 份的口径一致。
//
// 铁律：**只判类型，不下结论**。判不出来返回 `unknown`，绝不硬猜；返回值必须能被调用方
// 标成「推断」（我们入库时写 `reportTypeInferred: true`），让人一眼看出这不是原始单据上的字。

const T = (s) => String(s || '').replace(/\s+/g, '')

// 抬头标题行：前 6 行里第一条像标题的（出院/诊断证明靠它判，正文里的「出院医嘱」不算）
function titleLine(text, n = 6) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n)
  for (const ln of lines) {
    const flat = ln.replace(/\s+/g, '')
    if (flat.length > 40) continue
    if (/详见|另见|另附|另开|开具|参见|如上/.test(flat)) continue
    if (/出院记录|出院小结|诊断证明书|病情证明书|诊断证明|病情证明/.test(flat)) return flat
  }
  return ''
}

// 化验单：有结构化行时**按项目名判**，比按抬头判稳（同一张单抬头写法差异极大）
const LAB_PANELS = [
  { type: '血常规', re: /全血细胞计数|白细胞计数|淋巴细胞百分比|中性粒细胞百分比/ },
  { type: '凝血四项', re: /凝血酶原时间|国际标准化比值|活化部分凝血活酶|纤维蛋白原/ },
  { type: '血气', re: /^pH=|pCO2|pO2|剩余碱|实际碳酸氢/ },
  { type: '尿常规', re: /尿比重|尿胆原|尿潜血|尿白细胞|LEU|PH（CH）/ },
  { type: '粪便常规', re: /粪便外观|脂肪球|虫卵|霉菌/ },
  { type: 'ABO+RhD 血型', re: /ABO血型|Rh（?D）?血型|RhD/ },
  { type: '不规则抗体筛查', re: /红细胞抗体筛查|筛选细胞|不规则抗体/ },
  { type: '传染病四项', re: /乙肝表面抗原|丙型肝炎抗体|艾滋病病毒抗体|梅毒螺旋体/ },
  { type: '心衰+感染标志物', re: /钠尿肽前体|NT-proBNP|降钙素原|白介素6/ },
  { type: '心肌标志物', re: /肌红蛋白|肌酸激酶同工酶|肌钙蛋白/ },
  { type: '生化', re: /丙氨酸氨基转移酶|天门冬氨酸氨基转移酶|总蛋白|白蛋白|肌酐|尿素|乳酸脱氢酶/ },
]

const ULTRASOUND_PARTS = [
  ['超声-心脏', /心脏|左房|右房|左室|右室|室间隔|心包|二尖瓣|三尖瓣|主动脉瓣|射血分数/],
  ['超声-妇科', /子宫|附件|卵巢|盆腔积液|经阴道/],
  ['超声-生殖', /阴囊|附睾|睾丸|前列腺|精囊/],
  ['超声-浅表', /甲状腺|乳腺|淋巴结|浅表/],
  ['超声-血管', /下肢|上肢|股总静脉|股浅静脉|腘静脉|大隐静脉|颈动脉|椎动脉|足背动脉/],
  ['超声-腹部', /肝脏|胆囊|脾脏|胰腺|双肾|腹部/],
]

const CT_PARTS = [
  ['CT-头颈', /颅脑|头颅|鼻窦|颈部|脑/],
  ['CT-胸部', /胸部|肺|纵隔|胸膜/],
  ['CT-腹部', /腹部|肝胆|胰腺|脾|肾|盆腔/],
  ['CT-血管增强', /血管|增强|CTA|动脉/],
]

/**
 * 从内容判类型。
 * @param {{text?:string, rows?:Array, kind?:string, reportType?:string}} input
 * @returns {{kind:string, reportType:string, inferred:boolean, evidence:string}}
 *   inferred=false 表示「本来就给了类型，没动」；true 表示这是推断值，调用方必须标记出来。
 */
export function classifyReport({ text = '', rows = [], kind = '', reportType = '' } = {}) {
  const given = { kind: String(kind || '').trim(), reportType: String(reportType || '').trim() }
  // 已有类型就一律不覆盖（人工填的/适配器给的都是权威）
  if (given.reportType && given.reportType !== 'LAB_PANEL') {
    return { ...given, inferred: false, evidence: 'preset' }
  }
  const t = T(text)
  const has = (re) => re.test(t)
  const rowNames = (Array.isArray(rows) ? rows : []).map((r) => T(r?.name)).join(' ')
  const done = (k, ty, ev) => ({ kind: k, reportType: ty, inferred: true, evidence: ev })

  // ① 病历文书：标题优先（正文里的「出院医嘱」不算，否则诊断证明会被判成出院记录）
  const title = titleLine(text)
  if (title) {
    if (/诊断证明书|病情证明书|诊断证明|病情证明/.test(title)) return done('discharge', '诊断证明', 'title:诊断证明')
    return done('discharge', '出院记录', 'title:出院记录')
  }
  if (has(/出院日期|出院诊断|出院医嘱|出院情况/) && has(/入院日期|入院情况|入院初步诊断/)) return done('discharge', '出院记录', 'body:出院+入院章节')

  // ② 流式免疫分型（必须早于基因/骨髓：结论模板里的引用文字会反咬）
  if (has(/流式细胞|免疫表型|免疫分型|所检测抗原|CD45\/SSC/i)) return done('pathology', '流式免疫分型', 'text:流式/免疫表型')

  // ③ 基因 / 核型 / 融合基因 / mNGS（必须早于 CT）
  if (has(/融合基因|BCR[::\s-]*ABL1|PML[-\s]*RAR/i)) return done('pathology', '融合基因', 'text:融合基因')
  if (has(/核型|染色体微阵列|微阵列|arrayCGH|ISCN|G显带|R显带/i)) return done('pathology', '染色体核型', 'text:核型/ISCN')
  if (has(/高通量测序|宏基因组|mNGS/i)) return done('pathology', '病原mNGS', 'text:mNGS')
  if (has(/基因检测|基因测序|基因芯片|基因变异|突变检测|二代测序|NGS|FISH检测/i)) return done('pathology', '基因检测', 'text:基因检测')

  // ④ 心电图
  if (has(/心电图|窦性心律|QTc|PR间期/i)) return done('imaging', '心电图', 'text:心电图')

  // ⑤ 超声（部位细分；**不看 EF/射血分数**，见文件头）
  if (has(/超声|彩超|多普勒/)) {
    // **先把「EF 页脚」剥掉再判部位**：各家彩超报告页脚都印
    // 「EF:左心室射血分数 68%」这类注释，直接匹配部位词会把腹部/血管超声全判成心脏彩超
    // （实测：一张腹部彩超因为页脚带「左心室射血分数」被判成「超声-心脏」）。
    // MedData parseDoc.js:190 的原话是「不能用 EF/射血分数判断心脏」，这里把口径落成一行剥离。
    const tEcho = t.replace(/EF\s*[:：]?[^,，；;。]{0,8}射血分数\s*[:：]?\s*\d+%?/gi, '')
      .replace(/左?心室?射血分数\s*[:：]?\s*\d+%?/g, '')
      .replace(/射血分数\s*[:：]?\s*\d+%?/g, '')
    const hit = ULTRASOUND_PARTS.find(([, re]) => re.test(tEcho))
    return done('imaging', hit ? hit[0] : '超声', `text:超声/${hit ? hit[0] : '部位未识别'}`)
  }

  // ⑤b 超声心动图兜底：截图里可能把「超声」这个抬头裁掉，只剩测量表。
  //    只认**超声心动图专属的测量词**（心脏测值/左房前后径/各瓣膜形态…），**绝不认 EF/射血分数** ——
  //    各家彩超页脚都印「EF:左心室射血分数」注释，认它就等于把所有腹部/血管超声判成心脏彩超。
  if (has(/心脏测值|左房前后径|左室前后径|各瓣膜形态|二尖瓣前叶|室间隔厚/)) return done('imaging', '超声-心脏', 'text:超声心动图测量表')

  // ⑥ CT / 磁共振 / X 线（裸 CT 排除前后紧跟字母：HCT/ACTB/CTCF）
  if (has(/(^|[^A-Za-z])CT(?![A-Za-z])|计算机断层/)) {
    const hit = CT_PARTS.find(([, re]) => re.test(t))
    return done('imaging', hit ? hit[0] : 'CT', `text:CT/${hit ? hit[0] : '部位未识别'}`)
  }
  if (has(/磁共振|MRI|核磁/i)) return done('imaging', '磁共振', 'text:磁共振')
  if (has(/X-?ray|X线|X光|数字摄影|(^|[^A-Za-z])DR(?![A-Za-z])/i)) return done('imaging', 'X线', 'text:X线')

  // ⑦ 内镜 → 病理 → 骨髓（顺序有意义：胃镜取活检仍属内镜）
  if (has(/胃镜|肠镜|内镜|支气管镜/)) return done('imaging', '内镜', 'text:内镜')
  if (has(/活检|病理诊断|病理报告|病理学检查|组织病理|免疫组化|镜下所见/)) return done('pathology', '病理活检', 'text:病理/活检')
  if (has(/骨髓|骨穿|骨通|骨随|细胞形态学|涂片分类|粒红比|巨核细胞/)) return done('pathology', '骨髓形态学（骨穿）', 'text:骨髓/骨穿')

  // ⑧ 化验单：有结构化行就按项目名判（比抬头稳）
  if (Array.isArray(rows) && rows.length) {
    const hit = LAB_PANELS.find((p) => p.re.test(rowNames) || p.re.test(t))
    return done('lab', hit ? hit.type : '化验其他', `rows:${hit ? hit.type : '未命中已知板块'}`)
  }

  // ⑨ 拒收类别：票据（发票不是报告）
  if (has(/发票号码|价税合计|电子发票/)) return done('other', '票据', 'text:发票')

  return { kind: given.kind || 'unknown', reportType: given.reportType || '', inferred: false, evidence: 'unclassified' }
}

export const _internals = { titleLine, LAB_PANELS, ULTRASOUND_PARTS, CT_PARTS }
