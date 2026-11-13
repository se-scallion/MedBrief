// MedData 页面在 MedBrief 内的独立构建入口。
// 源码逐字节复制自 MedData（见 meddata/src），只提供构建配置，不改任何业务逻辑。
// 产物输出到 web/dist-meddata，由 server.mjs 的 mount.mjs 挂在 /meddata。
// node_modules 用 MedBrief 根目录那份（软链到 MedData），不另装依赖。
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const HERE = import.meta.dirname

export default defineConfig({
  root: HERE,
  base: '/meddata/',
  cacheDir: path.resolve(HERE, '.vite'),
  publicDir: path.resolve(HERE, 'public'),
  plugins: [react()],
  resolve: {
    modules: [path.resolve(HERE, '..', 'node_modules'), 'node_modules'],
  },
  build: {
    outDir: path.resolve(HERE, '..', 'web', 'dist-meddata'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // Vite 8 / rolldown 只接受函数形式（对象形式会报 manualChunks is not a function）
      output: {
        manualChunks: (id) => {
          if (id.includes('/node_modules/echarts/') || id.includes('/node_modules/zrender/')) return 'echarts'
          if (id.includes('/node_modules/pdfjs-dist/')) return 'pdfjs'
          return undefined
        },
      },
    },
  },
})
