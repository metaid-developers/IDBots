import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'cowork',
  'CoworkSessionDetail.tsx'
);

test('CoworkSessionDetail renders an end-conversation button for private A2A sessions', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /a2aSessionEndConversation/);
  assert.match(source, /handleEndA2APrivateChat/);
  assert.match(source, /coworkService\.endA2APrivateChat\(currentSession\.id\)/);
});
