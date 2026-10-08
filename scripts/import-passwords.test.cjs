const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { validateCommand } = require('../dist/electron/commands.js');
const { assertPrivateCommand } = require('../dist/electron/private-commands.js');
const { PASSWORDS_FILE_LIMIT, deletePasswordsFile, passwordsFileName, passwordsFormat, readPasswordsFile } = require('../dist/electron/import-passwords.js');
const { createVault } = require('../dist/electron/vault.js');
const { IMPORT_BROWSERS } = require('../dist/src/shared/api.js');

const SECRET = 'Synthetic-password-never-logged-9731';
const csv = `name,url,username,password,note\nSynthetic,https://site.example/login,synthetic-user,${SECRET},\n`;
const line = ['info', 'log', 'warn', 'error', 'debug'];

// Everything the process writes to the console while the work runs, so a test can prove what reached a log.
async function logged(work) {
  const output = [], original = Object.fromEntries(line.map(name => [name, console[name]]));
  for (const name of line) console[name] = (...args) => { output.push(args.map(String).join(' ')); };
  try { await work(); } finally { for (const name of line) console[name] = original[name]; }
  return output;
}

// A Vault service double: it counts what it is asked and never keeps anything but the last file it was given.
function serviceDouble(overrides = {}, { granted = true } = {}) {
  const calls = { imports: [], statuses: 0, permissions: [] };
  let unlocked = false, allowed = granted, summaries = [];
  const view = () => ({ id: 'horizon', name: 'Horizon', kind: 'cosmic', status: 'granted', kinds: ['login'], permissions: allowed ? ['import'] : [] });
  const service = {
    async status() { calls.statuses++; return { created: true, unlocked }; }, async unlock() { unlocked = true; }, async lock() { unlocked = false; }, async close() {},
    async logins() { return []; }, async listLogins() { return summaries.map(item => ({ ...item })); }, entries: { async save() {} }, hello: { async unlock() { unlocked = true; } },
    apps: { async self() { return view(); } },
    permissions: { async importWithPassword(password) { calls.permissions.push(['password', password]); unlocked = true; allowed = true; return view(); }, async importWithHello(hwnd) { calls.permissions.push(['hello', hwnd]); unlocked = true; allowed = true; return view(); } },
    async import(format, text) { if (!allowed) throw Object.assign(new Error('permission_required'), { code: 'permission_required' }); calls.imports.push([format, text]); summaries = [{ id: 'imported-one', version: 1, title: 'Synthetic', username: 'synthetic-user', website: 'https://site.example/login' }]; return { imported: 1, duplicates: 2, skipped: 3 }; },
    ...overrides,
  };
  return { service, calls, unlock: () => { unlocked = true; }, grant: value => { allowed = value; } };
}

function controller(t, directory, { privateWindow = false, connect, cipher, granted = true } = {}) {
  const events = [], double = serviceDouble({}, { granted });
  const vault = createVault({ window: { webContents: { getZoomFactor: () => 1 }, getNativeWindowHandle: () => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(123n); return bytes; } }, directory, privateWindow, cipher, clipboard: { writeText() {}, readText: () => '', clear() {} },
    timeout: () => 'close', saveTimeout() {}, page: () => null, covered: () => false, revealPage() {}, changed: () => events.push(vault.state()),
    connect: connect ?? (async () => double.service) });
  t.after(() => vault.close());
  return { vault, double, events };
}

module.exports = ({ temporaryDirectory, authenticatedCipher, notebookBrowser }) => {
  test('the format follows the browser: Edge and Firefox have their own, every other Chromium browser is Chrome', () => {
    assert.deepEqual(Object.fromEntries(IMPORT_BROWSERS.map(browser => [browser, passwordsFormat(browser)])), {
      edge: 'edge', chrome: 'chrome', brave: 'chrome', vivaldi: 'chrome', chromium: 'chrome', opera: 'chrome', 'opera-gx': 'chrome', firefox: 'firefox',
    });
  });

  test('the exported file must be a plain UTF-8 text file of at most 8 MiB, and a refusal never carries its content or place', t => {
    const directory = temporaryDirectory(t, 'passwords-file'), path = name => join(directory, name);
    writeFileSync(path('good.csv'), csv); assert.equal(readPasswordsFile(path('good.csv')), csv);
    writeFileSync(path('bom.csv'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv)])); assert.equal(readPasswordsFile(path('bom.csv')), csv);
    writeFileSync(path('accents.csv'), 'name,url\nCafé ñandú,https://site.example/\n'); assert.equal(readPasswordsFile(path('accents.csv')), 'name,url\nCafé ñandú,https://site.example/\n');
    writeFileSync(path('limit.csv'), Buffer.alloc(PASSWORDS_FILE_LIMIT, 97)); assert.equal(readPasswordsFile(path('limit.csv')).length, PASSWORDS_FILE_LIMIT);
    writeFileSync(path('large.csv'), Buffer.alloc(PASSWORDS_FILE_LIMIT + 1, 97));
    assert.throws(() => readPasswordsFile(path('large.csv')), error => error.message === 'IMPORT_PASSWORDS_FILE_TOO_LARGE');
    writeFileSync(path('latin1.csv'), Buffer.concat([Buffer.from('name,password\nx,'), Buffer.from([0xe9, 0xff, 0xfe]), Buffer.from(SECRET)]));
    writeFileSync(path('nul.csv'), Buffer.from(`name,password\nx,${SECRET}\0y\n`));
    writeFileSync(path('utf16.csv'), Buffer.from(`\ufeff${csv}`, 'utf16le'));
    mkdirSync(path('folder.csv'));
    for (const name of ['latin1.csv', 'nul.csv', 'utf16.csv', 'folder.csv', 'missing.csv']) assert.throws(() => readPasswordsFile(path(name)), error => error.message === 'IMPORT_PASSWORDS_FILE_INVALID' && !error.message.includes(SECRET) && !error.message.includes(directory), name);
    try {
      symlinkSync(path('good.csv'), path('link.csv'), 'file');
      assert.throws(() => readPasswordsFile(path('link.csv')), error => error.message === 'IMPORT_PASSWORDS_FILE_INVALID');
      assert.throws(() => deletePasswordsFile(path('link.csv')), error => error.message === 'IMPORT_PASSWORDS_DELETE_FAILED');
      assert.equal(existsSync(path('link.csv')), true); assert.equal(existsSync(path('good.csv')), true);
    } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
    assert.equal(passwordsFileName(join(directory, 'Chrome Passwords.csv')), 'Chrome Passwords.csv');
    assert.equal(passwordsFileName(join(directory, `bad\u0007name\u0085${'x'.repeat(400)}.csv`)).length, 255); assert.doesNotMatch(passwordsFileName(join(directory, 'a\nb.csv')), /[\x00-\x1f\x7f-\x9f]/);
  });

  test('deleting removes exactly the chosen file for good and leaves its neighbours, folders and links alone', t => {
    const directory = temporaryDirectory(t, 'passwords-delete'), chosen = join(directory, 'chosen.csv'), other = join(directory, 'other.csv');
    writeFileSync(chosen, csv); writeFileSync(other, csv); mkdirSync(join(directory, 'folder.csv'));
    deletePasswordsFile(chosen);
    assert.equal(existsSync(chosen), false); assert.equal(readFileSync(other, 'utf8'), csv);
    assert.doesNotThrow(() => deletePasswordsFile(chosen));
    assert.throws(() => deletePasswordsFile(join(directory, 'folder.csv')), error => error.message === 'IMPORT_PASSWORDS_DELETE_FAILED');
    assert.equal(existsSync(join(directory, 'folder.csv')), true); assert.equal(existsSync(other), true);
  });

  test('Vault imports only after it is unlocked, sends the text once in the browser format and returns the counts', async t => {
    const directory = temporaryDirectory(t, 'passwords-vault'), { vault, double, events } = controller(t, directory, { cipher: authenticatedCipher() });
    let reads = 0;
    const read = () => { reads++; return csv; };
    const output = await logged(async () => {
      await assert.rejects(vault.importPasswords('chrome', read), error => error.message === 'VAULT_LOCKED');
      assert.equal(reads, 0); assert.deepEqual(double.calls.imports, []);
      await vault.run({ type: 'vault-unlock', password: 'Synthetic master password' });
      assert.deepEqual(await vault.importPasswords('firefox', read), { imported: 1, duplicates: 2, skipped: 3 });
      assert.deepEqual(await vault.importPasswords('edge', () => 'name,url,username,password\n'), { imported: 1, duplicates: 2, skipped: 3 });
    });
    assert.equal(reads, 1); assert.deepEqual(double.calls.imports, [['firefox', csv], ['edge', 'name,url,username,password\n']]);
    // The panel lists what the import brought, as display metadata only.
    assert.deepEqual(vault.state().logins, [{ id: 'imported-one', origin: 'https://site.example', title: 'Synthetic', username: 'synthetic-user' }]);
    const audit = output.map(entry => JSON.parse(entry));
    assert.deepEqual(audit.map(entry => [entry.event, entry.outcome]), [['import', 'denied'], ['unlock', 'allowed'], ['import', 'allowed'], ['import', 'allowed']]);
    assert.ok(audit.every(entry => Object.keys(entry).sort().join() === 'actor,event,outcome,time' && entry.actor === 'horizon'));
    assert.equal(output.join('\n').includes(SECRET), false); assert.equal(JSON.stringify(events).includes(SECRET), false); assert.equal(JSON.stringify(vault.state()).includes(SECRET), false);
  });

  test('Vault unavailable, a service refusal, a lock in between and a bad answer each fail with a code and show nothing of the file', async t => {
    const directory = temporaryDirectory(t, 'passwords-failures'), cipher = authenticatedCipher();
    const unavailable = controller(t, join(directory, 'unavailable'), { cipher, connect: async () => { throw new Error(`service said ${SECRET}`); } });
    let reads = 0;
    const read = () => { reads++; return csv; };
    const refuse = error => async () => { throw error; };
    const output = await logged(async () => {
      await assert.rejects(unavailable.vault.importPasswords('chrome', read), error => error.message === 'VAULT_UNAVAILABLE');
      assert.equal(unavailable.vault.state().error, 'VAULT_UNAVAILABLE'); assert.equal(reads, 0);
      for (const [name, service, code] of [
        ['a refusal', refuse(Object.assign(new Error(`forbidden ${SECRET}`), { code: 'forbidden' })), 'IMPORT_PASSWORDS_FAILED'],
        ['an unknown failure', refuse(new Error(SECRET)), 'IMPORT_PASSWORDS_FAILED'],
        ['a lock in between', refuse(Object.assign(new Error('locked'), { code: 'locked' })), 'VAULT_LOCKED'],
        ['a bad answer', async () => ({ imported: 'many', duplicates: 0, skipped: 0 }), 'IMPORT_PASSWORDS_FAILED'],
        ['a negative answer', async () => ({ imported: -1, duplicates: 0, skipped: 0 }), 'IMPORT_PASSWORDS_FAILED'],
        ['no answer', async () => undefined, 'IMPORT_PASSWORDS_FAILED'],
      ]) {
        const { vault, double } = controller(t, join(directory, name), { cipher });
        double.service.import = service; double.unlock();
        await assert.rejects(vault.importPasswords('chrome', read), error => error.message === code && !error.message.includes(SECRET), name);
        assert.equal(vault.state().logins.some(item => JSON.stringify(item).includes(SECRET)), false);
      }
      // The file itself being refused is not a decision of Vault: no audit, and Vault stays unlocked and usable.
      const { vault, double } = controller(t, join(directory, 'file'), { cipher }); double.unlock();
      await assert.rejects(vault.importPasswords('chrome', () => { throw new Error('IMPORT_PASSWORDS_FILE_INVALID'); }), error => error.message === 'IMPORT_PASSWORDS_FILE_INVALID');
      assert.deepEqual(double.calls.imports, []);
      assert.deepEqual(await vault.importPasswords('chrome', () => csv), { imported: 1, duplicates: 2, skipped: 3 });
    });
    assert.equal(output.join('\n').includes(SECRET), false);
    const audit = output.map(entry => JSON.parse(entry)).filter(entry => entry.event === 'import');
    assert.deepEqual(audit.map(entry => entry.outcome), ['denied', 'denied', 'denied', 'denied', 'denied', 'denied', 'denied', 'allowed']);
  });

  test('Vault refuses a second import while one runs, and private windows never connect', async t => {
    const directory = temporaryDirectory(t, 'passwords-busy'), cipher = authenticatedCipher();
    const { vault, double } = controller(t, join(directory, 'busy'), { cipher }); double.unlock();
    let release;
    double.service.import = () => new Promise(done => { release = () => done({ imported: 1, duplicates: 0, skipped: 0 }); });
    const first = vault.importPasswords('chrome', () => csv);
    await assert.rejects(vault.importPasswords('chrome', () => csv), error => error.message === 'VAULT_BUSY');
    for (let wait = 0; wait < 100 && !release; wait++) await new Promise(done => setTimeout(done, 5));
    release(); assert.deepEqual(await first, { imported: 1, duplicates: 0, skipped: 0 });
    let connected = 0, read = 0;
    const hidden = controller(t, join(directory, 'private'), { cipher, privateWindow: true, connect: async () => { connected++; return double.service; } });
    await assert.rejects(hidden.vault.importPasswords('chrome', () => { read++; return csv; }), error => error.message === 'VAULT_UNAVAILABLE');
    assert.equal(connected, 0); assert.equal(read, 0);
  });

  test('the password commands carry exact keys, a file is named by an opaque id only and private windows refuse them all', () => {
    const file = randomUUID();
    const valid = [{ type: 'choose-import-passwords-file' }, { type: 'import-passwords', browser: 'firefox', file }, { type: 'delete-import-passwords-file', file }];
    for (const command of valid) {
      assert.deepEqual(validateCommand(command), command);
      assert.throws(() => validateCommand({ ...command, extra: 1 }), /IMPORT_COMMAND_INVALID/);
      assert.throws(() => assertPrivateCommand(command), /Private window import is unavailable/);
      for (const key of Object.keys(command).filter(key => key !== 'type')) { const missing = { ...command }; delete missing[key]; assert.throws(() => validateCommand(missing), /IMPORT_COMMAND_INVALID/); }
    }
    for (const change of [{ file: 'C:\\Users\\someone\\passwords.csv' }, { file: '' }, { file: 7 }, { file: null }, { file: `${file}/..` }, { file: file.toUpperCase() + 'x' }]) {
      assert.throws(() => validateCommand({ ...valid[1], ...change }), /IMPORT_COMMAND_INVALID/); assert.throws(() => validateCommand({ ...valid[2], ...change }), /IMPORT_COMMAND_INVALID/);
    }
    for (const browser of ['safari', '', 7, null, undefined]) assert.throws(() => validateCommand({ ...valid[1], browser }), /IMPORT_COMMAND_INVALID/);
    for (const browser of IMPORT_BROWSERS) assert.doesNotThrow(() => validateCommand({ ...valid[1], browser }));
  });

  test('through the browser: the file is chosen and kept in main, imported once Vault is unlocked, counted, then deleted for good', async t => {
    const directory = temporaryDirectory(t, 'passwords-browser'), exported = join(directory, 'Chrome Passwords.csv'), neighbour = join(directory, 'Other.csv');
    writeFileSync(exported, csv); writeFileSync(neighbour, 'name,url\n');
    const double = serviceDouble(), options = { vaultConnect: async () => double.service, folderChoice: { canceled: false, filePaths: [exported] } };
    const cipher = authenticatedCipher(), browser = notebookBrowser(t, cipher, options), { command, state } = browser;
    const output = await logged(async () => {
      const chosen = await command({ type: 'choose-import-passwords-file' });
      assert.deepEqual(Object.keys(chosen).sort(), ['id', 'name']); assert.equal(chosen.name, 'Chrome Passwords.csv'); assert.match(chosen.id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(options.folderArgs[1].filters, [{ name: 'CSV', extensions: ['csv'] }]); assert.deepEqual(options.folderArgs[1].properties, ['openFile']);
      assert.equal(JSON.stringify([chosen, state()]).includes(directory.replaceAll('\\', '\\\\')), false);
      await assert.rejects(async () => command({ type: 'import-passwords', browser: 'chrome', file: randomUUID() }), /IMPORT_PASSWORDS_NO_FILE/);
      await assert.rejects(async () => command({ type: 'import-passwords', browser: 'chrome', file: chosen.id }), /VAULT_LOCKED/);
      assert.deepEqual(double.calls.imports, []);
      await command({ type: 'vault-unlock', password: 'Synthetic master password' });
      assert.deepEqual(await command({ type: 'import-passwords', browser: 'edge', file: chosen.id }), { imported: 1, duplicates: 2, skipped: 3 });
      assert.deepEqual(double.calls.imports, [['edge', csv]]);
      assert.deepEqual(state().vault.logins.map(item => item.id), ['imported-one']);
      await assert.rejects(async () => command({ type: 'delete-import-passwords-file', file: randomUUID() }), /IMPORT_PASSWORDS_NO_FILE/);
      assert.equal(existsSync(exported), true);
      await command({ type: 'delete-import-passwords-file', file: chosen.id });
      assert.equal(existsSync(exported), false); assert.equal(readFileSync(neighbour, 'utf8'), 'name,url\n');
      await assert.rejects(async () => command({ type: 'delete-import-passwords-file', file: chosen.id }), /IMPORT_PASSWORDS_NO_FILE/);
      await assert.rejects(async () => command({ type: 'import-passwords', browser: 'edge', file: chosen.id }), /IMPORT_PASSWORDS_NO_FILE/);
      options.folderChoice = { canceled: true, filePaths: [] };
      assert.equal(await command({ type: 'choose-import-passwords-file' }), null);
      options.folderError = true;
      await assert.rejects(async () => command({ type: 'choose-import-passwords-file' }), /IMPORT_PASSWORDS_FILE_INVALID/);
    });
    assert.equal(output.join('\n').includes(SECRET), false); assert.equal(output.join('\n').includes(directory), false);
    assert.deepEqual(output.map(entry => JSON.parse(entry)).map(entry => [entry.event, entry.outcome]), [['import', 'denied'], ['unlock', 'allowed'], ['import', 'allowed']]);
    const privateWindow = browser.addWindow({ privateWindow: true });
    for (const command of [{ type: 'choose-import-passwords-file' }, { type: 'import-passwords', browser: 'chrome', file: randomUUID() }, { type: 'delete-import-passwords-file', file: randomUUID() }]) await assert.rejects(async () => privateWindow.command(command), /Private window import is unavailable/);
  });

  test('through the browser: a link, a file that is too large or not UTF-8 and a file that vanished are refused before Vault sees anything', async t => {
    const directory = temporaryDirectory(t, 'passwords-browser-refused'), file = join(directory, 'export.csv');
    const double = serviceDouble(), options = { vaultConnect: async () => double.service, folderChoice: { canceled: false, filePaths: [file] } };
    const browser = notebookBrowser(t, authenticatedCipher(), options), { command } = browser;
    double.unlock(); await command({ type: 'vault-refresh' });
    const attempt = async (bytes, code) => {
      if (bytes) writeFileSync(file, bytes);
      const chosen = await command({ type: 'choose-import-passwords-file' });
      await assert.rejects(async () => command({ type: 'import-passwords', browser: 'chrome', file: chosen.id }), error => error.message.includes(code) && !error.message.includes(SECRET), code);
      assert.deepEqual(double.calls.imports, []);
      return chosen;
    };
    await attempt(Buffer.alloc(PASSWORDS_FILE_LIMIT + 1, 97), 'IMPORT_PASSWORDS_FILE_TOO_LARGE');
    await attempt(Buffer.concat([Buffer.from('a,b\n'), Buffer.from([0xff, 0xfe]), Buffer.from(SECRET)]), 'IMPORT_PASSWORDS_FILE_INVALID');
    await attempt(Buffer.from(`a,b\n${SECRET}\0`), 'IMPORT_PASSWORDS_FILE_INVALID');
    const gone = join(directory, 'gone.csv'); writeFileSync(gone, csv);
    options.folderChoice = { canceled: false, filePaths: [gone] };
    const chosen = await command({ type: 'choose-import-passwords-file' });
    rmSync(gone);
    await assert.rejects(async () => command({ type: 'import-passwords', browser: 'chrome', file: chosen.id }), /IMPORT_PASSWORDS_FILE_INVALID/);
    try {
      const target = join(directory, 'target.csv'), link = join(directory, 'link.csv'); writeFileSync(target, csv); symlinkSync(target, link, 'file');
      options.folderChoice = { canceled: false, filePaths: [link] };
      const linked = await command({ type: 'choose-import-passwords-file' });
      await assert.rejects(async () => command({ type: 'import-passwords', browser: 'chrome', file: linked.id }), /IMPORT_PASSWORDS_FILE_INVALID/);
      await assert.rejects(async () => command({ type: 'delete-import-passwords-file', file: linked.id }), /IMPORT_PASSWORDS_DELETE_FAILED/);
      assert.equal(existsSync(link), true); assert.equal(readFileSync(target, 'utf8'), csv);
    } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
    assert.deepEqual(double.calls.imports, []);
  });

  test('Vault asks for the import permission first: nothing is read or sent until it is given, with the master password or Windows Hello', async t => {
    const directory = temporaryDirectory(t, 'passwords-permission'), cipher = authenticatedCipher();
    const { vault, double } = controller(t, join(directory, 'password'), { cipher, granted: false });
    let reads = 0;
    const read = () => { reads++; return csv; };
    const output = await logged(async () => {
      await vault.run({ type: 'vault-refresh' });
      assert.equal(vault.state().importAllowed, false); assert.equal(vault.state().unlocked, false);
      double.unlock();
      await assert.rejects(vault.importPasswords('chrome', read), error => error.message === 'VAULT_IMPORT_PERMISSION');
      assert.equal(reads, 0); assert.deepEqual(double.calls.imports, []); assert.equal(vault.state().importAllowed, false);
      await vault.run({ type: 'vault-lock' });
      await vault.run({ type: 'vault-import-permission', password: SECRET });
      assert.deepEqual(double.calls.permissions, [['password', SECRET]]);
      assert.equal(vault.state().importAllowed, true); assert.equal(vault.state().unlocked, true); assert.equal(vault.state().unlockMethod, 'master');
      assert.deepEqual(await vault.importPasswords('chrome', read), { imported: 1, duplicates: 2, skipped: 3 });
    });
    assert.equal(reads, 1); assert.equal(output.join('\n').includes(SECRET), false);
    assert.deepEqual(output.map(entry => JSON.parse(entry)).map(entry => [entry.event, entry.outcome]), [['import', 'denied'], ['lock', 'allowed'], ['permission', 'allowed'], ['import', 'allowed']]);
    // Once granted, a locked Vault still needs the normal unlock step.
    const locked = controller(t, join(directory, 'locked'), { cipher });
    await locked.vault.run({ type: 'vault-refresh' });
    assert.equal(locked.vault.state().importAllowed, true);
    await assert.rejects(locked.vault.importPasswords('chrome', read), error => error.message === 'VAULT_LOCKED'); assert.equal(reads, 1);
    // The service can still refuse an import for lack of the permission, and nothing is saved.
    const refused = controller(t, join(directory, 'refused'), { cipher }); refused.double.unlock();
    refused.double.service.import = async () => { throw Object.assign(new Error('permission_required'), { code: 'permission_required' }); };
    await refused.vault.run({ type: 'vault-refresh' });
    await assert.rejects(refused.vault.importPasswords('chrome', read), error => error.message === 'VAULT_IMPORT_PERMISSION');
    assert.equal(refused.vault.state().importAllowed, false); assert.equal(refused.vault.state().unlocked, true);
  });

  test('Windows Hello approves the import permission with the decimal window handle and unlocks Vault', { skip: process.platform !== 'win32' }, async t => {
    const { vault, double } = controller(t, join(temporaryDirectory(t, 'passwords-hello'), 'vault'), { cipher: authenticatedCipher(), granted: false });
    const output = await logged(async () => { await vault.run({ type: 'vault-import-permission-hello' }); });
    assert.deepEqual(double.calls.permissions, [['hello', '123']]);
    assert.equal(vault.state().importAllowed, true); assert.equal(vault.state().unlocked, true); assert.equal(vault.state().unlockMethod, 'hello');
    assert.deepEqual(output.map(entry => JSON.parse(entry)).map(entry => [entry.event, entry.outcome]), [['permission', 'allowed']]);
  });

  test('each answer of the permission request has its own code, is audited as denied and leaves Vault as it was', async t => {
    const directory = temporaryDirectory(t, 'passwords-permission-errors'), cipher = authenticatedCipher();
    const failing = code => async () => { throw Object.assign(new Error(`service said ${SECRET}`), { code }); };
    const cases = [
      ['password', 'locked', 'VAULT_PERMISSION_PASSWORD'], ['password', 'limited', 'VAULT_PERMISSION_LIMITED'], ['password', 'forbidden', 'VAULT_PERMISSION_FORBIDDEN'],
      ['password', 'unavailable', 'VAULT_UNAVAILABLE'], ['password', 'surprise', 'VAULT_UNAVAILABLE'],
      ...(process.platform === 'win32' ? [['hello', 'locked', 'VAULT_HELLO_FAILED'], ['hello', 'limited', 'VAULT_PERMISSION_LIMITED'], ['hello', 'not_found', 'VAULT_HELLO_NOT_SET_UP'],
        ['hello', 'unavailable', 'VAULT_HELLO_UNAVAILABLE'], ['hello', 'forbidden', 'VAULT_PERMISSION_FORBIDDEN']] : []),
    ];
    const output = await logged(async () => {
      for (const [way, code, expected] of cases) {
        const { vault, double } = controller(t, join(directory, `${way}-${code}`), { cipher, granted: false });
        double.service.permissions.importWithPassword = failing(code); double.service.permissions.importWithHello = failing(code);
        await vault.run({ type: 'vault-refresh' });
        const command = way === 'password' ? { type: 'vault-import-permission', password: SECRET } : { type: 'vault-import-permission-hello' };
        await assert.rejects(vault.run(command), error => error.message === expected && !error.message.includes(SECRET), `${way} ${code}`);
        assert.equal(vault.state().importAllowed, false); assert.equal(vault.state().unlocked, false);
        if (command.password !== undefined) assert.equal(command.password, '');
      }
    });
    assert.equal(output.join('\n').includes(SECRET), false);
    assert.ok(output.length >= cases.length);
    assert.ok(output.map(entry => JSON.parse(entry)).every(entry => entry.event === 'permission' && entry.outcome === 'denied'));
  });

  test('the permission commands carry exactly a bounded password or nothing', () => {
    assert.deepEqual(validateCommand({ type: 'vault-import-permission', password: 'Synthetic master password' }), { type: 'vault-import-permission', password: 'Synthetic master password' });
    assert.deepEqual(validateCommand({ type: 'vault-import-permission-hello' }), { type: 'vault-import-permission-hello' });
    for (const command of [{ type: 'vault-import-permission' }, { type: 'vault-import-permission', password: 'x', extra: 1 }, { type: 'vault-import-permission', password: 'x'.repeat(129) }, { type: 'vault-import-permission', password: 7 },
      { type: 'vault-import-permission-hello', password: 'x' }, { type: 'vault-import-permission-hello', hwnd: '1' }]) assert.throws(() => validateCommand(command), /VAULT_COMMAND_INVALID/);
  });

  test('every password string exists in English and Spanish with the same placeholders and no dashes', () => {
    const { copy } = require('../dist/src/copy.js');
    const keys = Object.keys(copy).filter(key => /^VAULT_PERMISSION|^VAULT_HELLO|^VAULT_IMPORT_PERMISSION|^vaultImportPermission|^importPasswords|^importedPasswords|^IMPORT_PASSWORDS|^importSetting|^importSitePermissions|^importTranslations|^importedSettings|^IMPORT_SETTINGS/.test(key));
    assert.ok(keys.length >= 30);
    for (const key of keys) {
      assert.ok(copy[key].en.trim() && copy[key].es.trim(), key);
      const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join();
      assert.equal(placeholders(copy[key].en), placeholders(copy[key].es), key);
    }
    for (const stem of ['importedPasswords', 'importedPasswordsDuplicate', 'importedPasswordsSkipped', 'importSitePermissions', 'importTranslations']) {
      for (const form of ['One', 'Many']) assert.match(copy[stem + form].en, /\{count\}/, stem + form);
      assert.notEqual(copy[stem + 'One'].en, copy[stem + 'Many'].en); assert.notEqual(copy[stem + 'One'].es, copy[stem + 'Many'].es);
    }
  });
};
