#!/usr/bin/env node
// ===================== 114 挂号命令行脚本 =====================
// 把「登录 → 图形验证码 → 短信验证码 → 就诊人校验 → 选号 → 提交」固化为一次命令。
//
// 用法（在项目根目录运行）：
//   node tools/browser-guahao.mjs --phone <11位手机号> \
//        --hos-code H02110002 --dept1-code yygh_NK_4d2b43fd_vir --dept2-code 4011301 \
//        --patient-name 代聪 --doctor 张三 --date 2026-11-20
//
// 常用开关：
//   --no-auto-submit    即使指定医生也停下等确认
//   --list-hospitals    只拉医院列表首屏（不必登录）
//   --search-hospital <关键词>  按关键词搜医院（写本地目录，可加 --save）
//   --list-depts <hosCode>  拉某医院科室树（不必登录）
//   --solver-check <png>    只跑验证码识别（自检用）
//
// 退出码：0 成功；1 失败；2 被 WAF 拦截；3 需要人工处理（就诊人/确认/验证码）

import readline from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Guahao114Flow, STAGES } from '../lib/guahao114Flow.js'
import { egoFetchHospitals, egoFetchDepts } from '../lib/egoDriver.js'
import { createCatalogStore } from '../lib/catalogStore.js'
import { solveCaptcha, captchaConfig } from '../lib/captchaSolver.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()) }))
}

function usage() {
  console.log(`
114 挂号命令行脚本

必填（真实下单）：
  --phone <11位手机号>
  --hos-code <医院编码>      例：H02110002
  --dept1-code <一级科室>     例：yygh_NK_4d2b43fd_vir
  --dept2-code <二级科室>     例：4011301
可选：
  --patient-name <姓名>       就诊人姓名（默认读 config 或环境变量）
  --doctor <医生姓名>         指定后默认直接提交（平台预约不扣费）
  --date <YYYY-MM-DD>         目标就诊日期
  --no-auto-submit            指定医生也停下等确认

免登录工具：
  --list-hospitals            列出医院（code + 名称）
  --list-depts <hosCode>      列出科室树
  --solver-check <png>        只跑验证码识别自检
`)
}

async function listHospitals() {
  const r = await egoFetchHospitals()
  if (!r.ok) {
    console.error(`医院列表获取失败：${r.error}`)
    return 2
  }
  const { httpStatus, payload } = r.result
  if (httpStatus !== 200) {
    console.error(`医院列表获取失败：HTTP ${httpStatus}（瑞数 WAF 拦截）`)
    return 2
  }
  if (!payload || payload.code !== '0000') {
    console.error(
      `医院列表业务层拒绝：code=${payload && payload.code} ${(payload && payload.message) || ''}\n` +
        `该接口需要站点自身注入的瑞数令牌参数，脚本无法复现。请直接使用医院编码（hosCode）。\n` +
        `可用 --list-depts <hosCode> 拉科室树验证编码是否有效。`,
    )
    return 3
  }
  const list = payload.data.list || []
  console.log(`共 ${payload.data.branchCount || list.length} 家（count=${payload.data.count}）`)
  for (const h of list) {
    console.log(`${h.code}\t${h.name}\t${h.levelText || ''}\t放号:${h.openTimeText || '-'}\t可在线支付:${h.onlinePayable}`)
  }
  return 0
}

async function listDepts(hosCode) {
  const r = await egoFetchDepts({ hosCode })
  if (!r.ok) {
    console.error(`科室列表获取失败：${r.error}`)
    return 2
  }
  const { httpStatus, payload } = r.result
  if (httpStatus !== 200 || !payload || payload.code !== '0000') {
    console.error(`科室列表获取失败：HTTP ${httpStatus} code=${payload && payload.code} ${(payload && payload.message) || ''}`)
    return httpStatus >= 400 ? 2 : 1
  }
  for (const d1 of payload.data || []) {
    console.log(`${d1.code}\t${d1.name}\tadvanceDay=${d1.advanceDay}`)
    for (const d2 of d1.subList || []) {
      console.log(`  ${d2.code}\t${d2.name}`)
    }
  }
  return 0
}

async function searchHospital(keyword, { save = false } = {}) {
  const store = createCatalogStore()
  const list = await store.searchHospitals(keyword)
  if (!list.length) {
    console.log(`关键词「${keyword}」无匹配医院`)
    return 3
  }
  console.log(`关键词「${keyword}」命中 ${list.length} 家：`)
  for (const h of list) console.log(`${h.code}\t${h.name}`)
  if (save) {
    const r = store.mergeHospitals(
      list.map((h) => ({ code: h.code, name: h.name })),
      { source: 'search/query' },
    )
    console.log(`\n已合并进本地目录：新增 ${r.added.length}，补全 ${r.updated.length}，当前共 ${r.total} 条`)
    console.log(`目录文件：${store.baseDir}/hospitals.json`)
  } else {
    console.log('\n（未写盘；加 --save 合并进本地目录）')
  }
  return 0
}

async function solverCheck(png) {
  const file = path.resolve(png)
  if (!fs.existsSync(file)) {
    console.error(`文件不存在：${file}`)
    return 1
  }
  console.log(`验证码识别自检：${file}`)
  console.log(`视觉模型端点：${captchaConfig.visionEndpoint}  模型：${captchaConfig.visionModel}`)
  const r = await solveCaptcha(file, { allowAI: true })
  for (const a of r.attempts) console.log(`  ${a.method}: ${a.code || '失败'}${a.error ? ' (' + a.error + ')' : ''}`)
  console.log(`最终结果：${r.code || '需人工填入'}（来源：${r.method}）`)
  return r.code ? 0 : 3
}

async function main() {
  if (args.help || args.h) { usage(); return 0 }
  if (args['list-hospitals']) return await listHospitals()
  if (args['list-depts']) return await listDepts(String(args['list-depts']))
  if (args['search-hospital']) return await searchHospital(String(args['search-hospital']), { save: !!args.save })
  if (args['solver-check']) return await solverCheck(String(args['solver-check']))

  const phone = String(args.phone || process.env.MEDBRIEF_114_PHONE || '').trim()
  const target = {
    hospital: args.hospital ? String(args.hospital) : undefined,
    hosCode: args['hos-code'] ? String(args['hos-code']) : undefined,
    dept1Code: args['dept1-code'] ? String(args['dept1-code']) : undefined,
    dept2Code: args['dept2-code'] ? String(args['dept2-code']) : undefined,
    doctor: args.doctor ? String(args.doctor) : '',
    date: args.date ? String(args.date) : '',
  }
  const patient = { name: args['patient-name'] ? String(args['patient-name']) : '' }

  if (!phone || !target.hosCode || !target.dept1Code || !target.dept2Code) {
    console.error('缺少必填参数。用 --help 查看用法。')
    return 1
  }

  const flow = new Guahao114Flow({
    phone,
    target,
    patient,
    autoSubmitWithDoctor: !args['no-auto-submit'],
    artifactsDir: path.join(ROOT, 'data', '114-flow'),
  })

  flow.on('stage', ({ stage, detail }) => {
    console.log(`\n▸ [${stage}] ${detail || ''}`)
  })
  flow.on('log', (line) => console.log(`  ${line}`))
  flow.on('captcha', async ({ imagePath }) => {
    console.log(`\n⚠ 图形验证码自动识别失败，请打开图片查看：${imagePath}`)
    const code = await ask('请输入 4 位图形验证码：')
    flow.submitCaptchaCode(code)
  })
  flow.on('needConfirm', async ({ slot }) => {
    console.log(`\n⚠ 待确认号源：${slot.label || slot.date || ''}（医生：${slot.doctorName || '不限'}）`)
    const ans = await ask('确认提交预约？(y/N) ')
    flow.submitConfirm(/^y(es)?$/i.test(ans))
  })
  flow.on('needPay', ({ fee }) => {
    console.log(`\n⚠ 该号源需在线支付（¥${fee ?? '未知'}），已停下。请在浏览器中确认。`)
  })
  flow.on('needPatient', ({ wantName }) => {
    console.log(`\n⚠ 未找到就诊人「${wantName}」。请先在 114 完成就诊人绑定（需本人身份证实名认证）后再跑。`)
  })

  const snap = await flow.start()
  if (snap.stage === STAGES.WAITING_SMS || snap.stage === STAGES.CAPTCHA_MANUAL) {
    if (snap.stage === STAGES.WAITING_SMS) {
      console.log('\n📱 短信已发出（60 秒内有效）')
      const code = await ask('请输入 6 位短信验证码：')
      await flow.completeLogin(code)
    }
  }

  // 轮询到终态
  const deadline = Date.now() + 8 * 60 * 1000
  while (!['booked', 'failed', 'aborted', 'waf_blocked', 'need_patient', 'need_confirm', 'slots_ready'].includes(flow.stage)) {
    if (Date.now() > deadline) {
      console.error('\n超时退出')
      await flow.close()
      return 1
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  const final = flow.snapshot()
  console.log('\n================ 结果 ================')
  console.log(`阶段：${final.stage}`)
  if (final.error) console.log(`错误：${final.error.message}`)
  if (final.result) {
    console.log(`成功：${final.result.ok}`)
    if (final.result.pageText) console.log(`页面摘要：${final.result.pageText.slice(0, 300).replace(/\s+/g, ' ')}`)
  }
  if (final.screenshots.length) {
    console.log('截图：')
    for (const s of final.screenshots) console.log(`  [${s.tag}] ${s.file}`)
  }
  await flow.close()

  if (final.stage === STAGES.BOOKED) return 0
  if (final.stage === STAGES.WAF_BLOCKED) return 2
  if ([STAGES.NEED_PATIENT, STAGES.NEED_CONFIRM, STAGES.SLOTS_READY].includes(final.stage)) return 3
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('未捕获异常：', e)
    process.exit(1)
  })
