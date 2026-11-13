// 报告原件 Blob 存储（SQLite，node:sqlite 内置，零新增依赖）
//
// 设计参照 MedData 的 data-server.mjs：表结构 blobs(id, kind, type, size, data, updated_at) + blob_tombstones。
// 目的（用户 2026-11-13 定的）：**入库必须带原件**，以后系统升级换识别模型时能拿原件重新识别，
// 不依赖当时的 OCR 结果。所以原件字节进库，reports.json 只存引用 id。
//
// id 前缀 f_ （与 MedData 的 docFileStore 同约定），便于将来两边互通迁移。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const DB_FILE = path.join(process.env.MEDBRIEF_DATA_DIR || path.join(process.cwd(), 'data'), 'medbrief.db')

function open() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
  const db = new DatabaseSync(DB_FILE)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      id TEXT PRIMARY KEY,
      sha256 TEXT,
      kind TEXT NOT NULL DEFAULT 'original',
      type TEXT,
      size INTEGER,
      width INTEGER,
      height INTEGER,
      origin_path TEXT,
      report_id TEXT,
      created_at TEXT,
      data BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_blobs_report ON blobs(report_id);
    CREATE TABLE IF NOT EXISTS blob_tombstones (id TEXT PRIMARY KEY, deleted_at TEXT);
  `)
  return db
}
let db = null
const q = () => (db ||= open())

const newId = () => 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export function saveBlob(buf, { kind = 'original', type = '', originPath = '', width = null, height = null, reportId = null } = {}) {
  const d = q()
  const id = newId()
  d.prepare('INSERT INTO blobs (id, sha256, kind, type, size, width, height, origin_path, report_id, created_at, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, sha(buf), kind, type, buf.length, width, height, originPath, reportId, new Date().toISOString(), buf)
  return { id, sha256: sha(buf), size: buf.length }
}

export function getBlob(id) {
  const row = q().prepare('SELECT id, type, size, data, sha256, width, height FROM blobs WHERE id = ?').get(id)
  return row || null
}

export function listBlobs() {
  return q().prepare('SELECT id, sha256, kind, type, size, width, height, origin_path, report_id, created_at FROM blobs ORDER BY created_at').all()
}

export function linkBlobToReport(id, reportId) {
  q().prepare('UPDATE blobs SET report_id = ? WHERE id = ?').run(reportId, id)
}

export function deleteBlob(id) {
  const d = q()
  d.prepare('DELETE FROM blobs WHERE id = ?').run(id)
  d.prepare('INSERT OR REPLACE INTO blob_tombstones (id, deleted_at) VALUES (?,?)').run(id, new Date().toISOString())
}

export function blobStats() {
  const d = q()
  const one = (sql) => d.prepare(sql).get()
  return {
    dbFile: DB_FILE,
    blobs: one('SELECT COUNT(*) n FROM blobs').n,
    bytes: one('SELECT COALESCE(SUM(size),0) n FROM blobs').n,
    unlinked: one('SELECT COUNT(*) n FROM blobs WHERE report_id IS NULL').n,
    tombstones: one('SELECT COUNT(*) n FROM blob_tombstones').n,
  }
}
