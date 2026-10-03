import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { CaptureImage, Notebook, NotebookContent, NotebookItem, NotebookSummary } from '../src/shared/api';
import { isWebURL } from './browsing';
import { isProfileId } from './profiles';
import { encryptedStore, readStoreFile, writeStoreFile } from './store';
import type { StoreCipher, StoreReadStatus } from './store';

export const NOTEBOOK_LIMIT = 200;
export const NOTEBOOK_ITEM_LIMIT = 2000;
export const CAPTURE_LIMIT = 50 * 1024 * 1024;
export const CAPTURE_STORAGE_LIMIT = 2 * 1024 * 1024 * 1024;
export interface NotebookStore { version: 1; key: string; inUse: string | null; notebooks: Notebook[] }
const captureName = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/;
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function notebookText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0');
}
function integer(value: unknown, minimum = 0, maximum = 8640000000000000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
export function notebookName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('NOTEBOOK_NAME_INVALID');
  const name = value.trim();
  if (!name) throw new Error('NOTEBOOK_NAME_EMPTY');
  if (name.length > 80) throw new Error('NOTEBOOK_NAME_LONG');
  return name;
}
export function validateNotebookItem(value: unknown): value is NotebookItem {
  if (!object(value, ['id', 'kind', 'title', 'text', 'note', 'source', 'image', 'createdAt', 'updatedAt']) || !isProfileId(value.id)
    || !notebookText(value.title, 200) || !notebookText(value.text, 100000) || !notebookText(value.note, 20000)
    || !integer(value.createdAt) || !integer(value.updatedAt)) return false;
  if (value.kind === 'note') return value.source === null && value.image === null && value.note === '';
  if (!object(value.source, ['url', 'title']) || !isWebURL(value.source.url) || !notebookText(value.source.title, 4096)) return false;
  if (value.kind === 'text') return value.image === null;
  return (value.kind === 'area' || value.kind === 'page') && value.text === ''
    && object(value.image, ['filename', 'width', 'height', 'bytes', 'cut'])
    && typeof value.image.filename === 'string' && captureName.test(value.image.filename)
    && integer(value.image.width, 1, 100000) && integer(value.image.height, 1, value.kind === 'page' ? 16384 : 100000)
    && integer(value.image.bytes, 1, CAPTURE_LIMIT) && typeof value.image.cut === 'boolean'
    && (value.kind === 'page' || !value.image.cut);
}
export function validateNotebookStore(value: unknown): value is NotebookStore {
  if (!object(value, ['version', 'key', 'inUse', 'notebooks']) || value.version !== 1
    || typeof value.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.key)
    || Buffer.from(value.key, 'base64').toString('base64') !== value.key
    || !Array.isArray(value.notebooks) || value.notebooks.length > NOTEBOOK_LIMIT) return false;
  const ids = new Set<string>(), names = new Set<string>(), files = new Set<string>();
  let bytes = 0;
  for (const notebook of value.notebooks) {
    if (!object(notebook, ['id', 'name', 'createdAt', 'updatedAt', 'usedAt', 'items']) || !isProfileId(notebook.id)
      || ids.has(notebook.id) || !integer(notebook.createdAt) || !integer(notebook.updatedAt) || !integer(notebook.usedAt)
      || !Array.isArray(notebook.items) || notebook.items.length > NOTEBOOK_ITEM_LIMIT) return false;
    let name: string;
    try { name = notebookName(notebook.name); } catch { return false; }
    if (name !== notebook.name || names.has(name.toLowerCase())) return false;
    ids.add(notebook.id); names.add(name.toLowerCase());
    for (const item of notebook.items) {
      if (!validateNotebookItem(item) || ids.has(item.id)) return false;
      ids.add(item.id);
      if (item.image) {
        if (files.has(item.image.filename)) return false;
        files.add(item.image.filename); bytes += item.image.bytes + 28;
      }
    }
  }
  return bytes <= CAPTURE_STORAGE_LIMIT && (value.inUse === null || value.notebooks.some(notebook => notebook.id === value.inUse));
}
export function writeNotebookStore(path: string, store: NotebookStore, cipher?: StoreCipher): void {
  if (!validateNotebookStore(store)) throw new Error('NOTEBOOK_ITEM_INVALID');
  writeStoreFile(path, store, cipher);
}
export function readNotebookStore(path: string, cipher?: StoreCipher, status: StoreReadStatus = { readError: false, memoryOnly: false }): NotebookStore {
  const empty: NotebookStore = { version: 1, key: randomBytes(32).toString('base64'), inUse: null, notebooks: [] };
  try {
    if (!existsSync(path)) { writeNotebookStore(path, empty, cipher); return empty; }
    let store: NotebookStore;
    let encrypted: boolean;
    try {
      encrypted = encryptedStore(path);
      if (encrypted && !cipher?.isEncryptionAvailable()) { status.readError = true; status.memoryOnly = true; return empty; }
      const value = readStoreFile(path, cipher);
      if (!validateNotebookStore(value)) throw new Error('NOTEBOOK_ITEM_INVALID');
      store = value;
    } catch {
      status.readError = true;
      renameSync(path, `${path}.corrupt-${randomUUID()}`); writeNotebookStore(path, empty, cipher); return empty;
    }
    if (!encrypted && cipher?.isEncryptionAvailable()) {
      try { writeNotebookStore(path, store, cipher); } catch { /* A valid plain store remains usable if its upgrade fails. */ }
    }
    return store;
  } catch { status.readError = true; }
  return empty;
}

function safeDirectory(path: string): void {
  // Horizon owns captures, the profile folder and profiles; user-data ancestors may be links.
  for (let parent = resolve(path), depth = 0; depth < 3; parent = dirname(parent), depth++) {
    try {
      const entry = lstatSync(parent);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('NOTEBOOK_STORAGE_FAILED');
    } catch (error: unknown) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
function regularCapture(directory: string, name: string): string | null {
  safeDirectory(directory);
  if (!captureName.test(name)) return null;
  const path = resolve(directory, name);
  try { const entry = lstatSync(path); return !entry.isSymbolicLink() && entry.isFile() ? path : null; }
  catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
export function cleanupCaptureFiles(directory: string, store: NotebookStore): void {
  safeDirectory(directory);
  if (!existsSync(directory)) return;
  const referenced = new Set(store.notebooks.flatMap(notebook => notebook.items.flatMap(item => item.image ? [item.image.filename] : [])));
  for (const name of readdirSync(directory)) {
    if (!referenced.has(name)) { const path = regularCapture(directory, name); if (path) unlinkSync(path); }
  }
}
export function readCaptureFile(directory: string, key: string, item: NotebookItem): Buffer | null {
  try {
    if (!item.image) return null;
    const path = regularCapture(directory, item.image.filename);
    if (!path || lstatSync(path).size !== item.image.bytes + 28) return null;
    const bytes = readFileSync(path), decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(item.id)); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  } catch { return null; }
}
export function writeCaptureFile(directory: string, key: string, id: string, bytes: Buffer): string {
  if (!bytes.length || bytes.length > CAPTURE_LIMIT) throw new Error('CAPTURE_TOO_LARGE');
  if (!isProfileId(id)) throw new Error('NOTEBOOK_ITEM_INVALID');
  safeDirectory(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const used = readdirSync(directory).reduce((total, name) => {
    const path = regularCapture(directory, name); return total + (path ? lstatSync(path).size : 0);
  }, 0);
  if (used + bytes.length + 28 > CAPTURE_STORAGE_LIMIT) throw new Error('NOTEBOOK_STORAGE_FULL');
  const name = `${randomUUID()}.bin`, path = resolve(directory, name), temporary = `${path}.${randomUUID()}.tmp`;
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  cipher.setAAD(Buffer.from(id));
  try {
    writeFileSync(temporary, Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return name;
}

export function createNotebooks(path: string, cipher: StoreCipher, changed: () => void) {
  const status = { readError: false, memoryOnly: false }, store = readNotebookStore(path, cipher, status);
  const directory = resolve(dirname(path), 'captures');
  let storageError = false, version = 0, disposed = false;
  let pendingWrite: ReturnType<typeof setTimeout> | undefined, restoreTimeout: ReturnType<typeof setTimeout> | undefined;
  let kept: { notebook: Notebook; index: number; inUse: boolean } | { notebookId: string; item: NotebookItem; index: number } | undefined;
  // The recovery copy retains the only key and references for its captures,
  // including after the replacement store reads successfully on a later launch.
  if (!status.readError && !status.memoryOnly) try {
    const recoveryCopy = readdirSync(dirname(path)).some(name => name.startsWith(`${basename(path)}.corrupt-`));
    if (!recoveryCopy) cleanupCaptureFiles(directory, store);
  } catch { status.readError = true; }
  const flush = () => {
    if (pendingWrite === undefined) return;
    clearTimeout(pendingWrite); pendingWrite = undefined;
    try { writeNotebookStore(path, store, cipher); storageError = false; } catch { storageError = true; }
    changed();
  };
  const persist = () => {
    version++;
    if (!disposed && !status.memoryOnly && pendingWrite === undefined) pendingWrite = setTimeout(flush, 500);
  };
  const assertUnlocked = () => {
    if (!status.memoryOnly) return;
    if (!cipher.isEncryptionAvailable()) throw new Error('NOTEBOOK_LOCKED');
    const nextStatus = { readError: false, memoryOnly: false };
    const reopened = readNotebookStore(path, cipher, nextStatus);
    if (nextStatus.memoryOnly) throw new Error('NOTEBOOK_LOCKED');
    Object.assign(store, reopened); Object.assign(status, nextStatus); version++; changed();
  };
  const get = (id: string) => {
    const notebook = store.notebooks.find(notebook => notebook.id === id);
    if (!notebook) throw new Error('NOTEBOOK_NOT_FOUND');
    return notebook;
  };
  const item = (notebook: string, id: string) => {
    const entry = get(notebook).items.find(item => item.id === id);
    if (!entry) throw new Error('NOTEBOOK_ITEM_NOT_FOUND');
    return entry;
  };
  const removeFiles = (items: NotebookItem[]) => {
    for (const entry of items) if (entry.image) { const file = regularCapture(directory, entry.image.filename); if (file) unlinkSync(file); }
  };
  const forget = () => {
    clearTimeout(restoreTimeout); restoreTimeout = undefined;
    const previous = kept; kept = undefined;
    if (previous) try { removeFiles('notebook' in previous ? previous.notebook.items : [previous.item]); } catch { storageError = true; changed(); }
  };
  const keep = (value: NonNullable<typeof kept>) => { forget(); kept = value; restoreTimeout = setTimeout(forget, 8000); };
  const uniqueName = (value: string, id?: string) => {
    const name = notebookName(value);
    if (store.notebooks.some(notebook => notebook.id !== id && notebook.name.toLowerCase() === name.toLowerCase())) throw new Error('NOTEBOOK_NAME_DUPLICATE');
    return name;
  };
  const use = (id: string) => { const notebook = get(id); notebook.usedAt = Date.now(); store.inUse = id; persist(); };
  const add = (id: string, entry: NotebookItem) => {
    const notebook = get(id);
    if (notebook.items.length >= NOTEBOOK_ITEM_LIMIT) throw new Error('NOTEBOOK_ITEM_LIMIT');
    if (!validateNotebookItem(entry)) throw new Error('NOTEBOOK_ITEM_INVALID');
    notebook.items.push(entry); notebook.updatedAt = Date.now(); use(id);
  };
  return {
    get, item, use, forget, flush, assertUnlocked, list: () => store.notebooks,
    retry: () => {
      assertUnlocked();
      persist(); flush();
      if (storageError) throw new Error('NOTEBOOK_STORAGE_FAILED');
    },
    state: () => ({
      notebooks: store.notebooks.map(({ id, name, items, updatedAt, usedAt }): NotebookSummary => ({ id, name, updatedAt, usedAt,
        notes: items.filter(item => item.kind === 'note').length, captures: items.filter(item => item.kind !== 'note').length,
        latest: [...items].reverse().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3).map(({ id, kind, title, source }) => ({ id, kind, title, source })) })),
      notebookInUse: store.inUse, notebooksVersion: version, notebookReadError: status.readError && !status.memoryOnly, notebookLocked: status.memoryOnly, notebookStorageError: storageError,
    }),
    content: (id: string): NotebookContent => {
      const notebook = get(id);
      // Generated filenames belong only to the privileged store.
      return structuredClone({ ...notebook, items: notebook.items.map(({ image, ...entry }) => ({ ...entry,
        image: image ? { width: image.width, height: image.height, bytes: image.bytes, cut: image.cut } : null })) });
    },
    image: (notebook: string, id: string) => readCaptureFile(directory, store.key, item(notebook, id)),
    create: (value: string) => {
      assertUnlocked();
      const name = uniqueName(value);
      if (store.notebooks.length >= NOTEBOOK_LIMIT) throw new Error('NOTEBOOK_LIMIT');
      const now = Date.now(), notebook: Notebook = { id: randomUUID(), name, createdAt: now, updatedAt: now, usedAt: now, items: [] };
      store.notebooks.push(notebook); use(notebook.id); return notebook;
    },
    rename: (id: string, value: string) => { const notebook = get(id); notebook.name = uniqueName(value, id); notebook.updatedAt = Date.now(); persist(); },
    delete: (id: string) => {
      const notebook = get(id); keep({ notebook, index: store.notebooks.indexOf(notebook), inUse: store.inUse === id });
      store.notebooks.splice(store.notebooks.indexOf(notebook), 1); if (store.inUse === id) store.inUse = null; persist();
    },
    addNote: (id: string, title: string, text: string) => {
      assertUnlocked();
      const now = Date.now(); add(id, { id: randomUUID(), kind: 'note', title, text, note: '', source: null, image: null, createdAt: now, updatedAt: now });
    },
    addCapture: (id: string, entry: NotebookItem, bytes?: Buffer, image?: Omit<CaptureImage, 'filename' | 'bytes'>) => {
      assertUnlocked();
      if (get(id).items.length >= NOTEBOOK_ITEM_LIMIT) throw new Error('NOTEBOOK_ITEM_LIMIT');
      try {
        if (bytes && image) entry.image = { ...image, bytes: bytes.length, filename: writeCaptureFile(directory, store.key, entry.id, bytes) };
        add(id, entry);
      } catch (error: unknown) {
        if (entry.image) try { removeFiles([entry]); } catch { storageError = true; }
        if (error instanceof Error && ['CAPTURE_TOO_LARGE', 'NOTEBOOK_STORAGE_FULL', 'NOTEBOOK_ITEM_LIMIT', 'NOTEBOOK_ITEM_INVALID'].includes(error.message)) throw error;
        throw new Error('NOTEBOOK_STORAGE_FAILED');
      }
    },
    update: (notebook: string, id: string, fields: { title?: string; text?: string; note?: string }) => {
      const entry = item(notebook, id), next = { ...entry, ...fields, updatedAt: Date.now() };
      if (!validateNotebookItem(next)) throw new Error('NOTEBOOK_ITEM_INVALID');
      Object.assign(entry, next); get(notebook).updatedAt = next.updatedAt; persist();
    },
    deleteItem: (notebookId: string, id: string) => {
      const notebook = get(notebookId), entry = item(notebookId, id); keep({ notebookId, item: entry, index: notebook.items.indexOf(entry) });
      notebook.items.splice(notebook.items.indexOf(entry), 1); notebook.updatedAt = Date.now(); persist();
    },
    restore: () => {
      if (!kept) return;
      if ('notebook' in kept) {
        if (store.notebooks.length >= NOTEBOOK_LIMIT) throw new Error('NOTEBOOK_LIMIT');
        uniqueName(kept.notebook.name);
        store.notebooks.splice(kept.index, 0, kept.notebook); if (kept.inUse) store.inUse = kept.notebook.id;
      } else {
        const notebook = get(kept.notebookId);
        if (notebook.items.length >= NOTEBOOK_ITEM_LIMIT) throw new Error('NOTEBOOK_ITEM_LIMIT');
        notebook.items.splice(kept.index, 0, kept.item); notebook.updatedAt = Date.now();
      }
      kept = undefined; forget(); persist();
    },
    dispose: (discard = false) => {
      disposed = true;
      // Pending deletions become orphans after quit; never let a deleted profile's timer recreate its folder.
      clearTimeout(restoreTimeout); restoreTimeout = undefined; kept = undefined;
      if (discard) { clearTimeout(pendingWrite); pendingWrite = undefined; } else flush();
    },
  };
}
