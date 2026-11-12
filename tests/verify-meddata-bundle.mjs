/**
 * MedData 标准病例交换包（Snapshot IS Bundle）离线单测
 * 覆盖：
 *   1. 空数据打包与还原
 *   2. 真实急淋B（Ph+ ALL-B）多指标全实体打包与还原
 *   3. 分型资料卡摘要嵌入与口径核验
 *   4. 全字段无损对齐（输入态 vs 还原态）
 *   5. 数据指纹 SHA-256 防篡改与校验
 *   6. JSON 序列化与跨端字符串反序列化
 * 用法：node scripts/verify-meddata-bundle.mjs
 */

import { buildMedDataBundle, parseMedDataBundle, computePayloadFingerprint, BUNDLE_FORMAT } from '../src/utils/meddataBundle.js'

let passCount = 0
let failCount = 0

function assert(cond, desc, detail = '') {
  if (cond) {
    passCount++
    console.log(`  ✅ [PASS] ${desc}`)
  } else {
    failCount++
    console.error(`  ❌ [FAIL] ${desc} ${detail ? `(${detail})` : ''}`)
  }
}

console.log('=== 开始执行 MedData Bundle 交换包验证 ===\n')

// ----------------- 测试用例 1：空数据打包与解析 -----------------
console.log('--- Case 1: 空数据打包与解析 ---')
{
  const emptyState = {}
  const bundle = buildMedDataBundle(emptyState, {
    generator: 'TestRunner-Empty',
    createdAt: '2026-11-11T00:00:00.000Z',
  })

  assert(bundle && bundle.manifest && bundle.payload, '返回结构包含 manifest 与 payload')
  assert(bundle.manifest.format === BUNDLE_FORMAT, 'manifest.format 正确')
  assert(typeof bundle.manifest.fingerprint === 'string' && bundle.manifest.fingerprint.length === 64, '生成 64 位 SHA-256 指纹')
  assert(bundle.manifest.counts.records === 0, 'records 计数为 0')
  assert(bundle.manifest.counts.docs === 0, 'docs 计数为 0')

  const parsed = parseMedDataBundle(bundle)
  assert(Array.isArray(parsed.records) && parsed.records.length === 0, '解析后 records 为空数组')
  assert(Array.isArray(parsed.docs) && parsed.docs.length === 0, '解析后 docs 为空数组')
  assert(parsed.patient_meta && typeof parsed.patient_meta === 'object', '解析后 patient_meta 存在')
  assert(parsed._manifest && parsed._manifest.format === BUNDLE_FORMAT, '_manifest 元数据挂载成功')
}

// ----------------- 测试用例 2：真实急淋B（ALL-B, Ph+）多指标打包 -----------------
console.log('\n--- Case 2: 真实急淋B（ALL-B, Ph+）多指标全实体打包与分型卡生成 ---')
{
  const realisticState = {
    patient_meta: {
      name: '张小明',
      age: 28,
      gender: 'Male',
      diagnosis: '急性淋巴细胞白血病',
    },
    records: [
      {
        id: 'rec_cbc_01',
        date: '2026-08-01',
        report_type: 'CBC',
        data_points: [
          { standard_code: 'WBC', original_name: '白细胞计数', value: '1.82', unit: '10^9/L', ref_range: '3.5-9.5', arrow: 'L' },
          { standard_code: 'Hb', original_name: '血红蛋白', value: '95', unit: 'g/L', ref_range: '130-175', arrow: 'L' },
          { standard_code: 'PLT', original_name: '血小板计数', value: '45', unit: '10^9/L', ref_range: '125-350', arrow: 'L' },
        ],
        notes: '化疗后骨髓抑制期复查',
      },
    ],
    docs: [
      {
        id: 'doc_bm_01',
        date: '2026-08-05',
        title: '骨髓细胞学检查报告',
        doc_type: '骨髓穿刺',
        category: 'exam',
        findings: '骨髓有核细胞增生低下，原幼淋巴细胞占 1.5%。',
        conclusion: '骨髓象：完全缓解（CR）骨髓象。',
      },
      {
        id: 'doc_fcm_01',
        date: '2026-08-05',
        title: '流式细胞术微小残留病变检测',
        doc_type: '微小残留病',
        category: 'exam',
        findings: '分析 500,000 个有核细胞，未见异常幼稚 B 淋巴细胞表型。',
        conclusion: 'FCM-MRD 未检出（<0.01%）。',
      },
      {
        id: 'doc_pcr_01',
        date: '2026-08-06',
        title: 'BCR-ABL1 (p190) 融合基因转录本定量检测',
        doc_type: '融合基因',
        category: 'exam',
        findings: 'BCR-ABL1/ABL1 拷贝比值 = 0.008%。',
        conclusion: '获得主要分子学反应（MMR）。',
      },
      {
        id: 'doc_case_01',
        date: '2026-08-10',
        title: '出院记录',
        category: 'case',
        fields: {
          department: '血液内科',
          diagnosis: '急性淋巴细胞白血病（Ph+，B-ALL）',
          discharge_diagnosis: '急性淋巴细胞白血病（Ph+，B-ALL）',
        },
      },
    ],
    diseaseMetrics: [
      {
        id: 'm_morph_01',
        stream: 'morph',
        code: 'BM_BLAST',
        analyte: 'blast',
        specimen: 'bm',
        date: '2026-08-05',
        value: 1.5,
        qualifier: null,
        unit: '%',
      },
      {
        id: 'm_fcm_01',
        stream: 'fcm',
        code: 'FCM_MRD',
        analyte: 'mrd',
        specimen: 'bm',
        date: '2026-08-05',
        value: 0,
        qualifier: 'nd',
        unit: '%',
      },
      {
        id: 'm_pcr_01',
        stream: 'pcr',
        code: 'BCR_ABL1_P190',
        analyte: 'P190',
        specimen: 'bm',
        date: '2026-08-06',
        value: 0.008,
        qualifier: null,
        unit: '%',
      },
    ],
    courses: [
      { id: 'c1', name: '诱导化疗 (VDCLP)', start: '2026-07-01', end: '2026-07-28' },
      { id: 'c2', name: '巩固治疗 (CAM)', start: '2026-08-01', end: '' },
    ],
    events: [
      { id: 'ev_01', date: '2026-08-02', kind: 'med', name: '达沙替尼片', dose: '100mg' },
    ],
    invoices: [
      { id: 'inv_01', issued_at: '2026-08-10', hospital: '北京大学人民医院', hospital_short: '北大人民', amount: 15420.5 },
    ],
    stays: [
      { id: 'stay_01', start: '2026-07-01', end: '2026-07-28', total: 12000, note: '一疗程住院' },
    ],
  }

  const bundle = buildMedDataBundle(realisticState, {
    generator: 'MedData-ALL-B-Test',
    today: '2026-08-12',
  })

  // 1. 基础结构断言
  assert(bundle.manifest.counts.records === 1, 'records 计数正确 (1)')
  assert(bundle.manifest.counts.docs === 4, 'docs 计数正确 (4)')
  assert(bundle.manifest.counts.diseaseMetrics === 3, 'diseaseMetrics 计数正确 (3)')
  assert(bundle.manifest.counts.courses === 2, 'courses 计数正确 (2)')

  // 2. 分型卡摘要断言
  const summary = bundle.manifest.typingSummary
  assert(summary && typeof summary === 'object', '分型摘要成功嵌入 manifest')
  assert(summary.typing && summary.typing.includes('Ph+'), `分型包含 Ph+ 状态: "${summary.typing}"`)
  assert(summary.hospital === '北大人民', `就诊医院识别为发票简称: "${summary.hospital}"`)
  assert(summary.stage && summary.stage.includes('形态'), `缓解阶段包含三维信息: "${summary.stage}"`)
  assert(Array.isArray(summary.genes) && summary.genes.some((g) => g.includes('BCR-ABL1')), '基因标签正确抽取主标志物 BCR-ABL1')

  // 3. 全量序列化与反序列化解析断言
  const bundleJsonString = JSON.stringify(bundle)
  const restoredState = parseMedDataBundle(bundleJsonString)

  // 4. 全字段无损对齐深度比对
  assert(restoredState.patient_meta.name === '张小明', '患者姓名无损还原')
  assert(restoredState.patient_meta.age === 28, '患者年龄无损还原')
  assert(restoredState.records.length === 1, 'records 长度一致')
  assert(restoredState.records[0].data_points.length === 3, 'data_points 长度一致')
  assert(restoredState.records[0].data_points[0].value === '1.82', 'WBC 数值无损保留')
  assert(restoredState.docs.length === 4, 'docs 长度一致')
  assert(restoredState.diseaseMetrics.length === 3, 'diseaseMetrics 长度一致')
  assert(restoredState.diseaseMetrics[2].value === 0.008, 'p190 定量数值精准还原')
  assert(restoredState.courses.length === 2, 'courses 长度一致')
  assert(restoredState.stays.length === 1, 'stays 长度一致')
}

// ----------------- 测试用例 3：指纹计算防篡改与完整性校验 -----------------
console.log('\n--- Case 3: 指纹计算防篡改与完整性校验 ---')
{
  const state = {
    patient_meta: { name: '李四', age: 40 },
    records: [{ id: 'r1', date: '2026-09-01', data_points: [{ standard_code: 'PLT', value: '100' }] }],
  }

  const bundle = buildMedDataBundle(state)
  const initialFingerprint = bundle.manifest.fingerprint

  // 1. 未篡改情况下正常通过
  let verified = false
  try {
    const s = parseMedDataBundle(bundle)
    verified = s.patient_meta.name === '李四'
  } catch {
    verified = false
  }
  assert(verified, '未篡改时正常解析并通过指纹校验')

  // 2. 篡改 Payload 中的一个指标数值
  const tamperedBundle = JSON.parse(JSON.stringify(bundle))
  tamperedBundle.payload.records[0].data_points[0].value = '999' // 篡改数值

  let caughtError = null
  try {
    parseMedDataBundle(tamperedBundle)
  } catch (err) {
    caughtError = err
  }
  assert(caughtError !== null, '篡改 Payload 后成功拦截并抛出错误')
  assert(
    caughtError && caughtError.message.includes('fingerprint mismatch'),
    `错误信息明确指示指纹不匹配: "${caughtError && caughtError.message}"`
  )

  // 3. 使用 skipVerify 绕过校验选项
  let bypassed = false
  try {
    const s = parseMedDataBundle(tamperedBundle, { skipVerify: true })
    bypassed = s.records[0].data_points[0].value === '999'
  } catch {
    bypassed = false
  }
  assert(bypassed, '指定 skipVerify: true 时可安全跳过校验')

  // 4. 验证格式错误拦截
  let formatError = null
  try {
    parseMedDataBundle({ manifest: { format: 'wrong-format', version: '1.0.0' }, payload: {} })
  } catch (e) {
    formatError = e
  }
  assert(formatError && formatError.message.includes('Invalid MedData bundle format'), '非标准格式交换包被正确拒绝')
}

console.log(`\n=== 验证完成：PASS ${passCount} | FAIL ${failCount} ===`)
if (failCount > 0) {
  process.exit(1)
} else {
  console.log('🎉 所有 MedData Bundle 交换包断言全部通过！')
  process.exit(0)
}
