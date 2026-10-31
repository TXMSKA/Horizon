import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Options {
  root: string; origin: string; platform?: NodeJS.Platform; helperPath?: string;
  protect?(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  unprotect?(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  command?(path: string, args: string[], options: CommandOptions): Promise<CommandResult>;
}
interface CommandOptions { shell: false; timeout: number; maxBuffer: number; windowsHide: true; input?: string }
interface CommandResult { code: number | null; stdout: string; stderr: string }
interface Metadata { origin: string; createdAt: number; updatedAt: number; writer: string }
type Entry = Metadata & ({ sealedK: string; store?: 'dpapi' } | { store: 'libsecret' });
interface KeyFile { version: 1; accounts: Record<string, Record<string, unknown>> }
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
      if (!validId(id) || !object(account)) throw new Error();
      if (Object.hasOwn(account, 'store') && account.store !== 'dpapi' && account.store !== 'libsecret') continue;
      const keys = ['origin', 'createdAt', 'updatedAt', 'writer'];
      if (account.store !== 'libsecret') keys.unshift('sealedK');
      if (Object.hasOwn(account, 'store')) keys.unshift('store');
      if (!fields(account, keys) || account.store !== 'libsecret' && !base64(account.sealedK)
        || typeof account.origin !== 'string' || account.origin.length > 2048
        || typeof account.writer !== 'string' || !account.writer || account.writer.length > 128
        || typeof account.createdAt !== 'number' || !Number.isSafeInteger(account.createdAt) || account.createdAt < 0
        || typeof account.updatedAt !== 'number' || !Number.isSafeInteger(account.updatedAt) || account.updatedAt < account.createdAt) throw new Error();
    }
    return value as unknown as KeyFile;
  } catch (error) { if (missing(error)) return { version: 1, accounts: {} }; throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function command(path: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((done, reject) => {
    const { input, ...settings } = options;
    const child = execFile(path, args, settings, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) reject(new Error('ACCOUNT_KEYSTORE'));
      else done({ code: error?.code as number | undefined ?? 0, stdout, stderr });
    });
    child.stdin?.on('error', () => { /* Process failures are handled without exposing stdin. */ });
    child.stdin?.end(input);
  });
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
  const platform = options.platform ?? process.platform;
  let kind: 'shared' | 'session' = platform === 'win32' ? 'shared' : 'session', probe: Promise<void> | undefined;
  const sessionOnly = () => kind === 'session';
  const memory = new Map<string, Uint8Array<ArrayBuffer>>();
  const directory = join(resolve(options.root), 'shared', 'keys'), path = join(directory, 'account.json'), lock = `${path}.lock`;
  const helperPath = options.helperPath ?? resolve(__dirname, '../../build/helpers/cosmic-dpapi.exe');
  const protect = options.protect ?? ((data: Uint8Array) => helper(helperPath, 'protect', data));
  const unprotect = options.unprotect ?? ((data: Uint8Array) => helper(helperPath, 'unprotect', data));
  const execute = (args: string[], input?: string) => (options.command ?? command)('secret-tool', args,
    { shell: false, timeout: 15000, maxBuffer: 1024, windowsHide: true, ...(input === undefined ? {} : { input }) });
  const available = async () => {
    if (platform !== 'linux') return;
    probe ??= (async () => {
      try {
        // libsecret reports a successful search with no match as exit 1 and empty stdout/stderr.
        // A reserved non-account attribute set avoids reading any account secret during the one bounded probe.
        const result = await execute(['lookup', 'application', 'cosmic', 'kind', 'keystore-probe', 'probe', 'horizon-v1']);
        if (result.code === 1 && result.stdout === '' && result.stderr === '') kind = 'shared';
      } catch { /* Unsupported Secret Service sessions keep keys in memory only. */ }
    })();
    await probe;
  };
  const secret = async (op: 'store' | 'lookup' | 'clear', accountId: string, input?: string) => {
    try {
      const result = await execute([op, ...(op === 'store' ? [`--label=Cosmic account key (${accountId})`] : []),
        'application', 'cosmic', 'kind', 'account-key', 'account', accountId], input);
      if (result.code !== 0 || result.stderr) throw new Error();
      if (kind === 'session') return undefined;
      return result.stdout;
    } catch { kind = 'session'; return undefined; }
  };
  const known = (entry: Record<string, unknown>) => entry.store === undefined || entry.store === 'dpapi' || entry.store === 'libsecret';
  const directories = (create: boolean) => {
    for (const folder of [resolve(options.root), join(resolve(options.root), 'shared'), directory]) {
      try { if (create) mkdirSync(folder, { recursive: true, mode: 0o700 }); }
      catch (error) { if (!exists(error)) throw error; }
      try { const entry = lstatSync(folder); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(); }
      catch (error) { if (!create && missing(error)) return false; throw error; }
    }
    return true;
  };
  const write = async (accountId: string, key?: Uint8Array): Promise<void> => {
    let locked = false, temporary: string | undefined;
    try {
      if (!validId(accountId) || key !== undefined && (!(key instanceof Uint8Array) || key.length !== 32)) throw new Error();
      await available();
      const session = () => { memory.get(accountId)?.fill(0); if (key) memory.set(accountId, Uint8Array.from(key)); else memory.delete(accountId); };
      if (sessionOnly()) { session(); return; }
      if (!key && !directories(false)) return;
      const sealed = key && platform === 'win32' ? await protect(Uint8Array.from(key)) : undefined;
      if (key && platform === 'win32' && (!(sealed instanceof Uint8Array) || !sealed.length || sealed.length > 12288)) throw new Error();
      let created = false;
      try { lstatSync(directory); } catch (error) { if (!missing(error)) throw error; created = true; }
      directories(true);
      if (created && process.platform === 'win32') await ownerOnly(directory);
      const deadline = Date.now() + 8000;
      let recovered = false;
      for (;;) {
        try { closeSync(openSync(lock, 'wx', 0o600)); locked = true; break; }
        catch (error) {
          if (!exists(error)) throw error;
          let entry;
          try { entry = lstatSync(lock); } catch (error) { if (missing(error)) continue; throw error; }
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error();
          if (!recovered && Date.now() - entry.mtimeMs > 10000) { unlinkSync(lock); recovered = true; }
          else {
            if (Date.now() >= deadline) throw new Error();
            await new Promise(done => setTimeout(done, 20));
          }
        }
      }
      if (sessionOnly()) { session(); return; }
      const keys = readKeys(path), previous = Object.hasOwn(keys.accounts, accountId) ? keys.accounts[accountId] : undefined;
      if (previous && !known(previous)) { if (key) throw new Error(); return; }
      if (previous && known(previous) && previous.origin !== options.origin) throw new Error();
      if (!key && (!previous || !known(previous))) return;
      const now = Date.now(), createdAt = previous && known(previous) ? previous.createdAt as number : now;
      const entry: Entry = { ...(platform === 'linux' ? { store: 'libsecret' as const } : { sealedK: Buffer.from(sealed ?? []).toString('base64') }), origin: options.origin,
        createdAt, updatedAt: Math.max(now, createdAt), writer: 'horizon' };
      if (platform !== 'linux' && previous?.store === 'libsecret') throw new Error();
      if (key) Object.defineProperty(keys.accounts, accountId, { value: entry, enumerable: true, configurable: true, writable: true });
      else delete keys.accounts[accountId];
      const bytes = Buffer.from(JSON.stringify(keys));
      if (bytes.length > 4 * 1024 * 1024) throw new Error();
      if (platform === 'linux') {
        if (previous?.store === 'libsecret' && await secret('clear', accountId) === undefined) { session(); return; }
        if (key && await secret('store', accountId, Buffer.from(key).toString('base64')) === undefined) { session(); return; }
      }
      temporary = `${path}.${randomUUID()}.tmp`;
      const descriptor = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, path); temporary = undefined;
    } catch { throw new Error('ACCOUNT_KEYSTORE'); }
    finally {
      if (temporary) try { unlinkSync(temporary); } catch { /* Keep the sanitized storage error. */ }
      if (locked) try { unlinkSync(lock); } catch { /* A stale lock can be recovered on the next write. */ }
    }
  };
  return {
    get kind() { return kind; },
    async get(accountId: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
      try {
        if (!validId(accountId)) throw new Error();
        await available();
        if (kind === 'session') return memory.get(accountId)?.slice();
        if (!directories(false)) return;
        const keys = readKeys(path), entry = Object.hasOwn(keys.accounts, accountId) ? keys.accounts[accountId] : undefined;
        if (!entry || !known(entry)) return;
        if (entry.origin !== options.origin) throw new Error();
        let key: Uint8Array;
        if (platform === 'linux') {
          if (entry.store !== 'libsecret') return;
          const output = await secret('lookup', accountId);
          if (output === undefined) return memory.get(accountId)?.slice();
          const value = output.endsWith('\n') ? output.slice(0, -1) : output;
          if (!base64(value)) throw new Error();
          key = Buffer.from(value, 'base64');
        } else {
          if (entry.store === 'libsecret') return;
          key = await unprotect(Buffer.from(entry.sealedK as string, 'base64'));
        }
        if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error();
        return Uint8Array.from(key);
      } catch { throw new Error('ACCOUNT_KEYSTORE'); }
    },
    async set(accountId: string, key: Uint8Array) {
      if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('ACCOUNT_KEYSTORE');
      return write(accountId, Uint8Array.from(key));
    },
    clear: (accountId: string) => write(accountId),
  };
}
