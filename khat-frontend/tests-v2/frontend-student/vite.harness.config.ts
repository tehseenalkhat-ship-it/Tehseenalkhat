import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const realThreadPanel = fileURLToPath(new URL('../../src/v2/chat/ThreadPanel.tsx', import.meta.url));
const stubThreadPanel = fileURLToPath(new URL('./ThreadPanelStub.tsx', import.meta.url));

/** Swap in the stub while the real ThreadPanel is still a placeholder (or when HARNESS_STUB_THREAD=1). */
function threadPanelStub(): Plugin {
  const usePlaceholder = () => process.env.HARNESS_STUB_THREAD === '1' || readFileSync(realThreadPanel, 'utf8').includes('PLACEHOLDER');
  return {
    name: 'harness-thread-panel-stub',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer || !/chat\/ThreadPanel(\.tsx)?$/.test(source) || importer === stubThreadPanel) return null;
      return usePlaceholder() ? stubThreadPanel : null;
    },
  };
}

export default defineConfig({
  root,
  plugins: [threadPanelStub(), react()],
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  server: { port: 5182, strictPort: true },
  optimizeDeps: { include: ['react-pdf'], exclude: ['lucide-react'] },
});
