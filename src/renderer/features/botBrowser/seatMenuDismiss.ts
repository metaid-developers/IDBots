/**
 * Outside-pointer dismissal for the Twin seat menu (owner UX finding
 * 2026-11-08): a menu that only closes from its own trigger leaves the owner
 * hunting for the same chip again. The rule is the usual one — a pointer
 * landing anywhere outside the chip container closes the menu; a pointer on a
 * menu row is inside, so the row's own action still runs.
 *
 * Kept as plain functions (no React, no ambient `document` at module scope) so
 * the close / no-close decision is covered by a fake event target in unit
 * tests instead of clicking the real roster.
 */

export interface SeatMenuPointerDocument {
  addEventListener(type: string, listener: (event: Event) => void, options?: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: boolean): void;
}

export interface SeatMenuOutsideDismissOptions {
  /** The chip container that owns both the trigger and the menu. */
  container: () => Element | null;
  /** Closes the menu (the panel owns the open state). */
  onDismiss: () => void;
  /** Defaults to the real document; tests pass a fake pointer target. */
  doc?: SeatMenuPointerDocument | null;
}

/** True when the pointer target sits inside the chip container (trigger or menu). */
export function isPointerInsideSeatMenu(
  container: Element | null | undefined,
  target: EventTarget | null | undefined,
): boolean {
  if (!container || !target) return false;
  return container.contains(target as Node);
}

/**
 * Bind the outside-pointer close for one open menu. Returns the unbind
 * function; callers bind only while the menu is open.
 */
export function bindSeatMenuOutsideDismiss(options: SeatMenuOutsideDismissOptions): () => void {
  const ownerDocument = options.doc
    ?? (typeof document !== 'undefined' ? document : null);
  if (!ownerDocument) return () => {};

  const handlePointerDown = (event: Event) => {
    if (isPointerInsideSeatMenu(options.container(), event.target)) return;
    options.onDismiss();
  };

  // Capture phase: a component that stops propagation on its own pointerdown
  // must not be able to keep the menu pinned open.
  ownerDocument.addEventListener('pointerdown', handlePointerDown, true);
  return () => ownerDocument.removeEventListener('pointerdown', handlePointerDown, true);
}
