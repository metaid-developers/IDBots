import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOrderPrompts } from '../src/main/services/orderPromptBuilder';

test('buildOrderPrompts adds media delivery constraints for image outputs', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] 请生成火箭发射图片。',
      '<raw_request>',
      '请生成火箭发射图片。',
      '</raw_request>',
      '支付金额 0.001 SPACE',
      `txid: ${'f'.repeat(64)}`,
      'service id: svc-image',
      'skill name: seedream',
      'output type: image',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    skillName: 'seedream',
    expectedOutputType: 'image',
  });

  assert.match(prompts.systemPrompt, /Expected output type:\s*image/i);
  assert.match(prompts.systemPrompt, /20MB/);
  assert.match(prompts.systemPrompt, /local file path/i);
  assert.match(prompts.systemPrompt, /do not claim success/i);
});
