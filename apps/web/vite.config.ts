import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the API runs separately (npm run dev in apps/server) and is proxied.
const target = process.env.ITEMDEX_API_PROXY || 'http://127.0.0.1:7777';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from a phone on the same Wi-Fi
    proxy: { '/api': target, '/media': target },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 600,
  },
});
