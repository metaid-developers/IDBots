import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards for the session list's render cost. The sidebar holds hundreds of
// session rows (a real install: ~900), and every list read replaced every
// summary object, so before this work a single refresh re-rendered all of them —
// each row re-running its relative-time formatter, its i18n lookups, its effects
// and its per-row closures. The contract these tests pin:
//
//  1. the row component is memoized and takes ids instead of pre-bound
//     closures (a closure per row would defeat the memo on every render);
//  2. the list stabilizes the summary objects it hands the rows, otherwise the
//     fresh objects from `coworkSlice.setSessions` defeat the memo anyway;
//  3. the list hands the rows referentially stable action callbacks and one
//     shared clock, and is memoized itself;
//  4. only a bounded prefix of rows mounts at once, with the rest revealed as
//     the user scrolls to the end — so a 900-session list no longer puts ~900
//     rows (and a five-figure node count) in the DOM up front.

const repoRoot = path.resolve(import.meta.dirname, '..');

const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

const listSource = read('src/renderer/components/cowork/CoworkSessionList.tsx');
const itemSource = read('src/renderer/components/cowork/CoworkSessionItem.tsx');
const revealSource = read('src/renderer/components/cowork/sessionListRevealBudget.ts');

test('the session row is memoized and its actions take the session id', () => {
  assert.match(itemSource, /const CoworkSessionItemRow: React\.FC<CoworkSessionItemProps> = \(\{/);
  assert.match(itemSource, /const CoworkSessionItem = React\.memo\(CoworkSessionItemRow\);/);
  // The id, not a pre-bound closure: the row closes over its own session.
  assert.match(itemSource, /onSelect: \(sessionId: string\) => void;/);
  assert.match(itemSource, /onTogglePin: \(sessionId: string, pinned: boolean\) => void;/);
  assert.match(itemSource, /onRename: \(sessionId: string, title: string\) => void;/);
  assert.match(itemSource, /onSelect\(session\.id\);/);
  assert.match(itemSource, /onTogglePin\(session\.id, !session\.pinned\);/);
  assert.match(itemSource, /onRename\(session\.id, nextTitle\);/);
  assert.match(itemSource, /onDelete\(session\.id\);/);
  assert.match(itemSource, /onToggleSelected\?\.\(session\.id\)/);
  // No per-row closures survive in the list's renderItem.
  assert.doesNotMatch(listSource, /onSelect=\{\(\) => onSelectSession/);
  assert.doesNotMatch(listSource, /onTogglePin=\{\(pinned\) => onTogglePin/);
});

test('the row stamp takes the list clock, and the row carries the i18n generation', () => {
  // A memoized row can no longer call Date.now() itself: without a shared clock
  // that ticks, "5m" would stay "5m" until the row's data changed.
  assert.match(itemSource, /export const formatRelativeTime = \(timestamp: number, nowMs: number = Date\.now\(\)\)/);
  assert.match(itemSource, /const relativeTime = formatRelativeTime\(session\.updatedAt, nowMs\);/);
  assert.match(itemSource, /nowMs\?: number;/);
  // The language is a prop (a memo input) so a language switch refreshes the
  // labels of rows whose data did not change.
  assert.match(itemSource, /language\?: string;/);
  assert.match(listSource, /const \[nowMs, setNowMs\] = useState\(\(\) => Date\.now\(\)\)/);
  assert.match(listSource, /window\.setInterval\(\(\) => setNowMs\(Date\.now\(\)\), RELATIVE_TIME_TICK_MS\)/);
  assert.match(listSource, /window\.clearInterval\(timer\)/);
  assert.match(listSource, /nowMs=\{nowMs\}/);
  assert.match(listSource, /language=\{language\}/);
});

test('the list stabilizes the summary objects it renders before anything reads them', () => {
  assert.match(listSource, /const \[sessions, autoSessions, followUpSessions\] = useStableSessionSummaries\(\s*incomingSessions,\s*incomingAutoSessions,\s*incomingFollowUpSessions,\s*\);/);
  assert.match(listSource, /const useStableSessionSummaries = \(/);
  // Shallow, one level deep into nested objects, and conservative: anything that
  // differs keeps the fresh object.
  assert.match(listSource, /const sameSummaryValue = \(a: unknown, b: unknown\): boolean => \{/);
  assert.match(listSource, /const kept = previous && sameSessionSummary\(previous, session\) \? previous : session;/);
});

test('the list is memoized and hands the rows stable callbacks', () => {
  assert.match(listSource, /const CoworkSessionList = React\.memo\(CoworkSessionListRow\);/);
  assert.match(listSource, /const selectSession = useStableCallback\(onSelectSession\);/);
  assert.match(listSource, /const deleteSession = useStableCallback\(onDeleteSession\);/);
  assert.match(listSource, /const togglePin = useStableCallback\(onTogglePin\);/);
  assert.match(listSource, /const renameSession = useStableCallback\(onRenameSession\);/);
  assert.match(listSource, /onSelect=\{selectSession\}/);
  // The sidebar must not hand the memoized list freshly built handlers again.
  const sidebar = read('src/renderer/components/Sidebar.tsx');
  assert.match(sidebar, /onSelectSession=\{listOnSelectSession\}/);
  assert.match(sidebar, /onDeleteSession=\{listOnDeleteSession\}/);
  assert.match(sidebar, /onTogglePin=\{listOnTogglePin\}/);
  assert.match(sidebar, /onRenameSession=\{listOnRenameSession\}/);
  assert.match(sidebar, /const listOnSelectSession = useStableCallback\(handleSelectSession\);/);
  assert.match(sidebar, /language=\{language\}/);
});

test('only a bounded prefix of rows mounts, and scrolling toward the end reveals more', () => {
  assert.match(revealSource, /export const REVEAL_INITIAL_ROWS = \d+;/);
  assert.match(revealSource, /export const REVEAL_CHUNK_ROWS = \d+;/);
  assert.match(listSource, /const revealedRows = useProgressiveRowReveal\(rootRef\);/);
  // The budget is spent by the row factory and checked before every section
  // header, so no header is left standing without its rows.
  assert.match(listSource, /let remainingRows = revealedRows;/);
  assert.match(listSource, /const revealBudgetLeft = \(\) => remainingRows > 0;/);
  assert.match(listSource, /if \(remainingRows <= 0\) return null;\s*\n\s*remainingRows -= 1;/);
  assert.match(listSource, /pinned\.length > 0 && revealBudgetLeft\(\) && \(/);
  assert.match(listSource, /revealBudgetLeft\(\) && sortedAutoSessions\.length > 0 && \(/);
  assert.match(listSource, /if \(!revealBudgetLeft\(\)\) return null;/);
  // Every branch roots at the element the reveal measures from. The selector
  // no longer owns a branch of its own (it rides above the grouped body), so
  // the branch count dropped by one: timeline, by-Bot, flat, empty state.
  assert.equal((listSource.match(/ref=\{rootRef\}/g) ?? []).length, 4);
  // Reveal is armed once per approach to the end: no unbounded state growth.
  assert.match(revealSource, /if \(!armed\) return \{ reveal: false, armed: false \};/);
  assert.match(revealSource, /if \(step\.reveal\) \{\s*\n\s*setRevealedRows\(\(previous\) => previous \+ REVEAL_CHUNK_ROWS\);/);
  // Without a scroll container above it nothing can be hidden, so everything
  // renders (the historic behavior).
  assert.match(revealSource, /const container = findScrollContainer\(rootRef\.current\);/);
  assert.match(revealSource, /setRevealedRows\(Number\.POSITIVE_INFINITY\);/);
  // The trigger listens to both the scroll and the container's own resizes
  // (window resize, sidebar collapse/expand), and cleans both up.
  assert.match(revealSource, /container\.addEventListener\('scroll', probe, \{ passive: true \}\)/);
  assert.match(revealSource, /new ResizeObserver\(probe\)/);
  assert.match(revealSource, /container\.removeEventListener\('scroll', probe\);\s*\n\s*observer\?\.disconnect\(\);/);
});

test('the reveal budget applies to every branch that renders rows', () => {
  // Every row list ends in renderItem, which is what spends the budget: the
  // pinned block, the expanded Follow-Up section, the expanded Autonomous
  // Tasks fold, the timeline groups, the by-Bot groups, and the flat branch's
  // pinned and unpinned halves. (The old selector branch was removed when the
  // online face moved onto the same grouped body, so its list is the by-Bot
  // groups' `.map(renderItem)` — one list, not two.)
  assert.equal((listSource.match(/\.map\(renderItem\)/g) ?? []).length, 7);
  assert.equal((listSource.match(/renderItem = \(session: CoworkSessionSummary\)/g) ?? []).length, 1);
});
