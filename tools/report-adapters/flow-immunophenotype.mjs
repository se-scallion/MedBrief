// 适配器 · 血液肿瘤免疫分型报告单（流式细胞术，骨髓）
//
// 首个真实样本：康圣达（乌鲁木齐）/ 海思特（北京）版式，条码 V02008911352，2026-07-17。
// 版式特征：抬头是「标签(EN)：值」的表单格；正文分三段 —— 抗原清单 / CD45-SSC 各群细胞占有核细胞比例 /
// CD34+ 占比 + 印象 + 结论。每行叠「姓名首字 + 条码」水印（由 index.mjs 的 stripWatermarkTokens 去掉）。
//
// 只做事实转录（红线见 tools/report-adapters/index.mjs 文件头）：
//   1. 各群细胞比例按**原文名**入库（`异常细胞占有核细胞比例`），不改写成「原始细胞/骨髓原始细胞」；
//   2. 流式报告没有参考区间 → refRange 空、status 'unknown'，不判高低；
//   3. 印象/结论/抗原清单**不做字段化**（自由文本，字段级结构化是延后项，见 docs/报告导入流程.md）：
//      它们完整留在 report.text 里可回查。

import { classifyAnalyte } from '../../lib/reportIntake.mjs'
import { stripWatermarkTokens, parseHeadFields, pickReportDate, dateOnly } from './shared.mjs'

export const REPORT_TYPE = 'FLOW_CYTOMETRY' // 与 MedData diseaseIngest 的 FLOW_TYPE_RE 对齐

// 抬头解析（「标签(EN)：值」/ 报告日期兜底）已下沉 shared.mjs：核型报告与通用化验单复用同一套，
// 不再每个适配器各写一份正则（2026-11-12 实测：兜底不认双语标签导致姓名/院名/日期全丢）。

// CD45-SSC 各群：`淋巴细胞(绿色) Lymphocyte(Green) 2.19%`
const POP_RE = /^(淋巴细胞|单核细胞|粒细胞|异常细胞|有核红细胞)\s*[(（][^)）]*[)）].*?(\d+(?:\.\d+)?)\s*[%％]\s*$/
// CD34+：`CD34+细胞占有核细胞比例（CD34+ Cells Proportion in Nuclear Cells）：84.42 ％`
const CD34_RE = /CD34\+\s*细胞占有核细胞比例.*?[：:]\s*(\d+(?:\.\d+)?)\s*[%％]/

function makeRow({ name, value, snippet, measuredAt, reportDate, analyte = null }) {
  const code = classifyAnalyte(name).code || ''
  const num = Number(String(value).replace(/[^\d.]/g, ''))
  return {
    name,
    originalName: name, // MedData data_points 的 original_name：报告原文名
    code,
    value: String(value),
    num: Number.isFinite(num) ? num : null,
    unit: '%',
    refRange: '', // 流式报告不给参考区间 —— 不许编
    flag: '',
    status: 'unknown', // 无参考区间 → 不判高低
    measuredAt,
    reportDate,
    stream: 'fcm', // 与 MedData STREAMS.fcm 对齐
    analyte,
    qualifier: 'eq',
    rawSnippet: snippet,
  }
}

export default {
  id: 'flow-immunophenotype',
  title: '血液肿瘤免疫分型报告单（流式细胞术）',

  match(text = '') {
    const t = String(text)
    if (/血液肿瘤免疫分型报告单|Hematological\s*Tumor\s*Immunotype\s*Report/i.test(t)) return 1
    if (/流式细胞术/.test(t) && /CD45\s*[-/]?\s*SSC|CD45-SSC圈门|各群细胞占有核细胞比例/.test(t)) return 0.8
    return 0
  },

  parse({ text = '' } = {}) {
    const lines = stripWatermarkTokens(String(text).split(/\r?\n/)).map((l) => l.trim()).filter(Boolean)
    const fields = parseHeadFields(text)
    const { reportDate, sampledAt, receivedAt, warnings } = pickReportDate(text, fields)
    const measuredAt = dateOnly(sampledAt) || reportDate

    const labName = (String(text).match(/主检实验室\s*[:：]\s*([^\s]+)/) || [])[1] || ''

    const rows = []
    for (const line of lines) {
      const pop = line.match(POP_RE)
      if (pop) {
        rows.push(makeRow({
          name: `${pop[1]}占有核细胞比例`,
          value: pop[2],
          snippet: line,
          measuredAt,
          reportDate,
        }))
        continue
      }
      const cd34 = line.match(CD34_RE)
      if (cd34) {
        rows.push(makeRow({
          name: 'CD34+细胞占有核细胞比例',
          value: cd34[1],
          snippet: line,
          measuredAt,
          reportDate,
          analyte: 'CD34',
        }))
      }
    }
    // 稳定顺序：异常细胞（疾病定义项）→ CD34+ → 其余各群按原文出现顺序
    const rank = (n) => (/^异常细胞/.test(n) ? 0 : /^CD34/.test(n) ? 1 : 2)
    rows.sort((a, b) => rank(a.name) - rank(b.name))

    if (!rows.length) warnings.push('未解析出任何比例行：请检查是否文本层缺失（扫描件需先走 8008 OCR）')
    if (!fields['姓名']) warnings.push('姓名未读到')
    if (!fields['检测条码']) warnings.push('检测条码未读到')

    return {
      meta: {
        kind: 'pathology',
        reportType: REPORT_TYPE,
        reportDate,
        sampledAt: sampledAt || '',
        receivedAt: receivedAt || '',
        hospital: fields['就诊医院'] || '',
        labName,
        barcode: fields['检测条码'] || '',
        clinicalDiagnosis: fields['临床诊断'] || '',
        patientName: fields['姓名'] || '',
        patientSex: fields['性别'] || '',
        patientAge: (fields['年龄'] || '').replace(/岁$/, ''),
        department: fields['科别'] || '',
        specimen: fields['标本类型'] || '',
        attending: fields['医生'] || '',
        method: fields['检测方法'] || '',
        equipment: fields['检测设备'] || '',
      },
      rows,
      warnings,
    }
  },
}
