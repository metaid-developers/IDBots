import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TURN_ACK_PHRASE_POOLS,
  drawTurnAckPhrase,
  findTailTurnAck,
  resetTurnAckDrawing,
} from '../src/renderer/components/cowork/turnAckPhrases.ts';
import { mapCerebellumEffortRungToTurnAckTier } from '../src/main/cerebellum/effortSelector.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// Phrase pools
// ---------------------------------------------------------------------------

const MIN_POOL_SIZES = { fast: 10, moderate: 8, heavy: 6, generic: 6 };

test('turn-ack phrase pools: both languages, minimum sizes, no duplicates, non-empty', () => {
  for (const language of ['zh', 'en']) {
    const pools = TURN_ACK_PHRASE_POOLS[language];
    for (const [tier, minSize] of Object.entries(MIN_POOL_SIZES)) {
      const pool = pools[tier];
      assert.ok(Array.isArray(pool) && pool.length >= minSize,
        `${language}/${tier} needs at least ${minSize} phrases (has ${pool?.length ?? 0})`);
      assert.ok(pool.every((phrase) => typeof phrase === 'string' && phrase.trim().length > 0),
        `${language}/${tier} phrases must be non-empty strings`);
      assert.equal(new Set(pool).size, pool.length, `${language}/${tier} phrases must be unique`);
    }
  }
});

test('shuffle bag: consecutive draws within a pool size never repeat, then the bag refills', () => {
  resetTurnAckDrawing(undefined, true);
  const pool = TURN_ACK_PHRASE_POOLS.zh.fast;
  const drawn = Array.from({ length: pool.length }, (_, index) =>
    drawTurnAckPhrase({ sessionId: 'bag-test', tier: 'fast', language: 'zh', ackMessageId: `ack-${index}` }));
  assert.equal(new Set(drawn).size, drawn.length, 'a full bag cycle draws every phrase exactly once');
  assert.deepEqual([...drawn].sort(), [...pool].sort(), 'the cycle covers the whole pool');
  // Refill: the next cycle is a reshuffle of the same pool.
  const second = Array.from({ length: pool.length }, (_, index) =>
    drawTurnAckPhrase({ sessionId: 'bag-test', tier: 'fast', language: 'zh', ackMessageId: `ack2-${index}` }));
  assert.deepEqual([...second].sort(), [...pool].sort(), 'the refilled bag still covers the whole pool');
});

test('shuffle bag: different sessions draw independently', () => {
  resetTurnAckDrawing(undefined, true);
  const a = drawTurnAckPhrase({ sessionId: 'session-a', tier: 'fast', language: 'zh', ackMessageId: 'a-0' });
  const b = drawTurnAckPhrase({ sessionId: 'session-b', tier: 'fast', language: 'zh', ackMessageId: 'b-0' });
  assert.ok(typeof a === 'string' && typeof b === 'string');
  assert.ok(poolIncludes('zh', 'fast', a), 'session-a drew from the zh fast pool');
  assert.ok(poolIncludes('zh', 'fast', b), 'session-b drew from the zh fast pool');
});

function poolIncludes(language, tier, phrase) {
  return TURN_ACK_PHRASE_POOLS[language][tier].includes(phrase);
}

test('draw is idempotent per ack message id (re-renders never re-roll)', () => {
  resetTurnAckDrawing(undefined, true);
  const first = drawTurnAckPhrase({ sessionId: 'idem', tier: 'heavy', language: 'en', ackMessageId: 'ack-fixed' });
  const intermediate = drawTurnAckPhrase({ sessionId: 'idem', tier: 'heavy', language: 'en', ackMessageId: 'ack-other' });
  const again = drawTurnAckPhrase({ sessionId: 'idem', tier: 'heavy', language: 'en', ackMessageId: 'ack-fixed' });
  assert.equal(first, again, 'the same ack message always renders the same phrase');
  assert.notEqual(first, intermediate, 'a different ack message advances the bag');
});

test('unknown tiers and languages degrade to the generic pool / english', () => {
  resetTurnAckDrawing(undefined, true);
  const phrase = drawTurnAckPhrase({ sessionId: 'degrade', tier: 'nonsense', language: 'zh', ackMessageId: 'deg-0' });
  assert.ok(poolIncludes('zh', 'generic', phrase), 'unknown tiers fall back to generic');
  const english = drawTurnAckPhrase({ sessionId: 'degrade2', tier: 'fast', language: 'fr', ackMessageId: 'deg-1' });
  assert.ok(poolIncludes('en', 'fast', english), 'unknown languages fall back to english');
});

// ---------------------------------------------------------------------------
// Tail-run scan
// ---------------------------------------------------------------------------

const statusMsg = (status, extra = {}, id = status) => ({
  id,
  type: 'system',
  metadata: { sdkRuntimeStatus: status, ...extra },
});
const textMsg = (id) => ({ id, type: 'assistant', metadata: { isStreaming: true } });

test('findTailTurnAck: finds the newest ack inside the contiguous status tail run', () => {
  const found = findTailTurnAck([
    statusMsg('turnAck', { turnAckTier: 'fast' }, 'ack-old'),
    statusMsg('requesting', {}, 'req-1'),
  ]);
  assert.deepEqual(found, { tier: 'fast', messageId: 'ack-old' },
    'an ack followed by requesting still applies (retry excepted)');
});

test('findTailTurnAck: real content ends the run — an older ack stops applying', () => {
  assert.equal(findTailTurnAck([
    statusMsg('turnAck', { turnAckTier: 'moderate' }, 'ack-old'),
    textMsg('stream-1'),
    statusMsg('requesting', {}, 'req-1'),
  ]), null, 'the streaming message breaks the tail run before the ack');
  assert.equal(findTailTurnAck([statusMsg('requesting', {}, 'req-1')]), null);
  assert.equal(findTailTurnAck([]), null);
});

test('findTailTurnAck: invalid tiers are ignored', () => {
  assert.equal(findTailTurnAck([statusMsg('turnAck', { turnAckTier: 'bogus' }, 'ack-bad')]), null);
  const valid = findTailTurnAck([
    statusMsg('turnAck', { turnAckTier: 'bogus' }, 'ack-bad'),
    statusMsg('turnAck', { turnAckTier: 'heavy' }, 'ack-good'),
  ]);
  assert.deepEqual(valid, { tier: 'heavy', messageId: 'ack-good' });
});

// ---------------------------------------------------------------------------
// Effort-rung → tier mapping (single difficulty source of truth)
// ---------------------------------------------------------------------------

test('mapCerebellumEffortRungToTurnAckTier: off/low→fast, high→moderate, max→heavy', () => {
  assert.equal(mapCerebellumEffortRungToTurnAckTier('off'), 'fast');
  assert.equal(mapCerebellumEffortRungToTurnAckTier('low'), 'fast');
  assert.equal(mapCerebellumEffortRungToTurnAckTier('high'), 'moderate');
  assert.equal(mapCerebellumEffortRungToTurnAckTier('max'), 'heavy');
});

// ---------------------------------------------------------------------------
// Source contracts (emission wiring + renderer consumption)
// ---------------------------------------------------------------------------

test('runner: turnAck is emitted after the effort verdict, before the brain call, gated to cowork_ui', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // Early emission: fires at turn entry — before ANY pre-flight await on the
  // turn path (the volatile build, images, and skill-env sync now run kicked
  // and overlapped) — so cold-start windows (15s+ relay key bootstrap) still
  // get an instant "on it" instead of the old generic spinner copy.
  const earlyEmission = source.indexOf('this.emitTurnAck(sessionId, earlyAckTier, prompt)');
  const envSyncSite = source.indexOf('await this.syncDshSkillSessionEnv(');
  assert.ok(earlyEmission > 0, 'the turn emits the early ack at entry');
  assert.ok(envSyncSite > earlyEmission,
    'the early ack precedes every pre-flight await on the turn path (covers the whole wait window)');
  // Tier upgrade: after the effort verdict, only an auto verdict that beats
  // generic supersedes the early emission (a newer turnAck wins the tail scan).
  const upgradeEmission = source.indexOf("'turn acknowledgment tier upgraded'");
  const effortSite = source.indexOf("'auto effort resolved for turn'");
  const brainSite = source.indexOf('await hub.runTurn(');
  assert.ok(upgradeEmission > effortSite,
    'the tier upgrade waits for the effort verdict');
  assert.ok(brainSite > upgradeEmission,
    'both emissions fire before the brain call (they cover the first-token wait)');
  const gate = source.slice(earlyEmission - 900, upgradeEmission + 400);
  assert.ok(gate.includes("sourceChannel === 'cowork_ui'"),
    'external-facing surfaces keep their established posture (cowork_ui only)');
});

test('runner: the picker "Auto" (stored as the string \'default\') is the auto path, not an explicit pick', async () => {
  const { resolveEffectiveEffortRung } = await import('../dist-electron/main/libs/coworkRunner.js');
  assert.equal(resolveEffectiveEffortRung('default'), null,
    "the picker's Auto rung must re-enable the cerebellum effort selector and the ack tiering");
  assert.equal(resolveEffectiveEffortRung(null), null);
  assert.equal(resolveEffectiveEffortRung(undefined), null);
  assert.equal(resolveEffectiveEffortRung('bogus'), null);
  assert.equal(resolveEffectiveEffortRung('off'), 'off');
  assert.equal(resolveEffectiveEffortRung('low'), 'low');
  assert.equal(resolveEffectiveEffortRung('high'), 'high');
  assert.equal(resolveEffectiveEffortRung('max'), 'max');

  // And every consumer reads through the normalization — no decision site
  // may compare effortOverride against null directly anymore.
  const source = read('src/main/libs/coworkRunner.ts');
  const consumers = source.match(/effortOverride (==|!=) null/g) ?? [];
  assert.deepEqual(consumers, [],
    'all effort decisions must go through resolveEffectiveEffortRung');
});

test('runner: the ack emitter bypasses the runtime-status dedup key (once per turn by construction)', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const start = source.indexOf('private emitTurnAck(');
  const end = source.indexOf('private emitSdkRuntimeStatus(', start);
  const body = source.slice(start, end);
  assert.ok(start > 0 && end > start, 'emitTurnAck exists next to emitSdkRuntimeStatus');
  assert.ok(!body.includes('lastSdkRuntimeStatusKey'),
    'a session-scoped dedup key would swallow the second turn\'s ack after a fast first reply');
  assert.ok(body.includes("sdkRuntimeStatus: 'turnAck'"));
});

test('renderer: both activity indicators consume the ack via the shared tail-run scan', () => {
  const indicator = read('src/renderer/components/cowork/AssistantActivityIndicator.tsx');
  const detail = read('src/renderer/components/cowork/CoworkSessionDetail.tsx');

  assert.ok(indicator.includes('findTailTurnAck(messages)'), 'assistant-mode indicator scans for the ack');
  assert.ok(indicator.includes('drawTurnAckPhrase({'), 'assistant-mode indicator draws a bag phrase');
  assert.ok(detail.includes('useTurnAckPhrase(messages, sessionId)'), 'professional-mode bar draws via the same hook');
  assert.ok(detail.includes('sessionId={currentSession.id}'), 'bags are scoped per session');
});
