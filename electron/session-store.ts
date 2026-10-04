import { existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OnStart } from '../src/shared/api';
import { isWebURL, settingsSection } from './browsing';
import { encryptedStore, readStoreFile, writeStoreFile } from './store';
import type { StoreCipher, StoreReadStatus } from './store';

export interface SessionEntry { url: string; title: string }
export interface SessionTab { url: string; title: string; zoom: number; entries: SessionEntry[]; index: number }
export interface ClosedTab extends SessionTab { position: number }
export interface SessionStore { version: 1; tabs: SessionTab[]; active: number; closed: ClosedTab[] }
export const CLOSED_TAB_LIMIT = 25;
export const SESSION_TAB_LIMIT = 200;
const HISTORY_LIMIT = 2000;
export const emptySession = (): SessionStore => ({ version: 1, tabs: [], active: -1, closed: [] });
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const string = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const index = (value: unknown, length: number): boolean => Number.isSafeInteger(value) && (length ? (value as number) >= 0 && (value as number) < length : value === -1);
function tabShape(value: unknown, closed = false): boolean {
  return shape(value, ['url', 'title', 'zoom', 'entries', 'index', ...(closed ? ['position'] : [])])
    && string(value.url, 8192) && string(value.title, 4096) && typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom >= 0.25 && value.zoom <= 3
    && Array.isArray(value.entries) && value.entries.length <= HISTORY_LIMIT && Array.from(value.entries).every(entry => shape(entry, ['url', 'title']) && string(entry.url, 8192) && string(entry.title, 4096))
    && index(value.index, value.entries.length) && (!closed || Number.isSafeInteger(value.position) && (value.position as number) >= 0 && (value.position as number) < SESSION_TAB_LIMIT);
}
export function validateSession(value: unknown): value is SessionStore {
  return shape(value, ['version', 'tabs', 'active', 'closed']) && value.version === 1
    && Array.isArray(value.tabs) && value.tabs.length <= SESSION_TAB_LIMIT && Array.from(value.tabs).every(tab => tabShape(tab)) && index(value.active, value.tabs.length)
    && Array.isArray(value.closed) && value.closed.length <= CLOSED_TAB_LIMIT && Array.from(value.closed).every(tab => tabShape(tab, true));
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
  return { version: 1, tabs: kept, active: active ? kept.indexOf(active) : kept.length ? Math.min(tabs.slice(0, store.active).filter(Boolean).length, kept.length - 1) : -1,
    closed: store.closed.map(tab => restorableTab(tab, ownAddress)).filter((tab): tab is ClosedTab => tab !== null) };
}
export function lazySession(store: SessionStore, onStart: OnStart) {
  const tabs = onStart === 'restore' ? store.tabs : [];
  return tabs.map((tab, position) => ({ tab, active: position === store.active, load: position === store.active && isWebURL(tab.url) }));
}
export function rememberClosed(store: SessionStore, tab: SessionTab, position: number): void {
  store.closed.unshift({ ...structuredClone(tab), position: Math.max(0, Math.min(SESSION_TAB_LIMIT - 1, Math.trunc(position))) });
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
    if (!validateSession(value)) throw new Error('Invalid session store');
    const restored = restoreSession(value, ownAddress);
    if (!encryptedStore(path)) writeSession(path, restored, cipher);
    return restored;
  } catch {
    status.readError = true;
    try { if (existsSync(path)) renameSync(path, `${path}.corrupt-${randomUUID()}`); }
    catch { status.memoryOnly = true; }
    return emptySession();
  }
}
