/**
 * Context-menu geometry and dismissal rules for panel bubbles (office-chat
 * purity pass #1, item ②). Pure functions only — no React, no ambient
 * window/document at module scope — so placement and the three close channels
 * (outside pointerdown / Escape / scroll) are covered by unit tests instead
 * of clicking a live bubble.
 */

/** Intrinsic menu size before measurement: 4 rows (~32px each) + 8px padding. */
export const CONTEXT_MENU_WIDTH = 156;
export const CONTEXT_MENU_HEIGHT = 148;
/** Clearance between the cursor point and the menu's top-left corner. */
export const CONTEXT_MENU_CURSOR_GAP = 4;

export interface ContextMenuViewport {
  width: number;
  height: number;
}

/**
 * Fixed-position placement for the menu anchored at the right-click point,
 * flipped inward when the intrinsic box would spill past the viewport edge
 * (bottom-right corner clicks open the menu up-left, the Telegram behavior).
 * Falls back to the un-clamped anchor when the viewport is unknown (0).
 */
export const resolveContextMenuPlacement = (
  pointerX: number,
  pointerY: number,
  viewport: ContextMenuViewport,
  menuWidth: number = CONTEXT_MENU_WIDTH,
  menuHeight: number = CONTEXT_MENU_HEIGHT,
): { x: number; y: number } => {
  let x = pointerX + CONTEXT_MENU_CURSOR_GAP;
  let y = pointerY + CONTEXT_MENU_CURSOR_GAP;
  if (viewport.width > 0 && x + menuWidth > viewport.width) {
    x = Math.max(0, pointerX - CONTEXT_MENU_CURSOR_GAP - menuWidth);
  }
  if (viewport.height > 0 && y + menuHeight > viewport.height) {
    y = Math.max(0, pointerY - CONTEXT_MENU_CURSOR_GAP - menuHeight);
  }
  return { x, y };
};

/**
 * Whether a pointerdown target lands outside the menu box (and outside the
 * bubble that opened it — re-right-clicking the same bubble re-opens, it does
 * not dismiss-then-open). Outside → the caller closes the menu.
 *
 * DOM membership is duck-typed (`nodeType` + `contains`) instead of
 * `instanceof Node`: this module is unit-tested in plain node runs where the
 * DOM globals do not exist, and the app only ever feeds it real event
 * targets or the fakes below.
 */
const looksLikeDomNode = (target: EventTarget | null | undefined): target is Node => {
  if (!target || typeof (target as { nodeType?: unknown }).nodeType !== 'number') return false;
  return typeof (target as { contains?: unknown }).contains === 'function';
};

export const isPointerOutsideContextMenu = (
  menuElement: Element | null | undefined,
  openerElement: Element | null | undefined,
  target: EventTarget | null | undefined,
): boolean => {
  if (!looksLikeDomNode(target)) return true;
  if (menuElement?.contains(target)) return false;
  if (openerElement?.contains(target)) return false;
  return true;
};
