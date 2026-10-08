import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

export interface WorkerRequest { database: string; kind: 'chromium' | 'firefox'; bookmarks: boolean; history: boolean; permissions: boolean; scan: number; nodes: number }
export interface HistoryRow { url: string; title: string; visits: number; last: number }
export interface MarkRow { id: number; parent: number; position: number; type: number; title: string | null; added: number; guid: string; url: string | null }
export interface PermissionRow { origin: string; type: string; permission: number }
export type WorkerReply = { ok: true; history: HistoryRow[]; bookmarks: MarkRow[]; permissions: PermissionRow[] } | { ok: false };

// Both browsers count in microseconds from their own epoch, which overflows a double, so SQLite converts to milliseconds.
const CHROMIUM = 'SELECT url, title, CAST(MIN(visit_count, 1000000) AS INTEGER) AS visits, CAST(last_visit_time / 1000 - 11644473600000 AS INTEGER) AS last FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?';
const FIREFOX_HISTORY = 'SELECT url, title, CAST(MIN(visit_count, 1000000) AS INTEGER) AS visits, CAST(last_visit_date / 1000 AS INTEGER) AS last FROM moz_places WHERE hidden = 0 AND last_visit_date > 0 ORDER BY last_visit_date DESC LIMIT ?';
const FIREFOX_BOOKMARKS = 'SELECT b.id AS id, b.parent AS parent, b.position AS position, b.type AS type, b.title AS title, CAST(b.dateAdded / 1000 AS INTEGER) AS added, b.guid AS guid, p.url AS url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.id LIMIT ?';
const FIREFOX_PERMISSIONS = "SELECT origin, type, CAST(permission AS INTEGER) AS permission FROM moz_perms WHERE expireType = 0 AND permission IN (1, 2) AND type IN ('camera', 'microphone', 'geo', 'desktop-notification', 'translations') ORDER BY id LIMIT ?";

function read(request: WorkerRequest): WorkerReply {
  const database = new DatabaseSync(request.database, { readOnly: true });
  try {
    const history = request.history ? database.prepare(request.kind === 'chromium' ? CHROMIUM : FIREFOX_HISTORY).all(request.scan) as unknown as HistoryRow[] : [];
    const bookmarks = request.bookmarks ? database.prepare(FIREFOX_BOOKMARKS).all(request.nodes) as unknown as MarkRow[] : [];
    const permissions = request.permissions ? database.prepare(FIREFOX_PERMISSIONS).all(request.scan) as unknown as PermissionRow[] : [];
    return { ok: true, history, bookmarks, permissions };
  } finally { database.close(); }
}

let reply: WorkerReply;
try { reply = read(workerData as WorkerRequest); } catch { reply = { ok: false }; }
parentPort?.postMessage(reply);
