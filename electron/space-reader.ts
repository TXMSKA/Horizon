import { createHash } from 'node:crypto';
import type { AccountSharedDataset, AccountSpace, DesktopItem, SharedProjectContent } from '../src/shared/api';
import { accountId, accountRecord, accountSuccess, spaceGeneration, spaceObject } from './spaces';
import type { AccountResponse } from './spaces';
import { openProjectManifest, openSpacePackage, validateSpaceCheckpoint } from './space-sharing';
import type { SpaceCheckpoint, SpaceIdentity } from './space-sharing';
import { integer, SYNC_LIMITS, uuid } from './sync-format';

interface Context { accountId: string; session: number; accessRevision?: number; accessRevisions?: Record<string, number>; spaces: AccountSpace[]; shared: AccountSharedDataset[] }
interface Options {
  context(): Context | undefined;
  key(space: string, generation: number): Promise<{ key: Uint8Array }>;
  request(route: string): Promise<AccountResponse>;
}
interface Cached {
  context: Context; dataset: AccountSharedDataset; content: SharedProjectContent; identity: SpaceIdentity;
  items: Map<string, SpaceCheckpoint['project']['items'][number]>;
}
const unavailable = () => new Error('SPACE_SHARED_UNAVAILABLE');
const invalid = () => new Error('ACCOUNT_INVALID_RESPONSE');
const cacheId = (space: string, dataset: string) => `${space}:${dataset}`;
export const sharedItemId = (value: unknown): value is string => typeof value === 'string' && /^shared:[0-9a-f]{64}$/.test(value);

export function createSharedProjects(options: Options) {
  const projects = new Map<string, Cached>(), images = new Map<string, Buffer>(), pending = new Map<string, Promise<Buffer | null>>();
  const openings = new Map<string, object>();
  let revision = 0, imageBytes = 0;
  const removeImage = (id: string) => { const bytes = images.get(id); if (bytes) { imageBytes -= bytes.length; images.delete(id); } };
  const remove = (id: string) => {
    const cached = projects.get(id);
    if (cached) for (const item of cached.items.keys()) { removeImage(item); pending.delete(item); }
    projects.delete(id);
  };
  const access = (context: Context, dataset: AccountSharedDataset) => {
    const current = options.context();
    if (!current || current.accountId !== context.accountId || current.session !== context.session
      || (current.accessRevisions?.[dataset.spaceId] ?? (current.accessRevisions ? 0 : current.accessRevision)) !== (context.accessRevisions?.[dataset.spaceId] ?? (context.accessRevisions ? 0 : context.accessRevision))
      || !current.spaces.some(space => space.id === dataset.spaceId && (!space.pending || space.stale) && space.members.some(member => member.accountId === current.accountId))
      || !current.shared.some(entry => entry.spaceId === dataset.spaceId && entry.datasetId === dataset.datasetId
        && entry.sharedBy.accountId === dataset.sharedBy.accountId && entry.sharedBy.accountId !== current.accountId)) throw unavailable();
  };
  const lookup = (project: string | null, id: string) => {
    if (project !== null || !sharedItemId(id)) throw unavailable();
    for (const cached of projects.values()) if (cached.items.has(id)) { access(cached.context, cached.dataset); return cached; }
    throw unavailable();
  };
  const read = async (route: string, check: () => void): Promise<Buffer> => {
    const bytes = accountSuccess(await options.request(route)); check();
    if (!Buffer.isBuffer(bytes)) throw invalid();
    return bytes;
  };
  return {
    async openSharedProject(spaceId: string, datasetId: string): Promise<SharedProjectContent> {
      const id = cacheId(spaceId, datasetId), ticket = {}, version = revision;
      openings.set(id, ticket);
      const current = options.context(), dataset = current?.shared.find(entry => entry.spaceId === spaceId && entry.datasetId === datasetId);
      const check = () => {
        if (!current || !dataset || version !== revision || openings.get(id) !== ticket) throw unavailable();
        access(current, dataset);
      };
      try {
        if (!current || !accountId(spaceId) || !uuid(datasetId) || !dataset) throw unavailable();
        check();
        const route = `/v1/spaces/${encodeURIComponent(spaceId)}/datasets/${datasetId}/objects`;
        const objects = new Map<string, { createdAt: number; size: number; sha256: string }>(), cursors = new Set<string>();
        let after: string | null = null, count = 0;
        do {
          const query = new URLSearchParams({ prefix: 'kg', limit: '1000', ...(after === null ? {} : { after }) });
          const response = await options.request(`${route}?${query}`); check();
          if (response.status === 404) throw unavailable();
          const value = accountSuccess(response);
          if (!accountRecord(value) || !Array.isArray(value.objects) || value.objects.length > 1000
            || !(value.after === null || typeof value.after === 'string' && /^[A-Za-z0-9_./-]{1,255}$/.test(value.after))) throw invalid();
          count += value.objects.length; if (count > SYNC_LIMITS.files) throw invalid();
          let previous: string | null = after;
          for (const object of value.objects) {
            if (!spaceObject(object) || !object.path.startsWith('kg') || objects.has(object.path) || previous !== null && object.path <= previous) throw invalid();
            previous = object.path;
            objects.set(object.path, object);
          }
          if (value.after !== null && (value.objects.length === 0 || value.after !== previous)) throw invalid();
          after = value.after;
          if (after !== null) { if (cursors.has(after)) throw invalid(); cursors.add(after); }
        } while (after !== null);
        const sequences = new Map<string, number>();
        for (const path of objects.keys()) {
          const checkpoint = /^(kg[1-9][0-9]{0,9}\/project\/[^/]+\/[^/]+\/)checkpoints\/([1-9][0-9]*)-[0-9a-f-]{36}\.hzs$/.exec(path);
          if (checkpoint && integer(Number(checkpoint[2]))) sequences.set(checkpoint[1]!, Math.max(sequences.get(checkpoint[1]!) ?? 0, Number(checkpoint[2])));
        }
        const manifests = [...objects].filter(([path]) => {
          const parts = path.split('/'); return parts.length === 5 && /^kg[1-9][0-9]{0,9}$/.test(parts[0]!) && spaceGeneration(Number(parts[0]!.slice(2)))
            && parts[1] === 'project' && uuid(parts[2]) && uuid(parts[3]) && parts[4] === 'dataset.hzs';
        }).sort((a, b) => Number(b[0].split('/')[0]!.slice(2)) - Number(a[0].split('/')[0]!.slice(2)) || b[1].createdAt - a[1].createdAt
          || (sequences.get(b[0].slice(0, -'dataset.hzs'.length)) ?? 0) - (sequences.get(a[0].slice(0, -'dataset.hzs'.length)) ?? 0) || b[0].localeCompare(a[0]));
        if (!manifests.length || new Set(manifests.map(([path]) => path.split('/').slice(2, 4).join('/'))).size > SYNC_LIMITS.writers) throw invalid();
        const manifestPath = manifests[0]![0], base = manifestPath.slice(0, -'dataset.hzs'.length);
        const checkpoints = [...objects.keys()].filter(path => path.startsWith(`${base}checkpoints/`)).map(path => {
          const match = /^(\d+)-([0-9a-f-]{36})\.hzs$/.exec(path.slice(`${base}checkpoints/`.length));
          if (!match || !integer(Number(match[1])) || !uuid(match[2])) throw invalid();
          return { path, sequence: Number(match[1]), id: match[2] };
        }).sort((a, b) => b.sequence - a.sequence || b.path.localeCompare(a.path));
        const latest = checkpoints[0]; if (!latest) throw invalid();
        const manifestBytes = await read(`${route}/${manifestPath}`, check);
        const verified = (path: string, bytes: Buffer) => {
          const metadata = objects.get(path);
          if (!metadata || bytes.length !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw invalid();
        };
        verified(manifestPath, manifestBytes);
        if (manifestBytes.length > 16384) throw invalid();
        const descriptor: unknown = JSON.parse(manifestBytes.toString('utf8'));
        if (!accountRecord(descriptor) || !spaceGeneration(descriptor.keyGeneration) || descriptor.keyGeneration !== Number(base.split('/')[0]!.slice(2))
          || descriptor.keyGeneration > current.spaces.find(space => space.id === spaceId)!.currentGeneration) throw invalid();
        const manifestKey = await options.key(spaceId, descriptor.keyGeneration);
        try { check(); await openProjectManifest(manifestKey.key, spaceId, datasetId, manifestBytes); check(); }
        finally { manifestKey.key.fill(0); }
        const bytes = await read(`${route}/${latest.path}`, check);
        verified(latest.path, bytes);
        if (bytes.length < 12 || bytes.length > SYNC_LIMITS.package) throw invalid();
        const keyGeneration = bytes.readUInt32BE(8);
        if (keyGeneration !== descriptor.keyGeneration) throw invalid();
        const material = await options.key(spaceId, keyGeneration);
        let snapshot: unknown;
        const identity: SpaceIdentity = { spaceId, dataset: datasetId, device: base.split('/')[2]!, generation: base.split('/')[3]!, keyGeneration,
          sequence: latest.sequence, id: latest.id, kind: 'checkpoint' };
        try { check(); snapshot = openSpacePackage(material.key, identity, bytes); }
        finally { material.key.fill(0); }
        check(); validateSpaceCheckpoint(snapshot, identity);
        const items = new Map<string, SpaceCheckpoint['project']['items'][number]>();
        const content: SharedProjectContent = { spaceId, datasetId, title: snapshot.project.name, sharedBy: { displayName: dataset.sharedBy.displayName },
          spaceName: current.spaces.find(space => space.id === spaceId)!.name, updatedAt: dataset.updatedAt, readOnly: true,
          folders: snapshot.project.folders, items: snapshot.project.items.map(({ image, ...item }) => {
            const itemId = `shared:${createHash('sha256').update(JSON.stringify([current.accountId, current.session, spaceId, datasetId, item.id])).digest('hex')}`;
            items.set(itemId, { ...item, image });
            return { ...item, id: itemId, image: image ? { width: image.width, height: image.height, bytes: image.bytes, cut: image.cut } : null };
          }) };
        remove(id);
        if (projects.size >= 16) remove(projects.keys().next().value!);
        projects.set(id, { context: current, dataset, content, identity, items });
        return structuredClone(content);
      } catch (error) {
        try { check(); } catch { error = unavailable(); }
        if (error instanceof Error && error.message === 'SPACE_SHARED_UNAVAILABLE') {
          if (openings.get(id) === ticket) remove(id);
          throw error;
        }
        if (error instanceof Error && ['ACCOUNT_NETWORK', 'ACCOUNT_TIMEOUT', 'ACCOUNT_DENIED', 'ACCOUNT_INVALID_RESPONSE'].includes(error.message)) {
          // Electron preserves only the error message across invoke, so carry bounded retry metadata with the code.
          if ('retryAfterMs' in error && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
            error.message += `; retryAfterMs=${Math.min(86400000, Math.ceil(error.retryAfterMs))}`;
          }
          throw error;
        }
        throw invalid();
      }
      finally { if (openings.get(id) === ticket) openings.delete(id); }
    },
    item(project: string | null, id: string): DesktopItem {
      const cached = lookup(project, id), item = cached.items.get(id)!;
      return structuredClone({ ...item, id, image: item.image ? { width: item.image.width, height: item.image.height, bytes: item.image.bytes, cut: item.image.cut,
        filename: `${item.image.blob.id}.bin` } : null });
    },
    image(project: string | null, id: string): Promise<Buffer | null> {
      try {
        const cached = lookup(project, id), image = cached.items.get(id)!.image;
        if (!image) return Promise.resolve(null);
        const hit = images.get(id); if (hit) { images.delete(id); images.set(id, hit); return Promise.resolve(Buffer.from(hit)); }
        const running = pending.get(id); if (running) return running.then(bytes => bytes && Buffer.from(bytes));
        const check = () => { access(cached.context, cached.dataset); if (projects.get(cacheId(cached.dataset.spaceId, cached.dataset.datasetId)) !== cached) throw unavailable(); };
        const task = (async () => {
          const identity: SpaceIdentity = { ...cached.identity, id: image.blob.id, keyGeneration: image.blob.keyGeneration, sequence: 0, kind: 'blob' };
          const route = `/v1/spaces/${encodeURIComponent(identity.spaceId)}/datasets/${identity.dataset}/objects/kg${identity.keyGeneration}/project/${identity.device}/${identity.generation}/blobs/${identity.id}.hzs`;
          const bytes = await read(route, check);
          if (bytes.length > SYNC_LIMITS.blob) throw unavailable();
          const material = await options.key(identity.spaceId, identity.keyGeneration);
          let plain: unknown;
          try { check(); plain = openSpacePackage(material.key, identity, bytes); } finally { material.key.fill(0); }
          check();
          if (!Buffer.isBuffer(plain) || plain.length > SYNC_LIMITS.blob || plain.length !== image.bytes
            || !plain.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw unavailable();
          while (imageBytes + plain.length > SYNC_LIMITS.blob) removeImage(images.keys().next().value!);
          images.set(id, plain); imageBytes += plain.length;
          return Buffer.from(plain);
        })().catch(() => { throw unavailable(); }).finally(() => { if (pending.get(id) === task) pending.delete(id); });
        pending.set(id, task); return task;
      } catch { return Promise.reject(unavailable()); }
    },
    clear(spaceId?: string) {
      if (spaceId !== undefined) {
        for (const [id, cached] of projects) if (cached.dataset.spaceId === spaceId) remove(id);
        for (const id of openings.keys()) if (id.slice(0, -37) === spaceId) openings.delete(id);
      } else { revision++; projects.clear(); images.clear(); pending.clear(); openings.clear(); imageBytes = 0; }
    },
  };
}
