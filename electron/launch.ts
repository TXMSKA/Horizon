import { statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isWebURL } from './browsing';

const ADDRESS_LIMIT = 8192;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

function boundedAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ADDRESS_LIMIT
    && value.trim() === value && !CONTROL_CHARACTERS.test(value);
}
function isHTMLFile(path: string): boolean {
  try { return ['.html', '.htm'].includes(extname(path).toLowerCase()) && statSync(path).isFile(); }
  catch { return false; }
}

export function isLocalHTMLURL(value: unknown): value is string {
  if (!boundedAddress(value) || !/^file:\/\//i.test(value) || /[\\?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.username || url.password || url.search || url.hash) return false;
    const path = fileURLToPath(url);
    return !CONTROL_CHARACTERS.test(path) && isHTMLFile(path);
  } catch { return false; }
}

// An address-bar entry that names an existing local HTML file: a drive path (optionally quoted, as Explorer's
// "Copy as path" yields) or a file URL. Returns the canonical file URL, or null so the normal rules apply.
export function localHTMLAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (value.length > 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim();
  if (!boundedAddress(value)) return null;
  try {
    if (/^file:\/\//i.test(value)) return isLocalHTMLURL(value) ? pathToFileURL(fileURLToPath(value)).href : null;
    // Only absolute paths: a drive path on Windows, a path from the root elsewhere.
    if (!(process.platform === 'win32' ? /^[a-z]:[\\/]/i.test(value) : value.startsWith('/'))) return null;
    const url = launchAddress([value]);
    return url && isLocalHTMLURL(url) ? url : null;
  } catch { return null; }
}

export function launchAddress(args: readonly string[], workingDirectory?: string): string | null {
  let address: string | null = null;
  for (const value of args) {
    if (!boundedAddress(value) || value.startsWith('-')) continue;
    if (isWebURL(value)) { address = value; continue; }
    // Only filesystem paths may reach the file branch; URI schemes are never launch commands.
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) continue;
    try {
      const path = resolve(workingDirectory ?? process.cwd(), value);
      if (!isHTMLFile(path)) continue;
      const url = pathToFileURL(path).href;
      if (isLocalHTMLURL(url)) address = url;
    } catch { /* An invalid path does not prevent a later valid address from opening. */ }
  }
  return address;
}
