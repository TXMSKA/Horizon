const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { join, dirname } = require('node:path');
const { createFaviconCache, cacheFavicon, validateFaviconOrigins, FAVICON_CACHE_LIMIT, FAVICON_CACHE_BYTES } = require('../dist/electron/favicon-cache.js');
const { FAVICON_LIMIT } = require('../dist/electron/favicon.js');
const { encryptedStore, readStoreFile, writeStoreFile } = require('../dist/electron/store.js');
const { profileStorePath } = require('../dist/electron/profiles.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

// NativeImage is supplied by the browser; these deterministic images exercise cache limits without launching Electron.
function image(width = 1, height = 1, encoded = png, resized = () => {}) {
  return { isEmpty: () => false, getSize: () => ({ width, height }), toPNG: () => encoded,
    resize(size) { resized(size); return image(size.width, size.height, encoded); } };
}
const decode = bytes => {
  if (!bytes.equals(png)) throw new Error('Synthetic decoder rejected corrupt raster');
  return image();
};

module.exports = ({ temporaryDirectory, authenticatedCipher, notebookBrowser, fireTimers }) => {
  test('favorite favicon cache accepts raster decodes only and enforces input, pixel and output caps', () => {
    let calls = 0;
    const decoder = bytes => { calls++; return decode(bytes); };
    for (const bytes of [Buffer.from('<svg/>'), Buffer.from('no image'), Buffer.alloc(FAVICON_LIMIT + 1)]) assert.equal(cacheFavicon(bytes, decoder), null);
    assert.equal(calls, 0);
    assert.equal(cacheFavicon(png.subarray(0, 12), decoder), null);
    assert.equal(cacheFavicon(png, () => ({ isEmpty: () => true })), null);
    assert.equal(cacheFavicon(png, () => { throw new Error('Decode failed'); }), null);
    assert.equal(cacheFavicon(png, () => image(32, 32, Buffer.concat([png, Buffer.alloc(FAVICON_CACHE_BYTES)]))), null);
    assert.equal(cacheFavicon(png, () => image(1, 1, Buffer.from('<svg/>'))), null);
    let size;
    assert.deepEqual(cacheFavicon(png, () => image(256, 128, png, value => { size = value; })), png);
    assert.deepEqual(size, { width: 32, height: 16 });
    const boundary = Buffer.concat([png, Buffer.alloc(FAVICON_CACHE_BYTES - png.length)]);
    assert.equal(cacheFavicon(png, () => image(32, 32, boundary)).length, FAVICON_CACHE_BYTES);
  });

  test('favorite favicon cache is encrypted at rest and persisted in least recently used order with 2000 origins', t => {
    const path = join(temporaryDirectory(t, 'favicon-lru'), 'favicons.json'), cipher = authenticatedCipher();
    let changes = 0;
    const cache = createFaviconCache(path, cipher, decode, () => { changes++; }); t.after(() => cache.dispose());
    for (let index = 0; index < FAVICON_CACHE_LIMIT; index++) assert.equal(cache.put(`https://site-${index}.example`, png), true);
    assert.ok(cache.get(['https://site-0.example'])['https://site-0.example']);
    cache.put('https://replacement.example', png); cache.flush();
    assert.equal(changes, FAVICON_CACHE_LIMIT + 1);
    assert.deepEqual(cache.get(['https://site-1.example']), {});
    assert.ok(cache.get(['https://site-0.example'])['https://site-0.example']); cache.flush();
    assert.equal(encryptedStore(path), true);
    const disk = readFileSync(path); assert.equal(disk.includes(Buffer.from('site-0.example')), false); assert.equal(disk.includes(Buffer.from(png.toString('base64'))), false);
    const stored = readStoreFile(path, cipher); assert.equal(stored.icons.length, FAVICON_CACHE_LIMIT); assert.equal(stored.icons.at(-1).origin, 'https://site-0.example');
    const reopened = createFaviconCache(path, cipher, decode, () => {}); t.after(() => reopened.dispose());
    assert.ok(reopened.get(['https://site-0.example'])['https://site-0.example']); assert.deepEqual(reopened.get(['https://site-1.example']), {});
    const version = reopened.version; reopened.put('https://site-0.example', png); assert.equal(reopened.version, version);
  });

  test('favorite favicon cache uses owner-only fallback and preserves encrypted data when the keyring is unavailable', t => {
    const path = join(temporaryDirectory(t, 'favicon-keyring'), 'favicons.json'), plain = { isEncryptionAvailable: () => false }, cipher = authenticatedCipher();
    const cache = createFaviconCache(path, plain, decode, () => {}); cache.put('https://plain.example', png); cache.flush(); cache.dispose();
    assert.equal(encryptedStore(path), false); if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    const encrypted = createFaviconCache(path, cipher, decode, () => {}); encrypted.flush(); encrypted.dispose(); assert.equal(encryptedStore(path), true);
    const before = readFileSync(path), locked = createFaviconCache(path, plain, decode, () => {}); t.after(() => locked.dispose());
    assert.deepEqual(locked.get(['https://plain.example']), {}); locked.put('https://new.example', png); locked.flush(); assert.deepEqual(readFileSync(path), before);
  });

  test('favorite favicon cache ignores invalid saved icons and clearing cancels pending and stale writes', t => {
    const path = join(temporaryDirectory(t, 'favicon-clear'), 'favicons.json'), cipher = authenticatedCipher();
    writeStoreFile(path, { version: 1, icons: [{ origin: 'https://valid.example', png: png.toString('base64') }, { origin: 'https://bad.example', png: png.subarray(0, 12).toString('base64') }, { origin: 'javascript:bad', png: png.toString('base64') }, { origin: 'https://big.example', png: Buffer.alloc(FAVICON_CACHE_BYTES + 1).toString('base64') }] }, cipher);
    const cache = createFaviconCache(path, cipher, decode, () => {}); t.after(() => cache.dispose());
    assert.equal(Object.keys(cache.get(['https://valid.example', 'https://bad.example', 'https://big.example'])).length, 1);
    const epoch = cache.epoch; cache.put('https://pending.example', png); cache.clear(); cache.flush();
    assert.equal(existsSync(path), false); assert.deepEqual(cache.get(['https://valid.example']), {});
    assert.equal(cache.put('https://late.example', png, epoch), false); cache.flush(); assert.equal(existsSync(path), false);
    cache.put('https://later.example', png); cache.flush(); assert.equal(existsSync(path), true);
    cache.dispose(); assert.equal(cache.put('https://disposed.example', png), false);
  });

  test('private favorite favicon cache never reads, decodes, encrypts, writes or clears its file', t => {
    const path = join(temporaryDirectory(t, 'favicon-private'), 'favicons.json'); writeFileSync(path, 'untouched cache');
    const fail = () => assert.fail('Private cache touched a dependency');
    const cache = createFaviconCache(path, { isEncryptionAvailable: fail, encryptString: fail, decryptString: fail }, fail, fail, true);
    assert.deepEqual(cache.get(['https://private.example']), {}); assert.equal(cache.put('https://private.example', png), false); cache.clear(); cache.flush(); cache.dispose();
    assert.equal(readFileSync(path, 'utf8'), 'untouched cache'); assert.equal(cache.version, 0);
  });

  test('favorite favicon IPC accepts only exact web origins in dense arrays of at most 200', () => {
    assert.deepEqual(validateFaviconOrigins(['https://example.com', 'http://localhost:8080', 'https://[::1]:8443']), ['https://example.com', 'http://localhost:8080', 'https://[::1]:8443']);
    assert.equal(validateFaviconOrigins(new Array(200).fill('https://example.com')).length, 200);
    for (const value of [undefined, {}, 'https://example.com', new Array(1), new Array(201).fill('https://example.com'), ['https://example.com/'], ['https://example.com/path'], ['https://example.com?q=a'], ['https://example.com#x'], ['https://user:pass@example.com'], ['https://EXAMPLE.com'], ['https://example.com:443'], ['file:///'], ['javascript:bad'], ['data:image/png;base64,a'], ['https://example.com', null]]) assert.throws(() => validateFaviconOrigins(value));
  });

  test('finished tab favicons fill only their profile cache and the IPC validates the sender', async t => {
    const options = { faviconDecode: decode }, browser = notebookBrowser(t, authenticatedCipher(), options), { state, command } = browser;
    browser.navigate('https://tabs.example/page'); const origin = 'https://tabs.example', profile = state().activeProfileId;
    const contents = browser.views.at(-1).webContents, get = (...args) => browser.handlers.get('horizon:favorite-favicons')(browser.event, ...args);
    for (const args of [[], ['https://tabs.example'], [[origin], 1], [['https://tabs.example/path']], [new Array(201).fill(origin)]]) assert.throws(() => get(...args));
    assert.throws(() => browser.handlers.get('horizon:favorite-favicons')({ ...browser.event, sender: {} }, [origin]));
    assert.deepEqual(get([origin]), {}); const version = state().favoriteFaviconVersion;
    let requests = 0; contents.session.fetch = async () => { requests++; return new Response(png); };
    contents.emit('page-favicon-updated', {}, ['https://tabs.example/icon.png']); await new Promise(setImmediate);
    assert.equal(state().favoriteFaviconVersion, version + 1); assert.equal(get([origin])[origin], `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(requests, 1); browser.browser.flush(); const path = join(dirname(profileStorePath(browser.directory, profile)), 'favicons.json'); assert.equal(encryptedStore(path), true);
    const other = state().profiles.find(value => value.id !== profile); command({ type: 'switch-profile', id: other.id }); assert.deepEqual(get([origin]), {});
    command({ type: 'switch-profile', id: profile }); assert.ok(get([origin])[origin]);
    const privateWindow = browser.addWindow({ profileId: profile, privateWindow: true, fresh: true });
    assert.deepEqual(browser.handlers.get('horizon:favorite-favicons')(privateWindow.event, [origin]), {});
    const before = readFileSync(path); let privateDecodes = 0; options.faviconDecode = () => { privateDecodes++; return image(); };
    privateWindow.navigate('https://private.example/page'); const privateContents = browser.views.at(-1).webContents;
    privateContents.session.fetch = async () => new Response(png); privateContents.emit('page-favicon-updated', {}, ['https://private.example/icon.png']); await new Promise(setImmediate);
    assert.equal(privateDecodes, 0); assert.equal(privateWindow.state().favoriteFaviconVersion, 0); assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(get(['https://private.example']), {}); privateWindow.close();
    assert.equal(requests, 1, 'Favorite cache lookup never issues a network request');
  });

  test('Chromium and Firefox import commands fill the encrypted favorite cache and skip a corrupt smallest decode', async t => {
    const root = temporaryDirectory(t, 'favicon-import-command'), local = join(root, 'Local'), roaming = join(root, 'Roaming');
    mkdirSync(local); mkdirSync(roaming);
    const sourceProfile = join(local, 'Microsoft', 'Edge', 'User Data', 'Default'), firefoxRoot = join(roaming, 'Mozilla', 'Firefox'), firefoxProfile = join(firefoxRoot, 'Profiles', 'abc.default-release');
    mkdirSync(sourceProfile, { recursive: true }); mkdirSync(firefoxProfile, { recursive: true });
    writeFileSync(join(dirname(sourceProfile), 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Synthetic' } } } }));
    writeFileSync(join(sourceProfile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [{ type: 'url', name: 'Imported', url: 'https://imported.example/page' }] } } }));
    writeFileSync(join(firefoxRoot, 'profiles.ini'), '[Profile0]\nName=Synthetic\nIsRelative=1\nPath=Profiles/abc.default-release\n');
    const places = new DatabaseSync(join(firefoxProfile, 'places.sqlite'));
    try {
      places.exec('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, parent INTEGER, position INTEGER, type INTEGER, title TEXT, dateAdded INTEGER, guid TEXT, fk INTEGER)');
      places.prepare('INSERT INTO moz_places VALUES (?, ?)').run(1, 'https://imported.example/page');
      const bookmark = places.prepare('INSERT INTO moz_bookmarks VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      bookmark.run(1, 0, 0, 2, 'Root', 0, 'root________', null); bookmark.run(2, 1, 0, 2, 'Toolbar', 0, 'toolbar_____', null); bookmark.run(3, 2, 0, 1, 'Imported', 0, 'link________', 1);
    } finally { places.close(); }
    for (const [source, firefox] of [[sourceProfile, false], [firefoxProfile, true]]) {
      const database = new DatabaseSync(join(source, firefox ? 'favicons.sqlite' : 'Favicons'));
      try {
        if (firefox) {
          database.exec('CREATE TABLE moz_pages_w_icons (id INTEGER PRIMARY KEY, page_url TEXT); CREATE TABLE moz_icons_to_pages (page_id INTEGER, icon_id INTEGER); CREATE TABLE moz_icons (id INTEGER PRIMARY KEY, width INTEGER, data BLOB)');
          const page = database.prepare('INSERT INTO moz_pages_w_icons VALUES (?, ?)'), mapping = database.prepare('INSERT INTO moz_icons_to_pages VALUES (?, ?)'), bitmap = database.prepare('INSERT INTO moz_icons VALUES (?, ?, ?)');
          page.run(1, 'https://imported.example/page'); page.run(2, 'https://history-only.example/page');
          mapping.run(1, 1); mapping.run(1, 2); mapping.run(2, 3);
          bitmap.run(1, 16, png.subarray(0, 12)); bitmap.run(2, 32, png); bitmap.run(3, 16, png);
        } else {
          database.exec('CREATE TABLE icon_mapping (id INTEGER PRIMARY KEY, page_url TEXT, icon_id INTEGER); CREATE TABLE favicons (id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE favicon_bitmaps (id INTEGER PRIMARY KEY, icon_id INTEGER, width INTEGER, height INTEGER, image_data BLOB)');
          const mapping = database.prepare('INSERT INTO icon_mapping VALUES (?, ?, ?)'), favicon = database.prepare('INSERT INTO favicons VALUES (?, ?)'), bitmap = database.prepare('INSERT INTO favicon_bitmaps VALUES (?, ?, ?, ?, ?)');
          mapping.run(1, 'https://imported.example/page', 1); mapping.run(2, 'https://history-only.example/page', 2);
          favicon.run(1, 'https://imported.example/icon.png'); favicon.run(2, 'https://history-only.example/icon.png');
          bitmap.run(1, 1, 16, 16, png.subarray(0, 12)); bitmap.run(2, 1, 32, 32, png); bitmap.run(3, 2, 16, 16, png);
        }
      } finally { database.close(); }
    }
    const previous = { HORIZON_IMPORT_LOCALAPPDATA: process.env.HORIZON_IMPORT_LOCALAPPDATA, HORIZON_IMPORT_APPDATA: process.env.HORIZON_IMPORT_APPDATA };
    process.env.HORIZON_IMPORT_LOCALAPPDATA = local; process.env.HORIZON_IMPORT_APPDATA = roaming;
    t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
    for (const [source, profile] of [['edge', 'Default'], ['firefox', 'abc.default-release']]) {
      let rejected = 0, accepted = 0;
      const browser = notebookBrowser(t, authenticatedCipher(), { faviconDecode: bytes => { try { const result = decode(bytes); accepted++; return result; } catch (error) { rejected++; throw error; } } });
      await browser.command({ type: 'import-browser-data', browser: source, profile, favorites: true, history: false, searchEngine: false, settings: false });
      const origins = ['https://imported.example', 'https://history-only.example'];
      const icons = browser.handlers.get('horizon:favorite-favicons')(browser.event, origins);
      assert.deepEqual(Object.keys(icons), ['https://imported.example']); assert.equal(rejected, 1); assert.equal(accepted, 1);
      const path = join(dirname(profileStorePath(browser.directory, browser.state().activeProfileId)), 'favicons.json');
      assert.equal(encryptedStore(path), true); assert.equal(readFileSync(path).includes(Buffer.from('imported.example')), false);
      browser.close();
    }
  });

  test('history, cached images, clear-on-close and profile removal erase favorite favicon browsing data', async t => {
    const browser = notebookBrowser(t, authenticatedCipher(), { faviconDecode: decode }), { state, command } = browser;
    browser.navigate('https://clear.example/page'); const profile = state().activeProfileId, path = join(dirname(profileStorePath(browser.directory, profile)), 'favicons.json');
    const contents = browser.views.at(-1).webContents, get = () => browser.handlers.get('horizon:favorite-favicons')(browser.event, ['https://clear.example']);
    const fill = async () => { contents.session.fetch = async () => new Response(png); contents.emit('page-favicon-updated', {}, ['https://clear.example/icon.png']); await new Promise(setImmediate); browser.browser.flush(); assert.equal(existsSync(path), true); };
    for (const kind of ['history', 'cache']) {
      await fill(); await command({ type: 'clear-browsing-data', history: kind === 'history', cookies: false, cache: kind === 'cache' });
      assert.equal(existsSync(path), false); assert.deepEqual(get(), {});
    }
    await fill(); command({ type: 'clear-history' }); assert.equal(existsSync(path), false); assert.deepEqual(get(), {});
    let finish; contents.session.fetch = () => new Promise(done => { finish = done; }); contents.emit('page-favicon-updated', {}, ['https://clear.example/late.png']);
    await command({ type: 'clear-browsing-data', history: false, cookies: false, cache: true }); finish(new Response(png)); await new Promise(setImmediate); browser.browser.flush(); assert.deepEqual(get(), {}); assert.equal(existsSync(path), false);
    await fill(); await command({ type: 'delete-profile', id: profile }); fireTimers(browser.timers, 500); assert.equal(existsSync(path), false);
    browser.close();
    for (const flag of ['set-clear-history-on-close', 'set-clear-cache-on-close']) {
      const closing = notebookBrowser(t, authenticatedCipher(), { faviconDecode: decode }); closing.navigate('https://close.example');
      const page = closing.views.at(-1).webContents; page.session.fetch = async () => new Response(png); page.emit('page-favicon-updated', {}, ['https://close.example/icon.png']); await new Promise(setImmediate); closing.browser.flush();
      const savedPath = join(dirname(profileStorePath(closing.directory, closing.state().activeProfileId)), 'favicons.json'); assert.equal(existsSync(savedPath), true);
      closing.command({ type: flag, value: true }); closing.app.emit('before-quit', { preventDefault() {} }); await new Promise(setImmediate);
      assert.equal(existsSync(savedPath), false); closing.close();
    }
  });

  test('sync profile removal erases cached icons and cancels pending cache persistence', async t => {
    let host;
    const browser = notebookBrowser(t, authenticatedCipher(), { faviconDecode: decode, syncHostCapture: value => { host = value; } });
    browser.navigate('https://removed.example/page'); const profile = browser.state().activeProfileId;
    const contents = browser.views.at(-1).webContents; contents.session.fetch = async () => new Response(png);
    contents.emit('page-favicon-updated', {}, ['https://removed.example/icon.png']); await new Promise(setImmediate); browser.browser.flush();
    const path = join(dirname(profileStorePath(browser.directory, profile)), 'favicons.json'); assert.equal(existsSync(path), true);
    browser.handlers.get('horizon:favorite-favicons')(browser.event, ['https://removed.example']);
    const snapshot = host.read(); snapshot.profiles = snapshot.profiles.filter(value => value.id !== profile);
    host.apply(snapshot, new Map()); fireTimers(browser.timers, 500);
    assert.equal(existsSync(path), false); assert.notEqual(browser.state().activeProfileId, profile);
  });
};
