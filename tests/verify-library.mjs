// 用**报告库真实数据**做回归（用户 2026-11-15 口径：别造样本，库里有 55 份就拿来测）
//
// 三条原则：
//   1. 只读 data/reports.json，**不打印任何患者内容**（断言失败时也只回打「第 N 份/字段名」）；
//   2. 真实库不存在时（换机 / CI）整体 SKIP 并退出 0 —— 不假装通过；
//   3. 断言是**自校验型**：拿原文当参照物证明「抽出来的日期真的在原文里 / 真的不是打印时间」，
//      不硬编码某位病人的值（否则换个库就失效）。
//
// 覆盖：报告元信息（日期/条码/医院）在真实文本上的不变量 + 项目名候选在真实行上的召回率
//      + 批量执行器 runBatch（失败不中断 / 可停止 / 重复计数）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractDocDates, guessBarcode, guessMeta } from '../lib/reportMeta.mjs'
import { buildSignatureIndex, suggestBySignature } from '../lib/analyteSignature.mjs'
import { classifyByTitle, classifyByRows, buildTypeRowIndex, detectTitle } from '../lib/reportTypeDetect.mjs'
import { runBatch } from '../web/src/pages/intake/shared.js'

let pass = 0
const fails = []
/** 原文里是否真的出现过这个日期（允许 2026-09-30 / 2026年9月30日 / 2026.9.30 等写法） */
function hasDate(text, want) {
  const m = String(want || '').match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return true
  const [, y, mo, d] = m
  // 不加「后面不能是数字」的前瞻：OCR 常把日期与时间粘成一串（实测 2026-07-1421:15:52），
  // 那仍然是原文里真实存在的日期，不能因为紧跟时分就判成「凭空生成」。
  const re = new RegExp(`${y}\\s*[-年/.]\\s*0?${Number(mo)}\\s*[-月/.]\\s*0?${Number(d)}`)
  return re.test(String(text || ''))
}

const it = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}
const itAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// ---------- 批量执行器（纯函数，与真实库无关） ----------
await itAsync('runBatch：单条抛错不中断整批，最后统计失败数', async () => {
  const items = [1, 2, 3, 4]
  const r = await runBatch(items, async (n) => { if (n === 2) throw new Error('boom'); return { ok: true } })
  assert.equal(r.ok, 3); assert.equal(r.failed, 1); assert.equal(r.done, 4); assert.equal(r.stopped, false)
})
await itAsync('runBatch：shouldStop 立即停止，且已完成的计数正确', async () => {
  let stop = false
  const seen = []
  const r = await runBatch([1, 2, 3, 4, 5], async (n) => { seen.push(n); if (n === 2) stop = true; return { ok: true } }, { shouldStop: () => stop })
  assert.deepEqual(seen, [1, 2]); assert.equal(r.stopped, true); assert.equal(r.done, 2); assert.equal(r.ok, 2)
})
await itAsync('runBatch：duplicate / skipped 单独计数，不混进 ok', async () => {
  const r = await runBatch([1, 2, 3], async (n) => (n === 1 ? { ok: true } : n === 2 ? { duplicate: true } : { skipped: true }))
  assert.equal(r.ok, 1); assert.equal(r.skipped, 2); assert.equal(r.failed, 0)
})
await itAsync('runBatch：进度回调最后一定到达 total（进度条不会卡在 99%）', async () => {
  let last = -1
  await runBatch([1, 2, 3], async () => ({ ok: true }), { onProgress: (done, total) => { last = `${done}/${total}` } })
  assert.equal(last, '3/3')
})

// ---------- 真实报告库 ----------
const FILE = 'data/reports.json'
if (!fs.existsSync(FILE)) {
  console.log('\n真实报告库不存在（data/reports.json），跳过库内回归 —— 这不是通过，是 SKIP')
} else {
  const store = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const reports = Array.isArray(store.reports) ? store.reports : []
  const withText = reports.filter((r) => String(r.text || '').trim())
  console.log(`\n（真实库：${reports.length} 份，其中有正文的 ${withText.length} 份）`)

  it('日期不变量①：抽出来的报告日期必须真的出现在原文里（不许凭空生成）', () => {
    let checked = 0
    for (const r of withText) {
      const d = extractDocDates(r.text)
      if (!d.date) continue
      checked++
      assert.ok(hasDate(r.text, d.date), `第 ${reports.indexOf(r) + 1} 份：抽出的 ${d.date} 在原文找不到（各种写法都查过）`)
    }
    assert.ok(checked >= Math.min(5, withText.length), `有效样本太少（${checked}）`)
  })

  it('日期不变量②：原文带「报告时间/报告日期」标签时，报告日期必须等于该标签后的日期', () => {
    let checked = 0
    for (const r of withText) {
      const m = String(r.text).match(/(报告时间|报告日期|签发日期|出报告时间)[^\d]{0,12}(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/)
      if (!m) continue
      checked++
      const want = `${m[2]}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`
      const meta = guessMeta(r.text, [])
      // 严格判据不变：报告日期必须等于标签后的日期。年份与单号冲突时 guessMeta **不会**改写日期
      // （只打 dateConflict 标记，见 tests/verify-report-meta.mjs），所以这里不需要例外。
      assert.equal(meta?.reportDate, want, `第 ${reports.indexOf(r) + 1} 份：报告日期应取标签后的 ${want}`)
    }
    assert.ok(checked >= 1, `库里应有带报告时间标签的样本，实际 ${checked}`)
  })

  it('日期不变量③：打印时间绝不能当报告日期（两者都存在且不同时）', () => {
    let checked = 0
    for (const r of withText) {
      const t = String(r.text)
      const rep = t.match(/(报告时间|报告日期)[^\d]{0,12}(20\d{2}\s*[-年/.]\s*\d{1,2}\s*[-月/.]\s*\d{1,2})/)
      const prt = t.match(/(打印时间|打印日期)[^\d]{0,12}(20\d{2}\s*[-年/.]\s*\d{1,2}\s*[-月/.]\s*\d{1,2})/)
      if (!rep || !prt) continue
      const norm = (s) => { const m = s.match(/(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '' }
      const repD = norm(rep[2]); const prtD = norm(prt[2])
      if (!repD || !prtD || repD === prtD) continue
      checked++
      const meta = guessMeta(t, [])
      assert.equal(meta?.reportDate, repD, `第 ${reports.indexOf(r) + 1} 份：报告日期被打印时间带偏了`)
    }
    // 这一条依赖「报告单上同时印着报告时间与打印时间」的样本；库里暂时没有就 SKIP，不算失败
    if (!checked) console.log('       （库内暂无同时含报告时间与打印时间的样本，本项 SKIP）')
  })

  it('条码不变量：抽出的条码必须出现在原文', () => {
    let checked = 0
    for (const r of withText) {
      const bc = guessBarcode(r.text)
      if (!bc) continue
      checked++
      assert.ok(String(r.text).includes(bc), `第 ${reports.indexOf(r) + 1} 份条码不在原文`)
    }
    assert.ok(checked >= 1, '库里应有带条码的报告')
  })

  // ⚠️ 校准记录（2026-11-15，主理人拍板）：`rep_mwh9w5et3um` 的库内标注曾被改成「融合基因」。
  // 原标注「骨髓形态学（骨穿）」是被抬头的「取材：骨髓」带偏的旧误判；原文实际是 FISH 分子检测：
  //   「图片结果：BCR::ABL1 / 信号描述：nuc ish(ABL1,BCR)×2[500]」
  // 处置：**改标注、不动规则**（规则 b43c726 已把 FISH 判为融合基因，这是对的）。
  // 谁要是又把它改回「骨髓形态学」，本用例会立刻红 —— 别再被「取材：骨髓」骗第二次。
  // 另注意：`data/reports.json` 是 gitignore 的（不在版本库里），改前请备份到 data/backups/，
  //   "git 可回滚"对这份文件不成立。
  it('类型不变量①：标题判出来的类型必须与库里已标注的一致（0 条不符）', () => {
    let checked = 0; const bad = []
    for (const r of withText) {
      const got = classifyByTitle(r.text)
      if (!got) continue
      checked++
      if (got.reportType !== r.reportType) bad.push(`${r.reportType}→${got.reportType}`)
    }
    console.log(`       标题判定覆盖 ${checked}/${withText.length} 份，不符 ${bad.length}`)
    assert.deepEqual(bad.slice(0, 5), [], `标题判定与库内标注不符：${bad.slice(0, 5).join('、')}`)
    assert.ok(checked >= Math.floor(withText.length * 0.4), `标题覆盖太低（${checked}/${withText.length}），类型识别对真实数据不可用`)
  })

  it('类型不变量②：有指标行的报告，「标题→项目集」组合判定同样 0 条不符', () => {
    const idx = buildTypeRowIndex(reports)
    assert.ok(idx.size >= 5, `项目集索引太小（${idx.size}）`)
    let checked = 0; const bad = []
    for (const r of reports) {
      if (!Array.isArray(r.rows) || !r.rows.length) continue
      const got = classifyByTitle(r.text || '') || classifyByRows(r.rows, idx)
      if (!got) continue
      checked++
      if (got.reportType !== r.reportType) bad.push(`${r.reportType}→${got.reportType}`)
    }
    console.log(`       组合判定覆盖 ${checked} 份，不符 ${bad.length}`)
    assert.deepEqual(bad.slice(0, 5), [], `组合判定与库内标注不符：${bad.slice(0, 5).join('、')}`)
  })

  it('类型回归（本次 bug 的钉子）：染色体核型报告不得被判成融合基因', () => {
    // 真实库里有 1 份核型报告，其结论里写着「…易位形成 BCR::ABL 融合基因」，
    // 旧实现只扫正文关键词 → 判成融合基因。这条断言就是那次事故的守门人。
    const k = reports.find((r) => r.reportType === '染色体核型' && String(r.text || '').trim())
    if (!k) { console.log('       （库内暂无核型报告，SKIP）'); return }
    const got = classifyByTitle(k.text)
    assert.ok(got, '核型报告必须能判出类型')
    assert.equal(got.reportType, '染色体核型', `被判成了 ${got.reportType}（正文出现「融合基因」不代表它是融合基因报告）`)
    // 同时确认标题识别本身是对的（不是碰巧）
    assert.ok(/核型/.test(detectTitle(k.text)), `标题识别结果应含「核型」，实际「${detectTitle(k.text).slice(0, 20)}」`)
  })

  it('项目名候选（C 方案）在真实行上的召回：抹掉名字后，正确名字应出现在候选里', () => {
    const idx = buildSignatureIndex(reports)
    assert.ok(idx.size >= 20, `签名索引太小（${idx.size}），说明真实库没被正确索引`)
    let tried = 0; let hit = 0
    for (const r of reports) {
      for (const row of (Array.isArray(r.rows) ? r.rows : [])) {
        const name = String(row.name || '').trim()
        const unit = String(row.unit || '').trim()
        const ref = String(row.refRange || '').trim()
        if (!name || (!unit && !ref)) continue
        if (!/[\u4e00-\u9fa5]{2,}/.test(name)) continue   // 只测有中文名的行
        tried++
        const sug = suggestBySignature({ name: '', unit, refRange: ref }, idx)
        if (sug.some((s) => s.name === name)) hit++
      }
    }
    const rate = tried ? hit / tried : 0
    console.log(`       召回：${hit}/${tried} = ${(rate * 100).toFixed(0)}%`)
    assert.ok(tried >= 20, `样本太少（${tried}）`)
    assert.ok(rate >= 0.5, `召回率 ${(rate * 100).toFixed(0)}% 低于 50%，候选功能对真实数据不可信`)
  })
}

console.log(`\n${'='.repeat(46)}`)
console.log(`真实库回归：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { console.log('失败：' + fails.join('、')); process.exit(1) }
