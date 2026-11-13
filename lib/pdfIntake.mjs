// ===================== PDF 导入（化验单/报告单常见输入形式） =====================
// 为什么需要：资料卡导入页原本只收图片，用户实际拿到的是医院导出的 PDF（报告单、融合基因报告…）。
// 两种 PDF 走两条路，判据是「文字从哪来」而不是「文件多大」：
//   1. **有文字层**（iText/Word/系统导出，实测 595×842 双页报告 text_len 921/2612）→ 直接抽文本，
//      不读图，快且准（`mode: 'text'`）；
//   2. **扫描件 / 无文字层**（纯图片 PDF）→ 按页栅格化成 PNG，交给既有的图像链
//      （deskew → cropToContent → planChunks → 逐块 OCR → 合并，`mode: 'raster'`）。
//
// 实现用本机 python3 + PyMuPDF（已装），零新增 node 依赖。MuPDF 对个别 iText 生成的 PDF 会刷
// `cannot find ExtGState resource` 之类的语法告警 —— 那是告警不是失败，已用
// `TOOLS.mupdf_display_errors(False)` 静音，避免污染 server 日志。

import { spawn } from 'node:child_process'

const PY = `import sys, json, base64, io
import fitz
fitz.TOOLS.mupdf_display_errors(False)

raw = sys.stdin.buffer.read()
cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
dpi = int(cfg.get('dpi') or 200)
max_pages = int(cfg.get('maxPages') or 20)
want_png = bool(cfg.get('wantPng'))

doc = fitz.open(stream=raw, filetype='pdf')
out = {'pageCount': doc.page_count, 'pages': [], 'mode': 'text'}
for i, page in enumerate(doc):
    if i >= max_pages:
        break
    text = page.get_text() or ''
    item = {'index': i + 1, 'text': text, 'width': round(page.rect.width), 'height': round(page.rect.height)}
    if want_png:
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        item['png'] = base64.b64encode(pix.tobytes('png')).decode('ascii')
    out['pages'].append(item)
if want_png:
    out['mode'] = 'raster'
print(json.dumps(out))
`

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  const s = String(input || '')
  return Buffer.from(s.replace(/^data:application\/pdf;base64,/i, '').replace(/^data:application\/octet-stream;base64,/i, ''), 'base64')
}

/**
 * 解析 PDF（纯本地，不联网）
 * @param {Buffer|string} input PDF Buffer 或 dataUrl
 * @param {{rasterDpi?:number, maxPages?:number}} opts
 * @returns {Promise<{pageCount:number, mode:'text'|'raster', pages:Array<{index:number,text:string,width:number,height:number,png?:string}>}>}
 */
export function readPdf(input, { rasterDpi = 200, maxPages = 20, wantPng = false } = {}) {
  const buf = toBuffer(input)
  return new Promise((resolve, reject) => {
    const py = spawn('python3', ['-c', PY, JSON.stringify({ dpi: rasterDpi, maxPages, wantPng })])
    let out = ''
    let err = ''
    py.stdout.on('data', (d) => { out += d })
    py.stderr.on('data', (d) => { err += d })
    py.on('error', (e) => reject(new Error(`python3 不可用：${e.message}`)))
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(`PDF 解析失败（python 退出码 ${code}）：${err.trim().slice(0, 300)}`))
      try {
        resolve(JSON.parse(out))
      } catch (e) {
        reject(new Error(`PDF 解析输出无法解析：${e.message}`))
      }
    })
    py.stdin.on('error', () => {})
    py.stdin.write(buf)
    py.stdin.end()
  })
}

/** 报告单上常见的「报告日期」抽取（YYYY-MM-DD / YYYY年M月D日），取文中最后一个 */
export function guessReportDate(text = '') {
  const re = /(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/g
  let last = null
  let m
  while ((m = re.exec(String(text)))) last = m
  if (!last) return ''
  return `${last[1]}-${String(last[2]).padStart(2, '0')}-${String(last[3]).padStart(2, '0')}`
}
