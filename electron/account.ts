import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { AccountState, Language } from '../src/shared/api';
import type { StoreCipher } from './store';
import { vaultTokenStore } from './vault-storage';

interface Options {
  directory: string; userData: string; cipher: StoreCipher; isPackaged: boolean; env?: NodeJS.ProcessEnv;
  language(): Language; changed(): void; openExternal(url: string): Promise<void>; fetch: typeof globalThis.fetch;
}
interface Tokens { accessToken: string; refreshToken: string; tokenType: 'Bearer'; expiresIn: number; deviceId: string }
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const errorCodes = new Set(['ACCOUNT_NETWORK', 'ACCOUNT_TIMEOUT', 'ACCOUNT_DENIED', 'ACCOUNT_INVALID_RESPONSE', 'ACCOUNT_STORAGE']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorCode = (error: unknown) => error instanceof Error && errorCodes.has(error.message) ? error.message : 'ACCOUNT_NETWORK';
export function createPKCE() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
export function accountEndpoints(packaged: boolean, env: NodeJS.ProcessEnv = process.env) {
  const endpoint = (value: string | undefined, fallback: string) => {
    if (packaged || value === undefined) return fallback;
    try {
      const local = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]+)\/?$/.exec(value);
      if (!/^https:\/\/[^/?#@\\\s]+\/?$/.test(value) && !(local && Number(local[1]) > 0)) throw new Error();
      const url = new URL(value);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { throw new Error('ACCOUNT_INVALID_RESPONSE'); }
  };
  return { api: endpoint(env.HORIZON_QUANTUM_API, 'https://quantum.txmska.com'), site: endpoint(env.HORIZON_QUANTUM_SITE, 'https://cosmic.txmska.com') };
}
export function validateAccountTokens(value: unknown): Tokens {
  if (!record(value) || Object.keys(value).length !== 5 || !['accessToken', 'refreshToken', 'tokenType', 'expiresIn', 'deviceId'].every(key => Object.hasOwn(value, key))
    || typeof value.accessToken !== 'string' || !tokenPattern.test(value.accessToken) || typeof value.refreshToken !== 'string' || !tokenPattern.test(value.refreshToken)
    || value.tokenType !== 'Bearer' || typeof value.expiresIn !== 'number' || !Number.isFinite(value.expiresIn) || value.expiresIn <= 0
    || !Number.isFinite(Date.now() + value.expiresIn * 1000) || typeof value.deviceId !== 'string') throw new Error('ACCOUNT_INVALID_RESPONSE');
  return value as unknown as Tokens;
}
function accountCard(value: unknown): AccountState {
  if (!record(value) || typeof value.email !== 'string') throw new Error('ACCOUNT_INVALID_RESPONSE');
  const displayName = typeof value.displayName === 'string' && value.displayName.trim() === value.displayName && value.displayName.length > 0
    && value.displayName.length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(value.displayName) ? value.displayName : null;
  const plans = Array.isArray(value.plans) ? value.plans.filter((plan: unknown): plan is Record<'key' | 'product' | 'tier' | 'label', string> => record(plan)
    && ['key', 'product', 'tier', 'label'].every(key => typeof plan[key] === 'string' && (plan[key] as string).trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(plan[key] as string))) : [];
  return { status: 'signedIn', email: value.email, displayName, plan: plans[0]?.label ?? null };
}
function installationId(userData: string): string {
  const path = resolve(userData, 'account-computer-id');
  try {
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    try { writeFileSync(path, randomUUID(), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw new Error();
    const id = readFileSync(path, 'utf8');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error();
    return id;
  } catch { throw new Error('ACCOUNT_STORAGE'); }
}
export function createAccount(options: Options) {
  const path = resolve(options.directory, 'account.sealed'), tokens = vaultTokenStore(path, options.cipher);
  let state: AccountState = { status: 'signedOut' }, access: { token: string; expires: number } | undefined;
  let generation = 0, closed = false, checking: Promise<void> | undefined;
  let attempt: { server: Server; url: string; timer: ReturnType<typeof setTimeout>; used: boolean } | undefined;
  const requests = new Set<AbortController>();
  const publish = (next: AccountState) => { state = next; if (!closed) options.changed(); };
  const check = (ticket: number) => { if (closed || ticket !== generation) throw new Error('ACCOUNT_DENIED'); };
  const stopAttempt = () => { if (attempt) { clearTimeout(attempt.timer); attempt.server.close(); attempt.server.closeAllConnections(); attempt = undefined; } };
  const invalidate = () => { generation++; checking = undefined; stopAttempt(); for (const controller of requests) controller.abort(); requests.clear(); };
  const fail = (error: unknown, ticket: number) => { if (!closed && ticket === generation) { stopAttempt(); publish({ status: 'error', code: errorCode(error) }); } };
  const readToken = async () => {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
      return await tokens.get();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new Error('ACCOUNT_STORAGE');
    }
  };
  const removeToken = () => {
    try { unlinkSync(path); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('ACCOUNT_STORAGE'); }
  };
  const request = async (route: string, method: 'GET' | 'POST', ticket: number, body?: unknown, bearer?: string) => {
    check(ticket);
    const controller = new AbortController(); requests.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000); timer.unref?.();
    try {
      const { api } = accountEndpoints(options.isPackaged, options.env);
      const response = await options.fetch(`${api}${route}`, { method, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      check(ticket);
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('ACCOUNT_INVALID_RESPONSE'); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) { await reader.cancel(); throw new Error('ACCOUNT_INVALID_RESPONSE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      check(ticket);
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { if (response.ok) throw new Error('ACCOUNT_INVALID_RESPONSE'); }
      return { status: response.status, ok: response.ok, value };
    } catch (error) { throw new Error(timedOut ? 'ACCOUNT_TIMEOUT' : errorCode(error)); }
    finally { clearTimeout(timer); requests.delete(controller); }
  };
  const requireSuccess = (response: { status: number; ok: boolean }) => {
    if (!response.ok) throw new Error([400, 401, 403].includes(response.status) ? 'ACCOUNT_DENIED' : 'ACCOUNT_NETWORK');
  };
  const saveTokens = async (value: unknown, ticket: number) => {
    const validated = validateAccountTokens(value); check(ticket);
    try { await tokens.set(validated.refreshToken); } catch { throw new Error('ACCOUNT_STORAGE'); }
    check(ticket); access = { token: validated.accessToken, expires: Date.now() + validated.expiresIn * 1000 };
    return access.token;
  };
  const refresh = async (ticket: number): Promise<string | undefined> => {
    const refreshToken = await readToken(); check(ticket);
    if (!refreshToken) { access = undefined; publish({ status: 'signedOut' }); return; }
    const response = await request('/v1/oauth/token', 'POST', ticket, { grantType: 'refresh_token', refreshToken, appId: 'horizon' });
    if (!response.ok && record(response.value) && record(response.value.error) && response.value.error.code === 'invalid_grant') {
      access = undefined; removeToken(); publish({ status: 'signedOut' }); return;
    }
    requireSuccess(response); return saveTokens(response.value, ticket);
  };
  const loadMe = async (ticket: number) => {
    let bearer = access && access.expires > Date.now() ? access.token : await refresh(ticket);
    if (!bearer) return;
    let response = await request('/v1/me', 'GET', ticket, undefined, bearer);
    if (response.status === 401) {
      access = undefined; bearer = await refresh(ticket);
      if (!bearer) return;
      response = await request('/v1/me', 'GET', ticket, undefined, bearer);
    }
    requireSuccess(response); check(ticket); publish(accountCard(response.value));
  };
  const me = (): Promise<void> => {
    if (closed || attempt) return Promise.resolve();
    if (checking) return checking;
    const ticket = generation;
    const work = loadMe(ticket).catch(error => { fail(error, ticket); throw new Error(errorCode(error)); }).finally(() => { if (checking === work) checking = undefined; });
    checking = work; return work;
  };
  const open = async (url: string) => { try { await options.openExternal(url); } catch { throw new Error('ACCOUNT_NETWORK'); } };
  const cancel = () => { invalidate(); access = undefined; publish({ status: 'signedOut' }); };
  return {
    state: (): AccountState => ({ ...state }), me, retry: me, cancel,
    async signIn() {
      if (closed) throw new Error('ACCOUNT_DENIED');
      if (attempt) return;
      invalidate(); access = undefined; const ticket = generation;
      publish({ status: 'signingIn' });
      try {
        const { site } = accountEndpoints(options.isPackaged, options.env), pkce = createPKCE(), computerId = installationId(options.userData);
        const deviceName = hostname().replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 128).trim() || 'Horizon';
        const server = createServer({ requestTimeout: 20000, headersTimeout: 20000, maxHeaderSize: 8192 }, (req, res) => {
          const match = /^\/callback\?code=([A-Za-z0-9_-]{43})$/.exec(req.url ?? ''), current = attempt;
          if (!current || current.server !== server || current.used || req.method !== 'GET' || !match || req.headers.host !== `127.0.0.1:${(server.address() as { port: number } | null)?.port}`) {
            res.writeHead(404, { Connection: 'close' }); res.end(); return;
          }
          current.used = true;
          const language = options.language(), message = language === 'es' ? 'Sesión iniciada. Se puede volver a Horizon.' : 'Signed in. Return to Horizon.';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
          res.end(`<!doctype html><html lang="${language}"><meta charset="utf-8"><title>Horizon</title><p>${message}</p></html>`);
          server.close();
          void (async () => {
            const response = await request('/v1/oauth/token', 'POST', ticket, { grantType: 'authorization_code', code: match[1], codeVerifier: pkce.verifier, redirectUri, appId: 'horizon' });
            requireSuccess(response); await saveTokens(response.value, ticket); await loadMe(ticket);
            check(ticket); stopAttempt();
          })().catch(error => fail(error, ticket));
        });
        server.on('connect', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
        server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
        server.setTimeout(20000, socket => socket.destroy()); server.unref();
        const timer = setTimeout(() => { if (ticket === generation) { invalidate(); access = undefined; publish({ status: 'error', code: 'ACCOUNT_TIMEOUT' }); } }, 600000); timer.unref?.();
        attempt = { server, url: '', timer, used: false };
        await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); if (closed || ticket !== generation) { server.close(); server.closeAllConnections(); } done(); }); });
        server.on('error', () => fail(new Error('ACCOUNT_NETWORK'), ticket));
        check(ticket);
        const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
        const url = new URL(`${site}/authorize`);
        url.search = new URLSearchParams({ appId: 'horizon', redirectUri, codeChallenge: pkce.challenge, computerId, deviceName }).toString();
        attempt!.url = url.href; await open(url.href);
      } catch (error) { fail(error, ticket); throw new Error(errorCode(error)); }
    },
    async reopen() {
      if (!attempt?.url || attempt.used) return;
      const ticket = generation;
      try { await open(attempt.url); } catch (error) { fail(error, ticket); throw error; }
    },
    async signOut() {
      const bearer = access && access.expires > Date.now() ? access.token : undefined;
      invalidate(); access = undefined; const ticket = generation;
      let refreshToken: string | undefined;
      try {
        try { refreshToken = await readToken(); } catch { /* Local deletion must work without the keyring. */ }
        check(ticket); removeToken(); publish({ status: 'signedOut' });
      } catch (error) { fail(error, ticket); throw new Error(errorCode(error)); }
      try {
        let token = bearer, refreshed = false;
        const refreshForRevoke = async () => {
          if (!refreshToken) return;
          const response = await request('/v1/oauth/token', 'POST', ticket, { grantType: 'refresh_token', refreshToken, appId: 'horizon' });
          requireSuccess(response); refreshed = true; return validateAccountTokens(response.value).accessToken;
        };
        if (!token) token = await refreshForRevoke();
        if (token) {
          const response = await request('/v1/oauth/revoke', 'POST', ticket, undefined, token);
          if (response.status === 401 && !refreshed) { token = await refreshForRevoke(); if (token) await request('/v1/oauth/revoke', 'POST', ticket, undefined, token); }
        }
      } catch { /* Revocation cannot prevent local sign-out. */ }
    },
    async manage() {
      const ticket = generation;
      try { await open(`${accountEndpoints(options.isPackaged, options.env).site}/`); }
      catch (error) { fail(error, ticket); throw new Error(errorCode(error)); }
    },
    close() { closed = true; invalidate(); access = undefined; state = { status: 'signedOut' }; },
  };
}
