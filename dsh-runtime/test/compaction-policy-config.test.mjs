// Per-route compaction policy config: generate-runtime-config emits one
// compaction-basic modelPolicies entry per provider/model route with a
// tiered threshold (90% of the window below 256K, 80% at/above) and a
// window-scaled headroom (4% of the window, clamped to [2K, 64K]). The
// upstream flat 64K headroom is sized for 1M-class windows; on small-window
// routes the pressure budget (window - reservedOutput - headroom) goes
// non-positive and proactive compaction silently disables itself via
// TargetPressureConfigError (the 2026-09-30 space-bunny-free incident). The
// host clamps the output ceiling on matching tiers (coworkModelLimits), so
// the 90% small-window threshold is actually reachable.
//
// Run: node test/compaction-policy-config.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'

const compactionEntry = (config) => config.find((entry) => entry.id === 'compaction-basic')
const sessionRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-policy-'))

// Tiered threshold + scaled headroom: 4% of the window, clamped to [2K, 64K];
// globals unchanged.
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      { key: 'small-gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm-128k', contextWindow: 128000, maxOutputTokens: 40960 }] },
      { key: 'big-gw', apiFormat: 'openai', baseUrl: 'https://b.example/v1', apiKeyEnv: 'K2', models: [{ id: 'm-1m', contextWindow: 1000000, maxOutputTokens: 256000 }] },
    ],
    sections: [],
  })
  const entryConfig = compactionEntry(config).config
  const policies = entryConfig.modelPolicies
  assert.ok(Array.isArray(policies), 'modelPolicies emitted')
  assert.deepEqual(
    policies.find((p) => p.provider === 'small-gw' && p.model === 'm-128k'),
    // Sub-256K window → 90% threshold tier; headroom = 4% of 128K.
    { provider: 'small-gw', model: 'm-128k', thresholdRatio: 0.9, headroomTokens: 5120 },
  )
  assert.deepEqual(
    policies.find((p) => p.provider === 'big-gw' && p.model === 'm-1m'),
    // 1M-class route keeps the 80% upstream threshold; headroom = 4% of 1M.
    { provider: 'big-gw', model: 'm-1m', thresholdRatio: 0.8, headroomTokens: 40000 },
  )
  const { modelPolicies: _ignored, ...globals } = entryConfig
  // maxOverflowRetries 2: the overflow-shrink patch summarizes only the older
  // half of the surface when the summary request itself overflows, so a
  // second recovery round is available when the shrunken request still
  // exceeds a provider cap that sits below the declared window.
  assert.deepEqual(globals, { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192, compactionRetries: 1, maxOverflowRetries: 2 })
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  per-route threshold tiers at 90%/80% (boundary 256K), headroom scales at 4% of the window, clamped to [2K, 64K]')
}

// Native DeepSeek routes key their policy to the fixed deepseek-official id.
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      { key: 'deepseek', native: true, apiFormat: 'openai', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'K1', models: [{ id: 'deepseek-flash', contextWindow: 1000000, maxOutputTokens: 256000 }] },
    ],
    sections: [],
  })
  assert.deepEqual(compactionEntry(config).config.modelPolicies, [
    { provider: 'deepseek-official', model: 'deepseek-flash', thresholdRatio: 0.8, headroomTokens: 40000 },
  ])
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  native routes key their policy to deepseek-official')
}

// Sanitized-key collisions dedupe last-wins (duplicate targets fail plugin load).
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      { key: 'my gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm', contextWindow: 128000 }] },
      { key: 'my-gw', apiFormat: 'openai', baseUrl: 'https://b.example/v1', apiKeyEnv: 'K2', models: [{ id: 'm', contextWindow: 256000 }] },
    ],
    sections: [],
  })
  const policies = compactionEntry(config).config.modelPolicies
  const matches = policies.filter((p) => p.provider === 'my-gw' && p.model === 'm')
  assert.equal(matches.length, 1, 'colliding route keys dedupe to one policy')
  // Last route wins, mirroring the routes dict. 256000 < 262144 → 90% tier.
  assert.deepEqual(matches[0], { provider: 'my-gw', model: 'm', thresholdRatio: 0.9, headroomTokens: 10240 })
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  sanitized-key collisions dedupe last-wins')
}

// No declared window → no policy (the route keeps the global flat headroom).
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      { key: 'nowin', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm' }] },
    ],
    sections: [],
  })
  assert.equal(compactionEntry(config).config.modelPolicies, undefined)
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  models without a context window get no policy entry')
}

// ID.Bots relay (metaid-free / metaso.network) × DeepSeek-family: the relay
// enforces a ~256K real request window under a 1M catalog declaration
// (2026-11-12 cw-4b78a0fd: a 259,414-token request was accepted, the next one
// rejected with CONTEXT_WINDOW_EXCEEDED) — the proactive threshold pins to
// 22% so it fires below the real line, mirroring the Command Code GLM tier.
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      {
        key: 'metaid-free', apiFormat: 'openai',
        baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1', apiKeyEnv: 'K1',
        models: [
          { id: 'deepseek-4.1-flash', contextWindow: 1048576, maxOutputTokens: 256000 },
          { id: 'glm-5.3-flash', contextWindow: 1048576, maxOutputTokens: 131072 },
        ],
      },
      { key: 'deepseek', native: true, apiFormat: 'openai', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'K2', models: [{ id: 'deepseek-flash', contextWindow: 1000000, maxOutputTokens: 256000 }] },
      { key: 'other-relay', apiFormat: 'openai', baseUrl: 'https://metaso.network.evil.example/v1', apiKeyEnv: 'K3', models: [{ id: 'deepseek-4.1-flash', contextWindow: 1000000, maxOutputTokens: 256000 }] },
    ],
    sections: [],
  })
  const policies = compactionEntry(config).config.modelPolicies
  assert.deepEqual(
    policies.find((p) => p.provider === 'metaid-free' && p.model === 'deepseek-4.1-flash'),
    { provider: 'metaid-free', model: 'deepseek-4.1-flash', thresholdRatio: 0.22, headroomTokens: 41943 },
    'relay×DeepSeek pins the 22% threshold',
  )
  assert.equal(
    policies.find((p) => p.provider === 'metaid-free' && p.model === 'glm-5.3-flash').thresholdRatio,
    0.8,
    'relay×GLM keeps the default tier — no such observation on the relay yet',
  )
  assert.equal(
    policies.find((p) => p.provider === 'deepseek-official' && p.model === 'deepseek-flash').thresholdRatio,
    0.8,
    'official DeepSeek keeps the default tier',
  )
  assert.equal(
    policies.find((p) => p.provider === 'other-relay' && p.model === 'deepseek-4.1-flash').thresholdRatio,
    0.8,
    'lookalike hosts do not trigger the scoped tier',
  )
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  ID.Bots relay×DeepSeek pins 22%; GLM/official/lookalike hosts keep the default tier')
}
