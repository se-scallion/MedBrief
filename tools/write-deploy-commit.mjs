#!/usr/bin/env node
// 阶段 0 D0-5⑥⑦：构建机产出可审计的部署凭证。
//   - 在**构建机**（有 .git）执行：把 commit、dist-next 的 sha256、时间、执行者写进 .deploy-commit（600）
//   - 服务器不带 .git，只做「/api/health.head == .deploy-commit.commit」两方比对（r5 P1-1）
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const distDir = path.join(root, 'web', 'dist-next')
const outFile = path.join(root, '.deploy-commit')

if (!fs.existsSync(distDir)) {
  console.error(`ERROR: ${distDir} 不存在，先跑 npm run build:web（D0-5⑦）`)
  process.exit(1)
}

// 目录级指纹：按相对路径排序后逐个文件 sha256，再整体 sha256（与归档方式无关，可复跑）
const files = []
;(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p)
    else files.push([path.relative(distDir, p), createHash('sha256').update(fs.readFileSync(p)).digest('hex')])
  }
})(distDir)
const distSha = createHash('sha256').update(files.map(([f, h]) => `${f} ${h}`).join('\n')).digest('hex')

const record = {
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  commitFull: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  distFileCount: files.length,
  distSha256: distSha,
  // 关键文件内容指纹：服务器端可用 sha256sum -c 自证"跑的就是这个提交"
  fileHashes: Object.fromEntries(
    ['server.mjs', 'lib/auth.mjs', 'web/dist-next/index.html', 'vendor/package.json']
      .map((f) => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')])
  ),
  // 别线在途改动清单：服务器端断言"这些文件不得出现在部署包内" ⇒ 直接证明别线改动没上线
  dirtyFiles: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((l) => l.slice(3).trim()),
  builtAt: new Date().toISOString(),
  builtBy: `${os.hostname()}@${os.userInfo().username}`,
  nodeVersion: process.version,
}
fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
fs.chmodSync(outFile, 0o600)
console.log(JSON.stringify(record, null, 2))
