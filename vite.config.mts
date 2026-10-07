import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import { packageChromeExtensions } from './scripts/package-chrome-extensions.mjs';

export default defineConfig({
  base: '/',
  envDir: false,
  plugins: [{
    name: 'horizon-native-theme',
    closeBundle() {
      // Native window paint reads the same palette before the renderer can draw.
      copyFileSync('src/tokens.css', 'dist/tokens.css');
      // The window and taskbar show the app icon with its tile; dist stays self-contained for packaging.
      copyFileSync('assets/icon/horizon-icon-256.png', 'dist/icon.png');
      const require = createRequire(import.meta.url);
      packageChromeExtensions();
      const store = readFileSync(require.resolve('electron-chrome-web-store/preload'), 'utf8');
      if (!store.includes('var DEBUG = true;')) throw new Error('Review the store preload before changing its version');
      // Keep the vendor bridge out of other origins, subframes and logs that could contain login data.
      writeFileSync('dist/electron/store-preload.js', `if (process.isMainFrame && location.origin === 'https://chromewebstore.google.com' && !new URL(location.href).username && !new URL(location.href).password) {\n${store.replace('var DEBUG = true;', 'var DEBUG = false;')}\n}\n`);
      const browser = readFileSync(require.resolve('electron-chrome-web-store'), 'utf8');
      const debug = /var (d\d*) = \(0, import_debug\d*\.default\)\("electron-chrome-web-store:[^"]+"\);/g;
      const preloadLookup = 'return (0, import_node_module.createRequire)(__dirname).resolve("electron-chrome-web-store/preload");';
      if ([...browser.matchAll(debug)].length !== 4 || !browser.includes(preloadLookup)) throw new Error('Review the store logging and preload before changing its version');
      // An inherited DEBUG environment variable must not expose store payloads or login data.
      writeFileSync('dist/electron/web-store.cjs', browser.replace(debug, 'var $1 = () => {};').replace(preloadLookup, 'return path5.join(__dirname, "store-preload.js");'));
    },
  }],
  build: {
    outDir: 'dist/renderer',
    target: 'chrome148',
    emptyOutDir: true,
    rolldownOptions: {
      onwarn(warning, defaultHandler) {
        // Client-only rendering has no server boundary for Lucide's use-client directives.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.id?.includes('lucide-react')) return;
        defaultHandler(warning);
      },
    },
  },
});
