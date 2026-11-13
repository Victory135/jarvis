import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // src-tauri is excluded: cargo locks files in target/ while building, which crashed the watcher (EBUSY).
  server: { host: '127.0.0.1', port: 5174, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { rollupOptions: { input: { main: 'index.html', orb: 'orb.html' } } },
})
