// 适配器 · 通用化验单（兜底）
//
// 任何「项目名 结果 单位 参考区间」的表格型化验单都走这里：解析完全复用 lib/reportIntake.mjs 的
// parseLabRows（双栏切分 / 序号插值 / 单位规范化 / 参考区间判定 / 逐行可信度闸门都是它的事）。
// 它永远是最后一个适配器（match 恒为 0.1），保证「认不出的版式」也有兜底，而不是直接失败。
//
// 2026-11-12 实测修正：康圣达系报告的抬头是「标签(EN)：值」，旧版这里用 `标签\s*[：:]?` 抓不到，
// 姓名/院名/采样时间全丢；且 `检测结果(ISCN 2024)` 被解析成 1 行假指标（退出码 0 → 会写脏库）。
// 现在抬头复用 shared.mjs，整份再用 assessLabRows 判「这到底是不是化验表格」。

import { parseLabRowsDetailed } from '../../lib/reportIntake.mjs'
import { stripWatermarkTokens, parseHeadFields, pickReportDate, assessLabRows } from './shared.mjs'

export default {
  id: 'lab-panel',
  title: '通用化验单（兜底）',

  match() {
    return 0.1 // 兜底：任何文本都给 0.1，只要前面有更具体的适配器命中就不会走到这里
  },

  parse({ text = '' } = {}) {
    const cleaned = stripWatermarkTokens(String(text).split(/\r?\n/)).join('\n')
    const { rows: rawRows, droppedLines } = parseLabRowsDetailed(cleaned)
    const verdict = assessLabRows(rawRows)
    const rows = verdict.rows.map((r) => ({
      ...r,
      originalName: r.originalName || r.name,
      rawSnippet: r.rawSnippet || '',
    }))

    const fields = parseHeadFields(text)
    const { reportDate, sampledAt, receivedAt, warnings } = pickReportDate(text, fields)
    if (droppedLines.length) {
      warnings.push(`可信度闸门丢掉 ${droppedLines.length} 行疑似版式文字：${droppedLines.slice(0, 2).join(' / ')}`)
    }
    if (!verdict.plausible) warnings.push(`疑似非化验版式：${verdict.reason} —— 需要为该版式新增适配器`)
    if (!rows.length) warnings.push('未解析出指标行（版式可能不是「名称+数值+参考区间」表格，需要为该版式新增适配器）')

    // 中文无括号标签的兜底（`姓名 某某` / `医院：某医院`），双语标签优先（parseHeadFields 已给出）。
    const grab = (label) => {
      const m = cleaned.match(new RegExp(`${label}\\s*[：:]?\\s*([^\\s，,；;、|]{1,20})`))
      return m ? m[1] : ''
    }
    const rawName = fields['姓名'] || grab('姓名')
    const rawSex = fields['性别'] || grab('性别')
    const rawAge = fields['年龄'] || grab('年龄')

    return {
      meta: {
        kind: 'lab',
        reportType: 'LAB_PANEL',
        reportDate,
        sampledAt,
        receivedAt,
        // 医院必须「带冒号的明确标签」才认：裸词 `医院` 会把「某医院检验科」的「检验科」抓成院名（实测踩过）
        hospital: fields['就诊医院'] || (cleaned.match(/(?:送检医院|就诊医院|医院名称|医院)\s*[：:]\s*([^\s，,；;、|]{2,20})/) || [])[1] || '',
        labName: '',
        barcode: fields['检测条码'] || '',
        clinicalDiagnosis: fields['临床诊断'] || '',
        patientName: /^[\u4e00-\u9fa5]{2,4}$/.test(rawName) ? rawName : '',
        patientSex: /男|女/.test(rawSex) ? rawSex.replace(/[^男女]/g, '').slice(0, 1) : '',
        patientAge: String(rawAge).replace(/岁$/, ''),
        department: fields['科别'] || '',
        specimen: fields['标本类型'] || '',
        attending: fields['医生'] || '',
      },
      rows,
      warnings,
    }
  },
}
