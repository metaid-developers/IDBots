import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildMacBuilderEnv, resolvePythonPath } from '../scripts/run-electron-builder-mac.mjs';

test('buildMacBuilderEnv injects a python shim and PYTHON_PATH for local mac packaging', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-mac-builder-'));
  const fakePython3 = path.join(tempRoot, 'python3');
  fs.writeFileSync(fakePython3, '');

  try {
    const result = buildMacBuilderEnv({
      cwd: tempRoot,
      env: { PATH: '/usr/bin:/bin' },
      pythonPath: fakePython3,
    });

    const expectedShimDir = path.join(tempRoot, '.tmp-bin');
    const expectedShimPath = path.join(expectedShimDir, 'python');

    assert.equal(result.pythonPath, fakePython3);
    assert.equal(result.shimDir, expectedShimDir);
    assert.equal(result.env.PYTHON_PATH, fakePython3);
    assert.equal(result.env.PATH, `${expectedShimDir}${path.delimiter}/usr/bin:/bin`);
    assert.equal(fs.readlinkSync(expectedShimPath), fakePython3);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildMacBuilderEnv disables automatic mac signing when no release signing env is configured', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-mac-builder-'));
  const fakePython3 = path.join(tempRoot, 'python3');
  fs.writeFileSync(fakePython3, '');

  try {
    const result = buildMacBuilderEnv({
      cwd: tempRoot,
      env: { PATH: '/usr/bin:/bin' },
      pythonPath: fakePython3,
    });

    assert.equal(result.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolvePythonPath prefers /usr/bin/python3 before shell-discovered python3 shims', () => {
  const result = resolvePythonPath(
    {},
    {
      pathExists: (candidate) => candidate === '/usr/bin/python3',
      resolveCommand: (candidate) => {
        if (candidate === 'python3') {
          return '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3';
        }
        return null;
      },
    },
  );

  assert.equal(result, '/usr/bin/python3');
});
