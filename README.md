# Horizon

Horizon is a web browser for Windows and Linux. Browsing works with tabs,
history, bookmarks, downloads, find, page zoom and a page context menu.
Profiles keep their tabs, history, bookmarks and sign-ins separate in the
same window. Personal keeps existing sign-ins; Work starts separately.
Profiles can be created, renamed, recoloured, switched and deleted.

Amber and Daylight are app-wide themes. Choose either one or System, with
an optional high-contrast palette. Language follows the system locale
(Spanish or English, with English for other locales) unless one is chosen
in Settings.

The three-dot menu holds the browser's own tools: zoom and fullscreen (F11),
find, the Favorites, History and Downloads panels, Settings and About.

The Hub, next to the profile avatar, holds Horizon's apps; Themes is the
first, and any app can be pinned to the toolbar as quick access. The avatar
opens the profiles.

Settings opens in a tab from the menu: the default browser, the search
engine (DuckDuckGo unless another is chosen), the downloads folder, the
language, the theme and dark pages, blocking and third-party cookies, the
sites with their own settings, clearing browsing data now or when Horizon
closes, and profiles. Only the installed app registers Horizon as a browser,
and only for the current user.

Notebooks keep personal notes, selected text, area captures and whole-page
captures locally, with encrypted capture images. Resume a notebook from the
start page or find it through the address bar. Lyra is still a preview.

## Run

Use Node.js 24 or 26 and npm 11.19 or newer. Verification used Node.js 26.8.2
and npm 11.19.1. From the repository in Windows PowerShell:

```powershell
npm.cmd ci
npm.cmd run setup:electron
npm.cmd run setup:gitleaks
git config --local core.hooksPath .githooks
npm.cmd run build
npm.cmd start
```

On Linux, use `npm` instead of `npm.cmd`. Electron needs the system libraries
required by its official Linux distribution.

`npm run dev` watches the renderer and Electron sources, builds them and
restarts the window. It serves built assets over `horizon://`, so the
production Content Security Policy also applies during development.

## Check

```text
npm run lint
npm run typecheck
npm run build
npm run test:security
npm run check:contrast
npm run scan:secrets
npm run verify:window
```

Build checks text and graphic contrast across all four palettes. Security
tests use temporary stores and mocked Electron sessions. `verify:window`
launches Electron and captures both themes in `.runtime/screenshots/`;
it needs an environment that permits Electron to run.

Development data and verification artifacts stay in `.runtime/`. Download
caches stay in `.npm-cache/`. The app has no application environment
variables and does not load environment files; `.env.example` records this.

## Security and packaging

Profile stores use Electron's `safeStorage` encryption when available.
Linux without a keyring uses plain JSON with owner-only permissions.
After a successful migration into Personal, the legacy `browser-store.json`
is renamed to owner-only `browser-store.json.migrated`, replacing any existing
archive so the original data can be recovered.
Session, storage, protocol and preload boundaries are documented in the
[Electron checklist](docs/security/electron-checklist.md). Dependency and
installer notes are in [dependencies](docs/security/dependencies.md).

Installer builds flip the Electron fuses during packaging in
`scripts/after-pack.cjs`; `npm run fuses -- <packaged-binary>` applies the same
values to an unsigned packaged binary by hand. Windows packaging embeds ASAR
integrity metadata first; Linux skips that unsupported fuse. The development
binary stays unmodified. Windows Smart App Control blocks it because it is
unsigned, so development on Windows needs Smart App Control off until signed
builds are available.

## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation, is
applied for. Until it is granted, the builds are unsigned and the release notes say so.

- Authors, reviewers and approvers: [TXMSKA](https://github.com/orgs/TXMSKA/people).
- Every release is approved by hand before it is signed and published.
- Only releases built by the release workflow from a tag on the default branch, on a
  GitHub-hosted runner, are submitted for signing.

## Privacy

Horizon collects no data about the people who use it and sends nothing about them
to TXMSKA. What it connects to, and why, is in the [privacy policy](PRIVACY.md).

## Installers

`npm run dist:win` builds the Windows installer and `npm run dist:linux` the
AppImage and deb package, in `release/`. Builds are unsigned and experimental.
Installers and updates come from the GitHub releases of TXMSKA/Horizon: the
release workflow publishes a draft with the run's token and the owner publishes
the draft. Installed builds update themselves from published releases. The
upgrade and release routine is in
[Electron upgrades and releases](docs/electron-upgrade.md).
