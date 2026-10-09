// Run after npm run build: electron scripts/verify-vault.cjs
// This verifier uses a real service and real Horizon surfaces, with synthetic data.
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { resolve, join, relative, isAbsolute } = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, randomBytes } = require('node:crypto');
const http = require('node:http');
const { app, BrowserWindow, protocol, session, ipcMain, webContents } = require('electron');
const root = resolve(__dirname, '..'), runtime = join(root, '.runtime');
mkdirSync(runtime, { recursive: true });
const scratch = mkdtempSync(join(runtime, 'verify-vault-'));
const vaultHome = join(scratch, 'vault'), browserHome = join(scratch, 'horizon');
process.env.VAULT_HOME = vaultHome;
app.setPath('userData', browserHome); app.setPath('sessionData', browserHome); app.setPath('crashDumps', join(scratch, 'crashes')); app.setAppLogsPath(join(scratch, 'logs'));
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'horizon', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const pause = ms => new Promise(done => setTimeout(done, ms));
let serviceProcess, seed, server, window, privateWindow, stage = 'startup', finishing = false;
const browsers = [];
const screenshots = join(runtime, 'screenshots');
const timeout = setTimeout(() => { void finish(false); }, 120000);
async function until(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await pause(100); }
  throw new Error(description);
}
async function finish(success) {
  if (finishing) return; finishing = true; clearTimeout(timeout);
  try {
    await Promise.all(browsers.map(browser => browser.closeVault()));
    privateWindow?.destroy(); window?.destroy();
    if (seed) { await seed.lock(); await seed.close(); }
    if (server) await new Promise(done => server.close(done));
    if (serviceProcess && serviceProcess.exitCode === null) {
      const exited = new Promise(done => serviceProcess.once('exit', done));
      serviceProcess.kill(); await Promise.race([exited, pause(3000)]);
      if (serviceProcess.exitCode === null) { serviceProcess.kill('SIGKILL'); await Promise.race([exited, pause(3000)]); }
    }
    // Resolve and check the generated path before recursive cleanup on Windows.
    const target = resolve(scratch), inside = relative(runtime, target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe scratch path');
    try { rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch {
      // Chromium can hold its temporary database until Electron exits. A hidden
      // Node helper retries only this checked generated directory after exit.
      const cleanup = "const fs=require('node:fs'),p=require('node:path');const root=p.resolve(process.argv[1]),target=p.resolve(process.argv[2]),r=p.relative(root,target);if(!r||r.startsWith('..')||p.isAbsolute(r)||!/^verify-vault-[A-Za-z0-9_-]+$/.test(r))process.exit(1);let attempts=0;const timer=setInterval(()=>{try{fs.rmSync(target,{recursive:true,force:true});clearInterval(timer)}catch{if(++attempts===60){clearInterval(timer);process.exitCode=1}}},500)";
      const child = spawn(process.env.HORIZON_VERIFY_NODE || 'node', ['-e', cleanup, runtime, target], { windowsHide: true, detached: true, shell: false, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
      child.on('error', () => {}); child.unref();
    }
  } catch { success = false; }
  console.log(success ? 'Vault runtime verification passed.' : `Vault runtime verification failed at ${stage}. Synthetic values were not printed.`);
  app.exit(success ? 0 : 1);
}
const chrome = (code, target = window) => target.webContents.executeJavaScript(code);
const command = value => chrome(`window.horizon.command(${JSON.stringify(value)})`);
async function dom(contents, work) {
  assert.equal(contents.debugger.isAttached(), false);
  contents.debugger.attach('1.3');
  try { return await work((method, params) => contents.debugger.sendCommand(method, params)); }
  finally { if (!contents.isDestroyed()) contents.debugger.detach(); }
}
async function focusEmail(contents) {
  await command({ type: 'vault-dismiss' });
  await command({ type: 'focus-page' });
  await dom(contents, async send => {
    const { root } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=email]' });
    assert.ok(nodeId); await send('DOM.focus', { nodeId });
  });
  contents.focus();
}
async function openPasswords() {
  await chrome(`document.querySelector('[aria-controls="browser-menu"]').click()`);
  await until(() => chrome('Boolean(document.querySelector("#browser-menu"))'), 'Menu missing');
  await chrome(`document.querySelector('#browser-menu button:has(.lucide-key-round)').click()`);
  await until(() => chrome('Boolean(document.querySelector(".vault-panel"))'), 'Passwords missing');
}
async function snapshot(contents) {
  return dom(contents, send => send('DOMSnapshot.captureSnapshot', { computedStyles: [] }));
}
async function createWindow(privateMode, settings, registry) {
  const { createBrowser, isProfileSession, isLaunchNavigation } = require('../dist/electron/browser.js');
  const { hardenContents, validateSender } = require('../dist/electron/security.js');
  if (!ipcMain.listenerCount('horizon:language-verifier')) {
    ipcMain.handle('horizon:language', event => { validateSender(event, event.sender); return 'en'; });
    ipcMain.handle('horizon:window-action', (event, action) => { validateSender(event, event.sender); if (action === 'close') BrowserWindow.fromWebContents(event.sender)?.close(); });
    ipcMain.on('horizon:language-verifier', () => {});
    app.on('web-contents-created', (_event, contents) => { hardenContents(contents, isProfileSession(contents.session), url => isLaunchNavigation(contents, url)); });
  }
  const target = new BrowserWindow({ width: 1440, height: 900, frame: false, show: true, webPreferences: {
    preload: resolve(root, 'dist/electron/preload.js'), additionalArguments: ['--horizon-theme=amber', '--horizon-contrast=standard'],
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
  } });
  const browser = createBrowser(target, browserHome, scratch, settings, registry, { status: 'developmentBuild', async refresh() {}, async register() {} }, { privateWindow: privateMode, fresh: true });
  browsers.push(browser);
  target.webContents.on('did-attach-webview', () => { throw new Error('Unexpected webview'); });
  await target.loadURL('horizon://app/');
  await until(() => chrome('Boolean(document.querySelector(".toolbar"))', target), 'Chrome missing');
  return target;
}
app.whenReady().then(async () => {
  try {
    stage = 'temporary service';
    const node = process.env.HORIZON_VERIFY_NODE || 'node';
    // HORIZON_VERIFY_VAULT_REPO points the check at a clean Vault checkout instead of the sibling working copy.
    const vaultRepository = resolve(process.env.HORIZON_VERIFY_VAULT_REPO || resolve(root, '../Vault'));
    const env = { ...process.env, VAULT_HOME: vaultHome }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
    // dev-install writes only the generated VAULT_HOME, never the real service home.
    await promisify(execFile)(node, [join(vaultRepository, 'packages/cli/src/main.ts'), 'dev-install'], { env, windowsHide: true, timeout: 30000 });
    serviceProcess = spawn(node, [join(vaultRepository, 'packages/service/src/main.ts')], { env, windowsHide: true, shell: false, stdio: 'ignore' });
    let failed = false; serviceProcess.on('error', () => { failed = true; });
    const { connect, findService } = await import('vault-client');
    await until(async () => !failed && Boolean(await findService(vaultHome)), 'Service unavailable');
    let token;
    seed = await connect({ home: vaultHome, app: { id: 'vault-cli', name: 'Synthetic verifier', kind: 'cosmic' }, tokens: { async get() { return token; }, async set(value) { token = value; } } });
    const master = randomBytes(24).toString('base64url'), username = 'synthetic@example.test', password = randomBytes(24).toString('base64url');
    await seed.create(master);
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "script-src 'none'" });
      if (request.url === '/frame') response.end(`<!doctype html><title>Synthetic frame host</title><iframe src="http://localhost:${server.address().port}/login" width="650" height="600"></iframe>`);
      else response.end(`<!doctype html><title>Synthetic sign-in</title><style>body{font:16px system-ui;background:#eeebe9;margin:80px}form{width:420px;margin:auto;padding:32px;border:1px solid #c2bdb9;border-radius:14px;background:#f4f2f0}label,input{display:block}input{height:40px;width:350px;margin:12px 0 48px}button{height:40px}</style><form><h1>Synthetic sign-in</h1><label>Email<input type="email" autocomplete="username" id="email" autofocus></label><label>Password<input type="password" autocomplete="current-password" id="password"></label><button type="button">Sign in</button></form>`);
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`, lookalike = `http://localhost:${server.address().port}`;
    const save = async (website, title) => {
      const id = randomUUID();
      await seed.entries.save({ id, kind: 'login', title, favorite: false, fields: [
        { id: 'website', name: 'Website', value: website, secret: false }, { id: 'username', name: 'Username', value: username, secret: false },
        { id: 'password', name: 'Password', value: password, secret: true },
      ], note: '', totp: '', recovery: [], files: [], updatedAt: new Date().toISOString() }, 0); return id;
    };
    const mainId = await save(origin, 'Synthetic local site'), otherId = await save(lookalike, 'Synthetic look-alike site');
    const { createSettings } = require('../dist/electron/settings.js');
    const { readRegistry } = require('../dist/electron/profiles.js');
    const { serveHorizon } = require('../dist/electron/protocol.js');
    const { secureSession } = require('../dist/electron/security.js');
    const settings = createSettings(join(browserHome, 'settings.json'), () => {}); settings.setLanguage('en'); settings.setTheme('amber', false); settings.finishFirstRun();
    const registry = readRegistry(join(browserHome, 'profiles.json'), 'en');
    secureSession(session.defaultSession);
    await serveHorizon(session.defaultSession.protocol, resolve(root, 'dist/renderer'));
    window = await createWindow(false, settings, registry);
    stage = 'local sign-in';
    await command({ type: 'navigate', input: origin + '/login' });
    let contents;
    await until(() => { contents = webContents.getAllWebContents().find(item => item.getURL() === origin + '/login'); return contents && !contents.isLoading(); }, 'Local page missing');
    await command({ type: 'vault-unlock', password: master });
    assert.equal((await chrome('window.horizon.getState()')).vault.logins.some(item => item.id === mainId), true);
    await command({ type: 'vault-lock' });
    await focusEmail(contents);
    // A locked Vault shows nothing of itself: the suggestion is only the way to unlock, and no saved title, username, site or id reaches chrome.
    const hidden = [mainId, otherId, 'Synthetic local site', 'Synthetic look-alike site', username];
    const leaks = async () => { const text = JSON.stringify((await chrome('window.horizon.getState()')).vault); return hidden.filter(value => text.includes(value)); };
    stage = 'locked suggestion';
    await until(() => chrome('Boolean(document.querySelector(".vault-suggestion .vault-account"))'), 'Suggestion missing');
    await until(() => window.contentView.children.some(view => view.webContents === contents && !view.getVisible()), 'Suggestion did not cover the native page');
    const suggestion = (await chrome('window.horizon.getState()')).vault.suggestion;
    assert.equal(suggestion.origin, origin); assert.equal(suggestion.locked, true); assert.deepEqual(suggestion.logins, []); assert.deepEqual(await leaks(), []);
    assert.equal(await chrome('document.querySelectorAll(".vault-suggestion .vault-account").length'), 1);
    assert.equal(await chrome('document.querySelector(".vault-suggestion").textContent.includes("Synthetic")'), false);
    const geometry = await chrome('(() => { const r=document.querySelector(".vault-suggestion").getBoundingClientRect();return {x:r.x,y:r.y};})()');
    assert.ok(Math.abs(geometry.x - suggestion.x) < 2); assert.ok(Math.abs(geometry.y - suggestion.y) < 2);
    mkdirSync(screenshots, { recursive: true });
    const suggestionPath = join(screenshots, 'vault-suggestion.png'); writeFileSync(suggestionPath, (await window.webContents.capturePage()).toPNG());
    stage = 'master password and native fill';
    await chrome('document.querySelector(".vault-account").click()');
    await until(() => chrome('Boolean(document.querySelector(".vault-dialog[open]"))'), 'Unlock dialog missing');
    await chrome(`(() => { const input=document.querySelector('.vault-dialog input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,${JSON.stringify(master)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await pause(100); await chrome('document.querySelector(".vault-dialog form").requestSubmit()');
    // After the unlock the same suggestion shows the sign-ins of this origin, without focusing the field again.
    await until(async () => { const shown = (await chrome('window.horizon.getState()')).vault.suggestion; return shown?.locked === false && shown.logins.length === 1; }, 'Sign-ins missing after unlock');
    assert.deepEqual((await chrome('window.horizon.getState()')).vault.suggestion.logins.map(item => item.id), [mainId]);
    await until(() => chrome('!document.querySelector(".vault-dialog[open]")'), 'Unlock dialog did not close');
    await chrome('document.querySelector(".vault-account").click()');
    await until(async () => {
      const data = await snapshot(contents), document = data.documents[0];
      const values = document.nodes.inputValue;
      return values?.value.some(index => data.strings[index] === password) && values.value.some(index => data.strings[index] === username);
    }, 'Native fill did not finish');
    assert.equal(JSON.stringify(await chrome('window.horizon.getState()')).includes(password), false);
    stage = 'look-alike page';
    await command({ type: 'vault-lock' }); await command({ type: 'navigate', input: lookalike + '/login' });
    await until(() => { contents = webContents.getAllWebContents().find(item => item.getURL() === lookalike + '/login'); return contents && !contents.isLoading(); }, 'Look-alike page missing');
    await focusEmail(contents);
    // Locked, the look-alike page gets the same unlock offer and no login data at all.
    await until(() => chrome('Boolean(document.querySelector(".vault-suggestion .vault-account"))'), 'Look-alike suggestion missing');
    const lookalikeLocked = (await chrome('window.horizon.getState()')).vault.suggestion;
    assert.equal(lookalikeLocked.origin, lookalike); assert.equal(lookalikeLocked.locked, true); assert.deepEqual(lookalikeLocked.logins, []); assert.deepEqual(await leaks(), []);
    // Unlocked, only the sign-in of the look-alike's own origin is offered, never the one of the other origin.
    await command({ type: 'vault-unlock', password: master });
    await until(async () => { const shown = (await chrome('window.horizon.getState()')).vault.suggestion; return shown?.locked === false && shown.logins.length > 0; }, 'Look-alike sign-in missing after unlock');
    const lookalikeShown = (await chrome('window.horizon.getState()')).vault.suggestion;
    assert.equal(lookalikeShown.origin, lookalike); assert.deepEqual(lookalikeShown.logins.map(item => item.id), [otherId]);
    assert.equal(JSON.stringify(lookalikeShown).includes(mainId), false); assert.equal(JSON.stringify(lookalikeShown).includes('Synthetic local site'), false);
    await command({ type: 'vault-lock' }); assert.deepEqual(await leaks(), []);
    // Both origins have saved logins. The service still returns only the exact one.
    await seed.unlock(master);
    assert.deepEqual((await seed.logins(origin)).map(row => row.entry.id), [mainId]); assert.deepEqual((await seed.logins(lookalike)).map(row => row.entry.id), [otherId]); await seed.lock();
    stage = 'cross-origin iframe';
    await command({ type: 'navigate', input: origin + '/frame' });
    await until(() => { contents = webContents.getAllWebContents().find(item => item.getURL() === origin + '/frame'); return contents && !contents.isLoading(); }, 'Frame page missing');
    await command({ type: 'focus-page' }); contents.focus();
    // Clicks into an offscreen frame are unreliable. The cross-origin frame runs in its own process, so the harness, standing in for the person, focuses its field directly.
    const frame = contents.mainFrame.frames.find(item => item.url.startsWith(lookalike)); assert.ok(frame);
    await frame.executeJavaScript('document.querySelector("input[type=email]").focus()');
    await until(() => contents.focusedFrame && contents.focusedFrame !== contents.mainFrame, 'Frame was not focused'); await pause(1700);
    assert.equal((await chrome('window.horizon.getState()')).vault.suggestion, null); assert.deepEqual(await leaks(), []);
    stage = 'private window';
    privateWindow = await createWindow(true, settings, registry);
    await chrome(`window.horizon.command({type:'navigate',input:${JSON.stringify(origin + '/login')}})`, privateWindow); await pause(1700);
    assert.equal((await chrome('window.horizon.getState()', privateWindow)).vault.suggestion, null);
    assert.equal(await chrome(`window.horizon.command({type:'vault-refresh'}).then(()=>false,()=>true)`, privateWindow), true); privateWindow.destroy(); privateWindow = undefined;
    stage = 'Passwords panel and clipboard';
    await command({ type: 'navigate', input: origin + '/login' }); await command({ type: 'vault-unlock', password: master });
    await openPasswords();
    await until(() => chrome('Boolean(document.querySelector(".vault-row"))'), 'Login row missing');
    await until(() => chrome('Boolean(document.querySelector(".web-snapshot")?.complete)'), 'Panel backdrop missing');
    const panelPath = join(screenshots, 'vault-passwords.png'); writeFileSync(panelPath, (await window.webContents.capturePage()).toPNG());
    await chrome('document.querySelector(".vault-row button").click()');
    const { clipboard } = require('electron');
    await until(async () => await clipboard.readText() === password, 'Clipboard copy missing');
    assert.equal(JSON.stringify(await chrome('window.horizon.getState()')).includes(password), false);
    await pause(30500); assert.equal(await clipboard.readText() === password, false);
    console.log(`Suggestion screenshot: ${suggestionPath}`); console.log(`Passwords screenshot: ${panelPath}`);
    await finish(true);
  } catch (error) {
    // Only the error's kind and code are printed; messages can carry synthetic values.
    console.log(`Failure kind: ${error?.name ?? "unknown"}${error?.code ? " " + error.code : ""} at ${stage}: ${String(error?.message ?? "").replace(/[^ -~]/g, "").slice(0, 80)}`);
    await finish(false);
  }
});
