// ===================== MedBrief 独立工作台端到端验证 =====================
// 直连 http://localhost:5174 进行真实 HTTP 接口调用与流程断言
// 覆盖：
//   测试 1：服务探活
//   测试 2：排班查询（朝阳医院 血液科 主鸿鹄）
//   测试 3：身份证校验（代聪 511025199605011511）
//   测试 4：预约主鸿鹄普通空号，断言凭证完整性
//   测试 5：病历录入与 MedData 标准交换包生成及 SHA-256 校验
//   测试 6：取消订单与号源回滚
// 运行：npm run test:live（= node tests/verify-e2e.mjs）；需 5174 已启动

import { strict as assert } from 'node:assert'
import http from 'node:http'

const BASE = 'http://localhost:5174'
let passCount = 0
let failCount = 0
const fails = []

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passCount++
    console.log(`PASS  ${name}`)
  }).catch((e) => {
    failCount++
    fails.push({ name, err: e.message })
    console.error(`FAIL  ${name}  →  ${e.message}`)
  })
}

async function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path)
    const payload = body ? JSON.stringify(body) : null
    const opts = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }
    const r = http.request(opts, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

console.log('=== MedBrief 独立工作台端到端验证 ===\n')
console.log(`目标服务: ${BASE}\n`)

// 预约成功后保留 orderId 用于后续取消测试
let bookedOrderId = null

// ===== 测试 1 =====
await test('测试 1：服务探活 /api/health', async () => {
  const { status, body } = await req('GET', '/api/health')
  assert.equal(status, 200, `HTTP状态码应为200，实际 ${status}`)
  assert.ok(body.ok, 'ok 应为 true')
  assert.equal(body.app, 'medbrief', `app 字段应为 medbrief，实际 ${body.app}`)
  assert.ok(body.port === 5174, `端口应为 5174，实际 ${body.port}`)
  console.log(`      服务名称: ${body.name}，端口: ${body.port}`)
})

// ===== 测试 2 =====
await test('测试 2：排班查询 — 朝阳医院 血液科 主鸿鹄', async () => {
  const { status, body } = await req(
    'GET',
    '/api/guahao/schedule?hospital=%E5%8C%97%E4%BA%AC%E6%9C%9D%E9%98%B3%E5%8C%BB%E9%99%A2&department=%E8%A1%80%E6%B6%B2%E7%A7%91&doctorName=%E4%B8%BB%E9%B8%BF%E9%B9%84&date=2026-11-16'
  )
  assert.equal(status, 200)
  assert.ok(body.ok, `查询失败: ${body.error || '未知错误'}`)
  const doctors = body.doctors || []
  assert.ok(doctors.length >= 1, `应返回至少 1 位医生，实际 ${doctors.length}`)
  const zhh = doctors.find(d => d.name === '主鸿鹄')
  assert.ok(zhh, '应包含主鸿鹄医生')
  assert.ok(zhh.slots && zhh.slots.length > 0, '主鸿鹄应有排班号源')
  const normalSlot = zhh.slots.find(s => s.type === 'normal' && s.remaining > 0)
  assert.ok(normalSlot, '主鸿鹄应有可用普通号')
  assert.ok(normalSlot.fee === 50, `普通号挂号费应为50元，实际 ${normalSlot.fee}`)
  console.log(`      主鸿鹄普通号剩余: ${normalSlot.remaining}，就诊时段: ${normalSlot.visitTimeSlot || normalSlot.timeSlot || normalSlot.periodLabel}`)
})

// ===== 测试 3 =====
await test('测试 3：身份证校验 — 代聪 511025199605011511 应合法', async () => {
  // 错误身份证应被拒绝
  const { body: badBody } = await req('POST', '/api/guahao/book', {
    patientName: '代聪', idCard: '123456', hospital: '北京朝阳医院',
    department: '血液科', doctorName: '主鸿鹄',
  })
  assert.ok(!badBody.ok, '错误身份证应校验失败')
  assert.ok(badBody.error && badBody.error.length > 0, '应返回错误信息')

  // 合法身份证应预约成功（先重置保证号源充足）
  await req('POST', '/api/guahao/reset', {})
  const { body: goodBody } = await req('POST', '/api/guahao/book', {
    patientName: '代聪', idCard: '511025199605011511', phone: '13800100114',
    hospital: '北京朝阳医院', department: '血液科', doctorName: '主鸿鹄',
    slotType: 'normal', period: 'morning',
  })
  assert.ok(goodBody.ok, `合法身份证预约应成功，错误: ${goodBody.error || ''}`)
  const tmpId = goodBody.voucher?.orderId
  console.log(`      合法身份证预约测试订单: ${tmpId}`)
  // 取消释放号源
  if (tmpId) await req('POST', '/api/guahao/cancel', { orderId: tmpId })
})

// ===== 测试 4 =====
await test('测试 4：预约主鸿鹄普通空号 — 断言凭证完整性', async () => {
  // 重置确保号源充足
  await req('POST', '/api/guahao/reset', {})

  const { body } = await req('POST', '/api/guahao/book', {
    patientName: '代聪',
    idCard: '511025199605011511',
    phone: '13800100114',
    hospital: '北京朝阳医院',
    department: '血液科',
    doctorName: '主鸿鹄',
    slotType: 'normal',
    period: 'morning',
  })
  assert.ok(body.ok, `预约应成功，错误: ${body.error || ''}`)

  // 返回结构：{ ok, orderId, message, voucher, slot }
  const voucher = body.voucher
  assert.ok(voucher, 'voucher 字段不应为空')
  assert.ok(voucher.orderId && voucher.orderId.startsWith('GH'), `订单号应以 GH 开头，实际: ${voucher.orderId}`)
  assert.equal(voucher.patientName, '代聪', `就诊人应为代聪，实际: ${voucher.patientName}`)
  assert.equal(voucher.doctorName, '主鸿鹄', `医生应为主鸿鹄，实际: ${voucher.doctorName}`)
  assert.ok(voucher.location && voucher.location.includes('朝阳医院'),
    `就诊地点应包含朝阳医院，实际: ${voucher.location}`)
  assert.ok(voucher.queueNumber, `应有排队序号，实际: ${voucher.queueNumber}`)
  const timeSlot = voucher.visitTimeSlot || voucher.timeSlot
  assert.ok(timeSlot, `应有就诊时段字段（visitTimeSlot or timeSlot）`)
  assert.ok(voucher.fee === 50, `挂号费应为50元，实际: ${voucher.fee}`)
  assert.equal(voucher.status, 'CONFIRMED', `状态应为CONFIRMED，实际: ${voucher.status}`)

  bookedOrderId = voucher.orderId
  console.log(`      预约成功: ${voucher.orderId}  序号: ${voucher.queueNumber}  时段: ${timeSlot}`)
  console.log(`      就诊地点: ${voucher.location}`)
})

// ===== 测试 5 =====
await test('测试 5：病历录入与 MedData 标准交换包生成及 SHA-256 校验', async () => {
  const { body } = await req('POST', '/api/brief/bundle', {
    patientName: '代聪',
    diseaseType: 'B-ALL',
    chiefComplaint: '发热、乏力 2 周，骨穿确诊急淋 B-ALL',
    history: '2026-01-15 确诊 B-ALL，已完成 VDLP+环磷酰胺 2 疗程，流式 MRD 0.1%',
    recentData: 'WBC 2.1×10⁹/L，PLT 68×10⁹/L，骨髓 MRD 流式 0.07%',
    question: '请问下一步是否需要 CAR-T 治疗？MRD 转阴后如何巩固？',
  })
  assert.ok(body.ok, `生成交换包应成功，错误: ${body.error || ''}`)
  assert.ok(body.sha256 && body.sha256.length === 64, `SHA-256/fingerprint 应为64字符十六进制，实际: ${body.sha256}`)
  assert.ok(body.schemaVersion, `应有 schemaVersion 字段，实际: ${body.schemaVersion}`)
  assert.ok(body.bundle && body.bundle.manifest, 'bundle.manifest 不应为空')
  // manifest 字段名为 fingerprint（本 lib 版本），server 映射为 sha256 返回
  const manifestFingerprint = body.bundle.manifest.fingerprint || body.bundle.manifest.sha256
  assert.equal(manifestFingerprint, body.sha256, 'manifest fingerprint 与返回的 sha256 应一致')
  assert.ok(body.filename && body.filename.endsWith('.meddata'), `文件名应以 .meddata 结尾，实际: ${body.filename}`)
  console.log(`      SHA-256: ${body.sha256.slice(0, 20)}...`)
  console.log(`      文件名: ${body.filename}`)
})

// ===== 测试 6 =====
await test('测试 6：取消订单与号源回滚', async () => {
  assert.ok(bookedOrderId, '测试4中应产出已确认的订单号')

  // 记录取消前剩余
  const { body: before } = await req(
    'GET',
    '/api/guahao/schedule?hospital=%E5%8C%97%E4%BA%AC%E6%9C%9D%E9%98%B3%E5%8C%BB%E9%99%A2&department=%E8%A1%80%E6%B6%B2%E7%A7%91&doctorName=%E4%B8%BB%E9%B8%BF%E9%B9%84&date=2026-11-16'
  )
  const zhhBefore = before.doctors?.find(d => d.name === '主鸿鹄')
  const slotBefore = zhhBefore?.slots.find(s => s.type === 'normal' && s.period === 'morning')
  const remainBefore = slotBefore?.remaining ?? 0
  console.log(`      取消前剩余: ${remainBefore}`)

  // 执行取消
  const { body } = await req('POST', '/api/guahao/cancel', { orderId: bookedOrderId })
  assert.ok(body.ok, `取消应成功，错误: ${body.error || ''}`)
  // cancelOrder 返回 { ok, orderId, message, slotRestored, order }
  assert.equal(body.order?.status, 'CANCELLED', `状态应变为CANCELLED，实际: ${body.order?.status}`)
  assert.ok(body.slotRestored === true, '号源回滚标记 slotRestored 应为 true')

  // 确认号源回滚
  const { body: after } = await req(
    'GET',
    '/api/guahao/schedule?hospital=%E5%8C%97%E4%BA%AC%E6%9C%9D%E9%98%B3%E5%8C%BB%E9%99%A2&department=%E8%A1%80%E6%B6%B2%E7%A7%91&doctorName=%E4%B8%BB%E9%B8%BF%E9%B9%84&date=2026-11-16'
  )
  const zhhAfter = after.doctors?.find(d => d.name === '主鸿鹄')
  const slotAfter = zhhAfter?.slots.find(s => s.type === 'normal' && s.period === 'morning')
  const remainAfter = slotAfter?.remaining ?? 0
  assert.ok(remainAfter > remainBefore, `取消后剩余(${remainAfter})应多于取消前(${remainBefore})`)
  console.log(`      取消后剩余: ${remainAfter}（号源已回滚）`)
  bookedOrderId = null
})

// ===== 结果汇总 =====
console.log('\n' + '='.repeat(50))
console.log(`结果：${passCount} 通过 / ${failCount} 失败`)
if (failCount > 0) {
  console.log('\n失败详情：')
  fails.forEach(f => console.log(`  FAIL  ${f.name}\n        ${f.err}`))
  console.log('')
  process.exit(1)
} else {
  console.log('\n所有测试通过。MedBrief 独立工作台全流程验证完毕。')
  console.log(`\n访问地址: http://localhost:5174`)
  process.exit(0)
}
