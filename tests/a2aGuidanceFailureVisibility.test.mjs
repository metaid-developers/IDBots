import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Source-anchor regression tests for the 2026-09-14 A2A stall post-mortem
 * (session 4e0f46b2, bot brain still pointed at a credit-exhausted provider):
 *
 * 1. A guided-restart failure surfaced ONLY as a small red status line — no
 *    transcript message, no cowork.log entry — so the operator read the click
 *    as "no reaction" and concluded the conversation was unrecoverable.
 * 2. The turn error itself was the raw provider JSON body; it named no
 *    provider or model, so "what do I top up / switch?" was unanswerable
 *    from the transcript.
 *
 * main.ts and coworkRunner.ts are Electron-coupled and cannot be imported
 * under node:test, so their wiring is anchored statically here (the same
 * pattern as coworkRunnerSurfWiringStatic.test.mjs).
 */

const mainSource = readFileSync(
  new URL('../src/main/main.ts', import.meta.url),
  'utf8',
);
const runnerSource = readFileSync(
  new URL('../src/main/libs/coworkRunner.ts', import.meta.url),
  'utf8',
);

test('guided-restart failure lands in the transcript with the preserved-guidance notice', () => {
  const catchStart = mainSource.indexOf('catch (restartError)');
  assert.ok(catchStart !== -1, 'guided-restart catch block must exist');
  const catchSlice = mainSource.slice(catchStart, catchStart + 4500);
  assert.match(
    catchSlice,
    /a2aGuidanceFailed: true/,
    'the failure notice must be identifiable in the transcript (a2aGuidanceFailed metadata)',
  );
  assert.match(
    catchSlice,
    /coworkStoreInst\.addMessage\(sessionId,\s*\{\s*type: 'system'/,
    'a failed guided restart must append a system message to the session transcript',
  );
  assert.match(
    catchSlice,
    /error: guidanceFailureNotice/,
    'metadata.error must carry the full notice — the A2A error banner reads metadata.error first',
  );
  assert.match(
    catchSlice,
    /a2aGuidanceQueue\.queue\(\{ sessionId, metabotId: session\.metabotId, guidance \}\)/,
    'the guidance must stay queued for the next local turn after a failed restart',
  );
});

test('guided-restart failure and success are logged to cowork.log', () => {
  const catchStart = mainSource.indexOf('catch (restartError)');
  const catchSlice = mainSource.slice(catchStart, catchStart + 4500);
  assert.match(
    catchSlice,
    /coworkLog\('ERROR', 'A2A Guidance', 'Guided restart failed/,
    'restart failure must be diagnosable from cowork.log',
  );
  assert.match(
    mainSource,
    /coworkLog\('INFO', 'A2A Guidance', 'Guided restart delivered'/,
    'restart success must be diagnosable from cowork.log',
  );
});

test('quota-dead DSH turns name the provider and model in the transcript error', () => {
  // Anchor on the settlement REGION, not a fixed character window: the error
  // call now sits after the other terminal-notice definitions, several
  // kilobytes past the quota notice (the old +1600 window stopped short of it
  // and reported a phantom mismatch). Slice from the quota notice to the
  // composed message it feeds.
  const settlement = runnerSource.indexOf('const quotaNotice =');
  assert.ok(settlement !== -1, 'the quota notice must exist in the DSH turn error settlement');
  const errorCall = runnerSource.indexOf('DSH turn failed:', settlement);
  assert.ok(errorCall > settlement, 'the quota notice must feed the DSH turn error settlement');
  const slice = runnerSource.slice(settlement, errorCall + 240);
  assert.match(slice, /isQuotaDshTurnError\(outcome\)/);
  assert.match(slice, /lastAttemptRoute\.provider/);
  assert.match(slice, /lastAttemptRoute\.model/);
  // The settlement message was refactored from one ${failureDetail} slot into
  // a composed notice chain (ladder semantics + quota + the other terminal
  // notices). The CONTRACT is unchanged — the quota notice is interpolated
  // into the DSH-turn error the transcript shows — so pin the composition,
  // not the retired literal (stale-literal red found in the 2026-11-08 batch).
  assert.match(
    slice,
    /`DSH turn failed: \$\{ladderSemantics\}\$\{quotaNotice\}/,
  );
});

test('the quota notice names the route that actually ran the last attempt', () => {
  const fallbackLoop = runnerSource.indexOf('let lastAttemptRoute = route;');
  assert.ok(fallbackLoop !== -1);
  const fallbackSwitch = runnerSource.indexOf('lastAttemptRoute = fallbackRoute;');
  assert.ok(fallbackSwitch !== -1, 'fallback-route resumes must update the notice route');
  assert.ok(fallbackSwitch > fallbackLoop);
});
