const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { compileFunction } = require('node:vm');
const ts = require('typescript');
const { GROUP_COLORS } = require('../dist/src/shared/api.js');
const { GROUP_ICON_TAGS } = require('../dist/src/shared/group-icon-tags.js');
const { GROUP_ICON_SPANISH } = require('../dist/src/shared/group-icon-spanish.js');
const { GROUP_ICON_NAMES, groupIcon } = require('../dist/src/shared/group-icon-names.js');
const { createGroupIconSearch } = require('../dist/src/shared/group-icon-search.js');
const { adjustedGroupColor, colorContrast, groupPaint, hexToHSV, hsvToHex } = require('../dist/src/shared/group-colors.js');

const tokens = Object.fromEntries([...readFileSync('src/tokens.css', 'utf8').matchAll(/--(palette-[\w-]+):\s*(#[a-f\d]{6});/gi)].map(match => [match[1], match[2]]));
const THEMES = ['amber', 'daylight', 'contrast-dark', 'contrast-light'];
const palette = theme => ({ chrome: tokens[`palette-${theme}-chrome`], wash: tokens[`palette-${theme}-wash`], colors: Object.fromEntries(GROUP_COLORS.map(role => [role, tokens[`palette-${theme}-${role}`]])) });
const searchGroupIcons = createGroupIconSearch(GROUP_ICON_TAGS, GROUP_ICON_SPANISH);
const reaches = (color, { chrome, wash }) => colorContrast(color, chrome) >= 3 && colorContrast(color, wash) >= 4.5;

test('all 1854 official icons keep Lucide English tags and carry a Spanish name and Spanish tags, with their source, version and license', () => {
  assert.equal(GROUP_ICON_NAMES.length, 1854); assert.equal(new Set(GROUP_ICON_NAMES).size, 1854);
  assert.deepEqual(Object.keys(GROUP_ICON_TAGS), GROUP_ICON_NAMES); assert.deepEqual(Object.keys(GROUP_ICON_SPANISH), GROUP_ICON_NAMES);
  for (const name of GROUP_ICON_NAMES) {
    const english = GROUP_ICON_TAGS[name], spanish = GROUP_ICON_SPANISH[name];
    assert.ok(english.length > 0, name); assert.ok(spanish.length > 1 && spanish.length <= 17, name);
    for (const tag of [...english, ...spanish]) assert.ok(typeof tag === 'string' && tag.trim() === tag && tag.length > 0 && !/[\u2010-\u2015\u2212]/.test(tag), name);
    for (const tag of spanish) assert.ok(!/[-_]/.test(tag), `${name}: ${tag}`);
    assert.equal(new Set(spanish).size, spanish.length, name);
    assert.ok(searchGroupIcons(name).some(icon => icon.name === name), name);
    assert.ok(groupIcon(name), name);
  }
  assert.equal(groupIcon(null), true); assert.equal(groupIcon('not-a-lucide-icon'), false); assert.equal(groupIcon('Plane'), false);
  assert.deepEqual(GROUP_ICON_TAGS['map'], ['location', 'navigation', 'travel']);
  const license = readFileSync('src/shared/group-icons.LICENSE.md', 'utf8');
  for (const part of ['1.48.0', '1854', 'https://unpkg.com/lucide-static@1.48.0/tags.json', 'ISC', 'Permission to use, copy, modify']) assert.ok(license.includes(part));
});

test('icon searches match names and English and Spanish meanings without case or accents', () => {
  for (const [query, icon] of [['airplane', 'plane'], ['AVIÓN', 'plane'], ['avion', 'plane'], ['BRÚJULA', 'compass'], ['brujula', 'compass'], ['corazón', 'heart'], ['ÁRBOL', 'trees'], ['clipboard', 'clipboard'], ['PORTAPAPELES', 'clipboard'], ['wheelchair', 'accessibility'], ['silla de ruedas', 'accessibility'], ['viaje', 'luggage'], ['trip', 'bus'], ['valija', 'luggage'], ['cumpleaños', 'cake']]) {
    assert.ok(searchGroupIcons(query).some(result => result.name === icon), query);
  }
  assert.equal(searchGroupIcons('  PLANE___takeoff  ')[0].name, 'plane-takeoff');
  assert.deepEqual(searchGroupIcons('no such icon zxqv'), []); assert.equal(searchGroupIcons('').length, 1854);
  assert.equal(searchGroupIcons('alarm-clock-check')[0].name, 'alarm-clock-check');
});

test('icon searches match whole words by their start, accept plurals and put names before tags', () => {
  assert.ok(searchGroupIcons('trees').some(icon => icon.name === 'trees'));
  assert.ok(searchGroupIcons('árboles').some(icon => icon.name === 'trees'));
  assert.ok(searchGroupIcons('avio').some(icon => icon.name === 'plane'));
  assert.equal(searchGroupIcons('plane')[0].name, 'plane');
  assert.deepEqual(searchGroupIcons('plane').map(icon => icon.name).slice(0, 3), ['plane', 'plane-landing', 'plane-takeoff']);
  const names = searchGroupIcons('trip').map(icon => icon.name);
  assert.ok(names.length > 8 && names.includes('plane') && names.includes('car') && names.includes('ship'));
  assert.ok(names.indexOf('columns-3') > names.indexOf('van'), 'words that only start like the query come after whole tags');
  assert.equal(searchGroupIcons('plane').every(icon => icon.es[0].length > 0), true);
});

test('suggested colors meet strip and label contrast as drawn in all four themes', () => {
  for (const theme of THEMES) {
    const values = palette(theme);
    for (const role of GROUP_COLORS) {
      assert.ok(reaches(values.colors[role], values), `${theme} ${role}`);
      assert.equal(groupPaint(role, values), values.colors[role]);
    }
  }
});

test('custom colors adjust lightness, retain hue and preserve already passing choices', () => {
  for (const theme of THEMES) {
    const values = palette(theme);
    const samples = ['#000000', '#ffffff', '#777777', '#4fb39a', '#ffff00', ...Array.from({ length: 24 }, (_, index) => hsvToHex({ h: index * 15, s: 80, v: 75 }))];
    for (const source of samples) {
      const color = adjustedGroupColor(source, values.chrome, values.wash), before = hexToHSV(source), after = hexToHSV(color);
      assert.ok(reaches(color, values), `${theme} ${source}`);
      if (before.s > 0 && after.s > 0) { const difference = Math.abs(before.h - after.h); assert.ok(Math.min(difference, 360 - difference) < 1.5, `${source} hue`); }
      assert.equal(adjustedGroupColor(color, values.chrome, values.wash), color);
      if (reaches(source, values)) assert.equal(color, source);
    }
  }
  assert.notEqual(adjustedGroupColor('#ffff00', palette('daylight').chrome, palette('daylight').wash), '#ffff00');
  assert.notEqual(adjustedGroupColor('#202020', palette('amber').chrome, palette('amber').wash), '#202020');
  assert.throws(() => adjustedGroupColor('#abc', '#ffffff', '#eeeeee')); assert.throws(() => adjustedGroupColor('url(example)', '#ffffff', '#eeeeee'));
  assert.equal(hsvToHex({ h: 360, s: 100, v: 100 }), '#ff0000');
  for (const color of ['#4fb39a', '#abcdef', '#000000', '#ffffff']) assert.equal(hsvToHex(hexToHSV(color)), color);
});

function expressions(filename, classes) {
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), result = {};
  const visit = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.attributes.properties.find(attribute => attribute.name?.text === 'className')?.initializer?.text;
      if (classes.includes(name)) result[name] = Object.fromEntries(node.attributes.properties.filter(attribute => ts.isJsxAttribute(attribute) && ['onKeyDown', 'onClick', 'onChange', 'type'].includes(attribute.name.text)).map(attribute => [attribute.name.text, ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : attribute.initializer.expression.getText(source)]));
    }
    ts.forEachChild(node, visit);
  }; visit(source); return result;
}
function evaluate(expression, globals) {
  const code = ts.transpileModule(`export const handler = ${expression};`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, exported = {};
  compileFunction(code, ['exports', ...Object.keys(globals)])(exported, ...Object.values(globals)); return exported.handler;
}

test('picker area arrow keys change both axes with Shift and boundary keys, and the hue strip is a native range slider', () => {
  const source = expressions('src/TabGroups.tsx', ['group-color-area', 'group-hue']);
  for (const [key, shiftKey, field, expected] of [['ArrowLeft', false, 's', 49], ['ArrowRight', true, 's', 60], ['ArrowUp', false, 'v', 51], ['ArrowDown', true, 'v', 40], ['Home', false, 's', 0], ['End', false, 's', 100]]) {
    let changed, prevented = false;
    evaluate(source['group-color-area'].onKeyDown, { value: { h: 166, s: 50, v: 50 }, change: next => { changed = next; } })({ key, shiftKey, preventDefault() { prevented = true; } });
    assert.equal(changed[field], expected); assert.equal(prevented, true);
  }
  let changed = null; evaluate(source['group-color-area'].onKeyDown, { value: { h: 0, s: 0, v: 0 }, change: next => { changed = next; } })({ key: 'a', shiftKey: false, preventDefault() { throw new Error('other keys stay free'); } });
  assert.equal(changed, null);
  assert.equal(source['group-hue'].type, 'range');
  let hue; evaluate(source['group-hue'].onChange, { value: { h: 166, s: 50, v: 50 }, change: next => { hue = next; } })({ target: { value: '200' } });
  assert.deepEqual(hue, { h: 200, s: 50, v: 50 });
});

test('group labels fold through commands and open editors with both keyboard context-menu keys', () => {
  const source = expressions('src/TabGroups.tsx', ['tab-group-label']), group = { id: 'group', folded: false };
  const commands = [], opened = [], opener = {};
  const globals = { group, run: command => commands.push(command), onEdit: (...args) => opened.push(args) };
  evaluate(source['tab-group-label'].onClick, globals)(); assert.deepEqual(commands, [{ type: 'set-tab-group-folded', id: 'group', folded: true }]);
  for (const [key, shiftKey] of [['ContextMenu', false], ['F10', true]]) evaluate(source['tab-group-label'].onKeyDown, globals)({ key, shiftKey, currentTarget: opener, preventDefault() {} });
  assert.deepEqual(opened, [[group, opener], [group, opener]]);
});

test('tab keyboard navigation skips folded tabs and preserves the selected visible tab focus', () => {
  const source = expressions('src/App.tsx', ['tab-select'])['tab-select'].onKeyDown;
  const visible = [{ id: 'outside' }, { id: 'after' }], commands = [], focused = [];
  const globals = { index: 0, visible, run: command => commands.push(command), closeFind() {}, setDirty() {}, setSuggestionsOpen() {}, document: { getElementById: id => ({ focus() { focused.push(id); } }) } };
  evaluate(source, globals)({ key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual(commands, [{ type: 'activate-tab', id: 'after' }]); assert.deepEqual(focused, ['tab-after']);
});
