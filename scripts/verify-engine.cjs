// Run after npm run build: electron scripts/verify-engine.cjs.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdirSync, mkdtempSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, session } = require('electron');

const runtime = resolve(__dirname, '../.runtime');
mkdirSync(runtime, { recursive: true });
const temporary = mkdtempSync(join(runtime, 'verify-engine-'));
app.setPath('userData', temporary);
app.setPath('sessionData', temporary);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP localhost 127.0.0.1');
app.on('window-all-closed', () => {});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64');
const seen = [], cookieHeaders = { sent: [], received: [] };
let origin, thirdParty, window, engine, controlEngine, cleaning = false, passed = 0, failed = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url, origin ?? 'http://127.0.0.1');
  seen.push({ path: url.pathname, query: url.searchParams, cookie: request.headers.cookie ?? '', host: request.headers.host });
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  if (url.pathname.startsWith('/cookie/')) {
    if (url.pathname === '/cookie/set') response.setHeader('Set-Cookie', 'engine_response=present; Path=/; SameSite=None; Secure');
    response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(pixel); return;
  }
  if (url.pathname === '/blocked-image.png' || url.pathname === '/favicon.ico') {
    response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(pixel); return;
  }
  if (url.pathname === '/download') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="engine-verification.txt"' });
    response.end('Horizon engine download fixture'); return;
  }
  if (url.pathname.startsWith('/observed/')) { response.writeHead(204); response.end(); return; }
  const title = url.pathname === '/second' ? 'Engine second page' : 'Engine fixture';
  const body = url.pathname === '/control' ? `<main style="height:3000px">
      <button id="control-button" class="control" style="top:40px" onclick="document.title='control clicked'">Control button</button>
      <input id="control-input" class="control" style="top:100px" aria-label="Control input" oninput="document.title='typed:'+this.value">
      <select id="control-select" class="control" style="top:160px" onchange="document.title='selected:'+this.value"><option value="first">First</option><option value="second">Second</option></select>
      <div id="control-pick" class="control" style="top:220px;background:steelblue">Pick this element</div>
      <section class="control" style="top:280px"><span style="display:inline-block;width:100px;height:40px">First sibling</span><span style="display:inline-block;width:100px;height:40px">Second sibling</span></section>
      <div class="id" id="actual" style="position:absolute;left:20px;top:340px;width:220px;height:40px">ID attribute fixture</div>
      <div id="id" class="control" style="top:400px">Unrelated ID</div>
      <div id="-" class="control" style="top:460px">Escaped ID fixture</div>
      </main><script>addEventListener('scroll', () => { document.title='scrolled:'+Math.round(scrollY); });</script>`
    : url.pathname === '/long' ? '<h1>Horizon accessibility fixture</h1><p>Engine needle appears here.</p><div style="height:3600px;background:linear-gradient(white,steelblue)"></div><p>Long page end</p>'
    : url.pathname === '/cookies' ? `<h1>Cookie fixture</h1><script>
      fetch('${thirdParty}/cookie/set', { credentials: 'include' }).then(() => fetch('${thirdParty}/cookie/echo', { credentials: 'include' })).then(() => fetch('/observed/cookies')).catch(() => fetch('/observed/cookie-error'));
      </script>`
    : `<h1>Horizon accessibility fixture</h1><p>Engine needle appears here.</p>
      <a class="control" style="top:100px" href="/opened-link" target="_blank">Open target</a>
      <button class="control" style="top:160px" onclick="window.open('/opened-button')">Open window</button>
      <a class="control" style="top:220px" href="/download" download>Download fixture</a>
      <button class="control" style="top:280px" onclick="navigator.geolocation.getCurrentPosition(() => fetch('/observed/permission?result=allowed'), error => fetch('/observed/permission?result=' + (error.code === 1 ? 'denied' : 'error')))">Request location</button>
      ${url.pathname === '/blocked' ? '<img src="/blocked-image.png" alt="Blocked fixture">' : ''}`;
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><link rel="icon" href="/favicon.ico"><style>body{margin:0;font:16px sans-serif}.control{position:absolute;left:20px;width:220px;height:40px;box-sizing:border-box}</style><body>${body}</body></html>`);
});

async function until(predicate, label, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await pause(40); }
  throw new Error('Verification timeout: ' + label);
}
async function check(label, run) {
  try { await run(); passed++; console.log('PASS ' + label); }
  catch (error) {
    failed++;
    const location = /verify-engine\.cjs:(\d+)/.exec(error?.stack ?? '')?.[1];
    const reason = error?.code === 'ERR_ASSERTION' ? 'assertion failed' : error instanceof Error && /^(Verification timeout:|READ_PAGE_|CONTROL_|ENGINE_|TAB_)/.test(error.message) ? error.message : 'unexpected condition: ' + String(error?.message ?? error).slice(0, 160);
    console.log('FAIL ' + label + ': ' + reason + (location ? ' at line ' + location : ''));
  }
}
function pngSize(bytes) {
  assert.ok(Buffer.isBuffer(bytes));
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
async function navigate(tab, path) {
  const url = origin + path;
  await tab.navigate(url);
  await until(() => tab.state.url === url && !tab.state.loading, path);
}
async function click(tab, y) {
  tab.view.webContents.sendInputEvent({ type: 'mouseMove', x: 80, y });
  tab.view.webContents.sendInputEvent({ type: 'mouseDown', x: 80, y, button: 'left', clickCount: 1 });
  tab.view.webContents.sendInputEvent({ type: 'mouseUp', x: 80, y, button: 'left', clickCount: 1 });
  await pause(80);
}
async function preparePick(tab) {
  const debug = tab.view.webContents.debugger, original = debug.sendCommand;
  let armed = false;
  debug.sendCommand = async (...args) => {
    const result = await original.apply(debug, args);
    if (args[0] === 'Overlay.setInspectMode' && args[1]?.mode === 'searchForNode') armed = true;
    return result;
  };
  const result = tab.control.pickElement();
  void result.catch(() => undefined);
  try { await until(() => armed, 'element inspect mode'); }
  finally { debug.sendCommand = original; }
  return { result };
}
async function pickedResult(promise) {
  let settled = false, result, error;
  void promise.then(value => { result = value; settled = true; }, reason => { error = reason; settled = true; });
  await until(() => settled, 'element pick result');
  if (error) throw error;
  return result;
}
async function inspectClick(tab, x, y) {
  const debug = tab.view.webContents.debugger;
  await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function assertPickedSelector(tab, result, expected) {
  assert.ok(result); const debug = tab.view.webContents.debugger;
  const { root } = await debug.sendCommand('DOM.getDocument');
  const actual = await debug.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: result.selector });
  const wanted = await debug.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: expected });
  assert.equal(actual.nodeIds.length, 1); assert.equal(wanted.nodeIds.length, 1);
  assert.deepEqual(actual.nodeIds, wanted.nodeIds);
}
function observeCookieHandlers(target) {
  const request = target.webRequest;
  for (const [method, outgoing] of [['onBeforeSendHeaders', true], ['onHeadersReceived', false]]) {
    const original = request[method].bind(request);
    request[method] = (...args) => {
      const last = args.length - 1, handler = args[last];
      if (typeof handler !== 'function') return original(...args);
      args[last] = (details, callback) => {
        const url = new URL(details.url);
        const probe = url.hostname === 'localhost' && url.pathname.startsWith('/cookie/');
        if (probe && outgoing) {
          // Chromium may reject third-party cookies first. Seed the boundary so this checks Horizon's handler too.
          details = { ...details, requestHeaders: { ...details.requestHeaders, Cookie: 'engine_probe=present' } };
        }
        handler(details, result => {
          if (probe) {
            const before = outgoing ? details.requestHeaders : details.responseHeaders;
            const after = outgoing ? result.requestHeaders : result.responseHeaders;
            cookieHeaders[outgoing ? 'sent' : 'received'].push({ path: url.pathname, before, after });
          }
          callback(result);
        });
      };
      return original(...args);
    };
  }
}
function hasHeader(headers, name) { return Object.keys(headers ?? {}).some(key => key.toLowerCase() === name); }
async function cleanup(code) {
  if (cleaning) return; cleaning = true;
  clearTimeout(watchdog);
  try { engine?.dispose(); } catch { /* A failed check may already have closed the engine. */ }
  try { controlEngine?.dispose(); } catch { /* A failed control check may already have closed the engine. */ }
  if (window && !window.isDestroyed()) window.destroy();
  server.closeAllConnections(); server.close();
  console.log(`Engine verification: ${passed} passed, ${failed} failed.`);
  app.exit(code);
}
const watchdog = setTimeout(() => { failed++; console.log('FAIL verifier deadline'); void cleanup(1); }, 120000);
process.on('uncaughtException', () => { failed++; console.log('FAIL uncaught verifier error'); void cleanup(1); });
process.on('unhandledRejection', () => { failed++; console.log('FAIL unhandled verifier rejection'); void cleanup(1); });

app.whenReady().then(async () => {
  const { createEngine, protectSession, blockedCount } = await import(pathToFileURL(resolve(__dirname, '../packages/engine/dist/index.js')).href);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  thirdParty = 'http://localhost:' + server.address().port;
  const target = session.fromPartition('verify-engine-' + Date.now());
  observeCookieHandlers(target);
  const baseline = { created: app.listenerCount('web-contents-created'), download: target.listenerCount('will-download') };
  const permissions = [], downloads = [], windows = [], navigations = [], changes = [];
  let consent = false;
  const protect = {
    dataDir: join(temporary, 'filters'), blockAds: true, blockThirdPartyCookies: true, privateMode: false,
    // Documented test hook: all list downloads stay in memory and never use a public endpoint.
    filterDownload: async url => url.endsWith('resources.json') ? JSON.stringify({ redirects: [], scriptlets: [] }) : '/blocked-image.png$image\n127.0.0.1##.engine-ad',
    permissions: async request => { permissions.push(request); return 'block'; },
    download: item => { downloads.push({ item, url: item.getURL(), state: undefined }); item.once('done', (_event, state) => { downloads.at(-1).state = state; }); return null; },
  };
  engine = createEngine({ session: target, protect, openWindow: details => { windows.push(details); }, consent: () => consent });
  const unsubscribeNavigate = engine.onNavigate(details => navigations.push(details));
  window = new BrowserWindow({ x: -3000, y: 0, width: 900, height: 700, show: false, skipTaskbar: true, focusable: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  // Input, find and visible capture need a painted window; it stays off screen so nothing covers the desktop.
  window.showInactive(); window.setPosition(-3000, 0);
  const tab = engine.openTab({ active: true });
  window.contentView.addChildView(tab.view); tab.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  tab.view.webContents.setBackgroundThrottling(false);
  const unsubscribeChange = tab.onChange(state => changes.push({ ...state }));

  await check('page control is undefined without the flag', async () => {
    assert.equal(tab.control, undefined); assert.equal(tab.view.webContents.debugger.isAttached(), false);
  });
  await check('navigation, state and secure preferences', async () => {
    await navigate(tab, '/first');
    await until(() => tab.state.title === 'Engine fixture', 'title');
    assert.equal(tab.state.secure, false); assert.ok(changes.length > 0);
    assert.ok(navigations.some(event => event.tabId === tab.id && event.url === origin + '/first'));
    const preferences = tab.view.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.webviewTag, false); assert.ok(!preferences.preload);
  });
  await check('back navigation', async () => {
    await navigate(tab, '/second'); assert.equal(tab.state.canGoBack, true);
    await tab.back(); await until(() => tab.state.url === origin + '/first' && !tab.state.loading, 'back');
    assert.equal(tab.state.canGoForward, true);
  });
  await check('forward navigation', async () => {
    await tab.forward(); await until(() => tab.state.url === origin + '/second' && !tab.state.loading, 'forward');
    assert.equal(tab.state.canGoForward, false);
  });
  await check('fixed filter list blocks a request', async () => {
    await until(() => existsSync(join(protect.dataDir, 'adblock/engines.bin')), 'filter initialization');
    await navigate(tab, '/blocked');
    await until(() => blockedCount(tab.view.webContents) > 0, 'blocked count');
    assert.ok(tab.state.blocked > 0);
    assert.equal(seen.some(request => request.path === '/blocked-image.png'), false);
  });
  await check('main-frame navigation resets blocked count', async () => {
    await navigate(tab, '/first'); assert.equal(blockedCount(tab.view.webContents), 0); assert.equal(tab.state.blocked, 0);
  });
  await check('third-party request cookie stripped by protection', async () => {
    await target.cookies.set({ url: thirdParty, name: 'engine_seed', value: 'present', path: '/' });
    await navigate(tab, '/cookies');
    await until(() => seen.some(request => request.path === '/observed/cookies'), 'cookie fixture');
    const outgoing = cookieHeaders.sent.find(request => request.path === '/cookie/echo');
    assert.ok(outgoing); assert.equal(hasHeader(outgoing.before, 'cookie'), true); assert.equal(hasHeader(outgoing.after, 'cookie'), false);
    assert.ok(seen.some(request => request.path === '/cookie/echo' && request.host.startsWith('localhost:') && request.cookie === ''));
  });
  await check('third-party response cookie stripped by protection', async () => {
    const incoming = cookieHeaders.received.find(request => request.path === '/cookie/set');
    assert.ok(incoming); assert.equal(hasHeader(incoming.before, 'set-cookie'), true); assert.equal(hasHeader(incoming.after, 'set-cookie'), false);
    assert.equal((await target.cookies.get({ url: thirdParty, name: 'engine_response' })).length, 0);
  });
  await check('permission reaches host and page receives denial', async () => {
    await navigate(tab, '/first'); await click(tab, 300);
    await until(() => permissions.some(request => request.permission === 'geolocation'), 'permission host');
    await until(() => seen.some(request => request.path === '/observed/permission' && request.query.get('result') === 'denied'), 'permission denied');
  });
  await check('download reaches host and null cancels', async () => {
    await click(tab, 240);
    await until(() => downloads.some(download => download.url === origin + '/download'), 'download host');
    await until(() => downloads.some(download => download.state === 'cancelled' || download.item.isDestroyed?.()), 'download cancellation');
  });
  await check('target blank routes to host without another window', async () => {
    await click(tab, 120); await until(() => windows.some(details => details.url === origin + '/opened-link'), 'target blank');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
  });
  await check('window.open routes to host without another window', async () => {
    await click(tab, 180); await until(() => windows.some(details => details.url === origin + '/opened-button'), 'window.open');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
  });
  await check('find returns a match', async () => {
    const result = await tab.find('Engine needle');
    assert.ok(result.matches > 0); tab.stopFind();
  });
  await check('zoom applies to web contents', async () => {
    tab.zoom(1.25); assert.equal(tab.view.webContents.getZoomFactor(), 1.25); tab.zoom(1);
  });
  let visible;
  await check('visible capture returns PNG', async () => {
    await navigate(tab, '/long'); await pause(200);
    visible = pngSize(await engine.capture(tab, { fullPage: false })); assert.ok(visible.width > 0 && visible.height > 0);
  });
  await check('full-page capture is taller and detaches debugger', async () => {
    const full = pngSize(await engine.capture(tab, { fullPage: true }));
    assert.ok(full.height > (visible?.height ?? 600)); assert.ok(full.height >= 3600);
    assert.equal(tab.view.webContents.debugger.isAttached(), false);
  });
  await check('readPage refuses absent consent', async () => {
    await assert.rejects(engine.readPage(tab), { message: 'READ_PAGE_CONSENT' });
    assert.equal(tab.view.webContents.debugger.isAttached(), false);
  });
  await check('readPage returns accessibility text with consent', async () => {
    consent = true; const text = await engine.readPage(tab); assert.ok(text.includes('Horizon accessibility fixture'));
    assert.equal(tab.view.webContents.debugger.isAttached(), false);
  });
  await check('main-frame load failure updates error and next load clears it', async () => {
    const closed = createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
    const url = `http://127.0.0.1:${port}/unreachable`;
    await tab.navigate(url).catch(() => undefined);
    await until(() => !!tab.state.error, 'failed load');
    assert.equal(tab.state.error.url, url); assert.ok(tab.state.error.code < 0); assert.ok(tab.state.error.description);
    await navigate(tab, '/first'); assert.ok(!tab.state.error);
  });
  await check('restored tab keeps backward and forward history', async () => {
    await navigate(tab, '/second'); await tab.back(); await until(() => tab.state.url === origin + '/first' && !tab.state.loading, 'history back');
    const saved = tab.history(); assert.ok(saved.entries.length >= 2);
    const restored = engine.openTab({ restore: saved, active: false });
    window.contentView.addChildView(restored.view); restored.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    await until(() => restored.state.url === origin + '/first' && !restored.state.loading, 'restore');
    assert.deepEqual(restored.history().entries.map(entry => entry.url), saved.entries.map(entry => entry.url));
    assert.equal(restored.history().index, saved.index); assert.equal(restored.state.canGoBack, true); assert.equal(restored.state.canGoForward, true);
    restored.close();
  });
  await check('dispose closes tabs and releases protection handlers', async () => {
    unsubscribeChange(); unsubscribeNavigate();
    const contents = tab.view.webContents; engine.dispose();
    await until(() => contents.isDestroyed(), 'tab destroyed');
    assert.equal(app.listenerCount('web-contents-created'), baseline.created);
    assert.equal(target.listenerCount('will-download'), baseline.download);
    const again = protectSession(target, { ...protect, blockAds: false }); again.dispose();
    assert.equal(app.listenerCount('web-contents-created'), baseline.created);
    assert.equal(target.listenerCount('will-download'), baseline.download);
  });
  const controlSession = session.fromPartition('verify-engine-control-' + Date.now());
  const controlProtect = { dataDir: join(temporary, 'control-filters'), blockAds: false, blockThirdPartyCookies: false };
  await check('all page control methods refuse a missing consent callback', async () => {
    const denied = createEngine({ session: controlSession, protect: controlProtect, pageControl: true });
    try {
      const deniedTab = denied.openTab(); await navigate(deniedTab, '/control');
      const control = deniedTab.control;
      for (const action of [() => control.click({ selector: '#control-button' }), () => control.type({ selector: '#control-input' }, 'Denied'),
        () => control.select({ selector: '#control-select' }, 'second'), () => control.scroll({ deltaY: 100 }),
        () => control.pickElement(), () => control.cancelPick(), () => control.release()]) {
        await assert.rejects(action(), { message: 'CONTROL_CONSENT' });
      }
      assert.equal(deniedTab.view.webContents.debugger.isAttached(), false);
    } finally { denied.dispose(); }
  });
  let controlConsent = false;
  const consentRequests = [];
  controlEngine = createEngine({ session: controlSession, protect: controlProtect, pageControl: true,
    consent: (url, purpose) => { consentRequests.push({ url, purpose }); return controlConsent; } });
  const controlTab = controlEngine.openTab({ active: true });
  window.contentView.addChildView(controlTab.view); controlTab.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  controlTab.view.webContents.setBackgroundThrottling(false);
  await navigate(controlTab, '/control');
  const debug = controlTab.view.webContents.debugger;
  await check('page control click refuses denied consent without attaching', async () => {
    await assert.rejects(controlTab.control.click({ selector: '#control-button' }), { message: 'CONTROL_CONSENT' });
    assert.equal(debug.isAttached(), false);
    assert.deepEqual(consentRequests.at(-1), { url: origin + '/control', purpose: 'control' });
  });
  controlConsent = true;
  await check('page control selector click changes tab title', async () => {
    await controlTab.control.click({ selector: '#control-button' });
    await until(() => controlTab.state.title === 'control clicked', 'control click title');
  });
  await check('page control missing selector reports target not found', async () => {
    await assert.rejects(controlTab.control.click({ selector: '#missing-control' }), { message: 'CONTROL_TARGET_NOT_FOUND' });
  });
  await check('page control selector typing changes input and title', async () => {
    await controlTab.control.type({ selector: '#control-input' }, 'Horizon');
    await until(() => controlTab.state.title === 'typed:Horizon', 'control type title');
  });
  await check('page control point typing focuses the input', async () => {
    await navigate(controlTab, '/control?point'); await pause(120);
    await controlTab.control.type({ x: 80, y: 120 }, 'Point');
    await until(() => controlTab.state.title === 'typed:Point', 'control point type title');
  });
  await check('page control selects an option and dispatches change', async () => {
    const original = debug.sendCommand, commands = [];
    debug.sendCommand = async (...args) => {
      const result = await original.apply(debug, args); commands.push({ method: args[0], params: args[1], result }); return result;
    };
    try { await controlTab.control.select({ selector: '#control-select' }, 'second'); }
    finally { debug.sendCommand = original; }
    await until(() => controlTab.state.title === 'selected:second', 'control select title');
    const world = commands.find(command => command.method === 'Page.createIsolatedWorld');
    const resolved = commands.find(command => command.method === 'DOM.resolveNode');
    const call = commands.find(command => command.method === 'Runtime.callFunctionOn');
    assert.equal(world?.params.worldName, 'horizon-engine-control');
    assert.ok(Number.isInteger(world?.result.executionContextId));
    assert.equal(resolved?.params.executionContextId, world.result.executionContextId);
    assert.ok(resolved?.result.object.objectId);
    assert.equal(call?.params.objectId, resolved.result.object.objectId);
    assert.equal(commands.some(command => command.method === 'Runtime.evaluate'), false);
  });
  await check('page control select rejects another element', async () => {
    await assert.rejects(controlTab.control.select({ selector: '#control-button' }, 'second'), { message: 'CONTROL_NOT_SELECT' });
  });
  await check('page control wheel scroll moves the page', async () => {
    await controlTab.control.scroll({ deltaY: 400 });
    await until(() => /^scrolled:\d+$/.test(controlTab.state.title) && Number(controlTab.state.title.split(':')[1]) > 0, 'control scroll title');
  });
  await check('page control picks an element with selector, box and cropped PNG', async () => {
    await navigate(controlTab, '/control'); await pause(120);
    const pick = await preparePick(controlTab);
    await inspectClick(controlTab, 80, 240);
    const result = await pickedResult(pick.result);
    assert.ok(result); assert.equal(result.selector, '#control-pick');
    assert.equal(Math.round(result.box.x), 20); assert.equal(Math.round(result.box.y), 220);
    assert.equal(Math.round(result.box.width), 220); assert.equal(Math.round(result.box.height), 40);
    // The crop is in device pixels, so it keeps the box's proportions at the display's scale.
    const size = pngSize(result.image); assert.ok(size.width >= 220 && Math.abs(size.width / size.height - 5.5) < 0.2);
  });
  await check('page control cancelPick resolves null', async () => {
    const pick = await preparePick(controlTab); await controlTab.control.cancelPick();
    assert.equal(await pickedResult(pick.result), null);
  });
  await check('page control picks a unique nth-of-type selector without an ID', async () => {
    const pick = await preparePick(controlTab); await inspectClick(controlTab, 160, 300);
    const result = await pickedResult(pick.result);
    assert.ok(result?.selector.includes(':nth-of-type('));
    await assertPickedSelector(controlTab, result, 'section > span:nth-of-type(2)');
  });
  await check('page control picking distinguishes an ID attribute from an attribute value', async () => {
    const pick = await preparePick(controlTab); await inspectClick(controlTab, 80, 360);
    const result = await pickedResult(pick.result); assert.equal(result?.selector, '#actual');
    await assertPickedSelector(controlTab, result, '#actual');
  });
  await check('page control picking escapes a single-hyphen ID', async () => {
    const pick = await preparePick(controlTab); await inspectClick(controlTab, 80, 480);
    await assertPickedSelector(controlTab, await pickedResult(pick.result), '[id="-"]');
  });
  await check('page control cancelPick cancels a pick during element description', async () => {
    const pick = await preparePick(controlTab), original = debug.sendCommand;
    let describing = false, unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    debug.sendCommand = async (...args) => {
      if (args[0] === 'DOM.getDocument' && args[1]?.depth === -1) { describing = true; await gate; }
      return original.apply(debug, args);
    };
    try {
      await inspectClick(controlTab, 80, 240); await until(() => describing, 'picked element description');
      const canceled = controlTab.control.cancelPick();
      await pause(0); unblock(); await canceled;
      assert.equal(await pickedResult(pick.result), null);
    } finally { unblock(); debug.sendCommand = original; }
  });
  await check('page control Escape resolves pick as null', async () => {
    const pick = await preparePick(controlTab);
    controlTab.view.webContents.focus();
    controlTab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    controlTab.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    assert.equal(await pickedResult(pick.result), null);
  });
  await check('page control release detaches its debugger', async () => {
    await controlTab.control.click({ selector: '#control-button' }); assert.equal(debug.isAttached(), true);
    await controlTab.control.release(); assert.equal(debug.isAttached(), false);
  });
  await check('page control release preserves the host debugger attachment', async () => {
    debug.attach('1.3');
    try {
      await controlTab.control.click({ selector: '#control-button' }); await controlTab.control.release();
      assert.equal(debug.isAttached(), true);
    } finally { if (debug.isAttached()) debug.detach(); }
  });
  await check('page control read consent identifies the read purpose', async () => {
    await controlEngine.readPage(controlTab);
    assert.deepEqual(consentRequests.at(-1), { url: origin + '/control', purpose: 'read' });
    assert.equal(debug.isAttached(), false);
  });
  await check('closing a page control tab cancels its pending pick', async () => {
    const contents = controlTab.view.webContents, pick = await preparePick(controlTab); controlTab.close();
    assert.equal(await pickedResult(pick.result), null);
    await until(() => contents.isDestroyed(), 'control tab destroyed');
  });
  controlEngine.dispose();
  await cleanup(failed ? 1 : 0);
}).catch(() => { failed++; console.log('FAIL verifier setup'); void cleanup(1); });
