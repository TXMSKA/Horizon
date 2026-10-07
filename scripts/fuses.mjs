import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } from '@electron/fuses';

const target = process.argv[2];
if (!target) throw new Error('Pass a packaged Windows or Linux binary. Installer builds flip the same fuses in scripts/after-pack.cjs; run this on an unsigned binary only.');
const binary = resolve(target);
if (!existsSync(resolve(binary, '../resources/app.asar'))) {
  throw new Error('Packaged fuses require resources/app.asar beside the binary.');
}
// Windows must embed ASAR integrity metadata during packaging before this step.
await flipFuses(binary, {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: binary.toLowerCase().endsWith('.exe'),
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: existsSync(resolve(binary, '../browser_v8_context_snapshot.bin')),
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
});
console.log(JSON.stringify(await getCurrentFuseWire(binary), null, 2));
