import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Wiring guard for the middle/right boundary handle.
 *
 * The behavioral suite (tests/sidebarResizeSession.test.ts) proves the state
 * machine itself cannot hang. This file proves App.tsx actually USES it the
 * safe way, because the original bug was a wiring bug, not a math bug:
 *
 *   · the drag session must be created inside the mousedown handler
 *     (listeners attached synchronously), never subscribed from a React
 *     effect keyed on an `isSidebarResizing` flag;
 *   · only the primary button may start it;
 *   · every exit path must clear BOTH the session ref and the visual flag;
 *   · the one toggle button keeps its semantics: click = collapse/expand,
 *     mousedown stopPropagation isolates it from the resize grip, double
 *     click on the seam = reset width;
 *   · (owner order ② 2026-11-11 evening) a full-viewport drag shield renders
 *     only while dragging, so the Bot Browser iframe can never swallow the
 *     pointer mid-drag, and the double-click snap tween strips the CSS width
 *     transition exactly like a drag does (the tween stays the single
 *     animator);
 *   · (owner order ④ 2026-11-11 evening) all four seam pills share ONE slim,
 *     low-presence, dead-center style — no per-face placement drift.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(repoRoot, 'src/renderer/App.tsx'), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `expected to find ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `expected to find ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

const resizeStartBlock = sliceBetween(
  appSource,
  'const handleSidebarResizeStart',
  'const handleSidebarResizeSnapToRatio',
);

const handleBlock = sliceBetween(
  appSource,
  'data-slot="panel-boundary-handle"',
  'data-slot="app-right-column"',
);

test('the resize session is created inside the mousedown handler, listeners attached synchronously', () => {
  assert.ok(
    resizeStartBlock.includes('startSidebarResizeSession({'),
    'the seam mousedown handler must start the DOM session itself',
  );
  assert.ok(
    !appSource.includes("document.addEventListener('mousemove'"),
    'no effect may subscribe the drag driver — the session owns it',
  );
  assert.ok(
    !appSource.includes('if (!isSidebarResizing) return;'),
    'the old state-flag-gated listener effect must be gone',
  );
});

test('only the primary button may start a drag', () => {
  assert.ok(
    resizeStartBlock.includes('if (event.button !== 0) return;'),
    'a right/middle click must never arm the drag (native menus eat the mouseup)',
  );
  assert.ok(
    resizeStartBlock.includes('button: event.button'),
    'the button guard must also be passed into the session for defense in depth',
  );
  assert.ok(
    resizeStartBlock.includes('sidebarResizeRef.current?.active'),
    'an already-live session must not be stacked',
  );
});

test('every exit path clears the session ref and the visual flag in one funnel', () => {
  assert.ok(
    resizeStartBlock.includes('sidebarResizeRef.current = null;'),
    'onEnd must clear the session ref',
  );
  assert.ok(
    resizeStartBlock.includes('setIsSidebarResizing(false);'),
    'onEnd must clear the visual resize flag',
  );
  assert.ok(
    appSource.includes("sidebarResizeRef.current?.finish('mode-change')"),
    'a surface switch must end a live session',
  );
  assert.ok(
    appSource.includes("sidebarResizeRef.current?.finish('unmount')"),
    'unmount/HMR must end a live session',
  );
  assert.ok(
    resizeStartBlock.includes("sidebarResizeRef.current?.finish('explicit')") ||
      appSource.includes("sidebarResizeRef.current?.finish('explicit')"),
    'a double-click reset must end a live session before snapping width',
  );
});

test('the seam keeps its per-face interaction semantics', () => {
  assert.ok(handleBlock.includes('data-slot="panel-boundary-handle"'), 'handle stays labelled');
  assert.ok(
    handleBlock.includes("data-collapsed={isSidebarCollapsed ? 'true' : 'false'}"),
    'the handle stays mounted in every collapse state',
  );
  assert.ok(
    handleBlock.includes("data-seam-state={showHomeSurface ? (homeSeamCollapsed ? 'left' : 'split') : studioSeamState}"),
    'the seam publishes its per-face state (split/left) for tests and styling',
  );
  assert.ok(
    handleBlock.includes('onMouseDown={middleColumnResizable ? handleSidebarResizeStart : undefined}'),
    'the resizable split state starts the resize; a collapsed state cannot',
  );
  assert.ok(
    handleBlock.includes('onDoubleClick={middleColumnResizable ? handleSidebarResizeSnapToRatio : undefined}'),
    'double click on the resizable seam still snaps the width (40:60 tween)',
  );
  assert.ok(handleBlock.includes('data-slot="panel-toggle"'), 'the toggle stays on the seam');
  assert.ok(
    handleBlock.includes('onMouseDown={(event) => event.stopPropagation()}'),
    'the toggle mousedown must not leak into the resize start',
  );
  assert.ok(
    handleBlock.includes('onDoubleClick={(event) => event.stopPropagation()}'),
    'the toggle double click must not leak into the seam snap',
  );
  // 接缝按钮双向化 2026-11-09: per-face chevron wiring. Every chevron points
  // where the seam moves on click; no toggle button remains on the old
  // single-axis handleToggleSidebar contract.
  assert.ok(
    handleBlock.includes('onClick={handleCollapseHomeSeam}') &&
      handleBlock.includes('onClick={handleExpandHomeSeam}'),
    'the BotWorks face owns its single-direction pair (collapse records ⇄ expand records)',
  );
  assert.ok(
    handleBlock.includes('onClick={handleCollapseStudioSeamLeft}') &&
      handleBlock.includes('onClick={handleExpandStudioSeam}'),
    'the Studio face owns its two transitions (collapse left, recover) — the fill direction is retired',
  );
  assert.ok(
    !handleBlock.includes('collapseStudioSeamRight'),
    'the retired fill-direction handler must not come back (平铺态砍掉)',
  );
  assert.ok(
    !handleBlock.includes('aria-pressed'),
    'the per-face seam is not a boolean toggle — data-seam-state carries the state',
  );
  assert.ok(
    handleBlock.includes("direction=\"left\"") && handleBlock.includes("direction=\"right\""),
    'every chevron renders through the direction-mapped PanelToggleIcon (static directions)',
  );
});

// ── Owner order ② (2026-11-11 evening): the drag shield + tween isolation ──

test('a full-viewport drag shield renders ONLY while dragging, so the browser iframe cannot swallow the pointer', () => {
  const shieldRegex = /\{isSidebarResizing \? \(\s*<div\s+aria-hidden="true"\s+data-slot="panel-resize-overlay"\s+className="fixed inset-0 z-50 cursor-col-resize"\s+\/>\s*\) : null\}/;
  assert.match(
    appSource,
    shieldRegex,
    'the transparent full-viewport shield must be gated on the live drag flag (fixed, above the seam z-40, col-resize cursor)',
  );
  assert.equal(
    (appSource.match(/panel-resize-overlay/g) || []).length,
    1,
    'the shield is declared exactly once — it must never shade normal interaction',
  );
  assert.ok(
    appSource.indexOf('panel-resize-overlay') > appSource.indexOf('data-slot="app-right-column"'),
    'the shield sits at shell level (after the grid), not inside a collapsible column',
  );
});

test('the snap tween strips the width transition the same way a drag does', () => {
  assert.ok(
    appSource.includes('const [isSidebarTweening, setIsSidebarTweening] = useState(false);'),
    'the tween owns an explicit animating flag',
  );
  assert.ok(
    appSource.includes('setIsSidebarTweening(true);'),
    'arming the tween arms the flag',
  );
  assert.ok(
    (appSource.match(/setIsSidebarTweening\(false\)/g) || []).length >= 2,
    'both stop paths (stopSidebarSnapTween + tween completion) clear the flag',
  );
  assert.equal(
    (appSource.match(/isResizing=\{isSidebarResizing \|\| isSidebarTweening\}/g) || []).length,
    2,
    'both columns (HomeSidebar + Sidebar) receive drag+tween transition suppression',
  );
});

// ── Owner order ④ (2026-11-11 evening): one slim, low-presence pill ──

test('all four seam pills share one slim dead-center low-presence style', () => {
  const pills = handleBlock.match(/data-slot="panel-toggle"/g) || [];
  assert.equal(
    pills.length,
    4,
    'exactly four pill states (BotWorks split/collapsed, Studio split/collapsed)',
  );
  assert.ok(
    appSource.includes('const SEAM_TOGGLE_PILL_CLASS') &&
      (handleBlock.match(/\$\{SEAM_TOGGLE_PILL_CLASS\}/g) || []).length === 4,
    'every pill renders through the one shared style constant',
  );
  assert.ok(
    appSource.includes('h-6 w-2'),
    'the pill is slimmed to h-6 w-2 (was h-7 w-3.5)',
  );
  assert.ok(
    !handleBlock.includes('h-7 w-3.5'),
    'the old chunky pill size must not survive anywhere on the seam',
  );
  assert.ok(
    (appSource.match(/const SEAM_TOGGLE_PILL_CLASS[^\n]*-translate-x-1\/2 -translate-y-1\/2/) || []).length === 1,
    'the shared constant pins every pill dead-center on the seam — Studio and BotWorks sit at the SAME spot',
  );
  assert.ok(
    !handleBlock.includes('left-full'),
    'the Studio split pill no longer hugs the browser edge (supersedes the 2026-11-09 placement)',
  );
  assert.ok(
    appSource.includes('SEAM_TOGGLE_PILL_ON_SEAM_CLASS') &&
      appSource.includes('SEAM_TOGGLE_PILL_RECOVER_CLASS'),
    'split pills hover-reveal; collapsed recover pills stay faintly visible (sole affordance)',
  );
  assert.ok(
    !appSource.includes('backdrop-blur-sm') || !handleBlock.includes('backdrop-blur-sm'),
    'the pills drop the backdrop blur (low presence, plain claude tokens)',
  );
  assert.equal(
    (handleBlock.match(/h-2\.5 w-2\.5/g) || []).length,
    4,
    'every chevron shrank to 10px to match the slimmer pill',
  );
});
