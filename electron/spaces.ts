import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { GROUP_COLORS, PROFILE_COLORS } from '../src/shared/api';
import type { AccountSpace, AccountSharedDataset } from '../src/shared/api';
import type { StoreCipher } from './store';
import { readVaultFile, writeVaultFile } from './vault-storage';
import { deriveKey, openPublicKey, openSealed, unwrap } from './cosmic-crypto';
import type { AccountKeyPair, KeyEnvelope } from './cosmic-crypto';
import { openProjectManifest } from './space-sharing';

// Quantum sends a dataset's newest object time as Unix milliseconds; an ISO string is accepted too. Both become ISO.
export const datasetTime = (value: unknown): string | null => {
  const time = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
export const accountRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const accountId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const role = (value: unknown): value is 'owner' | 'member' => value === 'owner' || value === 'member';
const string = (value: unknown, maximum: number, minimum = 0): value is string => typeof value === 'string' && value.length >= minimum && value.length <= maximum && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const name = (value: unknown) => string(value, 80, 1) && value.trim() ? value : null;
export function keyEnvelope(value: unknown): KeyEnvelope {
  if (!accountRecord(value) || typeof value.algorithm !== 'string' || typeof value.wrapped !== 'string') throw new Error('ACCOUNT_INVALID_RESPONSE');
  return { algorithm: value.algorithm, wrapped: value.wrapped };
}
export interface AccountResponse { status: number; ok: boolean; value: unknown; retryAfter?: number }
export function accountSuccess(response: AccountResponse): unknown {
  if (!response.ok) throw new Error([400, 401, 403].includes(response.status) ? 'ACCOUNT_DENIED' : 'ACCOUNT_NETWORK');
  return response.value;
}
type Get = (route: string) => Promise<AccountResponse>;
async function pages(get: Get, route: string, field: string): Promise<unknown[]> {
  const result: unknown[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '200', ...(after === null ? {} : { after }) });
    const value = accountSuccess(await get(`${route}${route.includes('?') ? '&' : '?'}${query}`));
    if (!accountRecord(value) || !Array.isArray(value[field]) || value[field].length > 200 || !(value.after === null || accountId(value.after))) throw new Error('ACCOUNT_INVALID_RESPONSE');
    result.push(...value[field]);
    if (typeof value.after === 'string' && cursors.has(value.after)) throw new Error('ACCOUNT_INVALID_RESPONSE');
    after = value.after;
    if (after) cursors.add(after);
  } while (after !== null);
  return result;
}
interface Pins { version: 1; accounts: Record<string, Record<string, string>> }
function pinsFile(path: string, cipher: StoreCipher): Pins {
  try {
    try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const value = readVaultFile(path, cipher);
    if (value === undefined) return { version: 1, accounts: {} };
    if (!accountRecord(value) || value.version !== 1 || !accountRecord(value.accounts)) throw new Error();
    for (const [id, members] of Object.entries(value.accounts)) {
      if (!accountId(id) || !accountRecord(members)) throw new Error();
      for (const [member, key] of Object.entries(members)) if (!accountId(member) || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error();
    }
    return value as unknown as Pins;
  } catch { throw new Error('ACCOUNT_STORAGE'); }
}
function profile(value: unknown): Pick<AccountSpace, 'name' | 'code' | 'colour' | 'icon'> | undefined {
  if (!accountRecord(value) || !name(value.name) || !string(value.code, 80) || !string(value.colour, 64)
    || !(/^#[0-9a-f]{6}$/i.test(value.colour) || [...GROUP_COLORS, ...PROFILE_COLORS].includes(value.colour as typeof GROUP_COLORS[number]))
    || !string(value.icon, 64, 1) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value.icon)) return;
  return { name: value.name as string, code: value.code, colour: value.colour, icon: value.icon };
}
async function datasetTitle(options: { get: Get; check(): void; key(space: string, generation: number): Promise<{ key: Uint8Array }> }, space: string, dataset: string): Promise<string> {
  const route = `/v1/spaces/${encodeURIComponent(space)}/datasets/${encodeURIComponent(dataset)}/objects`;
  const manifests: { path: string; createdAt: number }[] = [], cursors = new Set<string>();
  let after: string | null = null, count = 0;
  do {
    const query = new URLSearchParams({ prefix: 'project/', limit: '1000', ...(after === null ? {} : { after }) });
    const value = accountSuccess(await options.get(`${route}?${query}`)); options.check();
    if (!accountRecord(value) || !Array.isArray(value.objects) || value.objects.length > 1000 || !(value.after === null || typeof value.after === 'string' && /^[A-Za-z0-9_./-]{1,255}$/.test(value.after))) throw new Error('ACCOUNT_INVALID_RESPONSE');
    count += value.objects.length;
    if (count > 10000) throw new Error('ACCOUNT_INVALID_RESPONSE');
    for (const object of value.objects) {
      if (!accountRecord(object) || typeof object.path !== 'string' || !/^[A-Za-z0-9_./-]{1,255}$/.test(object.path)) throw new Error('ACCOUNT_INVALID_RESPONSE');
      if (/^project\/[A-Za-z0-9._:-]{1,128}\/[0-9a-f-]{36}\/dataset\.hzs$/.test(object.path)) {
        const createdAt = typeof object.createdAt === 'number' ? object.createdAt : typeof object.createdAt === 'string' ? Date.parse(object.createdAt) : NaN;
        if (!Number.isFinite(createdAt)) throw new Error('ACCOUNT_INVALID_RESPONSE');
        manifests.push({ path: object.path, createdAt });
      }
    }
    after = value.after;
    if (after !== null) { if (cursors.has(after)) throw new Error('ACCOUNT_INVALID_RESPONSE'); cursors.add(after); }
  } while (after !== null);
  const newest = manifests.sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path))[0];
  if (!newest) throw new Error('ACCOUNT_INVALID_RESPONSE');
  const bytes = accountSuccess(await options.get(`${route}/${newest.path.split('/').map(encodeURIComponent).join('/')}`)); options.check();
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw new Error('ACCOUNT_INVALID_RESPONSE');
  const descriptor: unknown = JSON.parse(bytes.toString('utf8'));
  if (!accountRecord(descriptor) || !Number.isSafeInteger(descriptor.keyGeneration) || (descriptor.keyGeneration as number) < 1) throw new Error('ACCOUNT_INVALID_RESPONSE');
  const { key } = await options.key(space, descriptor.keyGeneration as number);
  try { const manifest = await openProjectManifest(key, space, dataset, bytes); options.check(); return manifest.title; }
  finally { key.fill(0); }
}
export async function readSpaces(options: { get: Get; account: string; pair: AccountKeyPair; directory: string; cipher: StoreCipher; check(): void; fallbackName: string;
  rememberGeneration(space: string, generation: number): void; key(space: string, generation: number): Promise<{ key: Uint8Array }>;
  titleCache: Map<string, { updatedAt: string; title: string | null }> }) {
  const spaces: AccountSpace[] = [], shared: AccountSharedDataset[] = [];
  const path = resolve(options.directory, 'spaces-pins.json'), pins = pinsFile(path, options.cipher);
  const accountPins = Object.hasOwn(pins.accounts, options.account) ? pins.accounts[options.account]! : {};
  let dirty = false, error: string | null = null;
  const publicKeys = new Map<string, boolean>(), ids = new Set<string>();
  for (const entry of await pages(options.get, '/v1/spaces', 'spaces')) {
    if (!accountRecord(entry) || !accountId(entry.id) || !role(entry.role) || !Array.isArray(entry.members) || entry.members.length > 10000 || ids.has(entry.id)
      || [entry.currentGeneration, entry.generation].some(value => value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1))) throw new Error('ACCOUNT_INVALID_RESPONSE');
    ids.add(entry.id);
    const space: AccountSpace = { id: entry.id, name: options.fallbackName, code: null, colour: null, icon: null, role: entry.role, pending: true, members: [] };
    const route = `/v1/spaces/${encodeURIComponent(entry.id)}`;
    // Quantum names the Space's key generation currentGeneration; records from before that change have none and are generation 1.
    const generation = typeof entry.currentGeneration === 'number' ? entry.currentGeneration : typeof entry.generation === 'number' ? entry.generation : 1;
    options.rememberGeneration(entry.id, generation);
    const memberIds = new Set<string>();
    for (const member of entry.members) {
      if (!accountRecord(member) || !accountId(member.accountId) || !role(member.role) || memberIds.has(member.accountId)) throw new Error('ACCOUNT_INVALID_RESPONSE');
      memberIds.add(member.accountId);
      if (!publicKeys.has(member.accountId)) {
        try {
          const response = await options.get(`${route}/members/${encodeURIComponent(member.accountId)}/public-key`);
          if (response.status === 404) publicKeys.set(member.accountId, false);
          else {
            const key = openPublicKey(keyEnvelope(accountSuccess(response)));
            const encoded = Buffer.from(key).toString('base64'); options.check();
            const pinned = Object.hasOwn(accountPins, member.accountId) ? accountPins[member.accountId] : undefined;
            publicKeys.set(member.accountId, pinned !== undefined && pinned !== encoded);
            if (pinned === undefined) { Object.defineProperty(accountPins, member.accountId, { value: encoded, enumerable: true, writable: true, configurable: true }); dirty = true; }
          }
        } catch { error = 'ACCOUNT_INVALID_RESPONSE'; }
      }
      space.members.push({ accountId: member.accountId, displayName: name(member.displayName), role: member.role, keyChanged: publicKeys.get(member.accountId) ?? false });
    }
    if (!entry.keyPending) {
      let key: Uint8Array<ArrayBuffer> | undefined;
      try {
        const envelope = keyEnvelope(accountSuccess(await options.get(`${route}/key${generation > 1 ? `?generation=${generation}` : ''}`)));
        key = await unwrap(options.pair, envelope, `space-key:${entry.id}:${generation}:member:${options.account}`);
        if (key.length !== 32) throw new Error();
        space.pending = false;
        try {
          const bytes = await openSealed(await deriveKey(key, 'cosmic/space/profile'), keyEnvelope({ algorithm: entry.algorithm, wrapped: entry.sealedProfile }), `space-profile:${entry.id}:${generation}`);
          try { Object.assign(space, profile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))); }
          finally { bytes.fill(0); }
        } catch { /* An invalid profile keeps the neutral Space name and colour. */ }
      } catch { /* Missing or unopened member envelopes remain pending. */ }
      finally { key?.fill(0); }
    }
    spaces.push(space);
    if (!space.pending) try {
      const datasets = new Set<string>();
      for (const dataset of await pages(options.get, `${route}/datasets?app=horizon`, 'datasets')) {
        if (!accountRecord(dataset) || !accountId(dataset.id) || datasets.has(dataset.id) || !accountRecord(dataset.sharedBy) || !accountId(dataset.sharedBy.accountId)
          || !datasetTime(dataset.updatedAt) || typeof dataset.size !== 'number' || !Number.isSafeInteger(dataset.size) || dataset.size < 0) throw new Error('ACCOUNT_INVALID_RESPONSE');
        datasets.add(dataset.id);
        if (dataset.sharedBy.accountId === options.account) continue;
        const cacheId = `${space.id}:${dataset.id}`, cached = options.titleCache.get(cacheId);
        const updatedAt = datasetTime(dataset.updatedAt)!;
        let title = cached?.updatedAt === updatedAt ? cached.title : null;
        if (cached?.updatedAt !== updatedAt) {
          try { title = await datasetTitle(options, space.id, dataset.id); } catch { options.check(); }
          options.titleCache.set(cacheId, { updatedAt, title });
        }
        shared.push({ spaceId: space.id, datasetId: dataset.id, sharedBy: { accountId: dataset.sharedBy.accountId, displayName: name(dataset.sharedBy.displayName) }, updatedAt, size: dataset.size, title });
      }
    } catch { error = 'ACCOUNT_NETWORK'; }
  }
  options.check();
  if (dirty) try {
    Object.defineProperty(pins.accounts, options.account, { value: accountPins, enumerable: true, writable: true, configurable: true });
    writeVaultFile(path, pins, options.cipher);
  } catch { error = 'ACCOUNT_STORAGE'; }
  return { spaces, shared, spacesError: error };
}
