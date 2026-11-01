// Task 036: Lyra as the only model source. Horizon's assistant and translation run through the real adapter against fake Lyra services
// that speak protocol 1 (the 0.2.0 contract) or protocol 2 (sources, features, start source and the new codes), all on 127.0.0.1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { compileFunction, createContext, runInContext } = require('node:vm');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLyra, desktopNotice, lyraChat } = require('../dist/electron/lyra.js');
const { createTranslation } = require('../dist/electron/translate.js');
const { lyraErrorKey, lyraManaged } = require('../dist/src/shared/lyra.js');
const { copy, text } = require('../dist/src/copy.js');
const { setPermission, lyraExternal } = require('../dist/electron/site-settings.js');
const { validateStore } = require('../dist/electron/store.js');
const { emptySyncStore, validateRecord } = require('../dist/electron/sync-model.js');

const library = () => import(pathToFileURL(resolve(__dirname, '../packages/horizon-lyra/dist/index.js')).href);
const app = { id: 'horizon', name: 'Horizon', kind: 'cosmic' }, token = 'T'.repeat(43), bootstrap = 'B'.repeat(43);
const ALL_FEATURES = ['sources', 'sources.order', 'connections', 'cli', 'instructions', 'local-messages', 'budget', 'images', 'embeddings', 'account', 'sync.quantum', 'vault'];
const capabilities = { text: true, structured: false, tools: false, images: false, budget: true, fim: false, embeddings: false };
const source = (id, kind, external, state, model = null) => ({ id, kind, external, state, model, capabilities, ...(kind === 'cli' ? { connected: true } : {}) });
const order = ['local', 'groq', 'gemini', 'openrouter', 'paid', 'claude', 'codex', 'cursor', 'opencode', 'copilot', 'antigravity'];
// Every source not ready, then the one route each case makes ready.
const quiet = () => order.map(id => id === 'local' ? source(id, 'local', false, 'not_installed') : ['groq', 'gemini', 'openrouter', 'paid'].includes(id) ? source(id, 'key', true, 'disabled') : source(id, 'cli', true, 'login_required'));
const only = ready => quiet().map(entry => ready[entry.id] ? { ...entry, state: 'ready', model: ready[entry.id] } : entry);
// The start events of Lyra's Horizon fixtures (packages/client/test/fixtures/horizon.json at 3e0c798), with a CLI answer next to them.
const START = {
  local: { type: 'start', mode: 'fast', model: 'lyra-base', fellBack: false, provider: 'local', source: { id: 'local', kind: 'local', external: false, model: 'lyra-base' } },
  key: { type: 'start', mode: 'fast', model: 'gemini-2.5-flash', fellBack: false, provider: 'gemini', source: { id: 'gemini', kind: 'key', external: true, model: 'gemini-2.5-flash' } },
  cli: { type: 'start', mode: 'fast', model: 'claude-sonnet-4-5', fellBack: false, provider: 'cli', source: { id: 'claude', kind: 'cli', external: true, model: 'claude-sonnet-4-5' } },
  old: { type: 'start', mode: 'fast', model: 'lyra-base', fellBack: false, provider: 'local' },
};
const CODES = ['source_login', 'source_quota', 'source_unavailable', 'source_version', 'source_protocol', 'unsupported', 'local_only'];

function temporary(t) {
  const root = resolve('.runtime'); mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, 'lyra-routes-test-')); t.after(() => rmSync(folder, { recursive: true, force: true })); return folder;
}
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
const lines = (response, events) => { response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.end(events.map(event => JSON.stringify(event)).join('\n') + '\n'); };
// A fake Lyra service. options.turn answers each chat: an array of events, or a function of (payload, response) that writes its own stream.
async function fakeLyra(t, options = {}) {
  const home = temporary(t), hits = [], state = { protocol: options.protocol ?? 2, features: options.features ?? ALL_FEATURES, sources: options.sources ?? only({ local: 'lyra-base' }), started: 1 };
  const server = createServer((request, response) => {
    const parts = [];
    request.on('data', part => parts.push(part));
    request.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8'), payload = text ? JSON.parse(text) : undefined, header = request.headers['lyra-protocol'];
      hits.push({ method: request.method, url: request.url, header, payload });
      const protocol2 = state.protocol >= 2 && header === '2';
      if (request.url === '/v1/health') return json(response, 200, { ok: true, serviceVersion: '0.3.0', ...(state.protocol >= 2 ? { protocol: state.protocol, features: state.features } : {}) });
      if (request.url === '/v1/apps/register') return json(response, 201, { app: { id: 'horizon' }, token });
      if (request.url === '/v1/sources') return protocol2 ? json(response, 200, { order, sources: state.sources }) : json(response, 404, { error: { code: 'not_found', message: 'No' } });
      if (request.url === '/v1/models') return json(response, 200, { ready: true, ollama: { installed: true, running: true }, modes: { fast: { ready: options.localReady ?? true } } });
      if (request.url === '/v1/app/open') return options.appMissing ? json(response, 409, { error: { code: 'app_missing', message: 'No' } }) : json(response, 202, { opened: true });
      if (request.url === '/v1/chat') {
        const turn = options.turn ?? (() => [protocol2 ? START.local : START.old, { type: 'text', text: 'Answer.' }, { type: 'done' }]);
        const events = turn(payload, response, protocol2);
        if (Array.isArray(events)) lines(response, events);
        return;
      }
      json(response, 404, { error: { code: 'not_found', message: 'No' } });
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  mkdirSync(join(home, 'run'), { recursive: true }); mkdirSync(join(home, 'secrets'), { recursive: true });
  const announce = () => writeFileSync(join(home, 'run', 'service.json'), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, serviceVersion: '0.3.0', startedAt: state.started }));
  announce(); writeFileSync(join(home, 'secrets', 'bootstrap.key'), bootstrap);
  let stored;
  const tokens = { async get() { return stored; }, async set(value) { stored = value; } };
  const connect = async () => (await library()).connect({ app, tokens, home });
  // A restart is another service process: a new start time in the service record.
  const restart = () => { state.started++; announce(); };
  return { home, hits, state, connect, restart, server, chats: () => hits.filter(hit => hit.url === '/v1/chat') };
}
async function until(read, check, what) {
  for (let attempt = 0; attempt < 500; attempt++) { const value = read(); if (check(value)) return value; await new Promise(done => setTimeout(done, 10)); }
  assert.fail(`${what} did not happen; last state: ${JSON.stringify(read())}`);
}

// ------------------------------------------------------------------ the assistant
function assistant(service, options = {}) {
  // The saved decision of each site, with the notice it was given under, as the browser store keeps it.
  const decisions = new Map(), notices = new Map(), pages = new Map(), reads = [];
  let alive = true;
  const host = {
    privateWindow: options.privateWindow ?? false, alive: () => alive, language: () => 'en', changed() {},
    page: id => { if (!pages.has(id)) throw new Error('LYRA_PAGE_UNAVAILABLE'); return pages.get(id); },
    decision: origin => decisions.get(origin) ?? 'ask', external: origin => decisions.get(origin) === 'allow' && notices.get(origin) === true,
    allow: (origin, external) => { decisions.set(origin, 'allow'); notices.set(origin, external); },
    desktopExternal: () => false, allowDesktop() {},
    project: () => ({ id: 'project', items: [] }), item: () => undefined, save() {},
    connect: service.connect,
  };
  // A page whose site the person already allowed, by default under the notice that says external sources may answer; 'local' under the local notice, 'ask' not yet.
  const add = (id, url, notice = 'external') => {
    const page = { id, url, title: id, generation: 1, contents: { getURL: () => page.url, isDestroyed: () => false,
      debugger: { isAttached: () => false, attach() {}, detach() {}, async sendCommand(method) {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
        reads.push([id, method]);
        return { nodes: [{ nodeId: 'facts', role: { value: 'StaticText' }, name: { value: 'Release notes of version 2.' } }] };
      } } } };
    pages.set(id, page); if (notice !== 'ask') host.allow(new URL(url).origin, notice === 'external'); return page;
  };
  const lyra = createLyra(host);
  const ask = (task = 'summary') => lyra.run({ type: 'lyra-ask', task, question: 'Summarize this page.', tabs: ['page'], project: null, item: null });
  return { lyra, add, ask, reads, decisions, notices, close: () => { alive = false; lyra.stop(); } };
}
const settled = (lyra, phase) => until(() => lyra.state(), state => state.phase === phase || state.phase === 'failed' && phase !== 'failed', `Lyra reaching ${phase}`).then(state => { assert.equal(state.phase, phase, `error ${state.error}`); return state; });

test('the assistant answers through a local model, an API key or a CLI with no local model, and shows the source that answered', async t => {
  for (const [route, ready, start, cloudReady] of [['local', { local: 'lyra-base' }, START.local, false], ['key', { gemini: 'gemini-2.5-flash' }, START.key, true], ['cli', { claude: 'claude-sonnet-4-5' }, START.cli, true]]) {
    const service = await fakeLyra(t, { sources: only(ready), turn: () => [start, { type: 'text', text: 'The page lists the changes of version 2.' }, { type: 'done' }] });
    const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://notes.example/release');
    await fixture.lyra.run({ type: 'lyra-open' }); const home = await settled(fixture.lyra, 'home');
    assert.equal(home.route, 'any', route);
    await fixture.ask(); const answer = await settled(fixture.lyra, 'answer');
    assert.equal(answer.answer, 'The page lists the changes of version 2.');
    assert.deepEqual(answer.answeredBy, { id: start.source.id, kind: start.source.kind, model: start.source.model }, route);
    const [chat] = service.chats();
    // A question from the person is an explicit action, so it admits every source the person approved in Lyra; with no external source ready it is sent without cloud.
    assert.equal(chat.payload.cloud, cloudReady ? true : undefined, route); assert.equal(chat.header, '2');
    assert.ok(chat.payload.context.includes('Release notes of version 2.'));
    assert.equal(Object.hasOwn(chat.payload, 'contextLocal'), false);
    assert.equal(cloudReady, !service.state.sources.find(entry => entry.id === 'local').state.includes('ready'));
  }
});

test('the assistant on a protocol 1 service keeps today\'s local behaviour: no sources, no cloud and the 0.2.0 start event', async t => {
  const service = await fakeLyra(t, { protocol: 1 });
  const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://notes.example/release');
  await fixture.lyra.run({ type: 'lyra-open' }); assert.equal((await settled(fixture.lyra, 'home')).route, 'local');
  await fixture.ask(); const answer = await settled(fixture.lyra, 'answer');
  assert.equal(answer.answeredBy, null); assert.equal(answer.answer, 'Answer.');
  assert.equal(service.hits.some(hit => hit.url === '/v1/sources'), false);
  assert.equal(Object.hasOwn(service.chats()[0].payload, 'cloud'), false);
  // Without a local model the protocol 1 answer stays model_missing, and the person manages models in Lyra.
  const missing = await fakeLyra(t, { protocol: 1, localReady: false });
  const empty = assistant(missing); t.after(empty.close);
  await empty.lyra.run({ type: 'lyra-open' }); assert.equal((await settled(empty.lyra, 'failed')).error, 'model_missing');
  assert.equal(lyraManaged('model_missing'), true);
});

test('readiness follows Lyra\'s sources: every non-ready state is refused and any one ready source is enough', async t => {
  const states = ['not_installed', 'login_required', 'unsupported_version', 'quota', 'unavailable', 'failed', 'disabled'];
  const service = await fakeLyra(t, { sources: quiet().map((entry, index) => ({ ...entry, state: states[index % states.length] })) });
  const client = await service.connect();
  const view = await client.sources.list();
  assert.deepEqual([...new Set(view.sources.map(entry => entry.state))].sort(), [...states].sort());
  assert.equal(view.sources.find(entry => entry.id === 'claude').connected, true);
  const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://notes.example/release');
  await fixture.lyra.run({ type: 'lyra-open' }); assert.equal((await settled(fixture.lyra, 'failed')).error, 'no_source');
  await fixture.ask(); assert.equal((await settled(fixture.lyra, 'failed')).error, 'no_source');
  assert.equal(fixture.reads.length, 0, 'No page is read when nothing can answer'); assert.equal(service.chats().length, 0);
  service.state.sources = only({ codex: 'gpt-5.5-codex' });
  await fixture.lyra.run({ type: 'lyra-retry' }); await settled(fixture.lyra, 'answer');
  assert.equal(service.chats()[0].payload.cloud, true);
});

test('negotiation sends protocol 2 everywhere, reads features once per service process and refuses a missing feature before any body', async t => {
  const service = await fakeLyra(t, { features: ['local-messages'] });
  const client = await service.connect();
  const healthBefore = service.hits.filter(hit => hit.url === '/v1/health').length;
  assert.deepEqual(await client.capabilities(), { protocol: 2, serviceVersion: '0.3.0', features: ['local-messages'] });
  await client.capabilities();
  assert.equal(service.hits.filter(hit => hit.url === '/v1/health').length, healthBefore, 'Features are kept for the service process');
  assert.ok(service.hits.every(hit => hit.header === '2'));
  // Without the sources feature Horizon cannot know a route, so the assistant refuses before reading or sending anything.
  await assert.rejects(client.sources.list(), { code: 'unsupported' });
  const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://notes.example/release');
  await fixture.lyra.run({ type: 'lyra-open' }); assert.equal((await settled(fixture.lyra, 'failed')).error, 'unsupported');
  await fixture.ask(); assert.equal((await settled(fixture.lyra, 'failed')).error, 'unsupported');
  assert.equal(fixture.reads.length, 0); assert.equal(service.chats().length, 0);
  assert.equal(service.hits.some(hit => hit.url === '/v1/sources'), false);
  // A restarted service is another process, whose features are read again.
  service.state.features = ALL_FEATURES; service.restart();
  assert.deepEqual((await (await service.connect()).capabilities()).features, ALL_FEATURES);
  // Content marked local needs local-messages; cloud and local fields are never sent to a protocol 1 service.
  const bare = await fakeLyra(t, { features: ['sources'] }), old = await fakeLyra(t, { protocol: 1 });
  const local = { mode: 'fast', messages: [{ role: 'user', content: 'Private.', local: true }], contextLocal: true };
  for (const [target, request] of [[bare, local], [old, local], [old, { mode: 'fast', messages: [{ role: 'user', content: 'Hello' }], cloud: true }]]) {
    const refused = await target.connect();
    await assert.rejects((async () => { for await (const event of refused.chat(request)) void event; })(), { code: 'unsupported' });
    assert.equal(target.chats().length, 0, 'No request body reaches a service that cannot honour it');
  }
  const full = await fakeLyra(t); const fullClient = await full.connect();
  for await (const event of fullClient.chat(local)) void event;
  assert.deepEqual(full.chats()[0].payload, { mode: 'fast', messages: [{ role: 'user', content: 'Private.', local: true }], contextLocal: true });
});

test('every protocol 2 turn code is reported as itself with its own copy in English and Spanish', async t => {
  let code;
  const service = await fakeLyra(t, { turn: () => [{ type: 'error', code }] });
  const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://notes.example/release');
  for (code of CODES) {
    await fixture.ask(); assert.equal((await settled(fixture.lyra, 'failed')).error, code);
    const key = lyraErrorKey(code); assert.ok(key && key !== 'lyraFailure', code);
    for (const language of ['en', 'es']) assert.ok(copy[key][language].trim(), `${code} ${language}`);
  }
  for (const key of ['no_source', 'service_lost', 'cancelled', 'unavailable']) assert.ok(copy[lyraErrorKey(key)].es.trim());
  for (const key of ['TRANSLATE_LOCAL_REQUIRED', 'LYRA_APP_MISSING', 'LYRA_APP_UNAVAILABLE']) for (const language of ['en', 'es']) assert.ok(copy[key][language].trim());
});

test('cancellation and a service lost mid-answer are reported as such, and a service that drops the request as unavailable', async t => {
  let mode = 'hold';
  const service = await fakeLyra(t, { turn: (payload, response) => {
    if (mode === 'refuse') return void response.socket.destroy();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.write(JSON.stringify(START.local) + '\n');
    if (mode === 'lose') { response.write(JSON.stringify({ type: 'text', text: 'Partial' }) + '\n'); setTimeout(() => response.destroy(), 20); }
    if (mode === 'truncate') response.end(JSON.stringify({ type: 'text', text: 'Partial' }) + '\n');
  } });
  const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://notes.example/release');
  await fixture.ask(); await until(() => fixture.lyra.state().answeredBy, Boolean, 'the answer starting');
  await fixture.lyra.run({ type: 'lyra-cancel' });
  assert.equal(fixture.lyra.state().error, 'cancelled'); assert.equal(fixture.lyra.state().answer, '');
  for (mode of ['lose', 'truncate']) { await fixture.ask(); assert.equal((await settled(fixture.lyra, 'failed')).error, 'service_lost', mode); }
  mode = 'refuse'; await fixture.ask(); assert.equal((await settled(fixture.lyra, 'failed')).error, 'unavailable');
});

test('model and provider management opens Lyra\'s own app, and a missing app is said plainly', async t => {
  const service = await fakeLyra(t), fixture = assistant(service); t.after(fixture.close);
  await fixture.lyra.run({ type: 'lyra-manage' });
  assert.deepEqual(service.hits.filter(hit => hit.url === '/v1/app/open').map(hit => hit.payload), [{ section: 'models' }]);
  const missing = await fakeLyra(t, { appMissing: true }), other = assistant(missing); t.after(other.close);
  await assert.rejects(other.lyra.run({ type: 'lyra-manage' }), /LYRA_APP_MISSING/);
});

test('a private window never reaches Lyra, for the assistant or for translation', async t => {
  const service = await fakeLyra(t, { sources: only({ local: 'lyra-base', gemini: 'gemini-2.5-flash' }) });
  const fixture = assistant(service, { privateWindow: true }); t.after(fixture.close); fixture.add('page', 'https://private.example/');
  for (const type of ['lyra-open', 'lyra-home', 'lyra-retry', 'lyra-manage']) await assert.rejects(fixture.lyra.run({ type }), /LYRA_PRIVATE/);
  await assert.rejects(fixture.ask(), /LYRA_PRIVATE/);
  const page = translation(service, { privateWindow: true }); t.after(page.close);
  page.translation.probe();
  for (const type of ['translate-open', 'translate-start', 'translate-retry']) assert.throws(() => page.translation.run({ type }), /TRANSLATE_PRIVATE/);
  await new Promise(done => setTimeout(done, 50));
  assert.deepEqual(service.hits, [], 'Not even a health check leaves a private window');
});

test('a site allowed under the local notice is asked again before external sources may answer, and the new allow records that notice', async t => {
  const service = await fakeLyra(t, { protocol: 1, turn: (_payload, _response, protocol2) => [protocol2 ? START.key : START.old, { type: 'text', text: 'Answer.' }, { type: 'done' }] });
  const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://bank.example/statement', 'ask');
  await fixture.lyra.run({ type: 'lyra-open' }); await settled(fixture.lyra, 'home');
  await fixture.ask(); const local = await settled(fixture.lyra, 'permission');
  // The renderer shows lyraReadNotice for the local route: "nothing leaves it".
  assert.equal(local.route, 'local'); assert.match(copy.lyraReadNotice.en, /nothing leaves it/);
  await fixture.lyra.run({ type: 'lyra-permission', id: local.permission.id, answer: 'site' }); await settled(fixture.lyra, 'answer');
  assert.equal(fixture.notices.get('https://bank.example'), false, 'The allow records the local notice');
  assert.equal(Object.hasOwn(service.chats()[0].payload, 'cloud'), false);
  // Lyra is updated to protocol 2 with an API key ready: the saved local allow does not cover it.
  service.state.protocol = 2; service.state.sources = only({ local: 'lyra-base', gemini: 'gemini-2.5-flash' }); service.restart();
  await fixture.lyra.run({ type: 'lyra-home' }); await settled(fixture.lyra, 'home');
  const reads = fixture.reads.length;
  await fixture.ask(); const external = await settled(fixture.lyra, 'permission');
  assert.equal(external.route, 'any', 'The new notice says external sources may answer');
  assert.equal(service.chats().length, 1); assert.equal(fixture.reads.length, reads, 'Nothing is read or sent before the new notice is answered');
  await fixture.lyra.run({ type: 'lyra-permission', id: external.permission.id, answer: 'site' }); await settled(fixture.lyra, 'answer');
  assert.equal(fixture.notices.get('https://bank.example'), true);
  assert.equal(service.chats()[1].payload.cloud, true); assert.ok(service.chats()[1].payload.context.includes('Release notes of version 2.'));
  // An allow given under the external notice covers later questions without asking again.
  await fixture.ask(); await settled(fixture.lyra, 'answer'); assert.equal(service.chats()[2].payload.cloud, true);
  // A one-time grant under the local notice never covers a turn external sources may answer either.
  const once = assistant(await fakeLyra(t, { sources: only({ gemini: 'gemini-2.5-flash' }), turn: () => [START.key, { type: 'text', text: 'Answer.' }, { type: 'done' }] })); t.after(once.close);
  once.add('page', 'https://bank.example/statement', 'local');
  await once.lyra.run({ type: 'lyra-open' }); await settled(once.lyra, 'home');
  await once.ask(); assert.equal((await settled(once.lyra, 'permission')).route, 'any'); assert.equal(once.reads.length, 0);
});

test('a Lyra allow stores its notice, and decisions stored or synced without it read as local only', () => {
  const settings = { blocking: [], dark: [], permissions: [] }, profile = randomUUID();
  setPermission(settings, 'https://new.example', 'lyra', 'allow', true);
  assert.equal(lyraExternal(settings, 'https://new.example'), true);
  // An entry stored or synced before the notice was recorded: an allow under the local notice.
  const old = { origin: 'https://old.example', camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'ask', lyra: 'allow' };
  settings.permissions.push(old);
  assert.equal(lyraExternal(settings, old.origin), false);
  assert.ok(validateStore({ ...emptySyncStore(), siteSettings: settings }));
  for (const entry of settings.permissions) validateRecord({ item: 'siteSettings', profile, key: `permissions:${entry.origin}`, value: entry });
  for (const value of [{ ...old, lyra: 'block', lyraExternal: true }, { ...old, lyraExternal: false }]) {
    assert.throws(() => validateRecord({ item: 'siteSettings', profile, key: `permissions:${old.origin}`, value }), /SYNC_INVALID/);
  }
  // Any other decision, or an allow from the site settings page, drops the recorded external notice.
  setPermission(settings, 'https://new.example', 'lyra', 'block'); assert.equal(lyraExternal(settings, 'https://new.example'), false);
  setPermission(settings, 'https://new.example', 'lyra', 'allow'); assert.equal(lyraExternal(settings, 'https://new.example'), false);
  assert.equal(Object.hasOwn(settings.permissions[0], 'lyraExternal'), false);
});

test('a retry asks Lyra again which routes are ready after a mid-session upgrade, under the notice rule', async t => {
  const service = await fakeLyra(t, { protocol: 1, turn: (payload, _response, protocol2) => protocol2 && !payload.cloud ? [{ type: 'error', code: 'local_only' }] : [protocol2 ? START.key : START.old, { type: 'text', text: 'Answer.' }, { type: 'done' }] });
  const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://notes.example/release', 'local');
  await fixture.lyra.run({ type: 'lyra-open' }); await settled(fixture.lyra, 'home');
  await fixture.ask(); assert.equal((await settled(fixture.lyra, 'answer')).route, 'local');
  // Lyra is upgraded with only an API key ready. The next question keeps the local route the person was shown and fails for it.
  service.state.protocol = 2; service.state.sources = only({ gemini: 'gemini-2.5-flash' }); service.restart();
  await fixture.ask(); assert.equal((await settled(fixture.lyra, 'failed')).error, 'local_only');
  // The retry follows the routes Lyra offers now and, before any read, asks with the notice that says external sources may answer.
  const reads = fixture.reads.length;
  await fixture.lyra.run({ type: 'lyra-retry' }); const asked = await settled(fixture.lyra, 'permission');
  assert.equal(asked.route, 'any'); assert.equal(fixture.reads.length, reads);
  await fixture.lyra.run({ type: 'lyra-permission', id: asked.permission.id, answer: 'once' }); await settled(fixture.lyra, 'answer');
  assert.equal(service.chats().at(-1).payload.cloud, true);
});

test('a turn that fails after its start event never claims a source answered it', async t => {
  let mode = 'lose';
  const service = await fakeLyra(t, { sources: only({ claude: 'claude-sonnet-4-5' }), turn: (payload, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.write(JSON.stringify(START.cli) + '\n');
    if (mode === 'lose') setTimeout(() => response.destroy(), 20);
    if (mode === 'error') response.end(JSON.stringify({ type: 'error', code: 'source_quota' }) + '\n');
  } });
  const fixture = assistant(service); t.after(fixture.close); fixture.add('page', 'https://notes.example/release');
  for (mode of ['lose', 'error']) {
    await fixture.ask(); const failed = await settled(fixture.lyra, 'failed');
    assert.notEqual(failed.error, null, mode); assert.equal(failed.answeredBy, null, mode);
  }
  mode = 'hold'; await fixture.ask(); await until(() => fixture.lyra.state().answeredBy, Boolean, 'the answer starting');
  await fixture.lyra.run({ type: 'lyra-cancel' }); assert.equal(fixture.lyra.state().answeredBy, null);
  // With no source that answered, the route line says where Lyra may answer from.
  assert.equal(component('src/Lyra.tsx').lyraRouteText(fixture.lyra.state(), 'en'), copy.lyraRoutes.en);
});

// ------------------------------------------------------------------ the renderer
// Transpiles one renderer file with its imports replaced by the built copy and plain stand-ins, so its text can be read without a window.
function component(file, hooks = {}) {
  const ts = require('typescript');
  const source = ts.transpileModule(readFileSync(resolve(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported = {}, jsx = (type, props) => ({ type, props }), stand = new Proxy({}, { get: (_target, name) => String(name) });
  const modules = {
    react: { useEffect() {}, useLayoutEffect() {}, useId: () => 'id', useRef: value => ({ current: value }), useState: value => [value, () => {}], ...hooks },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': stand,
    './copy': require('../dist/src/copy.js'), './shared/lyra': require('../dist/src/shared/lyra.js'),
    './Desktop': stand, './ToolbarPopover': stand, './Switch': stand, './SidePanelFaces': stand,
  };
  compileFunction(source, ['exports', 'require'])(exported, name => { assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`); return modules[name]; });
  return exported;
}
// Every node of a rendered tree, depth first.
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  const children = node.props?.children;
  return [node, ...nodes(typeof node.type === 'function' ? node.type(node.props) : children)];
}
const words = node => Array.isArray(node) ? node.map(words).join('') : typeof node === 'string' ? node : node && typeof node === 'object' ? words(node.props?.children) : '';
function bar(value, hooks) {
  const tree = component('src/Translate.tsx', hooks).TranslateBar({ value, state: { store: { siteSettings: { translation: { always: [], never: [] } } } }, language: 'en', options: false, onOptions() {}, dismiss: false });
  const all = nodes(tree);
  return { status: words(all.find(node => node.props?.className === 'translation-status')), buttons: all.filter(node => node.type === 'button').map(words) };
}
// The text of the options menu, where the target language is chosen.
function menu(value) {
  const tree = component('src/Translate.tsx').TranslateBar({ value, state: { store: { siteSettings: { translation: { always: [], never: [] } } } }, language: 'en', options: true, onOptions() {}, dismiss: false });
  return words(nodes(tree).find(node => node.props?.className === 'translation-options'));
}

// ------------------------------------------------------------------ translation
function translation(service, options = {}) {
  const entries = ['Bonjour tout le monde.', 'Trois promenades autour du lac.'].map(text => ({ nodeValue: text, isConnected: true, parentElement: { closest: () => null, isContentEditable: false, getClientRects: () => [{}] } }));
  const document = { documentElement: { lang: options.lang ?? 'fr' }, body: {}, createTreeWalker: () => { let index = 0; return { nextNode: () => entries[index++] ?? null }; } };
  const world = createContext({ document, NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const page = { url: 'https://journal.example/fr', generation: 1, header: null, contents: { isDestroyed: () => false, getURL: () => page.url,
    async executeJavaScriptInIsolatedWorld(_id, scripts) { return runInContext(scripts[0].code, world); } } };
  let alive = true; const seen = [];
  const host = {
    privateWindow: options.privateWindow ?? false, alive: () => alive, page: () => page, language: () => 'en', changed() { seen.push(translation.state()); },
    never: () => false, always: () => options.always ?? null, remember() {},
    installed: async () => true, available: async () => true, connect: service.connect,
  };
  const translation = createTranslation(host);
  return { translation, entries, seen, close() { translation.stop(); alive = false; } };
}
const translated = (payload, protocol2, start = START.local) => {
  const data = JSON.parse(payload.context).data;
  return [...(protocol2 ? [start] : []), { type: 'text', text: data.sample ? 'fr' : JSON.stringify(data.texts.map(text => 'EN ' + text)) }, { type: 'done' }];
};
const phase = (fixture, value) => until(() => fixture.translation.state(), state => state.phase === value || state.phase === 'failed', `translation reaching ${value}`);

test('automatic translation stays local: it never sends cloud and, with only external sources ready, says it needs a local model', async t => {
  const local = await fakeLyra(t, { sources: only({ local: 'lyra-base', gemini: 'gemini-2.5-flash' }), turn: (payload, _response, protocol2) => translated(payload, protocol2) });
  const always = translation(local, { always: 'en' }); t.after(always.close);
  always.translation.probe(); assert.equal((await phase(always, 'translated')).phase, 'translated');
  assert.ok(local.chats().length > 0);
  for (const chat of local.chats()) assert.equal(Object.hasOwn(chat.payload, 'cloud'), false);
  assert.equal(always.entries[0].nodeValue, 'EN Bonjour tout le monde.');
  // Only an API key and a CLI are ready: the automatic translation sends nothing and asks for a local model.
  const external = await fakeLyra(t, { sources: only({ gemini: 'gemini-2.5-flash', claude: 'claude-sonnet-4-5' }), turn: (payload, _response, protocol2) => translated(payload, protocol2, START.key) });
  const remote = translation(external, { always: 'en' }); t.after(remote.close);
  remote.translation.probe(); const failed = await phase(remote, 'failed');
  assert.equal(failed.error, 'TRANSLATE_LOCAL_REQUIRED'); assert.equal(external.chats().length, 0);
  assert.equal(lyraManaged(failed.error), true);
  assert.equal(remote.entries[0].nodeValue, 'Bonjour tout le monde.');
  // An unknown language is never guessed remotely either: the automatic detection ends silently with nothing sent.
  const unknown = translation(external, { lang: '' }); t.after(unknown.close);
  unknown.translation.probe(); await new Promise(done => setTimeout(done, 200));
  assert.deepEqual([unknown.translation.state().phase, unknown.translation.state().open], ['idle', false]); assert.equal(external.chats().length, 0);
});

test('a translation the person asks for may use the remote routes with cloud: true', async t => {
  const external = await fakeLyra(t, { sources: only({ claude: 'claude-sonnet-4-5' }), turn: (payload, _response, protocol2) => translated(payload, protocol2, START.cli) });
  const fixture = translation(external); t.after(fixture.close);
  // A click taken with no bar on screen stops on the offer, which now says the text may leave this computer; the next click goes through.
  fixture.translation.run({ type: 'translate-start' });
  const offered = await until(() => fixture.translation.state(), state => state.phase === 'offered' && state.external === true || state.phase === 'failed', 'the offer with the external line');
  assert.equal(external.chats().length, 0); assert.ok(bar(offered).status.endsWith(copy.translateExternal.en));
  fixture.translation.run({ type: 'translate-start' }); assert.equal((await phase(fixture, 'translated')).phase, 'translated');
  assert.ok(external.chats().length > 0);
  for (const chat of external.chats()) assert.equal(chat.payload.cloud, true);
  // After an automatic refusal, a retry stays automatic and sends nothing; the bar offers a new request by the person, which goes through.
  const refused = await fakeLyra(t, { sources: only({ gemini: 'gemini-2.5-flash' }), turn: (payload, _response, protocol2) => translated(payload, protocol2, START.key) });
  const retried = translation(refused, { always: 'en' }); t.after(retried.close);
  retried.translation.probe(); const failed = await phase(retried, 'failed'); assert.equal(failed.error, 'TRANSLATE_LOCAL_REQUIRED');
  retried.translation.run({ type: 'translate-retry' }); await until(() => retried.translation.state(), state => state.phase === 'failed', 'the retry failing');
  await new Promise(done => setTimeout(done, 50));
  assert.equal(retried.translation.state().error, 'TRANSLATE_LOCAL_REQUIRED'); assert.equal(refused.chats().length, 0);
  const offer = bar(retried.translation.state());
  assert.ok(offer.buttons.includes('Translate to English')); assert.equal(offer.buttons.includes(copy.retry.en), false);
  assert.ok(offer.status.endsWith(copy.translateExternal.en));
  retried.translation.run({ type: 'translate-start' }); assert.equal((await phase(retried, 'translated')).phase, 'translated');
  assert.ok(refused.chats().length > 0 && refused.chats().every(chat => chat.payload.cloud === true));
  // A protocol 1 service translates as before: no cloud field.
  const old = await fakeLyra(t, { protocol: 1, turn: (payload, _response, protocol2) => translated(payload, protocol2) });
  const today = translation(old); t.after(today.close);
  today.translation.run({ type: 'translate-start' }); assert.equal((await phase(today, 'translated')).phase, 'translated');
  for (const chat of old.chats()) assert.equal(Object.hasOwn(chat.payload, 'cloud'), false);
});

test('translation reports cancellation, service loss and no ready source truthfully', async t => {
  let mode = 'hold';
  const service = await fakeLyra(t, { turn: (payload, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.write(JSON.stringify(START.local) + '\n');
    if (mode === 'lose') setTimeout(() => response.destroy(), 20);
  } });
  const fixture = translation(service); t.after(fixture.close);
  fixture.translation.run({ type: 'translate-start' }); await until(() => service.chats().length, Boolean, 'the turn starting');
  fixture.translation.run({ type: 'translate-cancel' }); assert.equal(fixture.translation.state().error, 'cancelled');
  mode = 'lose'; fixture.translation.run({ type: 'translate-retry' }); assert.equal((await phase(fixture, 'translated')).error, 'service_lost');
  service.state.sources = quiet(); service.restart();
  const before = service.chats().length;
  fixture.translation.run({ type: 'translate-retry' }); assert.equal((await phase(fixture, 'translated')).error, 'TRANSLATE_NO_SOURCE');
  assert.equal(service.chats().length, before);
});

test('a manual translation that may use external sources says so on the offer and shows where it is translating', async t => {
  const service = await fakeLyra(t, { sources: only({ gemini: 'gemini-2.5-flash' }), turn: (payload, _response, protocol2) => translated(payload, protocol2, START.key) });
  const fixture = translation(service); t.after(fixture.close);
  // Before anything was asked, Lyra's routes are unknown, so the offer says the text may leave this computer.
  fixture.translation.run({ type: 'translate-open' }); const offered = bar(await phase(fixture, 'offered'));
  assert.ok(offered.status.endsWith(copy.translateExternal.en)); assert.ok(offered.buttons.includes('Translate to English'));
  fixture.translation.run({ type: 'translate-start' }); assert.equal((await phase(fixture, 'translated')).phase, 'translated');
  assert.ok(service.chats().every(chat => chat.payload.cloud === true));
  const running = fixture.seen.filter(state => state.phase === 'running');
  // Before the start event the bar does not claim this computer; from it, it names the API key that is translating.
  assert.equal(bar(running[0]).status, copy.translatingPending.en);
  const through = running.find(state => state.answeredBy);
  assert.deepEqual(through.answeredBy, { id: 'gemini', kind: 'key', model: 'gemini-2.5-flash' });
  assert.equal(bar(through).status, 'Translating with an API key · gemini-2.5-flash');
  assert.equal(running.some(state => bar(state).status === copy.translating.en), false, 'Never "on this computer" while an external source translates');
  for (const language of ['en', 'es']) assert.match(text('translatingCli', language).replace('{source}', 'Claude Code').replace('{model}', 'm'), /Claude Code · m$/);
  // After the routes are known: with an external source ready the offer keeps the line, with none it is gone and the run is on this computer.
  assert.equal(fixture.translation.state().external, true);
  const local = await fakeLyra(t, { protocol: 1, turn: (payload, _response, protocol2) => translated(payload, protocol2) });
  const today = translation(local); t.after(today.close);
  today.translation.run({ type: 'translate-start' }); await phase(today, 'translated');
  assert.equal(today.translation.state().external, false);
  assert.ok(today.seen.filter(state => state.phase === 'running' && state.external === false).every(state => bar(state).status === copy.translating.en));
  assert.equal(bar({ ...today.translation.state(), phase: 'original' }).status.includes(copy.translateExternal.en), false);
});

test('a retry after a failed automatic translation stays automatic and local', async t => {
  let lose = true;
  const service = await fakeLyra(t, { sources: only({ local: 'lyra-base', gemini: 'gemini-2.5-flash' }), turn: (payload, response, protocol2) => {
    if (lose) { lose = false; response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.write(JSON.stringify(START.local) + '\n'); setTimeout(() => response.destroy(), 20); return; }
    return translated(payload, protocol2, payload.cloud ? START.key : START.local);
  } });
  const fixture = translation(service, { always: 'en' }); t.after(fixture.close);
  fixture.translation.probe(); assert.equal((await phase(fixture, 'translated')).error, 'service_lost');
  fixture.translation.run({ type: 'translate-retry' }); assert.equal((await phase(fixture, 'translated')).phase, 'translated');
  assert.ok(service.chats().length >= 2);
  for (const chat of service.chats()) assert.equal(Object.hasOwn(chat.payload, 'cloud'), false);
  // Only a new request by the person may go remote.
  fixture.translation.run({ type: 'translate-original' }); await phase(fixture, 'original');
  const before = service.chats().length;
  fixture.translation.run({ type: 'translate-start' }); await phase(fixture, 'translated');
  assert.ok(service.chats().length > before && service.chats().slice(before).every(chat => chat.payload.cloud === true));
});

// ------------------------------------------------------------------ notices before content leaves this computer
// A host whose saved item and project hold a private note, with the profile's lasting answer to the notice for saved items.
function desktopHost(service) {
  const note = { id: 'n1', kind: 'note', title: 'Private note', text: 'SECRET salary negotiation notes', note: '', source: null, image: null, folder: null };
  const profile = { external: false };
  const host = {
    privateWindow: false, alive: () => true, language: () => 'en', changed() {},
    page: () => { throw new Error('LYRA_PAGE_UNAVAILABLE'); }, decision: () => 'ask', external: () => false, allow() {},
    desktopExternal: () => profile.external, allowDesktop() { profile.external = true; },
    project: () => ({ id: 'p1', name: 'Shared research', items: [note] }), item: () => note, save() {}, connect: service.connect,
  };
  const lyra = createLyra(host);
  const ask = (task = 'item', question = 'Summarise this saved item and its notes.') => lyra.run({ type: 'lyra-ask', task, question, tabs: [], project: task === 'project' ? 'p1' : null, item: task === 'item' ? 'n1' : null });
  return { lyra, ask, profile, close: () => lyra.stop() };
}
const answered = (start = START.cli) => () => [start, { type: 'text', text: 'Answer.' }, { type: 'done' }];
// The first turn loses its connection after the start event; every later one answers.
const losingFirst = () => {
  let lose = true;
  return (_payload, response, protocol2) => {
    if (lose) { lose = false; response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.write(JSON.stringify(START.old) + '\n'); setTimeout(() => response.destroy(), 20); return; }
    return [protocol2 ? START.cli : START.old, { type: 'text', text: 'Answer.' }, { type: 'done' }];
  };
};

test('R1: a saved item or project reaches an external source only after its own notice, and No keeps it on this computer', async t => {
  const service = await fakeLyra(t, { sources: only({ claude: 'claude-sonnet-4-5' }), turn: answered() });
  const fixture = desktopHost(service); t.after(fixture.close);
  await fixture.ask(); const asked = await settled(fixture.lyra, 'permission');
  assert.deepEqual([asked.permission.origin, asked.route, service.chats().length], [null, 'any', 0], 'Nothing is sent before the notice is answered');
  const notice = nodes(component('src/Lyra.tsx').LyraNotice({ permission: asked.permission, route: asked.route, language: 'en', onAnswer() {} }));
  assert.ok(words(notice).includes(copy.lyraDesktopNotice.en)); assert.match(copy.lyraDesktopNotice.en, /may leave this computer/);
  assert.deepEqual(notice.filter(node => node.type === 'button').map(words), [copy.lyraAllowProfile.en, copy.lyraAllowOnce.en, copy.lyraKeepLocal.en]);
  for (const language of ['en', 'es']) for (const key of ['lyraDesktopQuestion', 'lyraDesktopNotice', 'lyraAllowProfile', 'lyraKeepLocal', 'LYRA_ROUTE_CHANGED', 'LYRA_NOTICE_REQUIRED']) assert.ok(copy[key][language].trim(), `${key} ${language}`);
  // Only on this computer: the turn is sent without cloud.
  await fixture.lyra.run({ type: 'lyra-permission', id: asked.permission.id, answer: 'deny' }); await settled(fixture.lyra, 'answer');
  assert.equal(Object.hasOwn(service.chats()[0].payload, 'cloud'), false); assert.ok(service.chats()[0].payload.context.includes('SECRET'));
  // Just this once covers this turn only; the next one asks again.
  await fixture.ask(); const once = await settled(fixture.lyra, 'permission');
  await fixture.lyra.run({ type: 'lyra-permission', id: once.permission.id, answer: 'once' }); await settled(fixture.lyra, 'answer');
  assert.equal(service.chats()[1].payload.cloud, true);
  await fixture.ask(); const always = await settled(fixture.lyra, 'permission');
  assert.equal(service.chats().length, 2);
  await fixture.lyra.run({ type: 'lyra-permission', id: always.permission.id, answer: 'site' }); await settled(fixture.lyra, 'answer');
  assert.equal(fixture.profile.external, true); assert.equal(service.chats()[2].payload.cloud, true);
  // Always for this profile covers later items and projects without asking again.
  await fixture.ask('project', 'What did I save?'); await settled(fixture.lyra, 'answer');
  assert.equal(service.chats()[3].payload.cloud, true);
  // With no external source ready there is nothing to tell: the turn is sent without cloud and without asking.
  const local = await fakeLyra(t, { turn: answered(START.local) }), quiet = desktopHost(local); t.after(quiet.close);
  await quiet.ask(); await settled(quiet.lyra, 'answer'); assert.equal(Object.hasOwn(local.chats()[0].payload, 'cloud'), false);
  // The panel line says what is asked may leave this computer.
  for (const language of ['en', 'es']) assert.match(copy.lyraRoutes[language], language === 'en' ? /may leave this computer/ : /puede salir de esta computadora/);
});

test('R1: the profile answer to the saved items notice is kept in its own local file and reads as not given when missing or malformed', t => {
  const path = join(temporary(t), 'lyra-desktop.json'), notice = desktopNotice(path);
  assert.equal(notice.external(), false);
  writeFileSync(path, '{"version":1,"external":"yes"}'); assert.equal(notice.external(), false);
  writeFileSync(path, 'not json'); assert.equal(notice.external(), false);
  notice.allow(); assert.equal(notice.external(), true); assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, external: true });
  // It lives outside the synced store, so no sync record can carry it.
  assert.equal(Object.hasOwn(emptySyncStore(), 'lyraDesktop'), false);
});

test('R2: a retry of a turn shown as local stops on a notice before external sources may answer', async t => {
  const service = await fakeLyra(t, { protocol: 1, turn: losingFirst() });
  const fixture = desktopHost(service); t.after(fixture.close);
  await fixture.lyra.run({ type: 'lyra-open' }); assert.equal((await settled(fixture.lyra, 'home')).route, 'local');
  await fixture.ask('project', 'What did I save?'); assert.equal((await settled(fixture.lyra, 'failed')).route, 'local');
  service.state.protocol = 2; service.state.sources = only({ claude: 'claude-sonnet-4-5' }); service.restart();
  await fixture.lyra.run({ type: 'lyra-retry' }); const asked = await settled(fixture.lyra, 'permission');
  assert.deepEqual([asked.permission.origin, asked.route, service.chats().length], [null, 'any', 1]);
  await fixture.lyra.run({ type: 'lyra-permission', id: asked.permission.id, answer: 'once' }); await settled(fixture.lyra, 'answer');
  assert.equal(service.chats()[1].payload.cloud, true);
  // A question with no page or item stops on the route line, which now says what is asked may leave; the next retry is taken under it.
  const plain = await fakeLyra(t, { protocol: 1, turn: losingFirst() });
  const question = desktopHost(plain); t.after(question.close);
  await question.lyra.run({ type: 'lyra-open' }); await settled(question.lyra, 'home');
  await question.lyra.run({ type: 'lyra-ask', task: 'question', question: 'What is my salary?', tabs: [], project: null, item: null }); await settled(question.lyra, 'failed');
  plain.state.protocol = 2; plain.state.sources = only({ claude: 'claude-sonnet-4-5' }); plain.restart();
  await question.lyra.run({ type: 'lyra-retry' }); const stopped = await settled(question.lyra, 'failed');
  assert.deepEqual([stopped.error, stopped.route, plain.chats().length], ['LYRA_ROUTE_CHANGED', 'any', 1]);
  assert.equal(component('src/Lyra.tsx').lyraRouteText(stopped, 'en'), copy.lyraRoutes.en);
  await question.lyra.run({ type: 'lyra-retry' }); await settled(question.lyra, 'answer');
  assert.equal(plain.chats()[1].payload.cloud, true);
});

test('R3: opening translation never sends the page to identify its language remotely', async t => {
  const service = await fakeLyra(t, { sources: only({ claude: 'claude-sonnet-4-5' }), turn: (payload, _response, protocol2) => translated(payload, protocol2, START.cli) });
  const fixture = translation(service, { lang: '' }); t.after(fixture.close);
  fixture.translation.run({ type: 'translate-open' }); const offered = await phase(fixture, 'offered');
  assert.deepEqual([offered.source, offered.external, service.chats().length], [null, true, 0], 'No sample leaves this computer');
  assert.equal(bar(offered).status, `${copy.originalLanguageUnknown.en}. ${copy.translateExternal.en}`);
  // Translating it is the person's click under that line, with the source language left to the model.
  fixture.translation.run({ type: 'translate-start' }); assert.equal((await phase(fixture, 'translated')).phase, 'translated');
  assert.ok(service.chats().length > 0 && service.chats().every(chat => chat.payload.cloud === true && !JSON.parse(chat.payload.context).data.sample));
  assert.match(service.chats()[0].payload.messages[0].content, /from the language it is written in/);
  assert.equal(bar(fixture.translation.state()).status, copy.translatedAuto.en);
  // With a local source ready the language is identified on this computer, without cloud.
  const local = await fakeLyra(t, { sources: only({ local: 'lyra-base', claude: 'claude-sonnet-4-5' }), turn: (payload, _response, protocol2) => translated(payload, protocol2) });
  const known = translation(local, { lang: '' }); t.after(known.close);
  known.translation.run({ type: 'translate-open' }); assert.equal((await phase(known, 'offered')).source, 'fr');
  assert.equal(local.chats().length, 1); assert.equal(Object.hasOwn(local.chats()[0].payload, 'cloud'), false);
});

test('R4: a target language change is taken under the external line in the options menu, or stays local without it', async t => {
  const service = await fakeLyra(t, { sources: only({ local: 'lyra-base', claude: 'claude-sonnet-4-5' }), turn: (payload, _response, protocol2) => translated(payload, protocol2, payload.cloud ? START.cli : START.local) });
  const fixture = translation(service, { always: 'en' }); t.after(fixture.close);
  fixture.translation.probe(); const done = await phase(fixture, 'translated');
  assert.ok(service.chats().every(chat => !Object.hasOwn(chat.payload, 'cloud')));
  assert.ok(menu(done).includes(copy.translateExternal.en), 'The menu says the text may leave where the target is chosen');
  const before = service.chats().length;
  fixture.translation.run({ type: 'translate-target', value: 'es' });
  await until(() => fixture.translation.state(), state => state.phase === 'translated' && service.chats().length > before || state.phase === 'failed', 'the new target');
  assert.ok(service.chats().slice(before).every(chat => chat.payload.cloud === true));
  // After a local run with no external source the menu has no line, and a change made there stays on this computer.
  const local = await fakeLyra(t, { turn: (payload, _response, protocol2) => translated(payload, protocol2) });
  const quiet = translation(local, { always: 'en' }); t.after(quiet.close);
  quiet.translation.probe(); const unseen = await phase(quiet, 'translated');
  assert.equal(unseen.external, false); assert.equal(menu(unseen).includes(copy.translateExternal.en), false);
  local.state.sources = only({ local: 'lyra-base', claude: 'claude-sonnet-4-5' });
  const count = local.chats().length;
  quiet.translation.run({ type: 'translate-target', value: 'es' });
  await until(() => quiet.translation.state(), state => state.phase === 'translated' && local.chats().length > count || state.phase === 'failed', 'the local target');
  assert.equal(quiet.translation.state().phase, 'translated');
  assert.ok(local.chats().slice(count).every(chat => !Object.hasOwn(chat.payload, 'cloud')));
});

test('R5: an offer drawn without the external line stops at the click, shows the line and waits for a second click', async t => {
  const service = await fakeLyra(t, { turn: (payload, _response, protocol2) => translated(payload, protocol2, payload.cloud ? START.cli : START.local) });
  const fixture = translation(service, { always: 'en' }); t.after(fixture.close);
  fixture.translation.probe(); await phase(fixture, 'translated');
  fixture.translation.run({ type: 'translate-original' }); const original = await phase(fixture, 'original');
  assert.equal(original.external, false); assert.equal(bar(original).status.includes(copy.translateExternal.en), false);
  service.state.sources = only({ local: 'lyra-base', claude: 'claude-sonnet-4-5' });
  const before = service.chats().length;
  fixture.translation.run({ type: 'translate-start' });
  const stopped = await until(() => fixture.translation.state(), state => state.phase === 'offered' || state.phase === 'failed', 'the offer');
  assert.deepEqual([stopped.phase, stopped.external, service.chats().length], ['offered', true, before]);
  assert.ok(bar(stopped).status.endsWith(copy.translateExternal.en));
  assert.equal(fixture.entries[0].nodeValue, 'Bonjour tout le monde.', 'The page is left as it was');
  fixture.translation.run({ type: 'translate-start' }); await phase(fixture, 'translated');
  assert.ok(service.chats().length > before && service.chats().slice(before).every(chat => chat.payload.cloud === true));
});

test('the gate: no request with cloud: true is sent unless the matching notice was recorded first, at every entry point', async t => {
  // The gate itself: a request with cloud: true and no recorded notice never reaches the client.
  const calls = [], client = { chat: request => { calls.push(request); return []; } }, signal = new AbortController().signal;
  assert.throws(() => lyraChat(client, { mode: 'fast', messages: [], cloud: true }, false, { signal }), /LYRA_NOTICE_REQUIRED/);
  assert.equal(calls.length, 0);
  lyraChat(client, { mode: 'fast', messages: [] }, false, { signal }); lyraChat(client, { mode: 'fast', messages: [], cloud: true }, true, { signal });
  assert.deepEqual(calls.map(request => request.cloud), [undefined, true]);
  const external = () => fakeLyra(t, { sources: only({ claude: 'claude-sonnet-4-5' }), turn: answered() });
  // lyra-ask on a page allowed under the local notice: the page notice comes first.
  const pageService = await external(), page = assistant(pageService); t.after(page.close); page.add('page', 'https://bank.example/statement', 'local');
  await page.ask(); assert.equal((await settled(page.lyra, 'permission')).route, 'any'); assert.equal(pageService.chats().length, 0);
  // lyra-ask with a question asked under the local line: sent without cloud.
  const lineService = await fakeLyra(t, { protocol: 1, turn: answered(START.old) }), line = desktopHost(lineService); t.after(line.close);
  await line.lyra.run({ type: 'lyra-open' }); await settled(line.lyra, 'home');
  lineService.state.protocol = 2; lineService.state.sources = only({ local: 'lyra-base', claude: 'claude-sonnet-4-5' }); lineService.restart();
  await line.lyra.run({ type: 'lyra-ask', task: 'question', question: 'What is new?', tabs: [], project: null, item: null }); await settled(line.lyra, 'answer');
  assert.equal(Object.hasOwn(lineService.chats()[0].payload, 'cloud'), false);
  // lyra-ask on an item and lyra-permission answered Only on this computer: no cloud.
  const itemService = await external(), item = desktopHost(itemService); t.after(item.close);
  await item.ask(); const asked = await settled(item.lyra, 'permission'); assert.equal(itemService.chats().length, 0);
  await item.lyra.run({ type: 'lyra-permission', id: asked.permission.id, answer: 'deny' }); await settled(item.lyra, 'answer');
  assert.equal(Object.hasOwn(itemService.chats()[0].payload, 'cloud'), false);
  // translate-retry of a failed manual run, whose bar shows no line: it stops on the offer before anything is sent.
  let lose = true;
  const retryService = await fakeLyra(t, { sources: only({ claude: 'claude-sonnet-4-5' }), turn: (payload, response, protocol2) => {
    if (lose) { lose = false; response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.write(JSON.stringify(START.cli) + '\n'); setTimeout(() => response.destroy(), 20); return; }
    return translated(payload, protocol2, START.cli);
  } });
  const retried = translation(retryService); t.after(retried.close);
  retried.translation.run({ type: 'translate-open' }); await phase(retried, 'offered');
  retried.translation.run({ type: 'translate-start' }); assert.equal((await phase(retried, 'translated')).error, 'service_lost');
  const sent = retryService.chats().length;
  retried.translation.run({ type: 'translate-retry' });
  const offer = await until(() => retried.translation.state(), state => state.phase === 'offered' || state.phase === 'translated', 'the offer after the retry');
  assert.equal(offer.phase, 'offered'); assert.equal(retryService.chats().length, sent);
  // probe, translate-open, translate-start and translate-target are covered by the automatic test and R3 to R5 above.
});

// ------------------------------------------------------------------ review 036c
// Every visible word of the Lyra panel drawn for one state.
function panelWords(lyra) {
  const tree = component('src/Lyra.tsx').LyraPanel({ state: { lyra, tabs: [], activeId: '', projects: [], projectInUse: null }, language: 'en', onClose() {}, onDesktop() {} });
  return words(nodes(tree).filter(node => typeof node.type === 'string'));
}

test('036c-1: the route line counts only where the panel draws it, and a question asked while it was hidden stops before anything leaves', async t => {
  // Lyra is not installed at first; once it is, only Claude Code is ready.
  let installed = false;
  const service = await fakeLyra(t, { sources: only({ claude: 'claude-sonnet-4-5' }), turn: answered() });
  const connect = async () => { if (!installed) throw { code: 'not_installed' }; return service.connect(); };
  const fixture = assistant({ connect }); t.after(fixture.close); fixture.add('page', 'https://notes.example/release');
  await fixture.lyra.run({ type: 'lyra-open' }); const missing = await settled(fixture.lyra, 'failed');
  assert.equal(missing.error, 'not_installed'); assert.equal(panelWords(missing).includes(copy.lyraRoutes.en), false);
  // A question typed in the panel that hid the line stops with the line on screen; nothing is read or sent.
  installed = true;
  await fixture.lyra.run({ type: 'lyra-ask', task: 'question', question: 'My private question', tabs: ['page'], project: null, item: null });
  const stopped = await settled(fixture.lyra, 'failed');
  assert.deepEqual([stopped.error, service.chats().length, fixture.reads.length], ['LYRA_ROUTE_UNSEEN', 0, 0]);
  assert.ok(panelWords(stopped).includes(copy.lyraRoutes.en));
  for (const language of ['en', 'es']) assert.ok(copy.LYRA_ROUTE_UNSEEN[language].trim());
  await fixture.lyra.run({ type: 'lyra-retry' }); await settled(fixture.lyra, 'answer');
  assert.equal(service.chats()[0].payload.cloud, true);
  // The automatic retry after installing Lyra is held to the same rule.
  installed = false;
  const auto = assistant({ connect }); t.after(auto.close); auto.add('page', 'https://notes.example/release');
  await auto.ask(); assert.equal((await settled(auto.lyra, 'failed')).error, 'not_installed');
  installed = true; const before = service.chats().length;
  await auto.lyra.run({ type: 'lyra-retry' });
  assert.deepEqual([(await settled(auto.lyra, 'failed')).error, service.chats().length], ['LYRA_ROUTE_UNSEEN', before]);
  // Failures where asking can reach external sources keep the line on screen, so a question asked there counts as noticed.
  for (const error of ['no_source', 'unavailable', 'model_missing', 'service_lost']) assert.ok(panelWords({ ...stopped, error, route: 'any' }).includes(copy.lyraRoutes.en), error);
  const empty = await fakeLyra(t, { sources: quiet(), turn: answered() });
  const none = assistant(empty); t.after(none.close); none.add('page', 'https://notes.example/release');
  await none.lyra.run({ type: 'lyra-open' }); assert.equal((await settled(none.lyra, 'failed')).error, 'no_source');
  empty.state.sources = only({ claude: 'claude-sonnet-4-5' });
  await none.ask(); await settled(none.lyra, 'answer'); assert.equal(empty.chats()[0].payload.cloud, true);
});

test('036c-3: an item a Space member shared is asked each time and never covered by the profile answer', async t => {
  const service = await fakeLyra(t, { sources: only({ claude: 'claude-sonnet-4-5' }), turn: answered() });
  const fixture = desktopHost(service); t.after(fixture.close); fixture.profile.external = true;
  const shared = `shared:${'a'.repeat(64)}`;
  const ask = () => fixture.lyra.run({ type: 'lyra-ask', task: 'item', question: 'Summarise this shared item.', tabs: [], project: null, item: shared });
  await ask(); const asked = await settled(fixture.lyra, 'permission');
  assert.deepEqual([asked.permission.origin, asked.permission.shared, service.chats().length], [null, true, 0]);
  const notice = nodes(component('src/Lyra.tsx').LyraNotice({ permission: asked.permission, route: asked.route, language: 'en', onAnswer() {} }));
  assert.ok(words(notice).includes(copy.lyraSharedNotice.en));
  assert.deepEqual(notice.filter(node => node.type === 'button').map(words), [copy.lyraAllowOnce.en, copy.lyraKeepLocal.en]);
  for (const language of ['en', 'es']) assert.ok(copy.lyraSharedNotice[language].trim());
  // A forged lasting answer is refused and leaves the notice waiting.
  await assert.rejects(fixture.lyra.run({ type: 'lyra-permission', id: asked.permission.id, answer: 'site' }), /LYRA_INVALID/);
  assert.equal(fixture.lyra.state().phase, 'permission');
  await fixture.lyra.run({ type: 'lyra-permission', id: asked.permission.id, answer: 'once' }); await settled(fixture.lyra, 'answer');
  assert.equal(service.chats()[0].payload.cloud, true);
  await ask(); assert.equal((await settled(fixture.lyra, 'permission')).permission.shared, true); assert.equal(service.chats().length, 1);
  // The person's own items stay covered by the profile answer.
  await fixture.lyra.run({ type: 'lyra-cancel' });
  await fixture.ask(); await settled(fixture.lyra, 'answer'); assert.equal(service.chats()[1].payload.cloud, true);
});

test('036c-4: a retry after an upgrade with only a local source ready is sent without cloud', async t => {
  let fail = true;
  const service = await fakeLyra(t, { protocol: 1, turn: (_payload, _response, protocol2) => {
    if (fail) { fail = false; return [{ type: 'error', code: 'busy' }]; }
    return [protocol2 ? START.local : START.old, { type: 'text', text: 'Answer.' }, { type: 'done' }];
  } });
  const fixture = assistant(service); t.after(fixture.close);
  await fixture.lyra.run({ type: 'lyra-open' }); assert.equal((await settled(fixture.lyra, 'home')).route, 'local');
  await fixture.lyra.run({ type: 'lyra-ask', task: 'question', question: 'What is new?', tabs: [], project: null, item: null }); await settled(fixture.lyra, 'failed');
  service.state.protocol = 2; service.state.sources = only({ local: 'lyra-base' }); service.restart();
  await fixture.lyra.run({ type: 'lyra-retry' }); await settled(fixture.lyra, 'answer');
  assert.equal(Object.hasOwn(service.chats()[1].payload, 'cloud'), false);
});

test('036c-2: the profile answer to the saved items notice can be withdrawn', t => {
  const path = join(temporary(t), 'lyra-desktop.json'), notice = desktopNotice(path);
  notice.allow(); assert.equal(notice.external(), true);
  notice.clear(); assert.equal(notice.external(), false);
  notice.clear(); assert.equal(notice.external(), false);
  for (const language of ['en', 'es']) for (const key of ['lyraDesktopSetting', 'lyraDesktopAllowed', 'lyraDesktopAsk', 'lyraDesktopReset']) assert.ok(copy[key][language].trim(), `${key} ${language}`);
});

test('036c-5: an error in the translation bar keeps the external line the next click is taken under', () => {
  const offered = { open: true, phase: 'offered', source: 'fr', target: 'en', error: null, external: true, answeredBy: null };
  const error = 'Lyra is not available.', failing = { useState: value => [typeof value === 'string' ? error : value, () => {}] };
  assert.equal(bar(offered, failing).status, `${error} ${copy.translateExternal.en}`);
  // Without the line there is nothing to keep: the error alone.
  assert.equal(bar({ ...offered, external: false }, failing).status, error);
});
