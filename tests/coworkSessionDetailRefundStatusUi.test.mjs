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

test('CoworkSessionDetail only renders refund status cards for A2A sessions', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(
    source,
    /\{isA2ASession\s*&&\s*currentSession\.serviceOrderSummary\s*&&\s*shouldShowRefundStatusCard\(currentSession\.serviceOrderSummary\)\s*&&\s*\(/
  );
});
