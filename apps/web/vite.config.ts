import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// The version shown in Settings > About is the desktop app's (desktop/package.json), the one the installer carries.
const version = (JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8')) as { version: string }).version

// The browser talks to /api; in development Vite forwards it to the Nest API so there is no CORS to configure.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  preview: { port: 4173, proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } } },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } },
  },
})
