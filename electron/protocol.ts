import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Protocol } from 'electron';
import { CONTENT_SECURITY_POLICY } from './security';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function serveHorizon(protocol: Protocol, directory: string): Promise<void> {
  const root = await realpath(directory);
  protocol.handle('horizon', async (request) => {
    const headers = {
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    };
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.protocol !== 'horizon:' || url.hostname !== 'app' || url.port || url.username || url.password || url.search) {
        return new Response(null, { status: 403, headers });
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0')) return new Response(null, { status: 403, headers });
      const file = await realpath(resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`));
      const local = relative(root, file);
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        return new Response(null, { status: 403, headers });
      }
      const extension = file.slice(file.lastIndexOf('.'));
      const contentType = MIME_TYPES[extension];
      if (!contentType) return new Response(null, { status: 403, headers });
      return new Response(new Uint8Array(await readFile(file)), { headers: { ...headers, 'Content-Type': contentType } });
    } catch {
      // Unknown resources reveal neither local paths nor filesystem errors.
      return new Response(null, { status: 404, headers });
    }
  });
}
