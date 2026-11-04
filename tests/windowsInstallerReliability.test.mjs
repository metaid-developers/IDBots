import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
class FakeBrowserWindow {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.showCalls = 0;
    this.listeners = new Map();
    FakeBrowserWindow.instances.push(this);
  }
  once(event, listener) {
    this.listeners.set(event, listener);
  }
  async loadURL(url) {
    this.loadedUrl = url;
    this.listeners.get('ready-to-show')?.();
  }
  show() {
    this.showCalls += 1;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => os.tmpdir(),
        relaunch: () => {},
        quit: () => {},
      },
      BrowserWindow: FakeBrowserWindow,
      session: { defaultSession: { fetch: async () => new Response() } },
    };
  }
  return originalLoad.apply(this, arguments);
};
const {
  launchWindowsNsisInstaller,
} = require('../dist-electron/main/libs/appUpdateInstaller.js');
const {
  runVersionChangeBackupAsync,
  readVersionMarker,
  backupsDirFor,
} = require('../dist-electron/main/services/dataRecoveryService.js');
const { scheduleStartupBackupProgress } = require('../dist-electron/main/libs/startupBackupProgress.js');
const { DB_FILENAME } = require('../dist-electron/main/appConstants.js');
Module._load = originalLoad;

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Windows updater launches the signed NSIS executable directly and detaches it', async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls += 1;
  };
  let invocation;
  const pending = launchWindowsNsisInstaller('C:\\Users\\user\\AppData\\Local\\Temp\\IDBots Setup.exe', (...args) => {
    invocation = args;
    setImmediate(() => child.emit('spawn'));
    return child;
  });

  assert.equal(await pending, 4321);
  assert.equal(invocation[0], 'C:\\Users\\user\\AppData\\Local\\Temp\\IDBots Setup.exe');
  assert.deepEqual(invocation[1], []);
  assert.equal(invocation[2].detached, true);
  assert.equal(invocation[2].stdio, 'ignore');
  assert.equal(invocation[2].windowsHide, false);
  assert.equal(child.unrefCalls, 1);
});

test('Windows updater reports a launcher failure instead of quitting into no installer', async () => {
  const child = new EventEmitter();
  child.unref = () => {
    throw new Error('a failed launch must not be detached');
  };
  const pending = launchWindowsNsisInstaller('C:\\missing\\IDBots Setup.exe', () => {
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  });

  await assert.rejects(pending, /Failed to launch the Windows installer: ENOENT/);
  const source = read('src/main/libs/appUpdateInstaller.ts');
  assert.match(source, /const installerPid = await launchWindowsNsisInstaller\(exePath\);[\s\S]*?app\.quit\(\)/);
  assert.doesNotMatch(source, /wscript\.exe|ExecutionPolicy Bypass|idbots-update-.*\.ps1/);
});

test('NSIS relies on the default running-app flow and restores only a missing desktop shortcut', () => {
  const source = read('scripts/nsis-installer.nsh');
  assert.doesNotMatch(source, /nsExec::ExecToLog\s+'taskkill/);
  assert.match(source, /!macro customInstall/);
  assert.match(source, /IfFileExists "\$newDesktopLink"/);
  assert.match(source, /CreateShortCut "\$newDesktopLink" "\$appExe"/);
  assert.equal((source.match(/CreateShortCut/g) || []).length, 1);
});

test('startup uses asynchronous pre-migration backup with bounded visible progress', () => {
  const main = read('src/main/main.ts');
  const progress = read('src/main/libs/startupBackupProgress.ts');
  assert.match(main, /await runVersionChangeBackupAsync\(/);
  assert.match(main, /scheduleStartupBackupProgress\(\)/);
  assert.match(main, /finally \{\s*backupProgress\?\.close\(\);\s*\}/);
  assert.ok(main.indexOf('await runVersionChangeBackupAsync(') < main.indexOf('store = await initStore();'));
  assert.match(progress, /setTimeout\(/);
  assert.match(progress, /Backing up your data before the update/);
  assert.match(progress, /clearTimeout\(timer\)/);
});

test('slow backup progress appears and always closes; fast backup creates no window', async () => {
  FakeBrowserWindow.instances = [];
  const slow = scheduleStartupBackupProgress(0);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeBrowserWindow.instances.length, 1);
  const progressWindow = FakeBrowserWindow.instances[0];
  assert.equal(progressWindow.showCalls, 1);
  assert.match(decodeURIComponent(progressWindow.loadedUrl), /Backing up your data before the update/);
  slow.close();
  assert.equal(progressWindow.destroyed, true);

  const fast = scheduleStartupBackupProgress(50);
  fast.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(FakeBrowserWindow.instances.length, 1);
});

test('asynchronous version backup preserves pre-upgrade bytes and marker semantics', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-async-version-backup-'));
  try {
    const dbPath = path.join(userData, DB_FILENAME);
    fs.writeFileSync(dbPath, 'before-1.0.10');
    fs.writeFileSync(`${dbPath}-wal`, 'wal-before-1.0.10');

    assert.equal(await runVersionChangeBackupAsync({
      currentVersion: '1.0.10',
      userDataPath: userData,
      hasExistingData: true,
      now: 1000,
    }), 'backup-created');
    assert.equal(readVersionMarker(userData).version, '1.0.10');
    const firstSlot = path.join(backupsDirFor(userData), 'version-slot-1');
    assert.equal(fs.readFileSync(path.join(firstSlot, DB_FILENAME), 'utf8'), 'before-1.0.10');
    assert.equal(fs.readFileSync(path.join(firstSlot, `${DB_FILENAME}-wal`), 'utf8'), 'wal-before-1.0.10');

    fs.writeFileSync(dbPath, 'before-1.0.11');
    assert.equal(await runVersionChangeBackupAsync({
      currentVersion: '1.0.11',
      userDataPath: userData,
      hasExistingData: true,
      now: 2000,
    }), 'backup-created');
    const secondSlot = path.join(backupsDirFor(userData), 'version-slot-2');
    assert.equal(fs.readFileSync(path.join(secondSlot, DB_FILENAME), 'utf8'), 'before-1.0.11');
    assert.equal(fs.readFileSync(path.join(firstSlot, DB_FILENAME), 'utf8'), 'before-1.0.10');

    assert.equal(await runVersionChangeBackupAsync({
      currentVersion: '1.0.11',
      userDataPath: userData,
      hasExistingData: true,
      now: 3000,
    }), 'no-version-change');
  } finally {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best-effort, including on Windows CI.
    }
  }
});
