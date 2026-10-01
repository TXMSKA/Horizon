import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserStore } from '../src/shared/api';
import { isWebURL } from './browsing';

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

export function validateStore(value: unknown): value is BrowserStore {
  return object(value, ['version', 'history', 'bookmarks', 'downloads']) && value.version === 1
    && entries(value.history, entry => object(entry, ['url', 'title', 'lastVisit', 'visitCount'])
      && isWebURL(entry.url) && string(entry.title, 4096) && timestamp(entry.lastVisit) && integer(entry.visitCount, 1))
    && entries(value.bookmarks, entry => object(entry, ['url', 'title', 'createdAt'])
      && isWebURL(entry.url) && string(entry.title, 4096) && timestamp(entry.createdAt))
    && entries(value.downloads, entry => object(entry, ['id', 'url', 'filename', 'path', 'received', 'total', 'status', 'startedAt'])
      && string(entry.id, 128, 1) && isWebURL(entry.url) && string(entry.filename, 256, 1)
      && entry.filename !== '.' && entry.filename !== '..'
      && basename(entry.filename) === entry.filename && win32.basename(entry.filename) === entry.filename
      && string(entry.path, 8192, 1) && (isAbsolute(entry.path) || win32.isAbsolute(entry.path))
      && integer(entry.received) && integer(entry.total) && timestamp(entry.startedAt)
      && typeof entry.status === 'string' && ['progressing', 'completed', 'failed', 'cancelled'].includes(entry.status));
}

export function writeStore(path: string, store: BrowserStore): void {
  if (!validateStore(store)) throw new Error('Invalid browser store');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(store), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function readStore(path: string): BrowserStore {
  const empty: BrowserStore = { version: 1, history: [], bookmarks: [], downloads: [] };
  try {
    if (!existsSync(path)) {
      writeStore(path, empty);
      return empty;
    }
    let store: BrowserStore;
    try {
      if (statSync(path).size > 64 * 1024 * 1024) throw new Error('Browser store exceeds size limit');
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!validateStore(value)) throw new Error('Invalid browser store');
      store = value;
    } catch {
      renameSync(path, `${path}.corrupt-${randomUUID()}`);
      writeStore(path, empty);
      return empty;
    }
    const interrupted = store.downloads.filter(entry => entry.status === 'progressing');
    interrupted.forEach(entry => { entry.status = 'failed'; });
    if (interrupted.length) {
      try { writeStore(path, store); } catch { /* The recovered list remains usable in memory. */ }
    }
    return store;
  } catch {
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
