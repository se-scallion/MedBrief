// ⑬ 前端安全不变量（v0.6 / r3(b)）：判定逻辑不得进浏览器。
//
// 为什么不是黑名单：只 grep 六个标识符挡不住
//   ① import '../../../lib/fieldDict.mjs'（六个词一个不出现）
//   ② 改名复制（critRange / judgeFlag）
//   ③ 阈值字面量被 bundler 打进产物
// 所以两条不变量：
//   (i)  web/src/** 不得 import 任何路径含 /lib/ 的模块（allowlist 只留既有 shim 例外）
//   (ii) 对**构建产物**断言规则字面量（阈值表 / 判定模块名），源码 grep 只作辅助信号
//
// 服务 = 不在浏览器；5174 与 8011 都算服务端，本断言**只管 web/src/** 与 dist bundle。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WEB_SRC = path.join(ROOT, 'web', 'src')
const DIST = path.join(ROOT, 'web', 'dist-next', 'assets')

let pass = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' · ' + e : ''}`) }

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

// 不变量 (i)：源码 import 路径
{
  // 唯一既有例外：MedBrief 的 MedData shim 需要码别名做「服务端↔MedData 形状」薄映射。
  // 收口期限：B1 同批让 8011 出码（/v2/code/alias），之后此 allowlist 应清空。
  const ALLOW = new Set([
    path.join(WEB_SRC, 'meddata', 'store.js'),
  ])
  const bad = []
  for (const f of walk(WEB_SRC).filter((f) => /\.(js|jsx|mjs)$/.test(f))) {
    if (ALLOW.has(f)) continue
    const txt = fs.readFileSync(f, 'utf8')
    for (const m of txt.matchAll(/(?:import|from)\s*['"]([^'"]+)['"]/g)) {
      if (/\/(?:lib)\//.test(m[1]) || m[1].startsWith('../../../lib/')) bad.push(`${path.relative(ROOT, f)} → ${m[1]}`)
    }
  }
  assert.deepEqual(bad, [], `前端不得 import /lib/ 判定模块：\n${bad.join('\n')}`)
  ok('不变量(i)：web/src/** 无 /lib/ import（allowlist: meddata/store.js:14 codeAlias，待 B1 出码后清空）')
}

// 不变量 (ii)：构建产物里的规则字面量
{
  if (!fs.existsSync(DIST)) {
    console.log('SKIP 不变量(ii)：dist-next/assets 不存在（先 npm run build:web）')
  } else {
    const bundles = fs.readdirSync(DIST).filter((f) => f.endsWith('.js'))
    assert.ok(bundles.length > 0, '应至少有一个 bundle')
    // 辅助信号：6 个判定标识符（r3 实测全 0）
    // 精确词边界：MedData shim 的前端 store 本来就有 `findDuplicateDoc/Record`（查重是前端归档的既有动作），
    // 不是 MedBrief 的 `findDuplicate` 判定模块。用 \b 边界避免把前者误判成后者（不变量不许误伤）。
    const IDS = ['CRITICAL_RULES', 'classifyAnalyte', 'findDuplicate', 'anatomyWeight', 'detectReportType', 'guessMeta']
    // 规则字面量：危急阈值表里的「≥1800」与「NT-proBNP」同现才算命中（避免误伤时段文案 n<1800?`下午`）
    const RULE = /NT[- ]?proBNP[\s\S]{0,80}1800|1800[\s\S]{0,80}NT[- ]?proBNP/
    for (const b of bundles) {
      const txt = fs.readFileSync(path.join(DIST, b), 'utf8')
      const hits = IDS.filter((k) => new RegExp(`(?:^|[^\\w$])${k}(?=[^\\w$]|$)`).test(txt))
      assert.deepEqual(hits, [], `${b} 含判定标识符: ${hits.join(',')}`)
      assert.ok(!RULE.test(txt), `${b} 含危急阈值表字面量（NT-proBNP/1800 同现）`)
    }
    ok(`不变量(ii)：${bundles.length} 个 bundle 无判定标识符、无阈值表字面量（1800 时段文案不误报）`)
  }
}

console.log(`\n前端安全不变量 ⑬：${pass} 通过 / 0 失败`)
