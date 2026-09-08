import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { developmentPorts } from './scripts/dev-support.ts'

const ports = developmentPorts(process.env.RP_DEV_API_PORT, process.env.RP_DEV_WEB_PORT)

export default defineConfig({
  root: 'apps/web', plugins: [react(), tailwind()],
  build: { outDir: 'dist', emptyOutDir: true, rolldownOptions: { output: { codeSplitting: { groups: [
    { name: 'react', test: /\/node_modules\/(?:react|react-dom|scheduler)\// },
    { name: 'controls', test: /\/node_modules\/(?:@radix-ui\/|radix-ui\/|motion\/|framer-motion\/|motion-dom\/|motion-utils\/)/ },
  ] } } } },
  server: { port: ports.web, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${ports.api}`, changeOrigin: false }, '/health': `http://127.0.0.1:${ports.api}` } },
})
