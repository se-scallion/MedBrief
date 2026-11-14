#!/usr/bin/env node
// 报告库排序口径回归（纯函数，不依赖浏览器/React）
//
// 为什么单独测：排序里三条都是**不变量**，写在 JSX 里只能靠肉眼：
//   ① 缺失值恒排最后（升序降序都一样）—— antd 的 sorter 会把结果乘以方向，降序时缺值会翻到最前；
//   ② 中文用 localeCompare('zh-Hans-CN')，不是码点序；
//   ③ 取消排序回默认「日期 降」，且默认日期键在缺失时退回**入库时间**（不写回 reportDate）。
// 口径来源：MedData `src/components/DataGrid.jsx:277-400`。
//
// 用法：node tests/verify-reportsort.mjs
import assert from 'node:assert/strict'
import { DEFAULT_SORT, sortReports, nextSort, dateKeyOf } from '../web/src/pages/intake/reportSort.js'

let pass = 0
const fails = []
const it = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); pass++ } catch (e) { console.log(`FAIL  ${name} → ${e.message}`); fails.push(name) }
}

const R = (id, o = {}) => ({ id, rows: [], ...o })

it('默认排序 = 日期降序；无 reportDate 的用入库时间参与排序（不写回 reportDate）', () => {
  const list = [
    R('old', { reportDate: '2026-07-14' }),
    R('new', { reportDate: '2026-08-02' }),
    R('nofdate', { reportDate: '', createdAt: '2026-11-14T07:00:00.000Z' }),
  ]
  assert.deepEqual(sortReports(list, DEFAULT_SORT).map((r) => r.id), ['nofdate', 'new', 'old'])
  assert.equal(list[2].reportDate, '', '排序不得改动 reportDate（那是临床事实）')
  assert.equal(dateKeyOf(list[2]), '2026-11-14', '无日期时排序键应取入库日期')
})

it('缺失值恒排最后：升序、降序都一样（医院 / 单号两列各验一次）', () => {
  const list = [
    R('b', { hospital: '北京朝阳', barcode: 'V0200' }),
    R('a', { hospital: '香河', barcode: 'P2026' }),
    R('none', { hospital: '', barcode: '' }),
  ]
  assert.deepEqual(sortReports(list, { key: 'hospital', order: 'ascend' }).map((r) => r.id).slice(-1), ['none'])
  assert.deepEqual(sortReports(list, { key: 'hospital', order: 'descend' }).map((r) => r.id).slice(-1), ['none'])
  assert.deepEqual(sortReports(list, { key: 'barcode', order: 'ascend' }).map((r) => r.id).slice(-1), ['none'])
  assert.deepEqual(sortReports(list, { key: 'barcode', order: 'descend' }).map((r) => r.id).slice(-1), ['none'])
})

it('中文字符串按 zh-Hans-CN 排（不是码点序：北京 < 上海）', () => {
  const list = [R('sh', { hospital: '上海某院' }), R('bj', { hospital: '北京朝阳' })]
  assert.deepEqual(sortReports(list, { key: 'hospital', order: 'ascend' }).map((r) => r.id), ['bj', 'sh'])
  // 前提：显式带 locale 才按拼音（北京 běi < 上海 shàng）；**不带 locale 会退回默认 locale**
  // （本机实测默认给出 -1，即 上 < 北），所以模块里必须显式传 'zh-Hans-CN' —— 这条断言就是钉这个。
  assert.ok('上'.localeCompare('北', 'zh-Hans-CN') > 0, '前置：带 zh-Hans-CN 时 北京 应在 上海 之前')
  assert.ok('上'.localeCompare('北') < 0, '前置：不带 locale 的默认排序会把顺序弄反（这正是必须显式传 locale 的原因）')
})

it('数值列按数字排（指标项数 2 < 10，不是字符串 "10" < "2"）', () => {
  const list = [R('ten', { rows: new Array(10).fill({}) }), R('two', { rows: [{}, {}] })]
  assert.deepEqual(sortReports(list, { key: 'rows', order: 'ascend' }).map((r) => r.id), ['two', 'ten'])
})

it('异常数按 status 计数：high/low/positive 才算，其余不算', () => {
  const list = [
    R('many', { rows: [{ status: 'high' }, { status: 'low' }, { status: 'normal' }] }),
    R('one', { rows: [{ status: 'positive' }, { status: 'normal' }] }),
    R('zero', { rows: [{ status: 'normal' }] }),
  ]
  assert.deepEqual(sortReports(list, { key: 'abnormal', order: 'descend' }).map((r) => r.id), ['many', 'one', 'zero'])
})

it('三态循环：升 → 降 → 取消（回默认日期降）→ 再升', () => {
  let s = DEFAULT_SORT
  s = nextSort(s, 'hospital'); assert.deepEqual(s, { key: 'hospital', order: 'ascend' })
  s = nextSort(s, 'hospital'); assert.deepEqual(s, { key: 'hospital', order: 'descend' })
  s = nextSort(s, 'hospital'); assert.deepEqual(s, DEFAULT_SORT)
  s = nextSort(s, 'hospital'); assert.deepEqual(s, { key: 'hospital', order: 'ascend' })
  // 换一列点，直接进升序
  assert.deepEqual(nextSort({ key: 'barcode', order: 'descend' }, 'rows'), { key: 'rows', order: 'ascend' })
})

it('纯函数：不改原数组；空输入 / 非数组不抛错', () => {
  const list = [R('a', { reportDate: '2026-07-14' }), R('b', { reportDate: '2026-08-02' })]
  const before = list.map((r) => r.id)
  sortReports(list, { key: 'date', order: 'ascend' })
  assert.deepEqual(list.map((r) => r.id), before, '原数组顺序不得被改动')
  assert.deepEqual(sortReports([]), [])
  assert.deepEqual(sortReports(null), [])
  assert.deepEqual(sortReports(undefined, { key: 'nope', order: 'ascend' }), [])
})

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `报告库排序：${pass} 通过 / 0 失败` : `报告库排序：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
