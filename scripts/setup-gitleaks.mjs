import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const version = '8.30.1';
const builds = {
  'win32-x64': ['windows_x64.zip', 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'],
  'win32-arm64': ['windows_arm64.zip', 'b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f'],
  'linux-x64': ['linux_x64.tar.gz', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'],
  'linux-arm64': ['linux_arm64.tar.gz', 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'],
};
const build = builds[`${process.platform}-${process.arch}`];
if (!build) throw new Error('Gitleaks setup supports Windows and Linux on x64 and arm64.');
const filename = `gitleaks_${version}_${build[0]}`;
const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/${filename}`);
if (!response.ok) throw new Error(`Gitleaks download failed: ${response.status}`);
const data = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(data).digest('hex') !== build[1]) throw new Error('Gitleaks checksum mismatch.');
const directory = resolve('.runtime/tools');
mkdirSync(directory, { recursive: true });
const archive = resolve(directory, filename);
writeFileSync(archive, data);
const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot, 'System32/tar.exe') : 'tar';
execFileSync(tar, ['-xf', filename], { cwd: directory, stdio: 'inherit' });
console.log(`Gitleaks ${version} installed with a verified SHA-256 checksum.`);
