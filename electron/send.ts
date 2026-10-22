import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DesktopItemKind, SendApp, SendReceiver } from '../src/shared/api';

export const SEND_APPS = ['docs', 'blueprint', 'nova'] as const;
const names: Record<SendApp, string> = { docs: 'Docs', blueprint: 'Blueprint', nova: 'Nova' };
const kinds: DesktopItemKind[] = ['note', 'text', 'area', 'page', 'link'];
export interface SendPayload {
  kind: DesktopItemKind; title: string; text: string; note: string;
  source: { url: string; title: string } | null; project: string | null;
  image: { bytes: Buffer; width: number; height: number } | null;
}
export function cosmicRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(platform === 'win32' ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'Cosmic');
}
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function inboxDirectory(root: string, app: SendApp): string {
  const inbox = join(root, 'inbox'), directory = join(inbox, app);
  for (const path of [root, inbox, directory]) {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('SEND_FAILED');
  }
  return directory;
}
function receiver(root: string, app: SendApp): DesktopItemKind[] | null {
  let descriptor: number | undefined;
  try {
    const path = join(inboxDirectory(root, app), 'receiver.json'), entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 4096) return null;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 4096) return null;
    const bytes = readFileSync(descriptor);
    if (bytes.length > 4096) return null;
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(value, ['version', 'app', 'name', 'accepts']) || value.version !== 1 || value.app !== app
      || typeof value.name !== 'string' || !value.name.trim() || !Array.isArray(value.accepts)
      || !Array.from(value.accepts).every(kind => kinds.includes(kind as DesktopItemKind))) return null;
    return value.accepts as DesktopItemKind[];
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
export function readReceivers(root: string): SendReceiver[] {
  return SEND_APPS.map(app => ({ app, name: names[app], accepts: receiver(root, app) }));
}
function validPayload(value: unknown): value is SendPayload {
  if (!object(value, ['kind', 'title', 'text', 'note', 'source', 'project', 'image']) || !kinds.includes(value.kind as DesktopItemKind)
    || typeof value.title !== 'string' || typeof value.text !== 'string' || typeof value.note !== 'string'
    || value.project !== null && typeof value.project !== 'string'
    || value.source !== null && (!object(value.source, ['url', 'title']) || typeof value.source.url !== 'string' || typeof value.source.title !== 'string')) return false;
  if (value.image === null) return true;
  return object(value.image, ['bytes', 'width', 'height']) && Buffer.isBuffer(value.image.bytes)
    && value.image.bytes.length >= 8 && value.image.bytes.length <= 20 * 1024 * 1024
    && value.image.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && typeof value.image.width === 'number' && Number.isSafeInteger(value.image.width) && value.image.width > 0 && value.image.width <= 100000
    && typeof value.image.height === 'number' && Number.isSafeInteger(value.image.height) && value.image.height > 0 && value.image.height <= 100000;
}
function textLimit(text: string): string {
  const bytes = Buffer.from(text), limit = 1024 * 1024;
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export function sendItem(root: string, app: SendApp, payload: SendPayload): void {
  if (!SEND_APPS.includes(app) || !validPayload(payload)) throw new Error('SEND_FAILED');
  const accepts = receiver(root, app);
  if (!accepts || !accepts.includes(payload.kind)) throw new Error('SEND_NOT_INSTALLED');
  let partial: string | undefined;
  try {
    const directory = inboxDirectory(root, app), id = randomUUID(), now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const temporary = join(directory, `.partial-${id}`);
    mkdirSync(temporary, { mode: 0o700 }); partial = temporary;
    const value = { version: 1, id, from: 'horizon', sentAt: now.toISOString(), kind: payload.kind, title: payload.title,
      text: textLimit(payload.text), note: payload.note, source: payload.source, project: payload.project,
      image: payload.image ? { file: 'image.png', width: payload.image.width, height: payload.image.height } : null };
    writeFileSync(join(temporary, 'item.json'), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    if (payload.image) writeFileSync(join(temporary, 'image.png'), payload.image.bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(directory, `${timestamp}-${id}`)); partial = undefined;
  } catch {
    if (partial) try { rmSync(partial, { recursive: true, force: true }); } catch { /* A failed cleanup must retain the send error. */ }
    throw new Error('SEND_FAILED');
  }
}
