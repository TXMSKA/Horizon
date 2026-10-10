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
3. The Release workflow runs the checks, then builds the Windows installer on Windows and the AppImage and deb package on Linux. It creates a draft release in `TXMSKA/Horizon` and uploads the installers, blockmaps and update metadata (`latest.yml`, `latest-linux.yml`). When signing is enabled, it first verifies the version tag and its ancestry on the default branch and prepares the draft. Otherwise electron-builder creates the draft through the existing unsigned path, and Windows appends the unsigned notice after uploading. Draft creation and uploads use the run's own `GITHUB_TOKEN`; only `prepare` and `release` have `contents: write`, and `release` also has `actions: read` so SignPath can read its workflow artifacts. The existing platform matrix is retained, so that read-only artifact permission also applies to Linux. Nothing publishes the release.
4. The owner reviews the draft and publishes it. Installers are downloaded from the GitHub releases of `TXMSKA/Horizon`, and installed builds find the update there only after the draft is published.

Builds are experimental. Until SignPath grants the project, leave the repository variable `SIGNPATH_ENABLED` unset. Packaging and publishing use the existing `electron-builder --publish always` path, and the draft notes include `This build is not code-signed yet`. Windows SmartScreen and Smart App Control can warn about or block unsigned installers and apps.

After the grant, configure SignPath project `horizon`, policy `release-signing`, and ZIP artifact configurations `executables` and `installer`. `executables` preserves the entire uploaded `release/win-unpacked` layout and signs only Horizon's own `Horizon.exe`; upstream Electron executables and DLLs are not signed under Horizon's certificate. `installer` signs the single NSIS executable. Enforce product name `Horizon` and the release's product version on signed files, require manual approval of every request, and restrict the signing policy's allowed branch names to the repository's default branch. Team members need MFA for GitHub and SignPath. Install the SignPath GitHub App and configure branch and tag rulesets against ref deletion and non-fast-forward updates, as required by `.signpath/policies/horizon/release-signing.yml`. These service and repository settings must be configured by the owner.

Set `vars.SIGNPATH_ORGANIZATION_ID`, store a submitter-only `secrets.SIGNPATH_API_TOKEN`, then set `vars.SIGNPATH_ENABLED` to `true`. Only the Windows tag-release steps in `TXMSKA/Horizon` use that secret. SignPath's action is pinned to v3 commit `f6d04783b4569d051e0c80105fe66e82819d0092`. It submits the workflow artifact, waits up to two hours per request for manual approval and downloads the signed artifact; reruns are refused by the pipeline policy, so use a new release build if a request times out.

The signing path builds `--dir --publish never` with `build/electron-builder.signpath.yml`, uploads the unpacked folder, signs it, verifies the returned Horizon executable's signature, then builds NSIS with `--prepackaged` from that signed folder. Fuses are flipped before signing and the prepackaged app is preserved. The signing config names the installer `Horizon-Setup-${version}.exe` so the local filename, GitHub asset and metadata agree when uploading directly with `gh`. It signs the installer separately and verifies that signature before upload. `scripts/signed-update-metadata.cjs` uses electron-builder's `app-builder-lib/out/targets/blockmap/blockmap.buildBlockMap` in external gzip mode to recreate the blockmap and both SHA-512/size entries in `latest.yml` from the final signed bytes. The signed installer, blockmap and metadata are uploaded to the draft with the run token.

electron-builder 26.15.3 uses `win.signtoolOptions.publisherName` for the former `win.publisherName` option. Only the signing config sets `SignPath Foundation`. Since directory builds do not generate `app-update.yml`, the existing after-pack hook calls `scripts/signpath-app-update.cjs` to write it with electron-builder's own publish configuration resolver before uploading the folder for signing. This embeds the GitHub feed and `publisherName` in `resources/app-update.yml` so electron-updater verifies subsequent Windows updates. Unsigned builds omit the name so their unsigned updates remain installable. The draft notes for signed Windows releases include `Free code signing provided by SignPath.io, certificate by SignPath Foundation`; Linux packaging is unchanged and those packages remain unsigned. Before publishing, review the notes and signatures of both Windows executables.

Installed builds check for updates a few seconds after start and every four hours while Settings, General, "Check for updates automatically" is on (the default). Turning it off cancels those automatic checks. About's "Check now" remains available. This preference stays on the installation and is excluded from settings sync. Updates download in the background and install when Horizon quits or when Restart is chosen in About. Linux updates work for the AppImage and the deb package only.

To prove the update path locally, run a packaged build with `HORIZON_UPDATE_URL` set to an `http://127.0.0.1` or `http://localhost` address that serves a newer `latest.yml` and installer. Other addresses are ignored, and development builds never check for updates.
