import { closeSync, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import type { ImportBrowser } from '../src/shared/api';

export type PasswordsFormat = 'chrome' | 'edge' | 'firefox';
// The same cap as Vault's own file limit.
export const PASSWORDS_FILE_LIMIT = 8 * 1024 * 1024;

export function passwordsFormat(browser: ImportBrowser): PasswordsFormat {
  return browser === 'edge' ? 'edge' : browser === 'firefox' ? 'firefox' : 'chrome';
}

export function passwordsFileName(path: string): string {
  return basename(path).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 255);
}

// The exported file holds every password in plain text. It must be a plain file of text, and nothing about its content or place reaches an error.
export function readPasswordsFile(path: string): string {
  const refuse = () => new Error('IMPORT_PASSWORDS_FILE_INVALID');
  let listed;
  try { listed = lstatSync(path); } catch { throw refuse(); }
  if (!listed.isFile() || listed.isSymbolicLink()) throw refuse();
  if (listed.size > PASSWORDS_FILE_LIMIT) throw new Error('IMPORT_PASSWORDS_FILE_TOO_LARGE');
  let bytes: Buffer;
  try {
    const file = openSync(path, 'r');
    try {
      // The opened file must be the one that was checked, not a link put in its place meanwhile.
      const opened = fstatSync(file);
      if (!opened.isFile() || opened.ino !== listed.ino || opened.dev !== listed.dev) throw refuse();
      if (opened.size > PASSWORDS_FILE_LIMIT) throw new Error('IMPORT_PASSWORDS_FILE_TOO_LARGE');
      bytes = Buffer.alloc(opened.size);
      let read = 0;
      while (read < bytes.length) {
        const chunk = readSync(file, bytes, read, bytes.length - read, read);
        if (!chunk) break;
        read += chunk;
      }
      bytes = bytes.subarray(0, read);
    } finally { closeSync(file); }
  } catch (error: unknown) {
    if (error instanceof Error && /^IMPORT_PASSWORDS_/.test(error.message)) throw error;
    throw refuse();
  }
  if (bytes.includes(0)) throw refuse();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw refuse(); }
}

// Permanent: the file is removed, not moved to the Recycle Bin, and only when it is still the plain file that was chosen.
export function deletePasswordsFile(path: string): void {
  try {
    const listed = lstatSync(path);
    if (!listed.isFile() || listed.isSymbolicLink()) throw new Error('IMPORT_PASSWORDS_DELETE_FAILED');
    unlinkSync(path);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw new Error('IMPORT_PASSWORDS_DELETE_FAILED');
  }
}
