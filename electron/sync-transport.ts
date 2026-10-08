import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { requireSync, SYNC_LIMITS, uuid } from './sync-format';
import type { SyncIdentity } from './sync-format';

export async function deadline<T>(work: Promise<T>, timeout: number = SYNC_LIMITS.timeout): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error('SYNC_TIMEOUT')), timeout); })]); }
  finally { clearTimeout(timer); }
}
const missing = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
export class FolderTransport {
  readonly root: string;
  constructor(folder: string, readonly timeout: number = SYNC_LIMITS.timeout) { requireSync(isAbsolute(folder) && folder.length <= 4096 && !folder.includes('\0'), 'SYNC_FOLDER'); this.root = resolve(folder); }
  private path(parts: string[]) {
    requireSync(parts.every(part => part !== '.' && part !== '..' && part.length > 0 && !/[\\/\x00]/.test(part)));
    const path = resolve(this.root, ...parts), local = relative(this.root, path); requireSync(!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)); return path;
  }
  private async safe(parts: string[], create = false) {
    let path = this.root;
    const root = await deadline(lstat(path), this.timeout); requireSync(root.isDirectory() && !root.isSymbolicLink(), 'SYNC_FOLDER');
    for (const part of parts) {
      path = join(path, part);
      if (create) try { await deadline(mkdir(path, { mode: 0o700 }), this.timeout); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
      const entry = await deadline(lstat(path), this.timeout); requireSync(entry.isDirectory() && !entry.isSymbolicLink(), 'SYNC_FOLDER');
    }
  }
  async list(parts: string[]): Promise<string[]> {
    this.path(parts);
    try { await this.safe(parts); } catch (error) { if (missing(error)) return []; throw error; }
    const directory = await deadline(opendir(this.path(parts)), this.timeout), names: string[] = [];
    try {
      for (;;) {
        const entry = await deadline(directory.read(), this.timeout); if (!entry) break;
        requireSync(names.length < SYNC_LIMITS.files, 'SYNC_LIMIT'); names.push(entry.name);
      }
    } finally { await deadline(directory.close(), this.timeout); }
    return names.sort();
  }
  async read(parts: string[], cap: number): Promise<Buffer> {
    const path = this.path(parts); await this.safe(parts.slice(0, -1));
    const entry = await deadline(lstat(path), this.timeout); requireSync(entry.isFile() && !entry.isSymbolicLink() && entry.size <= cap, 'SYNC_LIMIT');
    const file = await deadline(open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), this.timeout);
    try {
      const stat = await deadline(file.stat(), this.timeout); requireSync(stat.isFile() && stat.size <= cap, 'SYNC_LIMIT');
      const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
      while (offset < bytes.length) { const result = await deadline(file.read(bytes, offset, bytes.length - offset, offset), this.timeout); if (!result.bytesRead) break; offset += result.bytesRead; }
      requireSync(offset === stat.size && offset <= cap); return bytes.subarray(0, offset);
    } finally { await deadline(file.close(), this.timeout); }
  }
  async publish(parts: string[], bytes: Buffer, cap: number): Promise<void> {
    requireSync(bytes.length <= cap, 'SYNC_LIMIT'); const path = this.path(parts); await this.safe(parts.slice(0, -1), true);
    try { const previous = await this.read(parts, cap); requireSync(previous.equals(bytes)); return; } catch (error) { if (!missing(error)) throw error; }
    const temporary = `${path}.${randomUUID()}.partial`, file = await deadline(open(temporary, 'wx', 0o600), this.timeout);
    try { await deadline(file.writeFile(bytes), this.timeout); await deadline(file.sync(), this.timeout); }
    finally { await deadline(file.close(), this.timeout); }
    // Only this writer owns this namespace; a preexisting final file is verified above.
    await deadline(rename(temporary, path), this.timeout);
  }
  async remove(parts: string[]): Promise<void> {
    const path = this.path(parts); await this.safe(parts.slice(0, -1)); const stat = await deadline(lstat(path), this.timeout);
    requireSync(stat.isFile() && !stat.isSymbolicLink()); await deadline(unlink(path), this.timeout);
  }
}
export const writerParts = (device: string, generation: string) => { requireSync(uuid(device) && uuid(generation)); return ['writers', device, generation]; };
export const batchName = /^([1-9][0-9]{0,15})-([0-9a-f-]{36})\.hzs$/;
export function validBatch(name: string): { sequence: number; id: string } | null {
  const match = batchName.exec(name); if (!match || !uuid(match[2]) || !Number.isSafeInteger(Number(match[1]))) return null;
  return { sequence: Number(match[1]), id: match[2] };
}
export function validCheckpoint(name: string): { sequence: number; id: string } | null {
  const match = /^(0|[1-9][0-9]{0,15})-([0-9a-f-]{36})\.hzs$/.exec(name); if (!match || !uuid(match[2]) || !Number.isSafeInteger(Number(match[1]))) return null;
  return { sequence: Number(match[1]), id: match[2] };
}
export const objectName = (name: string) => name.endsWith('.hzs') && uuid(name.slice(0, -4));
export function decodeSync(key: Buffer, identity: SyncIdentity, bytes: Buffer): Promise<unknown> {
  return new Promise((done, reject) => {
    const worker = new Worker(join(__dirname, 'sync-worker.js'), { workerData: { key, identity, bytes }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    let settled = false;
    const finish = (work: () => void) => { if (settled) return; settled = true; clearTimeout(timer); work(); void worker.terminate(); };
    const timer = setTimeout(() => finish(() => reject(new Error('SYNC_TIMEOUT'))), SYNC_LIMITS.timeout);
    worker.once('message', (reply: { ok: boolean; value?: unknown; code?: string }) => finish(() => reply.ok ? done(reply.value) : reject(new Error(reply.code ?? 'SYNC_INVALID'))));
    worker.once('error', () => finish(() => reject(new Error('SYNC_INVALID'))));
    worker.once('exit', () => finish(() => reject(new Error('SYNC_INVALID'))));
  });
}
export const SYNC_ROOT_PARTS = ['Data', 'Horizon'] as const;
export function datasetFolder(folder: string, dataset: string) { requireSync(uuid(dataset)); return resolve(folder, ...SYNC_ROOT_PARTS, dataset); }
