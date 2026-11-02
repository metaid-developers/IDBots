import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { filterSessionsByTitle, groupSessionsByDay, resolveSessionBot } from '../src/mobile/app/sessionList';
import { SessionDrawer } from '../src/mobile/app/screens/ChatScreen';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge';
import { mobileI18n, t } from '../src/mobile/i18n';
import { isRenderableAvatar, IPC_TRUNCATION_MARKER } from '../src/mobile/app/avatar';
import type { useChat } from '../src/mobile/app/hooks/useChat';
import type { CoworkSessionSummary } from '../src/types/cowork';
import type { MobileMetabot } from '../src/mobile/bridge/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(here, relative), 'utf8');

type Chat = ReturnType<typeof useChat>;

/** Minimal session summary factory — only the fields grouping/filtering read. */
function session(
  id: string,
  updatedAt: number,
  overrides: Partial<CoworkSessionSummary> = {},
): CoworkSessionSummary {
  return {
    id,
    title: `session ${id}`,
    status: 'idle',
    pinned: false,
    createdAt: updatedAt - 1000,
    updatedAt,
    metabotId: 1,
    ...overrides,
  } as CoworkSessionSummary;
}

/** Fixed "now": 2026-10-29 12:00 local. */
const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime();
const THIS_MORNING = new Date(2026, 9, 29, 0, 30).getTime();
const YESTERDAY_EVENING = new Date(2026, 9, 28, 21, 0).getTime();
const THREE_DAYS_AGO = new Date(2026, 9, 26, 8, 0).getTime();

function bot(id: number, name: string, avatar: string | null): MobileMetabot {
  return {
    id,
    name,
    avatar,
  } as MobileMetabot;
}

describe('groupSessionsByDay', () => {
  it('groups into today / yesterday / earlier by local updatedAt', () => {
    const groups = groupSessionsByDay(
      [
        session('old', THREE_DAYS_AGO),
        session('yesterday', YESTERDAY_EVENING),
        session('today', THIS_MORNING),
      ],
      NOW,
    );
    assert.deepEqual(
      groups.map((group) => group.key),
      ['today', 'yesterday', 'earlier'],
    );
    assert.deepEqual(
      groups.map((group) => group.sessions.map((entry) => entry.id)),
      [['today'], ['yesterday'], ['old']],
    );
  });

  it('treats the local midnight boundary: 00:30 today is today, 23:59 yesterday is yesterday', () => {
    const justBeforeMidnight = new Date(2026, 9, 28, 23, 59).getTime();
    const groups = groupSessionsByDay(
      [session('late', justBeforeMidnight), session('early', THIS_MORNING)],
      NOW,
    );
    assert.deepEqual(groups.map((group) => group.key), ['today', 'yesterday']);
  });

  it('keeps input order inside a group and never mutates the input', () => {
    const input = [session('b', THIS_MORNING), session('a', THIS_MORNING - 1)];
    const snapshot = [...input];
    const groups = groupSessionsByDay(input, NOW);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.sessions.map((entry) => entry.id), ['b', 'a']);
    assert.deepEqual(input, snapshot);
  });

  it('lands malformed timestamps in "earlier" instead of throwing', () => {
    const dirty = { ...session('dirty', Number.NaN) } as CoworkSessionSummary;
    const negative = session('negative', -5);
    const groups = groupSessionsByDay([dirty, negative], NOW);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.key, 'earlier');
    assert.deepEqual(groups[0]?.sessions.map((entry) => entry.id), ['dirty', 'negative']);
  });

  it('returns an empty list for no sessions', () => {
    assert.deepEqual(groupSessionsByDay([], NOW), []);
  });
});

describe('isRenderableAvatar (A1 gateway-truncation gate)', () => {
  it('accepts complete data:image URLs and http(s) URLs', () => {
    assert.equal(isRenderableAvatar('data:image/png;base64,iVBORw0KGgo='), true);
    assert.equal(isRenderableAvatar('https://example.com/a.png'), true);
    assert.equal(isRenderableAvatar('http://example.com/a.png'), true);
  });

  it('rejects sanitizer-truncated strings even when they start with data:image', () => {
    const truncated = `data:image/png;base64,${'A'.repeat(6000)}\n${IPC_TRUNCATION_MARKER}`;
    assert.equal(truncated.length > 4000, true);
    assert.equal(isRenderableAvatar(truncated), false);
  });

  it('rejects non-string and non-image values', () => {
    assert.equal(isRenderableAvatar(null), false);
    assert.equal(isRenderableAvatar(undefined), false);
    assert.equal(isRenderableAvatar(42), false);
    assert.equal(isRenderableAvatar(''), false);
    assert.equal(isRenderableAvatar('   '), false);
    assert.equal(isRenderableAvatar('data:text/html;base64,PGI+'), false);
    assert.equal(isRenderableAvatar('javascript:alert(1)'), false);
    assert.equal(isRenderableAvatar('metafile://abc'), false);
  });
});

describe('resolveSessionBot', () => {
  const bots = [
    bot(1, 'Twin Bot', 'data:image/png;base64,AAA'),
    bot(2, 'Researcher', `data:image/png;base64,${'B'.repeat(6000)}\n${IPC_TRUNCATION_MARKER}`),
  ];

  it('prefers the session summary avatar, then falls back to the roster row', () => {
    const sessions = [session('s1', THIS_MORNING)];
    const summary = {
      ...sessions[0],
      metabotId: 2,
      metabotAvatar: 'data:image/gif;base64,R0lGODlh',
    } as CoworkSessionSummary;
    const view = resolveSessionBot([summary], 's1', 1, bots);
    assert.equal(view.metabotId, 2);
    assert.equal(view.avatar, 'data:image/gif;base64,R0lGODlh');
  });

  it('falls back to the roster avatar of the session\'s bot', () => {
    const sessions = [session('s1', THIS_MORNING)];
    const view = resolveSessionBot(sessions, 's1', null, bots);
    assert.equal(view.name, 'Twin Bot');
    assert.equal(view.avatar, 'data:image/png;base64,AAA');
  });

  it('degrades a gateway-truncated roster avatar to null (letter fallback)', () => {
    const sessions = [{ ...session('s1', THIS_MORNING), metabotId: 2 } as CoworkSessionSummary];
    const view = resolveSessionBot(sessions, 's1', 1, bots);
    assert.equal(view.name, 'Researcher');
    assert.equal(view.avatar, null);
  });

  it('uses the selected metabotId when no session is open', () => {
    const view = resolveSessionBot([], null, 2, bots);
    assert.equal(view.metabotId, 2);
    assert.equal(view.name, 'Researcher');
    assert.equal(view.avatar, null);
  });
});

// ---------------------------------------------------------------------------
// filterSessionsByTitle (drawer search, 2026-11-02)
// ---------------------------------------------------------------------------

describe('filterSessionsByTitle', () => {
  const input = [
    session('a', THIS_MORNING, { title: 'Weekly Report' }),
    session('b', YESTERDAY_EVENING, { title: 'debug notes' }),
    session('c', THREE_DAYS_AGO, { title: 'Trip plan' }),
  ];

  it('returns the input unchanged for empty/whitespace queries', () => {
    assert.equal(filterSessionsByTitle(input, ''), input);
    assert.equal(filterSessionsByTitle(input, '   '), input);
    assert.equal(filterSessionsByTitle(input, ''), input); // stable identity: no copy churn
  });

  it('matches case-insensitive title substrings and preserves order', () => {
    assert.deepEqual(
      filterSessionsByTitle(input, 'report').map((entry) => entry.id),
      ['a'],
    );
    assert.deepEqual(
      filterSessionsByTitle(input, 'REPORT').map((entry) => entry.id),
      ['a'],
    );
    assert.deepEqual(
      filterSessionsByTitle(input, '  Report ').map((entry) => entry.id),
      ['a'],
    );
    // Substring, not prefix: 'plan' matches 'Trip plan'.
    assert.deepEqual(
      filterSessionsByTitle(input, 'plan').map((entry) => entry.id),
      ['c'],
    );
  });

  it('returns an empty list when nothing matches', () => {
    assert.deepEqual(filterSessionsByTitle(input, 'nomatch'), []);
  });

  it('never mutates the input', () => {
    const snapshot = [...input];
    filterSessionsByTitle(input, 'report');
    assert.deepEqual(input, snapshot);
  });

  it('keeps malformed-title rows only for empty queries', () => {
    const dirty = [
      session('ok', THIS_MORNING, { title: 'Report' }),
      { ...session('bad', THIS_MORNING), title: undefined } as unknown as CoworkSessionSummary,
    ];
    assert.deepEqual(
      filterSessionsByTitle(dirty, 'report').map((entry) => entry.id),
      ['ok'],
    );
    // Whitespace-only query still sees every row, dirty or not.
    assert.equal(filterSessionsByTitle(dirty, '').length, 2);
  });

  it('composes with day grouping: filtered results keep Today/Yesterday/Earlier', () => {
    const filtered = filterSessionsByTitle(input, 'e'); // matches Weekly Report (a), debug notes (b)
    const groups = groupSessionsByDay(filtered, NOW);
    assert.deepEqual(
      groups.map((group) => group.key),
      ['today', 'yesterday'],
    );
    assert.deepEqual(groups[0]?.sessions.map((entry) => entry.id), ['a']);
    assert.deepEqual(groups[1]?.sessions.map((entry) => entry.id), ['b']);
  });
});

// ---------------------------------------------------------------------------
// SessionDrawer markup (SSR) + handler-contract pins (2026-11-02)
//
// Harness note (same convention as tests/mobileEmojiPicker.test.tsx): these
// renderer tests are server-rendered, so event handlers cannot be fired —
// markup is asserted via SSR and the interactive wiring (open / rename /
// delete-confirm) is pinned against the real ChatScreen source.
// ---------------------------------------------------------------------------

function chatFixture(overrides: Record<string, unknown> = {}): Chat {
  return {
    messages: [],
    sessions: [],
    sessionId: null,
    sessionTitle: null,
    metabotId: null,
    isStreaming: false,
    isSending: false,
    isUploading: false,
    restoring: false,
    pendingPermissionCount: 0,
    turnPhase: 'idle',
    permission: null,
    toolCalls: [],
    attempts: [],
    actionError: null,
    quotaExhausted: false,
    quotaKind: null,
    hasMoreHistory: false,
    draft: '',
    attachments: [],
    uploads: [],
    setMetabotId: () => undefined,
    setDraft: () => undefined,
    reloadSessions: async () => undefined,
    openSession: async () => undefined,
    renameSession: async () => false,
    archiveSession: async () => false,
    newChat: () => undefined,
    send: async () => undefined,
    stop: async () => undefined,
    pickAttachments: () => undefined,
    removeAttachment: () => undefined,
    removeUpload: () => undefined,
    loadEarlierMessages: async () => undefined,
    respondPermission: async () => undefined,
    dismissPermission: () => undefined,
    reopenPermissions: () => undefined,
    dismissQuota: () => undefined,
    reconcileSubmission: async () => undefined,
    retrySubmission: async () => undefined,
    discardSubmission: () => undefined,
    applyResync: () => undefined,
    getOpenSessionId: () => null,
    getStreamingMessage: () => null,
    ...overrides,
  } as unknown as Chat;
}

function renderDrawer(chatOverrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(SessionDrawer, {
      chat: chatFixture(chatOverrides),
      bots: [],
      open: true,
      onPickBot: () => undefined,
      onClose: () => undefined,
    }),
  );
}

const DRAWER_SOURCE = readSource('../src/mobile/app/screens/ChatScreen.tsx');

describe('SessionDrawer search + rows (SSR)', () => {
  it('renders the search input with localized placeholder and testid', () => {
    mobileI18n.setLanguage('zh');
    const markup = renderDrawer();
    assert.ok(markup.includes('data-testid="session-search-input"'));
    assert.ok(markup.includes(`placeholder="${t('mobile.chat.searchSessions')}"`));
    // Empty initial query: no clear button, and the copy is search copy only.
    assert.ok(!markup.includes('data-testid="session-search-clear"'));
  });

  it('renders every session row with its actions button, groups intact', () => {
    // The drawer groups against the live clock (groupSessionsByDay defaults
    // now=Date.now()), so the fixture uses wall-clock-relative timestamps.
    const realNow = Date.now();
    const markup = renderDrawer({
      sessions: [
        session('today-run', realNow - 60_000, { status: 'running' }),
        session('yesterday-idle', new Date(realNow).setHours(12, 0, 0, 0) - 24 * 60 * 60 * 1000),
        session('old-idle', realNow - 4 * 24 * 60 * 60 * 1000),
      ],
    });
    assert.ok(markup.includes('data-testid="session-group-today"'));
    assert.ok(markup.includes('data-testid="session-group-yesterday"'));
    assert.ok(markup.includes('data-testid="session-group-earlier"'));
    for (const id of ['today-run', 'yesterday-idle', 'old-idle']) {
      assert.ok(markup.includes(`data-testid="session-actions-${id}"`), `actions button for ${id}`);
      assert.ok(markup.includes(`data-testid="session-bot-avatar-${id}"`), `avatar for ${id}`);
    }
    // Exactly one running dot (today-run) — the indicator is unchanged.
    assert.equal(markup.split('h-2 w-2 shrink-0 rounded-full').length - 1, 1);
  });

  it('keeps tap-to-open wiring and search->grouping composition in the source', () => {
    // Open behavior: the row button still opens the session and closes the drawer.
    assert.match(DRAWER_SOURCE, /void chat\.openSession\(session\.id\);\s*\n\s*props\.onClose\(\);/);
    // The drawer filters by title BEFORE grouping (composition with pure functions).
    assert.match(DRAWER_SOURCE, /const visibleSessions = filterSessionsByTitle\(chat\.sessions, searchQuery\);/);
    assert.match(DRAWER_SOURCE, /const groups = groupSessionsByDay\(visibleSessions\);/);
  });

  it('shows the localized search-empty copy branch in the source', () => {
    assert.match(DRAWER_SOURCE, /session-search-empty/);
    assert.match(DRAWER_SOURCE, /t\('mobile\.chat\.searchEmpty'\)/);
    for (const language of ['zh', 'en'] as const) {
      mobileI18n.setLanguage(language);
      assert.ok(t('mobile.chat.searchEmpty').length > 0, `searchEmpty copy for ${language}`);
      assert.ok(t('mobile.chat.searchSessions').length > 0, `searchSessions copy for ${language}`);
    }
  });
});

describe('SessionDrawer rename + delete-confirm (source-contract pins)', () => {
  it('wires rename exclusively through the rename sheet confirm button', () => {
    // The rename bridge call has exactly one call site, inside submitRename.
    assert.equal(DRAWER_SOURCE.split('chat.renameSession(renameFor.id, renameDraft)').length - 1, 1);
    // And submitRename is reached only from the confirm button.
    assert.match(DRAWER_SOURCE, /data-testid="session-rename-confirm"[\s\S]{0,200}?void submitRename\(\);/);
    // Confirm is disabled for blank titles (trim + non-empty gate in the UI).
    assert.match(DRAWER_SOURCE, /disabled=\{renameDraft\.trim\(\) === ''\}/);
  });

  it('gates delete behind its own confirm sheet and archives (no hard delete)', () => {
    // The archive bridge call has exactly one call site, inside confirmDelete.
    assert.equal(DRAWER_SOURCE.split('chat.archiveSession(deleteFor.id)').length - 1, 1);
    // Reached only from the confirm button of the dedicated sheet.
    assert.match(DRAWER_SOURCE, /data-testid="session-delete-confirm"[\s\S]{0,200}?void confirmDelete\(\);/);
    // The menu's Delete button only OPENS the confirm sheet — its opening
    // tag never references the archive call or confirmDelete.
    const menuDeleteIdx = DRAWER_SOURCE.indexOf('data-testid="session-action-delete"');
    assert.ok(menuDeleteIdx >= 0, 'menu delete button rendered');
    const menuDeleteOpenTag = DRAWER_SOURCE.slice(menuDeleteIdx, DRAWER_SOURCE.indexOf('>', menuDeleteIdx) + 1);
    assert.ok(!menuDeleteOpenTag.includes('archiveSession'));
    assert.ok(!menuDeleteOpenTag.includes('confirmDelete'));
    // Confirm copy states the archive semantics in both languages.
    for (const language of ['zh', 'en'] as const) {
      mobileI18n.setLanguage(language);
      assert.ok(t('mobile.chat.deleteBody').length > 0, `deleteBody copy for ${language}`);
      assert.ok(t('mobile.chat.deleteTitle').length > 0, `deleteTitle copy for ${language}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Mock bridge rename/archive semantics (the wire path the drawer rides on)
// ---------------------------------------------------------------------------

describe('mock bridge session management channels', () => {
  function makeBridge() {
    return createMobileMockBridge({
      streamTokenIntervalMs: 1,
      orderCompleteDelayMs: 10,
      reconnectBlackoutMs: 10,
      scheduledRunDelayMs: 10,
      manualRunDelayMs: 10,
    });
  }

  async function listTitles(api: { cowork: { listSessions: () => Promise<{ sessions?: Array<{ title: string }> }> } }): Promise<string[]> {
    const result = await api.cowork.listSessions();
    return (result.sessions ?? []).map((entry) => entry.title);
  }

  it('renameSession trims, persists via listSessions, and rejects empty/unknown', async () => {
    const bridge = makeBridge();
    try {
      const api = bridge.electron;
      const created = await api.cowork.createGreetingSession({ title: 'Original', fallbackGreeting: 'hi' });
      const id = created.session?.id;
      assert.ok(id, 'greeting session created');
      const renamed = await api.cowork.renameSession({ sessionId: id as string, title: '  Renamed Title  ' });
      assert.equal(renamed.success, true);
      assert.ok((await listTitles(api)).includes('Renamed Title'), 'trimmed title visible in listSessions');
      const blank = await api.cowork.renameSession({ sessionId: id as string, title: '   ' });
      assert.equal(blank.success, false, 'blank title rejected');
      const missing = await api.cowork.renameSession({ sessionId: 'no-such-session', title: 'x' });
      assert.equal(missing.success, false, 'unknown session rejected');
    } finally {
      bridge.destroy();
    }
  });

  it('archiveSession hides from listSessions, survives in listArchivedSessions, restores via unarchive', async () => {
    const bridge = makeBridge();
    try {
      const api = bridge.electron;
      const created = await api.cowork.createGreetingSession({ title: 'Doomed', fallbackGreeting: 'hi' });
      const id = created.session?.id as string;
      assert.ok((await listTitles(api)).includes('Doomed'));

      const archived = await api.cowork.archiveSession(id);
      assert.equal(archived.success, true);
      assert.ok(!(await listTitles(api)).includes('Doomed'), 'archived row hidden from active list');
      const archivedList = await api.cowork.listArchivedSessions();
      assert.ok(
        (archivedList.sessions ?? []).some((entry) => entry.id === id),
        'archived row listed by listArchivedSessions (reversible)',
      );

      const restored = await api.cowork.unarchiveSession(id);
      assert.equal(restored.success, true);
      assert.ok((await listTitles(api)).includes('Doomed'), 'unarchive restores the row');

      const missing = await api.cowork.archiveSession('no-such-session');
      assert.equal(missing.success, false, 'unknown session rejected');
    } finally {
      bridge.destroy();
    }
  });
});
