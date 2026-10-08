const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const repository = resolve(__dirname, '..');
const phase = process.env.HORIZON_THEME_VERIFY_PHASE;
const directory = process.env.HORIZON_RUNTIME_DIRECTORY;

// The approved marketplace roles, in catalog order: the page, text, chrome, start-page ground, title, search field, search frame and sun.
const THEMES = [
  { id: 'fjord', name: 'Fjord', dark: true, page: '#18252b', text: '#dce9ed', chrome: '#142127', ground: '#142127', title: '#eef5f6', field: '#24353c', frame: '#91adb7', sun: '#a4d1da' },
  { id: 'dune', name: 'Dune', dark: false, page: '#efe8dd', text: '#4a4035', chrome: '#e9e1d5', ground: '#ebe3d7', title: '#3d3328', field: '#f6f1ea', frame: '#80766a', sun: '#7a4527' },
  { id: 'graphite', name: 'Graphite', dark: true, page: '#18191b', text: '#cfd1d6', chrome: '#131416', ground: '#121315', title: '#e8e9ec', field: '#202125', frame: '#7f828a', sun: '#aab6e0' },
  { id: 'moss', name: 'Moss', dark: false, page: '#eaede6', text: '#3c4637', chrome: '#e3e7de', ground: '#e6e9e2', title: '#2f382b', field: '#f2f4ef', frame: '#737a6d', sun: '#3f5b2e' },
];
const ROLES = ['page', 'text', 'chrome', 'ground', 'title', 'field', 'frame', 'sun'];
const rgb = hex => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;

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
  const timeout = setTimeout(() => { console.error(`Themes ${phase} timed out.`); app.exit(1); }, 120000);
  let started = false;
  app.on('browser-window-created', (_event, window) => {
    // The browser shows its window once it is ready; no window of this check is ever shown or focused, so nothing appears on screen. Unthrottled, the hidden page still paints for the colour reads and the captures.
    window.show = () => {}; window.showInactive = () => {}; window.focus = () => {};
    window.webContents.setBackgroundThrottling(false);
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
      // The Hub stays open after choosing or removing a theme and closes after Get.
      const ensureThemes = async () => { if (!await evaluate('Boolean(document.querySelector("#hub-marketplace-label"))')) await openThemes(); };
      const checkTheme = async (theme, installed) => {
        await waitFor(`document.documentElement.dataset.theme === "${theme.id}"`);
        const state = await evaluate('window.horizon.getState()');
        assert.equal(state.theme, theme.id); assert.deepEqual(state.installedThemes, installed);
        const colours = await evaluate(`(() => {
          const colour = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
          return { page: colour('body', 'backgroundColor'), text: colour('body', 'color'), chrome: colour('.chrome', 'backgroundColor'),
            ground: colour('.start-ground', 'backgroundColor'), title: colour('h1', 'color'),
            field: colour('.start-search', 'backgroundColor'), frame: colour('.start-search', 'borderTopColor'),
            sun: colour('.start-ground .horizon-sun', 'color') };
        })()`);
        // These are the approved roles of the theme, checked against the actual painted window.
        assert.deepEqual(colours, Object.fromEntries(ROLES.map(role => [role, rgb(theme[role])])), `${theme.name} painted roles`);
        assert.equal(window.getBackgroundColor().toLowerCase(), theme.page);
        // The system High contrast pair wins over the theme: pure black for the dark themes, pure white for the light ones.
        const high = await evaluate(`(() => {
          const root = document.documentElement, before = root.dataset.contrast;
          const standard = getComputedStyle(root).colorScheme;
          root.dataset.contrast = 'high';
          const result = { scheme: standard, page: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color };
          root.dataset.contrast = before;
          return result;
        })()`);
        assert.deepEqual(high, { scheme: theme.dark ? 'dark' : 'light only', page: theme.dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)', text: theme.dark ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)' }, `${theme.name} high contrast`);
        console.log(`${theme.name}: ${ROLES.length} painted roles and the ${theme.dark ? 'dark' : 'light'} High contrast pair match.`);
      };
      try {
        await waitFor('Boolean(document.querySelector(".start-search"))');
        // Showing the window is the foundation check's job; this check keeps every window hidden, and colours are read from the page either way.
        assert.equal(window.isVisible(), false, 'The verification window must stay off screen');
        assert.equal(await evaluate('matchMedia("(forced-colors: active)").matches'), false, 'Run palette verification with system High contrast off');
        if (phase === 'install') {
          await openThemes(); await capture('themes-before');
          assert.equal(await evaluate('document.querySelectorAll(".hub-theme-get").length'), THEMES.length);
          assert.deepEqual(await evaluate('[...document.querySelectorAll(".hub-theme-get")].map(button => button.getAttribute("aria-label"))'), THEMES.map(theme => `Get ${theme.name}`));
          for (const [index, theme] of THEMES.entries()) {
            await ensureThemes();
            await evaluate(`document.querySelector('[aria-label="Get ${theme.name}"]').click()`);
            await waitFor('!document.querySelector("#hub-popup")');
            await checkTheme(theme, THEMES.slice(0, index + 1).map(item => item.id)); await capture(`window-${theme.id}`);
          }
          await openThemes(); await waitFor(`${JSON.stringify(THEMES.map(theme => theme.id))}.every(id => document.querySelector("[data-theme-id=" + id + "]"))`);
          assert.equal(await evaluate('document.querySelectorAll(".hub-theme-get").length'), 0);
          assert.equal(await evaluate('document.querySelectorAll(".hub-theme-remove").length'), THEMES.length);
          await capture('themes-after');
        } else if (phase === 'remove') {
          // No settings are seeded in this process: startup must read the persisted installation, which ends on the last theme installed.
          const last = THEMES.at(-1);
          await checkTheme(last, THEMES.map(theme => theme.id)); await capture(`window-${last.id}-restarted`);
          const remaining = THEMES.map(theme => theme.id);
          for (const theme of [...THEMES].reverse()) {
            await ensureThemes();
            if (theme !== last) {
              await evaluate(`document.querySelector('[data-theme-id=${theme.id}]').click()`);
              await checkTheme(theme, remaining);
            }
            await evaluate(`document.querySelector('[aria-label="Remove ${theme.name}"]').click()`);
            await waitFor(`document.documentElement.dataset.theme === "daylight" && !document.querySelector("[data-theme-id=${theme.id}]")`);
            remaining.splice(remaining.indexOf(theme.id), 1);
            const state = await evaluate('window.horizon.getState()');
            assert.equal(state.theme, 'daylight'); assert.equal(state.contrast, 'standard'); assert.deepEqual(state.installedThemes, remaining);
            assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(238, 235, 233)');
            assert.equal(await evaluate('document.querySelectorAll(".hub-theme-remove").length'), remaining.length);
            console.log(`${theme.name}: removed, the window fell back to Daylight.`);
          }
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
