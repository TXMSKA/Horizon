import { dirname, resolve } from 'node:path';
import type { BrowserStore, DesktopItem, ImportProgress, SyncRemoteWindow } from '../src/shared/api';
import { isWebURL } from './browsing';
import { createDesktop } from './desktop';
import { makeProfile, profileStorePath, validateRegistry, writeRegistry } from './profiles';
import type { ProfileRegistry } from './profiles';
import type { ThemeSettings } from './settings';
import { readStore, validateStore, writeStore } from './store';
import type { StoreCipher } from './store';
import { readWindowSessions } from './session-store';
import type { WindowSessions } from './session-store';
import { requireSync } from './sync-format';
import type { SyncHost } from './sync-engine';
import type { SyncSnapshot } from './sync-model';

export interface SyncProfileData { store: BrowserStore; status: { readError: boolean; memoryOnly: boolean }; desktop: ReturnType<typeof createDesktop>; sessions: WindowSessions; sessionStatus: { readError: boolean; memoryOnly: boolean }; favoritesVersion: number; importProgress: ImportProgress | null }
export interface SyncBrowserBridge {
  registry(): ProfileRegistry;
  profiles: Map<string, SyncProfileData>;
  registryChanged(registry: ProfileRegistry): void;
  flush(): void;
  changed(): void;
  applied?(): void;
  dirty?(): void;
}
export function browserSyncHost(userData: string, cipher: StoreCipher, settings: ThemeSettings, bridge: SyncBrowserBridge): SyncHost {
  const get = (id: string): SyncProfileData => {
    let data = bridge.profiles.get(id);
    if (!data) {
      const path = profileStorePath(userData, id), status = { readError: false, memoryOnly: false }, sessionStatus = { readError: false, memoryOnly: false };
      data = { store: readStore(path, cipher, status), status, desktop: createDesktop(resolve(dirname(path), 'notebooks.json'), cipher, () => { bridge.dirty?.(); bridge.changed(); }),
        sessions: readWindowSessions(resolve(dirname(path), 'session.json'), cipher, url => url.startsWith('horizon://'), sessionStatus), sessionStatus, favoritesVersion: 0, importProgress: null };
      bridge.profiles.set(id, data);
    }
    requireSync(!data.status.readError && !data.status.memoryOnly && !data.sessionStatus.readError && !data.sessionStatus.memoryOnly, 'SYNC_STORAGE'); return data;
  };
  const read = (): SyncSnapshot => {
    bridge.flush();
    return { settings: settings.syncSnapshot(), profiles: bridge.registry().profiles.map(profile => {
      const data = get(profile.id), windows: SyncRemoteWindow[] = data.sessions.windows.map(window => {
        const tabs = window.session.tabs.filter(tab => isWebURL(tab.url)), ids = new Set(tabs.flatMap(tab => tab.groupId ? [tab.groupId] : []));
        return { profile: profile.id, id: window.id, tabs: tabs.map(tab => ({ title: tab.title, url: tab.url, group: tab.groupId ?? null })), groups: (window.session.groups ?? []).filter(group => ids.has(group.id)).map(group => ({ id: group.id, title: group.name })) };
      }).filter(window => window.tabs.length > 0);
      return { id: profile.id, name: profile.name, color: profile.color, createdAt: profile.createdAt, store: structuredClone(data.store), desktop: data.desktop.syncSnapshot(), windows };
    }) };
  };
  const replaceStore = (store: BrowserStore, next: BrowserStore) => {
    const sites = store.siteSettings; Object.assign(store, structuredClone(next), { downloads: store.downloads, siteSettings: sites });
    Object.assign(sites, structuredClone(next.siteSettings)); if (!next.siteSettings.translation) delete sites.translation;
  };
  return { read, changed: bridge.changed, committed: bridge.applied,
    image: (profile, item: DesktopItem) => {
      const desktop = get(profile).desktop, project = desktop.list().find(project => project.items.some(entry => entry.id === item.id)); return desktop.image(project?.id ?? null, item.id);
    },
    apply(next, images) {
      const previousRegistry = structuredClone(bridge.registry()), previousSettings = settings.syncSnapshot(), undo: (() => void)[] = [], registry = structuredClone(previousRegistry);
      registry.profiles = next.profiles.map(profile => {
        const previous = previousRegistry.profiles.find(entry => entry.id === profile.id), generated = previous ?? { ...makeProfile(profile.name, profile.color), id: profile.id, partition: `persist:profile-${profile.id}` };
        return { ...generated, name: profile.name, color: profile.color, createdAt: profile.createdAt };
      });
      if (!registry.profiles.some(profile => profile.id === registry.activeId)) registry.activeId = registry.profiles[0]?.id ?? '';
      registry.tombstones = [...new Set([...registry.tombstones, ...previousRegistry.profiles.filter(profile => !registry.profiles.some(next => next.id === profile.id)).map(profile => profile.partition)])];
      requireSync(validateRegistry(registry)); for (const profile of next.profiles) requireSync(validateStore(profile.store));
      const incoming = new Map<string, Buffer>(); for (const [id, bytes] of images) { const reference = JSON.parse(id) as { id: string }; incoming.set(`${reference.id}.bin`, bytes); }
      const rollback = () => { let failed = false; for (const restore of undo.reverse()) try { restore(); } catch { failed = true; } if (failed) throw new Error('SYNC_STORAGE'); };
      try {
        if (JSON.stringify(previousSettings) !== JSON.stringify(next.settings)) { settings.applySync(next.settings); undo.push(() => settings.applySync(previousSettings)); }
        for (const profile of next.profiles) {
          const data = get(profile.id), path = profileStorePath(userData, profile.id), oldStore = structuredClone(data.store); profile.store.downloads = data.store.downloads;
          if (JSON.stringify(oldStore) !== JSON.stringify(profile.store)) {
            writeStore(path, profile.store, cipher); replaceStore(data.store, profile.store); data.favoritesVersion++;
            undo.push(() => { writeStore(path, oldStore, cipher); replaceStore(data.store, oldStore); data.favoritesVersion++; });
          }
          const previousDesktop = data.desktop.syncSnapshot(); profile.desktop.key = previousDesktop.key;
          if (JSON.stringify(previousDesktop) !== JSON.stringify(profile.desktop)) undo.push(data.desktop.applySync(profile.desktop, incoming));
        }
        if (JSON.stringify(previousRegistry) !== JSON.stringify(registry)) {
          writeRegistry(resolve(userData, 'profiles.json'), registry); bridge.registryChanged(registry);
          undo.push(() => { writeRegistry(resolve(userData, 'profiles.json'), previousRegistry); bridge.registryChanged(previousRegistry); });
        }
      } catch (error) { rollback(); throw error; }
      bridge.changed(); return () => { rollback(); bridge.changed(); };
    },
  };
}
