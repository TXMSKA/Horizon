const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createBlockingEngine, downloadFilterList } = require('../dist/electron/blocking.js');

function directory(t) {
  const root = resolve('.runtime'); mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, 'blocking-policy-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}
function source(url) {
  return url.endsWith('resources.json') ? JSON.stringify({ redirects: [], scriptlets: [] }) : '||ad.synthetic.example^';
}

test('blocking disabled at startup makes no list request, including hourly checks and explicit refresh, and enabling starts downloads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let downloads = 0;
  const engine = createBlockingEngine(directory(t), undefined, { enabled: false, download: async url => { downloads++; return source(url); } });
  t.after(() => engine.stop());
  await engine.start();
  t.mock.timers.tick(48 * 60 * 60 * 1000);
  assert.equal(await engine.refresh(), false); assert.equal(downloads, 0);
  engine.setEnabled(true);
  assert.ok(downloads > 0);
  assert.equal(await engine.refresh(), true); assert.equal(engine.ready, true);
});

test('disabling blocking aborts in-flight downloads and suppresses retry and hourly downloads until enabled again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let downloads = 0, fail = false;
  const signals = [];
  const engine = createBlockingEngine(directory(t), undefined, { download: async (url, signal) => {
    downloads++; signals.push(signal);
    if (fail) throw new Error('synthetic offline');
    return new Promise((accept, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic cancelled')), { once: true }));
  } });
  t.after(() => engine.stop());
  await engine.start();
  const pending = engine.refresh(), first = downloads;
  engine.setEnabled(false);
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(await pending, false);
  t.mock.timers.tick(2 * 60 * 60 * 1000); assert.equal(downloads, first);
  fail = true; engine.setEnabled(true); await engine.refresh();
  const failed = downloads; assert.ok(failed > first);
  engine.setEnabled(false);
  t.mock.timers.tick(2 * 60 * 60 * 1000); assert.equal(downloads, failed);
  engine.setEnabled(true); await engine.refresh(); assert.ok(downloads > failed);
});

test('a stale cached engine remains available while blocking is disabled without requesting a list refresh', async t => {
  const folder = directory(t), now = Date.now();
  const seed = createBlockingEngine(folder, undefined, { now: () => now, download: async url => source(url) });
  assert.equal(await seed.refresh(), true); seed.stop();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let requests = 0;
  const cached = createBlockingEngine(folder, undefined, { enabled: false, now: () => now + 48 * 60 * 60 * 1000,
    download: async url => { requests++; return source(url); } });
  t.after(() => cached.stop());
  await cached.start(); assert.equal(cached.ready, true);
  assert.deepEqual(cached.match('https://ad.synthetic.example/banner', 'image', 'https://site.synthetic.example/'), { kind: 'ads' });
  t.mock.timers.tick(48 * 60 * 60 * 1000); assert.equal(requests, 0);
  cached.setEnabled(true); assert.ok(requests > 0); assert.equal(await cached.refresh(), true);
});

test('a cancelled list generation settling after re-enabling cannot abort or replace the new generation', async t => {
  let generation = 0;
  const old = [], fresh = [], signals = [];
  const engine = createBlockingEngine(directory(t), undefined, { download: (url, signal) => new Promise((accept, reject) => {
    if (generation === 0) old.push(reject);
    else { fresh.push(() => accept(source(url))); signals.push(signal); }
  }) });
  t.after(() => engine.stop());
  await engine.start();
  const cancelled = engine.refresh(); engine.setEnabled(false); generation++;
  engine.setEnabled(true);
  const pending = engine.refresh(), count = fresh.length;
  assert.ok(count > 0);
  for (const reject of old) reject(new Error('synthetic late cancellation'));
  assert.equal(await cancelled, false);
  assert.ok(signals.every(signal => !signal.aborted));
  assert.equal(engine.refresh(), pending); assert.equal(fresh.length, count);
  for (const accept of fresh) accept();
  assert.equal(await pending, true); assert.equal(engine.ready, true);
});

test('an already-cancelled filter download never calls its transport', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  let requests = 0;
  await assert.rejects(downloadFilterList('https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/easylist/easylist.txt', async () => {
    requests++; return new Response('||ad.synthetic.example^');
  }, cancelled.signal), /FILTER_TIMEOUT/);
  assert.equal(requests, 0);
});
