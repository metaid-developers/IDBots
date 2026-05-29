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
  assert.match(prompts.systemPrompt, /Do not stop after saying/i);
  assert.match(prompts.systemPrompt, /run the required skill/i);
});

test('buildOrderPrompts describes multiple order skills as an unordered allow-list scope', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] Summarize the attached report.',
      '<raw_request>',
      'Summarize the attached report.',
      '</raw_request>',
      'allowed skills: report-reader, summarizer',
      `txid: ${'a'.repeat(64)}`,
      'output type: text',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    allowedSkillNames: ['report-reader', 'summarizer'],
  });

  assert.match(prompts.systemPrompt, /Allowed skill scope:\s*report-reader,\s*summarizer\./);
  assert.match(prompts.systemPrompt, /use any suitable subset/i);
  assert.match(prompts.systemPrompt, /no execution-order semantics/i);
  assert.match(prompts.systemPrompt, /Do not use local skills outside this scope/i);
  assert.doesNotMatch(prompts.systemPrompt, /Required skill/i);
  assert.doesNotMatch(prompts.systemPrompt, /MUST use this skill/i);
  assert.doesNotMatch(prompts.systemPrompt, /must use every/i);
});
