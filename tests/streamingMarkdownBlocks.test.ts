import test from 'node:test';
import assert from 'node:assert/strict';
import { splitStreamingMarkdownBlocks } from '../src/renderer/components/streamingMarkdownSplit';

test('splitStreamingMarkdownBlocks keeps short text unsplit and freezes settled paragraphs/code blocks while protecting open fences', () => {
  const short = 'Hello world\n\nSecond paragraph';
  assert.deepEqual(splitStreamingMarkdownBlocks(short), {
    settledBlocks: [],
    activeTail: short,
  });

  const block1 = '## Section 1\n' + 'Explanation line with details about architecture and SQLite WAL mode.\n'.repeat(5);
  const block2 = '```ts\nfunction compute(x: number) {\n  // blank line inside fence must NOT split!\n\n  return x * 2;\n}\n```';
  const openFenceTail = '### Live Code\n```python\ndef run():\n\n    print("still streaming")';
  const combined = `${block1}\n\n${block2}\n\n${openFenceTail}`;

  const split = splitStreamingMarkdownBlocks(combined);
  assert.equal(split.settledBlocks.length, 2);
  assert.ok(split.settledBlocks[0].startsWith('## Section 1'));
  assert.ok(split.settledBlocks[1].includes('return x * 2;'));
  assert.equal(split.activeTail, openFenceTail);

  // Appending more tokens to the open fence leaves settledBlocks referentially identical in content!
  const nextSplit = splitStreamingMarkdownBlocks(`${combined}\n    return 42`);
  assert.deepEqual(nextSplit.settledBlocks, split.settledBlocks);
  assert.ok(nextSplit.activeTail.endsWith('return 42'));
});
