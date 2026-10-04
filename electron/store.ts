import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserStore } from '../src/shared/api';
import { isWebURL } from './browsing';
import { isPermissionDecision, SITE_SETTINGS_LIMIT, validHost, validOrigin } from './site-settings';
import { migrateBookmarks, validFavorites } from './favorites';

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function string(value: unknown, maximum: number, minimum = 0): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum && !value.includes('\0');
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function timestamp(value: unknown): value is number {
  return integer(value) && value <= 8640000000000000;
}

function entries(value: unknown, validate: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= 100000 && Array.from(value).every(validate);
}

export interface StoreCipher { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export interface StoreReadStatus { readError: boolean; memoryOnly: boolean }
export const recordsBrowsing = (privateWindow: boolean): boolean => !privateWindow;
export function clearStoredHistoryOnClose(path: string, store: BrowserStore, cipher: StoreCipher, save = writeStore): void {
  if (!store.clearHistoryOnClose) return;
  const previous = store.history;
  store.history = [];
  try { save(path, store, cipher); } catch (error) { store.history = previous; throw error; }
}
const encryptedHeader = Buffer.from('HORIZON-STORE-1\n');
const STORE_LIMIT = 64 * 1024 * 1024;
export function encryptedStore(path: string): boolean {
  const file = openSync(path, 'r');
  try {
    const header = Buffer.alloc(encryptedHeader.length);
    return readSync(file, header, 0, header.length, 0) === header.length && header.equals(encryptedHeader);
  } finally { closeSync(file); }
}

function browsingEntries(value: Record<string, unknown>, legacy = true): boolean {
  return entries(value.history, entry => object(entry, ['url', 'title', 'lastVisit', 'visitCount'])
      && isWebURL(entry.url) && string(entry.title, 4096) && timestamp(entry.lastVisit) && integer(entry.visitCount, 1))
    && (legacy ? entries(value.bookmarks, entry => object(entry, ['url', 'title', 'createdAt'])
      && isWebURL(entry.url) && string(entry.title, 4096) && timestamp(entry.createdAt)) : validFavorites(value.favorites))
    && entries(value.downloads, entry => object(entry, ['id', 'url', 'filename', 'path', 'received', 'total', 'status', 'startedAt'])
      && string(entry.id, 128, 1) && isWebURL(entry.url) && string(entry.filename, 256, 1)
      && entry.filename !== '.' && entry.filename !== '..'
      && basename(entry.filename) === entry.filename && win32.basename(entry.filename) === entry.filename
      && string(entry.path, 8192, 1) && (isAbsolute(entry.path) || win32.isAbsolute(entry.path))
      && integer(entry.received) && integer(entry.total) && timestamp(entry.startedAt)
      && typeof entry.status === 'string' && ['progressing', 'completed', 'failed', 'cancelled'].includes(entry.status));
}

type LegacyStore = Omit<BrowserStore, 'version' | 'favorites'> & { version: 4; bookmarks: { url: string; title: string; createdAt: number }[] };
function legacyStore(value: unknown): value is Pick<LegacyStore, 'bookmarks' | 'history' | 'downloads'> & { version: 1 } {
  return object(value, ['version', 'history', 'bookmarks', 'downloads']) && value.version === 1 && browsingEntries(value);
}
function hostChoices(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > SITE_SETTINGS_LIMIT) return false;
  const hosts = new Set<string>();
  return Array.from(value).every(entry => {
    if (!object(entry, ['host', 'enabled']) || !validHost(entry.host) || typeof entry.enabled !== 'boolean' || hosts.has(entry.host)) return false;
    hosts.add(entry.host); return true;
  });
}
function siteEntries(settings: Record<string, unknown>): boolean {
  if (!hostChoices(settings.blocking) || !Array.isArray(settings.permissions) || settings.permissions.length > SITE_SETTINGS_LIMIT) return false;
  const origins = new Set<string>();
  return Array.from(settings.permissions).every(entry => {
    if (!object(entry, ['origin', 'camera', 'microphone', 'location', 'notifications']) || !validOrigin(entry.origin) || origins.has(entry.origin)
      || !['camera', 'microphone', 'location', 'notifications'].every(key => isPermissionDecision(entry[key]))) return false;
    origins.add(entry.origin); return true;
  });
}
function legacySiteStore(value: unknown): value is Pick<LegacyStore, 'bookmarks' | 'history' | 'downloads'> & { version: 2; siteSettings: Omit<BrowserStore['siteSettings'], 'dark'> } {
  return object(value, ['version', 'history', 'bookmarks', 'downloads', 'siteSettings']) && value.version === 2 && browsingEntries(value)
    && object(value.siteSettings, ['blocking', 'permissions']) && siteEntries(value.siteSettings);
}
function legacyDarkStore(value: unknown): value is Pick<LegacyStore, 'bookmarks' | 'history' | 'downloads' | 'siteSettings'> & { version: 3 } {
  return object(value, ['version', 'history', 'bookmarks', 'downloads', 'siteSettings']) && value.version === 3 && browsingEntries(value)
    && object(value.siteSettings, ['blocking', 'dark', 'permissions']) && siteEntries(value.siteSettings) && hostChoices(value.siteSettings.dark);
}
function legacyV4Store(value: unknown): value is LegacyStore {
  return object(value, ['version', 'history', 'bookmarks', 'downloads', 'siteSettings', 'clearHistoryOnClose', 'clearCacheOnClose']) && value.version === 4 && browsingEntries(value)
    && typeof value.clearHistoryOnClose === 'boolean' && typeof value.clearCacheOnClose === 'boolean'
    && object(value.siteSettings, ['blocking', 'dark', 'permissions']) && siteEntries(value.siteSettings) && hostChoices(value.siteSettings.dark);
}
export function validateStore(value: unknown): value is BrowserStore {
  return object(value, ['version', 'history', 'favorites', 'downloads', 'siteSettings', 'clearHistoryOnClose', 'clearCacheOnClose']) && value.version === 5 && browsingEntries(value, false)
    && typeof value.clearHistoryOnClose === 'boolean' && typeof value.clearCacheOnClose === 'boolean'
    && object(value.siteSettings, ['blocking', 'dark', 'permissions']) && siteEntries(value.siteSettings) && hostChoices(value.siteSettings.dark);
}

export function writeStore(path: string, store: BrowserStore, cipher?: StoreCipher): void {
  if (!validateStore(store)) throw new Error('Invalid browser store');
  writeStoreFile(path, store, cipher);
}

export function writeStoreFile(path: string, store: unknown, cipher?: StoreCipher): void {
  const encryption = Boolean(cipher?.isEncryptionAvailable());
  if (!encryption && existsSync(path) && encryptedStore(path)) {
    throw new Error('Store encryption is unavailable');
  }
  const json = JSON.stringify(store);
  const bytes = encryption ? Buffer.concat([encryptedHeader, cipher!.encryptString(json)]) : Buffer.from(json);
  if (bytes.length > STORE_LIMIT) throw new Error('Browser store exceeds size limit');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function readStoreFile(path: string, cipher?: StoreCipher, read?: () => void): unknown {
  if (statSync(path).size > STORE_LIMIT) throw new Error('Browser store exceeds size limit');
  const bytes = readFileSync(path);
  read?.();
  const encrypted = bytes.subarray(0, encryptedHeader.length).equals(encryptedHeader);
  return JSON.parse(encrypted ? cipher!.decryptString(bytes.subarray(encryptedHeader.length)) : bytes.toString('utf8'));
}

export function readStore(path: string, cipher?: StoreCipher, status: StoreReadStatus = { readError: false, memoryOnly: false }): BrowserStore {
  const empty: BrowserStore = { version: 5, history: [], favorites: { bar: [], other: [] }, downloads: [], siteSettings: { blocking: [], dark: [], permissions: [] }, clearHistoryOnClose: false, clearCacheOnClose: false };
  try {
    if (!existsSync(path)) {
      writeStore(path, empty, cipher);
      return empty;
    }
    let store: BrowserStore;
    let upgrade = false;
    try {
      if (!cipher?.isEncryptionAvailable() && encryptedStore(path)) {
        status.readError = true; status.memoryOnly = true;
        return empty;
      }
      const encrypted = encryptedStore(path);
      const value = readStoreFile(path, cipher);
      if (legacyStore(value)) {
        store = { ...empty, history: value.history, downloads: value.downloads, favorites: migrateBookmarks(value.bookmarks) }; upgrade = true;
      } else if (legacySiteStore(value)) {
        store = { ...empty, history: value.history, downloads: value.downloads, favorites: migrateBookmarks(value.bookmarks), siteSettings: { ...value.siteSettings, dark: [] } }; upgrade = true;
      } else if (legacyDarkStore(value)) {
        store = { ...empty, history: value.history, downloads: value.downloads, siteSettings: value.siteSettings, favorites: migrateBookmarks(value.bookmarks) }; upgrade = true;
      } else if (legacyV4Store(value)) {
        store = { ...empty, history: value.history, downloads: value.downloads, siteSettings: value.siteSettings, clearHistoryOnClose: value.clearHistoryOnClose, clearCacheOnClose: value.clearCacheOnClose, favorites: migrateBookmarks(value.bookmarks) }; upgrade = true;
      } else {
        if (!validateStore(value)) throw new Error('Invalid browser store');
        store = value;
      }
      upgrade ||= !encrypted && Boolean(cipher?.isEncryptionAvailable());
    } catch {
      status.readError = true;
      renameSync(path, `${path}.corrupt-${randomUUID()}`);
      writeStore(path, empty, cipher);
      return empty;
    }
    const interrupted = store.downloads.filter(entry => entry.status === 'progressing');
    interrupted.forEach(entry => { entry.status = 'failed'; });
    if (interrupted.length || upgrade) {
      try { writeStore(path, store, cipher); } catch { /* The recovered list remains usable in memory. */ }
    }
    return store;
  } catch {
    status.readError = true;
    // A read-only or unavailable profile must not prevent the browser from starting.
  }
  return empty;
}

export function reserveDownloadPath(directory: string, filename: string, reserved: ReadonlySet<string>): string {
  const leaf = basename(win32.basename(filename));
  let safe = Array.from(leaf).map(character => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character).join('');
  safe = safe.replace(/[. ]+$/g, '').trim();
  if (!safe || safe === '.' || safe === '..') safe = 'download';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(safe)) safe = `_${safe}`;
  // Leave room for the collision suffix on filesystems with a 255-byte component limit.
  while (Buffer.byteLength(safe, 'utf8') > 180) safe = Array.from(safe).slice(0, -1).join('');
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  const root = resolve(directory);
  const normalized = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const reservations = new Set(Array.from(reserved, normalized));
  for (let index = 0; index < 100000; index++) {
    const path = resolve(root, index ? `${stem} (${index})${extension}` : safe);
    let occupied = true;
    try { lstatSync(path); } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') occupied = false;
      else throw error;
    }
    if (!occupied && !reservations.has(normalized(path))) return path;
  }
  throw new Error('No available download filename');
}
