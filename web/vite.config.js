import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// 产物输出到 web/dist，由 server.mjs 以 /guahao/ 静态托管。
// node_modules 在项目根（软链到 MedData），因此不另外安装依赖。
export default defineConfig({
  root: path.resolve(__dirname),
  base: '/guahao/',
  cacheDir: path.resolve(__dirname, '.vite'),
  plugins: [react()],
  resolve: {
    modules: [path.resolve(__dirname, '..', 'node_modules'), 'node_modules'],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:5174',
    },
  },
})
