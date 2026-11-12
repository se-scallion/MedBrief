// 倾斜矫正（deskew）门禁
// 背景（2026-11-12 单变量实测）：整页倾斜时「同一行 y 相近」的行聚类会崩 —— 旋转 2° 解析行数掉 27%，
// 而缩分辨率/降对比都不影响。故 OCR 前先估角回正。判据：estimate 误差 ≤ 0.5°、耗时 ≤ 150ms、
// 回正后行数恢复；|angle| < 0.5° 不动（二次插值会糊字）。
// 运行：node tests/verify-deskew.mjs [样例路径]
//      样例默认 /tmp/fake-lab-report.png（可用 MEDBRIEF_DESKEW_SAMPLE 指定）；缺样例时离线断言仍跑，OCR 断言 SKIP。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { estimateSkew, deskewImage, autoDeskew, SKEW_MIN_APPLY_DEG } from '../lib/deskew.mjs'

let pass = 0
const fails = []
const skips = []
function it(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log(`PASS  ${name}`) })
    .catch((e) => { fails.push(name); console.error(`FAIL  ${name} → ${e.message}`) })
}
const skip = (name, why) => { skips.push(name); console.log(`SKIP  ${name}（${why}）`) }

const SAMPLE = process.env.MEDBRIEF_DESKEW_SAMPLE || '/tmp/fake-lab-report.png'
const hasSample = fs.existsSync(SAMPLE)
const src = hasSample ? fs.readFileSync(SAMPLE) : null

// ---------- 离线断言（不需要 OCR） ----------
if (!hasSample) {
  skip('估角精度 / 回正效果 / 行数恢复', `样例不存在：${SAMPLE}`)
} else {
  await it('estimateSkew：原图（0°）判为不歪，angle=0', async () => {
    const est = await estimateSkew(src)
    assert.equal(est.angle, 0, `原图应判 0°，实际 ${est.angle}°`)
  })

  for (const deg of [1, 2, 3, 5]) {
    await it(`estimateSkew：歪 ${deg}° 时估计误差 ≤ 0.5°，且给出的是「矫正角」（符号相反）`, async () => {
      const rotated = await deskewImage(src, deg)
      const est = await estimateSkew(rotated)
      assert.ok(Math.abs(est.angle + deg) <= 0.5, `歪 ${deg}° → 估计 ${est.angle}°，误差 > 0.5°`)
    })
  }

  await it('estimateSkew：性能 ≤ 150ms（300px 宽 × 21 个角度）', async () => {
    const rotated = await deskewImage(src, 2)
    await estimateSkew(rotated) // 预热（首次会加载 canvas 模块）
    const times = []
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now()
      await estimateSkew(rotated)
      times.push(Date.now() - t0)
    }
    const med = times.sort((a, b) => a - b)[1]
    assert.ok(med <= 150, `中位耗时 ${med}ms 超过 150ms 预算`)
    console.log(`      实测估角耗时：${times.join(' / ')}ms（中位 ${med}ms）`)
  })

  await it('autoDeskew：|angle| < 0.5° 时不动图（避免二次插值损失）', async () => {
    const r = await autoDeskew(src)
    assert.equal(r.applied, false, '原图不该被重采样')
    assert.equal(r.angle, 0)
    assert.equal(SKEW_MIN_APPLY_DEG, 0.5)
  })
}

// ---------- 在线断言：回正后行数恢复（需要 5174 + 8008） ----------
async function ocrRows(image) {
  const r = await fetch('http://127.0.0.1:5174/api/intake/ocr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }),
  })
  return r.json()
}
const toUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64')

let serviceOk = false
try {
  const probe = await fetch('http://127.0.0.1:5174/api/health')
  serviceOk = probe.ok
} catch { serviceOk = false }

if (!hasSample || !serviceOk) {
  skip('回正后行数恢复（歪 2°/5° → 恢复原图行数）', !hasSample ? '样例不存在' : '5174 未启动')
} else {
  const base = await ocrRows(toUrl(src))
  const baseRows = base.rows.length
  for (const deg of [2, 5]) {
    await it(`回正后行数恢复：歪 ${deg}° → 与水平原图同为 ${baseRows} 行`, async () => {
      const rotated = await deskewImage(src, deg)
      const out = await ocrRows(rotated)
      assert.equal(out.deskewAngle, -deg, `应估出矫正角 -${deg}°，实际 ${out.deskewAngle}°`)
      assert.equal(out.deskewed, true, '超过 0.5° 必须实际回正')
      assert.equal(out.rows.length, baseRows, `回正后应恢复 ${baseRows} 行，实际 ${out.rows.length}`)
      console.log(`      歪 ${deg}°：deskewAngle=${out.deskewAngle}° · ${out.deskewMs}ms · rows ${out.rows.length}/${baseRows}`)
    })
  }
  await it('响应字段：deskewAngle / deskewed / deskewMs 齐全且类型正确', async () => {
    const out = await ocrRows(toUrl(src))
    assert.equal(typeof out.deskewAngle, 'number', 'deskewAngle 应为数字')
    assert.equal(typeof out.deskewed, 'boolean', 'deskewed 应为布尔')
    assert.equal(typeof out.deskewMs, 'number', 'deskewMs 应为数字')
    assert.equal(out.deskewed, false, '水平原图不应被矫正')
  })
}

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0
  ? `倾斜矫正：${pass} 通过 / 0 失败${skips.length ? `（${skips.length} 项跳过）` : ''}`
  : `倾斜矫正：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
