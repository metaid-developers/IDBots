import type { SidebarWidthMode } from './sidebarWidth';

/**
 * Sidebar resize session — ONE pointer-down ⇄ pointer-up pairing.
 *
 * Why this exists (owner-visible failure it fixes): the column-width drag used
 * to be driven by a React effect keyed on an `isSidebarResizing` state flag.
 * The document-level `mousemove` listener only started while a drag was active
 * and was only removed by a document `mouseup`, so any lost mouseup — the
 * primary button released OUTSIDE the window, a non-primary button opening a
 * native context menu, or a down/up pair completing before the passive effect
 * subscribed — left the flag stuck at `true`. Every later mousemove then
 * resized the column with no button held: "hover follows the pointer".
 *
 * Invariants this module enforces structurally:
 *   1. a session exists only between the originating mousedown and its paired
 *      ending; listeners are attached SYNCHRONOUSLY inside that mousedown, not
 *      after a state commit, so a fast click can never outrun them;
 *   2. only the primary button can start one (`button === 0`);
 *   3. every exit path (mouseup / pointerup / pointercancel / Escape / window
 *      blur / visibilitychange→hidden / an explicit finish) funnels through a
 *      single idempotent `finish()` that detaches every listener first;
 *   4. a mousemove that arrives with the primary button no longer held
 *      (`event.buttons` bit 0 clear) ends the session immediately instead of
 *      resizing — a dragged-then-released-outside pointer heals on its first
 *      move back inside the window instead of hanging forever.
 *
 * The module is deliberately DOM-injectable: `documentTarget` / `windowTarget`
 * let a node test drive the whole lifecycle with plain mock event targets.
 */

export type SidebarResizeEndReason =
  | 'mouseup'
  | 'pointerup'
  | 'pointercancel'
  | 'pointer-released'
  | 'escape'
  | 'window-blur'
  | 'visibility-hidden'
  | 'mode-change'
  | 'unmount'
  | 'replaced'
  | 'explicit';

export interface SidebarResizeEndInfo {
  mode: SidebarWidthMode;
  /** Final (clamped) width at the moment the session ended. */
  width: number;
  reason: SidebarResizeEndReason;
  /** True once at least one mousemove actually changed the width. */
  moved: boolean;
}

export interface SidebarResizeSessionOptions {
  /** clientX of the originating mousedown. */
  startX: number;
  /** Width before the drag. */
  startWidth: number;
  mode: SidebarWidthMode;
  clamp: (width: number) => number;
  onWidth: (width: number) => void;
  onEnd: (info: SidebarResizeEndInfo) => void;
  /** MouseEvent.button of the originating mousedown; only 0 (primary) starts. */
  button?: number;
  /**
   * Optional per-move width shaper (extreme damping, introduced with the
   * 2026-11-09 3:7 ruling; the band math is cap-independent, so it rides the
   * 2026-11-11 fixed-width drag cap unchanged).
   * Receives the raw uncapped target and the session's current width and
   * returns the width actually pursued; `clamp` still bounds the result, so a
   * shaper can never push the column out of range. Omitted = unchanged
   * straight-line drag.
   */
  shapeNext?: (rawNext: number, currentWidth: number) => number;
  documentTarget?: Document;
  windowTarget?: Window;
}

export interface SidebarResizeSession {
  readonly active: boolean;
  finish(reason?: SidebarResizeEndReason): void;
}

// ── Extreme damping (drag-cap companion, introduced with the 2026-11-09 3:7
// ruling; band math is cap-independent, unchanged by the 2026-11-11
// fixed-width ruling) ──
// Near either range edge each pointer pixel contributes proportionally less,
// so the column eases into the cap instead of hitting it with a jerk. The
// factor floor keeps the column still reachable at extreme proximity (it
// always can take the last few pixels, just slowly).
export const SIDEBAR_DAMP_BAND_PX = 96;
export const SIDEBAR_DAMP_MIN_FACTOR = 0.12;

/**
 * Delta actually applied for a raw pointer delta near the [min, max] range
 * edges. Far from both edges this is the identity; inside `band` of the edge
 * being approached the delta scales down linearly to `SIDEBAR_DAMP_MIN_FACTOR`
 * of itself; at/past an edge it is 0. The returned magnitude never exceeds the
 * raw delta and never crosses the bound (clamping stays a safety net).
 */
export function dampedSidebarDelta(
  delta: number,
  currentWidth: number,
  minWidth: number,
  maxWidth: number,
  band: number = SIDEBAR_DAMP_BAND_PX,
): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  if (!Number.isFinite(maxWidth) || maxWidth < minWidth) return 0;
  const room = delta > 0 ? maxWidth - currentWidth : currentWidth - minWidth;
  if (room <= 0) return 0;
  const factor = room >= band ? 1 : Math.max(SIDEBAR_DAMP_MIN_FACTOR, room / band);
  const damped = Math.round(delta * factor);
  if (damped === 0) return 0;
  const magnitude = Math.min(Math.abs(damped), Math.abs(delta), room);
  return delta > 0 ? magnitude : -magnitude;
}

// ── Double-click snap tween (ratio-ruling companion; unchanged since 40:60) ──
export const SIDEBAR_SNAP_TWEEN_MS = 220;

/** Pure ease-out curve for the snap tween: fast start, soft landing, 0→1. */
export function easeOutCubic(t: number): number {
  if (!Number.isFinite(t)) return t <= 0 ? 0 : 1;
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

function resolveDocument(): Document | undefined {
  return typeof document !== 'undefined' ? document : undefined;
}

function resolveWindow(doc: Document | undefined): Window | undefined {
  if (typeof window !== 'undefined') return window;
  const view = doc?.defaultView;
  return view ?? undefined;
}

export function startSidebarResizeSession(
  options: SidebarResizeSessionOptions,
): SidebarResizeSession | null {
  const { startX, startWidth, mode, clamp, onWidth, onEnd } = options;
  // Only a primary-button press may own the pointer. A right/middle click on
  // the seam cannot start a drag, so a native context menu swallowing the
  // matching mouseup can no longer strand the resize state.
  if (typeof options.button === 'number' && options.button !== 0) return null;
  if (!Number.isFinite(startX) || !Number.isFinite(startWidth)) return null;

  const doc = options.documentTarget ?? resolveDocument();
  if (!doc) return null;
  const win = options.windowTarget ?? resolveWindow(doc);

  let active = true;
  let width = startWidth;
  let moved = false;

  function finish(reason: SidebarResizeEndReason): void {
    if (!active) return;
    // Tear the wiring down before notifying, so a re-entrant event (or a
    // caller that unmounts/rerenders in onEnd) can never observe a live
    // session without listeners, or a listener without a session.
    active = false;
    doc.removeEventListener('mousemove', handleMove);
    doc.removeEventListener('mouseup', handleMouseUp);
    doc.removeEventListener('pointerup', handlePointerUp);
    doc.removeEventListener('pointercancel', handlePointerCancel);
    doc.removeEventListener('keydown', handleKeyDown);
    doc.removeEventListener('visibilitychange', handleVisibilityChange);
    win?.removeEventListener('blur', handleWindowBlur);
    onEnd({ mode, width, reason, moved });
  }

  function handleMove(event: MouseEvent): void {
    if (!active) return;
    // Defensive backstop, not a heuristic: a move with the primary button
    // released means the mouseup was delivered somewhere we never saw
    // (outside the window, a native menu, an app switch). End the session
    // rather than following the pointer. `buttons` is a bitmask; bit 0 is the
    // primary button, so this is exactly "buttons === 1" for the unmodified
    // single-button drag while tolerating chorded presses.
    const buttons = typeof event.buttons === 'number' ? event.buttons : 0;
    if ((buttons & 1) !== 1) {
      finish('pointer-released');
      return;
    }
    const rawNext = startWidth + (event.clientX - startX);
    // shapeNext (extreme damping) shapes the pursued width BEFORE clamp; with
    // no shaper the drag is the unchanged straight line it has always been.
    const next = clamp(
      options.shapeNext ? options.shapeNext(rawNext, width) : rawNext,
    );
    if (next === width) return;
    moved = true;
    width = next;
    onWidth(next);
  }

  function handleMouseUp(): void {
    finish('mouseup');
  }

  function handlePointerUp(): void {
    finish('pointerup');
  }

  function handlePointerCancel(): void {
    finish('pointercancel');
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.key === 'Esc') finish('escape');
  }

  function handleVisibilityChange(): void {
    if (doc.visibilityState === 'hidden') finish('visibility-hidden');
  }

  function handleWindowBlur(): void {
    finish('window-blur');
  }

  // Attached synchronously inside the mousedown handler — never from an
  // effect. `pointerup`/`pointercancel` are terminators only (mousemove stays
  // the single width driver, so a mouse that emits both never double-applies).
  doc.addEventListener('mousemove', handleMove);
  doc.addEventListener('mouseup', handleMouseUp);
  doc.addEventListener('pointerup', handlePointerUp);
  doc.addEventListener('pointercancel', handlePointerCancel);
  doc.addEventListener('keydown', handleKeyDown);
  doc.addEventListener('visibilitychange', handleVisibilityChange);
  win?.addEventListener('blur', handleWindowBlur);

  return {
    get active() {
      return active;
    },
    finish(reason: SidebarResizeEndReason = 'explicit') {
      finish(reason);
    },
  };
}
