import { createHash, randomUUID } from 'node:crypto';
import { accountId, accountRecord } from './spaces';
import { canonical, checkIdentity, integer, openSync, requireSync, sealSync, shape, SYNC_LIMITS, uuid, validateDataset } from './sync-format';
import type { DatasetParameters } from './sync-format';
import { deadline } from './sync-transport';
import type { SyncTransport } from './sync-transport';

export interface QuantumAccount {
  readonly accountId: string;
  readonly revision?: string;
  readonly computerId: string;
  readonly profileIds: readonly string[];
  assertActive(): void;
  request(path: string, init?: RequestInit, cap?: number): Promise<Response>;
  deriveSyncKey(datasetId: string): Promise<Buffer>;
  subscribeChanges?(listener: (page: QuantumChangePage | null) => Promise<void>): () => void;
}
export type QuantumProfileAccount = QuantumAccount;
export interface QuantumChange {
  seq: number; type: string; ownerType: 'account' | 'space'; ownerId: string; appId: string | null; datasetId: string | null;
  path: string | null; size: number | null; sha256: string | null; memberId: string | null; generation: number | null; createdAt: number;
}
export interface QuantumChangePage { changes: QuantumChange[]; cursor: string; retryAfterMs: number; skippedChanges?: number }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const validPath = (path: string) => path.length > 0 && path.length <= 255 && /^[A-Za-z0-9_./-]+$/.test(path)
  && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
function accountFailure(error: unknown): never {
  if (error instanceof Error && error.message === 'ACCOUNT_DENIED') throw new Error('SYNC_NOT_ALLOWED');
  if (error instanceof Error && error.message === 'ACCOUNT_CONSENT') throw new Error('SYNC_CONSENT_REQUIRED');
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
  return Number.isFinite(seconds) ? Math.max(3000, Math.min(seconds, 86400000)) : 60000;
}
async function request(account: QuantumAccount, path: string, init: RequestInit, timeout: number, cap?: number): Promise<Response> {
  let response: Response;
  try { account.assertActive(); response = await deadline(account.request(path, init, cap), timeout); account.assertActive(); }
  catch (error) { return accountFailure(error); }
  if (response.status === 200 || response.status === 201) return response;
  const failure = (message: string, details = {}) => Object.assign(new Error(message),
    response.headers.has('retry-after') ? { retryAfterMs: retryDelay(response.headers.get('retry-after')) } : {}, details);
  let value: unknown;
  try { value = JSON.parse((await deadline(capped(response, 65536, timeout), timeout)).toString('utf8')); }
  catch (error) { if (error instanceof Error && ['SYNC_LIMIT', 'SYNC_TIMEOUT'].includes(error.message)) throw failure(error.message); }
  const code = accountRecord(value) && accountRecord(value.error) && typeof value.error.code === 'string' ? value.error.code : '';
  if (response.status === 429 || response.status === 503 && ['busy', 'standby_read_only'].includes(code)) {
    const retryAfterMs = retryDelay(response.headers.get('retry-after'));
    throw Object.assign(new Error('SYNC_RATE_LIMITED'), { retryAfterMs, retryAfter: retryAfterMs / 1000 });
  }
  if (response.status === 404) throw failure('SYNC_INVALID', { code: 'ENOENT' });
  if (response.status === 410 && code === 'cursor_expired') throw failure('SYNC_INVALID', { bootstrap: true });
  if (response.status === 401) throw failure('SYNC_NOT_ALLOWED');
  if (code === 'pool_exceeded' || code === 'quota_exceeded' || code === 'storage_full') throw failure('SYNC_FULL');
  if (response.status === 403 && code === 'sync_plan_required') throw failure('SYNC_PLAN_REQUIRED');
  if (response.status === 403 && code === 'acceptance_required') throw failure('SYNC_CONSENT_REQUIRED');
  if (response.status === 403) throw failure('SYNC_NOT_ALLOWED');
  if (response.status === 409 && code === 'object_conflict') throw failure('SYNC_CONFLICT');
  if (response.status === 413 || ['dataset_limit', 'object_limit', 'writer_limit_exceeded', 'object_too_large', 'size_limit'].includes(code)) throw failure('SYNC_LIMIT');
  if (response.status === 408 || response.status === 504) throw failure('SYNC_TIMEOUT');
  throw failure(response.status >= 500 ? 'SYNC_STORAGE' : 'SYNC_INVALID');
}
async function responseJson(response: Response, timeout: number, cap = 1024 * 1024): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse((await deadline(capped(response, cap, timeout), timeout)).toString('utf8')); } catch (error) { if (error instanceof Error && error.message.startsWith('SYNC_')) throw error; throw new Error('SYNC_INVALID'); }
  requireSync(accountRecord(value)); return value;
}
async function json(account: QuantumAccount, path: string, timeout: number): Promise<Record<string, unknown>> {
  return responseJson(await request(account, path, { method: 'GET' }, timeout), timeout);
}
export async function fetchQuantumChanges(account: QuantumAccount, after?: string, signal?: AbortSignal): Promise<QuantumChangePage> {
  requireSync(after === undefined || typeof after === 'string' && after.length > 0 && after.length <= 255);
  const query = new URLSearchParams({ limit: '1000' }); if (after !== undefined) query.set('after', after);
  const response = await request(account, `/v1/changes?${query}`, { method: 'GET', signal }, 35000);
  const value = await responseJson(response, 35000);
  requireSync(Array.isArray(value.changes) && value.changes.length <= 1000 && typeof value.cursor === 'string' && value.cursor.length > 0 && value.cursor.length <= 255);
  let previous = 0;
  const changes: QuantumChange[] = [];
  let skippedChanges = 0;
  const types = ['object_added', 'object_deleted', 'dataset_created', 'dataset_deleted', 'member_added', 'member_removed', 'key_generation_committed', 'relay_published', 'relay_delivered', 'relay_read', 'relay_expired'];
  for (const row of value.changes) {
    if (!(accountRecord(row) && integer(row.seq) && row.seq > previous && typeof row.type === 'string' && types.includes(row.type)
      && (row.ownerType === 'account' || row.ownerType === 'space') && accountId(row.ownerId)
      && (row.appId === null || accountId(row.appId)) && (row.datasetId === null || accountId(row.datasetId))
      && (row.path === null || typeof row.path === 'string' && validPath(row.path)) && (row.size === null || integer(row.size))
      && (row.sha256 === null || typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.sha256))
      && (row.memberId === null || accountId(row.memberId)) && (row.generation === null || integer(row.generation) && row.generation >= 1 && row.generation <= 2147483647)
      && integer(row.createdAt))) { skippedChanges++; continue; }
    previous = row.seq;
    if (row.ownerType === 'account' && (row.ownerId !== account.accountId || row.appId !== 'horizon')
      || row.appId !== null && row.appId !== 'horizon'
      || (row.type === 'object_added' || row.type === 'object_deleted') && (row.appId !== 'horizon' || row.datasetId === null || row.path === null)
      || row.type === 'object_added' && (row.size === null || row.sha256 === null)) { skippedChanges++; continue; }
    changes.push(row as unknown as QuantumChange);
  }
  requireSync(value.changes.length === 0 || value.cursor !== after);
  return { changes, cursor: value.cursor, skippedChanges, retryAfterMs: response.headers.has('retry-after') ? retryDelay(response.headers.get('retry-after')) : 0 };
}
export class QuantumTransport implements SyncTransport {
  private objects: Set<string> | undefined;
  private descriptor: Buffer | undefined;
  constructor(readonly account: QuantumAccount, readonly datasetId: string, readonly timeout: number = SYNC_LIMITS.timeout) {
    requireSync(accountId(account.accountId) && uuid(account.computerId) && uuid(datasetId) && account.profileIds.length > 0
      && account.profileIds.every(uuid) && new Set(account.profileIds).size === account.profileIds.length);
  }
  describe() { return { kind: 'quantum' as const, label: 'Cosmic' }; }
  private route(path: string) { requireSync(validPath(path)); return `/v1/datasets/${this.datasetId}/objects/${path.split('/').map(encodeURIComponent).join('/')}`; }
  private assertActive() { try { this.account.assertActive(); } catch (error) { accountFailure(error); } }
  async readDescriptor() { this.assertActive(); return this.descriptor ??= await this.readObject('dataset.hzs', 4096); }
  async refreshObjects(force = false) {
    this.assertActive();
    if (this.objects && !force) return;
    const objects = new Set<string>();
    for await (const row of this.objectRows()) objects.add(row);
    this.objects = objects; if (force) this.descriptor = undefined;
  }
  applyChanges(changes: readonly { type: string; path: string | null }[]) {
    for (const change of changes) {
      if (change.type === 'dataset_deleted') { this.objects?.clear(); this.descriptor = undefined; }
      if (change.path === null) continue;
      if (change.type === 'object_added') this.objects?.add(change.path);
      if (change.type === 'object_deleted') { this.objects?.delete(change.path); if (change.path === 'dataset.hzs') this.descriptor = undefined; }
    }
    requireSync(!this.objects || this.objects.size <= SYNC_LIMITS.records, 'SYNC_LIMIT');
  }
  async *listObjects(prefix: string) {
    this.assertActive();
    requireSync(validPath(prefix)); const children = new Set<string>();
    const paths = this.objects ? [...this.objects].filter(path => path.startsWith(`${prefix}/`)).sort() : this.objectRows(`${prefix}/`);
    for await (const path of paths) {
      const child = `${prefix}/${path.slice(prefix.length + 1).split('/')[0]}`;
      if (!children.has(child)) { requireSync(children.size < SYNC_LIMITS.files, 'SYNC_LIMIT'); children.add(child); yield child; }
    }
  }
  private async *objectRows(prefix = '') {
    let after: string | null = null, scanned = 0;
    do {
      const query = new URLSearchParams({ limit: '100' }); if (prefix) query.set('prefix', prefix); if (after !== null) query.set('after', after);
      const value = await json(this.account, `/v1/datasets/${this.datasetId}/objects?${query}`, this.timeout);
      requireSync(Array.isArray(value.objects) && value.objects.length <= 100 && (value.after === null || typeof value.after === 'string'));
      let previous = after;
      for (const row of value.objects) {
        requireSync(accountRecord(row) && typeof row.path === 'string' && validPath(row.path) && row.path.startsWith(prefix)
          && (previous === null || row.path > previous) && integer(row.size) && typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.sha256)
          && integer(row.createdAt));
        previous = row.path; requireSync(++scanned <= SYNC_LIMITS.records, 'SYNC_LIMIT');
        yield row.path;
      }
      requireSync(value.after === null || value.objects.length > 0 && value.after === previous && value.after !== after);
      after = value.after as string | null;
    } while (after !== null);
  }
  async readObject(path: string, cap: number): Promise<Buffer> {
    requireSync(Number.isSafeInteger(cap) && cap >= 0 && cap <= SYNC_LIMITS.blob, 'SYNC_LIMIT');
    let response: Response;
    try { response = await request(this.account, this.route(path), { method: 'GET' }, this.timeout, cap); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') this.objects?.delete(path); throw error; }
    const bytes = await deadline(capped(response, cap, this.timeout), this.timeout);
    requireSync(response.headers.get('x-content-sha256') === hash(bytes));
    try { this.account.assertActive(); } catch (error) { accountFailure(error); } return bytes;
  }
  async writeObject(path: string, bytes: Buffer, cap: number): Promise<void> {
    requireSync(Buffer.isBuffer(bytes) && Number.isSafeInteger(cap) && cap >= 0 && cap <= SYNC_LIMITS.blob && bytes.length <= cap, 'SYNC_LIMIT');
    if (path !== 'dataset.hzs') requireSync(path.startsWith(`writers/${this.account.computerId}/`), 'SYNC_NOT_ALLOWED');
    const response = await request(this.account, this.route(path), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': hash(bytes) }, body: Uint8Array.from(bytes) }, this.timeout);
    const value = await responseJson(response, this.timeout, 65536); requireSync(value.success === true);
    this.objects?.add(path); if (path === 'dataset.hzs') this.descriptor = Buffer.from(bytes);
  }
  async deleteOwnObject(path: string, device: string): Promise<void> {
    requireSync(device === this.account.computerId && path.startsWith(`writers/${device}/`), 'SYNC_NOT_ALLOWED');
    const response = await request(this.account, this.route(path), { method: 'DELETE' }, this.timeout);
    const value = await responseJson(response, this.timeout, 65536); requireSync(value.success === true); this.objects?.delete(path);
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
        && (previous === null || row.id > previous) && integer(row.createdAt));
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
    const response = await request(account, `/v1/datasets/${datasetId}`, { method: 'PUT' }, SYNC_LIMITS.timeout);
    const value = await responseJson(response, SYNC_LIMITS.timeout, 65536); requireSync(value.id === datasetId && value.appId === 'horizon' && integer(value.createdAt));
    const descriptor: DatasetParameters = { magic: 'Horizon Sync', version: 1, datasetId, keyType: 'account',
      check: sealSync(key, checkIdentity(datasetId), { check: 'Horizon Sync' }).toString('base64') };
    await transport.writeObject('dataset.hzs', Buffer.from(canonical(descriptor)), 4096); return { datasetId, key, descriptor, transport };
  } catch (error) { key.fill(0); throw error; }
}
