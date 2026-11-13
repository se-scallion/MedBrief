// ===================== 流式图文报告「报告原文」拼装 =====================
// 2026-10-28 用户口径（两次拍板，最终版）：
//   ① 报告里的文字要留档（不只一行 MRD）：抬头、所检测抗原清单、印象、结论、注；
//   ② **不要**在正文里写「本地 OCR 转录，机器误识未校」这类免责句 —— 由 UI 区块标题承载「机器转录」这层语义；
//   ③ 患者身份与重复信息**一律不收**（姓名/性别/年龄/条码/住院号/床号/病历号/病案号/门诊号/标本类型/科室），
//      理由：既重复（已在 date/time/specimen/report_type 等结构化字段里）又敏感（项目脱敏口径见
//      src/utils/typingCard.js「不输出住院号/证件号」）；
//   ④ 落点是**化验记录的新字段 `report_text`（可编辑，编辑后打 report_text_edited 标记）**，不是「临床备注」：
//      备注会随导出/Prompt 提供给 AI（DataGrid.jsx 的标签明写），是用户手写语义，不能被机器全文污染；
//   ⑤ 仍**不**归档成检查报告实体：同一原件在 docs 与 records 各一份会制造跨实体同源重复（见 bugs.md Bug 204）。

/** 段落顺序固定：所检测抗原 → 印象 → 结论 → 注（抬头标题不收，2026-10-28 用户要求） */
const SECTION_LABELS = [
  { key: 'antigens', label: '所检测抗原：' },
  { key: 'impression', label: '印象：' },
  { key: 'conclusion', label: '结论：' },
  { key: 'footnote', label: '' },
]

/**
 * 把结构化正文拼成「报告原文」纯文本（本地通道与 AI 通道共用同一形状）。
 * - 各段为空则跳过；全空返回 ''（宁缺勿脏，绝不写占位文本）
 * - 段间空行分隔；不给段落加任何免责声明
 * @param {{antigens?:string,impression?:string,conclusion?:string,footnote?:string}|null} report
 * @returns {string}
 */
export function composeReportText(report) {
  if (!report || typeof report !== 'object') return ''
  const blocks = []
  for (const { key, label } of SECTION_LABELS) {
    const body = String(report[key] || '').trim()
    if (!body) continue
    // 原文若已自带同名标签（如「注: …」）就不再重复加；否则补上字段名（报告本来就是这么写的）
    blocks.push(label && !body.startsWith(label.slice(0, -1)) ? label + body : body)
  }
  return blocks.join('\n\n')
}

/** 报告原文是否含任何内容（供 UI 决定是否渲染区块） */
export function hasReportText(text) {
  return String(text || '').trim().length > 0
}
