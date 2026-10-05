const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { compileFunction } = require('node:vm');
const ts = require('typescript');
const { DESKTOP_TAB_DRAG, parseDesktopDrag, readDesktopTransfer } = require('../dist/src/shared/desktop-drag.js');

function expressions() {
  const source = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), result = {};
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ['overTabDrag', 'finishTabDrag', 'closeTabMenu', 'tabMoveReason'].includes(node.name.getText(source))) result[node.name.getText(source)] = node.initializer.getText(source);
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.text === 'className' && attribute.initializer?.text === 'tab-select')) {
      for (const attribute of node.attributes.properties) if (ts.isJsxAttribute(attribute) && ['onPointerDown', 'onPointerUp', 'onPointerCancel', 'onLostPointerCapture', 'onDragEnd', 'onDragStart', 'onKeyDown'].includes(attribute.name.text)) result[attribute.name.text] = attribute.initializer.expression.getText(source);
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0].getText(source).includes("document.addEventListener('keydown', cancel")) result.dragEffect = node.arguments[0].getText(source);
    if (ts.isJsxExpression(node) && node.expression?.getText(source).startsWith('menuTab && <ToolbarPopover')) result.menu = node.expression.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source); return result;
}

function compile(values, globals) {
  const exported = {}, jsx = (type, props) => ({ type, props });
  const source = ts.transpileModule(Object.entries(values).map(([name, expression]) => `export const ${name} = ${expression};`).join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const dependencies = { useCallback: callback => callback, require: name => { assert.equal(name, 'react/jsx-runtime'); return { jsx, jsxs: jsx }; }, ...globals };
  compileFunction(source, ['exports', ...Object.keys(dependencies)])(exported, ...Object.values(dependencies)); return exported;
}

class Transfer {
  constructor() { this.values = new Map(); this.types = []; }
  get dropEffect() { return 'none'; }
  set dropEffect(_value) {}
  get effectAllowed() { return 'none'; }
  set effectAllowed(_value) {}
  setData(type, value) { this.values.set(type, value); this.types = [...this.values.keys()]; }
  getData(type) { return this.values.get(type) ?? ''; }
}
class DragEvent {
  constructor(type, options) {
    this.type = type; this.defaultPrevented = false;
    for (const key of ['bubbles', 'cancelable', 'dataTransfer', 'clientX', 'clientY', 'screenX', 'screenY', 'relatedTarget']) this[key] = options[key];
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() {}
}

function dragHarness(tab = { id: 'page', url: 'https://example.com/', title: 'Example', movable: true }, single = false) {
  const commands = [], callbacks = new Map(), events = [], properties = new Map();
  const state = { activeProfileId: 'profile', tabs: single ? [tab] : [tab, { id: 'other' }] };
  const tabDrag = { current: null }, tabDragClick = { current: null }, tabDragPreview = { current: { style: { setProperty() {} }, remove() { events.push('preview removed'); } } };
  let captured = false, target = null, exported;
  const opener = { style: { setProperty(name, value) { properties.set(name, value); }, removeProperty(name) { properties.delete(name); } },
    setPointerCapture() { captured = true; }, hasPointerCapture() { return captured; }, releasePointerCapture() { captured = false; events.push('capture released'); },
    dispatchEvent(event) { events.push(event.type); if (event.type === 'dragend') exported.onDragEnd(event); return true; },
  };
  const document = { elementFromPoint() { return target; }, addEventListener(name, callback) { callbacks.set(name, callback); }, removeEventListener(name) { callbacks.delete(name); } };
  const globals = { tab, state, tabDrag, tabDragClick, tabDragPreview, DataTransfer: Transfer, DragEvent, document, window: { addEventListener(name, callback) { callbacks.set(name, callback); }, removeEventListener(name) { callbacks.delete(name); } },
    tabStripRef: { current: { getBoundingClientRect: () => ({ left: 0, right: 1000, top: 0, bottom: 40 }) } }, parseDesktopDrag, DESKTOP_TAB_DRAG, run: command => commands.push(command),
    closeTabMenu() {}, overTabDrag: point => exported.overTabDrag(point), finishTabDrag: cancelled => exported.finishTabDrag(cancelled),
  };
  const values = expressions(); delete values.closeTabMenu; delete values.tabMoveReason; delete values.menu;
  exported = compile(values, globals); const cleanup = exported.dragEffect();
  const point = (x = 400, y = 300) => ({ clientX: x, clientY: y, screenX: x + 100, screenY: y + 200, pointerId: 1, button: 0, currentTarget: opener, preventDefault() {} });
  const start = () => { exported.onPointerDown(point(50, 20)); tabDrag.current.started = true; properties.set('cursor', 'grabbing'); };
  return { exported, start, point, state, commands, callbacks, events, tabDrag, properties, cleanup, setTarget(value) { target = value; }, captured: () => captured };
}

test('tab drag opens one window only for an unhandled release outside the strip', () => {
  for (const [x, y, moved] of [[400, 300, true], [400, 20, false], [-1, 20, true], [1000, 40, false]]) {
    const h = dragHarness(); h.start(); h.exported.onPointerUp(h.point(x, y));
    assert.deepEqual(h.commands, moved ? [{ type: 'move-tab-to-window', id: 'page', point: { x: x + 100, y: y + 200 } }] : []);
    assert.equal(h.tabDrag.current, null); assert.equal(h.captured(), false); assert.equal(h.properties.has('cursor'), false);
    assert.ok(h.events.includes('preview removed')); h.cleanup();
  }
});

test('Escape, pointer cancellation, lost capture and blur release every drag resource without a move', () => {
  for (const kind of ['escape', 'pointercancel', 'lostcapture', 'blur']) {
    const h = dragHarness(); h.start(); h.exported.overTabDrag(h.point());
    if (kind === 'escape') { let prevented = false; h.callbacks.get('keydown')({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} }); assert.equal(prevented, true); }
    else if (kind === 'blur') h.callbacks.get('blur')();
    else h.exported[kind === 'pointercancel' ? 'onPointerCancel' : 'onLostPointerCapture']();
    assert.deepEqual(h.commands, []); assert.equal(h.tabDrag.current, null); assert.equal(h.captured(), false); assert.equal(h.properties.has('cursor'), false);
    assert.ok(h.events.includes('preview removed')); h.exported.onPointerUp(h.point()); assert.deepEqual(h.commands, []);
    h.cleanup(); assert.equal(h.callbacks.size, 0);
  }
});

test('single-tab windows keep Desktop copy data but never start a window move', () => {
  const h = dragHarness(undefined, true); h.start();
  assert.equal(h.tabDrag.current.move, false); assert.equal(h.tabDrag.current.transfer.effectAllowed, 'none');
  assert.deepEqual(readDesktopTransfer(h.tabDrag.current.transfer, h.state, null), { kind: 'link', address: 'https://example.com/', title: 'Example' });
  h.exported.onPointerUp(h.point()); assert.deepEqual(h.commands, []); h.cleanup();
});

test('existing Desktop drop handlers accept web tabs and refuse move-only tab kinds', () => {
  const source = ts.createSourceFile('DesktopDrop.tsx', readFileSync('src/DesktopDrop.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const values = {};
  const visit = node => { if (ts.isVariableDeclaration(node) && ['enter', 'drop'].includes(node.name.getText(source))) values[node.name.getText(source)] = node.initializer.getText(source); ts.forEachChild(node, visit); }; visit(source);
  for (const [single, disabled] of [[false, false], [true, false], [false, true]]) {
    for (const tab of [
      { id: 'page', url: 'https://example.com/', title: 'Example', movable: true },
      { id: 'home', url: '', title: '', movable: true },
      { id: 'desktop', url: 'horizon://desktop/project', title: '', desktop: 'project', movable: true },
      { id: 'settings', url: 'horizon://settings/general', title: '', settings: 'general', movable: true },
    ]) {
      const h = dragHarness(tab, single), origin = { current: null }, drops = [];
      const handlers = compile(values, { disabled, setOver() {}, origin, state: { ...h.state, activeId: tab.id }, formats: [DESKTOP_TAB_DRAG, 'text/uri-list', 'text/x-moz-url', 'text/plain'], available: () => true, readDesktopDrag: readDesktopTransfer, keep: item => drops.push(item), text: key => key, language: 'en', reject: () => assert.fail('Accepted web tab was rejected') });
      h.setTarget({ dispatchEvent(event) {
        if (event.type === 'dragenter' || event.type === 'dragover') handlers.enter(event);
        if (event.type === 'drop') handlers.drop(event);
        return !event.defaultPrevented;
      } });
      if (single && tab.id !== 'page') { h.exported.onPointerDown(h.point()); assert.equal(h.tabDrag.current, null); h.cleanup(); continue; }
      h.start(); h.exported.overTabDrag(h.point());
      assert.equal(h.tabDrag.current.accepted, !disabled && tab.id === 'page');
      assert.equal(h.tabDrag.current.transfer.dropEffect, 'none'); assert.equal(h.tabDrag.current.transfer.effectAllowed, 'none');
      h.exported.onPointerUp(h.point());
      if (!disabled && tab.id === 'page') { assert.deepEqual(h.commands, []); assert.deepEqual(drops, [{ kind: 'link', address: tab.url, title: tab.title }]); }
      else { assert.equal(drops.length, 0); assert.equal(h.commands[0].type, 'move-tab-to-window'); }
      h.cleanup();
    }
  }
});

test('a refused region or leaving an accepted target clears acceptance and allows a window move', () => {
  for (const target of [null, { dispatchEvent: () => true }]) {
    const h = dragHarness(); h.start();
    h.setTarget({ dispatchEvent(event) { if (event.type === 'dragover') event.preventDefault(); return !event.defaultPrevented; } });
    h.exported.overTabDrag(h.point()); assert.equal(h.tabDrag.current.accepted, true);
    h.setTarget(target); h.exported.onPointerUp(h.point());
    assert.equal(h.commands.length, 1); assert.equal(h.commands[0].type, 'move-tab-to-window'); h.cleanup();
  }
});

test('native favicon drag is cancelled without making the tab button draggable', () => {
  const source = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = node => {
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.text === 'className' && attribute.initializer?.text === 'tab-select')) assert.equal(node.attributes.properties.some(attribute => attribute.name?.text === 'draggable'), false);
    ts.forEachChild(node, visit);
  }; visit(source);
  let prevented = false;
  compile({ onDragStart: expressions().onDragStart }, {}).onDragStart({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
});

test('tab menu declares one disabled row with an inline reason and returns focus on Escape', () => {
  const values = expressions();
  for (const [count, movable, reason] of [[1, true, 'tabMoveOnlyTab'], [2, false, 'tabMovePending'], [2, true, null]]) {
    let focused = 0, closed = 0;
    const menuTab = { id: 'page', title: 'Page', url: 'https://example.com/', movable }, opener = { current: { focus() { focused++; } } };
    const globals = { state: { tabs: Array.from({ length: count }, () => menuTab) }, menuTab, tabMenuOpener: opener, t: key => key, webTabTitle: tab => tab.title, ToolbarPopover: 'anchor', Menu: 'menu', AppWindow: 'icon', setTabMenu(value) { assert.equal(value, null); closed++; }, run() {} };
    const helpers = compile({ closeTabMenu: values.closeTabMenu, tabMoveReason: values.tabMoveReason }, globals);
    const tree = compile({ menu: values.menu }, { ...globals, ...helpers }).menu.props.children;
    assert.equal(helpers.tabMoveReason, reason); assert.equal(tree.props.describedBy, reason ? 'tab-move-reason' : undefined);
    const [row, note] = tree.props.children; assert.equal(row.props.role, 'menuitem'); assert.equal(row.props.disabled, Boolean(reason));
    if (reason) { assert.equal(note.props.id, 'tab-move-reason'); assert.equal(note.props.children, reason); }
    tree.props.onDismiss('escape'); assert.equal(focused, 1); assert.equal(closed, 1);
  }
});

test('focused tabs open their own menu with either keyboard context-menu key', () => {
  for (const [key, shiftKey] of [['ContextMenu', false], ['F10', true]]) {
    const calls = [], opener = {}, exported = compile({ onKeyDown: expressions().onKeyDown }, { tab: { id: 'page' }, showTabMenu: (...args) => calls.push(args) });
    let prevented = false;
    exported.onKeyDown({ key, shiftKey, currentTarget: opener, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.deepEqual(calls, [['page', opener]]);
  }
});

test('tab menus focus their enabled row or disabled container and keep arrow and Escape paths whole', () => {
  for (const disabled of [false, true]) {
    const effects = [], document = { activeElement: null, addEventListener() {}, removeEventListener() {} }, dismissed = [];
    const row = { tagName: 'BUTTON', focus() { document.activeElement = row; } };
    const menu = { focus() { document.activeElement = menu; }, querySelector() { return disabled ? null : row; }, querySelectorAll() { return disabled ? [] : [row]; } };
    const react = { useRef: value => ({ current: value === null ? menu : value }), useEffect: callback => effects.push(callback), useLayoutEffect: callback => effects.push(callback) };
    const source = ts.transpileModule(readFileSync('src/Menu.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const exported = {}, jsx = (type, props) => ({ type, props });
    compileFunction(source, ['exports', 'require', 'document'])(exported, name => name === 'react' ? react : { jsx, jsxs: jsx }, document);
    const tree = exported.Menu({ id: 'tab-menu', label: 'Tab actions', keyboard: true, describedBy: disabled ? 'tab-move-reason' : undefined, onDismiss: reason => dismissed.push(reason) });
    effects.forEach(effect => effect()); assert.equal(document.activeElement, disabled ? menu : row);
    assert.equal(tree.props.role, 'menu'); assert.equal(tree.props['aria-describedby'], disabled ? 'tab-move-reason' : undefined);
    for (const key of ['ArrowDown', 'ArrowUp']) tree.props.onKeyDown({ key, target: disabled ? menu : row, preventDefault() {} });
    assert.equal(document.activeElement, disabled ? menu : row);
    tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.deepEqual(dismissed, ['escape']);
  }
});
