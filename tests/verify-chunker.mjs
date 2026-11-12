// 超高图切块（chunker）门禁
// 背景（2026-11-12 实测）：拼接长图会让 Vision 内部降采样，**中间带成片丢行**；
// 丢行只与 h/w 有关（≤2.8 稳定、3.21 掉 27%），与绝对像素高无关。
// 本文件守三件事：
//   1. planChunks 纯函数边界（2.79 不切 / 2.81 切 / 宽图不切 / 正方形不切 / 覆盖完整不丢像素）；
//   2. 单块路径必须与未引入切块时一致（返回 [{y:0,h:height}]，一个像素都不切）；
//   3. 真实超高图 e2e（样本存在时）：切块后 rawRowCount 与期望一致，且去重后的行数不虚高。
// 运行：node tests/verify-chunker.mjs
//      e2e 样本可用 MEDBRIEF_TALL_SAMPLE / MEDBRIEF_SAFE_SAMPLE 指定（默认 /tmp/height-4x-stitched.png 等）

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planChunks, MAX_ASPECT, DEFAULT_OVERLAP_PX } from '../lib/imageChunker.mjs'

let pass = 0
const fails = []
const skip = []
function it(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`) } catch (e) { fails.push(name); console.error(`FAIL  ${name} → ${e.message}`) }
}

// ---------- 1. planChunks 边界 ----------
it('h/w = 2.79 不切（单块路径）', () => {
  const p = planChunks({ width: 1000, height: 2790 })
  assert.equal(p.chunked, false)
  assert.deepEqual(p.chunks, [{ y: 0, h: 2790 }])
})

it('h/w = 2.81 切（≥2 块）', () => {
  const p = planChunks({ width: 1000, height: 2810 })
  assert.equal(p.chunked, true)
  assert.ok(p.chunks.length >= 2, `应切成 ≥2 块，实际 ${p.chunks.length}`)
})

it('恰好 2.8 不切（阈值含等号）', () => {
  const p = planChunks({ width: 1000, height: 2800 })
  assert.equal(p.chunked, false)
  assert.equal(MAX_ASPECT, 2.8)
})

it('宽图 / 正方形不切', () => {
  assert.equal(planChunks({ width: 4000, height: 1000 }).chunked, false)
  assert.equal(planChunks({ width: 2000, height: 2000 }).chunked, false)
})

it('尺寸缺失不抛错，返回单块', () => {
  assert.equal(planChunks({}).chunked, false)
  assert.equal(planChunks({}).chunks.length, 1)
})

it('切块覆盖完整：首块从 0 起、末块到图底、相邻块有重叠且无空洞', () => {
  const width = 2000
  const height = 6424
  const overlap = DEFAULT_OVERLAP_PX
  const p = planChunks({ width, height }, { overlapPx: overlap })
  assert.equal(p.chunks[0].y, 0)
  const last = p.chunks[p.chunks.length - 1]
  assert.equal(last.y + last.h, height, `末块应到图底：${last.y + last.h} ≠ ${height}`)
  for (let i = 1; i < p.chunks.length; i++) {
    const prevEnd = p.chunks[i - 1].y + p.chunks[i - 1].h
    const cur = p.chunks[i]
    assert.ok(cur.y < prevEnd, '相邻块必须有重叠（否则切点那行谁都不完整）')
    assert.ok(prevEnd - cur.y >= Math.min(overlap, cur.h), `重叠不足：${prevEnd - cur.y}`)
    assert.ok(cur.y <= prevEnd, '不得出现空洞')
  }
})

it('每块 h/w ≤ targetAspect（2.4），即每块都落在安全区', () => {
  // 注：targetAspect 是**上界**不是目标值 —— h/w 3.21 的图按 2 块切，每块 h/w ≈ 1.63，
  //     这已经是安全区；要求「每块恰为 2.4」在块数只能取整时不可能成立。
  for (const H of [3000, 6424, 9624, 12848]) {
    const p = planChunks({ width: 2000, height: H })
    for (const c of p.chunks) {
      const aspect = c.h / 2000
      assert.ok(aspect <= 2.4 + 0.01, `${H} 高的图块 h/w 越界：${aspect.toFixed(2)} > 2.4`)
      assert.ok(aspect <= MAX_ASPECT, `块 h/w 超过安全阈值：${aspect.toFixed(2)}`)
    }
  }
})

it('块数随长宽比增长，且单调不降', () => {
  const a = planChunks({ width: 2000, height: 6424 }).chunks.length
  const b = planChunks({ width: 2000, height: 12848 }).chunks.length
  assert.ok(b >= a, `更高的图不应切更少块：${b} < ${a}`)
})

// ---------- 2. 真实超高图 e2e（样本不在则跳过，不假红） ----------
const TALL = process.env.MEDBRIEF_TALL_SAMPLE || '/tmp/height-4x-stitched.png'
const SAFE = process.env.MEDBRIEF_SAFE_SAMPLE || '/tmp/height-3x-stitched.png'

async function post(path, body) {
  const r = await fetch('http://127.0.0.1:5174' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return r.json()
}
const durl = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')

if (!fs.existsSync(TALL) || !fs.existsSync(SAFE)) {
  skip.push(`e2e 跳过：样本不存在（${TALL} / ${SAFE}）`)
  console.log('SKIP  真实超高图 e2e（样本不在本机，设 MEDBRIEF_TALL_SAMPLE 可跑）')
} else {
  let tall
  let safe
  try {
    tall = await post('/api/intake/ocr', { image: durl(TALL), stitched: true })
    safe = await post('/api/intake/ocr', { image: durl(SAFE), stitched: true })
  } catch (e) {
    skip.push(`e2e 跳过：服务未响应（${e.message}）`)
    console.log('SKIP  真实超高图 e2e（5174 未启动）')
  }
  if (tall && safe) {
    it('e2e：h/w 2.41 的安全高图不切块，rawRowCount 保持 36', () => {
      assert.equal(safe.chunked, false, `不应切块，实际 chunked=${safe.chunked}`)
      assert.equal(safe.rawRowCount, 36, `rawRowCount 应为 36，实际 ${safe.rawRowCount}`)
    })
    it('e2e：h/w 3.21 的超高图切 2 块，rawRowCount 从 35 恢复到 48', () => {
      assert.equal(tall.chunked, true, '应当切块')
      assert.equal(tall.chunks, 2, `应切 2 块，实际 ${tall.chunks}`)
      assert.equal(tall.rawRowCount, 48, `rawRowCount 应为 48（切块前实测 35），实际 ${tall.rawRowCount}`)
    })
    it('e2e：切块合并后行数不虚高（12 项就该 12 行），且合并留痕', () => {
      assert.equal(tall.rows.length, 12, `合并后应为 12 行，实际 ${tall.rows.length}`)
      const merged = tall.rows.filter((r) => r.chunkMerged)
      assert.ok(merged.length > 0, '必须留痕：合并出来的行要带 chunkMerged')
      assert.ok(merged.every((r) => r.dedupedFrom >= 2), '合并行要记录 dedupedFrom')
    })
  }
}

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `超高图切块：${pass} 通过 / 0 失败${skip.length ? `（${skip.length} 项跳过）` : ''}` : `超高图切块：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
