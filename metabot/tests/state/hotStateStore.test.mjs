import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createHotStateStore } = require('../../dist/core/state/hotStateStore.js');

test('createHotStateStore round-trips secrets in hot storage only', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'metabot-hot-'));
  const store = createHotStateStore(homeDir);

  const writtenPath = await store.writeSecrets({
    mnemonic: 'secret phrase',
    token: 'secret-token'
  });

  assert.equal(writtenPath, store.paths.secretsPath);
  assert.deepEqual(await store.readSecrets(), {
    mnemonic: 'secret phrase',
    token: 'secret-token'
  });
  assert.match(readFileSync(store.paths.secretsPath, 'utf8'), /secret-token/);
  assert.equal(store.paths.secretsPath.startsWith(store.paths.hotRoot), true);
  assert.equal(store.paths.secretsPath.startsWith(store.paths.exportRoot), false);
});

test('createHotStateStore deleteSecrets removes the hot secrets source of truth', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'metabot-hot-delete-'));
  const store = createHotStateStore(homeDir);

  await store.writeSecrets({ mnemonic: 'secret phrase' });
  await store.deleteSecrets();

  assert.equal(await store.readSecrets(), null);
});
