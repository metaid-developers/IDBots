import test from 'node:test';
import assert from 'node:assert/strict';
import { packPermissionColumns } from '../src/renderer/components/cowork/permissionPromptLayout';
import { timeoutDefaultForToolApproval } from '../src/main/libs/permissionTimeoutDefault';

test('permission cards fill the right column top to bottom, then open a column to the left', () => {
  const entries = ['a', 'b', 'c'].map((requestId) => ({ requestId }));
  const heights = new Map([
    ['a', 100],
    ['b', 100],
    ['c', 100],
  ]);

  const columns = packPermissionColumns(entries, heights, 250, 12, 160);

  assert.deepEqual(columns.map((column) => column.map((entry) => entry.requestId)), [
    ['a', 'b'],
    ['c'],
  ]);
});

test('a single card taller than the viewport still gets its own column', () => {
  const columns = packPermissionColumns([{ requestId: 'tall' }], new Map([['tall', 800]]), 200, 12, 160);
  assert.equal(columns.length, 1);
  assert.equal(columns[0]?.[0]?.requestId, 'tall');
});

test('every unanswered tool approval resolves deny after the window (fail-closed)', () => {
  assert.equal(timeoutDefaultForToolApproval('Bash needs approval'), 'deny');
  assert.equal(timeoutDefaultForToolApproval(''), 'deny');
  assert.equal(timeoutDefaultForToolApproval(null), 'deny');
  assert.equal(timeoutDefaultForToolApproval('工具 "bash" 将启动外部 Agent CLI "cursor-agent"。'), 'deny');
  assert.equal(timeoutDefaultForToolApproval('Tool "bash" will delete files. Safety policy requires a human confirmation.'), 'deny');
});
