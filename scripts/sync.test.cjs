const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, existsSync } = require('node:fs');
const { tmpdir, hostname } = require('node:os');
const { join, dirname } = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes, randomUUID } = require('node:crypto');
const { SyncEngine } = require('../dist/electron/sync-engine.js');
const { browserSyncHost } = require('../dist/electron/sync-browser.js');
const { sealSync, openSync, randomSyncKeys, canonical, SYNC_LIMITS } = require('../dist/electron/sync-format.js');
const { FolderTransport, decodeSync, deadline } = require('../dist/electron/sync-transport.js');
const transportModule = require('../dist/electron/sync-transport.js');
const { readSyncState } = require('../dist/electron/sync-storage.js');
const { createSettings } = require('../dist/electron/settings.js');
const { makeProfile, writeRegistry, profileStorePath } = require('../dist/electron/profiles.js');
const { readStore, writeStore } = require('../dist/electron/store.js');
const { createDesktop } = require('../dist/electron/desktop.js');
const { validateCommand } = require('../dist/electron/commands.js');
const { assertPrivateCommand } = require('../dist/electron/private-commands.js');

function cipher() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = randomBytes(12), box = createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, box.update(value, 'utf8'), box.final(), box.getAuthTag()]); },
    decryptString(value) { const box = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); box.setAuthTag(value.subarray(-16)); return Buffer.concat([box.update(value.subarray(12, -16)), box.final()]).toString('utf8'); },
  };
}
function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]); }
const fixtureCleanup = new Map();
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'horizon-sync-test-')); fixtureCleanup.set(root, []);
  t.after(() => { for (const cleanup of fixtureCleanup.get(root)) cleanup(); fixtureCleanup.delete(root); rmSync(root, { recursive: true, force: true }); });
  const folder = join(root, 'cloud'); mkdirSync(folder); return { root, folder };
}
function seat(t, root, name, options = {}) {
  const directory = join(root, name); mkdirSync(directory, { recursive: true }); const encryption = options.cipher ?? cipher();
  const settings = createSettings(join(directory, 'settings.json'), () => {}), profile = makeProfile('Personal', 'amber'); profile.createdAt = 100;
  let registry = { version: 1, activeId: profile.id, profiles: [profile], tombstones: [] }; writeRegistry(join(directory, 'profiles.json'), registry);
  const status = { readError: false, memoryOnly: false }, store = readStore(profileStorePath(directory, profile.id), encryption, status), desktop = createDesktop(join(dirname(profileStorePath(directory, profile.id)), 'notebooks.json'), encryption, () => {});
  const data = { store, status, desktop, sessions: { version: 2, windows: [] }, sessionStatus: { readError: false, memoryOnly: false }, favoritesVersion: 0, importProgress: null }, profiles = new Map([[profile.id, data]]);
  let now = 1000000;
  const host = browserSyncHost(directory, encryption, settings, { registry: () => registry, profiles, registryChanged: value => { registry = value; }, flush() { for (const value of profiles.values()) value.desktop.flush(); }, changed() {} });
  const engine = new SyncEngine(directory, encryption, host, { now: () => now, ...options }); fixtureCleanup.get(root).push(() => { engine.stop(); for (const value of profiles.values()) value.desktop.dispose(); });
  return { directory, engine, encryption, settings, profile, data, profiles, host,
    advance(value = 1000) { now += value; },
    store(edit, item = 'favorites') { edit(data.store); writeStore(profileStorePath(directory, profile.id), data.store, encryption); engine.markDirty(item); },
    read() { return host.read(); },
  };
}
const favorite = (id = randomUUID(), title = 'Synthetic favorite') => ({ kind: 'link', id, title, url: 'https://synthetic-sync.example/favorite', createdAt: 100 });
async function pair(t) {
  const { root, folder } = setup(t), a = seat(t, root, 'a'), b = seat(t, root, 'b');
  await a.engine.create(folder, true); await a.engine.pulse(); await b.engine.join(folder, a.engine.revealKey(), true); await b.engine.pulse(); await a.engine.pulse(); return { root, folder, a, b };
}
async function converge(a, b) { await a.engine.pulse(); await b.engine.pulse(); await a.engine.pulse(); }
function batchFiles(folder) { return files(folder).filter(path => path.includes('batches') && path.endsWith('.hzs')); }

test('sync converges all items through real validators and a third install joins checkpoints', async t => {
  const { root, folder } = setup(t), a = seat(t, root, 'a'), b = seat(t, root, 'b');
  const folderId = randomUUID(), link = favorite();
  a.store(store => { store.favorites.bar = [{ kind: 'folder', id: folderId, name: 'Synthetic folder', createdAt: 100, children: [link] }]; store.history = [{ url: 'https://synthetic-sync.example/history', title: 'Synthetic history', lastVisit: 900000, visitCount: 3 }]; store.siteSettings = { blocking: [{ host: 'synthetic-sync.example', enabled: false }], dark: [{ host: 'synthetic-sync.example', enabled: true }], permissions: [{ origin: 'https://synthetic-sync.example', camera: 'block', microphone: 'ask', location: 'allow', notifications: 'block', lyra: 'ask' }], translation: { never: ['synthetic-sync.example'], always: [{ language: 'en', target: 'es' }] } }; store.clearCacheOnClose = true; });
  a.settings.setTheme('daylight', false); a.settings.setLanguage('es');
  const project = a.data.desktop.create('Synthetic research'), projectFolder = a.data.desktop.createFolder(project.id, 'Synthetic notes'); a.data.desktop.addNote(project.id, 'Synthetic note', 'Synthetic notebook text', projectFolder.id);
  const captureId = randomUUID(), image = Buffer.from('Synthetic capture bytes');
  a.data.desktop.addCapture(null, { id: captureId, folder: null, kind: 'area', title: 'Synthetic capture', text: '', note: 'Synthetic capture note', source: { url: 'https://synthetic-sync.example/capture', title: 'Synthetic capture source' }, image: null, createdAt: 100, updatedAt: 100 }, image, { width: 20, height: 20, cut: false });
  const group = randomUUID(); a.data.sessions.windows = [{ id: randomUUID(), selected: true, session: { version: 3, tabs: [{ url: 'https://synthetic-sync.example/tab', title: 'Synthetic tab', groupId: group }], groups: [{ id: group, name: 'Synthetic group' }] } }];
  await a.engine.create(folder, true); await a.engine.setItem('history', true); await a.engine.pulse();
  await b.engine.join(folder, a.engine.revealKey(), true); await b.engine.setItem('history', true); await b.engine.pulse(); await a.engine.pulse();
  for (const peer of [b, seat(t, root, 'c')]) {
    if (!peer.engine.state().configured) { await peer.engine.join(folder, a.engine.revealKey(), true); await peer.engine.setItem('history', true); await peer.engine.pulse(); }
    const state = peer.read(), source = a.read();
    assert.deepEqual(state.settings, source.settings); assert.deepEqual(state.profiles[0].store.favorites, source.profiles[0].store.favorites); assert.deepEqual(state.profiles[0].store.history, source.profiles[0].store.history); assert.deepEqual(state.profiles[0].store.siteSettings, source.profiles[0].store.siteSettings); assert.equal(state.profiles[0].store.clearCacheOnClose, true);
    assert.deepEqual(state.profiles[0].desktop.projects, source.profiles[0].desktop.projects); assert.equal(peer.data.desktop.image(null, captureId).equals(image), true);
    assert.equal(peer.engine.state().computers.some(computer => computer.windows.some(window => window.tabs.some(tab => tab.title === 'Synthetic tab') && window.groups.some(entry => entry.title === 'Synthetic group'))), true);
  }
  for (const path of files(folder)) for (const plain of ['Synthetic favorite', 'Synthetic notebook text', 'Synthetic capture bytes', 'synthetic-sync.example']) assert.equal(readFileSync(path).includes(Buffer.from(plain)), false);
  const second = makeProfile('Synthetic second', 'blue'); a.host.apply({ ...a.read(), profiles: [...a.read().profiles, { id: second.id, name: second.name, color: second.color, createdAt: second.createdAt, store: { ...a.read().profiles[0].store, favorites: { bar: [], other: [] }, history: [] }, desktop: { ...a.read().profiles[0].desktop, projects: [], captures: [], inUse: null }, windows: [] }] }, new Map());
  a.engine.markDirty('profiles'); await converge(a, b); assert.equal(b.read().profiles.length, 2);
});

for (const item of ['favorites', 'settings', 'desktop']) test(`sync concurrent ${item} edits converge and retain the older version`, async t => {
  const { a, b } = await pair(t);
  let id;
  if (item === 'favorites') { id = randomUUID(); a.store(store => store.favorites.bar.push(favorite(id, 'Base'))); }
  if (item === 'settings') { a.settings.setLanguage('es'); a.engine.markDirty(item); }
  if (item === 'desktop') { const project = a.data.desktop.create('Research'); a.data.desktop.addNote(project.id, 'Base', 'Base text'); id = { project: project.id, item: project.items[0].id }; a.engine.markDirty(item); }
  await converge(a, b); a.advance(); b.advance(2000);
  const edit = (peer, newer) => {
    if (item === 'favorites') peer.store(store => { store.favorites.bar[0].title = newer ? 'Newer' : 'Older'; });
    if (item === 'settings') { peer.settings.setLanguage(newer ? 'system' : 'en'); peer.engine.markDirty(item); }
    if (item === 'desktop') { peer.data.desktop.update(id.project, id.item, { title: newer ? 'Newer' : 'Older' }); peer.engine.markDirty(item); }
  };
  edit(a, false); edit(b, true); await converge(a, b);
  const value = peer => item === 'favorites' ? peer.data.store.favorites.bar[0].title : item === 'settings' ? peer.settings.language : peer.data.desktop.item(id.project, id.item).title;
  assert.equal(value(a), item === 'settings' ? 'system' : 'Newer'); assert.equal(value(b), value(a));
  assert.equal(a.engine.state().conflicts.some(conflict => conflict.item === item), true); assert.equal(b.engine.state().conflicts.some(conflict => conflict.item === item), true);
  const conflict = a.engine.state().conflicts.find(conflict => conflict.item === item && (item !== 'desktop' || conflict.title === 'Older')); await a.engine.restoreConflict(conflict.id); await converge(a, b); assert.equal(value(b), item === 'settings' ? 'en' : 'Older');
  const kept = b.engine.state().conflicts.find(conflict => conflict.item === item); if (kept) { await b.engine.dismissConflict(kept.id); assert.equal(b.engine.state().conflicts.some(conflict => conflict.id === kept.id), false); }
});

test('sync deletion against an edit uses time and retains deletion or edit', async t => {
  const { a, b } = await pair(t); a.store(store => store.favorites.bar.push(favorite())); await converge(a, b);
  a.advance(); b.advance(2000); a.store(store => { store.favorites.bar = []; }); b.store(store => { store.favorites.bar[0].title = 'Edited after deletion'; }); await converge(a, b);
  assert.equal(a.data.store.favorites.bar[0].title, 'Edited after deletion'); assert.equal(a.engine.state().conflicts.some(conflict => conflict.deleted), true);
  a.advance(4000); b.advance(); a.store(store => { store.favorites.bar = []; }); b.store(store => { store.favorites.bar[0].title = 'Older edit'; }); await converge(a, b);
  assert.equal(a.data.store.favorites.bar.length, 0); assert.equal(b.data.store.favorites.bar.length, 0);
});

test('sync switches stop publication and application and reenable with a checkpoint', async t => {
  const { folder, a, b } = await pair(t); await a.engine.setItem('favorites', false); await b.engine.setItem('favorites', false);
  a.store(store => store.favorites.bar.push(favorite(undefined, 'Local while off'))); const before = batchFiles(folder).length; await a.engine.pulse(); assert.equal(batchFiles(folder).length, before);
  await b.engine.setItem('favorites', true); b.advance(); b.store(store => store.favorites.bar.push(favorite(undefined, 'Remote while off'))); await b.engine.pulse(); await a.engine.pulse(); assert.equal(a.data.store.favorites.bar.length, 1); assert.equal(a.data.store.favorites.bar[0].title, 'Local while off');
  await a.engine.setItem('favorites', true); await converge(a, b); assert.equal(b.data.store.favorites.bar.some(entry => entry.title === 'Local while off'), true);
  assert.equal(files(folder).some(path => path.includes('checkpoints')), true);
});

test('sync sequence gaps wait without applying later records', async t => {
  const { folder, a, b } = await pair(t); const state = a.engine.local, key = Buffer.from(state.key, 'base64'), id = randomUUID(), sequence = state.sequence + 2;
  const operation = { item: 'settings', profile: null, key: 'language', value: 'es', id: randomUUID(), base: null, time: 2000000, device: state.device, generation: state.generation };
  const identity = { dataset: state.dataset.datasetId, device: state.device, generation: state.generation, sequence, id, kind: 'batch' }, parts = ['writers', state.device, state.generation, 'batches', `${sequence}-${id}.hzs`];
  await new FolderTransport(join(folder, 'Horizon Sync', state.dataset.datasetId)).publish(parts, sealSync(key, identity, { version: 1, kind: 'batch', createdAt: 1000000, sequence, operations: [operation], conflicts: [] }), SYNC_LIMITS.package);
  await b.engine.pulse(); assert.equal(b.settings.language, 'system');
  const missingId = randomUUID(), missing = { ...identity, sequence: sequence - 1, id: missingId };
  await new FolderTransport(join(folder, 'Horizon Sync', state.dataset.datasetId)).publish([...parts.slice(0, -1), `${sequence - 1}-${missingId}.hzs`], sealSync(key, missing, { version: 1, kind: 'batch', createdAt: 1000000, sequence: sequence - 1, operations: [], conflicts: [] }), SYNC_LIMITS.package);
  await b.engine.pulse(); assert.equal(b.settings.language, 'es');
});

test('sync crash after sealing republishes exactly the saved ciphertext on restart', async t => {
  const { root, folder } = setup(t); let crash = true; const a = seat(t, root, 'a', { afterSeal() { if (crash) throw new Error('Synthetic crash'); } }); a.store(store => store.favorites.bar.push(favorite()));
  await a.engine.create(folder, true); await assert.rejects(a.engine.pulse(), /SYNC_STORAGE/);
  const pending = a.engine.local.outbox, saved = pending.files.map(file => ({ parts: file.parts, bytes: readFileSync(join(a.directory, 'sync', 'outbox', file.file)) }));
  const oldGeneration = a.engine.local.generation; crash = false;
  const reopened = new SyncEngine(a.directory, a.encryption, a.host, { now: () => 1000000 }); t.after(() => reopened.stop()); assert.equal(reopened.local.generation, oldGeneration); await reopened.pulse();
  for (const file of saved) assert.equal(readFileSync(join(folder, 'Horizon Sync', reopened.local.dataset.datasetId, ...file.parts)).equals(file.bytes), true);
  const copied = join(root, 'copy'); mkdirSync(join(copied, 'sync'), { recursive: true }); copyFileSync(join(a.directory, 'sync', 'state.sealed'), join(copied, 'sync', 'state.sealed')); const clone = new SyncEngine(copied, a.encryption, a.host); assert.notEqual(clone.local.device, a.engine.local.device);
});

for (const attack of ['tampered', 'truncated', 'oversized', 'newer', 'moved', 'invalid-record']) test(`sync refuses ${attack} packages without changing stores or receipts`, async t => {
  const { folder, a, b } = await pair(t); a.advance(); a.store(store => store.favorites.bar.push(favorite())); await a.engine.pulse();
  const path = batchFiles(folder).find(path => path.endsWith(a.engine.local.outbox?.files[0]?.parts.at(-1) ?? 'impossible')) ?? batchFiles(folder).filter(path => path.includes(a.engine.local.device)).sort((a, b) => Number(a.split(/[\\/]/).at(-1).split('-')[0]) - Number(b.split(/[\\/]/).at(-1).split('-')[0])).at(-1);
  let bytes = readFileSync(path);
  if (attack === 'tampered') bytes[bytes.length - 1] ^= 1;
  if (attack === 'truncated') bytes = bytes.subarray(0, 25);
  if (attack === 'oversized') bytes = Buffer.alloc(SYNC_LIMITS.package + 1);
  if (attack === 'newer') bytes[8] = 2;
  if (attack === 'invalid-record') {
    const state = a.engine.local, name = path.split(/[\\/]/).at(-1), sequence = Number(name.split('-')[0]), id = name.slice(String(sequence).length + 1, -4), identity = { dataset: state.dataset.datasetId, device: state.device, generation: state.generation, sequence, id, kind: 'batch' }, payload = openSync(Buffer.from(state.key, 'base64'), identity, bytes); payload.operations[0].value.entry.url = 'file:///synthetic'; bytes = sealSync(Buffer.from(state.key, 'base64'), identity, payload);
  }
  if (attack === 'moved') {
    const state = a.engine.local, device = randomUUID(), generation = randomUUID(), name = path.split(/[\\/]/).at(-1), target = join(folder, 'Horizon Sync', state.dataset.datasetId, 'writers', device, generation, 'batches', `1-${name.slice(name.indexOf('-') + 1)}`); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  } else writeFileSync(path, bytes);
  const before = canonical(b.read()), cursors = canonical(b.engine.local.cursors); await assert.rejects(b.engine.pulse(), /SYNC_/); assert.equal(canonical(b.read()), before); assert.equal(canonical(b.engine.local.cursors), cursors);
});

test('sync ignores cloud conflict copies and partial files', async t => {
  const { folder, a, b } = await pair(t), state = a.engine.local, path = join(folder, 'Horizon Sync', state.dataset.datasetId, 'writers', state.device, state.generation, 'batches');
  for (const name of [`99-${randomUUID()}-MOTHERSHIP.hzs`, `99-${randomUUID()}.hzs.partial`, 'unknown.hzs']) writeFileSync(join(path, name), Buffer.from('Synthetic untrusted garbage'));
  await b.engine.pulse(); assert.equal(b.engine.state().failure, null);
});

test('sync refuses wrong keys and requires acceptance before touching the folder', async t => {
  const { root, folder } = setup(t), a = seat(t, root, 'a'), b = seat(t, root, 'b'); await assert.rejects(a.engine.create(folder, false)); assert.equal(files(folder).length, 0); await a.engine.create(folder, true);
  const other = await randomSyncKeys.create(); await assert.rejects(b.engine.join(folder, randomSyncKeys.encode(other.key), true), /SYNC_WRONG_KEY/); assert.equal(b.engine.state().configured, false); assert.equal(existsSync(join(b.directory, 'sync', 'state.sealed')), false);
  const bytes = readFileSync(join(a.directory, 'sync', 'state.sealed')); assert.equal(bytes.includes(Buffer.from(a.engine.revealKey())), false);
});

test('sync decoder caps decompression and authenticates blob paths', async () => {
  const key = randomBytes(32), dataset = randomUUID(), device = randomUUID(), generation = randomUUID(), id = randomUUID(), identity = { dataset, device, generation, id, sequence: 1, kind: 'batch' };
  const { gzipSync } = require('node:zlib'); const nonce = randomBytes(12), box = createCipheriv('aes-256-gcm', key, nonce); box.setAAD(Buffer.from(canonical(identity)));
  const compressed = gzipSync(Buffer.alloc(SYNC_LIMITS.plain + 1)), encrypted = Buffer.concat([box.update(compressed), box.final()]), header = Buffer.alloc(46); header.write('HZSYNC\r\n'); header[8] = 1; header[9] = 0; header.writeBigUInt64BE(1n, 10); nonce.copy(header, 18); box.getAuthTag().copy(header, 30);
  await assert.rejects(decodeSync(key, identity, Buffer.concat([header, encrypted])), /SYNC_INVALID/);
  const blob = { ...identity, kind: 'blob', sequence: 0 }, bytes = sealSync(key, blob, Buffer.from('Synthetic image')); await assert.rejects(decodeSync(key, { ...blob, id: randomUUID() }, bytes), /SYNC_INVALID/);
});

test('sync folder operations and workers have time limits', async () => { await assert.rejects(deadline(new Promise(() => {}), 10), /SYNC_TIMEOUT/); });

test('sync commands use exact keys and private windows refuse every command', () => {
  const commands = [{ type: 'sync-create', accepted: true }, { type: 'sync-join', accepted: true, key: 'synthetic-key-input' }, { type: 'sync-set-item', item: 'history', enabled: true }, { type: 'sync-now' }, { type: 'sync-leave', removeOwnFiles: false }, { type: 'sync-reveal-key' }, { type: 'sync-restore-conflict', id: randomUUID() }, { type: 'sync-dismiss-conflict', id: randomUUID() }];
  for (const command of commands) { assert.deepEqual(validateCommand(command), command); assert.throws(() => validateCommand({ ...command, folder: 'forged path' }), /SYNC_INVALID/); assert.throws(() => assertPrivateCommand(command), /SYNC_PRIVATE/); for (const key of Object.keys(command)) { const missing = { ...command }; delete missing[key]; assert.throws(() => validateCommand(missing)); } }
  assert.throws(() => validateCommand({ type: 'sync-create', accepted: false }), /SYNC_INVALID/);
});

test('sync leave only removes the current device files and forgets the local key', async t => {
  const { folder, a, b } = await pair(t), otherFiles = files(folder).filter(path => path.includes(b.engine.local.device)); await a.engine.leave(true); assert.equal(a.engine.state().configured, false); assert.equal(existsSync(join(a.directory, 'sync', 'state.sealed')), false); for (const path of otherFiles) assert.equal(existsSync(path), true);
});

test('sync capture metadata edits reuse immutable blob bytes and missing blobs wait', async t => {
  const { folder, a, b } = await pair(t), id = randomUUID(), image = Buffer.from('Synthetic capture revision');
  a.data.desktop.addCapture(null, { id, folder: null, kind: 'area', title: 'Capture', text: '', note: '', source: { url: 'https://synthetic.example/image', title: 'Image' }, image: null, createdAt: 1, updatedAt: 1 }, image, { width: 10, height: 10, cut: false }); a.engine.markDirty('desktop'); await a.engine.pulse();
  const path = files(folder).find(path => path.includes('blobs')), original = readFileSync(path); rmSync(path);
  const before = canonical(b.read()), cursor = canonical(b.engine.local.cursors); await assert.rejects(b.engine.pulse(), /SYNC_BLOB_PENDING/); assert.equal(canonical(b.read()), before); assert.equal(canonical(b.engine.local.cursors), cursor);
  writeFileSync(path, original); await b.engine.pulse(); assert.equal(b.data.desktop.image(null, id).equals(image), true);
  a.advance(); a.data.desktop.update(null, id, { title: 'Updated capture metadata' }); a.engine.markDirty('desktop'); await converge(a, b);
  assert.equal(readFileSync(path).equals(original), true); assert.equal(b.data.desktop.item(null, id).title, 'Updated capture metadata');
});

test('sync rolls back settings and per-profile stores after a later write fails', async t => {
  const { a, b } = await pair(t); a.store(store => store.favorites.bar.push(favorite())); a.settings.setLanguage('es'); a.engine.markDirty('settings'); const project = a.data.desktop.create('Remote research'); a.data.desktop.addNote(project.id, 'Rejected note', 'Synthetic body'); a.engine.markDirty('desktop'); await a.engine.pulse();
  const before = canonical(b.read()), cursor = canonical(b.engine.local.cursors), encrypt = b.encryption.encryptString;
  b.encryption.encryptString = value => { if (value.includes('Rejected note')) throw new Error('Synthetic unavailable storage'); return encrypt(value); };
  await assert.rejects(b.engine.pulse(), /SYNC_STORAGE/); b.encryption.encryptString = encrypt;
  assert.equal(canonical(b.read()), before); assert.equal(canonical(b.engine.local.cursors), cursor); await b.engine.pulse(); assert.equal(b.settings.language, 'es'); assert.equal(b.data.store.favorites.bar.length, 1);
});

test('sync creates checkpoints after 500 operations and only cleans old own batches', async t => {
  const { root, folder, a, b } = await pair(t); const previousCheckpoint = a.engine.local.checkpointSequence;
  a.store(store => { for (let index = 0; index < 500; index++) store.favorites.bar.push(favorite(randomUUID(), 'Synthetic item ' + index)); }); await a.engine.pulse();
  assert.equal(a.engine.local.checkpointSequence > previousCheckpoint, true);
  await b.engine.pulse(); const others = batchFiles(folder).filter(path => path.includes(b.engine.local.device)); a.advance(31 * 86400000); a.store(store => { store.favorites.bar[0].title = 'Later checkpoint'; }); a.engine.local.operationsSinceCheckpoint = 499; await a.engine.pulse();
  for (const path of others) assert.equal(existsSync(path), true);
  assert.equal(batchFiles(folder).filter(path => path.includes(a.engine.local.device)).length, 1);
  const c = seat(t, root, 'c'); await c.engine.join(folder, a.engine.revealKey(), true); await c.engine.pulse(); assert.equal(c.data.store.favorites.bar.length, 500); assert.equal(c.data.store.favorites.bar[0].title, 'Later checkpoint');
});

test('sync history tombstones preserve visits newer than the deletion', async t => {
  const { a, b } = await pair(t); await a.engine.setItem('history', true); await b.engine.setItem('history', true);
  const url = 'https://synthetic.example/visited'; a.store(store => store.history.push({ url, title: 'Visit', lastVisit: 1000000, visitCount: 1 }), 'history'); await converge(a, b);
  a.advance(1000); b.advance(2000); a.store(store => { store.history = []; }, 'history'); b.store(store => { store.history[0].lastVisit = 1005000; store.history[0].visitCount++; }, 'history'); await converge(a, b);
  assert.equal(a.data.store.history[0].lastVisit, 1005000); assert.equal(b.data.store.history[0].visitCount, 2);
});

test('sync folder disappearance fails without changing the published snapshot', async t => {
  const { folder, a } = await pair(t); const previous = canonical(a.engine.local.snapshot), synced = a.engine.state().lastSynced; rmSync(folder, { recursive: true, force: true }); await assert.rejects(a.engine.pulse(), /SYNC_FOLDER/); assert.equal(canonical(a.engine.local.snapshot), previous); assert.equal(a.engine.state().lastSynced, synced);
});

test('sync switching off a sealed item retires the batch and still syncs enabled items', async t => {
  const { root, folder } = setup(t); let crash = false; const a = seat(t, root, 'a', { afterSeal() { if (crash) throw new Error('Synthetic interruption'); } }); await a.engine.create(folder, true); await a.engine.pulse();
  const b = seat(t, root, 'b'); await b.engine.join(folder, a.engine.revealKey(), true); await b.engine.pulse(); await a.engine.pulse();
  a.store(store => store.favorites.bar.push(favorite())); a.settings.setLanguage('es'); a.engine.markDirty('settings'); crash = true; await assert.rejects(a.engine.pulse()); const pending = a.engine.local.outbox.files.filter(file => file.parts[3] === 'batches');
  await a.engine.setItem('favorites', false); crash = false; await converge(a, b); assert.equal(b.settings.language, 'es'); assert.equal(b.data.store.favorites.bar.length, 0); for (const file of pending) assert.equal(existsSync(join(folder, 'Horizon Sync', a.engine.local.dataset.datasetId, ...file.parts)), false);
});

test('sync focus receives and the development pulse publishes after its delay', async t => {
  const { root, folder } = setup(t), a = seat(t, root, 'a', { pulseMs: 50 }), b = seat(t, root, 'b'); await a.engine.create(folder, true); await a.engine.pulse(); await b.engine.join(folder, a.engine.revealKey(), true); await b.engine.pulse(); await a.engine.pulse();
  a.store(store => store.favorites.bar.push(favorite())); a.advance(100); a.engine.start();
  for (let index = 0; index < 100 && !a.engine.local.records.some(record => record.item === 'favorites'); index++) await new Promise(done => setTimeout(done, 20));
  assert.equal(a.engine.local.records.some(record => record.item === 'favorites'), true); a.engine.stop(); b.engine.focus();
  for (let index = 0; index < 100 && b.data.store.favorites.bar.length === 0; index++) await new Promise(done => setTimeout(done, 20)); assert.equal(b.data.store.favorites.bar.length, 1);
});

test('sync rejects unavailable secret storage and basic_text before creating a dataset', async t => {
  const { root, folder } = setup(t);
  for (const [index, protection] of [{ ...cipher(), isEncryptionAvailable: () => false }, { ...cipher(), getSelectedStorageBackend: () => 'basic_text' }].entries()) {
    const peer = seat(t, root, 'locked-' + index, { cipher: protection }); await assert.rejects(peer.engine.create(folder, true), /SYNC_LOCKED/); assert.equal(files(folder).length, 0);
  }
});

test('sync bounds writer discovery and ignores unrelated folder names', async t => {
  const { folder, a } = await pair(t), path = join(folder, 'Horizon Sync', a.engine.local.dataset.datasetId, 'writers');
  mkdirSync(join(path, 'cloud-conflict-copy')); await a.engine.pulse();
  for (let index = 0; index < 65; index++) mkdirSync(join(path, randomUUID())); const before = canonical(a.read()); await assert.rejects(a.engine.pulse(), /SYNC_LIMIT/); assert.equal(canonical(a.read()), before);
});

test('sync a committed apply journal never overwrites later local edits', async t => {
  const { a, b } = await pair(t); a.store(store => store.favorites.bar.push(favorite())); await converge(a, b);
  b.advance(); b.store(store => { store.favorites.bar[0].title = 'Edited after applying'; }); await converge(b, a); assert.equal(a.data.store.favorites.bar[0].title, 'Edited after applying');
});

test('sync recovers writes after a crash before the applied receipt was saved', async t => {
  const { a, b } = await pair(t), stateFile = join(b.directory, 'sync', 'state.sealed'), oldState = readFileSync(stateFile), id = randomUUID(), image = Buffer.from('Synthetic recovery image');
  a.data.desktop.addCapture(null, { id, folder: null, kind: 'area', title: 'Recovery image', text: '', note: '', source: { url: 'https://synthetic.example/recovery', title: 'Image' }, image: null, createdAt: 1, updatedAt: 1 }, image, { width: 10, height: 10, cut: false }); a.engine.markDirty('desktop');
  a.store(store => store.favorites.bar.push(favorite())); await a.engine.pulse(); await b.engine.pulse(); assert.equal(existsSync(join(b.directory, 'sync', 'apply.sealed')), true);
  writeFileSync(stateFile, oldState); const recovered = new SyncEngine(b.directory, b.encryption, b.host, { now: () => 1000000 }); t.after(() => recovered.stop()); await recovered.pulse(); assert.equal(b.data.store.favorites.bar.length, 1); assert.equal(recovered.state().failure, null); assert.equal(b.data.desktop.image(null, id).equals(image), true);
  const reference = recovered.local.records.find(record => record.item === 'desktop' && record.key === id).value.entry.image.blob, readImage = b.host.image; let calls = 0; b.host.image = (...args) => { calls++; return readImage(...args); };
  await recovered.pulse(); assert.equal(calls, 0); assert.deepEqual(recovered.local.records.find(record => record.item === 'desktop' && record.key === id).value.entry.image.blob, reference);
});

test('sync reenable checkpoints publish deletions made while an item was off', async t => {
  const { a, b } = await pair(t); a.store(store => store.favorites.bar.push(favorite())); await converge(a, b); await a.engine.setItem('favorites', false); a.store(store => { store.favorites.bar = []; }); await a.engine.pulse(); assert.equal(a.data.store.favorites.bar.length, 0);
  a.advance(); await a.engine.setItem('favorites', true); await converge(a, b); assert.equal(a.data.store.favorites.bar.length, 0); assert.equal(b.data.store.favorites.bar.length, 0);
});

test('sync preserves live site-settings and download references during application', async t => {
  const { a, b } = await pair(t), sites = b.data.store.siteSettings, downloads = b.data.store.downloads;
  a.store(store => { store.siteSettings.blocking.push({ host: 'synthetic.example', enabled: false }); }, 'siteSettings'); await converge(a, b); assert.equal(b.data.store.siteSettings === sites, true); assert.equal(b.data.store.downloads === downloads, true); assert.equal(sites.blocking[0].enabled, false);
});

test('sync local edits during worker decoding survive and are published by the retry', async t => {
  const { a, b } = await pair(t), id = randomUUID(), image = Buffer.from('Synthetic image for worker race');
  a.data.desktop.addCapture(null, { id, folder: null, kind: 'area', title: 'Image', text: '', note: '', source: { url: 'https://synthetic.example/race', title: 'Image' }, image: null, createdAt: 1, updatedAt: 1 }, image, { width: 10, height: 10, cut: false }); a.engine.markDirty('desktop'); await a.engine.pulse();
  const read = b.host.read; let changed = false;
  b.host.read = () => { const snapshot = read(); if (!changed) { changed = true; setTimeout(() => b.store(store => store.favorites.bar.push(favorite(undefined, 'Edited during receive'))), 0); } return snapshot; };
  await assert.rejects(b.engine.pulse(), /SYNC_CHANGED/); b.host.read = read; assert.equal(b.data.store.favorites.bar[0].title, 'Edited during receive'); await converge(b, a); assert.equal(a.data.store.favorites.bar[0].title, 'Edited during receive'); assert.equal(b.data.desktop.image(null, id).equals(image), true);
});

test('sync a disabled Desktop capture stays local while other items continue syncing', async t => {
  const { folder, a, b } = await pair(t); await a.engine.setItem('desktop', false); const id = randomUUID(), image = Buffer.from('Synthetic disabled capture');
  a.data.desktop.addCapture(null, { id, folder: null, kind: 'area', title: 'Disabled image', text: '', note: '', source: { url: 'https://synthetic.example/off', title: 'Image' }, image: null, createdAt: 1, updatedAt: 1 }, image, { width: 10, height: 10, cut: false }); a.settings.setLanguage('es'); a.engine.markDirty('settings'); await converge(a, b);
  assert.equal(b.settings.language, 'es'); assert.equal(b.data.desktop.captureList().length, 0); assert.equal(files(folder).filter(path => path.includes('blobs')).length, 0); assert.equal(a.data.desktop.image(null, id).equals(image), true);
});

test('sync restored local state gets a fresh generation even when the cloud folder is offline', async t => {
  const { a } = await pair(t), path = join(a.directory, 'sync', 'state.sealed'), backup = readFileSync(path), generation = a.engine.local.generation;
  a.store(store => store.favorites.bar.push(favorite())); await a.engine.pulse(); writeFileSync(path, backup);
  const restored = new SyncEngine(a.directory, a.encryption, a.host); assert.notEqual(restored.local.generation, generation); assert.equal(restored.local.device, a.engine.local.device);
});

test('sync refuses an unreadable local session instead of publishing an empty window list', async t => {
  const { a, b } = await pair(t), before = canonical(b.read()), cursor = canonical(b.engine.local.cursors);
  a.store(store => store.favorites.bar.push(favorite())); await a.engine.pulse(); b.data.sessionStatus.readError = true;
  await assert.rejects(b.engine.pulse(), /SYNC_STORAGE/); b.data.sessionStatus.readError = false;
  assert.equal(canonical(b.read()), before); assert.equal(canonical(b.engine.local.cursors), cursor); await b.engine.pulse(); assert.equal(b.data.store.favorites.bar.length, 1);
});

test('sync unpublished edit times survive a restart and the later remote rename wins', async t => {
  const { a, b } = await pair(t); a.store(store => store.favorites.bar.push(favorite(undefined, 'Base'))); await converge(a, b);
  a.advance(1000); a.store(store => { store.favorites.bar[0].title = 'Older before restart'; }); a.engine.stop();
  const saved = readSyncState(join(a.directory, 'sync', 'state.sealed'), a.encryption); assert.equal(saved.dirty.favorites, 1001000);
  a.engine = new SyncEngine(a.directory, a.encryption, a.host, { now: () => 1010000 }); t.after(() => a.engine.stop());
  b.advance(2000); b.store(store => { store.favorites.bar[0].title = 'Newer after restart'; }); await converge(a, b);
  for (const peer of [a, b]) {
    assert.equal(peer.data.store.favorites.bar[0].title, 'Newer after restart');
    const conflict = peer.engine.local.conflicts.find(conflict => conflict.operation.value?.entry?.title === 'Older before restart'); assert.equal(conflict.operation.time, 1001000);
    assert.equal(peer.engine.local.records.find(record => record.item === 'favorites').time, 1002000);
  }
});

test('sync startup store writes preserve record edit times after an offline restart', async t => {
  const { a, b } = await pair(t); a.store(store => store.favorites.bar.push(favorite(undefined, 'Base'))); await converge(a, b);
  a.advance(1000); a.store(store => { store.favorites.bar[0].title = 'From A'; }); a.engine.stop();
  b.advance(2000); b.store(store => { store.favorites.bar[0].title = 'From B'; }); await b.engine.pulse();
  a.engine = new SyncEngine(a.directory, a.encryption, a.host, { now: () => 1010000 }); t.after(() => a.engine.stop());
  for (const item of ['favorites', 'history', 'siteSettings', 'tabs', 'desktop', 'settings', 'profiles']) a.engine.markDirty(item);
  await a.engine.pulse(); await b.engine.pulse();
  for (const peer of [a, b]) {
    assert.equal(peer.data.store.favorites.bar[0].title, 'From B');
    assert.equal(peer.engine.local.records.find(record => record.item === 'favorites').time, 1002000);
    const conflict = peer.engine.local.conflicts.find(conflict => conflict.operation.value?.entry?.title === 'From A'); assert.equal(conflict.operation.time, 1001000);
  }
});

test('sync later edits to another record do not restamp an unpublished rename', async t => {
  const { a, b } = await pair(t); a.store(store => store.favorites.bar.push(favorite(undefined, 'Base'), favorite(undefined, 'Other'))); await converge(a, b);
  a.advance(1000); a.store(store => { store.favorites.bar[0].title = 'Older record edit'; }); await new Promise(done => setTimeout(done, 600));
  a.advance(3000); a.store(store => { store.favorites.bar[1].title = 'Later unrelated edit'; }); a.engine.stop();
  b.advance(2000); b.store(store => { store.favorites.bar[0].title = 'Newer record edit'; }); await b.engine.pulse();
  a.engine = new SyncEngine(a.directory, a.encryption, a.host, { now: () => 1010000 }); t.after(() => a.engine.stop()); await a.engine.pulse(); await b.engine.pulse();
  for (const peer of [a, b]) {
    assert.deepEqual(peer.data.store.favorites.bar.map(entry => entry.title), ['Newer record edit', 'Later unrelated edit']);
    assert.equal(peer.engine.local.conflicts.find(conflict => conflict.operation.value?.entry?.title === 'Older record edit').operation.time, 1001000);
  }
});

test('sync unchanged store writes create no record stamps or batches', async t => {
  const { folder, a } = await pair(t); a.store(store => store.favorites.bar.push(favorite())); await a.engine.pulse();
  const baseline = canonical(a.engine.local.records), batches = batchFiles(folder).length;
  a.advance(10000); for (const item of ['favorites', 'history', 'siteSettings', 'tabs', 'desktop', 'settings', 'profiles']) a.engine.markDirty(item);
  await new Promise(done => setTimeout(done, 600)); const saved = readSyncState(join(a.directory, 'sync', 'state.sealed'), a.encryption);
  assert.deepEqual(saved.edits, []); assert.deepEqual(saved.dirty, {}); await a.engine.pulse();
  assert.equal(batchFiles(folder).length, batches); assert.equal(canonical(a.engine.local.records), baseline);
});

for (const receiveBeforeEnabling of [false, true]) test(`sync joining with empty history never deletes remote visits, receive first: ${receiveBeforeEnabling}`, async t => {
  const { root, folder } = setup(t), a = seat(t, root, 'a'), b = seat(t, root, 'b');
  const entry = { url: 'https://synthetic.example/join-history', title: 'Existing remote visit', lastVisit: 1000000, visitCount: 1 };
  a.store(store => store.history.push(entry), 'history'); await a.engine.create(folder, true); await a.engine.setItem('history', true); await a.engine.pulse();
  await b.engine.join(folder, a.engine.revealKey(), true); if (receiveBeforeEnabling) await b.engine.pulse();
  assert.deepEqual(b.data.store.history, []); await b.engine.setItem('history', true); await converge(b, a);
  for (const peer of [a, b]) { assert.deepEqual(peer.data.store.history, [entry]); assert.deepEqual(peer.engine.state().conflicts, []); }
  assert.equal(b.engine.local.records.some(record => record.item === 'history' && record.value === null), false);
});

for (const title of ['Last known history title', '']) test(`sync kept history deletions retain their last title or address across restart: ${title || 'address'}`, async t => {
  const { a, b } = await pair(t); await a.engine.setItem('history', true); await b.engine.setItem('history', true);
  const url = 'https://synthetic.example/deleted-history'; a.store(store => store.history.push({ url, title, lastVisit: 1000000, visitCount: 1 }), 'history'); await converge(a, b);
  a.advance(1000); a.store(store => { store.history = []; }, 'history'); a.engine.stop();
  b.advance(2000); b.store(store => { store.history[0].title = 'Newer history title'; store.history[0].lastVisit = 1002000; }, 'history'); await b.engine.pulse();
  a.engine = new SyncEngine(a.directory, a.encryption, a.host, { now: () => 1010000 }); t.after(() => a.engine.stop()); await a.engine.pulse(); await b.engine.pulse();
  for (const peer of [a, b]) {
    const conflict = peer.engine.state().conflicts.find(conflict => conflict.item === 'history' && conflict.deleted); assert.equal(conflict.title, title || url);
    peer.engine.stop(); const reopened = new SyncEngine(peer.directory, peer.encryption, peer.host); t.after(() => reopened.stop()); assert.equal(reopened.state().conflicts.find(conflict => conflict.deleted).title, title || url);
  }
});

test('sync a burst persists its last edit time in one throttled state write', async t => {
  const { a } = await pair(t); a.store(store => store.favorites.bar.push(favorite(undefined, 'Base'))); await a.engine.pulse();
  const encrypt = a.encryption.encryptString; let writes = 0;
  a.encryption.encryptString = value => { if (Object.hasOwn(JSON.parse(value).value, 'dirty')) writes++; return encrypt(value); };
  for (let index = 0; index < 20; index++) { a.advance(1); a.data.store.favorites.bar[0].title = 'Burst ' + index; a.engine.markDirty('favorites'); }
  assert.equal(writes, 0); await new Promise(done => setTimeout(done, 600)); assert.equal(writes, 1);
  const saved = readSyncState(join(a.directory, 'sync', 'state.sealed'), a.encryption); assert.equal(saved.dirty.favorites, 1000020); assert.equal(saved.edits[0].time, 1000020); assert.equal(saved.edits[0].record.value.entry.title, 'Burst 19');
  a.engine.stop(); assert.equal(writes, 1); a.encryption.encryptString = encrypt;
});

test('sync encrypted computer records name remote tabs and conflicts with sanitized display names', async t => {
  const { root, folder } = setup(t), raw = ' \x00Synthetic\x7f\x85 computer ' + 'x'.repeat(80) + ' ', name = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64).trim();
  const a = seat(t, root, 'a', { name: raw }), b = seat(t, root, 'b');
  a.data.sessions.windows = [{ id: randomUUID(), selected: true, session: { version: 3, tabs: [{ title: 'Web tab', url: 'https://synthetic.example/name' }], groups: [] } }];
  await a.engine.create(folder, true); a.store(store => store.favorites.bar.push(favorite(undefined, 'Base'))); await a.engine.pulse(); await b.engine.join(folder, a.engine.revealKey(), true); await converge(b, a);
  assert.deepEqual(b.engine.state().computers.map(({ id, name }) => ({ id, name })), [{ id: a.engine.local.device, name }]);
  assert.equal(b.engine.local.records.find(record => record.item === 'computer' && record.key === b.engine.local.device).value.name, hostname().trim().slice(0, 64));
  a.advance(); b.advance(2000); a.store(store => { store.favorites.bar[0].title = 'Older'; }); b.store(store => { store.favorites.bar[0].title = 'Newer'; }); await converge(a, b);
  for (const peer of [a, b]) assert.deepEqual(peer.engine.state().conflicts.find(conflict => conflict.title === 'Older').computer, { id: a.engine.local.device, name });
  for (const path of files(folder)) assert.equal(readFileSync(path).includes(Buffer.from(name)), false);
});

test('sync omits remote windows without web tabs and computers without listed windows', async t => {
  const { a, b } = await pair(t), empty = { id: randomUUID(), selected: true, session: { version: 3, tabs: [{ title: 'Settings', url: 'horizon://settings' }], groups: [] } }, web = { id: randomUUID(), selected: false, session: { version: 3, tabs: [{ title: 'Web', url: 'https://synthetic.example/tab' }], groups: [] } };
  a.data.sessions.windows = [empty, web]; a.engine.markDirty('tabs'); await converge(a, b);
  assert.deepEqual(b.engine.state().computers[0].windows.map(window => window.id), [web.id]);
  a.data.sessions.windows = [empty]; a.engine.markDirty('tabs'); await converge(a, b); assert.deepEqual(b.engine.state().computers, []);
});

test('sync unchanged pulses and restarts read no capture images and replacements read once', async t => {
  const { folder, a, b } = await pair(t), id = randomUUID(), image = Buffer.from('Synthetic cached capture'), original = a.host.image; let calls = 0;
  a.host.image = (...args) => { calls++; return original(...args); };
  a.data.desktop.addCapture(null, { id, folder: null, kind: 'area', title: 'Cached image', text: '', note: '', source: { url: 'https://synthetic.example/cache', title: 'Image' }, image: null, createdAt: 1, updatedAt: 1 }, image, { width: 10, height: 10, cut: false }); a.engine.markDirty('desktop'); await a.engine.pulse(); assert.equal(calls, 1);
  calls = 0; await a.engine.pulse(); assert.equal(calls, 0); await b.engine.pulse();
  a.advance(); a.data.desktop.update(null, id, { title: 'Metadata only' }); a.engine.markDirty('desktop'); await converge(a, b); assert.equal(calls, 0);
  a.engine.stop(); a.engine = new SyncEngine(a.directory, a.encryption, a.host, { now: () => 1002000 }); t.after(() => a.engine.stop()); await a.engine.pulse(); assert.equal(calls, 0);
  const before = files(folder).filter(path => path.includes('blobs')).length, replacement = Buffer.from('Synthetic edited capture'); assert.equal(replacement.length, image.length);
  a.data.desktop.replaceCapture(id, replacement, { width: 10, height: 10, cut: false }, 'area'); a.engine.markDirty('desktop'); await converge(a, b); assert.equal(calls, 1);
  assert.equal(files(folder).filter(path => path.includes('blobs')).length, before + 1); assert.equal(b.data.desktop.image(null, id).equals(replacement), true);
});

test('sync cleanup with recent batches decodes nothing and preserves their sealed creation times', async t => {
  const { a } = await pair(t); a.store(store => store.favorites.bar.push(favorite())); await a.engine.pulse(); a.engine.local.operationsSinceCheckpoint = 499; a.advance(); a.store(store => { store.favorites.bar[0].title = 'Checkpoint'; }); await a.engine.pulse();
  const decode = transportModule.decodeSync; let calls = 0; transportModule.decodeSync = (...args) => { calls++; return decode(...args); }; t.after(() => { transportModule.decodeSync = decode; });
  await a.engine.cleanup(a.engine.local); assert.equal(calls, 0);
  const state = readSyncState(join(a.directory, 'sync', 'state.sealed'), a.encryption); assert.deepEqual(state.ownBatches, a.engine.local.ownBatches); assert.equal(Object.keys(state.ownBatches).length, 3);
});

test('sync a new receiver decodes only the latest of three checkpoints', async t => {
  const { root, folder } = setup(t), a = seat(t, root, 'a'); await a.engine.create(folder, true); await a.engine.pulse();
  for (const title of ['Second checkpoint', 'Third checkpoint']) { a.advance(); a.engine.local.operationsSinceCheckpoint = 499; a.store(store => { store.favorites.bar = [favorite(undefined, title)]; }); await a.engine.pulse(); }
  const checkpoints = files(folder).filter(path => path.includes('checkpoints')); assert.equal(checkpoints.length, 3);
  const latest = checkpoints.sort((a, b) => Number(a.split(/[\\/]/).at(-1).split('-')[0]) - Number(b.split(/[\\/]/).at(-1).split('-')[0])).at(-1); for (const path of checkpoints) if (path !== latest) writeFileSync(path, Buffer.from('Synthetic unread older checkpoint'));
  const decode = transportModule.decodeSync; let calls = 0; transportModule.decodeSync = (...args) => { calls++; return decode(...args); }; t.after(() => { transportModule.decodeSync = decode; });
  const b = seat(t, root, 'b'); await b.engine.join(folder, a.engine.revealKey(), true); await b.engine.pulse(); assert.equal(calls, 1); assert.equal(b.data.store.favorites.bar[0].title, 'Third checkpoint');
});

test('sync refuses a checkpoint whose filename sequence differs from its sealed header', async t => {
  const { root, folder } = setup(t), a = seat(t, root, 'a'); await a.engine.create(folder, true); await a.engine.pulse();
  const path = files(folder).find(path => path.includes('checkpoints')), name = path.split(/[\\/]/).at(-1), sequence = Number(name.split('-')[0]); copyFileSync(path, join(dirname(path), `${sequence + 1}-${name.slice(name.indexOf('-') + 1)}`));
  const b = seat(t, root, 'b'); await b.engine.join(folder, a.engine.revealKey(), true); const before = canonical(b.read()); await assert.rejects(b.engine.pulse(), /SYNC_INVALID/); assert.equal(canonical(b.read()), before); assert.deepEqual(b.engine.local.cursors, {});
});

test('sync removes only its older checkpoints after thirty days and retains the latest', async t => {
  const { folder, a, b } = await pair(t), other = files(folder).filter(path => path.includes(b.engine.local.device) && path.includes('checkpoints'));
  const first = files(folder).find(path => path.includes(a.engine.local.device) && path.includes('checkpoints'));
  a.advance(29 * 86400000); a.engine.local.operationsSinceCheckpoint = 499; a.store(store => store.favorites.bar.push(favorite())); await a.engine.pulse(); assert.equal(existsSync(first), true);
  a.advance(2 * 86400000); a.engine.local.operationsSinceCheckpoint = 499; a.store(store => { store.favorites.bar[0].title = 'Latest retained'; }); await a.engine.pulse(); assert.equal(existsSync(first), false);
  assert.equal(files(folder).filter(path => path.includes(a.engine.local.device) && path.includes('checkpoints')).length, 2); for (const path of other) assert.equal(existsSync(path), true);
});
