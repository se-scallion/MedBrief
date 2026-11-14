// 生成 MedData 组件在 MedBrief 内所需的 tailwind 样式。
// 不加载 preflight / @layer base：避免 tailwind 的全局重置破坏 MedBrief 现有 antd 页面与 Modal。
// 产物 web/src/meddata/embedded.css 是纯 CSS，由 MedDataWorkbench 引入。
import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'meddata', 'src')
const OUT = path.join(ROOT, 'web', 'src', 'meddata', 'embedded.css')

// tailwind content 用 raw：把 meddata/src 下的所有 js/jsx 源码拼进来，
// 避免相对 content glob 在子目录构建时不生效（Vite 8 实测）。
const chunks = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(js|jsx)$/.test(e.name)) chunks.push(fs.readFileSync(p, 'utf8'))
  }
}
walk(SRC)

const original = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')
// 去掉 @tailwind base 与 @layer base 块（含 html/body 全局规则）
let cssText = original.replace(/@tailwind\s+base\s*;/g, '')
const layerBaseAt = cssText.indexOf('@layer base')
if (layerBaseAt >= 0) {
  const open = cssText.indexOf('{', layerBaseAt)
  let depth = 0
  let end = -1
  for (let i = open; i < cssText.length; i += 1) {
    if (cssText[i] === '{') depth += 1
    else if (cssText[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end > 0) cssText = cssText.slice(0, layerBaseAt) + cssText.slice(end)
}

const config = {
  content: [{ raw: chunks.join('\n'), extension: 'html' }],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185',
          500: '#e11d48', 600: '#c8102e', 700: '#a80f27', 800: '#881020', 900: '#4c0519',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

const result = await postcss([tailwindcss(config)]).process(cssText, { from: undefined })
const banner = '/* 自动生成：node web/scripts/build-meddata-css.mjs —— 不含 preflight，勿手改 */\n'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, banner + result.css)
const ok = ['.min-h-screen', '.bg-white', '.rounded-xl'].filter((k) => result.css.includes(k))
console.log(`embedded.css ${result.css.length} bytes; 关键类: ${ok.join(', ') || '缺失'}`)
