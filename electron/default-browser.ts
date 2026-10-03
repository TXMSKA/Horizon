import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

import type { DefaultBrowserStatus } from '../src/shared/api';
export type { DefaultBrowserStatus } from '../src/shared/api';
export type RegistryRunner = (command: string, args: readonly string[]) => Promise<string | { stdout: string }>;
interface DefaultBrowserOptions {
  platform: string;
  isPackaged: boolean;
  execPath: string;
  runner?: RegistryRunner;
  openExternal: (url: string) => Promise<void>;
  changed?: (status: DefaultBrowserStatus) => void;
}

const USER_CHOICE = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
const CLASSES = 'HKCU\\Software\\Classes';
const CLIENT = 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon';
const SETTINGS_URL = 'ms-settings:defaultapps?registeredAppUser=Horizon';

const runRegistry: RegistryRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, [...args], { encoding: 'utf8', timeout: 2000, windowsHide: true, shell: false, maxBuffer: 64 * 1024 }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

export function createDefaultBrowser(options: DefaultBrowserOptions) {
  let status: DefaultBrowserStatus = options.platform !== 'win32' ? 'unsupported' : !options.isPackaged ? 'developmentBuild' : 'notDefault';
  const runner = options.runner ?? runRegistry;
  const registryPath = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const update = (next: DefaultBrowserStatus) => {
    if (status !== next) { status = next; options.changed?.(status); }
  };
  const refresh = async (): Promise<void> => {
    if (options.platform !== 'win32') { update('unsupported'); return; }
    if (!options.isPackaged) { update('developmentBuild'); return; }
    try {
      const result = await runner(registryPath, ['query', USER_CHOICE, '/v', 'ProgId']);
      const stdout = typeof result === 'string' ? result : result.stdout;
      update(/^\s*ProgId\s+REG_SZ\s+HorizonURL\s*$/im.test(stdout) ? 'default' : 'notDefault');
    } catch { update('notDefault'); }
  };
  const write = (key: string, name: string | null, value: string) => runner(registryPath, [
    'add', key, ...(name === null ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', value, '/f',
  ]);
  const register = async (): Promise<void> => {
    if (options.platform !== 'win32') throw new Error('DEFAULT_BROWSER_UNSUPPORTED');
    if (!options.isPackaged) throw new Error('DEFAULT_BROWSER_DEVELOPMENT_BUILD');
    try {
      if (!options.execPath || /["\x00-\x1f\x7f]/.test(options.execPath)) throw new Error('Invalid executable path');
      const executable = `"${options.execPath}"`;
      const icon = `${executable},0`;
      const openCommand = `${executable} "%1"`;
      await write(`${CLASSES}\\HorizonURL`, null, 'Horizon URL');
      await write(`${CLASSES}\\HorizonURL`, 'URL Protocol', '');
      await write(`${CLASSES}\\HorizonURL\\DefaultIcon`, null, icon);
      await write(`${CLASSES}\\HorizonURL\\shell\\open\\command`, null, openCommand);
      await write(`${CLASSES}\\HorizonHTML`, null, 'Horizon HTML Document');
      await write(`${CLASSES}\\HorizonHTML\\DefaultIcon`, null, icon);
      await write(`${CLASSES}\\HorizonHTML\\shell\\open\\command`, null, openCommand);
      await write(CLIENT, null, 'Horizon');
      await write(`${CLIENT}\\DefaultIcon`, null, icon);
      await write(`${CLIENT}\\shell\\open\\command`, null, openCommand);
      await write(`${CLIENT}\\Capabilities`, 'ApplicationName', 'Horizon');
      await write(`${CLIENT}\\Capabilities`, 'ApplicationDescription', 'Browse the web with Horizon');
      await write(`${CLIENT}\\Capabilities`, 'ApplicationIcon', icon);
      await write(`${CLIENT}\\Capabilities\\URLAssociations`, 'http', 'HorizonURL');
      await write(`${CLIENT}\\Capabilities\\URLAssociations`, 'https', 'HorizonURL');
      await write(`${CLIENT}\\Capabilities\\FileAssociations`, '.htm', 'HorizonHTML');
      await write(`${CLIENT}\\Capabilities\\FileAssociations`, '.html', 'HorizonHTML');
      await write('HKCU\\Software\\RegisteredApplications', 'Horizon', 'Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities');
    } catch { throw new Error('DEFAULT_BROWSER_REGISTRATION_FAILED'); }
    try { await options.openExternal(SETTINGS_URL); }
    catch { await refresh(); throw new Error('DEFAULT_BROWSER_SETTINGS_FAILED'); }
    await refresh();
  };
  return { get status() { return status; }, refresh, register };
}
