import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createExportStore } = require('../../dist/core/state/exportStore.js');

test('createExportStore writes inspectable json and markdown exports under exportRoot', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'metabot-export-'));
  const store = createExportStore(homeDir);

  const jsonPath = await store.writeJson('identity snapshot', {
    publicKey: '123',
    notes: ['inspectable']
  });
  const markdownPath = await store.writeMarkdown('session notes', '# Hello');

  assert.equal(jsonPath, path.join(store.paths.exportRoot, 'identity-snapshot.json'));
  assert.equal(markdownPath, path.join(store.paths.exportRoot, 'session-notes.md'));
  assert.deepEqual(JSON.parse(readFileSync(jsonPath, 'utf8')), {
    publicKey: '123',
    notes: ['inspectable']
  });
  assert.equal(readFileSync(markdownPath, 'utf8'), '# Hello\n');
});
