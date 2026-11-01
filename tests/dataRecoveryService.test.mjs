// feat/legacy-data-recovery — unit tests for
// src/main/services/dataRecoveryService.ts.
//
// Run (after `pnpm run compile:electron` / `npx tsc --project
// electron-tsconfig.json`):
//   node --test tests/dataRecoveryService.test.mjs
//
// NOTE: tests/* is gitignored except a whitelist; this file needs
// `git add -f tests/dataRecoveryService.test.mjs` when committing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNativeSqliteDatabase } from '../dist-electron/main/nativeSqliteDatabase.js';
import { DB_FILENAME } from '../dist-electron/main/appConstants.js';
import {
  readSqliteMetabotsSummary,
  listLegacyDataDirCandidates,
  discoverLegacyDbCandidates,
  rankLegacyDbCandidates,
  copySqliteTrio,
  overwriteStaleSqliteSidecars,
  runVersionChangeBackup,
  readVersionMarker,
  readDataDirectoryOverrideMarker,
  writeDataDirectoryOverrideMarker,
  resolveLocalAppDataRoot,
  runStartupDataRecoveryGuard,
  backupsDirFor,
  DATA_RECOVERY_VERSION_MARKER_FILENAME,
  DATA_RECOVERY_DIRECTORY_MARKER_FILENAME,
} from '../dist-electron/main/services/dataRecoveryService.js';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a real candidate data directory with an idbots.sqlite carrying
 *  the given metabots rows (name, updated_at). */
function writeFixtureDb(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, DB_FILENAME);
  const db = createNativeSqliteDatabase(dbPath);
  assert.ok(db, 'node:sqlite unavailable — cannot build test fixtures');
  db.run('CREATE TABLE IF NOT EXISTS metabots (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, updated_at INTEGER NOT NULL)');
  for (const [name, updatedAt] of rows) {
    db.run('INSERT INTO metabots (name, updated_at) VALUES (?, ?)', [name, updatedAt]);
  }
  db.close(); // checkpoints WAL into the main file
  return dbPath;
}

function makeFakeGuardDeps(options = {}) {
  const calls = {
    dialogs: [],
    persisted: [],
    closeCurrentStore: 0,
    relaunch: 0,
    exit: [],
  };
  const skipped = new Set();
  const deps = {
    discovery: options.discovery,
    getCurrentMetabotsCount: options.getCurrentMetabotsCount ?? (() => 0),
    getSkippedCandidateDbPaths: () => [...skipped],
    persistSkippedCandidate: (dbPath) => {
      skipped.add(dbPath);
      calls.persisted.push(dbPath);
    },
    showMessageBox: async (dialogOptions) => {
      calls.dialogs.push(dialogOptions);
      return { response: options.response ?? 2 };
    },
    closeCurrentStore: () => {
      calls.closeCurrentStore += 1;
    },
    relaunchApp: () => {
      calls.relaunch += 1;
    },
    exitApp: (code) => {
      calls.exit.push(code);
    },
    log: () => {},
    now: () => options.now ?? 1_700_000_000_000,
  };
  return { deps, calls, skipped };
}

// ---------------------------------------------------------------------------
// Read-only probing
// ---------------------------------------------------------------------------

test('readSqliteMetabotsSummary: counts rows and reads the newest updated_at', () => {
  const dir = makeTmpDir('drc-probe-');
  const dbPath = writeFixtureDb(dir, [
    ['a', 100],
    ['b', 200],
    ['c', 150],
  ]);
  const summary = readSqliteMetabotsSummary(dbPath);
  assert.ok(summary);
  assert.equal(summary.metabotsCount, 3);
  assert.equal(summary.lastUpdatedAt, 200);
});

test('readSqliteMetabotsSummary: missing file, empty db, and db without metabots table read as unusable/empty', () => {
  assert.equal(readSqliteMetabotsSummary(path.join(makeTmpDir('drc-probe-miss-'), DB_FILENAME)), null);

  const emptyDir = makeTmpDir('drc-probe-empty-');
  const emptyDb = writeFixtureDb(emptyDir, []);
  const emptySummary = readSqliteMetabotsSummary(emptyDb);
  assert.ok(emptySummary);
  assert.equal(emptySummary.metabotsCount, 0);

  // A sqlite file without a metabots table (not an IDBots library).
  const foreignDir = makeTmpDir('drc-probe-foreign-');
  const foreignDb = createNativeSqliteDatabase(path.join(foreignDir, DB_FILENAME));
  foreignDb.run('CREATE TABLE other (x INTEGER)');
  foreignDb.close();
  assert.equal(readSqliteMetabotsSummary(path.join(foreignDir, DB_FILENAME)), null);
});

test('readSqliteMetabotsSummary never writes sidecars into the candidate directory (immutable read-only)', () => {
  const dir = makeTmpDir('drc-probe-clean-');
  const dbPath = writeFixtureDb(dir, [['x', 1]]);
  const before = fs.readdirSync(dir).sort();
  const summary = readSqliteMetabotsSummary(dbPath);
  const after = fs.readdirSync(dir).sort();
  assert.ok(summary);
  assert.equal(summary.metabotsCount, 1);
  // Regression: a plain { readOnly: true } open of a WAL-mode database
  // creates -shm/-wal in the candidate dir; the immutable URI probe must
  // leave the directory byte-identical.
  assert.deepEqual(after, before);
});

test('readSqliteMetabotsSummary handles candidate paths with spaces and unicode', () => {
  const base = makeTmpDir('drc-probe-space-');
  const dir = path.join(base, 'IDBots 旧备份');
  const dbPath = writeFixtureDb(dir, [['x', 1]]);
  const summary = readSqliteMetabotsSummary(dbPath);
  assert.ok(summary);
  assert.equal(summary.metabotsCount, 1);
});

// ---------------------------------------------------------------------------
// Candidate discovery & ranking
// ---------------------------------------------------------------------------

function buildDiscoveryTree() {
  const base = makeTmpDir('drc-disc-');
  const appData = path.join(base, 'Roaming');
  const localAppData = path.join(base, 'Local');
  const currentUserData = path.join(appData, 'IDBots');
  const windowsOldUsers = path.join(base, 'Windows.old', 'Users');

  fs.mkdirSync(currentUserData, { recursive: true }); // current dir: excluded by path
  writeFixtureDb(path.join(appData, 'IDBots-old'), [
    ['a', 100],
    ['b', 200],
  ]);
  writeFixtureDb(path.join(appData, 'OctoBot'), [['legacy', 50]]);
  writeFixtureDb(path.join(appData, 'IDBots-empty'), []);
  writeFixtureDb(path.join(localAppData, 'IDBots'), [['local', 300]]);
  const windowsOldCandidate = writeFixtureDb(
    path.join(windowsOldUsers, 'u1', 'AppData', 'Roaming', 'IDBots'),
    [['old-machine', 400]],
  );

  return { base, appData, localAppData, currentUserData, windowsOldUsers, windowsOldCandidate };
}

test('candidate discovery lists IDBots*/legacy dirs across roots and excludes the current userData', () => {
  const tree = buildDiscoveryTree();
  const dirs = listLegacyDataDirCandidates({
    appDataPath: tree.appData,
    currentUserDataPath: tree.currentUserData,
    localAppDataPath: tree.localAppData,
    windowsOldUsersPath: tree.windowsOldUsers,
  });
  const names = dirs.map((dir) => path.basename(dir));
  assert.ok(names.includes('IDBots-old'));
  assert.ok(names.includes('OctoBot'));
  assert.ok(names.includes('IDBots-empty'));
  assert.ok(dirs.includes(path.join(tree.localAppData, 'IDBots')));
  assert.ok(dirs.includes(path.dirname(tree.windowsOldCandidate)));
  assert.ok(!dirs.includes(tree.currentUserData), 'current userData must be excluded');

  // Windows-specific roots absent → silently skipped (macOS dev behavior).
  const withoutWindowsRoots = listLegacyDataDirCandidates({
    appDataPath: tree.appData,
    currentUserDataPath: tree.currentUserData,
  });
  assert.ok(withoutWindowsRoots.length > 0);
  assert.ok(withoutWindowsRoots.every((dir) => !dir.includes('Windows.old')));
});

test('discovery keeps only candidates with bots; ranking prefers most bots, then newest', () => {
  const tree = buildDiscoveryTree();
  const candidates = discoverLegacyDbCandidates({
    appDataPath: tree.appData,
    currentUserDataPath: tree.currentUserData,
    localAppDataPath: tree.localAppData,
    windowsOldUsersPath: tree.windowsOldUsers,
  });
  assert.equal(candidates.length, 4);
  assert.ok(!candidates.some((candidate) => candidate.rootDir.endsWith('IDBots-empty')));

  const ranked = rankLegacyDbCandidates(candidates);
  // Most bots first: IDBots-old has 2.
  assert.ok(ranked[0].rootDir.endsWith('IDBots-old'));
  // Among the single-bot candidates the Windows.old one is the newest (400).
  assert.equal(ranked[1].dbPath, tree.windowsOldCandidate);
});

// ---------------------------------------------------------------------------
// Root resolvers
// ---------------------------------------------------------------------------

test('resolveLocalAppDataRoot: env override wins, derived Local sibling as fallback, null when neither exists', () => {
  const base = makeTmpDir('drc-local-');
  const roaming = path.join(base, 'Roaming');
  const local = path.join(base, 'Local');
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(local, { recursive: true });

  assert.equal(resolveLocalAppDataRoot(roaming, { LOCALAPPDATA: local }), local);
  assert.equal(resolveLocalAppDataRoot(roaming, {}), local); // derived sibling
  assert.equal(resolveLocalAppDataRoot(roaming, { LOCALAPPDATA: path.join(base, 'missing') }), local);
  const lone = makeTmpDir('drc-local-lone-');
  assert.equal(resolveLocalAppDataRoot(lone, {}), null);
});

// ---------------------------------------------------------------------------
// Trio copy & stale sidecars
// ---------------------------------------------------------------------------

test('copySqliteTrio copies whichever of the trio exists; missing members are skipped', () => {
  const source = makeTmpDir('drc-copy-src-');
  const dest = makeTmpDir('drc-copy-dst-');
  fs.writeFileSync(path.join(source, DB_FILENAME), 'MAIN');
  fs.writeFileSync(path.join(source, `${DB_FILENAME}-wal`), 'WAL');
  const copied = copySqliteTrio(source, dest);
  assert.deepEqual([...copied].sort(), [DB_FILENAME, `${DB_FILENAME}-wal`]);
  assert.equal(fs.readFileSync(path.join(dest, DB_FILENAME), 'utf8'), 'MAIN');
  assert.equal(fs.readFileSync(path.join(dest, `${DB_FILENAME}-wal`), 'utf8'), 'WAL');
  assert.equal(fs.existsSync(path.join(dest, `${DB_FILENAME}-shm`)), false);
});

test('overwriteStaleSqliteSidecars zeroes stale non-empty wal/shm but keeps replaced ones', () => {
  const dir = makeTmpDir('drc-sidecar-');
  fs.writeFileSync(path.join(dir, `${DB_FILENAME}-wal`), 'STALE-WAL');
  fs.writeFileSync(path.join(dir, `${DB_FILENAME}-shm`), 'STALE-SHM');
  overwriteStaleSqliteSidecars(dir, new Set(['-wal']));
  assert.equal(fs.readFileSync(path.join(dir, `${DB_FILENAME}-wal`), 'utf8'), 'STALE-WAL'); // replaced by import copy
  assert.equal(fs.statSync(path.join(dir, `${DB_FILENAME}-shm`)).size, 0); // neutralized
});

// ---------------------------------------------------------------------------
// Version-change backup rotation (copy & create only — nothing is deleted)
// ---------------------------------------------------------------------------

test('version backup: fresh install initializes the marker only; upgrades rotate 5 slots overwriting the oldest', () => {
  const userData = makeTmpDir('drc-ver-');
  fs.writeFileSync(path.join(userData, DB_FILENAME), 'main-fresh');
  fs.writeFileSync(path.join(userData, `${DB_FILENAME}-wal`), 'wal-fresh');

  let outcome = runVersionChangeBackup({
    currentVersion: '1.0.0',
    userDataPath: userData,
    hasExistingData: false,
    now: 1_000,
  });
  assert.equal(outcome, 'marker-initialized');
  const backupsDir = backupsDirFor(userData);
  assert.equal(fs.readdirSync(backupsDir).filter((name) => name.startsWith('version-slot-')).length, 0);

  for (let i = 1; i <= 7; i += 1) {
    fs.writeFileSync(path.join(userData, DB_FILENAME), `main-1.0.${i}`);
    outcome = runVersionChangeBackup({
      currentVersion: `1.0.${i}`,
      userDataPath: userData,
      hasExistingData: true,
      now: 1_000 + i * 10_000,
    });
    assert.equal(outcome, 'backup-created');
  }

  const slots = fs.readdirSync(backupsDir).filter((name) => name.startsWith('version-slot-'));
  assert.equal(slots.length, 5);
  const metas = slots.map((slot) => ({
    slot,
    meta: JSON.parse(fs.readFileSync(path.join(backupsDir, slot, 'slot-meta.json'), 'utf8')),
  }));
  const toVersions = metas.map((entry) => entry.meta.toVersion).sort();
  assert.deepEqual(toVersions, ['1.0.3', '1.0.4', '1.0.5', '1.0.6', '1.0.7']); // last five upgrades survive

  // The slot holding 1.0.7 contains the 1.0.7 database bytes (overwrite in place).
  const v7 = metas.find((entry) => entry.meta.toVersion === '1.0.7');
  assert.equal(fs.readFileSync(path.join(backupsDir, v7.slot, DB_FILENAME), 'utf8'), 'main-1.0.7');

  // Same version → no new backup, marker stays current.
  outcome = runVersionChangeBackup({
    currentVersion: '1.0.7',
    userDataPath: userData,
    hasExistingData: true,
    now: 999_999,
  });
  assert.equal(outcome, 'no-version-change');
  assert.equal(fs.readdirSync(backupsDir).filter((name) => name.startsWith('version-slot-')).length, 5);
  assert.equal(readVersionMarker(userData).version, '1.0.7');

  // Audit log records the backups.
  const log = fs.readFileSync(path.join(backupsDir, 'backup-log.txt'), 'utf8');
  assert.ok(log.includes('prefix=version'));
});

// ---------------------------------------------------------------------------
// Data-directory override marker
// ---------------------------------------------------------------------------

test('data-directory override marker: round-trip, and invalid targets read as absent', () => {
  const base = makeTmpDir('drc-marker-');
  const appData = path.join(base, 'appdata');
  const target = makeTmpDir('drc-marker-target-');
  writeFixtureDb(target, [['t', 1]]);

  assert.equal(readDataDirectoryOverrideMarker(appData), null); // no marker yet
  writeDataDirectoryOverrideMarker(appData, target, 123);
  assert.equal(readDataDirectoryOverrideMarker(appData), target);

  // Target lost its database → marker ignored (never deleted).
  fs.renameSync(path.join(target, DB_FILENAME), path.join(target, `${DB_FILENAME}.away`));
  assert.equal(readDataDirectoryOverrideMarker(appData), null);
  fs.renameSync(path.join(target, `${DB_FILENAME}.away`), path.join(target, DB_FILENAME));
  assert.equal(readDataDirectoryOverrideMarker(appData), target);

  // Corrupt marker → ignored.
  fs.writeFileSync(
    path.join(appData, 'IDBots', DATA_RECOVERY_DIRECTORY_MARKER_FILENAME),
    '{not json',
  );
  assert.equal(readDataDirectoryOverrideMarker(appData), null);
});

// ---------------------------------------------------------------------------
// Startup guard
// ---------------------------------------------------------------------------

function buildGuardScenario() {
  const base = makeTmpDir('drc-guard-');
  const appData = path.join(base, 'appdata');
  const currentUserData = path.join(appData, 'IDBots');
  const candidateDir = path.join(appData, 'IDBots-backup');
  fs.mkdirSync(currentUserData, { recursive: true });
  fs.writeFileSync(path.join(currentUserData, DB_FILENAME), 'old-empty-db');
  fs.writeFileSync(path.join(currentUserData, `${DB_FILENAME}-wal`), 'STALE-WAL');
  fs.writeFileSync(path.join(currentUserData, `${DB_FILENAME}-shm`), 'STALE-SHM');
  const candidateDb = writeFixtureDb(candidateDir, [
    ['bot-1', 500],
    ['bot-2', 600],
  ]);
  return { base, appData, currentUserData, candidateDir, candidateDb };
}

test('guard: non-empty library short-circuits without scanning', async () => {
  const scenario = buildGuardScenario();
  const { deps, calls } = makeFakeGuardDeps({
    discovery: {
      appDataPath: scenario.appData,
      currentUserDataPath: scenario.currentUserData,
    },
    getCurrentMetabotsCount: () => 5,
    response: 0,
  });
  assert.equal(await runStartupDataRecoveryGuard(deps), 'library-not-empty');
  assert.equal(calls.dialogs.length, 0);
});

test('guard: skip persists per candidate and never re-prompts for it', async () => {
  const scenario = buildGuardScenario();
  const { deps, calls } = makeFakeGuardDeps({
    discovery: {
      appDataPath: scenario.appData,
      currentUserDataPath: scenario.currentUserData,
    },
    response: 2,
  });
  assert.equal(await runStartupDataRecoveryGuard(deps), 'skipped-persisted');
  assert.equal(calls.dialogs.length, 1);
  assert.deepEqual(calls.persisted, [scenario.candidateDb]);

  // Second boot with the persisted skip: no dialog at all.
  assert.equal(await runStartupDataRecoveryGuard(deps), 'all-skipped');
  assert.equal(calls.dialogs.length, 1);
});

test('guard: import backs up the current trio first, copies the candidate over, neutralizes stale sidecars, relaunches', async () => {
  const scenario = buildGuardScenario();
  const candidateBytes = fs.readFileSync(scenario.candidateDb);
  const { deps, calls } = makeFakeGuardDeps({
    discovery: {
      appDataPath: scenario.appData,
      currentUserDataPath: scenario.currentUserData,
    },
    response: 0,
  });
  assert.equal(await runStartupDataRecoveryGuard(deps), 'import-executed');

  assert.equal(calls.closeCurrentStore, 1);
  assert.equal(calls.relaunch, 1);
  assert.deepEqual(calls.exit, [0]);

  const backupsDir = backupsDirFor(scenario.currentUserData);
  const actionSlots = fs.readdirSync(backupsDir).filter((name) => name.startsWith('action-slot-'));
  assert.equal(actionSlots.length, 1);
  const actionSlot = path.join(backupsDir, actionSlots[0]);
  // The pre-action backup captured the PRE-import (empty) trio, logged.
  assert.equal(fs.readFileSync(path.join(actionSlot, DB_FILENAME), 'utf8'), 'old-empty-db');
  assert.equal(fs.readFileSync(path.join(actionSlot, `${DB_FILENAME}-wal`), 'utf8'), 'STALE-WAL');
  const log = fs.readFileSync(path.join(backupsDir, 'backup-log.txt'), 'utf8');
  assert.ok(log.includes('pre-import'));

  // The current database is now the candidate's bytes; stale sidecars neutralized.
  assert.deepEqual(fs.readFileSync(path.join(scenario.currentUserData, DB_FILENAME)), candidateBytes);
  assert.equal(fs.statSync(path.join(scenario.currentUserData, `${DB_FILENAME}-wal`)).size, 0);
  assert.equal(fs.statSync(path.join(scenario.currentUserData, `${DB_FILENAME}-shm`)).size, 0);
  assert.ok(log.includes('import source='));

  // The candidate itself was never modified.
  assert.deepEqual(fs.readFileSync(scenario.candidateDb), candidateBytes);
});

test('guard: switch writes the override marker, keeps the current db untouched, relaunches', async () => {
  const scenario = buildGuardScenario();
  const { deps, calls } = makeFakeGuardDeps({
    discovery: {
      appDataPath: scenario.appData,
      currentUserDataPath: scenario.currentUserData,
    },
    response: 1,
  });
  assert.equal(await runStartupDataRecoveryGuard(deps), 'switch-executed');

  assert.equal(calls.closeCurrentStore, 0); // switch never touches the running store
  assert.equal(calls.relaunch, 1);
  assert.deepEqual(calls.exit, [0]);

  // Marker honored on read-back; current database untouched.
  assert.equal(readDataDirectoryOverrideMarker(scenario.appData), scenario.candidateDir);
  assert.equal(fs.readFileSync(path.join(scenario.currentUserData, DB_FILENAME), 'utf8'), 'old-empty-db');

  const backupsDir = backupsDirFor(scenario.currentUserData);
  const log = fs.readFileSync(path.join(backupsDir, 'backup-log.txt'), 'utf8');
  assert.ok(log.includes('pre-switch'));
  assert.ok(log.includes('switch target='));
});

test('guard: no candidates (macOS dev with empty roots) is a silent no-op', async () => {
  const base = makeTmpDir('drc-guard-none-');
  const appData = path.join(base, 'appdata');
  const currentUserData = path.join(appData, 'IDBots');
  fs.mkdirSync(currentUserData, { recursive: true });
  const { deps, calls } = makeFakeGuardDeps({
    discovery: { appDataPath: appData, currentUserDataPath: currentUserData },
  });
  assert.equal(await runStartupDataRecoveryGuard(deps), 'no-candidates');
  assert.equal(calls.dialogs.length, 0);
});
