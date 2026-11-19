import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readAndroidVersion(buildGradle = readFileSync(resolve(root, 'android/app/build.gradle'), 'utf8')) {
  const versionCode = buildGradle.match(/\bversionCode\s+(\d+)/);
  const versionName = buildGradle.match(/\bversionName\s+"([^"]+)"/);
  if (!versionCode || !versionName) throw new Error('Android version is missing from build.gradle');
  return { versionCode: Number(versionCode[1]), versionName: versionName[1] };
}

export function createAndroidEntry(apkPath, release, buildGradle) {
  const { versionCode, versionName } = readAndroidVersion(buildGradle);
  const apk = readFileSync(apkPath);
  return {
    version: versionName,
    versionCode,
    minVersionCode: release.minVersionCode,
    date: release.date,
    url: `https://app.idbots.world/downloads/IDBots-Android-${versionName}.apk`,
    sha256: createHash('sha256').update(apk).digest('hex'),
    size: statSync(apkPath).size,
    changeLog: release.changeLog,
  };
}

export function mergeAndroidUpdateManifest(baseManifest, android) {
  if (baseManifest?.code !== 0 || !baseManifest.data?.value) throw new Error('Invalid base update manifest');
  const merged = JSON.parse(JSON.stringify(baseManifest));
  merged.data.value.android = android;
  return merged;
}

function main() {
  const [apkArgument, baseArgument, outputArgument] = process.argv.slice(2);
  if (!apkArgument || !baseArgument || !outputArgument) {
    throw new Error('Usage: create-android-release-metadata.mjs <signed.apk> <current-update.json> <new-update.json>');
  }
  const apkPath = resolve(apkArgument);
  const baseManifest = JSON.parse(readFileSync(resolve(baseArgument), 'utf8'));
  const release = JSON.parse(readFileSync(resolve(root, 'release-notes/android-release.json'), 'utf8'));
  const android = createAndroidEntry(apkPath, release);
  const merged = mergeAndroidUpdateManifest(baseManifest, android);
  const outputPath = resolve(outputArgument);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(android, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
