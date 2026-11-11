import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for the Studio projection fast path (owner ruling
// 2026-11-11): the projector bot calls projection_begin right before writing
// the page file, and the host re-binds the LIVE turn's model selection to the
// lowest reasoning effort the model can express — so the large HTML write
// streams without deep thinking. Phase-scoped by construction: the kernel
// resolves each step's request config from the agent's CURRENT selection, and
// host tools execute between steps, so the flip lands on exactly the next
// request; the next turn's ensureSession re-binds the normally-resolved
// effort. This file pins the wiring end to end; the effort-choice semantics
// are covered by dshModelReasoning.test.mjs.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const kernelSource = read('src/main/libs/dshKernel/dshKernel.ts');
const hubSource = read('src/main/libs/coworkDshTurn.ts');
const runnerSource = read('src/main/libs/coworkRunner.ts');
const promptSource = read('src/main/libs/assistantModePrompt.ts');
const reasoningSource = read('src/main/libs/dshModelReasoning.ts');

test('the kernel client re-binds through the mounted session/ensure RPC', () => {
  assert.match(kernelSource, /async selectModel\(input: \{/);
  assert.match(kernelSource, /this\.client\.request\('session\/ensure', input\)/);
  assert.doesNotMatch(kernelSource, /this\.client\.request\('session\/selectModel', input\)/);
});

test('the hub tracks the live turn route and re-binds its selection to the lowest effort', () => {
  assert.match(hubSource, /private routeByDsh = new Map<string, DshTurnProviderRoute>\(\)/);
  assert.match(hubSource, /this\.routeByDsh\.set\(input\.dshSessionId, input\.provider\)/);
  assert.match(hubSource, /async forceProjectionFastMode\(coworkSessionId: string\)/);
  assert.match(hubSource, /dshLowestReasoningSelection\(route\.model, route\.apiFormat, route\.baseUrl\)/);
  assert.match(hubSource, /kernel\.selectModel\(\{ sessionId: dshId, provider: route\.key, model: route\.model, reasoningEffort: effort \}\)/);
  // Best-effort by contract: the re-bind must never throw out of the tool call.
  assert.match(hubSource, /return \{ ok: false, error: message \}/);
});

test('the projection_begin host tool mounts only on projector sessions and never errors the turn', () => {
  assert.match(runnerSource, /if \(this\.isProjectorModeSession\(sessionId\)\) \{/);
  assert.match(runnerSource, /'projection_begin',/);
  assert.match(runnerSource, /this\.dshTurnHub\?\.forceProjectionFastMode\(sessionId\)/);
  // Both outcomes return plain text — a failed re-bind degrades to the status
  // quo instead of failing the tool call.
  assert.match(runnerSource, /Fast mode unavailable right now — write the projection page as usual\./);
  const toolBlock = runnerSource.slice(
    runnerSource.indexOf("'projection_begin',"),
    runnerSource.indexOf('return tools', runnerSource.indexOf("'projection_begin',")),
  );
  assert.doesNotMatch(toolBlock, /isError: true/);
});

test('the projector prompt mandates projection_begin before the page write in both locales', () => {
  // Exact per-locale phrases (the header changelog may also name the tool, so
  // a bare count cannot distinguish copy from prose).
  assert.equal((promptSource.match(/projection_begin（无参数，立即返回）/g) ?? []).length, 1, 'zh rule');
  assert.equal((promptSource.match(/Call projection_begin once first \(no parameters, returns immediately\)/g) ?? []).length, 1, 'en rule');
  // The rule sits inside the 怎么投影 / How to project paragraphs, ahead of
  // the page-write instruction it gates.
  const zhIndex = promptSource.indexOf('projection_begin（无参数，立即返回）');
  const zhWriteIndex = promptSource.indexOf('reports/ 目录');
  assert.ok(zhIndex >= 0 && zhWriteIndex > zhIndex, 'zh rule must precede the page-write instruction');
  const enIndex = promptSource.indexOf('Call projection_begin once first');
  const enWriteIndex = promptSource.indexOf('reports/ (e.g.');
  assert.ok(enIndex >= 0 && enWriteIndex > enIndex, 'en rule must precede the page-write instruction');
});

test('the effort-choice helper picks the lowest EXPRESSIBLE selection, not a wire value', () => {
  assert.match(reasoningSource, /export function dshLowestReasoningSelection\(/);
  assert.match(reasoningSource, /if \(!ladder \|\| 'off' in ladder\) return 'off';/);
});
