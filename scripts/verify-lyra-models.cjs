// Run after npm run build: ./node_modules/.bin/electron.cmd scripts/verify-lyra-models.cjs
// The fixture is a local HTTP service. It never starts Lyra, Ollama, or a model install.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { app } = require('electron');

const name = `lyra-models-${randomUUID()}`;
const root = resolve(__dirname, '..', '.runtime', name);
const home = join(root, 'lyra');
const screenshots = join(root, 'screenshots');
mkdirSync(join(home, 'run'), { recursive: true });
mkdirSync(join(home, 'secrets'), { recursive: true });
mkdirSync(screenshots, { recursive: true });
process.env.HORIZON_RUNTIME_DIRECTORY = name;
process.env.LYRA_HOME = home;

const serviceVersion = 'fixture';
const bootstrap = randomBytes(32).toString('base64url');
assert.equal(bootstrap.length, 43);
const issued = new Set();
const requests = [];
const violations = [];
const sockets = new Set();
const fixture = { fastReady: false, deepReady: false, completionReady: false, appMissing: false };
const allowed = new Set(['GET /v1/health', 'POST /v1/apps/register', 'GET /v1/models', 'POST /v1/app/open', 'POST /v1/ollama/start']);

function modelsPayload() {
  return {
    ready: fixture.fastReady,
    ollama: { installed: true, running: true, version: '0.0.0-fixture' },
    modes: {
      fast: { model: 'lyra-base', ready: fixture.fastReady },
      normal: { model: 'lyra-base', ready: true },
      thinking: { model: 'lyra-thinking', ready: true },
      deep: { model: 'lyra-deep', ready: fixture.deepReady },
    },
    completion: { model: 'qwen2.5-coder:1.5b-base', ready: fixture.completionReady, bytes: 1 },
    installed: ['lyra-base'],
    plans: { light: { fits: true } },
  };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
  response.end(payload);
}

function authorization(request) {
  return Array.isArray(request.headers.authorization) ? '' : request.headers.authorization ?? '';
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const method = request.method ?? 'GET';
  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > 65536) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', () => {
    let body;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) { try { body = JSON.parse(raw); } catch { body = null; } }
    const route = `${method} ${path}`;
    if (!allowed.has(route) || path.includes('install')) {
      violations.push(route);
      json(response, 404, { error: { code: 'forbidden', message: 'unexpected' } });
      return;
    }
    requests.push({ method, path, body });
    if (route === 'GET /v1/health') { json(response, 200, { ok: true, serviceVersion }); return; }
    if (route === 'POST /v1/apps/register') {
      if (authorization(request) !== `Bootstrap ${bootstrap}`) { json(response, 401, { error: { code: 'unauthorized', message: 'unauthorized' } }); return; }
      const token = randomBytes(32).toString('base64url');
      issued.add(token);
      json(response, 200, { app: { id: 'horizon' }, token });
      return;
    }
    const presented = authorization(request).startsWith('Bearer ') ? authorization(request).slice('Bearer '.length) : '';
    if (!issued.has(presented)) { json(response, 401, { error: { code: 'unauthorized', message: 'unauthorized' } }); return; }
    if (route === 'GET /v1/models') { json(response, 200, modelsPayload()); return; }
    if (route === 'POST /v1/app/open') {
      if (fixture.appMissing) json(response, 409, { error: { code: 'app_missing', message: 'app_missing' } });
      else json(response, 202, { opened: true });
      return;
    }
    json(response, 200, { running: true, version: '0.0.0-fixture' });
  });
});

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', root);
app.setPath('sessionData', root);
app.setPath('crashDumps', join(root, 'crashes'));
app.setAppLogsPath(join(root, 'logs'));

let window, settled = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = code => window.webContents.executeJavaScript(code);
const command = value => chrome(`window.horizon.command(${JSON.stringify(value)})`);
const state = () => chrome('window.horizon.getState()');
async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await state(); if (predicate(value)) return value; await pause(50); }
  throw new Error('Verification timeout: ' + label);
}
async function failed(code) {
  return until(value => {
    if (value.lyra.phase === 'failed' && value.lyra.error !== code) throw new Error('Lyra state: ' + value.lyra.error);
    return value.lyra.open && value.lyra.phase === 'failed' && value.lyra.error === code;
  }, code);
}
async function screenshot(file) {
  const desired = (await state()).lyra.phase, deadline = Date.now() + 10000;
  while (!await chrome(`Boolean(document.querySelector('.lyra-panel[data-phase="${desired}"]'))`)) {
    if (Date.now() > deadline) throw new Error('Screenshot screen did not render: ' + file);
    await pause(50);
  }
  await chrome('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await pause(200);
  const proportions = await chrome(`(() => {
    const panel = document.querySelector('.lyra-panel');
    if (!panel) return null;
    return { overflow: panel.scrollWidth > panel.clientWidth + 1, width: panel.getBoundingClientRect().width };
  })()`);
  assert.ok(proportions);
  assert.equal(proportions.overflow, false);
  assert.ok(Math.abs(proportions.width - 400) < 1, `panel width ${proportions.width}`);
  const path = join(screenshots, file + '.png');
  writeFileSync(path, (await window.webContents.capturePage()).toPNG());
  console.log(path);
}
async function showFace(language, theme, contrast) {
  await command({ type: 'set-language', value: language });
  await command({ type: 'theme', value: theme });
  await command({ type: 'contrast', value: contrast });
  await until(value => value.language === language, language);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await chrome(`document.documentElement.dataset.theme === ${JSON.stringify(theme)} && document.documentElement.dataset.contrast === ${JSON.stringify(contrast)}`)) return;
    await pause(50);
  }
  throw new Error(`Appearance did not apply: ${language} ${theme} ${contrast}`);
}
async function clickPrimary() {
  const clicked = await chrome(`(() => {
    const button = document.querySelector('.lyra-panel .desktop-feedback .desktop-action.primary');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true);
}
async function clickRetry() {
  const clicked = await chrome(`(() => {
    const button = [...document.querySelectorAll('.lyra-panel .desktop-feedback .desktop-action')].find(entry => !entry.classList.contains('primary'));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true);
}
async function assertQuiet() {
  const quiet = await chrome(`(() => {
    const panel = document.querySelector('.lyra-panel');
    if (!panel) return false;
    const progress = Boolean(panel.querySelector('progress'));
    const install = [...panel.querySelectorAll('button')].some(button => /install/i.test(button.textContent ?? ''));
    return !progress && !install;
  })()`);
  assert.equal(quiet, true);
  assert.equal((await state()).services.dialog, null);
}
function assertOpen(slice) {
  const openAt = slice.findIndex(entry => entry.method === 'POST' && entry.path === '/v1/app/open');
  assert.ok(openAt >= 0);
  assert.deepEqual(slice[openAt].body, { section: 'models' });
  assert.equal(slice.filter(entry => entry.path === '/v1/app/open').length, 1);
  assert.equal(violations.length, 0);
}
async function cleanup(code) {
  if (settled) return;
  settled = true;
  clearTimeout(watchdog);
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  app.exit(code);
}
const watchdog = setTimeout(() => { console.error('Lyra model verification timed out. Artifacts: ' + root); void cleanup(1); }, 120000);
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created;
  // The window stays hidden so this check does not take focus, and it still paints for the captures.
  created.show = () => {}; created.showInactive = () => {}; created.focus = () => {};
  created.webContents.setBackgroundThrottling(false);
  created.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  created.webContents.once('did-finish-load', async () => {
    try {
      await until(value => value.tabs.length > 0, 'chrome ready');
      await command({ type: 'finish-first-run' });
      await showFace('en', 'amber', 'standard');
      await command({ type: 'dark-pages', value: 'off' });
      await command({ type: 'lyra-open' });
      let current = await failed('model_missing');
      assert.equal(current.lyra.sources.length, 0);
      await assertQuiet();
      const focused = await chrome(`(() => {
        const button = document.querySelector('.lyra-panel .desktop-feedback .desktop-action.primary');
        if (!(button instanceof HTMLButtonElement) || button.disabled) return '';
        button.focus();
        return document.activeElement === button ? button.textContent : '';
      })()`);
      assert.match(focused, /Open Lyra/);
      let mark = requests.length;
      await clickPrimary();
      await until(() => requests.length > mark, 'models open request');
      current = await failed('model_missing');
      const opened = requests.slice(mark);
      assertOpen(opened);
      assert.ok(opened.slice(opened.findIndex(entry => entry.path === '/v1/app/open') + 1).some(entry => entry.method === 'GET' && entry.path === '/v1/models'));
      assert.equal(current.lyra.error, 'model_missing');
      assert.equal(fixture.fastReady, false);
      await assertQuiet();
      fixture.fastReady = true;
      mark = requests.length;
      await clickRetry();
      current = await until(value => {
        if (value.lyra.phase === 'failed') throw new Error('Lyra state: ' + value.lyra.error);
        return requests.length > mark && value.lyra.phase === 'home';
      }, 'home');
      assert.equal(current.lyra.phase, 'home');
      assert.equal(fixture.deepReady, false);
      assert.equal(fixture.completionReady, false);
      fixture.fastReady = false;
      await command({ type: 'lyra-home' });
      await failed('model_missing');
      for (const language of ['en', 'es']) {
        for (const theme of ['amber', 'daylight']) {
          for (const contrast of ['standard', 'high']) {
            await showFace(language, theme, contrast);
            const openLabel = language === 'es' ? 'Abrir Lyra' : 'Open Lyra';
            const retryLabel = language === 'es' ? 'Volver a intentar' : 'Try again';
            const labels = await chrome(`(() => [...document.querySelectorAll('.lyra-panel .desktop-feedback button')].map(button => button.textContent))()`);
            assert.ok(labels.some(label => label.includes(openLabel)));
            assert.ok(labels.some(label => label.includes(retryLabel)));
            await assertQuiet();
            await screenshot(`missing-${language}-${theme}-${contrast}`);
          }
        }
      }
      fixture.appMissing = true;
      mark = requests.length;
      await clickPrimary();
      current = await until(value => requests.length > mark && value.lyra.open && value.lyra.phase === 'failed' && value.lyra.error === 'app_missing', 'app missing');
      const refused = requests.slice(mark);
      assertOpen(refused);
      assert.equal(refused.filter(entry => entry.path === '/v1/models').length, 0);
      for (const language of ['en', 'es']) {
        const sentence = language === 'es'
          ? 'La app de Lyra no está instalada. Ejecutar lyra models en una terminal.'
          : 'The Lyra app is not installed. Run lyra models in a terminal.';
        for (const theme of ['amber', 'daylight']) {
          for (const contrast of ['standard', 'high']) {
            await showFace(language, theme, contrast);
            const text = await chrome(`document.querySelector('.lyra-panel [role=alert] p')?.textContent ?? ''`);
            assert.equal(text, sentence);
            assert.match(text, /lyra models/);
            await assertQuiet();
            await screenshot(`fallback-${language}-${theme}-${contrast}`);
          }
        }
      }
      const closed = await chrome(`(() => {
        const panel = document.querySelector('.lyra-panel');
        if (!panel) return false;
        panel.focus();
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return true;
      })()`);
      assert.equal(closed, true);
      await until(value => value.lyra.open === false, 'panel closed');
      assert.equal(await chrome('!document.querySelector(".lyra-panel")'), true);
      assert.equal(violations.length, 0);
      const tally = {};
      for (const entry of requests) { const key = `${entry.method} ${entry.path}`; tally[key] = (tally[key] ?? 0) + 1; }
      console.log('Lyra synthetic requests: ' + JSON.stringify(tally));
      console.log('Lyra synthetic model verification passed. Artifacts: ' + root);
      await cleanup(0);
    } catch (error) {
      console.error('Lyra model verification failed: ' + (error instanceof Error ? error.message : 'unknown condition') + '. Artifacts: ' + root);
      await cleanup(1);
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  try {
    const address = server.address();
    if (!address || typeof address === 'string' || address.port < 1024) throw new Error('Fixture port is not usable');
    // The pid only makes the announcement parse. This check never signals a process.
    writeFileSync(join(home, 'run', 'service.json'), JSON.stringify({ version: 1, pid: 1, port: address.port, serviceVersion, startedAt: new Date().toISOString() }));
    writeFileSync(join(home, 'secrets', 'bootstrap.key'), bootstrap, { mode: 0o600 });
    require('../dist/electron/main.js');
  } catch (error) {
    console.error('Lyra model verification failed: ' + (error instanceof Error ? error.message : 'unknown condition') + '. Artifacts: ' + root);
    void cleanup(1);
  }
});
