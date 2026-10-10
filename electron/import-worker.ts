import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { FAVICON_LIMIT, isRasterImage } from './favicon';
import { isWebURL } from './browsing';

export interface WorkerRequest { database: string; kind: 'chromium' | 'firefox'; bookmarks: boolean; history: boolean; permissions: boolean; scan: number; nodes: number; faviconOrigins?: string[] }
export interface HistoryRow { url: string; title: string; visits: number; last: number }
export interface MarkRow { id: number; parent: number; position: number; type: number; title: string | null; added: number; guid: string; url: string | null }
export interface PermissionRow { origin: string; type: string; permission: number }
export interface FaviconRow { origin: string; bytes: Uint8Array; alternatives?: Uint8Array[] }
export type WorkerReply = { ok: true; history: HistoryRow[]; bookmarks: MarkRow[]; permissions: PermissionRow[]; favicons: FaviconRow[] } | { ok: false };

// Both browsers count in microseconds from their own epoch, which overflows a double, so SQLite converts to milliseconds.
const CHROMIUM = 'SELECT url, title, CAST(MIN(visit_count, 1000000) AS INTEGER) AS visits, CAST(last_visit_time / 1000 - 11644473600000 AS INTEGER) AS last FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?';
const FIREFOX_HISTORY = 'SELECT url, title, CAST(MIN(visit_count, 1000000) AS INTEGER) AS visits, CAST(last_visit_date / 1000 AS INTEGER) AS last FROM moz_places WHERE hidden = 0 AND last_visit_date > 0 ORDER BY last_visit_date DESC LIMIT ?';
const FIREFOX_BOOKMARKS = 'SELECT b.id AS id, b.parent AS parent, b.position AS position, b.type AS type, b.title AS title, CAST(b.dateAdded / 1000 AS INTEGER) AS added, b.guid AS guid, p.url AS url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.id LIMIT ?';
const FIREFOX_PERMISSIONS = "SELECT origin, type, CAST(permission AS INTEGER) AS permission FROM moz_perms WHERE expireType = 0 AND permission IN (1, 2) AND type IN ('camera', 'microphone', 'geo', 'desktop-notification', 'translations') ORDER BY id LIMIT ?";
const CHROMIUM_FAVICONS = 'SELECT DISTINCT b.id AS id, MAX(b.width, b.height) AS size FROM icon_mapping m JOIN favicons f ON f.id = m.icon_id JOIN favicon_bitmaps b ON b.icon_id = f.id WHERE (m.page_url = ? OR (m.page_url >= ? AND m.page_url < ?)) AND b.width >= 16 AND b.height >= 16 AND length(b.image_data) BETWEEN 1 AND ? ORDER BY size, b.id LIMIT ?';
const FIREFOX_FAVICONS = 'SELECT DISTINCT i.id AS id, i.width AS size FROM moz_pages_w_icons p JOIN moz_icons_to_pages m ON m.page_id = p.id JOIN moz_icons i ON i.id = m.icon_id WHERE (p.page_url = ? OR (p.page_url >= ? AND p.page_url < ?)) AND i.width >= 16 AND length(i.data) BETWEEN 1 AND ? ORDER BY size, i.id LIMIT ?';

function readFavicons(database: DatabaseSync, request: WorkerRequest): FaviconRow[] {
  if (!request.faviconOrigins?.length) return [];
  const origins = [...new Set(request.faviconOrigins)].filter(origin => isWebURL(origin) && new URL(origin).origin === origin).slice(0, 2000);
  const candidates = database.prepare(request.kind === 'chromium' ? CHROMIUM_FAVICONS : FIREFOX_FAVICONS);
  const bitmap = database.prepare(request.kind === 'chromium' ? 'SELECT image_data AS bytes FROM favicon_bitmaps WHERE id = ? AND length(image_data) <= ?' : 'SELECT data AS bytes FROM moz_icons WHERE id = ? AND length(data) <= ?');
  const result: FaviconRow[] = [];
  let scanned = 0, size = 0;
  for (const origin of origins) {
    if (scanned >= request.scan) break;
    // The cache decoder can reject corrupt raster payloads, so larger candidates remain available as fallbacks.
    let icon: FaviconRow | undefined;
    // Browser URLs are canonical; this exact origin prefix keeps scheme, port and neighboring hosts apart.
    for (const row of candidates.iterate(origin, `${origin}/`, `${origin}0`, FAVICON_LIMIT, request.scan - scanned)) {
      scanned++;
      const bytes = bitmap.get(row.id!, FAVICON_LIMIT)?.bytes;
      if (!(bytes instanceof Uint8Array) || !isRasterImage(Buffer.from(bytes))) continue;
      // Bound the worker transfer to the maximum size of the normalized 2,000-icon cache.
      if (size + bytes.byteLength > 2000 * 16 * 1024) break;
      if (!icon) { icon = { origin, bytes }; result.push(icon); }
      else (icon.alternatives ??= []).push(bytes);
      size += bytes.byteLength;
    }
  }
  return result;
}

function read(request: WorkerRequest): WorkerReply {
  const database = new DatabaseSync(request.database, { readOnly: true });
  try {
    const history = request.history ? database.prepare(request.kind === 'chromium' ? CHROMIUM : FIREFOX_HISTORY).all(request.scan) as unknown as HistoryRow[] : [];
    const bookmarks = request.bookmarks ? database.prepare(FIREFOX_BOOKMARKS).all(request.nodes) as unknown as MarkRow[] : [];
    const permissions = request.permissions ? database.prepare(FIREFOX_PERMISSIONS).all(request.scan) as unknown as PermissionRow[] : [];
    return { ok: true, history, bookmarks, permissions, favicons: readFavicons(database, request) };
  } finally { database.close(); }
}

let reply: WorkerReply;
try { reply = read(workerData as WorkerRequest); } catch { reply = { ok: false }; }
parentPort?.postMessage(reply);
