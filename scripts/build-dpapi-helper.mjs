import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.platform === 'win32') {
  const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const output = resolve('build/helpers/cosmic-dpapi.exe');
  mkdirSync(resolve('build/helpers'), { recursive: true });
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/reference:System.Security.dll', '/reference:System.Web.Extensions.dll', `/out:${output}`, resolve('helpers/windows/cosmic-dpapi.cs')], { stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
}
