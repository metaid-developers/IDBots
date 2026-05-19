import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getElectronDevBuildStatus } from '../scripts/wait-electron-dev-build.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-electron-build-'));

test('electron dev build status waits for the hashed main bundle to parse', () => {
  const distDir = makeTempDir();
  fs.writeFileSync(path.join(distDir, 'main.js'), '"use strict";\nrequire("./main-test.js");\n');
  fs.writeFileSync(path.join(distDir, 'preload.js'), '"use strict";\n');
  fs.writeFileSync(path.join(distDir, 'main-test.js'), '"use strict";\nfunction broken() {\n');

  const partial = getElectronDevBuildStatus(distDir);
  assert.equal(partial.ready, false);
  assert.match(partial.reason, /not parseable/);

  fs.writeFileSync(path.join(distDir, 'main-test.js'), '"use strict";\nfunction complete() { return 1; }\n');
  const complete = getElectronDevBuildStatus(distDir);
  assert.equal(complete.ready, true);
});
