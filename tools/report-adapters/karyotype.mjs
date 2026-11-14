// 适配器 · 染色体核型分析报告单（细胞遗传学，全文型）
//
// 2026-11-12 第二份真实样本：与库内流式报告同病人 / 同条码 / 同送检实验室，但版式完全不同。
// 关键取舍（用户拍板「只转录抬头 + 全文回查」）：
//   - 核型公式（`46,XX,t(9;22)(q34;q11.2)[2]/…`）、结果描述、结果解释、检测结论都是**自由文本**，
//     不拆成「指标行」，也不把 `[2]/[5]/[13]` 之类的细胞数硬算成百分比（那就是编造临床事实）；
//   - 全文完整进 report.text 可回查，故 rows = [] 是**合法结果**，不是解析失败；
//   - CLI 只对 `textOnly: true` 放宽「0 行 = 失败」红线，其它版式照旧拦住（退出码 3）。
//
// 红线：报告没有「报告日期」，用采样时间兜底并留痕（pickReportDate）；身份类字段（身份证/电话/住址）不收。

import { parseHeadFields, pickReportDate } from './shared.mjs'

export const REPORT_TYPE = 'KARYOTYPE' // 报告类型机读名，见 docs/字段字典.md §二

const KARYOTYPE_RE = /46\s*,\s*(?:XX|XY)|\bISCN\s*20\d{2}\b|t\(\d+\s*;\s*\d+\)/i

export default {
  id: 'karyotype',
  title: '染色体核型分析报告单（全文型）',

  match(text = '') {
    const t = String(text)
    if (/染色体核型分析报告单|Chromosome\s*Karyotype/i.test(t)) return 1
    if (/ISCN\s*20\d{2}/i.test(t) && /核型|染色体|karyotype/i.test(t)) return 0.8
    return 0
  },

  parse({ text = '' } = {}) {
    const fields = parseHeadFields(text)
    const { reportDate, sampledAt, receivedAt, warnings } = pickReportDate(text, fields)
    warnings.push('核型公式 / 结果描述 / 结果解释 / 检测结论为自由文本，不字段化；全文见 report.text')
    if (!KARYOTYPE_RE.test(String(text))) warnings.push('未读到核型公式正文（如 46,XX…），请核对 PDF 文本层或改走 8008 OCR')
    if (!fields['姓名']) warnings.push('姓名未读到')

    // 抬头是「标签(EN)：值」双栏表单，解析能力来自 shared.mjs（与流式/通用化验单同一套）
    const labName = (String(text).match(/^\s*([^\s]{2,24}(?:医学检验实验室|检验实验室|实验室))[ \t]*$/m) || [])[1] || ''
    return {
      textOnly: true, // CLI 读这个：0 行是设计结果，不是失败
      meta: {
        kind: 'pathology',
        reportType: REPORT_TYPE,
        textOnly: true, // 服务端读这个：rows 为空时不许回退 parseLabRows 把表头当指标
        reportDate,
        sampledAt,
        receivedAt,
        hospital: fields['就诊医院'] || '',
        labName,
        barcode: fields['检测条码'] || '',
        clinicalDiagnosis: fields['临床诊断'] || '',
        patientName: fields['姓名'] || '',
        patientSex: String(fields['性别'] || '').replace(/[^男女]/g, '').slice(0, 1),
        patientAge: String(fields['年龄'] || '').replace(/岁$/, ''),
        department: fields['科别'] || '',
        specimen: fields['标本类型'] || '',
        attending: fields['医生'] || '',
        method: fields['检测方法'] || '',
        equipment: fields['检测设备'] || '',
      },
      rows: [],
      warnings,
    }
  },
}
