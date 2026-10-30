// The dashboard's build (npm run build:web, which wrangler deploy and dev
// run first): web/ into web/dist/app, served at /app by the main Worker
// (server/worker/dash.ts). Its files are named by their hash.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/app/',
  plugins: [react()],
  build: { outDir: 'dist/app', emptyOutDir: true, assetsInlineLimit: 0 },
})
