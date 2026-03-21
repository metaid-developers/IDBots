import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const defaultSource = '/Users/tusm/Documents/MetaID_Projects/man-p2p';
const targetDir = path.join(projectRoot, 'resources', 'man-p2p');
const targetBinaryName = 'man-p2p-darwin-arm64';
const targetBinaryPath = path.join(targetDir, targetBinaryName);
const targetManifestPath = path.join(targetDir, 'bundle-manifest.json');

function parseArgs(argv) {
  const args = { source: process.env.MAN_P2P_SOURCE || defaultSource };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--source') {
      args.source = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function syncBinary(sourcePath) {
  const resolvedSource = path.resolve(sourcePath);
  const makefilePath = path.join(resolvedSource, 'Makefile');
  if (!fs.existsSync(makefilePath)) {
    throw new Error(`man-p2p source does not contain a Makefile: ${resolvedSource}`);
  }

  console.log(`[sync-man-p2p] building darwin arm64 binary from ${resolvedSource}`);
  run('make', ['build-darwin-arm64'], resolvedSource);

  const builtBinaryPath = path.join(resolvedSource, 'dist', targetBinaryName);
  if (!fs.existsSync(builtBinaryPath)) {
    throw new Error(`built binary not found at ${builtBinaryPath}`);
  }

  const sourceCommit = run('git', ['rev-parse', '--short', 'HEAD'], resolvedSource);
  const sourceBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], resolvedSource);
  const sourceVersion = run('git', ['describe', '--tags', '--always', '--dirty'], resolvedSource);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(builtBinaryPath, targetBinaryPath);
  fs.chmodSync(targetBinaryPath, 0o755);

  const manifest = {
    binary: targetBinaryName,
    binarySha256: sha256File(targetBinaryPath),
    sourcePath: resolvedSource,
    sourceBranch,
    sourceCommit,
    sourceVersion,
    syncedAt: new Date().toISOString(),
  };
  fs.writeFileSync(targetManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`[sync-man-p2p] synced ${targetBinaryName}`);
  console.log(`[sync-man-p2p] source ${sourceBranch}@${sourceCommit}`);
  console.log(`[sync-man-p2p] sha256 ${manifest.binarySha256}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  syncBinary(args.source);
} catch (error) {
  console.error(`[sync-man-p2p] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
