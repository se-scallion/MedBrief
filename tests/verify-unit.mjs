// ===================== MedBrief 单元门禁（纯函数，零网络，CI 必跑） =====================
// 覆盖：
//   1. 挂号核心纯函数：身份证/手机号校验、预约入参校验
//   2. 种子排班与预约/取消/号源回滚（内存态，无磁盘、无网络）
//   3. .meddata 交换包：格式/指纹/SHA-256、build→parse 无损还原、篡改必拒
//   4. 近期指标聚合：按日期取最新非空值、Null 疾病指标视为未测、HGB→Hb 别名
// 分层口径：本文件属 `npm run test:unit`；真实 HTTP/浏览器链路见 `npm run test:live`（tests/verify-e2e.mjs）。
// 运行：node tests/verify-unit.mjs

import { strict as assert } from 'node:assert'
import {
  validateIdCard,
  validatePhone,
  validateBookingPayload,
  createGuahaoManager,
  DEFAULT_DOCTORS,
} from '../lib/guahaoCore.js'
import { buildMedDataBundle, parseMedDataBundle, BUNDLE_FORMAT, BUNDLE_VERSION } from '../lib/meddataBundle.js'
import { summarizeState, formatSummaryText, LAB_CODE_ALIASES } from '../lib/metricsSummary.js'

let pass = 0
let fail = 0
const fails = []

function it(name, fn) {
  try {
    fn()
    pass++
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail++
    fails.push({ name, err: e.message })
    console.error(`FAIL  ${name}  →  ${e.message}`)
  }
}

console.log('=== MedBrief 单元门禁（纯函数） ===\n')

// ---------- 1. 校验类纯函数 ----------
it('身份证：代聪 511025199605011511 合法', () => {
  assert.equal(validateIdCard('511025199605011511'), true)
})

it('身份证：位数不足 / 校验码错 / 非法日期 一律拒绝', () => {
  assert.equal(validateIdCard('123456'), false)
  assert.equal(validateIdCard('511025199605011512'), false)
  assert.equal(validateIdCard('511025199613011511'), false)
})

it('手机号：合法与非法', () => {
  assert.equal(validatePhone('13800100114'), true)
  assert.equal(validatePhone('12345'), false)
})

it('预约入参：缺字段时逐条报错', () => {
  const r = validateBookingPayload({ patientName: '代聪' })
  assert.equal(r.valid, false)
  assert.ok(r.errors.length >= 4, `错误条数应 ≥4，实际 ${r.errors.length}`)
  const ok = validateBookingPayload({
    patientName: '代聪',
    idCard: '511025199605011511',
    hospital: '北京朝阳医院',
    department: '血液科',
    doctorName: '主鸿鹄',
  })
  assert.equal(ok.valid, true)
})

// ---------- 2. 种子排班 / 预约 / 取消回滚（内存态） ----------
it('种子数据：默认医生含主鸿鹄主任', () => {
  const zhh = DEFAULT_DOCTORS.find((d) => d.name === '主鸿鹄')
  assert.ok(zhh, '种子数据应含主鸿鹄')
  assert.ok(Array.isArray(zhh.slots) && zhh.slots.length > 0, '主鸿鹄应有号源')
})

it('预约 → 号源递减 → 取消 → 号源回滚', () => {
  const mgr = createGuahaoManager() // 不传 storageFile/fs：纯内存，不落盘
  const date = '2026-11-16'
  const remainOf = () =>
    mgr
      .getSchedule({ hospital: '北京朝阳医院', department: '血液科', date, doctorName: '主鸿鹄' })
      .doctors[0].slots.find((s) => s.type === 'normal' && s.period === 'morning').remaining

  const before = remainOf()
  const booked = mgr.bookAppointment({
    patientName: '代聪',
    idCard: '511025199605011511',
    phone: '13800100114',
    hospital: '北京朝阳医院',
    department: '血液科',
    doctorName: '主鸿鹄',
    slotType: 'normal',
    period: 'morning',
  })
  assert.equal(booked.ok, true, `预约应成功：${booked.error || ''}`)
  const orderId = booked.voucher?.orderId || booked.order?.orderId
  assert.ok(orderId && orderId.startsWith('GH'), `订单号应以 GH 开头，实际 ${orderId}`)
  assert.equal(remainOf(), before - 1, '预约后号源应减 1')

  const cancelled = mgr.cancelOrder(orderId)
  assert.equal(cancelled.ok, true, `取消应成功：${cancelled.error || ''}`)
  assert.equal(cancelled.order?.status, 'CANCELLED', '取消后状态应为 CANCELLED')
  assert.equal(cancelled.slotRestored, true, '应标记号源已回滚')
  assert.equal(remainOf(), before, '取消后号源应回滚到原值')
})

it('非法身份证预约被拒绝', () => {
  const mgr = createGuahaoManager()
  const r = mgr.bookAppointment({
    patientName: '代聪',
    idCard: '123456',
    hospital: '北京朝阳医院',
    department: '血液科',
    doctorName: '主鸿鹄',
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors && r.errors.length > 0)
})

// ---------- 3. .meddata 交换包 ----------
function sampleState() {
  return {
    patient_meta: { name: '代聪', diagnosis: 'B-ALL', idCard: '511025199605011511' },
    records: [
      {
        id: 'r_unit_001',
        date: '2026-09-20',
        created_at: '2026-09-27T02:38:18.338Z',
        report_type: 'CBC',
        data_points: [
          { standard_code: 'WBC', value: '6.83', unit: '10^9/L', ref_range: '3.5-9.5', status: 'NORMAL' },
          { standard_code: 'Hb', value: '113', unit: 'g/L', ref_range: '130-175', status: 'LOW' },
          { standard_code: 'PLT', value: '321', unit: '10^9/L', ref_range: '125-350', status: 'NORMAL' },
        ],
      },
    ],
    docs: [{ id: 'd_unit_001', title: '门诊病历', kind: 'outpatient', date: '2026-09-20' }],
    diseaseMetrics: [
      { id: 'dm_unit_001', stream: 'morph', code: 'BM_BLAST_PCT', date: '2026-10-10', value: 1.5, unit: '%', qualifier: 'eq' },
      { id: 'dm_unit_002', stream: 'fcm', code: 'FCM_MRD_PCT', date: '2026-09-03', value: 0.2, unit: '%', qualifier: 'eq' },
    ],
    events: [],
    courses: [],
    invoices: [],
  }
}

it('交换包：格式/版本/指纹长度正确', () => {
  const bundle = buildMedDataBundle(sampleState(), { exportedBy: 'unit-test', today: '2026-11-12' })
  assert.equal(bundle.manifest.format, BUNDLE_FORMAT)
  assert.ok(String(bundle.manifest.version).startsWith('1.'), `版本应 1.x，实际 ${bundle.manifest.version}`)
  assert.equal(String(bundle.manifest.fingerprint).length, 64, 'SHA-256 指纹应为 64 字符')
  assert.match(bundle.manifest.fingerprint, /^[0-9a-f]{64}$/)
})

it('交换包：build → parse 无损还原（实体数量与关键值）', () => {
  const bundle = buildMedDataBundle(sampleState(), { exportedBy: 'unit-test', today: '2026-11-12' })
  const state = parseMedDataBundle(bundle)
  assert.equal(state.records.length, 1)
  assert.equal(state.docs.length, 1)
  assert.equal(state.diseaseMetrics.length, 2)
  assert.equal(state.records[0].data_points[0].value, '6.83')
  assert.equal(state.patient_meta.name, '代聪')
})

it('交换包：JSON 字符串往返后仍可解析', () => {
  const bundle = buildMedDataBundle(sampleState(), { exportedBy: 'unit-test', today: '2026-11-12' })
  const state = parseMedDataBundle(JSON.stringify(bundle))
  assert.equal(state.records.length, 1)
})

it('交换包：篡改内容必被指纹拦截', () => {
  const bundle = buildMedDataBundle(sampleState(), { exportedBy: 'unit-test', today: '2026-11-12' })
  const tampered = JSON.parse(JSON.stringify(bundle))
  tampered.payload.records[0].data_points[0].value = '9.99'
  assert.throws(() => parseMedDataBundle(tampered), /fingerprint mismatch/)
})

it('交换包：版本不符必被拒绝', () => {
  const bundle = buildMedDataBundle(sampleState(), { exportedBy: 'unit-test', today: '2026-11-12' })
  const bad = JSON.parse(JSON.stringify(bundle))
  bad.manifest.version = '2.0.0'
  assert.throws(() => parseMedDataBundle(bad), /Unsupported MedData bundle version/)
})

// ---------- 4. 近期指标聚合 ----------
it('指标聚合：同 code 取日期最新，忽略空值', () => {
  const state = {
    records: [
      { date: '2026-09-20', created_at: '2026-09-20T01:00:00Z', data_points: [{ standard_code: 'WBC', value: '6.83', unit: '10^9/L' }] },
      { date: '2026-10-05', created_at: '2026-10-05T01:00:00Z', data_points: [{ standard_code: 'WBC', value: '3.20', unit: '10^9/L' }] },
      { date: '2026-10-06', created_at: '2026-10-06T01:00:00Z', data_points: [{ standard_code: 'WBC', value: '', unit: '10^9/L' }] },
    ],
    diseaseMetrics: [],
  }
  const s = summarizeState(state)
  assert.equal(s.latest.WBC.value, '3.20', `应取 2026-10-05 的值，实际 ${s.latest.WBC.value}`)
  assert.equal(s.latest.WBC.date, '2026-10-05')
  assert.equal(s.latest.WBC.numeric, true)
})

it('指标聚合：同日多份取 created_at 更晚者', () => {
  const state = {
    records: [
      { date: '2026-09-20', created_at: '2026-09-20T01:00:00Z', data_points: [{ standard_code: 'PLT', value: '100' }] },
      { date: '2026-09-20', created_at: '2026-09-20T09:00:00Z', data_points: [{ standard_code: 'PLT', value: '321' }] },
    ],
    diseaseMetrics: [],
  }
  assert.equal(summarizeState(state).latest.PLT.value, '321')
})

it('指标聚合：疾病指标 value=null 视为未测，取上一个有值的', () => {
  const state = {
    records: [],
    diseaseMetrics: [
      { code: 'FCM_MRD_PCT', date: '2026-09-03', value: 0.2, unit: '%', stream: 'fcm' },
      { code: 'FCM_MRD_PCT', date: '2026-10-16', value: null, unit: '%', stream: 'fcm' },
      { code: 'BM_BLAST_PCT', date: '2026-10-10', value: 1.5, unit: '%', stream: 'morph' },
    ],
  }
  const s = summarizeState(state)
  assert.equal(s.latest.FCM_MRD_PCT.value, '0.2')
  assert.equal(s.latest.BM_BLAST_PCT.value, '1.5')
})

it('指标聚合：HGB 别名指向库内标准 code Hb', () => {
  assert.equal(LAB_CODE_ALIASES.HGB, 'Hb')
  const state = {
    records: [{ date: '2026-09-20', data_points: [{ standard_code: 'Hb', value: '113', unit: 'g/L' }] }],
    diseaseMetrics: [],
  }
  const s = summarizeState(state)
  assert.equal(s.latest.Hb.value, '113')
  assert.equal(s.aliases.HGB, 'Hb')
})

it('指标聚合：formatSummaryText 只输出有值的指标行', () => {
  const state = {
    records: [{ date: '2026-09-20', data_points: [{ standard_code: 'WBC', value: '6.83', unit: '10^9/L' }] }],
    diseaseMetrics: [],
  }
  const text = formatSummaryText(summarizeState(state))
  assert.ok(text.includes('白细胞 6.83'), `文本应含白细胞值，实际：${text}`)
  assert.equal(text.split('\n').length, 1, '空指标不应占行')
})

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(50))
console.log(`单元门禁：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('\n失败详情：')
  fails.forEach((f) => console.log(`  FAIL  ${f.name}\n        ${f.err}`))
  process.exit(1)
}
console.log('MedBrief 纯函数门禁全绿（零网络、零磁盘写入）。')
process.exit(0)
