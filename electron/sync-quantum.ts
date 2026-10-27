import { createHash, randomUUID } from 'node:crypto';
import { accountId, accountRecord, datasetTime } from './spaces';
import { canonical, checkIdentity, integer, openSync, requireSync, sealSync, shape, SYNC_LIMITS, uuid, validateDataset } from './sync-format';
import type { DatasetParameters } from './sync-format';
import { deadline } from './sync-transport';
import type { SyncTransport } from './sync-transport';

export interface QuantumAccount {
  readonly accountId: string;
  readonly computerId: string;
  readonly profileIds: readonly string[];
  assertActive(): void;
  request(path: string, init?: RequestInit, cap?: number): Promise<Response>;
  deriveSyncKey(datasetId: string): Promise<Buffer>;
}
export type QuantumProfileAccount = QuantumAccount;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const validPath = (path: string) => path.length > 0 && path.length <= 255 && /^[A-Za-z0-9_./-]+$/.test(path)
  && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
const absent = () => Object.assign(new Error('SYNC_INVALID'), { code: 'ENOENT' });
function accountFailure(error: unknown): never {
  if (error instanceof Error && error.message === 'ACCOUNT_DENIED') throw new Error('SYNC_NOT_ALLOWED');
  if (error instanceof Error && error.message === 'ACCOUNT_TIMEOUT') throw new Error('SYNC_TIMEOUT');
  if (error instanceof Error && error.message === 'ACCOUNT_INVALID_RESPONSE') throw new Error('SYNC_INVALID');
  throw error;
}
async function capped(response: Response, cap: number, timeout: number): Promise<Buffer> {
  const length = response.headers.get('content-length');
  requireSync(length === null || /^\d+$/.test(length) && Number.isSafeInteger(Number(length)), 'SYNC_INVALID');
  if (length !== null && Number(length) > cap) { await response.body?.cancel(); throw new Error('SYNC_LIMIT'); }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader?.cancel().catch(() => {}); }, timeout);
  if (reader) try {
    for (;;) {
      const { done, value } = await deadline(reader.read(), timeout); if (done) break;
      size += value.byteLength;
      if (size > cap) { await reader.cancel(); throw new Error('SYNC_LIMIT'); }
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
  else clearTimeout(timer);
  requireSync(!timedOut, 'SYNC_TIMEOUT');
  requireSync(length === null || Number(length) === size); return Buffer.concat(chunks);
}
function retryDelay(header: string | null): number {
  if (header === null) return 60000;
  const seconds = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 86400000)) : 60000;
}
async function request(account: QuantumAccount, path: string, init: RequestInit, timeout: number, cap?: number): Promise<Response> {
  let response: Response;
  try { account.assertActive(); response = await deadline(account.request(path, init, cap), timeout); account.assertActive(); }
  catch (error) { return accountFailure(error); }
  if (response.status === 200 || response.status === 201) return response;
  let value: unknown;
  try { value = JSON.parse((await deadline(capped(response, 65536, timeout), timeout)).toString('utf8')); }
  catch (error) { if (error instanceof Error && ['SYNC_LIMIT', 'SYNC_TIMEOUT'].includes(error.message)) throw error; }
  const code = accountRecord(value) && accountRecord(value.error) && typeof value.error.code === 'string' ? value.error.code : '';
  if (response.status === 429) {
    const retryAfterMs = retryDelay(response.headers.get('retry-after'));
    throw Object.assign(new Error('SYNC_RATE_LIMITED'), { retryAfterMs, retryAfter: retryAfterMs / 1000 });
  }
  if (response.status === 404) throw absent();
  if (response.status === 401) throw new Error('SYNC_NOT_ALLOWED');
  if (code === 'pool_exceeded' || code === 'quota_exceeded' || code === 'storage_full') throw new Error('SYNC_FULL');
  if (response.status === 403) throw new Error('SYNC_NOT_ALLOWED');
  if (response.status === 409 && code === 'object_conflict') throw new Error('SYNC_CONFLICT');
  if (response.status === 413 || ['dataset_limit', 'object_limit', 'writer_limit_exceeded', 'object_too_large', 'size_limit'].includes(code)) throw new Error('SYNC_LIMIT');
  if (response.status === 408 || response.status === 504) throw new Error('SYNC_TIMEOUT');
  throw new Error(response.status >= 500 ? 'SYNC_STORAGE' : 'SYNC_INVALID');
}
async function json(account: QuantumAccount, path: string, timeout: number): Promise<Record<string, unknown>> {
  const response = await request(account, path, { method: 'GET' }, timeout);
  let value: unknown;
  try { value = JSON.parse((await deadline(capped(response, 65536, timeout), timeout)).toString('utf8')); } catch (error) { if (error instanceof Error && error.message.startsWith('SYNC_')) throw error; throw new Error('SYNC_INVALID'); }
  requireSync(accountRecord(value)); return value;
}
export class QuantumTransport implements SyncTransport {
  constructor(readonly account: QuantumAccount, readonly datasetId: string, readonly timeout: number = SYNC_LIMITS.timeout) {
    requireSync(accountId(account.accountId) && uuid(account.computerId) && uuid(datasetId) && account.profileIds.length > 0
      && account.profileIds.every(uuid) && new Set(account.profileIds).size === account.profileIds.length);
  }
  describe() { return { kind: 'quantum' as const, label: 'Cosmic' }; }
  private route(path: string) { requireSync(validPath(path)); return `/v1/datasets/${this.datasetId}/objects/${path.split('/').map(encodeURIComponent).join('/')}`; }
  readDescriptor() { return this.readObject('dataset.hzs', 4096); }
  async *listObjects(prefix: string) {
    requireSync(validPath(prefix)); const children = new Set<string>(); let after: string | null = null, scanned = 0;
    do {
      const query = new URLSearchParams({ prefix: `${prefix}/`, limit: '100' }); if (after !== null) query.set('after', after);
      const value = await json(this.account, `/v1/datasets/${this.datasetId}/objects?${query}`, this.timeout);
      requireSync(Array.isArray(value.objects) && value.objects.length <= 100 && (value.after === null || typeof value.after === 'string'));
      let previous = after;
      for (const row of value.objects) {
        requireSync(accountRecord(row) && typeof row.path === 'string' && validPath(row.path) && row.path.startsWith(`${prefix}/`)
          && (previous === null || row.path > previous) && integer(row.size) && typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.sha256)
          && datasetTime(row.createdAt) !== null);
        previous = row.path; requireSync(++scanned <= SYNC_LIMITS.records, 'SYNC_LIMIT');
        const child = `${prefix}/${row.path.slice(prefix.length + 1).split('/')[0]}`;
        if (!children.has(child)) { requireSync(children.size < SYNC_LIMITS.files, 'SYNC_LIMIT'); children.add(child); yield child; }
      }
      requireSync(value.after === null || value.objects.length > 0 && value.after === previous && value.after !== after);
      after = value.after as string | null;
    } while (after !== null);
  }
  async readObject(path: string, cap: number): Promise<Buffer> {
    requireSync(Number.isSafeInteger(cap) && cap >= 0 && cap <= SYNC_LIMITS.blob, 'SYNC_LIMIT');
    const response = await request(this.account, this.route(path), { method: 'GET' }, this.timeout, cap);
    const bytes = await deadline(capped(response, cap, this.timeout), this.timeout);
    requireSync(response.headers.get('x-content-sha256') === hash(bytes));
    try { this.account.assertActive(); } catch (error) { accountFailure(error); } return bytes;
  }
  async writeObject(path: string, bytes: Buffer, cap: number): Promise<void> {
    requireSync(Buffer.isBuffer(bytes) && Number.isSafeInteger(cap) && cap >= 0 && cap <= SYNC_LIMITS.blob && bytes.length <= cap, 'SYNC_LIMIT');
    if (path !== 'dataset.hzs') requireSync(path.startsWith(`writers/${this.account.computerId}/`), 'SYNC_NOT_ALLOWED');
    const response = await request(this.account, this.route(path), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': hash(bytes) }, body: Uint8Array.from(bytes) }, this.timeout);
    await response.body?.cancel();
  }
  async deleteOwnObject(path: string, device: string): Promise<void> {
    requireSync(device === this.account.computerId && path.startsWith(`writers/${device}/`), 'SYNC_NOT_ALLOWED');
    const response = await request(this.account, this.route(path), { method: 'DELETE' }, this.timeout); await response.body?.cancel();
  }
}
export async function enrollQuantumDataset(account: QuantumAccount): Promise<{ datasetId: string; key: Buffer; descriptor: DatasetParameters; transport: QuantumTransport }> {
  let after: string | null = null, count = 0;
  do {
    const query = new URLSearchParams({ limit: '100' }); if (after !== null) query.set('after', after);
    const value = await json(account, `/v1/datasets?${query}`, SYNC_LIMITS.timeout);
    requireSync(Array.isArray(value.datasets) && value.datasets.length <= 100 && (value.after === null || typeof value.after === 'string'));
    let previous = after;
    for (const row of value.datasets) {
      requireSync(accountRecord(row) && typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(row.id) && row.appId === 'horizon'
        && (previous === null || row.id > previous) && datasetTime(row.createdAt) !== null);
      previous = row.id; requireSync(++count <= SYNC_LIMITS.files, 'SYNC_LIMIT'); if (!uuid(row.id)) continue;
      const transport = new QuantumTransport(account, row.id); let key: Buffer | undefined;
      try {
        const descriptor: unknown = JSON.parse((await transport.readDescriptor()).toString('utf8')); validateDataset(descriptor);
        requireSync(descriptor.datasetId === row.id && descriptor.keyType === 'account');
        key = await account.deriveSyncKey(row.id); requireSync(key.length === 32);
        const check = openSync(key, checkIdentity(row.id), Buffer.from(descriptor.check, 'base64'));
        requireSync(shape(check, ['check']) && check.check === 'Horizon Sync', 'SYNC_WRONG_KEY');
        return { datasetId: row.id, key, descriptor, transport };
      } catch (error) {
        key?.fill(0);
        if (!(error instanceof SyntaxError) && !(error instanceof Error && ['SYNC_INVALID', 'SYNC_WRONG_KEY', 'SYNC_NEWER_FORMAT'].includes(error.message))) throw error;
      }
    }
    requireSync(value.after === null || value.datasets.length > 0 && value.after === previous && value.after !== after);
    after = value.after as string | null;
  } while (after !== null);
  const datasetId = randomUUID(), transport = new QuantumTransport(account, datasetId), key = await account.deriveSyncKey(datasetId);
  try {
    requireSync(key.length === 32);
    const response = await request(account, `/v1/datasets/${datasetId}`, { method: 'PUT' }, SYNC_LIMITS.timeout); await response.body?.cancel();
    const descriptor: DatasetParameters = { magic: 'Horizon Sync', version: 1, datasetId, keyType: 'account',
      check: sealSync(key, checkIdentity(datasetId), { check: 'Horizon Sync' }).toString('base64') };
    await transport.writeObject('dataset.hzs', Buffer.from(canonical(descriptor)), 4096); return { datasetId, key, descriptor, transport };
  } catch (error) { key.fill(0); throw error; }
}
