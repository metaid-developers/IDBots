// Renderer-side assistant-mode session gate — regression coverage.
//
// The assistant transcript form (thinking/tool chrome hidden, replies in
// .assistant-bubble) belongs to regular interactive owner chats ONLY. The
// backend gates every assistant-mode behavior on the per-session Studio
// marker rule (isAssistantModeOwnerChatSession in
// src/main/libs/coworkRunner.ts); the RENDERER derives the form from the
// FACE-derived chat experience mode (hooks/chatExperienceModeSource.ts,
// 总裁办公室 ruling 2026-11-09 — Studio=assistant, BotWorks=professional;
// the Settings toggle is retired). Before the session gate existed the
// renderer derived the form from the GLOBAL mode alone, so opening an
// orchestration/long-term/worker session while the mode was 'assistant'
// rendered the assistant transcript while the backend ran the professional
// prompt — "looks assistant, behaves professional".
//
// Four rendering scenarios are pinned against the real component
// (renderToStaticMarkup) driving the real gate, with the face set through
// the same localStorage slot the shell writes:
//   1. Studio face + regular interactive session -> assistant form;
//   2. Studio face + auto-origin run -> professional transcript;
//   3. Studio face + non-standard session type -> professional transcript;
//   4. BotWorks face -> professional transcript for every session shape.
//
// Observed markers: i18nService.t('reasoning') is the ThinkingBlock header,
// the fixture tool name is the ToolCallGroup row, `.assistant-bubble` is the
// assistant-mode reply bubble, and the reply text renders in both forms.
// Fixture timestamps are equal so the turn renders its process items inline
// (workedForMs === 0, no default-collapsed "Worked for" header) — the mode's
// hiding decision is then directly observable in the static markup.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import coworkReducer, { setCurrentSession } from '../src/renderer/store/slices/coworkSlice';
import skillReducer from '../src/renderer/store/slices/skillSlice';
import modelReducer from '../src/renderer/store/slices/modelSlice';
import CoworkSessionDetail from '../src/renderer/components/cowork/CoworkSessionDetail';
import { isAssistantModeOwnerChatSession } from '../src/renderer/components/cowork/assistantModeSessionGate';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkMessage, CoworkSession } from '../src/renderer/types/cowork';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments: string[]): string =>
  fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const TOOL_NAME = 'fixture_probe_tool';
const FINAL_TEXT = 'FINAL_REPLY_FIXTURE';

// Equal timestamps keep the completed turn expanded: workedForMs is 0, so the
// professional branch renders thinking block + tool group inline instead of
// behind the default-collapsed "Worked for" header.
const FIXTURE_MESSAGES = (): CoworkMessage[] => [
  { id: 'u1', type: 'user', content: '整理数据集', timestamp: 1000 },
  {
    id: 't1',
    type: 'assistant',
    content: 'THINKING_FIXTURE',
    timestamp: 1000,
    metadata: { isThinking: true, isFinal: true, isStreaming: false },
  },
  {
    id: 'c1',
    type: 'tool_use',
    content: `Using tool: ${TOOL_NAME}`,
    timestamp: 1000,
    metadata: { toolUseId: 'c1', toolName: TOOL_NAME, toolInput: { command: 'echo gate-fixture' } },
  },
  { id: 'r1', type: 'tool_result', content: 'ok', timestamp: 1000, metadata: { toolUseId: 'c1' } },
  { id: 'a1', type: 'assistant', content: FINAL_TEXT, timestamp: 1000 },
];

const fixtureSession = (overrides: Partial<CoworkSession> = {}): CoworkSession => ({
  id: 'sess-gate',
  title: 'Gate fixture',
  claudeSessionId: null,
  status: 'completed',
  pinned: false,
  cwd: '/tmp/gate-fixture',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  messages: FIXTURE_MESSAGES(),
  messageHistory: { hasMoreBefore: false, beforeSequence: null, pageSize: 100 },
  createdAt: 1000,
  updatedAt: 2000,
  sessionType: 'standard',
  autoOrigin: null,
  ...overrides,
});

/** Render CoworkSessionDetail for one (active face, session) pair. */
function renderDetail(surface: 'browser' | 'home', session: CoworkSession): string {
  const previousWindow = (globalThis as { window?: unknown }).window;
  // The component reads window.electron.platform during render; effects (and
  // their window listeners) never run under renderToStaticMarkup. The FACE
  // rides the same localStorage slot the shell writes
  // (SURFACE_MODE_STORAGE_KEY in useBotBrowserShell.ts) — the mode is derived
  // from it by hooks/chatExperienceModeSource.ts (Studio=assistant,
  // BotWorks=professional).
  (globalThis as { window?: unknown }).window = {
    electron: { platform: 'darwin' },
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (key: string) => (key === 'idbots.botBrowser.surfaceMode' ? surface : null),
      setItem: () => {},
      removeItem: () => {},
    },
  };
  try {
    const store = configureStore({
      reducer: { cowork: coworkReducer, skill: skillReducer, model: modelReducer },
    });
    store.dispatch(setCurrentSession(session));
    return renderToStaticMarkup(
      <Provider store={store as never}>
        <CoworkSessionDetail onContinue={() => {}} onStop={() => {}} />
      </Provider>,
    );
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
}

function assertAssistantForm(markup: string, label: string): void {
  assert.ok(markup.includes('assistant-bubble'), `${label}: reply renders in the assistant bubble`);
  assert.ok(
    !markup.includes(i18nService.t('reasoning')),
    `${label}: thinking chrome stays hidden`,
  );
  assert.ok(!markup.includes(TOOL_NAME), `${label}: tool details stay hidden`);
  assert.ok(markup.includes(FINAL_TEXT), `${label}: the reply text still renders`);
}

function assertProfessionalForm(markup: string, label: string): void {
  assert.ok(
    markup.includes(i18nService.t('reasoning')),
    `${label}: thinking chrome is NOT hidden`,
  );
  assert.ok(markup.includes(TOOL_NAME), `${label}: tool details are NOT hidden`);
  assert.ok(!markup.includes('assistant-bubble'), `${label}: no assistant bubble`);
  assert.ok(markup.includes(FINAL_TEXT), `${label}: the reply text still renders`);
}

test('scenario 1: Studio face + regular interactive session renders the assistant form', () => {
  const markup = renderDetail('browser', fixtureSession());
  assertAssistantForm(markup, 'Studio face + standard/no-autoOrigin');
});

test('scenario 2: Studio face + auto-created run renders the professional transcript', () => {
  for (const autoOrigin of ['orchestration', 'longterm', 'schedule'] as const) {
    const markup = renderDetail('browser', fixtureSession({ autoOrigin }));
    assertProfessionalForm(markup, `Studio face + autoOrigin ${autoOrigin}`);
  }
});

test('scenario 3: Studio face + non-standard session type renders the professional transcript', () => {
  for (const sessionType of ['browser', 'group_task', 'longterm'] as const) {
    const markup = renderDetail('browser', fixtureSession({ sessionType }));
    assertProfessionalForm(markup, `Studio face + sessionType ${sessionType}`);
  }
  // A2A conversations render their own message view (A2AMessageItem), which
  // filters internal status items (thinking, tool chrome) itself — in BOTH
  // modes — so there is no assistant-vs-professional transcript difference to
  // observe against a static fixture. The gate still yields the professional
  // verdict for a2a, pinned by the pure assertions below and by the wiring
  // test (the A2A item receives the gated value from the detail view).
});

test('scenario 4: BotWorks face renders the professional transcript for every session shape', () => {
  assertProfessionalForm(
    renderDetail('home', fixtureSession()),
    'BotWorks face + regular session',
  );
  assertProfessionalForm(
    renderDetail('home', fixtureSession({ autoOrigin: 'orchestration' })),
    'BotWorks face + auto-origin run',
  );
  assertProfessionalForm(
    renderDetail('home', fixtureSession({ sessionType: 'browser' })),
    'BotWorks face + non-standard session',
  );
});

test('the gate mirrors the backend rule on the two renderer-visible signals', () => {
  // Regular interactive owner chats: standard type (an absent type is the
  // stored-legacy 'standard' default, same as the backend's `?? 'standard'`).
  assert.equal(isAssistantModeOwnerChatSession('assistant', { sessionType: 'standard' }), true);
  assert.equal(isAssistantModeOwnerChatSession('assistant', {}), true);
  assert.equal(
    isAssistantModeOwnerChatSession('assistant', { sessionType: 'standard', autoOrigin: null }),
    true,
  );
  // Auto-created runs and non-standard session types never get the form.
  assert.equal(
    isAssistantModeOwnerChatSession('assistant', { sessionType: 'standard', autoOrigin: 'orchestration' }),
    false,
  );
  assert.equal(isAssistantModeOwnerChatSession('assistant', { sessionType: 'a2a' }), false);
  // No session (draft) and the BotWorks face mode render professional.
  assert.equal(isAssistantModeOwnerChatSession('assistant', null), false);
  assert.equal(isAssistantModeOwnerChatSession('professional', { sessionType: 'standard' }), false);
});

test('session-level surfaces resolve the mode through the shared gate', () => {
  const detailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
  const listSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionList.tsx');
  const panelSource = readSource('src', 'renderer', 'features', 'botBrowser', 'BotBrowserCoworkPanel.tsx');
  const gateSource = readSource('src', 'renderer', 'components', 'cowork', 'assistantModeSessionGate.ts');

  // The session detail derives its transcript form from (mode, currentSession).
  assert.ok(
    detailSource.includes('const isAssistantMode = isAssistantModeOwnerChatSession(chatExperienceMode, currentSession);'),
    'CoworkSessionDetail must gate on the session, not the global boolean',
  );
  assert.ok(
    !detailSource.includes('const isAssistantMode = chatExperienceMode === \'assistant\';'),
    'CoworkSessionDetail must not derive the form from the global mode alone',
  );
  // Session list rows resolve the verdict per row (session summaries carry
  // sessionType + autoOrigin).
  assert.ok(
    listSource.includes('assistantMode={isAssistantModeOwnerChatSession(chatExperienceMode, session)}'),
    'CoworkSessionList must gate each row on its own session',
  );
  assert.ok(
    !listSource.includes('const isAssistantMode = useChatExperienceMode() === \'assistant\';'),
    'CoworkSessionList must not pass the global boolean into rows',
  );
  // The Bot Browser panel is session-scoped too: live sessions gate on their
  // own session; the draft state passes the projector draft identity (the
  // next session from this panel is a Bot Internet projector session, owner
  // ruling 2026-11-07), and legacy pre-marker browser sessions still resolve
  // professional through the same gate.
  assert.ok(
    panelSource.includes('const isAssistantMode = isAssistantModeOwnerChatSession(chatExperienceMode, currentSession ?? PROJECTOR_DRAFT_SESSION_IDENTITY);'),
    'BotBrowserCoworkPanel must gate on its own session, with the projector draft identity for the empty state',
  );
  // The mirror documents its backend counterpart — an unlabeled copy is the
  // drift path this gate exists to prevent.
  assert.ok(
    gateSource.includes('src/main/libs/coworkRunner.ts')
      && gateSource.includes('isAssistantModeOwnerChatSession'),
    'the gate must name its backend counterpart (function + file) in the comment',
  );
});
