// ===================== 多引擎识别 · 引擎注册表 =====================
// 统一契约：recognizeWithEngine(engine, dataUrl, { signal, id })
//   → { points, engine, elapsedMs, rawMeta }
// 设计红线（评测结论 docs/ocr-skills-benchmark-20260927.md）：换读字引擎、保留理解层——
// 四个引擎的原始输出全部转成 grid 行数组后走同一个 normalizeGridToPoints（字典/别名/反推/审计）。
// 引擎清单与成绩：
//   local  本地 tesseract 管线（默认，44.9%/39.5%，离线）
//   vision macOS Vision（73.5%/27.9%，1.3s，离线，server spawn swift -j，blocks 坐标 0-1 归一）
//   mineru MinerU 云端（83.0%/82.3%，29s，异步 jobId 轮询，HTML 表）
//   ai     AI 精读（复用 /api/ai-docread mode:lab，多模态 agent 读原图转录 rows）
// bbox 契约：point._bbox = { x, y, w, h }（0-1 归一化比例，相对原图）——
//   local 的像素坐标在此除以 naturalWidth/Height 归一；vision 原生 0-1 直用；
//   mineru/ai 无坐标（不产生 _bbox，源图按钮对该行不显示）。
import { runOCRWithRetry, buildGridFromText } from './ocr.js'
import { normalizeGridToPoints } from './normalize.js'
import { buildGridFromHtmlTable, visionBlocksToLines } from './ocrParsers.js'
import { rowsToGrid, narrativeFromDone } from './agentRows.js'

export const ENGINES = {
  local: { name: 'local', label: '本地离线识别', isCloud: false },
  vision: { name: 'vision', label: 'macOS Vision（本机）', isCloud: false },
  mineru: { name: 'mineru', label: 'MinerU 云端', isCloud: true },
  ai: { name: 'ai', label: 'AI 精读', isCloud: true },
}

// dataURL → naturalWidth/Height（bbox 像素坐标归一化用）；加载失败给 1 防除零
function imageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 })
    img.onerror = () => resolve({ w: 1, h: 1 })
    img.src = dataUrl
  })
}

async function fetchJson(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || d.ok === false) throw new Error(d.error || `HTTP ${res.status}`)
  return d
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })

// 统一收口：grid → normalize 理解层 → points（打 _engine 标）
function finish(engine, grid, items, startedAt, extra = {}) {
  const points = normalizeGridToPoints(grid || []).map((p) => ({ ...p, _engine: engine }))
  return { points, engine, elapsedMs: Date.now() - startedAt, rawMeta: { grid, items, ...extra } }
}

// 本地管线 grid 行第 7 列的像素 bbox → 0-1 归一化（无 bbox 的行原样返回）
function normalizeGridBbox(grid, w, h) {
  return (grid || []).map((row) => {
    const bb = row && row[6]
    if (!bb) return row
    return [
      ...row.slice(0, 6),
      { x: bb.x0 / w, y: bb.y0 / h, w: (bb.x1 - bb.x0) / w, h: (bb.y1 - bb.y0) / h },
    ]
  })
}

// MinerU 异步任务轮询（server spawn 后写 done 文件；200s 上限）
async function pollMineru(jobId, signal) {
  const deadline = Date.now() + 200_000
  while (Date.now() < deadline) {
    await sleep(2500, signal)
    const res = await fetch(`/api/ocr-mineru-status?id=${encodeURIComponent(jobId)}`, { signal })
    const d = await res.json().catch(() => ({}))
    if (d.state === 'done') return d
    if (d.state === 'error') throw new Error(d.error || 'MinerU 识别失败')
    if (d.state === 'unknown') throw new Error('MinerU 任务丢失（服务端可能已重启），请重试')
  }
  throw new Error('MinerU 识别超时（200s）')
}

// AI 精读轮询（agent 异步跑，最长 300s；429 限流会带 state:'rate_limited'）
// AI 精读轮询：这类报告（骨穿双列表 / 流式图版）单次 agent 常跑 20–40 分钟，
// 原 300s 硬超时必然失败——用户看到的是「点了 AI 精读，校对网格一直是空的」。
// 口径：前台给 2 分钟（onSlow 回调让 UI 提示「较慢，仍在读」），总预算 45 分钟，
// 出结果就照常把 rows 填进抽查网格（含新项标记），用户再点保存入库。
async function pollAiDocRead(id, signal, { foregroundMs = 120_000, totalMs = 45 * 60_000, onSlow } = {}) {
  const t0 = Date.now()
  let told = false
  while (Date.now() - t0 < totalMs) {
    await sleep(4000, signal)
    if (!told && Date.now() - t0 > foregroundMs) {
      told = true
      try {
        onSlow && onSlow(Math.round((Date.now() - t0) / 1000))
      } catch {
        /* 提示失败不影响识别 */
      }
    }
    const res = await fetch(`/api/ai-docread-status?id=${encodeURIComponent(id)}`, { signal })
    const d = await res.json().catch(() => ({}))
    if (d.state === 'done' || d.state === 'failed') return d
    if (d.state === 'rate_limited') throw new Error(d.message || 'AI 识别接口限流中')
  }
  throw new Error('AI 精读超时（45 分钟）——agent 仍在后台跑时，稍后可重新点 AI 精读取回结果')
}

// 统一入口：按引擎识别一张图，产出 { points, engine, elapsedMs, rawMeta }
// fileName / origin 可选：只有 ai 引擎用（落进任务请求，供任务中心显示真实文件名与来源入口）
export async function recognizeWithEngine(engine, dataUrl, { signal, id, onSlow, fileName, origin } = {}) {
  const startedAt = Date.now()
  switch (engine) {
    case 'local': {
      const r = await runOCRWithRetry(dataUrl)
      const { w, h } = await imageSize(dataUrl)
      const grid = normalizeGridBbox(r.grid, w, h)
      return finish('local', grid, r.items, startedAt, {
        date: r.date,
        time: r.time,
        reportedAt: r.reportedAt,
        // 流式图文报告的正文（印象/结论）；非流式报告为 null
        narrative: r.narrative || null,
        degraded: false,
      })
    }
    case 'vision': {
      const d = await fetchJson('/api/ocr-vision', { id, image: dataUrl }, signal)
      const { lines, degraded, glued } = visionBlocksToLines(d.blocks)
      const grid = buildGridFromText(lines.join('\n')) || []
      // degraded=倾斜 / glued=表格整块粘连（Vision 无列对齐，紧凑表会串行丢项）——均降级提示
      return finish('vision', grid, null, startedAt, { degraded, glued, rawBlocks: d.blocks })
    }
    case 'mineru': {
      const { jobId } = await fetchJson('/api/ocr-mineru', { id, image: dataUrl }, signal)
      const done = await pollMineru(jobId, signal)
      const { grid } = buildGridFromHtmlTable(done.markdown || '')
      return finish('mineru', grid, null, startedAt, {})
    }
    case 'ai': {
      // fileName 一并提交：任务中心与「继续导入」横幅要显示用户真正传的文件，
      // 不带就退化成 task-<id>.jpg（2026-10-28 #ruyd81 用户看不懂"源文件哪来的"）。
      await fetchJson('/api/ai-docread', { id, image: dataUrl, mode: 'lab', fileName: fileName || '', origin: origin || '' }, signal)
      const done = await pollAiDocRead(id, signal, { onSlow })
      // rows → 5 列 grid（表头归一规则见 utils/agentRows.js：三个消费方共用一份，防口径漂移）
      const grid = rowsToGrid(done.rows)
      // 流式报告（C 类口径）agent 会另带 narrative，供落 record.report_text；字段缺失绝不臆造
      return finish('ai', grid, null, startedAt, { narrative: narrativeFromDone(done) })
    }
    default:
      throw new Error(`未知识别引擎：${engine}`)
  }
}
