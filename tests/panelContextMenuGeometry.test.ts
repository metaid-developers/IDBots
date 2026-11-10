import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_MENU_CURSOR_GAP,
  CONTEXT_MENU_HEIGHT,
  CONTEXT_MENU_WIDTH,
  isPointerOutsideContextMenu,
  resolveContextMenuPlacement,
} from '../src/renderer/features/botBrowser/panelContextMenuGeometry';

// Bubble context-menu geometry + dismissal rules (purity pass #1, item ②).
// Pure functions only: the placement flip and the three close channels are
// pinned here instead of clicking a live bubble.

const VIEWPORT = { width: 1200, height: 800 };

test('an interior click opens the menu down-right of the cursor with the gap', () => {
  const placement = resolveContextMenuPlacement(400, 300, VIEWPORT);
  assert.equal(placement.x, 400 + CONTEXT_MENU_CURSOR_GAP);
  assert.equal(placement.y, 300 + CONTEXT_MENU_CURSOR_GAP);
});

test('a click near the right edge flips the menu left of the cursor', () => {
  // 1200 - 156 - 4 = 1040: at x >= 1040 the intrinsic box would spill right.
  const placement = resolveContextMenuPlacement(1190, 300, VIEWPORT);
  assert.equal(placement.x, 1190 - CONTEXT_MENU_CURSOR_GAP - CONTEXT_MENU_WIDTH);
  assert.equal(placement.y, 300 + CONTEXT_MENU_CURSOR_GAP);
  // Never negative even at the extreme edge.
  assert.ok(placement.x >= 0);
});

test('a click near the bottom edge flips the menu above the cursor', () => {
  // 800 - 148 - 4 = 648: at y >= 648 the intrinsic box would spill below.
  const placement = resolveContextMenuPlacement(400, 790, VIEWPORT);
  assert.equal(placement.x, 400 + CONTEXT_MENU_CURSOR_GAP);
  assert.equal(placement.y, 790 - CONTEXT_MENU_CURSOR_GAP - CONTEXT_MENU_HEIGHT);
  assert.ok(placement.y >= 0);
});

test('a click in the bottom-right corner flips both axes', () => {
  const placement = resolveContextMenuPlacement(1195, 795, VIEWPORT);
  assert.equal(placement.x, 1195 - CONTEXT_MENU_CURSOR_GAP - CONTEXT_MENU_WIDTH);
  assert.equal(placement.y, 795 - CONTEXT_MENU_CURSOR_GAP - CONTEXT_MENU_HEIGHT);
});

test('an unknown viewport (0) keeps the un-clamped anchor placement', () => {
  const placement = resolveContextMenuPlacement(500, 600, { width: 0, height: 0 });
  assert.equal(placement.x, 500 + CONTEXT_MENU_CURSOR_GAP);
  assert.equal(placement.y, 600 + CONTEXT_MENU_CURSOR_GAP);
});

const makeNode = (name: string): Node => {
  // Minimal stand-in matching the module's duck-typed DOM check (nodeType +
  // contains); identity comparison stands in for real tree membership.
  const element = {
    nodeType: 1,
    contains: (other: unknown) => other === element || other === name,
    name,
  } as unknown as Node;
  return element;
};

test('dismissal rule: inside menu or opener stays open, everything else closes', () => {
  const menu = makeNode('menu');
  const opener = makeNode('opener');
  assert.equal(isPointerOutsideContextMenu(menu, opener, menu), false);
  assert.equal(isPointerOutsideContextMenu(menu, opener, opener), false);
  assert.equal(isPointerOutsideContextMenu(menu, opener, makeNode('elsewhere')), true);
  // Missing target / missing menu: treat as outside (fail-open to closing).
  assert.equal(isPointerOutsideContextMenu(menu, opener, null), true);
  assert.equal(isPointerOutsideContextMenu(null, opener, makeNode('elsewhere')), true);
  // Null opener: only the menu box keeps the menu alive.
  assert.equal(isPointerOutsideContextMenu(menu, null, menu), false);
  assert.equal(isPointerOutsideContextMenu(menu, null, makeNode('elsewhere')), true);
});
