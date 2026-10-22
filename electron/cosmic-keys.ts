import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Options {
  root: string; origin: string; platform?: NodeJS.Platform; helperPath?: string;
  protect?(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  unprotect?(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}
interface Entry { sealedK: string; origin: string; createdAt: number; updatedAt: number; writer: string }
interface KeyFile { version: 1; accounts: Record<string, Entry> }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown) => object(error) && error.code === 'ENOENT';
const exists = (error: unknown) => object(error) && error.code === 'EEXIST';
const fields = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validId = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id);
function base64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && Buffer.from(value, 'base64').toString('base64') === value;
}
function readKeys(path: string): KeyFile {
  let descriptor: number | undefined;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4 * 1024 * 1024) throw new Error();
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > 4 * 1024 * 1024) throw new Error();
    const bytes = readFileSync(descriptor);
    if (bytes.length > 4 * 1024 * 1024) throw new Error();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(value) || !fields(value, ['version', 'accounts']) || value.version !== 1 || !object(value.accounts)) throw new Error();
    for (const [id, account] of Object.entries(value.accounts)) {
      if (!validId(id) || !object(account) || !fields(account, ['sealedK', 'origin', 'createdAt', 'updatedAt', 'writer'])
        || !base64(account.sealedK) || typeof account.origin !== 'string' || account.origin.length > 2048
        || typeof account.writer !== 'string' || !account.writer || account.writer.length > 128
        || typeof account.createdAt !== 'number' || !Number.isSafeInteger(account.createdAt) || account.createdAt < 0
        || typeof account.updatedAt !== 'number' || !Number.isSafeInteger(account.updatedAt) || account.updatedAt < account.createdAt) throw new Error();
    }
    return value as unknown as KeyFile;
  } catch (error) { if (missing(error)) return { version: 1, accounts: {} }; throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function run(path: string, args: string[]): Promise<string> {
  return new Promise((done, reject) => {
    execFile(path, args, { timeout: 15000, maxBuffer: 16384, windowsHide: true }, (error, stdout) => error ? reject(new Error('ACCOUNT_KEYSTORE')) : done(stdout));
  });
}
async function ownerOnly(directory: string) {
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const identity = await run(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = identity.match(/\bS-1-[0-9-]+\b/)?.[0];
  if (!sid) throw new Error('ACCOUNT_KEYSTORE');
  await run(join(system, 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/q']);
}
function helper(path: string, op: 'protect' | 'unprotect', data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((done, reject) => {
    const child = execFile(path, [], { timeout: 15000, maxBuffer: 16384, windowsHide: true }, (error, stdout, stderr) => {
      try {
        if (error || stderr || !/^\{[^\r\n]*\}\r?\n?$/.test(stdout)) throw new Error();
        const value: unknown = JSON.parse(stdout);
        if (!object(value) || !fields(value, ['data']) || !base64(value.data)) throw new Error();
        done(Uint8Array.from(Buffer.from(value.data, 'base64')));
      } catch { reject(new Error('ACCOUNT_KEYSTORE')); }
    });
    child.stdin?.on('error', () => { /* The callback reports helper failure without exposing the input. */ });
    child.stdin?.end(`${JSON.stringify({ op, data: Buffer.from(data).toString('base64') })}\n`);
  });
}
export function createCosmicKeyStore(options: Options) {
  const platform = options.platform ?? process.platform, kind = platform === 'win32' ? 'shared' : 'session';
  const memory = new Map<string, Uint8Array<ArrayBuffer>>();
  const directory = join(resolve(options.root), 'shared', 'keys'), path = join(directory, 'account.json'), lock = `${path}.lock`;
  const helperPath = options.helperPath ?? resolve(__dirname, '../../build/helpers/cosmic-dpapi.exe');
  const protect = options.protect ?? ((data: Uint8Array) => helper(helperPath, 'protect', data));
  const unprotect = options.unprotect ?? ((data: Uint8Array) => helper(helperPath, 'unprotect', data));
  const directories = (create: boolean) => {
    for (const folder of [resolve(options.root), join(resolve(options.root), 'shared'), directory]) {
      try { if (create) mkdirSync(folder, { recursive: true, mode: 0o700 }); }
      catch (error) { if (!exists(error)) throw error; }
      try { const entry = lstatSync(folder); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(); }
      catch (error) { if (!create && missing(error)) return false; throw error; }
    }
    return true;
  };
  return {
    kind: kind as 'shared' | 'session',
    async get(accountId: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
      try {
        if (!validId(accountId)) throw new Error();
        if (kind === 'session') return memory.get(accountId)?.slice();
        if (!directories(false)) return;
        const keys = readKeys(path), entry = Object.hasOwn(keys.accounts, accountId) ? keys.accounts[accountId] : undefined;
        if (!entry) return;
        if (entry.origin !== options.origin) throw new Error();
        const key = await unprotect(Buffer.from(entry.sealedK, 'base64'));
        if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error();
        return Uint8Array.from(key);
      } catch { throw new Error('ACCOUNT_KEYSTORE'); }
    },
    async set(accountId: string, key: Uint8Array): Promise<void> {
      let locked = false, temporary: string | undefined;
      try {
        if (!validId(accountId) || !(key instanceof Uint8Array) || key.length !== 32) throw new Error();
        if (kind === 'session') { memory.set(accountId, Uint8Array.from(key)); return; }
        const sealed = await protect(Uint8Array.from(key));
        if (!(sealed instanceof Uint8Array) || !sealed.length || sealed.length > 12288) throw new Error();
        let created = false;
        try { lstatSync(directory); } catch (error) { if (!missing(error)) throw error; created = true; }
        directories(true);
        if (created && process.platform === 'win32') await ownerOnly(directory);
        for (let attempt = 0; attempt < 2; attempt++) {
          try { closeSync(openSync(lock, 'wx', 0o600)); locked = true; break; }
          catch (error) {
            if (!exists(error) || attempt > 0) throw error;
            const entry = lstatSync(lock);
            if (!entry.isFile() || entry.isSymbolicLink() || Date.now() - entry.mtimeMs <= 10000) throw new Error();
            unlinkSync(lock);
          }
        }
        const keys = readKeys(path), previous = Object.hasOwn(keys.accounts, accountId) ? keys.accounts[accountId] : undefined;
        if (previous && previous.origin !== options.origin) throw new Error();
        const now = Date.now(), entry: Entry = { sealedK: Buffer.from(sealed).toString('base64'), origin: options.origin,
          createdAt: previous?.createdAt ?? now, updatedAt: Math.max(now, previous?.createdAt ?? 0), writer: 'horizon' };
        Object.defineProperty(keys.accounts, accountId, { value: entry, enumerable: true, configurable: true, writable: true });
        const bytes = Buffer.from(JSON.stringify(keys));
        if (bytes.length > 4 * 1024 * 1024) throw new Error();
        temporary = `${path}.${randomUUID()}.tmp`;
        const descriptor = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
        renameSync(temporary, path); temporary = undefined;
      } catch { throw new Error('ACCOUNT_KEYSTORE'); }
      finally {
        if (temporary) try { unlinkSync(temporary); } catch { /* Keep the sanitized storage error. */ }
        if (locked) try { unlinkSync(lock); } catch { /* A stale lock can be recovered on the next write. */ }
      }
    },
  };
}
