import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// In dev, forward API + WebSocket traffic to the backend (in production Fastify serves this app from the same origin).
const backend = 'http://localhost:8080'
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': backend, '/health': backend, '/ws': { target: backend, ws: true } } },
})
