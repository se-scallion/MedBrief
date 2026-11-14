#!/usr/bin/env node
// 导入工作流的只读断言（不连库、不起服务）：解析器 + 判重护栏
// 跑：node tests/verify-import-workflow.mjs
import assert from 'node:assert/strict'
import { parseOcrTable, parseTwoColumnTable } from '../tools/ocr-table-rows.mjs'
import { findDuplicate } from '../lib/reportIntake.mjs'

let pass = 0
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name) }

// 1) 四列表：定性结果行不能丢（ABO 血型 B型）
const abo = ['检验项目\t结果\t参考范围\t单位', 'ABO血型鉴定\tB型', 'ABO血型正定型\tB型', 'ABO血型反定型\tB型', 'ABO血型酶法鉴\tB型', '定', 'Rh（D）血型鉴定\t阳性\t*Rh血型阴性、', '检验免责声明：'].join('\n')
ok('四列表保留定性行（ABO 5 行）', () => {
  const r = parseOcrTable(abo)
  assert.equal(r.rows.length, 5)
  assert.equal(r.rows[0].value, 'B型')
})

// 2) 四列表：粪便常规（未见/阴性/褐色稀便）8 行
const stool = ['检验项目\t结果\t参考范围\t单位', '粪便外观（WG）褐色稀便', '脂肪球\t未见', '夏雷登氏晶体\t未见', '白细胞\t阴性', '红细胞\t阴性', '粪便隐血试验（\t阴性\t阴性', 'OB）', '霉菌\t未见', '虫卵\t未见'].join('\n')
ok('粪便常规 8 行（含首行单格挤写）', () => {
  const r = parseOcrTable(stool)
  assert.equal(r.rows.length, 8)
  assert.equal(r.rows[0].name, '粪便外观（WG）')
})

// 3) 两列表：融合基因定性
const fusion = ['检测结果', '检测项目 检测结果', 'BCR::ABL1（P190型） 阳性', 'V02008911352 V02008911352', 'BCR::ABL1（P210型） 阴性', 'BCR::ABL1（P230型） 阴性', '检测意义解释：'].join('\n')
ok('两列表 3 行（阳性/阴性各就位）', () => {
  const r = parseTwoColumnTable(fusion)
  assert.equal(r.rows.length, 3)
  assert.equal(r.rows[0].name, 'BCR::ABL1（P190型）')
  assert.equal(r.rows[0].value, '阳性')
  assert.equal(r.rows[0].status, 'positive')
})

// 4) 判重护栏：dHash 撞了但单号/日期不同 → 不算重复（否则第二批会被误拒）
const dhash = '1'.repeat(64)
ok('dHash 相同但单号不同 → 不是重复', () => {
  const r = findDuplicate({ sha256: 'a', dhash, barcode: 'NEW', reportDate: '2026-08-04' }, [{ id: 'old', sha256: 'b', dhash, barcode: 'OLD', reportDate: '2026-07-26' }])
  assert.equal(r.dup, false)
})
ok('dHash 相同且单号相同 → 判近重复', () => {
  const r = findDuplicate({ sha256: 'a', dhash, barcode: 'SAME', reportDate: '2026-08-04' }, [{ id: 'old', sha256: 'b', dhash, barcode: 'SAME', reportDate: '2026-08-04' }])
  assert.equal(r.dup, true); assert.equal(r.kind, 'near')
})
ok('sha256 相同 → 精确重复（不看单号）', () => {
  const r = findDuplicate({ sha256: 'x', dhash, barcode: 'A' }, [{ id: 'old', sha256: 'x' }])
  assert.equal(r.dup, true); assert.equal(r.kind, 'exact')
})

console.log('\nverify-import-workflow: ' + pass + ' 项断言全部通过')
