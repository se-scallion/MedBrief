// 真实文档回归：用户亲自发来的那份 PDF（染色体核型报告）必须被判对。
//
// 背景（2026-11-15 用户原话）：「我发给你文件，就是让你测试的。你就测试好呗。你还让我去测吗？测了还是不行。」
// 之前两次都是「我改完 -> 让用户去试 -> 又不行」，根因有两个：
//   ① 判定链写在 server.mjs 里，测试只能测到 lib 的碎片，测的不是跑的那份；
//   ② 没有拿用户的真文件当断言基线，只能靠人工复验。
// 本文件两件事一起办：判定链抽进 lib/reportTypeDetect.mjs（detectReportType）后由这里断言，
// 并且**直接读那份真 PDF**做端到端断言（文件不存在时 SKIP，不假装通过）。
//
// 隐私：只打印「类型 / 日期 / 医院 / 是否抽到条码」这类派生结论，不打印任何患者原文与姓名。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readPdf } from '../lib/pdfIntake.mjs'
import { detectReportType, buildTypeRowIndex } from '../lib/reportTypeDetect.mjs'
import { guessMeta } from '../lib/reportMeta.mjs'
import { classifyReport } from '../lib/reportClassify.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`PASS ${name}${extra ? ' · ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`FAIL ${name}${extra ? ' · ' + extra : ''}`)
  }
}
const skip = (name, why) => console.log(`SKIP ${name} · ${why}`)

// ---------------------------------------------------------------- 一、判定链单测（离线）
// 事故原句：核型报告的结论里写着「t(9;22) 易位形成 BCR::ABL 融合基因」——
// 正文关键词法会把它判成「融合基因」，标题法必须压住正文。
const INCIDENT = [
  '乌鲁木齐康圣达医学检验实验室',
  '染色体核型分析报告单',
  ' 临床诊断(Diagnosis)：AL?',
  '检测结果(ISCN 2024)',
  '结果描述：2个核型：t(9;22)；5个核型：9p-,t(9;22),15q+,16q+；13个核型：正常核型。',
  '结论：t(9;22) 易位形成 BCR::ABL 融合基因，提示 CML/Ph+ ALL。',
].join('\n')

const bodyKeyword = ({ text }) => (/融合基因/.test(text) ? { reportType: '融合基因', kind: 'lab' } : null)
{
  const r = detectReportType(INCIDENT, [], { rowIndex: null, bodyClassify: bodyKeyword })
  ok('① 标题压住正文：核型报告不被正文里的「融合基因」拽走', r?.reportType === '染色体核型', `判成「${r?.reportType}」（evidence=${r?.evidence}）`)
  ok('①-a kind 同步为病理/骨穿类', r?.kind === 'pathology', `kind=${r?.kind}`)
}
{
  // 没有标题行时，才轮到正文兜底
  const noTitle = INCIDENT.split('\n').filter((l) => !/核型分析报告单/.test(l)).join('\n')
  const r = detectReportType(noTitle, [], { rowIndex: null, bodyClassify: bodyKeyword })
  ok('② 标题缺失 -> 正文兜底才生效', !!r, `判成「${r?.reportType || '空'}」（evidence=${r?.evidence}）`)
}
{
  // 项目集反推：标题判不出、但指标行与历史同类型高度重合
  const index = buildTypeRowIndex([
    { reportType: '血常规', rows: [{ name: '白细胞' }, { name: '血红蛋白' }, { name: '血小板' }, { name: '中性粒细胞' }] },
  ])
  const rows = [{ name: '白细胞' }, { name: '血红蛋白' }, { name: '血小板' }]
  const r = detectReportType('患者信息\n报告单号 P2026001\n', rows, { rowIndex: index, bodyClassify: null })
  ok('③ 无标题 -> 项目集反推命中「血常规」', r?.reportType === '血常规' && r?.evidence === 'rows', `判成「${r?.reportType}」（evidence=${r?.evidence}）`)
}
{
  // 全无线索时必须返回 null，不许瞎猜
  ok('④ 无线索 -> null（不瞎猜）', detectReportType('这是随便一段话，没有任何医学信息。', [], {}) === null)
}

// ---------------------------------------------------------------- 二、真 PDF 端到端
// 文件查找顺序：环境变量 -> ds-bot 附件目录（用户上传留下的只读副本）
const PDF_NAME = 'V020089_刘梦圆_新疆_新疆军区总医院_血液科_血液_MaYo骨髓染色体核型分_2026072318053636.pdf'
function findRealPdf() {
  const cands = []
  if (process.env.MEDBRIEF_REAL_PDF) cands.push(process.env.MEDBRIEF_REAL_PDF)
  const root = path.join(os.homedir(), 'Documents/projects/ds-bot/home/attachments/v1/files')
  const walk = (dir, depth = 0) => {
    if (depth > 4 || !fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === PDF_NAME) cands.push(p)
    }
  }
  walk(root)
  return cands.find((p) => fs.existsSync(p)) || ''
}

const pdfPath = findRealPdf()
if (!pdfPath) {
  skip('真 PDF 端到端', `找不到 ${PDF_NAME}（可用 MEDBRIEF_REAL_PDF=<路径> 指定）`)
} else {
  const parsed = await readPdf(fs.readFileSync(pdfPath), { maxPages: 5 })
  const text = (parsed.pages || []).map((p) => p.text).join('\n')
  ok('真 PDF：解析出文字层', parsed.mode === 'text' && text.length > 200, `${parsed.pageCount} 页 / ${text.length} 字 / mode=${parsed.mode}`)

  // 判定链与 server 完全同一份实现（server 现在调 detectReportType）
  const type = detectReportType(text, [], { rowIndex: null, bodyClassify: classifyReport })
  ok('真 PDF：报告类型 = 染色体核型', type?.reportType === '染色体核型', `判成「${type?.reportType}」（evidence=${type?.evidence}）`)

  // 已知医院名单用真实库（server 里也是这样喂给 guessMeta 的）
  let knownHospitals = []
  try {
    const store = JSON.parse(fs.readFileSync(new URL('../data/reports.json', import.meta.url), 'utf8'))
    knownHospitals = Array.from(new Set((store.reports || []).map((r) => r.hospital).filter(Boolean)))
  } catch { knownHospitals = [] }
  const meta = guessMeta(text, [], {
    classifyReport: ({ text: t, rows }) => detectReportType(t, rows, { bodyClassify: classifyReport }),
    knownHospitals,
  })
  ok('真 PDF：表单项 meta 带出报告类型（前端才填得上）', meta?.reportType === '染色体核型', `meta.reportType=${meta?.reportType || '空'}`)
  ok('真 PDF：报告日期 = 2026-07-17（采集 07-15，取报告口径）', meta?.reportDate === '2026-07-17', `reportDate=${meta?.reportDate} / sampledAt=${meta?.sampledAt || '空'} / ${meta?.dateSource}`)
  ok('真 PDF：医院取「就诊医院」标签值', meta?.hospital === '新疆军区总医院', `hospital=${meta?.hospital || '空'}`)
  ok('真 PDF：条码抽到（形态 V+数字）', /^V\d{8,}$/.test(meta?.barcode || ''), `barcode 长度 ${(meta?.barcode || '').length}`)

  // 没有已知医院名单时不能崩：退回第一个候选（抬头上的检验实验室），并如实说明
  const bare = guessMeta(text, [], { classifyReport: () => null, knownHospitals: [] })
  ok('真 PDF：无已知医院名单时退回首个候选（不崩、不空）', !!bare?.hospital, `退回「${bare?.hospital || '空'}」`)
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
