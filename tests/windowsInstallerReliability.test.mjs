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
  assertWindowsInstallerBundleVersion,
  resolveDownloadMetaPath,
  isTrustedUpdateInstallerPath,
  isUpdaterDrivenShutdown,
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
  // Windows checkouts are CRLF; the line-anchored assertions below stay
  // correct either way, but normalizing keeps future LF-anchored assertions
  // safe too (§11.9, flagged by windows-test-risk-scan).
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
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
  assert.deepEqual(invocation[1], ['--updated']);
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

// ── Windows installer version gate (v1.0.1 mislabeled-bundle incident class) ──

function sidecarFor(installerPath, version) {
  const metaPath = resolveDownloadMetaPath(installerPath);
  fs.writeFileSync(metaPath, JSON.stringify({
    url: 'https://cdn.example.com/IDBots.Setup.exe',
    platform: 'win32',
    arch: 'x64',
    version,
    downloadedSize: 1024,
    updatedAt: Date.now(),
  }), 'utf8');
  return metaPath;
}

test('Windows install refuses an installer whose version resource contradicts the manifest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-update-gate-'));
  const installerPath = path.join(dir, 'idbots-update-0123abcdef456789.exe');
  fs.writeFileSync(installerPath, 'fake');
  sidecarFor(installerPath, '1.1.2');
  try {
    await assert.rejects(
      assertWindowsInstallerBundleVersion(installerPath, async () => '1.1.1'),
      /mislabeled update: the installer reports 1\.1\.1 .* declares 1\.1\.2/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('Windows install accepts a matching version resource, tolerating a v-prefix', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-update-gate-'));
  const installerPath = path.join(dir, 'idbots-update-0123abcdef456789.exe');
  fs.writeFileSync(installerPath, 'fake');
  sidecarFor(installerPath, '1.1.2');
  try {
    await assert.doesNotReject(
      assertWindowsInstallerBundleVersion(installerPath, async () => 'v1.1.2'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('Windows install keeps the legacy behavior without a sidecar and fails open on an unreadable version resource', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-update-gate-'));
  const installerPath = path.join(dir, 'idbots-update-0123abcdef456789.exe');
  fs.writeFileSync(installerPath, 'fake');
  try {
    // No sidecar next to the installer → the gate must not block.
    await assert.doesNotReject(
      assertWindowsInstallerBundleVersion(installerPath, async () => '1.1.1'),
    );
    // Sidecar present but PowerShell could not read the version resource →
    // fail open (a machine where PowerShell is blocked must still be able to
    // update); only a READABLE contradiction is fatal.
    sidecarFor(installerPath, '1.1.2');
    await assert.doesNotReject(
      assertWindowsInstallerBundleVersion(installerPath, async () => null),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('Windows NSIS install gates the installer version resource before spawning it', () => {
  const source = read('src/main/libs/appUpdateInstaller.ts');
  const install = source.slice(source.indexOf('async function installWindowsNsis'));
  assert.match(
    install,
    /await assertWindowsInstallerBundleVersion\(exePath\);[\s\S]*?launchWindowsNsisInstaller\(exePath\)/,
    'the version gate must run before the installer is spawned',
  );
});

test('NSIS customCheckAppRunning closes IDBots and INSTDIR child processes safely and repairs broken shortcuts', () => {
  const source = read('scripts/nsis-installer.nsh');
  assert.doesNotMatch(source, /taskkill[^"\n]*\/T/i);
  assert.match(source, /!macro customCheckAppRunning/);
  assert.match(source, /IDBOTS_TARGET_DIR/);
  assert.match(source, /IDBOTS_OLD_USER_DIR/);
  assert.match(source, /IDBOTS_OLD_MACHINE_DIR/);
  assert.match(source, /taskkill\.exe" \/F \/IM "\$\{APP_EXECUTABLE_FILENAME\}" \/FI "PID ne \$R8"/);
  assert.match(source, /ExecShellWait "runas" "\$SYSDIR\\taskkill\.exe"/);
  // Session-scoped kill (2026-11-19 review P2): the fast taskkill must carry
  // the installer session's filter — a bare /IM is machine-wide and force-
  // killed ANOTHER session's instance under fast user switching, losing that
  // session's in-flight bot work. Session resolution fails closed (unknown
  // session kills nothing); the UAC-elevated retry keeps its machine-wide
  // form on purpose (it exists to reach the other ELEVATION of our own app).
  assert.match(source, /ProcessIdToSessionId\(i \$R8, \*i \.R9\) i \.R7/);
  assert.match(source, /\/FI "SESSION eq \$R9"/);
  assert.match(source, /\$\{If\} \$\{UAC_IsInnerInstance\}[\s\S]*?!insertmacro customCheckAppRunning/);
  assert.match(source, /IfFileExists "\$APPDATA\\IDBots\\idbots\.sqlite" _idbots_data_check_done 0/);
  assert.match(source, /!macro customInstall/);
  assert.match(source, /IfFileExists "\$newDesktopLink"/);
  assert.match(source, /CreateShortCut "\$newDesktopLink" "\$appExe"/);
  assert.equal((source.match(/CreateShortCut/g) || []).length, 1);
  assert.match(source, /IDBOTS_STARTMENU_LINK/);
  assert.match(source, /User Pinned\\TaskBar/);
  // Fast native tasklist/findstr gates avoid cold-spawning PowerShell + CIM on normal upgrades.
  assert.doesNotMatch(source, /gcim\s+Win32_Process/i);
  assert.match(source, /!macro _IDBOTS_FIND_MAIN_EXE/);
  assert.match(source, /!macro _IDBOTS_FIND_BUNDLED_CANDIDATES/);
  assert.match(source, /IdbotsPrevUserDir/);
  assert.match(source, /IdbotsPrevMachineDir/);
  // Finish-page "Run IDBots" launches $appExe directly instead of $launchLink (.lnk)
  // so --updated arguments and UAC/non-elevated modes always start IDBots.exe.
  assert.match(source, /!macro customFinishPage/);
  assert.match(source, /Function StartApp/);
  assert.match(source, /UAC_AsUser_Call Function _IdbotsLaunchFromUserProcess/);
  assert.match(source, /\$\{StdUtils\.ExecShellAsUser\} \$0 "\$appExe" "open" "\$1"/);
  assert.doesNotMatch(source, /"\$launchLink"/);
  // Finish-page verification is 5x250ms plus one DE-ELEVATED retry; the old
  // direct elevated Exec fallback spawned an admin-elevated IDBots.exe on a
  // slow shell (single-instance absorbed the duplicate but the survivor kept
  // an admin token) — deliberately gone (2026-11-19 review P2).
  assert.match(source, /\$R2 < 5/, 'the finish-page verify loop waits ~1.25s across 5 rounds');
  assert.equal((source.match(/Exec '"\$appExe" \$1'/g) || []).length, 1,
    'elevated direct Exec is gone: only the NON-elevated branch may spawn $appExe directly (the helper launches via $INSTDIR paths)');
  // The grammar gate must be wired into CI (regex pins cannot see NSIS
  // grammar — the first real compile is where this class of bug surfaces).
  const workflow = read('.github/workflows/build.yml');
  assert.match(workflow, /Compile the NSIS syntax harness \(makensis -WX\)/);
  assert.match(workflow, /node scripts\/verify-nsis-harness\.mjs --require-makensis/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts', 'verify-nsis-harness.mjs')), true);
  // PowerShell variables inside NSIS strings must be escaped as $$ to avoid makensis -WX warnings.
  assert.doesNotMatch(source, /(?<!\$)\$(?:ErrorActionPreference|env:|PID\b)/);

  const main = read('src/main/main.ts');
  assert.match(main, /app\.setAppUserModelId\('ai\.idbots\.app'\)/);
});

test('desktop shutdown enforces a cleanup watchdog, closes HTTP keep-alive connections, and caps child teardown waits', () => {
  const main = read('src/main/main.ts');
  const dshKernel = read('src/main/libs/dshKernel/dshKernel.ts');
  const skillServices = read('src/main/skillServices.ts');
  const compatProxy = read('src/main/libs/coworkOpenAICompatProxy.ts');
  const metaAppServer = read('src/main/services/metaAppLocalServer.ts');
  const webToolsProxy = read('src/main/services/dshWebToolsProxy.ts');

  assert.match(main, /DESKTOP_CLEANUP_TIMEOUT_MS\s*=\s*5_000/);
  assert.match(main, /finishCleanupAndExit/);
  assert.match(dshKernel, /shutdownTimeoutMs:\s*800/);
  assert.match(dshKernel, /disposeEofGraceMs:\s*1_500/);
  assert.match(dshKernel, /disposeGraceMs:\s*1_000/);
  assert.match(skillServices, /taskkill/);
  assert.doesNotMatch(skillServices, /setTimeout\(resolve,\s*2000\)/);
  assert.match(compatProxy, /server\.closeAllConnections\?\.\(\)/);
  assert.match(metaAppServer, /localServer\.closeAllConnections\?\.\(\)/);
  assert.match(webToolsProxy, /server\.closeAllConnections\?\.\(\)/);
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

// setTimeout(0) races setImmediate — under CI load the window's creation
// timer can land after two setImmediate hops (arm64 flake, run 43717315955).
// Poll until the expected state shows up instead of sleeping fixed hops.
async function waitFor(predicate, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('slow backup progress appears and always closes; fast backup creates no window', async () => {
  FakeBrowserWindow.instances = [];
  const slow = scheduleStartupBackupProgress(0);
  await waitFor(() => FakeBrowserWindow.instances.length === 1, 'the slow backup progress window');
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

// ── Win-compat P2 batch: reuse checksum, IPC path trust, shutdown budget, MAX_PATH ──

test('the install IPC only accepts updater temp-dir artifacts, whatever the renderer sends', () => {
  const temp = os.tmpdir();
  assert.equal(isTrustedUpdateInstallerPath(path.join(temp, 'idbots-update-0123abcdef456789.exe'), temp), true);
  assert.equal(isTrustedUpdateInstallerPath(path.join(temp, 'idbots-update-0123abcdef456789.dmg'), temp), true);
  assert.equal(isTrustedUpdateInstallerPath(path.join(temp, 'evil.exe'), temp), false, 'wrong name');
  assert.equal(isTrustedUpdateInstallerPath(path.join(temp, 'idbots-update-zzzz.exe'), temp), false, 'name is not 16 hex chars');
  assert.equal(isTrustedUpdateInstallerPath(path.join(temp, 'sub', 'idbots-update-0123abcdef456789.exe'), temp), false, 'subdirectory rejected');
  assert.equal(isTrustedUpdateInstallerPath(path.join(os.homedir(), 'elsewhere', 'idbots-update-0123abcdef456789.exe'), temp), false, 'another tree rejected');
  assert.equal(isTrustedUpdateInstallerPath('', temp), false);
  assert.equal(isTrustedUpdateInstallerPath(undefined, temp), false);
});

test('both install handlers gate the renderer-supplied path before executing it', () => {
  const source = read('src/main/main.ts');
  const install = source.slice(source.indexOf("registerIpcHandler('appUpdate:install'"));
  const applySilent = source.slice(source.indexOf("registerIpcHandler('appUpdate:applySilent'"));
  assert.match(install, /if \(!isTrustedUpdateInstallerPath\(filePath\)\)/);
  assert.match(applySilent, /if \(!isTrustedUpdateInstallerPath\(filePath\)\)/);
});

test('an updater-driven quit extends the cleanup watchdog past the installer kill window', () => {
  // The NSIS installer launches and the app quits in the same breath; the app
  // side must know the quit is updater-driven (set in installWindowsNsis) or
  // its 5s budget would lose the race it was extended for.
  const source = read('src/main/libs/appUpdateInstaller.ts');
  assert.match(source, /updaterDrivenShutdown = true;/);
  assert.match(source, /app\.quit\(\)/);
  const mainSource = read('src/main/main.ts');
  assert.match(mainSource, /const UPDATE_CLEANUP_TIMEOUT_MS = 15_000;/);
  assert.match(mainSource, /const cleanupTimeoutMs = \(\) => \(isUpdaterDrivenShutdown\(\) \? UPDATE_CLEANUP_TIMEOUT_MS : DESKTOP_CLEANUP_TIMEOUT_MS\);/);
  assert.equal(isUpdaterDrivenShutdown(), false, 'flag starts false in a fresh module');
});

test('the NSIS grace loop waits ~30s for an updater-driven quit before force-killing', () => {
  const source = read('scripts/nsis-installer.nsh');
  assert.match(source, /\$R1 < 120/, '120 × 250ms = 30s for the isUpdated grace loop');
  assert.match(source, /up to ~30s/);
});

test('the Windows package build fails on an install-path overflow', () => {
  const source = read('scripts/electron-builder-hooks.cjs');
  assert.match(source, /const WIN_MAX_PATH_LIMIT = 260;/);
  assert.match(source, /function verifyWindowsInstallPathBudget\(appOutDir\)/);
  assert.match(source, /verifyWindowsInstallPathBudget\(context\.appOutDir\)/, 'wired into afterPack for Windows targets');
  assert.match(source, /installedAt\(WIN_DEEPEST_BUDGET_USERNAME\) > WIN_MAX_PATH_LIMIT/);
});

test('the python runtime re-sync survives Windows file-handle races with bounded retries', () => {
  const source = read('src/main/libs/pythonRuntime.ts');
  assert.match(source, /fs\.rmSync\(userRoot, \{[\s\S]*?maxRetries: process\.platform === 'win32' \? 5 : 0,[\s\S]*?retryDelay: process\.platform === 'win32' \? 200 : 0,/);
});

// ── Update-wizard scope skip + auto-launch retarget (#5) ──

const { shouldRetargetAutoLaunch } = require('../dist-electron/main/autoLaunchManager.js');

test('auto-launch retargets only when the path moved and the user still wants it', () => {
  assert.equal(
    shouldRetargetAutoLaunch({ lastRegisteredExePath: 'C:\\App\\old\\IDBots.exe', currentExePath: 'C:\\App\\new\\IDBots.exe', autoLaunchEnabled: true }),
    true,
    'moved install with auto-launch on → re-register',
  );
  assert.equal(
    shouldRetargetAutoLaunch({ lastRegisteredExePath: 'C:\\App\\old\\IDBots.exe', currentExePath: 'C:\\App\\new\\IDBots.exe', autoLaunchEnabled: false }),
    false,
    'user opted out → never forced back on',
  );
  assert.equal(
    shouldRetargetAutoLaunch({ lastRegisteredExePath: 'C:\\App\\IDBots.exe', currentExePath: 'C:\\App\\IDBots.exe', autoLaunchEnabled: true }),
    false,
    'same path → nothing to do',
  );
  assert.equal(
    shouldRetargetAutoLaunch({ lastRegisteredExePath: undefined, currentExePath: 'C:\\App\\IDBots.exe', autoLaunchEnabled: true }),
    false,
    'first run registers separately, no retarget',
  );
});

test('an update skips the install-mode page by forcing the previous install scope', () => {
  const source = read('scripts/nsis-installer.nsh');
  assert.match(source, /!macro customInstallMode/, 'electron-builder hook that runs inside the page pre function');
  assert.match(source, /\$\{If\} \$IdbotsPrevUserDir != ""[\s\S]*?StrCpy \$isForceCurrentInstall "1"/, 'per-user history → force per-user, page aborts');
  assert.match(source, /\$\{ElseIf\} \$IdbotsPrevMachineDir != ""[\s\S]*?StrCpy \$isForceMachineInstall "1"/, 'per-machine history → force per-machine');
  assert.match(source, /\$\{If\} \$\{isUpdated\}/, 'a fresh install keeps the interactive page');
});

test('the app re-registers auto-launch when the exe path moved since last boot', () => {
  const source = read('src/main/main.ts');
  assert.match(source, /shouldRetargetAutoLaunch\(\{/);
  assert.match(source, /'auto_launch_last_exe'/);
  assert.match(source, /Re-registered auto-launch for the moved install/);
});
