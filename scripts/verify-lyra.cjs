// Run after npm run build: electron scripts/verify-lyra.cjs.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { app } = require('electron');

const root = mkdtempSync(join(tmpdir(), 'horizon-lyra-'));
const home = join(root, 'lyra'), data = join(root, 'horizon'), screenshots = join(root, 'screenshots');
for (const directory of [home, data, screenshots]) mkdirSync(directory, { recursive: true });
process.env.LYRA_HOME = home;
const lyraRepo = resolve(__dirname, '../../Lyra');
// The CLI writes only install.json into the temporary home; Lyra's repository is read-only here.
execFileSync(process.env.HORIZON_VERIFY_NODE || 'node', [join(lyraRepo, 'packages/cli/src/main.ts'), 'dev-install'], {
  cwd: lyraRepo, env: { ...process.env, LYRA_HOME: home }, windowsHide: true, stdio: 'ignore', timeout: 30000,
});
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
let syntheticMissing = false, connectedTemporaryService = false, window;
const lyraModule = require('../dist/electron/lyra.js'), createLyra = lyraModule.createLyra;
lyraModule.createLyra = host => createLyra({ ...host, connect: async () => {
  const connected = await host.connect();
  if (process.env.LYRA_HOME === home) connectedTemporaryService = true;
  if (!syntheticMissing) return connected;
  return { ...connected, models: { ...connected.models, status: async () => {
    const status = await connected.models.status();
    return { ...status, ready: false, modes: { ...status.modes, fast: { ...status.modes.fast, ready: false } } };
  } } };
} });
const pages = {
  '/routes': '<!doctype html><title>Rutas del Sur</title><h1>Patagonia road plan</h1><p>Route 40 has three gravel sections. The longest is 70 km. Drive by day. Fuel stations can be more than 200 km apart. Fill up in each town.</p>',
  '/inn': '<!doctype html><title>Lago Azul Inn</title><h1>Patagonia lodging</h1><p>Lago Azul Inn offers a base beside the lake. A room costs 80 dollars per night. The booking covers one night. Book a second night before heading north.</p>',
};
const server = createServer((request, response) => {
  response.writeHead(pages[request.url] ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(pages[request.url] ?? 'Not found');
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = code => window.webContents.executeJavaScript(code);
const command = value => chrome(`window.horizon.command(${JSON.stringify(value)})`);
const state = () => chrome('window.horizon.getState()');
async function until(predicate, label, timeout = 140000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await state(); if (predicate(value)) return value; await pause(100); }
  throw new Error('Verification timeout: ' + label);
}
async function phase(name) {
  return until(value => {
    if (value.lyra.phase === 'failed' && name !== 'failed') throw new Error('Lyra state: ' + value.lyra.error);
    return value.lyra.phase === name;
  }, name);
}
async function screenshot(name) {
  const desired = (await state()).lyra.phase, deadline = Date.now() + 10000;
  while (!await chrome(`Boolean(document.querySelector('.lyra-panel[data-phase="${desired}"]') || document.querySelector('.desktop-panel:not(.lyra-panel) .desktop-project-heading'))`)) {
    if (Date.now() > deadline) throw new Error('Screenshot screen did not render: ' + name);
    await pause(50);
  }
  await chrome('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await pause(200);
  const proportions = await chrome(`(() => {
    const panel = document.querySelector('.lyra-panel'), body = panel?.querySelector('.lyra-body');
    if (!panel) return null;
    const gap = getComputedStyle(body).gap, width = panel.getBoundingClientRect().width;
    const header = panel.querySelector('.desktop-panel-header');
    return { width, padding: getComputedStyle(header).marginInlineStart, gap, overflow: panel.scrollWidth > panel.clientWidth + 1 };
  })()`);
  if (proportions) { assert.equal(proportions.overflow, false); assert.ok(Math.abs(proportions.width - 400) < 1); assert.equal(proportions.padding, '20px'); assert.equal(proportions.gap, '16px'); }
  const path = join(screenshots, name + '.png'); writeFileSync(path, (await window.webContents.capturePage()).toPNG()); console.log(path);
}
async function ask(task, tabs, question) {
  await command({ type: 'lyra-ask', task, tabs, question, project: null, item: null });
}
async function rendered(selector) {
  const deadline = Date.now() + 10000;
  while (!await chrome(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
    if (Date.now() > deadline) throw new Error('Lyra control did not render');
    await pause(50);
  }
}
async function cleanup(code) {
  clearTimeout(watchdog);
  // Only this temporary service is put to sleep; the person's shared installation is untouched.
  if (connectedTemporaryService) try {
    execFileSync(process.env.HORIZON_VERIFY_NODE || 'node', [join(lyraRepo, 'packages/cli/src/main.ts'), 'unfocus'], {
      cwd: lyraRepo, env: { ...process.env, LYRA_HOME: home }, windowsHide: true, stdio: 'ignore', timeout: 15000,
    });
  } catch { /* A failed service may already be asleep. */ }
  // A service that ignored unfocus would keep this script's output pipe open; stop the temporary one by its run file.
  try { const run = JSON.parse(require('node:fs').readFileSync(join(home, 'run', 'service.json'), 'utf8')); if (Number.isSafeInteger(run.pid)) process.kill(run.pid); } catch { /* No run file means the service already stopped. */ }
  server.close(); app.exit(code);
}
const watchdog = setTimeout(() => { console.error('Lyra verification timed out. Artifacts: ' + root); void cleanup(1); }, 10 * 60 * 1000);
app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created; created.setBounds({ x: -20000, y: 0, width: 1440, height: 900 });
  created.webContents.once('did-finish-load', async () => {
    try {
      await until(value => value.tabs.length > 0, 'chrome ready');
      await command({ type: 'finish-first-run' }); await command({ type: 'set-language', value: 'en' });
      await command({ type: 'theme', value: 'amber' }); await command({ type: 'dark-pages', value: 'off' });
      // Keep the board's 1440 by 900 CSS frame for proportion checks and screenshots.
      window.webContents.setZoomFactor(1);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port;
      await command({ type: 'navigate', input: origin + '/routes' });
      let current = await until(value => value.tabs.some(tab => tab.url === origin + '/routes' && !tab.loading), 'first page');
      const first = current.activeId;
      await command({ type: 'new-tab', input: origin + '/inn' });
      current = await until(value => value.tabs.some(tab => tab.url === origin + '/inn' && !tab.loading), 'second page');
      const second = current.activeId;
      await command({ type: 'activate-tab', id: first });
      await command({ type: 'create-project', name: 'Lyra verification' }); const project = (await state()).projectInUse;
      await command({ type: 'lyra-open' }); await phase('home'); await screenshot('home');
      await ask('summary', [first], 'Summarise this page'); current = await phase('permission'); await screenshot('permission');
      const prompt = current.lyra.permission;
      assert.equal(prompt.origin, origin);
      // Press the real permission control in trusted chrome, never execute a script in a web page.
      await chrome('document.querySelector("[data-lyra-allow]").click()');
      current = await phase('answer'); assert.match(current.lyra.answer, /70|200|gravel|fuel/i); assert.equal(current.lyra.sources.length, 1); await screenshot('summary');
      const summary = current.lyra.answer;
      await command({ type: 'lyra-save', project });
      let saved = await chrome(`window.horizon.getProject(${JSON.stringify(project)})`);
      assert.ok(saved.items.some(item => item.kind === 'note' && item.text.includes(summary)));
      assert.ok(saved.items.some(item => item.source?.url === origin + '/routes'));
      assert.ok((await state()).desktopPanel.open);
      // The persisted site permission, rather than a UI flag, survives a fresh store read.
      const { profileStorePath } = require('../dist/electron/profiles.js'), { readStore } = require('../dist/electron/store.js');
      const { safeStorage } = require('electron');
      const stored = readStore(profileStorePath(data, (await state()).activeProfileId), safeStorage);
      assert.equal(stored.siteSettings.permissions.find(entry => entry.origin === origin).lyra, 'allow');
      await command({ type: 'lyra-open' });
      await ask('comparison', [first, second], 'Compare these two pages');
      current = await until(value => {
        assert.notEqual(value.lyra.phase, 'permission', 'The remembered origin must not prompt again');
        if (value.lyra.phase === 'failed') throw new Error('Comparison failed: ' + value.lyra.error);
        return value.lyra.phase === 'answer';
      }, 'comparison');
      assert.equal(current.lyra.sources.length, 2); assert.ok(current.lyra.answer.trim()); await screenshot('comparison');
      assert.match(current.lyra.answer, /fuel|gravel|route/i); assert.match(current.lyra.answer, /inn|room|night|booking|80/i);
      const comparison = current.lyra.answer; await command({ type: 'lyra-save', project });
      saved = await chrome(`window.horizon.getProject(${JSON.stringify(project)})`);
      const notes = saved.items.filter(item => item.kind === 'note'); assert.equal(notes.length, 2);
      const keptComparison = notes.find(item => item.text.includes(comparison));
      for (const path of ['/routes', '/inn']) assert.ok(keptComparison.text.includes(origin + path));
      await screenshot('saved');
      assert.ok(readFileSync(join(data, 'lyra.token')).subarray(0, 15).equals(Buffer.from('HORIZON-LYRA-1\n')));
      await command({ type: 'lyra-open' });
      await rendered('.lyra-panel button[title="Open in a tab"]');
      await chrome('document.querySelector(".lyra-panel button[title=\\"Open in a tab\\"]").click()');
      current = await until(value => value.tabs.find(tab => tab.id === value.activeId)?.url === 'horizon://lyra', 'Lyra tab');
      assert.equal(current.lyra.answer, comparison); assert.equal(current.lyra.sources.length, 2);
      await command({ type: 'activate-tab', id: first });
      syntheticMissing = true; await command({ type: 'lyra-home' }); current = await phase('failed'); assert.equal(current.lyra.error, 'model_missing'); await screenshot('missing');
      assert.ok(await chrome('Boolean([...document.querySelectorAll(".lyra-panel button")].find(button => button.textContent.includes("Install the local model")))'));
      syntheticMissing = false;
      const unavailable = join(root, 'unavailable'); mkdirSync(unavailable);
      writeFileSync(join(unavailable, 'install.json'), JSON.stringify({ version: 1, command: join(unavailable, 'missing-node.exe'), args: [] }));
      process.env.LYRA_HOME = unavailable;
      // A command that cannot start reads as an install that did not start; both show Lyra as unavailable.
      await command({ type: 'lyra-home' }); current = await phase('failed');
      assert.ok(['unavailable', 'invalid_install'].includes(current.lyra.error)); await screenshot('unavailable');
      assert.ok(await chrome('Boolean(document.querySelector(".lyra-panel [role=alert] button"))'));
      process.env.LYRA_HOME = home; await command({ type: 'lyra-retry' }); await phase('home');
      console.log('Lyra real-model verification passed. Artifacts: ' + root);
      await cleanup(0);
    } catch (error) {
      // Verification errors contain only controlled codes and labels, never service bodies or credentials.
      console.error('Lyra verification failed: ' + (error instanceof Error ? error.message : 'unknown condition') + '. Artifacts: ' + root);
      await cleanup(1);
    }
  });
});
require('../dist/electron/main.js');
// main's development paths are replaced before its whenReady callback creates a browser.
app.setPath('userData', data); app.setPath('sessionData', data); app.setPath('crashDumps', join(root, 'crashes')); app.setAppLogsPath(join(root, 'logs'));
