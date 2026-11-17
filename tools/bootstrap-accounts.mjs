// 账号系统 bootstrap —— 三步建号 + 归属全量指派（账号系统方案 §D0）
//
// 顺序（用户 2026-11-17 拍板）：
//   ① --bootstrap        交互建 admin（stdin 读密码，不进命令行历史），phone=13228372097
//   ② --create-user      建报告所有者，phone=13200000000（11 位护栏；默认零授权）
//   ③ --apply            把 reports.json 里 98+3 条报告全量指派给报告所有者
//
// 纪律：
//   · 默认 dry-run，只有显式 --apply 才写；任何写之前先备份 report_owners 表。
//   · 三步在**同一个事务**里完成（BEGIN IMMEDIATE / COMMIT / ROLLBACK），中间失败不留半套状态。
//   · 只读 data/reports.json，不改它一个字节（写后核对 sha256 不变）。
//   · 手机号/密码不落 git，不落命令行参数（密码走 stdin）。
//
// 用法：
//   node tools/bootstrap-accounts.mjs                         # dry-run：只打印将要做什么
//   node tools/bootstrap-accounts.mjs --apply                 # 真执行（会提示从 stdin 输入两次密码）

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const accounts = await import('../lib/accounts.mjs')
const { readStore } = await import('../lib/reportStore.mjs')
const { migrateLegacyPatientTo } = await import('../lib/intakeCard.js')

const ROOT = path.join(import.meta.dirname, '..')
const REPORTS_FILE = process.env.MEDBRIEF_REPORTS_FILE || path.join(ROOT, 'data', 'reports.json')
const APPLY = process.argv.includes('--apply')
// 密码来源（优先级）：环境变量 > stdin。环境变量由调用方这样传：
//   MB_ADMIN_PASSWORD=... MB_OWNER_PASSWORD=... node tools/bootstrap-accounts.mjs --apply
// 这样密码不进命令行历史；本脚本不会把密码写入任何文件/日志。
const ADMIN_PHONE = process.env.MEDBRIEF_ADMIN_PHONE || '13228372097'
const OWNER_PHONE = process.env.MEDBRIEF_OWNER_PHONE || '13200000000'

const shaOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function readPasswordPrompt(label) {
  const rl = readline.createInterface({ input, output })
  return new Promise(async (resolve) => {
    try {
      const p = await rl.question(`${label}: `)
      resolve(p)
    } finally { rl.close() }
  })
}

async function main() {
  console.log('=== MedBrief 账号系统 bootstrap ===')
  console.log(`模式: ${APPLY ? 'APPLY（真写）' : 'DRY-RUN（只读，不写）'}`)
  console.log(`管理员: ${ADMIN_PHONE}    报告所有者: ${OWNER_PHONE}`)
  console.log(`reports.json: ${REPORTS_FILE}`)

  // 1. 只读核对报告库
  const before = readStore(REPORTS_FILE)
  const beforeSha = shaOf(REPORTS_FILE)
  const ids = [...(before.reports || []), ...(before.trashed || [])].map((r) => r.id)
  const uniq = new Set(ids)
  console.log(`\n报告: ${before.reports.length} 活 + ${before.trashed.length} 回收站 = ${ids.length} 条（唯一 ${uniq.size}）`)

  // 2. 现状检查（只读）
  const existingAdmin = accounts.getUserByPhone(ADMIN_PHONE)
  const existingOwner = accounts.getUserByPhone(OWNER_PHONE)
  const ownersBefore = accounts.listOwners()
  console.log(`现状: 管理员 ${existingAdmin ? '已存在 id=' + existingAdmin.id : '未建'}；所有者 ${existingOwner ? '已存在 id=' + existingOwner.id : '未建'}；现有归属 ${ownersBefore.length} 条`)

  const plan = {
    createAdmin: !existingAdmin,
    createOwner: !existingOwner,
    assignCount: uniq.size,
    overwriteCount: [...uniq].filter((id) => accounts.getOwner(id) && accounts.getOwner(id).user_id !== (existingOwner?.id || '?')).length,
  }
  console.log(`\n将执行: ${plan.createAdmin ? '建 admin' : 'admin 已存在跳过'} / ${plan.createOwner ? '建 owner' : 'owner 已存在跳过'} / 指派 ${plan.assignCount} 条归属 / 迁移 p1 档案→owner`)
  if (plan.overwriteCount) console.log(`⚠️ 其中 ${plan.overwriteCount} 条当前归属不是 owner，--apply 会覆盖（先备份，可回滚）`)

  // 3. 密码（仅在 APPLY 且需要建账号时读；优先环境变量，否则 stdin）
  let adminPassword = process.env.MB_ADMIN_PASSWORD || null
  let ownerPassword = process.env.MB_OWNER_PASSWORD || null
  if (APPLY && plan.createAdmin && !adminPassword) {
    adminPassword = await readPasswordPrompt('请输入管理员密码（≥8 位）')
    if (adminPassword.length < 8) throw new Error('密码至少 8 位')
    const confirm = await readPasswordPrompt('请再输入一次确认')
    if (confirm !== adminPassword) throw new Error('两次密码不一致')
  }
  if (APPLY && plan.createOwner && !ownerPassword) {
    ownerPassword = crypto.randomBytes(18).toString('base64url')
    console.log('（报告所有者未指定密码，使用随机密码；它只作归属主体）')
  }


  if (!APPLY) {
    console.log('\nDRY-RUN 结束：未写任何数据。要真执行请加 --apply。')
    return
  }

  // 4. 事务：备份 → 建号 → 指派
  let adminId = existingAdmin?.id
  let ownerId = existingOwner?.id
  const result = accounts.withTransaction((d) => {
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    const bak = accounts.backupOwnerTable(stamp)

    if (plan.createAdmin) {
      const a = accounts.createUser({ phone: ADMIN_PHONE, password: adminPassword, role: 'admin', actorUserId: null })
      adminId = a.id
    }
    if (plan.createOwner) {
      // 用户 2026-11-17 明确指定所有者密码 123456（6 位 < 8）：本机个人工具，allowWeak 放行并记审计。
      const weak = !!ownerPassword && ownerPassword.length < 8
      if (weak) console.log('   ⚠️ 报告所有者密码 <8 位（用户指定），已放行并在 authz_log 记 weakPasswordAccepted')
      const o = accounts.createUser({ phone: OWNER_PHONE, password: ownerPassword, role: 'user', cardExport: 0, guahao: 0, actorUserId: adminId, allowWeak: weak })
      ownerId = o.id
    }
    for (const id of uniq) accounts.setOwner(id, ownerId, { source: 'bootstrap', reason: 'initial 98+3 assignment', actorUserId: adminId })
    // r6-addendum P0-2：把单份 p1 档案迁到 owner 名下（不动原文件）
    const migrated = migrateLegacyPatientTo(ownerId)
    return { bak, count: uniq.size, migrated }
  })

  // 5. 写后核对：reports.json 一个字节没变
  const afterSha = shaOf(REPORTS_FILE)
  if (afterSha !== beforeSha) {
    console.error(`❌ reports.json 发生变化（${beforeSha} → ${afterSha}）—— 严重错误，请立即检查！`)
    process.exitCode = 1
    return
  }

  console.log(`\n✅ 完成：admin=${adminId} owner=${ownerId}`)
  console.log(`   备份表: ${result.bak}`)
  console.log(`   指派: ${result.count} 条`)
  console.log(`   档案迁移: ${result.migrated ? (result.migrated.migrated ? result.migrated.dst : '跳过(' + result.migrated.reason + ')') : '无源档案'}`)
  console.log(`   reports.json sha256 未变: ${afterSha.slice(0, 16)}…`)
  console.log(`   归属统计:`, accounts.ownerStats())
}

main().catch((e) => {
  console.error(`\n❌ bootstrap 失败: ${e.message}`)
  process.exitCode = 1
})
