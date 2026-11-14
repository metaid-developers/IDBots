import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const detailSource = fs
  .readFileSync(path.join(repoRoot, 'src/renderer/components/cowork/CoworkSessionDetail.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

test('CoworkSessionDetail stops unconditional 3s idle git branch polling and polls only while session is running', () => {
  assert.doesNotMatch(detailSource, /window\.setInterval\(poll,\s*3000\)/);
  assert.match(detailSource, /const GIT_BRANCH_STREAMING_POLL_MS = 15_000;/);
  assert.match(detailSource, /if \(!sessionActivelyRunning\) return;/);
});

test('CoworkSessionDetail applies content-visibility: auto to historical turns and disables it during search or image export', () => {
  assert.match(detailSource, /contentVisibility:\s*'auto'/);
  assert.match(
    detailSource,
    /const allowOffscreenSkip = !isConversationSearchOpen && !isExportingImage && index < turns\.length - 4;/,
  );
});
