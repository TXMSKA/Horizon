const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname, resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { createServices, readRelease, readChecksum, downloadInstaller, runInstaller, downloadUrl, releaseUrl, RELEASE_HOSTS, DOWNLOAD_CAP } = require('../dist/electron/services-install.js');
const { validateCommand } = require('../dist/electron/commands.js');
const { assertPrivateCommand } = require('../dist/electron/private-commands.js');
const { createVault } = require('../dist/electron/vault.js');
const { createLyra } = require('../dist/electron/lyra.js');
const { copy, text } = require('../dist/src/copy.js');
const { SERVICE_IDS, SERVICE_INFO, serviceReason, validateServicesCommand } = require('../dist/src/shared/services.js');

const until = async (check, label) => {
  for (let attempt = 0; attempt < 600; attempt++) { const value = check(); if (value) return value; await new Promise(done => setTimeout(done, 5)); }
  assert.fail(`Timed out waiting for ${label}`);
};
const folder = t => { const path = mkdtempSync(join(tmpdir(), 'horizon-services-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const vaultPath = '/github.com/TXMSKA/Vault/releases/latest/download/';

// A local server stands in for GitHub: the address a request names (its host included) is the first segment of the local path, so
// the code under test sees GitHub's real addresses and redirects while nothing leaves this computer.
async function github(t, routes) {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    const route = routes[request.url];
    if (!route) { response.writeHead(404).end(); return; }
    route(request, response);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const port = server.address().port;
  const fetch = (url, init) => { const address = new URL(url); return globalThis.fetch(`http://127.0.0.1:${port}/${address.hostname}${address.pathname}${address.search}`, init); };
  return { fetch, hits };
}
const serve = (body, headers = {}) => (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/octet-stream', ...headers }); response.end(body); };
const redirect = location => (_request, response) => { response.writeHead(302, { Location: location }); response.end(); };
const installerRoutes = (bytes, extra = {}) => ({
  [`${vaultPath}Vault-Setup-x64.exe`]: serve(bytes),
  [`${vaultPath}SHA256SUMS.txt`]: serve(`${sha(bytes)}  Vault-Setup-x64.exe\n`),
  ...extra,
});
// The installer and its folder are real files; the fake process only reports how it was started.
function fakeSpawn(options = {}) {
  const started = [];
  const spawn = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    started.push({ command, args, options: spawnOptions, existed: existsSync(command), content: existsSync(command) ? readFileSync(command) : null, child });
    if (!options.hang) setImmediate(() => child.emit('exit', options.code ?? 0));
    return child;
  };
  return { spawn, started };
}
function fakeHost(options = {}) {
  const answers = [...(options.answers ?? ['ready'])], reaches = [], opened = [];
  let changes = 0;
  const host = {
    privateWindow: options.privateWindow ?? false, alive: () => true, changed: () => { changes++; },
    async reach(service) { reaches.push(service); return answers.length > 1 ? answers.shift() : answers[0]; },
    async open(url) { opened.push(url); },
  };
  return { host, reaches, opened, changes: () => changes };
}
const options = (extra = {}) => ({ platform: 'win32', declined: new Set(), lock: { held: false }, pollMs: 5, pollLimitMs: 400, ...extra });

test('service commands are exact, refused in private windows and never carry an address', () => {
  for (const command of [{ type: 'service-check' }, { type: 'service-retry' }, { type: 'service-reinstall' }, { type: 'service-not-now' }, { type: 'service-cancel' }, { type: 'service-close' },
    { type: 'service-offer', service: 'vault' }, { type: 'service-install', service: 'lyra' }, { type: 'service-page', service: 'lyra', page: 'about' }, { type: 'service-page', service: 'vault', page: 'download' }]) {
    assert.deepEqual(validateCommand(command), command); assert.deepEqual(validateServicesCommand(command), command);
    assert.throws(() => assertPrivateCommand(command), /SERVICES_PRIVATE/);
  }
  for (const bad of [null, [], {}, { type: 'service-install' }, { type: 'service-install', service: 'other' }, { type: 'service-install', service: 'vault', url: 'https://example.com/x.exe' },
    { type: 'service-install', service: 'vault', path: 'C:\\x.exe' }, { type: 'service-page', service: 'vault', page: 'https://example.com' }, { type: 'service-page', service: 'vault' },
    { type: 'service-retry', service: 'vault' }, { type: 'service-unknown' }, { type: 'service-offer', service: '__proto__' }]) assert.throws(() => validateCommand(bad));
});

test('a client answer becomes a reason only for a missing or not started service', () => {
  assert.equal(serviceReason({ code: 'not_installed' }), 'not_installed');
  for (const code of ['invalid_install', 'unavailable']) assert.equal(serviceReason({ code }), 'did_not_start');
  for (const bad of [{ code: 'locked' }, { code: 'forbidden' }, new Error('not_installed'), null, undefined, 'not_installed']) assert.equal(serviceReason(bad), null);
});

// Vault: the client's answer is the only detection, and the offer is tied to the features the person reached.
function vaultDouble(t, extra = {}) {
  const asked = [], states = [];
  let failure = { code: 'not_installed' };
  const vault = createVault({
    window: { webContents: { getZoomFactor: () => 1 } }, directory: folder(t), privateWindow: extra.privateWindow ?? false,
    cipher: { isEncryptionAvailable: () => false }, clipboard: { writeText() {}, readText: () => '', clear() {} },
    timeout: () => 'close', saveTimeout() {}, page: () => extra.page?.() ?? null, covered: () => false, revealPage() {}, changed: () => states.push(1),
    connect: async () => { if (failure) throw failure; return { status: async () => ({ created: true, unlocked: false }), close: async () => {}, apps: { self: async () => ({ permissions: ['import'] }) }, logins: async () => [] }; },
    unavailable: reason => asked.push(reason),
  });
  t.after(() => vault.close());
  return { vault, asked, fail(value) { failure = value; } };
}
test('Vault tells the host that it is missing only for the features the person reached', async t => {
  const fixture = vaultDouble(t);
  // Creating Vault, which is what a first launch does, asks nothing.
  assert.deepEqual(fixture.asked, []); assert.equal(fixture.vault.state().reason, null);
  await assert.rejects(fixture.vault.run({ type: 'vault-refresh' }), /VAULT_UNAVAILABLE/);
  assert.deepEqual(fixture.asked, ['not_installed']); assert.equal(fixture.vault.state().reason, 'not_installed'); assert.equal(fixture.vault.state().error, 'VAULT_UNAVAILABLE');
  await assert.rejects(fixture.vault.run({ type: 'vault-add', title: 'Synthetic', website: 'https://synthetic.example', username: 'u', password: 'p' }), /VAULT_UNAVAILABLE/);
  await assert.rejects(fixture.vault.run({ type: 'vault-unlock', password: 'Synthetic master password' }), /VAULT_UNAVAILABLE/);
  await assert.rejects(fixture.vault.importPasswords('chrome', () => 'synthetic'), /VAULT_UNAVAILABLE/);
  assert.deepEqual(fixture.asked, ['not_installed', 'not_installed', 'not_installed', 'not_installed']);
  // Commands that never belong to a feature entry do not ask: lock, copy, fill, a timeout choice.
  const before = fixture.asked.length;
  await assert.rejects(fixture.vault.run({ type: 'vault-copy', id: 'x', origin: 'https://synthetic.example' }));
  await assert.rejects(fixture.vault.run({ type: 'vault-lock' }));
  await fixture.vault.run({ type: 'set-vault-timeout', value: '5' });
  assert.equal(fixture.asked.length, before);
});
test('Vault carries the reason: invalid install and a start timeout mean it did not start, anything else says nothing', async t => {
  for (const [failure, reason, asks] of [[{ code: 'invalid_install' }, 'did_not_start', 1], [{ code: 'unavailable' }, 'did_not_start', 1], [{ code: 'not_installed' }, 'not_installed', 1], [new Error('Synthetic storage failure'), null, 0]]) {
    const fixture = vaultDouble(t); fixture.fail(failure);
    await assert.rejects(fixture.vault.run({ type: 'vault-refresh' }), /VAULT_UNAVAILABLE/);
    assert.equal(fixture.vault.state().reason, reason); assert.equal(fixture.vault.state().error, 'VAULT_UNAVAILABLE'); assert.equal(fixture.asked.length, asks);
  }
  const fixture = vaultDouble(t);
  assert.equal(await fixture.vault.reach(), 'not_installed');
  fixture.fail(null); assert.equal(await fixture.vault.reach(), 'ready'); assert.equal(fixture.vault.state().reason, null); assert.equal(fixture.vault.state().available, true);
});

const origin = 'https://synthetic.example';
function snapshot() {
  return { strings: [origin, '#document', 'HTML', 'FORM', 'INPUT', 'type', 'email', 'password', 'autocomplete', 'username', 'current-password'], documents: [{
    documentURL: 0, nodes: { nodeName: [1, 2, 3, 4, 4], backendNodeId: [1, 2, 3, 101, 102], parentIndex: [-1, 0, 1, 2, 2], attributes: [[], [], [], [5, 6, 8, 9], [5, 7, 8, 10]] },
    layout: { nodeIndex: [3, 4], bounds: [[200, 100, 300, 40], [200, 200, 300, 40]] }, scrollOffsetX: 0, scrollOffsetY: 0,
  }] };
}
function loginPage() {
  let attached = false;
  const mainFrame = { url: origin, origin };
  return { mainFrame, focusedFrame: mainFrame, isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => origin, focus() {}, async insertText() {},
    debugger: { isAttached: () => attached, attach() { attached = true; }, detach() { attached = false; }, async sendCommand(method, params) {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 101 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: params.nodeId } };
      if (method === 'DOMSnapshot.captureSnapshot') return snapshot();
      return {};
    } } };
}
test('a sign-in field never offers Vault: its one background connect is silent', async t => {
  let connects = 0;
  const asked = [], contents = loginPage();
  const vault = createVault({
    window: { webContents: { getZoomFactor: () => 1 } }, directory: folder(t), privateWindow: false, cipher: { isEncryptionAvailable: () => false }, clipboard: { writeText() {}, readText: () => '', clear() {} },
    timeout: () => 'close', saveTimeout() {}, page: () => ({ contents, generation: 1, id: 'tab', zoom: 1, bounds: { x: 0, y: 96, width: 900, height: 700 } }), covered: () => false, revealPage() {}, changed() {},
    connect: async () => { connects++; throw { code: 'not_installed' }; }, unavailable: reason => asked.push(reason),
  });
  t.after(() => vault.close());
  await vault.scan(); await vault.scan(); await new Promise(done => setImmediate(done));
  assert.equal(connects, 1); assert.deepEqual(asked, []); assert.equal(vault.state().suggestion, null);
});
test('Vault in a private window neither connects nor asks', async t => {
  const fixture = vaultDouble(t, { privateWindow: true });
  await assert.rejects(fixture.vault.run({ type: 'vault-refresh' })); await assert.rejects(fixture.vault.importPasswords('chrome', () => 'synthetic'));
  assert.equal(await fixture.vault.reach(), 'did_not_start'); assert.deepEqual(fixture.asked, []);
});

// Lyra: the panel and a question the person asked reach the offer; a translation offered automatically stays silent.
function lyraDouble(failure = { code: 'not_installed' }, privateWindow = false) {
  const asked = [];
  const host = { privateWindow, alive: () => true, language: () => 'en', changed() {}, page() { throw new Error('LYRA_PAGE_UNAVAILABLE'); }, decision: () => 'ask', allow() {}, project() { throw new Error('PROJECT_NOT_FOUND'); },
    item() { throw new Error('DESKTOP_ITEM_NOT_FOUND'); }, save() {}, connect: async () => { throw failure; }, unreachable: reason => asked.push(reason) };
  return { lyra: createLyra(host), asked };
}
const phase = async (lyra, wanted) => until(() => lyra.state().phase === wanted && lyra.state(), `Lyra phase ${wanted}`);
test('Lyra offers its install when the panel opens or the person asks, and only for a missing or not started service', async () => {
  const opened = lyraDouble();
  await opened.lyra.run({ type: 'lyra-open' }); await phase(opened.lyra, 'failed');
  assert.deepEqual(opened.asked, ['not_installed']); assert.equal(opened.lyra.state().error, 'not_installed');
  await opened.lyra.run({ type: 'lyra-ask', task: 'question', question: 'Synthetic question', tabs: [], project: null, item: null }); await until(() => opened.asked.length === 2, 'the question to ask');
  const stopped = lyraDouble({ code: 'invalid_install' });
  await stopped.lyra.run({ type: 'lyra-open' }); await phase(stopped.lyra, 'failed'); assert.deepEqual(stopped.asked, ['did_not_start']);
  for (const failure of [{ code: 'model_missing' }, { code: 'forbidden' }, new Error('Synthetic failure')]) {
    const other = lyraDouble(failure); await other.lyra.run({ type: 'lyra-open' }); await phase(other.lyra, 'failed'); assert.deepEqual(other.asked, []);
  }
  const fresh = lyraDouble(); assert.deepEqual(fresh.asked, []); assert.equal(fresh.lyra.state().open, false);
});
test('Lyra in a private window never connects or offers', async () => {
  const fixture = lyraDouble({ code: 'not_installed' }, true);
  await assert.rejects(fixture.lyra.run({ type: 'lyra-open' }), /LYRA_PRIVATE/); assert.deepEqual(fixture.asked, []);
});

test('the offer waits for the release, shows the rounded size and tells a missing or unreadable release apart', async t => {
  const api = path => `/api.github.com/repos/${path}/releases/latest`;
  const release = (name, size) => serve(JSON.stringify({ tag_name: 'v0.1.0', assets: [{ name: 'other.txt', size: 5 }, { name, size }] }), { 'Content-Type': 'application/json' });
  const env = await github(t, {
    [api('TXMSKA/Vault')]: release('Vault-Setup-x64.exe', 44040192 + 200000), [api('TXMSKA/lyra-releases')]: (_request, response) => { response.writeHead(404).end('{}'); },
  });
  assert.deepEqual(await readRelease(env.fetch, 'vault'), { release: 'available', sizeMb: 42 });
  assert.deepEqual(await readRelease(env.fetch, 'lyra'), { release: 'missing', sizeMb: null });
  assert.equal(releaseUrl('vault'), 'https://api.github.com/repos/TXMSKA/Vault/releases/latest');
  const other = await github(t, { [api('TXMSKA/Vault')]: release('Lyra-Setup-x64.exe', 100), [api('TXMSKA/lyra-releases')]: (_request, response) => { response.writeHead(500).end(); } });
  assert.deepEqual(await readRelease(other.fetch, 'vault'), { release: 'missing', sizeMb: null });
  assert.deepEqual(await readRelease(other.fetch, 'lyra'), { release: 'unknown', sizeMb: null });
  assert.deepEqual(await readRelease(async () => { throw new Error('offline'); }, 'vault'), { release: 'unknown', sizeMb: null });

  const asked = fakeHost(), services = createServices(asked.host, options({ fetch: env.fetch }));
  services.unavailable('vault', 'not_installed');
  assert.equal(services.state().dialog, null);
  const dialog = await until(() => services.state().dialog, 'the offer');
  assert.deepEqual({ phase: dialog.phase, service: dialog.service, release: dialog.release, sizeMb: dialog.sizeMb, manual: dialog.manual }, { phase: 'offer', service: 'vault', release: 'available', sizeMb: 42, manual: false });
  assert.equal(env.hits.filter(hit => hit.includes('/download/')).length, 0);
  assert.equal(services.state().entries.vault, 'not_installed');
});

test('a release that cannot be read keeps Install and a missing release offers only the download page', async t => {
  const { serviceDialogText } = dialogModule();
  // A server that fails is not a missing release: the size is unknown, Install stays and the download starts after the OK.
  const failing = await github(t, { '/api.github.com/repos/TXMSKA/lyra-releases/releases/latest': (_request, response) => { response.writeHead(503).end(); } });
  const unreadable = fakeHost(), temporary = folder(t), spawned = fakeSpawn();
  const second = createServices(unreadable.host, options({ fetch: failing.fetch, spawn: spawned.spawn, temporary }));
  second.unavailable('lyra', 'not_installed');
  const unknown = await until(() => second.state().dialog, 'the unknown offer');
  assert.equal(unknown.release, 'unknown'); assert.equal(unknown.sizeMb, null);
  for (const language of ['en', 'es']) {
    const body = serviceDialogText(unknown, language).body;
    assert.equal(body, `${text('serviceLyraIntro', language)} ${text('serviceDownloadNoSize', language).replace('{repo}', 'TXMSKA/lyra-releases')}`); assert.doesNotMatch(body, /\{|undefined|NaN/);
  }
  await second.run({ type: 'service-install', service: 'lyra' });
  await until(() => failing.hits.some(hit => hit.startsWith('/github.com/TXMSKA/lyra-releases/releases/latest/download/')), 'the download to be attempted');
  await until(() => second.state().dialog?.phase === 'failed', 'the failed screen'); assert.equal(spawned.started.length, 0);

  // A 404 release says the download is not available and Install refuses to start.
  const missing = await github(t, { '/api.github.com/repos/TXMSKA/Vault/releases/latest': (_request, response) => { response.writeHead(404).end('{"message":"Not Found"}'); } });
  const environment = fakeHost(), absent = createServices(environment.host, options({ fetch: missing.fetch, spawn: spawned.spawn }));
  absent.unavailable('vault', 'not_installed');
  const dialog = await until(() => absent.state().dialog, 'the missing offer');
  assert.equal(dialog.release, 'missing');
  for (const language of ['en', 'es']) {
    const body = serviceDialogText(dialog, language).body;
    assert.equal(body, `${text('serviceVaultIntro', language)} ${text('serviceDownloadMissing', language)}`); assert.doesNotMatch(body, /\{size\}|MB/);
  }
  await assert.rejects(absent.run({ type: 'service-install', service: 'vault' }), /SERVICES_STALE/);
  await absent.run({ type: 'service-page', service: 'vault', page: 'download' });
  assert.deepEqual(environment.opened, ['https://txmska.com/projects/vault/']); assert.equal(spawned.started.length, 0);
  assert.equal(missing.hits.some(hit => hit.includes('/download/')), false);
});

test('Not now holds until Horizon restarts, and Settings offers the service again', async t => {
  const env = await github(t, { '/api.github.com/repos/TXMSKA/Vault/releases/latest': serve(JSON.stringify({ assets: [{ name: 'Vault-Setup-x64.exe', size: 5 * 1048576 }] })) });
  const declined = new Set(), host = fakeHost();
  const services = createServices(host.host, options({ fetch: env.fetch, declined }));
  services.unavailable('vault', 'not_installed');
  await until(() => services.state().dialog?.phase === 'offer', 'the offer');
  await services.run({ type: 'service-not-now' });
  assert.equal(services.state().dialog, null); assert.deepEqual([...declined], ['vault']);
  // The same feature asks again and again, and nothing shows.
  for (let attempt = 0; attempt < 3; attempt++) { services.unavailable('vault', 'not_installed'); await new Promise(done => setTimeout(done, 20)); assert.equal(services.state().dialog, null); }
  // Another service is a different feature.
  services.unavailable('lyra', 'not_installed', undefined);
  await until(() => services.state().dialog?.service === 'lyra', 'the Lyra offer'); await services.run({ type: 'service-not-now' });
  // A new window of the same run shares the choice; a restart (a new set) forgets it.
  const sibling = createServices(fakeHost().host, options({ fetch: env.fetch, declined }));
  sibling.unavailable('vault', 'not_installed'); await new Promise(done => setTimeout(done, 20)); assert.equal(sibling.state().dialog, null);
  const restarted = createServices(fakeHost().host, options({ fetch: env.fetch, declined: new Set() }));
  restarted.unavailable('vault', 'not_installed'); await until(() => restarted.state().dialog?.phase === 'offer', 'the offer after a restart');
  // Settings offers it again whatever was said before.
  await services.run({ type: 'service-offer', service: 'vault' });
  const again = services.state().dialog; assert.equal(again.phase, 'offer'); assert.equal(again.service, 'vault'); assert.equal(declined.has('vault'), false);
  await assert.rejects(services.run({ type: 'service-offer', service: 'lyra' }), /SERVICES_STALE/);
});

test('private windows never offer, check or install anything', async t => {
  const env = await github(t, {}), host = fakeHost({ privateWindow: true }), spawned = fakeSpawn();
  const services = createServices(host.host, options({ fetch: env.fetch, spawn: spawned.spawn }));
  services.unavailable('vault', 'not_installed'); services.unavailable('lyra', 'did_not_start');
  await new Promise(done => setTimeout(done, 30));
  assert.equal(services.state().dialog, null); assert.deepEqual(env.hits, []); assert.deepEqual(host.reaches, []);
  for (const command of [{ type: 'service-offer', service: 'vault' }, { type: 'service-install', service: 'vault' }, { type: 'service-check' }, { type: 'service-retry' }]) await assert.rejects(services.run(command), /SERVICES_PRIVATE/);
  assert.equal(spawned.started.length, 0);
});

test('a service that did not start shows Retry and Reinstall, and Reinstall shows the size before downloading', async t => {
  const env = await github(t, { '/api.github.com/repos/TXMSKA/lyra-releases/releases/latest': serve(JSON.stringify({ assets: [{ name: 'Lyra-Setup-x64.exe', size: 85 * 1048576 }] })) });
  const host = fakeHost({ answers: ['did_not_start', 'ready'] }), spawned = fakeSpawn();
  let resumed = 0;
  const services = createServices(host.host, options({ fetch: env.fetch, spawn: spawned.spawn }));
  services.unavailable('lyra', 'did_not_start', () => resumed++);
  assert.equal(services.state().dialog.phase, 'not-started'); assert.equal(services.state().entries.lyra, 'did_not_start');
  await services.run({ type: 'service-retry' });
  assert.equal(services.state().dialog.phase, 'not-started'); assert.equal(services.state().dialog.busy, false); assert.equal(resumed, 0);
  await services.run({ type: 'service-reinstall' });
  const offer = services.state().dialog; assert.equal(offer.phase, 'offer'); assert.equal(offer.sizeMb, 85);
  assert.equal(env.hits.filter(hit => hit.includes('/download/')).length, 0); assert.equal(spawned.started.length, 0);
  await services.run({ type: 'service-not-now' });
  // Retry that works closes the dialog and continues the feature.
  const again = createServices(fakeHost({ answers: ['did_not_start', 'ready'] }).host, options({ fetch: env.fetch }));
  again.unavailable('vault', 'did_not_start', () => resumed++);
  await again.run({ type: 'service-retry' }); assert.equal(again.state().dialog.phase, 'not-started');
  await again.run({ type: 'service-retry' }); assert.equal(again.state().dialog, null); assert.equal(resumed, 1); assert.equal(again.state().entries.vault, 'installed');
});

const installer = randomBytes(4096);
async function installAfterOk(t, extra = {}, hostOptions = {}) {
  const routes = installerRoutes(installer, extra.routes), env = await github(t, { '/api.github.com/repos/TXMSKA/Vault/releases/latest': serve(JSON.stringify({ assets: [{ name: 'Vault-Setup-x64.exe', size: 4096 }] })), ...routes });
  const temporary = folder(t), host = fakeHost(hostOptions), spawned = fakeSpawn(extra.spawn);
  let resumed = 0;
  const services = createServices(host.host, options({ fetch: env.fetch, spawn: spawned.spawn, temporary, ...extra.options }));
  services.unavailable('vault', 'not_installed', () => resumed++);
  await until(() => services.state().dialog?.phase === 'offer', 'the offer');
  return { services, host, spawned, env, temporary, resumed: () => resumed };
}
test('the download starts only after Install and the installer runs with /S, without a shell or elevation', async t => {
  const fixture = await installAfterOk(t);
  assert.equal(fixture.env.hits.some(hit => hit.includes('/download/')), false); assert.equal(fixture.spawned.started.length, 0);
  await fixture.services.run({ type: 'service-install', service: 'vault' });
  await until(() => fixture.resumed() === 1, 'the install to finish');
  assert.equal(fixture.spawned.started.length, 1);
  const [started] = fixture.spawned.started;
  assert.deepEqual(started.args, ['/S']); assert.equal(started.options.shell, false); assert.equal(started.options.windowsHide, true);
  assert.equal(Object.hasOwn(started.options, 'verb'), false); assert.equal(started.options.detached, undefined);
  assert.equal(started.existed, true); assert.deepEqual(started.content, installer); assert.equal(dirname(dirname(started.command)), resolve(fixture.temporary)); assert.match(started.command, /Vault-Setup-x64\.exe$/);
  // The download is gone, the client was asked again and the feature went on.
  assert.deepEqual(readdirSync(fixture.temporary), []); assert.deepEqual(fixture.host.reaches, ['vault']);
  assert.equal(fixture.services.state().dialog, null); assert.equal(fixture.services.state().entries.vault, 'installed');
  assert.equal(fixture.env.hits.indexOf(`${vaultPath}SHA256SUMS.txt`) < fixture.env.hits.indexOf(`${vaultPath}Vault-Setup-x64.exe`), true);
});
test('the client is asked again after the install: a first run waits for the status, a silent service fails, a slow one stops', async t => {
  const states = [];
  const setup = await installAfterOk(t, {}, { answers: ['setup', 'setup', 'ready'] });
  setup.services.run({ type: 'service-install', service: 'vault' });
  await until(() => setup.services.state().dialog?.phase === 'finish', 'the finish screen');
  assert.equal(setup.resumed(), 0); assert.deepEqual(readdirSync(setup.temporary), []);
  await until(() => setup.resumed() === 1, 'the status to change'); assert.equal(setup.services.state().dialog, null); assert.equal(setup.host.reaches.length, 3); states.push(setup.services.state().entries.vault);

  const closing = await installAfterOk(t, {}, { answers: ['setup'] });
  closing.services.run({ type: 'service-install', service: 'vault' });
  await until(() => closing.services.state().dialog?.phase === 'finish', 'the finish screen');
  await closing.services.run({ type: 'service-close' }); const reached = closing.host.reaches.length;
  await new Promise(done => setTimeout(done, 40)); assert.equal(closing.host.reaches.length, reached); assert.equal(closing.resumed(), 0);

  const limited = await installAfterOk(t, { options: { pollMs: 5, pollLimitMs: 40 } }, { answers: ['setup'] });
  limited.services.run({ type: 'service-install', service: 'vault' });
  await until(() => limited.services.state().dialog?.phase === 'finish', 'the finish screen');
  await until(() => limited.services.state().dialog === null, 'the wait to end'); assert.equal(limited.resumed(), 0);

  const silent = await installAfterOk(t, {}, { answers: ['did_not_start'] });
  silent.services.run({ type: 'service-install', service: 'vault' });
  await until(() => silent.services.state().dialog?.phase === 'not-started', 'the not started screen'); assert.equal(silent.services.state().entries.vault, 'did_not_start');

  const absent = await installAfterOk(t, {}, { answers: ['not_installed'] });
  absent.services.run({ type: 'service-install', service: 'vault' });
  await until(() => absent.services.state().dialog?.phase === 'failed', 'the failed screen'); assert.equal(absent.services.state().dialog.failure, 'install'); assert.deepEqual(readdirSync(absent.temporary), []);
  assert.deepEqual(states, ['installed']);
});

test('the download refuses a checksum mismatch and deletes the file without running it', async t => {
  const fixture = await installAfterOk(t, { routes: { [`${vaultPath}SHA256SUMS.txt`]: serve(`${'0'.repeat(64)}  Vault-Setup-x64.exe\n`) } });
  await fixture.services.run({ type: 'service-install', service: 'vault' });
  await until(() => fixture.services.state().dialog?.phase === 'failed', 'the failed screen');
  assert.equal(fixture.services.state().dialog.failure, 'checksum'); assert.equal(fixture.spawned.started.length, 0); assert.deepEqual(readdirSync(fixture.temporary), []); assert.deepEqual(fixture.host.reaches, []);
  for (const sums of ['', `${sha(installer)}  Other-Setup.exe\n`, `${sha(installer).slice(0, 60)}  Vault-Setup-x64.exe\n`]) {
    const bad = await installAfterOk(t, { routes: { [`${vaultPath}SHA256SUMS.txt`]: serve(sums) } });
    await bad.services.run({ type: 'service-install', service: 'vault' });
    await until(() => bad.services.state().dialog?.phase === 'failed', 'the failed screen'); assert.equal(bad.spawned.started.length, 0); assert.deepEqual(readdirSync(bad.temporary), []);
  }
  // Retry runs the whole download again.
  const retry = await installAfterOk(t, { routes: { [`${vaultPath}SHA256SUMS.txt`]: serve(`${'1'.repeat(64)}  Vault-Setup-x64.exe\n`) } });
  await retry.services.run({ type: 'service-install', service: 'vault' });
  await until(() => retry.services.state().dialog?.phase === 'failed', 'the failed screen');
  const downloads = retry.env.hits.filter(hit => hit.endsWith('.exe')).length;
  await retry.services.run({ type: 'service-retry' }); await until(() => retry.env.hits.filter(hit => hit.endsWith('.exe')).length === downloads + 1, 'the second download');
  await until(() => retry.services.state().dialog?.phase === 'failed', 'the failed screen again'); assert.equal(retry.spawned.started.length, 0);
});

test('redirects leave GitHub only toward its release hosts, over HTTPS, and nothing else is fetched', async t => {
  const asset = `${vaultPath}Vault-Setup-x64.exe`;
  assert.deepEqual([...RELEASE_HOSTS], ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  for (const host of RELEASE_HOSTS.slice(1)) {
    const env = await github(t, installerRoutes(installer, { [asset]: redirect(`https://${host}/release/abc`), [`/${host}/release/abc`]: serve(installer) }));
    const directory = folder(t), signal = new AbortController().signal;
    assert.equal(await downloadInstaller(env.fetch, 'vault', join(directory, 'file.exe'), { signal }), sha(installer));
    assert.deepEqual(readFileSync(join(directory, 'file.exe')), installer);
  }
  const bad = ['https://evil.example/Vault-Setup-x64.exe', 'http://objects.githubusercontent.com/release/abc', 'https://github.com.evil.example/x', 'https://objects.githubusercontent.com.evil.example/x',
    'https://user:pass@objects.githubusercontent.com/x', 'https://objects.githubusercontent.com:8443/x', 'https://raw.githubusercontent.com/x', 'https://api.github.com/x', 'ftp://github.com/x', 'file:///C:/x.exe'];
  for (const target of bad) {
    const env = await github(t, installerRoutes(installer, { [asset]: redirect(target), '/evil.example/Vault-Setup-x64.exe': serve(installer) }));
    const directory = folder(t);
    await assert.rejects(downloadInstaller(env.fetch, 'vault', join(directory, 'file.exe'), { signal: new AbortController().signal }), error => error.code === 'redirect', target);
    assert.deepEqual(readdirSync(directory), []);
    assert.equal(env.hits.filter(hit => !hit.startsWith('/github.com/')).length, 0, target);
  }
  // A redirect chain that never ends is cut off.
  const loop = await github(t, { [asset]: redirect('https://github.com/TXMSKA/Vault/releases/latest/download/Vault-Setup-x64.exe') });
  await assert.rejects(downloadInstaller(loop.fetch, 'vault', join(folder(t), 'file.exe'), { signal: new AbortController().signal }), error => error.code === 'redirect');
  assert.equal(loop.hits.length <= 7, true);
  // The release's checksums follow the same rule.
  const sums = await github(t, { [`${vaultPath}SHA256SUMS.txt`]: redirect('https://evil.example/SHA256SUMS.txt') });
  await assert.rejects(readChecksum(sums.fetch, 'vault', new AbortController().signal), error => error.code === 'redirect');
  assert.equal(downloadUrl('lyra'), 'https://github.com/TXMSKA/lyra-releases/releases/latest/download/Lyra-Setup-x64.exe');
  assert.equal(downloadUrl('vault'), 'https://github.com/TXMSKA/Vault/releases/latest/download/Vault-Setup-x64.exe');
});

test('the download stops at the size cap, announced or streamed, and leaves nothing behind', async t => {
  assert.equal(DOWNLOAD_CAP, 500 * 1024 * 1024);
  const asset = `${vaultPath}Vault-Setup-x64.exe`, big = Buffer.alloc(8192, 7);
  const announced = await github(t, installerRoutes(installer, { [asset]: serve(big) }));
  const directory = folder(t);
  await assert.rejects(downloadInstaller(announced.fetch, 'vault', join(directory, 'file.exe'), { signal: new AbortController().signal, cap: 4096 }), error => error.code === 'too_large');
  assert.deepEqual(readdirSync(directory), []);
  const streamed = await github(t, installerRoutes(installer, { [asset]: (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.write(big.subarray(0, 3000)); setTimeout(() => response.end(big.subarray(3000)), 10); } }));
  const second = folder(t), seen = [];
  await assert.rejects(downloadInstaller(streamed.fetch, 'vault', join(second, 'file.exe'), { signal: new AbortController().signal, cap: 4096, progress: received => seen.push(received) }), error => error.code === 'too_large');
  assert.equal(Math.max(...seen) <= 8192, true);
  // The same bodies through the install flow end on the failed screen with the folder removed.
  const streamRoute = (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.write(big.subarray(0, 3000)); setTimeout(() => response.end(big.subarray(3000)), 10); };
  for (const route of [serve(big), streamRoute]) {
    const fixture = await installAfterOk(t, { routes: { [asset]: route }, options: { cap: 4096 } });
    await fixture.services.run({ type: 'service-install', service: 'vault' });
    await until(() => fixture.services.state().dialog?.phase === 'failed', 'the failed screen'); assert.equal(fixture.services.state().dialog.failure, 'download'); assert.deepEqual(readdirSync(fixture.temporary), []); assert.equal(fixture.spawned.started.length, 0);
  }
});

test('a release that is not there fails the install cleanly, with the download page as the manual path', async t => {
  const fixture = await installAfterOk(t, { routes: { [`${vaultPath}Vault-Setup-x64.exe`]: (_request, response) => { response.writeHead(404).end(); }, [`${vaultPath}SHA256SUMS.txt`]: (_request, response) => { response.writeHead(404).end(); } } });
  await fixture.services.run({ type: 'service-install', service: 'vault' });
  await until(() => fixture.services.state().dialog?.phase === 'failed', 'the failed screen');
  assert.equal(fixture.services.state().dialog.failure, 'download'); assert.deepEqual(readdirSync(fixture.temporary), []); assert.equal(fixture.spawned.started.length, 0);
  await fixture.services.run({ type: 'service-page', service: 'vault', page: 'download' }); assert.deepEqual(fixture.host.opened, ['https://txmska.com/projects/vault/']);
  await fixture.services.run({ type: 'service-close' }); assert.equal(fixture.services.state().dialog, null);
});

test('Cancel stops a download and deletes it, while an installer that is running cannot be cancelled', async t => {
  const asset = `${vaultPath}Vault-Setup-x64.exe`;
  let release;
  const slow = await installAfterOk(t, { routes: { [asset]: (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.write(Buffer.alloc(1024)); release = () => response.end(); } } });
  await slow.services.run({ type: 'service-install', service: 'vault' });
  await until(() => slow.services.state().dialog?.phase === 'downloading' && slow.services.state().dialog.received >= 1024, 'the download to start');
  await slow.services.run({ type: 'service-cancel' });
  await until(() => slow.services.state().dialog === null && readdirSync(slow.temporary).length === 0, 'the download to be deleted');
  assert.equal(slow.spawned.started.length, 0); assert.equal(slow.resumed(), 0); release?.();

  const running = await installAfterOk(t, { spawn: { hang: true } });
  await running.services.run({ type: 'service-install', service: 'vault' });
  await until(() => running.services.state().dialog?.phase === 'installing', 'the installer to run');
  await assert.rejects(running.services.run({ type: 'service-cancel' }), /SERVICES_STALE/); await assert.rejects(running.services.run({ type: 'service-close' }), /SERVICES_STALE/);
  assert.equal(running.services.state().dialog.phase, 'installing'); assert.equal(running.spawned.started[0].child.killed, undefined);
  running.spawned.started[0].child.emit('exit', 0);
  await until(() => running.resumed() === 1, 'the install to finish'); assert.deepEqual(readdirSync(running.temporary), []);
});

test('an installer that fails or hangs fails the install and the download is deleted', async t => {
  const failing = await installAfterOk(t, { spawn: { code: 1 } });
  await failing.services.run({ type: 'service-install', service: 'vault' });
  await until(() => failing.services.state().dialog?.phase === 'failed', 'the failed screen'); assert.equal(failing.services.state().dialog.failure, 'install'); assert.deepEqual(readdirSync(failing.temporary), []); assert.deepEqual(failing.host.reaches, []);
  const hanging = await installAfterOk(t, { spawn: { hang: true }, options: { installTimeoutMs: 30 } });
  await hanging.services.run({ type: 'service-install', service: 'vault' });
  await until(() => hanging.services.state().dialog?.phase === 'failed', 'the failed screen'); assert.equal(hanging.services.state().dialog.failure, 'install');
  assert.equal(hanging.spawned.started[0].child.killed, true); assert.deepEqual(readdirSync(hanging.temporary), []);
  await assert.rejects(runInstaller(() => { throw new Error('spawn failed'); }, 'C:\\x.exe', 100), error => error.code === 'installer');
  await assert.rejects(runInstaller(() => { const child = new EventEmitter(); child.kill = () => {}; setImmediate(() => child.emit('error', new Error('EACCES'))); return child; }, 'C:\\x.exe', 100), error => error.code === 'installer');
});

test('only one install runs at a time across windows', async t => {
  const lock = { held: false }, slowRoutes = { [`${vaultPath}Vault-Setup-x64.exe`]: (_request, response) => { response.writeHead(200); response.write(Buffer.alloc(100)); setTimeout(() => response.end(), 500); } };
  const first = await installAfterOk(t, { routes: slowRoutes, options: { lock } });
  const second = await installAfterOk(t, { options: { lock } });
  await first.services.run({ type: 'service-install', service: 'vault' });
  await until(() => lock.held, 'the first install to hold the lock');
  await second.services.run({ type: 'service-install', service: 'vault' });
  await until(() => second.services.state().dialog?.phase === 'failed', 'the busy screen'); assert.equal(second.services.state().dialog.failure, 'busy'); assert.equal(second.spawned.started.length, 0);
  await first.services.run({ type: 'service-cancel' }); await until(() => !lock.held, 'the lock to be released');
});

test('off Windows nothing is downloaded: Install opens the service page in the browser', async t => {
  const env = await github(t, {}), host = fakeHost(), spawned = fakeSpawn();
  const services = createServices(host.host, options({ platform: 'linux', fetch: env.fetch, spawn: spawned.spawn }));
  services.unavailable('lyra', 'not_installed');
  const offer = await until(() => services.state().dialog, 'the offer');
  assert.equal(offer.manual, true); assert.equal(offer.sizeMb, null); assert.deepEqual(env.hits, []);
  const body = dialogModule().serviceDialogText(offer, 'en').body; assert.equal(body, `${text('serviceLyraIntro', 'en')} ${text('serviceDownloadManual', 'en')}`);
  await services.run({ type: 'service-install', service: 'lyra' });
  assert.deepEqual(host.opened, ['https://txmska.com/projects/lyra/']); assert.equal(services.state().dialog, null); assert.deepEqual(env.hits, []); assert.equal(spawned.started.length, 0);
});

test('Settings checks both services and reads each client answer into a status', async () => {
  const host = fakeHost({ answers: ['not_installed'] }), services = createServices(host.host, options());
  await services.run({ type: 'service-check' });
  assert.deepEqual(host.reaches, ['vault', 'lyra']); assert.deepEqual(services.state().entries, { vault: 'not_installed', lyra: 'not_installed' });
  for (const [answer, status] of [['ready', 'installed'], ['setup', 'installed'], ['did_not_start', 'did_not_start']]) {
    const next = createServices(fakeHost({ answers: [answer] }).host, options());
    await next.run({ type: 'service-check' }); assert.deepEqual(next.state().entries, { vault: status, lyra: status });
  }
  assert.deepEqual(SERVICE_IDS, ['vault', 'lyra']); assert.equal(SERVICE_INFO.vault.asset, 'Vault-Setup-x64.exe'); assert.equal(SERVICE_INFO.lyra.repo, 'TXMSKA/lyra-releases');
});

// The renderer, run against the real source with a minimal React.
function load(file, dependencies, globals = {}, extra = '') {
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported = {}, jsx = (type, props) => ({ type, props });
  runInNewContext(source + extra, { exports: exported, Error, ...globals, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    return new Proxy({}, { get: (_target, key) => String(key) });
  } });
  return exported;
}
// Objects made inside the interface's own context have another prototype; plain copies compare by value.
const plain = value => JSON.parse(JSON.stringify(value));
const flat = value => [value].flat(Infinity).filter(item => item !== null && item !== undefined && typeof item !== 'boolean');
const find = (tree, predicate) => flat(tree).flatMap(node => typeof node === 'object' ? [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)] : []);
const label = node => flat(node.props.children).filter(child => typeof child === 'string').join('');
const commands = [];
const hooks = () => { const refs = []; return { refs, react: { useId: () => 'service-id', useRef: current => { const ref = { current }; refs.push(ref); return ref; }, useEffect() {} } }; };
function dialogModule(extra = {}) {
  const { react, refs } = hooks();
  const exported = load('src/Services.tsx', { react, './copy': require('../dist/src/copy.js'), './shared/services': require('../dist/src/shared/services.js') }, { window: { horizon: { command: async command => { commands.push(command); }, ...extra } } });
  return { ...exported, refs };
}
const dialogOf = (phase, extra = {}) => ({ service: 'vault', phase, release: 'available', sizeMb: 42, manual: false, received: 0, total: null, failure: null, busy: false, ...extra });

test('each screen of the board has its text and the safe action focused, in both languages', () => {
  const english = {
    offer: ['Install Vault to keep passwords', 'Vault stores passwords and keys on this computer, encrypted, and shares them with Horizon, Nova and Nebula. It is free and open source. Installing it downloads about 42 MB from GitHub (TXMSKA/Vault).'],
    downloading: ['Installing Vault', 'Downloading 18 of 42 MB from GitHub (TXMSKA/Vault).'],
    installing: ['Installing Vault', 'The download matches its published checksum. Vault is being installed for this Windows account.'],
    finish: ['Finish setting up Vault in its window', 'Vault opened its own window to create the vault and its recovery kit. Horizon continues on its own once Vault is ready.'],
    failed: ['Vault could not be installed', 'The download did not match its published checksum, so it was deleted and nothing was installed. Vault can also be installed from its download page.'],
    'not-started': ['Vault did not start', 'Vault is installed on this computer but did not answer. Retry, or reinstall it from its latest release.'],
  };
  const spanish = {
    offer: ['Instalar Vault para guardar contraseñas', 'Vault guarda las contraseñas y las claves en esta computadora, cifradas, y las comparte con Horizon, Nova y Nebula. Es gratuito y de código abierto. La instalación descarga unos 42 MB desde GitHub (TXMSKA/Vault).'],
  };
  const { serviceDialogText } = dialogModule();
  const shown = { offer: dialogOf('offer'), downloading: dialogOf('downloading', { received: 18.4 * 1048576, total: 42 * 1048576 }), installing: dialogOf('installing'), finish: dialogOf('finish'), failed: dialogOf('failed', { failure: 'checksum' }), 'not-started': dialogOf('not-started') };
  for (const [name, [title, body]] of Object.entries(english)) assert.deepEqual(plain(serviceDialogText(shown[name], 'en')), { title, body }, name);
  assert.deepEqual(plain(serviceDialogText(shown.offer, 'es')), { title: spanish.offer[0], body: spanish.offer[1] });
  assert.deepEqual(plain(serviceDialogText(dialogOf('offer', { service: 'lyra', sizeMb: 85 }), 'en')), { title: 'Install Lyra to use the assistant', body: 'Lyra runs the assistant on this computer, at no cost. Its setup shows the models it needs and their size before downloading them. Installing it downloads about 85 MB from GitHub (TXMSKA/lyra-releases).' });
  assert.deepEqual(plain(serviceDialogText(dialogOf('offer', { service: 'lyra', sizeMb: 85 }), 'es')), { title: 'Instalar Lyra para usar el asistente', body: 'Lyra ejecuta el asistente en esta computadora, sin costo. Su configuración muestra los modelos que necesita y su tamaño antes de descargarlos. La instalación descarga unos 85 MB desde GitHub (TXMSKA/lyra-releases).' });
  for (const [language, buttons] of [['en', { offer: ['Not now', 'Install'], downloading: ['Cancel'], installing: ['Cancel'], finish: ['Close'], failed: ['Open download page', 'Retry'], 'not-started': ['Reinstall', 'Retry'] }],
    ['es', { offer: ['Ahora no', 'Instalar'], downloading: ['Cancelar'], installing: ['Cancelar'], finish: ['Cerrar'], failed: ['Abrir la página de descarga', 'Reintentar'], 'not-started': ['Reinstalar', 'Reintentar'] }]]) {
    const safe = { offer: 0, downloading: 0, installing: null, finish: 0, failed: 1, 'not-started': 1 };
    for (const [name, expected] of Object.entries(buttons)) {
      const module = dialogModule(), tree = module.ServiceDialog({ dialog: shown[name], language });
      const actions = find(tree, node => node.props?.className === 'settings-dialog-actions')[0], pressed = find(actions, node => node.type === 'button');
      assert.deepEqual(pressed.map(label), expected, `${language} ${name}`);
      const focused = pressed.filter(node => node.props.ref === module.refs[1]);
      if (safe[name] === null) { assert.equal(focused.length, 0); assert.equal(pressed[0].props.disabled, true); assert.ok(pressed[0].props['aria-describedby']); }
      else { assert.equal(focused.length, 1); assert.equal(label(focused[0]), expected[safe[name]]); }
      assert.equal(tree.type, 'dialog'); assert.ok(tree.props['aria-labelledby'] && tree.props['aria-describedby']);
    }
  }
});

test('every dialog button sends the command of its own screen', async () => {
  commands.length = 0;
  const press = async (dialog, name) => { const tree = dialogModule().ServiceDialog({ dialog, language: 'en' }); find(tree, node => node.type === 'button' && label(node) === name)[0].props.onClick(); await Promise.resolve(); };
  await press(dialogOf('offer'), 'Not now'); await press(dialogOf('offer'), 'Install'); await press(dialogOf('offer', { service: 'lyra' }), 'What is Lyra?'); await press(dialogOf('offer', { release: 'missing' }), 'Open download page');
  await press(dialogOf('downloading'), 'Cancel'); await press(dialogOf('finish'), 'Close'); await press(dialogOf('failed'), 'Retry'); await press(dialogOf('failed'), 'Open download page');
  await press(dialogOf('not-started'), 'Reinstall'); await press(dialogOf('not-started'), 'Retry');
  assert.deepEqual(plain(commands), [{ type: 'service-not-now' }, { type: 'service-install', service: 'vault' }, { type: 'service-page', service: 'lyra', page: 'about' }, { type: 'service-page', service: 'vault', page: 'download' },
    { type: 'service-cancel' }, { type: 'service-close' }, { type: 'service-retry' }, { type: 'service-page', service: 'vault', page: 'download' }, { type: 'service-reinstall' }, { type: 'service-retry' }]);
  for (const command of plain(commands)) assert.deepEqual(validateCommand(command), command);
  // A missing release has no Install button at all.
  const missing = find(dialogModule().ServiceDialog({ dialog: dialogOf('offer', { release: 'missing' }), language: 'en' }), node => node.type === 'button').map(label);
  assert.equal(missing.includes('Install'), false);
  // Escape does what the safe action does.
  const escapes = [];
  for (const [phase, expected] of [['offer', 'service-not-now'], ['not-started', 'service-not-now'], ['downloading', 'service-cancel'], ['finish', 'service-close'], ['failed', 'service-close']]) {
    commands.length = 0; dialogModule().ServiceDialog({ dialog: dialogOf(phase), language: 'en' }).props.onCancel({ preventDefault() { escapes.push(phase); } }); await Promise.resolve();
    assert.deepEqual(plain(commands).map(command => command.type), [expected], phase);
  }
  commands.length = 0; dialogModule().ServiceDialog({ dialog: dialogOf('installing'), language: 'en' }).props.onCancel({ preventDefault() {} }); await Promise.resolve(); assert.deepEqual(commands, []);
  assert.equal(escapes.length, 5);
});

// Settings, General: the Shared services group.
function sharedServices(entries, dialog = null, language = 'en') {
  const { react } = hooks();
  const services = load('src/Services.tsx', { react, './copy': require('../dist/src/copy.js'), './shared/services': require('../dist/src/shared/services.js') }, { window: { horizon: { command: async () => {} } } });
  const sent = [];
  const settings = load('src/Settings.tsx', { react, './copy': require('../dist/src/copy.js'), './shared/api': require('../dist/src/shared/api.js'), './shared/services': require('../dist/src/shared/services.js'), './shared/sync-display': require('../dist/src/shared/sync-display.js'), './Services': services },
    { document: { activeElement: null, body: {} }, HTMLElement: class {}, window: { horizon: { command: async command => { sent.push(command); } } }, navigator: { language: 'en' } }, '\nexports.SharedServices = SharedServices;');
  const tree = settings.SharedServices({ state: { services: { dialog, entries } }, language });
  const rows = find(tree, node => typeof node.props?.children === 'function');
  const applied = [];
  return { sent, applied, tree, group: tree, rows: rows.map(row => ({ title: row.props.title, hint: row.props.hint, controls: find(row.props.children('row-id', async (command, message) => { applied.push([command, message]); return true; }, false), node => node.type === 'button') })) };
}
test('Settings lists both services and offers the right action for what each client said', () => {
  const buttons = row => row.controls.map(label);
  const missing = sharedServices({ vault: 'not_installed', lyra: 'installed' });
  assert.deepEqual(missing.rows.map(row => row.title), ['serviceVault', 'lyra']);
  assert.equal(missing.group.props.title, 'serviceSharedGroup');
  assert.deepEqual(missing.rows.map(row => buttons(row)), [['Install'], []]);
  assert.equal(missing.rows[0].hint, `${text('serviceVaultHint', 'en')} ${text('serviceNotInstalled', 'en')}`); assert.equal(missing.rows[1].hint, `${text('serviceLyraHint', 'en')} ${text('serviceInstalled', 'en')}`);
  const unstarted = sharedServices({ vault: 'did_not_start', lyra: 'unknown' });
  assert.deepEqual(unstarted.rows.map(row => buttons(row)), [['Reinstall', 'Retry'], []]);
  assert.equal(unstarted.rows[1].hint, `${text('serviceLyraHint', 'en')} ${text('serviceChecking', 'en')}`);
  const all = sharedServices({ vault: 'not_installed', lyra: 'not_installed' }, null, 'es');
  assert.deepEqual(all.rows.map(row => buttons(row)), [['Instalar'], ['Instalar']]);
  // Install offers again; Retry asks the clients again; Reinstall offers again. No button names an address or a path.
  const [vault] = all.rows; vault.controls[0].props.onClick();
  assert.deepEqual(plain(all.applied), [[{ type: 'service-offer', service: 'vault' }, '']]);
  const second = all.rows[1]; second.controls[0].props.onClick(); assert.deepEqual(plain(all.applied[1][0]), { type: 'service-offer', service: 'lyra' });
  const retry = unstarted.rows[0].controls; retry[0].props.onClick(); retry[1].props.onClick();
  assert.deepEqual(plain(unstarted.applied.map(([command]) => command)), [{ type: 'service-offer', service: 'vault' }, { type: 'service-check' }]);
  for (const [command] of plain([...all.applied, ...unstarted.applied])) assert.deepEqual(validateCommand(command), command);
  // While a dialog is open the buttons wait.
  const busy = sharedServices({ vault: 'not_installed', lyra: 'not_installed' }, dialogOf('offer'));
  assert.equal(busy.rows[0].controls[0].props.disabled, true);
  // Neither client says where the service's app is, so there is no Open button for an installed service.
  assert.equal(sharedServices({ vault: 'installed', lyra: 'installed' }).rows.every(row => buttons(row).length === 0), true);
});

test('the Settings group checks the services when General opens, and private windows do not show it', () => {
  const source = readFileSync('src/Settings.tsx', 'utf8');
  assert.match(source, /type: 'service-check'/);
  assert.match(source, /!state\.privateWindow && <SharedServices/);
});

test('every new copy key exists in both languages and the Spanish has no voseo or tuteo forms', () => {
  const keys = Object.keys(copy).filter(key => /^service[A-Z]/.test(key));
  assert.ok(keys.length >= 30);
  // Forms of vos and tu for the verbs and pronouns this copy could use, plus the regional words that go with them.
  const forms = ['vos', 'tu', 'tus', 'tú', 'ti', 'contigo', 'tuyo', 'tuya', 'usted', 'ustedes', 'acá', 'tenés', 'podés', 'querés', 'sabés', 'elegí', 'elegís', 'usá', 'usás', 'hacé', 'hacés', 'instalá', 'instalás', 'descargá', 'descargás', 'abrí', 'abrís', 'confirmá', 'confirmás', 'probá', 'probás', 'revisá', 'revisás', 'volvé', 'volvés', 'mirá', 'mirás', 'esperá', 'esperás', 'decís', 'vivís', 'sos', 'andá', 'andás', 'cerrá', 'cerrás', 'guardá', 'guardás', 'aceptá', 'aceptás', 'pasá', 'pasás', 'ponés', 'ponete', 'fijate', 'dejá', 'dejás', 'buscá', 'buscás', 'empezá', 'empezás', 'escribí', 'escribís', 'podes', 'tenes', 'queres'];
  const voseo = new RegExp(String.raw`(?<![\p{L}])(?:${forms.join('|')})(?![\p{L}])|\p{L}+(?:aste|iste)(?![\p{L}])`, 'iu');
  for (const key of keys) {
    for (const language of ['en', 'es']) {
      const value = copy[key][language];
      assert.ok(typeof value === 'string' && value.trim(), `${key} ${language}`);
      assert.doesNotMatch(value, /[\u2010-\u2015\u2212]/, `${key} ${language}`);
    }
    assert.doesNotMatch(copy[key].es, voseo, key);
    assert.doesNotMatch(copy[key].en, /[áéíóúñ¿¡]/, key);
  }
  // The same placeholders in both languages.
  for (const key of keys) assert.deepEqual((copy[key].es.match(/\{\w+\}/g) ?? []).sort(), (copy[key].en.match(/\{\w+\}/g) ?? []).sort(), key);
  // Every key the interface asks for exists.
  for (const file of ['src/Services.tsx', 'src/Settings.tsx']) {
    const source = readFileSync(file, 'utf8');
    for (const [, key] of source.matchAll(/\bt\('(service\w+)'\)/g)) assert.ok(copy[key], `${file} ${key}`);
    for (const [, key] of source.matchAll(/'(service[A-Z]\w+)'/g)) assert.ok(copy[key], `${file} ${key}`);
  }
  // The contract's texts, word for word.
  assert.equal(copy.serviceVaultTitle.en, 'Install Vault to keep passwords'); assert.equal(copy.serviceLyraTitle.es, 'Instalar Lyra para usar el asistente');
  assert.equal(copy.serviceInstall.es, 'Instalar'); assert.equal(copy.serviceNotNow.es, 'Ahora no'); assert.equal(copy.serviceAbout.es, '¿Qué es {service}?');
  // The check catches what it should.
  for (const bad of ['Tenés que instalarlo', 'Elegí una carpeta', 'Abriste el archivo', 'Revisá tu instalación', 'Acá está', 'Podés reintentar']) assert.match(bad, voseo);
  for (const good of ['La instalación descarga unos 42 MB', 'Hay una instalación en esta computadora', 'Reintentar cuando termine', 'Su página de descarga explica cómo obtenerla']) assert.doesNotMatch(good, voseo);
});
