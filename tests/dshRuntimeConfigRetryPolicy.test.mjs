// Runtime config generator: the shared outage retry policy must cover
// STREAM_CLOSED.
//
// The kernel's DEFAULT retryableCodes (EMPTY_RESPONSE/RATE_LIMIT/SERVER/
// TIMEOUT/TRANSPORT) does not include STREAM_CLOSED — a stream that ends
// before message_stop, i.e. the provider (or an intermediate gateway) closing
// the SSE connection mid-flight. Omitting retryableCodes from the host's
// TRANSIENT_OUTAGE_RETRY_POLICY therefore selected the kernel default, and a
// turn that rode "Service is too busy" retries through steps 3–5 died on the
// one request that got through with `DeepSeek Messages stream ended before
// message_stop` (STREAM_CLOSED, 2026-11-03 session cw-68650d7b): no in-
// attempt retry, turn settled as failed, owner's question unanswered.
//
// Both route families share the policy object: the native DeepSeek adapter
// entry (dsh-llm-deepseek-api-key) and every pi-ai route.

import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const worktreeRoot = path.resolve(import.meta.dirname, '..')
const generatorUrl = pathToFileURL(path.join(worktreeRoot, 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href
const { generateRuntimeConfig } = await import(generatorUrl)

const nativeDeepSeekProvider = {
  key: 'deepseek-official',
  native: true,
  apiFormat: 'openai',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'IDBOTS_DSH_API_KEY',
  models: [{ id: 'deepseek-chat', contextWindow: 131_072 }],
}

const piAiProvider = {
  key: 'commandcode',
  apiFormat: 'openai',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  apiKeyEnv: 'IDBOTS_DSH_API_KEY',
  models: [{ id: 'z-ai/glm-5.3-flash', contextWindow: 1_048_576 }],
}

const baseInput = (providers) => ({
  sessionRoot: '/tmp/dsh-retry-policy-test',
  providers,
})

test('native DeepSeek entry carries STREAM_CLOSED in its retryableCodes', () => {
  const config = generateRuntimeConfig(baseInput([nativeDeepSeekProvider]))
  const entry = config.find((e) => e.id.startsWith('llm-deepseek-'))
  assert.ok(entry, `native deepseek entry mounted: ${config.map((e) => e.id).join(', ')}`)
  const policy = entry.config?.retryPolicy
  assert.ok(policy, 'the entry carries the host retry policy override')
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 8, 'the outage ladder stays at 8 retries')
  assert.ok(Array.isArray(policy.retryableCodes), 'retryableCodes is explicit (kernel default omits STREAM_CLOSED)')
  assert.ok(policy.retryableCodes.includes('STREAM_CLOSED'), `STREAM_CLOSED must be retryable: ${JSON.stringify(policy.retryableCodes)}`)
  // The kernel defaults stay covered — this must not become a STREAM_CLOSED-only policy.
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.ok(policy.retryableCodes.includes(code), `${code} stays retryable`)
  }
})

test('pi-ai routes carry STREAM_CLOSED in their retryableCodes too', () => {
  const config = generateRuntimeConfig(baseInput([piAiProvider]))
  const entry = config.find((e) => e.id === 'llm-pi-ai')
  assert.ok(entry, 'the pi-ai LLM entry is mounted')
  const route = entry.config?.providers?.commandcode
  assert.ok(route, `pi-ai route mounted: ${Object.keys(entry.config?.providers ?? {}).join(', ')}`)
  const policy = route.retryPolicy
  assert.ok(policy, 'the route carries the host retry policy override')
  assert.ok(policy.retryableCodes.includes('STREAM_CLOSED'), `STREAM_CLOSED must be retryable: ${JSON.stringify(policy.retryableCodes)}`)
})
