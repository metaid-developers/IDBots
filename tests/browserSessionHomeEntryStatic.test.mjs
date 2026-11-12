import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for the BotWorks browser-session listing (owner ruling
// 2026-11-12, SUPERSEDING the two-surface split of 2026-11-08): Studio
// (Bot Internet) browser co-work sessions (session_type 'browser') are listed
// again in the BotWorks local history — with their Studio badge (copy renamed
// 浏览器→Studio the same day) — and open in the BotWorks chat view with the
// PROFESSIONAL presentation (full thinking transcript), not by routing back
// to the Studio surface. The Studio face keeps its side of the 11-08 split:
// its own local list stays browser-free and its search rows / panel history
// remain the Studio entry points.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('HomeSidebar lists browser sessions in the BotWorks local bucket again', () => {
  const source = read('src/renderer/components/HomeSidebar.tsx');

  // The local grouping no longer excludes browser sessions (owner ruling
  // 2026-11-12): only group_task is excluded, plus the IM-backed a2a
  // reclassification that stays pinned by qqSessionClassification (CLS-09b).
  assert.doesNotMatch(
    source,
    /&&\s*session\.sessionType\s*!==\s*'browser'/,
    'the BotWorks local list must include browser co-work sessions',
  );
  assert.match(
    source,
    /const isLocal = \(session: CoworkSessionSummary\) =>\s*session\.sessionType !== 'group_task'\s*&&\s*\(session\.sessionType !== 'a2a' \|\| isImSession\(session\)\)/,
  );
  assert.match(
    source,
    /const homeSessions = sessions;/,
    'BotWorks history is backed by the full cowork session list (search spans it)',
  );
});

test('HomeSidebar opens every session — browser included — in the BotWorks chat view', () => {
  const source = read('src/renderer/components/HomeSidebar.tsx');

  // The browser→Studio routing is retired on this face: a browser row opens
  // the cowork view like any other session, where it renders professionally.
  assert.doesNotMatch(source, /onSelectBrowserSession/, 'the face no longer takes a browser route prop');
  const handlerStart = source.indexOf('const handleSelectSession = async');
  assert.ok(handlerStart > 0, 'handleSelectSession should exist');
  const handlerEnd = source.indexOf('const handleDeleteSession', handlerStart);
  assert.ok(handlerEnd > handlerStart, 'handleSelectSession should end before handleDeleteSession');
  const handler = source.slice(handlerStart, handlerEnd);
  assert.doesNotMatch(handler, /sessionType\s*===\s*'browser'/, 'no browser branch in the selector');
  assert.match(handler, /onShowCowork\(\);/);
  assert.match(handler, /await coworkService\.loadSession\(sessionId\);/);
});

test('the Studio-face Sidebar keeps its side of the 11-08 split (browser rows off its local list, routed from search)', () => {
  const source = read('src/renderer/components/Sidebar.tsx');

  // Sidebar.tsx is the Internet middle column: browser sessions stay OFF its
  // local bucket (its entry points are the panel history + search rows).
  assert.match(source, /&&\s*session\.sessionType\s*!==\s*'browser'/);
  // ...and its search rows still route a browser hit back to the Studio panel.
  const handlerStart = source.indexOf('const handleSelectSession = async');
  assert.ok(handlerStart > 0, 'handleSelectSession should exist');
  const handlerEnd = source.indexOf('const handleDeleteSession', handlerStart);
  assert.ok(handlerEnd > handlerStart, 'handleSelectSession should end before handleDeleteSession');
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /target\?\.sessionType === 'browser' && onSelectBrowserSession/);
  assert.match(handler, /await onSelectBrowserSession\(sessionId\);/);
});

test('a2a grouping is unchanged; the group bucket is Internet-only', () => {
  const source = read('src/renderer/components/HomeSidebar.tsx');

  assert.match(source, /a2a:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'a2a'\s*&&\s*!isImSession\(session\)\)/);
  // Owner ruling 2026-11-08 15:46 retired the Home 「群任务」sign: the live Home
  // sidebar derives no group_task bucket any more. The Internet middle column
  // keeps its own copy of the bucket.
  assert.doesNotMatch(source, /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/);
  const internetCopy = read('src/renderer/components/Sidebar.tsx');
  assert.match(internetCopy, /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/);
});

test('the Studio badge is restored as a per-surface opt-in (owner ruling 2026-11-12)', () => {
  // SUPERSEDES the 2026-11-11 17:28 retirement: the badge is back, but as an
  // explicit showBrowserBadge prop so the Studio panel history (its own
  // bot-centered ruling) stays badge-free.
  const item = read('src/renderer/components/cowork/CoworkSessionItem.tsx');
  assert.match(item, /showBrowserBadge = false,/);
  assert.match(item, /\{showBrowserBadge && session\.sessionType === 'browser' \? \(/);
  assert.match(item, /i18nService\.t\('coworkSessionTypeBrowser'\)/);

  // The sidebars' shared list opts in (badge shows wherever a browser row
  // renders: the BotWorks local list and the search modal).
  const list = read('src/renderer/components/cowork/CoworkSessionList.tsx');
  assert.match(list, /showBrowserBadge = true,/);
  assert.match(list, /showBrowserBadge=\{showBrowserBadge\}/);

  // The Studio panel history renders rows directly WITHOUT the flag — its
  // rows stay badge-free (owner ruling 2026-11-11 17:28 on that surface).
  const panel = read('src/renderer/features/botBrowser/CoworkHistoryPanel.tsx');
  assert.doesNotMatch(panel, /showBrowserBadge/, 'the panel history stays badge-free');
});

test('the badge label reads Studio in both locales (copy renamed 2026-11-12)', () => {
  const source = read('src/renderer/services/i18n.ts');
  const occurrences = source.match(/coworkSessionTypeBrowser:/g) ?? [];
  assert.equal(occurrences.length, 2, 'the badge key must exist in exactly the two locales');
  const copies = source.match(/coworkSessionTypeBrowser: '([^']*)'/g) ?? [];
  assert.deepEqual(
    copies,
    ["coworkSessionTypeBrowser: 'Studio'", "coworkSessionTypeBrowser: 'Studio'"],
    'both locales carry the Studio copy (the 浏览器/Browser wording is retired)',
  );
});

test('App keeps the browser-session route for the Studio-face Sidebar only', () => {
  const source = read('src/renderer/App.tsx');

  assert.match(source, /const handleSelectBrowserSession = useCallback\(async \(sessionId: string\) => \{/);
  assert.match(
    source,
    /await botBrowserShell\.openBrowserHome\(\);\s*await browserCoworkService\.loadSession\(sessionId\);/,
  );
  // Exactly ONE wiring site remains: the Studio-face Sidebar. The HomeSidebar
  // mount must no longer take the prop.
  const wirings = source.match(/onSelectBrowserSession=\{handleSelectBrowserSession\}/g) ?? [];
  assert.equal(wirings.length, 1, 'only the Studio-face Sidebar wires the browser route');
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
