import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns';
import { readFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { FiltersEngine, Request, adsAndTrackingLists, adsLists } from '@ghostery/adblocker';
import type { ElectronRequestType } from '@ghostery/adblocker';
import { getDomain } from 'tldts-experimental';

export type BlockKind = 'ads' | 'trackers';
export interface BlockMatch { kind: BlockKind; redirectURL?: string }
export interface CosmeticMetrics { bytes: number; extractionMs: number; rules: number }
export const LIST_HOSTS = Object.freeze(['raw.githubusercontent.com'] as const);
export const LIST_TIMEOUT_MS = 30_000;
export const LIST_BYTES_LIMIT = 16 * 1024 * 1024;
const CACHE_BYTES_LIMIT = 128 * 1024 * 1024;
const CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAGIC = Buffer.from('HZAB0001');
const RESOURCE_URL = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
const LIST_URLS = Object.freeze([...new Set([...adsAndTrackingLists, RESOURCE_URL])]);
const ALLOWED_URLS = new Set(LIST_URLS);
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['2001::', 23], ['2002::', 16], ['64:ff9b::', 96],
  ['64:ff9b:1::', 48], ['100::', 64], ['2620:4f:8000::', 48], ['3fff::', 20], ['5f00::', 16], ['fec0::', 10],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv6');

export function assertListURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== LIST_HOSTS[0] || url.port || url.username || url.password || url.hash || !ALLOWED_URLS.has(url.href)) {
    throw new Error('FILTER_SOURCE_REFUSED');
  }
  return url;
}

export function isPublicListAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
    ?? (() => {
      const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (!hex) return undefined;
      const left = Number.parseInt(hex[1]!, 16), right = Number.parseInt(hex[2]!, 16);
      return `${left >> 8}.${left & 255}.${right >> 8}.${right & 255}`;
    })();
  const host = mapped ?? address;
  const family = isIP(host);
  return family !== 0 && !blockedAddresses.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

async function secureFetch(url: URL, signal: AbortSignal): Promise<Response> {
  return new Promise((accept, reject) => {
    const outgoing = httpsRequest(url, {
      method: 'GET', signal, rejectUnauthorized: true, family: 4,
      lookup: (host, options, callback) => {
        lookup(host, { all: true, verbatim: true }, (error, addresses) => {
          if (error) { callback(error, options.all ? [] : '', 4); return; }
          if (!addresses.length || addresses.some(entry => !isPublicListAddress(entry.address))) {
            callback(new Error('FILTER_ADDRESS_REFUSED'), options.all ? [] : '', 4); return;
          }
          const selected = addresses.find(entry => entry.family === 4);
          if (!selected) { callback(new Error('FILTER_ADDRESS_REFUSED'), options.all ? [] : '', 4); return; }
          if (options.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        });
      },
    }, incoming => {
      const status = incoming.statusCode ?? 500;
      if (status !== 200) {
        incoming.destroy();
        accept(new Response(null, { status: status >= 200 && status <= 599 ? status : 500 }));
        return;
      }
      const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      accept(new Response(body, { status, headers: incoming.headers as HeadersInit }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('FILTER_TIMEOUT'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('FILTER_TIMEOUT'));
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export async function downloadFilterList(
  value: string,
  transport: (url: URL, signal: AbortSignal) => Promise<Response> = secureFetch,
  cancelled?: AbortSignal,
): Promise<string> {
  const url = assertListURL(value);
  const signal = cancelled ? AbortSignal.any([cancelled, AbortSignal.timeout(LIST_TIMEOUT_MS)]) : AbortSignal.timeout(LIST_TIMEOUT_MS);
  const response = await raceAbort(transport(url, signal), signal);
  if (signal.aborted || response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > LIST_BYTES_LIMIT) {
    void response.body?.cancel().catch(() => undefined); throw new Error('FILTER_RESPONSE_REFUSED');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (signal.aborted) throw new Error('FILTER_TIMEOUT');
      if (done) break;
      size += value.byteLength;
      if (size > LIST_BYTES_LIMIT) throw new Error('FILTER_SIZE_LIMIT');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { try { reader.releaseLock(); } catch { /* Cancellation may still be settling. */ } }
  return Buffer.concat(chunks, size).toString('utf8');
}

function encodeCache(ads: FiltersEngine, full: FiltersEngine, updatedAt: number): Buffer {
  const left = Buffer.from(ads.serialize()), right = Buffer.from(full.serialize());
  const header = Buffer.alloc(24);
  CACHE_MAGIC.copy(header);
  header.writeDoubleBE(updatedAt, 8);
  header.writeUInt32BE(left.length, 16);
  header.writeUInt32BE(right.length, 20);
  const content = Buffer.concat([header, left, right]);
  if (content.length + 32 > CACHE_BYTES_LIMIT) throw new Error('FILTER_CACHE_SIZE_LIMIT');
  return Buffer.concat([content, createHash('sha256').update(content).digest()]);
}

function decodeCache(buffer: Buffer): { ads: FiltersEngine; full: FiltersEngine; updatedAt: number } {
  if (buffer.length < 56 || buffer.length > CACHE_BYTES_LIMIT || !buffer.subarray(0, 8).equals(CACHE_MAGIC)) throw new Error('FILTER_CACHE_INVALID');
  const updatedAt = buffer.readDoubleBE(8), adsSize = buffer.readUInt32BE(16), fullSize = buffer.readUInt32BE(20);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || updatedAt > Date.now() + CACHE_AGE_MS || 24 + adsSize + fullSize + 32 !== buffer.length) throw new Error('FILTER_CACHE_INVALID');
  const digest = createHash('sha256').update(buffer.subarray(0, -32)).digest();
  if (!digest.equals(buffer.subarray(-32))) throw new Error('FILTER_CACHE_INVALID');
  // The engine reads Uint32Array views, so each serialized slice needs an aligned backing buffer.
  const ads = FiltersEngine.deserialize(Uint8Array.from(buffer.subarray(24, 24 + adsSize)));
  const full = FiltersEngine.deserialize(Uint8Array.from(buffer.subarray(24 + adsSize, -32)));
  return { ads, full, updatedAt };
}

export function safeCosmeticCSS(styles: string): { css: string; rules: number } {
  const accepted: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of styles.matchAll(rule)) {
    const selector = match[1]!.trim(), declaration = match[2]!.trim();
    if (!selector || selector.includes('@') || /url\s*\(|image-set\s*\(|@import|@font-face|\\/i.test(match[0])) continue;
    // A fixed declaration makes filter-list CSS incapable of fetching a page resource.
    if (!/^display\s*:\s*none\s*!important\s*;?$/i.test(declaration)) continue;
    accepted.push(`${selector} { display: none !important; }`);
  }
  return { css: accepted.join('\n'), rules: accepted.length };
}

export interface BlockingEngineOptions {
  download?: (url: string, signal: AbortSignal) => Promise<string>;
  now?: () => number;
}

export function createBlockingEngine(userData: string, onReady: () => void = () => undefined, options: BlockingEngineOptions = {}) {
  const cachePath = resolve(userData, 'adblock', 'engines.bin');
  const download = options.download ?? ((url: string, signal: AbortSignal) => downloadFilterList(url, undefined, signal));
  const now = options.now ?? Date.now;
  let current: { ads: FiltersEngine; full: FiltersEngine; updatedAt: number } | undefined;
  let stopped = false;
  let refreshPromise: Promise<boolean> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  const refresh = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (refreshPromise) return refreshPromise;
    controller = new AbortController();
    refreshPromise = (async () => {
      try {
        const pairs = await Promise.all(LIST_URLS.map(async url => [url, await download(url, controller!.signal)] as const));
        if (stopped) return false;
        const lists = new Map(pairs);
        const ads = FiltersEngine.parse(adsLists.map(url => lists.get(url)!).join('\n'));
        const full = FiltersEngine.parse(adsAndTrackingLists.map(url => lists.get(url)!).join('\n'));
        if (!ads.getFilters().networkFilters.length || !full.getFilters().networkFilters.length) throw new Error('FILTER_LIST_INVALID');
        const resources = lists.get(RESOURCE_URL)!;
        ads.updateResources(resources, String(resources.length));
        full.updateResources(resources, String(resources.length));
        const updatedAt = now();
        const bytes = encodeCache(ads, full, updatedAt);
        await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
        const temporary = `${cachePath}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, cachePath); }
        finally { await unlink(temporary).catch(() => undefined); }
        if (stopped) return false;
        current = { ads, full, updatedAt };
        onReady();
        return true;
      } catch { controller?.abort(); return false; }
      finally { refreshPromise = undefined; controller = undefined; }
    })();
    return refreshPromise;
  };
  return {
    get ready() { return current !== undefined; },
    async start(): Promise<void> {
      if (started || stopped) return;
      started = true;
      try {
        if ((await stat(cachePath)).size <= CACHE_BYTES_LIMIT) {
          const cached = decodeCache(await readFile(cachePath));
          if (!stopped) { current = cached; onReady(); }
        }
      } catch { /* A missing or corrupt cache leaves pages unblocked until a new engine is built. */ }
      if (stopped) return;
      if (!current || now() - current.updatedAt >= CACHE_AGE_MS) void refresh();
      timer = setInterval(() => { if (!stopped && (!current || now() - current.updatedAt >= CACHE_AGE_MS)) void refresh(); }, 60 * 60 * 1000);
      timer.unref();
    },
    refresh,
    stop(): void { stopped = true; controller?.abort(); clearInterval(timer); },
    match(url: string, resourceType: ElectronRequestType, sourceURL: string): BlockMatch | undefined {
      if (!current || !/^(?:https?|wss?):\/\//i.test(url) || !/^https?:\/\//i.test(sourceURL)) return undefined;
      const request = Request.fromRawDetails({ url, type: resourceType, sourceUrl: sourceURL });
      const result = current.full.match(request);
      if (!result.match) return undefined;
      const kind: BlockKind = current.ads.match(request).match ? 'ads' : 'trackers';
      const redirect = result.redirect;
      if (redirect && ['text/plain', 'image/png', 'image/gif'].includes(redirect.contentType)
        && (redirect.contentType !== 'text/plain' || redirect.body.length === 0)
        && current.full.resources.resources.some(resource => resource.name === redirect.filename && resource.body === redirect.body && resource.contentType === redirect.contentType)
        && redirect.dataUrl.startsWith(`data:${redirect.contentType}`)) return { kind, redirectURL: redirect.dataUrl };
      return { kind };
    },
    cosmeticCSS(url: string): string {
      if (!current) return '';
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        const result = current.full.getCosmeticsFilters({ url, hostname: parsed.hostname, domain: getDomain(parsed.hostname),
          getBaseRules: false, getInjectionRules: false, getExtendedRules: false, getRulesFromDOM: false, getRulesFromHostname: true });
        return safeCosmeticCSS(result.styles).css;
      } catch { return ''; }
    },
    cosmeticMetrics(url: string): CosmeticMetrics {
      const began = performance.now();
      const css = this.cosmeticCSS(url);
      return { bytes: Buffer.byteLength(css), extractionMs: performance.now() - began, rules: safeCosmeticCSS(css).rules };
    },
  };
}
