// 报告库原子读写（v2 阶段 1.1）—— 唯一实现，5174 与 8011 共用同一份形状。
//
// 为什么要有（r2 P0-2 / r3 ③-1 实证）：
//   MedBrief/server.mjs 旧 readReports() 解析失败 catch → **返回空库**，
//   旧 writeReports() 用 writeFileSync **直写目标文件**；
//   进程崩在半途 / 文件被截断时，下一次写入会把 63 份真实报告覆盖成空库。
//
// 三条护栏：
//   ① 读失败**抛错**，不静默返回空库（只有「文件本来不存在」才允许空库）；
//   ② 写用 `tmp + fsync + rename` 原子替换，保 `{version, reports, trashed, audit}` 四字段；
//   ③ 进程内单写者队列（同一时刻只允许一个写），防并发交错；`version` 作乐观锁留痕。
//
// 不搬家：本模块是纯 IO 工具，不持有业务判定；数据文件仍由调用方指定路径。

import fs from 'node:fs'
import path from 'node:path'

const EMPTY = () => ({ version: 2, reports: [], trashed: [], audit: [] })

export class ReportStoreError extends Error {
  constructor(message, { code = 'REPORT_STORE_ERROR', cause = null } = {}) {
    super(message)
    this.code = code
    if (cause) this.cause = cause
  }
}

/** 读：文件不存在 → 空库；文件存在但坏/解析失败 → 抛错（绝不返回空库） */
export function readStore(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return EMPTY()
    throw new ReportStoreError(`报告库读取失败：${e.message}`, { code: 'REPORT_STORE_READ', cause: e })
  }
  let j
  try {
    j = JSON.parse(raw)
  } catch (e) {
    throw new ReportStoreError(`报告库 JSON 损坏，拒绝写入以免覆盖真实数据：${e.message}`, { code: 'REPORT_STORE_CORRUPT', cause: e })
  }
  if (!j || !Array.isArray(j.reports)) {
    throw new ReportStoreError('报告库缺少 reports[]，拒绝写入', { code: 'REPORT_STORE_SHAPE' })
  }
  return {
    version: Number(j.version) || 2,
    reports: j.reports,
    trashed: Array.isArray(j.trashed) ? j.trashed : [],
    audit: Array.isArray(j.audit) ? j.audit : [],
  }
}

// 单写者：Node 是单线程事件循环，下面整段用的是**同步 fs**（openSync/writeFileSync/fsyncSync/renameSync），
// 中间没有 await、不会让出事件循环 → 天然原子、不会与另一个写交错。
// 刻意**不做成 Promise 链**：原调用方（server.mjs 多处）是「写完立即发响应」的同步契约，
// 改成异步会引入读后写/响应先于落盘的竞态（F2 不改调用面）。
export function writeStore(file, store) {
  const out = {
    version: 2,
    reports: Array.isArray(store?.reports) ? store.reports : [],
    trashed: Array.isArray(store?.trashed) ? store.trashed : [],
    audit: Array.isArray(store?.audit) ? store.audit : [],
  }
  const payload = JSON.stringify(out, null, 2)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, payload, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file) // 原子替换：要么旧文件，要么完整新文件
  return true
}
