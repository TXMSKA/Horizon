const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, symlinkSync, rmSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { validateSender, secureSession, hardenContents, CONTENT_SECURITY_POLICY } = require('../dist/electron/security.js');
const { serveHorizon } = require('../dist/electron/protocol.js');
const { classifyInput, isAllowedURL, isAllowedSubframeURL, isWebURL, parseErrorName } = require('../dist/electron/browsing.js');
const { validateStore, readStore, writeStore, reserveDownloadPath } = require('../dist/electron/store.js');
const { validateCommand, validateContentArea } = require('../dist/electron/commands.js');
const { createSettings, readSettings, writeSettings, validateSettings } = require('../dist/electron/settings.js');
const { fetchFavicon, readFavicon, isFaviconURL, FAVICON_LIMIT } = require('../dist/electron/favicon.js');
const { browserShortcut } = require('../dist/src/shared/shortcuts.js');
const { cleanupPartitions, makeProfile, migrateStore, profileStorePath, readRegistry, validateRegistry, writeRegistry, removeProfileDirectory } = require('../dist/electron/profiles.js');
const { randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');
const { contextMenuGroups, PageMenuSession } = require('../dist/electron/context-menu.js');
const { PermissionQueue, defaultPermissions, requestedPermissions, setPermission, setBlocking, siteSettings, stripCookieHeaders, cookieSite, secureOrigin, SITE_SETTINGS_LIMIT } = require('../dist/electron/site-settings.js');

function menuParams(overrides = {}) {
  return {
    x: 25, y: 50, linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false,
    dictionarySuggestions: [], menuSourceType: 'mouse',
    editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: true, canPaste: true, canSelectAll: true },
    ...overrides,
  };
}
const menuNavigation = { back: true, forward: false, reload: true };

test('page menus contain only applicable groups and preserve enabled edit and navigation flags', () => {
  const rows = (ids, enabled = true) => ids.map(id => ({ id, enabled }));
  assert.deepEqual(contextMenuGroups(menuParams({ linkURL: 'https://example.com/' }), menuNavigation), [rows(['open-link', 'copy-link'])]);
  assert.deepEqual(contextMenuGroups(menuParams({ mediaType: 'image', srcURL: 'http://example.com/image.png' }), menuNavigation), [rows(['open-image', 'save-image', 'copy-image', 'copy-image-address'])]);
  assert.deepEqual(contextMenuGroups(menuParams({ selectionText: 'Selected text' }), menuNavigation), [rows(['copy', 'search-selection'])]);
  assert.deepEqual(contextMenuGroups(menuParams({ isEditable: true, selectionText: 'In a field', dictionarySuggestions: ['word', 'ward', 'word'] }), menuNavigation), [
    rows(['spell:word', 'spell:ward']), [...rows(['undo', 'redo', 'cut'], false), ...rows(['copy', 'paste', 'select-all'])],
  ]);
  const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: false, canPaste: false, canSelectAll: false };
  assert.deepEqual(contextMenuGroups(menuParams({ isEditable: true, editFlags: flags }), menuNavigation), [[
    { id: 'undo', enabled: true }, { id: 'redo', enabled: false }, { id: 'cut', enabled: true },
    { id: 'copy', enabled: false }, { id: 'paste', enabled: false }, { id: 'select-all', enabled: false },
  ]]);
  assert.deepEqual(contextMenuGroups(menuParams(), menuNavigation), [[{ id: 'back', enabled: true }, { id: 'forward', enabled: false }, { id: 'reload', enabled: true }]]);
  const combined = menuParams({ linkURL: 'https://example.com/', mediaType: 'image', srcURL: 'https://example.com/photo', selectionText: 'caption' });
  assert.deepEqual(contextMenuGroups(combined, menuNavigation), [rows(['open-link', 'copy-link']), rows(['open-image', 'save-image', 'copy-image', 'copy-image-address']), rows(['copy', 'search-selection'])]);
});

test('page menus drop every URL action for unsafe links and images', () => {
  for (const url of ['javascript:alert(1)', 'file:///private', 'horizon://app/', 'data:image/png,bytes', 'blob:https://example.com/image', 'about:blank', 'https://user@example.com/', ' https://example.com/', 'https://example.com/' + 'a'.repeat(8192)]) {
    assert.deepEqual(contextMenuGroups(menuParams({ linkURL: url }), menuNavigation), [], url);
    assert.deepEqual(contextMenuGroups(menuParams({ mediaType: 'image', srcURL: url }), menuNavigation), [], url);
    assert.deepEqual(contextMenuGroups(menuParams({ linkURL: url, selectionText: 'Keep this selection' }), menuNavigation).flat().map(row => row.id), ['copy', 'search-selection']);
  }
});

test('page menu sessions expose only display data and reject stale, unknown, disabled or mismatched actions', () => {
  const session = new PageMenuSession();
  const original = menuParams({ linkURL: 'https://private.example/path', selectionText: '😀'.repeat(45), menuSourceType: 'keyboard' });
  const first = session.open('tab', original, menuNavigation, { x: 5, y: 100 }, 0.75);
  assert.deepEqual(Object.keys(first).sort(), ['groups', 'id', 'keyboard', 'selection', 'x', 'y']);
  assert.equal(first.x, 40); assert.equal(first.y, 200); assert.equal(first.keyboard, true);
  assert.equal(Array.from(first.selection).length, 40);
  assert.equal(JSON.stringify(first).includes('private.example'), false);
  assert.throws(() => session.take('unknown', 'copy-link', 'tab'));
  assert.throws(() => session.take(first.id, 'unknown', 'tab'));
  assert.throws(() => session.take(first.id, 'copy-link', 'other'));
  original.linkURL = 'https://changed.example/';
  first.groups[0][0].enabled = false;
  assert.equal(session.take(first.id, 'open-link', 'tab').linkURL, 'https://private.example/path');
  assert.throws(() => session.take(first.id, 'copy-link', 'tab'));
  const second = session.open('tab', menuParams(), menuNavigation, { x: 0, y: 0 }, 1);
  assert.notEqual(second.id, first.id);
  assert.throws(() => session.take(second.id, 'forward', 'tab'));
  const third = session.open('tab', menuParams({ isEditable: true, dictionarySuggestions: ['word'] }), menuNavigation, { x: 0, y: 0 }, 1);
  assert.throws(() => session.take(second.id, 'back', 'tab'));
  assert.throws(() => session.take(third.id, 'spell:other', 'tab'));
  assert.equal(session.invalidate('other'), false);
  assert.equal(session.invalidate('tab'), true);
  assert.throws(() => session.take(third.id, 'spell:word', 'tab'));
  const fourth = session.open('tab', menuParams(), menuNavigation, { x: 0, y: 0 }, 1);
  assert.throws(() => session.dismiss('unknown'));
  session.dismiss(fourth.id);
  assert.throws(() => session.take(fourth.id, 'back', 'tab'));
});

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

test('shared menus clamp through CSSOM, focus by input source and keep the enabled keyboard path', () => {
  const { compileFunction } = require('node:vm');
  const { transpileModule, ModuleKind, JsxEmit } = require('typescript');
  const source = transpileModule(readFileSync('src/Menu.tsx', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  for (const keyboard of [false, true]) for (const profile of [false, true]) {
    const callbacks = new Map(), styles = new Map(), effects = [], cleanups = [], dismissed = [];
    const document = { activeElement: null, addEventListener(name, handler) { callbacks.set(name, handler); }, removeEventListener(name) { callbacks.delete(name); } };
    const items = [0, 1, 2].map(id => ({ id, focus() { document.activeElement = this; } }));
    const menu = {
      focus() { document.activeElement = this; }, contains(target) { return target === this || items.includes(target); },
      querySelector(selector) { if (selector === '[aria-checked=true]') return items[1]; assert.ok(selector.includes(':not(:disabled)')); return items[0]; },
      querySelectorAll(selector) { assert.ok(selector.includes(':not(:disabled)')); return items; },
      getBoundingClientRect() { return { width: 300, height: 200 }; },
      style: { setProperty(name, value) { styles.set(name, value); } },
      setAttribute() { assert.fail('Inline style attributes are forbidden'); },
    };
    const window = { addEventListener(name, handler) { callbacks.set(name, handler); }, removeEventListener(name) { callbacks.delete(name); } };
    const react = { useRef(value) { return { current: value === null ? menu : value }; }, useEffect(effect) { effects.push(effect); }, useLayoutEffect(effect) { effects.push(effect); } };
    class ResizeObserver { constructor(callback) { this.callback = callback; } observe() { this.callback(); } disconnect() {} }
    const exported = {};
    compileFunction(source, ['exports', 'require', 'document', 'window', 'ResizeObserver', 'innerWidth', 'innerHeight'])(exported, name => {
      if (name === 'react') return react;
      assert.equal(name, 'react/jsx-runtime'); return { jsx(type, props) { return { type, props }; } };
    }, document, window, ResizeObserver, 800, 600);
    const opener = {};
    const rendered = exported.Menu({ id: 'page-menu', label: 'Page menu', keyboard, initialFocus: profile ? '[aria-checked=true]' : undefined, className: profile ? 'profiles-menu' : undefined, point: { x: 790, y: 590 }, opener: { current: { contains: target => target === opener } }, onDismiss: reason => dismissed.push(reason), children: [] });
    effects.forEach(effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
    assert.equal(rendered.props.role, 'menu'); assert.equal(rendered.props['aria-label'], 'Page menu');
    assert.equal(document.activeElement, keyboard ? items[profile ? 1 : 0] : menu);
    assert.equal(styles.get('left'), '490px'); assert.equal(styles.get('top'), '390px');
    const press = key => {
      const event = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      rendered.props.onKeyDown(event); return event;
    };
    document.activeElement = menu;
    assert.equal(press('ArrowUp').prevented, true); assert.equal(document.activeElement, items[2]);
    press('ArrowDown'); assert.equal(document.activeElement, items[0]);
    press('End'); assert.equal(document.activeElement, items[2]);
    press('Home'); assert.equal(document.activeElement, items[0]);
    assert.equal(press('Enter').prevented, false); assert.equal(press(' ').prevented, false);
    const escape = press('Escape'); assert.equal(escape.prevented, true); assert.equal(escape.stopped, true);
    assert.equal(press('Tab').prevented, false);
    callbacks.get('pointerdown')({ target: menu }); callbacks.get('pointerdown')({ target: opener });
    assert.deepEqual(dismissed, ['escape', 'tab']);
    callbacks.get('pointerdown')({ target: {} }); assert.deepEqual(dismissed, ['escape', 'tab', 'outside']);
    cleanups.forEach(cleanup => cleanup()); assert.equal(callbacks.size, 0);
  }
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
    version: 2,
    siteSettings: { blocking: [], permissions: [] },
    history: [{ url: 'https://example.com/', title: 'Example', lastVisit: 1, visitCount: 2 }],
    bookmarks: [{ url: 'https://example.com/', title: 'Example', createdAt: 1 }],
    downloads: [{ id: 'download-1', url: 'https://example.com/file', filename: 'file.txt', path: join(directory, 'file.txt'), received: 3, total: 3, status: 'completed', startedAt: 1 }],
  };
}

test('store schema rejects unsafe URLs, shapes, statuses, paths, and unbounded fields', (t) => {
  const directory = temporaryDirectory(t, 'schema');
  assert.equal(validateStore(sampleStore(directory)), true);
  assert.equal(validateStore({ version: 2, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], permissions: [] } }), true);
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
  assert.deepEqual(readStore(path), { version: 2, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], permissions: [] } });
  assert.ok(existsSync(path));
  const store = sampleStore(directory);
  writeStore(path, store);
  assert.deepEqual(readStore(path), store);
  assert.equal(readdirSync(join(directory, 'profile')).some(name => name.endsWith('.tmp')), false);
  assert.throws(() => writeStore(path, { ...store, version: 3 }));
  assert.deepEqual(readStore(path), store);
  for (const corrupt of ['{broken json', JSON.stringify({ ...store, version: 3 })]) {
    writeFileSync(path, corrupt);
    assert.deepEqual(readStore(path), { version: 2, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], permissions: [] } });
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
    { type: 'new-tab' }, { type: 'new-tab', input: 'example.com' }, { type: 'new-tab', input: 'example.com', background: true }, { type: 'new-tab', background: false },
    { type: 'context-menu', id: 'menu', item: 'open-link' }, { type: 'context-menu', id: 'menu', item: 'spell:word' }, { type: 'dismiss-context-menu', id: 'menu' }, { type: 'open-downloads-folder' },
    { type: 'navigate', input: 'bread recipes' },
    { type: 'activate-tab', id: 'tab-1' }, { type: 'close-tab', id: 'tab-1' },
    { type: 'zoom', delta: -1 }, { type: 'zoom', delta: 0 }, { type: 'zoom', delta: 1 },
    { type: 'find', text: '', forward: false, next: false },
    { type: 'find', text: 'recipe', forward: true, next: true },
    { type: 'rename-bookmark', url: 'https://example.com/', title: 'Example' },
    ...['back', 'forward', 'reload', 'stop', 'bookmark', 'focus-page', 'stop-find', 'clear-history'].map(type => ({ type })),
    ...['delete-history', 'delete-bookmark'].map(type => ({ type, url: 'https://example.com/' })),
    ...['cancel-download', 'show-download', 'remove-download'].map(type => ({ type, id: 'download-1' })),
    ...['standard', 'high'].map(value => ({ type: 'contrast', value })),
    ...['system', 'amber', 'daylight'].flatMap(value => [{ type: 'theme', value }, { type: 'migrate-theme', value }]),
    ...['history', 'bookmarks', 'downloads'].map(kind => ({ type: 'restore', kind })),
  ];
  for (const command of commands) {
    assert.deepEqual(validateCommand(command), command);
    assert.throws(() => validateCommand({ ...command, unexpected: true }));
  }
  const invalid = [{ type: 'contrast' }, { type: 'contrast', value: true }, { type: 'contrast', value: 'dark' }, { type: 'theme', value: 'dark' }, { type: 'migrate-theme', value: null }, { type: 'theme' }, null, [], {}, { type: 'execute' }, { type: 'new-tab', input: '' },
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
  invalid.push(...[null, 1, 'true', {}, []].map(background => ({ type: 'new-tab', background })),
    { type: 'context-menu', id: '', item: 'copy' }, { type: 'context-menu', id: 'x'.repeat(129), item: 'copy' },
    { type: 'context-menu', id: 'menu', item: 'unknown' }, { type: 'context-menu', id: 'menu', item: 'spell:' },
    { type: 'context-menu', id: 'menu', item: 'spell:' + 'x'.repeat(257) }, { type: 'context-menu', id: 'menu', item: 'spell:\0' },
    { type: 'context-menu', id: 'menu', item: 'copy', url: 'https://evil.example/' }, { type: 'dismiss-context-menu' },
    { type: 'open-downloads-folder', path: 'C:\\private' });
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
  const clipboardText = [];
  const openedFolders = [];
  const timers = new Map();
  const writes = [];
  let writeFailure = false;
  let registryWriteFailure = false;
  let cleanupFailure = false;
  const storageErrors = [];
  const blockingCalls = [];
  let mockCosmetics = false;
  let mockBlockingReady = true;
  t.mock.method(console, 'error', (...args) => storageErrors.push(args));
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
  let nextContentsId = 0;
  class Contents extends EventEmitter {
    constructor(targetSession) {
      super();
      this.id = ++nextContentsId;
      this.targetSession = targetSession;
      this.mainFrame = { url: 'horizon://app/' };
      this.zoom = 0.75;
      this.destroyed = false;
      this.loading = false;
      this.sent = [];
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    }
    get session() { return this.targetSession || webSession; }
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
    reload() { this.reloads = (this.reloads || 0) + 1; }
    reloadIgnoringCache() { this.reloads = (this.reloads || 0) + 1; this.bypassedCache = (this.bypassedCache || 0) + 1; }
    insertCSS(css, options) { this.css = { css, options }; return Promise.resolve("css-key"); }
    undo() { this.edited = 'undo'; }
    redo() { this.edited = 'redo'; }
    cut() { this.edited = 'cut'; }
    copy() { this.edited = 'copy'; }
    paste() { this.edited = 'paste'; }
    selectAll() { this.edited = 'select-all'; }
    replaceMisspelling(word) { this.replacement = word; }
    copyImageAt(x, y) { this.copiedImage = { x, y }; }
    downloadURL(url) { this.downloaded = url; }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = options.webContents || new Contents(sessions.get(options.webPreferences.partition)); views.push(this); }
    setVisible(visible) { this.visible = visible; }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
  }
  const sessions = new Map();
  const webSession = new EventEmitter();
  const prepareMockSession = target => {
    target.cleared = [];
    target.setPermissionRequestHandler = handler => { target.request = handler; };
    target.setPermissionCheckHandler = handler => { target.check = handler; };
    target.setDevicePermissionHandler = handler => { target.device = handler; };
    target.listeners = {};
    target.webRequest = Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred'].map(name => [name, handler => {
      if (handler) target.listeners[name] = (target.listeners[name] || 0) + 1;
      target[{onBeforeRequest:'network', onBeforeSendHeaders:'sendHeaders', onHeadersReceived:'receiveHeaders', onCompleted:'completed', onErrorOccurred:'requestError'}[name]] = handler;
    }]));
    for (const name of ['clearStorageData', 'closeAllConnections', 'clearCache', 'clearAuthCache', 'clearCodeCaches']) target[name] = async () => { target.cleared.push(name); };
    return target;
  };
  sessions.set('persist:web', prepareMockSession(webSession));
  const electron = {
    app: Object.assign(new EventEmitter(), { getLocale: () => 'en', getPath: () => directory }),
    nativeImage: { createFromBuffer() { assert.fail('Privileged favicon decoding is forbidden'); } },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } },
    session: { fromPartition(name) { if (!sessions.has(name)) sessions.set(name, prepareMockSession(new EventEmitter())); return sessions.get(name); } },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { showItemInFolder(path) { shown.push(path); }, async openPath(path) { openedFolders.push(path); return ''; } },
    clipboard: { writeText(value) { clipboardText.push(value); } },
    screen: { getDisplayMatching() { return { scaleFactor: 2 }; } },
    WebContentsView: View,
  };
  const filename = resolve('dist/electron/browser.js');
  const localRequire = createRequire(filename);
  const loaded = { exports: {} };
  compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname', 'setTimeout', 'clearTimeout'])(loaded.exports,
    name => name === 'electron' ? electron : name === './blocking' ? { createBlockingEngine() { return {
      get ready() { return mockBlockingReady; }, start: async () => {}, stop() {}, cosmeticCSS: () => mockCosmetics ? '.advert {display:none!important;}' : '',
      match(url) { blockingCalls.push(url); return url.includes('/blocked-ad') ? { kind: 'ads' } : url.includes('/blocked-tracker') ? { kind: 'trackers' } : undefined; },
    }; } } : name === './store' ? { ...localRequire(name), writeStore(path, store, cipher) {
      if (writeFailure) throw new Error('Disk unavailable');
      writes.push(structuredClone(store)); localRequire(name).writeStore(path, store, cipher);
    } } : name === './profiles' ? { ...localRequire(name), writeRegistry(path, registry) {
      if (registryWriteFailure) throw new Error('Registry unavailable');
      localRequire(name).writeRegistry(path, registry);
    }, removeProfileDirectory(root, id) {
      if (cleanupFailure) throw new Error('Store folder unavailable');
      localRequire(name).removeProfileDirectory(root, id);
    } } : localRequire(name), loaded, filename, require('node:path').dirname(filename), schedule, clear);
  const window = new EventEmitter();
  window.webContents = new Contents();
  window.isDestroyed = () => false;
  let windowFocused = true;
  window.isFocused = () => windowFocused;
  window.getContentBounds = () => ({ width: 800, height: 600 });
  window.setFullScreen = fullscreen => { window.fullscreen = fullscreen; };
  window.setTitle = title => { window.title = title; };
  window.contentView = { addChildView() {}, removeChildView() {} };
  const themes = [];
  const settings = createSettings(join(directory, 'settings.json'), value => themes.push(value));
  const browser = loaded.exports.createBrowser(window, directory, join(directory, 'downloads'), settings);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const state = () => handlers.get('horizon:state')(event);
  const command = value => handlers.get('horizon:command')(event, value);
  const capture = (...args) => handlers.get('horizon:capture')(event, ...args);
  assert.equal(state().tabs.length, 1);
  assert.equal(window.title, 'Horizon');
  assert.equal(state().theme, 'system');
  command({ type: 'theme', value: 'amber' });
  assert.equal(state().theme, 'amber');
  assert.deepEqual(themes, ['amber']);
  assert.equal(state().contrast, 'standard');
  command({ type: 'contrast', value: 'high' });
  assert.equal(state().contrast, 'high');
  assert.equal(readSettings(join(directory, 'settings.json')).contrast, 'high');
  command({ type: 'contrast', value: 'standard' });
  assert.equal(state().contrast, 'standard');
  command({ type: 'migrate-theme', value: 'daylight' });
  assert.equal(state().theme, 'amber');
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
  const originalTab = state().activeId;
  const openMenu = (params = menuParams()) => {
    view.webContents.emit('context-menu', {}, params);
    const [channel, menu] = window.webContents.sent.at(-1);
    assert.equal(channel, 'horizon:context-menu');
    return menu;
  };
  const menuAction = (menu, item) => command({ type: 'context-menu', id: menu.id, item });
  let menu = openMenu(menuParams({ linkURL: 'https://example.com/link', menuSourceType: 'keyboard' }));
  assert.equal(menu.keyboard, true);
  assert.equal(menu.x, 25 / 0.92); assert.equal(menu.y, (50 + 111) / 0.92);
  assert.equal(window.webContents.focused, true);
  assert.equal(Object.hasOwn(menu, 'linkURL'), false);
  assert.throws(() => command({ type: 'context-menu', id: 'unknown', item: 'copy-link' }));
  assert.throws(() => menuAction(menu, 'copy-image'));
  menuAction(menu, 'copy-link');
  assert.equal(clipboardText.at(-1), 'https://example.com/link');
  assert.throws(() => menuAction(menu, 'copy-link'));
  menu = openMenu(menuParams({ linkURL: 'https://example.com/background-link' }));
  menuAction(menu, 'open-link');
  assert.equal(state().activeId, originalTab);
  assert.equal(views.at(-1).webContents.url, 'https://example.com/background-link');
  command({ type: 'close-tab', id: state().tabs.at(-1).id });
  menu = openMenu(menuParams({ mediaType: 'image', srcURL: 'https://example.com/photo.png' }));
  menuAction(menu, 'open-image');
  assert.notEqual(state().activeId, originalTab);
  assert.equal(views.at(-1).webContents.url, 'https://example.com/photo.png');
  command({ type: 'close-tab', id: state().activeId });
  for (const action of ['save-image', 'copy-image', 'copy-image-address']) {
    menuAction(openMenu(menuParams({ mediaType: 'image', srcURL: 'https://example.com/photo.png' })), action);
  }
  assert.equal(view.webContents.downloaded, 'https://example.com/photo.png');
  assert.deepEqual(view.webContents.copiedImage, { x: 25, y: 50 });
  assert.equal(clipboardText.at(-1), 'https://example.com/photo.png');
  menuAction(openMenu(menuParams({ selectionText: 'selected text' })), 'copy');
  assert.equal(clipboardText.at(-1), 'selected text');
  menuAction(openMenu(menuParams({ selectionText: 'https://example.com/search & mañana' })), 'search-selection');
  assert.equal(views.at(-1).webContents.url, 'https://duckduckgo.com/?q=https%3A%2F%2Fexample.com%2Fsearch%20%26%20ma%C3%B1ana');
  assert.notEqual(state().activeId, originalTab);
  command({ type: 'close-tab', id: state().activeId });
  menuAction(openMenu(menuParams({ selectionText: '😀'.repeat(20000) })), 'search-selection');
  assert.ok(views.at(-1).webContents.url.length <= 8192);
  command({ type: 'close-tab', id: state().activeId });
  const editFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
  for (const action of ['undo', 'redo', 'cut', 'copy', 'paste', 'select-all']) {
    menuAction(openMenu(menuParams({ isEditable: true, editFlags })), action);
    assert.equal(view.webContents.edited, action);
  }
  menu = openMenu(menuParams({ isEditable: true, dictionarySuggestions: ['correct', 'another'] }));
  assert.throws(() => menuAction(menu, 'spell:injected'));
  menuAction(menu, 'spell:correct');
  assert.equal(view.webContents.replacement, 'correct');
  menu = openMenu();
  assert.throws(() => menuAction(menu, 'back'));
  const stale = menu;
  menu = openMenu(menuParams({ selectionText: 'new selection' }));
  assert.throws(() => menuAction(stale, 'reload'));
  command({ type: 'dismiss-context-menu', id: menu.id });
  assert.throws(() => menuAction(menu, 'copy'));
  for (const navigation of [() => view.webContents.emit('did-start-navigation', {}, 'https://example.com/next', false, true), () => view.webContents.emit('did-start-navigation', {}, 'https://example.com/#part', true, true), () => view.webContents.emit('did-start-navigation', {}, 'https://frame.example/', false, false)]) {
    menu = openMenu(); navigation();
    assert.deepEqual(window.webContents.sent.findLast(([channel]) => channel === 'horizon:context-menu'), ['horizon:context-menu', null]);
    assert.throws(() => menuAction(menu, 'reload'));
  }
  menu = openMenu();
  command({ type: 'new-tab' });
  assert.throws(() => menuAction(menu, 'reload'));
  command({ type: 'close-tab', id: state().activeId });
  command({ type: 'new-tab', input: 'https://example.com/background', background: true });
  assert.equal(state().activeId, originalTab);
  const backgroundId = state().tabs.at(-1).id;
  menu = openMenu();
  command({ type: 'activate-tab', id: backgroundId });
  assert.throws(() => menuAction(menu, 'reload'));
  command({ type: 'close-tab', id: backgroundId });
  await command({ type: 'open-downloads-folder' });
  assert.deepEqual(openedFolders, [join(directory, 'downloads')]);
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
  assert.equal(window.title, 'Example - Horizon');
  view.webContents.emit('did-navigate-in-page', {}, 'https://example.com/', true);
  assert.equal(state().store.history[0].visitCount, 2);
  assert.equal(state().store.history[0].title, 'Example');
  assert.equal(timers.size, 1);
  assert.equal(writes.length, 0);
  tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].history[0].title, 'Example');
  assert.equal(timers.size, 0);

  const favicon = (...args) => handlers.get('horizon:favicon')(event, ...args);
  for (const args of [[], ['tab'], ['', 'a'.repeat(32)], [state().activeId, 'invalid'], [state().activeId, 'a'.repeat(32), 'extra']]) assert.throws(() => favicon(...args));
  assert.throws(() => handlers.get('horizon:favicon')({ ...event, sender: {} }, state().activeId, 'a'.repeat(32)));
  assert.throws(() => favicon('unknown', 'a'.repeat(32)));
  webSession.fetch = async () => new Response(faviconPNG);
  view.webContents.emit('page-favicon-updated', {}, ['https://example.com/icon.png']);
  await new Promise(resolve => setImmediate(resolve));
  const hash = state().tabs[0].favicon;
  assert.match(hash, /^[a-f0-9]{32}$/);
  assert.deepEqual(favicon(state().activeId, hash), faviconPNG);
  assert.equal(favicon(state().activeId, 'a'.repeat(32)), null);
  let delayed;
  webSession.fetch = () => new Promise(resolve => { delayed = resolve; });
  view.webContents.emit('page-favicon-updated', {}, ['https://example.com/slow.png']);
  command({ type: 'navigate', input: 'other.example' });
  assert.equal(state().tabs[0].favicon, null);
  assert.equal(favicon(state().activeId, hash), null);
  delayed(new Response(faviconPNG));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state().tabs[0].favicon, null);
  webSession.fetch = async () => new Response(faviconPNG);
  view.webContents.emit('did-navigate', {}, 'https://example.com/', 200);
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
    Object.assign(state().store, structuredClone(restoreStore), { siteSettings: state().store.siteSettings });
    command(destructive);
    const removed = structuredClone(state().store[kind]);
    assert.equal(removed.length, destructive.type === 'clear-history' ? 0 : 2);
    assert.equal([...timers.values()].filter(timer => timer.delay === 8000).length, 1);
    tick();
    assert.deepEqual(readStore(profileStorePath(directory, state().activeProfileId))[kind], removed);
    if (removed.length) state().store[kind][0].url = 'https://changed.example/';
    command({ type: 'restore', kind });
    assert.deepEqual(state().store[kind], restoreStore[kind]);
    assert.equal([...timers.values()].some(timer => timer.delay === 8000), false);
    tick();
    assert.deepEqual(readStore(profileStorePath(directory, state().activeProfileId))[kind], restoreStore[kind]);
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
  Object.assign(state().store, structuredClone(restoreStore), { siteSettings: state().store.siteSettings });
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
  Object.assign(state().store, originalStore, { siteSettings: state().store.siteSettings });
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
  const activeWindowTitle = window.title;
  guest.emit('page-title-updated', {}, 'Guest title');
  assert.equal(window.title, activeWindowTitle);
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
  menu = openMenu();
  assert.equal(menu.y, 50 / 0.92);
  handlers.get('horizon:content-area')(event, { top: 120, hidden: true });
  assert.equal(view.visible, false);
  command({ type: 'dismiss-context-menu', id: menu.id });
  assert.equal(view.visible, false, 'Fullscreen stays behind chrome until its snapshot is released');
  handlers.get('horizon:content-area')(event, { top: 120, hidden: false });
  assert.equal(view.visible, true);
  window.webContents.focused = false;
  handlers.get('horizon:content-area')(event, { top: 120, hidden: true });
  assert.equal(view.visible, false, 'Every chrome overlay can cover fullscreen without a page context menu');
  assert.equal(window.webContents.focused, true);
  window.webContents.focused = false;
  handlers.get('horizon:content-area')(event, { top: 120, hidden: true });
  assert.equal(window.webContents.focused, false, 'Only the page giving way moves the keyboard to chrome');
  view.webContents.emit('focus');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.webContents.focused, true, 'A hidden page hands the keyboard back to chrome');
  handlers.get('horizon:content-area')(event, { top: 120, hidden: false });
  window.webContents.focused = false; windowFocused = false;
  handlers.get('horizon:content-area')(event, { top: 120, hidden: true });
  assert.equal(window.webContents.focused, false, 'An unfocused window never takes the keyboard');
  windowFocused = true;
  handlers.get('horizon:content-area')(event, { top: 120, hidden: false });
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
  assert.ok(Object.values(webSession.listeners).every(count => count === 1));
  const network = (url, resourceType = 'script', id = 101) => {
    let result;
    webSession.network({ id, webContentsId: view.webContents.id, url, resourceType }, value => { result = value; });
    return result;
  };
  mockCosmetics = true;
  view.webContents.mainFrame.url = 'https://example.com/';
  view.webContents.emit('did-start-navigation', {}, 'https://example.com/', false, true);
  view.webContents.emit('did-navigate', {}, 'https://example.com/');
  assert.equal(view.visible, false, 'The view waits for CSS installation');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.visible, true); assert.equal(view.webContents.css.options.cssOrigin, 'user');
  assert.equal(state().blockingReady, true);
  const callsBeforeScheme = blockingCalls.length;
  assert.equal(network('file:///blocked-ad').cancel, true);
  assert.equal(blockingCalls.length, callsBeforeScheme, 'Scheme rules precede filter matching');
  assert.equal(network('https://ads.example/blocked-ad', 'script', 102).cancel, true);
  assert.equal(network('https://track.example/blocked-tracker', 'script', 103).cancel, true);
  assert.deepEqual(state().tabs[0].blocked, { ads: 1, trackers: 1, cookies: 0 });
  const cookieRequest = { id: 104, webContentsId: view.webContents.id, resourceType: 'xhr', url: 'https://third.test/pixel' };
  network(cookieRequest.url, 'xhr', 104);
  mockBlockingReady = false;
  assert.equal(state().blockingReady, false);
  webSession.sendHeaders({ ...cookieRequest, requestHeaders: { Cookie: 'id=one' } }, value => assert.deepEqual(value.requestHeaders, {}, 'Third-party cookies do not wait for the filter lists'));
  assert.equal(state().tabs[0].blocked.cookies, 1);
  mockBlockingReady = true;
  webSession.sendHeaders({ ...cookieRequest, requestHeaders: { Cookie: 'id=one; token=two', Accept: '*/*' } }, value => assert.deepEqual(value.requestHeaders, { Accept: '*/*' }));
  webSession.receiveHeaders({ ...cookieRequest, responseHeaders: { 'SET-Cookie': ['id=changed; Secure', 'new=three; Secure'], 'content-type': ['text/plain'] } }, value => assert.deepEqual(value.responseHeaders, { 'content-type': ['text/plain'] }));
  assert.equal(state().tabs[0].blocked.cookies, 3);
  webSession.sendHeaders({ ...cookieRequest, requestHeaders: { cookie: 'id=repeated' } }, () => {});
  assert.equal(state().tabs[0].blocked.cookies, 3);
  const mainRequest = { id: 106, webContentsId: view.webContents.id, resourceType: 'mainFrame', url: 'https://example.com/' };
  network(mainRequest.url, 'mainFrame', 106);
  const redirected = { ...mainRequest, url: 'https://redirected.test/' };
  network(redirected.url, 'mainFrame', 106);
  webSession.sendHeaders({ ...redirected, requestHeaders: { Cookie: 'first=party' } }, value => assert.deepEqual(value.requestHeaders, { Cookie: 'first=party' }));
  network(mainRequest.url, 'mainFrame', 106);
  const reloads = view.webContents.reloads || 0;
  command({ type: 'set-blocking', enabled: false });
  assert.equal(view.webContents.reloads, reloads + 1); assert.equal(state().siteSettings.blocking, false);
  assert.equal(network('https://ads.example/blocked-ad', 'script', 105).cancel, false);
  webSession.sendHeaders({ ...cookieRequest, requestHeaders: { Cookie: 'id=one' } }, value => assert.deepEqual(value.requestHeaders, { Cookie: 'id=one' }));
  webSession.receiveHeaders({ ...cookieRequest, responseHeaders: { 'Set-Cookie': ['id=one'] } }, value => assert.deepEqual(value.responseHeaders, { 'Set-Cookie': ['id=one'] }));
  assert.equal(view.webContents.bypassedCache, undefined);
  command({ type: 'set-blocking', enabled: true });
  assert.equal(view.webContents.bypassedCache, 1, 'Blocking turned back on reloads without the responses cached while it was off');
  view.webContents.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
  assert.deepEqual(state().tabs[0].blocked, { ads: 0, trackers: 0, cookies: 0 });
  webSession.receiveHeaders({ ...cookieRequest, responseHeaders: { 'Set-Cookie': ['late=one'] } }, () => {});
  assert.equal(state().tabs[0].blocked.cookies, 0, 'Old response cookies never enter the new page count');
  view.webContents.emit('did-navigate', {}, 'https://example.com/next');
  await new Promise(resolve => setImmediate(resolve));
  const permissionResults = [];
  const requestPermission = (permission, details = {}) => webSession.request(view.webContents, permission, allowed => permissionResults.push([permission, allowed]), details);
  requestPermission('media', { mediaTypes: ['video', 'audio'], requestingUrl: 'https://evil-frame.test/' });
  const mediaPrompt = state().permissionPrompt;
  assert.equal(mediaPrompt.origin, 'https://example.com'); assert.deepEqual(mediaPrompt.permissions, ['camera', 'microphone']);
  requestPermission('geolocation');
  command({ type: 'new-tab' }); assert.equal(state().permissionPrompt, null);
  assert.throws(() => command({ type: 'answer-permission', id: mediaPrompt.id, answer: 'allow' }), /STALE/);
  command({ type: 'close-tab', id: state().activeId }); assert.equal(state().permissionPrompt.id, mediaPrompt.id);
  command({ type: 'answer-permission', id: mediaPrompt.id, answer: 'allow' });
  assert.deepEqual(permissionResults, [['media', true]]);
  assert.equal(webSession.check(view.webContents, 'media', 'https://evil-frame.test', { mediaType: 'video' }), true);
  assert.equal(webSession.check(view.webContents, 'media', 'https://evil-frame.test', { mediaType: 'audio' }), true);
  assert.equal(webSession.check(null, 'media', 'https://evil-frame.test', { embeddingOrigin: 'https://example.com/', mediaType: 'video' }), true);
  view.webContents.mainFrame.origin = 'null';
  assert.equal(webSession.check(view.webContents, 'media', 'https://example.com', { mediaType: 'video' }), false);
  requestPermission('media', { mediaTypes: ['video'] });
  assert.deepEqual(permissionResults.at(-1), ['media', false]);
  delete view.webContents.mainFrame.origin;
  assert.equal(state().permissionPrompt.permissions[0], 'location');
  command({ type: 'answer-permission', id: state().permissionPrompt.id, answer: 'dismiss' });
  assert.equal(state().siteSettings.permissions.location, 'ask');
  requestPermission('geolocation');
  assert.deepEqual(permissionResults.at(-1), ['geolocation', false]); assert.equal(state().permissionPrompt, null, 'A dismissal holds until the page navigates');
  view.webContents.emit('did-start-navigation', {}, 'https://example.com/#next', true, true);
  requestPermission('notifications');
  command({ type: 'answer-permission', id: state().permissionPrompt.id, answer: 'block' });
  requestPermission('notifications'); assert.equal(state().permissionPrompt, null);
  assert.equal(webSession.check(view.webContents, 'notifications', 'https://example.com', {}), false);
  requestPermission('geolocation');
  command({ type: 'set-site-permission', permission: 'location', decision: 'allow' });
  assert.equal(permissionResults.at(-1)[1], true); assert.equal(state().permissionPrompt, null);
  command({ type: 'set-site-permission', permission: 'camera', decision: 'ask' });
  requestPermission('media', { mediaTypes: ['video'] });
  const stalePrompt = state().permissionPrompt;
  view.webContents.emit('did-start-navigation', {}, 'http://insecure.test/', false, true);
  assert.equal(permissionResults.at(-1)[1], false); assert.equal(state().permissionPrompt, null);
  assert.throws(() => command({ type: 'answer-permission', id: stalePrompt.id, answer: 'allow' }), /STALE/);
  requestPermission('media', { mediaTypes: ['video'] });
  assert.equal(state().permissionPrompt, null, 'A replaced document cannot create another prompt');
  view.webContents.mainFrame.url = 'http://insecure.test/'; requestPermission('geolocation');
  assert.equal(permissionResults.at(-1)[1], false); assert.equal(state().permissionPrompt, null);
  view.webContents.mainFrame.url = 'https://example.com/';
  view.webContents.emit('did-navigate', {}, 'https://example.com/'); await new Promise(resolve => setImmediate(resolve));
  command({ type: 'new-tab', input: 'https://close-permission.test/' });
  const permissionTab = views.at(-1).webContents;
  permissionTab.mainFrame.url = 'https://close-permission.test/';
  permissionTab.emit('did-navigate', {}, permissionTab.mainFrame.url);
  webSession.request(permissionTab, 'geolocation', allowed => permissionResults.push(['closed', allowed]), {});
  assert.equal(state().permissionPrompt.permissions[0], 'location');
  command({ type: 'close-tab', id: state().activeId });
  assert.deepEqual(permissionResults.at(-1), ['closed', false]);
  mockCosmetics = false;
  tick();
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
  const personalId = state().activeProfileId;
  const work = state().profiles.find(profile => profile.name === 'Work');
  assert.equal(state().profiles.length, 2);
  assert.equal(sessions.size, 1, 'Work stays lazy until its first switch');
  assert.equal(loaded.exports.isProfileSession(webSession), true);
  assert.equal(loaded.exports.isProfileSession(new EventEmitter()), false);
  const personalState = structuredClone(state());
  const livePersonalDownload = new Download();
  webSession.emit('will-download', allowed, livePersonalDownload, view.webContents);
  command({ type: 'delete-history', url: state().store.history[0].url }); tick();
  const deletedHistory = structuredClone(state().store.history);
  const oldMenu = openMenu();
  command({ type: 'switch-profile', id: work.id });
  assert.throws(() => menuAction(oldMenu, 'reload'));
  assert.equal(state().activeProfileId, work.id);
  assert.equal(readRegistry(join(directory, 'profiles.json'), 'en').activeId, work.id);
  assert.deepEqual(state().store, { version: 2, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], permissions: [] } });
  assert.equal(state().tabs.length, 1);
  assert.equal(view.visible, false); assert.equal(view.webContents.destroyed, false);
  assert.equal(sessions.size, 2);
  const workPartition = readRegistry(join(directory, 'profiles.json'), 'en').profiles.find(profile => profile.id === work.id).partition;
  const workSession = sessions.get(workPartition);
  assert.ok(workPartition.startsWith('persist:profile-')); assert.notEqual(workSession, webSession);
  assert.equal(loaded.exports.isProfileSession(workSession), true);
  command({ type: 'navigate', input: 'https://work.example/' });
  const workView = views.at(-1);
  assert.equal(workView.options.webPreferences.partition, workPartition);
  assert.equal(workView.webContents.session, workSession);
  assert.deepEqual({ ...workView.options.webPreferences, partition: 'persist:web' }, view.options.webPreferences);
  assert.equal(workView.visible, true);
  workView.webContents.emit('did-navigate', {}, 'https://work.example/'); command({ type: 'bookmark' });
  assert.equal(state().store.history[0].url, 'https://work.example/');
  assert.equal(state().store.bookmarks[0].url, 'https://work.example/');
  const workDownload = new Download();
  workSession.emit('will-download', allowed, workDownload, workView.webContents);
  assert.equal(state().store.downloads[0].path, workDownload.path);
  assert.notEqual(workDownload.path, livePersonalDownload.path, 'Concurrent downloads reserve paths across profiles');
  const workGuest = new Contents(workSession);
  const workPopup = workView.webContents.popup({ url: 'https://work.example/popup', disposition: 'background-tab' });
  assert.equal(workPopup.overrideBrowserWindowOptions.webPreferences.partition, workPartition);
  assert.equal(workPopup.createWindow({ webContents: workGuest }), workGuest);
  assert.equal(views.at(-1).options.webPreferences.partition, workPartition); assert.equal(views.at(-1).visible, false);
  command({ type: 'switch-profile', id: personalId });
  assert.equal(view.visible, true); assert.equal(workView.visible, false);
  assert.deepEqual(state().store.history, deletedHistory);
  command({ type: 'restore', kind: 'history' });
  assert.deepEqual(state().store.history, deletedHistory, 'Undo cannot cross a profile switch');
  assert.deepEqual(state().store.bookmarks, personalState.store.bookmarks);
  assert.equal(state().store.downloads.some(entry => entry.path === workDownload.path), false);
  workDownload.emit('updated', {}, 'progressing');
  assert.equal(state().store.downloads.some(entry => entry.path === workDownload.path), false);
  const beforeBackgroundShortcut = window.webContents.sent.length;
  workView.webContents.emit('before-input-event', { preventDefault() { assert.fail('Background shortcut'); } }, shortcutInput('F6'));
  workView.webContents.emit('zoom-changed', {}, 'in');
  assert.equal(workView.webContents.zoom, 1); assert.equal(window.webContents.sent.length, beforeBackgroundShortcut);
  const latePopup = workView.webContents.popup({ url: 'https://work.example/late', disposition: 'foreground-tab' });
  const lateGuest = new Contents(workSession); latePopup.createWindow({ webContents: lateGuest });
  assert.equal(state().activeProfileId, personalId); assert.equal(views.at(-1).visible, false);
  assert.equal(state().profiles.find(profile => profile.id === work.id).tabCount, 3);
  command({ type: 'switch-profile', id: work.id });
  assert.equal(state().store.downloads[0].received, 50);
  workGuest.close(); lateGuest.close(); workView.webContents.close();
  assert.equal(state().tabs.length, 1, 'The current profile retains a blank tab');
  command({ type: 'navigate', input: 'https://work.example/last' });
  const lastWorkView = views.at(-1); command({ type: 'switch-profile', id: personalId }); lastWorkView.webContents.close();
  assert.equal(state().profiles.find(profile => profile.id === work.id).tabCount, 0);
  command({ type: 'switch-profile', id: work.id }); assert.equal(state().tabs.length, 1);
  command({ type: 'navigate', input: 'https://work.example/delete' }); const deleteView = views.at(-1);
  assert.throws(() => command({ type: 'update-profile', id: work.id, name: ' personal ', color: 'cyan' }), /PROFILE_NAME_DUPLICATE/);
  assert.throws(() => command({ type: 'create-profile', name: 'WORK', color: 'red' }), /PROFILE_NAME_DUPLICATE/);
  command({ type: 'update-profile', id: work.id, name: '  Studio  ', color: 'cyan' });
  assert.equal(state().profiles.find(profile => profile.id === work.id).name, 'Studio');
  assert.equal(state().profiles.find(profile => profile.id === work.id).color, 'cyan');
  const beforeDeletion = structuredClone(state());
  registryWriteFailure = true;
  assert.throws(() => command({ type: 'delete-profile', id: work.id }), /Registry unavailable/);
  assert.deepEqual(state(), beforeDeletion);
  assert.equal(deleteView.webContents.destroyed, false); assert.equal(workDownload.cancelled, undefined);
  assert.deepEqual(workSession.cleared, []);
  registryWriteFailure = false;
  cleanupFailure = true;
  workSession.clearStorageData = async () => { workSession.cleared.push('clearStorageData'); throw new Error('Session unavailable'); };
  const deletion = command({ type: 'delete-profile', id: work.id });
  assert.equal(readRegistry(join(directory, 'profiles.json'), 'en').profiles.some(profile => profile.id === work.id), false);
  assert.deepEqual(readRegistry(join(directory, 'profiles.json'), 'en').tombstones, [workPartition]);
  assert.equal(state().activeProfileId, personalId);
  assert.throws(() => command({ type: 'new-tab' }), /deletion/); await deletion;
  assert.equal(deleteView.webContents.destroyed, true); assert.equal(workDownload.cancelled, true);
  assert.deepEqual(workSession.cleared.sort(), ['clearStorageData', 'closeAllConnections', 'clearCache', 'clearAuthCache', 'clearCodeCaches'].sort());
  assert.equal(existsSync(join(directory, 'profiles', work.id)), true);
  assert.equal(state().storageError, true);
  assert.equal(storageErrors.length, 2);
  assert.ok(storageErrors.every(([message]) => message === 'Profile storage error'));
  cleanupFailure = false;
  assert.deepEqual(readRegistry(join(directory, 'profiles.json'), 'en').tombstones, [workPartition]);
  assert.equal(state().profiles.length, 1);
  assert.equal(loaded.exports.isProfileSession(workSession), false);
  assert.throws(() => command({ type: 'delete-profile', id: personalId }), /PROFILE_LAST/);
  for (let index = 1; index < 20; index++) command({ type: 'create-profile', name: 'Profile ' + index, color: 'purple' });
  assert.equal(state().profiles.length, 20);
  assert.throws(() => command({ type: 'create-profile', name: 'Too many', color: 'blue' }), /PROFILE_LIMIT/);
  assert.throws(() => command({ type: 'switch-profile', id: work.id }));
  assert.throws(() => command({ type: 'delete-profile', id: work.id }));
  command({ type: 'switch-profile', id: personalId }); tick();
  assert.equal(state().theme, 'amber'); assert.equal(state().contrast, 'standard');
  view.webContents.emit('enter-html-full-screen');
  view.webContents.emit('page-favicon-updated', {}, ['https://example.com/icon.png']);
  await new Promise(resolve => setImmediate(resolve));
  const closedId = state().activeId, closedHash = state().tabs[0].favicon;
  assert.deepEqual(favicon(closedId, closedHash), faviconPNG);
  menu = openMenu();
  view.webContents.close();
  assert.throws(() => menuAction(menu, 'reload'));
  assert.throws(() => favicon(closedId, closedHash));
  assert.equal(window.fullscreen, false);
  assert.equal(state().tabs.length, 1);
  assert.equal(state().tabs[0].url, '');
  assert.equal(window.title, 'Horizon');
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
  const resumeProfile = state().profiles.find(profile => profile.id !== personalId);
  command({ type: 'switch-profile', id: resumeProfile.id });
  window.emit('closed');
  assert.equal(timers.size, 0);
  assert.equal(readStore(profileStorePath(directory, personalId)).downloads[0].status, 'cancelled');
  assert.equal(shutdownDownload.cancelled, true);
  assert.equal(electron.app.listenerCount('before-quit'), 0);
  assert.equal(view.webContents.destroyed, true);
  assert.equal(handlers.size, 0);
  assert.equal(loaded.exports.isProfileSession(webSession), false);
  const freshWindow = new EventEmitter();
  freshWindow.webContents = new Contents();
  for (const key of ['isDestroyed', 'getContentBounds', 'setFullScreen', 'setTitle', 'contentView']) freshWindow[key] = window[key];
  loaded.exports.createBrowser(freshWindow, directory, join(directory, 'downloads'), settings);
  assert.equal(existsSync(join(directory, 'profiles', work.id)), false, 'Tombstone cleanup retries the store folder');
  const freshEvent = { sender: freshWindow.webContents, senderFrame: freshWindow.webContents.mainFrame };
  const resumed = handlers.get('horizon:state')(freshEvent);
  assert.equal(resumed.activeProfileId, resumeProfile.id);
  assert.equal(resumed.tabs.length, 1); assert.equal(resumed.tabs[0].url, '');
  assert.equal(resumed.profiles.find(profile => profile.id === personalId).tabCount, 0);
  freshWindow.emit('closed');
  assert.equal(handlers.size, 0); assert.equal(timers.size, 0);
  for (const unavailable of [true, false]) {
    const path = profileStorePath(directory, resumeProfile.id), cipher = authenticatedCipher();
    writeStore(path, sampleStore(directory), cipher);
    const original = readFileSync(path);
    if (!unavailable) { original[original.length - 1] ^= 1; writeFileSync(path, original); }
    electron.safeStorage = unavailable ? { isEncryptionAvailable: () => false } : cipher;
    loaded.exports.createBrowser(freshWindow, directory, join(directory, 'downloads'), settings);
    const recovered = handlers.get('horizon:state')(freshEvent);
    assert.equal(recovered.storageReadError, true);
    assert.equal(recovered.storageError, false);
    handlers.get('horizon:command')(freshEvent, { type: 'navigate', input: 'https://session.example/' });
    views.at(-1).webContents.emit('did-navigate', {}, 'https://session.example/');
    tick();
    assert.equal(handlers.get('horizon:state')(freshEvent).store.history[0].url, 'https://session.example/');
    assert.equal(handlers.get('horizon:state')(freshEvent).storageReadError, true);
    freshWindow.emit('closed');
    if (unavailable) assert.deepEqual(readFileSync(path), original, 'Session edits and shutdown leave encrypted bytes intact');
    else assert.ok(readdirSync(require('node:path').dirname(path)).some(name => name.includes('.corrupt-') && readFileSync(join(require('node:path').dirname(path), name)).equals(original)));
  }
});

const faviconPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

test('settings validate themes, write atomically and preserve corrupt or oversized files', t => {
  const directory = temporaryDirectory(t, 'settings');
  const path = join(directory, 'settings.json');
  const changed = [];
  const settings = createSettings(path, value => changed.push(value));
  assert.equal(settings.theme, 'system');
  assert.equal(settings.contrast, 'standard');
  assert.equal(settings.migrationAllowed, true);
  settings.setTheme('amber', true);
  settings.setTheme('daylight', true);
  assert.equal(settings.theme, 'amber');
  assert.equal(settings.migrationAllowed, false);
  assert.deepEqual(changed, ['amber']);
  settings.setTheme('system', false);
  assert.equal(settings.theme, 'system');
  assert.equal(createSettings(path, () => {}).migrationAllowed, false);
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  for (const theme of ['system', 'amber', 'daylight']) assert.equal(validateSettings({ version: 1, theme, contrast: 'standard' }), true);
  for (const value of [null, [], {}, { version: 2, theme: 'system' }, { version: 1, theme: 'dark' }, { version: 1, theme: 'amber', extra: true }, { version: 1, theme: 'amber' }, { version: 1, theme: 'amber', contrast: 'invalid' }, { version: 1, theme: 'amber', contrast: null }, { version: 1, theme: 'amber', contrast: 'high', extra: true }]) {
    assert.equal(validateSettings(value), false);
    assert.throws(() => writeSettings(path, value));
  }
  for (const corrupt of ['{broken', JSON.stringify({ version: 2, theme: 'amber' }), ' '.repeat(4097)]) {
    writeFileSync(path, corrupt);
    assert.deepEqual(readSettings(path), { version: 1, theme: 'system', contrast: 'standard' });
    assert.ok(readdirSync(directory).filter(name => name.startsWith('settings.json.corrupt-')).some(name => readFileSync(join(directory, name), 'utf8') === corrupt));
  }
  const existing = createSettings(path, () => {});
  existing.setTheme('amber', true);
  assert.equal(existing.theme, 'system');
});

test('favicon URLs exclude privileged schemes, credentials and unbounded inputs', () => {
  for (const url of ['https://example.com/icon.png', 'https://8.8.8.8/icon', 'https://[2606:4700:4700::1111]/icon']) assert.equal(isFaviconURL(url), true);
  for (const url of [null, {}, '', 'about:blank', 'file:///private', 'horizon://app/', 'data:image/png,bytes', 'blob:https://example.com/icon', 'https://user@example.com/icon', ' https://example.com/icon', 'https://example.com/\nicon', 'https://example.com/' + 'a'.repeat(8192)]) assert.equal(isFaviconURL(url), false);
});

const privateFaviconHosts = ['127.0.0.1', '127.99.1.2', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.2', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '[::]', '[::1]', '[fc00::1]', '[fdff::1]', '[fe80::1]', '[febf::1]', '[::ffff:127.0.0.1]', '[::ffff:192.168.1.1]', 'localhost', 'sub.localhost', 'printer.local', 'server.internal', 'router.lan', 'host.home.arpa', 'home.arpa', 'LOCALHOST.'];
test('favicon destinations allow the page host and public hosts and refuse private candidates and every redirect hop', async () => {
  const signal = new AbortController().signal;
  for (const host of privateFaviconHosts) {
    const url = `http://${host}/icon`;
    assert.equal(isFaviconURL(url), false, host);
    assert.equal(isFaviconURL(url, `http://${host}/page`), true, `Same host: ${host}`);
    const calls = [];
    const target = { async fetch(value) { calls.push(value); return new Response(faviconPNG); } };
    assert.equal(await fetchFavicon(target, [url], signal, 'https://example.com/'), null);
    assert.deepEqual(calls, []);
    assert.deepEqual(await fetchFavicon(target, [url], signal, `http://${host}/page`), faviconPNG);
    calls.length = 0;
    target.fetch = async value => { calls.push(value); return new Response(null, { status: 302, headers: { location: calls.length === 1 ? 'https://cdn.example/hop' : url } }); };
    assert.equal(await fetchFavicon(target, ['https://example.com/start'], signal, 'https://example.com/page'), null);
    assert.deepEqual(calls, ['https://example.com/start', 'https://cdn.example/hop']);
  }
});

test('favicon streaming enforces the 256 KB cap even without a trustworthy length header', async () => {
  assert.equal((await readFavicon(new Response(faviconPNG))).equals(faviconPNG), true);
  let cancelled = false;
  const oversize = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(FAVICON_LIMIT)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readFavicon(new Response(oversize, { headers: { 'content-length': '1' } })), /size limit/);
  assert.equal(cancelled, true);
  await assert.rejects(readFavicon(new Response(faviconPNG, { headers: { 'content-length': String(FAVICON_LIMIT + 1) } })), /response/);
  const exact = Buffer.alloc(FAVICON_LIMIT); faviconPNG.copy(exact);
  assert.equal((await readFavicon(new Response(exact))).length, FAVICON_LIMIT);
});

test('favicon fetching preserves validated raster bytes without decoding, tries candidates in order and validates redirects', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', duration => { assert.equal(duration, 5000); return timeout(duration); });
  const controller = new AbortController();
  const calls = [];
  const target = { async fetch(url, options) {
    calls.push(url); assert.equal(options.redirect, 'manual'); assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith('/redirect')) return new Response(null, { status: 302, headers: { location: 'file:///private' } });
    if (url.endsWith('/svg')) return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('/xml')) return new Response(faviconPNG, { headers: { 'content-type': 'image/svg+xml' } });
    if (url.endsWith('/oversize')) return new Response(Buffer.alloc(FAVICON_LIMIT + 1));
    if (url.endsWith('/text')) return new Response('not an image');
    if (url.endsWith('/broken')) return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return new Response(faviconPNG);
  } };
  const candidates = ['data:image/png,bytes', ...['redirect', 'svg', 'xml', 'oversize', 'text', 'png', 'unused'].map(name => 'https://example.com/' + name)];
  assert.deepEqual(await fetchFavicon(target, candidates, controller.signal), faviconPNG);
  assert.deepEqual(calls, candidates.slice(1, -1));
  assert.equal(await fetchFavicon(target, ['https://example.com/svg', 'https://example.com/text'], controller.signal), null);
  const signatureOnly = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(await fetchFavicon(target, ['https://example.com/broken'], controller.signal), signatureOnly);
  const redirects = [];
  const redirecting = { async fetch(url) { redirects.push(url); return redirects.length === 1 ? new Response(null, { status: 302, headers: { location: '/png' } }) : new Response(faviconPNG); } };
  assert.deepEqual(await fetchFavicon(redirecting, ['http://example.com/start'], controller.signal), faviconPNG);
  assert.deepEqual(redirects, ['http://example.com/start', 'http://example.com/png']);
  controller.abort();
  const before = calls.length;
  assert.equal(await fetchFavicon(target, ['https://example.com/png'], controller.signal), null);
  assert.equal(calls.length, before);
});


test('sandboxed preload validates the startup theme and exposes only the frozen browser API', async () => {
  const { compileFunction } = require('node:vm');
  const filename = resolve('dist/electron/preload.js');
  for (const contrast of ['standard', 'high', 'invalid', '']) for (const [argument, expected] of [['system', 'system'], ['amber', 'amber'], ['daylight', 'daylight'], ['dark', 'system'], ['', 'system']]) {
    let exposed;
    const invocations = [];
    const electron = {
      contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'horizon'); exposed = value; } },
      ipcRenderer: { invoke(...args) { invocations.push(args); return Promise.resolve(null); }, on() {}, removeListener() {} },
    };
    compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', 'process'])({}, name => { assert.equal(name, 'electron'); return electron; }, { argv: ['electron', '--horizon-theme=' + argument, '--horizon-contrast=' + contrast, '--horizon-theme-migrate=1'] });
    assert.equal(exposed.initialTheme, expected);
    assert.equal(exposed.initialContrast, contrast === 'high' ? 'high' : 'standard');
    assert.equal(exposed.themeMigration, true);
    assert.equal(Object.isFrozen(exposed), true);
    assert.deepEqual(Object.keys(exposed).sort(), ['capture', 'command', 'getFavicon', 'getLanguage', 'getState', 'initialContrast', 'initialTheme', 'onContextMenu', 'onShortcut', 'onState', 'setContentArea', 'themeMigration', 'windowAction']);
    await exposed.getFavicon('tab', 'a'.repeat(32));
    assert.deepEqual(invocations, [['horizon:favicon', 'tab', 'a'.repeat(32)]]);
  }
});

test('contrast defaults follow the OS only on first run and legacy settings migrate atomically', t => {
  const directory = temporaryDirectory(t, 'contrast');
  const first = join(directory, 'first.json');
  const settings = createSettings(first, () => {}, true);
  assert.deepEqual(readSettings(first), { version: 1, theme: 'system', contrast: 'high' });
  settings.setTheme('amber', true);
  assert.equal(settings.contrast, 'high');
  settings.setContrast('standard');
  assert.equal(settings.theme, 'amber');
  assert.deepEqual(readSettings(first, true), { version: 1, theme: 'amber', contrast: 'standard' });
  assert.throws(() => settings.setContrast('invalid'));
  assert.equal(settings.contrast, 'standard');
  for (const theme of ['system', 'amber', 'daylight']) {
    const legacy = join(directory, theme + '.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, theme }));
    assert.deepEqual(readSettings(legacy, true), { version: 1, theme, contrast: 'standard' });
    assert.deepEqual(JSON.parse(readFileSync(legacy, 'utf8')), { version: 1, theme, contrast: 'standard' });
    assert.equal(createSettings(legacy, () => {}, true).migrationAllowed, false);
  }
  assert.equal(readdirSync(directory).some(name => name.includes('.corrupt-') || name.endsWith('.tmp')), false);
  const blocked = join(directory, 'blocked');
  writeFileSync(blocked, 'file');
  assert.deepEqual(readSettings(join(blocked, 'settings.json'), true), { version: 1, theme: 'system', contrast: 'high' });
  const unavailable = createSettings(join(blocked, 'settings.json'), () => {}, true);
  assert.throws(() => unavailable.setContrast('standard'));
  assert.equal(unavailable.contrast, 'high');
});

test('renderer applies both startup settings and preserves contrast across system scheme changes', () => {
  const { compileFunction } = require('node:vm');
  const { transpileModule, ModuleKind } = require('typescript');
  const source = transpileModule(readFileSync('src/theme.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  for (const theme of ['system', 'amber', 'daylight']) for (const contrast of ['standard', 'high']) {
    const root = { dataset: {} };
    let changed;
    const media = { matches: false, addEventListener(name, handler) { assert.equal(name, 'change'); changed = handler; } };
    const exported = {};
    compileFunction(source, ['exports', 'window', 'document', 'matchMedia'])(exported, { horizon: { initialTheme: theme, initialContrast: contrast } }, { documentElement: root }, query => { assert.equal(query, '(prefers-color-scheme: dark)'); return media; });
    exported.applyTheme(theme, contrast);
    assert.deepEqual(root.dataset, { theme: theme === 'system' ? 'daylight' : theme, contrast });
    media.matches = true; changed();
    assert.deepEqual(root.dataset, { theme: theme === 'system' ? 'amber' : theme, contrast });
    exported.applyTheme('system', contrast === 'high' ? 'standard' : 'high');
    assert.equal(root.dataset.theme, 'amber');
    media.matches = false; changed();
    assert.deepEqual(root.dataset, { theme: 'daylight', contrast: contrast === 'high' ? 'standard' : 'high' });
  }
});

test('main paints the resolved palette and passes both settings before loading chrome', async t => {
  const { EventEmitter } = require('node:events');
  const { compileFunction } = require('node:vm');
  const filename = resolve('dist/electron/main.js');
  const directory = temporaryDirectory(t, 'first-paint');
  const localRequire = require('node:module').createRequire(filename);
  for (const theme of ['system', 'amber', 'daylight']) for (const contrast of ['standard', 'high']) for (const dark of [false, true]) {
    const windows = [];
    let painted;
    const settings = { theme, contrast, migrationAllowed: false };
    const nativeTheme = new EventEmitter();
    nativeTheme.shouldUseDarkColors = dark;
    nativeTheme.shouldUseHighContrastColors = true;
    const app = new EventEmitter();
    app.isPackaged = true;
    app.enableSandbox = () => {};
    app.whenReady = () => Promise.resolve();
    app.getPath = () => directory;
    app.getLocale = () => 'en';
    app.exit = () => assert.fail('Main startup failed');
    const electron = {
      app, nativeTheme,
      protocol: { registerSchemesAsPrivileged() {} },
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
      session: { defaultSession: { protocol: {} } },
      ipcMain: { handle() {} },
      BrowserWindow: class extends EventEmitter {
        constructor(options) {
          super(); windows.push(this); this.options = options;
          this.webContents = new EventEmitter();
        }
        setBackgroundColor(value) { painted = value; }
        removeMenu() {}
        async loadURL(url) {
          assert.equal(url, 'horizon://app/');
          const darkScheme = theme === 'amber' || theme === 'system' && dark;
          const expected = contrast === 'high' ? darkScheme ? '#000000' : '#ffffff' : darkScheme ? '#171514' : '#eeebe9';
          assert.equal(this.options.backgroundColor, expected);
          assert.ok(this.options.webPreferences.additionalArguments.includes('--horizon-theme=' + theme));
          assert.ok(this.options.webPreferences.additionalArguments.includes('--horizon-contrast=' + contrast));
          this.loaded = true;
        }
      },
    };
    let changed;
    compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', '__dirname'])( {}, name => {
      if (name === 'electron') return electron;
      if (name === './settings') return { createSettings(path, callback, high) { assert.equal(path, join(directory, 'settings.json')); assert.equal(high, true); changed = callback; return settings; } };
      if (name === './security') return { START_URL: 'horizon://app/', secureSession() {} };
      if (name === './protocol') return { serveHorizon: async () => {} };
      if (name === './browser') return { createBrowser: () => ({ layout() {} }) };
      return localRequire(name);
    }, require('node:path').dirname(filename));
    await new Promise(done => setImmediate(done));
    const window = windows[0];
    assert.equal(window.loaded, true);
    settings.contrast = contrast === 'high' ? 'standard' : 'high';
    changed();
    const darkScheme = theme === 'amber' || theme === 'system' && dark;
    assert.equal(painted, settings.contrast === 'high' ? darkScheme ? '#000000' : '#ffffff' : darkScheme ? '#171514' : '#eeebe9');
    nativeTheme.shouldUseDarkColors = !dark;
    nativeTheme.emit('updated');
    if (theme === 'system') assert.equal(painted, settings.contrast === 'high' ? dark ? '#ffffff' : '#000000' : dark ? '#eeebe9' : '#171514');
    window.emit('closed');
    assert.equal(nativeTheme.listenerCount('updated'), 0);
  }
});

function authenticatedCipher() {
  const key = require('node:crypto').randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = require('node:crypto').randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

test('profile registry validates exact shapes, UUIDs, partitions, names, colours, counts and tombstones', () => {
  const personal = makeProfile('Personal', 'amber', true), work = makeProfile('Work', 'blue');
  const valid = { version: 1, activeId: personal.id, profiles: [personal, work], tombstones: ['persist:profile-' + randomUUID()] };
  assert.equal(validateRegistry(valid), true);
  for (const color of ['amber', 'blue', 'green', 'red', 'yellow', 'grey', 'purple', 'cyan']) assert.equal(validateRegistry({ ...valid, profiles: [{ ...personal, color }, work] }), true);
  for (const value of [null, [], {}, { ...valid, version: 2 }]) assert.equal(validateRegistry(value), false);
  const mutations = [
    registry => { registry.extra = true; },
    registry => { delete registry.tombstones; },
    registry => { registry.activeId = randomUUID(); },
    registry => { registry.activeId = 'not-a-uuid'; },
    registry => { registry.profiles = []; },
    registry => { registry.profiles = Array.from({ length: 21 }, (_, index) => makeProfile('Profile ' + index, 'cyan')); },
    registry => { registry.profiles = new Array(1); },
    registry => { registry.profiles[0].extra = true; },
    registry => { delete registry.profiles[0].createdAt; },
    registry => { registry.profiles[0].id = '../outside'; },
    registry => { registry.profiles[1].id = registry.profiles[0].id; },
    registry => { registry.profiles[1].partition = 'persist:web'; },
    registry => { registry.profiles[0].partition = 'web'; },
    registry => { registry.profiles[0].partition = 'persist:profile-not-a-uuid'; },
    registry => { registry.profiles[0].partition = 'persist:profile-' + randomUUID() + '/../outside'; },
    registry => { registry.profiles[0].name = ''; },
    registry => { registry.profiles[0].name = '   '; },
    registry => { registry.profiles[0].name = ' Personal'; },
    registry => { registry.profiles[0].name = 'x'.repeat(41); },
    registry => { registry.profiles[0].name = 'Line\nbreak'; },
    registry => { registry.profiles[0].name = 'Control\u0085'; },
    registry => { registry.profiles[0].name = 1; },
    registry => { registry.profiles[1].name = 'PERSONAL'; },
    registry => { registry.profiles[0].color = '#ff0000'; },
    registry => { registry.profiles[0].color = { toString: () => 'amber' }; },
    registry => { registry.profiles[0].createdAt = Infinity; },
    registry => { registry.profiles[0].createdAt = -1; },
    registry => { registry.profiles[0].createdAt = 8640000000000001; },
    registry => { registry.tombstones = null; },
    registry => { registry.tombstones = [personal.partition]; },
    registry => { registry.tombstones = ['persist:profile-' + randomUUID(), '../outside']; },
    registry => { registry.tombstones = [work.partition]; },
    registry => { registry.tombstones.push(registry.tombstones[0]); },
    registry => { registry.tombstones = [123]; },
  ];
  for (const mutate of mutations) { const registry = structuredClone(valid); mutate(registry); assert.equal(validateRegistry(registry), false); }
  const twenty = Array.from({ length: 20 }, (_, index) => makeProfile('Profile ' + index, 'grey'));
  assert.equal(validateRegistry({ version: 1, activeId: twenty[19].id, profiles: twenty, tombstones: ['persist:web'] }), true);
});

test('profile registry recovers malformed and oversized files, preserves originals and writes atomically', t => {
  const directory = temporaryDirectory(t, 'registry');
  const path = join(directory, 'profiles.json');
  const first = readRegistry(path, 'es');
  assert.deepEqual(first.profiles.map(profile => [profile.name, profile.color]), [['Personal', 'amber'], ['Trabajo', 'blue']]);
  assert.equal(first.profiles[0].partition, 'persist:web');
  assert.equal(first.activeId, first.profiles[0].id);
  assert.equal(validateRegistry(first), true);
  assert.deepEqual(readRegistry(path, 'en'), first);
  writeRegistry(path, { ...first, activeId: first.profiles[1].id });
  assert.equal(readRegistry(path, 'es').activeId, first.profiles[1].id);
  for (const corrupt of ['{broken', JSON.stringify({ ...first, activeId: 'unknown' }), ' '.repeat(64 * 1024 + 1)]) {
    writeFileSync(path, corrupt);
    const recovered = readRegistry(path, 'en');
    assert.equal(validateRegistry(recovered), true);
    assert.deepEqual(recovered.profiles.map(profile => profile.name), ['Personal', 'Work']);
    assert.ok(readdirSync(directory).some(name => name.startsWith('profiles.json.corrupt-') && readFileSync(join(directory, name), 'utf8') === corrupt));
  }
  assert.throws(() => writeRegistry(path, { ...first, profiles: [] }));
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  const blocked = join(directory, 'blocked'); writeFileSync(blocked, 'file');
  assert.equal(validateRegistry(readRegistry(join(blocked, 'profiles.json'), 'en')), true);
});

test('profile stores encrypt through an injected cipher and retain tampered or invalid encrypted originals', t => {
  const directory = temporaryDirectory(t, 'encrypted');
  const path = join(directory, 'profile', 'browser-store.json');
  const cipher = authenticatedCipher();
  const store = sampleStore(directory);
  writeStore(path, store, cipher);
  const encrypted = readFileSync(path);
  assert.equal(encrypted.includes(Buffer.from('https://example.com/')), false);
  assert.deepEqual(readStore(path, cipher), store);
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] ^= 1;
  writeFileSync(path, tampered);
  const readStatus = { readError: false, memoryOnly: false };
  assert.deepEqual(readStore(path, cipher, readStatus), { version: 2, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], permissions: [] } });
  assert.deepEqual(readStatus, { readError: true, memoryOnly: false });
  assert.ok(readdirSync(join(directory, 'profile')).some(name => name.startsWith('browser-store.json.corrupt-') && readFileSync(join(directory, 'profile', name)).equals(tampered)));
  const invalid = Buffer.concat([Buffer.from('HORIZON-STORE-1\n'), cipher.encryptString(JSON.stringify({ ...store, version: 3 }))]);
  writeFileSync(path, invalid);
  assert.equal(readStore(path, cipher).history.length, 0);
  assert.ok(readdirSync(join(directory, 'profile')).some(name => name.startsWith('browser-store.json.corrupt-') && readFileSync(join(directory, 'profile', name)).equals(invalid)));
  const unavailable = { isEncryptionAvailable: () => false };
  writeStore(path, store, cipher);
  const kept = readFileSync(path), status = { readError: false, memoryOnly: false };
  assert.equal(readStore(path, unavailable, status).history.length, 0);
  assert.deepEqual(status, { readError: true, memoryOnly: true });
  assert.deepEqual(readFileSync(path), kept);
  assert.throws(() => writeStore(path, store, unavailable), /encryption/);
  assert.throws(() => writeStore(path, store), /encryption/);
  assert.deepEqual(readFileSync(path), kept);
  const plain = join(directory, 'plain.json');
  writeStore(plain, store, unavailable);
  assert.deepEqual(JSON.parse(readFileSync(plain, 'utf8')), store);
  if (process.platform !== 'win32') assert.equal(require('node:fs').statSync(plain).mode & 0o777, 0o600);
  assert.deepEqual(readStore(plain, cipher), store, 'Plain stores are upgraded when encryption becomes available');
  assert.equal(readFileSync(plain).includes(Buffer.from('https://example.com/')), false);
  assert.equal(readdirSync(join(directory, 'profile')).some(name => name.endsWith('.tmp')), false);
});

test('legacy browsing migrates into Personal and archives the owner-only original only after a successful write', t => {
  const directory = temporaryDirectory(t, 'migration');
  const registry = readRegistry(join(directory, 'profiles.json'), 'en');
  const legacy = join(directory, 'browser-store.json');
  const store = sampleStore(directory), cipher = authenticatedCipher();
  const archived = `${legacy}.migrated`;
  writeFileSync(archived, 'old backup');
  writeStore(legacy, store);
  migrateStore(directory, registry, cipher);
  assert.equal(existsSync(legacy), false);
  assert.deepEqual(JSON.parse(readFileSync(archived, 'utf8')), store);
  if (process.platform !== 'win32') assert.equal(require('node:fs').statSync(archived).mode & 0o777, 0o600);
  const personal = registry.profiles.find(profile => profile.partition === 'persist:web');
  const destination = profileStorePath(directory, personal.id);
  assert.deepEqual(readStore(destination, cipher), store);
  assert.equal(existsSync(profileStorePath(directory, registry.profiles[1].id)), false);
  const newer = { ...store, history: [{ ...store.history[0], title: 'Newer data' }] };
  const older = { ...store, bookmarks: [] };
  writeStore(destination, newer, cipher); writeStore(legacy, older);
  migrateStore(directory, registry, cipher);
  assert.deepEqual(readStore(destination, cipher), newer, 'A retry after a crash preserves newer data');
  assert.equal(existsSync(legacy), false);
  assert.deepEqual(JSON.parse(readFileSync(archived, 'utf8')), older, 'The archive is replaced by the migrated original');
  const failed = join(directory, 'failed'); mkdirSync(failed);
  const failedRegistry = readRegistry(join(failed, 'profiles.json'), 'en');
  writeStore(join(failed, 'browser-store.json'), store);
  writeFileSync(join(failed, 'profiles'), 'cannot write a directory here');
  assert.throws(() => migrateStore(failed, failedRegistry, cipher));
  assert.equal(existsSync(join(failed, 'browser-store.json')), true);
  assert.deepEqual(readStore(join(failed, 'browser-store.json')), store);
});

test('tombstones remove only Electron persistent partition directories and remain pending on unsafe junctions', t => {
  const directory = temporaryDirectory(t, 'partitions');
  const path = join(directory, 'profiles.json');
  let registry = readRegistry(path, 'en');
  const partition = 'persist:profile-' + randomUUID();
  registry = { ...registry, tombstones: [partition] }; writeRegistry(path, registry);
  const root = join(directory, 'Partitions'); mkdirSync(root);
  const dead = join(root, partition.slice('persist:'.length)); mkdirSync(dead); writeFileSync(join(dead, 'Cookies'), 'old sign-ins');
  const live = join(root, 'web'); mkdirSync(live); writeFileSync(join(live, 'Cookies'), 'kept sign-ins');
  const outside = join(directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'keep');
  const cleaned = cleanupPartitions(directory, path, registry);
  assert.equal(existsSync(dead), false);
  assert.equal(readFileSync(join(live, 'Cookies'), 'utf8'), 'kept sign-ins');
  assert.deepEqual(cleaned.tombstones, []);
  assert.deepEqual(readRegistry(path, 'en').tombstones, []);
  assert.throws(() => removeProfileDirectory(root, '../outside'));
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
  const linkedSession = join(directory, 'linked-session'); mkdirSync(linkedSession);
  symlinkSync(outside, join(linkedSession, 'Partitions'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanupPartitions(linkedSession, path, registry), /Unsafe/);
  symlinkSync(outside, dead, process.platform === 'win32' ? 'junction' : 'dir');
  writeRegistry(path, registry);
  assert.throws(() => cleanupPartitions(directory, path, registry), /Unsafe/);
  assert.deepEqual(readRegistry(path, 'en').tombstones, [partition]);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
});

test('all profile commands reject extra keys, invalid names, ids, colours and unknown profiles', () => {
  const id = randomUUID(), known = new Set([id]);
  const valid = [{ type: 'switch-profile', id }, { type: 'delete-profile', id }, { type: 'create-profile', name: ' New ', color: 'cyan' }, { type: 'update-profile', id, name: 'New', color: 'purple' }];
  for (const command of valid) {
    assert.deepEqual(validateCommand(command, known), command);
    assert.throws(() => validateCommand({ ...command, extra: true }, known));
    for (const key of Object.keys(command)) { const missing = { ...command }; delete missing[key]; assert.throws(() => validateCommand(missing, known)); }
  }
  for (const type of ['switch-profile', 'delete-profile', 'update-profile']) for (const invalid of ['', '../escape', null, 5, randomUUID()]) {
    assert.throws(() => validateCommand({ type, id: invalid, ...(type === 'update-profile' ? { name: 'Valid', color: 'amber' } : {}) }, known));
  }
  for (const type of ['create-profile', 'update-profile']) {
    for (const name of ['', ' ', '\nname', 'Control\u0085', 'x'.repeat(41), null, {}, 5]) assert.throws(() => validateCommand({ type, name, color: 'amber', ...(type === 'update-profile' ? { id } : {}) }, known));
    for (const color of ['orange', '#ffffff', null, 5, {}]) assert.throws(() => validateCommand({ type, name: 'Valid', color, ...(type === 'update-profile' ? { id } : {}) }, known));
  }
});

test('site settings migrate strict version 1 stores and validate bounded canonical origins and hosts', t => {
  const directory = temporaryDirectory(t, 'site-settings');
  const path = join(directory, 'store.json'), sample = sampleStore(directory);
  const legacy = { version: 1, history: sample.history, bookmarks: sample.bookmarks, downloads: sample.downloads };
  legacy.version = 1;
  writeFileSync(path, JSON.stringify(legacy));
  const migrated = readStore(path);
  assert.deepEqual(migrated, sample);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), sample);
  assert.equal(readdirSync(directory).some(name => name.includes('corrupt')), false);
  const cipher = authenticatedCipher(), encryptedLegacy = join(directory, 'encrypted.json');
  writeFileSync(encryptedLegacy, Buffer.concat([Buffer.from('HORIZON-STORE-1\n'), cipher.encryptString(JSON.stringify(legacy))]));
  assert.deepEqual(readStore(encryptedLegacy, cipher), sample);
  const settings = sample.siteSettings;
  setBlocking(settings, 'example.com', false);
  setPermission(settings, 'https://example.com', 'camera', 'allow');
  assert.equal(validateStore(sample), true);
  assert.equal(siteSettings(settings, 'http://example.com/').blocking, false);
  assert.equal(siteSettings(settings, 'http://example.com/').permissions.camera, 'ask');
  assert.equal(siteSettings(settings, 'https://example.com/').permissions.camera, 'allow');
  for (const host of ['', 'Example.com', 'user@example.com', 'example.com:443', 'example.com/path', 'example.com.', 'x'.repeat(254), '\0']) {
    const invalid = structuredClone(sample); invalid.siteSettings.blocking[0].host = host;
    assert.equal(validateStore(invalid), false, host);
  }
  for (const origin of ['https://example.com/', 'http://user@example.com', 'file:///private', 'about:blank', 'https://EXAMPLE.com', 'https://example.com/path', 'https://example.com#part', 'https://' + 'a'.repeat(2048)]) {
    const invalid = structuredClone(sample); invalid.siteSettings.permissions[0].origin = origin;
    assert.equal(validateStore(invalid), false, origin);
  }
  for (const change of [
    value => { value.siteSettings.extra = true; }, value => { delete value.siteSettings; },
    value => { value.siteSettings.blocking[0].enabled = 'false'; }, value => { value.siteSettings.permissions[0].camera = 'yes'; },
    value => { value.siteSettings.permissions[0].extra = true; }, value => { value.siteSettings.blocking.push(value.siteSettings.blocking[0]); },
    value => { value.siteSettings.permissions.push(value.siteSettings.permissions[0]); }, value => { value.siteSettings.blocking = new Array(1); },
    value => { value.siteSettings.permissions = new Array(SITE_SETTINGS_LIMIT + 1); },
  ]) { const invalid = structuredClone(sample); change(invalid); assert.equal(validateStore(invalid), false); }
  writeFileSync(path, JSON.stringify({ ...legacy, extra: true }));
  assert.equal(readStore(path).history.length, 0, 'Invalid legacy files are not migrated');
});

test('site commands accept exact keys and known values only', () => {
  const valid = [
    ...[true, false].map(enabled => ({ type: 'set-blocking', enabled })),
    ...['camera', 'microphone', 'location', 'notifications'].flatMap(permission => ['ask', 'allow', 'block'].map(decision => ({ type: 'set-site-permission', permission, decision }))),
    ...['allow', 'block', 'dismiss'].map(answer => ({ type: 'answer-permission', id: 'prompt', answer })),
  ];
  for (const command of valid) {
    assert.deepEqual(validateCommand(command), command);
    assert.throws(() => validateCommand({ ...command, origin: 'https://attacker.test' }));
    for (const key of Object.keys(command)) { const missing = { ...command }; delete missing[key]; assert.throws(() => validateCommand(missing)); }
  }
  for (const command of [
    { type: 'set-blocking', enabled: 1 }, { type: 'set-blocking', enabled: 'true' },
    { type: 'set-site-permission', permission: 'geolocation', decision: 'allow' },
    { type: 'set-site-permission', permission: 'camera', decision: 'dismiss' },
    { type: 'answer-permission', id: '', answer: 'allow' }, { type: 'answer-permission', id: 'x'.repeat(129), answer: 'allow' },
    { type: 'answer-permission', id: '\0', answer: 'allow' }, { type: 'answer-permission', id: 'prompt', answer: 'ask' },
    { type: 'answer-permission', id: 'prompt', answer: {} },
  ]) assert.throws(() => validateCommand(command));
});

test('permission queues combine media callbacks, remember decisions, dismiss once and refuse dropped requests', () => {
  const settings = { blocking: [], permissions: [] }, results = [];
  let remembered = 0, changed = 0;
  const queue = new PermissionQueue(settings, () => changed++, () => remembered++);
  const request = (tab, origin, permissions) => queue.request(tab, origin, permissions, allowed => results.push(allowed));
  assert.deepEqual(requestedPermissions('media', { mediaTypes: ['video', 'audio'] }), ['camera', 'microphone']);
  assert.deepEqual(requestedPermissions('media', { mediaType: 'unknown' }), []);
  assert.deepEqual(requestedPermissions('clipboard-read'), []);
  for (const origin of ['https://example.com', 'http://localhost:3000', 'http://sub.localhost', 'http://127.0.0.1', 'http://[::1]']) assert.equal(secureOrigin(origin), true);
  for (const origin of ['http://example.com', 'http://127.evil.test', 'https://user@example.com', 'file:///private']) assert.equal(secureOrigin(origin), false);
  request('tab', 'https://example.com', ['camera', 'microphone']);
  const media = queue.prompt('tab');
  request('tab', 'https://example.com', ['camera', 'microphone']);
  request('tab', 'https://example.com', ['location']);
  request('other', 'https://other.test', ['notifications']);
  assert.equal(queue.prompt('tab').id, media.id); assert.notEqual(queue.prompt('other').id, media.id);
  queue.answer('tab', media.id, 'allow');
  assert.deepEqual(results, [true, true]); assert.equal(remembered, 1);
  request('tab', 'https://example.com', ['camera']); assert.equal(results.at(-1), true);
  queue.answer('tab', queue.prompt('tab').id, 'dismiss');
  assert.equal(siteSettings(settings, 'https://example.com').permissions.location, 'ask'); assert.equal(remembered, 1);
  request('tab', 'https://example.com', ['location']);
  assert.equal(queue.prompt('tab'), null, 'A dismissed request is not asked again on the same page'); assert.equal(results.at(-1), false);
  request('second', 'https://example.com', ['location']); assert.notEqual(queue.prompt('second'), null); queue.drop('second');
  setPermission(settings, 'https://example.com', 'location', 'allow');
  request('tab', 'https://example.com', ['location']); assert.equal(results.at(-1), true, 'A stored decision outranks a dismissal');
  setPermission(settings, 'https://example.com', 'location', 'ask');
  queue.drop('tab');
  request('tab', 'https://example.com', ['location']);
  queue.answer('tab', queue.prompt('tab').id, 'block');
  request('tab', 'https://example.com', ['location']); assert.equal(queue.prompt('tab'), null); assert.equal(results.at(-1), false);
  const stale = queue.prompt('other').id; queue.drop('other');
  assert.equal(queue.prompt('other'), null); assert.equal(results.at(-1), false);
  assert.throws(() => queue.answer('other', stale, 'allow'), /STALE/);
  request('tab', 'http://insecure.test', ['camera']); assert.equal(results.at(-1), false);
  assert.deepEqual(defaultPermissions(), { camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'ask' });
  assert.ok(changed > 0);
});

test('cookie headers use schemeful registrable sites and private suffixes and count distinct site/name pairs', () => {
  assert.equal(cookieSite('https://a.example.co.uk/'), 'https://example.co.uk');
  assert.notEqual(cookieSite('https://one.github.io/'), cookieSite('https://two.github.io/'));
  assert.equal(cookieSite('wss://a.example.com/'), cookieSite('https://b.example.com/'));
  const refused = new Set();
  const headers = { Cookie: 'id=one; id=two; token=three', Accept: '*/*' };
  assert.deepEqual(stripCookieHeaders(headers, false, 'https://third.test', 'https://first.test', true, refused), { Accept: '*/*' });
  assert.equal(refused.size, 2); assert.equal(headers.Cookie, 'id=one; id=two; token=three');
  assert.deepEqual(stripCookieHeaders({ 'set-cookie': ['id=other; Secure', 'another=one; Expires=Thu, 01 Jan 2037 00:00:00 GMT'] }, true, 'https://third.test', 'https://first.test', true, refused), {});
  assert.equal(refused.size, 3);
  stripCookieHeaders({ cookie: 'id=one' }, false, 'https://different.test', 'https://first.test', true, refused); assert.equal(refused.size, 4);
  assert.equal(stripCookieHeaders(headers, false, 'https://third.test', 'https://first.test', false, refused), headers);
  assert.equal(stripCookieHeaders(headers, false, 'https://a.example.com', 'https://b.example.com', true, refused), headers);
});

const {
  LIST_BYTES_LIMIT, LIST_HOSTS, assertListURL, createBlockingEngine,
  downloadFilterList, isPublicListAddress, safeCosmeticCSS,
} = require('../dist/electron/blocking.js');
const list = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/easylist/easylist.txt';

function blockingDirectory(t) {
  mkdirSync('.runtime', { recursive: true });
  const root = mkdtempSync(resolve('.runtime/blocking-test-'));
  t.after(() => { assert.ok(root.startsWith(resolve('.runtime') + require('node:path').sep)); rmSync(root, { recursive: true, force: true }); });
  return root;
}

function filterSource(url) {
  if (url.endsWith('resources.json')) return JSON.stringify({
    redirects: [{ name: 'nooptext', aliases: [], body: '', contentType: 'text/plain' }], scriptlets: [],
  });
  if (url.endsWith('/easylist.txt')) return [
    '||ad.example^', '@@||ad.example/okay^', '||redir.example^$redirect=nooptext',
    '||sock.example^', 'site.example##.sponsor', '##div[data-ad]',
  ].join('\n');
  if (url.endsWith('/easyprivacy.txt')) return '||track.example^';
  return '';
}

test('list boundary accepts only package URLs on the fixed HTTPS host and public DNS addresses', () => {
  assert.deepEqual(LIST_HOSTS, ['raw.githubusercontent.com']);
  assert.equal(assertListURL(list).href, list);
  for (const value of [
    list.replace('https:', 'http:'), list.replace('raw.githubusercontent.com', 'evil.example'),
    list.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.evil.example'),
    list + '?other', list + '#fragment', list.replace('easylist.txt', 'extra.txt'),
    list.replace('https://', 'https://user@'),
  ]) assert.throws(() => assertListURL(value), /FILTER_SOURCE_REFUSED/);
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPublicListAddress(address), false, address);
  }
  assert.equal(isPublicListAddress('8.8.8.8'), true);
  assert.equal(isPublicListAddress('::ffff:8.8.8.8'), true);
  assert.equal(isPublicListAddress('::ffff:808:808'), true);
  for (const [first, last, before, after] of [
    ['192.31.196.0', '192.31.196.255', '192.31.195.255', '192.31.197.0'],
    ['192.52.193.0', '192.52.193.255', '192.52.192.255', '192.52.194.0'],
    ['192.88.99.0', '192.88.99.255', '192.88.98.255', '192.88.100.0'],
    ['192.175.48.0', '192.175.48.255', '192.175.47.255', '192.175.49.0'],
    ['64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '64:ff9b:0:ffff:ffff:ffff:ffff:ffff', '64:ff9b:2::'],
    ['100::', '100::ffff:ffff:ffff:ffff', 'ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '100:0:0:1::'],
    ['2001::', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:200::'],
    ['2620:4f:8000::', '2620:4f:8000:ffff:ffff:ffff:ffff:ffff', '2620:4f:7fff:ffff:ffff:ffff:ffff:ffff', '2620:4f:8001::'],
    ['3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '3fff:1000::'],
    ['5f00::', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '5f01::'],
    ['fec0::', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ]) {
    for (const address of [first, last]) assert.equal(isPublicListAddress(address), false, address);
    for (const address of [before, after].filter(Boolean)) assert.equal(isPublicListAddress(address), true, address);
  }
  assert.equal(isPublicListAddress('2001:2::'), false);
});

test('list response refuses redirects, oversized headers and streams, and timed out headers or bodies', async t => {
  let called = false;
  for (const url of [list.replace('https:', 'http:'), list.replace('raw.githubusercontent.com', 'evil.test')]) {
    await assert.rejects(downloadFilterList(url, async () => { called = true; return new Response('unexpected'); }), /FILTER_SOURCE_REFUSED/);
  }
  assert.equal(called, false);
  await assert.rejects(downloadFilterList(list, async () => new Response(null, { status: 302 })), /FILTER_RESPONSE_REFUSED/);
  await assert.rejects(downloadFilterList(list, async () => new Response('small', { headers: { 'content-length': String(LIST_BYTES_LIMIT + 1) } })), /FILTER_RESPONSE_REFUSED/);
  const tooLarge = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(LIST_BYTES_LIMIT + 1)); controller.close(); } }));
  await assert.rejects(downloadFilterList(list, async () => tooLarge()), /FILTER_SIZE_LIMIT/);
  let deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', duration => { assert.equal(duration, 30000); return deadline.signal; });
  const headers = downloadFilterList(list, () => new Promise(() => undefined));
  deadline.abort();
  await assert.rejects(headers, /FILTER_TIMEOUT/);
  deadline = new AbortController();
  const slowBody = downloadFilterList(list, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([65])); }, cancel() { return new Promise(() => undefined); } })));
  setImmediate(() => deadline.abort());
  await assert.rejects(slowBody, /FILTER_TIMEOUT/);
});

test('two serialized engines classify ads and trackers, respect exceptions and allow neutral data redirects', async t => {
  const root = blockingDirectory(t);
  let changed = 0, downloads = 0;
  const first = createBlockingEngine(root, () => changed++, { download: async url => { downloads++; return filterSource(url); } });
  assert.equal(first.ready, false);
  assert.equal(first.match('https://ad.example/x', 'image', 'https://site.example/'), undefined);
  assert.equal(await first.refresh(), true);
  assert.equal(downloads, 15);
  assert.equal(changed, 1);
  assert.deepEqual(first.match('https://ad.example/x', 'image', 'https://site.example/'), { kind: 'ads' });
  assert.deepEqual(first.match('https://track.example/x', 'script', 'https://site.example/'), { kind: 'trackers' });
  assert.equal(first.match('https://ad.example/okay', 'image', 'https://site.example/'), undefined);
  assert.deepEqual(first.match('ws://sock.example/connect', 'webSocket', 'https://site.example/'), { kind: 'ads' });
  assert.deepEqual(first.match('https://redir.example/x', 'script', 'https://site.example/'), { kind: 'ads', redirectURL: 'data:text/plain;base64,' });
  assert.match(first.cosmeticCSS('https://site.example/'), /\.sponsor \{ display: none !important; \}/);
  assert.doesNotMatch(first.cosmeticCSS('https://site.example/'), /div\[data-ad\]/);
  first.stop();
  const cached = createBlockingEngine(root);
  await cached.start();
  assert.equal(cached.ready, true);
  assert.deepEqual(cached.match('https://track.example/x', 'script', 'https://site.example/'), { kind: 'trackers' });
  cached.stop();
});

test('stale refresh failure keeps the serialized last good engine', async t => {
  const root = blockingDirectory(t), initial = Date.now();
  const first = createBlockingEngine(root, undefined, { now: () => initial, download: async url => filterSource(url) });
  assert.equal(await first.refresh(), true);
  first.stop();
  const kept = readFileSync(join(root, 'adblock', 'engines.bin'));
  let attempted = 0;
  const stale = createBlockingEngine(root, undefined, { now: () => initial + 24 * 60 * 60 * 1000 + 1, download: async () => { attempted++; throw new Error('offline'); } });
  await stale.start();
  await stale.refresh();
  assert.ok(attempted > 0);
  assert.equal(stale.ready, true);
  assert.deepEqual(stale.match('https://ad.example/x', 'image', 'https://site.example/'), { kind: 'ads' });
  assert.deepEqual(readFileSync(join(root, 'adblock', 'engines.bin')), kept);
  stale.stop();
  const empty = createBlockingEngine(root, undefined, { download: async url => url.endsWith('resources.json') ? filterSource(url) : '' });
  assert.equal(await empty.refresh(), false);
  assert.deepEqual(readFileSync(join(root, 'adblock', 'engines.bin')), kept);
  empty.stop();
});

test('cosmetic sanitization keeps only fixed hiding declarations and refuses loading CSS', () => {
  const styles = '.ad { display:none!important; } .remote { background:url(https://evil.example/x); } .font { @font-face:x; } .custom { opacity:0; }';
  assert.deepEqual(safeCosmeticCSS(styles), { css: '.ad { display: none !important; }', rules: 1 });
});
