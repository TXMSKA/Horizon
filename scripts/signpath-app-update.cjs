const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const yaml = require('js-yaml');
const { getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager');

async function writeSignedAppUpdate(context) {
  if (context.electronPlatformName !== 'win32'
    || context.packager.platformSpecificBuildOptions.signtoolOptions?.publisherName !== 'SignPath Foundation') return;
  // --dir has no NSIS target, so PublishManager skips this file; --prepackaged
  // also skips afterPack. Generate it before signing with the builder's own resolver.
  const config = await getAppUpdatePublishConfiguration(context.packager, null, context.arch, false);
  if (config?.provider !== 'github' || config.owner !== 'TXMSKA' || config.repo !== 'Horizon'
    || !Array.isArray(config.publisherName) || config.publisherName.length !== 1
    || config.publisherName[0] !== 'SignPath Foundation') throw new Error('Signed update configuration is invalid.');
  await writeFile(join(context.appOutDir, 'resources/app-update.yml'), yaml.dump(config));
}

module.exports = { writeSignedAppUpdate };
