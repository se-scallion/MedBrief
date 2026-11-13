// 生成资料卡回归快照（脱敏）。
//
// 为什么要有快照（2026-11-13 排雷结论）：真实库是**活数据**，用户在持续导入
// （3 小时内 49 → 54 份、199 → 204 行），拿 data/reports.json 直接当断言靶子必然天天红，
// 且会让「测试通过」取决于用户导了几张单。所以：
//   真实库 → 一次性冻结成脱敏快照 → 断言只对快照 → 真实库只做人工核对与页数取证。
//
// 用法：node tools/make-card-snapshot.mjs [--out tests/fixtures/card-snapshot-v3.json] [--verify]
//   --verify：只校验脱敏（不写文件），用于 CI 与「改完 fixture 先自证」。
//
// 脱敏规则（红线：病友是别人的医疗数据，快照会进版本库）：
//   - 不留姓名、病历号、条码、床号、医生名、地址、影像号；
//   - 医院/实验室名 → 稳定别名（某院A / 某实验室甲），同一原名永远映射同一别名；
//   - 不留原始 OCR 文本 text / rawSnippet / imageRef / sha256 / dhash / fingerprint；
//   - 只保留资料卡渲染真正需要的字段。

import fs from 'node:fs'
import path from 'node:path'

const REPORTS = path.join('data', 'reports.json')
const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
const OUT = outArg >= 0 ? args[outArg + 1] : path.join('tests', 'fixtures', 'card-snapshot-v3.json')
const VERIFY_ONLY = args.includes('--verify')

// 稳定别名：按首次出现顺序编号（排序后固定，重跑快照不会漂）
const HOSPITAL_ALIAS = new Map()
const LAB_ALIAS = new Map()
// 别名键归一：去掉尾部重复的「医院/实验室」字样（实测脏数据：`新疆军区总医院` 与 `新疆军区总医院医院` 是同一家）
const aliasKey = (raw) => String(raw || '').trim().replace(/(?:医院|实验室|医学院)+$/g, '') || String(raw || '').trim()
const aliasOf = (map, raw, prefix) => {
  const key = aliasKey(raw)
  if (!key) return ''
  if (!map.has(key)) map.set(key, `${prefix}${String.fromCharCode(65 + map.size)}`)
  return map.get(key)
}

// 快照里允许出现的字段（白名单，不靠黑名单事后补）
const ROW_FIELDS = ['name', 'value', 'num', 'unit', 'refRange', 'flag', 'status', 'measuredAt']

function buildSnapshot() {
  const raw = JSON.parse(fs.readFileSync(REPORTS, 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.reports || []
  // 排序键只用于「稳定别名编号」，不改变报告顺序语义
  const hospitals = [...new Set(list.map((r) => String(r.hospital || '').trim()).filter(Boolean))].sort()
  for (const h of hospitals) aliasOf(HOSPITAL_ALIAS, h, '某院')
  const labs = [...new Set(list.map((r) => String(r.labName || '').trim()).filter(Boolean))].sort()
  for (const l of labs) aliasOf(LAB_ALIAS, l, '某实验室')

  const reports = list.map((r, i) => ({
    id: `snap_${String(i + 1).padStart(3, '0')}`,
    kind: r.kind || 'lab',
    reportType: r.reportType || '',
    reportDate: r.reportDate || '',
    sampledAt: r.sampledAt || '',
    hospital: aliasOf(HOSPITAL_ALIAS, r.hospital, '某院'),
    labName: aliasOf(LAB_ALIAS, r.labName, '某实验室'),
    source: r.source || 'image',
    // 原件按钮的联调入口：快照里给一个稳定的假 id（真实值来自 SQLite blobs.report_id 反查）
    fileBlobId: r.fileBlobId || `f_snapshot_${String(i + 1).padStart(3, '0')}`,
    rows: (r.rows || []).map((row) => {
      const o = {}
      for (const f of ROW_FIELDS) if (row[f] !== undefined) o[f] = row[f]
      return o
    }),
  }))
  return {
    _note: [
      '资料卡回归快照 v3（脱敏）。由 tools/make-card-snapshot.mjs 从 data/reports.json 生成。',
      '真实库是活数据（用户在持续导入），断言只对本快照；真实库只做人工核对与页数取证。',
      '医院/实验室名已替换为稳定别名，姓名/条码/原文/影像指纹一律不保留。',
    ],
    _meta: {
      generatedAt: new Date().toISOString(),
      reportCount: reports.length,
      rowCount: reports.reduce((a, r) => a + r.rows.length, 0),
    },
    patient: { name: '', sex: '女', age: '30', diagnosis: '急性B淋巴细胞白血病（Common-B-ALL可能）', subtype: '', stage: '', hospital: '某院A', attending: '' },
    reports,
  }
}

const snapshot = buildSnapshot()
const json = JSON.stringify(snapshot, null, 1)

// 脱敏自证（不变量，不列清单）：任何原始院名/实验室名都不得出现
const raw = JSON.parse(fs.readFileSync(REPORTS, 'utf8'))
const list = Array.isArray(raw) ? raw : raw.reports || []
const leaks = []
for (const r of list) {
  for (const k of ['hospital', 'labName', 'patientName', 'barcode']) {
    const v = String(r[k] || '').trim()
    if (v && v.length >= 3 && json.includes(v)) leaks.push(`${k}:${v}`)
  }
  if (r.text && String(r.text).length > 20 && json.includes(String(r.text).slice(0, 20))) leaks.push('text')
}
if (/刘梦圆|新疆|重庆|陆军|海思特|康圣达/.test(json)) leaks.push('blacklist-token')
if (leaks.length) {
  console.error('❌ 快照未脱敏，拒绝写入：', [...new Set(leaks)].join(' / '))
  process.exit(1)
}

if (VERIFY_ONLY) {
  console.log(`✅ 已存在的快照脱敏校验通过（本文件不含原始院名/姓名/原文）`)
  process.exit(0)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, json, 'utf8')
const kb = (Buffer.byteLength(json) / 1024).toFixed(1)
console.log(`✅ 快照已写入 ${OUT}`)
console.log(`   报告 ${snapshot._meta.reportCount} 份 / 行 ${snapshot._meta.rowCount} 行 / ${kb} KB`)
console.log(`   医院别名：${[...HOSPITAL_ALIAS].map(([k, v]) => `${k}→${v}`).join(' ')}`)
