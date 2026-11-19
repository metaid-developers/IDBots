'use strict';

const path = require('path');
const { existsSync, readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const { ensurePortableGit } = require('./setup-mingit.js');
const { readMacAppVersion } = require('./verify-release-artifact-version.cjs');
const { ensureFfmpeg } = require('./setup-ffmpeg.js');
const {
  resolveFfmpegPlatformKey,
  verifySourceFfmpeg,
  verifySourceRuntimes,
  verifyPackagedFfmpeg,
  verifyPackagedRuntimes,
  verifyPackagedContentResources,
} = require('./packagedRuntimes.cjs');

function isWindowsTarget(context) {
  return context?.electronPlatformName === 'win32';
}

function isMacTarget(context) {
  return context?.electronPlatformName === 'darwin';
}

function findPackagedBash(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources', 'mingit', 'bin', 'bash.exe'),
    path.join(appOutDir, 'resources', 'mingit', 'usr', 'bin', 'bash.exe'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function verifyMacBackgroundSkillHelper(appPath, appName) {
  const helperName = `${appName} Helper`;
  const helperAppPath = path.join(appPath, 'Contents', 'Frameworks', `${helperName}.app`);
  const helperExecutable = path.join(helperAppPath, 'Contents', 'MacOS', helperName);
  if (!existsSync(helperExecutable)) {
    throw new Error(`[electron-builder-hooks] Missing background skill runtime: ${helperExecutable}`);
  }
  const helperPlist = path.join(helperAppPath, 'Contents', 'Info.plist');
  const uiElement = spawnSync('plutil', ['-extract', 'LSUIElement', 'raw', helperPlist], { encoding: 'utf8' });
  if (uiElement.status !== 0 || uiElement.stdout.trim() !== 'true') {
    throw new Error(
      `[electron-builder-hooks] ${helperName}.app must set LSUIElement=true; `
      + 'background skill processes would otherwise appear as generic exec icons in the macOS Dock.',
    );
  }
  console.log('[electron-builder-hooks] Verified background skill runtime is LSUIElement');
}

function applyMacIconFix(appPath) {
  console.log('[electron-builder-hooks] Applying macOS icon fix for Apple Silicon compatibility...');

  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const iconPath = path.join(resourcesPath, 'icon.icns');

  if (!existsSync(infoPlistPath)) {
    console.warn(`[electron-builder-hooks] Info.plist not found at ${infoPlistPath}`);
    return;
  }

  if (!existsSync(iconPath)) {
    console.warn(`[electron-builder-hooks] icon.icns not found at ${iconPath}`);
    return;
  }

  // Check if CFBundleIconName already exists
  const checkResult = spawnSync('plutil', [
    '-extract', 'CFBundleIconName', 'raw', infoPlistPath
  ], { encoding: 'utf-8' });

  if (checkResult.status !== 0) {
    // CFBundleIconName doesn't exist, add it
    console.log('[electron-builder-hooks] Adding CFBundleIconName to Info.plist...');
    const addResult = spawnSync('plutil', [
      '-insert', 'CFBundleIconName', '-string', 'icon', infoPlistPath
    ], { encoding: 'utf-8' });

    if (addResult.status === 0) {
      console.log('[electron-builder-hooks] ✓ CFBundleIconName added successfully');
    } else {
      console.warn('[electron-builder-hooks] Failed to add CFBundleIconName:', addResult.stderr);
    }
  } else {
    console.log('[electron-builder-hooks] ✓ CFBundleIconName already present');
  }

  // Clear extended attributes
  spawnSync('xattr', ['-cr', appPath], { encoding: 'utf-8' });

  // Touch the app to update modification time
  spawnSync('touch', [appPath], { encoding: 'utf-8' });
  spawnSync('touch', [resourcesPath], { encoding: 'utf-8' });

  console.log('[electron-builder-hooks] ✓ macOS icon fix applied');
}

function verifyReleaseInputs() {
  const checkScriptPath = path.join(__dirname, 'check-cross-platform-paths.js');
  const result = spawnSync(process.execPath, [
    checkScriptPath,
    '--skip-lint',
    '--skip-compile',
  ], {
    encoding: 'utf-8',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`release input verification failed with exit code ${result.status}`);
  }
}

async function beforePack(context) {
  verifyReleaseInputs();

  const ffmpegPlatform = resolveFfmpegPlatformKey(context);
  if (ffmpegPlatform) {
    console.log(`[electron-builder-hooks] Ensuring bundled ffmpeg for ${ffmpegPlatform}...`);
    await ensureFfmpeg({ required: true, platforms: [ffmpegPlatform] });
    verifySourceFfmpeg(context);
    console.log('[electron-builder-hooks] Bundled ffmpeg present on disk');
  }

  verifySourceRuntimes();
  console.log('[electron-builder-hooks] Nested packaged runtime dependencies present');

  if (!isWindowsTarget(context)) {
    return;
  }

  console.log('[electron-builder-hooks] Windows target detected, ensuring PortableGit is prepared...');
  await ensurePortableGit({ required: true });
}

// Windows MAX_PATH guard (measured against the REAL packed tree).
//
// The per-user default install dir is C:\Users\<u>\AppData\Local\Programs\IDBots\
// = 40 + len(username) chars, so an installed file's absolute path is
// 40 + len(username) + <path relative to the unpacked app root>. NSIS cannot
// extract paths beyond 260 chars, and a mid-install extraction failure means
// a PARTIAL install (missing runtime files) — the "cannot install" class for
// long/Chinese usernames. Measured 2026-11-19: the deepest packaged path
// (a SKILLs doc file) sits at 256/260 for a 20-char username, so this gate
// fails the build the moment the payload grows even slightly deeper.
const WIN_MAX_PATH_LIMIT = 260;
const WIN_DEEPEST_BUDGET_USERNAME = 20;
const WIN_WARN_BUDGET_USERNAME = 30;

function verifyWindowsInstallPathBudget(appOutDir) {
  const deepest = { rel: '', len: 0 };
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(appOutDir, full);
        if (rel.length > deepest.len) {
          deepest.rel = rel;
          deepest.len = rel.length;
        }
      }
    }
  };
  walk(appOutDir);
  if (!deepest.len) {
    console.warn('[electron-builder-hooks] No packaged files found for the install-path budget check');
    return;
  }
  const installedAt = (usernameLen) => 40 + usernameLen + deepest.len;
  console.log(`[electron-builder-hooks] Deepest packaged path: ${deepest.len} chars (resources/…${deepest.rel.slice(-90)})`);
  console.log(
    `[electron-builder-hooks] Installed path budget: ${installedAt(WIN_DEEPEST_BUDGET_USERNAME)}/${WIN_MAX_PATH_LIMIT} `
    + `for a ${WIN_DEEPEST_BUDGET_USERNAME}-char username, ${installedAt(WIN_WARN_BUDGET_USERNAME)} `
    + `for ${WIN_WARN_BUDGET_USERNAME} (limit ${WIN_MAX_PATH_LIMIT})`,
  );
  if (installedAt(WIN_DEEPEST_BUDGET_USERNAME) > WIN_MAX_PATH_LIMIT) {
    throw new Error(
      `[electron-builder-hooks] Windows install-path overflow: the deepest packaged file reaches `
      + `${installedAt(WIN_DEEPEST_BUDGET_USERNAME)} chars for a ${WIN_DEEPEST_BUDGET_USERNAME}-char username `
      + `(NSIS limit ${WIN_MAX_PATH_LIMIT}): ${deepest.rel}. A long-username install would fail mid-extraction `
      + '(partial install). Trim the payload or shorten the resource path before shipping.',
    );
  }
  if (installedAt(WIN_WARN_BUDGET_USERNAME) > WIN_MAX_PATH_LIMIT) {
    console.warn(
      `[electron-builder-hooks] Windows install-path tight: a ${WIN_WARN_BUDGET_USERNAME}-char username would `
      + `exceed ${WIN_MAX_PATH_LIMIT} chars (${installedAt(WIN_WARN_BUDGET_USERNAME)}). `
      + 'Consider trimming deep SKILLs/runtime doc files.',
    );
  }
}

async function afterPack(context) {
  verifyPackagedRuntimes(context);
  console.log('[electron-builder-hooks] Nested packaged runtimes present in Resources');
  verifyPackagedContentResources(context);
  console.log('[electron-builder-hooks] Packaged content resources free of dot-entries and dead files');
  verifyPackagedFfmpeg(context);
  if (resolveFfmpegPlatformKey(context)) {
    console.log('[electron-builder-hooks] Bundled ffmpeg present in Resources');
  }

  if (isWindowsTarget(context)) {
    verifyWindowsInstallPathBudget(context.appOutDir);
    const bashPath = findPackagedBash(context.appOutDir);
    if (!bashPath) {
      throw new Error(
        '[electron-builder-hooks] Windows package is missing bundled PortableGit (bash.exe). '
        + 'Release packaging must include resources/mingit.'
      );
    } else {
      console.log(`[electron-builder-hooks] Verified bundled PortableGit: ${bashPath}`);
    }
  }

  if (isMacTarget(context)) {
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    if (existsSync(appPath)) {
      applyMacIconFix(appPath);
      verifyMacBackgroundSkillHelper(appPath, appName);

      // The packaged bundle must report the version this build is released as:
      // clients compare their own bundle version against the update manifest, so
      // an artifact reporting a different version makes every installation
      // re-download the same package forever (2026-10-19: the v1.0.1 installer
      // shipped an internal 1.0.0 while the tag, the file name and the manifest
      // all said 1.0.1).
      const expectedVersion = String(context.packager?.appInfo?.version ?? '').trim();
      if (!expectedVersion) {
        throw new Error('[electron-builder-hooks] packager appInfo exposes no version to verify against');
      }
      const actualVersion = readMacAppVersion(appPath);
      if (actualVersion !== expectedVersion) {
        throw new Error(
          `[electron-builder-hooks] packaged app reports version ${actualVersion} but this build is ${expectedVersion}; `
          + 'a published artifact must report its release version.',
        );
      }
      console.log(`[electron-builder-hooks] Verified packaged app version: ${actualVersion}`);
    } else {
      console.warn(`[electron-builder-hooks] App not found at ${appPath}, skipping icon fix`);
    }
  }
}

module.exports = {
  beforePack,
  afterPack,
};
