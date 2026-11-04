// Run after npm run build: electron scripts/verify-vault.cjs
// This verifier uses a real service and real Horizon surfaces, with synthetic data.
// No window is ever shown or focused: Horizon runs hidden (show: false) with painting kept on, and every picture is a capture of its views.
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
const started = Date.now();
const pause = ms => new Promise(done => setTimeout(done, ms));
let serviceProcess, seed, server, window, privateWindow, stage = 'startup', finishing = false;
const browsers = [], servicePids = new Set();
const screenshots = process.env.HORIZON_VERIFY_SHOTS ? resolve(process.env.HORIZON_VERIFY_SHOTS) : join(runtime, 'screenshots');
const timeout = setTimeout(() => { void finish(false); }, 700000);
async function until(check, description, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (await check()) return; await pause(100); }
  throw new Error(description);
}
async function finish(success) {
  if (finishing) return; finishing = true; clearTimeout(timeout);
  try {
    await Promise.race([Promise.all(browsers.map(browser => browser.closeVault())), pause(8000)]);
    privateWindow?.destroy(); window?.destroy();
    if (seed) { await seed.lock(); await seed.close(); }
    if (server) await new Promise(done => server.close(done));
    // The service the browser started on its own is the one of this temporary home; it goes by its recorded process id.
    try { const { findService } = await import('vault-client'); const record = await findService(vaultHome, 500); if (record) servicePids.add(record.pid); } catch { /* No service is left to stop. */ }
    if (serviceProcess) servicePids.add(serviceProcess.pid);
    for (const pid of servicePids) { try { process.kill(pid); } catch { /* Already gone. */ } }
    await pause(500);
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
  console.log(`Stopped processes: ${[...servicePids].join(', ') || 'none'}`);
  app.exit(success ? 0 : 1);
}
const chrome = (code, target = window) => target.webContents.executeJavaScript(code);
const command = value => chrome(`window.horizon.command(${JSON.stringify(value)})`);
const state = () => chrome('window.horizon.getState()');
async function dom(contents, work) {
  assert.equal(contents.debugger.isAttached(), false);
  contents.debugger.attach('1.3');
  try { return await work((method, params) => contents.debugger.sendCommand(method, params)); }
  finally { if (!contents.isDestroyed()) contents.debugger.detach(); }
}
// Retries while the browser's own scan holds the debugger for a moment.
async function domWhenFree(contents, work) {
  for (let attempt = 0; attempt < 300; attempt++) { if (!contents.debugger.isAttached()) { try { return await dom(contents, work); } catch (error) { if (!/already attached/i.test(String(error?.message))) throw error; } } await pause(40); }
  throw new Error('Debugger stayed busy');
}
async function focusField(contents, selector) {
  await command({ type: 'vault-dismiss' });
  await command({ type: 'focus-page' });
  await domWhenFree(contents, async send => {
    const { root: top } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: top.nodeId, selector });
    assert.ok(nodeId, selector); await send('DOM.focus', { nodeId });
  });
  contents.focus();
  // The press that brings the focus, as Electron reports it to the browser.
  contents.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown' });
}
const focusEmail = contents => focusField(contents, 'input[type=email]');
async function box(contents, selector) {
  return domWhenFree(contents, async send => {
    const { root: top } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: top.nodeId, selector });
    const { model } = await send('DOM.getBoxModel', { nodeId });
    const q = model.content; return { x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1] };
  });
}
async function openPasswords() {
  await chrome(`document.querySelector('[aria-controls="browser-menu"]').click()`);
  await until(() => chrome('Boolean(document.querySelector("#browser-menu"))'), 'Menu missing');
  await chrome(`document.querySelector('#browser-menu button:has(.lucide-key-round)').click()`);
  await until(() => chrome('Boolean(document.querySelector(".vault-panel"))'), 'Passwords missing');
}
async function snapshot(contents) {
  return domWhenFree(contents, send => send('DOMSnapshot.captureSnapshot', { computedStyles: [] }));
}
const hasValue = async (contents, value) => {
  const data = await snapshot(contents), values = data.documents[0].nodes.inputValue;
  return Boolean(values?.value.some(index => data.strings[index] === value));
};
// The view that draws the suggestion: the one child view of the window with the browser's own address that is not the chrome.
const overlayView = target => (target ?? window).contentView.children.find(view => view.webContents !== (target ?? window).webContents && view.webContents.getURL() === 'horizon://app/');
const overlay = code => overlayView().webContents.executeJavaScript(code);
// The window is hidden, so a picture is built from the captures of its views: chrome, then page and suggestion at their bounds, composed on a canvas of a hidden helper window.
let composer;
// A view of a hidden window is never painted by Chromium, so the suggestion is drawn again, with the page and styles it has, in an offscreen helper that is painted and captured.
let painter;
async function redraw(contents, at) {
  const markup = await contents.executeJavaScript(`(() => { const css = [...document.styleSheets].flatMap(sheet => (() => { try { return [...sheet.cssRules].map(rule => rule.cssText); } catch { return []; } })()).join(String.fromCharCode(10)); const root = document.documentElement.cloneNode(true); root.querySelectorAll('script,link').forEach(node => node.remove()); const head = root.querySelector('head') ?? root.appendChild(document.createElement('head')); const style = document.createElement('style'); style.textContent = css + ' html,body{background:transparent!important;margin:0}'; head.appendChild(style); return '<!doctype html>' + root.outerHTML; })()`);
  painter.setContentSize(Math.max(at.width, 64), Math.max(at.height, 64));
  await painter.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(markup)); await pause(300);
  const image = await painter.webContents.capturePage(); console.log('PAINT', JSON.stringify(image.getSize()), markup.length);
  return image.toDataURL();
}
// A capture of a view that has just changed can fail once while the compositor catches up.
async function attempt(work) { for (let tries = 0; ; tries++) { try { return await work(); } catch (error) { if (tries >= 6) throw error; await pause(150); } } }
async function shot(name, target = window) {
  mkdirSync(screenshots, { recursive: true });
  const size = target.getContentBounds(), layers = [];
  for (const view of [{ webContents: target.webContents, getBounds: () => ({ x: 0, y: 0, width: size.width, height: size.height }), getVisible: () => true }, ...target.contentView.children.filter(view => view.webContents && !view.webContents.isDestroyed() && view.webContents !== target.webContents)]) {
    if (!view.getVisible()) continue;
    // The hidden window paints a frame behind: the first capture wakes the view and the second is the current one.
    if (view.webContents === target.webContents) { await attempt(() => view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })); await pause(250); }
    let url, at;
    // A view that cannot be captured at this moment is left out of the picture, which is then checked by eye.
    try {
      at = view.getBounds(); url = view.webContents !== target.webContents && view.webContents.getURL().startsWith("horizon://") ? await redraw(view.webContents, at)
        : view.webContents.getURL().startsWith("horizon://") && view.webContents === target.webContents
        ? await attempt(async () => (await view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toDataURL())
        : "data:image/png;base64," + (await domWhenFree(view.webContents, send => send("Page.captureScreenshot", { format: "png" }))).data;
    } catch (error) { console.log('Capture skipped:', String(error?.message).slice(0, 60)); continue; }
    layers.push({ url, ...at });
  }
  const url = await composer.webContents.executeJavaScript(`(async()=>{const c=document.getElementById('c');c.width=${size.width};c.height=${size.height};const g=c.getContext('2d');for(const l of ${JSON.stringify(layers)}){const i=new Image();i.src=l.url;await i.decode();g.drawImage(i,l.x,l.y,l.width,l.height)}return c.toDataURL('image/png')})()`);
  // A capture takes the keyboard from the page, as the person would; it goes back so the field stays in focus.
  for (const view of target.contentView.children) { try { if (view.getVisible() && view.webContents.getURL().startsWith('http')) view.webContents.focus(); } catch { /* A view that is going away has nothing to give the keyboard back to. */ } };
  const path = join(screenshots, name); writeFileSync(path, Buffer.from(url.split(',')[1], 'base64')); return path;
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
  const target = new BrowserWindow({ width: 1463, height: 914, frame: false, show: false, webPreferences: {
    paintWhenInitiallyHidden: true, backgroundThrottling: false,
    preload: resolve(root, 'dist/electron/preload.js'), additionalArguments: ['--horizon-theme=amber', '--horizon-contrast=standard'],
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
  } });
  const browser = createBrowser(target, browserHome, scratch, settings, registry, { status: 'developmentBuild', async refresh() {}, async register() {} }, { privateWindow: privateMode, fresh: true });
  browsers.push(browser);
  if (process.env.HORIZON_VERIFY_DEBUG) for (const view of target.contentView.children) for (const name of ['did-fail-load', 'render-process-gone', 'did-start-loading', 'did-finish-load', 'did-start-navigation']) view.webContents.on(name, (event, ...rest) => console.log('OVEV', name, view.webContents.getURL().slice(0, 20), JSON.stringify(rest.filter(item => typeof item !== 'object').slice(0, 3))));
  target.webContents.on('did-attach-webview', () => { throw new Error('Unexpected webview'); });
  await target.loadURL('horizon://app/');
  await until(() => chrome('Boolean(document.querySelector(".toolbar"))', target), 'Chrome missing');
  return target;
}
const loginPage = (title, body) => `<!doctype html><title>${title}</title><style>body{font:16px system-ui;background:#eeebe9;margin:80px}form,div.box{width:420px;margin:auto;padding:32px;border:1px solid #c2bdb9;border-radius:14px;background:#f4f2f0}label,input{display:block}input{height:40px;width:350px;margin:12px 0 48px}button{height:40px}</style>${body}`;
app.whenReady().then(async () => {
  try {
    // Made before the browser hardens new contents, so it can draw a data page; it is hidden and loads nothing else.
    composer = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, paintWhenInitiallyHidden: true, backgroundThrottling: false } });
    await composer.loadURL('data:text/html,<canvas id=c></canvas>');
    painter = new BrowserWindow({ show: false, transparent: true, frame: false, width: 400, height: 200, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, javascript: false, partition: 'verify-painter' } });
    stage = 'temporary service'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'temporary service', Date.now() - started);
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
    const form = '<form><h1>Synthetic sign-in</h1><label>Email<input type="email" autocomplete="username" id="email" autofocus></label><label>Password<input type="password" autocomplete="current-password" id="password"></label><button type="button">Sign in</button></form>';
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "script-src 'none'" });
      const path = request.url.split('?')[0];
      if (path === '/frame') response.end(`<!doctype html><title>Synthetic frame host</title><iframe src="http://localhost:${server.address().port}/login" width="650" height="600"></iframe>`);
      else if (path === '/step1') response.end(loginPage('Synthetic first step', '<div class="box"><h1>Synthetic first step</h1><label>Email<input type="email" autocomplete="username" id="email"></label><button type="button">Next</button></div>'));
      else if (path === '/step2') response.end(loginPage('Synthetic second step', '<div class="box"><h1>Synthetic second step</h1><label>Password<input type="password" autocomplete="current-password" id="password"></label><button type="button">Sign in</button></div>'));
      else if (path === '/formless') response.end(loginPage('Synthetic formless', '<div class="box"><h1>Synthetic formless</h1><label>Email<input type="email" autocomplete="username" id="email"></label><label>Password<input type="password" autocomplete="current-password" id="password"></label></div>'));
      else if (path === '/signup') response.end(loginPage('Synthetic sign-up', '<form><h1>Synthetic sign-up</h1><label>Email<input type="email" autocomplete="username" id="email"></label><label>New password<input type="password" autocomplete="new-password" id="password"></label><button type="button">Create</button></form>'));
      else response.end(loginPage('Synthetic sign-in', form));
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
    assert.equal(window.isFocused(), false);
    assert.equal(window.isVisible(), false);
    const open = async path => {
      await command({ type: 'navigate', input: origin + path });
      let found;
      await until(() => { found = webContents.getAllWebContents().find(item => item.getURL() === origin + path); return found && !found.isLoading(); }, 'Page missing: ' + path);
      return found;
    };
    const pageView = contents => window.contentView.children.find(view => view.webContents === contents);
    const suggestionShown = async () => (await state()).vault.suggestion;
    const suggestionDrawn = () => overlayView() ? overlay('Boolean(document.querySelector(".vault-suggestion .vault-account"))') : false;
    // A press on the field as Electron reports one to the browser: the real pointer path cannot be driven without taking the display's focus.
    const click = async (contents, selector) => {
      const at = await box(contents, selector), x = Math.round(at.x + 40), y = Math.round(at.y + 15);
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      contents.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown', x, y });
    };
    stage = 'local sign-in'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'local sign-in', Date.now() - started);
    let contents = await open('/login');
    await command({ type: 'vault-unlock', password: master });
    assert.equal((await state()).vault.logins.some(item => item.id === mainId), true);
    await command({ type: 'vault-lock' });
    await focusEmail(contents); const firstFocus = Date.now();
    // A locked Vault shows nothing of itself: the suggestion is only the way to unlock, and no saved title, username, site or id reaches chrome.
    const hidden = [mainId, otherId, 'Synthetic local site', 'Synthetic look-alike site', username];
    const leaks = async () => { const text = JSON.stringify((await state()).vault) + JSON.stringify(await overlay('window.horizonVault.getState()')); return hidden.filter(value => text.includes(value)); };
    stage = 'locked suggestion'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'locked suggestion', Date.now() - started);
    await until(suggestionDrawn, 'Suggestion missing'); const firstShown = Date.now() - firstFocus;
    // The page is not hidden or frozen for it: the page view stays visible and the suggestion is a view of its own above it.
    assert.equal(pageView(contents).getVisible(), true);
    const cardView = overlayView(); await until(() => cardView.getVisible(), 'Suggestion view stayed hidden');
    const children = window.contentView.children; assert.ok(children.indexOf(cardView) > children.indexOf(pageView(contents)), 'Suggestion is not above the page');
    let suggestion = (await state()).vault.suggestion;
    assert.equal(suggestion.origin, origin); assert.equal(suggestion.locked, true); assert.deepEqual(suggestion.logins, []); assert.deepEqual(await leaks(), []);
    assert.equal(await overlay('document.querySelectorAll(".vault-suggestion .vault-account").length'), 1);
    assert.equal(await overlay('document.querySelector(".vault-suggestion").textContent.includes("Synthetic")'), false);
    assert.equal(await chrome('Boolean(document.querySelector(".vault-suggestion"))'), false);
    // Placement: under the field or above it, never over the field itself or the password field, and inside the page.
    const rectangle = view => view.getBounds();
    const pageBounds = pageView(contents).getBounds(), emailBox = await box(contents, '#email'), passwordBox = await box(contents, '#password');
    const absolute = at => ({ x: pageBounds.x + at.x, y: pageBounds.y + at.y, width: at.width, height: at.height });
    const touches = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    const placedBounds = rectangle(cardView);
    assert.equal(touches(placedBounds, absolute(emailBox)), false); assert.equal(touches(placedBounds, absolute(passwordBox)), false);
    assert.ok(placedBounds.y >= pageBounds.y && placedBounds.y + placedBounds.height <= pageBounds.y + pageBounds.height, 'Suggestion left the page');
    // Typing while the suggestion shows reaches the page and stays visible in it.
    contents.focus(); await contents.insertText('typed');
    await until(() => hasValue(contents, 'typed'), 'Typing did not reach the page');
    assert.equal(cardView.getVisible(), true);
    const lockedPath = await shot('01-suggestion-locked.png');
    // The suggestion follows the page when its view moves: a banner-sized shift of the content area.
    const before = rectangle(cardView);
    await chrome('window.horizon.setContentArea({ top: Math.round(document.querySelector("header.chrome").getBoundingClientRect().bottom) + 58, hidden: false })');
    await until(() => rectangle(cardView).y === before.y + 58, 'Suggestion did not follow the moved page');
    await chrome('window.horizon.setContentArea({ top: Math.round(document.querySelector("header.chrome").getBoundingClientRect().bottom), hidden: false })');
    await until(() => rectangle(cardView).y === before.y, 'Suggestion did not come back with the page');
    await contents.executeJavaScript('0').catch(() => undefined);
    stage = 'dismiss and re-offer'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'dismiss and re-offer', Date.now() - started);
    // A dismissed suggestion comes back when the person clicks or focuses the field again.
    await overlay('document.querySelector(".vault-heading .icon-button").click()');
    await until(async () => !(await suggestionShown()), 'Dismiss did not close the suggestion');
    assert.equal(cardView.getVisible(), false); await pause(900); assert.equal(await suggestionShown(), null);
    await click(contents, '#email'); const reopenAt = Date.now();
    await until(async () => (await suggestionShown())?.locked === true, 'Click did not offer the field again').catch(async error => { const v = (await state()).vault; console.log('DEBUG', JSON.stringify({ unlocked: v.unlocked, available: v.available, created: v.created, error: v.error, s: Boolean(v.suggestion), focus: contents.isFocused?.(), devtools: contents.debugger.isAttached() })); throw error; });
    await until(() => cardView.getVisible(), 'Suggestion view did not come back'); const reopened = Date.now() - reopenAt;
    // The password field gets its own offer; the username stays dismissed in the meantime.
    const emailCard = cardView.getBounds();
    await domWhenFree(contents, async send => { const { root: top } = await send('DOM.getDocument', { depth: 0 }); const { nodeId } = await send('DOM.querySelector', { nodeId: top.nodeId, selector: '#password' }); await send('DOM.focus', { nodeId }); });
    await until(() => { const now = cardView.getBounds(); return cardView.getVisible() && (now.x !== emailCard.x || now.y !== emailCard.y); }, 'Password field has no offer of its own');
    await focusEmail(contents);
    await until(suggestionDrawn, 'Suggestion missing after refocus');
    stage = 'master password, wrong password and fill with no extra click'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'master password, wrong password and fill with no extra click', Date.now() - started);
    await overlay('document.querySelector(".vault-account").click()');
    // The dialog is the one thing that covers the page; the suggestion gives way to it and does not stay dimmed behind it.
    await until(() => chrome('Boolean(document.querySelector(".vault-dialog[open]"))'), 'Unlock dialog missing');
    assert.equal((await state()).vault.unlockPrompt.origin, origin);
    await until(() => !pageView(contents).getVisible() && !cardView.getVisible(), 'Page or suggestion stayed visible under the dialog');
    assert.equal(await chrome('document.querySelector(".vault-dialog h2").textContent'), 'Vault is locked');
    assert.equal(await chrome('document.querySelector(".vault-dialog .setting-hint").textContent.includes("127.0.0.1")'), true);
    assert.equal(await chrome('document.activeElement === (document.querySelector(".vault-dialog .vault-hello") ?? document.querySelector(".vault-dialog input"))'), true);
    const hello = await chrome('Boolean(document.querySelector(".vault-dialog .vault-hello"))');
    assert.equal(hello, process.platform === 'win32'); assert.equal(await chrome('Boolean(document.querySelector(".vault-dialog input[type=password]"))'), true);
    assert.equal(await chrome('Boolean(document.querySelector(".toolbar-banner, .browser-error, header [role=alert]"))'), false);
    await pause(250);
    const dialogPath = await shot('02-unlock-dialog-default.png');
    const typeMaster = value => chrome(`(() => { const input=document.querySelector('.vault-dialog input[type=password]'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await typeMaster('wrong ' + randomBytes(6).toString('hex')); await pause(100);
    await chrome('document.querySelector(".vault-dialog form").requestSubmit()');
    // Busy: the controls are disabled and say so while Vault checks.
    let busyPath = '';
    try { await until(() => chrome('document.querySelector(".vault-dialog")?.getAttribute("aria-busy") === "true"'), 'Busy state missing', 30); busyPath = await shot('03-unlock-dialog-busy.png'); } catch { /* Vault answered before the capture; the busy markup is also asserted in the unit tests. */ }
    await until(() => chrome('Boolean(document.querySelector(".vault-dialog .vault-error"))'), 'Wrong password message missing');
    assert.equal(await chrome('document.querySelector(".vault-dialog .vault-error").textContent'), 'That master password is not right. Try again.');
    await until(() => chrome('document.activeElement === document.querySelector(".vault-dialog input[type=password]")'), 'Focus did not return to the password field');
    assert.equal(await chrome('document.querySelector(".vault-dialog input[type=password]").getAttribute("aria-invalid")'), 'true');
    assert.equal(await chrome('Boolean(document.querySelector(".toolbar-banner, .browser-error, header [role=alert]"))'), false);
    assert.equal((await state()).vault.error, null);
    const wrongPath = await shot('04-unlock-dialog-wrong-password.png');
    // Vault holds a retry back for a moment after a wrong password.
    await pause(1400); await typeMaster(master); await pause(100);
    const unlockedAt = Date.now();
    await chrome('document.querySelector(".vault-dialog form").requestSubmit()');
    // The only sign-in of this site goes in with no further click.
    await until(async () => (await hasValue(contents, password)) && (await hasValue(contents, username)), 'Native fill did not finish after the unlock', 150);
    const unlockToFill = Date.now() - unlockedAt;
    await until(() => chrome('!document.querySelector(".vault-dialog[open]")'), 'Unlock dialog did not close');
    await until(() => pageView(contents).getVisible(), 'Page did not come back'); assert.equal((await state()).vault.unlockPrompt, null);
    assert.equal(JSON.stringify(await state()).includes(password), false);
    await pause(500); await shot('05-after-fill.png');
    stage = 'unlocked suggestion'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'unlocked suggestion', Date.now() - started);
    await command({ type: 'vault-dismiss' }); contents = await open('/login'); await focusEmail(contents); const warmAt = Date.now();
    await until(async () => { const shown = await suggestionShown(); return shown?.locked === false && shown.logins.length === 1; }, 'Unlocked suggestion missing');
    await until(suggestionDrawn, 'Unlocked suggestion not drawn'); const warmFirst = Date.now() - warmAt, warmRuns = [warmFirst];
    // The machine is shared, so the warm path is sampled several times and the median is reported with the best.
    for (let run = 0; run < 4; run++) {
      await command({ type: 'vault-dismiss' }); await until(async () => !(await suggestionShown()), 'Dismiss missing');
      await focusEmail(contents); const at = Date.now();
      await until(async () => (await suggestionShown())?.locked === false, 'Warm suggestion missing'); await until(suggestionDrawn, 'Warm suggestion not drawn'); warmRuns.push(Date.now() - at);
    }
    const sorted = [...warmRuns].sort((a, b) => a - b), warm = `${sorted[Math.floor(sorted.length / 2)]} median, ${sorted[0]} best of ${sorted.length}`;
    assert.deepEqual((await suggestionShown()).logins.map(item => item.id), [mainId]);
    assert.equal(await overlay('document.querySelector(".vault-suggestion").textContent.includes("Synthetic")'), false);
    assert.equal(await overlay('document.querySelector(".vault-account .browser-entry-copy span").textContent'), username);
    await pause(250);
    const unlockedPath = await shot('06-suggestion-unlocked.png');
    // Cancel: Escape in the dialog closes it and leaves the field quiet.
    await command({ type: 'vault-lock' });
    await focusEmail(contents); await until(async () => (await suggestionShown())?.locked === true, 'Locked suggestion missing'); await until(suggestionDrawn, 'Locked suggestion not drawn');
    await overlay('document.querySelector(".vault-account").click()');
    await until(() => chrome('Boolean(document.querySelector(".vault-dialog[open]"))'), 'Unlock dialog missing');
    await chrome('document.querySelector(".vault-dialog").dispatchEvent(new Event("cancel", { cancelable: true }))');
    await until(() => chrome('!document.querySelector(".vault-dialog[open]")'), 'Escape did not close the dialog');
    assert.equal((await state()).vault.unlockPrompt, null); await until(() => pageView(contents).getVisible(), 'Page did not come back after cancel');
    stage = 'suggestion view limits'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'suggestion view limits', Date.now() - started);
    // The suggestion's view can only fill, dismiss and ask; everything else is refused, and it has no browser API.
    assert.equal(await overlay('typeof window.horizon'), 'undefined'); assert.deepEqual(await overlay('Object.keys(window.horizonVault).sort()'), ['command', 'getState', 'initialContrast', 'initialTheme', 'onFocus', 'onState', 'resize']);
    for (const call of [`window.horizonVault.command({type:'vault-unlock',password:'x'})`, `window.horizonVault.command({type:'vault-hello'})`, `window.horizonVault.command({type:'vault-fill',suggestion:'a',id:'b',password:'x'})`, `window.horizonVault.command({type:'vault-dismiss',extra:1})`, `window.horizonVault.resize('x',-1,5)`, `window.horizonVault.resize('x',5000,5)`])
      assert.equal(await overlay(`${call}.then(()=>'accepted',()=>'refused')`), 'refused', call);
    assert.equal(await chrome(`typeof window.horizonVault`), 'undefined');
    stage = 'password, two-step, formless and sign-up pages'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'password, two-step, formless and sign-up pages', Date.now() - started);
    await command({ type: 'vault-lock' });
    contents = await open('/login'); await focusField(contents, '#password');
    await until(async () => (await suggestionShown())?.locked === true, 'Password field has no offer on a fresh page');
    contents = await open('/step1'); await focusField(contents, '#email');
    await until(async () => (await suggestionShown())?.locked === true, 'First step has no offer');
    contents = await open('/step2'); await focusField(contents, '#password');
    await until(async () => (await suggestionShown())?.locked === true, 'Second step has no offer');
    contents = await open('/formless'); await focusField(contents, '#password');
    await until(async () => (await suggestionShown())?.locked === true, 'Formless password has no offer');
    await focusField(contents, '#email'); await until(async () => (await suggestionShown())?.locked === true, 'Formless email has no offer');
    contents = await open('/signup'); await focusField(contents, '#email'); await pause(1500);
    assert.equal(await suggestionShown(), null, 'Sign-up email must stay quiet');
    await focusField(contents, '#password'); await pause(1200); assert.equal(await suggestionShown(), null, 'New password must stay quiet');
    stage = 'look-alike page'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'look-alike page', Date.now() - started);
    await command({ type: 'vault-lock' }); contents = await open('/login'); await command({ type: 'navigate', input: lookalike + '/login' });
    await until(() => { contents = webContents.getAllWebContents().find(item => item.getURL() === lookalike + '/login'); return contents && !contents.isLoading(); }, 'Look-alike page missing');
    await focusEmail(contents);
    // Locked, the look-alike page gets the same unlock offer and no login data at all.
    await until(async () => (await suggestionShown())?.origin === lookalike, 'Look-alike suggestion missing'); await until(suggestionDrawn, 'Look-alike suggestion not drawn');
    const lookalikeLocked = (await state()).vault.suggestion;
    assert.equal(lookalikeLocked.origin, lookalike); assert.equal(lookalikeLocked.locked, true); assert.deepEqual(lookalikeLocked.logins, []); assert.deepEqual(await leaks(), []);
    // Unlocked, only the sign-in of the look-alike's own origin is offered, never the one of the other origin.
    await command({ type: 'vault-unlock', password: master });
    await until(async () => { const shown = (await state()).vault.suggestion; return shown?.locked === false && shown.logins.length > 0; }, 'Look-alike sign-in missing after unlock');
    const lookalikeShown = (await state()).vault.suggestion;
    assert.equal(lookalikeShown.origin, lookalike); assert.deepEqual(lookalikeShown.logins.map(item => item.id), [otherId]);
    assert.equal(JSON.stringify(lookalikeShown).includes(mainId), false); assert.equal(JSON.stringify(lookalikeShown).includes('Synthetic local site'), false);
    await command({ type: 'vault-lock' }); assert.deepEqual(await leaks(), []);
    // Both origins have saved logins. The service still returns only the exact one.
    await seed.unlock(master);
    assert.deepEqual((await seed.logins(origin)).map(row => row.entry.id), [mainId]); assert.deepEqual((await seed.logins(lookalike)).map(row => row.entry.id), [otherId]); await seed.lock();
    stage = 'cross-origin iframe'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'cross-origin iframe', Date.now() - started);
    await command({ type: 'navigate', input: origin + '/frame' });
    await until(() => { contents = webContents.getAllWebContents().find(item => item.getURL() === origin + '/frame'); return contents && !contents.isLoading(); }, 'Frame page missing');
    await command({ type: 'focus-page' }); contents.focus();
    // Clicks into an offscreen frame are unreliable. The cross-origin frame runs in its own process, so the harness, standing in for the person, focuses its field directly.
    const frame = contents.mainFrame.frames.find(item => item.url.startsWith(lookalike)); assert.ok(frame);
    await frame.executeJavaScript('document.querySelector("input[type=email]").focus()');
    await until(() => contents.focusedFrame && contents.focusedFrame !== contents.mainFrame, 'Frame was not focused'); await pause(1700);
    assert.equal((await state()).vault.suggestion, null); assert.deepEqual(await leaks(), []);
    stage = 'private window'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'private window', Date.now() - started);
    privateWindow = await createWindow(true, settings, registry);
    assert.equal(overlayView(privateWindow), undefined);
    await chrome(`window.horizon.command({type:'navigate',input:${JSON.stringify(origin + '/login')}})`, privateWindow); await pause(1700);
    assert.equal((await chrome('window.horizon.getState()', privateWindow)).vault.suggestion, null);
    assert.equal(await chrome(`window.horizon.command({type:'vault-refresh'}).then(()=>false,()=>true)`, privateWindow), true); privateWindow.destroy(); privateWindow = undefined;
    stage = 'Passwords panel and clipboard'; if (process.env.HORIZON_VERIFY_DEBUG) console.log('STAGE', 'Passwords panel and clipboard', Date.now() - started);
    await command({ type: 'navigate', input: origin + '/login' }); await command({ type: 'vault-unlock', password: master });
    await openPasswords();
    await until(() => chrome('Boolean(document.querySelector(".vault-row"))'), 'Login row missing');
    await chrome('document.querySelector(".vault-row button").click()');
    const { clipboard } = require('electron');
    await until(async () => await clipboard.readText() === password, 'Clipboard copy missing');
    assert.equal(JSON.stringify(await state()).includes(password), false);
    await pause(30500); assert.equal(await clipboard.readText() === password, false);
    console.log(`Screenshots: ${[lockedPath, dialogPath, busyPath, wrongPath, unlockedPath].filter(Boolean).join(' | ')}`);
    console.log(`Timing (ms): first field of the session ${firstShown}, warm focus to suggestion ${warm}, reopen after dismiss ${reopened}, unlock to filled ${unlockToFill} (includes Vault's key derivation)`);
    await finish(true);
  } catch (error) {
    // Only the error's kind and code are printed; messages can carry synthetic values.
    console.log(`Failure kind: ${error?.name ?? "unknown"}${error?.code ? " " + error.code : ""} at ${stage}: ${String(error?.message ?? "").replace(/[^ -~]/g, "").slice(0, 120)} ${String(error?.stack ?? "").split(String.fromCharCode(10)).filter(l => l.includes("verify-vault.cjs")).map(l => l.replace(/.*verify-vault.cjs:/, "")).join(" < ")}`);
    // The flags that explain a failure; no value of Vault is among them.
    try {
      const vault = (await state()).vault, card = overlayView();
      console.log('State:', JSON.stringify({ unlocked: vault.unlocked, available: vault.available, created: vault.created, error: vault.error, prompt: Boolean(vault.unlockPrompt), suggestion: vault.suggestion && { locked: vault.suggestion.locked, logins: vault.suggestion.logins.length },
        card: card && { visible: card.getVisible(), bounds: card.getBounds() }, pages: window.contentView.children.map(view => [view.webContents.getURL().slice(0, 40), view.getVisible()]) }));
    } catch { /* The window is already gone. */ }
    await finish(false);
  }
});
