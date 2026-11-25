import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { apply, store, digestTree, refusalFor, resolveCache } = require('../scripts/mingit-signed-cache.cjs');

const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const THUMBPRINT = 'AB'.repeat(20);

// A repository right after Windows packaging: the extracted PortableGit tree
// under resources/, and the packaged copy whose executables carry a signature.
function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-mingit-'));
  // Leftover temp dirs are harmless and OS-swept; never let cleanup fail a test.
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const repoRoot = path.join(dir, 'repo');
  const extracted = path.join(repoRoot, 'resources', 'mingit');
  const packaged = path.join(repoRoot, 'release', 'win-unpacked', 'resources', 'mingit');
  const files = {
    'usr/bin/git.exe': 'MZ\u0000git',
    'usr/bin/bash.exe': 'MZ\u0000bash',
    'mingw64/bin/libcurl-4.dll': 'dll-bytes',
  };
  for (const [relative, content] of Object.entries(files)) {
    const signed = relative.endsWith('.exe') ? `${content}<signature>` : content;
    write(path.join(extracted, relative), content);
    write(path.join(packaged, relative), signed);
  }
  const archive = path.join(dir, 'machine-cache', 'PortableGit-fake-64-bit.7z.exe');
  write(archive, 'fake-archive-bytes');
  const hookManifest = path.join(dir, 'hook-manifest.json');
  const env = {
    WIN_CERT_SHA1: THUMBPRINT,
    IDBOTS_PORTABLE_GIT_ARCHIVE: archive,
    IDBOTS_SIGNING_CACHE_DIR: path.join(dir, 'machine-cache'),
    IDBOTS_PRESIGNED_MANIFEST: hookManifest,
  };
  const lines = [];
  const log = (line) => lines.push(line);
  // Stands in for mingit-verify-signatures.ps1 (PowerShell is not available on
  // every platform the tests run on); individual tests corrupt one aspect.
  const verify = (overrides = {}) => (_treeDir, thumbprint) => {
    const verdicts = new Map();
    for (const relative of Object.keys(files).filter((name) => name.endsWith('.exe'))) {
      verdicts.set(relative, { status: 'Valid', signer: thumbprint, timestamped: true, ...overrides[relative] });
    }
    return verdicts;
  };
  return { dir, repoRoot, extracted, packaged, archive, env, lines, log, verify, write, hookManifest };
}

test('a signed tree is stored once and reused for the next build of the same archive and certificate', (t) => {
  const fixture = makeFixture(t);

  const stored = store({ repoRoot: fixture.repoRoot, env: fixture.env, log: fixture.log, verify: fixture.verify() });
  const applied = apply({ repoRoot: fixture.repoRoot, env: fixture.env, log: fixture.log });

  assert.equal(stored.stored, true);
  assert.equal(applied.hit, true);
  // The extracted tree now IS the signed tree, byte for byte.
  assert.deepEqual(digestTree(fixture.extracted), digestTree(fixture.packaged));
  assert.match(fs.readFileSync(path.join(fixture.extracted, 'usr', 'bin', 'git.exe'), 'utf8'), /<signature>/);
  // ...and the hook is told exactly which bytes are already signed.
  const handedOver = JSON.parse(fs.readFileSync(fixture.hookManifest, 'utf8')).files;
  assert.equal(handedOver['usr/bin/git.exe'], sha256('MZ\u0000git<signature>'));
  assert.equal(handedOver['mingw64/bin/libcurl-4.dll'], sha256('dll-bytes'));
  assert.equal(Object.keys(handedOver).length, 3);
});

test('storing again is a no-op once the cache exists', (t) => {
  const fixture = makeFixture(t);
  const options = { repoRoot: fixture.repoRoot, env: fixture.env, log: fixture.log, verify: fixture.verify() };

  assert.equal(store(options).stored, true);
  assert.deepEqual(store(options), { stored: false, reason: 'already-cached' });
});

test('the cache is keyed by what determines the signed bytes', (t) => {
  const fixture = makeFixture(t);
  const cacheRoot = fixture.env.IDBOTS_SIGNING_CACHE_DIR;
  const first = resolveCache({ archivePath: fixture.archive, thumbprint: THUMBPRINT, cacheRoot });

  const otherCertificate = resolveCache({ archivePath: fixture.archive, thumbprint: 'CD'.repeat(20), cacheRoot });
  fixture.write(fixture.archive, 'another-portablegit-release');
  const otherArchive = resolveCache({ archivePath: fixture.archive, thumbprint: THUMBPRINT, cacheRoot });

  assert.notEqual(first.dir, otherCertificate.dir);
  assert.notEqual(first.dir, otherArchive.dir);
  assert.equal(first.archiveSha256, sha256('fake-archive-bytes'));
});

test('apply leaves the extracted tree alone whenever it cannot prove the cache fits', (t) => {
  const fresh = () => makeFixture(t);
  const options = (fixture, verify) => ({ repoRoot: fixture.repoRoot, env: fixture.env, log: fixture.log, verify });
  const extractedBefore = (fixture) => digestTree(fixture.extracted);

  // No cache yet.
  const empty = fresh();
  const before = extractedBefore(empty);
  const miss = apply(options(empty));
  assert.equal(miss.hit, false);
  assert.deepEqual(digestTree(empty.extracted), before);
  assert.equal(fs.existsSync(empty.hookManifest), false, 'a miss must not hand any digest to the hook');

  // A different certificate.
  const otherCert = fresh();
  store(options(otherCert, otherCert.verify()));
  const missCert = apply(options({ ...otherCert, env: { ...otherCert.env, WIN_CERT_SHA1: 'CD'.repeat(20) } }));
  assert.equal(missCert.hit, false);
  assert.deepEqual(digestTree(otherCert.extracted), extractedBefore(otherCert));

  // A different PortableGit archive was extracted.
  const otherTree = fresh();
  store(options(otherTree, otherTree.verify()));
  otherTree.write(path.join(otherTree.extracted, 'usr', 'bin', 'git.exe'), 'MZ\u0000git-from-another-release');
  const missTree = apply(options(otherTree));
  assert.equal(missTree.hit, false);
  assert.match(missTree.reason, /differs/);
  assert.equal(
    fs.readFileSync(path.join(otherTree.extracted, 'usr', 'bin', 'git.exe'), 'utf8'),
    'MZ\u0000git-from-another-release',
    'the extracted tree is left exactly as it was',
  );

  // The cached copy itself was damaged.
  const damaged = fresh();
  const { dir } = store(options(damaged, damaged.verify()));
  fs.appendFileSync(path.join(dir, 'tree', 'usr', 'bin', 'bash.exe'), 'x');
  const missDamaged = apply(options(damaged));
  assert.equal(missDamaged.hit, false);
  assert.match(missDamaged.reason, /damaged/);
  assert.deepEqual(digestTree(damaged.extracted), extractedBefore(damaged));
});

test('store refuses a tree whose signatures it cannot vouch for', (t) => {
  const cases = [
    ['NotSigned', { 'usr/bin/git.exe': { status: 'NotSigned' } }, /not validly signed/],
    ['unsigned by our certificate', { 'usr/bin/bash.exe': { signer: 'EF'.repeat(20) } }, /another certificate/],
    ['signed without a timestamp', { 'usr/bin/git.exe': { timestamped: false } }, /without a timestamp/],
  ];
  for (const [label, overrides, expected] of cases) {
    const fixture = makeFixture(t);
    const result = store({ repoRoot: fixture.repoRoot, env: fixture.env, log: fixture.log, verify: fixture.verify(overrides) });
    assert.equal(result.stored, false, label);
    assert.match(result.reason, expected);
    assert.equal(fs.existsSync(path.join(fixture.env.IDBOTS_SIGNING_CACHE_DIR, 'mingit-signed')), false, `${label}: nothing may be cached`);
  }

  // The verification itself failing is not a pass.
  const unverifiable = makeFixture(t);
  const result = store({ repoRoot: unverifiable.repoRoot, env: unverifiable.env, log: unverifiable.log, verify: () => null });
  assert.equal(result.stored, false);
  assert.match(result.reason, /verification could not run/);
});

test('store refuses when the packaged tree is not simply the signed extracted one', (t) => {
  // An executable that came out of packaging unsigned.
  const unsigned = makeFixture(t);
  fs.writeFileSync(path.join(unsigned.packaged, 'usr', 'bin', 'git.exe'), 'MZ\u0000git');
  assert.match(
    store({ repoRoot: unsigned.repoRoot, env: unsigned.env, log: unsigned.log, verify: unsigned.verify() }).reason,
    /was not signed/,
  );

  // A file that is never signed but changed anyway.
  const changed = makeFixture(t);
  fs.writeFileSync(path.join(changed.packaged, 'mingw64', 'bin', 'libcurl-4.dll'), 'dll-bytes-changed');
  assert.match(
    store({ repoRoot: changed.repoRoot, env: changed.env, log: changed.log, verify: changed.verify() }).reason,
    /not an executable but changed/,
  );

  // A verdict for a file the tree does not contain.
  const extra = makeFixture(t);
  assert.equal(
    refusalFor({ unsigned: { 'a.exe': '1' }, signed: { 'a.exe': '2' }, verdicts: new Map([['a.exe', { status: 'Valid', signer: THUMBPRINT, timestamped: true }]]), thumbprint: THUMBPRINT }),
    null,
  );
  assert.match(
    refusalFor({ unsigned: { 'a.exe': '1' }, signed: { 'a.exe': '2', 'b.dll': '3' }, verdicts: new Map(), thumbprint: THUMBPRINT }),
    /other files/,
  );
});

test('store and apply are no-ops without a certificate or an archive', (t) => {
  const fixture = makeFixture(t);
  const bareEnv = { ...fixture.env, WIN_CERT_SHA1: '', IDBOTS_PORTABLE_GIT_ARCHIVE: '' };
  assert.equal(store({ repoRoot: fixture.repoRoot, env: bareEnv, log: fixture.log }).reason, 'not-applicable');
  assert.equal(apply({ repoRoot: fixture.repoRoot, env: bareEnv, log: fixture.log }).hit, false);
  assert.equal(fs.existsSync(path.join(fixture.env.IDBOTS_SIGNING_CACHE_DIR, 'mingit-signed')), false);
});
