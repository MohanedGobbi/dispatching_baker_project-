import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser talks to /api; in development Vite forwards it to the Nest API so there is no CORS to configure.
export default defineConfig({
  plugins: [react()],
  preview: { port: 4173, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } } },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } },
  },
})
