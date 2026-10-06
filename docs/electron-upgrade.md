# Electron upgrades and releases

## Electron upgrades

Electron supports the latest three major versions. Horizon stays on the newest major that has a patch older than seven days, matching `min-release-age` in `.npmrc`.

For a new patch of the current major:

1. Bump `electron` in `package.json` to the newest patch published at least seven days ago, with an exact version.
2. Run `npm run lint`, `npm run typecheck`, `npm run build` and `npm run test:security`.
3. Release as a new version (see Releasing).

For a new major:

1. Read the breaking changes for that major in the Electron release notes and check them against `electron/`, the preload and the security checklist in `docs/security/electron-checklist.md`.
2. Bump `electron` to the newest patch of the new major that satisfies the age floor.
3. Run `npm run lint`, `npm run typecheck`, `npm run build` and `npm run test:security`.
4. Rebuild the installers with `npm run dist:win` and, on Linux, `npm run dist:linux`.
5. Read back the fuse wire of each packaged binary with `getCurrentFuseWire` from `@electron/fuses`. Expected values, in order: runAsNode off, cookie encryption on, NODE_OPTIONS off, node inspect arguments off, embedded ASAR integrity on for Windows and off for Linux, only load app from ASAR on, browser V8 snapshot only when `browser_v8_context_snapshot.bin` exists, file protocol privileges off, wasm trap handlers on. `scripts/after-pack.cjs` sets them during packaging.
6. Check the off-screen behaviour: a window moved or restored onto a display that is no longer connected must open inside a visible work area.
7. Release as a new version tag.

## Releasing

1. Set `version` in `package.json` and merge the change to `master`.
2. Tag the merge commit as `vX.Y.Z`, matching `version`, and push the tag.
3. The Release workflow runs the checks, then builds the Windows installer on Windows and the AppImage and deb package on Linux. It creates a draft release in `TXMSKA/horizon-releases` and uploads the installers and the update metadata (`latest.yml`, `latest-linux.yml`). The upload uses the `HORIZON_RELEASES_TOKEN` secret, which is set only on that step.
4. A person reviews the draft and publishes it. Installed builds find the update only after the draft is published.

Builds are unsigned and experimental. Windows SmartScreen and Smart App Control warn about or block the installer and the installed app.

Installed builds check for updates a few seconds after start and every four hours, download in the background and install when Horizon quits or when Restart is chosen in About. Linux updates work for the AppImage and the deb package only.

To prove the update path locally, run a packaged build with `HORIZON_UPDATE_URL` set to an `http://127.0.0.1` or `http://localhost` address that serves a newer `latest.yml` and installer. Other addresses are ignored, and development builds never check for updates.
