# Horizon

Task 001 provides the static Electron shell and start page. Browsing, notebooks,
profiles, and Lyra controls are previews; only native window controls operate.

Use Node.js 24 or 26 and npm 11.19 or newer. Verification used Node.js 26.8.2 and
npm 11.19.1. Windows and Linux are the application targets.

## Run

From the repository on Windows PowerShell:

```powershell
npm.cmd ci
npm.cmd run setup:electron
npm.cmd run setup:gitleaks
git config --local core.hooksPath .githooks
npm.cmd run build
npm.cmd start
```

On Linux, use `npm` in place of `npm.cmd`. Electron also needs the system
libraries required by its official Linux distribution.

`npm run dev` watches the renderer and Electron sources, builds them, and
restarts the window. It deliberately serves built assets over `horizon://`
instead of exposing a Vite development server, so the production CSP applies.

```text
npm run lint
npm run typecheck
npm run build
npm run test:security
npm run check:contrast
npm run scan:secrets
npm run verify:window
```

The last command runs the actual window checks and captures both themes under
`.runtime/screenshots/`. It requires an environment that permits Electron
to run. Browser state, tools, and verification artifacts remain in `.runtime/`
during development; npm and Electron download caches remain in `.npm-cache/`.

The foundation has no application environment variables and does not load
environment files. `.env.example` records that empty configuration.

Amber and Daylight follow the system theme. Language follows Electron's system
locale: Spanish or English, with English for other locales. A manual theme
selector is deferred by the task brief's explicit system-theme decision.

The permission, protocol, preload, and fuse boundaries are documented in
[the Electron checklist](docs/security/electron-checklist.md).
The dependency and installer review is in
[dependencies](docs/security/dependencies.md).

## Packaging boundary

Task 012 applies `npm run fuses -- <packaged-binary>` after packaging and before
code signing. Windows packaging must embed ASAR integrity metadata first.
Linux does not enable the unsupported embedded-ASAR-integrity fuse.
The stock development binary stays unmodified. Windows Smart App Control blocks
it because it is unsigned, so development on Windows needs Smart App Control off.
