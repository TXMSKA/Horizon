const assert = require('node:assert/strict');
const { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { app, BrowserWindow, session, protocol, webContents, ipcMain } = require('electron');

const runtime = resolve(__dirname, '../.runtime');
mkdirSync(runtime, { recursive: true });
const phase = process.argv.find(value => value.startsWith('--extensions-phase='))?.slice('--extensions-phase='.length);
const saved = process.argv.find(value => value.startsWith('--extensions-data='))?.slice('--extensions-data='.length);
assert.ok(!phase || ['install', 'restart'].includes(phase));
assert.equal(Boolean(saved), Boolean(phase));
const restart = phase === 'restart';
const temporary = saved ?? mkdtempSync(resolve(runtime, 'extensions-verify-'));
assert.equal(dirname(temporary), runtime);
const data = phase ? temporary : resolve(temporary, 'controller'); mkdirSync(data, { recursive: true });
process.env.TMP = temporary; process.env.TEMP = temporary;
app.setPath('userData', data); app.setPath('sessionData', data);
app.setPath('crashDumps', resolve(temporary, 'crashes')); app.setAppLogsPath(resolve(temporary, 'logs'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'horizon', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const samples = [
  ['uBlock Origin Lite', 'ddkjiahejlhfcafbddmgiahcphecmpfh'],
  ['Dark Reader', 'eimadpbcbfnmbkopoojfekhnkhdbieeh'],
  ['Vimium', 'dbepggeogbaibhgnhhndojpepiihcmeb'],
];
const outputPath = resolve(temporary, 'output.txt');
function report(message) { appendFileSync(outputPath, message + '\n'); console.log(message); }
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function until(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(message);
}
if (!phase) {
  report('Starting extension verification in temporary user data');
  app.whenReady().then(async () => {
    for (const phase of ['install', 'restart']) {
      await new Promise((done, fail) => {
        const child = spawn(process.execPath, [resolve(__filename), `--extensions-phase=${phase}`, `--extensions-data=${temporary}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const timeout = setTimeout(() => { child.kill(); fail(new Error('Electron phase timed out')); }, 240000);
        let nativeOutput = '', fatal = false;
        child.stdout.on('data', bytes => { process.stdout.write(bytes); appendFileSync(resolve(temporary, 'native-output.txt'), bytes); });
        child.stderr.on('data', bytes => {
          process.stderr.write(bytes); appendFileSync(resolve(temporary, 'native-output.txt'), bytes);
          nativeOutput = (nativeOutput + bytes).slice(-8192);
          if (/FATAL:mojo/.test(nativeOutput) && !fatal) { fatal = true; child.kill(); clearTimeout(timeout); fail(new Error('Chromium could not create its sandboxed Mojo channel (Windows access denied)')); }
        });
        child.once('error', error => { clearTimeout(timeout); fail(error); });
        child.once('close', code => { clearTimeout(timeout); if (!fatal) { if (code === 0) done(); else fail(new Error(`Electron ${phase} phase exited with ${code}`)); } });
      });
    }
    app.exit(0);
  }).catch(error => { report(`FAIL: ${error.message}`); app.exit(1); });
} else {
  const timer = setTimeout(() => { report('FAIL: extension verification timed out'); app.exit(1); }, 240000);

  app.whenReady().then(async () => {
    report('Electron ready');
    const { createSettings } = require('../dist/electron/settings.js');
    const { createBrowser, isProfileSession } = require('../dist/electron/browser.js');
    const { existingExtensions } = require('../dist/electron/extensions.js');
    const { makeProfile, readRegistry, writeRegistry } = require('../dist/electron/profiles.js');
    const { hardenContents, secureSession, validateSender } = require('../dist/electron/security.js');
    const { serveHorizon } = require('../dist/electron/protocol.js');
    const registryPath = resolve(temporary, 'profiles.json');
    const registry = restart ? readRegistry(registryPath, 'en') : (() => {
      const first = makeProfile('Extensions test', 'amber'), second = makeProfile('Separate profile', 'blue');
      const value = { version: 1, activeId: first.id, profiles: [first, second], tombstones: [] }; writeRegistry(registryPath, value); return value;
    })();
    const settings = createSettings(resolve(temporary, 'settings.json'), () => {});
    settings.setLanguage('en'); settings.finishFirstRun(); settings.setBlockAds(false); settings.setDarkPages('off');
    secureSession(session.defaultSession);
    await serveHorizon(session.defaultSession.protocol, resolve(__dirname, '../dist/renderer'));
    report('Renderer protocol ready');
    app.on('web-contents-created', (_event, contents) => hardenContents(contents, isProfileSession(contents.session)));
    const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: resolve(__dirname, '../dist/electron/preload.js') } });
    const browser = createBrowser(window, temporary, resolve(temporary, 'downloads'), settings, registry, { status: 'developmentBuild', refresh: async () => {}, register: async () => {} });
    ipcMain.handle('horizon:language', event => { validateSender(event, event.sender); return 'en'; });
    ipcMain.handle('horizon:window-action', () => {});
    report('Browser and profile created');
    window.webContents.on('render-process-gone', (_event, details) => { report(`FAIL: renderer ${details.reason}`); app.exit(1); });
    await window.loadURL('horizon://app/');
    report('Renderer loaded');
    await until(() => window.webContents.executeJavaScript('Boolean(document.querySelector("h1"))'), 'Chrome did not render');
    const state = () => window.webContents.executeJavaScript('window.horizon.getState()');
    const command = value => window.webContents.executeJavaScript(`window.horizon.command(${JSON.stringify(value)})`);
    const target = session.fromPartition(registry.profiles[0].partition), manager = existingExtensions(target);
    await manager.ready;
    const local = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html><head><title>Extension runtime test</title><style>body{background:white;color:black}</style></head><body><h1>Extension runtime test</h1><a href="/next">Next</a></body></html>');
    });
    await new Promise(done => local.listen(0, '127.0.0.1', done));
    const localURL = `http://127.0.0.1:${local.address().port}/`;
    const workerRunning = id => Object.values(target.serviceWorkers.getAllRunning()).some(info => info.scope === `chrome-extension://${id}/`);
    const startWorker = async (name, id) => {
      // Mirrors Horizon's own retry: a just-registered worker's first start can abort.
      let worker;
      for (let attempt = 0; !worker; attempt++) {
        try { worker = await target.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`); }
        catch (error) { if (attempt >= 5) throw error; await delay(500 * (attempt + 1)); }
      }
      await until(() => workerRunning(id), `${name} service worker did not start`);
      assert.equal(manager.list().find(extension => extension.id === id)?.failed, false);
      report(`${name}: service worker started`);
    };
    const checkDarkPage = async () => {
      await command({ type: 'navigate', input: localURL });
      let page;
      await until(() => { page = window.contentView.children.find(view => view.webContents?.getURL() === localURL)?.webContents; return page && !page.isLoading(); }, 'Local test page did not load');
      await until(() => page.executeJavaScript(`Boolean(document.querySelector('style.darkreader')) && getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)'`), 'Dark Reader did not change the local test page');
      report('Dark Reader: its content script inserted a darkreader stylesheet and changed the local page background');
    };

    if (!restart) {
      for (const [name, id] of samples) {
        let installation = manager.install(id, window.webContents);
        await until(async () => (await state()).extensionWarning?.id === id, name + ' warning did not appear', 60000);
        let warning = (await state()).extensionWarning;
        await until(() => window.webContents.executeJavaScript('Boolean(document.querySelector(".extension-warning[open]"))'), 'Install dialog did not open');
        const focus = await window.webContents.executeJavaScript('document.activeElement?.textContent');
        assert.equal(focus, 'Cancel');
        const layout = await window.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('.extension-warning'), css = getComputedStyle(dialog);
          return { width: parseFloat(css.width), padding: parseFloat(css.paddingTop), radius: parseFloat(css.borderRadius), heading: parseFloat(getComputedStyle(dialog.querySelector('h2')).fontSize) };
        })()`);
        assert.deepEqual(layout, { width: 460, padding: 24, radius: 20, heading: 16 });
        if (id === samples[0][1]) writeFileSync(resolve(temporary, 'warning.png'), (await window.webContents.capturePage()).toPNG());
        report(`${name}: warning focused Cancel; unsupported APIs: ${warning.unsupported.join(', ') || 'none declared'}`);
        if (id === samples[0][1]) {
          await command({ type: 'answer-extension-install', id: warning.requestId, allow: false });
          assert.equal(await installation, null); assert.equal(target.extensions.getExtension(id), null);
          report('uBlock Origin Lite: Cancel leaves no installed code');
          installation = manager.install(id, window.webContents);
          await until(async () => (await state()).extensionWarning?.id === id, 'Second install decision did not appear', 60000);
          warning = (await state()).extensionWarning;
          await until(() => window.webContents.executeJavaScript('document.activeElement?.textContent === "Cancel"'), 'Second warning did not focus Cancel');
        }
        await command({ type: 'answer-extension-install', id: warning.requestId, allow: true });
        const extension = await installation;
        assert.equal(extension.id, id); assert.ok(target.extensions.getExtension(id));
        // uBlock Origin Lite is the unsupported sample: its worker needs declarativeNetRequest, which Electron lacks, so it is installed anyway and not expected to run.
        if (id === samples[0][1]) report('uBlock Origin Lite: installed anyway; not expected to run without declarativeNetRequest');
        else await startWorker(name, id);
        if (id === samples[1][1]) await checkDarkPage();
      }
      await window.webContents.executeJavaScript('document.querySelector("[aria-controls=extensions-popover]").click()');
      await until(() => window.webContents.executeJavaScript('Boolean(document.querySelector(".extensions-popover"))'), 'Extensions popover did not open');
      const layout = await window.webContents.executeJavaScript(`(() => {
        const popover = document.querySelector('.extensions-popover'), row = popover.querySelector('.extension-row');
        return { width: parseFloat(getComputedStyle(popover).width), gap: parseFloat(getComputedStyle(row).gap), row: parseFloat(getComputedStyle(row).height), icon: parseFloat(getComputedStyle(row.querySelector('.extension-icon')).width), pin: parseFloat(getComputedStyle(row.querySelector('.extension-pin')).width), heading: parseFloat(getComputedStyle(popover.querySelector('h2')).height), menu: parseFloat(getComputedStyle(popover.querySelector('.extension-menu-row')).height) };
      })()`);
      // The board draws a 28 px pin; every button keeps the app's 32 px target floor, which wins over the board.
      assert.deepEqual(layout, { width: 360, gap: 10, row: 40, icon: 28, pin: 32, heading: 32, menu: 34 });
      writeFileSync(resolve(temporary, 'popover.png'), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript('document.querySelector("[aria-controls=extensions-popover]").click()');
      report('Board geometry: warning 460/24/20, popover 360, rows 40, icons 28, pins at the 32 px target floor; screenshots captured');
      await command({ type: 'switch-profile', id: registry.profiles[1].id });
      assert.equal((await state()).extensions.length, 0);
      assert.equal(session.fromPartition(registry.profiles[1].partition).extensions.getAllExtensions().length, 0);
      report('Second profile: no installed or loaded extensions');
      const privateWindow = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: resolve(__dirname, '../dist/electron/preload.js') } });
      const privateBrowser = createBrowser(privateWindow, temporary, resolve(temporary, 'downloads'), settings, registry, undefined, { privateWindow: true });
      assert.ok(privateBrowser.privateWindow);
      await privateWindow.loadURL('horizon://app/');
      await privateWindow.webContents.executeJavaScript('window.horizon.command({type:"navigate",input:"http://127.0.0.1:1/"})');
      const privateSession = privateWindow.contentView.children.find(view => view.webContents)?.webContents.session;
      assert.ok(privateSession);
      assert.equal(privateSession.extensions.getAllExtensions().length, 0);
      assert.equal(privateSession.getPreloadScripts().length, 0);
      privateWindow.destroy(); report('Private session: no extensions and no store preload');
      await command({ type: 'switch-profile', id: registry.profiles[0].id });
      await command({ type: 'set-extension-enabled', id: samples[1][1], enabled: false });
      assert.equal(target.extensions.getExtension(samples[1][1]), null);
      await command({ type: 'set-extension-enabled', id: samples[1][1], enabled: true });
      assert.ok(target.extensions.getExtension(samples[1][1]));
      await startWorker(...samples[1]); await checkDarkPage();
      await command({ type: 'set-extension-enabled', id: samples[1][1], enabled: false });
      await command({ type: 'set-extension-pinned', id: samples[2][1], pinned: true });
      await until(() => window.webContents.executeJavaScript('Boolean(document.querySelector(".extension-action:not(:disabled)"))'), 'Pinned library action did not render');
      await window.webContents.executeJavaScript('document.querySelector(".extension-action").click()');
      let popup;
      const actionPopup = () => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(`chrome-extension://${samples[2][1]}/`) && contents.getType() !== 'backgroundPage');
      await until(() => { popup = actionPopup(); return popup && !popup.isLoading(); }, 'Library action popup did not open');
      const beforeTabs = (await state()).tabs.length;
      const created = await popup.executeJavaScript(`chrome.tabs.create({url:${JSON.stringify(localURL)},active:false})`);
      assert.equal((await state()).tabs.length, beforeTabs + 1);
      const queried = await popup.executeJavaScript('chrome.tabs.query({currentWindow:true})');
      assert.ok(queried.some(tab => tab.id === created.id && tab.url === localURL));
      assert.equal(queried.length, (await state()).tabs.length);
      await popup.executeJavaScript(`chrome.action.setBadgeText({text:'7',tabId:${created.id}})`);
      await popup.executeJavaScript(`chrome.tabs.update(${created.id},{active:true})`);
      await until(async () => (await state()).extensions.find(extension => extension.id === samples[2][1])?.action?.badge === '7', 'Tab action badge did not reach Horizon');
      // Selecting a page can dismiss the native popup. Reopen it before using its extension context again.
      manager.closePopup();
      await window.webContents.executeJavaScript('document.querySelector(".extension-action").click()');
      await until(() => { popup = actionPopup(); return popup && !popup.isLoading(); }, 'Library action popup did not reopen');
      await popup.executeJavaScript(`chrome.tabs.remove(${created.id})`);
      assert.equal((await state()).tabs.length, beforeTabs);
      manager.closePopup();
      report('Pinned action: library popup, real tab create/query/select/remove and tab-specific badge passed');
      report('Dark Reader: off, on, then off; Vimium: pinned');
      const unsupported = (await state()).extensions.find(extension => extension.id === samples[0][1]);
      assert.ok(unsupported.unsupported.includes('declarativeNetRequest'));
      assert.equal(unsupported.unsupported.includes('action'), false);
      assert.equal(unsupported.unsupported.includes('commands'), false);
      assert.equal(unsupported.unsupported.includes('alarms'), false);
      report('Unsupported-warning sample: uBlock Origin Lite still requires declarativeNetRequest; action, commands and alarms no longer warn');
      browser.flush();
      report('Restarting Electron with the same temporary user data');
      clearTimeout(timer);
      local.close();
      app.exit(0);
    } else {
      const restored = (await state()).extensions;
      assert.equal(restored.length, 3);
      for (const [, id] of samples) {
        const entry = restored.find(extension => extension.id === id); assert.ok(entry);
        assert.equal(entry.enabled, id !== samples[1][1]);
        assert.equal(Boolean(target.extensions.getExtension(id)), entry.enabled);
      }
      assert.equal(restored.find(extension => extension.id === samples[2][1]).pinned, true);
      assert.equal(session.fromPartition(registry.profiles[1].partition).extensions.getAllExtensions().length, 0);
      await startWorker(...samples[2]);
      assert.ok(manager.list().find(extension => extension.id === samples[2][1]).action);
      report('Restart: 3 installed; uBlock Origin Lite and Vimium on; Dark Reader off; Vimium pin preserved and running; second profile empty');
      report('Extension runtime verification passed.');
      clearTimeout(timer); local.close(); browser.flush(); app.exit(0);
    }
  }).catch(error => {
    report(`FAIL: ${error instanceof Error ? error.message : 'Verification failed'}`);
    clearTimeout(timer); app.exit(1);
  });
}
