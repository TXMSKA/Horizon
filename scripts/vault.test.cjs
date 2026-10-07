const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync, mkdirSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { loginFields, inspectLogin, fillLogin } = require('../dist/electron/vault-page.js');
const { vaultTokenStore, readVaultFile, vaultClipboard } = require('../dist/electron/vault-storage.js');
const { createVault, loginMetadata } = require('../dist/electron/vault.js');
const { vaultLogFields } = require('../dist/electron/vault-log.js');
const { validateCommand } = require('../dist/electron/commands.js');
const { createSettings } = require('../dist/electron/settings.js');
const origin = 'https://synthetic.example';
const secret = 'Synthetic-value-for-tests-only';

function directory(t) {
  const root = resolve('.runtime'); mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, 'vault-test-')); t.after(() => rmSync(folder, { recursive: true, force: true })); return folder;
}
function cipher() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), seal = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, seal.update(value), seal.final(), seal.getAuthTag()]); },
    decryptString(bytes) { const open = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); open.setAuthTag(bytes.subarray(-16)); return Buffer.concat([open.update(bytes.subarray(12, -16)), open.final()]).toString('utf8'); },
  };
}
function snapshot(site = origin) {
  return { strings: [site, '#document', 'HTML', 'FORM', 'INPUT', 'type', 'email', 'password', 'autocomplete', 'username', 'current-password'], documents: [{
    documentURL: 0, nodes: { nodeName: [1, 2, 3, 4, 4], backendNodeId: [1, 2, 3, 101, 102], parentIndex: [-1, 0, 1, 2, 2], attributes: [[], [], [], [5, 6, 8, 9], [5, 7, 8, 10]] },
    layout: { nodeIndex: [3, 4], bounds: [[200, 100, 300, 40], [200, 200, 300, 40]] }, scrollOffsetX: 0, scrollOffsetY: 0,
  }] };
}
function page() {
  let attached = false, focused = 101, site = origin, data = snapshot();
  const mainFrame = { url: site, origin: site }, writes = [], commands = [];
  const contents = {
    mainFrame, focusedFrame: mainFrame, isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => site,
    focus() {}, async insertText(value) { writes.push([focused, value]); },
    debugger: { isAttached: () => attached, attach() { attached = true; }, detach() { attached = false; },
      async sendCommand(method, params) {
        commands.push(method);
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: focused };
        if (method === 'DOM.describeNode') return { node: { backendNodeId: params.nodeId } };
        if (method === 'DOMSnapshot.captureSnapshot') return data;
        if (method === 'DOM.focus') { focused = params.backendNodeId; return {}; }
        if (method === 'Input.dispatchKeyEvent') return {};
        throw new Error('Unexpected debugger method');
      },
    },
  };
  return { contents, writes, commands, snapshot: value => { data = value; }, navigate(value) { site = value; mainFrame.url = value; mainFrame.origin = value; }, focused(value) { focused = value; } };
}
function row(site = origin, id = 'synthetic-id') {
  return { version: 1, entry: { id, kind: 'login', title: 'Synthetic site', fields: [
    { id: 'website', value: site }, { id: 'username', value: 'synthetic-user' }, { id: 'password', value: secret },
  ], note: secret, totp: secret, recovery: [{ value: secret }], files: [] } };
}
function controller(t, privateWindow = false, policy = 'close') {
  const fixture = page(), events = [], reads = [], copy = { text: '', writeText(value) { this.text = value; }, readText() { return this.text; }, clear() { this.text = ''; } };
  let unlocked = false, connected = 0, generation = 1, closed = 0, hwnd;
  const service = {
    async status() { return { created: true, unlocked }; }, async unlock() { unlocked = true; }, async lock() { unlocked = false; }, async close() { closed++; },
    async logins(site) { reads.push(site); return [row(), row('https://synthetic.example.evil', 'evil-id')]; },
    hello: { async unlock(handle) { hwnd = handle; unlocked = true; } }, entries: { async save() {} },
  };
  const folder = directory(t), protection = cipher();
  const vault = createVault({ window: { webContents: { getZoomFactor: () => 1 }, getNativeWindowHandle: () => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(123n); return bytes; } }, directory: folder, privateWindow, cipher: protection, clipboard: copy,
    timeout: () => policy, saveTimeout(value) { policy = value; }, page: () => ({ contents: fixture.contents, generation, id: 'synthetic-tab', zoom: 1, bounds: { x: 0, y: 96, width: 900, height: 700 } }),
    covered: () => false, revealPage() {}, changed: () => events.push(vault.state()), connect: async () => { connected++; return service; },
  });
  t.after(() => vault.close());
  return { vault, fixture, events, reads, copy, service, folder, protection, hwnd: () => hwnd, connected: () => connected, closed: () => closed, navigate() { generation++; fixture.navigate('https://evil.example'); } };
}

test('Vault refuses private windows before connecting, inspecting or copying', async t => {
  const fixture = controller(t, true);
  for (const command of [{ type: 'vault-refresh' }, { type: 'vault-unlock', password: secret }, { type: 'vault-fill', id: 'synthetic-id', suggestion: 'x' }, { type: 'vault-copy', id: 'synthetic-id', origin }, { type: 'set-vault-timeout', value: '5' }]) await assert.rejects(fixture.vault.run(command));
  await fixture.vault.scan(); assert.equal(fixture.connected(), 0); assert.deepEqual(fixture.fixture.commands, []); assert.equal(fixture.copy.text, ''); assert.equal(fixture.vault.state().suggestion, null);
  await assert.rejects(inspectLogin(fixture.fixture.contents, origin, true));
  await assert.rejects(fillLogin(fixture.fixture.contents, loginFields(snapshot(), origin, 101), { username: 'synthetic-user', password: secret }, true, () => {}));
  assert.deepEqual(fixture.fixture.writes, []);
});

test('Vault finds a visible top-document login and excludes signup, ambiguous and framed fields', async () => {
  const fixture = page(), fields = await inspectLogin(fixture.contents, origin, false);
  assert.equal(fields.username, 101); assert.equal(fields.password, 102); assert.deepEqual([fields.x, fields.y], [200, 100]);
  assert.equal(loginFields(snapshot('https://synthetic.example.evil'), origin, 101), null);
  const signup = snapshot(); signup.strings[10] = 'new-password'; assert.equal(loginFields(signup, origin, 101), null);
  const framed = snapshot(); framed.documents.push(structuredClone(framed.documents[0])); framed.documents[0].nodes.backendNodeId = [1, 2, 3, 201, 202]; assert.equal(loginFields(framed, origin, 101), null);
  const ambiguous = snapshot(); ambiguous.documents[0].nodes.nodeName.push(4); ambiguous.documents[0].nodes.backendNodeId.push(103); ambiguous.documents[0].nodes.parentIndex.push(2); ambiguous.documents[0].nodes.attributes.push([5, 7]); ambiguous.documents[0].layout.nodeIndex.push(5); ambiguous.documents[0].layout.bounds.push([200, 260, 300, 40]); assert.equal(loginFields(ambiguous, origin, 101), null);
  fixture.contents.focusedFrame = { url: 'https://foreign.example', origin: 'https://foreign.example' }; await assert.rejects(inspectLogin(fixture.contents, origin, false));
  assert.equal(fixture.commands.some(method => /Runtime|evaluate|callFunction/.test(method)), false);
});

test('Vault rechecks exact origin, frame, field and navigation before every native insertion', async () => {
  const fields = loginFields(snapshot(), origin, 101), values = { username: 'synthetic-user', password: secret };
  const good = page(); await fillLogin(good.contents, fields, values, false, () => {}); assert.deepEqual(good.writes, [[101, values.username], [102, secret]]);
  const different = page(); different.navigate('https://synthetic.example.evil'); await assert.rejects(fillLogin(different.contents, fields, values, false, () => {})); assert.deepEqual(different.writes, []);
  const frame = page(); frame.contents.focusedFrame = { url: 'https://foreign.example', origin: 'https://foreign.example' }; await assert.rejects(fillLogin(frame.contents, fields, values, false, () => {})); assert.deepEqual(frame.writes, []);
  const redirected = page(); redirected.contents.insertText = async value => { redirected.writes.push([101, value]); redirected.navigate('https://foreign.example'); };
  await assert.rejects(fillLogin(redirected.contents, fields, values, false, () => {})); assert.equal(redirected.writes.length, 1); assert.equal(redirected.writes.some(([, value]) => value === secret), false);
  const replaced = page(); replaced.contents.insertText = async value => { replaced.writes.push([101, value]); const data = snapshot(); data.documents[0].nodes.backendNodeId[4] = 999; replaced.snapshot(data); };
  await assert.rejects(fillLogin(replaced.contents, fields, values, false, () => {})); assert.equal(replaced.writes.length, 1);
  const focusStolen = page(), send = focusStolen.contents.debugger.sendCommand;
  focusStolen.contents.debugger.sendCommand = async (method, params) => { const result = await send(method, params); if (method === 'Input.dispatchKeyEvent') focusStolen.focused(999); return result; };
  await assert.rejects(fillLogin(focusStolen.contents, fields, values, false, () => {})); assert.deepEqual(focusStolen.writes, []);
});

test('Vault sends display metadata only, rejects mismatched service rows and writes the clipboard in main', async t => {
  const fixture = controller(t);
  assert.deepEqual(loginMetadata([row(), row('http://synthetic.example'), row('https://synthetic.example:444')], origin).map(item => item.id), ['synthetic-id']);
  await fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' }); await fixture.vault.scan();
  assert.equal(fixture.events.some(state => JSON.stringify(state).includes(secret)), false);
  const suggestion = fixture.vault.state().suggestion;
  assert.ok(suggestion); assert.deepEqual(suggestion.logins.map(item => item.id), ['synthetic-id']);
  assert.equal(await fixture.vault.run({ type: 'vault-copy', id: 'synthetic-id', origin }), undefined); assert.equal(fixture.copy.text === secret, true);
  assert.equal(fixture.events.some(state => JSON.stringify(state).includes(secret)), false);
  await fixture.vault.run({ type: 'vault-fill', suggestion: suggestion.id, id: 'synthetic-id' }); assert.equal(fixture.fixture.writes.length, 2);
  assert.equal(fixture.events.some(state => JSON.stringify(state).includes(secret)), false);
  await fixture.vault.close(); assert.equal(fixture.copy.text, ''); assert.equal(fixture.closed(), 1);
});

test('Vault rejects a stale suggestion after navigation and an in-flight lock', async t => {
  const fixture = controller(t);
  await fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' }); await fixture.vault.scan();
  const suggestion = fixture.vault.state().suggestion; fixture.navigate();
  await assert.rejects(fixture.vault.run({ type: 'vault-fill', suggestion: suggestion.id, id: 'synthetic-id' })); assert.deepEqual(fixture.fixture.writes, []);
  fixture.fixture.navigate(origin); await fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' }); await fixture.vault.scan();
  const next = fixture.vault.state().suggestion;
  fixture.service.logins = async () => { fixture.vault.invalidate(); return [row()]; };
  await assert.rejects(fixture.vault.run({ type: 'vault-fill', suggestion: next.id, id: 'synthetic-id' })); assert.deepEqual(fixture.fixture.writes, []);
});

test('Vault tokens and metadata are sealed, and OS encryption fails closed', async t => {
  const folder = directory(t), path = join(folder, 'token.sealed'), protection = cipher(), token = randomBytes(32).toString('base64url');
  const store = vaultTokenStore(path, protection); assert.equal(await store.get(), undefined); await store.set(token); assert.equal(await store.get() === token, true); assert.equal(readFileSync(path).includes(Buffer.from(token)), false);
  const fixture = controller(t); await fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' });
  const indexPath = join(fixture.folder, 'vault-sites.sealed'), indexBytes = readFileSync(indexPath);
  assert.equal(indexBytes.includes(Buffer.from(secret)), false); assert.equal(indexBytes.includes(Buffer.from('synthetic-user')), false); assert.equal(indexBytes.includes(Buffer.from(origin)), false);
  assert.equal(JSON.stringify(readVaultFile(indexPath, fixture.protection)).includes(secret), false);
  for (const bad of [{ isEncryptionAvailable: () => false }, { ...protection, getSelectedStorageBackend: () => 'basic_text' }]) {
    const unavailable = vaultTokenStore(join(folder, 'unavailable'), bad); await assert.rejects(unavailable.set(token)); await assert.rejects(unavailable.get());
  }
  assert.throws(() => readVaultFile(path, cipher()));
});

test('Vault clipboard expires at 30 seconds and preserves subsequently copied content', async () => {
  let value = '', callback, delay;
  const clipboard = { async writeText(text) { value = text; }, async readText() { return value; }, async clear() { value = ''; } };
  const nativeSetTimeout = global.setTimeout;
  // Observe the production default duration without waiting 30 seconds in a unit test.
  global.setTimeout = (work, milliseconds) => { callback = work; delay = milliseconds; return { unref() {} }; };
  let policy;
  try { policy = vaultClipboard(clipboard); await policy.copy(secret); } finally { global.setTimeout = nativeSetTimeout; }
  assert.equal(delay, 30000); await callback(); await new Promise(done => setImmediate(done)); assert.equal(value, '');
  const replacement = vaultClipboard(clipboard, work => { callback = work; return { unref() {} }; }); await replacement.copy(secret); value = 'Other synthetic content'; await callback(); await new Promise(done => setImmediate(done)); assert.equal(value, 'Other synthetic content'); await replacement.clear();
});

test('Vault commands are bounded, settings persist, and audit fields redact secrets', t => {
  const path = join(directory(t), 'settings.json'), settings = createSettings(path, () => {});
  assert.equal(settings.vaultTimeout, 'close');
  for (const value of ['close', '5', '15', '60']) { settings.setVaultTimeout(value); assert.equal(createSettings(path, () => {}).vaultTimeout, value); assert.deepEqual(validateCommand({ type: 'set-vault-timeout', value }), { type: 'set-vault-timeout', value }); }
  for (const command of [{ type: 'vault-unlock', password: 'x', extra: secret }, { type: 'vault-copy', id: 'x', origin: origin + '/login' }, { type: 'set-vault-timeout', value: 'forever' }, { type: 'vault-add', title: 'x', website: 'https://user:password@synthetic.example', username: 'u', password: 'p' }]) assert.throws(() => validateCommand(command));
  const fields = vaultLogFields({ password: secret, username: 'synthetic-user', token: randomBytes(32).toString('base64url'), code: randomBytes(32).toString('base64url'), actor: 'horizon', outcome: 'denied' });
  assert.deepEqual(fields, { password: '[redacted]', username: '[redacted]', token: '[redacted]', code: '[redacted]', actor: 'horizon', outcome: 'denied' });
  for (const file of ['src/Vault.tsx', 'electron/preload.ts']) assert.equal(readFileSync(resolve(file), 'utf8').includes('vault-client'), false);
});

test('Vault learns locked suggestions without retaining values and asks Hello with this window handle', async t => {
  const fixture = controller(t);
  if (process.platform === 'win32') { await fixture.vault.run({ type: 'vault-hello' }); assert.equal(fixture.hwnd(), '123'); assert.equal(fixture.vault.state().unlockMethod, 'hello'); }
  else await fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' });
  await fixture.vault.run({ type: 'vault-lock' }); const reads = fixture.reads.length;
  await fixture.vault.scan(); assert.ok(fixture.vault.state().suggestion); assert.equal(fixture.reads.length, reads); assert.deepEqual(fixture.vault.state().logins, []);
  const selected = fixture.vault.state().suggestion;
  await assert.rejects(fixture.vault.run({ type: 'vault-fill', suggestion: selected.id, id: 'synthetic-id' })); assert.deepEqual(fixture.fixture.writes, []);
});

test('Vault time limits lock before values are fetched and the close policy adds no timer lock', async t => {
  const fixture = controller(t, false, '5');
  await fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' });
  const actualNow = Date.now, later = actualNow() + 6 * 60000, reads = fixture.reads.length;
  Date.now = () => later;
  try { await assert.rejects(fixture.vault.run({ type: 'vault-copy', id: 'synthetic-id', origin })); } finally { Date.now = actualNow; }
  assert.equal(fixture.vault.state().unlocked, false); assert.equal(fixture.reads.length, reads); assert.equal(fixture.copy.text, '');
  await fixture.vault.run({ type: 'set-vault-timeout', value: 'close' }); await fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' });
  Date.now = () => later;
  try { await fixture.vault.run({ type: 'vault-copy', id: 'synthetic-id', origin }); } finally { Date.now = actualNow; }
  assert.equal(fixture.copy.text === secret, true);
});

test('Vault lock interrupts a pending fill and clipboard disposal awaits an OS write', async t => {
  const fixture = controller(t);
  await fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' }); await fixture.vault.scan();
  const suggestion = fixture.vault.state().suggestion;
  let complete, entered;
  const requested = new Promise(done => { entered = done; });
  fixture.service.logins = () => { entered(); return new Promise(done => { complete = done; }); };
  const pending = fixture.vault.run({ type: 'vault-fill', suggestion: suggestion.id, id: 'synthetic-id' });
  const refusal = assert.rejects(pending); await requested;
  await fixture.vault.run({ type: 'vault-lock' }); complete([row()]); await refusal; assert.deepEqual(fixture.fixture.writes, []);
  let finishWrite, value = '', started;
  const writing = new Promise(done => { started = done; });
  const clipboard = vaultClipboard({ async writeText(text) { started(); await new Promise(done => { finishWrite = done; }); value = text; }, async readText() { return value; }, async clear() { value = ''; } });
  const copy = clipboard.copy(secret); await writing; const disposed = clipboard.clear(); finishWrite(); await copy; await disposed; assert.equal(value, '');
});
