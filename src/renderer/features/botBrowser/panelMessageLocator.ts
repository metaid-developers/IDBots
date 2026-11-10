/**
 * Message locator rail math (office chat purity pass #2, item ③).
 *
 * The rail is a Telegram-style navigator on the transcript's right edge: one
 * tick per message sized by that message's rendered height, a draggable
 * viewport thumb, and a hover preview card. This module holds the pure math —
 * fractions, clamps and jump targets — so every mapping the rail performs is
 * unit-testable without a DOM:
 *
 * - `isPanelLocatorOverflow` gates the whole rail: no overflow, no rail.
 * - `buildPanelLocatorTicks` maps measured message boxes onto the rail's
 *   [0,1] space in exact document proportion (start/height), so the rail is a
 *   truthful map of the transcript.
 * - `panelLocatorThumbFor` / `panelLocatorScrollForHandle` are the two
 *   directions of the viewport thumb (state ⇄ drag).
 * - `panelLocatorScrollForRow` is the click-a-tick jump (row top + lead).
 * - `panelLocatorTickIndexAtFraction` resolves a pointer position to a
 *   message for hover previews and clicks.
 * - `panelLocatorPreviewLines` strips composer bookkeeping (attachment
 *   marker lines, markdown image lines, blank lines) out of a message body
 *   so the preview card shows the actual conversation text.
 * - `panelLocatorPreviewTop` clamps the preview card inside the rail.
 *
 * All fraction outputs live in [0,1]; every numeric input is guarded so a
 * zero-sized container can never produce NaN.
 */

import { USER_ATTACHMENT_MARKER_PATTERN } from '../../components/cowork/UserAttachmentBody';

/**
 * Minimum scrollable distance (px) before the rail appears. A few pixels of
 * scroll room is not a navigable transcript; the small buffer also keeps
 * rounding jitter from flashing the rail in and out.
 */
export const PANEL_LOCATOR_OVERFLOW_THRESHOLD_PX = 4;

/** Leap (px) left above a message row when jumping to it via a tick click. */
export const PANEL_LOCATOR_ROW_LEAD_PX = 8;

/** Slack (px) before a pointer gesture counts as a drag instead of a click. */
export const PANEL_LOCATOR_CLICK_SLOP_PX = 4;

/** Preview card inset (px) from the rail ends when clamping its position. */
export const PANEL_LOCATOR_PREVIEW_MARGIN_PX = 6;

/** One message as the rail needs it: identity, sender and plain body text. */
export interface PanelLocatorRow {
  id: string;
  isUser: boolean;
  /** Display name for the preview card (user rows carry the owner label). */
  sender: string;
  content: string;
}

/** A message row measured inside the scroll container (scroll-space px). */
export interface PanelLocatorRowBox {
  id: string;
  offsetTop: number;
  offsetHeight: number;
}

/** One tick on the rail, as fractions of the rail height. */
export interface PanelLocatorTick {
  id: string;
  start: number;
  height: number;
  isUser: boolean;
}

/** Viewport thumb position on the rail, as fractions of the rail height. */
export interface PanelLocatorThumb {
  start: number;
  size: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Whether the transcript overflows enough to deserve a rail. Any NaN input
 * (unmounted container, zero measure) means "no rail".
 */
export function isPanelLocatorOverflow(scrollHeight: number, clientHeight: number): boolean {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return false;
  return scrollHeight - clientHeight >= PANEL_LOCATOR_OVERFLOW_THRESHOLD_PX;
}

/**
 * Map measured message boxes onto rail fractions in exact document
 * proportion: a tick occupies the same slice of the rail that its message
 * occupies in the scroll content, which is what makes hover previews, the
 * thumb and click jumps agree on one coordinate system. Rows are ordered by
 * `offsetTop` (DOM order is already sorted; sorting makes the contract
 * explicit). A box taller than the remaining rail is clamped at the bottom.
 */
export function buildPanelLocatorTicks(boxes: PanelLocatorRowBox[], contentHeight: number, isUserById?: ReadonlyMap<string, boolean>): PanelLocatorTick[] {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0 || boxes.length === 0) return [];
  const ordered = [...boxes].sort((a, b) => a.offsetTop - b.offsetTop);
  return ordered.map((box) => {
    const start = clamp01(box.offsetTop / contentHeight);
    const height = Math.max(0, Math.min(1 - start, box.offsetHeight / contentHeight));
    return {
      id: box.id,
      start,
      height,
      isUser: isUserById?.get(box.id) ?? false,
    };
  });
}

/**
 * Viewport thumb for the current scroll state: the thumb covers the visible
 * fraction of the content, positioned by the scroll fraction. Degenerate
 * containers (nothing to scroll) render a full-height thumb.
 */
export function panelLocatorThumbFor(scrollTop: number, scrollHeight: number, clientHeight: number): PanelLocatorThumb {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight) || !Number.isFinite(scrollTop)) {
    return { start: 0, size: 1 };
  }
  if (scrollHeight <= 0 || clientHeight <= 0 || scrollHeight <= clientHeight) {
    return { start: 0, size: 1 };
  }
  const size = Math.min(1, clientHeight / scrollHeight);
  const start = Math.min(1 - size, Math.max(0, scrollTop / scrollHeight));
  return { start, size };
}

/**
 * Drag mapping, thumb-center anchoring: the thumb's center follows the
 * pointer's rail position, the container scrolls proportionally. Clamped to
 * the legal scroll range so both rail ends are exact.
 */
export function panelLocatorScrollForHandle(y: number, railHeight: number, scrollHeight: number, clientHeight: number): number {
  if (!Number.isFinite(railHeight) || railHeight <= 0 || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) {
    return 0;
  }
  if (scrollHeight <= clientHeight) return 0;
  const fraction = clamp01(y / railHeight);
  const maxScroll = scrollHeight - clientHeight;
  return Math.min(maxScroll, Math.max(0, fraction * scrollHeight - clientHeight / 2));
}

/**
 * Click-a-tick jump: scroll so the target row's top sits a small lead below
 * the viewport top. Rows near the document end clamp to the max scroll.
 */
export function panelLocatorScrollForRow(rowOffsetTop: number, scrollHeight: number, clientHeight: number): number {
  const maxScroll = Number.isFinite(scrollHeight) && Number.isFinite(clientHeight)
    ? Math.max(0, scrollHeight - clientHeight)
    : 0;
  if (!Number.isFinite(rowOffsetTop)) return 0;
  return Math.min(maxScroll, Math.max(0, rowOffsetTop - PANEL_LOCATOR_ROW_LEAD_PX));
}

/**
 * Which tick covers a pointer position, as an index into `ticks`. Coverage
 * is "last tick whose start ≤ fraction" — at a seam the later (lower)
 * message wins, matching the reading direction. Positions before the first
 * tick resolve to the first tick; an empty rail resolves to none.
 */
export function panelLocatorTickIndexAtFraction(ticks: PanelLocatorTick[], fraction: number): number {
  if (ticks.length === 0 || !Number.isFinite(fraction)) return -1;
  const value = clamp01(fraction);
  let index = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    if (ticks[i].start <= value) index = i;
    else break;
  }
  return index;
}

const MARKDOWN_IMAGE_LINE_PATTERN = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

/**
 * First lines of a message body for the hover preview card: attachment
 * marker lines (`附件路径: …` etc.), markdown image lines and blank lines
 * are bookkeeping, not conversation text — every one of them is skipped so
 * the two preview lines always show real words when there are any.
 */
export function panelLocatorPreviewLines(content: string, maxLines = 2): string[] {
  if (!content) return [];
  const lines: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (USER_ATTACHMENT_MARKER_PATTERN.test(line)) continue;
    if (MARKDOWN_IMAGE_LINE_PATTERN.test(line)) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

/**
 * Vertical position (px) for the preview card: centered on the pointer,
 * clamped inside the rail with a small margin. A rail shorter than the card
 * pins the card at the top margin.
 */
export function panelLocatorPreviewTop(pointerY: number, cardHeight: number, railHeight: number, margin = PANEL_LOCATOR_PREVIEW_MARGIN_PX): number {
  const safeMargin = Number.isFinite(margin) && margin >= 0 ? margin : 0;
  if (!Number.isFinite(pointerY) || !Number.isFinite(cardHeight) || !Number.isFinite(railHeight) || railHeight <= 0) {
    return safeMargin;
  }
  const preferred = pointerY - cardHeight / 2;
  const lowest = railHeight - cardHeight - safeMargin;
  if (lowest < safeMargin) return safeMargin;
  return Math.min(lowest, Math.max(safeMargin, preferred));
}

/**
 * Build the rail rows from the panel's visible messages. Sender names: user
 * rows carry the owner label, assistant rows carry the seat bot's name (may
 * be empty before the bot is known — the preview then shows the body only).
 */
export function buildPanelLocatorRows(
  messages: ReadonlyArray<{ id: string; type: string; content?: string }>,
  options: { botName: string | null; userLabel: string },
): PanelLocatorRow[] {
  return messages.map((message) => ({
    id: message.id,
    isUser: message.type === 'user',
    sender: message.type === 'user' ? options.userLabel : (options.botName ?? ''),
    content: typeof message.content === 'string' ? message.content : '',
  }));
}
