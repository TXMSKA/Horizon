# horizon-engine

Horizon's browser engine for Electron hosts. It runs in the main process and provides session protections and tabs. The host draws the browser controls, attaches views and stores history. Electron >=42 is a peer dependency supplied by the host.

Install from the sibling Horizon repository after building the package with `tsc -p packages/engine` in Horizon:

```json
{
  "dependencies": {
    "horizon-engine": "file:../Horizon/packages/engine"
  }
}
```

The package is ESM. Use `import` in an ESM main process or `await import('horizon-engine')` in a CommonJS main process. Horizon's synchronous compatibility modules use Node's `require(esm)` support. Its URL bridge imports the package's pure source entry because the renderer also consumes it; importing the main-process entry there would load Electron and Node APIs. The package has no top-level await.

## Layer 1

Protect a session owned by an existing browser. Call this before creating its web contents. Existing web contents in the session are hardened too. A session can have only one active protection; a second call throws. This layer owns the session's permission and webRequest handlers, so the host must not replace them while protection is active.

```ts
import { app, session } from 'electron';
import { protectSession } from 'horizon-engine';

await app.whenReady();
const target = session.fromPartition('persist:embedded-browser');
const protection = protectSession(target, {
  dataDir: app.getPath('userData'),
  blockAds: true,
  blockThirdPartyCookies: true,
  privateMode: false,
  permissions: async ({ origin, permission }) => {
    return await host.askPermission(origin, permission) ? 'allow' : 'block';
  },
  download: item => host.chooseDownloadPath(item), // Return an absolute path or null.
  openExternal: url => host.openExternal(url),
});

protection.update({ blockAds: false });
const blocked = protection.blockedCount(contents);
protection.resumeDownload(savedInterruptedDownload);
protection.dispose();
```

The `host`, `contents` and `savedInterruptedDownload` values in these examples belong to the embedding application. Permission requests include the requesting origin, Electron permission and details, and the WebContents. Missing callbacks deny permissions and cancel downloads. Permission checks return false until the host has allowed that origin and permission through a request. Private mode denies permissions, blocks scripts and forces request and cookie protection. It downloads PDFs instead of opening them in the viewer.

Downloads reach the host as Electron DownloadItems. A returned path is passed to `setSavePath`; returning null or omitting the callback cancels. The host tracks progress and pause, resume, cancel and retry on the item. `resumeDownload` accepts Electron's `CreateInterruptedDownloadOptions`.

`blockedCount(contents)` is also exported directly. It counts blocked network requests for that WebContents and resets on a main-frame document navigation. Cosmetic rules use `insertCSS` without running page code. Styles use author origin so live updates and disposal can remove them through Electron; inline important styles can override them. `dispose` stops filter work and releases the session handlers and listeners. It cannot restore handlers the host installed before protection, since Electron exposes no getters for them. The host must reapply its own policy after disposal.

## Layer 2

Create tabs when the host has no browser implementation. The engine creates and owns its session protection. Supply protection options rather than calling `protectSession` on the same session first.

```ts
import { app, BrowserWindow, session } from 'electron';
import { createEngine } from 'horizon-engine';

await app.whenReady();
const window = new BrowserWindow();
const engine = createEngine({
  session: session.fromPartition('persist:browser-tabs'),
  protect: { dataDir: app.getPath('userData'), blockAds: true, blockThirdPartyCookies: true },
  searchEngine: 'https://duckduckgo.com/?q=',
  openWindow: details => host.openTab(details.url),
  shortcut: input => host.handleShortcut(input),
  fullscreen: (_tab, on) => window.setFullScreen(on),
  consent: url => host.canReadPage(url),
});
const tab = engine.openTab({ url: 'https://example.com', active: true });
window.contentView.addChildView(tab.view);
tab.view.setBounds({ x: 0, y: 80, width: 900, height: 600 });
const unsubscribe = tab.onChange(state => host.updateTab(tab.id, state));
const stopHistory = engine.onNavigate(entry => host.recordHistory(entry));

await tab.navigate('search text');
await tab.navigate('localhost:3000', 'https://search.example/?q=');
tab.back(); tab.forward(); tab.reload(); tab.stop();
const result = await tab.find('example', { forward: true });
tab.stopFind(); tab.zoom(1.25);
const png = await engine.capture(tab, { fullPage: true });
const text = await engine.readPage(tab);
const restore = tab.history();
tab.close();
const reopened = engine.openTab({ restore });

unsubscribe(); stopHistory();
engine.dispose();
```

The engine does not attach, size or select views for the host. `active` controls the initial visibility of the view. The host manages later visibility and focus. `searchEngine` and the second `navigate` argument are search URL prefixes. `find` resolves Electron's final find result. `history` returns `{ entries, index }` for `navigationHistory.restore`. Tab state includes URL, title, favicon, loading, backward and forward availability, blocked request count, secure status and main-frame load errors. The secure flag reports an HTTPS URL without a load error, not a separate certificate audit.

Opened windows always return deny to Electron; `openWindow` lets the host create its own tab. A shortcut callback returns true when it handled the input, which prevents Electron's default action. The host must authorize fullscreen permission through `protect.permissions` to receive HTML fullscreen events. Normal tabs use Chromium's PDF viewer.

Capture returns a PNG Buffer. Full-page capture and page reading attach the debugger temporarily and detach it afterwards. An existing debugger attachment is reused and left attached. Page reading uses only the main document's accessibility tree, excludes form controls and embedded documents, and returns up to 6000 characters. `consent(url, 'read')` must return true or reading throws `READ_PAGE_CONSENT`. No preload or page script is injected.

## Page control

Page control is off by default: `tab.control` is undefined unless the host passes `pageControl: true` to `createEngine`. Horizon itself never enables it. The host must obtain consent per site through `consent(url, 'control')`; every control method checks this callback, and missing or denied consent throws `CONTROL_CONSENT`. Existing callbacks accepting only `url` remain compatible. Hosts should distinguish read and control permissions when asking for consent.

```ts
const engine = createEngine({
  session: target,
  protect: { dataDir: app.getPath('userData') },
  pageControl: true,
  consent: (url, purpose) => host.hasSiteConsent(url, purpose),
});
const tab = engine.openTab({ url: 'https://example.com' });
// Attach and size the view in the host, then wait for the page to load.
await tab.control!.click({ selector: '#submit' });
await tab.control!.type({ selector: '#search' }, 'Horizon');
await tab.control!.click({ x: 100, y: 200 });
await tab.control!.select({ selector: '#category' }, 'books');
await tab.control!.scroll({ deltaY: 400 });
const element = await tab.control!.pickElement();
await tab.control!.release();
```

Targets are CSS selectors or `{ x, y }` points in the view's CSS pixels. Clicks scroll selector targets into view and use their content centre; typing focuses the selector or clicks the point before inserting text. Missing selector targets throw `CONTROL_TARGET_NOT_FOUND`. `select` accepts a select element and dispatches input and change events; other elements throw `CONTROL_NOT_SELECT`. Scroll accepts optional `x`, `y`, `deltaX` and `deltaY`, defaulting to the view centre and zero deltas.

All control uses `webContents.debugger` and Chrome DevTools Protocol. It never uses `executeJavaScript`, a preload or `Runtime.evaluate`, and runs no script in the page's main world. Only `select` uses a function, through `Runtime.callFunctionOn` on a node resolved in the isolated world named `horizon-engine-control`.

`pickElement` enables Chromium's inspect overlay and resolves to `{ selector, box: { x, y, width, height }, image }`, where `image` is a cropped PNG Buffer and the box uses view CSS pixels. The selector uses a unique ID where possible, otherwise tags and `nth-of-type` along the parent chain in the main document. Escape or `cancelPick()` resolves null; inspect mode is turned off afterwards. Picks inside embedded documents or shadow roots cannot produce a main-document CSS selector and are rejected. Concurrent actions while another control action or pick is active throw `CONTROL_BUSY`.

The debugger attaches on first use and is detached on `release()`, tab close, document navigation or a failed operation. Control never detaches an attachment owned by the host. A navigation invalidates pending work, and a new action checks the new site's consent. Recorded flows, including replayable lists of navigation and control steps, are outside this build.

## Verification

`npm run test:security` includes the pure package tests. `npm run verify:engine` runs an offscreen Electron host against local fixtures. The `filterDownload(url, signal)` protection option is a test hook that replaces filter-list downloads without changing the blocker. Return filter text for list URLs and a JSON resource document such as `{"redirects":[],"scriptlets":[]}` for `resources.json`. Use a fresh `dataDir` to avoid loading an existing cache. Omit this hook in normal hosts.

The public surface is 0.x; see [UNSTABLE.md](UNSTABLE.md) before changing it.
