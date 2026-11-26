import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('manual update checks clear throttling and preserve the automatic dismissal window', () => {
  const manager = read('../mobile-shell/android/app/src/main/java/com/idbots/world/AppUpdateManager.java');
  assert.match(manager, /void checkNow\(UpdateCheckListener listener\)/);
  assert.match(manager, /remove\(KEY_LAST_CHECK\).*remove\(KEY_DISMISSED_VERSION\).*remove\(KEY_DISMISSED_AT\)/);
  assert.match(manager, /notifyUpToDate\(\)/);
  assert.match(manager, /notifyUpdateAvailable\(\)/);
  assert.match(manager, /DISMISS_INTERVAL_MS = 24L \* 60L \* 60L \* 1000L/);
  assert.doesNotMatch(manager, /verifyUpdateForTest/);
});

test('the updater uses the private app directory and an identity-encoding direct downloader', () => {
  const manager = read('../mobile-shell/android/app/src/main/java/com/idbots/world/AppUpdateManager.java');
  const downloader = read('../mobile-shell/android/app/src/main/java/com/idbots/world/AppUpdateDownloader.java');
  assert.match(manager, /activity\.getFilesDir\(\)/);
  assert.doesNotMatch(manager, /DownloadManager|getExternalFilesDir/);
  assert.match(downloader, /Accept-Encoding", "identity"/);
  assert.match(downloader, /expectedBytes/);
  assert.match(downloader, /"Too many download redirects"/);
  assert.match(downloader, /"APK size does not match the manifest"/);
  assert.match(read('../mobile-shell/android/app/src/main/res/xml/file_paths.xml'), /files-path[^>]+updates\//);
  assert.match(read('../mobile-shell/android/app/src/main/res/values/strings.xml'), /update_failed_reason/);
  assert.match(read('../mobile-shell/android/app/src/main/res/values-zh-rCN/strings.xml'), /update_failed_reason/);
});

test('About exposes the native manual update action and bilingual states', () => {
  const about = read('../src/mobile/app/screens/me/AboutPage.tsx');
  const bootstrap = read('../mobile-shell/native/idbots-native-bootstrap.js');
  const plugin = read('../mobile-shell/android/app/src/main/java/com/idbots/world/NativeCapabilitiesPlugin.java');
  const i18n = read('../src/mobile/i18n.ts');
  assert.match(about, /data-testid="about-check-update"/);
  assert.match(about, /data-testid="about-update-status"/);
  assert.match(about, /adapter\.checkForUpdate\(\)/);
  assert.match(bootstrap, /updateChecks: hasNativeMethod\('checkForUpdate'\)/);
  assert.match(bootstrap, /checkForUpdate: async \(\) =>/);
  assert.match(plugin, /public void checkForUpdate\(PluginCall call\)/);
  for (const key of ['checkUpdate', 'checking', 'update-available', 'up-to-date', 'check-failed']) {
    assert.match(i18n, new RegExp(`mobile\\.me\\.about\\.${key.replaceAll('-', '\\-')}`));
  }
});
