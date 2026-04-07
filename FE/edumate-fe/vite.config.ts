import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        // Match backend port
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
    },
  },
})
