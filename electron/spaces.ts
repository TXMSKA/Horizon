import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { GROUP_COLORS, PROFILE_COLORS } from '../src/shared/api';
import type { AccountSpace, AccountSharedDataset } from '../src/shared/api';
import type { StoreCipher } from './store';
import { readVaultFile, writeVaultFile } from './vault-storage';
import { deriveKey, openPublicKey, openSealed, unwrap } from './cosmic-crypto';
import type { AccountKeyPair, KeyEnvelope } from './cosmic-crypto';
import { openProjectManifest, openSpacePackage, validateSpaceCheckpoint } from './space-sharing';
import type { SpaceIdentity } from './space-sharing';

// Quantum sends a dataset's newest object time as Unix milliseconds; an ISO string is accepted too. Both become ISO.
export const datasetTime = (value: unknown): string | null => {
  const time = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
export const accountRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const accountId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
export const spaceGeneration = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
export const spaceObject = (value: unknown): value is { path: string; size: number; sha256: string; createdAt: number } => accountRecord(value)
  && typeof value.path === 'string' && /^[A-Za-z0-9_./-]{1,255}$/.test(value.path) && timestamp(value.size)
  && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) && timestamp(value.createdAt);
const role = (value: unknown): value is 'owner' | 'member' => value === 'owner' || value === 'member';
const string = (value: unknown, maximum: number, minimum = 0): value is string => typeof value === 'string' && value.length >= minimum && value.length <= maximum && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const name = (value: unknown) => string(value, 80, 1) && value.trim() ? value : null;
export function keyEnvelope(value: unknown): KeyEnvelope {
  if (!accountRecord(value) || typeof value.algorithm !== 'string' || typeof value.wrapped !== 'string') throw new Error('ACCOUNT_INVALID_RESPONSE');
  return { algorithm: value.algorithm, wrapped: value.wrapped };
}
export interface AccountResponse { status: number; ok: boolean; value: unknown; retryAfter?: number }
export function accountSuccess(response: AccountResponse): unknown {
  if (!response.ok) throw Object.assign(new Error([400, 401, 403].includes(response.status) ? 'ACCOUNT_DENIED' : 'ACCOUNT_NETWORK'),
    response.retryAfter === undefined ? {} : { retryAfterMs: response.retryAfter * 1000 });
  return response.value;
}
type Get = (route: string) => Promise<AccountResponse>;
async function pages(get: Get, route: string, field: string): Promise<unknown[]> {
  const result: unknown[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '200', ...(after === null ? {} : { after }) });
    const value = accountSuccess(await get(`${route}${route.includes('?') ? '&' : '?'}${query}`));
    if (!accountRecord(value) || !Array.isArray(value[field]) || value[field].length > 200 || !(value.after === null || typeof value.after === 'string' && /^[A-Za-z0-9_./-]{1,255}$/.test(value.after))) throw new Error('ACCOUNT_INVALID_RESPONSE');
    let previous: string | null = after;
    for (const entry of value[field]) {
      if (!accountRecord(entry) || !accountId(entry.id) || previous !== null && entry.id <= previous) throw new Error('ACCOUNT_INVALID_RESPONSE');
      previous = entry.id;
    }
    if (value.after !== null && (value[field].length === 0 || value.after !== previous)) throw new Error('ACCOUNT_INVALID_RESPONSE');
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
async function datasetTitle(options: DatasetOptions, space: string, dataset: string): Promise<{ title: string; objectHash: string }> {
  const route = `/v1/spaces/${encodeURIComponent(space)}/datasets/${encodeURIComponent(dataset)}/objects`;
  const manifests: { path: string; createdAt: number; sha256: string }[] = [], sequences = new Map<string, number>(), cursors = new Set<string>();
  const checkpoints = new Map<string, { path: string; sequence: number; size: number; sha256: string }>();
  let after: string | null = null, count = 0;
  do {
    const query = new URLSearchParams({ prefix: 'kg', limit: '1000', ...(after === null ? {} : { after }) });
    const value = accountSuccess(await options.get(`${route}?${query}`)); options.check();
    if (!accountRecord(value) || !Array.isArray(value.objects) || value.objects.length > 1000 || !(value.after === null || typeof value.after === 'string' && /^[A-Za-z0-9_./-]{1,255}$/.test(value.after))) throw new Error('ACCOUNT_INVALID_RESPONSE');
    count += value.objects.length;
    if (count > 10000) throw new Error('ACCOUNT_INVALID_RESPONSE');
    let previous: string | null = after;
    for (const object of value.objects) {
      if (!spaceObject(object) || !object.path.startsWith('kg') || previous !== null && object.path <= previous) throw new Error('ACCOUNT_INVALID_RESPONSE');
      previous = object.path;
      const checkpoint = /^(kg[1-9][0-9]{0,9}\/project\/[^/]+\/[^/]+\/)checkpoints\/([1-9][0-9]*)-[0-9a-f-]{36}\.hzs$/.exec(object.path);
      if (checkpoint && timestamp(Number(checkpoint[2]))) {
        const base = checkpoint[1]!, sequence = Number(checkpoint[2]), previous = checkpoints.get(base);
        sequences.set(base, Math.max(sequences.get(base) ?? 0, sequence));
        if (!previous || sequence > previous.sequence || sequence === previous.sequence && object.path > previous.path) checkpoints.set(base, { ...object, sequence });
      }
      if (/^kg[1-9][0-9]{0,9}\/project\/[A-Za-z0-9._:-]{1,128}\/[0-9a-f-]{36}\/dataset\.hzs$/.test(object.path)) {
        if (!spaceGeneration(Number(object.path.split('/')[0]!.slice(2)))) throw new Error('ACCOUNT_INVALID_RESPONSE');
        manifests.push({ path: object.path, createdAt: object.createdAt, sha256: object.sha256 });
      }
    }
    if (value.after !== null && (value.objects.length === 0 || value.after !== previous)) throw new Error('ACCOUNT_INVALID_RESPONSE');
    after = value.after;
    if (after !== null) { if (cursors.has(after)) throw new Error('ACCOUNT_INVALID_RESPONSE'); cursors.add(after); }
  } while (after !== null);
  const newest = manifests.sort((a, b) => Number(b.path.split('/')[0]!.slice(2)) - Number(a.path.split('/')[0]!.slice(2)) || b.createdAt - a.createdAt
    || (sequences.get(b.path.slice(0, -'dataset.hzs'.length)) ?? 0) - (sequences.get(a.path.slice(0, -'dataset.hzs'.length)) ?? 0) || b.path.localeCompare(a.path))[0];
  if (!newest) throw new Error('ACCOUNT_INVALID_RESPONSE');
  const checkpoint = checkpoints.get(newest.path.slice(0, -'dataset.hzs'.length));
  // Renames live in checkpoints; unrelated blob activity must not download their bytes again.
  const objectHash = JSON.stringify([newest.path, newest.sha256, checkpoint?.path, checkpoint?.sha256]);
  const cached = options.titleCache.get(`${space}:${dataset}`);
  if (cached?.objectHash === objectHash && cached.title !== null) return { title: cached.title, objectHash };
  const bytes = accountSuccess(await options.get(`${route}/${newest.path.split('/').map(encodeURIComponent).join('/')}`)); options.check();
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw new Error('ACCOUNT_INVALID_RESPONSE');
  const descriptor: unknown = JSON.parse(bytes.toString('utf8'));
  if (!accountRecord(descriptor) || !spaceGeneration(descriptor.keyGeneration) || descriptor.keyGeneration !== Number(newest.path.split('/')[0]!.slice(2))) throw new Error('ACCOUNT_INVALID_RESPONSE');
  const { key } = await options.key(space, descriptor.keyGeneration as number);
  try {
    const manifest = await openProjectManifest(key, space, dataset, bytes); options.check();
    if (!checkpoint) return { title: manifest.title, objectHash };
    const checkpointBytes = accountSuccess(await options.get(`${route}/${checkpoint.path.split('/').map(encodeURIComponent).join('/')}`)); options.check();
    if (!Buffer.isBuffer(checkpointBytes) || checkpointBytes.length > 8 * 1024 * 1024 || checkpointBytes.length !== checkpoint.size
      || createHash('sha256').update(checkpointBytes).digest('hex') !== checkpoint.sha256) throw new Error('ACCOUNT_INVALID_RESPONSE');
    const parts = checkpoint.path.split('/'), filename = parts.at(-1)!;
    const identity: SpaceIdentity = { spaceId: space, dataset, device: parts[2]!, generation: parts[3]!, keyGeneration: descriptor.keyGeneration,
      sequence: checkpoint.sequence, id: filename.slice(`${checkpoint.sequence}-`.length, -4), kind: 'checkpoint' };
    const snapshot = openSpacePackage(key, identity, checkpointBytes); validateSpaceCheckpoint(snapshot, identity); options.check();
    return { title: snapshot.project.name, objectHash };
  }
  finally { key.fill(0); }
}
interface DatasetOptions { get: Get; account: string; check(): void; key(space: string, generation: number): Promise<{ key: Uint8Array }>;
  titleCache: Map<string, { updatedAt: string; title: string | null; objectHash?: string }> }
export async function readSpaceDatasets(options: DatasetOptions, space: string, selected?: ReadonlySet<string>): Promise<AccountSharedDataset[]> {
  const shared: AccountSharedDataset[] = [], ids = new Set<string>();
  for (const dataset of await pages(options.get, `/v1/spaces/${encodeURIComponent(space)}/datasets?app=horizon`, 'datasets')) {
    if (!accountRecord(dataset) || !accountId(dataset.id) || ids.has(dataset.id) || dataset.appId !== 'horizon' || !accountRecord(dataset.sharedBy) || !accountId(dataset.sharedBy.accountId)
      || !(dataset.sharedBy.displayName === null || typeof dataset.sharedBy.displayName === 'string') || !timestamp(dataset.createdAt) || !timestamp(dataset.updatedAt)
      || typeof dataset.size !== 'number' || !Number.isSafeInteger(dataset.size) || dataset.size < 0) throw new Error('ACCOUNT_INVALID_RESPONSE');
    ids.add(dataset.id);
    if (dataset.sharedBy.accountId === options.account || selected && !selected.has(dataset.id)) continue;
    const cacheId = `${space}:${dataset.id}`, cached = options.titleCache.get(cacheId), updatedAt = datasetTime(dataset.updatedAt)!;
    let title = cached?.updatedAt === updatedAt ? cached.title : null;
    if (cached?.updatedAt !== updatedAt || selected?.has(dataset.id)) {
      let objectHash: string | undefined;
      try { ({ title, objectHash } = await datasetTitle(options, space, dataset.id)); } catch { options.check(); }
      options.titleCache.set(cacheId, { updatedAt, title, objectHash });
    }
    const objectHash = options.titleCache.get(cacheId)?.objectHash;
    shared.push({ spaceId: space, datasetId: dataset.id, sharedBy: { accountId: dataset.sharedBy.accountId, displayName: name(dataset.sharedBy.displayName) }, updatedAt, size: dataset.size, title,
      ...(objectHash === undefined ? {} : { contentRevision: createHash('sha256').update(objectHash).digest('hex') }) });
  }
  options.check(); return shared;
}
export async function readSpaces(options: { get: Get; account: string; pair: AccountKeyPair; directory: string; cipher: StoreCipher; check(): void; fallbackName: string; selected?: ReadonlySet<string>;
  rememberGeneration(space: string, generation: number): void; key(space: string, generation: number): Promise<{ key: Uint8Array }>;
  titleCache: Map<string, { updatedAt: string; title: string | null; objectHash?: string }> }) {
  const spaces: AccountSpace[] = [], shared: AccountSharedDataset[] = [], staleSpaces: string[] = [];
  const path = resolve(options.directory, 'spaces-pins.json'), pins = pinsFile(path, options.cipher);
  const accountPins = Object.hasOwn(pins.accounts, options.account) ? pins.accounts[options.account]! : {};
  let dirty = false, error: string | null = null;
  const publicKeys = new Map<string, boolean>(), ids = new Set<string>();
  for (const entry of await pages(options.get, '/v1/spaces', 'spaces')) {
    if (!accountRecord(entry) || !accountId(entry.id) || entry.kind !== 'shared' || !role(entry.role) || !Array.isArray(entry.members) || entry.members.length > 10000 || ids.has(entry.id)
      || !spaceGeneration(entry.currentGeneration) || typeof entry.rotationRequired !== 'boolean' || !timestamp(entry.createdAt)
      || !(entry.keyPending === undefined || entry.keyPending === true)
      || !((entry.algorithm === null && entry.sealedProfile === null) || typeof entry.algorithm === 'string' && typeof entry.sealedProfile === 'string')) throw new Error('ACCOUNT_INVALID_RESPONSE');
    ids.add(entry.id);
    // The contract exposes Space metadata through the list; deeper reads can stay scoped to affected Spaces.
    if (options.selected && !options.selected.has(entry.id)) continue;
    const space: AccountSpace = { id: entry.id, name: options.fallbackName, code: null, colour: null, icon: null, role: entry.role, pending: true,
      currentGeneration: entry.currentGeneration, rotationRequired: entry.rotationRequired, members: [] };
    const route = `/v1/spaces/${encodeURIComponent(entry.id)}`;
    const generation = entry.currentGeneration;
    options.rememberGeneration(entry.id, generation);
    const memberIds = new Set<string>();
    for (const member of entry.members) {
      if (!accountRecord(member) || !accountId(member.accountId) || !role(member.role) || !(member.displayName === null || typeof member.displayName === 'string') || memberIds.has(member.accountId)) throw new Error('ACCOUNT_INVALID_RESPONSE');
      memberIds.add(member.accountId);
      if (!publicKeys.has(member.accountId)) {
        try {
          const response = await options.get(`${route}/members/${encodeURIComponent(member.accountId)}/public-key`);
          if (response.status === 404) publicKeys.set(member.accountId, false);
          else {
            const envelope = keyEnvelope(accountSuccess(response));
            if (Buffer.from(envelope.wrapped, 'base64').length !== 33) throw new Error('ACCOUNT_INVALID_RESPONSE');
            const key = openPublicKey(envelope);
            const encoded = Buffer.from(key).toString('base64'); options.check();
            const pinned = Object.hasOwn(accountPins, member.accountId) ? accountPins[member.accountId] : undefined;
            publicKeys.set(member.accountId, pinned !== undefined && pinned !== encoded);
            if (pinned === undefined) { Object.defineProperty(accountPins, member.accountId, { value: encoded, enumerable: true, writable: true, configurable: true }); dirty = true; }
          }
        } catch { error = 'ACCOUNT_INVALID_RESPONSE'; }
      }
      space.members.push({ accountId: member.accountId, displayName: name(member.displayName), role: member.role, keyChanged: publicKeys.get(member.accountId) ?? false });
    }
    if (!memberIds.has(options.account)) throw new Error('ACCOUNT_INVALID_RESPONSE');
    if (!entry.keyPending) {
      let key: Uint8Array<ArrayBuffer> | undefined;
      try {
        const value = accountSuccess(await options.get(`${route}/key`));
        if (!accountRecord(value) || value.generation !== generation) throw new Error('ACCOUNT_INVALID_RESPONSE');
        const envelope = keyEnvelope(value);
        key = await unwrap(options.pair, envelope, `space-key:${entry.id}:${generation}:member:${options.account}`);
        if (key.length !== 32) throw new Error();
        space.pending = false;
        try {
          const bytes = await openSealed(await deriveKey(key, 'cosmic/space/profile'), keyEnvelope({ algorithm: entry.algorithm, wrapped: entry.sealedProfile }), `space-profile:${entry.id}:${generation}`);
          try { Object.assign(space, profile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))); }
          finally { bytes.fill(0); }
        } catch { /* An invalid profile keeps the neutral Space name and colour. */ }
      } catch (failure) {
        space.stale = true; staleSpaces.push(space.id);
        if (failure instanceof Error && ['ACCOUNT_NETWORK', 'ACCOUNT_TIMEOUT'].includes(failure.message)) error ??= failure.message;
      }
      finally { key?.fill(0); }
    }
    spaces.push(space);
    if (!space.pending) try {
      shared.push(...await readSpaceDatasets(options, space.id));
    } catch (failure) {
      space.stale = true; staleSpaces.push(space.id);
      if (failure instanceof Error && failure.message === 'ACCOUNT_INVALID_RESPONSE') error = failure.message;
      else error ??= failure instanceof Error && failure.message === 'ACCOUNT_TIMEOUT' ? failure.message : 'ACCOUNT_NETWORK';
    }
  }
  options.check();
  if (dirty) try {
    Object.defineProperty(pins.accounts, options.account, { value: accountPins, enumerable: true, writable: true, configurable: true });
    writeVaultFile(path, pins, options.cipher);
  } catch { error = 'ACCOUNT_STORAGE'; }
  return { spaces, shared, spacesError: error, staleSpaces };
}
