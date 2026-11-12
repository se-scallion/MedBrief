// ===================== MedData 标准病例交换包（Snapshot IS Bundle）=====================
// 纯函数契约：
//   1. buildMedDataBundle(state, options): 将结构化状态（records, docs, diseaseMetrics, patient_meta 等）
//      转换为标准 Manifest + Payload 交换包，嵌入分型卡摘要，并计算基于 SHA-256 的数据指纹防篡改。
//   2. parseMedDataBundle(bundleInput, options): 校验版本与指纹完整性，解析还原为 MedData 规范的 state 对象。
//
// 零浏览器外部依赖，支持浏览器端与 Node.js 离线单测/服务进程无缝运行。

import { buildTypingCard } from './typingCard.js'

export const BUNDLE_FORMAT = 'meddata-bundle'
export const BUNDLE_VERSION = '1.0.0'
export const SCHEMA_VERSION = 1

/**
 * 纯 JS 标准 SHA-256 实现（RFC 6234），保证跨环境（Node/浏览器/Worker）确定性与同步执行
 */
function rawSha256(ascii) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount))
  }

  const mathPow = Math.pow
  const maxWord = mathPow(2, 32)
  const lengthProperty = 'length'
  let i, j
  let result = ''

  const words = []
  const asciiBitLength = ascii[lengthProperty] * 8

  let hash = []
  const k = []
  let primeCounter = 0

  const isComposite = {}
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) {
        isComposite[i] = candidate
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0
    }
  }

  ascii += '\x80'
  while ((ascii[lengthProperty] % 64) - 56) ascii += '\x00'
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i)
    if (j >> 8) return ''
    words[i >> 2] |= j << (((3 - i) % 4) * 8)
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0
  words[words[lengthProperty]] = asciiBitLength

  for (j = 0; j < words[lengthProperty]; ) {
    const w = words.slice(j, (j += 16))
    const oldHash = hash
    hash = hash.slice(0, 8)

    for (i = 0; i < 64; i++) {
      const w15 = w[i - 15]
      const w2 = w[i - 2]

      const a = hash[0]
      const e = hash[4]
      const temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0)

      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]))

      hash = [(temp1 + temp2) | 0].concat(hash)
      hash[4] = (hash[4] + temp1) | 0
    }

    for (i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0
    }
  }

  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255
      result += (b < 16 ? '0' : '') + b.toString(16)
    }
  }
  return result
}

function utf8Encode(str) {
  return unescape(encodeURIComponent(str))
}

/**
 * 对象属性递归排序，生成确定性 Canonical JSON 字符串
 */
export function canonicalJsonStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj)
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJsonStringify).join(',') + ']'
  }
  const keys = Object.keys(obj).sort()
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k]))
  return '{' + entries.join(',') + '}'
}

/**
 * 计算 Payload 确定性 SHA-256 数据指纹
 */
export function computePayloadFingerprint(payload) {
  const canonical = canonicalJsonStringify(payload)
  return rawSha256(utf8Encode(canonical))
}

/**
 * 构建 MedData 标准病例交换包
 * @param {Object} state - MedData 全局状态或局部切片
 * @param {Object} [options] - 打包配置（如 generator, today, notes 等）
 * @returns {{manifest: Object, payload: Object}}
 */
export function buildMedDataBundle(state = {}, options = {}) {
  const patientMeta = state.patient_meta || state.patientMeta || {}
  const records = Array.isArray(state.records) ? state.records : []
  const docs = Array.isArray(state.docs) ? state.docs : []
  const diseaseMetrics = Array.isArray(state.diseaseMetrics) ? state.diseaseMetrics : []
  const events = Array.isArray(state.events) ? state.events : []
  const courses = Array.isArray(state.courses) ? state.courses : []
  const invoices = Array.isArray(state.invoices) ? state.invoices : []
  const stays = Array.isArray(state.stays) ? state.stays : []
  const drugPrices = Array.isArray(state.drugPrices) ? state.drugPrices : []
  const customFields = state.customFields || {}
  const typeCatalog = state.typeCatalog || {}
  const feverThresholds = state.feverThresholds || { low: 37.3, high: 38.5 }

  // 1. 组装干净的 Data Payload
  const payload = {
    patient_meta: patientMeta,
    records,
    docs,
    diseaseMetrics,
    events,
    courses,
    invoices,
    stays,
    drugPrices,
    customFields,
    typeCatalog,
    feverThresholds,
  }

  // 2. 计算确定性数据指纹
  const fingerprint = computePayloadFingerprint(payload)

  // 3. 生成分型卡摘要（嵌入 Manifest，供外部快速识别患者全貌无需全量解包分析）
  let typingSummary = null
  try {
    const card = buildTypingCard(
      {
        patientMeta,
        records,
        docs,
        courses,
        invoices,
        stays,
        diseaseMetrics,
      },
      options.today
    )
    typingSummary = {
      typing: card.typing?.text || '',
      stage: card.stage?.label ? `${card.stage.label} (${card.stage.detail})` : '',
      genes: (card.genes || []).map((g) => g.text),
      hospital: card.hospital || '',
      onset: card.onset?.text || '',
      activeCourse: card.course?.text || '',
      raw: card,
    }
  } catch (err) {
    typingSummary = {
      typing: String(patientMeta.diagnosis || ''),
      error: err.message,
    }
  }

  // 4. 构建 Manifest
  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: options.createdAt || new Date().toISOString(),
    generator: options.generator || 'MedData Core / MedBrief',
    notes: options.notes || '',
    fingerprint,
    counts: {
      records: records.length,
      docs: docs.length,
      diseaseMetrics: diseaseMetrics.length,
      events: events.length,
      courses: courses.length,
      invoices: invoices.length,
      stays: stays.length,
    },
    typingSummary,
  }

  return {
    manifest,
    payload,
  }
}

/**
 * 解析并校验 MedData 标准病例交换包
 * @param {string|Object} bundleInput - JSON 字符串或已解析的对象
 * @param {Object} [options] - 配置项（如 skipVerify: bool）
 * @returns {Object} 还原后的 MedData state 对象，带不可枚举的 _manifest 属性
 */
export function parseMedDataBundle(bundleInput, options = {}) {
  let bundle = bundleInput
  if (typeof bundleInput === 'string') {
    try {
      bundle = JSON.parse(bundleInput)
    } catch (e) {
      throw new Error(`Failed to parse MedData bundle JSON: ${e.message}`)
    }
  }

  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('Invalid MedData bundle: bundle must be a JSON object')
  }

  const { manifest, payload } = bundle
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid MedData bundle: missing manifest')
  }

  if (manifest.format !== BUNDLE_FORMAT) {
    throw new Error(`Invalid MedData bundle format: expected "${BUNDLE_FORMAT}", got "${manifest.format}"`)
  }

  if (!manifest.version || !String(manifest.version).startsWith('1.')) {
    throw new Error(`Unsupported MedData bundle version: ${manifest.version} (supported: ^1.0.0)`)
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid MedData bundle: missing or invalid payload')
  }

  // 完整性校验：重新计算指纹并比对
  const computedFingerprint = computePayloadFingerprint(payload)
  if (!options.skipVerify && manifest.fingerprint) {
    if (computedFingerprint !== manifest.fingerprint) {
      throw new Error(
        `MedData bundle verification failed: fingerprint mismatch (expected ${manifest.fingerprint}, got ${computedFingerprint}). The bundle data may be corrupted or tampered.`
      )
    }
  }

  // 重构标准 MedData state 对象
  const state = {
    patient_meta: payload.patient_meta || payload.patientMeta || {},
    records: Array.isArray(payload.records) ? payload.records : [],
    docs: Array.isArray(payload.docs) ? payload.docs : [],
    diseaseMetrics: Array.isArray(payload.diseaseMetrics) ? payload.diseaseMetrics : [],
    events: Array.isArray(payload.events) ? payload.events : [],
    courses: Array.isArray(payload.courses) ? payload.courses : [],
    invoices: Array.isArray(payload.invoices) ? payload.invoices : [],
    stays: Array.isArray(payload.stays) ? payload.stays : [],
    drugPrices: Array.isArray(payload.drugPrices) ? payload.drugPrices : [],
    customFields: payload.customFields && typeof payload.customFields === 'object' ? payload.customFields : {},
    typeCatalog: payload.typeCatalog && typeof payload.typeCatalog === 'object' ? payload.typeCatalog : {},
    feverThresholds: payload.feverThresholds || { low: 37.3, high: 38.5 },
  }

  // 附加不可枚举的 _manifest 供调用方查阅元信息
  Object.defineProperty(state, '_manifest', {
    value: manifest,
    enumerable: false,
    writable: true,
  })

  return state
}
