const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } = require('node:crypto');
const { createSpaceSharing } = require('../dist/electron/space-sharing.js');
const { createSharedProjects } = require('../dist/electron/space-reader.js');
const { readSpaceDatasets } = require('../dist/electron/spaces.js');

function fixture(t) {
  const temporary = join(__dirname, '..', '.runtime', '046-test-tmp'); mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'horizon-sharing-review-')), secret = randomBytes(32), spaceKey = randomBytes(32);
  const cipher = { isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = randomBytes(12), box = createCipheriv('aes-256-gcm', secret, nonce); return Buffer.concat([nonce, box.update(value, 'utf8'), box.final(), box.getAuthTag()]); },
    decryptString(value) { const box = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); box.setAuthTag(value.subarray(-16)); return Buffer.concat([box.update(value.subarray(12, -16)), box.final()]).toString('utf8'); },
  };
  const owner = randomUUID(), viewer = randomUUID(), space = { id: 'space-review', name: 'Review', pending: false, currentGeneration: 1, rotationRequired: false, members: [{ accountId: viewer }] };
  const context = { accountId: owner, computerId: randomUUID(), session: 1, capabilityRevision: '1:accepted', accessRevision: 1, accessRevisions: { [space.id]: 1 }, spaces: [space] };
  const project = { id: randomUUID(), name: 'Original project', createdAt: 1, updatedAt: 2, usedAt: 2, folders: [], items: [
    { id: randomUUID(), kind: 'note', title: 'Shared note', text: 'Snapshot content', note: '', source: null, image: null, folder: null, createdAt: 1, updatedAt: 2 },
  ] };
  const objects = new Map(), writers = new Set(), requests = [];
  let datasetId, notifications = 0, writeGate, writeFailure, keyReads = 0;
  const request = async (route, method = 'GET', body) => {
    requests.push({ route, method });
    if (method === 'PUT' && writeFailure) {
      if (writeFailure instanceof Error) throw writeFailure;
      return writeFailure;
    }
    const url = new URL(route, 'https://quantum.invalid'), base = `/v1/spaces/${space.id}/datasets`, prefix = `${base}/${datasetId}/objects`;
    if (method === 'PUT' && !route.includes('/objects/')) {
      datasetId = route.split('/').at(-1);
      return { status: 201, ok: true, value: { id: datasetId, appId: 'horizon', createdAt: 1 } };
    }
    if (method === 'PUT') {
      if (writeGate) { const gate = writeGate; writeGate = undefined; gate.enter(); await gate.wait; }
      const path = url.pathname.split('/objects/')[1], parts = path.split('/'), writer = `${parts[2]}/${parts[3]}`;
      assert.equal(Number(parts[0].slice(2)), space.currentGeneration, 'Space writes require the current key generation');
      assert.ok(writers.has(writer) || writers.size < 64, 'Quantum permits at most 64 writer generations per dataset');
      writers.add(writer);
      const previous = objects.get(path);
      assert.ok(!previous || previous.bytes.equals(body), 'Quantum objects are create-only');
      if (!previous) objects.set(path, { bytes: body, createdAt: Date.now() });
      return { status: 201, ok: true, value: { success: true } };
    }
    if (url.pathname === base) return { status: 200, ok: true, value: { datasets: [{ id: datasetId, appId: 'horizon', createdAt: 1, updatedAt: Date.now(), size: 1, sharedBy: { accountId: owner, displayName: 'Owner' } }], after: null } };
    if (url.pathname === prefix) return { status: 200, ok: true, value: { objects: [...objects].sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => ({ path, size: value.bytes.length, sha256: createHash('sha256').update(value.bytes).digest('hex'), createdAt: value.createdAt })), after: null } };
    const value = objects.get(url.pathname.slice(`${prefix}/`.length));
    return { status: value ? 200 : 404, ok: !!value, value: value?.bytes };
  };
  const manager = createSpaceSharing({ directory, cipher, context: () => structuredClone(context), changed() { notifications++; }, project: () => project, image: () => null,
    key: async () => { keyReads++; return { generation: space.currentGeneration, key: spaceKey.slice() }; }, request });
  t.after(async () => { await manager.close(); rmSync(directory, { recursive: true, force: true }); });
  return { manager, project, space, context, objects, writers, requests, request, viewer, spaceKey,
    dataset: () => datasetId,
    keyReads: () => keyReads,
    failWrites(value) { writeFailure = value; },
    async tick(milliseconds) { t.mock.timers.tick(milliseconds); for (let count = 0; count < 100; count++) await new Promise(setImmediate); },
    pauseWrite() { let enter, release; const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; }); writeGate = { enter, wait }; return { entered, release }; },
    async publishChange(edit) {
      const before = notifications; edit(); manager.changed(); t.mock.timers.tick(30000);
      for (let count = 0; notifications === before && count < 10000; count++) await new Promise(setImmediate);
      assert.ok(notifications > before, 'the scheduled publication must complete');
      assert.equal(manager.projectState(project.id).shareError, null);
    },
    async read() {
      const shared = await readSpaceDatasets({ get: request, account: viewer, check() {}, key: async () => ({ key: spaceKey.slice() }), titleCache: new Map() }, space.id);
      assert.equal(shared[0].title, project.name, 'dataset listings must show the latest checkpoint title');
      const reader = createSharedProjects({ context: () => ({ accountId: viewer, session: 1, spaces: [space], shared }), request, key: async () => ({ key: spaceKey.slice() }) });
      const content = await reader.openSharedProject(space.id, datasetId);
      assert.equal(content.title, project.name); assert.equal(content.items[0].text, project.items[0].text);
    },
  };
}

test('Space project renames reuse the writer generation and readers resolve the latest checkpoint title', async t => {
  const f = fixture(t); await f.manager.shareProject(f.project.id, f.space.id);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  for (let index = 1; index <= 65; index++) {
    await f.publishChange(() => { f.project.name = `Project rename ${index}`; f.project.updatedAt++; });
    assert.equal(f.writers.size, 1, 'a project rename must keep its existing writer generation');
  }
  assert.equal(f.writers.size, 1); assert.equal([...f.objects.keys()].filter(path => path.endsWith('/dataset.hzs')).length, 1);
  await f.read();
});

test('Space project key rotation reuses a writer at the contract cap and remains readable after 64 rotations', async t => {
  const f = fixture(t); await f.manager.shareProject(f.project.id, f.space.id);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  for (let index = 2; index <= 66; index++) await f.publishChange(() => { f.space.currentGeneration = index; });
  assert.equal(f.writers.size, 64);
  assert.equal([...f.objects.keys()].filter(path => path.endsWith('/dataset.hzs')).length, 66);
  assert.equal(f.requests.filter(value => value.method === 'PUT' && !value.route.includes('/objects/')).length, 1);
  await f.read();
});


test('Space publication survives an access change in another Space', async t => {
  const f = fixture(t), gate = f.pauseWrite(); t.after(gate.release);
  const publish = f.manager.shareProject(f.project.id, f.space.id); await gate.entered;
  f.context.accessRevision++; f.context.accessRevisions['other-space'] = 1;
  gate.release(); await assert.doesNotReject(publish);
  assert.equal(f.manager.projectState(f.project.id).shareError, null);
});

test('Space title reads cache the title-bearing object hash across unrelated updates', async t => {
  const f = fixture(t); await f.manager.shareProject(f.project.id, f.space.id);
  const titleCache = new Map(), options = { get: f.request, account: f.viewer, check() {}, key: async () => ({ key: f.spaceKey.slice() }), titleCache };
  const first = await readSpaceDatasets(options, f.space.id); assert.equal(first[0].title, f.project.name);
  const before = f.requests.length;
  titleCache.get(f.space.id + ':' + f.dataset()).updatedAt = new Date(0).toISOString();
  const second = await readSpaceDatasets(options, f.space.id); assert.equal(second[0].title, f.project.name);
  assert.equal(f.requests.slice(before).some(call => /\/objects\/.+\.hzs$/.test(call.route)), false, 'unchanged manifest/checkpoint hashes require no object downloads');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  await f.publishChange(() => { f.project.name = 'New cached title'; f.project.updatedAt++; });
  const renamed = await readSpaceDatasets(options, f.space.id); assert.equal(renamed[0].title, 'New cached title');
});


test('Space content revisions detect changed checkpoints with identical dataset time and size', async t => {
  const f = fixture(t); await f.manager.shareProject(f.project.id, f.space.id);
  const titleCache = new Map(), fixedTime = Date.now(), options = { account: f.viewer, check() {}, key: async () => ({ key: f.spaceKey.slice() }), titleCache,
    async get(route) { const response = await f.request(route); if (response.value?.datasets) response.value.datasets.forEach(dataset => { dataset.updatedAt = fixedTime; dataset.size = 100; }); return response; },
  };
  const first = (await readSpaceDatasets(options, f.space.id))[0]; assert.match(first.contentRevision, /^[a-f0-9]{64}$/);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: fixedTime });
  await f.publishChange(() => { f.project.items[0].text = 'Changed text with stable listing metadata'; f.project.updatedAt++; });
  const second = (await readSpaceDatasets(options, f.space.id, new Set([f.dataset()])))[0];
  assert.equal(second.updatedAt, first.updatedAt); assert.equal(second.size, first.size); assert.equal(second.title, first.title);
  assert.notEqual(second.contentRevision, first.contentRevision);
});

for (const failure of ['sync_plan_required', 'acceptance_required', 'ACCOUNT_CONSENT']) test(`Space publishing holds ${failure} until capabilities change`, async t => {
  const f = fixture(t); await f.manager.shareProject(f.project.id, f.space.id);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  f.failWrites(failure === 'ACCOUNT_CONSENT' ? new Error(failure) : { status: 403, ok: false, value: { error: { code: failure } } });
  f.project.name = 'Pending change'; f.manager.changed(); await f.tick(30000);
  assert.equal(f.manager.projectState(f.project.id).shareError, 'SPACE_SHARE_FAILED');
  const requests = f.requests.length, keys = f.keyReads();
  for (let minute = 0; minute < 12; minute++) {
    f.project.updatedAt++; f.context.accessRevisions[f.space.id]++; f.manager.changed(); await f.tick(60000);
  }
  assert.equal(f.requests.length, requests, 'refused publication must send no idle writes');
  assert.equal(f.keyReads(), keys, 'refused publication must send no idle key reads');
  f.failWrites(undefined); f.context.capabilityRevision = '2:accepted'; f.manager.changed(); await f.tick(30000);
  assert.equal(f.manager.projectState(f.project.id).shareError, null);
  assert.ok(f.requests.length > requests, 'changed capabilities resume the pending publication');
  await f.read();
});

test('Space transient publications back off from five seconds to one minute and reset after success', async t => {
  const f = fixture(t); await f.manager.shareProject(f.project.id, f.space.id);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  f.failWrites({ status: 503, ok: false, value: { error: { code: 'busy' } } });
  f.project.updatedAt++; f.manager.changed(); await f.tick(30000);
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    const requests = f.requests.length;
    await f.tick(delay - 1); assert.equal(f.requests.length, requests, `retry must wait ${delay} ms`);
    await f.tick(1); assert.equal(f.requests.length, requests + 1, `retry must run at ${delay} ms`);
  }
  f.failWrites(undefined); await f.tick(60000); assert.equal(f.manager.projectState(f.project.id).shareError, null);
  f.failWrites(new Error('ACCOUNT_NETWORK')); f.project.updatedAt++; f.manager.changed(); await f.tick(30000);
  const requests = f.requests.length; await f.tick(4999); assert.equal(f.requests.length, requests);
  await f.tick(1); assert.equal(f.requests.length, requests + 1, 'success resets the next transient retry to five seconds');
});
