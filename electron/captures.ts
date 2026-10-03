import type { WebContents } from 'electron';
import type { CaptureRect } from '../src/shared/api';
import { CAPTURE_LIMIT } from './notebooks';

export const SELECTION_WORLD = 1006;
export const SELECTION_CODE = 'String(getSelection())';
export const CAPTURE_DEADLINE = 10000;
export const PAGE_HEIGHT_LIMIT = 16384;
export function captureRectangle(rect: CaptureRect, zoom: number, bounds: { width: number; height: number }): CaptureRect {
  const x = Math.max(0, Math.min(bounds.width, Math.floor(rect.x * zoom)));
  const y = Math.max(0, Math.min(bounds.height, Math.floor(rect.y * zoom)));
  const right = Math.max(0, Math.min(bounds.width, Math.ceil((rect.x + rect.width) * zoom)));
  const bottom = Math.max(0, Math.min(bounds.height, Math.ceil((rect.y + rect.height) * zoom)));
  if (right - x < 8 || bottom - y < 8) throw new Error('CAPTURE_AREA_SMALL');
  return { x, y, width: right - x, height: bottom - y };
}
function deadline<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
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
export async function captureSelection(contents: WebContents): Promise<string> {
  const selection: unknown = await contents.executeJavaScriptInIsolatedWorld(SELECTION_WORLD, [{ code: SELECTION_CODE }]);
  if (typeof selection !== 'string') throw new Error('CAPTURE_FAILED');
  const text = selection.trim().slice(0, 100000);
  if (!text) throw new Error('NOTHING_SELECTED');
  return text;
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
