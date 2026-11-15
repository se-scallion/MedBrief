// 报告编辑「操作记录」落库（corrections 表，2026-11-15 用户口径 + Manager 审核放行）
//
// 为什么要这张表（方案 `.agents/plan-reportgrid-1115.md` 的 R4/R6/D1）：
//   报告库里用户改一格，可能是**两种完全不同的现实**：
//     ① OCR 认错了 → 用户改的值是「真值信号」，应该回流去改识别算法；
//     ② 用户自己手滑改了 → 那不是信号，学进去就是把噪声当训练数据。
//   只存「改前/改后」的 diff（= patchLog 已在做的事）**区分不了这两种**，必须同时留下
//   「用户是怎么操作的」序列（先删行再改值？点了一键修正？粘贴解析？复制过反馈？）。
//
// 与 patchLog 的分工（**不许并存两份真相**，Manager 判词 F2/R6）：
//   · patchLog（在 reports.json 里）= 「库里最终改成了什么」：字段级 from/to/at —— 唯一真相；
//   · corrections（本表）= 「用户怎么操作的」：op 序列 + 来源，值的前后变化只做引用，不回灌报告。
//
// 纪律：
//   1. **只追加**：本模块不导出任何 UPDATE/DELETE；
//   2. **永不回灌**：绝不拿这里的值去改 reports.json（那是用推断改事实）；
//   3. 批次上限，防止前端一次塞爆（MAX_BATCH）；
//   4. 与原件 blob 同一个 SQLite（data/medbrief.db），`CREATE TABLE IF NOT EXISTS`，老库照用。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB_FILE = path.join(process.env.MEDBRIEF_DATA_DIR || path.join(process.cwd(), 'data'), 'medbrief.db')

/** 一次最多收多少条（前端保存时一次性提交，正常一份报告几十条） */
export const MAX_BATCH = 500

let db = null
function q() {
  if (db) return db
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
  db = new DatabaseSync(DB_FILE)
  db.exec(`
    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL,
      session_id TEXT,
      row_index INTEGER,
      field TEXT,
      op TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT,
      source TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_corrections_report ON corrections(report_id);
  `)
  return db
}

const str = (v, max = 400) => (v == null ? '' : String(v).slice(0, max))

/**
 * 追加一批操作记录。
 * @param {Array<{op:string,row?:number,field?:string,from?:string,to?:string,source?:string}>} ops
 * @param {{reportId:string, sessionId?:string}} meta
 * @returns {{stored:number, dropped:number, sessionId:string}}
 */
export function appendCorrections(ops = [], { reportId = '', sessionId = '' } = {}) {
  const rid = str(reportId, 120)
  if (!rid) throw new Error('reportId 不能为空')
  const list = (Array.isArray(ops) ? ops : []).filter((o) => o && str(o.op, 40))
  const batch = list.slice(0, MAX_BATCH)
  const sid = str(sessionId, 80) || `s-${Date.now().toString(36)}`
  const at = new Date().toISOString()
  const ins = q().prepare('INSERT INTO corrections (report_id, session_id, row_index, field, op, from_value, to_value, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  for (const o of batch) {
    const rowIndex = Number.isFinite(Number(o.row)) && o.row !== '' && o.row != null ? Number(o.row) : null
    ins.run(rid, sid, rowIndex, str(o.field, 60) || null, str(o.op, 40), str(o.from), str(o.to), str(o.source, 20) || 'manual', at)
  }
  return { stored: batch.length, dropped: list.length - batch.length, sessionId: sid }
}

/** 读某份报告（或某次会话）的操作记录，按时间正序。 */
export function listCorrections({ reportId = '', sessionId = '', limit = 500 } = {}) {
  const lim = Math.min(2000, Math.max(1, Number(limit) || 500))
  const where = []
  const args = []
  if (reportId) { where.push('report_id = ?'); args.push(str(reportId, 120)) }
  if (sessionId) { where.push('session_id = ?'); args.push(str(sessionId, 80)) }
  const sql = `SELECT id, report_id, session_id, row_index, field, op, from_value, to_value, source, created_at
               FROM corrections ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC LIMIT ?`
  return q().prepare(sql).all(...args, lim)
}

export function correctionsStats() {
  const d = q()
  return {
    dbFile: DB_FILE,
    total: d.prepare('SELECT COUNT(*) n FROM corrections').get().n,
    reports: d.prepare('SELECT COUNT(DISTINCT report_id) n FROM corrections').get().n,
  }
}
