import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// 产物输出到 web/dist-next，由 server.mjs 托管在根路径 /（旧单文件工作台退到 /legacy）。
// node_modules 在项目根（软链到 MedData），因此不另外安装依赖。
export default defineConfig({
  root: path.resolve(__dirname),
  base: process.env.MEDBRIEF_WEB_BASE || '/',
  cacheDir: path.resolve(__dirname, '.vite'),
  plugins: [react()],
  resolve: {
    modules: [path.resolve(__dirname, '..', 'node_modules'), 'node_modules'],
  },
  build: {
    outDir: path.resolve(__dirname, process.env.MEDBRIEF_WEB_OUT || 'dist-next'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:5174',
    },
  },
})
