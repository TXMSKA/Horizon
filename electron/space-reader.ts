import { createHash } from 'node:crypto';
import type { AccountSharedDataset, AccountSpace, DesktopItem, SharedProjectContent } from '../src/shared/api';
import { accountId, accountRecord, accountSuccess } from './spaces';
import type { AccountResponse } from './spaces';
import { openProjectManifest, openSpacePackage, validateSpaceCheckpoint } from './space-sharing';
import type { SpaceCheckpoint, SpaceIdentity } from './space-sharing';
import { integer, SYNC_LIMITS, uuid } from './sync-format';

interface Context { accountId: string; session: number; spaces: AccountSpace[]; shared: AccountSharedDataset[] }
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
      || !current.spaces.some(space => space.id === dataset.spaceId && !space.pending && space.members.some(member => member.accountId === dataset.sharedBy.accountId))
      || !current.shared.some(entry => entry.spaceId === dataset.spaceId && entry.datasetId === dataset.datasetId
        && entry.updatedAt === dataset.updatedAt && entry.sharedBy.accountId === dataset.sharedBy.accountId && entry.sharedBy.accountId !== current.accountId)) throw unavailable();
  };
  const lookup = (project: string | null, id: string) => {
    if (project !== null || !sharedItemId(id)) throw unavailable();
    for (const cached of projects.values()) if (cached.items.has(id)) { access(cached.context, cached.dataset); return cached; }
    throw unavailable();
  };
  const read = async (route: string, check: () => void): Promise<Buffer> => {
    const bytes = accountSuccess(await options.request(route)); check();
    if (!Buffer.isBuffer(bytes)) throw unavailable();
    return bytes;
  };
  return {
    async openSharedProject(spaceId: string, datasetId: string): Promise<SharedProjectContent> {
      const id = cacheId(spaceId, datasetId), ticket = {}, version = revision;
      openings.set(id, ticket);
      try {
        const current = options.context(), dataset = current?.shared.find(entry => entry.spaceId === spaceId && entry.datasetId === datasetId);
        if (!current || !accountId(spaceId) || !uuid(datasetId) || !dataset) throw unavailable();
        const check = () => { if (version !== revision || openings.get(id) !== ticket) throw unavailable(); access(current, dataset); };
        check();
        const route = `/v1/spaces/${encodeURIComponent(spaceId)}/datasets/${datasetId}/objects`;
        const objects = new Map<string, number>(), cursors = new Set<string>();
        let after: string | null = null, count = 0;
        do {
          const query = new URLSearchParams({ prefix: 'project/', limit: '1000', ...(after === null ? {} : { after }) });
          const value = accountSuccess(await options.request(`${route}?${query}`)); check();
          if (!accountRecord(value) || !Array.isArray(value.objects) || value.objects.length > 1000
            || !(value.after === null || typeof value.after === 'string' && /^[A-Za-z0-9_./-]{1,255}$/.test(value.after))) throw unavailable();
          count += value.objects.length; if (count > SYNC_LIMITS.files) throw unavailable();
          for (const object of value.objects) {
            if (!accountRecord(object) || typeof object.path !== 'string' || !/^[A-Za-z0-9_./-]{1,255}$/.test(object.path) || objects.has(object.path)) throw unavailable();
            const createdAt = typeof object.createdAt === 'number' ? object.createdAt : typeof object.createdAt === 'string' ? Date.parse(object.createdAt) : NaN;
            if (!integer(createdAt)) throw unavailable();
            objects.set(object.path, createdAt);
          }
          after = value.after;
          if (after !== null) { if (cursors.has(after)) throw unavailable(); cursors.add(after); }
        } while (after !== null);
        const manifests = [...objects].filter(([path]) => {
          const parts = path.split('/'); return parts.length === 4 && parts[0] === 'project' && uuid(parts[1]) && uuid(parts[2]) && parts[3] === 'dataset.hzs';
        }).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
        if (!manifests.length || manifests.length > SYNC_LIMITS.writers) throw unavailable();
        const manifestPath = manifests[0]![0], base = manifestPath.slice(0, -'dataset.hzs'.length);
        const checkpoints = [...objects.keys()].filter(path => path.startsWith(`${base}checkpoints/`)).map(path => {
          const match = /^(\d+)-([0-9a-f-]{36})\.hzs$/.exec(path.slice(`${base}checkpoints/`.length));
          if (!match || !integer(Number(match[1])) || !uuid(match[2])) throw unavailable();
          return { path, sequence: Number(match[1]), id: match[2] };
        }).sort((a, b) => b.sequence - a.sequence || b.path.localeCompare(a.path));
        const latest = checkpoints[0]; if (!latest) throw unavailable();
        const manifestBytes = await read(`${route}/${manifestPath}`, check);
        if (manifestBytes.length > 16384) throw unavailable();
        const descriptor: unknown = JSON.parse(manifestBytes.toString('utf8'));
        if (!accountRecord(descriptor) || !integer(descriptor.keyGeneration) || descriptor.keyGeneration < 1 || descriptor.keyGeneration > 0xffffffff) throw unavailable();
        const manifestKey = await options.key(spaceId, descriptor.keyGeneration);
        let title: string;
        try { check(); title = (await openProjectManifest(manifestKey.key, spaceId, datasetId, manifestBytes)).title; check(); }
        finally { manifestKey.key.fill(0); }
        const bytes = await read(`${route}/${latest.path}`, check);
        if (bytes.length < 12 || bytes.length > SYNC_LIMITS.package) throw unavailable();
        const keyGeneration = bytes.readUInt32BE(8), material = await options.key(spaceId, keyGeneration);
        let snapshot: unknown;
        const identity: SpaceIdentity = { spaceId, dataset: datasetId, device: base.split('/')[1]!, generation: base.split('/')[2]!, keyGeneration,
          sequence: latest.sequence, id: latest.id, kind: 'checkpoint' };
        try { check(); snapshot = openSpacePackage(material.key, identity, bytes); }
        finally { material.key.fill(0); }
        check(); validateSpaceCheckpoint(snapshot, identity);
        if (snapshot.project.name !== title) throw unavailable();
        const items = new Map<string, SpaceCheckpoint['project']['items'][number]>();
        const content: SharedProjectContent = { spaceId, datasetId, title, sharedBy: { displayName: dataset.sharedBy.displayName },
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
      } catch { if (openings.get(id) === ticket) remove(id); throw unavailable(); }
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
          const route = `/v1/spaces/${encodeURIComponent(identity.spaceId)}/datasets/${identity.dataset}/objects/project/${identity.device}/${identity.generation}/blobs/${identity.id}.hzs`;
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
    clear() { revision++; projects.clear(); images.clear(); pending.clear(); openings.clear(); imageBytes = 0; },
  };
}
