// 两仓指标码别名回归（守「同名不同码导致跨系统趋势断线」）
// 背景：MedBrief 的 ANALYTE_CATALOG 与 MedData 的 dictionary.js 各维护一份码表，
// 实测 141 vs 161、交集 52，其中 9 组同名不同码（总蛋白 TP/TP_PROTEIN 等）。
// 不归一 → 同一指标进 MedData 后落到另一条曲线。
import assert from 'node:assert/strict'
import {
  MEDBRIEF_TO_MEDDATA, MEDDATA_TO_MEDBRIEF, toMedDataCode, toMedBriefCode, aliasStatus, CODE_ALIAS_STATUS,
} from '../lib/codeAlias.mjs'

let pass = 0
const fails = []
function it(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

console.log('两仓指标码别名\n')

it('9 组同名不同码全部登记，且双向可逆', () => {
  assert.equal(Object.keys(MEDBRIEF_TO_MEDDATA).length, 9)
  for (const [mine, theirs] of Object.entries(MEDBRIEF_TO_MEDDATA)) {
    assert.equal(toMedDataCode(mine), theirs, `${mine} → ${theirs} 失败`)
    assert.equal(toMedBriefCode(theirs), mine, `${theirs} → ${mine} 回程失败`)
  }
})

it('反向表由正向表生成（不会手抄漂移）', () => {
  assert.equal(Object.keys(MEDDATA_TO_MEDBRIEF).length, Object.keys(MEDBRIEF_TO_MEDDATA).length)
  for (const [theirs, mine] of Object.entries(MEDDATA_TO_MEDBRIEF)) {
    assert.equal(MEDBRIEF_TO_MEDDATA[mine], theirs)
  }
})

it('未登记的码原样直通（大多数码两仓同名，不许被改写）', () => {
  for (const c of ['WBC', 'Hb', 'PLT', 'NEUT_ABS', 'PT', 'D_DIMER', 'FCM_MRD_PCT']) {
    assert.equal(toMedDataCode(c), c)
    assert.equal(toMedBriefCode(c), c)
    assert.equal(aliasStatus(c), CODE_ALIAS_STATUS.SAME)
  }
  assert.equal(toMedDataCode(''), '')
  assert.equal(toMedDataCode(undefined), undefined)
})

it('别名状态可查（供对账体检，不参与渲染）', () => {
  assert.equal(aliasStatus('TP'), CODE_ALIAS_STATUS.ALIASED)
  assert.equal(aliasStatus('FERRITIN'), CODE_ALIAS_STATUS.ALIASED)
  assert.equal(aliasStatus('不存在的码'), CODE_ALIAS_STATUS.SAME)
})

it('大小写敏感：别名表不做模糊匹配（避免把 UPH 之外的 Uxx 码误并）', () => {
  assert.equal(toMedDataCode('tp'), 'tp')
  assert.equal(toMedBriefCode('TP_PROTEIN'), 'TP')
  assert.equal(toMedBriefCode('tp_protein'), 'tp_protein')
})

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `指标码别名：${pass} 通过 / 0 失败` : `指标码别名：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
