// ===================== 校对会话操作记录（Operation Log） =====================
// 为什么需要：反馈 JSON 原本只有「最终 diff」，看不出用户是**怎么**操作的——
//   是先删行再改值、还是点了一键修正、解析时粘进去的是什么、有没有点过重新匹配。
//   同为「代码被清空」，可能是算法漏识别，也可能是用户手滑清掉，只有操作记录能区分。
// 设计取舍（简化）：
//   · 只记结构性操作（面板/按钮/增删行/排序/保存），不记鼠标移动等噪声；
//   · 单元格编辑按「同一行 + 同一字段」合并：输入框是受控的，敲一个字符就触发一次
//     updatePoint，不合并会把一次改名拆成十几条、把反馈 JSON 撑爆。合并后保留
//     首值(from)、末值(to) 与次数(n)，信息不丢；
//   · 模块级单例（DataGrid 埋点 → ImportFlow 保存时读取），保存/重新识别时清空。
// 输出：feedback.operations = [{ i, t(HH:MM:SS), op, ...detail }]，按发生顺序排列。

const MAX_OPS = 300

let ops = []
let seq = 0

const now = () => new Date().toTimeString().slice(0, 8) // HH:MM:SS

export function pushOp(op, detail = {}) {
  const last = ops[ops.length - 1]
  // 连续编辑同一行同一字段 → 合并（保留首次改动前的值，更新末值与次数）
  if (op === 'edit-field' && last && last.op === 'edit-field' && last.row === detail.row && last.field === detail.field) {
    last.to = detail.to
    last.t = now()
    last.n = (last.n || 1) + 1
    return last
  }
  const rec = { i: ++seq, t: now(), op, ...detail }
  ops.push(rec)
  if (ops.length > MAX_OPS) ops = ops.slice(-MAX_OPS)
  return rec
}

export const getOps = () => ops.map((o) => ({ ...o }))

export const clearOps = () => {
  ops = []
  seq = 0
}
