const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { copy } = require('../dist/src/copy.js');

const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(done => setImmediate(done)); };

function harness(command = async () => undefined) {
  let cursor = 0; const slots = [], pending = [], sent = [], listeners = new Map();
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
  const document = {
    activeElement: null, body: { tag: 'body' },
    addEventListener(type, listener, capture) { listeners.set(`${type}:${Boolean(capture)}`, listener); },
    removeEventListener(type, _listener, capture) { listeners.delete(`${type}:${Boolean(capture)}`); },
  };
  const exports = {}, jsx = (type, props) => ({ type, props });
  const source = ts.transpileModule(readFileSync('src/Profiles.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const globals = { exports, Error, document, window: { horizon: { command: value => { sent.push(value); return command(value); } } },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name === './copy') return require('../dist/src/copy.js');
      if (name === './shared/api') return require('../dist/src/shared/api.js');
      return new Proxy({}, { get: (_target, key) => String(key) });
    },
  };
  runInNewContext(source, globals);
  return { exports, sent, slots, document, listeners, render(component, props) { cursor = 0; return exports[component](props); }, flush() { for (const effect of pending.splice(0)) effect(); } };
}
const flat = value => [value].flat(Infinity).filter(value => value !== null && value !== undefined && typeof value !== 'boolean');
const find = (tree, predicate) => flat(tree).flatMap(node => typeof node === 'object' ? [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)] : []);
const textOf = node => flat(node).map(child => typeof child === 'object' ? textOf(child.props?.children) : String(child)).join('');
const describe = reason => `described:${reason instanceof Error ? reason.message : reason}`;
const signedIn = (extra = {}) => ({ status: 'signedIn', email: 'alex.rivera@example.test', displayName: 'Alex Rivera', plan: 'Founder', phrase: 'ready', keyStore: 'shared', spaces: [], shared: [], spacesError: null, ...extra });
const commands = (extra = {}) => { const ran = [], phrases = []; return { ran, phrases, value: { pending: { current: false }, busy: false, error: '', retry: null, phrase: '', setPhrase: value => phrases.push(value), run: async value => { ran.push(JSON.parse(JSON.stringify(value))); }, ...extra } }; };
const buttons = tree => find(tree, node => node.type === 'button');
const profiles = [{ id: 'personal', name: 'Personal', color: 'amber', tabCount: 4 }, { id: 'work', name: 'Work', color: 'blue', tabCount: 1 }, { id: 'studio', name: 'Studio', color: 'green', tabCount: 0 }];

test('profile rows show tab counts, the current window and stay inside the scroll region', () => {
  const h = harness();
  for (const language of ['en', 'es']) {
    const tree = h.render('ProfilesMenu', { state: { account: { status: 'signedOut' }, profiles, activeProfileId: 'personal' }, language, keyboard: false, opener: { current: null }, describe, onDismiss() {}, onSwitch() {}, onNew() {}, onManage() {}, onPrivate() {} });
    const list = find(tree, node => node.props?.className === 'profiles-list')[0];
    const rows = find(list, node => node.props?.role === 'menuitemradio');
    assert.deepEqual(rows.map(row => find(row, node => node.type === 'small')[0].props.children), [
      copy.thisWindowTabs[language].replace('{tabs}', copy.profileTabs[language].replace('{count}', '4')), copy.profileTab[language], copy.profileNoTabs[language],
    ]);
    assert.deepEqual(rows.map(row => row.props['aria-checked']), [true, false, false]);
    assert.equal(find(rows[0], node => node.props?.className === 'profile-check').length, 1);
    const menu = find(tree, node => node.props?.id === 'profiles-menu')[0];
    assert.equal(find(menu, node => node.props?.role === 'menuitem').length, 3);
    assert.equal(find(menu, node => node.props?.className === 'account-card').length, 0, 'The account card stays outside the menu role');
  }
});

test('the account card offers each status with its own commands and never sends an empty phrase', async () => {
  const h = harness(), card = { current: null };
  let c = commands(), tree = h.render('AccountCard', { account: { status: 'signedOut' }, language: 'en', commands: c.value, card, describe });
  assert.equal(tree.props['aria-label'], copy.cosmicAccount.en); assert.match(textOf(tree), /Cosmic account/);
  assert.match(textOf(tree), new RegExp(copy.nebulaBrowserNote.en));
  buttons(tree)[0].props.onClick(); assert.deepEqual(c.ran, [{ type: 'account-sign-in' }]);

  c = commands(); tree = h.render('AccountCard', { account: { status: 'signingIn' }, language: 'es', commands: c.value, card, describe });
  for (const button of buttons(tree)) button.props.onClick();
  assert.deepEqual(c.ran, [{ type: 'account-reopen' }, { type: 'account-cancel' }]); assert.match(textOf(tree), new RegExp(copy.nebulaWaiting.es));

  c = commands(); tree = h.render('AccountCard', { account: signedIn({ phrase: 'needed' }), language: 'en', commands: c.value, card, describe });
  assert.equal(find(tree, node => node.type === 'textarea').length, 1);
  let submit = buttons(tree).find(button => button.props.type === 'submit');
  assert.equal(submit.props['aria-disabled'], true);
  const form = find(tree, node => node.type === 'form')[0];
  form.props.onSubmit({ preventDefault() {} }); assert.deepEqual(c.ran, []);
  assert.equal(find(tree, node => node.props?.role === 'alert').length, 0);
  c = commands({ phrase: 'one two three' }); tree = h.render('AccountCard', { account: signedIn({ phrase: 'wrong' }), language: 'en', commands: c.value, card, describe });
  submit = buttons(tree).find(button => button.props.type === 'submit'); assert.equal(submit.props['aria-disabled'], false);
  assert.equal(find(tree, node => node.props?.role === 'alert')[0].props.children, copy.ACCOUNT_PHRASE_WRONG.en);
  find(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(c.ran, [{ type: 'account-phrase', phrase: 'one two three' }]); assert.deepEqual(c.phrases, ['']);
  buttons(tree).find(button => button.props.type === 'button').props.onClick();
  assert.deepEqual(c.ran.at(-1), { type: 'account-sign-out' }); assert.deepEqual(c.phrases, ['', '']);

  c = commands(); tree = h.render('AccountCard', { account: signedIn(), language: 'en', commands: c.value, card, describe });
  assert.equal(find(tree, node => node.props?.className === 'account-card-avatar')[0].props.children, 'AR');
  assert.equal(find(tree, node => node.props?.className === 'account-card-plan')[0].props.children, 'Founder');
  assert.equal(find(tree, node => node.type === 'small')[0].props.children, 'alex.rivera@example.test');
  for (const button of buttons(tree)) button.props.onClick();
  assert.deepEqual(c.ran, [{ type: 'account-manage' }, { type: 'account-sign-out' }]);
  tree = h.render('AccountCard', { account: signedIn({ displayName: null, plan: null }), language: 'en', commands: c.value, card, describe });
  assert.equal(find(tree, node => node.props?.className === 'account-card-plan').length, 0);
  assert.equal(find(tree, node => node.type === 'small').length, 0, 'An email shown as the name is not repeated');

  c = commands({ busy: true }); tree = h.render('AccountCard', { account: { status: 'error', code: 'ACCOUNT_NETWORK' }, language: 'en', commands: c.value, card, describe });
  assert.equal(tree.props['aria-busy'], true); assert.ok(buttons(tree).every(button => button.props['aria-disabled'] === true));
  assert.match(textOf(tree), /described:ACCOUNT_NETWORK/); buttons(tree)[0].props.onClick();
  assert.deepEqual(c.ran, [{ type: 'account-retry' }]);
  await settle();
});

test('account commands run one at a time and never keep the phrase for a retry', async () => {
  let release; const h = harness(value => value.type === 'account-manage' ? new Promise((_resolve, reject) => { release = () => reject(new Error('ACCOUNT_NETWORK')); }) : Promise.reject(new Error('ACCOUNT_PHRASE_WRONG')));
  let state = h.render('useAccountCommands', describe);
  void state.run({ type: 'account-manage' }); void state.run({ type: 'account-sign-out' });
  assert.deepEqual(h.sent, [{ type: 'account-manage' }]); assert.equal(h.render('useAccountCommands', describe).busy, true);
  release(); await settle(); state = h.render('useAccountCommands', describe);
  assert.equal(state.error, 'described:ACCOUNT_NETWORK'); assert.deepEqual(state.retry, { type: 'account-manage' }); assert.equal(state.busy, false);
  await state.run({ type: 'account-phrase', phrase: 'secret words' }); state = h.render('useAccountCommands', describe);
  assert.equal(state.error, 'described:ACCOUNT_PHRASE_WRONG'); assert.equal(state.retry, null);
});

test('outside pointers close the popover unless they land inside it, words are typed or a command is pending', async () => {
  let release; const h = harness(() => new Promise(resolve => { release = resolve; }));
  const dismissed = [], gate = { dismiss: reason => dismissed.push(`raw:${reason}`) }, inside = { node: 'inside' };
  const props = { account: signedIn({ phrase: 'needed' }), language: 'en', describe, gate, profileCount: 3, onDismiss: reason => dismissed.push(reason), children: [] };
  let tree = h.render('ProfilesPopover', props);
  tree.props.ref.current = { contains: node => node === inside, querySelector: () => null };
  h.flush();
  const pointer = target => { h.listeners.get('pointerdown:true')({ target }); gate.dismiss('outside'); };
  pointer({}); assert.deepEqual(dismissed, ['outside']);
  pointer(inside); assert.deepEqual(dismissed, ['outside']);
  find(tree, node => node.props?.commands)[0].props.commands.setPhrase('typed');
  tree = h.render('ProfilesPopover', props); h.flush();
  pointer({}); assert.deepEqual(dismissed, ['outside']);
  gate.dismiss('escape'); assert.deepEqual(dismissed, ['outside', 'escape']);
  find(tree, node => node.props?.commands)[0].props.commands.setPhrase('');
  tree = h.render('ProfilesPopover', props); h.flush();
  void find(tree, node => node.props?.commands)[0].props.commands.run({ type: 'account-manage' });
  pointer({}); assert.deepEqual(dismissed, ['outside', 'escape']);
  release(); await settle(); pointer({}); assert.deepEqual(dismissed, ['outside', 'escape', 'outside']);
});

test('Tab and Shift+Tab move between the card and the menu and Escape closes from the card', () => {
  const h = harness(), dismissed = [], first = { focus() { h.document.activeElement = first; } }, last = { focus() { h.document.activeElement = last; } };
  const entry = { focus() { h.document.activeElement = entry; } }, menuItem = { node: 'menu-item' };
  const tree = h.render('ProfilesPopover', { account: { status: 'signingIn' }, language: 'en', describe, gate: { dismiss() {} }, profileCount: 1, onDismiss: reason => dismissed.push(reason), children: [] });
  tree.props.ref.current = { contains: () => true, querySelector: selector => selector.includes('aria-checked') ? entry : null };
  find(tree, node => node.props?.card)[0].props.card.current = { contains: node => node === first || node === last, querySelectorAll: () => [first, last] };
  const key = (handler, target, key, shiftKey = false) => { const event = { key, shiftKey, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; tree.props[handler](event); return event; };
  h.document.activeElement = last;
  assert.equal(key('onKeyDown', last, 'Tab').prevented, true); assert.equal(h.document.activeElement, entry);
  h.document.activeElement = first;
  assert.equal(key('onKeyDown', first, 'Tab').prevented, false); assert.deepEqual(dismissed, []);
  key('onKeyDown', first, 'Tab', true); assert.deepEqual(dismissed, ['tab']);
  const back = key('onKeyDownCapture', menuItem, 'Tab', true);
  assert.equal(back.prevented, true); assert.equal(back.stopped, true); assert.equal(h.document.activeElement, last);
  assert.equal(key('onKeyDownCapture', menuItem, 'Tab').prevented, false, 'Tab from the menu still closes as before');
  assert.equal(key('onKeyDown', first, 'Escape').stopped, true); assert.deepEqual(dismissed, ['tab', 'escape']);
  assert.equal(key('onKeyDown', menuItem, 'a').prevented, false);
});

test('the new menu copy is plain and present in both languages', () => {
  assert.deepEqual(copy.cosmicAccount, { en: 'Cosmic account', es: 'Cuenta de Cosmic' });
  for (const language of ['en', 'es']) assert.doesNotMatch(copy.cosmicAccount[language], /[‐-―]/);
});
