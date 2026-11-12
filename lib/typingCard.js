// ===================== MedBrief 分型卡摘要轻量派生器 =====================
// 适用场景：MedBrief 问诊病历与标准交换包 Manifest 生成
// 零外部依赖，安全纯函数

export function buildTypingCard(state = {}, today = '') {
  const patientMeta = state.patientMeta || {}
  const diseaseMetrics = Array.isArray(state.diseaseMetrics) ? state.diseaseMetrics : []
  const docs = Array.isArray(state.docs) ? state.docs : []

  // 1. 分型/诊断文本推导
  let typingText = patientMeta.diagnosis || ''
  if (!typingText) {
    const diagDoc = docs.find((d) => d && (d.diagnosis || d.title?.includes('诊断')))
    if (diagDoc) typingText = diagDoc.diagnosis || diagDoc.title
  }
  // 无来源就不写诊断（旧实现在这里兜底 B-ALL，等于给没有诊断依据的病例安一个诊断）
  if (!typingText) typingText = ''

  // 2. 阶段与状态
  // 分期与治疗描述同样只能来自表单/报告，缺就留空（'维持治疗…' 是凭空断言）
  const stageLabel = patientMeta.stage || ''
  const stageDetail = patientMeta.stageDetail || ''

  // 3. 基因/免疫表型
  // ⚠️ 2026-11-12：不再编造基因型。旧实现在缺字段时写死「IKZF1 缺失 / CD19+ / CD22+」，
  // 导出包会把这些无来源的结论直接送到医生面前（代诊-报告指出）。缺就留空，由表单提供。
  // 本文件 MedData 是上游（INTERFACE.md §四），此改动需同步回 MedData 并跑其 pnpm test。
  const genes = Array.isArray(patientMeta.genes)
    ? patientMeta.genes.map((g) => ({ text: String(g) }))
    : []

  // 4. 就诊医院与发病时间
  const hospital = patientMeta.hospital || ''
  // 同上：起病时间不得默认成 2024-03（无来源的既往史）
  const onset = patientMeta.onset || ''

  return {
    typing: { text: typingText },
    stage: { label: stageLabel, detail: stageDetail },
    genes,
    hospital,
    onset: { text: onset },
    primaryMarker: diseaseMetrics[0]?.code || '',
  }
}
