# Electron security checklist

Source: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), checked 2026-10-01. Applied means implemented in source and exercised by `npm run verify:window`, which passed on Windows on 2026-10-01 with Smart App Control off; Smart App Control blocks the unsigned development binary.

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 1. Only load secure content | Applied | [electron/main.ts:22](../../electron/main.ts#L22) and [electron/protocol.ts:24](../../electron/protocol.ts#L24). Only built local assets are served over a secure custom scheme. No site loads. |
| 2. Do not enable Node.js integration for remote content | Applied | [electron/main.ts:51](../../electron/main.ts#L51). Disabled in the renderer, workers, and subframes. |
| 3. Enable context isolation in all renderers | Applied | [electron/main.ts:54](../../electron/main.ts#L54). |
| 4. Enable process sandboxing | Applied | [electron/main.ts:21](../../electron/main.ts#L21) and [electron/main.ts:55](../../electron/main.ts#L55). |
| 5. Handle session permission requests | Applied | [electron/security.ts:30](../../electron/security.ts#L30). Requests, checks, and devices are denied on the only session before load. |
| 6. Do not disable webSecurity | Applied | [electron/main.ts:56](../../electron/main.ts#L56). |
| 7. Define a restrictive Content Security Policy | Applied | [electron/security.ts:4](../../electron/security.ts#L4) and [electron/protocol.ts:17](../../electron/protocol.ts#L17). Same-origin external scripts and styles only; no evaluation, inline code, connections, frames, objects, forms, or base changes. |
| 8. Do not enable allowRunningInsecureContent | Applied | [electron/main.ts:57](../../electron/main.ts#L57). |
| 9. Do not enable experimental features | Applied | [electron/main.ts:58](../../electron/main.ts#L58). |
| 10. Do not use enableBlinkFeatures | Not applicable | No Blink features are enabled; [electron/main.ts:49](../../electron/main.ts#L49) contains no override. |
| 11. Do not use allowpopups for WebViews | Not applicable | There are no WebViews. [electron/main.ts:59](../../electron/main.ts#L59) disables them. |
| 12. Verify WebView options before creation | Applied | [electron/main.ts:30](../../electron/main.ts#L30). Every attachment is refused. |
| 13. Disable or limit navigation | Applied | [electron/main.ts:27](../../electron/main.ts#L27). Navigation, frame navigation, and redirects are refused. The skip link moves focus without changing the trusted URL. |
| 14. Disable or limit creation of new windows | Applied | [electron/main.ts:31](../../electron/main.ts#L31). All renderer requests are denied. |
| 15. Do not use shell.openExternal with untrusted content | Not applicable | No shell API is imported or exposed. No URL reaches the operating system. |
| 16. Use a current version of Electron | Applied | [package.json:35](../../package.json#L35). Version 44.4.5 is exactly pinned in the current stable major. npm reported 44.5.1 on 2026-10-01; its 2026-09-30 publication misses the seven-day age floor. Task 002 moves to the newest 44.x that passes the floor before any site loads. |
| 17. Validate the sender of all IPC messages | Applied | [electron/security.ts:18](../../electron/security.ts#L18) and [electron/main.ts:71](../../electron/main.ts#L71). Both handlers check WebContents identity, the exact main frame, and a parsed Horizon URL. Window actions also validate their value. |
| 18. Avoid file:// and prefer custom protocols | Applied | [electron/main.ts:86](../../electron/main.ts#L86) and [electron/protocol.ts:13](../../electron/protocol.ts#L13). Canonical paths restrict serving to built assets and prevent traversal and junction escapes. |
| 19. Check which fuses can be changed | Not applicable at the development stage | [scripts/fuses.mjs:12](../../scripts/fuses.mjs#L12) is prepared for task 012 integration after packaging and before signing. Smart App Control blocks unsigned development binaries, modified or not. ASAR-only loading requires packaging; Windows ASAR integrity requires embedded metadata. Linux skips unsupported embedded integrity. |
| 20. Do not expose Electron APIs to untrusted web content | Applied | [electron/preload.ts:5](../../electron/preload.ts#L5) and [src/shared/api.ts:4](../../src/shared/api.ts#L4). Only locale retrieval and three window actions are exposed; no IPC primitives, callbacks, URLs, filesystem access, or Electron objects. |

## Fuse boundary for task 012

The prepared script requires resources/app.asar and runs before code signing. It disables RunAsNode, NodeOptions, Node CLI inspection, and file-protocol extra privileges; enables cookie encryption, ASAR-only loading, and Wasm trap handlers; enables embedded ASAR integrity for Windows binaries only; and selects the browser-specific V8 snapshot only when that artifact exists. All fuse options are explicit, and newly introduced fuses cause a hard failure.

The development binary lacks the browser-specific snapshot, so flipping that fuse there breaks startup, and Smart App Control blocks a modified binary; the script therefore refuses unpackaged targets. Task 012 owns ASAR creation, Windows integrity metadata, signing, and applying the script to distributable binaries.

## Verification

Node tests exercise hostile IPC identities and URLs, default permission/device/download/network denial, and protocol host/method/type/traversal/junction restrictions and CSP headers. The Electron integration script checks the real renderer, isolation, permissions, CSP, navigation, popups, and theme captures when execution is permitted. Run npm run build, npm run test:security, and npm run verify:window.

Native startup and both themes were verified on Windows on 2026-10-01. Linux startup and the Windows and Linux CI jobs have not run yet.
