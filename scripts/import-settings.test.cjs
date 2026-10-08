const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { discoverImportSources, readImport, chromiumSettings, firefoxSettings, parseFirefoxPrefs, summarizeSettings } = require('../dist/electron/import.js');
const { appSettingsSnapshot, applyAppSettings, mergeProfileSettings, restoreAppSettings } = require('../dist/electron/import-merge.js');
const { createSettings, readSettings } = require('../dist/electron/settings.js');
const { readStore, validateStore, writeStore } = require('../dist/electron/store.js');
const { SITE_SETTINGS_LIMIT } = require('../dist/electron/site-settings.js');
const { profileStorePath } = require('../dist/electron/profiles.js');
const { IMPORT_SETTINGS } = require('../dist/src/shared/api.js');

const NOW = Date.UTC(2026, 9, 7, 12);
const labels = { mobile: 'Mobile favorites', menu: 'Bookmarks menu' };
const empty = () => ({ sitePermissions: [], translationAlways: [], translationNever: [] });
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const pref = (name, value) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`;
const decisionList = found => found.sitePermissions.map(item => `${item.origin} ${item.permission} ${item.decision}`).sort();

function chromiumFixture(directory, { preferences, state = {}, bookmarks = false } = {}) {
  const root = join(directory, 'appdata'), local = join(root, 'Local'), roaming = join(root, 'Roaming');
  const user = join(local, 'Google', 'Chrome', 'User Data'), profile = join(user, 'Default');
  mkdirSync(profile, { recursive: true }); mkdirSync(roaming, { recursive: true });
  const fixture = { user, profile, environment: { local, roaming }, scratch: join(root, 'scratch'),
    write(nextPreferences, nextState = {}) {
      writeFileSync(join(user, 'Local State'), typeof nextState === 'string' ? nextState : JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' } } }, ...nextState }));
      if (nextPreferences === undefined) rmSync(join(profile, 'Preferences'), { force: true });
      else writeFileSync(join(profile, 'Preferences'), typeof nextPreferences === 'string' ? nextPreferences : JSON.stringify(nextPreferences));
      return this;
    } };
  if (bookmarks) writeFileSync(join(profile, 'Bookmarks'), JSON.stringify({ roots: {} }));
  return fixture.write(preferences, state);
}

function permissionsDatabase(path, rows) {
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE moz_perms (id INTEGER PRIMARY KEY, origin TEXT, type TEXT, permission INTEGER, expireType INTEGER, expireTime INTEGER, modificationTime INTEGER)');
  const insert = database.prepare('INSERT INTO moz_perms (origin, type, permission, expireType, expireTime, modificationTime) VALUES (?, ?, ?, ?, 0, 0)');
  for (const [origin, type, permission, expireType = 0] of rows) insert.run(origin, type, permission, expireType);
  database.close();
}

function firefoxFixture(directory, { prefs, permissions } = {}) {
  const root = join(directory, 'appdata'), local = join(root, 'Local'), roaming = join(root, 'Roaming');
  const firefox = join(roaming, 'Mozilla', 'Firefox'), profile = join(firefox, 'Profiles', 'abc.default-release');
  mkdirSync(profile, { recursive: true }); mkdirSync(local, { recursive: true });
  writeFileSync(join(firefox, 'profiles.ini'), '[Profile0]\r\nName=Main\r\nIsRelative=1\r\nPath=Profiles/abc.default-release\r\nDefault=1\r\n');
  if (prefs !== undefined) writeFileSync(join(profile, 'prefs.js'), Array.isArray(prefs) ? prefs.join('\n') : prefs);
  if (permissions) permissionsDatabase(join(profile, 'permissions.sqlite'), permissions);
  return { profile, environment: { local, roaming }, scratch: join(root, 'scratch') };
}

const settingsOnly = (browser, profile) => ({ browser, profile, favorites: false, history: false, searchEngine: false, settings: true });
const importedSettings = (fixture, browser, profile) => readImport(fixture.environment, settingsOnly(browser, profile), labels, fixture.scratch, () => {}, NOW).then(data => data.settings);
const left = fixture => existsSync(fixture.scratch) ? readdirSync(fixture.scratch) : [];

function uiModule(filename, dependencies) {
  const { compileFunction } = require('node:vm');
  const { transpileModule, ModuleKind, JsxEmit } = require('typescript');
  const source = transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  const exported = {}, jsx = (type, props) => ({ type, props });
  compileFunction(source, ['exports', 'require'])(exported, name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected interface import: ${name}`);
    return dependencies[name];
  });
  return exported;
}

module.exports = ({ temporaryDirectory, authenticatedCipher, notebookBrowser }) => {
  test('Chromium Preferences and Local State give every approved setting', t => {
    const directory = temporaryDirectory(t, 'settings-chromium'), saved = join(directory, 'Saved'); mkdirSync(saved);
    const fixture = chromiumFixture(directory, {
      preferences: {
        session: { restore_on_startup: 1 }, download: { default_directory: saved, prompt_for_download: true }, profile: { cookie_controls_mode: 1, content_settings: { exceptions: {
          media_stream_camera: { 'https://cam.example:443,*': { setting: 1 } }, media_stream_mic: { 'https://mic.example:443,*': { setting: 2 } },
          geolocation: { 'https://geo.example:443,*': { setting: 1 } }, notifications: { 'https://notify.example:443,*': { setting: 2 } },
        } } }, browser: { theme: { color_scheme2: 2 } },
        translate_allowlists: { fr: 'es', 'pt-BR': 'en' }, translate_site_blocklist_with_time: { 'never.example': 1234 },
      },
      state: { intl: { app_locale: 'es-419' }, browser: { enabled_labs_experiments: ['other@2', 'enable-force-dark@1'] } },
    });
    const found = chromiumSettings(fixture.profile, fixture.user);
    assert.deepEqual({ ...found, sitePermissions: decisionList(found) }, {
      onStart: 'restore', downloadsFolder: saved, askWhereToSave: true, blockThirdPartyCookies: true, language: 'es', theme: 'amber', darkPages: true,
      sitePermissions: ['https://cam.example camera allow', 'https://geo.example location allow', 'https://mic.example microphone block', 'https://notify.example notifications block'],
      translationAlways: [{ language: 'fr', target: 'es' }, { language: 'pt', target: 'en' }], translationNever: ['never.example'],
    });
    assert.deepEqual(summarizeSettings(found), { names: ['onStart', 'downloadsFolder', 'askWhereToSave', 'blockThirdPartyCookies', 'language', 'theme', 'darkPages'], sitePermissions: 4, translations: 3 });
  });

  test('Chromium values are mapped one by one and anything out of range or of another type leaves Horizon alone', t => {
    const fixture = chromiumFixture(temporaryDirectory(t, 'settings-chromium-values'));
    const read = (preferences, state) => chromiumSettings(fixture.write(preferences, state).profile, fixture.user);
    const preference = (group, name) => value => ({ [group]: { [name]: value } });
    const startup = preference('session', 'restore_on_startup'), prompt = preference('download', 'prompt_for_download'), cookies = preference('profile', 'cookie_controls_mode');
    const scheme = value => ({ browser: { theme: { color_scheme2: value } } }), locale = value => ({ intl: { app_locale: value } }), labs = value => ({ browser: { enabled_labs_experiments: value } });
    for (const [preferences, expected] of [
      [startup(1), { onStart: 'restore' }], [startup(5), { onStart: 'new-page' }], [startup(4), {}], [startup(0), {}], [startup(6), {}], [startup('1'), {}], [startup(null), {}],
      [prompt(true), { askWhereToSave: true }], [prompt(false), { askWhereToSave: false }], [prompt('yes'), {}], [prompt(1), {}],
      [cookies(1), { blockThirdPartyCookies: true }], [cookies(0), { blockThirdPartyCookies: false }], [cookies(2), { blockThirdPartyCookies: false }], [cookies(3), {}], [cookies(-1), {}], [cookies('1'), {}],
      [scheme(0), { theme: 'system' }], [scheme(1), { theme: 'daylight' }], [scheme(2), { theme: 'amber' }], [scheme(3), {}], [scheme('2'), {}],
      [{ session: 'x', download: [], profile: 7, browser: { theme: 'dark' } }, {}], [[], {}], [null, {}], [{}, {}],
    ]) assert.deepEqual(read(preferences, {}), { ...empty(), ...expected }, JSON.stringify(preferences));
    for (const [state, expected] of [
      [locale('es-419'), { language: 'es' }], [locale('es'), { language: 'es' }], [locale('en-US'), { language: 'en' }], [locale('fr-FR'), {}], [locale('es_AR'), {}], [locale(42), {}], [locale(''), {}],
      [labs(['enable-force-dark@1']), { darkPages: true }], [labs(['x', 'enable-force-dark@1', 'y']), { darkPages: true }], [labs(['enable-force-dark@0']), {}], [labs('enable-force-dark@1'), {}], [labs([]), {}],
    ]) assert.deepEqual(read({}, state), { ...empty(), ...expected }, JSON.stringify(state));
    assert.deepEqual(read(undefined, locale('en')), { ...empty(), language: 'en' });
  });

  test('a downloads folder is imported only when it exists as a real folder, in both families', t => {
    const directory = temporaryDirectory(t, 'settings-downloads'), real = join(directory, 'Real'), file = join(directory, 'file.txt');
    mkdirSync(real); writeFileSync(file, 'x');
    const chromium = chromiumFixture(directory);
    const fromChromium = value => chromiumSettings(chromium.write({ download: { default_directory: value } }).profile, chromium.user).downloadsFolder;
    const fromFirefox = (value, list = 2) => firefoxSettings(parseFirefoxPrefs([pref('browser.download.folderList', list), pref('browser.download.dir', value)].join('\n')), []).downloadsFolder;
    for (const read of [fromChromium, fromFirefox]) {
      assert.equal(read(real), real);
      for (const missing of [join(directory, 'Missing'), file, 'Downloads', '..\\Downloads', '', 7, null, `${real}\0`, join(directory, 'x'.repeat(2000))]) assert.equal(read(missing), undefined, String(missing).slice(0, 40));
    }
    assert.equal(fromFirefox(real, 1), undefined); assert.equal(fromFirefox(real, 0), undefined);
  });

  test('Chromium site decisions need one https origin, an allow or block, and no expiry; only the four permissions Horizon has are read', t => {
    const fixture = chromiumFixture(temporaryDirectory(t, 'settings-chromium-sites'));
    const rules = {
      'https://good.example:443,*': { setting: 1, last_modified: '13300000000000000' }, 'https://blocked.example:443,*': { setting: 2 }, 'https://port.example:8443,*': { setting: 1 },
      'https://noexpiry.example:443,*': { setting: 1, expiration: '0' }, 'https://[*.]wild.example:443,*': { setting: 1 }, '*,*': { setting: 1 }, 'https://*,*': { setting: 1 },
      'http://plain.example:80,*': { setting: 1 }, 'https://secondary.example:443,https://top.example:443': { setting: 1 }, 'https://ask.example:443,*': { setting: 3 },
      'https://default.example:443,*': { setting: 0 }, 'https://session.example:443,*': { setting: 4 }, 'https://expiring.example:443,*': { setting: 1, expiration: '13300000000000000' },
      'https://path.example:443/app,*': { setting: 1 }, 'https://user:pw@cred.example:443,*': { setting: 1 }, 'not a pattern': { setting: 1 }, 'https://two.example:443,*,*': { setting: 1 },
      'https://nosetting.example:443,*': { last_modified: '1' }, 'https://strange.example:443,*': 'allow',
    };
    const found = chromiumSettings(fixture.write({ profile: { content_settings: { exceptions: { geolocation: rules, popups: { 'https://popup.example:443,*': { setting: 1 } }, media_stream_camera: { 'https://cam.example:443,*': { setting: 2 } },
      media_stream_mic: { 'https://mic.example:443,*': { setting: 1 } }, notifications: { 'https://notify.example:443,*': { setting: 1 } } } } } }).profile, fixture.user);
    assert.deepEqual(decisionList(found), [
      'https://blocked.example location block', 'https://cam.example camera block', 'https://good.example location allow', 'https://mic.example microphone allow',
      'https://noexpiry.example location allow', 'https://notify.example notifications allow', 'https://port.example:8443 location allow',
    ]);
    const many = Object.fromEntries(Array.from({ length: SITE_SETTINGS_LIMIT + 5 }, (_, index) => [`https://site${index}.example:443,*`, { setting: 1 }]));
    assert.equal(chromiumSettings(fixture.write({ profile: { content_settings: { exceptions: { geolocation: many } } } }).profile, fixture.user).sitePermissions.length, SITE_SETTINGS_LIMIT);
  });

  test('Chromium translation keeps the Spanish and English targets and the hosts that are valid names', t => {
    const fixture = chromiumFixture(temporaryDirectory(t, 'settings-chromium-translate'));
    const found = chromiumSettings(fixture.write({
      translate_allowlists: { fr: 'es', 'pt-BR': 'en', de: 'fr', es: 'es', xx: 'en', 'not valid!': 'en', EN: 'es', it: 7, ja: 'en-GB' },
      translate_site_blocklist_with_time: { 'example.com': 1, 'Upper.Example.org': 2, 'bad host': 3, 'port.example:8080': 4, 'a.b.c.d.example': 5, '': 6 },
    }).profile, fixture.user);
    assert.deepEqual(found.translationAlways, [{ language: 'fr', target: 'es' }, { language: 'pt', target: 'en' }, { language: 'xx', target: 'en' }, { language: 'en', target: 'es' }, { language: 'ja', target: 'en' }]);
    assert.deepEqual(found.translationNever, ['example.com', 'a.b.c.d.example']);
    assert.deepEqual(chromiumSettings(fixture.write({ translate_allowlists: [], translate_site_blocklist_with_time: 'x' }).profile, fixture.user), empty());
  });

  test('prefs.js is read line by line through one strict pattern and only for the names Horizon uses', () => {
    const prefs = parseFirefoxPrefs([
      '// Mozilla User Preferences', '', '/* a comment */',
      pref('browser.startup.page', 1), pref('browser.startup.page', 3), pref('unknown.setting', true), pref('extensions.activeThemeID', 'firefox-compact-dark@mozilla.org'),
      'user_pref("network.cookie.cookieBehavior", 1)', 'user_pref(network.cookie.cookieBehavior, 1);', 'user_pref("network.cookie.cookieBehavior", );', 'user_pref("network.cookie.cookieBehavior", 1); // trailing',
      "user_pref('browser.download.dir', 'single');", 'user_pref("browser.download.useDownloadDir", maybe);', `user_pref("intl.locale.requested", "${'x'.repeat(5000)}");`,
      pref('browser.download.folderList', 2), 'user_pref("__proto__", 1);', 'not a pref line',
    ].join('\r\n'));
    assert.deepEqual([...prefs], [['browser.startup.page', 3], ['extensions.activeThemeID', 'firefox-compact-dark@mozilla.org'], ['browser.download.folderList', 2]]);
    assert.deepEqual([...parseFirefoxPrefs('')], []);
    assert.deepEqual([...parseFirefoxPrefs('\u0000\u0001garbage user_pref(\n\n)')], []);
  });

  test('Firefox prefs map every approved setting and leave out of range values alone', t => {
    const directory = temporaryDirectory(t, 'settings-firefox-values'), saved = join(directory, 'Saved'); mkdirSync(saved);
    const read = (...lines) => firefoxSettings(parseFirefoxPrefs(lines.join('\n')), []);
    for (const [lines, expected] of [
      [[pref('browser.startup.page', 3)], { onStart: 'restore' }], [[pref('browser.startup.page', 0)], { onStart: 'new-page' }], [[pref('browser.startup.page', 1)], { onStart: 'new-page' }],
      [[pref('browser.startup.page', 2)], {}], [[pref('browser.startup.page', '3')], {}],
      [[pref('browser.download.folderList', 2), pref('browser.download.dir', saved)], { downloadsFolder: saved }], [[pref('browser.download.folderList', 1), pref('browser.download.dir', saved)], {}],
      [[pref('browser.download.useDownloadDir', false)], { askWhereToSave: true }], [[pref('browser.download.useDownloadDir', true)], { askWhereToSave: false }], [[pref('browser.download.useDownloadDir', 0)], {}],
      [[pref('network.cookie.cookieBehavior', 1)], { blockThirdPartyCookies: true }], [[pref('network.cookie.cookieBehavior', 0)], { blockThirdPartyCookies: false }],
      [[pref('network.cookie.cookieBehavior', 5)], {}], [[pref('network.cookie.cookieBehavior', 4)], {}], [[pref('network.cookie.cookieBehavior', '1')], {}],
      [[pref('intl.locale.requested', 'es-AR,en-US')], { language: 'es' }], [[pref('intl.locale.requested', 'en-US')], { language: 'en' }], [[pref('intl.locale.requested', 'fr,es')], {}],
      [[pref('intl.locale.requested', '')], {}], [[pref('intl.locale.requested', 5)], {}],
      [[pref('extensions.activeThemeID', 'default-theme@mozilla.org')], { theme: 'system' }], [[pref('extensions.activeThemeID', 'default-theme')], { theme: 'system' }],
      [[pref('extensions.activeThemeID', 'firefox-compact-light@mozilla.org')], { theme: 'daylight' }], [[pref('extensions.activeThemeID', 'firefox-compact-dark@mozilla.org')], { theme: 'amber' }],
      [[pref('extensions.activeThemeID', 'firefox-alpenglow@mozilla.org')], {}], [[pref('extensions.activeThemeID', 'evil-default-theme@mozilla.org')], {}], [[pref('extensions.activeThemeID', 7)], {}],
      [[pref('browser.translations.alwaysTranslateLanguages', 'fr, de,!!,xx,fr')], { translationAlways: ['fr', 'de', 'xx'].map(language => ({ language, target: null })) }], [[pref('browser.translations.alwaysTranslateLanguages', 3)], {}],
    ]) assert.deepEqual(read(...lines), { ...empty(), ...expected }, lines.join(' '));
    assert.deepEqual(read(), empty());
  });

  test('clearing on close is read only while Firefox is set to clear, new keys before old ones and each part on by default', () => {
    const read = (...lines) => { const found = firefoxSettings(parseFirefoxPrefs(lines.join('\n')), []); return [found.clearHistoryOnClose === true, found.clearCacheOnClose === true]; };
    const sanitize = pref('privacy.sanitize.sanitizeOnShutdown', true);
    assert.deepEqual(read(sanitize), [true, true]);
    assert.deepEqual(read(sanitize, pref('privacy.clearOnShutdown_v2.browsingHistoryAndDownloads', false)), [false, true]);
    assert.deepEqual(read(sanitize, pref('privacy.clearOnShutdown_v2.cache', false)), [true, false]);
    assert.deepEqual(read(sanitize, pref('privacy.clearOnShutdown.history', false), pref('privacy.clearOnShutdown.cache', false)), [false, false]);
    assert.deepEqual(read(sanitize, pref('privacy.clearOnShutdown_v2.historyFormDataAndDownloads', false)), [false, true]);
    assert.deepEqual(read(sanitize, pref('privacy.clearOnShutdown_v2.browsingHistoryAndDownloads', true), pref('privacy.clearOnShutdown.history', false)), [true, true]);
    assert.deepEqual(read(sanitize, pref('privacy.clearOnShutdown_v2.cache', 'no')), [true, true]);
    assert.deepEqual(read(pref('privacy.sanitize.sanitizeOnShutdown', false)), [false, false]);
    assert.deepEqual(read(pref('privacy.sanitize.sanitizeOnShutdown', 1)), [false, false]);
    assert.deepEqual(read(pref('privacy.clearOnShutdown.history', true), pref('privacy.clearOnShutdown_v2.cache', true)), [false, false]);
  });

  test('Firefox permissions keep permanent allow and block decisions for https origins, and translation blocks become hosts', () => {
    const rows = [
      ['https://cam.example', 'camera', 1], ['https://mic.example', 'microphone', 2], ['https://geo.example', 'geo', 1], ['https://notify.example', 'desktop-notification', 2],
      ['https://never.example', 'translations', 2], ['https://allowed.example', 'translations', 1], ['http://plain.example', 'camera', 1], ['https://container.example^userContextId=2', 'camera', 1],
      ['https://other.example', 'popup', 1], ['https://prompt.example', 'camera', 3], ['file:///etc/passwd', 'camera', 1], ['https://UPPER.example', 'camera', 1], ['https://port.example:8443', 'geo', 2], [7, 'camera', 1],
    ].map(([origin, type, permission]) => ({ origin, type, permission }));
    const found = firefoxSettings(new Map(), rows);
    assert.deepEqual(decisionList(found), ['https://cam.example camera allow', 'https://geo.example location allow', 'https://mic.example microphone block', 'https://notify.example notifications block', 'https://port.example:8443 location block']);
    assert.deepEqual(found.translationNever, ['never.example']);
  });

  test('permissions.sqlite is read in the worker from a private copy, filtered by expiry, and the source stays the same', async t => {
    const directory = temporaryDirectory(t, 'settings-firefox-database');
    const fixture = firefoxFixture(directory, { prefs: [pref('browser.startup.page', 3)], permissions: [
      ['https://cam.example', 'camera', 1], ['https://session.example', 'camera', 1, 1], ['https://timed.example', 'geo', 1, 2], ['https://never.example', 'translations', 2], ['https://mic.example', 'microphone', 2],
    ] });
    const database = join(fixture.profile, 'permissions.sqlite'), prefs = join(fixture.profile, 'prefs.js'), before = [database, prefs].map(sha);
    const sources = await discoverImportSources(fixture.environment, fixture.scratch);
    assert.deepEqual(sources[0].profiles[0].settings, { names: ['onStart'], sitePermissions: 2, translations: 1 });
    const found = await importedSettings(fixture, 'firefox', 'abc.default-release');
    assert.deepEqual(decisionList(found), ['https://cam.example camera allow', 'https://mic.example microphone block']);
    assert.deepEqual(found.translationNever, ['never.example']); assert.equal(found.onStart, 'restore');
    assert.deepEqual([database, prefs].map(sha), before); assert.deepEqual(left(fixture), []);
  });

  test('a missing permissions.sqlite still brings the prefs, and a broken one is listed without it and refuses the import with nothing left behind', async t => {
    const directory = temporaryDirectory(t, 'settings-firefox-missing');
    const missing = firefoxFixture(join(directory, 'missing'), { prefs: [pref('browser.startup.page', 0), pref('network.cookie.cookieBehavior', 1)] });
    assert.deepEqual(await importedSettings(missing, 'firefox', 'abc.default-release'), { ...empty(), onStart: 'new-page', blockThirdPartyCookies: true });
    const broken = firefoxFixture(join(directory, 'broken'), { prefs: [pref('browser.startup.page', 3)] });
    const path = join(broken.profile, 'permissions.sqlite');
    writeFileSync(path, 'this is not a database'.repeat(100));
    const sources = await discoverImportSources(broken.environment, broken.scratch);
    assert.deepEqual(sources[0].profiles[0].settings, { names: ['onStart'], sitePermissions: 0, translations: 0 });
    await assert.rejects(importedSettings(broken, 'firefox', 'abc.default-release'), /IMPORT_SETTINGS_FAILED/);
    assert.deepEqual(left(broken), []);
    const handle = openSync(path, 'r+'); ftruncateSync(handle, 1024 * 1024 * 1024 + 1); closeSync(handle);
    await assert.rejects(importedSettings(broken, 'firefox', 'abc.default-release'), /IMPORT_FILE_TOO_LARGE/);
    rmSync(path);
    assert.equal((await importedSettings(broken, 'firefox', 'abc.default-release')).onStart, 'restore');
  });

  test('a permissions.sqlite that Firefox holds open asks to close it', { skip: process.platform !== 'win32' }, async t => {
    const directory = temporaryDirectory(t, 'settings-firefox-locked'), marker = join(directory, 'locked');
    const fixture = firefoxFixture(join(directory, 'source'), { prefs: [pref('browser.startup.page', 3)], permissions: [['https://cam.example', 'camera', 1]] });
    const database = join(fixture.profile, 'permissions.sqlite');
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${database}', 'Open', 'Read', 'None'); New-Item '${marker}' | Out-Null; Start-Sleep -Seconds 60`], { stdio: 'ignore' });
    try {
      for (let wait = 0; wait < 200 && !existsSync(marker); wait++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(existsSync(marker), 'the holder never locked the file');
      await assert.rejects(importedSettings(fixture, 'firefox', 'abc.default-release'), /IMPORT_FILE_LOCKED/);
      assert.deepEqual(left(fixture), []);
    } finally { const exited = new Promise(resolve => holder.once('exit', resolve)); holder.kill(); await exited; }
  });

  test('malformed, oversized or missing Preferences, Local State and prefs.js give no settings and never throw while the profiles are listed', async t => {
    const directory = temporaryDirectory(t, 'settings-malformed');
    const chromium = chromiumFixture(join(directory, 'chromium'), { preferences: '{broken', bookmarks: true });
    const listed = async fixture => (await discoverImportSources(fixture.environment, fixture.scratch))[0].profiles[0].settings;
    for (const preferences of ['{broken', '', '[1,', 'null\u0000']) assert.equal(await listed(chromium.write(preferences)), null, preferences);
    assert.throws(() => chromiumSettings(chromium.write('{broken').profile, chromium.user), /IMPORT_FILE_INVALID/);
    writeFileSync(join(chromium.profile, 'Preferences'), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    assert.equal(await listed(chromium), null); assert.throws(() => chromiumSettings(chromium.profile, chromium.user), /IMPORT_FILE_TOO_LARGE/);
    assert.equal(await listed(chromium.write(undefined)), null);
    assert.throws(() => chromiumSettings(chromium.write({ intl: { app_locale: 'es' } }, '{broken').profile, chromium.user), /IMPORT_FILE_INVALID/);
    const firefox = firefoxFixture(join(directory, 'firefox'), { prefs: 'garbage\nuser_pref("browser.startup.page"\n\u0000\u0001' });
    writeFileSync(join(firefox.profile, 'places.sqlite'), '');
    const profiles = (await discoverImportSources(firefox.environment, firefox.scratch))[0].profiles;
    assert.equal(profiles[0].settings, null);
    writeFileSync(join(firefox.profile, 'prefs.js'), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    assert.equal((await discoverImportSources(firefox.environment, firefox.scratch))[0].profiles[0].settings, null);
    await assert.rejects(readImport(firefox.environment, { ...settingsOnly('firefox', 'abc.default-release'), favorites: false }, labels, firefox.scratch, () => {}, NOW), /IMPORT_NO_CHOICE/);
  });

  test('the dialog lists what each profile holds from the same files the import reads', async t => {
    const directory = temporaryDirectory(t, 'settings-listed'), saved = join(directory, 'Saved'); mkdirSync(saved);
    const fixture = chromiumFixture(directory, { preferences: { session: { restore_on_startup: 5 }, download: { default_directory: saved }, profile: { content_settings: { exceptions: { geolocation: { 'https://geo.example:443,*': { setting: 1 } } } } }, translate_allowlists: { fr: 'es' } },
      state: { intl: { app_locale: 'en-US' } } });
    const [source] = await discoverImportSources(fixture.environment, fixture.scratch);
    assert.deepEqual(source.profiles, [{ id: 'Default', name: 'Person 1', favorites: false, history: false, searchEngine: null, settings: { names: ['onStart', 'downloadsFolder', 'language'], sitePermissions: 1, translations: 1 } }]);
    const data = await readImport(fixture.environment, settingsOnly('chrome', 'Default'), labels, fixture.scratch, (current, total) => assert.deepEqual([current, total], [1, 1]), NOW);
    assert.equal(data.favorites, null); assert.equal(data.history, null); assert.equal(data.settings.onStart, 'new-page');
  });

  test('app settings go through the Settings setters only when they differ, and a second import changes nothing', t => {
    const directory = temporaryDirectory(t, 'settings-apply'), path = join(directory, 'settings.json'), saved = join(directory, 'Saved'); mkdirSync(saved);
    let changes = 0;
    const settings = createSettings(path, () => { changes++; });
    const imported = { ...empty(), onStart: 'new-page', downloadsFolder: saved, askWhereToSave: true, blockThirdPartyCookies: false, language: 'es', theme: 'amber', darkPages: true };
    assert.deepEqual(applyAppSettings(settings, imported, 'en-US'), ['onStart', 'downloadsFolder', 'askWhereToSave', 'blockThirdPartyCookies', 'language', 'theme', 'darkPages']);
    const after = readSettings(path);
    assert.deepEqual([after.onStart, after.downloadsFolder, after.askWhereToSave, after.blockThirdPartyCookies, after.language, after.theme, after.darkPages], ['new-page', saved, true, false, 'es', 'amber', 'on']);
    const seen = changes;
    assert.deepEqual(applyAppSettings(settings, imported, 'en-US'), []); assert.equal(changes, seen);
    assert.deepEqual(applyAppSettings(settings, empty(), 'en-US'), []);
    // A system language that already is the imported one is not turned into a fixed choice.
    const system = createSettings(join(directory, 'system.json'), () => {});
    assert.deepEqual(applyAppSettings(system, { ...empty(), language: 'es' }, 'es-AR'), []); assert.equal(system.language, 'system');
    assert.deepEqual(applyAppSettings(system, { ...empty(), language: 'en' }, 'es-AR'), ['language']); assert.equal(system.language, 'en');
  });

  test('a setting that cannot be written stops the import and every value already written is put back', t => {
    const directory = temporaryDirectory(t, 'settings-restore'), path = join(directory, 'settings.json');
    const settings = createSettings(path, () => {});
    const before = readSettings(path), snapshot = appSettingsSnapshot(settings);
    assert.throws(() => applyAppSettings(settings, { ...empty(), onStart: 'new-page', askWhereToSave: true, downloadsFolder: join(directory, 'Gone'), theme: 'amber' }, 'en'), /DOWNLOADS_FOLDER_INVALID/);
    assert.equal(settings.onStart, 'new-page'); assert.equal(settings.askWhereToSave, false);
    restoreAppSettings(settings, snapshot);
    assert.deepEqual(readSettings(path), before); assert.equal(settings.theme, 'system');
    // The settings file itself refusing the write leaves the value as it was.
    rmSync(path); mkdirSync(path);
    assert.throws(() => applyAppSettings(settings, { ...empty(), onStart: 'new-page' }, 'en'), /SETTINGS_SAVE_FAILED/);
    assert.equal(settings.onStart, 'restore');
    restoreAppSettings(settings, snapshot);
    rmSync(path, { recursive: true }); writeFileSync(path, JSON.stringify(before));
    const reopened = createSettings(path, () => {});
    assert.throws(() => applyAppSettings(new Proxy(reopened, { get: (target, name) => name === 'setTheme' ? () => { throw new Error('SETTINGS_SAVE_FAILED'); } : Reflect.get(target, name) }), { ...empty(), onStart: 'new-page', blockThirdPartyCookies: false, theme: 'amber' }, 'en'), /SETTINGS_SAVE_FAILED/);
    assert.equal(reopened.onStart, 'new-page'); assert.equal(reopened.blockThirdPartyCookies, false);
    restoreAppSettings(reopened, appSettingsSnapshot(createSettings(join(directory, 'defaults.json'), () => {})));
    assert.deepEqual(readSettings(path), before);
  });

  test('site permissions fill only what is still at Ask, translation choices are a union where Horizon wins and clearing is only turned on', t => {
    const directory = temporaryDirectory(t, 'settings-profile'), path = join(directory, 'store.json'), cipher = authenticatedCipher();
    const store = readStore(path, cipher), identity = store.siteSettings;
    const entry = (origin, values) => ({ origin, camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'ask', lyra: 'ask', ...values });
    store.siteSettings.permissions.push(entry('https://kept.example', { camera: 'block' }), entry('https://fill.example', { microphone: 'allow' }));
    store.siteSettings.translation = { always: [{ language: 'fr', target: 'en' }], never: ['kept.example'] };
    const source = { ...empty(), clearHistoryOnClose: true, sitePermissions: [
      { origin: 'https://kept.example', permission: 'camera', decision: 'allow' }, { origin: 'https://kept.example', permission: 'location', decision: 'allow' },
      { origin: 'https://fill.example', permission: 'microphone', decision: 'block' }, { origin: 'https://fill.example', permission: 'camera', decision: 'block' },
      { origin: 'https://new.example', permission: 'notifications', decision: 'allow' },
    ], translationAlways: [{ language: 'fr', target: 'es' }, { language: 'de', target: null }, { language: 'es', target: null }, { language: 'it', target: 'en' }], translationNever: ['kept.example', 'new.example'] };
    assert.deepEqual(mergeProfileSettings(store, source, 'es'), { names: ['clearHistoryOnClose'], sitePermissions: 3, translations: 3, skipped: 0 });
    assert.equal(store.siteSettings, identity);
    assert.deepEqual(store.siteSettings.permissions, [
      entry('https://kept.example', { camera: 'block', location: 'allow' }), entry('https://fill.example', { microphone: 'allow', camera: 'block' }), entry('https://new.example', { notifications: 'allow' }),
    ]);
    assert.deepEqual(store.siteSettings.translation, { always: [{ language: 'fr', target: 'en' }, { language: 'de', target: 'es' }, { language: 'it', target: 'en' }], never: ['kept.example', 'new.example'] });
    assert.equal(store.clearHistoryOnClose, true); assert.equal(store.clearCacheOnClose, false);
    assert.deepEqual(mergeProfileSettings(store, source, 'es'), { names: [], sitePermissions: 0, translations: 0, skipped: 0 });
    assert.deepEqual(mergeProfileSettings(store, { ...empty(), clearHistoryOnClose: undefined, clearCacheOnClose: true }, 'es').names, ['clearCacheOnClose']);
    store.clearHistoryOnClose = false; assert.deepEqual(mergeProfileSettings(store, empty(), 'es').names, []); assert.equal(store.clearHistoryOnClose, false);
    assert.equal(validateStore(store), true);
    writeStore(path, store, cipher);
    assert.deepEqual(readStore(path, cipher), store); assert.equal(readFileSync(path).includes(Buffer.from('new.example')), false);
  });

  test('imported site settings and translation choices stay inside Horizon limits', t => {
    const path = join(temporaryDirectory(t, 'settings-limits'), 'store.json'), store = readStore(path, authenticatedCipher());
    const entry = origin => ({ origin, camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'ask', lyra: 'ask' });
    store.siteSettings.permissions = Array.from({ length: SITE_SETTINGS_LIMIT }, (_, index) => entry(`https://full${index}.example`));
    store.siteSettings.translation = { always: Array.from({ length: 200 }, (_, index) => ({ language: `a${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`, target: 'en' })), never: [] };
    const result = mergeProfileSettings(store, { ...empty(), sitePermissions: [{ origin: 'https://full0.example', permission: 'camera', decision: 'allow' }, { origin: 'https://over.example', permission: 'camera', decision: 'allow' }],
      translationAlways: [{ language: 'fr', target: 'es' }] }, 'en');
    assert.deepEqual(result, { names: [], sitePermissions: 1, translations: 0, skipped: 2 });
    assert.equal(store.siteSettings.permissions.length, SITE_SETTINGS_LIMIT); assert.equal(store.siteSettings.permissions[0].camera, 'allow');
    assert.equal(validateStore(store), true);
  });

  test('importing settings through the browser changes Horizon once, reports what changed and a failed save puts back settings and profile data', async t => {
    const directory = temporaryDirectory(t, 'settings-browser'), saved = join(directory, 'Saved'); mkdirSync(saved);
    const chromium = chromiumFixture(join(directory, 'chromium'), { preferences: {
      session: { restore_on_startup: 5 }, download: { default_directory: saved }, profile: { cookie_controls_mode: 0, content_settings: { exceptions: { geolocation: { 'https://geo.example:443,*': { setting: 1 } } } } },
      translate_allowlists: { fr: 'es' }, translate_site_blocklist_with_time: { 'never.example': 1 } }, state: { intl: { app_locale: 'es-AR' } } });
    const firefox = firefoxFixture(join(directory, 'firefox'), { prefs: [pref('privacy.sanitize.sanitizeOnShutdown', true), pref('privacy.clearOnShutdown_v2.cache', false), pref('extensions.activeThemeID', 'firefox-compact-light@mozilla.org')],
      permissions: [['https://cam.example', 'camera', 2]] });
    const environment = { HORIZON_IMPORT_LOCALAPPDATA: process.env.HORIZON_IMPORT_LOCALAPPDATA, HORIZON_IMPORT_APPDATA: process.env.HORIZON_IMPORT_APPDATA };
    process.env.HORIZON_IMPORT_LOCALAPPDATA = chromium.environment.local; process.env.HORIZON_IMPORT_APPDATA = firefox.environment.roaming;
    t.after(() => { for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
    const options = {}, cipher = authenticatedCipher(), browser = notebookBrowser(t, cipher, options), { command, state } = browser;
    const choice = (name, profile) => ({ type: 'import-browser-data', browser: name, profile, favorites: false, history: false, searchEngine: false, settings: true });
    const sources = await command({ type: 'list-import-sources' });
    assert.deepEqual(sources.map(source => source.browser), ['chrome', 'firefox']);
    assert.deepEqual(sources[0].profiles[0].settings, { names: ['onStart', 'downloadsFolder', 'blockThirdPartyCookies', 'language'], sitePermissions: 1, translations: 2 });
    const first = await command(choice('chrome', 'Default'));
    assert.deepEqual(first, { favorites: 0, history: 0, skipped: 0, searchEngine: null, settings: { names: ['onStart', 'downloadsFolder', 'blockThirdPartyCookies', 'language'], sitePermissions: 1, translations: 2 } });
    const written = readSettings(join(browser.directory, 'settings.json'));
    assert.deepEqual([written.onStart, written.downloadsFolder, written.blockThirdPartyCookies, written.language], ['new-page', saved, false, 'es']);
    assert.deepEqual(state().store.siteSettings.permissions.map(item => [item.origin, item.location]), [['https://geo.example', 'allow']]);
    assert.deepEqual(state().store.siteSettings.translation, { always: [{ language: 'fr', target: 'es' }], never: ['never.example'] });
    assert.deepEqual(await command(choice('chrome', 'Default')), { favorites: 0, history: 0, skipped: 0, searchEngine: null, settings: { names: [], sitePermissions: 0, translations: 0 } });
    // A failed save of the profile data restores the app settings it had already changed, and the profile data itself.
    const before = structuredClone(state().store), settingsBefore = readSettings(join(browser.directory, 'settings.json'));
    options.failStore = true;
    await assert.rejects(command(choice('firefox', 'abc.default-release')), /IMPORT_STORAGE_FAILED/);
    options.failStore = false;
    assert.deepEqual(state().store, before); assert.deepEqual(readSettings(join(browser.directory, 'settings.json')), settingsBefore);
    assert.equal(state().importProgress, null);
    const result = await command(choice('firefox', 'abc.default-release'));
    assert.deepEqual(result.settings, { names: ['theme', 'clearHistoryOnClose'], sitePermissions: 1, translations: 0 });
    assert.equal(readSettings(join(browser.directory, 'settings.json')).theme, 'daylight');
    assert.equal(state().store.clearHistoryOnClose, true); assert.equal(state().store.clearCacheOnClose, false);
    assert.equal(state().store.siteSettings.permissions.find(item => item.origin === 'https://cam.example').camera, 'block');
    assert.equal(readStore(profileStorePath(browser.directory, state().activeProfileId), cipher).clearHistoryOnClose, true);
    const privateWindow = browser.addWindow({ privateWindow: true });
    await assert.rejects(async () => privateWindow.command(choice('chrome', 'Default')), /Private window import is unavailable/);
  });

  test('the dialog names every setting in both languages and the result says what changed', () => {
    const copy = uiModule('src/copy.ts', {}), api = require('../dist/src/shared/api.js');
    const { importResultText, importSettingsItems } = uiModule('src/Import.tsx', { react: {}, 'lucide-react': {}, './copy': copy, './shared/api': api, './Vault': {} });
    for (const language of ['en', 'es']) {
      const names = importSettingsItems({ names: [...IMPORT_SETTINGS], sitePermissions: 0, translations: 0 }, language);
      assert.equal(new Set(names).size, IMPORT_SETTINGS.length); assert.ok(names.every(name => name.trim() && !/[{}]/.test(name)));
    }
    const list = (language, items) => new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(items);
    const settings = { names: ['onStart', 'theme'], sitePermissions: 12, translations: 1 };
    const english = importResultText({ favorites: 2, history: 1, skipped: 0, searchEngine: 'bing', settings }, null, 'en');
    assert.equal(english, `2 favorites and 1 page of history imported. Settings updated: ${list('en', ['what opens on start', 'theme', '12 site permissions', '1 translation choice'])}. The default search engine is now Bing.`);
    assert.match(importResultText({ favorites: 0, history: 0, skipped: 1, searchEngine: null, settings }, null, 'es'), /^Configuración actualizada: qué se abre al iniciar, tema, 12 permisos de sitios y 1 elección de traducción\. Se omitió 1 elemento/);
    const nothing = { favorites: 0, history: 0, skipped: 0, searchEngine: null, settings: { names: [], sitePermissions: 0, translations: 0 } };
    assert.equal(importResultText(nothing, null, 'en'), 'Nothing new to import.');
    assert.equal(importResultText(nothing, { imported: 3, duplicates: 2, skipped: 1 }, 'en'), '3 passwords were imported into Vault. 2 passwords were already in Vault and were left as they are. 1 row of the file could not be read and was skipped.');
    assert.equal(importResultText(null, { imported: 1, duplicates: 1, skipped: 0 }, 'en'), '1 password was imported into Vault. 1 password was already in Vault and was left as it is.');
    assert.equal(importResultText(null, { imported: 0, duplicates: 4, skipped: 0 }, 'es'), 'No se importó ninguna contraseña nueva a Vault. 4 contraseñas ya estaban en Vault y quedaron como estaban.');
    assert.equal(importResultText(null, { imported: 5, duplicates: 0, skipped: 0 }, 'es'), 'Se importaron 5 contraseñas a Vault.');
    for (const language of ['en', 'es']) assert.doesNotMatch(importResultText(nothing, { imported: 3, duplicates: 2, skipped: 1 }, language) + importResultText({ favorites: 2, history: 1, skipped: 2, searchEngine: 'bing', settings }, null, language), /[‒-―−]/);
  });
};
