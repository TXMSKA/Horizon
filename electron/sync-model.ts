import { randomBytes, randomUUID } from 'node:crypto';
import type { BrowserStore, DesktopItem, FavoriteItem, FavoritesTree, ProfileColor, SyncItem, SyncRemoteWindow } from '../src/shared/api';
import { validateStore } from './store';
import { validateDesktopStore } from './desktop';
import type { DesktopStore } from './desktop';
import { isProfileColor, profileName } from './profiles';
import { isMarketplaceTheme, validateSettings } from './settings';
import type { Settings } from './settings';
import { integer, recordId, requireSync, shape, uuid } from './sync-format';
import type { SyncOperation, SyncRecord } from './sync-format';
import { isWebURL } from './browsing';

// Automatic update checks stay local: another computer must not re-enable network checks here through sync.
export const SYNC_SETTING_KEYS = ['theme', 'contrast', 'darkPages', 'darkStrength', 'darkTone', 'searchEngine', 'language', 'onStart', 'askWhereToSave', 'blockAds', 'blockThirdPartyCookies', 'quickAccess', 'showCapture', 'marketplace'] as const;
export type SyncSettings = Pick<Settings, typeof SYNC_SETTING_KEYS[number]>;
export interface SyncProfileSnapshot { id: string; name: string; color: ProfileColor; createdAt: number; store: BrowserStore; desktop: DesktopStore; windows: SyncRemoteWindow[] }
export interface SyncSnapshot { settings: SyncSettings; profiles: SyncProfileSnapshot[] }
export interface BlobReference { device: string; generation: string; id: string }
export const emptySyncStore = (): BrowserStore => ({ version: 5, history: [], favorites: { bar: [], other: [] }, downloads: [], siteSettings: { blocking: [], dark: [], permissions: [] }, clearHistoryOnClose: false, clearCacheOnClose: false });
export const emptySyncDesktop = (): DesktopStore => ({ version: 2, key: randomBytes(32).toString('base64'), inUse: null, projects: [], captures: [] });
const defaults = (): Settings => ({ version: 7, onboarded: false, downloadsFolder: null, theme: 'system', contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', onStart: 'restore', askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [], showCapture: true });
export function validateSyncSettings(settings: unknown): asserts settings is SyncSettings {
  requireSync(settings !== null && typeof settings === 'object' && !Array.isArray(settings));
  const keys = Object.keys(settings); requireSync(keys.every(key => SYNC_SETTING_KEYS.includes(key as typeof SYNC_SETTING_KEYS[number])) && SYNC_SETTING_KEYS.filter(key => key !== 'marketplace').every(key => keys.includes(key)));
  requireSync(validateSettings({ ...defaults(), ...settings }));
}
export function syncSettings(settings: Settings): SyncSettings {
  return Object.fromEntries(SYNC_SETTING_KEYS.filter(key => settings[key] !== undefined).map(key => [key, structuredClone(settings[key])])) as unknown as SyncSettings;
}
export const computerName = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64).trim();
export const syncEnabled = (switches: Record<SyncItem, boolean>, item: SyncRecord['item']) => item === 'computer' || switches[item];
export function recordTitle(record: SyncRecord): string {
  const value = record.value as { title?: unknown; name?: unknown; url?: unknown; host?: unknown; origin?: unknown; entry?: { title?: unknown; name?: unknown; url?: unknown } } | null;
  const title = [value?.entry?.title, value?.entry?.name, value?.title, value?.name, value?.entry?.url, value?.url, value?.host, value?.origin, record.key].find(value => typeof value === 'string' && value.trim());
  return (typeof title === 'string' ? title : record.item).replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 200) || record.item;
}
export function snapshotRecords(snapshot: SyncSnapshot, mapping: Record<string, string>, device: string, blob: (profile: string, item: DesktopItem) => BlobReference, name: string): SyncRecord[] {
  const result: SyncRecord[] = [], add = (item: SyncRecord['item'], profile: string | null, key: string, value: unknown) => result.push({ item, profile, key, value: structuredClone(value) });
  add('computer', null, device, { name });
  for (const key of SYNC_SETTING_KEYS) if (snapshot.settings[key] !== undefined) add('settings', null, key, snapshot.settings[key]);
  for (const local of snapshot.profiles) {
    const profile = mapping[local.id]; requireSync(uuid(profile));
    add('profiles', null, profile, { name: local.name, color: local.color, createdAt: local.createdAt });
    const walk = (items: FavoriteItem[], parent: string) => items.forEach((item, position) => {
      const entry = { ...item }; if (entry.kind === 'folder') { walk(entry.children, entry.id); delete (entry as Partial<typeof entry>).children; }
      add('favorites', profile, item.id, { parent, position, entry });
    });
    walk(local.store.favorites.bar, 'bar'); walk(local.store.favorites.other, 'other');
    for (const entry of local.store.history) add('history', profile, entry.url, entry);
    for (const list of ['blocking', 'dark', 'permissions'] as const) for (const entry of local.store.siteSettings[list]) add('siteSettings', profile, `${list}:${'host' in entry ? entry.host : entry.origin}`, entry);
    const translation = local.store.siteSettings.translation;
    if (translation) {
      for (const host of translation.never) add('siteSettings', profile, `never:${host}`, host);
      for (const choice of translation.always) add('siteSettings', profile, `always:${choice.language}`, choice);
    }
    for (const key of ['clearHistoryOnClose', 'clearCacheOnClose'] as const) add('siteSettings', profile, key, local.store[key]);
    add('tabs', profile, device, local.windows.filter(window => window.tabs.length > 0).map(window => ({ ...window, profile })));
    for (const project of local.desktop.projects) {
      const { folders, items, ...entry } = project; add('desktop', profile, project.id, { type: 'project', entry });
      for (const entry of folders) add('desktop', profile, entry.id, { type: 'folder', project: project.id, entry });
      for (const entry of items) addItem(entry, project.id);
    }
    for (const entry of local.desktop.captures) addItem(entry, null);
    function addItem(entry: DesktopItem, project: string | null) {
      const { image, ...fields } = entry;
      add('desktop', profile!, entry.id, { type: 'item', project, entry: { ...fields, image: image ? { width: image.width, height: image.height, bytes: image.bytes, cut: image.cut, blob: blob(local.id, entry) } : null } });
    }
  }
  requireSync(result.length <= 100000, 'SYNC_LIMIT'); return result;
}
export function blobReference(record: SyncRecord): BlobReference | null {
  if (record.item !== 'desktop' || record.value === null) return null;
  const value = record.value as { type?: unknown; entry?: { image?: { blob?: BlobReference } } }; return value.type === 'item' ? value.entry?.image?.blob ?? null : null;
}
export function validateRemoteWindows(value: unknown): asserts value is SyncRemoteWindow[] {
  requireSync(Array.isArray(value) && value.length <= 200);
  const ids = new Set<string>();
  for (const window of value) {
    requireSync(shape(window, ['profile', 'id', 'tabs', 'groups']) && uuid(window.profile) && typeof window.id === 'string' && window.id.length <= 128 && !ids.has(window.id) && Array.isArray(window.tabs) && window.tabs.length <= 200 && Array.isArray(window.groups) && window.groups.length <= 200); ids.add(window.id);
    const groups = new Set<string>();
    for (const group of window.groups) { requireSync(shape(group, ['id', 'title']) && uuid(group.id) && typeof group.title === 'string' && group.title.length <= 200 && !groups.has(group.id)); groups.add(group.id); }
    for (const tab of window.tabs) requireSync(shape(tab, ['title', 'url', 'group']) && typeof tab.title === 'string' && tab.title.length <= 4096 && isWebURL(tab.url) && (tab.group === null || groups.has(tab.group as string)));
  }
}
export function validateRecord(record: SyncRecord): void {
  const { item, key, value, profile } = record;
  requireSync(item === 'settings' || item === 'profiles' || item === 'computer' ? profile === null : uuid(profile));
  if (item === 'computer') { requireSync(uuid(key) && shape(value, ['name']) && typeof value.name === 'string' && value.name.length > 0 && computerName(value.name) === value.name); return; }
  if (item === 'settings') requireSync(SYNC_SETTING_KEYS.includes(key as typeof SYNC_SETTING_KEYS[number]));
  if (['profiles', 'favorites', 'desktop', 'tabs'].includes(item)) requireSync(uuid(key));
  if (item === 'history') requireSync(isWebURL(key));
  if (value === null) return;
  if (item === 'profiles') {
    requireSync(shape(value, ['name', 'color', 'createdAt']) && isProfileColor(value.color) && integer(value.createdAt)); requireSync(profileName(value.name) === value.name); return;
  }
  if (item === 'tabs') { validateRemoteWindows(value); requireSync(value.every(window => window.profile === profile)); return; }
  if (item === 'settings') {
    const fields = { ...defaults(), [key]: value };
    if (key === 'theme' && isMarketplaceTheme(value)) fields.marketplace = { installed: [value], builtIn: 'system', contrast: 'standard' };
    requireSync(validateSettings(fields)); return;
  }
  if (item === 'history') { requireSync(shape(value, ['url', 'title', 'lastVisit', 'visitCount']) && value.url === key && validateStore({ ...emptySyncStore(), history: [value] })); return; }
  if (item === 'favorites') {
    requireSync(shape(value, ['parent', 'position', 'entry']) && (value.parent === 'bar' || value.parent === 'other' || uuid(value.parent)) && integer(value.position) && value.position <= 100000);
    const entry = value.entry; requireSync(entry && typeof entry === 'object' && 'id' in entry && entry.id === key);
    requireSync('kind' in entry && (entry.kind === 'folder' ? shape(entry, ['kind', 'id', 'name', 'createdAt']) : shape(entry, ['kind', 'id', 'title', 'url', 'createdAt'])));
    const normalized = 'kind' in entry && entry.kind === 'folder' ? { ...entry, children: [] } : entry;
    requireSync(validateStore({ ...emptySyncStore(), favorites: { bar: [normalized], other: [] } })); return;
  }
  if (item === 'siteSettings') {
    const store = emptySyncStore();
    setSiteRecord(store, key, value); requireSync(validateStore(store)); return;
  }
  requireSync(shape(value, ['type', 'entry']) && value.type === 'project' || shape(value, ['type', 'project', 'entry']) && (value.type === 'folder' || value.type === 'item'));
  const v = value as { type: string; project?: string | null; entry: Record<string, unknown> };
  requireSync(v.entry !== null && typeof v.entry === 'object' && !Array.isArray(v.entry) && v.entry.id === key && (v.project === undefined || v.project === null || uuid(v.project)));
  const desktop = emptySyncDesktop(), project = { id: v.project ?? randomUUID(), name: 'Synthetic', createdAt: 0, updatedAt: 0, usedAt: 0, folders: [], items: [] };
  if (v.type === 'project') desktop.projects = [{ ...v.entry, folders: [], items: [] }] as unknown as DesktopStore['projects'];
  else if (v.type === 'folder') desktop.projects = [{ ...project, folders: [v.entry] }] as unknown as DesktopStore['projects'];
  else {
    const image = v.entry.image;
    if (image !== null) requireSync(shape(image, ['width', 'height', 'bytes', 'cut', 'blob']) && shape(image.blob, ['device', 'generation', 'id']) && Object.values(image.blob).every(uuid));
    const entry = localDesktopItem(v.entry);
    if (entry.folder) project.folders = [{ id: entry.folder, name: 'Synthetic folder', createdAt: 0 }] as never[];
    if (v.project === null) desktop.captures = [entry]; else desktop.projects = [{ ...project, items: [entry] }];
  }
  requireSync(validateDesktopStore(desktop));
}
function localDesktopItem(value: Record<string, unknown>): DesktopItem {
  const image = value.image as { blob: BlobReference; width: number; height: number; bytes: number; cut: boolean } | null;
  return { ...value, image: image ? { filename: `${image.blob.id}.bin`, width: image.width, height: image.height, bytes: image.bytes, cut: image.cut } : null } as unknown as DesktopItem;
}
function setSiteRecord(store: BrowserStore, key: string, value: unknown): void {
  if (key === 'clearHistoryOnClose' || key === 'clearCacheOnClose') { requireSync(typeof value === 'boolean'); store[key] = value; return; }
  const split = key.indexOf(':'), list = key.slice(0, split), name = key.slice(split + 1);
  if (list === 'blocking' || list === 'dark' || list === 'permissions') {
    requireSync(value !== null && typeof value === 'object' && (value as Record<string, unknown>)[list === 'permissions' ? 'origin' : 'host'] === name);
    (store.siteSettings[list] as unknown[]).push(value);
  } else {
    store.siteSettings.translation ??= { never: [], always: [] };
    if (list === 'never') { requireSync(value === name); store.siteSettings.translation.never.push(value as string); }
    else { requireSync(list === 'always' && value !== null && typeof value === 'object' && 'language' in value && value.language === name); store.siteSettings.translation.always.push(value as never); }
  }
}
export function projectSnapshot(current: SyncSnapshot, mapping: Record<string, string>, records: SyncOperation[], switches: Record<SyncItem, boolean>, filename?: (profile: string, item: DesktopItem, reference: BlobReference) => string): SyncSnapshot {
  const next = structuredClone(current), live = records.filter(record => record.value !== null && syncEnabled(switches, record.item));
  for (const record of records) validateRecord(record);
  if (switches.settings) {
    for (const record of records.filter(record => record.item === 'settings')) {
      if (record.value === null) { if (record.key === 'marketplace') delete next.settings.marketplace; }
      else (next.settings as unknown as Record<string, unknown>)[record.key] = record.value;
    }
    validateSyncSettings(next.settings);
  }
  if (switches.profiles) {
    for (const record of records.filter(record => record.item === 'profiles')) {
      let local = Object.keys(mapping).find(id => mapping[id] === record.key);
      if (record.value === null) { next.profiles = next.profiles.filter(profile => profile.id !== local); continue; }
      const value = record.value as Pick<SyncProfileSnapshot, 'name' | 'color' | 'createdAt'>;
      if (!local) {
        local = next.profiles.find(profile => !mapping[profile.id] && profile.name.toLowerCase() === value.name.toLowerCase())?.id ?? randomUUID(); mapping[local] = record.key;
      }
      const profile = next.profiles.find(profile => profile.id === local);
      if (profile) Object.assign(profile, value);
      else next.profiles.push({ id: local, ...value, store: emptySyncStore(), desktop: emptySyncDesktop(), windows: [] });
    }
    requireSync(next.profiles.length > 0 && next.profiles.length <= 20 && new Set(next.profiles.map(profile => profile.name.toLowerCase())).size === next.profiles.length);
  }
  for (const profile of next.profiles) {
    const id = mapping[profile.id], selected = live.filter(record => record.profile === id).sort((a, b) => a.key.localeCompare(b.key));
    if (!id) continue;
    if (switches.favorites) {
      const tree: FavoritesTree = { bar: [], other: [] }, folders = new Map<string, FavoriteItem>(), entries = selected.filter(record => record.item === 'favorites').map(record => ({ key: record.key, ...record.value as { parent: string; position: number; entry: FavoriteItem } })).sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
      for (const row of entries) { const entry = row.entry.kind === 'folder' ? { ...row.entry, children: [] } : row.entry; folders.set(row.key, entry); }
      const parents = new Map(entries.map(row => [row.key, row.parent]));
      for (const row of entries) {
        const ancestors = new Set<string>(); let parent: string | undefined = row.key;
        while (parent && parents.has(parent)) { requireSync(!ancestors.has(parent) && ancestors.size < 50); ancestors.add(parent); parent = parents.get(parent); }
      }
      for (const row of entries) {
        const parent = folders.get(row.parent), entry = folders.get(row.key)!;
        if (row.parent === 'bar' || row.parent === 'other') tree[row.parent].push(entry);
        else if (parent?.kind === 'folder') parent.children.push(entry);
        else tree.other.push(entry);
      }
      requireSync(validateStore({ ...emptySyncStore(), favorites: tree })); profile.store.favorites = tree;
    }
    if (switches.history) profile.store.history = selected.filter(record => record.item === 'history').map(record => record.value as BrowserStore['history'][number]).sort((a, b) => b.lastVisit - a.lastVisit || a.url.localeCompare(b.url));
    if (switches.siteSettings) {
      profile.store.siteSettings = { blocking: [], dark: [], permissions: [] };
      for (const record of selected.filter(record => record.item === 'siteSettings')) setSiteRecord(profile.store, record.key, record.value);
    }
    if (switches.desktop) {
      const rows = selected.filter(record => record.item === 'desktop').map(record => record.value as { type: string; project?: string | null; entry: Record<string, unknown> }).sort((a, b) => Number(a.entry.createdAt) - Number(b.entry.createdAt) || String(a.entry.id).localeCompare(String(b.entry.id)));
      profile.desktop.projects = rows.filter(row => row.type === 'project').map(row => ({ ...row.entry, folders: [], items: [] })) as unknown as DesktopStore['projects']; profile.desktop.captures = [];
      for (const row of rows.filter(row => row.type === 'folder')) profile.desktop.projects.find(project => project.id === row.project)?.folders.push(row.entry as never);
      for (const row of rows.filter(row => row.type === 'item')) {
        const item = localDesktopItem(row.entry), project = profile.desktop.projects.find(project => project.id === row.project);
        if (item.image && filename) item.image.filename = filename(profile.id, item, (row.entry.image as { blob: BlobReference }).blob);
        if (!project && row.project !== null) continue;
        if (item.folder && !project?.folders.some(folder => folder.id === item.folder)) item.folder = null;
        if (project) project.items.push(item); else profile.desktop.captures.push(item);
      }
      if (!profile.desktop.projects.some(project => project.id === profile.desktop.inUse)) profile.desktop.inUse = null;
      requireSync(validateDesktopStore(profile.desktop));
    }
    requireSync(validateStore(profile.store));
  }
  return next;
}
export function newer(left: SyncOperation, right: SyncOperation) { return left.time > right.time || left.time === right.time && left.id > right.id; }
export function mergeOperation(records: Map<string, SyncOperation>, incoming: SyncOperation, conflicts: Map<string, SyncOperation>): void {
  const key = recordId(incoming), previous = records.get(key); validateRecord(incoming);
  if (!previous || previous.id === incoming.id) { records.set(key, incoming); return; }
  if (incoming.item === 'history' && incoming.value === null && previous.value !== null && (previous.value as { lastVisit: number }).lastVisit > incoming.time) { conflicts.set(incoming.id, incoming); return; }
  if (incoming.item === 'history' && previous.value === null && incoming.value !== null && (incoming.value as { lastVisit: number }).lastVisit <= previous.time) { conflicts.set(incoming.id, incoming); return; }
  if (incoming.base === previous.id) { records.set(key, incoming); return; }
  if (previous.base === incoming.id) return;
  let winner = newer(incoming, previous) ? incoming : previous, loser = winner === incoming ? previous : incoming;
  if (incoming.item === 'history' && (incoming.value === null || previous.value === null)) {
    const edit = incoming.value === null ? previous : incoming, deletion = incoming.value === null ? incoming : previous;
    if (edit.value !== null && (edit.value as { lastVisit: number }).lastVisit > deletion.time) { winner = edit; loser = deletion; }
  }
  if (incoming.item !== 'computer' && JSON.stringify(previous.value) !== JSON.stringify(incoming.value)) conflicts.set(loser.id, loser);
  records.set(key, winner);
}
