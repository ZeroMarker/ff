import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时: vite 5173 代理 /api -> 后端 8345
// 构建时: 输出到 public/ 由 server.js 直接托管
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8345', changeOrigin: true },
    },
  },
});