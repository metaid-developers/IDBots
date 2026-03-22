import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const defaultSource = '/Users/tusm/Documents/MetaID_Projects/man-p2p';
const targetDir = path.join(projectRoot, 'resources', 'man-p2p');
const targetManifestPath = path.join(targetDir, 'bundle-manifest.json');
const bundledArtifacts = [
  {
    binary: 'man-p2p-darwin-arm64',
    makeTarget: 'build-darwin-arm64',
  },
  {
    binary: 'man-p2p-win32-x64.exe',
    makeTarget: 'build-windows-amd64',
  },
];

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

  const syncedArtifacts = {};
  fs.mkdirSync(targetDir, { recursive: true });

  for (const artifact of bundledArtifacts) {
    console.log(`[sync-man-p2p] building ${artifact.binary} from ${resolvedSource}`);
    run('make', [artifact.makeTarget], resolvedSource);

    const builtBinaryPath = path.join(resolvedSource, 'dist', artifact.binary);
    if (!fs.existsSync(builtBinaryPath)) {
      throw new Error(`built binary not found at ${builtBinaryPath}`);
    }

    const targetBinaryPath = path.join(targetDir, artifact.binary);
    fs.copyFileSync(builtBinaryPath, targetBinaryPath);
    fs.chmodSync(targetBinaryPath, 0o755);
    syncedArtifacts[artifact.binary] = {
      makeTarget: artifact.makeTarget,
      sha256: sha256File(targetBinaryPath),
    };
  }

  const sourceCommit = run('git', ['rev-parse', '--short', 'HEAD'], resolvedSource);
  const sourceBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], resolvedSource);
  const sourceVersion = run('git', ['describe', '--tags', '--always', '--dirty'], resolvedSource);

  const manifest = {
    binary: 'man-p2p-darwin-arm64',
    binarySha256: syncedArtifacts['man-p2p-darwin-arm64'].sha256,
    artifacts: syncedArtifacts,
    sourcePath: resolvedSource,
    sourceBranch,
    sourceCommit,
    sourceVersion,
    syncedAt: new Date().toISOString(),
  };
  fs.writeFileSync(targetManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`[sync-man-p2p] synced ${Object.keys(syncedArtifacts).join(', ')}`);
  console.log(`[sync-man-p2p] source ${sourceBranch}@${sourceCommit}`);
  Object.entries(syncedArtifacts).forEach(([binary, data]) => {
    console.log(`[sync-man-p2p] sha256 ${binary} ${data.sha256}`);
  });
}

try {
  const args = parseArgs(process.argv.slice(2));
  syncBinary(args.source);
} catch (error) {
  console.error(`[sync-man-p2p] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
