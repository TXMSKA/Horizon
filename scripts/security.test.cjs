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
const { darkPagesActive, darkPagesCSS, DARK_FILTERS, MEDIAWIKI_DARK_CSS, setDarkPagesSwitch } = require('../dist/electron/dark-pages.js');
const { browserShortcut } = require('../dist/src/shared/shortcuts.js');
const { cleanupPartitions, makeProfile, migrateStore, profileStorePath, readRegistry, validateRegistry, writeRegistry, removeProfileDirectory } = require('../dist/electron/profiles.js');
const { randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');
const { contextMenuGroups, PageMenuSession } = require('../dist/electron/context-menu.js');
const { PermissionQueue, defaultPermissions, requestedPermissions, setPermission, setBlocking, setSiteDark, siteSettings, stripCookieHeaders, cookieSite, secureOrigin, SITE_SETTINGS_LIMIT } = require('../dist/electron/site-settings.js');
const testTemporaryRoot = resolve(process.env.HORIZON_TEST_TEMP ?? '.runtime');

test('quick access migrates settings versions 1 through 3 without losing their saved choices', t => {
  const directory = temporaryDirectory(t, 'quick-access-migration'), path = join(directory, 'settings.json');
  const defaults = readSettings(path);
  assert.equal(defaults.version, 4); assert.deepEqual(defaults.quickAccess, []);
  const third = { ...defaults, version: 3, searchEngine: 'brave', language: 'es', askWhereToSave: true, blockAds: false, blockThirdPartyCookies: false }; delete third.quickAccess;
  const versions = [{ version: 1, theme: 'amber', contrast: 'high' }, { version: 2, theme: 'daylight', contrast: 'standard', darkPages: 'on', darkStrength: 'deep', darkTone: 'warm' }, third];
  for (const previous of versions) {
    writeFileSync(path, JSON.stringify(previous));
    const expected = { ...defaults, ...previous, version: 4, quickAccess: [] };
    assert.deepEqual(readSettings(path), expected); assert.deepEqual(JSON.parse(readFileSync(path)), expected);
  }
  const { compileFunction } = require('node:vm'), filename = resolve('dist/electron/settings.js'), localRequire = require('node:module').createRequire(filename), exported = {};
  writeFileSync(path, JSON.stringify(third));
  compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require'])(exported, name => name === 'node:fs' ? { ...localRequire(name), writeFileSync() { throw new Error('Read-only settings'); } } : localRequire(name));
  assert.deepEqual(exported.readSettings(path), { ...defaults, ...third, version: 4, quickAccess: [] });
  assert.deepEqual(JSON.parse(readFileSync(path)), third);
});

test('quick access rejects unknown ids, duplicates, sparse arrays and more than six entries', t => {
  const { isQuickAccess } = require('../dist/electron/settings.js'), { HUB_APPS, QUICK_ACCESS_LIMIT } = require('../dist/src/shared/api.js');
  assert.equal(QUICK_ACCESS_LIMIT, 6);
  const directory = temporaryDirectory(t, 'quick-access-validation'), path = join(directory, 'settings.json'), defaults = readSettings(path);
  assert.equal(isQuickAccess([]), true);
  for (const id of HUB_APPS) assert.equal(validateSettings({ ...defaults, quickAccess: [id] }), true);
  for (const quickAccess of [null, {}, 'themes', [null], ['unknown'], ['__proto__'], ['themes', 'themes'], new Array(1), Array(7).fill('themes')]) {
    assert.equal(isQuickAccess(quickAccess), false); assert.equal(validateSettings({ ...defaults, quickAccess }), false);
    assert.throws(() => writeSettings(path, { ...defaults, quickAccess }));
  }
  const missing = { ...defaults }; delete missing.quickAccess; assert.equal(validateSettings(missing), false);
  const corrupt = { ...defaults, quickAccess: ['unknown'] }; writeFileSync(path, JSON.stringify(corrupt));
  assert.deepEqual(readSettings(path), defaults);
  assert.ok(readdirSync(directory).some(name => name.startsWith('settings.json.corrupt-') && readFileSync(join(directory, name), 'utf8') === JSON.stringify(corrupt)));
});

test('pin and unpin have exact command shapes and save idempotently without exposing mutable settings', t => {
  const directory = temporaryDirectory(t, 'quick-access-settings'), path = join(directory, 'settings.json'), changes = [];
  const settings = createSettings(path, theme => changes.push(theme));
  for (const type of ['pin-app', 'unpin-app']) {
    const command = { type, id: 'themes' }; assert.deepEqual(validateCommand(command), command);
    for (const invalid of [{ type }, { ...command, id: null }, { ...command, id: 'unknown' }, { ...command, id: '__proto__' }, { ...command, extra: true }]) assert.throws(() => validateCommand(invalid));
  }
  settings.setAppPinned('themes', true); settings.setAppPinned('themes', true);
  assert.deepEqual(settings.quickAccess, ['themes']); assert.deepEqual(readSettings(path).quickAccess, ['themes']); assert.equal(changes.length, 1);
  const exposed = settings.quickAccess; exposed.length = 0; assert.deepEqual(settings.quickAccess, ['themes']);
  assert.deepEqual(createSettings(path, () => {}).quickAccess, ['themes']);
  for (const [id, pinned] of [['unknown', true], ['themes', 'yes'], [null, false]]) assert.throws(() => settings.setAppPinned(id, pinned), /QUICK_ACCESS_INVALID/);
  settings.setAppPinned('themes', false); settings.setAppPinned('themes', false);
  assert.deepEqual(settings.quickAccess, []); assert.deepEqual(readSettings(path).quickAccess, []); assert.equal(changes.length, 2);
  rmSync(path); mkdirSync(path);
  assert.throws(() => settings.setAppPinned('themes', true), /SETTINGS_SAVE_FAILED/); assert.deepEqual(settings.quickAccess, []); assert.equal(changes.length, 2);
});

test('quick-access IPC publishes pinning immediately and retains it across local profiles', t => {
  const browser = notebookBrowser(t), { command, state } = browser;
  assert.deepEqual(state().quickAccess, []);
  command({ type: 'pin-app', id: 'themes' }); assert.deepEqual(state().quickAccess, ['themes']);
  const first = state().activeProfileId;
  command({ type: 'create-profile', name: 'Hub profile', color: 'blue' }); assert.notEqual(state().activeProfileId, first); assert.deepEqual(state().quickAccess, ['themes']);
  command({ type: 'unpin-app', id: 'themes' }); assert.deepEqual(state().quickAccess, []);
  command({ type: 'switch-profile', id: first }); assert.deepEqual(state().quickAccess, []);
  assert.throws(() => command({ type: 'pin-app', id: 'unknown' })); assert.deepEqual(state().quickAccess, []);
  const path = join(browser.directory, 'settings.json'); rmSync(path); mkdirSync(path);
  assert.throws(() => command({ type: 'pin-app', id: 'themes' }), /SETTINGS_SAVE_FAILED/); assert.deepEqual(state().quickAccess, []);
});

test('toolbar, Hub and profiles copy is present in English and Spanish', () => {
  const { copy, text } = interfaceModule('src/copy.ts');
  for (const key of ['toolbar', 'hub', 'hubHome', 'themes', 'installed', 'quickAccess', 'appActions', 'openApp', 'addQuickAccess', 'removeQuickAccess', 'savingQuickAccess', 'addedQuickAccess', 'removedQuickAccess', 'QUICK_ACCESS_INVALID', 'QUICK_ACCESS_LIMIT', 'SETTINGS_SAVE_FAILED', 'profile', 'profiles', 'newProfile', 'manageProfiles', 'amber', 'daylight', 'highContrast', 'lyra', 'askLyra', 'unavailable']) {
    for (const language of ['en', 'es']) assert.ok(typeof copy[key][language] === 'string' && text(key, language).trim(), `${key}: ${language}`);
  }
  for (const [language, saving, added, removed] of [['en', 'Saving quick access?', 'Added Themes to quick access', 'Removed Themes from quick access'], ['es', 'Guardando acceso r?pido?', 'Se agreg? Temas a acceso r?pido', 'Se quit? Temas de acceso r?pido']]) {
    assert.equal(text('savingQuickAccess', language), saving);
    assert.equal(text('addedQuickAccess', language).replace('{name}', text('themes', language)), added);
    assert.equal(text('removedQuickAccess', language).replace('{name}', text('themes', language)), removed);
  }
  assert.equal(text('hub', 'en'), 'Hub'); assert.equal(text('themes', 'en'), 'Themes'); assert.equal(text('installed', 'en'), 'Installed');
  assert.equal(text('addQuickAccess', 'en'), 'Add to quick access'); assert.equal(text('removeQuickAccess', 'en'), 'Remove from quick access');
});

test('toolbar popovers mount on the body and track the opener six pixels below and right-aligned', () => {
  const hooks = notebookTestHooks(), body = {}, events = new Map(), positioned = new Map(); let resize;
  const { ToolbarPopover } = interfaceModule('src/ToolbarPopover.tsx', { react: hooks.react, 'react-dom': { createPortal(node, host) { assert.equal(host, body); return node; } } }, {
    document: { body }, innerWidth: 1440, innerHeight: 900,
    getComputedStyle: () => ({ getPropertyValue: name => name === '--toolbar-popup-gap' ? '6px' : '12px' }),
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} },
    window: { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) },
  });
  const trigger = { right: 1100, bottom: 86 }, opener = { current: { getBoundingClientRect: () => trigger } };
  const tree = hooks.render(() => ToolbarPopover({ opener, children: 'Hub' }));
  tree.props.ref.current = { getBoundingClientRect: () => ({ width: 360 }), style: { setProperty: (name, value) => positioned.set(name, value) } };
  hooks.flush(); assert.equal(tree.props.style, undefined);
  assert.deepEqual([...positioned], [['left', '740px'], ['top', '92px'], ['--popup-available-height', '796px']]);
  trigger.right = 200; trigger.bottom = 120; resize();
  assert.equal(positioned.get('left'), '12px'); assert.equal(positioned.get('top'), '126px');
  hooks.dispose(); assert.equal(events.size, 0);
});

test('Hub tiles, dock and menus support keyboard opening, pending saves, retry and Escape focus', async () => {
  const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts'), sent = [], dismissed = [], announced = [], events = new Map();
  let page = 'home', complete, reject, focused = 0;
  const document = { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name), activeElement: null };
  const { Hub } = interfaceModule('src/Hub.tsx', { react: hooks.react, 'lucide-react': {}, './copy': copy, './shared/api': require('../dist/src/shared/api.js'), './Menu': { Menu: 'menu' }, './ToolbarPopover': { ToolbarPopover: 'popover' }, './Settings': { settingsError: (_reason, language) => copy.text('SETTINGS_SAVE_FAILED', language) } }, {
    document, window: { horizon: { command: command => { sent.push(command); return new Promise((resolve, fail) => { complete = resolve; reject = fail; }); } } },
  });
  const state = { quickAccess: [] }, opener = { current: { contains: () => false } }, focus = { focus: () => focused++ };
  const render = () => hooks.render(() => Hub({ state, language: 'en', page, opener, onPage: value => { page = value; }, onAnnounce: value => announced.push(value), onDismiss: value => dismissed.push(value) }));
  const nodes = (tree, role) => notebookNodes(tree, node => node.props.role === role);
  const tile = tree => notebookNodes(tree, node => node.props.className === 'hub-tile')[0];
  const key = (key, shiftKey = false) => ({ key, shiftKey, preventDefault() {}, stopPropagation() {} });
  let tree = render(), dialog = nodes(tree, 'dialog')[0];
  dialog.props.ref.current = { contains: () => false, querySelector: () => focus, querySelectorAll: () => [] };
  tile(tree).props.ref.current = focus; hooks.flush();
  assert.equal(dialog.props['aria-label'], 'Hub'); assert.equal(tile(tree).props.children[1].props.children, 'Themes');
  const currentTarget = { parentElement: { children: [focus] } }; tile(tree).props.onKeyDown({ ...key('ArrowRight'), currentTarget }); assert.equal(focused, 2);
  tile(tree).props.onKeyDown(key('ContextMenu')); tree = render(); hooks.flush();
  assert.equal(tile(tree).props['aria-expanded'], true); assert.deepEqual(nodes(tree, 'menuitem').map(node => node.props.children[1].props.children), ['Open', 'Add to quick access']);
  nodes(tree, 'menuitem')[1].props.onClick(); nodes(tree, 'menuitem')[1].props.onClick(); tree = render(); hooks.flush();
  assert.deepEqual(sent, [{ type: 'pin-app', id: 'themes' }]); assert.equal(nodes(tree, 'dialog')[0].props['aria-busy'], true);
  notebookNodes(tree, node => node.type === 'menu')[0].props.onDismiss('escape'); tree = render(); hooks.flush();
  complete(); for (let i = 0; i < 4; i++) await Promise.resolve(); assert.deepEqual(dismissed, []);
  state.quickAccess = ['themes']; tile(tree).props.onKeyDown(key('F10', true)); tree = render(); hooks.flush();
  assert.equal(nodes(tree, 'menuitem')[1].props.children[1].props.children, 'Remove from quick access'); nodes(tree, 'menuitem')[1].props.onClick();
  reject(new Error('SETTINGS_SAVE_FAILED')); for (let i = 0; i < 4; i++) await Promise.resolve(); tree = render();
  assert.equal(nodes(tree, 'menuitem').length, 0);
  const beforeRetryFocus = focused; nodes(tree, 'alert')[0].props.children[1].props.ref.current = focus; hooks.flush();
  assert.equal(focused, beforeRetryFocus + 1);
  assert.equal(announced.at(-1), copy.text('SETTINGS_SAVE_FAILED', 'en'));
  assert.equal(nodes(tree, 'alert')[0].props.children[0].props.children, copy.text('SETTINGS_SAVE_FAILED', 'en'));
  nodes(tree, 'alert')[0].props.children[1].props.onClick(); complete(); for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.deepEqual(sent.slice(1), [{ type: 'unpin-app', id: 'themes' }, { type: 'unpin-app', id: 'themes' }]); assert.deepEqual(dismissed, [true]);
  nodes(tree, 'dialog')[0].props.onKeyDown(key('Escape')); tree = render(); hooks.flush();
  nodes(tree, 'dialog')[0].props.onKeyDown(key('Escape')); assert.deepEqual(dismissed, [true, true, true]);
  const stops = [{ focus() {} }, focus]; dialog = nodes(tree, 'dialog')[0];
  dialog.props.ref.current.querySelectorAll = () => stops;
  let prevented = false; document.activeElement = stops[1];
  dialog.props.onKeyDown({ ...key('Tab'), preventDefault() { prevented = true; } });
  document.activeElement = stops[0]; dialog.props.onKeyDown(key('Tab', true));
  assert.equal(prevented, false); assert.deepEqual(dismissed.slice(-2), [true, true]);
  assert.deepEqual(announced, [copy.text('savingQuickAccess', 'en'), 'Added Themes to quick access', copy.text('savingQuickAccess', 'en'), copy.text('SETTINGS_SAVE_FAILED', 'en'), copy.text('savingQuickAccess', 'en'), 'Removed Themes from quick access']);
  tile(tree).props.onClick(); assert.equal(page, 'themes'); tree = render(); hooks.flush();
  notebookNodes(tree, node => node.props['aria-label'] === 'Hub Home')[0].props.onClick(); assert.equal(page, 'home');
  hooks.dispose(); assert.equal(events.size, 0);
});

test('installed theme radios save explicit choices, follow system changes and serialize theme and contrast', async () => {
  const hubHooks = notebookTestHooks(), themeHooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts'), commands = [];
  let hooks = hubHooks;
  const react = Object.fromEntries(Object.keys(hubHooks.react).map(key => [key, (...args) => hooks.react[key](...args)]));
  let complete, changed;
  const system = { matches: true, addEventListener(_name, callback) { changed = callback; }, removeEventListener() {} };
  const state = { theme: 'system', contrast: 'standard', quickAccess: [] };
  const { Hub } = interfaceModule('src/Hub.tsx', { react, 'lucide-react': { Check: 'Check' }, './copy': copy, './shared/api': require('../dist/src/shared/api.js'), './Menu': {}, './ToolbarPopover': { ToolbarPopover: 'popover' }, './Settings': { settingsError: () => 'Failed' } }, {
    matchMedia: () => system, window: { horizon: { command: command => { commands.push(command); return new Promise(resolve => { complete = () => { state[command.type] = command.value; resolve(); }; }); } } },
  });
  // A Hub page supplies the radio component's props without needing a browser window.
  const tree = hubHooks.render(() => Hub({ state, language: 'en', page: 'themes', opener: { current: null }, onPage() {}, onDismiss() {}, onAnnounce() {} }));
  const installed = notebookNodes(tree, node => typeof node.type === 'function' && node.props.state === state)[0];
  hooks = themeHooks;
  const render = () => themeHooks.render(() => installed.type(installed.props));
  const radios = tree => notebookNodes(tree, node => node.props.role === 'radio');
  let panel = render(); themeHooks.flush(); assert.equal(radios(panel)[0].props['aria-checked'], true);
  system.matches = false; changed(); panel = render(); assert.equal(radios(panel)[1].props['aria-checked'], true);
  radios(panel)[1].props.onClick(); assert.deepEqual(commands, [{ type: 'theme', value: 'daylight' }]); complete(); for (let i = 0; i < 4; i++) await Promise.resolve();
  panel = render(); const currentTarget = { parentElement: { children: [{ focus() {} }, { focus() {} }, { focus() {} }] } };
  radios(panel)[1].props.onKeyDown({ key: 'ArrowRight', currentTarget, preventDefault() {} }); radios(panel)[2].props.onClick();
  assert.deepEqual(commands.at(-1), { type: 'theme', value: 'amber' }); complete(); for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.deepEqual(commands.at(-1), { type: 'contrast', value: 'high' }); complete(); for (let i = 0; i < 4; i++) await Promise.resolve();
  panel = render(); assert.equal(commands.length, 3); assert.equal(radios(panel)[2].props['aria-checked'], true);
  assert.equal(radios(panel)[2].props.tabIndex, 0); assert.ok(radios(panel).slice(0, 2).every(node => node.props.tabIndex === -1));
  assert.equal(notebookNodes(panel, node => node.type === 'Check').length, 1);
  themeHooks.dispose();
});

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
  mkdirSync(testTemporaryRoot, { recursive: true });
  const parent = mkdtempSync(join(testTemporaryRoot, 'protocol-'));
  t.after(() => {
    assert.ok(parent.startsWith(testTemporaryRoot + require('node:path').sep));
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
      querySelector(selector) { if (selector === 'input:not(:disabled)') return null; if (selector === '[aria-checked=true]') return items[1]; assert.ok(selector.includes(':not(:disabled)')); return items[0]; },
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

function interfaceModule(filename, dependencies = {}, globals = {}) {
  const { compileFunction } = require('node:vm');
  const { transpileModule, ModuleKind, JsxEmit } = require('typescript');
  const source = transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  const exported = {}, jsx = (type, props) => ({ type, props });
  compileFunction(source, ['exports', 'require', ...Object.keys(globals)])(exported, name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected interface import: ${name}`);
    return dependencies[name];
  }, ...Object.values(globals));
  return exported;
}

function interfaceChildren(node) {
  return [node.props.children].flat(Infinity).filter(child => child && typeof child === 'object');
}

test('settings copy and each named settings failure are available in both languages', () => {
  const ts = require('typescript'), { copy } = interfaceModule('src/copy.ts');
  const api = ts.createSourceFile('api.ts', readFileSync('src/shared/api.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const failures = api.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'SettingsError');
  const keys = new Set(['settings', 'general', 'appearance', 'privacy', 'profiles']);
  for (const key of Object.keys(copy)) keys.add(key);
  for (const failure of failures.type.types) keys.add(failure.literal.text);
  for (const filename of ['src/Settings.tsx', 'src/Profiles.tsx']) {
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'text'].includes(node.expression.text) && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const key of keys) for (const language of ['en', 'es']) assert.ok(typeof copy[key]?.[language] === 'string' && copy[key][language].trim(), `${key}: ${language}`);
});

test('settings fixes keep the approved hints and history failure in both languages', () => {
  const { copy } = interfaceModule('src/copy.ts');
  const expected = {
    sitesOwnSettingsNone: ['None yet', 'Ninguno todavía'],
    blockingOffSettings: ['Off for every site in Settings', 'Desactivado para todos los sitios en Configuración'],
    defaultBrowserDevelopment: ['Horizon is not your default browser. This works in the installed app.', 'Horizon no es tu navegador predeterminado. Funciona en la aplicación instalada.'],
    CLEAR_HISTORY_FAILED: ['Browsing history could not be cleared. Try again.', 'No se pudo borrar el historial de navegación. Probá de nuevo.'],
  };
  for (const [key, [en, es]] of Object.entries(expected)) assert.deepEqual(copy[key], { en, es });
});

test('profile drafts survive editor remounts, lock during save and clear on Cancel or successful Save', async () => {
  let hooks = notebookTestHooks(), finish, cancelled = 0;
  const react = Object.fromEntries(Object.keys(hooks.react).map(key => [key, (...args) => hooks.react[key](...args)]));
  const sent = [], profile = { id: 'draft-profile', name: 'Work', color: 'blue' };
  const module = interfaceModule('src/Profiles.tsx', { react, 'lucide-react': notebookTestIcons, './copy': interfaceModule('src/copy.ts'), './shared/api': require('../dist/src/shared/api.js'), './Menu': {}, './ToolbarPopover': {} },
    { window: { horizon: { command: command => { sent.push(command); return new Promise(resolve => { finish = resolve; }); } } } });
  const render = () => hooks.render(() => module.ProfileForm({ language: 'en', profiles: [profile], profile, onCancel: () => { cancelled++; }, onSuccess() {} }));
  const input = tree => notebookNodes(tree, node => node.type === 'input')[0];
  const radios = tree => notebookNodes(tree, node => node.props.role === 'radio');
  let tree = render(); input(tree).props.onChange({ target: { value: 'Draft' } });
  tree = render(); radios(tree).find(node => node.props['data-profile-color'] === 'green').props.onClick();
  hooks = notebookTestHooks(); tree = render();
  assert.equal(input(tree).props.value, 'Draft');
  assert.equal(radios(tree).find(node => node.props['aria-checked']).props['data-profile-color'], 'green');
  tree.props.onSubmit({ preventDefault() {} }); tree = render();
  assert.equal(input(tree).props.readOnly, true); assert.ok(radios(tree).every(node => node.props.disabled));
  input(tree).props.onChange({ target: { value: 'Lost edit' } }); radios(tree)[0].props.onClick(); tree.props.onSubmit({ preventDefault() {} });
  assert.equal(sent.length, 1); assert.equal(input(render()).props.value, 'Draft');
  finish(); for (let index = 0; index < 5; index++) await Promise.resolve();
  hooks = notebookTestHooks(); tree = render(); assert.equal(input(tree).props.value, 'Work');
  input(tree).props.onChange({ target: { value: 'Discard' } }); tree = render();
  notebookNodes(tree, node => node.props.className === 'profile-action quiet')[0].props.onClick();
  hooks = notebookTestHooks(); tree = render(); assert.equal(input(tree).props.value, 'Work'); assert.equal(cancelled, 1);
});

test('history clear refuses memory-only and failed stores without losing history or changing disk', async t => {
  for (const memoryOnly of [false, true]) {
    let path;
    const options = { prepare(directory) {
      const registry = readRegistry(join(directory, 'profiles.json'), 'en');
      path = profileStorePath(directory, registry.activeId);
      writeStore(path, sampleStore(directory), memoryOnly ? authenticatedCipher() : plainCipher);
    } };
    const browser = notebookBrowser(t, plainCipher, options);
    browser.navigate();
    const history = structuredClone(browser.state().store.history), disk = readFileSync(path);
    options.failStore = !memoryOnly;
    await assert.rejects(browser.command({ type: 'clear-browsing-data', history: true, cookies: false, cache: false }), /CLEAR_HISTORY_FAILED/);
    assert.deepEqual(browser.state().store.history, history);
    assert.deepEqual(readFileSync(path), disk);
    assert.equal(browser.state().storageError, true);
    assert.equal(browser.state().clearingBrowsingData, false);
    browser.close();
  }
});

test('close records failed history storage, retains history and still clears cache and other profiles', async t => {
  const options = {}, browser = notebookBrowser(t, plainCipher, options);
  browser.navigate();
  browser.command({ type: 'set-clear-history-on-close', value: true });
  browser.command({ type: 'set-clear-cache-on-close', value: true });
  const history = structuredClone(browser.state().store.history);
  const other = browser.state().profiles.find(profile => profile.id !== browser.state().activeProfileId);
  const store = sampleStore(browser.directory); store.clearHistoryOnClose = true; store.clearCacheOnClose = true;
  writeStore(profileStorePath(browser.directory, other.id), store);
  options.failStore = true;
  browser.app.emit('before-quit', { preventDefault() {} });
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.deepEqual(browser.state().store.history, history);
  assert.equal(browser.state().storageError, true);
  assert.equal(browser.sessions.size, 2);
  for (const session of browser.sessions.values()) assert.ok(session.cleared.some(([name]) => name === 'clearCache'));
  browser.close();
});

test('registry runner always receives the absolute SystemRoot path or the Windows fallback', async t => {
  const { createDefaultBrowser } = require('../dist/electron/default-browser.js');
  const original = process.env.SystemRoot;
  t.after(() => { if (original === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = original; });
  for (const root of ['D:\\Windows', undefined]) {
    if (root === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = root;
    const calls = [];
    const service = createDefaultBrowser({ platform: 'win32', isPackaged: true, execPath: 'C:\\Horizon.exe', runner: async (command, args) => { calls.push([command, args]); return ''; }, openExternal: async () => {} });
    await service.refresh(); await service.register();
    assert.ok(calls.some(([, args]) => args[0] === 'query'));
    assert.ok(calls.some(([, args]) => args[0] === 'add'));
    for (const [command] of calls) assert.equal(command, `${root ?? 'C:\\Windows'}\\System32\\reg.exe`);
  }
});

test('settings sections and their public addresses map one to one', () => {
  const ts = require('typescript'), { settingsAddress, settingsSection } = require('../dist/electron/browsing.js');
  const source = ts.createSourceFile('api.ts', readFileSync('src/shared/api.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const type = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'SettingsSection');
  const sections = type.type.types.map(node => node.literal.text);
  const expected = { general: 'horizon://settings', appearance: 'horizon://settings/appearance', privacy: 'horizon://settings/privacy', 'privacy/sites': 'horizon://settings/privacy/sites', profiles: 'horizon://settings/profiles' };
  assert.deepEqual(sections.sort(), Object.keys(expected).sort());
  assert.equal(new Set(sections.map(settingsAddress)).size, sections.length);
  for (const [section, address] of Object.entries(expected)) {
    assert.equal(settingsAddress(section), address); assert.equal(settingsSection(address), section);
    assert.equal(settingsSection(address + '/'), null); assert.equal(settingsSection(address + '?section=profiles'), null);
  }
  assert.equal(settingsSection('horizon://settings/general'), null);
  const page = ts.createSourceFile('Settings.tsx', readFileSync('src/Settings.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rail = page.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(page) === 'SETTINGS_SECTIONS');
  const entries = rail.initializer.expression.elements;
  const destinations = entries.map(entry => entry.properties.find(property => property.name.getText(page) === 'section').initializer.text);
  assert.deepEqual(destinations, ['general', 'appearance', 'privacy', 'profiles']);
  for (const section of destinations) assert.equal(settingsSection(settingsAddress(section)), section);
});

test('profiles are managed in settings and the profiles panel route is removed', () => {
  const app = readFileSync('src/App.tsx', 'utf8'), profiles = readFileSync('src/Profiles.tsx', 'utf8'), settings = readFileSync('src/Settings.tsx', 'utf8');
  assert.doesNotMatch(app + profiles, /ProfilesPanel/);
  assert.doesNotMatch(app, /openPanel\('profiles'\)|panel === 'profiles'|panel !== 'profiles'/);
  assert.match(app, /onManage=\{\(\) => openSettings\('profiles'\)\}/);
  assert.match(app, /openSettings\('general'\)/);
  assert.match(settings, /ProfilesSettings/);
});

function settingsInterface(react = {}) {
  return interfaceModule('src/Settings.tsx', { react, 'lucide-react': {}, './copy': interfaceModule('src/copy.ts'), './shared/api': require('../dist/src/shared/api.js'), './HorizonMark': {}, './Menu': {}, './Notebooks': {}, './Profiles': {}, './Switch': {} });
}

test('settings failures use the complete named code and never expose command messages', () => {
  const { settingsError } = settingsInterface(), { copy } = interfaceModule('src/copy.ts');
  for (const key of Object.keys(copy).filter(key => /^[A-Z][A-Z_]+$/.test(key))) for (const language of ['en', 'es']) {
    assert.equal(settingsError(new Error(`Error invoking remote method: ${key}`), language), copy[key][language]);
  }
  assert.equal(settingsError(new Error('an unrecognised internal detail'), 'en'), copy.browserError.en);
});

test('settings sites count each host once and preserve permissions from every origin', () => {
  const react = { useState: value => [value, () => {}], useRef: current => ({ current }) };
  const { groupSiteSettings, Settings } = settingsInterface(react);
  const permissions = { camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'ask' };
  const sites = [
    { host: 'example.com', origin: 'https://example.com', blocking: false, dark: true, permissions: { ...permissions, location: 'allow' } },
    { host: 'example.com', origin: 'http://example.com:8080', blocking: false, dark: true, permissions: { ...permissions, location: 'block' } },
    { host: 'other.example', origin: 'https://other.example', blocking: null, dark: false, permissions },
  ];
  const groups = groupSiteSettings(sites);
  assert.deepEqual(groups.map(group => group.map(site => site.origin)), [['https://example.com', 'http://example.com:8080'], ['https://other.example']]);
  assert.deepEqual(groupSiteSettings([]), []);
  for (const language of ['en', 'es']) {
    const page = Settings({ state: { sites }, section: 'privacy/sites', language, onOpen() {} });
    const component = notebookNodes(page, node => node.type?.name === 'SitesSettings')[0];
    const rows = notebookNodes(component.type(component.props), node => node.type?.name === 'SettingsSite');
    assert.equal(rows.length, 2); assert.notEqual(rows[0].props.sites, rows[1].props.sites);
    const rendered = rows[0].type(rows[0].props), hint = notebookNodes(rendered, node => node.props.className === 'setting-hint')[0];
    assert.match(hint.props.children, /https:\/\/example\.com/); assert.match(hint.props.children, /http:\/\/example\.com:8080/);
  }
});

test('dark page copy includes the approved English and Rioplatense Spanish labels, hints and announcements', () => {
  const { copy, text } = interfaceModule('src/copy.ts');
  const expected = {
    darkPages: ['Dark pages', 'Páginas oscuras'], off: ['Off', 'No'], on: ['On', 'Sí'],
    darkStrength: ['Strength', 'Intensidad'], soft: ['Soft', 'Suave'], standard: ['Standard', 'Normal'], deep: ['Deep', 'Fuerte'],
    darkTone: ['Tone', 'Tono'], neutral: ['Neutral', 'Neutro'], warm: ['Warm', 'Cálido'],
    darkModeOnSite: ['Dark mode on this site', 'Modo oscuro en este sitio'],
    darkPagesOff: ['Dark pages are off. Turn them on in the menu.', 'Las páginas oscuras están apagadas. Activalas en el menú.'],
    darkPagesSystemLight: ['Dark pages follow the system, which is light now.', 'Las páginas oscuras siguen al sistema, que ahora está en claro.'],
    darkModeEnabled: ['Dark mode on for {host}', 'Modo oscuro activado en {host}'],
    darkModeDisabled: ['Dark mode off for {host}', 'Modo oscuro desactivado en {host}'],
  };
  for (const [key, [en, es]] of Object.entries(expected)) {
    assert.deepEqual(copy[key], { en, es }, key);
    assert.equal(text(key, 'en'), en); assert.equal(text(key, 'es'), es);
  }
  assert.ok(copy.system.en); assert.ok(copy.system.es);
});

test('dark page menu rows are labelled radio groups with immediate commands and mode-dependent options', () => {
  const { compileFunction } = require('node:vm');
  const ts = require('typescript'), { text } = interfaceModule('src/copy.ts');
  const source = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let menu;
  const visit = node => {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(source) === 'id' && property.initializer?.text === 'browser-menu')) menu = node;
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(menu);
  const compiled = ts.transpileModule(`export function render(state, t, run) { return ${menu.getText(source)}; }`, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported = {}, jsx = (type, props) => ({ type, props });
  compileFunction(compiled, ['exports', 'require', 'Menu', 'Plus', 'History', 'Star', 'Download', 'Search', 'Switch', 'Settings2', 'menuByKeyboard', 'menuButtonRef', 'activeUrl', 'active', 'window'])(exported,
    name => { assert.equal(name, 'react/jsx-runtime'); return { jsx, jsxs: jsx, Fragment: 'fragment' }; },
    'menu', 'plus', 'history', 'star', 'download', 'search', 'switch', 'settings', { current: false }, { current: null }, '', undefined, { horizon: { initialTheme: 'system', initialContrast: 'standard' } });
  for (const language of ['en', 'es']) for (const mode of [undefined, 'off', 'on', 'system']) for (const strength of ['soft', 'standard', 'deep']) for (const tone of ['neutral', 'warm']) {
    const commands = [], state = mode ? { darkPages: { mode, strength, tone } } : null;
    const rendered = exported.render(state, key => text(key, language), command => commands.push(command));
    const rows = interfaceChildren(rendered).flatMap(child => child.type === 'fragment' ? interfaceChildren(child) : [child]).filter(child => child.props.className === 'menu-theme');
    const visible = mode && mode !== 'off';
    assert.deepEqual(rows.map(row => row.props['aria-label']), (visible ? ['theme', 'darkPages', 'darkStrength', 'darkTone'] : ['theme', 'darkPages']).map(key => text(key, language)));
    for (const [index, type, values, selected] of [[1, 'dark-pages', ['off', 'on', 'system'], mode ?? 'off'], ...(visible ? [[2, 'dark-strength', ['soft', 'standard', 'deep'], strength], [3, 'dark-tone', ['neutral', 'warm'], tone]] : [])]) {
      const row = rows[index]; assert.equal(row.props.role, 'group');
      const [label, group] = interfaceChildren(row);
      assert.equal(label.props.children, row.props['aria-label']); assert.equal(group.props.className, 'segmented');
      const buttons = interfaceChildren(group); assert.equal(buttons.length, values.length);
      buttons.forEach((button, position) => {
        assert.equal(button.type, 'button'); assert.equal(button.props.type, 'button'); assert.equal(button.props.role, 'menuitemradio');
        assert.equal(button.props.tabIndex, -1); assert.equal(button.props['aria-checked'], values[position] === selected);
        assert.equal(button.props.children, text(values[position], language));
        button.props.onClick(); assert.deepEqual(commands.at(-1), { type, value: values[position] });
      });
    }
  }
});

test('site dark switches preserve row order, accessible hints and focus while refusing repeated pending commands', async () => {
  const copy = interfaceModule('src/copy.ts'), switchModule = interfaceModule('src/Switch.tsx');
  const react = { useId: () => 'site', useRef: current => ({ current }), useState: current => [current, () => {}], useEffect() {}, useLayoutEffect() {} };
  const { ShieldPopover } = interfaceModule('src/SiteControls.tsx', { react, './copy': copy, './Switch': switchModule, './Menu': { Menu: 'menu' },
    'lucide-react': { Bell: 'bell', Camera: 'camera', Check: 'check', Map: 'map', Mic: 'mic' }, './shared/api': { SITE_PERMISSIONS: ['camera', 'microphone', 'location', 'notifications'] } });
  for (const language of ['en', 'es']) for (const [mode, active] of [['off', false], ['system', false], ['system', true], ['on', true]]) for (const dark of [false, true]) {
    const commands = []; let finish;
    const popover = ShieldPopover({ site: { host: 'example.com', blocking: true, dark, permissions: { camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'ask' } },
      counts: { ads: 0, trackers: 0, cookies: 0 }, ready: true, blockAds: true, darkPages: { mode, active, strength: 'standard', tone: 'neutral' }, language, initial: 'E', opener: { current: null }, onDismiss() {}, onTabOut() {},
      run: command => { commands.push(command); return new Promise(done => { finish = done; }); } });
    const rows = interfaceChildren(popover), blockingIndex = rows.findIndex(row => row.props.className === 'site-blocking-row'), darkRow = rows[blockingIndex + 1];
    assert.equal(darkRow.props.className, active ? 'site-dark-row' : 'site-dark-row with-hint'); assert.equal(rows[blockingIndex + 2].type, 'hr');
    const [description, control] = interfaceChildren(darkRow), [label, hint] = interfaceChildren(description);
    assert.equal(description.props.className, 'site-blocking-copy'); assert.equal(label.props.children, copy.text('darkModeOnSite', language));
    const button = switchModule.Switch(control.props);
    assert.equal(button.type, 'button'); assert.equal(button.props.role, 'switch'); assert.equal(button.props['aria-checked'], active && dark);
    assert.equal(button.props.disabled, !active); assert.equal(button.props['aria-labelledby'], label.props.id);
    if (active) { assert.equal(hint, undefined); assert.equal(button.props['aria-describedby'], undefined); }
    else { assert.equal(button.props['aria-describedby'], hint.props.id); assert.equal(hint.props.children, copy.text(mode === 'off' ? 'darkPagesOff' : 'darkPagesSystemLight', language)); }
    const blockingControl = interfaceChildren(rows[blockingIndex])[1];
    if (active) {
      button.props.onClick(); button.props.onClick(); blockingControl.props.onChange(false);
      assert.deepEqual(commands, [{ type: 'set-site-dark', enabled: !dark }]); assert.equal(button.props.disabled, false);
      finish(true); await Promise.resolve();
      blockingControl.props.onChange(false); button.props.onClick();
      assert.deepEqual(commands.at(-1), { type: 'set-blocking', enabled: false }); assert.equal(commands.length, 2);
      finish(true); await Promise.resolve(); button.props.onClick(); assert.equal(commands.length, 3); finish(true); await Promise.resolve();
    }
    assert.ok(rows.slice(blockingIndex + 3).filter(row => row.type === 'button').every(row => row.props.className === 'site-permission-row'));
  }
  const app = readFileSync('src/App.tsx', 'utf8');
  assert.match(app, /if \(darkChanged && next\.siteSettings\) announce\(text\(next\.siteSettings\.dark \? 'darkModeEnabled' : 'darkModeDisabled', language\)\.replace\('\{host\}', next\.siteSettings\.host\)\)/);
  assert.match(app, /aria-live="polite"[^>]*>\{announcement\}/);
  assert.match(readFileSync('src/SiteControls.tsx', 'utf8'), /button:not\(:disabled\):not\(\[tabindex="-1"\]\)/);
});

test('site dark hints wrap without truncation and menu rows retain internal scrolling at minimum window zoom', () => {
  const css = readFileSync('src/styles.css', 'utf8'), tokens = readFileSync('src/tokens.css', 'utf8');
  assert.match(tokens, /--height-site-dark:\s*var\(--size-40\)/); assert.match(tokens, /--size-40:\s*2\.5rem/);
  assert.match(tokens, /--height-site-blocking:\s*var\(--size-52\)/); assert.match(tokens, /--size-52:\s*3\.25rem/);
  assert.match(tokens, /--gap-site-popover:\s*var\(--space-12\)/); assert.match(tokens, /--space-12:\s*0\.75rem/);
  assert.match(css, /\.site-dark-row\s*\{[^}]*gap:\s*var\(--gap-site-popover\);[^}]*min-height:\s*var\(--height-site-dark\)/);
  assert.match(css, /\.site-dark-row\.with-hint\s*\{[^}]*min-height:\s*var\(--height-site-blocking\)/);
  const hintRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => /site-dark-row|site-blocking-copy/.test(match[1]));
  assert.ok(hintRules.length >= 4);
  for (const [, selector, declarations] of hintRules) {
    assert.doesNotMatch(declarations, /text-overflow:\s*ellipsis|white-space:\s*nowrap|line-clamp:|overflow(?:-y)?:\s*(?:hidden|clip)|(?:^|;)\s*(?:max-)?height:/, selector);
  }
  assert.match(css, /\.site-blocking-copy small\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.browser-menu\s*\{[^}]*max-height:\s*calc\(100vh - var\(--height-tabs\) - var\(--height-toolbar\)\);[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.menu-theme\s*\{[^}]*flex-shrink:\s*0/);
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
  mkdirSync(testTemporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(testTemporaryRoot, `${prefix}-`));
  t.after(() => {
    assert.ok(directory.startsWith(testTemporaryRoot + require('node:path').sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function sampleStore(directory) {
  return {
    version: 4, clearHistoryOnClose: false, clearCacheOnClose: false,
    siteSettings: { blocking: [], dark: [], permissions: [] },
    history: [{ url: 'https://example.com/', title: 'Example', lastVisit: 1, visitCount: 2 }],
    bookmarks: [{ url: 'https://example.com/', title: 'Example', createdAt: 1 }],
    downloads: [{ id: 'download-1', url: 'https://example.com/file', filename: 'file.txt', path: join(directory, 'file.txt'), received: 3, total: 3, status: 'completed', startedAt: 1 }],
  };
}

test('store schema rejects unsafe URLs, shapes, statuses, paths, and unbounded fields', (t) => {
  const directory = temporaryDirectory(t, 'schema');
  assert.equal(validateStore(sampleStore(directory)), true);
  assert.equal(validateStore({ version: 4, clearHistoryOnClose: false, clearCacheOnClose: false, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], dark: [], permissions: [] } }), true);
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
  assert.deepEqual(readStore(path), { version: 4, clearHistoryOnClose: false, clearCacheOnClose: false, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], dark: [], permissions: [] } });
  assert.ok(existsSync(path));
  const store = sampleStore(directory);
  writeStore(path, store);
  assert.deepEqual(readStore(path), store);
  assert.equal(readdirSync(join(directory, 'profile')).some(name => name.endsWith('.tmp')), false);
  assert.throws(() => writeStore(path, { ...store, version: 5 }));
  assert.deepEqual(readStore(path), store);
  for (const corrupt of ['{broken json', JSON.stringify({ ...store, version: 5 })]) {
    writeFileSync(path, corrupt);
    assert.deepEqual(readStore(path), { version: 4, clearHistoryOnClose: false, clearCacheOnClose: false, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], dark: [], permissions: [] } });
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

async function navigationVisibilityTests(t, view, state) {
  const contents = view.webContents, url = state().tabs.find(tab => tab.id === state().activeId).url;
  const start = target => contents.emit('did-start-navigation', {}, target, false, true);
  const abort = target => contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', target, true);
  const settle = () => new Promise(done => setImmediate(done));
  contents.emit('did-stop-loading');
  await t.test('main-frame ERR_ABORTED restores the current document without an error', () => {
    start(url + '?download'); assert.equal(view.visible, false);
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url + '?download', false);
    assert.equal(view.visible, false, 'A subframe cannot reveal a pending main frame');
    contents.emit('did-redirect-navigation', {}, url + '?attachment', false, true);
    abort(url + '?attachment');
    assert.equal(view.visible, true); assert.equal(state().tabs.find(tab => tab.id === state().activeId).error, null);
    assert.equal(state().tabs.find(tab => tab.id === state().activeId).url, url);
    contents.emit('did-stop-loading');
  });
  await t.test('loading stopped without a main-frame commit restores the current document', () => {
    start(url + '?download'); assert.equal(view.visible, false);
    contents.emit('did-stop-loading'); assert.equal(view.visible, true);
    assert.equal(state().tabs.find(tab => tab.id === state().activeId).error, null);
  });
  await t.test('an older abort keeps the newer navigation hidden until its cosmetic CSS resolves', async subtest => {
    let finishCSS;
    subtest.mock.method(contents, 'insertCSS', (_css, options) => {
      assert.equal(options.cssOrigin, 'user'); return new Promise(done => { finishCSS = done; });
    });
    subtest.mock.method(contents, 'isLoading', () => contents.loading);
    for (const first of [url + '?older', url]) {
      start(first); start(url); contents.loading = true;
      abort(first); assert.equal(view.visible, false);
      contents.emit('did-stop-loading'); assert.equal(view.visible, false, 'A stale stop cannot reveal a still-loading navigation');
      contents.emit('did-navigate', {}, url); assert.equal(view.visible, false);
      contents.loading = false; contents.emit('did-stop-loading'); assert.equal(view.visible, false);
      finishCSS('cosmetic-key'); await settle(); assert.equal(view.visible, true);
    }
  });
  await t.test('a committed main frame stays hidden until cosmetic CSS insertion resolves', async subtest => {
    let finishCSS;
    subtest.mock.method(contents, 'insertCSS', () => new Promise(done => { finishCSS = done; }));
    start(url); assert.equal(view.visible, false);
    contents.emit('did-navigate', {}, url); contents.emit('did-stop-loading');
    abort(url); await settle(); assert.equal(view.visible, false);
    finishCSS('cosmetic-key'); await settle(); assert.equal(view.visible, true);
  });
}

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
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [], getActiveIndex: () => -1, restore: async () => {} };
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
    removeInsertedCSS() { return Promise.resolve(); }
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
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
    app: Object.assign(new EventEmitter(), { commandLine: { appendSwitch() {}, removeSwitch() {} }, getLocale: () => 'en', getPath: () => directory }),
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
  await navigationVisibilityTests(t, view, state);
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
  assert.deepEqual(state().store, { version: 4, clearHistoryOnClose: false, clearCacheOnClose: false, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], dark: [], permissions: [] } });
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
  for (const theme of ['system', 'amber', 'daylight']) assert.equal(validateSettings({ version: 4, theme, contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [] }), true);
  for (const value of [null, [], {}, { version: 2, theme: 'system' }, { version: 1, theme: 'dark' }, { version: 1, theme: 'amber', extra: true }, { version: 1, theme: 'amber' }, { version: 1, theme: 'amber', contrast: 'invalid' }, { version: 1, theme: 'amber', contrast: null }, { version: 1, theme: 'amber', contrast: 'high', extra: true }]) {
    assert.equal(validateSettings(value), false);
    assert.throws(() => writeSettings(path, value));
  }
  for (const corrupt of ['{broken', JSON.stringify({ version: 2, theme: 'amber' }), ' '.repeat(4097)]) {
    writeFileSync(path, corrupt);
    assert.deepEqual(readSettings(path), { version: 4, theme: 'system', contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [] });
    assert.ok(readdirSync(directory).filter(name => name.startsWith('settings.json.corrupt-')).some(name => readFileSync(join(directory, name), 'utf8') === corrupt));
  }
  const existing = createSettings(path, () => {});
  existing.setTheme('amber', true);
  assert.equal(existing.theme, 'system');
});

test('dark page flips replace views in every profile without closing tabs and site choices update only matching profile hosts', async t => {
  const { EventEmitter } = require('node:events'), { compileFunction } = require('node:vm');
  const directory = temporaryDirectory(t, 'dark-browser'), views = [], handlers = new Map(), sessions = new Map(), switchCalls = [], order = [];
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const app = Object.assign(new EventEmitter(), { getLocale: () => 'en', getPath: () => directory, commandLine: {
    appendSwitch(...args) { switchCalls.push(['append', ...args]); order.push('switch-on'); },
    removeSwitch(...args) { switchCalls.push(['remove', ...args]); order.push('switch-off'); },
  } });
  let nextId = 0;
  let mockCosmetics = false;
  class Contents extends EventEmitter {
    constructor(targetSession) {
      super(); this.id = ++nextId; this.session = targetSession; this.mainFrame = { url: 'horizon://app/' }; this.zoom = 1;
      this.sent = []; this.entries = []; this.index = -1; this.styles = new Map(); this.insertions = []; this.removals = [];
      this.navigationHistory = { getAllEntries: () => structuredClone(this.entries), getActiveIndex: () => this.index,
        canGoBack: () => this.index > 0, canGoForward: () => this.index >= 0 && this.index < this.entries.length - 1,
        restore: async value => { this.restored = structuredClone(value); this.entries = value.entries; this.index = value.index; this.url = value.entries[value.index].url; },
      };
    }
    isDestroyed() { return !!this.destroyed; }
    send(...args) { this.sent.push(args); }
    focus() {}
    setZoomMode() {}
    setZoomFactor(value) { this.zoom = value; }
    getZoomFactor() { return this.zoom; }
    setWindowOpenHandler(value) { this.popup = value; }
    loadURL(url) { this.url = url; this.loads = (this.loads || 0) + 1; return Promise.resolve(); }
    getTitle() { return ''; }
    isLoading() { return false; }
    close() { this.destroyed = true; this.emit('destroyed'); }
    findInPage() { return 7; }
    stopFindInPage(value) { this.stoppedFind = value; }
    insertCSS(css, options) {
      assert.equal(options, undefined, 'Dark CSS uses the removable default author origin');
      const key = `css-${this.id}-${this.insertions.length}`; this.insertions.push({ css, options, key });
      if (this.rejectCSS) return Promise.reject(new Error('CSS unavailable'));
      const install = () => { this.styles.set(key, css); assert.equal(this.styles.size, 1, 'Dark CSS never accumulates'); return key; };
      return this.deferCSS ? new Promise(done => { this.finishCSS = () => done(install()); }) : Promise.resolve(install());
    }
    removeInsertedCSS(key) { assert.ok(this.styles.has(key), 'Dark CSS is removed by its insertion key'); this.removals.push(key); this.styles.delete(key); return Promise.resolve(); }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(sessions.get(options.webPreferences.partition)); views.push(this); order.push('view'); }
    setVisible(value) { this.visible = value; }
    setBounds(value) { this.bounds = value; }
    getBounds() { return this.bounds; }
  }
  const electron = { app, nativeTheme, WebContentsView: View, safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } },
    session: { fromPartition(partition) {
      if (!sessions.has(partition)) {
        const target = new EventEmitter(); target.setPermissionRequestHandler = fn => { target.request = fn; };
        target.setPermissionCheckHandler = () => {}; target.setDevicePermissionHandler = () => {};
        target.webRequest = Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred'].map(name => [name, () => {}]));
        sessions.set(partition, target);
      }
      return sessions.get(partition);
    } },
  };
  const filename = resolve('dist/electron/browser.js'), localRequire = require('node:module').createRequire(filename), exported = {};
  compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', '__dirname'])(exported, name => name === 'electron' ? electron : name === './blocking' ? {
    createBlockingEngine: () => ({ ready: true, start: async () => {}, stop() {}, cosmeticCSS: () => mockCosmetics ? '.advert {display:none!important;}' : '', match: () => undefined }),
  } : localRequire(name), require('node:path').dirname(filename));
  const window = Object.assign(new EventEmitter(), { webContents: new Contents(), isDestroyed: () => false, isFocused: () => true,
    getContentBounds: () => ({ width: 800, height: 600 }), setTitle() {}, setFullScreen(value) { this.fullscreen = value; }, contentView: { addChildView() {}, removeChildView() {} },
  });
  const settings = createSettings(join(directory, 'settings.json'), () => {});
  exported.createBrowser(window, directory, join(directory, 'downloads'), settings);
  t.after(() => window.emit('closed'));
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }, state = () => handlers.get('horizon:state')(event);
  const command = value => handlers.get('horizon:command')(event, value), settle = () => new Promise(done => setImmediate(done));
  const commit = (view, url = view.webContents.url) => { view.webContents.mainFrame.url = url; view.webContents.emit('did-navigate', {}, url); };
  handlers.get('horizon:content-area')(event, { top: 96, hidden: false });
  assert.deepEqual(state().darkPages, { mode: 'off', strength: 'standard', tone: 'neutral', active: false });
  assert.throws(() => command({ type: 'set-site-dark', enabled: false }), /SITE_UNAVAILABLE/);
  command({ type: 'navigate', input: 'https://same.test/first' }); const personal = state().activeProfileId, first = views.at(-1); commit(first);
  mockCosmetics = true;
  await navigationVisibilityTests(t, first, state);
  mockCosmetics = false;
  const firstId = state().activeId;
  first.webContents.entries = [{ url: 'https://same.test/back', title: 'Back' }, { url: 'https://same.test/first', title: 'Current' }, { url: 'https://same.test/forward', title: 'Forward' }]; first.webContents.index = 1;
  command({ type: 'zoom', delta: 1 });
  command({ type: 'new-tab', input: 'http://same.test/second', background: true }); const second = views.at(-1); commit(second);
  command({ type: 'new-tab', input: 'https://other.test/', background: true }); const other = views.at(-1); commit(other);
  command({ type: 'new-tab', background: true }); const blankId = state().tabs.at(-1).id;
  const personalTabs = state().tabs.map(tab => tab.id), work = state().profiles.find(profile => profile.id !== personal);
  command({ type: 'switch-profile', id: work.id }); command({ type: 'navigate', input: 'https://same.test/work' }); const workView = views.at(-1); commit(workView);
  workView.webContents.entries = [{ url: 'https://same.test/previous-work', title: 'Previous' }, { url: 'https://same.test/work', title: 'Work' }]; workView.webContents.index = 1;
  workView.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); assert.equal(state().tabs[0].error, 'RENDERER_GONE');
  const workId = state().activeId; command({ type: 'switch-profile', id: personal });
  command({ type: 'find', text: 'dark', forward: true, next: false }); first.webContents.emit('found-in-page', {}, { requestId: 7, activeMatchOrdinal: 1, matches: 2 });
  first.webContents.emit('enter-html-full-screen'); assert.equal(window.fullscreen, true);
  sessions.get('persist:web').request(first.webContents, 'geolocation', allowed => { window.permissionResult = allowed; }, {});
  const prompt = state().permissionPrompt; assert.ok(prompt);
  const beforeFlip = views.length, oldViews = [first, second, other, workView]; order.length = 0;
  command({ type: 'dark-pages', value: 'on' });
  assert.equal(order[0], 'switch-on'); assert.equal(views.length, beforeFlip + oldViews.length);
  assert.deepEqual(switchCalls, [['append', 'blink-settings', 'forceDarkModeEnabled=true']]);
  assert.deepEqual(state().tabs.map(tab => tab.id), personalTabs); assert.equal(state().activeId, firstId);
  assert.equal(state().tabs.find(tab => tab.id === blankId).url, ''); assert.equal(window.fullscreen, false);
  assert.equal(first.webContents.stoppedFind, 'clearSelection'); assert.deepEqual(state().tabs[0].find, { active: 0, total: 0 });
  assert.equal(state().permissionPrompt, null); assert.equal(window.permissionResult, false);
  assert.throws(() => command({ type: 'answer-permission', id: prompt.id, answer: 'allow' }), /STALE/);
  const fresh = views.slice(beforeFlip), [newFirst, newSecond, newOther, newWork] = fresh;
  assert.deepEqual(newFirst.webContents.restored, { entries: first.webContents.entries, index: 1 }); assert.equal(newFirst.webContents.zoom, 1.1);
  assert.equal(newFirst.visible, true); assert.equal(newSecond.visible, false); assert.equal(newWork.visible, false);
  for (const [index, old] of oldViews.entries()) {
    assert.equal(old.webContents.destroyed, true); assert.equal(fresh[index].options.webPreferences.partition, old.options.webPreferences.partition);
    old.webContents.emit('destroyed'); old.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    old.webContents.emit('did-navigate', {}, 'https://stale.test/'); old.webContents.emit('page-title-updated', {}, 'Stale');
  }
  assert.deepEqual(state().tabs.map(tab => tab.id), personalTabs); assert.equal(state().tabs[0].url, 'https://same.test/first'); assert.equal(state().tabs[0].error, null);
  assert.equal(newWork.webContents.url, 'https://same.test/work');
  assert.deepEqual(newWork.webContents.restored, { entries: workView.webContents.entries, index: 1 }, 'Restoring the crashed renderer history loads its active entry normally');
  fresh.forEach(view => commit(view)); await settle();
  for (const view of fresh) assert.deepEqual([...view.webContents.styles.values()], [MEDIAWIKI_DARK_CSS]);
  command({ type: 'dark-strength', value: 'soft' }); command({ type: 'dark-tone', value: 'warm' }); await settle();
  assert.equal(views.length, beforeFlip + oldViews.length); assert.equal(switchCalls.length, 1);
  const filtered = `:root { filter: brightness(1.15) contrast(0.9) sepia(0.12) !important; }\n${MEDIAWIKI_DARK_CSS}`;
  for (const view of fresh) { assert.deepEqual([...view.webContents.styles.values()], [filtered]); assert.equal(view.webContents.insertions.at(-1).options, undefined); }
  const insertionCounts = fresh.map(view => view.webContents.insertions.length);
  command({ type: 'set-site-dark', enabled: false }); await settle();
  assert.equal(state().siteSettings.dark, false);
  for (const view of [newFirst, newSecond]) assert.deepEqual([...view.webContents.styles.values()], [':root { color-scheme: only light !important; }']);
  assert.equal(newOther.webContents.insertions.length, insertionCounts[2]); assert.equal(newWork.webContents.insertions.length, insertionCounts[3]);
  assert.deepEqual([...newWork.webContents.styles.values()], [filtered]);
  command({ type: 'set-site-dark', enabled: true }); await settle();
  assert.deepEqual([...newFirst.webContents.styles.values()], [filtered]); assert.equal(state().store.siteSettings.dark.length, 1);
  command({ type: 'dark-strength', value: 'standard' }); command({ type: 'dark-tone', value: 'neutral' }); await settle();
  for (const view of fresh) {
    assert.deepEqual([...view.webContents.styles.values()], [MEDIAWIKI_DARK_CSS]);
    assert.deepEqual(view.webContents.removals, view.webContents.insertions.slice(0, -1).map(insertion => insertion.key), 'Every previous dark stylesheet is removed on subsequent strength, tone or site changes');
  }
  newFirst.webContents.deferCSS = true;
  command({ type: 'dark-tone', value: 'warm' }); await settle(); assert.equal(newFirst.visible, true, 'Pending dark CSS does not hide the page');
  command({ type: 'dark-tone', value: 'neutral' }); newFirst.webContents.deferCSS = false; newFirst.webContents.finishCSS(); await settle();
  assert.deepEqual([...newFirst.webContents.styles.values()], [MEDIAWIKI_DARK_CSS], 'A late insertion is replaced by the newest choice');
  assert.deepEqual(newFirst.webContents.removals, newFirst.webContents.insertions.slice(0, -1).map(insertion => insertion.key));
  newFirst.webContents.rejectCSS = true; command({ type: 'dark-strength', value: 'deep' }); await settle();
  assert.equal(newFirst.visible, true); assert.equal(state().tabs[0].error, null); newFirst.webContents.rejectCSS = false;
  command({ type: 'dark-pages', value: 'system' }); assert.equal(views.length, beforeFlip + oldViews.length * 2); assert.equal(state().darkPages.active, false);
  assert.deepEqual(switchCalls.at(-1), ['remove', 'blink-settings']);
  const afterOff = views.length; nativeTheme.emit('updated'); assert.equal(views.length, afterOff);
  nativeTheme.shouldUseDarkColors = true; nativeTheme.emit('updated'); assert.equal(views.length, afterOff + oldViews.length); assert.equal(state().darkPages.active, true);
  nativeTheme.emit('updated'); assert.equal(views.length, afterOff + oldViews.length);
  command({ type: 'dark-pages', value: 'on' }); const finalCount = views.length;
  nativeTheme.shouldUseDarkColors = false; nativeTheme.emit('updated'); assert.equal(views.length, finalCount); assert.equal(state().darkPages.active, true);
  command({ type: 'switch-profile', id: work.id }); assert.equal(state().activeId, workId); assert.equal(state().tabs.length, 1); assert.equal(state().tabs[0].error, null); assert.equal(state().siteSettings.dark, true);
  window.emit('closed'); assert.equal(nativeTheme.listenerCount('updated'), 0); assert.equal(handlers.size, 0);
});

test('dark page settings validate exact values, migrate version 1 and retain valid data when migration cannot be saved', t => {
  const directory = temporaryDirectory(t, 'dark-settings'), path = join(directory, 'settings.json');
  const defaults = { version: 4, theme: 'system', contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [] };
  assert.deepEqual(readSettings(path), defaults);
  for (const darkPages of ['off', 'on', 'system']) for (const darkStrength of ['soft', 'standard', 'deep']) for (const darkTone of ['neutral', 'warm']) {
    const valid = { ...defaults, darkPages, darkStrength, darkTone };
    assert.equal(validateSettings(valid), true); writeSettings(path, valid); assert.deepEqual(readSettings(path), valid);
  }
  for (const key of Object.keys(defaults)) {
    const missing = { ...defaults }; delete missing[key]; assert.equal(validateSettings(missing), false);
  }
  for (const key of ['darkPages', 'darkStrength', 'darkTone']) for (const value of [null, true, 1, [], {}, 'invalid', { toString: () => defaults[key] }]) {
    const invalid = { ...defaults, [key]: value };
    assert.equal(validateSettings(invalid), false); assert.throws(() => writeSettings(path, invalid));
  }
  const settings = createSettings(path, () => {});
  for (const [setter, key, value] of [['setDarkPages', 'darkPages', 'on'], ['setDarkStrength', 'darkStrength', 'deep'], ['setDarkTone', 'darkTone', 'warm']]) {
    settings[setter](value); assert.equal(settings[key], value); assert.equal(readSettings(path)[key], value);
    for (const invalid of [null, true, 1, {}, 'invalid']) assert.throws(() => settings[setter](invalid));
    assert.equal(settings[key], value);
  }
  for (const contrast of ['standard', 'high']) for (const theme of ['system', 'amber', 'daylight']) {
    const legacy = { version: 1, theme, contrast }, migrated = { ...defaults, theme, contrast };
    writeFileSync(path, JSON.stringify(legacy)); assert.deepEqual(readSettings(path), migrated);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), migrated);
  }
  const { compileFunction } = require('node:vm'), filename = resolve('dist/electron/settings.js'), localRequire = require('node:module').createRequire(filename), exported = {};
  writeFileSync(path, JSON.stringify({ version: 1, theme: 'daylight', contrast: 'high' }));
  const original = readFileSync(path, 'utf8');
  compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require'])(exported, name => name === 'node:fs' ? { ...localRequire(name), writeFileSync() { throw new Error('Read-only settings'); } } : localRequire(name));
  assert.deepEqual(exported.readSettings(path), { ...defaults, theme: 'daylight', contrast: 'high' });
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(readdirSync(directory).some(name => name.includes('.corrupt-') || name.endsWith('.tmp')), false);
  for (const corrupt of [{ version: 1, theme: 'amber', contrast: 'invalid' }, { version: 1, theme: 'amber', extra: true }, { ...defaults, darkTone: 'blue' }]) {
    const bytes = JSON.stringify(corrupt); writeFileSync(path, bytes); assert.deepEqual(readSettings(path), defaults);
    assert.ok(readdirSync(directory).some(name => name.startsWith('settings.json.corrupt-') && readFileSync(join(directory, name), 'utf8') === bytes));
  }
});

test('dark page effective state, tunable filter table and CSS cover every mode, site, strength and tone', () => {
  for (const systemDark of [false, true]) {
    assert.equal(darkPagesActive('off', systemDark), false); assert.equal(darkPagesActive('on', systemDark), true);
    assert.equal(darkPagesActive('system', systemDark), systemDark);
  }
  assert.deepEqual(DARK_FILTERS, { strength: { soft: 'brightness(1.15) contrast(0.9)', standard: '', deep: 'brightness(0.85) contrast(1.05)' }, tone: { neutral: '', warm: 'sepia(0.12)' } });
  assert.equal(MEDIAWIKI_DARK_CSS, '.skin-invert, .mw-invert { color-scheme: only light !important; filter: invert(1) hue-rotate(180deg) !important; }\nimg.mw-file-element { color-scheme: only light !important; }');
  for (const active of [false, true]) for (const enabled of [false, true]) for (const strength of ['soft', 'standard', 'deep']) for (const tone of ['neutral', 'warm']) {
    const filter = [DARK_FILTERS.strength[strength], DARK_FILTERS.tone[tone]].filter(Boolean).join(' ');
    const expected = !active ? '' : !enabled ? ':root { color-scheme: only light !important; }' : filter ? `:root { filter: ${filter} !important; }\n${MEDIAWIKI_DARK_CSS}` : MEDIAWIKI_DARK_CSS;
    assert.equal(darkPagesCSS(active, enabled, strength, tone), expected, `${active}/${enabled}/${strength}/${tone}`);
  }
  const calls = [], commandLine = { appendSwitch(...args) { calls.push(['append', ...args]); }, removeSwitch(...args) { calls.push(['remove', ...args]); } };
  setDarkPagesSwitch(commandLine, true); setDarkPagesSwitch(commandLine, false);
  assert.deepEqual(calls, [['append', 'blink-settings', 'forceDarkModeEnabled=true'], ['remove', 'blink-settings']]);
});

test('chrome opts light palettes out of forced dark before CSS loads and preserves the system dark scheme', () => {
  const tokens = readFileSync('src/tokens.css', 'utf8'), html = readFileSync('index.html', 'utf8');
  assert.match(html, /<meta name="color-scheme" content="only light"\s*\/>/);
  assert.match(tokens, /:root\[data-theme="daylight"\]\s*\{\s*color-scheme:\s*only light;/);
  assert.match(tokens, /:root\[data-theme="amber"\]\s*\{\s*color-scheme:\s*dark;/);
  assert.match(tokens, /:root\s*\{\s*color-scheme:\s*only light;/);
  assert.match(tokens, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="daylight"\]\):not\(\[data-theme="amber"\]\)\s*\{\s*color-scheme:\s*dark;/);
  for (const match of tokens.matchAll(/[\s{]color-scheme:\s*([^;]+);/g)) assert.ok(['only light', 'dark'].includes(match[1]), match[1]);
});

test('dark page commands accept exact keys and reject missing or invalid values', () => {
  for (const [type, values] of [['dark-pages', ['off', 'on', 'system']], ['dark-strength', ['soft', 'standard', 'deep']], ['dark-tone', ['neutral', 'warm']]]) {
    for (const value of values) {
      const command = { type, value }; assert.deepEqual(validateCommand(command), command);
      assert.throws(() => validateCommand({ ...command, extra: true }));
    }
    for (const value of [undefined, null, false, 1, '', {}, [], 'invalid', { toString: () => values[0] }]) assert.throws(() => validateCommand({ type, value }));
    assert.throws(() => validateCommand({ type }));
  }
  for (const enabled of [true, false]) assert.deepEqual(validateCommand({ type: 'set-site-dark', enabled }), { type: 'set-site-dark', enabled });
  for (const enabled of [undefined, null, 1, 'false', {}, []]) assert.throws(() => validateCommand({ type: 'set-site-dark', enabled }));
  assert.throws(() => validateCommand({ type: 'set-site-dark' })); assert.throws(() => validateCommand({ type: 'set-site-dark', enabled: false, host: 'example.com' }));
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
    assert.deepEqual(Object.keys(exposed).sort(), ['capture', 'command', 'getCaptureImage', 'getFavicon', 'getLanguage', 'getNotebook', 'getState', 'initialContrast', 'initialTheme', 'onContextMenu', 'onShortcut', 'onState', 'setContentArea', 'themeMigration', 'windowAction']);
    await exposed.getFavicon('tab', 'a'.repeat(32));
    assert.deepEqual(invocations, [['horizon:favicon', 'tab', 'a'.repeat(32)]]);
    await exposed.getNotebook('notebook'); await exposed.getCaptureImage('notebook', 'item');
    assert.deepEqual(invocations.slice(1), [['horizon:notebook', 'notebook'], ['horizon:capture-image', 'notebook', 'item']]);
  }
});

test('contrast defaults follow the OS only on first run and legacy settings migrate atomically', t => {
  const directory = temporaryDirectory(t, 'contrast');
  const first = join(directory, 'first.json');
  const settings = createSettings(first, () => {}, true);
  assert.deepEqual(readSettings(first), { version: 4, theme: 'system', contrast: 'high', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [] });
  settings.setTheme('amber', true);
  assert.equal(settings.contrast, 'high');
  settings.setContrast('standard');
  assert.equal(settings.theme, 'amber');
  assert.deepEqual(readSettings(first, true), { version: 4, theme: 'amber', contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [] });
  assert.throws(() => settings.setContrast('invalid'));
  assert.equal(settings.contrast, 'standard');
  for (const theme of ['system', 'amber', 'daylight']) {
    const legacy = join(directory, theme + '.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, theme }));
    assert.deepEqual(readSettings(legacy, true), { version: 4, theme, contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [] });
    assert.deepEqual(JSON.parse(readFileSync(legacy, 'utf8')), { version: 4, theme, contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [] });
    assert.equal(createSettings(legacy, () => {}, true).migrationAllowed, false);
  }
  assert.equal(readdirSync(directory).some(name => name.includes('.corrupt-') || name.endsWith('.tmp')), false);
  const blocked = join(directory, 'blocked');
  writeFileSync(blocked, 'file');
  assert.deepEqual(readSettings(join(blocked, 'settings.json'), true), { version: 4, theme: 'system', contrast: 'high', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [] });
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
  for (const theme of ['system', 'amber', 'daylight']) for (const contrast of ['standard', 'high']) for (const dark of [false, true]) for (const mode of ['off', 'on', 'system']) {
    const windows = [];
    let painted;
    const settings = { theme, contrast, darkPages: mode, darkStrength: 'standard', darkTone: 'neutral', migrationAllowed: false };
    const nativeTheme = new EventEmitter();
    nativeTheme.shouldUseDarkColors = dark;
    nativeTheme.shouldUseHighContrastColors = true;
    const app = new EventEmitter();
    const switchCalls = [];
    app.commandLine = { appendSwitch(...args) { switchCalls.push(['append', ...args]); }, removeSwitch(...args) { switchCalls.push(['remove', ...args]); } };
    app.isPackaged = true;
    app.requestSingleInstanceLock = () => true;
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
          assert.deepEqual(switchCalls, mode === 'on' || mode === 'system' && dark ? [['append', 'blink-settings', 'forceDarkModeEnabled=true']] : [], 'The switch is configured before chrome creates a renderer');
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
      if (name === './settings') return { ...localRequire(name), createSettings(path, callback, high) { assert.equal(path, join(directory, 'settings.json')); assert.equal(high, true); changed = callback; return settings; } };
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
  assert.deepEqual(readStore(path, cipher, readStatus), { version: 4, clearHistoryOnClose: false, clearCacheOnClose: false, history: [], bookmarks: [], downloads: [], siteSettings: { blocking: [], dark: [], permissions: [] } });
  assert.deepEqual(readStatus, { readError: true, memoryOnly: false });
  assert.ok(readdirSync(join(directory, 'profile')).some(name => name.startsWith('browser-store.json.corrupt-') && readFileSync(join(directory, 'profile', name)).equals(tampered)));
  const invalid = Buffer.concat([Buffer.from('HORIZON-STORE-1\n'), cipher.encryptString(JSON.stringify({ ...store, version: 5 }))]);
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

test('site settings migrate strict version 1 and 2 stores to version 3 and validate bounded canonical origins and hosts', t => {
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
  const legacySample = { ...sample }; delete legacySample.clearHistoryOnClose; delete legacySample.clearCacheOnClose;
  const second = { ...legacySample, version: 2, siteSettings: { blocking: [{ host: 'example.com', enabled: false }], permissions: [{ origin: 'https://example.com', ...defaultPermissions(), camera: 'allow' }] } };
  const expected = { ...second, version: 4, clearHistoryOnClose: false, clearCacheOnClose: false, siteSettings: { ...second.siteSettings, dark: [] } };
  writeFileSync(path, JSON.stringify(second)); assert.deepEqual(readStore(path), expected);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), expected);
  writeFileSync(encryptedLegacy, Buffer.concat([Buffer.from('HORIZON-STORE-1\n'), cipher.encryptString(JSON.stringify(second))]));
  assert.deepEqual(readStore(encryptedLegacy, cipher), expected);
  const settings = sample.siteSettings;
  setBlocking(settings, 'example.com', false);
  assert.equal(siteSettings(settings, 'https://example.com/').dark, true);
  setSiteDark(settings, 'example.com', false);
  assert.equal(siteSettings(settings, 'https://example.com/').dark, false); assert.equal(siteSettings(settings, 'http://example.com/path').dark, false);
  assert.equal(siteSettings(settings, 'https://other.example/').dark, true);
  setPermission(settings, 'https://example.com', 'camera', 'allow');
  assert.equal(validateStore(sample), true);
  assert.equal(siteSettings(settings, 'http://example.com/').blocking, false);
  assert.equal(siteSettings(settings, 'http://example.com/').permissions.camera, 'ask');
  assert.equal(siteSettings(settings, 'https://example.com/').permissions.camera, 'allow');
  for (const host of ['', 'Example.com', 'user@example.com', 'example.com:443', 'example.com/path', 'example.com.', 'x'.repeat(254), '\0']) {
    const invalid = structuredClone(sample); invalid.siteSettings.blocking[0].host = host;
    assert.equal(validateStore(invalid), false, host);
    const invalidDark = structuredClone(sample); invalidDark.siteSettings.dark[0].host = host;
    assert.equal(validateStore(invalidDark), false, host); assert.throws(() => setSiteDark(settings, host, false), /SITE_UNAVAILABLE/);
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
    value => { delete value.siteSettings.dark; }, value => { value.siteSettings.dark = null; },
    value => { value.siteSettings.dark[0].enabled = 'false'; }, value => { value.siteSettings.dark[0].extra = true; },
    value => { value.siteSettings.dark.push(value.siteSettings.dark[0]); }, value => { value.siteSettings.dark = new Array(1); },
    value => { value.siteSettings.dark = new Array(SITE_SETTINGS_LIMIT + 1); },
  ]) { const invalid = structuredClone(sample); change(invalid); assert.equal(validateStore(invalid), false); }
  const bounded = { blocking: [], dark: Array.from({ length: SITE_SETTINGS_LIMIT }, (_, index) => ({ host: `host${index}.test`, enabled: false })), permissions: [] };
  assert.equal(validateStore({ ...sample, siteSettings: bounded }), true);
  setSiteDark(bounded, 'host0.test', true); assert.equal(bounded.dark.length, SITE_SETTINGS_LIMIT);
  assert.equal(siteSettings(bounded, 'https://host0.test/').dark, true);
  assert.throws(() => setSiteDark(bounded, 'overflow.test', false), /SITE_SETTINGS_LIMIT/);
  assert.equal(bounded.dark.length, SITE_SETTINGS_LIMIT);
  for (const invalid of [{ ...second, extra: true }, { ...second, siteSettings: { ...second.siteSettings, dark: [] } }, { ...second, siteSettings: { ...second.siteSettings, blocking: [{ host: 'Example.com', enabled: false }] } }]) {
    const bytes = JSON.stringify(invalid); writeFileSync(path, bytes); assert.equal(readStore(path).history.length, 0);
    assert.ok(readdirSync(directory).some(name => name.startsWith('store.json.corrupt-') && readFileSync(join(directory, name), 'utf8') === bytes));
  }
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
  const settings = { blocking: [], dark: [], permissions: [] }, results = [];
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
  mkdirSync(testTemporaryRoot, { recursive: true });
  const root = mkdtempSync(join(testTemporaryRoot, 'blocking-test-'));
  t.after(() => { assert.ok(root.startsWith(testTemporaryRoot + require('node:path').sep)); rmSync(root, { recursive: true, force: true }); });
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

test('missing engine retries after 1, 5 and 15 minutes then waits for the hourly check', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let downloads = 0;
  const engine = createBlockingEngine(blockingDirectory(t), undefined, { download: async () => { downloads++; throw new Error('offline'); } });
  t.after(() => engine.stop());
  await engine.start(); await engine.refresh();
  assert.equal(downloads, 15); assert.equal(engine.ready, false);
  for (const [delay, expected] of [[1, 30], [5, 45], [15, 60]]) {
    t.mock.timers.tick(delay * 60 * 1000 - 1); assert.equal(downloads, expected - 15);
    t.mock.timers.tick(1); assert.equal(downloads, expected);
    await engine.refresh(); assert.equal(downloads, expected);
  }
  t.mock.timers.tick(39 * 60 * 1000 - 1); assert.equal(downloads, 60);
  t.mock.timers.tick(1); assert.equal(downloads, 75);
  await engine.refresh(); assert.equal(downloads, 75);
});

test('successful retry makes the engine ready and cancels quick retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let downloads = 0, online = false, changed = 0;
  const engine = createBlockingEngine(blockingDirectory(t), () => changed++, { download: async url => { downloads++; if (!online) throw new Error('offline'); return filterSource(url); } });
  t.after(() => engine.stop());
  await engine.start(); await engine.refresh();
  online = true; t.mock.timers.tick(60 * 1000);
  assert.equal(downloads, 30); assert.equal(await engine.refresh(), true);
  assert.equal(engine.ready, true); assert.equal(changed, 1);
  assert.deepEqual(engine.match('https://ad.example/x', 'image', 'https://site.example/'), { kind: 'ads' });
  t.mock.timers.tick(60 * 60 * 1000); assert.equal(downloads, 30);
});

test('stopping a missing engine cancels its pending retry and hourly check', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let downloads = 0;
  const engine = createBlockingEngine(blockingDirectory(t), undefined, { download: async () => { downloads++; throw new Error('offline'); } });
  t.after(() => engine.stop());
  await engine.start(); await engine.refresh();
  engine.stop(); t.mock.timers.tick(2 * 60 * 60 * 1000);
  assert.equal(downloads, 15); assert.equal(await engine.refresh(), false); assert.equal(engine.ready, false);
});

test('stale refresh failure keeps the serialized last good engine without quick retries', async t => {
  const root = blockingDirectory(t), initial = Date.now();
  const first = createBlockingEngine(root, undefined, { now: () => initial, download: async url => filterSource(url) });
  assert.equal(await first.refresh(), true);
  first.stop();
  const kept = readFileSync(join(root, 'adblock', 'engines.bin'));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let attempted = 0;
  const stale = createBlockingEngine(root, undefined, { now: () => initial + 24 * 60 * 60 * 1000 + 1, download: async () => { attempted++; throw new Error('offline'); } });
  await stale.start();
  await stale.refresh();
  assert.ok(attempted > 0);
  assert.equal(stale.ready, true);
  assert.deepEqual(stale.match('https://ad.example/x', 'image', 'https://site.example/'), { kind: 'ads' });
  assert.deepEqual(readFileSync(join(root, 'adblock', 'engines.bin')), kept);
  const failed = attempted;
  t.mock.timers.tick(60 * 60 * 1000 - 1); assert.equal(attempted, failed);
  t.mock.timers.tick(1); assert.equal(attempted, failed + 15);
  await stale.refresh();
  stale.stop();
  const empty = createBlockingEngine(root, undefined, { download: async url => url.endsWith('resources.json') ? filterSource(url) : '' });
  assert.equal(await empty.refresh(), false);
  assert.deepEqual(readFileSync(join(root, 'adblock', 'engines.bin')), kept);
  empty.stop();
});

test('permission buttons use touch targets only for coarse pointers', () => {
  const css = readFileSync('src/styles.css', 'utf8');
  const coarse = css.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(coarse);
  assert.match(readFileSync('src/tokens.css', 'utf8'), /--target-touch:\s*var\(--size-44\)/);
  for (const selector of ['.site-popover button.site-permission-row', '.site-permission-actions .profile-action', '.site-permission-menu > button']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(escaped + '[^{}]*\\{[^}]*min-height:\\s*var\\(--target-touch\\)');
    assert.match(coarse[1], rule); assert.doesNotMatch(css.replace(coarse[0], ''), rule);
  }
  assert.doesNotMatch(coarse[1], /(?:^|,)\s*\.site-permission-row\s*[,\{]/m);
});

test('tab strip makes room for touch targets only for coarse pointers', () => {
  const css = readFileSync('src/styles.css', 'utf8');
  const tokens = readFileSync('src/tokens.css', 'utf8');
  const coarse = css.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(coarse);
  assert.match(tokens, /--height-tabs-touch:\s*3\.5rem\s*;/);
  assert.match(coarse[1], /:root\s*\{\s*--height-tabs:\s*var\(--height-tabs-touch\);\s*\}/);
  assert.match(coarse[1], /\.tab-strip\s*\{\s*--height-tab:\s*var\(--target-touch\);\s*--target-minimum:\s*var\(--target-touch\);\s*\}/);
  for (const [token, size] of [['height-tab', 'size-32'], ['height-tabs', 'size-44'], ['target-minimum', 'size-32']]) {
    const declaration = new RegExp('--' + token + ':\\s*([^;]+);', 'g');
    assert.deepEqual([...tokens.matchAll(declaration)].map(match => match[1].trim()), ['var(--' + size + ')']);
    assert.doesNotMatch(css.replace(coarse[0], ''), declaration);
  }
});

test('cosmetic sanitization keeps only fixed hiding declarations and refuses loading CSS', () => {
  const styles = '.ad { display:none!important; } .remote { background:url(https://evil.example/x); } .font { @font-face:x; } .custom { opacity:0; }';
  assert.deepEqual(safeCosmeticCSS(styles), { css: '.ad { display: none !important; }', rules: 1 });
});
const { validateNotebookStore, readNotebookStore, writeNotebookStore, writeCaptureFile, readCaptureFile, cleanupCaptureFiles, CAPTURE_LIMIT, CAPTURE_STORAGE_LIMIT } = require('../dist/electron/notebooks.js');
const { captureRectangle, captureSelection, captureWholePage, SELECTION_CODE, SELECTION_WORLD, CAPTURE_DEADLINE } = require('../dist/electron/captures.js');
const plainCipher = { isEncryptionAvailable: () => false };
function sampleNotebookItem(kind = 'note') {
  return { id: randomUUID(), kind, title: 'Item', text: kind === 'note' || kind === 'text' ? 'Private text' : '', note: '',
    source: kind === 'note' ? null : { url: 'https://example.com/', title: 'Source' },
    image: kind === 'area' || kind === 'page' ? { filename: `${randomUUID()}.bin`, width: 1, height: 1, bytes: faviconPNG.length, cut: false } : null,
    createdAt: 1, updatedAt: 1 };
}
function sampleNotebookStore() {
  const id = randomUUID();
  return { version: 1, key: require('node:crypto').randomBytes(32).toString('base64'), inUse: id,
    notebooks: [{ id, name: 'Research', createdAt: 1, updatedAt: 1, usedAt: 1, items: ['note', 'text', 'area', 'page'].map(sampleNotebookItem) }] };
}
function timedModule(name, timers) {
  const filename = resolve(`dist/electron/${name}.js`), exported = {};
  const localRequire = require('node:module').createRequire(filename);
  const schedule = (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; };
  require('node:vm').compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', 'setTimeout', 'clearTimeout'])(exported, localRequire, schedule, id => timers.delete(id));
  return exported;
}
function fireTimers(timers, delay) {
  for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
}

test('notebook schema validates exact shapes, names, sources, UUIDs, text and every limit', () => {
  const original = sampleNotebookStore(); assert.equal(validateNotebookStore(original), true);
  const invalid = change => { const store = structuredClone(original); change(store); assert.equal(validateNotebookStore(store), false); };
  for (const value of [null, [], {}, { ...original, extra: true }]) assert.equal(validateNotebookStore(value), false);
  for (const name of ['', ' ', ' padded ', 'a'.repeat(81), 'line\nname', 'null\0name', 'control\u0085']) invalid(store => { store.notebooks[0].name = name; });
  for (const key of ['', 'a'.repeat(44), Buffer.alloc(31).toString('base64')]) invalid(store => { store.key = key; });
  invalid(store => { store.version = 2; }); invalid(store => { store.inUse = randomUUID(); });
  invalid(store => { store.notebooks[0].extra = true; }); invalid(store => { store.notebooks[0].id = '../escape'; });
  invalid(store => { store.notebooks.push({ ...store.notebooks[0], id: randomUUID(), name: 'RESEARCH', items: [] }); });
  invalid(store => { store.notebooks.push({ ...store.notebooks[0], name: 'Other', items: [] }); });
  for (const field of ['createdAt', 'updatedAt', 'usedAt']) for (const value of [-1, 1.1, Infinity, 8640000000000001]) invalid(store => { store.notebooks[0][field] = value; });
  for (const [field, value] of [['extra', true], ['id', 'bad'], ['kind', 'unknown'], ['title', 'x'.repeat(201)], ['text', 'x'.repeat(100001)], ['note', 'x'.repeat(20001)], ['text', '\0'], ['createdAt', -1], ['updatedAt', 1.5]]) invalid(store => { store.notebooks[0].items[1][field] = value; });
  invalid(store => { store.notebooks[0].items.push(store.notebooks[0].items[0]); });
  invalid(store => { store.notebooks[0].items[0].source = { url: 'https://example.com/', title: '' }; });
  invalid(store => { store.notebooks[0].items[0].note = 'annotation'; });
  for (const url of ['file:///private', 'horizon://app/', 'https://user@example.com/']) invalid(store => { store.notebooks[0].items[1].source.url = url; });
  invalid(store => { store.notebooks[0].items[1].source.extra = true; }); invalid(store => { store.notebooks[0].items[1].source.title = 'x'.repeat(4097); });
  invalid(store => { store.notebooks[0].items[1].image = store.notebooks[0].items[2].image; });
  invalid(store => { store.notebooks[0].items[2].image = null; }); invalid(store => { store.notebooks[0].items[2].text = 'body'; });
  for (const [field, value] of [['filename', '../private.bin'], ['filename', 'page.png'], ['width', 0], ['height', -1], ['bytes', CAPTURE_LIMIT + 1], ['bytes', 0], ['cut', 'yes'], ['extra', true]]) invalid(store => { store.notebooks[0].items[2].image[field] = value; });
  invalid(store => { store.notebooks[0].items[2].image.cut = true; });
  invalid(store => { store.notebooks[0].items[3].image.height = 16385; });
  invalid(store => { store.notebooks[0].items[3].image.filename = store.notebooks[0].items[2].image.filename; });
  const bounded = structuredClone(original); bounded.notebooks[0].items = [];
  for (let index = 1; index < 200; index++) bounded.notebooks.push({ ...bounded.notebooks[0], id: randomUUID(), name: `Notebook ${index}`, items: [] });
  assert.equal(validateNotebookStore(bounded), true);
  bounded.notebooks.push({ ...bounded.notebooks[0], id: randomUUID(), name: 'Over limit' }); assert.equal(validateNotebookStore(bounded), false);
  const items = structuredClone(original); items.notebooks[0].items = Array.from({ length: 2000 }, () => sampleNotebookItem());
  assert.equal(validateNotebookStore(items), true); items.notebooks[0].items.push(sampleNotebookItem()); assert.equal(validateNotebookStore(items), false);
  const quota = structuredClone(original); quota.notebooks[0].items = Array.from({ length: 41 }, () => ({ ...sampleNotebookItem('page'), image: { filename: `${randomUUID()}.bin`, width: 1, height: 1, bytes: CAPTURE_LIMIT, cut: true } }));
  assert.equal(validateNotebookStore(quota), false); quota.notebooks[0].items.pop(); assert.equal(validateNotebookStore(quota), true);
});

test('notebook stores share encrypted and plain storage protections and recover corrupt originals', t => {
  const directory = temporaryDirectory(t, 'notebook-store'), path = join(directory, 'notebooks.json'), store = sampleNotebookStore();
  for (const cipher of [plainCipher, authenticatedCipher()]) {
    writeNotebookStore(path, store, cipher); assert.deepEqual(readNotebookStore(path, cipher), store);
    const original = readFileSync(path);
    assert.equal(original.includes(Buffer.from('Private text')), cipher === plainCipher);
    if (cipher !== plainCipher) {
      const status = { readError: false, memoryOnly: false };
      assert.deepEqual(readNotebookStore(path, plainCipher, status).notebooks, []); assert.deepEqual(status, { readError: true, memoryOnly: true });
      assert.throws(() => writeNotebookStore(path, store, plainCipher)); assert.deepEqual(readFileSync(path), original);
      original[original.length - 1] ^= 1; writeFileSync(path, original);
    } else writeFileSync(path, '{broken');
    const corrupt = readFileSync(path), status = { readError: false, memoryOnly: false };
    assert.deepEqual(readNotebookStore(path, cipher, status).notebooks, []); assert.equal(status.readError, true);
    assert.ok(readdirSync(directory).filter(name => name.startsWith('notebooks.json.corrupt-')).some(name => readFileSync(join(directory, name)).equals(corrupt)));
  }
  const upgrade = join(directory, 'upgrade.json'); writeNotebookStore(upgrade, store, plainCipher); const encrypted = authenticatedCipher();
  assert.deepEqual(readNotebookStore(upgrade, encrypted), store); assert.ok(readFileSync(upgrade).subarray(0, 16).toString().startsWith('HORIZON-STORE-1'));
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  assert.throws(() => writeNotebookStore(path, { ...store, extra: true }, encrypted));
  writeFileSync(path, JSON.stringify({ ...store, version: 2 })); const status = { readError: false, memoryOnly: false };
  assert.deepEqual(readNotebookStore(path, plainCipher, status).notebooks, []); assert.equal(status.readError, true);
  const blocked = join(directory, 'file'); writeFileSync(blocked, 'file'); const failed = { readError: false, memoryOnly: false };
  assert.deepEqual(readNotebookStore(join(blocked, 'notebooks.json'), plainCipher, failed).notebooks, []); assert.equal(failed.readError, true);
  if (process.platform !== 'win32') assert.equal(require('node:fs').statSync(path).mode & 0o777, 0o600);
});

test('capture files authenticate bytes and item identity, enforce quotas and clean only generated regular orphans', t => {
  const root = temporaryDirectory(t, 'capture-files'), directory = join(root, 'captures'), store = sampleNotebookStore(), item = store.notebooks[0].items[2];
  item.image.filename = writeCaptureFile(directory, store.key, item.id, faviconPNG);
  const path = join(directory, item.image.filename), encrypted = readFileSync(path);
  assert.equal(encrypted.length, faviconPNG.length + 28); assert.equal(encrypted.includes(faviconPNG), false);
  assert.deepEqual(readCaptureFile(directory, store.key, item), faviconPNG);
  assert.equal(readCaptureFile(directory, store.key, { ...item, id: randomUUID() }), null);
  encrypted[encrypted.length - 1] ^= 1; writeFileSync(path, encrypted); assert.equal(readCaptureFile(directory, store.key, item), null);
  encrypted[encrypted.length - 1] ^= 1; writeFileSync(path, encrypted);
  const orphan = writeCaptureFile(directory, store.key, randomUUID(), faviconPNG);
  const foreign = join(directory, 'foreign.png'); writeFileSync(foreign, 'keep');
  const target = join(root, 'outside'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'keep');
  const junction = join(directory, `${randomUUID()}.bin`); symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
  cleanupCaptureFiles(directory, store);
  assert.equal(existsSync(path), true); assert.equal(existsSync(join(directory, orphan)), false);
  assert.equal(existsSync(foreign), true); assert.equal(existsSync(junction), true); assert.equal(existsSync(join(target, 'keep')), true);
  const redirected = join(root, 'redirected'); symlinkSync(directory, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanupCaptureFiles(redirected, store), /NOTEBOOK_STORAGE_FAILED/);
  assert.throws(() => writeCaptureFile(redirected, store.key, randomUUID(), faviconPNG), /NOTEBOOK_STORAGE_FAILED/);
  assert.equal(readCaptureFile(redirected, store.key, item), null);
  const missingTarget = join(root, 'missing-target'), dangling = join(root, 'dangling'); mkdirSync(missingTarget);
  symlinkSync(missingTarget, dangling, process.platform === 'win32' ? 'junction' : 'dir'); require('node:fs').rmdirSync(missingTarget);
  assert.throws(() => cleanupCaptureFiles(dangling, store), /NOTEBOOK_STORAGE_FAILED/);
  assert.throws(() => writeCaptureFile(dangling, store.key, randomUUID(), faviconPNG), /NOTEBOOK_STORAGE_FAILED/);
  assert.throws(() => writeCaptureFile(directory, store.key, randomUUID(), Buffer.alloc(CAPTURE_LIMIT + 1)), /CAPTURE_TOO_LARGE/);
  const quota = join(directory, `${randomUUID()}.bin`); writeFileSync(quota, ''); require('node:fs').truncateSync(quota, CAPTURE_STORAGE_LIMIT);
  assert.throws(() => writeCaptureFile(directory, store.key, randomUUID(), faviconPNG), /NOTEBOOK_STORAGE_FULL/);
  require('node:fs').unlinkSync(quota);
  if (process.platform !== 'win32') {
    assert.equal(require('node:fs').statSync(directory).mode & 0o777, 0o700); assert.equal(require('node:fs').statSync(path).mode & 0o777, 0o600);
  }
});

test('notebook runtime debounces, flushes, enforces named limits and retains captures through undo', t => {
  const root = temporaryDirectory(t, 'notebook-runtime'), path = join(root, 'notebooks.json'), timers = new Map();
  const { createNotebooks } = timedModule('notebooks', timers), runtime = createNotebooks(path, plainCipher, () => {});
  const notebook = runtime.create('  Research  '); assert.equal(notebook.name, 'Research');
  runtime.addNote(notebook.id, 'Title', 'Private body'); const note = notebook.items[0];
  assert.equal([...timers.values()].filter(timer => timer.delay === 500).length, 1);
  assert.deepEqual(readNotebookStore(path).notebooks, []); runtime.flush(); assert.equal(readNotebookStore(path).notebooks[0].items[0].text, 'Private body');
  assert.throws(() => runtime.create('RESEARCH'), /NOTEBOOK_NAME_DUPLICATE/);
  for (const [name, error] of [['', 'EMPTY'], ['x'.repeat(81), 'LONG'], ['a\nb', 'INVALID']]) assert.throws(() => runtime.create(name), new RegExp('NOTEBOOK_NAME_' + error));
  runtime.update(notebook.id, note.id, { text: 'Edited' }); assert.equal(runtime.content(notebook.id).items[0].text, 'Edited');
  assert.throws(() => runtime.update(notebook.id, note.id, { title: 'x'.repeat(201) }), /NOTEBOOK_ITEM_INVALID/);
  assert.throws(() => runtime.update(notebook.id, note.id, { note: 'annotation' }), /NOTEBOOK_ITEM_INVALID/);
  const capture = sampleNotebookItem('area'); capture.image = null; runtime.addCapture(notebook.id, capture, faviconPNG, { width: 1, height: 1, cut: false });
  const capturePath = join(root, 'captures', capture.image.filename); assert.deepEqual(runtime.image(notebook.id, capture.id), faviconPNG);
  const state = runtime.state(); assert.equal(state.notebookInUse, notebook.id); assert.equal(state.notebooks[0].notes, 1); assert.equal(state.notebooks[0].captures, 1);
  assert.equal(JSON.stringify(state).includes('Edited'), false); assert.equal(JSON.stringify(state).includes('.bin'), false); assert.equal(JSON.stringify(state).includes('image'), false);
  assert.equal(JSON.stringify(runtime.content(notebook.id)).includes('.bin'), false);
  runtime.deleteItem(notebook.id, capture.id); assert.equal(existsSync(capturePath), true); runtime.restore(); assert.deepEqual(runtime.image(notebook.id, capture.id), faviconPNG);
  runtime.delete(notebook.id); assert.equal(runtime.state().notebookInUse, null); runtime.restore(); assert.equal(runtime.state().notebookInUse, notebook.id);
  runtime.deleteItem(notebook.id, capture.id); fireTimers(timers, 8000); assert.equal(existsSync(capturePath), false); runtime.restore(); assert.equal(notebook.items.length, 1);
  runtime.deleteItem(notebook.id, note.id); runtime.forget(); runtime.restore(); assert.equal(notebook.items.length, 0);
  for (let index = 0; index < 2000; index++) runtime.addNote(notebook.id, '', '');
  assert.throws(() => runtime.addNote(notebook.id, '', ''), /NOTEBOOK_ITEM_LIMIT/);
  assert.throws(() => runtime.addCapture(notebook.id, sampleNotebookItem('text')), /NOTEBOOK_ITEM_LIMIT/);
  for (let index = 1; index < 200; index++) runtime.create(`Notebook ${index}`);
  assert.throws(() => runtime.create('Over limit'), /NOTEBOOK_LIMIT/);
  const pending = runtime.state().notebooksVersion; runtime.dispose(); assert.equal(timers.size, 0); assert.ok(pending > 2000); assert.equal(readNotebookStore(path).notebooks.length, 200);
  const discarded = createNotebooks(join(root, 'discarded.json'), plainCipher, () => {}); discarded.create('Unsaved'); discarded.dispose(true);
  assert.equal(timers.size, 0); assert.deepEqual(readNotebookStore(join(root, 'discarded.json')).notebooks, []);
});

test('all notebook commands validate exact arguments and refuse another profile notebook or item', () => {
  const notebooks = sampleNotebookStore().notebooks, notebook = notebooks[0], id = notebook.id, item = notebook.items[0].id;
  const commands = [ { type: 'create-notebook', name: 'New' }, { type: 'rename-notebook', id, name: 'Name' },
    ...['delete-notebook', 'set-notebook'].map(type => ({ type, id })), { type: 'open-notebook', id }, { type: 'open-notebook', id, item },
    { type: 'add-note', notebook: id, title: '', text: '' }, { type: 'update-notebook-item', notebook: id, id: item, title: '', text: 'Body' },
    { type: 'update-notebook-item', notebook: id, id: item, note: '' }, { type: 'delete-notebook-item', notebook: id, id: item },
    ...['text', 'page'].map(kind => ({ type: 'save-capture', notebook: id, kind })), { type: 'save-capture', notebook: id, kind: 'area', rect: { x: -10, y: 10, width: 30, height: 40 } },
    { type: 'restore', kind: 'notebooks' } ];
  for (const command of commands) {
    assert.deepEqual(validateCommand(command, new Set(), notebooks), command);
    assert.throws(() => validateCommand({ ...command, extra: true }, new Set(), notebooks));
    for (const key of Object.keys(command).filter(key => !['item', 'title', 'text', 'note'].includes(key))) {
      const missing = { ...command }; delete missing[key]; assert.throws(() => validateCommand(missing, new Set(), notebooks));
    }
    if (command.notebook) assert.throws(() => validateCommand({ ...command, notebook: randomUUID() }, new Set(), notebooks));
    if (command.id) assert.throws(() => validateCommand({ ...command, id: randomUUID() }, new Set(), notebooks));
  }
  const invalid = [ { type: 'open-notebook', id, item: randomUUID() }, { type: 'open-notebook', id, item: undefined },
    { type: 'update-notebook-item', notebook: id, id: item }, { type: 'update-notebook-item', notebook: id, id: item, title: undefined },
    { type: 'update-notebook-item', notebook: id, id: item, text: 'x'.repeat(100001) }, { type: 'update-notebook-item', notebook: id, id: item, note: 'x'.repeat(20001) },
    { type: 'add-note', notebook: id, title: 'x'.repeat(201), text: '' }, { type: 'save-capture', notebook: id, kind: 'note' },
    { type: 'save-capture', notebook: id, kind: 'text', rect: {} } ];
  for (const rect of [{ x: 1, y: 1, width: 0, height: 9 }, { x: NaN, y: 1, width: 9, height: 9 }, { x: 0, y: 0, width: 9, height: Infinity }, { x: 0, y: 0, width: 9, height: 9, extra: 0 }]) invalid.push({ type: 'save-capture', notebook: id, kind: 'area', rect });
  invalid.forEach(command => assert.throws(() => validateCommand(command, new Set(), notebooks)));
});

test('area conversion multiplies chrome zoom, clamps inside the view and refuses small regions', () => {
  assert.deepEqual(captureRectangle({ x: 10, y: 20, width: 30, height: 40 }, 1.5, { width: 100, height: 100 }), { x: 15, y: 30, width: 45, height: 60 });
  assert.deepEqual(captureRectangle({ x: -10, y: -20, width: 100, height: 100 }, 2, { width: 100, height: 80 }), { x: 0, y: 0, width: 100, height: 80 });
  assert.throws(() => captureRectangle({ x: 95, y: 0, width: 40, height: 40 }, 1, { width: 100, height: 100 }), /CAPTURE_AREA_SMALL/);
  assert.throws(() => captureRectangle({ x: 0, y: 0, width: 8, height: 8 }, 0.5, { width: 100, height: 100 }), /CAPTURE_AREA_SMALL/);
});

test('selection capture uses one fixed isolated world and fixed code, trims, caps and reports no selection', async () => {
  const calls = [], contents = { executeJavaScriptInIsolatedWorld: async (...args) => { calls.push(args); return '  Selected  '; } };
  assert.equal(await captureSelection(contents), 'Selected'); assert.deepEqual(calls, [[SELECTION_WORLD, [{ code: 'String(getSelection())' }]]]); assert.equal(SELECTION_CODE, 'String(getSelection())');
  contents.executeJavaScriptInIsolatedWorld = async () => ' '; await assert.rejects(captureSelection(contents), /NOTHING_SELECTED/);
  contents.executeJavaScriptInIsolatedWorld = async () => 'a'.repeat(100001); assert.equal((await captureSelection(contents)).length, 100000);
});

test('page protocol refuses hidden views, caps device height, uses only two commands and always detaches', async () => {
  const calls = []; let attached = false;
  const contents = { debugger: { attach(version) { assert.equal(version, '1.3'); attached = true; }, detach() { attached = false; calls.push('detach'); },
    async sendCommand(name, args) { calls.push([name, args]); return name === 'Page.getLayoutMetrics' ? { cssLayoutViewport: { clientWidth: 800 }, cssContentSize: { height: 20000 } } : { data: faviconPNG.toString('base64') }; } } };
  await assert.rejects(captureWholePage(contents, false, 2, () => {}), /CAPTURE_PAGE_HIDDEN/); assert.deepEqual(calls, []);
  const result = await captureWholePage(contents, true, 2, () => {}); assert.equal(result.image.cut, true); assert.deepEqual(result.bytes, faviconPNG); assert.equal(attached, false);
  assert.deepEqual(calls, [['Page.getLayoutMetrics', undefined], ['Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 8192, scale: 1 } }], 'detach']);
  contents.debugger.sendCommand = async () => { throw new Error('Protocol failed'); }; await assert.rejects(captureWholePage(contents, true, 1, () => {}), /Protocol failed/); assert.equal(attached, false);
});

test('either page protocol call exceeding its deadline detaches without accepting late results', async () => {
  for (const stalled of ['Page.getLayoutMetrics', 'Page.captureScreenshot']) {
    const timers = new Map(), capture = timedModule('captures', timers); let detached = 0, finish;
    const contents = { debugger: { attach() {}, detach() { detached++; }, sendCommand(name) {
      return name === stalled ? new Promise(done => { finish = done; }) : Promise.resolve({ cssLayoutViewport: { clientWidth: 800 }, cssContentSize: { height: 600 } });
    } } };
    const work = capture.captureWholePage(contents, true, 1, () => {}); const rejected = assert.rejects(work, /CAPTURE_TIMEOUT/);
    await Promise.resolve(); await Promise.resolve(); assert.equal([...timers.values()].some(timer => timer.delay === CAPTURE_DEADLINE), true);
    fireTimers(timers, CAPTURE_DEADLINE); await rejected; assert.equal(detached, 1);
    finish({ data: faviconPNG.toString('base64') }); await Promise.resolve(); await Promise.resolve(); assert.equal(detached, 1); assert.equal(timers.size, 0);
  }
});
function notebookBrowser(t, cipher = plainCipher, options = {}) {
  const { EventEmitter } = require('node:events'), { compileFunction } = require('node:vm');
  let close = () => {}; t.after(() => close());
  const directory = temporaryDirectory(t, 'notebook-browser'), handlers = new Map(), views = [], timers = new Map(), sessions = new Map();
  const notebookModule = timedModule('notebooks', timers), captureModule = timedModule('captures', timers);
  let contentsId = 0;
  class Contents extends EventEmitter {
    constructor(targetSession) {
      super(); this.id = ++contentsId; this.session = targetSession; this.zoom = 1; this.mainFrame = { url: 'horizon://app/' }; this.sent = []; this.protocol = [];
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [], getActiveIndex: () => -1 };
      this.debugger = { attach: () => { this.attached = true; }, detach: () => { this.attached = false; this.detached = (this.detached || 0) + 1; }, sendCommand: async (name, args) => {
        this.protocol.push([name, args]); return name === 'Page.getLayoutMetrics' ? { cssLayoutViewport: { clientWidth: 800 }, cssContentSize: { height: 600 } } : { data: faviconPNG.toString('base64') };
      } };
    }
    isDestroyed() { return !!this.destroyed; }
    send(...args) { this.sent.push(args); }
    setWindowOpenHandler(fn) { this.popup = fn; }
    focus() {}
    setZoomMode() {}
    setZoomFactor(value) { this.zoom = value; }
    getZoomFactor() { return this.zoom; }
    getTitle() { return this.title || 'A web page'; }
    loadURL(url) { this.mainFrame.url = url; return Promise.resolve(); }
    isLoading() { return false; }
    stopFindInPage() {}
    insertCSS() { return Promise.resolve('style'); }
    removeInsertedCSS() { return Promise.resolve(); }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } }
    capturePage(...args) { this.captureArgs = args; return Promise.resolve({ toPNG: () => faviconPNG }); }
    executeJavaScriptInIsolatedWorld(...args) { this.selectionArgs = args; return Promise.resolve(this.selection ?? ' Selected text '); }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(sessions.get(options.webPreferences.partition)); views.push(this); }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    setVisible(value) { this.visible = value; }
    getVisible() { return this.visible; }
  }
  const app = Object.assign(new EventEmitter(), { getLocale: () => 'en', getPath: () => directory, commandLine: { appendSwitch() {}, removeSwitch() {} } });
  app.quit = () => { app.quits = (app.quits || 0) + 1; };
  const electron = { app, nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }), safeStorage: cipher, WebContentsView: View,
    screen: { getDisplayMatching: () => ({ scaleFactor: 2 }) },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } },
    session: { fromPartition(partition) {
      if (!sessions.has(partition)) {
        const target = new EventEmitter(); target.setPermissionRequestHandler = fn => { target.request = fn; }; target.setPermissionCheckHandler = fn => { target.check = fn; }; target.setDevicePermissionHandler = () => {};
        target.webRequest = Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred'].map(name => [name, fn => { target[name] = fn; }]));
        target.cleared = [];
        for (const name of ['clearStorageData', 'closeAllConnections', 'clearCache', 'clearAuthCache', 'clearCodeCaches']) target[name] = async args => { target.cleared.push([name, args]); if (options.clear) return options.clear(name, target); };
        sessions.set(partition, target);
      }
      return sessions.get(partition);
    } },
  };
  const filename = resolve('dist/electron/browser.js'), localRequire = require('node:module').createRequire(filename), exported = {};
  const schedule = (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; };
  compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', 'setTimeout', 'clearTimeout'])(exported, name =>
    name === 'electron' ? electron : name === './browsing-data' ? timedModule('browsing-data', timers) : name === './store' ? { ...localRequire(name), writeStore(...args) { if (options.failStore) throw new Error('Disk failure'); return localRequire(name).writeStore(...args); } } : name === './notebooks' ? notebookModule : name === './captures' ? captureModule : name === './blocking' ? { createBlockingEngine: () => options.blocker ?? ({ ready: false, start: async () => {}, stop() {}, cosmeticCSS: () => '', match: () => undefined }) } : localRequire(name), schedule, id => timers.delete(id));
  const window = Object.assign(new EventEmitter(), { webContents: new Contents(), isDestroyed: () => false, isFocused: () => true,
    getContentBounds: () => ({ width: 800, height: 600 }), setTitle() {}, setFullScreen() {}, contentView: { addChildView() {}, removeChildView() {} } });
  electron.dialog = { showOpenDialog: async (...args) => { options.folderArgs = args; if (options.folderError) throw new Error('Picker failed'); return options.folderChoice ?? { canceled: true, filePaths: [] }; }, showSaveDialogSync: (...args) => { options.saveArgs = args; return options.saveChoice; } };
  electron.shell = { openExternal: async () => assert.fail('System settings must stay mocked'), showItemInFolder: path => { options.shownPath = path; }, openPath: async () => '' };
  Contents.prototype.stop = function () { this.stops = (this.stops || 0) + 1; };
  Contents.prototype.reload = function () { this.reloads = (this.reloads || 0) + 1; };
  Contents.prototype.reloadIgnoringCache = function () { this.bypassedCache = (this.bypassedCache || 0) + 1; };
  options.prepare?.(directory);
  const settings = createSettings(join(directory, 'settings.json'), () => {});
  const browser = exported.createBrowser(window, directory, join(directory, 'downloads'), settings, undefined, { status: 'developmentBuild', refresh: async () => {}, register: async () => {} });
  let closed = false; close = () => { if (!closed) { closed = true; window.emit('closed'); } };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const state = () => handlers.get('horizon:state')(event), command = value => handlers.get('horizon:command')(event, value);
  const notebook = (...args) => handlers.get('horizon:notebook')(event, ...args), image = (...args) => handlers.get('horizon:capture-image')(event, ...args);
  const area = hidden => handlers.get('horizon:content-area')(event, { top: 100, hidden });
  const navigate = (url = 'https://example.com/') => { command({ type: 'navigate', input: url }); views.at(-1).webContents.emit('did-navigate', {}, url); };
  return { directory, handlers, views, timers, sessions, window, app, close, event, state, command, notebook, image, area, navigate, settings, openLaunch: browser.openLaunch, isLaunchNavigation: exported.isLaunchNavigation };
}

test('notebook tabs are chrome pages, remain consistent across editing and never enter history or a web view', async t => {
  const browser = notebookBrowser(t), { state, command, notebook, views } = browser;
  command({ type: 'create-notebook', name: 'My Research' }); const id = state().notebookInUse;
  command({ type: 'add-note', notebook: id, title: 'A note', text: 'Secret note' }); const item = notebook(id).items[0].id;
  const version = state().notebooksVersion;
  command({ type: 'open-notebook', id, item }); const tab = state().activeId;
  assert.equal(views.length, 0); assert.equal(state().tabs.find(entry => entry.id === tab).notebook, id);
  assert.equal(state().tabs.find(entry => entry.id === tab).notebookItem, item);
  assert.equal(state().tabs.find(entry => entry.id === tab).url, 'horizon://notebooks/my-research');
  assert.deepEqual(state().store.history, []); assert.equal(state().siteSettings, null); assert.equal(state().permissionPrompt, null);
  assert.equal(state().tabs.find(entry => entry.id === tab).favicon, null); assert.deepEqual(state().tabs.find(entry => entry.id === tab).blocked, { ads: 0, trackers: 0, cookies: 0 });
  command({ type: 'open-notebook', id }); assert.equal(state().activeId, tab); assert.equal(state().tabs.length, 1);
  command({ type: 'rename-notebook', id, name: 'Renamed Name' }); assert.equal(state().tabs.find(entry => entry.id === tab).url, 'horizon://notebooks/renamed-name');
  assert.equal(state().tabs.find(entry => entry.id === tab).title, 'Renamed Name'); assert.ok(state().notebooksVersion > version);
  await assert.rejects(command({ type: 'save-capture', notebook: id, kind: 'text' }), /CAPTURE_UNAVAILABLE/);
  command({ type: 'update-notebook-item', notebook: id, id: item, title: 'Edited title', text: 'Secret edit' });
  const wire = JSON.stringify(state()); assert.equal(wire.includes('Secret edit'), false); assert.equal(wire.includes('Secret note'), false);
  command({ type: 'open-notebook', id, item }); command({ type: 'delete-notebook-item', notebook: id, id: item });
  assert.equal(state().tabs.find(entry => entry.id === tab).notebookItem, null); command({ type: 'restore', kind: 'notebooks' }); assert.equal(notebook(id).items.length, 1);
  command({ type: 'navigate', input: 'example.com' }); assert.equal(state().tabs.find(entry => entry.id === tab).notebook, null); assert.equal(views.length, 1);
  views[0].webContents.emit('did-navigate', {}, 'https://example.com/'); assert.equal(state().store.history.length, 1);
  command({ type: 'open-notebook', id }); const reopened = state().activeId; command({ type: 'close-tab', id: reopened });
  command({ type: 'open-notebook', id });
  for (const target of [...state().tabs].filter(tab => tab.notebook !== id)) command({ type: 'close-tab', id: target.id });
  assert.equal(state().tabs.length, 1); command({ type: 'delete-notebook', id });
  assert.equal(state().tabs.length, 1); assert.equal(state().tabs[0].url, ''); assert.equal(state().tabs[0].notebook, null);
  command({ type: 'restore', kind: 'notebooks' }); assert.equal(notebook(id).items.length, 1);
  const profile = state().activeProfileId; browser.app.emit('before-quit');
  assert.equal(readNotebookStore(join(browser.directory, 'profiles', profile, 'notebooks.json')).notebooks[0].items[0].text, 'Secret edit');
  browser.close(); assert.equal(browser.handlers.size, 0); assert.equal(browser.timers.size, 0);
});

test('capture commands save all three kinds to the current profile and image IPC exposes bytes without paths', async t => {
  const browser = notebookBrowser(t), { state, command, notebook, image, handlers, event, window } = browser;
  command({ type: 'create-notebook', name: 'Captures' }); const id = state().notebookInUse;
  await assert.rejects(command({ type: 'save-capture', notebook: id, kind: 'area', rect: { x: 0, y: 0, width: 20, height: 20 } }), /CAPTURE_UNAVAILABLE/);
  browser.navigate(); const view = browser.views[0]; window.webContents.zoom = 1.5; browser.area(true);
  await command({ type: 'save-capture', notebook: id, kind: 'text' });
  const text = notebook(id).items[0]; assert.equal(text.text, 'Selected text'); assert.equal(text.title, 'A web page');
  assert.deepEqual(text.source, { url: 'https://example.com/', title: 'A web page' });
  assert.deepEqual(view.webContents.selectionArgs, [1006, [{ code: 'String(getSelection())' }]]);
  await command({ type: 'save-capture', notebook: id, kind: 'area', rect: { x: -10, y: -10, width: 1000, height: 1000 } });
  assert.deepEqual(view.webContents.captureArgs, [{ x: 0, y: 0, width: 800, height: 450 }, { stayHidden: true }]);
  const area = notebook(id).items[1]; assert.deepEqual(image(id, area.id), faviconPNG); assert.equal(image(id, text.id), null);
  assert.deepEqual(area.image, { width: 1, height: 1, bytes: faviconPNG.length, cut: false }); assert.equal(JSON.stringify(notebook(id)).includes('.bin'), false);
  await assert.rejects(command({ type: 'save-capture', notebook: id, kind: 'page' }), /CAPTURE_PAGE_HIDDEN/); assert.equal(view.webContents.protocol.length, 0);
  browser.area(false); view.setVisible(false);
  await assert.rejects(command({ type: 'save-capture', notebook: id, kind: 'page' }), /CAPTURE_PAGE_HIDDEN/);
  view.setVisible(true); const originalBounds = view.getBounds(); view.setBounds({ ...originalBounds, x: 800 });
  await assert.rejects(command({ type: 'save-capture', notebook: id, kind: 'page' }), /CAPTURE_PAGE_HIDDEN/);
  view.setBounds(originalBounds); await command({ type: 'save-capture', notebook: id, kind: 'page' });
  assert.equal(view.webContents.attached, false); assert.equal(view.webContents.detached, 1); assert.equal(notebook(id).items.length, 3);
  assert.equal(state().notebooks[0].captures, 3); assert.equal(state().notebooks[0].latest.length, 3);
  assert.equal(JSON.stringify(state()).includes('Selected text'), false); assert.equal(JSON.stringify(state()).includes('image'), false);
  view.webContents.selection = ''; await assert.rejects(command({ type: 'save-capture', notebook: id, kind: 'text' }), /NOTHING_SELECTED/);
  await assert.rejects(command({ type: 'save-capture', notebook: id, kind: 'area', rect: { x: 0, y: 0, width: 1, height: 1 } }), /CAPTURE_AREA_SMALL/);
  view.webContents.executeJavaScriptInIsolatedWorld = async () => { throw new Error('Native detail'); };
  await assert.rejects(command({ type: 'save-capture', notebook: id, kind: 'text' }), /CAPTURE_FAILED/);
  for (const channel of ['horizon:notebook', 'horizon:capture-image']) {
    const args = channel === 'horizon:notebook' ? [id] : [id, area.id];
    assert.throws(() => handlers.get(channel)({ ...event, sender: {} }, ...args));
    assert.throws(() => handlers.get(channel)({ ...event, senderFrame: { url: 'horizon://app/' } }, ...args));
    assert.throws(() => handlers.get(channel)(event, ...args, 'extra'));
    assert.throws(() => handlers.get(channel)(event, '../escape', ...args.slice(1)));
    assert.throws(() => handlers.get(channel)(event));
  }
  assert.throws(() => image(id, randomUUID()), /NOTEBOOK_ITEM_NOT_FOUND/); assert.throws(() => notebook(randomUUID()), /NOTEBOOK_NOT_FOUND/);
  const work = state().profiles.find(profile => profile.id !== state().activeProfileId); command({ type: 'switch-profile', id: work.id });
  assert.deepEqual(state().notebooks, []); assert.throws(() => notebook(id), /NOTEBOOK_NOT_FOUND/); assert.throws(() => image(id, area.id), /NOTEBOOK_NOT_FOUND/);
  for (const value of [{ type: 'open-notebook', id }, { type: 'save-capture', notebook: id, kind: 'text' }, { type: 'delete-notebook-item', notebook: id, id: area.id }]) assert.throws(() => command(value));
  browser.close(); assert.equal(handlers.size, 0); assert.equal(browser.timers.size, 0);
});

test('captures abandon changed tabs, pages, errors and profiles even when the original becomes active again', async t => {
  const browser = notebookBrowser(t), { state, command, notebook } = browser;
  command({ type: 'create-notebook', name: 'Research' }); const id = state().notebookInUse; browser.navigate();
  const tab = state().activeId, profile = state().activeProfileId, view = browser.views[0];
  const changes = [
    () => { browser.navigate(); },
    () => { view.webContents.emit('did-start-navigation', {}, 'https://example.com/#part', true, true); },
    () => { command({ type: 'new-tab' }); command({ type: 'activate-tab', id: tab }); },
    () => { const other = state().profiles.find(entry => entry.id !== profile); command({ type: 'switch-profile', id: other.id }); command({ type: 'switch-profile', id: profile }); },
    () => { view.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/', true); },
  ];
  for (const change of changes) {
    browser.navigate(); let finish;
    view.webContents.capturePage = () => new Promise(done => { finish = done; });
    const work = command({ type: 'save-capture', notebook: id, kind: 'area', rect: { x: 0, y: 0, width: 20, height: 20 } });
    const rejected = assert.rejects(work, /CAPTURE_CHANGED/); change(); finish({ toPNG: () => faviconPNG }); await rejected;
    assert.equal(notebook(id).items.length, 0);
  }
  browser.navigate(); let finish;
  view.webContents.executeJavaScriptInIsolatedWorld = () => new Promise(done => { finish = done; });
  const pending = command({ type: 'save-capture', notebook: id, kind: 'text' }), rejected = assert.rejects(pending, /CAPTURE_CHANGED/);
  command({ type: 'close-tab', id: tab }); finish('Selection'); await rejected; assert.equal(notebook(id).items.length, 0);
  browser.close(); assert.equal(browser.timers.size, 0);
});

test('profile deletion stops notebook writes and undo timers and capture deadlines detach through command IPC', async t => {
  const browser = notebookBrowser(t), { state, command, notebook } = browser;
  const original = state().activeProfileId, other = state().profiles.find(profile => profile.id !== original);
  command({ type: 'switch-profile', id: other.id }); command({ type: 'create-notebook', name: 'Deleted profile' });
  const id = state().notebookInUse; command({ type: 'add-note', notebook: id, title: '', text: 'Unsaved' });
  command({ type: 'delete-notebook-item', notebook: id, id: notebook(id).items[0].id });
  browser.navigate(); browser.area(false); const deletedView = browser.views.at(-1);
  deletedView.webContents.debugger.sendCommand = () => new Promise(() => {});
  const deletedCapture = command({ type: 'save-capture', notebook: id, kind: 'page' }), abandoned = assert.rejects(deletedCapture, /CAPTURE_CHANGED/);
  await command({ type: 'delete-profile', id: other.id }); fireTimers(browser.timers, 500); fireTimers(browser.timers, 8000);
  await abandoned; assert.equal(deletedView.webContents.detached, 1);
  assert.equal(existsSync(join(browser.directory, 'profiles', other.id)), false); assert.equal(browser.timers.size, 0);
  command({ type: 'create-notebook', name: 'Current profile' }); const current = state().notebookInUse; browser.navigate(); browser.area(false);
  const view = browser.views.at(-1); view.webContents.debugger.sendCommand = () => new Promise(() => {});
  const pending = command({ type: 'save-capture', notebook: current, kind: 'page' }), rejected = assert.rejects(pending, /CAPTURE_TIMEOUT/);
  fireTimers(browser.timers, CAPTURE_DEADLINE); await rejected; assert.equal(view.webContents.attached, false); assert.equal(view.webContents.detached, 1);
  assert.equal(notebook(current).items.length, 0); browser.close(); assert.equal(browser.timers.size, 0);
});
test('notebook read and save errors reach state, encrypted originals survive missing keys and quit leaves undo files for orphan cleanup', t => {
  const root = temporaryDirectory(t, 'notebook-recovery'), path = join(root, 'notebooks.json'), timers = new Map();
  const { createNotebooks } = timedModule('notebooks', timers);
  const runtime = createNotebooks(path, plainCipher, () => {}), notebook = runtime.create('Research'), capture = sampleNotebookItem('area');
  capture.image = null; runtime.addCapture(notebook.id, capture, faviconPNG, { width: 1, height: 1, cut: false }); runtime.flush();
  const file = join(root, 'captures', capture.image.filename);
  runtime.deleteItem(notebook.id, capture.id); runtime.dispose(); assert.equal(existsSync(file), true); assert.equal(timers.size, 0);
  const reopened = createNotebooks(path, plainCipher, () => {}); assert.equal(existsSync(file), false); assert.equal(reopened.content(notebook.id).items.length, 0); reopened.dispose();
  const stored = sampleNotebookStore(), protectedItem = stored.notebooks[0].items[2];
  protectedItem.image.filename = writeCaptureFile(join(root, 'captures'), stored.key, protectedItem.id, faviconPNG);
  const cipher = authenticatedCipher(); writeNotebookStore(path, stored, cipher); const original = readFileSync(path);
  const unavailable = createNotebooks(path, plainCipher, () => {}); assert.equal(unavailable.state().notebookReadError, false); assert.equal(unavailable.state().notebookLocked, true);
  assert.throws(() => unavailable.create('Memory'), /NOTEBOOK_LOCKED/);
  assert.throws(() => unavailable.addNote(stored.notebooks[0].id, '', 'Session edit'), /NOTEBOOK_LOCKED/);
  assert.throws(() => unavailable.addCapture(stored.notebooks[0].id, sampleNotebookItem('text')), /NOTEBOOK_LOCKED/);
  unavailable.dispose(); assert.equal(timers.size, 0); assert.deepEqual(readFileSync(path), original);
  const protectedFile = join(root, 'captures', protectedItem.image.filename); assert.equal(existsSync(protectedFile), true);
  original[original.length - 1] ^= 1; writeFileSync(path, original);
  const recovered = createNotebooks(path, cipher, () => {}); assert.equal(recovered.state().notebookReadError, true); assert.deepEqual(recovered.state().notebooks, []);
  assert.equal(existsSync(protectedFile), true); recovered.dispose();
  const blocked = join(root, 'blocked'); writeFileSync(blocked, 'file');
  const failed = createNotebooks(join(blocked, 'notebooks.json'), plainCipher, () => {}), failedNotebook = failed.create('Unavailable disk');
  failed.flush(); assert.equal(failed.state().notebookReadError, true); assert.equal(failed.state().notebookStorageError, true);
  const failedItem = sampleNotebookItem('area'); failedItem.image = null;
  assert.throws(() => failed.addCapture(failedNotebook.id, failedItem, faviconPNG, { width: 1, height: 1, cut: false }), /NOTEBOOK_STORAGE_FAILED/);
  failed.dispose(); assert.equal(timers.size, 0);
});

test('capture storage allows linked user-data ancestors but rejects every owned linked folder', t => {
  const root = temporaryDirectory(t, 'notebook-linked-home'), actual = join(root, 'actual'), linked = join(root, 'linked');
  mkdirSync(actual); symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const store = sampleNotebookStore(), item = store.notebooks[0].items[2], directory = join(linked, 'profiles', store.notebooks[0].id, 'captures');
  item.image.filename = writeCaptureFile(directory, store.key, item.id, faviconPNG);
  assert.deepEqual(readCaptureFile(directory, store.key, item), faviconPNG);
  assert.doesNotThrow(() => cleanupCaptureFiles(directory, store));
  for (const depth of [0, 1, 2]) {
    const owned = join(root, `owned-${depth}`), target = join(root, `target-${depth}`); mkdirSync(target);
    const parts = ['profiles', randomUUID(), 'captures'];
    const linkAt = join(owned, ...parts.slice(0, depth + 1)); mkdirSync(require('node:path').dirname(linkAt), { recursive: true });
    symlinkSync(target, linkAt, process.platform === 'win32' ? 'junction' : 'dir');
    const captures = join(owned, ...parts);
    assert.throws(() => writeCaptureFile(captures, store.key, randomUUID(), faviconPNG), /NOTEBOOK_STORAGE_FAILED/);
  }
});

test('unreadable notebook stores preserve recovery captures on this and subsequent launches', t => {
  const root = temporaryDirectory(t, 'notebook-corrupt-captures'), path = join(root, 'profiles', randomUUID(), 'notebooks.json'), timers = new Map();
  const { createNotebooks } = timedModule('notebooks', timers), runtime = createNotebooks(path, plainCipher, () => {}), notebook = runtime.create('Recoverable');
  const item = sampleNotebookItem('area'); item.image = null;
  runtime.addCapture(notebook.id, item, faviconPNG, { width: 1, height: 1, cut: false }); runtime.dispose();
  const capture = join(require('node:path').dirname(path), 'captures', item.image.filename), bytes = readFileSync(capture);
  const original = readFileSync(path, 'utf8'); writeFileSync(path, '{corrupt');
  const recovered = createNotebooks(path, plainCipher, () => {});
  assert.equal(recovered.state().notebookReadError, true); assert.deepEqual(readFileSync(capture), bytes); recovered.dispose();
  const next = createNotebooks(path, plainCipher, () => {}); assert.equal(next.state().notebookReadError, false);
  assert.deepEqual(readFileSync(capture), bytes); next.dispose();
  // The preserved key still decrypts the image once the original store is restored.
  writeFileSync(path, original); const restored = createNotebooks(path, plainCipher, () => {});
  assert.deepEqual(restored.image(notebook.id, item.id), faviconPNG); restored.dispose();
});

test('notebook addresses keep non-ASCII names readable while removing address delimiters', t => {
  const browser = notebookBrowser(t), { command, state } = browser;
  command({ type: 'create-notebook', name: 'Café 東京: otoño + ideas (2026)' }); const id = state().notebookInUse;
  command({ type: 'open-notebook', id }); assert.equal(state().tabs[0].url, 'horizon://notebooks/café-東京:-otoño-+-ideas-(2026)');
  command({ type: 'rename-notebook', id, name: 'Café / rutas? #mapa % <x> "a" \\ b' });
  assert.equal(state().tabs[0].url, 'horizon://notebooks/café--rutas-mapa--x-a--b');
  browser.close();
});

test('opening a notebook reuses only an active start page or its existing notebook tab', t => {
  const browser = notebookBrowser(t), { command, state } = browser, home = state().activeId;
  command({ type: 'create-notebook', name: 'First' }); const first = state().notebookInUse;
  command({ type: 'open-notebook', id: first }); assert.equal(state().activeId, home); assert.equal(state().tabs.length, 1);
  command({ type: 'new-tab' }); const blank = state().activeId;
  command({ type: 'open-notebook', id: first }); assert.equal(state().activeId, home); assert.equal(state().tabs.find(tab => tab.id === blank).url, '');
  command({ type: 'activate-tab', id: blank }); browser.navigate();
  command({ type: 'create-notebook', name: 'Second' }); const second = state().notebookInUse;
  command({ type: 'open-notebook', id: second }); assert.notEqual(state().activeId, blank); assert.equal(state().tabs.length, 3);
  assert.equal(state().tabs.find(tab => tab.id === blank).url, 'https://example.com/'); browser.close();
});

function notebookTestHooks() {
  const slots = [], effects = []; let cursor = 0;
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useRef(current) { const index = cursor++; slots[index] ??= { current }; return slots[index]; },
    useId() { return `notebook-${cursor++}`; },
    useEffect(effect, dependencies) { const index = cursor++, before = slots[index]; if (!before || !dependencies || dependencies.some((value, i) => !Object.is(value, before.dependencies?.[i]))) { effects.push(() => { before?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; }); } },
  };
  react.useLayoutEffect = react.useEffect;
  return { react, render(callback) { cursor = 0; return callback(); }, flush() { effects.splice(0).forEach(effect => effect()); }, dispose() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function notebookNodes(node, predicate) {
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [...(predicate(node) ? [node] : []), ...interfaceChildren(node).flatMap(child => notebookNodes(child, predicate))];
}
const notebookTestIcons = Object.fromEntries(['AppWindow', 'NotebookPen', 'SquareDashed', 'Type', 'Camera', 'Check', 'FileText', 'LoaderCircle', 'Pencil', 'Plus', 'TriangleAlert', 'X', 'Ellipsis', 'Trash2'].map(name => [name, name]));

test('capture controls start on Area, expose radio semantics and move selection by arrows, dragging and two clicks', () => {
  const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts'), focused = [], document = { body: {}, activeElement: null };
  const { CaptureOverlay } = interfaceModule('src/Capture.tsx', { react: hooks.react, 'react-dom': { createPortal: node => node }, 'lucide-react': notebookTestIcons, './copy': copy, './Notebooks': { NotebookPicker: 'picker', notebookError: reason => reason.message } }, { document });
  const render = () => hooks.render(() => CaptureOverlay({ state: { notebooks: [] }, language: 'en', header: { current: null }, onClose() {}, onSave() {} }));
  let tree = render(), radios = notebookNodes(tree, node => node.props.role === 'radio');
  assert.equal(tree.props.role, 'dialog'); assert.equal(tree.props['aria-modal'], 'true'); assert.equal(tree.props['aria-label'], copy.text('capturePurpose', 'en'));
  assert.equal(notebookNodes(tree, node => node.props.role === 'radiogroup').length, 1);
  assert.deepEqual(radios.map(node => [node.props.children[1], node.props['aria-checked'], node.props.tabIndex]), [['Text', false, -1], ['Area', true, 0], ['Full page', false, -1]]);
  const group = notebookNodes(tree, node => node.props.role === 'radiogroup')[0]; group.props.ref.current = { querySelectorAll: () => [0, 1, 2].map(index => ({ focus: () => focused.push(index) })) };
  const key = (key, shiftKey = false) => ({ key, shiftKey, preventDefault() {}, stopPropagation() {} });
  radios[1].props.onKeyDown(key('ArrowRight')); tree = render(); radios = notebookNodes(tree, node => node.props.role === 'radio');
  assert.equal(radios[2].props['aria-checked'], true); assert.deepEqual(focused, [2]);
  radios[2].props.onKeyDown(key('ArrowLeft')); tree = render();
  tree.props.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 96, width: 1440, height: 804 }) };
  let selection = notebookNodes(tree, node => node.props.className === 'capture-selection')[0]; selection.props.ref.current = { focus() {} };
  selection.props.onKeyDown(key('ArrowRight')); selection.props.onKeyDown(key('ArrowDown', true)); tree = render();
  assert.equal(notebookNodes(tree, node => node.type === 'rect')[0].props.height, 308);
  const event = (x, y) => ({ clientX: x, clientY: y + 96, button: 0, pointerId: 1, target: { closest: () => null }, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} }, preventDefault() {} });
  tree.props.onPointerDown(event(100, 100)); tree.props.onPointerMove(event(500, 300)); tree.props.onPointerUp(event(500, 300)); tree = render();
  let rectangle = notebookNodes(tree, node => node.type === 'rect')[0]; assert.equal(rectangle.props.width, 398); assert.equal(rectangle.props.height, 198); assert.equal(rectangle.props.strokeDasharray, '6 4');
  tree.props.onPointerDown(event(20, 30)); tree.props.onPointerUp(event(20, 30)); tree = render();
  tree.props.onPointerDown(event(120, 90)); tree.props.onPointerUp(event(120, 90)); tree = render();
  rectangle = notebookNodes(tree, node => node.type === 'rect')[0]; assert.equal(rectangle.props.width, 98); assert.equal(rectangle.props.height, 58);
  hooks.dispose();
});

test('new notebook controls have coarse-pointer targets and selected segments retain a contrasting edge', () => {
  const css = readFileSync('src/styles.css', 'utf8'), coarse = css.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/)[1];
  for (const selector of ['.capture-bar .profile-action', '.capture-guidance .text-button', '.capture-segmented button', '.notebook-name-form .profile-action', '.notebook-page .profile-action', '.notebook-first-use .profile-action', '.notebook-toast .text-button', '.notebooks-menu > button', '.notebook-actions-menu > button', '.notebook-resume', '.notebook-list-row', '.notebook-home-row']) {
    assert.ok(coarse.includes(selector)); assert.match(coarse.slice(coarse.indexOf(selector)), /min-height:\s*var\(--target-touch\)/);
  }
  assert.match(css, /\.capture-segmented \[aria-checked=true\]\s*\{[^}]*border-color:\s*var\(--border-control\);[^}]*background:\s*var\(--surface-pressed\)/);
  assert.match(css, /\.capture-overlay \.capture-bar\s*\{[^}]*height:\s*auto/);
  const tokens = readFileSync('src/tokens.css', 'utf8');
  for (const palette of ['amber', 'daylight', 'contrast-dark', 'contrast-light']) assert.match(tokens, new RegExp('--palette-' + palette + '-capture-veil:'));
  assert.match(tokens, /--palette-amber-capture-veil:\s*rgba\(0, 0, 0, 0\.45\)/);
});

test('capture image bytes stay in IPC and blob URLs are revoked on retry, errors, stale responses and unmount', async () => {
  const copy = interfaceModule('src/copy.ts');
  for (const outcome of ['retry', 'unmount', 'stale', 'null', 'error']) {
    const hooks = notebookTestHooks(), created = [], revoked = [], requests = []; let finish;
    const window = { horizon: { getCaptureImage(...args) { requests.push(args); return new Promise(resolve => { finish = resolve; }); } } };
    const { CaptureImage } = interfaceModule('src/NotebookView.tsx', { react: hooks.react, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {}, './Notebooks': {} }, { window, URL: { createObjectURL() { const url = 'blob:private-' + created.length; created.push(url); return url; }, revokeObjectURL: url => revoked.push(url) }, Blob, Uint8Array });
    const render = () => hooks.render(() => CaptureImage({ notebook: 'book', item: { id: 'image', title: 'Capture', image: { cut: false } }, language: 'en' }));
    render(); hooks.flush(); assert.deepEqual(requests, [['book', 'image']]);
    if (outcome === 'stale') hooks.dispose();
    finish(outcome === 'null' ? null : new Uint8Array([1, 2, 3])); await Promise.resolve();
    let tree = render();
    if (outcome === 'stale' || outcome === 'null') { assert.deepEqual(created, []); hooks.dispose(); continue; }
    assert.equal(notebookNodes(tree, node => node.type === 'img')[0].props.src, created[0]);
    if (outcome === 'error' || outcome === 'retry') {
      notebookNodes(tree, node => node.type === 'img')[0].props.onError(); tree = render(); assert.equal(notebookNodes(tree, node => node.props.role === 'alert').length, 1);
      if (outcome === 'retry') { notebookNodes(tree, node => node.type === 'button')[0].props.onClick(); render(); hooks.flush(); finish(new Uint8Array([4])); await Promise.resolve(); render(); assert.equal(created.length, 2); }
    }
    hooks.dispose(); for (const url of created) assert.ok(revoked.includes(url));
  }
});

test('notebook summaries omit text, annotations, image bytes and generated filenames', t => {
  const root = temporaryDirectory(t, 'notebook-summary-interface'), timers = new Map(), { createNotebooks } = timedModule('notebooks', timers);
  const runtime = createNotebooks(join(root, 'notebooks.json'), plainCipher, () => {}), notebook = runtime.create('Research'), item = sampleNotebookItem('text');
  item.text = 'PRIVATE CAPTURE BODY'; item.note = 'PRIVATE ANNOTATION'; runtime.addCapture(notebook.id, item);
  const image = sampleNotebookItem('area'); image.image = null; runtime.addCapture(notebook.id, image, faviconPNG, { width: 1, height: 1, cut: false });
  const summary = runtime.state().notebooks[0]; assert.equal(summary.latest.find(entry => entry.id === item.id).source.url, 'https://example.com/');
  for (const entry of summary.latest) assert.deepEqual(Object.keys(entry).sort(), ['id', 'kind', 'source', 'title']);
  const state = JSON.stringify(runtime.state()); for (const secret of [item.text, item.note, image.image.filename, faviconPNG.toString('base64')]) assert.equal(state.includes(secret), false);
  runtime.dispose();
});

test('debounced notebook edits serialize and flush before switching, retaining failed and newer drafts', async () => {
  const timers = new Map(), sent = [], errors = [];
  const { NotebookEdits } = interfaceModule('src/shared/notebook-edits.ts', {}, { setTimeout(callback) { const timer = {}; timers.set(timer, callback); return timer; }, clearTimeout(timer) { timers.delete(timer); } });
  let finish, fail = false;
  const edits = new NotebookEdits(command => { sent.push(command); if (fail) return Promise.reject(new Error('NOTEBOOK_STORAGE_FAILED')); return new Promise(resolve => { finish = resolve; }); }, reason => errors.push(reason));
  edits.change('book', 'item', { title: 'First' }); edits.change('book', 'item', { text: 'Draft' }); assert.equal(timers.size, 1);
  const first = edits.flush(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sent[0], { type: 'update-notebook-item', notebook: 'book', id: 'item', title: 'First', text: 'Draft' });
  edits.change('book', 'item', { title: 'Latest' }); finish(); await Promise.resolve(); await Promise.resolve();
  assert.equal(sent[1].title, 'Latest'); finish(); await first; assert.deepEqual(edits.fields('book', 'item'), {});
  fail = true; edits.change('book', 'item', { note: 'Kept on failure' }); await assert.rejects(edits.flush(), /NOTEBOOK_STORAGE_FAILED/);
  assert.equal(edits.fields('book', 'item').note, 'Kept on failure');
  fail = false; const retry = edits.flush(); await Promise.resolve(); await Promise.resolve(); finish(); await retry;
  assert.deepEqual(edits.fields('book', 'item'), {}); assert.equal(timers.size, 0); assert.deepEqual(errors, []);
});

test('notebook home metadata uses actual counts, calendar-relative dates and each named error has distinct bilingual copy', () => {
  const copy = interfaceModule('src/copy.ts'), helpers = interfaceModule('src/Notebooks.tsx', { react: {}, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {} });
  const now = new Date(2026, 9, 2, 0, 5).getTime(), yesterday = new Date(2026, 9, 1, 23, 55).getTime();
  assert.equal(helpers.notebookResumeMeta({ notes: 6, captures: 0, updatedAt: yesterday }, 'en', now), '6 notes, yesterday');
  assert.equal(helpers.notebookResumeMeta({ notes: 1, captures: 3, updatedAt: now }, 'en', now), '1 note and 3 captures, today');
  for (const language of ['en', 'es']) {
    const labels = Object.keys(copy.copy).filter(key => /^(NOTEBOOK_|CAPTURE_|NOTHING_SELECTED)/.test(key)).map(key => helpers.notebookError(new Error("Error invoking command: " + key), language));
    assert.equal(labels.length, 20); assert.equal(new Set(labels).size, 20); assert.ok(labels.every(label => label.length > 10));
  }
});

test('notebook chooser orders last use after the current notebook, preselects it and starts with a labelled form on first use', () => {
  const copy = interfaceModule('src/copy.ts'), hooks = notebookTestHooks();
  const module = interfaceModule('src/Notebooks.tsx', { react: hooks.react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': { Menu: 'menu' } });
  const chosen = [], state = { notebookInUse: 'current', notebooks: [{ id: 'older', name: 'Older', notes: 0, captures: 2, usedAt: 1 }, { id: 'latest', name: 'Latest', notes: 2, captures: 0, usedAt: 3 }, { id: 'current', name: 'Current', notes: 1, captures: 1, usedAt: 2 }] };
  const tree = hooks.render(() => module.NotebookPicker({ state, language: 'en', opener: { current: null }, onClose() {}, onChoose: notebook => chosen.push(notebook.id), choosing: true }));
  const rows = notebookNodes(tree, node => node.props.role === 'menuitemradio');
  assert.deepEqual(rows.map(row => row.props.children[1].props.children[0].props.children), ['Current', 'Latest', 'Older']);
  assert.deepEqual(rows.map(row => row.props['aria-checked']), [true, false, false]); rows[0].props.onClick(); assert.deepEqual(chosen, ['current']);
  const emptyHooks = notebookTestHooks(), emptyModule = interfaceModule('src/Notebooks.tsx', { react: emptyHooks.react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {} });
  const first = emptyHooks.render(() => emptyModule.NotebookPicker({ state: { notebooks: [], notebookInUse: null }, language: 'en', opener: { current: null }, onClose() {}, onChoose() {} }));
  assert.equal(notebookNodes(first, node => node.type === emptyModule.NotebookNameForm).length, 1);
  const formHooks = notebookTestHooks(), forms = interfaceModule('src/Notebooks.tsx', { react: formHooks.react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {} });
  const form = formHooks.render(() => forms.NotebookNameForm({ language: 'en', onCancel() {}, onSuccess() {} }));
  const label = notebookNodes(form, node => node.type === 'label')[0], input = notebookNodes(form, node => node.type === 'input')[0];
  assert.equal(label.props.htmlFor, input.props.id); assert.equal(label.props.children, 'Notebook name');
});

test('saved status exists before the first save and pauses its remaining duration on hover and focus', () => {
  const copy = interfaceModule('src/copy.ts'), hooks = notebookTestHooks(), timers = new Map(); let now = 0, closed = 0;
  const window = { setTimeout(callback, delay) { const timer = {}; timers.set(timer, { callback, delay }); return timer; }, clearTimeout(timer) { timers.delete(timer); } };
  const module = interfaceModule('src/Notebooks.tsx', { react: hooks.react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {} }, { window, Date: { now: () => now } });
  const onClose = () => closed++, notice = { message: 'Saved to Research', action: 'Open', onAction() {} };
  const render = value => hooks.render(() => module.NotebookStatus({ notice: value, language: 'en', onClose }));
  const empty = render(null); hooks.flush(); assert.equal(empty.props.role, 'status'); assert.equal(timers.size, 0);
  let tree = render(notice); hooks.flush(); assert.equal([...timers.values()][0].delay, 8000);
  now = 2000; notebookNodes(tree, node => node.props.className === 'notebook-toast')[0].props.onMouseEnter(); tree = render(notice); hooks.flush(); assert.equal(timers.size, 0);
  now = 10000; notebookNodes(tree, node => node.props.className === 'notebook-toast')[0].props.onMouseLeave(); tree = render(notice); hooks.flush(); assert.equal([...timers.values()][0].delay, 6000);
  now = 11000; const toast = notebookNodes(tree, node => node.props.className === 'notebook-toast')[0]; toast.props.onFocus(); tree = render(notice); hooks.flush(); assert.equal(timers.size, 0);
  notebookNodes(tree, node => node.props.className === 'notebook-toast')[0].props.onMouseEnter(); tree = render(notice); hooks.flush();
  notebookNodes(tree, node => node.props.className === 'notebook-toast')[0].props.onMouseLeave(); tree = render(notice); hooks.flush(); assert.equal(timers.size, 0, 'Leaving hover does not resume a focused message');
  notebookNodes(tree, node => node.props.className === 'notebook-toast')[0].props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); render(notice); hooks.flush();
  assert.equal([...timers.values()][0].delay, 5000); [...timers.values()][0].callback(); assert.equal(closed, 1); hooks.dispose();
});

test('full-page capture waits for visible content; save results respect closed and newly opened bars', async () => {
  const { compileFunction } = require('node:vm'), ts = require('typescript'), copy = interfaceModule('src/copy.ts');
  const source = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer; const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'saveNotebookCapture') initializer = node.initializer; ts.forEachChild(node, visit); }; visit(source); assert.ok(initializer);
  const compiled = ts.transpileModule(`export const save = ${initializer.getText(source)};`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  for (const kind of ['page', 'text', 'area']) for (const failure of [false, true]) for (const reopened of [false, true]) {
    const events = [], notices = [], exported = {}; let visible;
    const overlay = { scope: 'scope', mode: 'capture' }, liveOverlay = { current: overlay }, nextOverlay = { scope: 'scope', mode: 'capture' };
    const globals = {
      state: { notebookLocked: false }, notebookScope: 'scope', liveNotebookScope: { current: 'scope' }, notebookOverlay: overlay, liveNotebookOverlay: liveOverlay, edits: { flush: async () => events.push('flush') },
      setPageCapturePending: value => events.push('pending:' + value), setNotebookOverlay: value => { assert.equal(value, null); liveOverlay.current = value; events.push('closed'); },
      setMenuOpen() {}, setProfileOpen() {}, setHubPage() {}, setLyraOpen() {}, setShieldScope() {}, setSuggestionsOpen() {}, setPanel() {},
      requestAnimationFrame: callback => queueMicrotask(callback), reportArea: hidden => { assert.equal(hidden, false); events.push('visible'); return new Promise(resolve => { visible = resolve; }); },
      window: { horizon: { async command(command) { events.push('capture'); assert.equal(command.kind, kind); if (kind === 'area') assert.deepEqual(command.rect, { x: 1, y: 2, width: 300, height: 200 }); if (reopened) liveOverlay.current = nextOverlay; if (failure) throw new Error('CAPTURE_FAILED'); }, async getNotebook() { return { items: [{ id: 'saved-item' }] }; } } },
      notebookButtonRef: { current: { focus: () => events.push('focus') } }, setNotebookNotice: value => notices.push(value), language: 'en', text: copy.text, openNotebook() {}, notebookError: reason => reason.message,
    };
    compileFunction(compiled, ['exports', ...Object.keys(globals)])(exported, ...Object.values(globals));
    const work = exported.save({ id: 'book', name: 'Research' }, kind, { x: 1, y: 2, width: 300, height: 200 });
    if (kind === 'page') { for (let tick = 0; tick < 10 && !visible; tick++) await Promise.resolve(); assert.ok(visible); assert.equal(notices[0].message, 'Capturing the page'); assert.equal(notices[0].pending, true); assert.ok(events.indexOf('closed') < events.indexOf('visible')); assert.equal(events.includes('capture'), false); visible(); }
    if (failure && kind !== 'page' && !reopened) { await assert.rejects(work, /CAPTURE_FAILED/); assert.equal(events.includes('closed'), false); assert.deepEqual(notices, []); }
    else { await work; assert.equal(events.filter(event => event === 'capture').length, 1); assert.equal(notices.at(-1).message, failure ? 'CAPTURE_FAILED' : 'Saved to Research'); if (failure) assert.equal(notices.at(-1).action, 'Try again'); }
    if (reopened) { assert.equal(liveOverlay.current, nextOverlay); assert.equal(events.includes('focus'), false); }
  }
});

test('notebook storage Retry writes existing contents without another capture and validates its no-argument command', t => {
  assert.deepEqual(validateCommand({ type: 'retry-notebook-storage' }), { type: 'retry-notebook-storage' });
  assert.throws(() => validateCommand({ type: 'retry-notebook-storage', notebook: randomUUID() }));
  const root = temporaryDirectory(t, 'notebook-storage-retry'), blocked = join(root, 'blocked'); writeFileSync(blocked, 'file');
  const timers = new Map(), { createNotebooks } = timedModule('notebooks', timers), runtime = createNotebooks(join(blocked, 'notebooks.json'), plainCipher, () => {});
  const notebook = runtime.create('Research'); runtime.addNote(notebook.id, 'Draft', 'Keep this text'); runtime.flush();
  assert.equal(runtime.state().notebookStorageError, true); assert.throws(() => runtime.retry(), /NOTEBOOK_STORAGE_FAILED/);
  require('node:fs').unlinkSync(blocked); runtime.retry(); assert.equal(runtime.state().notebookStorageError, false);
  const saved = readNotebookStore(join(blocked, 'notebooks.json')); assert.equal(saved.notebooks[0].items.length, 1); assert.equal(saved.notebooks[0].items[0].text, 'Keep this text'); runtime.dispose();
  const browser = notebookBrowser(t); browser.command({ type: 'create-notebook', name: 'Captures' }); browser.navigate();
  const id = browser.state().notebookInUse;
  return browser.command({ type: 'save-capture', notebook: id, kind: 'text' }).then(() => {
    const before = browser.notebook(id); browser.command({ type: 'retry-notebook-storage' }); assert.deepEqual(browser.notebook(id).items, before.items); browser.close();
  });
});

test('capture guidance stays accessible and hidden while the error and retry remain visible', () => {
  const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts');
  const { CaptureOverlay } = interfaceModule('src/Capture.tsx', { react: hooks.react, 'react-dom': { createPortal: node => node }, 'lucide-react': notebookTestIcons, './copy': copy, './Notebooks': {} }, { document: { body: {} } });
  const render = () => hooks.render(() => CaptureOverlay({ state: { notebookStorageError: true }, language: 'en', header: { current: null }, onClose() {}, onSave() {}, onRetryStorage() {} }));
  let tree = render();
  const selection = notebookNodes(tree, node => node.props.className === 'capture-selection')[0];
  assert.equal(selection.props['aria-describedby'], 'capture-instructions capture-size');
  for (const id of ['capture-instructions', 'capture-size']) assert.equal(notebookNodes(tree, node => node.props.id === id)[0].props.className, 'visually-hidden');
  assert.equal(notebookNodes(tree, node => node.props.id === 'capture-size')[0].props.role, 'status');
  notebookNodes(tree, node => node.props.role === 'radio')[0].props.onClick(); tree = render();
  const hint = notebookNodes(tree, node => node.props.id === 'capture-size')[0];
  assert.equal(hint.props.className, 'visually-hidden'); assert.equal(hint.props.role, 'status'); assert.equal(hint.props.children, copy.text('captureTextHint', 'en'));
  const error = notebookNodes(tree, node => node.props.role === 'alert')[0];
  assert.equal(error.props.className, 'capture-error'); assert.equal(notebookNodes(error, node => node.type === 'button')[0].props.children, 'Try again');
  const css = readFileSync('src/styles.css', 'utf8');
  assert.doesNotMatch(css.match(/\.capture-guidance\s*\{([^}]+)\}/)[1], /background:|padding:|border:|margin-top:/);
  assert.match(css, /\.capture-error\s*\{[^}]*margin-top:[^}]*background:/);
});

test('notebook fields keep labels, read as board typography and grow and shrink with content and column width', async () => {
  const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts'), item = { id: 'item', kind: 'text', title: 'Title', text: 'Text', note: '', createdAt: Date.now() };
  let resized, disconnected = 0;
  const module = interfaceModule('src/NotebookView.tsx', { react: hooks.react, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {}, './Notebooks': { relativeNotebookDate: () => 'today', notebookCounts: () => '1 capture', notebookItemLabel: () => 'example.com' } }, { window: { horizon: { getNotebook: async () => ({ name: 'Book', items: [item] }) } }, ResizeObserver: class { constructor(callback) { resized = callback; } observe() {} disconnect() { disconnected++; } } });
  const render = () => hooks.render(() => module.NotebookView({ id: 'book', language: 'en', edits: {}, onOpen() {}, onDelete() {} }));
  render(); hooks.flush(); await Promise.resolve();
  const editor = notebookNodes(render(), node => typeof node.type === 'function' && node.props.item === item)[0];
  const fieldsHooks = notebookTestHooks(), changes = [];
  Object.assign(hooks.react, fieldsHooks.react);
  const edits = { fields: () => ({}), change: (...args) => changes.push(args) };
  const fields = fieldsHooks.render(() => editor.type({ ...editor.props, edits }));
  const title = notebookNodes(fields, node => node.type === 'input')[0];
  const areas = notebookNodes(fields, node => typeof node.type === 'function');
  for (const field of [title, ...areas]) assert.equal(notebookNodes(fields, node => node.type === 'label' && node.props.htmlFor === field.props.id).length, 1);
  assert.equal(areas[1].props.placeholder, copy.text('captureNotePlaceholder', 'en'));
  title.props.onChange({ target: { value: 'Changed' } }); assert.equal(changes[0][2].title, 'Changed');
  const growHooks = notebookTestHooks(); Object.assign(hooks.react, growHooks.react);
  const grow = value => growHooks.render(() => areas[0].type({ ...areas[0].props, value }));
  const textarea = grow('many lines'), element = { style: {}, scrollHeight: 120, offsetHeight: 26, clientHeight: 24, clientWidth: 400 };
  assert.equal(textarea.props.rows, 1); textarea.props.ref.current = element; growHooks.flush(); assert.equal(element.style.height, '122px');
  element.scrollHeight = 24; grow(''); growHooks.flush(); assert.equal(element.style.height, '26px');
  element.clientWidth = 200; element.scrollHeight = 72; resized(); assert.equal(element.style.height, '74px');
  growHooks.dispose(); assert.equal(disconnected, 2);
  const css = readFileSync('src/styles.css', 'utf8');
  assert.match(css, /\.notebook-item-title\s*\{[^}]*font-size: var\(--type-notebook-title\);[^}]*font-weight: var\(--weight-heading\);[^}]*color: var\(--text-title\)/);
  assert.match(css, /\.notebook-editor-field textarea\s*\{[^}]*font-size: var\(--type-body\);[^}]*color: var\(--text-primary\)/);
  assert.match(css, /\.notebook-item-title, \.notebook-editor-field textarea\s*\{[^}]*border-bottom-color: var\(--border-control\);[^}]*background: var\(--surface-transparent\)/);
  assert.match(css, /\.notebook-item-title:hover, \.notebook-item-title:focus, \.notebook-editor-field textarea:hover, \.notebook-editor-field textarea:focus\s*\{ border-color: var\(--border-control\)/);
  assert.doesNotMatch(css, /min-height: var\(--height-notebook-(?:text|annotation)\)/);
});

test('capture images use natural pixels divided by display scale and keep column bounds, proportions and radius', async () => {
  for (const scale of [1, 1.25, 2]) {
    const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts');
    const { CaptureImage } = interfaceModule('src/NotebookView.tsx', { react: hooks.react, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {}, './Notebooks': {} }, { window: { devicePixelRatio: scale, horizon: { getCaptureImage: async () => new Uint8Array([1]) } }, URL: { createObjectURL: () => 'blob:image', revokeObjectURL() {} }, Blob, Uint8Array });
    const render = () => hooks.render(() => CaptureImage({ notebook: 'book', item: { id: 'item', title: 'Capture' }, language: 'en' }));
    render(); hooks.flush(); await Promise.resolve();
    const image = notebookNodes(render(), node => node.type === 'img')[0], element = { naturalWidth: 500 * scale, naturalHeight: 220 * scale, style: {} };
    image.props.onLoad({ currentTarget: element }); assert.equal(element.style.width, '500px'); hooks.dispose();
  }
  assert.match(readFileSync('src/styles.css', 'utf8'), /\.notebook-capture img\s*\{[^}]*max-width: 100%;[^}]*height: auto;[^}]*border-radius: var\(--radius-panel\)/);
});

test('area arrows move and Shift resizes by ten, Alt uses one, and all edges stay bounded', async () => {
  const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts'), saved = [];
  const { CaptureOverlay } = interfaceModule('src/Capture.tsx', { react: hooks.react, 'react-dom': { createPortal: node => node }, 'lucide-react': notebookTestIcons, './copy': copy, './Notebooks': { NotebookPicker: 'picker' } }, { document: { body: {} } });
  const render = () => hooks.render(() => CaptureOverlay({ state: {}, language: 'en', header: { current: null }, onClose() {}, onSave: async (_book, _kind, rect) => saved.push(rect) }));
  let tree = render(); tree.props.ref.current = { getBoundingClientRect: () => ({ width: 1440, height: 804 }) };
  const press = async (key, shiftKey = false, altKey = false, count = 1) => {
    for (let i = 0; i < count; i++) notebookNodes(tree, node => node.props.className === 'capture-selection')[0].props.onKeyDown({ key, shiftKey, altKey, preventDefault() {}, stopPropagation() {} });
    tree = render(); notebookNodes(tree, node => node.props.className?.includes('capture-save'))[0].props.onClick(); tree = render();
    await notebookNodes(tree, node => node.type === 'picker')[0].props.onChoose({ id: 'book' }); tree = render(); return saved.at(-1);
  };
  assert.deepEqual(await press('ArrowRight'), { x: 320, y: 262, width: 820, height: 300 });
  assert.deepEqual(await press('ArrowDown', true), { x: 320, y: 262, width: 820, height: 310 });
  assert.equal((await press('ArrowLeft', false, true)).x, 319);
  assert.equal((await press('ArrowUp', true, true)).height, 309);
  assert.equal((await press('ArrowLeft', false, false, 100)).x, 0);
  assert.equal((await press('ArrowUp', false, false, 100)).y, 0);
  assert.equal((await press('ArrowRight', true, false, 200)).width, 1440);
  assert.equal((await press('ArrowDown', true, false, 100)).height, 804);
  assert.equal((await press('ArrowLeft', true, false, 200)).width, 1);
  assert.equal((await press('ArrowUp', true, false, 100)).height, 1);
  assert.equal((await press('ArrowRight', false, false, 200)).x, 1439);
  assert.equal((await press('ArrowDown', false, false, 100)).y, 803);
  for (const language of ['en', 'es']) { const instructions = copy.text('captureInstructions', language); assert.match(instructions, /10/); assert.match(instructions, /1 /); assert.match(instructions, /Alt/); }
});

test('run D: locked notebooks refuse every creation, preserve originals and reopen after encryption returns', t => {
  const root = temporaryDirectory(t, 'notebook-locked-d'), path = join(root, 'notebooks.json'), timers = new Map();
  const cipher = authenticatedCipher(), stored = sampleNotebookStore(); writeNotebookStore(path, stored, cipher);
  const bytes = readFileSync(path); let available = false;
  const { createNotebooks } = timedModule('notebooks', timers);
  const runtime = createNotebooks(path, { ...cipher, isEncryptionAvailable: () => available }, () => {});
  assert.equal(runtime.state().notebookLocked, true); assert.equal(runtime.state().notebookReadError, false);
  assert.throws(() => runtime.create('Blocked'), /NOTEBOOK_LOCKED/);
  assert.throws(() => runtime.addNote(stored.notebooks[0].id, '', ''), /NOTEBOOK_LOCKED/);
  assert.throws(() => runtime.addCapture(stored.notebooks[0].id, sampleNotebookItem('text')), /NOTEBOOK_LOCKED/);
  assert.deepEqual(readFileSync(path), bytes); assert.equal(timers.size, 0);
  available = true; runtime.retry(); assert.equal(runtime.state().notebookLocked, false);
  assert.equal(runtime.content(stored.notebooks[0].id).items.length, stored.notebooks[0].items.length); runtime.dispose();
  const app = readFileSync('src/App.tsx', 'utf8');
  assert.match(app, /setDismissedNotebookRead\(state.activeProfileId\)/);
  assert.match(app, /state\?\.notebookLocked \? 'NOTEBOOK_LOCKED'/);
  for (const language of ['en', 'es']) assert.ok(interfaceModule('src/copy.ts').text('NOTEBOOK_LOCKED', language));
});

test('run D: notebook loading has list and detail placeholders and images reserve stored proportions before arrival', () => {
  const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts'), styles = {};
  const module = interfaceModule('src/NotebookView.tsx', { react: hooks.react, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {}, './Notebooks': {} }, { window: { devicePixelRatio: 2, horizon: { getCaptureImage: () => new Promise(() => {}) } } });
  const tree = hooks.render(() => module.CaptureImage({ notebook: 'book', item: { id: 'image', title: '', image: { width: 1000, height: 440 } }, language: 'en' }));
  notebookNodes(tree, node => node.props.className === 'notebook-image-box')[0].props.ref.current = { style: { setProperty: (name, value) => { styles[name] = value; } } };
  hooks.flush(); assert.deepEqual(styles, { width: '500px', 'aspect-ratio': '1000 / 440' });
  assert.equal(notebookNodes(tree, node => node.type === 'LoaderCircle').length, 0); hooks.dispose();
  const loadingHooks = notebookTestHooks();
  const view = interfaceModule('src/NotebookView.tsx', { react: loadingHooks.react, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {}, './Notebooks': {} });
  const placeholder = loadingHooks.render(() => view.NotebookView({ id: 'book', selected: null, version: 0, language: 'en', edits: {}, readOnly: false }));
  assert.equal(notebookNodes(placeholder, node => node.type === 'li').length, 5);
  assert.equal(notebookNodes(placeholder, node => node.props.className === 'notebook-skeleton skeleton-title').length, 2);
  assert.equal(notebookNodes(placeholder, node => node.props.className === 'notebook-skeleton skeleton-line').length, 4);
});

test('run D: both notebook pickers filter above eight and offer the typed name with no results', () => {
  for (const choosing of [false, true]) {
    const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts');
    const module = interfaceModule('src/Notebooks.tsx', { react: hooks.react, 'react-dom': { createPortal: node => node }, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': { Menu: 'menu' } });
    const state = { activeProfileId: 'profile', notebooks: Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: `Book ${i}`, notes: 0, captures: 0, usedAt: i })), notebookInUse: '0' };
    const render = () => hooks.render(() => module.NotebookPicker({ state, language: 'en', choosing, opener: { current: null }, onClose() {}, onChoose() {} }));
    let tree = render(), input = notebookNodes(tree, node => node.type === 'input')[0];
    assert.equal(notebookNodes(tree, node => node.type === 'label')[0].props.htmlFor, input.props.id);
    input.props.onChange({ target: { value: 'bOoK 3' } }); tree = render();
    assert.equal(notebookNodes(tree, node => node.props.role === 'menuitemradio').length, 1);
    notebookNodes(tree, node => node.type === 'input')[0].props.onChange({ target: { value: 'Travel' } }); tree = render();
    assert.equal(notebookNodes(tree, node => node.props.role === 'menuitemradio').length, 0);
    assert.equal(notebookNodes(tree, node => node.props.role === 'status').length, 1);
    const create = notebookNodes(tree, node => node.props.role === 'menuitem')[0]; assert.equal(create.props.children[1].props.children, 'New notebook: Travel'); create.props.onClick();
    tree = render(); assert.equal(notebookNodes(tree, node => node.type === module.NotebookNameForm)[0].props.initial, 'Travel');
    const smallHooks = notebookTestHooks(); const small = interfaceModule('src/Notebooks.tsx', { react: smallHooks.react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': { Menu: 'menu' } });
    assert.equal(notebookNodes(smallHooks.render(() => small.NotebookPicker({ state: { ...state, notebooks: state.notebooks.slice(0, 8) }, language: 'en', opener: { current: null } })), node => node.type === 'input').length, 0);
  }
});

test('run D: cancelled and escaped notebook names survive remount, until cleared or submitted', async () => {
  let activeHooks = notebookTestHooks(), cancelled = 0;
  const react = Object.fromEntries(Object.keys(activeHooks.react).map(key => [key, (...args) => activeHooks.react[key](...args)]));
  const copy = interfaceModule('src/copy.ts'), sent = [];
  const module = interfaceModule('src/Notebooks.tsx', { react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {} }, { window: { horizon: { command: async command => { sent.push(command); }, getState: async () => ({ notebooks: [{ id: 'saved', name: 'Submitted' }] }) } } });
  const render = () => activeHooks.render(() => module.NotebookNameForm({ language: 'en', profileId: 'draft', onCancel: () => { cancelled++; }, onSuccess() {} }));
  let tree = render(); notebookNodes(tree, node => node.type === 'input')[0].props.onChange({ target: { value: 'Kept' } }); tree = render();
  tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(cancelled, 1);
  activeHooks = notebookTestHooks(); tree = render(); assert.equal(notebookNodes(tree, node => node.type === 'input')[0].props.value, 'Kept');
  notebookNodes(tree, node => node.type === 'button' && node.props.children === 'Cancel')[0].props.onClick();
  activeHooks = notebookTestHooks(); tree = render(); assert.equal(notebookNodes(tree, node => node.type === 'input')[0].props.value, 'Kept');
  notebookNodes(tree, node => node.type === 'button' && node.props.children === 'Clear')[0].props.onClick();
  activeHooks = notebookTestHooks(); tree = render(); assert.equal(notebookNodes(tree, node => node.type === 'input')[0].props.value, '');
  notebookNodes(tree, node => node.type === 'input')[0].props.onChange({ target: { value: 'Submitted' } }); tree = render(); tree.props.onSubmit({ preventDefault() {} });
  for (let i = 0; i < 8; i++) await Promise.resolve(); assert.equal(sent[0].name, 'Submitted');
  activeHooks = notebookTestHooks(); assert.equal(notebookNodes(render(), node => node.type === 'input')[0].props.value, '');
});

test('run D: notebook and start-page rows distinguish text, area, whole page and notes in both languages', async () => {
  const copy = interfaceModule('src/copy.ts');
  for (const language of ['en', 'es']) {
    const hooks = notebookTestHooks();
    const notebooks = interfaceModule('src/Notebooks.tsx', { react: hooks.react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {} });
    const items = ['text', 'area', 'page', 'note'].map((kind, i) => ({ id: String(i), kind, title: 'Same title', source: kind === 'note' ? null : { url: 'https://example.com/path' } }));
    const expected = ['example.com', copy.text('sourceCapture', language), copy.text('sourceFullPage', language), copy.text('sourceNote', language)];
    assert.deepEqual(items.map(item => notebooks.notebookItemLabel(item, language)), expected);
    const home = hooks.render(() => notebooks.NotebookHome({ state: { notebooks: [{ id: 'book', name: 'Book', latest: items, notes: 1, captures: 3, updatedAt: Date.now() }] }, language }));
    const rows = notebookNodes(home, node => node.props.className === 'notebook-home-row');
    assert.deepEqual(rows.map(row => row.props.children[0].type), ['FileText', 'Camera', 'Camera', 'FileText']);
    assert.deepEqual(rows.map(row => row.props.children[2].props.children), expected);
    const viewHooks = notebookTestHooks();
    const view = interfaceModule('src/NotebookView.tsx', { react: viewHooks.react, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {}, './Notebooks': notebooks }, { window: { horizon: { getNotebook: async () => ({ name: 'Book', items }) } } });
    const render = () => viewHooks.render(() => view.NotebookView({ id: 'book', language, edits: {}, readOnly: false })); render(); viewHooks.flush(); await Promise.resolve(); await Promise.resolve();
    const list = notebookNodes(render(), node => node.props.className?.startsWith('notebook-list-row'));
    assert.deepEqual(list.map(row => row.props.children[0].type), ['FileText', 'Camera', 'Camera', 'FileText']);
    assert.deepEqual(list.map(row => row.props.children[2].props.children), expected);
  }
});

test('run D: saving keeps its label with a spinner and page progress persists until replaced', async () => {
  const hooks = notebookTestHooks(), copy = interfaceModule('src/copy.ts'); let complete;
  const module = interfaceModule('src/Capture.tsx', { react: hooks.react, 'react-dom': { createPortal: node => node }, 'lucide-react': notebookTestIcons, './copy': copy, './Notebooks': { NotebookPicker: 'picker', notebookError: reason => reason.message } }, { document: { body: {} } });
  const render = () => hooks.render(() => module.CaptureOverlay({ state: { notebooks: [] }, language: 'en', header: { current: null }, onSave: () => new Promise(resolve => { complete = resolve; }), onClose() {} }));
  let tree = render(); notebookNodes(tree, node => node.props.className === 'profile-action primary capture-save')[0].props.onClick(); tree = render();
  const saving = notebookNodes(tree, node => node.type === 'picker')[0].props.onChoose({ id: 'book', name: 'Book' }); tree = render();
  const button = notebookNodes(tree, node => node.props.className === 'profile-action primary capture-save')[0];
  assert.equal(button.props.children[1], 'Save to notebook'); assert.equal(button.props.children[0].type, 'LoaderCircle'); assert.equal(button.props.disabled, true); complete(); await saving;
  const statusHooks = notebookTestHooks(), timers = [];
  const notebooks = interfaceModule('src/Notebooks.tsx', { react: statusHooks.react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {} }, { window: { setTimeout: fn => timers.push(fn), clearTimeout() {} } });
  const status = statusHooks.render(() => notebooks.NotebookStatus({ notice: { message: copy.text('capturingPage', 'en'), pending: true }, language: 'en', onClose() {} })); statusHooks.flush();
  assert.equal(status.props.role, 'status'); assert.equal(timers.length, 0); assert.equal(notebookNodes(status, node => node.type === 'button').length, 0);
  assert.match(readFileSync('src/App.tsx', 'utf8'), /setNotebookNotice\(\{ message: text\('capturingPage', language\), pending: true \}\)/);
});

test('run D: shared notebook and profile name inputs use sixteen pixels with unchanged dimensions', () => {
  const css = readFileSync('src/styles.css', 'utf8'), tokens = readFileSync('src/tokens.css', 'utf8');
  assert.match(css, /\.profile-form > input \{[^}]*height: var\(--height-profile-field\);[^}]*font-size: var\(--type-name-field\)/);
  assert.match(tokens, /--type-name-field: var\(--font-16\)/);
  assert.match(tokens, /--font-16: 1rem/);
});

test('run D: locked creation and capture explain refusal in place before sending commands', () => {
  const copy = interfaceModule('src/copy.ts'), hooks = notebookTestHooks(); let commands = 0;
  const notebooks = interfaceModule('src/Notebooks.tsx', { react: hooks.react, 'react-dom': {}, 'lucide-react': notebookTestIcons, './copy': copy, './Menu': {} }, { window: { horizon: { command() { commands++; } } } });
  const render = () => hooks.render(() => notebooks.NotebookNameForm({ language: 'es', profileId: 'locked', locked: true, onCancel() {}, onSuccess() {} }));
  let tree = render(); notebookNodes(tree, node => node.type === 'input')[0].props.onChange({ target: { value: 'Research' } }); tree = render(); tree.props.onSubmit({ preventDefault() {} });
  assert.equal(commands, 0); assert.equal(notebookNodes(render(), node => node.props.role === 'alert')[0].props.children[1], copy.text('NOTEBOOK_LOCKED', 'es'));
  const captureHooks = notebookTestHooks();
  const capture = interfaceModule('src/Capture.tsx', { react: captureHooks.react, 'react-dom': { createPortal: node => node }, 'lucide-react': notebookTestIcons, './copy': copy, './Notebooks': { NotebookPicker: 'picker' } }, { document: { body: {} } });
  const captureRender = () => captureHooks.render(() => capture.CaptureOverlay({ state: { notebookLocked: true }, language: 'en', header: { current: null }, onSave() { commands++; }, onClose() {} }));
  tree = captureRender(); notebookNodes(tree, node => node.props.className === 'profile-action primary capture-save')[0].props.onClick(); tree = captureRender();
  assert.equal(commands, 0); assert.equal(notebookNodes(tree, node => node.type === 'picker').length, 0);
  assert.equal(notebookNodes(tree, node => node.props.role === 'alert')[0].props.children[0].props.children, copy.text('NOTEBOOK_LOCKED', 'en'));
});
test('settings v4 validates every new field and migrates v2 without losing appearance', t => {
  const directory = temporaryDirectory(t, 'settings-v3'), path = join(directory, 'settings.json');
  const defaults = readSettings(path);
  assert.equal(defaults.version, 4);
  for (const [key, bad] of [['searchEngine', 'unknown'], ['language', 'fr'], ['downloadsFolder', 'relative'], ['askWhereToSave', 1], ['blockAds', null], ['blockThirdPartyCookies', 'false']]) {
    assert.equal(validateSettings({ ...defaults, [key]: bad }), false);
    const missing = { ...defaults }; delete missing[key]; assert.equal(validateSettings(missing), false);
  }
  const legacy = { version: 2, theme: 'daylight', contrast: 'high', darkPages: 'on', darkStrength: 'deep', darkTone: 'warm' };
  writeFileSync(path, JSON.stringify(legacy));
  assert.deepEqual(readSettings(path), { ...defaults, ...legacy, version: 4 });
  assert.equal(JSON.parse(readFileSync(path)).version, 4);
  const { compileFunction } = require('node:vm'), filename = resolve('dist/electron/settings.js'), localRequire = require('node:module').createRequire(filename), exported = {};
  writeFileSync(path, JSON.stringify(legacy));
  compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require'])(exported, name => name === 'node:fs' ? { ...require(name), renameSync() { throw new Error('Read-only'); } } : localRequire(name));
  assert.deepEqual(exported.readSettings(path), { ...defaults, ...legacy, version: 4 });
  assert.equal(JSON.parse(readFileSync(path)).version, 2);
});

test('downloads folder validation refuses relative, linked, controlled and unavailable choices while preserving settings', t => {
  const directory = temporaryDirectory(t, 'settings-folder'), path = join(directory, 'settings.json'), chosen = join(directory, 'chosen');
  mkdirSync(chosen);
  const { isDownloadsFolder, resolvedDownloadsFolder } = require('../dist/electron/settings.js');
  const settings = createSettings(path, () => {});
  settings.setTheme('amber', false); settings.setDownloadsFolder(chosen);
  assert.equal(isDownloadsFolder(chosen), true);
  const link = join(directory, 'linked'); symlinkSync(chosen, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const value of ['relative', 'C:relative', '\\root-relative', chosen + '\n', chosen + '\u0085', chosen + 'x'.repeat(1025), join(directory, 'missing'), link]) {
    assert.equal(isDownloadsFolder(value), false);
    assert.throws(() => settings.setDownloadsFolder(value), /DOWNLOADS_FOLDER_INVALID/);
    assert.equal(validateSettings({ ...readSettings(path), downloadsFolder: value }), false);
    assert.throws(() => writeSettings(path, { ...readSettings(path), downloadsFolder: value }));
  }
  require('node:fs').rmdirSync(chosen);
  assert.deepEqual(resolvedDownloadsFolder(settings, directory), { downloadsFolder: directory, downloadsFolderDefault: true, downloadsFolderUnavailable: true });
  const original = readFileSync(path), reopened = createSettings(path, () => {});
  assert.equal(reopened.theme, 'amber'); assert.equal(reopened.downloadsFolder, null); assert.equal(reopened.downloadsFolderUnavailable, true);
  assert.deepEqual(readFileSync(path), original); assert.equal(readdirSync(directory).some(name => name.includes('corrupt')), false);
  settings.setSearchEngine('brave'); assert.equal(settings.downloadsFolder, null); assert.equal(settings.downloadsFolderUnavailable, true);
  reopened.setDownloadsFolder(null); assert.equal(reopened.downloadsFolderUnavailable, false);
});

test('settings commands have exact shapes, named failures and all engine prefixes and language resolutions', () => {
  const { SEARCH_ENGINES } = require('../dist/src/shared/api.js'), { resolveLanguage } = require('../dist/electron/settings.js');
  const { settingsAddress, settingsSection } = require('../dist/electron/browsing.js');
  for (const section of ['general', 'appearance', 'privacy', 'privacy/sites', 'profiles']) assert.equal(settingsSection(settingsAddress(section)), section);
  const commands = [
    ...['general', 'appearance', 'privacy', 'privacy/sites', 'profiles'].map(section => ({ type: 'open-settings', section })),
    ...Object.keys(SEARCH_ENGINES).map(value => ({ type: 'set-search-engine', value })),
    ...['system', 'en', 'es'].map(value => ({ type: 'set-language', value })),
    ...['set-ask-where-to-save', 'set-block-ads', 'set-block-third-party-cookies', 'set-clear-history-on-close', 'set-clear-cache-on-close'].flatMap(type => [true, false].map(value => ({ type, value }))),
    ...['choose-downloads-folder', 'reset-downloads-folder', 'register-default-browser'].map(type => ({ type })),
    { type: 'reset-site', host: 'example.com' }, { type: 'clear-browsing-data', history: true, cookies: false, cache: false },
  ];
  for (const command of commands) {
    assert.deepEqual(validateCommand(command), command);
    assert.throws(() => validateCommand({ ...command, extra: 1 }), /SETTINGS_COMMAND_INVALID/);
    for (const key of Object.keys(command).filter(key => key !== 'type')) {
      const missing = { ...command }; delete missing[key]; assert.throws(() => validateCommand(missing), /SETTINGS_COMMAND_INVALID/);
      assert.throws(() => validateCommand({ ...command, [key]: null }), /SETTINGS_COMMAND_INVALID/);
    }
  }
  for (const command of [{ type: 'open-settings', section: 'privacy/' }, { type: 'set-search-engine', value: '__proto__' }, { type: 'set-language', value: 'EN' }, { type: 'clear-browsing-data', history: false, cookies: false, cache: false }, { type: 'reset-site', host: 'EXAMPLE.com' }, { type: 'reset-site', host: 'example.com:443' }]) assert.throws(() => validateCommand(command), /SETTINGS_COMMAND_INVALID/);
  const prefixes = { duckduckgo: 'https://duckduckgo.com/?q=', startpage: 'https://www.startpage.com/sp/search?query=', brave: 'https://search.brave.com/search?q=', ecosia: 'https://www.ecosia.org/search?q=', bing: 'https://www.bing.com/search?q=', google: 'https://www.google.com/search?q=' };
  for (const [engine, prefix] of Object.entries(prefixes)) assert.equal(classifyInput('bread & butter', engine), prefix + 'bread%20%26%20butter');
  assert.equal(resolveLanguage('system', 'es-AR'), 'es'); assert.equal(resolveLanguage('system', 'fr-FR'), 'en');
  assert.equal(resolveLanguage('en', 'es-AR'), 'en'); assert.equal(resolveLanguage('es', 'en-US'), 'es');
});

test('store v4 strictly validates profile close flags and preserves version 3 data on migration', t => {
  const directory = temporaryDirectory(t, 'store-v4'), path = join(directory, 'store.json'), sample = sampleStore(directory);
  for (const flag of ['clearHistoryOnClose', 'clearCacheOnClose']) {
    for (const value of [null, 1, 'false', undefined]) assert.equal(validateStore({ ...sample, [flag]: value }), false);
    const missing = { ...sample }; delete missing[flag]; assert.equal(validateStore(missing), false);
  }
  const legacy = { ...sample, version: 3 }; delete legacy.clearHistoryOnClose; delete legacy.clearCacheOnClose;
  writeFileSync(path, JSON.stringify(legacy));
  assert.deepEqual(readStore(path), sample); assert.equal(JSON.parse(readFileSync(path)).version, 4);
});

test('sites list preserves explicit dark choices and per-origin permissions; reset clears every host origin', () => {
  const { listSites, resetSite } = require('../dist/electron/site-settings.js');
  const store = { blocking: [{ host: 'example.com', enabled: false }, { host: 'normal.com', enabled: true }], dark: [{ host: 'example.com', enabled: true }, { host: 'dark.com', enabled: false }],
    permissions: [{ origin: 'https://example.com:8443', ...defaultPermissions(), camera: 'allow' }, { origin: 'http://example.com', ...defaultPermissions(), notifications: 'block' }, { origin: 'https://normal.com', ...defaultPermissions() }] };
  const sites = listSites(store);
  assert.equal(sites.length, 3);
  assert.deepEqual(sites.find(entry => entry.host === 'dark.com'), { host: 'dark.com', origin: 'https://dark.com', blocking: null, dark: false, permissions: defaultPermissions() });
  assert.equal(sites.filter(entry => entry.host === 'example.com').every(entry => entry.dark === true && entry.blocking === false), true);
  resetSite(store, 'example.com');
  assert.deepEqual(store.blocking, [{ host: 'normal.com', enabled: true }]); assert.deepEqual(store.permissions, [{ origin: 'https://normal.com', ...defaultPermissions() }]);
  assert.deepEqual(listSites(store).map(entry => entry.host), ['dark.com']);
});

test('settings tabs reuse one tab after the active page, retain profile memory and refuse address variants', t => {
  const browser = notebookBrowser(t), { command, state, views } = browser;
  browser.navigate(); const original = state().activeId;
  command({ type: 'new-tab' }); const blank = state().activeId; command({ type: 'activate-tab', id: original });
  command({ type: 'open-settings', section: 'general' }); const settings = state().activeId;
  assert.deepEqual(state().tabs.map(tab => tab.id), [original, settings, blank]); assert.equal(views.length, 1);
  assert.equal(state().tabs[1].url, 'horizon://settings'); assert.equal(state().tabs[1].settings, 'general'); assert.equal(state().siteSettings, null);
  assert.equal(state().tabs[1].favicon, null); assert.deepEqual(state().tabs[1].blocked, { ads: 0, trackers: 0, cookies: 0 });
  command({ type: 'navigate', input: 'horizon://settings/privacy/sites' }); assert.equal(state().activeId, settings); assert.equal(state().tabs[1].settings, 'privacy/sites');
  for (const input of ['horizon://settings/', 'horizon://settings/general', 'horizon://settings?x', 'horizon://settings/privacy#x', 'horizon://other']) assert.throws(() => command({ type: 'navigate', input }));
  assert.equal(state().store.history.length, 1);
  const profile = state().activeProfileId, other = state().profiles.find(entry => entry.id !== profile);
  command({ type: 'switch-profile', id: other.id }); command({ type: 'open-settings', section: 'profiles' }); assert.notEqual(state().activeId, settings);
  command({ type: 'switch-profile', id: profile }); assert.equal(state().activeId, settings);
  command({ type: 'navigate', input: 'example.org' }); assert.equal(state().tabs.find(tab => tab.id === settings).settings, null); assert.equal(views.length, 2);
  command({ type: 'open-settings', section: 'appearance' });
  for (let index = state().tabs.length; index < 200; index++) command({ type: 'new-tab' });
  const settingsTab = state().tabs.find(tab => tab.settings); command({ type: 'close-tab', id: settingsTab.id }); command({ type: 'new-tab' });
  assert.throws(() => command({ type: 'open-settings', section: 'general' }), /SETTINGS_TAB_LIMIT/);
});

test('app settings publish immediately and folder chooser is parented, canceled safely and reports picker errors', async t => {
  const options = {}, browser = notebookBrowser(t, plainCipher, options), { command, state } = browser;
  command({ type: 'set-search-engine', value: 'brave' }); command({ type: 'navigate', input: 'bread recipes' });
  assert.equal(state().tabs[0].url, 'https://search.brave.com/search?q=bread%20recipes');
  command({ type: 'set-language', value: 'es' }); assert.equal(state().languageSetting, 'es'); assert.equal(state().language, 'es');
  await command({ type: 'choose-downloads-folder' }); assert.equal(state().downloadsFolderDefault, true);
  const chosen = join(browser.directory, 'chosen'); mkdirSync(chosen); options.folderChoice = { canceled: false, filePaths: [chosen] };
  await command({ type: 'choose-downloads-folder' }); assert.equal(options.folderArgs[0], browser.window); assert.deepEqual(options.folderArgs[1].properties, ['openDirectory']); assert.equal(state().downloadsFolder, chosen);
  options.folderError = true; await assert.rejects(command({ type: 'choose-downloads-folder' }), /DOWNLOADS_FOLDER_PICK_FAILED/); assert.equal(state().downloadsFolder, chosen);
  command({ type: 'reset-downloads-folder' }); assert.equal(state().downloadsFolderDefault, true);
  options.failStore = true;
  assert.throws(() => command({ type: 'set-clear-history-on-close', value: true }), /PROFILE_SETTINGS_SAVE_FAILED/); assert.equal(state().clearHistoryOnClose, false);
  options.failStore = false; command({ type: 'set-clear-history-on-close', value: true }); assert.equal(state().clearHistoryOnClose, true);
  const settingsPath = join(browser.directory, 'settings.json'); rmSync(settingsPath); mkdirSync(settingsPath);
  assert.throws(() => command({ type: 'set-language', value: 'en' }), /SETTINGS_SAVE_FAILED/); assert.equal(state().language, 'es');
});

test('clear commands affect only captured profile, return selected flags, forget undo and refuse overlap', async t => {
  let finish;
  const options = { clear: name => name === 'clearCache' ? new Promise(resolve => { finish = resolve; }) : undefined };
  const browser = notebookBrowser(t, plainCipher, options), { command, state } = browser;
  browser.navigate(); const first = state().activeProfileId, other = state().profiles.find(entry => entry.id !== first);
  command({ type: 'clear-history' }); assert.equal(state().store.history.length, 0); command({ type: 'restore', kind: 'history' }); assert.equal(state().store.history.length, 1);
  command({ type: 'clear-history' });
  const work = command({ type: 'clear-browsing-data', history: true, cookies: true, cache: true });
  assert.equal(state().clearingBrowsingData, true); assert.throws(() => command({ type: 'clear-browsing-data', history: true, cookies: false, cache: false }), /CLEAR_IN_PROGRESS/);
  command({ type: 'switch-profile', id: other.id }); browser.navigate('https://other.example/');
  const contents = browser.views.at(-1).webContents, target = browser.sessions.get(contents.session === undefined ? 'none' : state().profiles.find(entry => entry.id === other.id)?.partition) ?? contents.session;
  target.onBeforeRequest({ id: 1, url: 'https://other.example/', resourceType: 'mainFrame', webContentsId: contents.id }, result => assert.equal(result.cancel, false));
  assert.equal(state().store.history.length, 1);
  await Promise.resolve(); finish(); assert.deepEqual(await work, { history: true, cookies: true, cache: true }); assert.equal(state().clearingBrowsingData, false);
  assert.equal(state().store.history.length, 1);
  command({ type: 'switch-profile', id: first }); command({ type: 'restore', kind: 'history' }); assert.deepEqual(state().store.history, []);
  const firstSession = browser.views[0].webContents.session;
  assert.deepEqual(firstSession.cleared, [['clearStorageData', { storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }], ['clearCache', undefined]]);
});

test('clear failures report each selected kind and profile reset rolls back a failed synchronous save', async t => {
  for (const [field, method, error] of [['cookies', 'clearStorageData', 'CLEAR_SITE_DATA_FAILED'], ['cache', 'clearCache', 'CLEAR_CACHE_FAILED']]) {
    const options = { clear: name => { if (name === method) throw new Error('Native detail'); } }, browser = notebookBrowser(t, plainCipher, options);
    await assert.rejects(browser.command({ type: 'clear-browsing-data', history: false, cookies: false, cache: false, [field]: true }), new RegExp(error));
    assert.equal(browser.state().clearingBrowsingData, false); browser.close();
  }
  const options = {}, browser = notebookBrowser(t, plainCipher, options); browser.navigate();
  browser.command({ type: 'set-blocking', enabled: false }); browser.command({ type: 'set-site-dark', enabled: true });
  options.failStore = true;
  await assert.rejects(browser.command({ type: 'clear-browsing-data', history: true, cookies: false, cache: false }), /CLEAR_HISTORY_FAILED/);
  assert.equal(browser.state().store.history.length, 1);
  assert.throws(() => browser.command({ type: 'reset-site', host: 'example.com' }), /SITE_SETTINGS_SAVE_FAILED/);
  assert.equal(browser.state().sites[0].blocking, false); options.failStore = false;
  browser.command({ type: 'reset-site', host: 'example.com' }); assert.deepEqual(browser.state().sites, []); assert.equal(browser.views[0].webContents.bypassedCache, 1);
});

test('global ads off avoids network matches and cosmetics, keeps exceptions and counts refused cookies independently', t => {
  let matches = 0, cosmetics = 0;
  const blocker = { ready: true, start: async () => {}, stop() {}, cosmeticCSS: () => { cosmetics++; return ''; }, match: () => { matches++; return { kind: 'ads' }; } };
  const browser = notebookBrowser(t, plainCipher, { blocker }), { state, command } = browser; browser.navigate();
  command({ type: 'set-blocking', enabled: false }); const exception = structuredClone(state().store.siteSettings.blocking);
  command({ type: 'set-block-ads', value: false }); browser.navigate('https://other.example/');
  const contents = browser.views.at(-1).webContents, target = contents.session;
  target.onBeforeRequest({ id: 1, url: 'https://ads.example/blocked', resourceType: 'script', webContentsId: contents.id }, result => assert.equal(result.cancel, false));
  let headers;
  target.onBeforeSendHeaders({ id: 1, url: 'https://ads.example/blocked', resourceType: 'script', requestHeaders: { Cookie: 'a=1' }, webContentsId: contents.id }, result => { headers = result.requestHeaders; });
  assert.deepEqual(headers, {}); assert.equal(matches, 0); assert.equal(cosmetics, 1);
  assert.deepEqual(state().store.siteSettings.blocking, exception); assert.deepEqual(state().tabs[0].blocked, { ads: 0, trackers: 0, cookies: 1 }); assert.deepEqual(target.cleared, []);
  target.onHeadersReceived({ id: 1, url: 'https://ads.example/blocked', resourceType: 'script', responseHeaders: { 'Set-Cookie': ['a=2', 'b=1'] }, webContentsId: contents.id }, result => assert.deepEqual(result.responseHeaders, {}));
  assert.equal(state().tabs[0].blocked.cookies, 2);
  command({ type: 'set-block-third-party-cookies', value: false });
  target.onBeforeSendHeaders({ id: 2, url: 'https://ads.example/', resourceType: 'script', requestHeaders: { Cookie: 'a=1' }, webContentsId: contents.id }, result => assert.deepEqual(result.requestHeaders, { Cookie: 'a=1' }));
  target.onHeadersReceived({ id: 2, url: 'https://ads.example/', resourceType: 'script', responseHeaders: { 'Set-Cookie': ['a=1; SameSite=None; Secure'] }, webContentsId: contents.id }, result => assert.deepEqual(result.responseHeaders, { 'Set-Cookie': ['a=1; SameSite=None; Secure'] }));
  command({ type: 'set-block-ads', value: true }); assert.equal(contents.bypassedCache, 1);
});

test('downloads ask dialog is parented, cancellation leaves ledger empty and trusted custom paths remain scoped', async t => {
  const options = {}, browser = notebookBrowser(t, plainCipher, options); browser.navigate();
  const contents = browser.views[0].webContents, target = contents.session;
  const { EventEmitter } = require('node:events');
  const item = () => Object.assign(new EventEmitter(), { getURL: () => 'https://example.com/download', getFilename: () => '../CON.txt', getTotalBytes: () => 10, getReceivedBytes: () => 0, setSavePath(path) { this.path = path; }, cancel() { this.cancelled = true; } });
  const first = item(); target.emit('will-download', { preventDefault() { assert.fail('Regular download refused'); } }, first, contents);
  assert.equal(first.path, join(browser.directory, 'downloads', '_CON.txt')); assert.equal(options.saveArgs, undefined);
  const live = browser.state().store.downloads[0]; await browser.command({ type: 'clear-browsing-data', history: true, cookies: false, cache: false }); assert.equal(first.cancelled, undefined); assert.equal(browser.state().store.downloads[0], live);
  await browser.command({ type: 'clear-browsing-data', history: false, cookies: false, cache: true }); assert.equal(first.cancelled, undefined); assert.equal(browser.state().store.downloads[0], live);
  browser.command({ type: 'set-ask-where-to-save', value: true });
  let prevented = false; const second = item(); target.emit('will-download', { preventDefault() { prevented = true; } }, second, contents);
  assert.equal(prevented, true); assert.equal(second.cancelled, true); assert.equal(browser.state().store.downloads.length, 1); assert.equal(options.saveArgs[0], browser.window);
  const otherFolder = join(browser.directory, 'other'); mkdirSync(otherFolder); options.saveChoice = join(otherFolder, 'chosen.txt');
  const third = item(); target.emit('will-download', { preventDefault() { assert.fail('Chosen download refused'); } }, third, contents);
  const entry = browser.state().store.downloads[0]; assert.equal(entry.path, options.saveChoice);
  browser.command({ type: 'show-download', id: entry.id }); assert.equal(options.shownPath, entry.path);
  entry.path = join(otherFolder, 'changed.txt'); assert.throws(() => browser.command({ type: 'show-download', id: entry.id }), /Invalid download path/);
  const chosenFolder = join(browser.directory, 'chosen-folder'); mkdirSync(chosenFolder); options.folderChoice = { canceled: false, filePaths: [chosenFolder] };
  await browser.command({ type: 'choose-downloads-folder' }); browser.command({ type: 'set-ask-where-to-save', value: false });
  const fourth = item(); target.emit('will-download', { preventDefault() { assert.fail('Chosen folder refused'); } }, fourth, contents); assert.equal(require('node:path').dirname(fourth.path), chosenFolder);
  require('node:fs').rmdirSync(chosenFolder);
  const fifth = item(); target.emit('will-download', { preventDefault() { assert.fail('Fallback folder refused'); } }, fifth, contents); assert.equal(require('node:path').dirname(fifth.path), join(browser.directory, 'downloads')); assert.equal(browser.state().downloadsFolderUnavailable, true); assert.equal(browser.state().downloadsFolderDefault, true);
});

test('quit clears flagged unopened profiles under one five-second deadline and keeps unflagged profile history', async t => {
  const options = { clear: name => name === 'clearCache' ? new Promise(() => {}) : undefined }, browser = notebookBrowser(t, plainCipher, options);
  browser.navigate(); const active = browser.state().activeProfileId, unopened = browser.state().profiles.find(profile => profile.id !== active);
  const unopenedStore = sampleStore(browser.directory); unopenedStore.clearHistoryOnClose = true; unopenedStore.clearCacheOnClose = true;
  writeStore(profileStorePath(browser.directory, unopened.id), unopenedStore);
  let prevented = 0; browser.app.emit('before-quit', { preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(readStore(profileStorePath(browser.directory, unopened.id)).history.length, 0);
  assert.equal(readStore(profileStorePath(browser.directory, active)).history.length, 1);
  assert.equal([...browser.timers.values()].filter(timer => timer.delay === 5000).length, 1);
  fireTimers(browser.timers, 5000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(browser.app.quits, 1);
});
test('default browser registers exact current-user arrays, opens fixed settings URI and refreshes status', async () => {
  const { createDefaultBrowser } = require('../dist/electron/default-browser.js');
  const calls = [], opened = [], changes = [], exe = 'C:\\Program Files\\Horizon\\Horizon.exe';
  const service = createDefaultBrowser({ platform: 'win32', isPackaged: true, execPath: exe, runner: async (name, args) => { calls.push([name, args]); return '    ProgId    REG_SZ    HorizonURL\r\n'; }, openExternal: async url => { opened.push(url); }, changed: status => changes.push(status) });
  await service.register();
  const registryPath = require('node:path').win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const icon = '"' + exe + '",0', command = '"' + exe + '" "%1"';
  assert.deepEqual(calls, [
    [registryPath, ['add', 'HKCU\\Software\\Classes\\HorizonURL', '/ve', '/t', 'REG_SZ', '/d', 'Horizon URL', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Classes\\HorizonURL', '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Classes\\HorizonURL\\DefaultIcon', '/ve', '/t', 'REG_SZ', '/d', icon, '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Classes\\HorizonURL\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Classes\\HorizonHTML', '/ve', '/t', 'REG_SZ', '/d', 'Horizon HTML Document', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Classes\\HorizonHTML\\DefaultIcon', '/ve', '/t', 'REG_SZ', '/d', icon, '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Classes\\HorizonHTML\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon', '/ve', '/t', 'REG_SZ', '/d', 'Horizon', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\DefaultIcon', '/ve', '/t', 'REG_SZ', '/d', icon, '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities', '/v', 'ApplicationName', '/t', 'REG_SZ', '/d', 'Horizon', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities', '/v', 'ApplicationDescription', '/t', 'REG_SZ', '/d', 'Browse the web with Horizon', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities', '/v', 'ApplicationIcon', '/t', 'REG_SZ', '/d', icon, '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities\\URLAssociations', '/v', 'http', '/t', 'REG_SZ', '/d', 'HorizonURL', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities\\URLAssociations', '/v', 'https', '/t', 'REG_SZ', '/d', 'HorizonURL', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities\\FileAssociations', '/v', '.htm', '/t', 'REG_SZ', '/d', 'HorizonHTML', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities\\FileAssociations', '/v', '.html', '/t', 'REG_SZ', '/d', 'HorizonHTML', '/f']],
    [registryPath, ['add', 'HKCU\\Software\\RegisteredApplications', '/v', 'Horizon', '/t', 'REG_SZ', '/d', 'Software\\Clients\\StartMenuInternet\\Horizon\\Capabilities', '/f']],
    [registryPath, ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']],
  ]);
  assert.deepEqual(opened, ['ms-settings:defaultapps?registeredAppUser=Horizon']); assert.equal(service.status, 'default'); assert.deepEqual(changes, ['default']);
});

test('default browser refuses development and unsupported builds without any runner; failures remain named', async () => {
  const { createDefaultBrowser } = require('../dist/electron/default-browser.js');
  for (const [platform, packaged, status, error] of [['linux', false, 'unsupported', 'UNSUPPORTED'], ['linux', true, 'unsupported', 'UNSUPPORTED'], ['win32', false, 'developmentBuild', 'DEVELOPMENT_BUILD']]) {
    const service = createDefaultBrowser({ platform, isPackaged: packaged, execPath: 'Horizon.exe', runner: async () => assert.fail('Runner must not execute'), openExternal: async () => assert.fail('Settings must not open') });
    await service.refresh(); assert.equal(service.status, status); await assert.rejects(service.register(), new RegExp('DEFAULT_BROWSER_' + error));
  }
  let output = 'ProgId REG_SZ OtherBrowser', failQuery = false, failWrite = false, failOpen = false;
  const service = createDefaultBrowser({ platform: 'win32', isPackaged: true, execPath: 'C:\\Horizon.exe', runner: async (_command, args) => { if (args[0] === 'query' && failQuery || args[0] === 'add' && failWrite) throw new Error('Native detail'); return output; }, openExternal: async () => { if (failOpen) throw new Error('Native detail'); } });
  await service.refresh(); assert.equal(service.status, 'notDefault'); output = 'ProgId REG_SZ HorizonURL'; await service.refresh(); assert.equal(service.status, 'default');
  failQuery = true; await service.refresh(); assert.equal(service.status, 'notDefault'); failWrite = true; await assert.rejects(service.register(), /DEFAULT_BROWSER_REGISTRATION_FAILED/);
  failWrite = false; failOpen = true; await assert.rejects(service.register(), /DEFAULT_BROWSER_SETTINGS_FAILED/);
});

test('launch parser accepts last bounded URL or regular HTML path and rejects unsafe input', t => {
  const { launchAddress, isLocalHTMLURL } = require('../dist/electron/launch.js'), { pathToFileURL } = require('node:url');
  const directory = temporaryDirectory(t, 'launch'), html = join(directory, 'page.HTML'), other = join(directory, 'other.html'); writeFileSync(html, '<html></html>'); writeFileSync(other, '<html></html>');
  const fileURL = pathToFileURL(html).href;
  assert.equal(launchAddress(['Horizon.exe', '--flag', 'page.HTML'], directory), fileURL);
  assert.equal(launchAddress([html, 'https://example.com/']), 'https://example.com/'); assert.equal(launchAddress(['https://example.com/', html]), fileURL);
  for (const value of ['--https://example.com/', '-page.html', 'https://user:pass@example.com/', 'javascript:alert(1)', 'file:///private.html', 'horizon://settings', 'https://example.com/\n', 'https://example.com/\u0085', 'https://example.com/' + 'x'.repeat(8192), join(directory, 'missing.html')]) assert.equal(launchAddress([value]), null);
  mkdirSync(join(directory, 'directory.html')); assert.equal(launchAddress([join(directory, 'directory.html')]), null);
  assert.equal(isLocalHTMLURL(fileURL), true);
  for (const value of [fileURL + '?x', fileURL + '#x', fileURL.replace('file:///', 'file://remote/'), 'file:' + html, fileURL + '\u0085', fileURL.replace('page.HTML', 'missing.html')]) assert.equal(isLocalHTMLURL(value), false);
});

test('local HTML launch authorizes only its exact tab main-frame URL and survives view replacement', t => {
  const browser = notebookBrowser(t), { pathToFileURL } = require('node:url'), html = join(browser.directory, 'launch.html'), other = join(browser.directory, 'other.html'); writeFileSync(html, '<html></html>'); writeFileSync(other, '<html></html>');
  const url = pathToFileURL(html).href, unrelated = pathToFileURL(other).href;
  browser.openLaunch(url); const first = browser.views.at(-1).webContents, target = first.session;
  assert.equal(browser.isLaunchNavigation(first, url), true); assert.equal(browser.isLaunchNavigation(first, unrelated), false);
  for (const [address, type, allowed] of [[url, 'mainFrame', true], [unrelated, 'mainFrame', false], [url, 'subFrame', false], [url, 'image', false]]) target.onBeforeRequest({ id: 1, url: address, resourceType: type, webContentsId: first.id }, result => assert.equal(result.cancel, !allowed));
  assert.equal(isAllowedURL(url), false); assert.throws(() => browser.command({ type: 'navigate', input: url }));
  const handlers = {}; hardenContents({ on: (name, fn) => { handlers[name] = fn; }, setWindowOpenHandler() {} }, true, address => browser.isLaunchNavigation(first, address));
  for (const [address, main, allowed] of [[url, true, true], [unrelated, true, false], [url, false, false]]) {
    let prevented = false; handlers['will-frame-navigate']({ url: address, isMainFrame: main, preventDefault() { prevented = true; } }); assert.equal(prevented, !allowed);
  }
  browser.command({ type: 'dark-pages', value: 'on' }); const replacement = browser.views.at(-1).webContents;
  assert.notEqual(first, replacement); assert.equal(browser.isLaunchNavigation(replacement, url), true); assert.equal(browser.isLaunchNavigation(replacement, unrelated), false);
  assert.deepEqual(browser.state().store.history, []);
});

function settingsMain(t, options) {
  const { EventEmitter } = require('node:events'), { compileFunction } = require('node:vm'), filename = resolve('dist/electron/main.js'), localRequire = require('node:module').createRequire(filename), directory = temporaryDirectory(t, 'settings-main'), windows = [], launches = [], handlers = new Map();
  const app = Object.assign(new EventEmitter(), { isPackaged: true, requestSingleInstanceLock: () => options.lock !== false, getLocale: () => 'es-AR', getPath: () => directory, enableSandbox() {}, whenReady: async () => {}, commandLine: { appendSwitch() {}, removeSwitch() {} }, quit() { this.quits = (this.quits || 0) + 1; }, exit() { assert.fail('Mock main failed'); } });
  const settings = { theme: 'system', contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', migrationAllowed: false, language: 'en' };
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.webContents = new EventEmitter(); this.minimized = true; }
    isDestroyed() { return false; } isMinimized() { return this.minimized; } restore() { this.minimized = false; this.restored = true; }
    removeMenu() {} setBackgroundColor() {} show() { this.shown = true; } focus() { this.focused = true; }
    async loadURL() { if (options.stall) await new Promise(done => { options.finish = done; }); this.loaded = true; }
  }
  compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', '__dirname', 'process'])({}, name => {
    if (name === 'electron') return { app, BrowserWindow: Window, nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }), protocol: { registerSchemesAsPrivileged() {} }, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) }, session: { defaultSession: { protocol: {} } }, ipcMain: { handle(name, fn) { handlers.set(name, fn); } } };
    if (name === './settings') return { ...localRequire(name), createSettings: () => settings };
    if (name === './browser') return { createBrowser: () => ({ layout() {}, openLaunch(url) { if (options.launchFail) throw new Error('Tab limit reached'); launches.push(url); } }), isProfileSession: () => false, isLaunchNavigation: () => false };
    if (name === './protocol') return { serveHorizon: async () => {} };
    if (name === './security') return { ...localRequire(name), secureSession() {}, validateSender() {} };
    return localRequire(name);
  }, require('node:path').dirname(filename), { argv: options.args ?? ['Horizon.exe'] });
  return { app, settings, windows, launches, handlers, directory };
}

test('main holds startup and second-instance URLs until chrome loads, restores and focuses; no lock creates no window', async t => {
  const rejected = settingsMain(t, { lock: false }); await new Promise(done => setImmediate(done)); assert.equal(rejected.app.quits, 1); assert.deepEqual(rejected.windows, []);
  const options = { stall: true, args: ['Horizon.exe', 'https://startup.example/'] }, main = settingsMain(t, options);
  main.app.emit('second-instance', {}, ['Horizon.exe', 'https://queued.example/'], main.directory);
  await new Promise(done => setImmediate(done)); assert.deepEqual(main.launches, []); assert.equal(main.windows[0].shown, undefined);
  options.finish(); await new Promise(done => setImmediate(done));
  assert.deepEqual(main.launches, ['https://startup.example/', 'https://queued.example/']); assert.equal(main.windows[0].restored, true); assert.equal(main.windows[0].shown, true); assert.equal(main.windows[0].focused, true);
  const html = join(main.directory, 'second.html'); writeFileSync(html, '<html></html>');
  main.app.emit('second-instance', {}, ['Horizon.exe', 'second.html'], main.directory); assert.equal(main.launches.at(-1), require('node:url').pathToFileURL(html).href);
  const count = main.launches.length; main.app.emit('second-instance', {}, ['--flag', 'javascript:alert(1)'], main.directory); assert.equal(main.launches.length, count);
  main.windows[0].minimized = true; main.windows[0].focused = false; main.app.emit('second-instance', {}, ['--flag'], main.directory); assert.equal(main.windows[0].minimized, false); assert.equal(main.windows[0].focused, true);
  options.launchFail = true; main.windows[0].focused = false; assert.doesNotThrow(() => main.app.emit('second-instance', {}, ['https://capped.example/'], main.directory)); assert.equal(main.windows[0].focused, true);
  assert.equal(main.handlers.get('horizon:language')({}), 'en'); main.settings.language = 'system'; assert.equal(main.handlers.get('horizon:language')({}), 'es');
});
test('context selection searches use every chosen engine prefix', t => {
  const browser = notebookBrowser(t), { command, state } = browser; browser.navigate();
  const original = state().activeId, contents = browser.views[0].webContents;
  const prefixes = { duckduckgo: 'https://duckduckgo.com/?q=', startpage: 'https://www.startpage.com/sp/search?query=', brave: 'https://search.brave.com/search?q=', ecosia: 'https://www.ecosia.org/search?q=', bing: 'https://www.bing.com/search?q=', google: 'https://www.google.com/search?q=' };
  for (const [engine, prefix] of Object.entries(prefixes)) {
    command({ type: 'set-search-engine', value: engine }); command({ type: 'activate-tab', id: original });
    contents.emit('context-menu', {}, menuParams({ selectionText: 'bread & butter' }));
    const menu = browser.window.webContents.sent.at(-1)[1];
    command({ type: 'context-menu', id: menu.id, item: 'search-selection' });
    assert.equal(state().tabs.find(tab => tab.id === state().activeId).url, prefix + 'bread%20%26%20butter');
  }
});

test('each clear kind leaves unselected data and library entries alone', async t => {
  for (const field of ['history', 'cookies', 'cache']) {
    const browser = notebookBrowser(t); browser.navigate();
    const store = browser.state().store;
    store.bookmarks.push({ url: 'https://saved.example/', title: 'Saved', createdAt: 1 });
    const before = structuredClone(store);
    const result = await browser.command({ type: 'clear-browsing-data', history: false, cookies: false, cache: false, [field]: true });
    assert.deepEqual(result, { history: field === 'history', cookies: field === 'cookies', cache: field === 'cache' });
    assert.deepEqual(store.history, field === 'history' ? [] : before.history); assert.deepEqual(store.bookmarks, before.bookmarks); assert.deepEqual(store.downloads, before.downloads);
    const calls = browser.views[0].webContents.session.cleared.map(entry => entry[0]);
    assert.deepEqual(calls, field === 'history' ? [] : [field === 'cookies' ? 'clearStorageData' : 'clearCache']); browser.close();
  }
});

test('reset site drops dismissed permission memory and resets all schemes and ports before asking again', t => {
  const browser = notebookBrowser(t); browser.navigate();
  const contents = browser.views[0].webContents, target = contents.session;
  contents.mainFrame = { url: 'https://example.com/' };
  let allowed; target.request(contents, 'geolocation', value => { allowed = value; }, {});
  const prompt = browser.state().permissionPrompt;
  browser.command({ type: 'answer-permission', id: prompt.id, answer: 'dismiss' }); assert.equal(allowed, false);
  target.request(contents, 'geolocation', value => { allowed = value; }, {}); assert.equal(browser.state().permissionPrompt, null);
  browser.command({ type: 'set-site-dark', enabled: true });
  const store = browser.state().store.siteSettings;
  setPermission(store, 'http://example.com:8080', 'notifications', 'block'); setPermission(store, 'https://example.com:8443', 'camera', 'allow');
  browser.command({ type: 'reset-site', host: 'example.com' });
  assert.deepEqual(store.permissions, []); assert.deepEqual(store.dark, []);
  target.request(contents, 'geolocation', () => {}, {}); assert.equal(browser.state().permissionPrompt.origin, 'https://example.com');
});
