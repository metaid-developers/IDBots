'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readPackageVersion({ cwd = process.cwd() } = {}) {
  const packageJsonPath = path.join(cwd, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = String(packageJson.version || '').trim();

  if (!version) {
    throw new Error(`package.json at ${packageJsonPath} is missing a version`);
  }

  return version;
}

function computeMacAppZipPath({
  releaseDir = 'release',
  productName = 'IDBots',
  version,
  arch = 'arm64',
}) {
  const normalizedVersion = String(version || '').trim();
  if (!normalizedVersion) {
    throw new Error('version is required to compute the mac app zip path');
  }

  return path.join(releaseDir, `${productName}-${normalizedVersion}-${arch}.app.zip`);
}

function resolveMacDmgPath({
  releaseDir = 'release',
  productName = 'IDBots',
  version,
  arch = 'arm64',
}) {
  const normalizedVersion = String(version || '').trim();
  if (!normalizedVersion) {
    throw new Error('version is required to resolve the mac DMG path');
  }

  const exactMatchPath = path.join(releaseDir, `${productName}-${normalizedVersion}-${arch}.dmg`);
  if (fs.existsSync(exactMatchPath)) {
    return exactMatchPath;
  }

  const matches = fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.startsWith(`${productName}-`) &&
        name.endsWith(`-${arch}.dmg`),
    );

  if (matches.length === 1) {
    return path.join(releaseDir, matches[0]);
  }

  if (matches.length === 0) {
    throw new Error(
      `No mac DMG found in ${releaseDir} for ${productName} ${normalizedVersion} ${arch}`,
    );
  }

  throw new Error(
    `Multiple mac DMGs found in ${releaseDir}: ${matches.sort().join(', ')}`,
  );
}

function resolveCliOptions() {
  return {
    releaseDir: process.env.RELEASE_DIR || 'release',
    productName: process.env.PRODUCT_NAME || 'IDBots',
    version: process.env.APP_VERSION || readPackageVersion(),
    arch: process.env.APP_ARCH || 'arm64',
  };
}

if (require.main === module) {
  const command = String(process.argv[2] || '').trim().toLowerCase();
  const options = resolveCliOptions();

  if (command === 'zip') {
    process.stdout.write(`${computeMacAppZipPath(options)}\n`);
  } else if (command === 'dmg') {
    process.stdout.write(`${resolveMacDmgPath(options)}\n`);
  } else {
    process.stderr.write('Usage: node scripts/release-artifact-paths.cjs <zip|dmg>\n');
    process.exitCode = 1;
  }
}

module.exports = {
  computeMacAppZipPath,
  readPackageVersion,
  resolveMacDmgPath,
};
