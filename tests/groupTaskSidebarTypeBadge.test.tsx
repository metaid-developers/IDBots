import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GroupTaskSidebarList, {
  GroupTaskTypeBadge,
} from '../src/renderer/components/groupTasks/GroupTaskSidebarList';
import { OpenTeamCollabSidebarRow } from '../src/renderer/components/groupTasks/OpenTeamCollabSidebarRow';
import { i18nService } from '../src/renderer/services/i18n';

const baseTask = (id: number) => ({
  id,
  groupId: null,
  title: `Task ${id}`,
  status: 'executing' as const,
  pinned: false,
  displayName: null,
  members: [],
  updatedAt: null,
  createdAt: null,
});

const baseCollab = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  groupId: `${'g'.repeat(64)}i0`,
  metabotId: 3,
  botName: 'Eleven',
  globalmetaid: 'idq1collab',
  inviterGlobalmetaid: 'idq1inviter',
  taskTitle: 'External Task',
  invitePinId: null,
  joinedPinId: null,
  status: 'active' as const,
  createdAt: null,
  messageCount: 3,
  lastMessageAt: null,
  leftAt: null,
  leftCause: null,
  leftReason: null,
  taskStatus: null,
  taskStatusUpdatedAt: null,
  memberPreviews: [
    { name: 'Eleven', avatar: null, role: 'worker' as const, metabotId: 3, globalMetaId: 'idq1collab' },
  ],
  ...overrides,
});

test('GroupTaskTypeBadge: Open Team reads the same neutral style as Local', () => {
  const openTeam = renderToStaticMarkup(<GroupTaskTypeBadge type="openteam-guest" />);
  assert.ok(
    openTeam.includes(i18nService.t('groupTasksTaskBadgeOpenTeam')),
    'open-team label rendered',
  );
  const local = renderToStaticMarkup(<GroupTaskTypeBadge type="local" />);
  assert.ok(local.includes(i18nService.t('groupTasksTaskBadgeLocal')), 'local label rendered');
  // Same muted bordered treatment for both — only the label differs.
  const neutralClass = 'border border-claude-border';
  assert.ok(openTeam.includes(neutralClass), 'open-team badge is neutral, not accent-colored');
  assert.ok(!/text-claude-accent\b/.test(openTeam), 'open-team badge carries no accent ink');
  assert.ok(local.includes(neutralClass), 'local badge keeps the neutral bordered style');
});

test('GroupTaskSidebarList: rows carry the type badge driven by openTeamTaskIds', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskSidebarList
      tasks={[baseTask(1), baseTask(44)]}
      onSelectTask={() => {}}
      openTeamTaskIds={new Set([44])}
    />,
  );
  assert.ok(
    markup.includes(i18nService.t('groupTasksTaskBadgeOpenTeam')),
    'remote-seat task row shows the Open Team badge',
  );
  assert.ok(
    markup.includes(i18nService.t('groupTasksTaskBadgeLocal')),
    'all-local task row shows the Local badge',
  );
});

test('OpenTeamCollabSidebarRow: joined collab rows carry the Open Team badge, no guest badge', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamCollabSidebarRow collab={baseCollab()} onSelect={() => {}} />,
  );
  assert.ok(
    markup.includes(i18nService.t('groupTasksTaskBadgeOpenTeam')),
    'joined collab row shows the Open Team badge',
  );
  assert.ok(!markup.includes(i18nService.t('groupTasksTaskBadgeLocal')), 'no local badge on collab rows');
  assert.ok(
    !markup.includes(i18nService.t('groupTasksTaskBadgeGuest')),
    'guest (参与方) badge removed from collab rows',
  );
});

test('OpenTeamCollabSidebarRow: bot avatars under the title, no message count', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamCollabSidebarRow
      collab={baseCollab({
        memberPreviews: [
          { name: 'Eleven', avatar: 'data:image/png;base64,QQ==', role: 'worker' as const, metabotId: 3, globalMetaId: 'idq1collab' },
        ],
      })}
      onSelect={() => {}}
    />,
  );
  assert.ok(markup.includes('data:image/png;base64,QQ=='), 'member avatar rendered');
  assert.ok(markup.includes('Eleven'), 'member name rendered (alt)');
  assert.ok(
    !markup.includes('groupTask.messages'),
    'message-count text removed from the row',
  );
  assert.ok(!markup.includes('>3<'), 'raw message count not rendered');
});

test('OpenTeamCollabSidebarRow: unix-second lastMessageAt reads as a sane relative time', () => {
  const oneHourAgoSeconds = Math.floor(Date.now() / 1000) - 3600;
  const markup = renderToStaticMarkup(
    <OpenTeamCollabSidebarRow
      collab={baseCollab({ lastMessageAt: oneHourAgoSeconds })}
      onSelect={() => {}}
    />,
  );
  assert.ok(markup.includes('>1h<'), `expected the 1h compact label, got: ${markup.slice(0, 400)}`);
  assert.ok(!markup.includes('20739d'), 'no 1970-epoch day-scale label');
});
