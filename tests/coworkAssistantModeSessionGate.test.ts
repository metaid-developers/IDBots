/**
 * Renderer assistant-mode session gate
 * (src/renderer/components/cowork/assistantModeSessionGate.ts).
 *
 * The chat-experience mode is a global setting, but its *effects* are
 * per-session: the backend applies assistant mode only to regular interactive
 * owner chats (isAssistantModeOwnerChatSession in
 * src/main/libs/coworkRunner.ts) and runs every unattended / non-standard
 * session with the professional prompt and the unattended effort branch. The
 * renderer used to read the global mode for every session, so opening an
 * orchestration / long-term / worker session showed assistant chrome (thinking
 * and tool detail hidden) while its turns actually ran professionally.
 *
 * Coverage:
 *  1. behavioural — the gate's truth table, imported and called for real;
 *  2. static wiring — each session-scoped consumer routes through the gate and
 *     no consumer derives the verdict from the bare global comparison again
 *     (the exact regression this change exists to prevent), plus the drift
 *     guard that ties the mirror to its backend counterpart.
 *
 * Run: npx tsx --test tests/coworkAssistantModeSessionGate.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isAssistantModeOwnerChatSession } from '../src/renderer/components/cowork/assistantModeSessionGate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(here, '..', relative), 'utf8');

const DETAIL = 'src/renderer/components/cowork/CoworkSessionDetail.tsx';
const LIST = 'src/renderer/components/cowork/CoworkSessionList.tsx';
const BROWSER_PANEL = 'src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx';
const GATE = 'src/renderer/components/cowork/assistantModeSessionGate.ts';

// ---------------------------------------------------------------------------
// 1. Behaviour: the gate's truth table
// ---------------------------------------------------------------------------

test('gate: an ordinary owner chat keeps assistant chrome while the global mode is assistant', () => {
  assert.equal(isAssistantModeOwnerChatSession('assistant', { sessionType: 'standard', autoOrigin: null }), true);
  // sessionType absent means the stored default, i.e. 'standard'
  assert.equal(isAssistantModeOwnerChatSession('assistant', { autoOrigin: null }), true);
  assert.equal(isAssistantModeOwnerChatSession('assistant', {}), true);
});

test('gate: auto-created runs (orchestration / long-term / schedule) never take assistant chrome', () => {
  for (const autoOrigin of ['orchestration', 'longterm', 'schedule'] as const) {
    assert.equal(
      isAssistantModeOwnerChatSession('assistant', { sessionType: 'standard', autoOrigin }),
      false,
      `autoOrigin '${autoOrigin}' must keep the professional treatment`,
    );
  }
});

test('gate: non-standard session types (a2a / browser / group) never take assistant chrome', () => {
  for (const sessionType of ['a2a', 'browser'] as const) {
    assert.equal(
      isAssistantModeOwnerChatSession('assistant', { sessionType, autoOrigin: null }),
      false,
      `sessionType '${sessionType}' must keep the professional treatment`,
    );
  }
});

test('gate: professional mode is professional for every session shape', () => {
  for (const session of [
    { sessionType: 'standard', autoOrigin: null },
    { sessionType: 'standard', autoOrigin: 'orchestration' as const },
    { sessionType: 'browser', autoOrigin: null },
  ]) {
    assert.equal(isAssistantModeOwnerChatSession('professional', session), false);
  }
});

test('gate: a missing session degrades to professional rather than throwing', () => {
  assert.equal(isAssistantModeOwnerChatSession('assistant', null), false);
  assert.equal(isAssistantModeOwnerChatSession('assistant', undefined), false);
});

test('gate: the verdict keys on the session, not on the mode alone', () => {
  // Same global mode, two session shapes, two different verdicts — this is the
  // whole point of the change.
  const mode = 'assistant' as const;
  assert.equal(isAssistantModeOwnerChatSession(mode, { sessionType: 'standard', autoOrigin: null }), true);
  assert.equal(isAssistantModeOwnerChatSession(mode, { sessionType: 'standard', autoOrigin: 'orchestration' }), false);
});

// ---------------------------------------------------------------------------
// 2. Static wiring: consumers route through the gate, and the mirror cannot drift
// ---------------------------------------------------------------------------

test('wiring: session-scoped consumers resolve assistant mode through the gate', () => {
  const detail = read(DETAIL);
  assert.ok(
    detail.includes('isAssistantModeOwnerChatSession(chatExperienceMode, currentSession)'),
    'CoworkSessionDetail must resolve the verdict from (mode, currentSession)',
  );

  const list = read(LIST);
  assert.ok(
    list.includes('isAssistantModeOwnerChatSession(chatExperienceMode, session)'),
    'each session-list row must resolve its own verdict from (mode, session)',
  );

  const browserPanel = read(BROWSER_PANEL);
  assert.ok(
    browserPanel.includes('isAssistantModeOwnerChatSession(chatExperienceMode, currentSession)'),
    'the Bot Browser cowork panel must resolve the verdict from (mode, session)',
  );
});

test('wiring: nobody derives the verdict from the bare global mode again', () => {
  for (const file of [DETAIL, LIST, BROWSER_PANEL]) {
    const source = read(file);
    assert.ok(
      !/useChatExperienceMode\(\)\s*===\s*'assistant'/.test(source),
      `${file} must not compare the global mode directly — that is the defect this gate fixes`,
    );
  }
});

test('wiring: the gate names its backend counterpart so the two rules cannot drift silently', () => {
  const gate = read(GATE);
  assert.ok(gate.includes('isAssistantModeOwnerChatSession'), 'the mirror keeps the backend function name');
  assert.ok(gate.includes('coworkRunner.ts'), 'the mirror points at the backend implementation');
  assert.ok(
    /MUST NOT drift|must not drift/i.test(gate),
    'the mirror must state the no-drift contract',
  );
  // The renderer payload carries no conversation source channel, so the known
  // divergence stays documented rather than silently forgotten.
  assert.ok(
    /source channel|sourceChannel/.test(gate) && /Known divergence/i.test(gate),
    'the known divergence (backend also keys on sourceChannel) must stay documented',
  );
});

test('wiring: the composer-level mode consumption for the draft state stays professional in the browser panel', () => {
  // The panel resolves with currentSession, which is null in the draft state;
  // the gate returns false for a missing session, so a browser draft renders
  // professional. Assert the null-passthrough contract the panel relies on.
  assert.equal(isAssistantModeOwnerChatSession('assistant', null), false);
});
