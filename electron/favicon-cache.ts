import { existsSync, unlinkSync } from 'node:fs';
import type { NativeImage } from 'electron';
import { FAVICON_LIMIT, isRasterImage } from './favicon';
import { validOrigin } from './site-settings';
import { encryptedStore, readStoreFile, writeStoreFile } from './store';
import type { StoreCipher } from './store';

export const FAVICON_CACHE_LIMIT = 2000;
export const FAVICON_CACHE_BYTES = 16 * 1024;
export const FAVICON_CACHE_SIZE = 32;
type Decode = (bytes: Buffer) => NativeImage;

export function clearFaviconCacheFile(path: string): void { if (existsSync(path)) unlinkSync(path); }

export function validateFaviconOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200 || !Array.from(value).every(validOrigin)) throw new Error('Invalid favorite favicon origins');
  return value as string[];
}

export function cacheFavicon(bytes: Uint8Array, decode: Decode): Buffer | null {
  if (!bytes.byteLength || bytes.byteLength > FAVICON_LIMIT) return null;
  const raster = Buffer.from(bytes);
  if (!isRasterImage(raster)) return null;
  try {
    let image = decode(raster);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1) return null;
    const ratio = Math.min(1, FAVICON_CACHE_SIZE / size.width, FAVICON_CACHE_SIZE / size.height);
    if (ratio < 1) image = image.resize({ width: Math.max(1, Math.floor(size.width * ratio)), height: Math.max(1, Math.floor(size.height * ratio)) });
    const png = image.toPNG();
    // The cache carries only freshly encoded PNGs, including when its source was another raster format.
    if (image.isEmpty() || image.getSize().width > FAVICON_CACHE_SIZE || image.getSize().height > FAVICON_CACHE_SIZE
      || png.length > FAVICON_CACHE_BYTES || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
    return png;
  } catch { return null; }
}

export function createFaviconCache(path: string, cipher: StoreCipher, decode: Decode, changed: () => void, privateWindow = false) {
  const icons = new Map<string, Buffer>();
  let version = 0, epoch = 0, disposed = false, dirty = false, memoryOnly = privateWindow;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(pending); pending = undefined;
    if (disposed || memoryOnly || !dirty) return;
    writeStoreFile(path, { version: 1, icons: [...icons].map(([origin, bytes]) => ({ origin, png: bytes.toString('base64') })) }, cipher);
    dirty = false;
  };
  const persist = () => {
    dirty = true;
    if (!pending && !memoryOnly) pending = setTimeout(() => { try { flush(); } catch { /* Optional icons stay usable in memory when storage is unavailable. */ } }, 500);
  };
  if (!privateWindow && existsSync(path)) {
    try {
      memoryOnly = !cipher.isEncryptionAvailable() && encryptedStore(path);
      if (!memoryOnly) {
        const stored = readStoreFile(path, cipher);
        if (!stored || typeof stored !== 'object' || !('version' in stored) || stored.version !== 1 || !('icons' in stored)
          || !Array.isArray(stored.icons) || stored.icons.length > FAVICON_CACHE_LIMIT) throw new Error('Invalid favicon cache');
        for (const entry of stored.icons) {
          if (!entry || typeof entry !== 'object' || !validOrigin(entry.origin) || typeof entry.png !== 'string'
            || entry.png.length > Math.ceil(FAVICON_CACHE_BYTES / 3) * 4) continue;
          const bytes = Buffer.from(entry.png, 'base64');
          const png = cacheFavicon(bytes, decode);
          if (png) icons.set(entry.origin, png);
        }
        if (!encryptedStore(path) && cipher.isEncryptionAvailable()) persist();
      }
    } catch { /* A missing or unreadable optional cache never blocks browsing. */ }
  }
  return {
    get version() { return version; },
    get epoch() { return epoch; },
    get(origins: string[]): Record<string, string> {
      const result: Record<string, string> = {};
      if (privateWindow || disposed) return result;
      for (const origin of validateFaviconOrigins(origins)) {
        const bytes = icons.get(origin);
        if (!bytes) continue;
        icons.delete(origin); icons.set(origin, bytes); persist();
        result[origin] = `data:image/png;base64,${bytes.toString('base64')}`;
      }
      return result;
    },
    put(origin: string, bytes: Uint8Array, generation = epoch): boolean {
      if (privateWindow || disposed || generation !== epoch || !validOrigin(origin)) return false;
      const png = cacheFavicon(bytes, decode);
      if (!png) return false;
      const previous = icons.get(origin);
      icons.delete(origin); icons.set(origin, png);
      while (icons.size > FAVICON_CACHE_LIMIT) icons.delete(icons.keys().next().value!);
      persist();
      if (!previous?.equals(png)) { version++; changed(); }
      return true;
    },
    clear() {
      if (privateWindow || disposed) return;
      clearTimeout(pending); pending = undefined; dirty = false; epoch++; icons.clear(); version++;
      try { clearFaviconCacheFile(path); } finally { changed(); }
    },
    flush,
    dispose() { clearTimeout(pending); pending = undefined; disposed = true; epoch++; icons.clear(); },
  };
}
