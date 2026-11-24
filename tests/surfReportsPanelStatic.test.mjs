import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for "the surf-report panel is indexed by day, not an
// unbounded sequential card stream" (owner spec 2026-11-18 01:44, amended
// 01:47).
//
// SurfReportsPanel renders the selected DAY's run cards into the advanced
// tab, which also hosts the wallet / backup / delete actions BELOW it. With
// no height constraint, every additional run made the panel taller and pushed
// those actions further down the page. The fix caps the LIST itself: all run
// cards of the viewed day live inside one height-bounded, internally
// scrolling container whose max height never depends on runs.length, so 1
// run and 20 runs occupy the same vertical budget. These assertions also pin
// the day-index contract: the header keeps a diary-style date chip that pops
// the mini month calendar in a fixed overlay (NEVER resident, owner ruling
// 2026-11-18 02:0x), days with runs are marked, the newest recorded day is
// the default selection, and the manual refresh button is GONE (freshness is
// the push-based refreshToken channel, owner ruling 2026-11-18 01:47).

const repoRoot = path.resolve(import.meta.dirname, '..');
const PANEL = 'src/renderer/components/metabots/SurfReportsPanel.tsx';

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * Locate the opening tag that carries data-slot="surf-reports-list" and return
 * its source span, so every assertion inspects ONLY that container's tag.
 */
function listContainerTag(source) {
  const slotIndex = source.indexOf('data-slot="surf-reports-list"');
  assert.ok(slotIndex > 0, 'the surf-reports list container must exist');
  const tagEnd = source.indexOf('>', slotIndex);
  assert.ok(tagEnd > slotIndex, 'the list container opening tag must close');
  return { slotIndex, tagEnd, tag: source.slice(slotIndex, tagEnd + 1) };
}

test('run cards live in one height-capped, internally scrolling container', () => {
  const source = read(PANEL);
  const { tag } = listContainerTag(source);

  assert.match(tag, /max-h-\[min\(420px,50vh\)\]/, 'the list needs a bounded max height');
  assert.match(tag, /overflow-y-auto/, 'overflow must scroll inside the container');
  assert.match(tag, /overscroll-contain/, 'scroll chaining to the page is suppressed');
  assert.match(tag, /divide-y/, 'the run rows stay cleanly separated inside the list');

  // The cap is a static class, never templated from data: that is exactly what
  // makes the panel height independent of the number of surf runs.
  assert.ok(!tag.includes('${'), 'the height cap must not be derived from runs.length');
  assert.ok(!/runs\.length/.test(tag), 'the container tag must not read runs.length');
});

test('runs.map(renderRunRow) renders INSIDE that container', () => {
  const source = read(PANEL);
  const { slotIndex, tagEnd } = listContainerTag(source);

  const mapIndex = source.indexOf('{runs.map(renderRunRow)}');
  assert.ok(mapIndex > 0, 'runs.map(renderRunRow) must still drive the list');
  assert.ok(mapIndex > slotIndex, 'the cards must come after the container opens');
  assert.ok(mapIndex > tagEnd, 'the cards must come after the container tag closes');
  // Nothing may close the container between its opening tag and the cards, so
  // the index comparison really does prove containment (not mere ordering).
  assert.ok(
    !source.slice(tagEnd, mapIndex).includes('</div>'),
    'no closing tag may sit between the container opening and the cards',
  );
});

test('the title row shows a count badge fed by the selected day run count', () => {
  const source = read(PANEL);
  const { slotIndex } = listContainerTag(source);

  const countIndex = source.indexOf('data-slot="surf-reports-count"');
  assert.ok(countIndex > 0, 'the run-count badge must exist');
  assert.ok(countIndex < slotIndex, 'the badge belongs to the header, above the list');

  const bodyStart = source.indexOf('>', countIndex) + 1;
  const bodyEnd = source.indexOf('</span>', bodyStart);
  assert.ok(bodyEnd > bodyStart, 'the badge element must close');
  const body = source.slice(bodyStart, bodyEnd).trim();

  assert.equal(body, '{runs.length}', 'the badge is fed by the day view run count');
  assert.doesNotMatch(body, /i18nService\.t\(/, 'the badge must not need a new i18n key');
});

test('empty states and panel error stay OUTSIDE the capped list', () => {
  const source = read(PANEL);
  const { slotIndex } = listContainerTag(source);

  const emptyIndex = source.indexOf("i18nService.t('surfReportsEmpty')");
  assert.ok(emptyIndex > 0, 'the no-records empty state must still exist');
  assert.ok(emptyIndex < slotIndex, 'the empty state renders before the list container');

  const dayEmptyIndex = source.indexOf("i18nService.t('surfReportsDayEmpty')");
  assert.ok(dayEmptyIndex > 0, 'the picked-day-empty hint must exist');
  assert.ok(dayEmptyIndex < slotIndex, 'the day-empty hint renders before the list container');

  const errorIndex = source.indexOf('{panelError ? (');
  assert.ok(errorIndex > 0, 'the panel error branch must still exist');
  assert.ok(errorIndex < slotIndex, 'the panel error renders before the list container');

  // Wording / markup of error and empty hints remain present outside the capped list.
  assert.match(source, /<p className="text-xs text-red-600 dark:text-rose-400">\{panelError\}<\/p>/);
  assert.match(source, /\{i18nService\.t\('surfReportsEmpty'\)\}/);
});

test('expanding a run scrolls its card into view, with an existence guard', () => {
  const source = read(PANEL);

  assert.match(
    source,
    /scrollIntoView\(\{\s*block:\s*'nearest'\s*\}\)/,
    "an expanded card must scroll into view using block: 'nearest'",
  );
  assert.match(
    source,
    /typeof\s+\w+\.scrollIntoView\s*===\s*'function'/,
    'scrollIntoView must be feature-detected so environments without it cannot throw',
  );
});

test('day-index load behaviour and expand semantics are pinned', () => {
  const source = read(PANEL);

  // The day index and the day view run through the two day queries.
  assert.match(source, /window\.electron\.surf\.listRunDays\(metabotId\)/);
  assert.match(source, /window\.electron\.surf\.listRunsByDay\(metabotId, range\.dayStartIso, range\.dayEndIso\)/);
  // The retired sequential feed must not be called anywhere.
  assert.ok(!source.includes('window.electron.surf.listRuns('), 'the unbounded listRuns feed is retired');

  // The manual refresh button is GONE (owner ruling 2026-11-18 01:47):
  // freshness comes from the refreshToken push, never a button.
  assert.ok(!source.includes('surf-reports-refresh'), 'the refresh button data-slot must be removed');
  assert.ok(!source.includes('surfReportsRefresh'), 'the refresh i18n key must have no reader');
  assert.ok(!source.includes('ArrowPathIcon'), 'the refresh icon import must be removed');
  assert.match(source, /refreshToken/, 'the push channel stays wired');

  // Default selection: the newest day with records seeds the view.
  assert.match(source, /const newestDay = result\.days\[0\] \?\? null/);

  // Default collapsed, and at most one run expanded at a time.
  assert.match(source, /const \[expandedRunId, setExpandedRunId\] = useState<string \| null>\(null\)/);
  assert.match(source, /onClick=\{\(\) => setExpandedRunId\(expanded \? null : run\.id\)\}/);
  // Per-run digest fold kept.
  assert.match(source, /surfReportDigestToggle/);
});

test('the header keeps a diary-style date chip that pops the calendar overlay', () => {
  const source = read(PANEL);

  assert.match(source, /import MiniMonthCalendar from '\.\.\/ui\/MiniMonthCalendar';/);
  assert.match(source, /<MiniMonthCalendar\b/, 'the calendar must still be rendered');
  assert.match(source, /markedDayKeys=\{markedDayKeys\}/, 'days with runs must mark the calendar');
  assert.match(source, /selectedDayKey=\{selectedDay\}/, 'the picked day must drive the selection');
  // Day keys become half-open UTC ranges for the store query.
  assert.match(source, /dayKeyToUtcRangeIso/);

  // Owner 2026-11-18 02:0x: no resident calendar. The chip labels the
  // selected day and opens the popup; the calendar renders ONLY inside the
  // fixed overlay that the chip toggles, and a pick closes it.
  const chipClassIndex = source.indexOf('!h-7');
  assert.ok(chipClassIndex > 0, 'the date chip must use the compact Studio Linear chip classes');
  const overlayClassIndex = source.indexOf(
    'fixed z-40 rounded-[10px] border border-slate-900/[0.12] dark:border-white/[0.12] dark:bg-[#182538] bg-white shadow-2xl p-2',
  );
  assert.ok(overlayClassIndex > chipClassIndex, 'the popup overlay must follow the date chip');
  const calIndex = source.indexOf('<MiniMonthCalendar');
  assert.ok(
    calIndex > overlayClassIndex,
    'the calendar must render inside the popup overlay, not resident in the header',
  );
  assert.ok(!source.includes('onPick={pickDay}'), 'a pick must also close the popup, so onPick is wrapped');

  assert.match(source, /\{selectedDay \?\? ''\}/, 'the chip label is the selected day key');
  assert.match(
    source,
    /setCalPos\(\{ top: rect\.bottom \+ 4, left: Math\.max\(8, rect\.right - 224\) \}\)/,
    'popup position mirrors the dream-diary anchor math',
  );
  assert.match(
    source,
    /onPick=\{\(dayKey\) => \{\s*pickDay\(dayKey\);\s*setCalOpen\(false\);\s*\}\}/,
    'picking a day loads that day and closes the popup',
  );
  assert.match(source, /document\.addEventListener\('mousedown', close\)/, 'an outside click closes the popup');
});
