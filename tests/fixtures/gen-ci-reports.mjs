#!/usr/bin/env node
// CI 专用合成数据：生成一份「形状与真实 reports.json 一致、内容全是假数据」的夹具。
//
// 为什么需要它：data/reports.json 被 .gitignore 排除（真实病历），而
//   tests/verify-auth.mjs / verify-card-inject.mjs / verify-card-mobile-layout.mjs
// 都会 `copyFileSync(ROOT/data/reports.json, ...)`。干净 clone 里这个文件不存在 ⇒ 三个门禁直接崩。
//
// 取值全是编造（医院/医生/患者名/数值都不是真人真值）。判定为「合成」：
//   1) 医院名固定「合成数据医院」、患者名固定「测试甲…」、barcode 固定 CI 前缀
//   2) 不读任何真实文件、不含随机源（同一版本永远产出同一份字节）
//
// 覆盖门禁所需的形状：
//   - ≥2 份报告（verify-card-inject 用 reports[1] 做「第二个人」）
//   - 12 个检验指标 × 6 份报告（趋势需要同一指标出现 ≥2 次；3 个指标含「血红」供 L17c 搜索断言）
// 用法：node tests/fixtures/gen-ci-reports.mjs > data/reports.json
const INDICATORS = [
  // [显示名, 代码, 单位, 基准值, 参考范围]
  ['血红蛋白', 'Hb', 'g/L', 132, '115-150'],
  ['红细胞平均血红蛋白含量', 'MCH', 'pg', 29.4, '27-34'],
  ['红细胞平均血红蛋白浓度', 'MCHC', 'g/L', 330, '316-354'],
  ['红细胞计数', 'RBC', '10^12/L', 4.42, '3.8-5.1'],
  ['白细胞计数', 'WBC', '10^9/L', 6.1, '3.5-9.5'],
  ['血小板计数', 'PLT', '10^9/L', 213, '125-350'],
  ['中性粒细胞百分比', 'NEUT%', '%', 58.2, '40-75'],
  ['谷丙转氨酶', 'ALT', 'U/L', 22, '7-40'],
  ['肌酐', 'CREA', 'umol/L', 71, '41-111'],
  ['空腹血糖', 'GLU', 'mmol/L', 5.2, '3.9-6.1'],
  ['总胆固醇', 'TC', 'mmol/L', 4.3, '2.8-5.2'],
  ['甘油三酯', 'TG', 'mmol/L', 1.2, '0.56-1.7'],
  // 以下 5 项是 cardPolicy.REQUIRED_BASICS 的「基本项」，缺失会在卡面挂缺项告警（推低趋势卡）
  ['中性粒细胞绝对值', 'NEUT_ABS', '10^9/L', 3.6, '1.8-6.3'],
  ['凝血酶原时间', 'PT', 's', 12.1, '11-14.5'],
  ['活化部分凝血活酶时间', 'APTT', 's', 29.5, '26-40'],
  ['纤维蛋白原', 'FIB', 'g/L', 2.8, '2-4'],
  ['乳酸脱氢酶', 'LDH', 'U/L', 186, '120-250'],
]

// 必须带异常行：卡面「总览」tab 的表格只渲染 p0（异常/危急），全 normal 会让表格空 ⇒
// tests/verify-card-mobile-layout.mjs 点「首行」直接超时（本地跑真实数据时不会暴露这一点）。
// key = 指标代码，value = [第几份报告下标, 异常值]
// 注意：必须落在**最后一份报告**（下标 5）——卡面 ② 核心异常项（p0rows）只取每项最近一次，
// 异常放在历史报告里 p0 仍为空（首版夹具就是这么错的）。
const ABNORMAL = {
  Hb: [5, 98],     // 最近一次偏低
  TG: [2, 2.4],    // 历史某次偏高（验证趋势里也有异常点）
}

const REPORTS = 6
const reports = []
for (let i = 0; i < REPORTS; i++) {
  // 日期必须贴近「今天」（2026-11-17），否则卡面会挂一条「数据陈旧 237 天」的告警横幅，
  // 把趋势卡整体推下首屏（L17a 因此假红）。真实数据也是最近日期。
  const day = String(2 + i * 3).padStart(2, '0')
  const date = `2026-11-${day}`
  const id = `rep_ci_${String(i + 1).padStart(2, '0')}`
  const rows = INDICATORS.map(([name, code, unit, base, refRange], j) => {
    // 确定性漂移：不同报告同一指标有小幅变化，避免曲线是直线
    let num = Number((base * (1 + ((i % 3) - 1) * 0.03) + (j % 5) * 0.1).toFixed(2))
    let status = 'normal'
    let flag = ''
    const ab = ABNORMAL[code]
    if (ab && ab[0] === i) {
      num = ab[1]
      status = num < base ? 'low' : 'high'
      flag = num < base ? '↓' : '↑'
    }
    return {
      name,
      originalName: name,
      code,
      value: String(num),
      num,
      unit,
      refRange,
      flag,
      status,
      measuredAt: date,
      reportDate: date,
      stream: 'lab',
      analyte: name,
      qualifier: 'eq',
      rawSnippet: `${name} ${num} ${unit} [合成数据]`,
    }
  })
  reports.push({
    id,
    createdAt: `${date}T03:00:00.000Z`,
    sha256: `ci-synthetic-sha256-${id}`,
    dhash: '',
    fingerprint: `ci-synthetic-fingerprint-${id}`,
    kind: 'lab',
    reportType: '血常规',
    reportDate: date,
    hospital: '合成数据医院',
    labName: '合成数据检验科',
    barcode: `CI${String(i + 1).padStart(4, '0')}`,
    sampledAt: `${date} 08:00`,
    receivedAt: `${date} 09:00`,
    clinicalDiagnosis: '（合成数据，无临床含义）',
    patientName: ['测试甲', '测试乙', '测试丙', '测试丁', '测试戊', '测试己'][i],
    sourceFile: `ci-synthetic://${id}.pdf`,
    imageRef: '',
    text: `合成数据 ${id} 测试${i + 1} 份报告，全部指标均为编造数值，仅用于 CI 门禁。`,
    rows,
    sourceBlobs: [],
    patchedAt: null,
    patchedFields: [],
    patchLog: [],
  })
}

// 白血病「核心资料」四类：缺任一类，卡面会挂一条 ~167px 的缺项告警，把趋势卡整体推下首屏
// （L17a 因此假红）。真实数据里这四类报告是有的，夹具必须同样具备。
const CORE_DOCS = [
  ['骨髓形态学报告', 'pathology', [['骨髓增生程度', '增生明显活跃'], ['原始细胞比例', '0.62']]],
  ['流式免疫分型报告', 'pathology', [['异常细胞占有核细胞比例', '85.76']]],
  ['融合基因检测', 'genetic', [['BCR::ABL1（P190型）', '阳性']]],
  ['染色体核型分析', 'genetic', [['核型', '46,XY,t(9;22)']]],
]
CORE_DOCS.forEach(([reportType, kind, pair], k) => {
  const date = `2026-11-${String(9 + k).padStart(2, '0')}`
  const id = `rep_ci_doc_${k + 1}`
  reports.push({
    id, createdAt: `${date}T03:00:00.000Z`, sha256: `ci-synthetic-sha256-${id}`, dhash: '',
    fingerprint: `ci-synthetic-fingerprint-${id}`, kind, reportType, reportDate: date,
    hospital: '合成数据医院', labName: '合成数据检验科', barcode: `CIDOC${k + 1}`,
    sampledAt: `${date} 08:00`, receivedAt: `${date} 09:00`,
    clinicalDiagnosis: '（合成数据，无临床含义）', patientName: '测试甲',
    sourceFile: `ci-synthetic://${id}.pdf`, imageRef: '',
    text: `合成数据 ${reportType}（编造内容，仅用于 CI 门禁）`,
    rows: pair.map(([name, value]) => ({
      name, originalName: name, code: '', value, num: Number(value) || null, unit: '',
      refRange: '', flag: '', status: 'unknown', measuredAt: date, reportDate: date,
      stream: 'doc', analyte: name, qualifier: 'eq', rawSnippet: `${name} ${value} [合成数据]`,
    })),
    sourceBlobs: [], patchedAt: null, patchedFields: [], patchLog: [],
  })
})

const out = { version: 1, reports, trashed: [], audit: [] }
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
