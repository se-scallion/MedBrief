// ===================== 记录写入决策（纯函数，零 store / 零 DOM） =====================
// 为什么单独抽出来（2026-10-29 数据丢失事故）：
// 用户校对一份血常规后点保存，界面提示成功、feedback 也落了盘，但**库里根本没有这条记录**
// （本地 IndexedDB 与服务端 records 两边都查不到，也没有墓碑 → 不是"存了又删"）。
// 根因在 store.js 的 writeRecord：它对「覆盖已有记录」的实现是
//   records.map(r => r.id === id ? merge(r, patch) : r)
// —— id 不在 records 里时 map 不命中，**什么也不写、不报错、调用方照常提示成功**。
// 覆盖目标可能因并发删除 / 同步回滚 / 候选 id 过期而不存在，此时正确行为是**回退为新增**，
// 并且必须把「到底发生了哪种写入」回传给调用方做提示与回读校验。
export const WRITE_REPLACE = 'replace' // 目标 id 存在 → 覆盖（保留用户手动编辑字段）
export const WRITE_APPEND = 'append' // 目标 id 不存在 → 回退新增，绝不静默丢弃

/**
 * 决定一次「写回已有记录」到底是覆盖还是新增。
 * @param {Array<{id:string}>} records 当前记录列表
 * @param {{id?:string}} target 调用方想覆盖的记录 id
 * @returns {{action:'replace'|'append', id:string|null}} id 为 replace 时的目标 id；append 时为 null
 */
export function planRecordWrite(records, target = {}) {
  const id = target && typeof target.id === 'string' ? target.id.trim() : ''
  const list = Array.isArray(records) ? records : []
  // append 分支必须由调用方生成新 id：沿用旧 id 会与被墓碑的 id 冲突，同步时可能被判"复活已删实体"
  if (!id) return { action: WRITE_APPEND, id: null }
  return list.some((r) => r && r.id === id) ? { action: WRITE_REPLACE, id } : { action: WRITE_APPEND, id: null }
}

/**
 * 写入结果是否可视为成功：调用方保存后必须回读校验（见 ImportFlow.commitSave），
 * 不能只看"函数没抛错"——这正是本次事故里"提示成功但没入库"的来源。
 * @param {{ok?:boolean, id?:string|null}} result
 * @param {Array<{id:string}>} records 写入后的记录列表
 */
export function isWritePersisted(result, records) {
  const id = result && typeof result.id === 'string' ? result.id : ''
  if (!id) return false
  return (Array.isArray(records) ? records : []).some((r) => r && r.id === id)
}
