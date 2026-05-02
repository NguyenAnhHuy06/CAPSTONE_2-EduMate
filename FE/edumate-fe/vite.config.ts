import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  /** Align with `FE/server.js` default (`PORT = 3001`) when `.env` has no `VITE_PROXY_TARGET`. */
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://127.0.0.1:3001'
  const devPort = Number(env.VITE_DEV_PORT || 5173) || 5173

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: devPort,
      open: true,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          timeout: 180_000,
          proxyTimeout: 180_000,
        },
      },
    },
  }
})