import type { WebContents } from 'electron';
import { CAPTURE_LIMIT } from './desktop';

export const CAPTURE_DEADLINE = 10000;
export const PAGE_HEIGHT_LIMIT = 16384;
export function deadline<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(new Error('CAPTURE_CHANGED'));
    const timer = setTimeout(() => fail(new Error('CAPTURE_TIMEOUT')), CAPTURE_DEADLINE);
    signal?.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, fail);
    if (signal?.aborted) abort();
  });
}
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length > CAPTURE_LIMIT) throw new Error('CAPTURE_TOO_LARGE');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('CAPTURE_FAILED');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 100000 || height > 100000) throw new Error('CAPTURE_TOO_LARGE');
  return { width, height };
}
export async function captureWholePage(contents: WebContents, visible: boolean, deviceScale: number, check: () => void, signal?: AbortSignal) {
  if (!visible) throw new Error('CAPTURE_PAGE_HIDDEN');
  const debuggerAPI = contents.debugger;
  let attached = false;
  try {
    check(); debuggerAPI.attach('1.3'); attached = true;
    const metrics = await deadline(debuggerAPI.sendCommand('Page.getLayoutMetrics'), signal);
    check();
    const width: unknown = metrics.cssLayoutViewport?.clientWidth, height: unknown = metrics.cssContentSize?.height;
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > 100000
      || typeof height !== 'number' || !Number.isFinite(height) || height <= 0
      || !Number.isFinite(deviceScale) || deviceScale <= 0) throw new Error('CAPTURE_FAILED');
    const maximum = Math.floor(PAGE_HEIGHT_LIMIT / deviceScale), cut = height > maximum;
    if (maximum < 1) throw new Error('CAPTURE_TOO_LARGE');
    const result = await deadline(debuggerAPI.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(height, maximum), scale: 1 },
    }), signal);
    check();
    if (typeof result.data !== 'string') throw new Error('CAPTURE_FAILED');
    if (result.data.length > Math.ceil(CAPTURE_LIMIT / 3) * 4) throw new Error('CAPTURE_TOO_LARGE');
    const bytes = Buffer.from(result.data, 'base64'), size = pngSize(bytes);
    if (size.height > PAGE_HEIGHT_LIMIT) throw new Error('CAPTURE_TOO_LARGE');
    return { bytes, image: { ...size, cut } };
  } finally {
    if (attached) try { debuggerAPI.detach(); } catch { /* Navigation or closure may already have detached it. */ }
  }
}
