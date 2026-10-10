const { readFile, writeFile } = require('node:fs/promises');
const { basename, resolve } = require('node:path');
const yaml = require('js-yaml');
// Use the same external gzip blockmap generator as electron-builder's NSIS target.
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

async function signedUpdateMetadata(directory) {
  const metadataPath = resolve(directory, 'latest.yml');
  const metadata = yaml.load(await readFile(metadataPath, 'utf8'));
  if (!metadata || typeof metadata.path !== 'string' || basename(metadata.path) !== metadata.path
    || !metadata.path.endsWith('.exe') || !Array.isArray(metadata.files) || metadata.files.length !== 1
    || metadata.files[0].url !== metadata.path) throw new Error('Expected one NSIS installer in latest.yml.');
  const installer = resolve(directory, metadata.path);
  const { sha512, size } = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`);
  metadata.sha512 = sha512;
  metadata.size = size;
  metadata.files[0].sha512 = sha512;
  metadata.files[0].size = size;
  await writeFile(metadataPath, yaml.dump(metadata));
}

module.exports = { signedUpdateMetadata };
if (require.main === module) {
  signedUpdateMetadata(process.argv[2] ?? 'release').catch(error => { console.error(error); process.exitCode = 1; });
}
