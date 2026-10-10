const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { CONTENT_SECURITY_POLICY } = require('../dist/electron/security.js');

const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const link = (host, id = host) => ({ kind: 'link', id, url: `https://${host}/page`, title: host, createdAt: 1 });
const folder = (children, id = 'folder') => ({ kind: 'folder', id, name: id, children, createdAt: 1 });
const state = (bar = [], other = []) => ({ activeProfileId: 'profile-one', favoriteFaviconVersion: 1, privateWindow: false, store: { favorites: { bar, other } } });
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(done => setImmediate(done)); };

function harness(read = async origins => Object.fromEntries(origins.map(origin => [origin, icon]))) {
  let cursor = 0; const slots = [], pending = [], calls = [], created = [], revoked = [], decoded = [], active = new Set();
  class LocalURL extends URL {
    static createObjectURL(blob) { const url = `blob:horizon://app/synthetic-${created.length}`; created.push({ url, blob }); active.add(url); return url; }
    static revokeObjectURL(url) { assert.ok(active.delete(url), `Object URL revoked twice: ${url}`); revoked.push(url); }
  }
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useRef(current) { const index = cursor++; slots[index] ??= { current }; return slots[index]; },
    useId: () => 'synthetic-id',
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (previous && dependencies && previous.dependencies && dependencies.length === previous.dependencies.length && dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))) return;
      previous?.cleanup?.(); slots[index] = { dependencies };
      pending.push(() => { slots[index].cleanup = effect(); });
    },
  };
  react.useLayoutEffect = react.useEffect;
  const exports = {}, jsx = (type, props) => ({ type, props });
  const source = ts.transpileModule(readFileSync('src/Favorites.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const globals = { exports, URL: LocalURL, Blob, atob: value => { decoded.push(value); return atob(value); }, Error, ResizeObserver: class { observe() {} disconnect() {} },
    document: { activeElement: null, fonts: { ready: Promise.resolve() }, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {}, horizon: { async getFavoriteFavicons(origins) { calls.push([...origins]); return read(origins); } } },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './shared/api') return require('../dist/src/shared/api.js');
      if (name === './shared/favorites') return require('../dist/src/shared/favorites.js');
      if (name === './copy') return require('../dist/src/copy.js');
      return new Proxy({}, { get: (_target, key) => String(key) });
    },
  };
  runInNewContext(source + '\nexports.useFavoriteFavicons = useFavoriteFavicons; exports.FavoriteBadge = FavoriteBadge; exports.FolderPopover = FolderPopover;', globals);
  return { exports, calls, slots, created, revoked, active, decoded, render(name, ...props) { cursor = 0; return exports[name](...props); }, flush() { for (const effect of pending.splice(0)) effect(); }, close() { for (const slot of slots) slot.cleanup?.(); } };
}
const flat = value => [value].flat(Infinity).filter(value => value !== null && value !== undefined && typeof value !== 'boolean');
const find = (tree, predicate) => flat(tree).flatMap(node => typeof node === 'object' ? [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)] : []);

test('favorite badges show a cached raster image, keep initials on misses and decode failure, and preserve folders', async () => {
  const h = harness(), badge = harness(), item = link('example.test'), browser = state();
  h.render('useFavoriteFavicons', browser, [item]); h.flush(); await settle();
  const icons = h.render('useFavoriteFavicons', browser, [item]);
  let tree = badge.render('FavoriteBadge', { item, icons });
  assert.equal(tree.type, 'img'); assert.equal(tree.props.src, icons['https://example.test']); assert.equal(tree.props.alt, '');
  assert.equal(tree.props.className, 'favorite-badge favorite-favicon');
  tree.props.onError(); tree = badge.render('FavoriteBadge', { item, icons });
  assert.equal(tree.type, 'span'); assert.equal(tree.props.children, 'E');
  assert.equal(badge.render('FavoriteBadge', { item }).props.children, 'E');
  const replacement = 'blob:horizon://app/replacement';
  assert.equal(badge.render('FavoriteBadge', { item, icons: { 'https://example.test': replacement } }).props.src, replacement);
  assert.equal(badge.render('FavoriteBadge', { item: folder([item]), icons }).type, 'Folder');
  h.close(); assert.equal(h.active.size, 0); assert.equal(h.revoked.length, 1);
});

test('favorite favicon reads deduplicate origins and split visible origins into batches of at most 200', async () => {
  const h = harness(), browser = state(), items = Array.from({ length: 401 }, (_, index) => link(`site-${index}.test`));
  items.push(link('site-0.test', 'second-page'), folder([link('hidden.test')]));
  assert.deepEqual(Object.keys(h.render('useFavoriteFavicons', browser, items)), []); h.flush(); await settle();
  const icons = h.render('useFavoriteFavicons', browser, items);
  assert.deepEqual(h.calls.map(batch => batch.length), [200, 200, 1]); assert.equal(Object.keys(icons).length, 401);
  assert.ok(h.calls.flat().every(origin => new URL(origin).origin === origin));
  assert.equal(h.calls.flat().includes('https://hidden.test'), false);
  h.flush(); await settle(); assert.equal(h.calls.length, 3); assert.equal(h.active.size, 401);
  h.close(); assert.equal(h.active.size, 0); assert.equal(h.revoked.length, 401);
});

test('private favorites do not read cached icons and stop later pending batches when a window becomes private', async () => {
  let finish; const h = harness(() => new Promise(done => { finish = done; })), browser = state(); browser.privateWindow = true;
  h.render('useFavoriteFavicons', browser, [link('example.test')]); h.flush(); assert.equal(h.calls.length, 0);
  browser.privateWindow = false;
  const items = Array.from({ length: 201 }, (_, index) => link(`site-${index}.test`));
  h.render('useFavoriteFavicons', browser, items); h.flush(); assert.equal(h.calls.length, 1);
  browser.privateWindow = true;
  assert.deepEqual(Object.keys(h.render('useFavoriteFavicons', browser, items)), []); h.flush();
  finish({ 'https://site-0.test': icon }); await settle();
  assert.equal(h.calls.length, 1); assert.deepEqual(Object.keys(h.render('useFavoriteFavicons', browser, items)), []); h.close();
  assert.equal(h.created.length, 0); assert.equal(h.active.size, 0);
  const cached = harness(), normal = state();
  cached.render('useFavoriteFavicons', normal, [link('example.test')]); cached.flush(); await settle(); assert.equal(cached.active.size, 1);
  normal.privateWindow = true;
  assert.deepEqual(Object.keys(cached.render('useFavoriteFavicons', normal, [link('example.test')])), []); cached.flush();
  assert.equal(cached.active.size, 0); assert.equal(cached.revoked.length, 1); cached.close();
});

test('favorite icons invalidate immediately on profile or cache version changes and ignore stale responses', async () => {
  const queued = [], h = harness(origins => new Promise(done => queued.push({ origins, done }))), browser = state(), items = [link('example.test')];
  h.render('useFavoriteFavicons', browser, items); h.flush();
  queued.shift().done({ 'https://example.test': icon }); await settle();
  assert.equal(h.render('useFavoriteFavicons', browser, items)['https://example.test'], h.created[0].url); assert.equal(h.active.size, 1);
  browser.favoriteFaviconVersion++;
  assert.deepEqual(Object.keys(h.render('useFavoriteFavicons', browser, items)), []); h.flush();
  assert.equal(h.active.size, 0); assert.equal(h.revoked.length, 1);
  browser.activeProfileId = 'profile-two';
  assert.deepEqual(Object.keys(h.render('useFavoriteFavicons', browser, items)), []); h.flush();
  queued.shift().done({ 'https://example.test': icon }); await settle();
  assert.deepEqual(Object.keys(h.render('useFavoriteFavicons', browser, items)), []);
  assert.equal(h.created.length, 1);
  queued.shift().done({}); await settle();
  assert.deepEqual(Object.keys(h.render('useFavoriteFavicons', browser, items)), []); h.close(); assert.equal(h.active.size, 0);
});

test('favorite favicon IPC failure and malformed or non-PNG responses retain initials without image network requests', async () => {
  for (const read of [async () => { throw new Error('Synthetic IPC failure'); }, async () => ({ 'https://example.test': 'https://remote.test/icon.png' }), async () => ({ 'https://example.test': 'data:image/svg+xml;base64,PHN2Zz4=' }), async () => ({ 'https://example.test': 'data:image/png;base64,A' })]) {
    const h = harness(read), browser = state(), items = [link('example.test')];
    h.render('useFavoriteFavicons', browser, items); h.flush(); await settle();
    assert.deepEqual(Object.keys(h.render('useFavoriteFavicons', browser, items)), []); h.close(); assert.equal(h.created.length, 0);
  }
});

test('favorite object URLs use PNG blobs allowed by Horizon CSP and cap decoded images at 16 KB', async () => {
  const browser = state(), items = [link('example.test')], png = Buffer.from(icon.split(',')[1], 'base64');
  for (const size of [16 * 1024, 16 * 1024 + 1, 16 * 1024 + 3]) {
    const bytes = Buffer.concat([png, Buffer.alloc(size - png.length)]);
    const h = harness(async () => ({ 'https://example.test': `data:image/png;base64,${bytes.toString('base64')}` }));
    h.render('useFavoriteFavicons', browser, items); h.flush(); await settle();
    const icons = h.render('useFavoriteFavicons', browser, items);
    if (size === 16 * 1024) {
      const imageSources = CONTENT_SECURITY_POLICY.split('; ').find(directive => directive.startsWith('img-src ')).split(' ').slice(1);
      assert.equal(new URL(icons['https://example.test']).protocol, 'blob:'); assert.ok(imageSources.includes('blob:')); assert.equal(imageSources.includes('data:'), false);
      assert.equal(h.created[0].blob.type, 'image/png'); assert.equal(h.created[0].blob.size, size);
      assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), bytes);
    } else { assert.deepEqual(Object.keys(icons), []); assert.equal(h.created.length, 0); }
    assert.equal(h.decoded.length, size === 16 * 1024 + 3 ? 0 : 1);
    h.close(); assert.equal(h.active.size, 0);
  }
});

test('favorite object URLs are revoked on partial batch failure and unmount before a late response', async () => {
  const browser = state();
  let calls = 0;
  const failedBatch = harness(async origins => { if (++calls > 1) throw new Error('Synthetic second batch failure'); return Object.fromEntries(origins.map(origin => [origin, icon])); });
  const items = Array.from({ length: 201 }, (_, index) => link(`site-${index}.test`));
  failedBatch.render('useFavoriteFavicons', browser, items); failedBatch.flush(); await settle();
  assert.equal(failedBatch.created.length, 200); assert.equal(failedBatch.revoked.length, 200); assert.equal(failedBatch.active.size, 0);
  assert.deepEqual(Object.keys(failedBatch.render('useFavoriteFavicons', browser, items)), []); failedBatch.close();
  let finish;
  const unmounted = harness(async origins => origins.includes('https://site-99.test') ? new Promise(done => { finish = done; }) : Object.fromEntries(origins.map(origin => [origin, icon])));
  unmounted.render('useFavoriteFavicons', browser, items); unmounted.flush(); await settle();
  assert.equal(unmounted.active.size, 200); unmounted.close(); assert.equal(unmounted.active.size, 0);
  finish({ 'https://site-99.test': icon }); await settle(); assert.equal(unmounted.created.length, 200); assert.equal(unmounted.revoked.length, 200);
});

test('favorites bar, folder menus and panel pass cached icons to every drawn site badge', async () => {
  const item = link('example.test'), hidden = link('hidden.test'), browser = state([item, folder([hidden])], [link('other-hidden.test')]);
  const common = { state: browser, language: 'en', run: async () => true, onDelete: async () => {}, onOverlay() {}, onActivate() {}, dismiss: false, undo: null, onRestore() {}, opener: { current: null }, onDismiss() {}, onAnnounce() {} };
  for (const name of ['FavoritesBar', 'FavoritesPanel', 'FolderPopover']) {
    const h = harness(), props = name === 'FolderPopover' ? { ...common, folder: folder([item, folder([hidden])]), beside: false, onOpen() {}, onClose() {}, actions: { showMenu() {}, menuKey() {} }, drag: { containerProps: () => ({}), props: () => ({}) } } : common;
    h.render(name, props); h.flush(); await settle();
    const tree = h.render(name, props), badges = find(tree, node => typeof node.type === 'function' && node.type.name === 'FavoriteBadge');
    assert.ok(badges.length > 0);
    assert.ok(badges.filter(badge => badge.props.item.kind === 'link').every(badge => new URL(badge.props.icons['https://example.test']).protocol === 'blob:'));
    assert.deepEqual(h.calls.flat(), ['https://example.test']); h.close(); assert.equal(h.active.size, 0);
  }
});
