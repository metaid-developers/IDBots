import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../src/renderer/services/i18n.ts', import.meta.url),
  'utf8',
);

test('execution reminder placeholder uses a neutral instruction instead of concrete examples', () => {
  assert.match(
    source,
    /gigSquarePublishExecutionReminderPlaceholder:\s*'请在这里输入metabot运行该服务前，需要提醒metabot的内容'/,
  );
  assert.doesNotMatch(source, /gigSquarePublishExecutionReminderPlaceholder:\s*'例如：/);
  assert.doesNotMatch(source, /gigSquarePublishExecutionReminderPlaceholder:\s*'e\.g\./);
});
