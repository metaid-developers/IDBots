import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for the two-surface session split (owner ruling
// 2026-11-08): Bot Browser co-work sessions (session_type = 'browser') live on
// the Bot Internet surface — the panel's own history overlay is their entry
// point — and must NOT mix into the Bot Home history list. Reachability stays
// via search rows (routed back to the Bot Browser surface) and the panel
// history. Earlier this file pinned the opposite contract: the 1.0.x regression
// where a renderer-side `sessionType !== 'browser'` filter left browser chats
// with no entry point at all. That concern is now answered by the panel history
// overlay, not by the home list.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('the restored Home sidebar keeps browser sessions OUT of the Bot Home history list', () => {
  // Owner ruling 2026-11-08 14:22 restored Bot Home to the baseline two-column
  // form: the live Home list is HomeSidebar.tsx. Sidebar.tsx keeps its copy of
  // the same contract for the Internet middle column (unchanged this batch).
  const source = read('src/renderer/components/HomeSidebar.tsx');

  // The local (home) grouping excludes browser sessions; they render on the
  // Bot Internet surface instead.
  assert.match(
    source,
    /&&\s*session\.sessionType\s*!==\s*'browser'/,
    'the home local list must exclude browser co-work sessions',
  );
  assert.match(
    source,
    /const homeSessions = sessions;/,
    'home history is still backed by the full cowork session list (search spans it)',
  );
});

test('the Home sidebar routes a browser row back to the Bot Browser surface', () => {
  const source = read('src/renderer/components/HomeSidebar.tsx');

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

test('a2a grouping is unchanged; browser rows stay out of local; the group bucket is Internet-only', () => {
  const source = read('src/renderer/components/HomeSidebar.tsx');

  // local holds human↔MetaBot chats but not browser co-work sessions (they
  // live on the Bot Internet surface). The one deliberate exception: an a2a
  // row that arrived over an IM channel (a QQ / WeChat bot-to-bot
  // conversation) is promoted into local so the owner can reach it from Bot
  // Home — the behaviour pinned by qqSessionClassification.test.ts (CLS-09b).
  assert.match(
    source,
    /const isLocal = \(session: CoworkSessionSummary\) =>\s*session\.sessionType !== 'group_task'\s*&&\s*session\.sessionType !== 'browser'\s*&&\s*\(session\.sessionType !== 'a2a' \|\| isImSession\(session\)\)/,
  );
  // and the a2a group matches its own type only — the a2a tab keeps the IM rows
  // out of itself, since they now live in local.
  assert.match(source, /a2a:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'a2a'\s*&&\s*!isImSession\(session\)\)/);
  // Owner ruling 2026-11-08 15:46 retired the Home 「群任务」sign: the live Home
  // sidebar derives no group_task bucket any more. Nothing is deleted — the
  // Internet middle column keeps its own copy of the bucket and its
  // group-task session slot (that file is untouched by this batch).
  assert.doesNotMatch(source, /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/);
  const internetCopy = read('src/renderer/components/Sidebar.tsx');
  assert.match(internetCopy, /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/);
});

test('browser rows retire the type badge (owner ruling 2026-11-11 17:28)', () => {
  // SUPERSEDES the former "browser rows carry a visible type badge" guard:
  // the source badge (「浏览器」/ Browser) is retired from the session rows —
  // its label, its derivation, and both locale entries are gone. The
  // visited-page context line stays the row's identity cue for these
  // sessions.
  const source = read('src/renderer/components/cowork/CoworkSessionItem.tsx');

  assert.doesNotMatch(source, /const isBrowser = session\.sessionType === 'browser';/);
  assert.doesNotMatch(source, /\{isBrowser && \(/);
  assert.doesNotMatch(source, /i18nService\.t\('coworkSessionTypeBrowser'\)/);
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
  // Bot-centered scope (owner spec 2026-11-11 17:28 ②): the parent hands the
  // panel the PRESENTED bot (the chip bot — live session bot, draft pick
  // otherwise), and the panel itself narrows to that bot's rows, so switching
  // bots moves the list with it.
  assert.match(source, /botId=\{chipMetabot\?\.id \?\? null\}/);
  const panel = read('src/renderer/features/botBrowser/CoworkHistoryPanel.tsx');
  assert.match(
    panel,
    /botId != null \? sessions\.filter\(\(session\) => session\.metabotId === botId\) : \[\]/,
    'the history panel scopes its rows strictly to the presented bot',
  );
});

test('the retired badge label is gone from both locales (owner ruling 2026-11-11 17:28)', () => {
  // SUPERSEDES the former "exists in both locales" guard: the source badge
  // retired from the rows means its key retires from the dictionary too.
  const source = read('src/renderer/services/i18n.ts');
  const occurrences = source.match(/coworkSessionTypeBrowser:/g) ?? [];
  assert.equal(occurrences.length, 0, 'the retired badge key must not survive in any locale');
});
