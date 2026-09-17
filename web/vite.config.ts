import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const backend = process.env.KVE_BACKEND ?? 'http://127.0.0.1:8006'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // Reachable from the LAN by IP or hostname; every visitor still signs in
    // with their own cluster token.
    host: process.env.KVE_HOST ?? '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/ws': { target: backend, ws: true, changeOrigin: false },
      '/healthz': backend,
      '/plugins': backend,
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
