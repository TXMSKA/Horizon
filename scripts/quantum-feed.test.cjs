const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { runInNewContext } = require('node:vm');

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.ok(predicate(), 'Aggregate feed did not reach the expected state');
}
function fixture(t, initial = { cursor: 'initial-cursor', changes: [], retryAfterMs: 0 }, options = {}) {
  const holds = [], writes = [], calls = [], waits = [], requests = [], exported = {};
  const account = { accountId: 'canonical-account', assertActive() {}, async request(path) { requests.push(path); return { ok: true, json: async () => ({ accountId: account.accountId }) }; } };
  runInNewContext(readFileSync(join(__dirname, '../dist/electron/quantum-feed.js'), 'utf8'), {
    exports: exported, AbortController, Date: options.now ? { now: options.now } : Date,
    setTimeout: options.fakeTimers ? (callback, delay) => { const timer = { callback, delay, unref() {} }; waits.push(timer); return timer; } : setTimeout,
    clearTimeout: options.fakeTimers ? () => {} : clearTimeout,
    require(name) {
      if (name === './vault-storage') return { readVaultFile: options.readVaultFile ?? (() => undefined), writeVaultFile(path, value) { writes.push({ profile: dirname(path), ...value }); options.writeVaultFile?.(path, value); } };
      if (name === './sync-quantum') return { async fetchQuantumChanges(source, cursor, signal) {
        calls.push({ source, cursor, signal });
        if (calls.length === 1 && !options.holdFirst) return initial;
        const hold = deferred(); holds.push(hold); return hold.promise;
      } };
      return require(name);
    },
  });
  const subscriptions = [];
  t.after(() => { for (const unsubscribe of subscriptions) unsubscribe(); });
  return { holds, writes, calls, waits, requests, subscribe(profile, listener, source = account) {
    const unsubscribe = exported.subscribeQuantumChanges({ account: source, directory: profile, cipher: {}, listener });
    subscriptions.push(unsubscribe); return unsubscribe;
  } };
}

test('aggregate broker persists only subscribers that finished the delivered page during a late profile bootstrap', async t => {
  const feed = fixture(t), started = deferred(), release = deferred(), bootstrap = deferred(), events = [];
  feed.subscribe('profile-a', async page => { if (page?.cursor === 'second-cursor') { started.resolve(); await release.promise; } });
  await until(() => feed.holds.length === 1);
  feed.holds.shift().resolve({ cursor: 'second-cursor', changes: [], retryAfterMs: 0 }); await started.promise;
  feed.subscribe('profile-b', async page => {
    if (page === null) { events.push('bootstrap-start'); await bootstrap.promise; events.push('bootstrap-finish'); }
    else events.push(page.cursor);
  });
  await until(() => events.includes('bootstrap-start'));
  release.resolve(); await until(() => feed.holds.length === 1);
  assert.deepEqual(events, ['bootstrap-start']);
  assert.equal(feed.writes.some(write => write.profile.endsWith('profile-b')), false);
  feed.holds.shift().resolve({ cursor: 'third-cursor', changes: [], retryAfterMs: 0 });
  await new Promise(setImmediate);
  assert.equal(feed.writes.some(write => write.profile.endsWith('profile-b')), false);
  bootstrap.resolve(); await until(() => feed.writes.some(write => write.profile.endsWith('profile-b')));
  assert.deepEqual(events, ['bootstrap-start', 'bootstrap-finish', 'third-cursor']);
  assert.equal(feed.writes.find(write => write.profile.endsWith('profile-b')).cursor, 'third-cursor');
});

test('aggregate broker checkpoints randomized empty cursors only every ten minutes and changed pages immediately', async t => {
  let now = 0;
  const feed = fixture(t, undefined, { now: () => now });
  feed.subscribe('profile-a', async () => {});
  await until(() => feed.holds.length === 1);
  assert.equal(feed.writes.length, 1);
  for (let read = 1; read <= 23; read++) {
    now += 25000;
    feed.holds.shift().resolve({ cursor: `empty-${read}`, changes: [], retryAfterMs: 0 });
    await until(() => feed.holds.length === 1);
    assert.equal(feed.calls.at(-1).cursor, `empty-${read}`);
    assert.equal(feed.writes.length, 1, `empty read ${read} must stay in memory`);
  }
  now += 25000;
  feed.holds.shift().resolve({ cursor: 'ten-minutes', changes: [], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.writes.length, 2); assert.equal(feed.writes.at(-1).cursor, 'ten-minutes');
  now += 1;
  feed.holds.shift().resolve({ cursor: 'change', changes: [{ seq: 1, type: 'dataset_created' }], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.writes.length, 3); assert.equal(feed.writes.at(-1).cursor, 'change');
});

test('aggregate broker reuses a stored checkpoint during empty holds and retries a failed changed-page checkpoint', async t => {
  let now = 1000, fail = true;
  const feed = fixture(t, undefined, { now: () => now,
    readVaultFile: () => ({ accountId: 'canonical-account', cursor: 'stored' }),
    writeVaultFile() { if (fail) throw new Error('VAULT_STORAGE_UNAVAILABLE'); } });
  feed.subscribe('profile-a', async () => {});
  await until(() => feed.holds.length === 1);
  assert.equal(feed.writes.length, 0);
  now += 25000;
  feed.holds.shift().resolve({ cursor: 'changed', changes: [{ seq: 1, type: 'dataset_created' }], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1); assert.equal(feed.writes.length, 1);
  fail = false;
  feed.holds.shift().resolve({ cursor: 'retry-checkpoint', changes: [], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.writes.length, 2); assert.equal(feed.writes.at(-1).cursor, 'retry-checkpoint');
});

test('aggregate stored-cursor recovery shares one bootstrap per profile and rebuilds each consumer once', async t => {
  const feed = fixture(t, undefined, { holdFirst: true,
    readVaultFile: () => ({ accountId: 'canonical-account', cursor: 'stored' }) }), first = [], second = [];
  feed.subscribe('profile-a', async page => first.push(page));
  feed.subscribe('profile-a', async page => second.push(page));
  await until(() => feed.holds.length === 1);
  feed.holds.shift().resolve({ cursor: 'history', changes: Array.from({ length: 1000 }, (_, seq) => ({ seq: seq + 1, type: 'object_added' })), retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(first.length, 0); assert.equal(second.length, 0);
  feed.holds.shift().resolve({ cursor: 'captured', changes: [{ seq: 1001, type: 'object_deleted' }], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(first.filter(page => page === null).length, 1);
  assert.equal(second.filter(page => page === null).length, 1);
  assert.equal(feed.requests.length, 1);
});

test('aggregate cursor expiry captures a fresh cursor and rebuilds ready consumers once per recovery', async t => {
  const feed = fixture(t), pages = [];
  feed.subscribe('profile-a', async page => pages.push(page));
  await until(() => feed.holds.length === 1);
  assert.equal(feed.requests.length, 1);
  feed.holds.shift().reject(Object.assign(new Error('SYNC_INVALID'), { bootstrap: true }));
  await until(() => feed.holds.length === 1);
  assert.equal(feed.calls.at(-1).cursor, undefined);
  assert.equal(pages.filter(page => page === null).length, 1);
  feed.holds.shift().resolve({ cursor: 'fresh-capture', changes: [], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.requests.length, 2);
  assert.equal(pages.filter(page => page === null).length, 2);
  assert.equal(feed.calls.at(-1).cursor, 'fresh-capture');
  const change = { seq: 1, type: 'object_added' };
  feed.holds.shift().resolve({ cursor: 'during-rebuild', changes: [change], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.deepEqual(pages.at(-1).changes, [change]);
  assert.equal(pages.filter(page => page === null).length, 2);
});

test('aggregate broker drains historical pages before rebuilding and does not replay old additions over current listings', async t => {
  const historical = Array.from({ length: 1000 }, (_, seq) => ({ seq: seq + 1, type: 'object_added' }));
  const feed = fixture(t, { cursor: 'historical-cursor', changes: historical, retryAfterMs: 0 }), pages = [];
  feed.subscribe('profile-a', async page => { pages.push(page); });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.calls.at(-1).cursor, 'historical-cursor'); assert.equal(pages.length, 0); assert.equal(feed.writes.length, 0);
  feed.holds.shift().resolve({ cursor: 'current-cursor', changes: [{ seq: 1001, type: 'object_deleted' }], retryAfterMs: 0 });
  await until(() => feed.writes.length === 1);
  assert.equal(pages[0], null); assert.equal(pages[1].changes.length, 0); assert.equal(pages[1].cursor, 'current-cursor');
  assert.equal(feed.calls.at(-1).cursor, 'current-cursor');
});

test('aggregate broker drains full raw pages including skipped changes before rebuilding', async t => {
  const changes = Array.from({ length: 999 }, (_, seq) => ({ seq: seq + 1, type: 'object_added' }));
  const feed = fixture(t, { cursor: 'history', changes, skippedChanges: 1, retryAfterMs: 0 }), pages = [];
  feed.subscribe('profile-a', async page => pages.push(page));
  await until(() => feed.holds.length === 1);
  assert.equal(pages.length, 0);
  feed.holds.shift().resolve({ cursor: 'current', changes: [], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.deepEqual(pages.map(page => page?.cursor ?? null), [null, 'current']);
});

test('aggregate broker aborts its sole held request and cannot persist a late response after unsubscribe', async t => {
  const feed = fixture(t), pages = [], unsubscribe = feed.subscribe('profile-a', async page => { pages.push(page?.cursor ?? null); });
  await until(() => feed.holds.length === 1);
  const before = feed.writes.length, hold = feed.holds.shift(), signal = feed.calls.at(-1).signal;
  unsubscribe(); assert.equal(signal.aborted, true);
  hold.resolve({ cursor: 'revoked-cursor', changes: [], retryAfterMs: 0 }); await new Promise(setImmediate);
  assert.equal(feed.writes.length, before);
  assert.deepEqual(pages, [null, 'initial-cursor']);
});

test('aggregate broker switches to a live profile after the first profile signs out during a hold', async t => {
  const feed = fixture(t), firstPages = [], secondPages = [];
  let active = true;
  const first = { accountId: 'canonical-account', assertActive() { if (!active) throw new Error('ACCOUNT_DENIED'); }, async request() { this.assertActive(); return { ok: true, json: async () => ({ accountId: this.accountId }) }; } };
  const second = { ...first, assertActive() {} };
  feed.subscribe('profile-a', async page => { first.assertActive(); firstPages.push(page?.cursor ?? null); }, first);
  await until(() => feed.holds.length === 1);
  feed.subscribe('profile-b', async page => { secondPages.push(page?.cursor ?? null); }, second);
  active = false;
  feed.holds.shift().reject(new Error('ACCOUNT_DENIED'));
  await until(() => feed.holds.length === 1);
  assert.equal(feed.calls.at(-1).source, second);
  feed.holds.shift().resolve({ cursor: 'after-signout', changes: [{ seq: 1, type: 'object_added' }], retryAfterMs: 0 });
  await until(() => secondPages.includes('after-signout'));
  assert.deepEqual(firstPages, [null, 'initial-cursor']);
  assert.deepEqual(secondPages, [null, 'after-signout']);
  feed.holds.shift().resolve({ cursor: 'live-change', changes: [{ seq: 2, type: 'object_added' }], retryAfterMs: 0 });
  await until(() => secondPages.includes('live-change'));
  assert.equal(feed.calls.at(-1).source, second);
});

test('aggregate broker rebuilds and replaces an unreadable sealed cursor', async t => {
  let reads = 0;
  const feed = fixture(t, undefined, { readVaultFile() { reads++; throw new Error('VAULT_STORAGE_UNAVAILABLE'); } }), pages = [];
  feed.subscribe('profile-a', async page => { pages.push(page?.cursor ?? null); });
  await until(() => feed.holds.length === 1);
  assert.equal(reads, 1);
  assert.equal(feed.calls[0].cursor, undefined);
  assert.deepEqual(pages, [null, 'initial-cursor']);
  assert.equal(feed.writes[0].cursor, 'initial-cursor');
});

test('aggregate broker skips a profile that signs out while another listener applies a page', async t => {
  const feed = fixture(t), started = deferred(), release = deferred(), pages = [];
  let active = true;
  const second = { accountId: 'canonical-account', assertActive() { if (!active) throw new Error('ACCOUNT_DENIED'); }, async request() { return { ok: true, json: async () => ({ accountId: this.accountId }) }; } };
  feed.subscribe('profile-a', async page => { if (page?.cursor === 'concurrent-signout') { started.resolve(); await release.promise; } });
  await until(() => feed.holds.length === 1);
  feed.subscribe('profile-b', async page => { second.assertActive(); pages.push(page?.cursor ?? null); }, second);
  feed.holds.shift().resolve({ cursor: 'both-ready', changes: [], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  feed.holds.shift().resolve({ cursor: 'concurrent-signout', changes: [], retryAfterMs: 0 });
  await started.promise;
  active = false; release.resolve();
  await until(() => feed.holds.length === 1);
  assert.deepEqual(pages, [null, 'both-ready']);
  assert.equal(feed.calls.at(-1).cursor, 'concurrent-signout');
  assert.equal(feed.writes.some(write => write.profile.endsWith('profile-b') && write.cursor === 'concurrent-signout'), false);
});

test('Horizon aggregate pages accept app-neutral Space membership and skip foreign app dataset events', async () => {
  const { fetchQuantumChanges } = require('../dist/electron/sync-quantum.js');
  const row = { seq: 1, type: 'member_removed', ownerType: 'space', ownerId: 'shared-space', appId: null, datasetId: null,
    path: null, size: null, sha256: null, memberId: 'canonical-account', generation: null, createdAt: 1 };
  let changes = [row];
  const source = { accountId: 'canonical-account', assertActive() {}, request: async () => Response.json({ changes, cursor: 'next-cursor' }) };
  assert.equal((await fetchQuantumChanges(source)).changes[0].appId, null);
  for (const ownerType of ['account', 'space']) {
    changes = [{ ...row, ownerType, ownerId: ownerType === 'account' ? source.accountId : row.ownerId,
      type: 'object_deleted', appId: 'blueprint', datasetId: 'foreign-dataset', path: 'kg1/writers/foreign/batches/1.enc' }];
    const page = await fetchQuantumChanges(source);
    assert.equal(page.changes.length, 0); assert.equal(page.skippedChanges, 1);
  }
});

test('Quantum HTTP refusals preserve Retry-After for receive and publish backoff', async () => {
  const { fetchQuantumChanges } = require('../dist/electron/sync-quantum.js');
  const cases = [[500, 'internal_error', 'SYNC_STORAGE'], [503, 'storage_unavailable', 'SYNC_STORAGE'],
    [401, 'unauthorized', 'SYNC_NOT_ALLOWED'], [403, 'sync_plan_required', 'SYNC_PLAN_REQUIRED'],
    [403, 'acceptance_required', 'SYNC_CONSENT_REQUIRED'], [403, 'forbidden', 'SYNC_NOT_ALLOWED'],
    [413, 'object_too_large', 'SYNC_LIMIT'], [409, 'object_conflict', 'SYNC_CONFLICT'],
    [409, 'pool_exceeded', 'SYNC_FULL'], [408, 'upload_timeout', 'SYNC_TIMEOUT'],
    [400, 'invalid_request', 'SYNC_INVALID'], [404, 'not_found', 'SYNC_INVALID'],
    [410, 'cursor_expired', 'SYNC_INVALID'], [429, 'rate_limited', 'SYNC_RATE_LIMITED']];
  for (const [status, code, message] of cases) {
    const source = { accountId: 'canonical-account', assertActive() {}, request: async () => Response.json({ error: { code } }, { status, headers: { 'Retry-After': '17' } }) };
    await assert.rejects(fetchQuantumChanges(source), error => error.message === message && error.retryAfterMs === 17000, `${status} ${code}`);
  }
});

test('a new aggregate subscriber rebuilds immediately without resetting or discarding existing consumers changes', async t => {
  const feed = fixture(t), first = [], second = [];
  feed.subscribe('profile-a', async page => first.push(page));
  await until(() => feed.holds.length === 1);
  feed.subscribe('profile-b', async page => second.push(page));
  await until(() => second.length === 1);
  assert.equal(second[0], null); assert.equal(feed.holds.length, 1);
  const change = { seq: 1, type: 'dataset_deleted', ownerType: 'space', ownerId: 'space-a', datasetId: 'dataset-a' };
  feed.holds.shift().resolve({ cursor: 'live', changes: [change], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(first.filter(page => page === null).length, 1);
  assert.deepEqual(first.at(-1).changes, [change]); assert.deepEqual(second.at(-1).changes, [change]);
});

test('aggregate subscribers wait for the first stored-cursor capture before rebuilding once', async t => {
  const feed = fixture(t, undefined, { holdFirst: true, readVaultFile: () => ({ accountId: 'canonical-account', cursor: 'stored' }) }), first = [], second = [];
  feed.subscribe('profile-a', async page => first.push(page));
  await until(() => feed.holds.length === 1);
  assert.equal(first.length, 0); assert.equal(feed.calls[0].cursor, 'stored');
  feed.subscribe('profile-b', async page => second.push(page));
  await new Promise(setImmediate);
  assert.equal(second.length, 0); assert.equal(feed.holds.length, 1);
  feed.holds.shift().resolve({ cursor: 'captured', changes: [], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(first.at(-1).cursor, 'captured'); assert.equal(second.at(-1).cursor, 'captured');
  assert.equal(first.filter(page => page === null).length, 1); assert.equal(second.filter(page => page === null).length, 1);
});

test('a failed newcomer rebuild cannot freeze or replay existing deliveries and retries on recovery', async t => {
  const feed = fixture(t), first = [], second = [];
  feed.subscribe('profile-a', async page => first.push(page));
  await until(() => feed.holds.length === 1);
  let recovered = false, attempts = 0;
  const source = { accountId: 'canonical-account', assertActive() {}, async request() {
    attempts++; if (!recovered) throw new Error('ACCOUNT_NETWORK');
    return { ok: true, json: async () => ({ accountId: this.accountId }) };
  } };
  feed.subscribe('profile-b', async page => second.push(page), source);
  await until(() => attempts === 1); await new Promise(setImmediate);
  feed.holds.shift().resolve({ cursor: 'while-unavailable', changes: [{ seq: 1, type: 'dataset_created' }], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.calls.at(-1).cursor, 'while-unavailable');
  assert.equal(first.filter(page => page?.cursor === 'while-unavailable').length, 1);
  assert.equal(feed.writes.some(write => write.profile.endsWith('profile-b')), false);
  recovered = true;
  feed.holds.shift().resolve({ cursor: 'recovered', changes: [{ seq: 2, type: 'dataset_created' }], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.deepEqual(second.map(page => page?.cursor ?? null), [null, 'recovered']);
  assert.equal(first.filter(page => page === null).length, 1);
  assert.equal(first.filter(page => page?.cursor === 'while-unavailable').length, 1);
  assert.equal(feed.writes.find(write => write.profile.endsWith('profile-b')).cursor, 'recovered');
});

test('aggregate broker writes only changed cursors and retries failed persistence without replaying a page', async t => {
  let fail = true;
  const feed = fixture(t, undefined, { writeVaultFile() { if (fail) throw new Error('VAULT_STORAGE_UNAVAILABLE'); } }), pages = [];
  feed.subscribe('profile-a', async page => pages.push(page));
  await until(() => feed.holds.length === 1);
  assert.equal(feed.calls.at(-1).cursor, 'initial-cursor');
  fail = false;
  feed.holds.shift().resolve({ cursor: 'initial-cursor', changes: [], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.writes.length, 2);
  feed.holds.shift().resolve({ cursor: 'initial-cursor', changes: [], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.writes.length, 2); assert.equal(pages.filter(page => page === null).length, 1);
  feed.holds.shift().resolve({ cursor: 'next', changes: [{ seq: 1, type: 'dataset_created' }], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(feed.writes.at(-1).cursor, 'next');
});

test('aggregate broker keeps one loop when eviction empties a feed during Retry-After', async t => {
  let live = true;
  const source = { accountId: 'canonical-account', assertActive() { if (!live) throw new Error('ACCOUNT_DENIED'); }, async request() { return { ok: true, json: async () => ({ accountId: this.accountId }) }; } };
  const feed = fixture(t, undefined, { fakeTimers: true });
  feed.subscribe('profile-a', async page => { if (page?.cursor === 'evicted') live = false; }, source);
  await until(() => feed.holds.length === 1);
  feed.holds.shift().resolve({ cursor: 'evicted', changes: [], retryAfterMs: 1000 });
  await until(() => feed.waits.length === 1);
  const count = feed.calls.length;
  feed.subscribe('profile-b', async () => {});
  await new Promise(setImmediate);
  assert.equal(feed.calls.length, count);
  feed.waits.shift().callback(); await until(() => feed.holds.length === 1);
  assert.equal(feed.calls.length, count + 1);
});

test('aggregate broker floors Retry-After zero errors to three seconds', async t => {
  const feed = fixture(t, undefined, { fakeTimers: true });
  feed.subscribe('profile-a', async () => {});
  await until(() => feed.holds.length === 1);
  feed.holds.shift().reject(Object.assign(new Error('SYNC_RATE_LIMITED'), { retryAfterMs: 0 }));
  await until(() => feed.waits.length === 1);
  assert.equal(feed.waits[0].delay, 3000);
});

test('aggregate broker grows repeated over-cap empty delays to 60 seconds and still receives changes', async t => {
  const feed = fixture(t, undefined, { fakeTimers: true }), pages = [];
  feed.subscribe('profile-a', async page => pages.push(page));
  await until(() => feed.holds.length === 1);
  for (const delay of [3000, 6000, 12000, 24000, 48000, 60000, 60000]) {
    feed.holds.shift().resolve({ cursor: 'initial-cursor', changes: [], retryAfterMs: 1000 });
    await until(() => feed.waits.length === 1); assert.equal(feed.waits[0].delay, delay);
    feed.waits.shift().callback(); await until(() => feed.holds.length === 1);
  }
  feed.holds.shift().resolve({ cursor: 'change', changes: [{ seq: 1, type: 'dataset_created' }], retryAfterMs: 0 });
  await until(() => feed.holds.length === 1);
  assert.equal(pages.at(-1).changes.length, 1);
  feed.holds.shift().resolve({ cursor: 'change', changes: [], retryAfterMs: 1000 });
  await until(() => feed.waits.length === 1); assert.equal(feed.waits[0].delay, 3000);
});

test('aggregate validation skips and counts malformed or foreign rows while strictly validating applied rows', async () => {
  const { fetchQuantumChanges } = require('../dist/electron/sync-quantum.js');
  const row = { seq: 1, type: 'object_added', ownerType: 'account', ownerId: 'canonical-account', appId: 'horizon', datasetId: 'dataset-a',
    path: 'writers/peer/checkpoint.hzs', size: 1, sha256: 'a'.repeat(64), memberId: null, generation: null, createdAt: 1 };
  const changes = [null, { ...row, seq: 2, sha256: 'invalid' }, { ...row, seq: 3, ownerId: 'foreign' },
    { ...row, seq: 4, appId: 'blueprint' }, { ...row, seq: 5, path: '../escape' }, { ...row, seq: 6 }, { ...row, seq: 6 }, { ...row, seq: 7, type: 'future' }];
  const source = { accountId: row.ownerId, assertActive() {}, request: async () => Response.json({ changes, cursor: 'next' }) };
  const page = await fetchQuantumChanges(source, 'previous');
  assert.deepEqual(page.changes, [{ ...row, seq: 6 }]); assert.equal(page.skippedChanges, 7); assert.equal(page.cursor, 'next');
  for (const value of ['0', '1']) {
    source.request = async () => Response.json({ changes: [], cursor: 'next' }, { headers: { 'Retry-After': value } });
    assert.equal((await fetchQuantumChanges(source)).retryAfterMs, 3000);
  }
});
