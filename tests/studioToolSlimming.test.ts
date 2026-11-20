// Studio/mobile tool-slimming gates: worker-economy families stay off the
// Studio owner-chat surface and start unmounted on cloud mobile owner chats.
// Mobile expands them only after explicit intent; non-Studio desktop surfaces
// keep their existing behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');

const GATED = [
  ['metatask family', 'if (this.metataskTools && this.metabotChainWrite && mountWorkerEconomyTools) {'],
  ['prediction ledger', 'if (this.predictionTools && mountWorkerEconomyTools) {'],
  ['group chat', 'if (this.groupChat && mountSocialTools) {'],
  ['escrow orders', 'if (this.escrowTools && mountWorkerEconomyTools) {'],
  ['metaprotocol writer', 'if (this.metaProtocolRegistry && mountWorkerEconomyTools) {'],
];

test('worker-economy families are gated off the Studio owner-chat surface', () => {
  // The shared gate const exists with the census rationale…
  assert.ok(
    runnerSource.includes('const isStudioOwnerChat = this.isAssistantModeOwnerChatSession(sessionId);'),
    'coworkRunner: the Studio owner-chat gate must be defined in buildSessionInlineTools',
  );
  // …and each family mount consults it.
  for (const [label, anchor] of GATED) {
    assert.ok(
      runnerSource.includes(anchor),
      `coworkRunner: the ${label} mount must be gated with !isStudioOwnerChat`,
    );
  }
  // The agentpedia block is an unconditional push inside the chain-write
  // block — it must now sit behind its own condition.
  const agentpediaAt = runnerSource.indexOf('...buildAgentpediaAgentTools({');
  assert.ok(agentpediaAt > 0, 'agentpedia mount exists');
  const before = runnerSource.slice(Math.max(0, agentpediaAt - 200), agentpediaAt);
  assert.ok(
    before.includes('if (mountWorkerEconomyTools) {'),
    'coworkRunner: the agentpedia family must use the shared worker-economy gate',
  );
});

test('the gate keys on the session marker, so non-Studio desktop surfaces keep every family', () => {
  // isAssistantModeOwnerChatSession = assistantMode && !autoOrigin — the
  // Studio definition. BotWorks/worker/A2A/automation sessions keep the full
  // surface (their own gates like memoryReadOnly are untouched).
  const gateAt = runnerSource.indexOf('const isStudioOwnerChat =');
  assert.ok(gateAt > 0);
  const context = runnerSource.slice(gateAt - 900, gateAt);
  assert.ok(
    context.includes('2026-11-19 census'),
    'the gate comment must cite the census evidence',
  );
});
