import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadRuntimePathsWithElectronStub() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getAppPath() {
            return process.cwd();
          },
          getPath() {
            return process.execPath;
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../dist-electron/libs/runtimePaths.js')];
    return require('../dist-electron/libs/runtimePaths.js');
  } finally {
    Module._load = originalLoad;
  }
}

test('resolveMetabotDistModulePath climbs out of a worktree-like directory when sibling .worktrees/metabot lacks dist output', async () => {
  const runtimePaths = loadRuntimePathsWithElectronStub();
  assert.equal(
    typeof runtimePaths.resolveMetabotDistModulePath,
    'function',
    'resolveMetabotDistModulePath() should be exported',
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-runtime-paths-'));
  const repoRoot = path.join(tempRoot, 'IDBots');
  const worktreeRoot = path.join(repoRoot, '.worktrees', 'feature-a');
  const existingMetabotFile = path.join(repoRoot, 'metabot', 'dist', 'core', 'orders', 'orderLifecycle.js');
  fs.mkdirSync(path.dirname(existingMetabotFile), { recursive: true });
  fs.writeFileSync(existingMetabotFile, 'module.exports = {};');
  fs.mkdirSync(path.join(repoRoot, '.worktrees', 'metabot'), { recursive: true });
  fs.mkdirSync(path.join(worktreeRoot, 'dist-electron'), { recursive: true });

  const resolved = runtimePaths.resolveMetabotDistModulePath('core/orders/orderLifecycle.js', {
    startDir: path.join(worktreeRoot, 'dist-electron'),
  });

  assert.equal(resolved, existingMetabotFile);
});
