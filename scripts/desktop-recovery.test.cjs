const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolve, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDesktop, readDesktopStore } = require('../dist/electron/desktop.js');

const plainCipher = { isEncryptionAvailable: () => false };
function temporaryDesktop(t) {
  const root = resolve(process.env.HORIZON_TEST_TEMP ?? '.runtime');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(join(root, 'desktop-recovery-')), path = join(directory, 'notebooks.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, path };
}
function denied() { return Object.assign(new Error('Synthetic storage failure'), { code: 'EACCES' }); }

for (const operation of ['readSync', 'readFileSync']) test(`an unread Desktop store survives ${operation} failure and Retry without any writes`, t => {
  const { directory, path } = temporaryDesktop(t);
  const original = createDesktop(path, plainCipher, () => {}), project = original.create('Existing project');
  original.flush(); original.dispose();
  const read = fs.readFileSync, bytes = read(path), underlying = fs[operation];
  let unavailable = true, moves = 0;
  t.mock.method(fs, operation, (...args) => {
    if (unavailable && (operation === 'readSync' || args[0] === path)) throw denied();
    return underlying(...args);
  });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => { moves++; return rename(...args); });
  const desktop = createDesktop(path, plainCipher, () => {});
  assert.equal(desktop.state().desktopReadError, true);
  assert.equal(desktop.state().desktopLocked, false);
  assert.throws(() => desktop.create('Replacement'), /DESKTOP_STORAGE_FAILED/);
  assert.throws(() => desktop.use(project.id), /DESKTOP_STORAGE_FAILED/);
  assert.throws(() => desktop.retry(), /DESKTOP_STORAGE_FAILED/);
  desktop.flush(); desktop.forget();
  assert.equal(moves, 0);
  unavailable = false;
  assert.deepEqual(read(path), bytes);
  assert.deepEqual(fs.readdirSync(directory), ['notebooks.json']);
  desktop.retry();
  assert.equal(desktop.state().desktopReadError, false);
  assert.equal(desktop.get(project.id).name, 'Existing project');
  assert.deepEqual(read(path), bytes);
  desktop.dispose();
});

test('failed corruption quarantine keeps Desktop read-only until Retry can preserve the original', t => {
  const { directory, path } = temporaryDesktop(t), bytes = Buffer.from('{');
  fs.writeFileSync(path, bytes);
  const rename = fs.renameSync; let unavailable = true;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (unavailable && args[0] === path) throw denied();
    return rename(...args);
  });
  const desktop = createDesktop(path, plainCipher, () => {});
  assert.throws(() => desktop.create('Replacement'), /DESKTOP_STORAGE_FAILED/);
  assert.throws(() => desktop.retry(), /DESKTOP_STORAGE_FAILED/);
  assert.deepEqual(fs.readFileSync(path), bytes);
  unavailable = false; desktop.retry(); desktop.dispose();
  const recovery = fs.readdirSync(directory).find(name => name.startsWith('notebooks.json.corrupt-'));
  assert.ok(recovery);
  assert.deepEqual(fs.readFileSync(join(directory, recovery)), bytes);
  assert.deepEqual(readDesktopStore(path).projects, []);
});

for (const original of ['missing', 'quarantined']) test(`a failed replacement write keeps the ${original} Desktop store usable in memory`, t => {
  const { directory, path } = temporaryDesktop(t), bytes = Buffer.from('{');
  if (original === 'quarantined') fs.writeFileSync(path, bytes);
  const rename = fs.renameSync; let unavailable = true;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (unavailable && args[1] === path) throw denied();
    return rename(...args);
  });
  const desktop = createDesktop(path, plainCipher, () => {});
  assert.equal(desktop.state().desktopReadError, true);
  const project = desktop.create('Memory project');
  assert.equal(desktop.get(project.id).name, 'Memory project');
  assert.equal(fs.existsSync(path), false);
  unavailable = false; desktop.retry(); desktop.dispose();
  assert.equal(readDesktopStore(path).projects[0].name, 'Memory project');
  if (original === 'quarantined') {
    const recovery = fs.readdirSync(directory).find(name => name.startsWith('notebooks.json.corrupt-'));
    assert.ok(recovery);
    assert.deepEqual(fs.readFileSync(join(directory, recovery)), bytes);
  }
});

function capture(desktop, project) {
  const id = randomUUID(), now = Date.now();
  desktop.addCapture(project, { id, kind: 'area', folder: null, title: 'Capture', text: '', note: '',
    source: { url: 'https://example.com/', title: 'Example' }, image: null, createdAt: now, updatedAt: now },
  Buffer.from('Synthetic capture'), { width: 1, height: 1, cut: false });
  desktop.flush();
  return desktop.item(project, id);
}
function failWrites(t, path) {
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => { if (args[1] === path) throw denied(); return rename(...args); });
}

for (const deletion of ['item', 'project', 'captures']) test(`failed ${deletion} deletion keeps its capture item and file when undo expires`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { directory, path } = temporaryDesktop(t), desktop = createDesktop(path, plainCipher, () => {});
  const project = desktop.create('Capture project'), destination = deletion === 'captures' ? null : project.id;
  const item = capture(desktop, destination), file = join(directory, 'captures', item.image.filename);
  failWrites(t, path);
  if (deletion === 'project') desktop.delete(project.id); else desktop.deleteItem(destination, item.id);
  t.mock.timers.tick(8000);
  assert.equal(desktop.state().desktopStorageError, true);
  assert.equal(desktop.item(destination, item.id).id, item.id);
  assert.ok(fs.existsSync(file));
  const stored = readDesktopStore(path);
  assert.ok((destination === null ? stored.captures : stored.projects.find(entry => entry.id === destination).items).some(entry => entry.id === item.id));
  desktop.dispose();
});

test('replacing a pending delete first saves it and keeps both captures when writes fail', t => {
  const { directory, path } = temporaryDesktop(t), desktop = createDesktop(path, plainCipher, () => {});
  const project = desktop.create('Capture project'), first = capture(desktop, project.id), second = capture(desktop, project.id);
  failWrites(t, path);
  desktop.deleteItem(project.id, first.id); desktop.deleteItem(project.id, second.id);
  assert.equal(desktop.item(project.id, first.id).id, first.id);
  desktop.flush(); desktop.forget();
  assert.deepEqual(desktop.get(project.id).items.map(item => item.id), [first.id, second.id]);
  for (const item of [first, second]) assert.ok(fs.existsSync(join(directory, 'captures', item.image.filename)));
  desktop.dispose();
});

test('an expired undo removes capture files after the deletion reaches the store', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { directory, path } = temporaryDesktop(t), desktop = createDesktop(path, plainCipher, () => {});
  const project = desktop.create('Capture project'), item = capture(desktop, project.id), file = join(directory, 'captures', item.image.filename);
  desktop.deleteItem(project.id, item.id); t.mock.timers.tick(500);
  assert.ok(fs.existsSync(file)); assert.deepEqual(readDesktopStore(path).projects[0].items, []);
  t.mock.timers.tick(7500); assert.equal(fs.existsSync(file), false);
  desktop.dispose();
});

test('project creation and renaming reserve Captures and refuse colliding readable addresses', t => {
  const { path } = temporaryDesktop(t), desktop = createDesktop(path, plainCipher, () => {});
  for (const name of ['Captures', 'CAPTURES', 'Captures?']) assert.throws(() => desktop.create(name), /PROJECT_ADDRESS_CONFLICT/);
  const route = desktop.create('Road trip'), other = desktop.create('Other');
  for (const name of ['Road-trip', 'Road  trip', 'Road trip?']) {
    assert.throws(() => desktop.create(name), /PROJECT_ADDRESS_CONFLICT/);
    assert.throws(() => desktop.rename(other.id, name), /PROJECT_ADDRESS_CONFLICT/);
  }
  assert.throws(() => desktop.rename(other.id, 'Captures'), /PROJECT_ADDRESS_CONFLICT/);
  assert.equal(desktop.get(other.id).name, 'Other');
  desktop.rename(route.id, 'Road-trip');
  assert.equal(desktop.get(route.id).name, 'Road-trip');
  assert.throws(() => desktop.create('ROAD-TRIP'), /PROJECT_NAME_DUPLICATE/);
  desktop.flush(); desktop.dispose();
  const reopened = createDesktop(path, plainCipher, () => {});
  assert.equal(reopened.get(route.id).name, 'Road-trip'); reopened.dispose();
});
