import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCapacitorConfig, getFlavor } from '../scripts/flavors.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const rootPackage = JSON.parse(read('../../package.json'));
const nativePackage = JSON.parse(read('../package.json'));

test('staging is the default remote and production requires an explicit flavor', () => {
  const staging = createCapacitorConfig('staging');
  const production = createCapacitorConfig('production');
  assert.equal(staging.server.url, 'https://staging.idbots.world/');
  assert.deepEqual(staging.server.allowNavigation, ['staging.idbots.world']);
  assert.equal(production.server.url, 'https://app.idbots.world/');
  assert.deepEqual(production.server.allowNavigation, ['app.idbots.world']);
  assert.match(nativePackage.scripts['build:android:production'], /production/);
  assert.match(nativePackage.scripts['build:ios:production'], /production/);
  assert.throws(() => getFlavor('development'), /Unknown native flavor/);
});

test('configuration keeps HTTPS, disables mixed content, and uses the bundled error page', () => {
  for (const flavor of ['staging', 'production']) {
    const config = createCapacitorConfig(flavor);
    assert.match(config.server.url, /^https:\/\//);
    assert.equal(config.android.allowMixedContent, false);
    assert.match(config.server.errorPath, /^offline\.html\?retry=/);
    assert.equal(config.ios.iosScheme, undefined);
    assert.equal(config.server.iosScheme, 'capacitor');
  }
});

test('Android has API 26 and explicit staging and production variants', () => {
  const variables = read('../android/variables.gradle');
  const build = read('../android/app/build.gradle');
  assert.match(variables, /minSdkVersion = 26/);
  assert.match(build, /productFlavors/);
  assert.match(build, /NATIVE_REMOTE_ORIGIN', '"https:\/\/staging\.idbots\.world"/);
  assert.match(build, /NATIVE_REMOTE_ORIGIN', '"https:\/\/app\.idbots\.world"/);
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
  const activity = read('../android/app/src/main/java/com/idbots/world/MainActivity.java');
  assert.match(activity, /registerPlugin\(NativeBackPlugin\.class\)/);
  const backPlugin = read('../android/app/src/main/java/com/idbots/world/NativeBackPlugin.java');
  assert.match(backPlugin, /@CapacitorPlugin\(name = "NativeBack"\)/);
  assert.match(backPlugin, /getBridge\(\)\.getActivity\(\)\.finish\(\)/);
});

test('Gradle wrapper remains executable in Git and on disk', () => {
  const entry = execFileSync('git', ['ls-files', '--stage', 'mobile-shell/android/gradlew'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(entry, /^100755 /);
  assert.ok(statSync(new URL('../android/gradlew', import.meta.url)).mode & 0o111);
});

test('both platforms install the adapter before remote application scripts', () => {
  assert.match(read('../android/app/src/main/java/com/idbots/world/NativeShellWebView.java'), /DOCUMENT_START_SCRIPT/);
  assert.match(read('../ios/App/App/NativeBridgeViewController.swift'), /injectionTime: \.atDocumentStart, forMainFrameOnly: true/);
  assert.match(read('../ios/App/App/NativeShellNavigationDelegate.swift'), /decisionHandler\(\.cancel\)/);
});

test('offline UI is small, bilingual, and has no cached online application or service worker', () => {
  const offline = read('../www/offline.html');
  assert.match(offline, /You’re offline/);
  assert.match(offline, /当前无法连接/);
  assert.match(offline, /does not provide offline Agent execution/);
  assert.doesNotMatch(offline, /serviceWorker|dist-mobile|\/app\/assets/);
  assert.ok(offline.length < 5000);
});

test('native dependencies stay outside the root package and Electron artifact', () => {
  assert.doesNotMatch(rootPackage.scripts.postinstall, /mobile-shell/);
  assert.equal(rootPackage.dependencies['@capacitor/core'], undefined);
  assert.equal(rootPackage.devDependencies['@capacitor/core'], undefined);
  const electronBuilder = JSON.parse(read('../../electron-builder.json'));
  assert.doesNotMatch(JSON.stringify(electronBuilder.files), /mobile-shell/);
  assert.doesNotMatch(JSON.stringify(electronBuilder.extraResources), /mobile-shell/);
  for (const dependency of ['@capacitor/camera', '@capacitor/share', '@capacitor/push-notifications']) {
    assert.equal(nativePackage.dependencies[dependency], undefined);
  }
});

test('NS2 native capabilities are registered with privacy and size boundaries', () => {
  const activity = read('../android/app/src/main/java/com/idbots/world/MainActivity.java');
  assert.match(activity, /registerPlugin\(NativeCapabilitiesPlugin\.class\)/);
  const android = read('../android/app/src/main/java/com/idbots/world/NativeCapabilitiesPlugin.java');
  assert.match(android, /25L \* 1024L \* 1024L/);
  assert.match(android, /FLAG_SECURE/);
  assert.match(android, /ACTION_OPEN_DOCUMENT/);
  assert.doesNotMatch(android, /console\.|System\.out|Log\./);
  const ios = read('../ios/App/App/NativeCapabilitiesPlugin.swift');
  assert.match(ios, /UIDocumentPickerViewController/);
  assert.match(ios, /UIActivityViewController/);
  assert.match(ios, /startAccessingSecurityScopedResource/);
  assert.match(ios, /25 \* 1024 \* 1024/);
  const controller = read('../ios/App/App/NativeBridgeViewController.swift');
  assert.match(controller, /registerPluginInstance\(NativeCapabilitiesPlugin\(\)\)/);
  const scene = read('../ios/App/App/SceneDelegate.swift');
  assert.match(scene, /NativeSecureScreen\.didEnterBackground/);
  assert.match(scene, /NativeSecureScreen\.willEnterForeground/);
  const project = read('../ios/App/App.xcodeproj/project.pbxproj');
  assert.match(project, /NativeCapabilitiesPlugin\.swift in Sources/);
  const plist = read('../ios/App/App/Info.plist');
  assert.match(plist, /NSCameraUsageDescription/);
  assert.match(plist, /NSPhotoLibraryUsageDescription/);
});

test('root package guidance remains synchronized', () => {
  const agents = read('../../AGENTS.md');
  const claude = read('../../CLAUDE.md');
  const normalized = agents.replace('# AGENTS.md', '# CLAUDE.md').replace('Codex (Codex.ai/code)', 'Claude Code (claude.ai/code)');
  assert.equal(normalized, claude);
  assert.match(agents, /Four packages, four lockfiles/);
  assert.match(agents, /never installed by root `postinstall` or packaged into Electron/);
});
