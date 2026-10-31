import { resolve } from 'node:path';
import type { StoreCipher } from './store';
import { readVaultFile, writeVaultFile } from './vault-storage';
import { fetchQuantumChanges } from './sync-quantum';
import type { QuantumAccount, QuantumChangePage } from './sync-quantum';

type Listener = (page: QuantumChangePage | null) => Promise<void>;
interface Connection { account: QuantumAccount; directory: string; cipher: StoreCipher; listener: Listener; rebuild?: Promise<boolean>; ready?: boolean }
interface Feed {
  connections: Set<Connection>; controller: AbortController; cursor?: string; ready: boolean; running: boolean;
  persisted: Map<string, { cursor: string; at: number }>; bootstraps: Map<string, Promise<void>>;
}
const feeds = new Map<string, Feed>();

function active(feed: Feed, entry: Connection): boolean {
  if (!feed.connections.has(entry)) return false;
  try { entry.account.assertActive(); return true; }
  catch { feed.connections.delete(entry); return false; }
}
function liveConnections(feed: Feed): Connection[] {
  return [...feed.connections].filter(entry => active(feed, entry));
}
async function deliver(feed: Feed, entries: Connection[], page: QuantumChangePage | null): Promise<Connection[]> {
  const delivered: Connection[] = [];
  for (const entry of entries) if (active(feed, entry)) {
    if (!await startRebuild(feed, entry)) continue;
    try { if (active(feed, entry)) { await entry.listener(page); delivered.push(entry); } }
    catch (error) { if (active(feed, entry)) throw error; }
  }
  return delivered;
}

async function rebuild(feed: Feed, entry: Connection): Promise<void> {
  let pending = feed.bootstraps.get(entry.directory);
  if (!pending) {
    pending = (async () => {
      const bootstrap = await entry.account.request('/v1/bootstrap?limit=200', { signal: feed.controller.signal });
      if (!bootstrap.ok) throw new Error('SYNC_STORAGE');
      const value: unknown = await bootstrap.json();
      if (!value || typeof value !== 'object' || !('accountId' in value) || value.accountId !== entry.account.accountId) throw new Error('SYNC_INVALID');
    })();
    feed.bootstraps.set(entry.directory, pending);
    void pending.catch(() => { if (feed.bootstraps.get(entry.directory) === pending) feed.bootstraps.delete(entry.directory); });
  }
  await pending;
  if (active(feed, entry)) await entry.listener(null);
}

function startRebuild(feed: Feed, entry: Connection): Promise<boolean> {
  if (entry.rebuild) return entry.rebuild;
  if (entry.ready) return Promise.resolve(true);
  const pending = rebuild(feed, entry).then(() => {
    entry.ready = active(feed, entry); return entry.ready;
  }, () => false).finally(() => { if (entry.rebuild === pending) entry.rebuild = undefined; });
  entry.rebuild = pending;
  return pending;
}

// Profiles using the same canonical account share the contract's single aggregate hold.
export function subscribeQuantumChanges(connection: Connection): () => void {
  const id = connection.account.accountId;
  let feed = feeds.get(id);
  if (!feed) {
    feed = { connections: new Set(), controller: new AbortController(), ready: false, running: false, persisted: new Map(), bootstraps: new Map() };
    feeds.set(id, feed);
  }
  feed.connections.add(connection);
  const current = feed;
  // The aggregate cursor was captured before this subscriber's listings. Its first
  // rebuild can start immediately without waiting for the account's held read.
  if (current.ready) void startRebuild(current, connection);
  if (!current.running) { current.running = true; void run(id, current); }
  return () => {
    current.connections.delete(connection);
    if (!current.connections.size) { current.controller.abort(); if (feeds.get(id) === current) feeds.delete(id); }
  };
}

async function run(id: string, feed: Feed): Promise<void> {
  const signal = feed.controller.signal;
  let initialized = false;
  let emptyDelay = 0;
  while (!signal.aborted) {
    const source = liveConnections(feed)[0];
    if (!source) { feed.controller.abort(); if (feeds.get(id) === feed) feeds.delete(id); return; }
    let delay = 0;
    try {
      source.account.assertActive();
      if (!initialized) {
        let stored: unknown;
        // The cursor is disposable; the captured feed and listings recover its history.
        try { stored = readVaultFile(resolve(source.directory, 'quantum-changes.sealed'), source.cipher); }
        catch { feed.cursor = undefined; }
        if (stored && typeof stored === 'object' && 'accountId' in stored && stored.accountId === id && 'cursor' in stored
          && typeof stored.cursor === 'string' && stored.cursor.length > 0 && stored.cursor.length <= 255) {
          feed.cursor = stored.cursor; feed.persisted.set(source.directory, { cursor: stored.cursor, at: Date.now() });
        }
        initialized = true;
      }
      // Capture a cursor before rebuilding so writes during the listings remain in the next page.
      let page = await fetchQuantumChanges(source.account, feed.cursor, signal);
      let changed = page.changes.length + (page.skippedChanges ?? 0) > 0;
      if (signal.aborted) return;
      source.account.assertActive();
      let delivered = liveConnections(feed);
      if (!feed.ready) {
        while (page.changes.length + (page.skippedChanges ?? 0) === 1000) {
          page = await fetchQuantumChanges(source.account, page.cursor, signal);
          changed ||= page.changes.length + (page.skippedChanges ?? 0) > 0;
        }
        delivered = liveConnections(feed);
        // Capture the current cursor before each snapshot, including restored subscriptions.
        for (const entry of delivered) { await entry.rebuild; entry.ready = false; }
        for (const entry of delivered) await startRebuild(feed, entry);
        feed.ready = true;
        for (const entry of liveConnections(feed)) if (!delivered.includes(entry)) void startRebuild(feed, entry);
        // Listings already include history through the captured cursor; replay only later mutations.
        page = { ...page, changes: [] };
      }
      delivered = await deliver(feed, delivered, page);
      feed.cursor = page.cursor;
      for (const entry of delivered) {
        const stored = feed.persisted.get(entry.directory);
        // Empty holds reseal the same position with fresh opaque cursor strings.
        if (!active(feed, entry) || stored?.cursor === page.cursor || stored && !changed && Date.now() - stored.at < 10 * 60 * 1000) continue;
        try {
          writeVaultFile(resolve(entry.directory, 'quantum-changes.sealed'), { accountId: id, cursor: page.cursor }, entry.cipher);
          feed.persisted.set(entry.directory, { cursor: page.cursor, at: Date.now() });
        } catch { feed.persisted.delete(entry.directory); }
      }
      if (!page.changes.length && page.retryAfterMs > 0) {
        emptyDelay = Math.min(60000, Math.max(3000, emptyDelay * 2));
        delay = Math.max(emptyDelay, page.retryAfterMs);
      } else { emptyDelay = 0; delay = page.retryAfterMs; }
    } catch (error) {
      if (signal.aborted) return;
      try { source.account.assertActive(); }
      catch { feed.connections.delete(source); continue; }
      if (error && typeof error === 'object' && 'bootstrap' in error && error.bootstrap === true) {
        feed.cursor = undefined; feed.ready = false; feed.bootstraps.clear(); continue;
      }
      delay = error && typeof error === 'object' && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' ? Math.max(3000, error.retryAfterMs) : 60000;
    }
    if (delay > 0) await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
      const timer = setTimeout(finish, delay); timer.unref?.(); signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
