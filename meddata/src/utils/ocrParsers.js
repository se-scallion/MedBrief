// ===================== 多引擎识别 · 解析器（纯函数，零 DOM / 零 ocr.js 依赖） =====================
// 职责：把「非本地引擎」的原始输出转成与本地管线同形状的 grid 行数组，
//      交给 normalizeGridToPoints（字典/别名/反推理解层）——换读字引擎、保留理解层。
// 契约：grid 行 = [name, value, ref, unit, arrow]（与 ocr.js buildGridFromItems 的 5 列对齐）。
// 纪律：单位串行、名称缺字等 MinerU 已知瑕疵**不在此清洗**——交给 normalize 的 audit/反推层，
//      本文件绝不新增启发式改写（数值红线 Bug 031 的延伸）。

// —— HTML 实体解码（MinerU 输出含 &lt; &gt; &amp; 等；单趟扫描，&amp; 不会二次展开）——
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }
export function decodeHtmlEntities(s = '') {
  return String(s).replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos|nbsp));/g,
    (raw, hex, dec, named) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16))
      if (dec) return String.fromCodePoint(parseInt(dec, 10))
      return NAMED_ENTITIES[named] ?? raw
    },
  )
}

// 提取 HTML 中所有 <table> 的行（td 文本二维数组，仅保留 table 内内容——页眉页脚天然被排除）
export function parseHtmlTables(html = '') {
  const rows = []
  const tables = String(html).match(/<table[\s\S]*?<\/table>/gi) || []
  for (const table of tables) {
    const trs = table.match(/<tr[\s\S]*?<\/tr>/gi) || []
    for (const tr of trs) {
      const tds = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []
      rows.push(
        tds.map((td) =>
          decodeHtmlEntities(td.replace(/<[^>]+>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim(),
        ),
      )
    }
  }
  return rows
}

// 表头/噪声行：首格以「项目名称/检验项目/项目/Item」开头（去空格后），且整行无箭头
const HEADER_ROW_RE = /^(项目名称|检验项目|项目|item)/i
const isHeaderRow = (cells) =>
  HEADER_ROW_RE.test(String(cells[0] || '').replace(/\s+/g, '')) && !/[↑↓]/.test(cells.join(''))

// 从半栏 cells 里取 [name, value, ref, unit, arrow]；无项目名的行丢弃（孤立数值/残行，
// 交给后续人工或换引擎——喂入无名称行只会产出 normalize 的 gap 噪声）
function pickGridRow(part) {
  const [name = '', value = '', ref = '', unit = '', tip = ''] = part
  const nm = String(name).trim()
  if (!nm) return null
  const val = String(value).trim()
  const arrow = (String(tip).match(/[↑↓]/) || [])[0] || ''
  return [nm, val, String(ref).trim(), String(unit).trim(), arrow]
}

// MinerU HTML → grid（[[name, value, ref, unit, arrow], ...]）
// 双栏表（每行 ≥8 个 td）拆左右两半各成一行；5 列取前 4 + tip 提箭头；表头行跳过。
export function buildGridFromHtmlTable(html = '') {
  const grid = []
  for (const cells of parseHtmlTables(html)) {
    if (cells.every((c) => !c)) continue
    if (isHeaderRow(cells)) continue
    if (cells.length >= 8) {
      const half = Math.floor(cells.length / 2)
      for (const part of [cells.slice(0, half), cells.slice(half)]) {
        const row = pickGridRow(part)
        if (row) grid.push(row)
      }
    } else {
      const row = pickGridRow(cells)
      if (row) grid.push(row)
    }
  }
  return { grid }
}

// —— macOS Vision blocks → 行文本数组 ——
// blocks: [{ text, boundingBox: {x, y, width, height}, confidence }]，坐标为 0-1 归一化比例。
// 按「块中心 y（y + h/2）」聚类成行（非 top 边界，评审加固：抗倾斜的第一道防线）；
// 行内按 x 升序拼接。倾斜严重时（行内块中心 y 极差超阈值）标记 degraded=true，
// 上层据此提示「Vision 对倾斜照片降级，建议重拍或换引擎」，不做几何校正（一期不引入）。
export function visionBlocksToLines(blocks = [], opts = {}) {
  const gapScale = opts.gapScale ?? 0.9 // 行间距阈值 = 块高中位数 × gapScale（0.9 吸收倾斜阶梯，仍小于真实行距 ≈ 1.3×块高）
  const skewTol = opts.skewTol ?? 0.02 // 行内块中心 y 极差超过此值 → 倾斜降级
  const items = (blocks || [])
    .filter((b) => b && b.text && String(b.text).trim() && b.boundingBox)
    .map((b) => ({
      text: String(b.text).trim(),
      x: b.boundingBox.x,
      cy: b.boundingBox.y + b.boundingBox.height / 2,
      h: b.boundingBox.height || 0,
    }))
  if (!items.length) return { lines: [], degraded: false }

  // 块高中位数 → 自适应行间距阈值
  const hs = items.map((b) => b.h).sort((a, b) => a - b)
  const hMed = hs[Math.floor(hs.length / 2)] || 0.01
  const rowGap = Math.max(0.004, hMed * gapScale)

  items.sort((a, b) => a.cy - b.cy || a.x - b.x)
  const groups = []
  let cur = null
  for (const it of items) {
    if (!cur || it.cy - cur.lastCy > rowGap) {
      cur = { firstCy: it.cy, lastCy: it.cy, blocks: [it] }
      groups.push(cur)
    } else {
      cur.blocks.push(it)
      cur.lastCy = it.cy
      if (Math.abs(it.cy - cur.firstCy) > skewTol) {
        // 行内首尾块垂直漂移过大 → 倾斜（同一行被读成阶梯状）
        groups.__degraded = true
      }
    }
  }
  const lines = groups.map((g) =>
    g.blocks
      .slice()
      .sort((a, b) => a.x - b.x)
      .map((b) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  // 粘连检测（实测发现，anemia 朝阳竖版报告）：紧凑化验表被 Vision 读成**一个巨大文本块**
  // （三行数据的名称+值+参考+单位全粘在一起，如「*叶酸（FA）*维生素B12 *铁蛋白 4.62 813.35
  // 187.00 190--824 26.78-397.88 …」）——Vision 无表格列对齐能力，后续切行必然串行丢项。
  // 判据：单行文本 >60 字且含 ≥4 个数值 → 判粘连，标 degraded 交由上层提示换引擎。
  const glued = lines.some((t) => t.length > 60 && (t.match(/-?\d+(?:\.\d+)?/g) || []).length >= 4)
  return { lines, degraded: !!groups.__degraded, glued }
}
