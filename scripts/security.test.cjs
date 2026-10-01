const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, symlinkSync, rmSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { validateSender, secureSession, hardenContents, CONTENT_SECURITY_POLICY } = require('../dist/electron/security.js');
const { serveHorizon } = require('../dist/electron/protocol.js');
const { classifyInput, isAllowedURL, isAllowedSubframeURL, isWebURL, parseErrorName } = require('../dist/electron/browsing.js');
const { validateStore, readStore, writeStore, reserveDownloadPath } = require('../dist/electron/store.js');
const { validateCommand, validateContentArea } = require('../dist/electron/commands.js');
const { browserShortcut } = require('../dist/src/shared/shortcuts.js');

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

test('navigation hardening isolates trusted chrome from untrusted web tabs', () => {
  for (const web of [false, true]) {
    const handlers = {};
    let popup;
    hardenContents({ on(name, handler) { handlers[name] = handler; }, setWindowOpenHandler(handler) { popup = handler; } }, web);
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      for (const url of ['http://example.com/', 'https://example.com/', 'about:blank', 'file:///private', 'horizon://app/', 'javascript:alert(1)', 'custom://example.com/', 'chrome://settings/', 'https://user@example.com/']) {
        let prevented = false;
        handlers[name]({ url, isMainFrame: true, preventDefault() { prevented = true; } });
        assert.equal(prevented, !web || !isAllowedURL(url), `${web}:${name}:${url}`);
      }
    }
    for (const name of ['will-frame-navigate', 'will-redirect']) {
      for (const url of ['https://example.com/', 'about:blank', 'about:srcdoc', 'data:text/html,test', 'blob:https://example.com/id', 'file:///private', 'horizon://app/', 'javascript:alert(1)', 'chrome://settings/', 'custom://example.com/']) {
        let prevented = false;
        handlers[name]({ url, isMainFrame: false, preventDefault() { prevented = true; } });
        assert.equal(prevented, !web || !isAllowedSubframeURL(url), `${web}:${name}:${url}`);
      }
    }
    let prevented = false;
    handlers['will-attach-webview']({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(popup({ url: 'https://example.com/' }), { action: 'deny' });
  }
});

test('chrome CSP permits blob images without widening other directives', () => {
  assert.equal(CONTENT_SECURITY_POLICY, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'");
});

test('subframes permit local document schemes without allowing privileged navigation', () => {
  for (const url of ['http://example.com/', 'https://example.com/', 'about:blank', 'about:srcdoc', 'data:text/html,<p>frame</p>', 'blob:https://example.com/id', `data:text/html,${'x'.repeat(8192)}`]) {
    assert.equal(isAllowedSubframeURL(url), true, url);
  }
  for (const url of [null, {}, 42, '', 'about:srcdoc#fragment', 'about:blank#fragment', 'about:config', 'file:///private', 'horizon://app/', 'javascript:alert(1)', 'chrome://settings/', 'custom://example.com/', ' https://example.com/', 'https://user@example.com/']) {
    assert.equal(isAllowedSubframeURL(url), false, String(url));
  }
});

test('load errors expose only strict Chromium error names', () => {
  for (const [description, expected] of [
    ['ERR_NAME_NOT_RESOLVED', 'ERR_NAME_NOT_RESOLVED'],
    ["ERR_NAME_NOT_RESOLVED (-105) loading 'https://example.com/'", 'ERR_NAME_NOT_RESOLVED'],
    ['net::ERR_CONNECTION_REFUSED at https://example.com/', 'ERR_CONNECTION_REFUSED'],
    ['Error: ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_AUTHORITY_INVALID'],
    ['', 'ERR_FAILED'], ['Connection failed (-2)', 'ERR_FAILED'], ['err_name_not_resolved', 'ERR_FAILED'],
  ]) assert.equal(parseErrorName(description), expected, description);
});

test('navigation permits only bounded web URLs and the exact blank page', () => {
  for (const url of ['https://example.com/', 'http://localhost:3000/a?q=1#part', 'https://[::1]/', 'about:blank']) {
    assert.equal(isAllowedURL(url), true, url);
    assert.equal(isWebURL(url), url !== 'about:blank', url);
  }
  for (const url of [null, {}, 42, '', 'example.com', 'https://user:password@example.com/', 'https://user@example.com/', ' https://example.com/', 'https://example.com/\npath', 'https://example.com/\0', 'about:blank#fragment', 'about:config', 'file:///private', 'horizon://app/', 'javascript:alert(1)', 'data:text/html,test', 'chrome://settings/', 'mailto:user@example.com', 'custom://example.com/', `https://example.com/${'x'.repeat(8192)}`]) {
    assert.equal(isAllowedURL(url), false, String(url));
    assert.equal(isWebURL(url), false, String(url));
  }
});

test('address input classifies hosts and URLs locally, and searches other text on DuckDuckGo', () => {
  const addresses = [
    [' example.com ', 'https://example.com/'],
    ['example.com/path?q=1#here', 'https://example.com/path?q=1#here'],
    ['localhost:3000', 'https://localhost:3000/'],
    ['127.0.0.1:8080/path', 'https://127.0.0.1:8080/path'],
    ['[::1]:8080', 'https://[::1]:8080/'],
    ['HTTP://EXAMPLE.COM/a', 'http://example.com/a'],
    ['https://español.example/', 'https://xn--espaol-zwa.example/'],
    ['about:blank', 'about:blank'],
  ];
  for (const [input, expected] of addresses) assert.equal(classifyInput(input), expected, input);
  for (const input of ['horizon', 'bread recipes', 'cat & dog', 'mañana', 'user@example.com', 'foo/bar']) {
    assert.equal(classifyInput(input), `https://duckduckgo.com/?q=${encodeURIComponent(input)}`, input);
  }
  for (const input of ['', ' ', 'line\nbreak', 'javascript:alert(1)', 'JavaScript:alert(1)', 'file:///private', 'horizon://app/', 'chrome://settings/', 'data:text/html,test', 'custom://example.com/', 'https://user:password@example.com/', 'x'.repeat(8193)]) {
    assert.throws(() => classifyInput(input), undefined, input);
  }
});

function temporaryDirectory(t, prefix) {
  mkdirSync('.runtime', { recursive: true });
  const directory = mkdtempSync(resolve(`.runtime/${prefix}-`));
  t.after(() => {
    assert.ok(directory.startsWith(resolve('.runtime') + require('node:path').sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function sampleStore(directory) {
  return {
    version: 1,
    history: [{ url: 'https://example.com/', title: 'Example', lastVisit: 1, visitCount: 2 }],
    bookmarks: [{ url: 'https://example.com/', title: 'Example', createdAt: 1 }],
    downloads: [{ id: 'download-1', url: 'https://example.com/file', filename: 'file.txt', path: join(directory, 'file.txt'), received: 3, total: 3, status: 'completed', startedAt: 1 }],
  };
}

test('store schema rejects unsafe URLs, shapes, statuses, paths, and unbounded fields', (t) => {
  const directory = temporaryDirectory(t, 'schema');
  assert.equal(validateStore(sampleStore(directory)), true);
  assert.equal(validateStore({ version: 1, history: [], bookmarks: [], downloads: [] }), true);
  for (const invalid of [null, [], {}, { version: 2, history: [], bookmarks: [], downloads: [] }]) assert.equal(validateStore(invalid), false);
  const mutations = [
    store => { store.extra = true; },
    store => { store.history = null; },
    store => { store.history[0].url = 'file:///private'; },
    store => { store.bookmarks[0].url = 'https://user@example.com/'; },
    store => { store.bookmarks[0].createdAt = -1; },
    store => { store.history[0].visitCount = 0; },
    store => { store.history[0].lastVisit = Infinity; },
    store => { store.history[0].lastVisit = Number.MAX_SAFE_INTEGER; },
    store => { store.bookmarks[0].createdAt = Number.MAX_SAFE_INTEGER; },
    store => { store.downloads[0].startedAt = Number.MAX_SAFE_INTEGER; },
    store => { store.history[0].title = 'x'.repeat(4097); },
    store => { store.downloads[0].status = 'running'; },
    store => { store.downloads[0].status = { toString: () => 'completed' }; },
    store => { store.downloads[0].total = NaN; },
    store => { store.downloads[0].received = -1; },
    store => { store.downloads[0].id = ''; },
    store => { store.downloads[0].filename = '../private'; },
    store => { store.downloads[0].filename = '..\\private'; },
    store => { store.downloads[0].filename = '..'; },
    store => { store.downloads[0].filename = '.'; },
    store => { store.downloads[0].path = 'relative/file'; },
    store => { store.downloads[0].url = 'javascript:alert(1)'; },
    store => { store.downloads[0].path += '\0'; },
    store => { store.history = new Array(1); },
  ];
  for (const mutate of mutations) {
    const store = sampleStore(directory);
    mutate(store);
    assert.equal(validateStore(store), false);
  }
});

test('store writes atomically, recovers invalid files, and preserves corrupt originals', (t) => {
  const directory = temporaryDirectory(t, 'store');
  const path = join(directory, 'profile', 'browser.json');
  assert.deepEqual(readStore(path), { version: 1, history: [], bookmarks: [], downloads: [] });
  assert.ok(existsSync(path));
  const store = sampleStore(directory);
  writeStore(path, store);
  assert.deepEqual(readStore(path), store);
  assert.equal(readdirSync(join(directory, 'profile')).some(name => name.endsWith('.tmp')), false);
  assert.throws(() => writeStore(path, { ...store, version: 2 }));
  assert.deepEqual(readStore(path), store);
  for (const corrupt of ['{broken json', JSON.stringify({ ...store, version: 2 })]) {
    writeFileSync(path, corrupt);
    assert.deepEqual(readStore(path), { version: 1, history: [], bookmarks: [], downloads: [] });
    const backups = readdirSync(join(directory, 'profile')).filter(name => name.startsWith('browser.json.corrupt-'));
    assert.ok(backups.some(name => readFileSync(join(directory, 'profile', name), 'utf8') === corrupt));
    assert.equal(validateStore(JSON.parse(readFileSync(path, 'utf8'))), true);
  }
  const unavailable = join(directory, 'not-a-directory');
  writeFileSync(unavailable, 'file');
  assert.doesNotThrow(() => readStore(join(unavailable, 'browser.json')));
});

test('interrupted downloads become failed when a profile is reopened', (t) => {
  const directory = temporaryDirectory(t, 'interrupted');
  const path = join(directory, 'browser.json');
  const store = sampleStore(directory);
  store.downloads[0].status = 'progressing';
  writeStore(path, store);
  const restored = readStore(path);
  assert.equal(restored.downloads[0].status, 'failed');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).downloads[0].status, 'failed');
  assert.equal(restored.downloads[0].received, 3);
});

test('download paths avoid existing and concurrent filenames and sanitize platform paths', (t) => {
  const directory = temporaryDirectory(t, 'download');
  const original = join(directory, 'report.pdf');
  writeFileSync(original, 'existing');
  const reserved = new Set([join(directory, 'report (1).pdf')]);
  assert.equal(reserveDownloadPath(directory, 'report.pdf', reserved), join(directory, 'report (2).pdf'));
  assert.equal(readFileSync(original, 'utf8'), 'existing');
  assert.equal(reserveDownloadPath(directory, '../../safe.txt', new Set()), join(directory, 'safe.txt'));
  assert.equal(reserveDownloadPath(directory, '..\\..\\safe.txt', new Set()), join(directory, 'safe.txt'));
  assert.equal(reserveDownloadPath(directory, 'CON.txt', new Set()), join(directory, '_CON.txt'));
  assert.equal(reserveDownloadPath(directory, 'LPT1', new Set()), join(directory, '_LPT1'));
  assert.equal(reserveDownloadPath(directory, '..', new Set()), join(directory, 'download'));
  assert.equal(reserveDownloadPath(directory, 'unsafe:name?.txt ', new Set()), join(directory, 'unsafe_name_.txt'));
  const longPath = reserveDownloadPath(directory, 'é'.repeat(300), new Set());
  assert.ok(Buffer.byteLength(require('node:path').basename(longPath), 'utf8') <= 180);
  assert.equal(require('node:path').dirname(longPath), directory);
  if (process.platform === 'win32') {
    assert.equal(reserveDownloadPath(directory, 'REPORT.pdf', new Set([join(directory, 'REPORT (1).PDF')])), join(directory, 'REPORT (2).pdf'));
  }
});

test('browser IPC arguments reject unknown actions, extra fields, and invalid values', () => {
  const commands = [
    { type: 'new-tab' }, { type: 'new-tab', input: 'example.com' },
    { type: 'navigate', input: 'bread recipes' },
    { type: 'activate-tab', id: 'tab-1' }, { type: 'close-tab', id: 'tab-1' },
    { type: 'zoom', delta: -1 }, { type: 'zoom', delta: 0 }, { type: 'zoom', delta: 1 },
    { type: 'find', text: '', forward: false, next: false },
    { type: 'find', text: 'recipe', forward: true, next: true },
    { type: 'rename-bookmark', url: 'https://example.com/', title: 'Example' },
    ...['back', 'forward', 'reload', 'stop', 'bookmark', 'focus-page', 'stop-find', 'clear-history'].map(type => ({ type })),
    ...['delete-history', 'delete-bookmark'].map(type => ({ type, url: 'https://example.com/' })),
    ...['cancel-download', 'show-download', 'remove-download'].map(type => ({ type, id: 'download-1' })),
    ...['history', 'bookmarks', 'downloads'].map(kind => ({ type: 'restore', kind })),
  ];
  for (const command of commands) {
    assert.deepEqual(validateCommand(command), command);
    assert.throws(() => validateCommand({ ...command, unexpected: true }));
  }
  const invalid = [null, [], {}, { type: 'execute' }, { type: 'new-tab', input: '' },
    { type: 'navigate', input: 1 }, { type: 'navigate', input: 'x'.repeat(8193) },
    { type: 'navigate', input: '\0' }, { type: 'close-tab', id: '' },
    { type: 'close-tab', id: 'x'.repeat(129) }, { type: 'zoom', delta: 2 },
    { type: 'zoom', delta: '1' }, { type: 'find', text: 'x'.repeat(1025), forward: true, next: false },
    { type: 'find', text: 'text', forward: 1, next: false },
    { type: 'find', text: 'text', forward: true },
    { type: 'rename-bookmark', url: 'file:///private', title: 'Private' },
    { type: 'rename-bookmark', url: 'https://example.com/', title: 'x'.repeat(1025) },
    { type: 'delete-history', url: 'javascript:alert(1)' },
    { type: 'restore' }, { type: 'restore', kind: 'tabs' },
    { type: 'restore', kind: '' }, { type: 'restore', kind: null },
    { type: 'restore', kind: { toString: () => 'history' } },
    { type: 'restore', kind: 'history', entries: [] },
    { type: 'restore', kind: 'bookmarks', url: 'https://example.com/' },
    { type: 'restore', kind: 'downloads', id: 'download-1' },
    { type: 'show-download', path: 'C:\\private\\file' }];
  for (const command of invalid) assert.throws(() => validateCommand(command));
  assert.deepEqual(validateContentArea({ top: 96, hidden: true }), { top: 96, hidden: true });
  assert.deepEqual(validateContentArea({ top: 2048, hidden: false }), { top: 2048, hidden: false });
  for (const area of [null, [], {}, { top: -1, hidden: false }, { top: 2049, hidden: false }, { top: Infinity, hidden: true }, { top: NaN, hidden: true }, { top: '96', hidden: false }, { top: 96, hidden: 1 }, { top: 96, hidden: true, path: '/private' }]) {
    assert.throws(() => validateContentArea(area));
  }
});

test('chrome and web content share the same browser shortcut mapping', () => {
  const input = (key, modifiers = {}) => ({ key, control: false, alt: false, shift: false, meta: false, ...modifiers });
  const controlKeys = { l: 'focus-address', t: 'new-tab', w: 'close-tab', r: 'reload', h: 'history', j: 'downloads', d: 'bookmark', f: 'find', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', '_': 'zoom-out', '0': 'zoom-reset', Tab: 'next-tab' };
  for (const [key, shortcut] of Object.entries(controlKeys)) {
    assert.equal(browserShortcut(input(key, { control: true })), shortcut, key);
    assert.equal(browserShortcut(input(key.toUpperCase(), { control: true })), shortcut, key);
  }
  for (let index = 1; index <= 9; index++) assert.equal(browserShortcut(input(String(index), { control: true })), `tab-${index}`);
  assert.equal(browserShortcut(input('Tab', { control: true, shift: true })), 'previous-tab');
  assert.equal(browserShortcut(input('+', { control: true, shift: true })), 'zoom-in');
  assert.equal(browserShortcut(input('ArrowLeft', { alt: true })), 'back');
  assert.equal(browserShortcut(input('ArrowRight', { alt: true })), 'forward');
  assert.equal(browserShortcut(input('F5')), 'reload');
  assert.equal(browserShortcut(input('F6')), 'focus-address');
  assert.equal(browserShortcut(input('Escape')), 'stop');
  for (const event of [input('t'), input('ArrowLeft'), input('t', { control: true, alt: true }), input('t', { control: true, shift: true }), input('t', { control: true, meta: true }), input('z', { control: true })]) {
    assert.equal(browserShortcut(event), null);
  }
});

test('browser lifecycle keeps pages isolated, scales bounds, records visits and handles downloads', async (t) => {
  const { EventEmitter } = require('node:events');
  const { createRequire } = require('node:module');
  const { compileFunction } = require('node:vm');
  const directory = temporaryDirectory(t, 'browser');
  const handlers = new Map();
  const views = [];
  const shown = [];
  const timers = new Map();
  const writes = [];
  let writeFailure = false;
  let nextTimer = 0;
  const schedule = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  const clear = id => timers.delete(id);
  const tick = (delay = 500) => {
    for (const [id, timer] of [...timers]) {
      assert.ok([500, 8000].includes(timer.delay));
      if (timer.delay !== delay) continue;
      timers.delete(id); timer.callback();
    }
  };
  class Contents extends EventEmitter {
    constructor() {
      super();
      this.mainFrame = { url: 'horizon://app/' };
      this.zoom = 0.75;
      this.destroyed = false;
      this.loading = false;
      this.sent = [];
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    }
    isDestroyed() { return this.destroyed; }
    send(...args) { this.sent.push(args); }
    focus() { this.focused = true; }
    setZoomMode(mode) { this.zoomMode = mode; }
    setZoomFactor(zoom) { this.zoom = zoom; }
    getZoomFactor() { return this.zoom; }
    setWindowOpenHandler(handler) { this.popup = handler; }
    loadURL(url) { this.url = url; return this.loadError ? Promise.reject(new Error(this.loadError)) : Promise.resolve(); }
    getTitle() { return this.title || ''; }
    close() { if (this.destroyed) return; this.destroyed = true; this.emit('destroyed'); }
    isLoading() { return this.loading; }
    capturePage() { this.captures = (this.captures || 0) + 1; return Promise.resolve(this.image); }
    stopFindInPage() {}
    findInPage(text, options) { this.find = { text, options }; return 7; }
    reload() {}
  }
  class View {
    constructor(options) { this.options = options; this.webContents = options.webContents || new Contents(); views.push(this); }
    setVisible(visible) { this.visible = visible; }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
  }
  const webSession = new EventEmitter();
  webSession.setPermissionRequestHandler = handler => { webSession.request = handler; };
  webSession.setPermissionCheckHandler = handler => { webSession.check = handler; };
  webSession.setDevicePermissionHandler = handler => { webSession.device = handler; };
  webSession.webRequest = { onBeforeRequest(handler) { webSession.network = handler; } };
  const electron = {
    app: new EventEmitter(),
    ipcMain: { handle(name, handler) { handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } },
    session: { fromPartition(name) { assert.equal(name, 'persist:web'); return webSession; } },
    shell: { showItemInFolder(path) { shown.push(path); } },
    screen: { getDisplayMatching() { return { scaleFactor: 2 }; } },
    WebContentsView: View,
  };
  const filename = resolve('dist/electron/browser.js');
  const localRequire = createRequire(filename);
  const loaded = { exports: {} };
  compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname', 'setTimeout', 'clearTimeout'])(loaded.exports,
    name => name === 'electron' ? electron : name === './store' ? { ...localRequire(name), writeStore(path, store) {
      if (writeFailure) throw new Error('Disk unavailable');
      writes.push(structuredClone(store)); localRequire(name).writeStore(path, store);
    } } : localRequire(name), loaded, filename, require('node:path').dirname(filename), schedule, clear);
  const window = new EventEmitter();
  window.webContents = new Contents();
  window.isDestroyed = () => false;
  window.getContentBounds = () => ({ width: 800, height: 600 });
  window.setFullScreen = fullscreen => { window.fullscreen = fullscreen; };
  window.contentView = { addChildView() {}, removeChildView() {} };
  const browser = loaded.exports.createBrowser(window, directory, join(directory, 'downloads'));
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const state = () => handlers.get('horizon:state')(event);
  const command = value => handlers.get('horizon:command')(event, value);
  const capture = (...args) => handlers.get('horizon:capture')(event, ...args);
  assert.equal(state().tabs.length, 1);
  assert.equal(views.length, 0);
  assert.equal(await capture(), null);
  await assert.rejects(async () => handlers.get('horizon:capture')({ ...event, sender: {} }));
  await assert.rejects(async () => handlers.get('horizon:capture')({ ...event, senderFrame: { url: 'horizon://app/' } }));
  window.webContents.mainFrame.url = 'https://example.com/';
  await assert.rejects(async () => capture());
  window.webContents.mainFrame.url = 'horizon://app/';
  await assert.rejects(async () => capture('unexpected'));
  assert.equal(writes.length, 0);
  assert.equal(timers.size, 1);
  assert.throws(() => handlers.get('horizon:command')({ ...event, sender: {} }, { type: 'new-tab' }));
  command({ type: 'navigate', input: 'bread recipes' });
  assert.equal(views.length, 1);
  const view = views[0];
  assert.equal(view.options.webPreferences.partition, 'persist:web');
  for (const flag of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(view.options.webPreferences[flag], true);
  for (const flag of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag']) assert.equal(view.options.webPreferences[flag], false);
  assert.equal(view.options.webPreferences.preload, undefined);
  assert.equal(view.webContents.url, 'https://duckduckgo.com/?q=bread%20recipes');
  handlers.get('horizon:content-area')(event, { top: 120, hidden: false });
  assert.deepEqual(view.bounds, { x: 0, y: 90, width: 800, height: 510 });
  assert.equal(view.visible, true);
  window.webContents.zoom = 0.92;
  browser.layout();
  assert.equal(view.bounds.y, 111);
  handlers.get('horizon:content-area')(event, { top: 120, hidden: true });
  assert.equal(view.visible, false);
  handlers.get('horizon:content-area')(event, { top: 120, hidden: false });
  let resized;
  let jpegQuality;
  const image = (width, height) => ({
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    resize(options) { resized = options; return image(options.width, options.height); },
    toJPEG(quality) { jpegQuality = quality; return Buffer.from([width % 256, height % 256]); },
  });
  view.webContents.image = image(3200, 2200);
  assert.ok((await capture()) instanceof Uint8Array);
  assert.equal(jpegQuality, 80);
  assert.ok(resized.width <= view.bounds.width * 2);
  assert.ok(resized.height <= view.bounds.height * 2);
  resized = undefined;
  view.webContents.image = image(640, 400);
  assert.deepEqual(await capture(), Buffer.from([128, 144]));
  assert.equal(resized, undefined);
  const shortcutInput = key => ({ type: 'keyDown', key, control: false, alt: false, shift: false, meta: false });
  let preventedShortcut = false;
  const shortcutEvent = { preventDefault() { preventedShortcut = true; } };
  const sentBefore = window.webContents.sent.length;
  view.webContents.emit('before-input-event', shortcutEvent, shortcutInput('Escape'));
  assert.equal(preventedShortcut, false);
  assert.equal(window.webContents.sent.length, sentBefore);
  view.webContents.loading = true;
  view.webContents.emit('before-input-event', shortcutEvent, shortcutInput('Escape'));
  assert.equal(preventedShortcut, true);
  assert.deepEqual(window.webContents.sent.at(-1), ['horizon:shortcut', 'stop']);
  view.webContents.loading = false; preventedShortcut = false;
  view.webContents.emit('before-input-event', shortcutEvent, shortcutInput('F6'));
  assert.equal(preventedShortcut, true);
  assert.deepEqual(window.webContents.sent.at(-1), ['horizon:shortcut', 'focus-address']);
  command({ type: 'zoom', delta: 1 });
  assert.equal(state().tabs[0].zoom, 1.1);
  assert.equal(view.webContents.zoom, 1.1);
  command({ type: 'find', text: 'bread', forward: true, next: false });
  assert.equal(view.webContents.find.options.findNext, true);
  command({ type: 'find', text: 'bread', forward: false, next: true });
  assert.equal(view.webContents.find.options.findNext, false);
  view.webContents.emit('found-in-page', {}, { requestId: 6, activeMatchOrdinal: 1, matches: 2 });
  assert.equal(state().tabs[0].find.total, 0);
  view.webContents.emit('found-in-page', {}, { requestId: 7, activeMatchOrdinal: 1, matches: 2 });
  assert.deepEqual(state().tabs[0].find, { active: 1, total: 2 });
  view.webContents.emit('did-navigate', {}, 'https://example.com/', 200);
  view.webContents.title = 'Example';
  view.webContents.emit('page-title-updated', {}, 'Example');
  view.webContents.emit('did-navigate-in-page', {}, 'https://example.com/', true);
  assert.equal(state().store.history[0].visitCount, 2);
  assert.equal(state().store.history[0].title, 'Example');
  assert.equal(timers.size, 1);
  assert.equal(writes.length, 0);
  tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].history[0].title, 'Example');
  assert.equal(timers.size, 0);
  view.webContents.emit('page-title-updated', {}, 'Latest title');
  view.webContents.emit('page-title-updated', {}, 'Final title');
  assert.equal(timers.size, 1);
  assert.equal(writes.length, 1);
  writeFailure = true; tick();
  assert.equal(state().storageError, true);
  writeFailure = false;
  view.webContents.emit('page-title-updated', {}, 'Saved title');
  electron.app.emit('before-quit');
  assert.equal(timers.size, 0);
  assert.equal(writes.at(-1).history[0].title, 'Saved title');
  assert.equal(state().storageError, false);
  const flushedWrites = writes.length;
  electron.app.emit('before-quit');
  assert.equal(writes.length, flushedWrites);
  view.webContents.emit('did-navigate', {}, 'https://example.com/missing', 404);
  assert.equal(state().tabs[0].error, null);
  assert.equal(view.visible, true);
  command({ type: 'bookmark' });
  assert.equal(state().store.bookmarks.length, 1);
  command({ type: 'bookmark' });
  assert.equal(state().store.bookmarks.length, 0);
  tick();
  const originalStore = structuredClone(state().store);
  for (const kind of ['history', 'bookmarks', 'downloads']) {
    const before = structuredClone(state().store);
    const writesBefore = writes.length;
    command({ type: 'restore', kind });
    assert.deepEqual(state().store, before);
    assert.equal(timers.size, 0);
    assert.equal(writes.length, writesBefore);
  }
  const restoreStore = sampleStore(directory);
  for (const kind of ['history', 'bookmarks', 'downloads']) {
    const entry = restoreStore[kind][0];
    restoreStore[kind] = [entry, { ...entry, url: 'https://second.example/', ...(kind === 'downloads' ? { id: 'download-2' } : {}) }, { ...entry, url: 'https://third.example/', ...(kind === 'downloads' ? { id: 'download-3' } : {}) }];
  }
  for (const [destructive, kind] of [
    [{ type: 'delete-history', url: 'https://second.example/' }, 'history'],
    [{ type: 'clear-history' }, 'history'],
    [{ type: 'delete-bookmark', url: 'https://second.example/' }, 'bookmarks'],
    [{ type: 'remove-download', id: 'download-2' }, 'downloads'],
  ]) {
    Object.assign(state().store, structuredClone(restoreStore));
    command(destructive);
    const removed = structuredClone(state().store[kind]);
    assert.equal(removed.length, destructive.type === 'clear-history' ? 0 : 2);
    assert.equal([...timers.values()].filter(timer => timer.delay === 8000).length, 1);
    tick();
    assert.deepEqual(readStore(join(directory, 'browser-store.json'))[kind], removed);
    if (removed.length) state().store[kind][0].url = 'https://changed.example/';
    command({ type: 'restore', kind });
    assert.deepEqual(state().store[kind], restoreStore[kind]);
    assert.equal([...timers.values()].some(timer => timer.delay === 8000), false);
    tick();
    assert.deepEqual(readStore(join(directory, 'browser-store.json'))[kind], restoreStore[kind]);
    const writesAfterRestore = writes.length;
    command({ type: 'restore', kind });
    assert.deepEqual(state().store[kind], restoreStore[kind]);
    assert.equal(timers.size, 0);
    assert.equal(writes.length, writesAfterRestore);
    command(destructive);
    tick(); tick(8000);
    command({ type: 'restore', kind });
    assert.deepEqual(state().store[kind], removed);
    assert.equal(timers.size, 0);
  }
  Object.assign(state().store, structuredClone(restoreStore));
  command({ type: 'delete-history', url: 'https://second.example/' });
  const historyAfterDelete = structuredClone(state().store.history);
  command({ type: 'delete-bookmark', url: 'https://second.example/' });
  assert.equal([...timers.values()].filter(timer => timer.delay === 8000).length, 1);
  command({ type: 'restore', kind: 'history' });
  assert.deepEqual(state().store.history, historyAfterDelete);
  command({ type: 'restore', kind: 'bookmarks' });
  assert.deepEqual(state().store.bookmarks, restoreStore.bookmarks);
  command({ type: 'delete-history', url: 'https://third.example/' });
  command({ type: 'restore', kind: 'history' });
  assert.deepEqual(state().store.history, historyAfterDelete);
  Object.assign(state().store, originalStore);
  tick();
  assert.throws(() => command({ type: 'navigate', input: 'horizon://app/' }));
  for (const url of ['file:///private', 'horizon://app/', 'javascript:alert(1)', 'data:text/html,page', 'custom://example.com/']) {
    assert.deepEqual(view.webContents.popup({ url }), { action: 'deny' });
  }
  assert.equal(state().tabs.length, 1);
  const openerId = state().activeId;
  const background = view.webContents.popup({ url: 'https://example.com/background', disposition: 'background-tab' });
  assert.equal(background.action, 'allow');
  assert.equal(background.outlivesOpener, true);
  assert.equal(typeof background.createWindow, 'function');
  const guest = new Contents();
  assert.equal(background.createWindow({ webContents: guest }), guest);
  assert.equal(views.at(-1).webContents, guest);
  assert.deepEqual(views.at(-1).options.webPreferences, view.options.webPreferences);
  assert.equal(state().tabs.length, 2);
  assert.equal(state().activeId, openerId);
  assert.equal(views.at(-1).visible, false);
  guest.emit('did-navigate', {}, 'https://example.com/background', 200);
  guest.emit('page-title-updated', {}, 'Guest title');
  assert.equal(state().tabs.at(-1).title, 'Guest title');
  guest.close(); guest.emit('destroyed');
  assert.equal(state().tabs.length, 1);
  assert.equal(state().activeId, openerId);
  const foreground = view.webContents.popup({ url: 'https://example.com/popup', disposition: 'new-window' });
  const foregroundGuest = new Contents();
  assert.equal(foreground.createWindow({ webContents: foregroundGuest }), foregroundGuest);
  assert.notEqual(state().activeId, openerId);
  command({ type: 'close-tab', id: state().activeId });
  assert.equal(foregroundGuest.destroyed, true);
  assert.equal(state().tabs.length, 1);
  assert.equal(state().activeId, openerId);
  const fallback = view.webContents.popup({ url: 'https://example.com/fallback', disposition: 'background-tab' });
  const fallbackContents = fallback.createWindow({});
  assert.equal(fallbackContents.url, 'https://example.com/fallback');
  assert.equal(state().activeId, openerId);
  fallbackContents.close();
  view.webContents.emit('enter-html-full-screen');
  assert.equal(window.fullscreen, true);
  assert.equal(state().tabs[0].fullscreen, true);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 800, height: 600 });
  view.webContents.emit('leave-html-full-screen');
  assert.equal(window.fullscreen, false);
  assert.equal(state().tabs[0].fullscreen, false);
  assert.equal(view.bounds.y, 111);
  view.webContents.emit('enter-html-full-screen');
  command({ type: 'new-tab' });
  assert.equal(window.fullscreen, false);
  assert.equal(state().tabs[0].fullscreen, false);
  command({ type: 'close-tab', id: state().activeId });
  view.webContents.emit('enter-html-full-screen');
  const fullscreenPopup = view.webContents.popup({ url: 'https://example.com/popup', disposition: 'foreground-tab' });
  const fullscreenGuest = new Contents();
  fullscreenPopup.createWindow({ webContents: fullscreenGuest });
  assert.equal(window.fullscreen, false);
  assert.equal(state().tabs[0].fullscreen, false);
  fullscreenGuest.close();
  for (const permission of ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read']) webSession.request(null, permission, allowed => assert.equal(allowed, false, permission));
  webSession.request(null, 'fullscreen', allowed => assert.equal(allowed, true));
  assert.equal(webSession.check(), false);
  assert.equal(webSession.device(), false);
  for (const url of ['file:///private', 'horizon://app/', 'data:text/html,page']) webSession.network({ url, resourceType: 'mainFrame' }, result => assert.equal(result.cancel, true));
  webSession.network({ url: 'https://example.com/', resourceType: 'mainFrame' }, result => assert.equal(result.cancel, false));
  for (const url of ['http://example.com/', 'https://example.com/', 'about:blank', 'about:srcdoc', 'data:text/html,page', 'blob:https://example.com/id']) {
    webSession.network({ url, resourceType: 'subFrame' }, result => assert.equal(result.cancel, false, url));
  }
  for (const url of ['file:///private', 'horizon://app/', 'javascript:alert(1)', 'chrome://settings/', 'custom://example.com/']) {
    webSession.network({ url, resourceType: 'subFrame' }, result => assert.equal(result.cancel, true, url));
  }
  let blocked = false;
  webSession.emit('will-download', { preventDefault() { blocked = true; } }, {}, window.webContents);
  assert.equal(blocked, true);
  class Download extends EventEmitter {
    getFilename() { return 'report.pdf'; }
    getURL() { return 'https://example.com/report.pdf'; }
    getTotalBytes() { return 100; }
    getReceivedBytes() { return 50; }
    setSavePath(path) { this.path = path; }
    cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled'); }
  }
  const downloadPopup = view.webContents.popup({ url: 'about:blank', disposition: 'background-tab' });
  const downloadGuest = new Contents();
  downloadPopup.createWindow({ webContents: downloadGuest });
  const transientDownload = new Download();
  const allowed = { preventDefault() { assert.fail('Valid web download was blocked'); } };
  webSession.emit('will-download', allowed, transientDownload, downloadGuest);
  assert.equal(state().tabs.length, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state().tabs.length, 1);
  assert.equal(downloadGuest.destroyed, true);
  assert.equal(transientDownload.cancelled, undefined);
  transientDownload.emit('updated', {}, 'progressing');
  transientDownload.emit('done', {}, 'completed');
  const transientEntry = state().store.downloads.find(entry => entry.path === transientDownload.path);
  assert.equal(transientEntry.status, 'completed');
  command({ type: 'remove-download', id: transientEntry.id });
  const first = new Download(), second = new Download();
  webSession.emit('will-download', allowed, first, view.webContents);
  webSession.emit('will-download', allowed, second, view.webContents);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state().tabs.length, 1);
  assert.equal(view.webContents.destroyed, false);
  assert.notEqual(first.path, second.path);
  first.emit('updated', {}, 'progressing');
  assert.equal(state().store.downloads.find(entry => entry.path === first.path).received, 50);
  second.emit('done', {}, 'completed');
  const completed = state().store.downloads.find(entry => entry.path === second.path);
  command({ type: 'show-download', id: completed.id });
  assert.deepEqual(shown, [second.path]);
  state().store.downloads.push({ ...completed, id: 'unsafe', filename: '..', path: directory });
  assert.throws(() => command({ type: 'show-download', id: 'unsafe' }));
  state().store.downloads.pop();
  command({ type: 'remove-download', id: completed.id });
  const progressing = state().store.downloads[0];
  command({ type: 'cancel-download', id: progressing.id });
  assert.equal(state().store.downloads[0].status, 'cancelled');
  view.webContents.emit('did-fail-load', {}, -105, "ERR_NAME_NOT_RESOLVED (-105) loading 'https://example.com/'", 'https://example.com/', true);
  assert.equal(view.visible, false);
  assert.equal(state().tabs[0].error, 'ERR_NAME_NOT_RESOLVED');
  const capturesBeforeError = view.webContents.captures;
  assert.equal(await capture(), null);
  assert.equal(view.webContents.captures, capturesBeforeError);
  command({ type: 'reload' });
  assert.equal(state().tabs[0].error, null);
  view.webContents.loadError = "ERR_CONNECTION_REFUSED (-102) loading 'https://example.com/'";
  command({ type: 'navigate', input: 'example.com' });
  await Promise.resolve();
  assert.equal(state().tabs[0].error, 'ERR_CONNECTION_REFUSED');
  view.webContents.loadError = undefined;
  command({ type: 'reload' });
  view.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(state().tabs[0].error, 'RENDERER_GONE');
  command({ type: 'reload' });
  assert.equal(state().tabs[0].error, null);
  view.webContents.emit('enter-html-full-screen');
  view.webContents.close();
  assert.equal(window.fullscreen, false);
  assert.equal(state().tabs.length, 1);
  assert.equal(state().tabs[0].url, '');
  const replacementId = state().activeId;
  view.webContents.emit('destroyed');
  assert.equal(state().activeId, replacementId);
  assert.equal(state().tabs.length, 1);
  assert.equal(await capture(), null);
  command({ type: 'navigate', input: 'example.com' });
  const shutdownView = views.at(-1);
  shutdownView.webContents.emit('did-navigate', {}, 'https://example.com/', 200);
  const shutdownDownload = new Download();
  webSession.emit('will-download', allowed, shutdownDownload, shutdownView.webContents);
  command({ type: 'new-tab' });
  assert.equal(shutdownView.visible, false);
  for (let index = state().tabs.length; index < 200; index++) command({ type: 'new-tab' });
  assert.deepEqual(view.webContents.popup({ url: 'https://example.com/' }), { action: 'deny' });
  assert.equal(state().tabs.length, 200);
  window.emit('closed');
  assert.equal(timers.size, 0);
  assert.equal(writes.at(-1).downloads[0].status, 'cancelled');
  assert.equal(shutdownDownload.cancelled, true);
  assert.equal(electron.app.listenerCount('before-quit'), 0);
  assert.equal(view.webContents.destroyed, true);
  assert.equal(handlers.size, 0);
});
