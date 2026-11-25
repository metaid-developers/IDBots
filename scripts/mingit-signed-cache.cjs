#!/usr/bin/env node
/**
 * Signed PortableGit cache: sign the bundled PortableGit tree once per
 * (archive, certificate), then reuse it.
 *
 * The failure class this closes: PortableGit is a fixed third-party tree, yet
 * every Windows build asked the cloud signer to sign its ~333 executables
 * again — 333 of the 356 signatures per build, each a round trip to the
 * signing service and to a timestamp server. A healthy Windows packaging step
 * spent about 8 minutes on them, and the v1.1.3 tag run 45609195621
 * (2026-11-25) lost its signer on the 711th signature of the build and failed
 * eight 90-second timeouts later.
 *
 *   store  (after packaging) records the packaged, signed tree together with a
 *          manifest of every file's digest before and after signing. It
 *          refuses to store unless every executable verifies as Valid, signed
 *          by the configured certificate and timestamped
 *          (scripts/mingit-verify-signatures.ps1).
 *   apply  (before packaging) substitutes the cached tree for the freshly
 *          extracted one — only when that tree matches the recorded unsigned
 *          digests file for file, the cached files still match their recorded
 *          signed digests, and certificate and archive are the same — and
 *          hands the digest list to scripts/windows-sign.cjs, which then
 *          recognises the already-signed binaries by content.
 *
 * A miss is never fatal: without a usable cache the build signs as before.
 *
 * Env: WIN_CERT_SHA1 and IDBOTS_PORTABLE_GIT_ARCHIVE are required for either
 * direction; IDBOTS_SIGNING_CACHE_DIR (default: the archive's directory) and
 * IDBOTS_PRESIGNED_MANIFEST (hook digest list; default under os.tmpdir()) are
 * optional.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MANIFEST_NAME = 'manifest.json';
const MINGIT_REL = path.join('resources', 'mingit');
const PACKAGED_MINGIT_REL = path.join('release', 'win-unpacked', 'resources', 'mingit');

const normalizeThumbprint = (value) => String(value || '').replace(/[^A-Fa-f0-9]/g, '').toUpperCase();

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(root, relative = '') {
  let found = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found = found.concat(listFiles(root, child));
    else if (entry.isFile()) found.push(child);
  }
  return found.sort();
}

/** Relative path (forward slashes) -> sha256, for every file under root. */
function digestTree(root) {
  const digests = {};
  for (const relative of listFiles(root)) digests[relative] = sha256File(path.join(root, relative));
  return digests;
}

function sameDigests(left, right) {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => right[key] === left[key]);
}

function readManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
    return manifest && manifest.version === 1 && manifest.unsigned && manifest.signed ? manifest : null;
  } catch {
    return null;
  }
}

/** The cache is keyed by what determines the signed bytes: archive + certificate. */
function resolveCache({ archivePath, thumbprint, cacheRoot }) {
  const archiveSha256 = sha256File(archivePath);
  const root = cacheRoot || path.dirname(archivePath);
  return {
    archiveSha256,
    dir: path.join(root, 'mingit-signed', `${archiveSha256.slice(0, 16)}-${thumbprint.slice(0, 12)}`),
  };
}

/**
 * Ask PowerShell for the signature state of every executable under treeDir.
 * @returns {Map<string, {status: string, signer: string|null, timestamped: boolean}> | null}
 *   null when the verification itself could not run.
 */
function verifyWithPowershell(treeDir, thumbprint) {
  const script = path.join(__dirname, 'mingit-verify-signatures.ps1');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', treeDir, '-Thumbprint', thumbprint],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return null;
  // Only the JSON is wanted; anything PowerShell prints around it is noise.
  const start = result.stdout.search(/[[{]/);
  const end = Math.max(result.stdout.lastIndexOf(']'), result.stdout.lastIndexOf('}'));
  if (start < 0 || end < start) return null;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  const verdicts = new Map();
  for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
    verdicts.set(String(entry.path).replace(/\\/g, '/'), {
      status: String(entry.status),
      signer: normalizeThumbprint(entry.signer),
      timestamped: entry.timestamped === true,
    });
  }
  return verdicts;
}

/** Decide whether a packaged tree may be cached. Returns null when it may. */
function refusalFor({ unsigned, signed, verdicts, thumbprint }) {
  if (!verdicts) return 'signature verification could not run; nothing is cached';
  const relatives = Object.keys(unsigned);
  if (relatives.length !== Object.keys(signed).length || relatives.some((relative) => signed[relative] === undefined)) {
    return 'the packaged tree has other files than the extracted one';
  }
  const executables = new Set(relatives.filter((relative) => relative.toLowerCase().endsWith('.exe')));
  if (executables.size === 0) return 'no executables found in the tree';
  for (const relative of relatives) {
    if (!executables.has(relative)) {
      if (signed[relative] !== unsigned[relative]) return `${relative} is not an executable but changed during packaging`;
      continue;
    }
    const verdict = verdicts.get(relative);
    if (signed[relative] === unsigned[relative]) return `${relative} was not signed`;
    if (verdict?.status !== 'Valid') return `${relative} is not validly signed (${verdict?.status ?? 'unverified'})`;
    if (verdict.signer !== thumbprint) return `${relative} is signed by another certificate`;
    if (!verdict.timestamped) return `${relative} is signed without a timestamp`;
  }
  return null;
}

function store({ repoRoot = process.cwd(), env = process.env, log = console.log, verify = verifyWithPowershell } = {}) {
  const thumbprint = normalizeThumbprint(env.WIN_CERT_SHA1);
  const archivePath = env.IDBOTS_PORTABLE_GIT_ARCHIVE;
  const unsignedTree = path.join(repoRoot, MINGIT_REL);
  const signedTree = path.join(repoRoot, PACKAGED_MINGIT_REL);
  if (!thumbprint || !archivePath || !fs.existsSync(archivePath) || !fs.existsSync(unsignedTree) || !fs.existsSync(signedTree)) {
    log('[mingit-signed-cache] store skipped: certificate, archive or packaged tree not available');
    return { stored: false, reason: 'not-applicable' };
  }
  const { archiveSha256, dir } = resolveCache({ archivePath, thumbprint, cacheRoot: env.IDBOTS_SIGNING_CACHE_DIR });
  if (readManifest(dir)) {
    log(`[mingit-signed-cache] already cached in ${dir}`);
    return { stored: false, reason: 'already-cached' };
  }

  const unsigned = digestTree(unsignedTree);
  const signed = digestTree(signedTree);
  const refusal = refusalFor({ unsigned, signed, thumbprint, verdicts: verify(signedTree, thumbprint) });
  if (refusal) {
    log(`[mingit-signed-cache] store refused: ${refusal}`);
    return { stored: false, reason: refusal };
  }

  const manifest = { version: 1, archiveSha256, certThumbprint: thumbprint, unsigned, signed };
  // Stage beside the destination and rename, so a cache directory is either
  // absent or complete.
  const staging = `${dir}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.cpSync(signedTree, path.join(staging, 'tree'), { recursive: true });
  fs.writeFileSync(path.join(staging, MANIFEST_NAME), JSON.stringify(manifest));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  log(`[mingit-signed-cache] stored ${Object.keys(signed).length} files in ${dir}`);
  return { stored: true, dir, files: Object.keys(signed).length };
}

function apply({ repoRoot = process.cwd(), env = process.env, log = console.log } = {}) {
  const miss = (reason) => {
    log(`[mingit-signed-cache] cache miss (${reason}); signing as usual`);
    return { hit: false, reason };
  };
  const thumbprint = normalizeThumbprint(env.WIN_CERT_SHA1);
  const archivePath = env.IDBOTS_PORTABLE_GIT_ARCHIVE;
  const workspaceTree = path.join(repoRoot, MINGIT_REL);
  if (!thumbprint || !archivePath || !fs.existsSync(archivePath) || !fs.existsSync(workspaceTree)) {
    return miss('certificate, archive or extracted tree not available');
  }
  const { archiveSha256, dir } = resolveCache({ archivePath, thumbprint, cacheRoot: env.IDBOTS_SIGNING_CACHE_DIR });
  const manifest = readManifest(dir);
  if (!manifest) return miss('no cache for this archive and certificate');
  if (manifest.certThumbprint !== thumbprint || manifest.archiveSha256 !== archiveSha256) {
    return miss('cache was made for another archive or certificate');
  }
  if (!sameDigests(digestTree(workspaceTree), manifest.unsigned)) {
    return miss('the extracted tree differs from the one that was signed');
  }
  let cachedTree;
  try {
    cachedTree = digestTree(path.join(dir, 'tree'));
  } catch {
    return miss('cached tree is missing');
  }
  if (!sameDigests(cachedTree, manifest.signed)) return miss('cached tree is incomplete or damaged');

  // Copy first and swap last: a failed copy must not leave the build without a tree.
  const staging = `${workspaceTree}.signed-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(path.join(dir, 'tree'), staging, { recursive: true });
  fs.rmSync(workspaceTree, { recursive: true, force: true });
  fs.renameSync(staging, workspaceTree);

  const manifestPath = env.IDBOTS_PRESIGNED_MANIFEST || path.join(os.tmpdir(), 'idbots-presigned-mingit.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, files: manifest.signed }));
  log(`[mingit-signed-cache] cache hit: ${Object.keys(manifest.signed).length} files reused from ${dir}`);
  return { hit: true, files: Object.keys(manifest.signed).length };
}

function main() {
  const command = process.argv[2];
  if (command === 'store') {
    store();
    return;
  }
  if (command === 'apply') {
    try {
      apply();
    } catch (error) {
      // Never fail a build over an optimization.
      console.warn(`[mingit-signed-cache] cache miss (error: ${error instanceof Error ? error.message : error}); signing as usual`);
    }
    return;
  }
  console.error('Usage: node scripts/mingit-signed-cache.cjs <store|apply>');
  process.exit(64);
}

if (require.main === module) main();

module.exports = { apply, store, digestTree, listFiles, normalizeThumbprint, refusalFor, resolveCache, verifyWithPowershell };
