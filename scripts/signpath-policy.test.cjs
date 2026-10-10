const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const yaml = require('js-yaml');
const { signedUpdateMetadata } = require('./signed-update-metadata.cjs');
const { writeSignedAppUpdate } = require('./signpath-app-update.cjs');

const read = path => readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');
const workflow = yaml.load(read('.github/workflows/release.yml'));
const signingCondition = "runner.os == 'Windows' && vars.SIGNPATH_ENABLED == 'true'";
const signpathAction = 'signpath/github-action-submit-signing-request@f6d04783b4569d051e0c80105fe66e82819d0092';

test('NSIS shows the privacy policy as plain text and preserves assisted per-user installer options', () => {
  const config = yaml.load(read('electron-builder.yml'));
  assert.equal(config.nsis.license, 'build/privacy.txt');
  // The installer page is PRIVACY.md without its Markdown marks, so the two cannot drift apart.
  const privacy = read('PRIVACY.md').replace(/\*\*/g, '').replace(/^#{1,2} /gm, '').trim();
  assert.equal(read(config.nsis.license).trim(), privacy);
  assert.ok(read('README.md').includes('[privacy policy](PRIVACY.md)'));
  assert.deepEqual(config.nsis, {
    license: 'build/privacy.txt', oneClick: false, perMachine: false, allowElevation: true,
    allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true,
    shortcutName: 'Horizon', deleteAppDataOnUninstall: false,
  });
});

test('SignPath pipeline policy requires hosted builds without reruns and protected refs', () => {
  const policy = yaml.load(read('.signpath/policies/horizon/release-signing.yml'));
  assert.deepEqual(policy, {
    'github-build-policies': { version: '1.0', disallow_reruns: true, runners: { require_github_hosted: true } },
    'github-scm-policies': { version: '1.0', ruleset_constraints: [{ enforced_from: 'CURRENT_BUILD', allow_bypass_actors: true,
      rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }] }] },
  });
  const tagCheck = workflow.jobs.prepare.steps.find(step => step.name === 'Check the tag');
  for (const step of workflow.jobs.prepare.steps) assert.equal(step.if, "vars.SIGNPATH_ENABLED == 'true'");
  assert.match(tagCheck.run, /git merge-base --is-ancestor/);
  assert.match(tagCheck.run, /GITHUB_REF_NAME.*v\$version/);
  assert.equal(tagCheck.env.DEFAULT_BRANCH, '${{ github.event.repository.default_branch }}');
});

test('Release actions are immutable and token permissions are limited to publishing and artifact reads', () => {
  assert.deepEqual(workflow.on, { push: { tags: ['v*'] } });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.prepare.permissions, { contents: 'write' });
  assert.deepEqual(workflow.jobs.release.permissions, { contents: 'write', actions: 'read' });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.if, "github.repository == 'TXMSKA/Horizon'");
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
    }
  }
  assert.equal(workflow.jobs.prepare['runs-on'], 'ubuntu-latest');
  assert.deepEqual(workflow.jobs.release.strategy.matrix.os, ['windows-latest', 'ubuntu-latest']);
});

test('SignPath token exists only in opt-in Windows signing steps and is absent from PR and fork paths', () => {
  const steps = Object.values(workflow.jobs).flatMap(job => job.steps);
  const secretSteps = steps.filter(step => JSON.stringify(step).includes('SIGNPATH_API_TOKEN'));
  assert.equal(secretSteps.length, 2);
  assert.equal(JSON.stringify(workflow.env ?? {}).includes('SIGNPATH_API_TOKEN'), false);
  for (const job of Object.values(workflow.jobs)) assert.equal(JSON.stringify(job.env ?? {}).includes('SIGNPATH_API_TOKEN'), false);
  for (const step of secretSteps) {
    assert.equal(step.uses, signpathAction);
    assert.equal(step.if, signingCondition);
    assert.equal(step.with['api-token'], '${{ secrets.SIGNPATH_API_TOKEN }}');
    assert.equal(step.with['organization-id'], '${{ vars.SIGNPATH_ORGANIZATION_ID }}');
    assert.equal(step.with['project-slug'], 'horizon');
    assert.equal(step.with['signing-policy-slug'], 'release-signing');
    assert.equal(step.with['wait-for-completion'], true);
    assert.ok(step.with['output-artifact-directory']);
    assert.equal(JSON.stringify(step.env ?? {}).includes('SIGNPATH_API_TOKEN'), false);
    for (const os of ['Windows', 'Linux']) for (const enabled of ['', undefined, 'false', 'TRUE', 'true']) {
      const expression = step.if.replace('runner.os', 'os').replace('vars.SIGNPATH_ENABLED', 'enabled');
      assert.equal(new Function('os', 'enabled', 'return ' + expression)(os, enabled), os === 'Windows' && enabled === 'true');
    }
  }
  assert.deepEqual(secretSteps.map(step => step.with['artifact-configuration-slug']), ['executables', 'installer']);
});

test('Signed release builds and signs the folder then installer before metadata and publishing', () => {
  const steps = workflow.jobs.release.steps;
  const unsigned = steps.find(step => step.run === 'npx electron-builder --publish always');
  assert.equal(unsigned.if, "runner.os != 'Windows' || vars.SIGNPATH_ENABLED != 'true'");
  const signed = steps.filter(step => step.if === signingCondition);
  assert.deepEqual(signed.map(step => step.name), [
    'Build the Windows folder for signing', 'Upload the Windows folder to sign', 'Sign the executables',
    'Build the installer from the signed folder', 'Upload the installer to sign', 'Sign the installer',
    'Recompute the signed installer metadata', 'Upload the signed Windows release files',
  ]);
  assert.match(signed[0].run, /--dir --publish never --config build\/electron-builder.signpath.yml/);
  assert.equal(signed[1].with.path, 'release/win-unpacked');
  assert.equal(signed[2].with['github-artifact-id'], '${{ steps.programs.outputs.artifact-id }}');
  assert.match(signed[3].run, /--prepackaged release\/programs-signed --publish never/);
  assert.match(signed[3].run, /Get-AuthenticodeSignature/);
  assert.equal(signed[5].with['github-artifact-id'], '${{ steps.installer.outputs.artifact-id }}');
  assert.match(signed[6].run, /Get-AuthenticodeSignature/);
  assert.match(signed[6].run, /node scripts\/signed-update-metadata.cjs release/);
  assert.match(signed[7].run, /gh release upload/);
  assert.equal(signed[7].env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  const notes = workflow.jobs.prepare.steps.find(step => step.name === 'Prepare the draft release notes');
  assert.match(notes.run, /Free code signing provided by SignPath.io, certificate by SignPath Foundation/);
  assert.match(notes.run, /This build is not code-signed yet/);
  assert.match(notes.run, /--draft --verify-tag/);
  assert.match(notes.run, /if \(!draft.isDraft\) process.exit\(1\)/);
  const unsignedNotes = steps.find(step => step.name === 'Add the unsigned release notice');
  assert.equal(unsignedNotes.if, "runner.os == 'Windows' && vars.SIGNPATH_ENABLED != 'true'");
  assert.ok(steps.indexOf(unsignedNotes) > steps.indexOf(unsigned));
  assert.match(unsignedNotes.run, /This build is not code-signed yet/);
  assert.match(unsignedNotes.run, /Expected the draft release created by electron-builder/);
});

test('Publisher verification is configured only for signed builds with the installed builder schema', () => {
  const base = yaml.load(read('electron-builder.yml'));
  const signed = yaml.load(read('build/electron-builder.signpath.yml'));
  assert.equal(signed.extends, 'electron-builder.yml');
  assert.equal(signed.nsis.artifactName, 'Horizon-Setup-${version}.${ext}');
  assert.equal(base.win.publisherName, undefined);
  assert.equal(base.win.signtoolOptions?.publisherName, undefined);
  assert.equal(signed.win.signtoolOptions.publisherName, 'SignPath Foundation');
  const schema = require('app-builder-lib/scheme.json');
  assert.ok(schema.definitions.WindowsConfiguration.properties.signtoolOptions);
  assert.ok(schema.definitions.WindowsSigntoolConfiguration.properties.publisherName);
  assert.notEqual(base.win.verifyUpdateCodeSignature, false);
});

test('Signed update metadata and external blockmap describe the final installer bytes', async t => {
  mkdirSync(resolve('.runtime'), { recursive: true });
  const directory = mkdtempSync(join(resolve('.runtime'), 'signed-metadata-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = 'Horizon Setup 0.1.1.exe';
  const bytes = Buffer.concat([Buffer.alloc(70000, 91), Buffer.from('synthetic appended signature')]);
  writeFileSync(join(directory, path), bytes);
  writeFileSync(join(directory, path + '.blockmap'), 'stale');
  writeFileSync(join(directory, 'latest.yml'), yaml.dump({ version: '0.1.1', path, sha512: 'stale',
    files: [{ url: path, sha512: 'stale', size: 1 }], releaseDate: '2026-10-10T00:00:00.000Z' }));
  await signedUpdateMetadata(directory);
  const metadata = yaml.load(readFileSync(join(directory, 'latest.yml'), 'utf8'));
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  assert.equal(metadata.sha512, sha512);
  assert.equal(metadata.size, bytes.length);
  assert.deepEqual(metadata.files, [{ url: path, sha512, size: bytes.length }]);
  assert.equal(metadata.releaseDate, '2026-10-10T00:00:00.000Z');
  assert.deepEqual(readFileSync(join(directory, path)), bytes);
  const map = JSON.parse(gunzipSync(readFileSync(join(directory, path + '.blockmap'))));
  assert.equal(map.version, '2');
  assert.equal(map.files[0].sizes.reduce((sum, size) => sum + size, 0), bytes.length);
  assert.equal(map.files[0].checksums.length, map.files[0].sizes.length);
  writeFileSync(join(directory, 'latest.yml'), yaml.dump({ path: '../outside.exe', files: [{ url: '../outside.exe' }] }));
  await assert.rejects(signedUpdateMetadata(directory), /Expected one NSIS installer/);
});

test('Directory builds embed the signed GitHub feed before signing and unsigned builds omit it', async t => {
  mkdirSync(resolve('.runtime'), { recursive: true });
  const directory = mkdtempSync(join(resolve('.runtime'), 'signed-app-update-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'resources'));
  const config = yaml.load(read('electron-builder.yml'));
  const { Platform } = require('app-builder-lib');
  const info = { config, appInfo: { channel: null, updaterCacheDirName: 'horizon-updater' } };
  const packager = { config, info, appInfo: info.appInfo, platform: Platform.WINDOWS,
    platformSpecificBuildOptions: { ...config.win, signtoolOptions: { publisherName: 'SignPath Foundation' } },
    isForceCodeSigningVerification: true, expandMacro: value => value,
    signingManager: { value: Promise.resolve({ computedPublisherName: { value: Promise.resolve(['SignPath Foundation']) } }) },
  };
  const context = { electronPlatformName: 'win32', appOutDir: directory, packager, arch: 1, targets: [{ name: 'dir' }] };
  await writeSignedAppUpdate(context);
  assert.deepEqual(yaml.load(readFileSync(join(directory, 'resources/app-update.yml'), 'utf8')), {
    ...config.publish, updaterCacheDirName: 'horizon-updater', publisherName: ['SignPath Foundation'],
  });
  rmSync(join(directory, 'resources/app-update.yml'));
  packager.platformSpecificBuildOptions = config.win;
  await writeSignedAppUpdate(context);
  assert.throws(() => readFileSync(join(directory, 'resources/app-update.yml')), /ENOENT/);
  assert.match(read('scripts/after-pack.cjs'), /await writeSignedAppUpdate\(context\)/);
});
