import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // The backend serves this build and already owns /assets for its API, so use another folder name.
  build: { assetsDir: 'static' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    force: true,
    include: ['react-pdf'],
    exclude: ['lucide-react'],
  },
});
