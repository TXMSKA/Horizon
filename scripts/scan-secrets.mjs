import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const local = resolve('.runtime/tools', process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
const executable = existsSync(local) ? local : 'gitleaks';
const args = process.argv.includes('--staged')
  ? ['git', '--pre-commit', '--staged']
  : ['git', '--log-opts=--all'];
const result = spawnSync(executable, [...args, '--redact', '--no-banner', '--config=.gitleaks.toml'], { stdio: 'inherit' });
if (result.error) {
  console.error('Gitleaks is required. Install it with npm run setup:gitleaks.');
  process.exit(1);
}
process.exit(result.status ?? 1);
