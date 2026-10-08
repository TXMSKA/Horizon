import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoreCipher } from './store';
import { requireSync, shape } from './sync-format';

const header = Buffer.from('HORIZON-SYNC-1\n'), cap = 128 * 1024 * 1024;
export type SyncCipher = StoreCipher & { getSelectedStorageBackend?(): string };
export function syncStorageAvailable(cipher: SyncCipher) { requireSync(cipher.isEncryptionAvailable() && cipher.getSelectedStorageBackend?.() !== 'basic_text', 'SYNC_LOCKED'); }
const fileIdentity = (path: string) => { const stat = statSync(path); return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; };
export function readSyncState(path: string, cipher: SyncCipher, status?: { restored: boolean }): unknown {
  syncStorageAvailable(cipher); if (!existsSync(path)) return undefined;
  try {
    requireSync(statSync(path).size <= cap, 'SYNC_LIMIT'); const bytes = readFileSync(path);
    requireSync(bytes.subarray(0, header.length).equals(header)); const value: unknown = JSON.parse(cipher.decryptString(bytes.subarray(header.length)));
    requireSync(shape(value, ['fileId', 'value']) && typeof value.fileId === 'string'); if (status) status.restored = value.fileId !== fileIdentity(path); return value.value;
  } catch { throw new Error('SYNC_STORAGE'); }
}
export function atomicSyncFile(path: string, bytes: Buffer) {
  requireSync(bytes.length <= cap, 'SYNC_LIMIT'); const temporary = `${path}.${randomUUID()}.tmp`;
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  catch { throw new Error('SYNC_STORAGE'); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function writeSyncState(path: string, value: unknown, cipher: SyncCipher) {
  syncStorageAvailable(cipher);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(temporary, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    // Atomic replacement preserves this file identity; copying a backup does not.
    const json = JSON.stringify({ fileId: fileIdentity(temporary), value }); requireSync(Buffer.byteLength(json) <= cap, 'SYNC_LIMIT');
    const bytes = Buffer.concat([header, cipher.encryptString(json)]); requireSync(bytes.length <= cap, 'SYNC_LIMIT'); writeFileSync(temporary, bytes, { flag: 'r+' }); renameSync(temporary, path);
  }
  catch { throw new Error('SYNC_STORAGE'); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
