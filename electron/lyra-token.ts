import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TokenStore } from 'lyra-client' with { 'resolution-mode': 'import' };
import type { StoreCipher } from './store';

const header = Buffer.from('HORIZON-LYRA-1\n');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function sealedLyraTokens(path: string, cipher: StoreCipher & { getSelectedStorageBackend?(): string }): TokenStore {
  const available = () => {
    // Linux's basic_text backend is not a system keyring and must not hold credentials.
    if (!cipher.isEncryptionAvailable() || cipher.getSelectedStorageBackend?.() === 'basic_text') throw new Error('LYRA_TOKEN_LOCKED');
  };
  return {
    async get() {
      available();
      if (!existsSync(path)) return undefined;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('LYRA_TOKEN_LOCKED');
      const bytes = readFileSync(path);
      if (!bytes.subarray(0, header.length).equals(header)) throw new Error('LYRA_TOKEN_LOCKED');
      const token = cipher.decryptString(bytes.subarray(header.length));
      if (!tokenPattern.test(token)) throw new Error('LYRA_TOKEN_LOCKED');
      return token;
    },
    async set(token) {
      available();
      if (!tokenPattern.test(token)) throw new Error('LYRA_TOKEN_LOCKED');
      const bytes = Buffer.concat([header, cipher.encryptString(token)]);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, path);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    },
  };
}
