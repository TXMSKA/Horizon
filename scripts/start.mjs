import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('dist/electron/main.js')) {
  console.error('Run npm run build before npm start.');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
try {
  const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
  child.on('error', error => { console.error(`Electron could not start: ${error.message}`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGINT', () => child.kill());
  process.on('SIGTERM', () => child.kill());
} catch (error) {
  console.error(`Electron could not start: ${error.message}`);
  process.exitCode = 1;
}
