import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import A2AApprovalBar from '../src/renderer/components/cowork/A2AApprovalBar';
import CoworkSessionItem from '../src/renderer/components/cowork/CoworkSessionItem';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkPermissionRequest } from '../src/renderer/types/cowork';

const approvalPermission = (overrides: Partial<CoworkPermissionRequest> = {}): CoworkPermissionRequest => ({
  sessionId: 'sess-a2a-1',
  requestId: 'req-payment-1',
  toolName: 'AskUserQuestion',
  toolInput: {
    questions: [{
      header: 'Transfer 10 SPACE',
      question: 'Send exactly 10 SPACE to Peer Bot. The transaction is public and irreversible.',
      options: [
        { label: 'Allow once', description: 'Authorize only this action.' },
        { label: 'Deny', description: 'Do not transfer.' },
      ],
    }],
    answers: {},
    context: { a2aApproval: true, category: 'payment' },
  },
  ...overrides,
});

test('generic A2A approval bar exposes one centered waiting state with allow and deny actions', () => {
  const markup = renderToStaticMarkup(<A2AApprovalBar permission={approvalPermission()} />);
  assert.ok(markup.includes('data-a2a-approval="payment"'));
  assert.ok(markup.includes(i18nService.t('a2aApprovalWaiting')));
  assert.ok(markup.includes('justify-center'));
  assert.ok(markup.includes('Transfer 10 SPACE'));
  assert.ok(markup.includes('public and irreversible'));
  assert.ok(markup.includes(i18nService.t('coworkApprove')));
  assert.ok(markup.includes(i18nService.t('coworkDeny')));
});

test('legacy friend approval keeps its copy while using the shared approval bar', () => {
  const permission = approvalPermission({
    toolInput: {
      questions: [{ header: 'Friend confirmation', question: 'Follow Peer Bot?', options: [{ label: 'Allow' }, { label: 'Deny' }] }],
      context: { action: 'invite' },
    },
  });
  const markup = renderToStaticMarkup(<A2AApprovalBar permission={permission} />);
  assert.ok(markup.includes('data-a2a-approval="friendship"'));
  assert.ok(markup.includes('data-a2a-friend-approval="invite"'));
  assert.ok(markup.includes(i18nService.t('a2aFriendApprovalInviteTitle')));
});

const renderSessionRow = (approvalPending: boolean) => renderToStaticMarkup(
  <CoworkSessionItem
    session={{
      id: 'sess-a2a-1',
      title: 'Peer Bot',
      status: 'running',
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
      sessionType: 'a2a',
    }}
    hasUnread={false}
    approvalPending={approvalPending}
    isActive={false}
    onSelect={() => {}}
    onDelete={() => {}}
    onTogglePin={() => {}}
    onRename={() => {}}
    nowMs={60_000}
  />,
);

test('online conversation row gives a pending approval a prominent red dot even while running', () => {
  const markup = renderSessionRow(true);
  assert.ok(markup.includes('data-a2a-approval-pending="true"'));
  assert.ok(markup.includes('bg-red-500'));
  assert.ok(markup.includes(i18nService.t('a2aApprovalPending')));
});

test('online conversation row removes the red approval dot after resolution', () => {
  const markup = renderSessionRow(false);
  assert.ok(!markup.includes('data-a2a-approval-pending'));
  assert.ok(!markup.includes('bg-red-500'));
});
