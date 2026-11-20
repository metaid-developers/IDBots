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

test('production startup uses declarative config, safe lifecycle, version 0.1.6, and branded launcher assets', () => {
  const build = read('../android/app/build.gradle');
  assert.match(build, /versionCode 8/);
  assert.match(build, /versionName "0\.1\.6"/);
  const iosProject = read('../ios/App/App.xcodeproj/project.pbxproj');
  assert.equal(iosProject.match(/CURRENT_PROJECT_VERSION = 8;/g)?.length, 2);
  assert.equal(iosProject.match(/MARKETING_VERSION = 0\.1\.6;/g)?.length, 2);
  const bootstrap = read('../android/app/src/main/java/com/idbots/world/NativeBootstrap.java');
  assert.match(bootstrap, /BuildConfig\.VERSION_NAME/);
  assert.match(bootstrap, /BuildConfig\.VERSION_CODE/);
  assert.doesNotMatch(bootstrap, /readAllBytes\s*\(/);
  assert.match(bootstrap, /ByteArrayOutputStream/);
  const activity = read('../android/app/src/main/java/com/idbots/world/MainActivity.java');
  assert.doesNotMatch(activity, /CapConfig|setServerUrl|setErrorPath/);
  assert.ok(activity.indexOf('registerPlugin(NativeBackPlugin.class)') < activity.indexOf('super.onCreate(savedInstanceState)'));
  assert.match(activity, /protected void load\(\)/);
  assert.match(activity, /if \(bridge == null\) return;/);
  for (const [path, size] of [
    ['../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 192],
    ['../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png', 192],
  ]) {
    const png = readFileSync(new URL(path, import.meta.url));
    assert.equal(png.readUInt32BE(16), size, path);
    assert.equal(png.readUInt32BE(20), size, path);
  }
});

test('approved amber splash preserves the robot aspect ratio on Android, iOS, and PWA', () => {
  const androidSplash = read('../android/app/src/main/res/drawable/splash.xml');
  assert.match(androidSplash, /@drawable\/splash_art/);
  assert.match(androidSplash, /android:gravity="center"/);
  assert.match(androidSplash, /@color\/idbots_launch/);
  for (const [density, scale] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) {
    for (const orientation of ['port', 'land']) {
      const path = `../android/app/src/main/res/drawable-${orientation}-${density}/splash_art.png`;
      const png = readFileSync(new URL(path, import.meta.url));
      assert.equal(png.readUInt32BE(16), 390 * scale, path);
      assert.equal(png.readUInt32BE(20), 844 * scale, path);
    }
  }
  const storyboard = read('../ios/App/App/Base.lproj/LaunchScreen.storyboard');
  assert.match(storyboard, /contentMode="scaleAspectFit"/);
  assert.doesNotMatch(storyboard, /scaleAspectFill/);
  assert.match(storyboard, /image="LaunchRobot"/);
  assert.match(storyboard, /image="LaunchTile"/);
  assert.doesNotMatch(storyboard, /userDefinedRuntimeAttributes/);
  for (const size of [264, 528, 792]) {
    const png = readFileSync(new URL(`../ios/App/App/Assets.xcassets/LaunchRobot.imageset/launch-robot-${size}.png`, import.meta.url));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  for (const size of [296, 592, 888]) {
    const png = readFileSync(new URL(`../ios/App/App/Assets.xcassets/LaunchTile.imageset/launch-tile-${size}.png`, import.meta.url));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const pwa = read('../../src/mobile/app/index.html');
  assert.match(pwa, /id="idbots-launch-splash"/);
  assert.match(pwa, /object-fit: contain/);
  assert.match(pwa, /#FEB338/);
  const bootstrap = read('../../src/mobile/app/bootstrap.tsx');
  assert.match(bootstrap, /finally \{/);
  assert.match(bootstrap, /getElementById\('idbots-launch-splash'\)\?\.remove\(\)/);
  const manifest = JSON.parse(read('../../src/mobile/app/public/manifest.webmanifest'));
  assert.equal(manifest.background_color, '#FEB338');
  assert.equal(manifest.theme_color, '#FEB338');
});

test('launcher icons use the full original artwork without adaptive cropping or added margins', () => {
  const generator = read('../scripts/generate-launcher-icons.mjs');
  assert.match(generator, /scale=\$\{size\}:\$\{size\}:flags=neighbor/);
  assert.doesNotMatch(generator, /crop=|pad=/);
  const source = readFileSync(new URL('../../public/logo.png', import.meta.url));
  assert.equal(source.readUInt32BE(16), 1080);
  assert.equal(source.readUInt32BE(20), 1080);
  for (const [density, size] of [
    ['mdpi', 48],
    ['hdpi', 72],
    ['xhdpi', 96],
    ['xxhdpi', 144],
    ['xxxhdpi', 192],
  ]) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const png = readFileSync(new URL(`../android/app/src/main/res/mipmap-${density}/${name}`, import.meta.url));
      assert.equal(png.readUInt32BE(16), size, `${density}/${name}`);
      assert.equal(png.readUInt32BE(20), size, `${density}/${name}`);
    }
  }
  for (const [path, size] of [
    ['../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024],
    ['../../src/mobile/app/public/icon-192.png', 192],
    ['../../src/mobile/app/public/icon-512.png', 512],
    ['../../src/mobile/app/public/apple-touch-icon.png', 180],
    ['../../src/mobile/login/public/icon-192.png', 192],
  ]) {
    const png = readFileSync(new URL(path, import.meta.url));
    assert.equal(png.readUInt32BE(16), size, path);
    assert.equal(png.readUInt32BE(20), size, path);
  }
  for (const path of [
    '../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
    '../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
    '../../src/mobile/app/public/icon-maskable-512.png',
  ]) {
    assert.throws(() => readFileSync(new URL(path, import.meta.url)), /ENOENT/, path);
  }
  const manifest = JSON.parse(read('../../src/mobile/app/public/manifest.webmanifest'));
  assert.equal(manifest.icons.length, 2);
  assert.equal(manifest.icons.at(-1).src, 'icon-512.png');
  assert.equal(manifest.icons.at(-1).purpose, 'any');
  assert.equal(manifest.icons.some((icon) => icon.purpose === 'maskable'), false);
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
  for (const dependency of ['@capacitor/camera', '@capacitor/share']) {
    assert.equal(nativePackage.dependencies[dependency], undefined);
  }
  assert.equal(nativePackage.dependencies['@capacitor/push-notifications'], '8.1.3');
  assert.equal(nativePackage.dependencies['@capacitor/local-notifications'], '8.3.1');
});

test('Android notification permission, category channels and event-only tap routing are present', () => {
  assert.match(read('../android/app/src/main/AndroidManifest.xml'), /android\.permission\.POST_NOTIFICATIONS/);
  const activity = read('../android/app/src/main/java/com/idbots/world/MainActivity.java');
  for (const channel of ['work', 'action', 'report', 'system']) assert.match(activity, new RegExp(`"${channel}"`));
  assert.match(read('../native/idbots-native-bootstrap.js'), /event\?\.notification\?\.data\?\.eventId/);
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
