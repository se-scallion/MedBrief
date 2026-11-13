// ===================== 化验转录（mode:'lab'）产物 → 校对网格 =====================
// 为什么要单独一层：同一份 agent 产物（done.rows = [名称, 结果, 参考, 单位] 二维数组）
// 有三个消费方 —— ① 检验报告导入页的 AI 精读引擎（ocrEngines.js）；
// ② 从「AI 任务」点「继续导入」回来的化验草稿（ImportFlow.jsx）；
// ③ 任务中心「查看结果」弹层（AiTaskCenter.jsx）。
// 三处各写一份表头规则，必然漂移成「同一个任务在这里丢首行、在那里不丢」（Bug 221 复现现场）。
//
// 契约：agent 首行应输出表头 ["项目名称","结果值","参考范围","单位"]，但模型常漏输出。
// normalizeGridToPoints 对「无表头网格」会把第 0 行当表头丢弃 → 首个真实数据行被静默漏掉
// （复现：骨髓形态学「原始粒细胞-骨髓片 / MYELOBLAST_MF」整行丢失）。
// 故统一归一：agent 已带表头就丢弃它，再前置规范表头，保证首行数据永不丢失。
// 纯函数模块（不引用任何浏览器 API），供 scripts/verify-agent-rows.mjs 直接单测。

export const AGENT_ROWS_HEADER = ['项目名称', '结果值', '参考范围', '单位']

// 首行是不是 agent 自己输出的表头（"项目名称/结果值" 的各种写法）
export function isAgentHeaderRow(row) {
  return (
    /项目|名称|检验项目|指标/.test(String(row?.[0] ?? '')) && /结果|数值|测定值|检测值/.test(String(row?.[1] ?? ''))
  )
}

// 去掉 agent 表头后的数据行（无表头则原样返回）
export function agentBodyRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.length && isAgentHeaderRow(list[0]) ? list.slice(1) : list
}

// rows → 5 列 grid（第 5 列 arrow 留空：箭头已在结果值尾部）
export function rowsToGrid(rows) {
  return [AGENT_ROWS_HEADER, ...agentBodyRows(rows)].map((r) => [
    String(r?.[0] ?? ''),
    String(r?.[1] ?? ''),
    String(r?.[2] ?? ''),
    String(r?.[3] ?? ''),
    '',
  ])
}

// 流式图文报告（C 类口径）的正文：agent 另带 narrative{antigens,impression,conclusion,footnote}。
// 五段全空视为未给（宁缺勿脏）——字段缺失绝不臆造。
export function narrativeFromDone(done) {
  const nar = done && done.narrative && typeof done.narrative === 'object' ? done.narrative : null
  if (!nar) return null
  const pick = (k) => String(nar[k] || '').trim()
  const out = {
    antigens: pick('antigens'),
    impression: pick('impression'),
    conclusion: pick('conclusion'),
    footnote: pick('footnote'),
  }
  return Object.values(out).some(Boolean) ? out : null
}
