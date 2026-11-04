import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dataGuard;
try {
  dataGuard = await import('../dist-electron/main/libs/dataGuard.js');
} catch {
  dataGuard = await import('../dist-electron/main/libs/dataGuard.js');
}

const { detectMissingDatabase, readDataGuardFingerprint, writeDataGuardFingerprint, fingerprintPathFor } = dataGuard;

const DB_FILENAME = 'idbots.sqlite';

const makeTmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'data-guard-'));

const detect = (userDataPath, fingerprintPath) =>
  detectMissingDatabase({ userDataPath, dbFilename: DB_FILENAME, fingerprintPath });

test('a genuine first run (empty data directory, no fingerprint) is not flagged', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(detect(dir, path.join(dir, 'fp.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing database short-circuits detection even with artifacts around', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, DB_FILENAME), 'not-a-real-db-but-present');
    fs.mkdirSync(path.join(dir, 'Local Storage'));
    assert.equal(detect(dir, path.join(dir, 'fp.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing database with prior-usage artifacts is flagged with the artifact list', () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'Local Storage'));
    fs.mkdirSync(path.join(dir, 'dsh-plugins'));
    fs.writeFileSync(path.join(dir, 'main.log'), 'boot noise');

    const evidence = detect(dir, path.join(dir, 'fp.json'));
    assert.ok(evidence, 'expected missing-database evidence');
    assert.equal(evidence.dbPath, path.join(dir, DB_FILENAME));
    assert.equal(evidence.fingerprint, null);
    assert.deepEqual(evidence.priorUsageArtifacts.sort(), ['Local Storage', 'dsh-plugins']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a matching fingerprint flags a vanished database even when the directory is empty', () => {
  const appData = makeTmpDir();
  const userData = makeTmpDir();
  try {
    const fingerprintPath = fingerprintPathFor(appData, userData);
    writeDataGuardFingerprint(fingerprintPath, {
      version: 1,
      updatedAt: '2026-10-31T23:52:00.000Z',
      userDataPath: userData,
      stats: { bots: 2, messages: 23475 },
    });

    const evidence = detect(userData, fingerprintPath);
    assert.ok(evidence, 'expected missing-database evidence');
    assert.equal(evidence.priorUsageArtifacts.length, 0);
    assert.equal(evidence.fingerprint.stats.bots, 2);
    assert.equal(evidence.fingerprint.stats.messages, 23475);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('a fingerprint for a different data directory does not trigger on a clean directory', () => {
  const appData = makeTmpDir();
  const userData = makeTmpDir();
  try {
    const fingerprintPath = fingerprintPathFor(appData, userData);
    writeDataGuardFingerprint(fingerprintPath, {
      version: 1,
      updatedAt: '2026-10-31T23:52:00.000Z',
      userDataPath: path.join(os.tmpdir(), 'some-other-idbots-data'),
    });
    assert.equal(detect(userData, fingerprintPath), null);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('a corrupt fingerprint file is ignored (falls back to artifacts only)', () => {
  const appData = makeTmpDir();
  const userData = makeTmpDir();
  try {
    const fingerprintPath = fingerprintPathFor(appData, userData);
    fs.mkdirSync(path.dirname(fingerprintPath), { recursive: true });
    fs.writeFileSync(fingerprintPath, '{not json at all');

    assert.equal(detect(userData, fingerprintPath), null, 'no artifacts, corrupt fingerprint -> no trigger');

    fs.mkdirSync(path.join(userData, 'metaapps'));
    const evidence = detect(userData, fingerprintPath);
    assert.ok(evidence, 'artifact evidence still applies');
    assert.equal(evidence.fingerprint, null);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('a fingerprint with a wrong schema version is ignored', () => {
  const appData = makeTmpDir();
  const userData = makeTmpDir();
  try {
    const fingerprintPath = fingerprintPathFor(appData, userData);
    fs.mkdirSync(path.dirname(fingerprintPath), { recursive: true });
    fs.writeFileSync(fingerprintPath, JSON.stringify({ version: 99, userDataPath: userData }));

    assert.equal(detect(userData, fingerprintPath), null);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('fingerprint paths are stable per data directory and distinct across directories', () => {
  const a = path.join(os.tmpdir(), 'idbots-data-a');
  const b = path.join(os.tmpdir(), 'idbots-data-b');
  const appData = os.tmpdir();
  assert.equal(fingerprintPathFor(appData, a), fingerprintPathFor(appData, a));
  assert.notEqual(fingerprintPathFor(appData, a), fingerprintPathFor(appData, b));
  assert.ok(fingerprintPathFor(appData, a).startsWith(path.join(appData, 'IDBots-dataguard')));
});

test('fingerprint write/read roundtrip leaves no temp files behind', () => {
  const appData = makeTmpDir();
  const userData = makeTmpDir();
  try {
    const fingerprintPath = fingerprintPathFor(appData, userData);
    const fingerprint = {
      version: 1,
      updatedAt: '2026-11-01T13:25:00.000Z',
      userDataPath: userData,
      stats: { bots: 1, messages: 134 },
    };
    writeDataGuardFingerprint(fingerprintPath, fingerprint);

    const written = readDataGuardFingerprint(fingerprintPath);
    assert.deepEqual(written, fingerprint);

    const leftovers = fs.readdirSync(path.dirname(fingerprintPath)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
