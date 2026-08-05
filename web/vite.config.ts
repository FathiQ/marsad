import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The build output is copied into internal/server/assets by the Docker build so
// the Go binary can embed it. Keeping it out of the Go tree during development
// means the repo never carries generated files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The graph libraries are large and always needed; splitting them buys
    // nothing but extra round trips on a dashboard served from the same pod.
    chunkSizeWarningLimit: 1400,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.MARSAD_API ?? 'http://localhost:8080',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
