import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(shellRoot, '..');
const source = resolve(repoRoot, 'public/logo.png');

function pngSize(path) {
  const data = readFileSync(path);
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`Not a PNG: ${path}`);
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

const sourceSize = pngSize(source);
if (sourceSize.width !== sourceSize.height) throw new Error('The launcher artwork must be square');

function render(destination, size) {
  mkdirSync(dirname(destination), { recursive: true });
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-i', source,
    '-vf', `scale=${size}:${size}:flags=neighbor`, '-frames:v', '1', destination,
  ], { stdio: 'inherit' });
  if (result.error) throw new Error(`ffmpeg is required to generate launcher icons: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${destination}`);
  const output = pngSize(destination);
  if (output.width !== size || output.height !== size) {
    throw new Error(`Unexpected icon dimensions for ${destination}: ${output.width}x${output.height}`);
  }
  console.log(`${relative(repoRoot, destination)} ${size}x${size}`);
}

const densities = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];
for (const [density, size] of densities) {
  const resources = resolve(shellRoot, `android/app/src/main/res/mipmap-${density}`);
  render(resolve(resources, 'ic_launcher.png'), size);
  render(resolve(resources, 'ic_launcher_round.png'), size);
}

render(resolve(shellRoot, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), 1024);
render(resolve(repoRoot, 'src/mobile/app/public/icon-192.png'), 192);
render(resolve(repoRoot, 'src/mobile/app/public/icon-512.png'), 512);
render(resolve(repoRoot, 'src/mobile/app/public/apple-touch-icon.png'), 180);
render(resolve(repoRoot, 'src/mobile/login/public/icon-192.png'), 192);
