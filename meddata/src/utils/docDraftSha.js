// ===================== 「从 AI 任务恢复草稿」时的原件哈希口径（纯函数）=====================
// 为什么单抽一层：归档查重有两路通道（src/utils/docDup.js），通道 0「原件字节哈希」是最可靠的一路，
// 而它完全依赖草稿身上有没有 sha。任务恢复的草稿（?task=）原来只信**任务请求里带的 sha256**：
// 请求没带（脚本直发的任务 / 早期任务）→ 草稿 sha 为空 → 通道 0 静默关死，只剩
// 「date + doc_type + 文件名」三项兜底 —— 而 AI 的措辞和导入时的文件名本来就常变。
//
// 2026-10-27 实测（用户报 AI 任务 #yfzq8）：同一份 CT 图（sha256 与已归档 `d_1788687658167_rib9a`
// 完全相同）因为 sha 为空 + doc_type 写成「胸部CT平扫」（归档记「CT」）+ 文件名 source.jpg
// （归档记 8411788683842_.pic.jpg），三项全不等 → 页面不报重复，用户填完一屏才在点保存时被拦。
//
// 口径（顺序不可颠倒）：
//   ① 任务请求里带了 sha256 → 直接用它（服务端权威、零开销）；
//   ② 没带但有原件 → **对原件字节现算**（原图既然已经在手里，就没有理由放弃字节通道）；
//   ③ 没有原件（doc-text 任务 / 副本已清）→ 空串，交给三项兜底（UI 需说明是弱匹配）。
// 注：不在这里做「回填到任务请求」——草稿是只读视图，写回属于服务端职责。
/**
 * @param {{requestSha?: string, file?: File|null, fingerprint?: (f: File) => Promise<string>}} p
 * @returns {Promise<string>} 小写 sha256 或空串
 */
export async function resolveDraftSha({ requestSha, file, fingerprint } = {}) {
  const given = String(requestSha || '').trim()
  if (given) return given
  if (!file) return ''
  if (typeof fingerprint !== 'function') return ''
  try {
    const h = await fingerprint(file)
    return String(h || '').trim()
  } catch {
    return ''
  }
}
