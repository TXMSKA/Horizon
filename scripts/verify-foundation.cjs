const assert = require('node:assert/strict');
const { writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const timeout = setTimeout(() => { console.error('Foundation verification timed out.'); app.exit(1); }, 30000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await window.webContents.executeJavaScript('Boolean(document.querySelector("h1"))')) break;
        await new Promise(done => setTimeout(done, 100));
      }
      // The start page now waits for the browser state, so the first paint and ready-to-show can trail the heading.
      for (let attempt = 0; attempt < 40 && !window.isVisible(); attempt++) await new Promise(done => setTimeout(done, 100));
      const initial = await window.webContents.executeJavaScript(`({
        url: location.href, title: document.title, language: document.documentElement.lang,
        heading: document.querySelector('h1')?.textContent,
        node: typeof require, process: typeof process, api: Object.keys(window.horizon).sort(),
        overflow: document.documentElement.scrollWidth > innerWidth
      })`);
      assert.equal(initial.url, 'horizon://app/');
      assert.equal(initial.heading, 'Horizon');
      assert.equal(initial.title, 'Horizon');
      assert.ok(['es', 'en'].includes(initial.language));
      assert.equal(initial.node, 'undefined');
      assert.equal(initial.process, 'undefined');
      assert.deepEqual(initial.api, ['capture', 'command', 'getLanguage', 'getState', 'onShortcut', 'onState', 'setContentArea', 'windowAction']);
      assert.equal(initial.overflow, false);
      assert.ok(window.isVisible());
      assert.equal(await window.webContents.executeJavaScript('document.querySelector(".skip-link").click(); location.href'), 'horizon://app/');
      const permission = await window.webContents.executeJavaScript('navigator.permissions.query({name: "geolocation"}).then(result => result.state)');
      assert.equal(permission, 'denied');
      const evalBlocked = await window.webContents.executeJavaScript(`(() => {
        try { new Function('return 1')(); return false; } catch (error) { return error.name === 'EvalError'; }
      })()`);
      assert.ok(evalBlocked);
      await assert.rejects(window.webContents.executeJavaScript('window.horizon.windowAction("invalid")'));
      const { validateSender } = require('../dist/electron/security.js');
      validateSender({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, window.webContents);
      assert.throws(() => validateSender({ sender: {}, senderFrame: window.webContents.mainFrame }, window.webContents));
      assert.throws(() => validateSender({ sender: window.webContents, senderFrame: {} }, window.webContents));
      const response = await session.defaultSession.fetch('horizon://app/');
      assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
      assert.equal((await session.defaultSession.fetch('horizon://evil/')).status, 403);
      assert.equal((await session.defaultSession.fetch('horizon://app/%2e%2e%2felectron/main.js')).status, 403);
      assert.equal((await session.defaultSession.fetch('horizon://app/', { method: 'POST' })).status, 403);
      assert.equal((await session.defaultSession.fetch('horizon://app/missing.js')).status, 404);
      mkdirSync('.runtime/screenshots', { recursive: true });
      // The theme is chosen in the browser menu since task 002; the system theme only sets the first one.
      for (const [theme, name] of [['dark', 'Amber'], ['light', 'Daylight']]) {
        await window.webContents.executeJavaScript(`(async () => {
          document.querySelector('[aria-controls=browser-menu]').click();
          await new Promise(done => setTimeout(done, 100));
          [...document.querySelectorAll('#browser-menu .segmented button')].find(button => button.textContent === ${JSON.stringify(name)}).click();
          document.querySelector('[aria-controls=browser-menu]').click();
        })()`);
        await new Promise(done => setTimeout(done, 200));
        const colours = await window.webContents.executeJavaScript(`({
          page: getComputedStyle(document.body).backgroundColor,
          placeholder: document.querySelector('.search-field input').placeholder
        })`);
        assert.equal(colours.page, theme === 'dark' ? 'rgb(7, 5, 6)' : 'rgb(251, 248, 247)');
        const capture = await window.webContents.capturePage();
        writeFileSync(resolve('.runtime/screenshots', `${theme}.png`), capture.toPNG());
        console.log(JSON.stringify({ theme, ...colours }));
      }
      await window.webContents.executeJavaScript('window.open("https://example.com")');
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      await window.webContents.executeJavaScript(`(() => {
        const a = document.createElement('a'); a.href = 'https://example.com'; a.click();
      })()`);
      await new Promise(done => setTimeout(done, 100));
      assert.equal(window.webContents.getURL(), 'horizon://app/');
      console.log('Foundation runtime verification passed.', JSON.stringify(initial));
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});
require('../dist/electron/main.js');
