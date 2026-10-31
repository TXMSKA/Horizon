const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const ts = require('typescript');

function harness() {
  let cursor = 0;
  const slots = [], effects = [], layouts = [], calls = [], requests = [], revoked = [];
  const hook = (queue, effect, dependencies) => {
    const index = cursor++, previous = slots[index];
    if (!previous || dependencies.some((value, position) => value !== previous.dependencies[position])) {
      slots[index] = { dependencies, cleanup: previous?.cleanup };
      queue.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
    }
  };
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useRef(current) { const index = cursor++; slots[index] ??= { current }; return slots[index]; },
    useEffect(effect, dependencies) { hook(effects, effect, dependencies); },
    useLayoutEffect(effect, dependencies) { hook(layouts, effect, dependencies); },
  };
  const exports = {}, jsx = (type, props) => ({ type, props });
  const selection = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) { Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset }); } };
  const globals = { exports, Error, Blob, Uint8Array, URL: { createObjectURL: () => `blob:${requests.length}`, revokeObjectURL: url => revoked.push(url) },
    document: { getSelection: () => selection }, window: { horizon: {
      command(command) { calls.push(command); return new Promise((resolve, reject) => requests.push({ resolve, reject })); },
      getCaptureImage(project, id) { calls.push({ project, id }); return new Promise((resolve, reject) => requests.push({ resolve, reject })); },
    } }, require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './copy') return { text: key => key };
      if (name === './Desktop') return { desktopError: reason => reason.message };
      return new Proxy({}, { get: (_target, key) => String(key) });
    } };
  const source = ts.transpileModule(readFileSync('src/DesktopView.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(source + '\nexports.SharedBody = SharedBody; exports.SharedCaptureImage = typeof SharedCaptureImage === "function" ? SharedCaptureImage : undefined;', globals);
  const flush = queue => { for (const effect of queue.splice(0)) effect(); };
  return { exports, globals, slots, calls, requests, revoked, selection,
    render(name, props) { cursor = 0; const tree = exports[name]({ onClose() {}, ...props }); flush(layouts); flush(effects); return tree; },
    flushLayouts: () => flush(layouts),
    unmount() { for (const slot of slots) slot.cleanup?.(); },
    async settle() { for (let index = 0; index < 3; index++) await new Promise(done => setImmediate(done)); },
  };
}
const flatten = tree => [tree].flat(Infinity).flatMap(node => node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : []);
const content = (title = 'First project', text = 'First note') => ({ spaceId: 'space-y', datasetId: 'dataset-y', title, sharedBy: { displayName: 'A' }, spaceName: 'Y', updatedAt: '1', readOnly: true, folders: [], items: [{ id: 'shared:note', kind: 'note', title: 'Note', text, note: '', source: null, image: null }] });

function readerHarness() {
  const space = 'space-y', dataset = randomUUID(), writer = randomUUID(), generation = randomUUID(), id = randomUUID();
  const base = `kg1/project/${writer}/${generation}/`, manifest = Buffer.from(JSON.stringify({ keyGeneration: 1 })), checkpoint = Buffer.alloc(12); checkpoint.writeUInt32BE(1, 8);
  const files = new Map([[`${base}dataset.hzs`, manifest], [`${base}checkpoints/1-${id}.hzs`, checkpoint]]);
  const context = { accountId: 'reader', session: 1, spaces: [{ id: space, pending: false, currentGeneration: 1, members: [{ accountId: 'reader' }] }], shared: [{ spaceId: space, datasetId: dataset, sharedBy: { accountId: 'owner', displayName: null } }] };
  const exports = {}, localRequire = createRequire(resolve('dist/electron/space-reader.js'));
  runInNewContext(ts.transpileModule(readFileSync('electron/space-reader.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Buffer, URLSearchParams, structuredClone, Error, require(name) {
      if (name === './space-sharing') return { openProjectManifest: async () => {}, validateSpaceCheckpoint() {}, openSpacePackage: () => ({ project: { name: 'Project', folders: [], items: [{ id, text: 'Last good note', image: null }] } }) };
      return localRequire(name);
    },
  });
  const h = { context, failure: null, corrupt: false, reader: null, beforeFailure: null, open: () => h.reader.openSharedProject(space, dataset) };
  h.reader = exports.createSharedProjects({ context: () => h.context, key: async () => ({ key: new Uint8Array(32) }), async request(route) {
    h.beforeFailure?.();
    if (h.failure instanceof Error) throw h.failure;
    if (h.failure) return h.failure;
    if (route.includes('?')) return { ok: true, value: { objects: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: 1 })), after: null } };
    const bytes = Buffer.from(files.get(route.split('/objects/')[1])); if (h.corrupt) bytes[bytes.length - 1] ^= 1;
    return { ok: true, value: bytes };
  } });
  return h;
}

test('shared reader preserves transport errors and cached items through failed automatic reopens', async () => {
  for (const failure of [new Error('ACCOUNT_NETWORK'), new Error('ACCOUNT_TIMEOUT'), { ok: false, status: 503 }, { ok: false, status: 429 }, { ok: false, status: 403, value: { error: { code: 'key_pending' } } }]) {
    const h = readerHarness(), previous = await h.open(); h.failure = failure;
    await assert.rejects(h.open(), { message: failure instanceof Error ? failure.message : failure.status === 403 ? 'ACCOUNT_DENIED' : 'ACCOUNT_NETWORK' });
    assert.equal(h.reader.item(null, previous.items[0].id).text, 'Last good note');
    h.failure = null; assert.equal((await h.open()).title, 'Project');
  }
});

test('a checkpoint integrity failure is retryable and retains the previous shared snapshot', async () => {
  const h = readerHarness(), previous = await h.open(); h.corrupt = true;
  await assert.rejects(h.open(), /ACCOUNT_INVALID_RESPONSE/);
  assert.equal(h.reader.item(null, previous.items[0].id).text, 'Last good note');
  h.corrupt = false; await h.open();
});

test('confirmed dataset removal makes a shared reader unavailable and clears its cached items', async () => {
  const h = readerHarness(), previous = await h.open(); h.failure = { ok: false, status: 404 };
  await assert.rejects(h.open(), /SPACE_SHARED_UNAVAILABLE/);
  assert.throws(() => h.reader.item(null, previous.items[0].id), /SPACE_SHARED_UNAVAILABLE/);
});

test('a failed shared reopen rechecks captured account and access before treating its error as retryable', async () => {
  for (const change of ['sign-out', 'session', 'dataset', 'membership', 'clear']) {
    const h = readerHarness(), previous = await h.open(); h.failure = new Error('ACCOUNT_DENIED');
    h.beforeFailure = () => {
      if (change === 'sign-out') h.context = undefined;
      else if (change === 'session') h.context = { ...h.context, session: h.context.session + 1 };
      else if (change === 'dataset') h.context = { ...h.context, shared: [] };
      else if (change === 'membership') h.context = { ...h.context, spaces: [] };
      else h.reader.clear();
    };
    await assert.rejects(h.open(), /SPACE_SHARED_UNAVAILABLE/, change);
    assert.throws(() => h.reader.item(null, previous.items[0].id), /SPACE_SHARED_UNAVAILABLE/, change);
  }
});

test('shared open command validation permits a stale Space after a failed key refresh', () => {
  const exports = {}, localRequire = createRequire(resolve('dist/electron/commands.js'));
  runInNewContext(ts.transpileModule(readFileSync('electron/commands.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Error, require: name => ['./spaces', './sync-format'].includes(name) ? localRequire(name) : {},
  });
  const command = { type: 'space-open-shared', space: 'space-y', dataset: randomUUID() };
  assert.equal(exports.validateCommand(command, undefined, [], [], undefined, [{ id: command.space, pending: true, stale: true }]), command);
  assert.throws(() => exports.validateCommand(command, undefined, [], [], undefined, [{ id: command.space, pending: true }]));
  assert.throws(() => exports.validateCommand(command, undefined, [], [], undefined, []));
});

test('an account loading failure preserves an open shared panel and retries account recovery', async () => {
  const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y' }, notices = [], commands = [];
  const dataset = { spaceId: page.space, datasetId: page.dataset, updatedAt: '1' };
  const props = { state: { account: { status: 'signedIn', shared: [dataset] } }, language: 'en', onRejected: message => notices.push(message), run: async command => { commands.push(command); return true; } };
  let closed = 0;
  const render = () => h.render('SharedBody', { page, props, onClose() { closed++; } });
  render(); h.requests[0].resolve(content()); await h.settle(); render();
  props.state.account = { status: 'error', code: 'ACCOUNT_NETWORK' }; render();
  let tree = render(); assert.match(JSON.stringify(tree), /First note/);
  const feedback = flatten(tree).find(node => node.props?.onRetry); assert.equal(feedback.props.error, 'ACCOUNT_NETWORK');
  feedback.props.onRetry(); assert.equal(commands.length, 1); assert.equal(commands[0].type, 'account-retry');
  props.state.account = { status: 'signingIn' }; tree = render(); assert.match(JSON.stringify(tree), /First note/);
  props.state.account = { status: 'signedIn', shared: [dataset] }; render(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(content('Recovered project')); await h.settle(); assert.match(JSON.stringify(render()), /Recovered project/);
  assert.equal(closed, 0); assert.deepEqual(notices, []);
});

test('transient automatic shared refresh failures show retry beside the last content', async () => {
  for (const item of [undefined, 'shared:note']) {
    const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y', item }, notices = [];
    const dataset = { spaceId: page.space, datasetId: page.dataset, updatedAt: '1' };
    const props = { state: { account: { status: 'signedIn', shared: [dataset] } }, language: 'en', onRejected: message => notices.push(message) };
    let closed = 0;
    const render = () => h.render('SharedBody', { page, props, onClose() { closed++; } });
    render(); h.requests[0].resolve(content()); await h.settle(); render();
    dataset.updatedAt = '2'; render(); h.requests[1].reject(new Error('ACCOUNT_TIMEOUT')); await h.settle();
    const tree = render(); assert.match(JSON.stringify(tree), /First note/);
    const feedback = flatten(tree).find(node => node.props?.onRetry); assert.equal(feedback.props.error, 'ACCOUNT_TIMEOUT');
    feedback.props.onRetry(); render(); assert.equal(h.requests.length, 3);
    h.requests[2].resolve(content('Updated project')); await h.settle(); assert.match(JSON.stringify(render()), /Updated project/);
    assert.equal(closed, 0); assert.deepEqual(notices, []);
  }
});

test('an open shared project refreshes matching dataset updates without resetting scroll or selection', async () => {
  for (const selected of [undefined, 'shared:note']) {
    const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y', item: selected };
    const dataset = { spaceId: page.space, datasetId: page.dataset, updatedAt: '1', size: 1, title: 'First project' };
    const props = { state: { account: { status: 'signedIn', shared: [dataset] } }, language: 'en' };
    const render = () => h.render('SharedBody', { page, props });
    render(); h.requests[0].resolve(content()); await h.settle(); let tree = render();
    assert.match(JSON.stringify(tree), /First note/);
    const node = { isConnected: true, nodeType: 3, textContent: 'First note', childNodes: [] };
    const panel = { scrollTop: 135, scrollLeft: 12, contains: candidate => candidate === node };
    const root = { closest: () => panel };
    flatten(tree).find(entry => entry.props?.ref).props.ref(root);
    Object.assign(h.selection, { anchorNode: node, anchorOffset: 2, focusNode: node, focusOffset: 7 });
    props.state = { account: { status: 'signedIn', shared: [{ ...dataset }, { spaceId: 'space-x', datasetId: 'dataset-x', updatedAt: '2' }] } };
    render(); assert.equal(h.calls.length, 1, 'unrelated Space updates do not refetch');
    props.state.account.shared[0] = { ...dataset, updatedAt: '2', size: 2, title: 'Renamed project' };
    tree = render(); assert.equal(h.calls.length, 2, 'a listing update refetches the open dataset');
    assert.match(JSON.stringify(tree), /First note/, 'current content stays mounted during refresh');
    h.requests[1].resolve(content('Renamed project', 'New')); await h.settle();
    panel.scrollTop = 0; panel.scrollLeft = 0; h.selection.anchorOffset = 0; h.selection.focusOffset = 0;
    node.textContent = 'New';
    tree = render(); assert.match(JSON.stringify(tree), /Renamed project/); assert.match(JSON.stringify(tree), /New/);
    assert.equal(panel.scrollTop, 135); assert.equal(panel.scrollLeft, 12); assert.equal(h.selection.anchorOffset, 2); assert.equal(h.selection.focusOffset, 3, 'selection clamps to the shorter updated text');
    page.item = 'shared:note'; tree = render(); assert.match(JSON.stringify(tree), /New/); assert.equal(h.calls.length, 2);
    props.state.account.shared[0].updatedAt = '3'; render(); h.requests[2].reject(new Error('ACCOUNT_NETWORK')); await h.settle();
    tree = render(); assert.match(JSON.stringify(tree), /Renamed project/); assert.match(JSON.stringify(tree), /New/, 'a transient refresh failure retains the displayed content');
  }
});

test('shared content refreshes a changed checkpoint hash with identical listing metadata', async () => {
  const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y' };
  const dataset = { spaceId: page.space, datasetId: page.dataset, updatedAt: '1', size: 100, title: 'First project', contentRevision: 'old-checkpoint' };
  const props = { state: { account: { status: 'signedIn', shared: [dataset] } }, language: 'en' };
  const render = () => h.render('SharedBody', { page, props });
  render(); h.requests[0].resolve(content()); await h.settle(); render();
  dataset.contentRevision = 'new-checkpoint'; render();
  assert.equal(h.calls.length, 2);
  h.requests[1].resolve(content('First project', 'Fresh note')); await h.settle();
  assert.match(JSON.stringify(render()), /Fresh note/);
});

test('a stale Space listing keeps the open project mounted without refetching', async () => {
  const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y' };
  const dataset = { spaceId: page.space, datasetId: page.dataset, updatedAt: '1', contentRevision: 'same-checkpoint' };
  const props = { state: { account: { status: 'signedIn', shared: [dataset] } }, language: 'en' };
  const render = () => h.render('SharedBody', { page, props });
  render(); h.requests[0].resolve(content()); await h.settle(); render();
  dataset.stale = true; props.state.account.spacesError = 'ACCOUNT_NETWORK';
  assert.match(JSON.stringify(render()), /First note/); assert.equal(h.calls.length, 1);
  delete dataset.stale; props.state.account.spacesError = null;
  assert.match(JSON.stringify(render()), /First note/); assert.equal(h.calls.length, 1);
  props.state.account.shared = []; render();
  assert.doesNotMatch(JSON.stringify(render()), /First note/);
});

test('deleted or revoked shared datasets clear displayed content and cancel pending refreshes', async () => {
  for (const account of [{ status: 'signedIn', shared: [] }, { status: 'signedOut' }]) {
    const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y' };
    const dataset = { spaceId: page.space, datasetId: page.dataset, updatedAt: '1' };
    const props = { state: { account: { status: 'signedIn', shared: [dataset] } }, language: 'en' };
    const render = () => h.render('SharedBody', { page, props });
    render(); h.requests[0].resolve(content()); await h.settle(); assert.match(JSON.stringify(render()), /First note/);
    dataset.updatedAt = '2'; render(); assert.equal(h.requests.length, 2);
    props.state.account = account; render(); let tree = render();
    assert.doesNotMatch(JSON.stringify(tree), /First note/); assert.match(JSON.stringify(tree), /SPACE_SHARED_UNAVAILABLE/);
    h.requests[1].resolve(content('Deleted project', 'Deleted note')); await h.settle(); tree = render();
    assert.doesNotMatch(JSON.stringify(tree), /Deleted note/); assert.equal(h.requests.length, 2);
  }
});

test('loss of shared project access closes the panel and reports unavailable without retry', async () => {
  for (const loss of ['removed-member', 'deleted-dataset', 'denied-read']) {
    const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y' }, notices = [];
    const dataset = { spaceId: page.space, datasetId: page.dataset, updatedAt: '1' };
    const props = { state: { account: { status: 'signedIn', shared: [dataset] } }, language: 'en', onRejected: message => notices.push(message) };
    let closed = 0;
    const render = () => h.render('SharedBody', { page, props, onClose() { closed++; } });
    render(); h.requests[0].resolve(content()); await h.settle(); assert.match(JSON.stringify(render()), /First note/);
    dataset.updatedAt = '2'; render(); assert.equal(h.requests.length, 2);
    if (loss === 'denied-read') h.requests[1].reject(new Error("Error invoking remote method: Error: SPACE_SHARED_UNAVAILABLE"));
    else props.state.account = loss === 'removed-member' ? { status: 'signedOut' } : { status: 'signedIn', shared: [] };
    await h.settle(); render();
    const tree = render();
    assert.equal(closed, 1, loss);
    assert.deepEqual(notices, ['SPACE_SHARED_UNAVAILABLE']);
    assert.doesNotMatch(JSON.stringify(tree), /First note/);
    assert.match(JSON.stringify(tree), /SPACE_SHARED_UNAVAILABLE/);
    assert.equal(flatten(tree).some(node => node.type === 'button' || node.props?.onRetry), false);
    if (loss !== 'denied-read') { h.requests[1].resolve(content('Revoked project', 'Revoked note')); await h.settle(); }
    assert.doesNotMatch(JSON.stringify(render()), /Revoked note/); assert.equal(closed, 1);
  }
});

test('a transient initial shared project failure keeps a retry and leaves the panel open', async () => {
  const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y' }, notices = [];
  const props = { state: { account: { status: 'signedIn', shared: [{ spaceId: page.space, datasetId: page.dataset }] } }, language: 'en', onRejected: message => notices.push(message) };
  let closed = 0;
  const render = () => h.render('SharedBody', { page, props, onClose() { closed++; } });
  render(); h.requests[0].reject(new Error('ACCOUNT_NETWORK')); await h.settle();
  const tree = render(); assert.equal(tree.props.error, 'ACCOUNT_NETWORK'); assert.equal(typeof tree.props.onRetry, 'function');
  assert.equal(closed, 0); assert.deepEqual(notices, []);
  tree.props.onRetry(); render(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(content()); await h.settle(); assert.match(JSON.stringify(render()), /First note/);
});

test('shared content ignores stale refreshes and refreshes images after the new snapshot opens', async () => {
  const h = harness(), page = { kind: 'shared', space: 'space-y', dataset: 'dataset-y', item: 'shared:note' };
  const dataset = { spaceId: page.space, datasetId: page.dataset, updatedAt: '1' };
  const props = { state: { account: { status: 'signedIn', shared: [dataset] } }, language: 'en' };
  const snapshot = title => { const next = content(title); next.items[0].image = { width: 10, height: 20 }; return next; };
  const render = () => h.render('SharedBody', { page, props });
  const imageVersion = tree => flatten(tree).find(entry => entry.type === h.exports.SharedCaptureImage).props.version;
  render(); h.requests[0].resolve(snapshot('First')); await h.settle(); const initialVersion = imageVersion(render());
  dataset.updatedAt = '2'; assert.equal(imageVersion(render()), initialVersion);
  dataset.updatedAt = '3'; assert.equal(imageVersion(render()), initialVersion);
  h.requests[2].resolve(snapshot('Newest')); await h.settle(); let tree = render();
  assert.match(JSON.stringify(tree), /Newest/); assert.notEqual(imageVersion(tree), initialVersion);
  h.requests[1].resolve(snapshot('Superseded')); await h.settle(); tree = render();
  assert.match(JSON.stringify(tree), /Newest/); assert.doesNotMatch(JSON.stringify(tree), /Superseded/);
});

test('shared image refresh retains the loaded image until its replacement is ready', async () => {
  const h = harness(), item = { id: 'shared:image', title: 'Image', image: { width: 10, height: 20 }, updatedAt: 1 };
  const props = { item, language: 'en', version: '1' }, render = () => h.render('SharedCaptureImage', props);
  render(); h.requests[0].resolve([1, 2]); await h.settle(); let tree = render();
  assert.equal(flatten(tree).find(entry => entry.type === 'img').props.src, 'blob:1');
  props.version = '2'; render(); assert.equal(h.calls.length, 2);
  tree = render(); assert.equal(flatten(tree).find(entry => entry.type === 'img').props.src, 'blob:1'); assert.deepEqual(h.revoked, []);
  h.requests[1].resolve([3, 4]); await h.settle(); tree = render();
  assert.equal(flatten(tree).find(entry => entry.type === 'img').props.src, 'blob:2'); assert.deepEqual(h.revoked, ['blob:1']);
  props.version = '3'; render(); props.version = '4'; render();
  h.requests[3].resolve([5, 6]); await h.settle(); h.requests[2].resolve([7, 8]); await h.settle();
  tree = render(); assert.equal(flatten(tree).find(entry => entry.type === 'img').props.src, 'blob:4');
  h.unmount(); assert.deepEqual(h.revoked, ['blob:1', 'blob:2', 'blob:4']);
});
