import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AccountSpace, CaptureImage, DesktopItem, Project } from '../src/shared/api';
import type { StoreCipher } from './store';
import { deriveKey, openSealed, seal } from './cosmic-crypto';
import type { KeyEnvelope } from './cosmic-crypto';
import { validateDesktopStore } from './desktop';
import { accountId, accountRecord, keyEnvelope, spaceGeneration } from './spaces';
import { canonical, integer, openSync, requireSync, sealSync, shape, SYNC_LIMITS, uuid } from './sync-format';
import type { SyncIdentity } from './sync-format';
import { readVaultFile, writeVaultFile } from './vault-storage';

const magic = Buffer.from('HZSPACE\n');
const generation = (value: unknown): value is number => spaceGeneration(value);
const info = (space: string, keyGeneration: number, purpose: string) => `cosmic/space/${space}/${keyGeneration}/horizon/${purpose}`;
export interface SpaceIdentity extends SyncIdentity { spaceId: string; keyGeneration: number }
function identityValid(identity: SpaceIdentity) {
  requireSync(accountId(identity.spaceId) && uuid(identity.dataset) && uuid(identity.device) && uuid(identity.generation)
    && generation(identity.keyGeneration) && uuid(identity.id) && integer(identity.sequence) && ['checkpoint', 'blob'].includes(identity.kind));
}
export function sealSpacePackage(spaceKey: Uint8Array, identity: SpaceIdentity, value: unknown): Buffer {
  identityValid(identity); requireSync(spaceKey.length === 32);
  const key = Buffer.from(hkdfSync('sha256', spaceKey, Buffer.alloc(0), info(identity.spaceId, identity.keyGeneration, 'project'), 32));
  try {
    const header = Buffer.alloc(12); magic.copy(header); header.writeUInt32BE(identity.keyGeneration, 8);
    const bytes = Buffer.concat([header, sealSync(key, identity, value)]);
    requireSync(bytes.length <= (identity.kind === 'blob' ? SYNC_LIMITS.blob : SYNC_LIMITS.package), 'SYNC_LIMIT'); return bytes;
  } finally { key.fill(0); }
}
export function openSpacePackage(spaceKey: Uint8Array, identity: SpaceIdentity, bytes: Buffer): unknown {
  identityValid(identity); requireSync(spaceKey.length === 32 && bytes.length >= 12 && bytes.subarray(0, 8).equals(magic)
    && bytes.readUInt32BE(8) === identity.keyGeneration);
  requireSync(bytes.length <= (identity.kind === 'blob' ? SYNC_LIMITS.blob : SYNC_LIMITS.package), 'SYNC_LIMIT');
  const key = Buffer.from(hkdfSync('sha256', spaceKey, Buffer.alloc(0), info(identity.spaceId, identity.keyGeneration, 'project'), 32));
  try { return openSync(key, identity, bytes.subarray(12)); } finally { key.fill(0); }
}
export async function sealProjectManifest(spaceKey: Uint8Array, spaceId: string, datasetId: string, keyGeneration: number, title: string, sharedAt: string): Promise<Buffer> {
  requireSync(accountId(spaceId) && uuid(datasetId) && generation(keyGeneration) && validTitle(title) && validDate(sharedAt));
  const manifest = await seal(await deriveKey(spaceKey, info(spaceId, keyGeneration, 'manifest')), Buffer.from(JSON.stringify({ title, sharedAt })),
    `horizon-project-manifest:${spaceId}:${datasetId}:${keyGeneration}`);
  return Buffer.from(JSON.stringify({ magic: 'Horizon Space Project', version: 1, datasetId, keyGeneration, manifest }));
}
const validTitle = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
export async function openProjectManifest(spaceKey: Uint8Array, spaceId: string, datasetId: string, bytes: Buffer): Promise<{ title: string; sharedAt: string; keyGeneration: number }> {
  requireSync(accountId(spaceId) && uuid(datasetId) && bytes.length <= 16384);
  const descriptor: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  requireSync(shape(descriptor, ['magic', 'version', 'datasetId', 'keyGeneration', 'manifest']) && descriptor.magic === 'Horizon Space Project'
    && descriptor.version === 1 && descriptor.datasetId === datasetId && generation(descriptor.keyGeneration));
  const plain = await openSealed(await deriveKey(spaceKey, info(spaceId, descriptor.keyGeneration, 'manifest')), keyEnvelope(descriptor.manifest),
    `horizon-project-manifest:${spaceId}:${datasetId}:${descriptor.keyGeneration}`);
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    requireSync(shape(value, ['title', 'sharedAt']) && validTitle(value.title) && validDate(value.sharedAt));
    return { title: value.title, sharedAt: value.sharedAt, keyGeneration: descriptor.keyGeneration };
  } finally { plain.fill(0); }
}

interface ImageReference { id: string; keyGeneration: number }
type SharedItem = Omit<DesktopItem, 'image'> & { image: (Omit<CaptureImage, 'filename'> & { blob: ImageReference }) | null };
export interface SpaceCheckpoint { version: 1; kind: 'checkpoint'; sequence: number; createdAt: number; keyGeneration: number; project: Omit<Project, 'items'> & { items: SharedItem[] } }
export function validateSpaceCheckpoint(value: unknown, identity: SpaceIdentity): asserts value is SpaceCheckpoint {
  identityValid(identity);
  requireSync(shape(value, ['version', 'kind', 'sequence', 'createdAt', 'keyGeneration', 'project']) && value.version === 1 && value.kind === 'checkpoint'
    && identity.kind === 'checkpoint' && value.sequence === identity.sequence && value.keyGeneration === identity.keyGeneration && integer(value.createdAt));
  requireSync(accountRecord(value.project) && Array.isArray(value.project.items) && value.project.items.length <= 2000);
  const items = value.project.items.map((item: unknown) => {
    requireSync(accountRecord(item));
    if (item.image === null) return item;
    requireSync(shape(item.image, ['width', 'height', 'bytes', 'cut', 'blob']) && shape(item.image.blob, ['id', 'keyGeneration'])
      && uuid(item.image.blob.id) && item.image.blob.keyGeneration === identity.keyGeneration);
    const { blob, ...image } = item.image;
    return { ...item, image: { ...image, filename: `${blob.id}.bin` } };
  });
  requireSync(validateDesktopStore({ version: 2, key: Buffer.alloc(32).toString('base64'), inUse: null, projects: [{ ...value.project, items }], captures: [] }));
}

interface Share {
  spaceId: string; datasetId: string; writerGeneration: string; keyGeneration: number; sequence: number; sharedAt: string;
  writer: string; created: boolean; generations: number; title: string; manifest: KeyEnvelope | null; published: boolean;
  digest: string | null; blobs: Record<string, { id: string; bytes: number; updatedAt?: number; sha256?: string }>;
  retryAt: number; shareError: string | null;
}
interface AccountShares { projects: Record<string, Share>; puts: number[] }
interface Shares { version: 1; accounts: Record<string, AccountShares> }
interface Context { accountId: string; computerId: string; session?: number; capabilityRevision?: string; accessRevision?: number; accessRevisions?: Record<string, number>; spaces: AccountSpace[] }
interface Options {
  directory: string; cipher: StoreCipher; changed(): void; context(): Context | undefined;
  key(spaceId: string, generation?: number): Promise<{ generation: number; key: Uint8Array }>;
  request(route: string, method: 'GET' | 'PUT' | 'DELETE', body?: Buffer): Promise<{ status: number; ok: boolean; value: unknown; retryAfter?: number }>;
  project(id: string): Project; image(project: string, item: string): Buffer | null;
}
const hourlyPuts = new Map<string, number[]>();
const own = <T>(entries: Record<string, T>, id: string) => Object.hasOwn(entries, id) ? entries[id] : undefined;
function sharesFile(path: string, cipher: StoreCipher): Shares {
  try {
    try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const value = readVaultFile(path, cipher);
    if (value === undefined) return { version: 1, accounts: {} };
    if (!shape(value, ['version', 'accounts']) || value.version !== 1 || !accountRecord(value.accounts)) throw new Error();
    for (const [id, account] of Object.entries(value.accounts)) {
      if (!accountId(id) || !shape(account, ['projects', 'puts']) || !accountRecord(account.projects) || !Array.isArray(account.puts)
        || account.puts.length > 30 || !account.puts.every(integer)) throw new Error();
      for (const [project, share] of Object.entries(account.projects)) {
        if (!uuid(project) || !shape(share, ['spaceId', 'datasetId', 'writerGeneration', 'keyGeneration', 'sequence', 'sharedAt', 'writer', 'created', 'generations', 'title', 'manifest', 'published', 'digest', 'blobs', 'retryAt', 'shareError'])
          || !accountId(share.spaceId) || !uuid(share.datasetId) || !uuid(share.writerGeneration) || !uuid(share.writer) || !generation(share.keyGeneration)
          || !integer(share.sequence) || !validDate(share.sharedAt) || typeof share.created !== 'boolean' || !integer(share.generations) || share.generations < 1 || share.generations > SYNC_LIMITS.writers
          || !validTitle(share.title) || typeof share.published !== 'boolean' || !(share.digest === null || typeof share.digest === 'string' && /^[0-9a-f]{64}$/.test(share.digest))
          || !accountRecord(share.blobs) || !integer(share.retryAt) || ![null, 'SPACE_SHARE_FAILED', 'SPACE_RATE_LIMITED'].includes(share.shareError as string | null)) throw new Error();
        if (share.manifest !== null) keyEnvelope(share.manifest);
        for (const [filename, blob] of Object.entries(share.blobs)) if (!/^[0-9a-f-]{36}\.bin$/.test(filename) || !accountRecord(blob)
          || Object.keys(blob).some(key => !['id', 'bytes', 'updatedAt', 'sha256'].includes(key)) || !uuid(blob.id) || !integer(blob.bytes) || blob.bytes < 1 || blob.bytes > SYNC_LIMITS.blob
          || !(blob.updatedAt === undefined || integer(blob.updatedAt)) || !(blob.sha256 === undefined || typeof blob.sha256 === 'string' && /^[a-f0-9]{64}$/.test(blob.sha256))) throw new Error();
      }
    }
    return value as unknown as Shares;
  } catch { throw new Error('SPACE_SHARE_FAILED'); }
}
function checkedProject(project: Project): Project {
  requireSync(validateDesktopStore({ version: 2, key: Buffer.alloc(32).toString('base64'), inUse: null, projects: [project], captures: [] }));
  return structuredClone(project);
}
const digest = (project: Project) => createHash('sha256').update(canonical({ ...project, usedAt: 0 })).digest('hex');

export function createSpaceSharing(options: Options) {
  const path = resolve(options.directory, 'spaces-shares.json');
  let state: Shares = { version: 1, accounts: {} }, storageFailed = false;
  try { state = sharesFile(path, options.cipher); } catch { storageFailed = true; }
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const observed = new Map<string, string>();
  const blocked = new Map<string, string | undefined>(), retryDelays = new Map<string, number>();
  let closed = false, work = Promise.resolve();
  const save = () => { if (Buffer.byteLength(JSON.stringify(state)) > 1900000) throw new Error('SPACE_SHARE_FAILED'); writeVaultFile(path, state, options.cipher); };
  const context = () => { const value = options.context(); if (closed || storageFailed || !value || !accountId(value.accountId) || !uuid(value.computerId)) throw new Error('SPACE_SHARE_FAILED'); return value; };
  const accessRevision = (current: Context, space: string) => current.accessRevisions?.[space] ?? (current.accessRevisions ? 0 : current.accessRevision);
  const check = (current: Context, space?: string) => { const next = context(); if (next.accountId !== current.accountId || next.computerId !== current.computerId || next.session !== current.session
    || space !== undefined && accessRevision(next, space) !== accessRevision(current, space)) throw new Error('SPACE_SHARE_FAILED'); return next; };
  const account = (id: string): AccountShares => {
    let value = own(state.accounts, id);
    if (!value) { value = { projects: {}, puts: [] }; Object.defineProperty(state.accounts, id, { value, enumerable: true }); }
    return value;
  };
  const serial = <T>(task: () => Promise<T>): Promise<T> => { const next = work.then(task); work = next.then(() => undefined, () => undefined); return next; };
  const cancel = (id: string) => { clearTimeout(timers.get(id)); timers.delete(id); };
  const schedule = (owner: string, project: string, delay: number) => {
    if (closed) return;
    const id = `${owner}:${project}`; cancel(id);
    const timer = setTimeout(() => {
      timers.delete(id);
      const requested = options.context();
      if (requested?.accountId !== owner) { observed.delete(id); return; }
      void serial(() => { check(requested); return publish(project); }).catch(() => undefined);
    }, Math.min(2147483647, Math.max(1, delay)));
    timer.unref?.(); timers.set(id, timer);
  };
  const notify = () => options.changed();
  async function publish(projectId: string): Promise<void> {
    const current = context(), records = account(current.accountId), share = own(records.projects, projectId);
    if (!share) return;
    const id = `${current.accountId}:${projectId}`;
    cancel(id);
    if (blocked.has(id) && blocked.get(id) === current.capabilityRevision) return;
    if (share.retryAt > Date.now()) { schedule(current.accountId, projectId, share.retryAt - Date.now()); return; }
    let key: Uint8Array | undefined;
    try {
      const space = current.spaces.find(entry => entry.id === share.spaceId && !entry.pending);
      if (!space || space.rotationRequired) throw new Error('SPACE_SHARE_FAILED');
      const keyGeneration = space.currentGeneration;
      const project = checkedProject(options.project(projectId)), hash = digest(project);
      const material = await options.key(share.spaceId); key = material.key; check(current, share.spaceId);
      if (!generation(material.generation) || material.generation !== keyGeneration) throw new Error('SPACE_SHARE_FAILED');
      if (share.keyGeneration !== material.generation || share.writer !== current.computerId) {
        if (share.writer !== current.computerId && share.generations >= SYNC_LIMITS.writers) throw new Error('SPACE_SHARE_FAILED');
        // A key generation already isolates immutable paths, so the current writer can be reused at the writer cap.
        if (share.generations < SYNC_LIMITS.writers) { share.writerGeneration = randomUUID(); share.generations++; }
        share.writer = current.computerId; share.keyGeneration = material.generation; share.blobs = {}; share.manifest = null; share.published = false;
        save();
      }
      share.title = project.name;
      if (share.digest === hash && share.published) { share.shareError = null; share.retryAt = 0; retryDelays.delete(id); save(); notify(); return; }
      const route = `/v1/spaces/${encodeURIComponent(share.spaceId)}/datasets/${share.datasetId}`;
      const send = async (target: string, body?: Buffer) => {
        const latest = check(current, share.spaceId).spaces.find(entry => entry.id === share.spaceId && !entry.pending);
        if (!latest || latest.rotationRequired || latest.currentGeneration !== keyGeneration) throw new Error('SPACE_SHARE_FAILED');
        const response = await options.request(target, 'PUT', body); check(current, share.spaceId);
        if (response.status === 403 && accountRecord(response.value) && accountRecord(response.value.error)
          && ['sync_plan_required', 'acceptance_required'].includes(response.value.error.code as string)) throw new Error('SPACE_PUBLISH_BLOCKED');
        if (response.status === 429) {
          const seconds = typeof response.retryAfter === 'number' && Number.isFinite(response.retryAfter) ? Math.max(1, response.retryAfter) : 60;
          share.retryAt = Math.ceil(Math.min(8640000000000000, Date.now() + seconds * 1000)); throw new Error('SPACE_RATE_LIMITED');
        }
        if (!response.ok) throw new Error('SPACE_SHARE_FAILED');
        if (!accountRecord(response.value) || (body === undefined
          ? response.value.id !== share.datasetId || response.value.appId !== 'horizon' || !integer(response.value.createdAt)
          : response.value.success !== true)) throw new Error('SPACE_SHARE_FAILED');
      };
      if (!share.created) {
        const now = Date.now(), counts = (times: number[]) => {
          const result = new Map<number, number>();
          for (const time of times) if (time > now - 3600000) result.set(time, (result.get(time) ?? 0) + 1);
          return result;
        };
        const merged = counts(hourlyPuts.get(current.accountId) ?? []);
        for (const [time, count] of counts(records.puts)) merged.set(time, Math.max(count, merged.get(time) ?? 0));
        const recent = [...merged].flatMap(([time, count]) => Array<number>(count).fill(time)).sort((a, b) => a - b);
        if (recent.length >= 30) { share.retryAt = recent[0]! + 3600000; throw new Error('SPACE_RATE_LIMITED'); }
        recent.push(now); hourlyPuts.set(current.accountId, recent); records.puts = recent; save();
        await send(route); share.created = true; save();
      }
      if (!share.manifest) {
        const bytes = await sealProjectManifest(key, share.spaceId, share.datasetId, share.keyGeneration, share.title, share.sharedAt); check(current, share.spaceId);
        const descriptor = JSON.parse(bytes.toString('utf8')) as { manifest: KeyEnvelope }; share.manifest = descriptor.manifest; save();
      }
      share.sequence++; save();
      const base = `${route}/objects/kg${share.keyGeneration}/project/${share.writer}/${share.writerGeneration}`;
      const identity = (id: string, kind: 'blob' | 'checkpoint'): SpaceIdentity => ({ dataset: share.datasetId, spaceId: share.spaceId, device: share.writer,
        generation: share.writerGeneration, keyGeneration: share.keyGeneration, sequence: kind === 'blob' ? 0 : share.sequence, id, kind });
      let staged = 0;
      const items: SharedItem[] = [];
      for (const item of project.items) {
        if (!item.image) { items.push(item as SharedItem); continue; }
        let blob = own(share.blobs, item.image.filename);
        if (!blob || blob.bytes !== item.image.bytes || blob.updatedAt !== item.updatedAt) {
          const bytes = options.image(projectId, item.id);
          requireSync(bytes !== null && bytes.length === item.image.bytes, 'SYNC_BLOB_PENDING');
          staged += bytes.length; requireSync(staged <= 256 * 1024 * 1024, 'SYNC_LIMIT');
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          if (!blob || blob.sha256 !== sha256) {
            blob = { id: randomUUID(), bytes: bytes.length, updatedAt: item.updatedAt, sha256 };
            const sealed = sealSpacePackage(key, identity(blob.id, 'blob'), bytes);
            await send(`${base}/blobs/${blob.id}.hzs`, sealed);
          } else blob.updatedAt = item.updatedAt;
          share.blobs[item.image.filename] = blob; save();
        }
        const image = { width: item.image.width, height: item.image.height, bytes: item.image.bytes, cut: item.image.cut };
        items.push({ ...item, image: { ...image, blob: { id: blob.id, keyGeneration: share.keyGeneration } } });
      }
      const checkpointId = randomUUID(), checkpoint: SpaceCheckpoint = { version: 1, kind: 'checkpoint', sequence: share.sequence, createdAt: Date.now(), keyGeneration: share.keyGeneration, project: { ...project, items } };
      validateSpaceCheckpoint(checkpoint, identity(checkpointId, 'checkpoint'));
      await send(`${base}/checkpoints/${share.sequence}-${checkpointId}.hzs`, sealSpacePackage(key, identity(checkpointId, 'checkpoint'), checkpoint));
      if (!share.published) {
        const descriptor = { magic: 'Horizon Space Project', version: 1, datasetId: share.datasetId, keyGeneration: share.keyGeneration, manifest: share.manifest };
        await send(`${base}/dataset.hzs`, Buffer.from(JSON.stringify(descriptor))); share.published = true;
      }
      share.digest = hash; share.retryAt = 0; share.shareError = null; retryDelays.delete(id);
      const filenames = new Set(project.items.flatMap(item => item.image ? [item.image.filename] : []));
      for (const filename of Object.keys(share.blobs)) if (!filenames.has(filename)) delete share.blobs[filename];
      save(); notify();
      if (digest(checkedProject(options.project(projectId))) !== hash) schedule(current.accountId, projectId, 30000);
    } catch (error) {
      if (closed || options.context()?.accountId !== current.accountId) { observed.delete(`${current.accountId}:${projectId}`); return; }
      share.shareError = error instanceof Error && error.message === 'SPACE_RATE_LIMITED' ? 'SPACE_RATE_LIMITED' : 'SPACE_SHARE_FAILED';
      const refused = error instanceof Error && ['SPACE_PUBLISH_BLOCKED', 'ACCOUNT_CONSENT'].includes(error.message);
      if (refused) { blocked.set(id, options.context()?.capabilityRevision); share.retryAt = 0; retryDelays.delete(id); }
      else {
        const delay = Math.min(60000, (retryDelays.get(id) ?? 2500) * 2); retryDelays.set(id, delay);
        share.retryAt = Math.max(share.retryAt, Date.now() + delay);
      }
      try { save(); } finally { notify(); if (!refused) schedule(current.accountId, projectId, share.retryAt - Date.now()); }
      throw new Error(share.shareError);
    } finally { key?.fill(0); }
  }
  const changed = () => {
    if (closed || storageFailed) return;
    const current = options.context(); if (!current) { observed.clear(); return; }
    const records = own(state.accounts, current.accountId); if (!records) return;
    for (const [id, share] of Object.entries(records.projects)) {
      try {
        const hash = digest(checkedProject(options.project(id))), key = `${current.accountId}:${id}`;
        if (blocked.has(key)) {
          if (blocked.get(key) === current.capabilityRevision) { cancel(key); continue; }
          blocked.delete(key); retryDelays.delete(key); share.retryAt = 0; observed.delete(key);
        }
        const space = current.spaces.find(entry => entry.id === share.spaceId && !entry.pending);
        if (!space || space.rotationRequired) { cancel(key); observed.delete(key); continue; }
        const signature = `${space.currentGeneration}:${accessRevision(current, share.spaceId) ?? 0}:${hash}`;
        if (observed.get(key) === signature) continue;
        observed.set(key, signature);
        if (hash !== share.digest || space.currentGeneration !== share.keyGeneration || share.shareError || !share.published) schedule(current.accountId, id, Math.max(30000, share.retryAt - Date.now()));
      } catch { /* A removed project retains its sharing record until Stop sharing. */ }
    }
  };
  queueMicrotask(changed);
  return {
    shareProject(projectId: string, spaceId: string) {
      const requested = options.context();
      return serial(async () => {
        if (!requested) throw new Error('SPACE_SHARE_FAILED');
        check(requested, spaceId);
        const current = context(), records = account(current.accountId);
        if (!uuid(projectId) || !current.spaces.some(space => space.id === spaceId && !space.pending)
          || Object.values(state.accounts).some(account => own(account.projects, projectId))) throw new Error('SPACE_SHARE_FAILED');
        const project = checkedProject(options.project(projectId));
        const material = await options.key(spaceId);
        try {
          check(current, spaceId);
          if (!generation(material.generation) || material.generation !== current.spaces.find(space => space.id === spaceId)!.currentGeneration || material.key.length !== 32) throw new Error('SPACE_SHARE_FAILED');
          records.projects[projectId] = { spaceId, datasetId: randomUUID(), writerGeneration: randomUUID(), keyGeneration: material.generation, sequence: 0,
            sharedAt: new Date().toISOString(), writer: current.computerId, created: false, generations: 1, title: project.name, manifest: null, published: false,
            digest: null, blobs: {}, retryAt: 0, shareError: null };
          try { save(); }
          catch {
            records.projects[projectId]!.shareError = 'SPACE_SHARE_FAILED'; records.projects[projectId]!.retryAt = Date.now() + 60000;
            notify(); schedule(current.accountId, projectId, 60000); throw new Error('SPACE_SHARE_FAILED');
          }
          notify();
          const space = current.spaces.find(entry => entry.id === spaceId)!;
          observed.set(`${current.accountId}:${projectId}`, `${space.currentGeneration}:${accessRevision(current, spaceId) ?? 0}:${digest(project)}`);
        } finally { material.key.fill(0); }
        await publish(projectId);
      });
    },
    stopSharing(projectId: string) {
      const requested = options.context();
      return serial(async () => {
        if (!requested) throw new Error('SPACE_SHARE_FAILED');
        check(requested);
        const current = context(), records = account(current.accountId), share = own(records.projects, projectId);
        if (!uuid(projectId) || !share || !current.spaces.some(space => space.id === share.spaceId)) throw new Error('SPACE_SHARE_FAILED');
        checkedProject(options.project(projectId));
        cancel(`${current.accountId}:${projectId}`);
        try {
          const response = await options.request(`/v1/spaces/${encodeURIComponent(share.spaceId)}/datasets/${share.datasetId}`, 'DELETE'); check(current, share.spaceId);
          const missing = response.status === 404 && accountRecord(response.value) && accountRecord(response.value.error) && response.value.error.code === 'not_found';
          if (!missing && (!response.ok || !accountRecord(response.value) || response.value.success !== true)) throw new Error(response.status === 429 ? 'SPACE_RATE_LIMITED' : 'SPACE_SHARE_FAILED');
          delete records.projects[projectId];
          try { save(); } catch (error) { records.projects[projectId] = share; throw error; }
          blocked.delete(`${current.accountId}:${projectId}`); retryDelays.delete(`${current.accountId}:${projectId}`); notify();
        } catch (error) {
          share.shareError = error instanceof Error && error.message === 'SPACE_RATE_LIMITED' ? 'SPACE_RATE_LIMITED' : 'SPACE_SHARE_FAILED'; save(); notify(); throw new Error(share.shareError);
        }
      });
    },
    projectState(projectId: string): { sharedTo: { spaceId: string; spaceName: string } | null; shareError: string | null } {
      if (storageFailed) return { sharedTo: null, shareError: 'SPACE_SHARE_FAILED' };
      const current = options.context(), records = current ? own(state.accounts, current.accountId) : undefined, share = records ? own(records.projects, projectId) : undefined;
      if (!share) return { sharedTo: null, shareError: null };
      const space = current?.spaces.find(entry => entry.id === share.spaceId);
      return { sharedTo: { spaceId: share.spaceId, spaceName: space?.name ?? 'Space' }, shareError: share.shareError };
    },
    changed,
    close() { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); blocked.clear(); retryDelays.clear(); return work; },
  };
}
