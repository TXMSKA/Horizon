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
import { accountId, accountSuccess, keyEnvelope, readSpaceDatasets, readSpaces } from './spaces';
import { createSpaceSharing } from './space-sharing';
import { createSharedProjects } from './space-reader';
import { SYNC_LIMITS, uuid } from './sync-format';
import type { QuantumAccount } from './sync-quantum';
import { subscribeQuantumChanges } from './quantum-feed';
import type { QuantumChangePage } from './sync-quantum';
import type { createDesktop } from './desktop';

interface Options {
  directory: string; userData: string; cipher: StoreCipher; isPackaged: boolean; env?: NodeJS.ProcessEnv;
  language(): Language; changed(): void; openExternal(url: string): Promise<void>; fetch: typeof globalThis.fetch;
  keyStore?: ReturnType<typeof createCosmicKeyStore>;
  desktop?: Pick<ReturnType<typeof createDesktop>, 'get' | 'image'>;
}
interface Tokens { accessToken: string; refreshToken: string; tokenType: 'Bearer'; expiresIn: number; deviceId: string; account_id: string }
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const errorCodes = new Set(['ACCOUNT_NETWORK', 'ACCOUNT_TIMEOUT', 'ACCOUNT_DENIED', 'ACCOUNT_INVALID_RESPONSE', 'ACCOUNT_STORAGE', 'ACCOUNT_PHRASE_WRONG', 'ACCOUNT_KEYSTORE', 'ACCOUNT_CONSENT']);
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
  if (!record(value) || Object.keys(value).length !== 6 || !['accessToken', 'refreshToken', 'tokenType', 'expiresIn', 'deviceId', 'account_id'].every(key => Object.hasOwn(value, key))
    || typeof value.accessToken !== 'string' || !tokenPattern.test(value.accessToken) || typeof value.refreshToken !== 'string' || !tokenPattern.test(value.refreshToken)
    || value.tokenType !== 'Bearer' || typeof value.expiresIn !== 'number' || !Number.isSafeInteger(value.expiresIn) || value.expiresIn <= 0
    || value.expiresIn > 900 || !Number.isFinite(Date.now() + value.expiresIn * 1000) || !accountId(value.deviceId) || !accountId(value.account_id)) throw new Error('ACCOUNT_INVALID_RESPONSE');
  return value as unknown as Tokens;
}
function accountCard(value: unknown): Extract<AccountState, { status: 'signedIn' }> {
  if (!record(value) || typeof value.email !== 'string') throw new Error('ACCOUNT_INVALID_RESPONSE');
  const displayName = typeof value.displayName === 'string' && value.displayName.trim() === value.displayName && value.displayName.length > 0
    && value.displayName.length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(value.displayName) ? value.displayName : null;
  const plans = Array.isArray(value.plans) ? value.plans.filter((plan: unknown): plan is Record<'key' | 'product' | 'tier' | 'label', string> => record(plan)
    && ['key', 'product', 'tier', 'label'].every(key => typeof plan[key] === 'string' && (plan[key] as string).trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(plan[key] as string))) : [];
  return { status: 'signedIn', email: value.email, displayName, plan: plans[0]?.label ?? null, phrase: 'needed', keyStore: 'session', consent: value.consentRequired === true ? 'required' : 'accepted', managedSync: false, spaces: [], shared: [], spacesError: null };
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
  let state: AccountState = { status: 'signedOut' }, access: { token: string; expires: number; deviceId: string; accountId: string } | undefined;
  let identity: string | undefined, key: Uint8Array<ArrayBuffer> | undefined, pair: AccountKeyPair | undefined;
  let keyStore = options.keyStore, keyStoreError = false, lastRefresh = 0, phraseWork: Promise<void> | undefined;
  let generation = 0, closed = false, checking: Promise<void> | undefined;
  let refreshing: { ticket: number; work: Promise<string | undefined> } | undefined;
  let computerId: string | undefined;
  let registeredComputerId: string | undefined;
  let spaceAccessRevision = 0, capabilityRevision = 0, stopChanges: (() => void) | undefined;
  const lastSpaceAccess = new Map<string, string>(), spaceAccessRevisions = new Map<string, number>();
  const readerAccessRevisions = new Map<string, number>();
  const spaceListingRevisions = new Map<string, number>(), datasetRevisions = new Map<string, number>();
  let capabilityRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let capabilityRefused = false, capabilityRefreshFailures = 0, capabilityRefreshChecks = 0, lastCapabilityGrant: boolean | undefined;
  let accountRefreshTimer: ReturnType<typeof setTimeout> | undefined, accountRefreshFailures = 0;
  let spaceRefreshTimer: ReturnType<typeof setTimeout> | undefined, refreshingSpaces = false, refreshAllSpaces = false;
  const pendingSpaces = new Map<string, Set<string> | null>(), ownDatasets = new Set<string>(), ownObjects = new Set<string>();
  let attempt: { server: Server; url: string; timer: ReturnType<typeof setTimeout>; used: boolean } | undefined;
  const requests = new Set<AbortController>();
  const spaceGenerations = new Map<string, number>();
  const titleCache = new Map<string, { updatedAt: string; title: string | null; objectHash?: string }>();
  let sharing: ReturnType<typeof createSpaceSharing> | undefined;
  const invalidateSpace = (id: string, lostAccess = false) => {
    spaceAccessRevision++; spaceAccessRevisions.set(id, (spaceAccessRevisions.get(id) ?? 0) + 1);
    if (lostAccess) { readerAccessRevisions.set(id, (readerAccessRevisions.get(id) ?? 0) + 1); sharedProjects?.clear(id); }
  };
  const publish = (next: AccountState) => {
    if (next.status === 'signedIn') {
      const previousSpaces = new Map(state.status === 'signedIn' ? state.spaces.map(space => [space.id, JSON.stringify(space)]) : []);
      const signatures = new Map(next.spaces.map(space => [space.id, JSON.stringify([space.currentGeneration, space.pending, space.rotationRequired,
        space.members.filter(member => member.accountId === identity).map(member => [member.role, member.keyChanged]), space.members.filter(member => member.keyChanged).map(member => member.accountId).sort()])]));
      for (const id of new Set([...lastSpaceAccess.keys(), ...signatures.keys()])) {
        if (lastSpaceAccess.has(id) && lastSpaceAccess.get(id) !== signatures.get(id)) invalidateSpace(id, !next.spaces.some(space => space.id === id && space.members.some(member => member.accountId === identity)));
      }
      lastSpaceAccess.clear(); for (const [id, signature] of signatures) lastSpaceAccess.set(id, signature);
      for (const id of new Set([...previousSpaces.keys(), ...next.spaces.map(space => space.id)])) {
        if (previousSpaces.get(id) !== JSON.stringify(next.spaces.find(space => space.id === id))) spaceListingRevisions.set(id, (spaceListingRevisions.get(id) ?? 0) + 1);
      }
      const previousDatasets = new Map(state.status === 'signedIn' ? state.shared.map(dataset => [`${dataset.spaceId}:${dataset.datasetId}`, JSON.stringify(dataset)]) : []);
      const datasets = new Map(next.shared.map(dataset => [`${dataset.spaceId}:${dataset.datasetId}`, JSON.stringify(dataset)]));
      for (const id of new Set([...previousDatasets.keys(), ...datasets.keys()])) {
        if (previousDatasets.get(id) !== datasets.get(id)) datasetRevisions.set(id, (datasetRevisions.get(id) ?? 0) + 1);
      }
    }
    if (next.status !== 'signedIn' || next.phrase !== 'ready' || next.consent !== 'accepted') { stopChanges?.(); stopChanges = undefined; }
    state = next; if (!closed) { sharing?.changed(); options.changed(); }
  };
  const spaceReadRevision = () => ({ access: new Map(spaceAccessRevisions), listings: new Map(spaceListingRevisions), datasets: new Map(datasetRevisions) });
  const mergeSpaces = (card: Extract<AccountState, { status: 'signedIn' }>, before: ReturnType<typeof spaceReadRevision>, selected?: ReadonlyMap<string, ReadonlySet<string> | null>) => {
    if (state.status !== 'signedIn') return { spaces: card.spaces, shared: card.shared };
    const current = state;
    const metadata = new Set(selected ? [...selected].filter(([id, datasets]) => datasets === null || !current.spaces.some(space => space.id === id && !space.pending)).map(([space]) => space) : [...card.spaces, ...current.spaces].map(space => space.id));
    const spaces = new Map(state.spaces.map(space => [space.id, space]));
    for (const id of metadata) if ((before.listings.get(id) ?? 0) === (spaceListingRevisions.get(id) ?? 0) && (before.access.get(id) ?? 0) === (spaceAccessRevisions.get(id) ?? 0)) {
      const space = card.spaces.find(space => space.id === id); if (space) spaces.set(id, space); else spaces.delete(id);
    }
    const datasets = new Map(state.shared.map(dataset => [`${dataset.spaceId}:${dataset.datasetId}`, dataset]));
    for (const dataset of [...state.shared, ...card.shared]) {
      const id = `${dataset.spaceId}:${dataset.datasetId}`, selection = selected?.get(dataset.spaceId);
      if (selected && selection !== null && !selection?.has(dataset.datasetId)) continue;
      if ((before.datasets.get(id) ?? 0) !== (datasetRevisions.get(id) ?? 0) || (before.access.get(dataset.spaceId) ?? 0) !== (spaceAccessRevisions.get(dataset.spaceId) ?? 0)) continue;
      const loaded = card.shared.find(entry => entry.spaceId === dataset.spaceId && entry.datasetId === dataset.datasetId);
      if (loaded && spaces.has(dataset.spaceId)) datasets.set(id, loaded); else datasets.delete(id);
    }
    return { spaces: [...spaces.values()].sort((a, b) => a.id.localeCompare(b.id)), shared: [...datasets.values()] };
  };
  const check = (ticket: number) => { if (closed || ticket !== generation) throw new Error('ACCOUNT_DENIED'); };
  const stopAttempt = () => { if (attempt) { clearTimeout(attempt.timer); attempt.server.close(); attempt.server.closeAllConnections(); attempt = undefined; } };
  const clearKeys = () => { readerAccessRevisions.clear(); capabilityRefreshChecks = 0; stopChanges?.(); stopChanges = undefined; clearTimeout(spaceRefreshTimer); spaceRefreshTimer = undefined; clearTimeout(capabilityRefreshTimer); capabilityRefreshTimer = undefined; clearTimeout(accountRefreshTimer); accountRefreshTimer = undefined; accountRefreshFailures = 0; capabilityRefused = false; lastCapabilityGrant = undefined; capabilityRefreshFailures = 0; pendingSpaces.clear(); ownDatasets.clear(); ownObjects.clear(); refreshAllSpaces = false; lastSpaceAccess.clear(); spaceAccessRevisions.clear(); spaceListingRevisions.clear(); datasetRevisions.clear(); spaceAccessRevision++; sharedProjects?.clear(); key?.fill(0); key = undefined; pair = undefined; identity = undefined; registeredComputerId = undefined; keyStoreError = false; spaceGenerations.clear(); titleCache.clear(); };
  const invalidate = () => { generation++; checking = undefined; refreshing = undefined; phraseWork = undefined; lastRefresh = 0; clearKeys(); stopAttempt(); for (const controller of requests) controller.abort(); requests.clear(); };
  const fail = (error: unknown, ticket: number) => { if (!closed && ticket === generation) { clearTimeout(accountRefreshTimer); accountRefreshTimer = undefined; accountRefreshFailures = 0; stopAttempt(); publish({ status: 'error', code: errorCode(error) }); } };
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
  const request = async (route: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', ticket: number, body?: unknown, bearer?: string, sync = false, cap?: number, signal?: AbortSignal) => {
    check(ticket);
    const controller = new AbortController(); requests.add(controller);
    let timedOut = false;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, route.startsWith('/v1/changes') ? 35000 : sync ? SYNC_LIMITS.timeout : 20000); timer.unref?.();
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
      const responseCap = !response.ok ? 65536 : sync && cap !== undefined ? cap : download ? /\/blobs\/[^/]+\.hzs$/.test(route) ? SYNC_LIMITS.blob : SYNC_LIMITS.package : /^\/v1\/(?:spaces|changes|bootstrap|datasets|keys)(?:\?|\/|$)/.test(route) ? 2 * 1024 * 1024 : 65536;
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
      const seconds = retry === null ? NaN : /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
      const retryAfter = Number.isFinite(seconds) ? Math.max(0, Math.min(86400, seconds)) : undefined;
      return { status: response.status, ok: response.ok, value, retryAfter, headers: response.headers, bytes };
    } catch (error) { throw new Error(timedOut ? 'ACCOUNT_TIMEOUT' : sync && error instanceof Error && error.message === 'SYNC_LIMIT' ? 'SYNC_LIMIT' : errorCode(error)); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); requests.delete(controller); }
  };
  const requireSuccess = (response: { status: number; ok: boolean; retryAfter?: number }) => {
    if (!response.ok) throw Object.assign(new Error([400, 401, 403].includes(response.status) ? 'ACCOUNT_DENIED' : 'ACCOUNT_NETWORK'),
      response.retryAfter === undefined ? {} : { retryAfterMs: response.retryAfter * 1000 });
  };
  const saveTokens = async (value: unknown, ticket: number) => {
    const validated = validateAccountTokens(value); check(ticket);
    if (identity && identity !== validated.account_id) throw new Error('ACCOUNT_DENIED');
    try { await tokens.set(validated.refreshToken); } catch { throw new Error('ACCOUNT_STORAGE'); }
    check(ticket); access = { token: validated.accessToken, expires: Date.now() + validated.expiresIn * 1000, deviceId: validated.deviceId, accountId: validated.account_id };
    return access.token;
  };
  const performRefresh = async (ticket: number): Promise<string | undefined> => {
    const refreshToken = await readToken(); check(ticket);
    if (!refreshToken) { invalidate(); access = undefined; publish({ status: 'signedOut' }); return; }
    const response = await request('/v1/oauth/token', 'POST', ticket, { grantType: 'refresh_token', refreshToken, appId: 'horizon' });
    if (!response.ok && record(response.value) && record(response.value.error) && response.value.error.code === 'invalid_grant') {
      access = undefined; clearKeys(); removeToken(); invalidate(); publish({ status: 'signedOut' }); return;
    }
    requireSuccess(response); return saveTokens(response.value, ticket);
  };
  const refresh = (ticket: number): Promise<string | undefined> => {
    if (refreshing?.ticket === ticket) return refreshing.work;
    const work = performRefresh(ticket).finally(() => { if (refreshing?.work === work) refreshing = undefined; });
    refreshing = { ticket, work }; return work;
  };
  const authorized = async (route: string, method: 'GET' | 'PUT' | 'DELETE', ticket: number, body?: unknown, sync = false, cap?: number, signal?: AbortSignal) => {
    const ownDataset = method === 'PUT' && /^\/v1\/spaces\/([^/]+)\/datasets\/([^/?]+)$/.exec(route);
    if (ownDataset) {
      ownDatasets.add(`${decodeURIComponent(ownDataset[1]!)}:${decodeURIComponent(ownDataset[2]!)}`);
      if (ownDatasets.size > 1000) ownDatasets.delete(ownDatasets.values().next().value!);
    }
    // The feed omits writer account identity; only paths submitted by this account connection are its own writes.
    const ownObject = method !== 'GET' && /^\/v1\/spaces\/([^/]+)\/datasets\/([^/?]+)\/objects\/(.+)$/.exec(route);
    if (ownObject) {
      ownObjects.add(`${method === 'PUT' ? 'object_added' : 'object_deleted'}:${ownObject.slice(1).map(decodeURIComponent).join(':')}`);
      if (ownObjects.size > SYNC_LIMITS.files) ownObjects.delete(ownObjects.values().next().value!);
    }
    let bearer = access && access.expires > Date.now() ? access.token : await refresh(ticket);
    if (!bearer) throw new Error('ACCOUNT_DENIED');
    let response = await request(route, method, ticket, body, bearer, sync, cap, signal);
    if (response.status === 401) {
      if (access?.token === bearer) access = undefined;
      bearer = access && access.expires > Date.now() ? access.token : await refresh(ticket);
      if (!bearer) throw new Error('ACCOUNT_DENIED');
      response = await request(route, method, ticket, body, bearer, sync, cap, signal);
    }
    // Quantum answers every protected route this way until the current Terms and Privacy are accepted on the Cosmic site.
    if (ownObject && !response.ok) ownObjects.delete(`${method === 'PUT' ? 'object_added' : 'object_deleted'}:${ownObject.slice(1).map(decodeURIComponent).join(':')}`);
    if (response.status === 403 && record(response.value) && record(response.value.error) && response.value.error.code === 'acceptance_required') {
      check(ticket);
      if (state.status === 'signedIn' && state.consent !== 'required') publish({ ...structuredClone(state), consent: 'required', managedSync: false });
      capabilityRefused = true; scheduleCapabilityRefresh();
      throw new Error('ACCOUNT_CONSENT');
    }
    if (sync && method !== 'GET' && response.status === 403 && record(response.value) && record(response.value.error) && response.value.error.code === 'sync_plan_required') {
      capabilityRefused = true; scheduleCapabilityRefresh();
    }
    if (sync && method === 'PUT' && response.ok && capabilityRefused) {
      capabilityRefused = false; capabilityRefreshFailures = 0; capabilityRefreshChecks = 0;
      clearTimeout(capabilityRefreshTimer); capabilityRefreshTimer = undefined; scheduleCapabilityRefresh();
    }
    return response;
  };
  // Effective capabilities come from Quantum on every refresh; plan labels are shown, never compared.
  const capabilities = async (ticket: number) => {
    const value = accountSuccess(await authorized('/v1/entitlements', 'GET', ticket));
    if (!record(value) || !record(value.capabilities) || !record(value.capabilities.managedSync) || typeof value.capabilities.managedSync.horizon !== 'boolean') throw new Error('ACCOUNT_INVALID_RESPONSE');
    const granted = value.capabilities.managedSync.horizon, newGrant = granted && lastCapabilityGrant !== true;
    lastCapabilityGrant = granted;
    if (granted && (!capabilityRefused || newGrant)) {
      if (newGrant) capabilityRevision++;
      capabilityRefused = false; capabilityRefreshFailures = 0; capabilityRefreshChecks = 0;
    }
    return granted;
  };
  const spaceKey = async (spaceId: string, requestedGeneration?: number) => {
    const ticket = generation, account = identity, accountPair = pair;
    if (!account || !accountPair || !key) throw new Error('ACCOUNT_DENIED');
    const keyGeneration = requestedGeneration ?? spaceGenerations.get(spaceId);
    if (!keyGeneration || !Number.isSafeInteger(keyGeneration) || keyGeneration < 1) throw new Error('ACCOUNT_INVALID_RESPONSE');
    const response = await authorized(`/v1/spaces/${encodeURIComponent(spaceId)}/key${requestedGeneration === undefined ? '' : `?generation=${keyGeneration}`}`, 'GET', ticket);
    let opened: Uint8Array<ArrayBuffer>;
    try {
      const value = accountSuccess(response);
      if (!record(value) || value.generation !== keyGeneration) throw new Error('ACCOUNT_INVALID_RESPONSE');
      opened = await unwrap(accountPair, keyEnvelope(value), `space-key:${spaceId}:${keyGeneration}:member:${account}`);
    }
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
      accountId: identity, session: generation, accessRevisions: Object.fromEntries(readerAccessRevisions), spaces: state.spaces, shared: state.shared,
    } : undefined,
    key: spaceKey, request: route => authorized(route, 'GET', generation),
  });
  if (options.desktop) sharing = createSpaceSharing({ directory: options.directory, cipher: options.cipher, changed: options.changed,
    context: () => !closed && state.status === 'signedIn' && state.phrase === 'ready' && identity && pair && registeredComputerId ? {
      accountId: identity, computerId: registeredComputerId, session: generation, accessRevision: spaceAccessRevision, accessRevisions: Object.fromEntries(spaceAccessRevisions), spaces: state.spaces,
      capabilityRevision: `${capabilityRevision}:${state.consent}`,
    } : undefined,
    key: spaceKey, request: (route, method, body) => authorized(route, method, generation, body, true),
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
  const loadSpaces = async (ticket: number, card: Extract<AccountState, { status: 'signedIn' }>, keys?: { phrase?: KeyEnvelope; public?: KeyEnvelope }, selected?: ReadonlySet<string>) => {
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
      const loaded = await readSpaces({ get: route => authorized(route, 'GET', ticket), account: identity, pair, directory: options.directory, cipher: options.cipher, titleCache, selected,
        rememberGeneration: (space, keyGeneration) => { check(ticket); spaceGenerations.set(space, keyGeneration); }, key: spaceKey,
        check: () => check(ticket), fallbackName: options.language() === 'es' ? 'Space compartido' : 'Shared Space' });
      if (state.status === 'signedIn') loaded.shared.push(...state.shared.filter(dataset => loaded.staleSpaces.includes(dataset.spaceId)).map(dataset => ({ ...dataset, stale: true as const })));
      if (selected) {
        card.spaces = [...card.spaces.filter(space => !selected.has(space.id)), ...loaded.spaces].sort((a, b) => a.id.localeCompare(b.id));
        card.shared = [...card.shared.filter(dataset => !selected.has(dataset.spaceId)), ...loaded.shared]; card.spacesError = loaded.spacesError;
      } else { card.spaces = loaded.spaces; card.shared = loaded.shared; card.spacesError = loaded.spacesError; }
      if (keyStoreError && !card.spacesError) card.spacesError = 'ACCOUNT_KEYSTORE';
    } catch (error) {
      check(ticket); card.spacesError = errorCode(error);
      if (state.status === 'signedIn') {
        card.spaces = state.spaces.map(space => ({ ...space, stale: true }));
        card.shared = state.shared.map(dataset => ({ ...dataset, stale: true }));
      }
    }
  };
  const loadMe = async (ticket: number) => {
    const before = spaceReadRevision();
    let bearer = access && access.expires > Date.now() ? access.token : await refresh(ticket);
    if (!bearer) return;
    let response = await request('/v1/me', 'GET', ticket, undefined, bearer);
    if (response.status === 401) {
      if (access?.token === bearer) access = undefined;
      bearer = access && access.expires > Date.now() ? access.token : await refresh(ticket);
      if (!bearer) return;
      response = await request('/v1/me', 'GET', ticket, undefined, bearer);
    }
    if (response.status === 403 && record(response.value) && record(response.value.error) && response.value.error.code === 'acceptance_required' && state.status === 'signedIn') {
      publish({ ...state, consent: 'required', managedSync: false }); return;
    }
    if (!response.ok && response.status !== 401) throw Object.assign(new Error('ACCOUNT_NETWORK'), response.retryAfter === undefined ? {} : { retryAfterMs: response.retryAfter * 1000 });
    requireSuccess(response); check(ticket);
    const card = accountCard(response.value), value = response.value as Record<string, unknown>;
    const device = Array.isArray(value.devices) ? value.devices.find((entry: unknown) => record(entry) && entry.id === access?.deviceId) : undefined;
    const id: unknown = value.accountId;
    if (!accountId(id) || id !== access?.accountId || !record(device) || device.accountId !== id || device.appId !== 'horizon'
      || !uuid(device.computerId)) throw new Error('ACCOUNT_INVALID_RESPONSE');
    if (device.revokedAt !== null) throw new Error('ACCOUNT_DENIED');
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
    if (card.consent === 'accepted') try { card.managedSync = await capabilities(ticket); }
    catch (error) {
      check(ticket);
      if (errorCode(error) === 'ACCOUNT_CONSENT') card.consent = 'required';
      // Quantum checks every write again, so a failed read keeps what the last answer allowed.
      else card.managedSync = state.status === 'signedIn' && state.managedSync;
    }
    if (card.consent === 'required') { lastRefresh = Date.now(); publish(card); return; }
    await loadSpaces(ticket, card); check(ticket); lastRefresh = Date.now(); publish({ ...card, ...mergeSpaces(card, before) }); startChanges();
  };
  const me = (): Promise<void> => {
    if (closed || attempt) return Promise.resolve();
    if (phraseWork) return phraseWork;
    if (checking) return checking;
    const ticket = generation;
    const work = loadMe(ticket).then(() => {
      if (ticket === generation) { clearTimeout(accountRefreshTimer); accountRefreshTimer = undefined; accountRefreshFailures = 0; }
    }).catch(error => {
      const code = errorCode(error);
      if (!closed && ticket === generation && !['ACCOUNT_DENIED', 'ACCOUNT_CONSENT'].includes(code)
        && (state.status === 'signedIn' || ['ACCOUNT_NETWORK', 'ACCOUNT_TIMEOUT'].includes(code))) {
        if (state.status === 'signedIn') publish({ ...state, spacesError: code });
        else publish({ status: 'error', code });
        if (!accountRefreshTimer) {
          accountRefreshFailures++;
          const retryAfter = error && typeof error === 'object' && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' ? error.retryAfterMs : 0;
          accountRefreshTimer = setTimeout(async () => { accountRefreshTimer = undefined; await me().catch(() => {}); },
            Math.max(retryAfter, Math.min(900000, 5000 * 2 ** Math.min(accountRefreshFailures - 1, 8))));
          accountRefreshTimer.unref?.();
        }
      } else fail(error, ticket);
      throw new Error(code);
    }).finally(() => { if (checking === work) checking = undefined; });
    checking = work; return work;
  };
  const scheduleCapabilityRefresh = (delay = 0) => {
    if (closed || capabilityRefreshTimer) return;
    const ticket = generation;
    capabilityRefreshTimer = setTimeout(async () => {
      capabilityRefreshTimer = undefined;
      try {
        const managedSync = await capabilities(ticket); check(ticket);
        if (state.status !== 'signedIn') return;
        publish({ ...state, managedSync, consent: 'accepted' }); startChanges();
        capabilityRefreshFailures = 0;
      } catch (error) { if (ticket === generation) capabilityRefreshFailures = errorCode(error) === 'ACCOUNT_CONSENT' ? 0 : capabilityRefreshFailures + 1; }
      if (ticket === generation && capabilityRefused) {
        capabilityRefreshChecks++;
        scheduleCapabilityRefresh(capabilityRefreshChecks >= 5 ? 900000 : Math.min(900000, 60000 * 2 ** Math.min(capabilityRefreshFailures, 4)));
      }
    }, delay);
    capabilityRefreshTimer.unref?.();
  };
  const makeQuantumAccount = (profileIds: readonly string[]): QuantumAccount | undefined => {
    if (closed || state.status !== 'signedIn' || state.phrase !== 'ready' || !identity || !key || !registeredComputerId
      || !profileIds.every(uuid) || new Set(profileIds).size !== profileIds.length) return;
    const ticket = generation, account = identity, device = registeredComputerId;
    const assertActive = () => {
      check(ticket);
      if (state.status !== 'signedIn' || state.phrase !== 'ready' || identity !== account || !key || registeredComputerId !== device) throw new Error('ACCOUNT_DENIED');
      // Sync stays local until the current terms are accepted, so no protected request leaves meanwhile.
      if (state.consent !== 'accepted') throw new Error('ACCOUNT_CONSENT');
    };
    return { accountId: account, computerId: device, profileIds: [...profileIds], assertActive,
      revision: JSON.stringify([options.directory, ticket, account, device, state.consent, capabilityRevision, [...profileIds].sort()]),
      subscribeChanges: listener => subscribeQuantumChanges({ account: makeQuantumAccount(profileIds)!, directory: options.directory, cipher: options.cipher, listener }),
      async request(route, init = {}, cap) {
        assertActive();
        if (!/^\/v1\/(?:datasets|changes|bootstrap)(?:\?|\/|$)/.test(route) || /[\x00-\x20\\#]/.test(route) || route.split('?')[0]!.includes('%') || route.split('?')[0]!.split('/').some(part => part === '.' || part === '..')
          || cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0 || cap > SYNC_LIMITS.blob)) throw new Error('ACCOUNT_DENIED');
        const method = init.method ?? 'GET';
        if (!['GET', 'PUT', 'DELETE'].includes(method) || init.body !== undefined && !(init.body instanceof Uint8Array)) throw new Error('ACCOUNT_DENIED');
        const body = init.body === undefined ? undefined : Buffer.from(init.body as Uint8Array);
        const response = await authorized(route, method as 'GET' | 'PUT' | 'DELETE', ticket, body, true, cap, init.signal ?? undefined); assertActive();
        return new Response(Uint8Array.from(response.bytes), { status: response.status, headers: response.headers });
      },
      async deriveSyncKey(datasetId) {
        assertActive(); const derived = await deriveAccountSyncKey(key!, datasetId);
        try { assertActive(); return derived; } catch (error) { derived.fill(0); throw error; }
      },
    };
  };
  const scheduleSpaces = () => {
    if (spaceRefreshTimer || refreshingSpaces || !refreshAllSpaces && !pendingSpaces.size || closed) return;
    const ticket = generation;
    spaceRefreshTimer = setTimeout(async () => {
      spaceRefreshTimer = undefined;
      if (checking) await checking.catch(() => {});
      if (closed || ticket !== generation || state.status !== 'signedIn' || state.phrase !== 'ready' || state.consent !== 'accepted' || !identity) return;
      if (Date.now() - lastRefresh < 30000) { scheduleSpaces(); return; }
      const all = refreshAllSpaces, selected = new Map(pendingSpaces), before = spaceReadRevision();
      refreshAllSpaces = false; pendingSpaces.clear(); refreshingSpaces = true; lastRefresh = Date.now();
      const card = structuredClone(state);
      card.spacesError = keyStoreError ? 'ACCOUNT_KEYSTORE' : null;
      try {
        if (all) await loadSpaces(ticket, card);
        else {
          const metadata = new Set([...selected].filter(([space, datasets]) => datasets === null || !card.spaces.some(entry => entry.id === space && !entry.pending)).map(([space]) => space));
          if (metadata.size) await loadSpaces(ticket, card, undefined, metadata);
          for (const [space, datasets] of selected) if (datasets && !metadata.has(space)) {
            const shared = await readSpaceDatasets({ get: route => authorized(route, 'GET', ticket), account: identity, check: () => check(ticket), key: spaceKey, titleCache }, space, datasets);
            card.shared = [...card.shared.filter(dataset => dataset.spaceId !== space || !datasets.has(dataset.datasetId)), ...shared];
          }
        }
        check(ticket);
        if (state.status === 'signedIn') {
          if (!keyStoreError && !card.spacesError) card.spacesError = null;
          publish({ ...state, ...mergeSpaces(card, before, all ? undefined : selected), spacesError: card.spacesError });
        }
      } catch (error) {
        if (!closed && ticket === generation && state.status === 'signedIn') publish({ ...state, spacesError: errorCode(error),
          shared: state.shared.map(dataset => all || selected.has(dataset.spaceId) ? { ...dataset, stale: true } : dataset) });
      } finally { refreshingSpaces = false; scheduleSpaces(); }
    }, Math.max(0, 30000 - (Date.now() - lastRefresh)));
    spaceRefreshTimer.unref?.();
  };
  const startChanges = () => {
    if (stopChanges || state.status !== 'signedIn' || state.phrase !== 'ready' || state.consent !== 'accepted') return;
    const source = makeQuantumAccount([]); if (!source) return;
    const ticket = generation;
    stopChanges = subscribeQuantumChanges({ account: source, directory: options.directory, cipher: options.cipher,
      async listener(page: QuantumChangePage | null) {
        check(ticket);
        const changes = page?.changes.filter(change => change.ownerType === 'space'
          && !(change.type === 'dataset_created' && ownDatasets.has(`${change.ownerId}:${change.datasetId}`))
          && !ownObjects.delete(`${change.type}:${change.ownerId}:${change.datasetId}:${change.path}`)) ?? [];
        if (page !== null && changes.length === 0) return;
        if (state.status !== 'signedIn' || state.phrase !== 'ready' || state.consent !== 'accepted') return;
        if (page === null) refreshAllSpaces = true;
        for (const change of changes) {
          if (change.type === 'member_removed' || change.type === 'key_generation_committed' || change.type === 'member_added' && change.memberId === identity) invalidateSpace(change.ownerId, change.type === 'member_removed' && change.memberId === identity);
          if (change.datasetId) {
            const id = `${change.ownerId}:${change.datasetId}`; datasetRevisions.set(id, (datasetRevisions.get(id) ?? 0) + 1);
          }
          if (change.type === 'dataset_deleted') publish({ ...state, shared: state.shared.filter(dataset => dataset.spaceId !== change.ownerId || dataset.datasetId !== change.datasetId) });
          if (change.type === 'member_removed' && change.memberId === identity) {
            publish({ ...state, spaces: state.spaces.filter(space => space.id !== change.ownerId), shared: state.shared.filter(dataset => dataset.spaceId !== change.ownerId) });
            pendingSpaces.delete(change.ownerId); continue;
          }
          if (['member_added', 'member_removed', 'key_generation_committed'].includes(change.type) || !change.datasetId) pendingSpaces.set(change.ownerId, null);
          else if (pendingSpaces.get(change.ownerId) !== null) {
            const datasets = pendingSpaces.get(change.ownerId) ?? new Set<string>(); datasets.add(change.datasetId); pendingSpaces.set(change.ownerId, datasets);
          }
        }
        // Consumers acknowledge the feed independently; a Space refresh failure remains visible and can be retried on demand.
        scheduleSpaces();
      },
    });
  };
  const open = async (url: string) => { try { await options.openExternal(url); } catch { throw new Error('ACCOUNT_NETWORK'); } };
  const cancel = () => { invalidate(); access = undefined; publish({ status: 'signedOut' }); };
  return {
    state: (): AccountState => structuredClone(state), me, retry: me, cancel,
    accountId: () => !closed && state.status === 'signedIn' ? identity ?? null : null,
    managedSync: () => !closed && state.status === 'signedIn' && state.consent === 'accepted' && state.managedSync,
    quantumSync(profileIds: readonly string[]): QuantumAccount | undefined {
      return profileIds.length > 0 ? makeQuantumAccount(profileIds) : undefined;
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
          await loadSpaces(ticket, card, keys); check(ticket); lastRefresh = Date.now(); publish(card); startChanges();
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
        const url = new URL(`${site}/authorize/`);
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
