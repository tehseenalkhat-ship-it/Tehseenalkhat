import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

/** Test-only: other agents' files may import CSS that is not written yet — serve an empty sheet instead of failing. */
function tolerateMissingCss(): Plugin {
  return {
    name: 'tolerate-missing-css',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.css')) return null;
      return existsSync(resolve(dirname(importer), source)) ? null : '\0missing.css';
    },
    load(id) { return id === '\0missing.css' ? '' : null; },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [tolerateMissingCss(), react()],
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  optimizeDeps: { include: ['react-pdf'], exclude: ['lucide-react'] },
});
