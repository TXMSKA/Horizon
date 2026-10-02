import { copyFileSync } from 'node:fs';
import { defineConfig } from 'vite';

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
