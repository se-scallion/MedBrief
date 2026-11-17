// 本地账号 / 权限 / 归属 / 审计 —— MedBrief 账号系统地基（账号系统方案 §D0/D1）
//
// 设计口径（计划 .agents/account-system-1116-plan.md v0.8 已过 r6 终判）：
//   · 表全部落在 data/medbrief.db（与 lib/blobStore.mjs 同一个库、同一套 MEDBRIEF_DATA_DIR），
//     不碰 data/reports.json 一个字节；归属走旁路表 report_owners。
//   · Node 的 node:sqlite 没有 transaction() API，事务用 BEGIN IMMEDIATE / COMMIT / ROLLBACK 手工包。
//   · 密码用 node:crypto.scrypt（N=16384,r=8,p=1），salt 随机，timingSafeEqual 比较。
//   · phone 有 CHECK(length=11 AND GLOB '1[3-9]*') 机器护栏；admin 号与 114 号同号但体系不同。
//   · 本模块只做存储与原子写，不含 HTTP 鉴权（那是 server.mjs 的守卫层，下一步接）。
//
// 用法：见 tools/bootstrap-accounts.mjs。默认只读，写操作由调用方显式触发。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const DB_FILE = path.join(process.env.MEDBRIEF_DATA_DIR || path.join(process.cwd(), 'data'), 'medbrief.db')

// 账号系统新增的 5 张表；IF NOT EXISTS 保证重复初始化不破坏已有数据。
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE CHECK(length(phone)=11 AND phone GLOB '1[3-9]*'),
    phoneVerifiedAt TEXT,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    sessionVersion INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
    card_export INTEGER NOT NULL DEFAULT 0,
    guahao INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('phone','ip')),
    failed_count INTEGER NOT NULL DEFAULT 0,
    first_failed_at TEXT,
    last_failed_at TEXT,
    locked_until TEXT
  );
  CREATE TABLE IF NOT EXISTS report_owners (
    report_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'bootstrap'
  );
  CREATE INDEX IF NOT EXISTS idx_report_owners_user ON report_owners(user_id);
  CREATE TABLE IF NOT EXISTS authz_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT,
    target_user_id TEXT,
    action TEXT NOT NULL,
    before TEXT,
    after TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS report_owner_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id TEXT NOT NULL,
    from_user_id TEXT,
    to_user_id TEXT,
    at TEXT NOT NULL,
    reason TEXT
  );
  -- r6-addendum P0-1：原件上传者归属（刚上传、尚未被报告引用时也能取回自己的原件）
  CREATE TABLE IF NOT EXISTS blob_owners (
    blob_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_blob_owners_user ON blob_owners(user_id);
`

let db = null
function q() {
  if (db) return db
  db = new DatabaseSync(DB_FILE)
  db.exec(SCHEMA)
  return db
}

/** 只用于测试：关闭当前连接，指向新库路径（进程内单例） */
export function resetForTest(newDbFile) {
  if (db) { try { db.close() } catch {} }
  db = null
  if (newDbFile) {
    // 通过临时改写模块内常量不可行（const），由调用方设置 MEDBRIEF_DATA_DIR 后重开
  }
}

const now = () => new Date().toISOString()
const newUserId = () => 'u_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')

// ---------- 密码学（J9：内置 scrypt，不引 native 包）----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 32 * 1024 * 1024 }

export function hashPassword(password, saltHex = null) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT)
  return { salt: salt.toString('hex'), hash: hash.toString('hex') }
}

export function verifyPassword(password, saltHex, hashHex) {
  try {
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const actual = crypto.scryptSync(String(password), salt, expected.length, SCRYPT)
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

// ---------- 校验 ----------
export function assertPhone(phone) {
  const p = String(phone || '')
  if (!/^1[3-9]\d{9}$/.test(p)) {
    throw Object.assign(new Error(`手机号必须是 11 位大陆号码（当前：${p || '空'}，长度 ${p.length}）`), { code: 'BAD_PHONE' })
  }
  return p
}

// ---------- 用户 CRUD ----------
export function getUserById(id) {
  return q().prepare('SELECT * FROM users WHERE id = ?').get(id) || null
}
export function getUserByPhone(phone) {
  return q().prepare('SELECT * FROM users WHERE phone = ?').get(String(phone)) || null
}
export function listUsers() {
  return q().prepare('SELECT id, phone, phoneVerifiedAt, role, card_export, guahao, sessionVersion, disabled, created_at, updated_at FROM users ORDER BY created_at').all()
}

/** 建用户；密码从参数传（调用方从 stdin 读，不进命令行历史）。返回不含 hash/salt 的视图。 */
export function createUser({ phone, password, role = 'user', cardExport = 0, guahao = 0, actorUserId = null, allowWeak = false }) {
  const p = assertPhone(phone)
  const minLen = allowWeak ? 4 : 8
  if (!password || String(password).length < minLen) {
    throw Object.assign(new Error(`密码至少 ${minLen} 位`), { code: 'WEAK_PASSWORD' })
  }
  const d = q()
  if (d.prepare('SELECT 1 FROM users WHERE phone = ?').get(p)) {
    throw Object.assign(new Error(`账号 ${p} 已存在`), { code: 'PHONE_EXISTS' })
  }
  const id = newUserId()
  const { salt, hash } = hashPassword(password)
  const ts = now()
  d.prepare(`INSERT INTO users (id, phone, phoneVerifiedAt, password_hash, salt, sessionVersion, role, card_export, guahao, created_at, updated_at, disabled)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(id, p, null, hash, salt, 0, role, cardExport ? 1 : 0, guahao ? 1 : 0, ts, ts)
  appendAuthz({ actorUserId, targetUserId: id, action: 'create_user', after: JSON.stringify({ phone: p, role, cardExport, guahao, weakPasswordAccepted: !!allowWeak }) })
  return publicUser(getUserById(id))
}

export function publicUser(u) {
  if (!u) return null
  const { password_hash, salt, ...rest } = u
  return rest
}

/** 改手机号：同步 sessionVersion+1（旧 cookie 全部作废）。 */
export function changePhone(id, newPhone, actorUserId = null) {
  const p = assertPhone(newPhone)
  const d = q()
  const before = getUserById(id)
  if (!before) throw new Error(`用户 ${id} 不存在`)
  if (before.phone === p) return publicUser(before)
  d.prepare('UPDATE users SET phone = ?, sessionVersion = sessionVersion + 1, updated_at = ? WHERE id = ?').run(p, now(), id)
  appendAuthz({ actorUserId, targetUserId: id, action: 'change_phone', before: JSON.stringify({ phone: before.phone }), after: JSON.stringify({ phone: p }) })
  return publicUser(getUserById(id))
}

/** 改密码 / 停用 / 手动踢下线：全部 sessionVersion+1。 */
export function bumpSessionVersion(id, action, actorUserId = null, extra = null) {
  const d = q()
  const before = getUserById(id)
  if (!before) throw new Error(`用户 ${id} 不存在`)
  d.prepare('UPDATE users SET sessionVersion = sessionVersion + 1, updated_at = ? WHERE id = ?').run(now(), id)
  appendAuthz({ actorUserId, targetUserId: id, action, after: extra ? JSON.stringify(extra) : null })
  return publicUser(getUserById(id))
}

/** 授权 / 撤销（card_export / guahao / role / disabled）。 */
export function setPermissions(id, patch, actorUserId = null) {
  const allowed = ['card_export', 'guahao', 'role', 'disabled']
  const keys = Object.keys(patch || {}).filter((k) => allowed.includes(k))
  if (!keys.length) throw new Error('没有可更新的权限字段')
  const before = getUserById(id)
  if (!before) throw new Error(`用户 ${id} 不存在`)
  const sets = keys.map((k) => `${k} = ?`).join(', ')
  const vals = keys.map((k) => {
    if (k === 'role') return patch.role === 'admin' ? 'admin' : 'user'
    return patch[k] ? 1 : 0
  })
  const d = q()
  const needsBump = ('disabled' in patch && patch.disabled) || ('role' in patch && patch.role !== before.role)
  d.prepare(`UPDATE users SET ${sets}, updated_at = ?${needsBump ? ', sessionVersion = sessionVersion + 1' : ''} WHERE id = ?`)
    .run(...vals, now(), id)
  const after = getUserById(id)
  appendAuthz({
    actorUserId, targetUserId: id, action: 'set_permissions',
    before: JSON.stringify(Object.fromEntries(keys.map((k) => [k, before[k]]))),
    after: JSON.stringify(Object.fromEntries(keys.map((k) => [k, after[k]]))),
  })
  return publicUser(after)
}

// ---------- 报告归属 ----------
export function getOwner(reportId) {
  return q().prepare('SELECT * FROM report_owners WHERE report_id = ?').get(reportId) || null
}
export function setOwner(reportId, userId, { source = 'bootstrap', reason = null, actorUserId = null } = {}) {
  const prev = getOwner(reportId)
  const d = q()
  d.prepare(`INSERT INTO report_owners (report_id, user_id, assigned_at, source) VALUES (?,?,?,?)
             ON CONFLICT(report_id) DO UPDATE SET user_id=excluded.user_id, assigned_at=excluded.assigned_at, source=excluded.source`)
    .run(reportId, userId, now(), source)
  d.prepare('INSERT INTO report_owner_log (report_id, from_user_id, to_user_id, at, reason) VALUES (?,?,?,?,?)')
    .run(reportId, prev?.user_id || null, userId, now(), reason || source)
  return { reportId, userId, source, previous: prev?.user_id || null }
}
export function deleteOwner(reportId) {
  const prev = getOwner(reportId)
  const d = q()
  d.prepare('DELETE FROM report_owners WHERE report_id = ?').run(reportId)
  if (prev) d.prepare('INSERT INTO report_owner_log (report_id, from_user_id, to_user_id, at, reason) VALUES (?,?,?,?,?)').run(reportId, prev.user_id, null, now(), 'purge')
  return !!prev
}
export function listOwners() {
  return q().prepare('SELECT * FROM report_owners ORDER BY report_id').all()
}
export function ownerStats() {
  const d = q()
  return {
    owners: d.prepare('SELECT COUNT(*) n FROM report_owners').get().n,
    bySource: d.prepare('SELECT source, COUNT(*) n FROM report_owners GROUP BY source').all(),
    byUser: d.prepare('SELECT u.phone, o.user_id, COUNT(*) n FROM report_owners o LEFT JOIN users u ON u.id=o.user_id GROUP BY o.user_id').all(),
  }
}

// ---------- 审计（只追加、不回灌）----------
export function appendAuthz({ actorUserId = null, targetUserId = null, action, before = null, after = null }) {
  q().prepare('INSERT INTO authz_log (actor_user_id, target_user_id, action, before, after, at) VALUES (?,?,?,?,?,?)')
    .run(actorUserId, targetUserId, action, before, after, now())
}
export function listAuthz(limit = 200) {
  return q().prepare('SELECT * FROM authz_log ORDER BY id DESC LIMIT ?').all(limit)
}
export function listOwnerLog(limit = 200) {
  return q().prepare('SELECT * FROM report_owner_log ORDER BY id DESC LIMIT ?').all(limit)
}

// ---------- 事务工具（node:sqlite 无 transaction()）----------
export function withTransaction(fn) {
  const d = q()
  d.exec('BEGIN IMMEDIATE')
  try {
    const result = fn(d)
    d.exec('COMMIT')
    return result
  } catch (e) {
    try { d.exec('ROLLBACK') } catch {}
    throw e
  }
}

/** 仅供 bootstrap 备份：把 report_owners 表整表拷贝成 build 表并加时间戳（不物理删）。 */
export function backupOwnerTable(tag) {
  const d = q()
  const name = `report_owners_bak_${String(tag).replace(/[^A-Za-z0-9_]/g, '_')}`
  d.exec(`CREATE TABLE IF NOT EXISTS ${name} AS SELECT * FROM report_owners`)
  return name
}

// ---------- 原件归属（r6-addendum P0-1）----------
export function getBlobOwner(blobId) {
  return q().prepare('SELECT * FROM blob_owners WHERE blob_id = ?').get(blobId) || null
}
export function setBlobOwner(blobId, userId) {
  q().prepare('INSERT INTO blob_owners (blob_id, user_id, at) VALUES (?,?,?) ON CONFLICT(blob_id) DO UPDATE SET user_id=excluded.user_id, at=excluded.at')
    .run(blobId, userId, now())
}
export function listBlobIdsForUser(userId) {
  return q().prepare('SELECT blob_id FROM blob_owners WHERE user_id = ?').all(userId).map((r) => r.blob_id)
}

export const DB_PATH = DB_FILE

// ---------- 登录限流（r2 P0-C：login_attempts 旁路表，phone/ip 双键）----------
export function getAttempt(key) {
  return q().prepare('SELECT * FROM login_attempts WHERE key = ?').get(key) || null
}
/** 记一次失败；返回该键的最新状态。退避 min(2^(n-5),8)s，第 10 次锁 15 分钟；锁满归零。 */
export function recordFailedAttempt(key, kind) {
  const d = q()
  const ts = Date.now()
  // r3 P1-8：admin 号不硬锁（防 LAN 远程锁死管理员），只累计退避 + 审计告警
  let isAdminKey = false
  let adminUser = null
  if (key.startsWith('phone:')) {
    adminUser = getUserByPhone(key.slice(6))
    isAdminKey = !!adminUser && adminUser.role === 'admin'
  }
  let a = getAttempt(key)
  if (!a) {
    d.prepare('INSERT INTO login_attempts (key, kind, failed_count, first_failed_at, last_failed_at, locked_until) VALUES (?,?,?,?,?,NULL)')
      .run(key, kind, 1, new Date(ts).toISOString(), new Date(ts).toISOString())
    a = getAttempt(key)
  } else {
    let n = (a.failed_count || 0) + 1
    let lockedUntil = a.locked_until
    // 锁定期已过 → 归零重来（防一次锁定=永久锁死）
    if (lockedUntil && Date.parse(lockedUntil) <= ts) { n = 1; lockedUntil = null }
    if (!isAdminKey && n >= 10 && !lockedUntil) lockedUntil = new Date(ts + 15 * 60 * 1000).toISOString()
    // admin 号不设 locked_until；backoffSeconds 会按 n 退避封顶 8s
    if (isAdminKey && n >= 10 && !a.locked_until) {
      appendAuthz({ targetUserId: adminUser.id, action: 'admin_login_throttle', after: JSON.stringify({ failed_count: n, ip: 'see login_fail' }) })
    }
    d.prepare('UPDATE login_attempts SET failed_count=?, last_failed_at=?, locked_until=? WHERE key=?')
      .run(n, new Date(ts).toISOString(), lockedUntil, key)
    a = getAttempt(key)
  }
  return a
}
/** 成功登录只清 phone 键（ip 键走滑动窗口，不被重置） */
export function clearPhoneAttempts(phone) {
  q().prepare('DELETE FROM login_attempts WHERE key = ?').run('phone:' + phone)
}
/** 当前退避秒数：第 5 次失败起 1,2,4,8…封顶 8s；锁定期返回 -1（已锁） */
export function backoffSeconds(a) {
  if (!a) return 0
  if (a.locked_until && Date.parse(a.locked_until) > Date.now()) return -1
  const n = a.failed_count || 0
  if (n < 5) return 0
  return Math.min(Math.pow(2, n - 5), 8)
}
/** 启动时清理 7 天前的失败记录（防无界增长） */
export function cleanupOldAttempts(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString()
  return q().prepare('DELETE FROM login_attempts WHERE last_failed_at < ?').run(cutoff).changes
}

/** blob 是否被某用户自己的报告引用（r6-add P0-1：GET blob/:id 的 EXISTS 判定） */
export function blobReferencedByUser(blobId, userId) {
  const row = q().prepare(`SELECT 1 FROM blobs b JOIN report_owners o ON o.report_id = b.report_id
                           WHERE b.id = ? AND o.user_id = ? LIMIT 1`).get(blobId, userId)
  return !!row
}
