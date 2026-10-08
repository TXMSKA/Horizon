const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');
const { validateCommand } = require('../dist/electron/commands.js');
const { assertPrivateCommand } = require('../dist/electron/private-commands.js');
const { copy } = require('../dist/src/copy.js');
const { syncRelativeTime, syncConflictTitle, syncErrorKey, syncFocusTarget } = require('../dist/src/shared/sync-display.js');
const { openRemoteGroup } = require('../dist/src/shared/remote-tabs.js');

test('saving the sync code accepts only its exact command and is refused in private windows', () => {
  const command = { type: 'sync-save-key' };
  assert.deepEqual(validateCommand(command), command);
  for (const field of ['key', 'path', 'accepted', 'filename', 'extra']) assert.throws(() => validateCommand({ ...command, [field]: 'synthetic' }), /SYNC_INVALID/);
  for (const value of [null, [], {}, { type: 'sync-save-key', key: undefined }]) assert.throws(() => validateCommand(value));
  assert.throws(() => assertPrivateCommand(command), /SYNC_PRIVATE/);
  assert.deepEqual(validateCommand({ type: 'open-settings', section: 'sync' }), { type: 'open-settings', section: 'sync' });
});

test('sync relative times cover boundaries, future clocks and separate plurals in both languages', () => {
  const now = 200000000;
  for (const language of ['en', 'es']) {
    for (const [elapsed, key, count] of [[0, 'syncJustNow'], [59999, 'syncJustNow'], [60000, 'syncMinuteOne', 1], [120000, 'syncMinuteMany', 2], [3599999, 'syncMinuteMany', 59], [3600000, 'syncHourOne', 1], [7200000, 'syncHourMany', 2], [86400000, 'syncDayOne', 1], [172800000, 'syncDayMany', 2]]) {
      assert.equal(syncRelativeTime(now - elapsed, language, now), copy[key][language].replace('{count}', String(count)));
    }
    assert.equal(syncRelativeTime(now + 60000, language, now), copy.syncJustNow[language]);
    assert.equal(syncRelativeTime(null, language, now), copy.syncNever[language]);
    assert.equal(syncRelativeTime(NaN, language, now), copy.syncNever[language]);
  }
});

test('conflict titles localize settings and unnamed items but preserve personal titles and sites', () => {
  for (const language of ['en', 'es']) {
    assert.equal(syncConflictTitle({ item: 'settings', title: 'language' }, language), copy.language[language]);
    assert.equal(syncConflictTitle({ item: 'settings', title: 'marketplace' }, language), copy.themes[language]);
    assert.equal(syncConflictTitle({ item: 'siteSettings', title: 'clearHistoryOnClose' }, language), copy.clearHistoryOnClose[language]);
    assert.equal(syncConflictTitle({ item: 'favorites', title: 'language' }, language), 'language');
    assert.equal(syncConflictTitle({ item: 'profiles', title: randomUUID() }, language), copy.profiles[language]);
    assert.equal(syncConflictTitle({ item: 'desktop', title: ' ' }, language), copy.desktop[language]);
    assert.equal(syncConflictTitle({ item: 'siteSettings', title: 'synthetic.example' }, language), 'synthetic.example');
  }
});

test('sync failures use bilingual messages without exposing arbitrary error text', () => {
  const codes = ['INVALID', 'NEWER_FORMAT', 'WRONG_KEY', 'STORAGE', 'FOLDER', 'FULL', 'LIMIT', 'TIMEOUT', 'LOCKED', 'GAP', 'BLOB_PENDING', 'CHANGED', 'CANCELLED', 'SAVE_FAILED', 'PRIVATE', 'TAB_LIMIT'];
  for (const suffix of codes) {
    const key = `SYNC_${suffix}`; assert.equal(syncErrorKey(new Error(`IPC failed: ${key}`)), key);
    assert.ok(copy[key].en && copy[key].es); assert.doesNotMatch(copy[key].en + copy[key].es, /[\u2010-\u2015\u2212]/);
  }
  assert.equal(syncErrorKey(new Error('unknown synthetic sensitive value')), 'browserError');
  assert.equal(syncErrorKey(new Error('syncCopyFailed')), 'syncCopyFailed');
});

function groupHost(options = {}) {
  const state = { activeProfileId: 'local-profile', privateWindow: !!options.privateWindow, sync: { switches: { tabs: options.tabs !== false } }, tabs: Array.from({ length: options.count ?? 1 }, (_, index) => ({ id: `existing-${index}`, url: 'https://existing.example/', groupId: null })), groups: [] };
  const commands = []; let next = 0;
  const host = { getState: async () => structuredClone(state), command: async command => {
    commands.push(command);
    if (command.type === options.failOn) throw new Error('SYNC_CHANGED');
    switch (command.type) {
      case 'new-tab': state.tabs.push({ id: `new-${next++}`, url: command.input, groupId: null }); break;
      case 'create-tab-group': { const id = randomUUID(); state.groups.push({ id, name: '' }); state.tabs.find(tab => tab.id === command.id).groupId = id; break; }
      case 'update-tab-group': state.groups.find(group => group.id === command.id).name = command.name; break;
      case 'add-tab-to-group': state.tabs.find(tab => tab.id === command.id).groupId = command.group; break;
      case 'activate-tab': state.activeId = command.id; break;
      case 'close-tab': state.tabs = state.tabs.filter(tab => tab.id !== command.id); break;
    }
  } };
  return { host, state, commands };
}
const remote = () => ({ profile: 'remote-profile', id: 'remote-window', groups: [{ id: 'remote-group', title: 'Research' }], tabs: [{ title: 'First', url: 'https://first.example/', group: 'remote-group' }, { title: 'Unrelated', url: 'https://unrelated.example/', group: null }, { title: 'Second', url: 'https://second.example/', group: 'remote-group' }] });

test('a remote group opens only its tabs into one new named local group', async () => {
  const { host, state, commands } = groupHost(); await openRemoteGroup(host, remote(), 'remote-group');
  assert.equal(state.tabs.length, 3); assert.equal(state.tabs[0].groupId, null);
  assert.equal(state.groups.length, 1); assert.equal(state.groups[0].name, 'Research');
  assert.ok(state.tabs.slice(1).every(tab => tab.groupId === state.groups[0].id));
  assert.deepEqual(commands.filter(command => command.type === 'new-tab').map(command => command.input), ['https://first.example/', 'https://second.example/']);
  assert.equal(state.activeId, state.tabs[1].id);
  assert.equal(commands.filter(command => command.type === 'close-tab-group-editor').length, 1);
});

test('remote groups check limits, private windows and the tabs switch before opening anything', async () => {
  for (const options of [{ count: 199 }, { privateWindow: true }, { tabs: false }]) {
    const { host, commands } = groupHost(options); await assert.rejects(openRemoteGroup(host, remote(), 'remote-group'), /SYNC_(TAB_LIMIT|CHANGED)/); assert.equal(commands.length, 0);
  }
  const { host, commands } = groupHost(); await assert.rejects(openRemoteGroup(host, remote(), 'missing'), /SYNC_CHANGED/); assert.equal(commands.length, 0);
});

test('a failed group opening removes its own partial tabs so retry does not duplicate them', async () => {
  const { host, state, commands } = groupHost({ failOn: 'add-tab-to-group' });
  await assert.rejects(openRemoteGroup(host, remote(), 'remote-group'), /SYNC_CHANGED/);
  assert.deepEqual(state.tabs.map(tab => tab.id), ['existing-0']); assert.equal(commands.filter(command => command.type === 'close-tab').length, 2);
});

function settingsHarness() {
  let cursor = 0; const slots = [], commands = [], effects = [];
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useRef(current) { const index = cursor++; slots[index] ??= { current }; return slots[index]; },
    useId: () => 'synthetic-id', useEffect: effect => effects.push(effect),
  };
  const exports = {}, jsx = (type, props) => ({ type, props });
  const state = { sync: { configured: false, folderName: null, lastSynced: null, switches: { favorites: true, history: false, tabs: true, desktop: true, siteSettings: true, settings: true, profiles: true }, failure: null, conflicts: [], computers: [], syncing: false } };
  const source = ts.transpileModule(readFileSync('src/Settings.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const globals = { exports, Error, HTMLElement: class {}, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === './copy') return require('../dist/src/copy.js');
    if (name === './shared/api') return require('../dist/src/shared/api.js');
    if (name === './shared/sync-display') return require('../dist/src/shared/sync-display.js');
    return new Proxy({}, { get: (_target, key) => String(key) });
  }, document: { activeElement: null, body: {} }, window: { horizon: { command: async command => { commands.push(command); if (command.type === 'sync-create' || command.type === 'sync-join') state.sync.configured = true; if (command.type === 'sync-reveal-key') return 'synthetic-display-code'; }, getState: async () => state } } };
  runInNewContext(source + '\nexports.SyncSettings = SyncSettings; exports.SyncDialog = SyncDialog;', globals);
  return { exports, state, slots, effects, globals, commands, render(language = 'en') { cursor = 0; effects.length = 0; return exports.SyncSettings({ state, language }); }, renderDialog(props) { cursor = 0; effects.length = 0; return exports.SyncDialog(props); }, flushFocus() { effects[1](); }, async settle() { for (let index = 0; index < 5; index++) await new Promise(done => setImmediate(done)); } };
}
const flat = value => [value].flat(Infinity).filter(value => value !== null && value !== undefined && typeof value !== 'boolean');
const find = (tree, predicate) => flat(tree).flatMap(node => typeof node === 'object' ? [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)] : []);
const button = (tree, label) => find(tree, node => node.type === 'button' && flat(node.props.children).includes(label))[0];
const dialog = tree => find(tree, node => typeof node.type === 'function' && node.type.name === 'SyncDialog')[0];
const rowControls = tree => [...find(tree, node => node.type === 'button'), ...find(tree, node => typeof node.props?.children === 'function').flatMap(node => node.props.children('row-id', async () => true, false))];

test('setup asks the family notice before any command and reveals the code once until Done', async () => {
  const h = settingsHarness(), opener = { isConnected: true, focus() {} };
  button(rowControls(h.render()), 'Set up sync').props.onClick({ currentTarget: opener });
  let tree = h.render(); assert.equal(dialog(tree).props.hint, 'syncNotice'); assert.equal(h.commands.length, 0);
  button(tree, 'Continue').props.onClick(); await h.settle(); tree = h.render();
  assert.equal(h.commands[0].type, 'sync-create'); assert.equal(h.commands[0].accepted, true);
  assert.equal(h.commands[1].type, 'sync-reveal-key'); assert.equal(dialog(tree).props.title, 'syncCodeTitle');
  assert.equal(find(tree, node => node.type === 'input' && node.props.readOnly)[0].props.value, 'synthetic-display-code');
  button(tree, 'Done').props.onClick(); tree = h.render(); assert.equal(dialog(tree), undefined);
  assert.equal(h.slots.some(slot => slot.value === 'synthetic-display-code'), false);
  button(rowControls(tree), 'Show code').props.onClick({ currentTarget: opener }); tree = h.render();
  assert.equal(dialog(tree).props.title, 'syncRevealTitle'); assert.equal(h.commands.length, 2);
});

test('joining asks the notice before the paste field and sends acceptance with the trimmed code', async () => {
  const h = settingsHarness(); button(rowControls(h.render()), 'Join with a code').props.onClick({ currentTarget: {} });
  let tree = h.render(); assert.equal(dialog(tree).props.hint, 'syncNotice'); button(tree, 'Continue').props.onClick();
  tree = h.render(); assert.equal(dialog(tree).props.hint, 'syncJoinHint'); assert.equal(h.commands.length, 0);
  find(tree, node => node.type === 'input')[0].props.onChange({ target: { value: ' synthetic-code ' } });
  button(h.render(), 'Continue').props.onClick(); await h.settle();
  assert.equal(h.commands[0].type, 'sync-join'); assert.equal(h.commands[0].key, 'synthetic-code'); assert.equal(h.commands[0].accepted, true);
  assert.equal(h.commands.some(command => command.type === 'sync-reveal-key'), false);
});

test('sync dialogs use showModal, focus the safe action and guard cancellation while pending', () => {
  const h = settingsHarness(); let shown = 0, safeFocus = 0, closed = 0, dismissed = 0;
  const props = { title: 'syncNoticeTitle', hint: 'syncNotice', language: 'en', pending: false, onClose() { dismissed++; }, children: null };
  const tree = h.renderDialog(props);
  tree.props.ref.current = { open: true, showModal() { shown++; }, close() { closed++; }, querySelector(selector) { assert.equal(selector, '[data-safe-action]'); return { focus() { safeFocus++; } }; } };
  const cleanup = h.effects[0](); assert.equal(shown, 1); assert.equal(safeFocus, 1);
  tree.props.onCancel({ preventDefault() {} }); assert.equal(dismissed, 1);
  h.renderDialog({ ...props, pending: true }).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(dismissed, 1);
  cleanup(); assert.equal(closed, 1);
});

function focusTarget(h) {
  return Object.assign(new h.globals.HTMLElement(), { isConnected: true, disabled: false, matches(selector) { assert.equal(selector, ':disabled'); return this.disabled; }, focus() { if (this.isConnected && !this.disabled) h.globals.document.activeElement = this; } });
}

test('sync focus prefers an available opener, otherwise the first connected enabled non-inert control', () => {
  const opener = { isConnected: true, disabled: false }, syncNow = { isConnected: true, disabled: false }, showCode = { isConnected: true, disabled: false };
  assert.equal(syncFocusTarget(opener, [syncNow, showCode]), opener);
  opener.isConnected = false; assert.equal(syncFocusTarget(opener, [syncNow, showCode]), syncNow);
  opener.isConnected = true; opener.disabled = true; syncNow.disabled = true;
  assert.equal(syncFocusTarget(opener, [syncNow, showCode]), showCode);
  assert.equal(syncFocusTarget(null, [{ isConnected: false }, { isConnected: true, inert: true }, showCode]), showCode);
  showCode.disabled = true; assert.equal(syncFocusTarget(opener, [syncNow, showCode]), null);
  assert.equal(syncFocusTarget(null, []), null);
});

test('Escape restores each confirmation opener after removal and Done restores Show code', async () => {
  for (const label of ['Show code', 'Leave sync']) {
    const h = settingsHarness(); h.state.sync.configured = true;
    const opener = focusTarget(h); opener.focus();
    button(rowControls(h.render()), label).props.onClick({ currentTarget: opener });
    const d = settingsHarness().renderDialog(dialog(h.render()).props);
    const inside = focusTarget(h); inside.focus();
    d.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(h.globals.document.activeElement, inside);
    assert.equal(dialog(h.render()), undefined); h.flushFocus();
    assert.equal(h.globals.document.activeElement, opener);
  }
  const h = settingsHarness(); h.state.sync.configured = true;
  const opener = focusTarget(h);
  button(rowControls(h.render()), 'Show code').props.onClick({ currentTarget: opener });
  button(h.render(), 'Show code').props.onClick(); await h.settle();
  button(h.render(), 'Done').props.onClick(); h.render(); h.flushFocus();
  assert.equal(h.globals.document.activeElement, opener);
});

test('setup Done and joining retain focus through pulses starting before or after restoration', async () => {
  for (const join of [false, true]) for (const pulse of ['none', 'before', 'after']) for (const connected of [false, true]) {
    const h = settingsHarness(), opener = focusTarget(h), next = focusTarget(h), fallback = focusTarget(h);
    let tree = h.render(); tree.props.ref.current = {
      closest(selector) { assert.equal(selector, '[inert]'); return null; },
      querySelectorAll(selector) { assert.equal(selector, 'button:not(:disabled)'); return next.disabled ? [fallback] : [next, fallback]; },
    };
    button(rowControls(tree), join ? 'Join with a code' : 'Set up sync').props.onClick({ currentTarget: opener });
    button(h.render(), 'Continue').props.onClick();
    if (join) {
      find(h.render(), node => node.type === 'input')[0].props.onChange({ target: { value: 'synthetic-code' } });
      button(h.render(), 'Continue').props.onClick();
    }
    await h.settle(); opener.isConnected = connected; opener.disabled = true;
    h.state.sync.syncing = next.disabled = pulse === 'before';
    tree = h.render(); h.flushFocus();
    if (!join) {
      assert.notEqual(h.globals.document.activeElement, next);
      button(tree, 'Done').props.onClick(); tree = h.render(); h.flushFocus();
    }
    assert.equal(dialog(tree), undefined);
    assert.equal(button(rowControls(tree), 'Show code').props.disabled, false);
    assert.equal(h.globals.document.activeElement, pulse === 'before' ? fallback : next);
    if (pulse === 'after') {
      h.state.sync.syncing = next.disabled = true; h.globals.document.activeElement = h.globals.document.body;
      h.render(); h.flushFocus(); assert.equal(h.globals.document.activeElement, fallback);
    }
    h.state.sync.syncing = next.disabled = false; h.render(); h.flushFocus();
    assert.equal(h.globals.document.activeElement, pulse === 'none' ? next : fallback);
    const moved = focusTarget(h); moved.focus();
    h.state.sync.syncing = next.disabled = true; h.render(); h.flushFocus();
    h.state.sync.syncing = next.disabled = false; h.render(); h.flushFocus();
    assert.equal(h.globals.document.activeElement, moved);
  }
});

test('a blocked restoration waits for an enabled control and successful native focus outside inert content', () => {
  const h = settingsHarness(), opener = focusTarget(h), next = focusTarget(h);
  h.state.sync.configured = true;
  let controls = [], inert = true, acceptFocus = false;
  const tree = h.render(); tree.props.ref.current = { closest() { return inert ? {} : null; }, querySelectorAll() { return controls; } };
  button(rowControls(tree), 'Show code').props.onClick({ currentTarget: opener });
  dialog(h.render()).props.onClose(); opener.isConnected = false; h.globals.document.activeElement = h.globals.document.body;
  const focus = next.focus; next.focus = () => { if (acceptFocus) focus.call(next); };
  controls = [next]; h.render(); h.flushFocus(); assert.equal(h.globals.document.activeElement, h.globals.document.body);
  inert = false; controls = []; h.render(); h.flushFocus(); assert.equal(h.globals.document.activeElement, h.globals.document.body);
  controls = [next]; h.render(); h.flushFocus(); assert.equal(h.globals.document.activeElement, h.globals.document.body);
  acceptFocus = true; h.render(); h.flushFocus(); assert.equal(h.globals.document.activeElement, next);
});

test('a wrong join code stays in the invalid focused field with its cause and Continue retries', async () => {
  for (const language of ['en', 'es']) {
    const h = settingsHarness(), t = key => copy[key][language];
    h.globals.window.horizon.command = async command => { h.commands.push(command); throw new Error('SYNC_WRONG_KEY'); };
    button(rowControls(h.render(language)), t('syncJoin')).props.onClick({ currentTarget: focusTarget(h) });
    button(h.render(language), t('syncContinue')).props.onClick();
    let tree = h.render(language), field = find(tree, node => node.type === 'input')[0], target = focusTarget(h);
    field.props.ref.current = target; field.props.onChange({ target: { value: ' synthetic-wrong-code ' } });
    button(h.render(language), t('syncContinue')).props.onClick(); await h.settle();
    tree = h.render(language); h.flushFocus(); field = find(tree, node => node.type === 'input')[0];
    assert.equal(field.props.value, ' synthetic-wrong-code '); assert.equal(field.props['aria-invalid'], true);
    const cause = find(tree, node => node.props?.id === field.props['aria-describedby'])[0];
    assert.equal(cause.props.children, t('SYNC_WRONG_KEY')); assert.equal(h.globals.document.activeElement, target);
    assert.equal(button(tree, t('retry')), undefined); assert.ok(button(tree, t('cancel')));
    button(tree, t('syncContinue')).props.onClick(); await h.settle();
    assert.equal(h.commands.length, 2); assert.ok(h.commands.every(command => command.type === 'sync-join' && command.key === 'synthetic-wrong-code'));
  }
});

test('saving a shown code uses the native command without sending the code or a path', async () => {
  const h = settingsHarness(); h.state.sync.configured = true;
  button(rowControls(h.render()), 'Show code').props.onClick({ currentTarget: {} });
  button(h.render(), 'Show code').props.onClick(); await h.settle();
  const command = h.globals.window.horizon.command;
  h.globals.window.horizon.command = async value => { await command(value); return value.type === 'sync-save-key'; };
  button(h.render(), 'Save as file').props.onClick(); await h.settle();
  assert.equal(JSON.stringify(h.commands.at(-1)), '{"type":"sync-save-key"}');
  assert.ok(JSON.stringify(find(h.render(), node => node.props?.role === 'status')).includes(copy.syncCodeSaved.en));
});

test('Copy selects the displayed code during the click and reports a refused copy in place', async () => {
  const h = settingsHarness(); h.state.sync.configured = true;
  button(rowControls(h.render()), 'Show code').props.onClick({ currentTarget: {} }); button(h.render(), 'Show code').props.onClick(); await h.settle();
  let selected = false, focused = false, allowed = true;
  const input = find(h.render(), node => node.type === 'input' && node.props.readOnly)[0];
  input.props.ref.current = { focus() { focused = true; }, select() { selected = true; } };
  h.globals.document.execCommand = action => { assert.equal(action, 'copy'); assert.equal(selected && focused, true); return allowed; };
  button(h.render(), 'Copy').props.onClick(); assert.equal(selected, true); await h.settle();
  assert.ok(JSON.stringify(find(h.render(), node => node.props?.role === 'status')).includes(copy.syncCodeCopied.en));
  allowed = false; button(h.render(), 'Copy').props.onClick(); await h.settle();
  assert.ok(JSON.stringify(find(h.render(), node => node.props?.role === 'alert')).includes(copy.syncCopyFailed.en));
  assert.equal(button(h.render(), 'Try again').props.disabled, false);
});

test('leave confirms first and defaults to keeping this computer files', async () => {
  for (const remove of [false, true]) {
    const h = settingsHarness(); h.state.sync.configured = true;
    button(rowControls(h.render()), 'Leave sync').props.onClick({ currentTarget: {} });
    let tree = h.render(); assert.equal(h.commands.length, 0);
    const checkbox = find(tree, node => node.type === 'input' && node.props.type === 'checkbox')[0]; assert.equal(checkbox.props.checked, false);
    assert.equal(button(tree, 'Keep syncing').props['data-safe-action'], true);
    if (remove) checkbox.props.onChange({ target: { checked: true } });
    tree = h.render(); button(tree, 'Leave sync').props.onClick(); await h.settle();
    assert.equal(JSON.stringify(h.commands[0]), JSON.stringify({ type: 'sync-leave', removeOwnFiles: remove }));
  }
});

test('a folder picker failure stays in place and retry repeats only the accepted setup', async () => {
  const h = settingsHarness();
  h.globals.window.horizon.command = async value => { h.commands.push(value); throw new Error('SYNC_CANCELLED'); };
  button(rowControls(h.render()), 'Set up sync').props.onClick({ currentTarget: {} }); button(h.render(), 'Continue').props.onClick(); await h.settle();
  let tree = h.render(); assert.ok(JSON.stringify(find(tree, node => node.props?.role === 'alert')).includes(copy.SYNC_CANCELLED.en));
  button(tree, 'Try again').props.onClick(); await h.settle();
  assert.equal(h.commands.length, 2); assert.ok(h.commands.every(command => command.type === 'sync-create' && command.accepted === true));
});

test('a first pulse failure still shows the new code and retry pulses without creating another dataset', async () => {
  const h = settingsHarness(), command = h.globals.window.horizon.command;
  h.globals.window.horizon.command = async value => { const result = await command(value); if (value.type === 'sync-create') { h.state.sync.failure = 'SYNC_FOLDER'; throw new Error('SYNC_FOLDER'); } if (value.type === 'sync-now') h.state.sync.failure = null; return result; };
  button(rowControls(h.render()), 'Set up sync').props.onClick({ currentTarget: {} }); button(h.render(), 'Continue').props.onClick(); await h.settle();
  let tree = h.render(); assert.equal(dialog(tree).props.title, 'syncCodeTitle'); assert.equal(h.commands[1].type, 'sync-reveal-key');
  button(tree, 'Try again').props.onClick(); await h.settle();
  assert.equal(h.commands[2].type, 'sync-now'); assert.equal(h.commands.filter(command => command.type === 'sync-create').length, 1);
});

test('all seven sync switches apply immediately and conflicts expose deletion, restore and dismiss', async () => {
  const h = settingsHarness(); h.state.sync.configured = true;
  h.state.sync.conflicts = [{ id: randomUUID(), item: 'favorites', title: 'Synthetic favorite', computer: { name: 'Synthetic computer' }, time: 100000, deleted: true }];
  const tree = h.render(), rows = find(tree, node => typeof node.props?.children === 'function' && typeof node.props?.title === 'string');
  const switches = rows.flatMap(row => flat(row.props.children('switch-id', async command => { h.commands.push(command); }, false))).filter(node => node.type === 'Switch');
  assert.equal(switches.length, 7); assert.equal(switches[1].props.checked, false);
  switches[1].props.onChange(true); assert.equal(JSON.stringify(h.commands[0]), '{"type":"sync-set-item","item":"history","enabled":true}');
  assert.ok(JSON.stringify(tree).includes(copy.syncDeletedVersion.en));
  button(tree, 'Restore').props.onClick(); await h.settle(); assert.equal(h.commands.at(-1).type, 'sync-restore-conflict');
  button(h.render(), 'Dismiss').props.onClick(); await h.settle(); assert.equal(h.commands.at(-1).type, 'sync-dismiss-conflict');
});
