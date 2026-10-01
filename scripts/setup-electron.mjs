import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const env = { ...process.env, electron_config_cache: resolve('.npm-cache/electron') };
// The download is verified only against the checksums.json bundled with the pinned package, from the official host.
for (const name of Object.keys(env)) {
  if (/^(npm_config_)?electron_(mirror|use_remote_checksums)$/i.test(name)) delete env[name];
}
const result = spawnSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
