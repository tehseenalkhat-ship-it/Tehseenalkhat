// Test-only dev config: same as the app, but a CSS file another owner has not created yet
// resolves to an empty stylesheet so the shared dev server keeps running while others work.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  root,
  plugins: [react(), {
    name: 'missing-css-is-empty',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.endsWith('.css') || !importer || !id.startsWith('.')) return null;
      const full = resolve(dirname(importer), id);
      return existsSync(full) ? null : '\0empty.css';
    },
    load(id) { return id === '\0empty.css' ? '' : null; },
  }],
  resolve: { alias: { '@': resolve(root, 'src') } },
  optimizeDeps: { include: ['react-pdf'], exclude: ['lucide-react'] },
});
