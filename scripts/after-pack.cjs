const { existsSync } = require('node:fs');
const { join } = require('node:path');

// Flips the Electron fuses on the packed binary before code signing, with the same values as scripts/fuses.mjs.
exports.default = async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const windows = context.electronPlatformName === 'win32';
  const binary = join(context.appOutDir, windows ? `${context.packager.appInfo.productFilename}.exe` : context.packager.executableName);
  if (!existsSync(join(context.appOutDir, 'resources/app.asar'))) throw new Error('Packaged fuses require resources/app.asar beside the binary.');
  await flipFuses(binary, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: windows,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: existsSync(join(context.appOutDir, 'browser_v8_context_snapshot.bin')),
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  });
};
