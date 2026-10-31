const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCosmicKeyStore } = require('../dist/electron/cosmic-keys.js');

test('Linux Secret Service keeps account keys across restarts without key material in account.json', { skip: process.platform !== 'linux' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'horizon-linux-keys-')), accountId = `horizon-test-${randomUUID()}`, key = randomBytes(32);
  const options = { root, origin: 'https://quantum.txmska.com', platform: 'linux' }, store = createCosmicKeyStore(options);
  t.after(async () => { try { await store.clear(accountId); } finally { key.fill(0); rmSync(root, { recursive: true, force: true }); } });
  await store.set(accountId, key); assert.equal(store.kind, 'shared');
  const restarted = createCosmicKeyStore(options), opened = await restarted.get(accountId);
  assert.equal(restarted.kind, 'shared'); assert.ok(opened instanceof Uint8Array && Buffer.from(opened).equals(key));
  const path = join(root, 'shared', 'keys', 'account.json'), serialized = readFileSync(path, 'utf8'), saved = JSON.parse(serialized), entry = saved.accounts[accountId];
  assert.deepEqual(Object.keys(saved).sort(), ['accounts', 'version']); assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'origin', 'store', 'updatedAt', 'writer']);
  assert.equal(entry.store, 'libsecret'); assert.equal(entry.origin, options.origin); assert.equal(entry.writer, 'horizon');
  assert.equal(Number.isSafeInteger(entry.createdAt), true); assert.equal(entry.updatedAt, entry.createdAt);
  assert.equal(serialized.includes(key.toString('base64')), false); assert.equal(serialized.includes(key.toString('hex')), false); assert.equal(readFileSync(path).includes(key), false);
  await restarted.clear(accountId); assert.equal(await createCosmicKeyStore(options).get(accountId) === undefined, true);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')).accounts, accountId), false);
  const cleared = spawnSync('secret-tool', ['lookup', 'application', 'cosmic', 'kind', 'account-key', 'account', accountId], { shell: false, timeout: 15000, maxBuffer: 16384, windowsHide: true, encoding: 'utf8' });
  assert.equal(cleared.status, 1); assert.equal(cleared.stdout === '', true); assert.equal(cleared.stderr === '', true);
});

test('Linux without a session bus keeps account keys only in memory', { skip: process.platform !== 'linux' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'horizon-linux-no-bus-')), root = join(directory, 'cosmic'), previous = process.env.DBUS_SESSION_BUS_ADDRESS, key = randomBytes(32);
  t.after(() => { key.fill(0); rmSync(directory, { recursive: true, force: true }); });
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(directory, 'missing-session-bus')}`;
  try {
    const options = { root, origin: 'https://quantum.txmska.com', platform: 'linux' }, store = createCosmicKeyStore(options);
    assert.equal(await store.get('account-a') === undefined, true); assert.equal(store.kind, 'session');
    await store.set('account-a', key); const opened = await store.get('account-a');
    assert.ok(opened instanceof Uint8Array && Buffer.from(opened).equals(key));
    assert.equal(await createCosmicKeyStore(options).get('account-a') === undefined, true); assert.equal(existsSync(root), false);
    await store.clear('account-a'); assert.equal(await store.get('account-a') === undefined, true);
  } finally {
    if (previous === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = previous;
  }
});
