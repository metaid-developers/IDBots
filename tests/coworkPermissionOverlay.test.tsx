import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import coworkReducer, {
  enqueuePendingPermission,
  setSessions,
  setCurrentSession,
} from '../src/renderer/store/slices/coworkSlice';
import CoworkPermissionOverlay from '../src/renderer/components/cowork/CoworkPermissionOverlay';
import { i18nService } from '../src/renderer/services/i18n';

/**
 * The global permission overlay is the answer to "owner confirmation dialog
 * invisible": prompts raised by sessions that are not the currently open chat
 * (background, IM-automation, hidden_from_session_list sessions) must render
 * somewhere answerable instead of silently burning the 60s watchdog.
 */

const permission = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'sess-hidden-1',
  toolName: 'Bash',
  toolInput: { command: 'npm install --save lodash', description: 'Install dependency' },
  requestId: 'req-1',
  toolUseId: null,
  ...overrides,
});

const sessionSummary = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-hidden-1',
  title: 'Deploy the staging bot',
  status: 'running' as const,
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

function renderOverlay(
  permissions: Array<Record<string, unknown>>,
  inlineSessionId: string | null,
  sessions: Array<Record<string, unknown>> = [],
  currentSession: Record<string, unknown> | null = null,
) {
  const store = configureStore({ reducer: { cowork: coworkReducer } });
  if (sessions.length > 0) {
    store.dispatch(setSessions(sessions as never));
  }
  if (currentSession) {
    store.dispatch(setCurrentSession(currentSession as never));
  }
  permissions.forEach((entry) => store.dispatch(enqueuePendingPermission(entry as never)));
  return renderToStaticMarkup(
    <Provider store={store as never}>
      <CoworkPermissionOverlay inlineSessionId={inlineSessionId} />
    </Provider>,
  );
}

test('overlay renders nothing when no permission is pending', () => {
  assert.equal(renderOverlay([], 'sess-current'), '');
});

test('overlay renders the prompt of a background session with its title and tool input', () => {
  const markup = renderOverlay(
    [permission()],
    'sess-current',
    [sessionSummary()],
  );

  assert.ok(markup.includes('data-cowork-permission-overlay="true"'), 'overlay container rendered');
  assert.ok(markup.includes(i18nService.t('coworkGlobalPermissionTitle')), 'fixed title rendered');
  assert.ok(markup.includes('Deploy the staging bot'), 'owning session title rendered');
  assert.ok(markup.includes('Bash'), 'requested tool name rendered');
  assert.ok(markup.includes(i18nService.t('coworkGlobalPermissionOpenSession')), 'open-session action rendered');

  // Since 8b41467e the compact overlay renders the tool name as the summary;
  // only AskUserQuestion prompts surface their tool input (first question).
  const askMarkup = renderOverlay(
    [permission({ toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'npm install --save lodash?' }] } })],
    'sess-current',
    [sessionSummary()],
  );
  assert.ok(askMarkup.includes('npm install --save lodash?'), 'tool input summary rendered');
});

test('overlay skips the prompt already rendered inline for the open chat', () => {
  const markup = renderOverlay(
    [permission({ sessionId: 'sess-open', requestId: 'req-open' })],
    'sess-open',
  );
  assert.equal(markup, '');
});

test('overlay keeps covering the open session when it is an A2A conversation (no inline seat)', () => {
  const markup = renderOverlay(
    [permission({ sessionId: 'sess-a2a', requestId: 'req-a2a' })],
    'sess-a2a',
    [sessionSummary({ id: 'sess-a2a', sessionType: 'a2a' })],
  );

  assert.ok(markup.includes('data-cowork-permission-overlay="true"'), 'A2A prompt stays answerable in the overlay');
  assert.ok(markup.includes('npm install --save lodash'), 'A2A prompt summary rendered');
});

test('overlay renders inline allow and deny actions', () => {
  const markup = renderOverlay(
    [permission()],
    'sess-current',
    [sessionSummary()],
  );

  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'deny action rendered');
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')), 'allow-once action rendered for a plain tool prompt');
});

test('overlay renders the destructive allow label for safety approvals', () => {
  const safetyPermission = permission({
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [
        {
          header: '安全确认',
          question: '工具 "bash" 将执行删除操作。是否允许本次操作？',
          options: [
            { label: '允许本次操作', description: '仅允许当前这一次操作继续执行。' },
            { label: '拒绝本次操作', description: '拒绝当前操作。' },
          ],
        },
      ],
      answers: {},
      context: { requestedToolName: 'bash', requestedToolInput: { command: 'rm -rf ./dist' } },
    },
  });
  const markup = renderOverlay([safetyPermission], 'sess-current', [sessionSummary()]);

  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowDelete')), 'destructive allow action rendered');
  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'deny action rendered');
});

test('overlay shows the first prompt that has no inline seat when several queue up', () => {
  const markup = renderOverlay(
    [
      permission({ sessionId: 'sess-open', requestId: 'req-open', toolName: 'Read' }),
      permission({ sessionId: 'sess-hidden-1', requestId: 'req-hidden', toolName: 'Write' }),
    ],
    'sess-open',
  );

  assert.ok(markup.includes('Write'), 'uncovered prompt rendered');
  assert.ok(!markup.includes('Read'), 'inline-covered prompt not duplicated');
});

/**
 * Real-device regression (2026-10-30 S6 final verification): the A2A friend
 * invite's owner authorization must render in the global overlay while the
 * owner is watching that exact A2A conversation. The prompt carries the
 * payload requestSuspendedApproval builds (AskUserQuestion + safety-style
 * options + context) for a session the owner has open.
 */
const friendInvitePermission = () => permission({
  sessionId: 'sess-a2a-invite',
  requestId: 'req-invite-1',
  toolName: 'AskUserQuestion',
  toolInput: {
    questions: [
      {
        header: '好友确认',
        question: '机器人「瑞幸店员」请求与「AI_Sunny」互加好友：授权后将用该机器人的钱包写链 /follow（contentBody=对方 GlobalMetaID，链上公开且不可撤销）。是否授权？',
        options: [
          { label: '允许本次操作', description: '仅允许当前这一次操作继续执行。' },
          { label: '拒绝本次操作', description: '拒绝当前操作，保持安全边界。' },
        ],
      },
    ],
    answers: {},
    context: { action: 'invite', peerGlobalMetaId: 'idq1peer', peerName: 'AI_Sunny', metabotId: 31 },
  },
});

test('A2A friend-invite approval renders in the overlay while that A2A chat is the open session', () => {
  const markup = renderOverlay(
    [friendInvitePermission()],
    'sess-a2a-invite',
    [sessionSummary({ id: 'sess-a2a-invite', sessionType: 'a2a', title: 'AI_Sunny' })],
  );

  assert.ok(markup.includes('data-cowork-permission-overlay="true"'), 'invite overlay rendered for the open A2A session');
  assert.ok(markup.includes('互加好友'), 'invite question rendered as the summary');
  // The invite context carries friend-action fields, not safety-tool fields
  // (requestedToolName/requestedToolInput), so the plain allow-once label —
  // not the destructive allow — is the correct render, matching production.
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')), 'plain allow-once action rendered');
  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'deny action rendered');
});

test('A2A invite approval still renders when the sessions list has not loaded (currentSession fallback)', () => {
  // List-reload gap: the open A2A chat is missing from state.cowork.sessions
  // but is loaded as currentSession. Skipping the prompt here would leave it
  // with no render seat anywhere — the invisible-dialog defect class.
  const markup = renderOverlay(
    [friendInvitePermission()],
    'sess-a2a-invite',
    [],
    sessionSummary({ id: 'sess-a2a-invite', sessionType: 'a2a', title: 'AI_Sunny' }),
  );

  assert.ok(markup.includes('data-cowork-permission-overlay="true"'), 'overlay rendered via the currentSession fallback');
  assert.ok(markup.includes('互加好友'), 'invite question rendered');
});

/**
 * S6 final-verification defect #4 (deny-arm visibility): the real device
 * found no CLEARLY visible deny entry on the friend authorization card,
 * leaving the reject branch untestable. The friend card must render an
 * unmistakable side-by-side 允许/拒绝 pair — its own header as the title and
 * an explicitly red-styled deny — while generic prompts keep their original
 * subtle styling byte-for-byte.
 */
test('friend-action card: clear side-by-side allow/deny pair, header title, explicit deny styling', () => {
  const markup = renderOverlay(
    [friendInvitePermission()],
    'sess-a2a-invite',
    [sessionSummary({ id: 'sess-a2a-invite', sessionType: 'a2a', title: 'AI_Sunny' })],
  );

  assert.ok(markup.includes('data-friend-action-card="invite"'), 'friend card is marked for styling');
  assert.ok(markup.includes('好友确认'), 'friend card title renders the question header, not the generic title');
  assert.ok(!markup.includes(i18nService.t('coworkGlobalPermissionTitle')), 'generic title is replaced on the friend card');
  // Both actions visible side by side in the same action row.
  const denyLabel = i18nService.t('coworkDeny');
  const allowLabel = i18nService.t('coworkApprovalAllowOnce');
  assert.ok(markup.includes(denyLabel), 'deny action rendered');
  assert.ok(markup.includes(allowLabel), 'allow action rendered');
  const actionRowStart = markup.indexOf('data-friend-action-card="invite"');
  const denyIndex = markup.indexOf(denyLabel, actionRowStart);
  const allowIndex = markup.indexOf(allowLabel, actionRowStart);
  assert.ok(denyIndex > actionRowStart && allowIndex > denyIndex, 'deny and allow sit side by side inside the friend action row');
  // The deny arm must be visible WITHOUT hover: explicit red border+text.
  const denyButtonStart = markup.lastIndexOf('<button', denyIndex);
  const denyButtonMarkup = markup.slice(denyButtonStart, denyIndex);
  assert.ok(denyButtonMarkup.includes('border-red-300'), 'deny carries a visible red border');
  assert.ok(denyButtonMarkup.includes('text-red-600'), 'deny carries visible red text');
  assert.ok(denyButtonMarkup.includes('font-semibold'), 'deny is bolded for prominence');
});

test('generic prompts keep the original subtle deny styling and generic title', () => {
  const markup = renderOverlay(
    [permission()],
    'sess-current',
    [sessionSummary()],
  );

  assert.ok(!markup.includes('data-friend-action-card='), 'generic prompt is not marked as a friend card');
  assert.ok(markup.includes(i18nService.t('coworkGlobalPermissionTitle')), 'generic title kept');
  const denyLabel = i18nService.t('coworkDeny');
  const denyIndex = markup.indexOf(denyLabel);
  const denyButtonMarkup = markup.slice(markup.lastIndexOf('<button', denyIndex), denyIndex);
  assert.ok(denyButtonMarkup.includes('border-claude-border'), 'generic deny keeps the subtle outline');
  assert.ok(!denyButtonMarkup.includes('border-red-300'), 'generic deny does not take the friend-card red styling');
});
