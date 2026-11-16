// Runtime config generator: per-route compaction policy.
//
// The Command Code gateway (api.commandcode.ai) refuses to START GLM relay
// requests far below the model's advertised window (2026-10-27 session
// cw-2c70849f: accepted 623,755 cold / 716,532 warm, rejected ~730K on a
// 1,048,576-declared route), so the tiered 0.8 threshold never fired and every
// turn died with the request 400 plus an identical compaction 400. The
// generator must route that gateway's GLM-family models to a 0.5 threshold —
// and ONLY that gateway's GLM routes: the same session's Zhipu-direct
// `glm-5.3` accepted 798K under the default policy.

import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const worktreeRoot = path.resolve(import.meta.dirname, '..')
const generatorUrl = pathToFileURL(path.join(worktreeRoot, 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href
const { generateRuntimeConfig } = await import(generatorUrl)

const baseInput = (providers) => ({
  sessionRoot: '/tmp/dsh-compaction-policy-test',
  providers,
})

const entryById = (config, id) => config.find((e) => e.id === id)
const compactionPolicyFor = (config, modelId) =>
  entryById(config, 'compaction-basic').config.modelPolicies.find((policy) => policy.model === modelId)

const commandcodeRoute = {
  key: 'commandcode',
  apiFormat: 'openai',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  apiKeyEnv: 'IDBOTS_DSH_API_KEY',
  models: [
    { id: 'z-ai/glm-5.3-flash', contextWindow: 1_048_576 },
    { id: 'zai-org/GLM-5.3', contextWindow: 1_000_000 },
    { id: 'deepseek/deepseek-v4-pro', contextWindow: 1_000_000 },
    { id: 'zai-org/GLM-5', contextWindow: 200_000 },
  ],
}

test('compaction-basic mounts maxOverflowRetries 2 for overflow-shrink recovery rounds', () => {
  const config = generateRuntimeConfig(baseInput([commandcodeRoute]))
  const compaction = entryById(config, 'compaction-basic').config
  assert.equal(compaction.maxOverflowRetries, 2)
  assert.equal(compaction.thresholdRatio, 0.8)
  assert.equal(compaction.retainRatio, 0.16)
})

test('Command Code GLM routes compact at 0.5 of the window', () => {
  const config = generateRuntimeConfig(baseInput([commandcodeRoute]))
  assert.deepEqual(
    { ...compactionPolicyFor(config, 'z-ai/glm-5.3-flash') },
    { provider: 'commandcode', model: 'z-ai/glm-5.3-flash', thresholdRatio: 0.5, headroomTokens: 41_943 },
  )
  assert.deepEqual(
    { ...compactionPolicyFor(config, 'zai-org/GLM-5.3') },
    { provider: 'commandcode', model: 'zai-org/GLM-5.3', thresholdRatio: 0.5, headroomTokens: 40_000 },
  )
})

test('Command Code non-GLM and small-window routes keep the tiered policy', () => {
  const config = generateRuntimeConfig(baseInput([commandcodeRoute]))
  assert.equal(compactionPolicyFor(config, 'deepseek/deepseek-v4-pro').thresholdRatio, 0.8)
  // The small-window tier wins over the gateway policy: no small-window GLM
  // SKU has shown the startable-cap behavior, and 0.5 would halve a 200K
  // model's usable context on a guess.
  assert.equal(compactionPolicyFor(config, 'zai-org/GLM-5').thresholdRatio, 0.9)
})

test('non-Command-Code gateways with the same model ids keep the default policy', () => {
  const config = generateRuntimeConfig(baseInput([
    {
      key: 'zhipu',
      apiFormat: 'responses',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKeyEnv: 'ZHIPU_KEY',
      models: [{ id: 'glm-5.3-flash', contextWindow: 1_048_576 }],
    },
    {
      key: 'mygw',
      apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:48790/v1',
      apiKeyEnv: 'MYGW_KEY',
      models: [{ id: 'z-ai/glm-5.3-flash', contextWindow: 1_048_576 }],
    },
  ]))
  assert.equal(compactionPolicyFor(config, 'glm-5.3-flash').thresholdRatio, 0.8)
  assert.equal(compactionPolicyFor(config, 'z-ai/glm-5.3-flash').thresholdRatio, 0.8)
})

test('a custom provider key riding the Command Code host is detected by baseUrl', () => {
  const config = generateRuntimeConfig(baseInput([
    {
      key: 'mycc',
      apiFormat: 'openai',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      apiKeyEnv: 'MYCC_KEY',
      models: [{ id: 'zai-org/GLM-5.3', contextWindow: 1_000_000 }],
    },
  ]))
  const policy = compactionPolicyFor(config, 'zai-org/GLM-5.3')
  assert.equal(policy.provider, 'mycc')
  assert.equal(policy.thresholdRatio, 0.5)
})

test('ID.Bots relay DeepSeek routes pair thresholdRatio 0.22 with scaled retainRatio 0.04 so system+tools+tail never deadlocks threshold', () => {
  const config = generateRuntimeConfig(baseInput([
    {
      key: 'idbots',
      apiFormat: 'openai',
      baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1',
      apiKeyEnv: 'IDBOTS_KEY',
      models: [
        { id: 'deepseek-4.1-flash', contextWindow: 1_000_000 },
        { id: 'glm-5.3-flash', contextWindow: 1_048_576 },
      ],
    },
  ]))
  const dsPolicy = compactionPolicyFor(config, 'deepseek-4.1-flash')
  assert.equal(dsPolicy.thresholdRatio, 0.22)
  assert.equal(dsPolicy.retainRatio, 0.04)
  const glmPolicy = compactionPolicyFor(config, 'glm-5.3-flash')
  assert.equal(glmPolicy.thresholdRatio, 0.8)
  assert.equal(glmPolicy.retainRatio, undefined)
})
