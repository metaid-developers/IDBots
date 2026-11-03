import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  OpenTeamCollabCard,
  OpenTeamGuestInviteCard,
  openTeamCollabStatusBadgeClass,
  openTeamCollabStatusLabel,
  openTeamCollabTitle,
  shortGlobalMetaId,
} from '../src/renderer/components/groupTasks/OpenTeamCollabsSection';
import { i18nService } from '../src/renderer/services/i18n';
import type { OpenTeamCollabSummary } from '../src/renderer/types/openTeamCollab';

const baseCollab: OpenTeamCollabSummary = {
  id: 1,
  groupId: 'group-ext-1',
  metabotId: 7,
  botName: 'Worker Seven',
  globalmetaid: 'gmid-bot-7',
  inviterGlobalmetaid: 'gmid-inviter-abcdef',
  taskTitle: 'External Task',
  invitePinId: 'pin-invite-1',
  joinedPinId: 'pin-join-1',
  status: 'active',
  createdAt: null,
  messageCount: 12,
  lastMessageAt: null,
  leftAt: null,
  leftCause: null,
  leftReason: null,
  taskStatus: null,
  taskStatusUpdatedAt: null,
  memberPreviews: [
    { name: 'Worker Seven', avatar: null, role: 'worker', metabotId: 7, globalMetaId: 'gmid-bot-7' },
    { name: 'Remote Chair', avatar: null, role: 'worker', metabotId: null, globalMetaId: 'gmid-inviter-abcdef' },
  ],
};

test('shortGlobalMetaId: trims, shortens, tolerates empty input', () => {
  assert.equal(shortGlobalMetaId('gmid-inviter-abcdef'), 'gmid-invit…');
  assert.equal(shortGlobalMetaId('short'), 'short');
  assert.equal(shortGlobalMetaId(null), '');
  assert.equal(shortGlobalMetaId('   '), '');
});

test('openTeamCollabTitle: task title wins, short group id fallback', () => {
  assert.equal(openTeamCollabTitle({ taskTitle: 'External Task', groupId: 'group-ext-1' }), 'External Task');
  const fallback = openTeamCollabTitle({ taskTitle: null, groupId: 'group-ext-1' });
  assert.ok(fallback.includes('group-ext-1'), `fallback should carry the group id, got: ${fallback}`);
  const truncated = openTeamCollabTitle({ taskTitle: null, groupId: 'group-ext-abcdef' });
  assert.ok(truncated.includes('group-ext-…'), `long group id should be shortened, got: ${truncated}`);
  assert.equal(openTeamCollabTitle({ taskTitle: '   ', groupId: 'g' }), openTeamCollabTitle({ taskTitle: null, groupId: 'g' }));
});

test('openTeamCollabStatusBadgeClass: active is green, left is gray', () => {
  assert.ok(openTeamCollabStatusBadgeClass({ status: 'active', taskStatus: null }).includes('green'));
  assert.ok(openTeamCollabStatusBadgeClass({ status: 'left', taskStatus: null }).includes('gray'));
});

test('collab badge: the host task status drives active memberships', () => {
  // 待验收 amber, 已完成 blue, 已取消 gray, unknown/executing keeps 进行中 green.
  assert.ok(openTeamCollabStatusBadgeClass({ status: 'active', taskStatus: 'review' }).includes('amber'));
  assert.ok(openTeamCollabStatusBadgeClass({ status: 'active', taskStatus: 'done' }).includes('blue'));
  assert.ok(openTeamCollabStatusBadgeClass({ status: 'active', taskStatus: 'cancelled' }).includes('gray'));
  assert.ok(openTeamCollabStatusBadgeClass({ status: 'active', taskStatus: 'executing' }).includes('green'));

  assert.equal(
    openTeamCollabStatusLabel({ status: 'active', taskStatus: 'review' }),
    i18nService.t('openTeamCollabTaskStatusReview'),
  );
  assert.equal(
    openTeamCollabStatusLabel({ status: 'active', taskStatus: 'done' }),
    i18nService.t('openTeamCollabTaskStatusDone'),
  );
  assert.equal(
    openTeamCollabStatusLabel({ status: 'active', taskStatus: 'cancelled' }),
    i18nService.t('openTeamCollabTaskStatusCancelled'),
  );
  assert.equal(
    openTeamCollabStatusLabel({ status: 'active', taskStatus: 'executing' }),
    i18nService.t('openTeamCollabStatusActive'),
  );
  assert.equal(
    openTeamCollabStatusLabel({ status: 'active', taskStatus: null }),
    i18nService.t('openTeamCollabStatusActive'),
  );
  // A left membership always shows Left, even if a status tag landed first.
  assert.equal(
    openTeamCollabStatusLabel({ status: 'left', taskStatus: 'done' }),
    i18nService.t('openTeamCollabStatusLeft'),
  );
});

test('OpenTeamCollabCard: renders the host task status label on the badge', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamCollabCard collab={{ ...baseCollab, taskStatus: 'review' }} onClick={() => {}} />,
  );
  assert.ok(markup.includes(i18nService.t('openTeamCollabTaskStatusReview')), 'review label rendered');
  assert.ok(!markup.includes(i18nService.t('openTeamCollabStatusActive')), 'plain active label replaced');
});

test('OpenTeamCollabCard: renders title, status, avatars and inviter — no message count', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamCollabCard collab={baseCollab} onClick={() => {}} />,
  );
  assert.ok(markup.includes('External Task'), 'task title rendered');
  assert.ok(markup.includes(i18nService.t('openTeamCollabStatusActive')), 'active status label rendered');
  assert.ok(markup.includes('W'), 'avatar initial rendered for a name-only preview');
  assert.ok(markup.includes('gmid-invit…'), 'short inviter id rendered');
  assert.ok(
    !markup.includes(i18nService.t('openTeamCollabMessageCount').replace('{count}', '12')),
    'message count removed from the card',
  );
  assert.ok(!markup.includes('>12<'), 'raw message count not rendered');
  assert.ok(!markup.includes(i18nService.t('openTeamCollabStatusLeft')), 'left label not rendered for active row');
});

test('OpenTeamCollabCard: falls back to the group label, no bot-id meta line', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamCollabCard
      collab={{
        ...baseCollab,
        botName: null,
        taskTitle: null,
        inviterGlobalmetaid: null,
        status: 'left',
        messageCount: 0,
        memberPreviews: [],
      }}
      onClick={() => {}}
    />,
  );
  assert.ok(markup.includes('group-ext-1'), 'group id fallback rendered as the title');
  assert.ok(markup.includes(i18nService.t('openTeamCollabStatusLeft')), 'left status label rendered');
  assert.ok(!markup.includes('External Task'), 'no task title for fallback row');
  assert.ok(!markup.includes('bot-7'), 'no "my bot" meta line anymore');
});

// ---------------------------------------------------------------------------
// P0-1: received-invite history card (OpenTeamGuestInviteCard)
// ---------------------------------------------------------------------------

const baseGuestInvite = {
  id: 1,
  groupId: 'group-ext-1',
  inviterGlobalmetaid: 'gmid-inviter-abcdef',
  inviterName: 'Remote Chair',
  taskTitle: 'External Task',
  goalSummary: 'Build something',
  requiredSkills: ['translation'],
  invitePinId: 'pin-invite-1',
  targetGlobalmetaid: 'gmid-guest',
  expiresAt: 1786400000,
  status: 'invited' as const,
  declineReason: null,
  joinedPinId: null,
  createdAt: null,
  respondedAt: null,
};

test('OpenTeamGuestInviteCard: renders title, inviter, status, goal and skills', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamGuestInviteCard invite={{ ...baseGuestInvite, status: 'invited' }} />,
  );
  assert.ok(markup.includes('External Task'), 'task title rendered');
  assert.ok(markup.includes('Remote Chair'), 'inviter name rendered');
  assert.ok(markup.includes(i18nService.t('openTeamGuestInviteStatusInvited')), 'invited label rendered');
  assert.ok(markup.includes('Build something'), 'goal rendered');
  assert.ok(markup.includes('translation'), 'required skills rendered');
  assert.ok(markup.includes('bg-amber-100'), 'waiting status uses the amber badge');
});

test('OpenTeamGuestInviteCard: terminal statuses show distinct labels', () => {
  const accepted = renderToStaticMarkup(
    <OpenTeamGuestInviteCard invite={{ ...baseGuestInvite, status: 'accepted' }} />,
  );
  assert.ok(accepted.includes(i18nService.t('openTeamGuestInviteStatusAccepted')));
  assert.ok(accepted.includes('bg-green-100'), 'accepted uses the green badge');
  const declined = renderToStaticMarkup(
    <OpenTeamGuestInviteCard invite={{ ...baseGuestInvite, status: 'declined' }} />,
  );
  assert.ok(declined.includes(i18nService.t('openTeamGuestInviteStatusDeclined')));
  const expired = renderToStaticMarkup(
    <OpenTeamGuestInviteCard invite={{ ...baseGuestInvite, status: 'expired' }} />,
  );
  assert.ok(expired.includes(i18nService.t('openTeamGuestInviteStatusExpired')));
});

test('OpenTeamGuestInviteCard: falls back to short group id when untitled', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamGuestInviteCard invite={{ ...baseGuestInvite, taskTitle: null, goalSummary: null, requiredSkills: [] }} />,
  );
  assert.ok(!markup.includes('External Task'));
  assert.ok(markup.includes(i18nService.t('openTeamCollabUntitled').split('{id}')[0].trim()), 'untitled fallback rendered');
});
