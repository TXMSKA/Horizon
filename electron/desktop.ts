import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { CaptureImage, CaptureSummary, Project, ProjectContent, DesktopItem, DesktopItemContent, ProjectFolder, ProjectSummary } from '../src/shared/api';
import { isWebURL } from './browsing';
import { isProfileId } from './profiles';
import { encryptedStore, readStoreFile, writeStoreFile } from './store';
import type { StoreCipher, StoreReadStatus } from './store';
export { desktopAddress } from '../src/shared/desktop-address';

export const PROJECT_LIMIT = 200;
export const PROJECT_ITEM_LIMIT = 2000;
export const FOLDER_LIMIT = 50;
export const KEPT_CAPTURE_LIMIT = 2000;
export const CAPTURE_LIMIT = 50 * 1024 * 1024;
export const CAPTURE_STORAGE_LIMIT = 2 * 1024 * 1024 * 1024;
export interface DesktopStore { version: 2; key: string; inUse: string | null; projects: Project[]; captures: DesktopItem[] }
const captureName = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/;
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function desktopText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0');
}
export function desktopInputText(value: unknown, maximum: number): value is string {
  return desktopText(value, maximum) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
}
export function desktopTitle(value: unknown, maximum = 200): value is string {
  return desktopInputText(value, maximum) && !/[\t\r\n]/.test(value);
}
export function folderName(value: unknown): string {
  try { return projectName(value); } catch (error) {
    throw new Error(error instanceof Error ? error.message.replace('PROJECT_', 'FOLDER_') : 'FOLDER_NAME_INVALID');
  }
}
function integer(value: unknown, minimum = 0, maximum = 8640000000000000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
export function projectName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('PROJECT_NAME_INVALID');
  const name = value.trim();
  if (!name) throw new Error('PROJECT_NAME_EMPTY');
  if (name.length > 80) throw new Error('PROJECT_NAME_LONG');
  return name;
}
function itemFields(value: unknown, legacy = false): value is DesktopItem {
  if (!object(value, ['id', 'kind', 'title', 'text', 'note', 'source', 'image', 'createdAt', 'updatedAt', ...(legacy ? [] : ['folder'])]) || !isProfileId(value.id)
    || !desktopText(value.title, 200) || !desktopText(value.text, 100000) || !desktopText(value.note, 20000)
    || !integer(value.createdAt) || !integer(value.updatedAt) || !legacy && value.folder !== null && !isProfileId(value.folder)) return false;
  if (value.kind === 'note') return value.source === null && value.image === null && value.note === '';
  if (!legacy && value.kind === 'text' && value.source === null) return value.image === null;
  if (!object(value.source, ['url', 'title']) || !isWebURL(value.source.url) || !desktopText(value.source.title, 4096)) return false;
  if (!legacy && value.kind === 'link') return value.text === '' && value.image === null && desktopTitle(value.title) && desktopTitle(value.source.title, 200);
  if (value.kind === 'text') return value.image === null;
  return (value.kind === 'area' || value.kind === 'page') && value.text === ''
    && object(value.image, ['filename', 'width', 'height', 'bytes', 'cut'])
    && typeof value.image.filename === 'string' && captureName.test(value.image.filename)
    && integer(value.image.width, 1, 100000) && integer(value.image.height, 1, value.kind === 'page' ? 16384 : 100000)
    && integer(value.image.bytes, 1, CAPTURE_LIMIT) && typeof value.image.cut === 'boolean'
    && (value.kind === 'page' || !value.image.cut);
}
export function validateDesktopItem(value: unknown): value is DesktopItem { return itemFields(value); }
function migrateDesktopStore(value: unknown): DesktopStore | null {
  if (!object(value, ['version', 'key', 'inUse', 'notebooks']) || value.version !== 1 || !Array.isArray(value.notebooks)) return null;
  const projects: unknown[] = [];
  for (const notebook of value.notebooks) {
    if (!object(notebook, ['id', 'name', 'createdAt', 'updatedAt', 'usedAt', 'items']) || !Array.isArray(notebook.items) || !Array.from(notebook.items).every(entry => itemFields(entry, true))) return null;
    projects.push({ ...notebook, folders: [], items: notebook.items.map(entry => ({ ...entry, folder: null })) });
  }
  const next = { version: 2, key: value.key, inUse: value.inUse, projects, captures: [] };
  return validateDesktopStore(next) ? next : null;
}
export function validateDesktopStore(value: unknown): value is DesktopStore {
  if (!object(value, ['version', 'key', 'inUse', 'projects', 'captures']) || value.version !== 2
    || typeof value.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.key)
    || Buffer.from(value.key, 'base64').toString('base64') !== value.key
    || !Array.isArray(value.projects) || value.projects.length > PROJECT_LIMIT
    || !Array.isArray(value.captures) || value.captures.length > KEPT_CAPTURE_LIMIT) return false;
  const ids = new Set<string>(), names = new Set<string>(), files = new Set<string>();
  let bytes = 0;
  const entry = (item: unknown, folders: Set<string>) => {
    if (!validateDesktopItem(item) || ids.has(item.id) || item.folder !== null && !folders.has(item.folder)) return false;
    ids.add(item.id);
    if (item.image) {
      if (files.has(item.image.filename)) return false;
      files.add(item.image.filename); bytes += item.image.bytes + 28;
    }
    return true;
  };
  for (const project of value.projects) {
    if (!object(project, ['id', 'name', 'createdAt', 'updatedAt', 'usedAt', 'items', 'folders']) || !isProfileId(project.id)
      || ids.has(project.id) || !integer(project.createdAt) || !integer(project.updatedAt) || !integer(project.usedAt)
      || !Array.isArray(project.items) || project.items.length > PROJECT_ITEM_LIMIT
      || !Array.isArray(project.folders) || project.folders.length > FOLDER_LIMIT) return false;
    let name: string;
    try { name = projectName(project.name); } catch { return false; }
    if (name !== project.name || names.has(name.toLowerCase())) return false;
    ids.add(project.id); names.add(name.toLowerCase());
    const folders = new Set<string>(), folderNames = new Set<string>();
    for (const folder of project.folders) {
      if (!object(folder, ['id', 'name', 'createdAt']) || !isProfileId(folder.id) || ids.has(folder.id) || !integer(folder.createdAt)) return false;
      try { if (folderName(folder.name) !== folder.name) return false; } catch { return false; }
      const name = (folder.name as string).toLowerCase();
      if (folderNames.has(name)) return false;
      ids.add(folder.id); folders.add(folder.id); folderNames.add(name);
    }
    if (!Array.from(project.items).every(item => entry(item, folders))) return false;
  }
  if (!Array.from(value.captures).every(item => validateDesktopItem(item) && (item.kind === 'area' || item.kind === 'page') && entry(item, new Set()))) return false;
  return bytes <= CAPTURE_STORAGE_LIMIT && (value.inUse === null || value.projects.some(project => project.id === value.inUse));
}
export function writeDesktopStore(path: string, store: DesktopStore, cipher?: StoreCipher): void {
  if (!validateDesktopStore(store)) throw new Error('DESKTOP_ITEM_INVALID');
  writeStoreFile(path, store, cipher);
}
export function readDesktopStore(path: string, cipher?: StoreCipher, status: StoreReadStatus = { readError: false, memoryOnly: false }): DesktopStore {
  const empty: DesktopStore = { version: 2, key: randomBytes(32).toString('base64'), inUse: null, projects: [], captures: [] };
  try {
    if (!existsSync(path)) { writeDesktopStore(path, empty, cipher); return empty; }
    let store: DesktopStore;
    let encrypted: boolean;
    let migrated = false;
    try {
      encrypted = encryptedStore(path);
      if (encrypted && !cipher?.isEncryptionAvailable()) { status.readError = true; status.memoryOnly = true; return empty; }
      const value = readStoreFile(path, cipher);
      const upgrade = migrateDesktopStore(value);
      if (upgrade) { store = upgrade; migrated = true; }
      else { if (!validateDesktopStore(value)) throw new Error('DESKTOP_ITEM_INVALID'); store = value; }
    } catch {
      status.readError = true;
      renameSync(path, `${path}.corrupt-${randomUUID()}`); writeDesktopStore(path, empty, cipher); return empty;
    }
    if (migrated || !encrypted && cipher?.isEncryptionAvailable()) {
      try { writeDesktopStore(path, store, cipher); } catch { /* A valid plain store remains usable if its upgrade fails. */ }
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
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('DESKTOP_STORAGE_FAILED');
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
export function cleanupCaptureFiles(directory: string, store: DesktopStore): void {
  safeDirectory(directory);
  if (!existsSync(directory)) return;
  const referenced = new Set([...store.projects.flatMap(project => project.items), ...store.captures].flatMap(item => item.image ? [item.image.filename] : []));
  for (const name of readdirSync(directory)) {
    if (!referenced.has(name)) { const path = regularCapture(directory, name); if (path) unlinkSync(path); }
  }
}
export function readCaptureFile(directory: string, key: string, item: DesktopItem): Buffer | null {
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
  if (!isProfileId(id)) throw new Error('DESKTOP_ITEM_INVALID');
  safeDirectory(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const used = readdirSync(directory).reduce((total, name) => {
    const path = regularCapture(directory, name); return total + (path ? lstatSync(path).size : 0);
  }, 0);
  if (used + bytes.length + 28 > CAPTURE_STORAGE_LIMIT) throw new Error('DESKTOP_STORAGE_FULL');
  const name = `${randomUUID()}.bin`, path = resolve(directory, name), temporary = `${path}.${randomUUID()}.tmp`;
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  cipher.setAAD(Buffer.from(id));
  try {
    writeFileSync(temporary, Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return name;
}

export function createDesktop(path: string, cipher: StoreCipher, changed: () => void) {
  const status = { readError: false, memoryOnly: false }, store = readDesktopStore(path, cipher, status);
  const directory = resolve(dirname(path), 'captures');
  let storageError = false, version = 0, disposed = false;
  let pendingWrite: ReturnType<typeof setTimeout> | undefined, restoreTimeout: ReturnType<typeof setTimeout> | undefined;
  let kept: { project: Project; index: number; inUse: boolean } | { projectId: string | null; item: DesktopItem; index: number }
    | { projectId: string; folder: ProjectFolder; index: number; items: string[] } | undefined;
  // The recovery copy retains the only key and references for its captures,
  // including after the replacement store reads successfully on a later launch.
  if (!status.readError && !status.memoryOnly) try {
    const recoveryCopy = readdirSync(dirname(path)).some(name => name.startsWith(`${basename(path)}.corrupt-`));
    if (!recoveryCopy) cleanupCaptureFiles(directory, store);
  } catch { status.readError = true; }
  const flush = () => {
    if (pendingWrite === undefined) return;
    clearTimeout(pendingWrite); pendingWrite = undefined;
    try { writeDesktopStore(path, store, cipher); storageError = false; } catch { storageError = true; }
    changed();
  };
  const persist = () => {
    version++;
    if (!disposed && !status.memoryOnly && pendingWrite === undefined) pendingWrite = setTimeout(flush, 500);
  };
  const assertUnlocked = () => {
    if (!status.memoryOnly) return;
    if (!cipher.isEncryptionAvailable()) throw new Error('DESKTOP_LOCKED');
    const nextStatus = { readError: false, memoryOnly: false };
    const reopened = readDesktopStore(path, cipher, nextStatus);
    if (nextStatus.memoryOnly) throw new Error('DESKTOP_LOCKED');
    Object.assign(store, reopened); Object.assign(status, nextStatus); version++; changed();
  };
  const get = (id: string) => {
    const project = store.projects.find(project => project.id === id);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    return project;
  };
  const collection = (project: string | null) => project === null ? store.captures : get(project).items;
  const item = (project: string | null, id: string) => {
    const entry = collection(project).find(item => item.id === id);
    if (!entry) throw new Error('DESKTOP_ITEM_NOT_FOUND');
    return entry;
  };
  const removeFiles = (items: DesktopItem[]) => {
    for (const entry of items) if (entry.image) { const file = regularCapture(directory, entry.image.filename); if (file) unlinkSync(file); }
  };
  const forget = () => {
    clearTimeout(restoreTimeout); restoreTimeout = undefined;
    const previous = kept; kept = undefined;
    if (previous && !('folder' in previous)) try { removeFiles('project' in previous ? previous.project.items : [previous.item]); } catch { storageError = true; changed(); }
  };
  const keep = (value: NonNullable<typeof kept>) => { forget(); kept = value; restoreTimeout = setTimeout(forget, 8000); };
  const uniqueName = (value: string, id?: string) => {
    const name = projectName(value);
    if (store.projects.some(project => project.id !== id && project.name.toLowerCase() === name.toLowerCase())) throw new Error('PROJECT_NAME_DUPLICATE');
    return name;
  };
  const use = (id: string) => { const project = get(id); project.usedAt = Date.now(); store.inUse = id; persist(); };
  const folder = (project: string, id: string) => {
    const entry = get(project).folders.find(folder => folder.id === id);
    if (!entry) throw new Error('FOLDER_NOT_FOUND');
    return entry;
  };
  const checkFolder = (project: string | null, id: string | null) => {
    if (id !== null) { if (project === null) throw new Error('FOLDER_NOT_FOUND'); folder(project, id); }
  };
  const uniqueFolder = (project: string, value: string, id?: string) => {
    const name = folderName(value);
    if (get(project).folders.some(folder => folder.id !== id && folder.name.toLowerCase() === name.toLowerCase())) throw new Error('FOLDER_NAME_DUPLICATE');
    return name;
  };
  const capacity = (project: string | null) => {
    if (collection(project).length >= (project === null ? KEPT_CAPTURE_LIMIT : PROJECT_ITEM_LIMIT)) throw new Error(project === null ? 'CAPTURE_LIMIT' : 'PROJECT_ITEM_LIMIT');
  };
  const touch = (project: string | null) => { if (project !== null) get(project).updatedAt = Date.now(); persist(); };
  const add = (id: string | null, entry: DesktopItem) => {
    capacity(id); checkFolder(id, entry.folder);
    if (!validateDesktopItem(entry)) throw new Error('DESKTOP_ITEM_INVALID');
    if (id === null && entry.kind !== 'area' && entry.kind !== 'page') throw new Error('DESKTOP_ITEM_INVALID');
    if ([...store.projects.flatMap(project => project.items), ...store.captures].some(item => item.id === entry.id)) throw new Error('DESKTOP_ITEM_INVALID');
    collection(id).push(entry); touch(id); if (id !== null) use(id);
  };
  const contentItem = ({ image, ...entry }: DesktopItem): DesktopItemContent => ({ ...entry,
    image: image ? { width: image.width, height: image.height, bytes: image.bytes, cut: image.cut } : null });
  return {
    get, item, folder, use, forget, flush, assertUnlocked, list: () => store.projects, captureList: () => store.captures,
    retry: () => {
      assertUnlocked();
      persist(); flush();
      if (storageError) throw new Error('DESKTOP_STORAGE_FAILED');
    },
    state: () => ({
      projects: store.projects.map(({ id, name, items, updatedAt, usedAt }): ProjectSummary => ({ id, name, updatedAt, usedAt,
        pages: items.filter(item => item.kind === 'link').length, notes: items.filter(item => item.kind === 'note').length,
        captures: items.filter(item => item.kind === 'area' || item.kind === 'page' || item.kind === 'text').length,
        folders: get(id).folders.map(folder => ({ ...folder, count: items.filter(item => item.folder === folder.id).length })),
        latest: [...items].reverse().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3).map(({ id, folder, kind, title, source, createdAt, updatedAt }) => ({ id, folder, kind, title, source, createdAt, updatedAt })) })),
      captures: store.captures.map(({ id, title, source, createdAt }): CaptureSummary => ({ id, title, source, createdAt })),
      projectInUse: store.inUse, desktopVersion: version, desktopReadError: status.readError && !status.memoryOnly, desktopLocked: status.memoryOnly, desktopStorageError: storageError,
    }),
    content: (id: string): ProjectContent => {
      const project = get(id);
      // Generated filenames belong only to the privileged store.
      return structuredClone({ ...project, items: project.items.map(contentItem) });
    },
    captures: (): DesktopItemContent[] => structuredClone(store.captures.map(contentItem)),
    image: (project: string | null, id: string) => readCaptureFile(directory, store.key, item(project, id)),
    create: (value: string) => {
      assertUnlocked();
      const name = uniqueName(value);
      if (store.projects.length >= PROJECT_LIMIT) throw new Error('PROJECT_LIMIT');
      const now = Date.now(), project: Project = { id: randomUUID(), name, createdAt: now, updatedAt: now, usedAt: now, folders: [], items: [] };
      store.projects.push(project); use(project.id); return project;
    },
    rename: (id: string, value: string) => { assertUnlocked(); const project = get(id); project.name = uniqueName(value, id); project.updatedAt = Date.now(); persist(); },
    delete: (id: string) => {
      assertUnlocked();
      const project = get(id); keep({ project, index: store.projects.indexOf(project), inUse: store.inUse === id });
      store.projects.splice(store.projects.indexOf(project), 1); if (store.inUse === id) store.inUse = null; persist();
    },
    createFolder: (project: string, value: string) => {
      assertUnlocked(); const parent = get(project), name = uniqueFolder(project, value);
      if (parent.folders.length >= FOLDER_LIMIT) throw new Error('FOLDER_LIMIT');
      const entry = { id: randomUUID(), name, createdAt: Date.now() }; parent.folders.push(entry); touch(project); return entry;
    },
    renameFolder: (project: string, id: string, value: string) => { assertUnlocked(); const entry = folder(project, id); entry.name = uniqueFolder(project, value, id); touch(project); },
    deleteFolder: (project: string, id: string) => {
      assertUnlocked(); const parent = get(project), entry = folder(project, id);
      keep({ projectId: project, folder: entry, index: parent.folders.indexOf(entry), items: parent.items.filter(item => item.folder === id).map(item => item.id) });
      parent.folders.splice(parent.folders.indexOf(entry), 1); for (const item of parent.items) if (item.folder === id) item.folder = null; touch(project);
    },
    moveItemFolder: (project: string, id: string, destination: string | null) => {
      assertUnlocked(); const entry = item(project, id); checkFolder(project, destination); entry.folder = destination; touch(project);
    },
    moveItemProject: (project: string, id: string, destination: string, destinationFolder: string | null) => {
      assertUnlocked(); const entry = item(project, id); checkFolder(destination, destinationFolder);
      if (project !== destination) { capacity(destination); collection(project).splice(collection(project).indexOf(entry), 1); collection(destination).push(entry); }
      entry.folder = destinationFolder; touch(project); touch(destination); use(destination);
    },
    addCaptureToProject: (id: string, project: string, destination: string | null) => {
      assertUnlocked(); const entry = item(null, id); checkFolder(project, destination); capacity(project);
      store.captures.splice(store.captures.indexOf(entry), 1); entry.folder = destination; collection(project).push(entry); touch(project); use(project);
    },
    addLink: (project: string, destination: string | null, address: string, title: string) => {
      assertUnlocked();
      if (!isWebURL(address) || !desktopTitle(title)) throw new Error('LINK_INVALID');
      const now = Date.now(); add(project, { id: randomUUID(), folder: destination, kind: 'link', title, text: '', note: '', source: { url: address, title }, image: null, createdAt: now, updatedAt: now });
    },
    addText: (project: string, destination: string | null, text: string, source: DesktopItem['source']) => {
      assertUnlocked();
      if (!desktopInputText(text, 100000) || source !== null && (!object(source, ['url', 'title']) || !isWebURL(source.url) || !desktopTitle(source.title))) throw new Error('TEXT_INVALID');
      const now = Date.now(); add(project, { id: randomUUID(), folder: destination, kind: 'text', title: source?.title ?? '', text, note: '', source, image: null, createdAt: now, updatedAt: now });
    },
    addNote: (id: string, title: string, text: string, destination: string | null = null) => {
      assertUnlocked();
      if (!desktopTitle(title) || !desktopInputText(text, 100000)) throw new Error('DESKTOP_ITEM_INVALID');
      const now = Date.now(); add(id, { id: randomUUID(), folder: destination, kind: 'note', title, text, note: '', source: null, image: null, createdAt: now, updatedAt: now });
    },
    addCapture: (id: string | null, entry: DesktopItem, bytes?: Buffer, image?: Omit<CaptureImage, 'filename' | 'bytes'>) => {
      assertUnlocked();
      capacity(id); checkFolder(id, entry.folder);
      if (!['text', 'area', 'page'].includes(entry.kind) || id === null && entry.kind === 'text') throw new Error('DESKTOP_ITEM_INVALID');
      let written = false;
      try {
        if (bytes && image) { entry.image = { ...image, bytes: bytes.length, filename: writeCaptureFile(directory, store.key, entry.id, bytes) }; written = true; }
        add(id, entry);
      } catch (error: unknown) {
        if (written && entry.image) try { removeFiles([entry]); } catch { storageError = true; }
        if (error instanceof Error && ['CAPTURE_TOO_LARGE', 'DESKTOP_STORAGE_FULL', 'PROJECT_ITEM_LIMIT', 'CAPTURE_LIMIT', 'DESKTOP_ITEM_INVALID'].includes(error.message)) throw error;
        throw new Error('DESKTOP_STORAGE_FAILED');
      }
    },
    update: (project: string | null, id: string, fields: { title?: string; text?: string; note?: string }) => {
      assertUnlocked();
      const entry = item(project, id), next = { ...entry, ...fields, updatedAt: Date.now() };
      if (!Object.keys(fields).length || Object.keys(fields).some(key => !['title', 'text', 'note'].includes(key))
        || fields.title !== undefined && !desktopTitle(fields.title) || fields.text !== undefined && !desktopInputText(fields.text, 100000)
        || fields.note !== undefined && !desktopInputText(fields.note, 20000) || !validateDesktopItem(next)) throw new Error('DESKTOP_ITEM_INVALID');
      Object.assign(entry, next); touch(project);
    },
    deleteItem: (projectId: string | null, id: string) => {
      assertUnlocked(); const entries = collection(projectId), entry = item(projectId, id); keep({ projectId, item: entry, index: entries.indexOf(entry) });
      entries.splice(entries.indexOf(entry), 1); touch(projectId);
    },
    restore: () => {
      assertUnlocked();
      if (!kept) return;
      if ('project' in kept) {
        if (store.projects.length >= PROJECT_LIMIT) throw new Error('PROJECT_LIMIT');
        uniqueName(kept.project.name);
        store.projects.splice(kept.index, 0, kept.project); if (kept.inUse) store.inUse = kept.project.id;
      } else if ('folder' in kept) {
        const project = get(kept.projectId);
        if (project.folders.length >= FOLDER_LIMIT) throw new Error('FOLDER_LIMIT');
        uniqueFolder(project.id, kept.folder.name);
        project.folders.splice(kept.index, 0, kept.folder);
        for (const item of project.items) if (kept.items.includes(item.id) && item.folder === null) item.folder = kept.folder.id;
        touch(project.id);
      } else {
        capacity(kept.projectId);
        // The original folder can have changed while the deletion was pending.
        const destination = kept.item.folder;
        if (kept.projectId !== null && destination !== null && !get(kept.projectId).folders.some(folder => folder.id === destination)) kept.item.folder = null;
        collection(kept.projectId).splice(kept.index, 0, kept.item); touch(kept.projectId);
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
