import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('detects infographic mode from payload and writes a stable output path', () => {
  const { detectMode } = require('../SKILLs/baoyu-image-studio/scripts/lib/promptBuilder.js');
  const { buildOutputPath } = require('../SKILLs/baoyu-image-studio/scripts/lib/outputPaths.js');

  const mode = detectMode({
    mode: 'infographic',
    topic: 'UTXO 解释',
    bullets: ['定义', '流程', '风险'],
  });
  const outputPath = buildOutputPath({
    cwd: '/tmp/demo',
    mode,
    title: 'UTXO 解释',
    extension: '.png',
    now: () => 1700000000000,
  });

  assert.equal(mode, 'infographic');
  assert.match(outputPath, /utxo/i);
  assert.match(outputPath, /\.png$/);
  assert.match(outputPath, /baoyu-image-studio/);
});

test('buildPrompt shapes infographic content with bullets and style hints', () => {
  const { buildPrompt } = require('../SKILLs/baoyu-image-studio/scripts/lib/promptBuilder.js');

  const prompt = buildPrompt({
    mode: 'infographic',
    topic: 'UTXO 是什么',
    bullets: ['定义', '交易流程', '双花风险'],
    style: 'clean',
  });

  assert.match(prompt, /UTXO/);
  assert.match(prompt, /定义/);
  assert.match(prompt, /交易流程/);
  assert.match(prompt, /clean/i);
});

test('providerResolver returns bridge providers before env-only providers', () => {
  const { resolveProviderConfig } = require('../SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js');

  const result = resolveProviderConfig({
    env: {
      BAOYU_IMAGE_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'router-key',
      OPENROUTER_IMAGE_MODEL: 'google/gemini-3.1-flash-image-preview',
      ARK_API_KEY: 'ark-key',
    },
  });

  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'google/gemini-3.1-flash-image-preview');
});

test('falls back to seedream when no bridge provider is configured but ARK_API_KEY exists', () => {
  const { resolveProviderConfig } = require('../SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js');

  const result = resolveProviderConfig({
    env: {
      ARK_API_KEY: 'ark-key',
      SEEDREAM_IMAGE_MODEL: 'doubao-seedream-5-0-260128',
    },
  });

  assert.equal(result.provider, 'seedream');
  assert.equal(result.model, 'doubao-seedream-5-0-260128');
});

test('all supported provider adapters export a generateImage function', () => {
  const { loadProviderAdapter } = require('../SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js');

  for (const providerId of ['openai', 'google', 'openrouter', 'dashscope', 'replicate', 'jimeng', 'seedream']) {
    const adapter = loadProviderAdapter(providerId);
    assert.equal(typeof adapter.generateImage, 'function', `${providerId} adapter should export generateImage`);
  }
});

test('runWithPayload writes a local image file and returns execution summary', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyu-image-studio-test-'));
  const { runWithPayload } = require('../SKILLs/baoyu-image-studio/scripts/index.js');

  const result = await runWithPayload(
    {
      title: 'Orange Space Cat',
      prompt: 'An orange cat floating in space',
      mode: 'cover',
    },
    {
      cwd: tempRoot,
      env: {
        BAOYU_IMAGE_PROVIDER: 'openai',
        OPENAI_API_KEY: 'test-key',
      },
      now: () => 1700000000000,
      adapters: {
        openai: {
          async generateImage() {
            return {
              bytes: Buffer.from('fake-image'),
              extension: '.png',
              mimeType: 'image/png',
            };
          },
        },
      },
    },
  );

  assert.equal(result.mode, 'cover');
  assert.equal(result.provider, 'openai');
  assert.equal(path.extname(result.outputPath), '.png');
  assert.ok(fs.existsSync(result.outputPath));
  assert.equal(fs.readFileSync(result.outputPath, 'utf8'), 'fake-image');
  assert.match(result.message, /orange space cat/i);
});

test('runWithPayload throws an actionable error when no supported provider is available', async () => {
  const { runWithPayload } = require('../SKILLs/baoyu-image-studio/scripts/index.js');

  await assert.rejects(
    () =>
      runWithPayload(
        {
          prompt: 'Generate a cover image about UTXO',
        },
        {
          cwd: '/tmp/demo',
          env: {},
        },
      ),
    /No supported image provider is available/i,
  );
});
