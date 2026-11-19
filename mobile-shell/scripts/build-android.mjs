import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFlavor } from './flavors.mjs';
import { readAndroidVersion } from './create-android-release-metadata.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flavor = getFlavor(process.argv[2] || 'staging');
const release = process.argv.includes('--release');
if (release && flavor.name !== 'production') throw new Error('Release APKs must use the production flavor');
if (release && !process.env.IDBOTS_ANDROID_KEYSTORE && !process.env.IDBOTS_ANDROID_SIGNING_INIT_SCRIPT) {
  throw new Error('Set IDBOTS_ANDROID_SIGNING_INIT_SCRIPT or the IDBOTS_ANDROID_KEYSTORE signing environment');
}
const localJavaHome = resolve(root, '.tooling/jdk-home/Home');
const javaHome = process.env.JAVA_HOME || (existsSync(resolve(localJavaHome, 'bin/java')) ? localJavaHome : undefined);
if (!javaHome) throw new Error('Set JAVA_HOME to a JDK 21 installation before building Android');

const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(process.env.HOME || '', 'Library/Android/sdk');
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  GRADLE_USER_HOME: resolve(root, '.tooling/gradle'),
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [resolve(root, 'scripts/select-flavor.mjs'), flavor.name], root);
run(process.execPath, [resolve(root, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'], root);
const task = release ? 'assembleProductionRelease' : (flavor.name === 'production' ? 'assembleProductionDebug' : 'assembleStagingDebug');
const gradleArguments = [];
if (process.env.IDBOTS_ANDROID_SIGNING_INIT_SCRIPT) {
  gradleArguments.push('-I', resolve(process.env.IDBOTS_ANDROID_SIGNING_INIT_SCRIPT));
}
gradleArguments.push(task);
run(resolve(root, 'android/gradlew'), gradleArguments, resolve(root, 'android'));
if (release) {
  const { versionName } = readAndroidVersion();
  const artifacts = resolve(root, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const source = resolve(root, 'android/app/build/outputs/apk/production/release/app-production-release.apk');
  const destination = resolve(artifacts, `IDBots-Android-${versionName}.apk`);
  copyFileSync(source, destination);
  process.stdout.write(`Release APK: ${destination}\n`);
}
