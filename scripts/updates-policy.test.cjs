const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { createSettings, readSettings, validateSettings } = require('../dist/electron/settings.js');
const { createUpdates } = require('../dist/electron/updates.js');
const { validateCommand } = require('../dist/electron/commands.js');
const { SYNC_SETTING_KEYS, validateSyncSettings } = require('../dist/electron/sync-model.js');
const { copy } = require('../dist/src/copy.js');

const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(done => setImmediate(done)); };
function timers(t) {
  const pending = new Map();
  for (const kind of ['Timeout', 'Interval']) {
    t.mock.method(global, `set${kind}`, (callback, delay) => { const handle = { unref() {} }; pending.set(handle, { kind, callback, delay }); return handle; });
    t.mock.method(global, `clear${kind}`, handle => pending.delete(handle));
  }
  return { pending, fire(kind) { const [handle, timer] = [...pending].find(([, timer]) => timer.kind === kind) ?? []; assert.ok(timer, `${kind} is scheduled`); if (kind === 'Timeout') pending.delete(handle); timer.callback(); return timer.callback; } };
}
function updater(t, automaticEnabled) {
  const clock = timers(t); let checks = 0, loads = 0;
  const autoUpdater = Object.assign(new EventEmitter(), { checkForUpdates: async () => { checks++; autoUpdater.emit('update-not-available'); return {}; } });
  const options = { platform: 'win32', packaged: true, appImage: false, packageType: null, firstCheckDelay: 5, checkInterval: 40, load: async () => { loads++; return autoUpdater; } };
  if (automaticEnabled !== undefined) options.automaticEnabled = automaticEnabled;
  const updates = createUpdates(options); t.after(() => updates.stop());
  return { clock, updates, get checks() { return checks; }, get loads() { return loads; } };
}

test('automatic update checks default to on and run at startup and on the interval', async t => {
  const h = updater(t); h.updates.start(); h.updates.start();
  assert.equal(h.clock.pending.size, 2);
  assert.deepEqual([...h.clock.pending.values()].map(timer => timer.delay), [5, 40]);
  h.clock.fire('Timeout'); await settle(); assert.equal(h.checks, 1);
  h.clock.fire('Interval'); await settle(); assert.equal(h.checks, 2); assert.equal(h.loads, 1);
});

test('turning automatic updates off prevents startup and interval checks while a manual check still runs', async t => {
  const h = updater(t, false); h.updates.start();
  assert.equal(h.clock.pending.size, 0); assert.equal(h.loads, 0);
  await h.updates.check(); assert.equal(h.checks, 1); assert.equal(h.updates.state.status, 'upToDate');
  assert.equal(h.clock.pending.size, 0);
  h.updates.setAutomatic(true); assert.equal(h.clock.pending.size, 2);
  h.clock.fire('Timeout'); await settle(); assert.equal(h.checks, 2);
  const queuedInterval = [...h.clock.pending.values()][0].callback;
  h.updates.setAutomatic(false); assert.equal(h.clock.pending.size, 0);
  queuedInterval(); await settle(); assert.equal(h.checks, 2);
  await h.updates.check(); assert.equal(h.checks, 3);
});

test('turning automatic updates off cancels a pending startup check and gates a delayed updater load', async t => {
  const clock = timers(t); let checks = 0, resolveLoad;
  const autoUpdater = Object.assign(new EventEmitter(), { checkForUpdates: async () => { checks++; return {}; } });
  const updates = createUpdates({ platform: 'win32', packaged: true, appImage: false, packageType: null, load: () => new Promise(done => { resolveLoad = done; }) });
  t.after(() => updates.stop()); updates.start();
  const queuedStartup = [...clock.pending.values()].find(timer => timer.kind === 'Timeout').callback;
  updates.setAutomatic(false); queuedStartup(); await settle(); assert.equal(resolveLoad, undefined); assert.equal(checks, 0);
  updates.setAutomatic(true); clock.fire('Timeout'); assert.equal(typeof resolveLoad, 'function');
  updates.setAutomatic(false); resolveLoad(autoUpdater); await settle(); assert.equal(checks, 0); assert.equal(clock.pending.size, 0);
  await updates.check(); assert.equal(checks, 1);
});

test('automatic update setting defaults on, validates exact booleans and persists across restarts', t => {
  const folder = mkdtempSync(join(tmpdir(), 'horizon-updates-setting-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'settings.json'); let notifications = 0;
  const settings = createSettings(path, () => notifications++), original = readSettings(path);
  assert.equal(settings.checkUpdatesAutomatically, true); assert.equal(validateSettings(original), true);
  for (const value of [false, true, false]) {
    settings.setCheckUpdatesAutomatically(value);
    assert.equal(readSettings(path).checkUpdatesAutomatically, value);
    assert.equal(createSettings(path, () => {}).checkUpdatesAutomatically, value);
    assert.deepEqual(validateCommand({ type: 'set-check-updates-automatically', value }), { type: 'set-check-updates-automatically', value });
  }
  assert.equal(notifications, 3); const saved = readFileSync(path, 'utf8');
  for (const value of [undefined, null, 'false', 0, 1, {}, []]) {
    assert.equal(validateSettings({ ...original, checkUpdatesAutomatically: value }), false);
    assert.throws(() => settings.setCheckUpdatesAutomatically(value), /SETTINGS_COMMAND_INVALID/);
    assert.throws(() => validateCommand({ type: 'set-check-updates-automatically', value }), /SETTINGS_COMMAND_INVALID/);
  }
  assert.equal(readFileSync(path, 'utf8'), saved);
  assert.throws(() => validateCommand({ type: 'set-check-updates-automatically', value: false, extra: true }), /SETTINGS_COMMAND_INVALID/);
  assert.deepEqual(validateCommand({ type: 'check-updates' }), { type: 'check-updates' });
  assert.throws(() => validateCommand({ type: 'check-updates', automatic: true }), /SETTINGS_COMMAND_INVALID/);
  writeFileSync(path, JSON.stringify(original)); assert.equal(createSettings(path, () => {}).checkUpdatesAutomatically, true);
});

test('sync deliberately excludes automatic updates and cannot overwrite the local choice', t => {
  const folder = mkdtempSync(join(tmpdir(), 'horizon-updates-sync-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const settings = createSettings(join(folder, 'settings.json'), () => {}); settings.setCheckUpdatesAutomatically(false);
  const snapshot = settings.syncSnapshot(); assert.equal(SYNC_SETTING_KEYS.includes('checkUpdatesAutomatically'), false);
  assert.equal(Object.hasOwn(snapshot, 'checkUpdatesAutomatically'), false);
  settings.applySync({ ...snapshot, language: 'es' }); assert.equal(settings.checkUpdatesAutomatically, false);
  assert.throws(() => validateSyncSettings({ ...snapshot, checkUpdatesAutomatically: true }), /SYNC_INVALID/);
});

function component(path, extra = '') {
  const exports = {}, jsx = (type, props) => ({ type, props });
  const react = { useRef: current => ({ current }), useId: () => 'synthetic-id', useEffect() {}, useState: value => [value, () => {}] };
  const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(source + extra, { exports, navigator: { language: 'en' }, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === './copy') return require('../dist/src/copy.js');
    if (name === './shared/api') return require('../dist/src/shared/api.js');
    return new Proxy({}, { get: (_target, key) => String(key) });
  } });
  return exports;
}
const nodes = (tree, predicate) => [tree].flat(Infinity).flatMap(node => node && typeof node === 'object' ? [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)] : []);

test('General offers the update switch and About keeps Check now next to its status in both languages', () => {
  const settings = component('src/Settings.tsx', '\nexports.GeneralSettings = GeneralSettings;'), { AboutHorizon } = component('src/AboutHorizon.tsx');
  for (const language of ['en', 'es']) {
    const tree = settings.GeneralSettings({ state: { defaultBrowser: 'unsupported', languageSetting: 'system', language, privateWindow: true, checkUpdatesAutomatically: false }, language });
    const toggle = nodes(tree, node => node.props.title === 'checkUpdatesAutomatically')[0];
    assert.equal(toggle.props.value, false); assert.equal(toggle.props.command, 'set-check-updates-automatically'); assert.equal(toggle.props.hint, copy.checkUpdatesAutomaticallyHint[language]);
    let checks = 0;
    for (const status of ['idle', 'upToDate', 'error', 'checking', 'downloading', 'ready', 'unavailable']) {
      const about = AboutHorizon({ version: 'synthetic-version', update: { status, percent: 30 }, language, opener: { current: null }, onClose() {}, onRestart() {}, onCheck() { checks++; } });
      const check = nodes(about, node => node.type === 'button' && node.props.children === copy.updateCheckNow[language])[0];
      const row = nodes(about, node => node.props.className === 'settings-feedback')[0];
      assert.ok(nodes(row, node => node.props.role === 'status').length); assert.ok(nodes(row, node => node === check).length);
      assert.equal(check.props.className, 'settings-button'); assert.equal(check.props.disabled, !['idle', 'upToDate', 'error'].includes(status));
      if (!check.props.disabled) check.props.onClick();
    }
    assert.equal(checks, 3);
  }
});

test('update policy copy exists in English and neutral impersonal Spanish without tuteo or voseo', () => {
  for (const key of ['checkUpdatesAutomatically', 'checkUpdatesAutomaticallyHint', 'updateCheckNow', 'updateIdle']) {
    assert.ok(copy[key].en && copy[key].es);
    assert.doesNotMatch(copy[key].es, /(?:^|[^\p{L}])(?:vos|tú|tu|tus|acá|usted|ustedes|buscá|buscas|comprueba|comprobá|haz|hacé|elige|elegí|puedes|podés)(?=$|[^\p{L}])/iu);
  }
  assert.equal(copy.checkUpdatesAutomatically.en, 'Check for updates automatically'); assert.equal(copy.updateCheckNow.en, 'Check now');
});
