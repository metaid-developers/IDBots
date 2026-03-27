import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeMacAppZipPath,
  resolveMacDmgPath,
} from '../scripts/release-artifact-paths.cjs';

test('computeMacAppZipPath uses the package version for mac notarization zip names', () => {
  assert.equal(
    computeMacAppZipPath({
      releaseDir: 'release',
      productName: 'IDBots',
      version: '0.1.98',
      arch: 'arm64',
    }),
    path.join('release', 'IDBots-0.1.98-arm64.app.zip'),
  );
});

test('resolveMacDmgPath returns the versioned electron-builder output when present', () => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-release-'));
  const expected = path.join(releaseDir, 'IDBots-0.1.98-arm64.dmg');
  fs.writeFileSync(expected, '');

  try {
    assert.equal(
      resolveMacDmgPath({
        releaseDir,
        productName: 'IDBots',
        version: '0.1.98',
        arch: 'arm64',
      }),
      expected,
    );
  } finally {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
});

test('resolveMacDmgPath falls back to the only matching DMG when the exact versioned file is absent', () => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-release-'));
  const expected = path.join(releaseDir, 'IDBots-nightly-arm64.dmg');
  fs.writeFileSync(expected, '');

  try {
    assert.equal(
      resolveMacDmgPath({
        releaseDir,
        productName: 'IDBots',
        version: '0.1.98',
        arch: 'arm64',
      }),
      expected,
    );
  } finally {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
});
