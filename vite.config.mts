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
