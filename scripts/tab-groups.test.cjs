const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { validateCommand } = require('../dist/electron/commands.js');
const { validateSession, migrateSession, restoreSession, readWindowSessions, writeWindowSessions } = require('../dist/electron/session-store.js');
const { contiguousTabGroups, moveGroupedTab, groupBoundaryIndex, nearestVisibleTab, tabRuns, visibleTabs } = require('../dist/src/shared/tab-groups.js');

const group = (name = '', folded = false) => ({ id: randomUUID(), name, color: 'success', icon: null, folded });
const tab = (groupId = null, url = 'https://example.com/') => ({ url, title: 'Page', zoom: 1, entries: [{ url, title: 'Page' }], index: 0, groupId });

test('group commands require exact shapes, bounded fields and published icon names', () => {
  const id = randomUUID();
  for (const command of [
    { type: 'create-tab-group', id: 'tab' }, { type: 'add-tab-to-group', id: 'tab', group: id }, { type: 'remove-tab-from-group', id: 'tab' },
    { type: 'update-tab-group', id, name: '', color: '#Ab09dF', icon: 'plane' }, { type: 'update-tab-group', id, icon: null },
    { type: 'update-tab-group', id, name: 'Viaje' }, { type: 'set-tab-group-folded', id, folded: true },
    { type: 'open-tab-group-editor', id }, { type: 'close-tab-group-editor', id },
  ]) { assert.deepEqual(validateCommand(command), command); assert.throws(() => validateCommand({ ...command, extra: true })); }
  for (const fields of [{}, { name: 'x'.repeat(81) }, { name: 'bad\nname' }, { name: null }, { color: '#abc' }, { color: '#12345678' }, { color: 'purple' }, { icon: 'not-a-lucide-icon' }, { icon: 'Plane' }, { icon: {} }, { icon: undefined }]) {
    assert.throws(() => validateCommand({ type: 'update-tab-group', id, ...fields }));
  }
  for (const command of [{ type: 'set-tab-group-folded', id, folded: 1 }, { type: 'set-tab-group-folded', id }, { type: 'add-tab-to-group', id: 'tab', group: '../escape' }, { type: 'open-tab-group-editor', id: 'unknown' }]) assert.throws(() => validateCommand(command));
});

test('grouped session schema rejects duplicate, empty, scattered, unknown and active folded groups', () => {
  const first = group('Trip'), second = group('', true);
  const sample = { version: 3, tabs: [tab(first.id), tab(first.id), tab(), tab(second.id)], active: 0, closed: [{ ...tab(), position: 0 }], groups: [first, second] };
  assert.equal(validateSession(sample), true);
  for (const mutate of [
    value => { value.groups.push(group()); }, value => { value.groups.push(value.groups[0]); }, value => { value.groups[0].extra = true; },
    value => { value.groups[0].icon = 'Not Kebab Case'; }, value => { value.groups[0].icon = 'x'.repeat(65); }, value => { value.groups[0].icon = {}; }, value => { value.groups[0].folded = true; }, value => { value.tabs[0].groupId = randomUUID(); },
    value => { delete value.tabs[0].groupId; }, value => { value.tabs[1].groupId = null; value.tabs[2].groupId = first.id; },
    value => { value.closed[0].groupId = first.id; }, value => { value.version = 1; }, value => { delete value.groups; },
  ]) { const value = structuredClone(sample); mutate(value); assert.equal(validateSession(value), false); }
  const restored = restoreSession({ ...sample, tabs: [tab(first.id, 'file:///unsafe'), tab(second.id)], active: 0, groups: [first, second] }, () => false);
  const renamed = structuredClone(sample); renamed.groups[0].icon = 'removed-from-a-later-lucide';
  assert.equal(validateSession(renamed), true); assert.equal(restoreSession(renamed, () => false).groups[0].icon, null);
  const plane = structuredClone(sample); plane.groups[0].icon = 'plane'; assert.equal(restoreSession(plane, () => false).groups[0].icon, 'plane');
  assert.equal(restored.groups.length, 1); assert.equal(restored.groups[0].id, second.id); assert.equal(restored.groups[0].folded, false);
  assert.equal(validateSession(restored), true);
});

test('legacy sessions migrate without changing navigation or closed tab ordering', () => {
  const current = tab(); delete current.groupId;
  const legacy = { version: 1, tabs: [current], active: 0, closed: [{ ...current, position: 7 }] }, before = structuredClone(legacy), migrated = migrateSession(legacy);
  assert.equal(validateSession(legacy), true); assert.equal(validateSession(migrated), true);
  assert.deepEqual(migrated, { version: 3, tabs: [{ ...current, groupId: null }], active: 0, closed: [{ ...current, position: 7, groupId: null }], groups: [] });
  assert.deepEqual(legacy, before); assert.deepEqual(migrateSession(migrated), migrated);
});

test('group ordering appends additions and places removals beyond their former contiguous block', () => {
  const first = group(), second = group();
  const tabs = [{ id: 'a', groupId: first.id }, { id: 'b', groupId: first.id }, { id: 'c', groupId: null }, { id: 'd', groupId: second.id }, { id: 'e', groupId: second.id }];
  assert.equal(groupBoundaryIndex(tabs, 1), 2); assert.equal(groupBoundaryIndex(tabs, 4), 5);
  moveGroupedTab(tabs, tabs[2], first.id); assert.deepEqual(tabs.map(tab => tab.id), ['a', 'b', 'c', 'd', 'e']);
  moveGroupedTab(tabs, tabs[0], null); assert.deepEqual(tabs.map(tab => tab.id), ['b', 'c', 'a', 'd', 'e']);
  moveGroupedTab(tabs, tabs[0], second.id); assert.deepEqual(tabs.map(tab => tab.id), ['c', 'a', 'd', 'e', 'b']);
  assert.equal(contiguousTabGroups(tabs, [first, second]), true);
  second.folded = true;
  assert.equal(nearestVisibleTab(tabs, [first, second], 3), 1);
  assert.equal(nearestVisibleTab(tabs, [first, second], 0, first.id), 1);
  tabs[1].groupId = first.id; assert.equal(nearestVisibleTab(tabs, [first, second], 0, first.id), -1);
});

test('the strip draws each group as one run and leaves folded groups out of the visible tabs', () => {
  const first = group('Trip'), second = group('', true);
  const tabs = [{ id: 'a', groupId: null }, { id: 'b', groupId: first.id }, { id: 'c', groupId: first.id }, { id: 'd', groupId: second.id }, { id: 'e' }];
  assert.deepEqual(tabRuns(tabs, [first, second]).map(run => [run.group?.id ?? null, run.tabs.map(tab => tab.id)]), [[null, ['a']], [first.id, ['b', 'c']], [second.id, ['d']], [null, ['e']]]);
  assert.deepEqual(visibleTabs(tabs, [first, second]).map(tab => tab.id), ['a', 'b', 'c', 'e']);
  assert.deepEqual(visibleTabs(tabs, []).map(tab => tab.id), ['a', 'b', 'c', 'd', 'e']);
});

module.exports = ({ notebookBrowser, authenticatedCipher, fireTimers, interfaceModule, interfaceChildren }) => {
  const groupsModule = (react = {}, globals = {}) => interfaceModule('src/TabGroups.tsx', { react, 'lucide-react': {}, './copy': interfaceModule('src/copy.ts'), './shared/api': require('../dist/src/shared/api.js'), './shared/group-colors': require('../dist/src/shared/group-colors.js'), './shared/group-icon-search': require('../dist/src/shared/group-icon-search.js'), './shared/group-icon-tags': require('../dist/src/shared/group-icon-tags.js'), './shared/group-icon-spanish': require('../dist/src/shared/group-icon-spanish.js'), './shared/tab-groups': require('../dist/src/shared/tab-groups.js'), './PopupAnchor': { PopupAnchor: 'anchor' }, './tab-groups.css': {} }, globals);
  test('an unnamed group reads as its colour in both languages and a named one as its trimmed name', () => {
    const { groupDisplayName } = groupsModule(), named = group('  Trip  ');
    assert.equal(groupDisplayName(named, 'en'), 'Trip');
    for (const [color, en, es] of [['success', 'Green', 'Verde'], ['soft', 'Muted grey', 'Gris suave'], ['title', 'Neutral', 'Neutro'], ['#a012cc', 'Custom #a012cc', 'Personalizado #a012cc']]) {
      assert.equal(groupDisplayName({ ...group(), color }, 'en'), en); assert.equal(groupDisplayName({ ...group('   '), color }, 'es'), es);
    }
  });

  test('tab menu rows add a tab to another group or remove it from its own, then put focus back on the replaced tab button', async () => {
    const { TabGroupMenuItems } = groupsModule(), target = group('Trip'), other = group('Cooking'), commands = [], closed = [], focused = [];
    let outcome = true;
    const render = (tab, groups = [target]) => interfaceChildren(TabGroupMenuItems({ tab, groups, palette: {}, language: 'en', close: (...focus) => closed.push(focus), focusTab: id => focused.push(id), run: async command => { commands.push(command); return outcome; } }));
    const [separator, create, row] = render({ id: 'page', groupId: null });
    assert.equal(separator.type, 'hr'); assert.equal(create.props.role, 'menuitem'); assert.equal(render({ id: 'page', groupId: null }).length, 3);
    create.props.onClick(); await Promise.resolve();
    assert.deepEqual(commands, [{ type: 'create-tab-group', id: 'page' }]); assert.deepEqual(closed, [[]]); assert.deepEqual(focused, []);
    row.props.onChoose(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(commands.at(-1), { type: 'add-tab-to-group', id: 'page', group: target.id }); assert.deepEqual(focused, ['page']);
    const grouped = render({ id: 'page', groupId: target.id }), remove = grouped.at(-1);
    assert.equal(grouped.length, 3); remove.props.onClick(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(commands.at(-1), { type: 'remove-tab-from-group', id: 'page' }); assert.deepEqual(focused, ['page', 'page']);
    outcome = false; remove.props.onClick(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(focused, ['page', 'page']);
    const groupRows = rows => rows.filter(node => node.props.group).map(node => node.props.group.id);
    assert.deepEqual(groupRows(render({ id: 'page', groupId: null }, [target, other])), [target.id, other.id]);
    const sibling = render({ id: 'page', groupId: target.id }, [target, other]);
    assert.deepEqual(groupRows(sibling), [other.id]); assert.equal(sibling.length, 4); assert.equal(sibling.at(-1).props.role, 'menuitem'); assert.equal(sibling.at(-1).props.group, undefined);
  });

  // The component functions run here with a hand-made hooks runtime: state, refs and effects live in named scopes, and a test renders again after it acts.
  const fakeReact = () => {
    const scopes = new Map(); let scope;
    const react = {
      useState(initial) { const index = scope.cursor++; scope.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; const slot = scope.slots[index]; return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
      useRef(current) { const index = scope.cursor++; scope.slots[index] ??= { current }; return scope.slots[index]; },
      useMemo(compute) { scope.cursor++; return compute(); },
      useEffect(effect, dependencies) {
        const target = scope, index = scope.cursor++, before = target.slots[index];
        if (!before || !dependencies || dependencies.some((value, position) => !Object.is(value, before.dependencies?.[position]))) target.effects.push(() => { before?.cleanup?.(); target.slots[index] = { dependencies, cleanup: effect() }; });
      },
    };
    react.useLayoutEffect = react.useEffect;
    return { react, render(name, callback) { scope = scopes.get(name) ?? { slots: [], effects: [], cursor: 0 }; scopes.set(name, scope); scope.cursor = 0; return callback(); }, flush() { for (const entry of scopes.values()) entry.effects.splice(0).forEach(effect => effect()); } };
  };
  const flat = value => [value].flat(Infinity).filter(item => item !== null && item !== undefined && typeof item !== 'boolean');
  const find = (node, predicate) => flat(node).flatMap(item => typeof item === 'object' ? [...(predicate(item) ? [item] : []), ...find(item.props?.children, predicate)] : []);
  const amber = { chrome: '#121110', wash: '#2a2117', colors: { success: '#8fc7a0', info: '#a3b2dc', primary: '#dda15a', error: '#e5938c', warning: '#d9b770', soft: '#a69c92', title: '#ece4dc', dim: '#9b9187' } };
  const editorHarness = () => {
    const hooks = fakeReact(), commands = [], timers = [], delays = [], frames = [], dismissed = [];
    const globals = { document: { addEventListener() {}, removeEventListener() {}, activeElement: null }, window: { setTimeout(callback, delay) { delays.push(delay); timers.push(callback); return timers.length; }, clearTimeout(id) { timers[id - 1] = null; } }, requestAnimationFrame: callback => frames.push(callback), cancelAnimationFrame() {} };
    const { GroupEditor } = groupsModule(hooks.react, globals), target = { id: 'g', name: '', color: 'success', icon: null, folded: false };
    const harness = { hooks, commands, delays, dismissed, target, document: globals.document, group: target, language: 'en',
      run: async command => { commands.push(command); return true; },
      render() { return hooks.render('editor', () => GroupEditor({ group: harness.group, language: harness.language, palette: amber, opener: { current: null }, run: harness.run, onDismiss: focus => dismissed.push(focus) })); },
      async settle() { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve)); },
      paint() { frames.splice(0).forEach(callback => callback()); },
      async open() { harness.render(); hooks.flush(); await harness.settle(); return harness; },
      type(value) { find(harness.render(), node => node.props.id === 'group-icon-search')[0].props.onChange({ target: { value } }); harness.render(); hooks.flush(); timers.filter(Boolean).at(-1)(); return harness.render(); },
    };
    return harness;
  };
  const choices = tree => find(tree, node => node.props.className === 'group-icon-choice');
  const countLine = tree => flat(find(tree, node => node.props.className === 'group-icon-count')[0].props.children)[0];
  const action = (tree, label) => find(tree, node => node.type === 'button' && (node.props['aria-label'] === label || flat(node.props.children).includes(label)))[0];

  test('the editor searches both languages after the debounce, pages through results and applies each choice as it is made', async () => {
    const h = await editorHarness().open();
    let tree = h.render();
    assert.equal(choices(tree).length, 8); assert.equal(countLine(tree), '1854 icons'); assert.equal(choices(tree)[0].props['aria-label'], 'a arrow down');
    assert.deepEqual(choices(tree).map(node => node.props.tabIndex), [0, -1, -1, -1, -1, -1, -1, -1]);
    tree = h.type('plane');
    assert.ok(h.delays.every(delay => delay >= 200 && delay <= 300)); assert.equal(choices(tree).length, 8); assert.equal(choices(tree)[0].props['aria-label'], 'plane');
    assert.match(countLine(tree), /^\d+ icons for “plane”$/); assert.ok(action(tree, 'Next icons')); assert.equal(action(tree, 'Previous icons'), undefined);
    action(tree, 'Next icons').props.onClick(); tree = h.render();
    assert.ok(choices(tree).length > 0 && choices(tree).length < 8); assert.ok(action(tree, 'Previous icons')); assert.equal(action(tree, 'Next icons'), undefined);
    choices(tree)[1].props.onClick(); await h.settle();
    assert.deepEqual(h.commands.at(-1), { type: 'update-tab-group', id: 'g', icon: choices(tree)[1].props['data-group-icon'] });
    choices(tree)[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }); await h.settle(); tree = h.render();
    assert.deepEqual(h.commands.at(-1), { type: 'update-tab-group', id: 'g', icon: choices(tree)[1].props['data-group-icon'] });
    h.group = { ...h.target, icon: 'plane' }; tree = h.render();
    action(tree, 'No icon').props.onClick(); await h.settle(); assert.deepEqual(h.commands.at(-1), { type: 'update-tab-group', id: 'g', icon: null });
    h.language = 'es'; tree = h.type('avion');
    assert.equal(choices(tree)[0].props['aria-label'], 'avión'); assert.match(countLine(tree), /^\d+ íconos para «avion»$/);
    assert.notEqual(action(tree, 'Sin ícono'), undefined);
  });

  test('the editor says when nothing matches, clears the search from there, and keeps typed names and invalid ones apart', async () => {
    const h = await editorHarness().open();
    let tree = h.type('zzzzqq');
    const empty = find(tree, node => node.props.className === 'group-icon-empty');
    assert.equal(empty.length, 1); assert.equal(flat(find(empty[0], node => node.type === 'p')[0].props.children).at(-1), 'No icons match this search.'); assert.equal(choices(tree).length, 0);
    action(tree, 'Clear search').props.onClick(); tree = h.render();
    assert.equal(choices(tree).length, 8); assert.equal(find(tree, node => node.props.id === 'group-icon-search')[0].props.value, '');
    const name = find(tree, node => node.props.id === 'group-name')[0];
    name.props.onChange({ target: { value: 'Trip' } }); await h.settle();
    assert.deepEqual(h.commands.at(-1), { type: 'update-tab-group', id: 'g', name: 'Trip' });
    const sent = h.commands.length; name.props.onChange({ target: { value: 'bad\u0007' } }); tree = h.render();
    assert.equal(h.commands.length, sent); assert.equal(find(tree, node => node.props.id === 'group-name')[0].props['aria-invalid'], true); assert.equal(find(tree, node => node.props.role === 'alert').length, 1);
    name.props.onChange({ target: { value: 'Trip 2' } }); tree = h.render();
    assert.equal(find(tree, node => node.props.id === 'group-name')[0].props['aria-invalid'], false); assert.equal(find(tree, node => node.props.role === 'alert').length, 0);
  });

  test('colour choices apply at once, the custom swatch opens the picker and Escape closes the picker before the editor', async () => {
    const h = await editorHarness().open();
    let tree = h.render();
    const swatches = () => find(h.render(), node => typeof node.type === 'function' && typeof node.props.onChoose === 'function');
    assert.equal(swatches().length, 9); assert.deepEqual(swatches().map(node => node.props.checked), [true, false, false, false, false, false, false, false, false]);
    swatches()[1].props.onChoose(); await h.settle(); assert.deepEqual(h.commands.at(-1), { type: 'update-tab-group', id: 'g', color: 'info' });
    const focused = []; swatches()[7].props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, currentTarget: { parentElement: { querySelectorAll: () => Array.from({ length: 9 }, (_, index) => ({ focus() { focused.push(index); } })) } } });
    await h.settle(); assert.deepEqual(focused, [8]); assert.deepEqual(h.commands.at(-1), { type: 'update-tab-group', id: 'g', color: 'info' }); assert.equal(swatches()[8].props.expanded, false);
    swatches()[8].props.onChoose(); await h.settle(); assert.deepEqual(h.commands.at(-1), { type: 'update-tab-group', id: 'g', color: '#8fc7a0' });
    tree = h.render(); assert.equal(swatches()[8].props.expanded, true); assert.equal(swatches()[8].props.custom, true);
    const picker = find(tree, node => typeof node.type === 'function' && 'pickerRef' in node.props)[0];
    assert.ok(picker); assert.equal(picker.props.color, '#8fc7a0');
    const editor = find(tree, node => node.props.className === 'group-editor')[0], key = { key: 'Escape', preventDefault() {}, stopPropagation() {} };
    editor.props.onKeyDown(key); tree = h.render(); assert.deepEqual(h.dismissed, []); assert.equal(find(tree, node => typeof node.type === 'function' && 'pickerRef' in node.props).length, 0);
    find(tree, node => node.props.className === 'group-editor')[0].props.onKeyDown(key); assert.deepEqual(h.dismissed, [true]);
  });

  test('Tab at the edge of the editor or the picker hands focus back instead of leaving at the start of the document', async () => {
    const h = await editorHarness().open(), stops = [{ id: 'first' }, { id: 'middle' }, { id: 'last' }];
    const press = (shiftKey, activeElement, target) => {
      h.document.activeElement = activeElement; let prevented = false;
      target.props.onKeyDown({ key: 'Tab', shiftKey, currentTarget: { querySelectorAll: () => stops }, preventDefault() { prevented = true; }, stopPropagation() {} });
      return prevented;
    };
    const editor = () => find(h.render(), node => node.props.className === 'group-editor')[0];
    assert.equal(press(false, stops[1], editor()), false); assert.deepEqual(h.dismissed, []);
    assert.equal(press(false, stops[2], editor()), true); assert.deepEqual(h.dismissed, [true]);
    assert.equal(press(true, stops[0], editor()), true); assert.deepEqual(h.dismissed, [true, true]);
    assert.equal(press(true, stops[1], editor()), false); assert.deepEqual(h.dismissed, [true, true]);
    find(h.render(), node => typeof node.props.onChoose === 'function' && node.props.custom)[0].props.onChoose(); await h.settle();
    const picker = find(h.render(), node => typeof node.type === 'function' && 'pickerRef' in node.props)[0], closed = [];
    const root = () => find(h.hooks.render('picker', () => picker.type({ ...picker.props, onClose: () => closed.push('closed') })), node => node.props.id === 'group-color-picker')[0];
    assert.equal(press(false, stops[2], root()), true); assert.deepEqual(closed, ['closed']);
    assert.equal(press(true, stops[0], root()), true); assert.deepEqual(closed, ['closed', 'closed']);
    assert.equal(press(false, stops[0], root()), false); assert.deepEqual(closed, ['closed', 'closed']);
  });

  test('the picker moves colour with the keys, takes a hex value with or without the hash and reports a bad one in place', async () => {
    const h = await editorHarness().open();
    find(h.render(), node => typeof node.props.onChoose === 'function' && node.props.custom)[0].props.onChoose(); await h.settle();
    const picker = find(h.render(), node => typeof node.type === 'function' && 'pickerRef' in node.props)[0], sent = [];
    const view = () => h.hooks.render('picker', () => picker.type({ ...picker.props, onColor: color => sent.push(color), onClose: () => sent.push('closed') }));
    let tree = view(); h.hooks.flush();
    const hexLabel = find(tree, node => node.props.htmlFor === 'group-hex')[0];
    assert.equal(hexLabel.props.className, 'visually-hidden'); assert.equal(hexLabel.props.children, 'Hex (#RRGGBB)');
    const { hexToHSV, hsvToHex } = require('../dist/src/shared/group-colors.js'), before = hexToHSV('#8fc7a0');
    find(tree, node => node.props.className === 'group-color-area')[0].props.onKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault() {} }); h.paint();
    assert.deepEqual(sent, [hsvToHex({ ...before, s: before.s + 10 })]);
    tree = view(); assert.equal(find(tree, node => node.props.className === 'group-hue')[0].props.value, Math.round(before.h));
    const hex = () => find(view(), node => node.props.id === 'group-hex')[0], error = () => find(view(), node => node.props.id === 'group-hex-error').length;
    hex().props.onChange({ target: { value: '#12' } }); assert.equal(sent.length, 1); hex().props.onBlur(); assert.equal(hex().props['aria-invalid'], true); assert.equal(error(), 1);
    hex().props.onChange({ target: { value: '4FB39A' } }); h.paint();
    assert.equal(sent.at(-1), '#4fb39a'); assert.equal(hex().props.value, '#4fb39a'); assert.equal(hex().props['aria-invalid'], false); assert.equal(error(), 0);
    hex().props.onChange({ target: { value: 'nothex' } }); hex().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.equal(sent.includes('closed'), false); assert.equal(hex().props['aria-invalid'], true);
    hex().props.onChange({ target: { value: '#a012cc' } }); h.paint(); hex().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.equal(sent.at(-1), 'closed'); assert.equal(sent.at(-2), '#a012cc');
    const area = find(view(), node => node.props.className === 'group-color-area')[0], box = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }), focus() {}, setPointerCapture() {}, hasPointerCapture: () => true };
    area.props.onPointerDown({ type: 'pointerdown', button: 0, pointerId: 1, clientX: 110, clientY: 70, currentTarget: box }); h.paint();
    assert.equal(sent.at(-1), hsvToHex({ ...hexToHSV('#a012cc'), s: 50, v: 50 }));
  });

  test('folding clips the tabs away over the token duration, turns around when clicked again mid-motion and skips the motion when reduced', () => {
    const run = async () => true;
    const harness = reduced => {
      const hooks = fakeReact(), animations = [], style = { getPropertyValue: name => ({ '--duration-group-fold': '120ms', '--curve-group-fold': ' cubic-bezier(0.2, 0, 0, 1) ' })[name] ?? '' };
      const { GroupRun } = groupsModule(hooks.react, { getComputedStyle: () => style, matchMedia: () => ({ matches: reduced }) });
      const element = { animate(keyframes, options) { const animation = { keyframes, options, playState: 'running', reversed: false, reverse() { this.reversed = true; }, cancel() { this.playState = 'idle'; } }; animations.push(animation); return animation; } };
      const state = { folded: false };
      const render = () => hooks.render('run', () => GroupRun({ group: { id: 'g', name: 'Trip', color: 'success', icon: null, folded: state.folded }, palette: amber, language: 'en', children: 'tab', editorId: null, editorOpener: { current: null }, run, onEdit() {} }));
      const tabs = tree => find(tree, node => node.props.className === 'tab-group-tabs')[0];
      let tree = render(); hooks.flush(); tabs(tree).props.ref.current = element;
      return { animations, tabs, toggle() { state.folded = !state.folded; tree = render(); hooks.flush(); return render(); }, current: () => render() };
    };
    const motion = harness(false);
    let tree = motion.toggle();
    assert.equal(motion.animations.length, 1); assert.deepEqual(motion.animations[0].keyframes, { clipPath: ['inset(0)', 'inset(0 100% 0 0)'] });
    assert.deepEqual(motion.animations[0].options, { duration: 120, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' });
    assert.equal(motion.tabs(tree).props.hidden, false); assert.equal(motion.tabs(tree).props.inert, true);
    tree = motion.toggle(); assert.equal(motion.animations.length, 1); assert.equal(motion.animations[0].reversed, true); assert.equal(motion.tabs(tree).props.inert, false);
    motion.animations[0].playState = 'finished'; motion.animations[0].onfinish(); assert.equal(motion.tabs(motion.current()).props.hidden, false);
    tree = motion.toggle(); assert.equal(motion.animations.length, 2); assert.deepEqual(motion.animations[1].keyframes, { clipPath: ['inset(0)', 'inset(0 100% 0 0)'] });
    motion.animations[1].playState = 'finished'; motion.animations[1].onfinish(); assert.equal(motion.tabs(motion.current()).props.hidden, true);
    tree = motion.toggle(); assert.equal(motion.animations.length, 3); assert.deepEqual(motion.animations[2].keyframes, { clipPath: ['inset(0 100% 0 0)', 'inset(0)'] }); assert.equal(motion.tabs(tree).props.hidden, false);
    const still = harness(true);
    tree = still.toggle(); assert.equal(still.animations.length, 0); assert.equal(still.tabs(tree).props.hidden, true); assert.equal(still.tabs(tree).props.inert, true);
    tree = still.toggle(); assert.equal(still.animations.length, 0); assert.equal(still.tabs(tree).props.hidden, false);
  });

  test('group runtime edits immediately, orders membership, folds around active tabs and removes empty groups', t => {
    const browser = notebookBrowser(t, authenticatedCipher()), first = browser.state().activeId;
    browser.command({ type: 'create-tab-group', id: first }); const id = browser.state().groups[0].id;
    assert.equal(browser.state().groupEditorId, id); assert.equal(browser.state().groups[0].color, 'success');
    browser.command({ type: 'update-tab-group', id, name: 'Viaje', color: '#a012cc', icon: 'plane' });
    assert.deepEqual(browser.state().groups[0], { id, name: 'Viaje', color: '#a012cc', icon: 'plane', folded: false });
    browser.command({ type: 'close-tab-group-editor', id }); assert.equal(browser.state().groupEditorId, null);
    browser.command({ type: 'open-tab-group-editor', id }); assert.equal(browser.state().groupEditorId, id);
    browser.command({ type: 'new-tab' }); const outside = browser.state().activeId;
    browser.command({ type: 'new-tab' }); const third = browser.state().activeId;
    browser.command({ type: 'add-tab-to-group', id: third, group: id });
    assert.deepEqual(browser.state().tabs.map(tab => tab.id), [first, third, outside]);
    browser.command({ type: 'set-tab-group-folded', id, folded: true }); assert.equal(browser.state().activeId, outside); assert.equal(browser.state().groups[0].folded, true);
    browser.command({ type: 'activate-tab', id: first }); assert.equal(browser.state().groups[0].folded, false);
    browser.command({ type: 'remove-tab-from-group', id: first }); assert.deepEqual(browser.state().tabs.map(tab => tab.id), [third, first, outside]);
    browser.command({ type: 'close-tab', id: third }); assert.deepEqual(browser.state().groups, []); assert.equal(browser.state().groupEditorId, null);
    assert.throws(() => browser.command({ type: 'open-tab-group-editor', id }), /Unknown tab group/); browser.command({ type: 'close-tab-group-editor', id });
    browser.close();
  });

  test('groups persist in their window and profile with folded state and never write from private windows', t => {
    const cipher = authenticatedCipher(), browser = notebookBrowser(t, cipher), first = browser.state().activeId;
    browser.command({ type: 'create-tab-group', id: first }); const id = browser.state().groups[0].id;
    browser.command({ type: 'update-tab-group', id, name: 'Travel', icon: 'map-pin', color: 'info' });
    browser.command({ type: 'set-tab-group-folded', id, folded: true }); assert.equal(browser.state().tabs.length, 2);
    const path = join(browser.directory, 'profiles', browser.state().activeProfileId, 'session.json'); fireTimers(browser.timers, 500);
    const sessions = readWindowSessions(path, cipher, () => false, { readError: false, memoryOnly: false });
    assert.equal(sessions.windows[0].session.version, 3); assert.equal(sessions.windows[0].session.groups[0].folded, true);
    const peer = browser.addWindow({ fresh: true }); assert.deepEqual(peer.state().groups, []);
    const privatePeer = browser.addWindow({ privateWindow: true }); browser.browser.flush(); const bytes = readFileSync(path);
    privatePeer.command({ type: 'create-tab-group', id: privatePeer.state().activeId }); privatePeer.command({ type: 'set-tab-group-folded', id: privatePeer.state().groups[0].id, folded: true });
    privatePeer.browser.flush(); assert.deepEqual(readFileSync(path), bytes);
    privatePeer.close(); peer.close(); browser.close();
    const restored = notebookBrowser(t, cipher, { directory: browser.directory });
    assert.deepEqual(restored.state().groups, [{ id, name: 'Travel', color: 'info', icon: 'map-pin', folded: true }]);
    const otherProfile = restored.state().profiles.find(profile => profile.id !== restored.state().activeProfileId).id;
    restored.command({ type: 'switch-profile', id: otherProfile }); assert.deepEqual(restored.state().groups, []); restored.close();
  });

  test('tab transfer drops group membership and rolls it back when attachment fails', t => {
    const browser = notebookBrowser(t, authenticatedCipher()), peer = browser.addWindow({ fresh: true, empty: true }); browser.navigate(); const first = browser.state().activeId;
    browser.command({ type: 'create-tab-group', id: first }); const id = browser.state().groups[0].id; browser.command({ type: 'new-tab' });
    const before = structuredClone(browser.state().groups);
    peer.window.contentView.addChildView = () => { throw new Error('Synthetic attachment failure'); };
    assert.throws(() => browser.browser.moveTab(first, peer.browser.windowId), /attachment failure/);
    assert.deepEqual(browser.state().groups, before); assert.equal(browser.state().tabs[0].groupId, id);
    peer.window.contentView.addChildView = () => {};
    browser.browser.moveTab(first, peer.browser.windowId);
    assert.deepEqual(browser.state().groups, []); assert.equal(peer.state().tabs[0].groupId, null); assert.deepEqual(peer.state().groups, []);
    peer.close(); browser.close();
  });

  test('folding all tabs creates one outside selection and refuses the tab limit without hiding the active page', t => {
    const browser = notebookBrowser(t), first = browser.state().activeId; browser.command({ type: 'create-tab-group', id: first }); const id = browser.state().groups[0].id;
    browser.command({ type: 'set-tab-group-folded', id, folded: true }); assert.equal(browser.state().tabs.length, 2); assert.equal(browser.state().tabs[1].groupId, null);
    browser.command({ type: 'activate-tab', id: first });
    for (let index = browser.state().tabs.length; index < 200; index++) browser.command({ type: 'new-tab' });
    for (const tab of browser.state().tabs.filter(tab => tab.id !== first)) browser.command({ type: 'add-tab-to-group', id: tab.id, group: id });
    const before = browser.state().activeId; assert.throws(() => browser.command({ type: 'set-tab-group-folded', id, folded: true }), /Tab limit reached/);
    assert.equal(browser.state().activeId, before); assert.equal(browser.state().groups[0].folded, false); assert.equal(browser.state().tabs.length, 200); browser.close();
  });

  test('a saved icon that Lucide no longer lists loads as no icon and the window keeps its tabs', t => {
    const cipher = authenticatedCipher(), browser = notebookBrowser(t, cipher), path = join(browser.directory, 'group-icon.json'), status = { readError: false, memoryOnly: false };
    const trip = { ...group('Trip'), icon: 'removed-from-a-later-lucide' };
    writeWindowSessions(path, { version: 2, windows: [{ id: randomUUID(), selected: true, session: { version: 3, tabs: [tab(trip.id)], active: 0, closed: [], groups: [trip] } }] }, cipher);
    const loaded = readWindowSessions(path, cipher, () => false, status);
    assert.equal(loaded.windows[0].session.tabs.length, 1); assert.deepEqual(loaded.windows[0].session.groups, [{ ...trip, icon: null }]);
    assert.equal(status.readError, false); assert.deepEqual(readdirSync(browser.directory).filter(name => name.includes('corrupt')), []); browser.close();
  });

  test('window session migration writes grouped shape on read and validates later reads', t => {
    const cipher = authenticatedCipher(), browser = notebookBrowser(t, cipher), path = join(browser.directory, 'group-migration.json');
    const current = tab(); delete current.groupId;
    const legacy = { version: 2, windows: [{ id: randomUUID(), selected: true, session: { version: 1, tabs: [current], active: 0, closed: [] } }] };
    writeFileSync(path, JSON.stringify(legacy));
    const status = { readError: false, memoryOnly: false }, migrated = readWindowSessions(path, cipher, () => false, status);
    assert.equal(migrated.windows[0].session.version, 3); assert.deepEqual(migrated.windows[0].session.groups, []); assert.equal(status.readError, false);
    writeWindowSessions(path, migrated, cipher); assert.deepEqual(readWindowSessions(path, cipher, () => false, status), migrated); browser.close();
  });
};
