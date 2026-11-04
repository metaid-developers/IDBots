'use strict';

const path = require('path');
const { existsSync, readdirSync, statSync } = require('fs');
const { PLATFORM_ASSETS } = require('./setup-ffmpeg.js');

/**
 * Nested extraResource runtimes that ship their own node_modules.
 * Add an entry here when packaging another gitignored runtime directory.
 * beforePack verifies the source tree; afterPack verifies the copied app Resources.
 */
const PACKAGED_RUNTIMES = [
  {
    id: 'dsh-runtime',
    dir: 'dsh-runtime',
    extraResourceFrom: 'dsh-runtime',
    extraResourceTo: 'dsh-runtime',
    markers: [
      'bin.mjs',
      path.join('node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js'),
      path.join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    ],
  },
];

/**
 * Suffixes of files under a packaged runtime's node_modules that nothing loads
 * at run time: TypeScript declarations and source maps. They are roughly 43%
 * of the files the Windows installer has to extract (and the previous
 * version's uninstaller has to delete), so the extraResources filter drops
 * them and afterPack fails closed if any slip through.
 *
 * `.md` must NOT be added: the DSH kernel ships built-in skills
 * (dsh-agent-preset/skills/.../SKILL.md, dsh-skill-office/assets/.../SKILL.md)
 * and DevTools issue descriptions as markdown inside node_modules and reads
 * them at run time.
 */
const RUNTIME_DEAD_FILE_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts', '.map'];

/** The electron-builder filter entries that implement RUNTIME_DEAD_FILE_SUFFIXES. */
const RUNTIME_DEAD_FILE_FILTERS = RUNTIME_DEAD_FILE_SUFFIXES.map(
  (suffix) => `!**/node_modules/**/*${suffix}`,
);

// Keep singular `test` directories: Playwright loads lib/mcp/test/browserBackend
// as production code. The current dependency tree has no production imports
// into __tests__/tests; afterPack enforces the same boundary.
const RUNTIME_TEST_DIRECTORY_NAMES = ['__tests__', 'tests'];
const RUNTIME_TEST_DIRECTORY_FILTERS = RUNTIME_TEST_DIRECTORY_NAMES.map(
  (directory) => `!**/node_modules/**/${directory}/**`,
);

/**
 * Content extraResources (SKILLs, METAAPPs) copy from the developer's working
 * tree, so git-ignored local scratch dirs (SKILLs/.tmp_*, .cowork-temp, ...)
 * would otherwise ship in the installer: in the 1.0.2/1.0.3 builds that was
 * ~30k files / ~1.2 GB of pure junk, each file extracted by the NSIS installer
 * (and deleted again by the previous version's uninstaller on the next
 * upgrade) under real-time Defender scanning — the multi-minute "installing"
 * stall reported by Windows users. The filter drops every dot-entry and
 * afterPack fails closed if one slips through.
 *
 * No tracked file under SKILLs/ or METAAPPs/ has a dot segment, and the
 * runtimes that need these trees (e.g. the web-search service) spawn
 * node dist/server/index.js directly — node_modules/.bin shims are never
 * used, so excluding dot dirs is safe.
 */
const RESOURCE_DOT_ENTRY_FILTERS = ['!**/.*', '!**/.*/**'];

/**
 * Content extraResources verified afterPack: markers must be present (so a
 * broken filter that drops the tree fails closed), no dot-entries may appear
 * anywhere, and listed node_modules roots must stay free of dead files.
 */
const PACKAGED_CONTENT_RESOURCES = [
  {
    id: 'SKILLs',
    extraResourceTo: 'SKILLs',
    markers: ['skills.config.json'],
    deadFileRoots: [path.join('web-search')],
  },
  {
    id: 'METAAPPs',
    extraResourceTo: 'METAAPPs',
    markers: [],
    deadFileRoots: [],
  },
];

// A negated filter body that drops a node_modules tree wholesale: it ends at
// `node_modules`, optionally followed by a double-star and a trailing `/*`.
// A body that only names a file type inside node_modules does not match.
const NODE_MODULES_TREE_EXCLUSION = /(^|\/)node_modules\/?(\*\*(\/\*)?)?\/?$/;

/** electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4 */
const ELECTRON_BUILDER_ARCH = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

const MIN_FFMPEG_BYTES = 1024 * 1024;

function projectRootFrom(scriptDir = __dirname) {
  return path.resolve(scriptDir, '..');
}

function isPackedBinaryPresent(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile() && stat.size > MIN_FFMPEG_BYTES;
  } catch {
    return false;
  }
}

function resolveArchName(context) {
  const arch = context?.arch;
  if (typeof arch === 'string' && arch) return arch;
  if (Object.prototype.hasOwnProperty.call(ELECTRON_BUILDER_ARCH, arch)) {
    return ELECTRON_BUILDER_ARCH[arch];
  }
  return process.arch;
}

function resolveFfmpegPlatformKey(context) {
  const platform = context?.electronPlatformName;
  const archName = resolveArchName(context);
  if (platform === 'darwin' && (archName === 'arm64' || archName === 'x64')) {
    return `darwin-${archName}`;
  }
  if (platform === 'win32') return 'win32-x64';
  return null;
}

function missingMarkers(runtimeRoot, markers) {
  return markers.filter((rel) => !existsSync(path.join(runtimeRoot, rel)));
}

function verifySourceRuntimes(root = projectRootFrom()) {
  const missing = [];
  for (const runtime of PACKAGED_RUNTIMES) {
    const runtimeRoot = path.join(root, runtime.dir);
    for (const rel of missingMarkers(runtimeRoot, runtime.markers)) {
      missing.push(path.join(runtime.dir, rel).replace(/\\/g, '/'));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      'Release packaging requires nested runtime dependencies before pack: '
      + `${missing.join(', ')}. Run pnpm install in each runtime directory listed in scripts/packagedRuntimes.cjs.`,
    );
  }
}

function resolvePackagedResourcesDir(context) {
  const appOutDir = context.appOutDir;
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    const bundled = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources');
    if (existsSync(bundled)) return bundled;
    const direct = path.join(appOutDir, 'Contents', 'Resources');
    if (existsSync(direct)) return direct;
    return bundled;
  }
  return path.join(appOutDir, 'resources');
}

function isRuntimeDeadFile(fileName) {
  return RUNTIME_DEAD_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

/**
 * Posix-style paths, relative to runtimeRoot, of every dead file under its
 * node_modules. Symlinks are not followed.
 */
function findPackagedRuntimeDeadFiles(runtimeRoot) {
  const nodeModulesRoot = path.join(runtimeRoot, 'node_modules');
  if (!existsSync(nodeModulesRoot)) return [];
  const found = [];
  const pending = [nodeModulesRoot];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativeSegments = path.relative(nodeModulesRoot, full).split(path.sep);
      const isTestFile = relativeSegments
        .slice(0, -1)
        .some((segment) => RUNTIME_TEST_DIRECTORY_NAMES.includes(segment));
      if (isRuntimeDeadFile(entry.name) || isTestFile) {
        found.push(path.relative(runtimeRoot, full).split(path.sep).join('/'));
      }
    }
  }
  return found.sort();
}

function verifyPackagedRuntimes(context) {
  const resourcesDir = resolvePackagedResourcesDir(context);
  const missing = [];
  const deadFiles = [];
  for (const runtime of PACKAGED_RUNTIMES) {
    const runtimeRoot = path.join(resourcesDir, runtime.extraResourceTo);
    for (const rel of missingMarkers(runtimeRoot, runtime.markers)) {
      missing.push(path.join(runtime.extraResourceTo, rel).replace(/\\/g, '/'));
    }
    for (const rel of findPackagedRuntimeDeadFiles(runtimeRoot)) {
      deadFiles.push(`${runtime.extraResourceTo}/${rel}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      'Packaged app is missing nested runtime files under Resources: '
      + `${missing.join(', ')}. extraResources must copy node_modules for each packaged runtime.`,
    );
  }
  if (deadFiles.length > 0) {
    throw new Error(
      `Packaged runtime node_modules still contain ${deadFiles.length} file(s) nothing loads at run time `
      + `(declarations, source maps, or dependency tests), e.g. ${deadFiles.slice(0, 5).join(', ')}. `
      + 'Keep the RUNTIME_DEAD_FILE_FILTERS and RUNTIME_TEST_DIRECTORY_FILTERS exclusions in the dsh-runtime extraResources filter of electron-builder.json.',
    );
  }
}

/**
 * Posix-style paths, relative to root, of every entry (file or directory)
 * whose basename starts with a dot. Dot-directories are recorded without
 * descending into them: one entry already condemns the whole subtree.
 */
function findDotEntries(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('.')) {
        if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
        continue;
      }
      found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return found.sort();
}

function verifyPackagedContentResources(context) {
  const resourcesDir = resolvePackagedResourcesDir(context);
  const missing = [];
  const dotEntries = [];
  const deadFiles = [];
  for (const resource of PACKAGED_CONTENT_RESOURCES) {
    const resourceRoot = path.join(resourcesDir, resource.extraResourceTo);
    if (!existsSync(resourceRoot)) {
      missing.push(`${resource.extraResourceTo}/`);
      continue;
    }
    for (const rel of missingMarkers(resourceRoot, resource.markers)) {
      missing.push(path.join(resource.extraResourceTo, rel).replace(/\\/g, '/'));
    }
    for (const rel of findDotEntries(resourceRoot)) {
      dotEntries.push(`${resource.extraResourceTo}/${rel}`);
    }
    for (const deadRoot of resource.deadFileRoots) {
      const runtimeRoot = path.join(resourceRoot, deadRoot);
      for (const rel of findPackagedRuntimeDeadFiles(runtimeRoot)) {
        deadFiles.push(`${resource.extraResourceTo}/${deadRoot.replace(/\\/g, '/')}/${rel}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      'Packaged app is missing content resource files under Resources: '
      + `${missing.join(', ')}. extraResources must copy each packaged content tree.`,
    );
  }
  if (dotEntries.length > 0) {
    throw new Error(
      `Packaged content resources contain ${dotEntries.length} dot-entr${dotEntries.length === 1 ? 'y' : 'ies'} `
      + `untracked local scratch must never ship (e.g. ${dotEntries.slice(0, 5).join(', ')}). `
      + 'Keep the RESOURCE_DOT_ENTRY_FILTERS exclusions in the SKILLs/METAAPPs extraResources filters of electron-builder.json.',
    );
  }
  if (deadFiles.length > 0) {
    throw new Error(
      `Packaged content resources still contain ${deadFiles.length} file(s) nothing loads at run time `
      + `(${RUNTIME_DEAD_FILE_SUFFIXES.join(', ')}), e.g. ${deadFiles.slice(0, 5).join(', ')}. `
      + 'Keep the RUNTIME_DEAD_FILE_FILTERS exclusions in the SKILLs extraResources filter of electron-builder.json.',
    );
  }
}

function extraResourceFilterExcludesNodeModules(filter) {
  if (!Array.isArray(filter)) return false;
  return filter.some((pattern) => {
    if (typeof pattern !== 'string' || !pattern.startsWith('!')) return false;
    return NODE_MODULES_TREE_EXCLUSION.test(pattern.slice(1).replace(/\\/g, '/'));
  });
}

function ffmpegSourcePath(platformKey, root = projectRootFrom()) {
  const asset = PLATFORM_ASSETS[platformKey];
  if (!asset) return null;
  return path.join(root, 'resources', 'ffmpeg', asset);
}

function ffmpegPackagedRel(platformKey) {
  const asset = PLATFORM_ASSETS[platformKey];
  if (!asset) return null;
  return path.join('ffmpeg', asset);
}

function verifySourceFfmpeg(context, root = projectRootFrom()) {
  const platformKey = resolveFfmpegPlatformKey(context);
  if (!platformKey) return;
  const sourcePath = ffmpegSourcePath(platformKey, root);
  if (!sourcePath || !isPackedBinaryPresent(sourcePath)) {
    throw new Error(
      `Release packaging requires bundled ffmpeg for ${platformKey} `
      + `(${sourcePath || 'unknown path'} is missing or smaller than 1MB). `
      + 'Run node scripts/setup-ffmpeg.js --required before packaging.',
    );
  }
}

function verifyPackagedFfmpeg(context) {
  const platformKey = resolveFfmpegPlatformKey(context);
  if (!platformKey) return;
  const rel = ffmpegPackagedRel(platformKey);
  const packagedPath = path.join(resolvePackagedResourcesDir(context), rel);
  if (!isPackedBinaryPresent(packagedPath)) {
    throw new Error(
      `Packaged app is missing bundled ffmpeg under Resources/${rel.replace(/\\/g, '/')}. `
      + 'CI must run scripts/setup-ffmpeg.js before electron-builder; extraResources skips missing files with only a warning.',
    );
  }
}

module.exports = {
  PACKAGED_RUNTIMES,
  PACKAGED_CONTENT_RESOURCES,
  RUNTIME_DEAD_FILE_SUFFIXES,
  RUNTIME_DEAD_FILE_FILTERS,
  RUNTIME_TEST_DIRECTORY_NAMES,
  RUNTIME_TEST_DIRECTORY_FILTERS,
  RESOURCE_DOT_ENTRY_FILTERS,
  isRuntimeDeadFile,
  findPackagedRuntimeDeadFiles,
  findDotEntries,
  missingMarkers,
  verifySourceRuntimes,
  verifyPackagedRuntimes,
  verifyPackagedContentResources,
  verifySourceFfmpeg,
  verifyPackagedFfmpeg,
  resolvePackagedResourcesDir,
  resolveFfmpegPlatformKey,
  extraResourceFilterExcludesNodeModules,
};
