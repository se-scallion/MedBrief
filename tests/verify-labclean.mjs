// 化验行字段清洗回归（守「看起来正常、实际是错值」这一类静默失败）
//
// 背景（2026-11-13 排雷实测，54 份真实报告 / 204 行）：
//   有 9 行的三列整体左移 —— `名称(含着真值) | 值=参考区间 | 参考区间=单位`。
//   这类行在旧卡面上「值」显示的是参考区间、参考区间显示的是单位，且因为 refRange='sec' 不是区间，
//   无法判定高低 → status=unknown → **既不进异常项、也不报错**，是最典型的静默失败。
//   还有 unit/refRange 串位、名称里嵌数值（`pCO2→pCO` 这类误剥）等。
//
// 断言原则（不贴实现细节，贴不变量）：
//   1. 幂等：清洗两次 == 清洗一次（有损规则最容易在这里第二次改坏数据）；
//   2. 干净行零改动：清洗层不许碰本来就对的字段（否则它本身就是新的污染源）；
//   3. 还原正确性：被左移的真值必须回到 value，区间回到 refRange，单位回到 unit —— 逐值核对；
//   4. 固有数字不剥：`CO2 / pCO2 / CD34+ / 白介素6 / P190型` 是项目名的一部分，剥掉就是造错名；
//   5. 串码防护：同名异轴项必须分 code（MCH≠Hb、血气 Hct≠血常规 HCT、尿白细胞≠血白细胞、尿糖≠血糖）；
//   6. 覆盖率不变量：快照里 ≥99% 的行必须拿到 code（code 是去重/趋势/危急值的唯一键）。
//
// 运行：node tests/verify-labclean.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeRow, cleanName, isUnitLike, isRange, extractNameValue, repairColumnShift, normalizeUnitDisplay } from '../lib/labClean.mjs'
import { classifyAnalyte } from '../lib/reportIntake.mjs'

const SNAP = JSON.parse(fs.readFileSync(new URL('./fixtures/card-snapshot-v3.json', import.meta.url), 'utf8'))
const ALL_ROWS = SNAP.reports.flatMap((r) => r.rows)

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

console.log(`化验行清洗回归（快照 ${SNAP.reports.length} 份 / ${ALL_ROWS.length} 行）\n`)

// ---------------- 1. 幂等 ----------------
it('幂等：清洗两次 == 清洗一次（全量，逐字段）', () => {
  const bad = []
  for (const row of ALL_ROWS) {
    const a = normalizeRow(row)
    const b = normalizeRow(a)
    for (const f of ['name', 'value', 'unit', 'refRange']) {
      if (String(a[f] ?? '') !== String(b[f] ?? '')) bad.push(`${row.name}.${f}: ${a[f]} → ${b[f]}`)
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `有 ${bad.length} 行二次清洗又被改动：${bad.slice(0, 5).join('；')}`)
})

// ---------------- 2. 干净行零改动 ----------------
it('干净行零改动：本来就对的字段一个不动', () => {
  const cleanRows = [
    { name: '白细胞计数', value: '6.83', unit: '10^9/L', refRange: '3.5-9.5', num: 6.83 },
    { name: '血红蛋白', value: '113', unit: 'g/L', refRange: '130-175', num: 113 },
    { name: '血小板', value: '321', unit: '10^9/L', refRange: '125-350', num: 321 },
    { name: 'C反应蛋白', value: '1.2', unit: 'mg/L', refRange: '0-8', num: 1.2 },
    { name: '骨髓原始细胞', value: '85.76', unit: '%', refRange: '', num: 85.76 },
  ]
  for (const row of cleanRows) {
    const out = normalizeRow(row)
    assert.deepEqual(out.repaired, [], `干净行被误改：${row.name} → repaired=${out.repaired.join('+')}`)
    assert.equal(out.name, row.name)
    assert.equal(out.value, row.value)
    assert.equal(out.unit, row.unit)
    assert.equal(out.refRange, row.refRange)
  }
})

// ---------------- 3. 列左移还原（真实脏行的真值必须回到 value） ----------------
it('列左移还原：真实 9 行的真值/区间/单位三列各归其位', () => {
  // 期望值来自原图原文（人工核对）：名称里被吞的那个数就是实测值
  const expected = [
    ['凝血酶原时间（P12.2个T）', '12.2', '9.8-12.1', 'sec'], // 原文 `sec`；`seC` 写法由 normalizeUnitDisplay 归一到小写
    ['中性粒细胞百分87.2个比', '87.2', '40-75', '%'],
    ['中性粒细胞计数12.59个', '12.59', '1.8-6.3', '10^9/L'],
    ['活化部分凝血活35.7个酶时间（APTT）', '35.7', '25-31.3', 'sec'],
    ['D-二聚体（D-Di10.18个mer）', '10.18', '0-0.55', 'mg/L'],
    ['中性粒细胞百分15.8', '15.8', '40-75', '%'],
  ]
  for (const [name, value, refRange, unit] of expected) {
    const raw = ALL_ROWS.find((r) => r.name === name)
    assert.ok(raw, `快照里找不到脏行「${name}」（快照是否已重新生成？）`)
    const out = normalizeRow(raw)
    assert.equal(out.value, value, `${name} 的值应为 ${value}，实际 ${out.value}`)
    assert.equal(out.refRange, refRange, `${name} 的参考区间应为 ${refRange}，实际 ${out.refRange}`)
    assert.equal(out.unit, unit, `${name} 的单位应为 ${unit}，实际 ${out.unit}`)
    assert.ok(out.repaired.includes('column-shift'), `${name} 应标记 column-shift 留痕`)
  }
})

it('列左移还原后可判定高低（旧行为是 status=unknown 静默漏判）', () => {
  const cases = [
    ['中性粒细胞百分87.2个比', 'high'],
    ['中性粒细胞计数12.59个', 'high'],
    ['D-二聚体（D-Di10.18个mer）', 'high'],
    ['活化部分凝血活35.7个酶时间（APTT）', 'high'],
  ]
  for (const [name, want] of cases) {
    const out = normalizeRow(ALL_ROWS.find((r) => r.name === name))
    const [lo, hi] = String(out.refRange).split('-').map(Number)
    const num = Number(out.value)
    const got = num > hi ? 'high' : num < lo ? 'low' : 'normal'
    assert.equal(got, want, `${name}：${num} 对 [${lo},${hi}] 应为 ${want}，实际 ${got}`)
  }
})

it('单位/区间串位纠正：unit 里存了区间 → 换回 refRange', () => {
  const out = normalizeRow({ name: '纤维蛋白原（FBG）', value: '3.2', unit: '1.8-3.5', refRange: '', num: 3.2 })
  assert.equal(out.unit, '', `单位应为空，实际 ${out.unit}`)
  assert.equal(out.refRange, '1.8-3.5', `参考区间应为 1.8-3.5，实际 ${out.refRange}`)
})

// ---------------- 4. 固有数字不剥 ----------------
it('固有数字不剥：CO2 / pCO2 / CD34+ / 白介素6 / P190型 全部保持原样', () => {
  for (const n of ['二氧化碳（CO2）', 'pCO2', 'CD34+细胞占有核细胞比例', '白介素6', 'BCR::ABL1（P190型）', 'HCO3-', 'BEecfC']) {
    assert.equal(cleanName(n), n, `「${n}」被改成了「${cleanName(n)}」（固有数字/编号不得剥离）`)
  }
})

it('单位写法归一：10-9/L → 10^9/L、SeC → sec、G/L → g/L（量纲不变，只修写法）', () => {
  assert.equal(normalizeUnitDisplay('10-9/L'), '10^9/L')
  assert.equal(normalizeUnitDisplay('10~12/L'), '10^12/L')
  assert.equal(normalizeUnitDisplay('SeC'), 'sec')
  assert.equal(normalizeUnitDisplay('G/L'), 'g/L')
  assert.equal(normalizeUnitDisplay('Cel/UL'), 'Cel/UL', '不认识的单位原样保留，不得瞎改')
})

it('value 尾巴噪声：22.00小 → 22.00（且不改 <0.01 这类真值）', () => {
  assert.equal(normalizeRow({ name: 'pCO2', value: '22.00小', num: 22 }).value, '22.00')
  assert.equal(normalizeRow({ name: '某项目', value: '<0.01' }).value, '<0.01')
})

it('名称噪声：圈号 / 尾部单字母 / 定性结果 / OCR 截断', () => {
  assert.equal(cleanName('二氧化碳（CO2）⑦'), '二氧化碳（CO2）')
  assert.equal(cleanName('血小板压积C'), '血小板压积')
  assert.equal(cleanName('丙型肝炎抗体（A阴性（-）nti-HCV）'), '丙型肝炎抗体（Anti-HCV）')
  assert.equal(cleanName('中性粒细胞百分15.8'), '中性粒细胞百分比')
})

// 2026-11-14 事故：`caa4d15` 用「纯中文 ≥2 字 → 说明性短语」的规则，把 **31 个合法定性结果**
// 全洗成了空值（阴性×22 / 阳性×4 / 未见×4 / 褐色稀便×1）。用户对比两份 PDF 逮到。
// 不变量：定性结果必须原样保留；只有真正的说明性短语才清空。
it('定性结果不得被当描述句清空：阴性 / 阳性 / 未见 / 褐色稀便 / neg 必须原样保留', () => {
  const cases = [
    ['Rh（D）血型鉴定', '阳性'],
    ['乙肝表面抗原（HBsAg）', '阴性'],
    ['艾滋病病毒抗体（Anti-HIV）', '阴性'],
    ['虫卵', '未见'],
    ['霉菌', '未见'],
    ['粪便外观（WG）', '褐色稀便'],
    ['ABO血型鉴定', 'B型'],
  ]
  for (const [name, value] of cases) {
    const n = normalizeRow({ name, value })
    assert.equal(n.value, value, `${name} 的值「${value}」被洗成了「${n.value}」`)
    assert.ok(!n.repaired.includes('prose-dropped'), `${name} 不该被标 prose-dropped`)
    assert.ok(n.qualitative, `${name} 必须标 qualitative（挡在趋势与高低判定之外）`)
    assert.ok(!Number.isFinite(n.num), `${name} 不得产生数值（否则会被当 0 参与判定）`)
  }
  // 快照全量视角：不允许任何一行在「值非空」的前提下**被静默清空**
  // （唯一允许的是被显式标记 prose-dropped 的说明性短语，如 NT-proBNP 的「慢性心衰」）
  const orig = new Map(ALL_ROWS.map((r) => [`${r.name}|${r.measuredAt}`, r]))
  const silently = ALL_ROWS.map(normalizeRow).filter((n) => {
    const o = orig.get(`${n.nameRaw}|${n.measuredAt}`)
    // 允许两类「显式标记」的清空：prose-dropped（说明性短语）、note-dropped（解释文本行）。
    // 仍然禁止的是**静默**清空：清空了却没留任何标记。
    const marked = n.repaired.includes('prose-dropped') || n.repaired.includes('note-dropped')
    return o && String(o.value ?? '').trim() && !String(n.value ?? '').trim() && !marked
  })
  assert.deepEqual(silently.map((r) => r.name), [], `有值却被静默清空的行：${silently.map((r) => r.name).join('、')}`)
})

it('说明性短语仍必须清空：`慢性心衰` → 空值 + prose-dropped（原本要治的场景不能被放开）', () => {
  const n = normalizeRow({ name: '前体NT-proBNP', value: '慢性心衰' })
  assert.equal(n.value, '')
  assert.ok(n.repaired.includes('prose-dropped'))
  assert.ok(n.proseValue)
})

it('名称里粘连的结果 token 剥掉后必须能命中 code（否则第 1 页只能写「未录入」）', () => {
  const pairs = [
    ['乙肝表面抗原（H阴性（-）BsAg）', 'HBSAG'],
    ['丙型肝炎抗体（A阴性（-）nti-HCV）', 'ANTI_HCV'],
    ['艾滋病病毒抗体阴性（-）（Anti-HIV）', 'ANTI_HIV'],
    ['梅毒螺旋体特异阴性（-）性抗体测定（Anti-TP）', 'ANTI_TP'],
  ]
  for (const [raw, code] of pairs) {
    const cleaned = cleanName(raw)
    assert.equal(classifyAnalyte(cleaned, {}).code, code, `${raw} → ${cleaned} 未解析出 ${code}`)
  }
  // 兼容两种写法：全角「（-）」与半角「(-)」
  assert.equal(cleanName('乙肝表面抗原（H阴性(-)BsAg）'), '乙肝表面抗原（HBsAg）')
})

it('单位 OCR 归一：fI / f1 / fi → fL；wmol/L → umol/L（血小板平均体积曾因 fI 丢掉整条趋势）', () => {
  for (const raw of ['fI', 'f1', 'fi', 'FL', 'fl', 'f']) {
    assert.equal(normalizeUnitDisplay(raw), 'fL', `${raw} 应归一为 fL`)
  }
  assert.equal(normalizeUnitDisplay('wmol/L'), 'umol/L')
  // 端到端：refRange 里装的是单位 → 移回 unit 并归一（两条历史行单位必须一致）
  const a = normalizeRow({ name: '血小板平均体积', value: '8.3', refRange: 'fI' })
  const b = normalizeRow({ name: '血小板平均体积', value: '7.9', refRange: 'fl' })
  assert.equal(a.unit, 'fL'); assert.equal(b.unit, 'fL')
  assert.equal(a.refRange, ''); assert.equal(b.refRange, '')
})

it('单边参考区间不得被当「说明文字」清掉：<125 / ＜=15% / >450 必须原样保留', () => {
  // 事故链：若把 `<125` 判成说明文字清空 → judgeFlag 拿不到区间 → 3182（25.5× 上限）静默漏标
  for (const ref of ['<125', '<125pg/ml', '＜=15%', '>450', '>=4.0', '≤15']) {
    const n = normalizeRow({ name: '某项目', value: '1', refRange: ref })
    assert.equal(n.refRange, ref.trim(), `${ref} 被误清成「${n.refRange}」`)
    assert.ok(!n.refRangeNote, `${ref} 不该被记成 refRangeNote`)
  }
})

it('参考区间是注意事项文本 → 置空显示「—」，原值留痕（2026-11-14 用户口径）', () => {
  // 此前只剥掉 `*` 与顿号，留下 `Rh血型阴性`，与左列的「阳性」并排会被读成自相矛盾；
  // 用户口径：这是说明不是区间 → 参考列显示「—」，原文本留在 refRangeNote 供回查。
  const n = normalizeRow({ name: 'Rh（D）血型鉴定', value: '阳性', refRange: '*Rh血型阴性、' })
  assert.equal(n.refRange, '')
  assert.equal(n.refRangeNote, 'Rh血型阴性')   // 留痕的是去噪后的说明文本（`*` 与顿号已剥）
  // 纯定性参考值（阴性 / 阳性 / 正常）是**真参考**，不许一起清掉
  assert.equal(normalizeRow({ name: '乙肝表面抗原（HBsAg）', value: '阴性', refRange: '阴性' }).refRange, '阴性')
  // 数值区间照旧保留
  assert.equal(normalizeRow({ name: '白细胞计数', value: '3.27', refRange: '3.5-9.5' }).refRange, '3.5-9.5')
  assert.equal(normalizeRow({ name: '某项目', value: '1', refRange: '＊1.2-3.4，' }).refRange, '1.2-3.4')
  // 真区间不得被误伤
  assert.equal(normalizeRow({ name: '某项目', value: '1', refRange: '9.8-12.1' }).refRange, '9.8-12.1')
})

it('NT-proBNP 脏名必须被别名消灭（含「按年龄分层 + pg/ml 阈值」的说明文字不再当项目名）', () => {
  const dirty = ALL_ROWS.map(normalizeRow).filter((r) => r.nameDirty)
  assert.equal(dirty.length, 0, `快照里不应再有脏名，实际还有 ${dirty.length} 行：${dirty.map((r) => r.name.slice(0, 30)).join('、')}`)
  const bnp = ALL_ROWS.map(normalizeRow).filter((r) => r.name === '前体NT-proBNP')
  assert.ok(bnp.length > 0, '沾了参考说明的 NT-proBNP 行必须还原为「前体NT-proBNP」')
  assert.ok(bnp.every((r) => !/[<>]?\d+\.\d+pg\/ml|按年龄分层/.test(r.name)), '规范名里不得残留阈值说明')
  assert.ok(bnp.every((r) => r.repaired.includes('name-alias')), '别名归一必须留痕（name-alias）')
  // 阈值被说明文字污染：`<300pg/ml-非` → `<300`
  const th = bnp.find((r) => String(r.value).startsWith('<'))
  if (th) assert.equal(th.value, '<300', `阈值应清洗为 <300，实际 ${th.value}`)
})

it('NT-proBNP 归到标准码（心功能关键项，蒽环类化疗必看），不得落进「其他项」', () => {
  const codes = new Set(ALL_ROWS.map(normalizeRow).filter((r) => r.name === '前体NT-proBNP').map((r) => classifyAnalyte(r.name).code))
  assert.deepEqual([...codes], ['NT_PROBNP'], `NT-proBNP 的 code 应为 NT_PROBNP，实际 ${[...codes].join(',')}`)
  assert.equal(classifyAnalyte('前体NT-proBNP').cat, 'INFLAM', '应归入炎症/心功能组（与 NT-proBNP 同类），不得落 OTHER')
})

it('脏名仍要标出来（别名只覆盖已知形态）：未登记的多数字名称必须 nameDirty', () => {
  const out = normalizeRow({ name: '某某项目 12.3 45.6 说明文字', value: '1.2', num: 1.2 })
  assert.equal(out.nameDirty, true, '未登记的多数字名称必须标 nameDirty，不许静默当正常项')
})

// ---------------- 5. 串码防护（同名异轴项） ----------------
it('串码防护：MCH≠Hb、血气 Hct≠血常规 HCT、尿白细胞≠血白细胞、尿糖≠血糖、尿钙≠血钙、脑脊液糖≠血糖', () => {
  const code = (n) => classifyAnalyte(n).code
  assert.equal(code('红细胞平均血红蛋白含量'), 'MCH')
  assert.notEqual(code('红细胞平均血红蛋白含量'), 'Hb')
  assert.equal(code('血红蛋白'), 'Hb')
  assert.equal(code('Hct'), 'BG_HCT')
  assert.equal(code('红细胞比积'), 'HCT')
  assert.notEqual(code('Hct'), code('红细胞比积'))
  assert.equal(code('白细胞（LEU）'), 'U_LEU')
  assert.notEqual(code('白细胞（LEU）'), 'WBC')
  assert.equal(code('葡萄糖（glu）'), 'U_GLU')
  assert.equal(code('葡萄糖（GLU）'), 'GLU')
  assert.notEqual(code('葡萄糖（glu）'), code('葡萄糖（GLU）'))
  assert.equal(code('酮体（KET）'), 'U_KET')
  // 2026-11-14 只读体检建议 #10：再补高风险同名异轴（钙 / 糖 / 红细胞）
  //   —— 若归到同一个 code，趋势会把不同样本类型连成一条假曲线。
  //
  // ⚠️ 这里**故意用无条件断言**：初版写成 `if (caUrine) assert.notEqual(...)`，
  //    而 `尿钙` / `脑脊液葡萄糖` 目前根本没登记在 catalog（返回 null）→ 条件永远不成立 = 空转断言。
  //    无条件 `notEqual(null, 'CA')` 才是真守卫：将来谁把「尿钙」映射成血钙的 CA，这条立刻红。
  assert.equal(code('钙'), 'CA', '前提：血钙要能解析出 CA')
  assert.notEqual(code('尿钙'), 'CA', '尿钙不得与血钙同码（未登记时应落到 OTHER/空码，而不是 CA）')
  assert.notEqual(code('脑脊液葡萄糖'), 'GLU', '脑脊液葡萄糖不得与血糖同码')
  assert.notEqual(code('潜血（ERY）'), 'RBC', '尿潜血不得与血常规红细胞同码')
  assert.notEqual(code('潜血（ERY）'), 'Hb', '尿潜血不得与血红蛋白同码')
  assert.equal(code('红细胞'), 'RBC', '前提：血常规红细胞要能解析出 RBC')
})

it('名称归一：同一项的不同写法归到同一 code', () => {
  assert.equal(classifyAnalyte('白细胞计数').code, classifyAnalyte('白细胞').code)
  assert.equal(classifyAnalyte('中性粒细胞百分比').code, 'NEUT_PCT')
  assert.equal(classifyAnalyte('中性粒细胞计数').code, 'NEUT_ABS')
  assert.equal(classifyAnalyte('凝血酶原时间（PT）').code, 'PT')
  assert.equal(classifyAnalyte('纤维蛋白原（FBG）').code, 'FIB')
  assert.equal(classifyAnalyte('国际标准化比值（INR）').code, 'INR')
  assert.equal(classifyAnalyte('降钙素原（PCT）').code, 'PCT')
  assert.notEqual(classifyAnalyte('血小板压积').code, 'PCT') // 血小板压积不得占用降钙素原的 code
})

// ---------------- 6. 覆盖率不变量 ----------------
it('code 覆盖率 ≥ 99%（快照全量）：code 是去重/趋势/危急值的唯一键', () => {
  const noCode = [...new Set(ALL_ROWS.map(normalizeRow).filter((r) => !classifyAnalyte(r.name).code).map((r) => r.name))]
  const ratio = 1 - noCode.length / ALL_ROWS.length
  assert.ok(ratio >= 0.99, `覆盖率 ${(ratio * 100).toFixed(1)}%（应 ≥99%），未归类：${noCode.join('、')}`)
})

it('无 code 的残留行必须是「已标脏名」的行（不许悄悄漏进 OTHER 组当正常项）', () => {
  const silent = ALL_ROWS.map(normalizeRow)
    .filter((r) => !classifyAnalyte(r.name).code && !r.nameDirty)
    .map((r) => r.name)
  assert.deepEqual([...new Set(silent)], [], `这些行既无 code 又没标脏名（会静默进「其他项」）：${[...new Set(silent)].join('、')}`)
})

// ---------------- 7. 纯函数边界（不抛错、不乱判） ----------------
it('边界：空行/纯白字段不抛错，且不产生虚假修复', () => {
  assert.deepEqual(normalizeRow({}).repaired, [])
  assert.deepEqual(normalizeRow({ name: '', value: '', unit: '', refRange: '' }).repaired, [])
  assert.equal(isRange('10~9/L'), false)
  assert.equal(isUnitLike('10~9/L'), true, '`10~9/L` 是单位，不是区间（否则白细胞单位永远判不成）')
  assert.equal(isUnitLike('1.8-3.5'), false)
  assert.equal(extractNameValue('二氧化碳（CO2）'), '2')
  assert.equal(repairColumnShift({ name: 'pCO2', value: '1-2', refRange: 'mmHg' }), null, '`pCO2` 的 2 是项目名，不得当作被吞的真值')
})

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `化验行清洗：${pass} 通过 / 0 失败` : `化验行清洗：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
