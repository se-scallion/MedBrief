// MedBrief 主前端构建：把 MedData 的识别组件一起打进同一个 bundle（不再是独立站点）。
// 关键：resolveId 拦截 meddata/src 对自身 store/docFileStore 的引用，改指向 MedBrief 适配层，
// 识别逻辑（ocr/normalize/ocrEngines/docAi...）一行不改，但保存落进 data/reports.json。
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MEDDATA_SRC = path.resolve(HERE, '..', 'meddata', 'src')
const SHIM_STORE = path.resolve(HERE, 'src', 'meddata', 'store.js')
const SHIM_FILES = path.resolve(HERE, 'src', 'meddata', 'docFileStore.js')

// 只拦 meddata/src 内部的相对引用；适配层自身与 MedBrief 其它代码不受影响。
function meddataAdapter() {
  return {
    name: 'medbrief-meddata-adapter',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      if (!importer.startsWith(MEDDATA_SRC + path.sep)) return null
      const abs = path.resolve(path.dirname(importer), source.split('?')[0])
      if (abs === path.join(MEDDATA_SRC, 'data', 'store.js')) return SHIM_STORE
      if (abs === path.join(MEDDATA_SRC, 'utils', 'docFileStore.js')) return SHIM_FILES
      return null
    },
  }
}

export default defineConfig({
  root: HERE,
  base: process.env.MEDBRIEF_WEB_BASE || '/',
  cacheDir: path.resolve(HERE, '.vite'),
  plugins: [meddataAdapter(), react()],
  resolve: {
    modules: [path.resolve(HERE, '..', 'node_modules'), 'node_modules'],
  },
  // 允许 Vite 读取 web/ 之外的 meddata/src
  server: {
    fs: { allow: [path.resolve(HERE, '..'), MEDDATA_SRC] },
    // 代理目标跟 server.mjs 用同一个环境变量（server.mjs:60 也从 PORT 读），
    // 端口只在「环境变量 / 这里」两处表达，不再各写死一份。
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT || 5174}` },
  },
  build: {
    outDir: path.resolve(HERE, process.env.MEDBRIEF_WEB_OUT || 'dist-next'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('/node_modules/echarts/') || id.includes('/node_modules/zrender/')) return 'echarts'
          if (id.includes('/node_modules/pdfjs-dist/')) return 'pdfjs'
          if (id.includes('/node_modules/tesseract.js')) return 'tesseract'
          return undefined
        },
      },
    },
  },
})
