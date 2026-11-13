import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  browserUriMatchesPrefix,
  browserUrisMatch,
  canonicalBrowserUri,
} from '../src/main/shared/browserUriMatch';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('BotBrowserCoworkPanel reads live session model/effort and persists changes via setSessionModel', () => {
  const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');

  // Live session display reads persisted session model before falling back to bot brain.
  assert.match(panelSource, /currentSession\.model \?\? null/);
  assert.match(panelSource, /currentSession\.modelProvider \?\? null/);
  assert.match(panelSource, /currentSession\.effort/);

  // Live session changes persist through cowork:session:setModel and update Redux slice.
  assert.match(panelSource, /window\.electron\?\.cowork\?\.setSessionModel\?\.\(/);
  assert.match(panelSource, /dispatch\(updateBrowserSessionModel\(/);

  // Draft picker persists across restarts in localStorage and clears once a session starts.
  assert.match(panelSource, /PENDING_MODEL_EFFORT_STORAGE_KEY = 'idbots\.botBrowser\.pendingModelEffort'/);
  assert.match(panelSource, /loadPersistedPendingModelEffort/);
  assert.match(panelSource, /savePersistedPendingModelEffort\(/);
});

test('browserUriMatch equates percent-encoded host paths and ABC-decoded tab URIs', () => {
  const encoded = 'preview-metaapp://localhost/Users/tusm/Library/Application%20Support/IDBots/live-stage/official-123/stage.html';
  const decoded = 'preview-metaapp://localhost/Users/tusm/Library/Application Support/IDBots/live-stage/official-123/stage.html';

  assert.equal(canonicalBrowserUri(encoded), canonicalBrowserUri(decoded));
  assert.equal(browserUrisMatch(encoded, decoded), true);
  assert.equal(browserUriMatchesPrefix(`${decoded}?v=1`, encoded), true);
  assert.equal(browserUrisMatch('metaapp://abc123', 'METAAPP://ABC123'), true);
  assert.equal(browserUrisMatch('metaapp://abc123', 'metaapp://xyz789'), false);
});
