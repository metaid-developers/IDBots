import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAndroidEntry, mergeAndroidUpdateManifest, readAndroidVersion } from '../scripts/create-android-release-metadata.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Android 0.1.7 uses native update checks and the existing versioned download channel', () => {
  assert.deepEqual(readAndroidVersion(), { versionCode: 9, versionName: '0.1.7' });
  const activity = read('../android/app/src/main/java/com/idbots/world/MainActivity.java');
  assert.match(activity, /new AppUpdateManager\(this\)/);
  assert.match(activity, /appUpdateManager\.onResume\(\)/);
  assert.match(activity, /appUpdateManager\.onPause\(\)/);
  const manager = read('../android/app/src/main/java/com/idbots/world/AppUpdateManager.java');
  assert.match(manager, /https:\/\/idbots\.ai\/update\.json/);
  assert.match(manager, /DownloadManager\.Request/);
  assert.match(manager, /RECEIVER_NOT_EXPORTED/);
  assert.match(manager, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  const paths = read('../android/app/src/main/res/xml/file_paths.xml');
  assert.match(paths, /external-files-path[^>]+Download\/updates\//);
  const verifier = read('../android/app/src/main/java/com/idbots/world/AppUpdateVerifier.java');
  assert.match(verifier, /GET_SIGNING_CERTIFICATES/);
  assert.match(verifier, /expected\.equals\(actual\)/);
  assert.match(read('../android/app/src/main/res/values/strings.xml'), /Update available/);
  assert.match(read('../android/app/src/main/res/values-zh-rCN/strings.xml'), /发现新版本/);
});

test('release metadata hashes the exact APK and preserves the desktop manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idbots-update-metadata-'));
  try {
    const apk = join(directory, 'IDBots-Android-0.1.7.apk');
    writeFileSync(apk, 'apk-content');
    const release = JSON.parse(read('../release-notes/android-release.json'));
    const entry = createAndroidEntry(apk, release);
    assert.equal(entry.version, '0.1.7');
    assert.equal(entry.versionCode, 9);
    assert.equal(entry.size, 11);
    assert.equal(entry.sha256, 'cb580f7f3dff3a02ab5053988c8dc92131ebc051d671c4b4efe8cc39b4768353');
    assert.equal(entry.url, 'https://app.idbots.world/downloads/IDBots-Android-0.1.7.apk');
    const desktop = { code: 0, data: { value: { version: '1.1.1', macArm: { url: 'https://download.idbots.ai/mac.dmg' } } } };
    const merged = mergeAndroidUpdateManifest(desktop, entry);
    assert.equal(merged.data.value.version, '1.1.1');
    assert.deepEqual(merged.data.value.macArm, desktop.data.value.macArm);
    assert.equal(merged.data.value.android, entry);
    assert.equal(desktop.data.value.android, undefined);
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});

test('release metadata rejects malformed manifests and missing versions', () => {
  assert.throws(() => mergeAndroidUpdateManifest({}, {}), /Invalid base update manifest/);
  assert.throws(() => readAndroidVersion('android {}'), /Android version is missing/);
});
