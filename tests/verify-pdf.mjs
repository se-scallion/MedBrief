// PDF 导入门禁
// 背景：资料卡导入页原先只收图片，但用户手里常有医院导出的 PDF（化验单、融合基因报告…）。
// 两条路径按「文字从哪来」分（不是按文件大小）：
//   1. 有文字层 → `pdfMode:'text'`，直接抽文本解析（快、准，不读图）；
//   2. 扫描件/无文字层 → `pdfMode:'raster'`，逐页栅格化后走图像链（deskew→crop→chunk→OCR→合并）。
// 运行：node tests/verify-pdf.mjs
//      真实样例用 MEDBRIEF_PDF_SAMPLE 指定（默认取本机留存的那份融合基因报告 PDF）；缺样例则 SKIP，不假红。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readPdf, guessReportDate } from '../lib/pdfIntake.mjs'

let pass = 0
const fails = []
const skips = []
async function it(name, fn) {
  try { await fn(); pass++; console.log(`PASS  ${name}`) } catch (e) { fails.push(name); console.error(`FAIL  ${name} → ${e.message}`) }
}
const skip = (name, why) => { skips.push(name); console.log(`SKIP  ${name}（${why}）`) }

// ---------- 纯函数：报告日期抽取 ----------
await it('guessReportDate：多种写法都能抽，取文中最后一个', () => {
  assert.equal(guessReportDate('报告日期：2026-07-22 15:56'), '2026-07-22')
  assert.equal(guessReportDate('采样时间：2026年7月15日 12:51'), '2026-07-15')
  assert.equal(guessReportDate('2026.7.1 打印\n2026/07/09 审核'), '2026-07-09')
  assert.equal(guessReportDate('没有日期'), '')
})

// ---------- 真实 PDF（文字层） ----------
const SAMPLE = process.env.MEDBRIEF_PDF_SAMPLE
  || '/Users/scallion/Documents/projects/ds-bot/home/attachments/v1/files/49/49afd1056a139df49732342635bb5c8c2f71ca3ec7c2db64c7cc39a4a910ab20/V020089_刘梦圆_新疆_新疆军区总医院_血液科_分.pdf'

if (!fs.existsSync(SAMPLE)) {
  skip('readPdf 文字层提取', `样例不存在：${SAMPLE}`)
} else {
  const buf = fs.readFileSync(SAMPLE)
  await it('readPdf：文字层 PDF 能抽到页数与文本（2 页 / >1000 字）', async () => {
    const t0 = Date.now()
    const r = await readPdf(buf)
    const ms = Date.now() - t0
    assert.equal(r.mode, 'text')
    assert.equal(r.pageCount, 2)
    assert.equal(r.pages.length, 2)
    const all = r.pages.map((p) => p.text).join('\n')
    assert.ok(all.length > 1000, `文本太短：${all.length}`)
    assert.ok(/BCR::ABL1/.test(all), '应抽到关键结论 BCR::ABL1')
    assert.ok(ms < 2000, `抽文本耗时 ${ms}ms，超过 2s 预算`)
    console.log(`      实测：${r.pageCount} 页 / ${all.length} 字 / ${ms}ms`)
  })

  await it('readPdf：不传 wantPng 时不应携带图片（省内存）', async () => {
    const r = await readPdf(buf)
    assert.ok(r.pages.every((p) => p.png === undefined), 'text 模式不该生成 png')
  })

  // e2e：走现网接口
  let up = false
  try { up = (await fetch('http://127.0.0.1:5174/api/health')).ok } catch { up = false }
  if (!up) {
    skip('e2e：/api/intake/ocr 接收 PDF', '5174 未启动')
  } else {
    await it('e2e：PDF 走文字层（pdfMode=text），返回页数/文本/报告日期', async () => {
      const j = await (await fetch('http://127.0.0.1:5174/api/intake/ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf: 'data:application/pdf;base64,' + buf.toString('base64') }),
      })).json()
      assert.equal(j.ok, true)
      assert.equal(j.kind, 'pdf')
      assert.equal(j.pdfMode, 'text')
      assert.equal(j.pages, 2)
      assert.equal(j.reportDate, '2026-07-22')
      assert.ok((j.text || '').length > 1000)
      // 融合基因报告没有「数值型指标行」，rows 为空是正常的；内容以 text 形式入库
      assert.ok(Array.isArray(j.rows))
    })
  }
}

// ---------- 扫描版 PDF（栅格化后走图像链） ----------
const SCANNED = process.env.MEDBRIEF_SCANNED_PDF || '/tmp/fake-lab-as-pdf.pdf'
if (!fs.existsSync(SCANNED)) {
  skip('扫描版 PDF 栅格化 + OCR', `样例不存在：${SCANNED}（可用 pymupdf 由 fake-lab-report.png 生成）`)
} else {
  await it('readPdf：wantPng=true 时每页带 png（栅格化路径的前提）', async () => {
    const r = await readPdf(fs.readFileSync(SCANNED), { wantPng: true })
    assert.equal(r.mode, 'raster')
    assert.equal(r.pages.length, 1)
    assert.ok((r.pages[0].png || '').length > 1000, '应输出页面 png base64')
  })

  let up2 = false
  try { up2 = (await fetch('http://127.0.0.1:5174/api/health')).ok } catch { up2 = false }
  if (!up2) {
    skip('e2e：扫描版 PDF 解析出 12 行', '5174 未启动')
  } else {
    await it('e2e：扫描版 PDF（无文字层）→ pdfMode=raster → 解析出 12 行指标', async () => {
      const j = await (await fetch('http://127.0.0.1:5174/api/intake/ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf: 'data:application/pdf;base64,' + fs.readFileSync(SCANNED).toString('base64') }),
      })).json()
      assert.equal(j.ok, true)
      assert.equal(j.pdfMode, 'raster', `应走栅格化路径，实际 ${j.pdfMode}`)
      assert.equal(j.rows.length, 12, `应解析出 12 行，实际 ${j.rows.length}`)
      assert.equal(j.rawRowCount, 12)
    })
  }
}

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0
  ? `PDF 导入：${pass} 通过 / 0 失败${skips.length ? `（${skips.length} 项跳过）` : ''}`
  : `PDF 导入：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
