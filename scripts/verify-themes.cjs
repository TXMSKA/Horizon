const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const repository = resolve(__dirname, '..');
const phase = process.env.HORIZON_THEME_VERIFY_PHASE;
const directory = process.env.HORIZON_RUNTIME_DIRECTORY;

if (!phase) {
  const profile = `verify-themes-${randomUUID()}`;
  const run = step => new Promise((done, reject) => {
    const child = spawn(process.execPath, [__filename], { cwd: repository, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, HORIZON_RUNTIME_DIRECTORY: profile, HORIZON_THEME_VERIFY_PHASE: step } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`Themes ${step} exited with ${code}`)));
  });
  app.whenReady().then(async () => {
    // Each process fully exits before the next one acquires the same profile's lock.
    for (const step of ['install', 'remove', 'fallback']) await run(step);
    console.log('Themes runtime verification passed.');
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  assert.ok(['install', 'remove', 'fallback'].includes(phase));
  assert.match(directory ?? '', /^verify-themes-[a-f0-9-]+$/);
  const runtime = resolve(repository, '.runtime', directory);
  const screenshots = resolve(runtime, 'screenshots');
  mkdirSync(screenshots, { recursive: true });
  if (phase === 'install') {
    const { createSettings } = require('../dist/electron/settings.js');
    const settings = createSettings(resolve(runtime, 'settings.json'), () => {});
    settings.setTheme('daylight', false); settings.setContrast('standard');
    settings.setLanguage('en'); settings.finishFirstRun();
  }
  const timeout = setTimeout(() => { console.error(`Themes ${phase} timed out.`); app.exit(1); }, 45000);
  let started = false;
  app.on('browser-window-created', (_event, window) => {
    if (started) return;
    started = true;
    window.webContents.once('did-finish-load', async () => {
      const evaluate = source => window.webContents.executeJavaScript(source);
      const waitFor = async source => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await evaluate(source)) return;
          await new Promise(done => setTimeout(done, 50));
        }
        throw new Error(`Themes condition failed: ${source}`);
      };
      const capture = async name => {
        // Two paints let React's state and the new palette reach the captured frame.
        await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
        const path = resolve(screenshots, `${name}.png`);
        writeFileSync(path, (await window.webContents.capturePage()).toPNG()); console.log(path);
      };
      const openThemes = async () => {
        await evaluate('document.querySelector("[aria-controls=hub-popup]").click()');
        await waitFor('Boolean(document.querySelector(".hub-tile"))');
        await evaluate('[...document.querySelectorAll(".hub-tile")].find(button => button.textContent === "Themes").click()');
        await waitFor('Boolean(document.querySelector("#hub-marketplace-label"))');
      };
      const checkFjord = async () => {
        await waitFor('document.documentElement.dataset.theme === "fjord"');
        const state = await evaluate('window.horizon.getState()');
        assert.equal(state.theme, 'fjord'); assert.deepEqual(state.installedThemes, ['fjord']);
        const colours = await evaluate(`(() => {
          const colour = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
          return { page: colour('body', 'backgroundColor'), text: colour('body', 'color'), chrome: colour('.chrome', 'backgroundColor'),
            ground: colour('.start-ground', 'backgroundColor'), title: colour('h1', 'color'),
            field: colour('.start-search', 'backgroundColor'), frame: colour('.start-search', 'borderTopColor'),
            sun: colour('.start-ground .horizon-sun', 'color') };
        })()`);
        // These are the approved Fjord roles, checked against the actual painted window.
        const expected = { page: 'rgb(24, 37, 43)', text: 'rgb(220, 233, 237)', chrome: 'rgb(20, 33, 39)',
          ground: 'rgb(20, 33, 39)', title: 'rgb(238, 245, 246)', field: 'rgb(36, 53, 60)',
          frame: 'rgb(145, 173, 183)', sun: 'rgb(164, 209, 218)' };
        assert.deepEqual(colours, expected);
        assert.equal(window.getBackgroundColor().toLowerCase(), '#18252b');
      };
      try {
        await waitFor('Boolean(document.querySelector(".start-search"))');
        // Showing the window is the foundation check's job; an unattended session can keep it hidden, and colours are read from the page either way.
        assert.equal(await evaluate('matchMedia("(forced-colors: active)").matches'), false, 'Run palette verification with system High contrast off');
        if (phase === 'install') {
          await openThemes(); await capture('themes-before');
          assert.equal(await evaluate('document.querySelectorAll(".hub-theme-get").length'), 1);
          await evaluate(`document.querySelector('[aria-label="Get Fjord"]').click()`);
          await waitFor('!document.querySelector("#hub-popup")');
          await checkFjord(); await capture('window-fjord');
          await openThemes(); await waitFor('Boolean(document.querySelector("[data-theme-id=fjord]"))');
          await capture('themes-after');
        } else if (phase === 'remove') {
          // No settings are seeded in this process: startup must read the persisted installation.
          await checkFjord(); await capture('window-fjord-restarted'); await openThemes();
          await evaluate(`document.querySelector('[aria-label="Remove Fjord"]').click()`);
          await waitFor('document.documentElement.dataset.theme === "daylight" && !document.querySelector("[data-theme-id=fjord]")');
          const state = await evaluate('window.horizon.getState()');
          assert.equal(state.theme, 'daylight'); assert.equal(state.contrast, 'standard'); assert.deepEqual(state.installedThemes, []);
          assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(238, 235, 233)');
          assert.equal(await evaluate('document.querySelectorAll(".hub-theme-remove").length'), 0);
          await capture('themes-removed');
        } else {
          const state = await evaluate('window.horizon.getState()');
          assert.equal(state.theme, 'daylight'); assert.deepEqual(state.installedThemes, []);
          assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(238, 235, 233)');
        }
        clearTimeout(timeout); app.quit();
      } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
    });
  });
  require('../dist/electron/main.js');
}
