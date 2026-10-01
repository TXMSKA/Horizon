import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const node = process.execPath;
const tsc = require.resolve('typescript/bin/tsc');
const vite = resolve(require.resolve('vite/package.json'), '../bin/vite.js');
let app;
let building = false;
let pending = false;
let timer;
let stopping = false;
const run = (entry, args) => new Promise((resolve, reject) => {
  const child = spawn(node, [entry, ...args], { stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error('Build failed')));
});
async function rebuild() {
  if (building) { pending = true; return; }
  building = true;
  app?.kill();
  try {
    await run(tsc, ['-p', 'tsconfig.electron.json']);
    await run(vite, ['build', '--mode', 'development']);
    if (!stopping) app = spawn(node, ['scripts/start.mjs'], { stdio: 'inherit' });
  } catch (error) { console.error(error.message); }
  finally {
    building = false;
    if (pending && !stopping) { pending = false; void rebuild(); }
  }
}
const changed = () => { clearTimeout(timer); timer = setTimeout(() => { void rebuild(); }, 150); };
const watchers = ['src', 'electron'].map(directory => watch(directory, { recursive: true }, changed));
watchers.push(watch('vite.config.mts', changed));
const stop = () => {
  stopping = true;
  clearTimeout(timer);
  watchers.forEach(watcher => watcher.close());
  app?.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// Serving Vite's built output keeps development under the production CSP without unsafe HMR.
await rebuild();
