const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { SyncEngine } = require('../dist/electron/sync-engine.js');
const { randomSyncKeys } = require('../dist/electron/sync-format.js');
const { createSettings } = require('../dist/electron/settings.js');
const { syncSettings, emptySyncStore, emptySyncDesktop } = require('../dist/electron/sync-model.js');
const { FolderTransport, validCheckpoint } = require('../dist/electron/sync-transport.js');
const { canonical, openSync, recordId } = require('../dist/electron/sync-format.js');
const { mergeOperation } = require('../dist/electron/sync-model.js');

async function fixture(t) {
  const temporary = join(__dirname, '../.runtime/046-test-tmp'); mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'quantum-review-'));
  const cipher = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const { key, check } = await randomSyncKeys.create(), objects = new Map([['dataset.hzs', Buffer.from(JSON.stringify(check))]]);
  let now = 1000000, active = true, subscribed = 0, unsubscribed = 0, receive;
  const account = { accountId: 'review-account', computerId: randomUUID(), profileIds: [randomUUID()], revision: 'session-1',
    assertActive() { if (!active) throw new Error('SYNC_NOT_ALLOWED'); },
    subscribeChanges(listener) { subscribed++; receive = listener; return () => { unsubscribed++; }; },
  };
  const transport = { describe: () => ({ kind: 'quantum', label: 'Cosmic' }),
    readDescriptor: async () => objects.get('dataset.hzs'),
    async *listObjects(prefix) {
      yield* new Set([...objects.keys()].filter(path => path.startsWith(prefix + '/')).map(path => prefix + '/' + path.slice(prefix.length + 1).split('/')[0]));
    },
    readObject: async path => objects.get(path), writeObject: async (path, bytes) => { objects.set(path, bytes); }, deleteOwnObject: async path => { objects.delete(path); },
  };
  const settings = syncSettings(createSettings(join(directory, 'settings.json'), () => {}));
  const host = { read: () => ({ profiles: [], settings }), image: () => null, apply: () => () => {}, changed() {} };
  const engine = new SyncEngine(directory, cipher, host, { now: () => now, quantum: () => active ? account : undefined, transport: () => transport });
  const state = engine.initial('', check, key); state.transport = { kind: 'quantum', accountId: account.accountId, datasetId: check.datasetId }; state.quantumAccountId = account.accountId; state.device = account.computerId;
  state.switches.profiles = false; state.fresh = []; engine.local = state; engine.active = transport; engine.save(state);
  t.after(() => { engine.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { engine, account, transport, directory, cipher, host, options: engine.options,
    active(value) { active = value; }, advance(ms) { now += ms; }, receive: page => receive(page),
    get subscribed() { return subscribed; }, get unsubscribed() { return unsubscribed; } };
}

for (const transportKind of ['folder', 'quantum']) for (const scenario of ['setting undo', 'favorite insertion undo']) for (const peer of [false, true]) {
  for (const cancel of peer ? [null, 'publish', 'receive'] : [null]) test(`${transportKind} held outbox retains ${scenario} through receive and restart${peer ? ' after a newer peer version' : ''}${cancel ? `, cancel undo then ${cancel}` : ''}`, async t => {
    const f = await fixture(t);
    if (transportKind === 'folder') {
      const folder = join(f.directory, 'cloud'); mkdirSync(folder);
      const transport = new FolderTransport(folder, undefined, f.engine.local.dataset.datasetId);
      await transport.writeObject('dataset.hzs', Buffer.from(canonical(f.engine.local.dataset)), 4096);
      f.engine.local.transport = { kind: 'folder', folder }; f.engine.active = transport; f.engine.options.transport = () => transport;
    }
    let current = f.host.read(); current.settings.searchEngine = 'bing';
    current.profiles = [{ id: f.account.profileIds[0], name: 'Personal', color: 'blue', createdAt: 1, store: emptySyncStore(), desktop: emptySyncDesktop(), windows: [] }];
    f.host.read = () => structuredClone(current); f.host.apply = next => { const old = current; current = next; return () => { current = old; }; };
    await f.engine.pulse(); f.advance(1000);
    const favorite = { id: randomUUID(), kind: 'link', title: 'Held favorite', url: 'https://example.test/', createdAt: 1 };
    const item = scenario === 'setting undo' ? 'settings' : 'favorites', key = item === 'settings' ? 'searchEngine' : favorite.id;
    if (item === 'settings') current.settings.searchEngine = 'google'; else current.profiles[0].store.favorites.bar.push(favorite);
    f.engine.markDirty(item);
    const write = f.engine.active.writeObject.bind(f.engine.active);
    f.engine.active.writeObject = async () => { throw new Error('SYNC_PLAN_REQUIRED'); };
    await assert.rejects(f.engine.pulse(), /SYNC_PLAN_REQUIRED/);
    const held = structuredClone(f.engine.local.outbox), operation = held.operations.find(operation => operation.key === key);
    f.advance(1000);
    if (item === 'settings') current.settings.searchEngine = 'bing'; else current.profiles[0].store.favorites.bar = [];
    f.engine.markDirty(item); f.engine.flushDirty();
    const undo = f.engine.local.edits.find(edit => edit.record.key === key);
    assert.ok(undo, 'returning to the pre-outbox value is a pending undo'); assert.equal(undo.base, operation.id);
    let remote;
    if (peer) {
      remote = { ...operation, id: randomUUID(), device: randomUUID(), generation: randomUUID(), time: cancel ? 2000000 : operation.time + 500,
        value: item === 'settings' ? 'duckduckgo' : { ...operation.value, entry: { ...favorite, title: 'Newer peer version' } } };
      f.engine.incoming = async () => ({ operations: [remote], conflicts: [], cursors: {}, waiting: null });
    }
    f.advance(6000); await f.engine.pulse(false, true);
    f.advance(1000); await f.engine.pulse(false, true);
    assert.equal(f.engine.local.edits.find(edit => edit.record.key === key)?.time, undo.time, 'repeated receives retain the undo even when the sealed version loses');
    assert.deepEqual(f.engine.local.outbox, held);
    assert.equal(f.engine.local.records.some(record => record.id === operation.id), false, 'unpublished operations are not received records');
    assert.equal(current.settings.searchEngine, 'bing'); assert.equal(current.profiles[0].store.favorites.bar.length, 0);
    if (cancel) {
      f.advance(1000);
      if (item === 'settings') current.settings.searchEngine = 'google'; else current.profiles[0].store.favorites.bar.push(favorite);
      f.engine.markDirty(item); f.engine.flushDirty();
      if (cancel === 'receive') { f.advance(1000); await f.engine.pulse(false, true); }
    }
    f.engine.stop(); const reopened = new SyncEngine(f.directory, f.cipher, f.host, f.options); t.after(() => reopened.stop());
    reopened.active.writeObject = write;
    const emitted = [], seal = reopened.sealOutbox.bind(reopened);
    reopened.sealOutbox = (...args) => { emitted.push(...args[1]); return seal(...args); };
    await reopened.pulse(true);
    const publishedUndo = emitted.find(operation => operation.key === key);
    if (cancel) {
      assert.equal(publishedUndo, undefined, 'canceling the undo must not create an edit based on an unseen remote winner');
      assert.equal(reopened.local.records.find(record => record.key === key).id, remote.id);
      assert.equal(current.settings.searchEngine, item === 'settings' ? 'duckduckgo' : 'bing');
      assert.equal(current.profiles[0].store.favorites.bar[0]?.title ?? null, item === 'favorites' ? 'Newer peer version' : null);
      return;
    }
    assert.ok(publishedUndo); assert.equal(publishedUndo.base, operation.id); assert.equal(publishedUndo.time, undo.time);
    assert.equal(current.settings.searchEngine, 'bing'); assert.equal(current.profiles[0].store.favorites.bar.length, 0);
    assert.equal(reopened.local.records.find(record => record.key === key).id, publishedUndo.id);
  });
}

test('writer generation reset checkpoints received values without making them own operations', async t => {
  const f = await fixture(t); let current = f.host.read();
  f.host.read = () => structuredClone(current); f.host.apply = next => { const old = current; current = next; return () => { current = old; }; };
  await f.engine.pulse();
  const remote = { item: 'settings', profile: null, key: 'searchEngine', value: 'bing', id: randomUUID(), base: null, time: 2000000, device: randomUUID(), generation: randomUUID() };
  f.engine.incoming = async () => ({ operations: [remote], conflicts: [], cursors: {}, waiting: null });
  await f.engine.pulse(false, true);
  const previousGeneration = f.engine.local.generation;
  f.engine.local.sequence = 0; await f.engine.checkGeneration(f.engine.local);
  assert.notEqual(f.engine.local.generation, previousGeneration, 'authenticated cloud packages force a new writer generation');
  const emitted = [], seal = f.engine.sealOutbox.bind(f.engine);
  f.engine.sealOutbox = (...args) => { emitted.push(...args[1]); return seal(...args); };
  await f.engine.pulse(true);
  assert.equal(emitted.some(operation => operation.key === remote.key), false);
  assert.equal(f.engine.local.records.find(operation => operation.key === remote.key).id, remote.id);
  const prefix = `writers/${f.engine.local.device}/${f.engine.local.generation}/checkpoints`;
  const paths = await Array.fromAsync(f.transport.listObjects(prefix)); assert.equal(paths.length, 1);
  const checkpoint = validCheckpoint(paths[0].split('/').at(-1)); assert.ok(checkpoint);
  const payload = openSync(Buffer.from(f.engine.local.key, 'base64'), { dataset: f.engine.local.dataset.datasetId, device: f.engine.local.device,
    generation: f.engine.local.generation, sequence: checkpoint.sequence, id: checkpoint.id, kind: 'checkpoint' }, await f.transport.readObject(paths[0]));
  assert.deepEqual(payload.operations.find(operation => operation.key === remote.key), remote, 'the checkpoint retains the received revision identity');
});

test('forced Quantum pulse retries a refusal and backoff once without an account revision', async t => {
  const f = await fixture(t); await f.engine.pulse();
  let calls = 0; f.engine.runPulse = async () => { calls++; throw new Error('SYNC_NOT_ALLOWED'); };
  await assert.rejects(f.engine.pulse(), /SYNC_NOT_ALLOWED/);
  await assert.rejects(f.engine.pulse(true), /SYNC_NOT_ALLOWED/);
  assert.equal(calls, 2);
  await f.engine.pulse(false); assert.equal(calls, 2);
  f.engine.runPulse = async () => { calls++; };
  await f.engine.pulse(true); assert.equal(calls, 3); assert.equal(f.engine.state().failure, null);
});

test('a forced retry replaces a stale plan hold with transient publication backoff', async t => {
  const f = await fixture(t); let calls = 0, refusal = 'SYNC_PLAN_REQUIRED';
  f.engine.runPulse = async (_force, receiveOnly) => { if (!receiveOnly) { calls++; if (refusal) throw new Error(refusal); } };
  await assert.rejects(f.engine.pulse(true), /SYNC_PLAN_REQUIRED/);
  refusal = 'SYNC_STORAGE'; await assert.rejects(f.engine.pulse(true), /SYNC_STORAGE/);
  assert.equal(f.engine.retryBlocked, false);
  refusal = null; f.advance(60000); await f.engine.pulse(false);
  assert.equal(calls, 3); assert.equal(f.engine.state().failure, null);
});

test('Sync now during an active background receive queues a publication attempt', async t => {
  const f = await fixture(t), attempts = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.engine.runPulse = async (force, receiveOnly) => { attempts.push([force, receiveOnly]); if (attempts.length === 1) await gate; };
  const receiving = f.engine.pulse(false, true);
  await new Promise(setImmediate);
  const forced = f.engine.pulse(true); release(); await Promise.all([receiving, forced]);
  assert.deepEqual(attempts, [[false, true], [true, false]]);
});

for (const action of ['create', 'join', 'enroll']) test(`leaving a held Quantum dataset resets retries before ${action}`, async t => {
  const f = await fixture(t); f.engine.pulseFailed(new Error('SYNC_PLAN_REQUIRED'));
  await f.engine.leave(false);
  assert.equal(f.engine.retryBlocked, false); assert.equal(f.engine.retryAt, 0); assert.equal(f.engine.retryDelay, 0);
  // Enrollment commands also discard any retry state that predates their new dataset.
  f.engine.retryBlocked = true; f.engine.retryAt = 9000000; f.engine.retryDelay = 60000;
  const folder = join(f.directory, 'cloud'); mkdirSync(folder);
  if (action === 'enroll') {
    f.account.request = async path => {
      if (path === '/v1/datasets?limit=100') return Response.json({ datasets: [], after: null });
      if (!path.includes('/objects/')) return Response.json({ id: path.split('/').at(-1), appId: 'horizon', createdAt: 1 }, { status: 201 });
      return Response.json({ success: true }, { status: 201 });
    };
    f.account.deriveSyncKey = async () => Buffer.alloc(32, 7);
    await f.engine.enrollQuantum(f.account);
  } else if (action === 'create') await f.engine.create(folder, true);
  else {
    const { key, check } = await randomSyncKeys.create();
    await new FolderTransport(folder, 1000, check.datasetId).writeObject('dataset.hzs', Buffer.from(canonical(check)), 4096);
    await f.engine.join(folder, randomSyncKeys.encode(key), true);
  }
  assert.equal(f.engine.retryBlocked, false); assert.equal(f.engine.retryAt, 0); assert.equal(f.engine.retryDelay, 0);
  let tried = 0; f.engine.runPulse = async () => { tried++; }; await f.engine.pulse(true);
  assert.equal(tried, 1); assert.equal(f.engine.state().failure, null);
});

test('plan-held publishing still receives remote settings and retains a sealed outbox and later local edits', async t => {
  const f = await fixture(t); let current = f.host.read();
  f.host.read = () => structuredClone(current); f.host.apply = next => { const old = current; current = next; return () => { current = old; }; };
  await f.engine.pulse(); f.engine.start();
  current.settings.theme = 'amber'; f.engine.markDirty('settings');
  f.transport.writeObject = async () => { throw new Error('SYNC_PLAN_REQUIRED'); };
  await assert.rejects(f.engine.pulse(), /SYNC_PLAN_REQUIRED/);
  const pending = structuredClone(f.engine.local.outbox); assert.ok(pending);
  current.settings.language = 'es'; f.engine.markDirty('settings');
  const remote = { item: 'settings', profile: null, key: 'searchEngine', value: 'google', id: randomUUID(), base: null, time: 2000000, device: randomUUID(), generation: randomUUID() };
  f.engine.incoming = async () => ({ operations: [remote], conflicts: [], cursors: {}, waiting: null });
  await f.receive(null);
  assert.equal(current.settings.searchEngine, 'google'); assert.equal(current.settings.theme, 'amber'); assert.equal(current.settings.language, 'es');
  assert.deepEqual(f.engine.local.outbox, pending); assert.equal(f.engine.state().failure, 'SYNC_PLAN_REQUIRED');
  f.transport.writeObject = async () => {};
  await f.engine.pulse(true); assert.equal(f.engine.local.outbox, null); assert.equal(f.engine.state().failure, null);
  assert.equal(current.settings.searchEngine, 'google'); assert.equal(current.settings.theme, 'amber'); assert.equal(current.settings.language, 'es');
});

test('receive failures retain their backoff while publishing remains plan-held', async t => {
  const f = await fixture(t); await f.engine.pulse(); f.engine.start();
  f.engine.pulseFailed(new Error('SYNC_PLAN_REQUIRED')); f.advance(5000);
  let reads = 0;
  f.transport.readDescriptor = async () => { reads++; throw new Error('SYNC_STORAGE'); };
  await f.receive(null); assert.equal(reads, 1);
  await f.receive(null); assert.equal(reads, 1);
  f.advance(10000); await f.receive(null); assert.equal(reads, 2);
  assert.equal(f.engine.retryBlocked, true);
});

for (const deletion of [false, true]) test(`held outbox never echoes a received ${deletion ? 'deletion' : 'setting'} when publication resumes`, async t => {
  const f = await fixture(t); let current = f.host.read();
  const favorite = { id: randomUUID(), kind: 'link', title: 'Original', url: 'https://example.test/', createdAt: 1 };
  if (deletion) current.profiles = [{ id: f.account.profileIds[0], name: 'Personal', color: 'blue', createdAt: 1, store: emptySyncStore(), desktop: emptySyncDesktop(), windows: [] }];
  if (deletion) current.profiles[0].store.favorites.bar.push(favorite);
  f.host.read = () => structuredClone(current); f.host.apply = next => { const old = current; current = next; return () => { current = old; }; };
  await f.engine.pulse(); f.engine.start();
  f.advance(1000); current.settings.theme = 'amber'; f.engine.markDirty('settings');
  f.transport.writeObject = async () => { throw new Error('SYNC_TIMEOUT'); };
  await assert.rejects(f.engine.pulse(), /SYNC_TIMEOUT/);
  const sealed = structuredClone(f.engine.local.outbox);
  const remote = { item: deletion ? 'favorites' : 'settings', profile: deletion ? f.engine.local.mapping[current.profiles[0].id] : null,
    key: deletion ? favorite.id : 'searchEngine', value: deletion ? null : 'bing', id: randomUUID(), base: null, time: 1000300, device: randomUUID(), generation: randomUUID() };
  f.engine.incoming = async () => ({ operations: [remote], conflicts: [], cursors: {}, waiting: null });
  f.advance(100000); await f.receive(null);
  assert.deepEqual(f.engine.local.outbox, sealed, 'receiving must preserve immutable retry bytes');
  assert.equal(deletion ? current.profiles[0].store.favorites.bar.length : current.settings.searchEngine, deletion ? 0 : 'bing');
  // C's edit follows B's update, but predates A's unrelated settings edit.
  const later = { ...remote, id: randomUUID(), base: remote.id, time: 1000600, device: randomUUID(), generation: randomUUID(),
    value: deletion ? { parent: 'bar', position: 0, entry: { ...favorite, title: 'Restored by C' } } : 'google' };
  f.engine.incoming = async () => ({ operations: [remote, later], conflicts: [], cursors: {}, waiting: null });
  f.transport.writeObject = async () => {};
  const sealedOperations = [], seal = f.engine.sealOutbox.bind(f.engine);
  f.engine.sealOutbox = (...args) => { sealedOperations.push(...args[1]); return seal(...args); };
  f.advance(200); await f.engine.pulse(true);
  assert.equal(sealedOperations.some(operation => operation.key === remote.key), false, 'received records must never become this device\'s operations');
  assert.equal(f.engine.local.records.find(operation => operation.key === remote.key)?.id, later.id);
  assert.equal(deletion ? current.profiles[0].store.favorites.bar[0].title : current.settings.searchEngine, deletion ? 'Restored by C' : 'google');
  assert.equal(current.settings.theme, 'amber');
});

test('a newer remote operation supersedes a held edit without discarding later local edits', async t => {
  const f = await fixture(t); let current = f.host.read();
  f.host.read = () => structuredClone(current); f.host.apply = next => { const old = current; current = next; return () => { current = old; }; };
  await f.engine.pulse(); f.engine.start();
  f.advance(1000); current.settings.theme = 'amber'; f.engine.markDirty('settings');
  f.transport.writeObject = async () => { throw new Error('SYNC_PLAN_REQUIRED'); };
  await assert.rejects(f.engine.pulse(), /SYNC_PLAN_REQUIRED/);
  const held = f.engine.local.outbox.operations.find(operation => operation.key === 'theme');
  f.advance(1000); current.settings.language = 'es'; f.engine.markDirty('settings');
  const remote = { ...held, id: randomUUID(), base: held.base, value: 'daylight', time: 2000000, device: randomUUID(), generation: randomUUID() };
  f.engine.incoming = async () => ({ operations: [remote], conflicts: [], cursors: {}, waiting: null });
  await f.receive(null);
  assert.equal(current.settings.theme, 'daylight'); assert.equal(current.settings.language, 'es');
  f.transport.writeObject = async () => {};
  await f.engine.pulse(true);
  assert.equal(f.engine.local.records.find(operation => operation.key === 'theme').id, remote.id);
  assert.equal(current.settings.language, 'es');
});

test('empty aggregate pages do not rewrite sealed engine state or retain a second cursor', async t => {
  const f = await fixture(t); await f.engine.pulse(); f.engine.start();
  const file = join(f.directory, 'sync/state.sealed'), before = readFileSync(file);
  await f.receive({ changes: [], cursor: 'idle-cursor', retryAfterMs: 0 });
  assert.deepEqual(readFileSync(file), before); assert.equal('quantumCursor' in f.engine.local, false);
});

test('Quantum start survives an unavailable account and subscribes and syncs when accountChanged resolves it', async t => {
  const f = await fixture(t); f.active(false);
  const engine = new SyncEngine(f.directory, f.cipher, f.host, f.options); t.after(() => engine.stop());
  assert.doesNotThrow(() => engine.start()); assert.equal(engine.state().failure, 'SYNC_NOT_ALLOWED'); assert.equal(f.subscribed, 0);
  f.active(true); engine.accountChanged(); assert.equal(f.subscribed, 1);
  await engine.pulse(); assert.equal(engine.state().failure, null); assert.ok(engine.state().lastSynced);
});

test('Quantum accountChanged replaces a stale profile subscription without rebuilding unchanged account state', async t => {
  const f = await fixture(t); f.engine.start(); assert.equal(f.subscribed, 1);
  f.engine.accountChanged(); assert.equal(f.subscribed, 1);
  f.account.revision = 'session-2'; f.engine.accountChanged(); assert.equal(f.unsubscribed, 1); assert.equal(f.subscribed, 2);
});

test('Quantum retries a failed rebuild with a forced inventory refresh before committing receive', async t => {
  const f = await fixture(t), refreshes = []; await f.engine.pulse(); f.engine.start();
  f.transport.refreshObjects = async force => { refreshes.push(force); if (refreshes.length === 1) throw new Error('SYNC_STORAGE'); };
  await f.receive(null); assert.equal(f.engine.state().failure, 'SYNC_STORAGE');
  f.advance(5000); await f.engine.pulse(false, true);
  assert.deepEqual(refreshes, [true, true]); assert.equal(f.engine.state().failure, null);
});

test('Quantum ignores an obsolete permanent refusal after account capabilities change during upload', async t => {
  const f = await fixture(t); f.engine.start();
  let entered, refuse;
  const started = new Promise(resolve => { entered = resolve; });
  f.transport.writeObject = () => { entered(); return new Promise((_resolve, reject) => { refuse = reject; }); };
  const pulse = f.engine.pulse(); await started;
  f.account.revision = 'renewed-plan'; f.engine.accountChanged();
  refuse(new Error('SYNC_PLAN_REQUIRED')); await assert.rejects(pulse, /SYNC_PLAN_REQUIRED/);
  f.transport.writeObject = async () => {};
  await f.engine.pulse(); assert.equal(f.engine.state().failure, null); assert.equal(f.engine.local.outbox, null);
});

test('Quantum ignores an obsolete receive refusal after account capabilities change during download', async t => {
  const f = await fixture(t); await f.engine.pulse(); f.engine.start();
  let entered, refuse;
  const started = new Promise(resolve => { entered = resolve; });
  f.transport.readDescriptor = () => { entered(); return new Promise((_resolve, reject) => { refuse = reject; }); };
  const receive = f.receive(null); await started;
  f.account.revision = 'renewed-plan'; f.engine.accountChanged();
  refuse(new Error('SYNC_PLAN_REQUIRED')); await receive;
  f.transport.readDescriptor = async () => Buffer.from(JSON.stringify(f.engine.local.dataset));
  await f.engine.pulse(); assert.equal(f.engine.state().failure, null);
});

for (const mode of ['receive', 'publish']) for (const code of ['SYNC_STORAGE', 'SYNC_INVALID', 'SYNC_LIMIT', 'SYNC_PLAN_REQUIRED', 'SYNC_CONSENT_REQUIRED', 'SYNC_NOT_ALLOWED', 'SYNC_RATE_LIMITED']) {
  test(`Quantum ${mode} ${code} bounds requests over simulated time and resumes after capability change`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const f = await fixture(t), attempts = [], permanent = mode === 'publish' && ['SYNC_PLAN_REQUIRED', 'SYNC_CONSENT_REQUIRED'].includes(code);
    let time = 0, refused = true;
    if (mode === 'publish') {
      f.engine.local.fresh = ['settings'];
      f.transport.writeObject = async () => { attempts.push(time); if (refused) throw Object.assign(new Error(code), code === 'SYNC_RATE_LIMITED' ? { retryAfterMs: 70000 } : {}); };
    } else f.transport.readDescriptor = async () => { attempts.push(time); if (refused) throw Object.assign(new Error(code), code === 'SYNC_RATE_LIMITED' ? { retryAfterMs: 70000 } : {}); return Buffer.from(JSON.stringify(f.engine.local.dataset)); };
    f.engine.start();
    if (mode === 'receive') await f.receive(null).catch(() => {});
    else await f.engine.pulse().catch(() => {});
    for (time = 1000; time <= 140000; time += 1000) { f.advance(1000); t.mock.timers.tick(1000); await f.engine.queue; }
    assert.deepEqual(attempts, permanent ? [0] : code === 'SYNC_RATE_LIMITED' ? [0, 70000, 140000] : [0, 5000, 15000, 35000, 75000, 135000]);
    assert.equal(f.engine.state().failure, code);
    refused = false;
    f.engine.accountChanged(); await f.engine.pulse(true); assert.equal(f.engine.state().failure, null, 'a forced pulse must retry without a capability revision');
    f.account.revision = 'new-capabilities'; f.engine.accountChanged(); await f.engine.pulse(); assert.equal(f.engine.state().failure, null);
  });
}

for (const transportKind of ['folder', 'quantum']) for (const pending of ['sealed outbox', 'unsealed edit', 'SYNC_PLAN_REQUIRED', 'SYNC_CONSENT_REQUIRED', 'SYNC_FULL', 'SYNC_RATE_LIMITED']) {
  for (const mutation of ['edit', 'deletion', 'remote deletion']) for (const ordering of ['remote older', 'remote newer']) {
    test(`original merge matrix: ${transportKind}, ${pending}, ${mutation}, ${ordering}`, async t => {
      const f = await fixture(t);
      if (transportKind === 'folder') {
        const folder = join(f.directory, 'cloud'), transport = new FolderTransport(folder, undefined, f.engine.local.dataset.datasetId);
        mkdirSync(folder);
        await transport.writeObject('dataset.hzs', Buffer.from(canonical(f.engine.local.dataset)), 4096);
        f.engine.local.transport = { kind: 'folder', folder }; f.engine.active = transport; f.engine.options.transport = () => transport;
      }
      let current = f.host.read();
      const favorite = { id: randomUUID(), kind: 'link', title: 'Base title', url: 'https://example.test/', createdAt: 1 };
      current.profiles = [{ id: f.account.profileIds[0], name: 'Personal', color: 'blue', createdAt: 1, store: emptySyncStore(), desktop: emptySyncDesktop(), windows: [] }];
      current.profiles[0].store.favorites.bar.push(favorite);
      f.host.read = () => structuredClone(current); f.host.apply = next => { const old = current; current = next; return () => { current = old; }; };
      await f.engine.pulse();
      const base = f.engine.local.records.find(operation => operation.key === favorite.id), writes = [], publish = f.engine.active.writeObject.bind(f.engine.active);
      f.engine.active.writeObject = async (path, bytes, cap) => { writes.push([path, bytes]); await publish(path, bytes, cap); };
      f.advance(1000);
      if (mutation === 'deletion') current.profiles[0].store.favorites.bar = [];
      else current.profiles[0].store.favorites.bar[0].title = 'Local title';
      f.engine.markDirty('favorites');
      let sealed;
      if (pending === 'sealed outbox') {
        f.engine.options.afterSeal = () => { throw new Error('Synthetic interruption'); };
        await assert.rejects(f.engine.pulse(), /Synthetic interruption|SYNC_STORAGE/); delete f.engine.options.afterSeal;
        sealed = structuredClone(f.engine.local.outbox);
      }
      if (pending.startsWith('SYNC_')) f.engine.pulseFailed(Object.assign(new Error(pending), pending === 'SYNC_RATE_LIMITED' ? { retryAfterMs: 70000 } : {}));
      const localTime = 1001000, remote = { ...base, id: randomUUID(), base: base.id, time: localTime + (ordering === 'remote newer' ? 500 : -500),
        device: randomUUID(), generation: randomUUID(), value: mutation === 'remote deletion' ? null : { ...base.value, entry: { ...favorite, title: 'Remote title' } } };
      const unrelated = { item: 'settings', profile: null, key: 'searchEngine', value: 'bing', id: randomUUID(), base: null, time: 1002000, device: remote.device, generation: remote.generation };
      f.engine.incoming = async () => ({ operations: [remote, unrelated], conflicts: [], cursors: {}, waiting: null });
      f.advance(pending === 'SYNC_RATE_LIMITED' ? 71000 : 6000); await f.engine.pulse(false, true);
      assert.equal(current.settings.searchEngine, 'bing');
      assert.equal(writes.length, 0, 'receive never publishes');
      if (sealed) assert.deepEqual(f.engine.local.outbox, sealed, 'sealed retry is immutable');
      else {
        assert.equal(f.engine.local.edits.find(edit => edit.record.key === favorite.id).base, base.id);
        // The causal base must survive a normal process restart after receive.
        f.engine.stop();
        const reopened = new SyncEngine(f.directory, f.cipher, f.host, f.options); t.after(() => reopened.stop());
        f.engine = reopened;
        f.engine.incoming = async () => ({ operations: [remote, unrelated], conflicts: [], cursors: {}, waiting: null });
      }
      const emitted = [], seal = f.engine.sealOutbox.bind(f.engine);
      f.engine.sealOutbox = (...args) => { emitted.push(...args[1]); return seal(...args); };
      f.advance(40000); await f.engine.pulse(true);
      const local = sealed?.operations.find(operation => operation.key === favorite.id) ?? emitted.find(operation => operation.key === favorite.id);
      assert.ok(local, 'the user operation is retained for publication'); assert.equal(local.base, base.id); assert.equal(local.time, localTime);
      const winner = ordering === 'remote newer' ? remote : local, loser = ordering === 'remote newer' ? local : remote;
      assert.equal(f.engine.local.records.find(operation => operation.key === favorite.id).id, winner.id);
      assert.deepEqual(f.engine.local.conflicts.find(conflict => conflict.id === loser.id)?.operation, loser);
      assert.equal(current.profiles[0].store.favorites.bar[0]?.title ?? null, winner.value?.entry.title ?? null);
      assert.equal(emitted.some(operation => operation.key === unrelated.key), false, 'received changes never become own operations');
      const published = [];
      for (const [path, bytes] of writes) {
        const match = /^writers\/([^/]+)\/([^/]+)\/batches\/([0-9]+)-([0-9a-f-]+)\.hzs$/.exec(path);
        if (!match) continue;
        published.push(...openSync(Buffer.from(f.engine.local.key, 'base64'), { dataset: f.engine.local.dataset.datasetId, device: match[1], generation: match[2], sequence: Number(match[3]), id: match[4], kind: 'batch' }, bytes).operations);
      }
      assert.equal(published.some(operation => operation.key === unrelated.key || operation.id === remote.id), false);
      const peer = new Map([[recordId(base), base]]), peerConflicts = new Map();
      mergeOperation(peer, remote, peerConflicts); for (const operation of published) mergeOperation(peer, operation, peerConflicts);
      assert.equal(peer.get(recordId(base)).id, winner.id, 'another receiver resolves the same winner');
      assert.deepEqual(peerConflicts.get(loser.id), loser);
      await f.engine.pulse(true);
      assert.equal(emitted.filter(operation => operation.key === favorite.id).length, sealed ? 0 : 1, 'settled received values are never echoed');
    });
  }
}

for (const transportKind of ['folder', 'quantum']) test(`${transportKind} receive journal recovery retains an unsealed edit and its causal base`, async t => {
  const f = await fixture(t);
  if (transportKind === 'folder') f.engine.local.transport = { kind: 'folder', folder: f.directory };
  let current = f.host.read();
  f.host.read = () => structuredClone(current); f.host.apply = next => { const old = current; current = next; return () => { current = old; }; };
  await f.engine.pulse(); f.advance(1000);
  const base = f.engine.local.records.find(operation => operation.key === 'theme');
  current.settings.theme = 'amber'; f.engine.markDirty('settings'); f.engine.flushDirty();
  const stateFile = join(f.directory, 'sync/state.sealed'), previous = readFileSync(stateFile);
  const remote = { ...base, id: randomUUID(), base: base.id, value: 'daylight', time: 2000000, device: randomUUID(), generation: randomUUID() };
  f.engine.incoming = async () => ({ operations: [remote], conflicts: [], cursors: {}, waiting: null });
  await f.engine.pulse(false, true); assert.equal(current.settings.theme, 'amber');
  f.engine.stop(); writeFileSync(stateFile, previous);
  const reopened = new SyncEngine(f.directory, f.cipher, f.host, f.options); t.after(() => reopened.stop());
  await reopened.recoverApplication();
  assert.equal(current.settings.theme, 'amber');
  assert.equal(reopened.local.edits.find(edit => edit.record.key === 'theme').base, base.id);
  const emitted = [], seal = reopened.sealOutbox.bind(reopened);
  reopened.sealOutbox = (...args) => { emitted.push(...args[1]); return seal(...args); };
  reopened.incoming = async () => ({ operations: [], conflicts: [], cursors: {}, waiting: null });
  await reopened.pulse(true);
  const local = emitted.find(operation => operation.key === 'theme'); assert.ok(local); assert.equal(local.base, base.id);
  assert.equal(reopened.local.records.find(operation => operation.key === 'theme').id, remote.id);
  assert.deepEqual(reopened.local.conflicts.find(conflict => conflict.id === local.id)?.operation, local);
});

test('a new edit of a remote winner descends from it while the losing outbox stays sealed', async t => {
  const f = await fixture(t); let current = f.host.read();
  f.host.read = () => structuredClone(current); f.host.apply = next => { const old = current; current = next; return () => { current = old; }; };
  await f.engine.pulse(); f.advance(1000); current.settings.theme = 'amber'; f.engine.markDirty('settings');
  f.engine.options.afterSeal = () => { throw new Error('Synthetic interruption'); };
  await assert.rejects(f.engine.pulse()); delete f.engine.options.afterSeal;
  const sealed = f.engine.local.outbox.operations.find(operation => operation.key === 'theme');
  const remote = { ...sealed, id: randomUUID(), time: 2000000, value: 'daylight', device: randomUUID(), generation: randomUUID() };
  f.engine.incoming = async () => ({ operations: [remote], conflicts: [], cursors: {}, waiting: null });
  f.advance(6000); await f.engine.pulse(false, true); assert.equal(current.settings.theme, 'daylight');
  f.advance(1000); current.settings.theme = 'system'; f.engine.markDirty('settings'); f.engine.flushDirty();
  assert.equal(f.engine.local.edits.find(edit => edit.record.key === 'theme').base, remote.id);
  const emitted = [], seal = f.engine.sealOutbox.bind(f.engine);
  f.engine.sealOutbox = (...args) => { emitted.push(...args[1]); return seal(...args); };
  await f.engine.pulse(true);
  const latest = emitted.find(operation => operation.key === 'theme'); assert.equal(latest.base, remote.id);
  assert.equal(current.settings.theme, 'system'); assert.equal(f.engine.local.records.find(operation => operation.key === 'theme').id, latest.id);
  assert.equal(f.engine.local.conflicts.some(conflict => conflict.id === remote.id), false);
});
