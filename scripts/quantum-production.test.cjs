const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } = require('node:crypto');
const { createAccount } = require('../dist/electron/account.js');
const cosmic = require('../dist/electron/cosmic-crypto.js');
const { vaultTokenStore, readVaultFile } = require('../dist/electron/vault-storage.js');
const { SyncEngine } = require('../dist/electron/sync-engine.js');
const { QuantumTransport } = require('../dist/electron/sync-quantum.js');
const { openSync } = require('../dist/electron/sync-format.js');
const { browserSyncHost } = require('../dist/electron/sync-browser.js');
const { createSettings } = require('../dist/electron/settings.js');
const { makeProfile, profileStorePath, writeRegistry } = require('../dist/electron/profiles.js');
const { readStore, writeStore } = require('../dist/electron/store.js');
const { createDesktop } = require('../dist/electron/desktop.js');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const favorite = (title = 'Quantum favorite') => ({ kind: 'link', id: randomUUID(), title, url: 'https://quantum-sync.example/favorite', createdAt: 100 });
function cipher() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = randomBytes(12), box = createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, box.update(value, 'utf8'), box.final(), box.getAuthTag()]); },
    decryptString(value) { const box = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); box.setAuthTag(value.subarray(-16)); return Buffer.concat([box.update(value.subarray(12, -16)), box.final()]).toString('utf8'); },
  };
}

function fixture(t) {
  const temporary = join(__dirname, '..', '.runtime', '046-test-tmp'); mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'horizon-quantum-production-')), cleanup = [];
  t.after(() => { for (const close of cleanup) close(); rmSync(root, { recursive: true, force: true }); });
  return { root, cleanup };
}
async function seat(fixture, name, server, accountId) {
  const directory = join(fixture.root, name); mkdirSync(directory, { recursive: true });
  const encryption = cipher(), login = await server.login(accountId);
  await vaultTokenStore(join(directory, 'account.sealed'), encryption).set(login.refreshToken);
  let engine;
  const account = createAccount({ directory, userData: directory, cipher: encryption, isPackaged: false,
    env: { HORIZON_QUANTUM_API: server.origin }, language: () => 'en', changed() { engine?.accountChanged(); }, openExternal: async () => {}, fetch,
    keyStore: { kind: 'session', get: async () => Uint8Array.from(login.key) },
  });
  fixture.cleanup.push(() => account.close());
  await account.retry();
  assert.equal(account.state().phrase, 'ready'); assert.equal(account.state().spacesError, null);
  const settings = createSettings(join(directory, 'settings.json'), () => {}), profile = makeProfile('Personal', 'amber'); profile.createdAt = 100;
  let registry = { version: 1, activeId: profile.id, profiles: [profile], tombstones: [] }; writeRegistry(join(directory, 'profiles.json'), registry);
  const status = { readError: false, memoryOnly: false }, store = readStore(profileStorePath(directory, profile.id), encryption, status);
  const desktop = createDesktop(join(dirname(profileStorePath(directory, profile.id)), 'notebooks.json'), encryption, () => {});
  const data = { store, status, desktop, sessions: { version: 2, windows: [] }, sessionStatus: { readError: false, memoryOnly: false }, favoritesVersion: 0, importProgress: null }, profiles = new Map([[profile.id, data]]);
  let now = 1000000;
  const host = browserSyncHost(directory, encryption, settings, { registry: () => registry, profiles, registryChanged: value => { registry = value; }, flush() { for (const value of profiles.values()) value.desktop.flush(); }, changed() {} });
  engine = new SyncEngine(directory, encryption, host, { now: () => now, quantum: id => account.accountId() === id ? account.quantumSync([profile.id]) : undefined });
  fixture.cleanup.push(() => { engine.stop(); for (const value of profiles.values()) value.desktop.dispose(); });
  return { directory, engine, account, profile, data, login, settings, cursor: () => readVaultFile(join(directory, 'quantum-changes.sealed'), encryption)?.cursor,
    async enroll() { const quantum = account.quantumSync([profile.id]); assert.equal(typeof quantum.subscribeChanges, 'function'); await engine.enrollQuantum(quantum); await engine.pulse(); },
    advance(value = 1000) { now += value; },
    store(edit) { edit(data.store); writeStore(profileStorePath(directory, profile.id), data.store, encryption); engine.markDirty('favorites'); },
  };
}
async function eventually(predicate, message = 'production aggregate feed did not converge') {
  const until = Date.now() + 5000;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
}
async function pair(t) {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'first', server);
  await a.enroll();
  const b = await seat(local, 'second', server, a.login.accountId); await b.enroll();
  await eventually(() => server.holds.size === 1 && a.cursor() && b.cursor());
  return { server, a, b };
}

test('production account and broker converge additions and deletions through one aggregate hold', async t => {
  const { server, a, b } = await pair(t), item = favorite('Real account aggregate addition');
  a.advance(); a.store(store => store.favorites.bar.push(item)); await a.engine.pulse();
  await eventually(() => b.data.store.favorites.bar.some(value => value.id === item.id));
  a.advance(); a.store(store => { store.favorites.bar = []; }); await a.engine.pulse();
  await eventually(() => b.data.store.favorites.bar.length === 0 && server.holds.size === 1);
  assert.equal(a.engine.state().failure, null); assert.equal(b.engine.state().failure, null);
  assert.equal(server.calls.some(call => /^\/v1\/datasets\/[^/]+\/changes$/.test(call.path)), false);
});

for (const scenario of ['search engine undo', 'favorite insertion undo']) test(`production HTTP Quantum preserves held ${scenario} through receive and publication`, async t => {
  const { server, a, b } = await pair(t), entry = favorite('Undo this held insertion');
  assert.equal(a.engine.options.transport, undefined); assert.equal(a.engine.active.describe().kind, 'quantum');
  a.advance(); a.settings.setSearchEngine('bing'); a.engine.markDirty('settings'); await a.engine.pulse(true);
  await eventually(() => b.settings.searchEngine === 'bing');
  const setting = scenario === 'search engine undo', key = setting ? 'searchEngine' : entry.id;
  a.advance();
  if (setting) { a.settings.setSearchEngine('google'); a.engine.markDirty('settings'); }
  else a.store(store => store.favorites.bar.push(entry));
  server.refusal = { status: 403, code: 'sync_plan_required', matches: call => call.identity?.computerId === a.login.computerId && call.method === 'PUT' && call.path.includes('/objects/writers/') };
  await assert.rejects(a.engine.pulse(true), /SYNC_PLAN_REQUIRED/);
  const held = structuredClone(a.engine.local.outbox), operation = held.operations.find(operation => operation.key === key);
  assert.ok(operation);
  const ciphertext = new Map(held.files.map(file => [file.file, sha256(readFileSync(join(a.engine.outboxPath, file.file)))]));
  a.advance();
  if (setting) { a.settings.setSearchEngine('bing'); a.engine.markDirty('settings'); }
  else a.store(store => { store.favorites.bar = store.favorites.bar.filter(value => value.id !== entry.id); });
  a.engine.flushDirty();
  const undo = a.engine.local.edits.find(edit => edit.record.key === key);
  assert.ok(undo, 'returning to the baseline must retain an edit against the sealed operation'); assert.equal(undo.base, operation.id);
  b.advance(); b.settings.setLanguage('es'); b.engine.markDirty('settings'); await b.engine.pulse(true);
  await eventually(() => a.settings.language === 'es', 'the real aggregate feed must apply the peer write while publishing is held');
  await a.engine.pulse(false, true);
  assert.deepEqual(a.engine.local.outbox, held);
  for (const file of held.files) assert.equal(sha256(readFileSync(join(a.engine.outboxPath, file.file))), ciphertext.get(file.file));
  assert.equal(a.engine.local.records.some(record => record.id === operation.id), false, 'an unpublished outbox operation must never become a received record');
  assert.equal(a.settings.searchEngine, 'bing'); assert.equal(a.data.store.favorites.bar.some(value => value.id === entry.id), false);
  const before = server.calls.length;
  server.refusal = undefined; await a.engine.pulse(true);
  const operations = server.calls.slice(before).flatMap(call => {
    const match = call.method === 'PUT' && /\/objects\/writers\/([^/]+)\/([^/]+)\/batches\/(\d+)-([^/]+)\.hzs$/.exec(call.path);
    if (!match || match[1] !== a.login.computerId) return [];
    return openSync(Buffer.from(a.engine.local.key, 'base64'), { dataset: a.engine.local.dataset.datasetId, device: match[1], generation: match[2], sequence: Number(match[3]), id: match[4], kind: 'batch' }, call.bytes).operations;
  });
  const publishedUndo = operations.find(value => value.key === key && value.id !== operation.id);
  assert.ok(publishedUndo, 'the actual HTTP upload must contain the undo after the held batch');
  assert.equal(publishedUndo.base, operation.id); assert.equal(publishedUndo.time, undo.time);
  assert.equal(publishedUndo.value, setting ? 'bing' : null);
  await eventually(() => b.engine.local.records.some(record => record.id === publishedUndo.id), 'the peer must receive the published undo revision');
  assert.equal(a.engine.local.outbox, null); assert.equal(a.settings.searchEngine, 'bing'); assert.equal(b.settings.searchEngine, 'bing');
  assert.equal(a.data.store.favorites.bar.some(value => value.id === entry.id), false); assert.equal(b.data.store.favorites.bar.some(value => value.id === entry.id), false);
});

test('production account and broker hold empty reads without idle listings or writes', async t => {
  const { server, a, b } = await pair(t);
  await new Promise(resolve => setTimeout(resolve, 150));
  const before = server.calls.length; a.advance(120000); b.advance(120000);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const idle = server.calls.slice(before);
  assert.ok(idle.length >= 3, 'the shortened empty-read deadline must complete and renew holds');
  assert.ok(idle.every(call => call.method === 'GET' && call.path === '/v1/changes'));
  assert.ok(idle.length < 20, 'empty reads must wait before the next request');
  await eventually(() => server.holds.size === 1);
});

test('production expired cursor replays a peer write made during the listing rebuild', async t => {
  const { server, a, b } = await pair(t), previous = a.cursor();
  const gate = server.pauseListing(); t.after(gate.release); server.expireCursors();
  await Promise.race([gate.entered, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('cursor recovery never rebuilt the object listing')), 5000); timer.unref(); })]);
  const item = favorite('Peer write inside cursor rebuild');
  b.advance(); b.store(store => store.favorites.bar.push(item)); await b.engine.pulse();
  assert.equal(a.data.store.favorites.bar.some(value => value.id === item.id), false);
  gate.release();
  await eventually(() => a.data.store.favorites.bar.some(value => value.id === item.id) && server.holds.size === 1);
  assert.notEqual(a.cursor(), previous);
  assert.equal(a.engine.state().failure, null);
  assert.ok(server.calls.filter(call => call.path === '/v1/bootstrap').length >= 2);
});

test('production stored sign-in recovers from launch outage with one bootstrap and dataset rebuild', async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'launch-recovery', server);
  await a.enroll(); await eventually(() => server.holds.size === 1 && a.cursor());
  a.account.cancel(); await eventually(() => server.holds.size === 0); a.engine.stop();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  server.refusal = { status: 503, code: 'busy', headers: { 'Retry-After': '5' }, matches: call => call.path === '/v1/me' };
  await assert.rejects(a.account.me(), /ACCOUNT_NETWORK/);
  assert.equal(a.account.state().status, 'error');
  const before = server.calls.length;
  server.refusal = undefined;
  t.mock.timers.tick(4999); await new Promise(setImmediate);
  assert.equal(server.calls.length, before);
  t.mock.timers.tick(1); await settled(() => a.account.state().status === 'signedIn');
  await settled(() => server.holds.size === 1); t.mock.timers.tick(100);
  await settled(() => a.engine.state().failure === null && !a.engine.running && server.holds.size === 1);
  const recovery = server.calls.slice(before), reads = path => recovery.filter(call => call.method === 'GET' && path.test(call.path)).length;
  assert.equal(reads(/^\/v1\/me$/), 1);
  assert.equal(reads(/^\/v1\/bootstrap$/), 1);
  assert.equal(reads(/\/objects$/), 1);
  assert.equal(reads(/\/objects\/dataset\.hzs$/), 1);
});

test('production broker continues delivery to the second profile after the first signs out', async t => {
  const { server, a, b } = await pair(t);
  a.account.cancel(); a.engine.accountChanged();
  const local = fixture(t), peer = await seat(local, 'peer', server, b.login.accountId); await peer.enroll();
  const item = favorite('After first profile signed out');
  peer.advance(); peer.store(store => store.favorites.bar.push(item)); await peer.engine.pulse();
  await eventually(() => b.data.store.favorites.bar.some(value => value.id === item.id) && server.holds.size === 1);
  assert.equal(b.engine.state().failure, null);
});

for (const interruption of ['offline account read', 'consent required']) test(`production Space subscription recovers after ${interruption}`, async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'recovered-spaces', server);
  server.spaces = true; await a.account.retry(); await a.enroll();
  assert.equal(a.account.state().spaces.length, 1);
  if (interruption === 'offline account read') {
    await eventually(() => server.holds.size === 1 && a.cursor());
    const revision = a.account.quantumSync([a.profile.id]).revision, spaces = a.account.state().spaces;
    const bootstraps = server.calls.filter(call => call.path === '/v1/bootstrap').length;
    server.refusal = { status: 503, code: 'storage_unavailable', matches: call => call.path === '/v1/me' };
    await assert.rejects(a.account.retry(), /ACCOUNT_NETWORK/);
    assert.equal(a.account.state().status, 'signedIn'); assert.equal(a.account.state().spacesError, 'ACCOUNT_NETWORK');
    assert.deepEqual(a.account.state().spaces, spaces); assert.equal(a.account.quantumSync([a.profile.id]).revision, revision);
    server.removeSpaceMember(a.login);
    await eventually(() => a.account.state().spaces.length === 0, 'the retained Space listener missed membership removal during an account read outage');
    assert.equal(server.calls.filter(call => call.path === '/v1/bootstrap').length, bootstraps);
    assert.notEqual(a.engine.state().failure, 'SYNC_NOT_ALLOWED');
    server.refusal = undefined;
    await a.account.retry(); assert.equal(a.account.state().spacesError, null);
    assert.equal(a.account.quantumSync([a.profile.id]).revision, revision);
    return;
  } else {
    server.consentRequired = true; await a.account.retry(); assert.equal(a.account.state().consent, 'required');
    server.consentRequired = false;
  }
  await a.account.retry();
  await eventually(() => server.holds.size === 1);
  server.removeSpaceMember(a.login);
  await eventually(() => a.account.state().spaces.length === 0, 'recovered account Space listener missed its membership removal');
});

test('production plan refusal refreshes capabilities and recovers after regrant without restart', async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'plan-recovery', server); await a.enroll();
  a.engine.stop(); a.advance(30000); a.store(store => store.favorites.bar.push(favorite('Publish after regrant')));
  const before = server.calls.filter(call => call.path === '/v1/entitlements').length;
  server.managedSync = false;
  server.refusal = { status: 403, code: 'sync_plan_required', matches: call => call.method === 'PUT' && call.path.includes('/objects/writers/') };
  await assert.rejects(a.engine.pulse(true), /SYNC_PLAN_REQUIRED/);
  await eventually(() => !a.account.managedSync() && server.calls.filter(call => call.path === '/v1/entitlements').length > before);
  server.refusal = undefined; server.managedSync = true;
  await a.account.retry(); a.engine.stop();
  await a.engine.pulse(false);
  assert.equal(a.engine.local.outbox, null); assert.equal(a.engine.state().failure, null);
});

for (const recovery of ['a new grant', 'explicit Sync now']) test(`production unchanged capability grant retains refused publication until ${recovery}`, async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'unchanged-plan', server); await a.enroll();
  await eventually(() => server.holds.size === 1 && a.cursor());
  a.advance(30000); a.store(store => store.favorites.bar.push(favorite('Unchanged granted capability')));
  server.refusal = { status: 403, code: 'sync_plan_required', matches: call => call.method === 'PUT' && call.path.includes('/objects/writers/') };
  await assert.rejects(a.engine.pulse(true), /SYNC_PLAN_REQUIRED/);
  const held = structuredClone(a.engine.local.outbox), revision = a.account.quantumSync([a.profile.id]).revision;
  const writes = server.calls.filter(call => call.method === 'PUT').length, bootstraps = server.calls.filter(call => call.path === '/v1/bootstrap').length;
  server.refusal = undefined; await a.account.retry();
  await a.engine.pulse(false);
  assert.deepEqual(a.engine.local.outbox, held); assert.equal(a.engine.state().failure, 'SYNC_PLAN_REQUIRED');
  assert.equal(a.account.quantumSync([a.profile.id]).revision, revision);
  assert.equal(server.calls.filter(call => call.method === 'PUT').length, writes);
  assert.equal(server.calls.filter(call => call.path === '/v1/bootstrap').length, bootstraps);
  if (recovery === 'a new grant') {
    server.managedSync = false; await a.account.retry(); a.engine.stop(); await a.engine.pulse(false);
    assert.deepEqual(a.engine.local.outbox, held); assert.equal(a.account.quantumSync([a.profile.id]).revision, revision);
    server.managedSync = true; await a.account.retry(); a.engine.stop(); await a.engine.pulse(false);
    assert.notEqual(a.account.quantumSync([a.profile.id]).revision, revision);
  } else await a.engine.pulse(true);
  assert.equal(a.engine.local.outbox, null); assert.equal(a.engine.state().failure, null);
});

async function settled(predicate) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await new Promise(setImmediate);
  assert.ok(predicate(), 'production capability recovery did not settle');
}

for (const reason of ['plan', 'consent']) test(`production ${reason} hold discovers a site regrant on the minute without retry`, async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'automatic-regrant', server); await a.enroll();
  a.engine.stop(); a.advance(30000); a.store(store => store.favorites.bar.push(favorite('Automatically released write')));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  server.managedSync = false;
  server.refusal = { status: 403, code: reason === 'plan' ? 'sync_plan_required' : 'acceptance_required', matches: call => call.method === 'PUT' && call.path.includes('/objects/writers/') };
  if (reason === 'consent') server.consentRequired = true;
  const initialReads = server.calls.filter(call => call.path === '/v1/entitlements').length;
  await assert.rejects(a.engine.pulse(true), reason === 'plan' ? /SYNC_PLAN_REQUIRED/ : /SYNC_CONSENT_REQUIRED/);
  t.mock.timers.tick(0); await settled(() => !a.account.managedSync() && server.calls.filter(call => call.path === '/v1/entitlements').length > initialReads);
  for (let index = 0; index < 20; index++) await new Promise(setImmediate);
  await settled(() => a.account.state().consent === (reason === 'consent' ? 'required' : 'accepted'));
  a.engine.stop();
  const reads = server.calls.filter(call => call.path === '/v1/entitlements').length, writes = server.calls.filter(call => call.method === 'PUT').length;
  for (let index = 0; index < 5; index++) { a.advance(1000); await a.engine.pulse(false).catch(() => {}); }
  assert.equal(server.calls.filter(call => call.method === 'PUT').length, writes, 'capability loss must not release the existing refusal hold');
  server.refusal = undefined; server.managedSync = true; server.consentRequired = false;
  t.mock.timers.tick(59999); await new Promise(setImmediate);
  assert.equal(server.calls.filter(call => call.path === '/v1/entitlements').length, reads);
  a.advance(60000); t.mock.timers.tick(1); await settled(() => a.account.managedSync());
  await settled(() => a.engine.local.outbox === null);
  assert.equal(a.engine.state().failure, null); assert.equal(a.account.state().plan, 'Quantum Test');
});

test('production successful Sync now after plan refusal refreshes capabilities without rebuilding the account card', async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'sync-now-card', server); await a.enroll();
  a.engine.stop(); a.advance(30000); a.store(store => store.favorites.bar.push(favorite('Sync now regrant')));
  server.managedSync = false;
  server.refusal = { status: 403, code: 'sync_plan_required', matches: call => call.method === 'PUT' && call.path.includes('/objects/writers/') };
  await assert.rejects(a.engine.pulse(true), /SYNC_PLAN_REQUIRED/); await settled(() => !a.account.managedSync()); a.engine.stop();
  assert.equal(a.account.state().plan, 'Quantum Test', 'entitlements do not replace the last account display card');
  server.refusal = undefined; server.managedSync = true;
  await a.engine.pulse(true);
  await settled(() => a.account.managedSync() && a.account.state().plan === 'Quantum Test');
  assert.equal(a.engine.local.outbox, null);
});

test('production failed entitlement refresh keeps the hold and backs off before a fresh regrant', async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'failed-capability-read', server); await a.enroll();
  a.engine.stop(); a.advance(30000); a.store(store => store.favorites.bar.push(favorite('Fresh grant after failed read')));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  server.refusal = { status: 403, code: 'sync_plan_required', matches: call => call.method === 'PUT' && call.path.includes('/objects/writers/') };
  await assert.rejects(a.engine.pulse(true), /SYNC_PLAN_REQUIRED/);
  server.refusal = { status: 500, code: 'storage_unavailable', matches: call => call.path === '/v1/entitlements' };
  const before = server.calls.filter(call => call.path === '/v1/entitlements').length;
  t.mock.timers.tick(0); await settled(() => server.calls.filter(call => call.path === '/v1/entitlements').length > before);
  for (let index = 0; index < 10; index++) await new Promise(setImmediate);
  assert.equal(a.account.managedSync(), true, 'failed entitlement reads keep the cached card permission');
  a.engine.stop();
  const reads = server.calls.filter(call => call.path === '/v1/entitlements').length, held = structuredClone(a.engine.local.outbox);
  const revision = a.account.quantumSync([a.profile.id]).revision, writes = server.calls.filter(call => call.method === 'PUT').length;
  server.refusal = undefined;
  t.mock.timers.tick(119999); await new Promise(setImmediate);
  assert.equal(server.calls.filter(call => call.path === '/v1/entitlements').length, reads, 'failed capability reads back off beyond the normal minute');
  a.advance(120000); t.mock.timers.tick(1);
  await settled(() => server.calls.filter(call => call.path === '/v1/entitlements').length > before + 1);
  for (let index = 0; index < 20; index++) await new Promise(setImmediate);
  a.engine.stop(); await a.engine.pulse(false);
  assert.deepEqual(a.engine.local.outbox, held); assert.equal(a.account.quantumSync([a.profile.id]).revision, revision);
  assert.equal(server.calls.filter(call => call.method === 'PUT').length, writes);
  server.managedSync = false; t.mock.timers.tick(60000); await settled(() => !a.account.managedSync()); a.engine.stop();
  assert.deepEqual(a.engine.local.outbox, held); assert.equal(a.account.quantumSync([a.profile.id]).revision, revision);
  server.managedSync = true; a.advance(60000); t.mock.timers.tick(60000);
  await settled(() => a.account.managedSync());
  assert.notEqual(a.account.quantumSync([a.profile.id]).revision, revision);
  await settled(() => a.engine.local.outbox === null);
  assert.equal(a.engine.state().failure, null);
});

test('production held publishing rechecks only entitlements and preserves signed-in receive access on failure', async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'isolated-entitlement-check', server); await a.enroll();
  a.engine.stop(); a.advance(30000); a.store(store => store.favorites.bar.push(favorite('Held during entitlement outage')));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  server.managedSync = false;
  server.refusal = { status: 403, code: 'sync_plan_required', matches: call => call.method === 'PUT' && call.path.includes('/objects/writers/') };
  await assert.rejects(a.engine.pulse(true), /SYNC_PLAN_REQUIRED/);
  t.mock.timers.tick(0); await settled(() => !a.account.managedSync()); a.engine.stop();
  const before = server.calls.length, capabilities = a.account.state().managedSync;
  server.refusal = { status: 503, code: 'storage_unavailable', matches: call => ['/v1/me', '/v1/entitlements'].includes(call.path) };
  t.mock.timers.tick(60000);
  await settled(() => server.calls.slice(before).some(call => call.path === '/v1/entitlements'));
  for (let index = 0; index < 50; index++) await new Promise(setImmediate);
  assert.equal(a.account.state().status, 'signedIn'); assert.equal(a.account.managedSync(), capabilities);
  assert.ok(a.account.quantumSync([a.profile.id]), 'Space and personal receive connections retain the authenticated account');
  assert.equal(server.calls.slice(before).some(call => call.path === '/v1/me' || call.path === '/v1/keys' || call.path.startsWith('/v1/spaces')), false);
  await assert.doesNotReject(a.engine.pulse(false, true));
  assert.notEqual(a.engine.state().failure, 'SYNC_NOT_ALLOWED');
});

test('production lapsed plans slow entitlement rechecks to fifteen minutes after four minutes', async t => {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'slow-lapsed-plan', server); await a.enroll();
  a.engine.stop(); a.advance(30000); a.store(store => store.favorites.bar.push(favorite('Long plan lapse')));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  server.managedSync = false;
  server.refusal = { status: 403, code: 'sync_plan_required', matches: call => call.method === 'PUT' && call.path.includes('/objects/writers/') };
  await assert.rejects(a.engine.pulse(true), /SYNC_PLAN_REQUIRED/);
  const reads = () => server.calls.filter(call => call.path === '/v1/entitlements').length;
  let previous = reads(); t.mock.timers.tick(0); await settled(() => !a.account.managedSync() && reads() > previous); a.engine.stop();
  for (let minute = 0; minute < 4; minute++) {
    previous = reads(); t.mock.timers.tick(60000); await settled(() => reads() > previous);
    for (let index = 0; index < 20; index++) await new Promise(setImmediate);
  }
  previous = reads(); t.mock.timers.tick(899999); await new Promise(setImmediate); assert.equal(reads(), previous);
  t.mock.timers.tick(1); await settled(() => reads() > previous);
  assert.equal(a.account.state().status, 'signedIn'); assert.equal(a.account.managedSync(), false);
});

test('production unchanged account refresh preserves Retry-After and avoids bootstrap rebuilds', async t => {
  const f = await retryFixture(t, 'publish'), count = () => f.server.calls.filter(f.matches).length;
  f.a.engine.start(); await f.a.engine.pulse(false, true);
  f.server.refusal = { status: 429, code: 'rate_limited', headers: { 'Retry-After': '17' }, matches: f.matches };
  await assert.rejects(f.a.engine.pulse(false), /SYNC_RATE_LIMITED/);
  const writes = count(), revision = f.a.account.quantumSync([f.a.profile.id]).revision;
  const rebuilds = () => f.server.calls.filter(call => call.path === '/v1/bootstrap' || call.path.endsWith('/objects') || call.path.endsWith('/objects/dataset.hzs')).length;
  const before = rebuilds();
  for (let second = 0; second < 17; second++) {
    await f.a.account.me(); await f.a.engine.pulse(false);
    assert.equal(count(), writes); assert.equal(f.a.account.quantumSync([f.a.profile.id]).revision, revision);
    f.a.advance(1000);
  }
  assert.equal(rebuilds(), before);
  await assert.rejects(f.a.engine.pulse(false), /SYNC_RATE_LIMITED/); assert.equal(count(), writes + 1);
});

async function retryFixture(t, mode) {
  const server = await fakeQuantum(t), local = fixture(t), a = await seat(local, 'retry', server);
  await a.enroll();
  await eventually(() => a.cursor() && server.holds.size === 1);
  let path;
  if (mode === 'receive') {
    a.engine.stop();
    const peer = await seat(local, 'peer', server, a.login.accountId), source = peer.account.quantumSync([peer.profile.id]);
    path = `writers/${source.computerId}/${randomUUID()}/checkpoints/1-${randomUUID()}.hzs`;
    await new QuantumTransport(source, a.engine.local.dataset.datasetId).writeObject(path, randomBytes(256), 4096);
    await a.engine.active.refreshObjects(true);
  } else {
    a.advance(); a.store(store => store.favorites.bar.push(favorite('Pending refused publication'))); a.engine.stop(); a.advance(30000);
  }
  const matches = call => call.method === (mode === 'receive' ? 'GET' : 'PUT') && (path ? call.path.endsWith(`/objects/${path}`) : call.path.includes('/objects/writers/'));
  return { server, a, mode, matches };
}
async function requestTicks(fixture, seconds = 140) {
  const { server, a, mode, matches } = fixture, ticks = [];
  let count = server.calls.filter(matches).length;
  for (let second = 0; second <= seconds; second++) {
    await a.engine.pulse(false, mode === 'receive').catch(() => {});
    const next = server.calls.filter(matches).length;
    for (let index = count; index < next; index++) ticks.push(second);
    count = next;
    if (second < seconds) a.advance(1000);
  }
  return ticks;
}

const refusals = [
  { name: '500 storage_unavailable', status: 500, code: 'storage_unavailable', failure: 'SYNC_STORAGE' },
  { name: '503 storage_unavailable', status: 503, code: 'storage_unavailable', failure: 'SYNC_STORAGE' },
  { name: 'object_limit', status: 413, code: 'object_limit', failure: 'SYNC_LIMIT' },
  { name: 'plan refusal', status: 403, code: 'sync_plan_required', failure: 'SYNC_PLAN_REQUIRED', permanent: true },
  { name: 'consent refusal', status: 403, code: 'acceptance_required', failure: 'SYNC_CONSENT_REQUIRED', permanent: true },
  { name: 'not allowed', status: 403, code: 'forbidden', failure: 'SYNC_NOT_ALLOWED' },
  { name: 'Retry-After', status: 429, code: 'rate_limited', failure: 'SYNC_RATE_LIMITED', headers: { 'Retry-After': '17' } },
];
for (const mode of ['receive', 'publish']) for (const refusal of refusals) test(`production ${mode} HTTP retries respect ${refusal.name} over simulated time`, async t => {
  const f = await retryFixture(t, mode);
  f.server.refusal = { ...refusal, matches: f.matches };
  const ticks = await requestTicks(f);
  const held = refusal.permanent && !(mode === 'receive' && refusal.failure === 'SYNC_PLAN_REQUIRED');
  assert.deepEqual(ticks, held ? [0] : refusal.headers ? [0, 17, 34, 54, 94] : [0, 5, 15, 35, 75, 135]);
  assert.equal(f.a.engine.state().failure, refusal.failure);
  if (mode === 'publish') assert.ok(f.a.engine.local.outbox, 'failed publication must retain its sealed outbox');
  if (held) {
    f.server.managedSync = false;
    await f.a.account.retry(); f.a.engine.accountChanged(); f.a.engine.stop();
    assert.deepEqual(await requestTicks(f, 0), refusal.failure === 'SYNC_PLAN_REQUIRED' ? [] : [0], 'a lost capability must preserve a plan hold; accepted consent releases its own hold');
  }
});

test('production receive backs off actual undecryptable peer checkpoint downloads', async t => {
  const f = await retryFixture(t, 'receive');
  assert.deepEqual(await requestTicks(f), [0, 5, 15, 35, 75, 135]);
  assert.equal(f.a.engine.state().failure, 'SYNC_INVALID');
});

async function fakeQuantum(t) {
  const datasets = new Map(), calls = [], keys = new Map(), credentials = new Map(), events = [], holds = new Set();
  let history = randomUUID();
  const cursor = (identity, seq) => Buffer.from(JSON.stringify([history, identity.accountId, identity.appId, seq])).toString('base64url');
  const emit = (identity, type, datasetId, path = null, bytes = null) => {
    events.push({ seq: events.length + 1, type, ownerType: 'account', ownerId: identity.accountId, appId: identity.appId, datasetId, path, size: bytes === null ? null : bytes.length, sha256: bytes === null ? null : sha256(bytes), memberId: null, generation: null, createdAt: Date.now() });
    for (const wake of [...holds]) wake();
  };
  let listingGate, refusal, managedSync = true, spaces = false, consentRequired = false;
  const scope = (account, app, id) => `${account}/${app}/${id}`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1'), token = request.headers.authorization?.replace(/^Bearer /, ''), identity = credentials.get(token);
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), call = { method: request.method, path: url.pathname, search: url.searchParams, identity, headers: request.headers, bytes }; calls.push(call);
      const json = (status, value, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'fake-request', ...headers }); response.end(JSON.stringify(value)); };
      const error = (status, code, headers) => json(status, { error: { code, message: code, fields: code === 'cursor_expired' ? { bootstrap: true } : {}, requestId: 'fake-request' } }, headers);
      if (url.pathname === '/v1/oauth/token') {
        const value = JSON.parse(bytes.toString()), login = credentials.get(value.refreshToken);
        if (!login) { error(401, 'invalid_grant'); return; }
        json(200, { accessToken: login.accessToken, refreshToken: value.refreshToken, tokenType: 'Bearer', expiresIn: 900, deviceId: login.deviceId, account_id: login.accountId }); return;
      }
      if (!identity) { error(401, 'unauthorized'); return; }
      if (refusal?.matches(call)) { error(refusal.status, refusal.code, refusal.headers); return; }
      if (url.pathname === '/v1/me') { json(200, { accountId: identity.accountId, email: 'person@example.test', consentRequired, plans: managedSync ? [{ key: 'test-plan', product: 'horizon', tier: 'sync', label: 'Quantum Test' }] : [], devices: [{ id: identity.deviceId, accountId: identity.accountId, appId: 'horizon', computerId: identity.computerId, revokedAt: null }] }); return; }
      if (url.pathname === '/v1/entitlements') { if (consentRequired) error(403, 'acceptance_required'); else json(200, { capabilities: { managedSync: { horizon: managedSync } } }); return; }
      if (url.pathname === '/v1/keys') { json(200, { keys: [{ recipient: 'public', ...identity.envelope }] }); return; }
      if (url.pathname === '/v1/spaces') { json(200, { spaces: spaces ? [{ id: 'space-a', kind: 'shared', role: 'member', keyPending: true, currentGeneration: 1, rotationRequired: false, createdAt: 100, algorithm: null, sealedProfile: null, members: [{ accountId: identity.accountId, displayName: null, role: 'member' }] }] : [], after: null }); return; }
      if (url.pathname.endsWith('/public-key')) { error(404, 'not_found'); return; }
      const { accountId, appId, computerId } = identity;
      if (url.pathname === '/v1/bootstrap' && request.method === 'GET') {
        json(200, { accountId, app: appId, device: { id: computerId, name: 'Synthetic computer' }, capabilities: { managedSync: { horizon: true }, spaces: 0, seatsPerSpace: 0, privateBuilds: [], relayPlus: false, premiumAppFeatures: false, blueprintPublish: false, monthlyCredits: 0 }, plans: [], pool: { poolBytes: 10000000000, usedBytes: 0 }, legal: { missing: [] }, spaces: [], after: null, cursors: { spaces: null } }); return;
      }
      if (url.pathname === '/v1/changes' && request.method === 'GET') {
        let after = 0;
        if (url.searchParams.has('after')) {
          try { const [version, owner, app, sequence] = JSON.parse(Buffer.from(url.searchParams.get('after'), 'base64url').toString()); if (version !== history || owner !== accountId || app !== appId || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error(); after = sequence; }
          catch { error(410, 'cursor_expired'); return; }
        }
        const limit = Number(url.searchParams.get('limit') || 100), historyAtStart = history;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) { error(400, 'invalid_request'); return; }
        const answer = () => {
          const changes = events.filter(event => event.seq > after && (event.ownerId === accountId || event.ownerType === 'space' && event.memberId === accountId) && event.appId === appId).slice(0, limit);
          const next = changes.length === limit ? changes.at(-1).seq : events.length;
          json(200, { changes, cursor: cursor(identity, next) });
        };
        const visible = () => events.some(event => event.seq > after && (event.ownerId === accountId || event.ownerType === 'space' && event.memberId === accountId) && event.appId === appId);
        if (visible()) { answer(); return; }
        let timer;
        const cleanup = () => { holds.delete(wake); clearTimeout(timer); response.removeListener('close', cleanup); };
        const wake = () => { if (historyAtStart !== history) { cleanup(); error(410, 'cursor_expired'); } else if (visible()) { cleanup(); answer(); } };
        holds.add(wake); response.once('close', cleanup); timer = setTimeout(() => { cleanup(); answer(); }, 100); timer.unref(); return;
      }
      if (url.pathname === '/v1/datasets' && request.method === 'GET') {
        const rows = [...datasets.values()].filter(value => value.accountId === accountId && value.appId === appId).map(({ id, appId, createdAt }) => ({ id, appId, createdAt })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const limit = Number(url.searchParams.get('limit') || 100), after = url.searchParams.get('after') || '', page = rows.filter(value => value.id > after).slice(0, limit);
        json(200, { datasets: page, after: page.length === limit ? page.at(-1).id : null }); return;
      }
      const match = /^\/v1\/datasets\/([^/]+)(?:\/objects(?:\/(.+))?)?$/.exec(url.pathname);
      if (!match) { error(404, 'not_found'); return; }
      const id = decodeURIComponent(match[1]);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { error(400, 'invalid_request'); return; }
      const objectRoute = url.pathname.includes('/objects');
      if ((!objectRoute && request.method !== 'PUT') || (objectRoute && !match[2] && request.method !== 'GET') || (match[2] && !['GET', 'HEAD', 'PUT', 'DELETE'].includes(request.method))) { error(405, 'method_not_allowed'); return; }
      const location = scope(accountId, appId, id), path = match[2] && match[2].split('/').map(decodeURIComponent).join('/');
      let dataset = datasets.get(location);
      if (!url.pathname.includes('/objects') && request.method === 'PUT') {
        const existed = !!dataset;
        if (!dataset) { dataset = { id, appId, accountId, createdAt: 1793000000000, objects: new Map() }; datasets.set(location, dataset); emit(identity, 'dataset_created', id); }
        json(existed ? 200 : 201, { id, appId, createdAt: dataset.createdAt }, existed ? {} : { Location: url.pathname }); return;
      }
      if (!dataset) { error(404, 'not_found'); return; }
      if (!path && request.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || '', after = url.searchParams.get('after') || '', limit = Number(url.searchParams.get('limit') || 100);
        const rows = [...dataset.objects].filter(([name]) => name.startsWith(prefix) && name > after).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([path, body]) => ({ path, size: body.length, sha256: sha256(body), createdAt: 1793000000000 }));
        if (listingGate) { const gate = listingGate; listingGate = undefined; gate.enter(); await gate.wait; }
        json(200, { objects: rows, after: rows.length === limit ? rows.at(-1).path : null }); return;
      }
      if (!path) { error(400, 'invalid_path'); return; }
      const writer = path.split('/')[1];
      if (['PUT', 'DELETE'].includes(request.method) && path !== 'dataset.hzs' && (!path.startsWith('writers/') || writer !== computerId)) { error(403, 'writer_forbidden'); return; }
      const previous = dataset.objects.get(path);
      if (request.method === 'PUT') {
        if (request.headers['content-type'] !== 'application/octet-stream') { error(415, 'unsupported_media_type'); return; }
        if (!request.headers['content-length']) { error(411, 'length_required'); return; }
        if (request.headers['x-content-sha256'] !== sha256(bytes)) { error(400, 'invalid_checksum'); return; }
        if (previous && !previous.equals(bytes)) { error(409, 'object_conflict'); return; }
        dataset.objects.set(path, Buffer.from(bytes)); if (!previous) emit(identity, 'object_added', id, path, bytes); json(previous ? 200 : 201, { success: true }, previous ? {} : { Location: url.pathname }); return;
      }
      if (!previous) { error(404, 'not_found'); return; }
      if (request.method === 'DELETE') { if (path === 'dataset.hzs') { error(403, 'delete_forbidden'); return; } dataset.objects.delete(path); emit(identity, 'object_deleted', id, path, previous); json(200, { success: true }); return; }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(previous.length), 'X-Content-SHA256': sha256(previous), 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); response.end(previous);
    } catch { response.writeHead(500, { 'Content-Type': 'application/json', 'X-Request-Id': 'fake-request' }); response.end(JSON.stringify({ error: { code: 'internal_error', message: 'Synthetic failure', fields: {}, requestId: 'fake-request' } })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function login(accountId = randomUUID()) {
    let material = keys.get(accountId);
    if (!material) { const key = randomBytes(32); material = { key, pair: await cosmic.createAccountKeyPair(key, accountId) }; keys.set(accountId, material); }
    const refreshToken = randomBytes(32).toString('base64url'), accessToken = randomBytes(32).toString('base64url');
    const identity = { accountId, computerId: randomUUID(), deviceId: randomUUID(), appId: 'horizon', accessToken, envelope: material.pair.envelope };
    credentials.set(refreshToken, identity); credentials.set(accessToken, identity);
    return { ...identity, refreshToken, key: material.key };
  }
  return { calls, login, origin, holds,
    set refusal(value) { refusal = value; }, set managedSync(value) { managedSync = value; },
    set spaces(value) { spaces = value; }, set consentRequired(value) { consentRequired = value; },
    removeSpaceMember(identity) {
      spaces = false;
      events.push({ seq: events.length + 1, type: 'member_removed', ownerType: 'space', ownerId: 'space-a', appId: 'horizon', datasetId: null, path: null, size: null, sha256: null, memberId: identity.accountId, generation: null, createdAt: Date.now() });
      for (const wake of [...holds]) wake();
    },
    pauseListing() { let enter, release; const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; }); listingGate = { enter, wait }; return { entered, release }; },
    expireCursors() { history = randomUUID(); for (const wake of [...holds]) wake(); },
  };
}

