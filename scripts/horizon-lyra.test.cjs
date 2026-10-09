const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { resolve, join } = require('node:path');

const library = () => import('horizon-lyra');
const app = { id: 'horizon', name: 'Horizon', kind: 'cosmic' };
const serviceVersion = '1.2.3';
const stale = 'S'.repeat(43), fresh = 'F'.repeat(43), bootstrap = 'B'.repeat(43);

function temporary(t) {
  const root = resolve('.runtime'); mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, 'horizon-lyra-test-')); t.after(() => rmSync(folder, { recursive: true, force: true })); return folder;
}
function memoryTokens(initial) {
  let token = initial; const writes = [];
  return { writes, async get() { return token; }, async set(value) { token = value; writes.push(value); } };
}
function body(request) {
  return new Promise(done => { const parts = []; request.on('data', part => parts.push(part)); request.on('end', () => done(Buffer.concat(parts).toString('utf8'))); });
}
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
async function fakeService(t, route, { announce = true } = {}) {
  const home = temporary(t), hits = [];
  const server = createServer(async (request, response) => {
    hits.push(`${request.method} ${request.url}`);
    if (request.url === '/v1/health') return json(response, 200, { ok: true, serviceVersion });
    const text = await body(request);
    await route(request, response, text ? JSON.parse(text) : undefined, hits);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const port = server.address().port;
  mkdirSync(join(home, 'run'), { recursive: true }); mkdirSync(join(home, 'secrets'), { recursive: true });
  if (announce) writeFileSync(join(home, 'run', 'service.json'), JSON.stringify({ version: 1, pid: process.pid, port, serviceVersion, startedAt: new Date().toISOString() }));
  writeFileSync(join(home, 'secrets', 'bootstrap.key'), bootstrap);
  return { home, port, hits };
}
async function drain(iterable) { const seen = []; for await (const event of iterable) seen.push(event); return seen; }
const chatRequest = { mode: 'fast', messages: [{ role: 'user', content: 'Hello' }] };
const streamOf = lines => (request, response) => { response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.end(lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n'); };

test('Lyra client reports a missing install and never trusts a malformed service file', async t => {
  const { connect } = await library();
  const service = await fakeService(t, (request, response) => json(response, 200, { ok: true }), { announce: false });
  await assert.rejects(connect({ app, tokens: memoryTokens(), home: service.home }), { code: 'not_installed' });
  const file = join(service.home, 'run', 'service.json');
  const good = { version: 1, pid: 1, port: service.port, serviceVersion, startedAt: 1 };
  for (const bad of [{ ...good, version: 2 }, { ...good, port: 80 }, { ...good, port: String(service.port) }, { ...good, pid: 0 }, { ...good, serviceVersion: '' }, { ...good, startedAt: null }, [good], 'not json', '']) {
    writeFileSync(file, typeof bad === 'string' ? bad : JSON.stringify(bad));
    await assert.rejects(connect({ app, tokens: memoryTokens(), home: service.home }), { code: 'not_installed' }, JSON.stringify(bad));
  }
  assert.deepEqual(service.hits, [], 'A rejected service file must never receive a request');
  writeFileSync(file, JSON.stringify({ ...good, serviceVersion: 'other' }));
  await assert.rejects(connect({ app, tokens: memoryTokens(), home: service.home }), { code: 'not_installed' });
  assert.deepEqual(service.hits, ['GET /v1/health'], 'A health answer with another version is not the announced service');
  writeFileSync(file, JSON.stringify(good));
  await connect({ app, tokens: memoryTokens(), home: service.home });
});

test('Lyra client starts the installed service with a minimal environment', async t => {
  const { connect } = await library();
  const home = temporary(t), script = join(home, 'service.cjs'), report = join(home, 'environment.json');
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(script, `
const { createServer } = require('node:http'), { writeFileSync } = require('node:fs'), { join } = require('node:path');
const home = process.argv[2];
const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, serviceVersion: '9.9.9' })); });
server.listen(0, '127.0.0.1', () => {
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ home: process.env.LYRA_HOME, probe: process.env.HORIZON_LYRA_TEST_SECRET ?? null }));
  writeFileSync(join(home, 'run', 'service.json'), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, serviceVersion: '9.9.9', startedAt: 1 }));
});
setTimeout(() => process.exit(0), 20000);
`);
  process.env.HORIZON_LYRA_TEST_SECRET = 'must-not-reach-the-service'; t.after(() => { delete process.env.HORIZON_LYRA_TEST_SECRET; });
  writeFileSync(join(home, 'install.json'), JSON.stringify({ version: 1, command: process.execPath, args: [script, home] }));
  await connect({ app, tokens: memoryTokens(), home, startTimeoutMs: 10000 });
  assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), { home, probe: null });
  writeFileSync(join(home, 'install.json'), JSON.stringify({ version: 1, command: 'relative/service', args: [] }));
  rmSync(join(home, 'run', 'service.json'));
  await assert.rejects(connect({ app, tokens: memoryTokens(), home }), { code: 'invalid_install' });
});

test('Lyra client registers once, keeps the token and retries a single 401', async t => {
  const { connect } = await library();
  const seen = { register: [], status: [] };
  const service = await fakeService(t, (request, response, payload) => {
    if (request.url === '/v1/apps/register') { seen.register.push([request.headers.authorization, payload]); return json(response, 200, { app: { id: 'horizon' }, token: fresh }); }
    seen.status.push(request.headers.authorization);
    if (request.headers.authorization !== `Bearer ${fresh}`) return json(response, 401, { error: { code: 'unauthorized', message: 'No' } });
    json(response, 200, { ready: true, ollama: { installed: true, running: false }, modes: { fast: { ready: true }, deep: { ready: false } } });
  });
  const tokens = memoryTokens(stale), client = await connect({ app, tokens, home: service.home });
  assert.deepEqual(await client.models.status(), { ready: true, ollama: { installed: true, running: false }, modes: { fast: { ready: true }, deep: { ready: false } } });
  assert.deepEqual(seen.register, [[`Bootstrap ${bootstrap}`, app]]);
  assert.deepEqual(seen.status, [`Bearer ${stale}`, `Bearer ${fresh}`]);
  assert.deepEqual(tokens.writes, [fresh]);
  await client.models.status();
  assert.equal(seen.register.length, 1, 'The stored token is reused');
  // With no stored token the first call registers; a token the service keeps refusing gets exactly one more registration, then the error surfaces.
  seen.register.length = 0; seen.status.length = 0;
  const refused = await fakeService(t, (request, response) => {
    if (request.url === '/v1/apps/register') { seen.register.push(1); return json(response, 200, { app: {}, token: fresh }); }
    seen.status.push(1); json(response, 401, { error: { code: 'revoked', message: 'Revoked' } });
  });
  await assert.rejects(connect({ app, tokens: memoryTokens(), home: refused.home }).then(client => client.models.status()), { code: 'revoked', status: 401 });
  assert.deepEqual([seen.register.length, seen.status.length], [2, 2]);
  // Without a token the first call registers and a refused registration reports the service's code.
  const closed = await fakeService(t, (request, response) => json(response, 403, { error: { code: 'forbidden', message: 'No' } }));
  await assert.rejects(connect({ app, tokens: memoryTokens(), home: closed.home }).then(client => client.models.status()), { code: 'forbidden' });
});

test('Lyra client sends chat, install and Ollama requests as the routes expect', async t => {
  const { connect } = await library();
  const requests = [];
  const service = await fakeService(t, (request, response, payload) => {
    requests.push({ url: request.url, auth: request.headers.authorization, language: request.headers['accept-language'], payload });
    if (request.url === '/v1/chat') return streamOf([{ type: 'start', mode: 'fast', model: 'tiny', fellBack: false }, { type: 'thinking' }, { type: 'text', text: 'Hi' }, { type: 'done' }, { type: 'text', text: 'after done' }])(request, response);
    if (request.url === '/v1/models/install') return streamOf([{ type: 'step', name: 'pull', status: 'running', completed: 1, total: 4 }, { type: 'error', code: 'disk_full' }])(request, response);
    if (request.url === '/v1/ollama/start') return json(response, 200, { running: true, version: '0.9.0' });
    json(response, 404, { error: { code: 'not_found', message: 'No' } });
  });
  const client = await connect({ app, tokens: memoryTokens(fresh), home: service.home });
  assert.deepEqual(await drain(client.chat({ ...chatRequest, priority: 'interactive', context: 'ctx', language: 'es' })), [
    { type: 'start', mode: 'fast', model: 'tiny', fellBack: false }, { type: 'thinking' }, { type: 'text', text: 'Hi' }, { type: 'done' }]);
  assert.deepEqual(await drain(client.models.install('light')), [{ type: 'step', name: 'pull', status: 'running', completed: 1, total: 4 }, { type: 'error', code: 'disk_full' }]);
  assert.deepEqual(await client.ollama.start(), { running: true, version: '0.9.0' });
  assert.deepEqual(requests.map(entry => [entry.url, entry.auth, entry.payload]), [
    ['/v1/chat', `Bearer ${fresh}`, { ...chatRequest, priority: 'interactive', context: 'ctx', language: 'es' }],
    ['/v1/models/install', `Bearer ${fresh}`, { plan: 'light', confirm: true }],
    ['/v1/ollama/start', `Bearer ${fresh}`, {}],
  ]);
  assert.equal(requests[0].language, 'es');
  assert.equal(requests[1].language, 'en');
  await assert.rejects(drain(client.chat({ mode: 'fast', messages: [] })), { code: 'invalid_request' });
});

test('Lyra client aborts a chat stream through the caller signal', async t => {
  const { connect } = await library();
  let closed;
  const service = await fakeService(t, (request, response) => {
    closed = new Promise(done => response.on('close', done));
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.write(JSON.stringify({ type: 'thinking' }) + '\n');
  });
  const client = await connect({ app, tokens: memoryTokens(fresh), home: service.home }), controller = new AbortController();
  const seen = [];
  await assert.rejects((async () => { for await (const event of client.chat(chatRequest, { signal: controller.signal })) { seen.push(event); controller.abort(); } })(), { code: 'cancelled' });
  assert.deepEqual(seen, [{ type: 'thinking' }]);
  await closed;
});

test('Lyra client caps every NDJSON line and the whole stream', async t => {
  const { connect } = await library();
  const text = size => JSON.stringify({ type: 'text', text: 'a'.repeat(size) });
  const service = await fakeService(t, async (request, response, payload) => {
    if (payload.context === 'line') return streamOf([{ type: 'thinking' }, text(64 * 1024)])(request, response);
    if (payload.context === 'edge') return streamOf([text(64 * 1024 - 64), { type: 'done' }])(request, response);
    // 300 valid lines of about 60 KB pass the line cap but exceed 16 MB together.
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const line = text(60 * 1024) + '\n';
    for (let index = 0; index < 300; index++) { if (!response.write(line)) await new Promise(done => response.once('drain', done)); if (response.destroyed) return; }
    response.end();
  });
  const client = await connect({ app, tokens: memoryTokens(fresh), home: service.home });
  const received = [];
  await assert.rejects((async () => { for await (const event of client.chat({ ...chatRequest, context: 'line' })) received.push(event.type); })(), { code: 'line_too_large' });
  assert.deepEqual(received, ['thinking'], 'Lines before the oversized one are still delivered');
  assert.equal((await drain(client.chat({ ...chatRequest, context: 'edge' }))).length, 2);
  let count = 0;
  await assert.rejects((async () => { for await (const event of client.chat({ ...chatRequest, context: 'stream' })) count += event.type === 'text' ? 1 : 0; })(), { code: 'stream_too_large' });
  assert.ok(count > 200 && count < 300, `The stream stopped at the cap, not at its end (${count} lines)`);
});

test('Lyra client rejects unknown event shapes and oversized or malformed JSON answers', async t => {
  const { connect } = await library();
  const bad = [
    [{ type: 'mystery' }], [{ type: 'text', text: 5 }], [{ type: 'text' }], [{ type: 'start', mode: 'fast', model: 'x' }], [{ type: 'error', code: 'has space' }], [{ type: 'error' }],
    ['not json'], ['[1,2]'], ['null'], [{ nope: true }],
  ];
  const service = await fakeService(t, (request, response, payload) => {
    if (request.url === '/v1/chat') return streamOf(bad[Number(payload.context)])(request, response);
    if (request.url === '/v1/models/install') return streamOf([{ type: 'step', name: 'pull', status: 'running', completed: -1, total: 4 }])(request, response);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/v1/models') return response.end(JSON.stringify({ ready: true, padding: 'x'.repeat(1024 * 1024 + 1), ollama: { installed: true, running: true }, modes: { fast: { ready: true } } }));
    response.end('{"running":true,');
  });
  const client = await connect({ app, tokens: memoryTokens(fresh), home: service.home });
  for (const [index, events] of bad.entries()) {
    await assert.rejects(drain(client.chat({ ...chatRequest, context: String(index) })), { code: 'invalid_response' }, JSON.stringify(events));
  }
  await assert.rejects(drain(client.models.install('light')), { code: 'invalid_response' });
  await assert.rejects(client.models.status(), { code: 'response_too_large' });
  await assert.rejects(client.ollama.start(), { code: 'invalid_response' });
  const shapes = await fakeService(t, (request, response) => json(response, 200, { ready: true, ollama: { installed: true, running: true }, modes: { slow: { ready: true } } }));
  await assert.rejects((await connect({ app, tokens: memoryTokens(fresh), home: shapes.home })).models.status(), { code: 'invalid_response' });
});
