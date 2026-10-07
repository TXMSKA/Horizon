import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoreCipher } from './store';
import type { TokenStore } from 'vault-client' with { 'resolution-mode': 'import' };

type VaultCipher = StoreCipher & { getSelectedStorageBackend?(): string };
const header = Buffer.from('HORIZON-VAULT-1\n');
function available(cipher: VaultCipher) {
  // Electron's Linux basic_text backend is obfuscation, not an OS secret store.
  if (!cipher.isEncryptionAvailable() || cipher.getSelectedStorageBackend?.() === 'basic_text') throw new Error('VAULT_STORAGE_UNAVAILABLE');
}
export function readVaultFile(path: string, cipher: VaultCipher): unknown {
  available(cipher);
  if (!existsSync(path)) return undefined;
  try {
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error();
    const bytes = readFileSync(path);
    if (!bytes.subarray(0, header.length).equals(header)) throw new Error();
    return JSON.parse(cipher.decryptString(bytes.subarray(header.length)));
  } catch { throw new Error('VAULT_STORAGE_UNAVAILABLE'); }
}
export function writeVaultFile(path: string, value: unknown, cipher: VaultCipher): void {
  available(cipher);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, Buffer.concat([header, cipher.encryptString(JSON.stringify(value))]), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch { throw new Error('VAULT_STORAGE_UNAVAILABLE'); }
  finally { if (existsSync(temporary)) try { unlinkSync(temporary); } catch { /* Preserve the storage error. */ } }
}
export function vaultTokenStore(path: string, cipher: VaultCipher): TokenStore {
  return {
    async get() {
      const value = readVaultFile(path, cipher);
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('VAULT_STORAGE_UNAVAILABLE');
      return value;
    },
    async set(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('VAULT_STORAGE_UNAVAILABLE');
      writeVaultFile(path, token, cipher);
    },
  };
}

export function vaultClipboard(clipboard: { writeText(value: string): void | Promise<void>; readText(): string | Promise<string>; clear(): void | Promise<void> }, schedule = (work: () => void) => setTimeout(work, 30000)) {
  let owned: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let writing = Promise.resolve();
  const clearOwned = async () => {
    clearTimeout(timer); timer = undefined;
    // Preserve clipboard content copied from another application after this value.
    const value = owned, ticket = generation;
    if (value === undefined) return;
    const current = await clipboard.readText();
    if (generation !== ticket) return;
    if (current === value) await clipboard.clear();
    if (owned === value) owned = undefined;
  };
  const clear = async () => {
    const ticket = ++generation;
    await writing.catch(() => undefined);
    if (ticket === generation) await clearOwned();
  };
  return {
    copy(value: string) {
      const ticket = ++generation;
      writing = writing.catch(() => undefined).then(async () => {
        await clearOwned();
        if (ticket !== generation) return;
        await clipboard.writeText(value); owned = value;
        // Closing or locking during the asynchronous OS write must clear its result.
        if (ticket !== generation) { await clearOwned(); return; }
        timer = schedule(() => { void clear().catch(() => undefined); }); timer.unref?.();
      });
      return writing;
    }, clear,
  };
}
