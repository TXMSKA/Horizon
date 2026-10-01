# Electron security checklist

Source: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), checked 2026-10-01. Task 001's native shell passed `npm run verify:window` on Windows with Smart App Control off. Task 002 adds untrusted web views; its automated checks cover the source and mocked lifecycle, while native browsing, keyboard/focus, resize/theme rendering, downloads and Google sign-in await the seat's app inspection. The implementation agent does not launch the app.

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 1. Only load secure content | Scoped | Chrome uses the secure custom protocol and restrictive CSP in [protocol.ts](../../electron/protocol.ts). Web tabs prefer HTTPS for bare hosts, and explicitly allow HTTP as required by task 002; insecure subcontent remains disabled. [browsing.ts](../../electron/browsing.ts), [browser.ts](../../electron/browser.ts). |
| 2. Do not enable Node.js integration for remote content | Applied | [main.ts](../../electron/main.ts). Disabled in the renderer, workers, and subframes. |
| 3. Enable context isolation in all renderers | Applied | [main.ts](../../electron/main.ts). |
| 4. Enable process sandboxing | Applied | [main.ts](../../electron/main.ts) and [main.ts](../../electron/main.ts). |
| 5. Handle session permission requests | Applied | [security.ts](../../electron/security.ts) denies requests, checks and devices in the chrome session. [browser.ts](../../electron/browser.ts) installs independent deny handlers on `persist:web` before loading sites. The one exception is HTML fullscreen, which Electron routes through the request handler: it is granted, as browsers do without a prompt, and Escape leaves it. Per-site permissions arrive in task 004. |
| 6. Do not disable webSecurity | Applied | [main.ts](../../electron/main.ts). |
| 7. Define a restrictive Content Security Policy | Applied | [security.ts](../../electron/security.ts) and [protocol.ts](../../electron/protocol.ts). Same-origin external scripts and styles only; `img-src 'self' blob:` permits local page snapshots. No evaluation, inline code, connections, frames, objects, forms, or base changes. |
| 8. Do not enable allowRunningInsecureContent | Applied | [main.ts](../../electron/main.ts). |
| 9. Do not enable experimental features | Applied | [main.ts](../../electron/main.ts). |
| 10. Do not use enableBlinkFeatures | Not applicable | No Blink features are enabled; [main.ts](../../electron/main.ts) contains no override. |
| 11. Do not use allowpopups for WebViews | Not applicable | There are no WebViews. [main.ts](../../electron/main.ts) disables them. |
| 12. Verify WebView options before creation | Applied | [main.ts](../../electron/main.ts). Every attachment is refused. |
| 13. Disable or limit navigation | Applied | [security.ts](../../electron/security.ts) keeps chrome navigation blocked. Top-level web navigation allows only HTTP, HTTPS and exact `about:blank`; subframes additionally allow exact `about:srcdoc`, `data:` and `blob:`. Both navigation events and the [web session request handler](../../electron/browser.ts) enforce these rules and block privileged schemes. |
| 14. Disable or limit creation of new windows | Applied | Chrome popups remain denied. Allowed web URLs create Horizon tabs through `createWindow`, adopting the guest WebContents with secure preferences and preserving its opener and `persist:web` session, subject to the tab cap. Background tabs do not activate; destroyed guests are removed safely. [browser.ts](../../electron/browser.ts). |
| 15. Do not use shell.openExternal with untrusted content | Applied | No URL is passed to the shell. The only shell operation is `showItemInFolder` for a known download ID whose stored path matches its filename in the Downloads folder. No download is executed. [browser.ts](../../electron/browser.ts). |
| 16. Use a current version of Electron | Pinned | [package.json](../../package.json) retains installed Electron 44.4.5 as specified by task 002. No dependency or lockfile changes were required. Version updates remain subject to the seven-day npm release-age floor. |
| 17. Validate the sender of all IPC messages | Applied | Every handler calls [validateSender](../../electron/security.ts) for WebContents identity, exact main frame and exact Horizon origin. [commands.ts](../../electron/commands.ts) checks object shapes, string limits, URL schemes and values; handlers check argument counts. |
| 18. Avoid file:// and prefer custom protocols | Applied | [main.ts](../../electron/main.ts) and [protocol.ts](../../electron/protocol.ts). Canonical paths restrict serving to built assets and prevent traversal and junction escapes. |
| 19. Check which fuses can be changed | Not applicable at the development stage | [scripts/fuses.mjs:12](../../scripts/fuses.mjs#L12) is prepared for task 012 integration after packaging and before signing. Smart App Control blocks unsigned development binaries, modified or not. ASAR-only loading requires packaging; Windows ASAR integrity requires embedded metadata. Linux skips unsupported embedded integrity. |
| 20. Do not expose Electron APIs to untrusted web content | Applied | [preload.ts](../../electron/preload.ts) exposes a typed browser API only to Horizon chrome. Every [web view](../../electron/browser.ts) has a separate persistent session, sandbox, context isolation, no Node and no preload. Web pages receive no bridge or IPC primitives. |

## Fuse boundary for task 012

The prepared script requires resources/app.asar and runs before code signing. It disables RunAsNode, NodeOptions, Node CLI inspection, and file-protocol extra privileges; enables cookie encryption, ASAR-only loading, and Wasm trap handlers; enables embedded ASAR integrity for Windows binaries only; and selects the browser-specific V8 snapshot only when that artifact exists. All fuse options are explicit, and newly introduced fuses cause a hard failure.

The development binary lacks the browser-specific snapshot, so flipping that fuse there breaks startup, and Smart App Control blocks a modified binary; the script therefore refuses unpackaged targets. Task 012 owns ASAR creation, Windows integrity metadata, signing, and applying the script to distributable binaries.

## Verification

Node tests exercise hostile IPC identities and arguments, bounded page capture, chrome/web frame navigation boundaries, URL/search classification, error names, default permission/device denial, protocol traversal and CSP, store schema/recovery, debounced writes and shutdown flushes, download name collisions and transient tabs, shared shortcuts, popup adoption, destroyed tabs and fullscreen in a mocked browser lifecycle. Run `npm run lint`, `npm run typecheck`, `npm run build` and `npm run test:security`. Build checks the theme contrast pairs. The task 001 integration script covers the foundation; it is not a task 002 browsing acceptance test.

Task 001 native startup and both themes were verified on Windows on 2026-10-01. Task 002 native inspection, Google sign-in, Linux startup and CI execution remain unverified here.
