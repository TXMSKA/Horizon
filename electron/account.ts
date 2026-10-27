import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { AccountState, Language } from '../src/shared/api';
import type { StoreCipher } from './store';
import { vaultTokenStore } from './vault-storage';
import { cosmicRoot } from './send';
import { createCosmicKeyStore } from './cosmic-keys';
import { createAccountKeyPair, deriveAccountSyncKey, openAccountKeyPair, openPhrase, unwrap } from './cosmic-crypto';
import type { AccountKeyPair, KeyEnvelope } from './cosmic-crypto';
import { accountId, accountSuccess, keyEnvelope, readSpaces } from './spaces';
import { createSpaceSharing } from './space-sharing';
import { createSharedProjects } from './space-reader';
import { SYNC_LIMITS, uuid } from './sync-format';
import type { QuantumAccount } from './sync-quantum';
import type { createDesktop } from './desktop';

interface Options {
  directory: string; userData: string; cipher: StoreCipher; isPackaged: boolean; env?: NodeJS.ProcessEnv;
  language(): Language; changed(): void; openExternal(url: string): Promise<void>; fetch: typeof globalThis.fetch;
  keyStore?: ReturnType<typeof createCosmicKeyStore>;
  desktop?: Pick<ReturnType<typeof createDesktop>, 'get' | 'image'>;
}
interface Tokens { accessToken: string; refreshToken: string; tokenType: 'Bearer'; expiresIn: number; deviceId: string }
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const errorCodes = new Set(['ACCOUNT_NETWORK', 'ACCOUNT_TIMEOUT', 'ACCOUNT_DENIED', 'ACCOUNT_INVALID_RESPONSE', 'ACCOUNT_STORAGE', 'ACCOUNT_PHRASE_WRONG', 'ACCOUNT_KEYSTORE']);
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
function accountCard(value: unknown): Extract<AccountState, { status: 'signedIn' }> {
  if (!record(value) || typeof value.email !== 'string') throw new Error('ACCOUNT_INVALID_RESPONSE');
  const displayName = typeof value.displayName === 'string' && value.displayName.trim() === value.displayName && value.displayName.length > 0
    && value.displayName.length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(value.displayName) ? value.displayName : null;
  const plans = Array.isArray(value.plans) ? value.plans.filter((plan: unknown): plan is Record<'key' | 'product' | 'tier' | 'label', string> => record(plan)
    && ['key', 'product', 'tier', 'label'].every(key => typeof plan[key] === 'string' && (plan[key] as string).trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(plan[key] as string))) : [];
  return { status: 'signedIn', email: value.email, displayName, plan: plans[0]?.label ?? null, phrase: 'needed', keyStore: 'session', spaces: [], shared: [], spacesError: null };
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
  let state: AccountState = { status: 'signedOut' }, access: { token: string; expires: number; deviceId: string } | undefined;
  let identity: string | undefined, key: Uint8Array<ArrayBuffer> | undefined, pair: AccountKeyPair | undefined;
  let keyStore = options.keyStore, keyStoreError = false, lastRefresh = 0, phraseWork: Promise<void> | undefined;
  let generation = 0, closed = false, checking: Promise<void> | undefined;
  let computerId: string | undefined;
  let registeredComputerId: string | undefined;
  let attempt: { server: Server; url: string; timer: ReturnType<typeof setTimeout>; used: boolean } | undefined;
  const requests = new Set<AbortController>();
  const spaceGenerations = new Map<string, number>();
  const titleCache = new Map<string, { updatedAt: string; title: string | null }>();
  let sharing: ReturnType<typeof createSpaceSharing> | undefined;
  const publish = (next: AccountState) => { state = next; if (!closed) { sharing?.changed(); options.changed(); } };
  const check = (ticket: number) => { if (closed || ticket !== generation) throw new Error('ACCOUNT_DENIED'); };
  const stopAttempt = () => { if (attempt) { clearTimeout(attempt.timer); attempt.server.close(); attempt.server.closeAllConnections(); attempt = undefined; } };
  const clearKeys = () => { sharedProjects?.clear(); key?.fill(0); key = undefined; pair = undefined; identity = undefined; registeredComputerId = undefined; keyStoreError = false; spaceGenerations.clear(); titleCache.clear(); };
  const invalidate = () => { generation++; checking = undefined; phraseWork = undefined; lastRefresh = 0; clearKeys(); stopAttempt(); for (const controller of requests) controller.abort(); requests.clear(); };
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
  const request = async (route: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', ticket: number, body?: unknown, bearer?: string, sync = false, cap?: number) => {
    check(ticket);
    const controller = new AbortController(); requests.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, sync ? SYNC_LIMITS.timeout : 20000); timer.unref?.();
    try {
      const { api } = accountEndpoints(options.isPackaged, options.env);
      const binary = Buffer.isBuffer(body), download = method === 'GET' && route.includes('/objects/');
      const response = await options.fetch(`${api}${route}`, { method, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { Accept: download ? 'application/octet-stream' : 'application/json', ...(body === undefined ? {} : binary ? {
          // Chromium's fetch writes Content-Length itself from the byte body and refuses a request that sets it.
          'Content-Type': 'application/octet-stream', 'X-Content-SHA256': createHash('sha256').update(body).digest('hex'),
        } : { 'Content-Type': 'application/json' }), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        ...(body === undefined ? {} : { body: binary ? Uint8Array.from(body) : JSON.stringify(body) }) });
      check(ticket);
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('ACCOUNT_INVALID_RESPONSE'); }
      const responseCap = sync && !response.ok ? 65536 : sync && cap !== undefined ? cap : download ? /\/blobs\/[^/]+\.hzs$/.test(route) ? SYNC_LIMITS.blob : SYNC_LIMITS.package : route.startsWith('/v1/spaces') ? 2 * 1024 * 1024 : 65536;
      if (sync && Number(response.headers.get('content-length')) > responseCap) { await response.body?.cancel(); throw new Error('SYNC_LIMIT'); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > responseCap) { await reader.cancel(); throw new Error(sync ? 'SYNC_LIMIT' : 'ACCOUNT_INVALID_RESPONSE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      check(ticket);
      const bytes = Buffer.concat(chunks);
      let value: unknown;
      if (download && response.ok) {
        if (!sync && (response.headers.get('content-length') !== String(bytes.length) || response.headers.get('x-content-sha256') !== createHash('sha256').update(bytes).digest('hex'))) throw new Error('ACCOUNT_INVALID_RESPONSE');
        value = bytes;
      } else try { value = JSON.parse(bytes.toString('utf8')); }
      catch { if (response.ok) throw new Error('ACCOUNT_INVALID_RESPONSE'); }
      const retry = response.headers.get('retry-after');
      const retryAfter = retry !== null && /^\d+$/.test(retry) && Number.isSafeInteger(Number(retry)) ? Number(retry) : undefined;
      return { status: response.status, ok: response.ok, value, retryAfter, headers: response.headers, bytes };
    } catch (error) { throw new Error(timedOut ? 'ACCOUNT_TIMEOUT' : sync && error instanceof Error && error.message === 'SYNC_LIMIT' ? 'SYNC_LIMIT' : errorCode(error)); }
    finally { clearTimeout(timer); requests.delete(controller); }
  };
  const requireSuccess = (response: { status: number; ok: boolean }) => {
    if (!response.ok) throw new Error([400, 401, 403].includes(response.status) ? 'ACCOUNT_DENIED' : 'ACCOUNT_NETWORK');
  };
  const saveTokens = async (value: unknown, ticket: number) => {
    const validated = validateAccountTokens(value); check(ticket);
    try { await tokens.set(validated.refreshToken); } catch { throw new Error('ACCOUNT_STORAGE'); }
    check(ticket); access = { token: validated.accessToken, expires: Date.now() + validated.expiresIn * 1000, deviceId: validated.deviceId };
    return access.token;
  };
  const refresh = async (ticket: number): Promise<string | undefined> => {
    const refreshToken = await readToken(); check(ticket);
    if (!refreshToken) { invalidate(); access = undefined; publish({ status: 'signedOut' }); return; }
    const response = await request('/v1/oauth/token', 'POST', ticket, { grantType: 'refresh_token', refreshToken, appId: 'horizon' });
    if (!response.ok && record(response.value) && record(response.value.error) && response.value.error.code === 'invalid_grant') {
      access = undefined; clearKeys(); removeToken(); invalidate(); publish({ status: 'signedOut' }); return;
    }
    requireSuccess(response); return saveTokens(response.value, ticket);
  };
  const authorized = async (route: string, method: 'GET' | 'PUT' | 'DELETE', ticket: number, body?: unknown, sync = false, cap?: number) => {
    let bearer = access && access.expires > Date.now() ? access.token : await refresh(ticket);
    if (!bearer) throw new Error('ACCOUNT_DENIED');
    let response = await request(route, method, ticket, body, bearer, sync, cap);
    if (response.status === 401) {
      access = undefined; bearer = await refresh(ticket);
      if (!bearer) throw new Error('ACCOUNT_DENIED');
      response = await request(route, method, ticket, body, bearer, sync, cap);
    }
    return response;
  };
  const spaceKey = async (spaceId: string, requestedGeneration?: number) => {
    const ticket = generation, account = identity, accountPair = pair;
    if (!account || !accountPair || !key) throw new Error('ACCOUNT_DENIED');
    const keyGeneration = requestedGeneration ?? spaceGenerations.get(spaceId);
    if (!keyGeneration || !Number.isSafeInteger(keyGeneration) || keyGeneration < 1) throw new Error('ACCOUNT_INVALID_RESPONSE');
    const response = await authorized(`/v1/spaces/${encodeURIComponent(spaceId)}/key${requestedGeneration === undefined ? '' : `?generation=${keyGeneration}`}`, 'GET', ticket);
    let opened: Uint8Array<ArrayBuffer>;
    try { opened = await unwrap(accountPair, keyEnvelope(accountSuccess(response)), `space-key:${spaceId}:${keyGeneration}:member:${account}`); }
    catch (error) {
      if (requestedGeneration === undefined) {
        await me(); check(ticket);
        if (spaceGenerations.get(spaceId) !== keyGeneration) return spaceKey(spaceId);
      }
      throw error;
    }
    try { check(ticket); if (opened.length !== 32) throw new Error('ACCOUNT_INVALID_RESPONSE'); return { generation: keyGeneration, key: opened }; }
    catch (error) { opened.fill(0); throw error; }
  };
  const sharedProjects = createSharedProjects({
    context: () => !closed && state.status === 'signedIn' && state.phrase === 'ready' && identity && pair ? {
      accountId: identity, session: generation, spaces: state.spaces, shared: state.shared,
    } : undefined,
    key: spaceKey, request: route => authorized(route, 'GET', generation),
  });
  if (options.desktop) sharing = createSpaceSharing({ directory: options.directory, cipher: options.cipher, changed: options.changed,
    context: () => !closed && state.status === 'signedIn' && state.phrase === 'ready' && identity && pair ? {
      accountId: identity, computerId: computerId ??= installationId(options.userData), session: generation, spaces: state.spaces,
    } : undefined,
    key: spaceKey, request: (route, method, body) => authorized(route, method, generation, body),
    project: id => options.desktop!.get(id), image: (project, item) => options.desktop!.image(project, item),
  });
  const envelopes = async (ticket: number): Promise<{ phrase?: KeyEnvelope; public?: KeyEnvelope }> => {
    const value = accountSuccess(await authorized('/v1/keys', 'GET', ticket));
    if (!record(value) || !Array.isArray(value.keys) || value.keys.length > 10000) throw new Error('ACCOUNT_INVALID_RESPONSE');
    const found: { phrase?: KeyEnvelope; public?: KeyEnvelope } = {};
    for (const entry of value.keys) if (record(entry) && (entry.recipient === 'phrase' || entry.recipient === 'public')) {
      if (found[entry.recipient]) throw new Error('ACCOUNT_INVALID_RESPONSE');
      found[entry.recipient] = keyEnvelope(entry);
    }
    return found;
  };
  const loadSpaces = async (ticket: number, card: Extract<AccountState, { status: 'signedIn' }>, keys?: { phrase?: KeyEnvelope; public?: KeyEnvelope }) => {
    sharedProjects?.clear();
    if (!identity || !key) return;
    try {
      if (!pair) {
        keys ??= await envelopes(ticket); check(ticket);
        let openedPair: AccountKeyPair;
        if (keys.public) openedPair = await openAccountKeyPair(key, keys.public, identity);
        else {
          if (!keys.phrase) throw new Error('ACCOUNT_INVALID_RESPONSE');
          const created = await createAccountKeyPair(key, identity); check(ticket);
          const response = await authorized('/v1/keys/public', 'PUT', ticket, created.envelope);
          if (response.status === 403) {
            const concurrent = (await envelopes(ticket)).public;
            if (!concurrent) throw new Error('ACCOUNT_DENIED');
            openedPair = await openAccountKeyPair(key!, concurrent, identity!);
          } else { accountSuccess(response); openedPair = { privateKey: created.privateKey, publicKey: created.publicKey }; }
        }
        check(ticket); pair = openedPair;
      }
      Object.assign(card, await readSpaces({ get: route => authorized(route, 'GET', ticket), account: identity, pair, directory: options.directory, cipher: options.cipher, titleCache,
        rememberGeneration: (space, keyGeneration) => { check(ticket); spaceGenerations.set(space, keyGeneration); }, key: spaceKey,
        check: () => check(ticket), fallbackName: options.language() === 'es' ? 'Space compartido' : 'Shared Space' }));
      if (keyStoreError && !card.spacesError) card.spacesError = 'ACCOUNT_KEYSTORE';
    } catch (error) { check(ticket); card.spacesError = errorCode(error); }
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
    requireSuccess(response); check(ticket);
    const card = accountCard(response.value), value = response.value as Record<string, unknown>;
    const device = Array.isArray(value.devices) ? value.devices.find((entry: unknown) => record(entry) && entry.id === access?.deviceId) : undefined;
    const id: unknown = record(device) ? device.userId : undefined;
    if (!accountId(id)) { card.spacesError = 'ACCOUNT_INVALID_RESPONSE'; publish(card); return; }
    if (identity !== id) { clearKeys(); identity = id; }
    registeredComputerId = record(device) && device.appId === 'horizon' && uuid(device.computerId) ? device.computerId : undefined;
    // Development builds may point at a scratch Cosmic folder, as Send to does; shipped builds use the person's own.
    keyStore ??= createCosmicKeyStore({ root: !options.isPackaged && (options.env ?? process.env).HORIZON_COSMIC_ROOT || cosmicRoot(options.env), origin: accountEndpoints(options.isPackaged, options.env).api,
      ...(options.isPackaged ? { helperPath: resolve(process.resourcesPath, 'helpers', 'cosmic-dpapi.exe') } : {}) });
    if (!key && !keyStoreError) try {
      const stored = await keyStore.get(id);
      try { check(ticket); key = stored; } catch (error) { stored?.fill(0); throw error; }
    } catch (error) { check(ticket); keyStoreError = true; card.spacesError = errorCode(error); }
    card.keyStore = keyStoreError ? 'error' : keyStore.kind;
    card.phrase = key ? 'ready' : state.status === 'signedIn' && state.phrase === 'wrong' ? 'wrong' : 'needed';
    if (keyStoreError) card.spacesError = 'ACCOUNT_KEYSTORE';
    await loadSpaces(ticket, card); check(ticket); lastRefresh = Date.now(); publish(card);
  };
  const me = (): Promise<void> => {
    if (closed || attempt) return Promise.resolve();
    if (phraseWork) return phraseWork;
    if (checking) return checking;
    const ticket = generation;
    const work = loadMe(ticket).catch(error => { fail(error, ticket); throw new Error(errorCode(error)); }).finally(() => { if (checking === work) checking = undefined; });
    checking = work; return work;
  };
  const open = async (url: string) => { try { await options.openExternal(url); } catch { throw new Error('ACCOUNT_NETWORK'); } };
  const cancel = () => { invalidate(); access = undefined; publish({ status: 'signedOut' }); };
  return {
    state: (): AccountState => structuredClone(state), me, retry: me, cancel,
    accountId: () => !closed && state.status === 'signedIn' ? identity ?? null : null,
    quantumSync(profileIds: readonly string[]): QuantumAccount | undefined {
      if (closed || state.status !== 'signedIn' || state.phrase !== 'ready' || !identity || !key || !registeredComputerId
        || profileIds.length === 0 || !profileIds.every(uuid) || new Set(profileIds).size !== profileIds.length) return;
      const ticket = generation, account = identity, device = registeredComputerId;
      const assertActive = () => {
        check(ticket);
        if (state.status !== 'signedIn' || state.phrase !== 'ready' || identity !== account || !key || registeredComputerId !== device) throw new Error('ACCOUNT_DENIED');
      };
      return { accountId: account, computerId: device, profileIds: [...profileIds], assertActive,
        async request(route, init = {}, cap) {
          assertActive();
          if (!/^\/v1\/datasets(?:\?|\/|$)/.test(route) || /[\x00-\x20\\#]/.test(route) || route.split('?')[0]!.includes('%') || route.split('?')[0]!.split('/').some(part => part === '.' || part === '..')
            || cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0 || cap > SYNC_LIMITS.blob)) throw new Error('ACCOUNT_DENIED');
          const method = init.method ?? 'GET';
          if (!['GET', 'PUT', 'DELETE'].includes(method) || init.body !== undefined && !(init.body instanceof Uint8Array)) throw new Error('ACCOUNT_DENIED');
          const body = init.body === undefined ? undefined : Buffer.from(init.body as Uint8Array);
          const response = await authorized(route, method as 'GET' | 'PUT' | 'DELETE', ticket, body, true, cap); assertActive();
          return new Response(Uint8Array.from(response.bytes), { status: response.status, headers: response.headers });
        },
        async deriveSyncKey(datasetId) {
          assertActive(); const derived = await deriveAccountSyncKey(key!, datasetId);
          try { assertActive(); return derived; } catch (error) { derived.fill(0); throw error; }
        },
      };
    },
    shareProject: (project: string, space: string) => {
      if (!sharing) return Promise.reject(new Error('SPACE_SHARE_FAILED'));
      return sharing.shareProject(project, space);
    },
    stopSharing: (project: string) => {
      if (!sharing) return Promise.reject(new Error('SPACE_SHARE_FAILED'));
      return sharing.stopSharing(project);
    },
    projectState: (project: string) => sharing?.projectState(project) ?? { sharedTo: null, shareError: null },
    openSharedProject: (space: string, dataset: string) => sharedProjects!.openSharedProject(space, dataset),
    sharedItem: (project: string | null, id: string) => sharedProjects!.item(project, id),
    sharedImage: (project: string | null, id: string) => sharedProjects!.image(project, id),
    desktopChanged: () => sharing?.changed(),
    refreshSpaces() {
      sharedProjects.clear();
      if (state.status !== 'signedIn' || Date.now() - lastRefresh < 30000) return Promise.resolve();
      lastRefresh = Date.now(); return me();
    },
    phrase(phrase: string): Promise<void> {
      if (closed || state.status !== 'signedIn' || !identity || !keyStore) { phrase = ''; return Promise.reject(new Error('ACCOUNT_DENIED')); }
      if (typeof phrase !== 'string' || phrase.length > 1000 || phrase.includes('\0')) { phrase = ''; return Promise.reject(new Error('ACCOUNT_INVALID_RESPONSE')); }
      if (phraseWork) { phrase = ''; return Promise.reject(new Error('ACCOUNT_DENIED')); }
      if (state.phrase === 'ready') { phrase = ''; return Promise.resolve(); }
      const ticket = generation, id = identity, card = structuredClone(state);
      const work = (async () => {
        let opened: Uint8Array<ArrayBuffer> | undefined;
        try {
          if (checking) await checking; check(ticket);
          const keys = await envelopes(ticket);
          if (!keys.phrase) throw new Error('ACCOUNT_INVALID_RESPONSE');
          opened = await openPhrase(phrase, keys.phrase); phrase = ''; check(ticket);
          if (!keyStoreError) try { await keyStore!.set(id, opened); } catch { check(ticket); keyStoreError = true; }
          check(ticket); key = opened; opened = undefined;
          card.phrase = 'ready'; card.keyStore = keyStoreError ? 'error' : keyStore!.kind; card.spacesError = keyStoreError ? 'ACCOUNT_KEYSTORE' : null;
          await loadSpaces(ticket, card, keys); check(ticket); lastRefresh = Date.now(); publish(card);
        } catch (error) {
          check(ticket); const code = errorCode(error);
          card.phrase = code === 'ACCOUNT_PHRASE_WRONG' ? 'wrong' : 'needed'; card.spacesError = code; publish(card); throw new Error(code);
        } finally { phrase = ''; opened?.fill(0); }
      })().finally(() => { if (phraseWork === work) phraseWork = undefined; });
      phraseWork = work; return work;
    },
    async signIn() {
      if (closed) throw new Error('ACCOUNT_DENIED');
      if (attempt) return;
      invalidate(); access = undefined; const ticket = generation;
      publish({ status: 'signingIn' });
      try {
        const { site } = accountEndpoints(options.isPackaged, options.env), pkce = createPKCE();
        computerId ??= installationId(options.userData);
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
    close() { closed = true; sharing?.close(); invalidate(); access = undefined; state = { status: 'signedOut' }; },
  };
}
