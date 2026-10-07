// Run after npm run build: electron scripts/verify-translate.cjs. Uses the real local Lyra model.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { app, nativeImage, safeStorage, webContents } = require('electron');
const { readStore } = require('../dist/electron/store.js');
const { profileStorePath } = require('../dist/electron/profiles.js');
const { TRANSLATE_KEY } = require('../dist/electron/translate-page.js');

const root = mkdtempSync(join(tmpdir(), 'horizon-translate-'));
const home = join(root, 'lyra'), data = join(root, 'horizon'), screenshots = join(root, 'screenshots');
for (const directory of [home, data, screenshots]) mkdirSync(directory, { recursive: true });
process.env.LYRA_HOME = home;
const lyraRepo = resolve(__dirname, '../../Lyra');
// dev-install writes the installation record into this temporary home; the team's repository is read-only.
execFileSync(process.env.HORIZON_VERIFY_NODE || 'node', [join(lyraRepo, 'packages/cli/src/main.ts'), 'dev-install'], {
  cwd: lyraRepo, env: { ...process.env, LYRA_HOME: home }, windowsHide: true, stdio: 'ignore', timeout: 30000,
});
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
let window, connectedTemporaryService = false, cleaning = false;
const translationModule = require('../dist/electron/translate.js'), createTranslation = translationModule.createTranslation;
translationModule.createTranslation = host => createTranslation({ ...host, connect: async () => {
  const client = await host.connect(); connectedTemporaryService = true; return client;
} });

const originalHeading = 'Tres paseos tranquilos alrededor del lago';
const originalParagraph = 'Seguí la orilla al amanecer, tomá el sendero del bosque después del desayuno y dejá la caminata por la cresta para una tarde despejada.';
const page = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Lagos del Sur</title>
<style>body{margin:0;background:#eeebe9;color:#48433e;font:16px system-ui}main{max-width:800px;margin:48px auto}h1{font:36px Georgia;color:#3b3631}h2{font:700 24px Georgia;color:#3b3631}small{color:#5b5551}.photo{height:230px;background:#ddd9d6;border-radius:14px;margin:18px 0}p{line-height:1.5}</style>
<body><main><h2>Lagos del Sur</h2><small>Diario de viaje</small><h1 id="heading">${originalHeading}</h1><div class="photo"></div><p id="paragraph">${originalParagraph}</p></main>
<script>
// This is the site's own world. It can see the displayed DOM, but must never see Horizon's original-text storage.
const probe = () => { window.translationProbe = { originalsVisible: Object.hasOwn(globalThis, ${JSON.stringify(TRANSLATE_KEY)}), horizonVisible: typeof window.horizon !== 'undefined', heading: document.getElementById('heading').textContent, paragraph: document.getElementById('paragraph').textContent }; };
new MutationObserver(probe).observe(document.body, { subtree: true, characterData: true, childList: true }); probe();
</script></body></html>`;
const server = createServer((request, response) => {
  response.writeHead(request.url === '/walks' || request.url === '/again' ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': 'es', 'Cache-Control': 'no-store' });
  response.end(request.url === '/walks' || request.url === '/again' ? page : 'Not found');
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = code => window.webContents.executeJavaScript(code);
const command = value => chrome(`window.horizon.command(${JSON.stringify(value)})`);
const state = () => chrome('window.horizon.getState()');
const active = value => value.tabs.find(tab => tab.id === value.activeId);
async function until(predicate, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await state(); if (predicate(value)) return value; await pause(100); }
  throw new Error('Verification timeout: ' + label);
}
async function phase(name) {
  return until(value => {
    const translation = active(value)?.translation;
    if (translation?.phase === 'failed' && name !== 'failed') throw new Error('Translation state: ' + translation.error);
    return translation?.phase === name;
  }, name);
}
async function rendered(selector) {
  const deadline = Date.now() + 10000;
  while (!await chrome(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
    if (Date.now() > deadline) throw new Error('Translation control did not render');
    await pause(50);
  }
}
async function click(selector) { await rendered(selector); await chrome(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function pageProbe(url) {
  const contents = webContents.getAllWebContents().find(contents => contents.getURL() === url);
  assert.ok(contents, 'Fixture page must be loaded');
  assert.equal(contents.debugger.isAttached(), false);
  contents.debugger.attach('1.3');
  try {
    // Read the result of the fixture's own MutationObserver in its default world; no translator code runs there.
    const result = await contents.debugger.sendCommand('Runtime.evaluate', { expression: 'window.translationProbe', returnByValue: true });
    const value = result.result.value;
    assert.equal(value.originalsVisible, false); assert.equal(value.horizonVisible, false);
    return value;
  } finally { if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach(); }
}
async function captureWindow() {
  // Native page views have their own compositor; chrome's capture alone can omit the translated document.
  const image = await window.webContents.capturePage(), size = image.getSize({ scaleFactor: 1 });
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  const viewport = await chrome('({ width: innerWidth, height: innerHeight })');
  assert.equal(bitmap.length, size.width * size.height * 4);
  for (const view of window.contentView.children) {
    if (!view.webContents || view.webContents === window.webContents || !view.getVisible()) continue;
    const bounds = view.getBounds(), x = Math.round(bounds.x * size.width / viewport.width), y = Math.round(bounds.y * size.height / viewport.height);
    const width = Math.round(bounds.width * size.width / viewport.width), height = Math.round(bounds.height * size.height / viewport.height);
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= size.width && y + height <= size.height);
    const page = await view.webContents.capturePage(); assert.equal(page.isEmpty(), false);
    const pixels = page.resize({ width, height }).toBitmap({ scaleFactor: 1 }); assert.equal(pixels.length, width * height * 4);
    for (let row = 0; row < height; row++) pixels.copy(bitmap, ((y + row) * size.width + x) * 4, row * width * 4, (row + 1) * width * 4);
  }
  return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height, scaleFactor: 1 });
}
async function screenshot(name, menu = false) {
  await rendered('.translation-bar');
  if (menu) {
    await rendered('.translation-options'); await rendered('.web-snapshot');
    await chrome('document.querySelector(".web-snapshot").decode()');
  }
  await chrome('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await pause(250);
  const proportions = await chrome(`(() => {
    const bar = document.querySelector('.translation-bar'), menu = document.querySelector('.translation-options'), opener = document.querySelector('.translation-menu-anchor');
    const rect = bar.getBoundingClientRect(), style = getComputedStyle(bar);
    return { height: rect.height, padding: style.paddingLeft, gap: style.gap, overflow: bar.scrollWidth > bar.clientWidth + 1,
      menu: menu ? { width: menu.getBoundingClientRect().width, gap: menu.getBoundingClientRect().top - rect.bottom, right: menu.getBoundingClientRect().right - opener.getBoundingClientRect().right, overflow: menu.scrollWidth > menu.clientWidth + 1 } : null };
  })()`);
  assert.ok(Math.abs(proportions.height - 42) < 1); assert.equal(proportions.padding, '20px'); assert.equal(proportions.gap, '10px'); assert.equal(proportions.overflow, false);
  if (menu) { assert.ok(Math.abs(proportions.menu.width - 300) < 1); assert.ok(Math.abs(proportions.menu.gap - 6) < 1); assert.ok(Math.abs(proportions.menu.right) < 1); assert.equal(proportions.menu.overflow, false); }
  const path = join(screenshots, name + '.png'); writeFileSync(path, (await captureWindow()).toPNG()); console.log(path);
}
async function persisted() {
  return readStore(profileStorePath(data, (await state()).activeProfileId), safeStorage).siteSettings.translation;
}
async function cleanup(code) {
  if (cleaning) return; cleaning = true; clearTimeout(watchdog);
  if (connectedTemporaryService) try {
    execFileSync(process.env.HORIZON_VERIFY_NODE || 'node', [join(lyraRepo, 'packages/cli/src/main.ts'), 'unfocus'], {
      cwd: lyraRepo, env: { ...process.env, LYRA_HOME: home }, windowsHide: true, stdio: 'ignore', timeout: 15000,
    });
  } catch { /* A failed temporary service may already be asleep. */ }
  // A service that ignored unfocus would keep this script's output pipe open; stop the temporary one by its run file.
  try { const run = JSON.parse(require('node:fs').readFileSync(join(home, 'run', 'service.json'), 'utf8')); if (Number.isSafeInteger(run.pid)) process.kill(run.pid); } catch { /* No run file means the service already stopped. */ }
  server.close(); app.exit(code);
}
const watchdog = setTimeout(() => { console.error('Translation verification timed out. Artifacts: ' + root); void cleanup(1); }, 10 * 60 * 1000);
app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created; created.setBounds({ x: -20000, y: 0, width: 1440, height: 900 });
  created.webContents.once('did-finish-load', async () => {
    try {
      await until(value => value.tabs.length > 0, 'chrome ready');
      await command({ type: 'finish-first-run' }); await command({ type: 'set-language', value: 'en' });
      await command({ type: 'theme', value: 'amber' }); await command({ type: 'dark-pages', value: 'off' }); window.webContents.setZoomFactor(1);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port, url = origin + '/walks';
      await command({ type: 'navigate', input: url }); await phase('offered'); await screenshot('bar');
      // Reopen the bar through the Hub's actual Translate tile.
      await command({ type: 'translate-close' });
      await click('button[aria-controls="hub-popup"]'); await click('.hub-tile:has(svg.lucide-languages)');
      await rendered('.translation-bar'); await click('[data-translate-action]'); await phase('translated');
      let probe = await pageProbe(url);
      assert.notEqual(probe.heading, originalHeading); assert.notEqual(probe.paragraph, originalParagraph);
      // The model's wording varies; the check is that Spanish became English, not a particular phrase.
      for (const value of [probe.heading, probe.paragraph]) { assert.doesNotMatch(value, /\b(paseos|tranquilos|alrededor|orilla|amanecer|desayuno|bosque)\b/i); assert.match(value, /\b(the|and|around|after|at)\b/i); }
      await screenshot('translated-page'); await click('[data-translate-options]'); await screenshot('options-menu', true);
      await click('.translation-choice [role="switch"]');
      await until(value => value.store.siteSettings.translation?.always.some(entry => entry.language === 'es' && entry.target === 'en'), 'always remembered');
      assert.deepEqual((await persisted()).always, [{ language: 'es', target: 'en' }]);
      // Closing the menu leaves the existing translated document in place.
      await click('[data-translate-options]'); await click('[data-translate-action]'); await phase('original');
      probe = await pageProbe(url); assert.equal(probe.heading, originalHeading); assert.equal(probe.paragraph, originalParagraph); await screenshot('original-page');
      assert.ok(await chrome('document.querySelector("[data-translate-action]").textContent.includes("Translate to English")'));
      await command({ type: 'navigate', input: origin + '/again' }); await phase('translated');
      probe = await pageProbe(origin + '/again'); assert.notEqual(probe.heading, originalHeading); assert.match(probe.heading, /\b(the|and|around)\b/i);
      await click('[data-translate-options]'); await click('[data-translate-never]'); await phase('original');
      await until(value => !active(value).translation.open, 'never closed the bar');
      const choices = await persisted(); assert.ok(choices.never.includes('127.0.0.1')); assert.deepEqual(choices.always, [{ language: 'es', target: 'en' }]);
      await command({ type: 'navigate', input: url }); await until(value => active(value)?.url === url && !active(value).loading, 'excluded page'); await pause(300);
      assert.equal(active(await state()).translation.open, false); assert.equal(active(await state()).translation.phase, 'idle');
      probe = await pageProbe(url); assert.equal(probe.heading, originalHeading);
      console.log('Translation real-model verification passed. Artifacts: ' + root); await cleanup(0);
    } catch (error) {
      // Assertions can embed model output; report only a controlled condition label, never page text or service bodies.
      const label = error?.code === 'ERR_ASSERTION' ? 'assertion failed' : error instanceof Error && /^(Verification timeout:|Translation state:|Translation control)/.test(error.message) ? error.message : 'unexpected condition';
      const line = /verify-translate\.cjs:(\d+)/.exec(error?.stack ?? '')?.[1];
      console.error('Translation verification failed: ' + label + (line ? ' at line ' + line : '') + '. Artifacts: ' + root); await cleanup(1);
    }
  });
});
require('../dist/electron/main.js');
app.setPath('userData', data); app.setPath('sessionData', data); app.setPath('crashDumps', join(root, 'crashes')); app.setAppLogsPath(join(root, 'logs'));
