// Regression tests for the mislabeled-update guard: an installer whose bundle
// reports a version different from the version recorded by the download
// sidecar must be refused before ANY macOS install path touches the installed
// app — the silent swap and the interactive fallback alike. A guard on one path
// only is no guard: the renderer moves to `ready` on every silent-apply failure,
// so the user's next Install click would have installed the very DMG the silent
// path had just refused.
//
// v1.0.1 shipped a bundle whose Info.plist still said 1.0.0, so the client kept
// judging itself outdated and re-downloaded the same 413 MB installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');

// --- compiled-module behavior tests (electron stubbed, like appUpdateMountPoint) ---
const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => '/tmp',
        relaunch: () => {},
        quit: () => {},
      },
      session: {
        defaultSession: {
          fetch: async () => {
            throw new Error('fetch not stubbed');
          },
        },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const installer = require('../dist-electron/main/libs/appUpdateInstaller.js');
Module._load = originalLoad;

test('resolveDownloadMetaPath maps dmg/exe/extension-less installers to their sidecar', () => {
  assert.equal(
    installer.resolveDownloadMetaPath('/var/folders/xy/T/idbots-update-abc123.dmg'),
    '/var/folders/xy/T/idbots-update-abc123.meta.json',
  );

  assert.equal(
    installer.resolveDownloadMetaPath('C:\\Users\\bot\\AppData\\Local\\Temp\\idbots-update-abc123.exe'),
    'C:\\Users\\bot\\AppData\\Local\\Temp\\idbots-update-abc123.meta.json',
  );

  assert.equal(
    installer.resolveDownloadMetaPath('/tmp/idbots-update-abc123'),
    '/tmp/idbots-update-abc123.meta.json',
  );

  // Dots in parent directories are not the file extension
  assert.equal(
    installer.resolveDownloadMetaPath('/tmp/v1.2.3/idbots-update-abc123.dmg'),
    '/tmp/v1.2.3/idbots-update-abc123.meta.json',
  );
});

test('resolveDownloadMetaPath agrees with the downloader sidecar naming', () => {
  const stableId = installer.computeStableDownloadId('https://example.com/IDBots-1.0.2-arm64.dmg', '1.0.2');
  const finalPath = `/tmp/idbots-update-${stableId}.dmg`;
  assert.equal(
    installer.resolveDownloadMetaPath(finalPath),
    `/tmp/idbots-update-${stableId}.meta.json`,
  );
});

// The guard shells out to plutil, so the real behavior can only run on macOS;
// the fake bundle is a bare Contents/Info.plist, which is all plutil reads.
const writeFakeBundle = (appPath, version) => {
  fs.mkdirSync(path.join(appPath, 'Contents'), { recursive: true });
  fs.writeFileSync(
    path.join(appPath, 'Contents', 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleShortVersionString</key>',
      `  <string>${version}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );
};

test(
  'assertInstallerBundleVersion refuses a mismatch, passes a match, skips without a sidecar',
  { skip: process.platform === 'darwin' ? false : 'plutil is macOS-only' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-bundle-guard-'));
    try {
      const installerPath = path.join(dir, 'idbots-update-0123456789abcdef.dmg');
      const metaPath = installer.resolveDownloadMetaPath(installerPath);
      const sourceApp = path.join(dir, 'IDBots.app');
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          url: 'https://example.com/IDBots-1.0.3-arm64.dmg',
          version: '1.0.3',
          platform: process.platform,
          arch: process.arch,
          downloadedSize: 1,
          updatedAt: Date.now(),
        }),
      );

      // The v1.0.1 shape: the manifest says one version, the bundle another.
      writeFakeBundle(sourceApp, '1.0.2');
      await assert.rejects(
        installer.assertInstallerBundleVersion(installerPath, sourceApp),
        /Refusing to install a mislabeled update: the bundle reports 1\.0\.2 but the update manifest declares 1\.0\.3/,
      );

      writeFakeBundle(sourceApp, '1.0.3');
      await installer.assertInstallerBundleVersion(installerPath, sourceApp);

      // No sidecar (hand-copied installer): legacy behavior, nothing is checked.
      fs.unlinkSync(metaPath);
      writeFakeBundle(sourceApp, '0.0.1');
      await installer.assertInstallerBundleVersion(installerPath, sourceApp);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// --- source-level assertions (hdiutil is never executed in tests) ---
const source = fs.readFileSync(path.join(repoRoot, 'src/main/libs/appUpdateInstaller.ts'), 'utf8');

function extractFunctionBody(sourceText, startMarker, endMarker) {
  const start = sourceText.indexOf(startMarker);
  assert.ok(start !== -1, `missing function start: ${startMarker}`);
  const end = sourceText.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `missing end marker: ${endMarker}`);
  return sourceText.slice(start, end);
}

const guardBody = () => extractFunctionBody(
  source,
  'export async function assertInstallerBundleVersion',
  'export async function cleanupStaleDownloads',
);
const silentBody = () => extractFunctionBody(
  source,
  'export async function applyMacUpdateSilently',
  'async function installWindowsNsis',
);
const interactiveBody = () => extractFunctionBody(
  source,
  'async function installMacDmg',
  'export async function relaunchPendingMacUpdate',
);

test('readMacBundleVersion reads the bundle self-reported version via plutil', () => {
  assert.match(source, /export async function readMacBundleVersion\(appPath: string\): Promise<string>/);
  assert.match(source, /path\.join\(appPath, 'Contents', 'Info\.plist'\)/);
  assert.match(source, /plutil -extract CFBundleShortVersionString raw/);
  assert.match(source, /reports no CFBundleShortVersionString/);
});

test('assertInstallerBundleVersion compares sidecar and bundle, and skips without a sidecar', () => {
  const body = guardBody();
  assert.match(body, /const declaredVersion = await readDeclaredInstallerVersion\(installerPath\)/);
  assert.match(body, /const incomingVersion = await readMacBundleVersion\(sourceApp\)/);
  assert.match(body, /if \(incomingVersion !== declaredVersion\) \{/);
  assert.match(
    body,
    /Refusing to install a mislabeled update: the bundle reports \$\{incomingVersion\} but the update manifest declares \$\{declaredVersion\}/,
  );

  const skipIdx = body.indexOf('if (!declaredVersion) {');
  assert.ok(skipIdx !== -1, 'absent-sidecar branch is missing');
  const checkIdx = body.indexOf('const incomingVersion');
  assert.ok(checkIdx > skipIdx, 'the sidecar check must precede the bundle read');
  const skipBranch = body.slice(skipIdx, checkIdx);
  assert.match(skipBranch, /skipping bundle version check/);
  assert.doesNotMatch(skipBranch, /throw /);
});

test('applyMacUpdateSilently runs the guard after mounting and before the swap', () => {
  const body = silentBody();
  assert.match(body, /await assertInstallerBundleVersion\(dmgPath, sourceApp\)/);

  // The gate must run after the DMG is mounted and before the swap touches the
  // installed app; the swap still copies the very sourceApp that was checked.
  const mountIdx = body.indexOf('hdiutil attach');
  const checkIdx = body.indexOf('assertInstallerBundleVersion(dmgPath, sourceApp)');
  const swapIdx = body.indexOf('idbots-new-');
  assert.ok(mountIdx !== -1, 'DMG mount step missing');
  assert.ok(checkIdx > mountIdx, 'version check must run after mounting the DMG');
  assert.ok(swapIdx !== -1, 'silent swap step missing');
  assert.ok(checkIdx < swapIdx, 'version check must run before the swap starts');
  assert.match(body, /cp -R \$\{shellEscape\(sourceApp\)\}/);
});

test('installMacDmg (interactive fallback) runs the same guard before the copy', () => {
  const body = interactiveBody();
  assert.match(body, /await assertInstallerBundleVersion\(dmgPath, sourceApp\)/);

  const mountIdx = body.indexOf('hdiutil attach');
  const checkIdx = body.indexOf('assertInstallerBundleVersion(dmgPath, sourceApp)');
  const copyIdx = body.indexOf('rm -rf ${shellEscape(targetApp)} && cp -R');
  assert.ok(mountIdx !== -1, 'DMG mount step missing');
  assert.ok(checkIdx > mountIdx, 'version check must run after mounting the DMG');
  assert.ok(copyIdx !== -1, 'interactive copy step missing');
  assert.ok(checkIdx < copyIdx, 'version check must run before the installed app is removed');

  // A refusal throws after the mount, so the error path must still detach.
  const catchIdx = body.indexOf('} catch (error) {');
  assert.ok(catchIdx > checkIdx, 'outer error handler must follow the guard');
  assert.match(body.slice(catchIdx), /hdiutil detach/);
});

test('both macOS install paths share one guard, so they cannot drift apart', () => {
  const refusals = source.split('Refusing to install a mislabeled update').length - 1;
  // macOS refuses inside assertInstallerBundleVersion ("the bundle reports");
  // the Windows twin (13f7dc08c) repeats the refusal with "the installer
  // reports" wording — one refusal site per platform, two in this file.
  assert.equal(refusals, 2, 'one refusal site per platform: macOS bundle guard + Windows installer twin');
  assert.doesNotMatch(silentBody(), /readDeclaredInstallerVersion|readMacBundleVersion/);
  assert.doesNotMatch(interactiveBody(), /readDeclaredInstallerVersion|readMacBundleVersion/);
  assert.equal(
    source.split('await assertInstallerBundleVersion(dmgPath, sourceApp)').length - 1,
    2,
    'exactly the two macOS install paths call the guard',
  );
});
