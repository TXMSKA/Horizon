import { existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OnStart, TabGroup } from '../src/shared/api';
import { groupIcon } from '../src/shared/group-icon-names';
import { contiguousTabGroups, groupColor, groupId, groupName, retainedTabGroups } from '../src/shared/tab-groups';
import { isWebURL, settingsSection } from './browsing';
import { encryptedStore, readStoreFile, writeStoreFile } from './store';
import type { StoreCipher, StoreReadStatus } from './store';

export interface SessionEntry { url: string; title: string }
export interface SessionTab { url: string; title: string; zoom: number; entries: SessionEntry[]; index: number; groupId?: string | null }
export interface ClosedTab extends SessionTab { position: number }
export interface SessionStore { version: 1 | 3; tabs: SessionTab[]; active: number; closed: ClosedTab[]; groups?: TabGroup[] }
export interface WindowSession { id: string; selected: boolean; session: SessionStore }
export interface WindowSessions { version: 2; windows: WindowSession[] }
export const LEGACY_WINDOW_ID = '00000000-0000-4000-8000-000000000001';
export const emptyWindowSessions = (): WindowSessions => ({ version: 2, windows: [] });
export const CLOSED_TAB_LIMIT = 25;
export const SESSION_TAB_LIMIT = 200;
const HISTORY_LIMIT = 2000;
export const emptySession = (): SessionStore => ({ version: 1, tabs: [], active: -1, closed: [] });
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const string = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const index = (value: unknown, length: number): boolean => Number.isSafeInteger(value) && (length ? (value as number) >= 0 && (value as number) < length : value === -1);
// A well-formed icon name is valid on disk; restoring drops one that Lucide no longer lists, so a renamed icon cannot cost a window its tabs.
const iconName = (value: unknown): boolean => value === null || typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
const validTabGroup = (value: unknown): value is TabGroup => shape(value, ['id', 'name', 'color', 'icon', 'folded']) && groupId(value.id) && groupName(value.name) && groupColor(value.color) && iconName(value.icon) && typeof value.folded === 'boolean';
function tabShape(value: unknown, closed = false, grouped = false): boolean {
  return shape(value, ['url', 'title', 'zoom', 'entries', 'index', ...(closed ? ['position'] : []), ...(grouped ? ['groupId'] : [])])
    && string(value.url, 8192) && string(value.title, 4096) && typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom >= 0.25 && value.zoom <= 3
    && Array.isArray(value.entries) && value.entries.length <= HISTORY_LIMIT && Array.from(value.entries).every(entry => shape(entry, ['url', 'title']) && string(entry.url, 8192) && string(entry.title, 4096))
    && index(value.index, value.entries.length) && (!closed || Number.isSafeInteger(value.position) && (value.position as number) >= 0 && (value.position as number) < SESSION_TAB_LIMIT)
    && (!grouped || value.groupId === null || !closed && groupId(value.groupId));
}
export function validateSession(value: unknown): value is SessionStore {
  if (!value || typeof value !== 'object') return false;
  const grouped = 'version' in value && value.version === 3;
  if (!shape(value, ['version', 'tabs', 'active', 'closed', ...(grouped ? ['groups'] : [])]) || value.version !== 1 && !grouped
    || !Array.isArray(value.tabs) || value.tabs.length > SESSION_TAB_LIMIT || !Array.from(value.tabs).every(tab => tabShape(tab, false, grouped)) || !index(value.active, value.tabs.length)
    || !Array.isArray(value.closed) || value.closed.length > CLOSED_TAB_LIMIT || !Array.from(value.closed).every(tab => tabShape(tab, true, grouped))) return false;
  if (!grouped) return true;
  const tabs = value.tabs;
  return Array.isArray(value.groups) && value.groups.length <= SESSION_TAB_LIMIT && Array.from(value.groups).every(validTabGroup)
    && contiguousTabGroups(tabs, value.groups) && !value.groups.some(group => group.folded && tabs[value.active as number]?.groupId === group.id);
}
export function migrateSession(store: SessionStore): SessionStore {
  if (store.version === 3) return structuredClone(store);
  return { version: 3, tabs: store.tabs.map(tab => ({ ...structuredClone(tab), groupId: null })), active: store.active,
    closed: store.closed.map(tab => ({ ...structuredClone(tab), groupId: null })), groups: [] };
}
export function validateWindowSessions(value: unknown): value is WindowSessions {
  if (!shape(value, ['version', 'windows']) || value.version !== 2 || !Array.isArray(value.windows) || value.windows.length > 200) return false;
  const ids = new Set<string>();
  return Array.from(value.windows).every(window => {
    if (!shape(window, ['id', 'selected', 'session']) || typeof window.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(window.id)
      || ids.has(window.id) || typeof window.selected !== 'boolean' || !validateSession(window.session)) return false;
    ids.add(window.id); return true;
  });
}
export function writeWindowSessions(path: string, store: WindowSessions, cipher: StoreCipher): void {
  if (!validateWindowSessions(store)) throw new Error('Invalid window sessions');
  if (!cipher.isEncryptionAvailable()) throw new Error('Store encryption is unavailable');
  writeStoreFile(path, store, cipher);
}
export function readWindowSessions(path: string, cipher: StoreCipher, ownAddress: (url: string) => boolean, status: StoreReadStatus): WindowSessions {
  if (!cipher.isEncryptionAvailable()) { status.memoryOnly = true; status.readError = existsSync(path); return emptyWindowSessions(); }
  try {
    if (!existsSync(path)) return emptyWindowSessions();
    const value = readStoreFile(path, cipher);
    const migrated = validateSession(value);
    const store = migrated ? { version: 2 as const, windows: [{ id: LEGACY_WINDOW_ID, selected: false, session: value }] } : value;
    if (!validateWindowSessions(store)) throw new Error('Invalid window sessions');
    const restored: WindowSessions = { version: 2, windows: store.windows.map(window => ({ ...window, session: restoreSession(migrateSession(window.session), ownAddress) })) };
    if (migrated || store.windows.some(window => window.session.version === 1) || !encryptedStore(path)) {
      try { writeWindowSessions(path, restored, cipher); }
      catch { status.readError = true; status.memoryOnly = true; }
    }
    return restored;
  } catch {
    status.readError = true;
    try { if (existsSync(path)) renameSync(path, `${path}.corrupt-${randomUUID()}`); } catch { status.memoryOnly = true; }
    return emptyWindowSessions();
  }
}
export function sessionAddress(url: string, ownAddress: (url: string) => boolean): boolean {
  return url === '' || url === 'about:blank' || isWebURL(url) || settingsSection(url) !== null || ownAddress(url);
}
export function restorableTab<T extends SessionTab>(tab: T, ownAddress: (url: string) => boolean): T | null {
  if (!sessionAddress(tab.url, ownAddress)) return null;
  const home = tab.url === '' || tab.url === 'about:blank';
  const entries = isWebURL(tab.url) || home ? tab.entries.filter(entry => isWebURL(entry.url) || entry.url === 'about:blank') : [];
  const selected = tab.entries[tab.index];
  let selectedIndex = selected ? entries.indexOf(selected) : -1;
  // A rejected current history entry must not replace the allowed address the tab was showing.
  if (entries.length && (selectedIndex < 0 || entries[selectedIndex]!.url !== (home ? 'about:blank' : tab.url))) { entries.splice(0, entries.length, { url: home ? 'about:blank' : tab.url, title: tab.title }); selectedIndex = 0; }
  return { ...tab, url: tab.url === 'about:blank' ? '' : tab.url, entries, index: entries.length ? Math.max(0, selectedIndex) : -1 };
}
export function restoreSession(store: SessionStore, ownAddress: (url: string) => boolean): SessionStore {
  const tabs = store.tabs.map(tab => restorableTab(tab, ownAddress));
  const active = tabs[store.active];
  const kept = tabs.filter((tab): tab is SessionTab => tab !== null);
  let selected = active ? kept.indexOf(active) : kept.length ? Math.min(tabs.slice(0, store.active).filter(Boolean).length, kept.length - 1) : -1;
  const groups = retainedTabGroups(kept, store.groups ?? []).map(group => ({ ...group, icon: groupIcon(group.icon) ? group.icon : null }));
  // Filtering unsafe addresses can leave only folded tabs, so restore one visible selection.
  if (store.version === 3 && groups.some(group => group.folded && kept[selected]?.groupId === group.id)) {
    const visible = kept.findIndex(tab => !groups.some(group => group.id === tab.groupId && group.folded));
    if (visible >= 0) selected = visible; else groups.find(group => group.id === kept[selected]?.groupId)!.folded = false;
  }
  return { version: store.version, tabs: kept, active: selected,
    closed: store.closed.map(tab => restorableTab(tab, ownAddress)).filter((tab): tab is ClosedTab => tab !== null), ...(store.version === 3 ? { groups } : {}) };
}
export function lazySession(store: SessionStore, onStart: OnStart) {
  const tabs = onStart === 'restore' ? store.tabs : [];
  return tabs.map((tab, position) => ({ tab, active: position === store.active, load: position === store.active && isWebURL(tab.url) }));
}
export function rememberClosed(store: SessionStore, tab: SessionTab, position: number): void {
  const saved = structuredClone(tab);
  if (store.version === 3) saved.groupId = null; else delete saved.groupId;
  store.closed.unshift({ ...saved, position: Math.max(0, Math.min(SESSION_TAB_LIMIT - 1, Math.trunc(position))) });
  store.closed.splice(CLOSED_TAB_LIMIT);
}
export function takeClosed(store: SessionStore, tabCount: number, ownAddress: (url: string) => boolean): ClosedTab | null {
  if (!store.closed.length) return null;
  if (tabCount >= SESSION_TAB_LIMIT) throw new Error('Tab limit reached');
  while (store.closed.length) {
    const tab = restorableTab(store.closed.shift()!, ownAddress);
    if (tab) return { ...tab, position: Math.min(tab.position, tabCount) };
  }
  return null;
}
export function writeSession(path: string, store: SessionStore, cipher: StoreCipher): void {
  if (!validateSession(store)) throw new Error('Invalid session store');
  if (!cipher.isEncryptionAvailable()) throw new Error('Store encryption is unavailable');
  writeStoreFile(path, store, cipher);
}
export function readSession(path: string, cipher: StoreCipher, ownAddress: (url: string) => boolean, status: StoreReadStatus): SessionStore {
  if (!cipher.isEncryptionAvailable()) { status.memoryOnly = true; status.readError = existsSync(path); return emptySession(); }
  try {
    if (!existsSync(path)) return emptySession();
    const value = readStoreFile(path, cipher);
    if (!validateSession(value) && !validateWindowSessions(value)) throw new Error('Invalid session store');
    const restored = restoreSession(validateSession(value) ? value : value.windows[0]?.session ?? emptySession(), ownAddress);
    if (!encryptedStore(path)) {
      if (validateWindowSessions(value)) writeWindowSessions(path, { version: 2, windows: value.windows.map(window => ({ ...window, session: restoreSession(window.session, ownAddress) })) }, cipher);
      else writeSession(path, restored, cipher);
    }
    return restored;
  } catch {
    status.readError = true;
    try { if (existsSync(path)) renameSync(path, `${path}.corrupt-${randomUUID()}`); }
    catch { status.memoryOnly = true; }
    return emptySession();
  }
}
