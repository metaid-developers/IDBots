// Runtime config generator: official DeepSeek rides the first-party
// dsh-llm-deepseek adapter.
//
// The native adapter owns the 'deepseek-official' route (chat-completions wire,
// off/low/high/max effort ladder, reasoning in the dedicated reasoning_content
// channel). A route marked `native` must mount a dedicated llm-deepseek plugin
// entry and never enter the llm-pi-ai providers dict; every other provider
// keeps riding pi-ai unchanged.

import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const worktreeRoot = path.resolve(import.meta.dirname, '..')
const generatorUrl = pathToFileURL(path.join(worktreeRoot, 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href
const { generateRuntimeConfig } = await import(generatorUrl)

const baseInput = (providers) => ({
  sessionRoot: '/tmp/dsh-native-test',
  providers,
})

const nativeDeepSeekRoute = {
  key: 'deepseek-official',
  apiFormat: 'responses',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'IDBOTS_DSH_API_KEY',
  native: true,
  models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 16_000 }],
}

const entryById = (config, id) => config.find((e) => e.id === id)
const piAiProviders = (config) => entryById(config, 'llm-pi-ai').config.providers

test('native deepseek mounts a dedicated llm-deepseek entry, not a pi-ai route', () => {
  const config = generateRuntimeConfig(baseInput([
    nativeDeepSeekRoute,
    { key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48790/v1', apiKeyEnv: 'K', models: [{ id: 'mock-1', contextWindow: 32_768 }] },
  ]))

  const native = entryById(config, 'llm-deepseek-deepseek-official')
  assert.ok(native, 'native plugin entry present')
  assert.equal(native.name, '@deepseek-ai/dsh-llm-deepseek-api-key')
  assert.equal(native.config.apiKeyEnv, 'IDBOTS_DSH_API_KEY')
  assert.equal(native.config.baseURL, 'https://api.deepseek.com/anthropic')
  assert.equal(native.config.thinking, 'enabled')
  assert.equal(native.config.reasoningEffort, 'high')
  assert.equal(native.config.defaultContextWindow, 1_000_000)
  assert.deepEqual(native.config.models, [
    { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 16_000, systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' },
  ])
  // Never a pi-ai route for the native provider; other providers unaffected.
  assert.equal(piAiProviders(config).deepseek, undefined)
  assert.ok(piAiProviders(config).mockgw)
})

test('native baseURL normalization collapses compat-suffix bases onto the Messages root', () => {
  for (const baseUrl of [
    'https://api.deepseek.com',
    'https://api.deepseek.com/',
    'https://api.deepseek.com/responses',
    'https://api.deepseek.com/anthropic',
    'https://api.deepseek.com/anthropic/v1',
    'https://api.deepseek.com/v1',
  ]) {
    const config = generateRuntimeConfig(baseInput([{ ...nativeDeepSeekRoute, baseUrl }]))
    const native = entryById(config, 'llm-deepseek-deepseek-official')
    assert.equal(native.config.baseURL, 'https://api.deepseek.com/anthropic', `base ${baseUrl}`)
  }
})

test('model entries without maxOutputTokens fall back to the default ceiling', () => {
  const config = generateRuntimeConfig(baseInput([{
    ...nativeDeepSeekRoute,
    models: [{ id: 'deepseek-v4-flash', contextWindow: 1_000_000 }],
  }]))
  const native = entryById(config, 'llm-deepseek-deepseek-official')
  // 256K, not the old 32K: d80f0ad5 raised the DeepSeek V4 output ceiling to
  // match upstream deepseek-harness (NATIVE_DEEPSEEK_DEFAULT_MAX_TOKENS in
  // dsh-runtime/lib/generate-runtime-config.mjs) and migrated existing 32K
  // provider rows at startup (services/deepseekOutputCeilingMigration).
  assert.equal(native.config.models[0].maxTokens, 256_000)
})

test('native vision catalog emits inputModalities and request-image budgets', () => {
  const config = generateRuntimeConfig(baseInput([{
    ...nativeDeepSeekRoute,
    models: [
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxOutputTokens: 32_768 },
      {
        id: 'deepseek-v4-flash-vision-exp',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        input: ['text', 'image'],
      },
    ],
  }]))
  const native = entryById(config, 'llm-deepseek-deepseek-official')
  assert.equal(native.config.models[0].inputModalities, undefined)
  assert.deepEqual(native.config.models[1], {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'deepseek-v4-flash-vision-exp',
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    systemPromptUpdate: 'in-history',
    toolUpdate: 'addition-only',
    inputModalities: ['text', 'image'],
    imagePixelBudget: 640_000,
    imageMaxBytes: 1_048_576,
  })
  assert.equal(
    config.some((e) => e.name === '@deepseek-ai/dsh-authorization'),
    false,
  )
})

test('non-native routes mount nothing native', () => {
  const config = generateRuntimeConfig(baseInput([
    { key: 'mockgw', apiFormat: 'responses', baseUrl: 'http://127.0.0.1:48790/v1', apiKeyEnv: 'K', models: [{ id: 'mock-1', contextWindow: 32_768 }] },
  ]))
  assert.equal(config.filter((e) => e.name === '@deepseek-ai/dsh-llm-deepseek-api-key').length, 0)
  assert.ok(piAiProviders(config).mockgw)
})

// Outage-tuned retry policy (2026-09-02 incident, session a27be8fa: a ~45–60s
// Wi-Fi roam exhausted the adapter default — 5 retries, 500ms→10s backoff
// ≈ 46s total — and killed the turn mid-task). Every route must now carry the
// widened ladder so transient machine-level network blips are ridden out
// inside the step instead of failing the turn.
test('every route carries the outage-tuned retry policy', () => {
  const expectedPolicy = {
    mode: 'normal',
    maxRetries: 8,
    // Explicit retryableCodes: the kernel default omits STREAM_CLOSED, so a
    // mid-stream truncation (provider closed the SSE connection before
    // message_stop; 2026-11-03 session cw-68650d7b) used to skip the ladder
    // and kill the whole turn.
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED'],
    backoff: { initialDelayMs: 1_000, maxDelayMs: 30_000 },
  }
  const config = generateRuntimeConfig(baseInput([
    nativeDeepSeekRoute,
    { key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48790/v1', apiKeyEnv: 'K', models: [{ id: 'mock-1', contextWindow: 32_768 }] },
  ]))
  const native = entryById(config, 'llm-deepseek-deepseek-official')
  assert.deepEqual(native.config.retryPolicy, expectedPolicy, 'native route')
  assert.deepEqual(piAiProviders(config).mockgw.retryPolicy, expectedPolicy, 'pi-ai route')
})

// Reasoning capability declarations ride the model family, not the provider
// (see dshModelReasoning.ts): a catalog-unknown gateway serving deepseek-v4
// must reach dsh-llm-pi-ai with reasoningEfforts + compat verbatim, or the
// model materializes reasoning:false and the effort selector's "off" sends
// nothing upstream (thinking stays on at the gateway default).
test('model reasoning declarations pass through to the pi-ai route verbatim', () => {
  const config = generateRuntimeConfig(baseInput([
    {
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48790/v1', apiKeyEnv: 'K',
      models: [{
        id: 'deepseek/deepseek-v4-flash',
        contextWindow: 1_000_000,
        reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
        compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
      }],
    },
  ]))
  const route = piAiProviders(config).mockgw
  assert.deepEqual(route.models[0].reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(route.models[0].compat, { thinkingFormat: 'deepseek', supportsReasoningEffort: true })
})

test('models without a reasoning declaration emit no reasoning fields', () => {
  const config = generateRuntimeConfig(baseInput([
    { key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48790/v1', apiKeyEnv: 'K', models: [{ id: 'mock-1', contextWindow: 32_768 }] },
  ]))
  const route = piAiProviders(config).mockgw
  assert.equal(route.models[0].reasoningEfforts, undefined)
  assert.equal(route.models[0].compat, undefined)
})
