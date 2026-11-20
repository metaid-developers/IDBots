import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(shellRoot, '..');
const approvedDesign = resolve(repoRoot, 'design-demos/mobile-splash/direction-b-companion.png');
const robot = resolve(repoRoot, 'public/logo.png');

function run(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  if (result.error) throw new Error(`ffmpeg is required to generate splash assets: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

function assertSize(path, width, height) {
  const png = readFileSync(path);
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
    throw new Error(`Unexpected dimensions for ${path}: expected ${width}x${height}`);
  }
  console.log(`${relative(repoRoot, path)} ${width}x${height}`);
}

function renderSplash(destination, scale) {
  const width = 390 * scale;
  const height = 844 * scale;
  mkdirSync(dirname(destination), { recursive: true });
  run([
    '-i', approvedDesign,
    '-vf', `scale=${width}:${height}:flags=neighbor,drawbox=x=0:y=${544 * scale}:w=${width}:h=${50 * scale}:color=0xFEB338:t=fill`,
    '-frames:v', '1', destination,
  ]);
  assertSize(destination, width, height);
}

const densities = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];
renderSplash(resolve(repoRoot, 'design-demos/mobile-splash/approved-splash.png'), 1);
renderSplash(resolve(shellRoot, 'android/app/src/main/res/drawable/splash_art.png'), 1);
for (const [density, scale] of densities) {
  for (const orientation of ['port', 'land']) {
    renderSplash(resolve(shellRoot, `android/app/src/main/res/drawable-${orientation}-${density}/splash_art.png`), scale);
  }
}

const iosImages = resolve(shellRoot, 'ios/App/App/Assets.xcassets/LaunchRobot.imageset');
mkdirSync(iosImages, { recursive: true });
const images = [];
for (const [scale, size] of [['1x', 264], ['2x', 528], ['3x', 792]]) {
  const filename = `launch-robot-${size}.png`;
  const destination = resolve(iosImages, filename);
  run(['-i', robot, '-vf', `scale=${size}:${size}:flags=neighbor`, '-frames:v', '1', destination]);
  assertSize(destination, size, size);
  images.push({ idiom: 'universal', filename, scale });
}
writeFileSync(resolve(iosImages, 'Contents.json'), `${JSON.stringify({ images, info: { version: 1, author: 'xcode' } }, null, 2)}\n`);

const iosTiles = resolve(shellRoot, 'ios/App/App/Assets.xcassets/LaunchTile.imageset');
mkdirSync(iosTiles, { recursive: true });
const tileImages = [];
for (const [scale, size] of [['1x', 296], ['2x', 592], ['3x', 888]]) {
  const filename = `launch-tile-${size}.png`;
  const destination = resolve(iosTiles, filename);
  const inset = Math.round(size * 16 / 296);
  const inner = size - inset * 2;
  run([
    '-i', resolve(shellRoot, 'android/app/src/main/res/drawable-port-xxxhdpi/splash_art.png'),
    '-vf', `crop=1184:1184:188:616,scale=${size}:${size}:flags=neighbor,drawbox=x=${inset}:y=${inset}:w=${inner}:h=${inner}:color=0xFEB338:t=fill`,
    '-frames:v', '1', destination,
  ]);
  assertSize(destination, size, size);
  tileImages.push({ idiom: 'universal', filename, scale });
}
writeFileSync(resolve(iosTiles, 'Contents.json'), `${JSON.stringify({ images: tileImages, info: { version: 1, author: 'xcode' } }, null, 2)}\n`);
