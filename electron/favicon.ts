import type { Session } from 'electron';
import { isIP } from 'node:net';
import { isWebURL } from './browsing';

export const FAVICON_LIMIT = 256 * 1024;
function publicIPv4(host: string): boolean {
  const [a = 0, b = 0] = host.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168);
}
export function isFaviconURL(value: unknown, pageURL?: string): value is string {
  if (!isWebURL(value)) return false;
  const hostname = new URL(value).hostname;
  if (pageURL && isWebURL(pageURL) && hostname === new URL(pageURL).hostname) return true;
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (/^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|home\.arpa)$/.test(host)) return false;
  const version = isIP(host);
  if (version === 4) return publicIPv4(host);
  if (version === 6) {
    const [left, right] = host.split('::');
    const start = left ? left.split(':') : [], end = right ? right.split(':') : [];
    const words = (right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]).map(word => parseInt(word, 16));
    if ((words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80) return false;
    if (words.slice(0, 5).every(word => word === 0)) {
      if (words[5] === 0) return false;
      if (words[5] === 0xffff) return publicIPv4(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`);
    }
  }
  return true;
}

// Raster signatures prevent SVG from ever reaching a decoder, even with a misleading MIME type.
export function isRasterImage(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    || bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))
    || bytes.subarray(0, 2).toString('ascii') === 'BM'
    || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
}
export async function readFavicon(response: Response): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > FAVICON_LIMIT || response.headers.get('content-type')?.toLowerCase().includes('svg')) {
    await response.body?.cancel(); throw new Error('Invalid favicon response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FAVICON_LIMIT) { await reader.cancel(); throw new Error('Favicon exceeds size limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size);
  if (!isRasterImage(bytes)) throw new Error('Invalid favicon format');
  return bytes;
}
export async function fetchFavicon(target: Pick<Session, 'fetch'>, candidates: string[], cancelled: AbortSignal, pageURL?: string): Promise<Buffer | null> {
  for (const candidate of candidates) {
    if (cancelled.aborted) return null;
    if (!isFaviconURL(candidate, pageURL)) continue;
    try {
      const signal = AbortSignal.any([cancelled, AbortSignal.timeout(5000)]);
      let url = candidate;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await target.fetch(url, { redirect: 'manual', signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) break;
          url = new URL(location, url).href;
          if (!isFaviconURL(url, pageURL)) break;
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); break; }
        const bytes = await readFavicon(response);
        // Untrusted raster bytes are decoded only by the sandboxed chrome renderer.
        return signal.aborted ? null : bytes;
      }
    } catch { /* Site icons are optional; the initial badge remains available. */ }
  }
  return null;
}
