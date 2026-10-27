const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { cpSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } = require('node:crypto');
const { SyncEngine } = require('../dist/electron/sync-engine.js');
const { QuantumTransport, enrollQuantumDataset } = require('../dist/electron/sync-quantum.js');
const { browserSyncHost } = require('../dist/electron/sync-browser.js');
const { canonical, checkIdentity, openSync, sealSync, SYNC_LIMITS } = require('../dist/electron/sync-format.js');
const { FolderTransport } = require('../dist/electron/sync-transport.js');
const { readSyncState } = require('../dist/electron/sync-storage.js');
const { createSettings } = require('../dist/electron/settings.js');
const { makeProfile, profileStorePath, writeRegistry } = require('../dist/electron/profiles.js');
const { readStore, writeStore } = require('../dist/electron/store.js');
const { createDesktop } = require('../dist/electron/desktop.js');
const { validateCommand } = require('../dist/electron/commands.js');
const { assertPrivateCommand } = require('../dist/electron/private-commands.js');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const favorite = (title = 'Quantum favorite') => ({ kind: 'link', id: randomUUID(), title, url: 'https://quantum-sync.example/favorite', createdAt: 100 });
function cipher() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = randomBytes(12), box = createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, box.update(value, 'utf8'), box.final(), box.getAuthTag()]); },
    decryptString(value) { const box = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); box.setAuthTag(value.subarray(-16)); return Buffer.concat([box.update(value.subarray(12, -16)), box.final()]).toString('utf8'); },
  };
}
async function fakeQuantum(t) {
  const datasets = new Map(), calls = [], refusals = [], keys = new Map(), credentials = new Map();
  let pageSize = 2, objectHeaders = null, pageReply = null;
  const scope = (account, app, id) => `${account}/${app}/${id}`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1'), token = request.headers.authorization?.replace(/^Bearer /, ''), identity = credentials.get(token);
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), call = { method: request.method, path: url.pathname, search: url.searchParams, identity, headers: request.headers, bytes }; calls.push(call);
      const json = (status, value, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', ...headers }); response.end(JSON.stringify(value)); };
      const error = (status, code, headers) => json(status, { error: { code } }, headers);
      if (!identity) { error(401, 'unauthorized'); return; }
      const forced = refusals.findIndex(item => (!item.method || item.method === request.method) && (!item.path || item.path === url.pathname));
      if (forced !== -1) { const value = refusals.splice(forced, 1)[0]; error(value.status, value.code, value.headers); return; }
      const { accountId, appId, computerId } = identity;
      if (url.pathname === '/v1/datasets' && request.method === 'GET') {
        const rows = [...datasets.values()].filter(value => value.accountId === accountId && value.appId === appId).map(({ id, appId, createdAt }) => ({ id, appId, createdAt })).sort((a, b) => a.id.localeCompare(b.id));
        const limit = Math.min(pageSize, Number(url.searchParams.get('limit') || 100)), after = url.searchParams.get('after') || '', page = rows.filter(value => value.id > after).slice(0, limit);
        json(200, { datasets: page, after: page.length === limit ? page.at(-1).id : null }); return;
      }
      const match = /^\/v1\/datasets\/([^/]+)(?:\/objects(?:\/(.+))?)?$/.exec(url.pathname);
      if (!match) { error(404, 'not_found'); return; }
      const id = decodeURIComponent(match[1]), location = scope(accountId, appId, id), path = match[2] && match[2].split('/').map(decodeURIComponent).join('/');
      let dataset = datasets.get(location);
      if (!url.pathname.includes('/objects') && request.method === 'PUT') {
        const existed = !!dataset;
        if (!dataset) { dataset = { id, appId, accountId, createdAt: 1793000000000, objects: new Map() }; datasets.set(location, dataset); }
        json(existed ? 200 : 201, { id, appId, createdAt: dataset.createdAt }); return;
      }
      if (!dataset) { error(404, 'not_found'); return; }
      if (!path && request.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || '', after = url.searchParams.get('after') || '', limit = Math.min(pageSize, Number(url.searchParams.get('limit') || 100));
        const rows = [...dataset.objects].filter(([name]) => name.startsWith(prefix) && name > after).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([path, body]) => ({ path, size: body.length, sha256: sha256(body), createdAt: 1793000000000 }));
        json(200, pageReply ? pageReply(rows, url) : { objects: rows, after: rows.length === limit ? rows.at(-1).path : null }); return;
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
        dataset.objects.set(path, Buffer.from(bytes)); json(previous ? 200 : 201, { success: true }); return;
      }
      if (!previous) { error(404, 'not_found'); return; }
      if (request.method === 'DELETE') { if (path === 'dataset.hzs') { error(403, 'delete_forbidden'); return; } dataset.objects.delete(path); json(200, { success: true }); return; }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(previous.length), 'X-Content-SHA256': sha256(previous), ...(objectHeaders ?? {}) }); response.end(previous);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function account(accountId = 'account-a', computerId = randomUUID(), appId = 'horizon') {
    keys.set(accountId, keys.get(accountId) ?? randomBytes(32)); const token = randomUUID(); credentials.set(token, { accountId, computerId, appId });
    const value = { accountId, computerId, profileIds: [randomUUID()], active: true,
      assertActive() { if (!value.active) throw new Error('SYNC_NOT_ALLOWED'); },
      async request(path, init = {}) {
        value.assertActive(); const headers = new Headers(init.headers); assert.equal(headers.has('Content-Length'), false, 'Chromium must choose Content-Length'); headers.set('Authorization', `Bearer ${token}`);
        return fetch(new URL(path, origin), { ...init, headers });
      },
      async deriveSyncKey(datasetId) { value.assertActive(); return Buffer.from(hkdfSync('sha256', keys.get(accountId), Buffer.alloc(0), `cosmic/account/horizon/sync/${datasetId}`, 32)); },
    }; return value;
  }
  return { calls, refusals, datasets, account, keys,
    dataset(account, id) { return datasets.get(scope(account.accountId, 'horizon', id)); },
    set pageSize(value) { pageSize = value; }, set objectHeaders(value) { objectHeaders = value; }, set pageReply(value) { pageReply = value; },
  };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'horizon-quantum-')), cleanup = [];
  t.after(() => { for (const close of cleanup) close(); rmSync(root, { recursive: true, force: true }); });
  return { root, cleanup };
}
function seat(fixture, name, account, options = {}) {
  const directory = join(fixture.root, name); mkdirSync(directory, { recursive: true }); const encryption = cipher();
  const settings = createSettings(join(directory, 'settings.json'), () => {}), profile = makeProfile('Personal', 'amber'); profile.createdAt = 100;
  let registry = { version: 1, activeId: profile.id, profiles: [profile], tombstones: [] }; writeRegistry(join(directory, 'profiles.json'), registry);
  const status = { readError: false, memoryOnly: false }, store = readStore(profileStorePath(directory, profile.id), encryption, status), desktop = createDesktop(join(dirname(profileStorePath(directory, profile.id)), 'notebooks.json'), encryption, () => {});
  const data = { store, status, desktop, sessions: { version: 2, windows: [] }, sessionStatus: { readError: false, memoryOnly: false }, favoritesVersion: 0, importProgress: null }, profiles = new Map([[profile.id, data]]);
  let now = 1000000, currentAccount = account; account.profileIds = [profile.id];
  const host = browserSyncHost(directory, encryption, settings, { registry: () => registry, profiles, registryChanged: value => { registry = value; }, flush() { for (const value of profiles.values()) value.desktop.flush(); }, changed() {} });
  const engine = new SyncEngine(directory, encryption, host, { now: () => now, quantum: id => currentAccount?.accountId === id && currentAccount.active ? currentAccount : undefined, ...options });
  fixture.cleanup.push(() => { engine.stop(); for (const value of profiles.values()) value.desktop.dispose(); });
  return { directory, engine, encryption, settings, profile, data, host, profiles,
    advance(value = 1000) { now += value; }, account(value) { currentAccount = value; }, read: host.read,
    store(edit, item = 'favorites') { edit(data.store); writeStore(profileStorePath(directory, profile.id), data.store, encryption); engine.markDirty(item); },
  };
}
async function converge(a, b) { await a.engine.pulse(); await b.engine.pulse(); await a.engine.pulse(); }
async function descriptor(account, datasetId) {
  const key = await account.deriveSyncKey(datasetId);
  return { magic: 'Horizon Sync', version: 1, datasetId, keyType: 'account', check: sealSync(key, checkIdentity(datasetId), { check: 'Horizon Sync' }).toString('base64') };
}
async function createDataset(account, datasetId = randomUUID()) {
  assert.equal((await account.request(`/v1/datasets/${datasetId}`, { method: 'PUT' })).ok, true);
  const transport = new QuantumTransport(account, datasetId), check = await descriptor(account, datasetId);
  await transport.writeObject('dataset.hzs', Buffer.from(canonical(check)), 4096); return { transport, check, datasetId };
}

test('Quantum transport has create-only retries, integrity checks, caps and own-writer deletion', async t => {
  const server = await fakeQuantum(t), account = server.account(), { transport, datasetId } = await createDataset(account), path = `writers/${account.computerId}/${randomUUID()}/blobs/${randomUUID()}.hzs`, bytes = Buffer.from('Opaque encrypted bytes');
  await transport.writeObject(path, bytes, 100); await transport.writeObject(path, bytes, 100);
  await assert.rejects(transport.writeObject(path, Buffer.from('Different bytes'), 100), /SYNC_CONFLICT/);
  assert.deepEqual(await transport.readObject(path, 100), bytes);
  await assert.rejects(transport.readObject(path, 1), /SYNC_LIMIT/); await assert.rejects(transport.writeObject(path, bytes, 1), /SYNC_LIMIT/);
  server.objectHeaders = { 'X-Content-SHA256': '0'.repeat(64) }; await assert.rejects(transport.readObject(path, 100), /SYNC_INVALID/); server.objectHeaders = null;
  await assert.rejects(transport.deleteOwnObject(path, randomUUID())); await assert.rejects(transport.deleteOwnObject('dataset.hzs', account.computerId));
  assert.equal(server.dataset(account, datasetId).objects.has(path), true); await transport.deleteOwnObject(path, account.computerId); assert.equal(server.dataset(account, datasetId).objects.has(path), false);
  const uploads = server.calls.filter(call => call.method === 'PUT' && call.path.includes('/objects/'));
  for (const call of uploads) { assert.equal(call.headers['x-content-sha256'], sha256(call.bytes)); assert.equal(call.headers['content-length'], String(call.bytes.length)); }
});

test('Quantum listings hide every page and yield each immediate child once', async t => {
  const server = await fakeQuantum(t), account = server.account(), { transport } = await createDataset(account), generation = randomUUID(), prefix = `writers/${account.computerId}/${generation}`;
  for (let index = 0; index < 7; index++) await transport.writeObject(`${prefix}/blobs/${randomUUID()}.hzs`, Buffer.from(String(index)), 10);
  await transport.writeObject(`${prefix}/batches/1-${randomUUID()}.hzs`, Buffer.from('Batch'), 10);
  assert.deepEqual(await Array.fromAsync(transport.listObjects('writers')), [`writers/${account.computerId}`]);
  assert.deepEqual((await Array.fromAsync(transport.listObjects(prefix))).sort(), [`${prefix}/batches`, `${prefix}/blobs`]);
  assert.equal((await Array.fromAsync(transport.listObjects(`${prefix}/blobs`))).length, 7);
  assert.ok(server.calls.filter(call => call.method === 'GET' && call.path.endsWith('/objects') && call.search.has('after')).length >= 6);
});

for (const invalid of ['repeated-cursor', 'duplicate-path', 'outside-prefix', 'invalid-checksum', 'oversized-page']) test(`Quantum listings refuse ${invalid} responses`, async t => {
  const server = await fakeQuantum(t), account = server.account(), { transport } = await createDataset(account), prefix = `writers/${account.computerId}/${randomUUID()}/blobs`;
  for (let index = 0; index < 3; index++) await transport.writeObject(`${prefix}/${randomUUID()}.hzs`, Buffer.from('Blob'), 10);
  server.pageReply = (rows, url) => {
    if (invalid === 'repeated-cursor') return { objects: rows, after: url.searchParams.get('after') ?? rows.at(-1).path };
    if (invalid === 'duplicate-path') return { objects: [rows[0], rows[0]], after: null };
    if (invalid === 'outside-prefix') return { objects: [{ ...rows[0], path: 'dataset.hzs' }], after: null };
    if (invalid === 'invalid-checksum') return { objects: [{ ...rows[0], sha256: 'not-a-checksum' }], after: null };
    return { objects: new Array(101).fill(rows[0]), after: null };
  };
  await assert.rejects(Array.fromAsync(transport.listObjects(prefix)), /SYNC_INVALID/);
});

test('Quantum transport bounds request and stalled-body deadlines', async () => {
  const account = { accountId: 'account-a', computerId: randomUUID(), profileIds: [randomUUID()], assertActive() {}, deriveSyncKey: async () => randomBytes(32), request: () => new Promise(() => {}) };
  const transport = new QuantumTransport(account, randomUUID(), 10); await assert.rejects(transport.readDescriptor(), /SYNC_TIMEOUT/);
  account.request = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }), { headers: { 'X-Content-SHA256': '0'.repeat(64) } });
  await assert.rejects(transport.readDescriptor(), /SYNC_TIMEOUT/);
});

for (const [status, code, failure] of [[403, 'sync_plan_required', 'SYNC_NOT_ALLOWED'], [403, 'pool_exceeded', 'SYNC_FULL'], [409, 'object_limit', 'SYNC_LIMIT'], [409, 'writer_limit_exceeded', 'SYNC_LIMIT'], [413, 'object_too_large', 'SYNC_LIMIT'], [429, 'rate_limited', 'SYNC_RATE_LIMITED'], [408, 'upload_timeout', 'SYNC_TIMEOUT']]) test(`Quantum maps ${status} ${code} without losing retry metadata`, async t => {
  const server = await fakeQuantum(t), account = server.account(), { transport } = await createDataset(account), path = `writers/${account.computerId}/${randomUUID()}/batches/1-${randomUUID()}.hzs`;
  server.refusals.push({ status, code, method: 'PUT', headers: { 'Retry-After': '7' } });
  await assert.rejects(transport.writeObject(path, Buffer.from('Sealed batch'), 100), error => error.message === failure && (status !== 429 || error.retryAfterMs === 7000));
});

test('Quantum cannot access another account or app and refuses another computer writer', async t => {
  const server = await fakeQuantum(t), owner = server.account(), { transport, datasetId } = await createDataset(owner);
  for (const account of [server.account('account-b'), server.account('account-a', randomUUID(), 'vault')]) {
    const other = new QuantumTransport(account, datasetId); await assert.rejects(other.readDescriptor()); await assert.rejects(Array.fromAsync(other.listObjects('writers')));
  }
  const path = `writers/${randomUUID()}/${randomUUID()}/blobs/${randomUUID()}.hzs`; await assert.rejects(transport.writeObject(path, Buffer.from('Forbidden'), 100), /SYNC_NOT_ALLOWED|SYNC_INVALID/);
  assert.equal(server.dataset(owner, datasetId).objects.size, 1);
});

test('Quantum enrollment creates an account descriptor and joins it from a new computer', async t => {
  const server = await fakeQuantum(t), first = server.account(), second = server.account(), created = await enrollQuantumDataset(first), joined = await enrollQuantumDataset(second);
  assert.equal(joined.datasetId, created.datasetId); assert.deepEqual(joined.key, created.key); assert.equal(created.descriptor.keyType, 'account');
  const expected = Buffer.from(hkdfSync('sha256', server.keys.get(first.accountId), Buffer.alloc(0), `cosmic/account/horizon/sync/${created.datasetId}`, 32)); assert.deepEqual(created.key, expected);
  assert.deepEqual(openSync(expected, checkIdentity(created.datasetId), Buffer.from(created.descriptor.check, 'base64')), { check: 'Horizon Sync' });
  assert.equal(server.calls.filter(call => call.method === 'PUT' && !call.path.includes('/objects/')).length, 1);
});

test('Quantum enrollment follows dataset pages past absent and wrong-key descriptors', async t => {
  const server = await fakeQuantum(t), account = server.account(); server.pageSize = 1;
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  await account.request(`/v1/datasets/${ids[0]}`, { method: 'PUT' });
  const wrong = await createDataset(account, ids[1]); server.dataset(account, wrong.datasetId).objects.set('dataset.hzs', Buffer.from(canonical({ ...wrong.check, check: sealSync(randomBytes(32), checkIdentity(wrong.datasetId), { check: 'Horizon Sync' }).toString('base64') })));
  const valid = await createDataset(account, ids[2]), joined = await enrollQuantumDataset(account); assert.equal(joined.datasetId, valid.datasetId);
  assert.ok(server.calls.some(call => call.path === '/v1/datasets' && call.search.has('after')));
});

test('Quantum enrollment surfaces the dataset limit and publishes no descriptor', async t => {
  const server = await fakeQuantum(t), account = server.account(); server.refusals.push({ method: 'PUT', status: 409, code: 'dataset_limit' });
  await assert.rejects(enrollQuantumDataset(account), /SYNC_LIMIT/); assert.equal(server.datasets.size, 0);
});

test('Quantum engines converge every enabled category, capture bytes and registered computer ids without idle uploads', async t => {
  const server = await fakeQuantum(t), local = fixture(t), accountA = server.account(), accountB = server.account(), a = seat(local, 'a', accountA), b = seat(local, 'b', accountB);
  const snapshot = a.read(); snapshot.profiles[0].color = 'blue'; a.host.apply(snapshot, new Map());
  const link = favorite(), image = Buffer.from('Quantum synthetic capture bytes'), captureId = randomUUID(), folderId = randomUUID();
  a.store(store => { store.favorites.bar = [{ kind: 'folder', id: folderId, name: 'Quantum folder', createdAt: 100, children: [link] }]; store.history = [{ url: 'https://quantum-sync.example/history', title: 'Quantum visit', lastVisit: 900000, visitCount: 3 }]; store.siteSettings = { blocking: [{ host: 'quantum-sync.example', enabled: false }], dark: [{ host: 'quantum-sync.example', enabled: true }], permissions: [{ origin: 'https://quantum-sync.example', camera: 'block', microphone: 'ask', location: 'allow', notifications: 'block', lyra: 'ask' }], translation: { never: ['quantum-sync.example'], always: [{ language: 'en', target: 'es' }] } }; store.clearCacheOnClose = true; });
  a.settings.setTheme('daylight', false); a.settings.setLanguage('es'); const project = a.data.desktop.create('Quantum research'), folder = a.data.desktop.createFolder(project.id, 'Quantum notes'); a.data.desktop.addNote(project.id, 'Quantum note', 'Quantum notebook text', folder.id);
  a.data.desktop.addCapture(null, { id: captureId, folder: null, kind: 'area', title: 'Quantum capture', text: '', note: 'Quantum note', source: { url: 'https://quantum-sync.example/capture', title: 'Source' }, image: null, createdAt: 100, updatedAt: 100 }, image, { width: 20, height: 20, cut: false });
  const group = randomUUID(); a.data.sessions.windows = [{ id: randomUUID(), selected: true, session: { version: 3, tabs: [{ url: 'https://quantum-sync.example/tab', title: 'Quantum tab', groupId: group }], groups: [{ id: group, name: 'Quantum group' }] } }];
  await a.engine.enrollQuantum(accountA); await a.engine.setItem('history', true); await a.engine.pulse(); await b.engine.enrollQuantum(accountB); await b.engine.setItem('history', true); await converge(a, b); await b.engine.pulse();
  assert.equal(a.engine.local.dataset.datasetId, b.engine.local.dataset.datasetId); assert.equal(a.engine.local.device, accountA.computerId); assert.equal(b.engine.local.device, accountB.computerId);
  assert.equal(b.read().profiles[0].color, 'blue'); assert.deepEqual(b.data.store.favorites, a.data.store.favorites); assert.deepEqual(b.data.store.history, a.data.store.history); assert.deepEqual(b.data.store.siteSettings, a.data.store.siteSettings); assert.equal(b.data.store.clearCacheOnClose, true); assert.equal(b.settings.language, 'es'); assert.equal(b.settings.mode, a.settings.mode);
  assert.equal(b.data.desktop.list()[0].items[0].text, 'Quantum notebook text'); assert.deepEqual(b.data.desktop.image(null, captureId), image); assert.ok(b.engine.state().computers.some(computer => computer.id === accountA.computerId && computer.windows.some(window => window.tabs.some(tab => tab.title === 'Quantum tab'))));
  for (const call of server.calls.filter(call => call.method === 'PUT' && call.path.includes('/objects/writers/'))) assert.equal(call.path.split('/objects/writers/')[1].split('/')[0], call.identity.computerId);
  const stored = readSyncState(join(a.directory, 'sync', 'state.sealed'), a.encryption); assert.deepEqual(stored.transport, { kind: 'quantum', accountId: accountA.accountId, datasetId: stored.dataset.datasetId }); assert.equal(JSON.stringify(stored).includes('Bearer'), false);
  for (const bytes of server.dataset(accountA, stored.dataset.datasetId).objects.values()) for (const plain of ['Quantum favorite', 'Quantum notebook text', 'Quantum synthetic capture bytes', 'quantum-sync.example']) assert.equal(bytes.includes(Buffer.from(plain)), false);
  const count = server.calls.filter(call => call.method === 'PUT').length; await converge(a, b); await b.engine.pulse(); assert.equal(server.calls.filter(call => call.method === 'PUT').length, count);
});

test('Quantum projects only explicitly assigned profiles and retains unassigned local data', async t => {
  const server = await fakeQuantum(t), local = fixture(t), accountA = server.account(), a = seat(local, 'a', accountA), accountB = server.account(), b = seat(local, 'b', accountB);
  const snapshot = a.read(), second = makeProfile('Unassigned private profile', 'blue'), extra = structuredClone(snapshot.profiles[0]); extra.id = second.id; extra.name = second.name; extra.store.favorites.bar = [favorite('Unassigned secret favorite')];
  a.host.apply({ ...snapshot, profiles: [...snapshot.profiles, extra] }, new Map()); a.store(store => store.favorites.bar.push(favorite('Assigned favorite')));
  await a.engine.enrollQuantum(accountA); await a.engine.pulse(); await b.engine.enrollQuantum(accountB); await converge(a, b);
  assert.equal(b.read().profiles.some(profile => profile.name === second.name), false); assert.equal(b.data.store.favorites.bar.some(entry => entry.title === 'Assigned favorite'), true); assert.equal(a.read().profiles.find(profile => profile.id === second.id).store.favorites.bar[0].title, 'Unassigned secret favorite');
  const serialized = JSON.stringify(a.engine.local.records); assert.equal(serialized.includes('Unassigned secret favorite'), false); assert.equal(serialized.includes(second.name), false);
});

test('Quantum sign-out and account changes retain the old outbox without publishing it to a new account', async t => {
  const server = await fakeQuantum(t), local = fixture(t), original = server.account(), a = seat(local, 'a', original); await a.engine.enrollQuantum(original); await a.engine.pulse();
  a.advance(); a.store(store => store.favorites.bar.push(favorite('Pending original-account edit'))); a.engine.options.afterSeal = () => { throw new Error('Synthetic interruption'); }; await assert.rejects(a.engine.pulse());
  const pending = structuredClone(a.engine.local.outbox); assert.equal(pending.accountId, original.accountId); const count = server.calls.length; original.active = false; a.account(undefined);
  await assert.rejects(a.engine.pulse(), /SYNC_NOT_ALLOWED/); assert.equal(server.calls.length, count);
  const replacement = server.account('account-b'); replacement.profileIds = [a.profile.id]; a.account(replacement); await assert.rejects(a.engine.pulse(), /SYNC_NOT_ALLOWED/); assert.equal(server.calls.length, count); assert.deepEqual(a.engine.local.outbox, pending); assert.equal(a.data.store.favorites.bar[0].title, 'Pending original-account edit');
  original.active = true; a.account(original); delete a.engine.options.afterSeal; await a.engine.pulse(); assert.equal(a.engine.local.outbox, null); assert.equal(server.calls.some(call => call.identity?.accountId === replacement.accountId), false);
});

test('Quantum descriptor rate limiting retains its delay and blocks every engine request until Retry-After', async t => {
  const server = await fakeQuantum(t), local = fixture(t), account = server.account(), a = seat(local, 'a', account); await a.engine.enrollQuantum(account); await a.engine.pulse();
  const datasetId = a.engine.local.dataset.datasetId, path = `/v1/datasets/${datasetId}/objects/dataset.hzs`, refusal = { method: 'GET', path, status: 429, code: 'rate_limited', headers: { 'Retry-After': '7' } };
  server.refusals.push(refusal); await assert.rejects(new QuantumTransport(account, datasetId).readDescriptor(), error => error.message === 'SYNC_RATE_LIMITED' && error.retryAfterMs === 7000);
  server.refusals.push(refusal); await assert.rejects(a.engine.pulse(), /SYNC_RATE_LIMITED/); const calls = server.calls.length;
  await a.engine.pulse(); a.advance(6999); await a.engine.pulse(); assert.equal(server.calls.length, calls); assert.equal(a.engine.state().failure, 'SYNC_RATE_LIMITED');
  a.advance(2); await a.engine.pulse(); assert.ok(server.calls.length > calls); assert.equal(a.engine.state().failure, null);
});

test('a folder leg cannot publish an account-tagged Quantum outbox under another account', async t => {
  const server = await fakeQuantum(t), local = fixture(t), original = server.account(), a = seat(local, 'a', original), folder = join(local.root, 'cloud'); mkdirSync(folder);
  await a.engine.enrollQuantum(original); await a.engine.pulse(); const datasetId = a.engine.local.dataset.datasetId, copied = new FolderTransport(folder, SYNC_LIMITS.timeout, datasetId);
  await copied.writeObject('dataset.hzs', Buffer.from(canonical(a.engine.local.dataset)), 4096);
  a.advance(); a.store(store => store.favorites.bar.push(favorite('Original-account pending edit'))); a.engine.options.afterSeal = () => { throw new Error('Synthetic interruption'); }; await assert.rejects(a.engine.pulse()); delete a.engine.options.afterSeal;
  const pending = structuredClone(a.engine.local.outbox); assert.equal(pending.accountId, original.accountId); await a.engine.switchTransport({ kind: 'folder', folder }); assert.deepEqual(a.engine.local.outbox, pending);
  const replacement = server.account('account-b'); replacement.profileIds = [a.profile.id]; await createDataset(replacement, datasetId); a.account(replacement); const calls = server.calls.length;
  await assert.rejects(a.engine.switchTransport({ kind: 'quantum', accountId: replacement.accountId, datasetId }), /SYNC_SWITCH_FAILED/);
  assert.equal(server.calls.length, calls); assert.equal(a.engine.local.transport.kind, 'folder'); assert.deepEqual(a.engine.local.outbox, pending); assert.equal(a.data.store.favorites.bar[0].title, 'Original-account pending edit');
});

test('rekeying a Quantum outbox through a random-key folder cannot change its account ownership', async t => {
  const server = await fakeQuantum(t), local = fixture(t), original = server.account(), a = seat(local, 'a', original), folder = join(local.root, 'cloud'); mkdirSync(folder);
  await a.engine.create(folder, true); await a.engine.pulse(); const datasetId = a.engine.local.dataset.datasetId; await createDataset(original, datasetId);
  await a.engine.switchTransport({ kind: 'quantum', accountId: original.accountId, datasetId }); await a.engine.pulse(); a.advance(); a.store(store => store.favorites.bar.push(favorite('Original-account rekeyed edit')));
  a.engine.options.afterSeal = () => { throw new Error('Synthetic interruption'); }; await assert.rejects(a.engine.pulse()); await a.engine.switchTransport({ kind: 'folder', folder }); await assert.rejects(a.engine.pulse());
  const pending = structuredClone(a.engine.local.outbox), replacement = server.account('account-b'); replacement.profileIds = [a.profile.id]; await createDataset(replacement, datasetId); a.account(replacement); const calls = server.calls.length;
  await assert.rejects(a.engine.switchTransport({ kind: 'quantum', accountId: replacement.accountId, datasetId }), /SYNC_SWITCH_FAILED/); assert.equal(server.calls.length, calls); assert.deepEqual(a.engine.local.outbox, pending); assert.equal(a.data.store.favorites.bar[0].title, 'Original-account rekeyed edit');
});

test('a copied Quantum install can wait signed out and resume with its newly registered computer writer', async t => {
  const server = await fakeQuantum(t), local = fixture(t), original = server.account(), a = seat(local, 'a', original); await a.engine.enrollQuantum(original); await a.engine.pulse();
  a.advance(); a.store(store => store.favorites.bar.push(favorite('Copied-install pending edit'))); a.engine.options.afterSeal = () => { throw new Error('Synthetic interruption'); }; await assert.rejects(a.engine.pulse()); a.engine.stop();
  const directory = join(local.root, 'copied'); mkdirSync(directory); cpSync(join(a.directory, 'sync'), join(directory, 'sync'), { recursive: true }); let current;
  const restored = new SyncEngine(directory, a.encryption, a.host, { now: () => 1000000, quantum: id => current?.accountId === id ? current : undefined }); local.cleanup.push(() => restored.stop());
  assert.equal(restored.state().configured, true); const calls = server.calls.length; await assert.rejects(restored.pulse(), /SYNC_NOT_ALLOWED/); assert.equal(server.calls.length, calls);
  current = server.account(); current.profileIds = [a.profile.id]; restored.accountChanged(); await restored.pulse();
  assert.equal(restored.local.device, current.computerId); assert.equal(restored.local.outbox, null); assert.equal(a.data.store.favorites.bar[0].title, 'Copied-install pending edit');
  for (const call of server.calls.slice(calls).filter(call => call.method === 'PUT' && call.path.includes('/objects/writers/'))) assert.equal(call.path.split('/objects/writers/')[1].split('/')[0], current.computerId);
});

test('Quantum rate limiting preserves sealed retries and waits for Retry-After before publication', async t => {
  const server = await fakeQuantum(t), local = fixture(t), account = server.account(), a = seat(local, 'a', account); await a.engine.enrollQuantum(account); await a.engine.pulse();
  a.advance(); a.store(store => store.favorites.bar.push(favorite('Rate limited edit'))); server.refusals.push({ method: 'PUT', status: 429, code: 'rate_limited', headers: { 'Retry-After': '7' } });
  await assert.rejects(a.engine.pulse(), /SYNC_RATE_LIMITED/); const pending = structuredClone(a.engine.local.outbox), writes = server.calls.filter(call => call.method === 'PUT').length;
  await a.engine.pulse().catch(() => {}); assert.equal(server.calls.filter(call => call.method === 'PUT').length, writes); assert.deepEqual(a.engine.local.outbox, pending);
  a.advance(7001); await a.engine.pulse(); assert.equal(a.engine.local.outbox, null);
});

test('folder to Quantum and back preserves pending edits and capture blobs', async t => {
  const server = await fakeQuantum(t), local = fixture(t), account = server.account(), a = seat(local, 'a', account), folder = join(local.root, 'cloud'); mkdirSync(folder);
  const captureId = randomUUID(), image = Buffer.from('Transport switch capture'); a.data.desktop.addCapture(null, { id: captureId, folder: null, kind: 'area', title: 'Switch capture', text: '', note: '', source: { url: 'https://quantum-sync.example/switch', title: 'Source' }, image: null, createdAt: 100, updatedAt: 100 }, image, { width: 10, height: 10, cut: false });
  await a.engine.create(folder, true); await a.engine.pulse(); const datasetId = a.engine.local.dataset.datasetId, destination = await createDataset(account, datasetId);
  a.advance(); a.store(store => store.favorites.bar.push(favorite('Before Quantum switch'))); a.engine.options.afterSeal = () => { throw new Error('Synthetic interrupted folder upload'); }; await assert.rejects(a.engine.pulse()); delete a.engine.options.afterSeal;
  await a.engine.switchTransport({ kind: 'quantum', accountId: account.accountId, datasetId }); await a.engine.pulse(); assert.equal(a.engine.local.transport.kind, 'quantum'); assert.equal(a.engine.local.device, account.computerId);
  const b = seat(local, 'b', server.account()); await b.engine.enrollQuantum(b.engine.options.quantum(account.accountId)); await converge(a, b); assert.equal(b.data.store.favorites.bar.some(entry => entry.title === 'Before Quantum switch'), true); assert.deepEqual(b.data.desktop.image(null, captureId), image);
  a.advance(); a.store(store => store.favorites.bar.push(favorite('Before folder switch'))); await a.engine.switchTransport({ kind: 'folder', folder }); await a.engine.pulse(); assert.equal(a.engine.local.transport.kind, 'folder'); assert.equal(a.data.store.favorites.bar.length, 2); assert.deepEqual(a.data.desktop.image(null, captureId), image);
  const source = new FolderTransport(folder, SYNC_LIMITS.timeout, datasetId); assert.equal(JSON.parse((await source.readDescriptor()).toString()).keyType, 'random'); assert.equal(destination.check.keyType, 'account');
});

test('Quantum switching waits for a safe point and retains an edit made during a pending upload', async t => {
  const server = await fakeQuantum(t), local = fixture(t), account = server.account(), a = seat(local, 'a', account), folder = join(local.root, 'cloud'); mkdirSync(folder);
  await a.engine.create(folder, true); await a.engine.pulse(); const datasetId = a.engine.local.dataset.datasetId; await createDataset(account, datasetId);
  let entered, release; const blocked = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }), originalWrite = a.engine.active.writeObject.bind(a.engine.active);
  a.engine.active.writeObject = async (...args) => { entered(); await gate; return originalWrite(...args); };
  a.advance(); a.store(store => store.favorites.bar.push(favorite('In-flight edit'))); const pulse = a.engine.pulse(); await blocked;
  let switched = false; const switching = a.engine.switchTransport({ kind: 'quantum', accountId: account.accountId, datasetId }).then(() => { switched = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(switched, false);
  a.advance(); a.store(store => store.favorites.bar.push(favorite('Edit during switch'))); release(); await assert.rejects(pulse, /SYNC_CHANGED/); await switching; await a.engine.pulse();
  const accountB = server.account(), b = seat(local, 'b', accountB); await b.engine.enrollQuantum(accountB); await converge(a, b); assert.deepEqual(b.data.store.favorites.bar.map(entry => entry.title).sort(), ['Edit during switch', 'In-flight edit']);
});

test('Quantum commands validate exact fields and remain unavailable to private windows', () => {
  const profile = randomUUID(), enroll = { type: 'sync-quantum-enroll', profile }, quantum = { type: 'sync-switch', transport: { kind: 'quantum', accountId: 'account-a', datasetId: randomUUID() } }, folder = { type: 'sync-switch', transport: { kind: 'folder' } };
  for (const command of [enroll, quantum, folder]) { assert.deepEqual(validateCommand(command, new Set([profile])), command); assert.throws(() => assertPrivateCommand(command), /SYNC_PRIVATE/); }
  for (const command of [{ ...enroll, profile: 'invalid' }, { ...enroll, token: 'forged' }, { ...enroll, profile: randomUUID() }, { ...quantum, extra: true }, { ...quantum, transport: { ...quantum.transport, datasetId: 'invalid' } }, { ...quantum, transport: { ...quantum.transport, token: 'forged' } }, { ...folder, transport: { kind: 'folder', folder: 'C:\\forged' } }]) assert.throws(() => validateCommand(command, new Set([profile])));
});

test('Quantum switching retains disabled unassigned baselines without publishing them', async t => {
  const server = await fakeQuantum(t), local = fixture(t), account = server.account(), a = seat(local, 'a', account), folder = join(local.root, 'cloud'); mkdirSync(folder);
  const snapshot = a.read(), extra = structuredClone(snapshot.profiles[0]); extra.id = randomUUID(); extra.name = 'Unassigned profile'; extra.store.favorites.bar = [favorite('Unassigned retained favorite')];
  a.host.apply({ ...snapshot, profiles: [...snapshot.profiles, extra] }, new Map());
  await a.engine.create(folder, true); await a.engine.pulse(); await a.engine.setItem('favorites', false);
  const datasetId = a.engine.local.dataset.datasetId; await createDataset(account, datasetId);
  await a.engine.switchTransport({ kind: 'quantum', accountId: account.accountId, datasetId }); await a.engine.pulse();
  const published = [...server.dataset(account, datasetId).objects].filter(([name]) => name.includes('/checkpoints/'));
  const key = await account.deriveSyncKey(datasetId);
  for (const [name, bytes] of published) {
    const [, device, generation, , filename] = name.split('/'), [, sequence, id] = /^(\d+)-(.+)\.hzs$/.exec(filename);
    const payload = openSync(key, { dataset: datasetId, device, generation, sequence: Number(sequence), id, kind: 'checkpoint' }, bytes);
    assert.equal(JSON.stringify(payload).includes('Unassigned retained favorite'), false);
  }
  assert.ok(published.length > 0); assert.equal(a.read().profiles.find(profile => profile.id === extra.id).store.favorites.bar[0].title, 'Unassigned retained favorite');
});

test('Quantum return to the original folder preserves unassigned capture encryption', async t => {
  const server = await fakeQuantum(t), local = fixture(t), account = server.account(), a = seat(local, 'a', account), folder = join(local.root, 'cloud'); mkdirSync(folder);
  const snapshot = a.read(), extra = structuredClone(snapshot.profiles[0]); extra.id = randomUUID(); extra.name = 'Unassigned capture profile';
  a.host.apply({ ...snapshot, profiles: [...snapshot.profiles, extra] }, new Map());
  const captureId = randomUUID(), bytes = Buffer.from('Unassigned capture bytes'), desktop = a.profiles.get(extra.id).desktop;
  desktop.addCapture(null, { id: captureId, folder: null, kind: 'area', title: 'Unassigned capture', text: '', note: '', source: { url: 'https://quantum-sync.example/capture', title: 'Source' }, image: null, createdAt: 100, updatedAt: 100 }, bytes, { width: 10, height: 10, cut: false });
  await a.engine.create(folder, true); await a.engine.pulse(); const datasetId = a.engine.local.dataset.datasetId; await createDataset(account, datasetId);
  await a.engine.switchTransport({ kind: 'quantum', accountId: account.accountId, datasetId }); await a.engine.pulse();
  assert.equal([...server.dataset(account, datasetId).objects.keys()].some(name => name.includes('/blobs/')), false);
  await a.engine.switchTransport({ kind: 'folder', folder }); await a.engine.pulse();
  assert.deepEqual(desktop.image(null, captureId), bytes);
});

test('Quantum assignment removal between objects blocks the remaining sealed uploads', async t => {
  const server = await fakeQuantum(t), local = fixture(t), account = server.account(), a = seat(local, 'a', account);
  const snapshot = a.read(), extra = structuredClone(snapshot.profiles[0]); extra.id = randomUUID(); extra.name = 'Second assigned profile';
  a.host.apply({ ...snapshot, profiles: [...snapshot.profiles, extra] }, new Map()); account.profileIds = [a.profile.id, extra.id];
  await a.engine.enrollQuantum(account); await a.engine.pulse(); await a.engine.setItem('favorites', false); await a.engine.setItem('favorites', true);
  a.advance(); a.store(store => store.favorites.bar.push(favorite('Departing profile edit')));
  const original = account.request; let removed = false, laterUploads = 0;
  account.request = async (route, init = {}) => {
    if (init.method === 'PUT' && removed) laterUploads++;
    const response = await original(route, init);
    if (init.method === 'PUT' && !removed) { account.profileIds = [extra.id]; removed = true; }
    return response;
  };
  await assert.rejects(a.engine.pulse(), /SYNC_NOT_ALLOWED/);
  assert.equal(removed, true); assert.equal(laterUploads, 0); assert.ok(a.engine.local.outbox.files.length >= 2);
  assert.equal(a.data.store.favorites.bar[0].title, 'Departing profile edit');
  account.profileIds = [a.profile.id, extra.id]; account.request = original; await a.engine.pulse(); assert.equal(a.engine.local.outbox, null);
});

test('Quantum signed-out restart retains configuration and sealed retries for the original account', async t => {
  const server = await fakeQuantum(t), local = fixture(t), account = server.account(), a = seat(local, 'a', account);
  await a.engine.enrollQuantum(account); await a.engine.pulse(); a.advance(); a.store(store => store.favorites.bar.push(favorite('Restart pending edit')));
  a.engine.options.afterSeal = () => { throw new Error('Synthetic interruption'); }; await assert.rejects(a.engine.pulse()); a.engine.stop();
  const pending = structuredClone(a.engine.local.outbox), calls = server.calls.length; let current;
  const restored = new SyncEngine(a.directory, a.encryption, a.host, { quantum: id => current?.accountId === id ? current : undefined }); local.cleanup.push(() => restored.stop());
  assert.equal(restored.state().configured, true); assert.deepEqual(restored.local.outbox, pending);
  await assert.rejects(restored.pulse(), /SYNC_NOT_ALLOWED/); assert.equal(server.calls.length, calls);
  current = account; restored.accountChanged(); await restored.pulse(); assert.equal(restored.local.outbox, null); assert.equal(a.data.store.favorites.bar[0].title, 'Restart pending edit');
});
