// MedBrief · 视觉 OCR 版式重建（表格行还原）
//
// 为什么需要这一层（2026-11-12 实测）：
//   本机 8008 的 macOS Vision 把表格按**列**逐块返回，`blocks[].text` 拼起来的顺序是
//   「项目名称 结果 单位 … 白细胞计数 WBC 血红蛋白 HGB … 6.83 92 68 0.42 …」，
//   即**同一列的项目名先全部返回，数值在后**。直接喂给按行解析的 `parseLabRows()` 只能出 1 行垃圾数据
//   （11 项化验单实测：解析出 1 行，且是「医院名 + 样本号」）。
//
// 解法：Vision 的每个 block 带归一化 `boundingBox{x,y,width,height}`（y 向下）。
//   1) 按 y 中心聚类成「行带」；2) 行带内按 x 排序；3) 行带内按间距是否接近列边界决定分隔；
//   4) 输出「项目 结果 单位 参考区间 提示」形态的文本行，交给既有 parseLabRows 解析。
//
// 纯函数、零依赖，便于单测。

/**
 * 把 Vision blocks 按 y 中心聚类成行。
 * @param {Array} blocks [{text, boundingBox:{x,y,width,height}, confidence}]
 * @param {object} opts
 * @param {number} opts.yTolerance 行判定容差（占图高的比例），默认 0.008（约 1% 图高）
 * @returns {Array<Array<block>>} 每行内按 x 升序
 */
export function groupBlocksIntoRows(blocks = [], { yTolerance = 0.008 } = {}) {
  const items = (blocks || [])
    .filter((b) => b && typeof b.text === 'string' && b.text.trim() && b.boundingBox)
    .map((b) => {
      const bb = b.boundingBox
      return {
        text: b.text.trim(),
        x: Number(bb.x) || 0,
        y: Number(bb.y) || 0,
        w: Number(bb.width) || 0,
        h: Number(bb.height) || 0,
        cx: (Number(bb.x) || 0) + (Number(bb.width) || 0) / 2,
        cy: (Number(bb.y) || 0) + (Number(bb.height) || 0) / 2,
        confidence: typeof b.confidence === 'number' ? b.confidence : null,
      }
    })
    // Vision 的 y 轴向上（原点在左下）：y 越大越靠上，所以按 cy 降序 = 页面从上到下
    .sort((a, b) => b.cy - a.cy || a.x - b.x)

  const rows = []
  for (const it of items) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(it.cy - last.cy) <= yTolerance) {
      last.items.push(it)
      last.cy = (last.cy * (last.items.length - 1) + it.cy) / last.items.length
    } else {
      rows.push({ cy: it.cy, items: [it] })
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x)
  return rows.map((r) => r.items)
}

/**
 * 行内块合并成一行的文本：列之间用制表符分隔（`parseLabRows` 认空格/制表符分隔）。
 * 相邻块间距超过 `gapRatio × 行高` 视为不同列；过近则直接拼接（中文常被切成多块）。
 */
export function rowToLine(items = [], { gapRatio = 0.0 } = {}) {
  if (!items.length) return ''
  const out = []
  let prev = null
  for (const it of items) {
    if (prev) {
      const prevRight = prev.x + prev.w
      const gap = it.x - prevRight
      const ref = Math.max(prev.h, it.h) || 0.01
      const isNewColumn = gap > ref * (gapRatio || 0.35)
      const bothCJK = /[\u4e00-\u9fa5]/.test(prev.text) && /[\u4e00-\u9fa5]/.test(it.text)
      out.push(isNewColumn || !bothCJK ? '\t' : '')
    }
    out.push(it.text)
    prev = it
  }
  return out.join('').replace(/\t+/g, '\t').trim()
}

/**
 * 一步到位：blocks → 文本行数组（按视觉行顺序）。
 */
export function blocksToLines(blocks = [], opts = {}) {
  const rows = groupBlocksIntoRows(blocks, opts)
  return rows.map((items) => rowToLine(items, opts)).filter(Boolean)
}

/**
 * 判断这一批 blocks 是否是「表格式报告」（某些块为纯数值）。
 * 用途：让调用方决定「按行解析」还是「按两列（项目列 / 数值列）对齐解析」。
 */
export function looksTabular(blocks = []) {
  const texts = (blocks || []).map((b) => String(b.text || '').trim()).filter(Boolean)
  if (texts.length < 6) return false
  const numeric = texts.filter((t) => /^-?\d+(\.\d+)?$/.test(t)).length
  return numeric / texts.length >= 0.15
}
