import { createHash, createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { crc32, inflateRawSync } from 'node:zlib';
import { extensionId } from './extension-policy';

const nativeFetch = globalThis.fetch;
const CRX_LIMIT = 64 * 1024 * 1024;
export function verifyStoreZIP(bytes: Buffer): void {
  const reject = () => { throw new Error('EXTENSION_INSTALL_FAILED'); };
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return reject();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), centralSize = bytes.readUInt32LE(end + 12);
  if (!count || count > 4096 || bytes.readUInt16LE(end + 8) !== count || start + centralSize !== end) return reject();
  let position = start, expanded = 0;
  const names = new Set<string>(), ranges: [number, number][] = [];
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) return reject();
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10), checksum = bytes.readUInt32LE(position + 16);
    const compressed = bytes.readUInt32LE(position + 20), size = bytes.readUInt32LE(position + 24), nameSize = bytes.readUInt16LE(position + 28);
    const extraSize = bytes.readUInt16LE(position + 30), commentSize = bytes.readUInt16LE(position + 32), mode = bytes.readUInt32LE(position + 38) >>> 16, local = bytes.readUInt32LE(position + 42);
    const next = position + 46 + nameSize + extraSize + commentSize;
    if (next > end || flags & 0x41 || ![0, 8].includes(method) || size > 32 * 1024 * 1024 || (expanded += size) > 256 * 1024 * 1024 || bytes.readUInt16LE(position + 34)) return reject();
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameSize), name = nameBytes.toString('utf8'), parts = name.replace(/\/$/, '').split('/');
    if (name.toLowerCase() === 'manifest.json' && size > 1024 * 1024) return reject();
    if (!name || name.length > 1024 || !Buffer.from(name, 'utf8').equals(nameBytes) || /[\\:\x00-\x1f\x7f]/.test(name) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) return reject();
    const canonical = name.normalize('NFC').toLowerCase().replace(/\/$/, '');
    if (names.has(canonical) || mode & 0o7000 || ![0, 0o100000, 0o40000].includes(mode & 0o170000)) return reject();
    names.add(canonical);
    for (let extra = position + 46 + nameSize; extra < position + 46 + nameSize + extraSize;) {
      if (extra + 4 > position + 46 + nameSize + extraSize) return reject();
      const tag = bytes.readUInt16LE(extra), length = bytes.readUInt16LE(extra + 2);
      // Alternate Unicode names and ZIP64 can disagree with the pinned extractor's path and size interpretation.
      if (tag === 0x7075 || tag === 1) return reject();
      extra += 4 + length; if (extra > position + 46 + nameSize + extraSize) return reject();
    }
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameSize) return reject();
    const data = local + 30 + nameSize + bytes.readUInt16LE(local + 28), limit = data + compressed;
    if (limit > start || !bytes.subarray(local + 30, local + 30 + nameSize).equals(nameBytes)) return reject();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== checksum || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) return reject();
    if (flags & 8 && [[14, checksum], [18, compressed], [22, size]].some(([field, expected]) => bytes.readUInt32LE(local + field!) !== 0 && bytes.readUInt32LE(local + field!) !== expected)) return reject();
    if (name.endsWith('/') && size) return reject();
    const content = bytes.subarray(data, limit), actual = method === 8 ? inflateRawSync(content, { maxOutputLength: Math.max(1, size) }) : content;
    if (actual.length !== size || crc32(actual) !== checksum) return reject();
    ranges.push([local, limit]); position = next;
  }
  if (position !== end) return reject();
  ranges.sort((left, right) => left[0] - right[0]);
  if (ranges.some((range, index) => index && range[0] < ranges[index - 1]![1])) return reject();
}
export function allowedStoreDownload(value: string, archive: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (archive) return url.hostname === 'clients2.google.com' && url.pathname === '/service/update2/crx'
      || url.hostname === 'clients2.googleusercontent.com' && url.pathname.startsWith('/crx/');
    return ['googleusercontent.com', 'gstatic.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
function fields(bytes: Buffer): Map<number, Buffer[]> {
  const result = new Map<number, Buffer[]>();
  let position = 0;
  const integer = () => {
    let value = 0;
    for (let count = 0; count < 5 && position < bytes.length; count++) {
      const byte = bytes[position++]!; value += (byte & 127) * 2 ** (count * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('EXTENSION_INSTALL_FAILED');
  };
  while (position < bytes.length) {
    const tag = integer(), wire = tag & 7, field = Math.floor(tag / 8);
    if (!field) throw new Error('EXTENSION_INSTALL_FAILED');
    if (wire === 0) integer();
    else if (wire === 2) {
      const length = integer(), end = position + length;
      if (end > bytes.length) throw new Error('EXTENSION_INSTALL_FAILED');
      result.set(field, [...(result.get(field) ?? []), bytes.subarray(position, end)]); position = end;
    } else if (wire === 1 || wire === 5) position += wire === 1 ? 8 : 4;
    else throw new Error('EXTENSION_INSTALL_FAILED');
    if (position > bytes.length) throw new Error('EXTENSION_INSTALL_FAILED');
  }
  return result;
}
export function verifyStoreArchive(bytes: Buffer, id: string): void {
  if (!extensionId(id) || bytes.length < 12 || bytes.length > CRX_LIMIT || bytes.toString('ascii', 0, 4) !== 'Cr24' || bytes.readUInt32LE(4) !== 3) throw new Error('EXTENSION_INSTALL_FAILED');
  const length = bytes.readUInt32LE(8);
  if (length > 1024 * 1024 || length >= bytes.length - 12) throw new Error('EXTENSION_INSTALL_FAILED');
  const header = fields(bytes.subarray(12, 12 + length)), signedHeaders = header.get(10000);
  if (signedHeaders?.length !== 1) throw new Error('EXTENSION_INSTALL_FAILED');
  const signed = signedHeaders[0]!, declared = fields(signed).get(1);
  const keyId = (key: Buffer) => createHash('sha256').update(key).digest().subarray(0, 16);
  const asId = (value: Buffer) => value.toString('hex').replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  if (declared?.length !== 1 || declared[0]!.length !== 16 || asId(declared[0]!) !== id) throw new Error('EXTENSION_INSTALL_FAILED');
  const size = Buffer.alloc(4); size.writeUInt32LE(signed.length);
  const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signed, bytes.subarray(12 + length)]);
  // The package matches the key to the id but does not verify its proof. Reject altered archives before it unpacks executable code.
  for (const proof of header.get(2) ?? []) {
    const values = fields(proof), keys = values.get(1), signatures = values.get(2);
    if (keys?.length !== 1 || signatures?.length !== 1 || !keyId(keys[0]!).equals(declared[0]!)) continue;
    try { if (verify('sha256', payload, createPublicKey({ key: keys[0]!, format: 'der', type: 'spki' }), signatures[0]!)) return; }
    catch { /* A malformed proof cannot establish the requested publisher. */ }
  }
  throw new Error('EXTENSION_INSTALL_FAILED');
}
export async function storeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const initial = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (init?.method && init.method !== 'GET') throw new Error('EXTENSION_INSTALL_FAILED');
  const archive = initial.hostname === 'clients2.google.com', id = new URLSearchParams(initial.searchParams.get('x') ?? '').get('id');
  if (archive && !extensionId(id)) throw new Error('EXTENSION_INSTALL_FAILED');
  const signal = AbortSignal.any([AbortSignal.timeout(45000), ...(init?.signal ? [init.signal] : [])]);
  let url = initial.href;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!allowedStoreDownload(url, archive)) throw new Error('EXTENSION_INSTALL_FAILED');
    const response = await nativeFetch(url, { method: 'GET', redirect: 'manual', signal, credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('EXTENSION_INSTALL_FAILED');
      url = new URL(location, url).href; continue;
    }
    const maximum = archive ? CRX_LIMIT : 1024 * 1024;
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('EXTENSION_INSTALL_FAILED'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maximum) { await reader.cancel(); throw new Error('EXTENSION_INSTALL_FAILED'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, size);
    if (archive) { verifyStoreArchive(bytes, id!); verifyStoreZIP(bytes.subarray(12 + bytes.readUInt32LE(8))); }
    return new Response(bytes, { status: 200, headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(size) } });
  }
  throw new Error('EXTENSION_INSTALL_FAILED');
}
function guardedPackage(): typeof import('electron-chrome-web-store') {
  // Its module captures fetch synchronously. Lend only that module the bounded downloader, then restore the process default.
  globalThis.fetch = storeFetch;
  try { return createRequire(__filename)('./web-store.cjs') as typeof import('electron-chrome-web-store'); }
  finally { globalThis.fetch = nativeFetch; }
}
export const store = guardedPackage();
