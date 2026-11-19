// Studio tool-slimming gates (Phase 2 slice 1, 2026-11-19 census): the
// worker-economy protocol families (metatask publish/submit/amend, agentpedia
// writers, escrow orders, post_metaprotocol writer, group_chat orchestration,
// prediction ledger) were never called from an assistant-mode owner chat in
// 30 recent sessions on ANY surface, yet their schemas cost ~36KB ≈ 9K
// tokens of EVERY Studio request. Each family mount is now gated off the
// Studio owner-chat surface; flipping one `&& !isStudioOwnerChat` restores it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');

const GATED = [
  ['metatask family', 'if (this.metataskTools && this.metabotChainWrite && !isStudioOwnerChat) {'],
  ['prediction ledger', 'if (this.predictionTools && !isStudioOwnerChat) {'],
  ['group chat', 'if (this.groupChat && !isStudioOwnerChat) {'],
  ['escrow orders', 'if (this.escrowTools && !isStudioOwnerChat) {'],
  ['metaprotocol writer', 'if (this.metaProtocolRegistry && !isStudioOwnerChat) {'],
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
    before.includes('if (!isStudioOwnerChat) {'),
    'coworkRunner: the agentpedia family must be gated with !isStudioOwnerChat',
  );
});

test('the gate keys on the session marker, so non-Studio surfaces keep every family', () => {
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
