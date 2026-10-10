const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { crc32, deflateSync } = require('node:zlib');
const { validateCommand } = require('../dist/electron/commands.js');
const { assertPrivateCommand } = require('../dist/electron/private-commands.js');
const { createSettings, readSettings, validateSettings, writeSettings } = require('../dist/electron/settings.js');
const { readStore, validateStore, writeStore } = require('../dist/electron/store.js');
const { validFavorites } = require('../dist/electron/favorites.js');
const { discoverImportSources, mozlz4, parseChromiumBookmarks, parseFirefoxBookmarks, readImport, searchEngineByAddress, searchEngineByName, BOOKMARK_NODE_LIMIT } = require('../dist/electron/import.js');
const { HISTORY_LIMIT, mergeFavorites, mergeHistory } = require('../dist/electron/import-merge.js');
const { FAVICON_LIMIT } = require('../dist/electron/favicon.js');
const { copy } = require('../dist/src/copy.js');

const NOW = Date.UTC(2026, 9, 5, 12);
const labels = { mobile: 'Mobile favorites', menu: 'Bookmarks menu' };
const chromiumMicroseconds = milliseconds => BigInt(milliseconds + 11644473600000) * 1000n;
const link = (name, url, added = NOW) => ({ type: 'url', name, url, date_added: String(chromiumMicroseconds(added)) });
const folder = (name, children, added = NOW) => ({ type: 'folder', name, children, date_added: String(chromiumMicroseconds(added)) });
const bookmarks = (bar, other = [], synced = []) => JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: bar }, other: { type: 'folder', children: other }, synced: { type: 'folder', children: synced } } });
const names = items => items.map(item => item.kind === 'folder' ? { [item.name]: names(item.children) } : item.title);
const urls = items => items.flatMap(item => item.kind === 'folder' ? urls(item.children) : [item.url]);
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function chromiumHistory(path, rows) {
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)');
  const insert = database.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.url, row.title, row.visits, chromiumMicroseconds(row.last), row.hidden ?? 0);
  database.close();
}

function faviconPNG(width, color) {
  const chunk = (kind, bytes) => {
    const type = Buffer.from(kind), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(width, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * width);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) pixels.set([...color, 255], y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function faviconDatabase(path, firefox, rows, walMode = false) {
  const database = new DatabaseSync(path);
  if (walMode) database.exec('PRAGMA journal_mode = WAL');
  database.exec(firefox
    ? 'CREATE TABLE moz_pages_w_icons (id INTEGER PRIMARY KEY, page_url TEXT); CREATE TABLE moz_icons_to_pages (page_id INTEGER, icon_id INTEGER); CREATE TABLE moz_icons (id INTEGER PRIMARY KEY, icon_url TEXT, width INTEGER, data BLOB)'
    : 'CREATE TABLE icon_mapping (id INTEGER PRIMARY KEY, page_url TEXT, icon_id INTEGER); CREATE TABLE favicons (id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE favicon_bitmaps (id INTEGER PRIMARY KEY, icon_id INTEGER, width INTEGER, height INTEGER, image_data BLOB)');
  database.exec('BEGIN');
  let id = 0;
  for (const row of rows) {
    id++;
    if (firefox) {
      database.prepare('INSERT INTO moz_pages_w_icons VALUES (?, ?)').run(id, row.url);
      database.prepare('INSERT INTO moz_icons_to_pages VALUES (?, ?)').run(id, id);
      database.prepare('INSERT INTO moz_icons VALUES (?, ?, ?, ?)').run(id, `https://icons.example/${id}`, row.width, row.bytes);
    } else {
      database.prepare('INSERT INTO icon_mapping VALUES (?, ?, ?)').run(id, row.url, id);
      database.prepare('INSERT INTO favicons VALUES (?, ?)').run(id, `https://icons.example/${id}`);
      database.prepare('INSERT INTO favicon_bitmaps VALUES (?, ?, ?, ?, ?)').run(id, id, row.width, row.width, row.bytes);
    }
  }
  database.exec('COMMIT');
  return database;
}

function firefoxDatabase(path, { walMode = false } = {}) {
  const database = new DatabaseSync(path);
  if (walMode) database.exec('PRAGMA journal_mode = WAL');
  database.exec('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, last_visit_date INTEGER)');
  database.exec('CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER, guid TEXT)');
  const place = database.prepare('INSERT INTO moz_places (id, url, title, visit_count, hidden, last_visit_date) VALUES (?, ?, ?, ?, ?, ?)');
  const mark = database.prepare('INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const micro = milliseconds => BigInt(milliseconds) * 1000n;
  place.run(1, 'https://example.com/ff-one', 'FF one', 4, 0, micro(NOW - 1000));
  place.run(2, 'https://example.com/ff-two', 'FF two', 2, 0, micro(NOW - 5000));
  place.run(3, 'https://example.com/ff-hidden', 'Hidden', 1, 1, micro(NOW));
  place.run(4, 'https://example.com/ff-never', 'Bookmarked only', 0, 0, null);
  place.run(5, 'javascript:alert(1)', 'Script', 1, 0, micro(NOW - 9000));
  place.run(6, 'place:type=6&sort=14', 'Recent tags', 0, 0, null);
  place.run(7, 'https://example.com/ff-tagged', 'Tagged', 1, 0, micro(NOW - 9000));
  for (const [id, type, fk, parent, position, title, guid] of [
    [1, 2, null, 0, 0, '', 'root________'], [2, 2, null, 1, 0, 'menu', 'menu________'], [3, 2, null, 1, 1, 'Bookmarks Toolbar', 'toolbar_____'], [4, 2, null, 1, 2, 'Tags', 'tags________'],
    [5, 2, null, 1, 3, 'Other Bookmarks', 'unfiled_____'], [6, 2, null, 1, 4, 'Mobile Bookmarks', 'mobile______'],
    [10, 1, 1, 3, 0, 'Bar link', 'aaaaaaaaaaaa'], [11, 2, null, 3, 1, 'Finanzas', 'bbbbbbbbbbbb'], [12, 1, 2, 11, 0, 'In folder', 'cccccccccccc'], [13, 3, null, 11, 1, null, 'dddddddddddd'],
    [14, 1, 5, 3, 2, 'Script link', 'eeeeeeeeeeee'], [15, 1, 6, 5, 0, 'Place query', 'ffffffffffff'], [16, 1, 4, 2, 0, 'Menu link', 'gggggggggggg'], [17, 1, 7, 6, 0, 'Phone link', 'hhhhhhhhhhhh'], [18, 1, 7, 4, 0, 'Tag entry', 'iiiiiiiiiiii'],
  ]) mark.run(id, type, fk, parent, position, title, micro(NOW - id * 1000), guid);
  return database;
}

function literalBlock(bytes) {
  // An LZ4 block of one literals-only sequence, which is a valid block for any input under 15 bytes plus extension bytes.
  const token = bytes.length < 15 ? bytes.length << 4 : 0xf0, extension = [];
  if (bytes.length >= 15) { let rest = bytes.length - 15; while (rest >= 255) { extension.push(255); rest -= 255; } extension.push(rest); }
  return Buffer.concat([Buffer.from([token, ...extension]), bytes]);
}
function mozlz4File(value) {
  const json = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(12);
  header.write('mozLz40\0', 0, 'latin1'); header.writeUInt32LE(json.length, 8);
  return Buffer.concat([header, literalBlock(json)]);
}

function profileFixture(directory) {
  const root = join(directory, 'appdata'), local = join(root, 'Local'), roaming = join(root, 'Roaming');
  const edge = join(local, 'Microsoft', 'Edge', 'User Data');
  mkdirSync(join(edge, 'Default'), { recursive: true }); mkdirSync(join(edge, 'Profile 1'), { recursive: true }); mkdirSync(join(edge, 'Empty'), { recursive: true });
  writeFileSync(join(edge, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' }, Empty: { name: 'Nothing' }, '..': { name: 'Up' }, 'Default/../Profile 1': { name: 'Slash' }, 'C:\\Windows': { name: 'Drive' }, '': { name: 'Blank' } } } }));
  writeFileSync(join(edge, 'Default', 'Bookmarks'), bookmarks([
    link('Home', 'https://example.com/home', Date.UTC(2024, 4, 1)),
    folder('Finanzas', [link('Bank', 'https://bank.example/'), folder('Taxes', [link('Tax office', 'https://tax.example/')]), link('Script', 'javascript:alert(1)'), link('Settings', 'edge://settings/')]),
    folder('Empty folder', []),
    link('Local file', 'file:///C:/secret.txt'),
  ], [link('Other one', 'http://other.example/')], [link('Phone', 'https://phone.example/')]));
  chromiumHistory(join(edge, 'Default', 'History'), [
    { url: 'https://example.com/old', title: 'Old', visits: 2, last: NOW - 86400000 },
    { url: 'https://example.com/new', title: 'New\nline', visits: 5, last: NOW - 1000 },
    { url: 'https://example.com/hidden', title: 'Hidden', visits: 1, last: NOW, hidden: 1 },
    { url: 'edge://history', title: 'Internal', visits: 1, last: NOW },
    { url: 'file:///C:/secret.txt', title: 'File', visits: 1, last: NOW },
  ]);
  writeFileSync(join(edge, 'Default', 'Preferences'), JSON.stringify({ default_search_provider_data: { template_url_data: { short_name: 'Bing', url: 'https://www.bing.com/search?q={searchTerms}' } } }));
  writeFileSync(join(edge, 'Profile 1', 'Bookmarks'), bookmarks([link('Work link', 'https://work.example/')]));
  writeFileSync(join(edge, 'Profile 1', 'Preferences'), JSON.stringify({ default_search_provider_data: { template_url_data: { short_name: 'Yahoo', url: 'https://search.yahoo.com/search?p={searchTerms}' } } }));
  const chrome = join(local, 'Google', 'Chrome', 'User Data');
  mkdirSync(join(chrome, 'Default'), { recursive: true });
  writeFileSync(join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' } } } }));
  writeFileSync(join(chrome, 'Default', 'Bookmarks'), bookmarks([link('Chrome link', 'https://chrome.example/')]));
  writeFileSync(join(chrome, 'Default', 'Preferences'), JSON.stringify({ default_search_provider_data: { template_url_data: { short_name: 'Google', url: '{google:baseURL}search?q={searchTerms}' } } }));
  const opera = join(roaming, 'Opera Software', 'Opera Stable');
  mkdirSync(opera, { recursive: true });
  writeFileSync(join(opera, 'Bookmarks'), bookmarks([link('Opera link', 'https://opera.example/')]));
  const firefox = join(roaming, 'Mozilla', 'Firefox');
  mkdirSync(join(firefox, 'Profiles', 'abc.default-release'), { recursive: true }); mkdirSync(join(firefox, 'Profiles', 'old.default'), { recursive: true });
  writeFileSync(join(firefox, 'profiles.ini'), '[Install1234]\r\nDefault=Profiles/abc.default-release\r\n\r\n[Profile1]\r\nName=default\r\nIsRelative=1\r\nPath=Profiles/old.default\r\n\r\n[Profile0]\r\nName=Main\r\nIsRelative=1\r\nPath=Profiles/abc.default-release\r\nDefault=1\r\n\r\n[Profile2]\r\nName=Outside\r\nIsRelative=0\r\nPath=C:\\Users\\Other\r\n\r\n[Profile3]\r\nName=Escape\r\nIsRelative=1\r\nPath=Profiles/../..\r\n');
  firefoxDatabase(join(firefox, 'Profiles', 'abc.default-release', 'places.sqlite')).close();
  writeFileSync(join(firefox, 'Profiles', 'abc.default-release', 'search.json.mozlz4'), mozlz4File({ version: 6, engines: [{ id: 'ddg@search.mozilla.org', _name: 'DuckDuckGo' }, { id: 'google@search.mozilla.org', _name: 'Google' }], metaData: { defaultEngineId: 'ddg@search.mozilla.org' } }));
  return { local, roaming, edge, chrome, opera, firefox, environment: { local, roaming }, scratch: join(root, 'scratch') };
}


const favoriteLink = (url, title = url) => ({ kind: 'link', id: randomUUID(), url, title, createdAt: 1 });
const favoriteFolder = (name, children = []) => ({ kind: 'folder', id: randomUUID(), name, createdAt: 1, children });
const imported = (title, url = `https://${title.toLowerCase().replace(/\W+/g, '-')}.example/`) => ({ kind: 'link', url, title, createdAt: 5 });
const importedFolder = (name, children) => ({ kind: 'folder', name, createdAt: 5, children });
const selection = (browser, profile, what = {}) => ({ browser, profile, favorites: true, history: true, searchEngine: true, settings: true, ...what });
const everything = (fixture, choice) => readImport(fixture.environment, choice, labels, fixture.scratch, () => {}, NOW);
const treeDepth = items => Math.max(0, ...items.filter(item => item.kind === 'folder').map(item => 1 + treeDepth(item.children)));
const removeDatabase = path => { for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true }); };

module.exports = ({ temporaryDirectory, authenticatedCipher }) => {
  test('import sources come from the browsers own profile lists and accept only plain child folders', async t => {
    const fixture = profileFixture(temporaryDirectory(t, 'import-sources'));
    const sources = await discoverImportSources(fixture.environment, fixture.scratch);
    assert.deepEqual(sources.map(source => source.browser), ['edge', 'chrome', 'opera', 'firefox']);
    assert.deepEqual(sources[0].profiles, [
      { id: 'Default', name: 'Personal', favorites: true, history: true, searchEngine: 'bing', settings: null },
      { id: 'Profile 1', name: 'Work', favorites: true, history: false, searchEngine: null, settings: null },
    ]);
    assert.deepEqual(sources[1].profiles, [{ id: 'Default', name: 'Person 1', favorites: true, history: false, searchEngine: 'google', settings: null }]);
    assert.deepEqual(sources[2].profiles, [{ id: 'default', name: 'Opera', favorites: true, history: false, searchEngine: null, settings: null }]);
    assert.deepEqual(sources[3].profiles, [{ id: 'abc.default-release', name: 'Main', favorites: true, history: true, searchEngine: 'duckduckgo', settings: null }]);
    assert.deepEqual(await discoverImportSources({ local: undefined, roaming: join(fixture.local, 'missing') }, fixture.scratch), []);
    assert.deepEqual(await discoverImportSources({ local: join(fixture.local, 'Microsoft'), roaming: undefined }, fixture.scratch), []);
    try {
      symlinkSync(join(fixture.edge, 'Profile 1'), join(fixture.edge, 'Linked'), 'junction');
      writeFileSync(join(fixture.edge, 'Local State'), JSON.stringify({ profile: { info_cache: { Linked: { name: 'Linked' }, Default: { name: 'Personal' } } } }));
      assert.deepEqual((await discoverImportSources(fixture.environment, fixture.scratch))[0].profiles.map(profile => profile.id), ['Default']);
    } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
  });

  test('Chromium favorites keep folders, order, titles and dates, skip non-web addresses and put Mobile favorites last in Other', () => {
    const parsed = parseChromiumBookmarks(bookmarks([
      link('Home', 'https://example.com/home', Date.UTC(2024, 4, 1)),
      folder('Finanzas', [link('Bank', 'https://bank.example/'), folder('Taxes', [link('Tax office', 'https://tax.example/')]), link('Script', 'javascript:alert(1)'), link('Settings', 'edge://settings/')]),
      folder('Empty folder', []), folder('  ', [link('Unnamed child', 'https://unnamed.example/')]), link('Local file', 'file:///C:/secret.txt'), link('', 'https://notitle.example/'),
    ], [link('Other one', 'http://other.example/')], [link('Phone', 'https://phone.example/')]), labels, NOW);
    assert.deepEqual(names(parsed.bar), ['Home', { Finanzas: ['Bank', { Taxes: ['Tax office'] }] }, { 'Empty folder': [] }, 'Unnamed child', 'https://notitle.example/']);
    assert.deepEqual(names(parsed.other), ['Other one', { 'Mobile favorites': ['Phone'] }]);
    assert.equal(parsed.skipped, 3);
    assert.equal(parsed.bar[0].createdAt, Date.UTC(2024, 4, 1)); assert.equal(parsed.bar[1].createdAt, NOW);
    assert.equal(parseChromiumBookmarks(bookmarks([link('Dated', 'https://dated.example/')]).replace(/"date_added":"\d+"/, '"date_added":"0"'), labels, NOW).bar[0].createdAt, NOW);
    assert.equal(parseChromiumBookmarks(bookmarks([link(`${'t'.repeat(300)}\u0007`, 'https://long.example/')]), labels, NOW).bar[0].title.length, 200);
    assert.equal(parseChromiumBookmarks(bookmarks([folder('x'.repeat(200), [link('One', 'https://one.example/')])]), labels, NOW).bar[0].name.length, 80);
  });

  test('Chromium favorites refuse oversized, too deep, too many and malformed files', t => {
    const fixture = profileFixture(temporaryDirectory(t, 'import-limits')), path = join(fixture.edge, 'Default', 'Bookmarks');
    const many = Array.from({ length: BOOKMARK_NODE_LIMIT + 1 }, (_, index) => link('n', `https://example.com/${index}`));
    assert.throws(() => parseChromiumBookmarks(bookmarks(many), labels, NOW), /IMPORT_FILE_TOO_LARGE/);
    assert.equal(parseChromiumBookmarks(bookmarks(many.slice(1)), labels, NOW).bar.length, BOOKMARK_NODE_LIMIT);
    let nested = [link('leaf', 'https://leaf.example/')];
    for (let level = 0; level < 31; level++) nested = [folder(`f${level}`, nested)];
    assert.doesNotThrow(() => parseChromiumBookmarks(bookmarks(nested), labels, NOW));
    assert.throws(() => parseChromiumBookmarks(bookmarks([folder('one more', nested)]), labels, NOW), /IMPORT_FILE_TOO_LARGE/);
    for (const broken of ['{broken', '[]', 'null', '{"roots":[]}', '']) assert.throws(() => parseChromiumBookmarks(broken, labels, NOW), /IMPORT_FILE_INVALID/);
    writeFileSync(path, Buffer.alloc(20 * 1024 * 1024 + 1, 32));
    return assert.rejects(everything(fixture, selection('edge', 'Default', { history: false, searchEngine: false })), /IMPORT_FILE_TOO_LARGE/);
  });

  test('Edge favorites, history and search engine are read from copies and the source files stay byte for byte the same', async t => {
    const fixture = profileFixture(temporaryDirectory(t, 'import-edge'));
    const files = [join(fixture.edge, 'Local State'), join(fixture.edge, 'Default', 'Bookmarks'), join(fixture.edge, 'Default', 'History'), join(fixture.edge, 'Default', 'Preferences')];
    const before = files.map(sha), progress = [];
    const data = await readImport(fixture.environment, selection('edge', 'Default'), labels, fixture.scratch, (current, total) => progress.push([current, total]), NOW);
    assert.deepEqual(files.map(sha), before);
    assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
    assert.deepEqual(names(data.favorites.bar), ['Home', { Finanzas: ['Bank', { Taxes: ['Tax office'] }] }, { 'Empty folder': [] }]);
    assert.deepEqual(names(data.favorites.other), ['Other one', { 'Mobile favorites': ['Phone'] }]);
    assert.equal(data.favorites.skipped, 3);
    assert.deepEqual(data.history.entries, [
      { url: 'https://example.com/new', title: 'New line', lastVisit: NOW - 1000, visitCount: 5 },
      { url: 'https://example.com/old', title: 'Old', lastVisit: NOW - 86400000, visitCount: 2 },
    ]);
    assert.equal(data.history.skipped, 2); assert.equal(data.searchEngine, 'bing');
    assert.deepEqual(existsSync(fixture.scratch) ? readdirSync(fixture.scratch) : [], []);
    const only = await everything(fixture, selection('edge', 'Default', { favorites: false, searchEngine: false }));
    assert.equal(only.favorites, null); assert.equal(only.searchEngine, null); assert.equal(only.history.entries.length, 2);
    const work = await everything(fixture, selection('edge', 'Profile 1'));
    assert.deepEqual(names(work.favorites.bar), ['Work link']); assert.equal(work.history, null); assert.equal(work.searchEngine, null);
    const opera = await everything(fixture, selection('opera', 'default'));
    assert.deepEqual(names(opera.favorites.bar), ['Opera link']);
  });

  test('Firefox favorites map the toolbar, menu and mobile folders, history skips hidden and unvisited places, and a WAL file is read', async t => {
    const fixture = profileFixture(temporaryDirectory(t, 'import-firefox'));
    const database = join(fixture.firefox, 'Profiles', 'abc.default-release', 'places.sqlite');
    removeDatabase(database);
    const open = firefoxDatabase(database, { walMode: true });
    try {
      assert.ok(statSync(`${database}-wal`).size > 0);
      const before = [database, `${database}-wal`].map(sha);
      const data = await everything(fixture, selection('firefox', 'abc.default-release'));
      assert.deepEqual([database, `${database}-wal`].map(sha), before);
      assert.deepEqual(names(data.favorites.bar), ['Bar link', { Finanzas: ['In folder'] }]);
      assert.deepEqual(names(data.favorites.other), [{ 'Bookmarks menu': ['Menu link'] }, { 'Mobile favorites': ['Phone link'] }]);
      assert.equal(data.favorites.skipped, 2); assert.equal(data.favorites.bar[0].createdAt, NOW - 10000);
      assert.deepEqual(data.history.entries.map(entry => [entry.url, entry.visitCount, entry.lastVisit]), [['https://example.com/ff-one', 4, NOW - 1000], ['https://example.com/ff-two', 2, NOW - 5000], ['https://example.com/ff-tagged', 1, NOW - 9000]]);
      assert.equal(data.history.skipped, 1); assert.equal(data.searchEngine, 'duckduckgo');
    } finally { open.close(); }
    const cycle = [{ id: 1, parent: 0, position: 0, type: 2, title: '', added: NOW, guid: 'root________', url: null }, { id: 3, parent: 1, position: 0, type: 2, title: 'bar', added: NOW, guid: 'toolbar_____', url: null }, { id: 9, parent: 3, position: 0, type: 2, title: 'loop', added: NOW, guid: 'x', url: null }, { id: 3, parent: 9, position: 0, type: 2, title: 'again', added: NOW, guid: 'y', url: null }];
    assert.throws(() => parseFirefoxBookmarks(cycle, labels, NOW), /IMPORT_FILE_TOO_LARGE/);
    assert.throws(() => parseFirefoxBookmarks(new Array(BOOKMARK_NODE_LIMIT + 1).fill(cycle[0]), labels, NOW), /IMPORT_FILE_TOO_LARGE/);
  });

  test('Chromium Favicons import picks the smallest raster of at least 16px for favorite origins only and leaves the source untouched', async t => {
    const fixture = profileFixture(temporaryDirectory(t, 'import-chromium-favicons')), source = join(fixture.edge, 'Default', 'Favicons');
    const small = faviconPNG(16, [255, 0, 0]), medium = faviconPNG(24, [0, 255, 0]), large = faviconPNG(32, [0, 0, 255]);
    const oversized = Buffer.alloc(FAVICON_LIMIT + 1); small.copy(oversized);
    const truncated = small.subarray(0, 8);
    writeFileSync(join(fixture.edge, 'Default', 'Bookmarks'), bookmarks([
      link('Example', 'https://example.com/favorite'), link('Bank', 'https://bank.example/'), link('Corrupt', 'https://corrupt.example/'),
      link('Oversized', 'https://oversized.example/'), link('HTTP', 'http://example.com/favorite'), link('Port', 'https://example.com:8443/favorite'),
      link('Decode fallback', 'https://decode-fallback.example/favorite'),
    ]));
    const database = faviconDatabase(source, false, [
      { url: 'https://example.com/old-page', width: 32, bytes: large }, { url: 'https://example.com/another-page', width: 16, bytes: small },
      { url: 'https://example.com/favorite', width: 8, bytes: faviconPNG(8, [0, 0, 0]) },
      { url: 'https://bank.example/', width: 16, bytes: Buffer.from('corrupt raster') }, { url: 'https://bank.example/', width: 24, bytes: medium },
      { url: 'https://corrupt.example/', width: 16, bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
      { url: 'https://oversized.example/', width: 16, bytes: oversized }, { url: 'https://history-only.example/', width: 16, bytes: small },
      { url: 'https://example.com.evil/', width: 16, bytes: medium }, { url: 'http://example.com/page', width: 16, bytes: medium },
      { url: 'https://example.com:8443/page', width: 16, bytes: large },
      { url: 'https://decode-fallback.example/page', width: 16, bytes: truncated }, { url: 'https://decode-fallback.example/page', width: 32, bytes: large },
    ]);
    database.prepare('INSERT INTO icon_mapping (page_url, icon_id) SELECT ?, icon_id FROM icon_mapping WHERE page_url = ?').run('https://decode-fallback.example/duplicate', 'https://decode-fallback.example/page');
    database.close();
    const before = sha(source), data = await everything(fixture, selection('edge', 'Default'));
    assert.equal(sha(source), before);
    assert.deepEqual(data.favicons.map(icon => [icon.origin, Buffer.from(icon.bytes)]), [
      ['https://example.com', small], ['https://bank.example', medium], ['http://example.com', medium], ['https://example.com:8443', large],
      ['https://decode-fallback.example', truncated],
    ]);
    assert.deepEqual(data.favicons.at(-1).alternatives.map(bytes => Buffer.from(bytes)), [large]);
    assert.deepEqual(readdirSync(fixture.scratch), []);
    const historyOnly = await everything(fixture, selection('edge', 'Default', { favorites: false }));
    assert.equal(historyOnly.favicons, undefined);
  });

  test('Firefox favicons.sqlite import reads its WAL copy, skips corrupt and oversized blobs, and imports favorite origins only', async t => {
    const fixture = profileFixture(temporaryDirectory(t, 'import-firefox-favicons')), profile = join(fixture.firefox, 'Profiles', 'abc.default-release');
    const source = join(profile, 'favicons.sqlite'), small = faviconPNG(16, [255, 0, 0]), large = faviconPNG(32, [0, 255, 0]);
    const oversized = Buffer.alloc(FAVICON_LIMIT + 1); small.copy(oversized);
    const truncated = small.subarray(0, 8);
    const places = new DatabaseSync(join(profile, 'places.sqlite'));
    for (const [id, url] of [[100, 'https://corrupt.example/'], [101, 'https://oversized.example/'], [102, 'https://bank.example/'], [103, 'https://decode-fallback.example/favorite']]) {
      places.prepare('INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)').run(id, url, 'Favorite');
      places.prepare('INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, 1, ?, 3, ?, ?, ?, ?)').run(id, id, id, 'Favorite', BigInt(NOW) * 1000n, `fixture-${id}`);
    }
    places.close();
    const database = faviconDatabase(source, true, [
      { url: 'https://example.com/ff-one', width: 32, bytes: large }, { url: 'https://example.com/ff-two', width: 16, bytes: small },
      { url: 'https://example.com/ff-one', width: 8, bytes: faviconPNG(8, [0, 0, 0]) },
      { url: 'https://example.com/ff-one', width: 16, bytes: Buffer.from('<svg/>') }, { url: 'https://example.com/ff-one', width: 16, bytes: oversized },
      { url: 'https://corrupt.example/', width: 16, bytes: Buffer.from('corrupt raster') }, { url: 'https://oversized.example/', width: 16, bytes: oversized },
      { url: 'https://bank.example/', width: 16, bytes: Buffer.from('<svg/>') }, { url: 'https://bank.example/', width: 32, bytes: large },
      { url: 'https://history-only.example/', width: 16, bytes: small }, { url: 'http://example.com/', width: 16, bytes: large },
      { url: 'https://example.com:8443/', width: 16, bytes: large }, { url: 'https://example.com.evil/', width: 16, bytes: large },
      { url: 'https://decode-fallback.example/page', width: 16, bytes: truncated }, { url: 'https://decode-fallback.example/page', width: 32, bytes: large },
    ], true);
    database.prepare('INSERT INTO moz_pages_w_icons VALUES (?, ?)').run(1000, 'https://decode-fallback.example/duplicate');
    database.prepare('INSERT INTO moz_icons_to_pages SELECT ?, m.icon_id FROM moz_icons_to_pages m JOIN moz_pages_w_icons p ON p.id = m.page_id WHERE p.page_url = ?').run(1000, 'https://decode-fallback.example/page');
    try {
      assert.ok(statSync(`${source}-wal`).size > 0);
      const before = [source, `${source}-wal`].map(sha), data = await everything(fixture, selection('firefox', 'abc.default-release'));
      assert.deepEqual([source, `${source}-wal`].map(sha), before);
      assert.deepEqual(data.favicons.map(icon => [icon.origin, Buffer.from(icon.bytes)]), [['https://example.com', small], ['https://bank.example', large], ['https://decode-fallback.example', truncated]]);
      assert.deepEqual(data.favicons.at(-1).alternatives.map(bytes => Buffer.from(bytes)), [large]);
      assert.deepEqual(readdirSync(fixture.scratch), []);
    } finally { database.close(); }
  });

  test('missing, corrupt and oversized favicon databases are optional and never prevent favorites import or leave a copy behind', async t => {
    const fixture = profileFixture(temporaryDirectory(t, 'import-optional-favicons'));
    for (const [browser, profile, source] of [
      ['edge', 'Default', join(fixture.edge, 'Default', 'Favicons')],
      ['firefox', 'abc.default-release', join(fixture.firefox, 'Profiles', 'abc.default-release', 'favicons.sqlite')],
    ]) {
      const missing = await everything(fixture, selection(browser, profile));
      assert.ok(missing.favorites.bar.length); assert.deepEqual(missing.favicons, []);
      writeFileSync(source, 'this is not SQLite');
      const corrupt = await everything(fixture, selection(browser, profile));
      assert.ok(corrupt.favorites.bar.length); assert.deepEqual(corrupt.favicons, []);
      const handle = openSync(source, 'r+'); ftruncateSync(handle, 1024 * 1024 * 1024 + 1); closeSync(handle);
      const oversized = await everything(fixture, selection(browser, profile));
      assert.ok(oversized.favorites.bar.length); assert.deepEqual(oversized.favicons, []);
      assert.deepEqual(readdirSync(fixture.scratch), []);
    }
  });

  test('search engines are recognised only when Horizon offers them, in Chromium templates and in Firefox LZ4 files', () => {
    assert.equal(searchEngineByAddress('https://www.bing.com/search?q={searchTerms}'), 'bing');
    assert.equal(searchEngineByAddress('{google:baseURL}search?q={searchTerms}'), 'google');
    assert.equal(searchEngineByAddress('https://www.google.com.ar/search?q={searchTerms}'), 'google');
    assert.equal(searchEngineByAddress('https://duckduckgo.com/?q={searchTerms}'), 'duckduckgo');
    assert.equal(searchEngineByAddress('https://search.brave.com/search?q={searchTerms}'), 'brave');
    assert.equal(searchEngineByAddress('https://www.ecosia.org/search?q={searchTerms}'), 'ecosia');
    assert.equal(searchEngineByAddress('https://www.startpage.com/sp/search?query={searchTerms}'), 'startpage');
    for (const other of ['https://search.yahoo.com/search?p={searchTerms}', 'https://evil.example/?next=google.com', 'not an address', 42, undefined]) assert.equal(searchEngineByAddress(other), null);
    assert.equal(searchEngineByName('Duck Duck Go'), 'duckduckgo'); assert.equal(searchEngineByName('Yahoo'), null); assert.equal(searchEngineByName(null), null);
    // A literal sequence followed by an overlapping match and a closing literal: the JSON string "ab" repeated nine times.
    const header = Buffer.alloc(12), block = Buffer.from([0x3c, 0x22, 0x61, 0x62, 0x02, 0x00, 0x10, 0x22]);
    header.write('mozLz40\0', 0, 'latin1'); header.writeUInt32LE(20, 8);
    assert.equal(mozlz4(Buffer.concat([header, block])), 'ab'.repeat(9));
    assert.deepEqual(mozlz4(mozlz4File({ metaData: { current: 'x'.repeat(40) } })), { metaData: { current: 'x'.repeat(40) } });
    for (const broken of [Buffer.from('nope'), Buffer.concat([header.subarray(0, 8), Buffer.alloc(4)]), Buffer.concat([header, Buffer.from([0xf0])]), Buffer.concat([header, Buffer.from([0x10, 0x22, 0x05, 0x00])])]) assert.throws(() => mozlz4(broken));
    const huge = Buffer.from(header); huge.writeUInt32LE(5 * 1024 * 1024, 8);
    assert.throws(() => mozlz4(Buffer.concat([huge, block])), /IMPORT_FILE_TOO_LARGE/);
  });

  test('a missing, corrupt or oversized file and an escaping profile fail with a code and leave no copy behind', async t => {
    const fixture = profileFixture(temporaryDirectory(t, 'import-failures')), history = join(fixture.edge, 'Default', 'History');
    const left = () => existsSync(fixture.scratch) ? readdirSync(fixture.scratch) : [];
    const historyOnly = selection('edge', 'Default', { favorites: false, searchEngine: false });
    await assert.rejects(everything(fixture, selection('edge', '..')), /IMPORT_SOURCE_NOT_FOUND/);
    await assert.rejects(everything(fixture, selection('edge', 'Default/../Profile 1')), /IMPORT_SOURCE_NOT_FOUND/);
    await assert.rejects(everything(fixture, selection('edge', 'C:\\Windows')), /IMPORT_SOURCE_NOT_FOUND/);
    await assert.rejects(everything(fixture, selection('brave', 'Default')), /IMPORT_SOURCE_NOT_FOUND/);
    await assert.rejects(everything(fixture, selection('edge', 'Profile 1', { favorites: false, searchEngine: false })), /IMPORT_NO_CHOICE/);
    writeFileSync(history, 'this is not a database'.repeat(100));
    await assert.rejects(everything(fixture, historyOnly), /IMPORT_HISTORY_FAILED/);
    assert.deepEqual(left(), []);
    writeFileSync(history, '');
    const handle = openSync(history, 'r+'); ftruncateSync(handle, 1024 * 1024 * 1024 + 1); closeSync(handle);
    await assert.rejects(everything(fixture, historyOnly), /IMPORT_FILE_TOO_LARGE/);
    rmSync(history);
    await assert.rejects(everything(fixture, historyOnly), /IMPORT_NO_CHOICE/);
    assert.deepEqual(left(), []);
  });

  test('a file the other browser holds open asks to close it, and nothing is left behind', { skip: process.platform !== 'win32' }, async t => {
    const directory = temporaryDirectory(t, 'import-locked'), fixture = profileFixture(directory), history = join(fixture.edge, 'Default', 'History'), marker = join(directory, 'locked');
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${history}', 'Open', 'Read', 'None'); New-Item '${marker}' | Out-Null; Start-Sleep -Seconds 60`], { stdio: 'ignore' });
    try {
      for (let wait = 0; wait < 200 && !existsSync(marker); wait++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(existsSync(marker), 'the holder never locked the file');
      await assert.rejects(everything(fixture, selection('edge', 'Default', { favorites: false, searchEngine: false })), /IMPORT_FILE_LOCKED/);
      assert.deepEqual(existsSync(fixture.scratch) ? readdirSync(fixture.scratch) : [], []);
    } finally { const exited = new Promise(resolve => holder.once('exit', resolve)); holder.kill(); await exited; }
  });

  test('favorites go into the same folders as the source, new ones follow its order, links already there are not repeated and a second import adds nothing', () => {
    const tree = { bar: [favoriteFolder('Finanzas', [favoriteLink('https://bank.example/', 'Bank')]), favoriteLink('https://example.com/home', 'Home')], other: [favoriteLink('https://kept.example/')] };
    const source = {
      bar: [imported('Home', 'https://example.com/home'), importedFolder('Finanzas', [imported('Bank', 'https://bank.example/'), importedFolder('Taxes', [imported('Tax office')]), imported('Brokerage')]),
        importedFolder('Viajes', [imported('Flight')]), importedFolder('Empty', []), importedFolder('Only repeats', [imported('Kept', 'https://kept.example/')]), importedFolder('finanzas', [imported('Lowercase')]), imported('Loose')],
      other: [imported('Kept again', 'https://kept.example/'), importedFolder('Mobile favorites', [imported('Phone')])],
    };
    const result = mergeFavorites(tree, source);
    assert.deepEqual(result, { links: 6, skipped: 0 });
    assert.deepEqual(names(tree.bar), [{ Finanzas: ['Bank', { Taxes: ['Tax office'] }, 'Brokerage'] }, 'Home', { Viajes: ['Flight'] }, { finanzas: ['Lowercase'] }, 'Loose']);
    assert.deepEqual(names(tree.other), ['https://kept.example/', { 'Mobile favorites': ['Phone'] }]);
    assert.equal(validFavorites(tree), true);
    const snapshot = JSON.stringify(tree);
    assert.deepEqual(mergeFavorites(tree, source), { links: 0, skipped: 0 });
    assert.equal(JSON.stringify(tree), snapshot);
    assert.equal(tree.bar[0].children[1].createdAt, 5);
  });

  test('favorites past Horizon nesting, folder and link limits are folded into the folder above or counted as skipped', () => {
    let deep = [imported('Leaf')];
    for (let level = 10; level > 0; level--) deep = [importedFolder(`level ${level}`, [imported(`Link ${level}`), ...deep])];
    const tree = { bar: [], other: [] };
    assert.equal(mergeFavorites(tree, { bar: deep, other: [] }).links, 11);
    assert.equal(treeDepth(tree.bar), 8); assert.equal(validFavorites(tree), true); assert.equal(urls(tree.bar).length, 11);
    const full = { bar: [favoriteFolder('Bulk', Array.from({ length: 9990 }, (_, index) => favoriteLink(`https://bulk.example/${index}`)))], other: [] };
    const outcome = mergeFavorites(full, { bar: [importedFolder('Bulk', Array.from({ length: 25 }, (_, index) => imported(`New ${index}`)))], other: [] });
    assert.deepEqual(outcome, { links: 10, skipped: 15 }); assert.equal(validFavorites(full), true);
    const crowded = { bar: Array.from({ length: 1000 }, (_, index) => favoriteFolder(`Folder ${index}`)), other: [] };
    assert.deepEqual(mergeFavorites(crowded, { bar: [importedFolder('One too many', [imported('Kept')])], other: [] }), { links: 1, skipped: 0 });
    assert.equal(crowded.bar.at(-1).kind, 'link'); assert.equal(validFavorites(crowded), true);
  });

  test('history merges by address with the later visit and larger count, stays capped and does not change on a second import', () => {
    const existing = [{ url: 'https://a.example/', title: 'A', lastVisit: 100, visitCount: 5 }, { url: 'https://b.example/', title: '', lastVisit: 300, visitCount: 1 }];
    const source = [{ url: 'https://a.example/', title: 'A imported', lastVisit: 200, visitCount: 3 }, { url: 'https://b.example/', title: 'B', lastVisit: 50, visitCount: 1 }, { url: 'https://c.example/', title: 'C', lastVisit: 400, visitCount: 2 }];
    const first = mergeHistory(existing, source);
    assert.deepEqual(first.history, [{ url: 'https://c.example/', title: 'C', lastVisit: 400, visitCount: 2 }, { url: 'https://b.example/', title: 'B', lastVisit: 300, visitCount: 1 }, { url: 'https://a.example/', title: 'A', lastVisit: 200, visitCount: 5 }]);
    assert.equal(first.imported, 3);
    assert.deepEqual(mergeHistory(first.history, source), { history: first.history, imported: 0 });
    assert.deepEqual(existing[0], { url: 'https://a.example/', title: 'A', lastVisit: 100, visitCount: 5 });
    const full = Array.from({ length: HISTORY_LIMIT }, (_, index) => ({ url: `https://full.example/${index}`, title: '', lastVisit: 1000 + index, visitCount: 1 }));
    const capped = mergeHistory(full, [{ url: 'https://old.example/', title: '', lastVisit: 1, visitCount: 1 }, { url: 'https://recent.example/', title: '', lastVisit: 1e6, visitCount: 1 }]);
    assert.equal(capped.history.length, HISTORY_LIMIT); assert.equal(capped.history[0].url, 'https://recent.example/'); assert.equal(capped.imported, 1);
    assert.equal(capped.history.some(entry => entry.url === 'https://old.example/'), false);
  });

  test('the merge is written once, validated and encrypted at rest, and an invalid store never replaces the saved one', async t => {
    const directory = temporaryDirectory(t, 'import-store'), path = join(directory, 'store.json'), cipher = authenticatedCipher();
    const fixture = profileFixture(directory), store = readStore(path, cipher);
    const data = await everything(fixture, selection('edge', 'Default'));
    mergeFavorites(store.favorites, data.favorites); store.history = mergeHistory(store.history, data.history.entries).history;
    assert.equal(validateStore(store), true);
    writeStore(path, store, cipher);
    assert.equal(readFileSync(path).includes(Buffer.from('bank.example')), false); assert.equal(readFileSync(path).includes(Buffer.from('tax.example')), false);
    assert.deepEqual(readStore(path, cipher), store);
    const saved = readFileSync(path);
    const broken = { ...store, history: [{ url: 'javascript:alert(1)', title: '', lastVisit: 1, visitCount: 1 }] };
    assert.throws(() => writeStore(path, broken, cipher), /Invalid browser store/);
    assert.deepEqual(readFileSync(path), saved);
    assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
  });

  test('import commands are exact, bounded and refused in private windows', () => {
    const valid = { type: 'import-browser-data', browser: 'edge', profile: 'Profile 1', favorites: true, history: false, searchEngine: true, settings: false };
    for (const command of [{ type: 'list-import-sources' }, { type: 'finish-first-run' }, valid]) { assert.deepEqual(validateCommand(command), command); assert.throws(() => validateCommand({ ...command, extra: 1 })); }
    for (const change of [{ browser: 'safari' }, { browser: 7 }, { profile: '' }, { profile: 'x'.repeat(256) }, { profile: 'a\0b' }, { profile: null }, { favorites: 1 }, { history: 'yes' }, { searchEngine: undefined }, { settings: undefined }, { settings: 'yes' }, { settings: 1 }]) assert.throws(() => validateCommand({ ...valid, ...change }), /IMPORT_COMMAND_INVALID/);
    assert.throws(() => validateCommand({ ...valid, favorites: false, searchEngine: false }), /IMPORT_NO_CHOICE/);
    assert.deepEqual(validateCommand({ ...valid, favorites: false, searchEngine: false, settings: true }).settings, true);
    const { settings, ...withoutSettings } = valid; assert.throws(() => validateCommand(withoutSettings), /IMPORT_COMMAND_INVALID/); assert.equal(settings, false);
    assert.throws(() => validateCommand({ type: 'import-browser-data', browser: 'edge' }), /IMPORT_COMMAND_INVALID/);
    assert.throws(() => validateCommand({ type: 'list-import-sources', browser: 'edge' }), /IMPORT_COMMAND_INVALID/);
    assert.throws(() => assertPrivateCommand(valid), /Private window import is unavailable/);
    assert.doesNotThrow(() => assertPrivateCommand({ type: 'list-import-sources' }));
  });

  test('the first-run step belongs to a new install only and finishing it is remembered', t => {
    const directory = temporaryDirectory(t, 'import-first-run'), path = join(directory, 'settings.json');
    const fresh = readSettings(path);
    assert.equal(fresh.version, 7); assert.equal(fresh.onboarded, false);
    const settings = createSettings(path, () => {});
    assert.equal(settings.onboarded, false); settings.finishFirstRun(); assert.equal(settings.onboarded, true);
    assert.equal(readSettings(path).onboarded, true); settings.finishFirstRun(); assert.equal(readSettings(path).onboarded, true);
    const previous = join(directory, 'previous.json'), { onboarded, ...rest } = fresh;
    writeFileSync(previous, JSON.stringify({ ...rest, version: 6 }));
    const migrated = readSettings(previous);
    assert.equal(migrated.version, 7); assert.equal(migrated.onboarded, true); assert.equal(onboarded, false);
    assert.equal(JSON.parse(readFileSync(previous, 'utf8')).onboarded, true);
    for (const value of ['yes', 1, null, undefined]) assert.equal(validateSettings({ ...fresh, onboarded: value }), false);
    assert.throws(() => writeSettings(path, { ...fresh, onboarded: 'yes' }), /Invalid settings/);
  });

  test('every import string exists in English and Spanish with the same placeholders', () => {
    const keys = Object.keys(copy).filter(key => /^import|^IMPORT_/.test(key));
    assert.ok(keys.length > 30);
    for (const key of keys) {
      assert.ok(copy[key].en.trim() && copy[key].es.trim(), key);
      const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join();
      assert.equal(placeholders(copy[key].en), placeholders(copy[key].es), key);
      assert.doesNotMatch(copy[key].en + copy[key].es, /[\u2012-\u2015\u2212]/, key);
    }
  });
};
