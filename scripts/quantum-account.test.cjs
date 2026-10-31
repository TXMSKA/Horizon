const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const crypto = require('../dist/electron/cosmic-crypto.js');
const { vaultTokenStore } = require('../dist/electron/vault-storage.js');

async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.ok(predicate(), 'Space aggregate consumer did not reach the expected state');
}
async function fixture(t, options = {}) {
  const temporary = join(__dirname, '..', '.runtime', '046-test-tmp'); mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'horizon-space-feed-')), profile = join(directory, 'profile'); mkdirSync(profile);
  const cipher = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const key = randomBytes(32), pair = await crypto.createAccountKeyPair(key, 'account-a'), spaceKey = randomBytes(32), device = randomUUID();
  await vaultTokenStore(join(profile, 'account.sealed'), cipher).set('r'.repeat(43));
  const envelopes = new Map(await Promise.all(['space-a', 'space-b'].map(async space => [space, await crypto.wrap(pair.publicKey, spaceKey, `space-key:${space}:1:member:account-a`)])));
  const calls = [], timers = new Map(), exports = {}, readers = { clears: 0, clearedSpaces: [], subscriptions: 0, unsubscribes: 0 }, localRequire = createRequire(join(__dirname, '../dist/electron/account.js'));
  const holds = [], feedCalls = [], cursors = [], broker = {};
  if (options.broker) runInNewContext(readFileSync(join(__dirname, '../dist/electron/quantum-feed.js'), 'utf8'), {
    exports: broker, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === './sync-quantum') return { async fetchQuantumChanges(_source, cursor) {
        feedCalls.push(cursor);
        if (feedCalls.length === 1) return { changes: [], cursor: 'initial', retryAfterMs: 0 };
        return new Promise(resolve => holds.push(resolve));
      } };
      if (name === './vault-storage') return { ...localRequire(name), writeVaultFile(path, value, cipher) { cursors.push(value.cursor); localRequire(name).writeVaultFile(path, value, cipher); } };
      return localRequire(name);
    },
  });
  let now = 1000000, listener, fail = false, failMe = options.initialFailure ?? false, failToken = options.tokenFailure ?? false, failDatasets = false, failKey = false, members = [], currentGeneration = 1, updatedAt = 100, datasetGate, displayName = null, managedSync = true, shareRequest, refusePut = false, revoked = false;
  runInNewContext(readFileSync(join(__dirname, '../dist/electron/account.js'), 'utf8'), {
    exports, Buffer, URL, URLSearchParams, AbortController, Response, TextDecoder, process, structuredClone,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const timer = { callback, at: now + delay, unref() {} }; timers.set(timer, timer); return timer; }, clearTimeout: timer => timers.delete(timer),
    require(name) {
      if (name === './quantum-feed') return { subscribeQuantumChanges(connection) { listener = connection.listener; readers.subscriptions++; const stop = options.broker ? broker.subscribeQuantumChanges(connection) : () => {}; return () => { readers.unsubscribes++; stop(); }; } };
      if (name === './space-reader') return { createSharedProjects(options) { readers.context = options.context; return { clear(space) { readers.clears++; readers.clearedSpaces.push(space); }, async openSharedProject() {} }; } };
      if (name === './space-sharing' && options.shareRequests) return { createSpaceSharing(options) { shareRequest = options.request; readers.sharingContext = options.context; readers.sharingKey = options.key; return { changed() {}, close() {} }; } };
      return localRequire(name);
    },
  });
  const account = exports.createAccount({ directory: profile, userData: directory, cipher, isPackaged: false,
    language: () => 'en', changed() {}, openExternal: async () => {}, keyStore: { kind: 'session', get: async () => key.slice() }, ...(options.shareRequests ? { desktop: {} } : {}),
    async fetch(value, init) {
      const url = new URL(value); calls.push({ path: url.pathname, method: init.method });
      const json = body => Response.json(body);
      const failure = value => {
        if (value === 'network') throw new Error('offline');
        if (value === 'timeout') throw new Error('ACCOUNT_TIMEOUT');
        return Response.json(value === 'invalid_grant' ? { error: { code: 'invalid_grant' } } : {}, { status: typeof value === 'number' ? value : 400,
          ...(options.retryAfter ? { headers: { 'Retry-After': String(options.retryAfter) } } : {}) });
      };
      if (url.pathname === '/v1/oauth/token') return failToken ? failure(failToken) : json({ accessToken: 'a'.repeat(43), refreshToken: 'r'.repeat(43), tokenType: 'Bearer', expiresIn: 900, deviceId: 'device-a', account_id: 'account-a' });
      if (url.pathname === '/v1/me') {
        if (failMe) return failure(failMe === true ? 503 : failMe);
        return json({ accountId: 'account-a', email: 'person@example.test', displayName, plans: [], consentRequired: failKey === 'consent', devices: [{ id: 'device-a', accountId: 'account-a', appId: 'horizon', revokedAt: revoked ? 100 : null, computerId: device }] });
      }
      if (url.pathname === '/v1/entitlements') return failKey === 'consent' ? Response.json({ error: { code: 'acceptance_required' } }, { status: 403 }) : json({ capabilities: { managedSync: { horizon: managedSync } } });
      if (url.pathname === '/v1/bootstrap') return json({ accountId: 'account-a' });
      if (url.pathname === '/v1/keys') return json({ keys: [{ recipient: 'public', ...pair.envelope }] });
      if (url.pathname === '/v1/spaces') {
        if (fail) return new Response('{}', { status: 503 });
        return json({ spaces: ['space-a', 'space-b'].map(id => ({ id, kind: 'shared', role: 'member', currentGeneration, rotationRequired: false, createdAt: 100,
          algorithm: null, sealedProfile: null, members: [{ accountId: 'account-a', displayName: null, role: 'member' }, ...members] })), after: null });
      }
      if (url.pathname.endsWith('/public-key')) return new Response('{}', { status: 404 });
      if (url.pathname.endsWith('/key')) return failKey === 'consent' ? Response.json({ error: { code: 'acceptance_required' } }, { status: 403 }) : failKey ? new Response('{}', { status: 503 }) : json({ ...envelopes.get(url.pathname.split('/')[3]), generation: 1 });
      if (url.pathname.endsWith('/datasets')) {
        const snapshotUpdatedAt = updatedAt;
        if (datasetGate) { const gate = datasetGate; datasetGate = undefined; gate.enter(); await gate.wait; }
        if (fail || failDatasets === true || failDatasets === url.pathname.split('/')[3]) return new Response('{}', { status: 503 });
        return json({ datasets: ['dataset-a', 'dataset-b'].map(id => ({ id, appId: 'horizon', createdAt: 100, updatedAt: snapshotUpdatedAt, size: 10, sharedBy: { accountId: 'peer', displayName: null } })), after: null });
      }
      if (url.pathname.endsWith('/objects')) return json({ objects: [], after: null });
      if (init.method === 'PUT' && /\/datasets\//.test(url.pathname) && refusePut) return Response.json({ error: { code: 'sync_plan_required' } }, { status: 403 });
      return json({ success: true });
    },
  });
  t.after(() => { account.close(); rmSync(directory, { recursive: true, force: true }); });
  if (options.initialFailure || options.tokenFailure) await account.me().catch(() => {});
  else { await account.me(); assert.equal(account.state().phrase, 'ready'); assert.ok(listener); }
  calls.length = 0;
  if (options.broker) await until(() => holds.length === 1);
  return { account, calls, readers, device, cursors, feedCalls, shareRequest, emit: async (changes, cursor = 'next') => {
    if (!options.broker) return listener(changes === null ? null : { changes, cursor, retryAfterMs: 0 });
    holds.shift()({ changes, cursor, retryAfterMs: 0 }); await until(() => holds.length === 1);
  },
    fail(value = true) { fail = value; }, changeTime(value) { updatedAt = value; },
    failDatasets(value = true) { failDatasets = value; }, failKey(value = true) { failKey = value; },
    members(value) { members = value; },
    failAccount(value) { failMe = value; }, rotate(value) { currentGeneration = value; },
    failToken(value) { failToken = value; },
    refusePut(value = true) { refusePut = value; }, revoke(value = true) { revoked = value; },
    capabilities(value, name) { managedSync = value; displayName = name; },
    pauseDatasets() { let enter, release; const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; }); datasetGate = { enter, wait }; return { entered, release }; },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); await timer.callback(); } await new Promise(setImmediate); },
  };
}
const event = (overrides = {}) => ({ type: 'object_added', ownerType: 'space', ownerId: 'space-a', datasetId: 'dataset-a', path: `kg1/project/${randomUUID()}/${randomUUID()}/checkpoints/1-${randomUUID()}.hzs`, ...overrides });

for (const route of ['me', 'token']) for (const failure of ['network', 'timeout', 503, 429]) test(`stored sign-in recovers automatically from launch ${route} ${failure} with backoff`, async t => {
  const f = await fixture(t, route === 'me' ? { initialFailure: failure } : { tokenFailure: failure });
  assert.equal(f.account.state().status, 'error');
  const reads = () => f.calls.filter(call => call.path === (route === 'me' ? '/v1/me' : '/v1/oauth/token')).length;
  await f.advance(4999); assert.equal(reads(), 0);
  await f.advance(1); assert.equal(reads(), 1);
  await f.advance(9999); assert.equal(reads(), 1);
  await f.advance(1); assert.equal(reads(), 2);
  f.failAccount(false); f.failToken(false);
  await f.advance(19999); assert.equal(reads(), 2);
  await f.advance(1); assert.equal(reads(), 3);
  assert.equal(f.account.state().status, 'signedIn'); assert.equal(f.account.state().phrase, 'ready');
  assert.equal(f.readers.subscriptions, 1);
  const recoveredReads = reads(); await f.advance(60000); assert.equal(reads(), recoveredReads);
});

for (const route of ['me', 'token']) for (const retryAfter of [60, new Date(1060000).toUTCString()]) test(`launch ${route} retry respects Retry-After ${retryAfter} and stops on cancel`, async t => {
  const f = await fixture(t, { retryAfter, ...(route === 'me' ? { initialFailure: 429 } : { tokenFailure: 503 }) });
  await f.advance(59999); assert.equal(f.calls.length, 0);
  await f.advance(1); assert.equal(f.calls.length, 1);
  f.account.cancel(); await f.advance(900000); assert.equal(f.calls.length, 1);
  assert.equal(f.account.state().status, 'signedOut');
});

for (const failure of [401, 'invalid_grant']) test(`confirmed launch authorization failure ${failure} ends automatic restoration`, async t => {
  const f = await fixture(t, failure === 401 ? { initialFailure: 401 } : { tokenFailure: failure });
  assert.equal(f.account.state().status, failure === 401 ? 'error' : 'signedOut');
  await f.advance(900000); assert.equal(f.calls.length, 0);
});

test('Space listener failures remain account errors while the aggregate cursor can advance', async t => {
  const f = await fixture(t); f.fail();
  await f.advance(30001);
  await assert.doesNotReject(f.emit([event()])); await f.advance(0);
  assert.equal(f.account.state().spacesError, 'ACCOUNT_NETWORK');
  f.fail(false); await f.advance(30001); await f.account.refreshSpaces();
  assert.equal(f.account.state().spacesError, null);
});

test('Space refresh failure does not block the real broker cursor or personal sync consumer', async t => {
  const f = await fixture(t, { broker: true }), received = [], source = f.account.quantumSync([randomUUID()]);
  const unsubscribe = source.subscribeChanges(async page => { if (page) received.push(page.cursor); }); t.after(unsubscribe);
  await f.emit([], 'second-profile-bootstrap');
  f.fail(); await f.advance(30001);
  assert.equal(f.account.state().spacesError, 'ACCOUNT_NETWORK');
  await f.emit([event()], 'after-space-failure'); await f.advance(30001);
  assert.equal(f.account.state().spacesError, 'ACCOUNT_NETWORK');
  assert.equal(received.at(-1), 'after-space-failure'); assert.equal(f.feedCalls.at(-1), 'after-space-failure');
  assert.ok(f.cursors.includes('after-space-failure'));
});

test('Space content events coalesce named datasets under the refresh throttle without invalidating access', async t => {
  const f = await fixture(t), revision = f.readers.context().accessRevision, clears = f.readers.clears;
  await f.emit([event({ type: 'dataset_created', path: null, ownerType: 'account' })]);
  assert.equal(f.calls.length, 0);
  for (let index = 0; index < 20; index++) await f.emit([event()]);
  assert.equal(f.calls.length, 0);
  f.changeTime(200); await f.advance(30001);
  assert.equal(f.calls.filter(call => call.path === '/v1/spaces/space-a/datasets').length, 1);
  assert.equal(f.calls.some(call => call.path === '/v1/spaces' || call.path.includes('/space-b/') || call.path.includes('/dataset-b/')), false);
  assert.equal(f.readers.context().accessRevision, revision); assert.equal(f.readers.clears, clears);
  assert.equal(f.account.state().shared.find(row => row.datasetId === 'dataset-a').updatedAt, new Date(200).toISOString());
});

test('Space deletion and rebuild preserve unrelated snapshots and publication access', async t => {
  const f = await fixture(t), revision = f.readers.context().accessRevision, clears = f.readers.clears;
  await f.emit([event({ type: 'dataset_deleted', datasetId: 'dataset-b', path: null })]);
  assert.equal(f.readers.context().accessRevision, revision); assert.equal(f.readers.clears, clears);
  assert.equal(f.account.state().shared.some(row => row.spaceId === 'space-a' && row.datasetId === 'dataset-b'), false);
  assert.equal(f.account.state().shared.some(row => row.spaceId === 'space-a' && row.datasetId === 'dataset-a'), true);
  assert.equal(f.readers.context().accessRevision, revision); assert.equal(f.readers.clears, clears);
  await f.emit(null); await f.advance(30001);
  assert.equal(f.readers.context().accessRevision, revision); assert.equal(f.readers.clears, clears);
});

test('Space rebuild and unchanged account refresh preserve opened snapshots and publish access', async t => {
  const f = await fixture(t), revision = f.readers.context().accessRevision, clears = f.readers.clears;
  await f.emit(null); await f.advance(30001); await f.account.me();
  assert.equal(f.readers.context().accessRevision, revision); assert.equal(f.readers.clears, clears);
});

test('Space generation recovery preserves the opened reader after a transient account refresh error', async t => {
  const f = await fixture(t), revision = f.readers.context().accessRevision, clears = f.readers.clears;
  f.failAccount(true); await assert.rejects(f.account.me(), /ACCOUNT_NETWORK/);
  assert.equal(f.account.state().status, 'signedIn'); assert.ok(f.readers.context());
  f.rotate(2); f.failAccount(false); await f.account.me();
  assert.equal(f.account.state().spaces[0].currentGeneration, 2);
  assert.equal(f.readers.context().accessRevision, revision);
  assert.equal(f.readers.clears, clears, 'a retained member can continue reading its opened snapshot');
});

for (const failure of [503, 'network']) test(`signed-in ${failure} account refresh retains receive access and retries with backoff`, async t => {
  const f = await fixture(t), profiles = [randomUUID()], source = f.account.quantumSync(profiles), before = f.account.state(), reader = f.readers.context();
  const subscriptions = f.readers.subscriptions, unsubscribes = f.readers.unsubscribes;
  f.failAccount(failure); await assert.rejects(f.account.me(), /ACCOUNT_NETWORK/);
  assert.equal(f.account.state().status, 'signedIn'); assert.equal(f.account.state().managedSync, before.managedSync);
  assert.deepEqual(f.account.state().shared, before.shared); assert.deepEqual(f.readers.context(), reader);
  assert.equal(f.account.state().spacesError, 'ACCOUNT_NETWORK'); assert.equal(f.account.quantumSync(profiles).revision, source.revision);
  assert.equal(f.readers.subscriptions, subscriptions); assert.equal(f.readers.unsubscribes, unsubscribes);
  await assert.doesNotReject(source.request('/v1/bootstrap'));
  const reads = () => f.calls.filter(call => call.path === '/v1/me').length;
  const initial = reads(); await f.advance(4999); assert.equal(reads(), initial);
  await f.advance(1); assert.equal(reads(), initial + 1);
  await f.advance(9999); assert.equal(reads(), initial + 1);
  f.failAccount(false); await f.advance(1); assert.equal(reads(), initial + 2);
  assert.equal(f.account.state().spacesError, null); assert.equal(f.account.quantumSync(profiles).revision, source.revision);
  assert.equal(f.readers.unsubscribes, unsubscribes);
});

test('signed-in account refresh retries respect Retry-After and stop after sign-out', async t => {
  const f = await fixture(t, { retryAfter: 60 }); f.failAccount(503);
  await assert.rejects(f.account.me(), /ACCOUNT_NETWORK/);
  const reads = () => f.calls.filter(call => call.path === '/v1/me').length, before = reads();
  await f.advance(59999); assert.equal(reads(), before);
  await f.advance(1); assert.equal(reads(), before + 1);
  await f.account.signOut(); await f.advance(900000); assert.equal(reads(), before + 1);
});

for (const failure of [401, 'revoked']) test(`confirmed ${failure} account access loss stops signed-in consumers`, async t => {
  const f = await fixture(t), source = f.account.quantumSync([randomUUID()]);
  if (failure === 'revoked') f.revoke(); else f.failAccount(401);
  await assert.rejects(f.account.me());
  assert.equal(f.account.state().status, 'error'); assert.equal(f.readers.context(), undefined);
  assert.throws(source.assertActive); assert.equal(f.readers.unsubscribes, 1);
});

test('Space events from another account sharing this installation computer are refreshed', async t => {
  const f = await fixture(t);
  await f.emit([event({ path: `kg1/project/${f.device}/${randomUUID()}/checkpoints/1-${randomUUID()}.hzs` })]);
  await f.advance(30001);
  assert.equal(f.calls.filter(call => call.path === '/v1/spaces/space-a/datasets').length, 1);
});

test('Space own-write suppression belongs to the account connection and exact object operation', async t => {
  const f = await fixture(t, { shareRequests: true }), path = `kg1/project/${f.device}/${randomUUID()}/checkpoints/1-${randomUUID()}.hzs`;
  await f.shareRequest(`/v1/spaces/space-a/datasets/dataset-a/objects/${path}`, 'PUT', Buffer.from('own checkpoint'));
  f.calls.length = 0;
  await f.emit([event({ path })]); await f.advance(30001);
  assert.equal(f.calls.length, 0, 'this account connection already applied its own object addition');
  await f.emit([event({ type: 'object_deleted', path })]); await f.advance(30001);
  assert.equal(f.calls.filter(call => call.path === '/v1/spaces/space-a/datasets').length, 1, 'a peer deletion of the same path is still received');
});

test('Space listings merge into the latest capability and account card', async t => {
  const f = await fixture(t), gate = f.pauseDatasets(); t.after(gate.release);
  await f.emit([event()]);
  const refreshing = f.advance(30001); await gate.entered;
  f.capabilities(false, 'Updated while Space listing waited'); await f.account.me();
  gate.release(); await refreshing;
  assert.equal(f.account.state().managedSync, false);
  assert.equal(f.account.state().displayName, 'Updated while Space listing waited');
});

test('Space control events refresh only named Spaces and preserve immediate access removal', async t => {
  const f = await fixture(t);
  await f.emit([event({ type: 'key_generation_committed', datasetId: null, path: null })]);
  await f.advance(30001);
  assert.equal(f.calls.filter(call => call.path === '/v1/spaces').length, 1);
  assert.equal(f.calls.some(call => call.path.includes('/space-b/')), false);
  assert.equal(f.account.state().spaces.length, 2);
  const before = f.calls.length;
  await f.emit([event({ type: 'member_removed', datasetId: null, path: null, memberId: 'account-a' })]);
  assert.equal(f.account.state().spaces.some(space => space.id === 'space-a'), false);
  await f.advance(30001); assert.equal(f.calls.length, before);
});

test('Space content updates and unrelated Space access preserve the opened project image snapshot', async () => {
  const space = 'space-a', dataset = randomUUID(), writer = randomUUID(), generation = randomUUID(), id = randomUUID();
  const base = `kg1/project/${writer}/${generation}/`, manifest = Buffer.from(JSON.stringify({ keyGeneration: 1 })), checkpoint = Buffer.alloc(12); checkpoint.writeUInt32BE(1, 8);
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex'), files = new Map([[`${base}dataset.hzs`, manifest], [`${base}checkpoints/1-${id}.hzs`, checkpoint]]);
  const row = { spaceId: space, datasetId: dataset, sharedBy: { accountId: 'peer', displayName: null }, updatedAt: new Date(100).toISOString(), size: 100, title: 'Shared' };
  let current = { accountId: 'account-a', session: 1, accessRevision: 1, accessRevisions: { [space]: 1 }, spaces: [{ id: space, pending: false, currentGeneration: 1, members: [{ accountId: 'account-a' }] }], shared: [row] }, release;
  const hold = new Promise(done => { release = done; }), exports = {}, localRequire = createRequire(join(__dirname, '../dist/electron/space-reader.js'));
  runInNewContext(readFileSync(join(__dirname, '../dist/electron/space-reader.js'), 'utf8'), {
    exports, Buffer, URLSearchParams, structuredClone,
    require(name) {
      if (name === './space-sharing') return { openProjectManifest: async () => ({ title: 'Shared' }), validateSpaceCheckpoint() {}, openSpacePackage: (_key, identity) => identity.kind === 'blob' ? png : {
        project: { name: 'Shared', folders: [], items: [{ id, kind: 'capture', image: { width: 1, height: 1, bytes: png.length, cut: null, blob: { id, keyGeneration: 1 } } }] },
      } };
      return localRequire(name);
    },
  });
  const reader = exports.createSharedProjects({ context: () => current, key: async () => ({ key: randomBytes(32) }), async request(route) {
    if (route.includes('?')) {
      await hold;
      return { ok: true, value: { objects: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: 100 })), after: null } };
    }
    return { ok: true, value: files.get(route.split('/objects/')[1]) ?? png };
  } });
  const opening = reader.openSharedProject(space, dataset);
  current = { ...current, shared: [{ ...row, updatedAt: new Date(200).toISOString() }] }; release();
  const opened = await opening;
  current = { ...current, accessRevision: 2, accessRevisions: { [space]: 1, 'other-space': 1 }, shared: [{ ...row, updatedAt: new Date(300).toISOString() }] };
  assert.deepEqual(await reader.image(null, opened.items[0].id), png);
  current = { ...current, spaces: [{ ...current.spaces[0], pending: true, stale: true }], shared: [{ ...row, stale: true }] };
  assert.deepEqual(await reader.image(null, opened.items[0].id), png, 'a failed Space key refresh retains the opened image');
  assert.equal(reader.item(null, opened.items[0].id).id, opened.items[0].id, 'Ask Lyra can still look up the opened item');
  current = { ...current, shared: [] };
  await assert.rejects(reader.image(null, opened.items[0].id), /SPACE_SHARED_UNAVAILABLE/);
});


test('Space invitations for another member preserve every existing access snapshot', async t => {
  const f = await fixture(t), before = f.readers.context(), clears = f.readers.clears;
  await f.emit([event({ type: 'member_added', datasetId: null, path: null, memberId: 'another-member' })]);
  await f.advance(30001);
  assert.equal(f.readers.clears, clears);
  assert.deepEqual(f.readers.context().accessRevisions, before.accessRevisions);
});

test('Space access loss invalidates only the affected reader and removes its datasets', async t => {
  const f = await fixture(t), before = f.readers.context(), clears = f.readers.clearedSpaces.length;
  await f.emit([event({ type: 'member_removed', datasetId: null, path: null, memberId: 'account-a' })]);
  assert.ok(f.readers.context().accessRevisions['space-a'] > (before.accessRevisions['space-a'] ?? 0));
  assert.equal(f.readers.context().accessRevisions['space-b'], before.accessRevisions['space-b']);
  assert.ok(f.readers.clearedSpaces.slice(clears).every(id => id === 'space-a'));
  assert.equal(f.account.state().shared.some(row => row.spaceId === 'space-a'), false);
});

test('Space deletion wins over an older in-flight dataset listing', async t => {
  const f = await fixture(t), gate = f.pauseDatasets(); t.after(gate.release);
  await f.emit([event()]); const refresh = f.advance(30001); await gate.entered;
  await f.emit([event({ type: 'dataset_deleted', datasetId: 'dataset-b', path: null })]);
  gate.release(); await refresh;
  assert.equal(f.account.state().shared.some(row => row.spaceId === 'space-a' && row.datasetId === 'dataset-b'), false);
  assert.equal(f.account.state().spaces.some(space => space.id === 'space-b'), true);
});

test('Space newer dataset listing wins over an older in-flight refresh', async t => {
  const f = await fixture(t), gate = f.pauseDatasets(); t.after(gate.release);
  await f.emit([event()]); const refresh = f.advance(30001); await gate.entered;
  f.changeTime(300); await f.account.me();
  gate.release(); await refresh;
  assert.equal(f.account.state().shared.find(row => row.spaceId === 'space-a' && row.datasetId === 'dataset-a').updatedAt, new Date(300).toISOString());
});


test('Space deletion wins over an older full account refresh', async t => {
  const f = await fixture(t), gate = f.pauseDatasets(); t.after(gate.release);
  const refresh = f.account.me(); await gate.entered;
  await f.emit([event({ type: 'dataset_deleted', datasetId: 'dataset-b', path: null })]);
  gate.release(); await refresh;
  assert.equal(f.account.state().shared.some(row => row.spaceId === 'space-a' && row.datasetId === 'dataset-b'), false);
});

for (const failure of ['listing', 'key', 'spaces']) test(`Space full refresh retains stale datasets and reader access after failed ${failure}`, async t => {
  const f = await fixture(t), before = f.account.state().shared, readerRevision = f.readers.context().accessRevisions, clears = f.readers.clears;
  if (failure === 'listing') f.failDatasets(); else if (failure === 'key') f.failKey(); else f.fail();
  await f.account.me();
  assert.equal(f.account.state().status, 'signedIn');
  assert.equal(f.account.state().spacesError, 'ACCOUNT_NETWORK');
  assert.equal(f.account.state().shared.length, before.length);
  assert.ok(f.account.state().shared.every(dataset => dataset.stale === true));
  assert.deepEqual(f.account.state().shared.map(dataset => { const copy = { ...dataset }; delete copy.stale; return copy; }), before);
  assert.deepEqual(f.readers.context().accessRevisions, readerRevision); assert.equal(f.readers.clears, clears);
  f.failDatasets(false); f.failKey(false); f.fail(false); await f.account.me();
  assert.ok(f.account.state().shared.every(dataset => !dataset.stale));
});

test('Space member and generation changes retain reader entries while this account keeps access', async t => {
  const f = await fixture(t), clears = f.readers.clears, revisions = f.readers.context().accessRevisions;
  for (const type of ['member_added', 'member_removed', 'key_generation_committed']) {
    await f.emit([event({ type, datasetId: null, path: null, memberId: 'another-member' })]);
    await f.advance(30001);
    assert.equal(f.readers.clears, clears); assert.deepEqual(f.readers.context().accessRevisions, revisions);
  }
  f.members([{ accountId: 'peer-member', displayName: null, role: 'member' }]); await f.account.me();
  assert.equal(f.readers.clears, clears); assert.deepEqual(f.readers.context().accessRevisions, revisions);
});

test('a failed Space listing retains only its stale datasets while other Spaces refresh', async t => {
  const f = await fixture(t); f.failDatasets('space-a'); f.changeTime(200); await f.account.me();
  const rows = f.account.state().shared;
  assert.ok(rows.filter(dataset => dataset.spaceId === 'space-a').every(dataset => dataset.stale && dataset.updatedAt === new Date(100).toISOString()));
  assert.ok(rows.filter(dataset => dataset.spaceId === 'space-b').every(dataset => !dataset.stale && dataset.updatedAt === new Date(200).toISOString()));
});

test('unchanged capability refreshes keep the engine revision and only a new grant changes it', async t => {
  const f = await fixture(t), profiles = [randomUUID()], revision = () => f.account.quantumSync(profiles).revision;
  const before = revision(); await f.account.me(); await f.account.retry(); assert.equal(revision(), before);
  f.capabilities(false); await f.account.me(); assert.equal(revision(), before, 'losing publish permission must retain receive retries');
  f.capabilities(true); await f.account.me(); assert.notEqual(revision(), before);
  const granted = revision(); await f.account.me(); assert.equal(revision(), granted);
});

test('sync plan refusal with an unchanged grant retains the hold revision and backs off capability reads', async t => {
  const f = await fixture(t), profiles = [randomUUID()], source = f.account.quantumSync(profiles), before = source.revision;
  f.refusePut();
  const response = await source.request(`/v1/datasets/${randomUUID()}/objects/writers/x/y/batches/1-a.hzs`, { method: 'PUT' });
  assert.equal(response.status, 403); f.calls.length = 0;
  await f.advance(0); assert.equal(f.account.quantumSync(profiles).revision, before);
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/entitlements']);
  f.calls.length = 0; await f.advance(59999); assert.equal(f.calls.length, 0);
  for (let check = 0; check < 4; check++) { await f.advance(check === 0 ? 1 : 60000); assert.equal(f.account.quantumSync(profiles).revision, before); }
  assert.equal(f.calls.length, 4);
  f.calls.length = 0; await f.advance(899999); assert.equal(f.calls.length, 0);
  await f.advance(1); assert.deepEqual(f.calls.filter(call => call.path !== '/v1/oauth/token').map(call => call.path), ['/v1/entitlements']);
  f.capabilities(false); await f.account.me(); assert.equal(f.account.quantumSync(profiles).revision, before);
  f.capabilities(true); await f.advance(900000); assert.notEqual(f.account.quantumSync(profiles).revision, before);
});

test('a successful sync write ends capability polling after a plan refusal', async t => {
  const f = await fixture(t), source = f.account.quantumSync([randomUUID()]), route = `/v1/datasets/${randomUUID()}/objects/writers/x/y/batches/1-a.hzs`;
  f.refusePut(); assert.equal((await source.request(route, { method: 'PUT' })).status, 403);
  await f.advance(0); f.refusePut(false);
  assert.equal((await source.request(route, { method: 'PUT' })).status, 200); await f.advance(0);
  f.calls.length = 0; await f.advance(900000); assert.equal(f.calls.length, 0);
});

test('Space publishing refusal rechecks entitlements and exposes only a new grant to held publishers', async t => {
  const f = await fixture(t, { shareRequests: true }), revision = () => f.readers.sharingContext().capabilityRevision;
  const before = revision(); f.refusePut();
  assert.equal((await f.shareRequest('/v1/spaces/space-a/datasets/dataset-a/objects/checkpoint.hzs', 'PUT', Buffer.from('checkpoint'))).status, 403);
  f.calls.length = 0; await f.advance(0);
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/entitlements']); assert.equal(revision(), before);
  f.capabilities(false); await f.advance(60000); assert.equal(revision(), before);
  f.capabilities(true); await f.advance(60000); assert.notEqual(revision(), before);
});

test('consent refusal fetching a Space publish key recovers through held entitlement rechecks', async t => {
  const f = await fixture(t, { shareRequests: true }), before = f.readers.sharingContext().capabilityRevision;
  f.failKey('consent'); await assert.rejects(f.readers.sharingKey('space-a'), /ACCOUNT_CONSENT/);
  assert.equal(f.account.state().consent, 'required');
  const refused = f.readers.sharingContext().capabilityRevision; assert.notEqual(refused, before);
  f.calls.length = 0; await f.advance(0);
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/entitlements']);
  f.failKey(false); await f.advance(60000);
  assert.equal(f.account.state().consent, 'accepted'); assert.notEqual(f.readers.sharingContext().capabilityRevision, refused);
});
