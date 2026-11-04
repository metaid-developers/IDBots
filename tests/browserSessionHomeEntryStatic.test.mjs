import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for "a Bot Browser session has no entry point in Bot Home":
// the SQL layer (coworkStore.listSessions) never filtered session_type, but the
// renderer Sidebar dropped every `sessionType === 'browser'` row, so once the
// user switched away from the Bot Browser surface the session was unreachable.
// These assertions pin the renderer-side contract that fixes it, and pin the
// a2a / group_task behaviour that must not regress.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Sidebar keeps browser sessions in the Bot Home history list', () => {
  const source = read('src/renderer/components/Sidebar.tsx');

  // The bug: home sessions were filtered with `sessionType !== 'browser'`.
  assert.doesNotMatch(
    source,
    /filter\(\(session\)\s*=>\s*session\.sessionType\s*!==\s*'browser'\)/,
    'Sidebar must not filter browser sessions out of the home history',
  );
  assert.match(
    source,
    /const homeSessions = sessions;/,
    'home history is the full cowork session list',
  );
});

test('Sidebar routes a browser row back to the Bot Browser surface', () => {
  const source = read('src/renderer/components/Sidebar.tsx');

  assert.match(source, /onSelectBrowserSession\?:\s*\(sessionId:\s*string\)\s*=>\s*void\s*\|\s*Promise<void>;/);
  const handlerStart = source.indexOf('const handleSelectSession = async');
  assert.ok(handlerStart > 0, 'handleSelectSession should exist');
  const handlerEnd = source.indexOf('const handleDeleteSession', handlerStart);
  assert.ok(handlerEnd > handlerStart, 'handleSelectSession should end before handleDeleteSession');
  const handler = source.slice(handlerStart, handlerEnd);

  assert.match(
    handler,
    /target\?\.sessionType\s*===\s*'browser'\s*&&\s*onSelectBrowserSession/,
    'browser sessions take the browser-surface branch',
  );
  assert.match(handler, /await onSelectBrowserSession\(sessionId\);/);
  // Non-browser sessions keep the historic home-view behaviour.
  assert.match(handler, /onShowCowork\(\);/);
  assert.match(handler, /await coworkService\.loadSession\(sessionId\);/);
  assert.match(
    handler,
    /target\?\.sessionType === 'browser' && onSelectBrowserSession\) \{\s*await onSelectBrowserSession\(sessionId\);\s*return;\s*\}\s*onShowCowork\(\);/,
    'browser branch returns early; the home branch is untouched',
  );
});

test('a2a and group_task grouping is unchanged', () => {
  const source = read('src/renderer/components/Sidebar.tsx');

  // local holds everything except the two dedicated groups, so browser lands in
  // local. The one deliberate exception: an a2a row that arrived over an IM
  // channel (a QQ / WeChat bot-to-bot conversation) is promoted into local so
  // the owner can reach it from Bot Home — the behaviour pinned by
  // qqSessionClassification.test.ts (CLS-09b).
  assert.match(
    source,
    /const isLocal = \(session: CoworkSessionSummary\) =>\s*session\.sessionType !== 'group_task'\s*&&\s*\(session\.sessionType !== 'a2a' \|\| isImSession\(session\)\)/,
  );
  // and the two dedicated groups match their own type only — the a2a tab keeps
  // the IM rows out of itself, since they now live in local.
  assert.match(source, /a2a:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'a2a'\s*&&\s*!isImSession\(session\)\)/);
  assert.match(source, /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/);
});

test('browser rows carry a visible type badge', () => {
  const source = read('src/renderer/components/cowork/CoworkSessionItem.tsx');

  assert.match(source, /const isBrowser = session\.sessionType === 'browser';/);
  assert.match(source, /\{isBrowser && \(/);
  assert.match(source, /i18nService\.t\('coworkSessionTypeBrowser'\)/);
  // The title/a2a presentation must stay driven by session type only — with the
  // same IM exception: an IM-backed a2a row is a direct-message chat, not a
  // bot-to-bot session, so it must not pick up a2a styling.
  assert.match(source, /const isA2A = session\.sessionType === 'a2a' && !session\.imChannel;/);
});

test('App wires the browser-session route and passes it to the Sidebar', () => {
  const source = read('src/renderer/App.tsx');

  assert.match(source, /import \{ browserCoworkService \} from '\.\/services\/browserCowork';/);
  assert.match(source, /const handleSelectBrowserSession = useCallback\(async \(sessionId: string\) => \{/);
  assert.match(
    source,
    /await botBrowserShell\.openBrowserHome\(\);\s*await browserCoworkService\.loadSession\(sessionId\);/,
  );
  assert.match(source, /onSelectBrowserSession=\{handleSelectBrowserSession\}/);
});

test('Bot Browser panel history still lists ONLY browser sessions', () => {
  const source = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');

  assert.match(
    source,
    /sessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'browser'\)/,
    'the panel history is browser-only and must keep its own filter',
  );
});

test('the browser-session badge label exists in both locales', () => {
  const source = read('src/renderer/services/i18n.ts');
  const occurrences = source.match(/coworkSessionTypeBrowser:/g) ?? [];
  assert.equal(occurrences.length, 2, 'zh + en translations for the badge label');
});
