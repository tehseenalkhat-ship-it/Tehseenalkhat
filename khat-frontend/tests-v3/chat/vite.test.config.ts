// Test-only vite config (chat owner): same as vite.config.ts but no HMR / file watching,
// so other agents' edits don't reload the page in the middle of a Playwright run.
import base from '../../vite.config';
export default { ...base, root: new URL('../..', import.meta.url).pathname, server: { hmr: false, watch: { ignored: ['**/*'] } } };
