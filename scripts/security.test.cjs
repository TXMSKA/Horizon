const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { validateSender, secureSession, CONTENT_SECURITY_POLICY } = require('../dist/electron/security.js');
const { serveHorizon } = require('../dist/electron/protocol.js');

test('IPC authorizes only the exact top-level Horizon frame', () => {
  const frame = { url: 'horizon://app/' };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  const event = { sender: contents, senderFrame: frame };
  validateSender(event, contents);
  for (const url of ['https://app/', 'file:///app/', 'horizon://app.evil/', 'horizon://user@app/', 'horizon://app:443/', 'horizon://app/other', 'horizon://app/?x=1', 'horizon://app/#x']) {
    frame.url = url;
    assert.throws(() => validateSender(event, contents));
  }
  frame.url = 'horizon://app/';
  assert.throws(() => validateSender({ ...event, sender: {} }, contents));
  assert.throws(() => validateSender({ ...event, senderFrame: { url: frame.url } }, contents));
  assert.throws(() => validateSender({ ...event, senderFrame: null }, contents));
  contents.isDestroyed = () => true;
  assert.throws(() => validateSender(event, contents));
});

test('session rejects requests, checks, devices, downloads, and network traffic', () => {
  const handlers = {};
  const target = {
    setPermissionRequestHandler: fn => { handlers.request = fn; },
    setPermissionCheckHandler: fn => { handlers.check = fn; },
    setDevicePermissionHandler: fn => { handlers.device = fn; },
    on: (_name, fn) => { handlers.download = fn; },
    webRequest: { onBeforeRequest: fn => { handlers.network = fn; } },
  };
  secureSession(target);
  handlers.request(null, 'geolocation', allowed => assert.equal(allowed, false));
  assert.equal(handlers.check(), false);
  assert.equal(handlers.device(), false);
  let prevented = false;
  handlers.download({ preventDefault() { prevented = true; } });
  assert.ok(prevented);
  for (const url of ['https://example.com/', 'http://example.com/', 'file:///test', 'data:text/html,test']) {
    handlers.network({ url }, result => assert.equal(result.cancel, true));
  }
  handlers.network({ url: 'horizon://app/' }, result => assert.equal(result.cancel, false));
});

test('custom protocol enforces its host, method, asset types, paths, and CSP', async (t) => {
  mkdirSync('.runtime', { recursive: true });
  const parent = mkdtempSync(resolve('.runtime/protocol-'));
  t.after(() => {
    assert.ok(parent.startsWith(resolve('.runtime') + require('node:path').sep));
    rmSync(parent, { recursive: true, force: true });
  });
  const root = join(parent, 'renderer');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<html></html>');
  writeFileSync(join(root, 'app.js'), 'export {};');
  writeFileSync(join(root, 'private.json'), '{}');
  writeFileSync(join(parent, 'outside.js'), 'private');
  mkdirSync(join(parent, 'secrets'));
  writeFileSync(join(parent, 'secrets/private.js'), 'private');
  symlinkSync(join(parent, 'secrets'), join(root, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  let handler;
  await serveHorizon({ handle(scheme, fn) { assert.equal(scheme, 'horizon'); handler = fn; } }, root);
  const request = (url, method = 'GET') => handler({ url, method });
  const response = await request('horizon://app/');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html></html>');
  assert.equal(response.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await request('horizon://app/app.js')).headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  for (const url of ['https://app/', 'horizon://app/escaped/private.js', 'horizon://evil/', 'horizon://user@app/', 'horizon://app:8080/', 'horizon://app/?query', 'horizon://app/private.json', 'horizon://app/%2e%2e%2foutside.js', 'horizon://app/%5c..%5coutside.js']) {
    assert.equal((await request(url)).status, 403, url);
  }
  assert.equal((await request('horizon://app/', 'POST')).status, 403);
  assert.equal((await request('horizon://app/missing.js')).status, 404);
});
