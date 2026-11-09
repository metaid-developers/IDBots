// Regression test for the dsh-compaction-basic kernel patch
// (scripts/dsh-kernel-patches/@deepseek-ai+dsh-compaction-basic+0.2.2-rc.1.patch).
//
// Upstream's context-overflow recovery summarizes the WHOLE surface (minus the
// last node) on the same provider/model that just rejected the request — and
// summarizeWithLlm replays that region as the summary request's prefix, so a
// provider whose real prompt cap sits below the declared contextWindow (the
// 2026-10-27 Command Code GLM incident, session cw-2c70849f: accepted
// 623,755 cold / 716,532 warm, rejected ~730K, declared 1,048,576) rejects the
// recovery the same way and every turn dies with the original 400.
//
// The patch adds a shrink ladder to the "context-overflow" branch of
// compactIfNeeded: when the summarization itself fails with a context-window
// overflow, keep the newer half of the region as retained tail and summarize
// only the older half, down the ladder until a summary fits (up to four rungs);
// non-overflow errors, cancellation and an unshrinkable single-node region
// rethrow immediately, preserving the original request error.
//
// These tests drive the real installed engine (the patched lib/index.js) with
// a stubbed compactRegion so the overflow classification and the ladder
// arithmetic run for real. Requires dsh-runtime/node_modules; skips cleanly
// when they are absent. Fails loudly when the node_modules exist but the
// patch is missing.

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const runtimeDir = path.resolve(import.meta.dirname, '..', 'dsh-runtime')
const compactionBasicLib = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'package.json'))

if (!runtimeReady) {
  test('dsh-compaction-basic present for the overflow-shrink patch test', { skip: 'dsh-runtime/node_modules not installed' }, () => {})
} else {
  const patchInstalled = fs.readFileSync(compactionBasicLib, 'utf8').includes('IDBots patch (overflow-shrink)')
  if (!patchInstalled) {
    // A clean install without the postinstall patch pass must not silently
    // pass this suite — the apply gate and CI fingerprints catch it too.
    test('overflow-shrink patch is applied to dsh-compaction-basic', () => {
      assert.fail('dsh-compaction-basic is installed but the overflow-shrink patch is missing — run `node scripts/apply-dsh-kernel-patches.cjs`')
    })
  } else {
    const { BasicCompactionEngine, overflowShrinkRetainTokens, isOverflowSummaryError } = await import(compactionBasicLib)
    const { LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } = await import(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))

    const GATEWAY_400 = '400: {"message":"{\\"error\\":{\\"message\\":\\"The prompt exceeds the context window this endpoint can start from. Compact the conversation and retry.\\",\\"type\\":\\"invalid_request_error\\",\\"param\\":\\"messages\\",\\"code\\":\\"context_length_exceeded\\"}}","type":"invalid_request_error"}'

    const makeCtx = (nodes, totalTokens) => {
      const warnings = []
      const ctx = {
        reflect: { provide() {} },
        on() {},
        logger: { info() {}, warn(message) { warnings.push(String(message)) } },
        tokenMeter: {
          measure: () => ({ nodes, totalTokens }),
          estimateMessage: () => 0,
        },
        get: () => undefined,
      }
      return { ctx, warnings }
    }

    const makeAgent = (seqs) => ({
      options: {},
      session: {
        seq: seqs.length + 1,
        requestHeader: () => ({ config: { provider: 'commandcode', model: 'z-ai/glm-5.3-flash' } }),
        surface: { nodes: [...seqs], replaceGeneration: 1 },
        // Plain message events keep every cut tool-pairing balanced.
        eventAt: (seq) => ({ seq, type: 'user/message', data: {} }),
        append: () => ({ seq: -1, data: {} }),
      },
    })

    /** One stubbed summarization: regions priced over `cap` overflow exactly
     *  like the Command Code gateway 400, others succeed. */
    const makeEngine = (nodes, cap) => {
      const tokensBySeq = new Map(nodes.map((node) => [node.seq, node.tokens]))
      const attempts = []
      class TestEngine extends BasicCompactionEngine {
        async compactRegion(start, end) {
          attempts.push([start, end])
          const startIdx = nodes.findIndex((node) => node.seq === start)
          const endIdx = nodes.findIndex((node) => node.seq === end)
          let regionTokens = 0
          for (let index = startIdx; index <= endIdx; index += 1) regionTokens += nodes[index].tokens
          if (regionTokens > cap) throw new LlmError(GATEWAY_400, CONTEXT_WINDOW_EXCEEDED_CODE)
          return {
            compactionId: 'test',
            shadowedRange: { start, end },
            shadowedSeqs: nodes.slice(startIdx, endIdx + 1).map((node) => node.seq),
            shadowedTokenCount: regionTokens,
            summary: [],
            startSeq: 1,
            summarySeq: 2,
            endSeq: 3,
          }
        }
      }
      const seqs = nodes.map((node) => node.seq)
      const { ctx, warnings } = makeCtx(nodes, nodes.reduce((total, node) => total + node.tokens, 0))
      const engine = new TestEngine(ctx, { auto: false })
      return { engine, attempts, warnings, agent: makeAgent(seqs) }
    }

    const nodesOf = (count, tokensEach, startSeq = 100) =>
      Array.from({ length: count }, (_, index) => ({ seq: startSeq + index, tokens: tokensEach, heuristicTokens: tokensEach }))

    test('context-overflow recovery halves the region when the summary request itself overflows', async () => {
      const { engine, attempts, warnings, agent } = makeEngine(nodesOf(8, 100_000), 250_000)
      const result = await engine.compactIfNeeded(agent, 'context-overflow')
      // 700K region overflows; the ladder runs 300K → 100K and succeeds.
      // (selectCompactableRange always excludes the newest surface node.)
      assert.deepEqual(attempts, [[100, 106], [100, 102], [100, 100]])
      assert.equal(result.shadowedRange.start, 100)
      assert.equal(result.shadowedRange.end, 100)
      assert.equal(result.shadowedTokenCount, 100_000)
      assert.ok(warnings.some((message) => message.includes('retrying on the older half of the region')), warnings.join('\n'))
    })

    test('a single shrink rung suffices when the overflow is marginal', async () => {
      const { engine, attempts, agent } = makeEngine(nodesOf(8, 100_000), 500_000)
      const result = await engine.compactIfNeeded(agent, 'context-overflow')
      assert.deepEqual(attempts, [[100, 106], [100, 102]])
      assert.equal(result.shadowedTokenCount, 300_000)
    })

    test('non-overflow summarization errors rethrow immediately', async () => {
      const nodes = nodesOf(4, 10_000)
      const attempts = []
      class TestEngine extends BasicCompactionEngine {
        async compactRegion(start, end) {
          attempts.push([start, end])
          throw new Error('summary unavailable')
        }
      }
      const seqs = nodes.map((node) => node.seq)
      const { ctx } = makeCtx(nodes, 40_000)
      const engine = new TestEngine(ctx, { auto: false })
      await assert.rejects(
        () => engine.compactIfNeeded(makeAgent(seqs), 'context-overflow'),
        /summary unavailable/,
      )
      assert.equal(attempts.length, 1)
    })

    test('an aborted signal rethrows after the first overflow', async () => {
      const nodes = nodesOf(8, 100_000)
      const attempts = []
      class TestEngine extends BasicCompactionEngine {
        async compactRegion(start, end) {
          attempts.push([start, end])
          throw new LlmError(GATEWAY_400, CONTEXT_WINDOW_EXCEEDED_CODE)
        }
      }
      const seqs = nodes.map((node) => node.seq)
      const { ctx } = makeCtx(nodes, 800_000)
      const engine = new TestEngine(ctx, { auto: false })
      await assert.rejects(
        () => engine.compactIfNeeded(makeAgent(seqs), 'context-overflow', AbortSignal.abort()),
        (error) => error.code === CONTEXT_WINDOW_EXCEEDED_CODE,
      )
      assert.equal(attempts.length, 1)
    })

    test('an unshrinkable single-node region is skipped, not attempted', async () => {
      // Upstream's selectCompactableRange always excludes the last surface
      // node, so a one-node surface offers no region at all: compactIfNeeded
      // resolves null without a summarization attempt.
      const { engine, attempts, agent } = makeEngine(nodesOf(1, 900_000), 100_000)
      assert.equal(await engine.compactIfNeeded(agent, 'context-overflow'), null)
      assert.deepEqual(attempts, [])
    })

    test('the ladder is bounded and eventually preserves the overflow', async () => {
      const { engine, attempts, agent } = makeEngine(nodesOf(16, 10_000), 1_000)
      await assert.rejects(
        () => engine.compactIfNeeded(agent, 'context-overflow'),
        (error) => error.code === CONTEXT_WINDOW_EXCEEDED_CODE,
      )
      // 15 nodes → 7 → 3 → 1: the initial attempt plus three shrink rungs;
      // the fourth catch is the ladder cap, preserving the overflow.
      assert.deepEqual(attempts, [[100, 114], [100, 106], [100, 102], [100, 100]])
    })

    test('nothing compactable returns null without a summarization attempt', async () => {
      const { engine, attempts, agent } = makeEngine(nodesOf(1, 10_000), 1_000_000)
      assert.equal(await engine.compactIfNeeded(agent, 'context-overflow'), null)
      assert.deepEqual(attempts, [])
    })

    test('overflowShrinkRetainTokens halves the region and always grows strictly', () => {
      const nodes = nodesOf(8, 100_000)
      const measurement = { nodes, totalTokens: 800_000 }
      const fullRange = { start: 100, end: 107 }
      const first = overflowShrinkRetainTokens(measurement, fullRange, 0)
      assert.equal(first, 400_000)
      const halfRange = { start: 100, end: 103 }
      const second = overflowShrinkRetainTokens(measurement, halfRange, first)
      assert.equal(second, 600_000)
      assert.ok(second > first)
      // Single-node regions cannot shrink further.
      assert.equal(overflowShrinkRetainTokens(measurement, { start: 100, end: 100 }, 0), null)
      // Unknown seqs bail out.
      assert.equal(overflowShrinkRetainTokens(measurement, { start: 999, end: 1001 }, 0), null)
    })

    test('isOverflowSummaryError recognizes the adapter code and gateway wording', () => {
      const coded = new LlmError(GATEWAY_400, CONTEXT_WINDOW_EXCEEDED_CODE)
      assert.equal(isOverflowSummaryError(coded), true)
      const wrapped = new Error('compaction summary failed', { cause: coded })
      assert.equal(isOverflowSummaryError(wrapped), true)
      // Wording fallback: the rendered chain matches the provider overflow
      // text even without the adapter code.
      assert.equal(isOverflowSummaryError(new Error(GATEWAY_400)), true)
      assert.equal(isOverflowSummaryError(new Error('summary unavailable')), false)
    })
  }
}
