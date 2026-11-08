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
 *     click on the seam = reset width.
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
  'const handleSidebarResizeReset',
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

test('the seam keeps its three interaction semantics', () => {
  assert.ok(handleBlock.includes('data-slot="panel-boundary-handle"'), 'handle stays labelled');
  assert.ok(
    handleBlock.includes("data-collapsed={isSidebarCollapsed ? 'true' : 'false'}"),
    'the handle stays mounted in both collapse states',
  );
  assert.ok(
    handleBlock.includes('onMouseDown={isSidebarCollapsed ? undefined : handleSidebarResizeStart}'),
    'expanded seam starts the resize; collapsed seam cannot',
  );
  assert.ok(
    handleBlock.includes('onDoubleClick={isSidebarCollapsed ? undefined : handleSidebarResizeReset}'),
    'double click on the expanded seam still resets the width',
  );
  assert.ok(handleBlock.includes('data-slot="panel-toggle"'), 'the single toggle stays on the seam');
  assert.ok(
    handleBlock.includes('onMouseDown={(event) => event.stopPropagation()}'),
    'the toggle mousedown must not leak into the resize start',
  );
  assert.ok(
    handleBlock.includes('onDoubleClick={(event) => event.stopPropagation()}'),
    'the toggle double click must not leak into the seam reset',
  );
  assert.ok(handleBlock.includes('onClick={handleToggleSidebar}'), 'click = collapse/expand');
  assert.ok(handleBlock.includes('aria-pressed={isSidebarCollapsed}'), 'the toggle stays a toggle');
});
